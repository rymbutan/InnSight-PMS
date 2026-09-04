import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api';
import { useToast, errMsg } from '../components/Toast';
import { pesosToCents, formatPeso } from '../lib/money';
import { useLiveRefresh, channels } from '../lib/useLiveEvents';
import { downloadAuthed } from '../lib/download';

export default function Folios() {
  const [searchParams] = useSearchParams();
  const toast = useToast();
  const [folioId, setFolioId] = useState(searchParams.get('id') || '');
  const [folio, setFolio] = useState(null);
  const [statement, setStatement] = useState(null);
  const [charge, setCharge] = useState({ chargeCode: '', description: '', amount: '' });
  const [payment, setPayment] = useState({ method: 'CASH', amount: '' });
  const [deposit, setDeposit] = useState({ method: 'CASH', amount: '' });
  const [codes, setCodes] = useState([]);
  const [loading, setLoading] = useState(false);
  // Bill splitting: the other open folios on the same stay, and which transaction
  // the user is currently moving. A stay can carry several folios when different
  // people are settling different parts of the bill.
  const [siblings, setSiblings] = useState([]);
  const [moving, setMoving] = useState(null);

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
  // Whenever the open folio belongs to a stay, load that stay's other folios so a
  // charge can be moved between them. A walk-in folio has no stay and no siblings.
  useEffect(() => {
    if (!folio?.stayId) return setSiblings([]);
    let cancelled = false;
    api
      .get(`/api/folios?stayId=${encodeURIComponent(folio.stayId)}`)
      .then((r) => !cancelled && setSiblings(r.data.filter((f) => f.id !== folio.id && f.status === 'OPEN')))
      .catch(() => !cancelled && setSiblings([]));
    return () => {
      cancelled = true;
    };
  }, [folio?.id, folio?.stayId]);

  async function addFolio() {
    if (!folio?.stayId) return;
    try {
      const { data } = await api.post('/api/folios', { stayId: folio.stayId, guestId: folio.guestId });
      toast.success(`Folio ${data.folioNumber} opened for this stay.`);
      setSiblings((prev) => [...prev, data]);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  async function moveTransaction(transactionId, toFolioId) {
    setMoving(null);
    if (!toFolioId) return;
    try {
      await api.post(`/api/folios/${folioId}/transfer`, { transactionId, toFolioId });
      toast.success('Charge moved.');
      load(folioId);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

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
  async function printReceipt(paymentId) {
    try {
      await downloadAuthed(`/api/folios/${folioId}/payments/${paymentId}/receipt`, {
        filename: `receipt-${folio?.folioNumber || folioId}-${paymentId.slice(-6)}.pdf`,
      });
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  async function closeFolio() {
    if (!confirm('Close this folio? This cannot be undone.')) return;
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
          {folio && folio.stayId && folio.status === 'OPEN' && (
            <button className="secondary" onClick={addFolio}>
              Split bill — add folio
            </button>
          )}
        </div>
        {folio && folio.stayId && siblings.length > 0 && (
          <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
            This stay has {siblings.length + 1} open folios:{' '}
            {[folio, ...siblings].map((f) => f.folioNumber).join(', ')}. Use <strong>Move</strong> on a
            charge to put it on another folio. Every folio must be settled before the guest can check out.
          </p>
        )}
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
                  <th>Type</th>
                  <th>Code</th>
                  <th>Description</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                  {siblings.length > 0 && <th />}
                </tr>
              </thead>
              <tbody>
                {folio.transactions.map((t) => (
                  <tr key={t.id}>
                    <td>{new Date(t.postedAt).toLocaleDateString()}</td>
                    <td>
                      <span className={`badge ${t.type.toLowerCase()}`}>{t.type}</span>
                    </td>
                    <td>{t.chargeCode || '—'}</td>
                    <td>{t.description}</td>
                    <td style={{ textAlign: 'right' }}>{formatPeso(t.amountCents)}</td>
                    {siblings.length > 0 && (
                      <td style={{ textAlign: 'right' }}>
                        {/* Payments stay where they were taken, and a transfer cannot
                            itself be transferred — the service refuses both, so the
                            control is not offered for them. */}
                        {folio.status === 'OPEN' &&
                          t.type !== 'PAYMENT' &&
                          t.type !== 'REFUND' &&
                          t.type !== 'TRANSFER' &&
                          (moving === t.id ? (
                            <select
                              autoFocus
                              defaultValue=""
                              onBlur={() => setMoving(null)}
                              onChange={(e) => moveTransaction(t.id, e.target.value)}
                            >
                              <option value="">Move to…</option>
                              {siblings.map((f) => (
                                <option key={f.id} value={f.id}>
                                  {f.folioNumber}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <button className="secondary small" onClick={() => setMoving(t.id)}>
                              Move
                            </button>
                          ))}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {statement?.folio?.payments?.length > 0 && (
            <div className="panel">
              <h3>Payments received</h3>
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Method</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {statement.folio.payments.map((p) => (
                    <tr key={p.id}>
                      <td>{new Date(p.createdAt).toLocaleDateString()}</td>
                      <td>{p.method}</td>
                      <td>
                        <span className={`badge ${p.status.toLowerCase()}`}>{p.status}</span>
                      </td>
                      <td style={{ textAlign: 'right' }}>{formatPeso(p.amountCents)}</td>
                      <td style={{ textAlign: 'right' }}>
                        {/* A voided or failed payment has no receipt — the service
                            refuses it, so the button is not offered. */}
                        {p.status !== 'VOIDED' && p.status !== 'FAILED' && (
                          <button className="secondary small" onClick={() => printReceipt(p.id)}>
                            Receipt
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

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
