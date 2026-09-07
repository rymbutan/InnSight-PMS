// Housekeeping status metadata — maps the PMS RoomStatus enum to the
// industry-standard codes taught in the SLSU Fundamentals of Lodging syllabus
// (VC, VCI, VD, OCC, OOO, OOS) plus the colors used on the hotel map.
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
