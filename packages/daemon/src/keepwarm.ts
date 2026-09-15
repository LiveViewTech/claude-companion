import { breakEven, minCacheablePrefix, pingCostUsd, rewriteCostUsd, turnCost, type AssistantTurn, type SessionState, type TtlTier } from "@ccc/core";
import type { CccConfig, KeepWarmTierPolicy } from "./config.ts";
import type { SessionTracker } from "./session-tracker.ts";
import type { Store } from "./store.ts";

/**
 * Keep-warm policy engine. The Stop hook is deliberately dumb: it sleeps until
 * state.keepwarm.nextPingAt, then asks /keepwarm/authorize. All spending
 * decisions are made here, and every ping is measured against the transcript;
 * the first cache MISS auto-disarms.
 *
 * Gates (all must pass to arm or authorize):
 *  - the session's TTL tier is known (measured, or seeded from keepwarm.accountType)
 *  - that tier's policy allows arming (keepwarm.tiers[tier].arm)
 *  - prefix >= the model's minimum cacheable size
 *  - pings this idle period < that tier's soft cap
 *
 * Reaching the cap on a tier with `escalateToHandoff` doesn't just stop the pings — it
 * arms a HANDOFF.md instruction, because past the cap the cheapest available move is to
 * externalize the state and start fresh rather than keep paying to hold the context.
 */
export class KeepWarm {
  private tracker: SessionTracker;
  private store: Store;
  private cfg: CccConfig;
  private onEvent: (kind: string, sessionId: string, payload: unknown) => void;
  /** Pings issued this idle period, per session; reset on human activity. */
  private idlePings = new Map<string, number>();
  /** Set at authorize time; the next assistant turn is judged as the ping turn. */
  private awaitingPing = new Map<string, { authorizedAt: number; prefix: number }>();
  /** Idle-period bookkeeping for counterfactual savings. */
  private idleStart = new Map<string, number>();

  /** Ask the guardian to arm a handoff. Injected so keepwarm needn't import Guardian. */
  private onEscalate: (sessionId: string, reason: string) => void;

  constructor(opts: {
    tracker: SessionTracker;
    store: Store;
    cfg: CccConfig;
    onEvent: (kind: string, sessionId: string, payload: unknown) => void;
    /** Called once when a session hits the ping cap on an escalating tier. */
    onEscalate?: (sessionId: string, reason: string) => void;
  }) {
    this.tracker = opts.tracker;
    this.store = opts.store;
    this.cfg = opts.cfg;
    this.onEvent = opts.onEvent;
    this.onEscalate = opts.onEscalate ?? (() => {});
  }

  /**
   * The session's TTL tier. A measured tier always wins; `accountType` only seeds a
   * session that hasn't reported a cache write yet, so a wrong account setting costs at
   * most the first idle period and can never misprice a ping.
   */
  tierFor(state: SessionState): TtlTier | null {
    if (state.ttlTier != null) return state.ttlTier;
    switch (this.cfg.keepwarm.accountType) {
      case "pro":
        return "5m";
      case "enterprise":
        return "1h";
      default:
        return null;
    }
  }

  private policyFor(state: SessionState): { tier: TtlTier; policy: KeepWarmTierPolicy } | null {
    const tier = this.tierFor(state);
    if (tier == null) return null;
    return { tier, policy: this.cfg.keepwarm.tiers[tier] };
  }

  /** Dashboard toggle. Returns the updated keepwarm block (with reason on refusal). */
  setArmed(sessionId: string, armed: boolean): SessionState["keepwarm"] | { error: string } {
    const state = this.tracker.get(sessionId);
    if (!state) return { error: "unknown session" };
    if (!armed) {
      state.keepwarm.armed = false;
      state.keepwarm.nextPingAt = null;
      state.keepwarm.reason = "disarmed by user";
      return state.keepwarm;
    }
    const gate = this.gate(state);
    if (gate) {
      state.keepwarm.armed = false;
      state.keepwarm.reason = gate;
      return state.keepwarm;
    }
    state.keepwarm.armed = true;
    state.keepwarm.reason = "armed";
    this.schedule(state);
    this.onEvent("keepwarm_armed", sessionId, {});
    return state.keepwarm;
  }

  /** Why keep-warm must NOT run right now; null = allowed. */
  private gate(state: SessionState): string | null {
    if (!this.cfg.keepwarm.enabled) return "keep-warm disabled in settings";
    const resolved = this.policyFor(state);
    if (!resolved) return "no cache write observed yet (and no account type set)";
    const { tier, policy } = resolved;
    if (!policy.arm) return `keep-warm is off for ${tier}-TTL sessions (see account settings)`;
    if (!state.model) return "model unknown";
    const min = minCacheablePrefix(state.model);
    if (state.prefixTokens < min) return `prefix ${state.prefixTokens} < cacheable minimum ${min}`;
    const pings = this.idlePings.get(state.sessionId) ?? 0;
    if (pings >= policy.maxPingsPerIdle) {
      // Past the cap, more pings cost more than the re-write they avoid. If this tier
      // escalates, hand the session to the guardian so the state gets externalized
      // instead of the cache simply being allowed to die unannounced.
      if (policy.escalateToHandoff) {
        this.onEscalate(state.sessionId, `keep-warm ping cap reached on ${tier} tier (${pings}/${policy.maxPingsPerIdle})`);
      }
      return `ping cap reached (${pings}/${policy.maxPingsPerIdle} this idle period)`;
    }
    return null;
  }

  /** Set nextPingAt just before the TTL deadline. */
  private schedule(state: SessionState): void {
    if (!state.keepwarm.armed || state.expiresAt == null) {
      state.keepwarm.nextPingAt = null;
      return;
    }
    state.keepwarm.nextPingAt = state.expiresAt - 30_000; // 30s of slack
  }

  /** Final authorization the Stop hook requests right before pinging. */
  authorize(sessionId: string): { ping: boolean; reason?: string } {
    const state = this.tracker.get(sessionId);
    if (!state) return { ping: false, reason: "unknown session" };
    if (!state.keepwarm.armed) return { ping: false, reason: state.keepwarm.reason };
    const gate = this.gate(state);
    if (gate) {
      state.keepwarm.armed = false;
      state.keepwarm.nextPingAt = null;
      state.keepwarm.reason = gate;
      this.onEvent("keepwarm_stopped", sessionId, { reason: gate });
      return { ping: false, reason: gate };
    }
    const n = (this.idlePings.get(sessionId) ?? 0) + 1;
    this.idlePings.set(sessionId, n);
    state.keepwarm.pings += 1;
    this.awaitingPing.set(sessionId, { authorizedAt: Date.now(), prefix: state.prefixTokens });
    if (!this.idleStart.has(sessionId) && state.lastTurnAt) this.idleStart.set(sessionId, state.lastTurnAt);
    this.onEvent("keepwarm_ping_authorized", sessionId, { n });
    return { ping: true };
  }

  /**
   * Called by the tracker pipeline for every assistant turn.
   * Judges ping turns (hit/miss), reconciles counterfactual savings when the
   * human returns, and reschedules the next ping.
   */
  onAssistantTurn(sessionId: string, turn: AssistantTurn): void {
    const state = this.tracker.get(sessionId);
    if (!state) return;
    const pending = this.awaitingPing.get(sessionId);

    if (pending && turn.usage && Date.parse(turn.timestamp) >= pending.authorizedAt - 5_000) {
      // This is (almost certainly) the ping turn.
      this.awaitingPing.delete(sessionId);
      const hit = turn.usage.cache_read_input_tokens > 0;
      const cost = turn.model ? turnCost(turn.usage, turn.model, turn.timestamp).totalUsd : 0;
      this.store.db
        .prepare(`INSERT INTO pings (session_id, ts, cache_read_tok, cache_w_tok, output_tok, cost_usd, hit) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          sessionId,
          Date.parse(turn.timestamp),
          turn.usage.cache_read_input_tokens,
          turn.usage.cache_creation_input_tokens,
          turn.usage.output_tokens,
          cost,
          hit ? 1 : 0,
        );
      state.keepwarm.netSavedUsd -= cost;
      if (!hit) {
        state.keepwarm.armed = false;
        state.keepwarm.nextPingAt = null;
        state.keepwarm.reason = "auto-disarmed: ping missed the cache (prefix changed or cache gone)";
        this.onEvent("keepwarm_miss_disarm", sessionId, { cost });
        return;
      }
      this.schedule(state); // ping refreshed the TTL; plan the next one
      return;
    }

    // A real (non-ping) turn while armed = the human is back: reconcile savings.
    if (state.keepwarm.armed && (this.idlePings.get(sessionId) ?? 0) > 0 && turn.usage) {
      const pingsThisIdle = this.idlePings.get(sessionId) ?? 0;
      const warmReturn = turn.usage.cache_read_input_tokens > 0;
      const tier = this.tierFor(state);
      if (warmReturn && state.model && tier) {
        // Without pings the cache would have died: the avoided cold re-write is the win.
        // Quote it at the session's own tier — a 1h write costs more than a 5m one, so
        // hardcoding "5m" here understated the savings on every subscription session.
        const avoided = rewriteCostUsd(state.prefixTokens, tier, state.model, state.rateMods);
        state.keepwarm.netSavedUsd += avoided;
        this.onEvent("keepwarm_reconciled", sessionId, { pingsThisIdle, avoidedUsd: avoided });
      }
      this.idlePings.set(sessionId, 0);
      this.idleStart.delete(sessionId);
      this.schedule(state);
    } else if (state.keepwarm.armed) {
      this.schedule(state);
    }
  }

  /** Live break-even numbers for the dashboard. */
  breakEvenFor(sessionId: string): ReturnType<typeof breakEven> | null {
    const state = this.tracker.get(sessionId);
    if (!state?.model) return null;
    const tier = this.tierFor(state);
    if (!tier) return null;
    const measured = this.medianPingOutput(sessionId);
    // At the session's own rates: in fast mode both the ping and the re-write it avoids
    // cost 2x, and quoting either at standard rates would misprice the trade.
    return breakEven(state.prefixTokens, tier, state.model, measured ?? 200, state.rateMods);
  }

  private medianPingOutput(sessionId: string): number | null {
    const rows = this.store.db
      .prepare(`SELECT output_tok FROM pings WHERE session_id = ? AND hit = 1 ORDER BY output_tok`)
      .all(sessionId) as Array<{ output_tok: number }>;
    if (rows.length === 0) return null;
    return rows[Math.floor(rows.length / 2)]!.output_tok;
  }

  /** Estimated ping cost right now (for UI). */
  pingCostFor(sessionId: string): number | null {
    const state = this.tracker.get(sessionId);
    if (!state?.model) return null;
    return pingCostUsd(state.prefixTokens, state.model, this.medianPingOutput(sessionId) ?? 200, state.rateMods);
  }
}
