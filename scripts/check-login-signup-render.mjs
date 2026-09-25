// Rendered checks for the bold, full-bleed Sign In / Sign Up screens: the
// green gradient shell, the brand hero on the left, the translucent "glass"
// card on the right, and basic responsive/overflow behavior.
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
<div class="login-shell" id="shell">
  <div class="login-panel" id="panel">
    <div class="login-hero" id="hero">
      <div class="login-hero-graphic"><img class="login-hero-graphic-img" src="${PIXEL}" alt="" /></div>
      <div class="login-hero-bottom">
        <div class="login-hero-brand">
          <img class="login-hero-logo" src="${PIXEL}" alt="" />
          <div>
            <div class="login-hero-word">InnSight</div>
            <div class="login-hero-tag">Hotel PMS</div>
          </div>
        </div>
      </div>
    </div>
    <form class="login-card" id="card">
      <h1 id="heading">Sign in</h1>
      <p class="login-lede">Enter your username and password to access your account</p>
      <div class="google-signin" id="google"><button type="button" class="google-btn">Sign In with Google</button></div>
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
      <p class="login-alt" id="alt">Don't have an account?</p>
      <a href="#" class="login-secondary" id="secondary">Sign Up</a>
    </form>
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

const shell = document.getElementById('shell');
const panel = document.getElementById('panel');
const hero = document.getElementById('hero');
const card = document.getElementById('card');
const heading = document.getElementById('heading');
const google = document.getElementById('google');
const divider = document.getElementById('divider');
const forgot = document.getElementById('forgot');
const submit = document.getElementById('submit');
const alt = document.getElementById('alt');
const secondary = document.getElementById('secondary');

// ── The bold gradient is CONTAINED in a rounded panel, not bled to the
// browser edges — the panel sits on the app's own neutral page background. ──
const bg = styleOf(panel).backgroundImage;
ok('panel (not the shell) carries the gradient', bg.includes('gradient'), bg);
ok('shell behind the panel is a plain, non-gradient background', !styleOf(shell).backgroundImage.includes('gradient'),
   styleOf(shell).backgroundImage);
ok('panel is contained: rounded corners', parseFloat(styleOf(panel).borderRadius) > 0, styleOf(panel).borderRadius);
ok('panel is inset from the shell edges (not full-bleed)',
   box(panel).left > box(shell).left + 4 && box(panel).top > box(shell).top + 4 && box(panel).width < box(shell).width,
   'panel left ' + Math.round(box(panel).left) + ' vs shell left ' + Math.round(box(shell).left) +
   ', panel width ' + Math.round(box(panel).width) + ' vs shell width ' + Math.round(box(shell).width));

// ── Card is a translucent "glass" panel, not an opaque page-colored one ──
const cardBg = styleOf(card).backgroundColor;
const alphaMatch = cardBg.match(/rgba?\\([^)]+,\\s*([0-9.]+)\\)/);
const alpha = alphaMatch ? parseFloat(alphaMatch[1]) : 1;
ok('card background is translucent (glass effect)', alpha < 1, cardBg);
ok('card has a backdrop blur', styleOf(card).backdropFilter.includes('blur') || styleOf(card).webkitBackdropFilter?.includes('blur'),
   styleOf(card).backdropFilter);

// ── Primary CTA is a solid high-contrast fill, not another glass button ──
ok('submit button has a solid, non-transparent fill', styleOf(submit).backgroundColor.startsWith('rgb(') && !styleOf(submit).backgroundColor.startsWith('rgba('),
   styleOf(submit).backgroundColor);

const wide = VW >= 1001; // matches the 1000px breakpoint that hides .login-hero

if (wide) {
  ok('hero is visible', box(hero).width > 0 && box(hero).height > 0);
  ok('hero sits left of the card', box(hero).left < box(card).left,
     'hero left ' + Math.round(box(hero).left) + ', card left ' + Math.round(box(card).left));
} else {
  ok('narrow: hero is hidden, card gets the room', styleOf(hero).display === 'none', styleOf(hero).display);
}

// ── Card content order: heading -> google -> divider -> fields -> forgot -> submit -> alt/secondary ──
ok('google sign-in sits above the divider', box(google).bottom <= box(divider).top + 1);
ok('divider sits below the heading', box(divider).top >= box(heading).bottom);
ok('forgot-password sits above the submit button', box(forgot).bottom <= box(submit).top + 1);
ok('secondary sign-up affordance sits below the submit button', box(secondary).top >= box(submit).bottom,
   'secondary top ' + Math.round(box(secondary).top) + ', submit bottom ' + Math.round(box(submit).bottom));
ok('alt line sits directly above the secondary button', box(alt).bottom <= box(secondary).top + 4);

// ── No horizontal overflow anywhere in the shell ─────────────────────────
ok('shell does not overflow the viewport horizontally', document.documentElement.scrollWidth <= VW + 1,
   document.documentElement.scrollWidth + ' vs ' + VW);

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
