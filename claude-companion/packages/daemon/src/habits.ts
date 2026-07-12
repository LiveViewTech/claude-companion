import type { Store } from "./store.ts";

export interface ProjectHabits {
  projectSlug: string;
  gaps: number;
  pctOver5m: number;
  pctUnder1h: number;
  expired: number;
  realizedRewriteUsd: number;
  recommendation: string;
}

const MIN_GAPS = 30;

/**
 * Idle-gap habit analytics: per-project distributions that drive the TTL
 * recommendation ("launch API sessions with 1h TTL") and inform keep-warm.
 * Pure break-even math applies until MIN_GAPS observations exist.
 */
export function projectHabits(store: Store): ProjectHabits[] {
  const rows = store.db
    .prepare(
      `SELECT project_slug AS slug,
              COUNT(*) AS gaps,
              AVG(CASE WHEN gap_seconds > 300 THEN 1.0 ELSE 0 END) AS over5m,
              AVG(CASE WHEN gap_seconds < 3600 THEN 1.0 ELSE 0 END) AS under1h,
              SUM(expired) AS expired,
              COALESCE(SUM(realized_rewrite_cost), 0) AS realized
       FROM gaps
       WHERE gap_seconds > 60
       GROUP BY project_slug
       ORDER BY gaps DESC`,
    )
    .all() as Array<{ slug: string; gaps: number; over5m: number; under1h: number; expired: number; realized: number }>;

  return rows.map((r) => {
    const pctOver5m = Math.round(r.over5m * 100);
    const pctUnder1h = Math.round(r.under1h * 100);
    let rec: string;
    if (r.gaps < MIN_GAPS) {
      rec = `collecting data (${r.gaps}/${MIN_GAPS} gaps) — using pure break-even math meanwhile`;
    } else if (pctOver5m >= 50 && pctUnder1h >= 80) {
      rec = `${pctOver5m}% of idle gaps outlive a 5m cache but ${pctUnder1h}% fit inside 1h — on API billing, launch with \`ccc launch --ttl 1h\``;
    } else if (pctOver5m < 25) {
      rec = `only ${pctOver5m}% of gaps exceed 5m — the default 5m TTL is fine here`;
    } else {
      rec = `${pctOver5m}% of gaps exceed 5m and ${100 - pctUnder1h}% exceed even 1h — consider keep-warm for short breaks and accepting re-writes for long ones`;
    }
    return {
      projectSlug: r.slug,
      gaps: r.gaps,
      pctOver5m,
      pctUnder1h,
      expired: r.expired,
      realizedRewriteUsd: Math.round(r.realized * 100) / 100,
      recommendation: rec,
    };
  });
}

/** Weekly cold-rewrite bill: the headline "cache expiry cost you $X" number. */
export function coldRewriteSummary(store: Store, sinceMs: number): { count: number; totalUsd: number } {
  const row = store.db
    .prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(realized_rewrite_cost), 0) AS s FROM gaps WHERE realized_rewrite_cost IS NOT NULL AND gap_start_ts >= ?`)
    .get(sinceMs) as { c: number; s: number };
  return { count: row.c, totalUsd: Math.round(row.s * 100) / 100 };
}
