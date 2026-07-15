/**
 * Tests for src/spend.ts — session spend tracker + circuit breaker.
 *
 * NOTE: spend.ts depends on src/cost.ts (createCostAggregator / UsageLike),
 * which is authored in parallel. The pure sessionSpendExceeded tests run
 * standalone; the createSpendTracker tests resolve cost.ts at test time.
 */
import { describe, it, expect } from "vitest";
import { sessionSpendExceeded, createSpendTracker } from "../spend.ts";
import type { CostAddPayload } from "../bus.ts";

describe("sessionSpendExceeded (pure threshold check)", () => {
  it("returns false when cap is undefined", () => {
    expect(sessionSpendExceeded(100, undefined)).toBe(false);
  });

  it("returns false when cap is 0", () => {
    expect(sessionSpendExceeded(100, 0)).toBe(false);
  });

  it("returns false when cap is negative", () => {
    expect(sessionSpendExceeded(100, -5)).toBe(false);
  });

  it("returns false when spend is below the cap", () => {
    expect(sessionSpendExceeded(0.5, 1)).toBe(false);
    expect(sessionSpendExceeded(0.99, 1)).toBe(false);
  });

  it("returns true when spend equals the cap (>= boundary)", () => {
    expect(sessionSpendExceeded(1, 1)).toBe(true);
  });

  it("returns true when spend exceeds the cap", () => {
    expect(sessionSpendExceeded(2, 1)).toBe(true);
    expect(sessionSpendExceeded(1.5, 1)).toBe(true);
  });
});

describe("createSpendTracker", () => {
  it("starts at zero spend", () => {
    const t = createSpendTracker();
    expect(t.getTotal()).toBe(0);
    expect(t.exceeded(1)).toBe(false);
  });

  it("accumulates from explicitly reported COST_ADD events", () => {
    const t = createSpendTracker();
    const evt = (usd: number): CostAddPayload => ({ usd, source: "subagent" });
    t.addCostFromEvent(evt(0.1));
    t.addCostFromEvent(evt(0.2));
    expect(t.getTotal()).toBeCloseTo(0.3, 6);
  });

  it("ignores undefined events and zero usd payloads", () => {
    const t = createSpendTracker();
    t.addCostFromEvent(undefined);
    t.addCostFromEvent({ usd: 0 });
    t.addUsage(undefined);
    expect(t.getTotal()).toBe(0);
  });

  it("respects the source/input/output fields on COST_ADD without throwing", () => {
    const t = createSpendTracker();
    t.addCostFromEvent({ usd: 0.05, source: "compaction", inputTokens: 100, outputTokens: 20 });
    expect(t.getTotal()).toBeCloseTo(0.05, 6);
  });

  it("accumulates from estimated usage (tokens are priced into a positive total)", () => {
    const t = createSpendTracker();
    // No reported cost.total => falls back to estimateCostUsd. 1M input + 1M
    // output prices to $18 ($3 input/Mtok + $15 output/Mtok).
    t.addUsage({ input: 1_000_000, output: 1_000_000 });
    expect(t.getTotal()).toBeCloseTo(18.0, 6);
  });

  it("includes cache tokens in the estimated total (cache adds cost)", () => {
    const base = createSpendTracker();
    base.addUsage({ input: 1_000_000 });
    const withCache = createSpendTracker();
    withCache.addUsage({ input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 });
    // Cache tokens are billable, so the cache-bearing total must exceed the base.
    expect(withCache.getTotal()).toBeGreaterThan(base.getTotal());
  });

  it("prefers a reported cost.total over the token estimate", () => {
    const t = createSpendTracker();
    // Reported cost wins even though tokens would estimate much more.
    t.addUsage({ input: 1_000_000, output: 1_000_000, cost: { total: 0.25 } });
    expect(t.getTotal()).toBeCloseTo(0.25, 6);
  });

  it("combines estimated usage and reported COST_ADD additively", () => {
    const t = createSpendTracker();
    t.addUsage({ input: 1_000_000 }); // $3
    expect(t.getTotal()).toBeCloseTo(3.0, 6);
    t.addCostFromEvent({ usd: 0.42, source: "tale" });
    expect(t.getTotal()).toBeCloseTo(3.42, 6);
  });

  it("reset clears the accumulated total", () => {
    const t = createSpendTracker();
    t.addCostFromEvent({ usd: 5 });
    expect(t.getTotal()).toBeCloseTo(5, 6);
    t.reset();
    expect(t.getTotal()).toBe(0);
  });

  it("breaker trips at the footer math once spend crosses the cap", () => {
    // Simulate the status-line footer math: accumulate spend from events, then
    // assert exceeded() flips exactly when spend >= cap.
    const t = createSpendTracker();
    const cap = 1.0;
    expect(t.exceeded(cap)).toBe(false); // 0 < 1

    t.addCostFromEvent({ usd: 0.6 });
    expect(t.exceeded(cap)).toBe(false); // 0.6 < 1

    t.addCostFromEvent({ usd: 0.4 });
    expect(t.getTotal()).toBeCloseTo(1.0, 6);
    expect(t.exceeded(cap)).toBe(true); // 1.0 >= 1.0 — trips

    t.addCostFromEvent({ usd: 0.1 });
    expect(t.exceeded(cap)).toBe(true); // stays tripped past the cap
  });

  it("breaker does not trip for a disabled/zero/undefined cap regardless of spend", () => {
    const t = createSpendTracker();
    t.addCostFromEvent({ usd: 1_000_000 });
    expect(t.exceeded(undefined)).toBe(false);
    expect(t.exceeded(0)).toBe(false);
    expect(t.exceeded(-1)).toBe(false);
  });
});
