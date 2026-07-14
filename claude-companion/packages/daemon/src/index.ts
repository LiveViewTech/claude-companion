import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { appPaths, claudeProjectsDir } from "@ccc/core";
import { loadConfig, saveConfig } from "./config.ts";
import { applyConfigUpdate, type ConfigUpdate } from "./config-runtime.ts";
import { Store } from "./store.ts";
import { SessionTracker } from "./session-tracker.ts";
import { TranscriptWatcher } from "./watcher.ts";
import { StateWriter } from "./state-writer.ts";
import { Server } from "./server.ts";
import { toast } from "./notify.ts";
import { Guardian } from "./guardian.ts";
import { Advisor } from "./advisor.ts";
import { KeepWarm } from "./keepwarm.ts";
import { Namer } from "./namer.ts";
import { launchTerminal } from "./launcher.ts";
import { computeExactAttribution } from "./attribution.ts";
import { AccountUsagePoller } from "./account-usage.ts";
import { WindowSampler } from "./window-sampler.ts";

export async function main(): Promise<void> {
  const cfg = loadConfig();
  const paths = appPaths();
  fs.mkdirSync(paths.state, { recursive: true });
  fs.mkdirSync(paths.log, { recursive: true });

  const store = new Store(path.join(paths.state, "ccc.db"));
  const tracker = new SessionTracker(store);
  tracker.warnBeforeMs = cfg.warnBeforeSeconds * 1000;
  const stateWriter = new StateWriter(paths.state);
  const watcher = new TranscriptWatcher(claudeProjectsDir(), tracker);
  const server = new Server(tracker, store, cfg.port);
  server.monthlyBudgetUsd = cfg.monthlyBudgetUsd;

  // Account usage: the claude.ai meter itself, so the month tile matches the website.
  let accountPoller: AccountUsagePoller | null = null;
  // Window observations (from OAuth polls AND statusline couriers) persist to the
  // events table so the real reset cadence — e.g. the undocumented ~72h "weekly"
  // advance — is reconstructable; /api/windows serves it to the dashboard chart.
  const windowSampler = new WindowSampler(store);
  if (cfg.accountUsage.enabled) {
    accountPoller = new AccountUsagePoller({
      pollMs: Math.max(15, cfg.accountUsage.pollSeconds) * 1000,
      onUpdate: (status) => {
        for (const w of status.usage?.windows ?? []) {
          windowSampler.observe({ window: w.name, utilization: w.utilization, resetsAt: w.resetsAt, source: "oauth" });
        }
      },
    });
    server.accountUsage = () => accountPoller!.status;
    server.accountRaw = () => ({ status: accountPoller!.status, raw: accountPoller!.lastResponse });
    accountPoller.start();
  }
  server.turnSignal =
    cfg.turnSignal.enabled && cfg.turnSignal.flash
      ? { flashColor: cfg.turnSignal.flashColor, flashMs: cfg.turnSignal.flashMs }
      : null;
  // NOTE: sound is played by the turn-signal HOOK, never the daemon. A detached background
  // process (the daemon) can't reach the interactive audio session, so daemon-side playback is
  // silent — verified live. The hook runs as a child of Claude Code in the user's session and can.

  // Session naming: every human prompt feeds the namer; its own `claude -p` runs execute in
  // state/namer, which is hidden from the dashboard (they'd otherwise name themselves forever).
  const namerDir = path.join(paths.state, "namer");
  const namer = new Namer({ tracker, store, cfg, namerDir });
  tracker.on("humanPrompt", (e) => namer.notePrompt(e));
  server.hideSessionsUnder = namerDir;

  // Dashboard "open" button: terminal window in the session's cwd running `claude --resume`.
  server.handlers.launchSession = async (sessionId) => {
    if (!/^[0-9a-zA-Z_-]{8,64}$/.test(sessionId)) return { ok: false, error: "bad session id" };
    const s = tracker.get(sessionId);
    if (!s) return { ok: false, error: "unknown session" };
    if (!s.cwd) return { ok: false, error: "no working directory recorded for this session" };
    store.logEvent("session_launch", sessionId, { cwd: s.cwd });
    return launchTerminal({ cwd: s.cwd, sessionId });
  };

  // Wire toasts + state files.
  tracker.on("state", (s) => stateWriter.writeSession(s));
  tracker.on("expiryWarning", ({ sessionId, rewriteCostUsd }) => {
    const s = tracker.get(sessionId);
    toast(
      {
        title: "Claude cache expiring soon",
        message: `${s?.projectSlug ?? sessionId}: ~60s left. Reply now or the next prompt re-writes ~$${rewriteCostUsd.toFixed(2)}.`,
      },
      cfg.toasts,
    );
    store.logEvent("expiry_warning", sessionId, { rewriteCostUsd });
  });
  tracker.on("expired", ({ sessionId, rewriteCostUsd }) => {
    const s = tracker.get(sessionId);
    toast(
      {
        title: "Claude cache expired",
        message: `${s?.projectSlug ?? sessionId}: next prompt pays a cold re-write (~$${rewriteCostUsd.toFixed(2)}).`,
      },
      cfg.toasts,
    );
    store.logEvent("expired", sessionId, { rewriteCostUsd });
  });
  tracker.on("coldRewrite", ({ sessionId, costUsd, gapSeconds }) => {
    toast(
      {
        title: "Cold cache re-write",
        message: `Session paid $${costUsd.toFixed(2)} to re-read history after ${Math.round(gapSeconds / 60)} min idle.`,
      },
      cfg.toasts,
    );
  });

  // M3: rate-limit guardian (courier sweep) + advisor endpoint.
  const guardian = new Guardian({
    tracker,
    store,
    cfg,
    stateDir: paths.state,
    sampler: windowSampler,
    onNotify: (n) => {
      const s = tracker.get(n.sessionId);
      const win = n.window === "five_hour" ? "5-hour" : "weekly";
      const resets = n.resetsAt ? new Date(n.resetsAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "?";
      toast(
        {
          title: n.level === "act" ? `Rate limit ${Math.round(n.pct)}% — wrapping up` : `Rate limit ${Math.round(n.pct)}%`,
          message:
            n.level === "act"
              ? `${s?.projectSlug ?? n.sessionId}: ${win} limit nearly exhausted (resets ${resets}). Claude will be told to ${n.action === "handoff" ? "write a handoff" : "capture context and wrap up"}.`
              : `${s?.projectSlug ?? n.sessionId}: ${win} limit at ${Math.round(n.pct)}% (resets ${resets}).`,
        },
        cfg.toasts,
      );
      if (s) stateWriter.writeSession(s);
    },
  });
  const advisor = new Advisor({
    tracker,
    cfg,
    ackGuardian: (sid, action) => {
      const ok = guardian.ack(sid, action);
      const s = tracker.get(sid);
      if (ok && s) stateWriter.writeSession(s);
      return ok;
    },
  });
  server.handlers.advise = (body) =>
    advisor.advise({
      session_id: String(body["session_id"] ?? ""),
      prompt: String(body["prompt"] ?? ""),
      cwd: typeof body["cwd"] === "string" ? body["cwd"] : undefined,
    });
  server.handlers.guardianAck = (sid, action) => {
    const ok = guardian.ack(sid, action);
    const s = tracker.get(sid);
    if (ok && s) stateWriter.writeSession(s);
    return ok;
  };
  const guardianTimer = setInterval(() => {
    const changed = guardian.sweep();
    // Account-wide 5h/7d windows reach every active session — including VS Code
    // extension sessions, which have no statusline to courier rate_limits.
    if (accountPoller?.status.usage) changed.push(...guardian.applyAccountWindows(accountPoller.status.usage));
    for (const s of new Set(changed)) stateWriter.writeSession(s);
  }, 15_000);
  guardianTimer.unref();

  // M5: keep-warm engine + periodic exact-token attribution.
  const keepwarm = new KeepWarm({
    tracker,
    store,
    cfg,
    onEvent: (kind, sid, payload) => {
      store.logEvent(kind, sid, payload);
      const s = tracker.get(sid);
      if (s) stateWriter.writeSession(s);
      if (kind === "keepwarm_miss_disarm") {
        toast(
          { title: "Keep-warm disarmed", message: `${s?.projectSlug ?? sid}: ping missed the cache (model switch or expiry) — stopped to avoid wasted spend.` },
          cfg.toasts,
        );
      }
    },
  });
  tracker.on("assistantTurn", ({ sessionId, entry }) => keepwarm.onAssistantTurn(sessionId, entry));
  server.handlers.keepwarmAuthorize = (sid) => keepwarm.authorize(sid);
  server.handlers.keepwarmSetArmed = (sid, armed) => keepwarm.setArmed(sid, armed);
  server.handlers.keepwarmBreakEven = (sid) => ({
    breakEven: keepwarm.breakEvenFor(sid),
    pingCostUsd: keepwarm.pingCostFor(sid),
  });

  // Live feature toggles from the dashboard. applyConfigUpdate mutates the shared cfg
  // object IN PLACE — every engine (guardian/keepwarm/advisor) holds this same reference,
  // so a flip takes effect on their next call, no restart. It reports which features were
  // just switched off so we can tear down in-flight state (the dashboard then reflects it
  // at once), then we persist to config.json.
  server.handlers.getConfig = () => cfg;
  server.handlers.setConfig = (updates) => {
    const effects = applyConfigUpdate(cfg, updates as ConfigUpdate);
    if (effects.keepwarmDisabled) {
      for (const s of tracker.all) {
        if (s.keepwarm.armed) {
          keepwarm.setArmed(s.sessionId, false);
          stateWriter.writeSession(s);
        }
      }
    }
    if (effects.guardianDisabled) {
      for (const s of tracker.all) {
        if (s.guardian.pendingAction) {
          s.guardian.pendingAction = null;
          stateWriter.writeSession(s);
        }
      }
    }
    saveConfig(cfg);
    return cfg;
  };
  const attributionTimer = setInterval(() => {
    try {
      computeExactAttribution(store);
    } catch { /* non-fatal */ }
  }, 60_000);
  attributionTimer.unref();

  // Startup: recover cumulative state from DB, then backfill new lines, then go live.
  tracker.restoreFromStore();
  await watcher.start();
  for (const s of tracker.all) stateWriter.writeSession(s);
  await server.listen();

  const pidFile = path.join(paths.state, "daemon.pid");
  fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, port: cfg.port, startedAt: Date.now() }));
  const shutdown = async () => {
    try {
      fs.unlinkSync(pidFile);
    } catch { /* ignore */ }
    accountPoller?.stop();
    await watcher.stop();
    server.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`ccc-daemon listening on http://127.0.0.1:${cfg.port} — watching ${claudeProjectsDir()}`);
  console.log(`state: ${paths.state}`);
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  main().catch((e) => {
    console.error("daemon failed:", e);
    process.exit(1);
  });
}
