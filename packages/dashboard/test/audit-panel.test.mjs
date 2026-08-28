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

/** Same harness as the day-tile test: real markup, real app.js, network stubbed. */
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
  return new Function(`return (function(){${src}\nreturn { renderAudit };})()`)();
}

/** A report shaped like /api/audit, using the real 2026-08-26 figures. */
function report(over = {}) {
  return {
    attributed: { n: 36, meterUsd: 167.86, localUsd: 137.96, ratio: 0.8219 },
    unattributed: { n: 0, meterUsd: 0 },
    unmetered: { n: 0, localUsd: 0 },
    byModel: [
      { model: "claude-sonnet-5", n: 20, meterUsd: 96.3, localUsd: 76.67, ratio: 0.7962 },
      { model: "claude-opus-5", n: 10, meterUsd: 54.44, localUsd: 46.88, ratio: 0.8611 },
    ],
    bySession: [],
    coverage: { meterMovedUsd: 204.13, inWindowsUsd: 167.86, pct: 82 },
    shortfall: { totalUsd: 29.9, perTurnUsd: 0.0205, perLocalDollar: 0.2167, turns: 1462 },
    drift: [],
    findings: [],
    windows: [],
    ...over,
  };
}

const wrap = () => document.getElementById("audit-wrap");
const note = () => document.getElementById("audit-note");
const foot = () => document.getElementById("audit-foot");

beforeEach(() => {
  realFetch = globalThis.fetch;
  realEventSource = globalThis.EventSource;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.EventSource = realEventSource;
  document.body.innerHTML = "";
});

describe("Cost audit panel (real index.html + app.js)", () => {
  it("ships collapsed and stays collapsed after rendering", () => {
    const app = loadApp();
    const details = wrap().querySelector("details");
    expect(details.hasAttribute("open")).toBe(false);
    app.renderAudit(report());
    expect(details.hasAttribute("open")).toBe(false);
  });

  it("puts the whole glance in the summary line", () => {
    const app = loadApp();
    app.renderAudit(report());
    expect(wrap().hidden).toBe(false);
    expect(note().textContent).toBe("— 0.822x meter · 36 windows · 82% coverage");
    expect(note().classList.contains("warn")).toBe(false);
  });

  it("shows the gap both ways, since which one holds steady is the diagnosis", () => {
    const app = loadApp();
    app.renderAudit(report());
    const figs = document.getElementById("audit-figs").textContent;
    expect(figs).toContain("$167.86");
    expect(figs).toContain("$137.96");
    // ccc reads $29.90 BELOW the meter, so the gap row is negative from ccc's side.
    expect(figs).toContain("-$29.90");
    expect(figs).toContain("$0.021 per turn");
    expect(figs).toContain("+21.7% on top of ccc's figure");
  });

  it("explains in the tooltip what the two gap figures would each mean", () => {
    const app = loadApp();
    app.renderAudit(report());
    // The aside states both figures; the tooltip is where their meaning lives.
    const tip = document.querySelector("#audit-figs dd.aside:last-child").title;
    expect(tip).toContain("charge per request");
    expect(tip).toContain("multiplier on spend");
    expect(tip).toContain("$10 per 1,000 searches");
  });

  it("marks a ratio measured from too few windows as provisional", () => {
    const app = loadApp();
    app.renderAudit({
      ...report(),
      byModel: [
        { model: "claude-opus-5", n: 11, meterUsd: 60.22, localUsd: 51.84, ratio: 0.8611 },
        { model: "claude-fable-5", n: 1, meterUsd: 2.14, localUsd: 1.97, ratio: 0.922 },
      ],
    });
    const rows = [...document.querySelectorAll("#audit-models tbody tr")].map((tr) =>
      [...tr.children].map((td) => td.textContent),
    );
    expect(rows[0][1]).toBe("0.861x"); // 11 windows: stands on its own
    expect(rows[1][1]).toBe("0.922x*"); // 1 window: flagged
    expect(foot().textContent).toContain("provisional");
  });

  it("rates each model against its accepted baseline", () => {
    const app = loadApp();
    app.renderAudit(
      report({
        drift: [
          { model: "claude-sonnet-5", baseline: 0.7962, current: 0.7962, changePct: 0, n: 20 },
          { model: "claude-opus-5", baseline: 0.8611, current: 0.8611, changePct: 0, n: 10 },
        ],
      }),
    );
    const rows = [...document.querySelectorAll("#audit-models tbody tr")].map((tr) =>
      [...tr.children].map((td) => td.textContent),
    );
    expect(rows[0]).toEqual(["claude-sonnet-5", "0.796x", "0.796x", "+0.0%", "$96.30", "$76.67", "20"]);
    expect(rows[1][2]).toBe("0.861x");
  });

  it("turns the summary amber only when a model drifted off its baseline", () => {
    const app = loadApp();
    app.renderAudit(
      report({
        drift: [{ model: "claude-opus-5", baseline: 0.8611, current: 0.712, changePct: -17.3, n: 12 }],
        findings: [{ kind: "drift", severity: "warn", subject: "claude-opus-5", message: "claude-opus-5 now prices at 0.712x the meter" }],
      }),
    );
    expect(note().textContent).toBe("— ⚠ claude-opus-5 0.861x → 0.712x (-17.3%)");
    expect(note().classList.contains("warn")).toBe(true);
    expect(foot().textContent).toContain("0.712x the meter");
  });

  it("says plainly when no spend happened off this machine", () => {
    const app = loadApp();
    app.renderAudit(report());
    expect(foot().textContent).toContain("off-machine: none seen");
  });

  it("names off-machine spend and keeps it out of the ratio", () => {
    const app = loadApp();
    app.renderAudit(report({ unattributed: { n: 3, meterUsd: 4.25 } }));
    expect(foot().textContent).toContain("$4.25");
    expect(foot().textContent).toContain("another machine");
    expect(foot().textContent).toContain("Excluded from the ratio");
  });

  it("explains how to get windows when there are none, instead of showing an empty table", () => {
    const app = loadApp();
    app.renderAudit(report({ attributed: { n: 0, meterUsd: 0, localUsd: 0, ratio: 0 } }));
    expect(note().textContent).toBe("— no reconciled windows yet");
    expect(foot().textContent).toContain("--backfill");
    expect(document.getElementById("audit-models").innerHTML).toBe("");
  });

  it("hides itself when auditing is off rather than rendering an empty panel", () => {
    const app = loadApp();
    app.renderAudit({ error: "audit disabled" });
    expect(wrap().hidden).toBe(true);
  });
});
