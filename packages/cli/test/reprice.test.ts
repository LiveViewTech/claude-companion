import { describe, expect, it } from "vitest";
import type { StoredTurn } from "@ccc/daemon/store";
import { costOfStoredTurn } from "../src/audit.ts";

const M = 1_000_000;

function row(over: Partial<StoredTurn>): StoredTurn {
  const t = {
    uuid: "req_1",
    ts: Date.parse("2026-09-23T12:00:00Z"),
    model: "claude-opus-5-5",
    inputTok: 0,
    outputTok: 0,
    cacheReadTok: 0,
    cacheW5Tok: 0,
    cacheW1hTok: 0,
    speed: null,
    geo: null,
    costUsd: 0,
    ...over,
  };
  // Consistent with the token columns unless a test overrides it.
  return { ...t, prefixTok: over.prefixTok ?? t.inputTok + t.cacheReadTok + t.cacheW5Tok + t.cacheW1hTok };
}

describe("costOfStoredTurn", () => {
  it("prices a stored Opus 5.5 turn at current rates", () => {
    // $4 in + $20 out + $0.20 read + $8 1h write
    const t = row({ inputTok: M, outputTok: M, cacheReadTok: M, cacheW1hTok: M });
    expect(costOfStoredTurn(t)).toBeCloseTo(4 + 20 + 0.2 + 8, 10);
  });

  it("applies stored fast-mode and US-geo modifiers", () => {
    expect(costOfStoredTurn(row({ inputTok: M, speed: "fast" }))).toBeCloseTo(8, 10);
    expect(costOfStoredTurn(row({ inputTok: M, geo: "us" }))).toBeCloseTo(4.4, 10);
  });

  it("refuses a turn whose cache-write total was lost at ingest", () => {
    // prefix_tok counts 1M write tokens the per-TTL columns don't have.
    expect(costOfStoredTurn(row({ cacheReadTok: M, prefixTok: 2 * M }))).toBeNull();
  });

  it("refuses a turn with no model or an unpriceable one", () => {
    expect(costOfStoredTurn(row({ model: null, inputTok: M }))).toBeNull();
    expect(costOfStoredTurn(row({ model: "<synthetic>", inputTok: M }))).toBeNull();
  });
});
