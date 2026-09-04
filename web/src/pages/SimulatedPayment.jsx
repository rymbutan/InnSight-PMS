// Guest-facing simulated wallet payment. URL: /pay/:token
//
// This is what a scanned QR code opens. It needs no login: the token in the URL is
// the credential (32 random bytes, single use, 15 minutes — see the folio service's
// lib/paymentIntent.js), which is why this page is mounted outside the app shell.
//
// It is deliberately, visibly a simulation. A training system that renders
// something indistinguishable from GCash or Maya teaches students to trust a
// screen that looks like this, which is the exact instinct that gets people
// phished. The banner is a feature, not a disclaimer.

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';
import { formatPeso } from '../lib/money';

// Explicit labels rather than mangling the enum. `.replace('_',' ')` plus a
// capitalize transform rendered QR_WALLET as "Qr Wallet".
const METHOD_LABELS = {
  QR_WALLET: 'QR wallet',
  GCASH: 'GCash',
  MAYA: 'Maya',
};

const MESSAGES = {
  EXPIRED: 'This payment link has expired. Ask the front desk for a new code.',
  CONFIRMED: 'This payment has already been made.',
  CANCELLED: 'This payment link was cancelled by the front desk.',
};

export default function SimulatedPayment() {
  const { token } = useParams();
  const [intent, setIntent] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [paid, setPaid] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/api/public/payment-intents/${encodeURIComponent(token)}`)
      .then((r) => !cancelled && setIntent(r.data))
      .catch(() => !cancelled && setErr('This payment link is not valid.'));
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function confirm() {
    setBusy(true);
    try {
      await api.post(`/api/public/payment-intents/${encodeURIComponent(token)}/confirm`);
      setPaid(true);
    } catch (e) {
      // The server answers 409 with the actual state, so the guest is told what
      // happened — already paid, or expired — instead of "something went wrong".
      const state = e?.response?.data?.state;
      setErr(MESSAGES[state] || e?.response?.data?.error || 'That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const state = intent?.state;
  const payable = state === 'PENDING' && !paid;

  return (
    <div className="pay-page">
      <div className="pay-card">
        <div className="pay-sim-banner">Simulated payment — no money will move</div>

        <h1 className="pay-hotel">InnSight Hotel</h1>

        {err && !paid && <p className="pay-error">{err}</p>}

        {!intent && !err && <p className="muted">Loading…</p>}

        {intent && !paid && (
          <>
            <div className="pay-amount-label">Amount due</div>
            <div className="pay-amount">{formatPeso(intent.amountCents)}</div>
            <div className="muted pay-method">via {METHOD_LABELS[intent.method] || intent.method}</div>

            {payable ? (
              <button className="pay-confirm" onClick={confirm} disabled={busy}>
                {busy ? 'Confirming…' : 'Confirm payment'}
              </button>
            ) : (
              <p className="pay-error">{MESSAGES[state] || 'This payment link cannot be used.'}</p>
            )}
          </>
        )}

        {paid && (
          <div className="pay-done">
            <div className="pay-tick" aria-hidden="true">
              ✓
            </div>
            <div className="pay-amount">{formatPeso(intent.amountCents)}</div>
            <p>
              Paid. The front desk has been notified — your folio is already updated.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
