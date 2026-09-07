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
  assert.ok(plan.errors.some((e) => /after check-in/i.test(e)), plan.errors.join(';'));
});

test('a reservation needs at least one adult', () => {
  const plan = planQuickEdit({ res, stay: null, form: pristine({ adults: 0 }) });
  assert.ok(plan.errors.some((e) => /adult/i.test(e)), plan.errors.join(';'));
});

test('cleared text fields are sent as null, not empty string', () => {
  const withOrigin = { ...res, origin: 'Booking.com' };
  const plan = planQuickEdit({ res: withOrigin, stay: null, form: pristine({ origin: '' }) });
  assert.strictEqual(plan.resPatch.origin, null);
});
