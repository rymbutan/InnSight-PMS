// Shared by Dashboard.jsx (manager/admin/front-desk) and AuditorDashboard.jsx —
// both put a "bookings by channel" donut on their landing screen, and they
// need to agree on what counts (active reservations only) and on the colour
// a given source is drawn in.

import { SOURCE_LABELS } from './reservationOptions';

// DIRECT uses the app's own accent rather than a generic green, since it's
// the brand's default channel; the rest match Revenue.jsx's source-mix donut
// so a channel is never one colour on that page and another here.
export const SOURCE_COLORS = {
  DIRECT: 'var(--accent)',
  WALK_IN: '#06b6d4',
  BOOKING_COM: '#3b82f6',
  AIRBNB: '#ef4444',
  EXPEDIA: '#f59e0b',
  AGODA: '#8b5cf6',
  OTA: '#94a3b8',
};

export function computeBookingSourceMix(reservations) {
  const counts = {};
  for (const r of reservations || []) {
    if (['CANCELLED', 'NO_SHOW'].includes(r.status)) continue;
    const s = r.source || 'DIRECT';
    counts[s] = (counts[s] || 0) + 1;
  }
  return Object.entries(counts).map(([k, v]) => ({
    label: SOURCE_LABELS[k] || k.replace('_', ' '),
    value: v,
    color: SOURCE_COLORS[k] || '#94a3b8',
  }));
}
