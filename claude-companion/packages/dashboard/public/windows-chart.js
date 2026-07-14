/* Usage-window reset patterns: step chart of window utilization over time with
   observed reset markers, plus a table of reset advances (the prev→next delta is
   the window's real cadence — e.g. the undocumented ~72h "weekly" advance).
   Hidden unless the daemon says the data is informative (a window moved or reset);
   dollar-metered seats that report no windows keep the section invisible. */

const W = 860;
const H = 240;
const M = { top: 14, right: 130, bottom: 26, left: 36 };

/* Categorical slots (validated light+dark against the dashboard surfaces).
   Color follows the entity: fixed assignment by window name, never by rank. */
const SLOT_COLORS = {
  light: ["#2a78d6", "#1baf7a", "#eda100", "#008300"],
  dark: ["#3987e5", "#199e70", "#c98500", "#008300"],
};

function slotFor(name, allNames) {
  const fixed = { five_hour: 0, seven_day: 1 };
  if (name in fixed) return fixed[name];
  const others = allNames.filter((n) => !(n in fixed)).sort();
  return Math.min(2 + others.indexOf(name), SLOT_COLORS.light.length - 1);
}

function colorFor(name, allNames) {
  const dark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  return (dark ? SLOT_COLORS.dark : SLOT_COLORS.light)[slotFor(name, allNames)];
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmtDay = (ts) => new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
const fmtWhen = (ts) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Step value of a series at time t: last sample at or before t (null before first). */
function valueAt(points, t) {
  let v = null;
  for (const p of points) {
    if (p.ts > t) break;
    v = p.pct;
  }
  return v;
}

export function renderWindows(payload) {
  const wrap = document.getElementById("windows-wrap");
  const chartEl = document.getElementById("windows-chart");
  const resetsEl = document.getElementById("windows-resets");
  if (!wrap || !chartEl || !resetsEl) return;

  const series = (payload?.series ?? []).filter((s) => s.points.length > 0);
  if (!payload?.informative || series.length === 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  const names = series.map((s) => s.name);
  const now = Date.now();
  const from = Math.min(...series.map((s) => s.points[0].ts));
  const span = Math.max(now - from, 60_000);
  const x = (ts) => M.left + ((ts - from) / span) * (W - M.left - M.right);
  const y = (pct) => M.top + (1 - Math.min(pct, 100) / 100) * (H - M.top - M.bottom);

  let svg = "";

  // Recessive grid: y ticks every 25%, x ticks at local midnights.
  for (const pct of [0, 25, 50, 75, 100]) {
    svg += `<line x1="${M.left}" y1="${y(pct)}" x2="${W - M.right}" y2="${y(pct)}" class="win-grid"/>`;
    svg += `<text x="${M.left - 6}" y="${y(pct) + 4}" class="win-axis" text-anchor="end">${pct}%</text>`;
  }
  const firstMidnight = new Date(from);
  firstMidnight.setHours(24, 0, 0, 0);
  for (let d = firstMidnight.getTime(); d < now; d += 86_400_000) {
    svg += `<line x1="${x(d)}" y1="${M.top}" x2="${x(d)}" y2="${H - M.bottom}" class="win-grid"/>`;
    svg += `<text x="${x(d)}" y="${H - 8}" class="win-axis" text-anchor="middle">${esc(fmtDay(d))}</text>`;
  }

  // Reset markers: dashed vertical line + flag per observed advance, series-colored.
  for (const s of series) {
    const color = colorFor(s.name, names);
    for (const r of s.resets) {
      const gap = r.gapHours != null ? `advanced ${r.gapHours}h` : "advanced";
      svg += `<g class="win-reset"><title>${esc(s.name)} reset observed ${esc(fmtWhen(r.ts))} — window ${esc(gap)}</title>`;
      svg += `<line x1="${x(r.ts)}" y1="${M.top}" x2="${x(r.ts)}" y2="${H - M.bottom}" stroke="${color}" stroke-dasharray="3 4" stroke-width="1"/>`;
      svg += `<path d="M ${x(r.ts) - 4} ${M.top} h8 l-4 6 z" fill="${color}"/></g>`;
    }
  }

  // Step-after lines (utilization is sampled state), 2px, carried to "now".
  for (const s of series) {
    const color = colorFor(s.name, names);
    const pts = s.points;
    let d = `M ${x(pts[0].ts).toFixed(1)} ${y(pts[0].pct).toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) d += ` H ${x(pts[i].ts).toFixed(1)} V ${y(pts[i].pct).toFixed(1)}`;
    d += ` H ${x(now).toFixed(1)}`;
    svg += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;
    // Direct label at line end: swatch carries identity, text wears ink tokens.
    const last = pts[pts.length - 1];
    const ly = y(last.pct);
    svg += `<circle cx="${x(now)}" cy="${ly}" r="3" fill="${color}"/>`;
    svg += `<rect x="${W - M.right + 6}" y="${ly - 4}" width="8" height="8" rx="2" fill="${color}"/>`;
    svg += `<text x="${W - M.right + 18}" y="${ly + 4}" class="win-label">${esc(s.name)} ${Math.round(last.pct)}%</text>`;
  }

  // Hover layer: crosshair + tooltip.
  svg += `<line id="win-crosshair" x1="0" y1="${M.top}" x2="0" y2="${H - M.bottom}" class="win-crosshair" visibility="hidden"/>`;
  svg += `<rect id="win-overlay" x="${M.left}" y="${M.top}" width="${W - M.left - M.right}" height="${H - M.top - M.bottom}" fill="transparent"/>`;

  const legend =
    series.length >= 2
      ? `<div class="win-legend">${series
          .map((s) => `<span class="win-key"><span class="win-swatch" style="background:${colorFor(s.name, names)}"></span>${esc(s.name)}</span>`)
          .join("")}</div>`
      : "";

  chartEl.innerHTML = `${legend}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Usage-window utilization over time with observed resets">${svg}</svg><div id="win-tooltip" class="win-tooltip" hidden></div>`;

  wireHover(chartEl, series, { from, span, now });
  renderResetTable(resetsEl, series);
}

function wireHover(chartEl, series, geo) {
  const svgEl = chartEl.querySelector("svg");
  const overlay = chartEl.querySelector("#win-overlay");
  const crosshair = chartEl.querySelector("#win-crosshair");
  const tooltip = chartEl.querySelector("#win-tooltip");
  if (!svgEl || !overlay || !crosshair || !tooltip) return;

  overlay.addEventListener("mousemove", (ev) => {
    const rect = svgEl.getBoundingClientRect();
    const fx = ((ev.clientX - rect.left) / rect.width) * W; // px -> viewBox units
    const t = geo.from + ((fx - M.left) / (W - M.left - M.right)) * geo.span;
    crosshair.setAttribute("x1", fx);
    crosshair.setAttribute("x2", fx);
    crosshair.setAttribute("visibility", "visible");
    const rows = series
      .map((s) => ({ name: s.name, v: valueAt(s.points, t) }))
      .filter((r) => r.v != null)
      .map((r) => `${esc(r.name)} ${Math.round(r.v)}%`);
    tooltip.innerHTML = `<strong>${esc(fmtWhen(t))}</strong> · ${rows.join(" · ")}`;
    tooltip.hidden = rows.length === 0;
    tooltip.style.left = `${Math.min(ev.clientX - rect.left + 12, rect.width - 180)}px`;
  });
  overlay.addEventListener("mouseleave", () => {
    crosshair.setAttribute("visibility", "hidden");
    tooltip.hidden = true;
  });
}

/** Table view (also the accessibility fallback): every observed reset with its advance. */
function renderResetTable(el, series) {
  const rows = series
    .flatMap((s) => s.resets.map((r) => ({ name: s.name, ...r })))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 30);
  if (rows.length === 0) {
    el.innerHTML = `<p class="soft">No resets observed yet — the chart fills in as windows advance. The interesting number will be the "advanced by" column: ~72h advances on the weekly window would confirm the community finding.</p>`;
    return;
  }
  el.innerHTML = `<table><thead><tr><th>Window</th><th>Observed</th><th>Advanced by</th><th>New reset time</th></tr></thead><tbody>${rows
    .map(
      (r) =>
        `<tr><td>${esc(r.name)}</td><td>${esc(fmtWhen(r.ts))}</td><td>${r.gapHours != null ? `${r.gapHours}h` : "?"}</td><td>${esc(fmtWhen(Date.parse(r.next)))}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}

export async function refreshWindows(fetchFn = fetch) {
  try {
    const r = await fetchFn("/api/windows");
    renderWindows(await r.json());
  } catch {
    /* daemon down; next tick retries */
  }
}

export function initWindowsSection() {
  void refreshWindows();
  setInterval(() => void refreshWindows(), 60_000);
}
