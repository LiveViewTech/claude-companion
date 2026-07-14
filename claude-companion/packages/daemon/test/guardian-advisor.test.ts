import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseLine } from "@ccc/core";
import { Store } from "../src/store.ts";
import { SessionTracker } from "../src/session-tracker.ts";
import { Guardian, type GuardianNotification } from "../src/guardian.ts";
import { Advisor } from "../src/advisor.ts";
import { DEFAULTS, type CccConfig } from "../src/config.ts";

let dir: string;
let store: Store;
let tracker: SessionTracker;
let notifications: GuardianNotification[];

const SID = "sess-g";

function seedSession(): void {
  const line = JSON.stringify({
    type: "assistant",
    uuid: "seed-1",
    sessionId: SID,
    timestamp: "2026-07-11T10:00:00.000Z",
    message: {
      model: "claude-fable-5",
      role: "assistant",
      content: [],
      usage: {
        input_tokens: 10,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 1000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
      },
    },
  });
  const { entry } = parseLine(line);
  tracker.ingest(entry!, "proj", false);
}

function writeCourier(pct: number, resetsAt = 1_800_000_000, ts = Date.now()): void {
  fs.mkdirSync(path.join(dir, "courier"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "courier", `${SID}.json`),
    JSON.stringify({ ts, rate_limits: { five_hour: { used_percentage: pct, resets_at: resetsAt } } }),
  );
}

function makeGuardian(cfg?: Partial<CccConfig["guardian"]>): Guardian {
  return new Guardian({
    tracker,
    store,
    cfg: { ...DEFAULTS, guardian: { ...DEFAULTS.guardian, action: "handoff", ...cfg } },
    stateDir: dir,
    onNotify: (n) => notifications.push(n),
  });
}

function makeAdvisor(
  ackGuardian: (sid: string, action: string) => boolean,
  advisor?: Partial<CccConfig["advisor"]>,
): Advisor {
  return new Advisor({
    tracker,
    cfg: { ...DEFAULTS, advisor: { ...DEFAULTS.advisor, ...advisor } },
    ackGuardian,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-guardian-"));
  store = new Store(path.join(dir, "t.db"));
  tracker = new SessionTracker(store);
  notifications = [];
  seedSession();
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Guardian", () => {
  it("stays quiet below thresholds", () => {
    writeCourier(50);
    makeGuardian().sweep();
    expect(notifications).toHaveLength(0);
    expect(tracker.get(SID)!.guardian.fiveHourPct).toBe(50);
    expect(tracker.get(SID)!.guardian.pendingAction).toBeNull();
  });

  it("notifies once at notify threshold, arms once at act threshold", () => {
    const g = makeGuardian();
    writeCourier(85, 1_800_000_000, Date.now());
    g.sweep();
    expect(notifications.map((n) => n.level)).toEqual(["notify"]);
    expect(tracker.get(SID)!.guardian.pendingAction).toBeNull();

    writeCourier(92, 1_800_000_000, Date.now() + 1000);
    g.sweep();
    expect(notifications.map((n) => n.level)).toEqual(["notify", "act"]);
    expect(tracker.get(SID)!.guardian.pendingAction).toBe("handoff");

    // Same window again: no repeat even at higher pct.
    writeCourier(97, 1_800_000_000, Date.now() + 2000);
    g.sweep();
    expect(notifications).toHaveLength(2);
  });

  it("re-arms in a new reset window and survives daemon restart (meta persisted)", () => {
    const g = makeGuardian();
    writeCourier(95, 1_800_000_000);
    g.sweep();
    expect(notifications.filter((n) => n.level === "act")).toHaveLength(1);

    // "Restart": new Guardian over the same store must not re-fire the same window...
    const g2 = makeGuardian();
    writeCourier(96, 1_800_000_000, Date.now() + 1000);
    tracker.get(SID)!.guardian.updatedAt = null; // force re-apply
    g2.sweep();
    expect(notifications.filter((n) => n.level === "act")).toHaveLength(1);

    // ...but a NEW window re-arms.
    writeCourier(91, 1_800_018_000, Date.now() + 2000);
    g2.sweep();
    expect(notifications.filter((n) => n.level === "act")).toHaveLength(2);
  });

  it("ack clears pending exactly once", () => {
    const g = makeGuardian();
    writeCourier(95);
    g.sweep();
    expect(g.ack(SID, "handoff")).toBe(true);
    expect(tracker.get(SID)!.guardian.pendingAction).toBeNull();
    expect(g.ack(SID, "handoff")).toBe(false); // second delivery attempt refused
  });

  it("notify-only mode never arms an action", () => {
    const g = makeGuardian({ action: "notify-only" } as never);
    // rebuild with notify-only
    const g2 = new Guardian({
      tracker,
      store,
      cfg: { ...DEFAULTS, guardian: { ...DEFAULTS.guardian, action: "notify-only" } },
      stateDir: dir,
      onNotify: (n) => notifications.push(n),
    });
    writeCourier(99);
    g2.sweep();
    expect(tracker.get(SID)!.guardian.pendingAction).toBeNull();
    expect(notifications.filter((n) => n.level === "notify")).toHaveLength(1);
    void g;
  });

  it("off mode never notifies or arms, but still records the raw percentage", () => {
    const g = makeGuardian({ action: "off" });
    writeCourier(99);
    g.sweep();
    expect(notifications).toHaveLength(0);
    expect(tracker.get(SID)!.guardian.pendingAction).toBeNull();
    expect(tracker.get(SID)!.guardian.fiveHourPct).toBe(99); // dashboard still sees the number
  });
});

describe("Advisor", () => {
  it("nudges plan-first for planning-shaped prompts, throttled", () => {
    const advisor = makeAdvisor(() => false);
    const first = advisor.advise({ session_id: SID, prompt: "Help me design a new architecture for the ingest service" });
    expect(first.systemMessage).toMatch(/plan mode/);
    const second = advisor.advise({ session_id: SID, prompt: "now plan the migration of the database" });
    expect(second.systemMessage).toBeUndefined(); // throttled
  });

  it("stays silent on ordinary prompts", () => {
    const advisor = makeAdvisor(() => false);
    expect(advisor.advise({ session_id: SID, prompt: "fix the typo in readme" })).toEqual({});
  });

  it("delivers the guardian instruction with ack, outranking nudges", () => {
    const g = makeGuardian();
    writeCourier(95);
    g.sweep();
    const advisor = makeAdvisor((sid, action) => g.ack(sid, action));
    const res = advisor.advise({ session_id: SID, prompt: "design a new plan for everything" });
    expect(res.additionalContext).toMatch(/HANDOFF\.md/);
    expect(res.systemMessage).toMatch(/guardian/);
    // pending cleared: next prompt gets no guardian content
    const res2 = advisor.advise({ session_id: SID, prompt: "hello again" });
    expect(res2.additionalContext).toBeUndefined();
  });

  it("when disabled, suppresses the plan nudge", () => {
    const advisor = makeAdvisor(() => false, { enabled: false });
    expect(advisor.advise({ session_id: SID, prompt: "Help me design a new architecture for the ingest service" })).toEqual({});
  });

  it("when disabled, STILL delivers the guardian instruction (that's a separate feature)", () => {
    const g = makeGuardian();
    writeCourier(95);
    g.sweep();
    const advisor = makeAdvisor((sid, action) => g.ack(sid, action), { enabled: false });
    const res = advisor.advise({ session_id: SID, prompt: "hello" });
    expect(res.additionalContext).toMatch(/HANDOFF\.md/);
    expect(res.systemMessage).toMatch(/guardian/);
  });

  it("honors a custom nudgeEvery throttle", () => {
    const advisor = makeAdvisor(() => false, { nudgeEvery: 2 });
    expect(advisor.advise({ session_id: SID, prompt: "design a new system architecture" }).systemMessage).toMatch(/plan mode/);
    // 2nd prompt: still within the 2-prompt throttle window
    expect(advisor.advise({ session_id: SID, prompt: "plan a migration strategy" }).systemMessage).toBeUndefined();
    // 3rd prompt: throttle window elapsed, nudges again
    expect(advisor.advise({ session_id: SID, prompt: "architect a new service from scratch" }).systemMessage).toMatch(/plan mode/);
  });
});
