import { spawn } from "node:child_process";

/**
 * Opens a terminal window in a session's working directory running
 * `claude --resume <sessionId>`. Called from the dashboard's "open" button via
 * POST /session/launch. The daemon runs in the user's logon session, so windows
 * it spawns land on the interactive desktop (unlike audio, which doesn't reach it).
 */

export interface LaunchSpec {
  cmd: string;
  args: string[];
  cwd?: string;
}

/** Candidate terminal invocations, tried in order until one spawns. Pure, for tests. */
export function terminalSpecs(platform: NodeJS.Platform, cwd: string, sessionId: string): LaunchSpec[] {
  const resume = `claude --resume ${sessionId}`;
  if (platform === "win32") {
    return [
      // Windows Terminal, new window in the project dir.
      { cmd: "wt.exe", args: ["-d", cwd, "powershell", "-NoExit", "-Command", resume] },
      // Fallback: classic console via cmd's `start` (title arg required when quoting).
      { cmd: "cmd.exe", args: ["/c", "start", "ccc", "powershell", "-NoExit", "-Command", resume], cwd },
    ];
  }
  if (platform === "darwin") {
    const sh = `cd ${posixQuote(cwd)} && ${resume}`;
    return [{ cmd: "osascript", args: ["-e", `tell application "Terminal" to do script ${appleQuote(sh)}`, "-e", 'tell application "Terminal" to activate'] }];
  }
  const sh = `${resume}; exec $SHELL`;
  return [
    { cmd: "x-terminal-emulator", args: ["-e", `bash -lc '${sh}'`], cwd },
    { cmd: "gnome-terminal", args: [`--working-directory=${cwd}`, "--", "bash", "-lc", sh] },
    { cmd: "konsole", args: ["--workdir", cwd, "-e", "bash", "-lc", sh] },
    { cmd: "xterm", args: ["-e", `bash -lc '${sh}'`], cwd },
  ];
}

/** Try each spec until one actually spawns. Resolves { ok } or { ok:false, error }. */
export function launchTerminal(opts: { cwd: string; sessionId: string; platform?: NodeJS.Platform }): Promise<{ ok: boolean; error?: string }> {
  const specs = terminalSpecs(opts.platform ?? process.platform, opts.cwd, opts.sessionId);
  return trySpecs(specs, 0);
}

function trySpecs(specs: LaunchSpec[], i: number): Promise<{ ok: boolean; error?: string }> {
  if (i >= specs.length) return Promise.resolve({ ok: false, error: "no terminal emulator could be started" });
  const spec = specs[i]!;
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.cmd, spec.args, {
        cwd: spec.cwd,
        detached: true,
        stdio: "ignore",
      });
    } catch {
      return resolve(trySpecs(specs, i + 1));
    }
    child.once("spawn", () => {
      child.unref();
      resolve({ ok: true });
    });
    child.once("error", () => resolve(trySpecs(specs, i + 1)));
  });
}

function posixQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
function appleQuote(s: string): string {
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}
