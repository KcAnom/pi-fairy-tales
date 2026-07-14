/**
 * Vendored word-wrap layout from @earendil-works/pi-tui
 * (dist/components/editor.js, wordWrapLine — pi-tui is MIT licensed).
 *
 * Why vendored: pi's extension loader cannot resolve deep imports into
 * packages (only bare "@earendil-works/pi-tui" works), and the index does not
 * export wordWrapLine. The editor mouse features must reproduce the editor's
 * wrap layout EXACTLY to map screen clicks to text positions, so this is a
 * faithful copy of the algorithm — keep in sync when pi-tui's editor wrapping
 * changes. One known divergence: paste-marker atomicity here matches any
 * `[paste #N …]` token regardless of the editor's valid-ID set (the editor
 * only merges markers with live IDs); it only matters for wrapped lines
 * containing stale marker-shaped text.
 */
import { visibleWidth } from "@earendil-works/pi-tui";

export interface TextChunk {
  text: string;
  startIndex: number;
  endIndex: number;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const cjkBreakRegex =
  /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;
const PASTE_MARKER_SINGLE = /^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$/;

const isWhitespaceChar = (char: string): boolean => /\s/.test(char);
const isPasteMarker = (segment: string): boolean => segment.length >= 10 && PASTE_MARKER_SINGLE.test(segment);

export function wordWrapLine(line: string, maxWidth: number): TextChunk[] {
  if (!line || maxWidth <= 0) {
    return [{ text: "", startIndex: 0, endIndex: 0 }];
  }
  const lineWidth = visibleWidth(line);
  if (lineWidth <= maxWidth) {
    return [{ text: line, startIndex: 0, endIndex: line.length }];
  }
  const chunks: TextChunk[] = [];
  const segments = [...graphemeSegmenter.segment(line)];
  let currentWidth = 0;
  let chunkStart = 0;
  // Wrap opportunity: the position after the last whitespace before a
  // non-whitespace grapheme, i.e. where a line break is allowed.
  let wrapOppIndex = -1;
  let wrapOppWidth = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const grapheme = seg.segment;
    const gWidth = visibleWidth(grapheme);
    const charIndex = seg.index;
    const isWs = !isPasteMarker(grapheme) && isWhitespaceChar(grapheme);
    // Overflow check before advancing.
    if (currentWidth + gWidth > maxWidth) {
      if (wrapOppIndex >= 0 && currentWidth - wrapOppWidth + gWidth <= maxWidth) {
        // Backtrack to last wrap opportunity (the remaining content plus the
        // current grapheme still fits within maxWidth).
        chunks.push({ text: line.slice(chunkStart, wrapOppIndex), startIndex: chunkStart, endIndex: wrapOppIndex });
        chunkStart = wrapOppIndex;
        currentWidth -= wrapOppWidth;
      } else if (chunkStart < charIndex) {
        // No viable wrap opportunity: force-break at current position.
        chunks.push({ text: line.slice(chunkStart, charIndex), startIndex: chunkStart, endIndex: charIndex });
        chunkStart = charIndex;
        currentWidth = 0;
      }
      wrapOppIndex = -1;
    }
    if (gWidth > maxWidth) {
      // Single atomic segment wider than maxWidth. Re-wrap it at grapheme
      // granularity — the split is purely visual.
      const subChunks = wordWrapLine(grapheme, maxWidth);
      for (let j = 0; j < subChunks.length - 1; j++) {
        const sc = subChunks[j];
        chunks.push({ text: sc.text, startIndex: charIndex + sc.startIndex, endIndex: charIndex + sc.endIndex });
      }
      const last = subChunks[subChunks.length - 1];
      chunkStart = charIndex + last.startIndex;
      currentWidth = visibleWidth(last.text);
      wrapOppIndex = -1;
      continue;
    }
    // Advance.
    currentWidth += gWidth;
    // Record wrap opportunity: whitespace followed by non-whitespace, or a
    // boundary where either side is CJK (CJK breaks between any characters).
    const next = segments[i + 1];
    if (isWs && next && (isPasteMarker(next.segment) || !isWhitespaceChar(next.segment))) {
      wrapOppIndex = next.index;
      wrapOppWidth = currentWidth;
    } else if (!isWs && next && !isWhitespaceChar(next.segment)) {
      const isCjk = !isPasteMarker(grapheme) && cjkBreakRegex.test(grapheme);
      const nextIsCjk = !isPasteMarker(next.segment) && cjkBreakRegex.test(next.segment);
      if (isCjk || nextIsCjk) {
        wrapOppIndex = next.index;
        wrapOppWidth = currentWidth;
      }
    }
  }
  // Push final chunk.
  chunks.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length });
  return chunks;
}
