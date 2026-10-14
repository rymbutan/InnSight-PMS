import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../auth';
import { useToast, errMsg } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { formatPeso, pesosToCents } from '../lib/money';
import Icon from '../components/Icon';
import Autocomplete from '../components/Autocomplete';

import { SOURCES, SOURCE_LABELS, SPECIAL_REQUEST_QUICK_PICKS, BANK_NAMES, TRANSFER_NETWORKS } from '../lib/reservationOptions';
import { CARD_BRANDS, EMPTY_DEPOSIT_DETAIL, nowForDateTimeLocal, missingDepositField } from '../lib/depositDetail';
import { paymentMethodGroups } from '../lib/paymentMethods';
import { ADDON_PREFERENCE_CATEGORY, useAddOnCatalog } from '../lib/guestAddonPreferences';

const STEPS = ['Availability', 'Details', 'Guests', 'Payment'];

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
  // Free-text guest preference, no cost — see Stay details in Step 2.
  // Standardized preferences (extra pillows, etc.) live on the guest's own
  // profile now instead of being re-entered per booking — see Guests.jsx.
  const [specialRequests, setSpecialRequests] = useState('');
  const [otherSpecialRequest, setOtherSpecialRequest] = useState('');
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
  // This guest's saved bank-transfer details (Ms. Padilla, Lane A-07) — lets
  // the Payment step auto-fill from one instead of retyping bank/network/
  // sender every time. Purely a convenience default: the reservation still
  // records its own copy of whatever ends up in the deposit fields, same as
  // if it had been typed by hand.
  const [guestBankAccounts, setGuestBankAccounts] = useState([]);
  useEffect(() => {
    if (!pickedGuest?.id) return setGuestBankAccounts([]);
    api
      .get(`/api/guests/${pickedGuest.id}/bank-accounts`)
      .then(({ data }) => setGuestBankAccounts(Array.isArray(data) ? data : []))
      .catch(() => setGuestBankAccounts([])); // no saved accounts is the common case, not an error
  }, [pickedGuest?.id]);
  // Lives on the guest's own profile (GuestPreference), not on the
  // reservation — but editable right here too, not only from Guests.jsx.
  // Each toggle PUTs straight to the guest's profile, same endpoint
  // Guests.jsx itself uses, so the two are always the same data and neither
  // can drift into its own per-booking copy.
  const [guestAddonPrefs, setGuestAddonPrefs] = useState({}); // { [code]: true }
  const addonCatalog = useAddOnCatalog();
  const [savingAddonPref, setSavingAddonPref] = useState(null);
  useEffect(() => {
    if (!pickedGuest?.id) return setGuestAddonPrefs({});
    api
      .get(`/api/guests/${pickedGuest.id}/preferences`)
      .then(({ data }) =>
        setGuestAddonPrefs(
          Object.fromEntries(
            (Array.isArray(data) ? data : [])
              .filter((p) => p.category === ADDON_PREFERENCE_CATEGORY && p.value)
              .map((p) => [p.key, true])
          )
        )
      )
      .catch(() => setGuestAddonPrefs({}));
  }, [pickedGuest?.id]);

  async function toggleGuestAddonPref(code, checked) {
    if (!pickedGuest?.id) return;
    setSavingAddonPref(code);
    setGuestAddonPrefs((m) => ({ ...m, [code]: checked || undefined }));
    try {
      await api.put(`/api/guests/${pickedGuest.id}/preferences/${code}`, {
        category: ADDON_PREFERENCE_CATEGORY,
        value: checked,
      });
    } catch (e) {
      setGuestAddonPrefs((m) => ({ ...m, [code]: !checked || undefined }));
      toast.error(errMsg(e));
    } finally {
      setSavingAddonPref(null);
    }
  }
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

  // Company/banking details are guest-profile fields (Guests.jsx), but shown
  // and editable here too — in Step 2, ahead of Step 3's guest pick — so the
  // desk doesn't have to leave the wizard. Synced FROM the picked guest once
  // one exists; for a brand-new guest they're carried in the POST /api/guests
  // payload at submit() instead, same pattern as name/email/phone above.
  const [companyName, setCompanyName] = useState('');
  const [employeeName, setEmployeeName] = useState('');
  useEffect(() => {
    setCompanyName(pickedGuest?.companyName || '');
    setEmployeeName(pickedGuest?.employeeName || '');
  }, [pickedGuest?.id]);

  const [newBankAccount, setNewBankAccount] = useState({
    bankName: '',
    accountName: '',
    accountNumberLast4: '',
    transferNetwork: '',
  });
  const [savingBankAccount, setSavingBankAccount] = useState(false);

  async function refreshGuestBankAccounts() {
    if (!pickedGuest?.id) return;
    try {
      const { data } = await api.get(`/api/guests/${pickedGuest.id}/bank-accounts`);
      setGuestBankAccounts(Array.isArray(data) ? data : []);
    } catch (err) {
      toast.error(errMsg(err));
    }
  }

  async function addGuestBankAccount() {
    if (!pickedGuest?.id) return;
    const { bankName, accountName, accountNumberLast4, transferNetwork } = newBankAccount;
    if (!bankName.trim() || !accountName.trim() || !/^\d{4}$/.test(accountNumberLast4)) {
      return toast.error('Bank, account name, and the last 4 digits (exactly 4) are required.');
    }
    setSavingBankAccount(true);
    try {
      await api.post(`/api/guests/${pickedGuest.id}/bank-accounts`, {
        bankName: bankName.trim(),
        accountName: accountName.trim(),
        accountNumberLast4,
        transferNetwork: transferNetwork.trim() || undefined,
        isDefault: guestBankAccounts.length === 0,
      });
      setNewBankAccount({ bankName: '', accountName: '', accountNumberLast4: '', transferNetwork: '' });
      await refreshGuestBankAccounts();
      toast.success('Bank account saved.');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setSavingBankAccount(false);
    }
  }

  // Defaults mirror DEFAULT_TAX_RATES in services/_shared/policies.js, so a
  // failed fetch still quotes the same figures the backend falls back to.
  const [taxRates, setTaxRates] = useState({ vat: 12, serviceCharge: 10, localTax: 0, realPropertyTax: 0 });

  useEffect(() => {
    api
      .get('/api/settings/tax-rates')
      .then(({ data }) => setTaxRates(data))
      .catch(() => {}); // defaults already set; a failed fetch just keeps them
  }, []);

  // Step 4 — Payment
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

  // Checked add-ons, priced from the live catalog — same rows toggleGuestAddonPref
  // writes to the guest's profile, just also charged onto THIS reservation.
  const checkedAddOns = useMemo(
    () => addonCatalog.filter((o) => guestAddonPrefs[o.code]),
    [addonCatalog, guestAddonPrefs]
  );

  const totals = useMemo(() => {
    const subtotalCents = picks.reduce((s, p) => s + p.ratePerNightCents * p.qty * nights, 0);
    const addOnsCents = checkedAddOns.reduce((s, o) => s + (o.priceCents || 0), 0);
    // Mirrors computeTax() in services/_shared/policies.js: four named
    // components at the hotel's configured rates, not a hardcoded VAT-only
    // guess — this is the same total the night audit will eventually charge.
    const taxCents = Math.round(
      (subtotalCents *
        (taxRates.vat + taxRates.serviceCharge + taxRates.localTax + taxRates.realPropertyTax)) /
        100
    );
    const grandTotalCents = subtotalCents + addOnsCents + taxCents;
    const suggestedDepositCents = Math.round(grandTotalCents * 0.5);
    return { subtotalCents, addOnsCents, taxCents, grandTotalCents, suggestedDepositCents };
  }, [picks, nights, taxRates, checkedAddOns]);

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
    setStep(Math.min(STEPS.length, step + 1));
  }
  function back() {
    setStep(Math.max(1, step - 1));
  }

  // A saved account's bank/network might not be one of the fixed options this
  // form offers (BANK_NAMES/TRANSFER_NETWORKS) — falls back to "Other" with
  // the real value typed in, same as a human picking "Other" would.
  function applySavedBankAccount(account) {
    const bankKnown = BANK_NAMES.includes(account.bankName);
    const networkKnown = account.transferNetwork && TRANSFER_NETWORKS.includes(account.transferNetwork);
    setDepositDetail({
      ...depositDetail,
      bankName: bankKnown ? account.bankName : 'OTHER',
      bankNameOther: bankKnown ? '' : account.bankName,
      transferNetwork: account.transferNetwork ? (networkKnown ? account.transferNetwork : 'OTHER') : depositDetail.transferNetwork,
      transferNetworkOther: account.transferNetwork && !networkKnown ? account.transferNetwork : '',
      senderName: account.accountName,
    });
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
        const { data } = await api.post('/api/guests', {
          ...newGuest,
          companyName: companyName.trim() || undefined,
          employeeName: employeeName.trim() || undefined,
        });
        guest = data;
      } else if (guest && (companyName.trim() !== (guest.companyName || '') || employeeName.trim() !== (guest.employeeName || ''))) {
        // Existing guest, edited here in Step 2 — write back to their profile
        // so it's still there next time, same as editing it from Guests.jsx.
        const { data } = await api.patch(`/api/guests/${guest.id}`, {
          companyName: companyName.trim(),
          employeeName: employeeName.trim(),
        });
        guest = data;
      }
      // A bank account typed into Step 2 before a guest existed (or left
      // un-saved for a picked guest) — save it now that guest.id is known.
      // "+ Add account" already saves immediately once a guest is picked, so
      // this only ever fires for what that button couldn't reach yet.
      if (guest?.id && newBankAccount.bankName.trim() && newBankAccount.accountName.trim() && /^\d{4}$/.test(newBankAccount.accountNumberLast4)) {
        try {
          await api.post(`/api/guests/${guest.id}/bank-accounts`, {
            bankName: newBankAccount.bankName.trim(),
            accountName: newBankAccount.accountName.trim(),
            accountNumberLast4: newBankAccount.accountNumberLast4,
            transferNetwork: newBankAccount.transferNetwork.trim() || undefined,
            isDefault: guestBankAccounts.length === 0,
          });
        } catch (e) {
          toast.error(`Reservation created, but the bank account could not be saved: ${errMsg(e)}`);
        }
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
        // Priced from the catalog at submit time, in the shape the server's
        // computeAddOns() already expects.
        addOns: checkedAddOns.map((o) => ({ description: o.label, costCents: o.priceCents })),
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
        ...(specialRequests.trim() ? { specialRequests: specialRequests.trim() } : {}),
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
        <div className="wizard-steps" data-tour="g-reservation-new-steps">
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
          <div className="panel-tinted" data-tour="g-reservation-new-search">
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
                <label className="ed-check" data-tour="g-reservation-new-nonrefund">
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

          <div className="panel" data-tour="g-reservation-new-rooms">
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
                            : // While the availability fetch is still in flight, don't
                              // offer a room that's plainly unusable or occupied right
                              // now — the server re-checks this on submit regardless
                              // (see reservation.routes.js's isRoomFree), but a choice
                              // this list shouldn't have suggested in the first place
                              // is worse UX than a shorter list for a moment.
                              allRooms.filter(
                                (r) =>
                                  r.typeCode === p.typeCode &&
                                  !['OUT_OF_ORDER', 'OUT_OF_SERVICE', 'OCCUPIED'].includes(r.status)
                              )
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

          {/* Free-text, guest- and stay-specific, no cost of its own. A
              guest's STANDING preferences (extra pillows, and the like) live
              on their own profile now (Guests.jsx) instead of being
              re-entered — and re-priced — on every booking. */}
          <h3 style={{ marginTop: 18 }}>Special requests</h3>
          <textarea
            rows={3}
            value={specialRequests}
            onChange={(e) => setSpecialRequests(e.target.value)}
            placeholder="e.g. Honeymoon trip — please set the room up for a couple."
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {SPECIAL_REQUEST_QUICK_PICKS.map((opt) => (
              <button
                key={opt}
                type="button"
                className="secondary small"
                onClick={() =>
                  setSpecialRequests((prev) => {
                    if (prev.split(/,\s*/).includes(opt)) return prev;
                    return prev.trim() ? `${prev.trim()}, ${opt}` : opt;
                  })
                }
              >
                + {opt}
              </button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <div style={{ flex: 1 }}>
              <input
                value={otherSpecialRequest}
                onChange={(e) => setOtherSpecialRequest(e.target.value)}
                placeholder="Other — type a request not listed above"
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  const text = otherSpecialRequest.trim();
                  if (!text) return;
                  setSpecialRequests((prev) => (prev.trim() ? `${prev.trim()}, ${text}` : text));
                  setOtherSpecialRequest('');
                }}
              />
            </div>
            <div style={{ alignSelf: 'flex-end' }}>
              <button
                type="button"
                className="secondary small"
                disabled={!otherSpecialRequest.trim()}
                onClick={() => {
                  const text = otherSpecialRequest.trim();
                  if (!text) return;
                  setSpecialRequests((prev) => (prev.trim() ? `${prev.trim()}, ${text}` : text));
                  setOtherSpecialRequest('');
                }}
              >
                + Add
              </button>
            </div>
          </div>

          {/* Company/banking live on the guest's own profile (Guests.jsx) —
              editable here too so the desk doesn't have to leave the wizard
              to set them up before Step 3's guest pick. */}
          <h3 style={{ marginTop: 18 }}>Company details</h3>
          <div className="row">
            <div>
              <label>Company name</label>
              <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
            </div>
            <div>
              <label>Employee name</label>
              <input value={employeeName} onChange={(e) => setEmployeeName(e.target.value)} />
            </div>
          </div>

          <h3 style={{ marginTop: 18 }}>Banking details</h3>
          {pickedGuest && guestBankAccounts.length > 0 && (
            <table style={{ marginBottom: 12 }}>
              <thead>
                <tr>
                  <th>Bank</th>
                  <th>Account</th>
                  <th>Last 4</th>
                  <th>Network</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {guestBankAccounts.map((a) => (
                  <tr key={a.id}>
                    <td>{a.bankName}</td>
                    <td>{a.accountName}</td>
                    <td>{a.accountNumberLast4}</td>
                    <td>{a.transferNetwork || '—'}</td>
                    <td className="t-c">{a.isDefault ? 'Default' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="row">
            <div>
              <label>Bank</label>
              <select
                value={newBankAccount.bankName}
                onChange={(e) => setNewBankAccount({ ...newBankAccount, bankName: e.target.value })}
              >
                <option value="">Select...</option>
                {BANK_NAMES.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label>Account holder</label>
              <input
                value={newBankAccount.accountName}
                onChange={(e) => setNewBankAccount({ ...newBankAccount, accountName: e.target.value })}
              />
            </div>
            <div>
              <label>Last 4 digits</label>
              <input
                value={newBankAccount.accountNumberLast4}
                maxLength={4}
                onChange={(e) =>
                  setNewBankAccount({ ...newBankAccount, accountNumberLast4: e.target.value.replace(/\D/g, '') })
                }
              />
            </div>
            <div>
              <label>Network</label>
              <select
                value={newBankAccount.transferNetwork}
                onChange={(e) => setNewBankAccount({ ...newBankAccount, transferNetwork: e.target.value })}
              >
                <option value="">Select...</option>
                {TRANSFER_NETWORKS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            {pickedGuest && (
              <div style={{ alignSelf: 'flex-end' }}>
                <button type="button" className="secondary small" disabled={savingBankAccount} onClick={addGuestBankAccount}>
                  + Add account
                </button>
              </div>
            )}
          </div>
          {!pickedGuest && (
            <p className="hint">
              Saved automatically for this guest once the reservation is created below.
            </p>
          )}
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
          ) : null}
          {pickedGuest && (
            <div style={{ marginBottom: 16 }}>
              {/* Editable right here, not just a preview — each toggle PUTs
                  straight to the guest's own profile (see
                  toggleGuestAddonPref), the same GuestPreference row
                  Guests.jsx edits. Checking one during a booking saves it for
                  every future stay too, not just this reservation. */}
              <label>Add-on preferences</label>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {addonCatalog.map((o) => (
                  <label
                    key={o.code}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      width: 'auto',
                      textTransform: 'none',
                      fontWeight: 400,
                    }}
                  >
                    <input
                      type="checkbox"
                      style={{ width: 'auto' }}
                      checked={Boolean(guestAddonPrefs[o.code])}
                      disabled={savingAddonPref === o.code}
                      onChange={(e) => toggleGuestAddonPref(o.code, e.target.checked)}
                    />
                    {o.label}
                    {o.priceCents > 0 && <span className="muted"> ({formatPeso(o.priceCents)})</span>}
                  </label>
                ))}
              </div>
            </div>
          )}
          {!pickedGuest && (
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

      {/* Step 4 — Payment */}
      {step === 4 && (
        <div className="panel">
          <h3>Payment</h3>

          <h3 style={{ marginTop: 0 }}>Total breakdown</h3>
          <table style={{ marginBottom: 18 }}>
            <tbody>
              <tr>
                <td>Room charges ({nights} night{nights === 1 ? '' : 's'})</td>
                <td className="t-n">{formatPeso(totals.subtotalCents)}</td>
              </tr>
              {checkedAddOns.map((o) => (
                <tr key={o.code}>
                  <td>{o.label}</td>
                  <td className="t-n">{formatPeso(o.priceCents)}</td>
                </tr>
              ))}
              <tr>
                <td>Taxes &amp; fees</td>
                <td className="t-n">{formatPeso(totals.taxCents)}</td>
              </tr>
              <tr>
                <td>
                  <strong>Grand total</strong>
                </td>
                <td className="t-n">
                  <strong>{formatPeso(totals.grandTotalCents)}</strong>
                </td>
              </tr>
            </tbody>
          </table>

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
              {guestBankAccounts.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <label>Use a saved bank account</label>
                  <select
                    defaultValue=""
                    onChange={(e) => {
                      const account = guestBankAccounts.find((a) => a.id === e.target.value);
                      if (account) applySavedBankAccount(account);
                    }}
                  >
                    <option value="">Type new details below…</option>
                    {guestBankAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.bankName} •••• {a.accountNumberLast4} — {a.accountName}
                        {a.isDefault ? ' (default)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}
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
      <div className="wizard-bottom" data-tour="g-reservation-new-bar">
        <div className="wizard-totals" data-tour="g-reservation-new-totals">
          <div className="wizard-total">
            <div className="label">Subtotal</div>
            <div className="value">{formatPeso(totals.subtotalCents)}</div>
          </div>
          {totals.addOnsCents > 0 && (
            <div className="wizard-total">
              <div className="label">Add-ons</div>
              <div className="value">{formatPeso(totals.addOnsCents)}</div>
            </div>
          )}
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
