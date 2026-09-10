// User Directory Display Hierarchy: every user management table/listing pins
// Admin accounts at the top, then orders everyone else alphabetically (A–Z)
// by name. Pulled out of Users.jsx so the ordering itself is unit-testable
// without mounting the page — the same reasoning as quickEditPlan.js.

export function isAdminRow(u) {
  return (u.roles || []).some((r) => (r.roleCode || r) === 'ADMIN');
}

export function sortUsers(users) {
  const nameOf = (u) => (u.displayName || u.username || '').toLowerCase();
  return [...users].sort((a, b) => {
    const adminDiff = Number(isAdminRow(b)) - Number(isAdminRow(a));
    if (adminDiff) return adminDiff;
    return nameOf(a).localeCompare(nameOf(b));
  });
}
