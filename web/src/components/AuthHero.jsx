// The left-hand brand panel shared by every signed-out screen (Sign In, Sign
// Up, Forgot/Reset password via AuthShell). Pulled into its own component for
// the same reason AuthShell itself exists: three call sites duplicating this
// markup means three chances for one of them to quietly go stale.
export default function AuthHero() {
  return (
    <div className="login-hero">
      <div className="login-hero-graphic" aria-hidden="true">
        <img className="login-hero-graphic-img" src="/brand/innsight-logo-icon.png" alt="" />
      </div>
      <div className="login-hero-bottom">
        <div className="login-hero-brand">
          <img className="login-hero-logo" src="/brand/innsight-logo-icon.png" alt="" aria-hidden="true" />
          <div>
            <div className="login-hero-word">InnSight</div>
            <div className="login-hero-tag">Hotel PMS</div>
          </div>
        </div>
        <p className="login-hero-copy">
          A modern property management system for front-desk, housekeeping, and night audit.
        </p>
      </div>
    </div>
  );
}
