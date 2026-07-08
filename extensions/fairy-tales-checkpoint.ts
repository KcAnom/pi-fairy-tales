/**
 * fairy-tales-checkpoint: a try-verify-rollback safety net (#20).
 *
 * In a git repo, snapshots the working tree after any turn that edited files —
 * using `git stash create`, which builds a dangling commit object WITHOUT
 * touching the index, stash list, or working tree (completely non-destructive).
 * `/rollback` restores the tree to a chosen checkpoint (with confirmation);
 * `/checkpoints` lists them. Together with the post-edit test hook this gives a
 * "if the change broke something, return to the last good state" loop.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isNested } from "../src/config.ts";
import { fmtDuration } from "../src/text.ts";
import { debug } from "../src/util.ts";

interface Checkpoint {
  sha: string;
  at: number;
  label: string;
}

export default function (pi: ExtensionAPI) {
  if (isNested()) return;

  let isGitRepo = false;
  let touched = false;
  const checkpoints: Checkpoint[] = [];

  const git = async (ctx: { cwd: string }, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    return pi.exec("git", ["-C", ctx.cwd, ...args], { timeout: 15000 });
  };

  pi.on("session_start", async (_event, ctx) => {
    const r = await git(ctx, ["rev-parse", "--is-inside-work-tree"]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    isGitRepo = r.code === 0 && r.stdout.trim() === "true";
  });

  pi.on("tool_result", async (event) => {
    if (!event.isError && (event.toolName === "write" || event.toolName === "edit")) touched = true;
    if (!event.isError && event.toolName === "bash") touched = true; // bash may write too
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!isGitRepo || !touched) return;
    touched = false;
    try {
      const created = await git(ctx, ["stash", "create", "fairy-tales checkpoint"]);
      const sha = created.stdout.trim();
      if (created.code === 0 && sha) {
        checkpoints.push({ sha, at: Date.now(), label: `after turn ${checkpoints.length + 1}` });
        if (checkpoints.length > 20) checkpoints.shift();
      }
    } catch (err) {
      debug("checkpoint", "stash create failed", err);
    }
  });

  pi.registerCommand("checkpoints", {
    description: "List working-tree checkpoints saved this session",
    handler: async (_args, ctx) => {
      if (!isGitRepo) return ctx.ui.notify("Not a git repository — checkpoints are disabled here.", "info");
      if (!checkpoints.length) return ctx.ui.notify("No checkpoints yet (they're created after file edits).", "info");
      const lines = checkpoints
        .slice()
        .reverse()
        .map((c) => `${c.sha.slice(0, 8)} · ${c.label} · ${fmtDuration(Date.now() - c.at)} ago`);
      ctx.ui.notify(`Checkpoints:\n${lines.join("\n")}`, "info");
    },
  });

  pi.registerCommand("rollback", {
    description: "Restore the working tree to a saved checkpoint",
    handler: async (_args, ctx) => {
      if (!isGitRepo) return ctx.ui.notify("Not a git repository — nothing to roll back.", "info");
      if (!checkpoints.length) return ctx.ui.notify("No checkpoints to roll back to.", "info");
      const items = checkpoints
        .slice()
        .reverse()
        .map((c) => `${c.sha.slice(0, 8)} · ${c.label} · ${fmtDuration(Date.now() - c.at)} ago`);
      const choice = await ctx.ui.select("Roll back the working tree to which checkpoint?", items);
      if (choice === undefined) return;
      const cp = checkpoints.slice().reverse()[items.indexOf(choice)];
      if (!cp) return;
      const ok = await ctx.ui.confirm(
        "Roll back?",
        `This overwrites current working-tree files with checkpoint ${cp.sha.slice(0, 8)}. Uncommitted changes since then will be lost. Continue?`,
      );
      if (!ok) return;
      // Snapshot the current state first so the rollback itself is reversible.
      const safety = await git(ctx, ["stash", "create", "pre-rollback safety"]);
      const res = await git(ctx, ["checkout", cp.sha, "--", "."]);
      if (res.code === 0) {
        const safetySha = safety.stdout.trim();
        ctx.ui.notify(
          `Rolled back to ${cp.sha.slice(0, 8)}.` + (safetySha ? ` Prior state saved as ${safetySha.slice(0, 8)} (git checkout to recover).` : ""),
          "info",
        );
      } else {
        ctx.ui.notify(`Rollback failed: ${res.stderr.trim() || res.stdout.trim()}`, "error");
      }
    },
  });
}
