import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth';

// Two independent gates, deliberately not merged:
//
//   `roles`   the permanent one. Who this page is FOR, written in the source and
//             mirrored by a requireRole guard on every API it calls. Nothing an
//             admin can click changes it.
//   `section` the configurable one. A section key from navSections.json that an
//             admin may hide from a role in Settings → Edit System Layout. It can
//             only ever take a page away from someone the `roles` gate already
//             let in — never grant one — so the two compose as an AND and the
//             order they are checked in does not matter.
//
// Both redirect to the dashboard rather than showing a "denied" screen: that is
// what this app already did for a role miss, and the dashboard is `core` in the
// catalogue precisely so it can never itself be hidden.
export default function ProtectedRoute({ children, roles, section }) {
  const { user, hasRole, hasSection } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !hasRole(...roles)) return <Navigate to="/" replace />;
  if (section && !hasSection(section)) return <Navigate to="/" replace />;
  return children;
}
