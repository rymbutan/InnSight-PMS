// Turning an instructor-authored scenario into the same three things the
// inspection already consumes: a case file, a layout, and tagged anchors.
//
// The procedural path builds those with applyDefects(); this builds them from
// stored data. Because both produce the identical shape, InspectionShift does
// not care which it got and inspectionScore.js needs no branch at all — an
// authored fault is graded through exactly the same code as a generated one.
//
// The clipboard booking is NOT one of the things a scenario stores. Both paths
// get it from buildClipboard() in caseFile.js, which prefers the room's real
// reservation.

import { DEFECT_IDS, buildClipboard } from './caseFile.js';
import { DEFECTS } from './defects.js';
import { getRoomPlan } from '../roomLayouts.js';
import { isKnownCategory } from './categories.js';
import { fitAddedToLayout } from './randomScenario.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Can this booking support this fault at all?
 *
 * The generated path has always asked this (see DEFECTS[].appliesTo) — it is why
 * a solo stay never gets an amenity shortfall. The authored path has to ask it
 * too now that the booking is the room's REAL reservation: a teacher tags twin
 * beds as `room_mismatch` for the couple they had in mind, then the scenario is
 * drawn for a room whose guest is travelling alone, and two twins for one person
 * is not a fault. Grading it would mark a student wrong for signing off a room
 * that is correct.
 *
 * A teacher-authored category carries no appliesTo and is always supportable —
 * no booking rules out a rat behind the wardrobe.
 */
function supportedBy(defectId, booking) {
  const d = DEFECTS.find((x) => x.id === defectId);
  if (!d || typeof d.appliesTo !== 'function') return true;
  return d.appliesTo(booking);
}

/**
 * Stable identity for a thing a scenario can point at.
 *
 * Objects the TEACHER added carry their own id. Fixtures that come from the tier
 * layout do not — and any id the editor stamps on them is regenerated on every
 * load, so it cannot survive a save. They are addressed by what they are and
 * where they stand instead, which also survives the furniture array being
 * reordered by a duplicate or a delete in the layout editor.
 *
 * The known cost of positional identity: MOVE a fixture in the layout editor and
 * a scenario tag pointing at it stops resolving. That is the accepted trade of
 * tracking the live layout rather than snapshotting it.
 */
export function refOf(item) {
  if (!item) return '';
  if (item.added && item.id) return item.id;
  const key = item.model || item.type || item.prim || 'item';
  return `${key}@${r2(item.pos?.[0])},${r2(item.pos?.[1])}`;
}

/**
 * Build the three things the inspection consumes — a case file, a layout and
 * tagged anchors — from an authored scenario.
 *
 * THE ROOM COMES FROM THE LIVE TIER LAYOUT. Scenarios used to store `furniture`
 * and read the shell from a `baseLayout` field that nothing ever wrote, so every
 * authored room rendered with w, l, h, floor, spawn and walls undefined: no
 * bathroom walls, and a shadow frustum sized from Math.max(undefined, undefined).
 * Now the shell and the base furniture are resolved from getRoomPlan(tier) at run
 * time, and the scenario contributes only what is WRONG with it — so editing a
 * room in the layout editor flows into every scenario for that tier.
 *
 * THE BOOKING COMES FROM THE ROOM'S REAL RESERVATION, never from the scenario.
 * `InspectionScenario.booking` still exists as a nullable column for rows written
 * when the Scenario Maker authored one, and nothing reads it: one scenario is
 * drawn for any room of its tier, so an authored guest name would be a guest
 * nobody booked, contradicting the PMS the student can go and check. With no
 * reservation at all — a Training practice drill has no room — buildClipboard()
 * invents one and flags it `fromReservation: false`.
 *
 * @param {object}   scenario     a row from /api/training/scenarios
 * @param {object}   [opts]
 * @param {function} [opts.rng]
 * @param {object}   [opts.plan]  the tier layout; injectable for tests
 * @param {object}   [opts.reservation] the room's real reservation, if any
 * @returns {{caseFile: object, layout: object, anchors: Array}}
 */
export function fromScenario(scenario, { rng = Math.random, plan = null, reservation = null } = {}) {
  const tier = scenario?.roomTier || 'Standard';
  const base = plan || getRoomPlan(tier);

  // A row written before scenarios tracked the layout stored a full furniture
  // snapshot. Honour it, but still give it the shell it never had.
  const legacy = Array.isArray(scenario?.furniture) && scenario.furniture.length > 0;

  let furniture;
  let fit = { moved: [], dropped: [] };
  if (legacy) {
    furniture = scenario.furniture;
  } else {
    const swaps = scenario?.swaps || {};
    furniture = (base.furniture || []).map((f) => {
      const to = swaps[refOf(f)];
      if (!to) return f;
      // An override may change the ASSET, its FACING and its SIZE — and nothing
      // else. `pos` is deliberately not settable: that is what stops a scenario
      // rearranging the room the teacher laid out, and stops a fault being placed
      // where it can wedge a student.
      //
      // Scale is uniform by construction (the editor only ever writes [s, s, s]).
      // These are Meshy exports with no reliable metric basis, and stretching one
      // on a single axis is glaringly visible — see MODEL_CFG in modelSizes.js.
      // Collision follows automatically: blockersOf() multiplies the box by the
      // scale, so what you bump into stays the thing you can see.
      if (typeof to === 'string') return { ...f, model: to, type: undefined };
      return {
        ...f,
        ...(to.model ? { model: to.model, type: undefined } : {}),
        ...(to.ry !== undefined ? { ry: to.ry } : {}),
        ...(to.scale ? { scale: to.scale } : {}),
        // `!== undefined`, not a truthy check: y: 0 is a real value — a
        // wall-mounted fixture pulled down to the floor — and a falsy test would
        // silently discard it and snap the fixture back up.
        ...(to.y !== undefined ? { y: to.y } : {}),
      };
    });
    // The layout is live, the scenario is a snapshot: re-check what it added
    // against the room as it is now (see fitAddedToLayout).
    fit = fitAddedToLayout(scenario?.added || [], base, scenario?.tags || []);
    for (const a of fit.added) furniture.push({ ...a, added: true });
  }

  // Index by the ref the fixture had BEFORE any override. refOf() derives from
  // the asset key, so a swapped bed answers to `messybed@…` rather than `bed@…`
  // — and every tag pointing at it would stop resolving the moment the teacher
  // swapped the asset, which is the first thing they do. Swap-then-tag is the
  // whole authoring loop, so the original ref is the stable one.
  const byRef = new Map();
  if (legacy) {
    for (const f of furniture) byRef.set(refOf(f), f);
  } else {
    const baseList = base.furniture || [];
    baseList.forEach((orig, i) => byRef.set(refOf(orig), furniture[i]));
    for (const f of furniture.slice(baseList.length)) byRef.set(refOf(f), f);
  }

  let anchors;
  if (legacy) {
    anchors = (scenario?.anchors || []).map((a) => ({
      ...a,
      // Built-in OR a registered teacher-authored category. Anything else has no
      // explanation to print, so it becomes a decoy.
      defectId: isKnownCategory(a.defectId) ? a.defectId : null,
    }));
  } else {
    anchors = [];
    for (const t of scenario?.tags || []) {
      const it = byRef.get(t.ref);
      if (!it) continue; // the fixture moved or went away — drop rather than mis-place
      anchors.push({
        id: `t_${t.ref}`,
        // A category the flag menu could not offer would be an unwinnable fault,
        // so an UNKNOWN one is demoted to a decoy. A teacher-authored category is
        // not unknown — it is registered from the shared library — and must
        // survive here, or custom categories could never be used at all.
        defectId: isKnownCategory(t.defectId) ? t.defectId : null,
        label: t.label || it.model || it.type || 'Item',
        pos: [...(it.pos || [0, 0])],
        size: t.size || [1.2, 1.4, 1.2],
        y: it.y,
      });
    }
  }

  // The booking first: which authored faults are real faults depends on it.
  const wanted = [...new Set(anchors.filter((a) => a.defectId).map((a) => a.defectId))];
  const booking = reservation
    ? buildClipboard({ roomTier: tier, rng, reservation })
    : practiceBooking(tier, rng, wanted);

  // Demote, never drop. The object stays in the room and stays clickable — it is
  // a decoy now, and signing it off clean is the correct call.
  for (const a of anchors) {
    if (a.defectId && !supportedBy(a.defectId, booking)) a.defectId = null;
  }

  const present = new Set(anchors.filter((a) => a.defectId).map((a) => a.defectId));
  // Built-ins first, in their canonical order, then any custom categories the
  // scenario tagged. Filtering DEFECT_IDS alone silently dropped every custom
  // category from `injected`, which is what made them ungradeable: the flag menu
  // offered them, the student picked one, and nothing was ever scored.
  const injected = [
    ...DEFECT_IDS.filter((id) => present.has(id)),
    ...[...present].filter((id) => !DEFECT_IDS.includes(id)),
  ];

  const caseFile = {
    ...booking,
    injected,
    scenarioId: scenario?.id || null,
    scenarioName: scenario?.name || null,
  };

  return {
    caseFile,
    layout: { ...base, furniture },
    anchors,
    // Props the live layout no longer had room for, so a caller can say so.
    fit: { moved: fit.moved, dropped: fit.dropped },
  };
}

// Parties that unlock a booking-relative fault: a couple (room_mismatch) and a
// family (amenity_math). No party satisfies both — twin beds for a couple needs
// pax 2 with no children, an amenity shortfall needs pax 3+ — so a scenario
// authoring both will always see one demoted, exactly as it would against a real
// reservation that can only be one or the other.
const PRACTICE_PARTIES = [
  { adults: 2, children: 0 },
  { adults: 2, children: 2 },
  { adults: 3, children: 0 },
];

/**
 * A booking for a drill with no room behind it — Training practice, and the
 * Scenario Maker's "preview as student".
 *
 * Invented, so it is invented to FIT: the random draw is tried first, and only
 * if it would defuse an authored fault are the shaped parties tried. Bending the
 * booking to the drill is the only honest direction — bending the drill to a
 * booking nobody made would delete the teacher's work at random.
 */
function practiceBooking(tier, rng, wanted) {
  const supported = (b) => wanted.filter((id) => supportedBy(id, b)).length;
  let best = buildClipboard({ roomTier: tier, rng });
  let bestScore = supported(best);
  for (const party of PRACTICE_PARTIES) {
    if (bestScore === wanted.length) break;
    const b = buildClipboard({ roomTier: tier, rng, party });
    const score = supported(b);
    if (score > bestScore) {
      best = b;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Pick one active scenario for a tier, or null to fall back to generation.
 * Authored scenarios JOIN the procedural pool rather than replacing it, so a
 * tier nobody has authored for still works and repeat plays still vary.
 */
export function pickScenario(scenarios, roomTier, rng = Math.random) {
  const usable = (scenarios || []).filter((s) => s && s.active !== false && s.roomTier === roomTier);
  if (!usable.length) return null;
  return usable[Math.floor(rng() * usable.length)];
}

/**
 * Faults and clean decoys in a payload about to be saved.
 *
 * The editor refuses a scenario with no faults (nothing to find) and warns about
 * one with no decoys (every clickable thing is a fault, so students learn to flag
 * whatever highlights). That check used to read `payload.anchors` directly — and
 * when scenarios moved to the tags overlay, anchors started going out empty, so
 * the count was always zero and every save was refused. Reading both shapes here,
 * under test, is what stops that recurring.
 */
export function scenarioCounts(payload) {
  const tagged = payload?.tags?.length ? payload.tags : payload?.anchors || [];
  return {
    faults: tagged.filter((t) => t && t.defectId).length,
    decoys: tagged.filter((t) => t && !t.defectId).length,
  };
}
