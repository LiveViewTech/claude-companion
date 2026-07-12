import fs from "node:fs";
import path from "node:path";
import { appPaths, claudeProjectsDir, parseLine, ttlTierOf, turnCost } from "@ccc/core";
import { loadConfig } from "@ccc/daemon/config";

/**
 * Schema-drift canary + health check:
 *  - parses the newest real transcript and reports entry types, parse errors,
 *    usage-field availability (incl. ephemeral TTL breakdown), unknown models;
 *  - reports daemon health and state directory.
 */
export async function doctor(): Promise<number> {
  const cfg = loadConfig();
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
        if (entry.model && turnCost(entry.usage, entry.model, entry.timestamp).unknownModel) {
          unknownModels.add(entry.model);
        }
      }
    }
  }

  console.log(`claude code version: ${ccVersion ?? "?"}`);
  console.log(`lines: ${lines.length}, parse errors: ${parseErrors}`);
  console.log(`entry kinds: ${JSON.stringify(counts)}`);
  console.log(`assistant turns with usage: ${assistantWithUsage} (ephemeral TTL breakdown present: ${withEphemeral})`);
  console.log(`ttl writes observed — 5m: ${tier5m}, 1h: ${tier1h}`);
  if (unknownModels.size > 0) {
    console.log(`⚠ models missing from pricing table: ${[...unknownModels].join(", ")} — costs for these read $0`);
  }

  let ok = true;
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
