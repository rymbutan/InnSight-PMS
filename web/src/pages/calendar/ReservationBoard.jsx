import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api';
import { useToast, errMsg } from '../../components/Toast';
import { useLiveRefresh, channels } from '../../lib/useLiveEvents';
import { localDay } from '../../lib/date';
import { formatPeso } from '../../lib/money';
import { assignSlots, colorFor, guestKey, inkOn } from '../../lib/guestColors';
import { buildBars, barAt, reservationIdForBar } from '../../lib/calendarBars';
import { useTheme } from '../../theme';
import CalendarShell from '../../components/CalendarShell';
import Icon from '../../components/Icon';
import { statusMeta } from '../../sim/statusMeta';

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function isoDay(d) {
  return localDay(d);
}
function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * Rooms x nights. The date window is owned by the page above, so switching to
 * the facility board and back lands on the same week.
 *
 * @param {object} p
 * @param {Date} p.startDate  local midnight of the first column
 * @param {Date[]} p.days     the columns themselves
 */
export default function ReservationBoard({ startDate, days }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [rooms, setRooms] = useState([]);
  const [types, setTypes] = useState([]);
  const [reservations, setReservations] = useState([]);
  const [stays, setStays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState({});
  const [popover, setPopover] = useState(null); // { x, y, roomId, day }
  const [drag, setDrag] = useState(null); // active drag state
  const [_previewBar, setPreviewBar] = useState(null);
  const gridRef = useRef(null);
  // Set when a live event is suppressed because a drag was in progress.
  const staleWhileDragging = useRef(false);

  // `live` marks a reload triggered by an SSE event rather than by the user.
  // Those must refresh in place: showing the skeleton meant the whole calendar
  // blanked every time anyone anywhere in the hotel touched anything.
  async function load({ live = false } = {}) {
    // Never pull the rug out from under an in-progress drag. A live reload
    // mid-drag replaced the bar the user was holding with the server's copy of
    // it, so the drop landed on stale geometry. Defer instead — the effect below
    // reloads as soon as the drag finishes.
    if (live && drag) {
      staleWhileDragging.current = true;
      return;
    }
    if (!live) setLoading(true);
    try {
      // The exact window. The old ±1 day of padding existed because the server
      // filtered on checkIn alone and the padding was a (failed) attempt to
      // catch stays that began just before it; GET /api/reservations now
      // answers with a proper overlap test, so the true bounds are correct.
      const from = isoDay(startDate);
      const to = isoDay(addDays(startDate, days.length));
      const [r, t, res, sh] = await Promise.all([
        api.get('/api/rooms'),
        api.get('/api/room-types'),
        api.get(`/api/reservations?from=${from}&to=${to}`),
        api.get('/api/in-house'),
      ]);
      setRooms(r.data);
      setTypes(t.data);
      setReservations(res.data);
      setStays(sh.data);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, [startDate]);
  // Live: repaint the calendar when reservations/stays/rooms change elsewhere.
  // Live scope — the grid is rooms x nights, drawn from reservations and in-house stays.
  // A folio charge or a guest profile edit changes nothing here.
  const { connected: liveConnected } = useLiveRefresh(load, {
    channels: channels('reservations', 'stays', 'rooms'),
  });

  // Pick up any live change that arrived while the user was mid-drag.
  useEffect(() => {
    if (!drag && staleWhileDragging.current) {
      staleWhileDragging.current = false;
      load({ live: true });
    }
  }, [drag]);

  const todayStr = isoDay(new Date());

  /* Group rooms by type, keep an order matching `types` */
  const grouped = useMemo(() => {
    const byType = {};
    for (const r of rooms) {
      const k = r.typeCode || 'OTHER';
      (byType[k] = byType[k] || []).push(r);
    }
    return types.map((t) => ({ type: t, rooms: byType[t.code] || [] })).filter((g) => g.rooms.length || true);
  }, [rooms, types]);

  /* Bars, from the tested transform in lib/calendarBars.js.
     `unassigned` is every booking in this window that has no room to sit on.
     The old code skipped those with `continue`, which is what made a saved
     reservation invisible; surfacing the count means it can never go quiet
     again even if room assignment fails. */
  const { byRoom: barsByRoom, unassigned } = useMemo(
    () => buildBars({ reservations, stays, rooms, days }),
    [reservations, stays, rooms, days]
  );

  /* ── One colour per guest ──────────────────────────────────────────────────
     Colour used to mean reservation status, so a week where nothing had happened
     yet was a wall of identical green. It identifies the GUEST now — the thing a
     front-desk user tracks across rooms and days — and status moved to the
     stripe on the bar's left edge.

     Assigned over every bar on the board at once, so no two guests visible
     together share a colour while there are slots left. */
  const { theme } = useTheme();
  // The palette is SELECTED per mode, not flipped: the dark steps were chosen
  // and validated against the dark surface.
  const dark = theme === 'dark';

  const guestSlots = useMemo(() => {
    const keys = [];
    for (const bars of Object.values(barsByRoom)) {
      for (const b of bars) {
        // An out-of-order block is a room state, not a guest: it keeps its own
        // red and must not consume a colour slot.
        if (b.status !== 'ooo') keys.push(guestKey(b));
      }
    }
    return assignSlots(keys);
  }, [barsByRoom]);

  /* Per-day occupancy % across all rooms */
  function dayOccupancy(day) {
    if (!rooms.length) return 0;
    const _ds = isoDay(day);
    const busyRooms = new Set();
    for (const [roomId, bars] of Object.entries(barsByRoom)) {
      for (const b of bars) {
        const ci = startOfDay(new Date(b.ci));
        const co = startOfDay(new Date(b.co));
        if (ci <= day && day < co) busyRooms.add(roomId);
      }
    }
    return (busyRooms.size / rooms.length) * 100;
  }

  /* ----- Drag & drop ----- */
  function onBarMouseDown(e, bar, kind) {
    e.preventDefault();
    e.stopPropagation();
    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    const cellRect = gridRef.current.querySelector('.cal2-cell')?.getBoundingClientRect();
    const colWidth = cellRect ? cellRect.width : 92;
    const rowHeight = cellRect ? cellRect.height : 32;
    setDrag({ bar, kind, startMouseX, startMouseY, colWidth, rowHeight, deltaCols: 0, deltaRows: 0 });
  }

  useEffect(() => {
    if (!drag) return;
    const onMove = (e) => {
      const dx = e.clientX - drag.startMouseX;
      const dy = e.clientY - drag.startMouseY;
      const deltaCols = Math.round(dx / drag.colWidth);
      const deltaRows = drag.kind === 'move' ? Math.round(dy / drag.rowHeight) : 0;
      setDrag((d) => ({ ...d, deltaCols, deltaRows }));
      setPreviewBar({ ...drag.bar, deltaCols, deltaRows, kind: drag.kind });
    };
    const onUp = async () => {
      const d = drag;
      setDrag(null);
      setPreviewBar(null);
      if (!d) return;
      if (d.kind === 'resize' && d.deltaCols !== 0) {
        // change checkout date by deltaCols
        const newCo = isoDay(addDays(new Date(d.bar.co), d.deltaCols));
        await applyDateChange(d.bar, null, newCo);
      } else if (d.kind === 'move' && (d.deltaCols !== 0 || d.deltaRows !== 0)) {
        // shift dates by deltaCols and possibly change room
        const newCi = isoDay(addDays(new Date(d.bar.ci), d.deltaCols));
        const newCo = isoDay(addDays(new Date(d.bar.co), d.deltaCols));
        const newRoomId = d.deltaRows ? findRoomByOffset(d.bar.roomId, d.deltaRows) : null;
        await applyDateChange(d.bar, newCi, newCo, newRoomId);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drag, rooms]);

  function findRoomByOffset(currentRoomId, offset) {
    // Flatten rooms grouped by visible order
    const flat = grouped.flatMap((g) => g.rooms);
    const idx = flat.findIndex((r) => r.id === currentRoomId);
    if (idx < 0) return null;
    const target = flat[idx + offset];
    return target?.id || null;
  }

  async function applyDateChange(bar, newCheckIn, newCheckOut, newRoomId) {
    // OPTIMISTIC. The bar stays where the user dropped it while the write is in
    // flight. It used to snap back to its old position and then jump again when
    // a four-request reload landed, which read as the drag having failed.
    //
    // The snapshot is the rollback: a rejected write (no availability for the
    // new dates, the target room already promised) must not leave the board
    // showing a move the server refused.
    const rollback = { reservations, stays };
    const isReservation = bar.key.startsWith('res-');
    const id = isReservation ? bar.key.slice(4) : bar.key.slice(5);

    if (isReservation) {
      setReservations((list) =>
        list.map((r) =>
          r.id === id
            ? {
                ...r,
                ...(newCheckIn ? { checkIn: newCheckIn } : {}),
                ...(newCheckOut ? { checkOut: newCheckOut } : {}),
                ...(newRoomId ? { assignedRoomId: newRoomId } : {}),
              }
            : r
        )
      );
    } else {
      setStays((list) =>
        list.map((sy) =>
          sy.id === id
            ? {
                ...sy,
                ...(newCheckOut ? { expectedCheckOut: newCheckOut } : {}),
                ...(newRoomId ? { assignedRoomId: newRoomId } : {}),
              }
            : sy
        )
      );
    }

    try {
      if (isReservation) {
        const body = {};
        if (newCheckIn) body.checkIn = newCheckIn;
        if (newCheckOut) body.checkOut = newCheckOut;
        if (newRoomId) body.assignedRoomId = newRoomId;
        await api.patch(`/api/reservations/${id}`, body);
        toast.success('Reservation updated.');
      } else {
        if (newRoomId) {
          await api.post(`/api/stays/${id}/room-change`, { newRoomId });
          toast.success('Room changed.');
        }
        if (newCheckOut) {
          // Resizing the bar only moves the expected checkout date — /extend
          // covers both longer and shorter. /early-departure would wrongly
          // depart the in-house guest, so it must not fire here.
          await api.post(`/api/stays/${id}/extend`, { newCheckOut });
        }
      }
      // The server publishes reservation:updated / stay:* on success, and the
      // live subscription above reconciles this optimistic state against it.
      // With the stream down there is nothing to reconcile against, so the
      // optimistic bar would be the only copy of the truth — refetch instead.
      if (!liveConnected) load({ live: true });
    } catch (e) {
      setReservations(rollback.reservations);
      setStays(rollback.stays);
      toast.error(errMsg(e));
    }
  }

  function onBarClick(bar) {
    if (drag) return;
    const id = reservationIdForBar(bar, stays);
    if (id) navigate(`/reservations/${id}`);
  }

  function onCellClick(e, room, day, colIdx) {
    if (drag) return;
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    // What is already drawn on this room-night. A click on a bar lands on the
    // CELL, not the bar — the bar is set to pointer-events:none for the frame a
    // press puts it in drag state, so the click falls through to here and
    // onBarClick above never runs. That makes this popover the only thing a
    // click on a booking produces, so it has to be able to open that booking:
    // offering nothing but "new reservation here" on an occupied night is what
    // left the board with no way in to a booking at all.
    const bar = barAt(barsByRoom[room.id], colIdx);
    const bookingId = reservationIdForBar(bar, stays);
    setPopover({
      x: rect.left + rect.width / 2,
      y: rect.bottom + 4,
      roomId: room.id,
      roomNumber: room.number,
      typeCode: room.typeCode,
      day: isoDay(day),
      // Absent on a free night, and on an out-of-order block, which has no
      // booking behind it.
      bookingId,
      bookingLabel: bookingId ? bar.label : '',
    });
  }

  function showBooking() {
    if (!popover?.bookingId) return;
    navigate(`/reservations/${popover.bookingId}`);
    setPopover(null);
  }

  function quickCreate() {
    if (!popover) return;
    navigate(
      `/reservations/new?roomTypeCode=${popover.typeCode}&checkIn=${popover.day}&assignedRoomId=${popover.roomId}`
    );
    setPopover(null);
  }

  return (
    <div onClick={() => setPopover(null)}>
      <CalendarShell
        days={days}
        cornerLabel="Room"
        loading={loading}
        gridRef={gridRef}
        daySub={(d) => `${dayOccupancy(d).toFixed(1)}%`}
        hint="Drag a bar to move · Drag right edge to extend · Click empty cell to create"
        toolbarExtra={
          /* A booking with no room has no row to sit on. Saying so is the point:
             silently skipping these is what made saved reservations invisible. */
          unassigned.length > 0 && (
            <span
              className="cal2-unassigned"
              title={`No room assigned yet, so there is no row to draw them on:\n${unassigned
                .map((b) => `${b.label} · ${new Date(b.ci).toLocaleDateString()} (${b.nights}n)`)
                .join('\n')}`}
            >
              <Icon name="alert-circle" size={12} style={{ marginRight: 4 }} />
              {unassigned.length} without a room
            </span>
          )
        }
        legend={
          /* The legend has to say what colour MEANS. It promised status, which the
             bar fill no longer carries — leaving it would have been worse than no
             legend, because a wrong key is read as true. */
          <>
            <span className="cal2-legend-note">
              Each guest has their own colour · <strong>stripe</strong> = status
            </span>
            <span>
              <span className="swatch stripe st-confirmed" /> Confirmed
            </span>
            <span>
              <span className="swatch stripe st-in_house" /> In-house
            </span>
            <span>
              <span className="swatch stripe st-pending" /> Pending
            </span>
            <span>
              <span className="swatch stripe st-checked_out" /> Checked out
            </span>
            <span>
              <span className="swatch stripe st-canceled" /> Cancelled / no-show
            </span>
            <span style={{ marginLeft: 'auto' }}>
              <span
                className="bar-balance-dot"
                style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 4 }}
              />{' '}
              Balance owing
            </span>
          </>
        }
      >
        {/* Per room-type group */}
        {grouped.map((g) => {
          const isCollapsed = collapsed[g.type.code];
          return (
            <div key={g.type.code} style={{ display: 'contents' }}>
              {/* Type summary row */}
              <div className="cal2-room type-row">
                <button
                  className="icon"
                  style={{ padding: 0, color: 'var(--muted)' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setCollapsed({ ...collapsed, [g.type.code]: !isCollapsed });
                  }}
                  aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                >
                  <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={12} />
                </button>
                <span style={{ marginLeft: 4 }}>{g.type.name}</span>
              </div>
              {days.map((d) => {
                // count available rooms of this type that are free this day
                const ds = isoDay(d);
                const free = g.rooms.filter((rm) => {
                  const bars = barsByRoom[rm.id] || [];
                  return !bars.some((b) => {
                    const ci = startOfDay(new Date(b.ci));
                    const co = startOfDay(new Date(b.co));
                    return ci <= d && d < co;
                  });
                }).length;
                return (
                  <div
                    key={ds}
                    className="cal2-day"
                    style={{ background: 'var(--surface-2)', textAlign: 'center', padding: '8px 4px' }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{free}</div>
                    <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                      {formatPeso(g.type.baseRate || 0)}
                    </div>
                  </div>
                );
              })}

              {/* Per room rows */}
              {!isCollapsed &&
                g.rooms.map((rm) => (
                  <div key={rm.id} style={{ display: 'contents' }}>
                    <div className="cal2-room">
                      {/* statusMeta, not the .status-dot.clean/dirty/occupied/out
                          modifiers — those colour OCCUPIED the same green as
                          CLEAN and DIRTY amber instead of red, disagreeing with
                          the Map & Housekeeping board's colours for the exact
                          same room statuses. One shared source keeps every
                          screen's dot meaning the same thing. */}
                      <span
                        className="status-dot"
                        style={{ background: statusMeta(rm.status || 'CLEAN').color }}
                      />
                      {rm.number}
                    </div>
                    {days.map((d, idx) => {
                      const isToday = isoDay(d) === todayStr;
                      return (
                        <div
                          key={isoDay(d)}
                          className={`cal2-cell ${isToday ? 'today' : ''}`}
                          onClick={(e) => onCellClick(e, rm, d, idx)}
                        >
                          {/* Each bar is rendered INSIDE the cell of the day it
                                  starts on, and sized as a multiple of that cell's
                                  own width.

                                  Every bar used to be rendered in column 0 and
                                  positioned with hardcoded 92px arithmetic — but the
                                  grid columns are `minmax(92px, 1fr)`, so on any
                                  viewport wider than about 1430px they are wider than
                                  92px and every bar drifted left of its real dates,
                                  further with each column. A guest's name sat on the
                                  wrong days, which is unusable on a board whose only
                                  job is telling you who is in which room and when.

                                  Percentages resolve against the containing cell, so
                                  this is exact at any width. */}
                          {(barsByRoom[rm.id] || [])
                            .filter((b) => b.startCol === idx)
                            .map((b) => {
                              const dragMatch = drag && drag.bar.key === b.key;
                              const dCols = dragMatch ? drag.deltaCols : 0;
                              const dRows = dragMatch && drag.kind === 'move' ? drag.deltaRows : 0;
                              const span =
                                dragMatch && drag.kind === 'resize' ? Math.max(1, b.span + dCols) : b.span;
                              // The drag preview uses the cell size MEASURED at
                              // mousedown, so it tracks the cursor exactly rather
                              // than assuming a column width.
                              const shiftX = dragMatch && drag.kind === 'move' ? dCols * drag.colWidth : 0;
                              const shiftY = dRows * (drag?.rowHeight || 0);
                              // An out-of-order block is a room state, not a
                              // guest, so it keeps the status fill it always
                              // had. Everything else is coloured by whose
                              // booking it is.
                              const isGuest = b.status !== 'ooo';
                              const slot = isGuest ? guestSlots.get(guestKey(b)) : undefined;
                              const fill = slot === undefined ? null : colorFor(slot, dark);
                              // A bar cut off by the edge of the window is
                              // NARROWER than the stay it represents. Without
                              // saying so, the board understates the length of
                              // every long stay at the window boundary — the
                              // width is the only length cue there is.
                              const cls = [
                                'cal2-bar',
                                b.status,
                                isGuest ? 'guest' : '',
                                dragMatch ? 'dragging' : '',
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
                                    left: 2,
                                    width: `calc(${span} * 100% - 4px)`,
                                    transform:
                                      shiftX || shiftY ? `translate(${shiftX}px, ${shiftY}px)` : undefined,
                                    pointerEvents: dragMatch ? 'none' : 'auto',
                                    ...(fill ? { background: fill, color: inkOn(fill) } : {}),
                                  }}
                                  onMouseDown={(e) => onBarMouseDown(e, b, 'move')}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onBarClick(b);
                                  }}
                                  title={`${b.label} · ${new Date(b.ci).toLocaleDateString()} → ${new Date(b.co).toLocaleDateString()} · ${b.nights} night${b.nights === 1 ? '' : 's'}${
                                    b.status === 'ooo' ? '' : ` · ${b.status.replace('_', ' ')}`
                                  }`}
                                >
                                  {/* The stripe carries STATUS now. Stay
                                          length used to live here and is the cue
                                          that lost least by moving — how many
                                          nights a booking runs is already the
                                          width of the bar. */}
                                  <span className={`cal2-bar-stripe st-${b.status}`} />
                                  {b.balanceDue && <span className="bar-balance-dot" />}
                                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {b.label}
                                  </span>
                                  {b.status !== 'ooo' && (
                                    <span
                                      className="cal2-resize-handle"
                                      onMouseDown={(e) => onBarMouseDown(e, b, 'resize')}
                                    />
                                  )}
                                </div>
                              );
                            })}
                        </div>
                      );
                    })}
                  </div>
                ))}
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
            <strong>Room {popover.roomNumber}</strong> · {popover.day}
          </div>
          <button className="btn-cta" style={{ width: '100%' }} onClick={quickCreate}>
            <Icon name="plus" size={14} style={{ marginRight: 6 }} />
            New reservation here
          </button>
          {/* Only when this night is actually taken. The guest's name is on the
              button because abutting bars put two bookings within a few pixels
              of each other, and "View booking" alone would not say which one is
              about to open. */}
          {popover.bookingId && (
            <button className="btn-ghost" style={{ width: '100%', marginTop: 6 }} onClick={showBooking}>
              <Icon name="calendar" size={14} style={{ marginRight: 6 }} />
              View booking{popover.bookingLabel ? ` · ${popover.bookingLabel}` : ''}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
