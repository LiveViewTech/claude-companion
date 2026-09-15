#!/usr/bin/env node
// Stop hook: (a) one-shot usage-limit-guardian delivery, (b) the human's resume prompt,
// (c) keep-warm cache pings.
// Dormant unless the daemon has flagged an action in the session state file.
// The ONLY surface that can spend money — every guard lives here.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

function stateDir() {
  const env = process.env;
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "claude-companion", "state");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "claude-companion", "state");
  }
  return path.join(env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "claude-companion");
}

const sanitize = (id) => String(id ?? "").replace(/[^a-zA-Z0-9_-]/g, "_");

function readState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(), "sessions", `${sanitize(sessionId)}.json`), "utf8"));
  } catch {
    return null;
  }
}

function readPort() {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(), "daemon.pid"), "utf8")).port ?? 47613;
  } catch {
    return 47613;
  }
}

function post(port, urlPath, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 1000 },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.end(body);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Parameterized by WHY the guardian armed (state.guardian.pendingReason). The same action
// arms for a usage window, a context-size threshold, or keep-warm giving up; hardcoding the
// usage-limit story made the instruction assert something false on a fixed-rate seat.
const GUARDIAN_MESSAGES = {
  wrapup: (cause) =>
    `SYSTEM (claude-companion guardian): ${cause}. ` +
    "Stop taking on new work now. Capture the current context: update the project's existing docs/CLAUDE.md in place with " +
    "the state of the work, decisions made, and anything in flight, then finish cleanly and summarize where things stand.",
  // The path is resolved daemon-side against the session's cwd and travels in the state file;
  // naming the file in prose alone left the model to resolve it against whatever directory it
  // believed it was in, which in a monorepo is a coin flip.
  handoff: (cause, handoffPath) =>
    `SYSTEM (claude-companion guardian): ${cause}. ` +
    `Stop taking on new work now. Update ${handoffPath} if it already exists — revise it in place, ` +
    "preserving anything still accurate, rather than replacing it wholesale — or create it if it does not. It should cover " +
    "the goal, current state, what is done vs remaining, key files touched, decisions made, and precise next steps, so a " +
    "fresh session can resume cheaply from it alone. Then finish cleanly.",
};

async function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }
  const sessionId = input.session_id ?? "";
  if (!sessionId) process.exit(0);
  const port = readPort();

  let state = readState(sessionId);
  if (!state) process.exit(0);

  // ---- (a) guardian one-shot delivery ---------------------------------------
  const pending = state.guardian?.pendingAction;
  if (pending && GUARDIAN_MESSAGES[pending]) {
    // Read the reason and the resolved path from the state we already have: the ack below
    // clears both server-side.
    const cause = state.guardian?.pendingReason ?? "this session should capture its state now";
    const handoffPath = state.guardian?.pendingHandoffPath || "HANDOFF.md";
    // Ack first so the instruction can never repeat, even across surfaces.
    const acked = await post(port, "/guardian/ack", { session_id: sessionId, action: pending });
    if (acked?.ok) {
      process.stdout.write(JSON.stringify({ decision: "block", reason: GUARDIAN_MESSAGES[pending](cause, handoffPath) }));
      process.exit(0);
    }
  }

  // ---- (b) the human's resume prompt ----------------------------------------
  // Fires on the stop AFTER the instruction was delivered — by which point Claude has
  // written the handoff, so this lands last in the transcript, right where the person is
  // deciding whether to /clear. Everything else the guardian emits is aimed at Claude;
  // this is the only line aimed at the human, and it exists so they don't have to compose
  // a resume prompt by hand. `systemMessage` shows to the user and not to the model, so it
  // costs no tokens and can't be mistaken for an instruction.
  const resumePrompt = state.guardian?.resumePrompt;
  if (resumePrompt) {
    const shown = await post(port, "/guardian/resume-shown", { session_id: sessionId });
    if (shown?.ok) {
      process.stdout.write(
        JSON.stringify({
          systemMessage:
            "✅ ccc: handoff captured — safe to /clear now. Paste this into the fresh session:\n\n" + resumePrompt,
        }),
      );
      process.exit(0);
    }
  }

  // ---- (c) keep-warm ping ----------------------------------------------------
  const kw = state.keepwarm;
  if (!kw?.armed || !kw.nextPingAt) process.exit(0);

  // Wait until just before the TTL deadline, in short slices so a disarm
  // (dashboard toggle, daemon auto-disarm on miss) is honored quickly.
  while (true) {
    state = readState(sessionId);
    const k = state?.keepwarm;
    if (!k?.armed || !k.nextPingAt) process.exit(0); // disarmed while waiting
    const wait = k.nextPingAt - Date.now();
    if (wait <= 0) break;
    await sleep(Math.min(wait, 5000));
  }

  // Final authorization from the daemon (budget, tier gate, break-even) —
  // the hook never decides to spend money on its own.
  const auth = await post(port, "/keepwarm/authorize", { session_id: sessionId });
  if (auth?.ping === true) {
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason:
          "claude-companion keep-warm ping: reply with exactly `ok` and nothing else. " +
          "Do not use tools, do not think about this beyond replying.",
      }),
    );
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
