import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Entry } from "@ccc/core";
import { Store } from "../src/store.ts";
import { SessionTracker } from "../src/session-tracker.ts";
import { Server } from "../src/server.ts";
import { terminalSpecs } from "../src/launcher.ts";

let dir: string;
let store: Store;
let tracker: SessionTracker;
let server: Server;
let base: string;

function assistantEntry(sid: string, cwd: string): Extract<Entry, { kind: "assistant" }> {
  return {
    kind: "assistant",
    uuid: `a-${sid}`,
    requestId: `req-${sid}`,
    sessionId: sid,
    timestamp: new Date().toISOString(),
    model: "claude-opus-4-8",
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    toolUses: [],
    cwd,
  };
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-launch-"));
  store = new Store(path.join(dir, "test.db"));
  tracker = new SessionTracker(store);
  server = new Server(tracker, store, 0);
  await server.listen();
  base = `http://127.0.0.1:${server.boundPort}`;
});
afterEach(() => {
  server.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("POST /session/launch", () => {
  it("awaits an async handler and returns its result", async () => {
    const seen: string[] = [];
    server.handlers.launchSession = async (sid) => {
      seen.push(sid);
      return { ok: sid === "known-session" };
    };
    const r = await fetch(`${base}/session/launch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "known-session" }),
    });
    expect(await r.json()).toEqual({ ok: true });
    expect(seen).toEqual(["known-session"]);
  });

  it("answers ok:false when no handler is wired", async () => {
    const r = await fetch(`${base}/session/launch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "x" }),
    });
    const res = (await r.json()) as { ok: boolean };
    expect(res.ok).toBe(false);
  });
});

describe("namer-session hiding", () => {
  it("omits sessions whose cwd is the hidden dir from /api/sessions", async () => {
    const hidden = path.join(dir, "state", "namer");
    server.hideSessionsUnder = hidden;
    tracker.ingest(assistantEntry("real-1", "C:\\repo\\proj"), "C--repo-proj", false);
    // separator/case variation must still match
    tracker.ingest(assistantEntry("namer-1", hidden.replace(/\\/g, "/").toUpperCase()), "namer-slug", false);
    const { sessions } = (await (await fetch(`${base}/api/sessions`)).json()) as { sessions: Array<{ sessionId: string }> };
    expect(sessions.map((s) => s.sessionId)).toEqual(["real-1"]);
  });
});

describe("terminalSpecs", () => {
  it("builds a Windows Terminal spec with cwd and resume command", () => {
    const specs = terminalSpecs("win32", "C:\\repo\\proj", "abc-123");
    expect(specs[0]?.cmd).toBe("wt.exe");
    expect(specs[0]?.args).toContain("C:\\repo\\proj");
    expect(specs[0]?.args.join(" ")).toContain("claude --resume abc-123");
    // fallback console spec present
    expect(specs[1]?.cmd).toBe("cmd.exe");
    expect(specs[1]?.cwd).toBe("C:\\repo\\proj");
  });

  it("covers mac and linux", () => {
    expect(terminalSpecs("darwin", "/home/n/p", "abc")[0]?.cmd).toBe("osascript");
    const linux = terminalSpecs("linux", "/home/n/p", "abc");
    expect(linux.length).toBeGreaterThan(1);
    expect(linux.every((s) => s.args.join(" ").includes("claude --resume abc"))).toBe(true);
  });
});
