// Rendered geometry guard for the docked chat windows.
//
// This exists because the chat window's collapse button shipped broken, and
// nothing in the toolchain could have told us. The JSX said
// `hidden={minimized}`, the state flipped, the icon changed to "expand" — and
// the window stayed wide open, because `[hidden] { display: none }` lives in
// the USER-AGENT stylesheet and every author rule outranks the UA stylesheet
// however unspecific it is. `.chat-win-body { display: flex }` silently won.
//
// The build passed. ESLint passed. 298 unit tests passed. A static check that
// every CSS class exists passed. The bug was in the CASCADE, which none of
// those can see, and it only exists once a browser resolves the stylesheet
// against the DOM. So this drives a real browser: it builds the window's actual
// markup, applies web/src/styles.css, toggles the collapse, and reads the
// COMPUTED style and measured box back out.
//
// web/src/lib/stylesheetGuards.test.js asserts the rule that fixes it is still
// in the stylesheet and runs with the normal suite. This is the deeper check —
// it needs Chrome, so it is a script you run rather than part of `node --test`.
//
// Run: node scripts/check-chat-dock-render.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS_PATH = path.join(ROOT, 'web/src/styles.css');

// Chrome, wherever this is being run. Headless Chrome is the only dependency,
// and it is deliberately not an npm one: pulling Puppeteer in for one check
// would add ~200MB to a repo that installs no test framework at all.
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
  // Not a failure. A machine without Chrome cannot run this, and refusing to
  // proceed would make the script a blocker rather than a check.
  console.log('[chat-dock] no Chrome found — skipping the rendered check.');
  console.log('[chat-dock] set CHROME_PATH to run it.');
  process.exit(0);
}

// The window's real markup, as components/ChatDock.jsx renders it collapsed.
const PAGE = `<!doctype html>
<meta charset="utf-8"><title>pending</title>
<link rel="stylesheet" href="./styles.css">
<body>
<div class="chat-dock">
  <section class="chat-win is-min" id="w">
    <header class="chat-win-head">
      <button class="chat-win-title"><span class="chat-win-name">Monte Salvanera</span></button>
      <div class="chat-win-tools"><button class="chat-icon-btn">-</button></div>
    </header>
    <div class="chat-win-body" id="b" hidden>
      <div class="chat-scroll">
        <div class="chat-day"><span>Today</span></div>
        <div class="chat-group">
          <div class="chat-group-bubbles">
            <div class="chat-bubble"><span class="chat-bubble-body">Hihi</span></div>
            <div class="chat-bubble"><span class="chat-bubble-body">Chami</span></div>
            <div class="chat-bubble"><span class="chat-bubble-body">Tamis anghang</span></div>
            <span class="chat-group-time">10:04</span>
          </div>
        </div>
      </div>
      <form class="chat-composer"><textarea></textarea><button class="chat-send">s</button></form>
    </div>
  </section>
</div>
<script>
const out = [];
const ok = (n, c, d) => out.push((c ? 'PASS' : 'FAIL') + ' :: ' + n + (d ? ' :: ' + d : ''));
const cs = (el) => getComputedStyle(el);
const box = (el) => el.getBoundingClientRect();
const w = document.getElementById('w');
const b = document.getElementById('b');

// Collapsed.
ok('collapsed: body computes to display:none', cs(b).display === 'none', 'got ' + cs(b).display);
ok('collapsed: window is header-height only', box(w).height > 0 && box(w).height < 60, box(w).height.toFixed(1) + 'px');
ok('collapsed: window narrows so several bars fit', Math.round(box(w).width) < 280, Math.round(box(w).width) + 'px');

// Expanded.
b.hidden = false; w.classList.remove('is-min');
ok('expanded: body computes to display:flex', cs(b).display === 'flex', 'got ' + cs(b).display);
ok('expanded: window is tall enough to converse in', box(w).height > 300, box(w).height.toFixed(1) + 'px');

// Round trip - collapsing must not be a one-way door.
b.hidden = true; w.classList.add('is-min');
ok('re-collapsed: body hidden again', cs(b).display === 'none', 'got ' + cs(b).display);

// The transcript grouping, which is the other half of this redesign.
b.hidden = false; w.classList.remove('is-min');
const bb = [...document.querySelectorAll('.chat-bubble')];
const gap = box(bb[1]).top - box(bb[0]).bottom;
ok('turn: bubbles inside one turn stack tightly', gap >= 0 && gap <= 4, gap.toFixed(1) + 'px');
ok('turn: one timestamp is visible', box(document.querySelector('.chat-group-time')).height > 0);
ok('turn: inner corners tighten into the stack',
   cs(bb[0]).borderTopLeftRadius !== cs(bb[1]).borderTopLeftRadius,
   cs(bb[0]).borderTopLeftRadius + ' vs ' + cs(bb[1]).borderTopLeftRadius);
ok('turn: the day separator renders', box(document.querySelector('.chat-day')).height > 0);

document.title = out.some((l) => l.startsWith('FAIL')) ? 'RESULT-FAIL' : 'RESULT-PASS';
const pre = document.createElement('pre');
pre.id = 'results';
pre.textContent = out.join('\\n');
document.body.appendChild(pre);
</script>
</body>`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innsight-dock-'));
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
    console.error('[chat-dock] the harness did not report — Chrome rendered nothing usable.');
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
    console.error(`\n[chat-dock] ${failed.length} rendered check(s) failed.`);
    process.exit(1);
  }
  console.log(`\n[chat-dock] ${lines.length} rendered checks passed.`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
