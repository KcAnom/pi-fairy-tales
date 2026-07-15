/**
 * fairy-tales-ledger: /ledger — where the session's tokens actually went.
 * Breaks spend down by category (main conversation, subagents by role,
 * compaction summaries, /tale) with tokens, cost, and share bars, in the
 * same book overlay as /tale. Subagent totals rebuild from the session
 * branch on restart; compaction//tale spend is tracked live via COST_ADD.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isNested } from "../src/config.ts";
import { bookOverlay } from "../src/overlay.ts";
import { AGENTS_STATUS, COST_ADD, type AgentsStatusPayload, type CostAddPayload, type RunSummary } from "../src/bus.ts";
import { fmtTokens, fmtUsd } from "../src/text.ts";
import { estimateCostUsd } from "../src/util.ts";

interface Bucket {
  input: number;
  output: number;
  usd: number;
}

const emptyBucket = (): Bucket => ({ input: 0, output: 0, usd: 0 });

export default function (pi: ExtensionAPI) {
  if (isNested()) return;

  // Main-session usage, accumulated from assistant messages (rebuilt from the
  // branch on session_start so restarts don't zero the ledger).
  let main = emptyBucket();
  let mainCacheRead = 0;
  let mainCacheWrite = 0;
  // Subagent runs by id — live snapshots via AGENTS_STATUS, plus finished runs
  // recovered from agent tool results in the branch.
  const runs = new Map<string, RunSummary>();
  // Side sessions that report through COST_ADD with a source tag.
  const extras = new Map<string, Bucket>();

  const addUsage = (msg: {
    role?: string;
    usage?: { cost?: { total?: number }; input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  }) => {
    if (msg?.role !== "assistant" || !msg.usage) return;
    const u = msg.usage;
    main.input += u.input ?? 0;
    main.output += u.output ?? 0;
    mainCacheRead += u.cacheRead ?? 0;
    mainCacheWrite += u.cacheWrite ?? 0;
    main.usd +=
      (u.cost?.total ?? 0) ||
      estimateCostUsd(u.input ?? 0, u.output ?? 0, u.cacheRead ?? 0, u.cacheWrite ?? 0);
  };

  const recordRunDetails = (details: unknown) => {
    const d = details as Partial<RunSummary> | undefined;
    if (d && typeof d.id === "string" && typeof d.role === "string" && typeof d.costUsd === "number") {
      runs.set(d.id, d as RunSummary);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    main = emptyBucket();
    mainCacheRead = 0;
    mainCacheWrite = 0;
    runs.clear();
    extras.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = (entry as { message?: { role?: string; toolName?: string; usage?: never; details?: unknown } }).message;
      if (!msg) continue;
      if (msg.role === "assistant") addUsage(msg as never);
      if (msg.role === "toolResult" && (msg.toolName === "agent" || msg.toolName === "agent_control")) {
        recordRunDetails(msg.details);
      }
    }
  });

  pi.on("message_end", async (event) => {
    addUsage(event.message as never);
  });

  pi.events.on(AGENTS_STATUS, (data: unknown) => {
    for (const r of (data as AgentsStatusPayload)?.running ?? []) runs.set(r.id, r);
  });

  pi.events.on(COST_ADD, (data: unknown) => {
    const d = data as CostAddPayload;
    if (!d || d.source === "subagent") return; // subagents are tracked per run
    const key = d.source ?? "other";
    const b = extras.get(key) ?? emptyBucket();
    b.usd += d.usd ?? 0;
    b.input += d.inputTokens ?? 0;
    b.output += d.outputTokens ?? 0;
    extras.set(key, b);
  });

  pi.registerCommand("ledger", {
    description: "Show where this session's tokens and cost went",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      interface Row {
        label: string;
        input: number;
        output: number;
        usd: number;
        detail?: string[];
      }

      const rows: Row[] = [];
      rows.push({ label: "Main conversation", ...main });

      const allRuns = [...runs.values()];
      if (allRuns.length) {
        const spriteTotal = allRuns.reduce((s, r) => s + (r.costUsd ?? 0), 0);
        const detail = allRuns
          .slice()
          .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
          .slice(0, 12)
          .map(
            (r) =>
              `${r.role} · ${r.name} [${r.model}] · t${r.turns} · ${fmtTokens(r.tokens ?? 0)} tok · ${fmtUsd(r.costUsd ?? 0)}${
                r.state === "running" ? " (running)" : ""
              }`,
          );
        if (allRuns.length > 12) detail.push(`…and ${allRuns.length - 12} more (agent_control list)`);
        rows.push({
          label: `Subagents (${allRuns.length} run${allRuns.length > 1 ? "s" : ""})`,
          input: allRuns.reduce((s, r) => s + (r.tokens ?? 0), 0),
          output: 0,
          usd: spriteTotal,
          detail,
        });
      }

      const extraLabel: Record<string, string> = { compaction: "Compaction summaries", tale: "/tale narrator", other: "Other" };
      for (const [key, b] of extras) {
        rows.push({ label: extraLabel[key] ?? key, ...b });
      }

      const totalUsd = rows.reduce((s, r) => s + r.usd, 0);
      const totalIn = rows.reduce((s, r) => s + r.input, 0);
      const totalOut = rows.reduce((s, r) => s + r.output, 0);

      await ctx.ui.custom(
        (
          tui: unknown,
          theme: { fg(c: string, s: string): string; bold(s: string): string },
          _kb: unknown,
          done: (v: undefined) => void,
        ) => {
          const BAR = 20;
          const lines: string[] = [];
          for (const r of rows) {
            const share = totalUsd > 0 ? r.usd / totalUsd : 0;
            const filled = Math.round(share * BAR);
            const bar = theme.fg("accent", "█".repeat(filled)) + theme.fg("dim", "░".repeat(BAR - filled));
            const tok =
              r.output > 0
                ? `${fmtTokens(r.input)} in · ${fmtTokens(r.output)} out`
                : `${fmtTokens(r.input)} tok`;
            lines.push(
              `${theme.bold(r.label.padEnd(26))} ${theme.fg("muted", tok.padStart(18))}  ${fmtUsd(r.usd).padStart(7)}  ${bar} ${theme.fg(
                "dim",
                `${Math.round(share * 100)}%`.padStart(4),
              )}`,
            );
            for (const d of r.detail ?? []) lines.push(theme.fg("muted", `   ${d}`));
          }
          lines.push(theme.fg("dim", "─".repeat(60)));
          lines.push(
            `${theme.bold("Total".padEnd(26))} ${theme.fg("muted", `${fmtTokens(totalIn)} in · ${fmtTokens(totalOut)} out`.padStart(18))}  ${theme.bold(
              fmtUsd(totalUsd).padStart(7),
            )}`,
          );
          if (mainCacheRead > 0 || mainCacheWrite > 0) {
            const pct = main.input + mainCacheRead > 0 ? Math.round((mainCacheRead / (main.input + mainCacheRead)) * 100) : 0;
            lines.push("");
            lines.push(
              theme.fg(
                "muted",
                `Cache: ${fmtTokens(mainCacheRead)} read (${pct}% of main input, ~10× cheaper) · ${fmtTokens(mainCacheWrite)} written`,
              ),
            );
          }
          lines.push("");
          lines.push(theme.fg("dim", "Subagent token counts are totals across their turns; compaction and /tale rows reset on restart."));
          const title = process.env.FTALES === "1" ? "❦ The Token Ledger ❦" : "Token Ledger";
          return bookOverlay({ title, contentLines: lines, tui, theme, done });
        },
        { overlay: true, overlayOptions: { anchor: "center", width: "80%" } },
      );
    },
  });
}
