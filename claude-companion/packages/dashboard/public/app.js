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

/** Accent palette: 8 clearly-distinct hues, hue-hopped so consecutively-assigned
    sessions look maximally different (only one blue, one cyan — kept far apart).
    Saturated enough to read on a dark theme without glowing. Repeats past 8 sessions. */
const SESSION_COLORS = [
  "#4f8fef", // blue
  "#e8863c", // orange
  "#57b368", // green
  "#e05c9e", // pink
  "#d9b13a", // gold
  "#9a6cf0", // purple
  "#e5544b", // red
  "#2fb8be", // cyan
];
/** sessionId -> palette index. Stable per session so its color survives re-sorts and re-renders. */
const sessionColorIdx = new Map();

/** sessionId -> lastTurnAt at the moment the user dismissed the card. The card stays hidden
    until a strictly newer turn arrives (then it un-dismisses itself). Persisted to localStorage
    so a dismiss survives reloads and the daemon re-sending every session on connect. */
const DISMISS_KEY = "ccc.dismissedSessions";
const dismissed = loadDismissed();

function loadDismissed() {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    return new Map(raw ? Object.entries(JSON.parse(raw)).map(([k, v]) => [k, Number(v)]) : []);
  } catch {
    return new Map();
  }
}
function saveDismissed() {
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify(Object.fromEntries(dismissed)));
  } catch {
    /* storage disabled/full — dismiss still works for this page load */
  }
}
function dismissSession(id, lastTurnAt) {
  dismissed.set(id, Number(lastTurnAt) || 0);
  saveDismissed();
  renderAll();
}

/** Assign (and remember) the least-used palette color among currently-visible sessions,
    so up to 8 live sessions stay distinguishable; ties break to the lowest index. */
function colorForSession(id, visibleIds) {
  let idx = sessionColorIdx.get(id);
  if (idx != null) return SESSION_COLORS[idx];
  const counts = new Array(SESSION_COLORS.length).fill(0);
  for (const vid of visibleIds) {
    const vi = sessionColorIdx.get(vid);
    if (vi != null) counts[vi]++;
  }
  idx = 0;
  for (let i = 1; i < counts.length; i++) if (counts[i] < counts[idx]) idx = i;
  sessionColorIdx.set(id, idx);
  return SESSION_COLORS[idx];
}

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
  es.addEventListener("turn", (e) => onTurn(JSON.parse(e.data)));
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
    const { dayCostUsd, monthCostUsd, monthlyBudgetUsd, account } = await r.json();
    dayCostEl.textContent = usd(dayCostUsd);
    const acct = account && account.usage;
    if (acct && typeof acct.usedUsd === "number") {
      // Anthropic's own meter (the claude.ai usage page number): account-wide,
      // billing-cycle-correct. The local estimate stays visible as a tooltip.
      renderMonth(acct.usedUsd, acct.monthlyLimitUsd, account.error ? "account · stale" : "account");
      monthCostEl.title = `this device, calendar month (est.): ${usd(monthCostUsd)}`;
    } else if (typeof monthCostUsd === "number") {
      renderMonth(monthCostUsd, monthlyBudgetUsd, "est.");
      monthCostEl.title = "local transcript estimate — this device only";
    }
  } catch {
    /* daemon down; SSE reconnect will recover */
  }
}

/** Month tile: value, optional "/$cap" + budget bar, and a source note ("account" or "est."). */
function renderMonth(spentUsd, capUsd, note) {
  if (typeof capUsd === "number" && capUsd > 0) {
    const pct = Math.min(999, Math.round((spentUsd / capUsd) * 100));
    monthCostEl.textContent = `${usd(spentUsd)} / ${usd(capUsd)}`;
    monthNoteEl.textContent = `${pct}% · ${note}`;
    budgetBarEl.hidden = false;
    budgetFillEl.style.width = `${Math.min(100, pct)}%`;
    // Status backed by the % label, never color alone.
    budgetFillEl.style.background = pct >= 90 ? "var(--critical)" : pct >= 75 ? "var(--warn)" : "var(--good)";
  } else {
    monthCostEl.textContent = usd(spentUsd);
    monthNoteEl.textContent = note;
    budgetBarEl.hidden = true;
  }
}

function visibleSessions() {
  const now = Date.now();
  let changed = false;
  const list = [];
  for (const s of sessions.values()) {
    const active = s.lastTurnAt && now - s.lastTurnAt < ACTIVE_WINDOW_MS;
    if (dismissed.has(s.sessionId)) {
      if (s.lastTurnAt && s.lastTurnAt > dismissed.get(s.sessionId)) {
        dismissed.delete(s.sessionId); // a newer turn arrived — bring the card back
        changed = true;
      } else {
        if (!active) { dismissed.delete(s.sessionId); changed = true; } // aged out; forget it to bound storage
        continue; // still dismissed, no new activity
      }
    }
    if (active) list.push(s);
  }
  if (changed) saveDismissed();
  return list.sort((a, b) => b.lastTurnAt - a.lastTurnAt);
}

function renderAll() {
  const list = visibleSessions();
  activeEl.textContent = String(list.length);
  const visibleIds = new Set(list.map((s) => s.sessionId));
  const seen = new Set();
  for (const s of list) {
    seen.add(s.sessionId);
    let card = cards.get(s.sessionId);
    if (!card) {
      card = tpl.content.firstElementChild.cloneNode(true);
      cards.set(s.sessionId, card);
    }
    fillCard(card, s);
    card.style.setProperty("--session-color", colorForSession(s.sessionId, visibleIds));
    // Re-append in sorted order: appendChild moves an existing node, so this keeps
    // the DOM ordered by lastTurnAt (newest first) even as sessions update live.
    sessionsEl.appendChild(card);
  }
  for (const [id, card] of cards) {
    if (!seen.has(id)) {
      card.remove();
      cards.delete(id);
      sessionColorIdx.delete(id); // free the color for reuse
    }
  }
  if (list.length === 0 && !sessionsEl.querySelector(".empty")) {
    sessionsEl.innerHTML = '<div class="empty">No recent sessions. Start Claude Code and this fills in live.</div>';
  } else if (list.length > 0) {
    const empty = sessionsEl.querySelector(".empty");
    if (empty) empty.remove();
  }
}

/** Render "model cost" pairs one per line (each nowrap in CSS) into el, or "–" when empty. */
function fillModelLines(el, entries) {
  el.textContent = "";
  if (!entries.length) {
    el.textContent = "–";
    return;
  }
  for (const [m, c] of entries) {
    const line = document.createElement("div");
    line.className = "carry-model-line";
    line.textContent = `${shortModel(m)} ${usd(c)}`;
    el.appendChild(line);
  }
}

function fillCard(card, s) {
  // Title = AI-generated session name when available (hover for the long description);
  // the project slug then moves down into the meta line.
  const projEl = card.querySelector(".proj");
  projEl.textContent = s.name || shortSlug(s.projectSlug);
  projEl.title = s.nameDescription || "";
  projEl.classList.toggle("named", !!s.name);
  card.querySelector(".slug").textContent = s.name ? `${shortSlug(s.projectSlug)} · ` : "";
  card.querySelector(".model").textContent = shortModel(s.model);
  card.querySelector(".turns").textContent = `${s.turns} turns`;
  const tier = card.querySelector(".tier");
  tier.textContent = s.ttlTier ? `${s.ttlTier} TTL` : "TTL ?";
  tier.className = `badge tier ${s.ttlTier ? `tier-${s.ttlTier}` : ""}`;
  card.querySelector(".cost").textContent = usd(s.sessionCostUsd);

  // "Start fresh?" indicator: what it costs to carry this context each turn.
  const tax = Number(s.prefixTaxUsd || 0);
  card.querySelector(".carry-model").textContent = s.model ? `(${prettyModel(s.model)})` : "";
  const carryEl = card.querySelector(".carry");
  carryEl.className = `carry ${carryClass(tax)}`;
  carryEl.querySelector(".carry-val").textContent = tax ? usd(tax) : "–";
  // Context prefix folded under the carry number — the context size behind that per-turn cost.
  card.querySelector(".prefix-sub").textContent = `(${kTok(s.prefixTokens)})`;
  const hint = card.querySelector(".carry-hint");
  // Ambient, not a directive — a fresh chat pays ~none of this per turn.
  hint.textContent = tax >= 0.1 ? `· fresh chat saves ~${usd(tax)}/turn` : "";
  const cur = normModel(s.model);
  fillModelLines(
    card.querySelector(".carry-models"),
    Object.entries(s.prefixTaxByModel || {}).filter(([m]) => m !== cur),
  );

  card.querySelector(".rewrite").textContent = s.rewriteCostUsd ? usd(s.rewriteCostUsd) : "–";
  fillModelLines(card.querySelector(".switch"), Object.entries(s.modelSwitchCostUsd || {}));
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

  // "×": hide this card. Returns automatically if the session gets a newer turn.
  const dismissBtn = card.querySelector(".dismiss-btn");
  if (dismissBtn) dismissBtn.onclick = () => dismissSession(s.sessionId, s.lastTurnAt);

  // "open": terminal window in the session's cwd running `claude --resume`.
  const openBtn = card.querySelector(".open-btn");
  openBtn.onclick = async () => {
    openBtn.disabled = true;
    let label = "opened ✓";
    try {
      const r = await fetch("/session/launch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: s.sessionId }),
      });
      const res = await r.json();
      if (!res || res.ok !== true) {
        label = "failed";
        openBtn.title = (res && res.error) || "launch failed";
      }
    } catch {
      label = "daemon down";
    }
    openBtn.textContent = label;
    setTimeout(() => {
      openBtn.textContent = "⧉ open";
      openBtn.disabled = false;
    }, 2500);
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
    renderRtkGain(rtk.gain);
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

/** rtk's OWN measured savings (ground truth). The transcript can't see
    hook-rewritten commands, so this bar is the real "is rtk working?" signal. */
function renderRtkGain(gain) {
  const el = document.getElementById("rtk-gain");
  if (!el) return;
  if (!gain || !gain.available || !gain.totalCommands) {
    const why = gain && gain.reason ? ` — ${esc(gain.reason)}` : "";
    el.innerHTML = `<span class="rtk-off">rtk not measured yet${why}.</span> <span class="soft">Once the rtk hook is active and has wrapped some commands, its savings show here.</span>`;
    return;
  }
  const pct = Math.max(0, Math.min(100, Math.round(gain.avgSavingsPct)));
  el.innerHTML =
    `<div class="rtk-line"><span class="rtk-ok">✓ rtk running</span>` +
    `<span class="rtk-stat"><b>${fmtN(gain.totalCommands)}</b> commands wrapped</span>` +
    `<span class="rtk-stat"><b>${kTok(gain.tokensSaved)}</b> saved</span>` +
    `<span class="rtk-stat"><b>${pct}%</b> avg</span></div>` +
    `<div class="rtk-bar"><div class="rtk-fill" style="width:${pct}%"></div></div>`;
}

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

/* "It's your turn" — flash the overlay for its duration and blink the tab title
   until the user looks (visibilitychange) or a timeout, so it works when hidden. */
const flashOverlay = document.getElementById("flash-overlay");
const BASE_TITLE = document.title;
let flashTimer = null;
let blinkTimer = null;
let blinkStopTimer = null;

function onTurn(data) {
  if (flashOverlay) {
    flashOverlay.style.setProperty("--flash-color", data.color || "#ffffff");
    flashOverlay.classList.add("on");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => flashOverlay.classList.remove("on"), Math.max(80, Number(data.ms) || 260));
  }
  blinkTitle(data.reason);
}

function blinkTitle(reason) {
  if (!document.hidden) return; // already looking — flash is enough
  const label = reason === "permission" ? "🔔 needs you" : reason === "question" ? "❓ your answer" : "✅ your turn";
  clearInterval(blinkTimer);
  clearTimeout(blinkStopTimer);
  let on = true;
  document.title = `${label} · ${BASE_TITLE}`;
  blinkTimer = setInterval(() => {
    document.title = on ? BASE_TITLE : `${label} · ${BASE_TITLE}`;
    on = !on;
  }, 800);
  blinkStopTimer = setTimeout(stopBlink, 30_000);
}

function stopBlink() {
  clearInterval(blinkTimer);
  clearTimeout(blinkStopTimer);
  blinkTimer = null;
  document.title = BASE_TITLE;
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) stopBlink();
});

function shortSlug(slug) {
  return (slug || "").replace(/^[Cc]--Users-[^-]+-/, "").replace(/-/g, "/") || slug;
}
function shortModel(m) {
  return (m || "?").replace(/^claude-/, "").replace(/-\d{8}$/, "");
}
/** "claude-opus-4-8-20250915" -> "opus 4.8"; "claude-fable-5" -> "fable 5". */
function prettyModel(m) {
  const parts = normModel(m).replace(/^claude-/, "").split("-").filter(Boolean);
  let i = parts.length;
  while (i > 0 && /^\d+$/.test(parts[i - 1])) i--;
  const name = parts.slice(0, i).join(" ");
  const ver = parts.slice(i).join(".");
  return (name + (ver ? ` ${ver}` : "")).trim() || shortModel(m);
}
function normModel(m) {
  return (m || "").replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "").toLowerCase();
}
/** Magnitude bucket for the per-turn carry cost (label carries the value; color is supplementary). */
function carryClass(v) {
  if (!v) return "";
  return v >= 0.3 ? "carry-red" : v >= 0.1 ? "carry-yellow" : "carry-green";
}

setInterval(() => {
  for (const card of cards.values()) tick(card);
}, 1000);

connect();
refreshAnalytics();
setInterval(refreshAnalytics, 60_000);
// Today/This-month tiles also refresh on every SSE `state` event, but poll on a timer too so
// they keep converging to the daemon's latest ingest even when all sessions are idle (no events).
// The daemon count trails claude.ai's live metering during active bursts and catches up at rest.
setInterval(refreshDayCost, 30_000);
