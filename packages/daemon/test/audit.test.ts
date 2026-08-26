import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.ts";
import { Auditor } from "../src/audit.ts";

let dir: string;
let store: Store;

const T0 = 1_800_000_000_000;
const QUIET = 15 * 60_000;
const HOUR = 3_600_000;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-audit-"));
  store = new Store(path.join(dir, "test.db"));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function turn(ts: number, costUsd: number, model = "claude-opus-5", sessionId = "sess-a"): void {
  store.insertTurn({
    uuid: `t${seq++}`,
    sessionId,
    ts,
    model,
    inputTok: 100,
    outputTok: 1000,
    cacheReadTok: 50_000,
    cacheW5Tok: 0,
    cacheW1hTok: 2000,
    costUsd,
    prefixTok: 50_000,
    isSidechain: false,
  });
}

function meterSample(ts: number, usedUsd: number): void {
  store.db
    .prepare(`INSERT INTO events (ts, kind, session_id, payload) VALUES (?, 'account_meter_sample', NULL, ?)`)
    .run(ts, JSON.stringify({ usedUsd }));
}

function auditor(): Auditor {
  return new Auditor({ store, quietMs: QUIET, warmupMs: 0, now: () => T0 + 100 * HOUR });
}

describe("Auditor.observe", () => {
  it("closes a window between two quiet readings and reconciles it", () => {
    const a = auditor();
    expect(a.observe(100, T0)).toBeNull(); // first quiet reading only anchors
    turn(T0 + HOUR, 4.0);
    turn(T0 + HOUR + 60_000, 4.0);
    // Still inside the quiet period after the last turn: no boundary yet.
    expect(a.observe(110, T0 + HOUR + 60_000 + QUIET / 2)).toBeNull();
    const w = a.observe(110, T0 + HOUR + 60_000 + QUIET)!;
    expect(w.meterDeltaUsd).toBe(10);
    expect(w.localCostUsd).toBe(8);
    expect(w.turns).toBe(2);
    expect(w.soleModel).toBe("claude-opus-5");
    expect(w.soleSession).toBe("sess-a");
  });

  it("slides the anchor through idle time instead of banking a huge empty window", () => {
    const a = auditor();
    a.observe(100, T0);
    expect(a.observe(100, T0 + HOUR)).toBeNull(); // flat meter, no turns
    expect(a.observe(100, T0 + 2 * HOUR)).toBeNull();
    turn(T0 + 2 * HOUR + 60_000, 1.0);
    const w = a.observe(101.5, T0 + 2 * HOUR + 60_000 + QUIET)!;
    // Measured from the slid anchor, so the window is short — not three hours long.
    expect(w.startTs).toBe(T0 + 2 * HOUR);
    expect(w.meterDeltaUsd).toBe(1.5);
  });

  it("banks a window with no local turns — meter moved somewhere ccc can't see", () => {
    const a = auditor();
    a.observe(100, T0);
    const w = a.observe(102, T0 + HOUR)!;
    expect(w.turns).toBe(0);
    expect(w.meterDeltaUsd).toBe(2);
    expect(a.report(T0 - HOUR).unattributed).toEqual({ n: 1, meterUsd: 2 });
  });

  it("re-anchors instead of reporting negative spend when the billing cycle rolls over", () => {
    const a = auditor();
    a.observe(480, T0);
    expect(a.observe(3.5, T0 + HOUR)).toBeNull();
    turn(T0 + 2 * HOUR, 1.0);
    const w = a.observe(4.7, T0 + 2 * HOUR + QUIET)!;
    expect(w.meterDeltaUsd).toBeCloseTo(1.2); // measured from the post-reset anchor
  });
});

describe("Auditor.report", () => {
  /** Two windows per model, each priced at `ratio` of the meter. */
  function seed(model: string, ratio: number, base: number): void {
    const a = auditor();
    let meter = base;
    let t = T0 + base * HOUR;
    a.observe(meter, t);
    for (let i = 0; i < 10; i++) {
      t += HOUR;
      turn(t, 10 * ratio, model, `sess-${model}`);
      meter += 10;
      t += QUIET;
      a.observe(meter, t);
    }
  }

  it("separates attributed spend from what it can't see, and rates each model", () => {
    seed("claude-opus-5", 0.8, 1);
    seed("claude-sonnet-5", 0.9, 20);
    const r = auditor().report(T0 - HOUR);
    expect(r.attributed.n).toBe(20);
    expect(r.attributed.ratio).toBeCloseTo(0.85, 2);
    const opus = r.byModel.find((m) => m.model === "claude-opus-5")!;
    const sonnet = r.byModel.find((m) => m.model === "claude-sonnet-5")!;
    expect(opus.ratio).toBeCloseTo(0.8, 3);
    expect(sonnet.ratio).toBeCloseTo(0.9, 3);
    expect(r.bySession).toHaveLength(2);
  });

  it("reports the gap per turn and per local dollar, so its shape is checkable", () => {
    seed("claude-opus-5", 0.8, 1);
    const r = auditor().report(T0 - HOUR);
    expect(r.shortfall.totalUsd).toBeCloseTo(20, 4); // $100 meter vs $80 local
    expect(r.shortfall.turns).toBe(10);
    expect(r.shortfall.perTurnUsd).toBeCloseTo(2, 4);
    expect(r.shortfall.perLocalDollar).toBeCloseTo(0.25, 4);
  });

  it("warns only once a baseline has been accepted and the ratio has moved off it", () => {
    seed("claude-opus-5", 0.8, 1);
    const a = auditor();
    expect(a.report(T0 - HOUR).findings.filter((f) => f.kind === "drift")).toEqual([]);
    expect(a.acceptBaselines(T0 - HOUR)).toEqual([{ model: "claude-opus-5", ratio: 0.8, n: 10 }]);
    // Same ratio: nothing to say.
    expect(a.report(T0 - HOUR).findings.filter((f) => f.kind === "drift")).toEqual([]);
    // A rate change lands: the model now prices well off its accepted baseline.
    seed("claude-opus-5", 1.2, 40);
    const drifted = a.report(T0 - HOUR);
    expect(drifted.drift[0]!.baseline).toBeCloseTo(0.8, 3);
    expect(drifted.drift[0]!.current).toBeGreaterThan(0.9);
    expect(drifted.findings.some((f) => f.kind === "drift" && f.severity === "warn")).toBe(true);
  });

  it("refuses to accept a baseline from too few windows", () => {
    seed("claude-opus-5", 0.8, 1);
    store.db.prepare(`DELETE FROM audit_windows WHERE id > 2`).run(); // leave 2
    expect(auditor().acceptBaselines(T0 - HOUR)).toEqual([]);
  });
});

describe("Auditor.backfill", () => {
  it("rebuilds windows from stored meter samples, idempotently", () => {
    // Two work bursts separated by quiet, with the meter sampled as it moved.
    meterSample(T0, 100);
    turn(T0 + HOUR, 4.0);
    meterSample(T0 + HOUR + 60_000, 105);
    turn(T0 + 3 * HOUR, 8.0);
    meterSample(T0 + 3 * HOUR + 60_000, 115);

    const a = new Auditor({ store, quietMs: QUIET, warmupMs: 0, now: () => T0 + 5 * HOUR });
    const first = a.backfill(T0 - HOUR);
    expect(first.windows).toBeGreaterThan(0);
    const r1 = a.report(T0 - 2 * HOUR);
    // Both bursts reconciled: $15 of meter movement against $12 of local cost.
    expect(r1.attributed.meterUsd).toBeCloseTo(15, 2);
    expect(r1.attributed.localUsd).toBeCloseTo(12, 2);

    const second = a.backfill(T0 - HOUR);
    expect(second.windows).toBe(first.windows); // same input, same output
    expect(a.report(T0 - 2 * HOUR).attributed.meterUsd).toBeCloseTo(15, 2);
  });

  it("drops quiet instants inside a poll gap, losing resolution but not correctness", () => {
    meterSample(T0, 100);
    turn(T0 + HOUR, 4.0);
    meterSample(T0 + HOUR + 60_000, 105);
    turn(T0 + 3 * HOUR, 8.0);
    meterSample(T0 + 3 * HOUR + 60_000, 115);
    // Nobody polled across the middle of the period, so the meter's value at the
    // boundary between the two bursts is unknown and that boundary can't be used.
    store.recordAccountPollOk(T0 + HOUR + 90_000, 5 * 60_000);
    store.recordAccountPollOk(T0 + 3 * HOUR, 5 * 60_000);

    const a = new Auditor({ store, quietMs: QUIET, warmupMs: 0, now: () => T0 + 5 * HOUR });
    const res = a.backfill(T0 - HOUR);
    expect(res.skippedInGaps).toBeGreaterThan(0);
    // Dropping the middle boundary merges the two bursts into one wider window. The
    // arithmetic still holds — a delta between two KNOWN readings is authoritative
    // whatever happened in between — so the totals match; only the resolution is lost.
    const r = a.report(T0 - 2 * HOUR);
    expect(r.attributed.n).toBe(1);
    expect(r.attributed.meterUsd).toBeCloseTo(15, 2);
    expect(r.attributed.localUsd).toBeCloseTo(12, 2);
    // ...and with nothing dominating a merged window, it teaches nothing per-session.
    expect(r.bySession).toHaveLength(1);
  });
});
