/**
 * Session spend tracking + circuit breaker, shared by extensions that spawn
 * subagents. Each extension owns its own instance (per bus.ts no-shared-state).
 */
import type { CostAddPayload } from "./bus.ts";
import { createCostAggregator, type UsageLike } from "./cost.ts";

/** Pure threshold check — exported for unit testing. */
export function sessionSpendExceeded(spend: number, cap: number | undefined): boolean {
  if (!cap || cap <= 0) return false;
  return spend >= cap;
}

export function createSpendTracker() {
  const cost = createCostAggregator();
  return {
    addUsage(usage: UsageLike | undefined): void { cost.addUsage(usage); },
    addCostFromEvent(data: CostAddPayload | undefined): void { if (data?.usd) cost.addCost(data.usd); },
    getTotal(): number { return cost.getUsd(); },
    exceeded(cap: number | undefined): boolean { return sessionSpendExceeded(cost.getUsd(), cap); },
    reset(): void { cost.reset(); },
  };
}
