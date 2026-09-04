import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api';
import { useToast, errMsg } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { pesosToCents, formatPeso } from '../lib/money';
import { useLiveRefresh, channels } from '../lib/useLiveEvents';
import { downloadAuthed } from '../lib/download';

export default function Folios() {
  const [searchParams] = useSearchParams();
  const toast = useToast();
  const confirm = useConfirm();
  const [folioId, setFolioId] = useState(searchParams.get('id') || '');
  const [folio, setFolio] = useState(null);
  const [statement, setStatement] = useState(null);
  const [charge, setCharge] = useState({ chargeCode: '', description: '', amount: '' });
  const [payment, setPayment] = useState({ method: 'CASH', amount: '' });
  const [deposit, setDeposit] = useState({ method: 'CASH', amount: '' });
  const [codes, setCodes] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api
      .get('/api/charge-codes')
      .then((r) => setCodes(r.data))
      .catch(() => {});
  }, []);

  // `live` marks an SSE-triggered reload. Refresh in place rather than showing
  // the skeleton, so the list does not blank on every event from any module.
  async function load(id, { live = false } = {}) {
    const target = id || folioId;
    if (!target) return;
    if (!live) setLoading(true);
    try {
      const [f, s] = await Promise.all([
        api.get(`/api/folios/${target}`),
        api.get(`/api/folios/${target}/statement`),
      ]);
      setFolio(f.data);
      setStatement(s.data);
      setFolioId(target);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const qid = searchParams.get('id');
    if (qid) load(qid);
  }, [searchParams]);

  // Live: a charge, payment, refund, deposit or settlement posted from another
  // screen (or by the night audit) refreshes the open folio automatically.
  //
  // Live scope — folio transactions only. This screen shows one folio's ledger;
  // it does not care that a room was cleaned or a reservation was booked.
  useLiveRefresh(
    (opts) => {
      if (folioId) load(folioId, opts);
    },
    { channels: channels('folio') }
  );

  async function postCharge(e) {
    e.preventDefault();
    try {
      await api.post(`/api/folios/${folioId}/charges`, {
        chargeCode: charge.chargeCode,
        description: charge.description,
        amountCents: pesosToCents(charge.amount),
      });
      toast.success('Charge posted.');
      setCharge({ chargeCode: '', description: '', amount: '' });
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  async function postPayment(e) {
    e.preventDefault();
    try {
      await api.post(`/api/folios/${folioId}/payments`, {
        method: payment.method,
        amountCents: pesosToCents(payment.amount),
      });
      toast.success('Payment posted.');
      setPayment({ method: 'CASH', amount: '' });
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  async function postDeposit(e) {
    e.preventDefault();
    try {
      await api.post(`/api/folios/${folioId}/deposit`, {
        method: deposit.method,
        amountCents: pesosToCents(deposit.amount),
      });
      toast.success('Deposit recorded.');
      setDeposit({ method: 'CASH', amount: '' });
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  // window.open sends no Authorization header, so this used to open a tab showing
  // {"error":"Missing bearer token."} — see lib/download.js.
  async function printPdf() {
    try {
      await downloadAuthed(`/api/folios/${folioId}/print`, {
        filename: `folio-${folio?.folioNumber || folioId}.pdf`,
      });
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  async function closeFolio() {
    const ok = await confirm({
      title: 'Close folio',
      message: 'Close this folio?',
      detail: 'This cannot be undone — no further charges or payments can be posted to it.',
      confirmLabel: 'Close folio',
    });
    if (!ok) return;
    try {
      await api.post(`/api/folios/${folioId}/close`);
      toast.success('Folio closed.');
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  return (
    <div>
      <h2>Folios</h2>

      <div className="panel">
        <h3>Open a folio</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <input placeholder="Folio id" value={folioId} onChange={(e) => setFolioId(e.target.value)} />
          <button onClick={() => load()} disabled={loading}>
            {loading ? <span className="spinner" /> : 'Open'}
          </button>
          {folio && (
            <button className="secondary" onClick={printPdf}>
              Print PDF
            </button>
          )}
          {folio && folio.status === 'OPEN' && (
            <button className="danger" onClick={closeFolio}>
              Close folio
            </button>
          )}
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          Tip: open a folio from the Arrivals page's "Folio" button to skip typing the id.
        </p>
      </div>

      {folio && (
        <>
          <div className="panel">
            <h3>
              Folio {folio.folioNumber} ·{' '}
              <span className={`badge ${folio.status.toLowerCase()}`}>{folio.status}</span>
            </h3>
            <div className="metrics">
              <div className="metric">
                <div className="label">Balance</div>
                <div className="value">
                  {formatPeso(statement?.balanceCents || 0, { currency: folio.currency })}
                </div>
              </div>
              <div className="metric">
                <div className="label">Charges</div>
                <div className="value">{statement?.totalCharges ?? 0}</div>
              </div>
              <div className="metric">
                <div className="label">Payments</div>
                <div className="value">{statement?.totalPayments ?? 0}</div>
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="t-c">Type</th>
                  <th>Code</th>
                  <th>Description</th>
                  <th className="t-n">Amount</th>
                </tr>
              </thead>
              <tbody>
                {folio.transactions.map((t) => (
                  <tr key={t.id}>
                    <td>{new Date(t.postedAt).toLocaleDateString()}</td>
                    <td className="t-c">
                      <span className={`badge ${t.type.toLowerCase()}`}>{t.type}</span>
                    </td>
                    <td>{t.chargeCode || '—'}</td>
                    <td>{t.description}</td>
                    <td className="t-n">{formatPeso(t.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h3>Post charge</h3>
            <form onSubmit={postCharge}>
              <div className="row">
                <div>
                  <label>Charge code</label>
                  <select
                    value={charge.chargeCode}
                    onChange={(e) => setCharge({ ...charge, chargeCode: e.target.value })}
                  >
                    <option value="">—</option>
                    {codes.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.code} — {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label>Description</label>
                  <input
                    required
                    value={charge.description}
                    onChange={(e) => setCharge({ ...charge, description: e.target.value })}
                  />
                </div>
                <div>
                  <label>Amount (₱)</label>
                  <input
                    required
                    type="number"
                    step="0.01"
                    min="0"
                    value={charge.amount}
                    onChange={(e) => setCharge({ ...charge, amount: e.target.value })}
                  />
                </div>
              </div>
              <button>Post charge</button>
            </form>
          </div>

          <div className="panel">
            <h3>Post payment</h3>
            <form onSubmit={postPayment}>
              <div className="row">
                <div>
                  <label>Method</label>
                  <select
                    value={payment.method}
                    onChange={(e) => setPayment({ ...payment, method: e.target.value })}
                  >
                    {['CASH', 'CARD', 'GCASH', 'BANK_TRANSFER'].map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label>Amount (₱)</label>
                  <input
                    required
                    type="number"
                    step="0.01"
                    min="0"
                    value={payment.amount}
                    onChange={(e) => setPayment({ ...payment, amount: e.target.value })}
                  />
                </div>
              </div>
              <button>Post payment</button>
            </form>
          </div>

          <div className="panel">
            <h3>Advance deposit</h3>
            <form onSubmit={postDeposit}>
              <div className="row">
                <div>
                  <label>Method</label>
                  <select
                    value={deposit.method}
                    onChange={(e) => setDeposit({ ...deposit, method: e.target.value })}
                  >
                    {['CASH', 'CARD', 'GCASH', 'BANK_TRANSFER'].map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label>Amount (₱)</label>
                  <input
                    required
                    type="number"
                    step="0.01"
                    min="0"
                    value={deposit.amount}
                    onChange={(e) => setDeposit({ ...deposit, amount: e.target.value })}
                  />
                </div>
              </div>
              <button>Record deposit</button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
