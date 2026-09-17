const { test } = require('node:test');
const assert = require('node:assert/strict');

// policy.js pulls in prisma at require time; stub it out so the pure parts can
// be tested without a database. Same technique as routes/authz.test.js — but
// this stub RECORDS the delete it is asked for, because the thing most worth
// testing here is precisely which rows the session purge would remove.
const deleteCalls = [];
require.cache[require.resolve('../lib/prisma')] = {
  exports: {
    message: {
      deleteMany: async (args) => {
        deleteCalls.push(args);
        return { count: 0 };
      },
    },
    appSetting: {
      findUnique: async () => null,
      upsert: async () => ({}),
    },
  },
};

const { MODES, DEFAULT_MODE, isMode, modeOf, cutoffFor, purgeForUser } = require('./policy');

test('the shipped default keeps messages', () => {
  // A deploy must never delete history nobody asked it to delete. If this ever
  // needs to change, it is a data-loss decision and not a default tweak.
  assert.equal(DEFAULT_MODE, 'never');
  assert.equal(modeOf('never').ms, null);
});

test('every mode the admin UI can offer is one the server accepts', () => {
  for (const m of MODES) assert.ok(isMode(m.mode), `${m.mode} is listed but not accepted`);
});

test('an unknown or absent mode falls back to keeping messages', () => {
  // A hand-edited row, or a mode removed in a later version, must not be read as
  // "delete something" — the fallback is always the non-destructive one.
  for (const bad of ['', '2h', 'DROP TABLE', null, undefined]) {
    assert.equal(isMode(bad), false);
    assert.equal(modeOf(bad).mode, 'never');
  }
});

test('duration modes produce a cutoff that many milliseconds in the past', () => {
  const now = Date.UTC(2026, 8, 15, 12, 0, 0);
  const cases = [
    ['1h', 1],
    ['3h', 3],
    ['5h', 5],
    ['12h', 12],
    ['24h', 24],
    ['7d', 24 * 7],
  ];
  for (const [mode, hours] of cases) {
    const cutoff = cutoffFor(modeOf(mode), now);
    assert.equal(cutoff.getTime(), now - hours * 3600 * 1000, `${mode} cutoff is wrong`);
  }
});

test('the session-scoped and keep-forever modes have no age cutoff', () => {
  // 'logout' expires on an auth event, not on a clock — a cutoff here would
  // quietly add an age limit nobody configured.
  for (const mode of ['never', 'logout']) {
    assert.equal(cutoffFor(modeOf(mode)), null);
  }
});

// ── Session purge: what it removes, and what it must not ────────────────────

test('the session purge deletes only messages that have been read', () => {
  deleteCalls.length = 0;
  return purgeForUser('u-1').then(() => {
    assert.equal(deleteCalls.length, 1, 'expected exactly one deleteMany');
    const { where } = deleteCalls[0];

    // Both halves have to be present. Either one alone is a bug that has
    // already shipped once: participant-only deletes unread mail in transit,
    // and readAt-only would clear strangers' conversations.
    const participant = where.AND?.find((c) => c.OR);
    const read = where.AND?.find((c) => c.readAt !== undefined);

    assert.ok(participant, 'purge must be scoped to the conversations this user is party to');
    assert.deepEqual(participant.OR, [{ senderId: 'u-1' }, { recipientId: 'u-1' }]);
    assert.ok(read, 'purge must be restricted to messages that have been read');
    assert.deepEqual(read.readAt, { not: null }, 'only readAt IS NOT NULL may be deleted');
  });
});

test('an unread message sent to someone offline is not deleted by their sign-in', () => {
  // The regression this guards is the reported bug: the purge runs on sign-IN,
  // so a message written to an offline colleague used to be destroyed the moment
  // they signed in, before it was ever on screen.
  deleteCalls.length = 0;
  return purgeForUser('recipient').then(() => {
    const { where } = deleteCalls[0];
    const clauses = where.AND || [];

    // Model the rows the query would and would not match.
    const unreadInbound = { senderId: 'sender', recipientId: 'recipient', readAt: null };
    const readInbound = { senderId: 'sender', recipientId: 'recipient', readAt: new Date() };
    const unreadOutbound = { senderId: 'recipient', recipientId: 'other', readAt: null };

    // A small evaluator for the clause shape purgeForUser builds, so the
    // assertions below read as "would this row be deleted?" rather than as
    // another restatement of the query.
    const matches = (row) =>
      clauses.every((c) => {
        if (c.OR) {
          return c.OR.some((cond) => {
            const [key, val] = Object.entries(cond)[0];
            return row[key] === val;
          });
        }
        if (c.readAt) return row.readAt !== null;
        return true;
      });

    assert.equal(matches(readInbound), true, 'a message already read SHOULD be cleared');
    assert.equal(matches(unreadInbound), false, 'an unread message must survive the recipient signing in');
    assert.equal(matches(unreadOutbound), false, 'an unread message you sent must survive your own sign-in');
  });
});
