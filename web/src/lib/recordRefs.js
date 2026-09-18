// ─────────────────────────────────────────────────────────────────────────────
// Record references in messages: a reservation, a folio or a guest profile
// attached to a chat message, drawn as a chip that opens the record in place.
//
// WHY A STRUCTURED REFERENCE AND NOT A PASTED LINK
// ------------------------------------------------
// Staff could paste `/folios?id=<uuid>` and the transcript could linkify it.
// But a chip that says only a URL tells the reader nothing about WHOSE bill it
// is, and the day a route is renamed every message that ever pointed at a
// record stops working. So a message carries what it points at (type + id)
// and a snapshot of how to name it (label + sub), captured from the record at
// send time. The chip renders from the message alone — ten chips on screen are
// not ten lookups — and still reads correctly after the record is renamed,
// closed or deleted.
//
// Where the chip GOES is decided here, at render time, from the type and id.
// That is the other half of the argument against storing a URL: the route
// table is the app's to change.
//
// The server-side twin is services/messaging/src/lib/recordRef.js. The two
// agree on the three type codes by hand; the browser and the service do not
// share a module system, and it is three strings.
//
// PURE. No React, no API — recordRefs.test.js covers it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything the UI needs to know about each type of record a message can
 * point at. `path` is the in-app route that opens one; `roles` are who may
 * look one up (mirrors the GET guards on the owning service — reservation and
 * folio are DESK_AUDIT, guest is DESK), which decides which tabs the picker
 * shows a given user.
 */
export const RECORD_TYPES = Object.freeze({
  RESERVATION: Object.freeze({
    noun: 'reservation',
    label: 'Reservation',
    icon: 'book-marked',
    path: (id) => `/reservations/${encodeURIComponent(id)}`,
    roles: ['ADMIN', 'MANAGER', 'FRONT_DESK', 'AUDITOR'],
    // GET /api/reservations with no term is the whole upcoming book, oldest
    // first — not a useful "recent" list, so the picker asks for a term.
    search: (q) => (q ? `/api/reservations?q=${encodeURIComponent(q)}` : null),
    searchHint: 'Type a guest name or confirmation number',
  }),
  FOLIO: Object.freeze({
    noun: 'folio',
    label: 'Folio',
    icon: 'file-text',
    // The query-string form, not /folios/:id — it is the one Arrivals already
    // uses and the Folios page reads on every change of the search params.
    path: (id) => `/folios?id=${encodeURIComponent(id)}`,
    roles: ['ADMIN', 'MANAGER', 'FRONT_DESK', 'AUDITOR'],
    // A blank term returns the most recent folios, which is what you want
    // when the one you mean was opened a minute ago.
    search: (q) => `/api/folios?q=${encodeURIComponent(q || '')}`,
    searchHint: 'Search by folio number or guest name',
  }),
  GUEST: Object.freeze({
    noun: 'guest',
    label: 'Guest',
    icon: 'user',
    path: (id) => `/guests?id=${encodeURIComponent(id)}`,
    roles: ['ADMIN', 'MANAGER', 'FRONT_DESK'],
    search: (q) => `/api/guests/search?q=${encodeURIComponent(q || '')}`,
    searchHint: 'Search by name or profile number',
  }),
});

/** The type codes in the order the picker shows them. */
export const RECORD_TYPE_ORDER = Object.freeze(['RESERVATION', 'FOLIO', 'GUEST']);

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Everything a chip needs, from the four stored fields: the route to open, the
 * icon, the type's display name. Null for anything that is not a reference.
 */
export function resolveRef(ref) {
  const type = str(ref?.type).toUpperCase();
  const meta = RECORD_TYPES[type];
  const id = str(ref?.id);
  if (!meta || !id) return null;
  return {
    type,
    id,
    label: str(ref?.label) || meta.label,
    sub: str(ref?.sub) || null,
    path: meta.path(id),
    icon: meta.icon,
    typeLabel: meta.label,
  };
}

/** The reference a message row carries, resolved, or null. */
export function refOf(message) {
  if (!message?.refType) return null;
  return resolveRef({
    type: message.refType,
    id: message.refId,
    label: message.refLabel,
    sub: message.refSub,
  });
}

/** The fields the send request carries — nothing the UI resolved for itself. */
export function refPayload(ref) {
  if (!ref) return undefined;
  return { type: ref.type, id: ref.id, label: ref.label, sub: ref.sub ?? null };
}

/** Two references point at the same record. */
export function sameRef(a, b) {
  if (!a || !b) return a === b;
  return a.type === b.type && a.id === b.id;
}

/** "Shared folio: Folio F-2026-0012" — a body stand-in for an attachment-only
 *  message, for the places that show a one-line preview. */
export function refPreview(ref) {
  if (!ref) return '';
  const noun = RECORD_TYPES[ref.type]?.noun || 'record';
  return ref.label ? `Shared ${noun}: ${ref.label}` : `Shared a ${noun}`;
}

// ── Building a reference from a record ──────────────────────────────────────
// One function per type so the label convention lives in exactly one place:
// the picker, the share buttons and the tests all go through these.

/** From a reservation row (the list or the detail response). */
export function reservationRef(r) {
  if (!r?.id) return null;
  const name = str(r.guestName);
  const conf = str(r.confirmationNumber);
  return {
    type: 'RESERVATION',
    id: String(r.id),
    label: name || conf || 'Reservation',
    // The confirmation number is the sub-line when the name took the label;
    // when there is no name it IS the label, and repeating it would be noise.
    sub: name && conf ? conf : null,
  };
}

/**
 * From a folio row. `guestName` may be passed for the detail view, which
 * derives the name to show from the payer, the reservation and the stay
 * (Folios.jsx's headerGuestName); the list rows carry `guestName` themselves.
 */
export function folioRef(f, guestName) {
  if (!f?.id) return null;
  const number = str(f.folioNumber);
  return {
    type: 'FOLIO',
    id: String(f.id),
    label: number ? `Folio ${number}` : 'Folio',
    sub: str(guestName) || str(f.payerName) || str(f.guestName) || null,
  };
}

/** From a guest profile. */
export function guestRef(g) {
  if (!g?.id) return null;
  const name = str(g.displayName) || `${str(g.firstName)} ${str(g.lastName)}`.trim();
  const number = str(g.profileNumber);
  return {
    type: 'GUEST',
    id: String(g.id),
    label: name || number || 'Guest',
    sub: name && number ? number : null,
  };
}

const BUILDERS = { RESERVATION: reservationRef, FOLIO: folioRef, GUEST: guestRef };

/** Build a reference from a search row of the given type. */
export function refFromRow(type, row) {
  const build = BUILDERS[type];
  return build ? build(row) : null;
}

/**
 * Which record types this user may look up — the picker's tabs. `hasRole` is
 * the auth context's checker, taking any number of role codes. Empty for a
 * role with no lookup rights at all (housekeeping), in which case the
 * composer does not offer the attach button.
 */
export function allowedRecordTypes(hasRole) {
  if (typeof hasRole !== 'function') return [];
  return RECORD_TYPE_ORDER.filter((t) => hasRole(...RECORD_TYPES[t].roles));
}
