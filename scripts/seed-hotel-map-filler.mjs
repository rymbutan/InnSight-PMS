#!/usr/bin/env node
/**
 * Adds purely COSMETIC filler rooms to the Multi-Lane scenario's existing
 * room types so the Map & Housekeeping page's floor map looks like a normal,
 * fully-populated hotel floor instead of 2-3 rooms adrift in an otherwise
 * empty corridor.
 *
 * This does NOT touch anything the scenario actually uses: it creates only
 * new CLEAN rooms with brand-new numbers (never a number any lane package or
 * dialogue script references) and attaches no guest, reservation, or work
 * order to any of them. Every guest/reservation/stay/work-order that
 * `scripts/seed-multilane.mjs` created stays exactly as it was — this script
 * only enlarges the room *count* those lanes' existing STD/DLX-style codes
 * point at, then raises each type's totalInventory to match so a future
 * booking can actually reach the new rooms instead of being capped at the
 * old physical count.
 *
 * PREREQUISITE: run `bash scripts/seed-demo.sh` then `node
 * scripts/seed-multilane.mjs` first — this script requires all six room
 * types (STD/DLX, STDB/DLXB, STDC/DLXC) to already exist.
 *
 *   node scripts/seed-hotel-map-filler.mjs
 *
 * Options:
 *   --url=http://localhost:8080     gateway base URL
 *   --username=admin --password=…   (defaults to ADMIN_INITIAL_PASSWORD from .env)
 *   --dry-run                       print what would happen, change nothing
 *
 * Idempotent: only creates a room number that doesn't already exist, and
 * only raises a type's totalInventory, never lowers it. Safe to re-run.
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

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Idempotency-Key': `seed-hk-filler-${Math.random().toString(36).slice(2)}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return parsed;
}

// ── What to fill ─────────────────────────────────────────────────────────
// computeLayout() splits a floor's rooms into two rows of ceil(count/2), and
// picks a room width to fit MAP_W's 980 units across however many columns
// the busiest floor needs. 16 rooms → 8 columns → exactly the 109px-wide
// room MAP_W was originally sized for (see hotelMap.js and its "seeded
// property" test) — the same density as the reference screenshot's 8-top/
// 7-bottom floor. Anything less just renders a smaller, correctly-proportioned
// map (which is the fix from the last pass); this is the number that makes a
// floor fill MAP_W's full width the way the reference image does.
const TARGET_PER_FLOOR = 16;

// One entry per (lane, room-type) pair — the two floors' worth of REAL rooms
// scripts/seed-demo.sh / seed-multilane.mjs already created for it, so this
// script knows exactly which numbers are already spoken for.
const GROUPS = [
  { code: 'STD', floors: [1, 2] },
  { code: 'DLX', floors: [3, 4] },
  { code: 'STDB', floors: [5, 6] },
  { code: 'DLXB', floors: [7, 8] },
  { code: 'STDC', floors: [9, 10] },
  { code: 'DLXC', floors: [11, 12] },
];

async function main() {
  console.log(`\n${c.bold}InnSight — hotel map filler rooms${c.reset}`);
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

  head('Precondition: all six room types exist');
  const types = await api('GET', '/api/room-types');
  const typeByCode = new Map(types.map((t) => [t.code, t]));
  const missing = GROUPS.map((g) => g.code).filter((code) => !typeByCode.has(code));
  if (missing.length) {
    bad(`missing room type(s): ${missing.join(', ')}`);
    console.log(`\n${c.yellow}Run 'bash scripts/seed-demo.sh' then 'node scripts/seed-multilane.mjs' first.${c.reset}\n`);
    process.exit(2);
  }
  ok('STD/DLX/STDB/DLXB/STDC/DLXC all exist');

  const rooms = await api('GET', '/api/rooms');
  const haveNumbers = new Set(rooms.map((r) => r.number));
  const countByCode = new Map();
  for (const r of rooms) countByCode.set(r.typeCode, (countByCode.get(r.typeCode) || 0) + 1);

  for (const group of GROUPS) {
    head(`${group.code} (floors ${group.floors.join(', ')})`);
    let created = 0;
    for (const floor of group.floors) {
      // Existing real rooms on this floor, so filler numbers never collide
      // with a room a dialogue script or lane package actually names.
      const existingOnFloor = rooms.filter((r) => r.floor === floor && r.typeCode === group.code).length;
      const need = Math.max(0, TARGET_PER_FLOOR - existingOnFloor);
      if (!need) { skip(`floor ${floor} already has ${existingOnFloor} rooms`); continue; }
      // Filler numbers continue the floor's own numbering upward, past
      // whatever the scenario already claimed (e.g. floor 1 has 101-103 →
      // filler starts at 104).
      let next = floor * 100 + existingOnFloor + 1;
      for (let i = 0; i < need; i += 1) {
        while (haveNumbers.has(String(next))) next += 1;
        const number = String(next);
        if (DRY) { info(`would create room ${number} (${group.code}, floor ${floor})`); next += 1; continue; }
        await api('POST', '/api/rooms', { number, typeCode: group.code, floor });
        haveNumbers.add(number);
        created += 1;
        next += 1;
      }
      ok(`floor ${floor}: added ${need} filler room(s) → ${TARGET_PER_FLOOR} total`);
    }

    const targetTotal = group.floors.length * TARGET_PER_FLOOR;
    const currentTotal = (countByCode.get(group.code) || 0) + created;
    const type = typeByCode.get(group.code);
    if (DRY) {
      info(`would raise ${group.code} totalInventory to ${targetTotal} (from ${type.totalInventory})`);
    } else if (type.totalInventory < targetTotal) {
      await api('PATCH', `/api/room-types/${type.code}`, { totalInventory: targetTotal });
      ok(`${group.code} totalInventory: ${type.totalInventory} → ${targetTotal}`);
    } else {
      skip(`${group.code} totalInventory already ${type.totalInventory} (≥ ${targetTotal})`);
    }
  }

  console.log(`\n${c.bold}${c.green}✓ Hotel map filler complete.${c.reset}`);
  console.log(`  Every floor now has ${TARGET_PER_FLOOR} rooms — refresh Map & Housekeeping to see it.\n`);
}

main().catch((e) => {
  bad(e.message);
  process.exit(1);
});
