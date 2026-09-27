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
 *   geometry the SVG needs. `mapW` is sized to the content, not a fixed
 *   canvas — it exceeds MAP_W for a busy floor (which is what makes the panel
 *   scroll rather than crush the rooms) and shrinks below it for a sparse one
 *   (so the drawing doesn't sit inside acres of dead space).
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
  // mapW hugs the actual content — it used to be clamped to at least MAP_W,
  // which was fine for a busy floor (content already reaches MAP_W on its
  // own) but left a sparsely-occupied property (few rooms per floor, spread
  // across many floors) drawing a corridor far wider than its own rooms:
  // two 150px-wide rooms centred in a 980-wide bar, with dead space flanking
  // them on both sides. The SVG is rendered at this exact native size (see
  // Housekeeping.jsx), not stretched to fill its panel, so shrinking mapW
  // here only tightens the drawing around its rooms — it can no longer
  // inflate mapH through aspect-ratio scaling the way it would if the SVG
  // were still stretched via CSS width:100%/height:auto.
  const mapW = MARGIN_X * 2 + cols * w + GAP * (cols - 1);

  const slots = [];
  const floors = [];
  let y = MAP_PAD_TOP;

  for (const f of floorNums) {
    const sorted = [...byFloor.get(f)].sort(byNumber);
    const topCount = Math.ceil(sorted.length / 2);
    const rows = [sorted.slice(0, topCount), sorted.slice(topCount)];

    // This floor's own span, top to bottom — for a "jump to this floor"
    // control (see PanZoom's focusRect) to pan to, not just for drawing.
    const floorTopY = y;
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
    const floorBottomY = rowBotY + bottomH;
    floors.push({ floor: f, labelY, corridorY, topY: floorTopY, bottomY: floorBottomY, count: sorted.length });
    y = floorBottomY + FLOOR_GAP;
  }

  return { slots, floors, mapW, mapH: y - FLOOR_GAP + MAP_PAD_TOP };
}
