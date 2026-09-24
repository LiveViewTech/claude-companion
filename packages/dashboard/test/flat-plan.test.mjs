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

/** Same harness as day-tile.test.mjs: real markup, real app.js, network stubbed. */
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
  return new Function(`return (function(){${src}\nreturn { setPlan, renderLimits, fillCard, addFeedItem, sessions };})()`)();
}

function session(over = {}) {
  return {
    sessionId: "s1",
    projectSlug: "-home-me-code-vision",
    model: "claude-sonnet-5",
    turns: 91,
    ttlTier: "1h",
    expiresAt: Date.now() + 30 * 60_000,
    lastTurnAt: Date.now(),
    prefixTokens: 177_000,
    rewriteCostUsd: 0.709,
    sessionCostUsd: 3.32,
    officialCostUsd: null,
    prefixTaxUsd: 0.035,
    prefixTaxByModel: { "claude-fable-5": 0.177 },
    modelSwitchCostUsd: { "claude-fable-5": 3.55 },
    keepwarm: { armed: true, pings: 2, netSavedUsd: 0.4, reason: "" },
    ...over,
  };
}

function newCard() {
  return document.getElementById("card-tpl").content.firstElementChild.cloneNode(true);
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  realEventSource = globalThis.EventSource;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.EventSource = realEventSource;
  document.body.innerHTML = "";
  document.body.className = "";
});

describe("flat-fee plan (real index.html + app.js)", () => {
  it("marks every dollar-bearing card row and header tile cost-only", () => {
    loadApp();
    const card = newCard();
    for (const sel of [".cost", ".carry", ".carry-models", ".rewrite", ".switch"]) {
      expect(card.querySelector(sel).closest(".cost-only"), sel).not.toBeNull();
    }
    expect(document.getElementById("day-cost").closest(".cost-only")).not.toBeNull();
    expect(document.getElementById("month-cost").closest(".cost-only")).not.toBeNull();
    expect(document.getElementById("audit-wrap").classList.contains("cost-only")).toBe(true);
    // The replacements only show on a flat plan.
    expect(card.querySelector(".ctx").closest(".flat-only")).not.toBeNull();
    expect(document.getElementById("limit-5h").closest(".flat-only")).not.toBeNull();
  });

  it("toggles body.plan-flat and reports whether the plan changed", () => {
    const app = loadApp();
    expect(app.setPlan({ flat: true })).toBe(true);
    expect(document.body.classList.contains("plan-flat")).toBe(true);
    expect(app.setPlan({ flat: true })).toBe(false);
    expect(app.setPlan(null)).toBe(true);
    expect(document.body.classList.contains("plan-flat")).toBe(false);
  });

  it("shows context size banded like the statusline, and no keep-warm dollars", () => {
    const app = loadApp();
    app.setPlan({ flat: true });
    const card = newCard();
    app.fillCard(card, session());
    expect(card.querySelector(".ctx").textContent).toBe("177k tok");
    expect(card.querySelector(".ctx").className).toBe("ctx ");
    expect(card.querySelector(".kw-info").textContent).toBe("");
    app.fillCard(card, session({ prefixTokens: 240_000 }));
    expect(card.querySelector(".ctx").classList.contains("ctx-yellow")).toBe(true);
    app.fillCard(card, session({ prefixTokens: 310_000 }));
    expect(card.querySelector(".ctx").classList.contains("ctx-red")).toBe(true);
  });

  it("keeps the keep-warm net figure on a usage-billed plan", () => {
    const app = loadApp();
    const card = newCard();
    app.fillCard(card, session());
    expect(card.querySelector(".kw-info").textContent).toBe("net +$0.400");
  });

  it("renders the usage-window tiles with reset times", () => {
    const app = loadApp();
    const soon = Date.now() + 2 * 3600_000;
    app.renderLimits({ fiveHour: { pct: 51.4, resetsAt: soon }, sevenDay: { pct: 91, resetsAt: soon + 3 * 86_400_000 }, at: Date.now() });
    expect(document.getElementById("limit-5h").textContent).toBe("51%");
    expect(document.getElementById("limit-5h-note").textContent).toMatch(/^resets /);
    expect(document.getElementById("limit-5h-fill").style.width).toBe("51%");
    expect(document.getElementById("limit-7d").textContent).toBe("91%");
    expect(document.getElementById("limit-7d-fill").style.background).toBe("var(--critical)");
  });

  it("drops a window's number once its reset time has passed", () => {
    const app = loadApp();
    app.renderLimits({ fiveHour: { pct: 54, resetsAt: Date.now() - 60_000 }, sevenDay: null, at: Date.now() - 3600_000 });
    expect(document.getElementById("limit-5h").textContent).toBe("–");
    expect(document.getElementById("limit-5h-note").textContent).toMatch(/^reset /);
    expect(document.getElementById("limit-7d").textContent).toBe("–");
  });

  it("sizes feed events in tokens, not dollars", () => {
    const app = loadApp();
    app.setPlan({ flat: true });
    app.sessions.set("s1", session());
    app.addFeedItem("expired", { sessionId: "s1", rewriteCostUsd: 0.709 });
    app.addFeedItem("coldRewrite", { sessionId: "s1", costUsd: 0.709, gapSeconds: 3900 });
    const text = document.getElementById("feed").textContent;
    expect(text).toContain("re-writes 177k tok");
    expect(text).toContain("cold re-write of 177k tok after 65 min idle");
    expect(text).not.toContain("$");
  });
});
