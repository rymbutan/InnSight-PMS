const test = require('node:test');
const assert = require('node:assert');

const { validateScenario } = require('./scenarioValidation');

const good = () => ({
  name: 'Couple in a twin room',
  roomTier: 'Standard',
  booking: { guestName: 'Dela Cruz, Maria', adults: 2, children: 0, specialRequests: 'Honeymoon.' },
  furniture: [{ model: 'twin', pos: [-1, -2], ry: 0 }],
  anchors: [{ id: 'a1', label: 'Beds', defectId: 'room_mismatch', pos: [0, -2], size: [2, 1, 2] }],
});

test('accepts a well-formed scenario and trims its text', () => {
  const r = validateScenario({ ...good(), name: '  Trim me  ' });
  assert.equal(r.ok, true);
  assert.equal(r.data.name, 'Trim me');
  assert.equal(r.data.booking.guestName, 'Dela Cruz, Maria');
});

test('requires a name', () => {
  const r = validateScenario({ ...good(), name: '   ' });
  assert.equal(r.ok, false);
  assert.match(r.error, /name/i);
});

test('rejects a room tier the sim cannot render', () => {
  const r = validateScenario({ ...good(), roomTier: 'Penthouse' });
  assert.equal(r.ok, false);
  assert.match(r.error, /roomTier/);
});

test('rejects an anchor tagged with a category the flag menu does not offer', () => {
  // This is the important one: such a fault could never be matched by a
  // student, so the run would be unwinnable with no way to tell why.
  const s = good();
  s.anchors = [{ id: 'a1', label: 'Beds', defectId: 'bed_is_ugly', pos: [0, 0] }];
  const r = validateScenario(s);
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown defectId/);
});

test('allows a null defectId — that is a clean decoy, not an error', () => {
  const s = good();
  s.anchors = [{ id: 'c1', label: 'Wardrobe', defectId: null, pos: [1, 1] }];
  assert.equal(validateScenario(s).ok, true);
});

test('requires a numeric [x, z] position on every anchor', () => {
  const s = good();
  s.anchors = [{ id: 'a1', label: 'Beds', defectId: null, pos: ['a', 2] }];
  const r = validateScenario(s);
  assert.equal(r.ok, false);
  assert.match(r.error, /pos/);
});

test('rejects impossible party sizes', () => {
  const zero = validateScenario({ ...good(), booking: { guestName: 'X', adults: 0, children: 0 } });
  assert.equal(zero.ok, false);
  const neg = validateScenario({ ...good(), booking: { guestName: 'X', adults: 2, children: -1 } });
  assert.equal(neg.ok, false);
});

test('normalises blank special requests to null', () => {
  const r = validateScenario({
    ...good(),
    booking: { guestName: 'X', adults: 1, children: 0, specialRequests: '   ' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.data.booking.specialRequests, null);
});

test('a partial update validates only what it was given', () => {
  const r = validateScenario({ active: false }, true);
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { active: false });
});

test('a partial update still rejects a bad value it was given', () => {
  const r = validateScenario({ roomTier: 'Nope' }, true);
  assert.equal(r.ok, false);
});

test('a full create rejects missing furniture or anchors', () => {
  const s = good();
  delete s.furniture;
  assert.equal(validateScenario(s).ok, false);
});

// ── Overlay fields: scenarios track the live tier layout ────────────────────
// A scenario no longer snapshots the room. It stores what is WRONG with it, so
// editing a room in the layout editor flows into every scenario for that tier.

const overlay = () => ({
  ...good(),
  furniture: [],
  anchors: [],
  swaps: { 'bed@0,-3.4': 'messybed' },
  added: [{ id: 'a1', model: 'cleaningcart', pos: [1, 1], ry: 0 }],
  tags: [{ ref: 'bed@0,-3.4', defectId: 'lived_in', label: 'Bed' }],
});

test('accepts an overlay scenario with empty legacy arrays', () => {
  const r = validateScenario(overlay());
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data.swaps, { 'bed@0,-3.4': 'messybed' });
  assert.equal(r.data.added.length, 1);
  assert.equal(r.data.tags.length, 1);
});

test('accepts a swap that carries a rotation as well as an asset', () => {
  const s = overlay();
  s.swaps = { 'bed@0,-3.4': { model: 'messybed', ry: 1.57 } };
  assert.equal(validateScenario(s).ok, true);
});

test('rejects a tag naming a category the flag menu does not offer', () => {
  // Same rule as anchors: an unmatched category is a fault no student can win.
  const s = overlay();
  s.tags = [{ ref: 'bed@0,-3.4', defectId: 'not_a_category' }];
  const r = validateScenario(s);
  assert.equal(r.ok, false);
  assert.match(r.error, /not_a_category/);
});

test('accepts a null tag — a deliberate clean decoy', () => {
  const s = overlay();
  s.tags = [{ ref: 'bed@0,-3.4', defectId: null, label: 'Bed' }];
  assert.equal(validateScenario(s).ok, true);
});

test('rejects a tag with no ref, which could never resolve to an object', () => {
  const s = overlay();
  s.tags = [{ defectId: 'lived_in' }];
  assert.equal(validateScenario(s).ok, false);
});

test('rejects an added object without a numeric [x, z] pos', () => {
  const s = overlay();
  s.added = [{ id: 'a1', model: 'cleaningcart', pos: ['x', 1] }];
  assert.equal(validateScenario(s).ok, false);
});

test('rejects non-object swaps, added and tags', () => {
  for (const bad of [{ swaps: [] }, { added: {} }, { tags: {} }]) {
    assert.equal(validateScenario({ ...overlay(), ...bad }).ok, false, JSON.stringify(bad));
  }
});

test('the overlay fields are optional — a legacy row still validates', () => {
  const r = validateScenario(good());
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.swaps, undefined);
});

test('accepts a swap carrying a uniform scale', () => {
  const s = overlay();
  s.swaps = { 'bed@0,-3.4': { model: 'messybed', scale: [1.5, 1.5, 1.5] } };
  assert.equal(validateScenario(s).ok, true);
});

test('rejects a scale that is not three numbers', () => {
  for (const bad of [[1, 1], 'big', [1, 1, 'x'], []]) {
    const s = overlay();
    s.swaps = { 'bed@0,-3.4': { scale: bad } };
    assert.equal(validateScenario(s).ok, false, JSON.stringify(bad));
  }
});

test('rejects a scale of zero or a negative — it would invert or vanish the mesh', () => {
  for (const bad of [[0, 0, 0], [-1, -1, -1]]) {
    const s = overlay();
    s.swaps = { 'bed@0,-3.4': { scale: bad } };
    assert.equal(validateScenario(s).ok, false, JSON.stringify(bad));
  }
});

test('rejects an absurd scale that would swallow the room', () => {
  const s = overlay();
  s.swaps = { 'bed@0,-3.4': { scale: [50, 50, 50] } };
  assert.equal(validateScenario(s).ok, false);
});

test('accepts a scale on an added object', () => {
  const s = overlay();
  s.added = [{ id: 'a1', model: 'cleaningcart', pos: [1, 1], scale: [2, 2, 2] }];
  assert.equal(validateScenario(s).ok, true);
});

test('rejects a bad scale on an added object too', () => {
  const s = overlay();
  s.added = [{ id: 'a1', model: 'cleaningcart', pos: [1, 1], scale: [0, 1, 1] }];
  assert.equal(validateScenario(s).ok, false);
});

test('accepts a swap carrying a height', () => {
  const s = overlay();
  s.swaps = { 'bed@0,-3.4': { y: 1.4 } };
  assert.equal(validateScenario(s).ok, true);
});

test('accepts a height of exactly zero', () => {
  const s = overlay();
  s.swaps = { 'bed@0,-3.4': { y: 0 } };
  assert.equal(validateScenario(s).ok, true, 'y: 0 is a real value, not "unset"');
});

test('rejects a non-numeric height', () => {
  const s = overlay();
  s.swaps = { 'bed@0,-3.4': { y: 'high' } };
  assert.equal(validateScenario(s).ok, false);
});

test('rejects a height that buries a fixture or floats it above the ceiling', () => {
  for (const bad of [-3, 12]) {
    const s = overlay();
    s.swaps = { 'bed@0,-3.4': { y: bad } };
    assert.equal(validateScenario(s).ok, false, String(bad));
  }
});

test('rejects a bad height on an added object', () => {
  const s = overlay();
  s.added = [{ id: 'a1', model: 'cleaningcart', pos: [1, 1], y: 99 }];
  assert.equal(validateScenario(s).ok, false);
});

// ── The booking is no longer authored ───────────────────────────────────────

test('a scenario saves with no booking at all', () => {
  // The case file now comes from the real reservation on the room. A scenario
  // that still demanded its own guest would be demanding a guest nobody can use.
  const r = validateScenario({
    name: 'Turned over badly',
    roomTier: 'Standard',
    furniture: [],
    anchors: [],
    tags: [{ ref: 'bed@0,-3', defectId: 'lived_in' }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.data.booking, undefined);
});

test('an explicit null booking is accepted, so a row can be cleared', () => {
  const r = validateScenario({ name: 'n', roomTier: 'Standard', furniture: [], anchors: [], booking: null });
  assert.equal(r.ok, true);
});

const withBooking = (booking) => ({
  name: 'n', roomTier: 'Standard', furniture: [], anchors: [], booking,
});

test('a half-filled booking is fine — every field is optional', () => {
  // Naming the guest and leaving the party alone is a sensible thing to want:
  // the reservation supplies the rest, and this only fills its silences.
  const r = validateScenario(withBooking({ guestName: 'Dela Cruz, Maria' }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.booking, { guestName: 'Dela Cruz, Maria' });
});

test('an entirely blank booking form is stored as no booking at all', () => {
  // "Wrote nothing" and "wrote an empty one" are the same intent; storing {}
  // would reach the case file as a fallback that answers nothing.
  const r = validateScenario(withBooking({ guestName: '   ', adults: '', children: '', specialRequests: '' }));
  assert.equal(r.ok, true);
  assert.equal(r.data.booking, null);
});

test('values that ARE supplied are still checked', () => {
  // Optional is not the same as unchecked: -3 adults is a mistake.
  assert.equal(validateScenario(withBooking({ adults: -3 })).ok, false);
  assert.equal(validateScenario(withBooking({ adults: 2.5 })).ok, false);
  assert.equal(validateScenario(withBooking({ adults: 2, children: -1 })).ok, false);
  assert.equal(validateScenario(withBooking('nope')).ok, false);
});

test('a party stated in halves is refused rather than silently dropped', () => {
  // The case file takes the party WHOLE from whichever source states it, so
  // children with no adults would vanish without a word.
  const r = validateScenario(withBooking({ children: 2 }));
  assert.equal(r.ok, false);
  assert.match(r.error, /adults/);
});

test('a complete authored booking still round-trips', () => {
  const r = validateScenario(
    withBooking({ guestName: ' Reyes, Ana ', adults: 2, children: 2, specialRequests: '  Cot needed. ' })
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.booking, {
    guestName: 'Reyes, Ana',
    adults: 2,
    children: 2,
    specialRequests: 'Cot needed.',
  });
});

// ── Primitive boxes ─────────────────────────────────────────────────────────

test('a primitive box can no longer be saved', () => {
  const r = validateScenario({
    name: 'n',
    roomTier: 'Standard',
    furniture: [],
    anchors: [],
    added: [{ id: 'p1', prim: 'vacuum', pos: [0, 0], size: [1, 1, 1] }],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /no longer supported/);
});

test('an added object still needs a model', () => {
  const r = validateScenario({
    name: 'n', roomTier: 'Standard', furniture: [], anchors: [],
    added: [{ id: 'p1', pos: [0, 0] }],
  });
  assert.equal(r.ok, false);
});

// ── Custom categories ───────────────────────────────────────────────────────

const withCats = (categories, tags = []) => ({
  name: 'n', roomTier: 'Standard', furniture: [], anchors: [], categories, tags,
});

test('a well-formed custom category is stored, trimmed', () => {
  const r = validateScenario(
    withCats([{ id: 'custom_pest', label: '  Pest hazard ', why: '  A rodent is an escalation. ', feedback: ' Escalate. ' }])
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.categories, [
    { id: 'custom_pest', label: 'Pest hazard', why: 'A rodent is an escalation.', feedback: 'Escalate.' },
  ]);
});

test('feedback is optional and normalises to null', () => {
  const r = validateScenario(withCats([{ id: 'custom_pest', label: 'Pest', why: 'why' }]));
  assert.equal(r.ok, true);
  assert.equal(r.data.categories[0].feedback, null);
});

test('a category with no why is refused, because grading prints it', () => {
  const r = validateScenario(withCats([{ id: 'custom_pest', label: 'Pest', why: '  ' }]));
  assert.equal(r.ok, false);
  assert.match(r.error, /why/);
});

test('a category id must be namespaced so it cannot shadow a built-in', () => {
  assert.equal(validateScenario(withCats([{ id: 'lived_in', label: 'X', why: 'y' }])).ok, false);
  assert.equal(validateScenario(withCats([{ id: 'pest', label: 'X', why: 'y' }])).ok, false);
});

test('two categories cannot wear the same name', () => {
  const r = validateScenario(
    withCats([
      { id: 'custom_a', label: 'Pest hazard', why: 'a' },
      { id: 'custom_b', label: '  pest   HAZARD ', why: 'b' },
    ])
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /both named/);
});

test('a tag may name a category the scenario declares', () => {
  const r = validateScenario(
    withCats([{ id: 'custom_pest', label: 'Pest', why: 'w' }], [{ ref: 'r1', defectId: 'custom_pest' }])
  );
  assert.equal(r.ok, true);
});

test('a tag naming an undeclared category is refused as unwinnable', () => {
  // The flag menu can only offer categories the scenario defines, so a tag
  // pointing outside that set is a fault the student could never answer.
  const r = validateScenario(
    withCats([{ id: 'custom_pest', label: 'Pest', why: 'w' }], [{ ref: 'r1', defectId: 'custom_other' }])
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown defectId/);
});

test('built-in ids keep working alongside custom ones', () => {
  const r = validateScenario(
    withCats([{ id: 'custom_pest', label: 'Pest', why: 'w' }], [
      { ref: 'r1', defectId: 'custom_pest' },
      { ref: 'r2', defectId: 'lived_in' },
      { ref: 'r3', defectId: null },
    ])
  );
  assert.equal(r.ok, true);
});

test('a PATCH that touches only tags still rejects a malformed custom id', () => {
  // With no category list in the payload there is nothing to check membership
  // against, so the shape is all that can be enforced — but it is enforced.
  assert.equal(validateScenario({ tags: [{ ref: 'r', defectId: 'custom_ok' }] }, true).ok, true);
  assert.equal(validateScenario({ tags: [{ ref: 'r', defectId: 'nonsense' }] }, true).ok, false);
});

// ── Condition text ──────────────────────────────────────────────────────────

const withTag = (tag) => ({ name: 'n', roomTier: 'Standard', furniture: [], anchors: [], tags: [tag] });

test('a tag may describe what the object looks like', () => {
  const r = validateScenario(
    withTag({ ref: 'bed@0,-3', defectId: 'lived_in', label: 'Bed', condition: 'Duvet pulled back.' })
  );
  assert.equal(r.ok, true);
  assert.equal(r.data.tags[0].condition, 'Duvet pulled back.');
});

test('a clean decoy may be described too', () => {
  // It must be able to: if only faults carried a description, the presence of
  // one would be the answer.
  const r = validateScenario(
    withTag({ ref: 'wardrobe@-2,0', defectId: null, label: 'Wardrobe', condition: 'Doors shut, empty.' })
  );
  assert.equal(r.ok, true);
});

test('a condition must be text, and short enough to fit beside the answers', () => {
  assert.equal(validateScenario(withTag({ ref: 'r', defectId: null, condition: 42 })).ok, false);
  assert.equal(validateScenario(withTag({ ref: 'r', defectId: null, condition: 'x'.repeat(401) })).ok, false);
  assert.equal(validateScenario(withTag({ ref: 'r', defectId: null, condition: 'x'.repeat(400) })).ok, true);
});

test('a tag with no condition is still fine', () => {
  assert.equal(validateScenario(withTag({ ref: 'r', defectId: 'lived_in' })).ok, true);
});

// ── Created inactive ────────────────────────────────────────────────────────

test('a new scenario may be created inactive (the editor does this)', () => {
  const r = validateScenario({
    name: 'n', roomTier: 'Standard', furniture: [], anchors: [], swaps: {}, added: [], tags: [],
    active: false,
  });
  assert.equal(r.ok, true);
  assert.equal(r.data.active, false);
});

test('a saved model prop with a tag round-trips through validation', () => {
  const r = validateScenario({
    name: 'n', roomTier: 'Standard', furniture: [], anchors: [],
    swaps: { 'bed@0,0': { ry: 1.57 } },
    added: [{ id: 'o1', model: 'sofa', pos: [1, 2], ry: 0, y: 0.5, scale: [1.2, 1.2, 1.2] }],
    tags: [{ ref: 'o1', defectId: 'blocked_path', label: 'Sofa' }, { ref: 'bed@0,0', defectId: null, label: 'Bed' }],
  });
  assert.equal(r.ok, true);
});
