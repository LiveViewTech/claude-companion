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

  async function fetchDay(server: Server): Promise<{ dayMeterUsd: number | null; dayCostUsd: number }> {
    return (await (await fetch(`http://127.0.0.1:${server.boundPort}/api/day`)).json()) as {
      dayMeterUsd: number | null;
      dayCostUsd: number;
    };
  }

  it("reports meter(now) - meter(midnight) when samples span midnight", async () => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    insertMeterSample(midnight.getTime() - 3600_000, 200.0); // last reading before midnight
    insertMeterSample(midnight.getTime() + 3600_000, 210.0); // intraday sample (ignored by baseline)
    const server = new Server(new SessionTracker(store), store, 0);
    server.accountUsage = () => ({ usage: { usedUsd: 276.3 }, error: null });
    await server.listen();
    try {
      expect((await fetchDay(server)).dayMeterUsd).toBeCloseTo(76.3);
    } finally {
      server.close();
    }
  });

  it("is null without a pre-midnight baseline or after a cycle reset", async () => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const server = new Server(new SessionTracker(store), store, 0);
    server.accountUsage = () => ({ usage: { usedUsd: 50 }, error: null });
    await server.listen();
    try {
      expect((await fetchDay(server)).dayMeterUsd).toBeNull(); // no samples at all
      insertMeterSample(midnight.getTime() - 60_000, 490.0); // baseline above current => meter reset
      expect((await fetchDay(server)).dayMeterUsd).toBeNull();
    } finally {
      server.close();
    }
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
