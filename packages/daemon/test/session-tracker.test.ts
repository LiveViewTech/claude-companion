import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseLine } from "@ccc/core";
import { Store } from "../src/store.ts";
import { SessionTracker } from "../src/session-tracker.ts";

let dir: string;
let store: Store;
let tracker: SessionTracker;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-tracker-"));
  store = new Store(path.join(dir, "test.db"));
  tracker = new SessionTracker(store);
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function assistantLine(opts: {
  uuid: string;
  ts: string;
  requestId?: string;
  cacheRead?: number;
  write5m?: number;
  write1h?: number;
  input?: number;
  output?: number;
  command?: string;
}): string {
  const w5 = opts.write5m ?? 0;
  const w1 = opts.write1h ?? 0;
  return JSON.stringify({
    type: "assistant",
    uuid: opts.uuid,
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
    sessionId: "sess-t",
    timestamp: opts.ts,
    cwd: "/repo",
    version: "2.1.207",
    isSidechain: false,
    message: {
      model: "claude-fable-5",
      role: "assistant",
      content: opts.command
        ? [{ type: "tool_use", id: `tu-${opts.uuid}`, name: "Bash", input: { command: opts.command } }]
        : [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: opts.input ?? 10,
        output_tokens: opts.output ?? 100,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: w5 + w1,
        cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 },
      },
    },
  });
}

function ingest(line: string, live = false): void {
  const { entry } = parseLine(line);
  if (!entry) throw new Error("fixture failed to parse");
  tracker.ingest(entry, "proj-slug", live);
}

describe("SessionTracker", () => {
  it("tracks tier, countdown, prefix, and cumulative cost", () => {
    ingest(assistantLine({ uuid: "t1", ts: "2026-07-11T10:00:00.000Z", write5m: 50_000, input: 100, output: 500 }));
    const s = tracker.get("sess-t")!;
    expect(s.ttlTier).toBe("5m");
    expect(s.lastTurnAt).toBe(Date.parse("2026-07-11T10:00:00.000Z"));
    expect(s.expiresAt).toBe(s.lastTurnAt! + 300_000);
    expect(s.prefixTokens).toBe(50_100);
    // rewrite = 50_100/1M * 10 * 1.25
    expect(s.rewriteCostUsd).toBeCloseTo(0.626, 2);
    expect(s.turns).toBe(1);
    expect(s.sessionCostUsd).toBeGreaterThan(0);
  });

  it("computes the prefix tax (carry-cost/turn) on the current + candidate models", () => {
    // 50_100-token prefix on Fable 5 ($10/M): 0.0501M * 10 * 0.1 = $0.0501/turn.
    ingest(assistantLine({ uuid: "px1", ts: "2026-07-11T10:00:00.000Z", write5m: 50_000, input: 100, output: 500 }));
    const s = tracker.get("sess-t")!;
    expect(s.prefixTaxUsd).toBeCloseTo(0.0501, 6);
    // Same prefix priced on Opus 4.8 ($5/M) would be half — surfaced for the switch-vs-fresh compare.
    expect(s.prefixTaxByModel["claude-opus-4-8"]).toBeCloseTo(0.02505, 6);
    expect(s.prefixTaxByModel["claude-fable-5"]).toBeCloseTo(0.0501, 6);
  });

  it("is idempotent on duplicate entries (re-tail safe)", () => {
    const line = assistantLine({ uuid: "dup", ts: "2026-07-11T10:00:00.000Z", write1h: 1000 });
    ingest(line);
    ingest(line);
    expect(tracker.get("sess-t")!.turns).toBe(1);
  });

  it("bills one billed response once across its repeated tool-round lines (same requestId, different uuids)", () => {
    // Claude Code logs a single API response as several assistant lines — one per
    // tool-call round — each with a NEW uuid but the SAME requestId and usage.
    // Regression: those must count as ONE turn, not N (the 2.28x overcount bug).
    const common = { ts: "2026-07-11T10:00:00.000Z", requestId: "req-abc", input: 100, output: 500, write1h: 40_000 };
    ingest(assistantLine({ uuid: "line-1", ...common, command: "ls" }));
    ingest(assistantLine({ uuid: "line-2", ...common, command: "ls" }));
    ingest(assistantLine({ uuid: "line-3", ...common, command: "ls" }));
    const s = tracker.get("sess-t")!;
    expect(s.turns).toBe(1);
    // cost counted once: 40_000/1M*10*2 (write1h) + 100/1M*10 (input) + 500/1M*50 (output)
    expect(s.sessionCostUsd).toBeCloseTo(0.8 + 0.001 + 0.025, 4);
    // and the tool-call links to the single deduped turn (attribution join intact)
    const turnUuids = store.db.prepare("SELECT DISTINCT turn_uuid FROM tool_calls").all() as Array<{ turn_uuid: string }>;
    expect(turnUuids).toEqual([{ turn_uuid: "req-abc" }]);
  });

  it("records a gap with realized cost on cold re-write and emits event", () => {
    const events: unknown[] = [];
    tracker.on("coldRewrite", (e) => events.push(e));
    ingest(assistantLine({ uuid: "g1", ts: "2026-07-11T10:00:00.000Z", write5m: 100_000 }));
    // 10 minutes later (> 5m TTL), no cache read, big re-write => cold
    ingest(assistantLine({ uuid: "g2", ts: "2026-07-11T10:10:00.000Z", write5m: 100_000, cacheRead: 0 }), true);
    const gaps = store.db.prepare("SELECT * FROM gaps").all() as Array<Record<string, unknown>>;
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!["expired"]).toBe(1);
    expect(gaps[0]!["realized_rewrite_cost"]).toBeGreaterThan(1); // 100k * 10/M * 1.25 = $1.25
    expect(events).toHaveLength(1);
  });

  it("does not flag warm continuation as cold re-write", () => {
    ingest(assistantLine({ uuid: "w1", ts: "2026-07-11T10:00:00.000Z", write1h: 100_000 }));
    ingest(assistantLine({ uuid: "w2", ts: "2026-07-11T10:30:00.000Z", cacheRead: 100_000, write1h: 500 }), true);
    const gaps = store.db.prepare("SELECT * FROM gaps").all() as Array<Record<string, unknown>>;
    expect(gaps).toHaveLength(1); // gap recorded (30 min)
    expect(gaps[0]!["expired"]).toBe(0); // but within 1h TTL
    expect(gaps[0]!["realized_rewrite_cost"]).toBeNull();
  });

  it("captures Bash tool calls with command class + rtk detection", () => {
    ingest(assistantLine({ uuid: "b1", ts: "2026-07-11T10:00:00.000Z", write1h: 1000, command: "rtk git status" }));
    const calls = store.db.prepare("SELECT * FROM tool_calls").all() as Array<Record<string, unknown>>;
    expect(calls).toHaveLength(1);
    expect(calls[0]!["command_class"]).toBe("git status");
    expect(calls[0]!["rtk_wrapped"]).toBe(1);
  });

  it("restores cumulative state from the store after restart", () => {
    ingest(assistantLine({ uuid: "r1", ts: "2026-07-11T10:00:00.000Z", write1h: 10_000 }));
    ingest(assistantLine({ uuid: "r2", ts: "2026-07-11T10:01:00.000Z", cacheRead: 10_000, write1h: 500 }));
    const costBefore = tracker.get("sess-t")!.sessionCostUsd;

    const tracker2 = new SessionTracker(store);
    tracker2.restoreFromStore();
    const s = tracker2.get("sess-t")!;
    expect(s.turns).toBe(2);
    expect(s.sessionCostUsd).toBeCloseTo(costBefore, 6);
    expect(s.ttlTier).toBe("1h");
    expect(s.prefixTokens).toBe(10_510);
  });
});
