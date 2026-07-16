# claude-companion (`ccc`)

Token/cache cockpit for Claude Code: cost visibility, a live prompt-cache-TTL countdown,
self-measuring cache keep-warm, a prompt advisor, and a subscription usage-limit guardian
that tells Claude to wrap up or write a handoff before you hit the wall.

Linux-first, works on Windows and macOS. No native build steps (Node 22.18+ / 24+,
uses built-in `node:sqlite` and native TypeScript execution — no compile).

## How it works

One background daemon watches `~/.claude/projects/**/*.jsonl` (both the CLI and the
VS Code extension write there) and derives everything from the per-turn `usage` data —
including which cache TTL tier (5m/1h) each request actually used, via the
`cache_creation.ephemeral_*` breakdown. Thin, dependency-free scripts (statusline, hooks)
read daemon-written state files and fail open when the daemon is down.

```
transcripts ──▶ daemon (watch/tail ▸ SQLite ▸ economics ▸ policy) ──▶ state files ──▶ statusline
                  │                                                └▶ SSE ──▶ dashboard (localhost:47613)
   hooks ◀────────┘ (advisor / guardian / keep-warm authorization)  └▶ desktop toasts
```

## Quick start

```sh
npm install
node packages/cli/src/ccc.ts install      # statusline + hooks into ~/.claude/settings.json (backup taken)
node packages/cli/src/ccc.ts daemon start
node packages/cli/src/ccc.ts open         # dashboard
node packages/cli/src/ccc.ts doctor       # schema canary + health
```

Restart Claude Code sessions after install (hook config snapshots at startup).

## Commands

| Command | What it does |
|---|---|
| `ccc install [--dry-run]` / `ccc uninstall` | Register/remove statusline + hooks (surgical edits, timestamped backups) |
| `ccc launch --ttl 1h\|5m [--no-rtk] [-- args]` | Start `claude` with a cache-TTL profile (`ENABLE_PROMPT_CACHING_1H=1` / `FORCE_PROMPT_CACHING_5M=1`) |
| `ccc code [dir] --ttl 1h\|5m` | Same, for VS Code (extension sessions inherit the env) |
| `ccc daemon start\|stop\|status`, `ccc ensure-daemon` | Daemon control (SessionStart hook auto-starts it) |
| `ccc open` | Dashboard (countdown rings, month/today meter + costs, cache economics, tokens-by-tool, rtk verdict) |
| `ccc doctor` | Transcript schema-drift canary, TTL observation, daemon health |

## Features

- **Cache countdown** — statusline `⏱ 4:37 (5m)` and dashboard ring, computed from the
  *observed* TTL tier of the last cache write; toast at T-60s with the cold re-write $ you'd pay.
- **Turn signal** — plays a sound + flashes the dashboard when Claude finishes, asks a question, or
  needs permission (replaces the Claude Notifier plugin). The sound is hook-driven so it fires even if
  the daemon is down; the flash rides SSE. Sound and flash toggle independently from dashboard Controls
  (or `turnSignal.sound` / `turnSignal.flash`); other knobs are config-only (e.g. `soundLeadMs`, per-reason `sounds`).
- **Session naming** — each card is titled with an AI summary of the session's intent
  (hover the name for a paragraph-long description). The daemon runs `claude -p` headless
  through a toolless custom agent on a cheap model (~1.3k input tokens/call, measured);
  the first prompt names the session, later prompts re-title it only when they meaningfully
  extend the intent. Toggle: `naming.enabled` / dashboard Controls.
- **Open in terminal** — the card's **⧉ open** button pops a terminal window in the
  session's cwd running `claude --resume <session>` (Windows Terminal → cmd fallback;
  macOS Terminal; common Linux emulators).
- **Cost visibility** — per-session and per-day $ from transcript usage × date-aware pricing;
  cold re-writes are detected and billed to a weekly "expiry cost you $X" number. The **This month**
  and **Today** tiles read Anthropic's own usage meter (the claude.ai Usage-page number, via the OAuth
  usage endpoint), so they match the website account-wide — all machines/surfaces, correct billing
  cycle; the local transcript estimate becomes the tile tooltip and the offline fallback. "Today" is
  the meter delta since local midnight, and warns ("⚠ daemon gap") instead of showing a wrong number
  if meter polling was down across midnight (stale baseline) — the tooltip's fallback estimate is
  this-device-only, not account-wide, so it can read low.
- **Keep-warm (experimental, API-billing only)** — arm per session in the dashboard; a Stop hook
  keeps the turn open and issues a minimal `ok` turn just before TTL expiry. Refuses to arm on
  1h-tier (subscription) sessions; soft ping cap; **every ping is measured from the transcript and
  the first cache miss auto-disarms**; honest net-saved accounting (can be negative).
- **Advisor** — UserPromptSubmit hook (<100ms budget, fail-open): plan-first nudges on
  design-shaped prompts; model-switch cache-invalidation cost shown ambiently (model-scoped caches!).
- **Usage-limit guardian** — tracks your plan's usage windows (the same 5-hour / 7-day limits that
  trigger Pro/Max throttling). The statusline couriers Claude Code's official `rate_limits` field
  (that's the CLI's name for these windows) to the daemon; at 80% you get a toast, at 90%
  (configurable, `guardian.action`: `off|notify-only|wrapup|handoff`)
  Claude is told — once — to capture context / update docs / write `HANDOFF.md` and wrap up.
- **Tokens by tool + rtk verdict** — per-command token attribution from transcripts
  (token-exact for single-tool turns), rtk-wrapped vs plain comparison with an n≥20 gate.
  This measures what `rtk gain` only estimates.

## Config

`config.json` in the platform config dir (Linux: `~/.config/claude-companion/`,
Windows: `%LOCALAPPDATA%\claude-companion\config\`):

```json
{
  "port": 47613,
  "toasts": true,
  "warnBeforeSeconds": 60,
  "monthlyBudgetUsd": 500,
  "accountUsage": { "enabled": true, "pollSeconds": 60 },
  "guardian": { "action": "handoff", "notifyPct": 80, "actPct": 90 },
  "keepwarm": { "enabled": true, "maxPingsPerIdle": 12 },
  "advisor": { "enabled": true, "nudgeEvery": 10 },
  "naming": { "enabled": true, "model": "haiku" },
  "turnSignal": { "enabled": true, "sound": true, "flash": true, "soundLeadMs": 750 }
}
```

Only keys you override need to appear; everything else uses `DEFAULTS` in `config.ts`. `monthlyBudgetUsd`
is just the fallback cap for the month tile — when `accountUsage` reaches the endpoint, the tile uses
the account's real limit instead.

Turning the optional features on/off:

- **Keep-warm** — `keepwarm.enabled` (master switch; even when `true` it's opt-in per
  session via the dashboard **arm** button). Set `false` to hard-disable.
- **Advisor** (plan-first nudge) — `advisor.enabled`; `advisor.nudgeEvery` throttles how
  often it can fire per session. This is separate from the guardian's wrap-up delivery.
- **Session naming** — `naming.enabled`; `naming.model` is passed to `claude -p --model`.
- **Usage-limit guardian** — `guardian.action`: `off | notify-only | wrapup | handoff`.
- **Turn signal** — `turnSignal.sound` (audible alert) and `turnSignal.flash` (dashboard flash)
  toggle independently; `turnSignal.enabled` and the rest of the block are config-only.
- **Account meter** — `accountUsage.enabled` feeds the month/today tiles from the claude.ai Usage
  endpoint (`accountUsage.pollSeconds` between polls); off ⇒ tiles fall back to the local estimate.
  Config-only, not in Controls.

The keep-warm, advisor, naming, guardian, and turn-signal sound/flash settings are also live-togglable
from the dashboard **Controls** panel (writes `config.json` and takes effect immediately, no daemon restart).

## Cache economics cheat-sheet (why this exists)

- cache read = **0.1×** base input; 5m write = **1.25×**; 1h write = **2×**; every hit refreshes the TTL free.
- Subscription sessions get the 1h TTL free (drops to 5m in overage); API-key sessions default to 5m.
- Caches are **model-scoped**: `/model` mid-session throws the whole cache away.
- ~12 pings ≈ one cold 5m re-write, so keep-warm pays only if you return within ~55 minutes.

## Development

```sh
npm test          # vitest (118 tests: adapter, economics, tailer, tracker, guardian, advisor, keep-warm, attribution, turn-signal, namer, launcher, controls, account-usage, window-sampler)
npm run typecheck
```

The transcript schema is officially internal/unstable — all parsing lives in
`packages/core/src/transcript-adapter.ts` behind tolerant per-line parsing, and
`ccc doctor` flags drift (parse-error rate, missing ephemeral breakdown, unknown models).
