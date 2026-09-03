// Validation for instructor-authored inspection scenarios.
//
// Pure and React-free so it can be unit-tested directly, and so the rules that
// decide whether a scenario is gradeable live in one place rather than being
// spread through the route handler.
//
// The rule that actually matters is DEFECT_IDS: an anchor tagged with an id the
// student's flag menu does not offer is a fault that can never be matched, so
// the run would be unwinnable in a way nobody could diagnose from the UI. It is
// rejected at write time rather than discovered by a student mid-inspection.

const ROOM_TIERS = ['Standard', 'Deluxe', 'Suite', 'Presidential'];

// Must stay in step with web/src/sim/inspection/categories.js BUILTIN_CATEGORIES.
const DEFECT_IDS = [
  'room_mismatch',
  'amenity_math',
  'blocked_path',
  'lingering_equipment',
  'lived_in',
  'incomplete_stock',
];

// A teacher may add categories of their own — "Pest or sanitation hazard" is the
// one that prompted it. Custom ids are namespaced so they can never shadow a
// built-in, and so a tag can be recognised as custom without shipping the
// scenario's category list alongside every request.
// Must stay in step with web/src/sim/inspection/categories.js.
const CUSTOM_ID_RE = /^custom_[A-Za-z0-9_-]{1,48}$/;
const isCustomId = (id) => typeof id === 'string' && CUSTOM_ID_RE.test(id);
const labelKey = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * @param {object} body
 * @param {boolean} [partial] true for PATCH: only validate the keys present
 * @returns {{ok: true, data: object} | {ok: false, error: string}}
 */
// A scenario may resize a fixture, but only within reason: 0 or a negative flips
// or vanishes the mesh, and a large multiple can swallow the room and seal a
// student in. Uniformity is enforced by the editor, which only ever writes
// [s, s, s]; this is the backstop against a hand-written payload.
// Height off the floor. Slightly negative is allowed — a rug or a mattress may
// need to sit a hair under the floor plane to avoid z-fighting — but burying a
// fixture or floating it above a 3 m ceiling is a mistake, not an intention.
const Y_MIN = -0.5;
const Y_MAX = 6;
function badY(v) {
  if (v === undefined) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'y must be a number.';
  if (v < Y_MIN || v > Y_MAX) return `y must be between ${Y_MIN} and ${Y_MAX}.`;
  return null;
}

const SCALE_MIN = 0.1;
const SCALE_MAX = 10;
function badScale(v) {
  if (v === undefined) return null;
  if (!Array.isArray(v) || v.length !== 3 || v.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    return 'scale must be three numbers.';
  }
  if (v.some((n) => n < SCALE_MIN || n > SCALE_MAX)) {
    return `scale must be between ${SCALE_MIN} and ${SCALE_MAX}.`;
  }
  return null;
}

function validateScenario(body, partial = false) {
  const out = {};
  const has = (k) => body[k] !== undefined;

  if (has('name') || !partial) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return { ok: false, error: 'name is required.' };
    }
    out.name = body.name.trim();
  }

  if (has('roomTier') || !partial) {
    if (!ROOM_TIERS.includes(body.roomTier)) {
      return { ok: false, error: `roomTier must be one of ${ROOM_TIERS.join(', ')}.` };
    }
    out.roomTier = body.roomTier;
  }

  if (has('active')) {
    if (typeof body.active !== 'boolean') return { ok: false, error: 'active must be a boolean.' };
    out.active = body.active;
  }

  // ── booking: optional, and only a fallback ────────────────────────────────
  // A scenario used to REQUIRE the guest it was wrong for, and that authored
  // guest was what the student read — so a room could be inspected against a
  // booking nobody made. The clipboard now comes from the real reservation on
  // the room the scenario is assigned to.
  //
  // A teacher may still write one, and every field is optional. It fills only
  // what the reservation is silent about, which in practice means previewing
  // your own authoring or a drill with no room behind it. Half-filled is a
  // legitimate state: naming the guest and leaving the party alone is a
  // sensible thing to want, so nothing here is mandatory. Values that ARE sent
  // are still checked — a booking for -3 adults is a mistake, not a preference.
  if (has('booking') && body.booking !== null) {
    const b = body.booking;
    if (typeof b !== 'object' || Array.isArray(b)) {
      return { ok: false, error: 'booking must be an object.' };
    }
    const out_b = {};

    if (typeof b.guestName === 'string' && b.guestName.trim()) out_b.guestName = b.guestName.trim();

    // '' and null both mean "left blank", which is not the same as a bad number.
    const wants = (v) => v !== undefined && v !== null && v !== '';
    if (wants(b.adults)) {
      const adults = Number(b.adults);
      if (!Number.isInteger(adults) || adults < 1) {
        return { ok: false, error: 'booking.adults must be a whole number of at least 1.' };
      }
      out_b.adults = adults;
    }
    if (wants(b.children)) {
      const children = Number(b.children);
      if (!Number.isInteger(children) || children < 0) {
        return { ok: false, error: 'booking.children must be a whole number of 0 or more.' };
      }
      out_b.children = children;
    }
    // A party stated in halves is how a room authored for a couple gets rendered
    // against a family: caseFile.js takes the party WHOLE from whichever source
    // states it, so `children` with no `adults` would be dropped in silence.
    if (out_b.children !== undefined && out_b.adults === undefined) {
      return { ok: false, error: 'booking.children needs booking.adults set as well.' };
    }
    if (typeof b.specialRequests === 'string' && b.specialRequests.trim()) {
      out_b.specialRequests = b.specialRequests.trim();
    }

    // An entirely blank form is stored as null rather than as {}: "the teacher
    // wrote no booking" and "the teacher wrote an empty one" are the same thing,
    // and one of the two spellings would otherwise reach caseFile.js as a
    // fallback object that answers nothing.
    out.booking = Object.keys(out_b).length ? out_b : null;
  } else if (has('booking')) {
    out.booking = null;
  }

  if (has('furniture') || !partial) {
    if (!Array.isArray(body.furniture)) return { ok: false, error: 'furniture must be an array.' };
    out.furniture = body.furniture;
  }

  if (has('anchors') || !partial) {
    if (!Array.isArray(body.anchors)) return { ok: false, error: 'anchors must be an array.' };
    for (const a of body.anchors) {
      if (!a || typeof a !== 'object') return { ok: false, error: 'each anchor must be an object.' };
      if (!Array.isArray(a.pos) || a.pos.length !== 2 || a.pos.some((n) => typeof n !== 'number')) {
        return { ok: false, error: 'each anchor needs a numeric [x, z] pos.' };
      }
      // null is a legitimate value: a clean decoy the student may inspect and
      // correctly sign off. Anything else must be a category the flag menu offers.
      if (a.defectId !== null && a.defectId !== undefined && !DEFECT_IDS.includes(a.defectId) && !isCustomId(a.defectId)) {
        return { ok: false, error: `unknown defectId "${a.defectId}".` };
      }
    }
    out.anchors = body.anchors;
  }

  // ── Overlay: what is WRONG with the live tier layout ──────────────────────
  // A scenario no longer snapshots the room. It names the fixtures whose ASSET
  // or FACING differ, the objects the teacher added, and what is wrong with
  // each. Position is deliberately absent from `swaps`: a scenario may not move
  // a fixture, because that changes the room the teacher laid out and can wedge
  // a student against real geometry.
  if (has('swaps')) {
    const sw = body.swaps;
    if (!sw || typeof sw !== 'object' || Array.isArray(sw)) {
      return { ok: false, error: 'swaps must be an object.' };
    }
    for (const [ref, v] of Object.entries(sw)) {
      if (!ref) return { ok: false, error: 'a swap needs a ref.' };
      if (typeof v === 'string') continue;
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        return { ok: false, error: `swap "${ref}" must be a model key or an object.` };
      }
      if (v.model !== undefined && typeof v.model !== 'string') {
        return { ok: false, error: `swap "${ref}" has a non-string model.` };
      }
      if (v.ry !== undefined && typeof v.ry !== 'number') {
        return { ok: false, error: `swap "${ref}" has a non-numeric ry.` };
      }
      const sErr = badScale(v.scale) || badY(v.y);
      if (sErr) return { ok: false, error: `swap "${ref}": ${sErr}` };
    }
    out.swaps = sw;
  }

  if (has('added')) {
    if (!Array.isArray(body.added)) return { ok: false, error: 'added must be an array.' };
    for (const a of body.added) {
      if (!a || typeof a !== 'object') return { ok: false, error: 'each added object must be an object.' };
      if (!a.id) return { ok: false, error: 'each added object needs an id.' };
      // Primitive boxes are gone from the product: they read as placeholder art
      // beside photoscanned furniture, and a student cannot judge a room whose
      // faults look unfinished. Existing rows are stripped at load; new writes
      // are refused here so none can be created again.
      if (a.prim && !a.model) {
        return {
          ok: false,
          error: 'primitive shapes are no longer supported — place a model instead.',
        };
      }
      if (!a.model) return { ok: false, error: 'each added object needs a model.' };
      if (!Array.isArray(a.pos) || a.pos.length !== 2 || a.pos.some((n) => typeof n !== 'number')) {
        return { ok: false, error: 'each added object needs a numeric [x, z] pos.' };
      }
      const aErr = badScale(a.scale) || badY(a.y);
      if (aErr) return { ok: false, error: `added object "${a.id}": ${aErr}` };
    }
    out.added = body.added;
  }

  // ── Categories the teacher typed ──────────────────────────────────────────
  // Six built-in categories cannot describe every fault a property cares about,
  // and a category that only half-exists is worse than none: the flag menu would
  // offer it while grading had no explanation to print, so the student would be
  // marked wrong with a blank reason. `why` is therefore required, not optional.
  if (has('categories')) {
    if (!Array.isArray(body.categories)) return { ok: false, error: 'categories must be an array.' };
    const ids = new Set();
    const labels = new Set();
    const cats = [];
    for (const c of body.categories) {
      if (!c || typeof c !== 'object') return { ok: false, error: 'each category must be an object.' };
      if (!isCustomId(c.id)) {
        return { ok: false, error: `category id "${c.id}" must look like custom_<slug>.` };
      }
      if (ids.has(c.id)) return { ok: false, error: `duplicate category id "${c.id}".` };
      const label = typeof c.label === 'string' ? c.label.trim() : '';
      const why = typeof c.why === 'string' ? c.why.trim() : '';
      if (!label) return { ok: false, error: `category "${c.id}" needs a label.` };
      if (!why) {
        return {
          ok: false,
          error: `category "${label}" needs a "why" — it is the reason shown to the student after grading.`,
        };
      }
      const lk = labelKey(label);
      if (labels.has(lk)) return { ok: false, error: `two categories are both named "${label}".` };
      ids.add(c.id);
      labels.add(lk);
      cats.push({
        id: c.id,
        label,
        why,
        feedback: typeof c.feedback === 'string' && c.feedback.trim() ? c.feedback.trim() : null,
      });
    }
    out.categories = cats;
  }

  // A tag may name a built-in category or one this scenario declares. When the
  // payload carries its own category list, a tag naming an id that is not in it
  // is rejected outright: it would render as an unwinnable fault, because the
  // flag menu could never offer a category the scenario does not define.
  const declared = out.categories
    ? new Set(out.categories.map((c) => c.id))
    : null;
  const knownId = (id) => DEFECT_IDS.includes(id) || (declared ? declared.has(id) : isCustomId(id));

  if (has('tags')) {
    if (!Array.isArray(body.tags)) return { ok: false, error: 'tags must be an array.' };
    for (const t of body.tags) {
      if (!t || typeof t !== 'object') return { ok: false, error: 'each tag must be an object.' };
      if (!t.ref || typeof t.ref !== 'string') return { ok: false, error: 'each tag needs a ref.' };
      // null is legitimate: a clean decoy the student may inspect and sign off.
      if (t.defectId !== null && t.defectId !== undefined && !knownId(t.defectId)) {
        return { ok: false, error: `unknown defectId "${t.defectId}".` };
      }
      // What the object looks like close up, shown while the student inspects it.
      // Capped because it renders in a fixed panel beside the flag options: a
      // wall of text would push the answers off the bottom of it.
      if (t.condition !== undefined && t.condition !== null) {
        if (typeof t.condition !== 'string') {
          return { ok: false, error: 'a tag condition must be text.' };
        }
        if (t.condition.length > 400) {
          return { ok: false, error: 'a tag condition must be 400 characters or fewer.' };
        }
      }
    }
    out.tags = body.tags;
  }

  return { ok: true, data: out };
}

module.exports = { validateScenario, ROOM_TIERS, DEFECT_IDS, isCustomId };
