#!/usr/bin/env node
/**
 * One-time backfill: create inventory holds for reservations that already exist.
 *
 * WHY THIS IS MANDATORY BEFORE GOING LIVE
 * ---------------------------------------
 * Availability is now derived exclusively from InventoryHold rows
 * (available = totalInventory - peakHeld). Before Phase 1, holds were created by
 * a Redis subscriber that frequently missed them, and any reservation created
 * through the staff wizard never had one at all.
 *
 * So on the first boot after deploying Phase 1, every pre-existing booking is
 * INVISIBLE to availability: the hotel reads as 100% empty and those rooms can be
 * sold again. Running this closes that window.
 *
 *   docker compose up -d
 *   node scripts/backfill-inventory-holds.mjs --dry-run    # inspect first
 *   node scripts/backfill-inventory-holds.mjs
 *
 * Options:
 *   --url=http://localhost:8080
 *   --username=admin --password=…   (defaults to ADMIN_INITIAL_PASSWORD from .env)
 *   --dry-run     report what would happen, change nothing
 *
 * Safe to re-run: reservations that already carry a hold are skipped, so a
 * partial run can simply be repeated.
 */

import { readFileSync } from 'node:fs';

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

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const BASE = args.url || process.env.GATEWAY_URL || 'http://localhost:8080';
const DRY = Boolean(args['dry-run']);

// Statuses that still occupy a room. Cancelled/no-show/checked-out do not.
const LIVE_STATUSES = new Set(['PENDING', 'CONFIRMED', 'CHECKED_IN', 'IN_HOUSE']);

let token = null;

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Idempotency-Key': `backfill-${Math.random().toString(36).slice(2)}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const day = (d) => new Date(d).toISOString().slice(0, 10);

async function main() {
  console.log(`Inventory hold backfill${DRY ? '  (DRY RUN — nothing will be written)' : ''}`);
  console.log(`gateway: ${BASE}\n`);

  const login = await api('POST', '/api/auth/login', {
    username: args.username || 'admin',
    password: resolveAdminPassword(args.password),
  });
  if (login.status !== 200) {
    console.error(`Login failed (${login.status}). Is the stack up?`);
    process.exit(2);
  }
  token = login.body.token || login.body.accessToken;

  const list = await api('GET', '/api/reservations');
  if (list.status !== 200) {
    console.error(`Could not list reservations (${list.status})`);
    process.exit(2);
  }

  const live = list.body.filter((r) => LIVE_STATUSES.has(r.status));
  const needing = live.filter((r) => !r.inventoryHoldGroupId);

  console.log(`  ${list.body.length} reservations total`);
  console.log(`  ${live.length} in a status that occupies a room`);
  console.log(`  ${needing.length} with NO inventory hold — these are invisible to availability\n`);

  if (needing.length === 0) {
    console.log('Nothing to backfill.\n');
    return;
  }

  const done = [];
  const conflicts = [];
  const failed = [];

  for (const r of needing) {
    const label = `${r.confirmationNumber} ${r.roomTypeCode} ${day(r.checkIn)}→${day(r.checkOut)}`;
    if (DRY) { console.log(`  would hold  ${label}`); done.push(r.id); continue; }

    // reservationId is supplied up front, so the hold is created already attached
    // and expires at checkout rather than after the short unattached TTL.
    const hold = await api('POST', '/api/holds', {
      roomTypeCode: r.roomTypeCode,
      checkIn: day(r.checkIn),
      checkOut: day(r.checkOut),
      quantity: 1,
      reservationId: r.id,
    });

    if (hold.status === 201) {
      // Record the group on the reservation so a later cancel can release it.
      await api('PATCH', `/api/reservations/${r.id}`, { inventoryHoldGroupId: hold.body.groupId });
      console.log(`  ✓ held      ${label}`);
      done.push(r.id);
    } else if (hold.status === 409) {
      // Genuine pre-existing oversell: more live bookings than the room type has
      // rooms. This is real corruption produced by the pre-fix code and needs a
      // human decision, so it is reported rather than forced.
      console.log(`  ! OVERSOLD  ${label} — ${hold.body?.error || ''}`);
      conflicts.push({ label, detail: hold.body });
    } else {
      console.log(`  ✗ failed    ${label} (${hold.status}) ${hold.body?.error || ''}`);
      failed.push(label);
    }
  }

  console.log(`\n  held: ${done.length}   oversold: ${conflicts.length}   failed: ${failed.length}`);

  if (conflicts.length) {
    console.log(`\n${conflicts.length} reservation(s) could not be held because the room type is`);
    console.log('already at capacity. These are pre-existing double-bookings created by the');
    console.log('old code. Each needs a decision — move to another room type, or cancel:\n');
    for (const c of conflicts) console.log(`  ${c.label}`);
    console.log('');
    process.exit(1);
  }
  console.log('');
}

main().catch((e) => { console.error(`\nUnexpected error: ${e.stack || e.message}\n`); process.exit(2); });
