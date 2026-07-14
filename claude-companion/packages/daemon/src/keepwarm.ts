import { breakEven, minCacheablePrefix, pingCostUsd, rewriteCostUsd, turnCost, type AssistantTurn, type SessionState } from "@ccc/core";
import type { CccConfig } from "./config.ts";
import type { SessionTracker } from "./session-tracker.ts";
import type { Store } from "./store.ts";

/**
 * Keep-warm policy engine. The Stop hook is deliberately dumb: it sleeps until
 * state.keepwarm.nextPingAt, then asks /keepwarm/authorize. All spending
 * decisions are made here, and every ping is measured against the transcript;
 * the first cache MISS auto-disarms.
 *
 * Gates (all must pass to arm or authorize):
 *  - last cache write was 5m-tier (1h-tier sessions have nothing to save)
 *  - prefix >= the model's minimum cacheable size
 *  - pings this idle period < soft cap (config, user-overridable)
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

  constructor(opts: {
    tracker: SessionTracker;
    store: Store;
    cfg: CccConfig;
    onEvent: (kind: string, sessionId: string, payload: unknown) => void;
  }) {
    this.tracker = opts.tracker;
    this.store = opts.store;
    this.cfg = opts.cfg;
    this.onEvent = opts.onEvent;
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
    if (state.ttlTier !== "5m") {
      return state.ttlTier === "1h"
        ? "session is on the 1h TTL (subscription) — nothing to keep warm"
        : "no cache write observed yet";
    }
    if (!state.model) return "model unknown";
    const min = minCacheablePrefix(state.model);
    if (state.prefixTokens < min) return `prefix ${state.prefixTokens} < cacheable minimum ${min}`;
    const pings = this.idlePings.get(state.sessionId) ?? 0;
    if (pings >= this.cfg.keepwarm.maxPingsPerIdle) {
      return `ping cap reached (${pings}/${this.cfg.keepwarm.maxPingsPerIdle} this idle period)`;
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
      if (warmReturn && state.model) {
        // Without pings the cache would have died: the avoided cold re-write is the win.
        const avoided = rewriteCostUsd(state.prefixTokens, "5m", state.model);
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
    if (!state?.model || !state.ttlTier) return null;
    const measured = this.medianPingOutput(sessionId);
    return breakEven(state.prefixTokens, state.ttlTier, state.model, measured ?? 200);
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
    return pingCostUsd(state.prefixTokens, state.model, this.medianPingOutput(sessionId) ?? 200);
  }
}
