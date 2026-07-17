/**
 * In-process smoke test: load the real extension modules against a stub
 * ExtensionAPI and drive their registered tools exactly as pi would —
 * verifies registration and the tool execute() paths that don't require a
 * live model (quest lifecycle, codebase_intel queries).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import agentsExtension from "../../extensions/fairy-tales-agents.ts";
import codeIntelExtension from "../../extensions/fairy-tales-code-intel.ts";

interface RegisteredTool {
  name: string;
  execute(id: string, params: Record<string, unknown>, signal?: unknown, onUpdate?: unknown, ctx?: unknown): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
}

function stubPi() {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, unknown>();
  const handlers = new Map<string, unknown[]>();
  return {
    tools,
    commands,
    api: {
      registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
      registerCommand(name: string, def: unknown) { commands.set(name, def); },
      registerShortcut() { /* unused */ },
      on(event: string, handler: unknown) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
      events: { on() { /* unused */ }, emit() { /* unused */ } },
      sendMessage() { /* unused */ },
    },
  };
}

function tempProject(): { cwd: string; close: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "fairy-smoke-"));
  // Project-level config redirects the quest DB into the temp dir so the
  // smoke test never touches the user's real journal.
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "fairy-tales.json"), JSON.stringify({
    quests: { path: join(cwd, "quests.sqlite"), maxHistory: 50, autoResume: false },
  }));
  writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(cwd, "b.ts"), 'import { a } from "./a.ts";\nexport const b = a;\n');
  return { cwd, close: () => rmSync(cwd, { recursive: true, force: true }) };
}

const text = (r: { content: Array<{ type: string; text: string }> }) => r.content.map((c) => c.text).join("\n");

test("agents extension registers and the quest tool works end to end", async () => {
  const pi = stubPi();
  agentsExtension(pi.api as never);
  assert.deepEqual([...pi.tools.keys()].sort(), ["agent", "agent_control", "quest"]);
  assert.ok(pi.commands.has("quests"));

  const p = tempProject();
  try {
    const quest = pi.tools.get("quest")!;
    const ctx = { cwd: p.cwd, hasUI: false };

    const enq = await quest.execute("t1", {
      action: "enqueue", role: "build", task: "Smoke task", name: "Smoke",
      dedupeKey: "smoke/run/main", chain: { chain: "smoke", runId: "run", phase: "main" }, retainUntilConsumed: true,
      priority: 2,
    }, undefined, undefined, ctx);
    assert.match(text(enq), /Queued q-/);
    const id = (enq.details as { quest: { id: string } }).quest.id;

    const dup = await quest.execute("t2", { action: "enqueue", role: "build", task: "Smoke again", dedupeKey: "smoke/run/main" }, undefined, undefined, ctx);
    assert.match(text(dup), /existing quest returned by dedupeKey/);
    assert.equal((dup.details as { quest: { id: string } }).quest.id, id);

    const list = await quest.execute("t3", { action: "list" }, undefined, undefined, ctx);
    assert.match(text(list), new RegExp(`${id}.*queued.*p2`));

    const get = await quest.execute("t4", { action: "get", id }, undefined, undefined, ctx);
    assert.match(text(get), /Smoke task/);

    const cancel = await quest.execute("t5", { action: "cancel", id }, undefined, undefined, ctx);
    assert.match(text(cancel), /Cancelled/);

    const requeue = await quest.execute("t6", { action: "requeue", id }, undefined, undefined, ctx);
    assert.match(text(requeue), /Requeued/);

    const events = await quest.execute("t7", { action: "events", id }, undefined, undefined, ctx);
    assert.match(text(events), /requeued/);
    assert.match(text(events), /enqueued/);
  } finally {
    p.close();
  }
});

test("codebase_intel extension registers and answers all four actions", async () => {
  const pi = stubPi();
  codeIntelExtension(pi.api as never);
  const tool = pi.tools.get("codebase_intel")!;
  assert.ok(tool);

  const p = tempProject();
  try {
    const ctx = { cwd: p.cwd, hasUI: false };
    const status = await tool.execute("s", { action: "status" }, undefined, undefined, ctx);
    assert.match(text(status), /Index: 2 files/);
    const deps = await tool.execute("d", { action: "deps", path: "b.ts" }, undefined, undefined, ctx);
    assert.match(text(deps), /a\.ts/);
    const impact = await tool.execute("i", { action: "impact", path: "a.ts" }, undefined, undefined, ctx);
    assert.match(text(impact), /b\.ts/);
    const hot = await tool.execute("h", { action: "hotspots" }, undefined, undefined, ctx);
    assert.match(text(hot), /a\.ts/);
  } finally {
    p.close();
  }
});
