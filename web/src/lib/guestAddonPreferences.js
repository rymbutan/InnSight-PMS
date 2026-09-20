import { useEffect, useState } from 'react';
import api from '../api';

// Standardized guest preferences (extra pillows, and the like) — the option
// list itself is now admin-managed, priced catalog data (inventory-service's
// AddOnCatalogItem, edited from Amenities & Facilities), not a hardcoded
// frontend list. Which of these a given guest wants stays as-is: a
// GuestPreference row (category 'addon') keyed on the catalog item's `code`,
// so the two can never drift into their own per-booking copy.
export const ADDON_PREFERENCE_CATEGORY = 'addon';

// Shared by Guests.jsx (where prefs are set) and NewReservation.jsx (where
// they're shown AND editable, so a booking never needs a trip to the guest
// profile) so both always render the same live prices.
export function useAddOnCatalog() {
  const [catalog, setCatalog] = useState([]);
  useEffect(() => {
    api
      .get('/api/addon-catalog', { params: { active: true } })
      .then(({ data }) => setCatalog(Array.isArray(data) ? data : []))
      .catch(() => setCatalog([])); // an empty checklist is safer than a stale hardcoded one
  }, []);
  return catalog;
}
