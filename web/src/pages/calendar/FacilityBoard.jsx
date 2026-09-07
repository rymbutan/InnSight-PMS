// Facilities x days — the same board as the reservation calendar, for spaces
// instead of rooms.
//
// It shares CalendarShell with the room board, so the two are the same object
// visually: the same sticky rail, the same day header, the same scroll region,
// the same legend strip. What differs is inside the cells, and it differs for a
// real reason — a room booking is a run of whole nights, a facility booking is
// a slot with a clock time. See lib/facilityBars.js for the geometry.
//
// READ-ONLY, DELIBERATELY
// -----------------------
// The room board lets you drag a stay to new dates because the server has an
// endpoint that revalidates availability on the move. There is no equivalent
// for a facility booking: a slot is protected by FacilitySlotLock rows written
// in the same transaction that created it, and moving one means deleting and
// rewriting those locks. Faking a drag that then fails, or worse silently
// double-books a hall, is worse than not offering it. Clicking a bar opens the
// facility desk, which is where a booking is actually changed or cancelled.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api';
import { useToast, errMsg } from '../../components/Toast';
import { useLiveRefresh, channels } from '../../lib/useLiveEvents';
import { localDay, startOfDay, addDays } from '../../lib/date';
import { formatPeso } from '../../lib/money';
import { assignSlots, colorFor, guestKey, inkOn } from '../../lib/guestColors';
import { buildFacilityBars } from '../../lib/facilityBars';
import { useTheme } from '../../theme';
import CalendarShell from '../../components/CalendarShell';
import Icon from '../../components/Icon';

// One lane is a bar plus the gap under it. The cell has to be tall enough for
// every lane in its row, or a stacked booking is drawn outside its own row.
const LANE_H = 22;
const LANE_PAD = 8;

function hhmm(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function durationLabel(minutes) {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * @param {object} p
 * @param {Date} p.startDate  local midnight of the first column
 * @param {Date[]} p.days     the columns themselves
 */
export default function FacilityBoard({ startDate, days }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [facilities, setFacilities] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState({});
  const [popover, setPopover] = useState(null);

  async function load({ live = false } = {}) {
    if (!live) setLoading(true);
    try {
      // The window in full days. `from`/`to` filter on startAt, so a booking
      // that STARTED the night before and runs past midnight into the first
      // column would be missed by an exact-bounds query — hence a day of lead
      // in. buildFacilityBars clips it back to the window when it draws it.
      const from = `${localDay(addDays(startDate, -1))}T00:00:00`;
      const to = `${localDay(addDays(startDate, days.length - 1))}T23:59:59`;
      const [f, b] = await Promise.all([
        api.get('/api/facilities'),
        api.get(`/api/facility-bookings?from=${from}&to=${to}`),
      ]);
      setFacilities(f.data || []);
      setBookings(b.data || []);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, [startDate]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live scope — this board is facilities and their bookings, nothing else.
  useLiveRefresh(() => load({ live: true }), { channels: channels('facilities') });

  const todayStr = localDay(new Date());

  /* Rows: only spaces that can actually hold a booking. A walk-in-only amenity
     (a laundry service, a bottle of water) has no time slot to draw, so a row
     for it would be permanently empty — the board would be mostly blank and
     the reservable spaces would be lost in it. They are reachable in full on
     the Amenities page; this is the schedule. */
  const rows = useMemo(() => facilities.filter((f) => f.reservable && f.active), [facilities]);

  /* Grouped by category, mirroring the room board's grouping by room type. */
  const grouped = useMemo(() => {
    const byCat = new Map();
    for (const f of rows) {
      const k = f.category || 'OTHER';
      if (!byCat.has(k)) byCat.set(k, []);
      byCat.get(k).push(f);
    }
    return [...byCat.entries()].map(([code, items]) => ({ code, items }));
  }, [rows]);

  const { byFacility, lanesByFacility, unplaced } = useMemo(
    () => buildFacilityBars({ bookings, facilities: rows, days }),
    [bookings, rows, days]
  );

  /* One colour per guest, the same rule as the room board: a wall of identical
     green tells you nothing, and who the booking is for is what a desk tracks. */
  const { theme } = useTheme();
  const dark = theme === 'dark';
  const guestSlots = useMemo(() => {
    const keys = [];
    for (const bars of Object.values(byFacility)) for (const b of bars) keys.push(guestKey(b));
    return assignSlots(keys);
  }, [byFacility]);

  /* The day header's third line. Occupancy in rooms means "% of rooms sold";
     for facilities the equivalent honest number is how many slots are booked —
     spaces have no single denominator, since a hall can hold six bookings in a
     day and a tennis court twelve. */
  function dayCount(day) {
    const start = startOfDay(day).getTime();
    const end = startOfDay(addDays(day, 1)).getTime();
    let n = 0;
    for (const bars of Object.values(byFacility)) {
      for (const b of bars) {
        if (new Date(b.startAt).getTime() < end && new Date(b.endAt).getTime() > start) n++;
      }
    }
    return n ? `${n} slot${n === 1 ? '' : 's'}` : '—';
  }

  function onCellClick(e, facility, day) {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setPopover({
      x: rect.left + rect.width / 2,
      y: rect.bottom + 4,
      code: facility.code,
      name: facility.name,
      day: localDay(day),
    });
  }

  /* Booking happens on the facility desk, which owns the guest-type branch, the
     folio lookup and the price preview. Sending the chosen space and day across
     means the desk opens on the right row rather than making the user find it. */
  function bookHere() {
    if (!popover) return;
    navigate(`/amenities?book=1&facility=${encodeURIComponent(popover.code)}&date=${popover.day}`);
    setPopover(null);
  }

  return (
    <div onClick={() => setPopover(null)}>
      <CalendarShell
        days={days}
        cornerLabel="Facility"
        colMin={140}
        loading={loading}
        daySub={dayCount}
        hint="Click an empty cell to book that space · Click a slot to open the facility desk"
        toolbarExtra={
          /* Same guarantee the room board makes: a booking that cannot be drawn
             is reported, never silently absent. This one happens when a space is
             deactivated or made walk-in-only while it still has bookings on the
             books. */
          unplaced.length > 0 && (
            <span
              className="cal2-unassigned"
              title={`These spaces are no longer bookable, so they have no row:\n${unplaced
                .map(
                  (b) =>
                    `${b.facilityName || 'Facility'} · ${b.label} · ${new Date(b.startAt).toLocaleString()}`
                )
                .join('\n')}`}
            >
              <Icon name="alert-circle" size={12} style={{ marginRight: 4 }} />
              {unplaced.length} on a closed space
            </span>
          )
        }
        legend={
          <>
            <span className="cal2-legend-note">
              Each guest has their own colour · a bar spans the hours it is booked for
            </span>
            <span>
              <span className="swatch stripe st-confirmed" /> Confirmed
            </span>
            <span style={{ marginLeft: 'auto' }} className="muted">
              Cancelled bookings release their space and are not shown
            </span>
          </>
        }
      >
        {rows.length === 0 && !loading && (
          <div className="cal2-empty" style={{ gridColumn: `1 / span ${days.length + 1}` }}>
            No reservable spaces yet. Mark an amenity <strong>Reservable</strong> on the Amenities page and it
            will get a row here.
          </div>
        )}

        {grouped.map((g) => {
          const isCollapsed = collapsed[g.code];
          return (
            <div key={g.code} style={{ display: 'contents' }}>
              {/* Category summary row, the counterpart of the room-type row. */}
              <div className="cal2-room type-row">
                <button
                  className="icon"
                  style={{ padding: 0, color: 'var(--muted)' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setCollapsed({ ...collapsed, [g.code]: !isCollapsed });
                  }}
                  aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                >
                  <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={12} />
                </button>
                <span style={{ marginLeft: 4 }}>{g.code.replace(/_/g, ' ')}</span>
              </div>
              {days.map((d) => {
                // How many of this category's spaces have nothing on them that
                // day — the same "what can I still sell" question the room
                // board's free-rooms count answers.
                const start = startOfDay(d).getTime();
                const end = startOfDay(addDays(d, 1)).getTime();
                const free = g.items.filter(
                  (f) =>
                    !(byFacility[f.id] || []).some(
                      (b) => new Date(b.startAt).getTime() < end && new Date(b.endAt).getTime() > start
                    )
                ).length;
                return (
                  <div
                    key={localDay(d)}
                    className="cal2-day"
                    style={{ background: 'var(--surface-2)', textAlign: 'center', padding: '8px 4px' }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{free}</div>
                    <div style={{ fontSize: 10, color: 'var(--muted)' }}>free</div>
                  </div>
                );
              })}

              {!isCollapsed &&
                g.items.map((f) => {
                  const bars = byFacility[f.id] || [];
                  const lanes = lanesByFacility[f.id] || 1;
                  const cellHeight = LANE_PAD + lanes * LANE_H;
                  return (
                    <div key={f.id} style={{ display: 'contents' }}>
                      <div className="cal2-room" title={f.description || f.name}>
                        <span className="cal2-fac-name">{f.name}</span>
                        {f.capacity ? <span className="cal2-fac-cap">{f.capacity}p</span> : null}
                      </div>
                      {days.map((d, idx) => (
                        <div
                          key={localDay(d)}
                          className={`cal2-cell ${localDay(d) === todayStr ? 'today' : ''}`}
                          style={{ minHeight: cellHeight }}
                          onClick={(e) => onCellClick(e, f, d)}
                        >
                          {bars
                            .filter((b) => b.startCol === idx)
                            .map((b) => {
                              const slot = guestSlots.get(guestKey(b));
                              const fill = slot === undefined ? null : colorFor(slot, dark);
                              const cls = [
                                'cal2-bar',
                                'cal2-bar--slot',
                                'guest',
                                b.status,
                                b.continuesBefore ? 'clip-start' : '',
                                b.continuesAfter ? 'clip-end' : '',
                              ]
                                .filter(Boolean)
                                .join(' ');
                              return (
                                <div
                                  key={b.key}
                                  className={cls}
                                  style={{
                                    // Percentages resolve against this cell, and a
                                    // cell is exactly one day — so a 09:00 start is
                                    // 37.5% in and three hours is 12.5% wide, at any
                                    // column width the grid happens to compute.
                                    left: `${b.offset * 100}%`,
                                    width: `${b.width * 100}%`,
                                    top: 4 + b.lane * LANE_H,
                                    ...(fill ? { background: fill, color: inkOn(fill) } : {}),
                                  }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    // The specific booking, not just the desk.
                                    // Clicking a bar and landing on a generic
                                    // Amenities page left the user to find the
                                    // row again by eye. The date goes with it so
                                    // the schedule opens on the right day —
                                    // localDay, not toISOString, because a bar
                                    // that starts in the local evening is
                                    // yesterday in UTC.
                                    navigate(
                                      `/amenities?booking=${encodeURIComponent(b.id)}` +
                                        `&date=${localDay(new Date(b.startAt))}`
                                    );
                                  }}
                                  title={
                                    `${b.label} · ${f.name}\n` +
                                    `${new Date(b.startAt).toLocaleDateString()} ${hhmm(b.startAt)} – ${hhmm(b.endAt)} (${durationLabel(b.minutes)})\n` +
                                    `${b.persons} person${b.persons === 1 ? '' : 's'} · ${formatPeso(b.priceCents)}` +
                                    (b.folioId ? ' · on a folio' : '')
                                  }
                                >
                                  <span className={`cal2-bar-stripe st-${b.status}`} />
                                  <span className="cal2-slot-time">{hhmm(b.startAt)}</span>
                                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {b.label}
                                  </span>
                                </div>
                              );
                            })}
                        </div>
                      ))}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </CalendarShell>

      {popover && (
        <div
          className="cal2-popover"
          style={{ left: popover.x - 100, top: popover.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ marginBottom: 8 }}>
            <strong>{popover.name}</strong> · {popover.day}
          </div>
          <button className="btn-cta" style={{ width: '100%' }} onClick={bookHere}>
            <Icon name="plus" size={14} style={{ marginRight: 6 }} />
            Book this space
          </button>
        </div>
      )}
    </div>
  );
}
