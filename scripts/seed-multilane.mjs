#!/usr/bin/env node
/**
 * Seeds everything the Multi-Lane Coordination Guide's three lanes need to be
 * runnable from a fresh `docker compose up -d` — Lane B's and Lane C's own
 * room types/rooms, all three lanes' "Holiday Weekend" rate plans, the
 * carryover maintenance tickets, and every guest/reservation/stay each
 * lane's Full-Shift package assumes is already in the system before the
 * 3:00 PM whistle.
 *
 * This goes through the gateway API exactly the way a facilitator's own
 * Admin login would, so it reproduces the same scenario data on ANY
 * deployment of this repo — not just whichever machine happened to have it
 * set up by hand. Check the result into nothing; run it fresh on each stack.
 *
 * PREREQUISITE: run `bash scripts/seed-demo.sh` FIRST. That script creates
 * Lane A's own room types (STD/DLX), 10 rooms, and its own generic demo
 * guests/reservations (Maria Santos, Juan Dela Cruz, Aiko Reyes) — this
 * script only adds Lane B and Lane C on top, plus the scenario's
 * guests/reservations/stays for all three lanes at once. It will refuse to
 * continue if STD/DLX don't exist yet, rather than silently building Lane
 * A's half of the scenario on top of nothing.
 *
 * Lane A's two arrival guests (Maria Santos, Juan Dela Cruz) are NOT
 * created again here — they're already seed-demo.sh's own guests. Instead
 * this script PATCHes those two existing reservations into the exact room
 * and dates the scenario board expects (seed-demo.sh's own bookings have no
 * assignedRoomId and the wrong dates for Juan, since it isn't scenario-aware).
 *
 *   docker compose up -d
 *   bash scripts/seed-demo.sh
 *   node scripts/seed-multilane.mjs
 *
 * Options:
 *   --url=http://localhost:8080     gateway base URL
 *   --username=admin --password=…   (defaults to ADMIN_INITIAL_PASSWORD from .env)
 *   --dry-run                       print what would happen, change nothing
 *
 * Safe to re-run for the room/rate-plan setup (idempotent). The guests,
 * reservations, stays, and work orders are NOT re-created if a reservation
 * for that lane's no-show guest already exists — that's this script's proxy
 * for "this lane has already been seeded," since none of those have a
 * natural unique key to upsert against.
 */

import { readFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const BASE = args.url || process.env.GATEWAY_URL || 'http://localhost:8080';
const DRY = !!args['dry-run'];

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const head = (t) => console.log(`\n${c.bold}${c.cyan}── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}${c.reset}`);
const ok = (t) => console.log(`  ${c.green}✓${c.reset} ${t}`);
const bad = (t) => console.log(`  ${c.red}✗${c.reset} ${t}`);
const skip = (t) => console.log(`  ${c.dim}~ ${t}${c.reset}`);
const info = (t) => console.log(`  ${c.dim}${t}${c.reset}`);

// Same resolution order as seed-test-data.mjs / prove-no-double-booking.mjs.
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
      'Idempotency-Key': `seed-multilane-${Math.random().toString(36).slice(2)}`,
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

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

// ── The three lanes ──────────────────────────────────────────────────────
// Room numbers, room-type codes, and rates all come straight from the
// Coordination Guide's Section 2 partition table and each lane's own
// package Section 2.2. Every lane is the same 6 Standard + 4 Deluxe shape;
// only the numbers, codes, and cast differ.
const RATE_STD = 150000; // PHP 1,500
const RATE_DLX = 280000; // PHP 2,800
const RATE_STD_HOLIDAY = 165000; // PHP 1,650 — Admin's pre-shift surge, ~10% over base
const RATE_DLX_HOLIDAY = 308000; // PHP 3,080

const LANES = [
  {
    name: 'A',
    stdCode: 'STD',
    dlxCode: 'DLX',
    createRoomTypes: false, // scripts/seed-demo.sh already made these
    board: {
      std: ['101', '102', '103', '201', '202', '203'],
      dlx: ['301', '302', '401', '402'],
      // number -> starting status, for everything that ISN'T the default
      // CLEAN a freshly-created room gets, and isn't handled by the
      // ambient walk-in / no-show reservation below.
      statusFixes: { '102': 'OUT_OF_ORDER', '201': 'DIRTY', '202': 'DIRTY', '401': 'DIRTY', '402': 'DIRTY' },
      brokenLockRoom: '102',
      ambientLongStayRoom: '101',
      ambientNamedRoom: '301',
      ambientNamedGuest: 'Mr. Tan',
      arrivalStdRoom: '103',
      arrivalStdGuest: { first: 'Maria', last: 'Santos' },
      arrivalDlxRoom: '302',
      arrivalDlxGuest: { first: 'Juan', last: 'Dela Cruz' },
      noShowGuest: { first: 'Ramon', last: 'Cruz' },
      noShowRef: 'RC-SETUP-01',
    },
  },
  {
    name: 'B',
    stdCode: 'STDB',
    dlxCode: 'DLXB',
    createRoomTypes: true,
    board: {
      std: ['501', '502', '503', '601', '602', '603'],
      dlx: ['701', '702', '801', '802'],
      statusFixes: { '502': 'OUT_OF_ORDER', '601': 'DIRTY', '602': 'DIRTY', '801': 'DIRTY', '802': 'DIRTY' },
      brokenLockRoom: '502',
      ambientLongStayRoom: '501',
      ambientNamedRoom: '701',
      ambientNamedGuest: 'Mr. Ocampo',
      arrivalStdRoom: '503',
      arrivalStdGuest: { first: 'Isabel', last: 'Aquino' },
      arrivalDlxRoom: '702',
      arrivalDlxGuest: { first: 'Rafael', last: 'Mendoza' },
      noShowGuest: { first: 'Renato', last: 'Bonifacio' },
      noShowRef: 'RB-SETUP-01',
    },
  },
  {
    name: 'C',
    stdCode: 'STDC',
    dlxCode: 'DLXC',
    createRoomTypes: true,
    board: {
      std: ['901', '902', '903', '1001', '1002', '1003'],
      dlx: ['1101', '1102', '1201', '1202'],
      statusFixes: { '902': 'OUT_OF_ORDER', '1001': 'DIRTY', '1002': 'DIRTY', '1201': 'DIRTY', '1202': 'DIRTY' },
      brokenLockRoom: '902',
      ambientLongStayRoom: '901',
      ambientNamedRoom: '1101',
      ambientNamedGuest: 'Mr. Marquez',
      arrivalStdRoom: '903',
      arrivalStdGuest: { first: 'Grace', last: 'Domingo' },
      arrivalDlxRoom: '1102',
      arrivalDlxGuest: { first: 'Patrick', last: 'Fernandez' },
      noShowGuest: { first: 'Ferdie', last: 'Solis' },
      noShowRef: 'FS-SETUP-01',
    },
  },
];

async function ensureGuest(first, last) {
  if (DRY) return null;
  const g = await api('POST', '/api/guests', { firstName: first, lastName: last });
  return g.id;
}

async function main() {
  console.log(`\n${c.bold}InnSight — Multi-Lane scenario seed${c.reset}`);
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

  head('Precondition: Lane A room types');
  const existingTypes = await api('GET', '/api/room-types');
  const codes = new Set(existingTypes.map((t) => t.code));
  if (!codes.has('STD') || !codes.has('DLX')) {
    bad('STD/DLX do not exist yet.');
    console.log(`\n${c.yellow}Run 'bash scripts/seed-demo.sh' first — it creates Lane A's room types and 10 rooms.${c.reset}\n`);
    process.exit(2);
  }
  ok('STD and DLX exist — Lane A is ready to build on');

  // ── Room types (Lane B / Lane C only) ─────────────────────────────────
  head('Room types (Lane B / Lane C)');
  for (const lane of LANES) {
    if (!lane.createRoomTypes) { skip(`Lane ${lane.name}: STD/DLX already exist`); continue; }
    for (const [code, rate] of [[lane.stdCode, RATE_STD], [lane.dlxCode, RATE_DLX]]) {
      if (codes.has(code)) { skip(`${code} already exists`); continue; }
      if (DRY) { info(`would create room type ${code}`); continue; }
      const count = code === lane.stdCode ? 6 : 4;
      await api('POST', '/api/room-types', {
        code,
        name: `${code === lane.stdCode ? 'Standard' : 'Deluxe'} (Lane ${lane.name})`,
        baseRate: rate,
        maxOccupancy: code === lane.stdCode ? 2 : 3,
        totalInventory: count,
      });
      ok(`created ${code}`);
    }
  }

  // ── Rooms (Lane B / Lane C only) ──────────────────────────────────────
  head('Rooms (Lane B / Lane C)');
  const existingRooms = await api('GET', '/api/rooms');
  const haveNumbers = new Set(existingRooms.map((r) => r.number));
  for (const lane of LANES) {
    if (!lane.createRoomTypes) continue;
    for (const n of lane.board.std) {
      if (haveNumbers.has(n)) { skip(`room ${n} already exists`); continue; }
      if (DRY) { info(`would create room ${n} (${lane.stdCode})`); continue; }
      await api('POST', '/api/rooms', { number: n, typeCode: lane.stdCode, floor: Math.floor(Number(n) / 100) });
      ok(`room ${n} (${lane.stdCode})`);
    }
    for (const n of lane.board.dlx) {
      if (haveNumbers.has(n)) { skip(`room ${n} already exists`); continue; }
      if (DRY) { info(`would create room ${n} (${lane.dlxCode})`); continue; }
      await api('POST', '/api/rooms', { number: n, typeCode: lane.dlxCode, floor: Math.floor(Number(n) / 100) });
      ok(`room ${n} (${lane.dlxCode})`);
    }
  }

  // Number -> id lookup, refreshed now that Lane B/C's rooms exist.
  const allRooms = DRY ? existingRooms : await api('GET', '/api/rooms');
  const roomIdByNumber = new Map(allRooms.map((r) => [r.number, r.id]));
  const roomId = (n) => {
    const id = roomIdByNumber.get(n);
    if (!id && !DRY) bad(`room ${n} not found — was it created above?`);
    return id;
  };

  // ── Holiday Weekend rate plans (all 3 lanes) ──────────────────────────
  head('Holiday Weekend rate plans');
  const existingPlans = DRY ? [] : await api('GET', '/api/rate-plans').catch(() => []);
  const planExists = (code) => existingPlans.some((p) => p.roomTypeCode === code && p.name === 'Holiday Weekend');
  const validFrom = iso(new Date());
  const validTo = iso(addDays(new Date(), 365));
  for (const lane of LANES) {
    for (const [code, rate] of [
      [lane.stdCode, RATE_STD_HOLIDAY],
      [lane.dlxCode, RATE_DLX_HOLIDAY],
    ]) {
      if (planExists(code)) { skip(`Holiday Weekend / ${code} already exists`); continue; }
      if (DRY) { info(`would create Holiday Weekend rate plan for ${code}`); continue; }
      await api('POST', '/api/rate-plans', {
        roomTypeCode: code,
        name: 'Holiday Weekend',
        baseRate: rate,
        validFrom: `${validFrom}T00:00:00.000Z`,
        validTo: `${validTo}T00:00:00.000Z`,
      });
      ok(`Holiday Weekend / ${code}`);
    }
  }

  // ── Room board — status fixes ──────────────────────────────────────────
  // Everything else (the two arrival rooms, the ambient rooms before their
  // walk-in below) is left at the CLEAN a freshly-created room defaults to.
  head('Room board — starting statuses');
  for (const lane of LANES) {
    for (const [number, status] of Object.entries(lane.board.statusFixes)) {
      const id = roomId(number);
      if (!id) continue;
      if (DRY) { info(`would set ${number} → ${status}`); continue; }
      await api('PATCH', `/api/rooms/${id}/status`, { status });
      ok(`Lane ${lane.name}: ${number} → ${status}`);
    }
  }

  // ── Guests, reservations, stays, work orders — per lane ────────────────
  const today = new Date();
  const tomorrow = addDays(today, 1);
  const dayAfter = addDays(today, 2);
  const inThreeDays = addDays(today, 3);

  for (const lane of LANES) {
    head(`Lane ${lane.name} — scenario data`);
    const b = lane.board;

    // "Already seeded" check: does this lane's no-show guest already have a
    // reservation? If so, skip the whole lane rather than risk creating a
    // second no-show/arrival for the same person.
    if (!DRY) {
      const already = await api(
        'GET',
        `/api/reservations?guestName=${encodeURIComponent(`${b.noShowGuest.first} ${b.noShowGuest.last}`)}`
      ).catch(() => []);
      if (Array.isArray(already) && already.length > 0) {
        skip(`Lane ${lane.name} already has a reservation for ${b.noShowGuest.first} ${b.noShowGuest.last} — skipping the rest of this lane`);
        continue;
      }
    }

    if (DRY) { info(`would seed guests/reservations/stays/work orders for Lane ${lane.name}`); continue; }

    // Guests — Lane A's two arrivals (Maria Santos, Juan Dela Cruz) are NOT
    // created here: scripts/seed-demo.sh already created guests with those
    // exact names as its own generic demo bookings. Creating a second pair
    // would leave two different "Maria Santos" people in the system. Lane A
    // instead reuses and corrects seed-demo.sh's own reservations below.
    const guestIds = {};
    const guestList = [
      ['noShow', b.noShowGuest],
      ['ambientNamed', { first: '', last: b.ambientNamedGuest.replace(/^Mr\.\s*/, '') }],
      ['ambientLongStay', { first: 'Long-Stay', last: `Guest (Lane ${lane.name})` }],
    ];
    if (lane.createRoomTypes) guestList.splice(1, 0, ['arrivalStd', b.arrivalStdGuest], ['arrivalDlx', b.arrivalDlxGuest]);
    for (const [key, person] of guestList) {
      guestIds[key] = await ensureGuest(person.first, person.last);
    }
    ok('guest profiles created');

    // No-show reservation — Bank Transfer deposit, so this pass also
    // exercises the Payment step's deposit sub-fields.
    const noShow = await api('POST', '/api/reservations', {
      guestId: guestIds.noShow,
      guestName: `${b.noShowGuest.first} ${b.noShowGuest.last}`,
      guestEmail: `${b.noShowGuest.first}.${b.noShowGuest.last}`.toLowerCase().replace(/\s+/g, '') + '@example.test',
      guestPhone: '09171234567',
      roomTypeCode: lane.stdCode,
      checkIn: iso(today),
      checkOut: iso(tomorrow),
      adults: 1,
      source: 'DIRECT',
      totalEstimateCents: RATE_STD,
      depositCents: RATE_STD,
      paymentType: 'BANK_TRANSFER',
      bankName: 'BDO',
      transferNetwork: 'InstaPay',
      senderName: `${b.noShowGuest.first} ${b.noShowGuest.last}`,
      reference: b.noShowRef,
      ratePlan: 'Base Rate',
      origin: 'Multi-Lane Pre-Shift Setup',
    });
    await api('PATCH', `/api/reservations/${noShow.id}`, { assignedRoomId: '' });
    await api('POST', `/api/reservations/${noShow.id}/confirm`);
    ok(`no-show reservation: ${b.noShowGuest.first} ${b.noShowGuest.last} (${noShow.confirmationNumber})`);

    if (lane.createRoomTypes) {
      // Arrival reservations — explicit assignedRoomId. Auto-assignment
      // ignores Room.status entirely (it only avoids rooms with an
      // overlapping RESERVATION), so leaving the room unspecified risks
      // landing an arrival on top of the ambient "occupied" room below.
      const arrivalStd = await api('POST', '/api/reservations', {
        guestId: guestIds.arrivalStd,
        guestName: `${b.arrivalStdGuest.first} ${b.arrivalStdGuest.last}`,
        guestEmail: `${b.arrivalStdGuest.first}.${b.arrivalStdGuest.last}`.toLowerCase().replace(/\s+/g, '') + '@example.test',
        guestPhone: '09171234567',
        roomTypeCode: lane.stdCode,
        assignedRoomId: roomId(b.arrivalStdRoom),
        checkIn: iso(today),
        checkOut: iso(tomorrow),
        adults: 2,
        source: 'DIRECT',
        totalEstimateCents: RATE_STD,
        depositCents: RATE_STD,
        paymentType: 'CASH',
        ratePlan: 'Base Rate',
        origin: 'Multi-Lane Pre-Shift Setup',
      });
      await api('POST', `/api/reservations/${arrivalStd.id}/confirm`);
      ok(`scheduled arrival: ${b.arrivalStdGuest.first} ${b.arrivalStdGuest.last} → room ${b.arrivalStdRoom} (${arrivalStd.confirmationNumber})`);

      // Early Arrival's reservation is for TOMORROW — the whole point of that
      // scene is Front Desk moving it up to today live during the shift.
      const arrivalDlx = await api('POST', '/api/reservations', {
        guestId: guestIds.arrivalDlx,
        guestName: `${b.arrivalDlxGuest.first} ${b.arrivalDlxGuest.last}`,
        guestEmail: `${b.arrivalDlxGuest.first}.${b.arrivalDlxGuest.last}`.toLowerCase().replace(/\s+/g, '') + '@example.test',
        guestPhone: '09171234567',
        roomTypeCode: lane.dlxCode,
        assignedRoomId: roomId(b.arrivalDlxRoom),
        checkIn: iso(tomorrow),
        checkOut: iso(dayAfter),
        adults: 2,
        source: 'DIRECT',
        totalEstimateCents: RATE_DLX,
        depositCents: RATE_DLX,
        paymentType: 'CASH',
        ratePlan: 'Base Rate',
        origin: 'Multi-Lane Pre-Shift Setup',
      });
      await api('POST', `/api/reservations/${arrivalDlx.id}/confirm`);
      ok(`early arrival (booked for tomorrow): ${b.arrivalDlxGuest.first} ${b.arrivalDlxGuest.last} → room ${b.arrivalDlxRoom} (${arrivalDlx.confirmationNumber})`);
    } else {
      // Lane A: seed-demo.sh already created "Maria Santos" (STD) and "Juan
      // Dela Cruz" (DLX) reservations with no assignedRoomId — auto-assignment
      // picks whichever room of that type is free first, which is NOT
      // guaranteed to be 103/302 (Room.status is cosmetic and ignored by
      // assignment). Correct those two reservations in place instead of
      // creating a second, same-named guest for each.
      const mariaMatches = await api('GET', `/api/reservations?guestName=${encodeURIComponent(`${b.arrivalStdGuest.first} ${b.arrivalStdGuest.last}`)}`);
      const maria = Array.isArray(mariaMatches) ? mariaMatches[0] : null;
      if (maria) {
        await api('PATCH', `/api/reservations/${maria.id}`, { assignedRoomId: roomId(b.arrivalStdRoom) });
        ok(`corrected room assignment: ${b.arrivalStdGuest.first} ${b.arrivalStdGuest.last} → room ${b.arrivalStdRoom} (${maria.confirmationNumber || maria.id})`);
      } else {
        bad(`no reservation found for ${b.arrivalStdGuest.first} ${b.arrivalStdGuest.last} — did scripts/seed-demo.sh run first?`);
      }

      // Juan's canonical booking is a ONE-NIGHT Deluxe stay for TOMORROW
      // (the "Early Arrival" scene moves it up to today live) — seed-demo.sh's
      // own booking is a two-night stay starting tomorrow with no room, so
      // both the room and the dates need correcting here.
      const juanMatches = await api('GET', `/api/reservations?guestName=${encodeURIComponent(`${b.arrivalDlxGuest.first} ${b.arrivalDlxGuest.last}`)}`);
      const juan = Array.isArray(juanMatches) ? juanMatches[0] : null;
      if (juan) {
        await api('PATCH', `/api/reservations/${juan.id}`, {
          assignedRoomId: roomId(b.arrivalDlxRoom),
          checkIn: iso(tomorrow),
          checkOut: iso(dayAfter),
        });
        ok(`corrected: ${b.arrivalDlxGuest.first} ${b.arrivalDlxGuest.last} → room ${b.arrivalDlxRoom}, booked for tomorrow (1 night) (${juan.confirmationNumber || juan.id})`);
      } else {
        bad(`no reservation found for ${b.arrivalDlxGuest.first} ${b.arrivalDlxGuest.last} — did scripts/seed-demo.sh run first?`);
      }
    }

    // Ambient in-house guests — walk-in check-in directly onto the still-
    // CLEAN rooms created above; the room:checkin event flips each one to
    // OCCUPIED automatically.
    await api('POST', '/api/walk-in', {
      guestName: `Long-Stay Guest`,
      guestId: guestIds.ambientLongStay,
      assignedRoomId: roomId(b.ambientLongStayRoom),
      expectedCheckOut: iso(dayAfter),
    });
    ok(`ambient long-stay guest → room ${b.ambientLongStayRoom} (checks out in 2 days)`);

    await api('POST', '/api/walk-in', {
      guestName: b.ambientNamedGuest,
      guestId: guestIds.ambientNamed,
      assignedRoomId: roomId(b.ambientNamedRoom),
      expectedCheckOut: iso(inThreeDays),
    });
    ok(`${b.ambientNamedGuest} (in-house, AC complaint thread) → room ${b.ambientNamedRoom}`);

    // Carryover maintenance work order — the broken door lock Maintenance
    // closes in Rotation 1.
    await api('POST', '/api/work-orders', {
      type: 'REACTIVE',
      priority: 'NORMAL',
      category: 'Door Lock',
      roomId: roomId(b.brokenLockRoom),
      reportedBy: 'Front Desk',
      description: 'Broken door lock, reported yesterday.',
      estimatedMinutes: 30,
    });
    ok(`carryover work order: broken door lock, room ${b.brokenLockRoom}`);
  }

  console.log(`\n${c.bold}${c.green}✓ Multi-Lane scenario seed complete.${c.reset}`);
  console.log('  All three lanes are ready for their own Auditor to open the business day and start Rotation 1.\n');
}

main().catch((e) => {
  bad(e.message);
  process.exit(1);
});
