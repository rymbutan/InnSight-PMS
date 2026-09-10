import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import Modal from '../components/Modal';
import { useToast, errMsg } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { useAuth } from '../auth';
import { pesosToCents } from '../lib/money';
import { localDay } from '../lib/date';
import { useLiveRefresh, channels } from '../lib/useLiveEvents';
import { downloadAuthed } from '../lib/download';
import Avatar from '../components/Avatar';
import EmptyState from '../components/EmptyState';
import StatusPill from '../components/StatusPill';

export default function Arrivals() {
  const navigate = useNavigate();
  const toast = useToast();
  const { hasRole } = useAuth();
  const canDelete = hasRole('ADMIN', 'MANAGER');
  const confirm = useConfirm();
  const [arrivals, setArrivals] = useState([]);
  const [inHouse, setInHouse] = useState([]);
  const [departures, setDepartures] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [loading, setLoading] = useState(true);

  const [checkInModal, setCheckInModal] = useState({ open: false, stay: null, roomId: '' });
  const [earlyModal, setEarlyModal] = useState({ open: false, stayId: '', unusedNights: 1, nightlyRate: '' });

  // Which arrival window the desk is looking at. Server-resolved, so the client
  // never does date arithmetic on UTC-midnight reservation values.
  const [range, setRange] = useState('today');
  const [degraded, setDegraded] = useState(false);

  // `live` marks an SSE-triggered reload. Refresh in place rather than showing
  // the skeleton, so the list does not blank on every event from any module.
  async function load({ live = false } = {}) {
    if (!live) setLoading(true);
    try {
      const [a, h, d, r] = await Promise.all([
        api.get(`/api/arrivals?range=${encodeURIComponent(range)}`),
        api.get('/api/in-house'),
        api.get('/api/departures'),
        api.get('/api/rooms'),
      ]);
      // /api/arrivals returns { range, degraded, arrivals } — it used to return
      // a bare array. Tolerate both so a stale cached bundle cannot blank the
      // list during a rolling deploy.
      setArrivals(Array.isArray(a.data) ? a.data : a.data.arrivals || []);
      setDegraded(Array.isArray(a.data) ? false : Boolean(a.data.degraded));
      setInHouse(h.data);
      setDepartures(d.data);
      setRooms(r.data);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);
  // Live: keep the front-desk arrivals/in-house/departures lists current.
  // Live scope — today's expected arrivals (reservation state) and who has actually
  // checked in or been marked no-show (stay state).
  useLiveRefresh(load, { channels: channels('reservations', 'stays') });

  // Rooms available for check-in: guest-ready (clean or inspected-clean) and not
  // currently occupied by another in-house stay.
  const occupiedRoomIds = new Set(inHouse.map((s) => s.assignedRoomId).filter(Boolean));
  const availableRooms = rooms.filter(
    (r) => ['CLEAN', 'CLEAN_INSPECTED'].includes(r.status) && !occupiedRoomIds.has(r.id)
  );

  // Admin/Manager only — server-enforced (services/reservation's
  // requireRole('ADMIN', 'MANAGER') on DELETE); the button itself is also
  // gated by canDelete so a lower-tier role never sees it at all. Refused by
  // the server once a real stay exists against the reservation (an arrival
  // row is always pre-check-in, so that guard essentially never fires here —
  // it exists for the departures row below, where a guest may already be
  // in-house).
  async function deleteReservation(reservationId, label) {
    if (!reservationId) return;
    const ok = await confirm({
      title: 'Delete reservation',
      message: `Permanently delete the reservation for ${label || 'this guest'}?`,
      detail: 'This cannot be undone.',
      confirmLabel: 'Delete permanently',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/api/reservations/${reservationId}`);
      toast.success('Reservation deleted.');
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  async function submitCheckIn(e) {
    e.preventDefault();
    const { stay, roomId } = checkInModal;
    if (!roomId) {
      toast.error('Select a room.');
      return;
    }
    // Week and Month show guests who are not due today. Early check-in is a real
    // and common thing to do, so this asks rather than refuses — but it names
    // the date, so it is a deliberate act rather than a misclick on the wrong row.
    const due = stay.expectedCheckIn ? new Date(stay.expectedCheckIn) : null;
    // localDay(), not toISOString().slice(0,10): the latter converts to UTC
    // first, so in Asia/Manila (UTC+8) it silently returns yesterday for the
    // first ~8 hours of every local day. See lib/date.js.
    const todayKey = localDay(new Date());
    if (due && due.toISOString().slice(0, 10) > todayKey) {
      const ok = await confirm({
        title: 'Early check-in',
        message: `${stay.guestName || 'This guest'} is not due until ${due.toLocaleDateString([], {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })}.`,
        detail: 'Checking them in now starts the stay today.',
        confirmLabel: 'Check in anyway',
      });
      if (!ok) return;
    }
    try {
      // reservationId/guestId/guestName are all a reservation carries, and
      // POST /api/check-in creates the Stay row when none exists — which is why
      // a guest with no stay row can be checked in from here with no backend
      // change at all.
      await api.post('/api/check-in', {
        reservationId: stay.reservationId,
        guestId: stay.guestId,
        guestName: stay.guestName,
        assignedRoomId: roomId,
      });
      toast.success(`${stay.guestName} checked in.`);
      setCheckInModal({ open: false, stay: null, roomId: '' });
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  async function checkOut(stayId, guestName) {
    const ok = await confirm({
      title: 'Check out guest',
      message: `Check out ${guestName}?`,
      confirmLabel: 'Check out',
      danger: false,
    });
    if (!ok) return;
    try {
      await api.post(`/api/check-out/${stayId}`);
      toast.success('Checked out.');
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  async function submitEarly(e) {
    e.preventDefault();
    const { stayId, unusedNights, nightlyRate } = earlyModal;
    try {
      await api.post(`/api/stays/${stayId}/early-departure`, {
        unusedNights: Number(unusedNights),
        nightlyRateCents: pesosToCents(nightlyRate),
      });
      toast.success('Early departure processed.');
      setEarlyModal({ open: false, stayId: '', unusedNights: 1, nightlyRate: '' });
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  // Was window.open, which sends no Authorization header — see lib/download.js.
  async function regCard(stayId) {
    try {
      await downloadAuthed(`/api/stays/${stayId}/registration-card`, {
        filename: `registration-card-${stayId}.pdf`,
      });
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  async function openFolio(stay) {
    try {
      let folioId = stay.folioId;
      if (!folioId) {
        const { data } = await api.get(`/api/folios?stayId=${stay.id}`);
        folioId = data[0]?.id;
      }
      if (!folioId) {
        toast.info('Folio not ready yet — try again in a moment.');
        return;
      }
      navigate(`/folios?id=${folioId}`);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  return (
    <div>
      <h2>Arrivals &amp; Departures</h2>

      <div className="panel">
        <div className="panel-head">
          <h3>Expected arrivals {loading && <span className="spinner" style={{ marginLeft: 8 }} />}</h3>
          {/* The range switcher sits in the panel header, top right. */}
          <div className="seg-rect" role="group" aria-label="Arrival window">
            {[
              ['today', 'Today'],
              ['week', 'Week'],
              ['month', 'Month'],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`seg-rect-btn${range === value ? ' is-active' : ''}`}
                aria-pressed={range === value}
                onClick={() => setRange(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* A partial list must say so. Silently showing fewer arrivals than
            exist is the exact failure this screen was rebuilt to remove. */}
        {degraded && (
          <p className="error" style={{ marginTop: 0 }}>
            Showing locally-known arrivals only — the reservation service is unreachable, so this list may be
            incomplete.
          </p>
        )}

        {arrivals.length === 0 && !loading ? (
          <EmptyState
            kind="inbox"
            title="No expected arrivals"
            hint={
              range === 'today'
                ? 'Confirmed reservations arriving today will appear here. Try Week or Month for later arrivals.'
                : `No confirmed reservations arriving in the next ${range === 'week' ? '7' : '30'} days.`
            }
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th className="t-c"></th>
                <th>Confirmation</th>
                <th>Guest</th>
                <th>Expected in</th>
                <th className="t-c">Nights</th>
                <th className="t-c">Pax</th>
                <th className="t-c">Actions</th>
              </tr>
            </thead>
            <tbody>
              {arrivals.map((s) => (
                <tr key={s.id}>
                  <td className="t-c" style={{ width: 40 }}>
                    <Avatar name={s.guestName || 'Guest'} size={30} />
                  </td>
                  <td>
                    {s.confirmationNumber || s.reservationId?.slice(0, 8) || '—'}
                    {s.overdue && (
                      <>
                        {' '}
                        <span className="badge cancelled" title="Due before today and not yet arrived">
                          Overdue
                        </span>
                      </>
                    )}
                  </td>
                  <td>{s.guestName || <span className="muted">—</span>}</td>
                  <td>
                    {s.expectedCheckIn
                      ? new Date(s.expectedCheckIn).toLocaleDateString([], {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })
                      : '—'}
                  </td>
                  <td className="t-c">{s.nights ?? '—'}</td>
                  <td className="t-c">{s.adults == null ? '—' : s.adults + (s.children || 0)}</td>
                  <td className="t-actions">
                    <button
                      className="small"
                      onClick={() => setCheckInModal({ open: true, stay: s, roomId: '' })}
                    >
                      Check-in
                    </button>
                    {canDelete && (
                      <button
                        className="small danger"
                        style={{ marginLeft: 6 }}
                        onClick={() => deleteReservation(s.reservationId, s.guestName)}
                        title="Delete this reservation"
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h3>In-House Guests</h3>
        {inHouse.length === 0 && !loading ? (
          <EmptyState
            kind="guests"
            title="No in-house guests"
            hint="Check in an arrival above to populate this list."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th className="t-c"></th>
                <th>Stay</th>
                <th>Guest</th>
                <th className="t-c">Guest status</th>
                <th className="t-c">Room</th>
                <th>Checked in</th>
                <th>Expected out</th>
                <th className="t-c">Actions</th>
              </tr>
            </thead>
            <tbody>
              {inHouse.map((s) => (
                <tr key={s.id}>
                  <td className="t-c" style={{ width: 40 }}>
                    <Avatar name={s.guestName || 'Guest'} size={30} />
                  </td>
                  <td>{s.id.slice(0, 8)}</td>
                  <td>{s.guestName || <span className="muted">—</span>}</td>
                  <td className="t-c">
                    <StatusPill status={s.status} />
                  </td>
                  <td className="t-c">{s.assignedRoomId}</td>
                  {/* Date AND time: on a check-in list "when did they arrive"
                      is an operational question about today, not a calendar one. */}
                  <td>
                    {s.actualCheckInAt ? (
                      new Date(s.actualCheckInAt).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>{s.expectedCheckOut ? new Date(s.expectedCheckOut).toLocaleDateString() : '—'}</td>
                  <td className="t-actions">
                    <button className="small" onClick={() => checkOut(s.id, s.guestName)}>
                      Check-out
                    </button>{' '}
                    <button
                      className="small danger"
                      onClick={() =>
                        setEarlyModal({ open: true, stayId: s.id, unusedNights: 1, nightlyRate: '' })
                      }
                    >
                      Early depart
                    </button>{' '}
                    <button className="small secondary" onClick={() => regCard(s.id)}>
                      Reg card
                    </button>{' '}
                    <button className="small secondary" onClick={() => openFolio(s)}>
                      Folio
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h3>Today's departures</h3>
        {departures.length === 0 && !loading ? (
          <EmptyState
            kind="calendar"
            title="No departures today"
            hint="Stays ending today will appear here."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th className="t-c"></th>
                <th>Stay</th>
                <th>Guest</th>
                <th className="t-c">Room</th>
              </tr>
            </thead>
            <tbody>
              {departures.map((s) => (
                <tr key={s.id}>
                  <td className="t-c" style={{ width: 40 }}>
                    <Avatar name={s.guestName || 'Guest'} size={30} />
                  </td>
                  <td>{s.id.slice(0, 8)}</td>
                  <td>{s.guestName || <span className="muted">—</span>}</td>
                  <td className="t-c">{s.assignedRoomId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal
        open={checkInModal.open}
        onClose={() => setCheckInModal({ open: false, stay: null, roomId: '' })}
        title={`Check-in: ${checkInModal.stay?.guestName || 'Guest'}`}
        footer={
          <>
            <button
              className="secondary"
              onClick={() => setCheckInModal({ open: false, stay: null, roomId: '' })}
            >
              Cancel
            </button>
            <button form="checkin-form">Confirm check-in</button>
          </>
        }
      >
        <form id="checkin-form" onSubmit={submitCheckIn}>
          <label>Assign room (only CLEAN + vacant shown)</label>
          <select
            required
            value={checkInModal.roomId}
            onChange={(e) => setCheckInModal({ ...checkInModal, roomId: e.target.value })}
          >
            <option value="">— Select a room —</option>
            {availableRooms.map((r) => (
              <option key={r.id} value={r.id}>
                Room {r.number} · {r.typeCode} · Floor {r.floor}
              </option>
            ))}
          </select>
          {availableRooms.length === 0 && (
            <p className="error">No clean vacant rooms available. Check housekeeping.</p>
          )}
        </form>
      </Modal>

      <Modal
        open={earlyModal.open}
        onClose={() => setEarlyModal({ ...earlyModal, open: false })}
        title="Early departure"
        footer={
          <>
            <button className="secondary" onClick={() => setEarlyModal({ ...earlyModal, open: false })}>
              Cancel
            </button>
            <button form="early-form" className="danger">
              Process
            </button>
          </>
        }
      >
        <form id="early-form" onSubmit={submitEarly}>
          <div className="row">
            <div>
              <label>Unused nights</label>
              <input
                type="number"
                min="1"
                required
                value={earlyModal.unusedNights}
                onChange={(e) => setEarlyModal({ ...earlyModal, unusedNights: e.target.value })}
              />
            </div>
            <div>
              <label>Nightly rate (₱)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                required
                placeholder="e.g. 1500.00"
                value={earlyModal.nightlyRate}
                onChange={(e) => setEarlyModal({ ...earlyModal, nightlyRate: e.target.value })}
              />
            </div>
          </div>
          <p className="muted">A refund adjustment will be posted to the guest's folio.</p>
        </form>
      </Modal>
    </div>
  );
}
