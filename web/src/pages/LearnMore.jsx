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
    body: 'A live 14-day room-type outlook makes overselling structurally impossible, Arrivals checks guests into a clean, inspected room in a couple of clicks, and a 4-step wizard walks a walk-in through rooms, details, guests, and payment. Every booking, cancellation, and check-in updates the dashboard the moment it happens — no manual refresh.',
    stat: { value: 'Live', label: 'Dashboard updates the instant a booking, stay, or folio changes' },
  },
  {
    id: 'housekeeping',
    title: 'Housekeeping, in real time',
    body: "An interactive floor map shows every room's status — dirty, clean, inspected, occupied — the moment it changes. Front desk can call a housekeeper about a specific room, and turnover isn't done until a supervisor signs off: housekeeping can clean a room, but only a supervisor can mark it Inspected — status always means what it says.",
    stat: { value: '2-step', label: 'Cleaned, then supervisor-inspected — never self-certified' },
  },
  {
    id: 'night-audit',
    title: 'Close the night audit in one click',
    body: 'One button posts a room charge to every in-house folio, combines every revenue source — rooms, amenities, laundry, spa — marks no-shows, auto-cancels overdue unconfirmed bookings, and closes the business day. Folios track every charge, payment, and refund, and an auditor has to approve one before a guest can check out. A full history of every past day (occupancy, ADR, RevPAR, revenue breakdown) is there to review afterward.',
    stat: { value: '1 button', label: 'Runs the full reconciliation and closes the day' },
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

      <section className="learn-hero" style={{ backgroundImage: 'url(/brand/hero-front-desk.jpg)' }}>
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
