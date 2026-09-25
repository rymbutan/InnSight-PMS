import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api';

// Survives a refresh or a closed tab: approval can take anywhere from
// minutes to days, and losing the waiting screen on reload would dump
// someone back at a blank form with no way to tell they'd already applied.
const WAIT_ID_KEY = 'innsight_access_request_id';

// "Sign Up" for a system where nobody may sign themselves up.
//
// Submitting records a request; it creates no account and grants nothing. An
// administrator turns an approved request into a real user with real roles, so
// the default-deny rule the rest of the system depends on still holds.
export default function RequestAccess() {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [note, setNote] = useState('');
  const [domain, setDomain] = useState('slsu.edu.ph');
  const [state, setState] = useState({ sending: false, error: '' });
  // Two steps rather than one long column: who you are, then the credentials
  // you're choosing. Nothing is submitted until step 2 — step 1 only checks
  // that there is something to move forward with.
  const [step, setStep] = useState(1);
  const navigate = useNavigate();

  // Set once the request has been sent; presence of an id (not `state.sent`)
  // is what puts the page in "waiting" mode, so a refresh mid-wait resumes it
  // instead of showing the form again.
  const [waitId, setWaitId] = useState(() => {
    try {
      return localStorage.getItem(WAIT_ID_KEY) || null;
    } catch {
      return null;
    }
  });
  const [waitStatus, setWaitStatus] = useState('PENDING');
  const [waitUsername, setWaitUsername] = useState('');

  function forgetWait() {
    try {
      localStorage.removeItem(WAIT_ID_KEY);
    } catch {
      /* private browsing, storage disabled — the poll loop still stops */
    }
  }

  function startOver() {
    forgetWait();
    setWaitId(null);
    setWaitStatus('PENDING');
    setWaitUsername('');
    setState({ sending: false, error: '' });
    setStep(1);
  }

  // Polls while a request is outstanding. Every response short-circuits to a
  // PENDING read on anything it doesn't recognise (network hiccup, an id this
  // server never issued a real row for) rather than surfacing an error — the
  // person waiting should see "still waiting", not a scare they did something
  // wrong.
  useEffect(() => {
    if (!waitId || waitStatus !== 'PENDING') return;
    let cancelled = false;
    async function poll() {
      try {
        const { data } = await api.get(`/api/auth/access-request/${waitId}/status`);
        if (cancelled || data.status === 'PENDING') return;
        if (data.status === 'APPROVED') {
          setWaitUsername(data.username || '');
          setWaitStatus('APPROVED');
        } else if (data.status === 'REJECTED') {
          setWaitStatus('REJECTED');
        }
        forgetWait();
      } catch {
        /* try again next tick */
      }
    }
    poll();
    const t = setInterval(poll, 8000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [waitId, waitStatus]);

  // The one auto-redirect: straight to Sign In, but only once approval is
  // actually confirmed — never on submission itself.
  useEffect(() => {
    if (waitStatus !== 'APPROVED') return;
    const t = setTimeout(() => navigate('/login'), 2500);
    return () => clearTimeout(t);
  }, [waitStatus, navigate]);

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

  function goBack() {
    setState((s) => ({ ...s, error: '' }));
    setStep(1);
  }

  // One handler for both steps, so pressing Enter on step 1 (e.g. right after
  // typing an email) advances to step 2 instead of running step 2's password
  // checks against fields that are not even on screen yet.
  async function onSubmit(e) {
    e.preventDefault();
    if (step === 1) {
      if (!fullName.trim() || !email.trim()) {
        return setState((s) => ({ ...s, error: 'Enter your name and university email first.' }));
      }
      setState((s) => ({ ...s, error: '' }));
      return setStep(2);
    }
    if (password.length < 8) {
      return setState({ sending: false, error: 'Password must be at least 8 characters.' });
    }
    if (password !== confirmPassword) {
      return setState({ sending: false, error: 'Passwords do not match.' });
    }
    setState({ sending: true, error: '' });
    try {
      const { data } = await api.post('/api/auth/access-request', {
        fullName,
        email,
        username,
        password,
        confirmPassword,
        note,
      });
      if (data?.id) {
        try {
          localStorage.setItem(WAIT_ID_KEY, data.id);
        } catch {
          /* private browsing, storage disabled — polling still works this tab */
        }
        setWaitId(data.id);
        setWaitStatus('PENDING');
      }
      setState({ sending: false, error: '', message: data?.message });
    } catch (err) {
      setState({
        sending: false,
        error: err.response?.data?.error || err.message,
      });
    }
  }

  return (
    <div className="login-shell">
      <div className="login-panel">
        <div className="login-chrome" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>

        <aside className="login-figure">
          <img className="login-figure-img" src="/brand/hotel.jpg" alt="" aria-hidden="true" />
          <div className="login-figure-scrim" aria-hidden="true" />
          <button
            type="button"
            className="login-figure-back"
            aria-label="Back to sign in"
            onClick={() => navigate('/login')}
          >
            ←
          </button>
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
              <div className="login-quote-foot">
                <div className="login-quote-byline">
                  <strong>Front Desk, Simplified</strong>
                  <span>Built for hotel operations teams</span>
                </div>
                <div className="login-quote-nav" aria-hidden="true">
                  <span>‹</span>
                  <span>›</span>
                </div>
              </div>
            </div>
          </div>
        </aside>

        <div className="login-form-side">
          <form className="login-card" onSubmit={onSubmit}>
            <div className="login-badge" aria-hidden="true" />
            <img
              className="login-wordmark"
              src="/brand/innsight-wordmark.png"
              alt="InnSight"
              width="640"
              height="186"
            />

            {waitId ? (
              <>
                {waitStatus === 'PENDING' && (
                  <>
                    <h1>Waiting for Approval</h1>
                    <p className="login-lede">
                      {state.message || 'An administrator will review it and set up your account.'}
                    </p>
                    <p className="login-lede">
                      Leave this open or come back any time — it checks quietly and takes you to
                      Sign In the moment it's approved.
                    </p>
                  </>
                )}
                {waitStatus === 'APPROVED' && (
                  <>
                    <h1>Request Approved</h1>
                    <p className="login-lede">
                      {waitUsername
                        ? `You're all set — sign in as ${waitUsername}.`
                        : "You're all set — you can sign in now."}
                    </p>
                    <p className="login-lede">Taking you to Sign In…</p>
                    <Link className="login-submit login-submit-link" to="/login">
                      Go to Sign In now
                    </Link>
                  </>
                )}
                {waitStatus === 'REJECTED' && (
                  <>
                    <h1>Request Declined</h1>
                    <p className="login-lede">
                      An administrator declined this request. If you think that's a mistake, reach
                      out to them directly — or submit a new request below.
                    </p>
                    <button type="button" className="login-submit" onClick={startOver}>
                      Submit a new request
                    </button>
                  </>
                )}
              </>
            ) : step === 1 ? (
              <>
                <h1>Request Access</h1>
                <p className="login-lede">
                  Step 1 of 2 — tell us who you are. Next you'll choose the username and password
                  you'll sign in with, once an administrator approves the request.
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

                <button className="login-submit">Next</button>

                {state.error && (
                  <div className="error" role="alert">
                    {state.error}
                  </div>
                )}
              </>
            ) : (
              <>
                <h1>Choose Your Credentials</h1>
                <p className="login-lede">
                  Step 2 of 2 — this is what you'll sign in with. An administrator still has to
                  approve the request before either one works.
                </p>

                <label className="login-label" htmlFor="ra-username">
                  Username
                </label>
                <input
                  id="ra-username"
                  className="login-input"
                  placeholder="Pick a username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  minLength={3}
                  maxLength={32}
                  pattern="[a-zA-Z0-9._-]{3,32}"
                  title="3–32 characters: letters, numbers, dot, underscore or hyphen only."
                  required
                  autoFocus
                />

                <label className="login-label" htmlFor="ra-password">
                  Password
                </label>
                <div className="login-input-wrap">
                  <input
                    id="ra-password"
                    className="login-input"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="At least 8 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    minLength={8}
                    required
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

                <label className="login-label" htmlFor="ra-confirm-password">
                  Confirm password
                </label>
                <input
                  id="ra-confirm-password"
                  className="login-input"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Type it again"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  minLength={8}
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

                <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
                  <button type="button" className="secondary" onClick={goBack} disabled={state.sending}>
                    Back
                  </button>
                  <button className="login-submit" style={{ flex: 1, marginTop: 0 }} disabled={state.sending}>
                    {state.sending ? 'Sending…' : 'Send Request'}
                  </button>
                </div>

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
