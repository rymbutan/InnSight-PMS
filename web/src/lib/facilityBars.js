// Turning facility bookings into calendar bars.
//
// The sibling of lib/calendarBars.js, and deliberately a separate module rather
// than a flag on that one: the two grids share their SHAPE (rows x the same 14
// days) but not their arithmetic, and merging them would mean one function
// where half the branches are dead on every call.
//
// WHAT IS DIFFERENT FROM A ROOM BAR
// ---------------------------------
// A room booking is measured in NIGHTS and always fills whole columns. A
// facility booking is a TIME SLOT: the function hall from 09:00 to 12:00 is
// three hours inside one column, and two of those can sit on the same facility
// on the same day without clashing. So a facility bar carries
//
//   offset  how far into its starting column it begins, 0..1 of that column
//   width   how many columns it covers, fractional (0.125 = three hours)
//   lane    which stacked row inside the cell it draws on
//
// and the grid gives it a column and a row. Whole-column arithmetic would draw
// a morning yoga class and an evening function as the same block, which is the
// one thing this board exists to tell apart.
//
// WHY LANES EXIST
// ---------------
// Sibling sections of a hall are separate rows, but the SAME space can hold two
// bookings in one day, and the server only rejects them when they overlap in
// time. Drawn naively both land at the same top offset and the later one hides
// the earlier. Lanes are the stacking: overlapping bookings get their own line
// inside the cell, and the row grows to fit.
//
// NOTHING IS EVER DROPPED SILENTLY
// --------------------------------
// A booking whose facility is not among the rows — deactivated since it was
// taken, or a child space the row list folded away — has nowhere to draw. It
// comes back in `unplaced` so the page can say so, the same guarantee
// calendarBars.js makes with `unassigned`.

import { startOfDay, addDays } from './date.js';

// A cancelled booking has had its slot locks deleted by the server, so the
// space is genuinely free again and the board must not show it as taken.
const RELEASED_STATUSES = ['CANCELLED'];

// The narrowest a bar is ever DRAWN, as a fraction of one day column. A 30
// minute slot is 2% of a day: at any realistic column width that is a sliver
// with no room for a label, so the stylesheet floors it. Lane assignment has to
// use the same floor or two short bookings an hour apart would be given the
// same lane and then drawn on top of each other.
//
// Keep in step with `min-width` on .cal2-bar--slot in styles.css.
export const MIN_SLOT_FRAC = 1 / 3;

/**
 * @param {object} args
 * @param {object[]} [args.bookings]    FacilityBooking rows, each with `facility`
 * @param {object[]} [args.facilities]  the rows of the grid, in display order
 * @param {Date[]} args.days            one local-midnight Date per column
 * @returns {{ byFacility: Record<string, object[]>, lanesByFacility: Record<string, number>, unplaced: object[] }}
 */
export function buildFacilityBars({ bookings = [], facilities = [], days }) {
  const byFacility = {};
  const lanesByFacility = {};
  const unplaced = [];
  if (!days?.length) return { byFacility, lanesByFacility, unplaced };

  // Column boundaries taken from the `days` array itself rather than computed
  // as multiples of 86400000. Under a DST change a local day is 23 or 25 hours
  // long, and a bar positioned as a fraction of a nominal 24 would sit off its
  // real time for the rest of that column.
  const colStart = days.map((d) => startOfDay(d).getTime());
  const colEnd = days.map((d) => startOfDay(addDays(d, 1)).getTime());
  const winStart = colStart[0];
  const winEnd = colEnd[colEnd.length - 1];

  // A facility may be listed by id or by code depending on the caller; index
  // both so a booking finds its row either way.
  const rowIds = new Set();
  const byCode = new Map();
  for (const f of facilities) {
    if (f?.id) rowIds.add(f.id);
    if (f?.code) byCode.set(f.code, f.id || f.code);
  }

  function makeBar(b) {
    const start = new Date(b.startAt).getTime();
    const end = new Date(b.endAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    // Half-open against the window: a booking that ends exactly at midnight on
    // the first column occupies none of it.
    if (end <= winStart || start >= winEnd) return null;

    const clipStart = Math.max(start, winStart);
    const clipEnd = Math.min(end, winEnd);

    let startCol = days.length - 1;
    for (let i = 0; i < days.length; i++) {
      if (clipStart < colEnd[i]) {
        startCol = i;
        break;
      }
    }
    const startLen = colEnd[startCol] - colStart[startCol];
    const offset = (clipStart - colStart[startCol]) / startLen;

    // Summed column by column, so a 25-hour DST day contributes exactly 1.0.
    let width = 0;
    for (let i = startCol; i < days.length; i++) {
      const a = Math.max(clipStart, colStart[i]);
      const z = Math.min(clipEnd, colEnd[i]);
      if (z <= a) break;
      width += (z - a) / (colEnd[i] - colStart[i]);
    }

    const minutes = Math.round((end - start) / 60000);
    return {
      key: `fb-${b.id}`,
      id: b.id,
      facilityId: b.facilityId,
      label: b.guestName || 'Booked',
      facilityName: b.facility?.name || '',
      status: String(b.status || 'CONFIRMED').toLowerCase(),
      startAt: b.startAt,
      endAt: b.endAt,
      persons: b.persons || 1,
      priceCents: b.priceCents || 0,
      folioId: b.folioId || null,
      startCol,
      offset,
      // In columns, already clipped to the window by the loop above.
      width,
      minutes,
      continuesBefore: start < winStart,
      continuesAfter: end > winEnd,
      lane: 0,
    };
  }

  for (const b of bookings) {
    if (RELEASED_STATUSES.includes(String(b.status || '').toUpperCase())) continue;
    const bar = makeBar(b);
    if (!bar) continue;
    // Fall back to the code when the row list was built from codes.
    const rowId = rowIds.has(bar.facilityId) ? bar.facilityId : byCode.get(b.facility?.code) || null;
    if (!rowId) {
      unplaced.push(bar);
      continue;
    }
    bar.facilityId = rowId;
    (byFacility[rowId] = byFacility[rowId] || []).push(bar);
  }

  // Lanes, per row. Greedy by start time: a bar takes the first lane whose last
  // bar has finished being DRAWN — `MIN_SLOT_FRAC` included, because that is
  // the width the user will actually see.
  for (const [id, bars] of Object.entries(byFacility)) {
    bars.sort((a, b) => a.startCol - b.startCol || a.offset - b.offset);
    const laneEnds = []; // rightmost drawn edge per lane, in fractional columns
    for (const bar of bars) {
      const from = bar.startCol + bar.offset;
      const to = from + Math.max(bar.width, MIN_SLOT_FRAC);
      let lane = laneEnds.findIndex((e) => e <= from + 1e-9);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = to;
      bar.lane = lane;
    }
    lanesByFacility[id] = Math.max(1, laneEnds.length);
  }

  return { byFacility, lanesByFacility, unplaced };
}
