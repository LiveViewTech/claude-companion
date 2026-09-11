import type { RateMods, TtlTier, Usage } from "./types.ts";
import {
  CACHE_READ_MULT,
  CACHE_WRITE_1H_MULT,
  CACHE_WRITE_5M_MULT,
  effectiveRates,
} from "./pricing.ts";

/**
 * Approximate cacheable prefix (tokens) after a turn: everything the next request
 * would re-read — cached reads + new writes + uncached input.
 */
export function prefixTokens(usage: Usage): number {
  return usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.input_tokens;
}

/**
 * Every projection below quotes the *next* request's price, so it takes the same rate
 * modifiers the session is currently running under: a session in fast mode pays fast
 * rates for its next cache write too, and quoting it at standard rates would halve every
 * re-write warning and break the keep-warm break-even. Omitting `mods` means standard
 * rates, which is what callers with no session context (a bare model comparison) want.
 */

/** USD to re-write `prefix` tokens cold at the given tier on the given model. */
export function rewriteCostUsd(prefix: number, tier: TtlTier, modelId: string, mods?: RateMods): number {
  const rates = effectiveRates(modelId, mods);
  if (!rates) return 0;
  const mult = tier === "1h" ? CACHE_WRITE_1H_MULT : CACHE_WRITE_5M_MULT;
  return (prefix / 1_000_000) * rates.inputPerM * mult;
}

/**
 * "Prefix tax": USD to carry the cached prefix for one more turn — the warm
 * cache read the next request pays just to re-read the existing context
 * (0.1x input rate). This is the ambient cost of NOT starting fresh; a new
 * chat pays ~0 of it. Same math as a keep-warm ping minus the output tokens.
 */
export function prefixTaxUsd(prefix: number, modelId: string, mods?: RateMods): number {
  const rates = effectiveRates(modelId, mods);
  if (!rates) return 0;
  return (prefix / 1_000_000) * rates.inputPerM * CACHE_READ_MULT;
}

/** USD for one cache-refreshing ping: prefix read + measured/estimated output. */
export function pingCostUsd(prefix: number, modelId: string, outputTokens = 200, mods?: RateMods): number {
  const rates = effectiveRates(modelId, mods);
  if (!rates) return 0;
  const read = (prefix / 1_000_000) * rates.inputPerM * CACHE_READ_MULT;
  const out = (outputTokens / 1_000_000) * rates.outputPerM;
  return read + out;
}

export interface BreakEven {
  pingUsd: number;
  rewriteUsd: number;
  /** Pings you can send before spending more than one cold re-write. */
  pingsUntilBreakEven: number;
  /** Minutes of keep-warm cover those pings buy at ~4.5 min cadence (5m TTL). */
  coverageMinutes: number;
}

export function breakEven(
  prefix: number,
  tier: TtlTier,
  modelId: string,
  measuredPingOutputTokens = 200,
  mods?: RateMods,
): BreakEven {
  const pingUsd = pingCostUsd(prefix, modelId, measuredPingOutputTokens, mods);
  const rewriteUsd = rewriteCostUsd(prefix, tier, modelId, mods);
  const n = pingUsd > 0 ? rewriteUsd / pingUsd : Infinity;
  const cadenceMin = tier === "1h" ? 55 : 4.5;
  return {
    pingUsd,
    rewriteUsd,
    pingsUntilBreakEven: Number.isFinite(n) ? Math.floor(n) : 0,
    coverageMinutes: Number.isFinite(n) ? Math.floor(n * cadenceMin) : 0,
  };
}

/**
 * Detect a cold re-write: a turn arriving after `gapSeconds` of idleness whose usage shows
 * no cache read but a substantial cache write (the whole prefix got re-written).
 */
export function isColdRewrite(usage: Usage, gapSeconds: number, tierBefore: TtlTier | null): boolean {
  if (tierBefore == null) return false;
  const ttl = tierBefore === "1h" ? 3600 : 300;
  return gapSeconds > ttl && usage.cache_read_input_tokens === 0 && usage.cache_creation_input_tokens > 1024;
}

/** Cost of switching to `newModel` right now: full prefix re-write at that model's rate. */
export function modelSwitchCostUsd(prefix: number, tier: TtlTier | null, newModelId: string, mods?: RateMods): number {
  return rewriteCostUsd(prefix, tier ?? "5m", newModelId, mods);
}
