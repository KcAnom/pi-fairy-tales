/**
 * fairy-tales-brand: the "Fairy Tales" experience.
 * Active ONLY when launched via the `ftales` command (which sets FTALES=1) —
 * plain `pi` stays completely unbranded. When active:
 *   - switches to the fairy-tales theme (shipped in this package)
 *   - replaces the startup header with the Fairy Tales banner
 *   - sets the terminal title
 *   - swaps the working indicator for drifting fairy dust
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { isNested, loadFairyTalesConfig, saveUserConfig, updateUserConfig } from "../src/config.ts";
import { renderMasthead } from "../src/banner.ts";

const SPARKLES = ["·", "✦", "✧", "⋆", "✧", "✦"];

function settingsTheme(): string | undefined {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf-8")).theme;
  } catch {
    return undefined;
  }
}

const isFairyTheme = (name?: string) => !!name && name.startsWith("fairy-tales");

/** Day/night enchantment: parchment dawn theme 07:00–18:59, twilight otherwise. */
function themeForHour(hour: number): string {
  return hour >= 7 && hour < 19 ? "fairy-tales-dawn" : "fairy-tales";
}

/** Tell the masthead renderer which gradient to use (dark vs light ground). */
function markDawn(themeName: string): void {
  (globalThis as Record<string, unknown>).__fairyTalesDawn = themeName === "fairy-tales-dawn";
}

export default function (pi: ExtensionAPI) {
  if (isNested()) return;

  if (process.env.FTALES !== "1") {
    // Plain `pi`: setTheme persists to settings.json, so if the last session
    // was ftales-branded, hand the theme back to what it was before. This is a
    // one-shot: after restoring we DELETE ui.previousTheme so it can't re-fire
    // on every subsequent plain-pi start — and a user who manually picks a
    // non-fairy theme in plain pi won't get it reverted.
    pi.on("session_start", async (_event, ctx) => {
      if (!ctx.hasUI) return;
      try {
        const previous = loadFairyTalesConfig(ctx.cwd).ui?.previousTheme;
        if (previous && !isFairyTheme(previous) && isFairyTheme(settingsTheme())) {
          ctx.ui.setTheme(previous);
          await updateUserConfig((c) => {
            const ui = (c.ui ?? {}) as { previousTheme?: string };
            delete ui.previousTheme;
            return { ...c, ui };
          });
        }
      } catch {
        // never block startup over cosmetics
      }
    });
    return;
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Theme: remember what the user had, then switch (setTheme persists).
    // Day/night enchantment picks the twilight or dawn variant by local hour.
    try {
      const current = settingsTheme();
      if (current && !isFairyTheme(current)) {
        await saveUserConfig({ ui: { previousTheme: current } });
      }
      const wanted = themeForHour(new Date().getHours());
      markDawn(wanted);
      if (current !== wanted) {
        ctx.ui.setTheme(wanted);
      }
    } catch {
      // theme missing — banner and title still apply
    }

    const theme = ctx.ui.theme;
    ctx.ui.setTitle(`✦ Fairy Tales — ${basename(ctx.cwd)}`);

    ctx.ui.setHeader((_tui: unknown, t: { fg(color: string, text: string): string; bold(text: string): string }) => ({
      invalidate() {},
      render(width: number): string[] {
        return renderMasthead(t, width);
      },
    }));

    ctx.ui.setWorkingIndicator({
      frames: SPARKLES.map((s, i) =>
        theme.fg(i % 2 === 0 ? "accent" : "muted", s),
      ),
      intervalMs: 160,
    });
  });
}
