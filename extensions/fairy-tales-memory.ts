/**
 * fairy-tales-memory: persistent cross-session memory.
 * - MEMORY.md index injected into context once per session (and re-injected
 *   after compaction) via before_agent_start.
 * - `remember` tool appends facts (optionally into a topic file).
 * - `/memory` opens the index in an editor dialog.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadFairyTalesConfig, isNested } from "../src/config.ts";
import { MemoryStore } from "../src/memory-store.ts";

export default function (pi: ExtensionAPI) {
  let injected = false;
  let store: MemoryStore | undefined;

  const getStore = (cwd: string): MemoryStore => {
    if (!store) store = new MemoryStore(loadFairyTalesConfig(cwd).memory.dir);
    return store;
  };

  pi.on("session_start", async (_event, ctx) => {
    store = new MemoryStore(loadFairyTalesConfig(ctx.cwd).memory.dir);
    injected = false;
  });

  pi.on("session_compact", async () => {
    // Compaction may squeeze the injected memory out of the kept window; re-inject next prompt.
    injected = false;
  });

  // Context management (#17): if re-injection left more than one memory block in
  // the window, keep only the most recent so stale copies don't waste context.
  pi.on("context", async (event) => {
    if (isNested()) return;
    const messages = (event as { messages?: Array<{ customType?: string }> }).messages;
    if (!messages) return;
    const memIdx = messages
      .map((m, i) => (m.customType === "fairy-tales-memory" ? i : -1))
      .filter((i) => i >= 0);
    if (memIdx.length <= 1) return;
    const keep = memIdx[memIdx.length - 1];
    const filtered = messages.filter((m, i) => m.customType !== "fairy-tales-memory" || i === keep);
    return { messages: filtered };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (injected || isNested()) return;
    const cfg = loadFairyTalesConfig(ctx.cwd);
    if (!cfg.memory.injectIndex) return;
    // Rank against the current prompt so long-lived memory doesn't flood context.
    const prompt = (event as { prompt?: string }).prompt;
    const index = getStore(ctx.cwd).relevantIndex(prompt);
    if (!index) return;
    injected = true;
    return {
      message: {
        customType: "fairy-tales-memory",
        content:
          `<memory>\nPersistent memory from previous sessions (index: ${getStore(ctx.cwd).indexPath}; ` +
          `topic files live in ${getStore(ctx.cwd).topicsDir} and can be read with the read tool):\n\n${index}\n</memory>`,
        display: false,
      },
    };
  });

  pi.registerTool({
    name: "remember",
    label: "Remember",
    description:
      "Save a fact to persistent memory that survives across sessions. Optional topic groups related facts into a topic file.",
    promptSnippet: "Save a durable fact to cross-session memory",
    promptGuidelines: [
      "Use remember when the user states a lasting preference, correction, or project fact worth keeping across sessions. Do not save session-only details.",
    ],
    parameters: Type.Object({
      content: Type.String({ description: "The fact to remember, one or two sentences" }),
      topic: Type.Optional(Type.String({ description: "Optional topic name to group related facts" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const path = await getStore(ctx.cwd).remember(params.content, params.topic);
      return {
        content: [{ type: "text", text: `Remembered (${path})` }],
        details: { path, topic: params.topic },
      };
    },
  });

  pi.registerTool({
    name: "forget",
    label: "Forget",
    description: "Remove memories from the index that match a query (a phrase or keyword). Use to correct outdated or wrong facts.",
    promptSnippet: "Remove outdated or incorrect memories",
    promptGuidelines: [
      "Use forget when the user says a remembered fact is wrong or no longer true; pass a distinctive phrase from the memory.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Phrase or keyword identifying the memory/memories to remove" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const removed = await getStore(ctx.cwd).forget(params.query);
      return {
        content: [{ type: "text", text: removed ? `Forgot ${removed} memor${removed === 1 ? "y" : "ies"} matching "${params.query}".` : `No memories matched "${params.query}".` }],
        details: { removed },
      };
    },
  });

  pi.registerCommand("memory", {
    description: "View and edit persistent memory index",
    handler: async (_args, ctx) => {
      const s = getStore(ctx.cwd);
      const current = s.readIndex() ?? "# Memory\n\n";
      const edited = await ctx.ui.editor("MEMORY.md", current);
      if (edited !== undefined && edited !== current) {
        await s.writeIndex(edited);
        ctx.ui.notify("Memory updated", "info");
      }
    },
  });
}
