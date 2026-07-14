// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderWindows } from "../public/windows-chart.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(here, "..", "public", "index.html");

/** Real dashboard markup, so the test fails if index.html's IDs drift from the module. */
function loadDashboardBody() {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!m) throw new Error("could not find <body> in index.html");
  document.body.innerHTML = m[1].replace(/<script[\s\S]*?<\/script>/gi, "");
}

beforeEach(() => loadDashboardBody());
afterEach(() => {
  document.body.innerHTML = "";
});

const h = 3600_000;
const now = Date.now();

function weeklySeries() {
  // Sawtooth: climbs, then a 72h reset drops it.
  return {
    name: "seven_day",
    points: [
      { ts: now - 30 * h, pct: 60 },
      { ts: now - 20 * h, pct: 96 },
      { ts: now - 19 * h, pct: 2 },
      { ts: now - 2 * h, pct: 34 },
    ],
    resets: [{ ts: now - 19 * h, prev: "2026-07-16T05:00:00Z", next: "2026-07-19T05:00:00Z", gapHours: 72 }],
  };
}

describe("usage-window reset chart (real index.html + windows-chart.js)", () => {
  it("stays hidden when the daemon says the data is uninformative", () => {
    renderWindows({ series: [{ name: "amber_ladder", points: [{ ts: now, pct: 0 }], resets: [] }], informative: false });
    expect(document.getElementById("windows-wrap").hidden).toBe(true);
  });

  it("renders step lines, reset markers, and the observed-resets table when informative", () => {
    renderWindows({ series: [weeklySeries()], informative: true });
    const wrap = document.getElementById("windows-wrap");
    expect(wrap.hidden).toBe(false);
    // Collapsed by default: the <details> has no open attribute in the markup.
    expect(wrap.querySelector("details").open).toBe(false);
    const svg = document.querySelector("#windows-chart svg");
    expect(svg).not.toBeNull();
    // One step path for the series (grid lines are <line>s, not <path>s) + the reset flag path.
    const paths = [...svg.querySelectorAll("path")];
    expect(paths.length).toBeGreaterThanOrEqual(2);
    expect(svg.querySelector('line[stroke-dasharray="3 4"]')).not.toBeNull(); // reset marker
    // Table view: the 72h advance is stated as data.
    const table = document.getElementById("windows-resets");
    expect(table.textContent).toContain("seven_day");
    expect(table.textContent).toContain("72h");
    // Single series: direct label present, no legend row.
    expect(document.querySelector(".win-legend")).toBeNull();
    expect(svg.textContent).toContain("seven_day");
  });

  it("shows a legend when two series are present", () => {
    renderWindows({
      series: [weeklySeries(), { name: "five_hour", points: [{ ts: now - 4 * h, pct: 48 }], resets: [] }],
      informative: true,
    });
    const keys = [...document.querySelectorAll(".win-legend .win-key")].map((k) => k.textContent);
    expect(keys).toEqual(["seven_day", "five_hour"]);
  });
});
