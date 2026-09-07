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

// Matches the deposit form's <option> list on the New Reservation screen.
export const PAYMENT_TYPES = ['Cash', 'Card', 'Bank Transfer', 'GCash'];
