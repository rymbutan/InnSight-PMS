// Rendered checks for three reported tablet/iPad layout defects.
//
//   1. HOTEL MAP. The status legend is a vertical column, which is right beside
//      the map and wrong once the layout stacks: full width, six statuses tall,
//      it pushed the room detail card below the fold. And in landscape a fixed
//      290px rail left the map under half the screen.
//
//   2. REVENUE CHARTS. BarChart drew into a fixed 420px SVG. Fourteen days of
//      data is 29px per bar against a ~25px date label, so the labels sat
//      shoulder to shoulder — the "crumpled" text under the chart.
//
//   3. ROOM TYPES & RATES. `.rooms-fixed` pins the page to the viewport height
//      and the rail was `overflow: visible`, so a property with more room types
//      than the layout was tightened for had them clipped off the bottom with
//      nothing on screen to say so.
//
// Each is geometry, so each is measured rather than eyeballed.
//
// Run: node scripts/check-tablet-map-charts-rooms.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS_PATH = path.join(ROOT, 'web/src/styles.css');

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
  console.log('[tablet-fixes] no Chrome found — skipping the rendered check.');
  console.log('[tablet-fixes] set CHROME_PATH to run it.');
  process.exit(0);
}

const CSS_TEXT = fs.readFileSync(CSS_PATH, 'utf8');

// The real six, copied from sim/statusMeta.js — codes AND labels, because
// "Vacant Clean Inspected" is half again as long as the others and is what
// actually decides whether the legend wraps cleanly or ragged.
const STATUSES = [
  ['VD', 'Vacant Dirty'],
  ['VC', 'Vacant Clean'],
  ['VCI', 'Vacant Clean Inspected'],
  ['OCC', 'Occupied'],
  ['OOS', 'Out of Service'],
  ['OOO', 'Out of Order'],
];

const legendItems = STATUSES.map(
  ([code, label]) =>
    `<span class="hk-legend-item"><span class="hk-legend-swatch"></span>` +
    `<span class="hk-legend-text"><strong>${code}</strong> ${label}</span>` +
    `<span class="muted">(7)</span></span>`
).join('');

// Fourteen day labels, as Revenue.jsx builds them, and the chart as Chart.jsx
// now draws it: width is a minimum and the wrapper scrolls.
const MIN_BAR_W = 34;
const N = 14;
const drawn = Math.max(420, N * MIN_BAR_W + 8);
const barW = (drawn - 8) / N;
const bars = Array.from(
  { length: N },
  (_, i) =>
    `<g class="chart-bar"><text x="${i * barW + barW / 2}" y="134" font-size="10" text-anchor="middle" fill="#888">09/${String((i % 28) + 1).padStart(2, '0')}</text></g>`
).join('');

const PAGE = `<!doctype html>
<meta charset="utf-8"><title>pending</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CSS_TEXT}</style>
<body>

<!-- 1. Hotel map -->
<div class="hk-layout" id="hklayout">
  <div class="panel hk-map-panel" id="mappanel">
    <div class="hk-map-scroll"><svg class="hk-map" width="900" height="420"></svg></div>
  </div>
  <div class="hk-side" id="hkside">
    <div class="panel hk-legend-panel">
      <h3>Legend</h3>
      <div class="hk-legend" id="legend">${legendItems}</div>
    </div>
    <div class="panel hk-detail" id="hkdetail"><h3>Room 412</h3></div>
  </div>
</div>

<!-- 2. Revenue chart, inside a panel the width of a half-row on tablet -->
<div class="row">
  <div class="panel" style="flex:1" id="chartpanel">
    <h3>ADR per day</h3>
    <div class="chart-scroll" id="chartscroll">
      <svg width="${drawn}" height="144" style="display:block" id="chartsvg">${bars}</svg>
    </div>
  </div>
</div>

<!-- 3. Room types rail, with more content than the frame -->
<div class="rooms-fixed" id="roomsfixed">
  <div class="rooms-grid">
    <div class="rooms-main"><div class="panel"><div class="rooms-table-scroll">rooms</div></div></div>
    <div class="rooms-aside" id="aside">
      <div class="panel"><h3>Promo codes</h3><div class="rt-list">${'<div class="rt-item"><div class="rt-head"><span class="rt-name">PROMO</span><span class="rt-rate">10% off</span></div><div class="rt-meta">A description line</div></div>'.repeat(4)}</div></div>
      <div class="panel"><h3>Room types &amp; rates</h3><div class="rt-list" id="rtlist">${'<div class="rt-item"><div class="rt-head"><span class="rt-name">DLX</span><span class="rt-rate">P3,500</span></div><div class="rt-meta">Deluxe room, sleeps 2</div></div>'.repeat(9)}</div></div>
    </div>
  </div>
</div>

<script>
const out = [];
const VW = window.innerWidth;
const ok = (n, c, d) => out.push((c ? 'PASS' : 'FAIL') + ' :: [' + VW + 'px] ' + n + (d ? ' :: ' + d : ''));
const box = (el) => el.getBoundingClientRect();
const cs = (el) => getComputedStyle(el);

// ── 1. Hotel map ───────────────────────────────────────────────────────────
const layout = document.getElementById('hklayout');
const mapPanel = document.getElementById('mappanel');
const side = document.getElementById('hkside');
const legend = document.getElementById('legend');
const stacked = cs(layout).flexDirection === 'column';

if (!stacked) {
  // Landscape: the map must get the lion's share of the row.
  const share = box(mapPanel).width / box(layout).width;
  ok('map takes most of the row beside the rail', share >= 0.62,
     Math.round(share * 100) + '% of ' + Math.round(box(layout).width) + 'px');
  ok('rail is no wider than it needs to be', box(side).width <= 292,
     Math.round(box(side).width) + 'px');
} else {
  // Stacked: the legend must be a wrapping ROW, not a tall column.
  ok('legend flows as a row when stacked', cs(legend).flexDirection === 'row', cs(legend).flexDirection);
  ok('legend wraps rather than overflowing', cs(legend).flexWrap === 'wrap', cs(legend).flexWrap);
  const items = [...legend.querySelectorAll('.hk-legend-item')];
  const rows = new Set(items.map((el) => Math.round(box(el).top)));
  ok('legend collapses to a few lines, not one per status', rows.size <= 3,
     rows.size + ' lines for ' + items.length + ' statuses');
  ok('legend is short enough to leave the detail card visible', box(legend).height <= 110,
     Math.round(box(legend).height) + 'px tall');
  ok('map still comes first when stacked', box(mapPanel).top < box(side).top);
}
// True at every width: nothing in the legend may spill out of the rail.
const spill = [...legend.querySelectorAll('.hk-legend-item')].filter((el) => box(el).right > box(side).right + 1);
ok('no legend item overflows the rail', spill.length === 0, spill.length + ' overflowing');

// ── 2. Revenue chart ───────────────────────────────────────────────────────
const svg = document.getElementById('chartsvg');
const scroll = document.getElementById('chartscroll');
const panel = document.getElementById('chartpanel');
const ticks = [...svg.querySelectorAll('text')];
ok('every date label is drawn', ticks.length === ${N}, ticks.length + ' labels');

// The actual complaint: labels touching each other.
let collisions = 0;
let tightest = Infinity;
for (let i = 0; i < ticks.length - 1; i += 1) {
  const gap = box(ticks[i + 1]).left - box(ticks[i]).right;
  tightest = Math.min(tightest, gap);
  if (gap < 2) collisions += 1;
}
ok('date labels never touch', collisions === 0,
   collisions + ' collisions, tightest gap ' + tightest.toFixed(1) + 'px');
ok('date labels keep a readable gap', tightest >= 4, tightest.toFixed(1) + 'px');

// And when they cannot fit, the chart scrolls instead of shrinking.
ok('chart scrolls rather than squeezing', cs(scroll).overflowX === 'auto', cs(scroll).overflowX);
ok('chart never stretches its panel', box(scroll).width <= box(panel).width + 1,
   Math.round(box(scroll).width) + ' vs panel ' + Math.round(box(panel).width));
ok('chart is actually scrollable when it overflows',
   scroll.scrollWidth <= scroll.clientWidth || cs(scroll).overflowX === 'auto',
   scroll.scrollWidth + ' content in ' + scroll.clientWidth + 'px');

// ── 3. Room types rail ─────────────────────────────────────────────────────
const aside = document.getElementById('aside');
const fixed = document.getElementById('roomsfixed');
if (cs(fixed).height !== 'auto' && VW >= 1100) {
  ok('rails that overflow can be scrolled', cs(aside).overflowY === 'auto', cs(aside).overflowY);
  const clipped = aside.scrollHeight > aside.clientHeight;
  ok('no room-type content is unreachable',
     !clipped || cs(aside).overflowY === 'auto',
     clipped ? 'content overflows and scrolls' : 'content fits');
  const last = document.querySelectorAll('#rtlist .rt-item');
  ok('the last room type exists in the DOM', last.length === 9, last.length + ' items');
} else {
  ok('rooms rail check skipped below the two-column breakpoint', true, 'stacked layout');
}

document.title = out.some((l) => l.startsWith('FAIL')) ? 'RESULT-FAIL' : 'RESULT-PASS';
const pre = document.createElement('pre');
pre.id = 'results';
pre.textContent = out.join('\\n');
document.body.appendChild(pre);
</script>
</body>`;

// iPad landscape, iPad portrait, and a desktop width where .rooms-fixed applies.
const VIEWPORTS = [
  { name: 'ipad-landscape', w: 1024, h: 768 },
  { name: 'ipad-portrait', w: 820, h: 1180 },
  { name: 'desktop', w: 1440, h: 900 },
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innsight-tablet-'));
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
      console.error(`[tablet-fixes] ${vp.name}: the harness did not report.`);
      process.exit(1);
    }
    const lines = block[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    for (const l of lines) console.log(`  ${l}`);
    total += lines.length;
    failures += lines.filter((l) => l.startsWith('FAIL')).length;
  }

  if (failures) {
    console.error(`\n[tablet-fixes] ${failures} of ${total} rendered check(s) failed.`);
    process.exit(1);
  }
  console.log(`\n[tablet-fixes] ${total} rendered checks passed.`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
