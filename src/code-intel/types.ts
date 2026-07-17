/** Shared types for the read-only codebase intelligence index. */

export interface FileEntry {
  /** Project-relative path with forward slashes. */
  path: string;
  mtimeMs: number;
  size: number;
  loc: number;
  /** Project-relative resolved import targets (external packages excluded). */
  imports: string[];
  /** External package specifiers (deduped, subpaths collapsed to the package). */
  packages: string[];
}

export interface IndexSnapshot {
  version: number;
  project: string;
  builtAt: number;
  /** "typescript" when the TS compiler API parsed sources, else "regex". */
  parser: "typescript" | "regex";
  files: Record<string, FileEntry>;
}

export interface DependencyHop {
  path: string;
  depth: number;
  /** The file on the previous hop that links here. */
  via?: string;
}

export interface HotspotEntry {
  path: string;
  /** Direct dependents (fan-in). */
  fanIn: number;
  /** Direct dependencies (fan-out). */
  fanOut: number;
  loc: number;
  /** Commits touching the file (best-effort git; 0 when unavailable). */
  churn: number;
  /** Combined ranking score. */
  score: number;
}

export interface IndexStats {
  files: number;
  edges: number;
  packages: number;
  builtAt: number;
  buildMs: number;
  parser: "typescript" | "regex";
  reusedFromCache: number;
  reparsed: number;
  cachePath: string;
}

export const INDEX_VERSION = 1;

/** Extensions the indexer scans and resolves, in resolution priority order. */
export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

export const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".turbo",
  ".cache", "vendor", "target", ".venv", "venv", "__pycache__", ".pi",
]);
