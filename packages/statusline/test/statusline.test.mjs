import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "src", "statusline.mjs");

let home;
let stateDir;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-statusline-"));
  // Linux layout; the script picks its state dir by platform, so pin every candidate.
  stateDir = path.join(home, "state", "claude-companion");
  fs.mkdirSync(path.join(stateDir, "sessions"), { recursive: true });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** Run the real statusline with this stdin and return its line, ANSI stripped. */
function render(input) {
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(input),
    env: { ...process.env, HOME: home, XDG_STATE_HOME: path.join(home, "state") },
    encoding: "utf8",
  });
  return r.stdout.replace(/\x1b\[[0-9;]*m/g, "");
}

function writeSession(state) {
  fs.writeFileSync(path.join(stateDir, "sessions", "s1.json"), JSON.stringify(state));
}
function writePlan(flat) {
  fs.writeFileSync(path.join(stateDir, "global.json"), JSON.stringify({ plan: { subscriptionType: flat ? "pro" : null, flat } }));
}

const STDIN = {
  session_id: "s1",
  model: { display_name: "Sonnet 5" },
  cost: { total_cost_usd: 3.32 },
  context_window: { total_input_tokens: 177_000, used_percentage: 18 },
  rate_limits: { five_hour: { used_percentage: 51 }, seven_day: { used_percentage: 79 } },
};

describe.skipIf(process.platform !== "linux")("statusline cost display", () => {
  it("drops the session cost on a flat plan and keeps context and windows", () => {
    writePlan(true);
    const line = render(STDIN);
    expect(line).not.toContain("$");
    expect(line).toContain("ctx 177K");
    expect(line).toContain("5h 51%");
    expect(line).toContain("7d 79%");
  });

  it("drops the re-write cost from an expired cache on a flat plan", () => {
    writePlan(true);
    writeSession({ expiresAt: Date.now() - 1000, ttlTier: "1h", rewriteCostUsd: 0.71 });
    const line = render(STDIN);
    expect(line).toContain("cache expired");
    expect(line).not.toContain("$");
  });

  it("shows costs on a usage-billed plan even when usage windows are present", () => {
    writePlan(false);
    writeSession({ expiresAt: Date.now() - 1000, ttlTier: "5m", rewriteCostUsd: 0.71 });
    const line = render(STDIN);
    expect(line).toContain("$3.32");
    expect(line).toContain("rewrite $0.71");
  });

  it("with no daemon state, treats a rate_limits field as a subscription seat", () => {
    expect(render(STDIN)).not.toContain("$");
    const { rate_limits: _, ...apiKeySeat } = STDIN;
    expect(render(apiKeySeat)).toContain("$3.32");
  });
});
