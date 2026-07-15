import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * Platform paths (Linux-first, XDG-compliant; Windows/macOS supported).
 * Inline env-paths logic to stay dependency-free.
 */
export interface AppPaths {
  /** Mutable state: SQLite DB, per-session state files. */
  state: string;
  /** User configuration. */
  config: string;
  /** Logs. */
  log: string;
}

const APP = "claude-companion";

export function appPaths(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): AppPaths {
  const home = env["CCC_HOME_OVERRIDE"] ?? os.homedir();
  if (platform === "win32") {
    const local = env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local");
    const base = path.join(local, APP);
    return { state: path.join(base, "state"), config: path.join(base, "config"), log: path.join(base, "log") };
  }
  if (platform === "darwin") {
    const base = path.join(home, "Library", "Application Support", APP);
    return { state: path.join(base, "state"), config: path.join(base, "config"), log: path.join(home, "Library", "Logs", APP) };
  }
  // Linux & friends: XDG
  const xdgState = env["XDG_STATE_HOME"] ?? path.join(home, ".local", "state");
  const xdgConfig = env["XDG_CONFIG_HOME"] ?? path.join(home, ".config");
  return {
    state: path.join(xdgState, APP),
    config: path.join(xdgConfig, APP),
    log: path.join(xdgState, APP, "log"),
  };
}

/** Root directory Claude Code writes transcripts under. */
export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env["CLAUDE_CONFIG_DIR"];
  if (configDir) return path.join(configDir, "projects");
  return path.join(os.homedir(), ".claude", "projects");
}

/** Claude Code user settings.json path. */
export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env["CLAUDE_CONFIG_DIR"];
  if (configDir) return path.join(configDir, "settings.json");
  return path.join(os.homedir(), ".claude", "settings.json");
}

/** Claude Code OAuth credentials file (written by `claude` login, rotated on token refresh). */
export function claudeCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env["CLAUDE_CONFIG_DIR"];
  if (configDir) return path.join(configDir, ".credentials.json");
  return path.join(os.homedir(), ".claude", ".credentials.json");
}
