import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { claudeSettingsPath } from "@ccc/core";

/**
 * TTL launcher profiles:
 *   ccc launch --ttl 1h            -> ENABLE_PROMPT_CACHING_1H=1 claude ...
 *   ccc launch --ttl 5m            -> FORCE_PROMPT_CACHING_5M=1 claude ...
 *   ccc launch --no-rtk            -> temp settings file with rtk hooks stripped
 *   ccc code [dir] --ttl 1h        -> VS Code inherits the env (extension sessions too)
 * TTL env vars are read at session launch; they can't change a running session.
 */
export async function launch(args: string[], viaCode: boolean): Promise<number> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const passthrough: string[] = [];
  let noRtk = false;

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
    } else if (a === "--no-rtk") {
      noRtk = true;
    } else if (a === "--") {
      passthrough.push(...args.slice(i + 1));
      break;
    } else {
      passthrough.push(a);
    }
  }

  if (noRtk) {
    const stripped = stripRtkSettings();
    if (stripped) {
      if (viaCode) {
        console.error("--no-rtk works only with `ccc launch` (CLI sessions); the VS Code extension reads the standard settings.");
      } else {
        passthrough.unshift("--settings", stripped);
        console.log(`rtk hooks stripped for this session (temp settings: ${stripped})`);
      }
    } else {
      console.log("--no-rtk: no rtk hooks found in settings — nothing to strip.");
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

/** Copy user settings minus rtk hook entries into a temp file; null when no rtk found. */
function stripRtkSettings(): string | null {
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(claudeSettingsPath(), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const hooks = settings["hooks"] as Record<string, Array<{ hooks?: Array<{ command?: string }> }>> | undefined;
  if (!hooks) return null;
  let found = false;
  for (const event of Object.keys(hooks)) {
    const before = hooks[event]!.length;
    hooks[event] = hooks[event]!.filter((e) => !e.hooks?.some((h) => (h.command ?? "").includes("rtk")));
    if (hooks[event]!.length !== before) found = true;
  }
  if (!found) return null;
  const tmp = path.join(os.tmpdir(), `ccc-no-rtk-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  return tmp;
}
