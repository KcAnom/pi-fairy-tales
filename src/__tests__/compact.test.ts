/**
 * Tests for src/compact.ts — compaction quality guard.
 * Pins the pass/fail thresholds so the compaction extension can rely on them.
 */
import { describe, it, expect } from "vitest";
import { summaryQualityScore } from "../compact.ts";

describe("summaryQualityScore", () => {
  it("passes for a good summary that compresses and preserves key terms", () => {
    const original = [
      "We discussed the implementation across engine.ts, config.ts, memory.ts,",
      "rules.ts, net.ts, and util.ts. The user wanted caching layered into",
      "engine.ts while keeping config.ts stable. memory.ts got the new LRU hook.",
      "rules.ts validation net.ts retries util.ts helpers all stayed the same.",
      "Repeating for length padding so the summary can be under half the size.",
      "engine.ts config.ts memory.ts rules.ts net.ts util.ts padding padding.",
    ].join(" ");
    const summary = "Implemented caching in engine.ts, kept config.ts stable, added LRU hook to memory.ts; rules.ts net.ts util.ts unchanged.";
    const verdict = summaryQualityScore(summary, original);
    expect(verdict.pass).toBe(true);
    expect(verdict.reason).toBe("ok");
  });

  it("fails for an empty summary", () => {
    const original = "engine.ts and config.ts were discussed here padding padding padding padding.";
    const verdict = summaryQualityScore("", original);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("trivially short");
  });

  it("fails for a trivially short summary (whitespace-only under 50 chars)", () => {
    const original = "engine.ts and config.ts were discussed here padding padding padding padding.";
    const verdict = summaryQualityScore("   ", original);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("trivially short");
  });

  it("fails for a summary that is too short in real text (< 50 chars)", () => {
    const original = "engine.ts and config.ts were discussed here padding padding padding padding padding.";
    const verdict = summaryQualityScore("ok done.", original);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("trivially short");
  });

  it("fails when the summary is nearly as long as the input (> 50%)", () => {
    // Original repeated so the summary (< 50% length) cannot trip the length
    // gate — instead this case exercises a summary that DID NOT compress.
    const phrase = "The model returned a long-winded answer about engine.ts and config.ts. ";
    const original = phrase.repeat(10); // long input
    // Summary is > 50% of original length on purpose.
    const summary = original.slice(0, Math.ceil(original.length * 0.75));
    const verdict = summaryQualityScore(summary, original);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("too long");
  });

  it("fails when the summary drops too many file-path key terms", () => {
    // Lots of distinct *.ts terms; padded so the summary can be < 50% length.
    const original = [
      "The conversation touched many modules: engine.ts config.ts memory.ts",
      "rules.ts net.ts util.ts banner.ts wrap.ts overlay.ts glob.ts text.ts.",
      "Padding to ensure the summary stays under half the length of the input.",
      "More padding here padding padding padding padding padding padding.",
      "engine.ts config.ts memory.ts rules.ts net.ts util.ts banner.ts wrap.ts.",
    ].join(" ");
    // Summary mentions ONLY engine.ts (1 of many) — well under 50% of terms.
    const summary = "Summary covers engine.ts broadly and omits the rest of the module list entirely.";
    const verdict = summaryQualityScore(summary, original);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("key terms");
  });

  it("passes when the original has no file-path-shaped key terms", () => {
    // No word.ext tokens; long input; a genuine short summary compresses fine.
    const original = "The user asked about how the whole system fits together and we walked through the architecture end to end without referencing any particular file names at all. ".repeat(4);
    const summary = "Walked through end-to-end architecture with the user; no specific files referenced.";
    const verdict = summaryQualityScore(summary, original);
    expect(verdict.pass).toBe(true);
    expect(verdict.reason).toBe("ok");
  });

  it("passes at exactly the 50% length threshold (boundary inclusive)", () => {
    // summary.length === original.length * 0.5 must NOT trip the strict `>` check.
    // Use no key terms to isolate the length gate.
    const chunk = "x".repeat(50);
    const original = chunk.repeat(4); // 200 chars
    const summary = "y".repeat(100) + " filler words to clear the fifty-char minimum gate easily here"; // 100 *exact* base + tail
    // Make summary exactly 100 chars (50% of 200) with >50 non-space chars.
    const exact = "z".repeat(100);
    const verdict = summaryQualityScore(exact, original);
    expect(verdict.pass).toBe(true);
    expect(verdict.reason).toBe("ok");
    // sanity: the over-threshold case trips
    const over = summaryQualityScore("z".repeat(101), original);
    expect(over.pass).toBe(false);
  });

  it("passes when exactly 50% of key terms are preserved (boundary inclusive)", () => {
    // Two distinct key terms; preserve exactly one (50%) — ratio < 0.5 is strict.
    // Pad the original so the summary stays under the 50% length gate.
    const original = [
      "We fixed bugs in engine.ts and then moved on to review config.ts thoroughly.",
      "Padding padding padding padding padding padding padding padding padding.",
      "More length padding so the summary can comfortably be under half the size.",
    ].join(" ");
    const summary = "Fixed bugs in engine.ts and reviewed the rest without naming it specifically here done.";
    const verdict = summaryQualityScore(summary, original);
    // engine.ts preserved (1 of 2) => ratio 0.5, not < 0.5 => passes length+terms.
    expect(verdict.pass).toBe(true);
  });
});
