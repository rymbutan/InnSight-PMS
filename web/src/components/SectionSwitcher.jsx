import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth';
import Icon from './Icon';

// Switches between sibling pages from the page header, beside the title.
//
// Reports and Revenue used to be a two-item submenu on the sidebar rail. They
// are separate routes with separate pages and stay that way — but once you are
// standing on one of them the other is a sibling view, not a separate
// destination, so the control belongs next to the content rather than back in
// the global navigation.
//
// Options the signed-in role cannot reach are dropped, and if that leaves only
// one the switcher renders nothing at all — a "switcher" with a single option
// is just a label.
export default function SectionSwitcher({ options }) {
  const { hasRole } = useAuth();
  const visible = options.filter((o) => !o.roles || hasRole(...o.roles));
  if (visible.length < 2) return null;

  return (
    <nav className="page-switch" aria-label="Section">
      {visible.map((o) => (
        <NavLink key={o.to} to={o.to} end>
          {o.icon ? <Icon name={o.icon} size={13} strokeWidth={2} /> : null}
          {o.label}
        </NavLink>
      ))}
    </nav>
  );
}

// The Reports ⇄ Revenue ⇄ Night Audit trio, declared once so the sibling pages
// cannot drift apart on labels, icons or role gating. Roles mirror the route
// guards in App.jsx. Night Audit joined this switcher rather than keeping its
// own rail entry — same move Revenue made first — because "close out today"
// is a sibling view of the property's numbers, not a separate destination.
export const REPORTS_SECTIONS = [
  { to: '/reports', label: 'Reports', icon: 'bar-chart', roles: ['ADMIN', 'MANAGER', 'AUDITOR'] },
  { to: '/revenue', label: 'Revenue', icon: 'coins', roles: ['ADMIN', 'MANAGER'] },
  { to: '/audit', label: 'Night Audit', icon: 'sunrise', roles: ['ADMIN', 'MANAGER', 'AUDITOR'] },
];
