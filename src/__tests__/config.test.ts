/**
 * Baseline tests for pure helpers from src/config.ts.
 */
import { describe, it, expect } from "vitest";
import { loadoutSummary, lineupLabel, loadoutToPatch, resolveCheapestModel, type Loadout, type FairyTalesConfig } from "../config.ts";

const shortModelId = (id: string) => id;

describe("loadoutSummary", () => {
  it("renders single mode with the session model (no sessionModel → ?)", () => {
    const l: Loadout = { modelMode: "single", singleModel: "session", tiers: {}, roles: { explore: "scout" } };
    expect(loadoutSummary(l, shortModelId)).toBe("? everywhere · single");
  });

  it("renders single-session mode with a known sessionModel", () => {
    const l: Loadout = { modelMode: "single", singleModel: "session", sessionModel: "openai/lead", tiers: {}, roles: { explore: "scout" } };
    expect(loadoutSummary(l, shortModelId)).toBe("lead everywhere · single");
  });

  it("renders single mode with a specific model", () => {
    const l: Loadout = { modelMode: "single", singleModel: "openai/gpt-4", tiers: {}, roles: { explore: "scout" } };
    expect(loadoutSummary(l, shortModelId)).toBe("gpt-4 everywhere · single");
  });

  it("renders tiered mode as lead ▸ crew", () => {
    const l: Loadout = {
      modelMode: "tiered",
      sessionModel: "openai/lead",
      tiers: { scout: { model: "anthropic/mini" }, worker: { model: "openai/main" } },
      roles: { explore: "scout", build: "worker" },
    };
    expect(loadoutSummary(l, shortModelId)).toBe("lead ▸ mini·main · tiered");
  });

  it("renders orchestrated mode with the 🎼 prefix", () => {
    const l: Loadout = {
      modelMode: "orchestrated",
      sessionModel: "openai/lead",
      tiers: { conductor: { model: "openai/sol" }, scout: { model: "anthropic/mini" } },
      roles: { explore: "scout", plan: "conductor" },
    };
    expect(loadoutSummary(l, shortModelId)).toBe("🎼 sol ▸ mini · orchestrated");
  });

  it("dedupes crew models", () => {
    const l: Loadout = {
      modelMode: "tiered",
      sessionModel: "openai/lead",
      tiers: { scout: { model: "anthropic/mini" }, worker: { model: "anthropic/mini" } },
      roles: { explore: "scout", build: "worker" },
    };
    expect(loadoutSummary(l, shortModelId)).toBe("lead ▸ mini · tiered");
  });
});

describe("lineupLabel", () => {
  const cfg = (mode: string): FairyTalesConfig => ({
    tiers: { conductor: { model: "openai/sol" }, scout: { model: "anthropic/mini" } },
    agents: {
      maxConcurrent: 5, maxTurnsPerRun: 20, maxCostPerRunUsd: 1.5,
      modelMode: mode as "orchestrated", singleModel: "session",
      roles: { explore: { tier: "scout" }, plan: { tier: "conductor" } },
    },
    memory: { dir: "~", injectIndex: true },
    plans: { dir: "~" },
    hooks: { bash: [], paths: [], postEdit: { testCommandFile: "", enabled: false } },
    web: { timeoutMs: 1, maxBytes: 1 },
  });

  it("returns the 🎼 label in orchestrated mode", () => {
    expect(lineupLabel(cfg("orchestrated"), shortModelId)).toBe("🎼 sol ▸ mini");
  });

  it("returns undefined in non-orchestrated modes", () => {
    expect(lineupLabel(cfg("tiered"), shortModelId)).toBeUndefined();
    expect(lineupLabel(cfg("single"), shortModelId)).toBeUndefined();
  });
});

describe("loadoutToPatch", () => {
  it("produces a patch that re-establishes tiers, roles, and mode", () => {
    const l: Loadout = { modelMode: "tiered", singleModel: "session", tiers: { scout: { model: "a/b" } }, roles: { explore: "scout" } };
    const patch = loadoutToPatch(l);
    expect(patch.tiers).toEqual({ scout: { model: "a/b" } });
    expect(patch.agents).toEqual({ modelMode: "tiered", singleModel: "session", roles: { explore: { tier: "scout" } } });
  });

  it("defaults singleModel to 'session' when undefined", () => {
    const l: Loadout = { modelMode: "single", singleModel: undefined, tiers: {}, roles: {} };
    expect((loadoutToPatch(l).agents as { singleModel: string }).singleModel).toBe("session");
  });
});

describe("resolveCheapestModel", () => {
  it("picks the lowest blended-price model (input weighted 3:1 over output)", () => {
    const registry = {
      getAvailable: () => [
        { provider: "a", id: "expensive", cost: { input: 10, output: 30 } },
        { provider: "b", id: "cheap", cost: { input: 1, output: 5 } },
        { provider: "c", id: "mid", cost: { input: 5, output: 10 } },
      ],
    };
    expect(resolveCheapestModel(registry)?.id).toBe("b/cheap");
  });

  it("skips models with no pricing (both rates 0)", () => {
    const registry = {
      getAvailable: () => [
        { provider: "local", id: "free", cost: { input: 0, output: 0 } },
        { provider: "a", id: "priced", cost: { input: 2, output: 2 } },
      ],
    };
    expect(resolveCheapestModel(registry)?.id).toBe("a/priced");
  });

  it("returns undefined when nothing is priced", () => {
    expect(resolveCheapestModel({ getAvailable: () => [{ provider: "local", id: "free", cost: { input: 0, output: 0 } }] })).toBeUndefined();
  });

  it("returns undefined on getAvailable throw", () => {
    expect(resolveCheapestModel({ getAvailable: () => { throw new Error("boom"); } })).toBeUndefined();
  });
});
