import api from '../api';

// ─────────────────────────────────────────────────────────────────────────────
// The sim's only link to the backend.
//
// WHY THIS EXISTS
// ---------------
// There were ZERO API calls anywhere in web/src/sim/. Only one of the three
// top-level games persisted anything — the cleaning turnover — and it did so via
// an inline `api.post` in Housekeeping.jsx. Guest Services and Lost & Found just
// raised a toast and threw the student's results away, so the Training page's
// competency table could never reflect either of them.
//
// Worse, an in-progress shift lived in `useState` inside RoomFreeRoam. A student
// part-way through a 13-station Presidential suite who reloaded, lost the tab or
// clicked "Leave shift" lost the entire shift with no warning.
//
// This module owns both halves: submitting a finished run, and check-pointing an
// unfinished one.
// ─────────────────────────────────────────────────────────────────────────────

export const ACTIVITY = {
  TURNOVER: 'TURNOVER',
  GUEST_SERVICE: 'GUEST_SERVICE',
  LOST_FOUND: 'LOST_FOUND',
  // The room inspection case study that replaced the turnover mini-games.
  // Must also be in the allow-list in services/auth/src/routes/training.routes.js
  // or the API silently records it as TURNOVER.
  INSPECTION: 'INSPECTION',
};

// Submit a completed run. Never throws: a training record is valuable but it must
// not be able to block the PMS action the student was actually performing (turning
// a room over, logging a guest request).
export async function submitRun({ activity, label, items }) {
  if (!Array.isArray(items) || !items.length) return { ok: false, reason: 'no items' };
  try {
    const { data } = await api.post('/api/training/results', {
      activity,
      roomTier: label,
      items,
    });
    return { ok: true, record: data };
  } catch (e) {
    // Surfaced by the caller as a non-blocking notice rather than swallowed
    // silently — a student should know their score did not save.
    return { ok: false, reason: e?.response?.data?.error || e?.message || 'request failed' };
  }
}

// ── In-progress shift autosave ───────────────────────────────────────────────
// Deliberately localStorage, not the server: a half-finished shift is not a
// training record, it is UI state, and check-pointing it on every station would
// write a row per click. It is scoped per user + room so two students sharing a
// browser profile, or one student working two rooms, don't collide.
const KEY_PREFIX = 'innsight_shift_v1';
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // a stale shift from yesterday is noise

function keyFor(userId, roomId) {
  return `${KEY_PREFIX}:${userId || 'anon'}:${roomId}`;
}

export function saveShift(userId, roomId, state) {
  try {
    localStorage.setItem(keyFor(userId, roomId), JSON.stringify({ at: Date.now(), state }));
  } catch {
    /* quota or private mode — autosave is best-effort */
  }
}

export function loadShift(userId, roomId) {
  try {
    const raw = localStorage.getItem(keyFor(userId, roomId));
    if (!raw) return null;
    const { at, state } = JSON.parse(raw);
    if (!at || Date.now() - at > MAX_AGE_MS) {
      clearShift(userId, roomId);
      return null;
    }
    if (!state || typeof state !== 'object') return null;
    return { at, state };
  } catch {
    return null;
  }
}

export function clearShift(userId, roomId) {
  try {
    localStorage.removeItem(keyFor(userId, roomId));
  } catch {
    /* ignore */
  }
}
