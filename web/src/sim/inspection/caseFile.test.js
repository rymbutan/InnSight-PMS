import test from 'node:test';
import assert from 'node:assert';

import { makeCaseFile, DEFECT_IDS } from './caseFile.js';
import { localDay } from '../../lib/date.js';
import { DEFECTS } from './defects.js';

// Deterministic rng so a generated case can be asserted exactly.
function seeded(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

test('injects between 2 and 4 defects', () => {
  for (let i = 1; i < 40; i += 1) {
    const c = makeCaseFile({ roomTier: 'Standard', rng: seeded(i) });
    assert.ok(c.injected.length >= 2 && c.injected.length <= 4, `got ${c.injected.length}`);
  }
});

test('every injected defect is applicable to the case it was injected into', () => {
  for (let i = 1; i < 40; i += 1) {
    const c = makeCaseFile({ roomTier: 'Suite', rng: seeded(i) });
    for (const id of c.injected) {
      const def = DEFECTS.find((d) => d.id === id);
      assert.ok(def, `unknown defect ${id}`);
      assert.ok(def.appliesTo(c), `${id} injected but does not apply to pax=${c.pax}`);
    }
  }
});

test('never injects the same defect twice in one case', () => {
  for (let i = 1; i < 40; i += 1) {
    const c = makeCaseFile({ roomTier: 'Standard', rng: seeded(i) });
    assert.equal(new Set(c.injected).size, c.injected.length);
  }
});

test('every injected id is a known defect id', () => {
  for (let i = 1; i < 20; i += 1) {
    const c = makeCaseFile({ roomTier: 'Standard', rng: seeded(i) });
    for (const id of c.injected) assert.ok(DEFECT_IDS.includes(id), `unknown id ${id}`);
  }
});

test('party composition is internally consistent', () => {
  for (let i = 1; i < 20; i += 1) {
    const c = makeCaseFile({ roomTier: 'Deluxe', rng: seeded(i) });
    assert.equal(c.pax, c.adults + c.children);
    assert.ok(c.adults >= 1);
    assert.ok(c.children >= 0);
  }
});

test('a supplied reservation overrides the synthetic booking but defects still inject', () => {
  const c = makeCaseFile({
    roomTier: 'Standard',
    rng: seeded(5),
    reservation: {
      confirmationNumber: 'R-REAL123',
      guestName: 'Dela Cruz, Maria',
      adults: 2,
      children: 2,
      specialRequests: 'Late arrival, around 11pm.',
    },
  });
  assert.equal(c.confirmationNumber, 'R-REAL123');
  assert.equal(c.guestName, 'Dela Cruz, Maria');
  assert.equal(c.adults, 2);
  assert.equal(c.children, 2);
  assert.equal(c.pax, 4);
  assert.equal(c.specialRequests, 'Late arrival, around 11pm.');
  assert.ok(c.injected.length >= 2);
});

test('a real reservation with no special requests keeps the null rather than inventing one', () => {
  const c = makeCaseFile({
    roomTier: 'Standard',
    rng: seeded(11),
    reservation: {
      confirmationNumber: 'R-NOREQ',
      guestName: 'Reyes, Jose',
      adults: 2,
      children: 0,
      specialRequests: null,
    },
  });
  assert.equal(c.specialRequests, null);
});

test('a real booking that cannot support a relative defect never gets one', () => {
  // Solo guest: room_mismatch (couple) and amenity_math (pax>=3) must not appear.
  const c = makeCaseFile({
    roomTier: 'Standard',
    rng: seeded(21),
    reservation: { confirmationNumber: 'R-SOLO', guestName: 'Solo, A', adults: 1, children: 0 },
  });
  assert.equal(c.pax, 1);
  assert.ok(!c.injected.includes('room_mismatch'));
  assert.ok(!c.injected.includes('amenity_math'));
  assert.ok(c.injected.length >= 2, 'must still produce a usable case');
});

test('a real reservation brings its own dates, not invented ones', () => {
  const c = makeCaseFile({
    roomTier: 'Standard',
    rng: seeded(7),
    reservation: {
      confirmationNumber: 'R-DATES',
      guestName: 'Aquino, Bea',
      adults: 2,
      children: 0,
      nights: 5,
      checkIn: '2027-01-09T07:00:00.000Z',
    },
  });
  assert.equal(c.nights, 5);
  assert.equal(c.arrival, localDay('2027-01-09T07:00:00.000Z'));
  assert.equal(c.fromReservation, true);
});

test('nights are counted from the stay when the reservation does not carry them', () => {
  const c = makeCaseFile({
    roomTier: 'Standard',
    rng: seeded(8),
    reservation: {
      confirmationNumber: 'R-SPAN',
      guestName: 'Ocampo, Carlo',
      adults: 2,
      children: 0,
      checkIn: '2027-01-09T07:00:00.000Z',
      checkOut: '2027-01-12T04:00:00.000Z',
    },
  });
  assert.equal(c.nights, 3);
});

test('a case with no reservation is flagged as a practice booking', () => {
  const c = makeCaseFile({ roomTier: 'Standard', rng: seeded(9) });
  assert.equal(c.fromReservation, false);
  assert.ok(c.guestName, 'a practice booking still needs a guest to inspect against');
  assert.match(c.arrival, /^\d{4}-\d{2}-\d{2}$/);
});

test('two runs with different seeds differ', () => {
  const a = makeCaseFile({ roomTier: 'Standard', rng: seeded(1) });
  const b = makeCaseFile({ roomTier: 'Standard', rng: seeded(999) });
  assert.notDeepEqual(
    { i: a.injected, p: a.pax, g: a.guestName },
    { i: b.injected, p: b.pax, g: b.guestName }
  );
});

test('the same seed reproduces the same case', () => {
  const a = makeCaseFile({ roomTier: 'Standard', rng: seeded(42) });
  const b = makeCaseFile({ roomTier: 'Standard', rng: seeded(42) });
  assert.deepEqual(a, b);
});
