// Revenue management page — pulls audit-day history, computes pickup pace
// and a 14-day occupancy forecast via linear regression on the trailing
// 30 days. Designed to demonstrate yield management concepts on the thesis
// defense without leaning on a full revenue-management engine.

import { useEffect, useMemo, useState } from 'react';
import api from '../api';
import { useToast, errMsg } from '../components/Toast';
import { formatPeso } from '../lib/money';
import { SparkLine, BarChart, DonutChart } from '../components/Chart';
import EmptyState from '../components/EmptyState';

// Simple linear regression: y = mx + b. Returns predict(x) and quality (R²).
function linearForecast(data) {
  const n = data.length;
  if (n < 2) return null;
  const xs = data.map((_, i) => i);
  const xMean = xs.reduce((s, x) => s + x, 0) / n;
  const yMean = data.reduce((s, y) => s + y, 0) / n;
  let num = 0,
    den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (data[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  const m = den === 0 ? 0 : num / den;
  const b = yMean - m * xMean;
  // R² (coefficient of determination)
  let ssRes = 0,
    ssTot = 0;
  for (let i = 0; i < n; i++) {
    const yPred = m * xs[i] + b;
    ssRes += (data[i] - yPred) ** 2;
    ssTot += (data[i] - yMean) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { predict: (x) => m * x + b, m, b, r2 };
}

export default function Revenue() {
  const toast = useToast();
  const [days, setDays] = useState([]);
  const [reservations, setReservations] = useState([]);
  const [_loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.get('/api/audit/days'), api.get('/api/reservations').catch(() => ({ data: [] }))])
      .then(([d, r]) => {
        setDays((d.data || []).slice().sort((a, b) => new Date(a.businessDate) - new Date(b.businessDate)));
        setReservations(r.data || []);
      })
      .catch((e) => toast.error(errMsg(e)))
      .finally(() => setLoading(false));
  }, []);

  const occSeries = days.map((d) => d.occupancyPct || 0);
  // adr / revPar are stored in cents; the charts format as ₱ whole pesos.
  const adrSeries = days.map((d) => (d.adr || 0) / 100);
  const revparSeries = days.map((d) => (d.revPar || 0) / 100);
  const _revenueSeries = days.map((d) => Number(d.roomRevenueCents || 0) / 100);

  const forecast = useMemo(() => {
    const trail = occSeries.slice(-30);
    const fit = linearForecast(trail);
    if (!fit) return null;
    const next14 = Array.from({ length: 14 }, (_, i) =>
      Math.max(0, Math.min(100, fit.predict(trail.length + i)))
    );
    return { next14, r2: fit.r2 };
  }, [occSeries]);

  const totals = useMemo(() => {
    const last30 = days.slice(-30);
    const totalRev = last30.reduce((s, d) => s + Number(d.roomRevenueCents || 0), 0);
    const avgOcc = last30.length ? last30.reduce((s, d) => s + (d.occupancyPct || 0), 0) / last30.length : 0;
    const avgAdr = last30.length ? last30.reduce((s, d) => s + (d.adr || 0), 0) / last30.length : 0;
    const avgRevPar = last30.length ? last30.reduce((s, d) => s + (d.revPar || 0), 0) / last30.length : 0;
    return { totalRev, avgOcc, avgAdr, avgRevPar };
  }, [days]);

  // Source mix donut from current reservations
  const sourceMix = useMemo(() => {
    const counts = {};
    for (const r of reservations) {
      const s = r.source || 'DIRECT';
      counts[s] = (counts[s] || 0) + 1;
    }
    const palette = {
      DIRECT: '#22c55e',
      WALK_IN: '#06b6d4',
      BOOKING_COM: '#3b82f6',
      AIRBNB: '#ef4444',
      EXPEDIA: '#f59e0b',
      AGODA: '#8b5cf6',
      OTA: '#94a3b8',
    };
    return Object.entries(counts).map(([k, v]) => ({
      label: k.replace('_', ' '),
      value: v,
      color: palette[k] || '#94a3b8',
    }));
  }, [reservations]);

  // Length-of-stay distribution
  const losDist = useMemo(() => {
    const buckets = { 1: 0, '2-3': 0, '4-7': 0, '8+': 0 };
    for (const r of reservations) {
      const n = r.nights || 1;
      if (n === 1) buckets['1']++;
      else if (n <= 3) buckets['2-3']++;
      else if (n <= 7) buckets['4-7']++;
      else buckets['8+']++;
    }
    return buckets;
  }, [reservations]);

  return (
    <div>
      <div className="page-head">
        <h1>Revenue management</h1>
        <span className="muted">Trailing 30 days · forecast next 14</span>
      </div>

      <div className="kpi-row">
        <div className="kpi-tile">
          <div>
            <div className="kpi-num">{totals.avgOcc.toFixed(1)}%</div>
            <div className="kpi-label">Avg occupancy (30d)</div>
          </div>
        </div>
        <div className="kpi-tile">
          <div>
            <div className="kpi-num">{formatPeso(totals.avgAdr)}</div>
            <div className="kpi-label">Avg ADR</div>
          </div>
        </div>
        <div className="kpi-tile">
          <div>
            <div className="kpi-num">{formatPeso(totals.avgRevPar)}</div>
            <div className="kpi-label">Avg RevPAR</div>
          </div>
        </div>
        <div className="kpi-tile">
          <div>
            <div className="kpi-num">{formatPeso(totals.totalRev)}</div>
            <div className="kpi-label">Room revenue (30d)</div>
          </div>
        </div>
      </div>

      <div className="row" style={{ alignItems: 'stretch' }}>
        <div className="panel" style={{ flex: 2 }}>
          <h3>Occupancy trend & 14-day forecast</h3>
          {occSeries.length < 2 ? (
            <EmptyState
              kind="chart"
              title="Run more night audits"
              hint="At least 2 audited days are needed to fit a forecast."
            />
          ) : (
            <>
              <SparkLine
                data={[...occSeries.slice(-30), ...(forecast?.next14 || [])]}
                width={640}
                height={120}
                color="var(--accent)"
              />
              {forecast && (
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  Linear regression · R² = {forecast.r2.toFixed(2)} · forecast tomorrow:{' '}
                  <strong>{forecast.next14[0].toFixed(1)}%</strong>, +14 days:{' '}
                  <strong>{forecast.next14[forecast.next14.length - 1].toFixed(1)}%</strong>
                </div>
              )}
            </>
          )}
        </div>
        <div className="panel" style={{ flex: 1 }}>
          <h3>Booking source mix</h3>
          {sourceMix.length === 0 ? (
            <EmptyState kind="inbox" title="No reservations yet" />
          ) : (
            <DonutChart segments={sourceMix} size={140} thickness={20} />
          )}
        </div>
      </div>

      <div className="row" style={{ alignItems: 'stretch' }}>
        <div className="panel" style={{ flex: 1 }}>
          <h3>ADR per day</h3>
          {adrSeries.length < 2 ? (
            <EmptyState kind="chart" title="No data" />
          ) : (
            <BarChart
              data={adrSeries.slice(-14)}
              labels={days
                .slice(-14)
                .map((d) =>
                  new Date(d.businessDate).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
                )}
              color="#16a34a"
              width={420}
              height={120}
              format={(v) => `₱${v.toFixed(0)}`}
            />
          )}
        </div>
        <div className="panel" style={{ flex: 1 }}>
          <h3>RevPAR per day</h3>
          {revparSeries.length < 2 ? (
            <EmptyState kind="chart" title="No data" />
          ) : (
            <BarChart
              data={revparSeries.slice(-14)}
              labels={days
                .slice(-14)
                .map((d) =>
                  new Date(d.businessDate).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
                )}
              color="#8b5cf6"
              width={420}
              height={120}
              format={(v) => `₱${v.toFixed(0)}`}
            />
          )}
        </div>
      </div>

      <div className="panel">
        <h3>Length of stay distribution</h3>
        <BarChart
          data={Object.values(losDist)}
          labels={Object.keys(losDist).map((k) => `${k} night${k === '1' ? '' : 's'}`)}
          color="#06b6d4"
          width={420}
          height={120}
        />
      </div>
    </div>
  );
}
