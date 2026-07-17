import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { QuestStore } from "../quest-store.ts";
import { filterQuests, questDashboard, questTableText, QUEST_FILTERS } from "../quest-dashboard.ts";

const PROJECT = "/tmp/dash-project";
const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const tui = { requestRender() { /* noop */ } };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "fairy-dash-"));
  const store = new QuestStore({ path: join(dir, "quests.sqlite"), maxHistory: 50 });
  return { store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seed(store: QuestStore) {
  const done = store.enqueue({ project: PROJECT, role: "build", name: "Ship feature", task: "ship it" });
  const c = store.claimNext(PROJECT, "s")!;
  store.attachRun(c.lease, "a1");
  store.updateTelemetry(c.lease, { model: "prov/big-model", tier: "worker", turns: 4, tokens: 2000, costUsd: 0.12 });
  store.complete(c.lease, "a1", "shipped");

  const failed = store.enqueue({ project: PROJECT, role: "review", name: "Review docs", task: "review" });
  const c2 = store.claimNext(PROJECT, "s")!;
  store.attachRun(c2.lease, "a2");
  store.fail(c2.lease, "reviewer exploded", "a2");

  const queued = store.enqueue({ project: PROJECT, role: "explore", name: "Map codebase", task: "map" });
  return { done: done.id, failed: failed.id, queued: queued.id };
}

test("filterQuests: filters by state bucket and free-text search", () => {
  const f = fixture();
  try {
    seed(f.store);
    const rows = f.store.list(PROJECT, 50);
    assert.equal(filterQuests(rows, "all", "").length, 3);
    assert.equal(filterQuests(rows, "active", "").length, 1);
    assert.equal(filterQuests(rows, "failed", "").length, 1);
    assert.equal(filterQuests(rows, "done", "").length, 1);
    assert.equal(filterQuests(rows, "cancelled", "").length, 0);
    assert.equal(filterQuests(rows, "all", "map").length, 1);
    assert.equal(filterQuests(rows, "all", "REVIEW").length, 1);
    assert.equal(filterQuests(rows, "all", "zzz").length, 0);
  } finally { f.close(); }
});

test("questTableText renders a plain-text fallback", () => {
  const f = fixture();
  try {
    const ids = seed(f.store);
    const text = questTableText(f.store.list(PROJECT, 50));
    assert.match(text, new RegExp(ids.queued));
    assert.match(text, /failed/);
    assert.match(text, /✓/);
    assert.equal(questTableText([]), "No quests match.");
  } finally { f.close(); }
});

test("dashboard renders, cycles filters, searches, and shows details", () => {
  const f = fixture();
  try {
    seed(f.store);
    const dash = questDashboard({ tui, theme, done: () => {}, store: f.store, project: PROJECT });
    try {
      let out = dash.render(100).join("\n");
      assert.match(out, /Quest Dashboard/);
      assert.match(out, /3 shown/);
      assert.match(out, /Ship feature/);

      // Cycle filter right → "active"
      dash.handleInput("\x1b[C");
      assert.equal(dash.state.filter, "active");
      out = dash.render(100).join("\n");
      assert.match(out, /Map codebase/);
      assert.doesNotMatch(out, /Ship feature/);

      // Search narrows within a filter
      dash.handleInput("\x1b[D"); // back to all
      dash.handleInput("/");
      for (const ch of "review") dash.handleInput(ch);
      dash.handleInput("\r");
      assert.equal(dash.state.search, "review");
      out = dash.render(100).join("\n");
      assert.match(out, /Review docs/);
      assert.doesNotMatch(out, /Map codebase/);

      // Details pane shows durable telemetry for the selected quest
      dash.handleInput("\x1b"); // close-ish? esc outside search closes… use fresh search reset instead
    } finally { dash.dispose(); }

    const dash2 = questDashboard({ tui, theme, done: () => {}, store: f.store, project: PROJECT });
    try {
      // Select the done quest (rows are newest-first: queued, failed, done)
      dash2.handleInput("j");
      dash2.handleInput("j");
      dash2.handleInput("\r");
      assert.equal(dash2.state.detail, true);
      const out = dash2.render(120).join("\n");
      assert.match(out, /attempt 1: done/);
      assert.match(out, /\[worker\] · t4 · 2k tok/);
      assert.match(out, /result:/);
      assert.match(out, /shipped/);
    } finally { dash2.dispose(); }
  } finally { f.close(); }
});

test("dashboard actions: run/retry/cancel respect quest state", () => {
  const f = fixture();
  try {
    const ids = seed(f.store);
    const calls: string[] = [];
    const dash = questDashboard({
      tui, theme, done: () => {}, store: f.store, project: PROJECT,
      actions: {
        run: (id) => { calls.push(`run:${id}`); return undefined; },
        retry: (id) => { calls.push(`retry:${id}`); return undefined; },
        cancel: (id) => { calls.push(`cancel:${id}`); return undefined; },
      },
    });
    try {
      dash.render(100);
      // Row 0 is the queued quest (newest first): run works.
      dash.handleInput("r");
      assert.deepEqual(calls, [`run:${ids.queued}`]);
      assert.match(dash.state.status ?? "", /✓/);
      // retry on a queued quest is refused before reaching the action.
      dash.handleInput("R");
      assert.equal(calls.length, 1);
      assert.match(dash.state.status ?? "", /cannot retry/);
      // Move to the failed quest: retry works, cancel is refused.
      dash.handleInput("j");
      dash.handleInput("R");
      assert.deepEqual(calls[1], `retry:${ids.failed}`);
      dash.handleInput("x");
      assert.equal(calls.length, 2);
      assert.match(dash.state.status ?? "", /cannot cancel/);
      // Back to queued: cancel works.
      dash.handleInput("k");
      dash.handleInput("x");
      assert.deepEqual(calls[2], `cancel:${ids.queued}`);
    } finally { dash.dispose(); }
  } finally { f.close(); }
});

test("dashboard closes on q and calls done", () => {
  const f = fixture();
  try {
    let closed = false;
    const dash = questDashboard({ tui, theme, done: () => { closed = true; }, store: f.store, project: PROJECT });
    dash.handleInput("q");
    assert.equal(closed, true);
  } finally { f.close(); }
});

test("QUEST_FILTERS stays in sync with filterQuests buckets", () => {
  assert.deepEqual([...QUEST_FILTERS], ["all", "active", "failed", "done", "cancelled"]);
});

test("claimById claims only the eligible target quest", () => {
  const f = fixture();
  try {
    const a = f.store.enqueue({ project: PROJECT, role: "build", task: "a" });
    const b = f.store.enqueue({ project: PROJECT, role: "build", task: "b", dependsOn: [a.id] });
    const later = f.store.enqueue({ project: PROJECT, role: "build", task: "later", scheduledAt: Date.now() + 60_000 });
    assert.equal(f.store.claimById(b.id, PROJECT, "s"), undefined); // dep-blocked
    assert.equal(f.store.claimById(later.id, PROJECT, "s"), undefined); // scheduled later
    assert.equal(f.store.claimById(a.id, "/tmp/other-project", "s"), undefined); // wrong project
    const claimed = f.store.claimById(a.id, PROJECT, "s");
    assert.equal(claimed?.quest.id, a.id);
    assert.equal(f.store.claimById(a.id, PROJECT, "s2"), undefined); // already running under a live lease
  } finally { f.close(); }
});

test("requeue revives terminal quests with one more attempt", () => {
  const f = fixture();
  try {
    const q = f.store.enqueue({ project: PROJECT, role: "build", task: "flaky" }); // maxAttempts 1
    const c = f.store.claimNext(PROJECT, "s")!;
    f.store.attachRun(c.lease, "a1");
    f.store.fail(c.lease, "boom", "a1");
    assert.equal(f.store.get(q.id)?.state, "failed");
    assert.equal(f.store.requeue(q.id, "/tmp/other"), false);
    assert.equal(f.store.requeue(q.id, PROJECT), true);
    const revived = f.store.get(q.id)!;
    assert.equal(revived.state, "queued");
    assert.equal(revived.maxAttempts, 2); // attempts(1) + 1
    const again = f.store.claimNext(PROJECT, "s")!;
    assert.equal(again.quest.id, q.id);
    assert.equal(again.quest.attempts, 2);
    f.store.attachRun(again.lease, "a2");
    f.store.complete(again.lease, "a2", "fixed");
    assert.equal(f.store.get(q.id)?.state, "done");
    assert.equal(f.store.requeue(q.id, PROJECT), false); // done is not requeueable
  } finally { f.close(); }
});
