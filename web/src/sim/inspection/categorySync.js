// Hydrating the shared fault categories from the server.
//
// Kept apart from categories.js so that module stays importable by Node — the
// unit tests load it without a browser or an axios instance.
import api from '../../api';
import { setCustomCategories } from './categories';

let inFlight = null;

/**
 * Fetch the shared categories once and register them. Concurrent callers share
 * one request.
 *
 * A failure is swallowed: the six built-ins still work, so an inspection remains
 * playable offline — it simply offers no teacher-authored categories.
 *
 * @param {boolean} force  refetch even if it has already been done
 */
export function hydrateCategories({ force = false } = {}) {
  if (inFlight && !force) return inFlight;
  inFlight = api
    // `all=true`: retired categories must still resolve for scenarios that
    // reference them, or those faults become unwinnable.
    .get('/api/training/categories?all=true', { timeout: 4000 })
    .then((r) => {
      setCustomCategories(r.data);
      return r.data;
    })
    .catch(() => {
      inFlight = null; // let a later attempt retry
      return null;
    });
  return inFlight;
}
