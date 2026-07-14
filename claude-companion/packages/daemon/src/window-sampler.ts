import type { Store } from "./store.ts";

export interface WindowObservation {
  /** Window name: "five_hour", "seven_day", or whatever the endpoint reports. */
  window: string;
  /** Percent 0-100. */
  utilization: number;
  /** ISO timestamp of the scheduled reset, if known. */
  resetsAt: string | null;
  /** Where the observation came from. */
  source: "oauth" | "courier";
}

/**
 * Persists usage-window observations to the events table so reset behavior is
 * reconstructable from data instead of folklore (e.g. the community finding that
 * the "seven_day" window actually advances every ~72h):
 *  - `account_window_sample` whenever a window's utilization or resets_at changes,
 *  - `account_window_reset` when resets_at moves — its prev→next delta IS the
 *    window's real advance interval.
 * Deduped in memory per window, so 60s polls cost one row only when something moved.
 */
export class WindowSampler {
  private last = new Map<string, { utilization: number; resetsAt: string | null }>();
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  observe(o: WindowObservation): void {
    const prev = this.last.get(o.window);
    if (prev && prev.utilization === o.utilization && prev.resetsAt === o.resetsAt) return;
    this.last.set(o.window, { utilization: o.utilization, resetsAt: o.resetsAt });
    this.store.logEvent("account_window_sample", null, {
      window: o.window,
      utilization: o.utilization,
      resetsAt: o.resetsAt,
      source: o.source,
    });
    if (prev?.resetsAt && o.resetsAt && prev.resetsAt !== o.resetsAt) {
      this.store.logEvent("account_window_reset", null, {
        window: o.window,
        prev: prev.resetsAt,
        next: o.resetsAt,
        utilization: o.utilization,
        source: o.source,
      });
    }
  }
}
