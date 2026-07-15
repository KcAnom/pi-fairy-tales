/** A scrollable book-style overlay shared by /tale and /grimoire. */
import { closeOverlay } from "./banner.ts";
import { debug } from "./util.ts";

interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Build the component object passed to ctx.ui.custom, with scroll handling. */
export function bookOverlay(opts: {
  title: string;
  contentLines: string[]; // pre-colored content (no frame)
  tui: unknown;
  theme: ThemeLike;
  done: (v: undefined) => void;
  hint?: string;
  /** Show the branded sparkle separators (· ✦). Plain pi gets plain "·". Defaults
   *  to off unless FTALES=1 is active, matching the plain-pi/ftales contract. */
  branded?: boolean;
}) {
  const { title, contentLines, tui, theme, done } = opts;
  // Default to the branded separators when running under ftales; callers can opt
  // out (plain pi) by passing branded: false. Plain pi → plain "·" separators.
  const branded = (opts.branded ?? process.env.FTALES === "1") && process.env.FTALES === "1";
  let offset = 0;

  // Rows for content between the frame. If the terminal height is unknown
  // (0/undefined — some ptys don't report it), show all content rather than
  // clip; scrolling only engages when we can actually measure the screen.
  const viewport = () => {
    const rows = process.stdout.rows;
    if (!rows || rows < 10) return contentLines.length;
    return Math.max(6, rows - 8);
  };

  const clamp = () => {
    const max = Math.max(0, contentLines.length - viewport());
    if (offset > max) offset = max;
    if (offset < 0) offset = 0;
  };

  debug("overlay", `${title} contentLines=${contentLines.length} rows=${process.stdout.rows}`);
  return {
    render(width: number): string[] {
      const inner = Math.max(20, width - 4);
      const motif = branded ? "· ✦ " : "· ";
      const rule = theme.fg("dim", motif.repeat(Math.max(1, Math.floor(inner / motif.length))));
      clamp();
      const vp = viewport();
      const window = contentLines.slice(offset, offset + vp);
      const more = contentLines.length > vp;
      const pos = more ? `  ${theme.fg("dim", `lines ${offset + 1}–${Math.min(offset + vp, contentLines.length)} of ${contentLines.length}`)}` : "";
      const hint = theme.fg("dim", opts.hint ?? (more ? "↑/↓ or j/k scroll · space page · q close" : "press q to close"));
      return [
        "",
        `  ${theme.fg("accent", theme.bold(title))}`,
        `  ${rule}`,
        "",
        ...window.map((l) => `  ${l}`),
        "",
        `  ${rule}`,
        pos,
        `  ${hint}`,
        "",
      ];
    },
    invalidate() {},
    handleInput(data: string) {
      const vp = viewport();
      if (data === "\x1b[A" || data === "k") {
        offset -= 1;
      } else if (data === "\x1b[B" || data === "j") {
        offset += 1;
      } else if (data === "\x1b[5~") {
        offset -= vp;
      } else if (data === "\x1b[6~" || data === " ") {
        offset += vp;
      } else if (data === "g") {
        offset = 0;
      } else if (data === "G") {
        offset = contentLines.length;
      } else {
        // q, escape, enter, or any other key closes the book
        closeOverlay(tui, done);
        return;
      }
      clamp();
    },
  };
}
