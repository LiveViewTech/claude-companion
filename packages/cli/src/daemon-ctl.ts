import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { appPaths } from "@ccc/core";
import { loadConfig } from "@ccc/daemon/config";

interface PidInfo {
  pid: number;
  port: number;
  startedAt: number;
}

function pidFile(): string {
  return path.join(appPaths().state, "daemon.pid");
}

function readPid(): PidInfo | null {
  try {
    return JSON.parse(fs.readFileSync(pidFile(), "utf8")) as PidInfo;
  } catch {
    return null;
  }
}

async function isHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function daemonStatus(): Promise<number> {
  const cfg = loadConfig();
  const info = readPid();
  const healthy = await isHealthy(info?.port ?? cfg.port);
  if (healthy) {
    console.log(`daemon: online (pid ${info?.pid ?? "?"}, http://127.0.0.1:${info?.port ?? cfg.port})`);
    return 0;
  }
  console.log("daemon: offline");
  return 1;
}

export async function daemonStart(foreground = false): Promise<number> {
  const cfg = loadConfig();
  if (await isHealthy(cfg.port)) {
    console.log(`daemon already running on http://127.0.0.1:${cfg.port}`);
    return 0;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const entry = path.resolve(here, "../../daemon/src/index.ts");
  if (foreground) {
    const { main } = await import("@ccc/daemon");
    await main();
    return 0;
  }
  const logDir = appPaths().log;
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, "daemon.log"), "a");
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  child.unref();
  // Wait for health (up to ~5s).
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await isHealthy(cfg.port)) {
      console.log(`daemon started (pid ${child.pid}) on http://127.0.0.1:${cfg.port}`);
      return 0;
    }
  }
  console.error(`daemon did not become healthy — check ${path.join(logDir, "daemon.log")}`);
  return 1;
}

/** Poll until the port stops answering /healthz. Returns false if it never does. */
async function waitForPortFree(port: number, attempts = 20, everyMs = 250): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (!(await isHealthy(port))) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return !(await isHealthy(port));
}

/**
 * Stop the daemon. `wait` polls until the port is actually free, escalating to SIGKILL if
 * the process ignores SIGTERM — required before starting a replacement, because
 * daemonStart() treats a still-answering port as "already running" and no-ops.
 */
export async function daemonStop(wait = false): Promise<number> {
  const info = readPid();
  const cfg = loadConfig();
  const port = info?.port ?? cfg.port;
  if (!info) {
    console.log("daemon: not running (no pid file)");
    return 0;
  }
  let alive = true;
  try {
    process.kill(info.pid, "SIGTERM");
    console.log(`sent SIGTERM to pid ${info.pid}`);
  } catch {
    console.log("daemon process already gone; cleaning pid file");
    alive = false;
  }
  // Remove the pid file only after we have the pid in hand, so an escalation can still use it.
  try {
    fs.unlinkSync(pidFile());
  } catch { /* ignore */ }
  if (!wait || !alive) return 0;

  if (await waitForPortFree(port)) return 0;
  // Still serving after ~5s: SIGKILL and give the socket a moment to close.
  try {
    process.kill(info.pid, "SIGKILL");
    console.log(`pid ${info.pid} ignored SIGTERM — sent SIGKILL`);
  } catch { /* already gone */ }
  if (await waitForPortFree(port, 12)) return 0;
  console.error(`port ${port} is still answering after SIGKILL — something else may be bound to it`);
  return 1;
}

/**
 * Stop then start, waiting for the old process to release the port in between.
 * `stop && start` does NOT do this: stop returns before the process exits, so start sees a
 * healthy port, reports "already running", and exits 0 having started nothing — leaving no
 * daemon at all once the old one finishes shutting down.
 */
export async function daemonRestart(): Promise<number> {
  const code = await daemonStop(true);
  if (code !== 0) return code;
  return daemonStart();
}

/** Idempotent start for the SessionStart hook: fast no-op when healthy. */
export async function ensureDaemon(): Promise<number> {
  const cfg = loadConfig();
  if (await isHealthy(cfg.port)) return 0;
  return daemonStart();
}
