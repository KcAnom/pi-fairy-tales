/**
 * fairy-tales-hooks: guard rails + post-edit test runner.
 *
 * - tool_call: bash commands checked against config regex rules (block/confirm),
 *   write/edit paths checked against glob rules. Confirm degrades to block when
 *   there is no UI (fail-safe).
 * - plan mode enforcement: while fairy-tales-plan broadcasts active=true, mutating
 *   bash commands and edit/write are blocked at the hook layer (second line of
 *   defense behind tool deactivation).
 * - post-edit hook: after a turn that touched files, runs the project's
 *   `.pi/test-command` (if present) and steers failures back to the agent.
 *
 * Rules stay active inside fairy-tales subagents — guard rails apply everywhere.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { loadFairyTalesConfig, type FairyTalesConfig } from "../src/config.ts";
import { checkBashCommand, checkPath, isMutatingBash } from "../src/rules.ts";
import { PLAN_CHANGED, type PlanChangedPayload } from "../src/bus.ts";
import { clipTail } from "../src/text.ts";

const FILE_TOOLS = ["write", "edit"] as const;

export default function (pi: ExtensionAPI) {
  let cfg: FairyTalesConfig | undefined;
  let planActive = false;
  let touchedFiles = new Set<string>();
  let testRunning = false;

  pi.events.on(PLAN_CHANGED, (data: PlanChangedPayload) => {
    planActive = !!data?.active;
  });

  pi.on("session_start", async (_event, ctx) => {
    cfg = loadFairyTalesConfig(ctx.cwd);
  });

  pi.on("tool_call", async (event, ctx) => {
    cfg ??= loadFairyTalesConfig(ctx.cwd);

    if (isToolCallEventType("bash", event)) {
      const command = event.input.command ?? "";

      if (planActive && isMutatingBash(command)) {
        return {
          block: true,
          reason: "Plan mode is active: bash commands that modify files or state are blocked. Present your plan with exit_plan first.",
        };
      }

      const verdict = checkBashCommand(cfg.hooks.bash, command);
      if (verdict) {
        if (verdict.action === "block") {
          return { block: true, reason: `Blocked by fairy-tales rule: ${verdict.reason}` };
        }
        // confirm — fail-safe to block when headless
        if (!ctx.hasUI) {
          return { block: true, reason: `Blocked (needs confirmation, no UI): ${verdict.reason}` };
        }
        const ok = await ctx.ui.confirm("Fairy-Tales guard", `${verdict.reason}\n\n${command}\n\nAllow?`);
        if (!ok) return { block: true, reason: `User denied: ${verdict.reason}` };
      }
      return;
    }

    const isFileTool = (FILE_TOOLS as readonly string[]).includes(event.toolName);
    if (isFileTool) {
      if (planActive) {
        return { block: true, reason: "Plan mode is active: file modifications are blocked. Present your plan with exit_plan first." };
      }
      const path = (event.input as { path?: string }).path;
      if (path) {
        const abs = resolve(ctx.cwd, path);
        const verdict = checkPath(cfg.hooks.paths, abs);
        if (verdict) {
          if (verdict.action === "block" || !ctx.hasUI) {
            return { block: true, reason: `Blocked by fairy-tales path rule: ${verdict.reason} (${abs})` };
          }
          const ok = await ctx.ui.confirm("Fairy-Tales guard", `${verdict.reason}\n\n${abs}\n\nAllow?`);
          if (!ok) return { block: true, reason: `User denied: ${verdict.reason}` };
        }
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    // Track successfully modified files for the post-edit test hook.
    if (!event.isError && (FILE_TOOLS as readonly string[]).includes(event.toolName)) {
      const path = (event.input as { path?: string }).path;
      if (path) touchedFiles.add(resolve(ctx.cwd, path));
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    cfg ??= loadFairyTalesConfig(ctx.cwd);
    if (!cfg.hooks.postEdit.enabled || touchedFiles.size === 0 || testRunning) return;

    const cmdFile = join(ctx.cwd, cfg.hooks.postEdit.testCommandFile);
    if (!existsSync(cmdFile)) {
      touchedFiles.clear();
      return;
    }
    const testCmd = readFileSync(cmdFile, "utf-8").trim();
    if (!testCmd) {
      touchedFiles.clear();
      return;
    }

    const files = [...touchedFiles];
    touchedFiles = new Set();
    testRunning = true;

    if (ctx.hasUI) ctx.ui.setStatus("fairy-tales-tests", "⏳ tests");

    // Run detached so a slow test suite never stalls the agent loop; failures
    // are steered back into the conversation for the model to fix.
    void (async () => {
      try {
        const result = await pi.exec("sh", ["-c", testCmd], {
          timeout: cfg!.hooks.postEdit.timeoutMs ?? 120000,
        });
        if (result.code !== 0) {
          const output = clipTail(`${result.stdout}\n${result.stderr}`.trim(), 16384, 400);
          pi.sendMessage(
            {
              customType: "fairy-tales-hook",
              content:
                `Post-edit test hook failed (exit ${result.code}) after editing: ${files.join(", ")}\n` +
                `Command: ${testCmd}\n\n${output}\n\nFix the failures.`,
              display: true,
            },
            { deliverAs: "steer", triggerTurn: true },
          );
        } else if (ctx.hasUI) {
          ctx.ui.notify(`✓ post-edit tests passed (${testCmd})`, "info");
        }
      } catch (err) {
        if (ctx.hasUI) ctx.ui.notify(`post-edit test hook error: ${String(err)}`, "error");
      } finally {
        testRunning = false;
        if (ctx.hasUI) ctx.ui.setStatus("fairy-tales-tests", undefined);
      }
    })();
  });
}
