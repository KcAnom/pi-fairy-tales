/**
 * AgentRunner: spawns and tracks nested agent sessions via the pi SDK.
 *
 * Isolation: each subagent gets a DefaultResourceLoader pointed at an EMPTY
 * agentDir with in-memory settings — no installed packages or global
 * extensions load inside subagents, so pi-fairy-tales can never recurse into
 * itself. Guard rails and the fetch tool are re-injected explicitly via
 * extensionFactories. Role tool allowlists never include the agent tools.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { FairyTalesConfig, RoleConfig } from "../config.ts";
import { resolveTierModel } from "../config.ts";
import type { RunSummary } from "../bus.ts";
import { buildRolePrompt, composeTask } from "./prompts.ts";
import { clipTail, fmtDuration, fmtTokens, fmtUsd } from "../text.ts";

import hooksExtension from "../../extensions/fairy-tales-hooks.ts";
import webExtension from "../../extensions/fairy-tales-web.ts";

export interface RunResult {
  text: string;
  summary: RunSummary;
  warnings: string[];
}

interface Run {
  summary: RunSummary;
  session: { abort(): Promise<void>; dispose(): void };
  promise: Promise<RunResult>;
  result?: RunResult;
}

export interface SpawnOptions {
  role: string;
  task: string;
  context?: string;
  name?: string;
  background: boolean;
  cwd: string;
  modelRegistry: { find(provider: string, id: string): unknown };
  fallbackModel: unknown;
  signal?: AbortSignal;
  onUpdate?: (activity: string) => void;
}

let emptyAgentDir: string | undefined;
function getEmptyAgentDir(): string {
  emptyAgentDir ??= mkdtempSync(join(tmpdir(), "pi-fairy-tales-subagent-"));
  return emptyAgentDir;
}

function extractText(msg: { content?: unknown } | undefined): string {
  const content = (msg as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

export class AgentRunner {
  private runs = new Map<string, Run>();
  private nextId = 1;

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

  async abort(id: string): Promise<boolean> {
    const run = this.runs.get(id);
    if (!run || run.summary.state !== "running") return false;
    run.summary.state = "aborted";
    await run.session.abort();
    return true;
  }

  async abortAll(): Promise<void> {
    for (const run of this.runs.values()) {
      if (run.summary.state === "running") {
        run.summary.state = "aborted";
        try {
          await run.session.abort();
        } catch {
          // already gone
        }
      }
    }
  }

  private emitStatus(): void {
    try {
      this.onStatus(this.list());
    } catch {
      // status sinks must never break runs
    }
  }

  spawn(opts: SpawnOptions): { id: string; promise: Promise<RunResult> } {
    const cfg = this.cfg();
    const role: RoleConfig | undefined = cfg.agents.roles[opts.role];
    if (!role) {
      throw new Error(`Unknown agent role "${opts.role}". Available: ${Object.keys(cfg.agents.roles).join(", ")}`);
    }
    if (this.runningCount() >= cfg.agents.maxConcurrent) {
      throw new Error(
        `Too many concurrent agents (max ${cfg.agents.maxConcurrent}). Wait for a running agent to finish or abort one with agent_control.`,
      );
    }

    const id = `a${this.nextId++}`;
    const warnings: string[] = [];
    const resolved = resolveTierModel(opts.modelRegistry, cfg, role.tier);
    if (!resolved) {
      warnings.push(
        `Tier "${role.tier}" model unavailable — subagent ran on the lead session's model instead. Check tiers in fairy-tales config.`,
      );
    }
    const model = (resolved?.model ?? opts.fallbackModel) as { id?: string } | undefined;

    const summary: RunSummary = {
      id,
      name: opts.name ?? `${opts.role}-${id}`,
      role: opts.role,
      model: model?.id ?? "?",
      turns: 0,
      costUsd: 0,
      startedAt: Date.now(),
      lastActivity: "starting",
      background: opts.background,
      state: "running",
    };

    // Register synchronously so parallel sibling spawns see this run when
    // checking maxConcurrent, and so list/abort work while the session boots.
    const placeholder: Run = {
      summary,
      session: { abort: async () => {}, dispose: () => {} },
      promise: undefined as never,
    };
    this.runs.set(id, placeholder);
    this.emitStatus();

    const promise = this.execute(id, placeholder, role, resolved, opts, cfg, warnings);
    placeholder.promise = promise;
    return { id, promise };
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
    const loader = new DefaultResourceLoader({
      cwd: opts.cwd,
      agentDir: getEmptyAgentDir(),
      settingsManager: SettingsManager.inMemory({}),
      systemPromptOverride: () => buildRolePrompt(opts.role, role),
      extensionFactories: [hooksExtension, webExtension],
    });
    const g = globalThis as Record<string, unknown>;
    g.__fairyTalesDepth = ((g.__fairyTalesDepth as number | undefined) ?? 0) + 1;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
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
      session = created.session;
      if (created.modelFallbackMessage) warnings.push(created.modelFallbackMessage);
    } finally {
      g.__fairyTalesDepth = Math.max(0, ((g.__fairyTalesDepth as number | undefined) ?? 1) - 1);
    }

    if (summary.state !== "running") {
      // aborted while the session was booting
      session.dispose();
      return { text: "(aborted before start)", summary, warnings };
    }
    run.session = session;
    this.emitStatus();

    let capped: string | undefined;
    let tokens = 0;

    const unsubscribe = session.subscribe((event: { type: string; [k: string]: unknown }) => {
      if (event.type === "turn_start") {
        summary.turns += 1;
        if (summary.turns > cfg.agents.maxTurnsPerRun) {
          capped = `turn cap (${cfg.agents.maxTurnsPerRun}) reached`;
          summary.state = "aborted";
          void session.abort();
        }
        this.emitStatus();
      } else if (event.type === "message_end") {
        const msg = event.message as
          | { role?: string; usage?: { cost?: { total?: number }; totalTokens?: number } }
          | undefined;
        if (msg?.role === "assistant") {
          const cost = msg.usage?.cost?.total ?? 0;
          summary.costUsd += cost;
          tokens += msg.usage?.totalTokens ?? 0;
          if (cost > 0) this.onCost(cost);
          if (summary.costUsd > cfg.agents.maxCostPerRunUsd) {
            capped = `cost cap (${fmtUsd(cfg.agents.maxCostPerRunUsd)}) reached`;
            summary.state = "aborted";
            void session.abort();
          }
          this.emitStatus();
        }
      } else if (event.type === "tool_execution_start") {
        const tool = event.toolName as string;
        const input = event.args ?? event.input;
        const detail =
          tool === "bash" ? String((input as { command?: string } | undefined)?.command ?? "").slice(0, 60) : "";
        summary.lastActivity = detail ? `${tool}: ${detail}` : tool;
        opts.onUpdate?.(summary.lastActivity);
        this.emitStatus();
      }
    });

    const onAbort = () => {
      if (summary.state === "running") {
        summary.state = "aborted";
        void session.abort();
      }
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await session.prompt(composeTask(opts.task, opts.context));

      const assistant = [...session.messages]
        .reverse()
        .find((m: { role?: string }) => m.role === "assistant") as
        | { errorMessage?: string; stopReason?: string; content?: unknown }
        | undefined;
      let text = extractText(assistant).trim();
      if (assistant?.errorMessage && (capped || summary.state === "aborted")) {
        // The abort we triggered surfaces as a provider error — the cap/abort warning already covers it.
        text = text || "(run aborted)";
      } else if (assistant?.errorMessage) {
        summary.state = "error";
        text = `${text ? `${text}\n\n` : ""}Provider error in subagent (model ${summary.model}): ${assistant.errorMessage}`;
        warnings.push("The subagent's model call failed — consider a different tier model in fairy-tales config.");
      } else if (!text) {
        text = "(subagent produced no final text)";
      }
      if (capped) {
        warnings.push(`Run stopped early: ${capped}. The result below may be incomplete.`);
      }
      if (summary.state === "running") summary.state = "done";

      const elapsed = Date.now() - summary.startedAt;
      const stats = `[${summary.role} · ${summary.model} · ${summary.turns} turns · ${fmtTokens(tokens)} tok · ${fmtUsd(summary.costUsd)} · ${fmtDuration(elapsed)}]`;
      const result: RunResult = {
        text: `${warnings.map((w) => `⚠ ${w}\n`).join("")}${clipTail(text)}\n\n${stats}`,
        summary,
        warnings,
      };
      const run2 = this.runs.get(id);
      if (run2) run2.result = result;
      return result;
    } catch (err) {
      summary.state = "error";
      throw new Error(`Subagent ${summary.name} failed: ${String(err)}`);
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      try {
        session.dispose();
      } catch {
        // already disposed
      }
      summary.lastActivity = "finished";
      this.emitStatus();
      // Keep finished runs listed for agent_control result/list; prune old ones.
      if (this.runs.size > 20) {
        for (const [key, r] of this.runs) {
          if (r.summary.state !== "running" && this.runs.size > 20) this.runs.delete(key);
        }
      }
    }
  }
}
