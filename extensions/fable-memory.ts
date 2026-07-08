/**
 * fable-memory: persistent cross-session memory.
 * - MEMORY.md index injected into context once per session (and re-injected
 *   after compaction) via before_agent_start.
 * - `remember` tool appends facts (optionally into a topic file).
 * - `/memory` opens the index in an editor dialog.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadFableConfig, isNested } from "../src/config.ts";
import { MemoryStore } from "../src/memory-store.ts";

export default function (pi: ExtensionAPI) {
  let injected = false;
  let store: MemoryStore | undefined;

  const getStore = (cwd: string): MemoryStore => {
    if (!store) store = new MemoryStore(loadFableConfig(cwd).memory.dir);
    return store;
  };

  pi.on("session_start", async (_event, ctx) => {
    store = new MemoryStore(loadFableConfig(ctx.cwd).memory.dir);
    injected = false;
  });

  pi.on("session_compact", async () => {
    // Compaction may squeeze the injected memory out of the kept window; re-inject next prompt.
    injected = false;
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (injected || isNested()) return;
    const cfg = loadFableConfig(ctx.cwd);
    if (!cfg.memory.injectIndex) return;
    const index = getStore(ctx.cwd).readIndex();
    if (!index) return;
    injected = true;
    return {
      message: {
        customType: "fable-memory",
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
