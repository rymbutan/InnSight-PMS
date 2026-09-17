// Layout checks for the topbar action strip and the Messages thread header.
//
// Both were reported as looking disorganised after Messages moved out of the
// sidebar, and both defects are pure geometry — the kind nothing in the build
// can see. Specifically:
//
//   - The Messages button and the notification bell were wrapped in one <span>
//     for the tutorial tour, which made them a SINGLE flex item of .cb-actions.
//     The strip's 6px gap therefore applied around the pair but not between
//     them, so two icon buttons sat flush while every other pair was spaced.
//
//   - "Open in dock" was dropped into .msg-thread-head, a flex row with a 12px
//     gap and no spacer, so it sat jammed against the contact's name and role
//     instead of at the right edge where a header action belongs.
//
// Run: node scripts/check-topbar-dock-ui.mjs

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
  console.log('[topbar-ui] no Chrome found — skipping the rendered check.');
  console.log('[topbar-ui] set CHROME_PATH to run it.');
  process.exit(0);
}

const CSS_TEXT = fs.readFileSync(CSS_PATH, 'utf8');

// The topbar's action strip and the thread header, as Layout.jsx and
// Messages.jsx render them.
const PAGE = `<!doctype html>
<meta charset="utf-8"><title>pending</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CSS_TEXT}</style>
<body>
<header class="cb-topbar">
  <div style="flex:1"></div>
  <div class="cb-actions" id="actions">
    <div class="cb-greeting"><span class="greeting-name">Good morning, Andrea</span></div>
    <div class="cb-icon-wrap"><button class="cb-icon-btn cb-icon-create" id="create"><svg width="18" height="18"></svg></button></div>
    <div class="cb-util-group" id="utils">
      <button class="cb-icon-btn" id="theme"><svg width="18" height="18"></svg></button>
      <button class="cb-icon-btn" id="tour"><svg width="18" height="18"></svg></button>
      <button class="cb-icon-btn" id="cal"><svg width="18" height="18"></svg></button>
    </div>
    <div class="cb-comms" data-tour="tour-notifications" id="comms">
      <button class="cb-icon-btn cb-icon-messages" id="messages">
        <svg width="18" height="18"></svg><span class="notif-badge">3</span>
      </button>
      <div class="notif-wrap"><button class="cb-icon-btn notif-btn" id="bell"><svg width="18" height="18"></svg><span class="notif-badge">5</span></button></div>
    </div>
    <div class="cb-acct"><button class="cb-acct-trigger" id="acct"><span class="role-pill">ADMIN</span></button></div>
  </div>
</header>

<div style="width:760px">
  <header class="msg-thread-head" id="thead">
    <span class="msg-avatar">MS<span class="msg-dot is-online"></span></span>
    <div class="msg-thread-id">
      <div class="msg-thread-name">Marisol Santiago</div>
      <div class="msg-thread-sub"><span class="role-badge">Front desk</span><span class="msg-presence is-online">Online</span></div>
    </div>
    <button class="btn-ghost msg-dock-btn" id="dock"><svg width="14" height="14"></svg><span>Open in dock</span></button>
  </header>
</div>

<script>
const out = [];
const ok = (n, c, d) => out.push((c ? 'PASS' : 'FAIL') + ' :: ' + n + (d ? ' :: ' + d : ''));
const box = (el) => el.getBoundingClientRect();
const cs = (el) => getComputedStyle(el);
const gapBetween = (a, b) => box(b).left - box(a).right;

// ── Topbar: even rhythm ────────────────────────────────────────────────────
// The complaint is that the strip reads as unevenly spaced. Measure the real
// gaps between consecutive icon buttons and require them to be consistent.
const icons = ['create', 'theme', 'tour', 'cal', 'messages', 'bell'].map((id) => document.getElementById(id));
const gaps = [];
for (let i = 0; i < icons.length - 1; i += 1) gaps.push(Math.round(gapBetween(icons[i], icons[i + 1])));
ok('every topbar icon renders', icons.every((el) => el && box(el).width > 0), icons.length + ' buttons');

// Groups may be separated by MORE than the base gap on purpose; what must never
// happen is two buttons flush against each other while their neighbours are spaced.
const minGap = Math.min(...gaps);
// 4px is a real floor, not a round number: these buttons grow a filled
// background on hover, and below about 4px two adjacent hover states touch and
// read as a rendering fault instead of as grouping.
ok('no two topbar icons sit flush', minGap >= 4, 'gaps: ' + gaps.join(', ') + 'px');
ok('topbar gaps are deliberate, not random', new Set(gaps).size <= 3, new Set(gaps).size + ' distinct gaps: ' + gaps.join(','));

// Nothing may overlap, and the strip must stay on one line.
let overlap = 0;
for (let i = 0; i < icons.length - 1; i += 1) if (gapBetween(icons[i], icons[i + 1]) < 0) overlap += 1;
ok('no topbar icons overlap', overlap === 0, overlap + ' overlapping pairs');
const tops = icons.map((el) => Math.round(box(el).top));
ok('topbar icons share one baseline', new Set(tops).size === 1, 'tops: ' + [...new Set(tops)].join(','));

// The two badge-carrying controls belong together and should read as a pair:
// closer to each other than to the utility button before them.
const withinComms = Math.round(gapBetween(document.getElementById('messages'), document.getElementById('bell')));
const beforeComms = Math.round(gapBetween(document.getElementById('cal'), document.getElementById('messages')));
ok('messages and the bell read as one group', withinComms <= beforeComms,
   'within ' + withinComms + 'px vs before ' + beforeComms + 'px');

// ── Thread header: the action belongs at the right edge ─────────────────────
const head = document.getElementById('thead');
const dock = document.getElementById('dock');
const id = document.querySelector('.msg-thread-id');
ok('Open in dock renders', box(dock).width > 0 && box(dock).height > 0,
   Math.round(box(dock).width) + 'x' + Math.round(box(dock).height));
ok('Open in dock is pushed to the right edge',
   box(head).right - box(dock).right <= 20,
   Math.round(box(head).right - box(dock).right) + 'px from the edge');
ok('Open in dock is clear of the contact name',
   box(dock).left - box(id).right >= 12,
   Math.round(box(dock).left - box(id).right) + 'px clearance');
ok('Open in dock is a comfortable target', box(dock).height >= 28,
   Math.round(box(dock).height) + 'px tall');
ok('Open in dock keeps its label on one line', dock.scrollWidth <= dock.clientWidth + 1,
   dock.scrollWidth + ' vs ' + dock.clientWidth);
ok('Open in dock stays inside the header', box(dock).right <= box(head).right + 0.5);

document.title = out.some((l) => l.startsWith('FAIL')) ? 'RESULT-FAIL' : 'RESULT-PASS';
const pre = document.createElement('pre');
pre.id = 'results';
pre.textContent = out.join('\\n');
document.body.appendChild(pre);
</script>
</body>`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innsight-topbar-'));
try {
  const page = path.join(dir, 'index.html');
  fs.writeFileSync(page, PAGE, 'utf8');

  const dom = execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--window-size=1280,800',
      '--virtual-time-budget=4000',
      '--dump-dom',
      `file:///${page.replace(/\\/g, '/')}`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 90_000 }
  );

  const block = dom.match(/<pre id="results">([\s\S]*?)<\/pre>/);
  if (!block) {
    console.error('[topbar-ui] the harness did not report — Chrome rendered nothing usable.');
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
    console.error(`\n[topbar-ui] ${failed.length} rendered check(s) failed.`);
    process.exit(1);
  }
  console.log(`\n[topbar-ui] ${lines.length} rendered checks passed.`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
