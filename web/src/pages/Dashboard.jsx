import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { useToast, errMsg } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { useAuth } from '../auth';
import { formatPeso } from '../lib/money';
import { localDay, nightsBetween } from '../lib/date';
import { useLiveRefresh, channels } from '../lib/useLiveEvents';
import StatusPill from '../components/StatusPill';
import { SparkLine, BarChart } from '../components/Chart';
import { HEAT_LEGEND, heatFill, heatInk, heatTitle, occupancyOf } from '../lib/outlookHeat';
import Icon from '../components/Icon';
import HousekeepingDashboard from './HousekeepingDashboard';

const RES_TABS = ['Arrivals', 'Departures', 'Stayovers', 'In-House Guests', 'Pending Payment'];
// "Overbookings" used to sit here and could only ever have been empty: the
// inventory hold model makes overselling impossible (prove-no-double-booking.mjs
// asserts it, and availability is never allowed to go negative). "Sold out" is
// the operationally useful version of the same worry — where you are about to
// turn business away.
const ACTIVITY_TABS = ['Sales', 'Cancelations', 'Sold out'];

/** Local-midnight day arithmetic. `new Date(d).setDate(+n)` is what the rest of
 *  this page uses; kept as one helper so the activity buckets and the outlook
 *  agree on where a day starts. */
function addDaysLocal(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  x.setHours(0, 0, 0, 0);
  return x;
}

export default function Dashboard() {
  const { hasRole } = useAuth();
  // A pure housekeeping/maintenance account gets its own dashboard. Everything
  // below this line is front-office: arrivals, departures, occupancy, the
  // booking outlook, revenue history. A room attendant can act on none of it,
  // and the reservations/audit/revenue calls behind it 403 for that role and
  // get swallowed — so what they were actually shown was a page of empty tiles
  // built from requests that had already failed.
  //
  // An account that ALSO holds ADMIN or MANAGER keeps the full view: they
  // supervise housekeeping rather than work it, and the operational picture is
  // the one they came for. The housekeeping view stays one click away on the map.
  if (hasRole('HOUSEKEEPING_MAINTENANCE') && !hasRole('ADMIN', 'MANAGER', 'FRONT_DESK', 'AUDITOR')) {
    return <HousekeepingDashboard />;
  }
  return <FrontOfficeDashboard />;
}

function FrontOfficeDashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { hasRole } = useAuth();
  const canDelete = hasRole('ADMIN', 'MANAGER');
  const canBook = hasRole('ADMIN', 'MANAGER', 'FRONT_DESK');
  const [resTab, setResTab] = useState('Arrivals');
  const [resWhen, setResWhen] = useState('Today');
  const [actTab, setActTab] = useState('Sales');
  const [data, setData] = useState({
    arrivals: [],
    inHouse: [],
    departures: [],
    rooms: { byStatus: {}, total: 0 },
    history: [],
    reservations: [],
  });
  const [search, setSearch] = useState('');
  const [outlook, setOutlook] = useState({ types: [], days: [], cells: {} });

  async function load() {
    try {
      const [a, h, d, rs, days, res, types, _rooms] = await Promise.all([
        // NO `range` on purpose. The tile beside this one counts departures for
        // today only, and a bare /api/arrivals answers the same question:
        // arrivals DUE TODAY. Passing a range would instead ask for the desk's
        // worklist, which also carries every unbounded overdue no-show — the
        // tile read 14 on a day with no arrivals due. The worklist lives on the
        // Arrivals page, which sends `range` explicitly.
        api.get('/api/arrivals'),
        api.get('/api/in-house'),
        api.get('/api/departures'),
        // Fail-soft like its four neighbours below. This was the one call in
        // the batch without a catch, so any hiccup from the reports service
        // rejected the whole Promise.all and replaced the dashboard with a red
        // toast, while a failure of arrivals or reservations merely emptied a
        // panel. An empty room-status donut is the right way to lose this.
        api.get('/api/reports/room-status').catch(() => ({ data: { byStatus: {}, total: 0 } })),
        api.get('/api/audit/days').catch(() => ({ data: [] })),
        api.get('/api/reservations').catch(() => ({ data: [] })),
        api.get('/api/room-types').catch(() => ({ data: [] })),
        api.get('/api/rooms').catch(() => ({ data: [] })),
      ]);
      setData({
        // /api/arrivals returns { range, degraded, arrivals }. Tolerate a bare
        // array too, so a stale cached bundle cannot blank the dashboard during
        // a rolling deploy.
        arrivals: Array.isArray(a.data) ? a.data : a.data?.arrivals || [],
        inHouse: h.data,
        departures: d.data,
        rooms: rs.data,
        history: days.data.slice().reverse(),
        reservations: res.data,
      });
      // Build 14-day outlook
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const dayList = Array.from({ length: 14 }, (_, i) => {
        const dt = new Date(today);
        dt.setDate(today.getDate() + i);
        return dt;
      });
      const cells = {};
      // available per type per day = totalInventory − reservations covering that day for that type
      for (const t of types.data) {
        for (const day of dayList) {
          const ds = localDay(day);
          const reserved = res.data.filter((r) => {
            if (r.roomTypeCode !== t.code) return false;
            if (['CANCELLED', 'NO_SHOW'].includes(r.status)) return false;
            const ci = localDay(r.checkIn);
            const co = localDay(r.checkOut);
            return ci <= ds && ds < co;
          }).length;
          cells[`${t.code}|${ds}`] = Math.max(0, t.totalInventory - reserved);
        }
      }
      setOutlook({ types: types.data, days: dayList, cells });
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  useEffect(() => {
    load();
  }, []);

  // Admin/Manager only — server-enforced (services/reservation's
  // requireRole('ADMIN', 'MANAGER') on DELETE) and not offered at all to a
  // lower-tier role (canDelete gates the button below). Covers both the
  // Arrivals and Departures tabs of the Reservations panel, since both list
  // Reservation rows and share this one action. Refused by the server once
  // a real stay exists against the reservation (a departure whose guest
  // already checked in), which is the correct behaviour, not a bug — Cancel
  // is still the tool for that case.
  async function deleteReservation(r) {
    const ok = await confirm({
      title: 'Delete reservation',
      message: `Permanently delete the reservation for ${r.guestName || 'this guest'}?`,
      detail: 'This cannot be undone.',
      confirmLabel: 'Delete permanently',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/api/reservations/${r.id}`);
      toast.success('Reservation deleted.');
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  // Auto-populate: re-fetch whenever anything changes in another module
  // (a reservation is booked/cancelled, a guest checks in/out, a room is
  // cleaned, the night audit runs, a folio settles…). Debounced so a burst
  // of related events triggers a single reload.
  const {
    connected,
  } = // Live scope — occupancy + arrivals/departures/in-house + room status + the revenue KPIs
    // off the last closed business day. NOT maintenance or guest profiles: nothing
    // on this screen renders them.
    useLiveRefresh(load, { channels: channels('reservations', 'stays', 'rooms', 'folio', 'audit') });

  const totalRooms = data.rooms.total || 0;
  const occRoomCount = data.inHouse.length;
  const occPct = totalRooms > 0 ? (occRoomCount / totalRooms) * 100 : 0;
  // Latest closed business day drives the ADR / RevPAR / revenue KPIs (only
  // populated for roles that can read audit days — managers/admins/auditors).
  const lastDay = data.history.length ? data.history[data.history.length - 1] : null;

  const reservationsList = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const targetDate = resWhen === 'Today' ? today : tomorrow;
    let rows = [];
    if (resTab === 'Arrivals') {
      rows = data.reservations.filter((r) => {
        if (!['CONFIRMED', 'PENDING'].includes(r.status)) return false;
        const ci = new Date(r.checkIn);
        return ci.toDateString() === targetDate.toDateString();
      });
    } else if (resTab === 'Departures') {
      rows = data.reservations.filter((r) => {
        // Exclude terminal statuses — a cancelled/no-show booking is not a departure.
        if (['CANCELLED', 'NO_SHOW'].includes((r.status || '').toUpperCase())) return false;
        const co = new Date(r.checkOut);
        return co.toDateString() === targetDate.toDateString();
      });
    } else if (resTab === 'Stayovers') {
      rows = data.inHouse.filter((s) => {
        const co = new Date(s.expectedCheckOut);
        return co > targetDate;
      });
    } else if (resTab === 'In-House Guests') {
      rows = data.inHouse;
    } else if (resTab === 'Pending Payment') {
      rows = data.reservations.filter((r) => Number(r.depositCents || 0) === 0 && r.status === 'CONFIRMED');
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter((r) => (r.guestName || '').toLowerCase().includes(q));
    }
    return rows;
  }, [resTab, resWhen, search, data]);

  const todayBooked = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return data.reservations.filter(
      (r) => new Date(r.createdAt || r.bookedAt || r.checkIn).toDateString() === today.toDateString()
    );
  }, [data.reservations]);
  const roomNights = todayBooked.reduce((s, r) => s + nightsBetween(r.checkIn, r.checkOut), 0);

  /* ── Today's Activity ─────────────────────────────────────────────────────
     The three tabs used to be decoration: `actTab` was set by the buttons and
     read by nothing but the CSS `active` class, while the numbers and the table
     underneath stayed hardcoded to today's bookings whichever tab was lit. So
     the tabs highlighted and nothing changed.

     None of this needed a backend change — cancellations were already in the
     reservations payload, and sold-out dates fall straight out of the outlook
     availability the panel below already loads. */
  const activity = useMemo(() => {
    const DAYS_BACK = 14;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayList = Array.from({ length: DAYS_BACK }, (_, i) => addDaysLocal(today, i - (DAYS_BACK - 1)));
    const bucketKey = (d) => localDay(new Date(d));
    const emptyBuckets = () => Object.fromEntries(dayList.map((d) => [localDay(d), 0]));

    if (actTab === 'Cancelations') {
      const rows = data.reservations.filter((r) => ['CANCELLED', 'NO_SHOW'].includes(r.status));
      const buckets = emptyBuckets();
      for (const r of rows) {
        const k = bucketKey(r.updatedAt || r.cancelledAt || r.createdAt || r.checkIn);
        if (k in buckets) buckets[k] += 1;
      }
      return {
        dayList,
        series: dayList.map((d) => buckets[localDay(d)]),
        color: '#e34948',
        primary: { value: rows.length, label: 'Cancelled' },
        secondary: {
          value: rows.reduce((n, r) => n + nightsBetween(r.checkIn, r.checkOut), 0),
          label: 'Room nights lost',
        },
        rows: rows
          .slice()
          .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))
          .slice(0, 7)
          .map((r) => ({
            id: r.id,
            a: r.guestName,
            b: new Date(r.checkIn).toLocaleDateString(),
            c: nightsBetween(r.checkIn, r.checkOut),
          })),
        head: ['Guest', 'Check-in', 'Nights'],
        empty: 'No cancellations.',
      };
    }

    if (actTab === 'Sold out') {
      // A cell at zero availability is a room type with nothing left to sell on
      // that date. Counted per day so the chart shows WHEN the property tightens.
      const rows = [];
      const series = outlook.days.map((d) => {
        const ds = localDay(d);
        let n = 0;
        for (const t of outlook.types) {
          if ((outlook.cells[`${t.code}|${ds}`] ?? 1) === 0) {
            n += 1;
            rows.push({ id: `${t.code}-${ds}`, a: t.name, b: d.toLocaleDateString(), c: 'Sold out' });
          }
        }
        return n;
      });
      return {
        dayList: outlook.days,
        series,
        color: '#eb6834',
        primary: { value: rows.length, label: 'Sold-out dates' },
        secondary: {
          value: new Set(rows.map((r) => r.a)).size,
          label: 'Types affected',
        },
        rows: rows.slice(0, 7),
        head: ['Room type', 'Date', 'Status'],
        empty: 'Nothing sold out in the next 14 days.',
      };
    }

    // Sales — bookings by the day they were MADE, which is what a sales figure
    // counts, not the day the guest arrives.
    const buckets = emptyBuckets();
    for (const r of data.reservations) {
      if (['CANCELLED', 'NO_SHOW'].includes(r.status)) continue;
      const k = bucketKey(r.createdAt || r.bookedAt || r.checkIn);
      if (k in buckets) buckets[k] += 1;
    }
    return {
      dayList,
      series: dayList.map((d) => buckets[localDay(d)]),
      color: '#2976d2',
      primary: { value: todayBooked.length, label: 'Booked today' },
      secondary: { value: roomNights, label: 'Room nights' },
      rows: todayBooked.slice(0, 7).map((r) => ({
        id: r.id,
        a: r.guestName,
        b: new Date(r.checkIn).toLocaleDateString(),
        c: nightsBetween(r.checkIn, r.checkOut),
      })),
      head: ['Guest', 'Check-in', 'Nights'],
      empty: 'No bookings today.',
    };
  }, [actTab, data.reservations, todayBooked, roomNights, outlook]);

  const occupancyTrend = data.history.map((d) => d.occupancyPct || 0);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>
            {new Date().toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}
          </h1>
          <div className="subtle">{new Date().toLocaleDateString(undefined, { weekday: 'long' })}</div>
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
          {/* Booking is a desk job. The dashboard is the one screen every role
              lands on, so this button was offering Auditor and Housekeeping a
              route into a page they are not authorised for — a CTA that can only
              end in "not authorised" reads as the app being broken. Matches the
              guard on /reservations/new and on POST /api/reservations. */}
          {canBook && (
            <button className="btn-cta" onClick={() => navigate('/reservations/new')}>
              <Icon name="plus" size={14} style={{ marginRight: 6 }} />
              Create new reservation
            </button>
          )}
        </div>
      </div>

      <div className="kpi-row">
        <div className="kpi-tile kpi-arrivals">
          <div>
            <div className="kpi-num">{data.arrivals.length}</div>
            <div className="kpi-label">Arrivals</div>
          </div>
          <div className="kpi-icon">
            <Icon name="log-in" size={26} />
          </div>
        </div>
        <div className="kpi-tile kpi-departures">
          <div>
            <div className="kpi-num">{data.departures.length}</div>
            <div className="kpi-label">Departures</div>
          </div>
          <div className="kpi-icon">
            <Icon name="log-out" size={26} />
          </div>
        </div>
        <div className="kpi-tile kpi-booked">
          <div>
            <div className="kpi-num">{occRoomCount}</div>
            <div className="kpi-label" title="Accommodations booked">
              Booked
            </div>
          </div>
          <span className="kpi-pct">{occPct.toFixed(2)}%</span>
        </div>
        {lastDay && (
          <>
            <div className="kpi-tile">
              <div>
                <div className="kpi-num">{(lastDay.occupancyPct ?? 0).toFixed(1)}%</div>
                <div className="kpi-label" title="Occupancy (last audit)">
                  Occupancy
                </div>
              </div>
            </div>
            <div className="kpi-tile">
              <div>
                <div className="kpi-num">{formatPeso(lastDay.adr)}</div>
                <div className="kpi-label">ADR</div>
              </div>
            </div>
            <div className="kpi-tile">
              <div>
                <div className="kpi-num">{formatPeso(lastDay.revPar)}</div>
                <div className="kpi-label">RevPAR</div>
              </div>
            </div>
            <div className="kpi-tile">
              <div>
                <div className="kpi-num">{formatPeso(lastDay.roomRevenueCents)}</div>
                <div className="kpi-label" title="Room revenue (last audit)">
                  Room revenue
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="row" style={{ alignItems: 'stretch' }}>
        {/* Reservations panel */}
        <div className="panel" style={{ flex: 2, minWidth: 380 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
            }}
          >
            <h3 style={{ margin: 0 }}>Reservations</h3>
            <div style={{ display: 'flex', gap: 4 }}>
              <button className="icon" title="Refresh" onClick={load}>
                <Icon name="refresh-cw" size={14} />
              </button>
              <button className="icon" title="Print">
                <Icon name="printer" size={14} />
              </button>
            </div>
          </div>
          <div className="tabs-pill" style={{ marginBottom: 8 }}>
            {RES_TABS.map((t) => (
              <button key={t} className={resTab === t ? 'active' : ''} onClick={() => setResTab(t)}>
                {t}
              </button>
            ))}
          </div>
          {(resTab === 'Arrivals' || resTab === 'Departures') && (
            <div className="tabs-pill" style={{ marginBottom: 8, gap: 12 }}>
              {['Today', 'Tomorrow'].map((w) => (
                <button key={w} className={resWhen === w ? 'active' : ''} onClick={() => setResWhen(w)}>
                  {w}
                </button>
              ))}
            </div>
          )}
          <input
            placeholder="Guest Name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ marginBottom: 10 }}
          />
          <table>
            <thead>
              <tr>
                <th>Guest</th>
                <th>Conf #</th>
                <th className="t-c">Room</th>
                <th className="t-c">Status</th>
                <th className="t-c"></th>
              </tr>
            </thead>
            <tbody>
              {reservationsList.length === 0 ? (
                <tr>
                  <td colSpan={5} className="loading-row">
                    No {resTab.toLowerCase()}.
                  </td>
                </tr>
              ) : (
                reservationsList.slice(0, 7).map((r) => (
                  <tr
                    key={r.id}
                    className="table-clickable"
                    onClick={() => r.confirmationNumber && navigate(`/reservations/${r.id}`)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td className="table-link">{r.guestName || '—'}</td>
                    <td>{r.confirmationNumber || r.id?.slice(0, 8)}</td>
                    <td className="t-c">{r.assignedRoomId || r.roomTypeCode || '—'}</td>
                    <td className="t-c">
                      <StatusPill status={r.status || 'IN_HOUSE'} size="sm" />
                    </td>
                    <td className="t-actions">
                      <button
                        className="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (r.id) navigate(`/reservations/${r.id}`);
                        }}
                        title="Open to check in"
                      >
                        <Icon name="log-in" size={14} />
                      </button>
                      {/* r.confirmationNumber, not resTab: it's what tells a real
                          Reservation row (Arrivals/Departures/Pending Payment)
                          apart from a Stay row (Stayovers/In-House Guests), which
                          has no reservation of its own to delete here. */}
                      {canDelete && r.confirmationNumber && (
                        <button
                          className="icon danger"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteReservation(r);
                          }}
                          title="Delete reservation"
                        >
                          <Icon name="trash" size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Today's Activity panel */}
        <div className="panel" style={{ flex: 1.5, minWidth: 320 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
            }}
          >
            <h3 style={{ margin: 0 }}>Today's Activity</h3>
            <button className="icon" title="Refresh" onClick={load}>
              <Icon name="refresh-cw" size={14} />
            </button>
          </div>
          <div className="tabs-pill" style={{ marginBottom: 12 }}>
            {ACTIVITY_TABS.map((t) => (
              <button key={t} className={actTab === t ? 'active' : ''} onClick={() => setActTab(t)}>
                {t}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 28, marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--accent)' }}>
                {activity.primary.value}
              </div>
              <div
                className="muted"
                style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.05 }}
              >
                {activity.primary.label}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--accent)' }}>
                {activity.secondary.value}
              </div>
              <div
                className="muted"
                style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.05 }}
              >
                {activity.secondary.label}
              </div>
            </div>
          </div>

          {/* The shape of the fortnight at a glance. The list underneath is kept
              because it is the only way from this panel to a specific booking. */}
          <div className="dash-chart">
            <BarChart
              data={activity.series}
              labels={activity.dayList.map((d, i) => (i % 2 === 0 ? String(d.getDate()) : ''))}
              color={activity.color}
              width={620}
              height={96}
              format={(v) => v}
            />
          </div>

          <table>
            <thead>
              <tr>
                {activity.head.map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {activity.rows.length === 0 ? (
                <tr>
                  <td colSpan={3} className="loading-row">
                    {activity.empty}
                  </td>
                </tr>
              ) : (
                activity.rows.map((r) => {
                  // Only a reservation row can be opened; a sold-out date has
                  // nowhere to go, so it must not pretend to be clickable.
                  const clickable = actTab !== 'Sold out';
                  return (
                    <tr
                      key={r.id}
                      onClick={clickable ? () => navigate(`/reservations/${r.id}`) : undefined}
                      style={clickable ? { cursor: 'pointer' } : undefined}
                    >
                      <td className={clickable ? 'table-link' : undefined}>{r.a}</td>
                      <td>{r.b}</td>
                      <td>{r.c}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 14 Day Outlook */}
      <div className="panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>14 Day Outlook</h3>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent)' }}>
              {occPct.toFixed(2)}%
            </span>
            <span className="muted" style={{ fontSize: 11, textTransform: 'uppercase' }}>
              14-Day Occupancy
            </span>
          </div>
          {occupancyTrend.length >= 2 && (
            <div style={{ marginLeft: 'auto' }}>
              <SparkLine data={occupancyTrend} color="var(--accent)" width={200} height={36} />
            </div>
          )}
        </div>
        {/* A HEATMAP, not a grid of numbers. Fifty-six bare figures were all
            correct and told you almost nothing — and "24" means something very
            different for a Standard with 24 rooms than for a Presidential with
            3. The number stays, because it is what you act on; the colour says
            how full that type is, which normalises across types the raw count
            cannot. */}
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
                <tr>
                  <td colSpan={15} className="loading-row">
                    No room types yet.
                  </td>
                </tr>
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

        {/* Colour means nothing without a key, and the key is what turns this
            from decoration back into data. */}
        <div className="heat-legend">
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
