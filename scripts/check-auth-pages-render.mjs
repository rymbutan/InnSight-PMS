// Rendered checks for the signed-out pages: Login, Forgot password, Reset password.
//
// WHY THIS EXISTS
// ---------------
// Reset password and Forgot password were built on `.login-wrap`, `.login-title`
// and `.login-sub`. Two of those three are not in the stylesheet at all — the
// heading and the body copy rendered as bare unstyled text, and the card sat in
// a frame with nothing beside it, while Login next door drew a full two-panel
// layout. Nothing caught it: the classes were valid strings, the build passed,
// every test passed, and the page "worked" in the sense that you could type in
// it.
//
// So this asserts the thing that actually went wrong — that every class these
// pages ask for exists and produces a styled box — rather than trusting that a
// class name in JSX means anything.
//
// Run: node scripts/check-auth-pages-render.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS_PATH = path.join(ROOT, 'web/src/styles.css');
const SRC = path.join(ROOT, 'web/src');

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

// ── Static half: every class these pages name must exist in the stylesheet ──
// This is the check that would have caught the original defect, and it needs no
// browser, so it runs before the Chrome guard and fails on its own.
const CSS_TEXT = fs.readFileSync(CSS_PATH, 'utf8');
const PAGES = [
  'components/AuthShell.jsx',
  'pages/ForgotPassword.jsx',
  'pages/ResetPassword.jsx',
  'pages/Login.jsx',
];

// Classes defined anywhere in the stylesheet, as bare names.
const DEFINED = new Set([...CSS_TEXT.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
// Utility classes that are applied by other means or are intentionally bare.
const IGNORE = new Set(['error']);

const undefinedClasses = [];
for (const rel of PAGES) {
  const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
  for (const m of src.matchAll(/className="([^"{}]+)"/g)) {
    for (const cls of m[1].trim().split(/\s+/)) {
      if (!cls || IGNORE.has(cls) || DEFINED.has(cls)) continue;
      undefinedClasses.push(`${rel}: .${cls}`);
    }
  }
}

if (undefinedClasses.length) {
  console.error('[auth-pages] classes used by the auth pages with no rule in styles.css:');
  for (const c of undefinedClasses) console.error(`  ${c}`);
  console.error('\n[auth-pages] these render unstyled — the exact defect this script exists for.');
  process.exit(1);
}
console.log(`  PASS :: every class on the auth pages is defined :: checked ${PAGES.length} files`);

if (!chrome) {
  console.log('[auth-pages] no Chrome found — static check passed, skipping the rendered half.');
  process.exit(0);
}

// ── Rendered half: the frame actually lays out ─────────────────────────────
const PAGE = `<!doctype html>
<meta charset="utf-8"><title>pending</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CSS_TEXT}</style>
<body>
<div class="login-shell" id="shell">
  <div class="login-panel" id="panel">
    <aside class="login-figure" id="figure">
      <div class="login-figure-scrim"></div>
      <div class="login-figure-body">
        <div class="login-eyebrow"><span class="login-eyebrow-rule"></span></div>
        <div class="login-figure-quote"><h2>Every Stay,<br>Perfectly Run</h2><p>A modern PMS.</p></div>
      </div>
    </aside>
    <div class="login-form-side" id="formside">
      <form class="login-card" id="card">
        <h1 id="title">Choose a new password</h1>
        <p class="login-lede" id="lede">At least 8 characters. This link works once.</p>
        <label class="login-label" for="pw">New password</label>
        <div class="login-input-wrap">
          <input id="pw" class="login-input" type="password">
          <button type="button" class="login-reveal" id="reveal">&#128065;</button>
        </div>
        <label class="login-label" for="cf">Confirm new password</label>
        <input id="cf" class="login-input" type="password">
        <button class="login-submit" id="submit">Set new password</button>
        <p class="login-alt" id="alt"><a href="#">Back to sign in</a></p>
      </form>
    </div>
  </div>
</div>
<script>
const out = [];
const VW = window.innerWidth;
const ok = (n, c, d) => out.push((c ? 'PASS' : 'FAIL') + ' :: [' + VW + 'px] ' + n + (d ? ' :: ' + d : ''));
const box = (el) => el.getBoundingClientRect();
const cs = (el) => getComputedStyle(el);

const panel = document.getElementById('panel');
const figure = document.getElementById('figure');
const card = document.getElementById('card');
const title = document.getElementById('title');
const lede = document.getElementById('lede');

ok('the card renders with real height', box(card).height > 200, Math.round(box(card).height) + 'px');

// The heading and lede are the two elements that were unstyled. A browser gives
// an <h1> a default size, so "is it styled" is tested as "does it differ from
// the UA default and match the Login page's treatment" — centred, and larger
// than body copy.
ok('heading is styled, not browser-default', cs(title).textAlign === 'center',
   'align=' + cs(title).textAlign + ' size=' + cs(title).fontSize);
ok('heading is the page heading size', parseFloat(cs(title).fontSize) >= 22, cs(title).fontSize);
ok('lede is styled as secondary copy', cs(lede).textAlign === 'center' && parseFloat(cs(lede).fontSize) <= 15,
   'align=' + cs(lede).textAlign + ' size=' + cs(lede).fontSize);

// Inputs must be full-width controls, not unstyled browser boxes.
const pw = document.getElementById('pw');
ok('inputs fill the card width', box(pw).width > box(card).width * 0.5,
   Math.round(box(pw).width) + ' of ' + Math.round(box(card).width));
ok('inputs are a comfortable height', box(pw).height >= 34, Math.round(box(pw).height) + 'px');

// The reveal toggle sits INSIDE its field rather than below it.
const reveal = document.getElementById('reveal');
ok('reveal toggle sits inside the password field',
   box(reveal).right <= box(pw).right + 1 && box(reveal).top >= box(pw).top - 1,
   'reveal right ' + Math.round(box(reveal).right) + ' vs field ' + Math.round(box(pw).right));

const submit = document.getElementById('submit');
ok('submit is a full-width primary button', box(submit).width > box(card).width * 0.5,
   Math.round(box(submit).width) + 'px');

// Two panels side by side on a wide screen; the photograph is half the point of
// the frame and was missing entirely from these pages.
if (VW >= 1000) {
  ok('the figure panel renders beside the form', box(figure).width > 200 && cs(figure).display !== 'none',
     Math.round(box(figure).width) + 'px');
  ok('figure and form are side by side', box(figure).right <= box(document.getElementById('formside')).left + 1);
} else {
  ok('narrow: the form is still usable', box(card).width > 240, Math.round(box(card).width) + 'px');
  ok('narrow: nothing overflows the viewport', box(panel).right <= VW + 1,
     Math.round(box(panel).right) + ' of ' + VW);
}

document.title = out.some((l) => l.startsWith('FAIL')) ? 'RESULT-FAIL' : 'RESULT-PASS';
const pre = document.createElement('pre');
pre.id = 'results';
pre.textContent = out.join('\\n');
document.body.appendChild(pre);
</script>
</body>`;

const VIEWPORTS = [
  { name: 'desktop', w: 1440, h: 900 },
  { name: 'tablet', w: 820, h: 1180 },
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innsight-auth-'));
let failures = 0;
let total = 1; // the static check above
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
      console.error(`[auth-pages] ${vp.name}: the harness did not report.`);
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
    console.error(`\n[auth-pages] ${failures} of ${total} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\n[auth-pages] ${total} checks passed.`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
