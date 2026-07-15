/** Cross-cutting helpers: debug channel, cached temp agent dir, token-cost estimate. */
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Debug channel. Empty catch blocks hide real failures (a permissions problem
 * on the memory dir looks identical to "no memory yet"). Route diagnostics
 * here; enabled with FAIRY_TALES_DEBUG=1, written to $TMPDIR/fairy-tales-debug.log.
 */
const DEBUG = process.env.FAIRY_TALES_DEBUG === "1";
const DEBUG_LOG = join(tmpdir(), "fairy-tales-debug.log");

export function debug(scope: string, message: string, err?: unknown): void {
  if (!DEBUG) return;
  try {
    const extra = err ? ` :: ${err instanceof Error ? err.stack ?? err.message : String(err)}` : "";
    appendFileSync(DEBUG_LOG, `[${scope}] ${message}${extra}\n`, "utf-8");
  } catch {
    // debug logging itself must never throw
  }
}

/**
 * One cached empty agent dir, shared by the subagent engine, compaction, /tale,
 * and any other ephemeral session — created once per process instead of a fresh
 * mkdtemp (and leaked dir) per call.
 */
let cachedAgentDir: string | undefined;
export function emptyAgentDir(): string {
  cachedAgentDir ??= mkdtempSync(join(tmpdir(), "fairy-tales-agent-"));
  return cachedAgentDir;
}

/**
 * Approximate USD cost from token counts when the provider reports $0
 * (subscription/flat-rate models). Cache reads charged at ~10% of input
 * (prompt-cache hits are cheap); cache writes at ~125% of input (writing to the
 * cache costs more than a regular read). Both default to 0 for backwards compat.
 */
const DEFAULT_INPUT_PER_MTOK = 3.0;
const DEFAULT_OUTPUT_PER_MTOK = 15.0;
const DEFAULT_CACHE_READ_PER_MTOK = 0.3;
const DEFAULT_CACHE_WRITE_PER_MTOK = 3.75;

export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  return (
    (inputTokens / 1_000_000) * DEFAULT_INPUT_PER_MTOK +
    (outputTokens / 1_000_000) * DEFAULT_OUTPUT_PER_MTOK +
    (cacheReadTokens / 1_000_000) * DEFAULT_CACHE_READ_PER_MTOK +
    (cacheWriteTokens / 1_000_000) * DEFAULT_CACHE_WRITE_PER_MTOK
  );
}

/**
 * Show a self-dismissing footer status. pi's ui.notify("info") prints a
 * PERSISTENT line into the conversation — wrong for "copied!" feedback.
 * A status segment set and cleared on a timer is the transient toast.
 * Consecutive flashes on the same key extend cleanly (old timer cancelled).
 */
const flashTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function flashStatus(
  ui: { setStatus(key: string, text?: string): void },
  key: string,
  text: string,
  ms = 4000,
): void {
  try {
    ui.setStatus(key, text);
  } catch {
    return; // UI gone (reload) — nothing to flash or clear
  }
  const prev = flashTimers.get(key);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    flashTimers.delete(key);
    try {
      ui.setStatus(key, undefined);
    } catch {
      // UI replaced meanwhile
    }
  }, ms);
  (timer as { unref?: () => void }).unref?.();
  flashTimers.set(key, timer);
}

/** Detect transient provider errors worth retrying (rate limits, 5xx, network). */
export function isTransientError(message: string | undefined): boolean {
  if (!message) return false;
  return /\b(429|500|502|503|504|rate.?limit|overloaded|timeout|timed out|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|network|temporarily)\b/i.test(
    message,
  );
}
