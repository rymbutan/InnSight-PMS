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
          <div>
            <button onClick={load} disabled={loading}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          {data?.checkedAt && (
            <div className="muted" style={{ alignSelf: 'flex-end' }}>
              Checked: {new Date(data.checkedAt).toLocaleTimeString()}
            </div>
          )}
        </div>
        {data?.services ? (
          <table>
            <thead>
              <tr>
                <th>Service</th>
                <th>Status</th>
                <th>HTTP</th>
                <th>Latency</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {data.services.map((s) => (
                <tr key={s.service}>
                  <td>{s.service}</td>
                  <td>
                    <span className={`badge ${s.status === 'up' ? 'clean' : 'dirty'}`}>{s.status}</span>
                  </td>
                  <td>{s.httpCode ?? '—'}</td>
                  <td>{s.latencyMs} ms</td>
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
