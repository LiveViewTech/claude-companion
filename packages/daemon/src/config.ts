import fs from "node:fs";
import path from "node:path";
import { appPaths } from "@ccc/core";

/** Keep-warm behavior for one TTL tier. */
export interface KeepWarmTierPolicy {
  /** Allow keep-warm to arm at all on sessions measured at this tier. */
  arm: boolean;
  /** Soft cap on pings per idle period (user-overridable, never break-even-limited). */
  maxPingsPerIdle: number;
  /**
   * On reaching the ping cap, arm a HANDOFF.md instruction instead of going quiet.
   * Turns the cap from "stop saving money" into "switch to the cheaper strategy":
   * past the cap, writing the handoff and clearing beats both pinging and re-writing.
   */
  escalateToHandoff: boolean;
}

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
   * Console spend limit. null = show the running total with no cap.
   */
  monthlyBudgetUsd: number | null;
  /**
   * Automatic rate lookup for models released after this build. When a transcript
   * carries a model the built-in table can't price, the daemon fetches Anthropic's
   * published pricing table and caches the rate — otherwise every cost for that model
   * silently reads $0 until someone edits pricing.ts (which is what happened for
   * claude-opus-5).
   *
   * This is the only feature that makes an outbound request to platform.claude.com:
   * unauthenticated GET of a public docs page, no request body, nothing about your usage
   * leaves the machine. Set `autoResolve: false` to confine the daemon's network access
   * to the usage endpoint; new models then read $0 and `ccc doctor` names them.
   *
   * `refreshDays` re-checks already-resolved rates — a cached entry is a flattened
   * snapshot, and published rates do change (an expiring promotional rate is the usual case).
   */
  pricing: {
    autoResolve: boolean;
    refreshDays: number;
  };
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
    /**
     * Seconds between polls, floored at 60 by the daemon. The endpoint rate-limits:
     * a 60s cadence (1,440 requests/day) drew a 429 whose Retry-After ran into hours.
     * The number tracks a monthly total, so a coarse interval costs nothing.
     */
    pollSeconds: number;
  };
  /**
   * Cost audit — reconciles ccc's own pricing math against Anthropic's meter, continuously.
   * Every interval bounded by local quiet on both sides gives an independent (authoritative
   * dollars, local dollars) pair; their ratio is what catches a rate change, an expiring
   * promotion or a mispriced model, and windows where the meter moved with no local turn
   * are spend ccc can't see (the Claude app, another machine). Needs accountUsage on.
   */
  audit: {
    /** Master switch. */
    enabled: boolean;
    /**
     * Minutes of local quiet required on both sides of a window boundary. Must exceed the
     * meter's lag behind live usage, or a boundary drawn mid-burst splits a turn's cost
     * from the meter movement it caused. Longer = fewer, cleaner windows.
     */
    quietMinutes: number;
    /** Toast when a model's ratio drifts from its accepted baseline. */
    alertOnDrift: boolean;
  };
  guardian: {
    /** off | notify-only | wrapup | handoff */
    action: "off" | "notify-only" | "wrapup" | "handoff";
    notifyPct: number;
    actPct: number;
    /**
     * Where the handoff lives, relative to the session's cwd (or absolute). Both delivery
     * surfaces name this file, and the daemon resolves it against the session cwd before
     * handing it over, so the model is told an exact path instead of resolving "HANDOFF.md"
     * against whatever directory it happens to think it is in — which in a monorepo is a
     * coin flip between the repo root and a package.
     */
    handoffPath: string;
  };
  keepwarm: {
    /**
     * Master switch. When false, keep-warm never arms — the dashboard toggle and the
     * Stop-hook authorize both refuse — regardless of any per-session arming. Keep-warm
     * is opt-in per session even when enabled; this is the hard off switch on top of that.
     */
    enabled: boolean;
    /**
     * Which account this machine's sessions run on. This ONLY seeds the expected TTL tier
     * for a session that has not yet reported a cache write — the moment a turn carries
     * `ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`, the measured tier wins and
     * this is ignored. So a wrong setting here costs at most one idle period, never a
     * mispriced ping, and a machine that switches between accounts still behaves correctly.
     *
     *   "auto"       — no seeding; wait for the first measured cache write (safest)
     *   "pro"        — Claude Pro subscription seat: 5-minute cache
     *   "enterprise" — Enterprise seat or API token: 1-hour cache
     */
    accountType: "auto" | "pro" | "enterprise";
    /**
     * Policy per TTL tier, keyed by the tier the session actually measured. The two tiers
     * want opposite behavior, which is why this is not one global setting:
     *
     *  5m — the cache dies between turns on any real pause, so pinging is nearly always
     *       cheaper than the cold re-write it avoids. Ping freely.
     *  1h — the cache survives normal think-time, so pings only pay off across a genuine
     *       walk-away. A ping costs a full cache read; roughly a dozen of them cost more
     *       than the single re-write they were avoiding. So ping a few times to cover a
     *       meeting, then stop and escalate to a handoff rather than bleed pings overnight.
     */
    tiers: {
      "5m": KeepWarmTierPolicy;
      "1h": KeepWarmTierPolicy;
    };
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
  /** Dashboard-only view preferences. Nothing here changes what the daemon measures. */
  dashboard: {
    /**
     * Session-card density. "advanced" is the full card; "simple" keeps only session cost,
     * cost/turn and cold re-write, stacked above the cache ring. Lives in config.json (rather
     * than the browser) so the Controls panel stays a single source of truth.
     */
    cardView: "simple" | "advanced";
  };
}

export const DEFAULTS: CccConfig = {
  port: 47613,
  toasts: true,
  warnBeforeSeconds: 60,
  monthlyBudgetUsd: null,
  pricing: { autoResolve: true, refreshDays: 7 },
  accountUsage: { enabled: true, pollSeconds: 300 },
  audit: { enabled: true, quietMinutes: 15, alertOnDrift: true },
  guardian: { action: "notify-only", notifyPct: 80, actPct: 90, handoffPath: "HANDOFF.md" },
  keepwarm: {
    enabled: true,
    accountType: "auto",
    tiers: {
      // Unchanged from the pre-tier behavior: the 5m path is the one that was already armed.
      "5m": { arm: true, maxPingsPerIdle: 12, escalateToHandoff: false },
      // Previously refused outright (allow1hArm: false). Now armed with a low cap, because
      // the measured failure mode on a 1h seat is walking away for hours, not slow turns.
      "1h": { arm: true, maxPingsPerIdle: 3, escalateToHandoff: true },
    },
  },
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
  dashboard: { cardView: "advanced" },
};

export function configFile(): string {
  return path.join(appPaths().config, "config.json");
}

/**
 * Shape of the pre-tier keepwarm block, still on disk in any config written before
 * per-tier policy existed. `allow1hArm` was a single gate on the 1h tier and
 * `maxPingsPerIdle` a single cap across both tiers.
 */
type LegacyKeepwarm = Partial<CccConfig["keepwarm"]> & {
  allow1hArm?: boolean;
  maxPingsPerIdle?: number;
};

/**
 * Fold a pre-tier keepwarm block into the per-tier shape. The legacy keys are honored
 * rather than discarded — a config that deliberately refused the 1h tier keeps refusing
 * it until the user says otherwise — but only when `tiers` is absent, so a migrated
 * config is never re-migrated on top of the user's later edits.
 */
function migrateKeepwarm(raw: LegacyKeepwarm | undefined): CccConfig["keepwarm"] {
  const base: CccConfig["keepwarm"] = {
    ...DEFAULTS.keepwarm,
    ...(raw ?? {}),
    tiers: {
      "5m": { ...DEFAULTS.keepwarm.tiers["5m"], ...(raw?.tiers?.["5m"] ?? {}) },
      "1h": { ...DEFAULTS.keepwarm.tiers["1h"], ...(raw?.tiers?.["1h"] ?? {}) },
    },
  };
  if (raw && raw.tiers === undefined) {
    if (typeof raw.allow1hArm === "boolean") base.tiers["1h"].arm = raw.allow1hArm;
    if (typeof raw.maxPingsPerIdle === "number" && raw.maxPingsPerIdle > 0) {
      const cap = Math.floor(raw.maxPingsPerIdle);
      base.tiers["5m"].maxPingsPerIdle = cap;
      base.tiers["1h"].maxPingsPerIdle = cap;
    }
  }
  // The legacy keys are not part of CccConfig; drop them so saveConfig writes a clean file.
  delete (base as LegacyKeepwarm).allow1hArm;
  delete (base as LegacyKeepwarm).maxPingsPerIdle;
  return base;
}

export function loadConfig(): CccConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(), "utf8")) as Partial<CccConfig>;
    const guardian: CccConfig["guardian"] & { handoffAtContextTokens?: unknown } = {
      ...DEFAULTS.guardian,
      ...(raw.guardian ?? {}),
    };
    // Retired context-size trigger. Drop the stale key so saveConfig writes a clean file.
    delete guardian.handoffAtContextTokens;
    return {
      ...DEFAULTS,
      ...raw,
      pricing: { ...DEFAULTS.pricing, ...(raw.pricing ?? {}) },
      accountUsage: { ...DEFAULTS.accountUsage, ...(raw.accountUsage ?? {}) },
      audit: { ...DEFAULTS.audit, ...(raw.audit ?? {}) },
      guardian,
      keepwarm: migrateKeepwarm(raw.keepwarm as LegacyKeepwarm | undefined),
      advisor: { ...DEFAULTS.advisor, ...(raw.advisor ?? {}) },
      naming: { ...DEFAULTS.naming, ...(raw.naming ?? {}) },
      turnSignal: {
        ...DEFAULTS.turnSignal,
        ...(raw.turnSignal ?? {}),
        sounds: { ...DEFAULTS.turnSignal.sounds, ...(raw.turnSignal?.sounds ?? {}) },
      },
      dashboard: { ...DEFAULTS.dashboard, ...(raw.dashboard ?? {}) },
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg: CccConfig): void {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
}
