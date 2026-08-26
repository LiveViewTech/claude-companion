import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.ts";
import { SessionTracker } from "../src/session-tracker.ts";
import { Server } from "../src/server.ts";
import { WindowSampler } from "../src/window-sampler.ts";

let dir: string;
let store: Store;
let sampler: WindowSampler;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-sampler-"));
  store = new Store(path.join(dir, "test.db"));
  sampler = new WindowSampler(store);
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function events(kind: string): Array<Record<string, unknown>> {
  return (store.db.prepare(`SELECT payload FROM events WHERE kind = ? ORDER BY id`).all(kind) as Array<{ payload: string }>).map(
    (r) => JSON.parse(r.payload) as Record<string, unknown>,
  );
}

describe("WindowSampler", () => {
  it("logs a sample only when a window's value changes", () => {
    sampler.observe({ window: "seven_day", utilization: 10, resetsAt: "2026-07-16T05:00:00Z", source: "oauth" });
    sampler.observe({ window: "seven_day", utilization: 10, resetsAt: "2026-07-16T05:00:00Z", source: "oauth" }); // no-op
    sampler.observe({ window: "seven_day", utilization: 12, resetsAt: "2026-07-16T05:00:00Z", source: "oauth" });
    expect(events("account_window_sample").map((p) => p["utilization"])).toEqual([10, 12]);
    expect(events("account_window_reset")).toEqual([]);
  });

  it("logs a reset when resets_at advances, carrying prev→next", () => {
    sampler.observe({ window: "seven_day", utilization: 96, resetsAt: "2026-07-16T05:00:00Z", source: "courier" });
    sampler.observe({ window: "seven_day", utilization: 1, resetsAt: "2026-07-19T05:00:00Z", source: "courier" });
    const resets = events("account_window_reset");
    expect(resets).toHaveLength(1);
    expect(resets[0]).toMatchObject({ window: "seven_day", prev: "2026-07-16T05:00:00Z", next: "2026-07-19T05:00:00Z" });
  });

  it("logs the account meter only when it moves", () => {
    sampler.observeMeter(239.28);
    sampler.observeMeter(239.28); // no-op
    sampler.observeMeter(240.01);
    expect(events("account_meter_sample").map((p) => p["usedUsd"])).toEqual([239.28, 240.01]);
  });
});

describe("GET /api/day dayMeterUsd", () => {
  function insertMeterSample(ts: number, usedUsd: number): void {
    store.db
      .prepare(`INSERT INTO events (ts, kind, session_id, payload) VALUES (?, 'account_meter_sample', NULL, ?)`)
      .run(ts, JSON.stringify({ usedUsd }));
  }

  interface DayBody {
    dayMeterUsd: number | null;
    dayCostUsd: number;
    dayBaseline: { at: number; kind: string; awayMinutes: number | null; awayReason: string | null } | null;
    meterStale: { fetchedAt: number; ageMinutes: number } | null;
  }

  /** A live meter reading — fetchedAt matters now: a stale one is withheld, not subtracted. */
  function meter(usedUsd: number, fetchedAt = Date.now()): () => unknown {
    return () => ({ usage: { usedUsd, fetchedAt }, error: null });
  }

  async function fetchDay(server: Server): Promise<DayBody> {
    return (await (await fetch(`http://127.0.0.1:${server.boundPort}/api/day`)).json()) as DayBody;
  }

  function midnightMs(): number {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  it("reports meter(now) - meter(midnight) when samples span midnight", async () => {
    const midnight = midnightMs();
    insertMeterSample(midnight - 3600_000, 200.0); // last reading before midnight
    insertMeterSample(midnight + 3600_000, 210.0); // intraday sample (ignored by baseline)
    const server = new Server(new SessionTracker(store), store, 0);
    server.accountUsage = meter(276.3);
    await server.listen();
    try {
      const day = await fetchDay(server);
      expect(day.dayMeterUsd).toBeCloseTo(76.3);
      expect(day.dayBaseline!.kind).toBe("midnight");
      expect(day.meterStale).toBeNull();
    } finally {
      server.close();
    }
  });

  it("is null without a pre-midnight baseline or after a cycle reset", async () => {
    const midnight = midnightMs();
    const server = new Server(new SessionTracker(store), store, 0);
    server.accountUsage = meter(50);
    await server.listen();
    try {
      expect((await fetchDay(server)).dayMeterUsd).toBeNull(); // no samples at all
      insertMeterSample(midnight - 60_000, 490.0); // baseline above current => meter reset
      expect((await fetchDay(server)).dayMeterUsd).toBeNull();
    } finally {
      server.close();
    }
  });

  it("withholds the delta and reports the age when the newest reading is stale", async () => {
    const midnight = midnightMs();
    insertMeterSample(midnight - 3600_000, 200.0);
    const server = new Server(new SessionTracker(store), store, 0);
    // The 2026-08-25 failure: a wedged poller froze the meter, so current and baseline
    // were the same number and "today" rendered as a confident $0.00.
    server.accountUsage = meter(200.0, Date.now() - 19 * 3600_000);
    await server.listen();
    try {
      const day = await fetchDay(server);
      expect(day.dayMeterUsd).toBeNull();
      expect(day.dayBaseline).toBeNull();
      expect(day.meterStale!.ageMinutes).toBe(19 * 60);
    } finally {
      server.close();
    }
  });

  it("keeps the pre-sleep reading as the baseline when the machine slept through midnight", async () => {
    const midnight = midnightMs();
    insertMeterSample(midnight - 3 * 3600_000, 200.0);
    store.recordAccountPollOk(midnight - 3 * 3600_000, 5 * 60_000); // last ok before the laptop closed
    // Suspend covers all but the two minutes between that poll and the lid closing.
    store.recordAwayWindow({
      start: midnight - 3 * 3600_000 + 120_000,
      end: midnight + 3600_000,
      ms: 4 * 3600_000 - 120_000,
      reason: "suspend",
    });
    store.recordAccountPollOk(midnight + 3600_000, 5 * 60_000); // first poll after waking
    const server = new Server(new SessionTracker(store), store, 0);
    server.accountUsage = meter(276.3);
    await server.listen();
    try {
      const day = await fetchDay(server);
      expect(day.dayMeterUsd).toBeCloseTo(76.3); // a number, not a warning
      expect(day.dayBaseline!.kind).toBe("pre-away");
      expect(day.dayBaseline!.awayReason).toBe("suspend");
      expect(day.dayBaseline!.at).toBe(midnight - 3 * 3600_000);
    } finally {
      server.close();
    }
  });

  it("flags the baseline as stale when polling broke across midnight and nothing was asleep", async () => {
    const midnight = midnightMs();
    insertMeterSample(midnight - 3 * 3600_000, 200.0);
    store.recordAccountPollOk(midnight - 3 * 3600_000, 5 * 60_000); // last ok, pre-outage
    store.recordAccountPollOk(midnight + 3600_000, 5 * 60_000); // recovery — logs the straddling gap
    const server = new Server(new SessionTracker(store), store, 0);
    server.accountUsage = meter(276.3);
    await server.listen();
    try {
      const day = await fetchDay(server);
      expect(day.dayMeterUsd).toBeCloseTo(76.3); // still shown — with the caveat attached
      expect(day.dayBaseline!.kind).toBe("stale");
      expect(day.dayBaseline!.awayMinutes).toBeNull();
    } finally {
      server.close();
    }
  });

  it("treats an ordinary mid-day poll gap as a clean midnight baseline", async () => {
    const midnight = midnightMs();
    insertMeterSample(midnight - 3600_000, 200.0);
    // Continuous coverage across midnight, then a >5min restart gap well into the day.
    store.recordAccountPollOk(midnight - 60_000, 5 * 60_000);
    store.recordAccountPollOk(midnight + 60_000, 5 * 60_000);
    store.recordAccountPollOk(midnight + 4 * 3600_000, 5 * 60_000); // intraday restart gap
    const server = new Server(new SessionTracker(store), store, 0);
    server.accountUsage = meter(210.0);
    await server.listen();
    try {
      const day = await fetchDay(server);
      expect(day.dayBaseline!.kind).toBe("midnight");
      expect(day.dayMeterUsd).toBeCloseTo(10.0);
    } finally {
      server.close();
    }
  });
});

describe("Store.recordAccountPollOk / pollGapCovering", () => {
  it("logs a gap row only when successful polls fall more than the threshold apart", () => {
    const t0 = 1_000_000_000_000;
    store.recordAccountPollOk(t0, 5 * 60_000);
    store.recordAccountPollOk(t0 + 60_000, 5 * 60_000); // within threshold — no gap
    store.recordAccountPollOk(t0 + 60_000 + 10 * 60_000, 5 * 60_000); // 10 min later — gap
    const rows = store.db.prepare(`SELECT payload FROM events WHERE kind = 'account_poll_gap'`).all() as Array<{ payload: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload).gapMs).toBe(10 * 60_000);
  });

  it("pollGapCovering finds only a gap whose interval straddles the instant", () => {
    const t0 = 1_000_000_000_000;
    store.recordAccountPollOk(t0, 5 * 60_000);
    store.recordAccountPollOk(t0 + 60 * 60_000, 5 * 60_000); // gap [t0, t0+60min]
    expect(store.pollGapCovering(t0 + 30 * 60_000)).not.toBeNull(); // inside
    expect(store.pollGapCovering(t0 + 90 * 60_000)).toBeNull(); // after
    expect(store.pollGapCovering(t0 - 60_000)).toBeNull(); // before
  });
});

describe("GET /api/windows", () => {
  it("serves series with reset gaps and an informativeness flag", async () => {
    // 72h advance on the weekly window; five_hour never moves off zero.
    sampler.observe({ window: "seven_day", utilization: 96, resetsAt: "2026-07-16T05:00:00Z", source: "oauth" });
    sampler.observe({ window: "seven_day", utilization: 2, resetsAt: "2026-07-19T05:00:00Z", source: "oauth" });
    sampler.observe({ window: "five_hour", utilization: 0, resetsAt: null, source: "oauth" });

    const tracker = new SessionTracker(store);
    const server = new Server(tracker, store, 0);
    await server.listen();
    try {
      const body = (await (await fetch(`http://127.0.0.1:${server.boundPort}/api/windows`)).json()) as {
        series: Array<{ name: string; points: unknown[]; resets: Array<{ gapHours: number | null }> }>;
        informative: boolean;
      };
      expect(body.informative).toBe(true);
      const weekly = body.series.find((s) => s.name === "seven_day")!;
      expect(weekly.points).toHaveLength(2);
      expect(weekly.resets[0]!.gapHours).toBe(72);
    } finally {
      server.close();
    }
  });

  it("is not informative when nothing ever moved", async () => {
    sampler.observe({ window: "amber_ladder", utilization: 0, resetsAt: "2026-09-02T06:59:59Z", source: "oauth" });
    const tracker = new SessionTracker(store);
    const server = new Server(tracker, store, 0);
    await server.listen();
    try {
      const body = (await (await fetch(`http://127.0.0.1:${server.boundPort}/api/windows`)).json()) as { informative: boolean };
      expect(body.informative).toBe(false);
    } finally {
      server.close();
    }
  });
});
