import fs from "node:fs";
import path from "node:path";
import type { SessionState } from "@ccc/core";
import type { AccountUsage } from "./account-usage.ts";
import type { CccConfig } from "./config.ts";
import type { SessionTracker } from "./session-tracker.ts";
import type { Store } from "./store.ts";
import type { WindowSampler } from "./window-sampler.ts";

interface UsageLimitWindow {
  used_percentage?: number;
  resets_at?: number; // unix seconds
}
interface CourierPayload {
  ts: number;
  // `rate_limits` is Claude Code's own name for these usage windows in the statusline
  // stdin JSON; the courier passes the field through verbatim, so the key is kept as-is.
  // Optional: an API-key seat has no usage windows but still reports a cost.
  rate_limits?: { five_hour?: UsageLimitWindow; seven_day?: UsageLimitWindow };
  /** Claude Code's own running total for the session, from stdin `cost.total_cost_usd`. */
  cost_usd?: number;
}

export interface GuardianNotification {
  sessionId: string;
  /** Null for triggers that aren't usage-window based (context size, keep-warm cap). */
  window: "five_hour" | "seven_day" | null;
  /** Null when there is no percentage to report — don't render "0%". */
  pct: number | null;
  resetsAt: number | null;
  level: "notify" | "act";
  action: "wrapup" | "handoff" | null;
  /** Human-readable cause; present on every "act" notification. */
  reason?: string;
  /** Resolved absolute path of the handoff the instruction names, when the action writes one. */
  handoffPath?: string;
}

/**
 * Usage-limit guardian: consumes the official `rate_limits` field couriered by the statusline,
 * updates session state, and — at configured thresholds — raises notifications
 * and arms a ONE-SHOT wrap-up/handoff instruction for the hooks to deliver.
 *
 * It also owns the courier channel itself, so the sweep hands the other stdin-only field
 * it carries — Claude Code's own session cost — to the tracker. That is a pass-through,
 * not guardian policy: nothing here reads or acts on the number.
 *
 * One-shot keying: (session, window, resets_at, level). A new reset window
 * re-arms; the same window never fires twice (persisted in the meta table so
 * daemon restarts don't re-nag).
 */
export class Guardian {
  private tracker: SessionTracker;
  private store: Store;
  private cfg: CccConfig;
  private courierDir: string;
  private onNotify: (n: GuardianNotification) => void;
  private sampler: WindowSampler | null;

  constructor(opts: {
    tracker: SessionTracker;
    store: Store;
    cfg: CccConfig;
    stateDir: string;
    onNotify: (n: GuardianNotification) => void;
    /** When set, courier usage-limit windows are logged for reset-cadence history. */
    sampler?: WindowSampler;
  }) {
    this.tracker = opts.tracker;
    this.store = opts.store;
    this.cfg = opts.cfg;
    this.courierDir = path.join(opts.stateDir, "courier");
    this.onNotify = opts.onNotify;
    this.sampler = opts.sampler ?? null;
  }

  /** Sessions this much idle or more don't get account-window updates (avoids arming wrap-ups on dead sessions). */
  static ACCOUNT_APPLY_WINDOW_MS = 30 * 60_000;

  /**
   * Feed the account-wide usage windows from the OAuth usage endpoint into every
   * recently-active session. The 5h/7d windows are account-global, so this covers
   * sessions the statusline courier can't reach (VS Code extension sessions have
   * no statusline). Same numbers as the courier; the updatedAt guard in apply()
   * ordering means whichever source is fresher wins. Returns changed sessions.
   */
  applyAccountWindows(usage: AccountUsage): SessionState[] {
    const payload: CourierPayload = {
      ts: usage.fetchedAt,
      rate_limits: {
        ...(usage.fiveHour ? { five_hour: { used_percentage: usage.fiveHour.utilization, resets_at: isoToUnixSeconds(usage.fiveHour.resetsAt) } } : {}),
        ...(usage.sevenDay ? { seven_day: { used_percentage: usage.sevenDay.utilization, resets_at: isoToUnixSeconds(usage.sevenDay.resetsAt) } } : {}),
      },
    };
    if (!payload.rate_limits?.five_hour && !payload.rate_limits?.seven_day) return [];
    const changed: SessionState[] = [];
    const cutoff = Date.now() - Guardian.ACCOUNT_APPLY_WINDOW_MS;
    for (const state of this.tracker.all) {
      if (state.lastTurnAt == null || state.lastTurnAt < cutoff) continue;
      if (state.guardian.updatedAt != null && payload.ts <= state.guardian.updatedAt) continue;
      if (this.apply(state, payload)) changed.push(state);
    }
    return changed;
  }

  /** Scan courier files and update guardian state. Called on an interval. Returns changed sessions. */
  sweep(): SessionState[] {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.courierDir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const changed: SessionState[] = [];
    for (const f of files) {
      const sessionId = f.replace(/\.json$/, "");
      const state = this.tracker.get(sessionId);
      if (!state) continue;
      let payload: CourierPayload;
      try {
        payload = JSON.parse(fs.readFileSync(path.join(this.courierDir, f), "utf8")) as CourierPayload;
      } catch {
        continue;
      }
      if (typeof payload.cost_usd === "number") {
        const updated = this.tracker.applyOfficialCost(sessionId, payload.cost_usd, payload.ts);
        if (updated) changed.push(updated);
      }
      if (!payload.rate_limits) continue;
      if (state.guardian.updatedAt != null && payload.ts <= state.guardian.updatedAt) continue;
      // Courier is the only window source on subscription seats without OAuth
      // windows — sample here (not in apply(), which the OAuth path also uses).
      this.sampleCourier(payload);
      if (this.apply(state, payload)) changed.push(state);
    }
    return changed;
  }

  private sampleCourier(payload: CourierPayload): void {
    if (!this.sampler) return;
    for (const [name, w] of [["five_hour", payload.rate_limits?.five_hour], ["seven_day", payload.rate_limits?.seven_day]] as const) {
      if (w?.used_percentage == null) continue;
      const resetsAt = w.resets_at != null ? new Date(w.resets_at * 1000).toISOString() : null;
      this.sampler.observe({ window: name, utilization: w.used_percentage, resetsAt, source: "courier" });
    }
  }

  private apply(state: SessionState, payload: CourierPayload): boolean {
    const g = state.guardian;
    const fh = payload.rate_limits?.five_hour;
    const sd = payload.rate_limits?.seven_day;
    g.fiveHourPct = fh?.used_percentage ?? g.fiveHourPct;
    g.sevenDayPct = sd?.used_percentage ?? g.sevenDayPct;
    g.fiveHourResetsAt = fh?.resets_at ?? g.fiveHourResetsAt;
    g.sevenDayResetsAt = sd?.resets_at ?? g.sevenDayResetsAt;
    g.updatedAt = payload.ts;

    this.evaluate(state, "five_hour", g.fiveHourPct, g.fiveHourResetsAt);
    this.evaluate(state, "seven_day", g.sevenDayPct, g.sevenDayResetsAt);
    return true;
  }

  private evaluate(state: SessionState, window: "five_hour" | "seven_day", pct: number | null, resetsAt: number | null): void {
    if (pct == null) return;
    const { action, notifyPct, actPct } = this.cfg.guardian;
    if (action === "off") return;

    if (pct >= notifyPct && this.once(state.sessionId, window, resetsAt, "notify")) {
      this.onNotify({ sessionId: state.sessionId, window, pct, resetsAt, level: "notify", action: null });
    }
    if (pct >= actPct && (action === "wrapup" || action === "handoff")) {
      if (this.once(state.sessionId, window, resetsAt, "act")) {
        state.guardian.pendingAction = action;
        state.guardian.pendingReason = `the user's subscription usage limit is nearly exhausted (${Math.round(pct)}% of the ${
          window === "five_hour" ? "5-hour" : "7-day"
        } window)`;
        state.guardian.pendingHandoffPath = this.handoffPathFor(state);
        this.persistPending(state);
        this.store.logEvent("guardian_armed", state.sessionId, { window, pct, action });
        this.onNotify({
          sessionId: state.sessionId,
          window,
          pct,
          resetsAt,
          level: "act",
          action,
          reason: state.guardian.pendingReason ?? undefined,
          handoffPath: state.guardian.pendingHandoffPath ?? undefined,
        });
      }
    }
  }

  /**
   * Arm a one-shot handoff for a reason that isn't a usage window — the keep-warm ping cap,
   * or a context size past `guardian.handoffAtContextTokens`. Reuses the same pendingAction
   * channel the hooks already drain, so delivery, ack and one-shot semantics are unchanged.
   *
   * Keyed on `reasonKey` rather than a reset window, so each distinct trigger fires once per
   * session. Returns true if this call armed it.
   */
  armHandoff(sessionId: string, reasonKey: string, detail?: string, humanReason?: string): boolean {
    const { action } = this.cfg.guardian;
    // "notify-only" deliberately never injects an instruction; honor that here too.
    if (action !== "wrapup" && action !== "handoff") return false;
    const state = this.tracker.get(sessionId);
    if (!state) return false;
    // Never stack on top of an undelivered instruction.
    if (state.guardian.pendingAction) return false;
    if (!this.once(sessionId, `reason:${reasonKey}`, null, "act")) return false;
    state.guardian.pendingAction = action;
    // Never fall back to the usage-limit wording: these triggers have nothing to do with
    // usage windows, and on a fixed-rate seat there is no window to be near the end of.
    state.guardian.pendingReason = humanReason ?? detail ?? "this session should capture its state now";
    state.guardian.pendingHandoffPath = this.handoffPathFor(state);
    this.persistPending(state);
    this.store.logEvent("guardian_armed", sessionId, { reason: reasonKey, detail, action });
    // window/pct are null: there is no usage window behind this trigger, and passing 0
    // made the toast read "Usage limit 0% — wrapping up".
    this.onNotify({
      sessionId,
      window: null,
      pct: null,
      resetsAt: null,
      level: "act",
      action,
      reason: state.guardian.pendingReason ?? undefined,
      handoffPath: state.guardian.pendingHandoffPath ?? undefined,
    });
    return true;
  }

  /**
   * Context-size trigger, called per assistant turn. Independent of usage windows, which is
   * what makes it the useful one on a fixed-token-rate seat: there is no percentage to watch,
   * only a context that has grown expensive to keep carrying.
   */
  onAssistantTurn(sessionId: string): void {
    const limit = this.cfg.guardian.handoffAtContextTokens;
    if (limit == null) return;
    const state = this.tracker.get(sessionId);
    if (!state || state.prefixTokens < limit) return;
    this.armHandoff(
      sessionId,
      `context:${limit}`,
      `prefix ${state.prefixTokens} tokens >= ${limit}`,
      `this session's context has grown to ${Math.round(state.prefixTokens / 1000)}K tokens, which is expensive to keep re-reading every turn`,
    );
  }

  /**
   * Persist the armed-but-undelivered block. The one-shot key in `meta` outlives the process
   * while the instruction itself lived only in memory, so a daemon restart between arming and
   * delivery dropped the handoff AND left the key behind — the trigger could then never fire
   * again for that (session, threshold). Observed live: a restart at 20:03 silently ate a
   * handoff armed at 20:02. Persisting the block is the narrow fix; moving the one-shot key to
   * delivery time instead would re-arm on every sweep until a surface picked it up, which on
   * the usage-window path is a toast per sweep.
   */
  private persistPending(state: SessionState): void {
    const g = state.guardian;
    if (!g.pendingAction && !g.resumePrompt) {
      this.store.delMeta(`guardian_pending:${state.sessionId}`);
      return;
    }
    this.store.setMeta(
      `guardian_pending:${state.sessionId}`,
      JSON.stringify({
        pendingAction: g.pendingAction,
        pendingReason: g.pendingReason,
        pendingHandoffPath: g.pendingHandoffPath,
        resumePrompt: g.resumePrompt,
      }),
    );
  }

  /**
   * Re-attach any undelivered instruction (or unshown resume prompt) to its session after a
   * restart. Call once at startup, AFTER the tracker has restored its sessions and BEFORE the
   * backfill replays turns — a replayed turn re-enters `onAssistantTurn`, which must see the
   * pending action so it doesn't stack a second one on top. Returns the sessions it changed.
   */
  restorePending(): SessionState[] {
    const changed: SessionState[] = [];
    for (const state of this.tracker.all) {
      const raw = this.store.getMeta(`guardian_pending:${state.sessionId}`);
      if (!raw) continue;
      let saved: Partial<SessionState["guardian"]>;
      try {
        saved = JSON.parse(raw) as Partial<SessionState["guardian"]>;
      } catch {
        this.store.delMeta(`guardian_pending:${state.sessionId}`);
        continue;
      }
      const action = saved.pendingAction;
      state.guardian.pendingAction = action === "wrapup" || action === "handoff" ? action : null;
      state.guardian.pendingReason = saved.pendingReason ?? null;
      state.guardian.pendingHandoffPath = saved.pendingHandoffPath ?? null;
      state.guardian.resumePrompt = saved.resumePrompt ?? null;
      changed.push(state);
    }
    return changed;
  }

  /**
   * Resolve `guardian.handoffPath` against the session's own cwd, so the instruction can
   * name an exact file. When the cwd is unknown (a session seen only through the
   * transcript, before any hook has reported one) the configured path is handed over
   * as-is and the model resolves it itself — the pre-existing behavior, not a regression.
   */
  private handoffPathFor(state: SessionState): string {
    const configured = this.cfg.guardian.handoffPath || "HANDOFF.md";
    if (path.isAbsolute(configured)) return configured;
    return state.cwd ? path.resolve(state.cwd, configured) : configured;
  }

  /**
   * The one output aimed at the human rather than at Claude: a prompt they can paste into
   * a fresh session. Built here because this is where the resolved path lives, and shown by
   * the Stop hook at the END of the turn that delivered the instruction — by which point
   * Claude has actually written the handoff, so the prompt isn't pointing at a file that
   * doesn't exist yet.
   *
   * Handoff only. A "wrapup" spreads its state across whatever docs the project already has,
   * so there is no single path to point a resume prompt at; inventing one would be worse
   * than saying nothing.
   */
  private resumePromptFor(action: string, handoffPath: string | null): string | null {
    if (action !== "handoff" || !handoffPath) return null;
    return (
      `Read ${handoffPath} and pick up where it leaves off — start from its next-actions section. ` +
      `Trust what it records instead of re-deriving it, and tell me if anything in it contradicts the code.`
    );
  }

  /** True exactly once per (session, window, resets_at, level). */
  private once(sessionId: string, window: string, resetsAt: number | null, level: string): boolean {
    const key = `guardian:${sessionId}:${window}:${resetsAt ?? "na"}:${level}`;
    if (this.store.getMeta(key)) return false;
    this.store.setMeta(key, String(Date.now()));
    return true;
  }

  /**
   * Hook acknowledged delivery: clear pending so it can never repeat, and hand the human
   * their resume prompt. Delivery is the right moment to arm that prompt — not arming —
   * because until a surface has actually injected the instruction, nothing has been asked
   * of Claude and there is nothing for the human to resume from.
   */
  ack(sessionId: string, action: string): boolean {
    const state = this.tracker.get(sessionId);
    if (!state || state.guardian.pendingAction !== action) return false;
    const resume = this.resumePromptFor(action, state.guardian.pendingHandoffPath);
    state.guardian.pendingAction = null;
    state.guardian.pendingReason = null;
    state.guardian.pendingHandoffPath = null;
    state.guardian.resumePrompt = resume;
    this.persistPending(state);
    this.store.logEvent("guardian_delivered", sessionId, { action, resumePrompt: resume != null });
    return true;
  }

  /** A surface showed the resume prompt to the human: clear it so it appears exactly once. */
  resumeShown(sessionId: string): boolean {
    const state = this.tracker.get(sessionId);
    if (!state || !state.guardian.resumePrompt) return false;
    state.guardian.resumePrompt = null;
    this.persistPending(state);
    this.store.logEvent("guardian_resume_shown", sessionId, {});
    return true;
  }
}

function isoToUnixSeconds(iso: string | null): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.round(ms / 1000) : undefined;
}
