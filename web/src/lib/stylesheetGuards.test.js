import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────────
// Invariants the stylesheet has to hold for the JSX to behave as written.
//
// These exist because of a shipped bug that no unit test could have caught and
// no reviewer spotted: the chat window's collapse button did nothing. The JSX
// said `hidden={minimized}`, the state flipped correctly, the icon changed —
// and the window stayed open, because `[hidden] { display: none }` lives in the
// USER-AGENT stylesheet and every author rule outranks the UA stylesheet no
// matter how unspecific it is. `.chat-win-body { display: flex }` therefore
// beat `hidden` silently.
//
// The lesson generalises past that one component, which is why this is a test
// about the stylesheet rather than a fix in one rule: any element that both
// carries `hidden` and has a `display` of its own is invisible-proof unless the
// stylesheet asserts otherwise once, globally.
// ─────────────────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');
const CSS = readFileSync(join(SRC, 'styles.css'), 'utf8');

function jsxFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) jsxFiles(full, out);
    else if (name.endsWith('.jsx')) out.push(full);
  }
  return out;
}

test('the stylesheet forces the hidden attribute to win', () => {
  // Normalised so whitespace and property order cannot make this pass or fail
  // by accident.
  const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
  const rule = flat.match(/\[hidden\]\s*\{([^}]*)\}/);
  assert.ok(rule, 'styles.css has no [hidden] rule at all');
  const body = rule[1].replace(/\s/g, '');
  assert.match(
    body,
    /display:none!important/,
    `[hidden] must be display:none!important, got: ${rule[1].trim()}`
  );
});

test('every element using the hidden attribute is covered by that rule', () => {
  // The guard above is global, so this passes as long as it is present. It is
  // here to FAIL LOUDLY if someone ever scopes that rule to a single selector
  // while components elsewhere still rely on `hidden` working.
  const users = [];
  for (const f of jsxFiles(SRC)) {
    const s = readFileSync(f, 'utf8');
    // `hidden={...}` and bare `hidden`, but never `aria-hidden`.
    if (/(?<!aria-)\bhidden(?:=\{|\s*\/?>|\s)/.test(s)) users.push(f.slice(SRC.length + 1));
  }
  if (users.length === 0) return; // nothing relies on it; the guard is harmless
  const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
  assert.match(
    flat,
    /(^|[,}\s])\[hidden\]\s*\{/,
    `these files rely on the hidden attribute, so [hidden] must stay an UNSCOPED rule: ${users.join(', ')}`
  );
});

test('a collapsed chat window is styled to shrink to its header', () => {
  // The other half of the collapse: with the body hidden, the window must also
  // narrow, or three collapsed bars plus the launcher overflow the dock. A
  // rendered check of the geometry lives in scripts/check-chat-dock-render.mjs;
  // this only asserts the rule has not been deleted.
  const flat = CSS.replace(/\s+/g, ' ');
  assert.match(flat, /\.chat-win\.is-min \{[^}]*width:/, '.chat-win.is-min must set a narrower width');
});

test('every badge the JSX renders actually gets a background from somewhere', () => {
  // `.badge` on its own sets shape and type but NO background — every colour
  // lives on a modifier. So a bare `<span className="badge">` renders as
  // unstyled text that still passes the build, ESLint and every unit test. The
  // Activity Log shipped that way for an afternoon and
  // scripts/check-activity-log-render.mjs is what caught it.
  //
  // A badge is satisfied by EITHER a modifier class whose rule sets a
  // background, OR an inline style that sets one — several call sites legitimately
  // do the latter to pick a themed variable directly. Modifiers that only adjust
  // shape (.badge.auto-cancelled sets padding and a cursor, nothing else) are
  // decorators and are not expected to paint, which is why this asks whether ANY
  // source of a background exists rather than requiring every class to provide it.
  const flat = CSS.replace(/\s+/g, ' ');
  // Double backslashes: this is a template literal, so `\.` would collapse to a
  // bare `.` and quietly match any character instead of a literal dot.
  const paints = (mod) => new RegExp(`\\.badge\\.${mod}[ .{][^}]*background`).test(flat);
  const missing = [];

  for (const file of jsxFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    // Only static class strings: a computed `badge ${status}` cannot be resolved
    // here and is covered by the per-status rules instead.
    for (const m of src.matchAll(/className="badge([^"{]*)"([\s\S]{0,240})/g)) {
      const modifiers = m[1].trim().split(/\s+/).filter(Boolean);
      // The inline style, if any, belongs to this same element — stop at the
      // element's closing bracket so a sibling's style cannot vouch for it.
      const rest = m[2].split('>')[0];
      const inlineBackground = /style=\{\{[^}]*background/.test(rest);
      if (inlineBackground) continue;
      if (modifiers.some(paints)) continue;
      missing.push(`${file}: "badge ${modifiers.join(' ')}" has no background — renders as plain text`);
    }
  }

  assert.deepEqual(missing, [], `badges that render as unstyled text:\n  ${missing.join('\n  ')}`);
});
