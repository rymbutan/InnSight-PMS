import { useEffect, useState } from 'react';
import Icon from './Icon';

// Time-of-day greeting.
//
//   00:00–11:59  sunrise  Good morning
//   12:00–17:59  sun      Good afternoon
//   18:00–23:59  moon     Good evening
//
// Boundaries are inclusive-start / exclusive-end, which is what makes 11:59
// still morning and 12:00 already afternoon.
function bandFor(hour) {
  if (hour < 12) return { icon: 'sunrise', text: 'Good morning' };
  if (hour < 18) return { icon: 'sun', text: 'Good afternoon' };
  return { icon: 'moon', text: 'Good evening' };
}

export default function Greeting({ name }) {
  const [hour, setHour] = useState(() => new Date().getHours());

  // A front-desk browser sits open across a shift change, so the greeting has to
  // roll over on its own — it used to be computed once at mount and would still
  // read "Good morning" at 8pm. Re-check on the hour rather than on a timer
  // tick, and re-arm each time so drift cannot accumulate.
  useEffect(() => {
    let timer;
    const schedule = () => {
      const now = new Date();
      const msToNextHour =
        (59 - now.getMinutes()) * 60000 + (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
      timer = setTimeout(() => {
        setHour(new Date().getHours());
        schedule();
      }, Math.max(1000, msToNextHour));
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);

  const band = bandFor(hour);

  return (
    <div className="greeting">
      <Icon name={band.icon} size={16} strokeWidth={1.9} />
      {/* The comma and the name are ONE span so the narrow-screen rule that
          drops the name takes its punctuation with it — hiding just the name
          left "Good morning, !" on the bar. */}
      <span className="greeting-text">
        {band.text}
        {name ? (
          <span className="greeting-name">
            , <strong>{name}</strong>
          </span>
        ) : null}
        !
      </span>
    </div>
  );
}
