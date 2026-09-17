// Unit tests for the activity-log record builder.
//
// The parsing is what decides whether an admin reading the log sees "mramos
// cancelled reservation 8f3c…" or "mramos updated reservations" — so it is pure
// and tested here rather than left inline in the middleware.
//
//   node --test src/lib/activityLog.test.js

const test = require('node:test');
const assert = require('node:assert');

const { buildEntry, describePath, singular, activityLog } = require('./activityLog');

const USER = { sub: 'u-1', username: 'mramos', roles: ['FRONT_DESK'] };

function entry(method, url, extra = {}) {
  return buildEntry({
    service: 'reservation',
    method,
    originalUrl: url,
    statusCode: 200,
    user: USER,
    ...extra,
  });
}

test('describePath splits resource, id and trailing operation', () => {
  assert.deepEqual(describePath('/api/reservations'), {
    resource: 'reservations',
    targetId: undefined,
    tail: undefined,
  });

  const id = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
  assert.deepEqual(describePath(`/api/reservations/${id}`), {
    resource: 'reservations',
    targetId: id,
    tail: undefined,
  });
  assert.deepEqual(describePath(`/api/reservations/${id}/cancel`), {
    resource: 'reservations',
    targetId: id,
    tail: 'cancel',
  });
  assert.deepEqual(describePath('/api/auth/login'), {
    resource: 'auth',
    targetId: undefined,
    tail: 'login',
  });
});

test('a numeric id is an id, a word is not', () => {
  assert.equal(describePath('/api/folios/204').targetId, '204');
  assert.equal(describePath('/api/folios/settle').targetId, undefined);
  assert.equal(describePath('/api/folios/settle').tail, 'settle');
});

test('summary names the operation, not just the verb', () => {
  const id = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
  // The whole point: "cancel" beats "update".
  assert.equal(entry('PATCH', `/api/reservations/${id}/cancel`).summary, `mramos cancel reservation ${id}`);
  assert.equal(entry('POST', '/api/reservations').summary, 'mramos created reservation');
  assert.equal(entry('DELETE', '/api/guests/7').summary, 'mramos deleted guest 7');
});

test('action is a stable, filterable key', () => {
  assert.equal(entry('POST', '/api/reservations').action, 'reservations.create');
  assert.equal(entry('POST', '/api/check-in').action, 'check-in.create');
  assert.equal(entry('POST', '/api/auth/login').action, 'auth.login');
});

test('the actor comes from the verified token claims', () => {
  const e = entry('POST', '/api/reservations');
  assert.equal(e.actorId, 'u-1');
  assert.equal(e.actorName, 'mramos');
  assert.deepEqual(e.actorRoles, ['FRONT_DESK']);
});

test('an unauthenticated write still records, as unknown', () => {
  const e = buildEntry({
    service: 'auth',
    method: 'POST',
    originalUrl: '/api/auth/login',
    statusCode: 200,
    user: undefined,
  });
  assert.equal(e.actorId, null);
  assert.equal(e.actorName, 'unknown');
  assert.deepEqual(e.actorRoles, []);
});

test('a handler override wins over the parsed defaults', () => {
  const e = entry('POST', '/api/folios/204/settle', {
    override: { summary: 'Settled folio 204', targetType: 'folio', targetId: '204', action: 'folio.settle' },
  });
  assert.equal(e.summary, 'Settled folio 204');
  assert.equal(e.action, 'folio.settle');
  assert.equal(e.targetId, '204');
});

test('the query string is stripped from the stored path', () => {
  assert.equal(entry('POST', '/api/reservations?source=walk-in').path, '/api/reservations');
});

test('no request body field exists on the record', () => {
  // Guards the PII decision in the file header: adding a body/payload field here
  // would put passwords and guest data into a screen admins read casually.
  const keys = Object.keys(entry('POST', '/api/reservations'));
  for (const banned of ['body', 'payload', 'request', 'params']) {
    assert.ok(!keys.includes(banned), `activity record must not carry ${banned}`);
  }
});

test('singular handles the resource names this codebase uses', () => {
  assert.equal(singular('reservations'), 'reservation');
  assert.equal(singular('guests'), 'guest');
  assert.equal(singular('facilities'), 'facility');
  assert.equal(singular('work-orders'), 'work-order');
  assert.equal(singular('housekeeping'), 'housekeeping');
});

// ── middleware behaviour ────────────────────────────────────────────────────
// A tiny fake req/res rather than a server: the contract under test is "what
// reaches the bus, and when", and that is observable from the finish handler.
function run(middleware, { method = 'POST', url = '/api/reservations', status = 200, locals = {} } = {}) {
  const handlers = [];
  const req = { method, url, originalUrl: url, path: url, headers: {}, user: USER };
  const res = { statusCode: status, locals, on: (ev, fn) => ev === 'finish' && handlers.push(fn) };
  let nexted = false;
  middleware(req, res, () => {
    nexted = true;
  });
  handlers.forEach((fn) => fn());
  return { nexted };
}

test('reads are not recorded', () => {
  const sent = [];
  const mw = activityLog({ service: 'reservation', publish: (e) => sent.push(e) });
  run(mw, { method: 'GET' });
  assert.deepEqual(sent, []);
});

test('failed writes are not recorded', () => {
  const sent = [];
  const mw = activityLog({ service: 'reservation', publish: (e) => sent.push(e) });
  run(mw, { status: 403 });
  run(mw, { status: 500 });
  assert.deepEqual(sent, []);
});

test('a successful write is recorded once', () => {
  const sent = [];
  const mw = activityLog({ service: 'reservation', publish: (e) => sent.push(e) });
  const { nexted } = run(mw, { status: 201 });
  assert.equal(nexted, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].service, 'reservation');
  assert.equal(sent[0].actorName, 'mramos');
});

test('a handler can suppress its own row', () => {
  const sent = [];
  const mw = activityLog({ service: 'reservation', publish: (e) => sent.push(e) });
  run(mw, { locals: { activity: false } });
  assert.deepEqual(sent, []);
});

test('a publish failure never escapes the finish handler', () => {
  const mw = activityLog({
    service: 'reservation',
    publish: () => {
      throw new Error('redis is down');
    },
  });
  // The assertion is that this does not throw — a dead Redis must not turn a
  // successful check-in into an unhandled exception.
  assert.doesNotThrow(() => run(mw));
});

test('the middleware refuses to be constructed without a service name', () => {
  assert.throws(() => activityLog(), /requires a service name/);
});
