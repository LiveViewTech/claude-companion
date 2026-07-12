import { execSync } from "node:child_process";

/**
 * rtk's OWN measured savings, read from `rtk gain -f json`.
 *
 * Why this exists: the rtk PreToolUse hook rewrites a Bash command
 * (`git status` -> `rtk git status`) at EXECUTION time, but Claude Code logs the
 * ORIGINAL, pre-rewrite command to the transcript. ccc parses transcripts, so it
 * never sees the `rtk`-prefixed form — the transcript-derived rtkVerdict A/B can
 * therefore never observe the hook working (every class shows 0 rtk samples). rtk
 * itself is the process doing the rewrite, so its own gain DB is the ground truth.
 * We surface that number so the dashboard can show rtk IS running, independent of
 * the (structurally blind) transcript A/B table.
 */
export interface RtkGain {
  /** false when rtk isn't installed / on PATH, or `rtk gain` failed. */
  available: boolean;
  totalCommands: number;
  tokensSaved: number;
  avgSavingsPct: number;
  inputTokens: number;
  outputTokens: number;
  /** Human-readable note when unavailable. */
  reason?: string;
}

const UNAVAILABLE = (reason: string): RtkGain => ({
  available: false,
  totalCommands: 0,
  tokensSaved: 0,
  avgSavingsPct: 0,
  inputTokens: 0,
  outputTokens: 0,
  reason,
});

let cache: { at: number; value: RtkGain } | null = null;
const TTL_MS = 30_000;

/** Cached (30s) so the /api/rtk handler doesn't spawn a process on every poll. */
export function rtkGain(now = Date.now()): RtkGain {
  if (cache && now - cache.at < TTL_MS) return cache.value;
  const value = probe();
  cache = { at: now, value };
  return value;
}

function probe(): RtkGain {
  let out: string;
  try {
    // Shell form so PATH/PATHEXT resolution finds rtk / rtk.exe cross-platform.
    // Args are static and trusted — no interpolation, no injection surface.
    out = execSync("rtk gain -f json", { timeout: 4000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e);
    if (/ENOENT|not recognized|not found/i.test(msg)) return UNAVAILABLE("rtk not detected on PATH");
    return UNAVAILABLE("rtk gain failed");
  }
  try {
    const s = (JSON.parse(out).summary ?? {}) as Record<string, unknown>;
    return {
      available: true,
      totalCommands: num(s["total_commands"]),
      tokensSaved: num(s["total_saved"]),
      avgSavingsPct: num(s["avg_savings_pct"]),
      inputTokens: num(s["total_input"]),
      outputTokens: num(s["total_output"]),
    };
  } catch {
    return UNAVAILABLE("rtk gain returned unparseable JSON");
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
