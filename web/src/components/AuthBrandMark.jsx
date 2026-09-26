// The small icon + wordmark lockup at the top of the sign-in/sign-up card.
// Split out from AuthHero (which now renders the marketing panel on the
// opposite side) so both pieces stay reusable independently.
export default function AuthBrandMark() {
  return (
    <div className="login-brandmark">
      <img src="/brand/innsight-logo-full.png" alt="InnSight Hotel PMS" />
    </div>
  );
}
