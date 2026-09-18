// "Does the record this message points at actually exist?" — asked of the
// service that owns it, before the message is stored.
//
// The browser only ever builds a reference from a row a search just returned,
// so in the normal case this confirms what is already true. It is here for the
// other cases: a record deleted between the search and the send, and a request
// that never came from the page at all. A chip pointing at nothing is a worse
// experience than a refused send, because the reader clicks it and lands on a
// "not found" page with no idea whether the record or the link is at fault.
//
// DEGRADES OPEN, DELIBERATELY. A 404 from the owning service is a definitive
// "no" and blocks the send. Anything else — timeout, connection refused, a 5xx —
// is "unknown", and the caller lets the message through. The alternative is that
// the folio service being slow stops housekeeping from messaging the desk about
// a folio, which puts a cross-service dependency on the one feature that is
// supposed to keep working when other things do not. The timeout is short for
// the same reason: this sits on the send path, and a sender waiting five
// seconds for a chip to be verified will assume the send failed.

const { makeServiceCaller, ServiceCallError } = require('./serviceCall');

const URLS = {
  RESERVATION: process.env.RESERVATION_URL || 'http://reservation-service:3011',
  FOLIO: process.env.FOLIO_URL || 'http://folio-service:3007',
  GUEST: process.env.GUEST_URL || 'http://guest-service:3008',
};

const PATHS = {
  RESERVATION: (id) => `/api/reservations/${encodeURIComponent(id)}`,
  FOLIO: (id) => `/api/folios/${encodeURIComponent(id)}`,
  GUEST: (id) => `/api/guests/${encodeURIComponent(id)}`,
};

// FRONT_DESK is the narrowest role that satisfies all three GET guards
// (reservation and folio: DESK_AUDIT; guest: DESK) without granting a write.
const { call } = makeServiceCaller({
  name: 'messaging',
  roles: ['FRONT_DESK'],
  permissions: [],
  timeoutMs: 1500,
  retries: 0,
});

/**
 * @param {{ type: string, id: string }} ref  a ref normalizeRef() has accepted
 * @returns {Promise<'ok' | 'missing' | 'unknown'>}
 */
async function recordExists(ref) {
  const base = URLS[ref.type];
  const path = PATHS[ref.type];
  if (!base || !path) return 'unknown';
  try {
    await call(`${base}${path(ref.id)}`);
    return 'ok';
  } catch (err) {
    if (err instanceof ServiceCallError && err.statusCode === 404) return 'missing';
    console.warn(`[Messaging] Could not verify ${ref.type} ${ref.id}: ${err.message}`);
    return 'unknown';
  }
}

module.exports = { recordExists };
