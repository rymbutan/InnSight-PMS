// Global keyboard shortcuts — registered once at the layout level.
// Press `?` to see the help overlay.
//
// Shortcuts are intentionally close to common SaaS conventions:
//   /  → focus the global search
//   n  → new reservation
//   c  → calendar
//   r  → reservations list
//   d  → dashboard (home)
//   g  → guests
//   ?  → toggle help overlay
//   esc→ close help
//
// ─────────────────────────────────────────────────────────────────────────────
// THESE MUST NOT FIRE OVER AN IMMERSIVE SURFACE.
//
// `d` is "dashboard" here and "strafe right" in the training sim, which walks with
// WASD. Because both handlers sit on `window`, pressing `d` mid-shift navigated to
// `/` and tore the whole shift down — the trainee was dumped on the dashboard with
// their run lost. `preventDefault()` in the sim's own handler does not help: it
// stops the browser's default action, not other listeners on the same target.
//
// `n`, `c`, `r`, `g` and `t` are the same hazard, just less likely to be pressed
// while walking around a room.
//
// So a full-screen surface owns the keyboard while it is open. Two ways to claim it:
//   • render with `.cg-overlay` — the established class for every sim/game overlay,
//     so new mini-games are covered without touching this file
//   • put `data-keyboard-capture` on the root element, for overlays that can't use
//     that class (the room layout editor has its own opaque layout)
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../theme';
import Icon from './Icon';

// Anything matching this owns the keyboard: skip global shortcuts entirely.
const IMMERSIVE = '.cg-overlay, [data-keyboard-capture]';

const SHORTCUTS = [
  { keys: ['/'], label: 'Focus global search' },
  { keys: ['n'], label: 'New reservation' },
  { keys: ['c'], label: 'Open calendar' },
  { keys: ['r'], label: 'Reservations list' },
  { keys: ['d'], label: 'Dashboard' },
  { keys: ['g'], label: 'Guests' },
  { keys: ['t'], label: 'Toggle dark/light theme' },
  { keys: ['?'], label: 'Show this help' },
];

export default function KeyboardShortcuts() {
  const navigate = useNavigate();
  const { toggle } = useTheme();
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    function isTyping(target) {
      const tag = (target?.tagName || '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable;
    }
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) return;
      // Escape still closes our own help overlay even from inside a game, since
      // nothing else owns it.
      if (e.key === 'Escape') {
        if (helpOpen) setHelpOpen(false);
        return;
      }
      // A sim/game overlay is open — it owns WASD, E and L. Stay out of its way.
      if (document.querySelector(IMMERSIVE)) return;
      switch (e.key) {
        case '/': {
          const el = document.querySelector('.cb-search');
          if (el) {
            e.preventDefault();
            el.focus();
            el.select?.();
          }
          break;
        }
        case 'n':
          e.preventDefault();
          navigate('/reservations/new');
          break;
        case 'c':
          e.preventDefault();
          navigate('/calendar');
          break;
        case 'r':
          e.preventDefault();
          navigate('/reservations');
          break;
        case 'd':
          e.preventDefault();
          navigate('/');
          break;
        case 'g':
          e.preventDefault();
          navigate('/guests');
          break;
        case 't':
          e.preventDefault();
          toggle();
          break;
        case '?':
          e.preventDefault();
          setHelpOpen((o) => !o);
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, toggle, helpOpen]);

  if (!helpOpen) return null;
  return (
    <div className="modal-backdrop" onClick={() => setHelpOpen(false)}>
      <div className="modal" style={{ width: 380 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Keyboard shortcuts</h3>
          <button className="modal-close" onClick={() => setHelpOpen(false)}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="modal-body">
          {SHORTCUTS.map((s) => (
            <div
              key={s.label}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 0',
              }}
            >
              <span style={{ fontSize: 13 }}>{s.label}</span>
              <span>
                {s.keys.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </span>
            </div>
          ))}
          <div style={{ marginTop: 12, fontSize: 11, color: 'var(--muted)' }}>
            Shortcuts are ignored while typing in inputs, and while a training simulation or the 3D layout
            editor is open — those use their own keys (WASD to move, E to interact, L for mouse-look).
          </div>
        </div>
      </div>
    </div>
  );
}
