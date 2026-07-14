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
import { wrapTextWithAnsi, Text } from "@earendil-works/pi-tui";
import { isNested, loadFairyTalesConfig, resolveCheapestModel, resolveTierModel } from "../src/config.ts";
import { renderMasthead, closeOverlay } from "../src/banner.ts";
import { bookOverlay } from "../src/overlay.ts";
import { AGENTS_STATUS, COST_ADD, type AgentsStatusPayload, type CostAddPayload } from "../src/bus.ts";
import { clipTail, fmtUsd } from "../src/text.ts";
import { emptyAgentDir, estimateCostUsd } from "../src/util.ts";

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
  let pendingRender = false;

  // Buffer render requests that arrive before the footer mounts, then flush —
  // otherwise early cost/agent/model updates are silently dropped (#24).
  const scheduleRender = () => {
    if (requestRender) requestRender();
    else pendingRender = true;
  };

  pi.events.on(COST_ADD, (d: CostAddPayload) => {
    goldUsd += d?.usd ?? 0;
    scheduleRender();
  });
  pi.events.on(AGENTS_STATUS, (d: AgentsStatusPayload) => {
    sprites = (d?.running ?? []).filter((r) => r.state === "running").length;
    scheduleRender();
  });

  pi.on("model_select", async (event) => {
    modelName = (event.model as { id?: string } | undefined)?.id ?? "";
    scheduleRender();
  });

  pi.on("message_end", async (event) => {
    const msg = event.message as {
      role?: string;
      usage?: { cost?: { total?: number }; input?: number; output?: number };
    };
    if (msg.role === "assistant" && msg.usage) {
      const reported = msg.usage.cost?.total ?? 0;
      goldUsd += reported > 0 ? reported : estimateCostUsd(msg.usage.input ?? 0, msg.usage.output ?? 0);
      scheduleRender();
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    const usage = ctx.getContextUsage();
    if (usage?.percent !== null && usage?.percent !== undefined) {
      inkPct = Math.max(0, 100 - Math.round(usage.percent));
      scheduleRender();
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
          if (pendingRender) {
            pendingRender = false;
            tui.requestRender();
          }
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
          tui: unknown,
          theme: { fg(c: string, s: string): string; bold(s: string): string },
          _keybindings: unknown,
          done: (v: undefined) => void,
        ) => {
          const timer = setTimeout(() => closeOverlay(tui, done), 1800);
          return {
            render(width: number): string[] {
              return ["", ...renderMasthead(theme, width), ""];
            },
            invalidate() {},
            handleInput(data: string) {
              clearTimeout(timer);
              closeOverlay(tui, done);
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

  // ---- /tale: the storybook recap (cached, cheap-tier, cost-attributed) ----
  let taleCache: { count: number; text: string } | undefined;

  const showTale = async (
    ctx: { hasUI: boolean; ui: { custom(f: unknown, o: unknown): Promise<unknown> } },
    tale: string,
  ) => {
    await ctx.ui.custom(
      (
        tui: unknown,
        theme: { fg(c: string, s: string): string; bold(s: string): string },
        _kb: unknown,
        done: (v: undefined) => void,
      ) => {
        const width = process.stdout.columns || 80;
        const inner = Math.max(20, Math.floor(width * 0.8) - 4);
        const contentLines = wrapTextWithAnsi(theme.fg("text", tale), inner);
        return bookOverlay({ title: "❦ The Tale So Far ❦", contentLines, tui, theme, done });
      },
      { overlay: true, overlayOptions: { anchor: "center", width: "80%" } },
    );
  };

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
      // Serve the cached tale if the conversation hasn't grown.
      if (taleCache && taleCache.count === messages.length) {
        await showTale(ctx, taleCache.text);
        return;
      }
      ctx.ui.setStatus("fairy-tales-tale", "✒ the narrator writes…");
      try {
        const conversation = serializeConversation(convertToLlm(messages as never));
        const cfg = loadFairyTalesConfig(ctx.cwd);
        const tier =
          (cfg.compaction?.tier ? resolveTierModel(ctx.modelRegistry, cfg, cfg.compaction.tier) : undefined) ??
          (() => {
            const cheapest = resolveCheapestModel(ctx.modelRegistry);
            return cheapest ? { model: cheapest.model, thinkingLevel: "low" } : undefined;
          })();
        const loader = new DefaultResourceLoader({
          cwd: ctx.cwd,
          agentDir: emptyAgentDir(),
          settingsManager: SettingsManager.inMemory({}),
          systemPromptOverride: () => NARRATOR_PROMPT,
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
        // Attribute the narrator's cost to the gold ledger.
        let taleCost = 0;
        const unsub = (session as unknown as { subscribe(fn: (e: { type: string; [k: string]: unknown }) => void): () => void }).subscribe(
          (e) => {
            if (e.type === "message_end") {
              const u = (e.message as { role?: string; usage?: { cost?: { total?: number }; input?: number; output?: number } })?.usage;
              const role = (e.message as { role?: string })?.role;
              if (role === "assistant" && u) {
                taleCost += (u.cost?.total ?? 0) || estimateCostUsd(u.input ?? 0, u.output ?? 0);
              }
            }
          },
        );
        try {
          await session.prompt(`Retell this conversation as a chapter:\n\n${clipTail(conversation, 200_000, 15_000)}`);
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
          taleCache = { count: messages.length, text: tale };
          if (taleCost > 0) pi.events.emit(COST_ADD, { usd: taleCost });
          await showTale(ctx, tale);
        } finally {
          unsub();
          session.dispose();
        }
      } catch (err) {
        ctx.ui.notify(`The narrator stumbled: ${String(err)}`, "error");
      } finally {
        ctx.ui.setStatus("fairy-tales-tale", undefined);
      }
    },
  });

  // ---- Message renderer cards (#27): agent results & hook messages render as
  // titled cards instead of plain text.
  pi.registerMessageRenderer("fairy-tales-agent-result", (message: { content?: string }, _opts: unknown, theme: { fg(c: string, s: string): string; bold(s: string): string }) => {
    const body = message.content ?? "";
    const width = (process.stdout.columns || 80) - 4;
    const lines = wrapTextWithAnsi(theme.fg("text", body), Math.max(20, width));
    return new Text([theme.fg("accent", theme.bold("✧ Sprite returns")), ...lines].join("\n"), 0, 0);
  });
  pi.registerMessageRenderer("fairy-tales-hook", (message: { content?: string }, _opts: unknown, theme: { fg(c: string, s: string): string; bold(s: string): string }) => {
    const body = message.content ?? "";
    const width = (process.stdout.columns || 80) - 4;
    const lines = wrapTextWithAnsi(theme.fg("text", body), Math.max(20, width));
    return new Text([theme.fg("warning", theme.bold("⚠ A trial failed")), ...lines].join("\n"), 0, 0);
  });
}
