import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { pingBackend } from '../api';
import GoogleSignIn from '../components/GoogleSignIn';

export default function Login() {
  const { user, login, loginWithGoogle, loading } = useAuth();
  const navigate = useNavigate();
  // Prefill the username on the dev server only. The PASSWORD is never prefilled
  // and never displayed: there is no fixed default any more — it is whatever
  // ADMIN_INITIAL_PASSWORD was set to when `scripts/db-seed.sh` created the
  // account, and that account is flagged mustChangePwd so the value is valid for
  // exactly one sign-in.
  const [username, setUsername] = useState(import.meta.env.DEV ? 'admin' : '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [backend, setBackend] = useState({ checking: true, ok: false, msg: '' });

  // On mount, ping the backend so we can give a useful message instead of a
  // generic "network error" if the gateway is down or unreachable.
  useEffect(() => {
    let cancelled = false;
    pingBackend().then((r) => {
      if (cancelled) return;
      if (r.ok) setBackend({ checking: false, ok: true, msg: '' });
      else
        setBackend({
          checking: false,
          ok: false,
          msg: 'Backend (gateway) is unreachable. Run `docker compose up -d` then refresh.',
        });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (user) return <Navigate to="/" replace />;

  // Google has verified the person; the server decides whether that address is
  // allowed in and issues the same session token the password path does.
  async function onGoogleCredential(credential) {
    setError('');
    try {
      const u = await loginWithGoogle(credential);
      navigate(u?.mustChangePwd ? '/change-password' : '/');
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    try {
      const u = await login(username, password);
      navigate(u?.mustChangePwd ? '/change-password' : '/');
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  }

  const signInLabel = loading
    ? 'Signing in…'
    : backend.checking
      ? 'Checking backend…'
      : !backend.ok
        ? 'Backend unreachable'
        : 'Sign In';

  return (
    <div className="login-shell">
      <div className="login-panel">
        {/* ── Left: photograph, brand mark top-left, strapline bottom-left ── */}
        <aside className="login-figure">
          <img className="login-figure-img" src="/brand/hotel.jpg" alt="" aria-hidden="true" />
          <div className="login-figure-scrim" aria-hidden="true" />
          <div className="login-figure-body">
            <div className="login-eyebrow">
              <img src="/brand/innsight-mark.png" alt="InnSight" className="login-eyebrow-mark" />
              <span className="login-eyebrow-rule" aria-hidden="true" />
            </div>
            <div className="login-figure-quote">
              <h2>
                Every Stay,
                <br />
                Perfectly Run
              </h2>
              <p>A modern PMS for front-desk, housekeeping, and night audit — built as an SLSU capstone.</p>
            </div>
          </div>
        </aside>

        {/* ── Right: the form ── */}
        <div className="login-form-side">
          <form className="login-card" onSubmit={onSubmit}>
            <img
              className="login-wordmark"
              src="/brand/innsight-wordmark.png"
              alt="InnSight"
              width="640"
              height="186"
            />

            <h1>Welcome Back</h1>
            <p className="login-lede">Enter your username and password to access your account</p>

            <label className="login-label" htmlFor="login-username">
              Username
            </label>
            <input
              id="login-username"
              className="login-input"
              placeholder="Enter your username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
            />

            <label className="login-label" htmlFor="login-password">
              Password
            </label>
            <div className="login-input-wrap">
              <input
                id="login-password"
                className="login-input"
                type={showPassword ? 'text' : 'password'}
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
              <button
                type="button"
                className="login-reveal"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
                title={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? '🙈' : '👁'}
              </button>
            </div>

            <button className="login-submit" disabled={loading || !backend.ok}>
              {signInLabel}
            </button>

            <GoogleSignIn
              onCredential={onGoogleCredential}
              onError={setError}
              disabled={loading || !backend.ok}
            />

            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}

            {!backend.checking && !backend.ok && (
              <div className="login-backend-warning" role="alert">
                <strong>{backend.msg}</strong>
                <div>
                  In a terminal: <code>cd "InnSight PMS" && docker compose up -d</code>
                </div>
              </div>
            )}

            <p className="login-alt">
              Don&rsquo;t have an account? <Link to="/request-access">Sign Up</Link>
            </p>

            {import.meta.env.DEV && (
              <p className="login-devhint muted">
                Sign in as <code>admin</code> with the <code>ADMIN_INITIAL_PASSWORD</code> from your{' '}
                <code>.env</code> (generated by <code>scripts/gen-env.sh</code>). You will be asked to change
                it.
              </p>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
