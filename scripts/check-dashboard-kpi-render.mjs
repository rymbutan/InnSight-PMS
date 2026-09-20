// Rendered checks for the dashboard's KPI strip.
//
// Two reported defects, both geometry:
//
//   1. NOT RESPONSIVE. `.kpi-row` is `grid-auto-flow: column`, so the seven
//      tiles are forced onto ONE row at every width and the row scrolls
//      sideways. On a tablet that is a horizontal scrollbar under the headline
//      figures of the whole product.
//
//   2. CUT OFF BY BIG NUMBERS. `.kpi-num` is a fixed 30px and the tile floor is
//      158px. "₱132,140.80" at 30px bold is wider than the 126px of usable
//      space inside that floor, so the number already overflows — and room
//      revenue only grows.
//
// The harness renders the real markup with a realistic figure AND an order of
// magnitude more, because the second is the case the complaint is really about.
//
// Run: node scripts/check-dashboard-kpi-render.mjs

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
  console.log('[kpi] no Chrome found — skipping the rendered check.');
  console.log('[kpi] set CHROME_PATH to run it.');
  process.exit(0);
}

const CSS_TEXT = fs.readFileSync(CSS_PATH, 'utf8');

// The seven tiles the dashboard renders, in order. `big` is the same board a
// year later — the value that must still fit.
const TILES = [
  { cls: 'kpi-tile kpi-arrivals', num: '0', big: '0', label: 'Arrivals', icon: true },
  { cls: 'kpi-tile kpi-departures', num: '0', big: '0', label: 'Departures', icon: true },
  { cls: 'kpi-tile kpi-booked', num: '6', big: '128', label: 'Booked', pct: '3.13%' },
  { cls: 'kpi-tile', num: '52.7%', big: '100.0%', label: 'Occupancy' },
  { cls: 'kpi-tile', num: '₱41.29', big: '₱9,841.29', label: 'ADR' },
  { cls: 'kpi-tile', num: '₱22.02', big: '₱7,022.02', label: 'RevPAR' },
  { cls: 'kpi-tile', num: '₱132,140.80', big: '₱12,345,678.90', label: 'Room revenue' },
];

const row = (key) =>
  TILES.map(
    (t, i) =>
      `<div class="${t.cls}" data-i="${i}">` +
      `<div><div class="kpi-num">${t[key]}</div><div class="kpi-label">${t.label}</div></div>` +
      (t.pct ? `<span class="kpi-pct">${t.pct}</span>` : '') +
      (t.icon ? '<div class="kpi-icon"><svg width="26" height="26"></svg></div>' : '') +
      `</div>`
  ).join('');

const PAGE = `<!doctype html>
<meta charset="utf-8"><title>pending</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CSS_TEXT}</style>
<body>
<!-- .cb-main is the real page container; the sidebar rail takes 264px of the
     viewport on desktop, which is what makes the tiles narrower than the window
     suggests. -->
<div class="cb-main" style="max-width:none">
  <div class="kpi-row" id="rowNow">${row('num')}</div>
  <div class="kpi-row" id="rowBig">${row('big')}</div>
</div>
<script>
const out = [];
const VW = window.innerWidth;
const ok = (n, c, d) => out.push((c ? 'PASS' : 'FAIL') + ' :: [' + VW + 'px] ' + n + (d ? ' :: ' + d : ''));
const box = (el) => el.getBoundingClientRect();
const cs = (el) => getComputedStyle(el);

function auditRow(rowId, when) {
  const row = document.getElementById(rowId);
  const tiles = [...row.querySelectorAll('.kpi-tile')];
  ok(when + ': all seven tiles render', tiles.length === 7, tiles.length + ' tiles');

  // THE defect: a number wider than the box it sits in.
  const clipped = [];
  for (const t of tiles) {
    const num = t.querySelector('.kpi-num');
    // scrollWidth > clientWidth means the text does not fit its own element;
    // comparing against the TILE catches a number escaping its padding too.
    const overflowsOwnBox = num.scrollWidth > num.clientWidth + 1;
    const escapesTile = box(num).right > box(t).right - 4;
    if (overflowsOwnBox || escapesTile) {
      clipped.push(num.textContent.trim() + ' in ' + Math.round(box(t).width) + 'px');
    }
  }
  ok(when + ': no figure is cut off by its tile', clipped.length === 0, clipped.join(' | ') || 'none');

  // Tiles must not overflow the page either.
  const spill = tiles.filter((t) => box(t).right > box(row).right + 1);
  ok(when + ': no tile spills out of the row', spill.length === 0, spill.length + ' spilling');

  // Every tile keeps a usable width — a 90px tile is not a KPI, it is a sliver.
  const narrow = tiles.filter((t) => box(t).width < 120);
  ok(when + ': every tile stays readable', narrow.length === 0,
     'narrowest ' + Math.round(Math.min(...tiles.map((t) => box(t).width))) + 'px');

  // Labels must not be clipped to nothing.
  const lostLabels = tiles.filter((t) => box(t.querySelector('.kpi-label')).height < 8);
  ok(when + ': every label is visible', lostLabels.length === 0, lostLabels.length + ' missing');

  return { row, tiles };
}

const now = auditRow('rowNow', 'current figures');
auditRow('rowBig', 'a year of growth');

// RESPONSIVENESS. On a narrow screen the strip must WRAP onto more rows rather
// than becoming a horizontal scroller under the product's headline numbers.
const rowsUsed = new Set(now.tiles.map((t) => Math.round(box(t).top)));
const scrolls = now.row.scrollWidth > now.row.clientWidth + 1;
if (VW >= 1400) {
  ok('desktop: the strip fits on one row', rowsUsed.size === 1, rowsUsed.size + ' rows');
  ok('desktop: no horizontal scrollbar', !scrolls, now.row.scrollWidth + ' in ' + now.row.clientWidth);
} else {
  ok('narrow: the strip wraps instead of scrolling sideways', rowsUsed.size > 1 && !scrolls,
     rowsUsed.size + ' rows, scrolls=' + scrolls);
}

document.title = out.some((l) => l.startsWith('FAIL')) ? 'RESULT-FAIL' : 'RESULT-PASS';
const pre = document.createElement('pre');
pre.id = 'results';
pre.textContent = out.join('\\n');
document.body.appendChild(pre);
</script>
</body>`;

// Desktop, laptop, iPad landscape, iPad portrait. The middle two are where the
// seven tiles stop fitting.
const VIEWPORTS = [
  { name: 'desktop', w: 1680, h: 950 },
  { name: 'laptop', w: 1366, h: 768 },
  { name: 'ipad-landscape', w: 1024, h: 768 },
  { name: 'ipad-portrait', w: 820, h: 1180 },
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innsight-kpi-'));
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
      console.error(`[kpi] ${vp.name}: the harness did not report.`);
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
    console.error(`\n[kpi] ${failures} of ${total} rendered check(s) failed.`);
    process.exit(1);
  }
  console.log(`\n[kpi] ${total} rendered checks passed.`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
