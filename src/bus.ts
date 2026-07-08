/**
 * Names and payload types for the pi.events cross-extension bus.
 * All fairy-tales extensions communicate ONLY through these events —
 * module-level state is not guaranteed to be shared across extension files.
 */

export const AGENTS_STATUS = "fairy-tales:agents:status";
export const COST_ADD = "fairy-tales:cost:add";
export const PLAN_CHANGED = "fairy-tales:plan:changed";

export interface RunSummary {
  id: string;
  name: string;
  role: string;
  model: string;
  turns: number;
  costUsd: number;
  startedAt: number;
  lastActivity: string;
  background: boolean;
  state: "running" | "done" | "error" | "aborted";
}

export interface AgentsStatusPayload {
  running: RunSummary[];
}

export interface CostAddPayload {
  usd: number;
}

export interface PlanChangedPayload {
  active: boolean;
}
