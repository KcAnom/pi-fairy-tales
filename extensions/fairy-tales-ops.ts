/**
 * fairy-tales-ops: robustness plumbing.
 * - message_end: normalize provider-specific context-overflow errors into pi's
 *   standard signal so auto-compaction + retry engage instead of a hard failure (#34).
 * - session_before_switch / session_before_fork: warn before /new, /fork, /clone
 *   discards context while a plan is active or the repo is dirty (#35).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isNested } from "../src/config.ts";
import { debug } from "../src/util.ts";

const OVERFLOW_PATTERNS =
  /(context.{0,20}(length|window|limit)|maximum context|too many tokens|token.{0,10}limit|input is too long|reduce the length|prompt is too long)/i;

export default function (pi: ExtensionAPI) {
  if (isNested()) return;

  let planActive = false;
  pi.events.on("fairy-tales:plan:changed", (d: { active?: boolean }) => {
    planActive = !!d?.active;
  });

  pi.on("message_end", async (event) => {
    const msg = event.message as { role?: string; errorMessage?: string } | undefined;
    if (msg?.role === "assistant" && msg.errorMessage && OVERFLOW_PATTERNS.test(msg.errorMessage)) {
      debug("ops", `normalizing overflow error: ${msg.errorMessage.slice(0, 80)}`);
      // Rewrite to the canonical phrase pi recognizes for overflow-triggered compaction.
      return { message: { ...msg, errorMessage: `context_length_exceeded: ${msg.errorMessage}` } };
    }
  });

  const guard = async (
    ctx: { hasUI: boolean; cwd: string; ui: { confirm(t: string, m: string): Promise<boolean> } },
    action: string,
  ): Promise<{ cancel: true } | undefined> => {
    if (!ctx.hasUI) return undefined;
    const reasons: string[] = [];
    if (planActive) reasons.push("plan mode is active (your plan hasn't been saved)");
    try {
      const r = await pi.exec("git", ["-C", ctx.cwd, "status", "--porcelain"], { timeout: 8000 });
      if (r.code === 0 && r.stdout.trim()) reasons.push("the working tree has uncommitted changes");
    } catch {
      /* not a git repo — ignore */
    }
    if (!reasons.length) return undefined;
    const ok = await ctx.ui.confirm(`${action}?`, `Heads up: ${reasons.join(" and ")}. Continue with ${action}?`);
    return ok ? undefined : { cancel: true };
  };

  pi.on("session_before_switch", async (_event, ctx) => guard(ctx, "switch session"));
  pi.on("session_before_fork", async (_event, ctx) => guard(ctx, "fork session"));
}
