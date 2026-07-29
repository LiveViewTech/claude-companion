# scripts/

> **These are no longer the primary path.** `ccc install` now checks for rtk and installs
> it natively (SHA-256-verified download, no `curl | sh`), then registers the hook in the
> same settings write — see the README's Quick start, or `ccc rtk` standalone. Reach for the
> scripts below only if you want rtk's **full** `init -g` footprint (which also writes
> `~/.claude/RTK.md` + an `@RTK.md` reference into your global `CLAUDE.md`) or ripgrep
> auto-installed via sudo — neither of which `ccc install` does.

Helper installers for [rtk (Rust Token Killer)](https://github.com/rtk-ai/rtk) +
its Claude Code hook. rtk is a Rust CLI proxy that filters/compresses dev-command
output to cut LLM token use by ~60-90%; ccc's dashboard measures the actual savings.

## What they do

Both scripts perform the full setup in one shot:

1. Install the `rtk` binary (download + **SHA256-verify** on Windows; official
   installer / Homebrew on unix).
2. Put it on your PATH.
3. Ensure **ripgrep** (`rg`) is present — some rtk filters shell out to it.
4. Register the Claude Code `PreToolUse` hook via `rtk init -g` (which **merges**
   into `~/.claude/settings.json` — existing hooks and permission rules are kept;
   settings.json is backed up first).

Both are **idempotent** — re-running detects what's already done and skips it.

## Windows (verified)

```powershell
pwsh -File scripts/setup-rtk.ps1
# options:
#   -Version v0.43.0     pin a release (default: latest)
#   -InstallDir <path>   where rtk.exe goes (default: ~\.local\bin)
#   -SkipRipgrep         don't touch ripgrep
#   -SkipInit            install the binary only, don't register the hook
#   -Force               re-download / re-run init even if already set up
```

## Linux / macOS (best-effort, **not tested on this machine**)

```sh
./setup-rtk.sh            # flags: --skip-ripgrep --skip-init --force
```

> Authored on a Windows-only box. Read it before running; the package-manager
> branches (apt/dnf/pacman/zypper/brew) may need tweaking for your distro.

## After running

Restart Claude Code — **hooks snapshot at session start**, so the rewrite only goes
live in the next session. Then verify:

```sh
git status     # Claude Code rewrites this to `rtk git status` transparently
rtk gain       # shows measured token savings
```

Undo the hook anytime: `rtk init -g --uninstall`
