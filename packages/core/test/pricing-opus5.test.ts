import { describe, expect, it } from "vitest";
import {
  CACHE_READ_MULT,
  CACHE_WRITE_1H_MULT,
  CACHE_WRITE_5M_MULT,
  lookupPrice,
  minCacheablePrefix,
} from "../src/pricing.ts";
import { turnCost } from "../src/pricing.ts";
import type { Usage } from "../src/types.ts";

/**
 * Figures verified 2026-07-28 against
 * platform.claude.com/docs/en/about-claude/pricing and .../build-with-claude/prompt-caching.
 *
 * Regression guard: claude-opus-5 was absent from both tables, so every cost on the
 * default model read $0 and its cache minimum defaulted to 4096 (8x the real 512).
 */
describe("claude-opus-5 pricing", () => {
  it("is in the table at the published base rates", () => {
    expect(lookupPrice("claude-opus-5")).toMatchObject({ inputPerM: 5, outputPerM: 25 });
  });

  it("resolves through the [1m] context-window suffix", () => {
    // The session model id is literally "claude-opus-5[1m]".
    expect(lookupPrice("claude-opus-5[1m]")).toMatchObject({ inputPerM: 5, outputPerM: 25 });
  });

  it("resolves the Bedrock-prefixed id", () => {
    expect(lookupPrice("anthropic.claude-opus-5")).toMatchObject({ inputPerM: 5, outputPerM: 25 });
  });

  it("derives the published per-model cache columns from the multipliers", () => {
    const base = 5;
    expect(base * CACHE_WRITE_5M_MULT).toBe(6.25); // published: $6.25 / MTok
    expect(base * CACHE_WRITE_1H_MULT).toBe(10); //   published: $10 / MTok
    expect(base * CACHE_READ_MULT).toBe(0.5); //      published: $0.50 / MTok
  });

  it("no longer reports unknownModel, and costs a turn correctly", () => {
    const usage: Usage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const cost = turnCost(usage, "claude-opus-5[1m]");
    expect(cost.unknownModel).toBe(false);
    expect(cost.inputUsd).toBeCloseTo(5, 10);
    expect(cost.outputUsd).toBeCloseTo(25, 10);
    expect(cost.totalUsd).toBeCloseTo(30, 10);
  });

  it("prices a 1h cache write at 2x base", () => {
    const usage: Usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 0 },
    };
    expect(turnCost(usage, "claude-opus-5").cacheWriteUsd).toBeCloseTo(10, 10);
  });
});

describe("minCacheablePrefix", () => {
  it("uses 512 for the newest models", () => {
    expect(minCacheablePrefix("claude-opus-5")).toBe(512);
    expect(minCacheablePrefix("claude-opus-5[1m]")).toBe(512);
    expect(minCacheablePrefix("claude-fable-5")).toBe(512);
    expect(minCacheablePrefix("claude-mythos-5")).toBe(512);
  });

  it("is not monotonic across the Opus 4.x generations", () => {
    expect(minCacheablePrefix("claude-opus-4-8")).toBe(1024);
    expect(minCacheablePrefix("claude-opus-4-7")).toBe(2048);
    expect(minCacheablePrefix("claude-opus-4-6")).toBe(4096);
    expect(minCacheablePrefix("claude-opus-4-5")).toBe(4096);
  });

  it("uses 1024 across the Sonnet line", () => {
    expect(minCacheablePrefix("claude-sonnet-5")).toBe(1024);
    expect(minCacheablePrefix("claude-sonnet-4-6")).toBe(1024);
    expect(minCacheablePrefix("claude-sonnet-4-5")).toBe(1024);
  });

  it("keeps Haiku 4.5 at 4096 and Mythos Preview at 2048", () => {
    expect(minCacheablePrefix("claude-haiku-4-5")).toBe(4096);
    expect(minCacheablePrefix("claude-mythos-preview")).toBe(2048);
  });
});
