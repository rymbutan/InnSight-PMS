import { useEffect, useState } from 'react';
import api from '../api';
import Icon from '../components/Icon';
import { useToast, errMsg } from '../components/Toast';

// Splits "Display Name <address>" into its two halves so the card can give
// each its own line: run together in one sentence, the raw <address> read as
// clutter dropped into the middle of the text rather than the actual mailbox
// this is being sent from, which is the one fact in this card someone would
// come back to check.
function splitFrom(from) {
  const m = /^(.*?)\s*<(.+)>\s*$/.exec(from || '');
  return m ? { name: m[1], address: m[2] } : { name: from, address: null };
}

// One card, whichever state the mail is in — ok or not. There were two
// separately hand-built layouts here before: the failure state had an icon,
// a title, a detail line and an auth line stacked vertically with the badge
// pinned to the far end of a `flex-start` row; the healthy state had none of
// that, just a label over one sentence with the badge vertically centered
// beside it. They agreed on nothing but both containing a badge, so the one
// state an admin checks constantly (this one loads healthy far more often
// than not) looked like an afterthought next to the one state built to be
// noticed. Same skeleton for both now — icon, title, badge on one line, the
// sending address broken out onto its own — so the only thing that changes
// between "healthy" and "not" is which icon, title and detail line it holds.
function MailHealthCard({ mail }) {
  const ok = mail.status === 'delivering';
  const title = ok
    ? 'Outbound email'
    : mail.status === 'capture-only'
      ? 'Email is not being delivered'
      : 'Email is not configured';
  const { name, address } = splitFrom(mail.from);
  return (
    <div className="panel health-mail" role={ok ? undefined : 'status'} data-tour="g-health-mail">
      <div className="health-mail-head">
        <Icon name={ok ? 'mail' : 'alert-circle'} size={17} strokeWidth={1.9} />
        <span className="health-mail-title">{title}</span>
        <span className={`badge ${ok ? 'clean' : 'dirty'}`}>{mail.status}</span>
      </div>
      <div className="health-mail-from muted">
        Sending via <strong>{mail.host}</strong> as <strong>{name}</strong>
        {address && <span className="health-mail-addr">{address}</span>}
      </div>
      {mail.detail && <div className="health-mail-detail muted">{mail.detail}</div>}
      {!ok && (
        <div className="health-mail-detail muted">
          Authenticated: <strong>{mail.authenticated ? 'yes' : 'no'}</strong>
        </div>
      )}
    </div>
  );
}

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
      <div className="page-head">
        <div className="page-head-title">
          <h1>Service Health</h1>
        </div>
      </div>

      {/* Outbound mail, above the service table rather than inside it: it is not
          a container that is up or down, and burying it in a row of nine would
          make the one state an admin most needs to notice the easiest to skim
          past. A forgot-password link that silently never arrives is the defect
          this panel exists to make visible — the API answers an identical 202
          either way, by design, so nothing else on the screen can say it. */}
      {data?.mail && <MailHealthCard mail={data.mail} />}

      <div className="panel" data-tour="g-health-services">
        <div className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
          <div data-tour="g-health-overall">
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
            <button data-tour="g-health-refresh" onClick={load} disabled={loading}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>
        {data?.services ? (
          <table data-tour="g-health-table">
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
