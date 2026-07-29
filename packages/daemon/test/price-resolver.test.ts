import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearResolvedCacheMinimums, clearResolvedPrices, lookupPrice, minCacheablePrefix } from "@ccc/core";
import { applyCachedPrices, loadPriceCache, PriceResolver } from "../src/price-resolver.ts";

const DOC = `
| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 7 | $7 / MTok | $8.75 / MTok | $14 / MTok | $0.70 / MTok | $35 / MTok |
`;

const CACHING_DOC = `
the minimum cacheable prompt length is:

* 512 tokens for Claude Opus 5 and Claude Opus 7
* 4,096 tokens for Claude Haiku 4.5
`;

let dir: string;
let cacheFile: string;

/**
 * The resolver fetches two pages. Route by URL so a test can fail one independently —
 * that independence is the property worth testing.
 */
function routedFetch(
  opts: { pricing?: string | number; caching?: string | number } = {},
  calls?: { pricing: number; caching: number },
): typeof fetch {
  return (async (url: string) => {
    const isCaching = String(url).includes("prompt-caching");
    const body = isCaching ? (opts.caching ?? CACHING_DOC) : (opts.pricing ?? DOC);
    if (calls) {
      if (isCaching) calls.caching++;
      else calls.pricing++;
    }
    if (typeof body === "number") return new Response("err", { status: body });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

function okFetch(body = DOC, calls?: { n: number }): typeof fetch {
  return (async (url: string) => {
    if (calls && !String(url).includes("prompt-caching")) calls.n++;
    if (String(url).includes("prompt-caching")) return new Response(CACHING_DOC, { status: 200 });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-price-"));
  cacheFile = path.join(dir, "model-prices.json");
  clearResolvedPrices();
  clearResolvedCacheMinimums();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  clearResolvedPrices();
  clearResolvedCacheMinimums();
});

describe("PriceResolver", () => {
  it("prices a model the built-in table doesn't know, and persists it", async () => {
    expect(lookupPrice("claude-opus-7")).toBeNull();

    const r = new PriceResolver({ enabled: true, refreshDays: 7, fetchFn: okFetch(), cacheFile });
    r.noteModel("claude-opus-7");
    await r.resolve();

    expect(lookupPrice("claude-opus-7")).toEqual({ inputPerM: 7, outputPerM: 35 });
    const cache = loadPriceCache(cacheFile);
    expect(cache.entries["claude-opus-7"]).toMatchObject({ inputPerM: 7, outputPerM: 35 });
    expect(cache.entries["claude-opus-7"]!.source).toContain("platform.claude.com");
    expect(cache.entries["claude-opus-7"]!.resolvedAt).toBeGreaterThan(0);
  });

  it("registers cached rates at construction, before any fetch", () => {
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 1,
        lastFetchAt: Date.now(),
        multiplierMismatch: [],
        unresolved: [],
        entries: {
          "claude-opus-7": { inputPerM: 7, outputPerM: 35, displayName: "Claude Opus 7", resolvedAt: Date.now(), source: "x" },
        },
      }),
    );
    // No fetchFn — construction alone must make the rate usable, so a daemon restart
    // doesn't re-cost history at $0 while waiting on the network.
    new PriceResolver({ enabled: true, refreshDays: 7, cacheFile });
    expect(lookupPrice("claude-opus-7")).toEqual({ inputPerM: 7, outputPerM: 35 });
  });

  it("does not fetch when every observed model is already priceable", async () => {
    const calls = { n: 0 };
    const r = new PriceResolver({ enabled: true, refreshDays: 7, fetchFn: okFetch(DOC, calls), cacheFile });
    r.noteModel("claude-opus-5"); // built-in
    r.noteModel("claude-haiku-4-5"); // built-in
    await r.resolve();
    expect(calls.n).toBe(0);
  });

  it("rate-limits repeat attempts but honours force", async () => {
    const calls = { n: 0 };
    const r = new PriceResolver({ enabled: true, refreshDays: 7, fetchFn: okFetch(DOC, calls), cacheFile });
    r.noteModel("claude-opus-7");
    await r.resolve();
    expect(calls.n).toBe(1);
    r.noteModel("claude-opus-9");
    await r.resolve(); // inside the interval — suppressed
    expect(calls.n).toBe(1);
    await r.resolve(true); // explicit refresh
    expect(calls.n).toBe(2);
  });

  it("leaves the model unpriced when the fetch fails — never guesses", async () => {
    const logs: string[] = [];
    const r = new PriceResolver({
      enabled: true,
      refreshDays: 7,
      cacheFile,
      fetchFn: (async () => {
        throw new Error("ENOTFOUND");
      }) as unknown as typeof fetch,
      log: (m) => logs.push(m),
    });
    r.noteModel("claude-opus-7");
    await r.resolve();
    expect(lookupPrice("claude-opus-7")).toBeNull();
    expect(logs.join(" ")).toContain("fetch failed");
  });

  it("leaves the model unpriced on a non-200", async () => {
    const r = new PriceResolver({
      enabled: true,
      refreshDays: 7,
      cacheFile,
      fetchFn: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    });
    r.noteModel("claude-opus-7");
    await r.resolve();
    expect(lookupPrice("claude-opus-7")).toBeNull();
  });

  it("keeps the prior cache when the page yields no usable rows", async () => {
    const r1 = new PriceResolver({ enabled: true, refreshDays: 7, fetchFn: okFetch(), cacheFile });
    r1.noteModel("claude-opus-7");
    await r1.resolve();

    const r2 = new PriceResolver({
      enabled: true,
      refreshDays: 7,
      cacheFile,
      fetchFn: okFetch("# Page was restructured\n\nno tables\n"),
    });
    await r2.resolve(true);
    // The known-good rate survives a format change rather than being wiped.
    expect(loadPriceCache(cacheFile).entries["claude-opus-7"]).toMatchObject({ inputPerM: 7 });
  });

  it("records a model that isn't listed in the published table", async () => {
    const r = new PriceResolver({ enabled: true, refreshDays: 7, fetchFn: okFetch(), cacheFile });
    r.noteModel("claude-imaginary-3");
    await r.resolve();
    expect(loadPriceCache(cacheFile).unresolved).toContain("claude-imaginary-3");
    expect(lookupPrice("claude-imaginary-3")).toBeNull();
  });

  it("reports a changed published rate rather than swapping it silently", async () => {
    const r1 = new PriceResolver({ enabled: true, refreshDays: 7, fetchFn: okFetch(), cacheFile });
    r1.noteModel("claude-opus-7");
    await r1.resolve();

    const logs: string[] = [];
    const cheaper = DOC.replace(
      "| Claude Opus 7 | $7 / MTok | $8.75 / MTok | $14 / MTok | $0.70 / MTok | $35 / MTok |",
      "| Claude Opus 7 | $6 / MTok | $7.50 / MTok | $12 / MTok | $0.60 / MTok | $30 / MTok |",
    );
    const r2 = new PriceResolver({
      enabled: true,
      refreshDays: 7,
      cacheFile,
      fetchFn: okFetch(cheaper),
      log: (m) => logs.push(m),
    });
    await r2.resolve(true);
    expect(logs.join(" ")).toContain("published rate changed");
    expect(loadPriceCache(cacheFile).entries["claude-opus-7"]).toMatchObject({ inputPerM: 6, outputPerM: 30 });
  });

  it("does nothing at all when disabled", async () => {
    const calls = { n: 0 };
    const r = new PriceResolver({ enabled: false, refreshDays: 7, fetchFn: okFetch(DOC, calls), cacheFile });
    r.noteModel("claude-opus-7");
    await r.resolve();
    expect(calls.n).toBe(0);
    expect(lookupPrice("claude-opus-7")).toBeNull();
  });

  it("ignores a corrupt or hand-edited cache entry", () => {
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 1,
        lastFetchAt: 0,
        entries: {
          "claude-bad-1": { inputPerM: "free", outputPerM: null },
          "claude-bad-2": { inputPerM: -5, outputPerM: 25 },
          "claude-good-1": { inputPerM: 1, outputPerM: 2, displayName: "g", resolvedAt: 1, source: "x" },
        },
      }),
    );
    const cache = loadPriceCache(cacheFile);
    expect(Object.keys(cache.entries)).toEqual(["claude-good-1"]);
  });

  it("resolves cache minimums alongside rates", async () => {
    const r = new PriceResolver({ enabled: true, refreshDays: 7, fetchFn: routedFetch(), cacheFile });
    r.noteModel("claude-opus-7");
    await r.resolve();
    // claude-opus-7 matches no family regex, so the built-in answer is the 4096 default.
    expect(minCacheablePrefix("claude-opus-7")).toBe(512);
    expect(loadPriceCache(cacheFile).cacheMinimums["claude-opus-7"]).toBe(512);
  });

  it("still applies minimums when the pricing page fails", async () => {
    const r = new PriceResolver({
      enabled: true,
      refreshDays: 7,
      cacheFile,
      fetchFn: routedFetch({ pricing: 503 }),
    });
    r.noteModel("claude-opus-7");
    await r.resolve();
    expect(lookupPrice("claude-opus-7")).toBeNull(); // rates unavailable
    expect(minCacheablePrefix("claude-opus-7")).toBe(512); // minimums still landed
  });

  it("still applies rates when the prompt-caching page fails", async () => {
    const r = new PriceResolver({
      enabled: true,
      refreshDays: 7,
      cacheFile,
      fetchFn: routedFetch({ caching: 503 }),
    });
    r.noteModel("claude-opus-7");
    await r.resolve();
    expect(lookupPrice("claude-opus-7")).toEqual({ inputPerM: 7, outputPerM: 35 });
    expect(minCacheablePrefix("claude-opus-7")).toBe(4096); // falls back to the default
  });

  it("gives up only when both pages are unreachable", async () => {
    const logs: string[] = [];
    const r = new PriceResolver({
      enabled: true,
      refreshDays: 7,
      cacheFile,
      fetchFn: routedFetch({ pricing: 503, caching: 503 }),
      log: (m) => logs.push(m),
    });
    r.noteModel("claude-opus-7");
    await r.resolve();
    expect(logs.join(" ")).toContain("both docs unreachable");
    expect(loadPriceCache(cacheFile).lastFetchAt).toBe(0); // nothing persisted
  });

  it("keeps previous minimums when the caching page stops parsing", async () => {
    const r1 = new PriceResolver({ enabled: true, refreshDays: 7, fetchFn: routedFetch(), cacheFile });
    r1.noteModel("claude-opus-7");
    await r1.resolve();

    const r2 = new PriceResolver({
      enabled: true,
      refreshDays: 7,
      cacheFile,
      fetchFn: routedFetch({ caching: "# restructured page, no minimums here\n" }),
    });
    await r2.resolve(true);
    expect(loadPriceCache(cacheFile).cacheMinimums["claude-opus-7"]).toBe(512);
  });

  it("records drift when a published minimum differs from the built-in table", async () => {
    const logs: string[] = [];
    const skewed = `
the minimum cacheable prompt length is:

* 1,024 tokens for Claude Haiku 4.5
`;
    const r = new PriceResolver({
      enabled: true,
      refreshDays: 7,
      cacheFile,
      fetchFn: routedFetch({ caching: skewed }),
      log: (m) => logs.push(m),
    });
    r.noteModel("claude-opus-7");
    await r.resolve();
    const drift = loadPriceCache(cacheFile).minimumDrift;
    expect(drift).toEqual([{ modelId: "claude-haiku-4-5", builtIn: 4096, published: 1024 }]);
    expect(logs.join(" ")).toContain("published value wins");
    // Published value is what callers get.
    expect(minCacheablePrefix("claude-haiku-4-5")).toBe(1024);
  });

  it("rejects an implausible minimum from a hand-edited cache", () => {
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 1,
        lastFetchAt: Date.now(),
        entries: {},
        cacheMinimums: { "claude-a-1": 1000, "claude-b-1": 0, "claude-c-1": 512 },
      }),
    );
    // Only the power-of-two in range survives — a bogus low value would make ccc claim a
    // prefix is cacheable when the API silently won't cache it.
    expect(loadPriceCache(cacheFile).cacheMinimums).toEqual({ "claude-c-1": 512 });
  });

  it("applyCachedPrices registers cached minimums too", () => {
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 1,
        lastFetchAt: Date.now(),
        entries: {},
        cacheMinimums: { "claude-opus-7": 512 },
      }),
    );
    expect(minCacheablePrefix("claude-opus-7")).toBe(4096);
    applyCachedPrices(cacheFile);
    expect(minCacheablePrefix("claude-opus-7")).toBe(512);
  });

  it("applyCachedPrices makes cached rates usable without a resolver", () => {
    // Regression: `ccc prices` and `ccc doctor` loaded the cache but never registered it,
    // so resolved-only models dropped off the table / were reported as unpriceable.
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 1,
        lastFetchAt: Date.now(),
        multiplierMismatch: [],
        unresolved: [],
        entries: {
          "claude-opus-4": { inputPerM: 15, outputPerM: 75, displayName: "Claude Opus 4", resolvedAt: 1, source: "x" },
        },
      }),
    );
    expect(lookupPrice("claude-opus-4")).toBeNull(); // not in the built-in table
    const cache = applyCachedPrices(cacheFile);
    expect(lookupPrice("claude-opus-4")).toEqual({ inputPerM: 15, outputPerM: 75 });
    expect(Object.keys(cache.entries)).toEqual(["claude-opus-4"]);
  });

  it("treats a future cache version as empty rather than trusting it", () => {
    fs.writeFileSync(cacheFile, JSON.stringify({ version: 999, entries: { x: { inputPerM: 1, outputPerM: 2 } } }));
    expect(loadPriceCache(cacheFile).entries).toEqual({});
  });

  it("surfaces a multiplier mismatch into the cache for doctor to report", async () => {
    const skewed = `
| Claude Opus 7 | $7 / MTok | $99 / MTok | $14 / MTok | $0.70 / MTok | $35 / MTok |
| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
`;
    const r = new PriceResolver({ enabled: true, refreshDays: 7, fetchFn: okFetch(skewed), cacheFile });
    r.noteModel("claude-opus-7");
    await r.resolve();
    expect(loadPriceCache(cacheFile).multiplierMismatch).toContain("claude-opus-7");
    expect(lookupPrice("claude-opus-7")).toBeNull();
  });

  it("refreshes stale cached rates without being asked about a new model", async () => {
    const calls = { n: 0 };
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 1,
        lastFetchAt: Date.now() - 30 * 86_400_000, // well past refreshDays
        multiplierMismatch: [],
        unresolved: [],
        entries: {
          "claude-opus-7": { inputPerM: 7, outputPerM: 35, displayName: "Claude Opus 7", resolvedAt: 1, source: "x" },
        },
      }),
    );
    const r = new PriceResolver({ enabled: true, refreshDays: 7, fetchFn: okFetch(DOC, calls), cacheFile });
    r.noteModel("claude-opus-5"); // priceable, but the cache is stale -> refresh
    await r.resolve();
    expect(calls.n).toBe(1);
  });
});
