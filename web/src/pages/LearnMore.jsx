import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import AuthBrandMark from '../components/AuthBrandMark';

// Public marketing page — no login required. This is where "Learn more" on
// the sign-in screen's carousel actually goes, rather than just advancing
// that carousel: three sections here mirror its three slides, and each
// carries the matching id so a link from a specific slide can jump straight
// to its section (see AuthHero.jsx).
const FEATURES = [
  {
    id: 'front-desk',
    title: 'Every stay, perfectly run',
    body: 'Check guests in, track housekeeping, and close the night audit — all from one dashboard. Front-desk staff see occupancy, arrivals, and room status the moment they change, without switching between spreadsheets or paper logs.',
    stat: { value: '87%', label: 'Typical occupancy visibility, in real time' },
  },
  {
    id: 'housekeeping',
    title: 'Housekeeping, in real time',
    body: "See every room's status the moment it changes, from dirty to inspected. Housekeepers update rooms from any device on the floor, so the front desk always knows what's ready to sell — no radio calls, no guesswork.",
    stat: { value: '42', label: 'Rooms a mid-size property turns on a busy day' },
  },
  {
    id: 'night-audit',
    title: 'Night audits that run themselves',
    body: 'Automated reconciliation catches discrepancies before they become problems. Nightly reports run on their own, so your team spends the graveyard shift on guests instead of spreadsheets.',
    stat: { value: '3 min', label: 'Average time to close a night audit' },
  },
];

export default function LearnMore() {
  // A client-side route change (react-router's Link, as AuthHero's "Learn
  // more" uses) doesn't trigger the browser's native jump-to-#hash the way a
  // full page load does — the DOM already exists, so nothing re-triggers it.
  // Scroll to the matching section by hand whenever the hash changes.
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash.slice(1));
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [hash]);

  return (
    <div className="learn-shell">
      <header className="learn-nav">
        <AuthBrandMark />
        <nav className="learn-nav-links">
          <Link to="/login">Sign In</Link>
          <Link to="/request-access" className="learn-nav-cta">
            Sign Up
          </Link>
        </nav>
      </header>

      <section className="learn-hero">
        <h1>Every Stay, Perfectly Run</h1>
        <p>A modern property management system for front-desk, housekeeping, and night audit.</p>
        <div className="learn-hero-actions">
          <Link to="/request-access" className="learn-hero-cta">
            Get started
          </Link>
          <Link to="/login" className="learn-hero-secondary">
            Sign In
          </Link>
        </div>
      </section>

      <section className="learn-features">
        {FEATURES.map((f) => (
          <div className="learn-feature" id={f.id} key={f.id}>
            <div className="learn-feature-text">
              <h2>{f.title}</h2>
              <p>{f.body}</p>
            </div>
            <div className="learn-feature-stat">
              <strong>{f.stat.value}</strong>
              <span>{f.stat.label}</span>
            </div>
          </div>
        ))}
      </section>

      <section className="learn-cta">
        <h2>Ready for a smoother front desk?</h2>
        <p>Request access and an administrator will get your account set up.</p>
        <Link to="/request-access" className="learn-hero-cta">
          Request Access
        </Link>
      </section>
    </div>
  );
}
