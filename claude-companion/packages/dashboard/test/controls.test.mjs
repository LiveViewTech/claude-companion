// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as controls from "../public/controls.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(here, "..", "public", "index.html");

let realFetch;

const jsonResponse = (obj) => ({ ok: true, json: async () => obj });
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Load the ACTUAL dashboard markup so this test fails if index.html's control IDs
    ever drift from what controls.js queries. We strip <script> tags first: they'd never
    execute from innerHTML anyway, and leaving them in makes happy-dom log a (harmless)
    "script loading is disabled" exception. We drive controls.js by importing it directly. */
function loadDashboardBody() {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!m) throw new Error("could not find <body> in index.html");
  document.body.innerHTML = m[1].replace(/<script[\s\S]*?<\/script>/gi, "");
}

beforeEach(() => {
  loadDashboardBody();
  realFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("dashboard controls (real index.html + controls.js)", () => {
  it("index.html exposes every control element controls.js targets", () => {
    expect(document.getElementById("ctrl-keepwarm")).not.toBeNull();
    expect(document.getElementById("ctrl-advisor")).not.toBeNull();
    expect(document.getElementById("ctrl-naming")).not.toBeNull();
    expect(document.getElementById("ctrl-guardian")).not.toBeNull();
    // the guardian <select> must offer exactly the four actions the daemon accepts
    const opts = [...document.getElementById("ctrl-guardian").options].map((o) => o.value);
    expect(opts).toEqual(["off", "notify-only", "wrapup", "handoff"]);
  });

  it("reflects GET /api/config into the controls", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ keepwarm: { enabled: false }, advisor: { enabled: true }, naming: { enabled: true }, guardian: { action: "handoff" } }),
    );
    await controls.refreshControls();
    expect(document.getElementById("ctrl-keepwarm").checked).toBe(false);
    expect(document.getElementById("ctrl-advisor").checked).toBe(true);
    expect(document.getElementById("ctrl-naming").checked).toBe(true);
    expect(document.getElementById("ctrl-guardian").value).toBe("handoff");
  });

  it("toggling session naming POSTs its state to /config", async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      calls.push({ url, opts });
      return jsonResponse({ guardian: { action: "notify-only" } });
    });
    controls.wireControls();
    const nam = document.getElementById("ctrl-naming");
    nam.checked = false;
    nam.dispatchEvent(new Event("change"));
    await tick();
    const post = calls.find((c) => c.url === "/config");
    expect(JSON.parse(post.opts.body)).toEqual({ naming: { enabled: false } });
  });

  it("toggling the keep-warm checkbox POSTs its state to /config", async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      calls.push({ url, opts });
      return jsonResponse({ guardian: { action: "notify-only" } });
    });
    controls.wireControls();
    const kw = document.getElementById("ctrl-keepwarm");
    kw.checked = true;
    kw.dispatchEvent(new Event("change")); // as a real click would
    await tick();
    const post = calls.find((c) => c.url === "/config");
    expect(post).toBeTruthy();
    expect(post.opts.method).toBe("POST");
    expect(JSON.parse(post.opts.body)).toEqual({ keepwarm: { enabled: true } });
  });

  it("changing the guardian select POSTs the action and re-syncs from the server echo", async () => {
    let postedBody = null;
    globalThis.fetch = vi.fn(async (url, opts) => {
      if (url === "/config") {
        postedBody = JSON.parse(opts.body);
        // daemon echoes the authoritative value (here, deliberately different)
        return jsonResponse({ guardian: { action: "notify-only" } });
      }
      return jsonResponse({});
    });
    controls.wireControls();
    const grd = document.getElementById("ctrl-guardian");
    grd.value = "handoff";
    grd.dispatchEvent(new Event("change"));
    await tick();
    expect(postedBody).toEqual({ guardian: { action: "handoff" } });
    expect(grd.value).toBe("notify-only"); // re-synced from the echo, not left at "handoff"
  });

  it("initControls wires the handlers AND triggers a refresh", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ keepwarm: { enabled: true }, advisor: { enabled: false }, guardian: { action: "off" } }),
    );
    controls.initControls();
    await tick();
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/config");
    expect(document.getElementById("ctrl-advisor").checked).toBe(false);
    expect(typeof document.getElementById("ctrl-keepwarm").onchange).toBe("function");
  });

  it("survives a daemon-down fetch rejection without throwing", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(controls.refreshControls()).resolves.toBeUndefined();
    controls.wireControls();
    document.getElementById("ctrl-advisor").dispatchEvent(new Event("change"));
    await tick(); // postConfig swallows the rejection internally
  });
});
