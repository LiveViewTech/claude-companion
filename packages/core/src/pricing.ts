import type { PriceSpec, TtlTier, Usage } from "./types.ts";

/**
 * Date-aware pricing table, USD per million tokens.
 * Derived rates (fixed multipliers of input price, per Anthropic docs):
 *   cache read = 0.1x · 5m cache write = 1.25x · 1h cache write = 2.0x
 * Sources: Anthropic pricing docs as of 2026-07. Sonnet 5 has intro pricing until 2026-08-31.
 * Verified 2026-07-28 against platform.claude.com/docs/en/about-claude/pricing — the
 * published per-model cache columns equal these multipliers exactly (e.g. Opus 5:
 * $5 base, $6.25 5m write, $10 1h write, $0.50 read), so deriving them is correct.
 */
const TABLE: Record<string, PriceSpec[]> = {
  "claude-fable-5": [{ inputPerM: 10, outputPerM: 50 }],
  "claude-mythos-5": [{ inputPerM: 10, outputPerM: 50 }],
  "claude-opus-5": [{ inputPerM: 5, outputPerM: 25 }],
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

/**
 * Rates resolved at runtime from Anthropic's published pricing table, so a model
 * released after this build still gets costed instead of reading $0. Populated by the
 * daemon (see daemon/price-resolver.ts); empty in any process that hasn't loaded it.
 *
 * TABLE always wins over OVERLAY: entries here are flattened to a single current rate,
 * so they must never clobber a hand-curated entry carrying date windows (Sonnet 5's
 * intro pricing would otherwise be overwritten with whichever row parsed first).
 */
const OVERLAY: Record<string, PriceSpec> = {};

/** Merge resolved rates in. Ids are normalized; existing overlay entries are replaced. */
export function registerResolvedPrices(prices: Record<string, PriceSpec>): void {
  for (const [id, spec] of Object.entries(prices)) OVERLAY[normalizeModelId(id)] = spec;
}

/** Ids currently served from the overlay rather than the built-in table. */
export function resolvedPriceIds(): string[] {
  return Object.keys(OVERLAY).sort();
}

/** Ids priced by the built-in table (hand-curated, authoritative over the overlay). */
export function builtInPriceIds(): string[] {
  return Object.keys(TABLE).sort();
}

/** True when this id would cost $0 — i.e. neither table nor overlay can price it. */
export function isUnpriced(modelId: string): boolean {
  return lookupPrice(modelId) === null;
}

export function clearResolvedPrices(): void {
  for (const k of Object.keys(OVERLAY)) delete OVERLAY[k];
}

/**
 * Minimum cacheable prefix per model family (tokens). Below this, nothing caches —
 * and no error is returned, so a too-short prefix silently reports 0 cache tokens.
 *
 * NOT monotonic across generations: 512 on the newest models but 4096 on Opus 4.6
 * and Haiku 4.5. Ordered most-specific first (first match wins), so the opus-4-8 /
 * -4-7 rules must precede the -4-[56] rule.
 * Verified 2026-07-28 against platform.claude.com/docs/en/build-with-claude/prompt-caching.
 */
const MIN_CACHEABLE: Array<[RegExp, number]> = [
  [/^claude-(opus-5|fable-5|mythos-5)/, 512],
  [/^claude-mythos-preview/, 2048],
  [/^claude-opus-4-8/, 1024],
  [/^claude-opus-4-7/, 2048],
  [/^claude-opus-4-[56]/, 4096],
  [/^claude-opus-4-[01]/, 1024],
  // Bare "claude-opus-4" (retired; normalizeModelId strips its date suffix). Must be
  // anchored — an unanchored /^claude-opus-4/ here would also swallow 4-5/4-6.
  [/^claude-opus-4$/, 1024],
  [/^claude-haiku-4-5/, 4096],
  [/^claude-haiku-3-5/, 2048],
  [/^claude-sonnet/, 1024],
];

/**
 * Minimums resolved at runtime from the prompt-caching page.
 *
 * Precedence here is the OPPOSITE of prices, deliberately. A resolved price must lose to
 * the built-in table because curated entries carry date windows a scrape can't express.
 * A resolved minimum is an exact per-model figure, while MIN_CACHEABLE below is a coarse
 * regex over model *families* — and that approximation was silently wrong for five models
 * before it was checked against the docs. So an exact resolved value wins over a family
 * guess, and any disagreement is reported (see builtInCacheMinimum) rather than hidden.
 */
const MIN_OVERLAY: Record<string, number> = {};

export function registerResolvedCacheMinimums(minimums: Record<string, number>): void {
  for (const [id, min] of Object.entries(minimums)) MIN_OVERLAY[normalizeModelId(id)] = min;
}

export function resolvedCacheMinimumIds(): string[] {
  return Object.keys(MIN_OVERLAY).sort();
}

export function clearResolvedCacheMinimums(): void {
  for (const k of Object.keys(MIN_OVERLAY)) delete MIN_OVERLAY[k];
}

/** The built-in (family-regex) answer, ignoring any resolved value — for drift reporting. */
export function builtInCacheMinimum(modelId: string): number {
  const norm = normalizeModelId(modelId);
  for (const [re, min] of MIN_CACHEABLE) if (re.test(norm)) return min;
  return 4096; // conservative default: over-estimating never claims a prefix is cacheable
}

export function minCacheablePrefix(modelId: string): number {
  const norm = normalizeModelId(modelId);
  const resolved = MIN_OVERLAY[norm];
  if (resolved !== undefined) return resolved;
  return builtInCacheMinimum(norm);
}

/** Strip context-window suffixes ("[1m]"), date suffixes, and provider prefixes. */
export function normalizeModelId(modelId: string): string {
  let m = modelId.trim().toLowerCase();
  m = m.replace(/\[[^\]]*\]$/, ""); // claude-fable-5[1m] -> claude-fable-5
  m = m.replace(/^anthropic\./, "");
  m = m.replace(/-\d{8}$/, ""); // dated snapshot -> alias
  return m;
}

/**
 * Resolution order, most trustworthy first:
 *   1. exact match in the built-in table (hand-curated, may carry date windows)
 *   2. exact match in the runtime overlay (resolved from the published table)
 *   3. longest prefix match in the built-in table (future point releases)
 *   4. longest prefix match in the overlay
 * Returns null when nothing matches — callers surface that as unknownModel, never $0
 * dressed up as a real number.
 */
export function lookupPrice(modelId: string, atIso?: string): PriceSpec | null {
  const norm = normalizeModelId(modelId);
  const specs = TABLE[norm];
  if (specs) return pickByDate(specs, atIso);

  const overlaid = OVERLAY[norm];
  if (overlaid) return overlaid;

  const key = longestPrefixKey(Object.keys(TABLE), norm);
  if (key) return pickByDate(TABLE[key]!, atIso);

  const overlayKey = longestPrefixKey(Object.keys(OVERLAY), norm);
  if (overlayKey) return OVERLAY[overlayKey]!;

  return null;
}

function longestPrefixKey(keys: string[], norm: string): string | undefined {
  return keys.filter((k) => norm.startsWith(k)).sort((a, b) => b.length - a.length)[0];
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
