import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAP_ZOOM_MAX,
  MAP_ZOOM_MIN,
  minUserZoom,
  PITCH_MAX,
  PITCH_MIN,
  STICK_DEADZONE,
  applyLookDelta,
  clampPan,
  clampZoom,
  fitView,
  initialView,
  stickKnob,
  stickVector,
  touchDistance,
  touchMidpoint,
  wantsTouchControls,
  zoomAbout,
} from './touchInput.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ── Detection ───────────────────────────────────────────────────────────────

test('coarse pointer is what decides, not the user agent', () => {
  const mm = (matches) => (q) => ({ matches: q === '(pointer: coarse)' ? matches : false });
  assert.equal(wantsTouchControls({ matchMedia: mm(true) }), true);
  assert.equal(wantsTouchControls({ matchMedia: mm(false) }), false);
});

test('a touchscreen laptop with a precise pointer keeps the keyboard controls', () => {
  // The reason `ontouchstart`/maxTouchPoints is not the primary test: this
  // device reports many touch points AND a fine pointer. Handing it an
  // on-screen joystick would be worse than what it already has.
  const env = { matchMedia: (q) => ({ matches: q === '(pointer: fine)' }), maxTouchPoints: 10 };
  assert.equal(wantsTouchControls(env), false);
});

test('detection degrades rather than throwing when matchMedia is absent', () => {
  assert.equal(wantsTouchControls({ maxTouchPoints: 5 }), true);
  assert.equal(wantsTouchControls({ maxTouchPoints: 0 }), false);
  assert.equal(wantsTouchControls({}), false);
  assert.equal(wantsTouchControls(null), false);
  assert.equal(wantsTouchControls(undefined), false);
});

// ── Joystick ────────────────────────────────────────────────────────────────

test('a thumb resting near the centre produces no movement', () => {
  // Without a dead zone a finger held still drifts the player, because a touch
  // point is never exactly stationary.
  const r = 50;
  assert.deepEqual(stickVector(0, 0, r), { x: 0, y: 0, mag: 0 });
  const inside = stickVector(r * (STICK_DEADZONE - 0.01), 0, r);
  assert.equal(inside.mag, 0);
  assert.equal(inside.x, 0);
  assert.equal(inside.y, 0);
});

test('pushing the stick fully forward is full speed forward', () => {
  // Screen y grows downward, so "up" is a negative dy and must come back as
  // POSITIVE forward. Getting this backwards inverts the controls.
  const v = stickVector(0, -50, 50);
  assert.ok(near(v.y, 1), `forward ${v.y}`);
  assert.ok(near(v.x, 0));
  assert.ok(near(v.mag, 1));

  const back = stickVector(0, 50, 50);
  assert.ok(near(back.y, -1), `back ${back.y}`);
});

test('pushing right is strafe-right, not turn', () => {
  const v = stickVector(50, 0, 50);
  assert.ok(near(v.x, 1), `strafe ${v.x}`);
  assert.ok(near(v.y, 0));
});

test('a diagonal push is not faster than a straight one', () => {
  // The classic virtual-stick bug: normalising each axis separately makes
  // diagonals 1.41x faster, and the stick feels wrong in a way nobody can name.
  const straight = stickVector(0, -50, 50);
  const diagonal = stickVector(35.36, -35.36, 50);
  assert.ok(near(diagonal.mag, straight.mag, 1e-3), `${diagonal.mag} vs ${straight.mag}`);
  assert.ok(Math.hypot(diagonal.x, diagonal.y) <= 1 + 1e-9);
});

test('dragging past the ring keeps the direction and drops the excess', () => {
  const atEdge = stickVector(50, 0, 50);
  const wayOut = stickVector(500, 0, 50);
  assert.ok(near(wayOut.mag, atEdge.mag), 'magnitude is capped at the ring');
  assert.ok(near(wayOut.x, atEdge.x), 'direction is unchanged');

  // And a far diagonal still points diagonally rather than snapping to an axis.
  // Up-and-right is forward AND strafe-right, so both components are positive
  // and equal.
  const farDiag = stickVector(400, -400, 50);
  assert.ok(farDiag.x > 0 && farDiag.y > 0, `${farDiag.x}, ${farDiag.y}`);
  assert.ok(near(farDiag.x, farDiag.y, 1e-9), 'stays on the diagonal');
  assert.ok(Math.hypot(farDiag.x, farDiag.y) <= 1 + 1e-9);
});

test('magnitude ramps from the dead-zone edge rather than jumping', () => {
  // If mag were `frac` directly, the stick would snap to 16% speed the moment
  // it engaged. It should start from a standstill.
  const r = 100;
  const justEngaged = stickVector(r * (STICK_DEADZONE + 0.001), 0, r);
  assert.ok(justEngaged.mag > 0 && justEngaged.mag < 0.02, `got ${justEngaged.mag}`);
  assert.ok(near(stickVector(r, 0, r).mag, 1));
});

test('a zero or negative radius cannot produce NaN', () => {
  for (const r of [0, -10]) {
    const v = stickVector(5, 5, r);
    assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.mag), `radius ${r}`);
  }
});

test('the drawn knob never leaves the dial', () => {
  assert.deepEqual(stickKnob(10, 10, 50), { x: 10, y: 10 });
  const k = stickKnob(500, 0, 50);
  assert.ok(near(Math.hypot(k.x, k.y), 50), `clamped to ${Math.hypot(k.x, k.y)}`);
  assert.deepEqual(stickKnob(0, 0, 50), { x: 0, y: 0 });
});

// ── Look drag ───────────────────────────────────────────────────────────────

test('dragging right turns the view left, matching the mouse path', () => {
  // Dragging the world right means the camera swings the other way; this is the
  // same sign convention Player uses for movementX, and the two inputs must not
  // disagree.
  const { yaw } = applyLookDelta(0, 0, 100, 0, 0.01);
  assert.ok(yaw < 0, `yaw ${yaw}`);
});

test('pitch cannot pass vertical however hard it is dragged', () => {
  const up = applyLookDelta(0, 0, 0, -100000, 0.01);
  assert.equal(up.pitch, PITCH_MAX);
  const down = applyLookDelta(0, 0, 0, 100000, 0.01);
  assert.equal(down.pitch, PITCH_MIN);
});

test('yaw is unbounded so a full turn is one continuous motion', () => {
  let yaw = 0;
  for (let i = 0; i < 100; i += 1) yaw = applyLookDelta(yaw, 0, 100, 0, 0.01).yaw;
  assert.ok(Math.abs(yaw) > 6.28, `wrapped or clamped: ${yaw}`);
});

// ── Pinch / pan ─────────────────────────────────────────────────────────────

test('zoom is clamped to a usable range and never NaN', () => {
  assert.equal(clampZoom(1000), MAP_ZOOM_MAX);
  assert.equal(clampZoom(0.01), MAP_ZOOM_MIN);
  assert.equal(clampZoom(Number.NaN), 1);
  // A runaway gesture pegs at the end of the range; snapping back to 1 would be
  // a zoom the user never asked for.
  assert.equal(clampZoom(Number.POSITIVE_INFINITY), MAP_ZOOM_MAX);
  assert.equal(clampZoom(Number.NEGATIVE_INFINITY), MAP_ZOOM_MIN);
  assert.equal(clampZoom(2), 2);
});

test('pinch geometry: distance and midpoint', () => {
  const a = { clientX: 0, clientY: 0 };
  const b = { clientX: 30, clientY: 40 };
  assert.equal(touchDistance(a, b), 50);
  assert.deepEqual(touchMidpoint(a, b), { x: 15, y: 20 });
});

test('the point under a pinch stays under the pinch', () => {
  // The bug this prevents: scaling about the element origin slides the content
  // out from under the fingers, so the map appears to flee the gesture.
  const view = { x: 0, y: 0, z: 1 };
  const anchor = { x: 300, y: 200 };
  const contentBefore = { x: (anchor.x - view.x) / view.z, y: (anchor.y - view.y) / view.z };

  const next = zoomAbout(view, 2.5, anchor);
  const contentAfter = { x: (anchor.x - next.x) / next.z, y: (anchor.y - next.y) / next.z };

  assert.ok(near(contentBefore.x, contentAfter.x, 1e-6), `${contentBefore.x} vs ${contentAfter.x}`);
  assert.ok(near(contentBefore.y, contentAfter.y, 1e-6));
});

test('zooming about a point respects the zoom clamp', () => {
  const out = zoomAbout({ x: 0, y: 0, z: 1 }, 99, { x: 10, y: 10 });
  assert.equal(out.z, MAP_ZOOM_MAX);
});

test('the map cannot be flicked completely out of view', () => {
  const viewport = { w: 800, h: 500 };
  const content = { w: 1200, h: 700 };
  const far = clampPan({ x: 99999, y: 99999, z: 1 }, viewport, content);
  // Some of the drawing is still on screen from the left/top edge.
  assert.ok(far.x <= viewport.w, `x ${far.x}`);
  assert.ok(far.y <= viewport.h, `y ${far.y}`);

  const farNeg = clampPan({ x: -99999, y: -99999, z: 1 }, viewport, content);
  assert.ok(farNeg.x >= -content.w, `x ${farNeg.x}`);
  assert.ok(farNeg.y >= -content.h, `y ${farNeg.y}`);
});

test('clampPan leaves an in-bounds view untouched and keeps the zoom', () => {
  const v = { x: 10, y: 20, z: 1.5 };
  const out = clampPan(v, { w: 800, h: 500 }, { w: 1200, h: 700 });
  assert.deepEqual(out, v);
});

test('fitView centres the whole drawing in the panel', () => {
  // 1600 wide into an 800 panel needs z = 0.48, BELOW the interactive
  // MAP_ZOOM_MIN of 0.6. Clamping the fit at that floor left a wide floor plan
  // unable to be shown whole, which is the one job "fit" has.
  const viewport = { w: 800, h: 600 };
  const content = { w: 1600, h: 600 };
  const v = fitView(viewport, content);
  // Scaled to fit the limiting axis, with the padding respected.
  assert.ok(content.w * v.z <= viewport.w, 'fits horizontally');
  assert.ok(content.h * v.z <= viewport.h, 'fits vertically');
  // Centred: the margins either side are equal.
  assert.ok(near(v.x, (viewport.w - content.w * v.z) / 2, 1e-9));
  assert.ok(near(v.y, (viewport.h - content.h * v.z) / 2, 1e-9));
});

test('fitView degrades to identity when nothing has been measured yet', () => {
  // The panel's size is read from the DOM, so the first render has zeroes.
  assert.deepEqual(fitView({ w: 0, h: 0 }, { w: 0, h: 0 }), { x: 0, y: 0, z: 1 });
  assert.deepEqual(fitView({ w: 800, h: 600 }, { w: 0, h: 500 }), { x: 0, y: 0, z: 1 });
});

// ── Initial open (distinct from the "Fit" button) ──────────────────────────

test('a tall, many-floor property opens legible, not crushed to fit the height', () => {
  // The bug this documents: a 12-floor property (a realistic hotel — see
  // scripts/seed-hotel-map-filler.mjs) is roughly 980x3970 content. `.pz-host`
  // on a tablet is height-capped to at most 560px (styles.css). fitView takes
  // the SMALLER of the width and height ratios to show everything at once,
  // and here that is the height ratio — z ~ 0.13, shrinking a 96px-min room
  // down to about 13px, illegible on the very first thing anyone sees.
  const viewport = { w: 700, h: 560 };
  const content = { w: 980, h: 3970 };
  const whole = fitView(viewport, content);
  const opened = initialView(viewport, content);
  assert.ok(opened.z > whole.z * 4, `opened at ${opened.z}, whole-property fit was ${whole.z}`);
  // Width-fit, same as fitView would compute if height were not the limiter.
  assert.ok(near(opened.z, (viewport.w - 32) / content.w, 1e-9));
});

test('initialView anchors to the top of the drawing (floor 1 first), not centred', () => {
  const viewport = { w: 700, h: 560 };
  const content = { w: 980, h: 3970 };
  const v = initialView(viewport, content, 16);
  assert.equal(v.y, 16);
});

test('initialView does not blow a sparse property up past native size', () => {
  // A panel wider than the drawing should open it at 1:1, not stretched to
  // fill the width — the desktop map already renders at native size for
  // exactly this reason (see .hk-map in styles.css).
  const viewport = { w: 1400, h: 900 };
  const content = { w: 500, h: 400 };
  assert.equal(initialView(viewport, content).z, 1);
});

test('initialView degrades to identity when nothing has been measured yet', () => {
  assert.deepEqual(initialView({ w: 0, h: 0 }, { w: 0, h: 0 }), { x: 0, y: 0, z: 1 });
  assert.deepEqual(initialView({ w: 800, h: 600 }, { w: 0, h: 500 }), { x: 0, y: 0, z: 1 });
});

test('a drawing wider than its panel can still be pinched back out to fit', () => {
  // minUserZoom drops to the fit when that is smaller than the interactive
  // floor, so the view the map OPENS at is always one the user can return to.
  const viewport = { w: 800, h: 600 };
  const wide = { w: 1600, h: 600 };
  assert.ok(minUserZoom(viewport, wide) <= fitView(viewport, wide).z + 1e-9);
  // A small drawing does not raise the floor above the normal minimum.
  assert.equal(minUserZoom(viewport, { w: 200, h: 150 }), MAP_ZOOM_MIN);
});
