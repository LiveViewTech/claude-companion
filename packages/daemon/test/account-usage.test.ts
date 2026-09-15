import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountUsagePoller, parseUsageResponse } from "../src/account-usage.ts";

// Shape documented in jens-duttke/usage-monitor-for-claude docs/api-reference.md (2026-03).
// used_credits / monthly_limit are cents (the sample below is $239.28 of a $500 limit).
const SAMPLE = {
  five_hour: { utilization: 48.0, resets_at: "2026-03-02T11:00:00.521744+00:00" },
  seven_day: { utilization: 64.0, resets_at: "2026-03-06T06:00:00.521764+00:00" },
  seven_day_opus: null,
  extra_usage: { is_enabled: true, monthly_limit: 50000, used_credits: 23928, utilization: null },
};

let dir: string;
let credsFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-acct-"));
  credsFile = path.join(dir, ".credentials.json");
  fs.writeFileSync(credsFile, JSON.stringify({ claudeAiOauth: { accessToken: "tok-123" } }));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function poller(fetchFn: typeof fetch): AccountUsagePoller {
  return new AccountUsagePoller({ pollMs: 60_000, fetchFn, credentialsFile: credsFile });
}

describe("parseUsageResponse", () => {
  it("extracts the claude.ai meter (cents -> dollars) and usage-limit windows", () => {
    const u = parseUsageResponse(SAMPLE)!;
    expect(u.usedUsd).toBe(239.28);
    expect(u.monthlyLimitUsd).toBe(500);
    expect(u.fiveHour).toEqual({ name: "five_hour", utilization: 48.0, resetsAt: "2026-03-02T11:00:00.521744+00:00" });
    expect(u.sevenDay?.utilization).toBe(64.0);
  });

  it("rejects responses without a usable extra_usage block", () => {
    expect(parseUsageResponse({})).toBeNull();
    expect(parseUsageResponse({ extra_usage: { used_credits: "nope" } })).toBeNull();
    expect(parseUsageResponse(null)).toBeNull();
  });

  it("tolerates a missing monthly limit", () => {
    const u = parseUsageResponse({ extra_usage: { used_credits: 150, monthly_limit: null } })!;
    expect(u.usedUsd).toBe(1.5);
    expect(u.monthlyLimitUsd).toBeNull();
    expect(u.fiveHour).toBeNull();
    expect(u.windows).toEqual([]);
  });

  it("collects windows name-agnostically, including the newer limits array", () => {
    const u = parseUsageResponse({
      extra_usage: { used_credits: 0, monthly_limit: 50000 },
      seven_day_sonnet: { utilization: 2.0, resets_at: "2026-07-16T05:00:00Z" },
      limits: [
        { group: "five_hour", percent: 12, resets_at: "2026-07-14T05:00:00Z" },
        { group: "seven_day", percent: 34, resets_at: "2026-07-16T05:00:00Z" },
        { group: "seven_day", scope: { model: { display_name: "Fable" } }, percent: 4, resets_at: "2026-07-16T05:00:00Z" },
        { group: "mystery_window", percent: 7, resets_at: null },
      ],
    })!;
    // Convenience picks resolve from the limits array when top-level fields are absent.
    expect(u.fiveHour).toEqual({ name: "five_hour", utilization: 12, resetsAt: "2026-07-14T05:00:00Z" });
    expect(u.sevenDay?.utilization).toBe(34);
    // Unknown window types are kept, not dropped — names/cadences are undocumented.
    expect(u.windows.map((w) => w.name)).toEqual(["seven_day_sonnet", "five_hour", "seven_day", "seven_day_fable", "mystery_window"]);
  });
});

describe("AccountUsagePoller", () => {
  it("sends the token from .credentials.json with the oauth beta header", async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const p = poller(((url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> };
      return Promise.resolve(new Response(JSON.stringify(SAMPLE), { status: 200 }));
    }) as unknown as typeof fetch);
    const s = await p.pollOnce();
    expect(seen!.url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(seen!.headers["Authorization"]).toBe("Bearer tok-123");
    expect(seen!.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(s.error).toBeNull();
    expect(s.usage?.usedUsd).toBe(239.28);
  });

  it("reports no-token without calling the API when credentials are absent", async () => {
    fs.rmSync(credsFile);
    let called = false;
    const p = poller((() => {
      called = true;
      return Promise.resolve(new Response("{}"));
    }) as unknown as typeof fetch);
    const s = await p.pollOnce();
    expect(called).toBe(false);
    expect(s.error).toBe("no-token");
    expect(s.usage).toBeNull();
  });

  it("keeps the last good reading through transient errors", async () => {
    let fail = false;
    const p = poller((() =>
      Promise.resolve(fail ? new Response("oops", { status: 500 }) : new Response(JSON.stringify(SAMPLE), { status: 200 }))) as unknown as typeof fetch);
    await p.pollOnce();
    fail = true;
    const s = await p.pollOnce();
    expect(s.error).toBe("http-500");
    expect(s.usage?.usedUsd).toBe(239.28); // stale but present
  });

  it("flags auth expiry and honors Retry-After on 429", async () => {
    let status = 401;
    let calls = 0;
    const p = poller((() => {
      calls++;
      return Promise.resolve(new Response("", { status, headers: { "Retry-After": "120" } }));
    }) as unknown as typeof fetch);
    expect((await p.pollOnce()).error).toBe("auth-expired");
    status = 429;
    expect((await p.pollOnce()).error).toBe("rate-limited");
    // Backoff window: the next poll is skipped without a request.
    await p.pollOnce();
    expect(calls).toBe(2);
  });

  it("clamps a Retry-After that would otherwise take the meter dark for hours", async () => {
    // The 2026-08-25 failure: a 429 asked for a day of silence, the poller obliged, and
    // the month tile sat frozen for 19h while "today" reported $0.00.
    let calls = 0;
    const logs: string[] = [];
    const p = new AccountUsagePoller({
      pollMs: 60_000,
      credentialsFile: credsFile,
      log: (m) => logs.push(m),
      fetchFn: (() => {
        calls++;
        return Promise.resolve(
          calls === 1
            ? new Response("", { status: 429, headers: { "Retry-After": "86400" } })
            : new Response(JSON.stringify(SAMPLE), { status: 200 }),
        );
      }) as unknown as typeof fetch,
    });

    vi.useFakeTimers();
    try {
      const t0 = new Date("2026-08-25T22:00:00Z");
      vi.setSystemTime(t0);
      expect((await p.pollOnce()).error).toBe("rate-limited");
      expect(logs.join(" ")).toContain("clamped to 900s");

      vi.setSystemTime(new Date(t0.getTime() + 10 * 60_000)); // inside the ceiling
      await p.pollOnce();
      expect(calls).toBe(1);

      vi.setSystemTime(new Date(t0.getTime() + 16 * 60_000)); // past it — asks again
      expect((await p.pollOnce()).error).toBeNull();
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
