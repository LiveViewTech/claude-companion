// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(here, "..", "public", "index.html");
const APP_JS = path.join(here, "..", "public", "app.js");

let realFetch;
let realEventSource;

/**
 * app.js is a classic script, not a module: it queries the DOM at load and wires SSE +
 * timers on the way out. Load the real index.html body first, stub the network, then run
 * the real source inside a function scope and hand back the renderers. Loading the actual
 * markup means this fails if a tile's element ID ever drifts from what app.js queries.
 */
function loadApp() {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!body) throw new Error("could not find <body> in index.html");
  document.body.innerHTML = body[1].replace(/<script[\s\S]*?<\/script>/gi, "");
  globalThis.EventSource = class {
    addEventListener() {}
    close() {}
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  const src = fs.readFileSync(APP_JS, "utf8");
  return new Function(`return (function(){${src}\nreturn { renderDay, renderMonth };})()`)();
}

const dayCost = () => document.getElementById("day-cost");
const dayNote = () => document.getElementById("day-note");

beforeEach(() => {
  realFetch = globalThis.fetch;
  realEventSource = globalThis.EventSource;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.EventSource = realEventSource;
  document.body.innerHTML = "";
});

describe("Today tile (real index.html + app.js)", () => {
  it("shows the meter delta bare when the baseline is a real midnight reading", () => {
    const app = loadApp();
    app.renderDay({ dayCostUsd: 8.83, dayMeterUsd: 14.71, dayBaseline: { at: Date.now(), kind: "midnight", awayMinutes: null, awayReason: null }, meterStale: null });
    expect(dayCost().textContent).toBe("$14.71");
    expect(dayNote().textContent).toBe("");
    expect(dayNote().classList.contains("warn")).toBe(false);
  });

  it("names the pre-sleep baseline without warning about it", () => {
    const app = loadApp();
    const at = Date.now() - 18 * 3600_000;
    app.renderDay({ dayCostUsd: 8.83, dayMeterUsd: 14.71, dayBaseline: { at, kind: "pre-away", awayMinutes: 780, awayReason: "suspend" }, meterStale: null });
    // The overnight case is expected, not an error: full number, no warn styling.
    expect(dayCost().textContent).toBe("$14.71");
    expect(dayNote().textContent).toMatch(/^since /);
    expect(dayNote().classList.contains("warn")).toBe(false);
    expect(dayNote().title).toContain("asleep");
    expect(dayNote().title).toContain("13h");
  });

  it("warns when the baseline is old because polling broke, not because the machine slept", () => {
    const app = loadApp();
    app.renderDay({ dayCostUsd: 8.83, dayMeterUsd: 14.71, dayBaseline: { at: Date.now() - 19 * 3600_000, kind: "stale", awayMinutes: null, awayReason: null }, meterStale: null });
    expect(dayCost().textContent).toBe("$14.71");
    expect(dayNote().classList.contains("warn")).toBe(true);
    expect(dayNote().title).toContain("polling stopped");
  });

  it("falls back to the local estimate and names the meter's age when it goes stale", () => {
    const app = loadApp();
    app.renderDay({ dayCostUsd: 8.83, dayMeterUsd: null, dayBaseline: null, meterStale: { fetchedAt: Date.now() - 19 * 3600_000, ageMinutes: 19 * 60 } });
    expect(dayCost().textContent).toBe("$8.83"); // the estimate, not a frozen $0.00
    expect(dayNote().textContent).toBe("est. · meter 19h old");
    expect(dayNote().classList.contains("warn")).toBe(true);
  });

  it("labels the local estimate plainly before the meter has spanned midnight", () => {
    const app = loadApp();
    app.renderDay({ dayCostUsd: 8.83, dayMeterUsd: null, dayBaseline: null, meterStale: null });
    expect(dayCost().textContent).toBe("$8.83");
    expect(dayNote().textContent).toBe("est.");
    expect(dayNote().classList.contains("warn")).toBe(false);
  });
});

describe("This-month tile", () => {
  it("carries the meter's age in the note once it is stale", () => {
    const app = loadApp();
    app.renderMonth(299.29, 500, "account · 19h old", true);
    expect(document.getElementById("month-cost").textContent).toBe("$299.29 / $500.00");
    expect(document.getElementById("month-note").textContent).toBe("60% · account · 19h old");
    expect(document.getElementById("month-note").classList.contains("warn")).toBe(true);
  });

  it("drops the warn styling on a fresh reading", () => {
    const app = loadApp();
    app.renderMonth(314, 500, "account", false);
    expect(document.getElementById("month-note").textContent).toBe("63% · account");
    expect(document.getElementById("month-note").classList.contains("warn")).toBe(false);
  });
});
