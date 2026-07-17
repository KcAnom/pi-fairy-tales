import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { extractSpecifiersRegex, listSourceFiles, resolveSpecifier } from "../code-intel/indexer.ts";
import { dependenciesOf, dependentsOf, hotspots } from "../code-intel/graph.ts";
import { CodeIntelService } from "../code-intel/service.ts";

function project() {
  const root = mkdtempSync(join(tmpdir(), "fairy-intel-"));
  const cacheRoot = mkdtempSync(join(tmpdir(), "fairy-intel-cache-"));
  const write = (rel: string, content: string) => {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  };
  return { root, cacheRoot, write, close: () => { rmSync(root, { recursive: true, force: true }); rmSync(cacheRoot, { recursive: true, force: true }); } };
}

function seed(p: ReturnType<typeof project>) {
  p.write("src/util.ts", "export const x = 1;\n");
  p.write("src/store.ts", 'import { x } from "./util.ts";\nimport sqlite from "node:sqlite";\nexport const s = x;\n');
  p.write("src/app.ts", 'import { s } from "./store.ts";\nimport React from "react";\nconst lazy = import("./util.ts");\n');
  p.write("extensions/main.ts", 'import { s } from "../src/store.ts";\nconst legacy = require("../src/util");\n');
  p.write("node_modules/pkg/index.ts", 'import "should-never-be-indexed";\n');
  p.write("dist/out.js", 'import "also-skipped";\n');
}

test("regex extractor catches import/export-from/dynamic/require forms", () => {
  const specs = extractSpecifiersRegex([
    'import a from "./a.ts";',
    'import { b } from "../b";',
    'export { c } from "./c/index.js";',
    'export * from "./d";',
    'const e = require("pkg-e");',
    'const f = await import("@scope/f/deep");',
    'import "node:fs";',
    "// import \"./commented\"; — still matches, acceptable overcount",
  ].join("\n"));
  for (const expected of ["./a.ts", "../b", "./c/index.js", "./d", "pkg-e", "@scope/f/deep", "node:fs"]) {
    assert.ok(specs.includes(expected), `missing ${expected}`);
  }
});

test("resolver handles extensions, index files, and js→ts swaps; skips escapes", () => {
  const p = project();
  try {
    seed(p);
    const from = join(p.root, "src", "app.ts");
    assert.equal(resolveSpecifier(from, "./store.ts", p.root, existsSync), "src/store.ts");
    assert.equal(resolveSpecifier(from, "./store", p.root, existsSync), "src/store.ts");
    assert.equal(resolveSpecifier(from, "./store.js", p.root, existsSync), "src/store.ts");
    assert.equal(resolveSpecifier(from, "react", p.root, existsSync), undefined);
    assert.equal(resolveSpecifier(from, "../../outside.ts", p.root, existsSync), undefined);
  } finally { p.close(); }
});

test("indexes a project: graph queries, skip dirs, incremental cache reuse", async () => {
  const p = project();
  try {
    seed(p);
    const service = new CodeIntelService({ cacheRoot: p.cacheRoot, preferTs: false });
    const first = await service.status(p.root);
    assert.equal(first.files, 4); // node_modules and dist skipped
    assert.ok(first.edges >= 4);
    assert.equal(first.reparsed, 4);
    assert.ok(first.cachePath.startsWith(p.cacheRoot));

    const { snapshot } = await service.ensureIndex(p.root);
    const deps = dependenciesOf(snapshot, "src/app.ts");
    assert.deepEqual(deps.map((h) => h.path).sort(), ["src/store.ts", "src/util.ts"]);
    const depsOfStore = dependenciesOf(snapshot, "src/store.ts", 1);
    assert.deepEqual(depsOfStore.map((h) => h.path), ["src/util.ts"]);

    const impact = dependentsOf(snapshot, "src/util.ts");
    assert.deepEqual(impact.map((h) => h.path).sort(), ["extensions/main.ts", "src/app.ts", "src/store.ts"]);
    const depthOne = dependentsOf(snapshot, "src/util.ts", 1);
    assert.ok(depthOne.every((h) => h.depth === 1));

    // Incremental: a second index run with no changes reuses everything.
    const service2 = new CodeIntelService({ cacheRoot: p.cacheRoot, preferTs: false });
    const second = await service2.status(p.root);
    assert.equal(second.reusedFromCache, 4);
    assert.equal(second.reparsed, 0);

    // Touch one file → only it reparses.
    const utilPath = join(p.root, "src/util.ts");
    writeFileSync(utilPath, "export const x = 2;\nexport const y = 3;\n");
    utimesSync(utilPath, new Date(), new Date(Date.now() + 5000));
    const third = await service2.status(p.root);
    assert.equal(third.reparsed, 1);
    assert.equal(third.reusedFromCache, 3);
  } finally { p.close(); }
});

test("hotspots rank the widely-imported file first", async () => {
  const p = project();
  try {
    seed(p);
    const service = new CodeIntelService({ cacheRoot: p.cacheRoot, preferTs: false });
    const { snapshot } = await service.ensureIndex(p.root);
    const top = hotspots(snapshot, new Map(), 10);
    assert.equal(top[0].path, "src/util.ts"); // fan-in 3
    assert.equal(top[0].fanIn, 3);
    const store = top.find((h) => h.path === "src/store.ts")!;
    assert.equal(store.fanIn, 2);
    assert.equal(store.fanOut, 1);
  } finally { p.close(); }
});

test("resolvePath accepts suffixes and reports ambiguity with suggestions", async () => {
  const p = project();
  try {
    seed(p);
    p.write("src/other/util.ts", "export const z = 1;\n");
    const service = new CodeIntelService({ cacheRoot: p.cacheRoot, preferTs: false });
    const { snapshot } = await service.ensureIndex(p.root);
    assert.equal(service.resolvePath(snapshot, "src/app.ts"), "src/app.ts");
    assert.equal(service.resolvePath(snapshot, "./src/app.ts"), "src/app.ts");
    assert.equal(service.resolvePath(snapshot, "app.ts"), "src/app.ts");
    const ambiguous = service.resolvePath(snapshot, "util.ts");
    assert.ok(typeof ambiguous === "object");
    if (typeof ambiguous === "object") {
      assert.match(ambiguous.error, /ambiguous/);
      assert.equal(ambiguous.suggestions.length, 2);
    }
    const missing = service.resolvePath(snapshot, "nope.ts");
    assert.ok(typeof missing === "object" && /not in the index/.test(missing.error));
  } finally { p.close(); }
});

test("never writes inside the analyzed project", async () => {
  const p = project();
  try {
    seed(p);
    const before = listSourceFiles(p.root, 1000).length;
    const service = new CodeIntelService({ cacheRoot: p.cacheRoot, preferTs: false });
    await service.status(p.root);
    await service.hotspots(p.root, 5);
    const rootEntries = readdirSync(p.root).sort();
    assert.deepEqual(rootEntries, ["dist", "extensions", "node_modules", "src"]);
    assert.equal(listSourceFiles(p.root, 1000).length, before);
  } finally { p.close(); }
});
