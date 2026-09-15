/* Feature toggles — read /api/config, write /config. The daemon applies changes live
   (no restart) and persists them to config.json. Split out of app.js as an ES module so
   the DOM wiring can be driven under a test without app.js's SSE/timer side effects. */
"use strict";

/** Card density is pure CSS: `body.view-simple` collapses each card down to the three
    cost lines + the cache ring (see style.css). Anything but "simple" is the full card. */
export function applyCardView(view) {
  document.body.classList.toggle("view-simple", view === "simple");
}

/** Fold (or unfold) every section below the cards. Simple view starts them collapsed so the
    cards are the whole page; `keep` spares the section holding that element (the one the user
    is standing in), so switching to simple from Controls doesn't shut the panel under the cursor. */
export function setSectionsOpen(open, { keep = null } = {}) {
  for (const d of document.querySelectorAll("main details.collapsible")) {
    d.open = open || (keep != null && d.contains(keep));
  }
}

const $ = (id) => document.getElementById(id);

/**
 * Grey out controls that currently have no effect, so the panel can't imply a setting is
 * doing something it isn't. Two real dependency chains, both verified against the daemon:
 *
 *  - keepwarm.enabled gates ALL of gate() — it returns on the first line — so the per-tier
 *    arm flags, the ping cap AND the ping-cap escalation are dead when it's off. The
 *    escalation is the non-obvious one: it fires from inside gate()'s ping-cap branch.
 *  - guardian.action must be "wrapup"/"handoff" for any instruction to reach Claude
 *    (armHandoff refuses otherwise), which gates both handoff triggers.
 *
 * Account type is deliberately NOT gated: tierFor() also feeds the per-session break-even
 * and ping-cost readouts, which render whether or not keep-warm is armed.
 */
function setCtrlEnabled(el, on) {
  if (!el) return;
  el.disabled = !on;
  // The native disabled attribute dims the input but not the label text around it.
  if (el.parentElement) el.parentElement.classList.toggle("ctrl-off", !on);
}

function syncDependentControls(cfg) {
  const kwOn = !!(cfg && cfg.keepwarm && cfg.keepwarm.enabled);
  const action = (cfg && cfg.guardian && cfg.guardian.action) || "off";
  const guardianDelivers = action === "wrapup" || action === "handoff";
  setCtrlEnabled($("ctrl-arm-5m"), kwOn);
  setCtrlEnabled($("ctrl-arm-1h"), kwOn);
  setCtrlEnabled($("ctrl-cap-1h"), kwOn);
  // Needs both: the cap is only reached inside gate(), and delivery needs the guardian.
  setCtrlEnabled($("ctrl-escalate-1h"), kwOn && guardianDelivers);
  // Independent of keep-warm — this is the trigger that still works with it off.
  setCtrlEnabled($("ctrl-handoff-context"), guardianDelivers);
  // Only the handoff action writes a file, so the path means nothing on "wrapup".
  setCtrlEnabled($("ctrl-handoff-path"), action === "handoff");
}

/** Reflect the keep-warm per-tier block + the two handoff triggers into their controls. */
function syncKeepwarmControls(cfg) {
  const tiers = (cfg && cfg.keepwarm && cfg.keepwarm.tiers) || {};
  const acct = $("ctrl-account-type");
  const arm5 = $("ctrl-arm-5m");
  const arm1 = $("ctrl-arm-1h");
  const cap1 = $("ctrl-cap-1h");
  const esc1 = $("ctrl-escalate-1h");
  const hctx = $("ctrl-handoff-context");
  const hpath = $("ctrl-handoff-path");
  if (acct && cfg.keepwarm) acct.value = cfg.keepwarm.accountType || "auto";
  if (arm5) arm5.checked = !!(tiers["5m"] && tiers["5m"].arm);
  if (arm1) arm1.checked = !!(tiers["1h"] && tiers["1h"].arm);
  if (cap1 && tiers["1h"]) cap1.value = String(tiers["1h"].maxPingsPerIdle ?? "");
  if (esc1) esc1.checked = !!(tiers["1h"] && tiers["1h"].escalateToHandoff);
  // An empty box is the off state, matching `handoffAtContextTokens: null`.
  if (hctx && cfg.guardian) {
    const v = cfg.guardian.handoffAtContextTokens;
    hctx.value = v == null ? "" : String(v);
  }
  // Relative to each session's own cwd; the daemon resolves it before naming it to Claude.
  if (hpath && cfg.guardian) hpath.value = cfg.guardian.handoffPath || "";
  syncDependentControls(cfg);
}

export async function refreshControls() {
  try {
    const cfg = await fetch("/api/config").then((r) => r.json());
    window.cccConfig = cfg;
    const kw = $("ctrl-keepwarm");
    const adv = $("ctrl-advisor");
    const nam = $("ctrl-naming");
    const grd = $("ctrl-guardian");
    const snd = $("ctrl-sound");
    const fls = $("ctrl-flash");
    const cv = $("ctrl-cardview");
    if (kw) kw.checked = !!(cfg.keepwarm && cfg.keepwarm.enabled);
    syncKeepwarmControls(cfg);
    if (adv) adv.checked = !!(cfg.advisor && cfg.advisor.enabled);
    if (nam) nam.checked = !!(cfg.naming && cfg.naming.enabled);
    if (grd) grd.value = (cfg.guardian && cfg.guardian.action) || "off";
    if (snd) snd.checked = !!(cfg.turnSignal && cfg.turnSignal.sound);
    if (fls) fls.checked = !!(cfg.turnSignal && cfg.turnSignal.flash);
    const view = (cfg.dashboard && cfg.dashboard.cardView) || "advanced";
    if (cv) cv.value = view;
    applyCardView(view);
    // On load, simple means "just the cards" — every section below them starts folded.
    if (view === "simple") setSectionsOpen(false);
  } catch {
    /* daemon down; SSE reconnect + next load will recover */
  }
}

export async function postConfig(update) {
  try {
    const cfg = await fetch("/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    }).then((r) => r.json());
    // Re-sync from the daemon's authoritative echo (it may reject invalid values, or
    // silently no-op an update the running daemon's code doesn't know about yet).
    if (cfg && typeof cfg === "object") window.cccConfig = cfg;
    const grd = $("ctrl-guardian");
    const snd = $("ctrl-sound");
    const fls = $("ctrl-flash");
    const cv = $("ctrl-cardview");
    if (cfg && typeof cfg === "object") syncKeepwarmControls(cfg);
    if (grd && cfg && cfg.guardian) grd.value = cfg.guardian.action;
    if (snd && cfg && cfg.turnSignal) snd.checked = !!cfg.turnSignal.sound;
    if (fls && cfg && cfg.turnSignal) fls.checked = !!cfg.turnSignal.flash;
    if (cfg && cfg.dashboard && cfg.dashboard.cardView) {
      const view = cfg.dashboard.cardView;
      // Only touch the fold state when the view ACTUALLY changed. Every control posts through
      // here, and cardView is always present in the echo, so unconditionally calling
      // setSectionsOpen(true) re-expanded every section the user had collapsed on each
      // checkbox click. The fold is a side effect of switching view, not of saving config.
      const wasSimple = document.body.classList.contains("view-simple");
      if (cv) cv.value = view;
      applyCardView(view);
      if (wasSimple !== (view === "simple")) setSectionsOpen(view !== "simple", { keep: cv });
    }
    return cfg;
  } catch {
    /* daemon down; leave the control as-is */
  }
}

export function wireControls() {
  const kw = $("ctrl-keepwarm");
  const adv = $("ctrl-advisor");
  const nam = $("ctrl-naming");
  const grd = $("ctrl-guardian");
  const snd = $("ctrl-sound");
  const fls = $("ctrl-flash");
  const cv = $("ctrl-cardview");
  const acct = $("ctrl-account-type");
  const arm5 = $("ctrl-arm-5m");
  const arm1 = $("ctrl-arm-1h");
  const cap1 = $("ctrl-cap-1h");
  const esc1 = $("ctrl-escalate-1h");
  const hctx = $("ctrl-handoff-context");
  const hpath = $("ctrl-handoff-path");
  // Grey the dependent rows immediately rather than after the round-trip; postConfig
  // re-syncs from the daemon's echo either way, so a rejected change still snaps back.
  const optimistic = (patch) => {
    const cur = window.cccConfig || {};
    syncDependentControls({
      ...cur,
      keepwarm: { ...(cur.keepwarm || {}), ...(patch.keepwarm || {}) },
      guardian: { ...(cur.guardian || {}), ...(patch.guardian || {}) },
    });
  };
  if (kw)
    kw.onchange = () => {
      optimistic({ keepwarm: { enabled: kw.checked } });
      postConfig({ keepwarm: { enabled: kw.checked } });
    };
  if (acct) acct.onchange = () => postConfig({ keepwarm: { accountType: acct.value } });
  if (arm5) arm5.onchange = () => postConfig({ keepwarm: { tiers: { "5m": { arm: arm5.checked } } } });
  if (arm1) arm1.onchange = () => postConfig({ keepwarm: { tiers: { "1h": { arm: arm1.checked } } } });
  if (cap1) cap1.onchange = () => postConfig({ keepwarm: { tiers: { "1h": { maxPingsPerIdle: Number(cap1.value) } } } });
  if (esc1) esc1.onchange = () => postConfig({ keepwarm: { tiers: { "1h": { escalateToHandoff: esc1.checked } } } });
  // Blank means off; the daemon takes null for that and ignores non-positive numbers.
  if (hctx) hctx.onchange = () => postConfig({ guardian: { handoffAtContextTokens: hctx.value === "" ? null : Number(hctx.value) } });
  // Blank is not an off state here — the daemon substitutes the default, since an
  // instruction that names no file at all is worse than one naming the wrong file.
  if (hpath) hpath.onchange = () => postConfig({ guardian: { handoffPath: hpath.value } });
  if (adv) adv.onchange = () => postConfig({ advisor: { enabled: adv.checked } });
  if (nam) nam.onchange = () => postConfig({ naming: { enabled: nam.checked } });
  if (grd)
    grd.onchange = () => {
      optimistic({ guardian: { action: grd.value } });
      postConfig({ guardian: { action: grd.value } });
    };
  if (snd) snd.onchange = () => postConfig({ turnSignal: { sound: snd.checked } });
  if (fls) fls.onchange = () => postConfig({ turnSignal: { flash: fls.checked } });
  if (cv)
    cv.onchange = () => {
      // Apply locally first: this is a view preference, so it shouldn't wait on (or be
      // undone by) a round-trip. postConfig re-syncs from the daemon's echo either way.
      applyCardView(cv.value);
      setSectionsOpen(cv.value !== "simple", { keep: cv });
      postConfig({ dashboard: { cardView: cv.value } });
    };
}

export function initControls() {
  wireControls();
  refreshControls();
}
