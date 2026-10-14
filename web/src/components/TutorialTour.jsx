// First-run product tour + manual replay.
//
// Two kinds of step:
//  - "chrome" steps point at persistent Layout controls (sidebar, search,
//    create, notifications, account) via data-tour="..." attributes. They
//    never navigate — Layout wraps every route, so these are always mounted.
//  - "page" steps actually visit a route and highlight its title, so the
//    tour explains what each SCREEN is for, not just the shell around it.
//    Which pages appear, and in what order, is read from the same
//    lib/navSections.json catalogue that builds the sidebar — so a role sees
//    exactly the pages it can reach, in the order it sees them there, and a
//    page nobody has hidden from this role's sidebar can't go missing from
//    its tour either.
//
// Nearly every page already renders its title as `.page-head` or a bare
// `<h1>`/`<h2>`/`<h3>` near the top (see web/src/pages/*.jsx) — reusing that
// existing convention as the highlight target means a new page needs no
// tour-specific markup to be included here; it only needs the sidebar entry
// it already has.
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import Icon from './Icon';

// The sidebar step has a phone-width alternate rather than just vanishing
// there: below 640px the rail itself is display:none (see .mobile-tabbar in
// styles.css) and a fixed bottom tab bar is the real primary navigation, so
// the tour should point at THAT, not silently skip explaining navigation
// altogether on a phone. Which one applies is decided once per tour open —
// see `isPhone` below — the same snapshot-and-don't-recheck approach already
// used for role/section visibility in this file.
const CHROME_STEPS = [
  {
    target: '[data-tour="tour-sidebar"]',
    phoneTarget: '[data-tour="tour-mobile-nav"]',
    title: 'Your navigation',
    phoneTitle: 'Your navigation',
    body: 'Every module you can reach lives here, grouped by section. Collapse it to an icon rail with the arrow at the top.',
    phoneBody:
      'Home, Bookings, Rooms, and Messages sit in this bar — tap More for everything else, the same full list the sidebar shows on a larger screen. You can also add InnSight to your home screen from your browser menu, so it opens like an app.',
  },
  {
    target: '[data-tour="tour-search"]',
    title: 'Search anywhere',
    body: 'Find a reservation or a guest from any screen in the app. Press "/" to jump straight to it.',
  },
  {
    target: '[data-tour="tour-create"]',
    title: 'Start something new',
    body: 'Create a reservation, a walk-in, a guest profile, or book a facility — all from one menu.',
  },
  {
    target: '[data-tour="tour-notifications"]',
    title: 'Messages & notifications',
    body:
      'Messages from colleagues, and alerts that need your attention. Both show ' +
      'an unread count here — Messages moved up from the sidebar so it stays in ' +
      'reach on a tablet, where the sidebar is a drawer.',
  },
  {
    target: '[data-tour="tour-account"]',
    title: 'Your account',
    body: 'Update your profile and settings, or sign out, from this menu.',
  },
];

// One entry per sidebar section in lib/navSections.json, in the SAME order
// they appear there (Main → Frontdesk → Housekeeping → Accounting →
// Design & Layout → Settings), with `calendar` inserted right after
// `reservations` — it isn't its own sidebar entry (navSections.json folds it
// into "Booking & Reservations" via matchPaths) but it's a genuinely
// different screen worth a stop of its own.
//
// `roles`/`core` mirror navSections.json exactly (and Layout.jsx's own filter
// — `(!roles || hasRole(...roles)) && (core || hasSection(key))`) so a page
// hidden from this account's sidebar is skipped here too, and one restored
// there reappears here with no further change.
// `process`, where present, becomes a SECOND step right after the page's
// overview — same page (no extra navigation), but pointing at the one
// control that actually drives that page's real-world workflow, with a
// description of the end-to-end process rather than just "here's a button".
// Left off a page when nothing on its list/index view is guaranteed to be in
// the DOM regardless of live data (e.g. Guests, Users, Rooms) — pointing at
// something that only renders after a search or an existing record would
// make the tour break depending on what's in the database.
const PAGES = [
  {
    key: 'dashboard',
    to: '/',
    core: true,
    title: 'Dashboard',
    body: 'Your daily snapshot — arrivals, departures, in-house guests, and room status at a glance. Every number here links through to the underlying list, so "12 arrivals today" is one click from the actual reservations. This is home base.',
  },
  {
    key: 'guests',
    to: '/guests',
    roles: ['ADMIN', 'MANAGER', 'FRONT_DESK'],
    title: 'Guests',
    body: 'Search guest profiles by name, phone, or email, and open one to see their full stay history, loyalty status, and any flags on the account. A profile is shared across every reservation and folio it touches, so updating a phone number here keeps every future booking in sync.',
  },
  {
    key: 'folios',
    to: '/folios',
    roles: ['ADMIN', 'MANAGER', 'FRONT_DESK', 'AUDITOR'],
    title: 'Folios',
    body: "A folio is a guest's running bill for the stay — every room charge, service, and payment lands here. Search for one, then add charges, record a payment, print a receipt, or resolve a disputed card payment. Closing a folio requires its balance to be fully settled first.",
    process: {
      target: '[data-tour="tour-process-folios"]',
      title: 'Processing a folio',
      body: "Search by folio number or guest name to pull one up. Once it's open: add a charge for anything the guest consumed, record a payment against the balance, print or email a receipt, and — once the balance reaches zero — close it out.",
    },
  },
  {
    key: 'reservations',
    to: '/reservations',
    roles: ['ADMIN', 'MANAGER', 'FRONT_DESK'],
    title: 'Booking & Reservations',
    body: "This is where a booking's entire lifecycle plays out: create it, get it confirmed, check the guest in on arrival day, add charges to their folio during the stay, and check them out. Filter by date, status, or room type, and click any row to open that reservation's full detail and timeline.",
    process: {
      target: '[data-tour="tour-process-reservations"]',
      title: 'Creating a reservation',
      body: "Click here to start one: pick dates and a room type, attach an existing guest or create a new profile on the spot, and optionally collect a deposit. It's created as CONFIRMED (or PENDING, if it still needs a deposit) — from there it flows into Arrivals on its check-in date.",
    },
  },
  {
    key: 'calendar',
    to: '/calendar',
    roles: ['ADMIN', 'MANAGER', 'FRONT_DESK'],
    title: 'Calendar',
    body: 'Availability and arrivals laid out by date — the fastest way to spot an open room without paging through the reservations list. Click a date to jump straight into starting a new booking for it.',
  },
  {
    key: 'arrivals',
    to: '/arrivals',
    roles: ['ADMIN', 'MANAGER', 'FRONT_DESK'],
    title: 'Arrivals & Departures',
    body: "Today's arrivals and departures in one worklist, switchable between Today, Week, and Month so you can plan ahead as well as work the day.",
    process: {
      target: '[data-tour="tour-process-arrivals"]',
      title: 'Check-in and check-out',
      body: 'Every reservation due to arrive shows up here on its check-in date. Checking a guest in verifies their ID and hands over the room; checking out settles the folio balance and releases the room to Housekeeping as dirty — no need to open the full reservation for either.',
    },
  },
  {
    key: 'housekeeping',
    to: '/housekeeping',
    roles: ['ADMIN', 'MANAGER', 'FRONT_DESK', 'HOUSEKEEPING_MAINTENANCE'],
    title: 'Map & Housekeeping',
    body: 'The room map — every room, color-coded by status. Click a room to update it, log a work order, or launch an inspection.',
    process: {
      target: '[data-tour="tour-process-housekeeping"]',
      title: 'The room status workflow',
      body: 'A room moves Dirty → Clean → Inspected before it can be sold again: check-out leaves it Dirty, an attendant marks it Clean once serviced, and it needs an Inspection sign-off before the front desk can assign it to the next guest.',
    },
  },
  {
    key: 'rooms',
    to: '/rooms',
    roles: ['ADMIN', 'MANAGER'],
    title: 'Hotel Rooms',
    body: 'Property configuration, not day-to-day operations: room types, individual rooms, and promo codes are defined here. A change here — a new room, a retired room type, a discontinued promo code — affects availability and pricing everywhere else in the app, from the Calendar to a brand-new booking.',
  },
  {
    key: 'amenities',
    to: '/amenities',
    roles: ['ADMIN', 'MANAGER', 'FRONT_DESK'],
    title: 'Amenities & Facilities',
    body: "Manage bookable shared spaces — function halls, meeting rooms, and similar facilities — and take bookings for them the same way you'd book a room, including their own charges on a guest's folio.",
  },
  {
    key: 'reports',
    to: '/reports',
    roles: ['ADMIN', 'MANAGER', 'AUDITOR'],
    title: 'Reports & Revenue',
    body: 'Occupancy, revenue, and operational reports for the property over a date range you control. Use these to catch a trend before it shows up as a problem at the front desk.',
  },
  {
    // Gated on 'reports', not 'audit': Night Audit no longer has its own
    // catalogue key (see the _mergeComment on navSections.json's "reports"
    // item) — hasSection('audit') would return false forever and this step
    // would silently vanish from the tour.
    key: 'reports',
    to: '/audit',
    roles: ['ADMIN', 'MANAGER', 'AUDITOR'],
    title: 'Night Audit',
    body: 'Closes out the current business day. Run it once, after every arrival and departure due today has been processed.',
    process: {
      target: '[data-tour="tour-process-audit"]',
      title: 'Running the audit',
      body: "This one action does five things: posts a room charge to every in-house folio, totals the day's sales across rooms and amenities, marks unarrived confirmed bookings as no-show, auto-cancels overdue unconfirmed bookings, and rolls the property's date forward to the next day.",
    },
  },
  {
    key: 'room-layouts',
    to: '/room-layouts',
    roles: ['ADMIN'],
    title: 'Room & Scenario Editor',
    body: 'Design the 3D room layouts and grading scenarios used in staff training — what trainees walk through and get scored against, not a guest-facing feature.',
  },
  {
    key: 'users',
    to: '/users',
    roles: ['ADMIN', 'MANAGER'],
    title: 'Users & Roles',
    body: 'Create staff logins, assign the roles that control what each person can see and do throughout the app, and approve or deny access requests submitted from the sign-in page.',
  },
  {
    key: 'health',
    to: '/health',
    roles: ['ADMIN'],
    title: 'Service Health',
    body: "A live status board for every backend service this app depends on — check here first when something isn't working, to see whether it's one service or all of them.",
  },
  {
    key: 'settings',
    to: '/settings',
    core: true,
    title: 'Settings',
    body: 'Your account, the hotel profile, and appearance preferences live here — including which sidebar sections each role can see, and the icon in the topbar that replays this tour.',
  },
];

// A sentinel, not a real selector: page steps need an ORDERED fallback
// chain (try `.page-head`, else the first heading, else the whole content
// region), and a comma-separated CSS selector can't express that — it
// resolves in DOCUMENT order, so `.cb-main` — the ANCESTOR of every other
// candidate here — would always win, having appeared first in the tree.
// See resolveTarget().
const PAGE_TARGET = '__page-heading__';

// Every page in PAGES renders its title through one of these — see the file
// header. Falling back to `.cb-main` itself means a step never has nothing
// to point at, even if some future page uses none of them.
function resolveTarget(target) {
  if (!target) return null;
  if (target === PAGE_TARGET) {
    return (
      document.querySelector('.page-head') ||
      document.querySelector('.cb-main h1') ||
      document.querySelector('.cb-main h2') ||
      document.querySelector('.cb-main h3') ||
      document.querySelector('.cb-main')
    );
  }
  return document.querySelector(target);
}

// A chrome target can EXIST while being irrelevant — the permanent sidebar
// and the phone tab bar are both always in the DOM (see the file header on
// CHROME_STEPS) with CSS `display: none` hiding whichever one the current
// width doesn't use. A plain querySelector match would still highlight it —
// as a zero-size ring in the corner of the screen, since a display:none
// element's rect is all zeroes. Checking the rect itself, not just presence,
// is what tells "exists" apart from "exists but hidden right now".
function isVisibleTarget(target) {
  const el = resolveTarget(target);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

const INTRO_STEP = {
  target: null,
  title: 'Welcome to InnSight PMS',
  body: "Here's a full tour — the app's shell, then every page you have access to. Skip anytime, and replay it later from your account menu.",
};

const OUTRO_STEP = {
  target: null,
  title: "You're all set",
  body: 'Replay this tour anytime from the sparkle icon in the topbar.',
};

const HOLE_PAD = 8;
const POP_W = 320;
const MEASURE_RETRIES = 30; // ~1.5s at 50ms apart — long enough for a route change plus first paint.
const MEASURE_INTERVAL_MS = 50;

// The app renders at `zoom: 0.7` (0.9 on phones) (see the note on `html` in styles.css). A
// DOMRect from getBoundingClientRect() already comes back in real, post-zoom
// screen pixels — but every element THIS component positions (the mask, the
// ring, the popover) is itself a descendant of that zoomed `html`, so the
// browser zooms it AGAIN when it renders our inline `top`/`left`/`width`/
// `height`. Left uncorrected, a target at real screen x=1545 gets a ring
// painted at 1545 * 0.7 ≈ 1082 — visibly pointing at the wrong element.
// Dividing by the zoom factor before handing a number to `style` cancels that
// second pass out, so the ring ends up back at the real, measured position.
function getZoomFactor() {
  const z = parseFloat(getComputedStyle(document.documentElement).zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

function computePopStyle(rect, zoom) {
  if (!rect) {
    return { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
  }
  // A target spanning most of the viewport's height (the sidebar) can't
  // sensibly be pointed at from "below" — the popover would land off-screen.
  // Anchor it to the side instead.
  const isTall = rect.height > window.innerHeight * 0.5;
  if (isTall) {
    return {
      position: 'fixed',
      top: Math.min(120, Math.max(HOLE_PAD, window.innerHeight - 280)) / zoom,
      left: Math.min(rect.right + 16, window.innerWidth - POP_W - HOLE_PAD) / zoom,
    };
  }
  const spaceBelow = window.innerHeight - rect.bottom;
  const top = spaceBelow > 240 ? rect.bottom + 16 : Math.max(HOLE_PAD, rect.top - 236);
  const left = Math.min(Math.max(HOLE_PAD, rect.left), window.innerWidth - POP_W - HOLE_PAD);
  return { position: 'fixed', top: top / zoom, left: left / zoom };
}

// `guideSteps` turns this into a single-page walkthrough: when given, those steps
// are used as-is instead of the app-wide chrome + every-page tour. A step is
//   { target?: CSS selector, title, body, try?: string }
// `target` may be omitted (centred card) or match nothing on screen (the same
// centred card — a guide never breaks because a control is absent for this
// role or this data). `try` makes the step INTERACTIVE: the highlighted control
// is left clickable, the card shows the instruction, and clicking the control
// moves on by itself. Reserve it for safe, reversible actions (open a filter,
// switch a tab) — never for anything that writes data.
export default function TutorialTour({ open, onFinish, guideSteps }) {
  const { hasRole, hasSection } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState(null);

  // Snapshotted once per tour OPEN, not on every render — hasRole/hasSection
  // are new function identities every render of AuthProvider, and re-deriving
  // the list on every keystroke elsewhere in the app would be wasted work for
  // a role that cannot change mid-tour anyway.
  const steps = useMemo(() => {
    if (!open) return [];
    if (guideSteps) return guideSteps;
    // Matches styles.css's own phone breakpoint (.mobile-tabbar's @media
    // (max-width: 640px)) exactly — this has to agree with the CSS or the
    // sidebar-vs-tab-bar choice below picks the one that's actually hidden.
    const isPhone = window.innerWidth <= 640;
    const chrome = CHROME_STEPS.map((s) => {
      const target = isPhone && s.phoneTarget ? s.phoneTarget : s.target;
      return {
        target,
        title: isPhone && s.phoneTitle ? s.phoneTitle : s.title,
        body: isPhone && s.phoneBody ? s.phoneBody : s.body,
      };
    }).filter((s) => !s.target || isVisibleTarget(s.target));
    const pages = PAGES.filter(
      (p) => (!p.roles || hasRole(...p.roles)) && (p.core || hasSection(p.key))
    ).flatMap((p) => {
      const overview = { path: p.to, target: PAGE_TARGET, title: p.title, body: p.body };
      // The process sub-step stays on the SAME page (no extra navigation) —
      // it's a second thing to look at on a page we're already on, not a
      // second destination.
      if (!p.process) return [overview];
      return [
        overview,
        { path: p.to, target: p.process.target, title: p.process.title, body: p.process.body },
      ];
    });
    return [INTRO_STEP, ...chrome, ...pages, OUTRO_STEP];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, guideSteps]);

  useEffect(() => {
    if (open) setIndex(0);
  }, [open, guideSteps]);

  const step = steps[index];

  // Drive navigation from the step itself, not from the Next/Back handlers —
  // so both directions, and the initial step, all funnel through one path
  // instead of three copies of "and also navigate".
  useEffect(() => {
    if (!open || !step?.path) return;
    if (location.pathname !== step.path) navigate(step.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step]);

  useEffect(() => {
    if (!open || !step?.target) {
      setRect(null);
      return undefined;
    }
    let cancelled = false;
    let tries = 0;
    setRect(null);
    function attempt() {
      if (cancelled) return;
      const el = resolveTarget(step.target);
      if (el) {
        // A control further down a long page would be highlighted off-screen.
        const r0 = el.getBoundingClientRect();
        if (r0.bottom > window.innerHeight || r0.top < 0) el.scrollIntoView({ block: 'center' });
        setRect(el.getBoundingClientRect());
        return;
      }
      // A page step's target only exists once the route we just asked for has
      // actually mounted, which is a beat behind this effect firing — retry
      // rather than give up on the first miss.
      tries += 1;
      if (tries < MEASURE_RETRIES) setTimeout(attempt, MEASURE_INTERVAL_MS);
    }
    attempt();
    function remeasure() {
      const el = resolveTarget(step.target);
      if (!el) return;
      const r = el.getBoundingClientRect();
      // Keep the previous state object when nothing moved, so the per-frame
      // poll below doesn't re-render the tour 60 times a second.
      setRect((prev) =>
        prev && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height
          ? prev
          : r
      );
    }
    window.addEventListener('resize', remeasure);
    window.addEventListener('scroll', remeasure, true);
    // The topbar reflows AFTER the first measurement (greeting text, the live
    // badge and the user's name all settle late), which left the ring parked
    // where the target used to be. Following the target every frame keeps the
    // ring on it no matter what moves it.
    let raf = requestAnimationFrame(function tick() {
      remeasure();
      raf = requestAnimationFrame(tick);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('scroll', remeasure, true);
    };
  }, [open, step, location.pathname]);

  // Interactive step: the user performs the action on the real control and the
  // tour follows. Capture phase, so it still fires if the control stops the
  // event from bubbling.
  const stepIndex = index;
  useEffect(() => {
    if (!open || !step?.try || !step.target) return undefined;
    let timer;
    function onClick(e) {
      const el = resolveTarget(step.target);
      if (el && el.contains(e.target)) {
        timer = setTimeout(() => setIndex((i) => (i === stepIndex ? i + 1 : i)), 300);
      }
    }
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, stepIndex]);

  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key === 'Escape') onFinish?.();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onFinish]);

  if (!open || !step) return null;

  const isFirst = index === 0;
  const isLast = index === steps.length - 1;
  const next = () => (isLast ? onFinish?.() : setIndex((i) => i + 1));
  const back = () => setIndex((i) => Math.max(0, i - 1));

  // Every number below is a real, post-zoom screen pixel (that's what rect —
  // a getBoundingClientRect() result — already is). Dividing by the zoom
  // factor here, right where each value becomes a `style` prop, is what
  // keeps the browser's own zoom on `html` from applying a second time. See
  // getZoomFactor()'s comment for why that second pass would otherwise happen.
  const zoom = getZoomFactor();
  const z = (n) => n / zoom;

  return (
    <div className="tour-overlay">
      {rect ? (
        <>
          <div
            className="tour-mask"
            style={{ top: 0, left: 0, right: 0, height: z(Math.max(0, rect.top - HOLE_PAD)) }}
          />
          <div className="tour-mask" style={{ top: z(rect.bottom + HOLE_PAD), left: 0, right: 0, bottom: 0 }} />
          <div
            className="tour-mask"
            style={{
              top: z(rect.top - HOLE_PAD),
              left: 0,
              width: z(Math.max(0, rect.left - HOLE_PAD)),
              height: z(rect.height + HOLE_PAD * 2),
            }}
          />
          <div
            className="tour-mask"
            style={{
              top: z(rect.top - HOLE_PAD),
              left: z(rect.right + HOLE_PAD),
              right: 0,
              height: z(rect.height + HOLE_PAD * 2),
            }}
          />
          {/* No background of its own — it exists to CAPTURE clicks over the
              one part of the screen the masks leave uncovered, so nothing on
              the real page underneath (a button in a page's title bar, say)
              is reachable while the tour has focus. */}
          <div
            className="tour-ring"
            style={{
              pointerEvents: step.try ? 'none' : undefined,
              top: z(rect.top - HOLE_PAD),
              left: z(rect.left - HOLE_PAD),
              width: z(rect.width + HOLE_PAD * 2),
              height: z(rect.height + HOLE_PAD * 2),
            }}
          />
        </>
      ) : (
        <div className="tour-mask" style={{ inset: 0 }} />
      )}

      <div className="tour-pop" style={computePopStyle(rect, zoom)}>
        <div className="tour-pop-head">
          <span className="tour-step-count">
            {index + 1} of {steps.length}
          </span>
          <button type="button" className="modal-close" onClick={() => onFinish?.()} aria-label="Skip tour">
            <Icon name="x" size={16} />
          </button>
        </div>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        {step.try && (
          <p className="tour-try">
            <Icon name="mouse-pointer" size={13} strokeWidth={2} /> Try it: {step.try}
          </p>
        )}
        <div className="tour-pop-actions">
          <button type="button" className="btn-ghost" onClick={() => onFinish?.()}>
            Skip
          </button>
          <div className="tour-pop-nav">
            {!isFirst && (
              <button type="button" className="btn-ghost" onClick={back}>
                Back
              </button>
            )}
            <button type="button" onClick={next}>
              {isLast ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
