import { spawnSync, spawn } from "node:child_process";
import process from "node:process";

/**
 * TTL launcher profiles:
 *   ccc launch --ttl 1h            -> ENABLE_PROMPT_CACHING_1H=1 claude ...
 *   ccc launch --ttl 5m            -> FORCE_PROMPT_CACHING_5M=1 claude ...
 *   ccc code [dir] --ttl 1h        -> VS Code inherits the env (extension sessions too)
 * TTL env vars are read at session launch; they can't change a running session.
 */
export async function launch(args: string[], viaCode: boolean): Promise<number> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const passthrough: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--ttl") {
      const v = args[++i];
      if (v === "1h") env["ENABLE_PROMPT_CACHING_1H"] = "1";
      else if (v === "5m") env["FORCE_PROMPT_CACHING_5M"] = "1";
      else {
        console.error(`--ttl expects 1h or 5m, got: ${v}`);
        return 2;
      }
    } else if (a === "--") {
      passthrough.push(...args.slice(i + 1));
      break;
    } else {
      passthrough.push(a);
    }
  }

  const bin = viaCode ? "code" : "claude";
  const finalArgs = viaCode && passthrough.length === 0 ? ["."] : passthrough;
  const isWin = process.platform === "win32";
  if (viaCode) {
    const child = spawn(bin, finalArgs, { env, detached: true, stdio: "ignore", shell: isWin });
    child.unref();
    console.log(`launched: code ${finalArgs.join(" ")} (TTL env applied to extension sessions)`);
    return 0;
  }
  const res = spawnSync(bin, finalArgs, { env, stdio: "inherit", shell: isWin });
  return res.status ?? 1;
}
