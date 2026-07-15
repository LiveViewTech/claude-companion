import fs from "node:fs";
import path from "node:path";
import { appPaths } from "@ccc/core";

export interface CccConfig {
  port: number;
  toasts: boolean;
  /** Warn this many seconds before cache expiry. */
  warnBeforeSeconds: number;
  /**
   * Monthly API spend cap in USD, for the dashboard "this month" tile
   * ($X of $Y). ccc computes month-to-date from local transcripts — this is an
   * estimate that can read low if some sessions ran on another machine, and its
   * calendar-month window may differ from your Console billing cycle. Set to your
   * Console spend limit ($200 here). null = show the running total with no cap.
   */
  monthlyBudgetUsd: number | null;
  /**
   * Account-usage sync — polls Anthropic's OAuth usage endpoint (the source behind
   * the claude.ai Settings -> Usage page) with the Claude Code login token, so the
   * dashboard's monthly tile matches the website exactly: all devices/surfaces and
   * the real billing cycle, unlike the local transcript estimate. Read-only; the
   * token goes only to api.anthropic.com. Undocumented endpoint — on failure the
   * tile falls back to the local estimate + monthlyBudgetUsd.
   */
  accountUsage: {
    /** Master switch. */
    enabled: boolean;
    /** Seconds between polls. */
    pollSeconds: number;
  };
  guardian: {
    /** off | notify-only | wrapup | handoff */
    action: "off" | "notify-only" | "wrapup" | "handoff";
    notifyPct: number;
    actPct: number;
  };
  keepwarm: {
    /**
     * Master switch. When false, keep-warm never arms — the dashboard toggle and the
     * Stop-hook authorize both refuse — regardless of any per-session arming. Keep-warm
     * is opt-in per session even when enabled; this is the hard off switch on top of that.
     */
    enabled: boolean;
    /** Soft cap on pings per idle period (user-overridable, never break-even-limited). */
    maxPingsPerIdle: number;
  };
  /**
   * Plan-first advisor — nudges toward plan mode on design/planning-shaped prompts early
   * in a session. This is a SEPARATE feature from the usage-limit guardian's wrap-up/handoff
   * delivery, even though both ride the UserPromptSubmit hook: turning the advisor off
   * silences only the plan nudge; guardian delivery stays governed by `guardian.action`.
   */
  advisor: {
    /** Master switch for the plan-first nudge. */
    enabled: boolean;
    /** Minimum prompts between nudges, per session. */
    nudgeEvery: number;
  };
  /**
   * Session naming — the daemon summarizes each session's prompts into a dashboard
   * name + description by running `claude -p` headless on a cheap model. Uses your
   * existing claude login (no API key needed); a few one-shot haiku calls per active
   * session per hour. Disable if you don't want ccc spending anything on your behalf.
   */
  naming: {
    /** Master switch. */
    enabled: boolean;
    /** Model passed to `claude -p --model` for naming calls. */
    model: string;
  };
  /**
   * "It's your turn" signal — plays a sound + flashes the dashboard when Claude
   * finishes, asks a question, or needs permission. Replaces the Claude Notifier
   * plugin. The sound is played by the turn-signal hook (works even if the daemon
   * is down); the flash is driven by the daemon over SSE.
   */
  turnSignal: {
    /** Master switch. */
    enabled: boolean;
    /** Play a sound on the user's turn. */
    sound: boolean;
    /** Flash the dashboard on the user's turn. */
    flash: boolean;
    /** CSS color for the dashboard flash. */
    flashColor: string;
    /** Flash duration in milliseconds. */
    flashMs: number;
    /**
     * Leading silence (ms) the turn-signal HOOK plays before the real sound on Windows, so the
     * audio device wakes during the silence instead of clipping the start of the sound ("I only
     * hear the end"). Bump this if the start is still cut off; 0 disables the pre-roll. (Read by
     * the hook from config.json; the daemon just carries it through.)
     */
    soundLeadMs: number;
    /**
     * Sound file per reason. Absolute path, or "" to use the platform default.
     * On Windows the defaults resolve to C:\Windows\Media\*.wav.
     */
    sounds: {
      /** Claude finished its turn (Stop). */
      done: string;
      /** Claude is asking the user a question (AskUserQuestion). */
      question: string;
      /** Claude needs the user to approve something (Notification). */
      permission: string;
    };
  };
}

export const DEFAULTS: CccConfig = {
  port: 47613,
  toasts: true,
  warnBeforeSeconds: 60,
  monthlyBudgetUsd: null,
  accountUsage: { enabled: true, pollSeconds: 60 },
  guardian: { action: "notify-only", notifyPct: 80, actPct: 90 },
  keepwarm: { enabled: true, maxPingsPerIdle: 12 },
  advisor: { enabled: true, nudgeEvery: 10 },
  naming: { enabled: true, model: "haiku" },
  turnSignal: {
    enabled: true,
    sound: true,
    flash: true,
    flashColor: "#ffffff",
    flashMs: 260,
    // 750ms of device spin-up before the sound so its opening isn't clipped;
    // lower it to tighten the flash->sound gap, raise it if clipping returns.
    soundLeadMs: 750,
    // "" means: let the hook pick a sensible per-platform default.
    sounds: { done: "", question: "", permission: "" },
  },
};

export function configFile(): string {
  return path.join(appPaths().config, "config.json");
}

export function loadConfig(): CccConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(), "utf8")) as Partial<CccConfig>;
    return {
      ...DEFAULTS,
      ...raw,
      accountUsage: { ...DEFAULTS.accountUsage, ...(raw.accountUsage ?? {}) },
      guardian: { ...DEFAULTS.guardian, ...(raw.guardian ?? {}) },
      keepwarm: { ...DEFAULTS.keepwarm, ...(raw.keepwarm ?? {}) },
      advisor: { ...DEFAULTS.advisor, ...(raw.advisor ?? {}) },
      naming: { ...DEFAULTS.naming, ...(raw.naming ?? {}) },
      turnSignal: {
        ...DEFAULTS.turnSignal,
        ...(raw.turnSignal ?? {}),
        sounds: { ...DEFAULTS.turnSignal.sounds, ...(raw.turnSignal?.sounds ?? {}) },
      },
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg: CccConfig): void {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
}
