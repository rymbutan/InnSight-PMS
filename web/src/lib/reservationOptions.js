// Option lists shared by the reservation forms.
//
// These lived as module-local consts in NewReservation.jsx. Quick Edit now edits
// the same columns, and two copies of a booking-source list drift: a source
// added to one form but not the other silently becomes uneditable on the detail
// page. One definition, imported by both.

export const SOURCES = ['DIRECT', 'WALK_IN', 'BOOKING_COM', 'AIRBNB', 'EXPEDIA', 'AGODA', 'OTA'];

export const SOURCE_LABELS = {
  DIRECT: 'Direct',
  WALK_IN: 'Walk-in',
  BOOKING_COM: 'Booking.com',
  AIRBNB: 'Airbnb',
  EXPEDIA: 'Expedia',
  AGODA: 'Agoda',
  OTA: 'Other OTA',
};

// Payment method options moved to lib/paymentMethods.js's paymentMethodGroups()
// — every payment-method <select> in the app (including the one this file
// used to serve) renders from that, grouped so GCash/Maya nest under
// "E-Wallet" instead of sitting flat alongside Cash and Card.

// Shared by NewReservation.jsx and WalkIn.jsx — a walk-in is a booking too,
// just one that skips the future-dated hold, so both wizards collect the same
// special-request/deposit-detail shape.
export const SPECIAL_REQUEST_QUICK_PICKS = [
  'High floor room',
  'Quiet room',
  'Luggage storage',
  'Away from elevator',
  'Near elevator',
  'Car parking',
  'Honeymoon arrangements',
];

export const BANK_NAMES = ['BDO', 'BPI', 'Metrobank', 'UnionBank', 'Landbank', 'OTHER'];
export const TRANSFER_NETWORKS = ['InstaPay', 'PESONet', 'Direct OTC Deposit', 'Wire Transfer', 'OTHER'];
