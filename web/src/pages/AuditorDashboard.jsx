// The auditor's own landing screen — distinct from FrontOfficeDashboard
// (Dashboard.jsx), which is built around arrivals/departures/booking, none of
// which an auditor acts on. This one is built around what an auditor actually
// does: certify the day's figures (Gross/VAT/Net, ADR/RevPAR/Occupancy),
// see where the money came from (booking channel, add-on sales), and clear
// folios for check-out (the audit-approve sign-off).
//
// Every figure here comes from an endpoint this role is already allowed to
// call — MGMT_AUDIT / DESK_AUDIT / FINANCE role groups in
// services/folio & services/reservation's auth middleware all include
// AUDITOR — so nothing on this page is a new grant, just a new arrangement
// of data this account could already reach.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { useToast, errMsg } from '../components/Toast';
import { formatPeso } from '../lib/money';
import { labelize } from '../lib/labels';
import { useLiveRefresh, channels } from '../lib/useLiveEvents';
import { DonutChart } from '../components/Chart';
import Icon from '../components/Icon';
import { computeBookingSourceMix } from '../lib/bookingSourceMix';

const FOLIO_TABS = ['Today', 'Week', 'Month'];

function inFolioRange(openedAt, tab) {
  const opened = new Date(openedAt);
  const now = new Date();
  if (tab === 'Today') return opened.toDateString() === now.toDateString();
  const cutoff = new Date(now);
  if (tab === 'Week') cutoff.setDate(cutoff.getDate() - 7);
  else cutoff.setMonth(cutoff.getMonth() - 1);
  return opened >= cutoff;
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

export default function AuditorDashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const [reservations, setReservations] = useState([]);
  const [history, setHistory] = useState([]);
  const [addOns, setAddOns] = useState({ totalCents: '0', byFacility: [] });
  const [folios, setFolios] = useState([]);
  const [folioTab, setFolioTab] = useState('Today');
  const [busyId, setBusyId] = useState(null);

  async function load() {
    try {
      const to = new Date();
      const from = new Date(to);
      from.setDate(from.getDate() - 30);
      const iso = (d) => d.toISOString().slice(0, 10);
      const [res, days, addonRes, folioRes] = await Promise.all([
        api.get('/api/reservations').catch(() => ({ data: [] })),
        // Audit-only history; returns newest business day first, same
        // contract Dashboard.jsx's FrontOfficeDashboard relies on.
        api.get('/api/audit/days').catch(() => ({ data: [] })),
        api.get(`/api/folios/amenity-revenue?from=${iso(from)}&to=${iso(to)}`).catch(() => ({
          data: { totalCents: '0', byFacility: [] },
        })),
        api.get('/api/folios').catch(() => ({ data: [] })),
      ]);
      setReservations(res.data);
      setHistory(days.data);
      setAddOns(addonRes.data);
      setFolios(folioRes.data);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  useEffect(() => {
    load();
  }, []);

  // Live scope — folio sign-offs/charges, reservations (for the channel mix)
  // and audit (for the day's Gross/VAT/Net once a night audit closes). NOT
  // rooms/stays/messaging: nothing on this screen renders them.
  const { connected } = useLiveRefresh(load, { channels: channels('folio', 'reservations', 'audit') });

  // Newest closed business day. /api/audit/days returns newest-first (see
  // Dashboard.jsx's own comment on the same call) — no reverse needed here
  // since this page only ever wants the single latest reading.
  const lastDay = history[0] || null;
  const grossCents = lastDay
    ? Number(lastDay.roomRevenueCents || 0) +
      Number(lastDay.facilityRevenueCents || 0) +
      Number(lastDay.otherRevenueCents || 0) +
      Number(lastDay.taxCents || 0)
    : 0;
  const vatCents = lastDay ? Number(lastDay.taxCents || 0) : 0;
  const netCents = grossCents - vatCents;

  const bookingSourceMix = useMemo(() => computeBookingSourceMix(reservations), [reservations]);
  const totalBookings = bookingSourceMix.reduce((s, x) => s + x.value, 0);

  const visibleFolios = useMemo(
    () =>
      folios
        .filter((f) => inFolioRange(f.openedAt, folioTab))
        .slice(0, 8),
    [folios, folioTab]
  );

  async function approve(folioId) {
    setBusyId(folioId);
    try {
      await api.post(`/api/folios/${folioId}/audit-approve`);
      toast.success('Folio approved — the guest can now be checked out.');
      load();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Auditor Dashboard</h1>
          <div className="subtle">
            {lastDay
              ? `Last closed day: ${new Date(lastDay.businessDate).toLocaleDateString(undefined, {
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })}`
              : 'No closed business day yet'}
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

      <div className="row" style={{ alignItems: 'stretch' }}>
        {/* Left column: channel mix, add-on revenue */}
        <div style={{ flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column' }}>
          <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div
              style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}
            >
              <h3 style={{ margin: 0 }}>Booking Channels</h3>
              <span className="muted" style={{ fontSize: 11, textTransform: 'uppercase' }}>
                {totalBookings} active
              </span>
            </div>
            {bookingSourceMix.length === 0 ? (
              <div className="muted" style={{ fontSize: 12 }}>
                No active reservations.
              </div>
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
                <DonutChart
                  segments={bookingSourceMix}
                  size={140}
                  thickness={20}
                  centerLabel={
                    <>
                      <div style={{ fontSize: 20, fontWeight: 700 }}>{totalBookings}</div>
                      <div className="muted" style={{ fontSize: 10, textTransform: 'uppercase' }}>
                        Bookings
                      </div>
                    </>
                  }
                />
              </div>
            )}
          </div>

          <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div
              style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}
            >
              <h3 style={{ margin: 0 }}>Add-on Revenue</h3>
              <span className="muted" style={{ fontSize: 11, textTransform: 'uppercase' }}>
                Last 30 days
              </span>
            </div>
            <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--accent)', marginBottom: 10 }}>
              {formatPeso(addOns.totalCents)}
            </div>
            {addOns.byFacility.length === 0 ? (
              <div className="muted" style={{ fontSize: 12 }}>
                No walk-in add-on sales in this range.
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Add-on</th>
                    <th className="t-c">Sales</th>
                    <th className="t-n">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {addOns.byFacility.slice(0, 6).map((f) => (
                    <tr key={f.code}>
                      <td>{f.code}</td>
                      <td className="t-c">{f.count}</td>
                      <td className="t-n">{formatPeso(f.totalCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Right column: the day's figures up top, folios needing review below */}
        <div style={{ flex: 1, minWidth: 360, display: 'flex', flexDirection: 'column' }}>
          <div className="panel">
            <h3 style={{ margin: '0 0 8px' }}>Day Summary</h3>
            {!lastDay ? (
              <div className="muted" style={{ fontSize: 12 }}>
                Run a night audit to see the day's figures.
              </div>
            ) : (
              <>
                <div className="metrics" style={{ marginBottom: 12 }}>
                  <Metric label="Gross" value={formatPeso(grossCents)} />
                  <Metric label="VAT" value={formatPeso(vatCents)} />
                  <Metric label="Net" value={formatPeso(netCents)} />
                </div>
                <div className="metrics">
                  <Metric label="Occupancy" value={`${(lastDay.occupancyPct ?? 0).toFixed(1)}%`} />
                  <Metric label="ADR" value={formatPeso(lastDay.adr)} />
                  <Metric label="RevPAR" value={formatPeso(lastDay.revPar)} />
                </div>
              </>
            )}
          </div>

          <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}
            >
              <h3 style={{ margin: 0 }}>Folio</h3>
              <button className="icon" title="Refresh" onClick={load}>
                <Icon name="refresh-cw" size={14} />
              </button>
            </div>
            <div className="tabs-pill" style={{ marginBottom: 12 }}>
              {FOLIO_TABS.map((t) => (
                <button key={t} className={folioTab === t ? 'active' : ''} onClick={() => setFolioTab(t)}>
                  {t}
                </button>
              ))}
            </div>
            <table>
              <thead>
                <tr>
                  <th>Guest</th>
                  <th>Folio #</th>
                  <th className="t-c">Status</th>
                  <th className="t-c"></th>
                </tr>
              </thead>
              <tbody>
                {visibleFolios.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="loading-row">
                      No folios opened this {folioTab.toLowerCase()}.
                    </td>
                  </tr>
                ) : (
                  visibleFolios.map((f) => (
                    <tr
                      key={f.id}
                      className="table-clickable"
                      onClick={() => navigate(`/folios/${f.id}`)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td className="table-link">{f.guestName || '—'}</td>
                      <td>{f.folioNumber}</td>
                      <td className="t-c">
                        <span className={`badge ${String(f.status).toLowerCase()}`}>{labelize(f.status)}</span>
                        {f.auditApprovedAt && (
                          <Icon
                            name="check-circle"
                            size={13}
                            style={{ marginLeft: 6, color: 'var(--text-success)', verticalAlign: 'middle' }}
                          />
                        )}
                      </td>
                      <td className="t-actions">
                        {f.status === 'OPEN' && !f.auditApprovedAt && (
                          <button
                            className="icon"
                            title="Approve for checkout"
                            disabled={busyId === f.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              approve(f.id);
                            }}
                          >
                            <Icon name="check-circle" size={14} />
                          </button>
                        )}
                        <button
                          className="icon"
                          title="Review"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(`/folios/${f.id}`);
                          }}
                        >
                          <Icon name="eye" size={14} />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
