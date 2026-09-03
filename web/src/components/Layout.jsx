import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { useTheme } from '../theme';
import api from '../api';
import Icon from './Icon';
import KeyboardShortcuts from './KeyboardShortcuts';

const PRIMARY_NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/calendar', label: 'Calendar', roles: ['ADMIN', 'MANAGER', 'FRONT_DESK', 'HOUSEKEEPING'] },
  { to: '/housekeeping', label: 'Housekeeping', roles: ['ADMIN', 'MANAGER', 'FRONT_DESK', 'HOUSEKEEPING'] },
  { to: '/reservations', label: 'Reservations', roles: ['ADMIN', 'MANAGER', 'FRONT_DESK'] },
  { to: '/arrivals', label: 'Front Desk', roles: ['ADMIN', 'MANAGER', 'FRONT_DESK'] },
  { to: '/guests', label: 'Guests', roles: ['ADMIN', 'MANAGER', 'FRONT_DESK'] },
  { to: '/reports', label: 'Reports', roles: ['ADMIN', 'MANAGER', 'AUDITOR'] },
  { to: '/revenue', label: 'Revenue', roles: ['ADMIN', 'MANAGER'] },
];

const HAMBURGER_NAV = [
  { to: '/rooms', label: 'Rooms & Housekeeping' },
  { to: '/amenities', label: 'Amenities & Facilities', roles: ['ADMIN', 'MANAGER', 'FRONT_DESK'] },
  {
    to: '/training',
    label: 'Training & Competency',
    roles: ['ADMIN', 'MANAGER', 'HOUSEKEEPING', 'FRONT_DESK'],
  },
  { to: '/walk-in', label: 'Walk-in', roles: ['ADMIN', 'MANAGER', 'FRONT_DESK'] },
  { to: '/folios', label: 'Folios', roles: ['ADMIN', 'MANAGER', 'FRONT_DESK', 'AUDITOR'] },
  { to: '/audit', label: 'Night Audit', roles: ['ADMIN', 'MANAGER', 'AUDITOR'] },
  { to: '/users', label: 'Users & Roles', roles: ['ADMIN', 'MANAGER'] },
  { to: '/health', label: 'Service Health', roles: ['ADMIN', 'MANAGER'] },
  // ADMIN only. Nav entries are filtered by `roles` below, so this is hidden from
  // everyone else rather than merely un-linked — the old /sim-demo harness was an
  // unlisted URL any authenticated user could reach.
  { to: '/room-layouts', label: 'Room Layouts (3D)', roles: ['ADMIN'] },
  { to: '/inspection-scenarios', label: 'Inspection Scenarios (3D)', roles: ['ADMIN'] },
];

export default function Layout() {
  const { user, logout, hasRole } = useAuth();
  const { theme, toggle: toggleTheme } = useTheme();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const userMenuRef = useRef(null);
  const createMenuRef = useRef(null);
  const searchRef = useRef(null);
  const searchTimer = useRef();
  const searchSeq = useRef(0);

  useEffect(() => {
    const onClick = (e) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) setUserMenuOpen(false);
      if (createMenuRef.current && !createMenuRef.current.contains(e.target)) setCreateMenuOpen(false);
      if (searchRef.current && !searchRef.current.contains(e.target)) setSearchOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
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

  const visiblePrimary = PRIMARY_NAV.filter((n) => !n.roles || hasRole(...n.roles));
  const visibleDrawer = HAMBURGER_NAV.filter((n) => !n.roles || hasRole(...n.roles));

  return (
    <div className="cb-app">
      <header className="cb-topbar">
        <button
          type="button"
          className="cb-hamburger"
          aria-label="Open menu"
          onClick={() => setDrawerOpen(true)}
        >
          <Icon name="menu" size={18} />
        </button>

        {/* The mark, not a stock building glyph. The wordmark is an image too,
            so the lockup keeps its own letterforms rather than approximating
            them in the UI font. Both are decorative here — the alt text on the
            mark carries the name once, and the wordmark is aria-hidden so a
            screen reader does not read "InnSight" twice. */}
        <div className="cb-brand">
          <img className="cb-brand-mark-img" src="/brand/innsight-mark.png" alt="InnSight" />
          <img
            className="cb-brand-wordmark"
            src="/brand/innsight-wordmark.png"
            alt=""
            aria-hidden="true"
          />
        </div>

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
                  onClick={() => {
                    setCreateMenuOpen(false);
                    navigate('/reservations/new');
                  }}
                >
                  New reservation
                </button>
                <button
                  onClick={() => {
                    setCreateMenuOpen(false);
                    navigate('/walk-in');
                  }}
                >
                  Walk-in
                </button>
                <button
                  onClick={() => {
                    setCreateMenuOpen(false);
                    navigate('/guests');
                  }}
                >
                  New guest
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
          <button type="button" className="cb-icon-btn" title="Rooms" onClick={() => navigate('/rooms')}>
            <Icon name="bed" size={18} />
          </button>
          <button type="button" className="cb-icon-btn" title="Notifications">
            <Icon name="bell" size={18} />
          </button>

          <div className="cb-icon-wrap" ref={userMenuRef}>
            <button
              type="button"
              className="cb-user-btn"
              onClick={() => setUserMenuOpen((o) => !o)}
              title={user?.displayName}
            >
              <span className="cb-user-avatar">{(user?.displayName || '?').slice(0, 1).toUpperCase()}</span>
            </button>
            {userMenuOpen && (
              <div className="cb-popmenu cb-popmenu-right">
                <div className="cb-user-head">
                  <div className="cb-user-name">{user?.displayName}</div>
                  <div className="cb-user-role">{user?.roles?.join(', ')}</div>
                </div>
                <div className="cb-popmenu-divider" />
                <button
                  onClick={() => {
                    setUserMenuOpen(false);
                    navigate('/change-password');
                  }}
                >
                  Change password
                </button>
                <button
                  onClick={() => {
                    setUserMenuOpen(false);
                    logout();
                  }}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {drawerOpen && (
        <>
          <div className="cb-drawer-backdrop" onClick={() => setDrawerOpen(false)} />
          <aside className="cb-drawer">
            <div className="cb-drawer-head">
              <img className="cb-brand-mark-img sm" src="/brand/innsight-mark.png" alt="" />{' '}
              Menu
              <button
                className="cb-drawer-close"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close menu"
              >
                <Icon name="x" size={18} />
              </button>
            </div>
            <nav>
              {[...visiblePrimary, ...visibleDrawer].map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.end}
                  className="cb-drawer-link"
                  onClick={() => setDrawerOpen(false)}
                >
                  {n.label}
                </NavLink>
              ))}
            </nav>
          </aside>
        </>
      )}

      <main className="cb-main">
        <Outlet />
      </main>
      <KeyboardShortcuts />
    </div>
  );
}
