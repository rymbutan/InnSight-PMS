const crypto = require('node:crypto');

// A pending simulated payment, addressed by a QR code.
//
// The confirm endpoint has to be unauthenticated — it is opened by whatever
// scanned the code, which has no session and no token of ours — so this token is
// the ONLY thing standing between a stranger and a payment posted to a guest's
// folio. 32 bytes from the CSPRNG, single use, and short-lived.
//
// base64url rather than hex: same entropy in two-thirds the characters, which
// keeps the encoded URL short enough to stay a comfortably scannable QR.
function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// How long a generated code stays payable. Long enough for a guest to find their
// phone and unlock it, short enough that a code left on a printout or a screenshot
// is not still spendable at the end of the shift.
const INTENT_TTL_MS = 15 * 60 * 1000;

// An emailed link isn't opened in front of the desk the way a QR code is — a
// guest might not check their inbox for hours. 15 minutes would make "Sent Pay
// by Link" mail a code that is already dead before it's read.
const LINK_TTL_MS = 24 * 60 * 60 * 1000;

// Expiry is DERIVED, never stored as a status. A row written PENDING would
// otherwise stay payable indefinitely unless something swept the table, and a
// sweeper that fails silently is a worse failure than no sweeper.
//
// `<=` rather than `<`: an intent expiring exactly now is expired. At a boundary,
// refusing a payment is recoverable — generate another code — while accepting one
// that should have lapsed is not.
function intentState(intent, now = new Date()) {
  if (intent.status !== 'PENDING') return intent.status;
  return new Date(intent.expiresAt) <= now ? 'EXPIRED' : 'PENDING';
}

module.exports = { newToken, intentState, INTENT_TTL_MS, LINK_TTL_MS };
