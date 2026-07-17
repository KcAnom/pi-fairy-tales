/**
 * Dependency graph queries over an IndexSnapshot: forward dependencies,
 * reverse impact (dependents), and hotspot ranking. Pure functions — no I/O
 * except the optional git-churn probe, which reads (never writes) the repo.
 */
import { execFileSync } from "node:child_process";
import type { DependencyHop, HotspotEntry, IndexSnapshot } from "./types.ts";

export function buildReverse(snapshot: IndexSnapshot): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const [path, entry] of Object.entries(snapshot.files)) {
    for (const dep of entry.imports) {
      const list = reverse.get(dep);
      if (list) list.push(path);
      else reverse.set(dep, [path]);
    }
  }
  return reverse;
}

function traverse(start: string, next: (p: string) => string[], maxDepth: number, limit: number): DependencyHop[] {
  const seen = new Set<string>([start]);
  const out: DependencyHop[] = [];
  let frontier: DependencyHop[] = [{ path: start, depth: 0 }];
  while (frontier.length && out.length < limit) {
    const upcoming: DependencyHop[] = [];
    for (const hop of frontier) {
      if (hop.depth >= maxDepth) continue;
      for (const n of next(hop.path)) {
        if (seen.has(n)) continue;
        seen.add(n);
        const entry = { path: n, depth: hop.depth + 1, via: hop.path };
        out.push(entry);
        upcoming.push(entry);
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
    frontier = upcoming;
  }
  return out;
}

/** Transitive imports of a file (what it depends on). */
export function dependenciesOf(snapshot: IndexSnapshot, path: string, maxDepth = 3, limit = 200): DependencyHop[] {
  return traverse(path, (p) => snapshot.files[p]?.imports ?? [], maxDepth, limit);
}

/** Transitive dependents of a file (reverse impact: what breaks if it changes). */
export function dependentsOf(snapshot: IndexSnapshot, path: string, maxDepth = 3, limit = 200): DependencyHop[] {
  const reverse = buildReverse(snapshot);
  return traverse(path, (p) => reverse.get(p) ?? [], maxDepth, limit);
}

/** Best-effort git churn: commits touching each file. Read-only; empty on
 *  non-git projects or any git failure. */
export function gitChurn(project: string, maxCommits = 500): Map<string, number> {
  const churn = new Map<string, number>();
  try {
    const out = execFileSync(
      "git",
      ["log", `--max-count=${maxCommits}`, "--name-only", "--format="],
      { cwd: project, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    for (const line of out.split("\n")) {
      const path = line.trim();
      if (path) churn.set(path, (churn.get(path) ?? 0) + 1);
    }
  } catch {
    // not a git repo / git missing — churn stays empty
  }
  return churn;
}

/** Rank files by structural centrality and (when available) git churn. */
export function hotspots(snapshot: IndexSnapshot, churn: Map<string, number>, limit = 20): HotspotEntry[] {
  const reverse = buildReverse(snapshot);
  const entries: HotspotEntry[] = Object.entries(snapshot.files).map(([path, entry]) => {
    const fanIn = reverse.get(path)?.length ?? 0;
    const fanOut = entry.imports.length;
    const c = churn.get(path) ?? 0;
    // Fan-in dominates (widely-depended-on files are the risk surface);
    // churn multiplies it (hot AND central is the real hotspot); LOC is a
    // weak tiebreaker so giant hub files rank above tiny barrels.
    const score = (fanIn * 3 + fanOut) * (1 + Math.log1p(c)) + entry.loc / 1000;
    return { path, fanIn, fanOut, loc: entry.loc, churn: c, score: Math.round(score * 100) / 100 };
  });
  return entries.sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit));
}
