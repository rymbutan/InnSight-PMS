import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RECORD_TYPES,
  RECORD_TYPE_ORDER,
  allowedRecordTypes,
  folioRef,
  guestRef,
  refFromRow,
  refOf,
  refPayload,
  refPreview,
  reservationRef,
  resolveRef,
  sameRef,
} from './recordRefs.js';

const ID = '3f1c2a9e-7b4d-4e1a-9c2b-0a1b2c3d4e5f';

test('every type has what a chip and the picker need', () => {
  for (const t of RECORD_TYPE_ORDER) {
    const meta = RECORD_TYPES[t];
    assert.ok(meta, t);
    assert.equal(typeof meta.noun, 'string');
    assert.equal(typeof meta.label, 'string');
    assert.equal(typeof meta.icon, 'string');
    assert.equal(typeof meta.path(ID), 'string');
    assert.ok(Array.isArray(meta.roles) && meta.roles.length > 0, `${t} has roles`);
    assert.equal(typeof meta.searchHint, 'string');
  }
  assert.deepEqual(Object.keys(RECORD_TYPES).sort(), [...RECORD_TYPE_ORDER].sort());
});

test('routes are the ones the record pages already answer to', () => {
  assert.equal(RECORD_TYPES.RESERVATION.path(ID), `/reservations/${ID}`);
  // The query-string form — what Arrivals navigates to and Folios reads.
  assert.equal(RECORD_TYPES.FOLIO.path(ID), `/folios?id=${ID}`);
  assert.equal(RECORD_TYPES.GUEST.path(ID), `/guests?id=${ID}`);
  // Ids are URL-encoded on the way into a route, so an odd one cannot break it.
  assert.equal(RECORD_TYPES.GUEST.path('a b/c'), '/guests?id=a%20b%2Fc');
});

test('search URLs: reservations need a term, folios and guests list recent on blank', () => {
  assert.equal(RECORD_TYPES.RESERVATION.search(''), null);
  assert.equal(RECORD_TYPES.RESERVATION.search('santos'), '/api/reservations?q=santos');
  assert.equal(RECORD_TYPES.FOLIO.search(''), '/api/folios?q=');
  assert.equal(RECORD_TYPES.FOLIO.search('F-2026'), '/api/folios?q=F-2026');
  assert.equal(RECORD_TYPES.GUEST.search(''), '/api/guests/search?q=');
  assert.equal(RECORD_TYPES.GUEST.search('dela cruz'), '/api/guests/search?q=dela%20cruz');
});

test('resolveRef fills in the route, icon and type label; rejects anything else', () => {
  const r = resolveRef({ type: 'folio', id: ID, label: 'Folio F-1', sub: 'Maria Santos' });
  assert.deepEqual(r, {
    type: 'FOLIO',
    id: ID,
    label: 'Folio F-1',
    sub: 'Maria Santos',
    path: `/folios?id=${ID}`,
    icon: 'file-text',
    typeLabel: 'Folio',
  });
  // A missing label falls back to the type name rather than an empty chip.
  assert.equal(resolveRef({ type: 'GUEST', id: ID }).label, 'Guest');
  assert.equal(resolveRef({ type: 'GUEST', id: ID, sub: '  ' }).sub, null);
  assert.equal(resolveRef(null), null);
  assert.equal(resolveRef({ type: 'ROOM', id: ID }), null);
  assert.equal(resolveRef({ type: 'FOLIO', id: '' }), null);
});

test('refOf reads the four stored columns off a message row', () => {
  const m = {
    id: 'm1',
    body: 'see this',
    refType: 'RESERVATION',
    refId: ID,
    refLabel: 'Ana Reyes',
    refSub: 'R-100',
  };
  const r = refOf(m);
  assert.equal(r.type, 'RESERVATION');
  assert.equal(r.path, `/reservations/${ID}`);
  assert.equal(r.label, 'Ana Reyes');
  assert.equal(r.sub, 'R-100');
  // The common case — a plain text message — is null, cheaply.
  assert.equal(refOf({ id: 'm2', body: 'hello' }), null);
  assert.equal(refOf({ id: 'm3', body: 'x', refType: null, refId: null }), null);
});

test('refPayload sends only the stored fields, and nothing for no attachment', () => {
  const resolved = resolveRef({ type: 'GUEST', id: ID, label: 'Ana', sub: 'G-1' });
  assert.deepEqual(refPayload(resolved), { type: 'GUEST', id: ID, label: 'Ana', sub: 'G-1' });
  assert.equal(refPayload(null), undefined);
  assert.deepEqual(refPayload({ type: 'GUEST', id: ID, label: 'Ana' }).sub, null);
});

test('sameRef compares the record, not the snapshot of its name', () => {
  assert.equal(sameRef({ type: 'GUEST', id: ID, label: 'a' }, { type: 'GUEST', id: ID, label: 'b' }), true);
  assert.equal(sameRef({ type: 'GUEST', id: ID }, { type: 'FOLIO', id: ID }), false);
  assert.equal(sameRef(null, null), true);
  assert.equal(sameRef(null, { type: 'GUEST', id: ID }), false);
});

test('refPreview stands in for the body of an attachment-only message', () => {
  assert.equal(refPreview({ type: 'FOLIO', label: 'Folio F-1' }), 'Shared folio: Folio F-1');
  assert.equal(refPreview({ type: 'GUEST', label: '' }), 'Shared a guest');
  assert.equal(refPreview(null), '');
});

test('reservationRef: the guest is the label, the confirmation number the sub-line', () => {
  assert.deepEqual(reservationRef({ id: ID, guestName: 'Maria Santos', confirmationNumber: 'R-2026-0007' }), {
    type: 'RESERVATION',
    id: ID,
    label: 'Maria Santos',
    sub: 'R-2026-0007',
  });
  // No name: the number carries the label and is not repeated underneath.
  assert.deepEqual(reservationRef({ id: ID, confirmationNumber: 'R-1' }), {
    type: 'RESERVATION',
    id: ID,
    label: 'R-1',
    sub: null,
  });
  assert.equal(reservationRef({ id: ID }).label, 'Reservation');
  assert.equal(reservationRef(null), null);
  assert.equal(reservationRef({}), null);
});

test('folioRef: the number is the label; the name comes from the page or the row', () => {
  assert.deepEqual(folioRef({ id: ID, folioNumber: 'F-2026-0012' }, 'Maria Santos'), {
    type: 'FOLIO',
    id: ID,
    label: 'Folio F-2026-0012',
    sub: 'Maria Santos',
  });
  // List rows carry a display-preferred guestName; the payer wins over it, as
  // the Folios page's own header does.
  assert.equal(folioRef({ id: ID, folioNumber: 'F-1', guestName: 'Ana' }).sub, 'Ana');
  assert.equal(
    folioRef({ id: ID, folioNumber: 'F-1', payerName: 'Company', guestName: 'Ana' }).sub,
    'Company'
  );
  assert.equal(folioRef({ id: ID }).label, 'Folio');
  assert.equal(folioRef({ id: ID, folioNumber: 'F-1' }).sub, null);
  assert.equal(folioRef(undefined), null);
});

test('guestRef: display name first, then first + last, then the profile number', () => {
  assert.deepEqual(guestRef({ id: ID, displayName: 'Juan Dela Cruz', profileNumber: 'G-1' }), {
    type: 'GUEST',
    id: ID,
    label: 'Juan Dela Cruz',
    sub: 'G-1',
  });
  assert.equal(guestRef({ id: ID, firstName: 'Juan', lastName: 'Dela Cruz' }).label, 'Juan Dela Cruz');
  assert.deepEqual(guestRef({ id: ID, profileNumber: 'G-9' }), {
    type: 'GUEST',
    id: ID,
    label: 'G-9',
    sub: null,
  });
  assert.equal(guestRef({ id: ID }).label, 'Guest');
});

test('refFromRow dispatches on type and the result resolves to a full chip', () => {
  const r = resolveRef(refFromRow('GUEST', { id: ID, displayName: 'Ana' }));
  assert.equal(r.icon, 'user');
  assert.equal(r.path, `/guests?id=${ID}`);
  assert.equal(refFromRow('ROOM', { id: ID }), null);
  assert.equal(refFromRow('FOLIO', null), null);
});

test('allowedRecordTypes follows the owning services’ GET guards', () => {
  const as =
    (...mine) =>
    (...wanted) =>
      wanted.some((r) => mine.includes(r));
  assert.deepEqual(allowedRecordTypes(as('ADMIN')), ['RESERVATION', 'FOLIO', 'GUEST']);
  assert.deepEqual(allowedRecordTypes(as('FRONT_DESK')), ['RESERVATION', 'FOLIO', 'GUEST']);
  // The auditor sees folios and reservations but not guest PII.
  assert.deepEqual(allowedRecordTypes(as('AUDITOR')), ['RESERVATION', 'FOLIO']);
  // Housekeeping can look nothing up, so the composer offers no paperclip.
  assert.deepEqual(allowedRecordTypes(as('HOUSEKEEPING_MAINTENANCE')), []);
  assert.deepEqual(allowedRecordTypes(undefined), []);
});
