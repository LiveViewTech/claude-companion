import { describe, expect, it } from "vitest";
import { parsePricingDoc, specsFor } from "../src/price-docs.ts";
import { effectiveRates, lookupPrice, minCacheablePrefix, turnCost } from "../src/pricing.ts";
import type { Usage } from "../src/types.ts";

/**
 * Figures verified 2026-10-07 against platform.claude.com/docs/en/about-claude/pricing.
 * Haiku 5.5: $0.10 / $0.50 for prompts up to 100k tokens, $0.50 / $2.50 above; reads 0.1x.
 * Sonnet 5.5: $2 / $10, reads 0.1x ($0.20; the page prose says 0.05x, the meter says 0.1x).
 */
const M = 1_000_000;

function usage(over: Partial<Usage>): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...over };
}

describe("claude-haiku-5-5 pricing", () => {
  it("costs a short prompt at $0.10 / $0.50", () => {
    const c = turnCost(usage({ input_tokens: 1000, output_tokens: 1000 }), "claude-haiku-5-5");
    expect(c.unknownModel).toBe(false);
    expect(c.inputUsd).toBeCloseTo(0.0001, 10);
    expect(c.outputUsd).toBeCloseTo(0.0005, 10);
  });

  it("bills the whole request at 5x once the prompt passes 100k tokens", () => {
    const u = usage({
      input_tokens: 10_000,
      cache_read_input_tokens: 80_000,
      cache_creation_input_tokens: 20_000,
      output_tokens: 1000,
    });
    const c = turnCost(u, "claude-haiku-5-5");
    expect(c.inputUsd).toBeCloseTo((10_000 / M) * 0.5, 10);
    expect(c.cacheReadUsd).toBeCloseTo((80_000 / M) * 0.05, 10);
    expect(c.outputUsd).toBeCloseTo((1000 / M) * 2.5, 10);
  });

  it("stays on the short tier at exactly 100k", () => {
    const r = effectiveRates("claude-haiku-5-5", { promptTokens: 100_000 })!;
    expect(r.inputPerM).toBeCloseTo(0.1, 10);
    expect(effectiveRates("claude-haiku-5-5", { promptTokens: 100_001 })!.inputPerM).toBeCloseTo(0.5, 10);
  });

  it("uses the short tier when the prompt size is unknown", () => {
    expect(effectiveRates("claude-haiku-5-5")!.inputPerM).toBeCloseTo(0.1, 10);
  });

  it("stacks US-only inference on the long tier", () => {
    expect(effectiveRates("claude-haiku-5-5", { promptTokens: 200_000, geo: "us" })!.inputPerM).toBeCloseTo(0.55, 10);
  });

  it("has no fast tier and reads cache at 0.1x", () => {
    const c = turnCost(usage({ input_tokens: M, cache_read_input_tokens: 1000, speed: "fast" }), "claude-haiku-5-5");
    expect(c.unpricedFastMode).toBe(true);
    expect(effectiveRates("claude-haiku-5-5")!.cacheReadMult).toBe(0.1);
  });

  it("does not leak into Haiku 4.5", () => {
    expect(lookupPrice("claude-haiku-4-5")).toMatchObject({ inputPerM: 1, outputPerM: 5 });
    expect(lookupPrice("claude-haiku-4-5")?.longContext).toBeUndefined();
  });

  it("uses the 512-token cache minimum", () => {
    expect(minCacheablePrefix("claude-haiku-5-5")).toBe(512);
    expect(minCacheablePrefix("claude-haiku-4-5")).toBe(4096);
  });
});

describe("claude-sonnet-5-5 pricing", () => {
  it("reads cache at the standard 0.1x ($0.20), as the meter bills it", () => {
    const c = turnCost(usage({ input_tokens: M, output_tokens: M, cache_read_input_tokens: M }), "claude-sonnet-5-5");
    expect(c.inputUsd).toBeCloseTo(2, 10);
    expect(c.outputUsd).toBeCloseTo(10, 10);
    expect(c.cacheReadUsd).toBeCloseTo(0.2, 10);
  });
});

describe("parsePricingDoc: length-tiered rows", () => {
  const doc = `
| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :---- | :---- | :---- | :---- | :---- | :---- |
| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |
| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |
`;

  it("folds the over-100k row into the base row as a long-context tier", () => {
    const p = parsePricingDoc(doc);
    expect(p.duplicates).toEqual([]);
    expect(p.rows.filter((r) => r.modelId === "claude-haiku-5-5")).toHaveLength(1);
    expect(specsFor(p, ["claude-haiku-5-5"])["claude-haiku-5-5"]).toEqual({
      inputPerM: 0.1,
      outputPerM: 0.5,
      longContext: { overTokens: 100_000, inputPerM: 0.5, outputPerM: 2.5 },
    });
  });

  it("accepts Sonnet 5.5's published $0.20 read against the standard 0.1x", () => {
    const p = parsePricingDoc(doc);
    expect(p.multiplierMismatch).toEqual([]);
    expect(p.rows.map((r) => r.modelId)).toContain("claude-sonnet-5-5");
  });
});
