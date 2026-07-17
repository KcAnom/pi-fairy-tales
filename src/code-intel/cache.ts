/**
 * Index cache, stored OUTSIDE analyzed projects (never write into a project):
 *   ~/.pi/agent/cache/code-intelligence/<sha256(projectPath)[:16]>/index.json
 * Incremental: unchanged files (same mtime + size) reuse their cached entry.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { INDEX_VERSION, type IndexSnapshot } from "./types.ts";

export const DEFAULT_CACHE_ROOT = join(homedir(), ".pi", "agent", "cache", "code-intelligence");

export function cacheDirFor(project: string, cacheRoot = DEFAULT_CACHE_ROOT): string {
  const key = createHash("sha256").update(project).digest("hex").slice(0, 16);
  return join(cacheRoot, key);
}

export function loadSnapshot(project: string, cacheRoot = DEFAULT_CACHE_ROOT): IndexSnapshot | undefined {
  try {
    const snapshot = JSON.parse(readFileSync(join(cacheDirFor(project, cacheRoot), "index.json"), "utf8")) as IndexSnapshot;
    if (snapshot.version !== INDEX_VERSION || snapshot.project !== project) return undefined;
    return snapshot;
  } catch {
    return undefined;
  }
}

export function saveSnapshot(snapshot: IndexSnapshot, cacheRoot = DEFAULT_CACHE_ROOT): string {
  const dir = cacheDirFor(snapshot.project, cacheRoot);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "index.json");
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(snapshot), "utf8");
  renameSync(tmp, path);
  return path;
}
