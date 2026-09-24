import type { Store } from "./store.ts";

/**
 * Cost audit: reconciles ccc's local pricing math against Anthropic's own meter.
 *
 * The meter is the truth and the local per-turn cost is a hypothesis, so the audit
 * measures the hypothesis rather than asserting it. Comparing month totals gives one
 * data point a month and mixes in everything ccc can't see; instead this builds its own
 * ground truth out of the meter samples already being collected.
 *
 * An audit window is a span bounded by local quiet on BOTH ends: no turn on this machine
 * for `quietMs` before either boundary reading. Quiet boundaries are what make the
 * arithmetic honest — the meter trails live usage by some unknown lag, so a boundary
 * drawn mid-burst would cut a turn's cost off from the meter movement it caused. With
 * both ends quiet, every turn inside the window has had time to reach the meter, and the
 * meter's movement across the window is exactly what those turns cost.
 *
 * Each window yields an independent (authoritative dollars, local dollars) pair. Their
 * ratio is the thing to watch: a rate change, an expiring promotion, a new cache tier or
 * a model the price table gets wrong all move it, whether or not anyone notices the
 * published table changed. Windows where the meter moved but no local turn exists are
 * spend ccc cannot see at all — the Claude app, claude.ai, another machine — and they're
 * reported separately instead of poisoning the ratio.
 *
 * Note the local side deliberately includes the session namer's own `claude -p` calls:
 * they're hidden from the dashboard but they do cost money, so leaving them out would
 * make the ratio look low.
 */

/** A single reconciled interval. */
export interface AuditWindow {
  id?: number;
  startTs: number;
  endTs: number;
  /** Authoritative dollars: how far the account meter moved across the window. */
  meterDeltaUsd: number;
  /** What ccc's own pricing math says those turns cost. */
  localCostUsd: number;
  turns: number;
  sessions: number;
  /** Per-model local cost inside the window. */
  models: Record<string, { costUsd: number; turns: number }>;
  /** Model responsible for at least SOLE_SHARE of local cost, else null. */
  soleModel: string | null;
  /** Session responsible for at least SOLE_SHARE of local cost, else null. */
  soleSession: string | null;
  inputTok: number;
  outputTok: number;
  cacheReadTok: number;
  cacheW5Tok: number;
  cacheW1hTok: number;
}

export interface AuditRatio {
  /** Windows behind the number. */
  n: number;
  meterUsd: number;
  localUsd: number;
  /** localUsd / meterUsd. 1.0 means the local math matches the meter exactly. */
  ratio: number;
}

export interface AuditFinding {
  kind: "drift" | "unattributed" | "coverage";
  severity: "info" | "warn";
  subject: string;
  message: string;
}

export interface AuditReport {
  from: number;
  to: number;
  /** Every window in range that carried both meter movement and local turns. */
  attributed: AuditRatio;
  /** Windows where the meter moved with no local turn at all: spend ccc can't see. */
  unattributed: { n: number; meterUsd: number };
  /** Windows with local turns but no meter movement — under-metering or lag past quiet. */
  unmetered: { n: number; localUsd: number };
  /** Per-model ratios, from windows a single model dominated. */
  byModel: Array<AuditRatio & { model: string }>;
  /** Per-session ratios, from windows a single session dominated. */
  bySession: Array<AuditRatio & { sessionId: string }>;
  /** Share of the period's total meter movement that landed inside closed windows. */
  coverage: { meterMovedUsd: number; inWindowsUsd: number; pct: number };
  /**
   * The gap expressed two ways, because which one holds steady says what it IS. A flat
   * multiplier on spend (a residency or fast-mode premium) keeps `perLocalDollar` steady;
   * a per-request charge (web search at $10/1k, say) keeps `perTurnUsd` steady. These
   * predictors are collinear until enough windows of differing shape accumulate, so treat
   * a single reading as a measurement, not a diagnosis.
   */
  shortfall: { totalUsd: number; perTurnUsd: number; perLocalDollar: number; turns: number };
  /** Accepted per-model baselines and how far the current ratio has drifted from them. */
  drift: Array<{ model: string; baseline: number; current: number; changePct: number; n: number }>;
  findings: AuditFinding[];
  windows: AuditWindow[];
}

export interface AuditorOptions {
  store: Store;
  /** Local quiet required on both sides of a boundary. Must exceed the meter's lag. */
  quietMs?: number;
  /** Below this the meter's cent rounding dominates, so the window teaches nothing. */
  minMeterDeltaUsd?: number;
  /** Ignore observations until this long after start, so transcript backfill can settle. */
  warmupMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Share of a window's local cost one model/session must carry to own the window. */
const SOLE_SHARE = 0.9;
/** Windows needed on both sides before a drift comparison means anything. */
const MIN_DRIFT_N = 8;
/** Ratio change against an accepted baseline that's worth a warning. */
const DRIFT_WARN = 0.1;

export class Auditor {
  private store: Store;
  private quietMs: number;
  private minMeterDeltaUsd: number;
  private warmupMs: number;
  private now: () => number;
  private log?: (msg: string) => void;
  private startedAt: number;
  /** Last meter reading taken at a quiet moment: the open edge of the next window. */
  private anchor: { ts: number; usedUsd: number } | null = null;

  private static ANCHOR_KEY = "audit_anchor";
  private static BASELINE_PREFIX = "audit_baseline_model:";

  constructor(opts: AuditorOptions) {
    this.store = opts.store;
    this.quietMs = opts.quietMs ?? 15 * 60_000;
    this.minMeterDeltaUsd = opts.minMeterDeltaUsd ?? 0.05;
    this.warmupMs = opts.warmupMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.log = opts.log;
    this.startedAt = this.now();
    this.anchor = this.loadAnchor();
  }

  /**
   * Feed one successful meter reading. Returns a window when this reading closed one.
   *
   * A reading taken while work is in flight is skipped outright: it can't anchor a
   * boundary and it can't close one. A quiet reading that found nothing to reconcile
   * just slides the anchor forward, so an idle stretch doesn't accumulate into a window
   * spanning hours of nothing.
   */
  observe(usedUsd: number, ts: number = this.now()): AuditWindow | null {
    if (this.now() - this.startedAt < this.warmupMs) return null;
    if (!this.isQuiet(ts)) return null;
    const prev = this.anchor;
    if (!prev || usedUsd < prev.usedUsd) {
      // No anchor yet, or the meter went backwards (billing-cycle rollover): re-anchor.
      this.setAnchor(ts, usedUsd);
      return null;
    }
    const stats = this.store.turnStatsInRange(prev.ts, ts);
    const meterDeltaUsd = round(usedUsd - prev.usedUsd, 4);
    if (meterDeltaUsd < this.minMeterDeltaUsd && stats.turns === 0) {
      this.setAnchor(ts, usedUsd); // nothing happened; keep the anchor fresh
      return null;
    }
    const w: AuditWindow = {
      startTs: prev.ts,
      endTs: ts,
      meterDeltaUsd,
      localCostUsd: round(stats.costUsd, 6),
      turns: stats.turns,
      sessions: stats.sessions,
      models: stats.models,
      ...soleOf(stats),
      inputTok: stats.inputTok,
      outputTok: stats.outputTok,
      cacheReadTok: stats.cacheReadTok,
      cacheW5Tok: stats.cacheW5Tok,
      cacheW1hTok: stats.cacheW1hTok,
    };
    this.store.insertAuditWindow(w);
    this.setAnchor(ts, usedUsd);
    this.log?.(
      `audit: window ${new Date(w.startTs).toISOString()}..${new Date(w.endTs).toISOString()} ` +
        `meter $${w.meterDeltaUsd.toFixed(2)} local $${w.localCostUsd.toFixed(2)} (${w.turns} turns)`,
    );
    return w;
  }

  /** True when no turn landed on this machine in the quiet period before `ts`. */
  private isQuiet(ts: number): boolean {
    const last = this.store.latestTurnTs(ts);
    return last == null || ts - last >= this.quietMs;
  }

  private setAnchor(ts: number, usedUsd: number): void {
    this.anchor = { ts, usedUsd };
    this.store.setMeta(Auditor.ANCHOR_KEY, JSON.stringify(this.anchor));
  }

  private loadAnchor(): { ts: number; usedUsd: number } | null {
    try {
      const raw = this.store.getMeta(Auditor.ANCHOR_KEY);
      if (!raw) return null;
      const a = JSON.parse(raw) as { ts?: unknown; usedUsd?: unknown };
      if (typeof a.ts !== "number" || typeof a.usedUsd !== "number") return null;
      return { ts: a.ts, usedUsd: a.usedUsd };
    } catch {
      return null;
    }
  }


  /**
   * Rebuild windows for a past period from the meter samples already on disk, so the audit
   * can answer a question today instead of in a week.
   *
   * It doesn't need every historical poll timestamp, only the meter's value at instants
   * that were quiet — and `meterUsdAt` gives exactly that, because samples are deduped on
   * change, so the last sample at or before an instant IS the reading at that instant. The
   * one thing that has to be checked is whether anyone was watching: an instant inside a
   * poll gap has an unknown meter value, however recent the last sample looks, so those
   * instants are dropped rather than guessed at.
   *
   * Idempotent — it clears the range first, and the boundaries it derives are the same ones
   * `observe` would have used live, so a rebuilt window matches a live-built one.
   *
   * The clear and the rebuild run as one transaction. A backfill is usually run from the CLI
   * while the daemon is up, and a window the daemon closes partway through would otherwise
   * survive the delete and then be duplicated by the rebuild, double-counting that span.
   */
  backfill(sinceMs: number, untilMs: number = this.now()): { windows: number; instants: number; skippedInGaps: number } {
    const result = this.store.transaction(() => {
      this.store.deleteAuditWindowsSince(sinceMs);
      const turnTs = this.store.turnTimestamps(sinceMs, untilMs);
      const candidates: number[] = [];
      // An instant is quiet when no turn landed in the quietMs before it. Every gap longer
      // than that yields one, plus the tail after the final turn.
      let prev = sinceMs;
      for (const ts of turnTs) {
        if (ts - prev > this.quietMs) candidates.push(ts - 1);
        prev = ts;
      }
      if (untilMs - prev > this.quietMs) candidates.push(untilMs);

      const instants: Array<{ ts: number; usedUsd: number }> = [];
      let skippedInGaps = 0;
      for (const ts of candidates) {
        // Nobody was polling here, so the meter's value at this instant is unknown.
        if (this.store.pollGapCovering(ts)) {
          skippedInGaps++;
          continue;
        }
        const usedUsd = this.store.meterUsdAt(ts);
        if (usedUsd == null) continue;
        instants.push({ ts, usedUsd });
      }

      let windows = 0;
      for (let i = 1; i < instants.length; i++) {
        const a = instants[i - 1]!;
        const b = instants[i]!;
        if (b.usedUsd < a.usedUsd) continue; // billing-cycle rollover
        const stats = this.store.turnStatsInRange(a.ts, b.ts);
        const meterDeltaUsd = round(b.usedUsd - a.usedUsd, 4);
        if (meterDeltaUsd < this.minMeterDeltaUsd && stats.turns === 0) continue; // nothing happened
        this.store.insertAuditWindow({
          startTs: a.ts,
          endTs: b.ts,
          meterDeltaUsd,
          localCostUsd: round(stats.costUsd, 6),
          turns: stats.turns,
          sessions: stats.sessions,
          models: stats.models,
          ...soleOf(stats),
          inputTok: stats.inputTok,
          outputTok: stats.outputTok,
          cacheReadTok: stats.cacheReadTok,
          cacheW5Tok: stats.cacheW5Tok,
          cacheW1hTok: stats.cacheW1hTok,
        });
        windows++;
      }
      return { windows, instants: instants.length, skippedInGaps };
    });
    this.log?.(
      `audit: backfilled ${result.windows} window(s) from ${result.instants} quiet instant(s), ${result.skippedInGaps} dropped inside poll gaps`,
    );
    return result;
  }

  /**
   * Refresh the local side of every closed window from the turns table, after
   * `ccc audit --reprice` re-costed stored turns. Boundaries and meter deltas stay exactly as
   * observed: a reprice changes what ccc thinks the turns cost, not what the meter did. A
   * backfill would re-derive the boundaries too, and can find windows the live audit never
   * closed, so it is the wrong tool for this.
   */
  recostWindows(): number {
    return this.store.transaction(() => {
      const windows = this.store.auditWindows(0, Number.MAX_SAFE_INTEGER);
      for (const w of windows) {
        const stats = this.store.turnStatsInRange(w.startTs, w.endTs);
        this.store.updateAuditWindowLocal(w.id, {
          localCostUsd: round(stats.costUsd, 6),
          turns: stats.turns,
          sessions: stats.sessions,
          models: stats.models,
          ...soleOf(stats),
          inputTok: stats.inputTok,
          outputTok: stats.outputTok,
          cacheReadTok: stats.cacheReadTok,
          cacheW5Tok: stats.cacheW5Tok,
          cacheW1hTok: stats.cacheW1hTok,
        });
      }
      return windows.length;
    });
  }

  /** Freeze the current per-model ratios as the baselines drift is measured against. */
  acceptBaselines(sinceMs: number): Array<{ model: string; ratio: number; n: number }> {
    const accepted: Array<{ model: string; ratio: number; n: number }> = [];
    for (const m of this.report(sinceMs).byModel) {
      if (m.n < MIN_DRIFT_N) continue;
      this.store.setMeta(Auditor.BASELINE_PREFIX + m.model, JSON.stringify({ ratio: m.ratio, n: m.n, at: this.now() }));
      accepted.push({ model: m.model, ratio: m.ratio, n: m.n });
    }
    return accepted;
  }

  report(sinceMs: number, untilMs: number = this.now()): AuditReport {
    const windows = this.store.auditWindows(sinceMs, untilMs);
    const attributed = { n: 0, meterUsd: 0, localUsd: 0, ratio: 0 };
    const unattributed = { n: 0, meterUsd: 0 };
    const unmetered = { n: 0, localUsd: 0 };
    const perModel = new Map<string, { n: number; meterUsd: number; localUsd: number }>();
    const perSession = new Map<string, { n: number; meterUsd: number; localUsd: number }>();
    let inWindowsUsd = 0;
    let attributedTurns = 0;

    for (const w of windows) {
      inWindowsUsd += w.meterDeltaUsd;
      if (w.turns === 0) {
        // The meter moved with nothing local to explain it.
        if (w.meterDeltaUsd >= this.minMeterDeltaUsd) {
          unattributed.n++;
          unattributed.meterUsd += w.meterDeltaUsd;
        }
        continue;
      }
      if (w.meterDeltaUsd < this.minMeterDeltaUsd) {
        unmetered.n++;
        unmetered.localUsd += w.localCostUsd;
        continue;
      }
      attributed.n++;
      attributed.meterUsd += w.meterDeltaUsd;
      attributed.localUsd += w.localCostUsd;
      attributedTurns += w.turns;
      if (w.soleModel) bump(perModel, w.soleModel, w);
      if (w.soleSession) bump(perSession, w.soleSession, w);
    }
    attributed.ratio = attributed.meterUsd > 0 ? round(attributed.localUsd / attributed.meterUsd, 4) : 0;

    const byModel = [...perModel.entries()]
      .map(([model, v]) => ({ model, n: v.n, meterUsd: round(v.meterUsd, 4), localUsd: round(v.localUsd, 4), ratio: round(v.localUsd / v.meterUsd, 4) }))
      .sort((a, b) => b.meterUsd - a.meterUsd);
    const bySession = [...perSession.entries()]
      .map(([sessionId, v]) => ({ sessionId, n: v.n, meterUsd: round(v.meterUsd, 4), localUsd: round(v.localUsd, 4), ratio: round(v.localUsd / v.meterUsd, 4) }))
      .sort((a, b) => b.meterUsd - a.meterUsd);

    const meterMovedUsd = this.store.meterMovementUsd(sinceMs, untilMs);
    const coverage = {
      meterMovedUsd: round(meterMovedUsd, 4),
      inWindowsUsd: round(inWindowsUsd, 4),
      pct: meterMovedUsd > 0 ? Math.round((inWindowsUsd / meterMovedUsd) * 100) : 0,
    };

    const drift: AuditReport["drift"] = [];
    for (const m of byModel) {
      const base = this.baselineFor(m.model);
      if (!base || m.n < MIN_DRIFT_N) continue;
      drift.push({ model: m.model, baseline: base.ratio, current: m.ratio, changePct: round(((m.ratio - base.ratio) / base.ratio) * 100, 1), n: m.n });
    }

    return {
      from: sinceMs,
      to: untilMs,
      attributed: { ...attributed, meterUsd: round(attributed.meterUsd, 4), localUsd: round(attributed.localUsd, 4) },
      unattributed: { n: unattributed.n, meterUsd: round(unattributed.meterUsd, 4) },
      unmetered: { n: unmetered.n, localUsd: round(unmetered.localUsd, 4) },
      byModel,
      bySession,
      coverage,
      shortfall: {
        totalUsd: round(attributed.meterUsd - attributed.localUsd, 4),
        perTurnUsd: attributedTurns > 0 ? round((attributed.meterUsd - attributed.localUsd) / attributedTurns, 6) : 0,
        perLocalDollar: attributed.localUsd > 0 ? round((attributed.meterUsd - attributed.localUsd) / attributed.localUsd, 4) : 0,
        turns: attributedTurns,
      },
      drift,
      findings: findings({ attributed, unattributed, coverage, drift }),
      windows,
    };
  }

  private baselineFor(model: string): { ratio: number; n: number } | null {
    try {
      const raw = this.store.getMeta(Auditor.BASELINE_PREFIX + model);
      if (!raw) return null;
      const b = JSON.parse(raw) as { ratio?: unknown; n?: unknown };
      return typeof b.ratio === "number" && b.ratio > 0 ? { ratio: b.ratio, n: typeof b.n === "number" ? b.n : 0 } : null;
    } catch {
      return null;
    }
  }
}

function bump(
  map: Map<string, { n: number; meterUsd: number; localUsd: number }>,
  key: string,
  w: AuditWindow,
): void {
  const v = map.get(key) ?? { n: 0, meterUsd: 0, localUsd: 0 };
  v.n++;
  v.meterUsd += w.meterDeltaUsd;
  v.localUsd += w.localCostUsd;
  map.set(key, v);
}

/** The key carrying at least SOLE_SHARE of `total`, else null. */
/** The model and session, if any, that dominated a window's local cost. */
function soleOf(stats: {
  costUsd: number;
  models: Record<string, { costUsd: number }>;
  topSession: { sessionId: string; costUsd: number } | null;
}): { soleModel: string | null; soleSession: string | null } {
  return {
    soleModel: dominant(stats.models, (m) => m.costUsd, stats.costUsd),
    soleSession:
      stats.topSession && stats.costUsd > 0 && stats.topSession.costUsd / stats.costUsd >= SOLE_SHARE
        ? stats.topSession.sessionId
        : null,
  };
}

function dominant<T>(rec: Record<string, T>, value: (t: T) => number, total: number): string | null {
  if (total <= 0) return null;
  for (const [k, v] of Object.entries(rec)) {
    if (value(v) / total >= SOLE_SHARE) return k;
  }
  return null;
}

/** What a reader should act on, in the order it matters. */
function findings(r: {
  attributed: { n: number; meterUsd: number; localUsd: number; ratio: number };
  unattributed: { n: number; meterUsd: number };
  coverage: { pct: number; meterMovedUsd: number };
  drift: AuditReport["drift"];
}): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const d of r.drift) {
    if (Math.abs(d.changePct) < DRIFT_WARN * 100) continue;
    out.push({
      kind: "drift",
      severity: "warn",
      subject: d.model,
      message:
        `${d.model} now prices at ${d.current.toFixed(3)}x the meter, ${d.changePct > 0 ? "up" : "down"} ` +
        `${Math.abs(d.changePct).toFixed(1)}% from the accepted ${d.baseline.toFixed(3)}x (${d.n} windows). ` +
        `A rate change, an expiring promotion or a new cache tier would do this — check \`ccc prices --refresh\`, ` +
        `then \`ccc audit --accept\` once the new ratio is the right one.`,
    });
  }
  if (r.unattributed.meterUsd >= 0.5) {
    out.push({
      kind: "unattributed",
      severity: "info",
      subject: "off-machine spend",
      message:
        `$${r.unattributed.meterUsd.toFixed(2)} across ${r.unattributed.n} window(s) moved the meter with no local turn: ` +
        `the Claude app, claude.ai, or Claude Code on another machine. Excluded from the ratio, not from your bill.`,
    });
  }
  if (r.coverage.meterMovedUsd > 1 && r.coverage.pct < 60) {
    out.push({
      kind: "coverage",
      severity: "info",
      subject: "coverage",
      message:
        `Only ${r.coverage.pct}% of the period's meter movement fell inside a quiet-bounded window, so the ratio ` +
        `describes that slice rather than the whole period. Continuous work without a quiet gap is the usual cause.`,
    });
  }
  return out;
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
