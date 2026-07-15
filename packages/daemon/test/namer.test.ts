import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Entry } from "@ccc/core";
import { Store } from "../src/store.ts";
import { SessionTracker } from "../src/session-tracker.ts";
import { DEFAULTS, type CccConfig } from "../src/config.ts";
import { Namer, buildInstruction, fallbackName, isNoise, parseNamerOutput } from "../src/namer.ts";

let dir: string;
let store: Store;
let tracker: SessionTracker;
let cfg: CccConfig;

const SID = "sess-name-1";

function assistantEntry(sid: string, uuid: string): Extract<Entry, { kind: "assistant" }> {
  return {
    kind: "assistant",
    uuid,
    requestId: `req-${uuid}`,
    sessionId: sid,
    timestamp: new Date().toISOString(),
    model: "claude-opus-4-8",
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    toolUses: [],
    cwd: "C:\\repo\\proj",
  };
}

/** A runner that records instructions and replies from a scripted queue. */
function scriptedRunner(replies: Array<string | null>) {
  const calls: string[] = [];
  const runner = async (instruction: string) => {
    calls.push(instruction);
    return replies[Math.min(calls.length - 1, replies.length - 1)] ?? null;
  };
  return { calls, runner };
}

const reply = (name: string, description: string, changed = true) =>
  JSON.stringify({ type: "result", result: JSON.stringify({ name, description, changed }) });

beforeEach(() => {
  vi.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-namer-"));
  store = new Store(path.join(dir, "test.db"));
  tracker = new SessionTracker(store);
  cfg = structuredClone(DEFAULTS);
  // create live state + a sessions row so applyName/setSessionName have a target
  tracker.ingest(assistantEntry(SID, "a-1"), "C--repo-proj", false);
});
afterEach(() => {
  vi.useRealTimers();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("namer output parsing", () => {
  it("unwraps claude --output-format json envelopes", () => {
    const r = parseNamerOutput(reply("Fix flaky tests", "Chasing a race in CI.", true));
    expect(r).toEqual({ name: "Fix flaky tests", description: "Chasing a race in CI.", changed: true });
  });

  it("tolerates fenced / plain-text JSON and rejects garbage", () => {
    expect(parseNamerOutput('```json\n{"name":"A","description":"B"}\n```')?.name).toBe("A");
    expect(parseNamerOutput('{"name":"A","description":"B","changed":false}')?.changed).toBe(false);
    expect(parseNamerOutput("no json here")).toBeNull();
    expect(parseNamerOutput('{"description":"missing name"}')).toBeNull();
  });
});

describe("namer heuristics", () => {
  it("filters command echoes and system wrappers", () => {
    expect(isNoise("<command-name>/model</command-name>")).toBe(true);
    expect(isNoise("Caveat: local command output")).toBe(true);
    expect(isNoise("y")).toBe(true);
    expect(isNoise("please rename the dashboard sessions")).toBe(false);
  });

  it("fallbackName truncates at a word boundary", () => {
    expect(fallbackName("short prompt")).toBe("short prompt");
    const long = fallbackName("this is a very long first prompt that keeps going and going and going");
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith("…")).toBe(true);
  });

  it("buildInstruction carries current name and omission count", () => {
    const ins = buildInstruction({ prompts: ["first", "recent"], promptCount: 10, name: "Old name", description: "Old desc" });
    expect(ins).toContain("Current name: Old name");
    expect(ins).toContain("8 middle prompts omitted");
    expect(ins).toContain("1. first");
  });
});

describe("namer lifecycle", () => {
  it("names a session from its first live prompt and persists", async () => {
    const { calls, runner } = scriptedRunner([reply("Build turn signal", "Sound + flash on turn end.")]);
    const namer = new Namer({ tracker, store, cfg, namerDir: path.join(dir, "namer"), runner });
    namer.notePrompt({ sessionId: SID, text: "add a turn signal sound to the dashboard", cwd: "C:\\repo\\proj", live: true });
    await vi.advanceTimersByTimeAsync(4000);
    expect(calls).toHaveLength(1);
    expect(tracker.get(SID)?.name).toBe("Build turn signal");
    expect(tracker.get(SID)?.nameDescription).toBe("Sound + flash on turn end.");
    expect(store.getSessionName(SID)?.name).toBe("Build turn signal");
  });

  it("throttles renames and keeps the name when the model says unchanged", async () => {
    const { calls, runner } = scriptedRunner([
      reply("Build turn signal", "Sound + flash."),
      reply("Build turn signal", "Sound + flash; then volume tweaks.", false),
    ]);
    const namer = new Namer({ tracker, store, cfg, namerDir: path.join(dir, "namer"), runner });
    namer.notePrompt({ sessionId: SID, text: "add a turn signal sound to the dashboard", live: true });
    await vi.advanceTimersByTimeAsync(4000);
    expect(calls).toHaveLength(1);

    namer.notePrompt({ sessionId: SID, text: "make the sound a little quieter please", live: true });
    // rename respects the 90s per-session floor: nothing at +30s...
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(1);
    // ...second call after the floor passes, seeded with the current name
    await vi.advanceTimersByTimeAsync(70_000);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("Current name: Build turn signal");
    expect(tracker.get(SID)?.name).toBe("Build turn signal");
    expect(tracker.get(SID)?.nameDescription).toContain("volume tweaks");
  });

  it("ignores noise, namer-cwd prompts, and backfill(live=false) prompts for scheduling", async () => {
    const { calls, runner } = scriptedRunner([reply("X", "Y")]);
    const namerDir = path.join(dir, "namer");
    const namer = new Namer({ tracker, store, cfg, namerDir, runner });
    namer.notePrompt({ sessionId: SID, text: "<command-name>/model</command-name>", live: true });
    namer.notePrompt({ sessionId: SID, text: "name this session for the dashboard", cwd: namerDir, live: true });
    namer.notePrompt({ sessionId: SID, text: "a genuine prompt from history backfill", live: false });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(0);
    expect(tracker.get(SID)?.name).toBeUndefined();
  });

  it("falls back to a truncated first prompt when the model call fails", async () => {
    const { runner } = scriptedRunner([null]);
    const namer = new Namer({ tracker, store, cfg, namerDir: path.join(dir, "namer"), runner });
    namer.notePrompt({ sessionId: SID, text: "please investigate the cache expiry countdown drift", live: true });
    await vi.advanceTimersByTimeAsync(4000);
    expect(tracker.get(SID)?.name).toBe("please investigate the cache expiry countdown drift");
  });

  it("does nothing when naming is disabled", async () => {
    cfg.naming.enabled = false;
    const { calls, runner } = scriptedRunner([reply("X", "Y")]);
    const namer = new Namer({ tracker, store, cfg, namerDir: path.join(dir, "namer"), runner });
    namer.notePrompt({ sessionId: SID, text: "a perfectly good naming prompt", live: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(0);
  });
});
