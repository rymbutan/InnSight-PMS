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
  // Bill splitting: the other open folios on the same stay, and which transaction
  // the user is currently moving. A stay can carry several folios when different
  // people are settling different parts of the bill.
  const [siblings, setSiblings] = useState([]);
  const [moving, setMoving] = useState(null);
  // The QR payment code currently on screen, if any.
  const [qr, setQr] = useState(null);

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
  async function chargeByQr() {
    const amount = Math.round(Number(payment.amount) * 100);
    if (!amount || amount <= 0) return toast.error('Enter the amount to charge first.');
    try {
      const { data } = await api.post(`/api/folios/${folioId}/payment-intents`, { amountCents: amount });
      setQr({ ...data, issuedAt: new Date().toISOString() });
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  // When the guest confirms on their phone, the folio service publishes
  // folio:payment_received and the live refresh below reloads this page. Clear the
  // code once its amount has landed, so the desk is not left showing a spent code.
  useEffect(() => {
    if (!qr || !statement) return;
    const paid = (statement.folio.payments || []).some(
      (p) => String(p.amountCents) === String(qr.amountCents) && new Date(p.createdAt) > new Date(qr.issuedAt || 0)
    );
    if (paid) {
      setQr(null);
      toast.success('Payment received.');
    }
  }, [statement]); // eslint-disable-line react-hooks/exhaustive-deps

  async function printReceipt(paymentId) {
    try {
      await downloadAuthed(`/api/folios/${folioId}/payments/${paymentId}/receipt`, {
        filename: `receipt-${folio?.folioNumber || folioId}-${paymentId.slice(-6)}.pdf`,
      });
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  async function emailReceipt(paymentId) {
    try {
      const { data } = await api.post(`/api/folios/${folioId}/payments/${paymentId}/receipt/email`);
      // Says "captured", not "delivered": SMTP points at Mailhog in this
      // deployment, which holds mail for inspection and never sends it on.
      toast.success(`Receipt emailed to ${data.to}. View it in Mailhog at :8025.`);
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
                  <th className="t-c">Type</th>
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
                    <td className="t-c">
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
                          <span style={{ display: 'inline-flex', gap: 6 }}>
                            <button className="secondary small" onClick={() => printReceipt(p.id)}>
                              Receipt
                            </button>
                            <button className="secondary small" onClick={() => emailReceipt(p.id)}>
                              Email
                            </button>
                          </span>
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
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button>Post payment</button>
                <button type="button" className="secondary" onClick={chargeByQr}>
                  Charge by QR
                </button>
              </div>
            </form>

            {qr && (
              <div className="qr-charge">
                <img src={qr.qrDataUrl} alt="Scan to pay" width="180" height="180" />
                <div className="qr-charge-side">
                  <div className="qr-charge-amount">{formatPeso(qr.amountCents)}</div>
                  {qr.scannable ? (
                    <p className="muted">Ask the guest to scan this with their phone camera.</p>
                  ) : (
                    <p className="muted">
                      {/* Honest about the offline case: a phone resolving localhost
                          reaches itself, so the code cannot be scanned from one. */}
                      This code points at <code>localhost</code>, so it can only be opened on this
                      machine. Open the link in another tab to demonstrate, or set{' '}
                      <code>PUBLIC_BASE_URL</code> to this machine&rsquo;s network address to make it
                      scannable.
                    </p>
                  )}
                  <a href={qr.url} target="_blank" rel="noreferrer" className="qr-charge-link">
                    {qr.url}
                  </a>
                  <p className="muted" style={{ fontSize: 12 }}>
                    Expires {new Date(qr.expiresAt).toLocaleTimeString()}. The folio updates itself
                    when the guest confirms.
                  </p>
                  <button className="secondary small" onClick={() => setQr(null)}>
                    Dismiss
                  </button>
                </div>
              </div>
            )}
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
