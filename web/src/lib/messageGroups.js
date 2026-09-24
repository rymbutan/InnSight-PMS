// ─────────────────────────────────────────────────────────────────────────────
// Turning a flat transcript into something a person can read at a glance.
//
// The thread used to render one bubble per message, each with its own
// timestamp, each separated by the same 8px. Three consecutive replies sent
// inside ten seconds therefore arrived as three identical islands carrying
// three identical clock times — the layout said "three separate events" about
// what was one person talking. And a conversation spanning a fortnight ran
// together with nothing marking where one day ended and the next began; the
// per-message stamp switched silently from "14:05" to "Sep 14, 14:05" and that
// was the only clue.
//
// So the transcript is grouped before it is drawn. Both the Messages page and
// the docked chat windows render from these groups, which is the other reason
// this is a module and not a loop inside a component: two surfaces showing the
// same conversation must not disagree about where a day starts or what counts
// as one person's turn.
//
// PURE. No React, no API, no Date.now() except where a caller passes a
// reference date in — so all of it is testable, and messageGroups.test.js does.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Consecutive messages from one sender collapse into a turn while they keep
 * arriving this close together. Five minutes is the usual chat convention and
 * it holds up here: staff send a burst of short lines about one room, then
 * nothing for an hour. Past the window the next line is a new turn, because the
 * gap itself is information — it says the conversation paused.
 */
export const GROUP_WITHIN_MS = 5 * 60 * 1000;

/** Local midnight for a date, which is where a calendar day starts for a reader. */
function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * "Today" / "Yesterday" / a written date, for the separator between days.
 *
 * `now` is a parameter rather than being read off the clock so this is
 * deterministic under test — and so a thread left open across midnight can be
 * re-labelled by passing the new date, instead of insisting yesterday is still
 * today because that is what it was when the page loaded.
 */
export function dayLabel(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  // Inside the last week the weekday is the most useful handle a reader has.
  if (days > 1 && days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(
    [],
    sameYear ? { month: 'long', day: 'numeric' } : { year: 'numeric', month: 'long', day: 'numeric' }
  );
}

/** Clock time alone. The day is carried by the separator above the group now,
 *  so repeating the date on every bubble is redundant. */
export function clockTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Group a transcript for rendering.
 *
 * @param {Array<{id: string, senderId: string, body: string, createdAt: string}>} messages
 *        oldest first, which is the order GET /api/messages/with/:id returns.
 * @param {string} meId  the signed-in user, so each group knows which side it is on.
 * @returns {Array<{type: 'day', key: string, iso: string}
 *                 |{type: 'group', key: string, senderId: string, mine: boolean,
 *                   items: Array<{...message, last: boolean}>, iso: string}>}
 *          A flat list in render order: a day separator, then that day's groups,
 *          then the next separator. Flat rather than nested because the renderer
 *          maps over it once, and a nested shape would need two loops to say the
 *          same thing.
 */
export function groupMessages(messages, meId) {
  const out = [];
  if (!Array.isArray(messages) || messages.length === 0) return out;

  let dayKey = null;
  let current = null;

  for (const m of messages) {
    if (!m || !m.id) continue;
    const t = new Date(m.createdAt).getTime();
    const k = Number.isNaN(t) ? 'unknown' : startOfDay(m.createdAt).getTime();

    // A new calendar day always breaks the group, even for the same sender a
    // minute either side of midnight: the separator has to go between them, and
    // a group cannot straddle it.
    if (k !== dayKey) {
      dayKey = k;
      out.push({ type: 'day', key: `day-${k}-${m.id}`, iso: m.createdAt });
      current = null;
    }

    const sameSender = current && current.senderId === m.senderId;
    const closeEnough = current && Math.abs(t - current.lastAt) <= GROUP_WITHIN_MS;

    if (sameSender && closeEnough) {
      current.items.push({ ...m, last: true });
      // Only the final bubble of a turn carries the timestamp and the tail, so
      // the one before it stops being the last.
      current.items[current.items.length - 2].last = false;
      current.lastAt = t;
    } else {
      current = {
        type: 'group',
        key: `grp-${m.id}`,
        senderId: m.senderId,
        mine: m.senderId === meId,
        items: [{ ...m, last: true }],
        iso: m.createdAt,
        lastAt: Number.isNaN(t) ? 0 : t,
      };
      out.push(current);
    }
  }

  // `lastAt` is bookkeeping for the loop above, not something a renderer should
  // be able to read and start depending on.
  for (const row of out) if (row.type === 'group') delete row.lastAt;
  return out;
}

/**
 * The preview line for a contact row: one line, no newlines, not endless.
 *
 * A pasted task note arrives with line breaks in it, and dropping it into a
 * single-line row renders the breaks as nothing — two words jammed together
 * with no space. Collapsing whitespace first is what keeps "Room 204\ndone"
 * from reading as "Room 204done".
 */
export function previewOf(text, max = 64) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= max) return flat;
  // Cut on a word boundary where there is one near the end, so the ellipsis
  // does not land mid-word.
  const cut = flat.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max - 12 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

/** First + last initial, the avatar fallback. Shared so the page, the dock and
 *  the contact rows cannot render the same person differently. */
export function initialsOf(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// A fixed fill per person instead of one flat grey for every avatar — purely
// decorative, so the palette is deliberately clear of the app's semantic
// colours (the brand green, --danger, --info, --warn fills all mean
// something elsewhere in the product; an avatar in one of those would read as
// a status by accident). Hashed off the id rather than the name, so it can't
// change with a display-name edit, and stable across the page and the dock
// because both call this same function.
const AVATAR_FILLS = ['#475569', '#6d28d9', '#0e7490', '#be185d', '#b45309', '#334155'];
export function avatarColorOf(id = '') {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_FILLS[Math.abs(hash) % AVATAR_FILLS.length];
}
