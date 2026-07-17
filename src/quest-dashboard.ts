/**
 * Quest dashboard: interactive overlay over the durable quest journal.
 *
 * Filters (all/active/failed/done/cancelled), incremental search, a detail
 * pane with durable per-attempt telemetry, and run/retry/cancel actions.
 * Rendering follows the bookOverlay conventions: the component returns
 * fully-composed lines and matches raw key sequences in handleInput (wheel
 * scroll arrives as synthetic j/k from the copy-on-select extension).
 * Pure helpers are exported for tests and for the headless text fallback.
 */
import { closeOverlay } from "./banner.ts";
import { fmtDuration, fmtTokens, fmtUsd, shortModelId } from "./text.ts";
import type { QuestRecord, QuestRunRecord, QuestStore } from "./quest-store.ts";

interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export const QUEST_FILTERS = ["all", "active", "failed", "done", "cancelled"] as const;
export type QuestFilter = (typeof QUEST_FILTERS)[number];

const ACTIVE_STATES = new Set(["queued", "running", "interrupted"]);

export function filterQuests(rows: QuestRecord[], filter: QuestFilter, search: string): QuestRecord[] {
  const bySearch = search.trim().toLowerCase();
  return rows.filter((q) => {
    if (filter === "active" && !ACTIVE_STATES.has(q.state)) return false;
    if (filter === "failed" && q.state !== "failed") return false;
    if (filter === "done" && q.state !== "done") return false;
    if (filter === "cancelled" && q.state !== "cancelled") return false;
    if (!bySearch) return true;
    return [q.id, q.name, q.role, q.task, q.state].some((s) => s.toLowerCase().includes(bySearch));
  });
}

const STATE_MARK: Record<string, string> = {
  queued: "☐",
  running: "◐",
  interrupted: "◭",
  done: "✓",
  failed: "✗",
  cancelled: "⊘",
};

/** One table line per quest (plain text; the overlay adds color). */
export function questRowText(q: QuestRecord, now = Date.now()): string {
  const mark = STATE_MARK[q.state] ?? "·";
  const age = fmtDuration(now - q.createdAt);
  const extras =
    (q.priority ? ` p${q.priority}` : "") +
    (q.retryAt && q.state === "queued" && q.retryAt > now ? ` retry ${fmtDuration(q.retryAt - now)}` : "") +
    (q.scheduledAt > now ? ` starts ${fmtDuration(q.scheduledAt - now)}` : "") +
    (q.dependsOn.length ? ` deps ${q.dependsOn.length}` : "");
  return `${mark} ${q.id} ${q.state.padEnd(11)} ${q.role.padEnd(8)} ${q.name} · a${q.attempts}/${q.maxAttempts} · ${age}${extras}`;
}

/** Headless/no-TUI fallback: the same dashboard as plain text. */
export function questTableText(rows: QuestRecord[], filter: QuestFilter = "all", search = ""): string {
  const visible = filterQuests(rows, filter, search);
  if (!visible.length) return "No quests match.";
  return visible.map((q) => questRowText(q)).join("\n");
}

export function questDetailLines(q: QuestRecord, runs: QuestRunRecord[], events: Array<{ event: string; at: number; data: unknown }>): string[] {
  const lines: string[] = [];
  lines.push(`task: ${q.task}`);
  if (q.context) lines.push(`context: ${q.context.slice(0, 300)}`);
  if (q.dependsOn.length) lines.push(`depends on: ${q.dependsOn.join(", ")}`);
  if (q.chain) lines.push(`chain: ${JSON.stringify(q.chain)}`);
  if (q.dedupeKey) lines.push(`dedupe: ${q.dedupeKey}${q.retainUntilConsumed ? q.consumedAt ? " · consumed" : " · retained" : ""}`);
  for (const r of runs.slice(0, 5)) {
    const dur = r.finishedAt ? fmtDuration(r.finishedAt - r.startedAt) : "…";
    lines.push(
      `attempt ${r.attempt}: ${r.outcome ?? "running"} · ${shortModelId(r.model ?? "?")}${r.tier ? ` [${r.tier}]` : ""} · t${r.turns} · ${fmtTokens(r.tokens)} tok · ${fmtUsd(r.costUsd)} · ${dur}${r.lastActivity ? ` · ${r.lastActivity}` : ""}`,
    );
  }
  const outcome = q.result ?? q.error;
  if (outcome) {
    lines.push(q.result ? "result:" : "error:");
    for (const l of outcome.split("\n").slice(0, 8)) lines.push(`  ${l.slice(0, 200)}`);
  }
  if (events.length) {
    lines.push("events:");
    for (const e of events.slice(0, 6)) lines.push(`  ${new Date(e.at).toISOString()} ${e.event}`);
  }
  return lines;
}

export interface QuestDashboardActions {
  /** Claim + dispatch this quest now. Return an error message, or undefined on success. */
  run?: (id: string) => string | undefined;
  /** Requeue a failed/cancelled/interrupted quest. Return an error message, or undefined. */
  retry?: (id: string) => string | undefined;
  /** Cancel a queued/interrupted quest. Return an error message, or undefined. */
  cancel?: (id: string) => string | undefined;
}

export interface QuestDashboardOptions {
  tui: unknown;
  theme: ThemeLike;
  done: (v: undefined) => void;
  store: QuestStore;
  project: string;
  actions?: QuestDashboardActions;
  branded?: boolean;
  /** Injected for tests. */
  now?: () => number;
}

interface DashboardComponent {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
  dispose(): void;
  /** test hooks */
  readonly state: { filter: QuestFilter; search: string; searchMode: boolean; selected: number; detail: boolean; status?: string };
}

export function questDashboard(opts: QuestDashboardOptions): DashboardComponent {
  const { theme, store, project } = opts;
  const now = opts.now ?? Date.now;
  const state = {
    filter: "all" as QuestFilter,
    search: "",
    searchMode: false,
    selected: 0,
    offset: 0,
    detail: false,
    status: undefined as string | undefined,
  };

  // Live refresh: quests progress while the overlay is open.
  const refresh = setInterval(() => {
    try { (opts.tui as { requestRender?: (force?: boolean) => void }).requestRender?.(); } catch { /* torn down */ }
  }, 1000);
  (refresh as { unref?: () => void }).unref?.();

  const visibleRows = (): QuestRecord[] => {
    try {
      return filterQuests(store.list(project, 200), state.filter, state.search);
    } catch {
      return []; // store closing during teardown
    }
  };

  const viewport = () => Math.max(6, (process.stdout.rows ?? 24) - 12);

  const clampSelection = (rows: QuestRecord[]) => {
    state.selected = Math.max(0, Math.min(state.selected, rows.length - 1));
    const vp = viewport();
    if (state.selected < state.offset) state.offset = state.selected;
    if (state.selected >= state.offset + vp) state.offset = state.selected - vp + 1;
    state.offset = Math.max(0, Math.min(state.offset, Math.max(0, rows.length - vp)));
  };

  const act = (kind: keyof QuestDashboardActions, allowed: (q: QuestRecord) => boolean, verb: string) => {
    const rows = visibleRows();
    const q = rows[state.selected];
    if (!q) { state.status = "nothing selected"; return; }
    if (!allowed(q)) { state.status = `${q.id} is ${q.state} — cannot ${verb}`; return; }
    const fn = opts.actions?.[kind];
    if (!fn) { state.status = `${verb} is not available here`; return; }
    const err = fn(q.id);
    state.status = err ?? `${verb}: ${q.id} ✓`;
  };

  const close = () => {
    clearInterval(refresh);
    closeOverlay(opts.tui, opts.done);
  };

  return {
    state,
    invalidate() { /* stateless between renders */ },
    dispose() { clearInterval(refresh); },
    render(width: number): string[] {
      const rows = visibleRows();
      clampSelection(rows);
      const t = now();
      const lines: string[] = [];
      const title = opts.branded ? "❦ The Quest Ledger ❦" : "Quest Dashboard";
      const counts = `${rows.length} shown`;
      lines.push(theme.bold(theme.fg("accent", ` ${title}`)) + theme.fg("dim", `  ${counts}`));
      lines.push(
        QUEST_FILTERS.map((f) => (f === state.filter ? theme.fg("accent", `[${f}]`) : theme.fg("dim", ` ${f} `))).join(" ") +
          "  " +
          (state.searchMode
            ? theme.fg("warning", `/${state.search}▏`)
            : state.search
              ? theme.fg("text", `/${state.search}`)
              : theme.fg("dim", "/ to search")),
      );
      lines.push(theme.fg("dim", "─".repeat(Math.max(10, Math.min(width - 2, 100)))));
      if (!rows.length) {
        lines.push(theme.fg("muted", "  No quests match."));
      }
      const vp = viewport();
      for (let i = state.offset; i < Math.min(rows.length, state.offset + vp); i++) {
        const q = rows[i];
        const text = questRowText(q, t).slice(0, Math.max(20, width - 4));
        const colored =
          q.state === "failed" ? theme.fg("error", text)
          : q.state === "done" ? theme.fg("success", text)
          : q.state === "running" ? theme.fg("accent", text)
          : q.state === "cancelled" ? theme.fg("dim", text)
          : theme.fg("text", text);
        lines.push(i === state.selected ? theme.bold(` ▸ ${colored}`) : `   ${colored}`);
      }
      if (rows.length > vp) {
        lines.push(theme.fg("dim", `   … ${state.offset + 1}–${Math.min(rows.length, state.offset + vp)} of ${rows.length}`));
      }
      const sel = rows[state.selected];
      if (state.detail && sel) {
        lines.push(theme.fg("dim", "─".repeat(Math.max(10, Math.min(width - 2, 100)))));
        let runs: QuestRunRecord[] = [];
        let events: Array<{ event: string; at: number; data: unknown }> = [];
        try { runs = store.runs(sel.id, 5); events = store.events(sel.id, 6); } catch { /* closing */ }
        for (const l of questDetailLines(sel, runs, events)) lines.push(theme.fg("muted", `  ${l.slice(0, Math.max(20, width - 4))}`));
      }
      if (state.status) lines.push(theme.fg("warning", ` ${state.status}`));
      lines.push(
        theme.fg("dim", " ↑↓ select · ←→ filter · / search · ⏎ details · r run · R retry · x cancel · q close"),
      );
      return lines;
    },
    handleInput(data: string): void {
      state.status = undefined;
      if (state.searchMode) {
        if (data === "\x1b") { state.searchMode = false; state.search = ""; return; }
        if (data === "\r" || data === "\n") { state.searchMode = false; return; }
        if (data === "\x7f" || data === "\b") { state.search = state.search.slice(0, -1); return; }
        if (data.length === 1 && data >= " " && data !== "\x7f") { state.search += data; state.selected = 0; return; }
        return; // ignore navigation sequences while typing
      }
      const rows = visibleRows();
      switch (data) {
        case "\x1b[A": case "k": state.selected--; break;
        case "\x1b[B": case "j": state.selected++; break;
        case "\x1b[5~": state.selected -= viewport(); break;
        case "\x1b[6~": case " ": state.selected += viewport(); break;
        case "g": state.selected = 0; break;
        case "G": state.selected = rows.length - 1; break;
        case "\x1b[C": case "l": case "\t":
          state.filter = QUEST_FILTERS[(QUEST_FILTERS.indexOf(state.filter) + 1) % QUEST_FILTERS.length];
          state.selected = 0;
          break;
        case "\x1b[D": case "h":
          state.filter = QUEST_FILTERS[(QUEST_FILTERS.indexOf(state.filter) + QUEST_FILTERS.length - 1) % QUEST_FILTERS.length];
          state.selected = 0;
          break;
        case "/": state.searchMode = true; state.search = ""; break;
        case "\r": case "\n": state.detail = !state.detail; break;
        case "r": act("run", (q) => q.state === "queued" || q.state === "interrupted", "run"); break;
        case "R": act("retry", (q) => q.state === "failed" || q.state === "cancelled" || q.state === "interrupted", "retry"); break;
        case "x": act("cancel", (q) => q.state === "queued" || q.state === "interrupted", "cancel"); break;
        case "q": case "\x1b": close(); break;
        default: break; // unknown keys are ignored, not close — this overlay has real bindings
      }
      clampSelection(rows);
    },
  };
}
