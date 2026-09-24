import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { useTheme } from '../theme';
import api from '../api';
import Icon from './Icon';
import KeyboardShortcuts from './KeyboardShortcuts';
import Greeting from './Greeting';
import NotificationBell from './NotificationBell';
import NotificationPopups from './NotificationPopups';
import IncomingCall from './IncomingCall';
import TutorialTour from './TutorialTour';
import ChatDock, { openChat } from './ChatDock';
import { applyAccent } from '../lib/accent';
import { playMessageChime } from '../lib/sound';
import { useNotificationFeed } from '../lib/notifications';
import { primaryRole } from '../lib/roles';
import RoleBadge from './RoleBadge';
import CATALOGUE from '../lib/navSections.json';

// The sidebar is the whole navigation surface now — there is no separate
// hamburger list any more, so anything reachable has to be in here or behind a
// topbar control.
//
// The entries themselves are no longer written here. They live in
// lib/navSections.json — THE catalogue, shared byte-for-byte with every service
// (services/_shared/navSections.json) so that the sidebar, the route guards in
// App.jsx and the server-side section guard cannot disagree about what a section
// is or which APIs it covers. `roles` on an entry still has to mirror the
// ProtectedRoute guard on the matching route; they are two copies of one fact,
// and the symptom when they disagree is a visible link that dead-ends.
//
// Calendar and Walk-in are deliberately NOT top-level entries: /calendar keeps
// working as a route (the topbar calendar button and the dashboard link both go
// there) and walk-in stays in the "create new" menu, where starting one belongs.
// Both are listed as `matchPaths` of the entry they belong under, so the rail
// highlights correctly while you are on them.
const NAV_SECTIONS = CATALOGUE.sections;

const COLLAPSE_KEY = 'innsight_sidebar_collapsed';

// ── The "click the background" collapse gesture ──────────────────────────────
// Both the rail and the content pane collapse the rail when you click their
// empty space. They used to carry two DIFFERENT hand-written guard selectors,
// and the rail's was the shorter one: it listed `a, button, input, select,
// label` and omitted textarea, [role=button] and [contenteditable]. One list,
// used by both, so the two gestures cannot drift apart again.
const INTERACTIVE =
  'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="tab"], [contenteditable]';

function hitInteractive(target) {
  // `closest` is what makes this safe: a click on the <svg> inside a nav link,
  // or on the unread pill, has that element as its target, so walking up finds
  // the link and the background never claims the click.
  return !(target instanceof Element) || !!target.closest(INTERACTIVE);
}

// A click that landed on a scroll container's SCROLLBAR, not on its content.
//
// This is the bug that made the rail collapse while you were trying to scroll
// it. `.side-nav` scrolls, and styling `::-webkit-scrollbar` at all opts
// Chromium out of overlay scrollbars — so the bar is a real 9px strip INSIDE
// the element, and a mousedown on the thumb reports the nav itself as the
// event target. With no interactive ancestor to find, the guard above waved it
// through and the rail collapsed under the pointer mid-drag.
//
// Comparing against clientWidth is the check: clientWidth excludes the
// scrollbar, so anything at or past it is the bar.
function hitScrollbar(e) {
  for (let el = e.target; el instanceof Element; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) {
      const r = el.getBoundingClientRect();
      // Border-box → padding-box, since clientWidth/Height are measured from
      // the padding edge.
      const bw = parseFloat(getComputedStyle(el).borderLeftWidth) || 0;
      const bh = parseFloat(getComputedStyle(el).borderTopWidth) || 0;
      if (e.clientX - r.left - bw >= el.clientWidth) return true;
      if (e.clientY - r.top - bh >= el.clientHeight) return true;
    }
  }
  return false;
}

// Beyond this much pointer travel between press and release, the gesture was a
// drag — a scrollbar grab, or a text selection swept across the group headings
// — and a drag must not toggle anything. A few pixels of slop because a plain
// click on a trackpad rarely lands on exactly one coordinate.
const DRAG_SLOP = 5;

// The press/release bookkeeping behind the background-click gesture, as one
// hook so the rail and the content pane share it rather than each growing their
// own copy. `onClick` fires the callback only for a real click on real empty
// space: primary button, no drag, no live text selection, not the scrollbar,
// and nothing interactive underneath.
function useBackgroundClick(onEmptyClick) {
  const down = useRef(null);
  return {
    onPointerDown: (e) => {
      down.current =
        e.button === 0 && !hitInteractive(e.target) && !hitScrollbar(e)
          ? { x: e.clientX, y: e.clientY }
          : null;
    },
    onClick: (e) => {
      const start = down.current;
      down.current = null;
      if (!start) return;
      if (Math.abs(e.clientX - start.x) > DRAG_SLOP || Math.abs(e.clientY - start.y) > DRAG_SLOP) return;
      // A click that merely ends a selection is not a click on the background.
      const sel = typeof window !== 'undefined' && window.getSelection?.();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return;
      // Re-checked on release: the guard above ran against the press target,
      // and a click's target can differ from it.
      if (hitInteractive(e.target)) return;
      onEmptyClick(e);
    },
  };
}

export default function Layout() {
  const { user, logout, hasRole, hasSection, refreshSections, setUser } = useAuth();
  // The desk roles. Drives both the top-bar "create" menu and the calendar
  // shortcut, which are the two top-bar controls whose every destination is
  // guarded to exactly these three.
  // MANAGER dropped from this set as part of the Manager Role Logic redesign:
  // strict oversight of existing bookings/guests/facilities, not creating new
  // ones — every item this flag gates (reservation, walk-in, guest, facility
  // booking) is exactly the "creation, booking" scope that redesign strips.
  const canCreate = hasRole('ADMIN', 'FRONT_DESK');
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
  // Clicking the rail's own background toggles it; clicking the page collapses
  // an expanded rail but never re-expands it — reopening stays a deliberate act
  // on the toggle or on the rail itself.
  const railToggle = useBackgroundClick(() => {
    if (drawerOpen) return;
    setCollapsed((c) => !c);
  });
  const contentToggle = useBackgroundClick(() => {
    if (drawerOpen || collapsed) return;
    setCollapsed(true);
  });

  // ── Notifications: ONE subscription, two surfaces ───────────────────────
  // The bell (a place you go and look) and the pop-ups (which come to you) show
  // the same rows. useNotificationFeed opens an SSE stream per call, so it is
  // held here once and handed to both rather than being called in each.
  const [popups, setPopups] = useState([]);
  const dismissPopup = useCallback((id) => setPopups((p) => p.filter((x) => x.id !== id)), []);
  // `location` is read through a ref: putting it in this callback's deps would
  // rebuild it on every navigation, and useNotificationFeed keys its subscription
  // off the callback identity.
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;
  const onNotification = useCallback((item) => {
    if (item.channel === 'messaging:message_sent') {
      // The chime lives here rather than on the unread-count poll below: this
      // fires the moment the message is sent, and the poll can be twenty
      // seconds behind it.
      playMessageChime();
      // Nothing to announce over the Messages page itself — the message is
      // already arriving in the thread the reader is looking at.
      if (pathRef.current === '/messages') return;
      // A message opens a CHAT WINDOW, not a notification card.
      //
      // The card was a dead end for the one channel where the useful response
      // is a reply: it said "Message from Maria Santos", and acting on it meant
      // clicking through to a full-page conversation and losing whatever you
      // had open. The docked window is the announcement AND the reply box, so
      // the interruption costs the reader nothing but the corner of the screen.
      // The row is still in the bell either way — this only decides which
      // surface comes to you.
      if (item.peerId) {
        openChat(item.peerId);
        return;
      }
      // No sender id in the payload (an older event shape): fall through to the
      // card, which at least still says a message arrived.
    }
    setPopups((p) => [item, ...p].slice(0, 6));
  }, []);
  const notifications = useNotificationFeed(user?.id, onNotification);
  const liveConnected = notifications.connected;
  const [acctMenuOpen, setAcctMenuOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // Shown in the popover BEFORE anything is typed, so opening the box is not a
  // dead end — the soonest arrivals are already the thing someone reaching for
  // this box during a shift is most often after. Loaded once, quietly: a role
  // that cannot see reservations just gets an empty default, same as a search
  // that turns up nothing.
  const [defaultReservations, setDefaultReservations] = useState([]);
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
  //
  // Also the moment the sidebar re-reads which sections it may show. An admin
  // saving a new layout should reach staff who are already signed in, and the
  // alternatives are worse: polling costs a request a minute forever, and baking
  // the list into the token would mean nothing changes until everyone signs out.
  // One small request per navigation, which is when the rail is being looked at
  // anyway. It is fail-soft — see hasSection in auth.jsx.
  useEffect(() => {
    setAcctMenuOpen(false);
    refreshSections();
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

  // Upcoming arrivals for the search popover's empty state — soonest check-in
  // first, same ordering the calendar and arrivals list use.
  useEffect(() => {
    api
      .get(`/api/reservations?checkInFrom=${new Date().toISOString()}`)
      .then(({ data }) => setDefaultReservations((data || []).slice(0, 5)))
      .catch(() => {
        /* a role with no reservations access just sees an empty default */
      });
  }, []);

  // ── Presence heartbeat ──────────────────────────────────────────────────
  // Lives in Layout, not on the Messages page, because "online" has to mean
  // "has the PMS open" rather than "is looking at the chat". Someone working
  // the arrivals list is reachable; a colleague who sees them greyed out would
  // go and find them in person instead of typing.
  //
  // 25s against the 45s TTL in services/messaging — one dropped request must
  // not flicker the dot for everybody watching.
  useEffect(() => {
    if (!user) return;
    const beat = () => api.post('/api/messages/presence/ping').catch(() => {});
    beat();
    const t = setInterval(beat, 25000);
    return () => clearInterval(t);
  }, [user]);

  // ── Unread messages badge ───────────────────────────────────────────────
  // Deliberately its own tiny endpoint rather than a slice of the contact
  // list: this runs on every page in the product, so it must stay one count
  // and not drag the whole Messages payload onto screens that never show it.
  // 20s, because a badge is an ambient nudge — the open conversation is what
  // needs to feel live, and that polls far faster from the page itself.
  const [unreadMessages, setUnreadMessages] = useState(0);
  // The count as of the previous poll. `null` means "not polled yet", which is
  // the case that must NOT ring: signing in with four messages waiting is not
  // four messages arriving, and chiming at a count we are merely seeing for the
  // first time would make the sound meaningless.
  const lastUnread = useRef(null);
  useEffect(() => {
    if (!user) return;
    const load = () =>
      api
        .get('/api/messages/unread-count')
        .then(({ data }) => {
          const total = data?.total || 0;
          // Only a RISE is an arrival. The count also falls (a thread was read)
          // and holds steady (nothing happened), and neither is news.
          //
          // And only while the live stream is DOWN. When SSE is connected the
          // chime has already rung from the message event above, up to twenty
          // seconds earlier; ringing again here would be the same message
          // announced twice. This is the fallback for a dropped stream, not a
          // second announcement.
          if (lastUnread.current !== null && total > lastUnread.current && !liveConnected) {
            playMessageChime();
          }
          lastUnread.current = total;
          setUnreadMessages(total);
        })
        .catch(() => {
          /* the badge is not worth an error surface — leave the last count */
        });
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [user, liveConnected]);

  // Opening the page is the moment the count is most wrong: the thread marks
  // everything read server-side, so wait for that and re-read rather than
  // leaving a stale badge up for the rest of the 20s window.
  useEffect(() => {
    if (location.pathname !== '/messages') return;
    const t = setTimeout(() => {
      api
        .get('/api/messages/unread-count')
        .then(({ data }) => {
          // No chime here. This re-read exists because opening the page CLEARS
          // the count; ringing off the same ref the poll uses would be sounding
          // an alarm about our own read receipt.
          const total = data?.total || 0;
          lastUnread.current = total;
          setUnreadMessages(total);
        })
        .catch(() => {});
    }, 1200);
    return () => clearTimeout(t);
  }, [location.pathname]);

  // First-run product tour. `hasSeenTutorial` is a DB column (see
  // services/auth/src/routes/auth.routes.js), not localStorage, so it follows
  // the ACCOUNT rather than the browser — signing in on a different machine
  // must not show it again, and clearing site data must not bring it back.
  //
  // The ref guards against re-checking on every `user` identity change (e.g.
  // finishTour's own setUser call below) — this must fire at most once per
  // mount, not once per render.
  const autoTourChecked = useRef(false);
  useEffect(() => {
    if (autoTourChecked.current || !user) return;
    autoTourChecked.current = true;
    if (user.hasSeenTutorial === false) {
      // A beat after paint, so the tour's first spotlight doesn't fight the
      // sidebar/topbar's own mount animations for the highlighted rect.
      const t = setTimeout(() => setTourOpen(true), 500);
      return () => clearTimeout(t);
    }
  }, [user]);

  // Shared by both "finished the tour" and "skipped it" — either way counts
  // as this account having seen it, so it stops greeting them at every
  // sign-in. Replaying it later (the account-menu button) calls setTourOpen
  // directly and never reaches here, so a replay can never re-flip this flag.
  async function finishTour() {
    setTourOpen(false);
    if (!user || user.hasSeenTutorial) return;
    try {
      await api.post('/api/auth/tutorial-seen');
    } catch {
      /* best-effort — worst case this account sees the tour once more */
    }
    setUser({ ...user, hasSeenTutorial: true });
  }

  // Feature/page matches are local (the catalogue is already in memory) and
  // gated by the same `reachable` check the rail uses, so the box never
  // suggests a page this role — or an admin's Sidebar Visibility choice —
  // has already closed off. Computed synchronously, unlike the guest/
  // reservation calls below, so a page match shows up before the debounce
  // even fires.
  function matchFeatures(v) {
    const needle = v.trim().toLowerCase();
    if (!needle) return [];
    return searchableFeatures.filter(
      (n) => n.label.toLowerCase().includes(needle) || n.group.toLowerCase().includes(needle)
    );
  }

  function onSearchChange(v) {
    setSearchQ(v);
    setSearchOpen(true);
    clearTimeout(searchTimer.current);
    if (!v.trim()) {
      setSearchResults(null);
      return;
    }
    const pages = matchFeatures(v);
    // Painted immediately, ahead of the debounce below — a page match is
    // already-loaded data, so there is no reason to make it wait on the
    // network round trip the guest/reservation lookups need.
    setSearchResults((prev) => ({ pages, guests: prev?.guests || [], reservations: prev?.reservations || [] }));
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
          pages,
          guests: (g.data || []).slice(0, 5),
          reservations: (r.data || []).slice(0, 5),
        });
      } catch {
        /* swallow */
      }
    }, 250);
  }

  // Drop entries this role cannot reach, then the ones an admin has hidden from
  // it in Settings → Edit System Layout, then any group left with nothing in it —
  // otherwise a housekeeper sees an "Accounting" heading over blank space.
  //
  // Two filters, not one: the role check is the permanent boundary and the
  // section check is the configurable one, and only the second can be turned off
  // by somebody clicking a checkbox. `core` entries skip the second entirely.
  //
  // `chrome: 'topbar'` entries are drawn beside the notification bell instead of
  // in the rail (Messages). They are filtered out HERE, after both permission
  // checks rather than before, so the topbar control inherits exactly the same
  // answer — hiding Messages from a role in Sidebar Visibility must remove the
  // topbar icon too, not just a rail row that is no longer there.
  const reachable = (n) => (!n.roles || hasRole(...n.roles)) && (n.core || hasSection(n.key));
  const sections = NAV_SECTIONS.map((s) => ({
    ...s,
    items: s.items.filter((n) => reachable(n) && n.chrome !== 'topbar'),
  })).filter((s) => s.items.length > 0);

  // The catalogue entry behind the topbar Messages control, or undefined when
  // this role cannot reach it.
  const messagesEntry = NAV_SECTIONS.flatMap((s) => s.items).find(
    (n) => n.key === 'messages' && n.chrome === 'topbar' && reachable(n)
  );

  // Every reachable feature, flattened for the search box — unlike `sections`
  // above, chrome:'topbar' entries (Messages) stay in: the box is a way to
  // FIND a feature, not a second copy of the rail, and Messages is reachable
  // whether or not it happens to also have a rail row.
  const searchableFeatures = NAV_SECTIONS.flatMap((s) =>
    s.items.filter(reachable).map((n) => ({
      key: n.key,
      to: n.to,
      icon: n.icon,
      group: s.label,
      label: n.nonAdminLabel && !hasRole('ADMIN') ? n.nonAdminLabel : n.label,
    }))
  );

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

      <nav className="side-nav" data-tour="tour-sidebar" aria-label="Main navigation">
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
                  {n.key === 'messages' && unreadMessages > 0 && (
                    <span
                      className="side-badge"
                      // Collapsed, the label is gone and the number would sit
                      // beside an icon with nothing to say what it counts.
                      title={`${unreadMessages} unread message${unreadMessages === 1 ? '' : 's'}`}
                    >
                      {unreadMessages > 9 ? '9+' : unreadMessages}
                    </span>
                  )}
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
      {/* The topbar now spans the FULL width of the shell — both sides, above
          the rail as well as above the content — with the sidebar and the
          content column as a row underneath it, rather than the topbar being
          scoped to the content column alone. */}
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

          <div className="cb-search-wrap" data-tour="tour-search" ref={searchRef}>
            <input
              className="cb-search"
              placeholder="Search reservations, guests, and more"
              value={searchQ}
              onChange={(e) => onSearchChange(e.target.value)}
              onFocus={() => setSearchOpen(true)}
            />
            {searchOpen &&
            searchResults &&
            (searchResults.pages.length || searchResults.guests.length || searchResults.reservations.length) ? (
              <div className="cb-search-pop">
                {searchResults.pages.length > 0 && (
                  <>
                    <div className="cb-search-section">Pages</div>
                    {searchResults.pages.map((n) => (
                      <button
                        key={n.key}
                        className="cb-search-item"
                        onClick={() => {
                          setSearchOpen(false);
                          navigate(n.to);
                        }}
                      >
                        <span>
                          <Icon name={n.icon} size={14} strokeWidth={2} /> {n.label}
                        </span>
                        <span className="muted">{n.group}</span>
                      </button>
                    ))}
                  </>
                )}
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
            ) : searchOpen && !searchQ.trim() && defaultReservations.length > 0 ? (
              // Nothing typed yet — show the soonest arrivals instead of an
              // empty box, so opening the search is not itself a dead end.
              <div className="cb-search-pop">
                <div className="cb-search-section">Upcoming reservations</div>
                {defaultReservations.map((r) => (
                  <button
                    key={r.id}
                    className="cb-search-item"
                    onClick={() => {
                      setSearchOpen(false);
                      navigate(`/reservations/${r.id}`);
                    }}
                  >
                    <span>{r.guestName || r.confirmationNumber || r.id.slice(0, 8)}</span>
                    <span className="muted">{new Date(r.checkIn).toLocaleDateString()}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="cb-actions">
            <Greeting name={user?.displayName} />

            {/* Every item in this menu — reservation, walk-in, guest, facility
                booking — is a desk action guarded to these three roles. For an
                Auditor or Housekeeping user the whole menu was four buttons that
                could only end in "not authorised", so the button itself goes
                rather than opening a dead list. */}
            <div className="cb-icon-wrap" ref={createMenuRef}>
              {canCreate && (
                <button
                  type="button"
                  className="cb-icon-btn cb-icon-create"
                  data-tour="tour-create"
                  title="Create new"
                  onClick={() => setCreateMenuOpen((o) => !o)}
                >
                  <Icon name="plus" size={18} strokeWidth={2.5} />
                </button>
              )}
              {canCreate && createMenuOpen && (
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
            {/* THREE CLUSTERS, not one undifferentiated row of icons: create,
                then the utilities you reach for occasionally, then the two
                controls that carry unread counts. Grouping is what makes six
                icons scan as three things instead of six — the gap INSIDE a
                cluster is deliberately tighter than the gap between clusters,
                so the eye gets the grouping without needing a border round
                each one. */}
            <div className="cb-util-group">
              <button
                type="button"
                className="cb-icon-btn"
                title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
                onClick={toggleTheme}
              >
                <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
              </button>
              {/* A standalone topbar icon rather than another line in the account
                menu — replaying the tour is something people reach for in the
                moment ("wait, how do I..."), not something they go looking for
                inside Settings-adjacent account chrome. graduation-cap, not
                sparkles — sparkles is already Amenities & Facilities' icon in
                the sidebar, and reusing it here read as the same feature. */}
              <button
                type="button"
                className="cb-icon-btn"
                title="Replay tutorial"
                onClick={() => setTourOpen(true)}
              >
                <Icon name="graduation-cap" size={18} />
              </button>
              {/* Gated to the roles that can actually open /calendar. This button
                is the only route to that page, so leaving it unguarded handed
                Housekeeping a shortcut straight into a "not authorised" screen —
                the guard has to be here, not only on the route. */}
              {hasRole('ADMIN', 'MANAGER', 'FRONT_DESK') && (
                <button
                  type="button"
                  className="cb-icon-btn"
                  title="Calendar"
                  onClick={() => navigate('/calendar')}
                >
                  <Icon name="calendar" size={18} />
                </button>
              )}
            </div>

            {/* Messages and the bell are the only two controls here that carry a
                count, so they belong together — and they were previously wrapped
                in a bare <span> for the tour, which made the PAIR a single flex
                item: the strip's gap applied around them but not between them,
                and the two buttons sat flush while every other pair was spaced.
                A real flex row fixes the spacing and still gives the tour one
                element to point at. */}
            <div className="cb-comms" data-tour="tour-notifications">
              {/* Messages lives here rather than in the rail. The badge is the
                  same unread count the sidebar row used to carry, so nothing is
                  lost by the move — and on a tablet the topbar stays visible
                  while the rail is a drawer you have to open. */}
              {messagesEntry && (
                <button
                  type="button"
                  className="cb-icon-btn cb-icon-messages"
                  title={unreadMessages > 0 ? `Messages — ${unreadMessages} unread` : 'Messages'}
                  aria-label={unreadMessages > 0 ? `Messages, ${unreadMessages} unread` : 'Messages'}
                  onClick={() => navigate('/messages')}
                >
                  <Icon name="message-circle" size={18} />
                  {unreadMessages > 0 && (
                    <span className="notif-badge" aria-hidden="true">
                      {unreadMessages > 9 ? '9+' : unreadMessages}
                    </span>
                  )}
                </button>
              )}
              <NotificationBell feed={notifications} />
            </div>

            {/* Hairline between the app's controls and "who am I". One separator,
                not one per cluster: the account pill is the only item here that
                is not an icon button, and marking that one boundary is enough to
                give the strip a shape without turning it into a toolbar of
                boxes. */}
            <span className="cb-sep" aria-hidden="true" />

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
                data-tour="tour-account"
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

      <div className="cb-body">
        {/* `side-collapsed` lives on the rail, NOT on the shell, so the drawer
            below — which renders the same markup — is never narrowed by it. The
            drawer is always the full-width version even while the desktop rail is
            collapsed. */}
        {/* Clicking the rail's empty space toggles it, and the listener sits on
            the RAIL rather than on .side-nav — which is what made the gesture
            unreliable. .side-nav is `flex: 1`, so its empty space is whatever the
            nav list does not fill: plenty for a housekeeper with six rows, and
            NONE for an admin whose list overflows and scrolls. For those roles
            every click in the rail landed on a link, and the gesture simply did
            not exist. On the aside, the head's empty space beside the brand, the
            strip beside the account block and the gap under the last row all
            count, at every role and window height.

            Keyboard users are unaffected: the labelled toggle in the head is
            still the primary control and the aside is not focusable. */}
        <aside className={`cb-sidebar${collapsed ? ' side-collapsed' : ''}`} {...railToggle}>
          {sidebar}
        </aside>

        {drawerOpen && (
          <>
            <div className="side-backdrop" onClick={() => setDrawerOpen(false)} />
            <aside className="cb-sidebar cb-sidebar-drawer">{sidebar}</aside>
          </>
        )}

        {/* Clicking the page collapses an expanded rail, the same gesture as
            clicking the rail's own whitespace — and now literally the same code
            path, so the two cannot disagree about what "empty space" means. It
            never fires on work: only while the rail is expanded (it never
            re-expands from here — that stays a deliberate act on the rail or its
            toggle), never while the mobile drawer is up (the backdrop owns that
            dismissal), never on a drag, a text selection or a scrollbar, and
            never when the click landed on something interactive. */}
        <div className="cb-content" {...contentToggle}>
          <main className="cb-main">
            <Outlet />
          </main>

          {/* In the shell rather than on a page: an event that happened elsewhere
              in the hotel has to reach whoever is on screen, whatever they have
              open. */}
          <NotificationPopups items={popups} onDismiss={dismissPopup} />
        </div>
      </div>
      <KeyboardShortcuts />
      {/* In the SHELL, not on a page: a call has to interrupt wherever the
          housekeeper happens to be, which is the difference between a call and
          a notification. */}
      <IncomingCall />
      {/* Docked chat windows, bottom-right. In the SHELL so a conversation
          survives navigation — a window that closed every time you changed page
          would be useless for the thing it exists for, which is replying to
          somebody without abandoning the screen you were working on.

          Suppressed on /messages: that page IS the conversation at full size,
          and a second live view of the same thread would double the poll rate
          for something already on screen. */}
      <ChatDock suppressed={location.pathname === '/messages'} />
      <TutorialTour open={tourOpen} onFinish={finishTour} />
    </div>
  );
}
