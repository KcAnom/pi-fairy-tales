/**
 * Pure helpers for compaction quality assessment. The compaction extension uses
 * these to decide whether a cheap-tier summary is good enough.
 */
export interface QualityVerdict { pass: boolean; reason: string; }

/**
 * Assess a summary against the original conversation. FAILS if:
 *  - empty/trivially short (< 50 chars)
 *  - nearly as long as the input (> 50% of original length — didn't compress)
 *  - drops too many key terms (file-path-shaped tokens word.ext) — < 50% preserved
 */
export function summaryQualityScore(summary: string, original: string): QualityVerdict {
  if (!summary || summary.trim().length < 50) {
    return { pass: false, reason: "summary is empty or trivially short" };
  }
  if (summary.length > original.length * 0.5) {
    return { pass: false, reason: `summary (${summary.length} chars) is too long vs input (${original.length} chars)` };
  }
  const keyTerms = new Set((original.match(/[\w-]+\.\w+/g) ?? []));
  if (keyTerms.size > 0) {
    let preserved = 0;
    for (const term of keyTerms) if (summary.includes(term)) preserved++;
    const ratio = preserved / keyTerms.size;
    if (ratio < 0.5) {
      return { pass: false, reason: `summary preserves only ${Math.round(ratio * 100)}% of key terms (${preserved}/${keyTerms.size})` };
    }
  }
  return { pass: true, reason: "ok" };
}
