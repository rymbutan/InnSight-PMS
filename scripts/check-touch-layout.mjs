// Rendered guard for the tablet layout and the touch controls.
//
// Same reason as check-chat-dock-render.mjs: the defects this catches live in
// the CASCADE and in measured geometry, which the build, ESLint and `node
// --test` cannot see. A stick whose knob escapes its dial, a joystick behind
// the canvas it is supposed to sit over, a 26px thumb target, a rail eating
// 264px of a 1024px iPad — every one of those renders "fine" to a bundler.
//
// It drives headless Chrome at real device sizes and asserts the boxes.
//
// Run: node scripts/check-touch-layout.mjs

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
  console.log('[touch-layout] no Chrome found — skipping the rendered check.');
  console.log('[touch-layout] set CHROME_PATH to run it.');
  process.exit(0);
}

// STICK_RADIUS in components/TouchControls.jsx. The dial is drawn from
// `.touch-stick`'s width and the maths clamps to this constant; if the two ever
// disagree the knob leaves the ring, which is the whole point of asserting it.
const STICK_RADIUS = 52;

const PAGE = `<!doctype html>
<meta charset="utf-8"><title>pending</title>
<style id="app-css">__CSS__</style>
<body>
<!-- The first-person stage with the touch overlay, as InspectionShift renders it. -->
<div class="fr-stage" id="stage" style="position:relative;width:100%;height:420px">
  <canvas id="canvas" style="width:100%;height:100%"></canvas>
  <div class="fr-hint" id="hint">joystick to walk &middot; drag to look &middot; aim the crosshair, then Inspect</div>
  <div class="touch-controls" id="tc">
    <div class="touch-look" id="look"></div>
    <div class="touch-stick" id="stick">
      <span class="touch-stick-ring"></span>
      <span class="touch-stick-knob" id="knob"></span>
    </div>
    <button class="touch-action" id="act">Inspect</button>
  </div>
</div>

<!-- The pan/zoom map host. -->
<div class="pz-host" id="pz">
  <div class="pz-surface" id="pzs"><div class="pz-content" id="pzc" style="width:1600px;height:600px"></div></div>
  <div class="pz-tools" id="pzt"><button>+</button><button>-</button><button>f</button></div>
</div>

<!-- A few of the controls whose thumb size matters. -->
<button class="chat-icon-btn" id="cib">x</button>
<button class="msg-send" id="send">s</button>

<!-- A chat window header at its tablet width: raising the icon buttons to a
     44px thumb target must not push the name out of its own bar. -->
<section class="chat-win" id="cw" style="width:300px">
  <header class="chat-win-head" id="cwh">
    <button class="chat-win-title"><span class="chat-avatar" style="width:28px;height:28px"></span><span class="chat-win-name" id="cwn">Monte Salvanera</span></button>
    <div class="chat-win-tools"><button class="chat-icon-btn">a</button><button class="chat-icon-btn">b</button><button class="chat-icon-btn">c</button></div>
  </header>
</section>

<script>
const out = [];
const ok = (n, c, d) => out.push((c ? 'PASS' : 'FAIL') + ' :: ' + n + (d ? ' :: ' + d : ''));
const cs = (el) => getComputedStyle(el);
const box = (id) => document.getElementById(id).getBoundingClientRect();
const el = (id) => document.getElementById(id);

// ── The look plane must actually receive the gesture ────────────────────────
// touch-action is the single most load-bearing property here: without it the
// browser claims a one-finger drag for scrolling / pull-to-refresh, pointermove
// stops arriving, and the camera turns a few pixels and then sticks.
ok('look plane: touch-action none', cs(el('look')).touchAction === 'none', cs(el('look')).touchAction);
ok('stick: touch-action none', cs(el('stick')).touchAction === 'none', cs(el('stick')).touchAction);
ok('map surface: touch-action none', cs(el('pzs')).touchAction === 'none', cs(el('pzs')).touchAction);
ok('3d canvas: touch-action none', cs(el('canvas')).touchAction === 'none', cs(el('canvas')).touchAction);

// ── The overlay must be over the canvas, and the stick over the look plane ──
const tcz = Number(cs(el('tc')).zIndex);
ok('touch overlay is stacked above the canvas', tcz >= 1, 'z-index ' + cs(el('tc')).zIndex);
// The frame itself must NOT eat clicks meant for the hints underneath it.
ok('overlay frame is click-through', cs(el('tc')).pointerEvents === 'none', cs(el('tc')).pointerEvents);
ok('look plane takes the pointer', cs(el('look')).pointerEvents === 'auto');
ok('stick takes the pointer', cs(el('stick')).pointerEvents === 'auto');

// The stick has to be the topmost thing at its own centre, or its touches go to
// the look plane and pushing the stick spins the camera instead of walking.
const s = box('stick');
const atStick = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
ok('stick wins the hit test at its centre', el('stick').contains(atStick), atStick && atStick.className);

// And the look plane must win in open space, or dragging the room does nothing.
const st = box('stage');
const atMiddle = document.elementFromPoint(st.left + st.width / 2, st.top + 40);
ok('look plane wins in open space', atMiddle === el('look'), atMiddle && atMiddle.className);

// ── The dial must match the maths ───────────────────────────────────────────
// The JS clamps the knob to STICK_RADIUS; the ring is drawn from CSS. If they
// disagree the knob visibly leaves the dial.
ok('dial diameter matches STICK_RADIUS * 2',
   Math.round(s.width) === ${STICK_RADIUS} * 2,
   Math.round(s.width) + 'px vs ' + ${STICK_RADIUS} * 2 + 'px');
ok('dial is square', Math.round(s.width) === Math.round(s.height), s.width + 'x' + s.height);

// Pushed to the ring, the knob stays inside the dial.
const k = el('knob');
k.style.transform = 'translate(' + ${STICK_RADIUS} + 'px, 0)';
const kb = k.getBoundingClientRect();
ok('knob at full deflection stays within the dial',
   kb.right <= s.right + 1 && kb.left >= s.left - 1,
   'knob ' + Math.round(kb.left) + '-' + Math.round(kb.right) + ' vs dial ' + Math.round(s.left) + '-' + Math.round(s.right));

// ── Thumb targets ──────────────────────────────────────────────────────────
// Headless Chrome reports a FINE pointer and cannot be told otherwise without
// the DevTools protocol, so the coarse-pointer media block never matches here and
// the rules that matter would go unmeasured — the harness would pass while
// saying nothing.
//
// So the block is found in the CSSOM and re-applied WITHOUT its media
// condition. That tests both halves of what we care about: that the rules exist
// at all, and that they actually produce a 44px box when they apply.
let coarseRules = 0;
(() => {
  const sheet = [...document.styleSheets].find((x) => x.ownerNode && x.ownerNode.id === 'app-css');
  const out = [];
  const walk = (rules) => {
    for (const r of rules) {
      if (r.type === CSSRule.MEDIA_RULE) {
        if (/pointer:\\s*coarse/.test(r.conditionText)) {
          for (const inner of r.cssRules) out.push(inner.cssText);
        } else {
          walk(r.cssRules);
        }
      }
    }
  };
  walk(sheet.cssRules);
  coarseRules = out.length;
  const style = document.createElement('style');
  style.textContent = out.join('\\n');
  document.head.appendChild(style);
})();
ok('the stylesheet has coarse-pointer target rules', coarseRules > 0, coarseRules + ' rules');

const MIN = 44;
for (const [id, name] of [['act', 'action button'], ['send', 'send button'], ['cib', 'icon button']]) {
  const b = box(id);
  ok(name + ' is at least ' + MIN + 'px', Math.min(b.width, b.height) >= MIN,
     Math.round(b.width) + 'x' + Math.round(b.height));
}
for (const b of [...document.querySelectorAll('.pz-tools button')]) {
  const r = b.getBoundingClientRect();
  if (Math.min(r.width, r.height) < 40) ok('map tool button >= 40px', false, Math.round(r.width) + 'x' + Math.round(r.height));
}
ok('map tool buttons >= 40px', [...document.querySelectorAll('.pz-tools button')]
  .every((b) => Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height) >= 40));

// ── The controls must not sit off the bottom of the stage ──────────────────
ok('stick is inside the stage', s.bottom <= st.bottom + 1 && s.left >= st.left - 1,
   'stick bottom ' + Math.round(s.bottom) + ' vs stage ' + Math.round(st.bottom));
const a = box('act');
ok('action button is inside the stage', a.bottom <= st.bottom + 1 && a.right <= st.right + 1,
   'action right ' + Math.round(a.right) + ' vs stage ' + Math.round(st.right));
// They must not overlap each other either, or a thumb reaching for one hits both.
ok('stick and action button do not overlap', a.left > s.right, 'gap ' + Math.round(a.left - s.right) + 'px');

// The hint is the one thing that shares the bottom of the stage with the
// controls. As a centred nowrap pill it ran under the joystick and off both
// edges at phone width, which is why it moves up on a coarse pointer.
const overlaps = (p, q) => !(p.right <= q.left || p.left >= q.right || p.bottom <= q.top || p.top >= q.bottom);
const h = box('hint');
ok('hint does not collide with the joystick', !overlaps(h, s),
   'hint ' + Math.round(h.left) + '-' + Math.round(h.right) + ' / ' + Math.round(h.top) + '-' + Math.round(h.bottom));
ok('hint does not collide with the action button', !overlaps(h, a));
ok('hint stays inside the stage', h.left >= st.left - 1 && h.right <= st.right + 1,
   'hint ' + Math.round(h.left) + '-' + Math.round(h.right) + ' vs stage ' + Math.round(st.left) + '-' + Math.round(st.right));

// ── The map host must have a height to pan within ──────────────────────────
const pz = box('pz');
ok('map host has a usable height', pz.height >= 300, Math.round(pz.height) + 'px');

// Raising the header icons to a 44px target must not overflow the bar or
// squeeze the name to nothing.
const cwh = el('cwh');
ok('chat header does not overflow at tablet width',
   cwh.scrollWidth <= cwh.clientWidth + 1, cwh.scrollWidth + ' vs ' + cwh.clientWidth);
ok('chat header still leaves room for the name',
   box('cwn').width >= 70, Math.round(box('cwn').width) + 'px');
ok('map host clips its content', cs(el('pz')).overflow === 'hidden', cs(el('pz')).overflow);
ok('map content scales from its top-left', cs(el('pzc')).transformOrigin.startsWith('0px 0px'),
   cs(el('pzc')).transformOrigin);

document.title = out.some((l) => l.startsWith('FAIL')) ? 'RESULT-FAIL' : 'RESULT-PASS';
const pre = document.createElement('pre');
pre.id = 'results';
pre.textContent = out.join('\\n');
document.body.appendChild(pre);
</script>
</body>`;

// iPad portrait and landscape, plus a phone for the lower bound. The window
// size is what decides which media queries apply, so each is a separate run.
const VIEWPORTS = [
  { name: 'iPad portrait', w: 768, h: 1024 },
  { name: 'iPad landscape', w: 1024, h: 768 },
  { name: 'iPad Pro 12.9 landscape', w: 1366, h: 1024 },
  { name: 'phone', w: 390, h: 844 },
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innsight-touch-'));
let failed = 0;
try {
  const page = path.join(dir, 'index.html');
  // Inlined, not linked: a file:// stylesheet is an opaque origin and reading
  // its `cssRules` from the page throws, which the coarse-pointer check needs.
  fs.writeFileSync(page, PAGE.replace('__CSS__', fs.readFileSync(CSS_PATH, 'utf8')), 'utf8');

  for (const vp of VIEWPORTS) {
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
      console.error(`[touch-layout] ${vp.name}: the harness did not report.`);
      failed += 1;
      continue;
    }
    const lines = block[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const bad = lines.filter((l) => l.startsWith('FAIL'));
    console.log(`\n  ${vp.name} (${vp.w}x${vp.h}) — ${lines.length - bad.length}/${lines.length} passed`);
    for (const l of bad) console.log(`    ${l}`);
    failed += bad.length;
  }

  if (failed) {
    console.error(`\n[touch-layout] ${failed} rendered check(s) failed.`);
    process.exit(1);
  }
  console.log('\n[touch-layout] all rendered checks passed at every viewport.');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
