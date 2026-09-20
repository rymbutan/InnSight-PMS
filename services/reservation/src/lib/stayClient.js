// Client for the stay service — used to check whether a guest is currently
// checked in before a new reservation is created for them (see item 9: a
// reservation and a Stay live in separate databases, so this service has no
// way to see "this guest is already in-house" on its own).

const { makeServiceCaller } = require('./serviceCall');

const STAY_URL = process.env.STAY_URL || 'http://stay-service:3006';

/**
 * @param {object} cfg
 * @param {string} cfg.name    calling service name, for the service token subject
 * @param {string} [cfg.baseUrl]
 */
function makeStayClient({ name, baseUrl = STAY_URL }) {
  const { call } = makeServiceCaller({
    name,
    roles: ['MANAGER'],
    permissions: ['stay.read'],
    timeoutMs: 3000,
    // Best-effort read on the booking path — see callers for the fallback
    // when stay is unreachable. Retried once since GET is idempotent and a
    // blip here would otherwise refuse a perfectly good booking.
    retries: 1,
  });

  // Every currently-checked-in stay for this guest. Empty (not thrown) if the
  // guest has none, or if guestId is falsy — callers that ask with no id get
  // an honest "nothing to check" rather than a wasted request.
  async function inHouseStaysForGuest(guestId) {
    if (!guestId) return [];
    return call(`${baseUrl}/api/stays?guestId=${encodeURIComponent(guestId)}&status=IN_HOUSE`);
  }

  return { inHouseStaysForGuest };
}

module.exports = { makeStayClient };
