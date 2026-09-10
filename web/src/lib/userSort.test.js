import test from 'node:test';
import assert from 'node:assert/strict';

import { sortUsers } from './userSort.js';

function user(username, displayName, roleCodes) {
  return { username, displayName, roles: roleCodes.map((roleCode) => ({ roleCode })) };
}

test('admin accounts pin at the top regardless of name', () => {
  const users = [
    user('zed', 'Zed Zephyr', ['FRONT_DESK']),
    user('anna', 'Anna Admin', ['ADMIN']),
    user('bo', 'Bo Barnes', ['MANAGER']),
  ];
  const sorted = sortUsers(users);
  assert.deepStrictEqual(
    sorted.map((u) => u.username),
    ['anna', 'bo', 'zed']
  );
});

test('multiple admins are pinned together, still A–Z among themselves', () => {
  const users = [
    user('zadmin', 'Zed Admin', ['ADMIN']),
    user('aadmin', 'Aria Admin', ['ADMIN']),
    user('desk', 'Desk Clerk', ['FRONT_DESK']),
  ];
  const sorted = sortUsers(users);
  assert.deepStrictEqual(
    sorted.map((u) => u.username),
    ['aadmin', 'zadmin', 'desk']
  );
});

test('non-admins sort strictly A-Z by display name', () => {
  const users = [
    user('c', 'Charlie', ['FRONT_DESK']),
    user('a', 'Alice', ['MANAGER']),
    user('b', 'Bob', ['AUDITOR']),
  ];
  const sorted = sortUsers(users);
  assert.deepStrictEqual(
    sorted.map((u) => u.username),
    ['a', 'b', 'c']
  );
});

test('falls back to username when display name is blank', () => {
  const users = [
    { username: 'zephyr', displayName: '', roles: [] },
    { username: 'alpha', displayName: '', roles: [] },
  ];
  const sorted = sortUsers(users);
  assert.deepStrictEqual(
    sorted.map((u) => u.username),
    ['alpha', 'zephyr']
  );
});

test('does not mutate the input array', () => {
  const users = [user('b', 'Bravo', []), user('a', 'Alpha', [])];
  const copy = [...users];
  sortUsers(users);
  assert.deepStrictEqual(users, copy);
});

test('a role passed as a bare string code is recognised the same as {roleCode}', () => {
  const users = [
    { username: 'z', displayName: 'Zed', roles: ['FRONT_DESK'] },
    { username: 'a', displayName: 'Aria', roles: ['ADMIN'] },
  ];
  const sorted = sortUsers(users);
  assert.deepStrictEqual(
    sorted.map((u) => u.username),
    ['a', 'z']
  );
});
