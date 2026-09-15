import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseLine } from "@ccc/core";
import { Store } from "../src/store.ts";
import { SessionTracker } from "../src/session-tracker.ts";
import { KeepWarm } from "../src/keepwarm.ts";
import { computeExactAttribution, classStats } from "../src/attribution.ts";
import { DEFAULTS } from "../src/config.ts";

let dir: string;
let store: Store;
let tracker: SessionTracker;
let keepwarm: KeepWarm;
let events: Array<{ kind: string; sid: string }>;

const SID = "sess-kw";

function turn(opts: {
  uuid: string;
  ts: string;
  read?: number;
  w5?: number;
  w1h?: number;
  input?: number;
  output?: number;
  tools?: Array<{ id: string; command: string }>;
}) {
  const line = JSON.stringify({
    type: "assistant",
    uuid: opts.uuid,
    sessionId: SID,
    timestamp: opts.ts,
    isSidechain: false,
    message: {
      model: "claude-fable-5",
      role: "assistant",
      content: (opts.tools ?? []).map((t) => ({ type: "tool_use", id: t.id, name: "Bash", input: { command: t.command } })),
      usage: {
        input_tokens: opts.input ?? 10,
        output_tokens: opts.output ?? 50,
        cache_read_input_tokens: opts.read ?? 0,
        cache_creation_input_tokens: (opts.w5 ?? 0) + (opts.w1h ?? 0),
        cache_creation: { ephemeral_5m_input_tokens: opts.w5 ?? 0, ephemeral_1h_input_tokens: opts.w1h ?? 0 },
      },
    },
  });
  const { entry } = parseLine(line);
  if (entry?.kind !== "assistant") throw new Error("bad fixture");
  return entry;
}

function toolResult(toolUseId: string, chars: number, ts: string) {
  const line = JSON.stringify({
    type: "user",
    uuid: `u-${toolUseId}`,
    sessionId: SID,
    timestamp: ts,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "x".repeat(chars) }] },
  });
  const { entry } = parseLine(line);
  return entry!;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-kw-"));
  store = new Store(path.join(dir, "t.db"));
  tracker = new SessionTracker(store);
  events = [];
  keepwarm = new KeepWarm({ tracker, store, cfg: DEFAULTS, onEvent: (kind, sid) => events.push({ kind, sid }) });
  tracker.on("assistantTurn", ({ sessionId, entry }) => keepwarm.onAssistantTurn(sessionId, entry));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("KeepWarm gates", () => {
  it("refuses to arm when keep-warm is disabled in config", () => {
    const kw = new KeepWarm({
      tracker,
      store,
      cfg: { ...DEFAULTS, keepwarm: { ...DEFAULTS.keepwarm, enabled: false } },
      onEvent: (kind, sid) => events.push({ kind, sid }),
    });
    tracker.ingest(turn({ uuid: "a", ts: new Date().toISOString(), w5: 100_000 }), "proj", true);
    const res = kw.setArmed(SID, true) as { armed: boolean; reason: string };
    expect(res.armed).toBe(false);
    expect(res.reason).toMatch(/disabled/);
  });

  it("refuses to arm on a tier whose policy disallows it", () => {
    const kw = new KeepWarm({
      tracker,
      store,
      cfg: {
        ...DEFAULTS,
        keepwarm: { ...DEFAULTS.keepwarm, tiers: { ...DEFAULTS.keepwarm.tiers, "1h": { ...DEFAULTS.keepwarm.tiers["1h"], arm: false } } },
      },
      onEvent: (kind, sid) => events.push({ kind, sid }),
    });
    tracker.ingest(turn({ uuid: "a", ts: "2026-07-11T10:00:00.000Z", w1h: 100_000 }), "proj", false);
    const res = kw.setArmed(SID, true) as { armed: boolean; reason: string };
    expect(res.armed).toBe(false);
    expect(res.reason).toMatch(/off for 1h-TTL/);
  });

  it("arms on the 1h tier by default (walk-aways, not think-time, are what kill a 1h cache)", () => {
    tracker.ingest(turn({ uuid: "a", ts: new Date().toISOString(), w1h: 100_000 }), "proj", true);
    const res = keepwarm.setArmed(SID, true) as { armed: boolean; reason: string };
    expect(res.armed).toBe(true);
  });

  it("seeds the tier from accountType until a cache write is measured", () => {
    const mk = (accountType: "auto" | "pro" | "enterprise") =>
      new KeepWarm({
        tracker,
        store,
        cfg: { ...DEFAULTS, keepwarm: { ...DEFAULTS.keepwarm, accountType } },
        onEvent: (kind, sid) => events.push({ kind, sid }),
      });
    // A turn with no cache write at all: nothing to measure.
    tracker.ingest(turn({ uuid: "a", ts: new Date().toISOString(), read: 100_000, input: 0 }), "proj", true);
    const s = tracker.get(SID)!;
    expect(s.ttlTier).toBeNull();
    expect(mk("auto").tierFor(s)).toBeNull();
    expect(mk("pro").tierFor(s)).toBe("5m");
    expect(mk("enterprise").tierFor(s)).toBe("1h");
  });

  it("a measured tier always beats the accountType hint", () => {
    const kw = new KeepWarm({
      tracker,
      store,
      cfg: { ...DEFAULTS, keepwarm: { ...DEFAULTS.keepwarm, accountType: "pro" } },
      onEvent: (kind, sid) => events.push({ kind, sid }),
    });
    tracker.ingest(turn({ uuid: "a", ts: new Date().toISOString(), w1h: 100_000 }), "proj", true);
    expect(kw.tierFor(tracker.get(SID)!)).toBe("1h");
  });

  it("escalates to a handoff once the 1h ping cap is reached", () => {
    const escalations: string[] = [];
    const kw = new KeepWarm({
      tracker,
      store,
      cfg: DEFAULTS,
      onEvent: (kind, sid) => events.push({ kind, sid }),
      onEscalate: (_sid, reason) => escalations.push(reason),
    });
    tracker.ingest(turn({ uuid: "a", ts: new Date().toISOString(), w1h: 100_000 }), "proj", true);
    kw.setArmed(SID, true);
    const cap = DEFAULTS.keepwarm.tiers["1h"].maxPingsPerIdle;
    for (let i = 0; i < cap; i++) {
      expect(kw.authorize(SID).ping).toBe(true);
      kw.onAssistantTurn(SID, turn({ uuid: `p${i}`, ts: new Date().toISOString(), read: 100_000, w1h: 50, output: 5 }));
    }
    expect(escalations).toHaveLength(0);
    const denied = kw.authorize(SID);
    expect(denied.ping).toBe(false);
    expect(denied.reason).toMatch(/ping cap/);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatch(/1h/);
  });

  it("does not escalate when the tier's escalateToHandoff is off", () => {
    const escalations: string[] = [];
    const kw = new KeepWarm({
      tracker,
      store,
      cfg: {
        ...DEFAULTS,
        keepwarm: {
          ...DEFAULTS.keepwarm,
          tiers: { ...DEFAULTS.keepwarm.tiers, "1h": { ...DEFAULTS.keepwarm.tiers["1h"], escalateToHandoff: false } },
        },
      },
      onEvent: (kind, sid) => events.push({ kind, sid }),
      onEscalate: (_sid, reason) => escalations.push(reason),
    });
    tracker.ingest(turn({ uuid: "a", ts: new Date().toISOString(), w1h: 100_000 }), "proj", true);
    kw.setArmed(SID, true);
    const cap = DEFAULTS.keepwarm.tiers["1h"].maxPingsPerIdle;
    for (let i = 0; i < cap; i++) {
      kw.authorize(SID);
      kw.onAssistantTurn(SID, turn({ uuid: `p${i}`, ts: new Date().toISOString(), read: 100_000, w1h: 50, output: 5 }));
    }
    expect(kw.authorize(SID).ping).toBe(false);
    expect(escalations).toHaveLength(0);
  });

  it("refuses below the cacheable minimum", () => {
    tracker.ingest(turn({ uuid: "a", ts: "2026-07-11T10:00:00.000Z", w5: 500, input: 0 }), "proj", false);
    const res = keepwarm.setArmed(SID, true) as { armed: boolean; reason: string };
    expect(res.armed).toBe(false);
    expect(res.reason).toMatch(/cacheable minimum/);
  });

  it("arms on a 5m session and schedules the ping before expiry", () => {
    tracker.ingest(turn({ uuid: "a", ts: new Date().toISOString(), w5: 100_000 }), "proj", true);
    const res = keepwarm.setArmed(SID, true) as { armed: boolean };
    expect(res.armed).toBe(true);
    const s = tracker.get(SID)!;
    expect(s.keepwarm.nextPingAt).toBe(s.expiresAt! - 30_000);
  });

  it("authorizes pings up to the soft cap then stops", () => {
    tracker.ingest(turn({ uuid: "a", ts: new Date().toISOString(), w5: 100_000 }), "proj", true);
    keepwarm.setArmed(SID, true);
    for (let i = 0; i < DEFAULTS.keepwarm.tiers["5m"].maxPingsPerIdle; i++) {
      expect(keepwarm.authorize(SID).ping).toBe(true);
      keepwarm.onAssistantTurn(SID, turn({ uuid: `p${i}`, ts: new Date().toISOString(), read: 100_000, w5: 50, output: 5 }));
    }
    const denied = keepwarm.authorize(SID);
    expect(denied.ping).toBe(false);
    expect(denied.reason).toMatch(/ping cap/);
  });

  it("measures ping turns and auto-disarms on the first miss", () => {
    tracker.ingest(turn({ uuid: "a", ts: new Date().toISOString(), w5: 100_000 }), "proj", true);
    keepwarm.setArmed(SID, true);
    expect(keepwarm.authorize(SID).ping).toBe(true);
    // Ping turn HIT
    keepwarm.onAssistantTurn(SID, turn({ uuid: "p1", ts: new Date().toISOString(), read: 100_000, w5: 100, output: 5 }));
    expect(tracker.get(SID)!.keepwarm.armed).toBe(true);
    let pings = store.db.prepare("SELECT * FROM pings").all() as Array<Record<string, unknown>>;
    expect(pings).toHaveLength(1);
    expect(pings[0]!["hit"]).toBe(1);

    // Second ping MISSES (e.g. model switched, cache gone)
    expect(keepwarm.authorize(SID).ping).toBe(true);
    keepwarm.onAssistantTurn(SID, turn({ uuid: "p2", ts: new Date().toISOString(), read: 0, w5: 100_000, output: 5 }));
    const s = tracker.get(SID)!;
    expect(s.keepwarm.armed).toBe(false);
    expect(s.keepwarm.reason).toMatch(/auto-disarmed/);
    expect(events.some((e) => e.kind === "keepwarm_miss_disarm")).toBe(true);
  });

  it("credits the avoided re-write when the human returns warm", () => {
    tracker.ingest(turn({ uuid: "a", ts: new Date().toISOString(), w5: 200_000, input: 0 }), "proj", true);
    keepwarm.setArmed(SID, true);
    keepwarm.authorize(SID);
    keepwarm.onAssistantTurn(SID, turn({ uuid: "p1", ts: new Date().toISOString(), read: 200_000, w5: 0, output: 5 }));
    const afterPing = tracker.get(SID)!.keepwarm.netSavedUsd; // negative (ping cost)
    expect(afterPing).toBeLessThan(0);
    // Human returns; warm read
    keepwarm.onAssistantTurn(SID, turn({ uuid: "h1", ts: new Date().toISOString(), read: 200_000, w5: 500, output: 400 }));
    const net = tracker.get(SID)!.keepwarm.netSavedUsd;
    // avoided rewrite = 200k/1M * 10 * 1.25 = $2.50; ping cost ~$0.20
    expect(net).toBeGreaterThan(2.0);
    expect(events.some((e) => e.kind === "keepwarm_reconciled")).toBe(true);
  });
});

describe("Attribution", () => {
  it("computes exact tokens for single-tool turns and class stats", () => {
    // Turn 1 issues one Bash call; prefix 100_000, output 100.
    tracker.ingest(
      turn({ uuid: "t1", ts: "2026-07-11T10:00:00.000Z", read: 0, w5: 100_000, input: 0, output: 100, tools: [{ id: "tu1", command: "git status" }] }),
      "proj",
      false,
    );
    tracker.ingest(toolResult("tu1", 8000, "2026-07-11T10:00:05.000Z"), "proj", false);
    // Turn 2: prefix = 100_000 + 100 (prev output) + 2_000 (tool result tokens) = 102_100
    tracker.ingest(turn({ uuid: "t2", ts: "2026-07-11T10:00:10.000Z", read: 100_000, w5: 2_100, input: 0, output: 50 }), "proj", false);

    const updated = computeExactAttribution(store);
    expect(updated).toBe(1);
    const call = store.db.prepare("SELECT * FROM tool_calls WHERE tool_use_id = 'tu1'").get() as Record<string, unknown>;
    expect(call["result_tok_exact"]).toBe(2_000); // 102_100 - 100_000 - 100
    expect(call["attribution"]).toBe("exact");

    const stats = classStats(store);
    expect(stats[0]!.commandClass).toBe("git status");
    expect(stats[0]!.medianChars).toBe(8000);
  });
});
