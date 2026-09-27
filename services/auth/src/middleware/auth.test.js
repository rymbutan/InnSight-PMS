const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

// Must be >=32 chars or the middleware ignores it and uses a dev fallback,
// which would make signed tokens fail to verify in the test below.
const TEST_SECRET = 'test_secret_0123456789_0123456789_xyz';
const TEST_SERVICE_SECRET = 'test_service_secret_0123456789_0123456789';
process.env.JWT_SECRET = TEST_SECRET;
process.env.SERVICE_JWT_SECRET = TEST_SERVICE_SECRET;

// verifyToken consults the Redis-backed revocation store (see lib/tokenRevocation.js)
// AND, via lib/navScope.js's own module-level createNavScope(), a second real
// ioredis client for sidebar-visibility config. Stub both: a unit test must not
// open a socket, and an un-stubbed ioredis client keeps retrying to connect
// forever, which keeps the event loop alive so `node --test` never exits — this
// file used to stub only tokenRevocation, leaving navScope's client real, which
// is exactly the hang (see the reservation-service convention of stubbing
// `ioredis` itself in services/reservation/src/routes/authz.test.js).
let revokedNext = false;
require.cache[require.resolve('../lib/tokenRevocation')] = {
  exports: {
    createRevocation: () => ({
      isRevoked: async () => revokedNext,
      revokeToken: async () => true,
      revokeAllForUser: async () => true,
      disconnect: () => {},
    }),
  },
};
require.cache[require.resolve('ioredis')] = {
  exports: function Redis() {
    return { get: async () => null, set: async () => {}, on: () => {}, disconnect: () => {} };
  },
};
const { verifyToken, requireRole, requirePermission, ALG, ISS_HUMAN, ISS_SERVICE, AUD } = require('./auth');

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
}
// verifyToken pins algorithm, issuer and audience (it previously pinned none of
// them, which is the algorithm-confusion footgun). A test token has to carry the
// same claims the real issuers set, or it is correctly rejected.
function sign(payload) {
  return jwt.sign(payload, TEST_SECRET, {
    algorithm: ALG,
    issuer: ISS_HUMAN,
    audience: AUD,
  });
}
// Machine tokens: separate key, separate issuer, and `svc: true`.
function signService(payload) {
  return jwt.sign({ ...payload, svc: true }, TEST_SERVICE_SECRET, {
    algorithm: ALG,
    issuer: ISS_SERVICE,
    audience: AUD,
  });
}

test('verifyToken: rejects missing header', async () => {
  const req = { headers: {} };
  const res = mockRes();
  await verifyToken(req, res, () => assert.fail('next should not be called'));
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /Missing bearer/);
});

test('verifyToken: rejects invalid token', async () => {
  const req = { headers: { authorization: 'Bearer bogus' } };
  const res = mockRes();
  await verifyToken(req, res, () => assert.fail('next should not be called'));
  assert.equal(res.statusCode, 401);
});

test('verifyToken: accepts valid token and populates req.user', async () => {
  const token = sign({ sub: 'u1', roles: ['ADMIN'], permissions: ['users:create'] });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = mockRes();
  let called = false;
  await verifyToken(req, res, () => {
    called = true;
  });
  assert.equal(called, true);
  assert.equal(req.user.sub, 'u1');
  assert.deepEqual(req.user.roles, ['ADMIN']);
});

test('requireRole: allows when role present', () => {
  const req = { user: { roles: ['FRONT_DESK'] } };
  const res = mockRes();
  let called = false;
  requireRole('FRONT_DESK', 'ADMIN')(req, res, () => {
    called = true;
  });
  assert.equal(called, true);
});

test('requireRole: forbids when role absent', () => {
  const req = { user: { roles: ['HOUSEKEEPING_MAINTENANCE'] } };
  const res = mockRes();
  requireRole('ADMIN')(req, res, () => assert.fail());
  assert.equal(res.statusCode, 403);
});

test('requirePermission: requires ALL listed permissions', () => {
  const req = { user: { permissions: ['folio:charge'] } };
  const res = mockRes();
  requirePermission('folio:charge', 'folio:close')(req, res, () => assert.fail());
  assert.equal(res.statusCode, 403);
});

test('requirePermission: passes when all permissions present', () => {
  const req = { user: { permissions: ['folio:charge', 'folio:close'] } };
  const res = mockRes();
  let called = false;
  requirePermission('folio:charge', 'folio:close')(req, res, () => {
    called = true;
  });
  assert.equal(called, true);
});

// ── Revocation (S4) ─────────────────────────────────────────────────────────
// Logout used to be a pure no-op: it published an event and returned success while
// the JWT stayed valid for its full 12h TTL.

test('verifyToken: rejects a REVOKED token even though the signature is valid', async () => {
  const token = sign({ sub: 'u1', roles: ['ADMIN'], jti: 'session-1' });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = mockRes();
  revokedNext = true;
  try {
    await verifyToken(req, res, () => assert.fail('next must not run for a revoked token'));
  } finally {
    revokedNext = false;
  }
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /revoked/i);
});

test('verifyToken: a SERVICE token skips the revocation lookup', async () => {
  // Machine tokens live 2–10 minutes and are minted per call, so there is nothing
  // to revoke — and they must keep working even while a user epoch is bumped.
  const token = signService({ sub: 'system.folio', roles: ['ADMIN'] });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = mockRes();
  let called = false;
  revokedNext = true; // would reject a user token
  try {
    await verifyToken(req, res, () => {
      called = true;
    });
  } finally {
    revokedNext = false;
  }
  assert.equal(called, true, 'service tokens must bypass revocation');
  assert.equal(req.user.svc, true);
});

test('verifyToken: rejects a token signed with the WRONG issuer', async () => {
  // Signature is valid, issuer is not — this is the class of bug that pinning
  // algorithm/issuer/audience exists to catch.
  const token = jwt.sign({ sub: 'u1' }, TEST_SECRET, {
    algorithm: ALG,
    issuer: 'someone-else',
    audience: AUD,
  });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = mockRes();
  await verifyToken(req, res, () => assert.fail('next must not run'));
  assert.equal(res.statusCode, 401);
});

test('verifyToken: rejects a HUMAN token signed with the SERVICE key', async () => {
  // Splitting the keys is the point: a service compromise must not yield a
  // forgeable human session.
  const token = jwt.sign({ sub: 'u1' }, TEST_SERVICE_SECRET, {
    algorithm: ALG,
    issuer: ISS_HUMAN,
    audience: AUD,
  });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = mockRes();
  await verifyToken(req, res, () => assert.fail('next must not run'));
  assert.equal(res.statusCode, 401);
});
