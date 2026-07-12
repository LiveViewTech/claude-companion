/* Claude Companion dashboard — vanilla JS, SSE-driven, client-side ticking. */
"use strict";

const sessionsEl = document.getElementById("sessions");
const feedEl = document.getElementById("feed");
const dayCostEl = document.getElementById("day-cost");
const monthCostEl = document.getElementById("month-cost");
const monthNoteEl = document.getElementById("month-note");
const budgetBarEl = document.getElementById("budget-bar");
const budgetFillEl = document.getElementById("budget-fill");
const activeEl = document.getElementById("active-count");
const daemonEl = document.getElementById("daemon-status");
const tpl = document.getElementById("card-tpl");

/** sessionId -> state (from daemon) */
const sessions = new Map();
/** sessionId -> card element */
const cards = new Map();

const RING_CIRC = 2 * Math.PI * 42; // r=42 in the SVG
const ACTIVE_WINDOW_MS = 6 * 3600_000; // hide sessions idle > 6h
const usd = (v) => (v >= 0.995 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`);
const kTok = (v) => (v >= 1000 ? `${Math.round(v / 1000)}k tok` : `${v} tok`);

function connect() {
  const es = new EventSource("/events");
  es.addEventListener("hello", (e) => {
    const { sessions: list } = JSON.parse(e.data);
    for (const s of list) sessions.set(s.sessionId, s);
    setDaemon(true);
    refreshDayCost();
    renderAll();
  });
  es.addEventListener("state", (e) => {
    const s = JSON.parse(e.data);
    sessions.set(s.sessionId, s);
    renderAll();
    refreshDayCost();
  });
  for (const kind of ["coldRewrite", "expiryWarning", "expired"]) {
    es.addEventListener(kind, (e) => addFeedItem(kind, JSON.parse(e.data)));
  }
  es.onerror = () => {
    setDaemon(false);
    es.close();
    setTimeout(connect, 3000);
  };
}

function setDaemon(ok) {
  daemonEl.innerHTML = ok
    ? '<span class="dot dot-good"></span>online'
    : '<span class="dot dot-bad"></span>offline';
}

async function refreshDayCost() {
  try {
    const r = await fetch("/api/day");
    const { dayCostUsd, monthCostUsd, monthlyBudgetUsd } = await r.json();
    dayCostEl.textContent = usd(dayCostUsd);
    if (typeof monthCostUsd === "number") {
      if (typeof monthlyBudgetUsd === "number" && monthlyBudgetUsd > 0) {
        const pct = Math.min(999, Math.round((monthCostUsd / monthlyBudgetUsd) * 100));
        monthCostEl.textContent = `${usd(monthCostUsd)} / ${usd(monthlyBudgetUsd)}`;
        monthNoteEl.textContent = `${pct}% · est.`;
        budgetBarEl.hidden = false;
        budgetFillEl.style.width = `${Math.min(100, pct)}%`;
        // Status backed by the % label, never color alone.
        budgetFillEl.style.background = pct >= 90 ? "var(--critical)" : pct >= 75 ? "var(--warn)" : "var(--good)";
      } else {
        monthCostEl.textContent = usd(monthCostUsd);
        monthNoteEl.textContent = "est.";
        budgetBarEl.hidden = true;
      }
    }
  } catch {
    /* daemon down; SSE reconnect will recover */
  }
}

function visibleSessions() {
  const now = Date.now();
  return [...sessions.values()]
    .filter((s) => s.lastTurnAt && now - s.lastTurnAt < ACTIVE_WINDOW_MS)
    .sort((a, b) => b.lastTurnAt - a.lastTurnAt);
}

function renderAll() {
  const list = visibleSessions();
  activeEl.textContent = String(list.length);
  const seen = new Set();
  for (const s of list) {
    seen.add(s.sessionId);
    let card = cards.get(s.sessionId);
    if (!card) {
      card = tpl.content.firstElementChild.cloneNode(true);
      cards.set(s.sessionId, card);
      sessionsEl.appendChild(card);
    }
    fillCard(card, s);
  }
  for (const [id, card] of cards) {
    if (!seen.has(id)) {
      card.remove();
      cards.delete(id);
    }
  }
  if (list.length === 0 && !sessionsEl.querySelector(".empty")) {
    sessionsEl.innerHTML = '<div class="empty">No recent sessions. Start Claude Code and this fills in live.</div>';
  } else if (list.length > 0) {
    const empty = sessionsEl.querySelector(".empty");
    if (empty) empty.remove();
  }
}

function fillCard(card, s) {
  card.querySelector(".proj").textContent = shortSlug(s.projectSlug);
  card.querySelector(".model").textContent = shortModel(s.model);
  card.querySelector(".turns").textContent = `${s.turns} turns`;
  const tier = card.querySelector(".tier");
  tier.textContent = s.ttlTier ? `${s.ttlTier} TTL` : "TTL ?";
  tier.className = `badge tier ${s.ttlTier ? `tier-${s.ttlTier}` : ""}`;
  card.querySelector(".cost").textContent = usd(s.sessionCostUsd);
  card.querySelector(".prefix").textContent = kTok(s.prefixTokens);
  card.querySelector(".rewrite").textContent = s.rewriteCostUsd ? usd(s.rewriteCostUsd) : "–";
  const sw = Object.entries(s.modelSwitchCostUsd || {})
    .map(([m, c]) => `${shortModel(m)} ${usd(c)}`)
    .slice(0, 2)
    .join(" · ");
  card.querySelector(".switch").textContent = sw || "–";
  card.dataset.expiresAt = s.expiresAt ?? "";
  card.dataset.ttlTier = s.ttlTier ?? "";

  // keep-warm toggle
  const kwBtn = card.querySelector(".kw-btn");
  const kwInfo = card.querySelector(".kw-info");
  const kw = s.keepwarm || {};
  kwBtn.textContent = kw.armed ? `armed ⚡${kw.pings}` : "arm";
  kwBtn.className = `kw-btn ${kw.armed ? "armed" : ""}`;
  kwInfo.textContent = kw.armed
    ? `net ${kw.netSavedUsd >= 0 ? "+" : ""}${usd(Math.abs(kw.netSavedUsd))}`
    : s.ttlTier === "1h"
      ? "1h TTL — not needed"
      : (kw.reason || "");
  kwBtn.onclick = async () => {
    try {
      const r = await fetch("/keepwarm/arm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: s.sessionId, armed: !kw.armed }),
      });
      const res = await r.json();
      if (res && res.reason && !res.armed) kwInfo.textContent = res.reason;
    } catch {
      /* daemon down */
    }
  };
  tick(card);
}

async function refreshAnalytics() {
  try {
    const [habits, tools, rtk] = await Promise.all([
      fetch("/api/habits").then((r) => r.json()),
      fetch("/api/tools").then((r) => r.json()),
      fetch("/api/rtk").then((r) => r.json()),
    ]);
    const cw = habits.coldRewritesWeek;
    document.getElementById("cold-week").textContent =
      cw && cw.count > 0 ? `— cold re-writes this week: ${cw.count} costing ${usd(cw.totalUsd)}` : "— no cold re-writes recorded this week";
    document.getElementById("habits").innerHTML = table(
      ["Project", "Gaps", ">5m", "<1h", "Expired", "Realized $", "Recommendation"],
      habits.projects.map((p) => [
        esc(shortSlug(p.projectSlug)),
        String(p.gaps),
        `${p.pctOver5m}%`,
        `${p.pctUnder1h}%`,
        String(p.expired),
        usd(p.realizedRewriteUsd),
        `<span class="rec">${esc(p.recommendation)}</span>`,
      ]),
      [1, 2, 3, 4, 5],
    );
    document.getElementById("tools").innerHTML = table(
      ["Tool", "Calls", "Result chars", "Tokens (est)", "Tokens (exact subset)"],
      tools.leaderboard.map((t) => [esc(t.tool), String(t.calls), fmtN(t.chars), fmtN(Math.round(t.tokEst)), fmtN(t.tokExact)]),
      [1, 2, 3, 4],
    );
    const vcls = { "rtk saves": "verdict-saves", "rtk adds overhead": "verdict-overhead", "no difference": "verdict-none", "insufficient data": "verdict-nodata" };
    document.getElementById("rtk").innerHTML = table(
      ["Command class", "n (plain/rtk)", "Median chars plain", "Median chars rtk", "Saved", "Verdict"],
      rtk.verdict.slice(0, 20).map((v) => [
        `<code>${esc(v.commandClass)}</code>`,
        `${v.plain ? v.plain.n : 0} / ${v.rtk ? v.rtk.n : 0}`,
        v.plain ? fmtN(v.plain.medianChars) : "–",
        v.rtk ? fmtN(v.rtk.medianChars) : "–",
        v.medianCharsSavedPct != null ? `${v.medianCharsSavedPct}%` : "–",
        `<span class="${vcls[v.verdict] || ""}">${esc(v.verdict)}</span>`,
      ]),
      [1, 2, 3, 4],
    );
  } catch {
    /* daemon down */
  }
}

function table(headers, rows, numCols = []) {
  const th = headers.map((h, i) => `<th class="${numCols.includes(i) ? "num" : ""}">${h}</th>`).join("");
  const trs = rows
    .map((r) => `<tr>${r.map((c, i) => `<td class="${numCols.includes(i) ? "num" : ""}">${c}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${trs || '<tr><td colspan="99" class="soft">no data yet</td></tr>'}</tbody></table>`;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmtN = (n) => Number(n).toLocaleString();

/** Update countdown ring + text from data-expires-at. Runs every second. */
function tick(card) {
  const fill = card.querySelector(".ring-fill");
  const text = card.querySelector(".countdown");
  const expiresAt = Number(card.dataset.expiresAt || 0);
  const ttlMs = card.dataset.ttlTier === "1h" ? 3600_000 : 300_000;
  if (!expiresAt) {
    text.textContent = "–:––";
    fill.style.strokeDashoffset = String(RING_CIRC);
    card.classList.add("stale");
    return;
  }
  const left = expiresAt - Date.now();
  if (left <= 0) {
    text.textContent = "expired";
    text.classList.add("expired");
    fill.style.strokeDashoffset = String(RING_CIRC);
    fill.style.stroke = "var(--critical)";
    card.classList.add("stale");
    return;
  }
  card.classList.remove("stale");
  text.classList.remove("expired");
  const frac = Math.min(1, left / ttlMs);
  fill.style.strokeDashoffset = String(RING_CIRC * (1 - frac));
  // Status encoding backed by the visible mm:ss label (never color alone).
  fill.style.stroke = left < 60_000 ? "var(--critical)" : left < ttlMs * 0.25 ? "var(--warn)" : "var(--good)";
  const m = Math.floor(left / 60000);
  const sec = Math.floor((left % 60000) / 1000);
  text.textContent = `${m}:${String(sec).padStart(2, "0")}`;
}

function addFeedItem(kind, data) {
  const li = document.createElement("li");
  li.className = `kind-${kind}`;
  const when = new Date().toLocaleTimeString();
  const s = sessions.get(data.sessionId);
  const proj = s ? shortSlug(s.projectSlug) : data.sessionId?.slice(0, 8) ?? "?";
  const msg =
    kind === "coldRewrite"
      ? `cold re-write cost ${usd(data.costUsd)} after ${Math.round(data.gapSeconds / 60)} min idle`
      : kind === "expiryWarning"
        ? `cache expires in ~60s — next prompt after expiry re-writes ${usd(data.rewriteCostUsd)}`
        : `cache expired — cold re-write ${usd(data.rewriteCostUsd)} on next prompt`;
  li.innerHTML = `<span class="when">${when}</span>${proj}: ${msg}`;
  feedEl.prepend(li);
  while (feedEl.children.length > 50) feedEl.lastChild.remove();
}

function shortSlug(slug) {
  return (slug || "").replace(/^[Cc]--Users-[^-]+-/, "").replace(/-/g, "/") || slug;
}
function shortModel(m) {
  return (m || "?").replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

setInterval(() => {
  for (const card of cards.values()) tick(card);
}, 1000);

connect();
refreshAnalytics();
setInterval(refreshAnalytics, 60_000);
