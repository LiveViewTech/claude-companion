import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { builtInPriceIds, resolvedPriceIds, type SessionState } from "@ccc/core";
import type { SessionTracker } from "./session-tracker.ts";
import type { Store } from "./store.ts";
import { classStats, computeExactAttribution, toolLeaderboard } from "./attribution.ts";
import { coldRewriteSummary, projectHabits } from "./habits.ts";
import { awayCoverageMs } from "./awake-tracker.ts";

/**
 * What the "today" meter figure is measured from. "midnight" is the real thing; the
 * other two mean the baseline predates local midnight, either because the machine was
 * asleep (expected on a laptop that spends the night in a backpack) or because polling
 * broke while the machine was up (a bug worth surfacing).
 */
export type DayBaselineKind = "midnight" | "pre-away" | "stale";

export interface DayBaseline {
  /** When the baseline reading was last confirmed. */
  at: number;
  kind: DayBaselineKind;
  /** Minutes of the pre-midnight gap the machine was demonstrably away for. */
  awayMinutes: number | null;
  /** "suspend" | "machine-off" | "daemon-down", from the longest away window. */
  awayReason: string | null;
}

/** Case/separator-insensitive path equality (Windows transcripts mix `\` and `/`). */
function normPath(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").toLowerCase();
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

/**
 * Localhost-only HTTP server: static dashboard, JSON API, SSE stream,
 * plus endpoints the hooks/statusline call (advisor + usage-limit courier land here in M3).
 */
export class Server {
  private server: http.Server;
  private sseClients = new Set<http.ServerResponse>();
  private publicDir: string;

  private tracker: SessionTracker;
  private store: Store;
  private port: number;
  /** Monthly spend cap (USD) for the dashboard "this month" tile; null = no cap. Set by index.ts. */
  monthlyBudgetUsd: number | null = null;
  /**
   * How old the account meter may get before its readings stop being usable. Set by
   * index.ts from the poll interval. Past this, "today" is withheld rather than
   * reported as the difference between two copies of the same stale number.
   */
  meterStaleMs = 20 * 60_000;
  /** Live account usage from Anthropic's OAuth endpoint; null when the poller is disabled. Set by index.ts. */
  accountUsage: (() => unknown) | null = null;
  /**
   * Runtime-resolved model rates + provenance, for /api/pricing. Lets a caller tell a
   * scraped rate from a built-in one, which matters before trusting a dollar figure.
   * Set by index.ts.
   */
  pricingStatus: (() => unknown) | null = null;
  /** Parsed status + raw endpoint response, for /api/account drift debugging. Set by index.ts. */
  accountRaw: (() => unknown) | null = null;
  /** Cost-audit report over a lookback window; null when auditing is off. Set by index.ts. */
  auditReport: ((sinceMs: number) => unknown) | null = null;
  /** Sessions whose cwd is this directory are hidden from the dashboard (the namer's own `claude -p` runs). */
  hideSessionsUnder: string | null = null;
  /** Dashboard flash config for the "it's your turn" signal; null = flashing off. Set by index.ts. */
  turnSignal: { flashColor: string; flashMs: number } | null = null;
  /** Per-session debounce for /turn so a burst of Stop/Notification hooks flashes once. */
  private lastTurnAt = new Map<string, number>();
  private static TURN_DEBOUNCE_MS = 1200;
  /**
   * How much of a pre-midnight polling gap may go unexplained by away windows before the
   * baseline is called stale rather than expected. Covers the minutes between the last
   * poll and the actual suspend, plus the heartbeat's own resolution.
   */
  private static AWAY_TOLERANCE_MS = 10 * 60_000;
  /** Feature endpoints plugged in by index.ts (advisor M3, keep-warm M5). */
  handlers: {
    advise?: (body: Record<string, unknown>) => unknown;
    guardianAck?: (sessionId: string, action: string) => boolean;
    keepwarmAuthorize?: (sessionId: string) => { ping: boolean; reason?: string };
    keepwarmSetArmed?: (sessionId: string, armed: boolean) => unknown;
    keepwarmBreakEven?: (sessionId: string) => unknown;
    /** Current daemon config (for the dashboard controls). */
    getConfig?: () => unknown;
    /** Apply a partial config update live and persist it; returns the new config. */
    setConfig?: (updates: Record<string, unknown>) => unknown;
    /** Open a terminal resuming this session (dashboard "open" button). */
    launchSession?: (sessionId: string) => Promise<unknown> | unknown;
  } = {};

  constructor(tracker: SessionTracker, store: Store, port: number) {
    this.tracker = tracker;
    this.store = store;
    this.port = port;
    const here = path.dirname(fileURLToPath(import.meta.url));
    this.publicDir = path.resolve(here, "../../dashboard/public");
    this.server = http.createServer((req, res) => this.route(req, res));

    tracker.on("state", (s) => {
      if (!this.isHidden(s)) this.broadcast("state", s);
    });
    tracker.on("coldRewrite", (e) => this.broadcast("coldRewrite", e));
    tracker.on("expiryWarning", (e) => this.broadcast("expiryWarning", e));
    tracker.on("expired", (e) => this.broadcast("expired", e));
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "127.0.0.1", () => resolve());
    });
  }

  /** Actual bound port (differs from the requested port when listening on 0). */
  get boundPort(): number {
    const a = this.server.address();
    return typeof a === "object" && a ? a.port : this.port;
  }

  close(): void {
    for (const c of this.sseClients) c.end();
    this.server.close();
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const p = url.pathname;
    try {
      if (p === "/healthz") return void this.json(res, { ok: true, pid: process.pid });
      if (p === "/api/sessions") return void this.json(res, this.sessionsPayload());
      if (p === "/api/day") return void this.json(res, this.dayPayload());
      if (p === "/api/audit") {
        if (!this.auditReport) return void this.json(res, { error: "audit disabled" }, 404);
        // Default 14d: long enough to accumulate windows, short enough to reflect current rates.
        const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 14));
        return void this.json(res, this.auditReport(Date.now() - days * 86_400_000));
      }
      if (p === "/api/tools") {
        computeExactAttribution(this.store);
        return void this.json(res, { leaderboard: toolLeaderboard(this.store), classes: classStats(this.store) });
      }
      if (p === "/api/pricing") {
        // Which rates are built in vs resolved from the published table, and when.
        return void this.json(res, {
          builtIn: builtInPriceIds(),
          resolved: resolvedPriceIds(),
          status: this.pricingStatus ? this.pricingStatus() : null,
        });
      }
      if (p === "/api/habits") {
        const weekAgo = Date.now() - 7 * 86_400_000;
        return void this.json(res, { projects: projectHabits(this.store), coldRewritesWeek: coldRewriteSummary(this.store, weekAgo) });
      }
      if (p === "/api/breakeven") {
        const sid = url.searchParams.get("session_id") ?? "";
        return void this.json(res, this.handlers.keepwarmBreakEven?.(sid) ?? null);
      }
      if (p === "/api/account") return void this.json(res, this.accountRaw?.() ?? { error: "account usage disabled" });
      if (p === "/api/windows") return void this.json(res, this.windowsPayload());
      if (p === "/api/config") return void this.json(res, this.handlers.getConfig?.() ?? {});
      if (p === "/events") return void this.sse(res);
      if (req.method === "POST" && p === "/advise") return void this.post(req, res, (b) => this.handlers.advise?.(b) ?? {});
      if (req.method === "POST" && p === "/guardian/ack")
        return void this.post(req, res, (b) => ({ ok: this.handlers.guardianAck?.(String(b["session_id"] ?? ""), String(b["action"] ?? "")) ?? false }));
      if (req.method === "POST" && p === "/keepwarm/authorize")
        return void this.post(req, res, (b) => this.handlers.keepwarmAuthorize?.(String(b["session_id"] ?? "")) ?? { ping: false, reason: "keep-warm not available" });
      if (req.method === "POST" && p === "/keepwarm/arm")
        return void this.post(req, res, (b) => this.handlers.keepwarmSetArmed?.(String(b["session_id"] ?? ""), Boolean(b["armed"])) ?? { error: "not available" });
      if (req.method === "POST" && p === "/config")
        return void this.post(req, res, (b) => this.handlers.setConfig?.(b) ?? { error: "not available" });
      if (req.method === "POST" && p === "/session/launch")
        return void this.post(req, res, (b) => this.handlers.launchSession?.(String(b["session_id"] ?? "")) ?? { ok: false, error: "not available" });
      if (req.method === "POST" && p === "/turn") return void this.post(req, res, (b) => this.handleTurn(b));
      if (p.startsWith("/api/")) return void this.json(res, { error: "not found" }, 404);
      return void this.static(p === "/" ? "/index.html" : p, res);
    } catch (e) {
      this.json(res, { error: String(e) }, 500);
    }
  }

  /** Read a JSON body (64KB cap) and answer with the handler's JSON result (promises awaited). */
  private post(req: http.IncomingMessage, res: http.ServerResponse, handler: (body: Record<string, unknown>) => unknown): void {
    let data = "";
    let overflow = false;
    req.on("data", (c: Buffer) => {
      data += c;
      if (data.length > 65536) {
        overflow = true;
        req.destroy();
      }
    });
    req.on("end", () => {
      if (overflow) return void this.json(res, { error: "body too large" }, 413);
      let body: Record<string, unknown> = {};
      try {
        body = data ? (JSON.parse(data) as Record<string, unknown>) : {};
      } catch {
        return void this.json(res, { error: "bad json" }, 400);
      }
      void (async () => {
        try {
          this.json(res, (await handler(body)) ?? {});
        } catch (e) {
          this.json(res, { error: String(e) }, 500);
        }
      })();
    });
  }

  /** Namer `claude -p` runs are real sessions on disk but noise on the dashboard. */
  private isHidden(s: SessionState): boolean {
    if (!this.hideSessionsUnder || !s.cwd) return false;
    return normPath(s.cwd) === normPath(this.hideSessionsUnder);
  }

  private sessionsPayload(): { sessions: SessionState[]; now: number } {
    const sessions = this.tracker.all
      .filter((s) => s.lastTurnAt != null && !this.isHidden(s))
      .sort((a, b) => (b.lastTurnAt ?? 0) - (a.lastTurnAt ?? 0))
      .slice(0, 50);
    return { sessions, now: Date.now() };
  }

  private dayPayload(): {
    dayCostUsd: number;
    dayMeterUsd: number | null;
    dayBaseline: DayBaseline | null;
    meterStale: { fetchedAt: number; ageMinutes: number } | null;
    from: number;
    to: number;
    monthCostUsd: number;
    monthStart: number;
    monthlyBudgetUsd: number | null;
    account: unknown;
  } {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const end = start + 86_400_000;
    // Month-to-date: first of the local month through now. dayCostUsd is just a
    // SUM(cost_usd) over a ts range, so it serves the month window too. This is the
    // local this-device estimate; `account` carries the claude.ai meter when available.
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const meter = this.dayMeter(start);
    return {
      dayCostUsd: this.store.dayCostUsd(start, end),
      dayMeterUsd: meter.usd,
      dayBaseline: meter.baseline,
      meterStale: this.meterStale(),
      from: start,
      to: end,
      monthCostUsd: this.store.dayCostUsd(monthStart, now.getTime() + 1),
      monthStart,
      monthlyBudgetUsd: this.monthlyBudgetUsd,
      account: this.accountUsage?.() ?? null,
    };
  }

  /** Latest account-meter reading and when it was taken; null when there is none. */
  private meterUsage(): { usedUsd: number; fetchedAt: number } | null {
    const status = this.accountUsage?.() as { usage?: { usedUsd?: unknown; fetchedAt?: unknown } } | null | undefined;
    const u = status?.usage;
    if (!u || typeof u.usedUsd !== "number" || !Number.isFinite(u.usedUsd)) return null;
    // An undated reading can't be aged, and any stand-in date would surface as a bogus
    // staleness banner, so it counts as no reading rather than an infinitely old one.
    if (typeof u.fetchedAt !== "number" || !Number.isFinite(u.fetchedAt)) return null;
    return { usedUsd: u.usedUsd, fetchedAt: u.fetchedAt };
  }

  /** Non-null when the meter's newest reading is older than meterStaleMs. */
  private meterStale(): { fetchedAt: number; ageMinutes: number } | null {
    const current = this.meterUsage();
    if (!current) return null;
    const age = Date.now() - current.fetchedAt;
    return age > this.meterStaleMs ? { fetchedAt: current.fetchedAt, ageMinutes: Math.round(age / 60_000) } : null;
  }

  /**
   * Account-true "today": current claude.ai meter minus its baseline reading (all
   * surfaces, matching the website's arithmetic — the local dayCostUsd estimate reads
   * ~12-16% low against it). Null when there is no reading, when the newest one is too
   * old to describe "now" (a stale meter on both ends of the subtraction yields a
   * confident $0.00, which is worse than no number), or when the meter went backwards
   * mid-day (billing-cycle rollover).
   */
  private dayMeter(dayStartMs: number): { usd: number | null; baseline: DayBaseline | null } {
    const current = this.meterUsage();
    if (!current || Date.now() - current.fetchedAt > this.meterStaleMs) return { usd: null, baseline: null };
    const baselineUsd = this.store.meterUsdAt(dayStartMs);
    if (baselineUsd == null || current.usedUsd < baselineUsd) return { usd: null, baseline: null };
    return { usd: current.usedUsd - baselineUsd, baseline: this.dayBaseline(dayStartMs) };
  }

  /**
   * Where the day's baseline reading actually comes from. No polling gap across local
   * midnight means the baseline is a true midnight figure — the sample itself may be
   * older, but a deduped meter only skips a sample when nothing moved, so the value
   * still held at midnight.
   *
   * A gap makes the baseline older than midnight, and the away windows say whether that
   * was expected. A suspended or powered-off machine explains it, and the pre-sleep
   * reading is then the best baseline there is (spend from another device during the
   * sleep lands in today's figure — the label says so). An unexplained gap means the
   * machine was up and polling broke, so the same number gets flagged instead.
   */
  private dayBaseline(dayStartMs: number): DayBaseline {
    const gap = this.store.pollGapCovering(dayStartMs);
    if (!gap) return { at: dayStartMs, kind: "midnight", awayMinutes: null, awayReason: null };
    const away = this.store.awayWindowsSince(gap.start);
    const covered = awayCoverageMs(away, gap.start, gap.end);
    const longest = away
      .filter((w) => w.end > gap.start && w.start < gap.end)
      .sort((a, b) => b.ms - a.ms)[0];
    return {
      at: gap.start,
      kind: gap.gapMs - covered <= Server.AWAY_TOLERANCE_MS ? "pre-away" : "stale",
      awayMinutes: covered > 0 ? Math.round(covered / 60_000) : null,
      awayReason: longest?.reason ?? null,
    };
  }

  /**
   * Usage-window history for the reset-patterns chart: utilization samples plus
   * observed resets_at advances (whose prev→next delta is the window's real
   * cadence — e.g. the undocumented ~72h "weekly" advance). `informative` gates
   * dashboard visibility: false until some window actually moved, as on
   * dollar-metered seats that report no 5h/7d windows at all.
   */
  private windowsPayload(): {
    series: Array<{
      name: string;
      points: Array<{ ts: number; pct: number }>;
      resets: Array<{ ts: number; prev: string; next: string; gapHours: number | null }>;
    }>;
    informative: boolean;
    sinceMs: number;
  } {
    const sinceMs = Date.now() - 14 * 86_400_000;
    const series = new Map<string, { name: string; points: Array<{ ts: number; pct: number }>; resets: Array<{ ts: number; prev: string; next: string; gapHours: number | null }> }>();
    for (const row of this.store.windowEvents(sinceMs)) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(row.payload ?? "null") as Record<string, unknown>;
      } catch {
        continue;
      }
      const name = typeof payload?.["window"] === "string" ? (payload["window"] as string) : null;
      if (!name) continue;
      const s = series.get(name) ?? { name, points: [], resets: [] };
      if (row.kind === "account_window_sample" && typeof payload["utilization"] === "number") {
        s.points.push({ ts: row.ts, pct: payload["utilization"] as number });
      } else if (row.kind === "account_window_reset" && typeof payload["prev"] === "string" && typeof payload["next"] === "string") {
        const gapMs = Date.parse(payload["next"] as string) - Date.parse(payload["prev"] as string);
        s.resets.push({
          ts: row.ts,
          prev: payload["prev"] as string,
          next: payload["next"] as string,
          gapHours: Number.isFinite(gapMs) ? Math.round(gapMs / 360_000) / 10 : null,
        });
      }
      series.set(name, s);
    }
    const all = [...series.values()];
    const informative = all.some((s) => s.resets.length > 0 || s.points.some((pt) => pt.pct > 0));
    return { series: all, informative, sinceMs };
  }

  /**
   * "It's your turn" flash: broadcast a `turn` SSE event for the dashboard to flash + blink its
   * tab title. Debounced per session so the several hooks that can fire on one stop (or a Stop +
   * Notification pair) flash only once. The SOUND is played by the hook, not here — a detached
   * background daemon can't reach the interactive audio session — so this only drives the visual.
   */
  private handleTurn(body: Record<string, unknown>): { ok: true; flashed: boolean } {
    const sessionId = String(body["session_id"] ?? "");
    const reason = String(body["reason"] ?? "done");
    if (!this.turnSignal) return { ok: true, flashed: false };
    const now = Date.now();
    const last = this.lastTurnAt.get(sessionId) ?? 0;
    if (now - last < Server.TURN_DEBOUNCE_MS) return { ok: true, flashed: false };
    this.lastTurnAt.set(sessionId, now);
    this.broadcast("turn", { sessionId, reason, color: this.turnSignal.flashColor, ms: this.turnSignal.flashMs, at: now });
    return { ok: true, flashed: true };
  }

  private sse(res: http.ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`event: hello\ndata: ${JSON.stringify(this.sessionsPayload())}\n\n`);
    this.sseClients.add(res);
    const ping = setInterval(() => res.write(`: keepalive\n\n`), 25_000);
    ping.unref();
    res.on("close", () => {
      clearInterval(ping);
      this.sseClients.delete(res);
    });
  }

  private broadcast(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.sseClients) c.write(frame);
  }

  private json(res: http.ServerResponse, body: unknown, status = 200): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private static(reqPath: string, res: http.ServerResponse): void {
    const safe = path.normalize(reqPath).replace(/^([.][.][/\\])+/, "");
    const file = path.join(this.publicDir, safe);
    if (!file.startsWith(this.publicDir)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      res.end(data);
    });
  }
}
