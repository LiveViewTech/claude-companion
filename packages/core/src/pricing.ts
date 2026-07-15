import type { PriceSpec, TtlTier, Usage } from "./types.ts";

/**
 * Date-aware pricing table, USD per million tokens.
 * Derived rates (fixed multipliers of input price, per Anthropic docs):
 *   cache read = 0.1x · 5m cache write = 1.25x · 1h cache write = 2.0x
 * Sources: Anthropic pricing docs as of 2026-07. Sonnet 5 has intro pricing until 2026-08-31.
 */
const TABLE: Record<string, PriceSpec[]> = {
  "claude-fable-5": [{ inputPerM: 10, outputPerM: 50 }],
  "claude-mythos-5": [{ inputPerM: 10, outputPerM: 50 }],
  "claude-opus-4-8": [{ inputPerM: 5, outputPerM: 25 }],
  "claude-opus-4-7": [{ inputPerM: 5, outputPerM: 25 }],
  "claude-opus-4-6": [{ inputPerM: 5, outputPerM: 25 }],
  "claude-opus-4-5": [{ inputPerM: 5, outputPerM: 25 }],
  "claude-opus-4-1": [{ inputPerM: 15, outputPerM: 75 }],
  "claude-sonnet-5": [
    { inputPerM: 2, outputPerM: 10, until: "2026-09-01" },
    { inputPerM: 3, outputPerM: 15, from: "2026-09-01" },
  ],
  "claude-sonnet-4-6": [{ inputPerM: 3, outputPerM: 15 }],
  "claude-sonnet-4-5": [{ inputPerM: 3, outputPerM: 15 }],
  "claude-haiku-4-5": [{ inputPerM: 1, outputPerM: 5 }],
};

export const CACHE_READ_MULT = 0.1;
export const CACHE_WRITE_5M_MULT = 1.25;
export const CACHE_WRITE_1H_MULT = 2.0;

/** Minimum cacheable prefix per model family (tokens). Below this, nothing caches. */
const MIN_CACHEABLE: Array<[RegExp, number]> = [
  [/^claude-(fable|mythos|sonnet-4-6)/, 2048],
  [/^claude-(opus-4-[5-8]|haiku-4-5)/, 4096],
  [/^claude-sonnet/, 1024],
];

export function minCacheablePrefix(modelId: string): number {
  const norm = normalizeModelId(modelId);
  for (const [re, min] of MIN_CACHEABLE) if (re.test(norm)) return min;
  return 4096; // conservative default
}

/** Strip context-window suffixes ("[1m]"), date suffixes, and provider prefixes. */
export function normalizeModelId(modelId: string): string {
  let m = modelId.trim().toLowerCase();
  m = m.replace(/\[[^\]]*\]$/, ""); // claude-fable-5[1m] -> claude-fable-5
  m = m.replace(/^anthropic\./, "");
  m = m.replace(/-\d{8}$/, ""); // dated snapshot -> alias
  return m;
}

export function lookupPrice(modelId: string, atIso?: string): PriceSpec | null {
  const norm = normalizeModelId(modelId);
  const specs = TABLE[norm] ?? null;
  if (!specs) {
    // Prefix fallback (e.g. future point releases): longest matching key.
    const key = Object.keys(TABLE)
      .filter((k) => norm.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) return null;
    return pickByDate(TABLE[key]!, atIso);
  }
  return pickByDate(specs, atIso);
}

function pickByDate(specs: PriceSpec[], atIso?: string): PriceSpec | null {
  const at = atIso ? atIso.slice(0, 10) : new Date().toISOString().slice(0, 10);
  for (const s of specs) {
    if (s.from && at < s.from) continue;
    if (s.until && at >= s.until) continue;
    return s;
  }
  return specs[specs.length - 1] ?? null;
}

export interface TurnCost {
  totalUsd: number;
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  /** True when pricing for the model was unknown and cost is 0. */
  unknownModel: boolean;
}

/** Cost of a single turn from its usage block, honoring the per-TTL write breakdown. */
export function turnCost(usage: Usage, modelId: string, atIso?: string): TurnCost {
  const price = lookupPrice(modelId, atIso);
  if (!price) {
    return { totalUsd: 0, inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0, unknownModel: true };
  }
  const perTok = price.inputPerM / 1_000_000;
  const outPerTok = price.outputPerM / 1_000_000;
  const w5 = usage.cache_creation?.ephemeral_5m_input_tokens;
  const w1 = usage.cache_creation?.ephemeral_1h_input_tokens;
  let cacheWriteUsd: number;
  if (w5 != null || w1 != null) {
    cacheWriteUsd = (w5 ?? 0) * perTok * CACHE_WRITE_5M_MULT + (w1 ?? 0) * perTok * CACHE_WRITE_1H_MULT;
  } else {
    // Breakdown absent: assume 5m tier (cheaper, conservative under-estimate flagged by doctor).
    cacheWriteUsd = usage.cache_creation_input_tokens * perTok * CACHE_WRITE_5M_MULT;
  }
  const inputUsd = usage.input_tokens * perTok;
  const outputUsd = usage.output_tokens * outPerTok;
  const cacheReadUsd = usage.cache_read_input_tokens * perTok * CACHE_READ_MULT;
  return {
    totalUsd: inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd,
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    unknownModel: false,
  };
}

/** TTL tier of a usage block: which ephemeral bucket the write landed in. Null when no write info. */
export function ttlTierOf(usage: Usage): TtlTier | null {
  const w5 = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const w1 = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  if (w1 > 0 && w1 >= w5) return "1h";
  if (w5 > 0) return "5m";
  return null;
}

export function ttlSeconds(tier: TtlTier): number {
  return tier === "1h" ? 3600 : 300;
}
