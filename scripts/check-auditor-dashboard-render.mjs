// Rendered checks for AuditorDashboard.jsx — the pure-auditor landing screen
// added alongside the manager/admin FrontOfficeDashboard. Same pattern as
// check-dashboard-kpi-render.mjs / check-dashboard-revenue-row-render.mjs: a
// green build says nothing about the CSS cascade or the geometry the
// left-column-of-three-panels + right-column-Folio-panel layout produces, so
// this renders the real markup in headless Chrome and reads back computed
// layout.
//
// Run: node scripts/check-auditor-dashboard-render.mjs

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
  console.log('[auditor-dash] no Chrome found — skipping the rendered check.');
  console.log('[auditor-dash] set CHROME_PATH to run it.');
  process.exit(0);
}

const CSS_TEXT = fs.readFileSync(CSS_PATH, 'utf8');

const SOURCE_SEGMENTS = [
  { label: 'Direct', value: 40, color: 'var(--accent)' },
  { label: 'Walk-in', value: 12, color: '#06b6d4' },
  { label: 'Booking.com', value: 30, color: '#3b82f6' },
  { label: 'Airbnb', value: 8, color: '#ef4444' },
];

// Mirrors components/Chart.jsx's DonutChart output after the density pass:
// width:100% row, a relatively-positioned svg wrapper for the centerLabel,
// legend with flex:1.
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

const metric = (label, value) => `<div class="metric"><div class="label">${label}</div><div class="value">${value}</div></div>`;

const FOLIO_ROWS = [
  { guest: 'Juan Dela Cruz', num: 'F-00021', status: 'open', approved: false },
  { guest: 'Maria Santos', num: 'F-00019', status: 'open', approved: true },
  { guest: 'Pedro Reyes', num: 'F-00015', status: 'closed', approved: true },
];

const PAGE_BODY = `
<div class="page-head">
  <div><h1>Auditor Dashboard</h1><div class="subtle">Last closed day: September 23, 2026</div></div>
</div>
<div class="row" id="outerRow" style="align-items:stretch">
  <div id="leftCol" style="flex:1;min-width:320px;display:flex;flex-direction:column">
    <div class="panel" id="channelsPanel" style="flex:1;display:flex;flex-direction:column">
      <h3 style="margin:0 0 8px">Booking Channels</h3>
      <div style="flex:1;display:flex;align-items:center">
        ${donut(SOURCE_SEGMENTS, 140, 20, '<div style="font-size:20px;font-weight:700">90</div><div class="muted" style="font-size:10px;text-transform:uppercase">Bookings</div>')}
      </div>
    </div>
    <div class="panel" id="addonPanel" style="flex:1;display:flex;flex-direction:column">
      <h3 style="margin:0 0 4px">Add-on Revenue</h3>
      <div style="font-size:26px;font-weight:700;color:var(--accent);margin-bottom:10px">₱42,300.00</div>
      <table><tbody><tr><td>Spa</td><td class="t-c">12</td><td class="t-n">₱18,000.00</td></tr></tbody></table>
    </div>
  </div>
  <div id="rightCol" style="flex:1;min-width:360px;display:flex;flex-direction:column">
    <div class="panel" id="summaryPanel">
      <h3 style="margin:0 0 8px">Day Summary</h3>
      <div class="metrics" id="grossRow" style="margin-bottom:12px">
        ${metric('Gross', '₱58,432.00')}${metric('VAT', '₱6,264.00')}${metric('Net', '₱52,168.00')}
      </div>
      <div class="metrics" id="roomRow">
        ${metric('Occupancy', '78.0%')}${metric('ADR', '₱2,340.00')}${metric('RevPAR', '₱1,825.20')}
      </div>
    </div>
    <div class="panel" id="folioPanel" style="flex:1;display:flex;flex-direction:column">
      <h3 style="margin:0 0 8px">Folio</h3>
      <div class="tabs-pill" style="margin-bottom:12px">
        <button class="active">Today</button><button>Week</button><button>Month</button>
      </div>
      <table>
        <thead><tr><th>Guest</th><th>Folio #</th><th class="t-c">Status</th><th class="t-c"></th></tr></thead>
        <tbody>
          ${FOLIO_ROWS.map(
            (r) => `<tr>
              <td class="table-link">${r.guest}</td><td>${r.num}</td>
              <td class="t-c"><span class="badge ${r.status}">${r.status === 'open' ? 'Open' : 'Closed'}</span>${r.approved ? '<svg width="13" height="13" style="margin-left:6px;vertical-align:middle"></svg>' : ''}</td>
              <td class="t-actions">${!r.approved && r.status === 'open' ? '<button class="icon" title="Approve for checkout"><svg width="14" height="14"></svg></button>' : ''}<button class="icon" title="Review"><svg width="14" height="14"></svg></button></td>
            </tr>`
          ).join('')}
        </tbody>
      </table>
    </div>
  </div>
</div>`;

const PAGE = `<!doctype html>
<meta charset="utf-8"><title>pending</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CSS_TEXT}</style>
<body>
<div class="cb-main" style="max-width:none">
  ${PAGE_BODY}
</div>
<script>
const out = [];
const VW = window.innerWidth;
const ok = (n, c, d) => out.push((c ? 'PASS' : 'FAIL') + ' :: [' + VW + 'px] ' + n + (d ? ' :: ' + d : ''));
const box = (el) => el.getBoundingClientRect();

const outer = document.getElementById('outerRow');
const left = document.getElementById('leftCol');
const right = document.getElementById('rightCol');
const spill = [left, right].filter((c) => box(c).right > box(outer).right + 1);
ok('left and right columns stay inside the outer row', spill.length === 0, spill.length + ' spilling');

if (VW >= 1200) {
  ok('wide: left column sits beside the right column', Math.round(box(left).top) === Math.round(box(right).top),
     'left top ' + Math.round(box(left).top) + ', right top ' + Math.round(box(right).top));
  const heightGap = Math.abs(box(left).height - box(right).height);
  ok('wide: left (3 stacked panels) and right (1 tall panel) end at the same height', heightGap <= 2,
     Math.round(box(left).height) + 'px vs ' + Math.round(box(right).height) + 'px');
} else {
  ok('narrow: right column wraps below left instead of overflowing', outer.scrollWidth <= outer.clientWidth + 1,
     outer.scrollWidth + ' vs ' + outer.clientWidth);
}

// Channel donut: legend fills the row, center label visible.
const channelsPanel = document.getElementById('channelsPanel');
const donutRow = channelsPanel.querySelector('div[style*="width:100%"]');
ok('channel donut row stretches to its panel width', box(donutRow).width >= box(channelsPanel).width - 40,
   Math.round(box(donutRow).width) + ' vs panel ' + Math.round(box(channelsPanel).width));
const centerLabel = channelsPanel.querySelector('div[style*="pointer-events:none"]');
ok('channel donut center label is visible', box(centerLabel).height > 8, Math.round(box(centerLabel).height) + 'px');

// Add-on revenue table renders with a real figure, not collapsed.
const addonPanel = document.getElementById('addonPanel');
const addonTotal = addonPanel.querySelector('div[style*="font-size:26px"]');
ok('add-on revenue total is visible', box(addonTotal).height > 10, Math.round(box(addonTotal).height) + 'px');

// Day Summary: Gross/VAT/Net and Occupancy/ADR/RevPAR, six metrics total, all
// visible and none collapsed onto each other.
const metrics = [...document.querySelectorAll('#grossRow .metric, #roomRow .metric')];
ok('all six day-summary metrics render', metrics.length === 6, metrics.length + ' metrics');
const collapsedMetrics = metrics.filter((m) => box(m).height < 20 || box(m.querySelector('.value')).width === 0);
ok('no day-summary metric is collapsed', collapsedMetrics.length === 0, collapsedMetrics.length + ' collapsed');

// Folio panel: tabs + rows with status badge and action icons.
const folioPanel = document.getElementById('folioPanel');
const rows = [...folioPanel.querySelectorAll('tbody tr')];
ok('all folio rows render', rows.length === 3, rows.length + ' rows');
const badgeless = rows.filter((r) => box(r.querySelector('.badge')).height < 6);
ok('every folio row shows a status badge', badgeless.length === 0, badgeless.length + ' missing');

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innsight-auditor-dash-'));
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
      console.error(`[auditor-dash] ${vp.name}: the harness did not report.`);
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
    console.error(`\n[auditor-dash] ${failures} of ${total} rendered check(s) failed.`);
    process.exit(1);
  }
  console.log(`\n[auditor-dash] ${total} rendered checks passed.`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
