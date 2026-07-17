/**
 * Read-only source indexer: walks a project, extracts import edges, and
 * resolves relative specifiers to project files. Prefers the TypeScript
 * compiler API when it is resolvable (pi ships with TS in many setups) and
 * falls back to a regex scanner — the fallback covers ES import/export-from,
 * dynamic import(), and CommonJS require() forms. Never writes anything
 * inside the analyzed project.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { SKIP_DIRS, SOURCE_EXTENSIONS, type FileEntry } from "./types.ts";

/** Minimal structural slice of the TS compiler API we use — `typescript` is an
 *  optional runtime dependency, so its types can't be imported statically. */
interface TsNode { kind: number }
interface TsApi {
  createSourceFile(name: string, source: string, target: number, setParents: boolean): TsNode;
  ScriptTarget: { Latest: number };
  SyntaxKind: { ImportKeyword: number };
  forEachChild(node: TsNode, visit: (n: TsNode) => void): void;
  isImportDeclaration(n: TsNode): boolean;
  isExportDeclaration(n: TsNode): boolean;
  isStringLiteral(n: TsNode): boolean;
  isCallExpression(n: TsNode): boolean;
  isIdentifier(n: TsNode): boolean;
}
type TsModule = TsApi | undefined;

let tsPromise: Promise<TsModule> | undefined;
async function loadTypescript(): Promise<TsModule> {
  // @ts-ignore -- `typescript` is optional at runtime and absent from deps
  tsPromise ??= import(/* @vite-ignore */ "typescript").then(
    (m) => ((m as { default?: unknown }).default ?? m) as TsApi,
    () => undefined,
  );
  return tsPromise;
}

const isSource = (name: string) => SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)) && !name.endsWith(".d.ts");

/** Walk the project tree, collecting source files (bounded, skip-listed). */
export function listSourceFiles(project: string, maxFiles = 20_000): string[] {
  const rootAbs = resolve(project);
  const found: string[] = [];
  const stack = [rootAbs];
  while (stack.length && found.length < maxFiles) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip, never fail the index
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== "." ) {
        if (entry.isDirectory()) continue; // hidden dirs (incl. .git) skipped
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile() && isSource(entry.name)) {
        found.push(full);
        if (found.length >= maxFiles) break;
      }
    }
  }
  return found.sort();
}

const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s+(?:[\s\S]*?from\s+)?["']([^"'\n]+)["']|require\(\s*["']([^"'\n]+)["']\s*\)|import\(\s*["']([^"'\n]+)["']\s*\)/gm;

export function extractSpecifiersRegex(source: string): string[] {
  const specs = new Set<string>();
  for (const m of source.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) specs.add(spec);
  }
  return [...specs];
}

function extractSpecifiersTs(ts: TsApi, path: string, source: string): string[] {
  const specs = new Set<string>();
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false);
  const visit = (node: TsNode): void => {
    const n = node as TsNode & {
      moduleSpecifier?: TsNode & { text: string };
      expression?: TsNode & { text?: string };
      arguments?: Array<TsNode & { text: string }>;
    };
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      specs.add(n.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && n.expression) {
      const isDynamicImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(n.expression) && n.expression.text === "require";
      if ((isDynamicImport || isRequire) && n.arguments?.length && ts.isStringLiteral(n.arguments[0])) {
        specs.add(n.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...specs];
}

/** Resolve a relative specifier to a project-relative file path, or undefined. */
export function resolveSpecifier(fromAbs: string, spec: string, projectAbs: string, exists: (p: string) => boolean): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = resolve(fromAbs, "..", spec);
  const candidates = [base];
  // "./x.ts" style already-suffixed specifiers hit the first candidate; also
  // try swapping a .js suffix for TS sources (NodeNext import style).
  if (/\.(js|mjs|cjs|jsx)$/.test(base)) {
    candidates.push(base.replace(/\.(js|mjs|cjs|jsx)$/, (m) => ({ ".js": ".ts", ".mjs": ".mts", ".cjs": ".cts", ".jsx": ".tsx" })[m] ?? m));
  }
  for (const ext of SOURCE_EXTENSIONS) candidates.push(base + ext);
  for (const ext of SOURCE_EXTENSIONS) candidates.push(join(base, `index${ext}`));
  for (const c of candidates) {
    if (exists(c)) {
      const rel = relative(projectAbs, c);
      if (rel.startsWith("..")) return undefined; // escaped the project
      return rel.split(sep).join("/");
    }
  }
  return undefined;
}

function packageName(spec: string): string {
  if (spec.startsWith("node:")) return spec;
  const parts = spec.split("/");
  return spec.startsWith("@") && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
}

export interface ParseOutcome {
  entry: FileEntry;
}

/** Parse one file into a FileEntry. `exists` is injected for testability. */
export async function parseFile(
  projectAbs: string,
  fileAbs: string,
  preferTs: boolean,
  exists: (p: string) => boolean,
): Promise<{ entry: FileEntry; parser: "typescript" | "regex" }> {
  const st = statSync(fileAbs);
  const source = readFileSync(fileAbs, "utf8");
  const ts = preferTs ? await loadTypescript() : undefined;
  let specs: string[];
  let parser: "typescript" | "regex";
  if (ts) {
    try {
      specs = extractSpecifiersTs(ts, fileAbs, source);
      parser = "typescript";
    } catch {
      specs = extractSpecifiersRegex(source);
      parser = "regex";
    }
  } else {
    specs = extractSpecifiersRegex(source);
    parser = "regex";
  }
  const imports = new Set<string>();
  const packages = new Set<string>();
  for (const spec of specs) {
    const resolved = resolveSpecifier(fileAbs, spec, projectAbs, exists);
    if (resolved) imports.add(resolved);
    else if (!spec.startsWith(".")) packages.add(packageName(spec));
  }
  return {
    parser,
    entry: {
      path: relative(projectAbs, fileAbs).split(sep).join("/"),
      mtimeMs: st.mtimeMs,
      size: st.size,
      loc: source.split("\n").length,
      imports: [...imports].sort(),
      packages: [...packages].sort(),
    },
  };
}
