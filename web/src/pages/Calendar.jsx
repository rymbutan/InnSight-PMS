// The calendar page: one date window, two boards.
//
// WHY THE BOARDS ARE SEPARATE COMPONENTS
// --------------------------------------
// Not for tidiness — for state. Each board owns its own fetch, its own live
// subscription and its own filters, and switching views UNMOUNTS the other one.
// That is the isolation: no stale reservations sitting behind the facility
// grid, no SSE subscription still repainting a board nobody is looking at, and
// no chance of one view's loading flag or popover leaking into the other.
//
// The date window is the one thing they share, and it lives here because the
// Prev/Today/Next controls are in the page head above both. Picking a week on
// one board and switching lands on the same week — the alternative, snapping
// back to today on every switch, makes the switcher feel like a page load.

import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth';
import { addDays, startOfDay } from '../lib/date';
import { CalendarNav } from '../components/CalendarShell';
import Icon from '../components/Icon';
import ReservationBoard from './calendar/ReservationBoard';
import FacilityBoard from './calendar/FacilityBoard';

const DAYS = 14;

// Everything about a view in one place, so adding a third is a row here rather
// than another branch in the JSX.
const VIEWS = {
  rooms: {
    label: 'Hotel Reservations',
    icon: 'bed',
    cta: { label: 'Create New Reservation', icon: 'plus', to: '/reservations/new' },
  },
  facilities: {
    label: 'Facility Bookings',
    icon: 'sparkles',
    // The facility desk is on the Amenities page, and deliberately stays there:
    // it owns the hotel-guest / walk-in branch, the folio lookup and the live
    // price preview. `book=1` scrolls it into view on arrival.
    cta: { label: 'Book a Facility', icon: 'plus', to: '/amenities?book=1' },
    // GET /api/facility-bookings is DESK-only and /amenities is closed to
    // housekeeping, so offering this tab to them would be a tab that 403s and a
    // button that lands on a page they cannot open.
    roles: ['ADMIN', 'MANAGER', 'FRONT_DESK'],
  },
};

export default function CalendarPage() {
  const navigate = useNavigate();
  const { hasRole } = useAuth();
  const [params, setParams] = useSearchParams();
  const [startDate, setStartDate] = useState(startOfDay(new Date()));

  const tabs = useMemo(
    () => Object.entries(VIEWS).filter(([, v]) => !v.roles || hasRole(...v.roles)),
    [hasRole]
  );

  // The view lives in the URL so it survives a reload and can be linked to.
  // Falling back rather than trusting the param matters: ?view=facilities from
  // a shared link must not hand a housekeeper a board they cannot load.
  const requested = params.get('view');
  const view = tabs.some(([k]) => k === requested) ? requested : tabs[0][0];
  const active = VIEWS[view];

  function switchTo(key) {
    if (key === view) return;
    const next = new URLSearchParams(params);
    next.set('view', key);
    // Replace, not push: flipping a tab back and forth should not fill the back
    // button with calendar states the user has to click through.
    setParams(next, { replace: true });
  }

  const days = useMemo(() => Array.from({ length: DAYS }, (_, i) => addDays(startDate, i)), [startDate]);

  return (
    <div>
      <div className="page-head">
        <h1>Calendar</h1>
        <div className="cal-head-actions">
          {tabs.length > 1 && (
            <div className="seg" role="tablist" aria-label="Calendar view">
              {tabs.map(([key, v]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={view === key}
                  className={view === key ? 'is-on' : ''}
                  onClick={() => switchTo(key)}
                >
                  <Icon name={v.icon} size={14} />
                  {v.label}
                </button>
              ))}
            </div>
          )}
          <CalendarNav startDate={startDate} setStartDate={setStartDate} />
          <button className="btn-cta" onClick={() => navigate(active.cta.to)}>
            <Icon name={active.cta.icon} size={14} style={{ marginRight: 6 }} />
            {active.cta.label}
          </button>
        </div>
      </div>

      {view === 'facilities' ? (
        <FacilityBoard startDate={startDate} days={days} />
      ) : (
        <ReservationBoard startDate={startDate} days={days} />
      )}
    </div>
  );
}
