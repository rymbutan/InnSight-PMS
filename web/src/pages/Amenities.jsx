import { useEffect, useMemo, useState } from 'react';
import api from '../api';
import { useAuth } from '../auth';
import { useToast, errMsg } from '../components/Toast';
import { useLiveRefresh, channels } from '../lib/useLiveEvents';
import { pesosToCents, centsToPesos, formatPeso } from '../lib/money';
import EmptyState from '../components/EmptyState';
import { useConfirm } from '../components/ConfirmDialog';

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
  const confirm = useConfirm();
  const [facilities, setFacilities] = useState([]);
  const [catFilter, setCatFilter] = useState('');
  const [activeFilter, setActiveFilter] = useState('');
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
    const ok = await confirm({
      title: 'Cancel booking',
      message: 'Are you sure you want to cancel this booking?',
      detail: 'The slot is released for others. A cancelled booking cannot be un-cancelled.',
      confirmLabel: 'Cancel booking',
      cancelLabel: 'Keep booking',
    });
    if (!ok) return;
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

  // Derived from the data, not a hardcoded list, so a category added on the
  // server appears here without a frontend change.
  const catalogCategories = useMemo(
    () => [...new Set(facilities.map((f) => f.category).filter(Boolean))].sort(),
    [facilities]
  );

  const visibleFacilities = useMemo(
    () =>
      orderedFacilities.filter((f) => {
        if (catFilter && f.category !== catFilter) return false;
        if (activeFilter === 'active' && !f.active) return false;
        if (activeFilter === 'inactive' && f.active) return false;
        return true;
      }),
    [orderedFacilities, catFilter, activeFilter]
  );

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
  // Deactivating asks; activating does not. Turning an amenity off pulls it out
  // of the booking screens for everyone, which is the half worth pausing on.
  async function toggleFacility(f) {
    if (f.active) {
      const ok = await confirm({
        title: 'Deactivate amenity',
        message: `Are you sure you want to deactivate ${f.name || f.code}?`,
        detail:
          'It disappears from the sales and booking screens. Existing bookings are unaffected, and you can reactivate it later.',
        confirmLabel: 'Deactivate',
      });
      if (!ok) return;
    }
    saveField(f.code, { active: !f.active }, f.active ? 'deactivated' : 'activated');
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
                <th className="t-n">Price / piece</th>
                <th className="t-c">Pieces</th>
                <th className="t-n">Line total</th>
              </tr>
            </thead>
            <tbody>
              {laundryItems.map((f) => {
                const qty = Number(laundryQty[f.code] || 0);
                return (
                  <tr key={f.code}>
                    <td>{f.name.replace(/^Laundry\s*—\s*/, '')}</td>
                    <td className="t-n">{formatPeso(f.priceCents)}</td>
                    <td className="t-c">
                      <input
                        type="number"
                        min="0"
                        step="1"
                        style={{ width: 80 }}
                        value={laundryQty[f.code] ?? ''}
                        onChange={(e) => setLaundryQty((p) => ({ ...p, [f.code]: e.target.value }))}
                      />
                    </td>
                    <td className="t-n">
                      {qty > 0 ? formatPeso(f.priceCents * qty) : <span className="muted">—</span>}
                    </td>
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
                  <th className="t-c">Persons</th>
                  <th className="t-n">Charge</th>
                  <th className="t-c">Status</th>
                  <th className="t-c">Actions</th>
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
                    <td className="t-c">{b.persons}</td>
                    <td className="t-n">
                      {formatPeso(b.priceCents)}
                      {b.folioId ? ' · paid' : ''}
                    </td>
                    <td className="t-c">
                      <span className={`badge ${b.status === 'CANCELLED' ? 'out' : 'clean'}`}>
                        {b.status}
                      </span>
                    </td>
                    <td className="t-actions">
                      {b.status === 'CONFIRMED' && (
                        <button className="small secondary" onClick={() => cancelBooking(b.id)}>
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
        <div className="panel-head">
          <h3>Amenity catalog</h3>
          <div className="filter-bar">
            <label className="filter-inline">
              <span>Category</span>
              <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
                <option value="">All categories</option>
                {catalogCategories.map((c) => (
                  <option key={c} value={c}>
                    {c.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-inline">
              <span>Show</span>
              <select value={activeFilter} onChange={(e) => setActiveFilter(e.target.value)}>
                <option value="">All</option>
                <option value="active">Active only</option>
                <option value="inactive">Inactive only</option>
              </select>
            </label>
            <span className="filter-count">
              {visibleFacilities.length} of {orderedFacilities.length}
            </span>
          </div>
        </div>
        {facilities.length === 0 ? (
          <EmptyState kind="inbox" title="No amenities yet" />
        ) : visibleFacilities.length === 0 ? (
          <EmptyState
            kind="search"
            title="No amenities match those filters"
            hint="Clear the category or status filter to see more."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Category</th>
                <th>Pricing</th>
                <th className="t-n">Price</th>
                <th className="t-c">Bookable</th>
                <th className="t-c">Active</th>
                {isAdmin && <th className="t-c">Admin</th>}
              </tr>
            </thead>
            <tbody>
              {visibleFacilities.map((f) => (
                <tr key={f.code} style={{ opacity: f.active ? 1 : 0.5 }}>
                  <td>{f.code}</td>
                  <td style={{ paddingLeft: f.parentCode ? 28 : undefined }}>
                    {f.parentCode && <span className="muted">└ </span>}
                    {f.name}
                  </td>
                  <td>{f.category.replace('_', ' ')}</td>
                  <td>{f.pricingModel.replace('PER_', 'per ').toLowerCase()}</td>
                  <td className="t-n">
                    {formatPeso(f.priceCents)} {f.unit || ''}
                  </td>
                  <td className="t-c">{f.reservable ? '✓' : '—'}</td>
                  <td className="t-c">{f.active ? '✓' : '✗'}</td>
                  {isAdmin && (
                    // The group is an inline-flex span INSIDE the cell, not a
                    // flex `td`: `display:flex` on a table cell drops it out of
                    // the table's own layout, so that column no longer shared
                    // the row height or the column width with anything else.
                    <td className="t-c">
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          style={{ width: 100 }}
                          placeholder={centsToPesos(f.priceCents).toFixed(2)}
                          value={edit[f.code] ?? ''}
                          onChange={(e) => setEdit((p) => ({ ...p, [f.code]: e.target.value }))}
                        />
                        {/* `small secondary`, matching every other in-table action
                            in the app (Users, Rooms). Full-size buttons stood a
                            third taller than the rows they sat in. */}
                        <button
                          className="small secondary"
                          disabled={edit[f.code] === undefined || edit[f.code] === ''}
                          onClick={() => savePrice(f.code)}
                        >
                          Save Price
                        </button>
                        <button
                          className={`small ${f.active ? 'danger' : 'secondary'}`}
                          onClick={() => toggleFacility(f)}
                        >
                          {f.active ? 'Deactivate' : 'Activate'}
                        </button>
                      </span>
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
              {/* `ed-check` gives this the same small box and inline label as
                  the editor's toggles, instead of a 36px square from the global
                  input rule with its caption wrapping beside it. */}
              <div className="row-action">
                <label className="ed-check">
                  <input
                    type="checkbox"
                    checked={form.reservable}
                    onChange={(e) => setForm({ ...form, reservable: e.target.checked })}
                  />
                  <span>Reservable (time-slot)</span>
                </label>
              </div>
              {/* The action is the last cell of the field row, level with the
                  inputs rather than a block underneath them. */}
              <div className="row-action">
                <button>Create amenity</button>
              </div>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
