import { useEffect, useState } from 'react';
import api from '../api';
import { SkeletonPanel, SkeletonTableBlock } from '../components/Skeleton';
import { useToast, errMsg } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { useLiveRefresh, channels } from '../lib/useLiveEvents';
import { formatPeso } from '../lib/money';
import { labelize } from '../lib/labels';
import SectionSwitcher, { REPORTS_SECTIONS } from '../components/SectionSwitcher';

export default function Audit() {
  const toast = useToast();
  const confirm = useConfirm();
  const [current, setCurrent] = useState(null);
  const [days, setDays] = useState([]);
  const [inHouseCount, setInHouseCount] = useState(0);
  const [running, setRunning] = useState(false);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    try {
      const [c, d, h] = await Promise.all([
        api.get('/api/audit/current'),
        api.get('/api/audit/days'),
        api.get('/api/in-house').catch(() => ({ data: [] })),
      ]);
      setCurrent(c.data);
      setDays(d.data);
      setInHouseCount(h.data.length);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoaded(true);
    }
  }
  useEffect(() => {
    load();
  }, []);
  // Keep the in-house count and day status live as things change elsewhere.
  // Live scope — the business-day list. Only opening/closing a day changes it.
  useLiveRefresh(load, { channels: channels('audit') });

  async function openDay() {
    try {
      await api.post('/api/audit/open-day', {});
      toast.success('Business day opened.');
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  async function run() {
    const ok = await confirm({
      title: 'Run night audit',
      message: 'Run night audit and close the business day?',
      detail: `Posts each of ${inHouseCount} in-house stay's own room charge, marks unarrived confirmed bookings as no-show, and auto-cancels overdue unconfirmed ones.`,
      confirmLabel: 'Run audit',
    });
    if (!ok) return;
    setRunning(true);
    try {
      await api.post('/api/audit/run', {});
      toast.success('Audit completed.');
      load();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div className="page-head-title">
          <h1>Night Audit</h1>
          <SectionSwitcher options={REPORTS_SECTIONS} />
        </div>
      </div>

      <div className="panel" data-tour="g-audit-current-day">
        <h3>Current business day</h3>
        {!loaded ? (
          <SkeletonPanel lines={5} label="Loading business day" />
        ) : current ? (
          <>
            <p>
              Date: <strong>{new Date(current.businessDate).toDateString()}</strong> · Status:{' '}
              <span className={`badge ${current.status.toLowerCase()}`}>{labelize(current.status)}</span>
            </p>
            <div className="metrics" style={{ marginBottom: 12 }} data-tour="g-audit-metrics">
              <div className="metric">
                <div className="label">In-house stays</div>
                <div className="value">{inHouseCount}</div>
              </div>
              <div className="metric">
                <div className="label">Room revenue</div>
                <div className="value">{formatPeso(current.roomRevenueCents ?? 0)}</div>
              </div>
              <div className="metric">
                <div className="label">Facility revenue</div>
                <div className="value">{formatPeso(current.facilityRevenueCents ?? 0)}</div>
              </div>
              <div className="metric">
                <div className="label">Other revenue</div>
                <div className="value">{formatPeso(current.otherRevenueCents ?? 0)}</div>
              </div>
              <div className="metric">
                <div className="label">Total revenue</div>
                <div className="value">
                  {formatPeso(
                    Number(current.roomRevenueCents ?? 0) +
                      Number(current.facilityRevenueCents ?? 0) +
                      Number(current.otherRevenueCents ?? 0)
                  )}
                </div>
              </div>
            </div>
            <div data-tour="tour-process-audit">
              <button data-tour="g-audit-run" onClick={run} disabled={running}>
                {running ? <span className="spinner" /> : 'Run audit'}
              </button>
            </div>
            <p className="muted" data-tour="g-audit-explain">
              The audit posts a room charge to each in-house folio, combines all of the day's sales — rooms
              plus amenities, laundry, spa and visitor sales — marks unarrived confirmed bookings as no-show,
              auto-cancels overdue unconfirmed bookings, and closes the day.
            </p>
          </>
        ) : (
          <>
            <p className="muted">No open business day.</p>
            <button data-tour="g-audit-open-day" onClick={openDay}>
              Open today
            </button>
          </>
        )}
      </div>

      <div className="panel" data-tour="g-audit-history">
        <h3>History</h3>
        {!loaded ? (
          <SkeletonTableBlock rows={5} cols={11} label="Loading audit history" />
        ) : days.length === 0 ? (
          <div className="loading-row">No audit history yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Status</th>
                <th>Arrivals</th>
                <th>Departures</th>
                <th>Occupancy</th>
                <th>ADR</th>
                <th>RevPAR</th>
                <th>Room revenue</th>
                <th>Facility revenue</th>
                <th>Other revenue</th>
                <th>Total revenue</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.id}>
                  <td>{new Date(d.businessDate).toDateString()}</td>
                  <td className="t-c">
                    <span className={`badge ${d.status.toLowerCase()}`}>{labelize(d.status)}</span>
                  </td>
                  <td>{d.arrivals ?? 0}</td>
                  <td>{d.departures ?? 0}</td>
                  <td>{(d.occupancyPct ?? 0).toFixed(1)}%</td>
                  <td>{formatPeso(d.adr ?? 0)}</td>
                  <td>{formatPeso(d.revPar ?? 0)}</td>
                  <td>{formatPeso(d.roomRevenueCents)}</td>
                  <td>{formatPeso(d.facilityRevenueCents ?? 0)}</td>
                  <td>{formatPeso(d.otherRevenueCents ?? 0)}</td>
                  <td>
                    {formatPeso(
                      Number(d.roomRevenueCents ?? 0) +
                        Number(d.facilityRevenueCents ?? 0) +
                        Number(d.otherRevenueCents ?? 0)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
