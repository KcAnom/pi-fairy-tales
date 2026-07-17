/**
 * fairy-tales-doctor: /doctor — one overlay that says why something's off.
 * Checks the things that silently degrade: tier models that don't resolve,
 * config parse problems, missing post-edit test command, memory not writable,
 * and the git/gh prerequisites for /ultraplan's PR path. Every failing line
 * comes with the fix.
 */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  expandHome,
  isNested,
  loadDiagnostics,
  loadFairyTalesConfig,
  resolveCheapestModel,
  resolveTierModel,
} from "../src/config.ts";
import { bookOverlay } from "../src/overlay.ts";
import { QuestStore } from "../src/quest-store.ts";

type Verdict = "ok" | "warn" | "fail";

interface Check {
  verdict: Verdict;
  label: string;
  detail?: string;
}

const MARK: Record<Verdict, string> = { ok: "✓", warn: "⚠", fail: "✗" };
const COLOR: Record<Verdict, string> = { ok: "success", warn: "warning", fail: "error" };

export default function (pi: ExtensionAPI) {
  if (isNested()) return;

  pi.registerCommand("doctor", {
    description: "Health-check this fairy-tales install: models, hooks, memory, ultraplan prerequisites",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const cfg = loadFairyTalesConfig(ctx.cwd);
      const checks: Check[] = [];

      // Config file problems (parse errors, unknown tiers, dropped guards).
      if (loadDiagnostics.length) {
        for (const d of loadDiagnostics) checks.push({ verdict: "warn", label: "Config", detail: d });
      } else {
        checks.push({ verdict: "ok", label: "Config", detail: "defaults + overrides merged cleanly" });
      }

      // Model routing: the #1 silent token cost.
      if (cfg.agents.modelMode === "single") {
        const single = cfg.agents.singleModel;
        if (!single || single === "session") {
          checks.push({
            verdict: "warn",
            label: "Subagent models",
            detail: "single/session — every subagent runs on your session model; /agent-model → Tiered saves tokens",
          });
        } else {
          const slash = single.indexOf("/");
          const found =
            slash > 0 ? ctx.modelRegistry.find(single.slice(0, slash), single.slice(slash + 1)) : undefined;
          checks.push(
            found
              ? { verdict: "ok", label: "Subagent models", detail: `single — ${single}` }
              : { verdict: "fail", label: "Subagent models", detail: `single — "${single}" not available; run /agent-model` },
          );
        }
      } else {
        for (const [name, tier] of Object.entries(cfg.tiers ?? {})) {
          const resolved = resolveTierModel(ctx.modelRegistry, cfg, name);
          if (resolved) {
            checks.push({ verdict: "ok", label: `Tier "${name}"`, detail: tier.model });
          } else if (name === "scout") {
            const cheapest = resolveCheapestModel(ctx.modelRegistry);
            checks.push({
              verdict: "warn",
              label: `Tier "${name}"`,
              detail: `"${tier.model}" not available — scout work falls back to ${cheapest ? `cheapest (${cheapest.id})` : "your session model"}; run /agent-model`,
            });
          } else {
            checks.push({
              verdict: "fail",
              label: `Tier "${name}"`,
              detail: `"${tier.model}" not available — this tier runs on your session model; run /agent-model`,
            });
          }
        }
      }

      // Compaction summarizer routing.
      const compTier = cfg.compaction?.tier;
      if (compTier) {
        const resolved = resolveTierModel(ctx.modelRegistry, cfg, compTier);
        const cheapest = resolved ? undefined : resolveCheapestModel(ctx.modelRegistry);
        checks.push(
          resolved
            ? { verdict: "ok", label: "Compaction", detail: `tier "${compTier}" · proactive at ${cfg.compaction?.proactiveAtPercent ?? "—"}%` }
            : {
                verdict: "warn",
                label: "Compaction",
                detail: `tier "${compTier}" not available — summaries run on ${cheapest ? `cheapest (${cheapest.id})` : "your session model"}`,
              },
        );
      }

      // Memory store.
      const memDir = expandHome(cfg.memory.dir);
      try {
        accessSync(memDir, constants.W_OK);
        const idx = join(memDir, "MEMORY.md");
        const size = existsSync(idx) ? statSync(idx).size : 0;
        checks.push({
          verdict: "ok",
          label: "Memory",
          detail: `${memDir} writable · index ${size} bytes${cfg.memory.injectIndex ? "" : " (injection OFF)"}`,
        });
      } catch {
        checks.push({ verdict: "fail", label: "Memory", detail: `${memDir} missing or not writable — remember/recall won't persist` });
      }

      // Durable quest queue and journal.
      try {
        const store = new QuestStore({ path: cfg.quests.path, maxHistory: cfg.quests.maxHistory });
        const health = store.health();
        store.close();
        checks.push({
          verdict: health.integrity === "ok" ? "ok" : "fail",
          label: "Quest journal",
          detail: `${health.path} · integrity ${health.integrity} · ${health.queued} queued · ${health.interrupted} interrupted${cfg.quests.autoResume ? " · auto-resume ON" : ""}`,
        });
      } catch (err) {
        checks.push({ verdict: "fail", label: "Quest journal", detail: `unavailable — ${String(err)}` });
      }

      // Post-edit test hook (opt-in per project).
      const testCmdPath = join(ctx.cwd, cfg.hooks.postEdit.testCommandFile);
      if (!cfg.hooks.postEdit.enabled) {
        checks.push({ verdict: "warn", label: "Post-edit tests", detail: "disabled in config" });
      } else if (existsSync(testCmdPath)) {
        checks.push({ verdict: "ok", label: "Post-edit tests", detail: `runs ${cfg.hooks.postEdit.testCommandFile} after edits` });
      } else {
        checks.push({
          verdict: "warn",
          label: "Post-edit tests",
          detail: `no ${cfg.hooks.postEdit.testCommandFile} in this project — create it (one line: your test command) to enable self-checking edits`,
        });
      }

      // Terminal ergonomics: copy-on-select (drag → release → clipboard) is a
      // terminal-emulator feature, not an app feature. Whether a host supports
      // it can't be probed, so inform rather than assert.
      const termProgram = process.env.TERM_PROGRAM ?? "";
      if (process.platform === "darwin" && termProgram === "Apple_Terminal") {
        checks.push({
          verdict: "ok",
          label: "Terminal",
          detail:
            "Terminal.app — for in-TUI copy-on-select, make sure View → Allow Mouse Reporting is enabled",
        });
      } else if (process.platform === "darwin" && termProgram === "iTerm.app") {
        let copyOn = true; // iTerm2's default
        try {
          const r = await pi.exec("defaults", ["read", "com.googlecode.iterm2", "CopySelection"], { timeout: 8000 });
          if (r.code === 0) copyOn = r.stdout.trim() !== "0";
        } catch {
          /* defaults unavailable — assume default */
        }
        checks.push(
          copyOn
            ? { verdict: "ok", label: "Terminal", detail: "iTerm2 — drag-select copies on release" }
            : {
                verdict: "warn",
                label: "Terminal",
                detail: "iTerm2 copy-on-select is OFF — defaults write com.googlecode.iterm2 CopySelection -bool true (then restart iTerm2)",
              },
        );
      } else if (termProgram === "vscode") {
        checks.push({
          verdict: "ok",
          label: "Terminal",
          detail: "VS Code — for drag-select auto-copy, enable terminal.integrated.copyOnSelection",
        });
      } else if (process.platform === "linux") {
        let clipTool = "";
        try {
          const r = await pi.exec("sh", ["-c", "command -v wl-copy || command -v xclip || command -v xsel"], { timeout: 8000 });
          if (r.code === 0) clipTool = r.stdout.trim().split("/").pop() ?? "";
        } catch {
          /* no shell — fall through */
        }
        checks.push(
          clipTool
            ? { verdict: "ok", label: "Clipboard", detail: `${clipTool} available for /grab` }
            : { verdict: "warn", label: "Clipboard", detail: "no wl-copy/xclip/xsel — /grab falls back to OSC 52 (terminal support varies)" },
        );
      }

      // Guard rails.
      checks.push({
        verdict: cfg.hooks.bash.length ? "ok" : "warn",
        label: "Guard rails",
        detail: `${cfg.hooks.bash.length} bash rules · ${cfg.hooks.paths.length} path rules${cfg.web.blockPrivateHosts ? " · fetch SSRF-protected" : ""}`,
      });

      // /ultraplan prerequisites: git worktrees need a repo; the PR path needs gh.
      let gitOk = false;
      try {
        const r = await pi.exec("git", ["-C", ctx.cwd, "rev-parse", "--git-dir"], { timeout: 8000 });
        gitOk = r.code === 0;
      } catch {
        /* git missing entirely */
      }
      let ghOk = false;
      try {
        const r = await pi.exec("gh", ["--version"], { timeout: 8000 });
        ghOk = r.code === 0;
      } catch {
        /* gh not installed */
      }
      checks.push(
        gitOk
          ? {
              verdict: "ok",
              label: "/ultraplan",
              detail: `git repo ✓ · gh ${ghOk ? "✓ (lands as PR)" : "✗ (lands as patch — install gh for PRs)"}`,
            }
          : { verdict: "warn", label: "/ultraplan", detail: "not a git repo here — worktree execution unavailable in this directory" },
      );

      // Spend caps at a glance.
      checks.push({
        verdict: "ok",
        label: "Spend caps",
        detail: `${cfg.agents.maxConcurrent} concurrent · ${cfg.agents.maxTurnsPerRun} turns/run · $${cfg.agents.maxCostPerRunUsd}/run`,
      });

      const fails = checks.filter((c) => c.verdict === "fail").length;
      const warns = checks.filter((c) => c.verdict === "warn").length;

      await ctx.ui.custom(
        (
          tui: unknown,
          theme: { fg(c: string, s: string): string; bold(s: string): string },
          _kb: unknown,
          done: (v: undefined) => void,
        ) => {
          const lines: string[] = [];
          for (const c of checks) {
            lines.push(
              `${theme.fg(COLOR[c.verdict], MARK[c.verdict])} ${theme.bold(c.label.padEnd(18))} ${theme.fg("muted", c.detail ?? "")}`,
            );
          }
          lines.push("");
          lines.push(
            fails
              ? theme.fg("error", `${fails} problem${fails > 1 ? "s" : ""}, ${warns} warning${warns === 1 ? "" : "s"} — fixes above`)
              : warns
                ? theme.fg("warning", `No problems, ${warns} warning${warns === 1 ? "" : "s"}`)
                : theme.fg("success", "All clear — this install is healthy"),
          );
          const title = process.env.FTALES === "1" ? "❦ The Apothecary ❦" : "Fairy-Tales Doctor";
          return bookOverlay({ title, contentLines: lines, tui, theme, done });
        },
        { overlay: true, overlayOptions: { anchor: "center", width: "80%" } },
      );
    },
  });
}
