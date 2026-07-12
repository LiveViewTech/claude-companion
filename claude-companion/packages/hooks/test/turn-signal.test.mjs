import { describe, expect, it } from "vitest";
import path from "node:path";
import { classifyReason, defaultSound } from "../src/turn-signal.mjs";

describe("turn-signal hook", () => {
  it("maps Stop / SubagentStop to 'done'", () => {
    expect(classifyReason({ hook_event_name: "Stop" })).toBe("done");
    expect(classifyReason({ hook_event_name: "SubagentStop" })).toBe("done");
  });

  it("splits Notification into permission vs. question by message text", () => {
    expect(classifyReason({ hook_event_name: "Notification", message: "Claude needs your permission to use Bash" })).toBe("permission");
    expect(classifyReason({ hook_event_name: "Notification", message: "Claude wants to run rm -rf" })).toBe("permission");
    expect(classifyReason({ hook_event_name: "Notification", message: "Claude is waiting for your input" })).toBe("question");
  });

  it("falls back to 'done' for unknown events", () => {
    expect(classifyReason({})).toBe("done");
    expect(classifyReason({ hook_event_name: "SomethingElse" })).toBe("done");
  });

  it("picks a distinct default sound per reason (basename check, platform-agnostic)", () => {
    const done = path.basename(defaultSound("done")).toLowerCase();
    const question = path.basename(defaultSound("question")).toLowerCase();
    const permission = path.basename(defaultSound("permission")).toLowerCase();
    expect(new Set([done, question, permission]).size).toBe(3);
  });
});
