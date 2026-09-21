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

describe("Guardian account windows", () => {
  const FRESH_SID = "sess-fresh";

  function seedFresh(): void {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "seed-fresh",
      sessionId: FRESH_SID,
      timestamp: new Date().toISOString(),
      message: { model: "claude-fable-5", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    });
    const { entry } = parseLine(line);
    tracker.ingest(entry!, "proj", false);
  }

  function accountUsage(fiveHourPct: number) {
    return {
      usedUsd: 250,
      monthlyLimitUsd: 500,
      fiveHour: { name: "five_hour", utilization: fiveHourPct, resetsAt: "2026-07-20T05:00:00Z" },
      sevenDay: null,
      windows: [],
      fetchedAt: Date.now(),
    };
  }

  it("feeds account-wide windows to recently-active sessions and fires thresholds", () => {
    seedFresh();
    const g = makeGuardian();
    const changed = g.applyAccountWindows(accountUsage(85));
    expect(changed.map((s) => s.sessionId)).toEqual([FRESH_SID]);
    const gs = tracker.get(FRESH_SID)!.guardian;
    expect(gs.fiveHourPct).toBe(85);
    expect(gs.fiveHourResetsAt).toBe(Math.round(Date.parse("2026-07-20T05:00:00Z") / 1000));
    expect(notifications.map((n) => n.level)).toEqual(["notify"]);
  });

  it("skips idle sessions so wrap-ups never arm on dead sessions", () => {
    // Only the stale seed session (2026-07-11) exists.
    const g = makeGuardian();
    expect(g.applyAccountWindows(accountUsage(95))).toEqual([]);
    expect(tracker.get(SID)!.guardian.fiveHourPct).toBeNull();
    expect(notifications).toHaveLength(0);
  });
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

describe("Guardian courier: official session cost", () => {
  function writeCostCourier(costUsd: number, ts = Date.now(), withLimits = false): void {
    fs.mkdirSync(path.join(dir, "courier"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "courier", `${SID}.json`),
      JSON.stringify({
        ts,
        cost_usd: costUsd,
        ...(withLimits ? { rate_limits: { five_hour: { used_percentage: 10, resets_at: 1_800_000_000 } } } : {}),
      }),
    );
  }

  it("applies a cost-only courier (API-key seats report no usage windows)", () => {
    const g = makeGuardian();
    writeCostCourier(1.23);
    const changed = g.sweep();
    expect(changed.map((s) => s.sessionId)).toEqual([SID]);
    expect(tracker.get(SID)?.officialCostUsd).toBe(1.23);
    // No windows in the payload, so guardian state must stay untouched.
    expect(tracker.get(SID)?.guardian.updatedAt).toBeNull();
  });

  it("keeps the official figure separate from ccc's own transcript math", () => {
    const g = makeGuardian();
    const local = tracker.get(SID)!.sessionCostUsd;
    writeCostCourier(local + 5);
    g.sweep();
    expect(tracker.get(SID)?.sessionCostUsd).toBe(local);
    expect(tracker.get(SID)?.officialCostUsd).toBe(local + 5);
  });

  it("ignores a stale courier and a repeat of the same number", () => {
    const g = makeGuardian();
    writeCostCourier(2, 2000);
    g.sweep();
    writeCostCourier(1, 1000); // older write, e.g. a slow statusline losing the race
    expect(g.sweep()).toEqual([]);
    expect(tracker.get(SID)?.officialCostUsd).toBe(2);
    writeCostCourier(2, 3000); // unchanged total: no redraw
    expect(g.sweep()).toEqual([]);
    expect(tracker.get(SID)?.officialCostUsd).toBe(2);
  });

  it("still drives the usage windows when both fields ride along", () => {
    const g = makeGuardian();
    writeCostCourier(0.5, Date.now(), true);
    g.sweep();
    expect(tracker.get(SID)?.officialCostUsd).toBe(0.5);
    expect(tracker.get(SID)?.guardian.fiveHourPct).toBe(10);
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

describe("guardian: non-usage-window handoff triggers", () => {
  it("armHandoff arms the pending action once, then refuses to re-arm the same reason", () => {
    const g = makeGuardian();
    expect(g.armHandoff(SID, "keepwarm-cap", "cap reached")).toBe(true);
    expect(tracker.get(SID)!.guardian.pendingAction).toBe("handoff");
    // Same reason, already pending: no double-arm.
    expect(g.armHandoff(SID, "keepwarm-cap", "cap reached")).toBe(false);
    // Even after delivery, the one-shot key keeps it from firing again this session.
    expect(g.ack(SID, "handoff")).toBe(true);
    expect(g.armHandoff(SID, "keepwarm-cap", "cap reached")).toBe(false);
  });

  it("armHandoff never injects on 'off' or 'notify-only'", () => {
    for (const action of ["off", "notify-only"] as const) {
      const g = makeGuardian({ action });
      expect(g.armHandoff(SID, `r-${action}`, "x")).toBe(false);
      expect(tracker.get(SID)!.guardian.pendingAction).toBeNull();
    }
  });

  it("armHandoff does not stack on top of an undelivered instruction", () => {
    const g = makeGuardian();
    expect(g.armHandoff(SID, "first", "x")).toBe(true);
    expect(g.armHandoff(SID, "second", "y")).toBe(false);
  });
});

describe("guardian: the delivered instruction states the real reason", () => {
  it("a usage-window handoff still says so, with the window and percentage", () => {
    const g = makeGuardian();
    writeCourier(95);
    g.sweep();
    const reason = tracker.get(SID)!.guardian.pendingReason!;
    expect(reason).toMatch(/usage limit is nearly exhausted/);
    expect(reason).toMatch(/5-hour/);
    expect(reason).toMatch(/95%/);
  });

  it("armHandoff carries the caller's human reason, never a usage-limit default", () => {
    const g = makeGuardian();
    g.armHandoff(SID, "keepwarm-cap", "cap 3/3", "keep-warm has stopped pinging");
    expect(tracker.get(SID)!.guardian.pendingReason).toBe("keep-warm has stopped pinging");
  });

  it("ack clears the reason along with the action", () => {
    const g = makeGuardian();
    g.armHandoff(SID, "test-reason", "detail");
    expect(g.ack(SID, "handoff")).toBe(true);
    const gs = tracker.get(SID)!.guardian;
    expect(gs.pendingAction).toBeNull();
    expect(gs.pendingReason).toBeNull();
  });
});

describe("guardian: the handoff path is pinned, not left to the model", () => {
  it("resolves the configured path against the session's own cwd", () => {
    tracker.get(SID)!.cwd = "/repo/root";
    const g = makeGuardian({ handoffPath: "HANDOFF.md" });
    g.armHandoff(SID, "test-reason", "detail");
    expect(tracker.get(SID)!.guardian.pendingHandoffPath).toBe(path.resolve("/repo/root", "HANDOFF.md"));
  });

  it("honors a subdirectory path and an absolute path", () => {
    tracker.get(SID)!.cwd = "/repo/root";
    makeGuardian({ handoffPath: "docs/HANDOFF.md" }).armHandoff(SID, "path-a", "detail");
    expect(tracker.get(SID)!.guardian.pendingHandoffPath).toBe(path.resolve("/repo/root", "docs/HANDOFF.md"));

    tracker.get(SID)!.guardian.pendingAction = null;
    const abs = path.resolve("/elsewhere/NOTES.md");
    makeGuardian({ handoffPath: abs }).armHandoff(SID, "path-b", "detail");
    expect(tracker.get(SID)!.guardian.pendingHandoffPath).toBe(abs);
  });

  it("falls back to the bare configured path when the session has no cwd yet", () => {
    expect(tracker.get(SID)!.cwd).toBeUndefined();
    makeGuardian({ handoffPath: "HANDOFF.md" }).armHandoff(SID, "test-reason", "detail");
    expect(tracker.get(SID)!.guardian.pendingHandoffPath).toBe("HANDOFF.md");
  });

  it("records the path on a usage-window arming too, and reports it to the notifier", () => {
    tracker.get(SID)!.cwd = "/repo/root";
    const g = makeGuardian();
    writeCourier(95);
    g.sweep();
    const resolved = path.resolve("/repo/root", "HANDOFF.md");
    expect(tracker.get(SID)!.guardian.pendingHandoffPath).toBe(resolved);
    expect(notifications.find((n) => n.level === "act")!.handoffPath).toBe(resolved);
  });

  it("the advisor names the resolved path in both the instruction and the user message", () => {
    tracker.get(SID)!.cwd = "/repo/root";
    const g = makeGuardian();
    g.armHandoff(SID, "test-reason", "detail");
    const resolved = path.resolve("/repo/root", "HANDOFF.md");
    const res = makeAdvisor((sid, action) => g.ack(sid, action)).advise({ session_id: SID, prompt: "next" });
    expect(res.additionalContext).toContain(`Update ${resolved}`);
    expect(res.systemMessage).toContain(resolved);
    // The old wording resolved itself against whatever cwd the model assumed.
    expect(res.additionalContext).not.toContain("in the project root");
  });
});

describe("guardian: the human gets a resume prompt, once, after delivery", () => {
  it("ack on a handoff leaves a paste-ready prompt naming the resolved path", () => {
    tracker.get(SID)!.cwd = "/repo/root";
    const g = makeGuardian();
    g.armHandoff(SID, "test-reason", "detail");
    expect(tracker.get(SID)!.guardian.resumePrompt).toBeNull();
    expect(g.ack(SID, "handoff")).toBe(true);
    const prompt = tracker.get(SID)!.guardian.resumePrompt!;
    expect(prompt).toContain(path.resolve("/repo/root", "HANDOFF.md"));
    expect(prompt).toMatch(/next-actions/i);
    // The path is cleared along with the rest of the pending block.
    expect(tracker.get(SID)!.guardian.pendingHandoffPath).toBeNull();
  });

  it("shows exactly once", () => {
    const g = makeGuardian();
    g.armHandoff(SID, "test-reason", "detail");
    g.ack(SID, "handoff");
    expect(g.resumeShown(SID)).toBe(true);
    expect(tracker.get(SID)!.guardian.resumePrompt).toBeNull();
    expect(g.resumeShown(SID)).toBe(false);
  });

  it("arms no resume prompt for a wrapup, which writes no single file to point at", () => {
    const g = makeGuardian({ action: "wrapup" });
    g.armHandoff(SID, "test-reason", "detail");
    expect(g.ack(SID, "wrapup")).toBe(true);
    expect(tracker.get(SID)!.guardian.resumePrompt).toBeNull();
  });

  it("arms the prompt whichever surface delivered — the advisor path included", () => {
    const g = makeGuardian();
    g.armHandoff(SID, "test-reason", "detail");
    makeAdvisor((sid, action) => g.ack(sid, action)).advise({ session_id: SID, prompt: "next" });
    expect(tracker.get(SID)!.guardian.resumePrompt).toMatch(/HANDOFF\.md/);
  });
});

describe("guardian: an armed instruction survives a daemon restart", () => {
  /** A restart is a fresh Guardian over the same store, reading tracker state rebuilt from the DB. */
  const afterRestart = (cfg?: Partial<CccConfig["guardian"]>) => makeGuardian(cfg);

  it("re-attaches an undelivered instruction instead of losing it to the one-shot key", () => {
    tracker.get(SID)!.cwd = "/repo/root";
    makeGuardian().armHandoff(SID, "test-reason", "detail");
    const armed = { ...tracker.get(SID)!.guardian };
    expect(armed.pendingAction).toBe("handoff");

    // The process dies here: in-memory state is gone, the one-shot key in `meta` is not.
    const g2 = afterRestart();
    tracker.get(SID)!.guardian.pendingAction = null;
    tracker.get(SID)!.guardian.pendingReason = null;
    tracker.get(SID)!.guardian.pendingHandoffPath = null;

    expect(g2.restorePending().map((s) => s.sessionId)).toEqual([SID]);
    const back = tracker.get(SID)!.guardian;
    expect(back.pendingAction).toBe("handoff");
    expect(back.pendingReason).toBe(armed.pendingReason);
    expect(back.pendingHandoffPath).toBe(armed.pendingHandoffPath);

    // And it still delivers exactly once afterwards.
    expect(g2.ack(SID, "handoff")).toBe(true);
    expect(g2.ack(SID, "handoff")).toBe(false);
  });

  it("re-attaches an unshown resume prompt too", () => {
    const g = makeGuardian();
    g.armHandoff(SID, "test-reason", "detail");
    g.ack(SID, "handoff");
    const prompt = tracker.get(SID)!.guardian.resumePrompt;
    expect(prompt).toBeTruthy();

    tracker.get(SID)!.guardian.resumePrompt = null;
    afterRestart().restorePending();
    expect(tracker.get(SID)!.guardian.resumePrompt).toBe(prompt);
  });

  it("leaves nothing behind once delivered and shown", () => {
    const g = makeGuardian();
    g.armHandoff(SID, "test-reason", "detail");
    g.ack(SID, "handoff");
    g.resumeShown(SID);
    expect(afterRestart().restorePending()).toEqual([]);
    expect(store.getMeta(`guardian_pending:${SID}`)).toBeNull();
  });

  it("restores nothing for a session that never armed", () => {
    expect(makeGuardian().restorePending()).toEqual([]);
  });

  it("survives a corrupt saved block rather than throwing at startup", () => {
    store.setMeta(`guardian_pending:${SID}`, "{not json");
    expect(makeGuardian().restorePending()).toEqual([]);
    expect(store.getMeta(`guardian_pending:${SID}`)).toBeNull();
  });
});
