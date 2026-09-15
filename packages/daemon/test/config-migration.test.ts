import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let dir: string;

/**
 * loadConfig reads a fixed path derived from appPaths(), so the config dir is redirected
 * per-test and the module re-imported to pick up the patched path.
 */
async function loadFrom(raw: unknown) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(raw));
  vi.resetModules();
  vi.doMock("@ccc/core", async () => {
    const actual = await vi.importActual<typeof import("@ccc/core")>("@ccc/core");
    return { ...actual, appPaths: () => ({ ...actual.appPaths(), config: dir }) };
  });
  const { loadConfig } = await import("../src/config.ts");
  return loadConfig();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-cfgmig-"));
});
afterEach(() => {
  vi.doUnmock("@ccc/core");
  vi.resetModules();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("keepwarm config migration (pre-tier -> per-tier)", () => {
  it("folds legacy allow1hArm into tiers['1h'].arm", async () => {
    const cfg = await loadFrom({ keepwarm: { enabled: true, allow1hArm: false, maxPingsPerIdle: 12 } });
    expect(cfg.keepwarm.tiers["1h"].arm).toBe(false);
    expect(cfg.keepwarm.tiers["5m"].arm).toBe(true);
  });

  it("folds a legacy allow1hArm: true through as well", async () => {
    const cfg = await loadFrom({ keepwarm: { enabled: true, allow1hArm: true } });
    expect(cfg.keepwarm.tiers["1h"].arm).toBe(true);
  });

  it("applies the legacy global maxPingsPerIdle to both tiers", async () => {
    const cfg = await loadFrom({ keepwarm: { enabled: true, maxPingsPerIdle: 7 } });
    expect(cfg.keepwarm.tiers["5m"].maxPingsPerIdle).toBe(7);
    expect(cfg.keepwarm.tiers["1h"].maxPingsPerIdle).toBe(7);
  });

  it("drops the legacy keys so a later save writes a clean file", async () => {
    const cfg = await loadFrom({ keepwarm: { enabled: true, allow1hArm: false, maxPingsPerIdle: 12 } });
    expect("allow1hArm" in cfg.keepwarm).toBe(false);
    expect("maxPingsPerIdle" in cfg.keepwarm).toBe(false);
  });

  it("does not re-migrate once tiers is present: explicit tiers win over stale legacy keys", async () => {
    const cfg = await loadFrom({
      keepwarm: {
        enabled: true,
        allow1hArm: false, // stale leftover
        tiers: { "1h": { arm: true, maxPingsPerIdle: 3, escalateToHandoff: true } },
      },
    });
    expect(cfg.keepwarm.tiers["1h"].arm).toBe(true);
  });

  it("fills in a partially-specified tier from defaults", async () => {
    const cfg = await loadFrom({ keepwarm: { tiers: { "1h": { maxPingsPerIdle: 5 } } } });
    expect(cfg.keepwarm.tiers["1h"].maxPingsPerIdle).toBe(5);
    expect(cfg.keepwarm.tiers["1h"].arm).toBe(true);
    expect(cfg.keepwarm.tiers["1h"].escalateToHandoff).toBe(true);
  });

  it("defaults accountType to auto and keeps the context trigger", async () => {
    const cfg = await loadFrom({ keepwarm: { enabled: true } });
    expect(cfg.keepwarm.accountType).toBe("auto");
    expect(cfg.guardian.handoffAtContextTokens).toBe(150_000);
  });

  it("honors an explicit accountType and a disabled context trigger", async () => {
    const cfg = await loadFrom({ keepwarm: { accountType: "pro" }, guardian: { handoffAtContextTokens: null } });
    expect(cfg.keepwarm.accountType).toBe("pro");
    expect(cfg.guardian.handoffAtContextTokens).toBeNull();
  });

  it("defaults handoffPath, and keeps a configured one through a partial guardian block", async () => {
    expect((await loadFrom({ guardian: { action: "handoff" } })).guardian.handoffPath).toBe("HANDOFF.md");
    const cfg = await loadFrom({ guardian: { handoffPath: "docs/STATE.md" } });
    expect(cfg.guardian.handoffPath).toBe("docs/STATE.md");
    expect(cfg.guardian.handoffAtContextTokens).toBe(150_000); // untouched sibling
  });
});
