import { useEffect, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Touch input: deciding when to offer it, and the maths behind the controls.
//
// WHY THE 3D VIEWS NEEDED THIS AT ALL
// -----------------------------------
// The first-person room walk was keyboard-and-mouse only, and not by
// preference — structurally. Movement read WASD and the arrow keys; looking
// around used the Pointer Lock API. A tablet has neither: there is no key to
// hold, and `requestPointerLock` either rejects or resolves and then reports no
// `movementX` at all. So on an iPad the room loaded, rendered perfectly, and
// could not be moved through or looked around. Not degraded — inert.
//
// The floor map had the quieter version of the same problem: it is an SVG whose
// room tooltips were bound to mouseenter/mouseleave, so on touch they either
// never appeared or appeared and stuck.
//
// PURE FIRST. Everything below the detection hook is arithmetic with no DOM and
// no React, so the joystick's dead zone, its clamping and the pinch maths are
// testable — touchInput.test.js does exactly that. The bug that made this
// necessary was invisible to the build, and geometry is the part most likely to
// be quietly wrong.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Does this device want touch controls?
 *
 * The test is `pointer: coarse` — "the primary input is imprecise" — rather
 * than sniffing the user agent or testing for `ontouchstart`:
 *
 *  • A user-agent string cannot be trusted and iPadOS deliberately reports
 *    itself as a Mac, so UA sniffing gets iPads exactly wrong.
 *  • `'ontouchstart' in window` is true on every touch-capable laptop, which
 *    would hand a precise mouse an on-screen joystick it does not need.
 *
 * `pointer: coarse` asks the right question and the browser answers it. A
 * touchscreen laptop with a trackpad reports `fine` and keeps the keyboard
 * controls; an iPad reports `coarse` and gets the sticks.
 *
 * @param {{matchMedia?: Function, maxTouchPoints?: number}} env  injected for tests
 */
export function wantsTouchControls(env) {
  if (!env) return false;
  const coarse = env.matchMedia?.('(pointer: coarse)')?.matches;
  if (coarse === true) return true;
  // `matchMedia` missing entirely (very old browser, or a test double that did
  // not supply it): fall back to whether the hardware reports touch points at
  // all. Never used on anything current.
  if (coarse === undefined && typeof env.maxTouchPoints === 'number') return env.maxTouchPoints > 0;
  return false;
}

/** Live `pointer: coarse`, so plugging in a mouse or docking a tablet swaps the
 *  controls without a reload. The query genuinely re-evaluates: an iPad with a
 *  Magic Keyboard trackpad attached flips to `fine`. */
export function useCoarsePointer() {
  const [coarse, setCoarse] = useState(() =>
    typeof window === 'undefined'
      ? false
      : wantsTouchControls({
          matchMedia: window.matchMedia.bind(window),
          maxTouchPoints: navigator.maxTouchPoints,
        })
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(pointer: coarse)');
    const on = (e) => setCoarse(e.matches);
    setCoarse(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return coarse;
}

// ── Joystick ────────────────────────────────────────────────────────────────

/** Below this fraction of the stick's radius the thumb is treated as centred.
 *  Without it a finger resting on the stick drifts the camera continuously,
 *  because a touch point is never exactly still. */
export const STICK_DEADZONE = 0.16;

/**
 * Thumb offset from the stick's centre → a movement vector.
 *
 * @param {number} dx  pixels right of centre
 * @param {number} dy  pixels below centre
 * @param {number} radius  the stick's travel in pixels
 * @returns {{x: number, y: number, mag: number}}
 *   `x` is strafe (+right), `y` is forward (+forward, so the screen's -dy),
 *   both in -1..1. `mag` is 0..1 for how far the stick is pushed.
 *
 * CLAMPED TO THE CIRCLE, NOT THE SQUARE. Normalising each axis on its own would
 * make a diagonal push 1.41× faster than a straight one, which is the classic
 * way a virtual stick ends up feeling wrong without anyone being able to say
 * why. Past the edge the vector keeps its DIRECTION and loses the excess
 * length, so dragging beyond the ring does not steer differently from the ring.
 */
export function stickVector(dx, dy, radius, deadzone = STICK_DEADZONE) {
  const r = radius > 0 ? radius : 1;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: 0, y: 0, mag: 0 };
  const frac = Math.min(1, len / r);
  if (frac < deadzone) return { x: 0, y: 0, mag: 0 };
  // Rescale so the vector ramps from 0 at the dead-zone edge to 1 at the ring,
  // instead of jumping to `deadzone` the instant it engages.
  const mag = (frac - deadzone) / (1 - deadzone);
  const ux = dx / len;
  const uy = dy / len;
  return { x: ux * mag, y: -uy * mag, mag };
}

/** Where to draw the thumb: the offset clamped to the ring, so it never leaves
 *  the dial however far the finger travels. */
export function stickKnob(dx, dy, radius) {
  const len = Math.hypot(dx, dy);
  if (len <= radius || len === 0) return { x: dx, y: dy };
  return { x: (dx / len) * radius, y: (dy / len) * radius };
}

// ── Look drag ───────────────────────────────────────────────────────────────

/** Radians of camera rotation per pixel dragged. Lower than the mouse's
 *  sensitivity because a finger sweeps far further than a mouse does, and a
 *  1:1 mapping spins the room. */
export const TOUCH_LOOK_SENS = 0.0042;

/**
 * A drag delta → a new yaw/pitch.
 *
 * Yaw is unbounded so a full turn is one continuous motion; pitch is clamped
 * short of vertical, or the room ends up upside down. Same limits as the mouse
 * path in RoomFreeRoam's Player, deliberately — the two inputs must not have
 * different ideas of how far up you can look.
 */
export const PITCH_MIN = -1.2;
export const PITCH_MAX = 1.0;

export function applyLookDelta(yaw, pitch, dx, dy, sens = TOUCH_LOOK_SENS) {
  return {
    yaw: yaw - dx * sens,
    pitch: Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch - dy * sens)),
  };
}

// ── Pinch / pan, for the 2D floor map ───────────────────────────────────────

/** How far the map may be zoomed. Below 1 the drawing is smaller than its own
 *  panel, which only ever loses detail; 4× is where room labels stop gaining. */
export const MAP_ZOOM_MIN = 0.6;
export const MAP_ZOOM_MAX = 4;

/** The floor `fitView` is allowed to reach. Separate from MAP_ZOOM_MIN, which
 *  is a limit on what the USER may pinch down to; a fit is computed, and a wide
 *  property's plan legitimately needs to go below the interactive minimum to be
 *  shown whole. Clamping the fit at MAP_ZOOM_MIN meant a 45-room floor could
 *  never be seen in one view, which is the one thing "fit" has to do. */
export const MAP_FIT_MIN = 0.08;

export function clampZoom(z, min = MAP_ZOOM_MIN, max = MAP_ZOOM_MAX) {
  // NaN, not "not finite": ±Infinity should peg at the ends, because that is a
  // runaway gesture and the honest answer is "as far as it goes". Resetting it
  // to 1 would snap the map back to a zoom the user never asked for.
  if (Number.isNaN(z) || typeof z !== 'number') return 1;
  return Math.max(min, Math.min(max, z));
}

/** Distance between two touch points, for pinch. */
export function touchDistance(a, b) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/** Midpoint of two touch points, the anchor a pinch zooms about. */
export function touchMidpoint(a, b) {
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

/**
 * Zoom about a fixed screen point.
 *
 * The naive version scales around the element's origin, which slides whatever
 * the user was pinching off toward a corner — the content appears to run away
 * from the fingers. Anchoring means the point under the pinch stays under the
 * pinch, which is the whole of what makes a pinch feel attached to the map.
 *
 * @param {{x: number, y: number, z: number}} view  current pan offset and zoom
 * @param {number} nextZoom  the requested new zoom (clamped by the caller)
 * @param {{x: number, y: number}} anchor  the screen point to hold still,
 *        relative to the viewport's top-left
 */
export function zoomAbout(view, nextZoom, anchor) {
  const z = clampZoom(nextZoom);
  // The content coordinate currently under the anchor.
  const cx = (anchor.x - view.x) / view.z;
  const cy = (anchor.y - view.y) / view.z;
  // Put that same content coordinate back under the anchor at the new zoom.
  return { x: anchor.x - cx * z, y: anchor.y - cy * z, z };
}

/**
 * Keep the drawing overlapping its viewport.
 *
 * Unbounded panning lets someone flick the whole floor plan off-screen and be
 * left staring at an empty panel with no way back but a reset button they have
 * to find. This always leaves a margin of the content in view on every side.
 */
export function clampPan(view, viewport, content, margin = 80) {
  const w = content.w * view.z;
  const h = content.h * view.z;
  return {
    ...view,
    x: Math.min(viewport.w - margin, Math.max(margin - w, view.x)),
    y: Math.min(viewport.h - margin, Math.max(margin - h, view.y)),
  };
}

/** The pan/zoom that fits the content in the viewport, centred — what the reset
 *  control returns to and what the map opens at. */
export function fitView(viewport, content, pad = 16) {
  if (!content.w || !content.h || !viewport.w || !viewport.h) return { x: 0, y: 0, z: 1 };
  const z = clampZoom(
    Math.min((viewport.w - pad * 2) / content.w, (viewport.h - pad * 2) / content.h),
    MAP_FIT_MIN
  );
  return { x: (viewport.w - content.w * z) / 2, y: (viewport.h - content.h * z) / 2, z };
}

/** How far the user may pinch out: the interactive floor, or the fit if the
 *  drawing is wider than that allows. Without this a large property opens
 *  fitted and then cannot be returned to that view by hand. */
export function minUserZoom(viewport, content) {
  return Math.min(MAP_ZOOM_MIN, fitView(viewport, content).z);
}
