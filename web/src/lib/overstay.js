// A guest who is still IN_HOUSE after their expected check-out time.
//
// Nothing else on the desk says so: the stay simply stays in the In-House list,
// its room stays OCCUPIED, and the next arrival for that room finds out at the
// counter. The Arrivals page uses this to raise the alert before that happens.

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// How long a stay has been past its expected check-out, or null if it is not
// overdue (not in-house, no expected check-out, or still within its time).
export function overdueMs(stay, now = Date.now()) {
  if (!stay || stay.status !== 'IN_HOUSE' || !stay.expectedCheckOut) return null;
  const due = new Date(stay.expectedCheckOut).getTime();
  if (Number.isNaN(due) || due >= now) return null;
  return now - due;
}

export function overdueLabel(ms) {
  if (ms >= DAY) {
    const days = Math.floor(ms / DAY);
    return `${days} day${days === 1 ? '' : 's'} overdue`;
  }
  if (ms >= HOUR) return `${Math.floor(ms / HOUR)}h overdue`;
  return `${Math.max(1, Math.floor(ms / MIN))} min overdue`;
}

// Overdue in-house stays, longest overdue first, each with its label. `overstay`
// is true from a full day past the expected check-out: the room is certainly not
// turning over today, as opposed to a guest who is simply a little late at the
// desk.
export function overdueStays(stays, now = Date.now()) {
  return (stays || [])
    .map((stay) => ({ stay, ms: overdueMs(stay, now) }))
    .filter((x) => x.ms !== null)
    .sort((a, b) => b.ms - a.ms)
    .map(({ stay, ms }) => ({ stay, ms, label: overdueLabel(ms), overstay: ms >= DAY }));
}
