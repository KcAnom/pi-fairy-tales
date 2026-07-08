/**
 * Fairy-Tales config: shipped defaults (fairy-tales.config.json in this package) deep-merged with
 * ~/.pi/agent/fairy-tales.json (user) and <cwd>/.pi/fairy-tales.json (project). Later wins.
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

export interface FairyTalesConfig {
  tiers: Record<string, TierConfig>;
  agents: {
    maxConcurrent: number;
    maxTurnsPerRun: number;
    maxCostPerRunUsd: number;
    /** "tiered" = per-role tier models; "single" = every subagent uses singleModel */
    modelMode: "tiered" | "single";
    /** "session" = follow the lead session's current model, or "provider/model-id" */
    singleModel: string;
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
    loadDiagnostics.push(`fairy-tales config: failed to parse ${path}: ${String(err)}`);
    return undefined;
  }
}

export const loadDiagnostics: string[] = [];

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function loadFairyTalesConfig(cwd: string): FairyTalesConfig {
  loadDiagnostics.length = 0;
  const defaults = readJson(join(packageRoot, "fairy-tales.config.json")) as unknown as FairyTalesConfig;
  const user = readJson(join(homedir(), ".pi", "agent", "fairy-tales.json"));
  const project = readJson(join(cwd, ".pi", "fairy-tales.json"));
  return deepMerge(deepMerge(defaults, user as Partial<FairyTalesConfig>), project as Partial<FairyTalesConfig>);
}

/**
 * Resolve a tier name to a Model via the session's model registry.
 * Returns undefined when the tier or model is unknown — callers fall back to ctx.model.
 */
export function resolveTierModel(
  modelRegistry: { find(provider: string, id: string): unknown },
  cfg: FairyTalesConfig,
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

/** True when this extension instance is running inside a fairy-tales subagent. */
export function isNested(): boolean {
  return ((globalThis as Record<string, unknown>).__fairyTalesDepth as number | undefined ?? 0) > 0;
}

/**
 * Persist a partial config into the user override file (~/.pi/agent/fairy-tales.json),
 * deep-merged over whatever is already there. Used by /agent-model.
 */
export async function saveUserConfig(patch: Record<string, unknown>): Promise<string> {
  const { withFileMutationQueue } = await import("@earendil-works/pi-coding-agent");
  const { writeFile, mkdir } = await import("node:fs/promises");
  const path = join(homedir(), ".pi", "agent", "fairy-tales.json");
  await withFileMutationQueue(path, async () => {
    const current = readJson(path) ?? {};
    const next = deepMerge(current, patch as never);
    await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
    await writeFile(path, JSON.stringify(next, null, 2) + "\n", "utf-8");
  });
  return path;
}
