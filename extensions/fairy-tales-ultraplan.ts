/**
 * fairy-tales-ultraplan: `/ultraplan <task>` — the heavy-planning workflow.
 *
 * Flow: background a read-only planning agent (terminal stays free) → structured
 * plan → approval gate (Approve & Execute / Approve / View / Reject) → on execute,
 * a build agent implements the plan inside an ISOLATED git worktree, self-repairing
 * against `.pi/test-command`, ending in a PR or a patch. The user's working tree is
 * never touched until they adopt the result.
 *
 * Everything runs on the CURRENT SESSION MODEL (forceSessionModel) regardless of the
 * tiered/single subagent config — ultraplan is model-agnostic by construction.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { loadFairyTalesConfig, expandHome, isNested, type FairyTalesConfig } from "../src/config.ts";
import { AgentRunner } from "../src/subagent/engine.ts";
import { COST_ADD, type RunSummary } from "../src/bus.ts";
import { slugify } from "../src/text.ts";
import { bookOverlay } from "../src/overlay.ts";
import { debug } from "../src/util.ts";
import { createWorktree, commitAll, formatPatch, detectRemote, openPr, repoRootOf, type Worktree } from "../src/ultraplan/worktree.ts";

interface PlanDoc {
  title: string;
  markdown: string;
}

const DEFAULTS = { planners: 1, worktree: true, autoExecute: false, planRole: "plan", buildRole: "build" };

export default function (pi: ExtensionAPI) {
  if (isNested()) return; // never inside subagents

  let cfg: FairyTalesConfig | undefined;
  let sessionModel: unknown;
  let active = false;

  const runner = new AgentRunner(
    () => cfg ?? loadFairyTalesConfig(process.cwd()),
    (running) => updateWidget(running),
    (usd) => pi.events.emit(COST_ADD, { usd }),
  );

  let uiRef: {
    hasUI: boolean;
    ui: { setStatus(k: string, t?: string): void; setWidget(k: string, l?: string[], o?: { placement?: string }): void };
  } | undefined;

  const updateWidget = (running: RunSummary[]) => {
    if (!uiRef?.hasUI) return;
    try {
      const active = running.filter((r) => r.state === "running");
      const lines = active.map((r) => ` ◆ ${r.name} · ${r.lastActivity} · t${r.turns}`);
      uiRef.ui.setWidget("fairy-tales-ultraplan", lines.length ? lines : undefined, { placement: "aboveEditor" });
    } catch {
      /* stale ui after reload */
    }
  };

  const setStage = (text?: string) => {
    if (uiRef?.hasUI) uiRef.ui.setStatus("fairy-tales-ultraplan-stage", text);
  };

  pi.on("session_start", async (_event, ctx) => {
    cfg = loadFairyTalesConfig(ctx.cwd);
    uiRef = ctx;
    sessionModel = (ctx as { model?: unknown }).model;
  });

  pi.on("model_select", async (event) => {
    const m = (event as { model?: unknown }).model;
    if (m) sessionModel = m;
  });

  pi.on("session_shutdown", async () => {
    await runner.abortAll();
  });

  pi.registerCommand("ultraplan", {
    description: "Heavy planner → approval gate → isolated worktree execution, on your session model",
    handler: async (args, ctx) => {
      const task = (typeof args === "string" ? args : "").trim();
      if (!task) return ctx.ui.notify("Usage: /ultraplan <task to plan and execute>", "info");
      if (active) return ctx.ui.notify("An ultraplan run is already in progress.", "info");
      if (!ctx.hasUI) return ctx.ui.notify("/ultraplan needs an interactive session for the approval gate.", "info");

      cfg = loadFairyTalesConfig(ctx.cwd);
      const up = { ...DEFAULTS, ...(cfg.ultraplan ?? {}) };
      const model = sessionModel ?? (ctx as { model?: unknown }).model;
      const registry = ctx.modelRegistry;
      if (!model) return ctx.ui.notify("No session model yet — send a message first, then run /ultraplan.", "info");

      active = true;
      setStage(`◆ ultraplan: planning (${up.planners > 1 ? `${up.planners} planners` : "1 planner"})…`);
      ctx.ui.notify(`ultraplan: planning "${task.slice(0, 60)}"… (terminal stays free)`, "info");

      // Detached: the command returns immediately so the terminal is free while planning runs.
      makePlan(task, up, model, registry, ctx.cwd)
        .then((plan) => (plan ? gate(ctx, task, plan, up, model, registry) : ctx.ui.notify("ultraplan: planning produced no plan.", "warning")))
        .catch((err) => {
          debug("ultraplan", "run failed", err);
          if (ctx.hasUI) ctx.ui.notify(`ultraplan failed: ${String(err)}`, "error");
        })
        .finally(() => {
          active = false;
          setStage(undefined);
        });
    },
  });

  // --- planning -----------------------------------------------------------

  const PLAN_INSTRUCTIONS = `Do NOT write or modify any files — this is planning only. Investigate the codebase (read-only) as needed, then output a complete implementation plan as markdown: a one-line title, a short summary, numbered concrete steps (each saying what to change and where), and a "Risks" section. End your reply with a fenced json block: \`\`\`json\n{"title": "<short title>", "summary": "<one sentence>"}\n\`\`\``;

  async function makePlan(task: string, up: typeof DEFAULTS, model: unknown, registry: unknown, cwd: string): Promise<PlanDoc | undefined> {
    const spawnPlanner = (name: string) =>
      runner.spawn({
        role: up.planRole,
        task: `Produce an implementation plan for this task.\n\nTASK:\n${task}\n\n${PLAN_INSTRUCTIONS}`,
        name,
        background: false,
        cwd,
        modelRegistry: registry as { find(p: string, i: string): unknown },
        fallbackModel: model,
        forceSessionModel: true,
      }).promise;

    if (up.planners <= 1) {
      const res = await spawnPlanner("ultraplan-planner");
      return toPlanDoc(res.text, res.structured, task);
    }

    // Ensemble: N independent planners → one synthesis pass merges them.
    const drafts = await Promise.all(Array.from({ length: Math.min(4, up.planners) }, (_, i) => spawnPlanner(`ultraplan-planner-${i + 1}`)));
    setStage("◆ ultraplan: synthesizing plans…");
    const candidates = drafts.map((d, i) => `--- CANDIDATE ${i + 1} ---\n${d.text}`).join("\n\n");
    const synth = await runner.spawn({
      role: up.planRole,
      task: `You are given ${drafts.length} candidate implementation plans for the same task. Merge them into ONE superior plan — take the best ideas, resolve conflicts, drop the weak parts.\n\nTASK:\n${task}\n\n${candidates}\n\n${PLAN_INSTRUCTIONS}`,
      name: "ultraplan-synthesis",
      background: false,
      cwd,
      modelRegistry: registry as { find(p: string, i: string): unknown },
      fallbackModel: model,
      forceSessionModel: true,
    }).promise;
    return toPlanDoc(synth.text, synth.structured, task);
  }

  function toPlanDoc(text: string, structured: unknown, task: string): PlanDoc {
    const title = (structured as { title?: string } | undefined)?.title?.trim() || text.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").slice(0, 80) || task.slice(0, 60);
    return { title, markdown: text.trim() };
  }

  // --- approval gate ------------------------------------------------------

  async function gate(
    ctx: { hasUI: boolean; cwd: string; ui: any; modelRegistry: unknown },
    task: string,
    plan: PlanDoc,
    up: typeof DEFAULTS,
    model: unknown,
    registry: unknown,
  ): Promise<void> {
    if (up.autoExecute) {
      savePlan(ctx.cwd, plan);
      return execute(ctx, plan, up, model, registry);
    }

    const APPROVE_EXEC = "Approve & Execute";
    const APPROVE_SAVE = "Approve (save plan only)";
    const VIEW = "View full plan";
    const REJECT = "Reject & discard";

    setStage("◆ ultraplan: awaiting your approval");
    // Loop so "View" returns to the menu.
    for (;;) {
      const choice = await ctx.ui.select(`Plan ready — ${plan.title}`, [APPROVE_EXEC, APPROVE_SAVE, VIEW, REJECT]);
      if (choice === VIEW) {
        await showPlan(ctx, plan);
        continue;
      }
      if (choice === undefined || choice === REJECT) {
        ctx.ui.notify("ultraplan: plan discarded. Refine your task and run /ultraplan again.", "info");
        return;
      }
      const file = savePlan(ctx.cwd, plan);
      if (choice === APPROVE_SAVE) {
        ctx.ui.notify(`ultraplan: plan saved to ${file}`, "info");
        return;
      }
      // APPROVE_EXEC
      return execute(ctx, plan, up, model, registry);
    }
  }

  async function showPlan(ctx: { ui: any }, plan: PlanDoc): Promise<void> {
    await ctx.ui.custom(
      (tui: unknown, theme: { fg(c: string, s: string): string; bold(s: string): string }, _kb: unknown, done: (v: undefined) => void) => {
        const contentLines = plan.markdown.split("\n").map((l) => theme.fg("text", l));
        const title = process.env.FTALES === "1" ? `❦ ${plan.title} ❦` : plan.title;
        return bookOverlay({ title, contentLines, tui, theme, done, branded: process.env.FTALES === "1" });
      },
    );
  }

  function savePlan(cwd: string, plan: PlanDoc): string {
    const c = cfg ?? loadFairyTalesConfig(cwd);
    const plansDir = expandHome(c.plans.dir);
    const date = new Date().toISOString().slice(0, 10);
    const file = join(plansDir, `${date}-ultraplan-${slugify(plan.title)}.md`);
    // Fire-and-forget through the mutation queue; the path is returned immediately for the notify.
    void withFileMutationQueue(file, async () => {
      mkdirSync(plansDir, { recursive: true });
      await writeFile(file, plan.markdown, "utf-8");
    });
    return file;
  }

  // --- execution (isolated worktree) --------------------------------------

  async function execute(
    ctx: { hasUI: boolean; cwd: string; ui: any },
    plan: PlanDoc,
    up: typeof DEFAULTS,
    model: unknown,
    registry: unknown,
  ): Promise<void> {
    const repoRoot = repoRootOf(ctx.cwd);
    const useWorktree = up.worktree && !!repoRoot;
    let wt: Worktree | undefined;
    let execDir = ctx.cwd;
    let baseSha = "HEAD";

    setStage("◆ ultraplan: executing…");
    try {
      if (useWorktree && repoRoot) {
        const branch = `ultraplan/exec-${Date.now()}`;
        wt = createWorktree(repoRoot, branch);
        execDir = wt.dir;
        baseSha = gitHead(wt.dir);
        ctx.ui.notify(`ultraplan: building in isolated worktree (branch ${branch})…`, "info");
      } else if (up.worktree) {
        ctx.ui.notify("ultraplan: not a git repo — building directly in the working tree.", "warning");
      }

      const buildTask =
        `Implement the following approved plan exactly. Make the real file changes and verify your work. ` +
        `If a test command is configured it runs automatically after your edits — fix any failures it reports.\n\nPLAN:\n${plan.markdown}`;

      const res = await runner.spawn({
        role: up.buildRole,
        task: buildTask,
        name: "ultraplan-builder",
        background: false,
        cwd: execDir,
        modelRegistry: registry as { find(p: string, i: string): unknown },
        fallbackModel: model,
        forceSessionModel: true,
      }).promise;

      if (!useWorktree || !wt || !repoRoot) {
        ctx.ui.notify(`ultraplan: done — changes applied to your working tree. Review with \`git diff\`. ${res.summary.turns} turns.`, "info");
        return;
      }

      const committed = commitAll(wt.dir, `ultraplan: ${plan.title}`);
      if (!committed) {
        ctx.ui.notify("ultraplan: the build agent produced no file changes. Nothing to commit.", "warning");
        return;
      }

      const remote = detectRemote(repoRoot);
      let outcome: string;
      if (remote.hasRemote && remote.hasGh) {
        try {
          const url = openPr(repoRoot, wt.dir, wt.branch, `ultraplan: ${plan.title}`, plan.markdown);
          outcome = `PR opened → ${url}`;
        } catch (err) {
          debug("ultraplan", "PR failed, falling back to patch", err);
          const patch = join(repoRoot, `${slugify(plan.title)}.patch`);
          formatPatch(wt.dir, baseSha, patch);
          outcome = `PR push failed; patch written → ${patch}`;
        }
      } else {
        const patch = join(repoRoot, `${slugify(plan.title)}.patch`);
        formatPatch(wt.dir, baseSha, patch);
        outcome = `patch written → ${patch} (apply with \`git apply\`)`;
      }
      ctx.ui.notify(`ultraplan: execution complete — ${outcome}`, "info");
    } finally {
      wt?.cleanup();
      setStage(undefined);
    }
  }

  function gitHead(dir: string): string {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    } catch {
      return "HEAD";
    }
  }
}
