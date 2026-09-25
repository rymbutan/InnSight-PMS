// Rendered checks for the dashboard's charts/insights block: the two-column
// "main content + right rail" section (Occupancy Trend + Revenue Trend,
// Bookings + Bookings by Source in the main column; Room Occupancy + Recent
// Activity in the aside), the day-over-day delta pill on the four
// audit-driven KPI tiles, and the density pass that stretches both columns
// to the same height and enlarges the charts so they actually fill their
// panels instead of leaving a dead gap on the trailing/bottom edge.
//
// Same pattern as check-dashboard-kpi-render.mjs: a green build says nothing
// about the CSS cascade or the geometry these nested `.row`/`.panel`
// combinations produce, so this renders the real markup in headless Chrome
// and reads back computed layout.
//
// Run: node scripts/check-dashboard-revenue-row-render.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS_PATH = process.env.DEPLOYED_CSS || path.join(ROOT, 'web/src/styles.css');

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

const chrome = CANDIDATES.find((p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
});

if (!chrome) {
  console.log('[revenue-row] no Chrome found — skipping the rendered check.');
  console.log('[revenue-row] set CHROME_PATH to run it.');
  process.exit(0);
}

const CSS_TEXT = fs.readFileSync(CSS_PATH, 'utf8');

// Stand-ins for SparkLine/BarChart/DonutChart's real SVG output
// (components/Chart.jsx) — enough markup to exercise the panel geometry
// around them, since the charts themselves are already exercised on the
// Revenue page. Sizes match the real call sites in pages/Dashboard.jsx.
const sparkSvg = (w, h) =>
  `<svg width="${w}" height="${h}" style="display:block"><polyline points="2,${h - 2} ${w - 2},2" fill="none" stroke="var(--accent)" stroke-width="2"/></svg>`;

const barSvg = (w, h) =>
  `<div class="chart-scroll"><svg width="${w}" height="${h + 24}" style="display:block">${Array.from(
    { length: 14 },
    (_, i) => `<rect x="${i * (w / 14) + 2}" y="${h - (i % 5) * 10 - 6}" width="${w / 14 - 4}" height="${(i % 5) * 10 + 6}" fill="var(--accent)"/>`
  ).join('')}</svg></div>`;

// Mirrors the real DonutChart component's markup after this pass: width:100%
// row, a relatively-positioned svg wrapper so a centerLabel can sit over it,
// and a legend that gets `flex: 1` instead of shrinking to its own text.
const donut = (segments, size, thickness, centerLabelHtml) => `
  <div style="display:flex;gap:16px;align-items:center;width:100%">
    <div style="position:relative;width:${size}px;height:${size}px;flex:0 0 auto">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle cx="${size / 2}" cy="${size / 2}" r="${(size - thickness) / 2}" fill="none" stroke="var(--neutral-soft)" stroke-width="${thickness}"/>
      </svg>
      ${
        centerLabelHtml
          ? `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;pointer-events:none">${centerLabelHtml}</div>`
          : ''
      }
    </div>
    <div style="font-size:12px;flex:1;min-width:0">
      ${segments
        .map(
          (s) =>
            `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">` +
            `<span style="width:10px;height:10px;border-radius:2px;background:${s.color};display:inline-block"></span>` +
            `<span>${s.label}</span><span class="muted" style="margin-left:auto">${s.value}</span></div>`
        )
        .join('')}
    </div>
  </div>`;

const ROOM_STATUS_SEGMENTS = [
  { label: 'Vacant Dirty', value: 4, color: '#dc2626' },
  { label: 'Vacant Clean', value: 12, color: '#16a34a' },
  { label: 'Vacant Clean Inspected', value: 20, color: '#2563eb' },
  { label: 'Occupied', value: 96, color: '#7c3aed' },
  { label: 'Out of Service', value: 2, color: '#ca8a04' },
];

const SOURCE_SEGMENTS = [
  { label: 'Direct', value: 40, color: 'var(--accent)' },
  { label: 'Walk-in', value: 12, color: '#06b6d4' },
  { label: 'Booking.com', value: 30, color: '#3b82f6' },
  { label: 'Airbnb', value: 8, color: '#ef4444' },
  { label: 'Expedia', value: 6, color: '#f59e0b' },
  { label: 'Agoda', value: 4, color: '#8b5cf6' },
  { label: 'Other OTA', value: 3, color: '#94a3b8' },
];

const ACTIVITY_EVENTS = [
  { tint: 'var(--accent-soft)', color: 'var(--accent)', icon: 'calendar', text: 'New booking — Juan Dela Cruz', at: 'just now' },
  { tint: '#ede9fe', color: '#7c3aed', icon: 'log-in', text: 'Checked in — Maria Santos', at: '12m ago' },
  { tint: '#fee2e2', color: '#dc2626', icon: 'x', text: 'Booking cancelled — Pedro Reyes', at: '1h ago' },
  { tint: 'var(--accent-soft)', color: 'var(--accent)', icon: 'calendar', text: 'New booking — Ana Lim', at: '3h ago' },
  { tint: '#ede9fe', color: '#7c3aed', icon: 'log-in', text: 'Checked in — Carlos Tan', at: '5h ago' },
  { tint: 'var(--accent-soft)', color: 'var(--accent)', icon: 'calendar', text: 'New booking — Rosa Cruz', at: '6h ago' },
];

const deltaPill = (value) => {
  const up = value >= 0;
  const color = up ? 'var(--text-success)' : 'var(--danger)';
  return `<span style="display:inline-flex;align-items:center;gap:2px;font-size:11px;font-weight:600;color:${color}">${up ? '\u2191' : '\u2193'} ${Math.abs(value).toFixed(1)}% <span class="muted" style="font-weight:400">vs prior day</span></span>`;
};

const activityRow = (e) => `
  <div style="display:flex;gap:10px;align-items:flex-start">
    <span style="display:flex;align-items:center;justify-content:center;width:28px;height:28px;flex:0 0 auto;border-radius:50%;background:${e.tint};color:${e.color}">
      <svg width="14" height="14"></svg>
    </span>
    <div style="min-width:0">
      <div style="font-size:13px">${e.text}</div>
      <div class="muted" style="font-size:11px">${e.at}</div>
    </div>
  </div>`;

// The four audit-driven KPI tiles, now with a delta pill under the label —
// same tile markup the KPI harness uses, plus the new pill.
const KPI_ROW = `
<div class="kpi-row" id="kpiRow">
  ${['Occupancy', 'ADR', 'RevPAR', 'Room revenue']
    .map(
      (label, i) => `
    <div class="kpi-tile" data-i="${i}">
      <div>
        <div class="kpi-num">${i === 0 ? '52.7%' : '\u20b19,841.29'}</div>
        <div class="kpi-label">${label}</div>
        ${deltaPill(i % 2 === 0 ? 3.4 : -1.8)}
      </div>
    </div>`
    )
    .join('')}
</div>`;

const MAIN_ASIDE_ROW = `
<div class="row" id="outerRow" style="align-items:stretch">
  <div id="mainCol" style="flex:3;min-width:480px;display:flex;flex-direction:column">
    <div class="row" id="chartsRow1" style="align-items:stretch;flex:1">
      <div class="panel" id="occPanel" style="flex:1;min-width:300px;display:flex;flex-direction:column">
        <h3 style="margin:0 0 8px">Occupancy Trend</h3>
        <div class="dash-chart" style="flex:1">${sparkSvg(420, 130)}</div>
        <div class="muted" style="font-size:12px">51.0% → 52.7%</div>
      </div>
      <div class="panel" id="revPanel" style="flex:1;min-width:300px;display:flex;flex-direction:column">
        <h3 style="margin:0 0 8px">Revenue Trend</h3>
        <div class="dash-chart" style="flex:1">${sparkSvg(420, 130)}</div>
        <div class="muted" style="font-size:12px">₱12,345.00 → ₱98,765.00</div>
      </div>
    </div>
    <div class="row" id="chartsRow2" style="align-items:stretch;flex:1">
      <div class="panel" id="bookingsPanel" style="flex:1.4;min-width:320px;display:flex;flex-direction:column">
        <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px">
          <h3 style="margin:0">Bookings</h3>
          <span class="muted" style="font-size:11px;text-transform:uppercase">42 in 14 days</span>
        </div>
        <div class="dash-chart" style="flex:1">${barSvg(440, 130)}</div>
      </div>
      <div class="panel" id="srcPanel" style="flex:1;min-width:260px;display:flex;flex-direction:column">
        <h3 style="margin:0 0 8px">Bookings by Source</h3>
        <div style="flex:1;display:flex;align-items:center">
          ${donut(SOURCE_SEGMENTS, 140, 20, '<div style="font-size:20px;font-weight:700">103</div><div class="muted" style="font-size:10px;text-transform:uppercase">Bookings</div>')}
        </div>
      </div>
    </div>
  </div>
  <div id="asideCol" style="flex:1;min-width:280px;display:flex;flex-direction:column">
    <div class="panel" id="roomOccPanel" style="flex:1;display:flex;flex-direction:column">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px">
        <h3 style="margin:0">Room Occupancy</h3>
        <span class="muted" style="font-size:11px;text-transform:uppercase">134 rooms</span>
      </div>
      <div style="flex:1;display:flex;align-items:center">
        ${donut(ROOM_STATUS_SEGMENTS, 132, 18, '<div style="font-size:20px;font-weight:700">96%</div><div class="muted" style="font-size:10px;text-transform:uppercase">Occupied</div>')}
      </div>
    </div>
    <div class="panel" id="activityPanel" style="flex:1">
      <h3 style="margin:0 0 8px">Recent Activity</h3>
      <div style="display:flex;flex-direction:column;gap:12px">
        ${ACTIVITY_EVENTS.map(activityRow).join('')}
      </div>
    </div>
  </div>
</div>`;

const PAGE = `<!doctype html>
<meta charset="utf-8"><title>pending</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CSS_TEXT}</style>
<body>
<div class="cb-main" style="max-width:none">
  ${KPI_ROW}
  ${MAIN_ASIDE_ROW}
</div>
<script>
const out = [];
const VW = window.innerWidth;
const ok = (n, c, d) => out.push((c ? 'PASS' : 'FAIL') + ' :: [' + VW + 'px] ' + n + (d ? ' :: ' + d : ''));
const box = (el) => el.getBoundingClientRect();

// ── KPI delta pills ──────────────────────────────────────────────────────
const tiles = [...document.querySelectorAll('#kpiRow .kpi-tile')];
ok('all four KPI tiles render', tiles.length === 4, tiles.length + ' tiles');
const pillless = tiles.filter((t) => box(t.querySelector('span')).height < 6);
ok('every KPI tile shows a visible delta pill', pillless.length === 0, pillless.length + ' missing');
const pillEscapes = tiles.filter((t) => box(t.querySelector('span')).right > box(t).right + 4);
ok('no delta pill escapes its tile', pillEscapes.length === 0, pillEscapes.length + ' escaping');

// ── Main + aside two-column shape, stretched to equal height ───────────
const outer = document.getElementById('outerRow');
const main = document.getElementById('mainCol');
const aside = document.getElementById('asideCol');
const spill = [main, aside].filter((p) => box(p).right > box(outer).right + 1);
ok('main and aside stay inside the outer row', spill.length === 0, spill.length + ' spilling');

if (VW >= 1200) {
  ok('wide: main sits left of aside on the same row', Math.round(box(main).top) === Math.round(box(aside).top),
     'main top ' + Math.round(box(main).top) + ', aside top ' + Math.round(box(aside).top));
  ok('wide: main column is wider than the aside', box(main).width > box(aside).width,
     Math.round(box(main).width) + ' vs ' + Math.round(box(aside).width));
  // THE fill check: with alignItems: stretch on the outer row, the two
  // columns must end at the same height — the taller one no longer leaves a
  // bare gap of page background beside the shorter one.
  const heightGap = Math.abs(box(main).height - box(aside).height);
  ok('wide: main and aside end at the same height (no dead gap beside either)', heightGap <= 2,
     Math.round(box(main).height) + 'px vs ' + Math.round(box(aside).height) + 'px');
} else {
  ok('narrow: aside wraps below main instead of overflowing', outer.scrollWidth <= outer.clientWidth + 1,
     outer.scrollWidth + ' vs ' + outer.clientWidth);
}

// ── Charts must actually fill their panel, not float in a corner of it ──
for (const id of ['occPanel', 'revPanel', 'bookingsPanel']) {
  const panel = document.getElementById(id);
  const svg = panel.querySelector('svg');
  const panelInnerW = box(panel).width - 36; // minus the panel's 18px+18px padding
  const svgW = Number(svg.getAttribute('width'));
  ok(id + ': chart uses most of its panel width (no big dead margin)', svgW >= panelInnerW * 0.55,
     svgW + 'px chart in ~' + Math.round(panelInnerW) + 'px available');
}

// Donut rows must stretch to the panel's full width (the width:100% / flex:1
// legend fix), not hug the left edge and leave the rest of the panel blank.
for (const id of ['srcPanel', 'roomOccPanel']) {
  const panel = document.getElementById(id);
  const donutRow = panel.querySelector('div[style*="width:100%"]');
  ok(id + ': donut row stretches to the panel width', box(donutRow).width >= box(panel).width - 40,
     Math.round(box(donutRow).width) + ' vs panel ' + Math.round(box(panel).width));
  const centerLabel = panel.querySelector('div[style*="pointer-events:none"]');
  ok(id + ': center label is visible over the ring', box(centerLabel).height > 8,
     Math.round(box(centerLabel).height) + 'px');
}

// Recent Activity rows must each be visible, not collapsed.
const activityPanel = document.getElementById('activityPanel');
const rows = [...activityPanel.querySelectorAll(':scope > div > div')];
const collapsedRows = rows.filter((r) => box(r).height < 20);
ok('every recent-activity row is visible', collapsedRows.length === 0, collapsedRows.length + ' collapsed');

document.title = out.some((l) => l.startsWith('FAIL')) ? 'RESULT-FAIL' : 'RESULT-PASS';
const pre = document.createElement('pre');
pre.id = 'results';
pre.textContent = out.join('\\n');
document.body.appendChild(pre);
</script>
</body>`;

const VIEWPORTS = [
  { name: 'desktop', w: 1680, h: 950 },
  { name: 'laptop', w: 1366, h: 768 },
  { name: 'ipad-landscape', w: 1024, h: 768 },
  { name: 'ipad-portrait', w: 820, h: 1180 },
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innsight-revenue-row-'));
let failures = 0;
let total = 0;
try {
  for (const vp of VIEWPORTS) {
    const page = path.join(dir, `${vp.name}.html`);
    fs.writeFileSync(page, PAGE, 'utf8');

    const dom = execFileSync(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        `--window-size=${vp.w},${vp.h}`,
        '--virtual-time-budget=4000',
        '--dump-dom',
        `file:///${page.replace(/\\/g, '/')}`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 90_000 }
    );

    const block = dom.match(/<pre id="results">([\s\S]*?)<\/pre>/);
    if (!block) {
      console.error(`[revenue-row] ${vp.name}: the harness did not report.`);
      process.exit(1);
    }
    const lines = block[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    console.log(`-- ${vp.name} --`);
    for (const l of lines) console.log(`  ${l}`);
    total += lines.length;
    failures += lines.filter((l) => l.startsWith('FAIL')).length;
  }

  if (failures) {
    console.error(`\n[revenue-row] ${failures} of ${total} rendered check(s) failed.`);
    process.exit(1);
  }
  console.log(`\n[revenue-row] ${total} rendered checks passed.`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
