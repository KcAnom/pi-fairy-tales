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

// The Runebound Cyber Gate (user design): full-bleed rune bars framing the
// title between mint orbs over a slate dot-lattice.
// Palette: Poison Ivy Mint + Neon Coral (design-fixed, not theme-mapped).
const MINT = "\x1b[38;2;85;239;196m";
const CORAL = "\x1b[38;2;255;118;117m";
const SLATE = "\x1b[38;2;99;110;114m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const TITLE = " F A I R Y   T A L E S ";
const SUBTITLE = " ~ once upon a terminal ~ ";
const ORB = "🔮"; // renders 2 cells wide

function runeBar(width: number): string {
  // Alternating rune/dash, colored per glyph, built to exact cell count.
  let bar = "";
  for (let i = 0; i < width; i++) {
    bar += i % 2 === 0 ? `${MINT}𐕣` : `${SLATE}─`;
  }
  return bar + RESET;
}

function gateRow(text: string, width: number): string {
  // "🔮 " = 3 cells each side (orb is double-width) → 6 cells of frame.
  if (text.length + 6 >= width) {
    return `${MINT}${ORB} ${BOLD}${CORAL}${text.slice(0, Math.max(0, width - 8))}${RESET} ${MINT}${ORB}${RESET}`;
  }
  const inner = width - 6;
  const padding = inner - text.length;
  const left = Math.floor(padding / 2);
  const right = padding - left;
  return (
    `${MINT}${ORB} ${SLATE}${"•".repeat(left)}` +
    `${BOLD}${CORAL}${text}${RESET}` +
    `${SLATE}${"•".repeat(right)}${RESET} ${MINT}${ORB}${RESET}`
  );
}

/** Render the masthead at the given width. Returns fully colored lines. */
export function renderMasthead(_t: ThemeLike, width: number): string[] {
  return [runeBar(width), gateRow(TITLE, width), gateRow(SUBTITLE, width), runeBar(width)];
}
