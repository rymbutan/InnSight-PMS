import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { useToast, errMsg } from '../components/Toast';
import { pesosToCents } from '../lib/money';

export default function WalkIn() {
  const navigate = useNavigate();
  const toast = useToast();
  const [rooms, setRooms] = useState([]);
  const [inHouse, setInHouse] = useState([]);
  const [form, setForm] = useState({
    guestName: '',
    guestId: '',
    assignedRoomId: '',
    nights: 1,
    deposit: '',
  });

  useEffect(() => {
    Promise.all([api.get('/api/rooms'), api.get('/api/in-house')])
      .then(([r, h]) => {
        setRooms(r.data);
        setInHouse(h.data);
      })
      .catch((e) => toast.error(errMsg(e)));
  }, []);

  const occupied = new Set(inHouse.map((s) => s.assignedRoomId).filter(Boolean));
  const available = rooms.filter(
    (r) => ['CLEAN', 'CLEAN_INSPECTED'].includes(r.status) && !occupied.has(r.id)
  );

  async function submit(e) {
    e.preventDefault();
    const checkout = new Date();
    checkout.setDate(checkout.getDate() + Number(form.nights || 1));
    try {
      const { data } = await api.post('/api/walk-in', {
        guestName: form.guestName,
        guestId: form.guestId || undefined,
        assignedRoomId: form.assignedRoomId,
        expectedCheckOut: checkout.toISOString(),
        depositAmount: pesosToCents(form.deposit),
      });
      toast.success(`Walk-in checked in — stay ${data.id.slice(0, 8)}`);
      navigate('/arrivals');
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  return (
    <div>
      <h2>Walk-in check-in</h2>
      <div className="panel">
        <p className="muted">
          Unreserved guest walking up to the front desk. Checks them straight in as an in-house stay.
        </p>
        <form onSubmit={submit}>
          <div className="row">
            <div>
              <label>Guest name</label>
              <input
                required
                value={form.guestName}
                onChange={(e) => setForm({ ...form, guestName: e.target.value })}
              />
            </div>
            <div>
              <label>Guest id (optional, if existing)</label>
              <input value={form.guestId} onChange={(e) => setForm({ ...form, guestId: e.target.value })} />
            </div>
          </div>
          <div className="row">
            <div>
              <label>Assign room</label>
              <select
                required
                value={form.assignedRoomId}
                onChange={(e) => setForm({ ...form, assignedRoomId: e.target.value })}
              >
                <option value="">— Select —</option>
                {available.map((r) => (
                  <option key={r.id} value={r.id}>
                    Room {r.number} · {r.typeCode} · Floor {r.floor}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label>Nights</label>
              <input
                type="number"
                min="1"
                required
                value={form.nights}
                onChange={(e) => setForm({ ...form, nights: e.target.value })}
              />
            </div>
            <div>
              <label>Deposit (₱)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.deposit}
                onChange={(e) => setForm({ ...form, deposit: e.target.value })}
              />
            </div>
          </div>
          {available.length === 0 && <p className="error">No clean vacant rooms available.</p>}
          <button disabled={available.length === 0}>Check-in walk-in</button>
        </form>
      </div>
    </div>
  );
}
