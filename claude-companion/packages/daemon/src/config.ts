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
  guardian: {
    /** off | notify-only | wrapup | handoff */
    action: "off" | "notify-only" | "wrapup" | "handoff";
    notifyPct: number;
    actPct: number;
  };
  keepwarm: {
    /** Soft cap on pings per idle period (user-overridable, never break-even-limited). */
    maxPingsPerIdle: number;
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
  guardian: { action: "notify-only", notifyPct: 80, actPct: 90 },
  keepwarm: { maxPingsPerIdle: 12 },
  turnSignal: {
    enabled: true,
    sound: true,
    flash: true,
    flashColor: "#ffffff",
    flashMs: 260,
    soundLeadMs: 1200,
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
      guardian: { ...DEFAULTS.guardian, ...(raw.guardian ?? {}) },
      keepwarm: { ...DEFAULTS.keepwarm, ...(raw.keepwarm ?? {}) },
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
