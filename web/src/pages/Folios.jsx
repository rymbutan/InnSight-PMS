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
import ShareRecordDialog from '../components/ShareRecordDialog';
import Modal from '../components/Modal';
import { folioRef } from '../lib/recordRefs';
import { useAuth } from '../auth';
import { paymentMethodGroups, isEWallet } from '../lib/paymentMethods';
import { labelize } from '../lib/labels';

// Mirrors ReservationDetail.jsx's CreditCardsTab — never a full card number,
// only what a terminal receipt already shows.
const CARD_BRANDS = ['VISA', 'MASTERCARD', 'AMEX', 'DISCOVER', 'JCB', 'OTHER'];
const BANK_NAMES = ['BDO', 'BPI', 'Metrobank', 'UnionBank', 'Landbank', 'OTHER'];
const TRANSFER_NETWORKS = ['InstaPay', 'PESONet', 'Direct OTC Deposit', 'Wire Transfer', 'OTHER'];
const MAX_PROOF_BYTES = 10 * 1024 * 1024;

// 'YYYY-MM-DDTHH:mm' in LOCAL time, what <input type="datetime-local"> both
// accepts and returns — toISOString() would shift this to UTC and silently
// move the displayed time.
function nowForDateTimeLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.readAsDataURL(file);
  });
}

const EMPTY_PAYMENT = {
  method: 'CASH',
  amount: '',
  cardBrand: 'VISA',
  cardLast4: '',
  cardholderName: '',
  gatewayRef: '',
  bankName: 'BDO',
  bankNameOther: '',
  transferNetwork: 'InstaPay',
  transferNetworkOther: '',
  senderName: '',
  bankRef: '',
  transferredAt: '',
  proofFile: null,
};

export default function Folios() {
  const [searchParams] = useSearchParams();
  const toast = useToast();
  const confirm = useConfirm();
  // Sign-off is the auditor's, with Admin as the break-glass path for a shift
  // with no auditor on. Deliberately excludes Manager and Front Desk: the
  // control is only worth anything if the people taking the money are not the
  // people certifying it. Mirrors AUDIT_SIGNOFF on the API.
  const { hasRole } = useAuth();
  const canSignOff = hasRole('AUDITOR', 'ADMIN');
  const [auditBusy, setAuditBusy] = useState(false);
  const [folioId, setFolioId] = useState(searchParams.get('id') || '');
  const [folio, setFolio] = useState(null);
  const [statement, setStatement] = useState(null);
  const [charge, setCharge] = useState({ chargeCode: '', description: '', amount: '' });
  // Everything past `method`/`amount` only matters for CARD/BANK_TRANSFER
  // (see the Payment tab below) — never a full card number, matching the
  // guarantee-card-on-file rule in ReservationDetail.jsx's CreditCardsTab.
  const [payment, setPayment] = useState(EMPTY_PAYMENT);
  const [processingPayment, setProcessingPayment] = useState(false);
  const [uploadingProof, setUploadingProof] = useState(false);
  // The CARD/BANK_TRANSFER surcharge (Settings' Payment Processing Fee card) —
  // fetched once so the Amount field can preview it before posting; the
  // server computes and posts the real charge independently, so a stale
  // preview here can never desync the actual fee charged.
  const [paymentFeePercent, setPaymentFeePercent] = useState(0);
  const [deposit, setDeposit] = useState({ method: 'CASH', amount: '' });
  const [codes, setCodes] = useState([]);
  // Bill splitting: the other open folios on the same stay, and which transaction
  // the user is currently moving. A stay can carry several folios when different
  // people are settling different parts of the bill.
  const [siblings, setSiblings] = useState([]);
  const [moving, setMoving] = useState(null);
  const [splitOpen, setSplitOpen] = useState(false);
  // "Send to colleague": this folio lands in a colleague's chat as a chip
  // that opens it here.
  const [shareOpen, setShareOpen] = useState(false);
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
  // The case being decided, and the note explaining the decision.
  const [resolving, setResolving] = useState(null); // { dispute, decision }
  const [resolveNote, setResolveNote] = useState('');
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
    api
      .get('/api/settings/payment-fee-percent')
      .then((r) => setPaymentFeePercent(r.data.feePercent))
      .catch(() => {}); // 0% default already set; a failed fetch just keeps it
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
    // Prefill what is still refundable, not the original amount: on a payment
    // that was already partly refunded at the desk the original is more than
    // the service will let this case claim.
    const refundable = refundableCentsFor(p);
    setDisputeFor({ ...p, refundableCents: refundable });
    setDisputeForm({ type: 'REFUND_REQUEST', reason: '', amount: (refundable / 100).toFixed(2) });
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

  // What each decision is called, and what it does, in the one place the
  // dialog, the toast and the button label all read from — they used to
  // disagree ("Escalate" on the button, "disputed" in the toast).
  const DISPUTE_DECISIONS = {
    APPROVED: {
      verb: 'Approve',
      title: 'Approve claim & refund',
      detail:
        'This posts a real refund against the original payment, same as the Refund action. The case is then closed for good.',
      done: 'Claim approved — refund posted.',
    },
    REJECTED: {
      verb: 'Reject',
      title: 'Reject claim',
      detail: 'No money moves. The case is closed for good and cannot be reopened.',
      done: 'Claim rejected.',
    },
    DISPUTED: {
      verb: 'Escalate',
      title: 'Escalate to the wallet provider',
      detail:
        'No money moves yet. The case stays open until the provider comes back, then it is approved or rejected here.',
      done: 'Claim escalated to the wallet provider.',
    },
  };

  // The note is the only record of WHY a claim went the way it did, so it is
  // captured at the decision rather than being an argument nothing ever sent.
  function openResolve(dispute, decision) {
    setResolving({ dispute, decision });
    setResolveNote('');
  }

  async function submitResolve(e) {
    e?.preventDefault();
    if (!resolving) return;
    const { dispute, decision } = resolving;
    setResolvingId(dispute.id);
    try {
      await api.post(`/api/payment-disputes/${dispute.id}/resolve`, {
        decision,
        resolutionNote: resolveNote.trim() || undefined,
      });
      toast.success(DISPUTE_DECISIONS[decision].done);
      setResolving(null);
      // One reload, not two: `load` re-fetches the statement AND the dispute
      // queue, and an approval has just changed both.
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
        // Every folio on a stay shares its guest, but a SPLIT folio's own
        // guestName is its distinct payer (e.g. "Andrei Sumilang"), not the
        // stay's guest — prefer a row with no payerName of its own first, and
        // only fall back to whichever name is present if every folio on this
        // stay happens to have a distinct payer.
        setStayGuestName(
          r.data.find((f) => f.guestName && !f.payerName)?.guestName ||
            r.data.find((f) => f.guestName)?.guestName ||
            ''
        );
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
  // Required fields per method — checked here so the "Post payment" button
  // never even reaches the server with something it will reject anyway (the
  // server enforces the SAME rules independently — see
  // missingPaymentField() in folio.routes.js — this is just the fast,
  // in-modal feedback for it).
  function missingPaymentField() {
    const p = payment;
    if (p.method === 'CARD') {
      if (!/^\d{4}$/.test(p.cardLast4)) return 'Enter the last 4 digits of the card.';
      if (!p.cardholderName.trim()) return 'Cardholder name is required.';
    }
    if (p.method === 'BANK_TRANSFER') {
      if (p.bankName === 'OTHER' && !p.bankNameOther.trim()) return 'Enter the bank name.';
      if (p.transferNetwork === 'OTHER' && !p.transferNetworkOther.trim()) {
        return 'Enter the transfer network/channel.';
      }
      if (!p.senderName.trim()) return "Sender/account holder's name is required.";
      if (!p.bankRef.trim()) return 'Bank reference/control number is required.';
      // transferredAt is NOT required here: the field's own displayed default
      // is "now" (see the input's value fallback below), and that default is
      // sent as-is if the field was never touched — see postPayment.
    }
    return null;
  }

  // CARD and BANK_TRANSFER are the two methods with something to simulate
  // processing THROUGH — a terminal authorization, a bank confirming a
  // transfer — so those two get the extra fields below and a brief
  // simulated "Processing…" delay before posting, the same shape the QR
  // flow's own confirm step has (SimulatedPayment.jsx). Cash and a manual
  // e-wallet entry stay instant: there's no gateway behind either.
  async function postPayment(e) {
    e.preventDefault();
    const method = payment.method;
    const missing = missingPaymentField();
    if (missing) return toast.error(missing);

    try {
      setProcessingPayment(method === 'CARD' || method === 'BANK_TRANSFER');
      if (method === 'CARD' || method === 'BANK_TRANSFER') {
        // Simulated gateway/bank latency — nothing here talks to a real
        // processor, but a payment that resolves instantly teaches the wrong
        // lesson about what "processing" a card or a transfer feels like.
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
      const { data } = await api.post(`/api/folios/${folioId}/payments`, {
        method,
        amountCents: pesosToCents(payment.amount),
        ...(method === 'CARD' && {
          cardMasked: `${payment.cardBrand} •••• ${payment.cardLast4}`,
          cardholderName: payment.cardholderName.trim(),
        }),
        // Blank fields are NOT sent as '' — the server falls back to
        // simulateGatewayRef() only when the field is genuinely absent, so a
        // typed-in gateway transaction number always wins for CARD. BANK_
        // TRANSFER's reference is required above, so it is always sent.
        ...(method === 'CARD' && payment.gatewayRef.trim() && { reference: payment.gatewayRef.trim() }),
        ...(method === 'BANK_TRANSFER' && {
          bankName: payment.bankName === 'OTHER' ? payment.bankNameOther.trim() : payment.bankName,
          transferNetwork:
            payment.transferNetwork === 'OTHER'
              ? payment.transferNetworkOther.trim()
              : payment.transferNetwork,
          senderName: payment.senderName.trim(),
          reference: payment.bankRef.trim(),
          // Falls back to "now" if the field was never touched — matches
          // what the (otherwise identical) input already displays.
          transferredAt: new Date(payment.transferredAt || nowForDateTimeLocal()).toISOString(),
        }),
      });

      // The proof slip/screenshot, if one was picked, uploads AFTER the
      // payment exists — the proof route is keyed by paymentId. A failed
      // upload does not undo the payment: it already happened, and staff can
      // retry attaching evidence for it separately (see the ledger's
      // collapsed details, which offer an upload/replace control per payment).
      if (method === 'BANK_TRANSFER' && payment.proofFile) {
        setUploadingProof(true);
        try {
          const contentBase64 = await readFileAsBase64(payment.proofFile);
          await api.post(`/api/folios/${folioId}/payments/${data.id}/proof`, {
            filename: payment.proofFile.name,
            contentType: payment.proofFile.type || 'application/octet-stream',
            contentBase64,
          });
        } catch (proofErr) {
          toast.error(`Payment posted, but the proof upload failed: ${errMsg(proofErr)}`);
        } finally {
          setUploadingProof(false);
        }
      }

      const feeNote = Number(data.feeCents) > 0 ? ` (+ ${formatPeso(data.feeCents)} processing fee)` : '';
      toast.success(
        data.gatewayRef ? `Payment posted — Ref: ${data.gatewayRef}${feeNote}` : `Payment posted.${feeNote}`
      );
      setPayment(EMPTY_PAYMENT);
      load();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setProcessingPayment(false);
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
      (p) =>
        String(p.amountCents) === String(qr.amountCents) && new Date(p.createdAt) > new Date(qr.issuedAt || 0)
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

  // ── Night-audit sign-off ──────────────────────────────────────────────────
  async function approveAudit() {
    setAuditBusy(true);
    try {
      await api.post(`/api/folios/${folioId}/audit-approve`);
      toast.success('Folio approved — the guest can now be checked out.');
      load();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setAuditBusy(false);
    }
  }

  async function revokeAudit() {
    // Asks, because withdrawing is what strands a guest at the desk. Approving
    // does not ask: it only ever unblocks.
    const ok = await confirm({
      title: 'Withdraw approval',
      message: 'Withdraw the audit approval on this folio?',
      detail: 'The guest will not be able to check out until it is approved again.',
      confirmLabel: 'Withdraw approval',
    });
    if (!ok) return;
    setAuditBusy(true);
    try {
      await api.post(`/api/folios/${folioId}/audit-revoke`);
      toast.success('Approval withdrawn.');
      load();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setAuditBusy(false);
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
  const headerGuestName =
    folio?.payerName || folio?.guestName || stayGuestName || 'Walk-in / no guest on file';

  // The Payment row behind a PAYMENT-type ledger transaction — every payment-
  // posting route sets FolioTransaction.reference to the Payment's own id
  // (see folio.routes.js's comment on why that must never be gatewayRef),
  // which is exactly what makes this lookup possible.
  function paymentForTransaction(t) {
    if (t.type !== 'PAYMENT' || !t.reference) return null;
    return (folio.payments || []).find((p) => p.id === t.reference) || null;
  }

  // How much of a payment has NOT gone back to the guest yet — the payment's
  // own ledger line less every refund posted against it. The folio service
  // caps both /refund and a dispute at exactly this (lib/refund.js), so
  // mirroring it here is what stops the Dispute form from offering an amount
  // the server will only turn down, and what drops the button once a payment
  // has been given back in full.
  function refundableCentsFor(p) {
    const txs = folio.transactions || [];
    const paid = txs.find((t) => t.type === 'PAYMENT' && t.reference === p.id);
    if (!paid) return 0;
    const refunded = txs
      .filter((t) => t.type === 'REFUND' && t.refundOfId === paid.id)
      .reduce((sum, t) => sum + Number(t.amountCents), 0);
    return Math.max(0, Number(paid.amountCents) - refunded);
  }

  // The one-line summary a collapsed <details> shows under a payment line —
  // "Card: Visa ****4321 | Ref: TXN-99812" / "Bank: BDO (InstaPay) | Ref:
  // 20260910-8812" — falling back to a bare reference line for any other
  // method that has one (QR/e-wallet's SIM-…), and nothing at all for a
  // payment with no gateway/bank behind it (cash, or an e-wallet entry with
  // no reference typed in).
  function paymentSummaryTag(p) {
    if (!p) return null;
    if (p.method === 'CARD' && (p.cardMasked || p.gatewayRef)) {
      return `Card: ${p.cardMasked || '—'}${p.gatewayRef ? ` | Ref: ${p.gatewayRef}` : ''}`;
    }
    if (p.method === 'BANK_TRANSFER' && (p.bankName || p.gatewayRef)) {
      const bank = p.transferNetwork ? `${p.bankName} (${p.transferNetwork})` : p.bankName;
      return `Bank: ${bank || '—'}${p.gatewayRef ? ` | Ref: ${p.gatewayRef}` : ''}`;
    }
    if (p.gatewayRef) return `Ref: ${p.gatewayRef}`;
    return null;
  }

  async function viewPaymentProof(p) {
    try {
      await downloadAuthed(`/api/folios/${folioId}/payments/${p.id}/proof`, {
        filename: p.proof?.filename || 'proof',
        openInTab: true,
      });
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

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

        <div className="guest-search-bar" data-tour="tour-process-folios">
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
                  {results.length === 1 ? '1 match' : `${results.length} matches`} for “{q}” — choose one, or
                  press Enter.
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
                  {/* SPLIT when another folio shares this one's stay (a bill split
                      into several payers), SOLO otherwise — see lib/folioList.js.
                      Also what makes the Guest column above trustworthy: a split
                      folio's own payer (e.g. "Andrei Sumilang"), not the stay's
                      original guest repeated on every row. */}
                  <th className="t-c">Type of Charge</th>
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
                      <span className={`badge ${f.chargeType === 'SPLIT' ? 'split' : 'solo'}`}>
                        {f.chargeType === 'SPLIT' ? 'Split' : 'Solo Charge'}
                      </span>
                    </td>
                    <td className="t-c">
                      <span className={`badge ${String(f.status).toLowerCase()}`}>{labelize(f.status)}</span>
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
                <div className="folio-summary-nameline">
                  <div className="folio-summary-name">{headerGuestName}</div>
                  <div className="folio-summary-sub">
                    Folio {folio.folioNumber}
                    <span className={`badge ${folio.status.toLowerCase()}`}>{labelize(folio.status)}</span>
                  </div>
                </div>
              </div>
              {/* Three groups, not six buttons in a row: reference (nothing here
                  changes the bill), billing structure (splits it), and the
                  lifecycle gate (signs it off, then closes it). Every button is
                  .small now — Split Bill and Approve for Checkout were both
                  .btn-cta, the same full-size, shouting-uppercase treatment the
                  dashboard's one "Create new reservation" button uses, so two
                  actions in one toolbar were each claiming to be THE thing to
                  click. Approve for Checkout keeps that treatment, shrunk, as
                  the one action actually gating checkout — see the banner right
                  below this row. Everything else reads as an equal, ordinary
                  choice, which is what it is. */}
              <div className="folio-summary-actions">
                <div className="folio-action-group">
                  <button className="secondary small" onClick={printPdf}>
                    Print PDF
                  </button>
                  <button className="secondary small" onClick={() => setShareOpen(true)}>
                    Send to colleague
                  </button>
                  <ShareRecordDialog
                    open={shareOpen}
                    onClose={() => setShareOpen(false)}
                    record={folioRef(folio, headerGuestName)}
                  />
                </div>
                {folio.status === 'OPEN' && folio.stayId && (
                  <>
                    <span className="folio-action-divider" aria-hidden="true" />
                    <div className="folio-action-group">
                      {/* A real split: pick the payers and how the bill
                          divides, and the folios are opened and the charges
                          apportioned in one action. The button this replaced
                          said "Split bill" but only opened an empty folio,
                          leaving the operator to move every charge by hand —
                          and a charge that did not divide into whole cents
                          could not be divided at all. */}
                      <button className="secondary small" onClick={() => setSplitOpen(true)}>
                        Split bill
                      </button>
                      {/* Kept, honestly labelled now. The per-line Move control
                          needs a sibling folio to move a charge ONTO, so
                          removing the only way to open one would take away
                          manual splitting along with the misleading label. */}
                      <button className="secondary small" onClick={addFolio}>
                        Add folio
                      </button>
                    </div>
                  </>
                )}
                {/* Night-audit sign-off. Only the auditor (and Admin as
                    break-glass) sees these: the desk cannot certify its own
                    takings, which is the entire point of the gate. The divider
                    itself is gated on OPEN alone, not canSignOff — Close Folio
                    below renders for every OPEN folio regardless of role, so
                    this group is never actually empty when the divider shows. */}
                {folio.status === 'OPEN' && <span className="folio-action-divider" aria-hidden="true" />}
                <div className="folio-action-group">
                  {folio.status === 'OPEN' && canSignOff && !folio.auditApproved && (
                    <button className="btn-cta small" onClick={approveAudit} disabled={auditBusy}>
                      {auditBusy ? 'Approving…' : 'Approve for checkout'}
                    </button>
                  )}
                  {folio.status === 'OPEN' && canSignOff && folio.auditApproved && (
                    <button className="secondary small" onClick={revokeAudit} disabled={auditBusy}>
                      Withdraw approval
                    </button>
                  )}
                  {folio.status === 'OPEN' && (
                    <button className="danger small" onClick={closeFolio}>
                      Close folio
                    </button>
                  )}
                </div>
              </div>
            </div>
            {/* Readable by EVERY role, not just the auditor. The desk is the one
                who gets refused at check-out, so the desk is who most needs to
                see why — and "approved, then the bill changed" has to be its own
                message or a clerk re-reads an approval badge that no longer
                means anything. */}
            {folio.status === 'OPEN' && (
              <p className={`folio-audit-line ${folio.auditApproved ? 'is-ok' : 'is-pending'}`}>
                {folio.auditApproved ? (
                  <>Audit approved — this folio is cleared for check-out.</>
                ) : folio.auditApprovalStale ? (
                  <>
                    Approved earlier, but the bill has changed since. The auditor must re-check it before this
                    guest can check out.
                  </>
                ) : (
                  <>Awaiting auditor approval. The guest cannot check out until an auditor signs this off.</>
                )}
              </p>
            )}
            {folio.stayId && siblings.length > 0 && (
              <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
                This stay has {siblings.length + 1} open folios:{' '}
                {[folio, ...siblings].map((f) => f.folioNumber).join(', ')}. Use <strong>Move</strong> on a
                charge to put it on another folio. Every folio must be settled before the guest can check out.
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
                      <th>Reference</th>
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
                    {folio.transactions.map((t) => {
                      const linkedPayment = paymentForTransaction(t);
                      const summaryTag = paymentSummaryTag(linkedPayment);
                      // Extra gateway/bank metadata beyond the one-line summary — only
                      // CARD (a cardholder name) and BANK_TRANSFER (sender, transfer
                      // date, and always either a proof link or "no proof on file")
                      // ever have any, so a Ref-only tag (e-wallet/QR) or cash gets no
                      // expando at all rather than an empty one.
                      const hasExtra =
                        linkedPayment &&
                        ((linkedPayment.method === 'CARD' && linkedPayment.cardholderName) ||
                          linkedPayment.method === 'BANK_TRANSFER');
                      return (
                        <tr key={t.id}>
                          <td>{new Date(t.postedAt).toLocaleDateString()}</td>
                          <td className="t-c">
                            <span className={`badge ${t.type.toLowerCase()}`}>{labelize(t.type)}</span>
                          </td>
                          <td>{t.chargeCode || '—'}</td>
                          <td>{t.description}</td>
                          {/* The gateway/bank reference now lives in its own column
                                instead of a full-width row under the date — a payment
                                with nothing to show (cash, or an e-wallet entry with no
                                typed-in reference) just reads as "—", same as Code. */}
                          <td>
                            {summaryTag ? (
                              hasExtra ? (
                                <details className="payment-tx-details">
                                  <summary>{summaryTag}</summary>
                                  <div className="payment-tx-details-body">
                                    {linkedPayment.method === 'CARD' && linkedPayment.cardholderName && (
                                      <div>Cardholder: {linkedPayment.cardholderName}</div>
                                    )}
                                    {linkedPayment.method === 'BANK_TRANSFER' && (
                                      <>
                                        {linkedPayment.senderName && (
                                          <div>Sender: {linkedPayment.senderName}</div>
                                        )}
                                        {linkedPayment.transferredAt && (
                                          <div>
                                            Transferred:{' '}
                                            {new Date(linkedPayment.transferredAt).toLocaleString()}
                                          </div>
                                        )}
                                        {linkedPayment.proof ? (
                                          <div>
                                            <button
                                              type="button"
                                              className="secondary small"
                                              onClick={() => viewPaymentProof(linkedPayment)}
                                            >
                                              View proof ({linkedPayment.proof.filename})
                                            </button>
                                          </div>
                                        ) : (
                                          <div className="muted">No proof of transfer on file.</div>
                                        )}
                                      </>
                                    )}
                                  </div>
                                </details>
                              ) : (
                                summaryTag
                              )
                            ) : (
                              '—'
                            )}
                          </td>
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
                      );
                    })}
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
                        {/* The gateway/bank reference a real terminal or bank statement
                            would show — CARD gets an "AUTH-…" code, BANK_TRANSFER a
                            "BANKREF-…" number, a QR/e-wallet payment its "SIM-…" one
                            (see lib/paymentMethods.js's simulateGatewayRef and the QR
                            confirm route). Cash carries none — there's no gateway
                            behind it — so that row's cell reads "—". */}
                        <th>Reference</th>
                        <th style={{ textAlign: 'right' }}>Amount</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {statement.folio.payments.map((p) => (
                        <tr key={p.id}>
                          <td>{new Date(p.createdAt).toLocaleDateString()}</td>
                          <td>{labelize(p.method)}</td>
                          <td>
                            <span className={`badge ${p.status.toLowerCase()}`}>{labelize(p.status)}</span>
                          </td>
                          <td className="payment-reference">{p.gatewayRef || '—'}</td>
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
                                {/* A wallet payment can be claimed against while
                                    any of it is still in the hotel's hands and
                                    no case is already open on it — the service
                                    refuses both, so offering the button would
                                    only produce a 409. */}
                                {isEWallet(p.method) &&
                                  refundableCentsFor(p) > 0 &&
                                  !disputes.some(
                                    (d) =>
                                      d.paymentId === p.id &&
                                      (d.status === 'PENDING' || d.status === 'DISPUTED')
                                  ) && (
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
                          <td>{labelize(d.method)}</td>
                          <td>{d.type === 'CHARGEBACK' ? 'Chargeback' : 'Refund request'}</td>
                          <td style={{ textAlign: 'right' }}>{formatPeso(d.amountCents)}</td>
                          <td className="muted">
                            <div>{d.reason || '—'}</div>
                            {/* Who did what, on the row itself. Every one of
                                these is recorded by the service and none of it
                                was ever shown, so a second cashier could not
                                tell an escalated case from an abandoned one. */}
                            {d.filedBy && <div style={{ fontSize: 12 }}>Filed by {d.filedBy}</div>}
                            {d.resolutionNote && <div style={{ fontSize: 12 }}>Note: {d.resolutionNote}</div>}
                            {d.resolvedBy && (
                              <div style={{ fontSize: 12 }}>
                                {d.status === 'APPROVED' ? 'Approved' : 'Rejected'} by {d.resolvedBy}
                              </div>
                            )}
                          </td>
                          <td>
                            <span className={`badge ${d.status.toLowerCase()}`}>{labelize(d.status)}</span>
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {/* Only the transitions the service will actually
                                accept — DISPUTE_TRANSITIONS in
                                services/folio/src/routes/folio.routes.js. An
                                escalated case cannot be escalated again. */}
                            {(d.status === 'PENDING' || d.status === 'DISPUTED') && (
                              <span style={{ display: 'inline-flex', gap: 6 }}>
                                <button
                                  className="secondary small"
                                  disabled={resolvingId === d.id}
                                  onClick={() => openResolve(d, 'APPROVED')}
                                >
                                  Approve
                                </button>
                                <button
                                  className="secondary small"
                                  disabled={resolvingId === d.id}
                                  onClick={() => openResolve(d, 'REJECTED')}
                                >
                                  Reject
                                </button>
                                {d.status === 'PENDING' && (
                                  <button
                                    className="secondary small"
                                    disabled={resolvingId === d.id}
                                    onClick={() => openResolve(d, 'DISPUTED')}
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

                      {/* A preview only — the server computes and posts the real fee
                          independently (see policies.js's paymentProcessingFeeCents),
                          so this can never desync what actually lands on the folio. */}
                      {(payment.method === 'CARD' || payment.method === 'BANK_TRANSFER') &&
                        paymentFeePercent > 0 &&
                        Number(payment.amount) > 0 && (
                          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                            + Processing fee ({paymentFeePercent}%):{' '}
                            {formatPeso(Math.round(pesosToCents(payment.amount) * (paymentFeePercent / 100)))}
                            {' — Total added to folio: '}
                            {formatPeso(
                              pesosToCents(payment.amount) +
                                Math.round(pesosToCents(payment.amount) * (paymentFeePercent / 100))
                            )}
                          </p>
                        )}

                      {/* A card terminal reads the card, not a typed-in number — this
                          asks only for what a receipt would show (brand + last 4 +
                          cardholder name), same rule as the guarantee-card-on-file
                          tab. Confirming simulates the terminal authorizing it (see
                          postPayment). */}
                      {payment.method === 'CARD' && (
                        <>
                          <div className="row" style={{ marginTop: 10 }}>
                            <div>
                              <label>Card brand</label>
                              <select
                                value={payment.cardBrand}
                                onChange={(e) => setPayment({ ...payment, cardBrand: e.target.value })}
                              >
                                {CARD_BRANDS.map((b) => (
                                  <option key={b} value={b}>
                                    {b}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label>Last 4 digits</label>
                              <input
                                required
                                inputMode="numeric"
                                maxLength={4}
                                placeholder="4242"
                                value={payment.cardLast4}
                                onChange={(e) =>
                                  setPayment({
                                    ...payment,
                                    cardLast4: e.target.value.replace(/\D/g, '').slice(0, 4),
                                  })
                                }
                              />
                            </div>
                          </div>
                          <label style={{ marginTop: 10 }}>Cardholder name</label>
                          <input
                            required
                            placeholder="As printed on the card"
                            value={payment.cardholderName}
                            onChange={(e) => setPayment({ ...payment, cardholderName: e.target.value })}
                          />
                          {/* Optional: staff can type in the ACTUAL authorization code a
                              real terminal printed. Left blank, the server simulates
                              one (AUTH-…) — see lib/paymentMethods.js's
                              simulateGatewayRef. */}
                          <label style={{ marginTop: 10 }}>Transaction / Authorization code (optional)</label>
                          <input
                            placeholder="Gateway transaction ID or POS approval code — leave blank to simulate one"
                            value={payment.gatewayRef}
                            onChange={(e) => setPayment({ ...payment, gatewayRef: e.target.value })}
                          />
                        </>
                      )}

                      {/* Bank transfer has nothing to simulate a control number FROM —
                          every field here is required before the transfer counts as
                          confirmed (see missingPaymentField, both here and server-side
                          in folio.routes.js). */}
                      {payment.method === 'BANK_TRANSFER' && (
                        <>
                          <div className="row" style={{ marginTop: 10 }}>
                            <div>
                              <label>Bank name</label>
                              <select
                                value={payment.bankName}
                                onChange={(e) => setPayment({ ...payment, bankName: e.target.value })}
                              >
                                {BANK_NAMES.map((b) => (
                                  <option key={b} value={b}>
                                    {b === 'OTHER' ? 'Other — type your own…' : b}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label>Transfer network / channel</label>
                              <select
                                value={payment.transferNetwork}
                                onChange={(e) => setPayment({ ...payment, transferNetwork: e.target.value })}
                              >
                                {TRANSFER_NETWORKS.map((n) => (
                                  <option key={n} value={n}>
                                    {n === 'OTHER' ? 'Other — type your own…' : n}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                          {payment.bankName === 'OTHER' && (
                            <input
                              required
                              style={{ marginTop: 8 }}
                              placeholder="Bank name"
                              value={payment.bankNameOther}
                              onChange={(e) => setPayment({ ...payment, bankNameOther: e.target.value })}
                            />
                          )}
                          {payment.transferNetwork === 'OTHER' && (
                            <input
                              required
                              style={{ marginTop: 8 }}
                              placeholder="Transfer network / channel"
                              value={payment.transferNetworkOther}
                              onChange={(e) =>
                                setPayment({ ...payment, transferNetworkOther: e.target.value })
                              }
                            />
                          )}

                          <label style={{ marginTop: 10 }}>Sender / account holder name</label>
                          <input
                            required
                            value={payment.senderName}
                            onChange={(e) => setPayment({ ...payment, senderName: e.target.value })}
                          />

                          <label style={{ marginTop: 10 }}>Bank reference / control number</label>
                          <input
                            required
                            placeholder="Mandatory transaction ID from the slip or app"
                            value={payment.bankRef}
                            onChange={(e) => setPayment({ ...payment, bankRef: e.target.value })}
                          />

                          <label style={{ marginTop: 10 }}>Transfer date &amp; time</label>
                          <input
                            required
                            type="datetime-local"
                            value={payment.transferredAt || nowForDateTimeLocal()}
                            onChange={(e) => setPayment({ ...payment, transferredAt: e.target.value })}
                          />

                          <label style={{ marginTop: 10 }}>Proof of transfer / deposit slip (optional)</label>
                          <input
                            type="file"
                            accept="image/*,application/pdf"
                            onChange={(e) => {
                              const file = e.target.files?.[0] || null;
                              if (file && file.size > MAX_PROOF_BYTES) {
                                toast.error(
                                  `File is too large — max ${(MAX_PROOF_BYTES / (1024 * 1024)).toFixed(0)}MB.`
                                );
                                e.target.value = '';
                                return;
                              }
                              setPayment({ ...payment, proofFile: file });
                            }}
                          />
                          {payment.proofFile && (
                            <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                              {payment.proofFile.name} ({(payment.proofFile.size / 1024).toFixed(0)} KB)
                            </p>
                          )}
                        </>
                      )}

                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
                        <button disabled={processingPayment || uploadingProof}>
                          {processingPayment
                            ? 'Processing…'
                            : uploadingProof
                              ? 'Uploading proof…'
                              : 'Post payment'}
                        </button>
                        {/* QR/pay-by-link only makes sense for an e-wallet — CARD and
                            BANK_TRANSFER already have their own dedicated fields above,
                            and CASH is handed over in person, so none of the three ever
                            had a QR to scan. */}
                        {isEWallet(payment.method) && (
                          <button
                            type="button"
                            className="secondary"
                            onClick={chargeByQr}
                            disabled={processingPayment || uploadingProof}
                          >
                            Charge by QR
                          </button>
                        )}
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
        title={disputeFor ? `File a dispute — ${labelize(disputeFor.method)}` : 'File a dispute'}
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
              max={(disputeFor.refundableCents / 100).toFixed(2)}
              value={disputeForm.amount}
              onChange={(e) => setDisputeForm({ ...disputeForm, amount: e.target.value })}
            />
            {/* Only worth saying when the two differ — on an untouched payment
                the ceiling IS the amount and repeating it is noise. */}
            {disputeFor.refundableCents !== Number(disputeFor.amountCents) && (
              <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                {formatPeso(disputeFor.refundableCents)} of the original {formatPeso(disputeFor.amountCents)}{' '}
                is still refundable — the rest has already gone back to the guest.
              </p>
            )}
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

      {/* Deciding a claim. This is a modal rather than the plain confirm dialog
          because a decision needs a note with it — the service has always
          stored one, and nothing ever had a way to type it. */}
      <Modal
        open={!!resolving}
        onClose={() => setResolving(null)}
        title={resolving ? DISPUTE_DECISIONS[resolving.decision].title : ''}
        footer={
          <>
            <button className="secondary" onClick={() => setResolving(null)}>
              Cancel
            </button>
            <button onClick={submitResolve} disabled={!!resolvingId}>
              {resolvingId ? 'Working…' : resolving ? DISPUTE_DECISIONS[resolving.decision].verb : 'Confirm'}
            </button>
          </>
        }
      >
        {resolving && (
          <form onSubmit={submitResolve}>
            <p>
              {resolving.decision === 'APPROVED' ? 'Approve' : 'Decide'} the{' '}
              {resolving.dispute.type === 'CHARGEBACK' ? 'chargeback' : 'refund request'} for{' '}
              {formatPeso(resolving.dispute.amountCents)} on this {resolving.dispute.method} payment?
            </p>
            <p className="muted" style={{ fontSize: 12 }}>
              {DISPUTE_DECISIONS[resolving.decision].detail}
            </p>
            <label style={{ marginTop: 10 }}>Note (optional)</label>
            <textarea
              rows={3}
              value={resolveNote}
              onChange={(e) => setResolveNote(e.target.value)}
              placeholder={
                resolving.decision === 'DISPUTED'
                  ? 'The reference the provider gave you, and what you sent them.'
                  : 'Why this claim was decided this way.'
              }
            />
          </form>
        )}
      </Modal>
    </div>
  );
}
