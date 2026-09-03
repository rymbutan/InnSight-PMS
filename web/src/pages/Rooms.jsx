import { useEffect, useState } from 'react';
import api from '../api';
import { useAuth } from '../auth';
import { useToast, errMsg } from '../components/Toast';
import { useLiveRefresh, channels } from '../lib/useLiveEvents';
import { pesosToCents, centsToPesos, formatPeso } from '../lib/money';
import EmptyState from '../components/EmptyState';

const STATUSES = ['CLEAN', 'CLEAN_INSPECTED', 'DIRTY', 'OCCUPIED', 'OUT_OF_ORDER', 'OUT_OF_SERVICE'];

export default function Rooms() {
  const { hasRole } = useAuth();
  const isAdmin = hasRole('ADMIN'); // property configuration is ADMIN-only
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
  const [priceEdit, setPriceEdit] = useState({}); // { [code]: pesosString }
  const [promos, setPromos] = useState([]);
  const [newPromo, setNewPromo] = useState({ code: '', percentOff: '', description: '' });
  const toast = useToast();

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
      <h2>Rooms &amp; Housekeeping</h2>

      {!isAdmin && (
        <p className="muted" style={{ marginTop: 0 }}>
          Room types &amp; pricing are managed by an administrator. You can update housekeeping status below.
        </p>
      )}

      {/* Room types + pricing — read-only for staff, editable for ADMIN */}
      <div className="panel">
        <h3>Room types &amp; rates</h3>
        {types.length === 0 ? (
          <EmptyState kind="inbox" title="No room types yet" />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Max occ.</th>
                <th>Inventory</th>
                <th>Rate / night</th>
                {isAdmin && <th>Edit price</th>}
              </tr>
            </thead>
            <tbody>
              {types.map((t) => (
                <tr key={t.code}>
                  <td>{t.code}</td>
                  <td>{t.name}</td>
                  <td>{t.maxOccupancy}</td>
                  <td>{t.totalInventory}</td>
                  <td>{formatPeso(t.baseRate)}</td>
                  {isAdmin && (
                    <td style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        style={{ width: 110 }}
                        placeholder={centsToPesos(t.baseRate).toFixed(2)}
                        value={priceEdit[t.code] ?? ''}
                        onChange={(e) => setPriceEdit((p) => ({ ...p, [t.code]: e.target.value }))}
                      />
                      <button
                        className="secondary"
                        disabled={priceEdit[t.code] === undefined || priceEdit[t.code] === ''}
                        onClick={() => savePrice(t.code)}
                      >
                        Save
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {isAdmin && (
        <>
          <div className="panel">
            <h3>Create room type</h3>
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
              </div>
              <button>Create type</button>
            </form>
          </div>

          <div className="panel">
            <h3>Add room</h3>
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
              </div>
              <button>Add</button>
            </form>
          </div>

          <div className="panel">
            <h3>Promo codes</h3>
            <form onSubmit={createPromo}>
              <div className="row">
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
                <div>
                  <label>Description</label>
                  <input
                    value={newPromo.description}
                    onChange={(e) => setNewPromo({ ...newPromo, description: e.target.value })}
                  />
                </div>
              </div>
              <button>Add promo</button>
            </form>
            {promos.length > 0 && (
              <table style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>% off</th>
                    <th>Description</th>
                    <th>Active</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {promos.map((p) => (
                    <tr key={p.code} style={{ opacity: p.active ? 1 : 0.5 }}>
                      <td>{p.code}</td>
                      <td>{p.percentOff}%</td>
                      <td>{p.description || '—'}</td>
                      <td>{p.active ? '✓' : '✗'}</td>
                      <td>
                        <button className="secondary" onClick={() => togglePromo(p.code, !p.active)}>
                          {p.active ? 'Deactivate' : 'Activate'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      <div className="panel">
        <h3>Rooms</h3>
        {rooms.length === 0 ? (
          <EmptyState
            kind="inbox"
            title="No rooms yet"
            hint={isAdmin ? 'Add a room type above, then add rooms to it.' : 'No rooms configured.'}
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Room</th>
                <th>Type</th>
                <th>Floor</th>
                <th>Status</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {rooms.map((r) => {
                const dotCls = r.status === 'OUT_OF_ORDER' ? 'out' : r.status.toLowerCase();
                return (
                  <tr key={r.id}>
                    <td>
                      <span className={`status-dot ${dotCls}`} />
                      {r.number}
                    </td>
                    <td>{r.typeCode}</td>
                    <td>{r.floor}</td>
                    <td>
                      <span className={`badge ${dotCls}`}>{r.status}</span>
                    </td>
                    <td>
                      <select value={r.status} onChange={(e) => setStatus(r.id, e.target.value)}>
                        {STATUSES.map((s) => (
                          <option key={s}>{s}</option>
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
  );
}
