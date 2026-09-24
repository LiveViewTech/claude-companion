import { describe, expect, it } from "vitest";
import { breakEven, pingCostUsd, prefixTaxUsd } from "../src/economics.ts";
import { parsePricingDoc } from "../src/price-docs.ts";
import { builtInCacheReadMult, effectiveRates, lookupPrice, minCacheablePrefix, turnCost } from "../src/pricing.ts";
import type { Usage } from "../src/types.ts";

/**
 * Figures verified 2026-09-24 against platform.claude.com/docs/en/about-claude/pricing:
 *   Opus 5.5: $4 base, $5 5m write, $8 1h write, $0.20 cache read, $20 output
 *   fast mode: $8 / $40
 *
 * Regression guard: claude-opus-5-5 had no entry and prefix-matched claude-opus-5, so it
 * was costed at $5/$25 with 0.1x cache reads ($0.50 instead of $0.20).
 */
const M = 1_000_000;

function usage(over: Partial<Usage>): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...over };
}

describe("claude-opus-5-5 pricing", () => {
  it("has its own entry instead of inheriting claude-opus-5's", () => {
    expect(lookupPrice("claude-opus-5-5")).toMatchObject({ inputPerM: 4, outputPerM: 20, cacheReadMult: 0.05 });
    expect(lookupPrice("claude-opus-5-5[1m]")).toMatchObject({ inputPerM: 4, outputPerM: 20 });
    expect(lookupPrice("claude-opus-5")).toMatchObject({ inputPerM: 5, outputPerM: 25 });
  });

  it("costs input and output at $4 / $20", () => {
    const cost = turnCost(usage({ input_tokens: M, output_tokens: M }), "claude-opus-5-5[1m]");
    expect(cost.unknownModel).toBe(false);
    expect(cost.inputUsd).toBeCloseTo(4, 10);
    expect(cost.outputUsd).toBeCloseTo(20, 10);
  });

  it("reads cache at 0.05x ($0.20), not the standard 0.1x", () => {
    expect(turnCost(usage({ cache_read_input_tokens: M }), "claude-opus-5-5").cacheReadUsd).toBeCloseTo(0.2, 10);
    // Other models are unchanged.
    expect(turnCost(usage({ cache_read_input_tokens: M }), "claude-opus-5").cacheReadUsd).toBeCloseTo(0.5, 10);
  });

  it("keeps the standard write multipliers ($5 5m, $8 1h)", () => {
    const u = usage({
      cache_creation_input_tokens: 2 * M,
      cache_creation: { ephemeral_5m_input_tokens: M, ephemeral_1h_input_tokens: M },
    });
    expect(turnCost(u, "claude-opus-5-5").cacheWriteUsd).toBeCloseTo(5 + 8, 10);
  });

  it("bills fast mode at $8 / $40, with the 0.05x read stacked on the fast rate", () => {
    const u = usage({ input_tokens: M, output_tokens: M, cache_read_input_tokens: M, speed: "fast" });
    const cost = turnCost(u, "claude-opus-5-5");
    expect(cost.unpricedFastMode).toBe(false);
    expect(cost.inputUsd).toBeCloseTo(8, 10);
    expect(cost.outputUsd).toBeCloseTo(40, 10);
    expect(cost.cacheReadUsd).toBeCloseTo(0.4, 10);
  });

  it("stacks US-only inference on the reduced read rate", () => {
    const rates = effectiveRates("claude-opus-5-5", { geo: "us" })!;
    expect(rates.inputPerM * rates.cacheReadMult).toBeCloseTo(0.22, 10);
  });

  it("uses 0.05x in the keep-warm and prefix-tax projections", () => {
    expect(prefixTaxUsd(M, "claude-opus-5-5")).toBeCloseTo(0.2, 10);
    expect(pingCostUsd(M, "claude-opus-5-5", 0)).toBeCloseTo(0.2, 10);
    // 1h re-write $8 vs a $0.20 ping: 40 pings before a re-write is cheaper.
    expect(breakEven(M, "1h", "claude-opus-5-5", 0).pingsUntilBreakEven).toBe(40);
  });

  it("uses the 512-token cache minimum", () => {
    expect(minCacheablePrefix("claude-opus-5-5")).toBe(512);
  });

  it("scopes the read multiplier to the exact id", () => {
    expect(builtInCacheReadMult("claude-opus-5-5")).toBe(0.05);
    expect(builtInCacheReadMult("claude-opus-5")).toBe(0.1);
    expect(builtInCacheReadMult("claude-opus-5-5-1")).toBe(0.1);
  });
});

describe("parsePricingDoc — per-model read multipliers", () => {
  // Rows as published 2026-09-24, footnote markers included.
  const doc = `
| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :---- | :---- | :---- | :---- | :---- | :---- |
| Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |
| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Sonnet 5 | $2 / MTok<sup>3</sup> | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok<sup>3</sup> |
`;

  it("accepts the Opus 5.5 row against its recorded 0.05x read multiplier", () => {
    const p = parsePricingDoc(doc);
    expect(p.rows.find((r) => r.modelId === "claude-opus-5-5")).toMatchObject({ inputPerM: 4, outputPerM: 20 });
    expect(p.multiplierMismatch).not.toContain("claude-opus-5-5");
  });

  it("reads rows whose price cells carry footnote markers", () => {
    const p = parsePricingDoc(doc);
    expect(p.rows.map((r) => r.modelId)).toEqual(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5"]);
    expect(p.rows.find((r) => r.modelId === "claude-sonnet-5")).toMatchObject({ inputPerM: 2, outputPerM: 10 });
    expect(p.multiplierMismatch).toEqual([]);
  });

  it("still flags a non-standard read column ccc has no record of", () => {
    const odd = "| Claude Opus 9 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |";
    expect(parsePricingDoc(odd).multiplierMismatch).toEqual(["claude-opus-9"]);
  });
});

describe("claude-fable-5-1 / claude-mythos-5-1 pricing", () => {
  it("keeps Fable 5's base rates but reads cache at 0.025x ($0.25)", () => {
    for (const id of ["claude-fable-5-1", "claude-fable-5-1[1m]", "claude-mythos-5-1"]) {
      const cost = turnCost(usage({ input_tokens: M, output_tokens: M, cache_read_input_tokens: M }), id);
      expect(cost.inputUsd).toBeCloseTo(10, 10);
      expect(cost.outputUsd).toBeCloseTo(50, 10);
      expect(cost.cacheReadUsd).toBeCloseTo(0.25, 10);
    }
    expect(turnCost(usage({ cache_read_input_tokens: M }), "claude-fable-5").cacheReadUsd).toBeCloseTo(1, 10);
  });

  it("uses the 512-token cache minimum", () => {
    expect(minCacheablePrefix("claude-fable-5-1")).toBe(512);
    expect(minCacheablePrefix("claude-mythos-5-1")).toBe(512);
  });
});
