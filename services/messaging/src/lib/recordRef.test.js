const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RECORD_TYPES,
  MAX_LABEL,
  normalizeRef,
  refColumns,
  refPreview,
  messagePreview,
} = require('./recordRef');

const ID = '3f1c2a9e-7b4d-4e1a-9c2b-0a1b2c3d4e5f';

test('no ref is the normal case and normalises to null', () => {
  assert.deepEqual(normalizeRef(undefined), { ok: true, ref: null });
  assert.deepEqual(normalizeRef(null), { ok: true, ref: null });
});

test('a well-formed ref is trimmed and upper-cased, with sub optional', () => {
  const r = normalizeRef({
    type: 'folio',
    id: ` ${ID} `,
    label: '  Folio F-2026-0012 ',
    sub: ' Maria Santos ',
  });
  assert.deepEqual(r, {
    ok: true,
    ref: { type: 'FOLIO', id: ID, label: 'Folio F-2026-0012', sub: 'Maria Santos' },
  });
  const noSub = normalizeRef({ type: 'GUEST', id: ID, label: 'Juan Dela Cruz' });
  assert.equal(noSub.ok, true);
  assert.equal(noSub.ref.sub, null);
  assert.equal(normalizeRef({ type: 'GUEST', id: ID, label: 'x', sub: '   ' }).ref.sub, null);
});

test('every declared type is accepted and nothing else is', () => {
  for (const type of Object.keys(RECORD_TYPES)) {
    assert.equal(normalizeRef({ type, id: ID, label: 'x' }).ok, true, type);
  }
  for (const bad of ['ROOM', 'USER', '', 'folios', 42]) {
    const r = normalizeRef({ type: bad, id: ID, label: 'x' });
    assert.equal(r.ok, false, String(bad));
    assert.match(r.error, /ref\.type/);
  }
});

test('the ref has to be an object, not a string or a list', () => {
  for (const bad of ['FOLIO', 7, true, [ID]]) {
    const r = normalizeRef(bad);
    assert.equal(r.ok, false);
    assert.match(r.error, /object/);
  }
});

test('the id keeps out things that are obviously not an id', () => {
  // (Surrounding whitespace is trimmed rather than refused — a copied id with a
  // trailing newline is still that id.)
  for (const bad of ['', 'abc', '/folios?id=' + ID, 'x'.repeat(65), 'has space', `${ID}/x`]) {
    const r = normalizeRef({ type: 'FOLIO', id: bad, label: 'x' });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.error, /ref\.id/);
  }
  // A plain uuid, a cuid-ish id and a dashed slug all pass — the owning
  // service's 404 decides whether they are real.
  for (const ok of [ID, 'ckv9x2y3z0000abcd', 'G-1758150000000-42']) {
    assert.equal(normalizeRef({ type: 'GUEST', id: ok, label: 'x' }).ok, true, ok);
  }
});

test('the label is required and both text fields are length-capped', () => {
  assert.match(normalizeRef({ type: 'FOLIO', id: ID }).error, /ref\.label is required/);
  assert.match(normalizeRef({ type: 'FOLIO', id: ID, label: '   ' }).error, /ref\.label is required/);
  const long = 'a'.repeat(MAX_LABEL + 1);
  assert.match(normalizeRef({ type: 'FOLIO', id: ID, label: long }).error, /ref\.label cannot exceed/);
  assert.match(
    normalizeRef({ type: 'FOLIO', id: ID, label: 'x', sub: long }).error,
    /ref\.sub cannot exceed/
  );
  assert.equal(normalizeRef({ type: 'FOLIO', id: ID, label: 'a'.repeat(MAX_LABEL) }).ok, true);
});

test('refColumns maps to the four Message columns, all null when absent', () => {
  assert.deepEqual(refColumns(null), { refType: null, refId: null, refLabel: null, refSub: null });
  assert.deepEqual(refColumns({ type: 'GUEST', id: ID, label: 'Ana', sub: null }), {
    refType: 'GUEST',
    refId: ID,
    refLabel: 'Ana',
    refSub: null,
  });
});

test('an attachment-only message still has a preview', () => {
  assert.equal(refPreview('FOLIO', 'Folio F-1'), 'Shared folio: Folio F-1');
  assert.equal(refPreview('RESERVATION', 'Maria Santos'), 'Shared reservation: Maria Santos');
  assert.equal(refPreview('GUEST', null), 'Shared a guest');
  assert.equal(refPreview('SOMETHING', 'x'), 'Shared record: x');

  // The body wins when there is one; the attachment stands in when there is not.
  assert.equal(messagePreview({ body: 'Look at this', refType: 'FOLIO', refLabel: 'F-1' }), 'Look at this');
  assert.equal(messagePreview({ body: '', refType: 'FOLIO', refLabel: 'F-1' }), 'Shared folio: F-1');
  assert.equal(messagePreview({ body: '   ' }), '');
  assert.equal(messagePreview({ body: 'x'.repeat(200) }, 120).length, 120);
});
