// Client for the inventory service, which is the SINGLE authoritative owner of
// room-type capacity and physical room state.
//
// Any service that needs to claim capacity or validate a room assignment goes
// through here. The important invariant: capacity is claimed BEFORE the caller
// commits its own row, and released if that commit fails.
//
//   const hold = await inventory.acquireHold({ roomTypeCode, checkIn, checkOut });
//   try {
//     const row = await prisma.reservation.create({ ... });
//     await inventory.attachHold(hold.groupId, row.id);
//   } catch (e) {
//     await inventory.releaseHold(hold.groupId);   // compensating action
//     throw e;
//   }
//
// If the process dies between acquire and attach, the hold carries a short TTL
// and expires on its own, so capacity is never leaked permanently.

const { makeServiceCaller, ServiceCallError } = require('./serviceCall');
const { utcDayKey } = require('./date');

const INVENTORY_URL = process.env.INVENTORY_URL || 'http://inventory-service:3005';

// Raised when capacity is genuinely exhausted, as opposed to inventory being
// unreachable. Callers map this to HTTP 409 and everything else to 502/500.
class NoInventoryError extends Error {
  constructor(message, detail = {}) {
    super(message || 'No inventory available for the requested dates.');
    this.name = 'NoInventoryError';
    this.statusCode = 409;
    this.detail = detail;
  }
}

// 'YYYY-MM-DD' for a query string, from either a Date or an already-formatted
// string. Inventory parses date-only keys as UTC midnight, which is the same
// convention checkIn/checkOut are stored with — sending a full timestamp with a
// local-time component is how a range lands a day out.
function dayParam(value) {
  if (value instanceof Date) return utcDayKey(value);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  if (!m) throw new TypeError(`dayParam: expected a date, got ${value}`);
  return m[1];
}

/**
 * @param {object} cfg
 * @param {string} cfg.name    calling service name, for the service token subject
 * @param {string} cfg.secret  JWT_SECRET
 * @param {string} [cfg.baseUrl]
 */
function makeInventoryClient({ name, secret, baseUrl = INVENTORY_URL }) {
  // BOOKING role is what POST /api/holds requires. Kept deliberately narrow —
  // this token should not be able to reconfigure the property.
  const { call } = makeServiceCaller({
    name,
    roles: ['ADMIN', 'MANAGER', 'FRONT_DESK'],
    permissions: ['room.read', 'inventory.hold'],
    secret,
    // MUST exceed inventory's transaction budget (maxWait 8s + timeout 10s).
    // At 5s the caller aborted while inventory went on to commit the hold, so
    // the group id was never returned and the capacity was stranded until its
    // TTL lapsed — a self-inflicted outage under exactly the burst this design
    // is meant to survive.
    timeoutMs: 20000,
  });

  /**
   * Claim capacity for a date range. Resolves only if the hold was actually
   * created — every night in the range had room.
   * @throws {NoInventoryError} when the room type is full (upstream 409)
   */
  async function acquireHold({ roomTypeCode, checkIn, checkOut, quantity = 1, ttlSeconds, reservationId }) {
    try {
      return await call(`${baseUrl}/api/holds`, {
        method: 'POST',
        body: JSON.stringify({ roomTypeCode, checkIn, checkOut, quantity, ttlSeconds, reservationId }),
      });
    } catch (err) {
      if (err instanceof ServiceCallError && err.statusCode === 409) {
        throw new NoInventoryError(err.body?.error, err.body || {});
      }
      if (err instanceof ServiceCallError && err.statusCode === 400) {
        throw Object.assign(new Error(err.body?.error || 'Invalid booking request.'), { statusCode: 400 });
      }
      throw err;
    }
  }

  async function attachHold(groupId, reservationId) {
    return call(`${baseUrl}/api/holds/${encodeURIComponent(groupId)}/attach`, {
      method: 'POST',
      body: JSON.stringify({ reservationId }),
    });
  }

  // Compensating action. Never throws — it runs on the failure path, where
  // masking the original error with a release failure would be worse than
  // leaving a hold to expire on its own.
  async function releaseHold(groupId) {
    if (!groupId) return false;
    try {
      await call(`${baseUrl}/api/holds/${encodeURIComponent(groupId)}`, { method: 'DELETE' });
      return true;
    } catch (err) {
      console.error(
        `[${name}] Failed to release inventory hold ${groupId}: ${err.message}. ` +
          'It will expire on its own via its TTL.'
      );
      return false;
    }
  }

  async function commitHold(groupId) {
    return call(`${baseUrl}/api/holds/${encodeURIComponent(groupId)}/commit`, { method: 'POST' });
  }

  // Single physical room, for server-side assignment validation.
  async function getRoom(roomId) {
    try {
      return await call(`${baseUrl}/api/rooms/${encodeURIComponent(roomId)}`);
    } catch (err) {
      if (err instanceof ServiceCallError && err.statusCode === 404) return null;
      throw err;
    }
  }

  // Physically usable rooms of a type, in the order front-desk staff pick them
  // (lowest floor, then lowest number). This is only the CANDIDATE list —
  // whether a room is free for a given date range depends on assignedRoomId,
  // which lives in the reservation database, so that test runs on our side (see
  // lib/roomAssignment.js).
  async function roomCandidates({ roomTypeCode, checkIn, checkOut }) {
    const qs = new URLSearchParams({
      typeCode: roomTypeCode,
      checkIn: dayParam(checkIn),
      checkOut: dayParam(checkOut),
    });
    const body = await call(`${baseUrl}/api/availability/find-room?${qs.toString()}`);
    if (Array.isArray(body?.candidates)) return body.candidates;
    // Older inventory builds only returned a single `room`. Degrading to that
    // is better than assigning nothing, and it disappears once both are current.
    return body?.room ? [body.room] : [];
  }

  // Every physical room, for walk-in auto-assign (POST /api/walk-in with no
  // assignedRoomId) — the only caller here that needs the whole roster rather
  // than one type or one id, since a walk-in has no room type step to narrow
  // the search the way a reservation's roomCandidates does.
  async function listRooms() {
    return call(`${baseUrl}/api/rooms`);
  }

  return { acquireHold, attachHold, releaseHold, commitHold, getRoom, listRooms, roomCandidates, baseUrl };
}

module.exports = { makeInventoryClient, NoInventoryError, INVENTORY_URL };
