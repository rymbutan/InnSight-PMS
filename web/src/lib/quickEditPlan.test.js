import test from 'node:test';
import assert from 'node:assert/strict';

import { planQuickEdit } from './quickEditPlan.js';

const res = {
  id: 'r1',
  checkIn: '2026-08-30T00:00:00.000Z',
  checkOut: '2026-08-31T00:00:00.000Z',
  adults: 2,
  children: 0,
  source: 'WALK_IN',
  paymentType: null,
  ratePlan: null,
  origin: null,
  expectedArrivalTime: null,
  specialRequests: null,
};

// The form as the modal seeds it — i.e. nothing edited yet.
function pristine(over = {}) {
  return {
    checkIn: '2026-08-30',
    checkOut: '2026-08-31',
    adults: 2,
    children: 0,
    source: 'WALK_IN',
    paymentType: '',
    ratePlan: '',
    origin: '',
    expectedArrivalTime: '',
    specialRequests: '',
    ...over,
  };
}

test('an untouched form produces no calls at all', () => {
  const plan = planQuickEdit({ res, stay: null, form: pristine() });
  assert.deepStrictEqual(plan.errors, []);
  assert.deepStrictEqual(plan.resPatch, {});
  assert.strictEqual(plan.extendTo, null);
});

test('changed scalar fields go into the reservation patch, unchanged ones do not', () => {
  const plan = planQuickEdit({
    res,
    stay: null,
    form: pristine({ adults: 3, origin: 'Booking.com' }),
  });
  assert.deepStrictEqual(plan.resPatch, { adults: 3, origin: 'Booking.com' });
});

// The bug this module exists to prevent: a PRE_ARRIVAL stay is not an arrival.
// Routing its date change to /extend moved the stay's expected checkout and left
// Reservation.checkOut and nights stale, so the header never changed — and the
// inventory hold for the old range was never re-taken.
test('a pre-arrival stay patches the reservation AND syncs the stay', () => {
  const plan = planQuickEdit({
    res,
    stay: { id: 's1', status: 'PRE_ARRIVAL' },
    form: pristine({ checkOut: '2026-09-02' }),
  });
  assert.strictEqual(plan.resPatch.checkOut, '2026-09-02');
  assert.strictEqual(plan.extendTo, '2026-09-02');
});

test('an in-house stay extends the stay and does not repatch reservation dates', () => {
  const plan = planQuickEdit({
    res,
    stay: { id: 's1', status: 'IN_HOUSE' },
    form: pristine({ checkOut: '2026-09-02' }),
  });
  assert.strictEqual(plan.extendTo, '2026-09-02');
  assert.strictEqual(plan.resPatch.checkOut, undefined);
  assert.strictEqual(plan.resPatch.checkIn, undefined);
});

test('check-in is locked only once the guest is actually in-house', () => {
  assert.strictEqual(planQuickEdit({ res, stay: null, form: pristine() }).checkInLocked, false);
  assert.strictEqual(
    planQuickEdit({ res, stay: { id: 's1', status: 'PRE_ARRIVAL' }, form: pristine() }).checkInLocked,
    false
  );
  assert.strictEqual(
    planQuickEdit({ res, stay: { id: 's1', status: 'IN_HOUSE' }, form: pristine() }).checkInLocked,
    true
  );
});

test('a pre-arrival check-in change is sent; an in-house one is dropped', () => {
  const early = planQuickEdit({
    res,
    stay: { id: 's1', status: 'PRE_ARRIVAL' },
    form: pristine({ checkIn: '2026-08-28' }),
  });
  assert.strictEqual(early.resPatch.checkIn, '2026-08-28');

  const inHouse = planQuickEdit({
    res,
    stay: { id: 's1', status: 'IN_HOUSE' },
    form: pristine({ checkIn: '2026-08-28' }),
  });
  assert.strictEqual(inHouse.resPatch.checkIn, undefined);
});

test('check-out on or before check-in is rejected', () => {
  const plan = planQuickEdit({ res, stay: null, form: pristine({ checkOut: '2026-08-30' }) });
  assert.ok(
    plan.errors.some((e) => /after check-in/i.test(e)),
    plan.errors.join(';')
  );
});

test('a reservation needs at least one adult', () => {
  const plan = planQuickEdit({ res, stay: null, form: pristine({ adults: 0 }) });
  assert.ok(
    plan.errors.some((e) => /adult/i.test(e)),
    plan.errors.join(';')
  );
});

test('cleared text fields are sent as null, not empty string', () => {
  const withOrigin = { ...res, origin: 'Booking.com' };
  const plan = planQuickEdit({ res: withOrigin, stay: null, form: pristine({ origin: '' }) });
  assert.strictEqual(plan.resPatch.origin, null);
});

// Mandatory Downpayment Constraint: this field is how staff record a deposit
// against a publicly-created booking (which starts with none at all), so it
// can later be confirmed. Leaving it blank must not be read as "set it to 0".
test('a blank deposit field sends nothing — it is not an attempt to zero it out', () => {
  const plan = planQuickEdit({ res: { ...res, depositCents: 0n }, stay: null, form: pristine() });
  assert.strictEqual(plan.resPatch.depositCents, undefined);
  assert.deepStrictEqual(plan.errors, []);
});

test('recording a deposit sends depositCents in centavos', () => {
  const plan = planQuickEdit({
    res: { ...res, depositCents: 0n },
    stay: null,
    form: pristine({ depositPesos: '500' }),
  });
  assert.strictEqual(plan.resPatch.depositCents, 50000);
  assert.deepStrictEqual(plan.errors, []);
});

test('a zero or negative deposit is rejected before it reaches the server', () => {
  const plan = planQuickEdit({
    res: { ...res, depositCents: 0n },
    stay: null,
    form: pristine({ depositPesos: '0' }),
  });
  assert.ok(
    plan.errors.some((e) => /greater than 0/i.test(e)),
    plan.errors.join(';')
  );
  assert.strictEqual(plan.resPatch.depositCents, undefined);
});

test('an unchanged deposit is not resent', () => {
  const plan = planQuickEdit({
    res: { ...res, depositCents: 50000n },
    stay: null,
    form: pristine({ depositPesos: '500' }),
  });
  assert.strictEqual(plan.resPatch.depositCents, undefined);
});
