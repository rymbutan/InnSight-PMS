import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveEvents, LIVE_CHANNELS } from './useLiveEvents';

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
// ─────────────────────────────────────────────────────────────────────────────

// How each channel reads to a human, plus the icon its row carries. `subject`
// pulls the most identifying field out of the payload — room number,
// confirmation code, guest name — so a row says which thing changed rather than
// just that something did.
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
  'guest:flagged': { icon: 'info', text: 'Guest flagged' },

  'maintenance:work_order_created': { icon: 'settings', text: 'Work order created' },
  'maintenance:room_out_of_service': { icon: 'ban', text: 'Room out of service' },
  'maintenance:room_restored': { icon: 'check', text: 'Room back in service' },

  'audit:day_opened': { icon: 'moon', text: 'Business day opened' },
  'audit:day_closed': { icon: 'moon', text: 'Business day closed' },

  'facility:changed': { icon: 'sparkles', text: 'Amenity updated' },
  'facility:booked': { icon: 'sparkles', text: 'Facility booked' },
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
  'guest:flagged': (d) => (d?.guestId ? `/guests?id=${d.guestId}` : '/guests'),
  'maintenance:work_order_created': () => '/rooms',
  'maintenance:room_out_of_service': () => '/rooms',
  'maintenance:room_restored': () => '/rooms',
  'audit:day_opened': () => '/audit',
  'audit:day_closed': () => '/audit',
  'facility:changed': () => '/amenities',
  'facility:booked': () => '/amenities',
};

function subjectOf(data) {
  if (!data || typeof data !== 'object') return '';
  const d = data;
  const room = d.number || d.roomNumber || d.room;
  if (room) return `Room ${room}`;
  return (
    d.confirmationNumber ||
    d.guestName ||
    d.displayName ||
    d.folioNumber ||
    d.businessDate ||
    d.name ||
    ''
  );
}

export function describeEvent(channel, data) {
  const meta = EVENT_MAP[channel];
  if (!meta) return null;
  return {
    icon: meta.icon,
    text: meta.text,
    subject: subjectOf(data),
    to: EVENT_LINK[channel]?.(data) || null,
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

export function useNotificationFeed(userId) {
  const [state, setState] = useState(() => readStored(userId));
  const stateRef = useRef(state);
  stateRef.current = state;

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

  const unreadItems = useMemo(
    () => state.items.filter((i) => i.at > state.lastReadAt),
    [state]
  );
  const readItems = useMemo(
    () => state.items.filter((i) => i.at <= state.lastReadAt),
    [state]
  );

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
