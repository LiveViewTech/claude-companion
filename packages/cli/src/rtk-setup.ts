import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { claudeSettingsPath } from "@ccc/core";

/**
 * rtk (Rust Token Killer) detection + install.
 *
 * Why this lives in ccc: the dashboard's rtk panel reads `rtk gain -f json`
 * (see daemon/rtk-gain.ts), which silently reports "not detected on PATH" when
 * rtk is missing — so a missing rtk looked like an empty tile rather than a
 * setup step nobody had run. `ccc install` now checks for it and installs it.
 *
 * We deliberately do NOT shell out to scripts/setup-rtk.sh: that pipes
 * `curl | sh` and is flagged untested on unix. Instead we replicate the
 * official installer's security properties in-process — SHA-256 verification
 * against the release's checksums.txt, and a path-traversal scan of the
 * archive before extraction.
 *
 * We also deliberately do NOT run `rtk init -g`, which additionally writes
 * ~/.claude/RTK.md and an @RTK.md reference into the *global* CLAUDE.md. That
 * is a user-scope footprint change affecting every project; the PreToolUse hook
 * alone is what makes rtk actually rewrite commands. Users who want the
 * instruction files can still run `rtk init -g` themselves.
 */

const REPO = "rtk-ai/rtk";
/** rtk's own canonical hook shape, so `rtk init -g --show` / `rtk verify` recognize it. */
const RTK_HOOK_COMMAND = "rtk hook claude";
const RTK_HOOK_MATCHER = "Bash";

export interface RtkStatus {
  /** rtk resolves on PATH and answers --version. */
  installed: boolean;
  version: string | null;
  /** A PreToolUse hook invoking `rtk hook …` is present in settings.json. */
  hookRegistered: boolean;
  /** ripgrep — some rtk filters shell out to it. Advisory only; we never sudo-install. */
  ripgrep: boolean;
}

/** Where the official installer puts the binary (override with RTK_INSTALL_DIR). */
export function rtkInstallDir(env: NodeJS.ProcessEnv = process.env): string {
  return env["RTK_INSTALL_DIR"] ?? path.join(os.homedir(), ".local", "bin");
}

/** Direct executable form so arguments are not interpreted by a shell. */
function probe(file: string, args: string[]): string | null {
  try {
    const res = spawnSync(file, args, {
      shell: false,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (res.status !== 0) return null;
    return (res.stdout ?? "").trim() || null;
  } catch {
    return null;
  }
}

export function rtkStatus(): RtkStatus {
  const rtkBin = process.platform === "win32" ? "rtk.cmd" : "rtk";
  const rgBin = process.platform === "win32" ? "rg.exe" : "rg";
  const version = probe(rtkBin, ["--version"]);
  return {
    installed: version !== null,
    version,
    hookRegistered: rtkHookRegistered(),
    ripgrep: probe(rgBin, ["--version"]) !== null,
  };
}

/** True when settings.json already carries an rtk PreToolUse hook. */
export function rtkHookRegistered(): boolean {
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(claudeSettingsPath(), "utf8")) as Record<string, unknown>;
  } catch {
    return false;
  }
  const hooks = settings["hooks"] as Record<string, Array<{ hooks?: Array<{ command?: string }> }>> | undefined;
  const list = hooks?.["PreToolUse"];
  if (!Array.isArray(list)) return false;
  return list.some((e) => e.hooks?.some((h) => (h.command ?? "").includes("rtk hook")));
}

/** The hook entry `ccc install` merges into settings.json (bare command — resolved via PATH). */
export function rtkHookEntry(): { matcher: string; hooks: Array<{ type: "command"; command: string }> } {
  return { matcher: RTK_HOOK_MATCHER, hooks: [{ type: "command", command: RTK_HOOK_COMMAND }] };
}

/** Release asset name for this platform. rtk ships only x86_64 for Windows. */
export function rtkAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  const a = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  if (!a) return null;
  if (platform === "win32") return "rtk-x86_64-pc-windows-msvc.zip";
  if (platform === "darwin") return `rtk-${a}-apple-darwin.tar.gz`;
  if (platform === "linux") {
    // musl for x86_64 (static, distro-agnostic); gnu is the only aarch64 build published.
    return a === "x86_64" ? "rtk-x86_64-unknown-linux-musl.tar.gz" : "rtk-aarch64-unknown-linux-gnu.tar.gz";
  }
  return null;
}

/**
 * Latest release tag via the /releases/latest 302 redirect — no API call, so no
 * 60-req/hour anonymous rate limit. Falls back to the REST API.
 */
export async function latestRtkVersion(): Promise<string | null> {
  try {
    const res = await fetch(`https://github.com/${REPO}/releases/latest`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    const loc = res.headers.get("location");
    const tag = loc?.match(/\/tag\/([^/\s]+)$/)?.[1];
    if (tag) return tag;
  } catch {
    /* fall through to the API */
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: string };
    return body.tag_name ?? null;
  } catch {
    return null;
  }
}

/** Pull the expected digest for `asset` out of a checksums.txt body. */
export function expectedDigest(checksums: string, asset: string): string | null {
  for (const line of checksums.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m && m[2] === asset) return m[1]!.toLowerCase();
  }
  return null;
}

/** Reject absolute paths and `..` components (CWE-22) before extracting. */
export function hasUnsafeEntry(entries: string[]): boolean {
  return entries.some((e) => /^\/|^[a-zA-Z]:[\\/]|(^|[\\/])\.\.([\\/]|$)/.test(e.trim()));
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

export interface EnsureRtkResult {
  /** rtk is on PATH now (either already was, or we just installed it). */
  installed: boolean;
  /** True when this call actually downloaded and installed the binary. */
  changed: boolean;
  version: string | null;
}

/**
 * Install the rtk binary if it isn't already on PATH. Never touches settings.json —
 * hook registration is folded into `ccc install`'s single surgical settings write.
 */
export async function ensureRtkBinary(opts: { dryRun?: boolean; force?: boolean; version?: string } = {}): Promise<EnsureRtkResult> {
  const before = rtkStatus();
  if (before.installed && !opts.force) {
    console.log(`rtk: already installed (${before.version}).`);
    return { installed: true, changed: false, version: before.version };
  }

  const asset = rtkAsset();
  if (!asset) {
    console.log(`rtk: no published build for ${process.platform}/${process.arch} — skipping.`);
    return { installed: false, changed: false, version: null };
  }

  const version = opts.version ?? (await latestRtkVersion());
  if (!version) {
    console.log("rtk: could not resolve the latest release (pin one with --rtk-version vX.Y.Z) — skipping.");
    return { installed: false, changed: false, version: null };
  }

  const dir = rtkInstallDir();
  if (opts.dryRun) {
    console.log(`rtk: would install ${version} (${asset}) -> ${dir}`);
    return { installed: false, changed: false, version };
  }

  const base = `https://github.com/${REPO}/releases/download/${version}`;
  console.log(`rtk: installing ${version} (${asset}) -> ${dir}`);

  let archive: Buffer;
  let checksums: string;
  try {
    archive = await download(`${base}/${asset}`);
    checksums = (await download(`${base}/checksums.txt`)).toString("utf8");
  } catch (e) {
    console.log(`rtk: download failed (${(e as Error).message}) — skipping.`);
    return { installed: false, changed: false, version };
  }

  // Verify BEFORE anything touches the filesystem.
  const expected = expectedDigest(checksums, asset);
  if (!expected) {
    console.log(`rtk: ${asset} not listed in checksums.txt — refusing to install unverified binary.`);
    return { installed: false, changed: false, version };
  }
  const actual = crypto.createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) {
    console.log(`rtk: SHA-256 mismatch (expected ${expected}, got ${actual}) — refusing to install.`);
    return { installed: false, changed: false, version };
  }
  console.log("rtk: SHA-256 verified.");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-rtk-"));
  try {
    const archivePath = path.join(tmp, asset);
    fs.writeFileSync(archivePath, archive);
    const binName = process.platform === "win32" ? "rtk.exe" : "rtk";

    if (!extract(archivePath, tmp, binName)) {
      return { installed: false, changed: false, version };
    }

    const extracted = path.join(tmp, binName);
    if (!fs.existsSync(extracted)) {
      console.log(`rtk: ${binName} not found in the archive — skipping.`);
      return { installed: false, changed: false, version };
    }

    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, binName);
    fs.copyFileSync(extracted, target);
    if (process.platform !== "win32") fs.chmodSync(target, 0o755);
    console.log(`rtk: installed -> ${target}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const after = rtkStatus();
  if (!after.installed) {
    console.log(`rtk: installed to ${dir} but not resolvable on PATH. Add it to your shell profile:`);
    console.log(`     export PATH="${dir}:$PATH"`);
  }
  return { installed: after.installed, changed: true, version: after.version ?? version };
}

/**
 * Unpack the single rtk binary. tar handles .tar.gz everywhere; Windows .zip goes
 * through Expand-Archive. Returns false when extraction was refused or failed.
 */
function extract(archivePath: string, dest: string, binName: string): boolean {
  if (archivePath.endsWith(".zip")) {
    const ps = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${dest}' -Force`],
      { encoding: "utf8", timeout: 60000, windowsHide: true },
    );
    if (ps.status !== 0) {
      console.log(`rtk: Expand-Archive failed (${(ps.stderr ?? "").trim() || ps.status}) — skipping.`);
      return false;
    }
    return true;
  }

  const list = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf8", timeout: 60000, windowsHide: true });
  if (list.status !== 0) {
    console.log(`rtk: cannot read archive with tar (${(list.stderr ?? "").trim() || list.status}) — skipping.`);
    return false;
  }
  const entries = (list.stdout ?? "").split("\n").filter(Boolean);
  if (hasUnsafeEntry(entries)) {
    console.log("rtk: archive contains unsafe paths (absolute or traversal) — refusing to extract.");
    return false;
  }
  if (!entries.some((e) => e.trim() === binName)) {
    console.log(`rtk: archive does not contain a top-level ${binName} — skipping.`);
    return false;
  }
  const x = spawnSync("tar", ["-xzf", archivePath, "-C", dest], { encoding: "utf8", timeout: 60000, windowsHide: true });
  if (x.status !== 0) {
    console.log(`rtk: extraction failed (${(x.stderr ?? "").trim() || x.status}) — skipping.`);
    return false;
  }
  return true;
}

/** `ccc rtk` — report status, and install the binary + register the hook if missing. */
export async function rtkCommand(args: string[]): Promise<number> {
  const checkOnly = args.includes("--check");
  const force = args.includes("--force");
  const vIdx = args.indexOf("--rtk-version");
  const version = vIdx >= 0 ? args[vIdx + 1] : undefined;

  const before = rtkStatus();
  console.log(`rtk binary:   ${before.installed ? before.version : "not on PATH"}`);
  console.log(`rtk hook:     ${before.hookRegistered ? `registered (${RTK_HOOK_COMMAND})` : "not registered"}`);
  console.log(`ripgrep (rg): ${before.ripgrep ? "present" : "missing — some rtk filters shell out to it"}`);

  if (checkOnly) return before.installed && before.hookRegistered ? 0 : 1;

  if (!before.installed || force) {
    const res = await ensureRtkBinary({ force, version });
    if (!res.installed) return 1;
  }
  if (!rtkHookRegistered()) {
    console.log("rtk: hook not registered — run `ccc install` to add it to settings.json.");
    return 1;
  }
  console.log("rtk: ready. Restart Claude Code so the hook loads (hooks snapshot at session start).");
  return 0;
}
