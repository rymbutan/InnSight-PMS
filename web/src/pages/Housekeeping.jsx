import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import api from '../api';
import { useAuth } from '../auth';
import { useToast, errMsg } from '../components/Toast';
import Icon from '../components/Icon';
import PanZoom from '../components/PanZoom';
import { useCoarsePointer } from '../lib/touchInput';
import { useConfirm } from '../components/ConfirmDialog';
import { formatPeso } from '../lib/money';
import { statusMeta, STATUS_ORDER, ON_FILL_INK, ON_FILL_INK_SOFT } from '../sim/statusMeta';
import { useRoomEvents } from '../sim/useRoomEvents';
import { submitRun, ACTIVITY } from '../sim/trainingLog';
import { passesInspection } from '../sim/inspection/inspectionScore';
import { computeLayout, MARGIN_X, CORRIDOR_H } from '../sim/hotelMap';

// Heavy sim code only downloads when a supervisor actually starts an inspection.
const InspectionShift = lazy(() => import('../sim/inspection/InspectionShift'));

// ── Single room on the SVG map ──────────────────────────────────────────────
function RoomShape({ slot, selected, flashing, onSelect, onHover, hoverable = true }) {
  const { room, x, y, w, h, row } = slot;
  const meta = statusMeta(room.status);
  // Door sits on the corridor side: bottom edge for the top row, top edge
  // for the bottom row.
  const doorY = row === 0 ? y + h - 4 : y;
  return (
    <g
      className={`hk-room${flashing ? ' hk-room-flash' : ''}`}
      onClick={() => onSelect(room)}
      {...(hoverable
        ? {
            onMouseEnter: (e) => onHover(room, e),
            onMouseMove: (e) => onHover(room, e),
            onMouseLeave: () => onHover(null),
          }
        : // No hover handlers at all on touch. A tap fires a synthetic
          // mouseenter with no matching mouseleave, so the tooltip appeared
          // under the finger and then stayed there over the map. Tapping
          // already selects the room, and the detail panel below says
          // everything the tooltip did and more.
          {})}
      style={{ cursor: 'pointer' }}
    >
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={6}
        fill={meta.fill}
        stroke={selected ? 'var(--text)' : meta.color}
        strokeWidth={selected ? 2.5 : 1.5}
      />
      {/* door notch on the corridor side */}
      <rect x={x + w / 2 - 9} y={doorY} width={18} height={4} rx={2} fill={meta.color} />
      <text
        x={x + w / 2}
        y={y + h / 2 - 12}
        textAnchor="middle"
        fontSize="17"
        fontWeight="700"
        fill={ON_FILL_INK}
      >
        {room.number}
      </text>
      {/* The full type name at a readable width, the short code when the map is
          scaled down. This is what used to render as "Standar" — the name was
          drawn at whatever width was left over and simply overflowed its tile
          into the neighbouring room. */}
      <text x={x + w / 2} y={y + h / 2 + 8} textAnchor="middle" fontSize="11" fill={ON_FILL_INK_SOFT}>
        {w >= 88 ? room.roomType?.name || room.typeCode : room.typeCode}
      </text>
      {/* status code badge */}
      <g>
        <rect x={x + w / 2 - 19} y={y + h / 2 + 16} width={38} height={18} rx={9} fill={meta.color} />
        <text
          x={x + w / 2}
          y={y + h / 2 + 29}
          textAnchor="middle"
          fontSize="10.5"
          fontWeight="700"
          fill="#fff"
        >
          {meta.code}
        </text>
      </g>
    </g>
  );
}

// Shown in place of the turnover when the signed-in user has not been
// assigned the operational role it belongs to.
function GameLockNotice() {
  return (
    <p className="hk-game-lock">
      <Icon name="ban" size={14} strokeWidth={1.9} />
      <span>
        Room turnover is assigned work. Ask your instructor to give you the
        <strong> Housekeeping &amp; Maintenance</strong> role to run it.
      </span>
    </p>
  );
}

// Shown to a housekeeper on a room they have already cleaned. Signing a room
// off as guest-ready is the supervisor's check ON that cleaning — the attendant
// who turned the room over cannot certify their own work, which is the entire
// reason Vacant Clean and Inspected are two states and not one. The inventory
// service enforces the same split (INSPECTION_SIGNOFF_ROLES in
// services/inventory/src/routes/inventory.routes.js), so this notice explains a
// button that would be refused rather than merely hiding it.
function SignOffLockNotice() {
  return (
    <p className="hk-game-lock">
      <Icon name="ban" size={14} strokeWidth={1.9} />
      <span>
        This room is cleaned and waiting on a <strong>supervisor</strong> to inspect it. Housekeeping does not
        sign off its own turnover.
      </span>
    </p>
  );
}

// ── Context actions per status (the "detail panel" of the learning guide) ───
// Two different gates, because these are two different jobs done by two
// different people:
//   `canClean`   — run the turnover on a dirty room (housekeeping's own work;
//                  instructors, ADMIN/MANAGER, may also preview it).
//   `canSignOff` — inspect a room that is already clean and pass it as
//                  guest-ready. Supervisors only.
function panelActions(room, act, launchGame, canClean, canSignOff) {
  switch (room.status) {
    case 'DIRTY':
      return (
        <>
          <p className="muted">
            The room is only marked clean once it is worked against the booking and every fault is correctly
            fixed — there is no manual shortcut.
          </p>
          {canClean ? (
            <button className="btn-primary hk-action" onClick={() => launchGame('INSPECTION', room)}>
              <Icon name="search" size={14} strokeWidth={2} />
              Turn Room Over Against Booking
            </button>
          ) : (
            <GameLockNotice />
          )}
          <button className="secondary" onClick={() => act('OUT_OF_SERVICE', 'Room placed out of service.')}>
            Mark Out of Service
          </button>
          <button className="danger" onClick={() => act('OUT_OF_ORDER', 'Room placed out of order.')}>
            Mark Out of Order
          </button>
        </>
      );
    case 'CLEAN':
      return (
        <>
          {canSignOff ? (
            <button className="btn-primary hk-action" onClick={() => launchGame('INSPECTION', room)}>
              <Icon name="search" size={14} strokeWidth={2} />
              Inspect &amp; Sign Off Room
            </button>
          ) : (
            <SignOffLockNotice />
          )}
          <button className="secondary" onClick={() => act('DIRTY', 'Room degraded to Vacant Dirty.')}>
            Report Inadequate Cleaning
          </button>
          <button className="danger" onClick={() => act('OUT_OF_ORDER', 'Room placed out of order.')}>
            Mark Out of Order
          </button>
        </>
      );
    case 'CLEAN_INSPECTED':
      return (
        <>
          <p className="muted">Ready for guest assignment by the front desk.</p>
          <button className="secondary" onClick={() => act('DIRTY', 'Room degraded to Vacant Dirty.')}>
            Report Inadequate Cleaning
          </button>
        </>
      );
    case 'OCCUPIED':
      return (
        <>
          <p className="muted">Guest in room — status is controlled by front-desk check-in/out.</p>
        </>
      );
    case 'OUT_OF_ORDER':
      return (
        <button
          className="btn-primary hk-action"
          onClick={() => act('DIRTY', 'Maintenance done — room needs cleaning.')}
        >
          <Icon name="settings" size={14} strokeWidth={1.9} />
          Restore Room
        </button>
      );
    case 'OUT_OF_SERVICE':
      return (
        <button
          className="btn-primary hk-action"
          onClick={() => act('DIRTY', 'Servicing done — room needs cleaning.')}
        >
          <Icon name="settings" size={14} strokeWidth={1.9} />
          Return to Service
        </button>
      );
    default:
      return null;
  }
}

export default function Housekeeping() {
  const [rooms, setRooms] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [game, setGame] = useState(null); // { type, room, reservation }
  // The last inspection's outcome for whichever room ran it — a FAIL leaves
  // the status exactly where it was (a DIRTY room that fails stays DIRTY),
  // so the map tile and the panel's action buttons look identical to before
  // anything happened. Without this, the only sign anything ran at all was a
  // toast that had already faded by the time someone looked back at the
  // panel — indistinguishable from the button not working. Keyed by room id
  // so it only ever shows for the room it's actually about, and cleared the
  // moment that room's next game starts.
  const [lastResult, setLastResult] = useState(null); // { roomId, ok, message }
  const [hover, setHover] = useState(null); // { room, x, y }
  const [flash, setFlash] = useState(() => new Set());
  const flashTimers = useRef({});
  const toast = useToast();
  const confirm = useConfirm();
  const { hasRole } = useAuth();
  // The turnover is training assigned to the housekeeping role; instructors
  // (ADMIN/MANAGER) can preview it.
  const canClean = hasRole('HOUSEKEEPING_MAINTENANCE', 'ADMIN', 'MANAGER');
  const isSupervisor = hasRole('ADMIN', 'MANAGER'); // can assign rooms to housekeepers
  // Signing a clean room off as guest-ready is the supervisor's check on
  // housekeeping's work, so housekeeping cannot do it to its own rooms — see
  // SignOffLockNotice, and the matching 403 in the inventory service. Held
  // separately from `canClean` precisely so an account with only the
  // housekeeping role gets one and not the other.
  //
  // NOT the same list as `isSupervisor`: the inventory service's
  // INSPECTION_SIGNOFF_ROLES (services/inventory/src/routes/inventory.routes.js)
  // also trusts FRONT_DESK with this specific action, so gating the button on
  // `isSupervisor` alone showed a front-desk account SignOffLockNotice for a
  // request the backend would actually have accepted.
  const canSignOff = hasRole('ADMIN', 'MANAGER', 'FRONT_DESK');
  // Who may ring housekeeping. Mirrors CALLERS on POST /api/housekeeping-calls.
  const canCall = hasRole('ADMIN', 'MANAGER', 'FRONT_DESK');
  const [callReason, setCallReason] = useState('CLEANING');
  const [callNote, setCallNote] = useState('');
  const [calling, setCalling] = useState(false);

  async function callHousekeeping(room) {
    setCalling(true);
    try {
      const { data } = await api.post('/api/housekeeping-calls', {
        roomId: room.id,
        reason: callReason,
        note: callNote || undefined,
      });
      // Register it with the shell so the answer-back toast fires on THIS
      // terminal only — every desk receives the channel, and a clerk should not
      // be told a colleague's call was picked up.
      window.__innsightTrackCall?.(data.callId, data.targetName);
      toast.success(
        data.targetName
          ? `Ringing ${data.targetName} about room ${room.number}…`
          : `Ringing housekeeping about room ${room.number}…`
      );
      setCallNote('');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setCalling(false);
    }
  }
  const [hkUsers, setHkUsers] = useState([]);

  // ── Which inspection scenario each room hands out ─────────────────────────
  // A supervisor can pin a premade scenario to a room, so every student who
  // inspects it walks into the same authored faults. A room with no pin either
  // draws an authored scenario for its tier or has one generated — both stay in
  // play, so a tier nobody has authored for still works.
  const [scenarios, setScenarios] = useState([]);
  const [assignments, setAssignments] = useState({}); // roomId → scenarioId

  // Inspecting a REAL room, so the clipboard shows that room's real booking —
  // guest name, party size and special requests all come from the reservation.
  // Best-effort: a vacant room or a failed lookup falls back to a generated
  // booking rather than blocking the inspection, since the exercise is still
  // valid without a live guest.
  async function launchInspection(type, room) {
    let reservation = null;
    // Offline this lookup cannot succeed, and waiting out a timeout before the
    // room even opens is what made "Inspect" look broken with no wifi. Skip it
    // outright when the browser knows it is offline, and bound it hard otherwise:
    // a generated booking is a perfectly valid exercise.
    if (navigator.onLine !== false) {
      try {
        const { data } = await api.get(`/api/reservations?assignedRoomId=${encodeURIComponent(room.id)}`, {
          timeout: 4000,
        });
        const list = Array.isArray(data) ? data : data?.items || [];
        reservation =
          list.find(
            (r) => r.status === 'IN_HOUSE' || r.status === 'CHECKED_IN' || r.status === 'CONFIRMED'
          ) ||
          list[0] ||
          null;
      } catch {
        reservation = null;
      }
    }
    setLastResult(null);
    setGame({ type, room, reservation });
  }

  async function loadScenarioPins() {
    // Never fatal: the room grid must render even if the training service is
    // down, and an unpinned room simply generates its faults.
    const [list, pins] = await Promise.all([
      api
        .get('/api/training/scenarios')
        .then(({ data }) => data || [])
        .catch(() => []),
      api
        .get('/api/training/scenario-assignments')
        .then(({ data }) => data || [])
        .catch(() => []),
    ]);
    setScenarios(list);
    setAssignments(Object.fromEntries(pins.map((a) => [a.roomId, a.scenarioId])));
  }

  async function setScenarioPin(room, scenarioId) {
    const prev = assignments[room.id] || '';
    // Optimistic: the select must not sit on the old value while the round trip
    // completes, or a supervisor clicks it twice.
    setAssignments((m) => ({ ...m, [room.id]: scenarioId || undefined }));
    try {
      if (scenarioId) {
        await api.put(`/api/training/scenario-assignments/${room.id}`, { scenarioId });
        const s = scenarios.find((x) => x.id === scenarioId);
        toast.success(`Room ${room.number} will use “${s?.name || 'this scenario'}”.`);
      } else {
        await api.delete(`/api/training/scenario-assignments/${room.id}`);
        toast.success(`Room ${room.number} will generate its own faults.`);
      }
    } catch (e) {
      setAssignments((m) => ({ ...m, [room.id]: prev || undefined }));
      toast.error(errMsg(e));
    }
  }

  async function load() {
    try {
      const r = await api.get('/api/rooms');
      setRooms(r.data);
      loadScenarioPins();
      // The roster, for the Assign-to dropdown. Everyone who can assign or call
      // needs it now — not just supervisors — so it comes from the narrow
      // /api/users/housekeepers route rather than the full user list, which the
      // front desk is not entitled to read.
      if ((isSupervisor || canCall) && hkUsers.length === 0) {
        const u = await api.get('/api/users/housekeepers').catch(() => ({ data: [] }));
        setHkUsers(u.data || []);
      }
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  async function assign(roomId, u) {
    try {
      await api.patch(
        `/api/rooms/${roomId}/assign`,
        u ? { assignedTo: u.id, assignedToName: u.displayName } : { assignedTo: null }
      );
      setRooms((prev) =>
        prev.map((r) =>
          r.id === roomId ? { ...r, assignedTo: u?.id || null, assignedToName: u?.displayName || null } : r
        )
      );
      toast.success(u ? `Assigned to ${u.displayName}.` : 'Unassigned.');
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  useEffect(() => {
    load();
  }, []);
  // Clear any pending flash timers on unmount so they don't fire setFlash on
  // an unmounted component.
  useEffect(
    () => () => {
      Object.values(flashTimers.current).forEach(clearTimeout);
      flashTimers.current = {};
    },
    []
  );

  function flashRoom(roomId) {
    setFlash((prev) => new Set(prev).add(roomId));
    clearTimeout(flashTimers.current[roomId]);
    flashTimers.current[roomId] = setTimeout(() => {
      setFlash((prev) => {
        const n = new Set(prev);
        n.delete(roomId);
        return n;
      });
    }, 1600);
  }

  // Live updates: any status change anywhere in the PMS (front-desk checkout,
  // another student cleaning, an instructor override) repaints the map.
  useRoomEvents(({ roomId, status }) => {
    setRooms((prev) => prev.map((r) => (r.id === roomId ? { ...r, status } : r)));
    flashRoom(roomId);
  });

  // The two statuses that take a room OUT of sellable inventory. Guarded inside
  // `act` rather than on the buttons, so every call site — including any added
  // later — is covered by construction and cannot forget the prompt.
  const NEEDS_CONFIRM = {
    OUT_OF_SERVICE: {
      what: 'out of service',
      detail:
        'The room leaves sellable inventory until someone puts it back. Front desk will not be able to assign it.',
    },
    OUT_OF_ORDER: {
      what: 'out of order',
      detail:
        'The room leaves sellable inventory and is flagged as faulty. Front desk will not be able to assign it.',
    },
  };

  // `toastKind` defaults to 'success' for every other caller (Mark Out of
  // Service, Report Inadequate Cleaning, ...) — all genuinely successful
  // status changes. The inspection-fail path below passes 'error' because a
  // room going DIRTY-to-DIRTY has nothing else to show that it happened.
  async function act(roomId, status, msg, toastKind = 'success') {
    const guard = NEEDS_CONFIRM[status];
    if (guard) {
      const room = rooms.find((r) => r.id === roomId);
      const ok = await confirm({
        title: `Mark ${guard.what}`,
        message: `Are you sure you want to mark room ${room?.number ?? ''} ${guard.what}?`,
        detail: guard.detail,
        confirmLabel: `Mark ${guard.what}`,
      });
      if (!ok) return;
    }
    try {
      await api.patch(`/api/rooms/${roomId}/status`, { status });
      setRooms((prev) => prev.map((r) => (r.id === roomId ? { ...r, status } : r)));
      flashRoom(roomId);
      toast[toastKind](msg);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  const { slots, floors, mapW, mapH } = useMemo(() => computeLayout(rooms), [rooms]);
  const selected = rooms.find((r) => r.id === selectedId) || null;
  const counts = useMemo(() => {
    const c = {};
    rooms.forEach((r) => {
      c[r.status] = (c[r.status] || 0) + 1;
    });
    return c;
  }, [rooms]);
  // Live, so docking a tablet to a keyboard swaps the map's controls back to
  // the desktop ones without a reload.
  const touch = useCoarsePointer();
  const occupancy = rooms.length ? Math.round(((counts.OCCUPIED || 0) / rooms.length) * 100) : 0;
  // The floor tabs below call through this to jump the map to a floor,
  // without resetting whatever zoom the person already pinched to.
  const panZoomRef = useRef(null);

  return (
    <div>
      {/* Same title treatment as Rooms, so the two read as one destination with
          two views. Navigation between them is the sidebar's job. */}
      <div className="hk-header">
        <div className="page-head-title">
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 600 }}>Map &amp; Housekeeping</h1>
        </div>
        <span className="hk-occupancy">
          Occupancy: <strong>{occupancy}%</strong>
        </span>
      </div>

      <div className="hk-layout">
        <div className="panel hk-map-panel" data-tour="tour-process-housekeeping">
          {/* On a mouse: the drawing keeps its rooms at a legible width and
              grows past the panel when the property is large, so this scrolls
              rather than squeezing forty-five rooms into one screen-width.

              On touch: that scroll is close to unusable — a one-finger drag
              over an SVG gets claimed by the page, and there is no way to zoom
              the part that matters. <PanZoom> takes over on a coarse pointer
              only, and leaves the desktop container exactly as it was. */}
          {/* Floor tabs — touch only, same reasoning as PanZoom itself: a
              mouse already has the native scrollbar to find a floor with, but
              a phone or an iPad has to pan a many-floor property blind to
              reach one, which is exactly what "fit the screen" asked for.
              Jumps by panning (see PanZoom's focusRect), not by resetting
              zoom, so whatever legibility level was already pinched to
              carries over to the floor landed on. */}
          {touch && floors.length > 1 && (
            <div className="hk-floor-tabs" role="tablist" aria-label="Jump to floor">
              {floors.map((f) => (
                <button
                  key={f.floor}
                  type="button"
                  role="tab"
                  className="hk-floor-tab"
                  onClick={() =>
                    panZoomRef.current?.focusRect({
                      x: 0,
                      y: f.topY,
                      w: mapW,
                      h: f.bottomY - f.topY,
                    })
                  }
                >
                  Floor {f.floor}
                </button>
              ))}
            </div>
          )}
          <PanZoom
            ref={panZoomRef}
            enabled={touch}
            className="hk-map-scroll"
            contentW={mapW}
            contentH={mapH || 420}
            label="Hotel floor map — drag to pan, pinch to zoom"
          >
            <svg
              viewBox={`0 0 ${mapW} ${mapH || 420}`}
              width={mapW}
              height={mapH || 420}
              className="hk-map"
              role="img"
              aria-label="Interactive hotel floor map"
            >
              {floors.map((f) => (
                <g key={`floor-${f.floor}`}>
                  <text x={MARGIN_X - 8} y={f.labelY} fontSize="12" fontWeight="700" fill="var(--muted)">
                    FLOOR {f.floor}
                  </text>
                  <text x={MARGIN_X + 66} y={f.labelY} fontSize="11" fill="var(--muted-2)">
                    {f.count} room{f.count === 1 ? '' : 's'}
                  </text>
                  <rect
                    x={MARGIN_X - 8}
                    y={f.corridorY}
                    width={mapW - (MARGIN_X - 8) * 2}
                    height={CORRIDOR_H}
                    rx={4}
                    fill="var(--row-hover)"
                    stroke="var(--border)"
                  />
                  <text
                    x={mapW / 2}
                    y={f.corridorY + CORRIDOR_H / 2 + 4}
                    textAnchor="middle"
                    fontSize="11"
                    letterSpacing="6"
                    fill="var(--muted-2)"
                  >
                    CORRIDOR
                  </text>
                </g>
              ))}
              {slots.map((slot) => (
                <RoomShape
                  key={slot.room.id}
                  slot={slot}
                  selected={slot.room.id === selectedId}
                  flashing={flash.has(slot.room.id)}
                  onSelect={(room) => setSelectedId(room.id === selectedId ? null : room.id)}
                  onHover={(room, e) => setHover(room ? { room, x: e.clientX, y: e.clientY } : null)}
                  hoverable={!touch}
                />
              ))}
            </svg>
          </PanZoom>

          {hover && !touch && (
            <div className="hk-tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
              <strong>Room {hover.room.number}</strong> — {hover.room.roomType?.name || hover.room.typeCode}
              <div>
                {statusMeta(hover.room.status).label} ({statusMeta(hover.room.status).code})
              </div>
              {hover.room.roomType && (
                <div className="muted">
                  {formatPeso(hover.room.roomType.baseRate)} / night · sleeps{' '}
                  {hover.room.roomType.maxOccupancy}
                </div>
              )}
              <div className="muted">{statusMeta(hover.room.status).hint}</div>
            </div>
          )}
        </div>

        <div className="hk-side">
          <div className="panel hk-legend-panel">
            <h3>Legend</h3>
            <div className="hk-legend">
              {STATUS_ORDER.map((s) => {
                const m = statusMeta(s);
                return (
                  <span key={s} className="hk-legend-item" title={m.hint}>
                    <span className="hk-legend-swatch" style={{ background: m.fill, borderColor: m.color }} />
                    <span className="hk-legend-text">
                      <strong>{m.code}</strong> {m.label}
                    </span>
                    <span className="muted">({counts[s] || 0})</span>
                  </span>
                );
              })}
            </div>
          </div>

          {selected && (
            <div className="panel hk-detail">
              <div className="hk-detail-head">
                <h3 style={{ margin: 0 }}>Room {selected.number}</h3>
                <button className="icon" aria-label="Close" onClick={() => setSelectedId(null)}>
                  <Icon name="x" size={16} />
                </button>
              </div>
              <div
                className="hk-detail-status"
                style={{
                  background: statusMeta(selected.status).fill,
                  color: statusMeta(selected.status).color,
                }}
              >
                {statusMeta(selected.status).code} — {statusMeta(selected.status).label}
              </div>
              <dl className="hk-detail-meta">
                <dt>Type</dt>
                <dd>{selected.roomType?.name || selected.typeCode}</dd>
                <dt>Rate</dt>
                <dd>{selected.roomType ? `${formatPeso(selected.roomType.baseRate)} / night` : '—'}</dd>
                <dt>Floor</dt>
                <dd>{selected.floor}</dd>
                <dt>Sleeps</dt>
                <dd>{selected.roomType?.maxOccupancy ?? '—'}</dd>
                <dt>Assigned</dt>
                <dd>{selected.assignedToName || <span className="muted">unassigned</span>}</dd>
              </dl>

              {/* The desk's end of the internal line. Front Desk holds hk.read
                  but NOT hk.update, so it cannot mark this room dirty itself —
                  which is exactly why the control is a call and not a status
                  change. The desk asks; housekeeping decides and updates. */}
              {canCall && (
                <div className="hk-call">
                  <label style={{ margin: '0 0 4px' }}>Call housekeeping</label>
                  <div className="hk-call-row">
                    <select value={callReason} onChange={(e) => setCallReason(e.target.value)}>
                      <option value="CLEANING">Room needs cleaning</option>
                      <option value="SPILL">Spill / urgent clean</option>
                      <option value="LINENS">Fresh linens</option>
                      <option value="TURNDOWN">Turndown service</option>
                      <option value="INSPECTION">Ready for inspection</option>
                      <option value="OTHER">Other</option>
                    </select>
                    <button
                      type="button"
                      className="btn-primary hk-call-btn"
                      disabled={calling || !selected.assignedTo}
                      title={!selected.assignedTo ? 'Assign the room to a housekeeper before calling' : undefined}
                      onClick={() => callHousekeeping(selected)}
                    >
                      <Icon name="phone" size={14} />
                      {calling ? 'Ringing…' : 'Call'}
                    </button>
                  </div>
                  <input
                    className="hk-call-note"
                    value={callNote}
                    maxLength={200}
                    placeholder="Optional message (e.g. guest arriving at 1pm)"
                    onChange={(e) => setCallNote(e.target.value)}
                  />
                  {/* Says who will actually hear it BEFORE the button is
                      pressed. The target comes from the room's assignment, so
                      without this the same button quietly means two different
                      things depending on a field further up the panel. An
                      unassigned room has no one call target any more — see
                      POST /housekeeping-calls — so the button above is disabled
                      rather than fanning the ring out to the whole team. */}
                  <p className="hk-call-who">
                    {selected.assignedToName ? (
                      <>
                        Rings <strong>{selected.assignedToName}</strong> only.
                      </>
                    ) : (
                      <>
                        Unassigned — assign the room above before you can call.
                      </>
                    )}
                  </p>
                </div>
              )}
              {/* Front desk can assign too now: the workflow is assign, THEN
                  ring, and a clerk who cannot name the housekeeper has nobody to
                  call. Naming who works the room is not the same power as
                  changing the room's status, which remains hk.update. */}
              {(isSupervisor || canCall) && (
                <div style={{ margin: '6px 0 12px', display: 'flex', gap: 6, alignItems: 'center' }}>
                  <label style={{ margin: 0 }}>Assign to</label>
                  <select
                    value={selected.assignedTo || ''}
                    onChange={(e) =>
                      assign(selected.id, hkUsers.find((u) => u.id === e.target.value) || null)
                    }
                  >
                    <option value="">— unassigned —</option>
                    {hkUsers.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.displayName}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Which faults this room hands out. Only scenarios authored for
                this room's tier are offered: a Suite scenario laid over a
                Standard room would tag fixtures that room does not have, and
                every one of those tags would silently fail to resolve. */}
              {isSupervisor && (
                <div style={{ margin: '6px 0 12px' }}>
                  <label style={{ margin: '0 0 4px' }}>Inspection scenario</label>
                  <select
                    style={{ width: '100%' }}
                    value={assignments[selected.id] || ''}
                    onChange={(e) => setScenarioPin(selected, e.target.value)}
                  >
                    <option value="">— generate faults automatically —</option>
                    {scenarios
                      .filter((s) => s.roomTier === (selected.roomType?.name || ''))
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                          {s.active === false ? ' (inactive)' : ''}
                        </option>
                      ))}
                  </select>
                  <p className="muted" style={{ margin: '4px 0 0', fontSize: 12 }}>
                    {assignments[selected.id]
                      ? 'Every student inspecting this room gets these exact faults.'
                      : 'Faults are generated, or drawn from an authored scenario for this room type. The booking on the clipboard is this room’s real reservation either way — a room with nobody booked in gets a practice booking, marked as such.'}
                  </p>
                </div>
              )}
              {/* Persists until this room's next attempt (cleared in
                  launchInspection), unlike the toast that reported the same
                  thing — a FAIL leaves the status and the buttons below
                  looking exactly like nothing was ever tried. */}
              {lastResult && lastResult.roomId === selected.id && (
                <p className={lastResult.ok ? 'hk-result hk-result--pass' : 'hk-result hk-result--fail'}>
                  <Icon name={lastResult.ok ? 'check-circle' : 'alert-circle'} size={14} strokeWidth={2} />
                  {lastResult.message}
                </p>
              )}
              <div className="hk-actions">
                {panelActions(
                  selected,
                  (status, msg) => act(selected.id, status, msg),
                  (type, room) => launchInspection(type, room),
                  canClean,
                  canSignOff
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {game && (
        <Suspense
          fallback={
            <div className="cg-overlay">
              <div className="cg-window">
                <p style={{ padding: 24 }}>Loading inspection…</p>
              </div>
            </div>
          }
        >
          {(() => {
            const { room, reservation } = game;
            const close = () => setGame(null);
            // Every game now persists its result to the competency record. Only
            // the cleaning turnover used to; Guest Services and Lost & Found
            // toasted and discarded the student's work.
            const logRun = async (activity, label, items, okMsg) => {
              const r = await submitRun({ activity, label, items });
              if (r.ok) toast.success(okMsg);
              // A failed save is reported, not swallowed — the student needs to
              // know the run did not reach their training record.
              else
                toast.error(
                  `${okMsg.replace(/\.$/, '')}, but the training result could not be saved (${r.reason}).`
                );
            };

            // The student works the room against its real booking. What a pass
            // is WORTH depends on who ran it: housekeeping's own turnover ends
            // at Vacant Clean and waits on a supervisor, and only a supervisor's
            // run signs the room off as guest-ready. Letting every pass land on
            // Inspected made the sign-off step decorative — an attendant
            // certified their own work, and the inventory service now refuses
            // that outright.
            const passStatus = canSignOff ? 'CLEAN_INSPECTED' : 'CLEAN';
            const passMessage = canSignOff
              ? `Room ${room.number} inspected — now guest-ready.`
              : `Room ${room.number} cleaned — waiting on a supervisor's inspection.`;
            return (
              <InspectionShift
                room={room}
                reservation={reservation}
                // Pinned scenario for this room if an instructor set one.
                scenario={scenarios.find((s) => s.id === assignments[room.id]) || null}
                // Otherwise the pool this page loaded — an ARRAY (even empty) so
                // the shift never has to make a request of its own.
                scenarioPool={scenarios}
                onExit={close}
                onComplete={(items) => {
                  const tier = room.roomType?.name || 'Standard';
                  logRun(ACTIVITY.INSPECTION, tier, items, `Room ${room.number} inspection recorded.`);
                  setGame(null);
                  // Guest-ready only if every fault was found and correctly
                  // categorised, and nothing clean was condemned — partial
                  // credit sends the room back for another turnover rather
                  // than through on a best-effort pass.
                  if (passesInspection(items)) {
                    setLastResult({ roomId: room.id, ok: true, message: passMessage });
                    act(room.id, passStatus, passMessage);
                  } else {
                    const failMessage = `Room ${room.number} inspection found problems — needs re-cleaning.`;
                    // Recorded even though the room started and ends DIRTY: that
                    // no-op status write is exactly why this needs its own
                    // signal, not just the toast below.
                    setLastResult({ roomId: room.id, ok: false, message: failMessage });
                    act(room.id, 'DIRTY', failMessage, 'error');
                  }
                }}
              />
            );
          })()}
        </Suspense>
      )}
    </div>
  );
}
