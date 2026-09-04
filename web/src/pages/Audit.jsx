import { useEffect, useState } from 'react';
import api from '../api';
import { useToast, errMsg } from '../components/Toast';
import { useLiveRefresh, channels } from '../lib/useLiveEvents';
import { pesosToCents, formatPeso } from '../lib/money';

export default function Audit() {
  const toast = useToast();
  const [current, setCurrent] = useState(null);
  const [days, setDays] = useState([]);
  const [nightlyRate, setNightlyRate] = useState('');
  const [inHouseCount, setInHouseCount] = useState(0);
  const [running, setRunning] = useState(false);

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
    if (!nightlyRate) {
      toast.error('Enter nightly rate first.');
      return;
    }
    if (
      !confirm(
        `Run night audit?\n\nWill post ₱${nightlyRate} room charge to ${inHouseCount} in-house stay(s), mark overdue reservations as no-show, and close the day.`
      )
    )
      return;
    setRunning(true);
    try {
      await api.post('/api/audit/run', { nightlyRateCents: pesosToCents(nightlyRate) });
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
      <h2>Night Audit</h2>

      <div className="panel">
        <h3>Current business day</h3>
        {current ? (
          <>
            <p>
              Date: <strong>{new Date(current.businessDate).toDateString()}</strong> · Status:{' '}
              <span className={`badge ${current.status.toLowerCase()}`}>{current.status}</span>
            </p>
            <div className="metrics" style={{ marginBottom: 12 }}>
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
            <div className="row">
              <div>
                <label>Nightly rate (₱)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="e.g. 1500.00"
                  value={nightlyRate}
                  onChange={(e) => setNightlyRate(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                <button onClick={run} disabled={running}>
                  {running ? <span className="spinner" /> : 'Run audit'}
                </button>
              </div>
            </div>
            <p className="muted">
              The audit posts a room charge to each in-house folio, combines all of the day's sales — rooms
              plus amenities, laundry, spa and visitor sales — marks overdue reservations as no-show, and
              closes the day.
            </p>
          </>
        ) : (
          <>
            <p className="muted">No open business day.</p>
            <button onClick={openDay}>Open today</button>
          </>
        )}
      </div>

      <div className="panel">
        <h3>History</h3>
        {days.length === 0 ? (
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
                  <td>
                    <span className={`badge ${d.status.toLowerCase()}`}>{d.status}</span>
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
