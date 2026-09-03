import { useEffect, useMemo, useState } from 'react';
import api from '../api';
import { useAuth } from '../auth';
import { useToast, errMsg } from '../components/Toast';
import { useLiveRefresh, channels } from '../lib/useLiveEvents';
import { pesosToCents, centsToPesos, formatPeso } from '../lib/money';
import EmptyState from '../components/EmptyState';

const CATEGORIES = [
  'EVENT_HALL',
  'MEETING_ROOM',
  'GYM',
  'POOL',
  'RESTAURANT',
  'SPA',
  'PARKING',
  'LAUNDRY',
  'OTHER',
];
const MODELS = ['PER_USE', 'PER_HOUR', 'PER_PERSON', 'PER_DAY'];
const METHODS = ['CASH', 'CARD', 'GCASH', 'BANK'];

// Mirrors the server-side pricing (display only; server is authoritative).
function total(f, { units = 1, persons = 1, startAt, endAt } = {}) {
  const p = f.priceCents;
  if (f.pricingModel === 'PER_HOUR') {
    const h =
      startAt && endAt
        ? Math.max(1, Math.ceil((new Date(endAt) - new Date(startAt)) / 3600000))
        : Math.max(1, units);
    return p * h;
  }
  if (f.pricingModel === 'PER_DAY') {
    const d =
      startAt && endAt
        ? Math.max(1, Math.ceil((new Date(endAt) - new Date(startAt)) / 86400000))
        : Math.max(1, units);
    return p * d;
  }
  if (f.pricingModel === 'PER_PERSON') return p * Math.max(1, persons || units);
  return p * Math.max(1, units);
}
const blank = {
  code: '',
  name: '',
  category: 'OTHER',
  pricingModel: 'PER_USE',
  priceCents: '',
  unit: '',
  capacity: '',
  reservable: false,
  description: '',
};

export default function Amenities() {
  const { hasRole } = useAuth();
  const isAdmin = hasRole('ADMIN');
  const canSell = hasRole('ADMIN', 'MANAGER', 'FRONT_DESK');
  const toast = useToast();
  const [facilities, setFacilities] = useState([]);
  const [form, setForm] = useState(blank);
  const [edit, setEdit] = useState({}); // { [code]: pesos }
  const [sel, setSel] = useState(null); // selected facility code for POS
  const [pos, setPos] = useState({
    guestName: '',
    units: 1,
    persons: 1,
    startAt: '',
    endAt: '',
    method: 'CASH',
  });
  const today = new Date().toISOString().slice(0, 10);
  const [schedDate, setSchedDate] = useState(today);
  const [bookings, setBookings] = useState([]);

  // Laundry ticket — several garment lines charged as one folio line.
  const [laundryQty, setLaundryQty] = useState({}); // { [facilityCode]: qty }
  const [laundryGuest, setLaundryGuest] = useState('');
  const [laundryMethod, setLaundryMethod] = useState('CASH');

  async function load() {
    try {
      const { data } = await api.get('/api/facilities');
      setFacilities(data);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  async function loadBookings(d = schedDate) {
    try {
      const { data } = await api.get(`/api/facility-bookings?from=${d}T00:00:00&to=${d}T23:59:59`);
      setBookings(data);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    loadBookings();
  }, [schedDate]); // eslint-disable-line react-hooks/exhaustive-deps
  useLiveRefresh(
    () => {
      load();
      loadBookings();
    },
    { channels: channels('facilities') }
  );

  async function cancelBooking(id) {
    try {
      await api.patch(`/api/facility-bookings/${id}`, { status: 'CANCELLED' });
      toast.success('Booking cancelled.');
      loadBookings();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  const selected = useMemo(() => facilities.find((f) => f.code === sel) || null, [facilities, sel]);

  // Divisible spaces list under their parent, so the hall's sections read as
  // part of it rather than as three unrelated rooms.
  const orderedFacilities = useMemo(() => {
    const parents = facilities.filter((f) => !f.parentCode);
    const byParent = new Map();
    for (const f of facilities.filter((x) => x.parentCode)) {
      if (!byParent.has(f.parentCode)) byParent.set(f.parentCode, []);
      byParent.get(f.parentCode).push(f);
    }
    const ordered = parents.flatMap((p) => [p, ...(byParent.get(p.code) || [])]);
    // A child whose parent is filtered out (e.g. inactive) must still appear.
    const seen = new Set(ordered.map((f) => f.code));
    return [...ordered, ...facilities.filter((f) => !seen.has(f.code))];
  }, [facilities]);

  const laundryItems = useMemo(
    () => facilities.filter((f) => f.category === 'LAUNDRY' && f.active),
    [facilities]
  );
  const laundryLines = useMemo(
    () =>
      laundryItems
        .map((f) => ({ f, qty: Number(laundryQty[f.code] || 0) }))
        .filter((l) => Number.isInteger(l.qty) && l.qty > 0),
    [laundryItems, laundryQty]
  );
  const laundryTotalCents = useMemo(
    () => laundryLines.reduce((s, l) => s + l.f.priceCents * l.qty, 0),
    [laundryLines]
  );

  async function postLaundryTicket() {
    if (laundryLines.length === 0) return;
    try {
      const { data } = await api.post('/api/folios/laundry-sale', {
        items: laundryLines.map((l) => ({ facilityCode: l.f.code, qty: l.qty })),
        guestName: laundryGuest || undefined,
        method: laundryMethod,
      });
      toast.success(`Laundry ticket posted — ${formatPeso(data.totalCents)}.`);
      setLaundryQty({});
      setLaundryGuest('');
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  async function createFacility(e) {
    e.preventDefault();
    try {
      await api.post('/api/facilities', {
        ...form,
        priceCents: pesosToCents(form.priceCents),
        capacity: form.capacity === '' ? null : Number(form.capacity),
      });
      toast.success(`Amenity ${form.code} created.`);
      setForm(blank);
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  async function saveField(code, patch, label) {
    try {
      await api.patch(`/api/facilities/${code}`, patch);
      toast.success(`${code} ${label}.`);
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  async function savePrice(code) {
    const pesos = edit[code];
    if (pesos === undefined || pesos === '') return;
    await saveField(code, { priceCents: pesosToCents(pesos) }, 'price updated');
    setEdit((p) => {
      const n = { ...p };
      delete n[code];
      return n;
    });
  }

  async function sell() {
    if (!selected) return;
    try {
      const body = { facilityCode: selected.code, guestName: pos.guestName || undefined, method: pos.method };
      if (selected.pricingModel === 'PER_PERSON') body.persons = Number(pos.persons) || 1;
      else if (selected.reservable) {
        body.startAt = pos.startAt;
        body.endAt = pos.endAt;
      } else body.units = Number(pos.units) || 1;

      let bookingId;
      if (selected.reservable) {
        if (!pos.startAt || !pos.endAt)
          return toast.error('Pick start and end time for a reservable facility.');
        const { data: bk } = await api.post('/api/facility-bookings', {
          facilityCode: selected.code,
          guestName: pos.guestName || 'Walk-in',
          startAt: pos.startAt,
          endAt: pos.endAt,
          persons: Number(pos.persons) || 1,
        });
        bookingId = bk.id;
        body.facilityBookingId = bookingId;
      }
      const { data } = await api.post('/api/folios/amenity-sale', body);
      toast.success(
        `Sold ${data.facility} — ${formatPeso(Number(data.amountCents))} · folio ${data.folioNumber}`
      );
      setPos({ guestName: '', units: 1, persons: 1, startAt: '', endAt: '', method: 'CASH' });
      setSel(null);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  const preview = selected
    ? total(selected, {
        units: Number(pos.units),
        persons: Number(pos.persons),
        startAt: pos.startAt,
        endAt: pos.endAt,
      })
    : 0;

  return (
    <div>
      <h2>Amenities &amp; Facilities</h2>

      {/* Walk-in POS / booking */}
      {canSell && (
        <div className="panel">
          <h3>Visitor sale (non-hotel guest)</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Charge a visitor — someone using an amenity without staying at the hotel. No room assignment is
            needed; the sale is tracked on its own visitor folio.
          </p>
          <div className="row">
            <div>
              <label>Amenity</label>
              <select value={sel || ''} onChange={(e) => setSel(e.target.value || null)}>
                <option value="">— select —</option>
                {facilities
                  .filter((f) => f.active)
                  .map((f) => (
                    <option key={f.code} value={f.code}>
                      {f.name} · {formatPeso(f.priceCents)} {f.unit || ''}
                      {f.reservable ? ' · bookable' : ''}
                    </option>
                  ))}
              </select>
            </div>
            {selected && (
              <>
                <div>
                  <label>Visitor name (optional)</label>
                  <input
                    value={pos.guestName}
                    onChange={(e) => setPos({ ...pos, guestName: e.target.value })}
                  />
                </div>
                {selected.pricingModel === 'PER_PERSON' && (
                  <div>
                    <label>Persons</label>
                    <input
                      type="number"
                      min="1"
                      value={pos.persons}
                      onChange={(e) => setPos({ ...pos, persons: e.target.value })}
                    />
                  </div>
                )}
                {!selected.reservable && selected.pricingModel !== 'PER_PERSON' && (
                  <div>
                    <label>Quantity</label>
                    <input
                      type="number"
                      min="1"
                      value={pos.units}
                      onChange={(e) => setPos({ ...pos, units: e.target.value })}
                    />
                  </div>
                )}
                {selected.reservable && (
                  <>
                    <div>
                      <label>Start</label>
                      <input
                        type="datetime-local"
                        value={pos.startAt}
                        onChange={(e) => setPos({ ...pos, startAt: e.target.value })}
                      />
                    </div>
                    <div>
                      <label>End</label>
                      <input
                        type="datetime-local"
                        value={pos.endAt}
                        onChange={(e) => setPos({ ...pos, endAt: e.target.value })}
                      />
                    </div>
                    {selected.capacity && (
                      <div>
                        <label>Persons (max {selected.capacity})</label>
                        <input
                          type="number"
                          min="1"
                          max={selected.capacity}
                          value={pos.persons}
                          onChange={(e) => setPos({ ...pos, persons: e.target.value })}
                        />
                      </div>
                    )}
                  </>
                )}
                <div>
                  <label>Payment</label>
                  <select value={pos.method} onChange={(e) => setPos({ ...pos, method: e.target.value })}>
                    {METHODS.map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </div>
              </>
            )}
          </div>
          {selected && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 8 }}>
              <strong style={{ fontSize: 18 }}>Total: {formatPeso(preview)}</strong>
              <button className="btn-cta" onClick={sell}>
                {selected.reservable ? 'Book & charge' : 'Charge & print'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Laundry ticket — per-piece pricing, posted as one charge */}
      {canSell && laundryItems.length > 0 && (
        <div className="panel">
          <h3>Laundry ticket</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Priced per piece. Enter how many of each garment; the whole ticket posts as one charge.
          </p>
          <table>
            <thead>
              <tr>
                <th>Garment</th>
                <th>Price / piece</th>
                <th>Pieces</th>
                <th>Line total</th>
              </tr>
            </thead>
            <tbody>
              {laundryItems.map((f) => {
                const qty = Number(laundryQty[f.code] || 0);
                return (
                  <tr key={f.code}>
                    <td>{f.name.replace(/^Laundry\s*—\s*/, '')}</td>
                    <td>{formatPeso(f.priceCents)}</td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        style={{ width: 80 }}
                        value={laundryQty[f.code] ?? ''}
                        onChange={(e) => setLaundryQty((p) => ({ ...p, [f.code]: e.target.value }))}
                      />
                    </td>
                    <td>{qty > 0 ? formatPeso(f.priceCents * qty) : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
            <div>
              <label>Visitor name (optional)</label>
              <input value={laundryGuest} onChange={(e) => setLaundryGuest(e.target.value)} />
            </div>
            <div>
              <label>Payment method</label>
              <select value={laundryMethod} onChange={(e) => setLaundryMethod(e.target.value)}>
                {METHODS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1, textAlign: 'right', fontWeight: 600 }}>
              Ticket total: {formatPeso(laundryTotalCents)}
            </div>
            <div>
              <button onClick={postLaundryTicket} disabled={laundryLines.length === 0}>
                Post laundry ticket
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Daily bookings schedule (halls / meeting rooms) */}
      {canSell && (
        <div className="panel">
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0 }}>Facility bookings — daily schedule</h3>
            <input type="date" value={schedDate} onChange={(e) => setSchedDate(e.target.value)} />
          </div>
          {bookings.length === 0 ? (
            <EmptyState
              kind="inbox"
              title="No bookings for this date"
              hint="Reservable amenities (halls, meeting rooms) booked for this day appear here."
            />
          ) : (
            <table style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th>Facility</th>
                  <th>Time</th>
                  <th>Guest</th>
                  <th>Persons</th>
                  <th>Charge</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {bookings.map((b) => (
                  <tr key={b.id} style={{ opacity: b.status === 'CANCELLED' ? 0.5 : 1 }}>
                    <td>{b.facility?.name || b.facilityId}</td>
                    <td>
                      {new Date(b.startAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–
                      {new Date(b.endAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td>{b.guestName}</td>
                    <td>{b.persons}</td>
                    <td>
                      {formatPeso(b.priceCents)}
                      {b.folioId ? ' · paid' : ''}
                    </td>
                    <td>
                      <span className={`badge ${b.status === 'CANCELLED' ? 'out' : 'clean'}`}>
                        {b.status}
                      </span>
                    </td>
                    <td>
                      {b.status === 'CONFIRMED' && (
                        <button className="secondary" onClick={() => cancelBooking(b.id)}>
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Catalog */}
      <div className="panel">
        <h3>Amenity catalog</h3>
        {facilities.length === 0 ? (
          <EmptyState kind="inbox" title="No amenities yet" />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Category</th>
                <th>Pricing</th>
                <th>Price</th>
                <th>Bookable</th>
                <th>Active</th>
                {isAdmin && <th>Admin</th>}
              </tr>
            </thead>
            <tbody>
              {orderedFacilities.map((f) => (
                <tr key={f.code} style={{ opacity: f.active ? 1 : 0.5 }}>
                  <td>{f.code}</td>
                  <td style={{ paddingLeft: f.parentCode ? 28 : undefined }}>
                    {f.parentCode && <span className="muted">└ </span>}
                    {f.name}
                  </td>
                  <td>{f.category.replace('_', ' ')}</td>
                  <td>{f.pricingModel.replace('PER_', 'per ').toLowerCase()}</td>
                  <td>
                    {formatPeso(f.priceCents)} {f.unit || ''}
                  </td>
                  <td>{f.reservable ? '✓' : '—'}</td>
                  <td>{f.active ? '✓' : '✗'}</td>
                  {isAdmin && (
                    <td style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        style={{ width: 100 }}
                        placeholder={centsToPesos(f.priceCents).toFixed(2)}
                        value={edit[f.code] ?? ''}
                        onChange={(e) => setEdit((p) => ({ ...p, [f.code]: e.target.value }))}
                      />
                      <button
                        className="secondary"
                        disabled={edit[f.code] === undefined || edit[f.code] === ''}
                        onClick={() => savePrice(f.code)}
                      >
                        Save price
                      </button>
                      <button
                        className="secondary"
                        onClick={() =>
                          saveField(f.code, { active: !f.active }, f.active ? 'deactivated' : 'activated')
                        }
                      >
                        {f.active ? 'Deactivate' : 'Activate'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Admin: create new amenity */}
      {isAdmin && (
        <div className="panel">
          <h3>Add amenity</h3>
          <form onSubmit={createFacility}>
            <div className="row">
              <div>
                <label>Code</label>
                <input
                  required
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                />
              </div>
              <div>
                <label>Name</label>
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div>
                <label>Category</label>
                <select
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div>
                <label>Pricing model</label>
                <select
                  value={form.pricingModel}
                  onChange={(e) => setForm({ ...form, pricingModel: e.target.value })}
                >
                  {MODELS.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div>
                <label>Price (₱)</label>
                <input
                  required
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.priceCents}
                  onChange={(e) => setForm({ ...form, priceCents: e.target.value })}
                />
              </div>
              <div>
                <label>Unit label</label>
                <input
                  value={form.unit}
                  placeholder="e.g. day pass"
                  onChange={(e) => setForm({ ...form, unit: e.target.value })}
                />
              </div>
              <div>
                <label>Capacity</label>
                <input
                  type="number"
                  min="0"
                  value={form.capacity}
                  onChange={(e) => setForm({ ...form, capacity: e.target.value })}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={form.reservable}
                    onChange={(e) => setForm({ ...form, reservable: e.target.checked })}
                    style={{ width: 'auto' }}
                  />{' '}
                  Reservable (time-slot)
                </label>
              </div>
            </div>
            <button>Create amenity</button>
          </form>
        </div>
      )}
    </div>
  );
}
