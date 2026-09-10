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

// Each `color` is chosen for what it signals to housekeeping/front-desk at a
// glance, not just for visual variety — this is a status BOARD, and a color
// that reads as the wrong urgency is a worse bug than a room drawn "ugly":
//   green   → go / ready / positive (VC: nothing stands between this room and
//             a guest except a supervisor's sign-off)
//   blue    → trust / verified (VCI: someone actually checked it — blue is
//             the same "confirmed" signal a checkmark or a badge uses)
//   red     → stop / needs action now (VD: the one state that actively blocks
//             a sale until a person does something about it)
//   violet  → privacy / do-not-disturb, NOT caution (OCC: a guest is in
//             residence, which is the successful, ordinary outcome of a
//             booking — not a problem. Amber/orange here would read as a
//             warning on a room that's simply doing its job, and hospitality
//             signage already uses violet/purple for "occupied" precisely to
//             avoid that false alarm)
//   amber   → caution / temporary (OOS: a known, short-lived limitation —
//             amber sits a deliberate notch below red because this isn't
//             blocking inventory the way VD or OOO does)
//   slate   → neutral / inactive (OOO: removed from the sellable set
//             entirely — gray reads as "not part of today's board" rather
//             than "urgent," which fits a room that's already been reported
//             and is now just waiting on a longer repair)
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
  // Was orange (#ea580c) — orange/amber is a caution color, and an occupied
  // room isn't a problem to watch, it's the point of the whole operation.
  // Violet is the hospitality-industry convention for "guest in residence /
  // do not disturb" for exactly that reason: calm and private, not alarmed.
  OCCUPIED: {
    code: 'OCC',
    label: 'Occupied',
    color: '#7c3aed',
    fill: '#ede9fe',
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
