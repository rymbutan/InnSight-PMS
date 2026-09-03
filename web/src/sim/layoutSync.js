// Hydrating the shared room layouts from the server.
//
// Kept apart from roomLayouts.js so that module stays importable by Node — the
// geometry validator and the unit tests both load it without a browser.
import api from '../api';
import { setRoomLayouts } from './roomLayouts';

let inFlight = null;

/**
 * Fetch the shared layouts once and apply them. Safe to call from anywhere and
 * as often as you like: concurrent callers share one request.
 *
 * A failure is deliberately swallowed — the app falls back to the layouts
 * committed in roomLayouts.js, which is a correct room, not a broken one.
 *
 * @param {boolean} force  refetch even if it has already been done
 */
export function hydrateRoomLayouts({ force = false } = {}) {
  if (inFlight && !force) return inFlight;
  inFlight = api
    .get('/api/room-layouts')
    .then((r) => {
      setRoomLayouts(r.data);
      return r.data;
    })
    .catch(() => {
      inFlight = null; // let a later attempt retry
      return null;
    });
  return inFlight;
}
