import os from "node:os";
import { performance } from "node:perf_hooks";
import type { Store } from "./store.ts";

/** Why nobody was watching the account meter for a while. */
export type AwayReason = "suspend" | "machine-off" | "daemon-down";

export interface AwayWindow {
  /** First instant we were no longer watching. */
  start: number;
  /** Instant we came back. */
  end: number;
  ms: number;
  reason: AwayReason;
}

export interface AwakeTrackerOptions {
  store: Store;
  /** Heartbeat period. Shorter = tighter bound on when a suspend started. */
  heartbeatMs?: number;
  /**
   * Wall-vs-monotonic divergence below this is noise, not a suspend (clock steps
   * from NTP, rounding). A late timer diverges by ~0 because both clocks advance
   * together, so this only has to cover clock adjustment.
   */
  slackMs?: number;
  /** Gaps shorter than this aren't worth recording. */
  minAwayMs?: number;
  now?: () => number;
  /** Monotonic clock. Frozen while the system sleeps — that's the whole mechanism. */
  mono?: () => number;
  /** Milliseconds since the machine booted, for telling a reboot from a dead daemon. */
  uptimeMs?: () => number;
  log?: (msg: string) => void;
}

/**
 * Separates "the machine was asleep" from "the daemon was broken".
 *
 * A heartbeat samples the wall clock and the monotonic clock together. Wall time keeps
 * running through a system suspend; CLOCK_MONOTONIC (what performance.now() reads on
 * Linux, and mach_absolute_time on macOS) does not. So a tick whose wall delta exceeds
 * its monotonic delta was preceded by a suspend of about that difference, while a tick
 * that is merely late — GC, load, a stalled event loop — advances both clocks equally
 * and is correctly ignored.
 *
 * Daemon downtime is caught separately: the last heartbeat is persisted to `meta`, so a
 * fresh process can see how long nobody was watching, and boot time says whether the
 * machine was off for it.
 *
 * The consumer is the "today" baseline. `dayMeterUsd` is a delta against the meter's
 * reading at local midnight, and a laptop that sleeps in a backpack overnight never has
 * one. An away window covering midnight explains the miss, which makes the last
 * pre-sleep reading a usable baseline instead of a reason to refuse the number.
 */
export class AwakeTracker {
  private store: Store;
  private heartbeatMs: number;
  private slackMs: number;
  private minAwayMs: number;
  private now: () => number;
  private mono: () => number;
  private uptimeMs: () => number;
  private log?: (msg: string) => void;
  private lastWall: number;
  private lastMono: number;
  private timer: NodeJS.Timeout | null = null;

  private static META_KEY = "awake_last_seen";

  constructor(opts: AwakeTrackerOptions) {
    this.store = opts.store;
    this.heartbeatMs = opts.heartbeatMs ?? 30_000;
    this.slackMs = opts.slackMs ?? 20_000;
    this.minAwayMs = opts.minAwayMs ?? 120_000;
    this.now = opts.now ?? Date.now;
    this.mono = opts.mono ?? (() => performance.now());
    this.uptimeMs = opts.uptimeMs ?? (() => os.uptime() * 1000);
    this.log = opts.log;
    this.lastWall = this.now();
    this.lastMono = this.mono();
  }

  start(): void {
    this.noteStartupGap();
    this.beat();
    this.timer = setInterval(() => this.tick(), this.heartbeatMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One heartbeat. Returns the away window it just closed, or null when the tick was
   * ordinary. Exposed so tests can drive it with injected clocks.
   */
  tick(): AwayWindow | null {
    const wall = this.now();
    const mono = this.mono();
    const slept = wall - this.lastWall - (mono - this.lastMono);
    this.lastWall = wall;
    this.lastMono = mono;
    this.store.setMeta(AwakeTracker.META_KEY, String(wall));
    if (slept < this.minAwayMs || slept < this.slackMs) return null;
    return this.record({ start: wall - slept, end: wall, ms: slept, reason: "suspend" });
  }

  /**
   * Downtime from before this process existed: the previous heartbeat is in `meta`.
   * Boot time distinguishes a machine that was off from a daemon that died under a
   * machine that stayed up — the second one is a real bug worth seeing in the log.
   */
  private noteStartupGap(): AwayWindow | null {
    const raw = this.store.getMeta(AwakeTracker.META_KEY);
    const prev = raw != null ? Number(raw) : null;
    if (prev == null || !Number.isFinite(prev)) return null;
    const wall = this.now();
    const ms = wall - prev;
    if (ms < this.minAwayMs) return null;
    const bootedAt = wall - this.uptimeMs();
    const reason: AwayReason = bootedAt > prev ? "machine-off" : "daemon-down";
    return this.record({ start: prev, end: wall, ms, reason });
  }

  private beat(): void {
    this.lastWall = this.now();
    this.lastMono = this.mono();
    this.store.setMeta(AwakeTracker.META_KEY, String(this.lastWall));
  }

  private record(w: AwayWindow): AwayWindow {
    this.store.recordAwayWindow(w);
    this.log?.(`awake-tracker: ${w.reason} for ${Math.round(w.ms / 60_000)} min, back at ${new Date(w.end).toISOString()}`);
    return w;
  }
}

/** Total milliseconds of [startMs, endMs] that the given away windows account for. */
export function awayCoverageMs(windows: Array<{ start: number; end: number }>, startMs: number, endMs: number): number {
  const spans = windows
    .map((w) => [Math.max(w.start, startMs), Math.min(w.end, endMs)] as const)
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cursor = -Infinity;
  for (const [a, b] of spans) {
    const from = Math.max(a, cursor);
    if (b > from) total += b - from;
    cursor = Math.max(cursor, b);
  }
  return total;
}
