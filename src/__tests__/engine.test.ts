/**
 * Tests for shouldEscalate (orchestrated-mode escalation decision).
 * attachTracker/execute/continue need a live pi session — integration-tested
 * via `pi -p`, not here.
 */
import { describe, it, expect } from "vitest";
import { shouldEscalate } from "../subagent/engine.ts";
import type { FairyTalesConfig } from "../config.ts";

const baseCfg = (overrides: Partial<FairyTalesConfig> = {}): FairyTalesConfig => ({
  tiers: { conductor: { model: "openai/strong" }, scout: { model: "openai/cheap" } },
  agents: {
    maxConcurrent: 5, maxTurnsPerRun: 20, maxCostPerRunUsd: 1.5,
    modelMode: "orchestrated", singleModel: "session",
    roles: { explore: { tier: "scout" }, plan: { tier: "conductor" } },
  },
  memory: { dir: "~", injectIndex: true },
  plans: { dir: "~" },
  hooks: { bash: [], paths: [], postEdit: { testCommandFile: "", enabled: false } },
  web: { timeoutMs: 1, maxBytes: 1 },
  ...overrides,
});

describe("shouldEscalate", () => {
  it("escalates a provider-error run on a cheap tier", () => {
    expect(shouldEscalate(baseCfg(), "scout", { state: "error" }, undefined, false)).toBe(true);
  });

  it("escalates a structured 'failed' status", () => {
    expect(shouldEscalate(baseCfg(), "scout", { state: "done" }, { status: "failed" }, false)).toBe(true);
  });

  it("escalates a turn-cap abort (cappedReason set)", () => {
    expect(shouldEscalate(baseCfg(), "scout", { state: "aborted", cappedReason: "turn cap (20) reached" }, undefined, false)).toBe(true);
  });

  it("escalates a cost-cap abort (cappedReason set)", () => {
    expect(shouldEscalate(baseCfg(), "scout", { state: "aborted", cappedReason: "cost cap ($1.50) reached" }, undefined, false)).toBe(true);
  });

  it("does NOT escalate a user-initiated abort (no cappedReason)", () => {
    expect(shouldEscalate(baseCfg(), "scout", { state: "aborted" }, undefined, false)).toBe(false);
  });

  it("does NOT escalate a clean completion", () => {
    expect(shouldEscalate(baseCfg(), "scout", { state: "done" }, undefined, false)).toBe(false);
  });

  it("does NOT escalate a conductor-tier run (would loop)", () => {
    expect(shouldEscalate(baseCfg(), "conductor", { state: "error" }, undefined, false)).toBe(false);
  });

  it("does NOT escalate when already escalated", () => {
    expect(shouldEscalate(baseCfg(), "scout", { state: "error" }, undefined, true)).toBe(false);
  });

  it("does NOT escalate in non-orchestrated modes", () => {
    expect(shouldEscalate(baseCfg({ agents: { ...baseCfg().agents, modelMode: "tiered" } }), "scout", { state: "error" }, undefined, false)).toBe(false);
    expect(shouldEscalate(baseCfg({ agents: { ...baseCfg().agents, modelMode: "single" } }), "scout", { state: "error" }, undefined, false)).toBe(false);
  });

  it("does NOT escalate when no conductor tier is configured", () => {
    const noConductor = baseCfg({ tiers: { scout: { model: "openai/cheap" } } });
    expect(shouldEscalate(noConductor, "scout", { state: "error" }, undefined, false)).toBe(false);
  });
});
