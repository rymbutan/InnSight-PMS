import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../auth';
import { useToast, errMsg } from '../components/Toast';
import { formatPeso, pesosToCents } from '../lib/money';
import Icon from '../components/Icon';

const STEPS = ['Availability', 'Details', 'Guests', 'Add-ons', 'Payment'];
const SOURCES = ['DIRECT', 'WALK_IN', 'BOOKING_COM', 'AIRBNB', 'EXPEDIA', 'AGODA', 'OTA'];
const SOURCE_LABELS = {
  DIRECT: 'Direct',
  WALK_IN: 'Walk-in',
  BOOKING_COM: 'Booking.com',
  AIRBNB: 'Airbnb',
  EXPEDIA: 'Expedia',
  AGODA: 'Agoda',
  OTA: 'Other OTA',
};

export default function NewReservation() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { hasRole } = useAuth();
  const isAdmin = hasRole('ADMIN', 'MANAGER');
  const [step, setStep] = useState(1);

  // Step 1
  const [source, setSource] = useState('DIRECT');
  const [checkIn, setCheckIn] = useState(params.get('checkIn') || '');
  const [checkOut, setCheckOut] = useState('');
  const [promoCode, setPromoCode] = useState('');
  const [searched, setSearched] = useState(false);
  const [types, setTypes] = useState([]);
  const [allRooms, setAllRooms] = useState([]);

  // Selections
  const [picks, setPicks] = useState([]); // {typeCode, name, ratePerNightCents, qty, assignedRoomId?}

  // Step 3
  const [guestQ, setGuestQ] = useState('');
  const [guestResults, setGuestResults] = useState([]);
  const [pickedGuest, setPickedGuest] = useState(null);
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
  const [feePercent, setFeePercent] = useState(10);
  const [feeEditPesos, setFeeEditPesos] = useState('');

  useEffect(() => {
    api
      .get('/api/settings/addon-fee-percent')
      .then(({ data }) => setFeePercent(data.feePercent))
      .catch(() => {}); // default of 10 already set; a failed fetch just keeps it
  }, []);

  function addAddOn() {
    const costCents = pesosToCents(addOnCostPesos);
    if (!addOnDesc.trim() || !costCents) return;
    setAddOns((list) => [...list, { description: addOnDesc.trim(), costCents }]);
    setAddOnDesc('');
    setAddOnCostPesos('');
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
  const [paymentMethod, setPaymentMethod] = useState('Cash');
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
    const taxCents = Math.round(subtotalCents * 0.12); // 12% VAT placeholder
    const grandTotalCents = subtotalCents + taxCents + addOnsTotalCents;
    const suggestedDepositCents = Math.round(grandTotalCents * 0.5);
    return { subtotalCents, taxCents, grandTotalCents, suggestedDepositCents };
  }, [picks, nights, addOnsTotalCents]);

  const balanceDueCents = useMemo(() => {
    return Math.max(0, totals.grandTotalCents - pesosToCents(depositPesos));
  }, [totals, depositPesos]);

  function search() {
    if (!checkIn || !checkOut) return toast.error('Pick check-in and check-out dates first.');
    if (new Date(checkOut) <= new Date(checkIn)) return toast.error('Check-out must be after check-in.');
    setSearched(true);
  }

  // Step 3 — guest search
  useEffect(() => {
    if (!guestQ.trim()) {
      setGuestResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get(`/api/guests/search?q=${encodeURIComponent(guestQ)}`);
        setGuestResults(data || []);
      } catch {
        /* */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [guestQ]);

  function next() {
    if (step === 1 && picks.length === 0) return toast.error('Select at least one accommodation.');
    if (step === 3 && !pickedGuest && !newGuest.firstName)
      return toast.error('Pick a guest or enter a new one.');
    setStep(Math.min(STEPS.length, step + 1));
  }
  function back() {
    setStep(Math.max(1, step - 1));
  }

  async function submit() {
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
        adults: 2,
        children: 0,
        source,
        totalEstimateCents: totals.grandTotalCents,
        depositCents: pesosToCents(depositPesos),
        paymentType: paymentMethod,
        ratePlan: 'Base Rate',
        origin: SOURCE_LABELS[source],
        // No discount engine yet — record the promo code on the reservation so
        // staff can see and apply it, rather than silently dropping it.
        ...(promoCode ? { specialRequests: `Promo code: ${promoCode}` } : {}),
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
                          {allRooms
                            .filter((r) => r.typeCode === p.typeCode && r.status !== 'OUT_OF_ORDER')
                            .map((r) => (
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
                      <th>Max Occupancy</th>
                      <th>Available</th>
                      <th>Rate / night</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {types.map((t) => (
                      <tr key={t.code}>
                        <td>
                          <strong>{t.name}</strong> <span className="muted">({t.code})</span>
                        </td>
                        <td>{t.maxOccupancy}</td>
                        <td>{t.totalInventory}</td>
                        <td>{formatPeso(t.baseRate)}</td>
                        <td>
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
                <th>Quantity</th>
                <th>Room</th>
                <th>Nights</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {picks.map((p, i) => (
                <tr key={i}>
                  <td>{p.name}</td>
                  <td>{p.qty}</td>
                  <td>
                    {p.assignedRoomId
                      ? `Room ${allRooms.find((r) => r.id === p.assignedRoomId)?.number}`
                      : 'Auto'}
                  </td>
                  <td>{nights}</td>
                  <td>{formatPeso(p.ratePerNightCents * p.qty * nights)}</td>
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
              <input
                value={guestQ}
                onChange={(e) => setGuestQ(e.target.value)}
                placeholder="Search by name, email, phone…"
              />
              {guestResults.length > 0 && (
                <div
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    marginTop: 6,
                    maxHeight: 180,
                    overflowY: 'auto',
                  }}
                >
                  {guestResults.map((g) => (
                    <button
                      key={g.id}
                      className="actions-item"
                      style={{ width: '100%', textAlign: 'left' }}
                      onClick={() => setPickedGuest(g)}
                    >
                      <strong>{g.displayName}</strong> <span className="muted">— {g.email || '—'}</span>
                    </button>
                  ))}
                </div>
              )}
              <h3 style={{ marginTop: 22 }}>Or create new guest</h3>
              <div className="row">
                <div>
                  <label>First name *</label>
                  <input
                    value={newGuest.firstName}
                    onChange={(e) => setNewGuest({ ...newGuest, firstName: e.target.value })}
                  />
                </div>
                <div>
                  <label>Last name *</label>
                  <input
                    value={newGuest.lastName}
                    onChange={(e) => setNewGuest({ ...newGuest, lastName: e.target.value })}
                  />
                </div>
                <div>
                  <label>Email</label>
                  <input
                    type="email"
                    value={newGuest.email}
                    onChange={(e) => setNewGuest({ ...newGuest, email: e.target.value })}
                  />
                </div>
                <div>
                  <label>Phone</label>
                  <input
                    value={newGuest.phone}
                    onChange={(e) => setNewGuest({ ...newGuest, phone: e.target.value })}
                  />
                </div>
              </div>
              <h3>Guest address</h3>
              <div className="row">
                <div>
                  <label>Street</label>
                  <input
                    value={newGuest.streetAddress}
                    onChange={(e) => setNewGuest({ ...newGuest, streetAddress: e.target.value })}
                  />
                </div>
                <div>
                  <label>City</label>
                  <input
                    value={newGuest.city}
                    onChange={(e) => setNewGuest({ ...newGuest, city: e.target.value })}
                  />
                </div>
                <div>
                  <label>Country *</label>
                  <input
                    value={newGuest.country}
                    onChange={(e) => setNewGuest({ ...newGuest, country: e.target.value })}
                  />
                </div>
                <div>
                  <label>State/Region</label>
                  <input
                    value={newGuest.state}
                    onChange={(e) => setNewGuest({ ...newGuest, state: e.target.value })}
                  />
                </div>
                <div>
                  <label>Postal</label>
                  <input
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
            <div style={{ flex: 1 }}>
              <label>Special request</label>
              <input
                value={addOnDesc}
                placeholder="e.g. specific brand of cake"
                onChange={(e) => setAddOnDesc(e.target.value)}
              />
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
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button onClick={addAddOn} disabled={!addOnDesc.trim() || !pesosToCents(addOnCostPesos)}>
                Add
              </button>
            </div>
          </div>
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
              <label>Deposit amount (₱)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={depositPesos}
                onChange={(e) => setDepositPesos(e.target.value)}
                placeholder={(totals.suggestedDepositCents / 100).toFixed(2)}
              />
            </div>
            <div>
              <label>Payment method</label>
              <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
                <option>Cash</option>
                <option>Card</option>
                <option>Bank Transfer</option>
                <option>GCash</option>
                <option>Maya</option>
                <option>Other</option>
              </select>
            </div>
          </div>
          <div className="muted" style={{ marginTop: 12 }}>
            On confirm: reservation will be created &amp; auto-confirmed. Deposit (if &gt; 0) will post to the
            folio after check-in.
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
            onClick={() => {
              if (dirty && !confirm('You have unsaved changes. Discard?')) return;
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
