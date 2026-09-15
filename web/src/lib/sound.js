import { useEffect, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// The message notification chime.
//
// SYNTHESISED, NOT A FILE
// -----------------------
// Two short sine tones from the Web Audio API rather than an mp3. A bundled
// audio file would be a binary asset in the repo, another request on every page
// load, and — because the artifact CSP and the gateway both keep this app on its
// own origin — one more thing to get right in the build. The whole sound is
// about forty lines of maths and weighs nothing.
//
// WHY THE 1.5s GATE
// -----------------
// Two places ring this bell: the sidebar badge in Layout.jsx (which notices any
// new message anywhere) and the open conversation in Messages.jsx (which
// notices a reply in the thread you are reading). While you sit on the Messages
// page with a thread open, both can see the same arrival within a second of each
// other, and five messages arriving at once should be one chime and not five.
// The gate lives here, in the one place both callers go through, rather than as
// coordination between them.
//
// AUTOPLAY
// --------
// Browsers refuse to start an AudioContext until the user has interacted with
// the page. In practice signing in IS that interaction and the context resumes
// on the first play, but a resume can still be refused (a tab restored in the
// background, for instance). Every failure path here is silent: a missing chime
// is a missing nicety, and an exception thrown from a polling callback is not.
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'innsight.messageSound';
// Per-device, like the light/dark theme and for the same reason: whether a
// sound is welcome depends on the room the terminal is in — the front desk has
// guests in earshot, the back office does not — not on who is signed in.
const CHANGE_EVENT = 'innsight:message-sound-changed';

const MIN_GAP_MS = 1500;
let lastPlayedAt = 0;
let ctx = null;

export function isSoundEnabled() {
  try {
    // Default ON: the point of the feature is to be noticed. Only an explicit
    // "off" silences it.
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    // Private mode, or storage blocked. Sound on is the shipped behaviour.
    return true;
  }
}

export function setSoundEnabled(enabled) {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    /* the toggle still works for this page's lifetime */
  }
  // `storage` only fires in OTHER tabs, so the toggle in Settings and the one in
  // the Messages header would not see each other without this.
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: enabled }));
}

// Shared state for every control that offers the toggle, so two of them on
// screen at once cannot disagree about whether sound is on.
export function useMessageSound() {
  const [enabled, setEnabled] = useState(isSoundEnabled);

  useEffect(() => {
    const sync = () => setEnabled(isSoundEnabled());
    window.addEventListener(CHANGE_EVENT, sync);
    // Another tab changing it counts too.
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  return [enabled, (next) => setSoundEnabled(next)];
}

function context() {
  if (ctx) return ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

// One tone of the chime.
function tone(ac, { freq, startAt, duration, peak }) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  // A ramped envelope, not an abrupt start and stop: a square-edged gain change
  // produces an audible click at each end that is more noticeable than the note.
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(gain).connect(ac.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

// A rising two-note figure — reads as "something arrived" rather than as an
// alarm. This app already has toast errors for things that are wrong.
export function playMessageChime() {
  if (!isSoundEnabled()) return;

  const now = Date.now();
  if (now - lastPlayedAt < MIN_GAP_MS) return;

  try {
    const ac = context();
    if (!ac) return;
    if (ac.state === 'suspended') ac.resume().catch(() => {});

    const t = ac.currentTime;
    tone(ac, { freq: 880, startAt: t, duration: 0.11, peak: 0.13 }); // A5
    tone(ac, { freq: 1318.5, startAt: t + 0.1, duration: 0.17, peak: 0.1 }); // E6
    lastPlayedAt = now;
  } catch {
    /* no audio device, blocked context, or a browser without Web Audio */
  }
}
