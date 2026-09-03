// ─────────────────────────────────────────────────────────────────────────────
// The case a student is asked to judge.
//
// The whole point of the redesign (Changes-to-be-made doc, item 3) is that the
// room is only wrong RELATIVE TO A BOOKING. Two twin beds is not a fault; two
// twin beds for a couple is. Two towels is not a fault; two towels for a family
// of four is. So the booking is generated FIRST, and only defects that the
// booking can actually support are injected — see the `appliesTo` filter below.
//
// Generating the defects first and the booking second would produce cases that
// contradict themselves (an "amenity shortfall" for a solo guest), which would
// teach students to distrust the clipboard — the exact opposite of the lesson.
//
// ON A REAL ROOM THE BOOKING IS THE REAL RESERVATION. buildClipboard() is the
// single place a clipboard booking is built, for the generated path and the
// authored-scenario path alike — a scenario says what is wrong with the room, it
// does not say who is arriving. Only when there is no reservation at all (a
// Training practice drill has no room) is one invented, and it is flagged
// `fromReservation: false` so the panel can say so.
// ─────────────────────────────────────────────────────────────────────────────

import { DEFECTS } from './defects.js';
import { localDay, nightsBetween } from '../../lib/date.js';

export const DEFECT_IDS = [
  'room_mismatch',
  'amenity_math',
  'blocked_path',
  'lingering_equipment',
  'lived_in',
  'incomplete_stock',
];

const MIN_DEFECTS = 2;
const MAX_DEFECTS = 4;

const SURNAMES = [
  'Dela Cruz',
  'Reyes',
  'Santos',
  'Bautista',
  'Mendoza',
  'Villanueva',
  'Aquino',
  'Ocampo',
  'Salazar',
  'Navarro',
];
const GIVEN = ['Maria', 'Jose', 'Ana', 'Paolo', 'Liza', 'Ramon', 'Bea', 'Carlo', 'Grace', 'Miguel'];

// Requests a front desk would really record. Deliberately a mix: some bear on a
// defect (a couple expecting one bed), some are pure noise. A student must
// decide which matter — being handed only load-bearing information would let
// them work backwards from the clipboard instead of inspecting the room.
const REQUESTS = [
  null,
  null,
  'Honeymoon trip — please set the room up for a couple.',
  'Travelling with two young children; extra towels appreciated.',
  'Late arrival, around 11pm.',
  'Guest is a light sleeper — room away from the lift was requested.',
  'Anniversary stay; welcome amenity requested.',
  'Early check-in requested if the room is ready.',
];

// Fisher-Yates. `sort(() => 0.5 - rng())` is NOT uniform and has already caused
// a real randomisation bug in this codebase (see MINIGAMES_REBUILD.md).
function shuffle(list, rng) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const pick = (list, rng) => list[Math.floor(rng() * list.length)];
const intBetween = (lo, hi, rng) => lo + Math.floor(rng() * (hi - lo + 1));

function confirmationNumber(rng) {
  const hex = '0123456789ABCDEF';
  let s = '';
  for (let i = 0; i < 8; i += 1) s += hex[Math.floor(rng() * 16)];
  return `R-${s}`;
}

function arrivalDate(rng) {
  // A plain date string; the clipboard only ever displays it.
  const month = intBetween(1, 12, rng);
  const day = intBetween(1, 28, rng);
  return `2027-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Party sizes weighted toward the compositions the defects can teach against:
// a couple (room mismatch) and a family (amenity math).
function makeParty(rng) {
  const roll = rng();
  if (roll < 0.4) return { adults: 2, children: 0 };
  if (roll < 0.7) return { adults: 2, children: 2 };
  if (roll < 0.85) return { adults: 3, children: 0 };
  if (roll < 0.95) return { adults: 2, children: 1 };
  return { adults: 1, children: 0 };
}

/**
 * Build one inspection case.
 *
 * @param {object}   opts
 * @param {string}   opts.roomTier      Standard | Deluxe | Suite | Presidential
 * @param {function} [opts.rng]         injectable for deterministic tests
 * @param {object}   [opts.reservation] real PMS reservation; its fields win over
 *                                      the synthetic ones (Housekeeping path)
 */
export function makeCaseFile({ roomTier = 'Standard', rng = Math.random, reservation = null } = {}) {
  // Draw a party that supports at least MIN_DEFECTS. Every defect but the two
  // booking-relative ones applies unconditionally, so this converges instantly;
  // the retry only exists so a future, pickier defect set cannot silently
  // produce a one-defect case.
  let party = makeParty(rng);
  let candidates = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const probe = buildBooking({ party, roomTier, rng, reservation });
    candidates = DEFECTS.filter((d) => d.appliesTo(probe));
    if (candidates.length >= MIN_DEFECTS) break;
    party = { adults: 2, children: 2 }; // widen: supports both relative defects
  }

  const booking = buildBooking({ party, roomTier, rng, reservation });
  const howMany = Math.min(intBetween(MIN_DEFECTS, MAX_DEFECTS, rng), candidates.length);
  const injected = shuffle(candidates, rng)
    .slice(0, howMany)
    .map((d) => d.id);

  return { ...booking, injected };
}

/**
 * The clipboard booking, from the real reservation where there is one.
 *
 * The one place this is built. The authored path calls it too — see
 * fromScenario() — because a scenario is reused across rooms and cannot know
 * the guest standing in any of them.
 *
 * @param {object}   opts
 * @param {string}   opts.roomTier
 * @param {function} [opts.rng]
 * @param {object}   [opts.reservation] a row from /api/reservations
 * @param {object}   [opts.party] force the synthetic party; the authored path
 *                                uses this to invent a booking its faults fit
 */
export function buildClipboard({
  roomTier = 'Standard',
  rng = Math.random,
  reservation = null,
  party = null,
} = {}) {
  // A party is always resolved, reservation or not, so a reservation row missing
  // a field degrades to a sensible value rather than a blank clipboard.
  return buildBooking({ party: party || makeParty(rng), roomTier, rng, reservation });
}

function buildBooking({ party, roomTier, rng, reservation }) {
  const adults = Number.isInteger(reservation?.adults) ? reservation.adults : party.adults;
  const children = Number.isInteger(reservation?.children) ? reservation.children : party.children;
  return {
    confirmationNumber: reservation?.confirmationNumber || confirmationNumber(rng),
    guestName: reservation?.guestName || `${pick(SURNAMES, rng)}, ${pick(GIVEN, rng)}`,
    adults,
    children,
    pax: adults + children,
    roomTier,
    // A real guest's dates, not invented ones. Showing a fabricated arrival
    // beside a real guest name is the worst of both: it reads as authoritative
    // and it is wrong, and a student who checks it against the PMS learns to
    // distrust the clipboard. Falls back to the synthetic draws in the same
    // order as before, so a generated case is unchanged.
    nights: nightsOf(reservation, rng),
    arrival: reservation?.checkIn ? localDay(reservation.checkIn) : arrivalDate(rng),
    // `undefined` means "not supplied"; an explicit null on a real reservation
    // means "no requests on file", and both render the same on the clipboard.
    specialRequests:
      reservation && 'specialRequests' in reservation ? reservation.specialRequests : pick(REQUESTS, rng),
    // Whether the student is judging the room against a real arriving guest or a
    // practice booking. The clipboard prints this; a student must never be left
    // guessing which one they are looking at.
    fromReservation: !!reservation,
  };
}

function nightsOf(reservation, rng) {
  if (Number.isInteger(reservation?.nights) && reservation.nights > 0) return reservation.nights;
  if (reservation?.checkIn && reservation?.checkOut) {
    return nightsBetween(reservation.checkIn, reservation.checkOut);
  }
  return intBetween(1, 4, rng);
}
