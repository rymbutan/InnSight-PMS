import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { Skeleton, SkeletonRows } from '../components/Skeleton';
import { useAuth } from '../auth';
import { useToast, errMsg } from '../components/Toast';
import { useLiveRefresh, channels } from '../lib/useLiveEvents';
import { STATUS_META, STATUS_ORDER } from '../sim/statusMeta';
import EmptyState from '../components/EmptyState';
import Icon from '../components/Icon';
import { labelize } from '../lib/labels';
import { localDay } from '../lib/date';
import { SparkLine } from '../components/Chart';
import { HEAT_LEGEND, heatFill, heatInk, heatTitle, occupancyOf, outlookOccupancy } from '../lib/outlookHeat';

// ─────────────────────────────────────────────────────────────────────────────
// The dashboard a Housekeeping & Maintenance account sees instead of the
// front-office one.
//
// WHY IT IS A SEPARATE PAGE
// -------------------------
// The shared dashboard answers front-office questions — arrivals, departures,
// audit and revenue history — most of which this role is not entitled to read
// at all: those calls 403 and get swallowed, so the page they were shown was
// mostly empty tiles built from requests that had already failed.
//
// The 14-day booking outlook is the one exception, reused verbatim below: GET
// /api/reservations was widened to also allow HOUSEKEEPING_MAINTENANCE for
// exactly this (see the comment on that route in reservation.routes.js) — a
// room attendant benefits from seeing demand coming the same way the front
// desk does, and the endpoint returns nothing more sensitive than a booking
// count per room type per night already does on that page.
//
// Everything else here is either a room they have to turn over, a job
// assigned to them, or somebody asking them for something. Nothing on this
// page is a number they can only look at.
// ─────────────────────────────────────────────────────────────────────────────

// A room's Job Orders priority/request come from whichever call the front
// desk most recently placed on it, if any. SPILL is the one reason that is
// genuinely urgent — a spill left to sit is a slip hazard, not just a
// scheduling problem — everything else waiting on an attendant is routine.
const CALL_PRIORITY = {
  SPILL: { label: 'Urgent', bg: '#dc2626', fg: '#fff' },
  DEFAULT: { label: 'Requested', bg: '#f59e0b', fg: '#fff' },
  NONE: { label: 'Routine', bg: '#cbd5e1', fg: '#0f172a' },
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
  const [calls, setCalls] = useState([]);
  const [callTab, setCallTab] = useState('All');
  const [outlook, setOutlook] = useState({ types: [], days: [], cells: {} });

  // Every request fails soft to an empty list. This page is a worklist made of
  // independent sources, and one of them being unreachable is no reason to
  // show none of the others — the shared dashboard had exactly that failure and
  // greeted the whole role with a red toast.
  const [loaded, setLoaded] = useState(false);

  async function load() {
    const [r, c, types, res] = await Promise.all([
      api.get('/api/rooms').catch(() => ({ data: [] })),
      api.get('/api/housekeeping-calls', { params: { limit: 50 } }).catch(() => ({ data: [] })),
      api.get('/api/room-types').catch(() => ({ data: [] })),
      api.get('/api/reservations').catch(() => ({ data: [] })),
    ]);
    setRooms(Array.isArray(r.data) ? r.data : []);
    setCalls(Array.isArray(c.data) ? c.data : []);

    // Same build as the front-office dashboard's 14 Day Outlook — see
    // Dashboard.jsx's FrontOfficeDashboard.load(). Kept as one copy would be
    // nicer, but the two pages already don't share a module and duplicating
    // ~15 lines is cheaper than introducing one for a single caller.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayList = Array.from({ length: 14 }, (_, i) => {
      const dt = new Date(today);
      dt.setDate(today.getDate() + i);
      return dt;
    });
    const cells = {};
    for (const t of types.data) {
      for (const day of dayList) {
        const ds = localDay(day);
        const reserved = res.data.filter((rv) => {
          if (rv.roomTypeCode !== t.code) return false;
          if (['CANCELLED', 'NO_SHOW'].includes(rv.status)) return false;
          const ci = localDay(rv.checkIn);
          const co = localDay(rv.checkOut);
          return ci <= ds && ds < co;
        }).length;
        cells[`${t.code}|${ds}`] = Math.max(0, t.totalInventory - reserved);
      }
    }
    setOutlook({ types: types.data, days: dayList, cells });
    setLoaded(true);
  }

  useEffect(() => {
    load();
  }, []);

  // Rooms, the desk's calls, and reservations for the outlook below — a
  // booking being made doesn't change what an attendant has to clean today,
  // but it does change tomorrow's forecast.
  const { connected } = useLiveRefresh(() => load(), {
    channels: channels('rooms', 'housekeeping', 'reservations'),
  });

  const outlookOcc = useMemo(() => outlookOccupancy(outlook, localDay), [outlook]);

  const counts = useMemo(() => {
    const c = {};
    for (const r of rooms) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [rooms]);

  const myRooms = useMemo(
    () => rooms.filter((r) => r.assignedTo && r.assignedTo === user?.id),
    [rooms, user]
  );

  // The one still-ringing call on each room, if any — Job Orders' Priority
  // and Requests columns read off this. Keyed by room NUMBER because that is
  // all a call carries (see POST /housekeeping-calls); a room with more than
  // one open call keeps only the latest, same as the ringing modal would.
  const openCallByRoom = useMemo(() => {
    const m = new Map();
    for (const c of calls) if (!c.answeredAt) m.set(c.roomNumber, c);
    return m;
  }, [calls]);

  // History's three tabs — an answered call is either Accepted or Declined,
  // and a call still ringing belongs in neither, so it only shows up under
  // All (with its own "Waiting …" pill, same as before).
  const acceptedCalls = useMemo(() => calls.filter((c) => c.answeredAt && c.accepted), [calls]);
  const declinedCalls = useMemo(() => calls.filter((c) => c.answeredAt && !c.accepted), [calls]);

  const visibleCalls =
    callTab === 'Accepted' ? acceptedCalls : callTab === 'Declined' ? declinedCalls : calls;

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

  return (
    <div>
      <div className="page-head" data-tour="g-dashboard-hk-head">
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

      {/* ── Board: where every room stands right now ── */}
      <div className="panel" data-tour="g-dashboard-hk-status">
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

      {/* Job orders and History side by side — the two worklists this role
          actually clears, at equal weight. Below the two-column breakpoint
          they stack, same as the status board's own tiles. */}
      <div className="hkd-cols">
        {/* ── Job orders ── */}
        <div className="panel" data-tour="g-dashboard-hk-jobs">
          <h3>
            Job orders{' '}
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
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ minWidth: 520 }}>
                <thead>
                  <tr>
                    <th>Room</th>
                    <th>Status</th>
                    <th>Priority</th>
                    <th>Requests</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {myRooms.map((r) => {
                    const call = openCallByRoom.get(r.number);
                    const pri = call
                      ? CALL_PRIORITY[call.reason] || CALL_PRIORITY.DEFAULT
                      : CALL_PRIORITY.NONE;
                    return (
                      <tr key={r.id}>
                        <td>
                          <strong>{r.number}</strong>
                        </td>
                        <td>
                          <RoomStatusPill status={r.status} />
                        </td>
                        <td>
                          <Pill bg={pri.bg} fg={pri.fg}>
                            {pri.label}
                          </Pill>
                        </td>
                        <td>
                          {call ? (
                            <>
                              <div>{CALL_REASON_LABEL[call.reason] || call.reason}</div>
                              {call.note && (
                                <div className="muted" style={{ fontSize: 12 }}>
                                  {call.note}
                                </div>
                              )}
                            </>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button className="secondary small" onClick={() => navigate('/housekeeping')}>
                            Open
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── History — every call from the front desk, answered or not.
            Same table this panel always had; only the tabs and the title
            changed (it used to default to "Waiting", which is also the one
            KPI tile above and the live ringing modal already cover). */}
        <div className="panel" data-tour="g-dashboard-hk-history">
          <h3>History</h3>
          <div className="tabs-pill" data-tour="g-dashboard-hk-histtabs" style={{ marginBottom: 10 }}>
            {['Accepted', 'Declined', 'All'].map((t) => (
              <button key={t} className={callTab === t ? 'active' : ''} onClick={() => setCallTab(t)}>
                {t}
              </button>
            ))}
          </div>
          {visibleCalls.length === 0 ? (
            <EmptyState
              kind="inbox"
              title={
                callTab === 'Accepted'
                  ? 'No accepted calls yet'
                  : callTab === 'Declined'
                    ? 'No declined calls'
                    : 'No calls yet'
              }
              hint="The front desk rings housekeeping from the room map. Every call is logged here, answered or not."
            />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ minWidth: 560 }}>
                <thead>
                  <tr>
                    <th>Job #</th>
                    <th>Room</th>
                    <th>Time</th>
                    <th>Reason</th>
                    <th>From</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visibleCalls.map((c) => (
                    <tr key={c.id}>
                      {/* Calls have no sequential number of their own (unlike a
                          work order's workOrderNumber) — this is the id's tail,
                          just so a call is something you can point at in
                          conversation ("CL-4F2A9B") rather than only by room
                          and time. */}
                      <td className="muted" style={{ fontSize: 12 }}>
                        CL-{c.id.slice(-6).toUpperCase()}
                      </td>
                      <td>
                        <strong>{c.roomNumber}</strong>
                      </td>
                      <td title={new Date(c.placedAt).toLocaleString()}>{clockTime(c.placedAt)}</td>
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
                          <Pill
                            bg="#dcfce7"
                            fg="#16a34a"
                            title={
                              c.replyMessage
                                ? `${new Date(c.answeredAt).toLocaleString()} — “${c.replyMessage}”`
                                : new Date(c.answeredAt).toLocaleString()
                            }
                          >
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
            </div>
          )}
        </div>
      </div>

      {/* 14 Day Outlook — identical to the front-office dashboard's panel
          (same lib/outlookHeat helpers, same heat-* CSS), so demand reads the
          same way for whoever is looking at it. */}
      <div className="panel" data-tour="g-dashboard-hk-outlook">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>14 Day Outlook</h3>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent)' }}>
              {outlookOcc.pct.toFixed(2)}%
            </span>
            <span className="muted" style={{ fontSize: 11, textTransform: 'uppercase' }}>
              14-Day Occupancy
            </span>
          </div>
          {outlookOcc.series.length >= 2 && (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="muted" style={{ fontSize: 10 }}>
                TODAY
              </span>
              <SparkLine
                data={outlookOcc.series}
                color="var(--accent)"
                width={200}
                height={36}
                min={0}
                max={100}
                fill
              />
              <span className="muted" style={{ fontSize: 10 }}>
                +14d
              </span>
            </div>
          )}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="outlook-heat" style={{ minWidth: 800 }}>
            <thead>
              <tr>
                <th style={{ minWidth: 200 }}>Rooms left to sell</th>
                {outlook.days.map((d) => {
                  const weekend = d.getDay() === 0 || d.getDay() === 6;
                  return (
                    <th
                      key={d.toISOString()}
                      className={weekend ? 'weekend' : undefined}
                      style={{ textAlign: 'center', minWidth: 54 }}
                    >
                      <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                        {d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()}
                      </div>
                      <div style={{ fontWeight: 600, marginTop: 2 }}>{d.getDate()}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {outlook.types.length === 0 ? (
                loaded ? (
                  <tr>
                    <td colSpan={15} className="loading-row">
                      No room types yet.
                    </td>
                  </tr>
                ) : (
                  <SkeletonRows rows={4} cols={15} />
                )
              ) : (
                outlook.types.map((t) => (
                  <tr key={t.code}>
                    <td style={{ fontWeight: 500 }}>
                      {t.name}{' '}
                      <span className="muted" style={{ fontSize: 11 }}>
                        {t.totalInventory} rooms
                      </span>
                    </td>
                    {outlook.days.map((d) => {
                      const ds = localDay(d);
                      const avail = outlook.cells[`${t.code}|${ds}`] ?? 0;
                      const occ = occupancyOf(avail, t.totalInventory);
                      return (
                        <td key={ds} className="heat-cell">
                          <div
                            className="heat-box"
                            style={{ background: heatFill(occ), color: heatInk(occ) }}
                            title={heatTitle(t.name, d, avail, t.totalInventory)}
                          >
                            {avail}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="heat-legend" data-tour="g-dashboard-hk-legend">
          <span className="muted">Share of the room type already sold</span>
          {HEAT_LEGEND.map((l) => (
            <span key={l.label} className="heat-legend-item">
              <span className="heat-legend-swatch" style={{ background: l.fill }} />
              {l.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
