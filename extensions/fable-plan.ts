/**
 * fable-plan: plan mode.
 * Enter via /plan, --plan flag, or ctrl+alt+p. While active:
 * - mutating tools (edit/write) are deactivated; fable-hooks additionally
 *   blocks mutating bash and edit/write at the tool_call layer.
 * - the system prompt gets a planning addendum and the agent is told to
 *   finish by calling exit_plan.
 * Exit via the exit_plan tool: user confirms, plan is saved to the plans dir,
 * tools are restored. State survives restarts via custom entries.
 */
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { loadFableConfig, expandHome, isNested } from "../src/config.ts";
import { PLAN_CHANGED } from "../src/bus.ts";
import { slugify } from "../src/text.ts";

const PLAN_ADDENDUM = `

## Plan mode (ACTIVE)

You are in plan mode: a read-only research and design phase.
- Do NOT modify any files or system state. File-mutating tools are disabled and mutating bash commands are blocked.
- Explore the codebase, gather facts, and design an implementation approach.
- When your plan is ready, call the exit_plan tool with the complete plan as markdown. Do not describe the plan in a normal reply instead of calling exit_plan.
- If the user asks questions, answer them; stay in plan mode until exit_plan is accepted.`;

const READONLY_KEEP = new Set(["read", "grep", "find", "ls", "bash", "fetch", "agent", "agent_control", "todo", "exit_plan", "remember"]);

export default function (pi: ExtensionAPI) {
  let active = false;
  let savedTools: string[] | undefined;

  const enter = (ctx: { hasUI: boolean; ui: { setStatus(k: string, t?: string): void; notify(m: string, l?: string): void } }) => {
    if (active) return;
    active = true;
    savedTools = pi.getActiveTools().map((t: { name: string } | string) => (typeof t === "string" ? t : t.name));
    pi.setActiveTools([...new Set([...savedTools.filter((name) => READONLY_KEEP.has(name)), "exit_plan"])]);
    pi.appendEntry("fable-plan", { active: true, savedTools });
    pi.events.emit(PLAN_CHANGED, { active: true });
    if (ctx.hasUI) {
      ctx.ui.setStatus("fable-plan", "◆ PLAN");
      ctx.ui.notify("Plan mode: read-only until exit_plan is accepted", "info");
    }
  };

  const exit = (ctx: { hasUI: boolean; ui: { setStatus(k: string, t?: string): void } }) => {
    if (!active) return;
    active = false;
    if (savedTools?.length) pi.setActiveTools(savedTools);
    savedTools = undefined;
    pi.appendEntry("fable-plan", { active: false });
    pi.events.emit(PLAN_CHANGED, { active: false });
    if (ctx.hasUI) ctx.ui.setStatus("fable-plan", undefined);
  };

  pi.registerFlag("plan", { description: "Start in plan mode", type: "boolean", default: false });

  pi.registerTool({
    name: "exit_plan",
    label: "Exit Plan Mode",
    description:
      "Present the finished plan and request approval to leave plan mode. Call this exactly once, when the plan is complete.",
    parameters: Type.Object({
      plan: Type.String({ description: "The complete implementation plan, as markdown" }),
      title: Type.Optional(Type.String({ description: "Short plan title, used for the saved filename" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!active) {
        return { content: [{ type: "text", text: "Plan mode is not active; proceed normally." }] };
      }
      let approved = true;
      if (ctx.hasUI) {
        const preview = params.plan.split("\n").slice(0, 12).join("\n");
        approved = await ctx.ui.confirm("Approve plan and exit plan mode?", preview);
      }
      if (!approved) {
        return {
          content: [{ type: "text", text: "User rejected the plan. Revise it based on their feedback and call exit_plan again." }],
        };
      }
      const cfg = loadFableConfig(ctx.cwd);
      const plansDir = expandHome(cfg.plans.dir);
      const date = new Date().toISOString().slice(0, 10);
      const file = join(plansDir, `${date}-${slugify(params.title ?? params.plan.split("\n")[0])}.md`);
      await withFileMutationQueue(file, async () => {
        mkdirSync(plansDir, { recursive: true });
        await writeFile(file, params.plan, "utf-8");
      });
      exit(ctx);
      return {
        content: [{ type: "text", text: `Plan approved and saved to ${file}. Plan mode is off — proceed with implementation.` }],
        details: { file },
      };
    },
  });

  pi.registerCommand("plan", {
    description: "Toggle plan mode (read-only research and design)",
    handler: async (_args, ctx) => {
      if (active) {
        exit(ctx);
        if (ctx.hasUI) ctx.ui.notify("Plan mode off", "info");
      } else {
        enter(ctx);
      }
    },
  });

  pi.registerShortcut("ctrl+alt+p", {
    description: "Toggle plan mode",
    handler: async (ctx) => {
      active ? exit(ctx) : enter(ctx);
    },
  });

  pi.on("before_agent_start", async (event) => {
    if (!active) return;
    return { systemPrompt: event.systemPrompt + PLAN_ADDENDUM };
  });

  pi.on("session_start", async (event, ctx) => {
    if (isNested()) return;
    // Rebuild plan state from the session (restart/resume survival).
    let last: { active?: boolean; savedTools?: string[] } | undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && (entry as { customType?: string }).customType === "fable-plan") {
        last = (entry as { data?: { active?: boolean; savedTools?: string[] } }).data;
      }
    }
    active = false;
    savedTools = undefined;
    if (last?.active) {
      // Re-enter without appending a duplicate entry.
      active = true;
      savedTools = last.savedTools;
      pi.setActiveTools([...new Set([...(last.savedTools ?? []).filter((name) => READONLY_KEEP.has(name)), "exit_plan"])]);
      pi.events.emit(PLAN_CHANGED, { active: true });
      if (ctx.hasUI) ctx.ui.setStatus("fable-plan", "◆ PLAN");
    } else if (event.reason === "startup" && pi.getFlag("plan")) {
      enter(ctx);
    }
  });
}
