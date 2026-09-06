import test from 'node:test';
import assert from 'node:assert/strict';

import { HEAT_LEGEND, heatFill, heatInk, heatTitle, occupancyOf } from './outlookHeat.js';

test('occupancy normalises across room types of different sizes', () => {
  // The whole reason for colouring by occupancy rather than the raw count: 3 of
  // 3 suites sold and 24 of 24 standards sold are the same fact.
  assert.equal(occupancyOf(0, 3), 1);
  assert.equal(occupancyOf(0, 24), 1);
  assert.equal(occupancyOf(3, 3), 0);
  assert.equal(occupancyOf(12, 24), 0.5);
});

test('a type with no inventory reads as empty, not as sold out', () => {
  assert.equal(occupancyOf(0, 0), 0);
  assert.equal(heatFill(occupancyOf(0, 0)), 'var(--heat-0)');
});

test('availability outside the inventory is clamped rather than trusted', () => {
  assert.equal(occupancyOf(-5, 10), 1);
  assert.equal(occupancyOf(99, 10), 0);
});

// Direction is no longer asserted here: the ramp runs pale→deep in light mode
// and dim→bright in dark, because a deep blue on a deep-navy page reads as the
// empty end. What must hold either way is that every band is its own step.
test('every occupancy band gets its own step', () => {
  const fills = [0, 0.2, 0.4, 0.6, 0.9, 1].map(heatFill);
  assert.equal(new Set(fills).size, 6, 'each band is its own step');
  assert.equal(fills[0], 'var(--heat-0)');
  assert.equal(fills[5], 'var(--heat-5)');
});

test('sold out is its own step, distinct from merely busy', () => {
  // The operational difference that matters: 99% full still has a room to sell.
  assert.notEqual(heatFill(0.99), heatFill(1));
});

test('a nearly-empty type is not painted as empty', () => {
  assert.notEqual(heatFill(0), heatFill(0.05));
});

test('each step carries its own paired ink', () => {
  // The ink token must match the fill token index-for-index. This is what the
  // old implementation could not express: it matched the fill against two
  // hard-coded hexes and let everything else fall through to var(--text), so in
  // dark mode — where --text is near-white — the pale steps rendered white on
  // pale blue at 1.26:1.
  assert.equal(heatInk(0), 'var(--heat-0-ink)');
  assert.equal(heatInk(0.4), 'var(--heat-2-ink)');
  assert.equal(heatInk(0.9), 'var(--heat-4-ink)');
  assert.equal(heatInk(1), 'var(--heat-5-ink)');
});

test('ink is always a token, never a literal colour', () => {
  // A raw hex here cannot follow the theme, which is precisely how the dark-mode
  // heatmap became unreadable. Six distinct inks, every one themeable.
  const inks = [0, 0.1, 0.3, 0.6, 0.9, 1].map(heatInk);
  for (const ink of inks) assert.match(ink, /^var\(--heat-\d-ink\)$/, `${ink} is not a token`);
  assert.equal(new Set(inks).size, 6, 'each step has its own ink');
});

test('the legend covers every step the ramp can produce', () => {
  const produced = new Set([0, 0.1, 0.3, 0.6, 0.9, 1].map(heatFill));
  const legend = new Set(HEAT_LEGEND.map((l) => l.fill));
  for (const f of produced) assert.ok(legend.has(f), `${f} is not in the legend`);
  assert.equal(HEAT_LEGEND.length, 6);
});

test('the tooltip says what the number means in words', () => {
  const t = heatTitle('Standard', new Date('2026-09-01T00:00:00'), 20, 24);
  assert.match(t, /Standard/);
  assert.match(t, /20 of 24 left/);
  assert.match(t, /4 sold/);
  assert.match(t, /17% full/);
});

test('a sold-out tooltip reads as 100%', () => {
  assert.match(
    heatTitle('Suite', new Date('2026-09-01T00:00:00'), 0, 6),
    /0 of 6 left · 6 sold \(100% full\)/
  );
});

test('bad numbers do not produce NaN on screen', () => {
  assert.equal(occupancyOf(undefined, undefined), 0);
  assert.equal(heatFill(NaN), 'var(--heat-0)');
  assert.doesNotMatch(heatTitle('X', new Date(), undefined, undefined), /NaN/);
});
