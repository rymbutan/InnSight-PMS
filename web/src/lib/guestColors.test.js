import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PALETTE_LIGHT,
  PALETTE_DARK,
  SLOTS,
  assignSlots,
  colorFor,
  contrast,
  guestKey,
  inkOn,
} from './guestColors.js';

const names = (n) => Array.from({ length: n }, (_, i) => `Guest ${i}`);

// ── The requirement ─────────────────────────────────────────────────────────

test('no two guests share a colour, up to the palette size', () => {
  for (let n = 1; n <= SLOTS; n += 1) {
    const map = assignSlots(names(n));
    const used = [...map.values()];
    assert.equal(used.length, n, `${n} guests placed`);
    assert.equal(new Set(used).size, n, `${n} guests got ${new Set(used).size} distinct colours`);
  }
});

test('a realistic board of fourteen bookings is fully distinct', () => {
  const guests = [
    'Dela Cruz, Maria', 'Reyes, Paolo', 'Santos, Grace', 'Bautista, Ramon',
    'Mendoza, Liza', 'Villanueva, Carlo', 'Aquino, Bea', 'Ocampo, Miguel',
    'Salazar, Ana', 'Navarro, Jose', 'Cruz, Elena', 'Lim, Anthony',
    'Garcia, Rosa', 'Torres, Danilo',
  ];
  const map = assignSlots(guests);
  assert.equal(new Set(map.values()).size, guests.length);
});

test('past the palette size colours repeat rather than being invented', () => {
  // Generating a 17th hue is what makes a board unreadable for a colour-blind
  // user. Every bar carries the guest's name, so a repeat costs a glance.
  const map = assignSlots(names(SLOTS + 6));
  assert.equal(map.size, SLOTS + 6);
  for (const slot of map.values()) {
    assert.ok(Number.isInteger(slot) && slot >= 0 && slot < SLOTS);
  }
});

// ── Stability ───────────────────────────────────────────────────────────────

test('the same guests always produce the same board', () => {
  const a = assignSlots(names(12));
  const b = assignSlots(names(12));
  assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort());
});

test('the order bookings arrive in does not change the colours', () => {
  const forward = names(12);
  const backward = [...forward].reverse();
  assert.deepEqual([...assignSlots(forward).entries()].sort(), [...assignSlots(backward).entries()].sort());
});

test('most guests keep their colour when the week changes', () => {
  // Hashing first and only moving actual collisions is the point: assigning by
  // position on screen would repaint everyone whenever the view scrolled.
  const week1 = names(10);
  const week2 = [...names(10).slice(3), 'Guest 97', 'Guest 98', 'Guest 99'];
  const a = assignSlots(week1);
  const b = assignSlots(week2);
  const shared = week1.filter((k) => b.has(k));
  const kept = shared.filter((k) => a.get(k) === b.get(k)).length;
  assert.ok(kept >= shared.length - 2, `only ${kept}/${shared.length} guests kept their colour`);
});

test('duplicate bookings for one guest share that guest’s colour', () => {
  // The same person in two rooms is one identity, not two.
  const map = assignSlots(['Reyes, Paolo', 'Reyes, Paolo', 'Santos, Grace']);
  assert.equal(map.size, 2);
});

test('blank keys are ignored rather than claiming a slot', () => {
  const map = assignSlots(['A', '', null, undefined, 'B']);
  assert.deepEqual([...map.keys()].sort(), ['A', 'B']);
});

test('an empty board assigns nothing', () => {
  assert.equal(assignSlots([]).size, 0);
  assert.equal(assignSlots(undefined).size, 0);
});

// ── Identity ────────────────────────────────────────────────────────────────

test('a guest record beats the name, so one person keeps one colour', () => {
  // Two bookings under slightly different spellings are still one guest.
  assert.equal(guestKey({ guestId: 'g1', guestName: 'Reyes, Paolo' }), 'g1');
  assert.equal(guestKey({ guestId: 'g1', guestName: 'REYES, P.' }), 'g1');
});

test('a walk-in with no guest record falls back to the name', () => {
  assert.equal(guestKey({ guestName: 'Walk, In' }), 'Walk, In');
  assert.equal(guestKey({ label: 'OOO' }), 'OOO');
  assert.equal(guestKey(null), '');
});

// ── Palette integrity ───────────────────────────────────────────────────────

test('both modes offer the same number of slots', () => {
  assert.equal(PALETTE_LIGHT.length, SLOTS);
  assert.equal(PALETTE_DARK.length, SLOTS);
});

test('no colour is repeated inside a mode', () => {
  assert.equal(new Set(PALETTE_LIGHT).size, SLOTS);
  assert.equal(new Set(PALETTE_DARK).size, SLOTS);
});

test('every entry is a real six-digit hex', () => {
  for (const hex of [...PALETTE_LIGHT, ...PALETTE_DARK]) {
    assert.match(hex, /^#[0-9a-f]{6}$/, hex);
  }
});

test('colorFor picks the palette for the mode and never runs off the end', () => {
  assert.equal(colorFor(0, false), PALETTE_LIGHT[0]);
  assert.equal(colorFor(0, true), PALETTE_DARK[0]);
  assert.equal(colorFor(SLOTS + 3, false), PALETTE_LIGHT[3]);
  assert.equal(colorFor(-1, false), PALETTE_LIGHT[SLOTS - 1]);
});

// ── Readability ─────────────────────────────────────────────────────────────

test('the guest name is readable on every colour in the palette', () => {
  // The name is what makes a repeated colour harmless, so it is the one thing
  // that must never be hard to read. 4.5:1 is the WCAG floor for body text.
  for (const hex of [...PALETTE_LIGHT, ...PALETTE_DARK]) {
    const ratio = contrast(hex, inkOn(hex));
    assert.ok(ratio >= 4.5, `${hex} on ${inkOn(hex)} is only ${ratio.toFixed(2)}:1`);
  }
});

test('ink is whichever of the two actually reads better', () => {
  // Not a luminance threshold: slot 1's blue looks like a "use white" colour and
  // is not — white on it is 4.42:1, near-black 4.8:1.
  assert.equal(inkOn('#eda100'), '#10151c'); // yellow — obvious
  assert.equal(inkOn('#4a3aa7'), '#ffffff'); // violet — obvious
  for (const hex of [...PALETTE_LIGHT, ...PALETTE_DARK]) {
    const chosen = inkOn(hex);
    const other = chosen === '#10151c' ? '#ffffff' : '#10151c';
    assert.ok(contrast(hex, chosen) >= contrast(hex, other), `${hex} picked the worse ink`);
  }
});
