const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeRepositorySession,
  openRepositoryInSession,
  closeRepositoryInSession,
} = require('../src/repository-session');

test('restores the legacy last repository as a one-tab session', () => {
  assert.deepEqual(normalizeRepositorySession({ lastRepository: '/repos/legacy' }), {
    repositories: ['/repos/legacy'],
    activeRepository: '/repos/legacy',
  });
});

test('opening a repository adds one tab and activates it without duplicates', () => {
  const initial = { repositories: ['/repos/one'], activeRepository: '/repos/one' };
  assert.deepEqual(openRepositoryInSession(initial, '/repos/two'), {
    repositories: ['/repos/one', '/repos/two'],
    activeRepository: '/repos/two',
  });
  assert.deepEqual(openRepositoryInSession(initial, '/repos/one'), initial);
});

test('closing the active tab selects its right neighbor, then its left neighbor', () => {
  const session = { repositories: ['/repos/one', '/repos/two', '/repos/three'], activeRepository: '/repos/two' };
  assert.deepEqual(closeRepositoryInSession(session, '/repos/two'), {
    repositories: ['/repos/one', '/repos/three'],
    activeRepository: '/repos/three',
  });
  assert.deepEqual(closeRepositoryInSession({ ...session, activeRepository: '/repos/three' }, '/repos/three'), {
    repositories: ['/repos/one', '/repos/two'],
    activeRepository: '/repos/two',
  });
});

test('closing an inactive tab keeps the active repository and closing the last tab empties the session', () => {
  assert.deepEqual(closeRepositoryInSession({ repositories: ['/repos/one', '/repos/two'], activeRepository: '/repos/two' }, '/repos/one'), {
    repositories: ['/repos/two'],
    activeRepository: '/repos/two',
  });
  assert.deepEqual(closeRepositoryInSession({ repositories: ['/repos/one'], activeRepository: '/repos/one' }, '/repos/one'), {
    repositories: [],
    activeRepository: null,
  });
});
