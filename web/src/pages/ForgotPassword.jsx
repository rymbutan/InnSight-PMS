import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';

// Ask for a reset link.
//
// The response is the SAME whether or not the address belongs to an account —
// see POST /api/auth/forgot-password — so this page must not imply otherwise.
// "If that email matches an account" is doing real work: phrasing it as "sent"
// would tell whoever typed it that the address is registered here.
export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/api/auth/forgot-password', { email });
      setSent(true);
    } catch (err) {
      // Only a malformed request or an unreachable server lands here; the
      // endpoint answers 202 for everything else by design.
      setError(err.response?.data?.error || 'Could not reach the server. Try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-form-side">
        <div className="login-card">
          <h1 className="login-title">Forgot password</h1>
          {sent ? (
            <>
              <p className="login-sub">
                If that email matches an account, a reset link is on its way. It expires in 30 minutes and
                works once.
              </p>
              <p className="muted" style={{ fontSize: 12 }}>
                Nothing arrived? Check that you used the address your account was created with, or ask an
                administrator to reset it for you.
              </p>
              <p className="login-alt">
                <Link to="/login">Back to sign in</Link>
              </p>
            </>
          ) : (
            <form onSubmit={onSubmit}>
              <p className="login-sub">
                Enter the email on your account and we&rsquo;ll send you a link to choose a new password.
              </p>
              <label htmlFor="fp-email">Email</label>
              <input
                id="fp-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
              {error && (
                <div className="error" role="alert">
                  {error}
                </div>
              )}
              <button className="btn-primary" disabled={loading || !email}>
                {loading ? 'Sending…' : 'Send reset link'}
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
