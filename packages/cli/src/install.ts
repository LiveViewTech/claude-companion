import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeSettingsPath } from "@ccc/core";
import { ensureRtkBinary, rtkHookEntry, rtkStatus } from "./rtk-setup.ts";

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
    turnSignal: path.join(root, "packages", "hooks", "src", "turn-signal.mjs"),
  };
}

function nodeCmd(script: string): string {
  return `node "${script}"`;
}

/** One desired hook registration. A LIST (not a per-event map) so multiple ccc
 *  hooks can coexist on one event (e.g. Stop carries keep-warm AND turn-signal). */
interface DesiredHook {
  event: string;
  entry: HookEntry;
  label: string;
}

function desiredHooks(): DesiredHook[] {
  const p = repoPaths();
  return [
    { event: "SessionStart", entry: { hooks: [{ type: "command", command: nodeCmd(p.sessionStart), timeout: 10 }] }, label: "daemon autostart" },
    { event: "UserPromptSubmit", entry: { hooks: [{ type: "command", command: nodeCmd(p.promptSubmit), timeout: 5 }] }, label: "advisor" },
    // Long timeout: the keep-warm hook deliberately sleeps up to one 5m TTL window.
    { event: "Stop", entry: { hooks: [{ type: "command", command: nodeCmd(p.stop), timeout: 600 }] }, label: "keep-warm/guardian" },
    // Turn signal: sound + dashboard flash whenever it's the user's turn. The VS Code
    // extension doesn't reliably emit Notification for AskUserQuestion or permission
    // prompts, so we cover each case with its dedicated event:
    //   Stop            -> done       (fires reliably after every response)
    //   PreToolUse+AUQ  -> question   (documented workaround for the AskUserQuestion gap)
    //   PermissionRequest -> permission (fires when a permission dialog appears)
    //   Notification    -> permission/idle (CLI + idle-timeout; harmless no-op in the extension)
    // turn-signal never emits a decision and exits 0, so PreToolUse/PermissionRequest
    // fall through to normal behavior — they don't block or auto-approve anything.
    { event: "Stop", entry: { hooks: [{ type: "command", command: nodeCmd(p.turnSignal), timeout: 10 }] }, label: "turn-signal (done)" },
    { event: "PreToolUse", entry: { matcher: "AskUserQuestion", hooks: [{ type: "command", command: nodeCmd(p.turnSignal), timeout: 10 }] }, label: "turn-signal (question)" },
    { event: "PermissionRequest", entry: { hooks: [{ type: "command", command: nodeCmd(p.turnSignal), timeout: 10 }] }, label: "turn-signal (permission)" },
    { event: "Notification", entry: { hooks: [{ type: "command", command: nodeCmd(p.turnSignal), timeout: 10 }] }, label: "turn-signal (permission/idle)" },
  ];
}

/**
 * Marker test for "this command points into our repo".
 *
 * Case-INSENSITIVE on purpose: the marker is really the repo directory name, and
 * `git clone` yields `Claude-Companion` (capitalized). A case-sensitive match made
 * `ccc install` treat its own statusline as foreign and — worse — made `ccc
 * uninstall` a silent no-op that left every hook behind.
 */
export function isOurs(cmd: string): boolean {
  return cmd.toLowerCase().includes(CCC_MARKER);
}

export interface InstallOptions {
  dryRun?: boolean;
  /** Skip the rtk check/install entirely (same flag name as `ccc launch --no-rtk`). */
  noRtk?: boolean;
  /** Pin the rtk release instead of resolving the latest. */
  rtkVersion?: string;
}

export async function install(opts: InstallOptions = {}): Promise<number> {
  const dryRun = opts.dryRun ?? false;
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

  // rtk first: the binary must exist on PATH before its hook is worth registering.
  // Network work, so it happens before we start staging settings edits.
  let rtkPresent = false;
  if (opts.noRtk) {
    console.log("rtk: skipped (--no-rtk).");
  } else {
    const res = await ensureRtkBinary({ dryRun, version: opts.rtkVersion });
    rtkPresent = res.installed;
    if (!rtkPresent && dryRun) rtkPresent = rtkStatus().installed;
    if (!rtkPresent && !dryRun) {
      console.log("rtk: unavailable — continuing without the rtk hook (ccc works fine without it).");
    }
    if (rtkPresent && !rtkStatus().ripgrep) {
      console.log("rtk: note — ripgrep (rg) is missing; some rtk filters shell out to it. Install it with your package manager.");
    }
  }

  const changes: string[] = [];
  const p = repoPaths();

  // Statusline (only set if absent or already ours — never clobber a foreign statusline).
  const existingSL = settings["statusLine"] as { command?: string } | undefined;
  if (!existingSL || (existingSL.command && isOurs(existingSL.command))) {
    const desiredSL = { type: "command", command: nodeCmd(p.statusline), padding: 0, refreshInterval: 1000 };
    // Only report a change when the value actually differs, so a re-run of an
    // up-to-date install still says "nothing to change".
    if (JSON.stringify(existingSL) !== JSON.stringify(desiredSL)) {
      settings["statusLine"] = desiredSL;
      changes.push(`statusLine -> ccc statusline (refresh 1s)`);
    }
  } else {
    console.log(`note: a non-ccc statusline is configured (${existingSL.command}); leaving it alone.`);
    console.log(`      to chain it, have it exec our script too, or remove it and re-run ccc install.`);
  }

  // Hooks: append ours if not already present. Dedup by EXACT command string
  // (not "is it ours?"), so a second ccc hook on the same event — e.g. turn-signal
  // alongside keep-warm on Stop — is added rather than mistaken for already-present.
  const hooks = (settings["hooks"] ?? {}) as Record<string, HookEntry[]>;
  const desired = desiredHooks();
  // rtk's hook is NOT ccc-marked: it carries no CCC_MARKER, so `ccc uninstall`
  // leaves it in place (it isn't ours to remove — `rtk init -g --uninstall` owns
  // that). Dedup is by exact command string, so a hook already registered by
  // `rtk init -g` is recognized rather than duplicated.
  if (rtkPresent) {
    desired.push({ event: "PreToolUse", entry: rtkHookEntry(), label: "rtk auto-rewrite" });
  }
  for (const { event, entry, label } of desired) {
    const list = hooks[event] ?? [];
    const cmd = entry.hooks[0]!.command;
    const present = list.some((e) => e.hooks?.some((h) => h.command === cmd));
    if (!present) {
      list.push(entry);
      hooks[event] = list;
      changes.push(`hooks.${event} += ccc ${label}`);
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
