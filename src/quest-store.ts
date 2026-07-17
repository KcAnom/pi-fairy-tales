import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expandHome } from "./config.ts";

export type QuestState = "queued" | "running" | "done" | "failed" | "cancelled" | "interrupted";

export interface QuestRecord {
  id: string;
  project: string;
  role: string;
  name: string;
  task: string;
  context?: string;
  state: QuestState;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  agentRunId?: string;
  ownerSession?: string;
  result?: string;
  error?: string;
}

export interface QuestStoreOptions {
  path: string;
  maxHistory: number;
}

interface QuestRow {
  id: string;
  project: string;
  role: string;
  name: string;
  task: string;
  context: string | null;
  state: QuestState;
  attempts: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
  agent_run_id: string | null;
  owner_session: string | null;
  result: string | null;
  error: string | null;
}

function fromRow(row: QuestRow): QuestRecord {
  return {
    id: row.id,
    project: row.project,
    role: row.role,
    name: row.name,
    task: row.task,
    context: row.context ?? undefined,
    state: row.state,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    agentRunId: row.agent_run_id ?? undefined,
    ownerSession: row.owner_session ?? undefined,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
  };
}

/** Durable, provider-neutral queue and append-only event journal for agent work. */
export class QuestStore {
  readonly path: string;
  private db: DatabaseSync;

  constructor(private options: QuestStoreOptions) {
    this.path = resolve(expandHome(options.path));
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  health(): { path: string; integrity: string; queued: number; interrupted: number } {
    const integrity = (this.db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string })?.integrity_check ?? "unknown";
    const counts = this.db.prepare(
      "SELECT SUM(CASE WHEN state='queued' THEN 1 ELSE 0 END) queued, SUM(CASE WHEN state='interrupted' THEN 1 ELSE 0 END) interrupted FROM quests",
    ).get() as { queued?: number; interrupted?: number };
    return { path: this.path, integrity, queued: counts.queued ?? 0, interrupted: counts.interrupted ?? 0 };
  }

  enqueue(input: { project: string; role: string; name?: string; task: string; context?: string }): QuestRecord {
    const now = Date.now();
    const id = `q-${randomUUID().slice(0, 8)}`;
    const project = resolve(input.project);
    const name = input.name?.trim() || `${input.role} quest`;
    this.db.prepare(
      `INSERT INTO quests (id, project, role, name, task, context, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
    ).run(id, project, input.role, name, input.task, input.context ?? null, now, now);
    this.event(id, "enqueued", { role: input.role, name });
    this.prune();
    return this.get(id)!;
  }

  get(id: string): QuestRecord | undefined {
    const row = this.db.prepare("SELECT * FROM quests WHERE id = ?").get(id) as QuestRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(project: string, limit = 30): QuestRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM quests WHERE project = ? ORDER BY created_at DESC LIMIT ?",
    ).all(resolve(project), Math.max(1, Math.min(limit, 200))) as unknown as QuestRow[];
    return rows.map(fromRow);
  }

  claimNext(project: string, ownerSession = "legacy"): QuestRecord | undefined {
    const normalized = resolve(project);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(
        "SELECT id FROM quests WHERE project = ? AND state IN ('queued','interrupted') ORDER BY created_at ASC LIMIT 1",
      ).get(normalized) as { id?: string } | undefined;
      if (!row?.id) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const now = Date.now();
      this.db.prepare(
        "UPDATE quests SET state='running', attempts=attempts+1, started_at=?, finished_at=NULL, updated_at=?, error=NULL, owner_session=?, agent_run_id=NULL WHERE id=?",
      ).run(now, now, ownerSession, row.id);
      this.event(row.id, "claimed", {});
      this.db.exec("COMMIT");
      return this.get(row.id);
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  attachRun(id: string, ownerSession: string, agentRunId: string): boolean {
    const changed = Number(this.db.prepare(
      "UPDATE quests SET agent_run_id=?, updated_at=? WHERE id=? AND state='running' AND owner_session=? AND agent_run_id IS NULL",
    ).run(agentRunId, Date.now(), id, ownerSession).changes) > 0;
    if (changed) this.event(id, "agent_started", { agentRunId });
    return changed;
  }

  complete(id: string, ownerSession: string, agentRunId: string, result: string): boolean {
    const now = Date.now();
    const changed = Number(this.db.prepare(
      "UPDATE quests SET state='done', result=?, error=NULL, finished_at=?, updated_at=? WHERE id=? AND state='running' AND owner_session=? AND agent_run_id=?",
    ).run(result, now, now, id, ownerSession, agentRunId).changes) > 0;
    if (changed) this.event(id, "completed", {});
    return changed;
  }

  fail(id: string, ownerSession: string, error: string, agentRunId?: string): boolean {
    const now = Date.now();
    const sql = agentRunId
      ? "UPDATE quests SET state='failed', error=?, finished_at=?, updated_at=? WHERE id=? AND state='running' AND owner_session=? AND agent_run_id=?"
      : "UPDATE quests SET state='failed', error=?, finished_at=?, updated_at=? WHERE id=? AND state='running' AND owner_session=?";
    const args = agentRunId ? [error, now, now, id, ownerSession, agentRunId] : [error, now, now, id, ownerSession];
    const changed = Number(this.db.prepare(sql).run(...args).changes) > 0;
    if (changed) this.event(id, "failed", { error: error.slice(0, 1000) });
    return changed;
  }

  cancel(id: string, project: string): boolean {
    const now = Date.now();
    const result = this.db.prepare(
      "UPDATE quests SET state='cancelled', finished_at=?, updated_at=? WHERE id=? AND project=? AND state IN ('queued','interrupted')",
    ).run(now, now, id, resolve(project));
    if (Number(result.changes) > 0) this.event(id, "cancelled", {});
    return Number(result.changes) > 0;
  }

  recoverOwned(project: string, ownerSession: string): number {
    const now = Date.now();
    const ids = this.db.prepare(
      "SELECT id FROM quests WHERE project=? AND state='running' AND owner_session=?",
    ).all(resolve(project), ownerSession) as unknown as Array<{ id: string }>;
    if (!ids.length) return 0;
    this.db.prepare(
      "UPDATE quests SET state='interrupted', updated_at=?, error=COALESCE(error, 'lead session ended before completion'), owner_session=NULL, agent_run_id=NULL WHERE project=? AND state='running' AND owner_session=?",
    ).run(now, resolve(project), ownerSession);
    for (const { id } of ids) this.event(id, "recovered", { ownerSession });
    return ids.length;
  }

  events(id: string, limit = 50): Array<{ event: string; at: number; data: unknown }> {
    const rows = this.db.prepare(
      "SELECT event, at, data FROM quest_events WHERE quest_id=? ORDER BY seq DESC LIMIT ?",
    ).all(id, Math.max(1, Math.min(limit, 200))) as unknown as Array<{ event: string; at: number; data: string }>;
    return rows.map((row) => {
      try { return { event: row.event, at: row.at, data: JSON.parse(row.data) }; }
      catch { return { event: row.event, at: row.at, data: row.data }; }
    });
  }

  private event(id: string, event: string, data: unknown): void {
    this.db.prepare("INSERT INTO quest_events (quest_id, event, at, data) VALUES (?, ?, ?, ?)")
      .run(id, event, Date.now(), JSON.stringify(data));
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS quests (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        role TEXT NOT NULL,
        name TEXT NOT NULL,
        task TEXT NOT NULL,
        context TEXT,
        state TEXT NOT NULL CHECK(state IN ('queued','running','done','failed','cancelled','interrupted')),
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        agent_run_id TEXT,
        owner_session TEXT,
        result TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS quests_project_state_created ON quests(project, state, created_at);
      CREATE TABLE IF NOT EXISTS quest_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        quest_id TEXT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
        event TEXT NOT NULL,
        at INTEGER NOT NULL,
        data TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS quest_events_quest_seq ON quest_events(quest_id, seq);
      PRAGMA user_version=1;
    `);
    const columns = this.db.prepare("PRAGMA table_info(quests)").all() as unknown as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "owner_session")) this.db.exec("ALTER TABLE quests ADD COLUMN owner_session TEXT");
  }

  private prune(): void {
    const keep = Math.max(20, this.options.maxHistory);
    this.db.prepare(
      `DELETE FROM quests WHERE id IN (
         SELECT id FROM quests WHERE state IN ('done','failed','cancelled') ORDER BY updated_at DESC LIMIT -1 OFFSET ?
       )`,
    ).run(keep);
  }
}
