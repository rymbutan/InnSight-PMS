#!/usr/bin/env node
/**
 * One-time backfill: post the missing room charge(s) onto already-checked-in
 * stays' folios.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * Room charges used to be posted ONLY by the night audit (once per business
 * day). Check-in was fixed to also post the ENTIRE stay's room charges
 * immediately — one line per reserved night — (see
 * services/folio/src/subscribers/redis.subscriber.js), under the SAME
 * reference the night audit itself checks before charging a stay for a given
 * day (`AUDIT-<businessDay>-<stayId>`) — so the two never double-charge, and
 * an early departure is credited back through the existing
 * POST /folios/:id/early-departure-adjustment route rather than needing this
 * to guess who left early.
 *
 * That fix only runs on a FRESH `room:checkin` event, though, so any guest who
 * was already checked in before it shipped still has a folio missing every
 * reserved night's room charge (unless the night audit happened to run for
 * some of those days already — in which case this correctly finds nothing to
 * do for them). This script catches those stays up to the full reservation
 * total, exactly as if they had checked in under the new code.
 *
 *   docker compose up -d
 *   node scripts/backfill-checkin-room-charges.mjs --dry-run    # inspect first
 *   node scripts/backfill-checkin-room-charges.mjs
 *
 * Options:
 *   --url=http://localhost:8080
 *   --username=admin --password=…   (defaults to ADMIN_INITIAL_PASSWORD from .env)
 *   --dry-run     report what would be posted, change nothing
 *
 * Safe to re-run: a night already charged (by this script, by the night audit,
 * or by check-in itself) carries the `AUDIT-<day>-<stayId>` reference and is
 * skipped, so a partial or repeated run never double-posts.
 */

import { readFileSync } from 'node:fs';

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
  } catch {
    /* no .env — fall through */
  }
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
// Business days are LOCAL calendar days in the property's own timezone (see
// services/*/src/lib/date.js), not whatever timezone this script happens to
// run in. docker-compose.yml sets every container's TZ to this same default.
const PROPERTY_TZ = process.env.TZ_PROPERTY || process.env.TZ || 'Asia/Manila';
const ROOM_CHARGE_CODE = 'RM';
// A stay in-house this long with no room charges at all would mean something
// is badly wrong (or the data is a demo seed with a far-future/garbage
// check-in date) — cap the catch-up window rather than loop indefinitely.
const MAX_NIGHTS_PER_STAY = 60;

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
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

// 'YYYY-MM-DD' for `d` in the property's timezone — matches localDay()'s
// convention in services/*/src/lib/date.js.
function localDay(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PROPERTY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d instanceof Date ? d : new Date(d));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function nextDayKey(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

const peso = (cents) => `₱${(cents / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

async function main() {
  console.log(`Check-in room charge backfill${DRY ? '  (DRY RUN — nothing will be written)' : ''}`);
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

  const stays = await api('GET', '/api/in-house');
  if (stays.status !== 200) {
    console.error(`Could not list in-house stays (${stays.status})`);
    process.exit(2);
  }

  console.log(`  ${stays.body.length} stay(s) currently in-house\n`);

  let postedNights = 0;
  let touchedStays = 0;
  let skippedWalkIn = 0;
  let skippedNoRate = 0;
  let skippedNoFolio = 0;
  let errors = 0;

  for (const s of stays.body) {
    const label = `${s.guestName || s.id}${s.assignedRoomId ? ` (room ${s.assignedRoomId})` : ''}`;

    // Walk-ins carry no reservation, and so no rate to charge — same scope
    // limit as the check-in fix itself. Fixing that needs a rate field on the
    // walk-in form, which is a separate change.
    if (!s.reservationId) {
      skippedWalkIn += 1;
      continue;
    }

    const rRes = await api('GET', `/api/reservations/${encodeURIComponent(s.reservationId)}`);
    if (rRes.status !== 200) {
      console.log(`  ✗ ${label}: could not load reservation (${rRes.status})`);
      errors += 1;
      continue;
    }
    const r = rRes.body;
    const nights = r.nights || 1;
    const totalEstimateCents = Number(r.totalEstimateCents || 0);
    const nightlyCents = totalEstimateCents > 0 ? Math.round(totalEstimateCents / nights) : 0;
    if (nightlyCents <= 0) {
      console.log(`  – ${label}: no usable nightly rate on the reservation — skipped`);
      skippedNoRate += 1;
      continue;
    }

    const foliosRes = await api('GET', `/api/folios?stayId=${encodeURIComponent(s.id)}`);
    const folioSummary = (foliosRes.body || []).find((f) => f.status === 'OPEN');
    if (!folioSummary) {
      console.log(`  – ${label}: no open folio found — skipped`);
      skippedNoFolio += 1;
      continue;
    }

    // The LIST route (above) intentionally returns only a summary row — no
    // `transactions` — so the idempotency check MUST re-fetch the single-folio
    // route, which does include them. Reading `.transactions` off the list
    // row silently produces an empty set and defeats the whole point of
    // checking existing references first.
    const folioRes = await api('GET', `/api/folios/${folioSummary.id}`);
    const folio = folioRes.body;
    const existingRefs = new Set((folio?.transactions || []).map((t) => t.reference).filter(Boolean));
    if (!r.checkIn) {
      console.log(`  – ${label}: reservation has no checkIn date — skipped`);
      continue;
    }

    // Every reserved night, from the RESERVATION's own check-in day — same
    // window the check-in fix itself charges — not just the nights elapsed
    // so far. A guest mid-stay still owes their remaining nights up front.
    let day = localDay(r.checkIn);
    let postedForStay = 0;
    const nightsToCharge = Math.min(nights, MAX_NIGHTS_PER_STAY);
    for (let i = 0; i < nightsToCharge; i += 1) {
      const reference = `AUDIT-${day}-${s.id}`;
      if (!existingRefs.has(reference)) {
        if (DRY) {
          console.log(`  would post  ${label}: ${day} — ${peso(nightlyCents)}`);
          postedForStay += 1;
        } else {
          const post = await api('POST', `/api/folios/${folio.id}/charges`, {
            chargeCode: ROOM_CHARGE_CODE,
            description: `Room charge for ${day}`,
            amountCents: nightlyCents,
            postedBy: 'system.backfill',
            sourceSystem: 'backfill',
            reference,
          });
          if (post.status === 201) {
            console.log(`  ✓ posted    ${label}: ${day} — ${peso(nightlyCents)}`);
            postedForStay += 1;
          } else {
            console.log(`  ✗ failed    ${label}: ${day} (${post.status}) ${post.body?.error || ''}`);
            errors += 1;
          }
        }
      }
      day = nextDayKey(day);
    }
    if (postedForStay > 0) touchedStays += 1;
    postedNights += postedForStay;
  }

  console.log(
    `\n${DRY ? 'would post' : 'posted'}: ${postedNights} night(s) across ${touchedStays} stay(s)   ` +
      `skipped (walk-in): ${skippedWalkIn}   skipped (no rate): ${skippedNoRate}   ` +
      `skipped (no folio): ${skippedNoFolio}   errors: ${errors}\n`
  );
  if (errors > 0) process.exit(1);
}

main().catch((e) => {
  console.error(`\nUnexpected error: ${e.stack || e.message}\n`);
  process.exit(2);
});
