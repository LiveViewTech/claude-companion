import {
  builtInCacheMinimum,
  builtInPriceIds,
  lookupPrice,
  minCacheablePrefix,
  resolvedPriceIds,
} from "@ccc/core";
import { loadConfig } from "@ccc/daemon/config";
import { applyCachedPrices, PriceResolver, priceCacheFile } from "@ccc/daemon/price-resolver";

/**
 * `ccc prices` — show which model rates are built in versus resolved at runtime from
 * Anthropic's published table, with provenance. The distinction matters: a resolved rate
 * came from parsing a docs page, so anyone about to trust a dollar figure should be able
 * to see where it came from and how old it is.
 */
export async function prices(args: string[]): Promise<number> {
  const refresh = args.includes("--refresh");
  const cfg = loadConfig();

  if (refresh) {
    const resolver = new PriceResolver({
      enabled: true, // --refresh is an explicit request; honour it even if autoResolve is off
      refreshDays: cfg.pricing.refreshDays,
      log: (msg) => console.log(msg),
    });
    console.log("fetching published pricing table...");
    await resolver.resolve(true);
  }

  // Register before lookup — otherwise resolved-only models silently drop off the table.
  const cache = applyCachedPrices();
  const built = new Set(builtInPriceIds());
  const ids = [...new Set([...built, ...resolvedPriceIds()])].sort();

  console.log(`auto-resolve: ${cfg.pricing.autoResolve ? `on (refresh every ${cfg.pricing.refreshDays}d)` : "off"}`);
  console.log(`cache: ${priceCacheFile()}`);
  console.log(
    `last fetch: ${cache.lastFetchAt ? new Date(cache.lastFetchAt).toISOString() : "never"}`,
  );
  console.log();
  console.log("model                     in$/M   out$/M   min-cache   source");
  for (const id of ids) {
    const p = lookupPrice(id);
    if (!p) continue;
    const src = built.has(id) ? "built-in" : `resolved ${fmtAge(cache.entries[id]?.resolvedAt)}`;
    // "*" marks a minimum taken from the published page over the built-in family guess.
    const min = minCacheablePrefix(id);
    const minMark = min !== builtInCacheMinimum(id) ? "*" : " ";
    console.log(
      `${id.padEnd(24)} ${String(p.inputPerM).padStart(6)}  ${String(p.outputPerM).padStart(7)}  ` +
        `${String(min).padStart(8)}${minMark}   ${src}`,
    );
  }

  if (cache.minimumDrift.length > 0) {
    console.log();
    console.log("* published cache minimum differs from the built-in table (published wins):");
    for (const d of cache.minimumDrift) {
      console.log(`    ${d.modelId}: built-in ${d.builtIn} -> published ${d.published}`);
    }
    console.log("  worth folding into MIN_CACHEABLE in packages/core/src/pricing.ts.");
  }

  if (cache.unresolved.length > 0) {
    console.log();
    console.log(`⚠ seen in transcripts but not found in the published table: ${cache.unresolved.join(", ")}`);
    console.log("  these cost $0. Check the model id, or add it to packages/core/src/pricing.ts.");
  }
  if (cache.multiplierMismatch.length > 0) {
    console.log();
    console.log(`⚠ published cache columns disagree with ccc's multipliers for: ${cache.multiplierMismatch.join(", ")}`);
    console.log("  ccc assumes 1.25x (5m write) / 2x (1h write) / 0.1x (read). Verify those still hold.");
  }
  return 0;
}

function fmtAge(at?: number): string {
  if (!at) return "(unknown age)";
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days <= 0) return "today";
  return `${days}d ago`;
}
