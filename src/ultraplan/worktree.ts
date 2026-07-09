/**
 * Git worktree isolation for /ultraplan execution.
 *
 * Ported from pi-fab5-ultraplan (deepseek-free): create a throwaway worktree on
 * a fresh branch, let the build agent edit inside it, then commit and either open
 * a PR (if a remote + gh exist) or drop a patch — leaving the user's working tree
 * untouched until they choose to adopt the change.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run git in `cwd` with an explicit argument array (never a shell string). */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export interface Worktree {
  dir: string;
  branch: string;
  cleanup(): void;
}

/** `git rev-parse --show-toplevel`, or undefined if `dir` is not in a git repo. */
export function repoRootOf(dir: string): string | undefined {
  try {
    return git(dir, ["rev-parse", "--show-toplevel"]).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function createWorktree(repoRoot: string, branch: string): Worktree {
  const dir = mkdtempSync(join(tmpdir(), "fairy-worktree-"));
  git(repoRoot, ["worktree", "add", dir, "-b", branch, "HEAD"]);

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    try {
      git(repoRoot, ["worktree", "remove", "--force", dir]);
    } catch {
      // cleanup must never throw
    }
    try {
      git(repoRoot, ["branch", "-D", branch]);
    } catch {
      // branch may have been pushed/kept; ignore
    }
  };

  return { dir, branch, cleanup };
}

/** Stage and commit everything in `dir`. "Nothing to commit" is not an error. */
export function commitAll(dir: string, message: string): boolean {
  git(dir, ["add", "-A"]);
  try {
    git(dir, ["-c", "user.email=ultraplan@fairy-tales", "-c", "user.name=fairy-tales-ultraplan", "commit", "-m", message]);
    return true;
  } catch (err) {
    const out = `${(err as { stdout?: unknown }).stdout ?? ""}${(err as { stderr?: unknown }).stderr ?? ""}`;
    if (/nothing to commit|no changes added|working tree clean/i.test(out)) return false;
    throw err;
  }
}

/** Write the diff from `baseRef` to HEAD into `outFile`. Returns bytes written. */
export function formatPatch(dir: string, baseRef: string, outFile: string): number {
  const diff = git(dir, ["diff", baseRef, "HEAD"]);
  writeFileSync(outFile, diff);
  return diff.length;
}

export interface RemoteInfo {
  hasRemote: boolean;
  hasGh: boolean;
}

export function detectRemote(repoRoot: string): RemoteInfo {
  let hasRemote = false;
  let hasGh = false;
  try {
    hasRemote = git(repoRoot, ["remote"]).trim().length > 0;
  } catch {
    hasRemote = false;
  }
  try {
    execFileSync("gh", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    hasGh = true;
  } catch {
    hasGh = false;
  }
  return { hasRemote, hasGh };
}

/** Push `branch` from the worktree and open a PR. Throws on failure (caller falls back to a patch). */
export function openPr(repoRoot: string, dir: string, branch: string, title: string, body: string): string {
  git(dir, ["push", "-u", "origin", branch]);
  const out = execFileSync("gh", ["pr", "create", "--title", title, "--body", body, "--head", branch], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out.trim();
}
