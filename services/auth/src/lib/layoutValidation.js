// Shape check for a room-layout save body. Lives apart from layouts.routes.js
// (which pulls in prisma) so it can be unit-tested without a database.

// A layout is ~60 fixtures of short numeric records. Well past anything real,
// but bounded so a malformed client cannot post megabytes into the column.
const MAX_FIXTURES = 400;

const positive = (n) => Number.isFinite(n) && n > 0;
// A scale may be negative (a mirrored fixture) but never zero or non-finite.
const nonZero = (n) => Number.isFinite(n) && n !== 0;

// Reject anything that is not plan-shaped BEFORE it reaches the database — a
// layout that fails to parse client-side would otherwise brick every room.
function validate(body) {
  const { room, furniture, walls, stations } = body || {};
  if (!room || typeof room !== 'object') return 'room is required.';
  if (!positive(room.w) || !positive(room.l)) return 'room.w and room.l must be positive numbers.';
  if (room.h != null && !positive(room.h)) return 'room.h must be a positive number.';
  if (!Array.isArray(room.spawn) || room.spawn.length !== 2 || !room.spawn.every(Number.isFinite)) {
    return 'room.spawn must be [x, z].';
  }
  for (const [name, val] of [
    ['furniture', furniture],
    ['walls', walls],
    ['stations', stations],
  ]) {
    if (!Array.isArray(val)) return `${name} must be an array.`;
    if (val.length > MAX_FIXTURES) return `${name} has more than ${MAX_FIXTURES} entries.`;
  }
  for (const f of furniture) {
    if (!f || typeof f !== 'object') return 'every fixture must be an object.';
    if (!f.model && !f.type) return 'every fixture needs a model or a type.';
    if (!Array.isArray(f.pos) || f.pos.length !== 2 || !f.pos.every(Number.isFinite)) {
      return 'every fixture needs pos: [x, z].';
    }
    if (f.scale != null && (!Array.isArray(f.scale) || f.scale.length !== 3 || !f.scale.every(nonZero))) {
      return 'fixture scale must be three non-zero numbers.';
    }
  }
  for (const w of walls) {
    if (!w || typeof w !== 'object') return 'every wall must be an object.';
    if (!positive(w.w) || !positive(w.d)) return 'every wall needs a positive width and depth.';
  }
  return null;
}

module.exports = { validate, MAX_FIXTURES };
