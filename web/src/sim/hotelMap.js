// ── Hotel map geometry ────────────────────────────────────────────────────────────
// The hotel is drawn as ONE WING PER FLOOR: two rows of rooms either side of a
// corridor, stacked, with the floor named down the side.
//
// It used to be a single wing for the whole property — every room in the hotel
// divided into two long rows. That reads fine for fifteen rooms and falls apart
// past that: at forty-five, each room was 55px wide, "Standard" clipped to
// "Standar", the numbers ran into each other, and rooms 115 and 201 sat side by
// side on the same corridor as though they were neighbours. A hotel map that
// does not show floors is not really a map.
//
// Rooms never shrink below MIN_ROOM_W now. If a floor has more rooms than fit at
// that width the drawing grows wider than its container and scrolls sideways —
// a legible map you scroll beats an illegible one that fits.
export const MAP_W = 980;
const MIN_ROOM_W = 96; // below this the type name starts clipping
const MAX_ROOM_W = 150; // above this a small floor reads as a row of billboards
const ROW_H = 118;
export const CORRIDOR_H = 44;
const FLOOR_LABEL_H = 26;
const FLOOR_GAP = 26;
export const MARGIN_X = 26;
const MAP_PAD_TOP = 14;
const GAP = 8;

const byNumber = (a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true });

/**
 * Lay the property out as a stack of floors.
 *
 * Every floor uses the SAME room width — taken from the busiest floor — so the
 * columns line up down the map instead of each floor drawing its own grid.
 *
 * @returns {{slots, floors, mapW, mapH}} `floors` carries the corridor and label
 *   geometry the SVG needs; `mapW` may exceed MAP_W, which is what makes the
 *   panel scroll rather than crush the rooms.
 */
export function computeLayout(rooms) {
  const byFloor = new Map();
  for (const room of rooms || []) {
    const f = Number.isFinite(room.floor) ? room.floor : 1;
    if (!byFloor.has(f)) byFloor.set(f, []);
    byFloor.get(f).push(room);
  }
  const floorNums = [...byFloor.keys()].sort((a, b) => a - b);
  if (!floorNums.length) return { slots: [], floors: [], mapW: MAP_W, mapH: 240 };

  // The widest row anywhere decides the column width for the whole map.
  let cols = 1;
  for (const f of floorNums) cols = Math.max(cols, Math.ceil(byFloor.get(f).length / 2));

  const fit = (MAP_W - MARGIN_X * 2 - GAP * (cols - 1)) / cols;
  const w = Math.max(MIN_ROOM_W, Math.min(MAX_ROOM_W, fit));
  const mapW = Math.max(MAP_W, MARGIN_X * 2 + cols * w + GAP * (cols - 1));

  const slots = [];
  const floors = [];
  let y = MAP_PAD_TOP;

  for (const f of floorNums) {
    const sorted = [...byFloor.get(f)].sort(byNumber);
    const topCount = Math.ceil(sorted.length / 2);
    const rows = [sorted.slice(0, topCount), sorted.slice(topCount)];

    const labelY = y + FLOOR_LABEL_H - 8;
    const rowTopY = y + FLOOR_LABEL_H;
    const corridorY = rowTopY + ROW_H;
    const rowBotY = corridorY + CORRIDOR_H;

    rows.forEach((row, r) => {
      if (!row.length) return;
      // Short rows are centred, so a floor with an odd room count does not leave
      // a ragged gap on one side.
      const rowW = row.length * w + GAP * (row.length - 1);
      const x0 = (mapW - rowW) / 2;
      row.forEach((room, i) => {
        slots.push({ room, x: x0 + i * (w + GAP), y: r === 0 ? rowTopY : rowBotY, w, h: ROW_H, row: r });
      });
    });

    const bottomH = rows[1].length ? ROW_H : 0;
    floors.push({ floor: f, labelY, corridorY, count: sorted.length });
    y = rowBotY + bottomH + FLOOR_GAP;
  }

  return { slots, floors, mapW, mapH: y - FLOOR_GAP + MAP_PAD_TOP };
}
