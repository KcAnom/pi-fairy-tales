/** Formatting + truncation helpers shared by fairy-tales extensions. */
import { truncateTail, truncateHead } from "@earendil-works/pi-coding-agent";

export function fmtUsd(usd: number): string {
  return usd >= 10 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${(s % 60).toString().padStart(2, "0")}s`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}

/** Keep the END of long text (conclusions live there). */
export function clipTail(text: string, maxBytes = 51200, maxLines = 2000): string {
  const t = truncateTail(text, { maxBytes, maxLines });
  return t.truncated ? `[...truncated, showing tail]\n${t.content}` : t.content;
}

/** Keep the START of long text (page content, logs). */
export function clipHead(text: string, maxBytes = 51200, maxLines = 2000): string {
  const t = truncateHead(text, { maxBytes, maxLines });
  return t.truncated ? `${t.content}\n[...truncated at ${maxBytes} bytes]` : t.content;
}

export function slugify(text: string, maxLen = 40): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, maxLen) || "untitled"
  );
}
