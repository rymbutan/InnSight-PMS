import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveEvents, LIVE_CHANNELS } from './useLiveEvents';
import { labelize } from './labels';

// ─────────────────────────────────────────────────────────────────────────────
// In-app notification feed.
//
// The server already fans every committed business event out over the SSE
// stream at /api/events, and since services/inventory/src/index.js gained
// CHANNEL_AUDIENCE it fans them out PER ROLE — a housekeeper's stream no longer
// carries folio, payment, guest or night-audit traffic at all. So this module
// deliberately does no filtering of its own: what arrives here is already
// everything this user is entitled to see, and nothing else. Re-filtering in the
// browser would imply the client is the security boundary, which it is not.
//
// Direct messages ride the same stream, on `messaging:message_sent`. That one is
// DIRECTED rather than broadcast — the fan-out sends it to the recipient's
// stream alone (see directedTargetOf in the inventory service) — which is what
// makes it safe for the payload to carry a sender name and a preview.
// ─────────────────────────────────────────────────────────────────────────────

// How each channel reads to a human, plus the icon its row carries. `text` is
// normally a string; where the most useful headline depends on the payload — a
// message is "Message from Maria Santos", not "New message" — it is a function
// of the event data instead.
const EVENT_MAP = {
  'room:status_changed': { icon: 'bed', text: 'Room status changed' },
  'room:maintenance': { icon: 'settings', text: 'Room flagged for maintenance' },

  'reservation:created': { icon: 'calendar', text: 'New reservation' },
  'reservation:updated': { icon: 'calendar', text: 'Reservation updated' },
  'reservation:confirmed': { icon: 'check', text: 'Reservation confirmed' },
  'reservation:cancelled': { icon: 'ban', text: 'Reservation cancelled' },

  'room:checkin': { icon: 'arrow-left-right', text: 'Guest checked in' },
  'room:checkout': { icon: 'arrow-left-right', text: 'Guest checked out' },
  'stay:no_show': { icon: 'ban', text: 'Marked no-show' },
  'stay:extended': { icon: 'calendar', text: 'Stay extended' },
  'stay:room_changed': { icon: 'bed', text: 'Room moved' },
  'stay:early_departure': { icon: 'arrow-left-right', text: 'Early departure' },

  'folio:opened': { icon: 'file-text', text: 'Folio opened' },
  'folio:charge_posted': { icon: 'file-text', text: 'Charge posted' },
  'folio:payment_received': { icon: 'coins', text: 'Payment received' },
  'folio:settled': { icon: 'coins', text: 'Folio settled' },
  'folio:closed': { icon: 'file-text', text: 'Folio closed' },
  'folio:deposit_received': { icon: 'coins', text: 'Deposit received' },
  'folio:refund_posted': { icon: 'coins', text: 'Refund posted' },
  'folio:early_departure_adjusted': { icon: 'coins', text: 'Early-departure adjustment' },

  'guest:profile_created': { icon: 'users', text: 'Guest profile created' },
  'guest:profile_updated': { icon: 'users', text: 'Guest profile updated' },
  'guest:profile_deleted': { icon: 'trash', text: 'Guest profile deleted' },
  'guest:flagged': { icon: 'info', text: 'Guest flagged' },

  'maintenance:work_order_created': { icon: 'settings', text: 'Work order created' },
  'maintenance:room_out_of_service': { icon: 'ban', text: 'Room out of service' },
  'maintenance:room_restored': { icon: 'check', text: 'Room back in service' },

  'audit:day_opened': { icon: 'moon', text: 'Business day opened' },
  'audit:day_closed': { icon: 'moon', text: 'Business day closed' },

  'facility:changed': { icon: 'sparkles', text: 'Amenity updated' },
  'facility:booked': { icon: 'sparkles', text: 'Facility booked' },

  // The sender's name IS the headline — "New message" tells the reader nothing
  // they did not already learn from the notification appearing at all.
  'messaging:message_sent': {
    icon: 'message-circle',
    text: (d) => (d.senderName ? `Message from ${d.senderName}` : 'New message'),
  },
};

// Where clicking the row should go. Kept separate from EVENT_MAP so a channel
// with no sensible destination simply has none and renders as non-clickable.
const EVENT_LINK = {
  'room:status_changed': () => '/housekeeping',
  'room:maintenance': () => '/rooms',
  'reservation:created': (d) => (d?.reservationId ? `/reservations/${d.reservationId}` : '/reservations'),
  'reservation:updated': (d) => (d?.reservationId ? `/reservations/${d.reservationId}` : '/reservations'),
  'reservation:confirmed': (d) => (d?.reservationId ? `/reservations/${d.reservationId}` : '/reservations'),
  'reservation:cancelled': () => '/reservations',
  'room:checkin': () => '/arrivals',
  'room:checkout': () => '/arrivals',
  'stay:no_show': () => '/arrivals',
  'stay:extended': () => '/arrivals',
  'stay:room_changed': () => '/rooms',
  'stay:early_departure': () => '/arrivals',
  'folio:opened': (d) => (d?.folioId ? `/folios/${d.folioId}` : '/folios'),
  'folio:charge_posted': (d) => (d?.folioId ? `/folios/${d.folioId}` : '/folios'),
  'folio:payment_received': (d) => (d?.folioId ? `/folios/${d.folioId}` : '/folios'),
  'folio:settled': (d) => (d?.folioId ? `/folios/${d.folioId}` : '/folios'),
  'folio:closed': () => '/folios',
  'folio:deposit_received': (d) => (d?.folioId ? `/folios/${d.folioId}` : '/folios'),
  'folio:refund_posted': (d) => (d?.folioId ? `/folios/${d.folioId}` : '/folios'),
  'folio:early_departure_adjusted': () => '/folios',
  'guest:profile_created': (d) => (d?.guestId ? `/guests?id=${d.guestId}` : '/guests'),
  'guest:profile_updated': (d) => (d?.guestId ? `/guests?id=${d.guestId}` : '/guests'),
  // No id — the profile is gone, so linking to it would open an empty page.
  'guest:profile_deleted': () => '/guests',
  'guest:flagged': (d) => (d?.guestId ? `/guests?id=${d.guestId}` : '/guests'),
  // The map, not /rooms. These three are the notifications Housekeeping &
  // Maintenance actually receives, and /rooms is now management-only — a
  // notification whose only action is a link into a page you cannot open is
  // worse than no link. The map carries live room status, which is what these
  // events are about.
  'maintenance:work_order_created': () => '/housekeeping',
  'maintenance:room_out_of_service': () => '/housekeeping',
  'maintenance:room_restored': () => '/housekeeping',
  'audit:day_opened': () => '/audit',
  'audit:day_closed': () => '/audit',
  'facility:changed': () => '/amenities',
  'facility:booked': () => '/amenities',
  // Straight into the conversation it came from.
  'messaging:message_sent': (d) => (d?.senderId ? `/messages?peer=${d.senderId}` : '/messages'),
};

// ── Turning a payload into a sentence ────────────────────────────────────────
//
// Every row used to read "Payment received" and nothing else, which is true of
// every payment and therefore says nothing about this one. These helpers pull
// the identifying facts out of whatever the event actually carries, so a row
// names the room, the guest, the amount.
//
// Payload shapes differ per publisher and several are thin. Each formatter is
// written to degrade: a field that is missing drops out of the sentence instead
// of printing "undefined", and a channel whose payload carries nothing useful
// still renders its headline on its own.

const peso = (cents) => {
  const n = Number(cents);
  if (!Number.isFinite(n)) return null;
  return `₱${(n / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const shortDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

const roomOf = (d) => {
  const n = d.number || d.roomNumber || d.room;
  return n ? `Room ${n}` : null;
};

const whoOf = (d) => d.guestName || d.displayName || d.name || null;

const refOf = (d) => d.confirmationNumber || d.folioNumber || null;

// Joins the parts that survived, so a thin payload produces a short line rather
// than a string of separators.
const parts = (...bits) => bits.filter(Boolean).join(' · ');

// Per-channel detail. A channel not listed here falls back to the generic
// subject line, which is what every channel did before.
const DETAIL = {
  'room:status_changed': (d) => parts(roomOf(d), d.status ? `now ${labelize(d.status)}` : null),
  'room:maintenance': (d) => parts(roomOf(d), d.reason),

  'reservation:created': (d) =>
    parts(
      whoOf(d),
      refOf(d),
      d.nights ? `${d.nights} night${d.nights === 1 ? '' : 's'}` : null,
      shortDate(d.checkIn) ? `from ${shortDate(d.checkIn)}` : null
    ),
  'reservation:updated': (d) => parts(whoOf(d), refOf(d)),
  'reservation:confirmed': (d) => parts(whoOf(d), refOf(d)),
  'reservation:cancelled': (d) => parts(whoOf(d), refOf(d), d.reason),

  'room:checkin': (d) => parts(whoOf(d), roomOf(d), d.walkIn ? 'walk-in' : null),
  'room:checkout': (d) => parts(whoOf(d), roomOf(d)),
  'stay:no_show': (d) => parts(whoOf(d), refOf(d)),
  'stay:extended': (d) =>
    parts(whoOf(d), roomOf(d), shortDate(d.newCheckOut) ? `until ${shortDate(d.newCheckOut)}` : null),
  'stay:room_changed': (d) =>
    parts(whoOf(d), d.fromRoom && d.toRoom ? `${d.fromRoom} to ${d.toRoom}` : roomOf(d)),
  'stay:early_departure': (d) => parts(whoOf(d), roomOf(d)),

  'folio:opened': (d) => parts(whoOf(d), refOf(d)),
  'folio:charge_posted': (d) =>
    parts(peso(d.amountCents), d.chargeCode ? labelize(d.chargeCode) : null, whoOf(d)),
  'folio:payment_received': (d) => parts(peso(d.amountCents), d.method ? labelize(d.method) : null, whoOf(d)),
  'folio:settled': (d) => parts(whoOf(d), refOf(d), peso(d.totalCents)),
  'folio:closed': (d) => parts(whoOf(d), refOf(d)),
  'folio:deposit_received': (d) => parts(peso(d.amountCents), whoOf(d)),
  'folio:refund_posted': (d) => parts(peso(d.amountCents), whoOf(d)),
  'folio:early_departure_adjusted': (d) => parts(peso(d.amountCents), whoOf(d)),

  'guest:profile_created': (d) => parts(whoOf(d), d.profileNumber),
  'guest:profile_updated': (d) => parts(whoOf(d), d.profileNumber),
  'guest:profile_deleted': (d) => parts(whoOf(d), d.profileNumber),
  'guest:flagged': (d) => parts(whoOf(d), d.vipLevel ? labelize(d.vipLevel) : null, d.reason),

  'maintenance:work_order_created': (d) =>
    parts(roomOf(d), d.category ? labelize(d.category) : null, d.description),
  'maintenance:room_out_of_service': (d) => parts(roomOf(d), d.reason),
  'maintenance:room_restored': (d) => parts(roomOf(d)),

  'audit:day_opened': (d) => parts(shortDate(d.businessDate)),
  'audit:day_closed': (d) =>
    parts(
      shortDate(d.businessDate),
      d.occupancyPct != null ? `${Math.round(d.occupancyPct)}% occupancy` : null
    ),

  'facility:changed': (d) => parts(d.name || d.code),
  'facility:booked': (d) => parts(d.name || d.code, whoOf(d), shortDate(d.startsAt)),

  // The preview IS the detail. A "new message" with no hint of what it says is
  // one more thing to go and check rather than one less.
  'messaging:message_sent': (d) => d.preview || '',
};

function subjectOf(data) {
  if (!data || typeof data !== 'object') return '';
  return roomOf(data) || refOf(data) || whoOf(data) || data.businessDate || '';
}

export function describeEvent(channel, data) {
  const meta = EVENT_MAP[channel];
  if (!meta) return null;
  const d = data && typeof data === 'object' ? data : {};
  const text = typeof meta.text === 'function' ? meta.text(d) : meta.text;
  let subject = '';
  try {
    subject = DETAIL[channel] ? DETAIL[channel](d) : subjectOf(d);
  } catch {
    // A payload shaped differently from what a formatter assumed must not take
    // the notification down with it — fall back to the generic subject.
    subject = '';
  }
  return {
    icon: meta.icon,
    text,
    subject: subject || subjectOf(d),
    to: EVENT_LINK[channel]?.(d) || null,
  };
}

// Cap the stored feed. Notifications are ambient context, not an audit trail —
// the audit service owns business-day history — so old rows fall off the end
// rather than being paginated.
const MAX_ITEMS = 120;

// Keyed PER USER. A shared front-desk browser would otherwise hand the next
// person to sign in the previous user's notification history out of
// localStorage, which would undo the server-side role filtering for exactly the
// machines most likely to be shared.
const storeKey = (userId) => `innsight_notifs_${userId || 'anon'}`;

const EMPTY = { items: [], lastReadAt: 0 };

// ONE list plus a read boundary, rather than two lists. Unread and Read are two
// views of the same feed — an item is unread when it arrived after `lastReadAt`
// — so nothing has to be moved between buckets and an item cannot end up in
// both. The earlier build kept a separate `history` array; it is ignored here,
// and stops being written on the next save.
function readStored(userId) {
  try {
    const raw = localStorage.getItem(storeKey(userId));
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw);
    return {
      items: Array.isArray(parsed.items) ? parsed.items.slice(0, MAX_ITEMS) : [],
      lastReadAt: Number(parsed.lastReadAt) || 0,
    };
  } catch {
    return EMPTY;
  }
}

// `onArrive` is called with each newly arrived item, for the on-screen pop-ups.
// A callback rather than a second subscription: every call to this hook opens
// its own SSE stream, so the bell and the pop-ups have to share one.
export function useNotificationFeed(userId, onArrive) {
  const [state, setState] = useState(() => readStored(userId));
  const stateRef = useRef(state);
  stateRef.current = state;

  // Held in a ref so a caller passing an inline arrow does not re-subscribe the
  // event stream on every render.
  const arriveRef = useRef(onArrive);
  arriveRef.current = onArrive;

  // Switching accounts must swap the whole feed, not merge into it.
  useEffect(() => {
    setState(readStored(userId));
  }, [userId]);

  const persist = useCallback(
    (next) => {
      try {
        localStorage.setItem(storeKey(userId), JSON.stringify(next));
      } catch {
        /* private mode / quota — the feed just becomes session-only */
      }
    },
    [userId]
  );

  const onEvent = useCallback(
    (channel, data) => {
      const described = describeEvent(channel, data);
      if (!described) return;
      const item = {
        id: `${channel}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        channel,
        at: Date.now(),
        ...described,
      };
      const cur = stateRef.current;
      const next = {
        items: [item, ...cur.items].slice(0, MAX_ITEMS),
        lastReadAt: cur.lastReadAt,
      };
      setState(next);
      persist(next);
      try {
        arriveRef.current?.(item);
      } catch {
        /* a failing pop-up must not cost the feed the notification */
      }
    },
    [persist]
  );

  // Subscribe to everything the server is willing to send this role. Unlike a
  // page, the bell genuinely does render all of them, so the whole list is the
  // correct subscription here rather than a channel group.
  const { connected } = useLiveEvents(onEvent, LIVE_CHANNELS);

  // Moves everything from Unread to Read by advancing the boundary. Nothing is
  // destroyed, so this is the safe action and the one Clear performs on the
  // Unread tab.
  const markAllRead = useCallback(() => {
    const next = { ...stateRef.current, lastReadAt: Date.now() };
    setState(next);
    persist(next);
  }, [persist]);

  // Discards only what has already been read. Unread items are never destroyed
  // by Clear — you cannot lose something you have not seen.
  const clearRead = useCallback(() => {
    const cur = stateRef.current;
    const next = { ...cur, items: cur.items.filter((i) => i.at > cur.lastReadAt) };
    setState(next);
    persist(next);
  }, [persist]);

  const unreadItems = useMemo(() => state.items.filter((i) => i.at > state.lastReadAt), [state]);
  const readItems = useMemo(() => state.items.filter((i) => i.at <= state.lastReadAt), [state]);

  return {
    items: state.items,
    unreadItems,
    readItems,
    unread: unreadItems.length,
    markAllRead,
    clearRead,
    connected,
    lastReadAt: state.lastReadAt,
  };
}

// "just now" / "12m" / "3h" / "2d" — a notification list wants elapsed time,
// not a timestamp the reader has to subtract from.
export function relativeTime(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
