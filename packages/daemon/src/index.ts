import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { appPaths, claudeProjectsDir } from "@ccc/core";
import { loadConfig, saveConfig, type CccConfig } from "./config.ts";
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
import { AwakeTracker } from "./awake-tracker.ts";
import { Auditor } from "./audit.ts";
import { WindowSampler } from "./window-sampler.ts";
import { PriceResolver } from "./price-resolver.ts";

/**
 * Toast an audit finding at most once a day per subject, and record it either way. A
 * drifting price ratio only matters if somebody hears about it, and stops mattering if
 * they hear about it every five minutes.
 */
function alertOnAuditFindings(auditor: Auditor, store: Store, cfg: CccConfig): void {
  if (!cfg.audit.alertOnDrift) return;
  const now = Date.now();
  for (const finding of auditor.report(now - 14 * 86_400_000).findings) {
    if (finding.severity !== "warn") continue;
    const key = `audit_alerted:${finding.kind}:${finding.subject}`;
    const last = Number(store.getMeta(key) ?? 0);
    if (Number.isFinite(last) && now - last < 24 * 3600_000) continue;
    store.setMeta(key, String(now));
    store.logEvent("audit_finding", null, finding);
    toast({ title: `Cost audit: ${finding.subject}`, message: finding.message }, cfg.toasts);
  }
}

export async function main(): Promise<void> {
  const cfg = loadConfig();
  const paths = appPaths();
  fs.mkdirSync(paths.state, { recursive: true });
  fs.mkdirSync(paths.log, { recursive: true });

  const store = new Store(path.join(paths.state, "ccc.db"));
  const tracker = new SessionTracker(store);
  tracker.warnBeforeMs = cfg.warnBeforeSeconds * 1000;

  // Model rates for anything released after this build. Constructed before the watcher
  // starts so cached rates are registered with core ahead of the backfill replay —
  // otherwise the first pass would cost a new model's historical turns at $0.
  const priceResolver = new PriceResolver({
    enabled: cfg.pricing.autoResolve,
    refreshDays: cfg.pricing.refreshDays,
    log: (msg) => console.log(msg),
  });
  tracker.onModelSeen = (modelId) => priceResolver.noteModel(modelId);
  if (cfg.pricing.autoResolve) {
    // One refresh at boot so a rate change lands without waiting for an unpriced model
    // to show up. Rate-limited internally; failure is logged and ignored.
    void priceResolver.resolve();
  }
  const stateWriter = new StateWriter(paths.state);
  const watcher = new TranscriptWatcher(claudeProjectsDir(), tracker);
  const server = new Server(tracker, store, cfg.port);
  server.monthlyBudgetUsd = cfg.monthlyBudgetUsd;
  server.pricingStatus = () => priceResolver.status;

  // Account usage: the claude.ai meter itself, so the month tile matches the website.
  let accountPoller: AccountUsagePoller | null = null;
  // Window observations (from OAuth polls AND statusline couriers) persist to the
  // events table so the real reset cadence — e.g. the undocumented ~72h "weekly"
  // advance — is reconstructable; /api/windows serves it to the dashboard chart.
  const windowSampler = new WindowSampler(store);
  // Suspend/downtime log. Runs whether or not the meter is being polled: it is what
  // lets the "today" baseline tell a laptop that slept through midnight (fine, use the
  // pre-sleep reading) from polling that broke while the machine was up (flag it).
  const awakeTracker = new AwakeTracker({ store, log: (msg) => console.log(msg) });
  awakeTracker.start();
  // Permanent cost audit. Fed from the same successful polls that move the meter samples,
  // so it costs no extra requests.
  const auditor = cfg.audit.enabled
    ? new Auditor({ store, quietMs: Math.max(5, cfg.audit.quietMinutes) * 60_000, log: (msg) => console.log(msg) })
    : null;
  if (auditor) server.auditReport = (sinceMs) => auditor.report(sinceMs);
  if (cfg.accountUsage.enabled) {
    // Floor of 60s: a 60s cadence — 1,440 requests/day at an undocumented endpoint —
    // is what earned the 429 that froze the meter for 19h on 2026-08-25. The number
    // moves in dollars over a month; 5 minutes resolves it fine.
    const pollMs = Math.max(60, cfg.accountUsage.pollSeconds) * 1000;
    // A break in successful polling longer than this means nobody was watching the
    // meter; recordAccountPollOk logs it so a gap straddling local midnight can be
    // matched against the away windows that explain it (see Server.dayBaseline).
    const pollGapMs = Math.max(5 * 60_000, pollMs * 4);
    // Withhold "today" once the newest reading is four missed polls old, rather than
    // subtract a stale number from itself and report $0.00.
    server.meterStaleMs = Math.max(4 * pollMs, 15 * 60_000);
    accountPoller = new AccountUsagePoller({
      pollMs,
      log: (msg) => console.log(msg),
      onUpdate: (status) => {
        // Only a genuinely successful poll (error === null) counts as meter coverage;
        // status.usage lingers as last-good across errors, so gate on error too.
        if (!status.error && status.usage) {
          windowSampler.observeMeter(status.usage.usedUsd);
          store.recordAccountPollOk(Date.now(), pollGapMs);
          if (auditor && auditor.observe(status.usage.usedUsd, status.usage.fetchedAt)) {
            alertOnAuditFindings(auditor, store, cfg);
          }
        }
        for (const w of status.usage?.windows ?? []) {
          windowSampler.observe({ window: w.name, utilization: w.utilization, resetsAt: w.resetsAt, source: "oauth" });
        }
      },
    });
    server.accountUsage = () => accountPoller!.status;
    server.accountRaw = () => ({ status: accountPoller!.status, raw: accountPoller!.lastResponse });
    accountPoller.start();
  }
  // Startup snapshot; setConfig's handler below recomputes this on every live update so
  // toggling turnSignal.flash/.enabled from Controls doesn't need a daemon restart.
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

  // M3: usage-limit guardian (courier sweep) + advisor endpoint.
  const guardian = new Guardian({
    tracker,
    store,
    cfg,
    stateDir: paths.state,
    sampler: windowSampler,
    onNotify: (n) => {
      const s = tracker.get(n.sessionId);
      const who = s?.projectSlug ?? n.sessionId;
      const win = n.window === "five_hour" ? "5-hour" : n.window === "seven_day" ? "weekly" : null;
      const resets = n.resetsAt ? new Date(n.resetsAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "?";
      // A notification can come from a usage window OR from context size / keep-warm giving
      // up, which have no window and no percentage — render those from n.reason instead of
      // printing "Usage limit 0%".
      const pct = n.pct != null ? `${Math.round(n.pct)}%` : null;
      let title: string;
      let message: string;
      if (n.level === "act") {
        // Echo the path the instruction actually names, so a misconfigured handoffPath is
        // visible before you go looking for a file that was written somewhere else.
        const did = n.action === "handoff" ? `update ${n.handoffPath ?? "HANDOFF.md"}` : "capture context";
        title = pct && win ? `Usage limit ${pct} — wrapping up` : "Capturing state — safe to /clear after";
        message =
          pct && win
            ? `${who}: ${win} limit nearly exhausted (resets ${resets}). Claude will be told to ${did} and wrap up.`
            : `${who}: ${n.reason ?? "this session should capture its state now"}. Claude will be told to ${did} — then you can /clear and resume from it.`;
      } else {
        title = pct ? `Usage limit ${pct}` : "Usage limit";
        message = pct && win ? `${who}: ${win} limit at ${pct} (resets ${resets}).` : `${who}: ${n.reason ?? "approaching a limit"}.`;
      }
      toast({ title, message }, cfg.toasts);
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
  server.handlers.guardianResumeShown = (sid) => {
    const ok = guardian.resumeShown(sid);
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
    // At the ping cap on an escalating tier, stop buying time and externalize the state
    // instead: the guardian's existing one-shot channel delivers the HANDOFF.md instruction.
    onEscalate: (sid, reason) => {
      if (
        !guardian.armHandoff(
          sid,
          "keepwarm-cap",
          reason,
          "keep-warm has stopped pinging (ping cap reached), so the prompt cache will lapse shortly and the whole context will have to be re-sent",
        )
      )
        return;
      const s = tracker.get(sid);
      if (s) stateWriter.writeSession(s);
      const handoffPath = s?.guardian.pendingHandoffPath ?? cfg.guardian.handoffPath;
      toast(
        { title: "Writing handoff", message: `${s?.projectSlug ?? sid}: ${reason}. Claude will write ${handoffPath} so you can /clear and resume cheaply.` },
        cfg.toasts,
      );
    },
  });
  tracker.on("assistantTurn", ({ sessionId, entry }) => {
    keepwarm.onAssistantTurn(sessionId, entry);
  });
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
    // server.turnSignal gates handleTurn()'s flash broadcast and is only a startup snapshot
    // (see above) — recompute it on every update so toggling turnSignal.flash/.enabled from
    // Controls takes effect immediately instead of waiting for a daemon restart.
    server.turnSignal =
      cfg.turnSignal.enabled && cfg.turnSignal.flash
        ? { flashColor: cfg.turnSignal.flashColor, flashMs: cfg.turnSignal.flashMs }
        : null;
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
  // Before the backfill: a replayed turn can re-enter keepwarm's onEscalate -> guardian.armHandoff,
  // which must see a restored pending action rather than arm a second one behind it.
  for (const s of guardian.restorePending()) stateWriter.writeSession(s);
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
