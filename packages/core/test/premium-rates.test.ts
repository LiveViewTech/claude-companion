import { describe, expect, it } from "vitest";
import { prefixTaxUsd, rewriteCostUsd } from "../src/economics.ts";
import { effectiveRates, GEO_US_MULT, modsOf, turnCost } from "../src/pricing.ts";
import { parseLine } from "../src/transcript-adapter.ts";
import type { Usage } from "../src/types.ts";

/**
 * Fast mode and US-only inference are the two premiums a transcript reports and ccc used
 * to drop on the floor. Rates verified 2026-09-09 against
 * platform.claude.com/docs/en/about-claude/pricing (fast mode: Opus 5 / 4.8 at $10/$50,
 * caching multipliers stack on top) and .../manage-claude/data-residency (1.1x, all
 * categories, Claude 4.6+).
 *
 * Figures below are hand-computed against 1M-token blocks so a wrong multiplier is
 * readable in the failure message.
 */

function usage(over: Partial<Usage> = {}): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...over,
  };
}

describe("fast mode", () => {
  it("bills input and output at the premium pair", () => {
    const u = usage({ input_tokens: 1_000_000, output_tokens: 1_000_000, speed: "fast" });
    const c = turnCost(u, "claude-opus-5");
    expect(c.inputUsd).toBeCloseTo(10, 10); // $5 standard
    expect(c.outputUsd).toBeCloseTo(50, 10); // $25 standard
    expect(c.unpricedFastMode).toBe(false);
  });

  it("stacks the caching multipliers on top of the fast rate", () => {
    const write5m = turnCost(
      usage({ cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 1_000_000 }, speed: "fast" }),
      "claude-opus-5",
    );
    expect(write5m.cacheWriteUsd).toBeCloseTo(12.5, 10); // 1.25 x $10

    const write1h = turnCost(
      usage({ cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000 }, speed: "fast" }),
      "claude-opus-5",
    );
    expect(write1h.cacheWriteUsd).toBeCloseTo(20, 10); // 2 x $10

    const read = turnCost(usage({ cache_read_input_tokens: 1_000_000, speed: "fast" }), "claude-opus-5");
    expect(read.cacheReadUsd).toBeCloseTo(1, 10); // 0.1 x $10
  });

  it("leaves a standard turn untouched", () => {
    const u = usage({ input_tokens: 1_000_000, output_tokens: 1_000_000, speed: "standard" });
    const c = turnCost(u, "claude-opus-5");
    expect(c.inputUsd).toBeCloseTo(5, 10);
    expect(c.outputUsd).toBeCloseTo(25, 10);
  });

  it("falls back to standard rates, flagged, on a model with no fast tier", () => {
    // Sonnet 5 has no fast tier; inventing a premium would over-bill. Under-billing is the
    // safe direction, but the flag is what stops it from being silent.
    const c = turnCost(usage({ input_tokens: 1_000_000, speed: "fast" }), "claude-sonnet-5");
    expect(c.inputUsd).toBeCloseTo(2, 10);
    expect(c.unpricedFastMode).toBe(true);
  });

  it("applies to Opus 4.8 and not to Opus 4.6", () => {
    expect(effectiveRates("claude-opus-4-8", { speed: "fast" })?.inputPerM).toBe(10);
    // 4.6 accepts speed:"fast", runs standard and bills standard.
    expect(effectiveRates("claude-opus-4-6", { speed: "fast" })?.inputPerM).toBe(5);
    expect(effectiveRates("claude-opus-4-6", { speed: "fast" })?.unpricedFast).toBe(true);
  });
});

describe("inference geo", () => {
  it("bills US-only inference at 1.1x across every category", () => {
    const u = usage({
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_1h_input_tokens: 1_000_000 },
      inference_geo: "us",
    });
    const c = turnCost(u, "claude-opus-5");
    expect(c.inputUsd).toBeCloseTo(5 * GEO_US_MULT, 10);
    expect(c.outputUsd).toBeCloseTo(25 * GEO_US_MULT, 10);
    expect(c.cacheReadUsd).toBeCloseTo(0.5 * GEO_US_MULT, 10);
    expect(c.cacheWriteUsd).toBeCloseTo(10 * GEO_US_MULT, 10);
    expect(c.unknownGeo).toBe(false);
  });

  it("charges global routing at standard rates", () => {
    const c = turnCost(usage({ input_tokens: 1_000_000, inference_geo: "global" }), "claude-opus-5");
    expect(c.inputUsd).toBeCloseTo(5, 10);
    expect(c.unknownGeo).toBe(false);
  });

  it("stacks on top of fast mode rather than replacing it", () => {
    const c = turnCost(usage({ input_tokens: 1_000_000, speed: "fast", inference_geo: "us" }), "claude-opus-5");
    expect(c.inputUsd).toBeCloseTo(11, 10); // 1.1 x $10, not 1.1 x $5 and not $10
  });

  it("bills an unrecognized geo at standard rates, flagged", () => {
    const c = turnCost(usage({ input_tokens: 1_000_000, inference_geo: "eu" }), "claude-opus-5");
    expect(c.inputUsd).toBeCloseTo(5, 10);
    expect(c.unknownGeo).toBe(true);
  });
});

describe("projections follow the session's modifiers", () => {
  it("quotes a re-write and the prefix tax at fast rates", () => {
    const mods = { speed: "fast" };
    expect(rewriteCostUsd(1_000_000, "1h", "claude-opus-5", mods)).toBeCloseTo(20, 10);
    expect(rewriteCostUsd(1_000_000, "1h", "claude-opus-5")).toBeCloseTo(10, 10);
    expect(prefixTaxUsd(1_000_000, "claude-opus-5", mods)).toBeCloseTo(1, 10);
  });

  it("drops the premium when the projection is for a model without a fast tier", () => {
    // "What would switching to Sonnet cost?" is a standard-rate question even mid-fast-session.
    expect(rewriteCostUsd(1_000_000, "5m", "claude-sonnet-5", { speed: "fast" })).toBeCloseTo(2.5, 10);
  });
});

describe("transcript adapter", () => {
  it("carries speed and inference_geo off the usage block", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "u1",
      sessionId: "s1",
      timestamp: "2026-09-09T00:00:00Z",
      message: {
        model: "claude-opus-5",
        usage: { input_tokens: 1, output_tokens: 2, speed: "fast", inference_geo: "us" },
      },
    });
    const entry = parseLine(line).entry;
    expect(entry?.kind).toBe("assistant");
    const u = entry?.kind === "assistant" ? entry.usage : undefined;
    expect(u?.speed).toBe("fast");
    expect(u?.inference_geo).toBe("us");
    expect(modsOf(u!)).toEqual({ speed: "fast", geo: "us" });
  });

  it("leaves both undefined when the transcript omits them", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "u1",
      sessionId: "s1",
      timestamp: "2026-09-09T00:00:00Z",
      message: { model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 2 } },
    });
    const entry = parseLine(line).entry;
    const u = entry?.kind === "assistant" ? entry.usage : undefined;
    expect(u?.speed).toBeUndefined();
    expect(u?.inference_geo).toBeUndefined();
  });
});
