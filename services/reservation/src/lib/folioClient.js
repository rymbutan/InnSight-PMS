// Client for the folio service's tax-rate settings — used to price a booking
// quote with the SAME rates that will apply when the room charge is actually
// posted, rather than the reservation service's own guess.
//
// Read-only and low-volume (once per booking, not once per charge), so unlike
// the charge-posting hot path this is allowed to make a cross-service call.
// Callers decide what to do if folio is unreachable — see lib/publicQuote.js.

const { makeServiceCaller } = require('./serviceCall');

const FOLIO_URL = process.env.FOLIO_URL || 'http://folio-service:3007';

/**
 * @param {object} cfg
 * @param {string} cfg.name    calling service name, for the service token subject
 * @param {string} [cfg.baseUrl]
 */
function makeFolioClient({ name, baseUrl = FOLIO_URL }) {
  // FRONT_DESK satisfies folio's DESK_AUDIT guard on GET /api/settings/tax-rates
  // without granting write access to anything.
  //
  // retries: 0 — GET is retried by default, but this call has a designed
  // no-op fallback (see publicQuote.js) on ANY failure. Retrying before
  // falling back only delays that fallback: a folio that is merely slow, not
  // down, would otherwise add up to timeoutMs × 3 (plus backoff) to every
  // public booking instead of failing fast into the default rates.
  const { call } = makeServiceCaller({
    name,
    roles: ['FRONT_DESK'],
    permissions: ['settings.read'],
    timeoutMs: 1000,
    retries: 0,
  });

  async function getTaxRates() {
    return call(`${baseUrl}/api/settings/tax-rates`);
  }

  return { getTaxRates };
}

module.exports = { makeFolioClient };
