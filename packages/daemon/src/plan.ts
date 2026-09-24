import fs from "node:fs";
import { claudeCredentialsPath } from "@ccc/core";
import type { CccConfig } from "./config.ts";

/**
 * Subscription tiers billed as a flat monthly fee, as Claude Code records them in
 * `claudeAiOauth.subscriptionType`. Enterprise is left out on purpose: its seats are
 * commonly billed on usage, so hiding dollars there would hide the actual bill.
 */
const FLAT_TIERS = new Set(["pro", "max", "team"]);

export interface PlanInfo {
  /** Claude Code's recorded subscription tier; null for an API-key login or an unreadable file. */
  subscriptionType: string | null;
  /**
   * True on a flat-fee plan. Per-turn dollars are not what such a plan is billed, so every
   * surface drops them and shows tokens and the 5-hour / weekly usage windows instead.
   */
  flat: boolean;
}

/**
 * Read only `subscriptionType` from Claude Code's OAuth credentials. The tokens in the same
 * file are never returned or logged. Null when the file is missing (API-key login), mid-rewrite
 * on token rotation, or shaped differently.
 */
export function readSubscriptionType(file: string = claudeCredentialsPath()): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const oauth = raw["claudeAiOauth"];
    const t = typeof oauth === "object" && oauth !== null ? (oauth as Record<string, unknown>)["subscriptionType"] : null;
    return typeof t === "string" && t ? t.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Apply the `billing` setting: an explicit "flat" or "usage" wins, "auto" follows the login. */
export function resolvePlan(billing: CccConfig["billing"] | undefined, subscriptionType: string | null): PlanInfo {
  const flat = billing === "flat" ? true : billing === "usage" ? false : subscriptionType != null && FLAT_TIERS.has(subscriptionType);
  return { subscriptionType, flat };
}
