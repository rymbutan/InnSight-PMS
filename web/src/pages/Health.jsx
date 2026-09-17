import { useEffect, useState } from 'react';
import api from '../api';
import Icon from '../components/Icon';
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

      {/* Outbound mail, above the service table rather than inside it: it is not
          a container that is up or down, and burying it in a row of nine would
          make the one state an admin most needs to notice the easiest to skim
          past. A forgot-password link that silently never arrives is the defect
          this panel exists to make visible — the API answers an identical 202
          either way, by design, so nothing else on the screen can say it. */}
      {data?.mail && data.mail.status !== 'delivering' && (
        <div className="panel" role="status">
          <div className="row" style={{ alignItems: 'flex-start', gap: 10, marginBottom: 0 }}>
            <Icon name="alert-circle" size={18} strokeWidth={1.9} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 650, marginBottom: 2 }}>
                {data.mail.status === 'capture-only'
                  ? 'Email is not being delivered'
                  : 'Email is not configured'}
              </div>
              <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                {data.mail.detail}
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                Sending via <strong>{data.mail.host}</strong> as <strong>{data.mail.from}</strong>
                {' · '}
                authenticated: <strong>{data.mail.authenticated ? 'yes' : 'no'}</strong>
              </div>
            </div>
            <span className="badge dirty">{data.mail.status}</span>
          </div>
        </div>
      )}

      {data?.mail?.status === 'delivering' && (
        <div className="panel">
          <div className="row" style={{ alignItems: 'center', gap: 10, marginBottom: 0 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="muted">Outbound email</div>
              <div style={{ fontSize: 13 }}>
                Sending via <strong>{data.mail.host}</strong> as <strong>{data.mail.from}</strong>
              </div>
            </div>
            <span className="badge clean">delivering</span>
          </div>
        </div>
      )}

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
