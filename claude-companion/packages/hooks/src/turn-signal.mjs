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
// The sound player must finish (or hit this cap) *before* the hook exits. Claude Code runs hooks
// in a job object that kills the whole process tree on exit, so a detached child gets killed
// mid-startup (powershell needs ~300ms just to load) — hence "flash but no sound". We wait for
// the player instead. The daemon can't play it (a detached background process can't reach the
// audio device), so it MUST come from the hook. 7s covers the lead silence + the bundled WAVs.
const SOUND_TIMEOUT_MS = 7000;
// Leading silence (ms) played before the real sound on Windows: the audio endpoint wakes during
// the silence instead of clipping the start of the sound ("I only hear the end"). 0 disables it.
// 750ms gives the device enough spin-up to stop clipping the sound's start; lower
// turnSignal.soundLeadMs to tighten the flash->sound gap, raise it if clipping returns.
const HOOK_DEFAULTS = { enabled: true, sound: true, soundLeadMs: 750, sounds: { done: "", question: "", permission: "" } };

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
// classified from the message text since both arrive on the same event; PreToolUse =>
// registered only on the AskUserQuestion matcher, so it's a question (Notification isn't
// reliably emitted for AskUserQuestion in every surface, e.g. the VS Code extension).
export function classifyReason(input) {
  const event = String(input.hook_event_name ?? "");
  if (event === "Stop" || event === "SubagentStop") return "done";
  if (event === "PreToolUse") {
    return String(input.tool_name ?? "") === "AskUserQuestion" ? "question" : "done";
  }
  // PermissionRequest fires when a tool-permission dialog appears. Exit-0 with no
  // output falls through to the normal permission UI (it does NOT auto-approve),
  // so this is a safe place to signal. The VS Code extension doesn't reliably emit
  // a Notification for permission prompts, so this is the dedicated hook for them.
  if (event === "PermissionRequest") return "permission";
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

// Parse a RIFF/WAVE file: locate the fmt fields and the data chunk. Returns null if it's not a
// WAV we understand. Walks chunks so it tolerates extra chunks (LIST/fact) between fmt and data.
export function parseWav(buf) {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let off = 12;
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        byteRate: buf.readUInt32LE(body + 8),
        blockAlign: buf.readUInt16LE(body + 12),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      dataOff = body;
      dataLen = Math.min(size, buf.length - body);
    }
    off = body + size + (size & 1); // chunks are word-aligned
  }
  if (!fmt || dataOff < 0) return null;
  return { fmt, dataOff, dataLen };
}

// Build a NEW WAV = `leadMs` of silence + the original samples, in a SINGLE data chunk. This is
// the key to un-clipping: Windows' SoundPlayer clips the opening of every PlaySync while its audio
// stream/device spins up, so silence must be in the SAME buffer as the sound (a separate PlaySync
// of a silence file doesn't help — the real sound's own PlaySync clips again). PCM only.
export function withLeadingSilence(srcBuf, leadMs) {
  const p = parseWav(srcBuf);
  if (!p || p.fmt.audioFormat !== 1) return null; // PCM only
  const { fmt } = p;
  const silBytes = Math.max(0, Math.round((fmt.byteRate * leadMs) / 1000 / fmt.blockAlign) * fmt.blockAlign);
  const orig = srcBuf.subarray(p.dataOff, p.dataOff + p.dataLen);
  const newDataLen = silBytes + orig.length;
  const out = Buffer.alloc(44 + newDataLen);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + newDataLen, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(fmt.channels, 22);
  out.writeUInt32LE(fmt.sampleRate, 24);
  out.writeUInt32LE(fmt.byteRate, 28);
  out.writeUInt16LE(fmt.blockAlign, 32);
  out.writeUInt16LE(fmt.bits, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(newDataLen, 40);
  orig.copy(out, 44 + silBytes); // leading silBytes are already zero
  return out;
}

// Cached path to `srcPath` with `leadMs` of silence prepended (built once). Falls back to the
// original file if it isn't PCM WAV or anything goes wrong.
function paddedWav(srcPath, leadMs) {
  try {
    const dir = path.join(baseDir("state"), "sound");
    fs.mkdirSync(dir, { recursive: true });
    const base = path.basename(srcPath).replace(/[^a-zA-Z0-9._-]/g, "_");
    const f = path.join(dir, `lead${leadMs}-${base}`);
    if (!fs.existsSync(f)) {
      const buf = withLeadingSilence(fs.readFileSync(srcPath), leadMs);
      if (!buf) return srcPath;
      fs.writeFileSync(f, buf);
    }
    return f;
  } catch {
    return srcPath;
  }
}

// Resolves once the sound has played (or the safety timeout fires). We deliberately do NOT
// detach: the hook must stay alive until the player finishes, or Claude Code's job object
// tears the player down before it makes a sound. On Windows a short silence is played first so
// device spin-up doesn't clip the start. Never rejects — a sound must not fail a hook.
function playSound(wav, leadMs = 0) {
  return new Promise((resolve) => {
    if (!wav) return resolve();
    try {
      if (!fs.existsSync(wav)) return resolve();
    } catch {
      return resolve();
    }
    let cmd, args;
    if (process.platform === "win32") {
      // Play ONE WAV that is silence + the sound, so the stream-open clip lands in the silence.
      const target = leadMs > 0 ? paddedWav(wav, leadMs) : wav;
      cmd = "powershell";
      args = ["-NoProfile", "-NonInteractive", "-Command", `(New-Object Media.SoundPlayer '${target.replace(/'/g, "''")}').PlaySync()`];
    } else if (process.platform === "darwin") {
      cmd = "afplay";
      args = [wav];
    } else {
      cmd = "sh";
      args = ["-c", 'paplay "$0" 2>/dev/null || aplay -q "$0" 2>/dev/null', wav];
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      const child = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        done();
      }, SOUND_TIMEOUT_MS);
      timer.unref?.();
      child.on("exit", () => { clearTimeout(timer); done(); });
      child.on("error", () => { clearTimeout(timer); done(); });
    } catch {
      done(); /* never fail the hook over a sound */
    }
  });
}

// POSTs and resolves the parsed JSON response ({ok,flashed,sounded}), or null if the daemon is
// unreachable. The `sounded` flag lets us skip the local fallback when the daemon played the sound.
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
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      },
    );
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.end(body);
  });
}

async function main() {
  // Headless naming runs spawned by the ccc daemon set CCC_NAMER=1 — they must
  // never flash the dashboard or play "your turn" sounds.
  if (process.env.CCC_NAMER === "1") process.exit(0);
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }
  const cfg = readTurnSignalCfg();
  if (cfg.enabled === false) process.exit(0);

  const reason = classifyReason(input);
  // Fire the dashboard flash (best-effort, concurrent) and play the sound. The sound MUST be
  // played here in the hook: the daemon is a detached background process and can't reach the
  // audio device — only this hook (a child of Claude Code, in the user's interactive session)
  // can. It's played synchronously so it survives the hook's exit; Claude Code's job object would
  // otherwise kill a detached player mid-note.
  const flash = post(readPort(), "/turn", { session_id: input.session_id ?? "", reason });
  if (cfg.sound !== false) {
    await playSound((cfg.sounds && cfg.sounds[reason]) || defaultSound(reason), cfg.soundLeadMs ?? 0);
  }
  await flash;
  process.exit(0);
}

// Only run when invoked directly (node turn-signal.mjs), not when imported by tests.
const invokedDirectly =
  process.argv[1] != null && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) main().catch(() => process.exit(0));
