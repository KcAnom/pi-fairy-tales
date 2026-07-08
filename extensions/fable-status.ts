/**
 * fable-status: one footer segment with live session vitals.
 *   <model> · ctx N% · $X.XX · ⚡N agents
 * Cost aggregates main-session assistant messages plus fable:cost:add events
 * emitted by the subagent engine.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isNested } from "../src/config.ts";
import { AGENTS_STATUS, COST_ADD, type AgentsStatusPayload, type CostAddPayload } from "../src/bus.ts";
import { fmtUsd } from "../src/text.ts";

export default function (pi: ExtensionAPI) {
  if (isNested()) return; // no UI inside subagents

  let modelName = "";
  let contextPct: number | undefined;
  let costUsd = 0;
  let runningAgents = 0;
  let render: (() => void) | undefined;

  const update = (ctx: { ui: { setStatus(key: string, text?: string): void }; hasUI: boolean }) => {
    if (!ctx.hasUI) return;
    const parts: string[] = [];
    if (modelName) parts.push(modelName);
    if (contextPct !== undefined) parts.push(`ctx ${contextPct}%`);
    parts.push(fmtUsd(costUsd));
    if (runningAgents > 0) parts.push(`⚡${runningAgents} agent${runningAgents > 1 ? "s" : ""}`);
    ctx.ui.setStatus("fable", parts.join(" · "));
  };

  pi.on("session_start", async (_event, ctx) => {
    modelName = (ctx.model as { id?: string } | undefined)?.id ?? "";
    render = () => update(ctx);
    update(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    modelName = (event.model as { id?: string } | undefined)?.id ?? "";
    update(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    const msg = event.message as { role?: string; usage?: { cost?: { total?: number } } };
    if (msg.role === "assistant" && msg.usage?.cost?.total) {
      costUsd += msg.usage.cost.total;
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
