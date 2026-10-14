import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { stickKnob, stickVector } from '../lib/touchInput';

// ─────────────────────────────────────────────────────────────────────────────
// On-screen controls for the first-person room views, on touch devices.
//
// WHY: the room walk was keyboard-and-mouse only, and not as a preference —
// movement read WASD, looking used the Pointer Lock API. A tablet has neither.
// `requestPointerLock` on iPadOS either rejects or resolves and then reports no
// `movementX` at all, so an iPad rendered the room perfectly and could not move
// through it or look around. Inert, not degraded.
//
// THE LAYOUT, AND WHY IT IS THIS WAY ROUND
//  • A full-surface drag layer BEHIND everything: one finger anywhere on the
//    room looks around, which is what people already expect from every
//    first-person app on a phone.
//  • The stick is FLOATING: it does not exist until a finger lands on the LEFT
//    half of the room, and then it appears centred under that finger. Each
//    pointer is tracked by its own pointerId, so a thumb walking on the left
//    and a finger looking around on the right work at the same time. A fixed
//    corner stick made people reach for it; this puts it wherever the thumb is.
//  • An action button bottom-right, because "tap the thing you are looking at"
//    is ambiguous when tapping is also how you look: a drag that happens to end
//    where it started would fire an interaction nobody asked for. A tap on the
//    view still interacts, but only below a movement threshold — the button is
//    the unambiguous way.
//
// EVERY HANDLER IS A POINTER EVENT, not a touch event. Pointer events carry
// mouse, pen and touch in one API, give per-pointer capture for free, and are
// what lets the same component serve a stylus on a Surface without a branch.
// ─────────────────────────────────────────────────────────────────────────────

// Travel of the stick in CSS pixels — the dial is twice this across, and kept in
// sync with `.touch-stick`'s width in styles.css: the maths clamps to this, the
// ring is drawn from that, and if they disagree the knob leaves the dial.
const STICK_RADIUS = 52;

// A pointer that travels further than this between down and up was a look
// drag, not a tap, so it must not also interact with whatever is under it.
const TAP_SLOP_PX = 10;

/**
 * @param {object}   props
 * @param {React.MutableRefObject} props.inputRef
 *        Shared mutable input state, read once per frame by the 3D Player:
 *        `{ move: {x, y}, look: {dx, dy} }`. A ref rather than state on
 *        purpose — a joystick updates at pointer-move rate, and putting that
 *        through React would re-render the whole overlay dozens of times a
 *        second to move one circle.
 * @param {() => void} props.onInteract  the action button, and a tap on the view
 * @param {boolean}  props.disabled      paused, or a dialog is open over the room
 * @param {string}   props.actionLabel   what the action button says it does
 * @param {boolean}  props.actionEnabled whether anything is in range to act on
 */
export default function TouchControls({
  inputRef,
  onInteract,
  disabled = false,
  actionLabel = 'Inspect',
  actionEnabled = true,
}) {
  // Redrawing the knob is the only thing that needs React here, and it is
  // deliberately the ONLY thing: `inputRef` carries the numbers the renderer
  // consumes, this carries the pixels the eye consumes.
  const [knob, setKnob] = useState(null);
  // Where the floating stick is drawn, in the controls layer's own CSS pixels;
  // null while no finger is driving it, which is also what hides it.
  const [stickPos, setStickPos] = useState(null);

  const layerRef = useRef(null);
  const stickPointer = useRef(null);
  const stickOrigin = useRef({ x: 0, y: 0 });

  const lookPointer = useRef(null);
  const lookLast = useRef({ x: 0, y: 0 });
  const lookStart = useRef({ x: 0, y: 0 });
  const lookMoved = useRef(0);

  const zero = useCallback(() => {
    if (inputRef.current) inputRef.current.move = { x: 0, y: 0 };
    setKnob(null);
    setStickPos(null);
    stickPointer.current = null;
  }, [inputRef]);

  // Releasing on pause is not optional. A thumb held on the stick when a dialog
  // opens would otherwise leave a movement vector in the ref for ever, and the
  // player walks into a wall for as long as the dialog is up.
  useEffect(() => {
    if (disabled) zero();
  }, [disabled, zero]);

  // Client pixels -> the layer's own CSS pixels. The app runs under `zoom` on
  // <html>, so a `left`/`top` set on a child is scaled a second time; the ratio
  // of the layer's drawn width to its layout width is exactly that factor,
  // whatever it is and however the browser reports it.
  function layerSpace(e) {
    const r = layerRef.current.getBoundingClientRect();
    const scale = layerRef.current.offsetWidth ? r.width / layerRef.current.offsetWidth : 1;
    return {
      x: (e.clientX - r.left) / scale,
      y: (e.clientY - r.top) / scale,
      w: r.width / scale,
      h: r.height / scale,
    };
  }

  // ── The stick ─────────────────────────────────────────────────────────────
  function stickDown(e, p) {
    // Centred where the thumb landed, nudged inboard if that would put the dial
    // off the edge of the room. The origin is the dial's centre, not the touch
    // point, so a clamped landing still registers as a push away from it.
    const cx = Math.min(Math.max(p.x, STICK_RADIUS), p.w - STICK_RADIUS);
    const cy = Math.min(Math.max(p.y, STICK_RADIUS), p.h - STICK_RADIUS);
    stickOrigin.current = { x: cx, y: cy };
    stickPointer.current = e.pointerId;
    setStickPos({ x: cx, y: cy });
    stickMove(e);
  }

  function stickMove(e) {
    if (stickPointer.current !== e.pointerId || disabled) return;
    const p = layerSpace(e);
    const dx = p.x - stickOrigin.current.x;
    const dy = p.y - stickOrigin.current.y;
    if (inputRef.current) inputRef.current.move = stickVector(dx, dy, STICK_RADIUS);
    setKnob(stickKnob(dx, dy, STICK_RADIUS));
  }

  // ── The look surface ──────────────────────────────────────────────────────
  function lookDown(e) {
    if (disabled) return;
    // Left half drives the floating stick, right half looks — unless the stick
    // is already held, in which case a second finger is a look wherever it is.
    const p = layerSpace(e);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (p.x < p.w / 2 && stickPointer.current === null) {
      stickDown(e, p);
      return;
    }
    if (lookPointer.current !== null) return;
    lookPointer.current = e.pointerId;
    lookLast.current = { x: e.clientX, y: e.clientY };
    lookStart.current = { x: e.clientX, y: e.clientY };
    lookMoved.current = 0;
  }

  function lookMove(e) {
    if (stickPointer.current === e.pointerId) {
      stickMove(e);
      return;
    }
    if (lookPointer.current !== e.pointerId || disabled) return;
    const dx = e.clientX - lookLast.current.x;
    const dy = e.clientY - lookLast.current.y;
    lookLast.current = { x: e.clientX, y: e.clientY };
    lookMoved.current = Math.max(
      lookMoved.current,
      Math.hypot(e.clientX - lookStart.current.x, e.clientY - lookStart.current.y)
    );
    // ACCUMULATED, not replaced. Pointer-move can fire several times between two
    // animation frames, and overwriting would throw away all but the last of
    // them — the camera would lag behind a fast sweep and stop short of where
    // the finger went. The Player adds these up and zeroes them each frame.
    if (inputRef.current) {
      inputRef.current.look.dx += dx;
      inputRef.current.look.dy += dy;
    }
  }

  function lookUp(e) {
    if (stickPointer.current === e.pointerId) {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      zero();
      return;
    }
    if (lookPointer.current !== e.pointerId) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    lookPointer.current = null;
    // A drag is a look; only something that stayed put is a tap meant to act.
    if (!disabled && lookMoved.current <= TAP_SLOP_PX) onInteract?.();
  }

  return (
    <div className="touch-controls" data-disabled={disabled || undefined}>
      {/* Behind the controls, over the canvas. `touch-action: none` in the
          stylesheet is load-bearing: without it the browser claims the gesture
          for scrolling and pull-to-refresh, and pointermove stops arriving
          mid-drag — the camera turns a little and then sticks. */}
      <div
        className="touch-look"
        ref={layerRef}
        onPointerDown={lookDown}
        onPointerMove={lookMove}
        onPointerUp={lookUp}
        onPointerCancel={lookUp}
        aria-hidden="true"
      />

      {/* Purely visual: the look layer owns the pointer for the stick too. */}
      {stickPos && (
        <div
          className="touch-stick"
          style={{ left: stickPos.x - STICK_RADIUS, top: stickPos.y - STICK_RADIUS }}
          aria-hidden="true"
        >
          <span className="touch-stick-ring">
            <Icon name="move" size={18} strokeWidth={1.9} />
          </span>
          <span
            className={`touch-stick-knob${knob ? ' is-active' : ''}`}
            style={knob ? { transform: `translate(${knob.x}px, ${knob.y}px)` } : undefined}
          />
        </div>
      )}

      <button
        type="button"
        className="touch-action"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => onInteract?.()}
        disabled={disabled || !actionEnabled}
      >
        <Icon name="mouse-pointer" size={16} strokeWidth={2} />
        {actionLabel}
      </button>
    </div>
  );
}

/** The shape `inputRef` holds. Exported so the 3D side builds it the same way
 *  rather than guessing at the field names. */
export function makeTouchInput() {
  return { move: { x: 0, y: 0 }, look: { dx: 0, dy: 0 } };
}
