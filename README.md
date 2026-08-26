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
                                          # also installs rtk + its hook (skip with --no-rtk)
node packages/cli/src/ccc.ts daemon start
node packages/cli/src/ccc.ts open         # dashboard
node packages/cli/src/ccc.ts doctor       # schema canary + health
```

Restart Claude Code sessions after install (hook config snapshots at startup).

`install` checks for [rtk](https://github.com/rtk-ai/rtk) and installs it when missing —
downloading the release asset, **SHA-256-verifying it against the release's `checksums.txt`**,
scanning the archive for absolute/`..` paths, and unpacking to `~/.local/bin`. It then registers
rtk's own `PreToolUse` hook (`rtk hook claude`, matcher `Bash`) in the same single settings write.
Without that hook rtk is installed but inert — nothing rewrites your commands, and the dashboard's
rtk panel stays empty. `ccc install --no-rtk` skips the whole thing; `ccc rtk` does it standalone.

Two deliberate limits: ccc does **not** run `rtk init -g` (that additionally writes `~/.claude/RTK.md`
and an `@RTK.md` reference into your *global* `CLAUDE.md` — a user-scope change affecting every
project; run it yourself if you want the instruction files), and it does **not** install ripgrep,
which needs sudo — it only warns when `rg` is missing. `ccc uninstall` leaves rtk alone; remove it
with `rtk init -g --uninstall`.

## Commands

| Command | What it does |
|---|---|
| `ccc install [--dry-run] [--no-rtk] [--rtk-version vX.Y.Z]` / `ccc uninstall` | Register/remove statusline + hooks (surgical edits, timestamped backups); installs rtk + its hook unless `--no-rtk` |
| `ccc rtk [--check] [--force]` | Report rtk binary / hook / ripgrep status; install the binary if missing (`--check` reports only, exit 1 if incomplete) |
| `ccc prices [--refresh]` | Model rates in use, marked built-in vs auto-resolved (with age); `--refresh` re-reads the published table |
| `ccc audit [--days N] [--backfill] [--accept] [--json]` | Reconcile ccc's cost math against Anthropic's meter; `--backfill` rebuilds the period from stored samples, `--accept` freezes the current per-model ratios as the drift baseline |
| `ccc launch --ttl 1h\|5m [--no-rtk] [-- args]` | Start `claude` with a cache-TTL profile (`ENABLE_PROMPT_CACHING_1H=1` / `FORCE_PROMPT_CACHING_5M=1`) |
| `ccc code [dir] --ttl 1h\|5m` | Same, for VS Code (extension sessions inherit the env) |
| `ccc daemon start\|stop\|status`, `ccc ensure-daemon` | Daemon control (SessionStart hook auto-starts it) |
| `ccc open` | Dashboard (countdown rings, month/today meter + costs, cache economics, tokens-by-tool, rtk verdict) |
| `ccc doctor` | Transcript schema-drift canary, TTL observation, daemon health |

The table uses a bare `ccc`, which exists once you `npm link` from the repo root. Without that, prefix
every command with the interpreter — `node packages/cli/src/ccc.ts <command>` — from the repo directory.

## Starting a session with a cache TTL (1h / 5m)

Claude Code chooses its prompt-cache TTL from environment variables that are read **once, at session
start** — you cannot change the TTL of a session that is already running. `ccc launch` (terminal) and
`ccc code` (VS Code) set those variables and start the session for you.

| You want | Command | Env it sets |
|---|---|---|
| 1-hour cache | `ccc launch --ttl 1h` | `ENABLE_PROMPT_CACHING_1H=1` |
| 5-minute cache | `ccc launch --ttl 5m` | `FORCE_PROMPT_CACHING_5M=1` |

### Terminal (CLI sessions)

```sh
ccc launch --ttl 1h                       # 1-hour prompt cache
ccc launch --ttl 5m                       # 5-minute prompt cache
ccc launch --ttl 1h --no-rtk              # ...with rtk's hooks stripped for this session only
ccc launch --ttl 1h -- --model opus       # everything after `--` is passed through to `claude`
```

`ccc launch` runs `claude` in the foreground with your terminal attached, so it behaves exactly like
typing `claude` yourself. `--no-rtk` copies your settings minus rtk's hook entries to a temp file and
passes it as `--settings`; it is CLI-only, because the VS Code extension always reads the standard
settings file.

### VS Code (extension sessions)

```sh
ccc code --ttl 1h                         # current directory
ccc code . --ttl 5m
ccc code ~/code/some-project --ttl 1h
```

This spawns VS Code **detached** with the TTL variable in its environment. Every Claude session started
inside that window — including the extension's — inherits it, because the extension is a child of that
Code process. The directory argument is optional and defaults to `.`.

Two consequences worth knowing: a Code window that's already open won't pick up the new TTL (VS Code
reuses the running instance rather than re-reading the env, so open a **new window** or fully quit Code
first), and the setting is per-window, not global.

### Which one do you want?

1h is free on subscription plans (Pro/Max) and is the one to use for long sessions — it drops back to
5m if you spill into overage billing. 5m is the API-key default. Keep-warm deliberately refuses to arm
on 1h-tier sessions, since there is nothing to save there.

Don't trust the flag — trust the measurement. The dashboard countdown ring and `ccc doctor` both report
the TTL tier that the transcript's `cache_creation.ephemeral_*` breakdown says was **actually** used,
which is the only way to catch a profile that didn't take.

## Features

- **Cache countdown** — statusline `⏱ 4:37 (5m)` and dashboard ring, computed from the
  *observed* TTL tier of the last cache write; toast at T-60s with the cold re-write $ you'd pay.
- **Turn signal** — plays a sound + flashes the dashboard when Claude finishes, asks a question, or
  needs permission (replaces the Claude Notifier plugin). The sound is hook-driven so it fires even if
  the daemon is down; the flash rides SSE. Sound and flash toggle independently from dashboard Controls
  (or `turnSignal.sound` / `turnSignal.flash`); other knobs are config-only (e.g. `soundLeadMs`, per-reason `sounds`).
  Sounds come from the platform's own set (Windows `tada`/`chimes`/`notify`, macOS `Glass`/`Ping`/`Funk`,
  Linux's XDG sound theme) — see [Turn-signal sounds](#turn-signal-sounds).
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
  the meter delta since its baseline reading, and the tile note says what that baseline is: a real
  midnight reading (bare number), the last reading before the machine slept or shut down ("since Tue
  5:41 PM" — expected on a laptop, nothing was watching the meter overnight), or a baseline left old
  by broken polling (same note, flagged). If the meter's newest reading itself goes stale the tiles
  fall back to the local this-device estimate and say how old the meter is, rather than subtract a
  frozen number from itself and report $0.00.
- **Cost audit (permanent)** — the meter is the truth and ccc's per-turn math is a hypothesis, so
  the daemon measures the hypothesis continuously. Every interval bounded by local quiet on both
  sides yields an independent (authoritative dollars, local dollars) pair; `ccc audit` aggregates
  them into an overall ratio plus per-model and per-session ratios. Quiet boundaries are what make
  it honest: the meter trails live usage, so a boundary drawn mid-burst would separate a turn's cost
  from the meter movement it caused. Freeze the ratios with `ccc audit --accept` and a later rate
  change, expiring promotion or mispriced model shows up as drift — with a toast — instead of
  silently moving every dollar figure. Windows where the meter moved with no local turn are spend
  ccc cannot see (the Claude app, claude.ai, another machine) and are reported separately rather
  than folded into the ratio. `--backfill` reconstructs past windows from meter samples already on
  disk, so a fresh install can answer the question immediately.
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
- **Model rates and cache minimums survive new releases** — a model released after the build
  isn't in the pricing table, so every cost for it reads **$0** until someone edits the code
  (exactly what happened with `claude-opus-5`), and its minimum cacheable prefix falls back to
  a conservative 4096 that keep-warm then reasons from. The daemon now notices a model it can't
  price and resolves both the rates (pricing page) and the minimum cacheable prefix
  (prompt-caching page) from Anthropic's docs, caching them with provenance. The two pages are
  fetched independently — one failing or changing shape doesn't discard the other's result.
  Deliberately conservative: nothing is fetched until an unpriceable model actually appears
  (or a cached rate ages past `pricing.refreshDays`); the fetch is off the hot path; the
  built-in table always wins so hand-curated date windows (Sonnet 5's intro pricing) can't be
  clobbered by a flattened scrape; and a failed or unparseable lookup leaves the model at a
  visible $0 rather than substituting a guess. The page carries base, fast-mode, and batch
  rates for the same model, so the parser keys on the 6-column base table and cross-checks
  each row's published cache columns against the 1.25x/2x/0.1x multipliers — a mismatch means
  either a misparse or that those constants went stale, and `ccc doctor` says so. Minimums are
  published as a bullet list rather than a table and are validated against the power-of-two
  shape every real value has. Precedence differs by design: a resolved **rate** loses to the
  built-in table (curated entries carry date windows a scrape can't express), while a resolved
  **minimum** wins over the built-in family regexes (an exact per-model figure beats a coarse
  family guess) — and any disagreement is reported so the built-in table can catch up.
  `ccc prices` shows what's built-in vs resolved. These are the only outbound requests to
  platform.claude.com (public pages, unauthenticated, nothing about your usage is sent);
  `pricing.autoResolve: false` disables them.
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
  "pricing": { "autoResolve": true, "refreshDays": 7 },
  "accountUsage": { "enabled": true, "pollSeconds": 300 },
  "guardian": { "action": "handoff", "notifyPct": 80, "actPct": 90 },
  "keepwarm": { "enabled": true, "maxPingsPerIdle": 12 },
  "advisor": { "enabled": true, "nudgeEvery": 10 },
  "naming": { "enabled": true, "model": "haiku" },
  "turnSignal": { "enabled": true, "sound": true, "flash": true, "soundLeadMs": 750 },
  "dashboard": { "cardView": "advanced" }
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
- **Card view** — `dashboard.cardView`: `advanced` (default) is the full session card; `simple` keeps
  only **Session cost**, **Cost / turn** and **Cold re-write**, stacked above the cache ring, and hides
  the rest of the card (…by model, Switch model, Keep-warm, the context-prefix and fresh-chat notes).
  Simple also loads with every section below the cards folded, so the page is just the cards. View-only —
  the daemon still measures everything either way, so switching back shows the same numbers. Also in Controls.
- **Model-rate auto-resolve** — `pricing.autoResolve` looks up rates and cache minimums for
  models released after this build (see the feature note above); `pricing.refreshDays`
  re-checks already-resolved values. Off ⇒ an unknown model costs $0, its cache minimum falls
  back to 4096, and `ccc doctor` names it. Config-only, not in Controls.
- **Account meter** — `accountUsage.enabled` feeds the month/today tiles from the claude.ai Usage
  endpoint (`accountUsage.pollSeconds` between polls, floored at 60); off ⇒ tiles fall back to the
  local estimate. The endpoint rate-limits: a 60s cadence drew a 429 asking for hours of silence, so
  the default is 300s and any server-requested backoff is capped at 15 minutes. Config-only, not in
  Controls.

The keep-warm, advisor, naming, guardian, card-view and turn-signal sound/flash settings are also live-togglable
from the dashboard **Controls** panel (writes `config.json` and takes effect immediately, no daemon restart).
Every dashboard section is collapsible — click its heading to fold it away.

### Turn-signal sounds

Each reason gets its own sound, taken from whatever the platform already ships:

| Reason | Windows | macOS | Linux (XDG sound theme) |
|---|---|---|---|
| `done` — Claude finished | `tada.wav` | `Glass.aiff` | `complete` |
| `question` — Claude is asking | `chimes.wav` | `Ping.aiff` | `message` |
| `permission` — needs approval | `notify.wav` | `Funk.aiff` | `dialog-information` |

Override any of them with an absolute path in `turnSignal.sounds` (`""` = platform default):

```json
{ "turnSignal": { "sounds": { "done": "/home/me/sounds/tada.wav", "question": "", "permission": "" } } }
```

A configured path that no longer exists falls back to the platform default instead of going silent.

**Linux specifics.** There is no single guaranteed sound file or audio player on Linux, so the hook
resolves both at play time. It searches `$XDG_DATA_HOME/sounds`, `/usr/local/share/sounds` and
`/usr/share/sounds` across the `freedesktop`, `Yaru`, `gnome`, `ubuntu` and `oxygen` themes for
`.oga`/`.ogg`/`.wav`, and picks the first player actually installed from `pw-play` (PipeWire),
`paplay` (PulseAudio), `canberra-gtk-play`, `ffplay`, `mpv`, `ogg123`, `play` (sox), `aplay`, `cvlc`.

The ordering matters for a specific reason: **`aplay` has no decoder.** Handed a compressed file it
doesn't fail — it falls back to RAW playback and renders the Vorbis bytes as samples, which comes out
as several seconds of static. So `aplay` is only ever offered `.wav`/`.au`, and `ogg123` only
`.oga`/`.ogg`. If no sound theme is installed at all, or the only player present can't decode the theme's
format, the hook synthesizes a short chime WAV into the state dir (`sound/ccc-<reason>.wav`) and plays
that — so Linux is never silent and never static.

If you hear nothing on Linux, install a player and a theme:
`sudo apt install pipewire-bin sound-theme-freedesktop` (or `pulseaudio-utils` on a PulseAudio box).

`turnSignal.soundLeadMs` (default 750) is Windows-only: it prepends that much silence to the WAV so the
audio endpoint's spin-up clips the silence instead of the start of the sound.

## Cache economics cheat-sheet (why this exists)

- cache read = **0.1×** base input; 5m write = **1.25×**; 1h write = **2×**; every hit refreshes the TTL free.
- Subscription sessions get the 1h TTL free (drops to 5m in overage); API-key sessions default to 5m.
- Caches are **model-scoped**: `/model` mid-session throws the whole cache away.
- ~12 pings ≈ one cold 5m re-write, so keep-warm pays only if you return within ~55 minutes.

## Development

```sh
npm test          # vitest (222 tests: adapter, economics, tailer, tracker, guardian, advisor, keep-warm, attribution, turn-signal, namer, launcher, controls, account-usage, window-sampler, rtk-setup, install-marker, price-docs, price-resolver)
npm run typecheck
```

The transcript schema is officially internal/unstable — all parsing lives in
`packages/core/src/transcript-adapter.ts` behind tolerant per-line parsing, and
`ccc doctor` flags drift (parse-error rate, missing ephemeral breakdown, unknown models).
