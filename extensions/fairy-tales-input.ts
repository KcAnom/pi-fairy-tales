/**
 * fairy-tales-input: input quick-modes (#21).
 *
 * Recognizes leading shortcuts on the raw input line before the agent sees it:
 *   ??<question>  → "ask mode": answer concisely, read-only, no file edits this turn.
 *   >><text>      → verbatim: send the text as-is (skips slash/template handling),
 *                   useful when the message literally starts with "/" or "#".
 * Everything else passes through untouched.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isNested } from "../src/config.ts";

const ASK_DIRECTIVE =
  "\n\n[Ask mode: answer this concisely from what you can read. Do NOT modify files, run mutating commands, or delegate build work this turn.]";

export default function (pi: ExtensionAPI) {
  if (isNested()) return;

  let askThisTurn = false;

  pi.on("input", async (event) => {
    const e = event as { text?: string; source?: string };
    const text = e.text ?? "";
    if (text.startsWith("??")) {
      askThisTurn = true;
      return { action: "transform", text: text.slice(2).trimStart() };
    }
    if (text.startsWith(">>")) {
      return { action: "transform", text: text.slice(2).trimStart() };
    }
    return { action: "continue" };
  });

  // Apply the ask-mode directive for exactly one turn.
  pi.on("before_agent_start", async (event) => {
    if (isNested() || !askThisTurn) return;
    askThisTurn = false;
    return { systemPrompt: (event as { systemPrompt: string }).systemPrompt + ASK_DIRECTIVE };
  });
}
