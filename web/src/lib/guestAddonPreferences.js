// Standardized, unpriced guest preferences — "Add-on information" lives on
// the guest's own profile (Guests.jsx), not re-entered per booking. Shared
// between Guests.jsx (where they're set) and NewReservation.jsx (where
// they're shown, read-only, so the desk sees what this guest usually wants
// without leaving the wizard) so the two can never drift out of sync.
//
// Backed by GuestPreference (category 'addon'), a generic key/value store
// that already existed for exactly this shape of data.
export const ADDON_PREFERENCE_OPTIONS = [
  { code: 'EXTRA_PILLOWS', label: 'Extra pillows' },
  { code: 'EXTRA_TOWELS', label: 'Extra towels' },
  { code: 'EXTRA_BED', label: 'Extra bed' },
  { code: 'BABY_COT', label: 'Baby cot' },
  { code: 'HYPOALLERGENIC_BEDDING', label: 'Hypoallergenic bedding' },
  { code: 'AIRPORT_TRANSFER', label: 'Airport transfer' },
  { code: 'EARLY_CHECKIN', label: 'Early check-in' },
  { code: 'LATE_CHECKOUT', label: 'Late checkout' },
];

export const ADDON_PREFERENCE_CATEGORY = 'addon';
