import { describe, expect, it } from "vitest";
import { displayNameToModelId, parseCacheMinimums, parseFastPricing, parsePricingDoc, specsFor } from "../src/price-docs.ts";
import {
  builtInCacheMinimum,
  clearResolvedCacheMinimums,
  clearResolvedPrices,
  lookupPrice,
  minCacheablePrefix,
  registerResolvedCacheMinimums,
  registerResolvedPrices,
} from "../src/pricing.ts";

/**
 * Excerpt of platform.claude.com/docs/en/about-claude/pricing.md as of 2026-07-28,
 * kept deliberately faithful: it includes all THREE tables that carry "$N / MTok"
 * cells, because the whole point of the 6-column rule is to not read fast-mode or
 * batch rates as base rates.
 */
const DOC = `
# Pricing

## Model pricing

| Model                                                                     | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
| ------------------------------------------------------------------------- | ----------------- | --------------- | --------------- | ---------------------- | ------------- |
| Claude Fable 5                                                            | $10 / MTok        | $12.50 / MTok   | $20 / MTok      | $1 / MTok              | $50 / MTok    |
| Claude Mythos 5 ([limited availability](https://anthropic.com/glasswing)) | $10 / MTok        | $12.50 / MTok   | $20 / MTok      | $1 / MTok              | $50 / MTok    |
| Claude Opus 5                                                             | $5 / MTok         | $6.25 / MTok    | $10 / MTok      | $0.50 / MTok           | $25 / MTok    |
| Claude Opus 4.8                                                           | $5 / MTok         | $6.25 / MTok    | $10 / MTok      | $0.50 / MTok           | $25 / MTok    |
| Claude Opus 4.1 ([deprecated](/docs/en/about-claude/model-deprecations))  | $15 / MTok        | $18.75 / MTok   | $30 / MTok      | $1.50 / MTok           | $75 / MTok    |
| Claude Sonnet 5 [through August 31, 2026](/docs/en/about-claude/pricing)  | $2 / MTok         | $2.50 / MTok    | $4 / MTok       | $0.20 / MTok           | $10 / MTok    |
| Claude Sonnet 5 starting September 1, 2026                                | $3 / MTok         | $3.75 / MTok    | $6 / MTok       | $0.30 / MTok           | $15 / MTok    |
| Claude Haiku 4.5                                                          | $1 / MTok         | $1.25 / MTok    | $2 / MTok       | $0.10 / MTok           | $5 / MTok     |

### Fast mode pricing

| Model                           | Input      | Output     |
| ------------------------------- | ---------- | ---------- |
| Claude Opus 5 / Claude Opus 4.8 | $10 / MTok | $50 / MTok |

### Batch processing

| Model           | Batch input  | Batch output  |
| --------------- | ------------ | ------------- |
| Claude Opus 5   | $2.50 / MTok | $12.50 / MTok |
| Claude Haiku 4.5 | $0.50 / MTok | $2.50 / MTok |
`;

describe("parsePricingDoc", () => {
  const parse = parsePricingDoc(DOC);
  const byId = new Map(parse.rows.map((r) => [r.modelId, r]));

  it("reads the base rates, not the fast-mode or batch rates", () => {
    // The single most important assertion in this file: Opus 5 appears three times on
    // the real page at $5/$25, $10/$50, and $2.50/$12.50.
    expect(byId.get("claude-opus-5")).toMatchObject({ inputPerM: 5, outputPerM: 25 });
  });

  it("does not emit a row for the fast-mode combined-name cell", () => {
    expect(byId.has("claude-opus-5-/-claude-opus-4-8")).toBe(false);
  });

  it("picks up every model in the 6-column table", () => {
    expect([...byId.keys()].sort()).toEqual([
      "claude-fable-5",
      "claude-haiku-4-5",
      "claude-mythos-5",
      "claude-opus-4-1",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-5",
    ]);
  });

  it("strips deprecation and availability qualifiers from names", () => {
    expect(byId.get("claude-opus-4-1")).toMatchObject({ inputPerM: 15, outputPerM: 75 });
    expect(byId.get("claude-mythos-5")).toMatchObject({ inputPerM: 10, outputPerM: 50 });
  });

  it("reports a duplicate id and keeps the first row", () => {
    // Sonnet 5 has an intro row and a successor row; first wins, duplicate flagged.
    expect(parse.duplicates).toContain("claude-sonnet-5");
    expect(byId.get("claude-sonnet-5")).toMatchObject({ inputPerM: 2, outputPerM: 10 });
  });

  it("finds no multiplier mismatches on a well-formed page", () => {
    expect(parse.multiplierMismatch).toEqual([]);
  });
});

describe("parsePricingDoc — rejection paths", () => {
  it("flags a row whose cache columns contradict the multipliers", () => {
    const bad = `
| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
| Claude Opus 9 | $5 / MTok | $99 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
`;
    const p = parsePricingDoc(bad);
    // Refused rather than trusted — a misparse and a multiplier change look identical here.
    expect(p.rows).toEqual([]);
    expect(p.multiplierMismatch).toEqual(["claude-opus-9"]);
  });

  it("rejects an implausible base rate", () => {
    const bad = `
| Claude Opus 9 | $5000 / MTok | $6250 / MTok | $10000 / MTok | $500 / MTok | $25000 / MTok |
`;
    expect(parsePricingDoc(bad).rows).toEqual([]);
  });

  it("rejects a row where output is cheaper than input", () => {
    const bad = `
| Claude Opus 9 | $25 / MTok | $31.25 / MTok | $50 / MTok | $2.50 / MTok | $5 / MTok |
`;
    expect(parsePricingDoc(bad).rows).toEqual([]);
  });

  it("ignores the header and separator rows without counting them as rejects", () => {
    const p = parsePricingDoc(DOC);
    // Header/separator rows have no price cells, so they're skipped before name parsing.
    expect(p.rejected).toBe(0);
  });

  it("returns nothing for an unrelated page", () => {
    expect(parsePricingDoc("# Some other page\n\nNo tables here.\n").rows).toEqual([]);
  });

  it("survives empty and garbage input", () => {
    expect(parsePricingDoc("").rows).toEqual([]);
    expect(parsePricingDoc("|||||\n| | | | | |").rows).toEqual([]);
  });
});

describe("displayNameToModelId", () => {
  it("maps published display names to API ids", () => {
    expect(displayNameToModelId("Claude Opus 5")).toBe("claude-opus-5");
    expect(displayNameToModelId("Claude Opus 4.8")).toBe("claude-opus-4-8");
    expect(displayNameToModelId("Claude Haiku 4.5")).toBe("claude-haiku-4-5");
    expect(displayNameToModelId("Claude Sonnet 4.6")).toBe("claude-sonnet-4-6");
  });

  it("rejects non-model cells", () => {
    expect(displayNameToModelId("Model")).toBeNull();
    expect(displayNameToModelId("Base Input Tokens")).toBeNull();
    expect(displayNameToModelId("")).toBeNull();
    expect(displayNameToModelId("Claude Opus")).toBeNull(); // no version digit
  });
});

/**
 * Verbatim excerpt of the prompt-caching page's "Cache limitations" block as of
 * 2026-07-28. A bullet list, not a table: thousands separators, markdown links,
 * per-name parentheticals, Oxford commas, and the same count across several bullets.
 */
const CACHING_DOC = `
### Cache limitations

On the Claude API, [Claude Platform on AWS](/docs/en/build-with-claude/claude-platform-on-aws), [Google Cloud](/docs/en/build-with-claude/claude-on-vertex-ai), and [Microsoft Foundry](/docs/en/build-with-claude/claude-in-microsoft-foundry), the minimum cacheable prompt length is:

* 512 tokens for Claude Opus 5, Claude Fable 5, and [Claude Mythos 5](https://anthropic.com/glasswing)
* 2,048 tokens for [Claude Mythos Preview](https://anthropic.com/glasswing) and Claude Opus 4.7
* 4,096 tokens for Claude Opus 4.6 and Claude Opus 4.5
* 1,024 tokens for Claude Opus 4.8, Claude Sonnet 5, Claude Sonnet 4.6, Claude Sonnet 4.5, Claude Opus 4.1 ([deprecated](/docs/en/about-claude/model-deprecations)), Claude Opus 4 ([retired, except on Google Cloud](/docs/en/about-claude/model-deprecations)), and Claude Sonnet 4 ([retired, except on Bedrock and Google Cloud](/docs/en/about-claude/model-deprecations))
* 4,096 tokens for Claude Haiku 4.5
* 2,048 tokens for Claude Haiku 3.5 ([retired, except on Google Cloud](/docs/en/about-claude/model-deprecations))

These minimums apply on every platform where each model is available.

Shorter prompts cannot be cached, even if marked with \`cache_control\`.
`;

describe("parseCacheMinimums", () => {
  const { minimums, rejected } = parseCacheMinimums(CACHING_DOC);

  it("reads every model in the block", () => {
    expect(minimums).toEqual({
      "claude-opus-5": 512,
      "claude-fable-5": 512,
      "claude-mythos-5": 512,
      "claude-mythos-preview": 2048,
      "claude-opus-4-7": 2048,
      "claude-opus-4-6": 4096,
      "claude-opus-4-5": 4096,
      "claude-opus-4-8": 1024,
      "claude-sonnet-5": 1024,
      "claude-sonnet-4-6": 1024,
      "claude-sonnet-4-5": 1024,
      "claude-opus-4-1": 1024,
      "claude-opus-4": 1024,
      "claude-sonnet-4": 1024,
      "claude-haiku-4-5": 4096,
      "claude-haiku-3-5": 2048,
    });
  });

  it("strips thousands separators", () => {
    expect(minimums["claude-opus-4-8"]).toBe(1024); // published as "1,024"
  });

  it("splits an Oxford-comma list carrying links and parentheticals", () => {
    // The 1,024 bullet is the nastiest: 7 names, 3 with bracketed qualifiers.
    expect(minimums["claude-sonnet-4"]).toBe(1024);
    expect(minimums["claude-opus-4-1"]).toBe(1024);
  });

  it("handles the same count appearing in multiple bullets", () => {
    expect(minimums["claude-opus-4-6"]).toBe(4096);
    expect(minimums["claude-haiku-4-5"]).toBe(4096);
  });

  it("rejects nothing on a well-formed block", () => {
    expect(rejected).toBe(0);
  });

  it("stops at prose and does not wander into later lists", () => {
    const doc = `${CACHING_DOC}\n\n* 999999 tokens for Claude Bogus 1\n`;
    expect(parseCacheMinimums(doc).minimums["claude-bogus-1"]).toBeUndefined();
  });

  it("rejects a non-power-of-two count (a misread year, say)", () => {
    const doc = `the minimum cacheable prompt length is:\n\n* 2,026 tokens for Claude Opus 9\n`;
    const p = parseCacheMinimums(doc);
    expect(p.minimums).toEqual({});
    expect(p.rejected).toBe(1);
  });

  it("rejects out-of-range counts", () => {
    const lo = `the minimum cacheable prompt length is:\n\n* 128 tokens for Claude Opus 9\n`;
    const hi = `the minimum cacheable prompt length is:\n\n* 131072 tokens for Claude Opus 9\n`;
    expect(parseCacheMinimums(lo).minimums).toEqual({});
    expect(parseCacheMinimums(hi).minimums).toEqual({});
  });

  it("returns empty when the anchor sentence is absent", () => {
    expect(parseCacheMinimums("# Prompt caching\n\n* 512 tokens for Claude Opus 5\n").minimums).toEqual({});
  });

  it("survives empty input", () => {
    expect(parseCacheMinimums("").minimums).toEqual({});
  });
});

describe("minCacheablePrefix overlay", () => {
  it("prefers a published minimum over the built-in family guess", () => {
    clearResolvedCacheMinimums();
    // claude-sonnet-9 would fall to the /^claude-sonnet/ family rule at 1024.
    expect(builtInCacheMinimum("claude-sonnet-9")).toBe(1024);
    registerResolvedCacheMinimums({ "claude-sonnet-9": 512 });
    expect(minCacheablePrefix("claude-sonnet-9")).toBe(512); // published value wins
    // builtInCacheMinimum keeps reporting the static answer, so drift stays visible.
    expect(builtInCacheMinimum("claude-sonnet-9")).toBe(1024);
    clearResolvedCacheMinimums();
    expect(minCacheablePrefix("claude-sonnet-9")).toBe(1024);
  });

  it("prices a brand-new model's minimum instead of defaulting to 4096", () => {
    clearResolvedCacheMinimums();
    expect(minCacheablePrefix("claude-opus-9")).toBe(4096); // conservative default
    registerResolvedCacheMinimums({ "claude-opus-9": 512 });
    expect(minCacheablePrefix("claude-opus-9")).toBe(512);
    clearResolvedCacheMinimums();
  });

  it("resolves through the [1m] suffix", () => {
    clearResolvedCacheMinimums();
    registerResolvedCacheMinimums({ "claude-opus-9": 512 });
    expect(minCacheablePrefix("claude-opus-9[1m]")).toBe(512);
    clearResolvedCacheMinimums();
  });

  it("built-in MIN_CACHEABLE agrees with every published minimum", () => {
    clearResolvedCacheMinimums();
    const { minimums } = parseCacheMinimums(CACHING_DOC);
    // Canary: the hand-maintained family regexes must match the docs snapshot above. A
    // failure here means either the table drifted or a regex change had a side effect on a
    // neighbouring model (the -[56] / -[01] rules are order-sensitive).
    const drift = Object.entries(minimums)
      .filter(([id, v]) => builtInCacheMinimum(id) !== v)
      .map(([id, v]) => `${id}: built-in ${builtInCacheMinimum(id)} vs published ${v}`);
    expect(drift).toEqual([]);
  });
});

describe("parseFastPricing", () => {
  it("reads the fast table and splits its combined model cell", () => {
    const { fast } = parseFastPricing(DOC);
    expect(fast).toEqual({
      "claude-opus-5": { inputPerM: 10, outputPerM: 50 },
      "claude-opus-4-8": { inputPerM: 10, outputPerM: 50 },
    });
  });

  it("stops at the next heading, so the batch table is never read as a premium", () => {
    // Batch is three columns too, and a 50% DISCOUNT: reading it here would bill fast
    // turns at half rate instead of double. Haiku only appears in the batch table.
    const { fast } = parseFastPricing(DOC);
    expect(fast["claude-haiku-4-5"]).toBeUndefined();
  });

  it("finds nothing on a page with no fast-mode section", () => {
    expect(parseFastPricing("# Pricing\n\n| a | b | c |\n| $1 / MTok | $2 / MTok | $3 / MTok |").fast).toEqual({});
  });

  it("refuses a fast rate that is not above the base rate", () => {
    // Same shape as the real page but with the batch figures under the fast heading.
    const doc = DOC.replace("| Claude Opus 5 / Claude Opus 4.8 | $10 / MTok | $50 / MTok |", "| Claude Opus 5 | $2.50 / MTok | $12.50 / MTok |");
    const parse = parsePricingDoc(doc);
    const row = parse.rows.find((r) => r.modelId === "claude-opus-5");
    expect(row?.inputPerM).toBe(5); // base row intact
    expect(row?.fast).toBeUndefined();
  });

  it("attaches fast rates to the base row they belong to", () => {
    const parse = parsePricingDoc(DOC);
    const byId = new Map(parse.rows.map((r) => [r.modelId, r]));
    expect(byId.get("claude-opus-5")?.fast).toEqual({ inputPerM: 10, outputPerM: 50 });
    expect(byId.get("claude-opus-4-8")?.fast).toEqual({ inputPerM: 10, outputPerM: 50 });
    // Fable 5 is on the page but has no fast tier.
    expect(byId.get("claude-fable-5")?.fast).toBeUndefined();
  });
});

describe("specsFor + overlay precedence", () => {
  it("narrows a parse to the requested ids", () => {
    const specs = specsFor(parsePricingDoc(DOC), ["claude-opus-5", "claude-nonexistent-9"]);
    // Base rates from the 6-column table, fast rates from the fast-mode section — both
    // belong to the same spec, and the base pair is still the one costing a standard turn.
    expect(specs).toEqual({
      "claude-opus-5": { inputPerM: 5, outputPerM: 25, fast: { inputPerM: 10, outputPerM: 50 } },
    });
  });

  it("prices a model the built-in table has never heard of", () => {
    clearResolvedPrices();
    expect(lookupPrice("claude-opus-7")).toBeNull();
    registerResolvedPrices({ "claude-opus-7": { inputPerM: 7, outputPerM: 35 } });
    expect(lookupPrice("claude-opus-7")).toEqual({ inputPerM: 7, outputPerM: 35 });
    clearResolvedPrices();
  });

  it("never lets the overlay override a built-in date-windowed entry", () => {
    clearResolvedPrices();
    // A flattened scrape of Sonnet 5 must not clobber the curated intro-pricing window.
    registerResolvedPrices({ "claude-sonnet-5": { inputPerM: 999, outputPerM: 999 } });
    const p = lookupPrice("claude-sonnet-5", "2026-07-28T00:00:00Z");
    expect(p).toEqual({ inputPerM: 2, outputPerM: 10 });
    clearResolvedPrices();
  });

  it("normalizes ids on registration so [1m] and provider prefixes resolve", () => {
    clearResolvedPrices();
    registerResolvedPrices({ "anthropic.claude-opus-7": { inputPerM: 7, outputPerM: 35 } });
    expect(lookupPrice("claude-opus-7[1m]")).toEqual({ inputPerM: 7, outputPerM: 35 });
    clearResolvedPrices();
  });
});
