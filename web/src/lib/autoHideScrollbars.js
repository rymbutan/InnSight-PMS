// Scrollbars are invisible until something actually scrolls, then fade back out.
//
// CSS alone cannot express "while scrolling" — there is no :scrolling selector
// and no scroll-driven equivalent that works on the scrollbar pseudo-elements.
// So the styling lives in styles.css (thumb transparent by default, coloured
// under .is-scrolling) and this adds that class for as long as scrolling is
// happening.
//
// ONE capture-phase listener on the document, not a listener per scroll
// container. Scroll events do not bubble, but they do pass through the capture
// phase, so a single listener sees scrolling in every pane — including panes
// that mount long after this runs, which a per-element approach would miss.
//
// The gutter width is reserved permanently in CSS and only the THUMB changes
// colour. Collapsing the gutter instead would reflow the pane's content every
// time a scroll started and stopped.

const HIDE_AFTER_MS = 900;

// Keyed weakly so a detached pane's timer does not pin the element in memory.
const timers = new WeakMap();

export function installAutoHideScrollbars() {
  if (typeof document === 'undefined') return;

  document.addEventListener(
    'scroll',
    (e) => {
      // Scrolling the page itself reports `document` as the target, but the
      // class has to go on <html> — that is the element with the scrollbar.
      const el = e.target === document || e.target === window ? document.documentElement : e.target;
      if (!el || !el.classList) return;

      el.classList.add('is-scrolling');
      clearTimeout(timers.get(el));
      timers.set(
        el,
        setTimeout(() => el.classList.remove('is-scrolling'), HIDE_AFTER_MS)
      );
    },
    // capture: reaches non-bubbling scroll events from any depth.
    // passive: never blocks the scroll it is observing.
    { capture: true, passive: true }
  );
}
