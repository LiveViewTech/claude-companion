import type { Store } from "./store.ts";

/**
 * Per-tool / per-command token attribution.
 *
 * Exact-token method: for an assistant turn that issued exactly ONE tool call,
 * the tokens that tool's result added to context ≈
 *   next_turn(input + cache_read + cache_creation)   [= next prefix]
 * − this_turn(prefix) − this_turn(output)
 * (the next request re-reads everything plus the new output and tool result).
 * Multi-tool turns fall back to byte-proportional allocation, flagged as such.
 */

export interface ClassStats {
  commandClass: string;
  n: number;
  medianChars: number;
  p90Chars: number;
  medianTokExact: number | null;
  nExact: number;
}

/** Fill result_tok_exact for single-tool turns that don't have it yet. Idempotent. */
export function computeExactAttribution(store: Store): number {
  const rows = store.db
    .prepare(
      `SELECT tc.tool_use_id AS id, tc.turn_uuid AS turn_uuid, t.session_id AS sid, t.ts AS ts,
              t.prefix_tok AS prefix, t.output_tok AS out
       FROM tool_calls tc
       JOIN turns t ON t.uuid = tc.turn_uuid
       WHERE tc.result_tok_exact IS NULL AND tc.result_chars IS NOT NULL
         AND (SELECT COUNT(*) FROM tool_calls x WHERE x.turn_uuid = tc.turn_uuid) = 1`,
    )
    .all() as Array<{ id: string; turn_uuid: string; sid: string; ts: number; prefix: number; out: number }>;

  const nextTurn = store.db.prepare(
    `SELECT prefix_tok AS prefix FROM turns
     WHERE session_id = ? AND ts > ? AND is_sidechain = 0
     ORDER BY ts ASC LIMIT 1`,
  );

  let updated = 0;
  const set = store.db.prepare(`UPDATE tool_calls SET result_tok_exact = ?, attribution = 'exact' WHERE tool_use_id = ?`);
  for (const r of rows) {
    const nxt = nextTurn.get(r.sid, r.ts) as { prefix: number } | undefined;
    if (!nxt) continue; // no following turn yet
    const exact = nxt.prefix - r.prefix - r.out;
    if (exact >= 0 && exact < 2_000_000) {
      set.run(exact, r.id);
      updated++;
    }
  }
  return updated;
}

export function classStats(store: Store): ClassStats[] {
  const rows = store.db
    .prepare(
      `SELECT command_class AS cls, result_chars AS chars, result_tok_exact AS tok
       FROM tool_calls
       WHERE tool_name = 'Bash' AND command_class IS NOT NULL AND result_chars IS NOT NULL`,
    )
    .all() as Array<{ cls: string; chars: number; tok: number | null }>;

  const groups = new Map<string, { chars: number[]; toks: number[] }>();
  for (const r of rows) {
    const g = groups.get(r.cls) ?? { chars: [], toks: [] };
    g.chars.push(r.chars);
    if (r.tok != null) g.toks.push(r.tok);
    groups.set(r.cls, g);
  }

  const out: ClassStats[] = [];
  for (const [cls, g] of groups) {
    g.chars.sort((a, b) => a - b);
    g.toks.sort((a, b) => a - b);
    out.push({
      commandClass: cls,
      n: g.chars.length,
      medianChars: quantile(g.chars, 0.5),
      p90Chars: quantile(g.chars, 0.9),
      medianTokExact: g.toks.length > 0 ? quantile(g.toks, 0.5) : null,
      nExact: g.toks.length,
    });
  }
  return out.sort((a, b) => b.n - a.n);
}

/** Tokens by tool name (context burn leaderboard) — chars/4 estimate where exact is missing. */
export function toolLeaderboard(store: Store): Array<{ tool: string; calls: number; chars: number; tokEst: number; tokExact: number }> {
  const rows = store.db
    .prepare(
      `SELECT tool_name AS tool, COUNT(*) AS calls,
              COALESCE(SUM(result_chars), 0) AS chars,
              COALESCE(SUM(result_tok_exact), 0) AS tokExact,
              COALESCE(SUM(CASE WHEN result_tok_exact IS NULL THEN result_chars/4 ELSE result_tok_exact END), 0) AS tokEst
       FROM tool_calls
       GROUP BY tool_name ORDER BY tokEst DESC`,
    )
    .all() as Array<{ tool: string; calls: number; chars: number; tokEst: number; tokExact: number }>;
  return rows;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[idx]!;
}
