// Housekeeping status metadata — maps the PMS RoomStatus enum to the
// industry-standard codes taught in the SLSU Fundamentals of Lodging syllabus
// (VC, VCI, VD, OCC, OOO, OOS) plus the colors used on the hotel map.
// Ink for text drawn ON a `fill` below.
//
// Every fill in this table is a light pastel and is the SAME value in both
// themes — a vacant-clean room is mint whether the app is light or dark. So the
// text on it can never be a theme token: the hotel map drew the room number in
// var(--text) and the room type in var(--muted), which are near-white under
// data-theme="dark", i.e. white on mint. Both are fixed dark values here,
// beside the fills they have to work against.
export const ON_FILL_INK = '#0f172a'; // room number — 15:1 on the lightest fill
export const ON_FILL_INK_SOFT = '#475569'; // room type — 6.0:1 on the darkest fill

export const STATUS_META = {
  CLEAN: {
    code: 'VC',
    label: 'Vacant Clean',
    color: '#16a34a',
    fill: '#dcfce7',
    hint: 'Cleaned — awaiting supervisor inspection.',
  },
  CLEAN_INSPECTED: {
    code: 'VCI',
    label: 'Vacant Clean Inspected',
    color: '#2563eb',
    fill: '#dbeafe',
    hint: 'Passed inspection — ready for guest assignment.',
  },
  DIRTY: {
    code: 'VD',
    label: 'Vacant Dirty',
    color: '#dc2626',
    fill: '#fee2e2',
    hint: 'Requires immediate cleaning.',
  },
  OCCUPIED: {
    code: 'OCC',
    label: 'Occupied',
    color: '#ea580c',
    fill: '#ffedd5',
    hint: 'Guest currently in the room.',
  },
  OUT_OF_ORDER: {
    code: 'OOO',
    label: 'Out of Order',
    color: '#475569',
    fill: '#e2e8f0',
    hint: 'Major maintenance — removed from inventory.',
  },
  OUT_OF_SERVICE: {
    code: 'OOS',
    label: 'Out of Service',
    color: '#ca8a04',
    fill: '#fef9c3',
    hint: 'Minor servicing — temporarily unavailable.',
  },
};

export const STATUS_ORDER = [
  'DIRTY',
  'CLEAN',
  'CLEAN_INSPECTED',
  'OCCUPIED',
  'OUT_OF_SERVICE',
  'OUT_OF_ORDER',
];

export function statusMeta(status) {
  return (
    STATUS_META[status] || {
      code: status,
      label: status,
      color: '#64748b',
      fill: '#e2e8f0',
      hint: '',
    }
  );
}
