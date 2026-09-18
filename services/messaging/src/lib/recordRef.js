// A message can carry ONE record reference — a reservation, a folio or a guest
// profile — alongside (or instead of) its text. The browser renders it as a
// chip that opens the record in place; this module is the server's view of it.
//
// WHY STRUCTURED, NOT A PASTED LINK
// ---------------------------------
// Staff could paste `/folios?id=…` into the box and the renderer could linkify
// it. Two things go wrong with that. The chip would have nothing to show but a
// URL, because a UUID says nothing about whose bill it is; and the day a route
// is renamed every message that ever pointed at a record stops working. So the
// message stores WHAT it points at (type + id) and a snapshot of how to name it
// (label + sub), captured at send time from the record the sender was looking
// at. The chip can then be drawn from the row alone — ten chips on screen do
// not mean ten lookups — and it still reads correctly after the record is
// renamed, closed or deleted.
//
// The four columns live on Message rather than in a side table because a
// message has at most one of these, and a join to fetch what is effectively two
// short strings would be paid on every three-second thread poll.
//
// PURE. No Prisma, no network — see recordRef.test.js. The existence check
// against the owning service is recordLookup.js.

/** The record types a message may point at, with the noun the UI uses. Kept
 *  in step by hand with web/src/lib/recordRefs.js — three strings, and the
 *  browser and this service do not share a module system. */
const RECORD_TYPES = Object.freeze({
  RESERVATION: 'reservation',
  FOLIO: 'folio',
  GUEST: 'guest',
});

// A name plus a number is all a chip shows; anything longer than this is not a
// label, it is someone using the field as a second message body.
const MAX_LABEL = 120;

// Every record id in this system is a UUID, but the check is deliberately
// looser than a strict UUID regex: it only has to keep out things that are
// obviously not an id (an empty string, a URL, a paragraph), not certify one.
// The owning service's 404 is what says whether the id is real.
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Validate and normalise the `ref` field of a send request.
 *
 * @returns {{ ok: true, ref: null | { type: string, id: string, label: string, sub: string | null } }
 *         | { ok: false, error: string }}
 *   `ref: null` is the normal case — most messages carry no record. Absent,
 *   null and undefined all mean "none"; anything else has to be well-formed.
 */
function normalizeRef(input) {
  if (input == null) return { ok: true, ref: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'ref must be an object.' };
  }
  const type = str(input.type).toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(RECORD_TYPES, type)) {
    return { ok: false, error: `ref.type must be one of ${Object.keys(RECORD_TYPES).join(', ')}.` };
  }
  const id = str(input.id);
  if (!ID_RE.test(id)) return { ok: false, error: 'ref.id is not a valid record id.' };

  const label = str(input.label);
  if (!label) return { ok: false, error: 'ref.label is required.' };
  if (label.length > MAX_LABEL) {
    return { ok: false, error: `ref.label cannot exceed ${MAX_LABEL} characters.` };
  }
  const sub = str(input.sub);
  if (sub.length > MAX_LABEL) {
    return { ok: false, error: `ref.sub cannot exceed ${MAX_LABEL} characters.` };
  }
  return { ok: true, ref: { type, id, label, sub: sub || null } };
}

/** The Message columns for a (possibly absent) reference. */
function refColumns(ref) {
  if (!ref) return { refType: null, refId: null, refLabel: null, refSub: null };
  return { refType: ref.type, refId: ref.id, refLabel: ref.label, refSub: ref.sub ?? null };
}

/**
 * One line standing in for the body when a message is only an attachment:
 * "Shared folio: Folio F-2026-0012". Used for the contact row's preview and the
 * notification toast, both of which show `body` and would otherwise show
 * nothing at all for a message the sender very much did send.
 */
function refPreview(refType, refLabel) {
  const noun = RECORD_TYPES[refType] || 'record';
  return refLabel ? `Shared ${noun}: ${refLabel}` : `Shared a ${noun}`;
}

/** The preview text for a stored message row — its body, or its attachment. */
function messagePreview(row, max = 120) {
  const body = str(row?.body);
  if (body) return body.slice(0, max);
  if (row?.refType) return refPreview(row.refType, row.refLabel).slice(0, max);
  return '';
}

module.exports = { RECORD_TYPES, MAX_LABEL, normalizeRef, refColumns, refPreview, messagePreview };
