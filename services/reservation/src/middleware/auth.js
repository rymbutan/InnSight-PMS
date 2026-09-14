const jwt = require('jsonwebtoken');
const { createRevocation } = require('../lib/tokenRevocation');
const { createNavScope } = require('../lib/navScope');

// Values that have shipped in this repo as defaults or fallbacks. A length check
// alone never caught them: the compose default was 41 characters, so it sailed
// past `>= 32` and the production hard-fail below could never fire. Anything
// published in source control is public knowledge and must be refused by value,
// not by length.
const KNOWN_WEAK_SECRETS = new Set([
  'innsight_slsu_capstone_jwt_secret_2025',
  'innsight_slsu_capstone_jwt_secret_2025_dev_only_DO_NOT_USE_IN_PROD',
  'change_me_to_a_random_32plus_char_secret',
]);

// Hard-fail in production if JWT_SECRET isn't a strong value.
// In development we fall back to a known-weak secret with a loud warning.
const JWT_SECRET = (function () {
  const fromEnv = process.env.JWT_SECRET;
  const isProd = process.env.NODE_ENV === 'production';

  if (fromEnv && fromEnv.length >= 32 && !KNOWN_WEAK_SECRETS.has(fromEnv)) return fromEnv;

  if (isProd) {
    const why = !fromEnv
      ? 'is unset'
      : fromEnv.length < 32
        ? `is only ${fromEnv.length} characters (need >= 32)`
        : "is one of this repo's published default values";
    console.error(`[FATAL] JWT_SECRET ${why}. Generate one with: openssl rand -hex 32`);
    process.exit(1);
  }

  if (fromEnv && KNOWN_WEAK_SECRETS.has(fromEnv)) {
    console.warn(
      '[WARN] JWT_SECRET is a published default from this repo. It is public. Replace it before any deployment.'
    );
  } else {
    console.warn(
      '[WARN] JWT_SECRET unset or weak — using dev fallback. Set JWT_SECRET=<random 32+ chars> for production.'
    );
  }
  return 'innsight_slsu_capstone_jwt_secret_2025_dev_only_DO_NOT_USE_IN_PROD';
})();

// ── Machine tokens are a SEPARATE credential ─────────────────────────────────
// folio, audit and reports each minted their own admin token with the SAME shared
// secret used for human sessions:
//
//     jwt.sign({ sub: 'system.folio', roles: ['ADMIN'] }, JWT_SECRET, ...)
//
// Two problems. First, any one compromised service could forge a HUMAN session for
// any user, because the signing key was identical. Second, nothing distinguished a
// machine caller from a person, so an audit log could not tell them apart and no
// policy could treat them differently.
//
// Now machine tokens are signed with SERVICE_JWT_SECRET and carry `svc: true`, and
// verification pins the algorithm, issuer and audience — `jwt.verify` previously
// pinned NONE of those, which is the algorithm-confusion footgun.
//
// ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
// This is still SYMMETRIC. Every service holds SERVICE_JWT_SECRET, so a compromised
// service can still mint a machine token (it just cannot mint a human session).
// The complete fix is asymmetric: auth holds an RS256/EdDSA private key, services
// hold only the public key, and folio/audit/reports REQUEST a token from auth
// instead of minting one. That needs a token-issuing endpoint plus caching in every
// caller, and is deliberately left as follow-up work rather than half-done.
const ISS_HUMAN = 'innsight-auth';
const ISS_SERVICE = 'innsight-svc';
const AUD = 'innsight-api';
const ALG = 'HS256';

const SERVICE_JWT_SECRET = (function () {
  const v = process.env.SERVICE_JWT_SECRET;
  const isProd = process.env.NODE_ENV === 'production';
  if (v && v.length >= 32 && !KNOWN_WEAK_SECRETS.has(v)) {
    if (v === JWT_SECRET && isProd) {
      console.error(
        '[FATAL] SERVICE_JWT_SECRET must differ from JWT_SECRET — using one key for both defeats the separation.'
      );
      process.exit(1);
    }
    return v;
  }
  if (isProd) {
    console.error('[FATAL] SERVICE_JWT_SECRET is unset or weak. Generate one with: openssl rand -hex 32');
    process.exit(1);
  }
  console.warn('[WARN] SERVICE_JWT_SECRET unset — deriving a dev-only value. Set it for production.');
  return `dev_service_key_${JWT_SECRET}`;
})();

// Mint a short-lived machine token. ONE place, so the claim shape and lifetime
// cannot drift between services the way the three hand-rolled copies did.
function signServiceToken({ name, roles = [], permissions = [], expiresIn = '2m' }) {
  return jwt.sign(
    {
      sub: `system.${name}`,
      username: `system.${name}`,
      displayName: `${name} service`,
      roles,
      permissions,
      svc: true,
    },
    SERVICE_JWT_SECRET,
    { expiresIn, algorithm: ALG, issuer: ISS_SERVICE, audience: AUD }
  );
}

// Verify against the right key. The unverified decode only picks WHICH key to check
// against — the signature is still validated below, so a forged `svc` claim just
// means the token is checked against a key the attacker doesn't have.
function verifyAnyToken(token) {
  let svc = false;
  try {
    svc = jwt.decode(token)?.svc === true;
  } catch {
    /* treat as human */
  }
  const secret = svc ? SERVICE_JWT_SECRET : JWT_SECRET;
  const issuer = svc ? ISS_SERVICE : ISS_HUMAN;
  const claims = jwt.verify(token, secret, { algorithms: [ALG], issuer, audience: AUD });
  // A token that claims svc but verified against the human key (or vice versa) is
  // impossible given the issuer pin, but assert the invariant anyway.
  if (!!claims.svc !== svc) throw new Error('svc claim mismatch');
  return claims;
}

// ── Named role groups ────────────────────────────────────────────────────────
// Authorisation was enforced per-route, and the WRITE routes were guarded while
// the READS were left wide open — so any authenticated account, including a
// HOUSEKEEPING trainee, could read every folio, every guest profile with its
// contacts/consents/loyalty, daily revenue totals and printable statements.
// `requirePermission` existed and was never called anywhere.
//
// These groups exist so a route's audience is legible at the call site instead of
// being a bare list of strings, and so widening one audience is a single edit.
const R = {
  ADMIN: 'ADMIN',
  MANAGER: 'MANAGER',
  FRONT_DESK: 'FRONT_DESK',
  // Housekeeping and Maintenance were two separate roles; merged into one
  // (Unified Staff Role) since the same on-the-ground staff clean/inspect
  // rooms AND log/work maintenance tickets — a split role meant
  // re-assigning every account that already did both jobs.
  HOUSEKEEPING_MAINTENANCE: 'HOUSEKEEPING_MAINTENANCE',
  AUDITOR: 'AUDITOR',
};
const ROLE_GROUPS = {
  // Management only — revenue and configuration.
  MGMT: [R.ADMIN, R.MANAGER],
  // Management plus the night auditor: financial totals and day-close data.
  MGMT_AUDIT: [R.ADMIN, R.MANAGER, R.AUDITOR],
  // Front-of-house: guest PII and reservations.
  DESK: [R.ADMIN, R.MANAGER, R.FRONT_DESK],
  // Front-of-house plus auditor: folios and statements.
  DESK_AUDIT: [R.ADMIN, R.MANAGER, R.FRONT_DESK, R.AUDITOR],
  // Operational day-sheets (arrivals/departures/in-house) — housekeeping genuinely
  // needs these to know which rooms to turn over, so they are not desk-only.
  OPS_READ: [R.ADMIN, R.MANAGER, R.FRONT_DESK, R.HOUSEKEEPING_MAINTENANCE, R.AUDITOR],
  // Housekeeping & maintenance work: room status, inspections, work orders, assets.
  MAINT: [R.ADMIN, R.MANAGER, R.HOUSEKEEPING_MAINTENANCE],
  // Non-sensitive shared reference data (room list, room types, facilities) that
  // every staff role needs to do its job. Deliberately still authenticated.
  ALL_STAFF: [R.ADMIN, R.MANAGER, R.FRONT_DESK, R.HOUSEKEEPING_MAINTENANCE, R.AUDITOR],
};

// Shared revocation store. Logout denylists a single `jti`; disabling a user,
// changing their password or changing their roles bumps a per-user epoch that
// invalidates every outstanding token at once. Without this, logout was a pure
// no-op and a disabled account kept working for the token's full 12h TTL.
const revocation = createRevocation({ label: 'auth' });

// Sidebar Visibility (Settings → Edit System Layout). An admin can hide whole
// sections of the product from a role; this is what makes that a real boundary
// instead of a hidden link. It hangs off verifyToken rather than being mounted
// as its own middleware because the nine services mount their routers
// differently — some wrap the entire /api tree, the auth service guards route by
// route — and this is the one chokepoint every authenticated request already
// passes through. See lib/navScope.js for the subtract-only rule and why a
// prefix stays open while any visible section still needs it.
const navScope = createNavScope({ label: 'auth' });

async function verifyToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token.' });
  let claims;
  try {
    claims = verifyAnyToken(token);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
  // Machine-to-machine tokens are short-lived (2–10 min) and minted per call, so
  // there is nothing to revoke and no user epoch to consult.
  if (!claims.svc && (await revocation.isRevoked(claims))) {
    return res.status(401).json({ error: 'Session has been revoked. Please sign in again.' });
  }
  req.user = claims;
  // Answers the response itself when the caller's role has lost this section, so
  // there is nothing for the route behind it to decide.
  if (await navScope.denyIfOutOfScope(req, res)) return;
  next();
}

function requireRole(...allowed) {
  // NAMED on purpose: _shared/authzAudit.js identifies a guarded route by this
  // function's name when it walks the router stack. An anonymous arrow would make
  // every route look unguarded and the audit test useless.
  return function roleGuard(req, res, next) {
    const roles = req.user?.roles || [];
    if (!roles.some((r) => allowed.includes(r))) {
      return res.status(403).json({ error: 'Forbidden.' });
    }
    next();
  };
}

function requirePermission(...needed) {
  return function permissionGuard(req, res, next) {
    const perms = req.user?.permissions || [];
    if (!needed.every((p) => perms.includes(p))) {
      return res.status(403).json({ error: 'Forbidden.' });
    }
    next();
  };
}

module.exports = {
  verifyToken,
  requireRole,
  requirePermission,
  JWT_SECRET,
  ROLE_GROUPS,
  revocation,
  navScope,
  signServiceToken,
  SERVICE_JWT_SECRET,
  ISS_HUMAN,
  ISS_SERVICE,
  AUD,
  ALG,
};
