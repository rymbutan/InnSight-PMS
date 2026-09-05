// Room numbering and inventory totals, as a pure function.
//
// Extracted from seed.js so the numbering rule can be tested without a database.
// The rule matters more than it looks: a room's number is floor × 100 + its index
// on that floor — 101…115, 201…215 — because the housekeeping map derives a room's
// floor with `Math.floor(number / 100)`. A flat 101…160 run would put every room on
// floor 1 and draw the whole property as one row.
//
// `totals` exists because RoomType.totalInventory must equal the number of rooms
// that actually exist: availability is totalInventory minus held nights, so a count
// below the real one refuses bookings for rooms standing empty — which looks like a
// bug in the booking engine rather than a seeding mistake.
function planInventory(floors, roomTypes) {
  const rooms = [];
  const totals = {};

  for (const rt of roomTypes) totals[rt.code] = rt.perFloor * floors;

  for (let floor = 1; floor <= floors; floor += 1) {
    let idx = 0;
    for (const rt of roomTypes) {
      for (let i = 0; i < rt.perFloor; i += 1) {
        idx += 1;
        rooms.push({ number: String(floor * 100 + idx), typeCode: rt.code, floor });
      }
    }
  }

  return { rooms, totals };
}

module.exports = { planInventory };
