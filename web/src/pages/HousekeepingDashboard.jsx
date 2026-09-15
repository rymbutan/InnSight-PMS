import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../auth';
import { useToast, errMsg } from '../components/Toast';
import { useLiveRefresh, channels } from '../lib/useLiveEvents';
import { STATUS_META, STATUS_ORDER } from '../sim/statusMeta';
import EmptyState from '../components/EmptyState';
import Icon from '../components/Icon';
import { labelize } from '../lib/labels';

// ─────────────────────────────────────────────────────────────────────────────
// The dashboard a Housekeeping & Maintenance account sees instead of the
// front-office one.
//
// WHY IT IS A SEPARATE PAGE
// -------------------------
// The shared dashboard answers front-office questions — arrivals, departures,
// occupancy, a 14-day booking outlook, revenue history. A room attendant can
// act on none of it, and most of it they are not entitled to read at all: the
// reservations, audit and revenue calls on that page 403 for this role and get
// swallowed, so the page they were shown was mostly empty tiles built from
// requests that had already failed.
//
// Everything here is either a room they have to turn over, a job assigned to
// them, or somebody asking them for something. Nothing on this page is a number
// they can only look at.
// ─────────────────────────────────────────────────────────────────────────────

// Newest first, and only the states that still need somebody. A verified order
// is history; it belongs in the Completed tab, not in the worklist.
const OPEN_WO = ['REPORTED', 'TRIAGED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'];

// Fixed hex, matching STATUS_META's reasoning: a priority colour is an
// identifier, and one that shifted between themes would stop being learnable.
const WO_PRIORITY = {
  EMERGENCY: { label: 'Emergency', bg: '#dc2626', fg: '#fff' },
  URGENT: { label: 'Urgent', bg: '#ea580c', fg: '#fff' },
  NORMAL: { label: 'Normal', bg: '#94a3b8', fg: '#0f172a' },
  SCHEDULED: { label: 'Scheduled', bg: '#cbd5e1', fg: '#0f172a' },
};

const WO_STATUS_LABEL = {
  REPORTED: 'Reported',
  TRIAGED: 'Triaged',
  ASSIGNED: 'Assigned',
  IN_PROGRESS: 'In progress',
  ON_HOLD: 'On hold',
  COMPLETED: 'Completed',
  VERIFIED: 'Verified',
  CANCELLED: 'Cancelled',
};

const CALL_REASON_LABEL = {
  CLEANING: 'Cleaning',
  TURNDOWN: 'Turndown',
  LINENS: 'Linens',
  SPILL: 'Spill',
  INSPECTION: 'Inspection',
  OTHER: 'Other',
};

// "14m", "3h", "2d" — how long this has been waiting. Age is the thing that
// makes a worklist urgent, and an absolute timestamp makes the reader do the
// subtraction themselves.
function ageSince(iso) {
  if (!iso) return '—';
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / 1440)}d`;
}

function clockTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
}

function Pill({ bg, fg, children, title }) {
  return (
    <span
      title={title}
      style={{
        background: bg,
        color: fg,
        borderRadius: 999,
        padding: '2px 9px',
        fontSize: 11,
        fontWeight: 700,
        whiteSpace: 'nowrap',
        display: 'inline-block',
      }}
    >
      {children}
    </span>
  );
}

function RoomStatusPill({ status }) {
  const meta = STATUS_META[status];
  if (!meta) return <span className="muted">{labelize(status)}</span>;
  return (
    <Pill bg={meta.fill} fg={meta.color} title={meta.hint}>
      {meta.label}
    </Pill>
  );
}

export default function HousekeepingDashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const [rooms, setRooms] = useState([]);
  const [orders, setOrders] = useState([]);
  const [calls, setCalls] = useState([]);
  const [woTab, setWoTab] = useState('Open');
  const [callTab, setCallTab] = useState('Waiting');
  const [busyWo, setBusyWo] = useState(null);

  // Every request fails soft to an empty list. This page is a worklist made of
  // four independent sources, and one of them being unreachable is no reason to
  // show none of the others — the shared dashboard had exactly that failure and
  // greeted the whole role with a red toast.
  async function load() {
    const [r, w, c] = await Promise.all([
      api.get('/api/rooms').catch(() => ({ data: [] })),
      api.get('/api/work-orders').catch(() => ({ data: [] })),
      api.get('/api/housekeeping-calls', { params: { limit: 50 } }).catch(() => ({ data: [] })),
    ]);
    setRooms(Array.isArray(r.data) ? r.data : []);
    setOrders(Array.isArray(w.data) ? w.data : []);
    setCalls(Array.isArray(c.data) ? c.data : []);
  }

  useEffect(() => {
    load();
  }, []);

  // Rooms, work orders and the desk's calls — the three things this page is
  // made of, and nothing else. A booking being made does not change a room
  // attendant's day.
  const { connected } = useLiveRefresh(() => load(), {
    channels: channels('rooms', 'maintenance', 'housekeeping'),
  });

  const counts = useMemo(() => {
    const c = {};
    for (const r of rooms) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [rooms]);

  const myRooms = useMemo(
    () => rooms.filter((r) => r.assignedTo && r.assignedTo === user?.id),
    [rooms, user]
  );

  const openOrders = useMemo(() => orders.filter((o) => OPEN_WO.includes(o.status)), [orders]);
  const urgentOrders = useMemo(
    () => openOrders.filter((o) => o.priority === 'EMERGENCY' || o.priority === 'URGENT'),
    [openOrders]
  );
  const waitingCalls = useMemo(() => calls.filter((c) => !c.answeredAt), [calls]);

  const visibleOrders = useMemo(() => {
    if (woTab === 'Urgent') return urgentOrders;
    if (woTab === 'Mine') return openOrders.filter((o) => o.assignedTo === user?.id);
    if (woTab === 'Completed') {
      return orders.filter((o) => o.status === 'COMPLETED' || o.status === 'VERIFIED');
    }
    return openOrders;
  }, [woTab, orders, openOrders, urgentOrders, user]);

  const visibleCalls = callTab === 'Waiting' ? waitingCalls : calls;

  // Room numbers, so a work order reads "Room 204" instead of a UUID. A work
  // order can also be against an asset with no room at all, hence the fallback.
  const roomNumberOf = useMemo(() => {
    const m = new Map(rooms.map((r) => [r.id, r.number]));
    return (id) => (id ? m.get(id) || id : null);
  }, [rooms]);

  // The lifecycle button this order is up to, if any. Mirrors the state machine
  // the maintenance service enforces (requireWorkOrderState), so a button is
  // only ever offered where the service would accept it.
  function nextAction(o) {
    if (o.status === 'REPORTED') return { label: 'Triage', path: 'triage', body: {} };
    if (o.status === 'TRIAGED' || o.status === 'ASSIGNED') {
      return { label: 'Start', path: 'start', body: {} };
    }
    if (o.status === 'IN_PROGRESS') return { label: 'Complete', path: 'complete', body: {} };
    if (o.status === 'COMPLETED') return { label: 'Verify', path: 'verify', body: {} };
    return null;
  }

  async function advance(o) {
    const action = nextAction(o);
    if (!action) return;
    setBusyWo(o.id);
    try {
      await api.post(`/api/work-orders/${o.id}/${action.path}`, action.body);
      toast.success(`${o.workOrderNumber} — ${action.label.toLowerCase()}d.`);
      load();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyWo(null);
    }
  }

  async function answerCall(c) {
    try {
      await api.post(`/api/housekeeping-calls/${c.id}/answer`, {
        accepted: true,
        roomNumber: c.roomNumber,
        callerId: c.callerId,
      });
      toast.success(`Picked up — room ${c.roomNumber}.`);
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  const totalRooms = rooms.length;
  const toClean = counts.DIRTY || 0;
  const awaitingInspection = counts.CLEAN || 0;
  const ready = counts.CLEAN_INSPECTED || 0;
  const offline = (counts.OUT_OF_ORDER || 0) + (counts.OUT_OF_SERVICE || 0);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>
            {new Date().toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}
          </h1>
          <div className="subtle">
            Housekeeping &amp; Maintenance — {new Date().toLocaleDateString(undefined, { weekday: 'long' })}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span
            className={`hk-live ${connected ? 'on' : 'off'}`}
            title={connected ? 'Live — updates automatically' : 'Reconnecting…'}
          >
            <span className="hk-live-dot" /> {connected ? 'Live' : 'Offline'}
          </span>
          <button className="icon" title="Refresh" onClick={load}>
            <Icon name="refresh-cw" size={16} />
          </button>
        </div>
      </div>

      {/* Six numbers, every one of them a queue somebody has to empty. */}
      <div className="kpi-row">
        <div className="kpi-tile">
          <div>
            <div className="kpi-num">{toClean}</div>
            <div className="kpi-label">To clean</div>
          </div>
          <div className="kpi-icon">
            <Icon name="bed" size={26} />
          </div>
        </div>
        <div className="kpi-tile">
          <div>
            <div className="kpi-num">{awaitingInspection}</div>
            <div className="kpi-label" title="Cleaned — waiting on a supervisor to sign them off">
              Awaiting inspection
            </div>
          </div>
          <div className="kpi-icon">
            <Icon name="search" size={26} />
          </div>
        </div>
        <div className="kpi-tile">
          <div>
            <div className="kpi-num">{ready}</div>
            <div className="kpi-label">Guest-ready</div>
          </div>
          <span className="kpi-pct">{totalRooms ? Math.round((ready / totalRooms) * 100) : 0}%</span>
        </div>
        <div className="kpi-tile">
          <div>
            <div className="kpi-num">{offline}</div>
            <div className="kpi-label" title="Out of order or out of service">
              Off inventory
            </div>
          </div>
          <div className="kpi-icon">
            <Icon name="ban" size={26} />
          </div>
        </div>
        <div className="kpi-tile">
          <div>
            <div className="kpi-num">{openOrders.length}</div>
            <div className="kpi-label">Open job orders</div>
          </div>
          <div className="kpi-icon">
            <Icon name="settings" size={26} />
          </div>
        </div>
        <div className="kpi-tile">
          <div>
            <div className="kpi-num">{waitingCalls.length}</div>
            <div className="kpi-label">Calls waiting</div>
          </div>
          <div className="kpi-icon">
            <Icon name="phone" size={26} />
          </div>
        </div>
      </div>

      {/* ── Board: where every room stands right now ── */}
      <div className="panel">
        <h3>Room status</h3>
        <div className="hkd-status-board">
          {STATUS_ORDER.map((s) => {
            const meta = STATUS_META[s];
            const n = counts[s] || 0;
            return (
              <button
                key={s}
                className="hkd-status-cell"
                title={`${meta.hint} — open the map`}
                onClick={() => navigate('/housekeeping')}
                style={{ background: meta.fill, borderColor: meta.color }}
              >
                <span className="hkd-status-n" style={{ color: meta.color }}>
                  {n}
                </span>
                <span className="hkd-status-label" style={{ color: meta.color }}>
                  {meta.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="hkd-cols">
        {/* ── My rooms ── */}
        <div className="panel">
          <h3>
            My rooms{' '}
            <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>
              ({myRooms.length})
            </span>
          </h3>
          {myRooms.length === 0 ? (
            <EmptyState
              kind="inbox"
              title="No rooms assigned to you"
              hint="A supervisor assigns rooms on the housekeeping map. Unassigned rooms are still everyone's to pick up."
              action={
                <button className="secondary" onClick={() => navigate('/housekeeping')}>
                  Open the map
                </button>
              }
            />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Room</th>
                  <th>Floor</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {myRooms.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.number}</strong>
                    </td>
                    <td className="t-c">{r.floor}</td>
                    <td>
                      <RoomStatusPill status={r.status} />
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="secondary small" onClick={() => navigate('/housekeeping')}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Calls from the front desk ── */}
        <div className="panel">
          <h3>Calls from the front desk</h3>
          <div className="tabs-pill" style={{ marginBottom: 10 }}>
            {['Waiting', 'All'].map((t) => (
              <button key={t} className={callTab === t ? 'active' : ''} onClick={() => setCallTab(t)}>
                {t}
                {t === 'Waiting' && waitingCalls.length > 0 ? ` (${waitingCalls.length})` : ''}
              </button>
            ))}
          </div>
          {visibleCalls.length === 0 ? (
            <EmptyState
              kind="inbox"
              title={callTab === 'Waiting' ? 'No calls waiting' : 'No calls yet'}
              hint="The front desk rings housekeeping from the room map. Every call is logged here, answered or not."
            />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Room</th>
                  <th>Reason</th>
                  <th>From</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visibleCalls.map((c) => (
                  <tr key={c.id}>
                    <td title={new Date(c.placedAt).toLocaleString()}>{clockTime(c.placedAt)}</td>
                    <td>
                      <strong>{c.roomNumber}</strong>
                    </td>
                    <td>
                      <div>{CALL_REASON_LABEL[c.reason] || c.reason}</div>
                      {c.note && (
                        <div className="muted" style={{ fontSize: 12 }}>
                          {c.note}
                        </div>
                      )}
                    </td>
                    <td className="muted">{c.callerName || '—'}</td>
                    <td>
                      {c.answeredAt ? (
                        <Pill bg="#dcfce7" fg="#16a34a" title={new Date(c.answeredAt).toLocaleString()}>
                          {c.answeredByName || 'Answered'}
                        </Pill>
                      ) : (
                        /* Age, not a timestamp: a call that has been ringing for
                           40 minutes is the problem, and the reader should not
                           have to do the subtraction. */
                        <Pill bg="#fee2e2" fg="#dc2626">
                          Waiting {ageSince(c.placedAt)}
                        </Pill>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {!c.answeredAt && (
                        <button className="secondary small" onClick={() => answerCall(c)}>
                          Pick up
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ── Job orders ── */}
      <div className="panel">
        <h3>Job orders</h3>
        <div className="tabs-pill" style={{ marginBottom: 10 }}>
          {['Open', 'Mine', 'Urgent', 'Completed'].map((t) => (
            <button key={t} className={woTab === t ? 'active' : ''} onClick={() => setWoTab(t)}>
              {t}
              {t === 'Urgent' && urgentOrders.length > 0 ? ` (${urgentOrders.length})` : ''}
            </button>
          ))}
        </div>
        {visibleOrders.length === 0 ? (
          <EmptyState
            kind="inbox"
            title={woTab === 'Open' ? 'Nothing outstanding' : `No ${woTab.toLowerCase()} job orders`}
            hint="Work orders are raised from the room map and by the front desk when a guest reports a fault."
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Room</th>
                <th>Priority</th>
                <th>What</th>
                <th>Status</th>
                <th className="t-c">Age</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visibleOrders.map((o) => {
                const pri = WO_PRIORITY[o.priority] || WO_PRIORITY.NORMAL;
                const action = nextAction(o);
                const room = roomNumberOf(o.roomId);
                return (
                  <tr key={o.id}>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {o.workOrderNumber}
                    </td>
                    <td>{room ? <strong>{room}</strong> : <span className="muted">—</span>}</td>
                    <td>
                      <Pill bg={pri.bg} fg={pri.fg}>
                        {pri.label}
                      </Pill>
                    </td>
                    <td>
                      <div>{o.description}</div>
                      {(o.category || o.roomOutOfService) && (
                        <div className="muted" style={{ fontSize: 12 }}>
                          {o.category}
                          {o.category && o.roomOutOfService ? ' · ' : ''}
                          {o.roomOutOfService ? 'room off inventory' : ''}
                        </div>
                      )}
                    </td>
                    <td>{WO_STATUS_LABEL[o.status] || o.status}</td>
                    <td className="t-c" title={new Date(o.createdAt).toLocaleString()}>
                      {ageSince(o.createdAt)}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {action && (
                        <button
                          className="secondary small"
                          disabled={busyWo === o.id}
                          onClick={() => advance(o)}
                        >
                          {busyWo === o.id ? '…' : action.label}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
