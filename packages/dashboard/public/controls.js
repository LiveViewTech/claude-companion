/* Feature toggles — read /api/config, write /config. The daemon applies changes live
   (no restart) and persists them to config.json. Split out of app.js as an ES module so
   the DOM wiring can be driven under a test without app.js's SSE/timer side effects. */
"use strict";

export async function refreshControls() {
  try {
    const cfg = await fetch("/api/config").then((r) => r.json());
    const kw = document.getElementById("ctrl-keepwarm");
    const adv = document.getElementById("ctrl-advisor");
    const nam = document.getElementById("ctrl-naming");
    const grd = document.getElementById("ctrl-guardian");
    const snd = document.getElementById("ctrl-sound");
    const fls = document.getElementById("ctrl-flash");
    if (kw) kw.checked = !!(cfg.keepwarm && cfg.keepwarm.enabled);
    if (adv) adv.checked = !!(cfg.advisor && cfg.advisor.enabled);
    if (nam) nam.checked = !!(cfg.naming && cfg.naming.enabled);
    if (grd) grd.value = (cfg.guardian && cfg.guardian.action) || "off";
    if (snd) snd.checked = !!(cfg.turnSignal && cfg.turnSignal.sound);
    if (fls) fls.checked = !!(cfg.turnSignal && cfg.turnSignal.flash);
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
    const grd = document.getElementById("ctrl-guardian");
    const snd = document.getElementById("ctrl-sound");
    const fls = document.getElementById("ctrl-flash");
    if (grd && cfg && cfg.guardian) grd.value = cfg.guardian.action;
    if (snd && cfg && cfg.turnSignal) snd.checked = !!cfg.turnSignal.sound;
    if (fls && cfg && cfg.turnSignal) fls.checked = !!cfg.turnSignal.flash;
    return cfg;
  } catch {
    /* daemon down; leave the control as-is */
  }
}

export function wireControls() {
  const kw = document.getElementById("ctrl-keepwarm");
  const adv = document.getElementById("ctrl-advisor");
  const nam = document.getElementById("ctrl-naming");
  const grd = document.getElementById("ctrl-guardian");
  const snd = document.getElementById("ctrl-sound");
  const fls = document.getElementById("ctrl-flash");
  if (kw) kw.onchange = () => postConfig({ keepwarm: { enabled: kw.checked } });
  if (adv) adv.onchange = () => postConfig({ advisor: { enabled: adv.checked } });
  if (nam) nam.onchange = () => postConfig({ naming: { enabled: nam.checked } });
  if (grd) grd.onchange = () => postConfig({ guardian: { action: grd.value } });
  if (snd) snd.onchange = () => postConfig({ turnSignal: { sound: snd.checked } });
  if (fls) fls.onchange = () => postConfig({ turnSignal: { flash: fls.checked } });
}

export function initControls() {
  wireControls();
  refreshControls();
}
