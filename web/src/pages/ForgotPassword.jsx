import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import AuthShell from '../components/AuthShell';

// Ask for a reset link.
//
// The response is the SAME whether or not the address belongs to an account —
// see POST /api/auth/forgot-password — so this page must not imply otherwise.
// "If that email matches an account" is doing real work: phrasing it as "sent"
// would tell whoever typed it that the address is registered here.
//
// Frame is AuthShell, the same one Login draws. This page used `.login-wrap`,
// `.login-title` and `.login-sub`, two of which are not in the stylesheet, so
// its heading and body copy rendered unstyled beside an empty half-frame.
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

  if (sent) {
    return (
      <AuthShell
        title="Check your email"
        lede="If that email matches an account, a reset link is on its way. It expires in 30 minutes and works once."
      >
        <p className="login-note">
          Nothing arrived? Check your spam folder first, then confirm you used the address your account was
          created with. An administrator can also set a new password for you directly.
        </p>
        <p className="login-alt">
          <Link to="/login">Back to sign in</Link>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Forgot password"
      lede="Enter the email on your account and we’ll send you a link to choose a new password."
      onSubmit={onSubmit}
    >
      <label className="login-label" htmlFor="fp-email">
        Email
      </label>
      <input
        id="fp-email"
        className="login-input"
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@slsu.edu.ph"
      />

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      <button className="login-submit" disabled={loading || !email}>
        {loading ? 'Sending…' : 'Send reset link'}
      </button>

      <p className="login-alt">
        <Link to="/login">Back to sign in</Link>
      </p>
    </AuthShell>
  );
}
