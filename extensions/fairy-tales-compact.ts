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
import { isNested, loadFairyTalesConfig, resolveCheapestModel, resolveTierModel } from "../src/config.ts";
import { clipTail } from "../src/text.ts";
import { emptyAgentDir, debug } from "../src/util.ts";

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

      // Summarize on the configured cheap tier when available; if the tier does
      // not resolve, prefer the cheapest priced model over the expensive lead model.
      const cfg = loadFairyTalesConfig(ctx.cwd);
      const tierName = cfg.compaction?.tier;
      const tier =
        (tierName ? resolveTierModel(ctx.modelRegistry, cfg, tierName) : undefined) ??
        (() => {
          const cheapest = resolveCheapestModel(ctx.modelRegistry);
          return cheapest ? { model: cheapest.model, thinkingLevel: "low" } : undefined;
        })();

      const loader = new DefaultResourceLoader({
        cwd: ctx.cwd,
        agentDir: emptyAgentDir(),
        settingsManager: SettingsManager.inMemory({}),
        systemPromptOverride: () => SUMMARIZER_PROMPT,
      });
      await loader.reload();
      const { session } = await createAgentSession({
        cwd: ctx.cwd,
        model: (tier?.model ?? ctx.model) as never,
        thinkingLevel: (tier?.thinkingLevel ?? "low") as never,
        noTools: "all" as never,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(ctx.cwd),
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      });

      const onAbort = () => void session.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        // Keep the TAIL — the newest messages are the most relevant to continue from.
        await session.prompt(
          `Summarize this conversation:\n\n${clipTail(conversation, 300_000, 20_000)}${filesNote}${previous}`,
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
    } catch (err) {
      debug("compact", "custom compaction failed, falling back to default", err);
      return undefined; // pi's default compaction takes over
    }
  });

  // Proactive compaction: when context crosses the configured threshold, compact
  // with focus instructions rather than waiting for pi's automatic trigger (#18).
  let compacting = false;
  pi.on("turn_end", async (_event, ctx) => {
    if (compacting) return;
    const cfg = loadFairyTalesConfig(ctx.cwd);
    const threshold = cfg.compaction?.proactiveAtPercent;
    if (!threshold) return;
    const usage = ctx.getContextUsage();
    if (usage?.percent != null && usage.percent >= threshold) {
      compacting = true;
      try {
        await ctx.compact({ customInstructions: "Preserve the current task, recent decisions, and the next step precisely." });
      } catch (err) {
        debug("compact", "proactive compaction failed", err);
      } finally {
        compacting = false;
      }
    }
  });
}
