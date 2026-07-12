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

export async function daemonStop(): Promise<number> {
  const info = readPid();
  if (!info) {
    console.log("daemon: not running (no pid file)");
    return 0;
  }
  try {
    process.kill(info.pid, "SIGTERM");
    console.log(`sent SIGTERM to pid ${info.pid}`);
  } catch {
    console.log("daemon process already gone; cleaning pid file");
  }
  try {
    fs.unlinkSync(pidFile());
  } catch { /* ignore */ }
  return 0;
}

/** Idempotent start for the SessionStart hook: fast no-op when healthy. */
export async function ensureDaemon(): Promise<number> {
  const cfg = loadConfig();
  if (await isHealthy(cfg.port)) return 0;
  return daemonStart();
}
