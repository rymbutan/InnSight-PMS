import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { useToast, errMsg } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { pesosToCents, centsToPesos, formatPeso } from '../lib/money';
import Autocomplete from '../components/Autocomplete';
import Icon from '../components/Icon';
import { paymentMethodGroups } from '../lib/paymentMethods';
import { SPECIAL_REQUEST_QUICK_PICKS, BANK_NAMES, TRANSFER_NETWORKS } from '../lib/reservationOptions';
import { CARD_BRANDS, EMPTY_DEPOSIT_DETAIL, nowForDateTimeLocal, missingDepositField } from '../lib/depositDetail';
import { ADDON_PREFERENCE_CATEGORY, useAddOnCatalog } from '../lib/guestAddonPreferences';

// A walk-in is a booking too, just one that skips the future-dated hold and
// checks straight into a real room today — see NewReservation.jsx, which this
// wizard mirrors step for step (Rooms/Details/Guests/Payment collect the same
// detail its Availability/Details/Guests/Payment steps do) so the desk isn't
// missing anything just because the guest didn't call ahead. What's actually
// walk-in-specific stays confined to Step 1 (today's available rooms instead
// of a date-ranged search) and submit() (POST /api/walk-in, one real room,
// immediate IN_HOUSE status — never a future PENDING reservation).
const STEPS = ['Rooms', 'Details', 'Guests', 'Payment'];

export default function WalkIn() {
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [step, setStep] = useState(1);

  const [rooms, setRooms] = useState([]);
  const [inHouse, setInHouse] = useState([]);

  useEffect(() => {
    Promise.all([api.get('/api/rooms'), api.get('/api/in-house')])
      .then(([r, h]) => {
        setRooms(r.data);
        setInHouse(h.data);
      })
      .catch((e) => toast.error(errMsg(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const occupied = new Set(inHouse.map((s) => s.assignedRoomId).filter(Boolean));
  const available = rooms.filter(
    (r) => ['CLEAN', 'CLEAN_INSPECTED'].includes(r.status) && !occupied.has(r.id)
  );
  const availableSorted = [...available].sort(
    (a, b) => a.floor - b.floor || String(a.number).localeCompare(String(b.number), undefined, { numeric: true })
  );

  // Step 1 — Rooms. The "accommodation list": what's actually free right now,
  // grouped by type — same information NewReservation.jsx's Availability step
  // shows, just computed from CURRENT room status instead of a date-ranged
  // search, since a walk-in only ever needs "is a room free today".
  const roomTypes = useMemo(() => {
    const byType = new Map();
    for (const r of availableSorted) {
      if (!byType.has(r.typeCode)) {
        byType.set(r.typeCode, {
          typeCode: r.typeCode,
          name: r.roomType?.name || r.typeCode,
          ratePerNightCents: r.roomType?.baseRate || 0,
          count: 0,
        });
      }
      byType.get(r.typeCode).count += 1;
    }
    return [...byType.values()];
  }, [availableSorted]);

  const [pickedTypeCode, setPickedTypeCode] = useState('');
  const [assignedRoomId, setAssignedRoomId] = useState('');
  const [nightlyRate, setNightlyRate] = useState('');
  const [rateTouched, setRateTouched] = useState(false);

  // Rooms of the picked type only, once one is picked — narrows the specific-
  // room dropdown the same way NewReservation.jsx's per-pick room select does.
  const roomsOfPickedType = pickedTypeCode
    ? availableSorted.filter((r) => r.typeCode === pickedTypeCode)
    : availableSorted;

  function pickType(typeCode) {
    setPickedTypeCode(typeCode);
    setAssignedRoomId('');
    const t = roomTypes.find((x) => x.typeCode === typeCode);
    if (!rateTouched && t) setNightlyRate(centsToPesos(t.ratePerNightCents));
  }

  function pickRoom(roomId) {
    // '' is "Auto-assign" — preview the rate from whichever room the server
    // would pick first, since the desk still needs a number for the deposit
    // before submitting.
    const room = roomId ? roomsOfPickedType.find((r) => r.id === roomId) : roomsOfPickedType[0];
    setAssignedRoomId(roomId);
    if (!rateTouched && room?.roomType?.baseRate != null) {
      setNightlyRate(centsToPesos(room.roomType.baseRate));
    }
  }

  // The picker's onChange never fires if the desk just accepts the default —
  // without this the rate stayed blank until they touched something, even
  // though a valid preview (the first available room) is already known once
  // the room list loads.
  useEffect(() => {
    if (rateTouched || pickedTypeCode || assignedRoomId || nightlyRate) return;
    const first = availableSorted[0];
    if (first?.roomType?.baseRate != null) setNightlyRate(centsToPesos(first.roomType.baseRate));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms, inHouse]);

  const [nights, setNights] = useState(1);
  const [adults, setAdults] = useState(1);
  const [children, setChildren] = useState(0);

  const [specialRequests, setSpecialRequests] = useState('');
  const [otherSpecialRequest, setOtherSpecialRequest] = useState('');

  const [companyName, setCompanyName] = useState('');
  const [employeeName, setEmployeeName] = useState('');

  // A picked existing guest and the free-typed name are mutually exclusive —
  // deriving guestId/guestName from the SAME picked-guest object is what keeps
  // them from diverging (see NewReservation.jsx). Previously this was a raw
  // "guest id" text box a clerk had to already know a UUID to fill in, so a
  // returning guest's stay almost never actually linked to their guest record.
  const [pickedGuest, setPickedGuest] = useState(null);
  const [guestQ, setGuestQ] = useState('');
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

  useEffect(() => {
    setCompanyName(pickedGuest?.companyName || '');
    setEmployeeName(pickedGuest?.employeeName || '');
  }, [pickedGuest?.id]);

  // Saved bank-transfer details, and the guest's standing add-on preferences —
  // same guest-service data NewReservation.jsx's Guests/Details steps read
  // and write, so a walk-in guest's profile is never a second, drifting copy.
  const [guestBankAccounts, setGuestBankAccounts] = useState([]);
  useEffect(() => {
    if (!pickedGuest?.id) return setGuestBankAccounts([]);
    api
      .get(`/api/guests/${pickedGuest.id}/bank-accounts`)
      .then(({ data }) => setGuestBankAccounts(Array.isArray(data) ? data : []))
      .catch(() => setGuestBankAccounts([]));
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

  function applySavedBankAccount(account) {
    const bankKnown = BANK_NAMES.includes(account.bankName);
    const networkKnown = account.transferNetwork && TRANSFER_NETWORKS.includes(account.transferNetwork);
    setDepositDetail((d) => ({
      ...d,
      bankName: bankKnown ? account.bankName : 'OTHER',
      bankNameOther: bankKnown ? '' : account.bankName,
      transferNetwork: networkKnown ? account.transferNetwork : 'OTHER',
      transferNetworkOther: networkKnown ? '' : account.transferNetwork || '',
      senderName: account.accountName,
    }));
  }

  const addonCatalog = useAddOnCatalog();
  const [guestAddonPrefs, setGuestAddonPrefs] = useState({}); // { [code]: true }
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
  const checkedAddOns = useMemo(
    () => addonCatalog.filter((o) => guestAddonPrefs[o.code]),
    [addonCatalog, guestAddonPrefs]
  );

  // Defaults mirror DEFAULT_TAX_RATES in services/_shared/policies.js, so a
  // failed fetch still quotes the same figures the backend falls back to.
  const [taxRates, setTaxRates] = useState({ vat: 12, serviceCharge: 10, localTax: 0, realPropertyTax: 0 });
  useEffect(() => {
    api
      .get('/api/settings/tax-rates')
      .then(({ data }) => setTaxRates(data))
      .catch(() => {});
  }, []);

  const [depositPesos, setDepositPesos] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('CASH');
  const [depositDetail, setDepositDetail] = useState(EMPTY_DEPOSIT_DETAIL);

  // Track whether the desk has begun entering data; if so, warn before
  // navigating away (back-button or tab close).
  const dirty = Boolean(pickedTypeCode || pickedGuest || newGuest.firstName || depositPesos);
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

  const totals = useMemo(() => {
    const n = Math.max(1, Number(nights) || 1);
    const subtotalCents = pesosToCents(nightlyRate) * n;
    const addOnsCents = checkedAddOns.reduce((s, o) => s + (o.priceCents || 0), 0);
    const taxCents = Math.round(
      (subtotalCents *
        (taxRates.vat + taxRates.serviceCharge + taxRates.localTax + taxRates.realPropertyTax)) /
        100
    );
    const grandTotalCents = subtotalCents + addOnsCents + taxCents;
    const suggestedDepositCents = Math.round(grandTotalCents * 0.5);
    return { subtotalCents, addOnsCents, taxCents, grandTotalCents, suggestedDepositCents };
  }, [nightlyRate, nights, taxRates, checkedAddOns]);

  const balanceDueCents = useMemo(
    () => Math.max(0, totals.grandTotalCents - pesosToCents(depositPesos)),
    [totals, depositPesos]
  );

  function next() {
    if (step === 1 && availableSorted.length === 0) {
      return toast.error('No clean, vacant rooms are available right now.');
    }
    if (step === 3 && !pickedGuest) {
      const missing = ['firstName', 'lastName', 'email', 'phone', 'streetAddress', 'city', 'country', 'state', 'postal'].filter(
        (k) => !String(newGuest[k] || '').trim()
      );
      if (missing.length) return toast.error('Fill in all guest details, or search for an existing guest.');
    }
    setStep((s) => Math.min(4, s + 1));
  }
  function back() {
    setStep((s) => Math.max(1, s - 1));
  }

  async function submit() {
    if (!(pesosToCents(depositPesos) > 0)) {
      return toast.error('A deposit is required before a walk-in guest can check in.');
    }
    const missingDeposit = missingDepositField(paymentMethod, depositDetail);
    if (missingDeposit) return toast.error(missingDeposit);
    const typedName = `${newGuest.firstName} ${newGuest.lastName}`.trim();
    const guestName = pickedGuest?.displayName || typedName;
    if (!guestName) return toast.error('Guest name is required.');
    try {
      let guest = pickedGuest;
      if (!guest && typedName) {
        const { data } = await api.post('/api/guests', {
          ...newGuest,
          displayName: typedName,
          companyName: companyName.trim() || undefined,
          employeeName: employeeName.trim() || undefined,
        });
        guest = data;
      } else if (
        guest &&
        (companyName.trim() !== (guest.companyName || '') || employeeName.trim() !== (guest.employeeName || ''))
      ) {
        const { data } = await api.patch(`/api/guests/${guest.id}`, {
          companyName: companyName.trim(),
          employeeName: employeeName.trim(),
        });
        guest = data;
      }
      if (
        guest?.id &&
        newBankAccount.bankName.trim() &&
        newBankAccount.accountName.trim() &&
        /^\d{4}$/.test(newBankAccount.accountNumberLast4)
      ) {
        try {
          await api.post(`/api/guests/${guest.id}/bank-accounts`, {
            bankName: newBankAccount.bankName.trim(),
            accountName: newBankAccount.accountName.trim(),
            accountNumberLast4: newBankAccount.accountNumberLast4,
            transferNetwork: newBankAccount.transferNetwork.trim() || undefined,
            isDefault: guestBankAccounts.length === 0,
          });
        } catch (e) {
          toast.error(`Checked in, but the bank account could not be saved: ${errMsg(e)}`);
        }
      }

      const checkout = new Date();
      checkout.setDate(checkout.getDate() + Number(nights || 1));
      const payload = {
        guestName,
        guestId: guest?.id || undefined,
        // '' means "Auto-assign" — the server picks a room itself rather
        // than requiring the desk to scan the list for a free one.
        assignedRoomId: assignedRoomId || undefined,
        expectedCheckOut: checkout.toISOString(),
        depositAmount: pesosToCents(depositPesos),
        adults: Number(adults) || 1,
        children: Number(children) || 0,
        nightlyRateCents: pesosToCents(nightlyRate),
        addOns: checkedAddOns.map((o) => ({ description: o.label, costCents: o.priceCents })),
        paymentType: paymentMethod,
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
        ...(specialRequests.trim() ? { specialRequests: specialRequests.trim() } : {}),
      };
      const { data } = await api.post('/api/walk-in', payload);
      submittedRef.current = true; // disable beforeunload guard
      const assignedRoom = rooms.find((r) => r.id === data.assignedRoomId);
      toast.success(
        `Walk-in checked in — stay ${data.id.slice(0, 8)}` +
          (assignedRoom ? `, room ${assignedRoom.number}` : '')
      );
      navigate('/arrivals');
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  return (
    <div>
      <div className="page-head">
        <h1>Walk-in check-in</h1>
        <div className="wizard-steps" data-tour="g-walk-in-steps">
          {STEPS.map((s, i) => (
            <div key={s} className={`wizard-step ${step === i + 1 ? 'active' : step > i + 1 ? 'done' : ''}`}>
              <span className="num">{step > i + 1 ? <Icon name="check" size={12} /> : i + 1}</span> {s}
            </div>
          ))}
        </div>
      </div>

      {/* Step 1 — Rooms */}
      {step === 1 && (
        <div className="panel" data-tour="g-walk-in-intro">
          <p className="muted">
            Unreserved guest walking up to the front desk. Checks them straight in as an in-house stay — the room
            has to be free right now, not just on some future date.
          </p>
          <h3>Accommodation list</h3>
          {roomTypes.length === 0 ? (
            <p className="error">No clean vacant rooms are available right now.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Room Type</th>
                  <th className="t-c">Available now</th>
                  <th className="t-n">Rate / night</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {roomTypes.map((t) => (
                  <tr key={t.typeCode} style={pickedTypeCode === t.typeCode ? { background: 'var(--accent-soft)' } : undefined}>
                    <td>{t.name}</td>
                    <td className="t-c">{t.count}</td>
                    <td className="t-n">{formatPeso(t.ratePerNightCents)}</td>
                    <td className="t-c">
                      <button
                        type="button"
                        className={pickedTypeCode === t.typeCode ? 'small' : 'btn-primary small'}
                        onClick={() => pickType(t.typeCode)}
                      >
                        {pickedTypeCode === t.typeCode ? 'Selected' : 'Select'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3 style={{ marginTop: 18 }}>Assign room</h3>
          <div className="row" data-tour="g-walk-in-room">
            <div>
              <label>Room</label>
              <select value={assignedRoomId} onChange={(e) => pickRoom(e.target.value)}>
                <option value="">Auto-assign (first available room)</option>
                {roomsOfPickedType.map((r) => (
                  <option key={r.id} value={r.id}>
                    Room {r.number} · {r.typeCode} · Floor {r.floor}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label>Nightly rate (₱)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                required
                value={nightlyRate}
                onChange={(e) => {
                  setRateTouched(true);
                  setNightlyRate(e.target.value);
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Step 2 — Details */}
      {step === 2 && (
        <div className="panel">
          <h3>Stay details</h3>
          <div className="row">
            <div>
              <label>Nights</label>
              <input
                type="number"
                min="1"
                required
                value={nights}
                onChange={(e) => setNights(e.target.value)}
              />
            </div>
          </div>

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
            <p className="hint">Saved automatically for this guest once they're checked in below.</p>
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
              <input type="number" min="1" required value={adults} onChange={(e) => setAdults(e.target.value)} />
            </div>
            <div>
              <label>Children</label>
              <input type="number" min="0" value={children} onChange={(e) => setChildren(e.target.value)} />
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
              <span className="muted">{pickedGuest.email || pickedGuest.phone}</span>
              <button className="secondary small" style={{ marginLeft: 'auto' }} onClick={() => setPickedGuest(null)}>
                Change
              </button>
            </div>
          ) : null}
          {pickedGuest && (
            <div style={{ marginBottom: 16 }}>
              {/* Editable right here, not just a preview — each toggle PUTs
                  straight to the guest's own profile, the same GuestPreference
                  row Guests.jsx edits. Checking one here saves it for every
                  future stay too, not just this walk-in. */}
              <label>Add-on preferences</label>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {addonCatalog.map((o) => (
                  <label
                    key={o.code}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, width: 'auto', textTransform: 'none', fontWeight: 400 }}
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
              <Autocomplete
                value={guestQ}
                onChange={setGuestQ}
                placeholder="Search by name, email, phone…"
                endpoint={(term) => `/api/guests/search?q=${encodeURIComponent(term)}`}
                mapItem={(g) => ({ id: g.id, title: g.displayName, meta: g.email || g.phone || '' })}
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
                  <input required value={newGuest.city} onChange={(e) => setNewGuest({ ...newGuest, city: e.target.value })} />
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
                <td>
                  Room charges ({nights} night{Number(nights) === 1 ? '' : 's'})
                </td>
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
                      setDepositDetail({ ...depositDetail, cardLast4: e.target.value.replace(/\D/g, '').slice(0, 4) })
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
              <label style={{ marginTop: 10 }}>Transaction / Authorization code (optional)</label>
              <input
                placeholder="Gateway transaction ID or POS approval code — leave blank to simulate one"
                value={depositDetail.gatewayRef}
                onChange={(e) => setDepositDetail({ ...depositDetail, gatewayRef: e.target.value })}
              />
            </>
          )}

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
                  onChange={(e) => setDepositDetail({ ...depositDetail, transferNetworkOther: e.target.value })}
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
            A downpayment is required before a walk-in guest can check in. On confirm: the guest is checked in
            immediately as an in-house stay, and the deposit posts to the folio right away.
          </div>
        </div>
      )}

      {/* Sticky bottom bar */}
      <div className="wizard-bottom" data-tour="g-walk-in-bar">
        <div className="wizard-totals" data-tour="g-walk-in-totals">
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
              navigate('/arrivals');
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
              Check-in walk-in <Icon name="check" size={14} style={{ marginLeft: 4 }} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
