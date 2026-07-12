import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeSettingsPath } from "@ccc/core";

/**
 * Surgical settings.json editor: registers our statusline + hooks, preserving
 * everything else byte-for-byte semantically (parse -> modify -> serialize).
 * Every entry we add carries the CCC_MARKER in its command string so uninstall
 * can find exactly ours. A timestamped backup is written before any change.
 */
const CCC_MARKER = "claude-companion";

interface HookCmd {
  type: "command";
  command: string;
  timeout?: number;
}
interface HookEntry {
  matcher?: string;
  hooks: HookCmd[];
}

function repoPaths() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "../../..");
  return {
    statusline: path.join(root, "packages", "statusline", "src", "statusline.mjs"),
    sessionStart: path.join(root, "packages", "hooks", "src", "session-start.mjs"),
    promptSubmit: path.join(root, "packages", "hooks", "src", "user-prompt-submit.mjs"),
    stop: path.join(root, "packages", "hooks", "src", "stop-keepwarm.mjs"),
  };
}

function nodeCmd(script: string): string {
  return `node "${script}"`;
}

function desiredHooks(): Record<string, HookEntry> {
  const p = repoPaths();
  return {
    SessionStart: { hooks: [{ type: "command", command: nodeCmd(p.sessionStart), timeout: 10 }] },
    UserPromptSubmit: { hooks: [{ type: "command", command: nodeCmd(p.promptSubmit), timeout: 5 }] },
    // Long timeout: the keep-warm hook deliberately sleeps up to one 5m TTL window.
    Stop: { hooks: [{ type: "command", command: nodeCmd(p.stop), timeout: 600 }] },
  };
}

function isOurs(cmd: string): boolean {
  return cmd.includes(CCC_MARKER);
}

export async function install(dryRun: boolean): Promise<number> {
  const settingsPath = claudeSettingsPath();
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  } catch (e) {
    if (fs.existsSync(settingsPath)) {
      console.error(`refusing to touch unparseable settings: ${settingsPath} (${(e as Error).message})`);
      return 1;
    }
  }

  const changes: string[] = [];
  const p = repoPaths();

  // Statusline (only set if absent or already ours — never clobber a foreign statusline).
  const existingSL = settings["statusLine"] as { command?: string } | undefined;
  if (!existingSL || (existingSL.command && isOurs(existingSL.command))) {
    settings["statusLine"] = { type: "command", command: nodeCmd(p.statusline), padding: 0, refreshInterval: 1000 };
    changes.push(`statusLine -> ccc statusline (refresh 1s)`);
  } else {
    console.log(`note: a non-ccc statusline is configured (${existingSL.command}); leaving it alone.`);
    console.log(`      to chain it, have it exec our script too, or remove it and re-run ccc install.`);
  }

  // Hooks: append ours per event if not already present.
  const hooks = (settings["hooks"] ?? {}) as Record<string, HookEntry[]>;
  for (const [event, entry] of Object.entries(desiredHooks())) {
    const list = hooks[event] ?? [];
    const present = list.some((e) => e.hooks?.some((h) => isOurs(h.command)));
    if (!present) {
      list.push(entry);
      hooks[event] = list;
      changes.push(`hooks.${event} += ccc ${event === "Stop" ? "keep-warm/guardian" : event === "UserPromptSubmit" ? "advisor" : "daemon autostart"}`);
    }
  }
  settings["hooks"] = hooks;

  if (changes.length === 0) {
    console.log("already installed — nothing to change.");
    return 0;
  }

  console.log(`planned changes to ${settingsPath}:`);
  for (const c of changes) console.log(`  + ${c}`);
  if (dryRun) {
    console.log("(dry run — nothing written)");
    return 0;
  }

  if (fs.existsSync(settingsPath)) {
    const backup = `${settingsPath}.ccc-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(settingsPath, backup);
    console.log(`backup: ${backup}`);
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log("installed. Restart Claude Code sessions to pick up hooks/statusline (hook config snapshots at startup).");
  return 0;
}

export async function uninstall(): Promise<number> {
  const settingsPath = claudeSettingsPath();
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  } catch {
    console.log("no settings file — nothing to uninstall.");
    return 0;
  }

  let changed = false;
  const sl = settings["statusLine"] as { command?: string } | undefined;
  if (sl?.command && isOurs(sl.command)) {
    delete settings["statusLine"];
    changed = true;
  }
  const hooks = settings["hooks"] as Record<string, HookEntry[]> | undefined;
  if (hooks) {
    for (const event of Object.keys(hooks)) {
      const before = hooks[event]!.length;
      hooks[event] = hooks[event]!.filter((e) => !e.hooks?.some((h) => isOurs(h.command)));
      if (hooks[event]!.length !== before) changed = true;
      if (hooks[event]!.length === 0) delete hooks[event];
    }
    if (Object.keys(hooks).length === 0) delete settings["hooks"];
  }

  if (!changed) {
    console.log("nothing of ours found in settings.");
    return 0;
  }
  const backup = `${settingsPath}.ccc-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(settingsPath, backup);
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`uninstalled (backup: ${backup}).`);
  return 0;
}
