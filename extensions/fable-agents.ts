/**
 * fable-agents: subagent orchestration (the Task-tool equivalent).
 * - `agent` tool: delegate a task to a role-specialized nested agent session.
 *   Multiple agent calls in one assistant message run concurrently (pi's
 *   default parallel tool execution) — that IS the fan-out mechanism.
 * - `agent_control` tool: list / result / abort for background runs.
 * - Live widget above the editor while agents run; /agents command to manage.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { loadFableConfig, isNested, type FableConfig } from "../src/config.ts";
import { AgentRunner } from "../src/subagent/engine.ts";
import { AGENTS_STATUS, COST_ADD, type RunSummary } from "../src/bus.ts";
import { fmtDuration, fmtUsd } from "../src/text.ts";

export default function (pi: ExtensionAPI) {
  if (isNested()) return; // structurally excluded from subagents anyway; belt and suspenders

  let cfg: FableConfig | undefined;
  let uiRef: { hasUI: boolean; ui: { setWidget(k: string, l?: string[], o?: { placement?: string }): void } } | undefined;

  const runner = new AgentRunner(
    () => cfg ?? loadFableConfig(process.cwd()),
    (running) => {
      pi.events.emit(AGENTS_STATUS, { running });
      updateWidget(running);
    },
    (usd) => pi.events.emit(COST_ADD, { usd }),
  );

  const updateWidget = (all: RunSummary[]) => {
    if (!uiRef?.hasUI) return;
    try {
      const active = all.filter((r) => r.state === "running");
      const lines = active.map((r) => {
        const secs = fmtDuration(Date.now() - r.startedAt);
        return ` ◐ ${r.name} [${r.role}·${r.model}] ${r.lastActivity} · t${r.turns} · ${fmtUsd(r.costUsd)} · ${secs}`;
      });
      uiRef.ui.setWidget("fable-agents", lines.length ? lines : undefined, { placement: "aboveEditor" });
    } catch {
      // stale ui after reload — refreshed on next session_start
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    cfg = loadFableConfig(ctx.cwd);
    uiRef = ctx;
  });

  pi.on("session_shutdown", async () => {
    await runner.abortAll();
  });

  const roleNames = ["explore", "plan", "build", "review", "general"] as const;

  pi.registerTool({
    name: "agent",
    label: "Agent",
    description:
      "Delegate a task to a specialized subagent running in its own context. Roles: explore (fast read-only scout), plan (architect, read-only), build (implements and verifies), review (finds real defects, read-only), general (full toolbox). The subagent cannot ask questions — give it a complete, self-contained task. Set background:true to keep working while it runs; its result is delivered to you when it finishes.",
    promptSnippet: "Delegate a task to a role-specialized subagent (explore/plan/build/review/general)",
    promptGuidelines: [
      "Use agent with role 'explore' to search or map the codebase instead of reading many files yourself; issue several agent calls in ONE message to fan out in parallel.",
      "Give agent tasks that are self-contained: include all context the subagent needs, and say exactly what the result must contain.",
    ],
    parameters: Type.Object({
      role: StringEnum(roleNames),
      task: Type.String({ description: "Complete, self-contained task description including expected output" }),
      context: Type.Optional(Type.String({ description: "Extra context: relevant paths, constraints, prior findings" })),
      name: Type.Optional(Type.String({ description: "Short display name for this run" })),
      background: Type.Optional(Type.Boolean({ description: "Run in background; result is delivered on completion" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      cfg = loadFableConfig(ctx.cwd);
      const { id, promise } = runner.spawn({
        role: params.role,
        task: params.task,
        context: params.context,
        name: params.name,
        background: !!params.background,
        cwd: ctx.cwd,
        modelRegistry: ctx.modelRegistry,
        fallbackModel: ctx.model,
        signal: params.background ? undefined : signal,
        onUpdate: params.background
          ? undefined
          : (activity) => onUpdate?.({ content: [{ type: "text", text: `⚙ ${activity}` }] }),
      });

      if (!params.background) {
        const result = await promise;
        return {
          content: [{ type: "text", text: result.text }],
          details: { ...result.summary },
        };
      }

      // Background: deliver the result via steer when it settles.
      promise
        .then((result) => {
          pi.sendMessage(
            {
              customType: "fable-agent-result",
              content: `Background agent "${result.summary.name}" (${result.summary.role}) finished:\n\n${result.text}`,
              display: true,
            },
            { deliverAs: "steer", triggerTurn: true },
          );
        })
        .catch((err) => {
          try {
            pi.sendMessage(
              {
                customType: "fable-agent-result",
                content: `Background agent failed: ${String(err)}`,
                display: true,
              },
              { deliverAs: "steer", triggerTurn: true },
            );
          } catch {
            // session replaced meanwhile — result is lost (documented limitation)
          }
        });
      return {
        content: [
          {
            type: "text",
            text: `Started background agent "${params.name ?? params.role}" (id ${id}). Its result will be delivered to you when it finishes; check progress with agent_control.`,
          },
        ],
        details: { id, role: params.role, background: true },
      };
    },
  });

  pi.registerTool({
    name: "agent_control",
    label: "Agent Control",
    description: "Manage running subagents: list all runs, get the result of a finished run, or abort a running one.",
    parameters: Type.Object({
      action: StringEnum(["list", "result", "abort"] as const),
      id: Type.Optional(Type.String({ description: "Run id (required for result/abort)" })),
    }),
    async execute(_toolCallId, params) {
      if (params.action === "list") {
        const runs = runner.list();
        const text = runs.length
          ? runs
              .map(
                (r) =>
                  `${r.id} · ${r.name} · ${r.role} · ${r.state} · t${r.turns} · ${fmtUsd(r.costUsd)} · ${r.lastActivity}`,
              )
              .join("\n")
          : "No agent runs this session.";
        return { content: [{ type: "text", text }], details: { runs } };
      }
      if (!params.id) throw new Error(`agent_control ${params.action} requires id`);
      if (params.action === "abort") {
        const ok = await runner.abort(params.id);
        return { content: [{ type: "text", text: ok ? `Aborted ${params.id}.` : `${params.id} is not running.` }] };
      }
      const run = runner.get(params.id);
      if (!run) throw new Error(`Unknown run id ${params.id}`);
      if (run.result) {
        return { content: [{ type: "text", text: run.result.text }], details: { ...run.result.summary } };
      }
      return {
        content: [{ type: "text", text: `${params.id} is still ${run.summary.state} (${run.summary.lastActivity}).` }],
      };
    },
  });

  pi.registerCommand("agents", {
    description: "Show and manage subagent runs",
    handler: async (_args, ctx) => {
      const runs = runner.list();
      if (!runs.length) {
        ctx.ui.notify("No agent runs this session", "info");
        return;
      }
      const items = runs.map(
        (r) => `${r.id} · ${r.name} · ${r.state} · t${r.turns} · ${fmtUsd(r.costUsd)}${r.state === "running" ? " (select to abort)" : ""}`,
      );
      const choice = await ctx.ui.select("Agent runs", items);
      if (choice === undefined) return;
      const picked = runs[items.indexOf(choice)];
      if (picked?.state === "running") {
        const ok = await ctx.ui.confirm("Abort?", `Abort ${picked.name}?`);
        if (ok) await runner.abort(picked.id);
      }
    },
  });
}
