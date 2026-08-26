import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.ts";
import { AwakeTracker, awayCoverageMs } from "../src/awake-tracker.ts";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-awake-"));
  store = new Store(path.join(dir, "test.db"));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Test clocks that behave like the real pair: `run` advances both (an ordinary tick, or
 * a late one), `sleep` advances only wall time — which is exactly what a system suspend
 * does to CLOCK_MONOTONIC.
 */
function clocks(startWall: number) {
  let wall = startWall;
  let mono = 0;
  return {
    now: () => wall,
    mono: () => mono,
    run: (ms: number) => {
      wall += ms;
      mono += ms;
    },
    sleep: (ms: number) => {
      wall += ms;
    },
  };
}

describe("AwakeTracker", () => {
  const T0 = 1_800_000_000_000;

  it("records a suspend from the wall-vs-monotonic divergence", () => {
    const c = clocks(T0);
    const t = new AwakeTracker({ store, now: c.now, mono: c.mono });
    c.run(30_000);
    expect(t.tick()).toBeNull();
    c.run(30_000);
    c.sleep(9 * 3600_000); // lid closed, nine hours in a backpack
    const w = t.tick()!;
    expect(w.reason).toBe("suspend");
    expect(w.ms).toBe(9 * 3600_000);
    expect(w.end).toBe(c.now());
    expect(store.awayWindowsSince(0)).toHaveLength(1);
  });

  it("ignores a late tick, which advances both clocks together", () => {
    const c = clocks(T0);
    const t = new AwakeTracker({ store, now: c.now, mono: c.mono });
    c.run(20 * 60_000); // event loop stalled 20 min — starvation, not sleep
    expect(t.tick()).toBeNull();
    expect(store.awayWindowsSince(0)).toEqual([]);
  });

  it("ignores a suspend too short to affect a baseline", () => {
    const c = clocks(T0);
    const t = new AwakeTracker({ store, now: c.now, mono: c.mono });
    c.run(30_000);
    c.sleep(45_000);
    expect(t.tick()).toBeNull();
    expect(store.awayWindowsSince(0)).toEqual([]);
  });

  it("attributes pre-process downtime to the machine being off when it booted after the last beat", () => {
    const c = clocks(T0);
    const first = new AwakeTracker({ store, now: c.now, mono: c.mono });
    first.start();
    first.stop();
    c.sleep(10 * 3600_000); // machine off overnight
    const c2 = clocks(c.now());
    const second = new AwakeTracker({ store, now: c2.now, mono: c2.mono, uptimeMs: () => 5 * 60_000 }); // booted 5 min ago
    second.start();
    second.stop();
    const [w] = store.awayWindowsSince(0);
    expect(w!.reason).toBe("machine-off");
    expect(w!.ms).toBe(10 * 3600_000);
  });

  it("calls it daemon-down when the machine stayed up through the gap", () => {
    const c = clocks(T0);
    const first = new AwakeTracker({ store, now: c.now, mono: c.mono });
    first.start();
    first.stop();
    c.sleep(3 * 3600_000);
    const c2 = clocks(c.now());
    const second = new AwakeTracker({ store, now: c2.now, mono: c2.mono, uptimeMs: () => 40 * 3600_000 }); // up for days
    second.start();
    second.stop();
    expect(store.awayWindowsSince(0)[0]!.reason).toBe("daemon-down");
  });

  it("writes no startup window on a first run with no heartbeat on record", () => {
    const c = clocks(T0);
    const t = new AwakeTracker({ store, now: c.now, mono: c.mono });
    t.start();
    t.stop();
    expect(store.awayWindowsSince(0)).toEqual([]);
  });
});

describe("awayCoverageMs", () => {
  it("clips to the interval and merges overlapping windows", () => {
    const windows = [
      { start: 0, end: 100 },
      { start: 50, end: 150 }, // overlaps the first — counted once
      { start: 400, end: 900 }, // tail runs past the interval end
    ];
    expect(awayCoverageMs(windows, 0, 500)).toBe(250); // [0,150] + [400,500]
    expect(awayCoverageMs(windows, 120, 130)).toBe(10);
    expect(awayCoverageMs([], 0, 500)).toBe(0);
    expect(awayCoverageMs([{ start: 600, end: 700 }], 0, 500)).toBe(0); // disjoint
  });
});
