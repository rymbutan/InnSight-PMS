// Contrast guard for the two theme token blocks in web/src/styles.css.
//
// This exists because dark mode was originally built by swapping ~20 CSS
// variables while ~70 declarations elsewhere kept writing literal light colours.
// Nothing failed — it just rendered #e2e8f0 text on a #ffffff menu (1.23:1) and
// panel borders at 1.18:1. A stylesheet cannot be eyeballed for that, and the
// failure is invisible to lint, the type checker and the build.
//
// So the rule is now mechanical: every foreground/background pair the app can
// actually produce is asserted here, in BOTH themes. Adding a component that
// needs a new surface means adding its token and its pair to this file.
//
// Run: node scripts/check-contrast.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS = fs.readFileSync(path.join(ROOT, 'web/src/styles.css'), 'utf8');

// ── colour maths ────────────────────────────────────────────────────────────
const srgb = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * srgb(r / 255) + 0.7152 * srgb(g / 255) + 0.0722 * srgb(b / 255);
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** `#rgb`, `#rrggbb`, `#rrggbbaa` or `rgba(r,g,b,a)` → [r,g,b,a]. */
function parse(v) {
  const s = v.trim();
  const m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(',').map((n) => parseFloat(n));
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  let h = s.replace('#', '');
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  const n = h.match(/../g).map((x) => parseInt(x, 16));
  return [n[0], n[1], n[2], h.length === 8 ? n[3] / 255 : 1];
}

/** Flatten a translucent colour onto an opaque backdrop. */
const over = (fg, bg) =>
  fg[3] >= 1 ? fg.slice(0, 3) : [0, 1, 2].map((i) => Math.round(fg[3] * fg[i] + (1 - fg[3]) * bg[i]));

// ── token extraction ────────────────────────────────────────────────────────
function tokens(selector) {
  const i = CSS.indexOf(selector);
  if (i < 0) throw new Error(`missing token block: ${selector}`);
  const block = CSS.slice(i, CSS.indexOf('}', i));
  const out = {};
  for (const [, k, v] of block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[k] = v.trim();
  return out;
}
const THEMES = { light: tokens(':root {'), dark: tokens("html[data-theme='dark'] {") };

// ── what the app can actually put on top of what ────────────────────────────
// [foreground, background, minimum, why]
const TEXT = 4.5; // WCAG 1.4.3 AA, normal-size text
const CTRL = 3.0; // WCAG 1.4.11, boundaries of interactive controls
const EDGE = 1.4; // a panel edge a person can actually see

const PAIRS = [
  ['text', 'bg', TEXT],
  ['text', 'panel', TEXT],
  ['text', 'surface', TEXT],
  ['text', 'surface-2', TEXT],
  ['text', 'overlay', TEXT],
  ['text', 'field', TEXT],
  ['muted', 'surface', TEXT],
  ['muted', 'overlay', TEXT],
  ['muted', 'surface-2', TEXT],
  // --muted-2 is the NON-TEXT tier: icons, sort arrows, disabled controls and
  // small fills. It cannot also clear 4.5:1 without collapsing into --muted, so
  // it is held to the 3:1 non-text bar and real text uses --muted instead.
  ['muted-2', 'bg', CTRL],
  ['muted-2', 'surface', CTRL],
  // text sitting on a saturated fill (buttons, avatars, calendar bars, toasts)
  ['on-accent', 'accent', TEXT],
  ['on-accent', 'accent-hover', TEXT],
  ['on-green', 'green', TEXT],
  ['on-green', 'green-hover', TEXT],
  ['on-accent', 'danger', TEXT],
  ['on-accent', 'danger-hover', TEXT],
  ['on-warn', 'warn', TEXT],
  ['on-neutral', 'muted-2', TEXT], // .as-mark.as-skipped
  // status badges: a tint plus its paired text
  ['on-accent-soft', 'accent-soft', TEXT],
  ['on-green-soft', 'green-soft', TEXT],
  ['on-warn-soft', 'warn-soft', TEXT],
  ['on-danger-soft', 'danger-soft', TEXT],
  ['on-neutral-soft', 'neutral-soft', TEXT],
  // non-text: control boundaries and panel edges
  ['border-strong', 'surface', CTRL],
  ['border-strong', 'field', CTRL],
  ['border', 'surface', EDGE],
  ['border', 'bg', EDGE],
];
// NOTE: overlay-vs-surface is deliberately NOT asserted. In the light theme menus
// are the same white as panels and separate themselves with a border and a
// shadow, which is a normal treatment, not a defect. What must hold is that text
// stays readable ON the overlay — covered by the --text/--muted pairs above.;

// Pre-existing LIGHT-theme failures, untouched by the dark-mode work: white text
// on the green/amber/red fills. Fixing them means giving those fills dark text,
// which changes how the light theme looks — a deliberate design call, not a
// silent side effect. Listed so the guard still catches anything NEW.
const KNOWN = new Set([
  // (empty) Both themes now pass every pair. Add an entry here only with a
  // written reason, never to quiet a failure.
]);

let failed = 0,
  waived = 0;
for (const [theme, tok] of Object.entries(THEMES)) {
  const rows = [];
  for (const [fgK, bgK, min] of PAIRS) {
    if (!tok[fgK] || !tok[bgK]) {
      console.error(`  ✗ ${theme}: undefined token --${tok[fgK] ? bgK : fgK}`);
      failed++;
      continue;
    }
    // A tint is composited over the panel it sits on before being measured.
    const bg = over(parse(tok[bgK]), parse(tok.panel));
    const fg = over(parse(tok[fgK]), bg);
    const r = ratio(fg, bg);
    const key = `${theme}:${fgK}/${bgK}`;
    const ok = r >= min;
    if (!ok && KNOWN.has(key)) {
      waived++;
      rows.push(['~', fgK, bgK, r, min]);
      continue;
    }
    if (!ok) failed++;
    rows.push([ok ? '✓' : '✗', fgK, bgK, r, min]);
  }
  console.log(`\n${theme.toUpperCase()}`);
  for (const [mark, f, b, r, min] of rows)
    if (mark !== '✓') console.log(`  ${mark} --${f} on --${b}  ${r.toFixed(2)}:1  (need ${min})`);
  console.log(`  ${rows.filter((x) => x[0] === '✓').length}/${rows.length} pairs pass`);
}

if (waived) console.log(`\n~ ${waived} pre-existing light-theme failure(s) waived — see KNOWN in this file.`);
if (failed) {
  console.error(`\n✗ ${failed} contrast failure(s).`);
  process.exit(1);
}
console.log('\n✓ Contrast OK in both themes.');
