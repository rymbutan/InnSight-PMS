import { useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE } from '../api';

// ─────────────────────────────────────────────────────────────────────────────
// Cross-module live updates.
//
// The gateway exposes a single Server-Sent Events stream at /api/events that
// forwards every business event from the Redis bus (reservations, check-ins,
// room status, folio settlements, maintenance, night audit…). These hooks let
// any screen react to those events in real time, so the dashboard and other
// pages stay populated automatically when something changes in another module
// — no manual refresh, no polling.
//
// SUBSCRIBE TO WHAT YOU RENDER, NOT TO EVERYTHING.
// `useLiveRefresh(load)` used to default to all 30 channels, so a housekeeper
// posting a minibar charge (`folio:charge_posted`) triggered a full 8-request
// Dashboard reload and a 4-request Calendar reload in EVERY open tab — for an
// event neither page displays. Against the gateway's request budget that put the
// ceiling at about 6 concurrent dashboards before the 7th user's reload storm
// started getting rejected, which in turn hit /api/events reconnects and dropped
// everyone into 30s backoff followed by a synchronised re-storm.
//
// So pass a channel group: `useLiveRefresh(load, { channels: channels('reservations') })`.
// ─────────────────────────────────────────────────────────────────────────────

// Keep in sync with LIVE_CHANNELS in services/inventory/src/index.js.
export const LIVE_CHANNELS = [
  'room:status_changed',
  'room:maintenance',
  'reservation:created',
  'reservation:updated',
  'reservation:confirmed',
  'reservation:cancelled',
  'room:checkin',
  'room:checkout',
  'stay:no_show',
  'stay:extended',
  'stay:room_changed',
  'stay:early_departure',
  'folio:opened',
  'folio:charge_posted',
  'folio:payment_received',
  'folio:settled',
  'folio:closed',
  'folio:deposit_received',
  'folio:refund_posted',
  'folio:early_departure_adjusted',
  'folio:transferred',
  'guest:profile_created',
  'guest:profile_updated',
  'guest:flagged',
  'maintenance:work_order_created',
  'maintenance:room_out_of_service',
  'maintenance:room_restored',
  'audit:day_opened',
  'audit:day_closed',
  'facility:changed',
  'facility:booked',
];

// Named groups, so a page declares the DOMAIN it renders rather than pasting
// channel strings. Adding a channel to a domain makes every page that renders
// that domain live-aware of it, in one edit.
export const CHANNEL_GROUPS = {
  reservations: [
    'reservation:created',
    'reservation:updated',
    'reservation:confirmed',
    'reservation:cancelled',
  ],
  stays: [
    'room:checkin',
    'room:checkout',
    'stay:no_show',
    'stay:extended',
    'stay:room_changed',
    'stay:early_departure',
  ],
  rooms: ['room:status_changed', 'room:maintenance'],
  folio: [
    'folio:opened',
    'folio:charge_posted',
    'folio:payment_received',
    'folio:settled',
    'folio:closed',
    'folio:deposit_received',
    'folio:refund_posted',
    'folio:early_departure_adjusted',
  'folio:transferred',
  ],
  guests: ['guest:profile_created', 'guest:profile_updated', 'guest:flagged'],
  maintenance: [
    'maintenance:work_order_created',
    'maintenance:room_out_of_service',
    'maintenance:room_restored',
  ],
  audit: ['audit:day_opened', 'audit:day_closed'],
  facilities: ['facility:changed', 'facility:booked'],
};

// channels('reservations', 'stays') → the de-duplicated union of those groups.
export function channels(...groups) {
  const out = new Set();
  for (const g of groups) {
    const list = CHANNEL_GROUPS[g];
    if (!list) {
      console.error(`[live] unknown channel group "${g}" — see CHANNEL_GROUPS in lib/useLiveEvents.js`);
      continue;
    }
    for (const c of list) out.add(c);
  }
  return [...out];
}

// A channel the server never forwards is a silently dead subscription. That is
// not hypothetical: the Amenities page subscribed to ['facility:changed',
// 'facility:booked'] for months while neither was in the server's LIVE_CHANNELS,
// so amenity edits were permanently invisible to other clients and nothing
// anywhere said so. Fail loudly in development instead.
function warnUnforwarded(names) {
  if (!import.meta.env.DEV) return;
  const unknown = names.filter((n) => !LIVE_CHANNELS.includes(n));
  if (unknown.length) {
    console.error(
      `[live] subscribing to ${unknown.join(', ')}, which the server does not forward. ` +
        'Add them to LIVE_CHANNELS in BOTH services/inventory/src/index.js and ' +
        'web/src/lib/useLiveEvents.js, or this subscription does nothing.'
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ONE EventSource per tab, shared by every subscriber.
//
// Each useLiveEvents() call used to open its own EventSource, so a tab held one
// connection per hook. The gateway caps /api/events at 24 concurrent streams per
// client address (limit_conn sse_conn 24 in services/gateway/nginx.conf), and
// that cap is per ADDRESS — so a hotel whose terminals share one NAT'd address
// is spending from a pool of 24 for the whole property. The notification bell
// lives in the app shell and subscribes for the entire session, which on the
// old one-connection-per-hook model would have made every tab cost two streams
// and halved how many terminals could be open at once.
//
// This costs no extra bandwidth: /api/events is mounted as sseStream(LIVE_CHANNELS),
// so the server sends every channel the caller's ROLE permits regardless of what
// the browser listens for. The per-hook channel list was only ever deciding which
// events fired that hook's callback locally, which the dispatch below preserves
// exactly — a subscriber still hears only its own channels.
// ─────────────────────────────────────────────────────────────────────────────
const subscribers = new Set();
let sharedEs = null;
let sharedRetry = null;
let sharedAttempts = 0;
let sharedConnected = false;

function notifyConnection() {
  for (const s of subscribers) s.onConnection?.(sharedConnected);
}

function dispatch(e) {
  let data = null;
  try {
    data = e.data ? JSON.parse(e.data) : null;
  } catch {
    /* malformed payload — ignore */
  }
  for (const s of subscribers) {
    if (s.channels.has(e.type)) s.cb?.(e.type, data);
  }
}

function teardown() {
  clearTimeout(sharedRetry);
  sharedRetry = null;
  if (sharedEs) {
    LIVE_CHANNELS.forEach((n) => sharedEs.removeEventListener(n, dispatch));
    try {
      sharedEs.close();
    } catch {
      /* already gone */
    }
    sharedEs = null;
  }
  sharedConnected = false;
}

async function openShared() {
  // A subscriber may have unmounted while the ticket request was in flight.
  if (subscribers.size === 0 || sharedEs) return;
  const token = localStorage.getItem('innsight_token');
  if (!token) {
    // Not logged in yet — check again shortly rather than giving up.
    sharedRetry = setTimeout(openShared, 3000);
    return;
  }
  // EventSource cannot send an Authorization header, so something has to go in
  // the URL. It used to be the 12-hour session JWT — which nginx then logged.
  // Instead, exchange the token for a SINGLE-USE 30-second ticket over a normal
  // authenticated POST, and put only that in the query string.
  let ticket;
  try {
    const r = await fetch(`${API_BASE}/api/events/ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!r.ok) throw new Error(`ticket ${r.status}`);
    ({ ticket } = await r.json());
  } catch {
    // Could be an expired session or a service restart; back off and retry.
    sharedAttempts += 1;
    sharedRetry = setTimeout(openShared, Math.min(30000, 1000 * 2 ** Math.min(sharedAttempts, 5)));
    return;
  }
  if (subscribers.size === 0 || sharedEs) return;
  // Native EventSource auto-retries, but always with the ORIGINAL url — and a
  // ticket is single-use, so its built-in retry would 401-loop forever. We
  // manage reconnection ourselves and mint a fresh ticket each attempt.
  sharedEs = new EventSource(`${API_BASE}/api/events?ticket=${encodeURIComponent(ticket)}`);
  // SSE events are NAMED (event: <channel>), so a plain onmessage won't see
  // them — a listener per channel is required. Listen to all of them once and
  // route in `dispatch`, rather than per subscriber.
  LIVE_CHANNELS.forEach((n) => sharedEs.addEventListener(n, dispatch));
  sharedEs.onopen = () => {
    sharedAttempts = 0;
    sharedConnected = true;
    notifyConnection();
  };
  sharedEs.onerror = () => {
    teardown();
    notifyConnection();
    if (subscribers.size === 0) return;
    sharedAttempts += 1;
    sharedRetry = setTimeout(openShared, Math.min(30000, 1000 * 2 ** Math.min(sharedAttempts, 5)));
  };
}

function subscribe(entry) {
  subscribers.add(entry);
  if (!sharedEs && !sharedRetry) openShared();
  else entry.onConnection?.(sharedConnected);
  return () => {
    subscribers.delete(entry);
    // Last one out closes the connection, so a tab sitting on a page with no
    // live needs is not holding a stream against the gateway's cap.
    if (subscribers.size === 0) teardown();
  };
}

// Low-level: invoke onEvent(channel, data) for each live event on `channels`
// (defaults to all). Returns { connected } for a live indicator. Reconnects
// automatically on drops.
export function useLiveEvents(onEvent, channelList = LIVE_CHANNELS) {
  const [connected, setConnected] = useState(sharedConnected);
  const cbRef = useRef(onEvent);
  cbRef.current = onEvent;
  // Callers commonly pass a fresh array literal every render; key on the content
  // so that does not tear the subscription down and rebuild it on each one.
  const key = useMemo(() => channelList.join(','), [channelList.join(',')]);

  useEffect(() => {
    const names = key ? key.split(',') : LIVE_CHANNELS;
    warnUnforwarded(names);
    return subscribe({
      channels: new Set(names),
      cb: (channel, data) => cbRef.current?.(channel, data),
      onConnection: setConnected,
    });
  }, [key]);

  return { connected };
}

// High-level: call `reload()` (debounced) whenever any of `channels` fires.
// This is what list/summary screens want — one line to become live.
//
// `reload` is invoked as `reload({ live: true })`. A page whose load() shows a
// skeleton should use that to refresh in place instead, so the screen does not
// flash every time anyone anywhere touches anything.
export function useLiveRefresh(reload, { channels: channelList = LIVE_CHANNELS, delay = 600 } = {}) {
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const timer = useRef(null);

  const { connected } = useLiveEvents(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => reloadRef.current?.({ live: true }), delay);
  }, channelList);

  useEffect(() => () => clearTimeout(timer.current), []);
  return { connected };
}
