// ─────────────────────────────────────────────────────────────────────────────
// DEMO TRADING HISTORY — July and August, generated not recorded.
//
// WHAT THIS IS
// ------------
// The Reports and Revenue screens read real operating history: BusinessDay rows
// closed by the night audit, and amenity sales posted through the POS. A stack
// that has only been running for a few days has neither, so both screens are
// empty and the forecast has nothing to regress on. This produces two months of
// plausible history so those screens can be seen working.
//
// IT IS NOT SEED DATA. Nothing here runs from scripts/db-seed.sh — it is behind
// scripts/seed-demo-history.sh, which has to be asked for, and which can take it
// all back out again with --purge. Reference data (charge codes, room types)
// belongs in a seed; invented revenue does not go anywhere near the path that
// runs against a real property's database.
//
// WHY ONE GENERATOR SHARED BY TWO SERVICES
// ----------------------------------------
// The audit service writes the daily totals and the folio service writes the
// individual amenity sales. Those are two records of the SAME trading, and the
// two screens are read side by side — a Revenue page claiming ₱48,000 of
// facility income on a day whose Amenities report lists ₱11,000 of sales does
// not read as demo data, it reads as a broken system. Both services derive
// their numbers from the functions below, so the totals reconcile by
// construction. scripts/check-shared.sh keeps the two vendored copies identical.
//
// DETERMINISTIC ON PURPOSE
// ------------------------
// Every figure is a pure function of its date. Re-running the script produces
// exactly the same history, so a number quoted off the screen on Monday is still
// that number on Friday, and a partial run can simply be repeated.
// ─────────────────────────────────────────────────────────────────────────────

// The property as services/inventory/src/seed.js builds it: 4 floors x 15 rooms.
// If that plan changes this constant has to follow, or occupancy percentages
// here stop matching the rooms the rest of the system can actually sell.
const ROOMS_AVAILABLE = 60;

// Weighted mean of the seeded rack rates (8 STD + 4 DLX + 2 STE + 1 PRS per
// floor), in centavos. The anchor the generated ADR moves around.
const BASE_ADR_CENTS = 430000;

// A tiny deterministic hash → [0,1). Not random: the same date always yields the
// same value, in both services, on every machine.
function unitNoise(key, salt = 0) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // >>> 0 first: Math.imul returns a signed 32-bit value.
  return ((h >>> 0) % 100000) / 100000;
}

// LOCAL calendar days throughout — Convention 1 in date.js, not Convention 2.
//
// This is the distinction that file warns about, and getting it wrong here is
// not cosmetic. BusinessDay.businessDate is stored at LOCAL midnight and
// GET /api/audit/days builds its bounds with parseLocalDay(); a row written at
// UTC midnight lands at 08:00 local in Asia/Manila and falls outside the range
// that asked for its own day. The same applies to a POS sale: the amenity
// report filters postedAt by local days, so a sale stamped 20:00 UTC on 31
// August belongs to 1 September locally and drops out of an August report.
//
// So: every date below is built WITHOUT a trailing Z, which parses in the
// container's own timezone, and read back with local getters rather than
// toISOString().

// 'YYYY-MM-DD' from a date's LOCAL calendar fields. toISOString() would convert
// to UTC first and return the previous day for any local-midnight value east of
// Greenwich.
function dayKey(d) {
  const x = new Date(d);
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${x.getFullYear()}-${m}-${day}`;
}

// Every LOCAL day from `from` to `to` inclusive, each at local midnight.
// setDate() steps the local calendar, so this stays correct across a DST
// boundary in a timezone that has one (the Philippines does not, but the
// property this ships to is not the only place it could run).
function eachDay(from, to) {
  const out = [];
  const cur = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  while (cur.getTime() <= end.getTime()) {
    out.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

// Occupancy, as a percentage. Three effects, because a flat line with noise on
// it does not look like a hotel:
//   - the WEEK: Friday and Saturday fill, Tuesday and Wednesday do not;
//   - the SEASON: a slow arc peaking in the first half of August;
//   - day-to-day noise, bounded so it never swamps the other two.
function occupancyPctFor(date) {
  const key = dayKey(date);
  const dow = new Date(key).getUTCDay(); // 0 Sun … 6 Sat
  const weekday = [4, -6, -8, -5, 2, 13, 15][dow];

  // Day 0 is 1 July; the arc peaks around day 40 (10 August).
  const dayIndex = Math.round((new Date(key).getTime() - Date.UTC(2026, 6, 1)) / 86400000);
  const season = 9 * Math.sin((Math.PI * Math.min(Math.max(dayIndex, 0), 61)) / 61);

  const noise = (unitNoise(key, 1) - 0.5) * 9;
  const pct = 63 + weekday + season + noise;
  // A real property is never at 0 and rarely at 100.
  return Math.round(Math.min(97, Math.max(28, pct)) * 10) / 10;
}

// Rate follows demand — the whole premise the Revenue page demonstrates. A full
// house earns roughly a fifth more per room than a quiet Tuesday.
function adrCentsFor(date, occupancyPct) {
  const key = dayKey(date);
  const demand = (occupancyPct - 63) / 63; // −0.55 … +0.54
  const noise = (unitNoise(key, 2) - 0.5) * 0.05;
  return Math.round(BASE_ADR_CENTS * (1 + demand * 0.34 + noise));
}

// The facility sales for one day, as individual walk-in transactions. This is
// the LEDGER the folio service writes and the audit service totals — both sides
// come from here, which is what keeps the Amenities report and the Revenue
// page's facility line agreeing.
//
// Prices match services/inventory/src/seed.js. A facility whose price an admin
// later edits will not retro-change this history, which is correct: a past sale
// was made at the price of the day.
const FACILITIES = [
  { code: 'POOL', name: 'Swimming Pool', unit: 'day pass', priceCents: 25000, perUnit: true, weight: 34 },
  { code: 'GYM', name: 'Fitness Center', unit: 'day pass', priceCents: 20000, perUnit: true, weight: 22 },
  { code: 'SPA', name: 'Spa & Massage', unit: 'per session', priceCents: 120000, perUnit: true, weight: 16 },
  {
    code: 'RESTO',
    name: 'Restaurant / Café',
    unit: 'per person',
    priceCents: 60000,
    perUnit: true,
    weight: 14,
  },
  { code: 'MTG', name: 'Meeting Room', unit: 'per hour', priceCents: 50000, perUnit: true, weight: 9 },
  {
    code: 'HALL',
    name: 'Grand Function Hall',
    unit: 'per hour',
    priceCents: 150000,
    perUnit: true,
    weight: 5,
  },
];

const WEIGHT_TOTAL = FACILITIES.reduce((s, f) => s + f.weight, 0);

function pickFacility(r) {
  let x = r * WEIGHT_TOTAL;
  for (const f of FACILITIES) {
    x -= f.weight;
    if (x <= 0) return f;
  }
  return FACILITIES[0];
}

// → [{ code, name, unit, units, amountCents, postedAt }]
function facilitySalesFor(date) {
  const key = dayKey(date);
  const dow = new Date(key).getUTCDay();
  const occ = occupancyPctFor(date);

  // Busier house and weekends mean more walk-in amenity trade. The function
  // hall in particular is a weekend business.
  const weekendLift = dow === 5 || dow === 6 || dow === 0 ? 3 : 0;
  const count = Math.max(2, Math.round(2 + (occ / 100) * 6 + weekendLift * unitNoise(key, 3)));

  const sales = [];
  for (let i = 0; i < count; i += 1) {
    const f = pickFacility(unitNoise(`${key}:${i}`, 4));
    // Hours for the hourly rooms, heads for the restaurant, one pass otherwise.
    const spread = unitNoise(`${key}:${i}`, 5);
    let units = 1;
    if (f.code === 'HALL') units = 3 + Math.floor(spread * 5);
    else if (f.code === 'MTG') units = 2 + Math.floor(spread * 4);
    else if (f.code === 'RESTO') units = 1 + Math.floor(spread * 4);
    else units = 1 + Math.floor(spread * 2);

    // Spread across LOCAL trading hours, 08:00–20:59. Local, because the
    // amenity report buckets postedAt by local day — a sale stamped in UTC
    // would fall out of its own day's figures near either end of the range.
    const hour = 8 + Math.floor(unitNoise(`${key}:${i}`, 6) * 13);
    const minute = Math.floor(unitNoise(`${key}:${i}`, 7) * 60);
    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    const postedAt = new Date(`${key}T${hh}:${mm}:00`);

    sales.push({
      code: f.code,
      name: f.name,
      unit: f.unit,
      units,
      amountCents: f.priceCents * units,
      postedAt,
    });
  }
  return sales;
}

// Everything the audit service needs to write one closed BusinessDay. Facility
// revenue is the SUM OF THE SALES ABOVE rather than an independent estimate —
// that identity is the whole reason this file is shared.
function businessDayFor(date) {
  const key = dayKey(date);
  const occupancyPct = occupancyPctFor(date);
  const roomsOccupied = Math.round((occupancyPct / 100) * ROOMS_AVAILABLE);
  const adr = adrCentsFor(date, occupancyPct);
  const roomRevenueCents = roomsOccupied * adr;

  const facilityRevenueCents = facilitySalesFor(date).reduce((s, x) => s + x.amountCents, 0);

  // In-house extras: minibar, laundry, room service. A fifth of room revenue,
  // give or take.
  const otherRevenueCents = Math.round(roomRevenueCents * (0.18 + unitNoise(key, 8) * 0.08));

  // VAT 12% + service charge 10%, matching the shipped tax defaults.
  const taxable = roomRevenueCents + otherRevenueCents + facilityRevenueCents;
  const taxCents = Math.round(taxable * 0.22);

  // Not everything banked the same day — a few percent sits in receivables.
  const paymentsCents = Math.round((taxable + taxCents) * (0.93 + unitNoise(key, 9) * 0.06));

  const arrivals = Math.max(1, Math.round(roomsOccupied * (0.26 + unitNoise(key, 10) * 0.12)));
  const departures = Math.max(1, Math.round(roomsOccupied * (0.24 + unitNoise(key, 11) * 0.12)));
  const noShows = unitNoise(key, 12) > 0.82 ? 1 + Math.floor(unitNoise(key, 13) * 2) : 0;

  return {
    // Local midnight — the convention GET /api/audit/days queries against.
    businessDate: new Date(`${key}T00:00:00`),
    status: 'CLOSED',
    roomsOccupied,
    roomsAvailable: ROOMS_AVAILABLE,
    occupancyPct,
    arrivals,
    departures,
    noShows,
    roomRevenueCents,
    facilityRevenueCents,
    otherRevenueCents,
    taxCents,
    paymentsCents,
    adr: Math.round(adr) / 100,
    revPar: Math.round(roomRevenueCents / ROOMS_AVAILABLE) / 100,
  };
}

// The window both services fill. July and August of the current trading year.
const DEMO_FROM = '2026-07-01';
const DEMO_TO = '2026-08-31';

module.exports = {
  ROOMS_AVAILABLE,
  DEMO_FROM,
  DEMO_TO,
  eachDay,
  dayKey,
  occupancyPctFor,
  adrCentsFor,
  facilitySalesFor,
  businessDayFor,
  FACILITIES,
};
