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
    // The CLI and the daemon both write; without this a writer that finds the lock held
    // fails immediately instead of waiting the moment out.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  /**
   * Run `fn` as a single atomic write. BEGIN IMMEDIATE claims the write lock up front, so
   * another process's writes land wholly before or wholly after — never interleaved into
   * a multi-statement sequence that reads its own earlier writes.
   */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Already unwound by SQLite.
      }
      throw err;
    }
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
      CREATE TABLE IF NOT EXISTS audit_windows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_ts INTEGER NOT NULL,
        end_ts INTEGER NOT NULL,
        meter_delta_usd REAL NOT NULL,
        local_cost_usd REAL NOT NULL,
        turns INTEGER NOT NULL DEFAULT 0,
        sessions INTEGER NOT NULL DEFAULT 0,
        models TEXT,
        sole_model TEXT,
        sole_session TEXT,
        input_tok INTEGER NOT NULL DEFAULT 0,
        output_tok INTEGER NOT NULL DEFAULT 0,
        cache_read_tok INTEGER NOT NULL DEFAULT 0,
        cache_w5_tok INTEGER NOT NULL DEFAULT 0,
        cache_w1h_tok INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_audit_windows_end ON audit_windows(end_ts);
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

  /** Account-meter reading (USD) as of `atMs`: the last sample at or before it. Null when none. */
  meterUsdAt(atMs: number): number | null {
    const row = this.db
      .prepare(
        `SELECT payload FROM events
         WHERE kind = 'account_meter_sample' AND ts <= ?
         ORDER BY ts DESC LIMIT 1`,
      )
      .get(atMs) as { payload: string } | undefined;
    if (!row) return null;
    try {
      const usd = (JSON.parse(row.payload) as { usedUsd?: unknown }).usedUsd;
      return typeof usd === "number" && Number.isFinite(usd) ? usd : null;
    } catch {
      return null;
    }
  }

  /**
   * Record a successful account-meter poll and flag any coverage gap. The last
   * ok-timestamp lives in `meta`; when the previous ok was more than
   * `gapThresholdMs` before `nowMs`, the downtime window [prev, nowMs] is written
   * as one `account_poll_gap` row. That interval is what `pollGapCovering` tests:
   * if it straddles local midnight the pre-midnight meter baseline is stale, so
   * the "today" delta must be suppressed. Meter movement is tracked separately and
   * deduped, so a flat-overnight meter is NOT mistaken for downtime — only an
   * actual break in successful polling logs a row (rare: restart / net / token).
   */
  recordAccountPollOk(nowMs: number, gapThresholdMs: number): void {
    const prevRaw = this.getMeta("account_poll_last_ok");
    const prev = prevRaw != null ? Number(prevRaw) : null;
    if (prev != null && Number.isFinite(prev) && nowMs - prev > gapThresholdMs) {
      this.db
        .prepare(`INSERT INTO events (ts, kind, session_id, payload) VALUES (?, 'account_poll_gap', NULL, ?)`)
        .run(nowMs, JSON.stringify({ start: prev, end: nowMs, gapMs: nowMs - prev }));
    }
    this.setMeta("account_poll_last_ok", String(nowMs));
  }

  /** The most recent poll-coverage gap whose [start, end] straddles `instantMs`, else null. */
  pollGapCovering(instantMs: number): { start: number; end: number; gapMs: number } | null {
    const rows = this.db
      .prepare(`SELECT payload FROM events WHERE kind = 'account_poll_gap' AND ts >= ? ORDER BY id DESC`)
      .all(instantMs) as Array<{ payload: string }>;
    for (const r of rows) {
      try {
        const g = JSON.parse(r.payload) as { start?: unknown; end?: unknown; gapMs?: unknown };
        if (typeof g.start === "number" && typeof g.end === "number" && g.start <= instantMs && g.end >= instantMs) {
          return { start: g.start, end: g.end, gapMs: typeof g.gapMs === "number" ? g.gapMs : g.end - g.start };
        }
      } catch {
        // skip malformed row
      }
    }
    return null;
  }

  /**
   * Record a stretch where nobody was watching the meter because the machine was
   * asleep or off (see AwakeTracker). Stored at `ts = end` so a plain `ts >= x`
   * scan finds every window that could still matter.
   */
  recordAwayWindow(w: { start: number; end: number; ms: number; reason: string }): void {
    this.db
      .prepare(`INSERT INTO events (ts, kind, session_id, payload) VALUES (?, 'away_window', NULL, ?)`)
      .run(w.end, JSON.stringify(w));
  }

  /** Away windows that ended at or after `sinceMs`, oldest first. */
  awayWindowsSince(sinceMs: number): Array<{ start: number; end: number; ms: number; reason: string }> {
    const rows = this.db
      .prepare(`SELECT payload FROM events WHERE kind = 'away_window' AND ts >= ? ORDER BY ts ASC`)
      .all(sinceMs) as Array<{ payload: string }>;
    const out: Array<{ start: number; end: number; ms: number; reason: string }> = [];
    for (const r of rows) {
      try {
        const w = JSON.parse(r.payload) as Record<string, unknown>;
        if (typeof w["start"] !== "number" || typeof w["end"] !== "number") continue;
        out.push({
          start: w["start"],
          end: w["end"],
          ms: typeof w["ms"] === "number" ? w["ms"] : w["end"] - w["start"],
          reason: typeof w["reason"] === "string" ? w["reason"] : "unknown",
        });
      } catch {
        // skip malformed row
      }
    }
    return out;
  }

  /**
   * Aggregate of every turn in (startMs, endMs] — the local side of an audit window.
   * Includes the session namer's own `claude -p` runs: hidden from the dashboard, but
   * they cost money, so omitting them would bias the ratio low.
   */
  turnStatsInRange(
    startMs: number,
    endMs: number,
  ): {
    turns: number;
    sessions: number;
    costUsd: number;
    inputTok: number;
    outputTok: number;
    cacheReadTok: number;
    cacheW5Tok: number;
    cacheW1hTok: number;
    models: Record<string, { costUsd: number; turns: number }>;
    topSession: { sessionId: string; costUsd: number } | null;
  } {
    const agg = this.db
      .prepare(
        `SELECT COUNT(*) AS turns, COUNT(DISTINCT session_id) AS sessions, COALESCE(SUM(cost_usd), 0) AS cost,
                COALESCE(SUM(input_tok), 0) AS input_tok, COALESCE(SUM(output_tok), 0) AS output_tok,
                COALESCE(SUM(cache_read_tok), 0) AS cache_read_tok,
                COALESCE(SUM(cache_w5_tok), 0) AS cache_w5_tok, COALESCE(SUM(cache_w1h_tok), 0) AS cache_w1h_tok
         FROM turns WHERE ts > ? AND ts <= ?`,
      )
      .get(startMs, endMs) as Record<string, number>;
    const models: Record<string, { costUsd: number; turns: number }> = {};
    const rows = this.db
      .prepare(
        `SELECT COALESCE(model, 'unknown') AS m, SUM(cost_usd) AS c, COUNT(*) AS n
         FROM turns WHERE ts > ? AND ts <= ? GROUP BY m`,
      )
      .all(startMs, endMs) as Array<{ m: string; c: number; n: number }>;
    for (const r of rows) models[r.m] = { costUsd: r.c, turns: r.n };
    const top = this.db
      .prepare(
        `SELECT session_id AS s, SUM(cost_usd) AS c FROM turns WHERE ts > ? AND ts <= ?
         GROUP BY session_id ORDER BY c DESC LIMIT 1`,
      )
      .get(startMs, endMs) as { s: string; c: number } | undefined;
    return {
      turns: agg["turns"] ?? 0,
      sessions: agg["sessions"] ?? 0,
      costUsd: agg["cost"] ?? 0,
      inputTok: agg["input_tok"] ?? 0,
      outputTok: agg["output_tok"] ?? 0,
      cacheReadTok: agg["cache_read_tok"] ?? 0,
      cacheW5Tok: agg["cache_w5_tok"] ?? 0,
      cacheW1hTok: agg["cache_w1h_tok"] ?? 0,
      models,
      topSession: top ? { sessionId: top.s, costUsd: top.c } : null,
    };
  }

  /** Timestamp of the newest turn at or before `atOrBeforeMs` (default: any), else null. */
  latestTurnTs(atOrBeforeMs = Number.MAX_SAFE_INTEGER): number | null {
    const row = this.db.prepare(`SELECT MAX(ts) AS t FROM turns WHERE ts <= ?`).get(atOrBeforeMs) as {
      t: number | null;
    };
    return row.t ?? null;
  }

  /**
   * Total upward movement of the account meter across (startMs, endMs], summed over
   * consecutive samples so a billing-cycle rollover (the meter dropping to near zero)
   * doesn't read as negative spend. Used to say how much of a period the audit's
   * quiet-bounded windows actually cover.
   */
  meterMovementUsd(startMs: number, endMs: number): number {
    const rows = this.db
      .prepare(
        `SELECT payload FROM events WHERE kind = 'account_meter_sample' AND ts > ? AND ts <= ? ORDER BY ts ASC`,
      )
      .all(startMs, endMs) as Array<{ payload: string }>;
    let prev = this.meterUsdAt(startMs);
    let total = 0;
    for (const r of rows) {
      let usd: number | null = null;
      try {
        const v = (JSON.parse(r.payload) as { usedUsd?: unknown }).usedUsd;
        usd = typeof v === "number" && Number.isFinite(v) ? v : null;
      } catch {
        usd = null;
      }
      if (usd == null) continue;
      if (prev != null && usd > prev) total += usd - prev;
      prev = usd;
    }
    return total;
  }

  insertAuditWindow(w: {
    startTs: number;
    endTs: number;
    meterDeltaUsd: number;
    localCostUsd: number;
    turns: number;
    sessions: number;
    models: Record<string, { costUsd: number; turns: number }>;
    soleModel: string | null;
    soleSession: string | null;
    inputTok: number;
    outputTok: number;
    cacheReadTok: number;
    cacheW5Tok: number;
    cacheW1hTok: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO audit_windows
         (start_ts, end_ts, meter_delta_usd, local_cost_usd, turns, sessions, models, sole_model, sole_session,
          input_tok, output_tok, cache_read_tok, cache_w5_tok, cache_w1h_tok)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        w.startTs,
        w.endTs,
        w.meterDeltaUsd,
        w.localCostUsd,
        w.turns,
        w.sessions,
        JSON.stringify(w.models),
        w.soleModel,
        w.soleSession,
        w.inputTok,
        w.outputTok,
        w.cacheReadTok,
        w.cacheW5Tok,
        w.cacheW1hTok,
      );
  }

  /** Closed audit windows ending in (sinceMs, untilMs], oldest first. */
  auditWindows(
    sinceMs: number,
    untilMs: number,
  ): Array<{
    id: number;
    startTs: number;
    endTs: number;
    meterDeltaUsd: number;
    localCostUsd: number;
    turns: number;
    sessions: number;
    models: Record<string, { costUsd: number; turns: number }>;
    soleModel: string | null;
    soleSession: string | null;
    inputTok: number;
    outputTok: number;
    cacheReadTok: number;
    cacheW5Tok: number;
    cacheW1hTok: number;
  }> {
    const rows = this.db
      .prepare(`SELECT * FROM audit_windows WHERE end_ts > ? AND end_ts <= ? ORDER BY end_ts ASC`)
      .all(sinceMs, untilMs) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      let models: Record<string, { costUsd: number; turns: number }> = {};
      try {
        models = JSON.parse(String(r["models"] ?? "{}")) as Record<string, { costUsd: number; turns: number }>;
      } catch {
        models = {};
      }
      return {
        id: Number(r["id"]),
        startTs: Number(r["start_ts"]),
        endTs: Number(r["end_ts"]),
        meterDeltaUsd: Number(r["meter_delta_usd"]),
        localCostUsd: Number(r["local_cost_usd"]),
        turns: Number(r["turns"]),
        sessions: Number(r["sessions"]),
        models,
        soleModel: r["sole_model"] == null ? null : String(r["sole_model"]),
        soleSession: r["sole_session"] == null ? null : String(r["sole_session"]),
        inputTok: Number(r["input_tok"]),
        outputTok: Number(r["output_tok"]),
        cacheReadTok: Number(r["cache_read_tok"]),
        cacheW5Tok: Number(r["cache_w5_tok"]),
        cacheW1hTok: Number(r["cache_w1h_tok"]),
      };
    });
  }

  /** Turn timestamps in (startMs, endMs], oldest first — the quiet-gap timeline. */
  turnTimestamps(startMs: number, endMs: number): number[] {
    return (
      this.db.prepare(`SELECT ts FROM turns WHERE ts > ? AND ts <= ? ORDER BY ts ASC`).all(startMs, endMs) as Array<{
        ts: number;
      }>
    ).map((r) => r.ts);
  }

  /** Drop audit windows ending after `sinceMs`, so a backfill can rebuild them idempotently. */
  deleteAuditWindowsSince(sinceMs: number): number {
    return Number(this.db.prepare(`DELETE FROM audit_windows WHERE end_ts > ?`).run(sinceMs).changes);
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
