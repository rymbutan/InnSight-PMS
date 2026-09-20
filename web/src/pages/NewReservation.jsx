import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../auth';
import { useToast, errMsg } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { formatPeso, pesosToCents } from '../lib/money';
import Icon from '../components/Icon';
import Autocomplete from '../components/Autocomplete';

import { SOURCES, SOURCE_LABELS } from '../lib/reservationOptions';
import { paymentMethodGroups } from '../lib/paymentMethods';

const STEPS = ['Availability', 'Details', 'Guests', 'Add-ons', 'Payment'];

// Same per-method deposit detail Folios.jsx's "Post payment" modal collects,
// minus amount (that's depositPesos) and proof upload (out of scope here — no
// folio/payment id exists yet at booking time to attach a document to).
const CARD_BRANDS = ['VISA', 'MASTERCARD', 'AMEX', 'DISCOVER', 'JCB', 'OTHER'];
const BANK_NAMES = ['BDO', 'BPI', 'Metrobank', 'UnionBank', 'Landbank', 'OTHER'];
const TRANSFER_NETWORKS = ['InstaPay', 'PESONet', 'Direct OTC Deposit', 'Wire Transfer', 'OTHER'];
const EMPTY_DEPOSIT_DETAIL = {
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
};

// 'YYYY-MM-DDTHH:mm' in LOCAL time, what <input type="datetime-local"> both
// accepts and returns — toISOString() would shift this to UTC.
function nowForDateTimeLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

// Mirrors services/reservation/src/lib/missingDepositField.js exactly, so a
// deposit the wizard lets through is never rejected by the server.
function missingDepositField(method, detail) {
  if (method === 'CARD') {
    if (!/^\d{4}$/.test(detail.cardLast4)) return 'Enter the last 4 digits of the card.';
    if (!detail.cardholderName.trim()) return 'Cardholder name is required.';
  }
  if (method === 'BANK_TRANSFER') {
    if (detail.bankName === 'OTHER' && !detail.bankNameOther.trim()) return 'Enter the bank name.';
    if (detail.transferNetwork === 'OTHER' && !detail.transferNetworkOther.trim()) {
      return 'Enter the transfer network/channel.';
    }
    if (!detail.senderName.trim()) return "Sender/account holder's name is required.";
    if (!detail.bankRef.trim()) return 'Bank reference/control number is required.';
  }
  return null;
}

// Built-in special requests for the Add-ons step's dropdown — the common
// ones a front desk gets asked for repeatedly, so staff pick one instead of
// re-typing it every time. Phrased as a billed line-item description (not
// the guest-facing wording on the public booking page's own checklist),
// since this becomes what prints on the folio. "Other" keeps the free-text
// input for anything not on the list — a cake brand, a specific chocolate,
// whatever the guest actually asked for that isn't one of these.
const BUILT_IN_ADDON_REQUESTS = [
  'High floor room',
  'Quiet room',
  'Luggage storage',
  'Away from elevator',
  'Near elevator',
  'Car parking',
  'Honeymoon arrangements',
  'Baby cot (additional charges may apply)',
  'Airport transfer',
];

export default function NewReservation() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { hasRole } = useAuth();
  const isAdmin = hasRole('ADMIN', 'MANAGER');
  const [step, setStep] = useState(1);

  // Step 1
  const [source, setSource] = useState('DIRECT');
  const [checkIn, setCheckIn] = useState(params.get('checkIn') || '');
  const [checkOut, setCheckOut] = useState('');
  const [promoCode, setPromoCode] = useState('');
  // Per the Terms & Conditions' "Promotional / Non-Refundable Tier": flagged
  // bookings forfeit the full amount on cancellation regardless of timing.
  const [isNonRefundable, setIsNonRefundable] = useState(false);
  const [searched, setSearched] = useState(false);
  const [types, setTypes] = useState([]);
  const [allRooms, setAllRooms] = useState([]);
  // Which specific rooms of each picked type are actually free for
  // [checkIn, checkOut) — { [typeCode]: string[] room ids }. Drives the
  // per-pick room dropdown below; see GET /reservations/available-rooms.
  // Rooms of a type that AREN'T in here for the current dates are not
  // missing by accident — they're already booked for an overlapping window
  // (or genuinely out of service), which is exactly what used to go
  // unchecked when this list was just "every room of the type".
  const [availableRoomIds, setAvailableRoomIds] = useState({});

  // Selections
  const [picks, setPicks] = useState([]); // {typeCode, name, ratePerNightCents, qty, assignedRoomId?}

  // Step 3
  const [guestQ, setGuestQ] = useState('');
  const [pickedGuest, setPickedGuest] = useState(null);
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);
  const [newGuest, setNewGuest] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    streetAddress: '',
    city: '',
    country: 'Philippines',
    state: '',
    postal: '',
  });

  // Step 4 — Add-ons
  const [addOns, setAddOns] = useState([]); // [{ description, costCents }]
  const [addOnDesc, setAddOnDesc] = useState('');
  const [addOnCostPesos, setAddOnCostPesos] = useState('');
  // Which built-in request the dropdown has selected, if any — '' (none
  // chosen yet) or 'OTHER' both fall through to the free-text input below it.
  const [addOnPreset, setAddOnPreset] = useState('');
  const [feePercent, setFeePercent] = useState(10);
  const [feeEditPesos, setFeeEditPesos] = useState('');
  // Defaults mirror DEFAULT_TAX_RATES in services/_shared/policies.js, so a
  // failed fetch still quotes the same figures the backend falls back to.
  const [taxRates, setTaxRates] = useState({ vat: 12, serviceCharge: 10, localTax: 0, realPropertyTax: 0 });

  useEffect(() => {
    api
      .get('/api/settings/addon-fee-percent')
      .then(({ data }) => setFeePercent(data.feePercent))
      .catch(() => {}); // default of 10 already set; a failed fetch just keeps it
  }, []);

  useEffect(() => {
    api
      .get('/api/settings/tax-rates')
      .then(({ data }) => setTaxRates(data))
      .catch(() => {}); // defaults already set; a failed fetch just keeps them
  }, []);

  // costCents alone can't tell "0" (a free special request — allowed) apart
  // from "" (nothing typed yet — not allowed), since both round to 0. Read
  // the raw field instead: entered and non-negative is valid, empty or
  // negative/non-numeric is not.
  function addOnCostEntered() {
    const trimmed = addOnCostPesos.trim();
    if (trimmed === '') return false;
    const n = Number(trimmed);
    return Number.isFinite(n) && n >= 0;
  }
  function addAddOn() {
    if (!addOnDesc.trim() || !addOnCostEntered()) return;
    const costCents = pesosToCents(addOnCostPesos);
    setAddOns((list) => [...list, { description: addOnDesc.trim(), costCents }]);
    setAddOnDesc('');
    setAddOnCostPesos('');
    setAddOnPreset('');
  }
  function removeAddOn(idx) {
    setAddOns((list) => list.filter((_, i) => i !== idx));
  }
  async function saveFeePercent() {
    const pct = Number(feeEditPesos);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return;
    try {
      const { data } = await api.put('/api/settings/addon-fee-percent', { feePercent: pct });
      setFeePercent(data.feePercent);
      setFeeEditPesos('');
      toast.success('Add-on fee updated.');
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  const addOnsTotalCents = useMemo(
    () => addOns.reduce((s, a) => s + Math.round(a.costCents * (1 + feePercent / 100)), 0),
    [addOns, feePercent]
  );

  // Step 5
  const [depositPesos, setDepositPesos] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('CASH');
  // Per-method deposit detail (CARD/BANK_TRANSFER only) — same fields and
  // validation Folios.jsx's own "Post payment" modal uses.
  const [depositDetail, setDepositDetail] = useState(EMPTY_DEPOSIT_DETAIL);
  // CARD/BANK_TRANSFER surcharge preview — the server recomputes and stores
  // the authoritative fee independently, so a stale preview here can never
  // desync what actually lands on the reservation.
  const [paymentFeePercent, setPaymentFeePercent] = useState(0);

  useEffect(() => {
    api
      .get('/api/settings/payment-fee-percent')
      .then(({ data }) => setPaymentFeePercent(data.feePercent))
      .catch(() => {}); // 0 already set; a failed fetch just keeps no preview
  }, []);
  // Track whether the user has begun entering data; if so, warn before
  // navigating away (back-button or tab close).
  const dirty = picks.length > 0 || pickedGuest || newGuest.firstName || depositPesos;
  const submittedRef = useRef(false);
  useEffect(() => {
    function onBeforeUnload(e) {
      if (dirty && !submittedRef.current) {
        e.preventDefault();
        e.returnValue = ''; // Chrome requires returnValue to be set
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    api
      .get('/api/room-types')
      .then((r) => setTypes(r.data))
      .catch(() => {});
    api
      .get('/api/rooms')
      .then((r) => setAllRooms(r.data))
      .catch(() => {});
  }, []);

  // Pre-fill from the calendar's "New reservation here" popover.
  //
  // This used to live in the mount effect behind `setTimeout(..., 200)`, which
  // could never work: the effect's closure captured `types` as the initial empty
  // array, so the lookup 200ms later still searched an empty list and the pick
  // was never added. Clicking a cell on the calendar therefore dropped both the
  // room type and the room it was clicked on, and the wizard opened blank.
  //
  // Keyed on `types` instead, so it runs when the data it needs has actually
  // arrived, and guarded so it runs only once.
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || !types.length) return;
    const code = params.get('roomTypeCode');
    if (!code) return;
    const t = types.find((x) => x.code === code);
    if (!t) return;
    prefilled.current = true;
    addPick(t, params.get('assignedRoomId') || undefined);
  }, [types]);

  // Which rooms are actually free for the current dates — refetched whenever
  // the date range changes or a new room type gets picked. One request per
  // DISTINCT type in `picks`, not per pick, since several picks can share a
  // type. A failed fetch leaves that type's entry alone (undefined) rather
  // than clearing it to an empty list, so the per-pick dropdown below falls
  // back to its old, permissive filter instead of offering nothing at all.
  useEffect(() => {
    if (!checkIn || !checkOut) return undefined;
    const typeCodes = [...new Set(picks.map((p) => p.typeCode))];
    if (!typeCodes.length) return undefined;
    let cancelled = false;
    Promise.all(
      typeCodes.map((roomTypeCode) =>
        api
          .get('/api/reservations/available-rooms', { params: { roomTypeCode, checkIn, checkOut } })
          .then((r) => [roomTypeCode, r.data.roomIds])
          .catch(() => [roomTypeCode, null])
      )
    ).then((pairs) => {
      if (cancelled) return;
      setAvailableRoomIds((prev) => {
        const next = { ...prev };
        for (const [roomTypeCode, ids] of pairs) if (ids) next[roomTypeCode] = ids;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkIn, checkOut, picks.map((p) => p.typeCode).join(',')]);

  function addPick(t, roomId) {
    setPicks((p) => [
      ...p,
      {
        typeCode: t.code,
        name: t.name,
        ratePerNightCents: Number(t.baseRate || 0),
        qty: 1,
        assignedRoomId: roomId,
      },
    ]);
  }
  function removePick(i) {
    setPicks((p) => p.filter((_, idx) => idx !== i));
  }
  function setQty(i, qty) {
    setPicks((p) => p.map((x, idx) => (idx === i ? { ...x, qty: Math.max(1, qty) } : x)));
  }
  function setRoom(i, roomId) {
    setPicks((p) => p.map((x, idx) => (idx === i ? { ...x, assignedRoomId: roomId } : x)));
  }

  const nights = useMemo(() => {
    if (!checkIn || !checkOut) return 0;
    return Math.max(0, Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000));
  }, [checkIn, checkOut]);

  const totals = useMemo(() => {
    const subtotalCents = picks.reduce((s, p) => s + p.ratePerNightCents * p.qty * nights, 0);
    // Mirrors computeTax() in services/_shared/policies.js: four named
    // components at the hotel's configured rates, not a hardcoded VAT-only
    // guess — this is the same total the night audit will eventually charge.
    const taxCents = Math.round(
      (subtotalCents *
        (taxRates.vat + taxRates.serviceCharge + taxRates.localTax + taxRates.realPropertyTax)) /
        100
    );
    const grandTotalCents = subtotalCents + taxCents + addOnsTotalCents;
    const suggestedDepositCents = Math.round(grandTotalCents * 0.5);
    return { subtotalCents, taxCents, grandTotalCents, suggestedDepositCents };
  }, [picks, nights, addOnsTotalCents, taxRates]);

  const balanceDueCents = useMemo(() => {
    return Math.max(0, totals.grandTotalCents - pesosToCents(depositPesos));
  }, [totals, depositPesos]);

  function search() {
    if (!checkIn || !checkOut) return toast.error('Pick check-in and check-out dates first.');
    if (new Date(checkOut) <= new Date(checkIn)) return toast.error('Check-out must be after check-in.');
    setSearched(true);
  }

  // Every "create new guest" field is required before Add-ons is reachable —
  // an existing PICKED guest already has this on file, so the rule only
  // applies down the "Or create new guest" path.
  const NEW_GUEST_REQUIRED_FIELDS = [
    ['firstName', 'First name'],
    ['lastName', 'Last name'],
    ['email', 'Email'],
    ['phone', 'Phone'],
    ['streetAddress', 'Street'],
    ['city', 'City'],
    ['country', 'Country'],
    ['state', 'State/Region'],
    ['postal', 'Postal'],
  ];

  function next() {
    if (step === 1) {
      if (!checkIn || !checkOut) return toast.error('Pick check-in and check-out dates first.');
      if (picks.length === 0) return toast.error('Select at least one accommodation.');
    }
    if (step === 3 && !pickedGuest) {
      const missing = NEW_GUEST_REQUIRED_FIELDS.filter(([key]) => !String(newGuest[key] || '').trim());
      if (missing.length) {
        return toast.error(
          `Pick an existing guest, or fill in every field for the new guest (missing: ${missing
            .map(([, label]) => label)
            .join(', ')}).`
        );
      }
    }
    // Add-ons is deliberately skippable — "no add-ons yet" is a valid
    // finished state, not a missing field. What is NOT allowed is leaving
    // half of the "add a request" mini-form filled in and silently moving on,
    // since that discards what was typed without any signal that it never
    // got added — require it to be finished (via Add) or cleared first.
    if (step === 4 && (addOnDesc.trim() || addOnCostPesos.trim() !== '')) {
      return toast.error(
        'Finish adding this special request (click Add), or clear the special request and cost fields before continuing.'
      );
    }
    setStep(Math.min(STEPS.length, step + 1));
  }
  function back() {
    setStep(Math.max(1, step - 1));
  }

  async function submit() {
    // Mandatory Downpayment Constraint: the server rejects a booking with no
    // recorded downpayment, but that check must not be the guest's first
    // clue — this catches it in the wizard, before a guest/room is created.
    if (!(pesosToCents(depositPesos) > 0)) {
      return toast.error(
        'A downpayment is required before this booking can be created. Enter the deposit amount collected.'
      );
    }
    // Same per-method requirements Folio holds a folio payment to — checked
    // here, before a guest/room is created, so a rejection never comes as a
    // surprise after the wizard has already done other work.
    const missingDeposit = missingDepositField(paymentMethod, depositDetail);
    if (missingDeposit) return toast.error(missingDeposit);
    try {
      // create guest if new
      let guest = pickedGuest;
      if (!guest && newGuest.firstName) {
        const { data } = await api.post('/api/guests', newGuest);
        guest = data;
      }
      const first = picks[0];
      const payload = {
        guestId: guest?.id,
        guestName: guest?.displayName || `${newGuest.firstName} ${newGuest.lastName}`.trim(),
        guestEmail: guest?.email || newGuest.email,
        guestPhone: guest?.phone || newGuest.phone,
        roomTypeCode: first.typeCode,
        // Omitted rather than sent as '' when the user leaves it on auto-assign:
        // the server treats '' as a room id, and an empty string defeats the
        // double-booking constraint's IS NOT NULL guard. The server normalises
        // it too, but there is no reason to send a value that means nothing.
        assignedRoomId: first.assignedRoomId || undefined,
        checkIn,
        checkOut,
        adults: Number(adults) || 1,
        children: Number(children) || 0,
        source,
        totalEstimateCents: totals.grandTotalCents,
        depositCents: pesosToCents(depositPesos),
        paymentType: paymentMethod,
        isNonRefundable,
        ratePlan: 'Base Rate',
        origin: SOURCE_LABELS[source],
        // Resolved the same way Folios.jsx's postPayment does: CARD sends a
        // masked receipt-style string, BANK_TRANSFER resolves its "OTHER"
        // free-text fields and defaults transferredAt to now.
        ...(paymentMethod === 'CARD' && {
          cardMasked: `${depositDetail.cardBrand} •••• ${depositDetail.cardLast4}`,
          cardholderName: depositDetail.cardholderName.trim(),
        }),
        ...(paymentMethod === 'CARD' &&
          depositDetail.gatewayRef.trim() && { gatewayRef: depositDetail.gatewayRef.trim() }),
        ...(paymentMethod === 'BANK_TRANSFER' && {
          bankName:
            depositDetail.bankName === 'OTHER' ? depositDetail.bankNameOther.trim() : depositDetail.bankName,
          transferNetwork:
            depositDetail.transferNetwork === 'OTHER'
              ? depositDetail.transferNetworkOther.trim()
              : depositDetail.transferNetwork,
          senderName: depositDetail.senderName.trim(),
          gatewayRef: depositDetail.bankRef.trim(),
          transferredAt: new Date(depositDetail.transferredAt || nowForDateTimeLocal()).toISOString(),
        }),
        // Send the CODE, never a computed discount. The server validates it,
        // applies the percentage to the total and writes the note on the
        // reservation — see POST /api/reservations. It used to be recorded as a
        // Special Requests note and nothing more, so the guest was quoted a
        // discount and charged full price. It also used to OVERWRITE whatever
        // the guest had typed into Special Requests; the server now appends.
        ...(promoCode ? { promoCode: promoCode.trim().toUpperCase() } : {}),
        ...(addOns.length
          ? { addOns: addOns.map((a) => ({ description: a.description, costCents: a.costCents })) }
          : {}),
      };
      const { data: r } = await api.post('/api/reservations', payload);
      // Auto-confirm
      await api.post(`/api/reservations/${r.id}/confirm`);
      submittedRef.current = true; // disable beforeunload guard
      toast.success(`Reservation ${r.confirmationNumber} created and confirmed.`);
      navigate(`/reservations/${r.id}`);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  return (
    <div>
      <div className="page-head">
        <h1>New Reservation</h1>
        <div className="wizard-steps">
          {STEPS.map((s, i) => (
            <div key={s} className={`wizard-step ${step === i + 1 ? 'active' : step > i + 1 ? 'done' : ''}`}>
              <span className="num">{step > i + 1 ? <Icon name="check" size={12} /> : i + 1}</span> {s}
            </div>
          ))}
        </div>
      </div>

      {/* Step 1 — Availability */}
      {step === 1 && (
        <>
          <div className="panel-tinted">
            <div className="row">
              <div>
                <label>Source *</label>
                <select value={source} onChange={(e) => setSource(e.target.value)}>
                  {SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {SOURCE_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Check-In</label>
                <input type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
              </div>
              <div>
                <label>Check-Out</label>
                <input type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
              </div>
              <div>
                <label>Promo code</label>
                <input value={promoCode} onChange={(e) => setPromoCode(e.target.value)} />
              </div>
              {/* `ed-check` gives this the same small box and inline label as
                  every other field-row checkbox (e.g. Amenities.jsx's
                  Reservable toggle), instead of a 36px square from the global
                  input rule with its caption wrapping beside it. `row-action`
                  opts this cell out of .row's flex:1 stretch so it sits at its
                  natural width rather than matching the date/promo fields. */}
              <div className="row-action" style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 10 }}>
                <label className="ed-check">
                  <input
                    type="checkbox"
                    checked={isNonRefundable}
                    onChange={(e) => setIsNonRefundable(e.target.checked)}
                  />
                  <span>Non-refundable / promo rate</span>
                </label>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                <button className="btn-cta" onClick={search}>
                  <Icon name="search" size={14} style={{ marginRight: 6 }} />
                  Search
                </button>
              </div>
            </div>
          </div>

          <div className="panel">
            <h3>Accommodations</h3>
            {!searched ? (
              <div className="muted" style={{ textAlign: 'center', padding: 36 }}>
                <Icon
                  name="bed"
                  size={36}
                  color="var(--muted-2)"
                  style={{ display: 'block', margin: '0 auto 8px' }}
                />
                Select check-in and check-out dates to search for availability
              </div>
            ) : (
              <>
                {picks.length > 0 && (
                  <div
                    style={{
                      marginBottom: 16,
                      padding: 12,
                      background: 'var(--accent-soft)',
                      borderRadius: 8,
                    }}
                  >
                    <strong>Selected:</strong>
                    {picks.map((p, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
                        <span style={{ flex: 1 }}>{p.name}</span>
                        <input
                          type="number"
                          min="1"
                          value={p.qty}
                          onChange={(e) => setQty(i, Number(e.target.value))}
                          style={{ width: 60 }}
                        />
                        <select
                          value={p.assignedRoomId || ''}
                          onChange={(e) => setRoom(i, e.target.value)}
                          style={{ width: 140 }}
                        >
                          <option value="">Auto-assign (first free room)</option>
                          {/* Only rooms actually free for [checkIn, checkOut) —
                              see the available-rooms fetch above. This used to
                              list every room of the type that wasn't
                              OUT_OF_ORDER, with no date-overlap check at all,
                              which is how a room already booked by someone
                              else for these exact dates ended up selectable
                              right next to Auto-assign. Falls back to the old,
                              permissive filter only if that fetch hasn't
                              resolved yet (or failed) for this type — so a
                              slow network never leaves the dropdown empty. */}
                          {(availableRoomIds[p.typeCode]
                            ? allRooms.filter(
                                (r) =>
                                  availableRoomIds[p.typeCode].includes(r.id) || r.id === p.assignedRoomId
                              )
                            : allRooms.filter((r) => r.typeCode === p.typeCode && r.status !== 'OUT_OF_ORDER')
                          ).map((r) => (
                            <option key={r.id} value={r.id}>
                              Room {r.number}
                            </option>
                          ))}
                        </select>
                        <span style={{ width: 100, textAlign: 'right' }}>
                          {formatPeso(p.ratePerNightCents * p.qty * nights)}
                        </span>
                        <button className="icon" onClick={() => removePick(i)} aria-label="Remove">
                          <Icon name="x" size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <table>
                  <thead>
                    <tr>
                      <th>Room Type</th>
                      <th className="t-c">Max Occupancy</th>
                      <th className="t-c">Available</th>
                      <th className="t-n">Rate / night</th>
                      <th className="t-c"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {types.map((t) => (
                      <tr key={t.code}>
                        <td>
                          <strong>{t.name}</strong> <span className="muted">({t.code})</span>
                        </td>
                        <td className="t-c">{t.maxOccupancy}</td>
                        <td className="t-c">{t.totalInventory}</td>
                        <td className="t-n">{formatPeso(t.baseRate)}</td>
                        <td className="t-actions">
                          <button className="btn-primary small" onClick={() => addPick(t)}>
                            <Icon name="plus" size={12} style={{ marginRight: 4 }} />
                            Add
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </>
      )}

      {/* Step 2 — Details */}
      {step === 2 && (
        <div className="panel">
          <h3>Stay details</h3>
          <div className="row">
            <div>
              <label>Check-In</label>
              <input type="date" value={checkIn} disabled />
            </div>
            <div>
              <label>Check-Out</label>
              <input type="date" value={checkOut} disabled />
            </div>
            <div>
              <label>Nights</label>
              <input value={nights} disabled />
            </div>
            <div>
              <label>Source</label>
              <input value={SOURCE_LABELS[source]} disabled />
            </div>
          </div>
          <h3 style={{ marginTop: 18 }}>Accommodation summary</h3>
          <table>
            <thead>
              <tr>
                <th>Room Type</th>
                <th className="t-c">Quantity</th>
                <th className="t-c">Room</th>
                <th className="t-c">Nights</th>
                <th className="t-n">Total</th>
              </tr>
            </thead>
            <tbody>
              {picks.map((p, i) => (
                <tr key={i}>
                  <td>{p.name}</td>
                  <td className="t-c">{p.qty}</td>
                  <td className="t-c">
                    {p.assignedRoomId
                      ? `Room ${allRooms.find((r) => r.id === p.assignedRoomId)?.number}`
                      : 'Auto'}
                  </td>
                  <td className="t-c">{nights}</td>
                  <td className="t-n">{formatPeso(p.ratePerNightCents * p.qty * nights)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Step 3 — Guests */}
      {step === 3 && (
        <div className="panel">
          <h3>Guest information</h3>
          <div className="row" style={{ marginBottom: 16 }}>
            <div>
              <label>Adults</label>
              <input
                type="number"
                min="1"
                required
                value={adults}
                onChange={(e) => setAdults(e.target.value)}
              />
            </div>
            <div>
              <label>Children</label>
              <input
                type="number"
                min="0"
                value={children}
                onChange={(e) => setChildren(e.target.value)}
              />
            </div>
          </div>
          {pickedGuest ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: 14,
                background: 'var(--accent-soft)',
                borderRadius: 8,
                marginBottom: 16,
              }}
            >
              <strong>{pickedGuest.displayName}</strong>
              <span className="muted">{pickedGuest.email}</span>
              <button
                className="secondary small"
                style={{ marginLeft: 'auto' }}
                onClick={() => setPickedGuest(null)}
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <label>Search existing guest</label>
              {/* Was an always-open results box pushed below the field; now the
                  shared overlay panel, so it matches every other search in the
                  app and supports arrow-key selection. */}
              <Autocomplete
                value={guestQ}
                onChange={setGuestQ}
                placeholder="Search by name, email, phone…"
                endpoint={(term) => `/api/guests/search?q=${encodeURIComponent(term)}`}
                mapItem={(g) => ({ id: g.id, title: g.displayName, meta: g.email || '' })}
                onPick={(g) => setPickedGuest(g)}
              />
              <h3 style={{ marginTop: 22 }}>Or create new guest</h3>
              <div className="row">
                <div>
                  <label>First name *</label>
                  <input
                    required
                    value={newGuest.firstName}
                    onChange={(e) => setNewGuest({ ...newGuest, firstName: e.target.value })}
                  />
                </div>
                <div>
                  <label>Last name *</label>
                  <input
                    required
                    value={newGuest.lastName}
                    onChange={(e) => setNewGuest({ ...newGuest, lastName: e.target.value })}
                  />
                </div>
                <div>
                  <label>Email *</label>
                  <input
                    required
                    type="email"
                    value={newGuest.email}
                    onChange={(e) => setNewGuest({ ...newGuest, email: e.target.value })}
                  />
                </div>
                <div>
                  <label>Phone *</label>
                  <input
                    required
                    value={newGuest.phone}
                    onChange={(e) => setNewGuest({ ...newGuest, phone: e.target.value })}
                  />
                </div>
              </div>
              <h3>Guest address</h3>
              <div className="row">
                <div>
                  <label>Street *</label>
                  <input
                    required
                    value={newGuest.streetAddress}
                    onChange={(e) => setNewGuest({ ...newGuest, streetAddress: e.target.value })}
                  />
                </div>
                <div>
                  <label>City *</label>
                  <input
                    required
                    value={newGuest.city}
                    onChange={(e) => setNewGuest({ ...newGuest, city: e.target.value })}
                  />
                </div>
                <div>
                  <label>Country *</label>
                  <input
                    required
                    value={newGuest.country}
                    onChange={(e) => setNewGuest({ ...newGuest, country: e.target.value })}
                  />
                </div>
                <div>
                  <label>State/Region *</label>
                  <input
                    required
                    value={newGuest.state}
                    onChange={(e) => setNewGuest({ ...newGuest, state: e.target.value })}
                  />
                </div>
                <div>
                  <label>Postal *</label>
                  <input
                    required
                    value={newGuest.postal}
                    onChange={(e) => setNewGuest({ ...newGuest, postal: e.target.value })}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Step 4 — Add-ons */}
      {step === 4 && (
        <div className="panel">
          <h3>Add-ons</h3>
          {addOns.length === 0 && (
            <div className="muted" style={{ padding: 12 }}>
              No add-ons yet. Add a special request below, or skip to the next step to take payment.
            </div>
          )}
          {addOns.map((a, i) => {
            const totalCents = Math.round(a.costCents * (1 + feePercent / 100));
            return (
              <div key={i} className="row" style={{ alignItems: 'center' }}>
                <div style={{ flex: 1 }}>{a.description}</div>
                <div>{formatPeso(a.costCents)}</div>
                <div className="muted">+{feePercent}% fee</div>
                <div>{formatPeso(totalCents)}</div>
                <button className="secondary" onClick={() => removeAddOn(i)}>
                  Remove
                </button>
              </div>
            );
          })}
          <div className="row" style={{ marginTop: 12 }}>
            <div>
              <label>Special request</label>
              <select
                value={addOnPreset}
                onChange={(e) => {
                  const val = e.target.value;
                  setAddOnPreset(val);
                  setAddOnDesc(val === 'OTHER' ? '' : val);
                }}
              >
                <option value="">Choose a built-in request…</option>
                {BUILT_IN_ADDON_REQUESTS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
                <option value="OTHER">Other — type your own…</option>
              </select>
            </div>
            <div>
              <label>Cost (₱)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={addOnCostPesos}
                onChange={(e) => setAddOnCostPesos(e.target.value)}
              />
            </div>
            <div className="row-action">
              <button onClick={addAddOn} disabled={!addOnDesc.trim() || !addOnCostEntered()}>
                Add
              </button>
            </div>
          </div>
          {/* Kept OUT of the row above on purpose: it used to live inside the
              "Special request" cell, and that cell growing to fit a second
              input stretched the whole row — Cost's input floated near the
              top of a now-much-taller cell while Add sank to the bottom,
              visibly disconnected from both. A full-width row of its own
              can't distort anything beside it. */}
          {addOnPreset === 'OTHER' && (
            <div className="row" style={{ marginTop: -4 }}>
              <div style={{ flex: 1 }}>
                <label>Custom request</label>
                <input
                  value={addOnDesc}
                  placeholder="e.g. specific brand of cake"
                  onChange={(e) => setAddOnDesc(e.target.value)}
                />
              </div>
            </div>
          )}
          {addOns.length > 0 && (
            <div className="row" style={{ marginTop: 8, fontWeight: 600 }}>
              <div style={{ flex: 1 }}>Add-ons total</div>
              <div>{formatPeso(addOnsTotalCents)}</div>
            </div>
          )}
          {isAdmin && (
            <div
              className="row"
              style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}
            >
              <div className="muted">Current add-on fee: {feePercent}%</div>
              <input
                type="number"
                step="0.1"
                min="0"
                max="100"
                style={{ width: 100 }}
                placeholder={String(feePercent)}
                value={feeEditPesos}
                onChange={(e) => setFeeEditPesos(e.target.value)}
              />
              <button className="secondary" disabled={feeEditPesos === ''} onClick={saveFeePercent}>
                Save fee %
              </button>
            </div>
          )}
        </div>
      )}

      {/* Step 5 — Payment */}
      {step === 5 && (
        <div className="panel">
          <h3>Payment</h3>
          <div className="row">
            <div>
              <label>Suggested deposit</label>
              <input value={formatPeso(totals.suggestedDepositCents)} disabled />
            </div>
            <div>
              <label>Deposit amount (₱) *</label>
              <input
                type="number"
                min="0.01"
                step="0.01"
                required
                value={depositPesos}
                onChange={(e) => setDepositPesos(e.target.value)}
                placeholder={(totals.suggestedDepositCents / 100).toFixed(2)}
              />
            </div>
            <div>
              <label>Payment method *</label>
              <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
                {paymentMethodGroups().map((g) =>
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
                )}
              </select>
            </div>
          </div>

          {/* A preview only — the server computes and stores the authoritative
              fee independently (see policies.js's paymentProcessingFeeCents),
              so this can never desync what actually gets recorded. */}
          {(paymentMethod === 'CARD' || paymentMethod === 'BANK_TRANSFER') &&
            paymentFeePercent > 0 &&
            pesosToCents(depositPesos) > 0 && (
              <p className="muted" style={{ fontSize: 12 }}>
                + Processing fee ({paymentFeePercent}%):{' '}
                {formatPeso(Math.round(pesosToCents(depositPesos) * (paymentFeePercent / 100)))}
              </p>
            )}

          {/* A card terminal reads the card, not a typed-in number — this asks
              only for what a receipt would show (brand + last 4 + cardholder
              name), same rule as Folios.jsx's own "Post payment" modal. */}
          {paymentMethod === 'CARD' && (
            <>
              <div className="row" style={{ marginTop: 10 }}>
                <div>
                  <label>Card brand</label>
                  <select
                    value={depositDetail.cardBrand}
                    onChange={(e) => setDepositDetail({ ...depositDetail, cardBrand: e.target.value })}
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
                    value={depositDetail.cardLast4}
                    onChange={(e) =>
                      setDepositDetail({
                        ...depositDetail,
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
                value={depositDetail.cardholderName}
                onChange={(e) => setDepositDetail({ ...depositDetail, cardholderName: e.target.value })}
              />
              {/* Optional: staff can type in the ACTUAL authorization code a real
                  terminal printed. Left blank, the server simulates one (AUTH-…). */}
              <label style={{ marginTop: 10 }}>Transaction / Authorization code (optional)</label>
              <input
                placeholder="Gateway transaction ID or POS approval code — leave blank to simulate one"
                value={depositDetail.gatewayRef}
                onChange={(e) => setDepositDetail({ ...depositDetail, gatewayRef: e.target.value })}
              />
            </>
          )}

          {/* Bank transfer has nothing to simulate a control number FROM — every
              field here is required (see missingDepositField, both here and
              server-side in lib/missingDepositField.js). */}
          {paymentMethod === 'BANK_TRANSFER' && (
            <>
              <div className="row" style={{ marginTop: 10 }}>
                <div>
                  <label>Bank name</label>
                  <select
                    value={depositDetail.bankName}
                    onChange={(e) => setDepositDetail({ ...depositDetail, bankName: e.target.value })}
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
                    value={depositDetail.transferNetwork}
                    onChange={(e) => setDepositDetail({ ...depositDetail, transferNetwork: e.target.value })}
                  >
                    {TRANSFER_NETWORKS.map((n) => (
                      <option key={n} value={n}>
                        {n === 'OTHER' ? 'Other — type your own…' : n}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {depositDetail.bankName === 'OTHER' && (
                <input
                  required
                  style={{ marginTop: 8 }}
                  placeholder="Bank name"
                  value={depositDetail.bankNameOther}
                  onChange={(e) => setDepositDetail({ ...depositDetail, bankNameOther: e.target.value })}
                />
              )}
              {depositDetail.transferNetwork === 'OTHER' && (
                <input
                  required
                  style={{ marginTop: 8 }}
                  placeholder="Transfer network / channel"
                  value={depositDetail.transferNetworkOther}
                  onChange={(e) =>
                    setDepositDetail({ ...depositDetail, transferNetworkOther: e.target.value })
                  }
                />
              )}

              <label style={{ marginTop: 10 }}>Sender / account holder name</label>
              <input
                required
                value={depositDetail.senderName}
                onChange={(e) => setDepositDetail({ ...depositDetail, senderName: e.target.value })}
              />

              <label style={{ marginTop: 10 }}>Bank reference / control number</label>
              <input
                required
                placeholder="Mandatory transaction ID from the slip or app"
                value={depositDetail.bankRef}
                onChange={(e) => setDepositDetail({ ...depositDetail, bankRef: e.target.value })}
              />

              <label style={{ marginTop: 10 }}>Transfer date &amp; time</label>
              <input
                required
                type="datetime-local"
                value={depositDetail.transferredAt || nowForDateTimeLocal()}
                onChange={(e) => setDepositDetail({ ...depositDetail, transferredAt: e.target.value })}
              />
            </>
          )}

          <div className="muted" style={{ marginTop: 12 }}>
            A downpayment is required to create this booking. On confirm: reservation will be created &amp;
            auto-confirmed, and the deposit will post to the folio after check-in.
          </div>
        </div>
      )}

      {/* Sticky bottom bar */}
      <div className="wizard-bottom">
        <div className="wizard-totals">
          <div className="wizard-total">
            <div className="label">Subtotal</div>
            <div className="value">{formatPeso(totals.subtotalCents)}</div>
          </div>
          <div className="wizard-total">
            <div className="label">Taxes</div>
            <div className="value">{formatPeso(totals.taxCents)}</div>
          </div>
          <div className="wizard-total">
            <div className="label">Grand Total</div>
            <div className="value">{formatPeso(totals.grandTotalCents)}</div>
          </div>
          <div className="wizard-total">
            <div className="label">Suggested Deposit</div>
            <div className="value">{formatPeso(totals.suggestedDepositCents)}</div>
          </div>
          <div className="wizard-total balance">
            <div className="label">Balance Due</div>
            <div className="value">{formatPeso(balanceDueCents)}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            className="btn-ghost"
            onClick={async () => {
              if (dirty) {
                const ok = await confirm({
                  title: 'Discard changes',
                  message: 'You have unsaved changes. Discard them?',
                  confirmLabel: 'Discard',
                });
                if (!ok) return;
              }
              navigate('/reservations');
            }}
          >
            Cancel
          </button>
          {step > 1 && (
            <button className="secondary" onClick={back}>
              <Icon name="chevron-left" size={14} style={{ marginRight: 4 }} />
              {STEPS[step - 2]}
            </button>
          )}
          {step < STEPS.length && (
            <button className="btn-cta" onClick={next}>
              {STEPS[step]} <Icon name="chevron-right" size={14} style={{ marginLeft: 4 }} />
            </button>
          )}
          {step === STEPS.length && (
            <button className="btn-cta" onClick={submit}>
              Confirm &amp; Pay <Icon name="check" size={14} style={{ marginLeft: 4 }} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
