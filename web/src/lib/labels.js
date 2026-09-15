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

  // Statuses and codes whose words are not independent — the generic rule
  // title-cases each one separately and produces "Out Of Order", "In House",
  // "No Show", "Qr Wallet". Everything whose words DO stand alone
  // ("Bank Transfer", "Meeting Room", "Checked In") is left to fall through.
  IN_HOUSE: 'In-House',
  NOT_IN_HOUSE: 'Not In-House',
  NO_SHOW: 'No-Show',
  PRE_ARRIVAL: 'Pre-Arrival',
  OUT_OF_ORDER: 'Out of Order',
  OUT_OF_SERVICE: 'Out of Service',
  CLEAN_INSPECTED: 'Clean (Inspected)',
  QR_WALLET: 'QR Wallet',
  FRONT_DESK: 'Front Desk',
  HOUSEKEEPING_MAINTENANCE: 'Housekeeping & Maintenance',
};

// WALK_IN -> Walk-in, ONLINE_BOOKING -> Online Booking, DIRECT -> Direct.
//
// Safe to apply anywhere a value is DISPLAYED, including to values that are not
// enums at all: anything that is already prose falls straight through. That is
// deliberate — the fix for "the screen shows BANK_TRANSFER" should be reachable
// by wrapping the render site, without first having to prove what the column
// can contain.
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
