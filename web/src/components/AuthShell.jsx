import { Link } from 'react-router-dom';

// The signed-out frame: a brand panel on the left, a card on the right.
//
// WHY THIS EXISTS
// ---------------
// Login draws this frame inline, and the three pages that sit either side of it
// in the same flow — Forgot password, Reset password, Request access — did not.
// They used `.login-wrap`, `.login-title` and `.login-sub`, two of which are not
// in the stylesheet at all, so their heading and body copy rendered as bare
// unstyled text inside a frame with nothing beside it.
//
// That is a drift problem rather than a styling problem: the frame lived in one
// page's JSX, so every other page in the flow had to re-describe it from memory
// and one of them was describing a version that no longer existed. Extracting it
// means there is one frame, and a page that wants it cannot get it subtly wrong.
//
// Login itself is deliberately NOT refactored onto this. It carries a wordmark,
// a Google button, a backend-status guard and a password reveal, and folding all
// of that in would make the shared piece a component with a switch for every
// caller — which is the same drift again, wearing a prop.
export default function AuthShell({ title, lede, children, onSubmit }) {
  // A form when there is something to submit, a plain div when the page is only
  // telling you something. Wrapping a "check your inbox" message in a <form>
  // with no submit hands the browser an empty form to offer to autofill.
  const Card = onSubmit ? 'form' : 'div';
  const cardProps = onSubmit ? { onSubmit } : {};

  return (
    <div className="login-shell">
      <div className="login-panel">
        <aside className="login-illustration">
          <Link to="/login" aria-label="InnSight — back to sign in">
            <img className="login-illustration-logo" src="/brand/innsight-logo-icon.png" alt="InnSight" />
          </Link>
          <p className="login-illustration-caption">
            A modern PMS for front-desk, housekeeping, and night audit.
          </p>
        </aside>

        <div className="login-form-side">
          <Card className="login-card" {...cardProps}>
            <h1>{title}</h1>
            {lede && <p className="login-lede">{lede}</p>}

            {children}
          </Card>
        </div>
      </div>
    </div>
  );
}
