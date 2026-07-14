/**
 * Fairy-Tales config: shipped defaults (fairy-tales.config.json in this package) deep-merged with
 * ~/.pi/agent/fairy-tales.json (user) and <cwd>/.pi/fairy-tales.json (project). Later wins.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
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
    /** Appended onto (not replacing) the shipped bash rules — the safe way to add rules. */
    bashAppend?: BashRule[];
    /** Appended onto (not replacing) the shipped path rules. */
    pathsAppend?: PathRule[];
    postEdit: { testCommandFile: string; enabled: boolean; timeoutMs?: number };
  };
  web: { timeoutMs: number; maxBytes: number; blockPrivateHosts?: boolean };
  /** Optional compaction summarizer tier (falls back to the lead model). */
  compaction?: { tier?: string; proactiveAtPercent?: number };
  /** /ultraplan: background heavy planning → approval gate → worktree execution, always on the session model. */
  ultraplan?: {
    /** Parallel planning agents; >1 adds a synthesis pass that merges them into one plan. */
    planners: number;
    /** Isolate execution in a throwaway git worktree (leaves the working tree untouched). */
    worktree: boolean;
    /** Skip the approval gate and execute immediately after planning. */
    autoExecute: boolean;
    /** Role used for planning (read-only). */
    planRole: string;
    /** Role used for execution (edits/writes). */
    buildRole: string;
  };
  /** UI preferences + internal state persisted by the brand extension. */
  ui?: {
    previousTheme?: string;
    /** Toast when the system clipboard changes (drag-copy confirmation). Default true. */
    clipboardNotify?: boolean;
  };
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

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

interface CacheEntry {
  key: string;
  cfg: FairyTalesConfig;
  diagnostics: string[];
}
const cache = new Map<string, CacheEntry>();

/** Concatenate shipped defaults with `<name>Append` overrides for rule arrays. */
function applyAppends(cfg: FairyTalesConfig): void {
  const h = cfg.hooks;
  if (h?.bashAppend?.length) h.bash = [...(h.bash ?? []), ...h.bashAppend];
  if (h?.pathsAppend?.length) h.paths = [...(h.paths ?? []), ...h.pathsAppend];
}

/** Validate the merged config; push human-readable problems into `diagnostics`. */
function validate(cfg: FairyTalesConfig, defaults: FairyTalesConfig, diagnostics: string[]): void {
  const tierNames = new Set(Object.keys(cfg.tiers ?? {}));
  for (const [roleName, role] of Object.entries(cfg.agents?.roles ?? {})) {
    if (role.tier && !tierNames.has(role.tier)) {
      diagnostics.push(`role "${roleName}" references unknown tier "${role.tier}" (known: ${[...tierNames].join(", ")})`);
    }
  }
  const mode = cfg.agents?.modelMode;
  if (mode && mode !== "tiered" && mode !== "single") {
    diagnostics.push(`agents.modelMode "${mode}" is invalid (use "tiered" or "single")`);
  }
  const single = cfg.agents?.singleModel;
  if (mode === "single" && single && single !== "session" && !single.includes("/")) {
    diagnostics.push(`agents.singleModel "${single}" should be "session" or "provider/model-id"`);
  }
  // Warn if a wholesale bash-rule override dropped the shipped safety guards.
  const shippedGuards = (defaults.hooks?.bash ?? []).filter((r) => r.action === "block");
  const activePatterns = new Set((cfg.hooks?.bash ?? []).map((r) => r.pattern));
  for (const guard of shippedGuards) {
    if (!activePatterns.has(guard.pattern)) {
      diagnostics.push(
        `hooks.bash override dropped the shipped guard for ${guard.reason ?? guard.pattern} — use hooks.bashAppend to add rules without replacing defaults`,
      );
    }
  }
}

export function loadFairyTalesConfig(cwd: string): FairyTalesConfig {
  const userPath = join(homedir(), ".pi", "agent", "fairy-tales.json");
  const projectPath = join(cwd, ".pi", "fairy-tales.json");
  const defaultsPath = join(packageRoot, "fairy-tales.config.json");
  const key = [defaultsPath, userPath, projectPath].map(mtimeOf).join(":");

  const hit = cache.get(cwd);
  if (hit && hit.key === key) {
    loadDiagnostics.length = 0;
    loadDiagnostics.push(...hit.diagnostics);
    return hit.cfg;
  }

  loadDiagnostics.length = 0;
  const defaults = readJson(defaultsPath) as unknown as FairyTalesConfig;
  const user = readJson(userPath);
  const project = readJson(projectPath);
  const cfg = deepMerge(deepMerge(defaults, user as Partial<FairyTalesConfig>), project as Partial<FairyTalesConfig>);
  applyAppends(cfg);
  validate(cfg, defaults, loadDiagnostics);

  cache.set(cwd, { key, cfg, diagnostics: [...loadDiagnostics] });
  return cfg;
}

/** The role names available for the `agent` tool, derived from config. */
export function roleNames(cfg: FairyTalesConfig): string[] {
  return Object.keys(cfg.agents?.roles ?? {});
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

/**
 * Cheapest available model by blended price (input weighted 3:1 over output —
 * scout-style work is read-heavy). Models with no reported pricing (both rates 0,
 * e.g. local models) are skipped: zero can mean "unknown" and silently routing
 * work to a tiny local model is worse than the session-model fallback.
 * Returns undefined when nothing priced is available.
 */
export function resolveCheapestModel(modelRegistry: {
  getAvailable?(): Array<{ provider: string; id: string; cost?: { input?: number; output?: number } }>;
}): { model: unknown; id: string } | undefined {
  try {
    const models = modelRegistry.getAvailable?.() ?? [];
    let best: { model: unknown; id: string; price: number } | undefined;
    for (const m of models) {
      const input = m.cost?.input ?? 0;
      const output = m.cost?.output ?? 0;
      if (input <= 0 && output <= 0) continue;
      const price = input * 3 + output;
      if (!best || price < best.price) best = { model: m, id: `${m.provider}/${m.id}`, price };
    }
    return best ? { model: best.model, id: best.id } : undefined;
  } catch {
    return undefined;
  }
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
