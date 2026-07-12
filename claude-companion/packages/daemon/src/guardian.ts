import fs from "node:fs";
import path from "node:path";
import type { SessionState } from "@ccc/core";
import type { CccConfig } from "./config.ts";
import type { SessionTracker } from "./session-tracker.ts";
import type { Store } from "./store.ts";

interface RateLimitWindow {
  used_percentage?: number;
  resets_at?: number; // unix seconds
}
interface CourierPayload {
  ts: number;
  rate_limits: { five_hour?: RateLimitWindow; seven_day?: RateLimitWindow };
}

export interface GuardianNotification {
  sessionId: string;
  window: "five_hour" | "seven_day";
  pct: number;
  resetsAt: number | null;
  level: "notify" | "act";
  action: "wrapup" | "handoff" | null;
}

/**
 * Rate-limit guardian: consumes official rate_limits couriered by the statusline,
 * updates session state, and — at configured thresholds — raises notifications
 * and arms a ONE-SHOT wrap-up/handoff instruction for the hooks to deliver.
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

  constructor(opts: {
    tracker: SessionTracker;
    store: Store;
    cfg: CccConfig;
    stateDir: string;
    onNotify: (n: GuardianNotification) => void;
  }) {
    this.tracker = opts.tracker;
    this.store = opts.store;
    this.cfg = opts.cfg;
    this.courierDir = path.join(opts.stateDir, "courier");
    this.onNotify = opts.onNotify;
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
      if (state.guardian.updatedAt != null && payload.ts <= state.guardian.updatedAt) continue;
      if (this.apply(state, payload)) changed.push(state);
    }
    return changed;
  }

  private apply(state: SessionState, payload: CourierPayload): boolean {
    const g = state.guardian;
    const fh = payload.rate_limits.five_hour;
    const sd = payload.rate_limits.seven_day;
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
        this.store.logEvent("guardian_armed", state.sessionId, { window, pct, action });
        this.onNotify({ sessionId: state.sessionId, window, pct, resetsAt, level: "act", action });
      }
    }
  }

  /** True exactly once per (session, window, resets_at, level). */
  private once(sessionId: string, window: string, resetsAt: number | null, level: string): boolean {
    const key = `guardian:${sessionId}:${window}:${resetsAt ?? "na"}:${level}`;
    if (this.store.getMeta(key)) return false;
    this.store.setMeta(key, String(Date.now()));
    return true;
  }

  /** Hook acknowledged delivery: clear pending so it can never repeat. */
  ack(sessionId: string, action: string): boolean {
    const state = this.tracker.get(sessionId);
    if (!state || state.guardian.pendingAction !== action) return false;
    state.guardian.pendingAction = null;
    this.store.logEvent("guardian_delivered", sessionId, { action });
    return true;
  }
}
