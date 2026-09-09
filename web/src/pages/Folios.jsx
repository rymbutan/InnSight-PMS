import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api';
import EmptyState from '../components/EmptyState';
import Avatar from '../components/Avatar';
import { useToast, errMsg } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { pesosToCents, formatPeso } from '../lib/money';
import { useLiveRefresh, channels } from '../lib/useLiveEvents';
import { downloadAuthed } from '../lib/download';
import SplitBillDialog from '../components/SplitBillDialog';
import Modal from '../components/Modal';
import { paymentMethodGroups, isEWallet } from '../lib/paymentMethods';

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
  // Bill splitting: the other open folios on the same stay, and which transaction
  // the user is currently moving. A stay can carry several folios when different
  // people are settling different parts of the bill.
  const [siblings, setSiblings] = useState([]);
  const [moving, setMoving] = useState(null);
  const [splitOpen, setSplitOpen] = useState(false);
  // The stay's guest name. Neither GET /folios/:id nor the statement carries it —
  // it lives on the guest service and only the folio LIST joins it — so it is
  // read out of the sibling fetch below rather than paid for with a second call.
  const [stayGuestName, setStayGuestName] = useState('');
  // The QR payment code currently on screen, if any.
  const [qr, setQr] = useState(null);
  // E-wallet refund/chargeback disputes filed against this folio's payments.
  const [disputes, setDisputes] = useState([]);
  const [disputeFor, setDisputeFor] = useState(null); // the Payment being disputed
  const [disputeForm, setDisputeForm] = useState({ type: 'REFUND_REQUEST', reason: '', amount: '' });
  const [disputeBusy, setDisputeBusy] = useState(false);
  const [resolvingId, setResolvingId] = useState(null);
  // Which of the three "take an action" forms the sidebar shows. They used to
  // be three stacked full-width panels; one at a time in a tab is the same
  // three forms without scrolling past two you are not about to use.
  const [actionTab, setActionTab] = useState('charge');

  // The folio list, mirroring the Guest Profiles pattern:
  //   browse      resting state — the most recent folios
  //   suggesting  live matches for what is being typed, still as table rows
  //   selected    a folio was chosen: the list is GONE, not narrowed to one row
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [listMode, setListMode] = useState('browse');
  const [searching, setSearching] = useState(false);
  // Debounce timer plus a monotonic request id: without the id a slow response
  // for "F-1" can land after a fast one for "F-11" and repopulate the table with
  // the wider result.
  const suggestTimer = useRef(null);
  const suggestSeq = useRef(0);

  useEffect(() => {
    api
      .get('/api/charge-codes')
      .then((r) => setCodes(r.data))
      .catch(() => {});
  }, []);

  async function load(id) {
    const target = id || folioId;
    if (!target) return;
    try {
      const [f, s] = await Promise.all([
        api.get(`/api/folios/${target}`),
        api.get(`/api/folios/${target}/statement`),
      ]);
      setFolio(f.data);
      setStatement(s.data);
      setFolioId(target);
      loadDisputes(target);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  async function loadDisputes(target) {
    try {
      const { data } = await api.get('/api/payment-disputes', { params: { folioId: target } });
      setDisputes(data);
    } catch {
      // Non-fatal: the folio itself already loaded. A dead disputes fetch
      // should not block viewing the statement.
    }
  }

  function openDispute(p) {
    setDisputeFor(p);
    setDisputeForm({ type: 'REFUND_REQUEST', reason: '', amount: (Number(p.amountCents) / 100).toFixed(2) });
  }

  async function submitDispute(e) {
    e.preventDefault();
    if (!disputeFor) return;
    setDisputeBusy(true);
    try {
      await api.post(`/api/folios/${folioId}/payments/${disputeFor.id}/disputes`, {
        type: disputeForm.type,
        reason: disputeForm.reason || undefined,
        amountCents: pesosToCents(disputeForm.amount),
      });
      toast.success('Dispute filed.');
      setDisputeFor(null);
      loadDisputes(folioId);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setDisputeBusy(false);
    }
  }

  async function resolveDispute(disputeId, decision) {
    if (decision === 'APPROVED') {
      const ok = await confirm({
        title: 'Approve dispute',
        message: 'Approve this claim and refund the guest?',
        detail: 'This posts a real refund against the original payment, same as the Refund action.',
        confirmLabel: 'Approve & refund',
      });
      if (!ok) return;
    }
    setResolvingId(disputeId);
    try {
      await api.post(`/api/payment-disputes/${disputeId}/resolve`, { decision });
      toast.success(
        decision === 'APPROVED' ? 'Dispute approved — refund posted.' : `Dispute marked ${decision.toLowerCase()}.`
      );
      loadDisputes(folioId);
      load(folioId);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setResolvingId(null);
    }
  }

  useEffect(() => {
    const qid = searchParams.get('id');
    if (qid) {
      load(qid);
      setListMode('selected');
    }
  }, [searchParams]);

  useEffect(() => () => clearTimeout(suggestTimer.current), []);

  // `term` is passed explicitly rather than read from `q`: state here reads one
  // render stale, which is what makes a just-created row fail to appear.
  async function searchFolios(term = q, mode) {
    const mine = ++suggestSeq.current;
    setSearching(true);
    try {
      const { data } = await api.get(`/api/folios?q=${encodeURIComponent(term ?? '')}`);
      if (mine !== suggestSeq.current) return;
      setResults(Array.isArray(data) ? data : []);
      if (mode) setListMode(mode);
    } catch (e) {
      if (mine === suggestSeq.current) toast.error(errMsg(e));
    } finally {
      if (mine === suggestSeq.current) setSearching(false);
    }
  }

  function onQueryChange(v) {
    setQ(v);
    clearTimeout(suggestTimer.current);
    const term = v.trim();
    if (!term) {
      setListMode('browse');
      searchFolios('', 'browse');
      return;
    }
    setListMode('suggesting');
    suggestTimer.current = setTimeout(() => searchFolios(term, 'suggesting'), 220);
  }

  // A single match IS the answer, so it opens straight through rather than
  // making you click the one row it just found.
  async function onSearchSubmit(e) {
    e?.preventDefault();
    clearTimeout(suggestTimer.current);
    const term = q.trim();
    if (!term) return searchFolios('', 'browse');
    const mine = ++suggestSeq.current;
    setSearching(true);
    try {
      const { data } = await api.get(`/api/folios?q=${encodeURIComponent(term)}`);
      if (mine !== suggestSeq.current) return;
      setSearching(false);
      const rows = Array.isArray(data) ? data : [];
      setResults(rows);
      if (rows.length === 1) pickFolio(rows[0]);
      else setListMode('suggesting');
    } catch (e) {
      if (mine !== suggestSeq.current) return;
      setSearching(false);
      toast.error(errMsg(e));
    }
  }

  function pickFolio(f) {
    clearTimeout(suggestTimer.current);
    // Bump the sequence so a debounced response still in flight cannot land
    // afterwards and put the list back over the selection.
    suggestSeq.current++;
    setQ(f.folioNumber || '');
    setResults([f]);
    setListMode('selected');
    load(f.id);
  }

  function clearFolioSearch() {
    clearTimeout(suggestTimer.current);
    setQ('');
    setListMode('browse');
    searchFolios('', 'browse');
  }

  // Populate the list on first render. Ordering hazard: the `?id=` effect
  // above runs first on mount and sets listMode to 'selected' SYNCHRONOUSLY
  // (before this effect's fetch even starts). This effect's `searchFolios`
  // call is async, so its `setListMode('browse')` lands a network round trip
  // later — after 'selected' has already been set — and would otherwise
  // stomp it back to 'browse', popping the list open above the already-loaded
  // folio card. So: only force 'browse' when there is no `?id=` waiting to
  // claim 'selected'. The fetch still runs either way, so `results` holds the
  // recent-folios list and "Show all" works immediately after a deep link.
  useEffect(() => {
    searchFolios('', searchParams.get('id') ? undefined : 'browse');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live: a charge, payment, refund, deposit or settlement posted from another
  // screen (or by the night audit) refreshes the open folio automatically.
  //
  // Whenever the open folio belongs to a stay, load that stay's other folios so a
  // charge can be moved between them. A walk-in folio has no stay and no siblings.
  useEffect(() => {
    if (!folio?.stayId) {
      setSiblings([]);
      setStayGuestName('');
      return undefined;
    }
    let cancelled = false;
    api
      .get(`/api/folios?stayId=${encodeURIComponent(folio.stayId)}`)
      .then((r) => {
        if (cancelled) return;
        setSiblings(r.data.filter((f) => f.id !== folio.id && f.status === 'OPEN'));
        // Every folio on a stay shares its guest, so the first name present is
        // the right one whichever row it came from.
        setStayGuestName(r.data.find((f) => f.guestName)?.guestName || '');
      })
      .catch(() => {
        if (cancelled) return;
        setSiblings([]);
        setStayGuestName('');
      });
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

  // Who this folio bills, for the summary header. The folio's own payer (set
  // by a split — see folio.payerName) takes priority over the stay's overall
  // guest, since a split folio bills a specific person, not necessarily
  // whoever occupies the room. A walk-in folio has neither.
  const headerGuestName = folio?.payerName || folio?.guestName || stayGuestName || 'Walk-in / no guest on file';

  // Shared between the Payment and Deposit tabs — one method list, one place
  // that renders it as <option>s or <optgroup>s.
  function renderMethodOptions() {
    return paymentMethodGroups().map((g) =>
      g.kind === 'group' ? (
        <optgroup key={g.label} label={g.label}>
          {g.methods.map((m) => (
            <option key={m.code} value={m.code}>
              {m.label}
            </option>
          ))}
        </optgroup>
      ) : (
        <option key={g.code} value={g.code}>
          {g.label}
        </option>
      )
    );
  }

  return (
    <div>
      <h2>Folios</h2>

      <div className="panel">
        {/* No heading once a folio is chosen — a label over a lone search box,
            with the answer in a card below, would be labelling a list that is
            no longer there. */}
        {listMode !== 'selected' && (
          <div className="panel-head" style={{ marginBottom: 12 }}>
            <h3>{listMode === 'browse' ? 'Recent folios' : 'Matching folios'}</h3>
            {searching && (
              <span className="muted" style={{ fontSize: 12 }}>
                <span className="spinner" /> Searching…
              </span>
            )}
          </div>
        )}

        <div className="guest-search-bar">
          <input
            className="guest-search-input"
            value={q}
            placeholder="Folio number or guest name"
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSearchSubmit(e);
              if (e.key === 'Escape') clearFolioSearch();
            }}
            autoComplete="off"
            aria-label="Search folios by number or guest name"
          />
          <button type="button" onClick={onSearchSubmit}>
            Search
          </button>
          {(q || listMode !== 'browse') && (
            <button type="button" className="secondary" onClick={clearFolioSearch}>
              Show all
            </button>
          )}
        </div>

        {listMode === 'selected' ? null : results.length === 0 ? (
          <EmptyState
            kind="search"
            title="No folios found"
            hint={
              q
                ? `No matches for "${q}". Try a folio number or the guest's name.`
                : 'Folios open automatically when a guest checks in.'
            }
          />
        ) : (
          <>
            {listMode !== 'browse' && (
              <div className="guest-isolated-bar">
                <span>
                  {results.length === 1 ? '1 match' : `${results.length} matches`} for “{q}” — choose
                  one, or press Enter.
                </span>
                <button type="button" className="small secondary" onClick={clearFolioSearch}>
                  Show all folios
                </button>
              </div>
            )}
            <table className="table-clickable">
              <thead>
                <tr>
                  <th className="t-c"></th>
                  <th>Folio #</th>
                  <th>Guest</th>
                  <th className="t-c">Status</th>
                  <th style={{ textAlign: 'right' }}>Balance</th>
                </tr>
              </thead>
              <tbody>
                {/* The whole row is the control. role/tabIndex/onKeyDown are what
                    keep it usable without a mouse — a bare onClick on a <tr> is
                    invisible to the keyboard and to a screen reader. */}
                {results.map((f) => (
                  <tr
                    key={f.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open folio ${f.folioNumber}`}
                    onClick={() => pickFolio(f)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        pickFolio(f);
                      }
                    }}
                  >
                    <td className="t-c" style={{ width: 40 }}>
                      <Avatar name={f.guestName || 'Folio'} size={32} />
                    </td>
                    <td>{f.folioNumber}</td>
                    <td>{f.guestName || <span className="muted">—</span>}</td>
                    <td className="t-c">
                      <span className={`badge ${String(f.status).toLowerCase()}`}>{f.status}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {formatPeso(f.balanceCents, { currency: f.currency })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {folio && (
        <>
          {/* ── Summary: who this folio bills, its status, and its totals ──
              The folio's payer (set by a split) takes priority over the
              stay's overall guest, since a split folio bills a specific
              person, not necessarily whoever occupies the room. */}
          <div className="panel">
            <div className="folio-summary-top">
              <div className="folio-summary-guest">
                <Avatar name={headerGuestName} size={40} />
                <div>
                  <div className="folio-summary-name">{headerGuestName}</div>
                  <div className="folio-summary-sub">
                    Folio {folio.folioNumber}
                    <span className={`badge ${folio.status.toLowerCase()}`}>{folio.status}</span>
                  </div>
                </div>
              </div>
              <div className="folio-summary-actions">
                <button className="secondary" onClick={printPdf}>
                  Print PDF
                </button>
                {folio.status === 'OPEN' && folio.stayId && (
                  <>
                    {/* A real split: pick the payers and how the bill divides,
                        and the folios are opened and the charges apportioned in
                        one action. The button this replaced said "Split bill"
                        but only opened an empty folio, leaving the operator to
                        move every charge by hand — and a charge that did not
                        divide into whole cents could not be divided at all. */}
                    <button className="btn-cta" onClick={() => setSplitOpen(true)}>
                      Split bill
                    </button>
                    {/* Kept, honestly labelled now. The per-line Move control
                        needs a sibling folio to move a charge ONTO, so removing
                        the only way to open one would take away manual
                        splitting along with the misleading label. */}
                    <button className="secondary" onClick={addFolio}>
                      Add folio
                    </button>
                  </>
                )}
                {folio.status === 'OPEN' && (
                  <button className="danger" onClick={closeFolio}>
                    Close folio
                  </button>
                )}
              </div>
            </div>
            {folio.stayId && siblings.length > 0 && (
              <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
                This stay has {siblings.length + 1} open folios:{' '}
                {[folio, ...siblings].map((f) => f.folioNumber).join(', ')}. Use <strong>Move</strong> on a
                charge to put it on another folio. Every folio must be settled before the guest can check
                out.
              </p>
            )}
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
          </div>

          <div className="folio-layout">
            {/* ── Main: the ledger and what it produced ── */}
            <div className="folio-main">
              <div className="panel">
                <h3>Ledger</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th className="t-c">Type</th>
                      <th>Code</th>
                      <th>Description</th>
                      <th style={{ textAlign: 'right' }}>Amount</th>
                      {/* Tax was invisible here while every charge carried zero
                          of it. Now that charges attract VAT and service
                          charge, a cashier posting 1,000.00 watched Balance
                          move 1,220.00 with nothing on screen accounting for
                          the 220.00. The ledger has to add up on its face. */}
                      <th style={{ textAlign: 'right' }}>Tax</th>
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
                        {/* taxAmountCents arrives as a decimal STRING (BigInt has no
                            JSON form); formatPeso takes either. Compared as a
                            string rather than parsed — there is no arithmetic to do
                            here, and money must never touch a float. A row with no
                            tax shows a dash rather than 0.00, so a genuinely
                            untaxed line reads as untaxed at a glance. */}
                        <td style={{ textAlign: 'right' }}>
                          {t.taxAmountCents == null || String(t.taxAmountCents) === '0'
                            ? '—'
                            : formatPeso(t.taxAmountCents)}
                        </td>
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
                                {isEWallet(p.method) && p.status !== 'REFUNDED' && (
                                  <button className="secondary small" onClick={() => openDispute(p)}>
                                    Dispute
                                  </button>
                                )}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {disputes.length > 0 && (
                <div className="panel">
                  <h3>E-Wallet Disputes</h3>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Filed</th>
                        <th>Wallet</th>
                        <th>Type</th>
                        <th style={{ textAlign: 'right' }}>Amount</th>
                        <th>Reason</th>
                        <th>Status</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {disputes.map((d) => (
                        <tr key={d.id}>
                          <td>{new Date(d.filedAt).toLocaleDateString()}</td>
                          <td>{d.method}</td>
                          <td>{d.type === 'CHARGEBACK' ? 'Chargeback' : 'Refund request'}</td>
                          <td style={{ textAlign: 'right' }}>{formatPeso(d.amountCents)}</td>
                          <td className="muted">{d.reason || '—'}</td>
                          <td>
                            <span className={`badge ${d.status.toLowerCase()}`}>{d.status}</span>
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {(d.status === 'PENDING' || d.status === 'DISPUTED') && (
                              <span style={{ display: 'inline-flex', gap: 6 }}>
                                <button
                                  className="secondary small"
                                  disabled={resolvingId === d.id}
                                  onClick={() => resolveDispute(d.id, 'APPROVED')}
                                >
                                  Approve
                                </button>
                                <button
                                  className="secondary small"
                                  disabled={resolvingId === d.id}
                                  onClick={() => resolveDispute(d.id, 'REJECTED')}
                                >
                                  Reject
                                </button>
                                {d.status === 'PENDING' && (
                                  <button
                                    className="secondary small"
                                    disabled={resolvingId === d.id}
                                    onClick={() => resolveDispute(d.id, 'DISPUTED')}
                                  >
                                    Escalate
                                  </button>
                                )}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* ── Side: the three ways to move money on this folio, one at a
                time instead of three stacked full-width forms ── */}
            <div className="folio-side">
              <div className="panel">
                <div className="tabs-pill">
                  <button
                    type="button"
                    className={actionTab === 'charge' ? 'active' : ''}
                    onClick={() => setActionTab('charge')}
                  >
                    Charge
                  </button>
                  <button
                    type="button"
                    className={actionTab === 'payment' ? 'active' : ''}
                    onClick={() => setActionTab('payment')}
                  >
                    Payment
                  </button>
                  <button
                    type="button"
                    className={actionTab === 'deposit' ? 'active' : ''}
                    onClick={() => setActionTab('deposit')}
                  >
                    Deposit
                  </button>
                </div>

                {actionTab === 'charge' && (
                  <form onSubmit={postCharge}>
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
                    <label style={{ marginTop: 10 }}>Description</label>
                    <input
                      required
                      value={charge.description}
                      onChange={(e) => setCharge({ ...charge, description: e.target.value })}
                    />
                    <label style={{ marginTop: 10 }}>Amount (₱)</label>
                    <input
                      required
                      type="number"
                      step="0.01"
                      min="0"
                      value={charge.amount}
                      onChange={(e) => setCharge({ ...charge, amount: e.target.value })}
                    />
                    <button style={{ marginTop: 12 }}>Post charge</button>
                  </form>
                )}

                {actionTab === 'payment' && (
                  <>
                    <form onSubmit={postPayment}>
                      <label>Method</label>
                      <select
                        value={payment.method}
                        onChange={(e) => setPayment({ ...payment, method: e.target.value })}
                      >
                        {renderMethodOptions()}
                      </select>
                      <label style={{ marginTop: 10 }}>Amount (₱)</label>
                      <input
                        required
                        type="number"
                        step="0.01"
                        min="0"
                        value={payment.amount}
                        onChange={(e) => setPayment({ ...payment, amount: e.target.value })}
                      />
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
                        <button>Post payment</button>
                        <button type="button" className="secondary" onClick={chargeByQr}>
                          Charge by QR
                        </button>
                      </div>
                    </form>

                    {qr && (
                      <div className="qr-charge" style={{ flexDirection: 'column' }}>
                        <img src={qr.qrDataUrl} alt="Scan to pay" width="160" height="160" />
                        <div className="qr-charge-side">
                          <div className="qr-charge-amount">{formatPeso(qr.amountCents)}</div>
                          {qr.scannable ? (
                            <p className="muted">Ask the guest to scan this with their phone camera.</p>
                          ) : (
                            <p className="muted">
                              {/* Honest about the offline case: a phone resolving localhost
                                  reaches itself, so the code cannot be scanned from one. */}
                              This code points at <code>localhost</code>, so it can only be opened on
                              this machine. Open the link in another tab to demonstrate, or set{' '}
                              <code>PUBLIC_BASE_URL</code> to this machine&rsquo;s network address to
                              make it scannable.
                            </p>
                          )}
                          <a href={qr.url} target="_blank" rel="noreferrer" className="qr-charge-link">
                            {qr.url}
                          </a>
                          <p className="muted" style={{ fontSize: 12 }}>
                            Expires {new Date(qr.expiresAt).toLocaleTimeString()}. The folio updates
                            itself when the guest confirms.
                          </p>
                          <button className="secondary small" onClick={() => setQr(null)}>
                            Dismiss
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}

                {actionTab === 'deposit' && (
                  <form onSubmit={postDeposit}>
                    <label>Method</label>
                    <select
                      value={deposit.method}
                      onChange={(e) => setDeposit({ ...deposit, method: e.target.value })}
                    >
                      {renderMethodOptions()}
                    </select>
                    <label style={{ marginTop: 10 }}>Amount (₱)</label>
                    <input
                      required
                      type="number"
                      step="0.01"
                      min="0"
                      value={deposit.amount}
                      onChange={(e) => setDeposit({ ...deposit, amount: e.target.value })}
                    />
                    <button style={{ marginTop: 12 }}>Record deposit</button>
                  </form>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      <SplitBillDialog
        open={splitOpen}
        folio={folio}
        // The guest occupying the room is nearly always one of the payers, so the
        // dialog opens with their name already in the first row. folio.guestName
        // (the reservation's) is the reliable source; stayGuestName (derived from
        // a Guest-service profile join) is a fallback for the rare folio it still
        // catches that this one does not.
        guestName={folio?.guestName || stayGuestName}
        // Defaults the payer count to the booking's adult count instead of an
        // arbitrary 2, since the desk splits a bill among the people who are
        // actually staying far more often than any other number.
        adults={folio?.adults}
        // Drives the notice explaining that money already taken cannot be moved
        // to another payer. Only shown when there is any, so an untouched folio
        // is not warned about a situation it is not in. Checked against the
        // TRANSACTIONS, because those are what a split does and does not move —
        // the Payment rows are a different table and a refund has no row there.
        hasPayments={(statement?.folio?.transactions || []).some(
          (t) => t.type === 'PAYMENT' || t.type === 'REFUND'
        )}
        onClose={() => setSplitOpen(false)}
        // A split opens folios and posts transfer pairs, so both the folio and
        // its siblings have moved on — reload rather than patching local state.
        onDone={() => load(folioId)}
      />

      {/* Filing an e-wallet refund/chargeback claim — see the Dispute button
          on a GCash/Maya row in "Payments received" above. */}
      <Modal
        open={!!disputeFor}
        onClose={() => setDisputeFor(null)}
        title={disputeFor ? `File a dispute — ${disputeFor.method}` : 'File a dispute'}
        width={420}
        footer={
          <>
            <button className="secondary" onClick={() => setDisputeFor(null)}>
              Cancel
            </button>
            <button onClick={submitDispute} disabled={disputeBusy}>
              {disputeBusy ? 'Filing…' : 'File dispute'}
            </button>
          </>
        }
      >
        {disputeFor && (
          <form onSubmit={submitDispute}>
            <label>Type</label>
            <select
              value={disputeForm.type}
              onChange={(e) => setDisputeForm({ ...disputeForm, type: e.target.value })}
            >
              <option value="REFUND_REQUEST">Refund request (guest/desk-initiated)</option>
              <option value="CHARGEBACK">Chargeback (filed by the guest with the wallet)</option>
            </select>
            <label style={{ marginTop: 10 }}>Amount (₱)</label>
            <input
              type="number"
              step="0.01"
              min="0.01"
              max={(Number(disputeFor.amountCents) / 100).toFixed(2)}
              value={disputeForm.amount}
              onChange={(e) => setDisputeForm({ ...disputeForm, amount: e.target.value })}
            />
            <label style={{ marginTop: 10 }}>Reason</label>
            <textarea
              rows={3}
              value={disputeForm.reason}
              onChange={(e) => setDisputeForm({ ...disputeForm, reason: e.target.value })}
              placeholder="What the guest reported, or the gateway's chargeback reason."
            />
            <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              Filing does not move any money. Approving the case later posts the actual refund.
            </p>
          </form>
        )}
      </Modal>
    </div>
  );
}
