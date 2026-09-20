import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { useToast, errMsg } from '../components/Toast';
import { pesosToCents, centsToPesos } from '../lib/money';
import Autocomplete from '../components/Autocomplete';

export default function WalkIn() {
  const navigate = useNavigate();
  const toast = useToast();
  const [rooms, setRooms] = useState([]);
  const [inHouse, setInHouse] = useState([]);
  // A picked existing guest and the free-typed name are mutually exclusive —
  // deriving guestId/guestName from the SAME picked-guest object (the pattern
  // NewReservation.jsx uses) is what keeps them from diverging. Previously
  // this was a raw "guest id" text box a clerk had to already know a UUID to
  // fill in, so a returning guest's stay almost never actually linked to
  // their guest record — only the typed name was saved.
  const [pickedGuest, setPickedGuest] = useState(null);
  const [guestQ, setGuestQ] = useState('');
  const [form, setForm] = useState({
    assignedRoomId: '',
    nights: 1,
    adults: 1,
    children: 0,
    deposit: '',
    // Seeded from the room's base rate once one is picked (below); editable
    // for a negotiated walk-in rate. Without a rate travelling with the
    // check-in, the folio had a deposit PAYMENT and nothing to charge it
    // against — see stay.routes.js's POST /api/walk-in for the other half.
    nightlyRate: '',
  });
  // Whether the desk has touched the rate field themselves — once they have,
  // picking a different room must not clobber their override.
  const [rateTouched, setRateTouched] = useState(false);

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

  function pickRoom(roomId) {
    const room = available.find((r) => r.id === roomId);
    setForm((f) => ({
      ...f,
      assignedRoomId: roomId,
      nightlyRate: !rateTouched && room?.roomType?.baseRate != null ? centsToPesos(room.roomType.baseRate) : f.nightlyRate,
    }));
  }

  async function submit(e) {
    e.preventDefault();
    const guestName = pickedGuest?.displayName || guestQ.trim();
    if (!guestName) return toast.error('Guest name is required.');
    const checkout = new Date();
    checkout.setDate(checkout.getDate() + Number(form.nights || 1));
    try {
      const { data } = await api.post('/api/walk-in', {
        guestName,
        guestId: pickedGuest?.id || undefined,
        assignedRoomId: form.assignedRoomId,
        expectedCheckOut: checkout.toISOString(),
        depositAmount: pesosToCents(form.deposit),
        adults: Number(form.adults) || 1,
        children: Number(form.children) || 0,
        nightlyRateCents: pesosToCents(form.nightlyRate),
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
              <label>Guest</label>
              {pickedGuest ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '8px 12px',
                    background: 'var(--accent-soft)',
                    borderRadius: 8,
                  }}
                >
                  <strong>{pickedGuest.displayName}</strong>
                  <span className="muted">{pickedGuest.email || pickedGuest.phone}</span>
                  <button
                    type="button"
                    className="secondary small"
                    style={{ marginLeft: 'auto' }}
                    onClick={() => {
                      setPickedGuest(null);
                      setGuestQ('');
                    }}
                  >
                    Change
                  </button>
                </div>
              ) : (
                <Autocomplete
                  value={guestQ}
                  onChange={setGuestQ}
                  placeholder="Search an existing guest, or type a new guest's name"
                  endpoint={(term) => `/api/guests/search?q=${encodeURIComponent(term)}`}
                  mapItem={(g) => ({ id: g.id, title: g.displayName, meta: g.email || g.phone || '' })}
                  onPick={(g) => setPickedGuest(g)}
                />
              )}
            </div>
          </div>
          <div className="row">
            <div>
              <label>Assign room</label>
              <select
                required
                value={form.assignedRoomId}
                onChange={(e) => pickRoom(e.target.value)}
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
              <label>Nightly rate (₱)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                required
                value={form.nightlyRate}
                onChange={(e) => {
                  setRateTouched(true);
                  setForm({ ...form, nightlyRate: e.target.value });
                }}
              />
            </div>
          </div>
          <div className="row">
            <div>
              <label>Adults</label>
              <input
                type="number"
                min="1"
                required
                value={form.adults}
                onChange={(e) => setForm({ ...form, adults: e.target.value })}
              />
            </div>
            <div>
              <label>Children</label>
              <input
                type="number"
                min="0"
                value={form.children}
                onChange={(e) => setForm({ ...form, children: e.target.value })}
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
