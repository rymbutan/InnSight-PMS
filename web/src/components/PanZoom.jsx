import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Icon from './Icon';
import {
  MAP_ZOOM_MAX,
  clampPan,
  clampZoom,
  fitView,
  initialView,
  minUserZoom,
  touchDistance,
  touchMidpoint,
  zoomAbout,
} from '../lib/touchInput';

// ─────────────────────────────────────────────────────────────────────────────
// Drag to pan, pinch to zoom — for the floor map on a touch device.
//
// WHAT IT REPLACES, AND ONLY WHERE
// The housekeeping map is an SVG drawn at its native size inside a
// horizontally-scrolling div. On a mouse that is fine: the wheel scrolls it and
// a 45-room property runs off to the right until you scroll. On a tablet it is
// close to unusable — a one-finger drag over the drawing is claimed by the page
// (or by pull-to-refresh), there is no way to zoom the thing that matters, and
// the room tooltips were bound to mouseenter/mouseleave so they either never
// appeared or appeared and stuck.
//
// So this is `enabled` ONLY on a coarse pointer. Desktop keeps the native
// scroll it already had, unchanged, because nothing was wrong with it and
// swapping a working interaction for a new one is how you break the people who
// were not complaining.
//
// A DRAG MUST NOT ALSO SELECT. The rooms underneath are clickable, and a pan
// that starts on a room would otherwise both move the map and open that room's
// panel. The gesture is classified on release — travel under the slop is a tap
// and passes through, over it is a pan and the click that follows is swallowed
// in the capture phase, before the SVG ever sees it.
//
// The arithmetic — clamping, anchored zoom, fit — is in lib/touchInput.js with
// tests. What lives here is only the event plumbing.
// ─────────────────────────────────────────────────────────────────────────────

const TAP_SLOP_PX = 8;
const ZOOM_STEP = 1.45;

export default function PanZoom({ enabled, contentW, contentH, className = '', label = 'Map', children }) {
  const hostRef = useRef(null);
  const [view, setView] = useState({ x: 0, y: 0, z: 1 });
  const [viewport, setViewport] = useState({ w: 0, h: 0 });

  // Live gesture state. Refs, not state: these change on every pointermove and
  // none of them is rendered — putting them through React would re-render the
  // whole map on each frame of a drag.
  const drag = useRef(null);
  const pinch = useRef(null);
  const swallowClick = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;

  const content = { w: contentW || 0, h: contentH || 0 };

  // Measure the host, and keep measuring: the panel's width changes when the
  // sidebar collapses, when a tablet rotates, and when the detail panel below
  // grows. A one-off measurement on mount would leave the fit wrong after any
  // of those.
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el || !enabled) return undefined;
    const measure = () => setViewport({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [enabled]);

  // The explicit "Fit" button only — shows the WHOLE property, however small
  // that makes a many-floor one. NOT used to open the map; see the effect
  // below.
  const fit = useCallback(() => {
    setView(fitView(viewport, content));
  }, [viewport.w, viewport.h, content.w, content.h]);

  // Open at a legible, width-fit size instead of fitView's whole-property
  // fit — a real property is commonly many floors stacked, and fitting all of
  // them into `.pz-host`'s capped height (worst on a tablet) crushed every
  // room tile down with it, illegible on the very first thing anyone saw. See
  // initialView's own comment. Re-opens the same way when the drawing itself
  // changes size (a floor added, a property seeded), which is a different
  // drawing rather than the same one moved.
  useEffect(() => {
    if (enabled && viewport.w && content.w) setView(initialView(viewport, content));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, viewport.w, viewport.h, content.w, content.h]);

  const applyZoom = useCallback(
    (factor, anchor) => {
      const v = viewRef.current;
      const a = anchor || { x: viewport.w / 2, y: viewport.h / 2 };
      const floor = minUserZoom(viewport, content);
      const next = clampZoom(v.z * factor, floor, MAP_ZOOM_MAX);
      setView(clampPan(zoomAbout(v, next, a), viewport, content));
    },
    [viewport.w, viewport.h, content.w, content.h]
  );

  function onPointerDown(e) {
    if (!enabled) return;
    const host = hostRef.current;
    // A second finger does not need handling here: the pinch listener below
    // runs on the native touch events, and its `touchstart` clears this drag
    // the moment two points are down. Pinch is tracked there rather than from
    // pointer ids because the midpoint and the span need BOTH points at once,
    // and a pointer event only ever carries one of them.
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0, from: viewRef.current };
    host.setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e) {
    if (!enabled || !drag.current || drag.current.id !== e.pointerId) return;
    if (pinch.current) return; // a pinch owns the gesture; ignore the stray finger
    const d = drag.current;
    d.moved = Math.max(d.moved, Math.hypot(e.clientX - d.x, e.clientY - d.y));
    if (d.moved <= TAP_SLOP_PX) return; // still possibly a tap — do not move yet
    const next = {
      ...d.from,
      x: d.from.x + (e.clientX - d.x),
      y: d.from.y + (e.clientY - d.y),
    };
    setView(clampPan(next, viewport, content));
  }

  function onPointerUp(e) {
    if (!enabled || !drag.current || drag.current.id !== e.pointerId) return;
    hostRef.current?.releasePointerCapture?.(e.pointerId);
    // Over the slop it was a pan, so the click that the browser is about to
    // synthesise must not reach the room under the finger.
    swallowClick.current = drag.current.moved > TAP_SLOP_PX;
    drag.current = null;
  }

  // Capture phase, so this runs BEFORE the SVG's own click handlers rather than
  // after they have already opened a room.
  useEffect(() => {
    const el = hostRef.current;
    if (!el || !enabled) return undefined;
    const onClickCapture = (ev) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      ev.stopPropagation();
      ev.preventDefault();
    };
    el.addEventListener('click', onClickCapture, true);
    return () => el.removeEventListener('click', onClickCapture, true);
  }, [enabled]);

  // Pinch, on the native touch events. Registered non-passive because it calls
  // preventDefault: iOS Safari otherwise takes a two-finger gesture as a page
  // zoom and the map never sees it.
  useEffect(() => {
    const el = hostRef.current;
    if (!el || !enabled) return undefined;

    const start = (ev) => {
      if (ev.touches.length !== 2) return;
      drag.current = null;
      const [a, b] = [ev.touches[0], ev.touches[1]];
      pinch.current = { dist: touchDistance(a, b), from: viewRef.current };
    };
    const move = (ev) => {
      if (!pinch.current || ev.touches.length !== 2) return;
      ev.preventDefault();
      const [a, b] = [ev.touches[0], ev.touches[1]];
      const dist = touchDistance(a, b);
      if (pinch.current.dist <= 0) return;
      const mid = touchMidpoint(a, b);
      const r = el.getBoundingClientRect();
      const anchor = { x: mid.x - r.left, y: mid.y - r.top };
      const floor = minUserZoom({ w: el.clientWidth, h: el.clientHeight }, content);
      const target = clampZoom(pinch.current.from.z * (dist / pinch.current.dist), floor, MAP_ZOOM_MAX);
      setView(
        clampPan(
          zoomAbout(pinch.current.from, target, anchor),
          { w: el.clientWidth, h: el.clientHeight },
          content
        )
      );
    };
    const end = (ev) => {
      if (ev.touches.length < 2) pinch.current = null;
    };

    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end, { passive: true });
    el.addEventListener('touchcancel', end, { passive: true });
    return () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
    };
  }, [enabled, content.w, content.h]);

  // Not enabled: render the children exactly as they were, in the scrolling
  // container this replaces. No wrapper, no transform, no new behaviour.
  if (!enabled) return <div className={className}>{children}</div>;

  return (
    <div className="pz-host" ref={hostRef} aria-label={label}>
      <div
        className="pz-surface"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          className="pz-content"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}
        >
          {children}
        </div>
      </div>

      <div className="pz-tools">
        <button type="button" onClick={() => applyZoom(ZOOM_STEP)} aria-label="Zoom in" title="Zoom in">
          <Icon name="plus" size={16} strokeWidth={2.2} />
        </button>
        <button type="button" onClick={() => applyZoom(1 / ZOOM_STEP)} aria-label="Zoom out" title="Zoom out">
          <Icon name="minus" size={16} strokeWidth={2.2} />
        </button>
        <button type="button" onClick={fit} aria-label="Fit the whole map" title="Fit">
          <Icon name="maximize" size={15} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
