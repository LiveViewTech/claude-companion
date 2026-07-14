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
