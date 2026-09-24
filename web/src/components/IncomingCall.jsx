import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api';
import Icon from './Icon';
import { useAuth } from '../auth';
import { useToast } from './Toast';
import { useLiveEvents, channels } from '../lib/useLiveEvents';

// ─────────────────────────────────────────────────────────────────────────────
// The simulated internal phone line between the front desk and housekeeping.
//
// Mounted once in the app shell, so it rings wherever the housekeeper happens to
// be in the app rather than only on one page — that is the whole point of a call
// as opposed to a notification: it interrupts.
//
// Both ends live here. Housekeeping sees the handset; the desk that placed the
// call sees the answer come back. Which end you are is decided by your role and
// by whether the call is yours, never by a prop.
// ─────────────────────────────────────────────────────────────────────────────

// How long the desk waits before reporting silence. Long enough for somebody to
// put down a mop and cross a corridor, short enough that a clerk with a guest at
// the counter is not left guessing.
const RING_OUT_MS = 30000;

const REASON_LABEL = {
  CLEANING: 'Room needs cleaning',
  TURNDOWN: 'Turndown service',
  LINENS: 'Fresh linens',
  SPILL: 'Spill / urgent clean',
  INSPECTION: 'Ready for inspection',
  OTHER: 'Housekeeping needed',
};

// Canned replies, each carrying the answer it implies. Tapping one both
// answers the call AND tells the desk something more useful than a plain
// "accepted" — the plain Accept/Decline buttons stay for a call that just
// needs a fast tap with nothing more to say.
const QUICK_REPLIES = [
  { accepted: true, text: "Sure, I'll look into it." },
  { accepted: true, text: 'On my way.' },
  { accepted: false, text: "Sorry, I'm busy — can you assign it to someone else?" },
  { accepted: false, text: 'Not available right now.' },
];

// A two-tone ring, synthesised rather than shipped as an audio file: a .mp3
// would be another asset to load, and the CSP on this app blocks media from
// anywhere but its own origin anyway. Built on demand and torn down on answer,
// so nothing holds an AudioContext open between calls.
function useRinger() {
  const ctxRef = useRef(null);
  const timerRef = useRef(null);

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (ctxRef.current) {
      try {
        ctxRef.current.close();
      } catch {
        /* already closed — nothing to do */
      }
      ctxRef.current = null;
    }
  }, []);

  const start = useCallback(() => {
    stop();
    let ctx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
    } catch {
      // Autoplay policy, or no audio device. The visual ring is the part that
      // matters; sound is an enhancement and must never break the call.
      return;
    }
    ctxRef.current = ctx;
    const burst = () => {
      if (!ctxRef.current) return;
      [0, 0.4].forEach((offset) => {
        const t0 = ctx.currentTime + offset;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 480;
        // Ramped, not switched: a square-edged gate on a sine is an audible
        // click at both ends.
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.34);
      });
    };
    burst();
    timerRef.current = setInterval(burst, 2400);
  }, [stop]);

  useEffect(() => stop, [stop]);
  return { start, stop };
}

export default function IncomingCall() {
  const { user, hasRole } = useAuth();
  const toast = useToast();
  const ringer = useRinger();
  // The call currently ringing on THIS screen, if any.
  const [call, setCall] = useState(null);
  const [busy, setBusy] = useState(false);
  // Calls this tab placed, so an answer for somebody else's call is ignored.
  const mine = useRef(new Set());
  // Pending ring-out timers, cleared when a call is answered or on unmount.
  const ringOuts = useRef(new Map());

  const canAnswer = hasRole('HOUSEKEEPING_MAINTENANCE', 'ADMIN', 'MANAGER');

  const onEvent = useCallback(
    (name, data) => {
      if (name === 'housekeeping:call_placed') {
        if (!canAnswer) return;
        // Never ring the person who placed it. An admin is on both audiences,
        // and without this they call themselves.
        if (data.callerId && data.callerId === user?.id) return;
        // Belt-and-suspenders on top of the server's own per-connection
        // targeting (services/inventory/src/index.js directedTargetOf): every
        // call now has a targetUserId (unassigned rooms can no longer be
        // called), so a frame that somehow reaches this screen for someone
        // else's room must not ring here either.
        if (data.targetUserId && data.targetUserId !== user?.id) return;
        setCall(data);
        return;
      }
      if (name === 'housekeeping:call_answered') {
        // Only the desk that dialled hears the answer.
        if (!mine.current.has(data.callId)) return;
        mine.current.delete(data.callId);
        // Answered, so the ring-out must not also fire.
        clearTimeout(ringOuts.current.get(data.callId));
        ringOuts.current.delete(data.callId);
        const who = data.answeredByName || 'Housekeeping';
        // A quick-reply message says more than "accepted"/"declined" ever
        // could, so it replaces the generic line rather than sitting next to it.
        const generic = data.accepted
          ? `${who} accepted the call${data.roomNumber ? ` for room ${data.roomNumber}` : ''}.`
          : `${who} declined the call${data.roomNumber ? ` for room ${data.roomNumber}` : ''}.`;
        const line = data.replyMessage ? `${who}: “${data.replyMessage}”` : generic;
        if (data.accepted) toast.success(line);
        else toast.error(line);
      }
    },
    [canAnswer, toast, user?.id]
  );

  useLiveEvents(onEvent, channels('housekeeping'));

  // Ring while a call is on screen; silence it the moment it is gone, including
  // on unmount (sign-out mid-ring must not leave a tone playing).
  useEffect(() => {
    if (call) ringer.start();
    else ringer.stop();
  }, [call, ringer]);

  async function answer(accepted, replyMessage = null) {
    if (!call) return;
    setBusy(true);
    try {
      await api.post(`/api/housekeeping-calls/${call.callId}/answer`, {
        accepted,
        roomNumber: call.roomNumber,
        callerId: call.callerId,
        replyMessage,
      });
      // Closed on the local decision, not on the round trip: the handset must
      // stop ringing when you press the button, even if the answer-back fails.
      setCall(null);
    } catch {
      setCall(null);
      toast.error('Could not tell the desk — the call was closed here anyway.');
    } finally {
      setBusy(false);
    }
  }

  // Exposed so the desk side can register a call it placed. Kept on window
  // rather than in context because the caller is a page, the receiver is the
  // shell, and threading a provider between them for one Set is more machinery
  // than the feature is worth.
  useEffect(() => {
    window.__innsightTrackCall = (callId, targetName) => {
      mine.current.add(callId);
      // Ring-out. A DIRECTED call reaches exactly one person, so if that person
      // is off shift or signed out it reaches nobody at all — and without this
      // the desk waits on a call that was never going to be answered. Silence
      // has to be reported, not left to look like it is still ringing.
      const timer = setTimeout(() => {
        if (!mine.current.has(callId)) return; // already answered
        mine.current.delete(callId);
        toast.error(
          targetName
            ? `No answer from ${targetName}. Unassign the room to ring the whole team.`
            : 'No answer from housekeeping.'
        );
      }, RING_OUT_MS);
      ringOuts.current.set(callId, timer);
    };
    return () => {
      delete window.__innsightTrackCall;
      for (const t of ringOuts.current.values()) clearTimeout(t);
      ringOuts.current.clear();
    };
  }, [toast]);

  if (!call) return null;

  return (
    <div className="call-backdrop" role="dialog" aria-modal="true" aria-label="Incoming call">
      <div className="call-card">
        <div className="call-pulse">
          <Icon name="phone" size={30} />
        </div>
        <div className="call-from">Incoming call</div>
        <div className="call-name">{call.callerName}</div>
        <div className="call-room">Room {call.roomNumber}</div>
        <div className="call-reason">{REASON_LABEL[call.reason] || REASON_LABEL.OTHER}</div>
        {call.note && <p className="call-note">“{call.note}”</p>}
        <div className="call-actions">
          <button className="call-btn call-decline" onClick={() => answer(false)} disabled={busy}>
            <Icon name="phone-off" size={16} />
            Decline
          </button>
          <button className="call-btn call-accept" onClick={() => answer(true)} disabled={busy}>
            <Icon name="phone" size={16} />
            Accept
          </button>
        </div>
        <div className="call-quick-replies">
          <div className="call-quick-replies-label">Or send a reply</div>
          <div className="call-quick-replies-list">
            {QUICK_REPLIES.map((r) => (
              <button
                key={r.text}
                type="button"
                className={`call-quick-reply ${r.accepted ? 'is-accept' : 'is-decline'}`}
                onClick={() => answer(r.accepted, r.text)}
                disabled={busy}
              >
                {r.text}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
