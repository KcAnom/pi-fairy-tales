/**
 * Tests for the shared cost aggregator (src/cost.ts).
 *
 * The footer, status line, and ledger all share this fallback math:
 *   reported > 0 ? reported : estimateCostUsd(...)
 * These tests pin the rules that keep their counters in agreement — most
 * importantly that a reported cost is used as-is and never double-counted
 * against a cache-token estimate.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createCostAggregator } from "../cost.ts";

describe("createCostAggregator", () => {
  let agg: ReturnType<typeof createCostAggregator>;
  beforeEach(() => {
    agg = createCostAggregator();
  });

  describe("addUsage — reported cost path", () => {
    it("uses the reported cost total when it is greater than zero", () => {
      agg.addUsage({ input: 1_000_000, output: 1_000_000, cost: { total: 0.42 } });
      // A pure estimate of 1M/1M tokens would be ~$18; reported $0.42 wins.
      expect(agg.getUsd()).toBeCloseTo(0.42, 6);
    });

    it("does not double-count: reported cost is preferred over the cache-token estimate", () => {
      agg.addUsage({
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
        cost: { total: 0.05 },
      });
      // If the cache estimate were added on top we'd see ~$22; we must see $0.05.
      expect(agg.getUsd()).toBeCloseTo(0.05, 6);
      expect(agg.getUsd()).toBeLessThan(1);
    });

    it("treats an explicit zero reported total as 'unreported' and falls back to the estimate", () => {
      agg.addUsage({ input: 1_000_000, output: 0, cost: { total: 0 } });
      expect(agg.getUsd()).toBeCloseTo(3.0, 6);
    });

    it("falls back to the estimate when no cost object is present", () => {
      agg.addUsage({ input: 1_000_000, output: 1_000_000 });
      expect(agg.getUsd()).toBeCloseTo(3.0 + 15.0, 6);
    });

    it("falls back to the estimate when cost.total is undefined", () => {
      agg.addUsage({ input: 1_000_000, output: 0, cost: {} });
      expect(agg.getUsd()).toBeCloseTo(3.0, 6);
    });
  });

  describe("addUsage — estimate fallback path", () => {
    it("estimates from input/output tokens when cost is unreported", () => {
      agg.addUsage({ input: 500_000, output: 500_000 });
      // 0.5M * $3 + 0.5M * $15 = $1.5 + $7.5
      expect(agg.getUsd()).toBeCloseTo(9.0, 6);
    });

    it("includes cache-read tokens in the fallback estimate (~$0.30/Mtok)", () => {
      agg.addUsage({ cacheRead: 1_000_000 });
      expect(agg.getUsd()).toBeCloseTo(0.3, 6);
    });

    it("includes cache-write tokens in the fallback estimate (~$3.75/Mtok)", () => {
      agg.addUsage({ cacheWrite: 1_000_000 });
      expect(agg.getUsd()).toBeCloseTo(3.75, 6);
    });

    it("combines all four token types additively in the fallback", () => {
      agg.addUsage({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 });
      expect(agg.getUsd()).toBeCloseTo(3.0 + 15.0 + 0.3 + 3.75, 6);
    });

    it("treats missing token fields as zero (no NaN)", () => {
      agg.addUsage({});
      expect(agg.getUsd()).toBe(0);
      expect(Number.isFinite(agg.getUsd())).toBe(true);
    });
  });

  describe("addUsage — no-op cases", () => {
    it("ignores an undefined usage", () => {
      agg.addUsage(undefined);
      expect(agg.getUsd()).toBe(0);
      expect(agg.getTotal()).toEqual({
        usd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });
  });

  describe("token totals", () => {
    it("tracks input/output token totals across calls", () => {
      agg.addUsage({ input: 100, output: 50 });
      agg.addUsage({ input: 200, output: 150 });
      expect(agg.getTotal().inputTokens).toBe(300);
      expect(agg.getTotal().outputTokens).toBe(200);
    });

    it("tracks cache-read and cache-write token totals across calls", () => {
      agg.addUsage({ cacheRead: 1000, cacheWrite: 2000 });
      agg.addUsage({ cacheRead: 3000, cacheWrite: 4000 });
      expect(agg.getTotal().cacheReadTokens).toBe(4000);
      expect(agg.getTotal().cacheWriteTokens).toBe(6000);
    });

    it("accumulates tokens even when the reported cost is used", () => {
      // Token totals are independent of whether we used the reported cost.
      agg.addUsage({ input: 1_000_000, output: 1_000_000, cacheRead: 500, cacheWrite: 500, cost: { total: 0.42 } });
      const total = agg.getTotal();
      expect(total.inputTokens).toBe(1_000_000);
      expect(total.outputTokens).toBe(1_000_000);
      expect(total.cacheReadTokens).toBe(500);
      expect(total.cacheWriteTokens).toBe(500);
      expect(total.usd).toBeCloseTo(0.42, 6);
    });
  });

  describe("accumulation", () => {
    it("sums usd across multiple addUsage calls (reported and estimated)", () => {
      agg.addUsage({ input: 1_000_000, output: 0, cost: { total: 1.0 } }); // reported 1.0
      agg.addUsage({ input: 1_000_000, output: 0 }); // estimated 3.0
      agg.addUsage({ input: 0, output: 1_000_000, cost: { total: 0.5 } }); // reported 0.5
      expect(agg.getUsd()).toBeCloseTo(1.0 + 3.0 + 0.5, 6);
    });

    it("getUsd and getTotal().usd agree", () => {
      agg.addUsage({ input: 100_000, output: 50_000 });
      expect(agg.getUsd()).toBe(agg.getTotal().usd);
    });
  });

  describe("addCost", () => {
    it("adds a raw usd amount for subagent/compaction events", () => {
      agg.addCost(0.123);
      expect(agg.getUsd()).toBeCloseTo(0.123, 6);
    });

    it("stacks addCost on top of addUsage totals", () => {
      agg.addUsage({ input: 1_000_000, output: 0, cost: { total: 2.0 } });
      agg.addCost(0.5);
      expect(agg.getUsd()).toBeCloseTo(2.5, 6);
    });

    it("does not change token totals (token-less side events)", () => {
      agg.addCost(1.0);
      const total = agg.getTotal();
      expect(total.usd).toBe(1.0);
      expect(total.inputTokens).toBe(0);
      expect(total.outputTokens).toBe(0);
      expect(total.cacheReadTokens).toBe(0);
      expect(total.cacheWriteTokens).toBe(0);
    });

    it("adds zero cost without effect", () => {
      agg.addUsage({ input: 1_000_000, output: 0 });
      const before = agg.getUsd();
      agg.addCost(0);
      expect(agg.getUsd()).toBe(before);
    });
  });

  describe("reset", () => {
    it("clears usd back to zero", () => {
      agg.addUsage({ input: 1_000_000, output: 0, cost: { total: 5.0 } });
      agg.addCost(3.0);
      agg.reset();
      expect(agg.getUsd()).toBe(0);
    });

    it("clears all token totals back to zero", () => {
      agg.addUsage({ input: 100, output: 200, cacheRead: 300, cacheWrite: 400 });
      agg.reset();
      expect(agg.getTotal()).toEqual({
        usd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });

    it("leaves the aggregator usable after reset", () => {
      agg.addUsage({ input: 1_000_000, output: 0, cost: { total: 5.0 } });
      agg.reset();
      agg.addUsage({ input: 1_000_000, output: 0, cost: { total: 2.0 } });
      expect(agg.getUsd()).toBeCloseTo(2.0, 6);
      expect(agg.getTotal().inputTokens).toBe(1_000_000);
    });
  });

  describe("instance isolation", () => {
    it("separate aggregators do not share state", () => {
      const a = createCostAggregator();
      const b = createCostAggregator();
      a.addUsage({ input: 1_000_000, output: 0, cost: { total: 9.0 } });
      b.addUsage({ input: 1_000_000, output: 0, cost: { total: 1.0 } });
      expect(a.getUsd()).toBe(9.0);
      expect(b.getUsd()).toBe(1.0);
      // Resetting one must not touch the other.
      a.reset();
      expect(a.getUsd()).toBe(0);
      expect(b.getUsd()).toBe(1.0);
    });
  });
});
