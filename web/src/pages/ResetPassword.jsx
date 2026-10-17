import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';
import AuthShell from '../components/AuthShell';
import EyeIcon from '../components/EyeIcon';

// Redeem a reset link. The token arrives in the query string, never typed.
//
// The markup is AuthShell — the same two-panel frame Login draws — because this
// page previously used a set of classes (.login-wrap, .login-title, .login-sub)
// that no longer exist in the stylesheet: the heading and the body copy rendered
// completely unstyled, and the card sat in a frame with nothing beside it. A
// person arriving here has clicked a link in their email and is one step from
// being locked out; it should not be the one screen in the product that looks
// half-built.
export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const navigate = useNavigate();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  // null while we haven't asked yet, then true/false. Opening the link SPENDS it:
  // the server swaps the emailed token for a one-time secret that lives only in
  // this component's memory, so a refresh, a second tab or a forwarded copy of
  // the URL all come back "expired". That is deliberate — see /reset-password/open.
  const [linkValid, setLinkValid] = useState(token ? null : false);
  const [session, setSession] = useState('');
  // Effects run twice under StrictMode in dev, and a second open would find the
  // link already spent and throw away the secret the first one returned. The ref
  // makes this a strictly once-per-page-load call, and nothing here is cancelled
  // on cleanup for the same reason: the first response is the only one we get.
  const opened = useRef(false);

  useEffect(() => {
    if (!token || opened.current) return undefined;
    opened.current = true;
    api
      .post('/api/auth/reset-password/open', { token })
      .then((res) => {
        setSession(res.data?.session || '');
        setLinkValid(Boolean(res.data?.valid));
      })
      // The link may or may not have been spent if this failed, and there is no
      // secret to submit with either way, so it is a dead end: say so.
      .catch(() => setLinkValid(false));
    return undefined;
  }, [token]);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    // Checked here as well as on the server: the server enforces the rule, this
    // just saves a round trip to be told something the page already knows.
    if (pw.length < 8) return setError('Password must be at least 8 characters.');
    if (pw !== confirm) return setError('The two passwords do not match.');
    setLoading(true);
    try {
      await api.post('/api/auth/reset-password', { token: session, newPassword: pw });
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
    return undefined;
  }

  // A link with no token is the one state where there is nothing to do here, so
  // it says so and points at the only way forward rather than showing a form
  // that cannot succeed.
  if (!token) {
    return (
      <AuthShell title="Link incomplete" lede="This reset link is missing its token, so it cannot be used.">
        <p className="login-alt">
          Links expire after 5 minutes and stop working as soon as they are opened. <Link to="/forgot-password">Request a new one</Link>.
        </p>
        <p className="login-alt">
          <Link to="/login">Back to sign in</Link>
        </p>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell title="Password updated" lede="You have been signed out everywhere. Taking you to sign in…">
        <p className="login-alt">
          <Link to="/login">Sign in now</Link>
        </p>
      </AuthShell>
    );
  }

  // Still asking the server whether this link is spent — do not flash the form
  // and then yank it away a moment later.
  if (linkValid === null) {
    return <AuthShell title="Checking your link" lede="One moment…" />;
  }

  // Same copy as the missing-token case above: a used or expired link is
  // exactly as dead as one with no token, so it gets exactly the same answer
  // rather than a form that only fails once you've typed a new password.
  if (!linkValid) {
    return (
      <AuthShell title="Link expired" lede="This reset link has already been used or has expired.">
        <p className="login-alt">
          Links expire after 5 minutes and stop working as soon as they are opened. <Link to="/forgot-password">Request a new one</Link>.
        </p>
        <p className="login-alt">
          <Link to="/login">Back to sign in</Link>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Choose a new password"
      lede="At least 8 characters. This link was used up when you opened it and expires 5 minutes after it was sent, so finish now."
      onSubmit={onSubmit}
    >
      <label className="login-label" htmlFor="rp-pw">
        New password
      </label>
      {/* The reveal toggle is the same control Login carries, and it matters
          more here: this is a password being INVENTED rather than recalled, and
          a typo in a masked field is only discovered at the confirm step. */}
      <div className="login-input-wrap">
        <input
          id="rp-pw"
          className="login-input"
          type={show ? 'text' : 'password'}
          required
          minLength={8}
          autoComplete="new-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
        <button
          type="button"
          className="login-reveal"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? 'Hide password' : 'Show password'}
          aria-pressed={show}
          title={show ? 'Hide password' : 'Show password'}
        >
          <EyeIcon off={show} />
        </button>
      </div>

      <label className="login-label" htmlFor="rp-confirm">
        Confirm new password
      </label>
      <input
        id="rp-confirm"
        className="login-input"
        type={show ? 'text' : 'password'}
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

      <button className="login-submit" disabled={loading}>
        {loading ? 'Saving…' : 'Set new password'}
      </button>

      <p className="login-alt">
        <Link to="/login">Back to sign in</Link>
      </p>
    </AuthShell>
  );
}
