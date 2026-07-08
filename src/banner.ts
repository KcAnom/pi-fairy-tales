/** The Fairy Tales masthead, shared by the startup header and title screen. */

/**
 * Close an overlay and force a full-screen repaint. pi's compositor only
 * repaints rows its own content reaches, so a tall overlay dismissed over a
 * short screen leaves stale glyphs below — requestRender(true) clears them.
 */
export function closeOverlay(tui: unknown, done: (v: undefined) => void): void {
  done(undefined);
  setTimeout(() => {
    try {
      (tui as { requestRender(force?: boolean): void }).requestRender(true);
    } catch {
      // cosmetic only
    }
  }, 15);
}

export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

// Solid block lettering split into [FAIRY, TALES] halves so each word gets its own color.
const LETTERS: Array<[string, string]> = [
  ["█████  ███  █████ ████  █   █", "   █████  ███  █     █████  ████"],
  ["█     █   █   █   █   █  █ █ ", "     █   █   █ █     █     █    "],
  ["████  █████   █   ████    █  ", "     █   █████ █     ████   ███ "],
  ["█     █   █   █   █  █    █  ", "     █   █   █ █     █         █"],
  ["█     █   █ █████ █   █   █  ", "     █   █   █ █████ █████ ████ "],
];

const ART_WIDTH = LETTERS[0][0].length + LETTERS[0][1].length;
const DUST = "·  ✦    ·   ✧      ·      ✦    ·    ✧   ·";
const SUBTITLE = "~ once upon a terminal ~";

function center(s: string, visible: number, width: number): string {
  return " ".repeat(Math.max(0, Math.floor((width - visible) / 2))) + s;
}

/** Render the masthead for the given width; falls back to the compact banner
 *  on narrow terminals. Returns fully colored lines. */
export function renderMasthead(t: ThemeLike, width: number): string[] {
  if (width < ART_WIDTH + 2) {
    const title = "F A I R Y   T A L E S";
    return [
      center(t.fg("dim", DUST), DUST.length, width),
      center(t.fg("accent", t.bold(`✧  ${title}  ✧`)), title.length + 6, width),
      center(t.fg("muted", SUBTITLE), SUBTITLE.length, width),
      center(t.fg("dim", DUST), DUST.length, width),
    ];
  }
  const lines: string[] = [];
  lines.push(center(t.fg("dim", DUST), DUST.length, width));
  for (const [fairy, tales] of LETTERS) {
    lines.push(center(t.fg("accent", t.bold(fairy)) + t.fg("mdCode", t.bold(tales)), ART_WIDTH, width));
  }
  const sub = `✧ ${SUBTITLE} ✦`;
  lines.push(center(t.fg("muted", sub), sub.length, width));
  lines.push(center(t.fg("dim", DUST), DUST.length, width));
  return lines;
}
