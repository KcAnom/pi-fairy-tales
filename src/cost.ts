/**
 * Shared cost-aggregation logic for the footer, status line, and ledger.
 * The three cost-tracking extensions each independently re-implemented the
 * `reported > 0 ? reported : estimateCostUsd(...)` fallback. Any divergence
 * makes the footer's gold counter disagree with /ledger's total. This module
 * is the single source of truth; each extension owns its own instance (per the
 * bus.ts rule that module-level state is not shared across extension files).
 */
import { estimateCostUsd } from "./util.ts";

export interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

export interface CostTotals {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function createCostAggregator() {
  let usd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  return {
    addUsage(usage: UsageLike | undefined): void {
      if (!usage) return;
      inputTokens += usage.input ?? 0;
      outputTokens += usage.output ?? 0;
      cacheReadTokens += usage.cacheRead ?? 0;
      cacheWriteTokens += usage.cacheWrite ?? 0;
      const reported = usage.cost?.total ?? 0;
      usd += reported > 0
        ? reported
        : estimateCostUsd(usage.input ?? 0, usage.output ?? 0, usage.cacheRead ?? 0, usage.cacheWrite ?? 0);
    },
    addCost(amount: number): void { usd += amount; },
    getTotal(): CostTotals { return { usd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }; },
    getUsd(): number { return usd; },
    reset(): void { usd = 0; inputTokens = 0; outputTokens = 0; cacheReadTokens = 0; cacheWriteTokens = 0; },
  };
}
