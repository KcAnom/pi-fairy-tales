/**
 * fairy-tales-compact: structured compaction summaries.
 * Replaces pi's default compaction summary with a Fairy-Tales-style structured
 * handoff (request/intent, decisions, files, done, pending, next step),
 * produced by a one-shot toolless agent session on the current model.
 * Any failure returns undefined so pi's default compaction takes over.
 */
import {
  convertToLlm,
  serializeConversation,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNested } from "../src/config.ts";
import { clipHead } from "../src/text.ts";

const SUMMARIZER_PROMPT = `You are a conversation summarizer for a coding agent. You receive a serialized conversation and produce a handoff summary so the agent can continue seamlessly with the older messages removed.

Write EXACTLY these markdown sections:
## Request & Intent
What the user asked for, including refinements. Preserve their key phrasing.
## Key Decisions & Constraints
Decisions made, approaches chosen and rejected, user-imposed constraints.
## Files & State
Files created/modified/read that matter, with paths. Current state of the work.
## What Was Done
Completed work, verified outcomes.
## Pending & Next Step
Unfinished work and the single concrete next step.

Rules: be specific (paths, names, commands, error messages). No fluff. If a previous summary is provided, merge its still-relevant facts. Output ONLY the summary sections.`;

export default function (pi: ExtensionAPI) {
  if (isNested()) return;

  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, signal } = event;
    try {
      const conversation = serializeConversation(convertToLlm(preparation.messagesToSummarize));
      if (!conversation?.trim()) return undefined;

      const fileOps = (preparation.fileOps ?? []) as Array<{ path?: string; operation?: string }>;
      const filesNote = fileOps.length
        ? `\n\n[File operations observed]: ${fileOps
            .map((f) => `${f.operation ?? "?"} ${f.path ?? "?"}`)
            .slice(0, 60)
            .join("; ")}`
        : "";
      const previous = preparation.previousSummary
        ? `\n\n[Previous summary to merge]:\n${preparation.previousSummary}`
        : "";

      const loader = new DefaultResourceLoader({
        cwd: ctx.cwd,
        agentDir: mkdtempSync(join(tmpdir(), "pi-fairy-tales-compact-")),
        settingsManager: SettingsManager.inMemory({}),
        systemPromptOverride: () => SUMMARIZER_PROMPT,
      });
      await loader.reload();
      const { session } = await createAgentSession({
        cwd: ctx.cwd,
        model: ctx.model as never,
        thinkingLevel: "low" as never,
        noTools: "all" as never,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(ctx.cwd),
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      });

      const onAbort = () => void session.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await session.prompt(
          `Summarize this conversation:\n\n${clipHead(conversation, 300_000, 20_000)}${filesNote}${previous}`,
        );
        const assistant = [...session.messages]
          .reverse()
          .find((m: { role?: string }) => m.role === "assistant") as
          | { errorMessage?: string; content?: Array<{ type?: string; text?: string }> }
          | undefined;
        if (assistant?.errorMessage) return undefined;
        const summary = (assistant?.content ?? [])
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (!summary) return undefined;
        return {
          compaction: {
            summary,
            firstKeptEntryId: preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
            details: { fairyTales: true },
          },
        };
      } finally {
        signal?.removeEventListener("abort", onAbort);
        session.dispose();
      }
    } catch {
      return undefined; // pi's default compaction takes over
    }
  });
}
