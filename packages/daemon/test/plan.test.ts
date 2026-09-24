import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseLine } from "@ccc/core";
import { readSubscriptionType, resolvePlan } from "../src/plan.ts";
import { Store } from "../src/store.ts";
import { SessionTracker } from "../src/session-tracker.ts";
import { Server } from "../src/server.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-plan-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolvePlan", () => {
  it("treats Pro, Max and Team as flat on auto, and everything else as usage-billed", () => {
    expect(resolvePlan("auto", "pro").flat).toBe(true);
    expect(resolvePlan("auto", "max").flat).toBe(true);
    expect(resolvePlan("auto", "team").flat).toBe(true);
    // Enterprise seats are commonly billed on usage; hiding dollars there hides the bill.
    expect(resolvePlan("auto", "enterprise").flat).toBe(false);
    // API-key login: no OAuth block at all.
    expect(resolvePlan("auto", null).flat).toBe(false);
  });

  it("lets an explicit setting override the login either way", () => {
    expect(resolvePlan("flat", null)).toEqual({ subscriptionType: null, flat: true });
    expect(resolvePlan("usage", "pro")).toEqual({ subscriptionType: "pro", flat: false });
  });

  it("falls back to auto for a missing or unknown setting", () => {
    expect(resolvePlan(undefined, "pro").flat).toBe(true);
    expect(resolvePlan("bogus" as never, "pro").flat).toBe(true);
  });
});

describe("readSubscriptionType", () => {
  it("returns only the tier, lower-cased", () => {
    const f = path.join(dir, ".credentials.json");
    fs.writeFileSync(f, JSON.stringify({ claudeAiOauth: { accessToken: "tok-secret", subscriptionType: "Pro" } }));
    expect(readSubscriptionType(f)).toBe("pro");
  });

  it("is null for a missing file or a login without a tier", () => {
    expect(readSubscriptionType(path.join(dir, "nope.json"))).toBeNull();
    const f = path.join(dir, ".credentials.json");
    fs.writeFileSync(f, JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }));
    expect(readSubscriptionType(f)).toBeNull();
  });
});

describe("/api/day plan + limits", () => {
  let store: Store;
  let tracker: SessionTracker;
  let server: Server;

  beforeEach(async () => {
    store = new Store(path.join(dir, "test.db"));
    tracker = new SessionTracker(store);
    server = new Server(tracker, store, 0);
    await server.listen();
  });
  afterEach(() => {
    server.close();
    store.close();
  });

  function seed(sessionId: string): void {
    const { entry } = parseLine(
      JSON.stringify({
        type: "assistant",
        uuid: `${sessionId}-1`,
        sessionId,
        timestamp: "2026-09-24T10:00:00.000Z",
        message: {
          model: "claude-sonnet-5",
          role: "assistant",
          content: [],
          usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000 },
        },
      }),
    );
    tracker.ingest(entry!, "proj", false);
  }

  async function day(): Promise<Record<string, unknown>> {
    return (await (await fetch(`http://127.0.0.1:${server.boundPort}/api/day`)).json()) as Record<string, unknown>;
  }

  it("reports the plan the daemon resolved", async () => {
    server.plan = () => ({ subscriptionType: "pro", flat: true });
    expect((await day())["plan"]).toEqual({ subscriptionType: "pro", flat: true });
  });

  it("serves the freshest session's usage windows, reset times in ms", async () => {
    seed("old");
    seed("new");
    Object.assign(tracker.get("old")!.guardian, { fiveHourPct: 20, sevenDayPct: 60, fiveHourResetsAt: 1_790_000_000, sevenDayResetsAt: 1_790_100_000, updatedAt: 1000 });
    Object.assign(tracker.get("new")!.guardian, { fiveHourPct: 51, sevenDayPct: 79, fiveHourResetsAt: 1_790_280_000, sevenDayResetsAt: 1_790_310_000, updatedAt: 2000 });
    expect((await day())["limits"]).toEqual({
      fiveHour: { pct: 51, resetsAt: 1_790_280_000_000 },
      sevenDay: { pct: 79, resetsAt: 1_790_310_000_000 },
      at: 2000,
    });
  });

  it("reports no limits when no session has a reading (API-key seats)", async () => {
    seed("a");
    expect((await day())["limits"]).toEqual({ fiveHour: null, sevenDay: null, at: null });
  });
});
