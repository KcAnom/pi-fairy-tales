/**
 * fairy-tales-agents: subagent orchestration (the Task-tool equivalent).
 * - `agent` tool: delegate a task to a role-specialized nested agent session.
 *   Multiple agent calls in one assistant message run concurrently (pi's
 *   default parallel tool execution) — that IS the fan-out mechanism.
 * - `agent_control` tool: list / result / abort for background runs.
 * - Live widget above the editor while agents run; /agents command to manage.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { loadFairyTalesConfig, resolveTierModel, saveUserConfig, isNested, roleNames, type FairyTalesConfig } from "../src/config.ts";
import { AgentRunner } from "../src/subagent/engine.ts";
import { AGENTS_STATUS, COST_ADD, type RunSummary } from "../src/bus.ts";
import { fmtDuration, fmtUsd, fmtTokens } from "../src/text.ts";

// Storybook glyphs for roles (matches the Fae Council names when branded).
const ROLE_GLYPH: Record<string, string> = {
  explore: "🕯",
  plan: "✶",
  build: "⚒",
  review: "🪶",
  general: "🜍",
};

export default function (pi: ExtensionAPI) {
  if (isNested()) return; // structurally excluded from subagents anyway; belt and suspenders

  let cfg: FairyTalesConfig | undefined;
  let uiRef: { hasUI: boolean; ui: { setWidget(k: string, l?: string[], o?: { placement?: string }): void } } | undefined;

  const runner = new AgentRunner(
    () => cfg ?? loadFairyTalesConfig(process.cwd()),
    (running) => {
      pi.events.emit(AGENTS_STATUS, { running });
      updateWidget(running);
    },
    (usd) => pi.events.emit(COST_ADD, { usd, source: "subagent" }),
  );

  // The Fae Council: storybook identities for subagent roles, ftales-only.
  const FAE: Record<string, string> | undefined =
    process.env.FTALES === "1"
      ? {
          explore: "🕯 Will-o'-Wisp",
          plan: "✶ the Sage",
          build: "⚒ the Smith",
          review: "🪶 the Raven",
          general: "🜍 the Wanderer",
        }
      : undefined;

  const roleLabel = (role: string) => FAE?.[role] ?? role;

  const updateWidget = (all: RunSummary[]) => {
    if (!uiRef?.hasUI) return;
    try {
      const active = all.filter((r) => r.state === "running");
      const lines = active.map((r) => {
        const secs = fmtDuration(Date.now() - r.startedAt);
        const mark = FAE ? "✧" : "◐";
        return ` ${mark} ${roleLabel(r.role)} · ${r.name} [${r.model}] ${r.lastActivity} · t${r.turns} · ${fmtUsd(r.costUsd)} · ${secs}`;
      });
      uiRef.ui.setWidget("fairy-tales-agents", lines.length ? lines : undefined, { placement: "aboveEditor" });
    } catch {
      // stale ui after reload — refreshed on next session_start
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    cfg = loadFairyTalesConfig(ctx.cwd);
    uiRef = ctx;
  });

  pi.on("session_shutdown", async () => {
    await runner.abortAll();
  });

  // Role enum is derived from config so custom roles are reachable (#14).
  const cfgRoles = roleNames(loadFairyTalesConfig(process.cwd()));
  const roleEnum = (cfgRoles.length ? cfgRoles : ["explore", "plan", "build", "review", "general"]) as [string, ...string[]];
  const roleDescriptions = Object.entries(loadFairyTalesConfig(process.cwd()).agents.roles)
    .map(([n, r]) => `${n} (${r.description ?? "custom role"})`)
    .join(", ");

  pi.registerTool({
    name: "agent",
    label: "Agent",
    description:
      `Delegate a task to a specialized subagent running in its own context. Roles: ${roleDescriptions}. The subagent cannot ask questions — give it a complete, self-contained task. Set background:true to keep working while it runs; its result is delivered to you when it finishes. Overflow beyond the concurrency limit is queued, not rejected.`,
    promptSnippet: "Delegate a task to a role-specialized subagent",
    promptGuidelines: [
      "Use agent with role 'explore' to search or map the codebase instead of reading many files yourself; issue several agent calls in ONE message to fan out in parallel.",
      "Give agent tasks that are self-contained: include all context the subagent needs, and say exactly what the result must contain.",
      "Use agent_control with action 'continue' and a follow-up task to ask a just-finished agent a follow-up question without re-spawning.",
    ],
    parameters: Type.Object({
      role: StringEnum(roleEnum),
      task: Type.String({ description: "Complete, self-contained task description including expected output" }),
      context: Type.Optional(Type.String({ description: "Extra context: relevant paths, constraints, prior findings" })),
      name: Type.Optional(Type.String({ description: "Short display name for this run" })),
      background: Type.Optional(Type.Boolean({ description: "Run in background; result is delivered on completion" })),
    }),
    renderResult(result, opts, theme) {
      const d = (result.details ?? {}) as Partial<RunSummary> & { structured?: { status?: string } };
      const glyph = ROLE_GLYPH[d.role ?? ""] ?? "✧";
      const status = d.structured?.status ? ` · ${d.structured.status}` : "";
      const header =
        theme.fg("accent", `${glyph} ${d.name ?? "agent"}`) +
        theme.fg("dim", ` [${d.role}·${d.model}] · t${d.turns ?? 0} · ${fmtTokens(d.tokens ?? 0)} tok · ${fmtUsd(d.costUsd ?? 0)}${status}`);
      const expanded = (opts as { expanded?: boolean })?.expanded;
      if (!expanded) return new Text(header, 0, 0);
      const body = (result.content ?? [])
        .map((c) => (c as { text?: string }).text ?? "")
        .join("\n");
      return new Text(`${header}\n${theme.fg("text", body)}`, 0, 0);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      cfg = loadFairyTalesConfig(ctx.cwd);
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
          details: { ...result.summary, structured: result.structured },
        };
      }

      // Background: deliver the result via steer when it settles.
      promise
        .then((result) => {
          pi.sendMessage(
            {
              customType: "fairy-tales-agent-result",
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
                customType: "fairy-tales-agent-result",
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
    description:
      "Manage subagents: 'list' all runs, 'result' to get a finished run's output, 'abort' a running one, 'continue' to send a follow-up task to a recently finished agent (reuses its context), or 'transcript' to get the path to a finished run's full message log for debugging.",
    parameters: Type.Object({
      action: StringEnum(["list", "result", "abort", "continue", "transcript"] as const),
      id: Type.Optional(Type.String({ description: "Run id (required for result/abort/continue/transcript)" })),
      task: Type.Optional(Type.String({ description: "Follow-up task (required for continue)" })),
    }),
    async execute(_toolCallId, params, signal) {
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
      if (params.action === "continue") {
        if (!params.task) throw new Error("agent_control continue requires a task");
        const result = await runner.continue(params.id, params.task, signal);
        if (!result) throw new Error(`Unknown run id ${params.id}`);
        return { content: [{ type: "text", text: result.text }], details: { ...result.summary, structured: result.structured } };
      }
      if (params.action === "transcript") {
        const r = runner.get(params.id);
        if (!r) throw new Error(`Unknown run id ${params.id}`);
        const path = r.summary.transcriptPath;
        return {
          content: [{ type: "text", text: path ? `Transcript: ${path} (read it for the full run)` : `No transcript saved for ${params.id}.` }],
          details: { transcriptPath: path },
        };
      }
      const run = runner.get(params.id);
      if (!run) throw new Error(`Unknown run id ${params.id}`);
      if (run.result) {
        return { content: [{ type: "text", text: run.result.text }], details: { ...run.result.summary, structured: run.result.structured } };
      }
      return {
        content: [{ type: "text", text: `${params.id} is still ${run.summary.state} (${run.summary.lastActivity}).` }],
      };
    },
  });

  // What each shipped tier is for — shown in the wizard so the choice is informed.
  const TIER_HINT: Record<string, string> = {
    scout: "cheap & fast: exploration, compaction summaries",
    worker: "your main model: implementation",
    brain: "your best model: planning, review",
  };

  pi.registerCommand("agent-model", {
    description: "Set subagent models: a wizard to pick a model per tier, or one model for all",
    handler: async (_args, ctx) => {
      const current = loadFairyTalesConfig(ctx.cwd);
      const mode =
        current.agents.modelMode === "single"
          ? `single (${current.agents.singleModel === "session" ? "follows session model" : current.agents.singleModel})`
          : "tiered (per role)";

      const TIERED = "Tiered — pick a model per tier (recommended: saves tokens)";
      const SESSION = "Single — always follow my session model";
      const available =
        ((await (
          ctx.modelRegistry as unknown as {
            getAvailable(): Array<{ provider: string; id: string; cost?: { input?: number; output?: number } }>;
          }
        ).getAvailable()) as Array<{ provider: string; id: string; cost?: { input?: number; output?: number } }>) ??
        [];
      const modelItems = available.map((m) => `Single — ${m.provider}/${m.id}`);

      const choice = await ctx.ui.select(`Subagent model mode (now: ${mode})`, [TIERED, SESSION, ...modelItems]);
      if (choice === undefined) return;

      if (choice === TIERED) {
        // Wizard: one pick per tier from the user's own available models, with
        // pricing shown so "cheap" is a fact and not a guess. Esc anywhere cancels
        // the whole wizard without saving.
        const priceOf = (m: { cost?: { input?: number; output?: number } }) => {
          const i = m.cost?.input ?? 0;
          const o = m.cost?.output ?? 0;
          return i <= 0 && o <= 0 ? "free/local" : `$${i}/$${o} per Mtok`;
        };
        const modelChoices = available.map((m) => `${m.provider}/${m.id} — ${priceOf(m)}`);
        const tiers: Record<string, { model: string; thinkingLevel?: string }> = {};
        for (const [name, tier] of Object.entries(current.tiers ?? {})) {
          const resolvedNow = resolveTierModel(ctx.modelRegistry, current, name);
          const keep = resolvedNow ? [`Keep current — ${tier.model}`] : [];
          const hint = TIER_HINT[name] ?? "custom tier";
          const pick = await ctx.ui.select(`Model for "${name}" tier (${hint})`, [...keep, ...modelChoices]);
          if (pick === undefined) return; // cancelled — save nothing
          const idx = modelChoices.indexOf(pick);
          if (idx >= 0) {
            const m = available[idx];
            tiers[name] = { model: `${m.provider}/${m.id}`, thinkingLevel: tier.thinkingLevel };
          }
        }
        const path = await saveUserConfig({ tiers, agents: { modelMode: "tiered" } });
        cfg = loadFairyTalesConfig(ctx.cwd);
        const summary = Object.entries(cfg.tiers ?? {})
          .map(([n, t]) => `${n}=${t.model}`)
          .join(", ");
        ctx.ui.notify(`Subagent models: tiered — ${summary} (saved to ${path})`, "info");
        return;
      }

      let patch: { agents: { modelMode: string; singleModel?: string } };
      let label: string;
      if (choice === SESSION) {
        patch = { agents: { modelMode: "single", singleModel: "session" } };
        label = "single: session model";
      } else {
        const spec = choice.replace("Single — ", "");
        patch = { agents: { modelMode: "single", singleModel: spec } };
        label = `single: ${spec}`;
      }
      const path = await saveUserConfig(patch);
      cfg = loadFairyTalesConfig(ctx.cwd);
      ctx.ui.notify(`Subagent models: ${label} (saved to ${path})`, "info");
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
