// Rendered checks for the restyled Sign In / Sign Up screens: the window-chrome
// dots, the round "back" button and grayscale filter on the photograph, the
// quote byline + decorative pagination row, and the gradient badge above the
// wordmark.
//
// A green build says nothing about the CSS cascade these new pieces sit in —
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

// Mirrors Login.jsx / RequestAccess.jsx's shared markup after the restyle —
// a 1x1 transparent pixel stands in for /brand/hotel.jpg so the check has no
// network/file dependency.
const PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7';

const PANEL = `
<div class="login-shell">
  <div class="login-panel" id="panel">
    <div class="login-chrome" id="chrome" aria-hidden="true">
      <span></span><span></span><span></span>
    </div>
    <aside class="login-figure" id="figure">
      <img class="login-figure-img" id="figureImg" src="${PIXEL}" alt="" aria-hidden="true" />
      <div class="login-figure-scrim" aria-hidden="true"></div>
      <div class="login-figure-notch login-figure-notch--tl" id="notchTL" aria-hidden="true"></div>
      <div class="login-figure-notch login-figure-notch--br" id="notchBR" aria-hidden="true"></div>
      <div class="login-figure-body">
        <div class="login-figure-top" id="figureTop">
          <button type="button" class="login-figure-back" id="backBtn" aria-label="Go back">&larr;</button>
          <div class="login-eyebrow">
            <span class="login-eyebrow-rule" aria-hidden="true"></span>
          </div>
        </div>
        <div class="login-figure-quote" id="quote">
          <h2>Every Stay,<br />Perfectly Run</h2>
          <div class="login-testimonial" id="testimonial">
            <p>A modern PMS for front-desk, housekeeping, and night audit.</p>
            <div class="login-testimonial-byline">
              <strong>Front Desk, Simplified</strong>
              <span>Built for hotel operations teams</span>
            </div>
          </div>
        </div>
      </div>
      <div class="login-figure-forward" id="forwardBtn" aria-hidden="true">&rarr;</div>
    </aside>
    <div class="login-form-side">
      <form class="login-card">
        <div class="login-badge" id="badge" aria-hidden="true"></div>
        <h1>Welcome Back</h1>
        <label class="login-label" for="u">Username</label>
        <input id="u" class="login-input" />
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
const chromeDots = document.getElementById('chrome');
const figure = document.getElementById('figure');
const badge = document.getElementById('badge');

// ── Window-chrome dots ──────────────────────────────────────────────────
const dots = [...chromeDots.querySelectorAll('span')];
ok('three chrome dots render', dots.length === 3, dots.length + ' dots');
const dotColors = dots.map((d) => styleOf(d).backgroundColor);
ok('chrome dots use distinct colours', new Set(dotColors).size === 3, dotColors.join(', '));
ok('chrome dots sit above the panel content (not clipped to 0 size)', box(chromeDots).width > 0 && box(chromeDots).height > 0);

const wide = VW >= 769; // matches the 768px breakpoint that hides .login-figure

if (wide) {
  // ── Photograph: grayscale filter + back button ─────────────────────────
  const img = document.getElementById('figureImg');
  ok('photograph is visible', box(img).width > 0 && box(img).height > 0);
  ok('photograph has a grayscale filter applied', styleOf(img).filter.includes('grayscale'), styleOf(img).filter);

  // ── Container shape: a plain, modest rounded rectangle (traced from the
  // reference — NOT an exaggerated swoop or organic blob). ────────────────
  const r = styleOf(figure).borderRadius.split(' ').map(parseFloat);
  const maxRadius = Math.max(...r);
  const minRadius = Math.min(...r);
  ok('figure has a uniform, modest corner radius (no exaggerated swoop)',
     maxRadius <= 40 && maxRadius === minRadius, styleOf(figure).borderRadius);

  // ── Back/forward buttons sit RECESSED into card-colored notches cut from
  // the two opposite corners (top-left, bottom-right) — the actual shape
  // traced from the reference, rather than floating on the bare photo. ────
  const backBtn = document.getElementById('backBtn');
  const forwardBtn = document.getElementById('forwardBtn');
  const notchTL = document.getElementById('notchTL');
  const notchBR = document.getElementById('notchBR');

  ok('back button is visible over the photograph', box(backBtn).width > 0 && box(backBtn).height > 0);
  ok('back button sits inside the figure bounds', box(backBtn).left >= box(figure).left - 1 && box(backBtn).top >= box(figure).top - 1);
  ok('top-left notch is anchored flush to the figure top-left corner',
     Math.abs(box(notchTL).left - box(figure).left) <= 1 && Math.abs(box(notchTL).top - box(figure).top) <= 1);
  ok('back button is fully contained within the top-left notch',
     box(backBtn).left >= box(notchTL).left && box(backBtn).right <= box(notchTL).right &&
     box(backBtn).top >= box(notchTL).top && box(backBtn).bottom <= box(notchTL).bottom,
     'btn ' + JSON.stringify({l:Math.round(box(backBtn).left),t:Math.round(box(backBtn).top),r:Math.round(box(backBtn).right),b:Math.round(box(backBtn).bottom)}) +
     ' notch ' + JSON.stringify({l:Math.round(box(notchTL).left),t:Math.round(box(notchTL).top),r:Math.round(box(notchTL).right),b:Math.round(box(notchTL).bottom)}));

  ok('forward affordance is visible over the photograph', box(forwardBtn).width > 0 && box(forwardBtn).height > 0);
  ok('bottom-right notch is anchored flush to the figure bottom-right corner',
     Math.abs(box(notchBR).right - box(figure).right) <= 1 && Math.abs(box(notchBR).bottom - box(figure).bottom) <= 1);
  ok('forward affordance is fully contained within the bottom-right notch',
     box(forwardBtn).left >= box(notchBR).left && box(forwardBtn).right <= box(notchBR).right &&
     box(forwardBtn).top >= box(notchBR).top && box(forwardBtn).bottom <= box(notchBR).bottom,
     'btn ' + JSON.stringify({l:Math.round(box(forwardBtn).left),t:Math.round(box(forwardBtn).top),r:Math.round(box(forwardBtn).right),b:Math.round(box(forwardBtn).bottom)}) +
     ' notch ' + JSON.stringify({l:Math.round(box(notchBR).left),t:Math.round(box(notchBR).top),r:Math.round(box(notchBR).right),b:Math.round(box(notchBR).bottom)}));

  // ── Testimonial: an inset rounded card, clear of the forward notch. ─────
  const testimonial = document.getElementById('testimonial');
  ok('testimonial card renders inside the figure', box(testimonial).bottom <= box(figure).bottom + 1);
  ok('testimonial card is inset from the figure edges (not full-bleed)',
     box(testimonial).left > box(figure).left + 4 && box(testimonial).right < box(figure).right - 4,
     'card ' + Math.round(box(testimonial).left) + '-' + Math.round(box(testimonial).right) + ' vs figure ' + Math.round(box(figure).left) + '-' + Math.round(box(figure).right));
  ok('testimonial card does not run under the forward notch',
     box(testimonial).right <= box(notchBR).left + 1,
     'card right ' + Math.round(box(testimonial).right) + ', notch left ' + Math.round(box(notchBR).left));
} else {
  ok('narrow: figure is hidden, form gets the room', styleOf(figure).display === 'none', styleOf(figure).display);
  ok('narrow: chrome dots remain visible above the form', box(chromeDots).width > 0);
}

// ── Badge above the heading, always (both breakpoints) ──────────────────
ok('brand badge renders as a visible circle', box(badge).width >= 20 && box(badge).height >= 20,
   Math.round(box(badge).width) + 'x' + Math.round(box(badge).height));
ok('badge is round', styleOf(badge).borderRadius.includes('50%') || parseFloat(styleOf(badge).borderRadius) >= box(badge).width / 2 - 1,
   styleOf(badge).borderRadius);

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
