// Promo-code preview for the desk's booking forms.
//
// The SERVER is still the authority: reservation.routes.js and stay.routes.js
// each validate the code again and apply the percentage themselves, and the
// client only ever sends the code, never a discounted price. This exists so the
// agent sees the discount in the summary BEFORE saving, using the same public
// endpoint the servers validate against.
import { useEffect, useState } from 'react';
import api from '../api';
export { afterPromoCents } from './money';

/**
 * Debounced validation of a typed code.
 *   state.status: 'idle' | 'checking' | 'valid' | 'invalid' | 'error'
 *   applied:      {code, percentOff} only while the code is confirmed valid
 * 'error' means the lookup itself failed (network/inventory down). The servers
 * fall back to full price in that case, so the form must not block on it.
 */
export function usePromo() {
  const [code, setCode] = useState('');
  const [state, setState] = useState({ status: 'idle' });

  useEffect(() => {
    const c = code.trim().toUpperCase();
    if (!c) {
      setState({ status: 'idle' });
      return undefined;
    }
    setState({ status: 'checking' });
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get(`/api/public/promo/${encodeURIComponent(c)}`);
        if (cancelled) return;
        setState(
          data?.valid
            ? { status: 'valid', code: data.code, percentOff: Number(data.percentOff) || 0, description: data.description }
            : { status: 'invalid' }
        );
      } catch {
        if (!cancelled) setState({ status: 'error' });
      }
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [code]);

  const applied = state.status === 'valid' ? { code: state.code, percentOff: state.percentOff } : null;
  return { code, setCode, state, applied };
}

/** One line of feedback under the promo input: {text, color} or null. */
export function promoHint(state) {
  switch (state.status) {
    case 'checking':
      return { text: 'Checking code…', color: 'var(--muted-2)' };
    case 'valid':
      return {
        text: `${state.code} applied — ${state.percentOff}% off${state.description ? ` (${state.description})` : ''}`,
        color: 'var(--text-success)',
      };
    case 'invalid':
      return { text: 'This code is not valid or has expired.', color: 'var(--text-danger)' };
    case 'error':
      return { text: 'Could not check this code right now; it will be checked when you save.', color: 'var(--muted-2)' };
    default:
      return null;
  }
}
