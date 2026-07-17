/**
 * Code-intel service: builds/refreshes the incremental index and answers
 * queries. Read-only with respect to the analyzed project — the only writes
 * go to the cache directory under ~/.pi/agent/cache/code-intelligence/.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_CACHE_ROOT, cacheDirFor, loadSnapshot, saveSnapshot } from "./cache.ts";
import { dependenciesOf, dependentsOf, gitChurn, hotspots } from "./graph.ts";
import { listSourceFiles, parseFile } from "./indexer.ts";
import { INDEX_VERSION, type DependencyHop, type HotspotEntry, type IndexSnapshot, type IndexStats } from "./types.ts";

export interface CodeIntelOptions {
  cacheRoot?: string;
  maxFiles?: number;
  preferTs?: boolean;
}

export class CodeIntelService {
  private snapshots = new Map<string, { snapshot: IndexSnapshot; stats: IndexStats }>();
  private readonly cacheRoot: string;
  private readonly maxFiles: number;
  private readonly preferTs: boolean;

  constructor(options: CodeIntelOptions = {}) {
    this.cacheRoot = options.cacheRoot ?? DEFAULT_CACHE_ROOT;
    this.maxFiles = options.maxFiles ?? 20_000;
    this.preferTs = options.preferTs ?? true;
  }

  /** Build or incrementally refresh the index for a project. */
  async ensureIndex(project: string, force = false): Promise<{ snapshot: IndexSnapshot; stats: IndexStats }> {
    const projectAbs = resolve(project);
    const startedAt = Date.now();
    const previous = force ? undefined : this.snapshots.get(projectAbs)?.snapshot ?? loadSnapshot(projectAbs, this.cacheRoot);
    const files = listSourceFiles(projectAbs, this.maxFiles);
    const existsCache = new Map<string, boolean>();
    const exists = (p: string): boolean => {
      let hit = existsCache.get(p);
      if (hit === undefined) {
        hit = existsSync(p);
        existsCache.set(p, hit);
      }
      return hit;
    };
    const snapshot: IndexSnapshot = { version: INDEX_VERSION, project: projectAbs, builtAt: startedAt, parser: "regex", files: {} };
    let reused = 0;
    let reparsed = 0;
    let sawTs = false;
    for (const fileAbs of files) {
      const rel = fileAbs.slice(projectAbs.length + 1).split("\\").join("/");
      const prev = previous?.files[rel];
      let st;
      try {
        st = statSync(fileAbs);
      } catch {
        continue; // deleted mid-scan
      }
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
        snapshot.files[rel] = prev;
        reused++;
        continue;
      }
      try {
        const { entry, parser } = await parseFile(projectAbs, fileAbs, this.preferTs, exists);
        snapshot.files[entry.path] = entry;
        if (parser === "typescript") sawTs = true;
        reparsed++;
      } catch {
        // unreadable/binary-ish file — skip rather than fail the index
      }
    }
    snapshot.parser = sawTs || (reparsed === 0 && previous?.parser === "typescript") ? "typescript" : "regex";
    const stats: IndexStats = {
      files: Object.keys(snapshot.files).length,
      edges: Object.values(snapshot.files).reduce((n, f) => n + f.imports.length, 0),
      packages: new Set(Object.values(snapshot.files).flatMap((f) => f.packages)).size,
      builtAt: startedAt,
      buildMs: Date.now() - startedAt,
      parser: snapshot.parser,
      reusedFromCache: reused,
      reparsed,
      cachePath: cacheDirFor(projectAbs, this.cacheRoot),
    };
    try {
      saveSnapshot(snapshot, this.cacheRoot);
    } catch {
      // cache write failure is non-fatal — queries still work in-memory
    }
    this.snapshots.set(projectAbs, { snapshot, stats });
    return { snapshot, stats };
  }

  /** Normalize a user-supplied path to an indexed file (accepts absolute,
   *  project-relative, or unique suffix matches). */
  resolvePath(snapshot: IndexSnapshot, input: string): string | { error: string; suggestions: string[] } {
    const norm = input.replace(/\\/g, "/").replace(/^\.\//, "");
    if (snapshot.files[norm]) return norm;
    const abs = resolve(snapshot.project, norm);
    const rel = abs.startsWith(snapshot.project) ? abs.slice(snapshot.project.length + 1).replace(/\\/g, "/") : undefined;
    if (rel && snapshot.files[rel]) return rel;
    const matches = Object.keys(snapshot.files).filter((p) => p.endsWith(norm) || p.includes(norm));
    if (matches.length === 1) return matches[0];
    return {
      error: matches.length ? `ambiguous path "${input}"` : `"${input}" is not in the index`,
      suggestions: matches.slice(0, 8),
    };
  }

  async dependencies(project: string, path: string, depth = 3): Promise<{ target?: string; hops?: DependencyHop[]; error?: string; suggestions?: string[] }> {
    const { snapshot } = await this.ensureIndex(project);
    const resolved = this.resolvePath(snapshot, path);
    if (typeof resolved !== "string") return resolved;
    return { target: resolved, hops: dependenciesOf(snapshot, resolved, depth) };
  }

  async dependents(project: string, path: string, depth = 3): Promise<{ target?: string; hops?: DependencyHop[]; error?: string; suggestions?: string[] }> {
    const { snapshot } = await this.ensureIndex(project);
    const resolved = this.resolvePath(snapshot, path);
    if (typeof resolved !== "string") return resolved;
    return { target: resolved, hops: dependentsOf(snapshot, resolved, depth) };
  }

  async hotspots(project: string, limit = 20): Promise<HotspotEntry[]> {
    const { snapshot } = await this.ensureIndex(project);
    return hotspots(snapshot, gitChurn(snapshot.project), limit);
  }

  async status(project: string, force = false): Promise<IndexStats> {
    return (await this.ensureIndex(project, force)).stats;
  }
}
