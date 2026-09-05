// Turning stored enum codes into text a person reads.
//
// The API stores booking sources, statuses and categories as SCREAMING_SNAKE
// constants, and several screens were printing them raw — a reservation from
// the front desk showed as "WALK_IN". The database value is the right thing to
// store; it is the wrong thing to display.

// Names that title-casing would get wrong. Everything else falls through to the
// generic rule, so a source added on the server reads correctly without a
// frontend change.
const SPECIAL = {
  WALK_IN: 'Walk-in',
  BOOKING_COM: 'Booking.com',
  OTA: 'OTA',
  AIRBNB: 'Airbnb',
  GCASH: 'GCash',
  VIP: 'VIP',
};

// WALK_IN -> Walk-in, ONLINE_BOOKING -> Online Booking, DIRECT -> Direct.
export function labelize(code) {
  if (code === null || code === undefined || code === '') return '';
  const raw = String(code).trim();
  if (SPECIAL[raw.toUpperCase()]) return SPECIAL[raw.toUpperCase()];
  // Only reformat if it actually looks like a constant. A value that is already
  // prose ("Front desk") must be left exactly as it is.
  if (!/^[A-Z0-9]+(_[A-Z0-9]+)*$/.test(raw)) return raw;
  return raw
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}
