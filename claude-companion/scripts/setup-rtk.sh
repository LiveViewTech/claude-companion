#!/usr/bin/env bash
# setup-rtk.sh — install rtk (Rust Token Killer) + the Claude Code hook on Linux/macOS.
#
#   rtk: https://github.com/rtk-ai/rtk — a Rust CLI proxy that filters/compresses
#   dev-command output to cut LLM token use ~60-90%.
#
# This wraps rtk's OFFICIAL installer (which exists for unix), then ensures ripgrep
# is present and registers the Claude Code hook. Re-runnable.
#
#   Usage:  ./setup-rtk.sh [--skip-ripgrep] [--skip-init] [--force]
#   Undo:   rtk init -g --uninstall
#
# ⚠️  NOT TESTED ON UNIX BY US — authored on a Windows-only box. The Windows path
#     (scripts/setup-rtk.ps1) is the verified one. Treat this as a best-effort
#     port: read it before running, and expect to tweak the package-manager bits.
set -euo pipefail

SKIP_RIPGREP=0
SKIP_INIT=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --skip-ripgrep) SKIP_RIPGREP=1 ;;
    --skip-init)    SKIP_INIT=1 ;;
    --force)        FORCE=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

info() { printf '\033[36m[rtk-setup]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[rtk-setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[rtk-setup]\033[0m %s\n' "$*"; }

# ---------------------------------------------------------------------------
# 1. Install / update rtk via the official installer (idempotent-ish)
# ---------------------------------------------------------------------------
if command -v rtk >/dev/null 2>&1 && [ "$FORCE" -eq 0 ]; then
  ok "rtk already installed: $(rtk --version). Use --force to reinstall."
else
  if command -v brew >/dev/null 2>&1; then
    info 'Installing rtk via Homebrew...'
    brew install rtk || brew upgrade rtk
  else
    info 'Installing rtk via official install.sh (-> ~/.local/bin)...'
    curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
  fi
fi

# Make sure ~/.local/bin is on PATH for this shell (installer target).
case ":$PATH:" in
  *":$HOME/.local/bin:"*) : ;;
  *) export PATH="$HOME/.local/bin:$PATH"
     warn 'Added ~/.local/bin to PATH for this shell; add it to your shell rc to persist.' ;;
esac

command -v rtk >/dev/null 2>&1 || { echo "rtk not on PATH after install" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 2. Ensure ripgrep (rg) — some rtk filters shell out to it
# ---------------------------------------------------------------------------
if [ "$SKIP_RIPGREP" -eq 0 ]; then
  if command -v rg >/dev/null 2>&1; then
    ok 'ripgrep (rg) already available.'
  else
    info 'Installing ripgrep...'
    if   command -v brew    >/dev/null 2>&1; then brew install ripgrep
    elif command -v apt-get >/dev/null 2>&1; then sudo apt-get update && sudo apt-get install -y ripgrep
    elif command -v dnf     >/dev/null 2>&1; then sudo dnf install -y ripgrep
    elif command -v pacman  >/dev/null 2>&1; then sudo pacman -S --noconfirm ripgrep
    elif command -v zypper  >/dev/null 2>&1; then sudo zypper install -y ripgrep
    else warn 'No known package manager; install ripgrep manually and keep rg on PATH.'
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 3. Register the Claude Code hook (settings.json MERGE, backed up first)
# ---------------------------------------------------------------------------
if [ "$SKIP_INIT" -eq 0 ]; then
  if rtk init -g --show 2>&1 | grep -q 'RTK hook configured' && [ "$FORCE" -eq 0 ]; then
    ok 'Claude Code hook already configured; skipping init (use --force to re-run).'
  else
    settings="$HOME/.claude/settings.json"
    if [ -f "$settings" ]; then
      backup="$settings.rtk-setup-backup-$(date +%Y%m%d-%H%M%S)"
      cp "$settings" "$backup"
      ok "Backed up settings.json -> $backup"
    fi
    info 'Registering hook: rtk init -g --auto-patch'
    rtk init -g --auto-patch
  fi
fi

# ---------------------------------------------------------------------------
# Verify + summary
# ---------------------------------------------------------------------------
echo
info '--- verification ---'
rtk --version
[ "$SKIP_INIT" -eq 0 ] && rtk init -g --show 2>&1 | grep -E 'Hook:|RTK.md:|settings.json:' || true
echo
ok 'Done. Restart Claude Code so the hook loads (hooks snapshot at session start).'
ok 'Test after restart: run `git status`, then `rtk gain` to see savings.'
