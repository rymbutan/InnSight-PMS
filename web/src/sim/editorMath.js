// Small pure helpers for the room layout editor's inspector — kept out of the
// component for the same reason editorSelection.js is: the editor is a 3D canvas
// that cannot be driven headlessly, so anything left inside it is untestable.

/** Smallest value a size / scale / room dimension may take. */
export const MIN_SIZE = 0.1;
export const MIN_SCALE = 0.01;

/**
 * A key for a new station that no existing station already uses. Starts from the
 * array length (so a first station is still `custom0`) and walks forward past
 * any collision — after a delete, `length` alone can land on a key that exists.
 */
export function uniqueStationKey(stations, base = 'custom') {
  const used = new Set((stations || []).map((s) => s?.key));
  let n = (stations || []).length;
  while (used.has(`${base}${n}`)) n += 1;
  return `${base}${n}`;
}

/**
 * Parse what is in a number box. Returns a finite number, or null while the
 * text is not (yet) one — '', '-', '.', '1e' — so a half-typed value is never
 * turned into 0 and written to the layout.
 */
export function parseDraft(text) {
  const s = String(text ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** A scale may be negative (a mirrored fixture) but never ~0, which collapses it. */
export function nonZeroScale(n) {
  return Math.abs(n) < MIN_SCALE ? (n < 0 ? -MIN_SCALE : MIN_SCALE) : n;
}

/** Raise a value to `min` (a null min means no floor). */
export function atLeast(n, min) {
  return min == null ? n : Math.max(min, n);
}

/**
 * Keep the spawn point inside the room. Rooms are centred on the origin, so the
 * floor runs from -w/2..w/2 and -l/2..l/2. Room shrinking itself is never
 * rejected — only the spawn is pulled in so a player cannot start in the void.
 */
export function clampSpawn(room) {
  const spawn = Array.isArray(room?.spawn) ? room.spawn : [0, 0];
  const hx = Math.max(0, (room.w || 0) / 2);
  const hz = Math.max(0, (room.l || 0) / 2);
  const clamp = (v, h) => Math.min(h, Math.max(-h, Number.isFinite(v) ? v : 0));
  const next = [clamp(spawn[0], hx), clamp(spawn[1], hz)];
  if (next[0] === spawn[0] && next[1] === spawn[1] && Array.isArray(room.spawn)) return room;
  return { ...room, spawn: next };
}
