/**
 * AgentRunner: spawns and tracks nested agent sessions via the pi SDK.
 *
 * Isolation: each subagent gets a DefaultResourceLoader pointed at an EMPTY
 * agentDir with in-memory settings — no installed packages or global extensions
 * load inside subagents, so pi-fairy-tales can never recurse into itself. Guard
 * rails and the fetch tool are re-injected explicitly. Role tool allowlists
 * never include the agent tools.
 *
 * Beyond one-shot spawning it provides: a concurrency queue (overflow waits for
 * a slot instead of failing), transient-error retry with backoff, token-based
 * cost estimation when providers report $0, per-run transcript persistence, and
 * follow-up conversations with recently finished agents.
 */
import { mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { FairyTalesConfig, RoleConfig } from "../config.ts";
import { resolveCheapestModel, resolveTierModel } from "../config.ts";
import type { RunSummary } from "../bus.ts";
import { buildRolePrompt, composeTask } from "./prompts.ts";
import { clipTail, fmtDuration, fmtTokens, fmtUsd, slugify } from "../text.ts";
import { emptyAgentDir, estimateCostUsd, isTransientError, debug } from "../util.ts";

import hooksExtension from "../../extensions/fairy-tales-hooks.ts";
import webExtension from "../../extensions/fairy-tales-web.ts";

/**
 * Orchestrated-mode escalation decision: a finished cheap-tier run whose result
 * failed (provider error, the structured envelope says failed/blocked, OR the
 * run hit a limit cap — turn or cost) retries once on the conductor tier. A
 * user-initiated abort does NOT escalate (the user chose to stop). Pure so it
 * can be unit-tested.
 */
export function shouldEscalate(
  cfg: FairyTalesConfig,
  roleTier: string | undefined,
  summary: { state: string; cappedReason?: string },
  structured: unknown,
  alreadyEscalated: boolean,
): boolean {
  if (cfg.agents.modelMode !== "orchestrated" || alreadyEscalated) return false;
  if (!cfg.tiers?.conductor?.model) return false;
  if (roleTier === "conductor") return false;
  const status = (structured as { status?: string } | undefined)?.status?.toLowerCase();
  // A limit-hit abort (cappedReason set) is incomplete work — escalate it.
  if (summary.cappedReason) return true;
  return summary.state === "error" || status === "failed" || status === "blocked";
}

export interface RunResult {
  text: string;
  summary: RunSummary;
  warnings: string[];
  /** Parsed structured envelope if the subagent emitted a trailing ```json block. */
  structured?: unknown;
}

type LiveSession = {
  abort(): Promise<void>;
  dispose(): void;
  prompt(text: string, opts?: unknown): Promise<void>;
  subscribe(fn: (e: { type: string; [k: string]: unknown }) => void): () => void;
  messages: Array<{ role?: string; content?: unknown }>;
};

interface Run {
  summary: RunSummary;
  session: LiveSession;
  promise: Promise<RunResult>;
  result?: RunResult;
  /** Kept alive for follow-up (agent_control continue); disposed by LRU/shutdown. */
  live?: LiveSession;
}

export interface SpawnOptions {
  role: string;
  /** Resolve the model from this tier instead of the role's tier (escalation). */
  tierOverride?: string;
  task: string;
  context?: string;
  name?: string;
  background: boolean;
  cwd: string;
  modelRegistry: {
    find(provider: string, id: string): unknown;
    getAvailable?(): Array<{ provider: string; id: string; cost?: { input?: number; output?: number } }>;
  };
  fallbackModel: unknown;
  /** Ignore tier/single config and run on fallbackModel (the session model). Used by /ultraplan. */
  forceSessionModel?: boolean;
  signal?: AbortSignal;
  onUpdate?: (activity: string) => void;
}

const TRANSCRIPT_DIR = join(homedir(), ".pi", "agent", "fairy-tales-transcripts");
const KEEP_ALIVE = 3; // completed sessions kept for follow-up

function extractText(msg: { content?: unknown } | undefined): string {
  const content = (msg as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

/** Parse an optional trailing ```json … ``` block into a structured object. */
function parseStructured(text: string): unknown {
  const m = text.match(/```json\s*([\s\S]*?)```\s*$/i);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1].trim());
  } catch {
    return undefined;
  }
}

export class AgentRunner {
  private runs = new Map<string, Run>();
  private nextId = 1;
  private running = 0;
  private waiters: Array<() => void> = [];
  private liveOrder: string[] = []; // LRU of kept-alive session run ids

  constructor(
    private cfg: () => FairyTalesConfig,
    private onStatus: (running: RunSummary[]) => void,
    private onCost: (usd: number) => void,
  ) {}

  setConfig(cfg: () => FairyTalesConfig): void {
    this.cfg = cfg;
  }

  list(): RunSummary[] {
    return [...this.runs.values()].map((r) => r.summary);
  }
  get(id: string): Run | undefined {
    return this.runs.get(id);
  }
  runningCount(): number {
    return this.list().filter((r) => r.state === "running").length;
  }

  private async acquireSlot(max: number): Promise<void> {
    while (this.running >= Math.max(1, max)) {
      await new Promise<void>((res) => this.waiters.push(res));
    }
    this.running++;
  }
  private releaseSlot(): void {
    this.running = Math.max(0, this.running - 1);
    this.waiters.shift()?.();
  }

  async abort(id: string): Promise<boolean> {
    const run = this.runs.get(id);
    if (!run || (run.summary.state !== "running" && run.summary.state !== "queued")) return false;
    run.summary.state = "aborted";
    try {
      await run.session.abort();
    } catch {
      /* not started yet */
    }
    return true;
  }

  async abortAll(): Promise<void> {
    for (const run of this.runs.values()) {
      if (run.summary.state === "running" || run.summary.state === "queued") {
        run.summary.state = "aborted";
        try {
          await run.session.abort();
        } catch {
          /* already gone */
        }
      }
      this.disposeLive(run);
    }
    this.waiters.splice(0).forEach((w) => w());
  }

  private disposeLive(run: Run): void {
    if (run.live) {
      try {
        run.live.dispose();
      } catch {
        /* already disposed */
      }
      run.live = undefined;
    }
  }

  private emitStatus(): void {
    try {
      this.onStatus(this.list());
    } catch {
      /* status sinks must never break runs */
    }
  }

  spawn(opts: SpawnOptions): { id: string; promise: Promise<RunResult> } {
    const cfg = this.cfg();
    const role: RoleConfig | undefined = cfg.agents.roles[opts.role];
    if (!role) {
      throw new Error(`Unknown agent role "${opts.role}". Available: ${Object.keys(cfg.agents.roles).join(", ")}`);
    }
    // Overflow queues rather than fails, but a huge backlog still errors.
    const queued = this.list().filter((r) => r.state === "queued").length;
    if (queued >= cfg.agents.maxConcurrent * 4) {
      throw new Error(`Agent queue is full (${queued} waiting). Let some finish before spawning more.`);
    }

    const id = `a${this.nextId++}`;
    const warnings: string[] = [];
    // /ultraplan pins subagents to the session model; everything else honors tier/single config.
    const resolved = opts.forceSessionModel
      ? { model: opts.fallbackModel, thinkingLevel: cfg.tiers?.[role.tier]?.thinkingLevel }
      : this.resolveModel(role, opts, cfg, warnings);
    const model = (resolved?.model ?? opts.fallbackModel) as { id?: string } | undefined;

    const summary: RunSummary = {
      id,
      name: opts.name ?? `${opts.role}-${id}`,
      role: opts.role,
      model: model?.id ?? "?",
      turns: 0,
      costUsd: 0,
      startedAt: Date.now(),
      lastActivity: this.running >= cfg.agents.maxConcurrent ? "queued" : "starting",
      background: opts.background,
      state: "queued",
      tier: opts.forceSessionModel
        ? "session"
        : (opts.tierOverride ?? (cfg.agents.modelMode === "single" ? "session" : role.tier)),
    };

    const placeholder: Run = {
      summary,
      session: { abort: async () => {}, dispose: () => {}, prompt: async () => {}, subscribe: () => () => {}, messages: [] },
      promise: undefined as never,
    };
    this.runs.set(id, placeholder);
    this.emitStatus();

    const promise = this.execute(id, placeholder, role, resolved, opts, cfg, warnings);
    placeholder.promise = promise;
    return { id, promise };
  }

  private resolveModel(
    role: RoleConfig,
    opts: SpawnOptions,
    cfg: FairyTalesConfig,
    warnings: string[],
  ): { model: unknown; thinkingLevel: string | undefined } | undefined {
    const tierName = opts.tierOverride ?? role.tier;
    if (cfg.agents.modelMode === "single" && !opts.tierOverride) {
      const tierThinking = cfg.tiers?.[tierName]?.thinkingLevel;
      const single = cfg.agents.singleModel;
      if (!single || single === "session") return { model: opts.fallbackModel, thinkingLevel: tierThinking };
      const slash = single.indexOf("/");
      const found = slash > 0 ? opts.modelRegistry.find(single.slice(0, slash), single.slice(slash + 1)) : undefined;
      if (found) return { model: found, thinkingLevel: tierThinking };
      warnings.push(`Single model "${single}" not found — ran on the lead session's model. Fix with /agent-model.`);
      return undefined;
    }
    const resolved = resolveTierModel(opts.modelRegistry, cfg, tierName);
    if (!resolved) {
      // Scout work is high-volume/low-stakes: falling back to the expensive
      // session model is the worst outcome, so try the cheapest priced model first.
      if (tierName === "scout") {
        const cheapest = resolveCheapestModel(opts.modelRegistry);
        if (cheapest) {
          warnings.push(
            `Tier "scout" model unavailable — ran on cheapest available model ${cheapest.id}. Set it with /agent-model.`,
          );
          return { model: cheapest.model, thinkingLevel: cfg.tiers?.[tierName]?.thinkingLevel };
        }
      }
      warnings.push(`Tier "${tierName}" model unavailable — ran on the lead session's model. Fix with /agent-model.`);
    }
    return resolved;
  }

  private async bootSession(
    role: RoleConfig,
    resolved: { model: unknown; thinkingLevel: string | undefined } | undefined,
    opts: SpawnOptions,
  ): Promise<{ session: LiveSession; fallbackMessage?: string }> {
    const loader = new DefaultResourceLoader({
      cwd: opts.cwd,
      agentDir: emptyAgentDir(),
      settingsManager: SettingsManager.inMemory({}),
      systemPromptOverride: () => buildRolePrompt(opts.role, role),
      extensionFactories: [hooksExtension, webExtension],
    });
    const g = globalThis as Record<string, unknown>;
    g.__fairyTalesDepth = ((g.__fairyTalesDepth as number | undefined) ?? 0) + 1;
    try {
      await loader.reload();
      const created = await createAgentSession({
        cwd: opts.cwd,
        model: (resolved?.model ?? opts.fallbackModel) as never,
        thinkingLevel: (resolved?.thinkingLevel ?? "medium") as never,
        tools: role.tools as never,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(opts.cwd),
        settingsManager: SettingsManager.inMemory({}),
      });
      return { session: created.session as unknown as LiveSession, fallbackMessage: created.modelFallbackMessage };
    } finally {
      g.__fairyTalesDepth = Math.max(0, ((g.__fairyTalesDepth as number | undefined) ?? 1) - 1);
    }
  }

  private saveTranscript(summary: RunSummary, session: LiveSession): void {
    try {
      mkdirSync(TRANSCRIPT_DIR, { recursive: true });
      const file = join(TRANSCRIPT_DIR, `${summary.startedAt}-${slugify(summary.name)}-${summary.id}.json`);
      writeFileSync(file, JSON.stringify({ summary, messages: session.messages }, null, 2), "utf-8");
      summary.transcriptPath = file;
      // Prune old transcripts (keep newest 50).
      const files = readdirSync(TRANSCRIPT_DIR).filter((f) => f.endsWith(".json")).sort();
      for (const old of files.slice(0, Math.max(0, files.length - 50))) {
        rmSync(join(TRANSCRIPT_DIR, old), { force: true });
      }
    } catch (err) {
      debug("engine", "failed to save transcript", err);
    }
  }

  private async execute(
    id: string,
    run: Run,
    role: RoleConfig,
    resolved: { model: unknown; thinkingLevel: string | undefined } | undefined,
    opts: SpawnOptions,
    cfg: FairyTalesConfig,
    warnings: string[],
  ): Promise<RunResult> {
    const summary = run.summary;
    await this.acquireSlot(cfg.agents.maxConcurrent);
    if (summary.state === "aborted") {
      this.releaseSlot();
      return { text: "(aborted before start)", summary, warnings };
    }
    summary.state = "running";
    summary.lastActivity = "starting";
    this.emitStatus();

    let session: LiveSession;
    try {
      const booted = await this.bootSession(role, resolved, opts);
      session = booted.session;
      if (booted.fallbackMessage) warnings.push(booted.fallbackMessage);
    } catch (err) {
      summary.state = "error";
      this.releaseSlot();
      this.emitStatus();
      throw new Error(`Subagent ${summary.name} failed to start: ${String(err)}`);
    }
    run.session = session;
    this.emitStatus();

    const accum = { tokens: 0, inTok: 0, outTok: 0 };
    const tracker = this.attachTracker(session, summary, cfg, opts.onUpdate, accum);
    const unsubscribe = tracker.unsubscribe;

    const onAbort = () => {
      if (summary.state === "running") {
        summary.state = "aborted";
        void session.abort();
      }
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      // Prompt with transient-error retry.
      const maxRetries = 2;
      for (let attempt = 0; ; attempt++) {
        await session.prompt(composeTask(opts.task, opts.context));
        const err = this.lastAssistantError(session);
        if (err && isTransientError(err) && attempt < maxRetries && summary.state === "running") {
          warnings.push(`Transient error (attempt ${attempt + 1}), retrying: ${err.slice(0, 120)}`);
          // Show the backoff in the widget — a silent 30s retry reads as a hang.
          const backoffMs = 800 * (attempt + 1);
          summary.lastActivity = `⟳ provider hiccup — retry ${attempt + 1}/${maxRetries} in ${Math.round(backoffMs / 1000) || 1}s`;
          this.emitStatus();
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        break;
      }

      const capped = tracker.getCapped();
      const assistant = [...session.messages]
        .reverse()
        .find((m) => m.role === "assistant") as { errorMessage?: string; content?: unknown } | undefined;
      let text = extractText(assistant).trim();
      if (assistant?.errorMessage && (capped || summary.state === "aborted")) {
        text = text || "(run aborted)";
      } else if (assistant?.errorMessage) {
        summary.state = "error";
        text = `${text ? `${text}\n\n` : ""}Provider error in subagent (model ${summary.model}): ${assistant.errorMessage}`;
        warnings.push("The subagent's model call failed — consider a different tier model in fairy-tales config.");
      } else if (!text) {
        text = "(subagent produced no final text)";
      }
      if (capped) warnings.push(`Run stopped early: ${capped}. The result below may be incomplete.`);
      if (summary.state === "running") summary.state = "done";

      const structured = parseStructured(text);
      const elapsed = Date.now() - summary.startedAt;
      summary.tokens = accum.tokens || accum.inTok + accum.outTok;
      const stats = `[${summary.role} · ${summary.model} · ${summary.turns} turns · ${fmtTokens(summary.tokens)} tok · ${fmtUsd(summary.costUsd)} · ${fmtDuration(elapsed)}]`;
      const result: RunResult = {
        text: `${warnings.map((w) => `⚠ ${w}\n`).join("")}${clipTail(text)}\n\n${stats}`,
        summary,
        warnings,
        structured,
      };
      run.result = result;
      this.saveTranscript(summary, session);
      return result;
    } catch (err) {
      summary.state = "error";
      throw new Error(`Subagent ${summary.name} failed: ${String(err)}`);
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      this.releaseSlot();
      // Keep the session alive for follow-up if it completed cleanly; else dispose.
      if (summary.state === "done") {
        run.live = session;
        this.liveOrder.push(id);
        while (this.liveOrder.length > KEEP_ALIVE) {
          const evict = this.liveOrder.shift()!;
          const r = this.runs.get(evict);
          if (r) this.disposeLive(r);
        }
      } else {
        try {
          session.dispose();
        } catch {
          /* already disposed */
        }
      }
      summary.lastActivity = "finished";
      this.emitStatus();
      // Prune old finished run records (keep newest 20).
      if (this.runs.size > 20) {
        for (const [key, r] of this.runs) {
          if (this.runs.size <= 20) break;
          if (r.summary.state !== "running" && r.summary.state !== "queued" && !r.live) this.runs.delete(key);
        }
      }
    }
  }

  /**
   * Subscribe to a live session to track turns, tokens, cost (with the per-run
   * cost cap), and activity. Shared by execute() and continue() so a follow-up
   * conversation gets the SAME caps and cost attribution as the original run —
   * previously continue() ran uncapped and uncosted.
   */
  private attachTracker(
    session: LiveSession,
    summary: RunSummary,
    cfg: FairyTalesConfig,
    onUpdate: ((activity: string) => void) | undefined,
    accum: { tokens: number; inTok: number; outTok: number },
  ): { unsubscribe: () => void; getCapped: () => string | undefined } {
    let capped: string | undefined;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "turn_start") {
        summary.turns += 1;
        if (summary.turns > cfg.agents.maxTurnsPerRun) {
          capped = `turn cap (${cfg.agents.maxTurnsPerRun}) reached`;
          summary.cappedReason = capped;
          summary.state = "aborted";
          void session.abort();
        }
        this.emitStatus();
      } else if (event.type === "message_end") {
        const msg = event.message as
          | {
              role?: string;
              usage?: {
                cost?: { total?: number; cacheRead?: number; cacheWrite?: number };
                totalTokens?: number;
                input?: number;
                output?: number;
                cacheRead?: number;
                cacheWrite?: number;
              };
            }
          | undefined;
        if (msg?.role === "assistant" && msg.usage) {
          const reported = msg.usage.cost?.total ?? 0;
          accum.inTok += msg.usage.input ?? 0;
          accum.outTok += msg.usage.output ?? 0;
          accum.tokens += msg.usage.totalTokens ?? 0;
          const cost =
            reported > 0
              ? reported
              : estimateCostUsd(
                  msg.usage.input ?? 0,
                  msg.usage.output ?? 0,
                  msg.usage.cacheRead ?? msg.usage.cost?.cacheRead ?? 0,
                  msg.usage.cacheWrite ?? msg.usage.cost?.cacheWrite ?? 0,
                );
          summary.costUsd += cost;
          if (cost > 0) this.onCost(cost);
          if (summary.costUsd > cfg.agents.maxCostPerRunUsd) {
            capped = `cost cap (${fmtUsd(cfg.agents.maxCostPerRunUsd)}) reached`;
            summary.cappedReason = capped;
            summary.state = "aborted";
            void session.abort();
          }
          this.emitStatus();
        }
      } else if (event.type === "tool_execution_start") {
        const tool = event.toolName as string;
        const input = event.args ?? event.input;
        const detail = tool === "bash" ? String((input as { command?: string } | undefined)?.command ?? "").slice(0, 60) : "";
        summary.lastActivity = detail ? `${tool}: ${detail}` : tool;
        onUpdate?.(summary.lastActivity);
        this.emitStatus();
      }
    });
    return { unsubscribe, getCapped: () => capped };
  }

  private lastAssistantError(session: LiveSession): string | undefined {
    const a = [...session.messages].reverse().find((m) => m.role === "assistant") as
      | { errorMessage?: string }
      | undefined;
    return a?.errorMessage;
  }

  /** Continue a conversation with a recently finished agent (follow-up). */
  async continue(id: string, task: string, signal?: AbortSignal): Promise<RunResult | undefined> {
    const run = this.runs.get(id);
    if (!run) return undefined;
    if (!run.live) {
      return {
        text: `Agent ${id} is no longer live (only the ${KEEP_ALIVE} most recent finished agents can be continued). Spawn a fresh agent with the needed context.`,
        summary: run.summary,
        warnings: [],
      };
    }
    const session = run.live;
    const cfg = this.cfg();
    const summary = run.summary;
    const accum = { tokens: 0, inTok: 0, outTok: 0 };
    // Follow-ups get the SAME caps and cost attribution as the original run —
    // turn-cap and cost-cap continue from where the first run left off, and new
    // spend is reported through onCost so the ledger and footer stay accurate.
    const tracker = this.attachTracker(session, summary, cfg, undefined, accum);
    const onAbort = () => void session.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const g = globalThis as Record<string, unknown>;
    g.__fairyTalesDepth = ((g.__fairyTalesDepth as number | undefined) ?? 0) + 1;
    try {
      summary.state = "running";
      this.emitStatus();
      await session.prompt(task);
      const capped = tracker.getCapped();
      const assistant = [...session.messages].reverse().find((m) => m.role === "assistant") as
        | { errorMessage?: string; content?: unknown }
        | undefined;
      let text = extractText(assistant).trim();
      const warnings: string[] = [];
      if (assistant?.errorMessage && !(capped || summary.state === "aborted")) {
        summary.state = "error";
        text = `${text ? `${text}\n\n` : ""}Provider error in continued agent (model ${summary.model}): ${assistant.errorMessage}`;
        warnings.push("The continued agent's model call failed.");
      } else if (assistant?.errorMessage) {
        text = text || "(run aborted)";
      } else if (!text) {
        text = "(no reply)";
      }
      if (capped) warnings.push(`Run stopped early: ${capped}. The result below may be incomplete.`);
      if (summary.state === "running") summary.state = "done";
      summary.tokens = (summary.tokens ?? 0) + (accum.tokens || accum.inTok + accum.outTok);
      const result: RunResult = { text: clipTail(text), summary, warnings, structured: parseStructured(text) };
      run.result = result;
      this.emitStatus();
      return result;
    } finally {
      tracker.unsubscribe();
      g.__fairyTalesDepth = Math.max(0, ((g.__fairyTalesDepth as number | undefined) ?? 1) - 1);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
