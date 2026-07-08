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

// "Gilded Dusk": solid block lettering lit by a vertical sunset gradient —
// starlight gold melting into rose, row by row — beneath a crescent moon
// with drifting dust, closed by a fleuron rule.
const LETTERS: string[] = [
  "█████  ███  █████ ████  █   █    █████  ███  █     █████  ████",
  "█     █   █   █   █   █  █ █       █   █   █ █     █     █    ",
  "████  █████   █   ████    █       █   █████ █      ████  ███  ",
  "█     █   █   █   █  █    █       █   █   █ █      █        █ ",
  "█     █   █ █████ █   █   █       █   █   █ █████ █████ ████  ",
];
const ART_WIDTH = LETTERS[0].length;

// Sunset gradient, one stop per lettering row (starlight → gold → ember → rose).
const GRADIENT: Array<[number, number, number]> = [
  [255, 233, 163],
  [255, 215, 0],
  [255, 184, 107],
  [255, 158, 158],
  [255, 126, 182],
];

const BOLD = "\x1b[1m";
const ITALIC = "\x1b[3m";
const RESET = "\x1b[0m";
const rgb = (r: number, g: number, b: number, s: string) => `\x1b[38;2;${r};${g};${b}m${s}${RESET}`;
const LAVENDER = (s: string) => rgb(157, 146, 194, s);
const MOON = (s: string) => rgb(242, 233, 220, s);

const SUBTITLE = "once upon a terminal";

function center(s: string, visible: number, width: number): string {
  return " ".repeat(Math.max(0, Math.floor((width - visible) / 2))) + s;
}

/** Render the masthead for the given width; falls back to a compact banner
 *  on narrow terminals. Returns fully colored lines. */
export function renderMasthead(_t: ThemeLike, width: number): string[] {
  const [r1, g1, b1] = GRADIENT[0];
  const [r5, g5, b5] = GRADIENT[GRADIENT.length - 1];

  if (width < ART_WIDTH + 2) {
    const title = "F A I R Y   T A L E S";
    return [
      center(LAVENDER("·  ✦    ·   ✧      ·      ✦   ·"), 31, width),
      center(rgb(r1, g1, b1, BOLD + `✧  ${title}  ✧`), title.length + 6, width),
      center(LAVENDER(ITALIC + `~ ${SUBTITLE} ~`), SUBTITLE.length + 4, width),
      center(rgb(r5, g5, b5, "·  ✧    ·   ✦      ·      ✧   ·"), 31, width),
    ];
  }

  const pad = Math.max(0, Math.floor((width - ART_WIDTH) / 2));
  const sky =
    " ".repeat(Math.max(0, pad - 4)) +
    MOON("☾") +
    LAVENDER(" ·˚ ✦") +
    " ".repeat(Math.max(1, ART_WIDTH - 8)) +
    LAVENDER("✧ ˚· ");

  const lines: string[] = [sky];
  LETTERS.forEach((row, i) => {
    const [r, g, b] = GRADIENT[i];
    lines.push(" ".repeat(pad) + rgb(r, g, b, BOLD + row));
  });

  const ruleSeg = "─".repeat(Math.max(4, Math.floor((ART_WIDTH - SUBTITLE.length - 8) / 2)));
  const closing = `${ruleSeg} ❦ ${SUBTITLE} ❦ ${ruleSeg}`;
  lines.push(center(LAVENDER(`${ruleSeg} ❦ `) + MOON(ITALIC + SUBTITLE) + LAVENDER(` ❦ ${ruleSeg}`), closing.length, width));
  return lines;
}
