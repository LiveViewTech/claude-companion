import fs from "node:fs";
import path from "node:path";
import { appPaths, claudeProjectsDir, parseLine, ttlTierOf, turnCost } from "@ccc/core";
import { loadConfig } from "@ccc/daemon/config";
import { applyCachedPrices } from "@ccc/daemon/price-resolver";

/**
 * Schema-drift canary + health check:
 *  - parses the newest real transcript and reports entry types, parse errors,
 *    usage-field availability (incl. ephemeral TTL breakdown), unknown models;
 *  - reports daemon health and state directory.
 */
export async function doctor(): Promise<number> {
  const cfg = loadConfig();
  // Must precede the transcript scan below: without the resolved rates registered, a
  // model the cache can price would be reported as "missing from pricing table".
  const priceCache = applyCachedPrices();
  const projects = claudeProjectsDir();
  console.log(`transcripts: ${projects}`);

  const newest = findNewestTranscript(projects);
  if (!newest) {
    console.log("no transcripts found — is Claude Code installed?");
    return 1;
  }
  console.log(`newest transcript: ${newest}`);

  const counts: Record<string, number> = {};
  let parseErrors = 0;
  let assistantWithUsage = 0;
  let withEphemeral = 0;
  let unknownModels = new Set<string>();
  const unpricedFast = new Set<string>();
  const unknownGeos = new Set<string>();
  let fastTurns = 0;
  let usGeoTurns = 0;
  let tier5m = 0;
  let tier1h = 0;
  let ccVersion: string | undefined;

  const lines = fs.readFileSync(newest, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    const { entry, error } = parseLine(line);
    if (error) {
      parseErrors++;
      continue;
    }
    if (!entry) continue;
    const kind = entry.kind === "other" ? `other:${entry.type}` : entry.kind;
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (entry.kind === "assistant") {
      ccVersion = entry.version ?? ccVersion;
      if (entry.usage) {
        assistantWithUsage++;
        if (entry.usage.cache_creation) withEphemeral++;
        const tier = ttlTierOf(entry.usage);
        if (tier === "5m") tier5m++;
        if (tier === "1h") tier1h++;
        if (entry.usage.speed === "fast") fastTurns++;
        if (entry.usage.inference_geo === "us") usGeoTurns++;
        if (entry.model) {
          const cost = turnCost(entry.usage, entry.model, entry.timestamp);
          if (cost.unknownModel) unknownModels.add(entry.model);
          if (cost.unpricedFastMode) unpricedFast.add(entry.model);
          if (cost.unknownGeo && entry.usage.inference_geo) unknownGeos.add(entry.usage.inference_geo);
        }
      }
    }
  }

  console.log(`claude code version: ${ccVersion ?? "?"}`);
  console.log(`lines: ${lines.length}, parse errors: ${parseErrors}`);
  console.log(`entry kinds: ${JSON.stringify(counts)}`);
  console.log(`assistant turns with usage: ${assistantWithUsage} (ephemeral TTL breakdown present: ${withEphemeral})`);
  console.log(`ttl writes observed — 5m: ${tier5m}, 1h: ${tier1h}`);
  if (fastTurns > 0 || usGeoTurns > 0) {
    console.log(`premium turns — fast mode: ${fastTurns}, US-only inference: ${usGeoTurns} (billed at 2x / 1.1x)`);
  }
  if (unpricedFast.size > 0) {
    // Under-billing, and silent without this: the turn costs 2x and ccc quotes 1x.
    console.log(
      `⚠ fast-mode turns on models with no fast rates: ${[...unpricedFast].join(", ")} — ` +
        "billed at standard rates here, so these sessions read low (run: ccc prices --refresh)",
    );
  }
  if (unknownGeos.size > 0) {
    console.log(
      `⚠ unrecognized inference_geo: ${[...unknownGeos].join(", ")} — costed at standard rates; ` +
        "only \"global\" and \"us\" (1.1x) have published multipliers",
    );
  }
  if (unknownModels.size > 0) {
    console.log(`⚠ models missing from pricing table: ${[...unknownModels].join(", ")} — costs for these read $0`);
    console.log(
      cfg.pricing.autoResolve
        ? "  auto-resolve is on: the daemon looks these up in the published table (see: ccc prices)"
        : "  auto-resolve is off (pricing.autoResolve) — enable it, or run: ccc prices --refresh",
    );
  }

  let ok = true;

  // Provenance for rates that came from the published table rather than the build.
  const resolvedCount = Object.keys(priceCache.entries).length;
  const minCount = Object.keys(priceCache.cacheMinimums).length;
  if (resolvedCount > 0 || minCount > 0) {
    const age = priceCache.lastFetchAt
      ? `${Math.max(0, Math.floor((Date.now() - priceCache.lastFetchAt) / 86_400_000))}d old`
      : "age unknown";
    console.log(
      `pricing: ${resolvedCount} rate(s) + ${minCount} cache minimum(s) auto-resolved from the docs (${age})`,
    );
  }
  if (priceCache.minimumDrift.length > 0) {
    // Not a failure — the published value is in use. Flagged so the built-in table can catch up.
    console.log(
      `note: built-in cache minimums are stale for ${priceCache.minimumDrift
        .map((d) => `${d.modelId} (${d.builtIn}→${d.published})`)
        .join(", ")} — published values in use`,
    );
  }
  if (priceCache.multiplierMismatch.length > 0) {
    console.log(
      `⚠ published cache columns disagree with ccc's multipliers for ${priceCache.multiplierMismatch.join(", ")} — ` +
        "the 1.25x/2x/0.1x constants (or that model's cacheReadMult) may be stale",
    );
    ok = false;
  }

  if (parseErrors > lines.length * 0.01) {
    console.log("⚠ SCHEMA DRIFT? >1% of lines failed to parse — adapter needs a look");
    ok = false;
  }
  if (assistantWithUsage > 0 && withEphemeral === 0) {
    console.log("⚠ SCHEMA DRIFT: usage.cache_creation breakdown missing — TTL tier detection degraded to config guessing");
    ok = false;
  }

  // Daemon health
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/healthz`, { signal: AbortSignal.timeout(1500) });
    console.log(`daemon: ${res.ok ? `online (http://127.0.0.1:${cfg.port})` : `unhealthy (${res.status})`}`);
  } catch {
    console.log("daemon: offline (run: ccc daemon start)");
  }
  console.log(`state dir: ${appPaths().state}`);
  return ok ? 0 : 1;
}

function findNewestTranscript(projectsDir: string): string | null {
  let newest: { file: string; mtime: number } | null = null;
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(projectsDir).map((d) => path.join(projectsDir, d));
  } catch {
    return null;
  }
  for (const dir of dirs) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const file = path.join(dir, f);
      const m = fs.statSync(file).mtimeMs;
      if (!newest || m > newest.mtime) newest = { file, mtime: m };
    }
  }
  return newest?.file ?? null;
}
