// Rendered geometry guard for the Activity Log page.
//
// Same reasoning as scripts/check-chat-dock-render.mjs: a clean build, clean
// ESLint and a passing unit suite have twice shipped visibly broken UI in this
// repo, because the defects were in the cascade and in layout geometry and no
// build step can observe either. A new page composed of existing classes is
// exactly where that goes wrong quietly — a class that was only ever defined
// nested under some other component renders as nothing here, and the page still
// "builds".
//
// So this drives a real browser over the markup ActivityLog.jsx produces, applies
// web/src/styles.css, and measures. It also renders the `history` icon added to
// Icon.jsx for this page's sidebar entry, because Icon falls back to an EMPTY
// SPAN for an unknown name — a missing glyph is invisible rather than loud.
//
// Run: node scripts/check-activity-log-render.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS_PATH = path.join(ROOT, 'web/src/styles.css');
const ICON_PATH = path.join(ROOT, 'web/src/components/Icon.jsx');

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
  // Not a failure — a machine without Chrome cannot run this, and refusing to
  // proceed would make the script a blocker rather than a check.
  console.log('[activity-log] no Chrome found — skipping the rendered check.');
  console.log('[activity-log] set CHROME_PATH to run it.');
  process.exit(0);
}

// Pull the `history` icon's real paths out of Icon.jsx rather than pasting a
// copy here — a copy would keep passing after someone edited the component.
const iconSrc = fs.readFileSync(ICON_PATH, 'utf8');
const iconBlock = iconSrc.match(/\n {2}history: \(\s*<>([\s\S]*?)<\/>\s*\),/);
if (!iconBlock) {
  console.error('[activity-log] no `history` icon in Icon.jsx — the sidebar entry would render blank.');
  process.exit(1);
}
const iconPaths = iconBlock[1].replace(/\s+/g, ' ').trim();

// The markup ActivityLog.jsx renders, with FilterField expanded to the
// <div class="filter-field"><label>…</label>…</div> it actually emits.
const PAGE = `<!doctype html>
<meta charset="utf-8"><title>pending</title>
<link rel="stylesheet" href="./styles.css">
<body>
<div style="width:1200px">
  <div class="page-head">
    <h2 class="page-head-title">Activity Log</h2>
    <div class="muted">Every successful change made in the system, newest first.</div>
  </div>
  <div class="panel" id="panel">
    <div class="filter-grid" id="grid">
      <div class="filter-field"><label>From</label><input type="date"></div>
      <div class="filter-field"><label>To</label><input type="date"></div>
      <div class="filter-field"><label>User</label><select><option>Everyone</option></select></div>
      <div class="filter-field"><label>Area</label><select><option>All areas</option></select></div>
      <div class="filter-field"><label>Action</label><select><option>All actions</option></select></div>
      <div class="filter-field"><label>Search</label><input type="search" placeholder="name, path or record id"></div>
    </div>
    <div class="row" style="align-items:center;margin-bottom:12px">
      <div class="muted">1–50 of 4,812<span class="filter-count"> · 2 filter(s)</span></div>
      <div class="row-action">
        <button class="btn-ghost" id="clear">Clear filters</button>
        <button id="refresh">Refresh</button>
      </div>
    </div>
    <table id="table">
      <thead><tr><th>When</th><th>Who</th><th>Did what</th><th>Area</th><th>Record</th></tr></thead>
      <tbody>
        <tr id="row1">
          <td style="white-space:nowrap">17/09/2026, 09:14:22</td>
          <td><div>mramos</div><div class="muted" style="display:flex;gap:4px;flex-wrap:wrap"><span class="role-badge">Front desk</span></div></td>
          <td><div id="summary">mramos cancel reservation 3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b</div><div class="muted" style="font-size:0.85em">PATCH /api/reservations/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b/cancel</div></td>
          <td><span class="badge neutral" id="area">reservation</span></td>
          <td class="muted" id="record" style="font-size:0.85em;word-break:break-all">3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b</td>
        </tr>
      </tbody>
    </table>
  </div>
  <svg id="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${iconPaths}</svg>
</div>
<script>
const out = [];
const ok = (n, c, d) => out.push((c ? 'PASS' : 'FAIL') + ' :: ' + n + (d ? ' :: ' + d : ''));
const cs = (el) => getComputedStyle(el);
const box = (el) => el.getBoundingClientRect();

// The panel and table must actually occupy space. A class defined only as a
// descendant of some other component would leave these collapsed.
ok('panel renders with height', box(document.getElementById('panel')).height > 100,
   box(document.getElementById('panel')).height.toFixed(0) + 'px');
ok('table renders with height', box(document.getElementById('table')).height > 40,
   box(document.getElementById('table')).height.toFixed(0) + 'px');

// The filter row is a grid, and at 1200px it must lay the six fields out in
// columns rather than stacking them into a tall ladder.
const grid = document.getElementById('grid');
ok('filter row is a real grid', cs(grid).display === 'grid', 'got ' + cs(grid).display);
const cols = cs(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
ok('filters lay out in multiple columns at desktop width', cols >= 3, cols + ' columns');

// Every field's control must be visible and inside its track — the date inputs
// are the ones that historically overhang (see the comment in styles.css).
const fields = [...document.querySelectorAll('.filter-field')];
ok('all six filter fields render', fields.length === 6, fields.length + ' fields');
const overflowing = fields.filter((f) => {
  const c = f.querySelector('input,select');
  return box(c).width > box(f).width + 1;
});
ok('no filter control overhangs its column', overflowing.length === 0, overflowing.length + ' overhanging');
const invisible = fields.filter((f) => box(f.querySelector('input,select')).height < 10);
ok('every filter control is visible', invisible.length === 0, invisible.length + ' collapsed');

// The label sits ABOVE its control; if .filter-field lost its column direction
// they would sit side by side and the grid would blow out.
const f0 = fields[0];
ok('filter label sits above its control',
   box(f0.querySelector('label')).bottom <= box(f0.querySelector('input')).top + 1);

// The row strip puts its actions at the far right.
const strip = document.querySelector('.row-action');
ok('row actions render', box(strip).width > 0 && box(strip).height > 0);

// The badge and role capsule are borrowed from other pages — confirm they are
// not bare text here.
const area = document.getElementById('area');
ok('service badge has a background', cs(area).backgroundColor !== 'rgba(0, 0, 0, 0)', cs(area).backgroundColor);
ok('role capsule renders', box(document.querySelector('.role-badge')).height > 0);

// A long uuid in the Record column must wrap rather than widening the table past
// its container — word-break is doing real work here.
ok('table stays inside its container',
   box(document.getElementById('table')).width <= box(document.getElementById('panel')).width + 1,
   box(document.getElementById('table')).width.toFixed(0) + ' vs ' + box(document.getElementById('panel')).width.toFixed(0));

// The new sidebar glyph. Icon.jsx renders an EMPTY SPAN for an unknown name, so
// a missing icon is silent — measure that this one actually draws.
const icon = document.getElementById('icon');
ok('history icon has drawable geometry', icon.querySelectorAll('path').length >= 2,
   icon.querySelectorAll('path').length + ' paths');
const ib = icon.getBBox ? icon.getBBox() : { width: 0, height: 0 };
ok('history icon occupies its box', ib.width > 8 && ib.height > 8,
   ib.width.toFixed(1) + 'x' + ib.height.toFixed(1));

// Narrow viewport: the filter grid must reflow instead of forcing a horizontal
// scrollbar on the whole page.
document.querySelector('div[style*="1200px"]').style.width = '420px';
const colsNarrow = cs(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
ok('filters reflow at tablet width', colsNarrow < cols, colsNarrow + ' columns at 420px');

document.title = out.some((l) => l.startsWith('FAIL')) ? 'RESULT-FAIL' : 'RESULT-PASS';
const pre = document.createElement('pre');
pre.id = 'results';
pre.textContent = out.join('\\n');
document.body.appendChild(pre);
</script>
</body>`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innsight-activity-'));
try {
  fs.copyFileSync(CSS_PATH, path.join(dir, 'styles.css'));
  const page = path.join(dir, 'index.html');
  fs.writeFileSync(page, PAGE, 'utf8');

  const dom = execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--virtual-time-budget=4000',
      '--dump-dom',
      `file:///${page.replace(/\\/g, '/')}`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 90_000 }
  );

  const block = dom.match(/<pre id="results">([\s\S]*?)<\/pre>/);
  if (!block) {
    console.error('[activity-log] the harness did not report — Chrome rendered nothing usable.');
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
  const failed = lines.filter((l) => l.startsWith('FAIL'));
  if (failed.length) {
    console.error(`\n[activity-log] ${failed.length} rendered check(s) failed.`);
    process.exit(1);
  }
  console.log(`\n[activity-log] ${lines.length} rendered checks passed.`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
