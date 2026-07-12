import { EventEmitter } from "node:events";
import {
  classifyCommand,
  isColdRewrite,
  modelSwitchCostUsd,
  prefixTokens,
  rewriteCostUsd,
  ttlSeconds,
  ttlTierOf,
  turnCost,
  type Entry,
  type SessionState,
  type TtlTier,
} from "@ccc/core";
import type { Store } from "./store.ts";

const CANDIDATE_MODELS = ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"];

export interface TrackerEvents {
  /** Session state changed (new turn ingested, expiry, etc.). */
  state: [SessionState];
  /** Every live-ingested assistant turn (keep-warm judges ping turns here). */
  assistantTurn: [{ sessionId: string; entry: Extract<Entry, { kind: "assistant" }> }];
  /** Cold cache re-write detected (money burned). */
  coldRewrite: [{ sessionId: string; costUsd: number; gapSeconds: number }];
  /** Cache is about to expire while the session sits idle. */
  expiryWarning: [{ sessionId: string; expiresAt: number; rewriteCostUsd: number }];
  /** Cache expired while idle. */
  expired: [{ sessionId: string; rewriteCostUsd: number }];
}

/**
 * Consumes parsed transcript entries, maintains live per-session state
 * (TTL tier, countdown, prefix, costs), detects gaps/cold re-writes,
 * and schedules expiry warnings.
 */
export class SessionTracker extends EventEmitter<TrackerEvents> {
  private sessions = new Map<string, SessionState>();
  private warnTimers = new Map<string, NodeJS.Timeout[]>();
  /** Warn this many ms before cache expiry. */
  warnBeforeMs = 60_000;

  private store: Store;

  constructor(store: Store) {
    super();
    this.store = store;
  }

  get all(): SessionState[] {
    return [...this.sessions.values()];
  }

  get(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /** Ingest one entry from `projectSlug`'s transcript. `live` gates timers/toasts (false during backfill). */
  ingest(entry: Entry, projectSlug: string, live: boolean): void {
    if (entry.kind === "assistant") this.ingestAssistant(entry, projectSlug, live);
    else if (entry.kind === "user") this.ingestUser(entry);
  }

  private ingestAssistant(entry: Extract<Entry, { kind: "assistant" }>, projectSlug: string, live: boolean): void {
    if (!entry.sessionId) return;
    const ts = Date.parse(entry.timestamp);
    if (!Number.isFinite(ts)) return;

    const state = this.sessions.get(entry.sessionId) ?? this.newState(entry.sessionId, projectSlug);
    if (entry.cwd) state.cwd = entry.cwd;
    if (entry.version) state.ccVersion = entry.version;
    if (entry.model) state.model = entry.model;

    // One billed API response is logged as several assistant lines (one per
    // tool-call round), each with a distinct `uuid` but the same `requestId`.
    // Key the turn on requestId so INSERT OR IGNORE dedups those repeats and the
    // response is billed exactly once. Tool links use the same key so the
    // tool_calls -> turns join stays intact.
    const turnKey = entry.requestId ?? entry.uuid;

    // Record tool uses for attribution (even on sidechains — they burn tokens too).
    for (const tu of entry.toolUses) {
      const cc = tu.command ? classifyCommand(tu.command) : undefined;
      this.store.insertToolCall({
        toolUseId: tu.id,
        sessionId: entry.sessionId,
        turnUuid: turnKey,
        ts,
        toolName: tu.name,
        command: tu.command,
        commandClass: cc?.cls,
        rtkWrapped: cc?.rtkWrapped ?? false,
      });
    }

    if (entry.usage) {
      const usage = entry.usage;
      const model = entry.model ?? state.model ?? "unknown";
      const cost = turnCost(usage, model, entry.timestamp);
      const prefix = prefixTokens(usage);
      const inserted = this.store.insertTurn({
        uuid: turnKey,
        sessionId: entry.sessionId,
        ts,
        model: entry.model,
        inputTok: usage.input_tokens,
        outputTok: usage.output_tokens,
        cacheReadTok: usage.cache_read_input_tokens,
        cacheW5Tok: usage.cache_creation?.ephemeral_5m_input_tokens ?? 0,
        cacheW1hTok: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        costUsd: cost.totalUsd,
        prefixTok: prefix,
        isSidechain: entry.isSidechain ?? false,
      });

      // Gap analysis against the previous turn (main chain only, deduped inserts only).
      if (inserted && !entry.isSidechain && state.lastTurnAt != null && ts > state.lastTurnAt) {
        const gapSeconds = Math.round((ts - state.lastTurnAt) / 1000);
        const tierBefore = state.ttlTier;
        if (gapSeconds > 60) {
          const cold = isColdRewrite(usage, gapSeconds, tierBefore);
          const realized = cold && tierBefore ? turnCostWriteUsd(cost.cacheWriteUsd) : undefined;
          this.store.insertGap({
            sessionId: entry.sessionId,
            projectSlug,
            gapStartTs: state.lastTurnAt,
            gapSeconds,
            ttlTier: tierBefore,
            expired: tierBefore != null && gapSeconds > ttlSeconds(tierBefore),
            realizedRewriteCost: realized,
          });
          if (cold && realized != null) {
            this.store.logEvent("cold_rewrite", entry.sessionId, { costUsd: realized, gapSeconds });
            if (live) this.emit("coldRewrite", { sessionId: entry.sessionId, costUsd: realized, gapSeconds });
          }
        }
      }

      if (inserted && !entry.isSidechain) {
        // Update live cache state from this turn.
        const tier = ttlTierOf(usage) ?? state.ttlTier;
        state.ttlTier = tier;
        state.lastTurnAt = ts;
        state.expiresAt = tier ? ts + ttlSeconds(tier) * 1000 : null;
        state.prefixTokens = prefix;
        state.rewriteCostUsd = tier && state.model ? rewriteCostUsd(prefix, tier, state.model) : 0;
        state.modelSwitchCostUsd = {};
        for (const m of CANDIDATE_MODELS) {
          if (state.model && m !== normalize(state.model)) {
            state.modelSwitchCostUsd[m] = modelSwitchCostUsd(prefix, tier, m);
          }
        }
      }
      if (inserted) {
        state.sessionCostUsd += cost.totalUsd;
        state.turns += 1;
      }

      this.store.upsertSession({
        id: entry.sessionId,
        projectSlug,
        cwd: entry.cwd,
        ccVersion: entry.version,
        ts,
        model: entry.model,
        tier: state.ttlTier,
      });
    }

    state.updatedAt = Date.now();
    this.sessions.set(entry.sessionId, state);
    if (live) {
      this.emit("assistantTurn", { sessionId: entry.sessionId, entry });
      this.scheduleExpiryTimers(state);
      this.emit("state", state);
    }
  }

  private ingestUser(entry: Extract<Entry, { kind: "user" }>): void {
    for (const tr of entry.toolResults) {
      this.store.setToolResultChars(tr.toolUseId, tr.resultChars);
    }
    // Human prompt = activity; a cache read will follow on the assistant turn,
    // so countdown updates arrive with that turn. Nothing else to do here.
  }

  /** Restore cumulative counters from the DB after a restart (before live tailing). */
  restoreFromStore(): void {
    const rows = this.store.db
      .prepare(
        `SELECT t.session_id AS sid, s.project_slug AS slug, s.cwd AS cwd, s.cc_version AS ver, s.last_model AS model,
                s.billing_tier_last AS tier,
                SUM(t.cost_usd) AS cost, COUNT(*) AS turns, MAX(t.ts) AS last_ts
         FROM turns t JOIN sessions s ON s.id = t.session_id
         GROUP BY t.session_id`,
      )
      .all() as Array<{ sid: string; slug: string; cwd: string | null; ver: string | null; model: string | null; tier: string | null; cost: number; turns: number; last_ts: number }>;
    for (const r of rows) {
      const state = this.newState(r.sid, r.slug);
      state.cwd = r.cwd ?? undefined;
      state.ccVersion = r.ver ?? undefined;
      state.model = r.model ?? undefined;
      state.ttlTier = (r.tier as TtlTier | null) ?? null;
      state.sessionCostUsd = r.cost;
      state.turns = r.turns;
      state.lastTurnAt = r.last_ts;
      state.expiresAt = state.ttlTier ? r.last_ts + ttlSeconds(state.ttlTier) * 1000 : null;
      const last = this.store.db
        .prepare(`SELECT prefix_tok FROM turns WHERE session_id = ? AND is_sidechain = 0 ORDER BY ts DESC LIMIT 1`)
        .get(r.sid) as { prefix_tok: number } | undefined;
      state.prefixTokens = last?.prefix_tok ?? 0;
      if (state.ttlTier && state.model) {
        state.rewriteCostUsd = rewriteCostUsd(state.prefixTokens, state.ttlTier, state.model);
      }
      state.updatedAt = Date.now();
      this.sessions.set(r.sid, state);
    }
  }

  private scheduleExpiryTimers(state: SessionState): void {
    const old = this.warnTimers.get(state.sessionId);
    if (old) for (const t of old) clearTimeout(t);
    this.warnTimers.delete(state.sessionId);
    if (state.expiresAt == null) return;

    const now = Date.now();
    const timers: NodeJS.Timeout[] = [];
    const expiresAt = state.expiresAt;
    const warnIn = expiresAt - this.warnBeforeMs - now;
    if (warnIn > 0) {
      const t = setTimeout(() => {
        const s = this.sessions.get(state.sessionId);
        if (s && s.expiresAt === expiresAt) {
          this.emit("expiryWarning", { sessionId: s.sessionId, expiresAt, rewriteCostUsd: s.rewriteCostUsd });
        }
      }, warnIn);
      t.unref();
      timers.push(t);
    }
    const expireIn = expiresAt - now;
    if (expireIn > 0) {
      const t = setTimeout(() => {
        const s = this.sessions.get(state.sessionId);
        if (s && s.expiresAt === expiresAt) {
          this.emit("expired", { sessionId: s.sessionId, rewriteCostUsd: s.rewriteCostUsd });
          this.emit("state", s);
        }
      }, expireIn);
      t.unref();
      timers.push(t);
    }
    this.warnTimers.set(state.sessionId, timers);
  }

  private newState(sessionId: string, projectSlug: string): SessionState {
    return {
      sessionId,
      projectSlug,
      ttlTier: null,
      expiresAt: null,
      lastTurnAt: null,
      prefixTokens: 0,
      rewriteCostUsd: 0,
      sessionCostUsd: 0,
      turns: 0,
      modelSwitchCostUsd: {},
      keepwarm: { armed: false, pings: 0, netSavedUsd: 0, nextPingAt: null, reason: "not implemented (M5)" },
      guardian: {
        fiveHourPct: null,
        sevenDayPct: null,
        fiveHourResetsAt: null,
        sevenDayResetsAt: null,
        pendingAction: null,
        updatedAt: null,
      },
      updatedAt: Date.now(),
    };
  }
}

function normalize(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
}

function turnCostWriteUsd(cacheWriteUsd: number): number {
  return Math.round(cacheWriteUsd * 10_000) / 10_000;
}
