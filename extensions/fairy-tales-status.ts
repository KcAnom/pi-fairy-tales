/**
 * fairy-tales-status: one footer segment with live session vitals.
 *   <model> · ctx N% · $X.XX · ⚡N agents
 * Cost aggregates main-session assistant messages plus fairy-tales:cost:add events
 * emitted by the subagent engine.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isNested, lineupLabel, loadFairyTalesConfig, loadDiagnostics, resolveTierModel } from "../src/config.ts";
import { AGENTS_STATUS, COST_ADD, type AgentsStatusPayload, type CostAddPayload } from "../src/bus.ts";
import { fmtUsd, shortModelId } from "../src/text.ts";
import { estimateCostUsd } from "../src/util.ts";

// The enchanted footer (ftales only) owns the vitals; the plain status segment
// stands down so the two never compute cost/agents independently and disagree.
const FOOTER_OWNS_VITALS = process.env.FTALES === "1";

export default function (pi: ExtensionAPI) {
  if (isNested()) return; // no UI inside subagents

  let modelName = "";
  let contextPct: number | undefined;
  let costUsd = 0;
  let runningAgents = 0;
  let render: (() => void) | undefined;

  const update = (ctx: { ui: { setStatus(key: string, text?: string): void }; hasUI: boolean }) => {
    if (!ctx.hasUI || FOOTER_OWNS_VITALS) return;
    const parts: string[] = [];
    const lineup = lineupLabel(loadFairyTalesConfig(process.cwd()), shortModelId);
    if (lineup) parts.push(lineup);
    else if (modelName) parts.push(modelName);
    if (contextPct !== undefined) parts.push(`ctx ${contextPct}%`);
    parts.push(fmtUsd(costUsd));
    if (runningAgents > 0) parts.push(`⚡${runningAgents} agent${runningAgents > 1 ? "s" : ""}`);
    ctx.ui.setStatus("fairy-tales", parts.join(" · "));
  };

  pi.on("session_start", async (_event, ctx) => {
    modelName = (ctx.model as { id?: string } | undefined)?.id ?? "";
    render = () => update(ctx);
    update(ctx);
    // Surface config problems (unknown tier, dropped guard, parse error) once.
    const cfg = loadFairyTalesConfig(ctx.cwd);
    if (ctx.hasUI && loadDiagnostics.length) {
      for (const d of loadDiagnostics.slice(0, 4)) ctx.ui.notify(`⚠ fairy-tales config: ${d}`, "warning");
    }
    // Warn when tier models this session would actually use don't resolve — that
    // work silently falls back (scout → cheapest priced model, other tiers → the
    // session model), which is the #1 hidden token cost.
    if (ctx.hasUI) {
      const referenced = new Set<string>();
      if (cfg.agents?.modelMode === "tiered") {
        for (const role of Object.values(cfg.agents.roles ?? {})) referenced.add(role.tier);
      }
      if (cfg.compaction?.tier) referenced.add(cfg.compaction.tier);
      const unresolved = [...referenced].filter(
        (t) => cfg.tiers?.[t]?.model && !resolveTierModel(ctx.modelRegistry, cfg, t),
      );
      if (unresolved.length) {
        ctx.ui.notify(
          `⚠ fairy-tales: tier model${unresolved.length > 1 ? "s" : ""} not available: ${unresolved
            .map((t) => `${t} (${cfg.tiers[t].model})`)
            .join(", ")} — run /agent-model to pick from your models`,
          "warning",
        );
      }
    }
  });

  pi.on("model_select", async (event, ctx) => {
    modelName = (event.model as { id?: string } | undefined)?.id ?? "";
    update(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    const msg = event.message as {
      role?: string;
      usage?: { cost?: { total?: number }; input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    };
    if (msg.role === "assistant" && msg.usage) {
      const reported = msg.usage.cost?.total ?? 0;
      costUsd +=
        reported > 0
          ? reported
          : estimateCostUsd(msg.usage.input ?? 0, msg.usage.output ?? 0, msg.usage.cacheRead ?? 0, msg.usage.cacheWrite ?? 0);
      update(ctx);
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    const usage = ctx.getContextUsage();
    if (usage?.percent !== null && usage?.percent !== undefined) {
      contextPct = Math.round(usage.percent);
    }
    update(ctx);
  });

  pi.events.on(COST_ADD, (data: CostAddPayload) => {
    costUsd += data?.usd ?? 0;
    render?.();
  });

  pi.events.on(AGENTS_STATUS, (data: AgentsStatusPayload) => {
    runningAgents = (data?.running ?? []).filter((r) => r.state === "running").length;
    render?.();
  });
}
