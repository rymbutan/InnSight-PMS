// Rendered checks for the light, minimal Sign In / Sign Up screens: the brand
// panel with the InnSight logo, the top-right "sign up"/"sign in" link, the
// divider between the Google button and the manual fields, and basic
// responsive/overflow behavior.
//
// A green build says nothing about the CSS cascade these pieces sit in —
// this renders the real markup in headless Chrome and reads back computed
// layout, same pattern as check-dashboard-revenue-row-render.mjs.
//
// Run: node scripts/check-login-signup-render.mjs

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
  console.log('[login-signup] no Chrome found — skipping the rendered check.');
  console.log('[login-signup] set CHROME_PATH to run it.');
  process.exit(0);
}

const CSS_TEXT = fs.readFileSync(CSS_PATH, 'utf8');

// A tiny transparent pixel stands in for the real logo asset so the check has
// no filesystem/network dependency.
const PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7';

const PANEL = `
<div class="login-shell">
  <div class="login-panel" id="panel">
    <aside class="login-illustration" id="illustration">
      <img class="login-illustration-logo" id="logo" src="${PIXEL}" alt="InnSight" />
      <p class="login-illustration-caption">A modern PMS for front-desk, housekeeping, and night audit.</p>
    </aside>
    <div class="login-form-side">
      <form class="login-card" id="card">
        <p class="login-topline" id="topline">Don't have an account? <a href="#">Sign up</a></p>
        <h1>Sign in</h1>
        <p class="login-lede">Enter your username and password to access your account</p>
        <div class="google-signin" id="google">
          <button type="button" class="google-btn">Sign In with Google</button>
        </div>
        <div class="login-divider" id="divider">
          <span class="login-divider-line" aria-hidden="true"></span>
          <span>Or continue with username</span>
          <span class="login-divider-line" aria-hidden="true"></span>
        </div>
        <label class="login-label" for="u">Username</label>
        <input id="u" class="login-input" />
        <label class="login-label" for="p">Password</label>
        <div class="login-input-wrap">
          <input id="p" class="login-input" type="password" />
          <button type="button" class="login-reveal">o</button>
        </div>
        <p class="login-forgot" id="forgot"><a href="#">Forgot password?</a></p>
        <button class="login-submit" id="submit">Sign In</button>
      </form>
    </div>
  </div>
</div>`;

const PAGE = `<!doctype html>
<meta charset="utf-8"><title>pending</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CSS_TEXT}</style>
<body>
${PANEL}
<script>
const out = [];
const VW = window.innerWidth;
const ok = (n, c, d) => out.push((c ? 'PASS' : 'FAIL') + ' :: [' + VW + 'px] ' + n + (d ? ' :: ' + d : ''));
const box = (el) => el.getBoundingClientRect();
const styleOf = (el) => getComputedStyle(el);

const panel = document.getElementById('panel');
const illustration = document.getElementById('illustration');
const logo = document.getElementById('logo');
const card = document.getElementById('card');
const topline = document.getElementById('topline');
const google = document.getElementById('google');
const divider = document.getElementById('divider');
const forgot = document.getElementById('forgot');
const submit = document.getElementById('submit');

const wide = VW >= 769; // matches the 768px breakpoint that hides .login-illustration

if (wide) {
  ok('illustration panel is visible', box(illustration).width > 0 && box(illustration).height > 0);
  ok('logo renders inside the illustration panel', box(logo).width > 0 &&
     box(logo).left >= box(illustration).left - 1 && box(logo).right <= box(illustration).right + 1);
  ok('illustration sits left of the form (matches the reference layout)',
     box(illustration).left < box(card).left, 'illustration left ' + Math.round(box(illustration).left) + ', card left ' + Math.round(box(card).left));
} else {
  ok('narrow: illustration panel is hidden, form gets the room', styleOf(illustration).display === 'none', styleOf(illustration).display);
}

// ── Top-right "sign up" line sits above the heading ─────────────────────
ok('topline renders above the card content', box(topline).top <= box(card).top + 4);
ok('topline is right-aligned', styleOf(topline).textAlign === 'right', styleOf(topline).textAlign);

// ── Google button, then the divider, then the manual fields ─────────────
ok('Google sign-in sits above the divider', box(google).bottom <= box(divider).top + 1,
   'google bottom ' + Math.round(box(google).bottom) + ', divider top ' + Math.round(box(divider).top));
const lines = [...divider.querySelectorAll('.login-divider-line')];
ok('divider has a rule on each side of its text', lines.length === 2 && lines.every((l) => box(l).width > 4));

// ── Forgot-password link sits after the fields, before the submit button ─
ok('forgot-password link sits above the submit button', box(forgot).bottom <= box(submit).top + 1);
ok('forgot-password link is right-aligned', styleOf(forgot).textAlign === 'right', styleOf(forgot).textAlign);

// ── No horizontal overflow anywhere in the panel ────────────────────────
ok('panel does not overflow the viewport', box(panel).right <= VW + 1, Math.round(box(panel).right) + ' vs ' + VW);

document.title = out.some((l) => l.startsWith('FAIL')) ? 'RESULT-FAIL' : 'RESULT-PASS';
const pre = document.createElement('pre');
pre.id = 'results';
pre.textContent = out.join('\\n');
document.body.appendChild(pre);
</script>
</body>`;

const VIEWPORTS = [
  { name: 'desktop', w: 1440, h: 900 },
  { name: 'laptop', w: 1180, h: 800 },
  { name: 'tablet-portrait', w: 820, h: 1180 },
  { name: 'mobile', w: 390, h: 844 },
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innsight-login-signup-'));
let failures = 0;
let total = 0;
try {
  for (const vp of VIEWPORTS) {
    const pagePath = path.join(dir, `${vp.name}.html`);
    fs.writeFileSync(pagePath, PAGE, 'utf8');

    const dom = execFileSync(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        `--window-size=${vp.w},${vp.h}`,
        '--virtual-time-budget=4000',
        '--dump-dom',
        `file:///${pagePath.replace(/\\/g, '/')}`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 90_000 }
    );

    const block = dom.match(/<pre id="results">([\s\S]*?)<\/pre>/);
    if (!block) {
      console.error(`[login-signup] ${vp.name}: the harness did not report.`);
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
    console.error(`\n[login-signup] ${failures} of ${total} rendered check(s) failed.`);
    process.exit(1);
  }
  console.log(`\n[login-signup] ${total} rendered checks passed.`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
