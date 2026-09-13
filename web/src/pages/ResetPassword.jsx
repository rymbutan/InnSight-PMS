import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';

// Redeem a reset link. The token arrives in the query string, never typed.
export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const navigate = useNavigate();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    // Checked here as well as on the server: the server enforces the rule, this
    // just saves a round trip to be told something the page already knows.
    if (pw.length < 8) return setError('Password must be at least 8 characters.');
    if (pw !== confirm) return setError('The two passwords do not match.');
    setLoading(true);
    try {
      await api.post('/api/auth/reset-password', { token, newPassword: pw });
      setDone(true);
      // Straight to sign-in rather than logging them in from here: the reset
      // deliberately mints no session, so the new password is proved once by
      // being typed.
      setTimeout(() => navigate('/login'), 2200);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not reset the password. Try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-form-side">
        <div className="login-card">
          <h1 className="login-title">Choose a new password</h1>
          {!token ? (
            <>
              <p className="login-sub">This link is missing its token. Request a new one.</p>
              <p className="login-alt">
                <Link to="/forgot-password">Forgot password?</Link>
              </p>
            </>
          ) : done ? (
            <>
              <p className="login-sub">
                Password updated. You have been signed out everywhere. Taking you to sign in…
              </p>
              <p className="login-alt">
                <Link to="/login">Sign in now</Link>
              </p>
            </>
          ) : (
            <form onSubmit={onSubmit}>
              <label htmlFor="rp-pw">New password</label>
              <input
                id="rp-pw"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
              />
              <label htmlFor="rp-confirm">Confirm new password</label>
              <input
                id="rp-confirm"
                type="password"
                required
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
              {error && (
                <div className="error" role="alert">
                  {error}
                </div>
              )}
              <button className="btn-primary" disabled={loading}>
                {loading ? 'Saving…' : 'Set new password'}
              </button>
              <p className="login-alt">
                <Link to="/login">Back to sign in</Link>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
