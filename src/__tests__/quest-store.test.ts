import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { QuestStore } from "../quest-store.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "fairy-quests-"));
  const path = join(dir, "quests.sqlite");
  const store = new QuestStore({ path, maxHistory: 20 });
  return { store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("enqueues, claims, journals, and completes a quest", () => {
  const f = fixture();
  try {
    const queued = f.store.enqueue({ project: "/tmp/project", role: "build", name: "Build it", task: "Implement the feature" });
    assert.equal(queued.state, "queued");
    const running = f.store.claimNext("/tmp/project", "session-1");
    assert.equal(running?.id, queued.id);
    assert.equal(running?.state, "running");
    assert.equal(running?.attempts, 1);
    assert.equal(f.store.attachRun(queued.id, "session-1", "a1"), true);
    assert.equal(f.store.complete(queued.id, "session-1", "a1", "done"), true);
    const complete = f.store.get(queued.id);
    assert.equal(complete?.state, "done");
    assert.equal(complete?.result, "done");
    assert.deepEqual(f.store.events(queued.id).map((e) => e.event), ["completed", "agent_started", "claimed", "enqueued"]);
  } finally { f.close(); }
});

test("recovers running work as interrupted and claims it again", () => {
  const f = fixture();
  try {
    const queued = f.store.enqueue({ project: "/tmp/project", role: "explore", task: "Map it" });
    assert.equal(f.store.claimNext("/tmp/project", "session-1")?.state, "running");
    assert.equal(f.store.recoverOwned("/tmp/project", "another-session"), 0);
    assert.equal(f.store.recoverOwned("/tmp/project", "session-1"), 1);
    assert.equal(f.store.get(queued.id)?.state, "interrupted");
    const retried = f.store.claimNext("/tmp/project", "session-2");
    assert.equal(retried?.id, queued.id);
    assert.equal(retried?.attempts, 2);
  } finally { f.close(); }
});

test("rejects stale callbacks from a previous owner or agent run", () => {
  const f = fixture();
  try {
    const q = f.store.enqueue({ project: "/tmp/project", role: "build", task: "Build" });
    f.store.claimNext("/tmp/project", "session-1");
    assert.equal(f.store.attachRun(q.id, "session-1", "a1"), true);
    assert.equal(f.store.complete(q.id, "session-2", "a2", "stale"), false);
    assert.equal(f.store.fail(q.id, "session-1", "stale", "a2"), false);
    assert.equal(f.store.get(q.id)?.state, "running");
    assert.equal(f.store.complete(q.id, "session-1", "a1", "fresh"), true);
    assert.equal(f.store.fail(q.id, "session-1", "late", "a1"), false);
    assert.equal(f.store.get(q.id)?.result, "fresh");
  } finally { f.close(); }
});

test("cancels only queued work and isolates projects", () => {
  const f = fixture();
  try {
    const first = f.store.enqueue({ project: "/tmp/one", role: "plan", task: "Plan" });
    f.store.enqueue({ project: "/tmp/two", role: "plan", task: "Other" });
    assert.equal(f.store.list("/tmp/one").length, 1);
    assert.equal(f.store.cancel(first.id, "/tmp/two"), false);
    assert.equal(f.store.cancel(first.id, "/tmp/one"), true);
    assert.equal(f.store.cancel(first.id, "/tmp/one"), false);
    assert.equal(f.store.get(first.id)?.state, "cancelled");
    assert.equal(f.store.health().integrity, "ok");
  } finally { f.close(); }
});
