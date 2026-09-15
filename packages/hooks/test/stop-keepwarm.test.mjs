import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../src/stop-keepwarm.mjs", import.meta.url));
const SID = "sess-stop";

let root;
let server;
let port;
let posts;

/** Mirrors the hook's own stateDir(), given the env this test sets below. */
function stateDir() {
  if (process.platform === "win32") return path.join(root, "claude-companion", "state");
  if (process.platform === "darwin") return path.join(root, "Library", "Application Support", "claude-companion", "state");
  return path.join(root, "claude-companion");
}

function writeState(guardian, keepwarm = null) {
  const dir = path.join(stateDir(), "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SID}.json`), JSON.stringify({ sessionId: SID, guardian, keepwarm }));
}

/**
 * Runs the hook exactly as Claude Code does — a real subprocess fed stdin JSON, talking to a
 * real local daemon — because the behavior under test IS the ordering of its stages and the
 * shape of the JSON it writes to stdout. Neither survives being unit-tested in pieces.
 */
function runHook() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, XDG_STATE_HOME: root, LOCALAPPDATA: root, HOME: root },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("close", () => {
      let parsed = null;
      try {
        parsed = JSON.parse(out);
      } catch {
        /* no output is a valid outcome: the hook is dormant */
      }
      resolve({ out, json: parsed });
    });
    child.stdin.end(JSON.stringify({ session_id: SID, hook_event_name: "Stop" }));
  });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-stop-"));
  posts = [];
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      posts.push({ path: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ping: false }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(path.join(stateDir(), "daemon.pid"), JSON.stringify({ pid: process.pid, port }));
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
});

describe("stop hook: guardian delivery", () => {
  it("names the daemon-resolved handoff path, not a guess at the project root", async () => {
    writeState({ pendingAction: "handoff", pendingReason: "the context has grown large", pendingHandoffPath: "/repo/root/docs/HANDOFF.md" });
    const { json } = await runHook();
    expect(json.decision).toBe("block");
    expect(json.reason).toContain("Update /repo/root/docs/HANDOFF.md");
    expect(json.reason).toContain("the context has grown large");
    expect(json.reason).not.toContain("in the project root");
    expect(posts.map((p) => p.path)).toEqual(["/guardian/ack"]);
  });

  it("falls back to a bare HANDOFF.md when the daemon resolved no path", async () => {
    writeState({ pendingAction: "handoff", pendingReason: "x", pendingHandoffPath: null });
    const { json } = await runHook();
    expect(json.reason).toContain("Update HANDOFF.md");
  });

  it("delivers the instruction BEFORE the resume prompt when both are set", async () => {
    // Can't happen from the daemon (ack sets one as it clears the other), but the ordering is
    // the whole point of the stage: the human's prompt must never precede the work it describes.
    writeState({ pendingAction: "handoff", pendingReason: "x", pendingHandoffPath: "/r/HANDOFF.md", resumePrompt: "Read /r/HANDOFF.md ..." });
    const { json } = await runHook();
    expect(json.decision).toBe("block");
    expect(json.systemMessage).toBeUndefined();
  });
});

describe("stop hook: the human's resume prompt", () => {
  it("shows it as a systemMessage and reports it shown", async () => {
    writeState({ pendingAction: null, resumePrompt: "Read /repo/root/HANDOFF.md and pick up where it leaves off." });
    const { json } = await runHook();
    expect(json.systemMessage).toContain("safe to /clear");
    expect(json.systemMessage).toContain("Read /repo/root/HANDOFF.md and pick up where it leaves off.");
    // systemMessage only — it must not block or reach the model.
    expect(json.decision).toBeUndefined();
    expect(posts.map((p) => p.path)).toEqual(["/guardian/resume-shown"]);
    expect(posts[0].body).toEqual({ session_id: SID });
  });

  it("shows nothing when the daemon says it was already shown", async () => {
    await new Promise((r) => server.close(r));
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
      });
    });
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    writeState({ pendingAction: null, resumePrompt: "Read HANDOFF.md" });
    const { out } = await runHook();
    expect(out).toBe("");
  });

  it("stays dormant with nothing pending and keep-warm unarmed", async () => {
    writeState({ pendingAction: null, resumePrompt: null }, { armed: false, nextPingAt: null });
    const { out } = await runHook();
    expect(out).toBe("");
    expect(posts).toEqual([]);
  });
});
