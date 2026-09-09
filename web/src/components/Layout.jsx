import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { useTheme } from '../theme';
import api from '../api';
import Icon from './Icon';
import KeyboardShortcuts from './KeyboardShortcuts';
import Greeting from './Greeting';
import NotificationBell from './NotificationBell';
import { applyAccent } from '../lib/accent';
import { primaryRole } from '../lib/roles';
import RoleBadge from './RoleBadge';

// The sidebar is the whole navigation surface now — there is no separate
// hamburger list any more, so anything reachable has to be in here or behind a
// topbar control.
//
// `roles` on each entry MUST mirror the ProtectedRoute guard on the matching
// route in App.jsx. They are two copies of one fact, and when they disagree the
// symptom is a visible link that dead-ends in "not authorised" — so if you
// change a route's roles, change it here too.
//
// Calendar and Walk-in are deliberately NOT listed: /calendar keeps working as a
// route (the topbar calendar button and the dashboard link both go there) and
// walk-in stays in the "create new" menu, where the act of starting one belongs.
const NAV_SECTIONS = [
  {
    label: 'Main',
    items: [{ to: '/', label: 'Dashboard', icon: 'layout-dashboard', end: true }],
  },
  {
    label: 'Frontdesk',
    items: [
      { to: '/guests', label: 'Guests', icon: 'users', roles: ['ADMIN', 'MANAGER', 'FRONT_DESK'] },
      {
        to: '/folios',
        label: 'Folios',
        icon: 'file-text',
        roles: ['ADMIN', 'MANAGER', 'FRONT_DESK', 'AUDITOR'],
      },
      {
        to: '/reservations',
        label: 'Booking & Reservations',
        // NOT 'calendar' — that is the top bar's own button, and the two sat
        // close enough that the rail entry looked like a second copy of it.
        icon: 'book-marked',
        roles: ['ADMIN', 'MANAGER', 'FRONT_DESK'],
      },
      {
        to: '/arrivals',
        label: 'Arrivals & Departures',
        icon: 'arrow-left-right',
        roles: ['ADMIN', 'MANAGER', 'FRONT_DESK'],
      },
    ],
  },
  {
    label: 'Housekeeping',
    items: [
      {
        to: '/housekeeping',
        label: 'Map & Housekeeping',
        icon: 'map',
        roles: ['ADMIN', 'MANAGER', 'FRONT_DESK', 'HOUSEKEEPING'],
      },
      {
        to: '/rooms',
        label: 'Hotel Room Information Editor',
        // Everyone but Admin sees the plain-language name — the full name
        // names what the page technically is (an editor of room records),
        // which matters to whoever configures the property, not to a Front
        // Desk or Housekeeping user just looking up a room.
        nonAdminLabel: 'Hotel Rooms',
        icon: 'bed',
        roles: ['ADMIN', 'MANAGER', 'FRONT_DESK', 'HOUSEKEEPING'],
      },
      {
        to: '/amenities',
        label: 'Amenities & Facilities',
        icon: 'sparkles',
        roles: ['ADMIN', 'MANAGER', 'FRONT_DESK'],
      },
    ],
  },
  {
    label: 'Skills Proficiency',
    items: [
      {
        to: '/training',
        label: 'Training & Competency',
        icon: 'graduation-cap',
        roles: ['ADMIN', 'MANAGER', 'HOUSEKEEPING', 'FRONT_DESK'],
      },
    ],
  },
  {
    label: 'Accounting',
    items: [
      // ONE rail entry for both pages. It links to Reports; switching to Revenue
      // happens in the page header (see ReportSwitcher), not here — a rail that
      // expands to two items costs a click and a chevron to reach a destination
      // that is one tab away once you have arrived.
      {
        to: '/reports',
        label: 'Reports & Revenue',
        icon: 'bar-chart',
        matchPaths: ['/revenue'],
        roles: ['ADMIN', 'MANAGER', 'AUDITOR'],
      },
      { to: '/audit', label: 'Night Audit', icon: 'sunrise', roles: ['ADMIN', 'MANAGER', 'AUDITOR'] },
    ],
  },
  {
    label: 'Design & Layout',
    items: [
      // ONE rail entry for both editors. Scenarios is no longer listed: the two
      // are tabs of a single page now (Rooms authors the room as it should be,
      // Scenarios authors it as it should not), and /inspection-scenarios still
      // resolves for anything already bookmarked.
      {
        to: '/room-layouts',
        label: 'Room & Scenario Editor',
        icon: 'box',
        matchPaths: ['/inspection-scenarios'],
        roles: ['ADMIN'],
      },
    ],
  },
  {
    label: 'Settings',
    items: [
      { to: '/users', label: 'User & Roles', icon: 'shield', roles: ['ADMIN', 'MANAGER'] },
      { to: '/health', label: 'Service Health', icon: 'activity', roles: ['ADMIN'] },
      { to: '/settings', label: 'Settings', icon: 'settings' },
    ],
  },
];

const COLLAPSE_KEY = 'innsight_sidebar_collapsed';

export default function Layout() {
  const { user, logout, hasRole } = useAuth();
  const { theme, toggle: toggleTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Read synchronously so the rail does not render expanded and then snap
  // narrow on the first paint.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [acctMenuOpen, setAcctMenuOpen] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const createMenuRef = useRef(null);
  const acctMenuRef = useRef(null);
  const acctTriggerRef = useRef(null);
  const searchRef = useRef(null);
  const searchTimer = useRef();
  const searchSeq = useRef(0);

  useEffect(() => {
    const onClick = (e) => {
      if (createMenuRef.current && !createMenuRef.current.contains(e.target)) setCreateMenuOpen(false);
      if (acctMenuRef.current && !acctMenuRef.current.contains(e.target)) setAcctMenuOpen(false);
      if (searchRef.current && !searchRef.current.contains(e.target)) setSearchOpen(false);
    };
    // Escape closes the account menu wherever focus is. A menu opened from a
    // pill in the corner is easy to open by accident and, without this, can only
    // be dismissed by clicking away — which on a table row means also firing
    // whatever that row does.
    const onKey = (e) => {
      if (e.key === 'Escape') setAcctMenuOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // Close the account menu on navigation — every item in it navigates, and a
  // menu still hanging open over the page you just moved to reads as a bug.
  useEffect(() => {
    setAcctMenuOpen(false);
  }, [location.pathname]);

  // ── Account menu keyboard handling ──────────────────────────────────────
  // Roving focus over the menu's own buttons rather than a tracked active
  // index: the DOM already knows what the items are and which one has focus, so
  // there is no second copy of that state to fall out of sync with the markup.
  // `index` is signed — -1 is the last item, which is what ArrowUp on the
  // trigger should land on.
  function focusItem(index) {
    // The menu is rendered by the state change that has not painted yet when
    // this runs from the trigger, so defer to the frame that has it.
    requestAnimationFrame(() => {
      const items = acctMenuRef.current?.querySelectorAll('[role="menuitem"]');
      if (!items?.length) return;
      items[(index + items.length) % items.length]?.focus();
    });
  }

  function onAcctMenuKeyDown(e) {
    const items = [...(acctMenuRef.current?.querySelectorAll('[role="menuitem"]') || [])];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(at + 1) % items.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(at - 1 + items.length) % items.length].focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0].focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1].focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      // Escape returns focus to the trigger — closing a menu and dropping focus
      // to the top of the document is how a keyboard user loses their place.
      // Tab closes but lets focus move on naturally.
      setAcctMenuOpen(false);
      if (e.key === 'Escape') acctTriggerRef.current?.focus();
    }
  }

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* private mode — the rail just forgets between sessions */
    }
  }, [collapsed]);

  // The hotel's accent colours, for EVERY role — not just the admins who can
  // change them. Fetched here rather than in Settings because the accent has to
  // be right on every screen, and Settings is a screen most staff never open.
  useEffect(() => {
    api
      .get('/api/settings/theme')
      .then(({ data }) => applyAccent(data))
      .catch(() => {
        /* keep whatever the cached/shipped palette already painted */
      });
  }, []);

  function onSearchChange(v) {
    setSearchQ(v);
    setSearchOpen(true);
    clearTimeout(searchTimer.current);
    if (!v.trim()) {
      setSearchResults(null);
      return;
    }
    const seq = ++searchSeq.current;
    searchTimer.current = setTimeout(async () => {
      try {
        const [g, r] = await Promise.all([
          api.get(`/api/guests/search?q=${encodeURIComponent(v)}`).catch(() => ({ data: [] })),
          api.get(`/api/reservations?q=${encodeURIComponent(v)}`).catch(() => ({ data: [] })),
        ]);
        // Ignore a slow response that a newer query has superseded.
        if (seq !== searchSeq.current) return;
        setSearchResults({
          guests: (g.data || []).slice(0, 5),
          reservations: (r.data || []).slice(0, 5),
        });
      } catch {
        /* swallow */
      }
    }, 250);
  }

  // Drop entries this role cannot reach, then drop any group left with nothing
  // in it — otherwise a housekeeper sees an "Accounting" heading over blank space.
  const sections = NAV_SECTIONS.map((s) => ({
    ...s,
    items: s.items.filter((n) => !n.roles || hasRole(...n.roles)),
  })).filter((s) => s.items.length > 0);

  const initial = (user?.displayName || '?').slice(0, 1).toUpperCase();

  const sidebar = (
    <>
      <div className="side-head">
        <div className="side-brand">
          <img className="side-brand-mark" src="/brand/innsight-mark.png" alt="InnSight" />
          <img className="side-brand-wordmark" src="/brand/innsight-wordmark.png" alt="" aria-hidden="true" />
        </div>
        {/* Desktop: collapse to an icon rail. Mobile: close the drawer. */}
        <button
          type="button"
          className="side-collapse"
          onClick={() => {
            if (drawerOpen) setDrawerOpen(false);
            else setCollapsed((c) => !c);
          }}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        >
          <Icon name={collapsed ? 'chevron-right' : 'chevron-left'} size={15} />
        </button>
      </div>

      {/* Clicking the rail's empty space collapses it. `closest` is what makes
          this safe: a click that landed on a link, button, input or the account
          block is that control's click, not the background's, so it is ignored
          here. Only genuinely empty space gets through. Keyboard users are
          unaffected — the labelled toggle in the header is still the primary
          control, and this div is not focusable. */}
      <nav
        className="side-nav"
        aria-label="Main navigation"
        onClick={(e) => {
          if (drawerOpen) return;
          if (e.target.closest('a, button, input, select, label')) return;
          setCollapsed((c) => !c);
        }}
      >
        {sections.map((s) => (
          <div className="side-group" key={s.label}>
            {/* Hidden from sight when collapsed but kept for screen readers, so
                the grouping survives even though the text does not. */}
            <div className="side-group-label" aria-hidden={collapsed || undefined}>
              {s.label}
            </div>
            {s.items.map((n) => {
              // A nav item may show a different label to everyone but Admin
              // (see the Hotel Room Information Editor entry above) — resolved
              // here, once, rather than at every read of n.label below.
              const label = n.nonAdminLabel && !hasRole('ADMIN') ? n.nonAdminLabel : n.label;
              return (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.end}
                  // `matchPaths` marks the row active on routes other than its own
                  // `to`. Reports & Revenue links to /reports but covers both
                  // pages, and without this the rail highlights nothing at all
                  // while you are on /revenue.
                  className={({ isActive }) =>
                    `side-link${
                      isActive || n.matchPaths?.some((p) => location.pathname.startsWith(p)) ? ' active' : ''
                    }`
                  }
                  onClick={() => setDrawerOpen(false)}
                  // The label is the only affordance left once collapsed.
                  title={collapsed ? label : undefined}
                >
                  <Icon name={n.icon} size={18} strokeWidth={1.9} />
                  <span className="side-link-label">{label}</span>
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="side-user">
        <button
          type="button"
          className="side-user-main"
          onClick={() => {
            setDrawerOpen(false);
            navigate('/settings');
          }}
          title={`${user?.displayName || ''} — open settings`}
        >
          <span className="side-user-avatar">{initial}</span>
          <span className="side-user-text">
            <span className="side-user-name">{user?.displayName}</span>
            <span className="side-user-role">{user?.roles?.join(', ')}</span>
          </span>
        </button>
        <button type="button" className="side-user-out" onClick={logout} title="Sign out">
          <Icon name="log-out" size={16} />
        </button>
      </div>
    </>
  );

  return (
    <div className="cb-app">
      {/* `side-collapsed` lives on the rail, NOT on the shell, so the drawer
          below — which renders the same markup — is never narrowed by it. The
          drawer is always the full-width version even while the desktop rail is
          collapsed. */}
      <aside className={`cb-sidebar${collapsed ? ' side-collapsed' : ''}`}>{sidebar}</aside>

      {drawerOpen && (
        <>
          <div className="side-backdrop" onClick={() => setDrawerOpen(false)} />
          <aside className="cb-sidebar cb-sidebar-drawer">{sidebar}</aside>
        </>
      )}

      {/* Clicking the page collapses an expanded rail, the same gesture as
          clicking the rail's own whitespace. Guarded three ways so it never
          fires on work: only while the rail is expanded (it never re-expands —
          that stays a deliberate act on the toggle), never while the mobile
          drawer is up (the backdrop owns that dismissal), and never when the
          click landed on something interactive. `closest` is what makes the
          last one hold: a click on a button INSIDE a panel has that button as
          its target, so the panel never sees an "empty space" click that was
          really someone pressing Save. */}
      <div
        className="cb-content"
        onClick={(e) => {
          if (
            !collapsed &&
            !drawerOpen &&
            !e.target.closest('a, button, input, select, textarea, label, [role="button"], [contenteditable]')
          )
            setCollapsed(true);
        }}
      >
        <header className="cb-topbar">
          <button
            type="button"
            className="cb-hamburger"
            aria-label="Open menu"
            onClick={() => setDrawerOpen(true)}
          >
            <Icon name="menu" size={18} />
          </button>

          {/* One control, in the shared topbar, so every routed page gets it
              for free rather than each page wiring its own. Hidden on the
              dashboard itself — there is nothing in the app to go back TO
              from the landing page. navigate(-1) walks the app's own history
              stack, the same one the browser's back button reads. */}
          {location.pathname !== '/' && (
            <button type="button" className="cb-back" onClick={() => navigate(-1)}>
              <Icon name="chevron-left" size={15} strokeWidth={2.2} />
              Back
            </button>
          )}

          <div className="cb-search-wrap" ref={searchRef}>
            <input
              className="cb-search"
              placeholder="Search reservations, guests, and more"
              value={searchQ}
              onChange={(e) => onSearchChange(e.target.value)}
              onFocus={() => setSearchOpen(true)}
            />
            {searchOpen &&
            searchResults &&
            (searchResults.guests.length || searchResults.reservations.length) ? (
              <div className="cb-search-pop">
                {searchResults.guests.length > 0 && (
                  <>
                    <div className="cb-search-section">Guests</div>
                    {searchResults.guests.map((g) => (
                      <button
                        key={g.id}
                        className="cb-search-item"
                        onClick={() => {
                          setSearchOpen(false);
                          navigate(`/guests?id=${g.id}`);
                        }}
                      >
                        <span>{g.displayName}</span>
                        <span className="muted">{g.profileNumber}</span>
                      </button>
                    ))}
                  </>
                )}
                {searchResults.reservations.length > 0 && (
                  <>
                    <div className="cb-search-section">Reservations</div>
                    {searchResults.reservations.map((r) => (
                      <button
                        key={r.id}
                        className="cb-search-item"
                        onClick={() => {
                          setSearchOpen(false);
                          navigate(`/reservations/${r.id}`);
                        }}
                      >
                        <span>{r.guestName || r.confirmationNumber || r.id.slice(0, 8)}</span>
                        <span className="muted">{r.confirmationNumber}</span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            ) : null}
          </div>

          <div className="cb-actions">
            <Greeting name={user?.displayName} />

            <div className="cb-icon-wrap" ref={createMenuRef}>
              <button
                type="button"
                className="cb-icon-btn cb-icon-create"
                title="Create new"
                onClick={() => setCreateMenuOpen((o) => !o)}
              >
                <Icon name="plus" size={18} strokeWidth={2.5} />
              </button>
              {createMenuOpen && (
                <div className="cb-popmenu">
                  <button
                    type="button"
                    className="cb-popmenu-item"
                    onClick={() => {
                      setCreateMenuOpen(false);
                      navigate('/reservations/new');
                    }}
                  >
                    New reservation
                  </button>
                  <button
                    type="button"
                    className="cb-popmenu-item"
                    onClick={() => {
                      setCreateMenuOpen(false);
                      navigate('/walk-in');
                    }}
                  >
                    Walk-in
                  </button>
                  <button
                    type="button"
                    className="cb-popmenu-item"
                    onClick={() => {
                      setCreateMenuOpen(false);
                      navigate('/guests');
                    }}
                  >
                    New guest
                  </button>
                  {/* Booking a hall or meeting room is a "create" in the same
                      sense as a reservation, and it was the one create with no
                      way in from here. `?book=1` opens the page with the desk
                      focused rather than dropping you at the top of it. */}
                  <button
                    type="button"
                    className="cb-popmenu-item"
                    onClick={() => {
                      setCreateMenuOpen(false);
                      navigate('/amenities?book=1');
                    }}
                  >
                    Book a facility
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              className="cb-icon-btn"
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              onClick={toggleTheme}
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
            </button>
            <button
              type="button"
              className="cb-icon-btn"
              title="Calendar"
              onClick={() => navigate('/calendar')}
            >
              <Icon name="calendar" size={18} />
            </button>
            <NotificationBell userId={user?.id} />

            {/* The role, spelled out, in place of an avatar initial — a circle
                with "A" in it identifies nobody and says nothing about what the
                person signed in can do. An account with several roles shows its
                highest-privilege one; see primaryRole for why the array's own
                order cannot be used.

                It is a BUTTON, not a label. The pill is the only piece of the top
                bar that identifies the account, so it is where people go looking
                for "who am I / sign out" — and on mobile, where the rail is a
                drawer, the rail's own user block is behind a hamburger tap. The
                menu shows the full role list too, which the pill alone cannot:
                it can only display the highest-privilege one. */}
            <div className="cb-acct" ref={acctMenuRef}>
              <button
                type="button"
                ref={acctTriggerRef}
                className="cb-acct-trigger"
                onClick={() => setAcctMenuOpen((v) => !v)}
                // ArrowDown/Up opens the menu straight onto the first/last item,
                // which is the behaviour a menu button is expected to have — a
                // keyboard user should not have to open and then re-aim.
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    setAcctMenuOpen(true);
                    focusItem(e.key === 'ArrowDown' ? 0 : -1);
                  }
                }}
                aria-haspopup="menu"
                aria-expanded={acctMenuOpen}
                aria-controls="cb-acct-menu"
                title={`${user?.displayName || 'Account'} — ${user?.roles?.join(', ') || ''}`}
              >
                <RoleBadge upper code={primaryRole(user?.roles)} />
                <Icon name="chevron-down" size={14} className="cb-acct-caret" />
              </button>
              {acctMenuOpen && (
                <div
                  className="cb-popmenu cb-acct-menu"
                  id="cb-acct-menu"
                  role="menu"
                  aria-label="Account"
                  onKeyDown={onAcctMenuKeyDown}
                >
                  <div className="cb-acct-head">
                    <span className="cb-acct-name">{user?.displayName || user?.username}</span>
                    {user?.username && user?.displayName && (
                      <span className="cb-acct-sub">@{user.username}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    className="cb-popmenu-item"
                    onClick={() => {
                      setAcctMenuOpen(false);
                      navigate('/settings');
                    }}
                  >
                    <Icon name="settings" size={15} />
                    Settings
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="cb-popmenu-item is-danger"
                    onClick={() => {
                      setAcctMenuOpen(false);
                      logout();
                    }}
                  >
                    <Icon name="log-out" size={15} />
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="cb-main">
          <Outlet />
        </main>
      </div>
      <KeyboardShortcuts />
    </div>
  );
}
