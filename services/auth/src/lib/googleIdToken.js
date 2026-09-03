// Verification of a Google Identity Services ID token.
//
// Deliberately dependency-free: Google publishes its signing certificates as
// X.509 PEMs at a stable endpoint, and `jsonwebtoken` (already a dependency)
// verifies RS256 against a PEM. Pulling in google-auth-library would mean a new
// package and an image rebuild for ~40 lines of well-specified behaviour.
//
// What is checked, in order — a failure at any step is a rejected sign-in:
//   1. signature, against the Google cert whose `kid` the token names
//   2. `aud` === our OAuth client id (the token was minted FOR us)
//   3. `iss` is one of Google's two documented issuer strings
//   4. `exp`/`nbf` (jsonwebtoken enforces these)
//   5. the email is verified by Google
//   6. the email is inside the allowed domain, and any Workspace `hd` agrees
//
// Step 6 is the university restriction. `hd` alone is not enough (it is absent
// for consumer accounts) and the email domain alone is not enough either (an
// unverified address could be anything), so both are required to agree.

const jwt = require('jsonwebtoken');

const CERTS_URL = 'https://www.googleapis.com/oauth2/v1/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

let cache = { certs: null, expiresAt: 0 };

// Google rotates these keys; the response's Cache-Control tells us for how long
// it is safe to hold them. Falling back to an hour if the header is missing.
async function fetchCerts() {
  if (cache.certs && Date.now() < cache.expiresAt) return cache.certs;

  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error(`Google certs endpoint returned ${res.status}`);
  const certs = await res.json();

  const cc = res.headers.get('cache-control') || '';
  const maxAge = Number(/max-age=(\d+)/.exec(cc)?.[1] ?? 3600);
  cache = { certs, expiresAt: Date.now() + maxAge * 1000 };
  return certs;
}

/**
 * Verify a Google ID token and return the trusted claims, or throw.
 *
 * @param {string} credential  the raw ID token from Google Identity Services
 * @param {object} opts
 * @param {string} opts.clientId       our OAuth client id — the expected `aud`
 * @param {string} opts.allowedDomain  e.g. 'slsu.edu.ph'
 * @returns {Promise<{ email: string, name: string, sub: string }>}
 */
async function verifyGoogleIdToken(credential, { clientId, allowedDomain }) {
  if (!credential || typeof credential !== 'string') throw new Error('Missing Google credential.');
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID is not configured on the server.');

  const decoded = jwt.decode(credential, { complete: true });
  const kid = decoded?.header?.kid;
  if (!kid) throw new Error('Malformed Google credential.');

  const certs = await fetchCerts();
  const pem = certs[kid];
  // An unknown kid means the token was not signed by a current Google key.
  if (!pem) throw new Error('Google credential was not signed by a recognised key.');

  const claims = jwt.verify(credential, pem, {
    algorithms: ['RS256'],
    audience: clientId,
    issuer: ISSUERS,
  });

  if (claims.email_verified !== true && claims.email_verified !== 'true') {
    throw new Error('That Google account has an unverified email address.');
  }

  const email = String(claims.email || '').toLowerCase();
  const domain = allowedDomain.toLowerCase();
  if (!email.endsWith(`@${domain}`)) {
    throw new Error(`Only @${allowedDomain} accounts can sign in.`);
  }
  // Consumer accounts have no `hd`; a Workspace account that has one must match,
  // otherwise a lookalike address on another tenant would pass the check above.
  if (claims.hd && String(claims.hd).toLowerCase() !== domain) {
    throw new Error(`Only @${allowedDomain} accounts can sign in.`);
  }

  return { email, name: claims.name || claims.given_name || email, sub: claims.sub };
}

// ── Access-token path ────────────────────────────────────────────────────────
//
// The ID-token flow above can only be triggered by Google's own rendered button,
// which sits in an iframe and cannot be styled. To present a button that matches
// the rest of the sign-in screen we use the OAuth 2.0 token flow instead, which
// hands the browser an ACCESS token. That is a bearer credential, so it needs a
// different — and easy to get wrong — set of checks:
//
//   1. `tokeninfo` proves the token is live AND names the client it was issued
//      to. Skipping the `aud` check is the classic hole here: without it, an
//      access token minted for ANY other Google app could be replayed against us.
//   2. `userinfo` then supplies the profile, including the Workspace `hd`.
//
// The domain rule is identical to the ID-token path.

const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

/**
 * Verify a Google OAuth access token and return the trusted profile, or throw.
 *
 * @param {string} accessToken
 * @param {object} opts
 * @param {string} opts.clientId       our OAuth client id — the expected `aud`
 * @param {string} opts.allowedDomain  e.g. 'slsu.edu.ph'
 * @returns {Promise<{ email: string, name: string, sub: string }>}
 */
async function verifyGoogleAccessToken(accessToken, { clientId, allowedDomain }) {
  if (!accessToken || typeof accessToken !== 'string') throw new Error('Missing Google token.');
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID is not configured on the server.');

  const infoRes = await fetch(`${TOKENINFO_URL}?access_token=${encodeURIComponent(accessToken)}`);
  if (!infoRes.ok) throw new Error('Google sign-in token was rejected.');
  const info = await infoRes.json();

  // THE critical check — see the note above.
  if (info.aud !== clientId) {
    throw new Error('That Google token was issued for a different application.');
  }

  const profRes = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!profRes.ok) throw new Error('Could not read your Google profile.');
  const prof = await profRes.json();

  const verified = prof.email_verified ?? info.email_verified;
  if (verified !== true && verified !== 'true') {
    throw new Error('That Google account has an unverified email address.');
  }

  const email = String(prof.email || info.email || '').toLowerCase();
  const domain = allowedDomain.toLowerCase();
  if (!email.endsWith(`@${domain}`)) {
    throw new Error(`Only @${allowedDomain} accounts can sign in.`);
  }
  if (prof.hd && String(prof.hd).toLowerCase() !== domain) {
    throw new Error(`Only @${allowedDomain} accounts can sign in.`);
  }

  return { email, name: prof.name || prof.given_name || email, sub: prof.sub || info.sub };
}

module.exports = {
  verifyGoogleIdToken,
  verifyGoogleAccessToken,
  _resetCertCache: () => (cache = { certs: null, expiresAt: 0 }),
};
