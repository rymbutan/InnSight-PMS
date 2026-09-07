// Decides what Quick Edit should actually call when the user hits Save.
//
// This lives outside the component because the branch is easy to get wrong and
// was wrong before: the modal used to treat "a Stay row exists" as "the guest is
// here" and sent every checkout change to POST /api/stays/:id/extend. But a stay
// is created at PRE_ARRIVAL, before anyone arrives, so a booking that had not
// been checked in took that branch too — and /extend only writes
// Stay.expectedCheckOut. Reservation.checkOut and nights stayed stale (the header
// showed the old dates, which read as "the save did nothing"), and the inventory
// hold for the ORIGINAL range was never re-taken, so the freed nights stayed
// blocked and the new ones were never checked for availability.
//
// Arrival is a status, not the existence of a row.

const TEXT_FIELDS = [
  'source',
  'paymentType',
  'ratePlan',
  'origin',
  'expectedArrivalTime',
  'specialRequests',
];

const day = (v) => (v ? String(v).slice(0, 10) : '');

export function planQuickEdit({ res, stay, form }) {
  const errors = [];

  // Only an IN_HOUSE stay means the guest is actually here. PRE_ARRIVAL is a
  // booking waiting for them; DEPARTED / NO_SHOW are already closed out and the
  // services reject date changes on those themselves.
  const inHouse = stay?.status === 'IN_HOUSE';

  if (form.checkIn && form.checkOut && !(new Date(form.checkOut) > new Date(form.checkIn))) {
    errors.push('Check-out must be after check-in.');
  }
  if (Number(form.adults) < 1) {
    errors.push('A reservation needs at least one adult.');
  }

  const resPatch = {};

  if (Number(form.adults) !== Number(res.adults ?? 1)) resPatch.adults = Number(form.adults);
  if (Number(form.children) !== Number(res.children ?? 0)) resPatch.children = Number(form.children);

  for (const k of TEXT_FIELDS) {
    const before = res[k] || '';
    const after = form[k] || '';
    // An emptied field must clear the column, and Prisma needs null for that —
    // '' would store an empty string that renders as a blank value rather than
    // the '—' placeholder.
    if (after !== before) resPatch[k] = after || null;
  }

  const outMoved = day(form.checkOut) !== day(res.checkOut);
  const inMoved = day(form.checkIn) !== day(res.checkIn);

  // Dates. For a booking nobody has arrived at, the reservation is the record of
  // truth: patch it and let the route recompute nights and re-hold inventory.
  // Once in-house those dates are history and only the expected checkout moves.
  if (!inHouse) {
    if (inMoved) resPatch.checkIn = day(form.checkIn);
    if (outMoved) resPatch.checkOut = day(form.checkOut);
  }

  // Keep the stay's expected checkout aligned whenever one exists, so the
  // arrivals and housekeeping screens do not show a date the reservation no
  // longer has.
  const extendTo = stay && outMoved ? day(form.checkOut) : null;

  return { errors, resPatch, extendTo, checkInLocked: inHouse, inHouse };
}
