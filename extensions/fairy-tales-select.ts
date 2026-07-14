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
 * - Wheel: inside an overlay it scrolls the overlay (translated to j/k); in
 *   the main view a wheel tick releases mouse tracking so native terminal
 *   scrollback scrolling (and native selection) works, and any keypress
 *   re-arms tracking. Non-left-button events are consumed so they never leak
 *   into the editor as garbage.
 * - Column math treats characters as width 1 after ANSI stripping; wide glyphs
 *   (CJK, emoji) can offset a slice by a column or two.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { wordWrapLine } from "../src/wrap.ts";
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
    addInputListener(l: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
    requestRender?(force?: boolean): void;
    hasOverlay?(): boolean;
  };

  /** The pi editor's runtime surface (pi-tui Editor internals, duck-typed). */
  type EditorLike = {
    getText(): string;
    setText(text: string): void;
    getCursor(): { line: number; col: number };
    state: { lines: string[]; cursorLine: number; cursorCol: number };
    lastWidth: number;
    scrollOffset: number;
    paddingX?: number;
    setCursorCol?(col: number): void;
  };

  /** One visual (wrapped) editor line: which logical line and slice it shows. */
  interface VisualLine {
    line: number;
    start: number;
    text: string;
  }

  let tui: Tui | undefined;
  let unsub: (() => void) | undefined;
  let enabled = false;
  let active = false; // feature on for this session (config + UI)
  let scrollHintShown = false;
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

  // ---- editor mouse interaction: click places the cursor, drag selects, ⌫ deletes ----

  /** Duck-type the focused component as pi's editor. */
  const focusedEditor = (): EditorLike | undefined => {
    const fc = (tui as unknown as { focusedComponent?: unknown })?.focusedComponent as EditorLike | undefined;
    return fc && typeof fc.getText === "function" && typeof fc.getCursor === "function" && fc.state?.lines
      ? fc
      : undefined;
  };

  /** Rebuild the editor's wrap layout exactly as Editor.layoutText does. */
  const layoutMap = (ed: EditorLike): VisualLine[] => {
    const width = Math.max(1, ed.lastWidth || 80);
    const out: VisualLine[] = [];
    const lines = ed.state.lines.length ? ed.state.lines : [""];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (visibleWidth(line) <= width) {
        out.push({ line: i, start: 0, text: line });
      } else {
        for (const chunk of wordWrapLine(line, width)) {
          out.push({ line: i, start: chunk.startIndex, text: chunk.text });
        }
      }
    }
    return out;
  };

  /** Index of the visual line currently containing the editor cursor. */
  const cursorVisualIndex = (ed: EditorLike, map: VisualLine[]): number => {
    for (let i = map.length - 1; i >= 0; i--) {
      const v = map[i];
      if (v.line === ed.state.cursorLine && ed.state.cursorCol >= v.start) return i;
    }
    return 0;
  };

  /**
   * Screen row (1-based) of the first visible editor content line, anchored on
   * the renderer's hardware-cursor tracking — no string matching against the
   * frame needed. Returns undefined when the anchor isn't available.
   */
  const editorContentTopRow = (ed: EditorLike): number | undefined => {
    if (!tui) return undefined;
    const t = tui as unknown as { hardwareCursorRow?: number; previousLines?: string[] };
    if (typeof t.hardwareCursorRow !== "number" || !Array.isArray(t.previousLines)) return undefined;
    const height = heightOf(tui);
    const viewportTop = Math.max(0, t.previousLines.length - height);
    const cursorScreenRow = t.hardwareCursorRow - viewportTop + 1; // 1-based
    const cvi = cursorVisualIndex(ed, layoutMap(ed));
    return cursorScreenRow - (cvi - (ed.scrollOffset ?? 0));
  };

  /** Map a screen click to a logical editor position, or undefined if outside. */
  const editorPosAt = (ed: EditorLike, row: number, col: number): { line: number; col: number } | undefined => {
    const top = editorContentTopRow(ed);
    if (top === undefined) return undefined;
    const map = layoutMap(ed);
    const scroll = ed.scrollOffset ?? 0;
    const height = heightOf(tui!);
    const maxVisible = Math.max(5, Math.floor(height * 0.3));
    const visibleCount = Math.min(map.length - scroll, maxVisible);
    const vIdx = scroll + (row - top);
    if (row < top || row >= top + visibleCount || vIdx < 0 || vIdx >= map.length) return undefined;
    const v = map[vIdx];
    const padding = ed.paddingX ?? 1;
    const offset = Math.max(0, col - 1 - padding);
    return { line: v.line, col: v.start + Math.min(offset, v.text.length) };
  };

  const setEditorCursor = (ed: EditorLike, pos: { line: number; col: number }) => {
    ed.state.cursorLine = Math.max(0, Math.min(pos.line, ed.state.lines.length - 1));
    const lineLen = (ed.state.lines[ed.state.cursorLine] ?? "").length;
    const col = Math.max(0, Math.min(pos.col, lineLen));
    if (typeof ed.setCursorCol === "function") ed.setCursorCol(col);
    else ed.state.cursorCol = col;
    tui?.requestRender?.();
  };

  // Active in-editor selection (logical text range), surviving until the next keypress.
  let editorSel: { ed: EditorLike; a: { line: number; col: number }; b: { line: number; col: number } } | undefined;
  let editorDragging = false;

  const normalizeSel = (s: NonNullable<typeof editorSel>) => {
    let { a, b } = s;
    if (b.line < a.line || (b.line === a.line && b.col < a.col)) [a, b] = [b, a];
    return { a, b };
  };

  const editorSelText = (s: NonNullable<typeof editorSel>): string => {
    const { a, b } = normalizeSel(s);
    const lines = s.ed.state.lines;
    if (a.line === b.line) return (lines[a.line] ?? "").slice(a.col, b.col);
    const parts = [(lines[a.line] ?? "").slice(a.col)];
    for (let i = a.line + 1; i < b.line; i++) parts.push(lines[i] ?? "");
    parts.push((lines[b.line] ?? "").slice(0, b.col));
    return parts.join("\n");
  };

  const deleteEditorSelection = () => {
    if (!editorSel) return;
    const { a, b } = normalizeSel(editorSel);
    const ed = editorSel.ed;
    const lines = ed.state.lines.slice();
    const merged = (lines[a.line] ?? "").slice(0, a.col) + (lines[b.line] ?? "").slice(b.col);
    lines.splice(a.line, b.line - a.line + 1, merged);
    ed.setText(lines.join("\n"));
    setEditorCursor(ed, a);
    editorSel = undefined;
    paint(true);
  };

  const clearEditorSelection = () => {
    if (!editorSel) return;
    editorSel = undefined;
    paint(true);
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

  const finishEditorDrag = async () => {
    editorDragging = false;
    if (!editorSel) return;
    const moved = editorSel.a.line !== editorSel.b.line || editorSel.a.col !== editorSel.b.col;
    if (!moved) {
      // plain click — cursor already placed
      editorSel = undefined;
      anchor = head = undefined;
      paint(true);
      return;
    }
    const text = editorSelText(editorSel);
    if (text) {
      pi.events.emit(CLIP_MARK, { text });
      await copyToClipboard(text);
      notify?.(`⧉ Copied ${text.length} chars · press ⌫ to delete the selection`);
    }
    // Keep the highlight + selection alive until the next keypress.
  };

  const onInput = (data: string): { consume?: boolean; data?: string } | undefined => {
    const m = SGR_MOUSE.exec(data);
    if (!m) {
      // Keyboard input re-arms mouse tracking after a wheel handed it back to
      // the terminal for native scrollback (typing = "I'm interacting again").
      if (active && !enabled && tui) {
        enabled = true;
        tui.terminal.write(ENABLE);
      }
      // Keyboard input while an editor selection is active: ⌫/⌦ deletes it,
      // anything else clears it and proceeds normally.
      if (editorSel && !editorDragging) {
        if (data === "\x7f" || data === "\b" || data === "\x1b[3~") {
          deleteEditorSelection();
          anchor = head = undefined;
          return { consume: true };
        }
        clearEditorSelection();
        anchor = head = undefined;
      }
      return undefined;
    }
    const btn = Number(m[1]);
    const col = Number(m[2]);
    const row = Number(m[3]);
    const release = m[4] === "m";
    if (btn & 64) {
      // Wheel. In an overlay: scroll it (the book overlays understand j/k).
      // In the main view: hand the mouse back to the terminal so native
      // scrollback scrolling works; any keypress re-arms tracking.
      if (tui?.hasOverlay?.()) {
        return { data: (btn & 3) === 0 ? "k" : "j" };
      }
      clearEditorSelection();
      anchor = head = undefined;
      paint(true);
      if (enabled) {
        enabled = false;
        try {
          tui?.terminal.write(DISABLE);
        } catch {
          process.stdout.write(DISABLE);
        }
        if (!scrollHintShown) {
          scrollHintShown = true;
          notify?.("🖱 wheel freed for scrolling — any key re-arms mouse select");
        }
      }
      return { consume: true };
    }
    const isLeft = (btn & 3) === 0;
    const isMotion = (btn & 32) !== 0;
    if (release) {
      if (editorDragging) void finishEditorDrag();
      else void finish();
      return { consume: true };
    }
    if (isLeft && !isMotion) {
      clearEditorSelection();
      // A press inside the editor's content places the cursor and may start
      // an in-editor selection; anywhere else starts a chat copy-selection.
      const ed = !tui?.hasOverlay?.() ? focusedEditor() : undefined;
      const pos = ed ? editorPosAt(ed, row, col) : undefined;
      anchor = { row, col };
      head = { row, col };
      if (ed && pos) {
        setEditorCursor(ed, pos);
        editorSel = { ed, a: pos, b: pos };
        editorDragging = true;
      } else {
        editorDragging = false;
        paint();
      }
      return { consume: true };
    }
    if (isLeft && isMotion && anchor) {
      head = { row, col };
      if (editorDragging && editorSel) {
        const pos = editorPosAt(editorSel.ed, row, col);
        if (pos) editorSel.b = pos;
      }
      paintThrottled();
      return { consume: true };
    }
    return { consume: true }; // other buttons — swallow
  };

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const cfg = loadFairyTalesConfig(ctx.cwd);
    if (cfg.ui?.copyOnSelect === false) {
      active = false;
      unsub?.();
      unsub = undefined;
      disableModes();
      return;
    }
    active = true;
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
