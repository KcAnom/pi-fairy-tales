/**
 * fairy-tales-code-intel: read-only codebase intelligence.
 *
 * Registers a `codebase_intel` tool over an incremental import-graph index:
 * dependency queries, reverse-impact traversal, hotspot ranking, and
 * index/cache status. The index cache lives OUTSIDE analyzed projects
 * (~/.pi/agent/cache/code-intelligence/) — this feature never writes inside
 * a project. Kill switch: codeIntel.enabled=false in fairy-tales config.
 */
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isNested, loadFairyTalesConfig } from "../src/config.ts";
import { CodeIntelService } from "../src/code-intel/service.ts";
import { fmtDuration } from "../src/text.ts";

export default function (pi: ExtensionAPI) {
  if (isNested()) return;

  const service = new CodeIntelService();

  pi.registerTool({
    name: "codebase_intel",
    label: "Codebase Intel",
    description:
      "Read-only codebase intelligence over the project's import graph. Actions: 'deps' lists what a file depends on (transitively, with depth); " +
      "'impact' lists everything that depends on a file — what could break if it changes; 'hotspots' ranks files by fan-in/fan-out/size/git-churn; " +
      "'status' builds or refreshes the index and reports stats. The index is cached outside the project and refreshes incrementally.",
    promptSnippet: "Query the project import graph (deps, impact, hotspots)",
    promptGuidelines: [
      "Before editing a widely-used file, run codebase_intel with action 'impact' on it to see the blast radius.",
      "Use codebase_intel 'hotspots' when exploring an unfamiliar codebase — the top entries are its load-bearing files.",
    ],
    parameters: Type.Object({
      action: StringEnum(["deps", "impact", "hotspots", "status"] as const),
      path: Type.Optional(Type.String({ description: "File path for deps/impact (project-relative, absolute, or a unique suffix)" })),
      depth: Type.Optional(Type.Integer({ description: "Traversal depth for deps/impact (default 3)" })),
      limit: Type.Optional(Type.Integer({ description: "Max results (default: 200 hops / 20 hotspots)" })),
      refresh: Type.Optional(Type.Boolean({ description: "For status: force a full rebuild instead of incremental refresh" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = loadFairyTalesConfig(ctx.cwd);
      if (cfg.codeIntel?.enabled === false) {
        return { content: [{ type: "text", text: "codebase_intel is disabled (codeIntel.enabled=false in fairy-tales config)." }], details: { disabled: true } };
      }

      if (params.action === "status") {
        const stats = await service.status(ctx.cwd, params.refresh ?? false);
        return {
          content: [{ type: "text", text:
            `Index: ${stats.files} files · ${stats.edges} internal edges · ${stats.packages} external packages\n` +
            `parser ${stats.parser} · built in ${fmtDuration(stats.buildMs)} (${stats.reusedFromCache} cached, ${stats.reparsed} reparsed)\n` +
            `cache ${stats.cachePath} (outside the project — nothing is written into analyzed repos)` }],
          details: { stats },
        };
      }

      if (params.action === "hotspots") {
        const top = await service.hotspots(ctx.cwd, params.limit ?? 20);
        const text = top.length
          ? top.map((h, i) => `${String(i + 1).padStart(2)}. ${h.path} · score ${h.score} · ${h.fanIn}⇠ ${h.fanOut}⇢ · ${h.loc} loc${h.churn ? ` · ${h.churn} commits` : ""}`).join("\n")
          : "No source files indexed.";
        return { content: [{ type: "text", text }], details: { hotspots: top } };
      }

      if (!params.path) throw new Error(`codebase_intel ${params.action} requires path`);
      const depth = Math.max(1, Math.min(params.depth ?? 3, 10));
      const result = params.action === "deps"
        ? await service.dependencies(ctx.cwd, params.path, depth)
        : await service.dependents(ctx.cwd, params.path, depth);
      if (result.error) {
        const sugg = result.suggestions?.length ? `\nDid you mean:\n${result.suggestions.map((s) => `  ${s}`).join("\n")}` : "";
        return { content: [{ type: "text", text: `${result.error}${sugg}` }], details: { error: result.error, suggestions: result.suggestions } };
      }
      const hops = (result.hops ?? []).slice(0, params.limit ?? 200);
      const label = params.action === "deps" ? "depends on" : "is depended on by";
      const text = hops.length
        ? `${result.target} ${label} ${hops.length} file(s) within depth ${depth}:\n` +
          hops.map((h) => `${"  ".repeat(h.depth)}${h.path}${h.via && h.depth > 1 ? ` (via ${h.via})` : ""}`).join("\n")
        : `${result.target} ${label} nothing within depth ${depth}.`;
      return { content: [{ type: "text", text }], details: { target: result.target, hops } };
    },
  });
}
