/**
 * fairy-tales-select: in-TUI copy-on-select, the way Claude Code's fullscreen
 * mode does it. Enables xterm SGR mouse tracking (1002/1006), tracks a drag
 * over pi's rendered frame, and on mouse release extracts the selected text
 * from the renderer's last frame and copies it to the clipboard, with a toast.
 *
 * Notes:
 * - Requires the terminal to deliver mouse reporting (most do; Terminal.app
 *   gates it behind View → Allow Mouse Reporting).
 * - Live highlight: the selection is overdrawn in reverse video while dragging
 *   and restored from the render buffer on change/release.
 * - Wheel and non-left-button events are consumed so they never leak into the
 *   editor as garbage; wheel scrolling inside a mouse-reporting terminal is
 *   traded away — disable with ui.copyOnSelect: false to get it back.
 * - Column math treats characters as width 1 after ANSI stripping; wide glyphs
 *   (CJK, emoji) can offset a slice by a column or two.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isNested, loadFairyTalesConfig } from "../src/config.ts";
import { CLIP_MARK } from "../src/bus.ts";
import { flashStatus } from "../src/util.ts";
import { copyToClipboard } from "./fairy-tales-grab.ts";

const ENABLE = "\x1b[?1002h\x1b[?1006h";
const DISABLE = "\x1b[?1002l\x1b[?1006l";
// One complete SGR mouse report (pi-tui's stdin buffer delivers them whole).
const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
// CSI + OSC + other escapes — for extracting plain text from rendered lines.
const ANSI = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

interface Point {
  row: number; // 1-based screen row
  col: number; // 1-based screen col
}

export function extractSelection(
  frameLines: string[],
  viewportHeight: number,
  anchor: Point,
  head: Point,
): string {
  const top = Math.max(0, frameLines.length - viewportHeight);
  let [a, b] = [anchor, head];
  if (b.row < a.row || (b.row === a.row && b.col < a.col)) [a, b] = [b, a];
  const out: string[] = [];
  for (let row = a.row; row <= b.row; row++) {
    const idx = top + row - 1;
    if (idx < 0 || idx >= frameLines.length) continue;
    const plain = frameLines[idx].replace(ANSI, "");
    const from = row === a.row ? a.col - 1 : 0;
    const to = row === b.row ? b.col : plain.length;
    out.push(plain.slice(Math.max(0, from), Math.max(0, to)).replace(/\s+$/, ""));
  }
  while (out.length && !out[out.length - 1]) out.pop();
  while (out.length && !out[0]) out.shift();
  return out.join("\n");
}

export default function (pi: ExtensionAPI) {
  if (isNested()) return;

  type Tui = {
    terminal: { write(data: string): void; rows?: number };
    addInputListener(l: (data: string) => { consume?: boolean } | undefined): () => void;
  };

  let tui: Tui | undefined;
  let unsub: (() => void) | undefined;
  let enabled = false;
  let notify: ((msg: string) => void) | undefined;
  let anchor: Point | undefined;
  let head: Point | undefined;
  // Screen rows currently overdrawn with the selection highlight.
  const paintedRows = new Set<number>();
  let lastPaintAt = 0;

  const frameOf = (t: Tui) => (t as unknown as { previousLines?: string[] }).previousLines;
  const heightOf = (t: Tui) => t.terminal.rows ?? process.stdout.rows ?? 24;

  /**
   * Live highlight: restore previously painted rows from the render buffer,
   * then overdraw the current selection in reverse video. The cursor is
   * saved/restored (DECSC/DECRC) so the renderer's position tracking holds.
   * A real re-render mid-drag overwrites the paint; the next motion event
   * repaints. Colors inside the selection collapse to inverse mono — that's
   * the standard selection look.
   */
  const paint = (restoreOnly = false) => {
    if (!tui) return;
    const frame = frameOf(tui);
    if (!Array.isArray(frame) || !frame.length) return;
    const height = heightOf(tui);
    const top = Math.max(0, frame.length - height);
    let buf = "\x1b7";
    for (const r of paintedRows) {
      const idx = top + r - 1;
      if (idx >= 0 && idx < frame.length) buf += `\x1b[${r};1H\x1b[2K${frame[idx]}\x1b[0m`;
    }
    paintedRows.clear();
    if (!restoreOnly && anchor && head) {
      let [a, b] = [anchor, head];
      if (b.row < a.row || (b.row === a.row && b.col < a.col)) [a, b] = [b, a];
      for (let r = Math.max(1, a.row); r <= Math.min(height, b.row); r++) {
        const idx = top + r - 1;
        if (idx < 0 || idx >= frame.length) continue;
        const plain = frame[idx].replace(ANSI, "");
        const from = Math.max(0, (r === a.row ? a.col : 1) - 1);
        const to = r === b.row ? b.col : plain.length;
        const slice = plain.slice(from, Math.max(from, to));
        if (!slice) continue;
        buf += `\x1b[${r};${from + 1}H\x1b[7m${slice}\x1b[0m`;
        paintedRows.add(r);
      }
    }
    buf += "\x1b8";
    tui.terminal.write(buf);
  };

  const paintThrottled = () => {
    const now = Date.now();
    if (now - lastPaintAt < 25) return;
    lastPaintAt = now;
    paint();
  };

  const disableModes = () => {
    if (!enabled) return;
    enabled = false;
    try {
      tui?.terminal.write(DISABLE);
    } catch {
      process.stdout.write(DISABLE);
    }
  };
  // Backstop: never leave the user's terminal in mouse-reporting mode.
  process.on("exit", () => {
    if (enabled) process.stdout.write(DISABLE);
  });

  const finish = async () => {
    if (!anchor || !head || !tui) return;
    const moved = anchor.row !== head.row || Math.abs(anchor.col - head.col) >= 1;
    const [a, h] = [anchor, head];
    anchor = head = undefined;
    paint(true); // clear the highlight
    if (!moved) return; // a plain click, not a selection
    const frame = frameOf(tui);
    const rows = heightOf(tui);
    if (!Array.isArray(frame) || !frame.length) return;
    const text = extractSelection(frame, rows, a, h);
    if (!text.trim()) return;
    pi.events.emit(CLIP_MARK, { text });
    await copyToClipboard(text);
    const lines = text.split("\n").length;
    notify?.(`⧉ Copied selection (${lines} line${lines > 1 ? "s" : ""} · ${text.length} chars)`);
  };

  const onInput = (data: string): { consume?: boolean } | undefined => {
    const m = SGR_MOUSE.exec(data);
    if (!m) return undefined;
    const btn = Number(m[1]);
    const col = Number(m[2]);
    const row = Number(m[3]);
    const release = m[4] === "m";
    if (btn & 64) return { consume: true }; // wheel — swallow, never editor garbage
    const isLeft = (btn & 3) === 0;
    const isMotion = (btn & 32) !== 0;
    if (release) {
      void finish();
      return { consume: true };
    }
    if (isLeft && !isMotion) {
      anchor = { row, col };
      head = { row, col };
      paint();
      return { consume: true };
    }
    if (isLeft && isMotion && anchor) {
      head = { row, col };
      paintThrottled();
      return { consume: true };
    }
    return { consume: true }; // other buttons — swallow
  };

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const cfg = loadFairyTalesConfig(ctx.cwd);
    if (cfg.ui?.copyOnSelect === false) {
      unsub?.();
      unsub = undefined;
      disableModes();
      return;
    }
    notify = (msg) => flashStatus(ctx.ui, "fairy-tales-select", msg);
    // A zero-line widget whose factory hands us the live TUI instance.
    ctx.ui.setWidget(
      "fairy-tales-select",
      (t: unknown) => {
        const next = t as Tui;
        if (tui !== next) {
          unsub?.();
          tui = next;
          unsub = tui.addInputListener(onInput);
          enabled = false;
        }
        if (!enabled) {
          enabled = true;
          tui.terminal.write(ENABLE);
        }
        return { render: () => [], invalidate() {} };
      },
      { placement: "aboveEditor" },
    );
  });

  pi.on("session_shutdown", async () => {
    unsub?.();
    unsub = undefined;
    disableModes();
  });
}
