import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, type StoredTurn } from "../src/store.ts";
import { Auditor } from "../src/audit.ts";

let dir: string;
let store: Store;

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-reprice-"));
  store = new Store(path.join(dir, "test.db"));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function turn(uuid: string, ts: number, model: string | undefined, costUsd: number, sessionId = "sess-a"): void {
  store.insertTurn({
    uuid,
    sessionId,
    ts,
    ...(model ? { model } : {}),
    inputTok: 10,
    outputTok: 100,
    cacheReadTok: 1000,
    cacheW5Tok: 0,
    cacheW1hTok: 50,
    costUsd,
    prefixTok: 1060,
    isSidechain: false,
  });
}

const cost = (uuid: string) =>
  (store.db.prepare(`SELECT cost_usd AS c FROM turns WHERE uuid = ?`).get(uuid) as { c: number }).c;

// Stand-in pricing: opus-5-5 halves, anything else is unchanged, no model is unpriceable.
function costOf(t: StoredTurn): number | null {
  if (!t.model) return null;
  return t.model === "claude-opus-5-5" ? t.costUsd / 2 : t.costUsd;
}

describe("Store.repriceTurns", () => {
  it("rewrites changed turns and reports before/after per model", () => {
    turn("a", T0, "claude-opus-5-5", 2);
    turn("b", T0 + 1, "claude-opus-5", 3);
    const r = store.repriceTurns(costOf);
    expect(r).toMatchObject({ turns: 2, changed: 1, unpriced: 0 });
    expect(r.byModel["claude-opus-5-5"]).toEqual({ turns: 1, changed: 1, beforeUsd: 2, afterUsd: 1 });
    expect(r.byModel["claude-opus-5"]).toEqual({ turns: 1, changed: 0, beforeUsd: 3, afterUsd: 3 });
    expect(cost("a")).toBe(1);
    expect(cost("b")).toBe(3);
  });

  it("writes nothing on a dry run", () => {
    turn("a", T0, "claude-opus-5-5", 2);
    expect(store.repriceTurns(costOf, { dryRun: true }).changed).toBe(1);
    expect(cost("a")).toBe(2);
  });

  it("keeps the stored cost of a turn it can't price instead of zeroing it", () => {
    turn("a", T0, undefined, 0.75);
    const r = store.repriceTurns(costOf);
    expect(r).toMatchObject({ changed: 0, unpriced: 1 });
    expect(cost("a")).toBe(0.75);
  });

  it("carries the new cost to the keep-warm ping recorded for that turn", () => {
    turn("a", T0, "claude-opus-5-5", 2);
    store.db
      .prepare(`INSERT INTO pings (session_id, ts, cache_read_tok, cache_w_tok, output_tok, cost_usd, hit) VALUES (?, ?, 0, 0, 0, ?, 1)`)
      .run("sess-a", T0, 2);
    store.repriceTurns(costOf);
    expect((store.db.prepare(`SELECT cost_usd AS c FROM pings`).get() as { c: number }).c).toBe(1);
  });
});

describe("Auditor.recostWindows", () => {
  it("refreshes a window's local side and leaves its boundaries and meter delta alone", () => {
    turn("a", T0 + HOUR, "claude-opus-5-5", 8, "sess-a");
    turn("b", T0 + 2 * HOUR, "claude-opus-5", 2, "sess-b");
    store.insertAuditWindow({
      startTs: T0,
      endTs: T0 + 3 * HOUR,
      meterDeltaUsd: 6,
      localCostUsd: 10,
      turns: 2,
      sessions: 2,
      models: { "claude-opus-5-5": { costUsd: 8, turns: 1 }, "claude-opus-5": { costUsd: 2, turns: 1 } },
      soleModel: null,
      soleSession: null,
      inputTok: 20,
      outputTok: 200,
      cacheReadTok: 2000,
      cacheW5Tok: 0,
      cacheW1hTok: 100,
    });
    store.repriceTurns(costOf);
    const auditor = new Auditor({ store, quietMs: 15 * 60_000, warmupMs: 0, now: () => T0 + 10 * HOUR });
    expect(auditor.recostWindows()).toBe(1);
    const [w] = store.auditWindows(0, Number.MAX_SAFE_INTEGER);
    expect(w).toMatchObject({ startTs: T0, endTs: T0 + 3 * HOUR, meterDeltaUsd: 6, localCostUsd: 6, turns: 2 });
    expect(w!.models["claude-opus-5-5"]).toEqual({ costUsd: 4, turns: 1 });
  });
});
