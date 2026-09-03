import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../api';

// Subscribes to the inventory service's SSE stream (/api/rooms/events) and
// invokes onStatusChange({ roomId, number, status }) for every live room
// status transition. Returns the connection state so the UI can show a
// "live" indicator.
//
// Authorisation is a SINGLE-USE 30-second ticket, not the session JWT. Passing the
// 12-hour bearer token as `?token=` wrote a live credential into nginx's access log
// and the browser's history on every connect — see the note in
// services/inventory/src/index.js. Because a ticket is consumed on connect,
// EventSource's built-in retry (which reuses the original URL) would 401-loop, so
// reconnection is handled here with backoff and a fresh ticket per attempt.
export function useRoomEvents(onStatusChange) {
  const [connected, setConnected] = useState(false);
  const handlerRef = useRef(onStatusChange);
  handlerRef.current = onStatusChange;

  useEffect(() => {
    let es = null;
    let retryTimer = null;
    let attempts = 0;
    let closed = false;

    const onEvent = (e) => {
      try {
        handlerRef.current?.(JSON.parse(e.data));
      } catch {
        /* malformed payload — ignore */
      }
    };

    const backoff = () => {
      attempts += 1;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(attempts, 5));
      retryTimer = setTimeout(connect, delay);
    };

    async function connect() {
      if (closed) return;
      const token = localStorage.getItem('innsight_token');
      if (!token) {
        retryTimer = setTimeout(connect, 3000);
        return;
      }

      let ticket;
      try {
        const r = await fetch(`${API_BASE}/api/events/ticket`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        });
        if (!r.ok) throw new Error(`ticket ${r.status}`);
        ({ ticket } = await r.json());
      } catch {
        backoff();
        return;
      }
      if (closed) return;

      es = new EventSource(`${API_BASE}/api/rooms/events?ticket=${encodeURIComponent(ticket)}`);
      es.onopen = () => {
        attempts = 0;
        setConnected(true);
      };
      es.onerror = () => {
        setConnected(false);
        try {
          es.close();
        } catch {
          /* ignore */
        }
        if (!closed) backoff();
      };
      es.addEventListener('room:status_changed', onEvent);
    }
    connect();

    return () => {
      closed = true;
      clearTimeout(retryTimer);
      if (es) {
        es.removeEventListener('room:status_changed', onEvent);
        es.close();
      }
    };
  }, []);

  return { connected };
}
