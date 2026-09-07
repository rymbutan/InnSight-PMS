const test = require('node:test');
const assert = require('node:assert');

const { TIER_KEY, badTier } = require('./tierKey');

// This rule regressed once already: layouts.routes.js briefly went back to a
// hardcoded whitelist of the four built-in tiers, which meant every layout for a
// user-created room type failed to save with "Unknown room tier." Nothing caught
// it, because nothing tested it. These are that test.
test('the four built-in tiers are accepted', () => {
  for (const t of ['Standard', 'Deluxe', 'Suite', 'Presidential']) {
    assert.strictEqual(badTier(t), false, `${t} should be a valid tier`);
  }
});

// Room types ARE user-created (Rooms → Create room type), so a layout key can be
// any room-type name the property invented. Validity is a matter of SHAPE, never
// of membership in a list.
test('a room type the property invented is accepted', () => {
  for (const t of ['Cabana', 'Ocean View', 'Family Room 2', 'accessible-king', 'Loft_A', 'A']) {
    assert.strictEqual(badTier(t), false, `${t} should be a valid tier`);
  }
});

test('shapes that could break a URL or a column are rejected', () => {
  for (const t of [
    '',            // empty
    ' Leading',    // must start alphanumeric
    '-Leading',
    'Slash/Name',  // would split the route path
    'Question?',
    'Hash#1',
    'Percent%20',
    'Quote"Name',
    'a'.repeat(41), // over the 40-char cap
  ]) {
    assert.strictEqual(badTier(t), true, `${JSON.stringify(t)} should be rejected`);
  }
});

test('non-strings are rejected rather than coerced', () => {
  for (const t of [undefined, null, 42, {}, [], true]) {
    assert.strictEqual(badTier(t), true, `${JSON.stringify(t)} should be rejected`);
  }
});

test('the exported pattern is what the web forms are kept in sync with', () => {
  // web/src/pages/RoomLayouts.jsx (KEY_RE) and web/src/sim/RoomLayoutEditor.jsx
  // both carry this literal so a bad name costs no round trip. If this changes,
  // change those too.
  assert.strictEqual(TIER_KEY.source, '^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$');
});
