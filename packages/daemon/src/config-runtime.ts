import type { CccConfig } from "./config.ts";

const GUARDIAN_ACTIONS: readonly CccConfig["guardian"]["action"][] = ["off", "notify-only", "wrapup", "handoff"];
const CARD_VIEWS: readonly CccConfig["dashboard"]["cardView"][] = ["simple", "advanced"];
const ACCOUNT_TYPES: readonly CccConfig["keepwarm"]["accountType"][] = ["auto", "subscription", "api"];
const TTL_TIERS = ["5m", "1h"] as const;

/** The live-updatable subset of the config the dashboard can PATCH (each block optional/partial). */
export type ConfigUpdate = {
  keepwarm?: Omit<Partial<CccConfig["keepwarm"]>, "tiers"> & {
    /** Patch one or both tiers, field by field. */
    tiers?: Partial<Record<"5m" | "1h", Partial<CccConfig["keepwarm"]["tiers"]["5m"]>>>;
  };
  advisor?: Partial<CccConfig["advisor"]>;
  guardian?: Partial<CccConfig["guardian"]>;
  naming?: Partial<CccConfig["naming"]>;
  turnSignal?: Partial<Pick<CccConfig["turnSignal"], "sound" | "flash">>;
  dashboard?: Partial<CccConfig["dashboard"]>;
};

/** Which features a config update just switched OFF, so the caller can tear down in-flight state. */
export interface ConfigUpdateEffects {
  /** Keep-warm went enabled -> disabled: caller should disarm armed sessions. */
  keepwarmDisabled: boolean;
  /** Guardian went active -> "off": caller should clear pending wrap-up/handoff actions. */
  guardianDisabled: boolean;
}

/**
 * Validate a partial config update from the dashboard and apply the accepted fields to
 * `cfg` IN PLACE — every engine (guardian/keepwarm/advisor) holds this same reference, so
 * a change takes effect on their next call with no daemon restart. Unknown keys and invalid
 * values are ignored (the object is never replaced, only its known toggles mutated). Returns
 * which features were just turned off so the caller can tear down in-flight state.
 */
export function applyConfigUpdate(cfg: CccConfig, updates: ConfigUpdate): ConfigUpdateEffects {
  const effects: ConfigUpdateEffects = { keepwarmDisabled: false, guardianDisabled: false };

  if (updates.keepwarm && typeof updates.keepwarm.enabled === "boolean") {
    if (cfg.keepwarm.enabled && !updates.keepwarm.enabled) effects.keepwarmDisabled = true;
    cfg.keepwarm.enabled = updates.keepwarm.enabled;
  }
  if (updates.keepwarm && typeof updates.keepwarm.accountType === "string" && ACCOUNT_TYPES.includes(updates.keepwarm.accountType)) {
    cfg.keepwarm.accountType = updates.keepwarm.accountType;
  }
  // Per-tier policy. Each tier is patched independently so the dashboard can send just
  // the field that changed without having to echo the whole block back.
  for (const tier of TTL_TIERS) {
    const patch = updates.keepwarm?.tiers?.[tier];
    if (!patch) continue;
    const target = cfg.keepwarm.tiers[tier];
    if (typeof patch.arm === "boolean") target.arm = patch.arm;
    if (typeof patch.escalateToHandoff === "boolean") target.escalateToHandoff = patch.escalateToHandoff;
    if (typeof patch.maxPingsPerIdle === "number" && patch.maxPingsPerIdle > 0) {
      target.maxPingsPerIdle = Math.floor(patch.maxPingsPerIdle);
    }
  }

  if (updates.naming && typeof updates.naming.enabled === "boolean") cfg.naming.enabled = updates.naming.enabled;

  if (updates.advisor && typeof updates.advisor.enabled === "boolean") cfg.advisor.enabled = updates.advisor.enabled;
  if (updates.advisor && typeof updates.advisor.nudgeEvery === "number" && updates.advisor.nudgeEvery > 0) {
    cfg.advisor.nudgeEvery = Math.floor(updates.advisor.nudgeEvery);
  }

  if (updates.guardian && typeof updates.guardian.action === "string" && GUARDIAN_ACTIONS.includes(updates.guardian.action)) {
    if (cfg.guardian.action !== "off" && updates.guardian.action === "off") effects.guardianDisabled = true;
    cfg.guardian.action = updates.guardian.action;
  }
  // Where the handoff is written. Blank resets to the default rather than clearing it: an
  // empty path would make the instruction name nothing at all, which is strictly worse than
  // the old prose-only wording it replaced.
  if (updates.guardian && typeof updates.guardian.handoffPath === "string") {
    const v = updates.guardian.handoffPath.trim();
    cfg.guardian.handoffPath = v === "" ? "HANDOFF.md" : v;
  }

  if (updates.turnSignal && typeof updates.turnSignal.sound === "boolean") cfg.turnSignal.sound = updates.turnSignal.sound;
  if (updates.turnSignal && typeof updates.turnSignal.flash === "boolean") cfg.turnSignal.flash = updates.turnSignal.flash;

  // View-only: the dashboard reads this back on load so the card density survives a reload.
  if (updates.dashboard && typeof updates.dashboard.cardView === "string" && CARD_VIEWS.includes(updates.dashboard.cardView)) {
    cfg.dashboard.cardView = updates.dashboard.cardView;
  }

  return effects;
}
