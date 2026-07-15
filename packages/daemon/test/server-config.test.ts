import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.ts";
import { SessionTracker } from "../src/session-tracker.ts";
import { Server } from "../src/server.ts";
import { DEFAULTS, type CccConfig } from "../src/config.ts";
import { applyConfigUpdate, type ConfigUpdate } from "../src/config-runtime.ts";

let dir: string;
let store: Store;
let tracker: SessionTracker;
let server: Server;
let base: string;
let cfg: CccConfig;
let persisted: number;

/**
 * Wires the config handlers exactly as index.ts does — using the REAL applyConfigUpdate
 * (not a copy) — so GET /api/config, POST /config, the in-place mutation, validation, and
 * persist path are exercised end-to-end over a real socket. `persisted` stands in for the
 * saveConfig(cfg) call.
 */
function wireConfigHandlers(): void {
  server.handlers.getConfig = () => cfg;
  server.handlers.setConfig = (updates) => {
    applyConfigUpdate(cfg, updates as ConfigUpdate);
    persisted++;
    return cfg;
  };
}

async function getConfig(): Promise<CccConfig> {
  return (await (await fetch(`${base}/api/config`)).json()) as CccConfig;
}
async function postConfig(body: Record<string, unknown>): Promise<CccConfig> {
  const r = await fetch(`${base}/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await r.json()) as CccConfig;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-cfg-"));
  store = new Store(path.join(dir, "test.db"));
  tracker = new SessionTracker(store);
  server = new Server(tracker, store, 0); // ephemeral port
  cfg = structuredClone(DEFAULTS);
  persisted = 0;
  wireConfigHandlers();
  await server.listen();
  base = `http://127.0.0.1:${server.boundPort}`;
});
afterEach(() => {
  server.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("config HTTP endpoints", () => {
  it("GET /api/config returns the current config", async () => {
    const got = await getConfig();
    expect(got.keepwarm.enabled).toBe(true);
    expect(got.advisor.enabled).toBe(true);
    expect(got.guardian.action).toBe(DEFAULTS.guardian.action);
  });

  it("POST /config applies the feature toggles and persists", async () => {
    const res = await postConfig({
      keepwarm: { enabled: false },
      advisor: { enabled: false },
      naming: { enabled: false },
      guardian: { action: "handoff" },
    });
    expect(res.keepwarm.enabled).toBe(false);
    expect(res.advisor.enabled).toBe(false);
    expect(res.naming.enabled).toBe(false);
    expect(res.guardian.action).toBe("handoff");
    expect(persisted).toBe(1); // saveConfig-equivalent ran once
    // readable back on the next GET (same in-memory object the daemon serves)
    expect((await getConfig()).guardian.action).toBe("handoff");
  });

  it("rejects an invalid guardian.action, keeping the previous value", async () => {
    await postConfig({ guardian: { action: "handoff" } });
    const res = await postConfig({ guardian: { action: "bogus" } });
    expect(res.guardian.action).toBe("handoff"); // unchanged
  });

  it("ignores a non-positive nudgeEvery but accepts a valid one", async () => {
    const res1 = await postConfig({ advisor: { nudgeEvery: 0 } });
    expect(res1.advisor.nudgeEvery).toBe(DEFAULTS.advisor.nudgeEvery); // 0 rejected
    const res2 = await postConfig({ advisor: { nudgeEvery: 3 } });
    expect(res2.advisor.nudgeEvery).toBe(3);
  });

  it("leaves unrelated fields untouched on a partial update", async () => {
    const res = await postConfig({ keepwarm: { enabled: false } });
    expect(res.port).toBe(DEFAULTS.port);
    expect(res.turnSignal.enabled).toBe(DEFAULTS.turnSignal.enabled);
    expect(res.advisor.enabled).toBe(true); // not in the update
  });

  it("returns 400 on a malformed JSON body", async () => {
    const r = await fetch(`${base}/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(r.status).toBe(400);
  });
});

describe("applyConfigUpdate teardown effects", () => {
  it("flags keepwarmDisabled only on an enabled -> disabled transition", () => {
    const c = structuredClone(DEFAULTS); // keepwarm.enabled = true
    expect(applyConfigUpdate(c, { keepwarm: { enabled: false } }).keepwarmDisabled).toBe(true);
    // already off: no teardown needed
    expect(applyConfigUpdate(c, { keepwarm: { enabled: false } }).keepwarmDisabled).toBe(false);
    // turning back on: not a disable
    expect(applyConfigUpdate(c, { keepwarm: { enabled: true } }).keepwarmDisabled).toBe(false);
  });

  it("flags guardianDisabled only on an active -> off transition", () => {
    const c = structuredClone(DEFAULTS); // guardian.action = "notify-only"
    expect(applyConfigUpdate(c, { guardian: { action: "off" } }).guardianDisabled).toBe(true);
    // already off -> off: no teardown
    expect(applyConfigUpdate(c, { guardian: { action: "off" } }).guardianDisabled).toBe(false);
    // off -> handoff: not a disable
    expect(applyConfigUpdate(c, { guardian: { action: "handoff" } }).guardianDisabled).toBe(false);
  });

  it("ignores unknown keys and never replaces nested objects", () => {
    const c = structuredClone(DEFAULTS);
    const keepwarmRef = c.keepwarm;
    applyConfigUpdate(c, { port: 9999, bogus: true, keepwarm: { enabled: false } } as never);
    expect(c.port).toBe(DEFAULTS.port); // port is not a live-updatable toggle
    expect(c.keepwarm).toBe(keepwarmRef); // mutated in place, same reference the engines hold
  });
});
