/** The Fairy Tales masthead, shared by the startup header and title screen. */

/**
 * Close an overlay and force a full-screen repaint. pi's compositor only
 * repaints rows its own content reaches, so a tall overlay dismissed over a
 * short screen leaves stale glyphs below — requestRender(true) clears them.
 */
export function closeOverlay(tui: unknown, done: (v: undefined) => void): void {
  done(undefined);
  const timer = setTimeout(() => {
    try {
      (tui as { requestRender(force?: boolean): void }).requestRender(true);
    } catch {
      // cosmetic only
    }
  }, 15);
  timer.unref?.(); // cosmetic repaint must not keep the process alive
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

// Twilight sunset gradient (dark theme): starlight → gold → ember → rose.
const GRADIENT_DUSK: Array<[number, number, number]> = [
  [255, 233, 163],
  [255, 215, 0],
  [255, 184, 107],
  [255, 158, 158],
  [255, 126, 182],
];
// Dawn gradient (light parchment theme): deeper gilt → rose so it reads on a
// pale ground instead of washing out.
const GRADIENT_DAWN: Array<[number, number, number]> = [
  [176, 122, 0],
  [160, 109, 0],
  [184, 92, 30],
  [176, 49, 109],
  [140, 30, 90],
];

/** The brand extension sets this when the light dawn theme is active. */
function gradient(): Array<[number, number, number]> {
  return (globalThis as Record<string, unknown>).__fairyTalesDawn ? GRADIENT_DAWN : GRADIENT_DUSK;
}
function dawn(): boolean {
  return !!(globalThis as Record<string, unknown>).__fairyTalesDawn;
}

const BOLD = "\x1b[1m";
const ITALIC = "\x1b[3m";
const RESET = "\x1b[0m";
const rgb = (r: number, g: number, b: number, s: string) => `\x1b[38;2;${r};${g};${b}m${s}${RESET}`;
const LAVENDER = (s: string) => (dawn() ? rgb(109, 79, 194, s) : rgb(157, 146, 194, s));
const MOON = (s: string) => (dawn() ? rgb(90, 70, 40, s) : rgb(242, 233, 220, s));

const SUBTITLE = "once upon a terminal";

function center(s: string, visible: number, width: number): string {
  return " ".repeat(Math.max(0, Math.floor((width - visible) / 2))) + s;
}

/** Render the masthead for the given width; falls back to a compact banner
 *  on narrow terminals. Returns fully colored lines. */
export function renderMasthead(_t: ThemeLike, width: number): string[] {
  const grad = gradient();
  const [r1, g1, b1] = grad[0];
  const [r5, g5, b5] = grad[grad.length - 1];

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
    const [r, g, b] = grad[i];
    lines.push(" ".repeat(pad) + rgb(r, g, b, BOLD + row));
  });

  const ruleSeg = "─".repeat(Math.max(4, Math.floor((ART_WIDTH - SUBTITLE.length - 8) / 2)));
  const closing = `${ruleSeg} ❦ ${SUBTITLE} ❦ ${ruleSeg}`;
  lines.push(center(LAVENDER(`${ruleSeg} ❦ `) + MOON(ITALIC + SUBTITLE) + LAVENDER(` ❦ ${ruleSeg}`), closing.length, width));
  return lines;
}
