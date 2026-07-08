/**
 * Fable config: shipped defaults (fable.config.json in this package) deep-merged with
 * ~/.pi/agent/fable.json (user) and <cwd>/.pi/fable.json (project). Later wins.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface TierConfig {
  model: string; // "provider/model-id"
  thinkingLevel?: string;
}

export interface RoleConfig {
  tier: string;
  tools: string[];
  description?: string;
  promptAppend?: string;
}

export interface BashRule {
  pattern: string;
  action: "block" | "confirm";
  reason?: string;
}

export interface PathRule {
  glob: string;
  action: "block" | "confirm";
  reason?: string;
}

export interface FableConfig {
  tiers: Record<string, TierConfig>;
  agents: {
    maxConcurrent: number;
    maxTurnsPerRun: number;
    maxCostPerRunUsd: number;
    roles: Record<string, RoleConfig>;
  };
  memory: { dir: string; injectIndex: boolean };
  plans: { dir: string };
  hooks: {
    bash: BashRule[];
    paths: PathRule[];
    postEdit: { testCommandFile: string; enabled: boolean; timeoutMs?: number };
  };
  web: { timeoutMs: number; maxBytes: number };
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function deepMerge<T>(base: T, override: Partial<T> | undefined): T {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override as T;
  if (typeof base === "object" && base !== null && typeof override === "object") {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
      out[k] = k in out ? deepMerge(out[k], v as never) : v;
    }
    return out as T;
  }
  return override as T;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    // A malformed override file must not brick pi; caller surfaces via diagnostics.
    loadDiagnostics.push(`fable config: failed to parse ${path}: ${String(err)}`);
    return undefined;
  }
}

export const loadDiagnostics: string[] = [];

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function loadFableConfig(cwd: string): FableConfig {
  loadDiagnostics.length = 0;
  const defaults = readJson(join(packageRoot, "fable.config.json")) as unknown as FableConfig;
  const user = readJson(join(homedir(), ".pi", "agent", "fable.json"));
  const project = readJson(join(cwd, ".pi", "fable.json"));
  return deepMerge(deepMerge(defaults, user as Partial<FableConfig>), project as Partial<FableConfig>);
}

/**
 * Resolve a tier name to a Model via the session's model registry.
 * Returns undefined when the tier or model is unknown — callers fall back to ctx.model.
 */
export function resolveTierModel(
  modelRegistry: { find(provider: string, id: string): unknown },
  cfg: FableConfig,
  tierName: string,
): { model: unknown; thinkingLevel: string | undefined } | undefined {
  const tier = cfg.tiers?.[tierName];
  if (!tier?.model) return undefined;
  const slash = tier.model.indexOf("/");
  if (slash <= 0) return undefined;
  const provider = tier.model.slice(0, slash);
  const id = tier.model.slice(slash + 1);
  const model = modelRegistry.find(provider, id);
  if (!model) return undefined;
  return { model, thinkingLevel: tier.thinkingLevel };
}

/** True when this extension instance is running inside a fable subagent. */
export function isNested(): boolean {
  return ((globalThis as Record<string, unknown>).__fableDepth as number | undefined ?? 0) > 0;
}
