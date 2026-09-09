// The registration card as a testable structure.
//
// Same split as folioPrintModel in the folio service, and for the same reason:
// the layout is pdfkit calls that cannot be asserted on, but WHICH values land
// on the paper is exactly the part that must not regress. The route fetches,
// this decides, the renderer draws.
//
// Everything here degrades. The card is what the desk checks a guest in with,
// so a folio, guest or inventory service that is down must cost the card a
// field, never the page.

const REG_CARD_TITLE = 'InnSight PMS Registration Card';

const MS_PER_DAY = 86400000;

// The ISO code, not '₱'. pdfkit's built-in Helvetica is WinAnsi-encoded and has
// no glyph for U+20B1, so a peso sign printed on the card as '±'. The folio PDF
// already writes `${currency} ${amount}` for the same reason, so the two
// documents agree and neither needs a font file shipped to render one character.
const CURRENCY = 'PHP';

function money(cents) {
  if (cents === null || cents === undefined || cents === '') return '';
  const n = Number(cents);
  if (!Number.isFinite(n)) return '';
  return `${CURRENCY} ${(n / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function mdY(d) {
  if (!d) return '';
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return '';
  const mm = String(t.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(t.getUTCDate()).padStart(2, '0');
  return `${mm}/${dd}/${t.getUTCFullYear()}`;
}

function nightsOf(reservation, stay) {
  const n = Number(reservation?.nights);
  if (Number.isFinite(n) && n > 0) return n;
  const a = stay?.expectedCheckIn ? new Date(stay.expectedCheckIn) : null;
  const b = stay?.expectedCheckOut ? new Date(stay.expectedCheckOut) : null;
  if (!a || !b || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  // Whole nights between calendar days — the clock times on a stay are the
  // expected check-in/out hours and must not round the count up or down.
  const days = Math.round(
    (Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) -
      Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate())) /
      MS_PER_DAY
  );
  return days > 0 ? days : null;
}

function guestName(guest, stay) {
  const full = [guest?.firstName, guest?.lastName].filter(Boolean).join(' ').trim();
  return full || stay?.guestName || '';
}

/**
 * @param {object}   args
 * @param {object}   args.stay          the Stay row (the only required input)
 * @param {object}  [args.reservation]  reservation, for contact + money + nights
 * @param {object}  [args.guest]        guest profile, for name + nationality
 * @param {object}  [args.hotel]        settings/hotel, for the venue block
 * @param {object[]}[args.roomTypes]    inventory room types, for the rate table
 */
function regCardModel({ stay, reservation = null, guest = null, hotel = null, roomTypes = [] }) {
  const nights = nightsOf(reservation, stay);

  const fields = [
    // Country used to print here from guest?.nationality, but nothing in the
    // booking flow ever collects or stores a guest's nationality — New
    // Reservation's "Country" input is the guest's ADDRESS country, and per
    // the Address row below, address fields are dropped by POST /api/guests
    // entirely. The row printed blank on every single card, never a real
    // answer, so it's removed rather than joining Address as a write-in line
    // for a fact nothing in the system has ever actually captured.
    { label: 'Name', value: guestName(guest, stay) },
    // Nothing in the system stores a guest address: Guest has no column for it
    // and New Reservation's address inputs are dropped by POST /api/guests. A
    // write-in line is honest; a blank that looks like missing data is not.
    { label: 'Address', value: '', writeIn: true },
    { label: 'Phone', value: reservation?.guestPhone || '' },
    { label: 'Email', value: reservation?.guestEmail || '' },
  ];

  const venueLines = [hotel?.name, hotel?.address, hotel?.phone, hotel?.email, hotel?.url]
    .map((v) => (v == null ? '' : String(v).trim()))
    .filter(Boolean);

  // The reference form offers 1/2/3 nights as boxes and anything else as a
  // write-in. Keep that, because it is the shape front-desk staff are trained on.
  const options = [1, 2, 3].map((n) => ({ nights: n, label: n === 1 ? '1 Night' : `${n} Nights`, checked: nights === n }));
  const otherNights = nights && nights > 3 ? nights : null;

  const rows = (roomTypes || []).map((t) => ({
    code: t.code,
    name: t.name || t.code,
    rate: money(t.baseRate),
    checked: Boolean(reservation?.roomTypeCode) && t.code === reservation.roomTypeCode,
  }));

  return {
    title: REG_CARD_TITLE,
    confirmationNumber: reservation?.confirmationNumber || '',
    room: stay?.assignedRoomId || '',
    fields,
    venue: { heading: 'HOTEL VENUE', lines: venueLines },
    duration: { heading: 'DURATION OF STAY', options, otherNights, nights },
    rooms: { columns: ['Room Categories', 'Room Rate'], rows },
    notes: [
      'Note: Cancellations made less than 7 days prior to arrival date will be charged for the full ' +
        'one nights accommodation.',
      'No show (failing to arrive at all) will be charged the full amount of the reservation.',
    ],
    schedule: {
      columns: ['Schedule', 'Date', 'Arrival time', 'Flight number'],
      rows: [
        {
          label: 'Arrival',
          date: mdY(stay?.expectedCheckIn),
          time: reservation?.expectedArrivalTime || '',
          // No flight number is captured anywhere in the system.
          flight: '',
        },
        { label: 'Departure', date: mdY(stay?.expectedCheckOut), time: '', flight: '' },
      ],
    },
    totals: { totalCost: money(reservation?.totalEstimateCents) },
  };
}

module.exports = { regCardModel, REG_CARD_TITLE };
