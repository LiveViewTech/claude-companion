import fs from "node:fs";
import path from "node:path";
import {
  appPaths,
  builtInCacheMinimum,
  isUnpriced,
  parseCacheMinimums,
  parsePricingDoc,
  registerResolvedCacheMinimums,
  registerResolvedPrices,
  specsFor,
  type FastRates,
  type PriceSpec,
} from "@ccc/core";

/**
 * Keeps cost math working across model releases.
 *
 * A model that ships after this build isn't in the static pricing table, so every cost
 * for it reads $0 (that is exactly what happened with claude-opus-5). Rather than
 * requiring a code edit per release, the resolver watches for models the tables can't
 * price and looks their rates up in Anthropic's published pricing table.
 *
 * Deliberate properties:
 *  - Lazy. Nothing is fetched until an unpriceable model actually appears in a
 *    transcript. A machine whose models are all known never makes a request.
 *  - Off the hot path. resolve() is fire-and-forget; a turn is never delayed on it, and
 *    a failed lookup just leaves the model unpriced (visible $0 + doctor warning) rather
 *    than substituting a guess.
 *  - Cached to disk with provenance. Every entry records where and when it came from, so
 *    `ccc prices` / `ccc doctor` can distinguish a resolved rate from a built-in one.
 *    A resolved rate is a scrape, and the operator should be able to see that.
 *  - Re-checked on a TTL, because published rates change (a promotional rate expiring is
 *    the common case) and a cached entry is flattened to one current figure.
 */

const PRICING_DOC_URL = "https://platform.claude.com/docs/en/about-claude/pricing.md";
/** Minimum cacheable prefix per model — a separate page, fetched independently. */
const CACHING_DOC_URL = "https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md";
const CACHE_FILE = "model-prices.json";
const CACHE_VERSION = 1;
/** Don't hammer the docs when several unknown models appear at once, or on repeat failures. */
const MIN_FETCH_INTERVAL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;

export interface ResolvedEntry extends PriceSpec {
  /** Display name as published, for the CLI table. */
  displayName: string;
  /** ms epoch of the fetch that produced this entry. */
  resolvedAt: number;
  source: string;
}

export interface PriceCache {
  version: number;
  entries: Record<string, ResolvedEntry>;
  /** ms epoch of the last *successful* fetch, whether or not it yielded new entries. */
  lastFetchAt: number;
  /** Ids whose published cache columns disagreed with our multipliers. */
  multiplierMismatch: string[];
  /** Ids we looked for and could not find in the published table. */
  unresolved: string[];
  /**
   * modelId -> minimum cacheable prefix, from the prompt-caching page. Absent in caches
   * written before this field existed; treated as empty rather than invalidating them.
   */
  cacheMinimums: Record<string, number>;
  /** Models where the resolved minimum differs from the built-in family guess. */
  minimumDrift: Array<{ modelId: string; builtIn: number; published: number }>;
}

function emptyCache(): PriceCache {
  return {
    version: CACHE_VERSION,
    entries: {},
    lastFetchAt: 0,
    multiplierMismatch: [],
    unresolved: [],
    cacheMinimums: {},
    minimumDrift: [],
  };
}

export function priceCacheFile(): string {
  return path.join(appPaths().state, CACHE_FILE);
}

/**
 * Fast-mode rates survive a cache round-trip only if they still look like a premium.
 * Absent is the normal case (most models have no fast tier); a "premium" at or below the
 * base rate is a corrupted or hand-edited entry, and dropping it costs a fast turn at
 * standard rates instead of billing it at a rate nobody published.
 */
function validFast(fast: unknown, inputPerM: number, outputPerM: number): FastRates | undefined {
  const f = fast as Partial<FastRates> | undefined;
  if (!f || typeof f.inputPerM !== "number" || typeof f.outputPerM !== "number") return undefined;
  if (!Number.isFinite(f.inputPerM) || !Number.isFinite(f.outputPerM)) return undefined;
  if (f.inputPerM <= inputPerM || f.outputPerM <= outputPerM) return undefined;
  return { inputPerM: f.inputPerM, outputPerM: f.outputPerM };
}

function fmtFast(f: FastRates | undefined): string {
  return f ? `${f.inputPerM}/${f.outputPerM}` : "none";
}

/** The core-facing half of a cache entry (drops provenance). */
function specOf(e: ResolvedEntry): PriceSpec {
  return { inputPerM: e.inputPerM, outputPerM: e.outputPerM, ...(e.fast ? { fast: e.fast } : {}) };
}

export function loadPriceCache(file = priceCacheFile()): PriceCache {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PriceCache>;
    if (raw.version !== CACHE_VERSION || typeof raw.entries !== "object" || raw.entries === null) {
      return emptyCache();
    }
    const entries: Record<string, ResolvedEntry> = {};
    for (const [id, e] of Object.entries(raw.entries as Record<string, unknown>)) {
      const entry = e as Partial<ResolvedEntry>;
      // Re-validate on read: a hand-edited or truncated cache must not inject a bogus rate.
      if (
        typeof entry.inputPerM === "number" &&
        typeof entry.outputPerM === "number" &&
        Number.isFinite(entry.inputPerM) &&
        Number.isFinite(entry.outputPerM) &&
        entry.inputPerM > 0 &&
        entry.outputPerM > 0
      ) {
        const fast = validFast(entry.fast, entry.inputPerM, entry.outputPerM);
        entries[id] = {
          inputPerM: entry.inputPerM,
          outputPerM: entry.outputPerM,
          ...(fast ? { fast } : {}),
          displayName: typeof entry.displayName === "string" ? entry.displayName : id,
          resolvedAt: typeof entry.resolvedAt === "number" ? entry.resolvedAt : 0,
          source: typeof entry.source === "string" ? entry.source : PRICING_DOC_URL,
        };
      }
    }
    // Re-validate minimums on read too: a bogus low value would make ccc claim a prefix
    // is cacheable when the API silently won't cache it.
    const cacheMinimums: Record<string, number> = {};
    for (const [id, v] of Object.entries((raw.cacheMinimums ?? {}) as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isInteger(v) && v >= 256 && v <= 65536 && (v & (v - 1)) === 0) {
        cacheMinimums[id] = v;
      }
    }
    return {
      version: CACHE_VERSION,
      entries,
      lastFetchAt: typeof raw.lastFetchAt === "number" ? raw.lastFetchAt : 0,
      multiplierMismatch: Array.isArray(raw.multiplierMismatch) ? raw.multiplierMismatch : [],
      unresolved: Array.isArray(raw.unresolved) ? raw.unresolved : [],
      cacheMinimums,
      minimumDrift: Array.isArray(raw.minimumDrift) ? raw.minimumDrift : [],
    };
  } catch {
    return emptyCache();
  }
}

/**
 * Load the cache AND register it with core, returning the cache for reporting.
 *
 * Any process that prices turns must call this (or construct a PriceResolver) before
 * looking up rates — loading the cache alone does nothing, because lookupPrice() reads
 * the in-memory overlay, not the file. Skipping it makes a cached model look unpriceable:
 * $0 costs in the CLI and a false "missing from pricing table" warning in doctor.
 */
export function applyCachedPrices(file = priceCacheFile()): PriceCache {
  const cache = loadPriceCache(file);
  const specs: Record<string, PriceSpec> = {};
  for (const [id, e] of Object.entries(cache.entries)) specs[id] = specOf(e);
  if (Object.keys(specs).length > 0) registerResolvedPrices(specs);
  if (Object.keys(cache.cacheMinimums).length > 0) registerResolvedCacheMinimums(cache.cacheMinimums);
  return cache;
}

function savePriceCache(cache: PriceCache, file = priceCacheFile()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache, null, 2) + "\n");
  } catch {
    /* cache is an optimization; a read-only state dir must not break costing */
  }
}

export interface PriceResolverOptions {
  enabled: boolean;
  /** Re-check the published table when the newest entry is older than this. */
  refreshDays: number;
  /** Injection points for tests. */
  fetchFn?: typeof fetch;
  cacheFile?: string;
  now?: () => number;
  log?: (msg: string) => void;
}

export class PriceResolver {
  private cache: PriceCache;
  private inFlight: Promise<void> | null = null;
  private lastAttemptAt = 0;
  /** Models seen unpriced this process; retried only on refresh, not per turn. */
  private pending = new Set<string>();
  private opts: PriceResolverOptions;

  constructor(opts: PriceResolverOptions) {
    this.opts = opts;
    this.cache = loadPriceCache(opts.cacheFile ?? priceCacheFile());
    this.applyToCore();
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }

  /** Push cached rates and minimums into core so the lookups can serve them. */
  private applyToCore(): void {
    const specs: Record<string, PriceSpec> = {};
    for (const [id, e] of Object.entries(this.cache.entries)) specs[id] = specOf(e);
    if (Object.keys(specs).length > 0) registerResolvedPrices(specs);
    if (Object.keys(this.cache.cacheMinimums).length > 0) {
      registerResolvedCacheMinimums(this.cache.cacheMinimums);
    }
  }

  get status(): {
    enabled: boolean;
    entries: Record<string, ResolvedEntry>;
    lastFetchAt: number;
    stale: boolean;
    multiplierMismatch: string[];
    unresolved: string[];
    cacheMinimums: Record<string, number>;
    minimumDrift: Array<{ modelId: string; builtIn: number; published: number }>;
  } {
    return {
      enabled: this.opts.enabled,
      entries: this.cache.entries,
      lastFetchAt: this.cache.lastFetchAt,
      stale: this.isStale(),
      multiplierMismatch: this.cache.multiplierMismatch,
      unresolved: this.cache.unresolved,
      cacheMinimums: this.cache.cacheMinimums,
      minimumDrift: this.cache.minimumDrift,
    };
  }

  private isStale(): boolean {
    // A cache written before minimums existed has prices but no minimums; treat that as
    // stale once so the caching page gets read. lastFetchAt is stamped on every attempt,
    // so an empty result can't turn this into a fetch loop.
    if (Object.keys(this.cache.cacheMinimums).length === 0 && this.cache.lastFetchAt !== 0) {
      return this.now() - this.cache.lastFetchAt > MIN_FETCH_INTERVAL_MS;
    }
    if (this.cache.lastFetchAt === 0) return Object.keys(this.cache.entries).length > 0;
    return this.now() - this.cache.lastFetchAt > this.opts.refreshDays * 86_400_000;
  }

  /**
   * Called for every model observed in a transcript. Cheap and synchronous: returns
   * immediately unless this model can't be priced (or the cache is due a refresh), in
   * which case a single background fetch is kicked off. Never throws, never awaits.
   */
  noteModel(modelId: string): void {
    if (!this.opts.enabled || !modelId) return;
    const unpriced = isUnpriced(modelId);
    if (!unpriced && !this.isStale()) return;
    if (unpriced) this.pending.add(modelId);
    void this.resolve();
  }

  /**
   * Fetch + parse + persist. Coalesces concurrent callers and rate-limits attempts.
   * `force` bypasses the rate limit (used by `ccc prices --refresh`).
   */
  async resolve(force = false): Promise<void> {
    if (!this.opts.enabled && !force) return;
    if (this.inFlight) return this.inFlight;
    // Nothing to learn and nothing stale: don't touch the network. This is what makes the
    // boot-time call free on a machine whose models are all already priceable.
    if (!force && this.pending.size === 0 && !this.isStale()) return;
    if (!force && this.now() - this.lastAttemptAt < MIN_FETCH_INTERVAL_MS) return;
    this.lastAttemptAt = this.now();
    this.inFlight = this.doResolve(force).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** GET a docs page as text; null on any failure (logged). Never throws. */
  private async fetchDoc(url: string, label: string): Promise<string | null> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        this.log(`price-resolver: HTTP ${res.status} from ${label} docs`);
        return null;
      }
      return await res.text();
    } catch (e) {
      this.log(`price-resolver: ${label} fetch failed (${(e as Error).message})`);
      return null;
    }
  }

  /**
   * The two pages are fetched and applied independently: rates come from the pricing page,
   * minimum cacheable prefixes from the prompt-caching page. One page failing or changing
   * shape must not discard what the other returned.
   */
  private async doResolve(force = false): Promise<void> {
    const at = this.now();
    const [pricingMd, cachingMd] = await Promise.all([
      this.fetchDoc(PRICING_DOC_URL, "pricing"),
      this.fetchDoc(CACHING_DOC_URL, "prompt-caching"),
    ]);

    if (pricingMd === null && cachingMd === null) {
      this.log("price-resolver: both docs unreachable — models stay unpriced");
      return;
    }

    if (pricingMd !== null) this.applyPricing(pricingMd, force, at);
    if (cachingMd !== null) this.applyMinimums(cachingMd);

    this.cache.lastFetchAt = at;
    savePriceCache(this.cache, this.opts.cacheFile ?? priceCacheFile());
    this.applyToCore();
  }

  /** Parse published minimum cacheable prefixes and report drift vs the built-in guesses. */
  private applyMinimums(markdown: string): void {
    const { minimums, rejected } = parseCacheMinimums(markdown);
    if (Object.keys(minimums).length === 0) {
      this.log(
        `price-resolver: parsed 0 cache minimums (${rejected} rejected) — ` +
          "prompt-caching doc format may have changed; keeping previous values",
      );
      return;
    }

    const drift: Array<{ modelId: string; builtIn: number; published: number }> = [];
    for (const [id, published] of Object.entries(minimums)) {
      const builtIn = builtInCacheMinimum(id);
      if (builtIn !== published) drift.push({ modelId: id, builtIn, published });
    }

    this.cache.cacheMinimums = minimums;
    this.cache.minimumDrift = drift;
    if (drift.length) {
      this.log(
        "price-resolver: published cache minimum differs from the built-in table for " +
          drift.map((d) => `${d.modelId} ${d.builtIn}->${d.published}`).join(", ") +
          " (published value wins)",
      );
    }
  }

  private applyPricing(markdown: string, force: boolean, at: number): void {
    const parse = parsePricingDoc(markdown);
    if (parse.rows.length === 0) {
      // Page structure changed enough that nothing validated. Keep prior cache.
      this.log(
        `price-resolver: parsed 0 usable rows (${parse.rejected} rejected, ` +
          `${parse.multiplierMismatch.length} multiplier mismatches) — pricing doc format may have changed`,
      );
      this.cache.multiplierMismatch = parse.multiplierMismatch;
      return; // caller still saves, so a successful minimums parse isn't lost
    }

    // Lazily: only what we were asked for, plus a refresh of whatever is already cached
    // (a cached entry is a flattened snapshot and goes stale when a published rate changes).
    // On an explicit refresh: mirror the whole table, so `ccc prices --refresh` is useful
    // on a cold cache and a model released tomorrow costs correctly the first time it
    // appears, with no fetch latency at all.
    const wanted = force
      ? new Set(parse.rows.map((r) => r.modelId))
      : new Set<string>([...this.pending, ...Object.keys(this.cache.entries)]);
    const found = specsFor(parse, wanted);
    const byId = new Map(parse.rows.map((r) => [r.modelId, r]));

    const added: string[] = [];
    const changed: string[] = [];
    for (const [id, spec] of Object.entries(found)) {
      const prev = this.cache.entries[id];
      if (!prev) added.push(id);
      else if (prev.inputPerM !== spec.inputPerM || prev.outputPerM !== spec.outputPerM) {
        changed.push(`${id} ${prev.inputPerM}/${prev.outputPerM} -> ${spec.inputPerM}/${spec.outputPerM}`);
      } else if (fmtFast(prev.fast) !== fmtFast(spec.fast)) {
        changed.push(`${id} fast ${fmtFast(prev.fast)} -> ${fmtFast(spec.fast)}`);
      }
      this.cache.entries[id] = {
        ...spec,
        displayName: byId.get(id)?.displayName ?? id,
        resolvedAt: at,
        source: PRICING_DOC_URL,
      };
    }

    this.cache.unresolved = [...this.pending].filter((id) => !(id in found)).sort();
    this.cache.multiplierMismatch = parse.multiplierMismatch;
    for (const id of Object.keys(found)) this.pending.delete(id);

    if (added.length) this.log(`price-resolver: resolved rates for ${added.join(", ")}`);
    if (changed.length) this.log(`price-resolver: published rate changed — ${changed.join("; ")}`);
    if (this.cache.unresolved.length) {
      this.log(`price-resolver: not listed in the published table: ${this.cache.unresolved.join(", ")}`);
    }
    if (parse.multiplierMismatch.length) {
      this.log(
        `price-resolver: cache-column mismatch for ${parse.multiplierMismatch.join(", ")} — ` +
          `ccc's cache multipliers (1.25x/2x/0.1x, or a model's cacheReadMult) may be stale`,
      );
    }
  }
}
