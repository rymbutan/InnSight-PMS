// Guest-facing reservation lookup. URL: /portal/:confirmationNumber
// Lets a guest see their booking status, dates, balance, and request changes
// (early check-in / late checkout) — without needing a staff login.

import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import api from '../api';
import { formatPeso } from '../lib/money';
import StatusPill from '../components/StatusPill';
import Icon from '../components/Icon';

export default function GuestPortal() {
  const { confirmationNumber } = useParams();
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [requestNote, setRequestNote] = useState('');

  useEffect(() => {
    api
      .get(`/api/public/reservations/${encodeURIComponent(confirmationNumber)}`)
      .then((r) => setRes(r.data))
      .catch((e) => setErr(e.response?.data?.error || 'Could not fetch your reservation.'));
  }, [confirmationNumber]);

  async function submitRequest() {
    if (!requestNote.trim()) return;
    setRequesting(true);
    try {
      await api.post(`/api/public/reservations/${res.confirmationNumber}/notes`, {
        body: `[Guest portal request] ${requestNote}`,
      });
      setRequestNote('');
      alert('Your request has been sent to the front desk.');
    } catch (e) {
      alert('Could not send your request. Please call us.');
    } finally {
      setRequesting(false);
    }
  }

  return (
    <div className="public-booking">
      <header className="pb-header">
        <div className="pb-brand">
          <Icon name="building-2" size={28} />
          <div>
            <div className="pb-brand-name">InnSight Hotel</div>
            <div className="pb-brand-tag">Guest portal</div>
          </div>
        </div>
        <Link to="/book" style={{ marginLeft: 'auto', fontSize: 13 }}>
          Make another booking
        </Link>
      </header>

      <div className="pb-body">
        {err && (
          <div className="panel" style={{ maxWidth: 600, margin: '0 auto', textAlign: 'center' }}>
            <div className="error" role="alert">
              {err}
            </div>
          </div>
        )}

        {res && (
          <>
            <div className="panel" style={{ maxWidth: 760, margin: '0 auto' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: 12,
                }}
              >
                <h2 style={{ margin: 0 }}>Your reservation</h2>
                <StatusPill status={res.status} />
              </div>
              <div className="muted" style={{ marginBottom: 14 }}>
                {res.confirmationNumber}
              </div>

              <div className="row">
                <div>
                  <label>Guest</label>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{res.guestName}</div>
                </div>
                <div>
                  <label>Email</label>
                  <div>{res.guestEmail || '—'}</div>
                </div>
              </div>
              <div className="row">
                <div>
                  <label>Check-in</label>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>
                    {new Date(res.checkIn).toLocaleDateString()}
                  </div>
                </div>
                <div>
                  <label>Check-out</label>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>
                    {new Date(res.checkOut).toLocaleDateString()}
                  </div>
                </div>
                <div>
                  <label>Nights</label>
                  <div>{res.nights}</div>
                </div>
                <div>
                  <label>Room type</label>
                  <div>{res.roomTypeCode}</div>
                </div>
              </div>
              <div className="row">
                <div>
                  <label>Total</label>
                  <div style={{ fontSize: 18, fontWeight: 700 }}>{formatPeso(res.totalEstimateCents)}</div>
                </div>
                <div>
                  <label>Deposit paid</label>
                  <div>{formatPeso(res.depositCents)}</div>
                </div>
                <div>
                  <label>Balance due at check-in</label>
                  <div style={{ color: 'var(--danger)', fontWeight: 600 }}>
                    {formatPeso(Number(res.totalEstimateCents) - Number(res.depositCents))}
                  </div>
                </div>
              </div>
            </div>

            <div className="panel" style={{ maxWidth: 760, margin: '0 auto' }}>
              <h3>Request a change</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                Need an early check-in, late checkout, or room preference? Send us a note — our front desk
                will respond.
              </p>
              <textarea
                rows={3}
                value={requestNote}
                onChange={(e) => setRequestNote(e.target.value)}
                placeholder="Tell us what you need…"
              />
              <button
                className="btn-cta"
                onClick={submitRequest}
                disabled={requesting || !requestNote.trim()}
                style={{ marginTop: 10 }}
              >
                {requesting ? 'Sending…' : 'Send request'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
