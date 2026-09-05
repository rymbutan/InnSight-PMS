// Which single role to display for an account that holds several.
//
// `user.roles[0]` is NOT the answer, though it looks like it. That array comes
// straight from the UserRole rows in insertion order, so an account granted
// AUDITOR and later ADMIN arrives as ["AUDITOR","ADMIN"] and a full
// administrator gets labelled "AUDITOR" in the top bar. The order carries no
// meaning at all — it is whatever order the rows were written in.
//
// Precedence is therefore declared explicitly, most privileged first, and must
// stay consistent with the role definitions in services/auth/src/seed.js.
const PRECEDENCE = ['ADMIN', 'MANAGER', 'AUDITOR', 'FRONT_DESK', 'HOUSEKEEPING', 'MAINTENANCE'];

// One colour per role, so a badge is identifiable at a glance in a dense table
// without reading it — and so the same role looks the same everywhere it
// appears (top bar, Users table, anywhere added later).
//
// Fixed hex rather than theme tokens: --accent is user-customisable through the
// System Color Changer, and a role palette that shifts when someone recolours
// the app would stop being a stable identifier. All six are dark enough for
// white text to clear 4.5:1.
const ROLE_COLORS = {
  ADMIN: '#0a6b3d',
  MANAGER: '#4338ca',
  AUDITOR: '#7e22ce',
  FRONT_DESK: '#0369a1',
  HOUSEKEEPING: '#0f766e',
  MAINTENANCE: '#b45309',
};

// Slate, for a role code the app does not know about — a badge that still reads
// correctly beats one that vanishes or throws.
const ROLE_FALLBACK = '#475569';

export function roleColor(code) {
  return ROLE_COLORS[code] || ROLE_FALLBACK;
}

// Front desk reads better than FRONT_DESK in a table cell.
export function roleLabel(code) {
  if (!code) return 'User';
  return code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ');
}

export function primaryRole(roles) {
  if (!Array.isArray(roles) || roles.length === 0) return 'USER';
  for (const code of PRECEDENCE) {
    if (roles.includes(code)) return code;
  }
  // A role added to the database but not to PRECEDENCE still shows something
  // truthful rather than falling back to a generic label.
  return roles[0];
}
