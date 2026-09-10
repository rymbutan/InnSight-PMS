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

  // The CARD/BANK_TRANSFER processing-fee surcharge percent, for previewing —
  // and, server-side, authoritatively computing — the deposit fee shown in the
  // wizard's Payment step. Same fallback discipline: a caller that can't reach
  // folio treats 0% as "no surcharge to preview" rather than blocking the booking.
  async function getPaymentFeePercent() {
    const result = await call(`${baseUrl}/api/settings/payment-fee-percent`);
    return result?.feePercent ?? 0;
  }

  // The property's check-in/check-out clock times, stamped onto every booking's
  // stored window. Same fallback discipline as the rates: callers treat a
  // failure as "use the shipped defaults" rather than refusing the booking.
  async function getHotelTimes() {
    const hotel = await call(`${baseUrl}/api/settings/hotel`);
    return {
      checkInTime: hotel?.checkInTime,
      checkOutTime: hotel?.checkOutTime,
    };
  }

  return { getTaxRates, getHotelTimes, getPaymentFeePercent };
}

module.exports = { makeFolioClient };
