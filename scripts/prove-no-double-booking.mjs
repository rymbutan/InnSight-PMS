#!/usr/bin/env node
/**
 * End-to-end proof that the double-booking race is closed.
 *
 * Runs against a LIVE stack (docker compose up -d) and exercises the real HTTP
 * path, the real inventory service, and the real Postgres row lock — everything
 * the unit tests can only model.
 *
 *   docker compose up -d
 *   node scripts/prove-no-double-booking.mjs
 *
 * Options:
 *   --url=http://localhost:8080   gateway base URL
 *   --attempts=20                 simultaneous bookings to fire
 *   --username=admin --password=…   (defaults to ADMIN_INITIAL_PASSWORD from .env)
 *   --keep                        don't clean up the temporary room type
 *
 * WHAT IT ASSERTS
 *   1. N simultaneous bookings against a 1-room type → exactly 1 succeeds
 *   2. every loser gets a clean 409, never a 500 and never a hang
 *   3. availability afterwards reads 0, not a negative number
 *   4. the winner is a real, retrievable reservation
 *   5. N simultaneous bookings against a K-room type → exactly K succeed
 *
 * Exit code 0 = the race is closed. Non-zero = it is not.
 */

import { readFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const BASE = args.url || process.env.GATEWAY_URL || 'http://localhost:8080';
const ATTEMPTS = Number(args.attempts || 20);
// Admin password resolution. There is no fixed default any more: the seed creates
// the account from ADMIN_INITIAL_PASSWORD (see scripts/gen-env.sh). Order of
// preference: --password= flag, ADMIN_PASSWORD env, ADMIN_INITIAL_PASSWORD env,
// then ADMIN_INITIAL_PASSWORD out of .env.
function resolveAdminPassword(flag) {
  if (flag && flag !== true) return String(flag);
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (process.env.ADMIN_INITIAL_PASSWORD) return process.env.ADMIN_INITIAL_PASSWORD;
  try {
    const envPath = new URL('../.env', import.meta.url);
    const line = readFileSync(envPath, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('ADMIN_INITIAL_PASSWORD='));
    if (line) return line.slice('ADMIN_INITIAL_PASSWORD='.length).trim();
  } catch { /* no .env — fall through */ }
  console.error('No admin password available. Run `bash scripts/gen-env.sh`, or pass');
  console.error('--password=… / ADMIN_PASSWORD=… (the CURRENT password if it was changed).');
  process.exit(2);
}

const USERNAME = args.username || 'admin';
const PASSWORD = resolveAdminPassword(args.password);

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const ok = (m) => console.log(`  ${c.green}✓${c.reset} ${m}`);
const bad = (m) => console.log(`  ${c.red}✗${c.reset} ${m}`);
const info = (m) => console.log(`  ${c.dim}${m}${c.reset}`);
const head = (m) => console.log(`\n${c.bold}${c.cyan}${m}${c.reset}`);

let token = null;
const failures = [];

async function api(method, path, body, { raw = false } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      // A distinct key per logical intent — the server dedupes replays of the
      // SAME key, and each of these bookings is a genuinely separate intent.
      'Idempotency-Key': `prove-${Math.random().toString(36).slice(2)}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (raw) return { status: res.status, body: parsed };
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return parsed;
}

function futureRange(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const ci = d.toISOString().slice(0, 10);
  const out = new Date(d);
  out.setDate(out.getDate() + 2);
  return { checkIn: ci, checkOut: out.toISOString().slice(0, 10) };
}

/** Fire N bookings as simultaneously as the runtime allows. */
async function stampede(roomTypeCode, range, n) {
  // Build every request object first, then release them together, so setup cost
  // doesn't stagger their arrival.
  const fire = Array.from({ length: n }, (_, i) =>
    () => api('POST', '/api/reservations', {
      guestName: `Race Tester ${i + 1}`,
      guestEmail: `race${i + 1}@example.test`,
      roomTypeCode,
      checkIn: range.checkIn,
      checkOut: range.checkOut,
      adults: 1,
    }, { raw: true }).catch((e) => ({ status: 0, body: { error: e.message } }))
  );
  return Promise.all(fire.map((f) => f()));
}

function summarise(results) {
  const byStatus = new Map();
  for (const r of results) byStatus.set(r.status, (byStatus.get(r.status) || 0) + 1);
  return [...byStatus.entries()].sort((a, b) => a[0] - b[0])
    .map(([s, n]) => `${n}×${s || 'network-error'}`).join('  ');
}

async function main() {
  console.log(`${c.bold}Double-booking race — end-to-end proof${c.reset}`);
  info(`gateway  ${BASE}`);
  info(`attempts ${ATTEMPTS}`);

  // ── Setup ────────────────────────────────────────────────────────────────
  head('Setup');
  try {
    const login = await api('POST', '/api/auth/login', { username: USERNAME, password: PASSWORD });
    token = login.token || login.accessToken;
    if (!token) throw new Error('login returned no token');
    ok(`authenticated as ${USERNAME}`);
  } catch (e) {
    bad(`login failed: ${e.message}`);
    console.log(`\n${c.yellow}Is the stack up? Try: docker compose up -d${c.reset}`);
    process.exit(2);
  }

  const stamp = Date.now().toString(36).toUpperCase().slice(-6);
  const singleCode = `RACE1${stamp}`;
  const multiCode = `RACEK${stamp}`;
  const K = 3;

  await api('POST', '/api/room-types', {
    code: singleCode, name: 'Race Test (1 room)', baseRate: 100000, maxOccupancy: 2, totalInventory: 1,
  });
  ok(`created room type ${singleCode} with totalInventory = 1`);

  await api('POST', '/api/room-types', {
    code: multiCode, name: `Race Test (${K} rooms)`, baseRate: 100000, maxOccupancy: 2, totalInventory: K,
  });
  ok(`created room type ${multiCode} with totalInventory = ${K}`);

  // ── Scenario 1: the last room ────────────────────────────────────────────
  head(`Scenario 1 — ${ATTEMPTS} guests race for 1 room`);
  const range1 = futureRange(30);
  info(`nights ${range1.checkIn} → ${range1.checkOut}`);

  const t0 = Date.now();
  const results1 = await stampede(singleCode, range1, ATTEMPTS);
  const elapsed1 = Date.now() - t0;

  const created1 = results1.filter((r) => r.status === 201);
  const refused1 = results1.filter((r) => r.status === 409);
  const errored1 = results1.filter((r) => r.status >= 500 || r.status === 0);

  info(`responses: ${summarise(results1)}   (${elapsed1}ms)`);

  if (created1.length === 1) ok(`exactly 1 booking succeeded`);
  else { bad(`expected exactly 1 success, got ${created1.length} — THE ROOM WAS OVERSOLD`); failures.push('oversell'); }

  if (refused1.length === ATTEMPTS - 1) ok(`the other ${refused1.length} were cleanly refused with 409`);
  else { bad(`expected ${ATTEMPTS - 1} refusals, got ${refused1.length}`); failures.push('refusal-count'); }

  if (errored1.length === 0) ok('no 500s and no dropped connections');
  else { bad(`${errored1.length} request(s) failed hard: ${errored1[0].body?.error}`); failures.push('hard-errors'); }

  // ── Availability must agree with what happened ───────────────────────────
  head('Scenario 2 — availability reflects reality');
  const avail = await api('GET', `/api/availability?checkIn=${range1.checkIn}&checkOut=${range1.checkOut}&roomType=${singleCode}`);
  const row = Array.isArray(avail) ? avail.find((r) => r.roomTypeCode === singleCode) : null;

  if (row && row.available === 0) ok('availability reads 0 — sold out');
  else { bad(`expected available = 0, got ${row ? row.available : 'no row'}`); failures.push('availability'); }

  if (row && row.available >= 0) ok('availability is not negative (no hidden oversell)');
  else { bad('availability went negative — inventory is oversold and being masked'); failures.push('negative-availability'); }

  // ── The winner must be a real booking ───────────────────────────────────
  head('Scenario 3 — the winning booking is real');
  if (created1.length >= 1) {
    const winner = created1[0].body;
    const fetched = await api('GET', `/api/reservations/${winner.id}`, null, { raw: true });
    if (fetched.status === 200 && fetched.body.confirmationNumber === winner.confirmationNumber) {
      ok(`reservation ${winner.confirmationNumber} is retrievable`);
    } else {
      bad('the winning reservation could not be read back'); failures.push('winner-missing');
    }
    if (winner.inventoryHoldGroupId) ok('the winner carries an inventory hold group id');
    else { bad('the winner has no hold group — capacity is not tracked for it'); failures.push('no-hold'); }
  }

  // ── Scenario 4: K rooms ─────────────────────────────────────────────────
  head(`Scenario 4 — ${ATTEMPTS} guests race for ${K} rooms`);
  const range2 = futureRange(60);
  const results2 = await stampede(multiCode, range2, ATTEMPTS);
  const created2 = results2.filter((r) => r.status === 201);

  info(`responses: ${summarise(results2)}`);
  if (created2.length === K) ok(`exactly ${K} bookings succeeded`);
  else { bad(`expected exactly ${K} successes, got ${created2.length}`); failures.push('multi-room'); }

  // ── Cleanup ─────────────────────────────────────────────────────────────
  if (!args.keep) {
    head('Cleanup');
    let cancelled = 0;
    for (const r of [...created1, ...created2]) {
      const res = await api('POST', `/api/reservations/${r.body.id}/cancel`,
        { reason: 'Automated race-condition test' }, { raw: true });
      if (res.status === 200) cancelled += 1;
    }
    ok(`cancelled ${cancelled} test reservation(s)`);

    // The two throwaway types used to be left behind on every run, because
    // there was no delete endpoint to call — so a rates screen accumulated a
    // permanent row of "Race Test" entries, one pair per run, that no admin
    // could clear. DELETE /api/room-types/:code exists now, and this uses it.
    //
    // A type still refuses to delete while live holds reference it, so the
    // cancellations above have to land first. That is why this comes after them
    // and why a failure here is reported rather than thrown: leaving a stray
    // room type behind must never turn a PASSING race proof into a failure.
    for (const code of [singleCode, multiCode]) {
      const res = await api('DELETE', `/api/room-types/${code}`, null, { raw: true });
      if (res.status === 204) ok(`removed room type ${code}`);
      else bad(`could not remove room type ${code}: ${res.body?.error || res.status}`);
    }
  }

  // ── Verdict ─────────────────────────────────────────────────────────────
  console.log('');
  if (failures.length === 0) {
    console.log(`${c.green}${c.bold}PASS${c.reset} — the double-booking race is closed.`);
    console.log(`${c.dim}${ATTEMPTS} simultaneous bookings, 1 room, 1 winner.${c.reset}\n`);
    process.exit(0);
  }
  console.log(`${c.red}${c.bold}FAIL${c.reset} — ${failures.length} check(s) failed: ${failures.join(', ')}\n`);
  process.exit(1);
}

main().catch((e) => {
  console.error(`\n${c.red}Unexpected error:${c.reset} ${e.stack || e.message}\n`);
  process.exit(2);
});
