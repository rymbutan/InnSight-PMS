// Rendered checks for the two-tone Sign In / Sign Up screens: a plain white
// form on the left, a green marketing panel (feature-highlight card, stat
// pill, carousel dots) on the right, contained in a rounded panel on the
// app's own page background.
//
// A green build says nothing about the CSS cascade these pieces sit in —
// this renders the real markup in headless Chrome and reads back computed
// layout, same pattern as check-dashboard-revenue-row-render.mjs.
//
// NOTE on viewport widths: on this Windows/Chrome combination, `--dump-dom`
// silently floors `--window-size` at ~500px (verified via CDP device-metric
// override, which does NOT have this floor) — a headless-Chrome quirk, not
// an app bug. The "mobile" entry below therefore also renders at ~500px in
// this harness; it still exercises the <1000px "hero hidden" layout, but is
// not proof of correctness at true phone widths (~390px). Verify those with
// an actual screenshot (`--screenshot`, which is NOT floored) or CDP
// `Emulation.setDeviceMetricsOverride` if a change specifically targets
// narrow phones.
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

// A tiny transparent pixel stands in for real image assets so the check has
// no filesystem/network dependency.
const PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7';

const PANEL = `
<div class="login-shell" id="shell">
  <div class="login-panel" id="panel">
    <div class="login-form-side" id="formSide">
      <form class="login-card" id="card">
        <div class="login-brandmark"><img src="${PIXEL}" alt="" /><span>InnSight</span></div>
        <h1 id="heading">Sign in</h1>
        <p class="login-topline" id="topline">Don't have an account? <a href="#">Sign Up</a></p>
        <label class="login-label" for="u">Username</label>
        <input id="u" class="login-input" />
        <label class="login-label" for="p">Password</label>
        <div class="login-input-wrap">
          <input id="p" class="login-input" type="password" />
          <button type="button" class="login-reveal">o</button>
        </div>
        <p class="login-forgot" id="forgot"><a href="#">Forgot password?</a></p>
        <button class="login-submit" id="submit">Sign In</button>
        <div class="login-divider" id="divider">
          <span class="login-divider-line" aria-hidden="true"></span>
          <span>Or continue with username</span>
          <span class="login-divider-line" aria-hidden="true"></span>
        </div>
        <div class="google-signin" id="google"><button type="button" class="google-btn">Sign In with Google</button></div>
      </form>
    </div>
    <div class="login-hero" id="hero">
      <div class="login-hero-topbar"><span class="login-hero-support">Support</span></div>
      <div class="login-hero-highlight" id="highlight">
        <div class="login-hero-highlight-text">
          <h2>Run your front desk faster</h2>
          <p>Check guests in, track housekeeping, and close the night audit.</p>
          <span class="login-hero-cta">Learn more</span>
        </div>
        <img class="login-hero-highlight-art" src="${PIXEL}" alt="" />
      </div>
      <div class="login-hero-stat" id="stat">
        <div><strong>87%</strong><span>Occupancy today</span></div>
      </div>
      <div class="login-hero-features" id="features">
        <h3>Introducing new features</h3>
        <p>Real-time room status, automated night audits, and instant guest messaging.</p>
      </div>
      <div class="login-hero-dots" id="dots">
        <button type="button" class="login-hero-arrow">&lsaquo;</button>
        <button type="button" class="login-hero-dot"></button>
        <button type="button" class="login-hero-dot login-hero-dot--active"></button>
        <button type="button" class="login-hero-dot"></button>
        <button type="button" class="login-hero-arrow">&rsaquo;</button>
      </div>
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

const shell = document.getElementById('shell');
const panel = document.getElementById('panel');
const formSide = document.getElementById('formSide');
const card = document.getElementById('card');
const heading = document.getElementById('heading');
const topline = document.getElementById('topline');
const forgot = document.getElementById('forgot');
const submit = document.getElementById('submit');
const divider = document.getElementById('divider');
const google = document.getElementById('google');
const hero = document.getElementById('hero');
const highlight = document.getElementById('highlight');
const stat = document.getElementById('stat');
const features = document.getElementById('features');
const dots = document.getElementById('dots');

// ── The panel is CONTAINED on the app's own page background, not bled to
// the browser edges. ─────────────────────────────────────────────────────
ok('panel is contained: rounded corners', parseFloat(styleOf(panel).borderRadius) > 0, styleOf(panel).borderRadius);
ok('panel is inset from the shell edges (not full-bleed)',
   box(panel).left > box(shell).left + 4 && box(panel).top > box(shell).top + 4 && box(panel).width < box(shell).width,
   'panel left ' + Math.round(box(panel).left) + ' vs shell left ' + Math.round(box(shell).left) +
   ', panel width ' + Math.round(box(panel).width) + ' vs shell width ' + Math.round(box(shell).width));

// ── Left form side is a plain white card, not a translucent glass one ──
ok('form side has an opaque white background', styleOf(formSide).backgroundColor === 'rgb(255, 255, 255)',
   styleOf(formSide).backgroundColor);
ok('submit button has a solid fill', styleOf(submit).backgroundColor.startsWith('rgb('),
   styleOf(submit).backgroundColor);

const wide = VW >= 1001; // matches the 1000px breakpoint that hides .login-hero

if (wide) {
  ok('hero is visible', box(hero).width > 0 && box(hero).height > 0);
  ok('hero sits right of the form', box(hero).left > box(card).left,
     'hero left ' + Math.round(box(hero).left) + ', card left ' + Math.round(box(card).left));

  // ── Feature-highlight card + overlapping stat pill, matching the
  // reference's layered composition. ────────────────────────────────────
  ok('stat pill overlaps the bottom of the highlight card',
     box(stat).top < box(highlight).bottom && box(stat).bottom > box(highlight).bottom,
     'stat ' + Math.round(box(stat).top) + '-' + Math.round(box(stat).bottom) + ', highlight bottom ' + Math.round(box(highlight).bottom));
  ok('features block sits below the highlight card', box(features).top >= box(highlight).bottom);
  ok('carousel dots sit below the features text', box(dots).top >= box(features).bottom);

  // ── The carousel is real controls, not decorative markers: buttons, one
  // marked as the current slide, all cursor:pointer. ─────────────────────
  const dotButtons = [...dots.querySelectorAll('button.login-hero-dot')];
  const arrowButtons = [...dots.querySelectorAll('button.login-hero-arrow')];
  ok('carousel renders real <button> controls for dots and arrows',
     dotButtons.length >= 2 && arrowButtons.length === 2,
     dotButtons.length + ' dots, ' + arrowButtons.length + ' arrows');
  ok('dot and arrow buttons show a pointer cursor',
     [...dotButtons, ...arrowButtons].every((b) => styleOf(b).cursor === 'pointer'));

} else {
  ok('narrow: hero is hidden, form gets the room', styleOf(hero).display === 'none', styleOf(hero).display);
}

// ── Card content order: brandmark -> heading -> topline -> fields ->
// forgot -> submit -> divider -> google. ─────────────────────────────────
ok('topline sits directly under the heading', box(topline).top >= box(heading).bottom);
ok('forgot-password sits above the submit button', box(forgot).bottom <= box(submit).top + 1);
ok('divider sits below the submit button', box(divider).top >= box(submit).bottom);
ok('google sign-in sits below the divider', box(google).top >= box(divider).bottom);

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
  { name: 'mobile', w: 390, h: 844 }, // see the NOTE above — floored to ~500px here
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
