import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionState } from "@ccc/core";
import type { SessionTracker } from "./session-tracker.ts";
import type { Store } from "./store.ts";
import { classStats, computeExactAttribution, rtkVerdict, toolLeaderboard } from "./attribution.ts";
import { rtkGain } from "./rtk-gain.ts";
import { coldRewriteSummary, projectHabits } from "./habits.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

/**
 * Localhost-only HTTP server: static dashboard, JSON API, SSE stream,
 * plus endpoints the hooks/statusline call (advisor + rate-limit courier land here in M3).
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
  /** Dashboard flash config for the "it's your turn" signal; null = flashing off. Set by index.ts. */
  turnSignal: { flashColor: string; flashMs: number } | null = null;
  /** Per-session debounce for /turn so a burst of Stop/Notification hooks flashes once. */
  private lastTurnAt = new Map<string, number>();
  private static TURN_DEBOUNCE_MS = 1200;
  /** Feature endpoints plugged in by index.ts (advisor M3, keep-warm M5). */
  handlers: {
    advise?: (body: Record<string, unknown>) => unknown;
    guardianAck?: (sessionId: string, action: string) => boolean;
    keepwarmAuthorize?: (sessionId: string) => { ping: boolean; reason?: string };
    keepwarmSetArmed?: (sessionId: string, armed: boolean) => unknown;
    keepwarmBreakEven?: (sessionId: string) => unknown;
  } = {};

  constructor(tracker: SessionTracker, store: Store, port: number) {
    this.tracker = tracker;
    this.store = store;
    this.port = port;
    const here = path.dirname(fileURLToPath(import.meta.url));
    this.publicDir = path.resolve(here, "../../dashboard/public");
    this.server = http.createServer((req, res) => this.route(req, res));

    tracker.on("state", (s) => this.broadcast("state", s));
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
      if (p === "/api/tools") {
        computeExactAttribution(this.store);
        return void this.json(res, { leaderboard: toolLeaderboard(this.store), classes: classStats(this.store) });
      }
      if (p === "/api/rtk") {
        computeExactAttribution(this.store);
        // gain = rtk's own measured savings (ground truth — the transcript-derived
        // verdict can't see hook-rewritten commands; see rtk-gain.ts).
        return void this.json(res, { verdict: rtkVerdict(this.store), gain: rtkGain() });
      }
      if (p === "/api/habits") {
        const weekAgo = Date.now() - 7 * 86_400_000;
        return void this.json(res, { projects: projectHabits(this.store), coldRewritesWeek: coldRewriteSummary(this.store, weekAgo) });
      }
      if (p === "/api/breakeven") {
        const sid = url.searchParams.get("session_id") ?? "";
        return void this.json(res, this.handlers.keepwarmBreakEven?.(sid) ?? null);
      }
      if (p === "/events") return void this.sse(res);
      if (req.method === "POST" && p === "/advise") return void this.post(req, res, (b) => this.handlers.advise?.(b) ?? {});
      if (req.method === "POST" && p === "/guardian/ack")
        return void this.post(req, res, (b) => ({ ok: this.handlers.guardianAck?.(String(b["session_id"] ?? ""), String(b["action"] ?? "")) ?? false }));
      if (req.method === "POST" && p === "/keepwarm/authorize")
        return void this.post(req, res, (b) => this.handlers.keepwarmAuthorize?.(String(b["session_id"] ?? "")) ?? { ping: false, reason: "keep-warm not available" });
      if (req.method === "POST" && p === "/keepwarm/arm")
        return void this.post(req, res, (b) => this.handlers.keepwarmSetArmed?.(String(b["session_id"] ?? ""), Boolean(b["armed"])) ?? { error: "not available" });
      if (req.method === "POST" && p === "/turn") return void this.post(req, res, (b) => this.handleTurn(b));
      if (p.startsWith("/api/")) return void this.json(res, { error: "not found" }, 404);
      return void this.static(p === "/" ? "/index.html" : p, res);
    } catch (e) {
      this.json(res, { error: String(e) }, 500);
    }
  }

  /** Read a JSON body (64KB cap) and answer with the handler's JSON result. */
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
      try {
        this.json(res, handler(body) ?? {});
      } catch (e) {
        this.json(res, { error: String(e) }, 500);
      }
    });
  }

  private sessionsPayload(): { sessions: SessionState[]; now: number } {
    const sessions = this.tracker.all
      .filter((s) => s.lastTurnAt != null)
      .sort((a, b) => (b.lastTurnAt ?? 0) - (a.lastTurnAt ?? 0))
      .slice(0, 50);
    return { sessions, now: Date.now() };
  }

  private dayPayload(): {
    dayCostUsd: number;
    from: number;
    to: number;
    monthCostUsd: number;
    monthStart: number;
    monthlyBudgetUsd: number | null;
  } {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const end = start + 86_400_000;
    // Month-to-date: first of the local month through now. dayCostUsd is just a
    // SUM(cost_usd) over a ts range, so it serves the month window too.
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    return {
      dayCostUsd: this.store.dayCostUsd(start, end),
      from: start,
      to: end,
      monthCostUsd: this.store.dayCostUsd(monthStart, now.getTime() + 1),
      monthStart,
      monthlyBudgetUsd: this.monthlyBudgetUsd,
    };
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
