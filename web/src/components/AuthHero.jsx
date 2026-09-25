import { useEffect, useState } from 'react';

// The right-hand marketing panel shared by every signed-out screen (Sign In,
// Sign Up, Forgot/Reset password via AuthShell). Pulled into its own
// component for the same reason AuthShell itself exists: three call sites
// duplicating this markup means three chances for one of them to quietly go
// stale.
//
// A real carousel, not decorative dots: each slide pairs the highlight
// card's pitch with a stat and a matching sentence under "Introducing new
// features", auto-advancing but fully driven by the same index a click on
// an arrow or a dot would set.
const SLIDES = [
  {
    heading: 'Every Stay, Perfectly Run',
    body: 'Check guests in, track housekeeping, and close the night audit — all from one dashboard.',
    statValue: '87%',
    statLabel: 'Occupancy today',
    feature: 'Real-time room status, automated night audits, and instant guest messaging — all in one place.',
  },
  {
    heading: 'Housekeeping, in real time',
    body: "See every room's status the moment it changes, from dirty to inspected.",
    statValue: '42',
    statLabel: 'Rooms turned today',
    feature: 'Housekeepers update room status from any device — the front desk sees it instantly.',
  },
  {
    heading: 'Close the night audit in minutes',
    body: 'Automated reconciliation catches discrepancies before they become problems.',
    statValue: '3 min',
    statLabel: 'Average audit time',
    feature: 'Nightly reports run themselves, so your team can focus on guests instead of spreadsheets.',
  },
];

// Advances on its own, but every render reads the count off the *current*
// index rather than a fixed delay from mount, so a manual click on an arrow
// or a dot below resets how long the next auto-advance waits — nobody
// clicks "next" only to have it flip again a moment later.
const AUTO_ADVANCE_MS = 6000;

export default function AuthHero() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setIndex((i) => (i + 1) % SLIDES.length);
    }, AUTO_ADVANCE_MS);
    return () => clearInterval(id);
  }, [index]);

  const slide = SLIDES[index];
  const goTo = (i) => setIndex((i + SLIDES.length) % SLIDES.length);

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
        <div className="login-hero-highlight-text" key={`text-${index}`}>
          <h2>{slide.heading}</h2>
          <p>{slide.body}</p>
          <span className="login-hero-cta">Learn more</span>
        </div>
        <img className="login-hero-highlight-art" src="/brand/hotel.jpg" alt="" aria-hidden="true" />
      </div>
      <div className="login-hero-stat" key={`stat-${index}`}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 20V10M12 20V4M20 20v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <div>
          <strong>{slide.statValue}</strong>
          <span>{slide.statLabel}</span>
        </div>
      </div>

      <div className="login-hero-features" key={`features-${index}`}>
        <h3>Introducing new features</h3>
        <p>{slide.feature}</p>
      </div>

      <div className="login-hero-dots">
        <button
          type="button"
          className="login-hero-arrow"
          aria-label="Previous slide"
          onClick={() => goTo(index - 1)}
        >
          ‹
        </button>
        {SLIDES.map((s, i) => (
          <button
            key={s.heading}
            type="button"
            className={'login-hero-dot' + (i === index ? ' login-hero-dot--active' : '')}
            aria-label={`Show slide ${i + 1}: ${s.heading}`}
            aria-current={i === index}
            onClick={() => goTo(i)}
          />
        ))}
        <button type="button" className="login-hero-arrow" aria-label="Next slide" onClick={() => goTo(index + 1)}>
          ›
        </button>
      </div>
    </div>
  );
}
