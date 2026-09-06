// Public-facing booking engine — no login required.
// Mounted at /book. Uses /api/availability and /api/reservations from the
// guest's perspective: pick dates → choose room type → enter contact info → done.
//
// Designed to be embeddable on a hotel's marketing site as an iframe later.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { formatPeso } from '../lib/money';
import Icon from '../components/Icon';

const STEPS = ['Dates', 'Room', 'Guest', 'Confirm'];

export default function PublicBooking() {
  const _navigate = useNavigate();
  const [step, setStep] = useState(0);

  // Step 1
  const [checkIn, setCheckIn] = useState('');
  const [checkOut, setCheckOut] = useState('');
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);

  // Availability
  const [types, setTypes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState(null);

  // Step 3
  const [guest, setGuest] = useState({ firstName: '', lastName: '', email: '', phone: '' });
  const [promoCode, setPromoCode] = useState('');

  // Step 4
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState(null);
  const [err, setErr] = useState('');

  const nights = useMemo(() => {
    if (!checkIn || !checkOut) return 0;
    return Math.max(0, Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000));
  }, [checkIn, checkOut]);

  async function searchAvailability() {
    setErr('');
    if (!checkIn || !checkOut) return setErr('Please pick check-in and check-out dates.');
    if (new Date(checkOut) <= new Date(checkIn)) return setErr('Check-out must be after check-in.');
    setLoading(true);
    try {
      const { data } = await api.get(`/api/public/availability?checkIn=${checkIn}&checkOut=${checkOut}`);
      setTypes(data || []);
      setStep(1);
    } catch (e) {
      setErr('We could not check availability right now. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  function pickType(t) {
    setPicked(t);
    setStep(2);
  }

  async function submit() {
    setErr('');
    if (!guest.firstName || !guest.lastName || !guest.email) {
      return setErr('Please fill in your name and email.');
    }
    setSubmitting(true);
    try {
      // Pricing and deposit are computed server-side; no payment is collected
      // here, so we don't send (or imply) any amounts.
      const payload = {
        guestName: `${guest.firstName} ${guest.lastName}`.trim(),
        guestEmail: guest.email,
        guestPhone: guest.phone,
        roomTypeCode: picked.roomTypeCode,
        checkIn,
        checkOut,
        adults,
        children,
        source: 'DIRECT',
        origin: 'Public booking engine',
        ...(promoCode.trim() ? { promoCode: promoCode.trim() } : {}),
      };
      const { data: r } = await api.post('/api/public/reservations', payload);
      setConfirmed(r);
      setStep(3);
    } catch (e) {
      setErr(e.response?.data?.error || 'Booking failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="public-booking">
      <header className="pb-header">
        <div className="pb-brand">
          <Icon name="building-2" size={28} />
          <div>
            <div className="pb-brand-name">InnSight Hotel</div>
            <div className="pb-brand-tag">Direct booking — no fees</div>
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
          <a href="/login" style={{ fontSize: 13, color: 'var(--muted)' }}>
            Staff login
          </a>
        </div>
      </header>

      <div className="pb-body">
        <div className="pb-stepper">
          {STEPS.map((s, i) => (
            <div key={s} className={`wizard-step ${step === i ? 'active' : step > i ? 'done' : ''}`}>
              <span className="num">{step > i ? <Icon name="check" size={12} /> : i + 1}</span> {s}
            </div>
          ))}
        </div>

        {step === 0 && (
          <div className="panel" style={{ maxWidth: 720, margin: '0 auto' }}>
            <h3>When are you staying with us?</h3>
            <div className="row">
              <div>
                <label>Check-in</label>
                <input type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
              </div>
              <div>
                <label>Check-out</label>
                <input type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
              </div>
              <div>
                <label>Adults</label>
                <input
                  type="number"
                  min="1"
                  value={adults}
                  onChange={(e) => setAdults(Number(e.target.value))}
                />
              </div>
              <div>
                <label>Children</label>
                <input
                  type="number"
                  min="0"
                  value={children}
                  onChange={(e) => setChildren(Number(e.target.value))}
                />
              </div>
            </div>
            {err && (
              <div className="error" role="alert">
                {err}
              </div>
            )}
            <button
              className="btn-cta"
              onClick={searchAvailability}
              disabled={loading}
              style={{ marginTop: 12 }}
            >
              {loading ? (
                'Searching…'
              ) : (
                <>
                  Search availability <Icon name="chevron-right" size={14} style={{ marginLeft: 4 }} />
                </>
              )}
            </button>
          </div>
        )}

        {step === 1 && (
          <div className="panel" style={{ maxWidth: 880, margin: '0 auto' }}>
            <h3>
              Available rooms · {nights} night{nights !== 1 ? 's' : ''}
            </h3>
            {types.length === 0 ? (
              <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
                Sorry, no rooms are available for those dates.
              </div>
            ) : (
              types.map((t) => (
                <div key={t.roomTypeCode} className="pb-roomcard">
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 16 }}>{t.name}</div>
                    <div className="muted" style={{ marginTop: 2 }}>
                      {t.available} room{t.available !== 1 ? 's' : ''} available · sleeps up to{' '}
                      {t.maxOccupancy || 2}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', minWidth: 160 }}>
                    <div style={{ fontSize: 22, fontWeight: 700 }}>{formatPeso(t.baseRate)}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      per night · {formatPeso((t.baseRate || 0) * nights)} total before taxes
                    </div>
                  </div>
                  <button className="btn-cta" onClick={() => pickType(t)} disabled={t.available <= 0}>
                    Select
                  </button>
                </div>
              ))
            )}
            <button className="secondary" style={{ marginTop: 12 }} onClick={() => setStep(0)}>
              ← Change dates
            </button>
          </div>
        )}

        {step === 2 && picked && (
          <div className="panel" style={{ maxWidth: 720, margin: '0 auto' }}>
            <h3>Your information</h3>
            <div className="row">
              <div>
                <label>First name *</label>
                <input
                  value={guest.firstName}
                  onChange={(e) => setGuest({ ...guest, firstName: e.target.value })}
                />
              </div>
              <div>
                <label>Last name *</label>
                <input
                  value={guest.lastName}
                  onChange={(e) => setGuest({ ...guest, lastName: e.target.value })}
                />
              </div>
            </div>
            <div className="row">
              <div>
                <label>Email *</label>
                <input
                  type="email"
                  value={guest.email}
                  onChange={(e) => setGuest({ ...guest, email: e.target.value })}
                />
              </div>
              <div>
                <label>Phone</label>
                <input value={guest.phone} onChange={(e) => setGuest({ ...guest, phone: e.target.value })} />
              </div>
              <div>
                <label>Promo code</label>
                <input
                  value={promoCode}
                  placeholder="optional"
                  onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
                />
              </div>
            </div>
            <div style={{ background: 'var(--accent-soft)', padding: 14, borderRadius: 8, marginTop: 14 }}>
              <strong>{picked.name}</strong>
              <br />
              <span className="muted">
                {checkIn} → {checkOut} · {nights} night{nights !== 1 ? 's' : ''}
              </span>
              <br />
              <strong style={{ fontSize: 18 }}>{formatPeso((picked.baseRate || 0) * nights)} total before taxes</strong>
              <br />
              <span className="muted" style={{ fontSize: 12 }}>
                Taxes are calculated when your booking is confirmed.
              </span>
            </div>
            {err && (
              <div className="error" role="alert" style={{ marginTop: 10 }}>
                {err}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button className="secondary" onClick={() => setStep(1)}>
                ← Back
              </button>
              <button
                className="btn-cta"
                onClick={submit}
                disabled={submitting}
                style={{ marginLeft: 'auto' }}
              >
                {submitting ? 'Booking…' : 'Confirm booking'}
              </button>
            </div>
          </div>
        )}

        {step === 3 && confirmed && (
          <div className="panel" style={{ maxWidth: 600, margin: '0 auto', textAlign: 'center' }}>
            <div style={{ color: 'var(--text-success)', marginBottom: 12 }}>
              <Icon name="check-circle" size={48} />
            </div>
            <h2 style={{ margin: '0 0 12px' }}>Booking confirmed!</h2>
            <p>Your confirmation number is</p>
            <div style={{ fontSize: 28, fontWeight: 700, fontFamily: 'monospace', margin: '8px 0 16px' }}>
              {confirmed.confirmationNumber}
            </div>
            <p className="muted">
              A confirmation email has been sent to <strong>{guest.email}</strong>.
            </p>
            <p className="muted" style={{ fontSize: 12 }}>
              Need to view or manage your reservation later? Visit{' '}
              <a href={`/portal/${confirmed.confirmationNumber}`}>your guest portal</a>.
            </p>
            <button
              className="btn-primary"
              onClick={() => {
                setStep(0);
                setConfirmed(null);
                setPicked(null);
                setCheckIn('');
                setCheckOut('');
                setGuest({ firstName: '', lastName: '', email: '', phone: '' });
              }}
              style={{ marginTop: 12 }}
            >
              Make another booking
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
