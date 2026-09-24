import path from "node:path";
import { appPaths, turnCost, type Usage } from "@ccc/core";
import { loadConfig } from "@ccc/daemon/config";
import { Auditor, type AuditReport } from "@ccc/daemon/audit";
import { applyCachedPrices } from "@ccc/daemon/price-resolver";
import { Store, type StoredTurn } from "@ccc/daemon/store";

/**
 * `ccc audit` — how well ccc's own pricing math matches Anthropic's meter.
 *
 * Reads the database directly rather than the daemon's HTTP API, so a report is available
 * even when the daemon is down (WAL mode makes a concurrent reader safe). `--backfill` and
 * `--reprice` are the subcommands that write, and each takes the write lock for the whole
 * rewrite so it can't interleave with a running daemon. The daemon is what BUILDS the windows, though:
 * with it stopped, no new ones accumulate.
 */
export async function audit(args: string[]): Promise<number> {
  const cfg = loadConfig();
  const daysIdx = args.indexOf("--days");
  const days = daysIdx >= 0 ? Math.max(1, Number(args[daysIdx + 1]) || 14) : 14;
  const store = new Store(path.join(appPaths().state, "ccc.db"));
  try {
    const auditor = new Auditor({ store, quietMs: Math.max(5, cfg.audit.quietMinutes) * 60_000 });
    const since = Date.now() - days * 86_400_000;

    if (args.includes("--backfill")) {
      // Rebuild the period from meter samples already on disk instead of waiting for
      // windows to accumulate live.
      const { windows, instants, skippedInGaps } = auditor.backfill(since);
      console.log(`rebuilt ${windows} window(s) from ${instants} quiet instant(s) over the last ${days}d` +
        (skippedInGaps ? `; ${skippedInGaps} instant(s) dropped for falling inside a poll gap` : ""));
      console.log("");
      printReport(auditor.report(since), days, cfg.audit.enabled);
      return 0;
    }

    if (args.includes("--reprice")) return reprice(store, auditor, args.includes("--dry-run"));

    if (args.includes("--accept")) {
      const accepted = auditor.acceptBaselines(since);
      if (!accepted.length) {
        console.log("nothing to accept: no model has enough windows yet (need 8+). Try again after more work.");
        return 1;
      }
      console.log("accepted as the baseline drift is measured against:");
      for (const a of accepted) console.log(`  ${a.model.padEnd(26)} ${a.ratio.toFixed(3)}x  (${a.n} windows)`);
      return 0;
    }

    const report = auditor.report(since);
    if (args.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
    printReport(report, days, cfg.audit.enabled);
    // Exit 1 on anything worth acting on, so a cron/CI caller can notice.
    return report.findings.some((f) => f.severity === "warn") ? 1 : 0;
  } finally {
    store.close();
  }
}

/**
 * Re-cost every stored turn at current rates. Run after a pricing.ts change: cost_usd is
 * fixed at ingest, so session totals, the local daily figure and audit windows otherwise
 * keep the old rate indefinitely.
 */
function reprice(store: Store, auditor: Auditor, dryRun: boolean): number {
  // Price as the daemon does, resolved rates included, or a model priced only by the
  // resolver would read as unpriceable here and keep a stale cost.
  applyCachedPrices();
  const r = store.repriceTurns(costOfStoredTurn, { dryRun });
  const usd = (n: number) => `$${n.toFixed(2)}`;
  console.log(`${dryRun ? "would re-cost" : "re-costed"} ${r.changed} of ${r.turns} stored turn(s)`);
  console.log("");
  console.log("model                        turns  changed      before       after");
  for (const [model, m] of Object.entries(r.byModel).sort((a, b) => b[1].afterUsd - a[1].afterUsd)) {
    console.log(
      `${model.padEnd(26)} ${String(m.turns).padStart(7)}  ${String(m.changed).padStart(7)}  ` +
        `${usd(m.beforeUsd).padStart(10)}  ${usd(m.afterUsd).padStart(10)}`,
    );
  }
  if (r.unpriced) console.log(`\n${r.unpriced} turn(s) could not be priced and kept their stored cost.`);
  if (dryRun || r.changed === 0) return 0;
  console.log(`\nrefreshed the local side of ${auditor.recostWindows()} audit window(s).`);
  console.log("Restart the daemon (ccc daemon restart) so live session totals pick up the new costs.");
  return 0;
}

/** Rebuild a turn's usage block from its stored columns and price it; null when it can't be. */
export function costOfStoredTurn(t: StoredTurn): number | null {
  if (!t.model) return null;
  // Ingest stores only the per-TTL write columns. A transcript without that breakdown left
  // both at 0 while prefix_tok kept the write total, and re-costing would drop the writes.
  if (t.prefixTok > t.inputTok + t.cacheReadTok + t.cacheW5Tok + t.cacheW1hTok) return null;
  const usage: Usage = {
    input_tokens: t.inputTok,
    output_tokens: t.outputTok,
    cache_read_input_tokens: t.cacheReadTok,
    cache_creation_input_tokens: t.cacheW5Tok + t.cacheW1hTok,
    cache_creation: { ephemeral_5m_input_tokens: t.cacheW5Tok, ephemeral_1h_input_tokens: t.cacheW1hTok },
    ...(t.speed ? { speed: t.speed } : {}),
    ...(t.geo ? { inference_geo: t.geo } : {}),
  };
  const cost = turnCost(usage, t.model, new Date(t.ts).toISOString());
  return cost.unknownModel ? null : cost.totalUsd;
}

function printReport(r: AuditReport, days: number, enabled: boolean): void {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  console.log(`cost audit — last ${days}d${enabled ? "" : "  (audit.enabled is FALSE: no new windows are being built)"}`);
  console.log(`window: ${new Date(r.from).toLocaleString()} -> ${new Date(r.to).toLocaleString()}`);
  console.log("");

  if (r.attributed.n === 0) {
    console.log("no reconciled windows yet.");
    console.log("");
    console.log("A window needs the account meter read at two moments that each follow a quiet");
    console.log("stretch with no local turns. Continuous work, or a daemon that isn't polling,");
    console.log("produces none. Check `ccc daemon status` and give it a work session with breaks.");
    return;
  }

  // The headline: what a dollar of real spend looks like in ccc's arithmetic.
  const pct = (r.attributed.ratio - 1) * 100;
  console.log(`ccc prices ${r.attributed.ratio.toFixed(3)}x the meter  (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`);
  console.log(`  meter (authoritative): ${usd(r.attributed.meterUsd)}`);
  console.log(`  ccc  (local math)    : ${usd(r.attributed.localUsd)}`);
  console.log(`  residual             : ${usd(r.attributed.localUsd - r.attributed.meterUsd)} over ${r.attributed.n} reconciled window(s)`);
  console.log("");
  console.log(
    `gap shape: ${usd(r.shortfall.perTurnUsd)} per turn, or ` +
      `${(r.shortfall.perLocalDollar * 100).toFixed(1)}% on top of ccc's figure, over ${r.shortfall.turns} turns.`,
  );
  console.log("  Both descriptions fit the data so far, and they predict different things, so watch");
  console.log("  which one stays steady as more windows arrive. Steady dollars-per-turn means a charge");
  console.log("  per request (web search bills $10 per 1,000 searches). A steady percentage means a");
  console.log("  multiplier on spend (fast mode bills Opus 5 at 2x; US-pinned inference is 1.1x on");
  console.log("  everything). Neither appears in the transcript, so it has to be inferred here.");
  console.log(`coverage: ${r.coverage.pct}% of the period's ${usd(r.coverage.meterMovedUsd)} of meter movement fell inside a window`);
  if (r.unattributed.n) {
    console.log(`off-machine: ${usd(r.unattributed.meterUsd)} moved the meter with no local turn (${r.unattributed.n} window(s))`);
  }
  if (r.unmetered.n) {
    console.log(`unmetered  : ${usd(r.unmetered.localUsd)} of local turns with no meter movement (${r.unmetered.n} window(s))`);
  }

  if (r.byModel.length) {
    console.log("");
    console.log("by model (windows one model dominated):");
    console.log(`  ${"model".padEnd(26)} ${"ratio".padStart(7)} ${"meter".padStart(10)} ${"ccc".padStart(10)}   windows`);
    for (const m of r.byModel) {
      console.log(`  ${m.model.padEnd(26)} ${(m.ratio.toFixed(3) + "x").padStart(7)} ${usd(m.meterUsd).padStart(10)} ${usd(m.localUsd).padStart(10)}   ${m.n}`);
    }
  }

  if (r.bySession.length) {
    console.log("");
    console.log("by session (windows one session dominated):");
    for (const s of r.bySession.slice(0, 10)) {
      console.log(`  ${s.sessionId.slice(0, 8).padEnd(10)} ${(s.ratio.toFixed(3) + "x").padStart(7)} ${usd(s.meterUsd).padStart(10)} ${usd(s.localUsd).padStart(10)}   ${s.n}`);
    }
  }

  if (r.drift.length) {
    console.log("");
    console.log("drift vs accepted baselines:");
    for (const d of r.drift) {
      console.log(`  ${d.model.padEnd(26)} ${d.baseline.toFixed(3)}x -> ${d.current.toFixed(3)}x  (${d.changePct >= 0 ? "+" : ""}${d.changePct}%)`);
    }
  } else {
    console.log("");
    console.log("no accepted baselines yet — run `ccc audit --accept` once the ratios look right,");
    console.log("and drift from them becomes a warning.");
  }

  if (r.findings.length) {
    console.log("");
    for (const f of r.findings) console.log(`${f.severity === "warn" ? "⚠" : "·"} ${f.message}`);
  }
}
