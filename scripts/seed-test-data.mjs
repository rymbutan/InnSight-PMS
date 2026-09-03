#!/usr/bin/env node
/**
 * Fill a running stack with real bookings — and, on a property that predates the
 * three-floor seed, the extra rooms to hang them on.
 *
 * Mainly this exists for the inspection scenario builder, which needs a room
 * with a booking attached before any of it means anything.
 *
 * A scenario is authored against a room, and the clipboard the student reads is
 * that room's REAL reservation. With one reservation in the system there is
 * exactly one room where the feature can be seen working, so this creates a
 * spread: couples, families, solo travellers, arriving on different days, so the
 * booking-relative faults (amenity shortfall, room mismatch) actually differ
 * from room to room.
 *
 *   docker compose up -d
 *   node scripts/seed-test-data.mjs
 *
 * Options:
 *   --url=http://localhost:8080   gateway base URL
 *   --username=admin --password=…   (defaults to ADMIN_INITIAL_PASSWORD from .env)
 *   --floors=3                    how many floors of rooms to end up with
 *   --reservations=14             how many bookings to create (0 to skip)
 *   --no-purge                    keep the RACE* test room types
 *   --dry-run                     print what would happen, change nothing
 *
 * Safe to re-run. Rooms and inventory counts are idempotent; reservations are
 * additive, because two guests booking the same room type on the same night is a
 * legitimate thing to have twice and the script cannot tell a duplicate from a
 * deliberate second booking.
 */

import { readFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const BASE = args.url || process.env.GATEWAY_URL || 'http://localhost:8080';
const FLOORS = Math.max(1, Number(args.floors || 3));
const WANT_RESERVATIONS = args.reservations === undefined ? 14 : Number(args.reservations);
const PURGE = !args['no-purge'];
const DRY = !!args['dry-run'];

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const head = (t) => console.log(`\n${c.bold}${c.cyan}── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}${c.reset}`);
const ok = (t) => console.log(`  ${c.green}✓${c.reset} ${t}`);
const bad = (t) => console.log(`  ${c.red}✗${c.reset} ${t}`);
const info = (t) => console.log(`  ${c.dim}${t}${c.reset}`);

// Same resolution order as prove-no-double-booking.mjs: there is no fixed
// default password any more — the seed creates the admin from
// ADMIN_INITIAL_PASSWORD (scripts/gen-env.sh).
function resolveAdminPassword(flag) {
  if (flag && flag !== true) return String(flag);
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (process.env.ADMIN_INITIAL_PASSWORD) return process.env.ADMIN_INITIAL_PASSWORD;
  try {
    const line = readFileSync(new URL('../.env', import.meta.url), 'utf8')
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
let token = null;

async function api(method, path, body, { raw = false } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Idempotency-Key': `seed-${Math.random().toString(36).slice(2)}`,
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

// ── The property ────────────────────────────────────────────────────────────
// Per floor. Room numbers follow the existing seed's convention (floor × 100 +
// index), which the housekeeping map relies on to sort rooms into two rows.
const PER_FLOOR = [
  { code: 'STD', count: 8 },
  { code: 'DLX', count: 4 },
  { code: 'STE', count: 2 },
  { code: 'PRS', count: 1 },
];

// ── Guests ──────────────────────────────────────────────────────────────────
// Party compositions are deliberately spread. Half the fault categories are only
// faults RELATIVE to the booking — two towels is correct for a couple and wrong
// for a family of four — so a test property where every booking is a couple can
// only ever show half the system working.
const GUESTS = [
  { name: 'Dela Cruz, Maria', adults: 2, children: 0, requests: 'Honeymoon trip — please set the room up for a couple.', type: 'DLX' },
  { name: 'Reyes, Paolo', adults: 2, children: 2, requests: 'Travelling with two young children; extra towels appreciated.', type: 'STD' },
  { name: 'Santos, Grace', adults: 1, children: 0, requests: null, type: 'STD' },
  { name: 'Bautista, Ramon', adults: 2, children: 3, requests: 'Cot for the youngest, please.', type: 'STE' },
  { name: 'Mendoza, Liza', adults: 2, children: 0, requests: 'Late arrival, around 11pm.', type: 'STD' },
  { name: 'Villanueva, Carlo', adults: 3, children: 0, requests: 'Three colleagues — separate beds if possible.', type: 'DLX' },
  { name: 'Aquino, Bea', adults: 2, children: 1, requests: null, type: 'STD' },
  { name: 'Ocampo, Miguel', adults: 4, children: 0, requests: 'Anniversary stay; welcome amenity requested.', type: 'STE' },
  { name: 'Salazar, Ana', adults: 1, children: 0, requests: 'Guest is a light sleeper — room away from the lift was requested.', type: 'STD' },
  { name: 'Navarro, Jose', adults: 2, children: 2, requests: 'Early check-in requested if the room is ready.', type: 'DLX' },
  { name: 'Cruz, Elena', adults: 2, children: 0, requests: null, type: 'PRS' },
  { name: 'Lim, Anthony', adults: 2, children: 4, requests: 'Large family — please confirm bedding before arrival.', type: 'STE' },
  { name: 'Garcia, Rosa', adults: 1, children: 1, requests: 'Travelling with an infant.', type: 'STD' },
  { name: 'Torres, Danilo', adults: 2, children: 0, requests: 'Quiet room preferred.', type: 'DLX' },
  { name: 'Ramos, Isabel', adults: 3, children: 1, requests: 'Extra pillows, please.', type: 'DLX' },
  { name: 'Domingo, Rafael', adults: 2, children: 0, requests: null, type: 'PRS' },
];

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

async function main() {
  console.log(`\n${c.bold}InnSight — test data${c.reset}`);
  info(`gateway ${BASE}`);
  if (DRY) info('DRY RUN — nothing will be changed');

  head('Sign in');
  try {
    const login = await api('POST', '/api/auth/login', { username: USERNAME, password: PASSWORD });
    token = login.token || login.accessToken;
    if (!token) throw new Error('login returned no token');
    ok(`authenticated as ${USERNAME}`);
  } catch (e) {
    bad(`login failed: ${e.message}`);
    console.log(`\n${c.yellow}Is the stack up? Try: docker compose up -d${c.reset}\n`);
    process.exit(2);
  }

  // ── 1. Remove the leftover race-test room types ──────────────────────────
  // Every run of prove-no-double-booking.mjs used to strand two of these in the
  // rates screen, because there was no delete endpoint for it to call.
  if (PURGE) {
    head('Remove test room types');
    const types = await api('GET', '/api/room-types');
    const junk = types.filter((t) => /^RACE/.test(t.code));
    if (!junk.length) ok('none left behind');
    for (const t of junk) {
      if (DRY) { info(`would delete ${t.code} (${t.name})`); continue; }
      const res = await api('DELETE', `/api/room-types/${t.code}`, null, { raw: true });
      if (res.status === 204) ok(`deleted ${t.code} — ${t.name}`);
      else bad(`${t.code}: ${res.body?.error || res.status}`);
    }
  }

  // ── 2. Build out the floors ──────────────────────────────────────────────
  head('Rooms');
  const existingRooms = await api('GET', '/api/rooms');
  const have = new Set(existingRooms.map((r) => r.number));
  info(`${existingRooms.length} room(s) already exist`);

  const wanted = [];
  for (let floor = 1; floor <= FLOORS; floor += 1) {
    let n = floor * 100;
    for (const grp of PER_FLOOR) {
      for (let i = 0; i < grp.count; i += 1) {
        n += 1;
        wanted.push({ number: String(n), typeCode: grp.code, floor });
      }
    }
  }

  let made = 0;
  for (const r of wanted) {
    if (have.has(r.number)) continue;
    if (DRY) { made += 1; continue; }
    const res = await api('POST', '/api/rooms', {
      id: r.number,
      number: r.number,
      typeCode: r.typeCode,
      floor: r.floor,
      features: { tv: true, wifi: true },
    }, { raw: true });
    // 409 is a room that already exists under a different id — not a failure.
    if (res.status === 201) made += 1;
    else if (res.status !== 409) bad(`room ${r.number}: ${res.body?.error || res.status}`);
  }
  ok(DRY ? `would add ${made} room(s)` : `added ${made} room(s) — ${wanted.length} across ${FLOORS} floor(s)`);

  // ── 3. Inventory must match reality ──────────────────────────────────────
  // availability = totalInventory − held nights. A type whose totalInventory is
  // lower than its actual room count silently refuses bookings for rooms that
  // are standing empty, which looks exactly like a bug in the booking engine.
  head('Inventory counts');
  const rooms = DRY ? wanted : await api('GET', '/api/rooms');
  const counts = {};
  for (const r of rooms) counts[r.typeCode] = (counts[r.typeCode] || 0) + 1;
  for (const [code, count] of Object.entries(counts)) {
    if (DRY) { info(`would set ${code} totalInventory = ${count}`); continue; }
    const res = await api('PATCH', `/api/room-types/${code}`, { totalInventory: count }, { raw: true });
    if (res.status === 200) ok(`${code} totalInventory = ${count}`);
    else bad(`${code}: ${res.body?.error || res.status}`);
  }

  // ── 4. Bookings ──────────────────────────────────────────────────────────
  if (WANT_RESERVATIONS > 0) {
    head('Reservations');
    const today = new Date();
    const roomsByType = {};
    for (const r of rooms) (roomsByType[r.typeCode] ||= []).push(r);
    for (const list of Object.values(roomsByType)) {
      list.sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
    }

    const taken = new Set();
    const created = [];
    for (let i = 0; i < Math.min(WANT_RESERVATIONS, GUESTS.length); i += 1) {
      const g = GUESTS[i];
      // A room of the right type that no other seeded booking is using. Assigning
      // the room is the whole point: Housekeeping looks a reservation up BY
      // assigned room, and an unassigned booking is invisible to the inspection.
      const room = (roomsByType[g.type] || []).find((r) => !taken.has(r.id));
      if (!room) { bad(`no free ${g.type} room for ${g.name}`); continue; }
      taken.add(room.id);

      // Arrivals spread across the week, and a couple of stays already running,
      // so the board is not a single wall of same-day check-ins.
      const offset = (i % 5) - 1; // -1 (in-house) through 3 (arriving later)
      const checkIn = addDays(today, offset);
      const checkOut = addDays(checkIn, 1 + (i % 4));

      if (DRY) { info(`would book ${g.name} into ${room.number} (${iso(checkIn)}→${iso(checkOut)})`); continue; }

      const res = await api('POST', '/api/reservations', {
        guestName: g.name,
        roomTypeCode: g.type,
        assignedRoomId: room.id,
        checkIn: iso(checkIn),
        checkOut: iso(checkOut),
        adults: g.adults,
        children: g.children,
        specialRequests: g.requests,
        source: 'WALK_IN',
      }, { raw: true });

      if (res.status === 201) {
        // A booking is created PENDING. Left that way the housekeeping clipboard
        // shows a guest arriving today against an unconfirmed reservation, and
        // launchInspection only reaches it through its "any reservation for this
        // room" fallback rather than by matching a real status.
        await api('POST', `/api/reservations/${res.body.id}/confirm`, {}, { raw: true });
        created.push({ g, room, res: res.body, arriving: offset >= 0 });
        ok(`${g.name} → room ${room.number} (${g.adults}A${g.children ? `/${g.children}C` : ''}, ${iso(checkIn)})`);
      } else {
        bad(`${g.name}: ${res.body?.error || res.status}`);
      }
    }

    // ── 5. Put the rooms in a state worth testing ──────────────────────────
    // "Inspect Room Against Booking" is offered on CLEAN rooms only — the
    // turnover is done and a supervisor signs it off. Rooms with a booking
    // arriving are left CLEAN so every one of them is an inspection you can
    // run; the in-house stays go OCCUPIED, and a couple go DIRTY so the
    // housekeeping queue is not empty either.
    if (!DRY && created.length) {
      head('Room states');
      let clean = 0, occupied = 0, dirty = 0;
      for (const [i, item] of created.entries()) {
        const status = !item.arriving ? 'OCCUPIED' : i % 5 === 4 ? 'DIRTY' : 'CLEAN';
        const res = await api('PATCH', `/api/rooms/${item.room.id}/status`, { status }, { raw: true });
        if (res.status !== 200) { bad(`room ${item.room.number}: ${res.body?.error || res.status}`); continue; }
        if (status === 'CLEAN') clean += 1;
        else if (status === 'OCCUPIED') occupied += 1;
        else dirty += 1;
      }
      ok(`${clean} clean and ready to inspect, ${occupied} occupied, ${dirty} dirty`);

      console.log('');
      info('Rooms you can inspect against a real booking:');
      for (const item of created) {
        if (!item.arriving) continue;
        console.log(
          `    ${c.bold}${item.room.number}${c.reset} ${c.dim}${item.g.type}${c.reset}  ` +
          `${item.g.name} — ${item.g.adults + item.g.children} guest(s)`
        );
      }
    }
  }

  console.log(`\n${c.green}${c.bold}Done.${c.reset}`);
  console.log(`${c.dim}Housekeeping → pick a CLEAN room → "Inspect Room Against Booking".`);
  console.log(`Assign an authored scenario to a room from the same panel.${c.reset}\n`);
}

main().catch((e) => {
  console.error(`\n${c.red}Unexpected error:${c.reset} ${e.stack || e.message}\n`);
  process.exit(1);
});
