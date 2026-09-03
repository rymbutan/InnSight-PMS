// Strip credential material before a user record leaves the service.
//
// Extracted from users.routes.js so it can be tested at all: that file imports
// Prisma and Redis, so nothing inside it can be loaded by `node --test`, and
// this is the function that decides whether the property's password hashes go
// out over HTTP.
//
// THE BUG IT CARRIES A TEST FOR. The original destructured `_passwordHash` —
// with a leading underscore — while the Prisma field is `passwordHash`. It
// removed a property that does not exist, so the real bcrypt hash passed
// straight through and every user-returning endpoint published every user's
// hash, the admin's included. A hash is not a plaintext password, but handing
// it to any browser that can call GET /api/users turns "steal a session" into
// "crack offline at your leisure", and it lands in logs, HAR captures and
// browser memory on the way.
//
// Deny-list rather than allow-list, deliberately: an allow-list silently drops
// new profile fields as the model grows, which is a bug reported as "the UI
// stopped showing X". A new CREDENTIAL field is rare and deliberate, and adding
// it here is part of adding it to the schema.
const SECRET_FIELDS = ['passwordHash', 'mfaSecret', 'resetToken'];

function sanitizeUser(u) {
  if (!u) return null;
  // A copy, never in place: callers reuse the Prisma object, and the login path
  // reads `passwordHash` off it on the very next line.
  const safe = { ...u };
  for (const f of SECRET_FIELDS) delete safe[f];
  return safe;
}

module.exports = { sanitizeUser, SECRET_FIELDS };
