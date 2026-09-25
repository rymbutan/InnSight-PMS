// The right-hand marketing panel shared by every signed-out screen (Sign In,
// Sign Up, Forgot/Reset password via AuthShell). Pulled into its own
// component for the same reason AuthShell itself exists: three call sites
// duplicating this markup means three chances for one of them to quietly go
// stale.
export default function AuthHero() {
  return (
    <div className="login-hero">
      <div className="login-hero-topbar">
        <span className="login-hero-support">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M4 13v-1a8 8 0 0 1 16 0v1M4 13v4a2 2 0 0 0 2 2h1v-7H5a1 1 0 0 0-1 1Zm16 0v4a2 2 0 0 1-2 2h-1v-7h2a1 1 0 0 1 1 1Z"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Support
        </span>
      </div>

      <div className="login-hero-highlight">
        <div className="login-hero-highlight-text">
          <h2>Run your front desk faster</h2>
          <p>Check guests in, track housekeeping, and close the night audit — all from one dashboard.</p>
          <span className="login-hero-cta">Learn more</span>
        </div>
        <img className="login-hero-highlight-art" src="/brand/hotel.jpg" alt="" aria-hidden="true" />
      </div>
      <div className="login-hero-stat" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M4 20V10M12 20V4M20 20v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <div>
          <strong>87%</strong>
          <span>Occupancy today</span>
        </div>
      </div>

      <div className="login-hero-features">
        <h3>Introducing new features</h3>
        <p>Real-time room status, automated night audits, and instant guest messaging — all in one place.</p>
      </div>

      <div className="login-hero-dots" aria-hidden="true">
        <span className="login-hero-arrow">‹</span>
        <span className="login-hero-dot" />
        <span className="login-hero-dot login-hero-dot--active" />
        <span className="login-hero-dot" />
        <span className="login-hero-arrow">›</span>
      </div>
    </div>
  );
}
