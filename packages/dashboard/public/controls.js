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

export async function refreshControls() {
  try {
    const cfg = await fetch("/api/config").then((r) => r.json());
    window.cccConfig = cfg;
    const kw = document.getElementById("ctrl-keepwarm");
    const a1h = document.getElementById("ctrl-allow1h");
    const adv = document.getElementById("ctrl-advisor");
    const nam = document.getElementById("ctrl-naming");
    const grd = document.getElementById("ctrl-guardian");
    const snd = document.getElementById("ctrl-sound");
    const fls = document.getElementById("ctrl-flash");
    const cv = document.getElementById("ctrl-cardview");
    if (kw) kw.checked = !!(cfg.keepwarm && cfg.keepwarm.enabled);
    if (a1h) a1h.checked = !!(cfg.keepwarm && cfg.keepwarm.allow1hArm);
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
    const a1h = document.getElementById("ctrl-allow1h");
    const grd = document.getElementById("ctrl-guardian");
    const snd = document.getElementById("ctrl-sound");
    const fls = document.getElementById("ctrl-flash");
    const cv = document.getElementById("ctrl-cardview");
    if (a1h && cfg && cfg.keepwarm) a1h.checked = !!cfg.keepwarm.allow1hArm;
    if (grd && cfg && cfg.guardian) grd.value = cfg.guardian.action;
    if (snd && cfg && cfg.turnSignal) snd.checked = !!cfg.turnSignal.sound;
    if (fls && cfg && cfg.turnSignal) fls.checked = !!cfg.turnSignal.flash;
    if (cfg && cfg.dashboard && cfg.dashboard.cardView) {
      if (cv) cv.value = cfg.dashboard.cardView;
      applyCardView(cfg.dashboard.cardView);
      // Keep the fold state honest even when the daemon snapped the view back to advanced.
      setSectionsOpen(cfg.dashboard.cardView !== "simple", { keep: cv });
    }
    return cfg;
  } catch {
    /* daemon down; leave the control as-is */
  }
}

export function wireControls() {
  const kw = document.getElementById("ctrl-keepwarm");
  const a1h = document.getElementById("ctrl-allow1h");
  const adv = document.getElementById("ctrl-advisor");
  const nam = document.getElementById("ctrl-naming");
  const grd = document.getElementById("ctrl-guardian");
  const snd = document.getElementById("ctrl-sound");
  const fls = document.getElementById("ctrl-flash");
  const cv = document.getElementById("ctrl-cardview");
  if (kw) kw.onchange = () => postConfig({ keepwarm: { enabled: kw.checked } });
  if (a1h) a1h.onchange = () => postConfig({ keepwarm: { allow1hArm: a1h.checked } });
  if (adv) adv.onchange = () => postConfig({ advisor: { enabled: adv.checked } });
  if (nam) nam.onchange = () => postConfig({ naming: { enabled: nam.checked } });
  if (grd) grd.onchange = () => postConfig({ guardian: { action: grd.value } });
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
