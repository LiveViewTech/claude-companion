import { describe, expect, it } from "vitest";
import {
  breakEven,
  isColdRewrite,
  modelSwitchCostUsd,
  pingCostUsd,
  prefixTaxUsd,
  prefixTokens,
  rewriteCostUsd,
} from "../src/economics.ts";
import { lookupPrice, normalizeModelId, ttlTierOf, turnCost } from "../src/pricing.ts";
import type { Usage } from "../src/types.ts";

const FABLE = "claude-fable-5";

describe("pricing", () => {
  it("normalizes model ids", () => {
    expect(normalizeModelId("claude-fable-5[1m]")).toBe("claude-fable-5");
    expect(normalizeModelId("anthropic.claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  it("is date-aware for Sonnet 5 intro pricing", () => {
    expect(lookupPrice("claude-sonnet-5", "2026-07-11")?.inputPerM).toBe(2);
    // The scheduled 2026-09-01 rise to $3 was cancelled; $2 is now the standard price.
    expect(lookupPrice("claude-sonnet-5", "2026-09-15")?.inputPerM).toBe(2);
  });

  it("computes turn cost with per-TTL write rates (hand-computed)", () => {
    // Fable 5: $10/M input, $50/M output. 1h write = 2x, read = 0.1x.
    const usage: Usage = {
      input_tokens: 1000,
      output_tokens: 2000,
      cache_creation_input_tokens: 10_000,
      cache_read_input_tokens: 100_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10_000 },
    };
    const c = turnCost(usage, FABLE, "2026-07-11");
    expect(c.inputUsd).toBeCloseTo(0.01, 10); // 1000/1M * 10
    expect(c.outputUsd).toBeCloseTo(0.1, 10); // 2000/1M * 50
    expect(c.cacheReadUsd).toBeCloseTo(0.1, 10); // 100k/1M * 10 * 0.1
    expect(c.cacheWriteUsd).toBeCloseTo(0.2, 10); // 10k/1M * 10 * 2.0
    expect(c.totalUsd).toBeCloseTo(0.41, 10);
  });

  it("uses 1.25x when the write is 5m-tier", () => {
    const usage: Usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 10_000,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: 0 },
    };
    expect(turnCost(usage, FABLE).cacheWriteUsd).toBeCloseTo(0.125, 10); // 10k/1M * 10 * 1.25
  });

  it("detects TTL tier from ephemeral buckets", () => {
    expect(ttlTierOf({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1, cache_read_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 1, ephemeral_5m_input_tokens: 0 } })).toBe("1h");
    expect(ttlTierOf({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1, cache_read_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 1 } })).toBe("5m");
    expect(ttlTierOf({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 5 })).toBeNull();
  });
});

describe("economics", () => {
  it("prefix = read + write + uncached input", () => {
    expect(prefixTokens({ input_tokens: 300, output_tokens: 9, cache_creation_input_tokens: 700, cache_read_input_tokens: 199_000 })).toBe(200_000);
  });

  it("rewrite cost: 200k prefix on Fable 5 at 5m tier = $2.50", () => {
    expect(rewriteCostUsd(200_000, "5m", FABLE)).toBeCloseTo(2.5, 10); // 0.2M * 10 * 1.25
  });

  it("ping cost: 200k prefix read + 200 output tokens on Fable 5 = $0.21", () => {
    expect(pingCostUsd(200_000, FABLE, 200)).toBeCloseTo(0.21, 10); // 0.2M*10*0.1 + 200/1M*50
  });

  it("break-even ~ 11 pings for 200k prefix (5m tier)", () => {
    const be = breakEven(200_000, "5m", FABLE, 200);
    expect(be.pingsUntilBreakEven).toBe(11); // floor(2.50 / 0.21)
    expect(be.coverageMinutes).toBeGreaterThan(45);
  });

  it("flags cold rewrites only after TTL with zero cache read", () => {
    const cold: Usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 150_000, cache_read_input_tokens: 0 };
    const warm: Usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 500, cache_read_input_tokens: 150_000 };
    expect(isColdRewrite(cold, 400, "5m")).toBe(true);
    expect(isColdRewrite(cold, 200, "5m")).toBe(false); // within TTL
    expect(isColdRewrite(warm, 400, "5m")).toBe(false); // cache hit
    expect(isColdRewrite(cold, 400, null)).toBe(false); // unknown tier
  });

  it("model switch cost uses the new model's write rate", () => {
    // 200k prefix, switching to Opus 4.8 ($5/M) at 5m tier: 0.2M * 5 * 1.25 = $1.25
    expect(modelSwitchCostUsd(200_000, "5m", "claude-opus-4-8")).toBeCloseTo(1.25, 10);
  });

  it("prefix tax = warm cache read of the prefix (0.1x input), model-dependent", () => {
    // 460k prefix on Fable 5 ($10/M) at read rate: 0.46M * 10 * 0.1 = $0.46/turn (handoff example).
    expect(prefixTaxUsd(460_000, FABLE)).toBeCloseTo(0.46, 10);
    // Same prefix on Opus 4.8 ($5/M): half the tax.
    expect(prefixTaxUsd(460_000, "claude-opus-4-8")).toBeCloseTo(0.23, 10);
    // Unknown model prices at $0 rather than throwing.
    expect(prefixTaxUsd(460_000, "totally-unknown")).toBe(0);
  });
});
