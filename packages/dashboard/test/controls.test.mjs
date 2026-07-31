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
    expect(document.getElementById("ctrl-sound")).not.toBeNull();
    expect(document.getElementById("ctrl-flash")).not.toBeNull();
    // the guardian <select> must offer exactly the four actions the daemon accepts
    const opts = [...document.getElementById("ctrl-guardian").options].map((o) => o.value);
    expect(opts).toEqual(["off", "notify-only", "wrapup", "handoff"]);
  });

  it("reflects GET /api/config into the controls", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        keepwarm: { enabled: false },
        advisor: { enabled: true },
        naming: { enabled: true },
        guardian: { action: "handoff" },
        turnSignal: { sound: false, flash: true },
      }),
    );
    await controls.refreshControls();
    expect(document.getElementById("ctrl-keepwarm").checked).toBe(false);
    expect(document.getElementById("ctrl-advisor").checked).toBe(true);
    expect(document.getElementById("ctrl-naming").checked).toBe(true);
    expect(document.getElementById("ctrl-guardian").value).toBe("handoff");
    expect(document.getElementById("ctrl-sound").checked).toBe(false);
    expect(document.getElementById("ctrl-flash").checked).toBe(true);
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

  it("toggling turn sound and turn flash each POST their own turnSignal field", async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      calls.push({ url, opts });
      return jsonResponse({ guardian: { action: "notify-only" } });
    });
    controls.wireControls();
    const snd = document.getElementById("ctrl-sound");
    snd.checked = false;
    snd.dispatchEvent(new Event("change"));
    await tick();
    const fls = document.getElementById("ctrl-flash");
    fls.checked = false;
    fls.dispatchEvent(new Event("change"));
    await tick();
    const posts = calls.filter((c) => c.url === "/config").map((c) => JSON.parse(c.opts.body));
    expect(posts).toEqual([{ turnSignal: { sound: false } }, { turnSignal: { flash: false } }]);
  });

  it("snaps ctrl-sound/ctrl-flash back to the server echo when the daemon didn't apply the change", async () => {
    // Regression: an older daemon build ignored an unrecognized turnSignal update and echoed
    // the config back unchanged. The checkbox must reflect that (not the user's optimistic click),
    // or the control silently lies about what's actually configured.
    globalThis.fetch = vi.fn(async () => jsonResponse({ turnSignal: { sound: true, flash: true } }));
    controls.wireControls();
    const snd = document.getElementById("ctrl-sound");
    const fls = document.getElementById("ctrl-flash");
    snd.checked = false;
    snd.dispatchEvent(new Event("change"));
    await tick();
    fls.checked = false;
    fls.dispatchEvent(new Event("change"));
    await tick();
    expect(snd.checked).toBe(true); // snapped back — the update didn't actually take
    expect(fls.checked).toBe(true);
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

  it("card view: the select offers exactly the two views and starts on advanced markup", () => {
    const cv = document.getElementById("ctrl-cardview");
    expect(cv).not.toBeNull();
    expect([...cv.options].map((o) => o.value)).toEqual(["advanced", "simple"]);
    expect(document.body.classList.contains("view-simple")).toBe(false);
  });

  it("card view: /api/config drives body.view-simple and the select", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ dashboard: { cardView: "simple" } }));
    await controls.refreshControls();
    expect(document.getElementById("ctrl-cardview").value).toBe("simple");
    expect(document.body.classList.contains("view-simple")).toBe(true);
  });

  it("card view: a config without a dashboard block falls back to advanced", async () => {
    document.body.classList.add("view-simple");
    globalThis.fetch = vi.fn(async () => jsonResponse({ keepwarm: { enabled: true } }));
    await controls.refreshControls();
    expect(document.getElementById("ctrl-cardview").value).toBe("advanced");
    expect(document.body.classList.contains("view-simple")).toBe(false);
  });

  it("card view: changing the select applies immediately and POSTs the new view", async () => {
    let postedBody = null;
    globalThis.fetch = vi.fn(async (url, opts) => {
      if (url === "/config") {
        postedBody = JSON.parse(opts.body);
        return jsonResponse({ dashboard: { cardView: "simple" } });
      }
      return jsonResponse({});
    });
    controls.wireControls();
    const cv = document.getElementById("ctrl-cardview");
    cv.value = "simple";
    cv.dispatchEvent(new Event("change"));
    // Applied optimistically, before the POST resolves — it's a view preference, not a daemon behavior.
    expect(document.body.classList.contains("view-simple")).toBe(true);
    await tick();
    expect(postedBody).toEqual({ dashboard: { cardView: "simple" } });
  });

  it("card view: an older daemon that echoes the config unchanged snaps the view back", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ dashboard: { cardView: "advanced" } }));
    controls.wireControls();
    const cv = document.getElementById("ctrl-cardview");
    cv.value = "simple";
    cv.dispatchEvent(new Event("change"));
    await tick();
    expect(cv.value).toBe("advanced");
    expect(document.body.classList.contains("view-simple")).toBe(false);
  });

  it("Controls, rtk and Events are collapsible like the analytics sections", () => {
    const summaries = [...document.querySelectorAll(".feed-wrap details.collapsible > summary")].map(
      (s) => s.textContent.trim().split(/\s+/)[0].toLowerCase(),
    );
    for (const name of ["controls", "rtk", "events"]) expect(summaries).toContain(name);
    // Controls hosts the card-view toggle, so it must not start collapsed.
    expect(document.getElementById("ctrl-cardview").closest("details").open).toBe(true);
  });

  it("card view: loading into simple folds every section below the cards", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ dashboard: { cardView: "simple" } }));
    await controls.refreshControls();
    const sections = [...document.querySelectorAll("main details.collapsible")];
    expect(sections.length).toBeGreaterThanOrEqual(5);
    expect(sections.every((d) => d.open === false)).toBe(true);
  });

  it("card view: switching to simple folds everything EXCEPT the Controls panel in use", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ dashboard: { cardView: "simple" } }));
    controls.wireControls();
    const cv = document.getElementById("ctrl-cardview");
    cv.value = "simple";
    cv.dispatchEvent(new Event("change"));
    await tick();
    const controlsPanel = cv.closest("details");
    expect(controlsPanel.open).toBe(true); // the user is standing in it
    const others = [...document.querySelectorAll("main details.collapsible")].filter((d) => d !== controlsPanel);
    expect(others.every((d) => d.open === false)).toBe(true);
  });

  it("card view: switching back to advanced unfolds the sections again", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ dashboard: { cardView: "advanced" } }));
    for (const d of document.querySelectorAll("main details.collapsible")) d.open = false;
    controls.wireControls();
    const cv = document.getElementById("ctrl-cardview");
    cv.value = "advanced";
    cv.dispatchEvent(new Event("change"));
    await tick();
    expect([...document.querySelectorAll("main details.collapsible")].every((d) => d.open)).toBe(true);
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
