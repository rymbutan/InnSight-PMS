// Local-timezone date helpers.
//
// Using `new Date(...).toISOString().slice(0, 10)` to build a day key is a
// silent bug: toISOString() converts to UTC first, so in any non-UTC zone
// (e.g. Philippine time, UTC+8) a local calendar day maps to the wrong ISO
// day for part of the day. These helpers derive the key from LOCAL calendar
// fields so "today" is consistent everywhere in the app.

// YYYY-MM-DD for the given date in LOCAL time.
export function localDay(d) {
  const x = d instanceof Date ? d : new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// Nights between two dates; always at least 1 (a same-day stay is one night).
export function nightsBetween(checkIn, checkOut) {
  const ms = new Date(checkOut).getTime() - new Date(checkIn).getTime();
  return Math.max(1, Math.round(ms / 86400000));
}
