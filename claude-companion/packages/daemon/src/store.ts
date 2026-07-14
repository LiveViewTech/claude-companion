import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

/**
 * SQLite persistence via Node's built-in node:sqlite (no native build step).
 * Schema includes M4/M5 tables up front so migrations stay trivial.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_slug TEXT NOT NULL,
        cwd TEXT,
        cc_version TEXT,
        started_ts INTEGER,
        last_ts INTEGER,
        last_model TEXT,
        billing_tier_last TEXT,
        rtk_detected INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS turns (
        uuid TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        model TEXT,
        input_tok INTEGER NOT NULL DEFAULT 0,
        output_tok INTEGER NOT NULL DEFAULT 0,
        cache_read_tok INTEGER NOT NULL DEFAULT 0,
        cache_w5_tok INTEGER NOT NULL DEFAULT 0,
        cache_w1h_tok INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        prefix_tok INTEGER NOT NULL DEFAULT 0,
        is_sidechain INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_turns_session_ts ON turns(session_id, ts);
      CREATE INDEX IF NOT EXISTS idx_turns_ts ON turns(ts);
      CREATE TABLE IF NOT EXISTS tool_calls (
        tool_use_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_uuid TEXT,
        ts INTEGER,
        tool_name TEXT NOT NULL,
        command TEXT,
        command_class TEXT,
        rtk_wrapped INTEGER NOT NULL DEFAULT 0,
        result_chars INTEGER,
        result_tok_exact INTEGER,
        attribution TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
      CREATE TABLE IF NOT EXISTS gaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project_slug TEXT NOT NULL,
        gap_start_ts INTEGER NOT NULL,
        gap_seconds INTEGER NOT NULL,
        hour_of_day INTEGER NOT NULL,
        weekday INTEGER NOT NULL,
        ttl_tier TEXT,
        expired INTEGER NOT NULL DEFAULT 0,
        realized_rewrite_cost REAL
      );
      CREATE INDEX IF NOT EXISTS idx_gaps_project ON gaps(project_slug);
      CREATE TABLE IF NOT EXISTS pings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        cache_read_tok INTEGER NOT NULL DEFAULT 0,
        cache_w_tok INTEGER NOT NULL DEFAULT 0,
        output_tok INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        hit INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        session_id TEXT,
        payload TEXT
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    // Column additions to pre-existing tables (CREATE IF NOT EXISTS won't add them).
    this.addColumn("sessions", "name", "TEXT");
    this.addColumn("sessions", "name_desc", "TEXT");
    this.addColumn("sessions", "name_prompts", "INTEGER DEFAULT 0");
  }

  private addColumn(table: string, column: string, decl: string): void {
    const cols = this.db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }

  upsertSession(s: {
    id: string;
    projectSlug: string;
    cwd?: string;
    ccVersion?: string;
    ts: number;
    model?: string;
    tier?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_slug, cwd, cc_version, started_ts, last_ts, last_model, billing_tier_last)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           last_ts = MAX(last_ts, excluded.last_ts),
           cwd = COALESCE(excluded.cwd, cwd),
           cc_version = COALESCE(excluded.cc_version, cc_version),
           last_model = COALESCE(excluded.last_model, last_model),
           billing_tier_last = COALESCE(excluded.billing_tier_last, billing_tier_last)`,
      )
      .run(s.id, s.projectSlug, s.cwd ?? null, s.ccVersion ?? null, s.ts, s.ts, s.model ?? null, s.tier ?? null);
  }

  insertTurn(t: {
    uuid: string;
    sessionId: string;
    ts: number;
    model?: string;
    inputTok: number;
    outputTok: number;
    cacheReadTok: number;
    cacheW5Tok: number;
    cacheW1hTok: number;
    costUsd: number;
    prefixTok: number;
    isSidechain: boolean;
  }): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO turns
         (uuid, session_id, ts, model, input_tok, output_tok, cache_read_tok, cache_w5_tok, cache_w1h_tok, cost_usd, prefix_tok, is_sidechain)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.uuid,
        t.sessionId,
        t.ts,
        t.model ?? null,
        t.inputTok,
        t.outputTok,
        t.cacheReadTok,
        t.cacheW5Tok,
        t.cacheW1hTok,
        t.costUsd,
        t.prefixTok,
        t.isSidechain ? 1 : 0,
      );
    return res.changes > 0;
  }

  insertToolCall(c: {
    toolUseId: string;
    sessionId: string;
    turnUuid: string;
    ts: number;
    toolName: string;
    command?: string;
    commandClass?: string;
    rtkWrapped: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO tool_calls (tool_use_id, session_id, turn_uuid, ts, tool_name, command, command_class, rtk_wrapped)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.toolUseId, c.sessionId, c.turnUuid, c.ts, c.toolName, c.command ?? null, c.commandClass ?? null, c.rtkWrapped ? 1 : 0);
  }

  /** Persist an LLM-generated session name. `promptCount` = prompts seen when named (rename watermark). */
  setSessionName(id: string, name: string, desc: string, promptCount: number): void {
    this.db
      .prepare(`UPDATE sessions SET name = ?, name_desc = ?, name_prompts = ? WHERE id = ?`)
      .run(name, desc, promptCount, id);
  }

  getSessionName(id: string): { name?: string; desc?: string; prompts: number } | null {
    const row = this.db
      .prepare(`SELECT name, name_desc AS desc, name_prompts AS prompts FROM sessions WHERE id = ?`)
      .get(id) as { name: string | null; desc: string | null; prompts: number | null } | undefined;
    if (!row) return null;
    return { name: row.name ?? undefined, desc: row.desc ?? undefined, prompts: row.prompts ?? 0 };
  }

  setToolResultChars(toolUseId: string, chars: number): void {
    this.db.prepare(`UPDATE tool_calls SET result_chars = ? WHERE tool_use_id = ?`).run(chars, toolUseId);
  }

  insertGap(g: {
    sessionId: string;
    projectSlug: string;
    gapStartTs: number;
    gapSeconds: number;
    ttlTier: string | null;
    expired: boolean;
    realizedRewriteCost?: number;
  }): void {
    const d = new Date(g.gapStartTs);
    this.db
      .prepare(
        `INSERT INTO gaps (session_id, project_slug, gap_start_ts, gap_seconds, hour_of_day, weekday, ttl_tier, expired, realized_rewrite_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        g.sessionId,
        g.projectSlug,
        g.gapStartTs,
        g.gapSeconds,
        d.getHours(),
        d.getDay(),
        g.ttlTier,
        g.expired ? 1 : 0,
        g.realizedRewriteCost ?? null,
      );
  }

  logEvent(kind: string, sessionId: string | null, payload: unknown): void {
    this.db
      .prepare(`INSERT INTO events (ts, kind, session_id, payload) VALUES (?, ?, ?, ?)`)
      .run(Date.now(), kind, sessionId, JSON.stringify(payload ?? null));
  }

  dayCostUsd(dayStartMs: number, dayEndMs: number): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM turns WHERE ts >= ? AND ts < ?`)
      .get(dayStartMs, dayEndMs) as { c: number };
    return row.c;
  }

  /** Usage-window observations (samples + resets) since `sinceMs`, oldest first. */
  windowEvents(sinceMs: number): Array<{ ts: number; kind: string; payload: string | null }> {
    return this.db
      .prepare(
        `SELECT ts, kind, payload FROM events
         WHERE kind IN ('account_window_sample', 'account_window_reset') AND ts >= ?
         ORDER BY ts`,
      )
      .all(sinceMs) as Array<{ ts: number; kind: string; payload: string | null }>;
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
