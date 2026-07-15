#!/usr/bin/env node
// SessionStart hook: make sure the ccc daemon is running (lazy autostart).
// Must be fast and silent — spawn detached and exit immediately.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ccc = path.resolve(here, "../../cli/src/ccc.ts");

try {
  const child = spawn(process.execPath, [ccc, "ensure-daemon"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
} catch {
  /* never block session start */
}
process.exit(0);
