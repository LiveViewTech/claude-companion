#!/usr/bin/env node
// Claude Code statusline for claude-companion.
// Dependency-free and fast: stdin JSON + daemon-written state file -> one ANSI line.
// Also acts as the *usage-limits courier*: the plan usage windows (5h/7d) only exist in this
// stdin JSON — Claude Code names the field `rate_limits` — so we persist them for the daemon (guardian, M3).
//
// Degrades gracefully: with the daemon down it renders from stdin alone.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

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

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function sanitize(id) {
  return String(id ?? "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Local wall-clock time as "h:mma"/"h:mmp" (e.g. 10:47p) — compact for a statusline. */
function clockTime(ms) {
  const d = new Date(ms);
  let h = d.getHours();
  const ap = h >= 12 ? "p" : "a";
  h = h % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, "0")}${ap}`;
}

function main() {
  const input = readStdin();
  const sessionId = input.session_id ?? input.sessionId ?? "";
  const dir = stateDir();

  // --- courier: persist the official `rate_limits` field (usage-limit windows) for the daemon (best effort) ----
  if (sessionId && input.rate_limits && typeof input.rate_limits === "object") {
    try {
      fs.mkdirSync(path.join(dir, "courier"), { recursive: true });
      const f = path.join(dir, "courier", `${sanitize(sessionId)}.json`);
      fs.writeFileSync(f, JSON.stringify({ ts: Date.now(), rate_limits: input.rate_limits }));
    } catch { /* never break the statusline */ }
  }

  // --- read daemon state (may be missing/stale) -------------------------------
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(path.join(dir, "sessions", `${sanitize(sessionId)}.json`), "utf8"));
  } catch { /* daemon down or session unknown */ }

  const parts = [];

  // model · effort
  const model = (input.model?.display_name ?? input.model?.id ?? state?.model ?? "?").replace(/^claude-/i, "");
  const effort = input.effort?.level ? ` ${DIM}${input.effort.level}${RESET}` : "";
  parts.push(`${BOLD}${model}${RESET}${effort}`);

  // cache expiry (from daemon state; ground truth from transcripts).
  // Shown as an ABSOLUTE clock time, not a mm:ss countdown: Claude Code only re-runs the
  // statusline on activity (never on an idle timer), and any activity resets the cache TTL to
  // full — so a countdown can only ever render at ~full or frozen, never visibly ticking down.
  // An expiry time reads correctly regardless of when the line is re-rendered.
  if (state?.expiresAt) {
    const left = state.expiresAt - Date.now();
    const tier = state.ttlTier ?? "?";
    if (left <= 0) {
      parts.push(`${RED}cache expired · rewrite $${(state.rewriteCostUsd ?? 0).toFixed(2)}${RESET}`);
    } else {
      const col = left < 60_000 ? RED : left < 300_000 ? YELLOW : GREEN;
      parts.push(`${col}⏱ exp ${clockTime(state.expiresAt)}${RESET} ${DIM}(${tier})${RESET}`);
    }
  } else {
    parts.push(`${DIM}⏱ exp –:––${RESET}`);
  }

  // session cost: prefer official client-side estimate from stdin, fall back to daemon math
  const cost = input.cost?.total_cost_usd ?? state?.sessionCostUsd;
  if (typeof cost === "number") parts.push(`$${cost.toFixed(2)}`);

  // context usage
  const ctxPct = input.context_window?.used_percentage;
  if (typeof ctxPct === "number") parts.push(`${DIM}ctx ${Math.round(ctxPct)}%${RESET}`);

  // official usage limits (subscription only) — Claude Code's `rate_limits` field
  const rl = input.rate_limits;
  const fmtLimit = (o, label) => {
    if (!o || typeof o.used_percentage !== "number") return null;
    const pct = Math.round(o.used_percentage);
    const col = pct >= 90 ? RED : pct >= 80 ? YELLOW : DIM;
    return `${col}${label} ${pct}%${RESET}`;
  };
  const fh = fmtLimit(rl?.five_hour, "5h");
  const sd = fmtLimit(rl?.seven_day, "7d");
  if (fh) parts.push(fh);
  if (sd) parts.push(sd);

  // keep-warm indicator (M5)
  if (state?.keepwarm?.armed) {
    parts.push(`⚡${state.keepwarm.pings}`);
  }

  process.stdout.write(parts.join(` ${DIM}|${RESET} `));
}

main();
