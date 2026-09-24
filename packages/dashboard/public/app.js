/* Claude Companion dashboard — vanilla JS, SSE-driven, client-side ticking. */
"use strict";

const sessionsEl = document.getElementById("sessions");
const feedEl = document.getElementById("feed");
const dayCostEl = document.getElementById("day-cost");
const dayNoteEl = document.getElementById("day-note");
const monthCostEl = document.getElementById("month-cost");
const monthNoteEl = document.getElementById("month-note");
const budgetBarEl = document.getElementById("budget-bar");
const budgetFillEl = document.getElementById("budget-fill");
const activeEl = document.getElementById("active-count");
const daemonEl = document.getElementById("daemon-status");
const tpl = document.getElementById("card-tpl");

/** Flat-fee plan (Pro/Max/Team, or `billing: "flat"`): no dollar figures anywhere on the page. */
let flatPlan = false;

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
    const { sessions: list, plan } = JSON.parse(e.data);
    // The habits table loaded before this told us the plan; redo it if the plan differs.
    if (setPlan(plan)) refreshAnalytics();
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

/** Apply the daemon's plan. The CSS swaps the tiles and card rows; returns true when it changed. */
function setPlan(plan) {
  const flat = !!(plan && plan.flat);
  document.body.classList.toggle("plan-flat", flat);
  if (flat === flatPlan) return false;
  flatPlan = flat;
  return true;
}

async function refreshDayCost() {
  try {
    const r = await fetch("/api/day");
    const day = await r.json();
    // Card text and the habits table differ by plan too, not just what CSS hides.
    if (setPlan(day.plan)) {
      renderAll();
      refreshAnalytics();
    }
    renderLimits(day.limits);
    renderDay(day);
    const { monthCostUsd, monthlyBudgetUsd, account, meterStale } = day;
    const acct = account && account.usage;
    if (acct && typeof acct.usedUsd === "number") {
      // Anthropic's own meter (the claude.ai usage page number): account-wide and
      // billing-cycle-correct. When it's stale, say HOW stale — a bare "stale" read the
      // same at two minutes and at nineteen hours, which is how a frozen meter once went
      // a full day without anyone noticing.
      renderMonth(acct.usedUsd, acct.monthlyLimitUsd, meterStale ? `account · ${ageLabel(meterStale.ageMinutes)} old` : "account", !!meterStale);
      monthCostEl.title = meterStale
        ? `Frozen at the reading from ${new Date(meterStale.fetchedAt).toLocaleString()}` +
          (account.error ? ` — polling is failing (${account.error})` : "") +
          `. this device, calendar month (est.): ${usd(monthCostUsd)}`
        : `this device, calendar month (est.): ${usd(monthCostUsd)}`;
    } else if (typeof monthCostUsd === "number") {
      renderMonth(monthCostUsd, monthlyBudgetUsd, "est.", false);
      monthCostEl.title = "local transcript estimate — this device only";
    }
  } catch {
    /* daemon down; SSE reconnect will recover */
  }
}

/** Age a person can read at a glance: "45 min", "19h", "3d". */
function ageLabel(minutes) {
  if (minutes < 90) return `${minutes} min`;
  const hours = minutes / 60;
  return hours < 36 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
}

const AWAY_WORDS = { suspend: "asleep", "machine-off": "powered off", "daemon-down": "not being watched" };

/** Short "Wed 5:41 PM" for a baseline instant. */
function shortWhen(ms) {
  return new Date(ms).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/**
 * Today tile. The number is the account meter's movement since its baseline reading, and
 * the note says what that baseline is — a machine that sleeps through midnight has no
 * midnight reading, and the difference is worth seeing rather than hiding.
 */
function renderDay({ dayCostUsd, dayMeterUsd, dayBaseline, meterStale }) {
  const local = `this device (transcript est.): ${usd(dayCostUsd)}`;
  if (typeof dayMeterUsd !== "number") {
    // No usable meter delta. Show the local estimate and label it as one.
    dayCostEl.textContent = usd(dayCostUsd);
    setDayNote(
      meterStale ? `est. · meter ${ageLabel(meterStale.ageMinutes)} old` : "est.",
      meterStale
        ? `The account meter hasn't been read since ${new Date(meterStale.fetchedAt).toLocaleString()}, so today can't be measured against it. ` +
            `Showing this machine's transcript estimate, which tracks Claude usage here only and runs 12-16% low. ${local}`
        : `Local transcript estimate, this machine only. The account meter takes over once it has a reading on both sides of midnight.`,
      !!meterStale,
    );
    return;
  }
  dayCostEl.textContent = usd(dayMeterUsd);
  const kind = dayBaseline && dayBaseline.kind;
  if (kind === "pre-away") {
    // Expected on a laptop: nothing read the meter overnight because the machine wasn't
    // running, so the last waking reading is the baseline. Say so and move on.
    const away = AWAY_WORDS[dayBaseline.awayReason] || "away";
    setDayNote(
      `since ${shortWhen(dayBaseline.at)}`,
      `Measured from the last meter reading before this machine was ${away}` +
        (dayBaseline.awayMinutes ? ` (${ageLabel(dayBaseline.awayMinutes)})` : "") +
        `, not from midnight — nothing was watching the meter overnight. Anything spent on another device during that window lands in this figure. ${local}`,
      false,
    );
    return;
  }
  if (kind === "stale") {
    setDayNote(
      `since ${shortWhen(dayBaseline.at)} ⚠`,
      `Meter polling stopped at ${new Date(dayBaseline.at).toLocaleString()} while this machine was up, so the baseline predates midnight and this figure covers more than today. ${local}`,
      true,
    );
    return;
  }
  setDayNote("", local, false);
}

/** Today's qualifier goes in the note; the dollar figure keeps its full size. */
function setDayNote(text, tip, warn) {
  dayNoteEl.textContent = text;
  dayNoteEl.classList.toggle("warn", !!warn);
  dayNoteEl.title = tip;
  dayCostEl.classList.remove("warn");
  dayCostEl.title = tip;
}

/** Short clock time for a reset: "3:20 PM" within a day, "Thu 9:59 PM" beyond. */
function resetWhen(ms) {
  const opts = ms - Date.now() < 86_400_000 ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" };
  return new Date(ms).toLocaleString([], opts);
}

/**
 * Flat-plan tiles: the 5-hour and weekly usage windows, from the freshest reading any
 * session has (statusline courier or account poll). A window whose reset time has passed
 * shows no number: the old percentage is gone and nothing has reported the new one yet.
 */
function renderLimits(limits) {
  const at = limits && limits.at;
  const one = (key, w, word) => {
    const valEl = document.getElementById(`limit-${key}`);
    const noteEl = document.getElementById(`limit-${key}-note`);
    const fillEl = document.getElementById(`limit-${key}-fill`);
    if (!valEl || !noteEl || !fillEl) return;
    if (!w) {
      valEl.textContent = "–";
      noteEl.textContent = "";
      fillEl.style.width = "0%";
      valEl.title = `No ${word} reading yet. Claude Code reports it to the statusline on each turn.`;
      return;
    }
    const src = at ? ` Last reading ${new Date(at).toLocaleString()}.` : "";
    if (w.resetsAt && w.resetsAt <= Date.now()) {
      valEl.textContent = "–";
      noteEl.textContent = `reset ${resetWhen(w.resetsAt)}`;
      fillEl.style.width = "0%";
      valEl.title = `The ${word} window reset at ${new Date(w.resetsAt).toLocaleString()} and nothing has reported it since.${src}`;
      return;
    }
    const pct = Math.round(w.pct);
    valEl.textContent = `${pct}%`;
    noteEl.textContent = w.resetsAt ? `resets ${resetWhen(w.resetsAt)}` : "";
    fillEl.style.width = `${Math.min(100, pct)}%`;
    // Same 80/90 thresholds as the statusline and the guardian; the % label carries it too.
    fillEl.style.background = pct >= 90 ? "var(--critical)" : pct >= 80 ? "var(--warn)" : "var(--good)";
    valEl.title = `${pct}% of the ${word} usage window, account-wide.${src}`;
  };
  one("5h", limits && limits.fiveHour, "5-hour");
  one("7d", limits && limits.sevenDay, "weekly");
}

/** Month tile: value, optional "/$cap" + budget bar, and a source note ("account" or "est."). */
function renderMonth(spentUsd, capUsd, note, warn) {
  monthNoteEl.classList.toggle("warn", !!warn);
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
  // Claude Code's own total, when a statusline render has couriered one, hangs off the
  // hover: two independently-derived numbers for the same session, so a gap between them
  // is the one thing that says either is wrong.
  const costEl = card.querySelector(".cost");
  costEl.textContent = usd(s.sessionCostUsd);
  const official = typeof s.officialCostUsd === "number" ? s.officialCostUsd : null;
  costEl.title =
    official === null
      ? ""
      : `Claude Code's own total: ${usd(official)} (ccc: ${usd(s.sessionCostUsd)}, ` +
        `difference ${usd(Math.abs(official - s.sessionCostUsd))})`;
  costEl.classList.toggle("drift", official !== null && Math.abs(official - s.sessionCostUsd) > Math.max(0.05, official * 0.1));

  // Flat plan: the context size itself, banded like the statusline's ctx figure.
  const ctxEl = card.querySelector(".ctx");
  const prefix = Number(s.prefixTokens || 0);
  ctxEl.textContent = prefix ? kTok(prefix) : "–";
  ctxEl.className = `ctx ${prefix >= 300_000 ? "ctx-red" : prefix >= 200_000 ? "ctx-yellow" : ""}`;

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
  const allow1h = !!(window.cccConfig && window.cccConfig.keepwarm && window.cccConfig.keepwarm.allow1hArm);
  kwInfo.textContent = kw.armed
    ? (flatPlan ? "" : `net ${kw.netSavedUsd >= 0 ? "+" : ""}${usd(Math.abs(kw.netSavedUsd))}`)
    : s.ttlTier === "1h" && !allow1h
      ? "1h TTL"
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
    const [habits, tools, audit] = await Promise.all([
      fetch("/api/habits").then((r) => r.json()),
      fetch("/api/tools").then((r) => r.json()),
      // 404s with {error} when auditing is off; renderAudit then hides the panel.
      fetch("/api/audit?days=14").then((r) => r.json()),
    ]);
    const cw = habits.coldRewritesWeek;
    document.getElementById("cold-week").textContent =
      cw && cw.count > 0
        ? `— cold re-writes this week: ${cw.count}${flatPlan ? "" : ` costing ${usd(cw.totalUsd)}`}`
        : "— no cold re-writes recorded this week";
    // Flat plan: drop the dollar column rather than show a figure nobody is billed.
    const realized = flatPlan ? [] : ["Realized $"];
    document.getElementById("habits").innerHTML = table(
      ["Project", "Gaps", ">5m", "<1h", "Expired", ...realized, "Recommendation"],
      habits.projects.map((p) => [
        esc(shortSlug(p.projectSlug)),
        String(p.gaps),
        `${p.pctOver5m}%`,
        `${p.pctUnder1h}%`,
        String(p.expired),
        ...(flatPlan ? [] : [usd(p.realizedRewriteUsd)]),
        `<span class="rec">${esc(p.recommendation)}</span>`,
      ]),
      flatPlan ? [1, 2, 3, 4] : [1, 2, 3, 4, 5],
    );
    document.getElementById("tools").innerHTML = table(
      ["Tool", "Calls", "Result chars", "Tokens (est)", "Tokens (exact subset)"],
      tools.leaderboard.map((t) => [esc(t.tool), String(t.calls), fmtN(t.chars), fmtN(Math.round(t.tokEst)), fmtN(t.tokExact)]),
      [1, 2, 3, 4],
    );
    renderAudit(audit);
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

/**
 * Cost-audit panel. The meter is the truth and ccc's per-turn math is a hypothesis, so
 * this shows how the hypothesis is holding up: one ratio per model against the baseline
 * that `ccc audit --accept` froze. The panel stays collapsed, so the summary line has to
 * carry the glance — and it turns amber only when a model has drifted off its baseline,
 * which is the sole part of this that is ever urgent.
 */
function renderAudit(a) {
  const wrap = document.getElementById("audit-wrap");
  if (!wrap) return;
  // Auditing off, or the daemon predates it: no panel rather than an empty one.
  if (!a || a.error || !a.attributed) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const note = document.getElementById("audit-note");
  const figs = document.getElementById("audit-figs");
  const foot = document.getElementById("audit-foot");
  const drifted = (a.findings || []).filter((f) => f.kind === "drift");

  if (!a.attributed.n) {
    note.textContent = "— no reconciled windows yet";
    note.classList.remove("warn");
    figs.innerHTML = "";
    document.getElementById("audit-models").innerHTML = "";
    foot.innerHTML =
      `<div>A window needs the account meter read at two moments that each follow a quiet stretch ` +
      `with no local turns, so continuous work produces none. <code>ccc audit --backfill</code> rebuilds ` +
      `past windows from meter samples already stored.</div>`;
    return;
  }

  if (drifted.length) {
    const d = a.drift.find((x) => x.model === drifted[0].subject) || a.drift[0];
    note.textContent = d ? `— ⚠ ${d.model} ${d.baseline.toFixed(3)}x → ${d.current.toFixed(3)}x (${signed(d.changePct)}%)` : "— ⚠ price drift";
    note.classList.add("warn");
  } else {
    note.textContent = `— ${a.attributed.ratio.toFixed(3)}x meter · ${a.attributed.n} windows · ${a.coverage.pct}% coverage`;
    note.classList.remove("warn");
  }

  const gap = a.shortfall;
  // shortfall.totalUsd is meter-minus-ccc (positive when ccc undercounts). Show it from
  // ccc's side, so the sign matches the row above it and `ccc audit`'s residual line.
  const cccVsMeter = -gap.totalUsd;
  figs.innerHTML =
    row("meter (authoritative)", usd(a.attributed.meterUsd), "") +
    row("ccc (local math)", usd(a.attributed.localUsd), "") +
    row(
      "gap",
      signedUsd(cccVsMeter),
      `= $${gap.perTurnUsd.toFixed(3)} per turn, or ${signed(gap.perLocalDollar * 100)}% on top of ccc's figure`,
      `Two ways of describing the same gap. Both fit the data so far, and they predict different ` +
        `things, so watch which one stays steady as more windows arrive. If the per-turn dollars hold ` +
        `steady, the gap is a charge per request: web search bills $10 per 1,000 searches. If the ` +
        `percentage holds steady, it is a multiplier on spend: fast mode bills Opus 5 at 2x, and ` +
        `US-pinned inference is 1.1x on everything. Neither is visible in the transcript, which is ` +
        `why this has to be inferred from the meter.`,
    );

  document.getElementById("audit-models").innerHTML = table(
    ["Model", "Ratio", "Baseline", "Drift", "Meter", "ccc", "Windows"],
    a.byModel.map((m) => {
      const d = a.drift.find((x) => x.model === m.model);
      return [
        esc(m.model),
        `${m.ratio.toFixed(3)}x${m.n < AUDIT_MIN_N ? '<span class="soft" title="Too few windows to trust yet.">*</span>' : ""}`,
        d ? `${d.baseline.toFixed(3)}x` : '<span class="soft">not set</span>',
        d ? `<span class="${Math.abs(d.changePct) >= 10 ? "warn" : ""}">${signed(d.changePct)}%</span>` : "–",
        usd(m.meterUsd),
        usd(m.localUsd),
        String(m.n),
      ];
    }),
    [1, 2, 3, 4, 5, 6],
  );

  const lines = [];
  lines.push(
    a.unattributed.n
      ? `<div>off-machine: <b>${usd(a.unattributed.meterUsd)}</b> moved the meter with no local turn across ` +
          `${a.unattributed.n} window(s) — the Claude app, claude.ai, or Claude Code on another machine. ` +
          `Excluded from the ratio above.</div>`
      : `<div>off-machine: none seen. Every window that moved the meter had local turns to account for it.</div>`,
  );
  if (a.unmetered.n) {
    lines.push(`<div>unmetered: ${usd(a.unmetered.localUsd)} of local turns with no meter movement (${a.unmetered.n} window(s)).</div>`);
  }
  for (const f of a.findings || []) {
    lines.push(`<div class="${f.severity === "warn" ? "warn" : ""}">${f.severity === "warn" ? "⚠ " : "· "}${esc(f.message)}</div>`);
  }
  if (a.byModel.some((m) => m.n < AUDIT_MIN_N)) {
    lines.push(
      `<div>* measured from fewer than ${AUDIT_MIN_N} windows, so treat that ratio as provisional. ` +
        `A baseline needs ${AUDIT_MIN_N}.</div>`,
    );
  }
  if (!a.drift.length) {
    lines.push(`<div>No baselines accepted yet. Run <code>ccc audit --accept</code> once the ratios look right, and drift from them becomes a warning.</div>`);
  }
  foot.innerHTML = lines.join("");
}

/** Windows a model needs before its ratio is worth acting on. Mirrors MIN_DRIFT_N in audit.ts. */
const AUDIT_MIN_N = 8;
const signed = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;
const signedUsd = (n) => `${n < 0 ? "-" : ""}${usd(Math.abs(n))}`;
function row(label, value, aside, tip) {
  const t = tip ? ` title="${esc(tip)}"` : "";
  return `<dt${t}>${label}</dt><dd${t}>${value}</dd><dd class="aside"${t}>${aside ? esc(aside) : ""}</dd>`;
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
  // Flat plan: a re-write is sized by the context it re-sends, not what it would cost.
  const ctx = s && s.prefixTokens ? kTok(s.prefixTokens) : "the whole context";
  const msg = flatPlan
    ? kind === "coldRewrite"
      ? `cold re-write of ${ctx} after ${Math.round(data.gapSeconds / 60)} min idle`
      : kind === "expiryWarning"
        ? `cache expires in ~60s — next prompt after expiry re-writes ${ctx}`
        : `cache expired — next prompt re-writes ${ctx}`
    : kind === "coldRewrite"
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
