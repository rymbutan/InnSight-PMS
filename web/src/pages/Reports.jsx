import { useState } from 'react';
import api from '../api';
import { useToast, errMsg } from '../components/Toast';
import { formatPeso } from '../lib/money';
import { BarChart } from '../components/Chart';
import EmptyState from '../components/EmptyState';

const TYPES = [
  { value: 'occupancy', label: 'Occupancy (date range)' },
  { value: 'revenue', label: 'Revenue (date range)' },
  { value: 'amenities', label: 'Amenity revenue (date range)' },
  { value: 'arrivals', label: 'Arrivals (single date)' },
  { value: 'departures', label: 'Departures (single date)' },
  { value: 'in-house', label: 'In-House Guests' },
  { value: 'room-status', label: 'Room status' },
];

function toCSV(rows, columns) {
  const header = columns.map((c) => c.label).join(',');
  const body = rows
    .map((r) =>
      columns
        .map((c) => {
          const v = typeof c.accessor === 'function' ? c.accessor(r) : r[c.accessor];
          const s = v == null ? '' : String(v).replace(/"/g, '""');
          return /[",\n]/.test(s) ? `"${s}"` : s;
        })
        .join(',')
    )
    .join('\n');
  return header + '\n' + body;
}

function download(filename, content) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function Reports() {
  const toast = useToast();
  const [type, setType] = useState('occupancy');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    setResult(null);
    setLoading(true);
    try {
      let url = `/api/reports/${type}`;
      const params = new URLSearchParams();
      if (type === 'arrivals' || type === 'departures') {
        if (from) params.set('date', from);
      } else {
        if (from) params.set('from', from);
        if (to) params.set('to', to);
      }
      if (params.toString()) url += `?${params.toString()}`;
      const { data } = await api.get(url);
      setResult({ type, data });
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }

  const needsRange = type === 'occupancy' || type === 'revenue' || type === 'amenities';
  const needsDate = type === 'arrivals' || type === 'departures';

  return (
    <div>
      <h2>Reports</h2>
      <div className="panel">
        <div className="row">
          <div>
            <label>Report</label>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          {needsRange && (
            <>
              <div>
                <label>From</label>
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div>
                <label>To</label>
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </>
          )}
          {needsDate && (
            <div>
              <label>Date</label>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button onClick={run} disabled={loading}>
              {loading ? <span className="spinner" /> : 'Run'}
            </button>
          </div>
        </div>
      </div>

      {result && <RenderReport type={result.type} data={result.data} />}
    </div>
  );
}

function RenderReport({ type, data }) {
  if (type === 'occupancy') {
    const rows = data.rows || [];
    const cols = [
      { label: 'Date', accessor: (r) => new Date(r.businessDate).toLocaleDateString() },
      { label: 'Status', accessor: 'status' },
      { label: 'Occupancy %', accessor: (r) => (r.occupancyPct ?? 0).toFixed(1) },
      { label: 'ADR', accessor: (r) => formatPeso(r.adr ?? 0) },
      { label: 'RevPAR', accessor: (r) => formatPeso(r.revPar ?? 0) },
      { label: 'Room revenue', accessor: (r) => formatPeso(r.roomRevenueCents) },
    ];
    const trend = rows.map((r) => r.occupancyPct || 0);
    const labels = rows.map((r) =>
      new Date(r.businessDate).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
    );
    return (
      <>
        <div className="panel">
          <div className="metrics">
            <Metric label="Days" value={data.days} />
            <Metric label="Avg occupancy" value={`${(data.avgOccupancyPct || 0).toFixed(1)}%`} />
            <Metric label="Avg ADR" value={formatPeso(data.avgAdr || 0)} />
            <Metric label="Avg RevPAR" value={formatPeso(data.avgRevPar || 0)} />
          </div>
          {trend.length >= 2 && (
            <div style={{ marginTop: 12 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                Occupancy trend
              </div>
              <BarChart
                data={trend}
                labels={labels}
                color="var(--accent)"
                width={640}
                height={120}
                format={(v) => `${v.toFixed(1)}%`}
              />
            </div>
          )}
        </div>
        <ResultTable rows={rows} cols={cols} filename="occupancy.csv" />
      </>
    );
  }
  if (type === 'revenue') {
    const rows = data.rows || [];
    const cols = [
      { label: 'Date', accessor: (r) => new Date(r.businessDate).toLocaleDateString() },
      { label: 'Room revenue', accessor: (r) => formatPeso(r.roomRevenueCents) },
      { label: 'Other revenue', accessor: (r) => formatPeso(r.otherRevenueCents) },
      { label: 'Tax', accessor: (r) => formatPeso(r.taxCents) },
      { label: 'Payments', accessor: (r) => formatPeso(r.paymentsCents) },
    ];
    const t = data.totals || {};
    const revTrend = rows.map((r) => Number(r.roomRevenueCents || 0) / 100);
    const labels = rows.map((r) =>
      new Date(r.businessDate).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
    );
    return (
      <>
        <div className="panel">
          <div className="metrics">
            <Metric label="Room revenue" value={formatPeso(t.roomRevenueCents)} />
            <Metric label="Other revenue" value={formatPeso(t.otherRevenueCents)} />
            <Metric label="Tax" value={formatPeso(t.taxCents)} />
            <Metric label="Payments" value={formatPeso(t.paymentsCents)} />
          </div>
          {revTrend.length >= 2 && (
            <div style={{ marginTop: 12 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                Room revenue per day
              </div>
              <BarChart
                data={revTrend}
                labels={labels}
                color="#16a34a"
                width={640}
                height={120}
                format={(v) => `₱${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
              />
            </div>
          )}
        </div>
        <ResultTable rows={rows} cols={cols} filename="revenue.csv" />
      </>
    );
  }
  if (type === 'arrivals' || type === 'departures' || type === 'in-house') {
    const rows = data.rows || [];
    const cols = [
      { label: 'Stay', accessor: (r) => r.id?.slice(0, 8) },
      { label: 'Guest', accessor: 'guestName' },
      { label: 'Room', accessor: 'assignedRoomId' },
      { label: 'Status', accessor: 'status' },
      {
        label: 'Check-in',
        accessor: (r) =>
          r.actualCheckInAt || r.expectedCheckIn
            ? new Date(r.actualCheckInAt || r.expectedCheckIn).toLocaleString()
            : '—',
      },
      {
        label: 'Check-out',
        accessor: (r) =>
          r.actualCheckOutAt || r.expectedCheckOut
            ? new Date(r.actualCheckOutAt || r.expectedCheckOut).toLocaleString()
            : '—',
      },
    ];
    return (
      <>
        <div className="panel">
          <div className="metrics">
            <Metric label="Count" value={data.count} />
          </div>
        </div>
        <ResultTable rows={rows} cols={cols} filename={`${type}.csv`} />
      </>
    );
  }
  if (type === 'amenities') {
    const rows = data.rows || [];
    const cols = [
      { label: 'Code', accessor: 'code' },
      { label: 'Amenity', accessor: 'name' },
      { label: 'Category', accessor: (r) => (r.category || '').replace('_', ' ') },
      { label: 'Uses', accessor: 'count' },
      { label: 'Revenue', accessor: (r) => formatPeso(r.totalCents) },
    ];
    const bars = rows.map((r) => Number(r.totalCents || 0) / 100);
    const labels = rows.map((r) => r.name || r.code);
    return (
      <>
        <div className="panel">
          <div className="metrics">
            <Metric label="Total amenity revenue" value={formatPeso(data.totalCents)} />
            <Metric label="Total transactions" value={data.count} />
            <Metric label="Amenities sold" value={rows.length} />
          </div>
          {bars.length >= 2 && (
            <div style={{ marginTop: 12 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                Revenue by amenity
              </div>
              <BarChart
                data={bars}
                labels={labels}
                color="#8b5cf6"
                width={640}
                height={120}
                format={(v) => `₱${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
              />
            </div>
          )}
        </div>
        {rows.length === 0 ? (
          <EmptyState
            kind="inbox"
            title="No amenity sales in this range"
            hint="Record walk-in amenity sales from the Amenities page."
          />
        ) : (
          <ResultTable rows={rows} cols={cols} filename="amenity-revenue.csv" />
        )}
      </>
    );
  }
  if (type === 'room-status') {
    const rows = data.rows || [];
    const cols = [
      { label: 'Room', accessor: 'number' },
      { label: 'Type', accessor: 'typeCode' },
      { label: 'Floor', accessor: 'floor' },
      { label: 'Status', accessor: 'status' },
    ];
    return (
      <>
        <div className="panel">
          <div className="metrics">
            <Metric label="Total rooms" value={data.total} />
            {Object.entries(data.byStatus || {}).map(([k, v]) => (
              <Metric key={k} label={k} value={v} />
            ))}
          </div>
        </div>
        <ResultTable rows={rows} cols={cols} filename="room-status.csv" />
      </>
    );
  }
  return null;
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <div className="label">{label}</div>
      <div className="value">{value ?? '—'}</div>
    </div>
  );
}

function ResultTable({ rows, cols, filename }) {
  return (
    <div className="panel">
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}
      >
        <h3 style={{ margin: 0 }}>
          {rows.length} row{rows.length !== 1 ? 's' : ''}
        </h3>
        {rows.length > 0 && (
          <button className="small secondary" onClick={() => download(filename, toCSV(rows, cols))}>
            Export CSV
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <EmptyState
          kind="chart"
          title="No data"
          hint="Adjust the date range or run a night audit to populate this report."
        />
      ) : (
        <table>
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.label}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {cols.map((c) => {
                  const v = typeof c.accessor === 'function' ? c.accessor(r) : r[c.accessor];
                  return <td key={c.label}>{v ?? '—'}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
