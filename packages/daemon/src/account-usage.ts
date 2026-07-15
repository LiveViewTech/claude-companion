import fs from "node:fs";
import { claudeCredentialsPath } from "@ccc/core";

/**
 * Account-usage sync: polls Anthropic's OAuth usage endpoint — the same source
 * the claude.ai Settings -> Usage page reads — so the dashboard's monthly number
 * matches the website exactly (all devices and surfaces, correct billing cycle,
 * no local pricing math). Mechanism mirrors jens-duttke/usage-monitor-for-claude.
 *
 * The Claude Code OAuth token is read fresh from .credentials.json on every poll
 * (the file is rewritten on token rotation), used only in the Authorization
 * header toward api.anthropic.com, and never stored or logged.
 *
 * The endpoint is undocumented and may change without notice — every field is
 * parsed defensively and failures degrade to the local transcript estimate.
 */

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** UA the endpoint expects; matches what Claude Code itself sends. */
const FALLBACK_USER_AGENT = "claude-code/2.1.204";

export interface AccountWindow {
  /** Percent 0-100 as reported by the API. */
  utilization: number;
  /** ISO timestamp the window resets at, if reported. */
  resetsAt: string | null;
}

export interface AccountWindowInfo extends AccountWindow {
  /** Window name: "five_hour", "seven_day", or a limits-array group/model combo. */
  name: string;
}

export interface AccountUsage {
  /** Dollars spent this billing cycle — the number the claude.ai usage page shows. */
  usedUsd: number;
  /** Monthly cap in dollars, null when the account has none. */
  monthlyLimitUsd: number | null;
  fiveHour: AccountWindow | null;
  sevenDay: AccountWindow | null;
  /**
   * Every usage window the endpoint reported, name-agnostic — window types are
   * undocumented and drift (e.g. the "seven_day" window empirically resets every
   * ~72h). resets_at changes per window are logged to the events table so the
   * real cadence is observable.
   */
  windows: AccountWindowInfo[];
  fetchedAt: number;
}

export interface AccountUsageStatus {
  usage: AccountUsage | null;
  /** null when healthy; short reason otherwise ("no-token", "auth-expired", "rate-limited", "network", "http-<code>"). */
  error: string | null;
}

export interface AccountUsagePollerOptions {
  pollMs: number;
  /** Injection points for tests. */
  fetchFn?: typeof fetch;
  credentialsFile?: string;
  userAgent?: string;
  onUpdate?: (status: AccountUsageStatus) => void;
}

export class AccountUsagePoller {
  /** Latest result; usage survives transient errors so the dashboard keeps the last good number. */
  readonly status: AccountUsageStatus = { usage: null, error: null };
  /** Last raw endpoint response (no secrets), for /api/account drift debugging. */
  lastResponse: unknown = null;

  private timer: NodeJS.Timeout | null = null;
  /** Earliest next request (pushed out by Retry-After on 429). */
  private nextAllowedAt = 0;
  private opts: Required<Pick<AccountUsagePollerOptions, "pollMs">> & AccountUsagePollerOptions;

  constructor(opts: AccountUsagePollerOptions) {
    this.opts = opts;
  }

  start(): void {
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.opts.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<AccountUsageStatus> {
    if (Date.now() < this.nextAllowedAt) return this.status;
    const token = this.readToken();
    if (!token) return this.update(null, "no-token");

    const doFetch = this.opts.fetchFn ?? fetch;
    let res: Response;
    try {
      res = await doFetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": this.opts.userAgent ?? FALLBACK_USER_AGENT,
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return this.update(null, "network");
    }

    if (res.status === 401) return this.update(null, "auth-expired");
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      this.nextAllowedAt = Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.opts.pollMs);
      return this.update(null, "rate-limited");
    }
    if (!res.ok) return this.update(null, `http-${res.status}`);

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return this.update(null, "bad-json");
    }
    this.lastResponse = body;
    const usage = parseUsageResponse(body);
    if (!usage) return this.update(null, "bad-shape");
    return this.update(usage, null);
  }

  private readToken(): string | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.opts.credentialsFile ?? claudeCredentialsPath(), "utf8")) as Record<string, unknown>;
      const oauth = raw["claudeAiOauth"];
      const token = typeof oauth === "object" && oauth !== null ? (oauth as Record<string, unknown>)["accessToken"] : null;
      return typeof token === "string" && token ? token : null;
    } catch {
      // Also covers a read racing the file's rewrite on token rotation: treat as
      // "no token right now" and let the next poll retry.
      return null;
    }
  }

  private update(usage: AccountUsage | null, error: string | null): AccountUsageStatus {
    if (usage) this.status.usage = usage;
    this.status.error = error;
    this.opts.onUpdate?.(this.status);
    return this.status;
  }
}

/**
 * Tolerant parse of the /api/oauth/usage response; null when extra_usage is unusable.
 * "Credits" are cents: verified live against an account whose $500 website cap came
 * back as monthly_limit 50000 (and used_credits tracked the website dollars x100).
 */
export function parseUsageResponse(body: unknown): AccountUsage | null {
  if (typeof body !== "object" || body === null) return null;
  const o = body as Record<string, unknown>;
  const extra = o["extra_usage"];
  if (typeof extra !== "object" || extra === null) return null;
  const e = extra as Record<string, unknown>;
  const usedCredits = num(e["used_credits"]);
  if (usedCredits == null) return null;
  const limitCredits = num(e["monthly_limit"]);
  const windows = collectWindows(o);
  const byName = (re: RegExp) => windows.find((w) => re.test(w.name)) ?? null;
  return {
    usedUsd: usedCredits / 100,
    monthlyLimitUsd: limitCredits != null ? limitCredits / 100 : null,
    fiveHour: byName(/^five_hour$|^5h$/i),
    sevenDay: byName(/^seven_day$|^7d$/i),
    windows,
    fetchedAt: Date.now(),
  };
}

/**
 * Every usage window in the response, name-agnostic: top-level quota fields
 * ({utilization, resets_at} objects like five_hour/seven_day/seven_day_sonnet),
 * plus `limits`-array entries — newer responses move windows there, keyed by
 * `group`, with per-model entries carrying scope.model.display_name.
 */
function collectWindows(o: Record<string, unknown>): AccountWindowInfo[] {
  const out: AccountWindowInfo[] = [];
  const add = (name: string, w: AccountWindow | null) => {
    if (name && w && !out.some((x) => x.name === name)) out.push({ name, ...w });
  };
  for (const [key, value] of Object.entries(o)) {
    if (key === "extra_usage" || key === "limits") continue;
    add(key, parseWindow(value));
  }
  const limits = o["limits"];
  if (Array.isArray(limits)) {
    for (const item of limits) {
      if (typeof item !== "object" || item === null) continue;
      const e = item as Record<string, unknown>;
      const pct = num(e["percent"]) ?? num(e["utilization"]);
      if (pct == null) continue;
      const scope = e["scope"] as Record<string, unknown> | undefined;
      const model = scope && typeof scope === "object" ? (scope["model"] as Record<string, unknown> | undefined) : undefined;
      const display = model && typeof model["display_name"] === "string" ? (model["display_name"] as string) : null;
      const group = typeof e["group"] === "string" ? e["group"] : "";
      const name = display ? `${group || "limit"}_${display.toLowerCase().replace(/[^a-z0-9]+/g, "_")}` : group;
      add(name, { utilization: pct, resetsAt: typeof e["resets_at"] === "string" ? e["resets_at"] : null });
    }
  }
  return out;
}

function parseWindow(v: unknown): AccountWindow | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const utilization = num(o["utilization"]);
  if (utilization == null) return null;
  return { utilization, resetsAt: typeof o["resets_at"] === "string" ? o["resets_at"] : null };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
