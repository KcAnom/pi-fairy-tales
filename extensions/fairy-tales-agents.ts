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
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildLoadoutSnapshot,
  isNested,
  loadFairyTalesConfig,
  loadoutSummary,
  loadoutToPatch,
  resolveCheapestModel,
  resolveTierModel,
  roleNames,
  saveUserConfig,
  updateUserConfig,
  type FairyTalesConfig,
  type Loadout,
} from "../src/config.ts";
import { bookOverlay } from "../src/overlay.ts";
import { AgentRunner, shouldEscalate, type RunResult } from "../src/subagent/engine.ts";
import { QuestStore, type QuestRecord } from "../src/quest-store.ts";
import { QuestRuntime, type ClaimedQuest } from "../src/quest-runtime.ts";
import { QuestScheduler } from "../src/quest-scheduler.ts";
import { AGENTS_STATUS, COST_ADD, type CostAddPayload, type RunSummary } from "../src/bus.ts";
import { fmtDuration, fmtUsd, fmtTokens, shortModelId } from "../src/text.ts";
import { createSpendTracker } from "../src/spend.ts";

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
  let questStore: QuestStore | undefined;
  let questRuntime: QuestRuntime | undefined;
  let questScheduler: QuestScheduler | undefined;
  let projectCwd = process.cwd();
  let sessionOwner = randomUUID();
  let shuttingDown = false;
  let uiRef: { hasUI: boolean; ui: { setWidget(k: string, l?: string[], o?: { placement?: string }): void } } | undefined;

  // Session spend tracker — feeds on the same events the footer/status/ledger
  // do, so the circuit breaker fires at exactly the total the user sees.
  const spend = createSpendTracker();
  pi.events.on(COST_ADD, (d: CostAddPayload) => spend.addCostFromEvent(d));

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

  const questLine = (q: QuestRecord) => {
    const extras =
      (q.priority ? ` · p${q.priority}` : "") +
      (q.retryAt && q.state === "queued" ? ` · retry ${new Date(q.retryAt).toLocaleTimeString()}` : "") +
      (q.dependsOn.length ? ` · after ${q.dependsOn.join(",")}` : "");
    return `${q.id} · ${q.state} · ${q.role} · ${q.name} · attempts ${q.attempts}/${q.maxAttempts}${extras}`;
  };

  const openQuestStore = (cwd: string): void => {
    const current = cfg ?? loadFairyTalesConfig(cwd);
    try { questStore?.close(); } catch { /* stale reload */ }
    questStore = new QuestStore({
      path: current.quests.path,
      maxHistory: current.quests.maxHistory,
      leaseTtlMs: current.quests.leaseTtlMs,
      maxAttempts: current.quests.maxAttempts,
      backoffBaseMs: current.quests.backoffBaseMs,
    });
    questRuntime = new QuestRuntime({ store: questStore, ownerSession: sessionOwner, heartbeatMs: current.quests.heartbeatMs });
    projectCwd = cwd;
  };

  const updateQuestWidget = () => {
    if (!uiRef?.hasUI || !questStore) return;
    try {
      const active = questStore.list(projectCwd, 50).filter((q) => q.state === "queued" || q.state === "running" || q.state === "interrupted");
      const lines = active.slice(0, 5).map((q) => ` ${q.state === "running" ? "◐" : "☐"} ${q.name} · ${q.role} · ${q.id}`);
      uiRef.ui.setWidget("fairy-tales-quests", lines.length ? lines : undefined, { placement: "aboveEditor" });
    } catch { /* store may be closing during reload */ }
  };

  const runClaimedQuest = async (claimed: ClaimedQuest, ctx: any, background: boolean, signal?: AbortSignal): Promise<RunResult | { id: string; settled: Promise<void> }> => {
    const runtime = questRuntime;
    if (!runtime) throw new Error("Quest journal is not initialized");
    const { quest, lease } = claimed;
    let spawned;
    try {
      spawned = runner.spawn({
        role: quest.role, task: quest.task, context: quest.context, name: quest.name,
        background, cwd: quest.project, modelRegistry: ctx.modelRegistry,
        fallbackModel: ctx.model, signal: background ? undefined : signal,
      });
    } catch (err) {
      runtime.fail(lease, `dispatch failed: ${String(err)}`);
      updateQuestWidget();
      throw err;
    }
    // If the lease expires (missed heartbeats) and another session reclaims the
    // quest, abort our worker — its write-backs would be fenced out anyway.
    runtime.setLeaseLostHandler(quest.id, () => void runner.abort(spawned.id));
    if (!runtime.attachRun(lease, spawned.id)) {
      void runner.abort(spawned.id);
      runtime.release(quest.id);
      throw new Error(`Quest ${quest.id} lost ownership before its agent started`);
    }
    updateQuestWidget();
    const pushTelemetry = () => {
      const s = runner.get(spawned.id)?.summary;
      if (s) runtime.updateTelemetry(lease, { model: s.model, tier: s.tier, turns: s.turns, tokens: s.tokens, costUsd: s.costUsd, lastActivity: s.lastActivity });
    };
    pushTelemetry();
    const telemetryTimer = setInterval(pushTelemetry, 15_000);
    (telemetryTimer as { unref?: () => void }).unref?.();
    // Settle exactly once: telemetry flush happens before the terminal write
    // because complete/fail invalidate the lease that fences updateTelemetry.
    const settle = (result?: RunResult, err?: unknown) => {
      clearInterval(telemetryTimer);
      pushTelemetry();
      if (result && result.summary.state === "done") runtime.complete(lease, spawned.id, result.text);
      else if (!shuttingDown) runtime.fail(lease, result ? result.text : String(err), spawned.id);
      else runtime.release(quest.id); // shutdown path: recoverOwned marks it interrupted
      updateQuestWidget();
    };
    if (background) {
      const settled = spawned.promise.then((result) => {
        settle(result);
        try {
          pi.sendMessage({ customType: "fairy-tales-quest-result", content: `Quest ${quest.id} “${quest.name}” completed:\n\n${result.text}`, display: true }, { deliverAs: "steer", triggerTurn: true });
        } catch { /* session changed */ }
      }).catch((err) => {
        settle(undefined, err);
        try {
          pi.sendMessage({ customType: "fairy-tales-quest-result", content: `Quest ${quest.id} “${quest.name}” failed: ${String(err)}`, display: true }, { deliverAs: "steer", triggerTurn: true });
        } catch { /* session changed */ }
      });
      return { id: spawned.id, settled };
    }
    try {
      const result = await spawned.promise;
      settle(result);
      return result;
    } catch (err) {
      settle(undefined, err);
      throw err;
    }
  };

  const updateWidget = (all: RunSummary[]) => {
    if (!uiRef?.hasUI) return;
    try {
      const active = all.filter((r) => r.state === "running");
      const lines = active.map((r) => {
        const secs = fmtDuration(Date.now() - r.startedAt);
        const mark = FAE ? "✧" : "◐";
        return ` ${mark} ${roleLabel(r.role)} · ${r.name} [${r.tier ?? r.role}·${shortModelId(r.model)}] ${r.lastActivity} · t${r.turns} · ${fmtUsd(r.costUsd)} · ${secs}`;
      });
      uiRef.ui.setWidget("fairy-tales-agents", lines.length ? lines : undefined, { placement: "aboveEditor" });
    } catch {
      // stale ui after reload — refreshed on next session_start
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    cfg = loadFairyTalesConfig(ctx.cwd);
    projectCwd = ctx.cwd;
    sessionOwner = randomUUID();
    shuttingDown = false;
    uiRef = ctx;
    spend.reset();
    questScheduler?.stop();
    questScheduler = undefined;
    openQuestStore(ctx.cwd);
    try { questStore?.reclaimExpired(ctx.cwd); } catch { /* visibility only */ }
    updateQuestWidget();
    if (cfg.scheduler?.enabled && questRuntime) {
      // Persistent scheduler drains the whole queue (including interrupted
      // work), so the single-shot autoResume claim is subsumed by it.
      questScheduler = new QuestScheduler({
        runtime: questRuntime,
        project: ctx.cwd,
        pollMs: cfg.scheduler.pollMs,
        maxConcurrent: cfg.scheduler.maxConcurrent,
        isPaused: () => {
          const cap = (cfg ?? loadFairyTalesConfig(projectCwd)).agents.maxCostPerSessionUsd;
          return cap && spend.exceeded(cap) ? `session cost cap ${fmtUsd(cap)} reached` : undefined;
        },
        dispatch: async (claimed) => {
          const out = await runClaimedQuest(claimed, ctx, true);
          await (out as { settled: Promise<void> }).settled;
        },
        onError: (err) => {
          if (ctx.hasUI) {
            try { ctx.ui.notify(`Quest scheduler: ${String(err)}`, "error"); } catch { /* stale ui */ }
          }
        },
      });
      questScheduler.start();
    } else if (cfg.quests.autoResume) {
      const next = questRuntime?.claimNext(ctx.cwd);
      if (next) void runClaimedQuest(next, ctx, true).catch((err) => {
        if (ctx.hasUI) ctx.ui.notify(`Auto-resume failed for ${next.quest.id}: ${String(err)}`, "error");
      });
    }
    // Orchestrated mode: the session model IS the conductor — align it.
    if (cfg.agents.modelMode === "orchestrated") {
      const cond = cfg.tiers?.conductor?.model;
      const slash = cond?.indexOf("/") ?? -1;
      if (cond && slash > 0) {
        const condId = cond.slice(slash + 1);
        const currentId = (ctx.model as { id?: string } | undefined)?.id;
        if (currentId !== condId) {
          const model = ctx.modelRegistry.find(cond.slice(0, slash), condId);
          const setModel = (ctx as unknown as { setModel?: (m: unknown) => Promise<boolean> }).setModel;
          if (model && typeof setModel === "function") {
            try {
              const ok = await setModel.call(ctx, model);
              if (ok && ctx.hasUI) ctx.ui.notify(`🎼 Orchestrated: session aligned to conductor (${condId})`, "info");
            } catch {
              if (ctx.hasUI) ctx.ui.notify(`🎼 Orchestrated: conductor is ${cond} — switch with /model`, "warning");
            }
          } else if (ctx.hasUI) {
            ctx.ui.notify(`🎼 Orchestrated: conductor is ${cond} but session runs ${currentId} — switch with /model`, "warning");
          }
        }
      }
    }
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    questScheduler?.stop();
    questScheduler = undefined;
    await runner.abortAll();
    try { questRuntime?.shutdown(projectCwd); } catch { /* best effort */ }
    try { questStore?.close(); } catch { /* already closed */ }
    questRuntime = undefined;
    questStore = undefined;
  });

  // Track main-session spend so the circuit breaker sees the full picture.
  pi.on("message_end", async (event) => {
    const msg = event.message as { role?: string; usage?: Record<string, unknown> };
    if (msg?.role === "assistant" && msg.usage) spend.addUsage(msg.usage as never);
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
      // Storybook glyphs only in ftales; plain pi gets a neutral marker (mirrors
      // the FAE ? "✧" : "◐" gate already used in the live widget).
      const glyph = process.env.FTALES === "1" ? (ROLE_GLYPH[d.role ?? ""] ?? "✧") : "◆";
      const status = d.structured?.status ? ` · ${d.structured.status}` : "";
      const header =
        theme.fg("accent", `${glyph} ${d.name ?? "agent"}`) +
        theme.fg("dim", ` [${d.role}·${d.tier ?? "?"}·${shortModelId(d.model ?? "?")}] · t${d.turns ?? 0} · ${fmtTokens(d.tokens ?? 0)} tok · ${fmtUsd(d.costUsd ?? 0)}${status}`);
      const expanded = (opts as { expanded?: boolean })?.expanded;
      if (!expanded) return new Text(header, 0, 0);
      const body = (result.content ?? [])
        .map((c) => (c as { text?: string }).text ?? "")
        .join("\n");
      return new Text(`${header}\n${theme.fg("text", body)}`, 0, 0);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      cfg = loadFairyTalesConfig(ctx.cwd);

      // Session spend circuit breaker: block new subagent spawns when the
      // session total exceeds the configured ceiling. The main conversation
      // continues — only delegation is blocked.
      const sessionCap = cfg.agents.maxCostPerSessionUsd;
      if (sessionCap && spend.exceeded(sessionCap)) {
        return {
          content: [
            {
              type: "text",
              text:
                `⚠ Session spend limit reached: ${fmtUsd(spend.getTotal())} of ${fmtUsd(sessionCap)}. ` +
                `New subagent spawns are blocked so the total can't climb further. ` +
                `Complete the work directly in this conversation, or raise agents.maxCostPerSessionUsd in ~/.pi/agent/fairy-tales.json.`,
            },
          ],
          details: { sessionSpendBlocked: true, total: spend.getTotal(), cap: sessionCap },
        };
      }

      // Orchestrated mode: a failed cheap-tier run retries ONCE on the
      // conductor tier, with the failed attempt's report attached.
      const maybeEscalate = async (result: RunResult): Promise<RunResult & { escalated?: boolean }> => {
        const c = loadFairyTalesConfig(ctx.cwd);
        const roleTier = c.agents.roles[params.role]?.tier;
        if (!shouldEscalate(c, roleTier, result.summary, result.structured, false)) return result;
        onUpdate?.({ content: [{ type: "text", text: `⟳ ${roleTier}-tier attempt failed — escalating to conductor` }], details: {} });
        const esc = runner.spawn({
          role: params.role,
          tierOverride: "conductor",
          task: params.task,
          context: `${params.context ? `${params.context}\n\n` : ""}[ESCALATION] A ${roleTier}-tier attempt at this task failed. Its final report follows — diagnose what went wrong and complete the task properly.\n---\n${result.text.slice(-4000)}`,
          name: `${params.name ?? params.role}⤴`,
          background: false,
          cwd: ctx.cwd,
          modelRegistry: ctx.modelRegistry,
          fallbackModel: ctx.model,
          signal: params.background ? undefined : signal,
          onUpdate: params.background
            ? undefined
            : (activity) => onUpdate?.({ content: [{ type: "text", text: `⚙ ${activity}` }], details: {} }),
        });
        const second = await esc.promise;
        return { ...second, escalated: true };
      };

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
        const result = await maybeEscalate(await promise);
        return {
          content: [{ type: "text", text: result.text }],
          details: { ...result.summary, structured: result.structured, escalated: result.escalated },
        };
      }

      // Background: deliver the result via steer when it settles.
      promise
        .then((first) => maybeEscalate(first))
        .then((result) => {
          pi.sendMessage(
            {
              customType: "fairy-tales-agent-result",
              content: `Background agent "${result.summary.name}" (${result.summary.role}) finished${result.escalated ? " (escalated to conductor after a failed cheap-tier attempt)" : ""}:\n\n${result.text}`,
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
    name: "quest",
    label: "Quest Journal",
    description:
      "Durable provider-neutral work queue. Enqueue agent work that survives session restarts, run the next queued quest, inspect history/events, or cancel work that has not started.",
    promptSnippet: "Queue durable agent work that can resume across sessions",
    promptGuidelines: [
      "Use quest instead of agent when work must survive a session restart or needs an auditable lifecycle.",
      "Use action 'run' to claim and dispatch the oldest queued/interrupted quest for this project.",
    ],
    parameters: Type.Object({
      action: StringEnum(["enqueue", "run", "list", "get", "events", "cancel"] as const),
      role: Type.Optional(StringEnum(roleEnum)),
      task: Type.Optional(Type.String({ description: "Self-contained task for enqueue" })),
      context: Type.Optional(Type.String({ description: "Extra context for the delegated agent" })),
      name: Type.Optional(Type.String({ description: "Short quest name" })),
      id: Type.Optional(Type.String({ description: "Quest id for get/events/cancel" })),
      background: Type.Optional(Type.Boolean({ description: "For run: return immediately and deliver the result later (default true)" })),
      priority: Type.Optional(Type.Integer({ description: "For enqueue: higher runs first (default 0)" })),
      dependsOn: Type.Optional(Type.Array(Type.String(), { description: "For enqueue: quest ids that must complete first" })),
      maxAttempts: Type.Optional(Type.Integer({ description: "For enqueue: failure retry budget (default from config; 1 = no retries)" })),
      notBefore: Type.Optional(Type.String({ description: "For enqueue: ISO timestamp before which the quest must not run" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      cfg = loadFairyTalesConfig(ctx.cwd);
      if (!questStore || !questRuntime) openQuestStore(ctx.cwd);
      if (params.action === "enqueue") {
        if (!params.role || !params.task) throw new Error("quest enqueue requires role and task");
        const scheduledAt = params.notBefore ? Date.parse(params.notBefore) : undefined;
        if (params.notBefore && Number.isNaN(scheduledAt)) throw new Error(`quest enqueue: cannot parse notBefore "${params.notBefore}"`);
        const q = questStore!.enqueue({
          project: ctx.cwd, role: params.role, task: params.task, context: params.context, name: params.name,
          priority: params.priority, dependsOn: params.dependsOn, maxAttempts: params.maxAttempts, scheduledAt,
        });
        updateQuestWidget();
        return { content: [{ type: "text", text: `Queued ${questLine(q)}\nRun it with quest action='run'.` }], details: { quest: q } };
      }
      if (params.action === "run") {
        const claimed = questRuntime!.claimNext(ctx.cwd);
        if (!claimed) return { content: [{ type: "text", text: "No claimable quests for this project (queued work may be scheduled later, waiting on retry backoff, or blocked on dependencies)." }] };
        const background = params.background !== false;
        const outcome = await runClaimedQuest(claimed, ctx, background, _signal);
        const text = background
          ? `Started ${claimed.quest.id} “${claimed.quest.name}” as background agent ${(outcome as { id: string }).id}.`
          : (outcome as RunResult).text;
        return { content: [{ type: "text", text }], details: { quest: questStore!.get(claimed.quest.id), background } };
      }
      if (params.action === "list") {
        const rows = questStore!.list(ctx.cwd);
        return { content: [{ type: "text", text: rows.length ? rows.map(questLine).join("\n") : "No quests for this project." }], details: { quests: rows } };
      }
      if (!params.id) throw new Error(`quest ${params.action} requires id`);
      if (params.action === "cancel") {
        const cancelled = questStore!.cancel(params.id, ctx.cwd);
        updateQuestWidget();
        return { content: [{ type: "text", text: cancelled ? `Cancelled ${params.id}.` : `${params.id} is not queued/interrupted or does not exist.` }] };
      }
      const q = questStore!.get(params.id);
      if (!q || q.project !== resolve(ctx.cwd)) return { content: [{ type: "text", text: `Unknown quest ${params.id} in this project.` }] };
      if (params.action === "events") {
        const events = questStore!.events(params.id);
        return { content: [{ type: "text", text: events.map((e) => `${new Date(e.at).toISOString()} · ${e.event} · ${JSON.stringify(e.data)}`).join("\n") || "No events." }], details: { quest: q, events } };
      }
      const lastRun = questStore!.runs(params.id, 1)[0];
      const telemetry = lastRun
        ? `\n\nLast attempt: #${lastRun.attempt} · ${lastRun.outcome ?? "running"} · ${shortModelId(lastRun.model ?? "?")} · t${lastRun.turns} · ${fmtTokens(lastRun.tokens)} tok · ${fmtUsd(lastRun.costUsd)}`
        : "";
      return { content: [{ type: "text", text: `${questLine(q)}${telemetry}\n\n${q.result ?? q.error ?? q.task}` }], details: { quest: q, lastRun } };
    },
  });

  pi.registerCommand("quests", {
    description: "Show the durable quest queue and journal for this project",
    handler: async (_args, ctx) => {
      cfg = loadFairyTalesConfig(ctx.cwd);
      if (!questStore || !questRuntime) openQuestStore(ctx.cwd);
      const rows = questStore!.list(ctx.cwd);
      const s = questScheduler?.status();
      const schedLine = s
        ? `scheduler: ${s.pausedReason ? `paused (${s.pausedReason})` : s.leaseHeld ? "active" : "standby (lease held elsewhere)"} · ${s.inFlight} in flight\n`
        : cfg.scheduler?.enabled ? "scheduler: enabled (starts with the session)\n" : "";
      if (ctx.hasUI) ctx.ui.notify(schedLine + (rows.length ? rows.map(questLine).slice(0, 8).join("\n") : "No quests for this project."), "info");
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

      const ORCH = "Orchestrated — strong conductor + cheap crew, failed runs escalate (recommended)";
      const TIERED = "Tiered — pick a model per tier";
      const SESSION = "Single — always follow my session model";
      const available =
        ((await (
          ctx.modelRegistry as unknown as {
            getAvailable(): Array<{ provider: string; id: string; cost?: { input?: number; output?: number } }>;
          }
        ).getAvailable()) as Array<{ provider: string; id: string; cost?: { input?: number; output?: number } }>) ??
        [];
      const modelItems = available.map((m) => `Single — ${m.provider}/${m.id}`);

      const choice = await ctx.ui.select(`Subagent model mode (now: ${mode})`, [ORCH, TIERED, SESSION, ...modelItems]);
      if (choice === undefined) return;

      if (choice === ORCH) {
        // One pick: the conductor (your strongest model). It becomes the session
        // model, the plan/review roles, and the escalation target; scout/worker
        // tiers stay as configured (cheap crew).
        const priceOf = (m: { cost?: { input?: number; output?: number } }) => {
          const i = m.cost?.input ?? 0;
          const o = m.cost?.output ?? 0;
          return i <= 0 && o <= 0 ? "free/local" : `$${i}/$${o} per Mtok`;
        };
        const items = available.map((m) => `${m.provider}/${m.id} — ${priceOf(m)}`);
        const pick = await ctx.ui.select("Conductor model (your strongest — judgment lives here)", items);
        if (pick === undefined) return;
        const m = available[items.indexOf(pick)];
        const spec = `${m.provider}/${m.id}`;
        const path = await saveUserConfig({
          tiers: { conductor: { model: spec, thinkingLevel: "high" } },
          agents: { modelMode: "orchestrated", roles: { plan: { tier: "conductor" }, review: { tier: "conductor" } } },
        });
        cfg = loadFairyTalesConfig(ctx.cwd);
        ctx.ui.notify(`Orchestrated: conductor ${spec} · plan/review on conductor · failed runs escalate (saved to ${path}) — restart to align the session model`, "info");
        return;
      }

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

  pi.registerCommand("agent-models", {
    description: "Show the current subagent model setup: mode, tiers, per-role effective models, compaction",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const cfg = loadFairyTalesConfig(ctx.cwd);
      const sessionModel = (ctx.model as { id?: string } | undefined)?.id ?? "(session model)";
      const cheapest = resolveCheapestModel(ctx.modelRegistry);

      // Effective model for a role, mirroring the engine's resolution exactly.
      const effectiveFor = (tierName: string): { model: string; note?: string } => {
        if (cfg.agents.modelMode === "single") {
          const single = cfg.agents.singleModel;
          if (!single || single === "session") return { model: sessionModel, note: "follows session" };
          const slash = single.indexOf("/");
          const found = slash > 0 ? ctx.modelRegistry.find(single.slice(0, slash), single.slice(slash + 1)) : undefined;
          return found ? { model: single } : { model: sessionModel, note: `"${single}" unavailable → session` };
        }
        const resolved = resolveTierModel(ctx.modelRegistry, cfg, tierName);
        if (resolved) return { model: cfg.tiers[tierName].model };
        if (tierName === "scout" && cheapest) return { model: cheapest.id, note: "tier unavailable → cheapest" };
        return { model: sessionModel, note: "tier unavailable → session" };
      };

      await ctx.ui.custom(
        (
          tui: unknown,
          theme: { fg(c: string, s: string): string; bold(s: string): string },
          _kb: unknown,
          done: (v: undefined) => void,
        ) => {
          const ok = (s: string) => theme.fg("success", s);
          const warn = (s: string) => theme.fg("warning", s);
          const mut = (s: string) => theme.fg("muted", s);
          const lines: string[] = [];

          const modeLabel =
            cfg.agents.modelMode === "single"
              ? `single — ${cfg.agents.singleModel === "session" ? `follows session (${sessionModel})` : cfg.agents.singleModel}`
              : cfg.agents.modelMode === "orchestrated"
                ? "orchestrated — conductor leads, cheap crew executes, failures escalate"
                : "tiered — per-role tier models";
          lines.push(`${theme.bold("Mode".padEnd(14))} ${modeLabel}`);
          lines.push(`${theme.bold("Session model".padEnd(14))} ${sessionModel}`);
          lines.push("");

          lines.push(theme.bold("Tiers"));
          for (const [name, tier] of Object.entries(cfg.tiers ?? {})) {
            const resolved = resolveTierModel(ctx.modelRegistry, cfg, name);
            const mark = resolved ? ok("✓") : warn("✗");
            lines.push(
              `  ${mark} ${name.padEnd(8)} ${tier.model}${mut(` · thinking ${tier.thinkingLevel ?? "default"}`)}${
                resolved ? "" : warn("  (not available)")
              }`,
            );
          }
          lines.push("");

          lines.push(theme.bold("Roles → effective model"));
          for (const [role, rc] of Object.entries(cfg.agents.roles ?? {})) {
            const eff = effectiveFor(rc.tier);
            lines.push(
              `  ${role.padEnd(9)} ${mut(`[${rc.tier}]`)} ${eff.model}${eff.note ? warn(`  · ${eff.note}`) : ""}`,
            );
          }
          lines.push("");

          if (cfg.compaction?.tier) {
            const eff = effectiveFor(cfg.compaction.tier);
            lines.push(
              `${theme.bold("Compaction".padEnd(14))} tier "${cfg.compaction.tier}" → ${eff.model}${eff.note ? warn(`  · ${eff.note}`) : ""}${mut(
                ` · proactive at ${cfg.compaction.proactiveAtPercent ?? "—"}%`,
              )}`,
            );
          }
          if (cfg.agents.modelMode === "orchestrated") {
            const cond = cfg.tiers?.conductor?.model ?? "(unset)";
            lines.push(`${theme.bold("Escalation".padEnd(14))} failed runs retry once on conductor (${cond})`);
          }
          lines.push(`${theme.bold("Ultraplan".padEnd(14))} always the session model (${sessionModel})`);
          lines.push("");
          lines.push(
            mut(
              `Caps: ${cfg.agents.maxConcurrent} concurrent · ${cfg.agents.maxTurnsPerRun} turns/run · $${cfg.agents.maxCostPerRunUsd}/run  —  change models with /agent-model`,
            ),
          );

          const title = process.env.FTALES === "1" ? "❦ The Fae Council Roster ❦" : "Subagent Models";
          return bookOverlay({ title, contentLines: lines, tui, theme, done });
        },
        { overlay: true, overlayOptions: { anchor: "center", width: "80%" } },
      );
    },
  });

  pi.registerCommand("loadout", {
    description: "Named model lineups: /loadout save|use|delete <name>, or bare /loadout to pick one",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const current = loadFairyTalesConfig(ctx.cwd);
      const loadouts = current.loadouts ?? {};
      const model = ctx.model as { provider?: string; id?: string } | undefined;
      const sessionSpec = model?.provider && model?.id ? `${model.provider}/${model.id}` : undefined;
      const [verb, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const name = rest.join("-");

      const applyLoadout = async (loadoutName: string, l: Loadout) => {
        const path = await saveUserConfig(loadoutToPatch(l));
        cfg = loadFairyTalesConfig(ctx.cwd);
        // Re-align the session model to the loadout (conductor wins in orchestrated mode).
        const target = l.modelMode === "orchestrated" ? (l.tiers?.conductor?.model ?? l.sessionModel) : l.sessionModel;
        let aligned = "";
        const setModel = (ctx as unknown as { setModel?: (m: unknown) => Promise<boolean> }).setModel;
        if (target && typeof setModel === "function") {
          const slash = target.indexOf("/");
          const m = slash > 0 ? ctx.modelRegistry.find(target.slice(0, slash), target.slice(slash + 1)) : undefined;
          if (m) {
            try {
              if (await setModel.call(ctx, m)) aligned = ` · session → ${shortModelId(target.slice(slash + 1))}`;
            } catch {
              /* model switch declined */
            }
          }
        }
        ctx.ui.notify(`Loadout "${loadoutName}": ${loadoutSummary(l, shortModelId)}${aligned} (saved to ${path})`, "info");
      };

      if (verb === "save") {
        if (!name) {
          ctx.ui.notify("Usage: /loadout save <name>", "warning");
          return;
        }
        const snapshot = buildLoadoutSnapshot(current, sessionSpec);
        await saveUserConfig({ loadouts: { [name]: snapshot } });
        ctx.ui.notify(`Loadout "${name}" saved: ${loadoutSummary(snapshot, shortModelId)}`, "info");
        return;
      }
      if (verb === "delete") {
        if (!name || !loadouts[name]) {
          ctx.ui.notify(name ? `No loadout named "${name}"` : "Usage: /loadout delete <name>", "warning");
          return;
        }
        await updateUserConfig((c) => {
          const lo = (c.loadouts ?? {}) as Record<string, unknown>;
          delete lo[name];
          return { ...c, loadouts: lo };
        });
        ctx.ui.notify(`Loadout "${name}" deleted`, "info");
        return;
      }
      if (verb === "use") {
        const l = loadouts[name];
        if (!l) {
          ctx.ui.notify(name ? `No loadout named "${name}" — /loadout save ${name} first` : "Usage: /loadout use <name>", "warning");
          return;
        }
        await applyLoadout(name, l);
        return;
      }
      // Bare /loadout (or list): pick one to apply.
      const names = Object.keys(loadouts);
      if (!names.length) {
        ctx.ui.notify("No loadouts yet — save the current lineup with /loadout save <name>", "info");
        return;
      }
      const items = names.map((n) => `${n} — ${loadoutSummary(loadouts[n], shortModelId)}`);
      const choice = await ctx.ui.select("Switch to which loadout?", items);
      if (choice === undefined) return;
      const picked = names[items.indexOf(choice)];
      await applyLoadout(picked, loadouts[picked]);
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
