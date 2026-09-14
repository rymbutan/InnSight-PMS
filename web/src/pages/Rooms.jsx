import { useEffect, useMemo, useState } from 'react';
import api from '../api';
import { STATUS_ORDER as ROOM_STATUSES } from '../sim/statusMeta';
import { labelize } from '../lib/labels';
import { useAuth } from '../auth';
import { useToast, errMsg } from '../components/Toast';
import { useLiveRefresh, channels } from '../lib/useLiveEvents';
import { pesosToCents, centsToPesos, formatPeso } from '../lib/money';
import EmptyState from '../components/EmptyState';
import Icon from '../components/Icon';
import { useConfirm } from '../components/ConfirmDialog';

const STATUSES = ['CLEAN', 'CLEAN_INSPECTED', 'DIRTY', 'OCCUPIED', 'OUT_OF_ORDER', 'OUT_OF_SERVICE'];

export default function Rooms() {
  const { hasRole } = useAuth();
  const isAdmin = hasRole('ADMIN'); // property configuration is ADMIN-only
  // Promotions are commercial, not configuration — see the panel below.
  const canManagePromos = hasRole('ADMIN', 'MANAGER');
  const [rooms, setRooms] = useState([]);
  const [types, setTypes] = useState([]);
  const [newRoom, setNewRoom] = useState({ number: '', typeCode: '', floor: 1 });
  const [newType, setNewType] = useState({
    code: '',
    name: '',
    baseRate: '',
    maxOccupancy: 2,
    totalInventory: 0,
  });
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  // An empty filter means "all", so each clause short-circuits rather than
  // needing a sentinel value in the option list.
  const visibleRooms = useMemo(
    () =>
      rooms.filter(
        (r) => (!typeFilter || r.typeCode === typeFilter) && (!statusFilter || r.status === statusFilter)
      ),
    [rooms, typeFilter, statusFilter]
  );
  // How many rooms sit in each housekeeping state, in the syllabus' own order.
  // The aside's second slot shows EITHER the rates or the setup forms, never
  // both — `setupOpen` is which, `setupTab` is which form. Two booleans would
  // allow "open but no tab selected"; a string cannot express that.
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupTab, setSetupTab] = useState('room');

  const [priceEdit, setPriceEdit] = useState({}); // { [code]: pesosString }
  // The room type being fully edited, or null. One at a time — two open cards
  // in a 300px rail would leave neither readable.
  const [typeEdit, setTypeEdit] = useState(null);
  const [promos, setPromos] = useState([]);
  const [newPromo, setNewPromo] = useState({ code: '', percentOff: '', description: '' });
  const toast = useToast();
  const confirm = useConfirm();

  async function load() {
    try {
      const [r, t, p] = await Promise.all([
        api.get('/api/rooms'),
        api.get('/api/room-types'),
        api.get('/api/promo-codes').catch(() => ({ data: [] })),
      ]);
      setRooms(r.data);
      setTypes(t.data);
      setPromos(p.data);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  async function createPromo(e) {
    e.preventDefault();
    try {
      await api.post('/api/promo-codes', {
        code: newPromo.code,
        percentOff: Number(newPromo.percentOff),
        description: newPromo.description || undefined,
      });
      toast.success(`Promo ${newPromo.code.toUpperCase()} created.`);
      setNewPromo({ code: '', percentOff: '', description: '' });
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  async function togglePromo(code, active) {
    // Only deactivation asks. Turning a promo back on is harmless; turning it
    // off stops it working for every guest mid-booking.
    if (!active) {
      const ok = await confirm({
        title: 'Deactivate promo code',
        message: `Are you sure you want to deactivate ${code}?`,
        detail: 'Guests will no longer be able to apply this code. You can reactivate it later.',
        confirmLabel: 'Deactivate',
      });
      if (!ok) return;
    }
    try {
      await api.patch(`/api/promo-codes/${code}`, { active });
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  useEffect(() => {
    load();
  }, []);
  // Live scope — the room list with housekeeping status, plus out-of-service /
  // restored transitions from work orders.
  useLiveRefresh(load, { channels: channels('rooms', 'maintenance') });

  async function setStatus(id, status) {
    try {
      await api.patch(`/api/rooms/${id}/status`, { status });
      toast.success(`Room status set to ${status}.`);
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  async function createRoom(e) {
    e.preventDefault();
    try {
      await api.post('/api/rooms', newRoom);
      toast.success(`Room ${newRoom.number} added.`);
      setNewRoom({ number: '', typeCode: '', floor: 1 });
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  async function createType(e) {
    e.preventDefault();
    try {
      await api.post('/api/room-types', { ...newType, baseRate: pesosToCents(newType.baseRate) });
      toast.success(`Room type ${newType.code} created.`);
      setNewType({ code: '', name: '', baseRate: '', maxOccupancy: 2, totalInventory: 0 });
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  async function saveType() {
    const t = typeEdit;
    if (!t) return;
    // Only what changed. The endpoint rejects an empty body with "No editable
    // fields provided", and sending every field back would overwrite a value
    // someone else edited between this card opening and Save.
    const patch = {};
    const current = types.find((x) => x.code === t.code);
    if (t.name !== current?.name) patch.name = t.name;
    if (Number(t.maxOccupancy) !== current?.maxOccupancy) patch.maxOccupancy = Number(t.maxOccupancy);
    if (Number(t.totalInventory) !== current?.totalInventory) patch.totalInventory = Number(t.totalInventory);
    const cents = pesosToCents(t.baseRate);
    if (cents !== current?.baseRate) patch.baseRate = cents;
    if (!Object.keys(patch).length) {
      setTypeEdit(null);
      return;
    }
    try {
      await api.patch(`/api/room-types/${t.code}`, patch);
      toast.success(`${t.name} updated.`);
      setTypeEdit(null);
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  async function removeType(t) {
    const ok = await confirm({
      title: 'Delete room type',
      message: `Delete “${t.name}” (${t.code})?`,
      detail:
        'Only a type with no rooms and no live holds can be deleted — the server refuses otherwise and says why. This cannot be undone.',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await api.delete(`/api/room-types/${t.code}`);
      toast.success(`${t.name} deleted.`);
      if (typeEdit?.code === t.code) setTypeEdit(null);
      load();
    } catch (e) {
      // The 409 carries the reason — "3 rooms still use this type" — and that
      // is the whole answer, so it goes to the user verbatim.
      toast.error(errMsg(e));
    }
  }

  async function savePrice(code) {
    const pesos = priceEdit[code];
    if (pesos === undefined || pesos === '') return;
    try {
      await api.patch(`/api/room-types/${code}`, { baseRate: pesosToCents(pesos) });
      toast.success(`${code} price updated.`);
      setPriceEdit((p) => {
        const n = { ...p };
        delete n[code];
        return n;
      });
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  return (
    <div>
      <h2>{isAdmin ? 'Hotel Room Information Editor' : 'Hotel Rooms'}</h2>

      {/* The only non-admin who reaches this page now is a Manager — Front Desk
          and Housekeeping no longer have it at all — so the note says what a
          manager can actually do here, rather than the old line about updating
          housekeeping status, which was written for readers who can no longer
          open the page. */}
      {!isAdmin && (
        <p className="muted rooms-note">
          Room types &amp; pricing are managed by an administrator. You can create and manage promo codes
          here.
        </p>
      )}

      {/* Two columns: the room list is the work, everything else is reference
          or configuration. The list used to sit at the BOTTOM, under as many as
          three admin forms, so the one thing a housekeeper opens this page to do
          was the last thing on it. It leads now, and the aside carries what you
          consult rather than operate. Single column below 1100px. */}
      <div className="rooms-grid">
        <div className="rooms-main">
          <div className="panel">
            {/* Filters sit on the panel head, aligned right against the title —
            a full property runs to hundreds of rooms and the unfiltered list is
            unusable at that size. */}
            <div className="panel-head">
              <h3>Rooms</h3>
              <div className="filter-bar">
                <label className="filter-inline">
                  <span>Type</span>
                  <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                    <option value="">All types</option>
                    {types.map((t) => (
                      <option key={t.code} value={t.code}>
                        {t.code}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="filter-inline">
                  <span>Status</span>
                  <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                    <option value="">All statuses</option>
                    {ROOM_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="filter-count">
                  {visibleRooms.length} of {rooms.length}
                </span>
              </div>
            </div>
            {/* Only this scrolls. The board, the filters and the whole right
                rail stay put — see .rooms-fixed. */}
            <div className="rooms-table-scroll">
              {rooms.length === 0 ? (
                <EmptyState
                  kind="inbox"
                  title="No rooms yet"
                  hint={isAdmin ? 'Add a room type above, then add rooms to it.' : 'No rooms configured.'}
                />
              ) : visibleRooms.length === 0 ? (
                <EmptyState
                  kind="search"
                  title="No rooms match those filters"
                  hint="Clear the type or status filter to see more."
                />
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Room</th>
                      <th>Type</th>
                      <th className="t-c">Floor</th>
                      <th className="t-c">Status</th>
                      <th className="t-c">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRooms.map((r) => {
                      const dotCls = r.status === 'OUT_OF_ORDER' ? 'out' : r.status.toLowerCase();
                      return (
                        <tr key={r.id}>
                          <td>
                            <span className={`status-dot ${dotCls}`} />
                            {r.number}
                          </td>
                          <td>{r.typeCode}</td>
                          <td className="t-c">{r.floor}</td>
                          <td className="t-c">
                            <span className={`badge ${dotCls}`}>{r.status}</span>
                          </td>
                          <td className="t-c">
                            {/* `value` is set explicitly now: the option previously
                          had none, so its value was its TEXT — labelling the
                          options would have started submitting "Clean inspected"
                          instead of CLEAN_INSPECTED. */}
                            <select
                              className="table-select"
                              value={r.status}
                              onChange={(e) => setStatus(r.id, e.target.value)}
                            >
                              {STATUSES.map((s) => (
                                <option key={s} value={s}>
                                  {labelize(s)}
                                </option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

        <aside className="rooms-aside">
          {/* Promo codes leads the aside. It is a short list of short values, so
              it reads as cards rather than the five-column table it used to be —
              that table needed the full page width, which is why it used to live
              below the grid instead of here. */}
          {/* Manager too, not Admin only. A promotion is a commercial decision
              — the manager running the shoulder-season rate is the person who
              should be able to open and close it — and it is the one thing in
              this aside that is not property configuration. Mirrors the MGMT
              guard on POST/PATCH /api/promo-codes; gating it any tighter here
              would hide a form the API would have accepted. */}
          {canManagePromos && (
            <div className="panel">
              <h3>Promo codes</h3>
              <form onSubmit={createPromo}>
                {/* Code and % off share a line: the aside stacks a `.row` one
                    field per line, which is right for a full-width Description
                    but wasteful for a short code beside a three-digit number. */}
                <div className="row row-split">
                  <div>
                    <label>Code</label>
                    <input
                      required
                      value={newPromo.code}
                      onChange={(e) => setNewPromo({ ...newPromo, code: e.target.value.toUpperCase() })}
                    />
                  </div>
                  <div>
                    <label>% off</label>
                    <input
                      required
                      type="number"
                      min="1"
                      max="100"
                      value={newPromo.percentOff}
                      onChange={(e) => setNewPromo({ ...newPromo, percentOff: e.target.value })}
                    />
                  </div>
                </div>
                <div className="row">
                  <div>
                    <label>Description</label>
                    <input
                      value={newPromo.description}
                      onChange={(e) => setNewPromo({ ...newPromo, description: e.target.value })}
                    />
                  </div>
                  <div className="row-action">
                    <button>Add promo</button>
                  </div>
                </div>
              </form>
              {promos.length > 0 && (
                <div className="rt-list" style={{ marginTop: 12 }}>
                  {promos.map((p) => (
                    <div key={p.code} className="rt-item" style={{ opacity: p.active ? 1 : 0.55 }}>
                      <div className="rt-head">
                        <span className="rt-name">{p.code}</span>
                        <span className="rt-rate">{p.percentOff}% off</span>
                      </div>
                      <div className="rt-meta">{p.description || 'No description'}</div>
                      <div className="rt-edit">
                        <button
                          className={`small secondary${p.active ? '' : ' outline-success'}`}
                          onClick={() => togglePromo(p.code, !p.active)}
                        >
                          {p.active ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Setup REPLACES the types list rather than appearing beside it. The
              aside is one column: adding a room and reading the rates are two
              different jobs, and showing both at once is what made this column a
              stack of three panels in the first place. */}
          {setupOpen ? (
            <div className="panel">
              <div className="setup-head">
                <div className="seg" role="tablist" aria-label="Property setup">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={setupTab === 'room'}
                    className={setupTab === 'room' ? 'is-on' : ''}
                    onClick={() => setSetupTab('room')}
                  >
                    <Icon name="bed" size={13} strokeWidth={2} />
                    Add Room
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={setupTab === 'type'}
                    className={setupTab === 'type' ? 'is-on' : ''}
                    onClick={() => setSetupTab('type')}
                  >
                    <Icon name="building-2" size={13} strokeWidth={2} />
                    Create Room Type
                  </button>
                </div>
                {/* The + that opened this panel is inside the panel it replaced,
                    so without this there is no way back to the rates. */}
                <button
                  type="button"
                  className="small icon secondary"
                  onClick={() => setSetupOpen(false)}
                  aria-label="Close setup and show room types"
                  title="Done"
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
              {setupTab === 'room' ? (
                <form onSubmit={createRoom}>
                  <div className="row">
                    <div>
                      <label>Number</label>
                      <input
                        required
                        value={newRoom.number}
                        onChange={(e) => setNewRoom({ ...newRoom, number: e.target.value })}
                      />
                    </div>
                    <div>
                      <label>Type</label>
                      <select
                        required
                        value={newRoom.typeCode}
                        onChange={(e) => setNewRoom({ ...newRoom, typeCode: e.target.value })}
                      >
                        <option value="">—</option>
                        {types.map((t) => (
                          <option key={t.code} value={t.code}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label>Floor</label>
                      <input
                        type="number"
                        value={newRoom.floor}
                        onChange={(e) => setNewRoom({ ...newRoom, floor: Number(e.target.value) })}
                      />
                    </div>
                    <div className="row-action">
                      <button>Add</button>
                    </div>
                  </div>
                </form>
              ) : (
                <form onSubmit={createType}>
                  <div className="row">
                    <div>
                      <label>Code</label>
                      <input
                        required
                        value={newType.code}
                        onChange={(e) => setNewType({ ...newType, code: e.target.value })}
                      />
                    </div>
                    <div>
                      <label>Name</label>
                      <input
                        required
                        value={newType.name}
                        onChange={(e) => setNewType({ ...newType, name: e.target.value })}
                      />
                    </div>
                    <div>
                      <label>Base rate (₱)</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={newType.baseRate}
                        onChange={(e) => setNewType({ ...newType, baseRate: e.target.value })}
                      />
                    </div>
                    <div>
                      <label>Max occupancy</label>
                      <input
                        type="number"
                        value={newType.maxOccupancy}
                        onChange={(e) => setNewType({ ...newType, maxOccupancy: Number(e.target.value) })}
                      />
                    </div>
                    <div>
                      <label>Inventory</label>
                      <input
                        type="number"
                        value={newType.totalInventory}
                        onChange={(e) => setNewType({ ...newType, totalInventory: Number(e.target.value) })}
                      />
                    </div>
                    <div className="row-action">
                      <button>Create type</button>
                    </div>
                  </div>
                </form>
              )}
            </div>
          ) : (
            <div className="panel">
              <div className="panel-head">
                <h3>Room types &amp; rates</h3>
                {isAdmin && (
                  <button
                    type="button"
                    className="rt-add"
                    onClick={() => setSetupOpen(true)}
                    aria-label="Add a room or create a room type"
                    title="Add room / create room type"
                  >
                    <Icon name="plus" size={15} strokeWidth={2.6} />
                  </button>
                )}
              </div>
              {types.length === 0 ? (
                <EmptyState kind="inbox" title="No room types yet" />
              ) : (
                <div className="rt-list">
                  {types.map((t) =>
                    typeEdit?.code === t.code ? (
                      // Full edit, in place of the card. Everything the server
                      // will accept on a room type — name, occupancy, inventory
                      // and rate — rather than the rate alone, which was the
                      // only field the quick row could reach.
                      <form
                        key={t.code}
                        className="rt-item rt-item-editing"
                        onSubmit={(e) => {
                          e.preventDefault();
                          saveType();
                        }}
                      >
                        <label>Name</label>
                        <input
                          required
                          value={typeEdit.name}
                          onChange={(e) => setTypeEdit((s) => ({ ...s, name: e.target.value }))}
                        />
                        <div className="row row-split">
                          <div>
                            <label>Sleeps</label>
                            <input
                              type="number"
                              min="1"
                              value={typeEdit.maxOccupancy}
                              onChange={(e) => setTypeEdit((s) => ({ ...s, maxOccupancy: e.target.value }))}
                            />
                          </div>
                          <div>
                            <label>Rooms</label>
                            <input
                              type="number"
                              min="0"
                              value={typeEdit.totalInventory}
                              onChange={(e) => setTypeEdit((s) => ({ ...s, totalInventory: e.target.value }))}
                            />
                          </div>
                        </div>
                        <label>Rate per night</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={typeEdit.baseRate}
                          onChange={(e) => setTypeEdit((s) => ({ ...s, baseRate: e.target.value }))}
                        />
                        <div className="rt-edit">
                          <button className="small secondary outline-success" type="submit">
                            Save changes
                          </button>
                          <button type="button" className="small secondary" onClick={() => setTypeEdit(null)}>
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div key={t.code} className="rt-item">
                        <div className="rt-head">
                          <span className="rt-name">{t.name}</span>
                          <span className="rt-rate">{formatPeso(t.baseRate)}</span>
                        </div>
                        <div className="rt-meta">
                          {t.code} · sleeps {t.maxOccupancy} · {t.totalInventory} rooms · per night
                        </div>
                        {isAdmin && (
                          <div className="rt-edit">
                            {/* The quick rate box stays: changing a price is the
                                edit that happens weekly, and sending it through a
                                full form would be three clicks for one number. */}
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              aria-label={`New nightly rate for ${t.name}`}
                              placeholder={centsToPesos(t.baseRate).toFixed(2)}
                              value={priceEdit[t.code] ?? ''}
                              onChange={(e) => setPriceEdit((p) => ({ ...p, [t.code]: e.target.value }))}
                            />
                            <button
                              className="small secondary outline-success"
                              disabled={priceEdit[t.code] === undefined || priceEdit[t.code] === ''}
                              onClick={() => savePrice(t.code)}
                            >
                              Save
                            </button>
                            <button
                              className="small secondary"
                              onClick={() =>
                                setTypeEdit({
                                  code: t.code,
                                  name: t.name,
                                  maxOccupancy: t.maxOccupancy,
                                  totalInventory: t.totalInventory,
                                  baseRate: centsToPesos(t.baseRate).toFixed(2),
                                })
                              }
                              title={`Edit ${t.name}`}
                            >
                              Edit
                            </button>
                            {/* Trash icon and the solid danger fill, the same
                                treatment delete gets on the scenario cards —
                                it is the one action here that cannot be undone,
                                so it should not look like its neighbours. */}
                            <button
                              className="danger small"
                              onClick={() => removeType(t)}
                              title={`Delete ${t.name}`}
                              aria-label={`Delete ${t.name}`}
                            >
                              <Icon name="trash" size={13} strokeWidth={1.9} />
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
