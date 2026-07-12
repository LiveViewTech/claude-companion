#!/usr/bin/env node
// Stop + Notification hook: "it's your turn" signal (sound + dashboard flash).
// Replaces the Claude Notifier plugin. Plays a sound locally (works even if the
// daemon is down) and fires a best-effort POST /turn so the daemon can flash the
// dashboard over SSE. Must be fast and non-blocking: sound is detached, the POST
// has a hard timeout, and we never emit a hook decision.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const POST_TIMEOUT_MS = 800;
const HOOK_DEFAULTS = { enabled: true, sound: true, sounds: { done: "", question: "", permission: "" } };

function baseDir(kind) {
  const env = process.env;
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "claude-companion", kind);
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "claude-companion", kind);
  }
  if (kind === "config") return path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "claude-companion");
  return path.join(env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "claude-companion");
}

function readTurnSignalCfg() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(baseDir("config"), "config.json"), "utf8"));
    const ts = raw.turnSignal ?? {};
    return { ...HOOK_DEFAULTS, ...ts, sounds: { ...HOOK_DEFAULTS.sounds, ...(ts.sounds ?? {}) } };
  } catch {
    return { ...HOOK_DEFAULTS };
  }
}

function readPort() {
  try {
    return JSON.parse(fs.readFileSync(path.join(baseDir("state"), "daemon.pid"), "utf8")).port ?? 47613;
  } catch {
    return 47613;
  }
}

// Stop => Claude finished; Notification => it needs the user (permission vs. a question),
// classified from the message text since both arrive on the same event.
export function classifyReason(input) {
  const event = String(input.hook_event_name ?? "");
  if (event === "Stop" || event === "SubagentStop") return "done";
  if (event === "Notification") {
    const msg = String(input.message ?? "").toLowerCase();
    if (/permission|approve|\ballow\b|wants to|needs your/.test(msg)) return "permission";
    return "question";
  }
  return "done";
}

export function defaultSound(reason) {
  if (process.platform === "win32") {
    const media = path.join(process.env.SystemRoot ?? "C:\\Windows", "Media");
    return path.join(media, reason === "done" ? "tada.wav" : reason === "question" ? "chimes.wav" : "notify.wav");
  }
  if (process.platform === "darwin") {
    const s = "/System/Library/Sounds";
    return path.join(s, reason === "done" ? "Glass.aiff" : reason === "question" ? "Ping.aiff" : "Funk.aiff");
  }
  const s = "/usr/share/sounds/freedesktop/stereo";
  return path.join(s, reason === "done" ? "complete.oga" : reason === "question" ? "message.oga" : "dialog-information.oga");
}

function playSound(wav) {
  if (!wav) return;
  try {
    if (!fs.existsSync(wav)) return;
  } catch {
    return;
  }
  let cmd, args;
  if (process.platform === "win32") {
    // PlaySync in a detached child: the child outlives this hook and plays fully.
    cmd = "powershell";
    args = ["-NoProfile", "-NonInteractive", "-Command", `(New-Object Media.SoundPlayer '${wav.replace(/'/g, "''")}').PlaySync()`];
  } else if (process.platform === "darwin") {
    cmd = "afplay";
    args = [wav];
  } else {
    cmd = "sh";
    args = ["-c", 'paplay "$0" 2>/dev/null || aplay -q "$0" 2>/dev/null', wav];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } catch {
    /* never fail the hook over a sound */
  }
}

function post(port, urlPath, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        timeout: POST_TIMEOUT_MS,
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve(true));
      },
    );
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end(body);
  });
}

async function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }
  const cfg = readTurnSignalCfg();
  if (cfg.enabled === false) process.exit(0);

  const reason = classifyReason(input);
  if (cfg.sound !== false) {
    playSound((cfg.sounds && cfg.sounds[reason]) || defaultSound(reason));
  }
  // Best-effort flash. The sound already fired locally, so a down daemon is harmless.
  await post(readPort(), "/turn", { session_id: input.session_id ?? "", reason });
  process.exit(0);
}

// Only run when invoked directly (node turn-signal.mjs), not when imported by tests.
const invokedDirectly =
  process.argv[1] != null && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) main().catch(() => process.exit(0));
