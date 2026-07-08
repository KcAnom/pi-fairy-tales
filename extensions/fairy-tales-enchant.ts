/**
 * fairy-tales-enchant: the exclusive ftales-only experience layer.
 * Active only when launched via `ftales` (FTALES=1). Provides:
 *   - The Enchanted Footer: realm (git branch) · gold (session cost) ·
 *     ink (context remaining) · sprites (running subagents)
 *   - /tale: the session retold as a storybook chapter in an overlay
 *   - A brief sparkle title screen on startup
 *   - Sessions auto-named like book chapters ("The Tale of …")
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
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNested } from "../src/config.ts";
import { AGENTS_STATUS, COST_ADD, type AgentsStatusPayload, type CostAddPayload } from "../src/bus.ts";
import { clipHead, fmtUsd } from "../src/text.ts";

const NARRATOR_PROMPT = `You are the Narrator of a storybook about a software developer's work. You receive a serialized coding-agent conversation and retell it as a short fairy-tale chapter.

Rules:
- 150-300 words, markdown, starting with "Once upon a terminal,".
- The developer is the hero; bugs/errors are creatures or curses; subagents are helpful sprites; tests are trials; commits seal the chapter.
- Weave in the REAL specifics (file names, commands, what actually happened) so it doubles as a true recap.
- End with "And so the tale continues…" if work is unfinished, or "…and they merged happily ever after." if it is done.
Output ONLY the chapter.`;

export default function (pi: ExtensionAPI) {
  if (process.env.FTALES !== "1" || isNested()) return;

  // ---- shared live data for the footer ----
  let modelName = "";
  let inkPct: number | undefined;
  let goldUsd = 0;
  let sprites = 0;
  let requestRender: (() => void) | undefined;

  pi.events.on(COST_ADD, (d: CostAddPayload) => {
    goldUsd += d?.usd ?? 0;
    requestRender?.();
  });
  pi.events.on(AGENTS_STATUS, (d: AgentsStatusPayload) => {
    sprites = (d?.running ?? []).filter((r) => r.state === "running").length;
    requestRender?.();
  });

  pi.on("model_select", async (event) => {
    modelName = (event.model as { id?: string } | undefined)?.id ?? "";
    requestRender?.();
  });

  pi.on("message_end", async (event) => {
    const msg = event.message as { role?: string; usage?: { cost?: { total?: number } } };
    if (msg.role === "assistant" && msg.usage?.cost?.total) {
      goldUsd += msg.usage.cost.total;
      requestRender?.();
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    const usage = ctx.getContextUsage();
    if (usage?.percent !== null && usage?.percent !== undefined) {
      inkPct = Math.max(0, 100 - Math.round(usage.percent));
      requestRender?.();
    }
    // Name the session like a book chapter after the first exchange.
    try {
      if (!pi.getSessionName()) {
        for (const entry of ctx.sessionManager.getBranch()) {
          if (entry.type !== "message") continue;
          const msg = (entry as { message?: { role?: string; content?: Array<{ type?: string; text?: string }> } }).message;
          if (msg?.role === "user") {
            const text = (msg.content ?? []).find((b) => b?.type === "text")?.text ?? "";
            const gist = text.replace(/\s+/g, " ").trim().slice(0, 44);
            if (gist) pi.setSessionName(`The Tale of "${gist}${text.length > 44 ? "…" : ""}"`);
            break;
          }
        }
      }
    } catch {
      // naming is cosmetic
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    modelName = (ctx.model as { id?: string } | undefined)?.id ?? "";

    // ---- The Enchanted Footer ----
    try {
      ctx.ui.setFooter(
        (
          tui: { requestRender(): void },
          theme: { fg(c: string, s: string): string },
          footerData: {
            getGitBranch(): string | null;
            getExtensionStatuses(): ReadonlyMap<string, string>;
            onBranchChange(cb: () => void): () => void;
          },
        ) => {
          requestRender = () => tui.requestRender();
          return {
            invalidate() {},
            render(width: number): string[] {
              try {
              const parts: string[] = [];
              if (modelName) parts.push(theme.fg("accent", `✦ ${modelName}`));
              const branch = footerData.getGitBranch();
              if (branch) parts.push(theme.fg("muted", `⚘ realm: ${branch}`));
              if (inkPct !== undefined) {
                parts.push(theme.fg(inkPct < 20 ? "warning" : "muted", `✒ ink ${inkPct}%`));
              }
              parts.push(theme.fg("muted", `🜚 ${fmtUsd(goldUsd)} gold`));
              if (sprites > 0) parts.push(theme.fg("accent", `✧ ${sprites} sprite${sprites > 1 ? "s" : ""} at work`));
              for (const [key, text] of footerData.getExtensionStatuses()) {
                if (key === "fairy-tales") continue; // our footer already shows these vitals
                parts.push(text);
              }
              const line = " " + parts.join(theme.fg("dim", "  ·  "));
              return wrapTextWithAnsi(line, width).slice(0, 2);
              } catch {
                return [" ✦ Fairy Tales"];
              }
            },
            dispose:
              typeof footerData?.onBranchChange === "function"
                ? footerData.onBranchChange(() => tui.requestRender())
                : undefined,
          };
        },
      );
    } catch {
      // default footer stays
    }

    // ---- Title screen (brief, auto-dismissing) ----
    try {
      void ctx.ui.custom(
        (
          _tui: unknown,
          theme: { fg(c: string, s: string): string; bold(s: string): string },
          _keybindings: unknown,
          done: (v: undefined) => void,
        ) => {
          const timer = setTimeout(() => done(undefined), 1800);
          return {
            render(width: number): string[] {
              const center = (s: string, len: number) =>
                " ".repeat(Math.max(0, Math.floor((width - len) / 2))) + s;
              const dust = "· ✦ · ✧ · ⋆ · ✧ · ✦ ·";
              const title = "F A I R Y   T A L E S";
              return [
                "",
                center(theme.fg("dim", dust), dust.length),
                "",
                center(theme.fg("accent", theme.bold(title)), title.length),
                center(theme.fg("muted", "~ once upon a terminal ~"), 24),
                "",
                center(theme.fg("dim", dust), dust.length),
                "",
              ];
            },
            invalidate() {},
            handleInput(data: string) {
              clearTimeout(timer);
              done(undefined);
              void data;
            },
          };
        },
        { overlay: true, overlayOptions: { anchor: "center", width: "60%" } },
      );
    } catch {
      // overlay unsupported (RPC) — skip
    }
  });

  // ---- /tale: the storybook recap ----
  pi.registerCommand("tale", {
    description: "Retell this session as a storybook chapter",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const messages: unknown[] = [];
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "message") messages.push((entry as { message?: unknown }).message);
      }
      if (messages.length < 2) {
        ctx.ui.notify("This tale has not begun yet — say something first.", "info");
        return;
      }
      ctx.ui.setStatus("fairy-tales-tale", "✒ the narrator writes…");
      try {
        const conversation = serializeConversation(convertToLlm(messages as never));
        const loader = new DefaultResourceLoader({
          cwd: ctx.cwd,
          agentDir: mkdtempSync(join(tmpdir(), "pi-ft-tale-")),
          settingsManager: SettingsManager.inMemory({}),
          systemPromptOverride: () => NARRATOR_PROMPT,
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
        try {
          await session.prompt(`Retell this conversation as a chapter:\n\n${clipHead(conversation, 200_000, 15_000)}`);
          const assistant = [...session.messages]
            .reverse()
            .find((m: { role?: string }) => m.role === "assistant") as
            | { content?: Array<{ type?: string; text?: string }> }
            | undefined;
          const tale = (assistant?.content ?? [])
            .filter((b) => b?.type === "text" && b.text)
            .map((b) => b.text)
            .join("\n")
            .trim();
          if (!tale) {
            ctx.ui.notify("The narrator lost the thread — try again.", "warning");
            return;
          }
          await ctx.ui.custom(
            (
              _tui: unknown,
              theme: { fg(c: string, s: string): string; bold(s: string): string },
              _kb: unknown,
              done: (v: undefined) => void,
            ) => ({
              render(width: number): string[] {
                const inner = Math.max(20, width - 4);
                const lines = wrapTextWithAnsi(theme.fg("text", tale), inner).map((l: string) => `  ${l}`);
                const rule = theme.fg("dim", "· ✦ ".repeat(Math.max(1, Math.floor(inner / 4))));
                return [
                  "",
                  `  ${theme.fg("accent", theme.bold("❦ The Tale So Far ❦"))}`,
                  `  ${rule}`,
                  "",
                  ...lines,
                  "",
                  `  ${rule}`,
                  `  ${theme.fg("dim", "press any key to close the book")}`,
                  "",
                ];
              },
              invalidate() {},
              handleInput(data: string) {
                if (data) done(undefined);
              },
            }),
            { overlay: true, overlayOptions: { anchor: "center", width: "80%" } },
          );
        } finally {
          session.dispose();
        }
      } catch (err) {
        ctx.ui.notify(`The narrator stumbled: ${String(err)}`, "error");
      } finally {
        ctx.ui.setStatus("fairy-tales-tale", undefined);
      }
    },
  });
}
