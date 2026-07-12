#!/usr/bin/env node
// UserPromptSubmit hook: advisor nudges + rate-limit-guardian delivery.
// Hard budget: fail-open on ANY error, total wall clock well under 100ms.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const TIMEOUT_MS = 75;

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

function readPort() {
  try {
    const pid = JSON.parse(fs.readFileSync(path.join(stateDir(), "daemon.pid"), "utf8"));
    return pid.port ?? 47613;
  } catch {
    return 47613;
  }
}

function postAdvise(port, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      { host: "127.0.0.1", port, path: "/advise", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: TIMEOUT_MS },
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
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
    req.end(body);
  });
}

async function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    /* fail open */
  }
  const advice = await postAdvise(readPort(), {
    session_id: input.session_id ?? "",
    prompt: input.prompt ?? "",
    cwd: input.cwd ?? "",
    surface: "UserPromptSubmit",
  });
  if (advice && (advice.additionalContext || advice.systemMessage)) {
    const out = {};
    if (advice.additionalContext) {
      out.hookSpecificOutput = { hookEventName: "UserPromptSubmit", additionalContext: advice.additionalContext };
    }
    if (advice.systemMessage) out.systemMessage = advice.systemMessage;
    process.stdout.write(JSON.stringify(out));
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
