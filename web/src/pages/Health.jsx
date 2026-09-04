import { useEffect, useState } from 'react';
import api from '../api';
import { useToast, errMsg } from '../components/Toast';

export default function Health() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await api.get('/api/health/services');
      setData(r.data);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  return (
    <div>
      <h2>Service Health</h2>
      <div className="panel">
        <div className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
          <div>
            <div className="muted">Overall</div>
            <div>
              <span className={`badge ${data?.overall === 'up' ? 'clean' : 'dirty'}`}>
                {data?.overall || '—'}
              </span>
            </div>
          </div>
          {/* Refresh moved AFTER the timestamp, so the action sits at the far
              right of the strip. It was between the two readouts, which put a
              button in the middle of a line of status text — the one place
              nothing is clickable. */}
          {data?.checkedAt && (
            <div className="muted" style={{ alignSelf: 'flex-end' }}>
              Checked: {new Date(data.checkedAt).toLocaleTimeString()}
            </div>
          )}
          <div className="row-action">
            <button onClick={load} disabled={loading}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>
        {data?.services ? (
          <table>
            <thead>
              <tr>
                <th>Service</th>
                <th className="t-c">Status</th>
                <th className="t-c">HTTP</th>
                <th className="t-n">Latency</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {data.services.map((s) => (
                <tr key={s.service}>
                  <td>{s.service}</td>
                  <td className="t-c">
                    <span className={`badge ${s.status === 'up' ? 'clean' : 'dirty'}`}>{s.status}</span>
                  </td>
                  <td className="t-c">{s.httpCode ?? '—'}</td>
                  <td className="t-n">{s.latencyMs} ms</td>
                  <td className="muted">{s.error || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="loading-row">Loading…</div>
        )}
      </div>
    </div>
  );
}
