import { useEffect, useRef, useState } from 'react';
import api from '../api';

// Google Identity Services, loaded once and shared by every mount.
const GIS_SRC = 'https://accounts.google.com/gsi/client';
let gisPromise = null;

function loadGis() {
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const el = document.createElement('script');
    el.src = GIS_SRC;
    el.async = true;
    el.defer = true;
    el.onload = () => resolve();
    // Offline, blocked by an extension, or refused by CSP — the caller falls
    // back to hiding the button rather than showing a dead control.
    el.onerror = () => reject(new Error('Could not reach Google sign-in.'));
    document.head.appendChild(el);
  });
  return gisPromise;
}

// Google's mark, inlined so it needs no extra request and no img-src grant.
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}

/**
 * "Sign In with Google", restricted to the university domain.
 *
 * Uses the OAuth 2.0 token flow rather than Google's rendered button, because
 * that button lives in an iframe and cannot be styled to match this screen. The
 * browser gets an access token; the SERVER decides what it means — it checks the
 * token was issued to us, reads the profile, and enforces the domain. Nothing
 * here is a security control: `hint`/`hosted_domain` only pre-filter Google's own
 * account chooser.
 *
 * Renders nothing at all unless the server reports a configured client id.
 */
export default function GoogleSignIn({ onCredential, onError, disabled }) {
  const [cfg, setCfg] = useState(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const clientRef = useRef(null);
  const cb = useRef(onCredential);
  cb.current = onCredential;

  useEffect(() => {
    let cancelled = false;
    api
      .get('/api/auth/config')
      .then((r) => !cancelled && setCfg(r.data))
      .catch(() => !cancelled && setUnavailable(true));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!cfg?.googleClientId) return;
    let cancelled = false;

    loadGis()
      .then(() => {
        if (cancelled) return;
        clientRef.current = window.google.accounts.oauth2.initTokenClient({
          client_id: cfg.googleClientId,
          scope: 'openid email profile',
          hosted_domain: cfg.allowedEmailDomain,
          callback: (resp) => {
            setBusy(false);
            if (resp?.access_token) cb.current?.(resp.access_token);
            else onError?.('Google sign-in was cancelled.');
          },
          error_callback: () => {
            setBusy(false);
            onError?.('Google sign-in was cancelled.');
          },
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setUnavailable(true);
        onError?.(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [cfg]);

  if (unavailable || (cfg && !cfg.googleClientId)) return null;

  return (
    <div className="google-signin">
      <button
        type="button"
        className="google-btn"
        disabled={disabled || busy || !clientRef.current}
        onClick={() => {
          setBusy(true);
          clientRef.current?.requestAccessToken();
        }}
      >
        <GoogleMark />
        <span>{busy ? 'Waiting for Google…' : 'Sign In with Google'}</span>
      </button>
      {cfg?.allowedEmailDomain && (
        <p className="google-signin-hint muted">
          Use your <strong>@{cfg.allowedEmailDomain}</strong> university account.
        </p>
      )}
    </div>
  );
}
