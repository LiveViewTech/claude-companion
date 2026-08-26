#!/usr/bin/env node
import process from "node:process";
import { daemonStart, daemonStatus, daemonStop, ensureDaemon } from "./daemon-ctl.ts";
import { doctor } from "./doctor.ts";
import { openDashboard } from "./open.ts";
import { install, uninstall } from "./install.ts";
import { launch } from "./launch.ts";
import { rtkCommand } from "./rtk-setup.ts";
import { prices } from "./prices.ts";
import { audit } from "./audit.ts";

const [, , cmd, ...args] = process.argv;

async function run(): Promise<number> {
  switch (cmd) {
    case "daemon": {
      const sub = args[0];
      if (sub === "start") return daemonStart();
      if (sub === "stop") return daemonStop();
      if (sub === "status") return daemonStatus();
      console.error("usage: ccc daemon <start|stop|status>");
      return 2;
    }
    case "ensure-daemon":
      return ensureDaemon();
    case "open":
      return openDashboard();
    case "doctor":
      return doctor();
    case "install": {
      const vIdx = args.indexOf("--rtk-version");
      return install({
        dryRun: args.includes("--dry-run"),
        noRtk: args.includes("--no-rtk"),
        rtkVersion: vIdx >= 0 ? args[vIdx + 1] : undefined,
      });
    }
    case "uninstall":
      return uninstall();
    case "rtk":
      return rtkCommand(args);
    case "prices":
      return prices(args);
    case "audit":
      return audit(args);
    case "launch":
      return launch(args, false);
    case "code":
      return launch(args, true);
    case undefined:
    case "help":
    case "--help":
      console.log(`ccc — Claude Code companion

commands:
  ccc install [--dry-run] [--no-rtk] [--rtk-version vX.Y.Z]
                                 register statusline + hooks in ~/.claude/settings.json (with backup);
                                 installs rtk + its hook too unless --no-rtk
  ccc uninstall                  remove our statusline + hooks (with backup; leaves rtk alone)
  ccc rtk [--check] [--force]    report rtk binary/hook/ripgrep status; install the binary if missing
  ccc prices [--refresh]         show model rates (built-in vs auto-resolved); --refresh re-reads the published table
  ccc audit [--days N] [--json] [--backfill] [--accept]
                                 reconcile ccc's cost math against Anthropic's meter; --backfill rebuilds
                                 the period from stored meter samples; --accept freezes the current
                                 per-model ratios as the baseline drift is measured against
  ccc launch [--ttl 1h|5m] [--no-rtk] [-- args]   start claude with a cache-TTL profile
  ccc code [dir] [--ttl 1h|5m]   start VS Code with a cache-TTL profile
  ccc daemon start|stop|status   control the background daemon
  ccc ensure-daemon              start the daemon iff not running (used by SessionStart hook)
  ccc open                       open the dashboard in a browser
  ccc doctor                     check transcript schema, daemon health`);
      return 0;
    default:
      console.error(`unknown command: ${cmd} (try: ccc help)`);
      return 2;
  }
}

run().then((code) => process.exit(code));
