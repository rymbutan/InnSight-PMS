import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────────
// Every icon name the app asks for must exist in Icon.jsx.
//
// WHY THIS EXISTS
// ---------------
// Icon renders an EMPTY SPAN for a name it does not know:
//
//   const path = PATHS[name];
//   if (!path) return <span style={{ width: size, height: size }} />;
//
// That is the right runtime behaviour — a missing glyph must not throw and must
// not collapse the layout — but it means a typo or a new name nobody added is
// completely silent. The build passes, ESLint passes, the tests pass, and the
// button just has nothing in it. That shipped twice in one day: `history` for
// the Activity Log sidebar entry and `minimize` for the Messages "Open in dock"
// button, both caught by eye rather than by anything automatic.
//
// So: walk the JSX for static icon names, walk the nav catalogue for the ones it
// declares, and assert every one of them resolves.
// ─────────────────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');
const ROOT = join(SRC, '..');
const ICON_SRC = readFileSync(join(SRC, 'components/Icon.jsx'), 'utf8');

// The keys of the PATHS object: `name:` or `'name-with-dashes':` at one level of
// indentation. Anchored to two spaces so nested SVG attributes cannot match.
const DEFINED = new Set([...ICON_SRC.matchAll(/^ {2}'?([a-z0-9-]+)'?:\s*\(/gm)].map((m) => m[1]));

function jsxFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) jsxFiles(full, out);
    else if (name.endsWith('.jsx')) out.push(full);
  }
  return out;
}

test('Icon.jsx exposes a parseable set of names (guards the guard)', () => {
  // If the regex above ever stops matching the file's shape, every test below
  // would report every icon as missing — or, worse, a rewrite could make DEFINED
  // empty and the failure would look like an app-wide bug rather than a test bug.
  assert.ok(DEFINED.size > 30, `only parsed ${DEFINED.size} icon names out of Icon.jsx`);
  for (const known of ['x', 'chevron-down', 'message-circle', 'maximize']) {
    assert.ok(DEFINED.has(known), `expected to parse the well-known "${known}" icon`);
  }
});

test('every static <Icon name="..."> in the app resolves to a real glyph', () => {
  const missing = [];
  for (const file of jsxFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    // Static string names only. `name={n.icon}` and other expressions cannot be
    // resolved here — the nav catalogue's are covered by the next test, and the
    // rest are computed from values this file cannot see.
    for (const m of src.matchAll(/<Icon\b[^>]*?\bname="([^"]+)"/g)) {
      if (!DEFINED.has(m[1])) missing.push(`${relative(ROOT, file)}: <Icon name="${m[1]}" />`);
    }
  }
  assert.deepEqual(missing, [], `icon names with no glyph — these render blank:\n  ${missing.join('\n  ')}`);
});

test('every icon the nav catalogue declares resolves to a real glyph', () => {
  // navSections.json feeds `<Icon name={n.icon} />` in Layout.jsx, which the
  // static scan above cannot follow. This is where the Activity Log's missing
  // `history` glyph would have been caught.
  const catalogue = JSON.parse(readFileSync(join(SRC, 'lib/navSections.json'), 'utf8'));
  const missing = [];
  for (const section of catalogue.sections) {
    for (const item of section.items) {
      if (item.icon && !DEFINED.has(item.icon)) {
        missing.push(`navSections.json: "${item.key}" declares icon "${item.icon}"`);
      }
    }
  }
  assert.deepEqual(missing, [], `nav icons with no glyph — these render blank:\n  ${missing.join('\n  ')}`);
});
