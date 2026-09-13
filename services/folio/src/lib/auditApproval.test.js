const test = require('node:test');
const assert = require('node:assert');
const { auditApprovalOf, lastActivityAt } = require('./auditApproval');

const T = (iso) => new Date(iso);

test('a folio nobody has approved is not approved, and not stale', () => {
  const a = auditApprovalOf({ auditApprovedAt: null }, [{ postedAt: T('2026-01-01T10:00:00Z') }]);
  assert.equal(a.approved, false);
  assert.equal(
    a.stale,
    false,
    'never-approved must not read as stale — the desk says different things for each'
  );
});

test('approval after the last posting holds', () => {
  const a = auditApprovalOf({ auditApprovedAt: T('2026-01-01T12:00:00Z'), auditApprovedBy: 'aud-1' }, [
    { postedAt: T('2026-01-01T10:00:00Z') },
    { postedAt: T('2026-01-01T11:00:00Z') },
  ]);
  assert.equal(a.approved, true);
  assert.equal(a.stale, false);
  assert.equal(a.approvedBy, 'aud-1');
});

// The bug this whole module exists to prevent: an auditor signs off, a late
// minibar charge lands, and the guest checks out against a bill nobody checked.
test('a charge posted AFTER approval makes it stale, not approved', () => {
  const a = auditApprovalOf({ auditApprovedAt: T('2026-01-01T12:00:00Z') }, [
    { postedAt: T('2026-01-01T10:00:00Z') },
    { postedAt: T('2026-01-01T12:30:00Z') }, // late minibar
  ]);
  assert.equal(a.approved, false);
  assert.equal(a.stale, true);
});

// Ties fail closed: we cannot prove the auditor saw a charge stamped the same
// millisecond they signed, and a needless re-check is cheaper than letting an
// unchecked charge out of the building.
test('a posting in the same millisecond as the approval invalidates it', () => {
  const same = T('2026-01-01T12:00:00.000Z');
  const a = auditApprovalOf({ auditApprovedAt: same }, [{ postedAt: same }]);
  assert.equal(a.approved, false);
  assert.equal(a.stale, true);
});

test('an empty folio can be approved', () => {
  const a = auditApprovalOf({ auditApprovedAt: T('2026-01-01T12:00:00Z') }, []);
  assert.equal(a.approved, true);
});

test('ISO strings are accepted as well as Date objects', () => {
  const a = auditApprovalOf({ auditApprovedAt: '2026-01-01T12:00:00Z' }, [
    { postedAt: '2026-01-01T13:00:00Z' },
  ]);
  assert.equal(a.stale, true);
});

test('an unparseable approval timestamp is treated as no approval', () => {
  const a = auditApprovalOf({ auditApprovedAt: 'not-a-date' }, []);
  assert.equal(a.approved, false);
  assert.equal(a.stale, false);
});

test('lastActivityAt ignores unparseable rows rather than throwing', () => {
  const last = lastActivityAt([{ postedAt: 'nonsense' }, { postedAt: T('2026-01-01T09:00:00Z') }]);
  assert.deepEqual(last, T('2026-01-01T09:00:00Z'));
});
