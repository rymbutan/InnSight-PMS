import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';

// "Sign Up" for a system where nobody may sign themselves up.
//
// Submitting records a request; it creates no account and grants nothing. An
// administrator turns an approved request into a real user with real roles, so
// the default-deny rule the rest of the system depends on still holds.
export default function RequestAccess() {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [domain, setDomain] = useState('slsu.edu.ph');
  const [state, setState] = useState({ sending: false, sent: false, error: '' });

  // The allowed domain is server-owned; the placeholder should not hardcode it.
  useEffect(() => {
    let cancelled = false;
    api
      .get('/api/auth/config')
      .then((r) => {
        if (!cancelled && r.data?.allowedEmailDomain) setDomain(r.data.allowedEmailDomain);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(e) {
    e.preventDefault();
    setState({ sending: true, sent: false, error: '' });
    try {
      const { data } = await api.post('/api/auth/access-request', { fullName, email, note });
      setState({ sending: false, sent: true, error: '', message: data?.message });
    } catch (err) {
      setState({
        sending: false,
        sent: false,
        error: err.response?.data?.error || err.message,
      });
    }
  }

  return (
    <div className="login-shell">
      <div className="login-panel">
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

        <div className="login-form-side">
          <form className="login-card" onSubmit={onSubmit}>
            <img
              className="login-wordmark"
              src="/brand/innsight-wordmark.png"
              alt="InnSight"
              width="640"
              height="186"
            />

            {state.sent ? (
              <>
                <h1>Request Sent</h1>
                <p className="login-lede">
                  {state.message || 'An administrator will review it and set up your account.'}
                </p>
                <p className="login-lede">
                  You will not be able to sign in until your account has been created.
                </p>
                <Link className="login-submit login-submit-link" to="/login">
                  Back to Sign In
                </Link>
              </>
            ) : (
              <>
                <h1>Request Access</h1>
                <p className="login-lede">
                  Accounts are created by an administrator. Tell us who you are and we will pass it on.
                </p>

                <label className="login-label" htmlFor="ra-name">
                  Full name
                </label>
                <input
                  id="ra-name"
                  className="login-input"
                  placeholder="Enter your full name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  autoComplete="name"
                  required
                  autoFocus
                />

                <label className="login-label" htmlFor="ra-email">
                  University email
                </label>
                <input
                  id="ra-email"
                  className="login-input"
                  type="email"
                  placeholder={`you@${domain}`}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                />

                <label className="login-label" htmlFor="ra-note">
                  Why do you need access? <span className="muted">(optional)</span>
                </label>
                <textarea
                  id="ra-note"
                  className="login-input login-textarea"
                  placeholder="e.g. BSHM 4-A, enrolled in the front-office practicum"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  maxLength={500}
                />

                <button className="login-submit" disabled={state.sending}>
                  {state.sending ? 'Sending…' : 'Send Request'}
                </button>

                {state.error && (
                  <div className="error" role="alert">
                    {state.error}
                  </div>
                )}
              </>
            )}

            <p className="login-alt">
              Already have an account? <Link to="/login">Sign In</Link>
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
