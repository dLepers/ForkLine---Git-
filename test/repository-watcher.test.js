const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RepositoryWatcher } = require('../src/repository-watcher');

test('invalidates action history before refreshing an external repository change', async () => {
  const events = [];
  const watcher = new RepositoryWatcher({}, () => {}, {
    onExternalChange: () => events.push('external'),
  });
  watcher.repository = '/tmp/repository';
  watcher.fingerprint = 'before';
  watcher.readFingerprint = async () => 'after';
  watcher.refresh = async () => {
    events.push('refresh');
    return { repositoryRevision: 1 };
  };

  const snapshot = await watcher.refreshIfChanged();

  assert.deepEqual(events, ['external', 'refresh']);
  assert.deepEqual(snapshot, { repositoryRevision: 1 });
});

test('does not invalidate action history when the repository fingerprint is unchanged', async () => {
  let invalidations = 0;
  const watcher = new RepositoryWatcher({}, () => {}, {
    onExternalChange: () => { invalidations += 1; },
  });
  watcher.repository = '/tmp/repository';
  watcher.fingerprint = 'same';
  watcher.readFingerprint = async () => 'same';

  assert.equal(await watcher.refreshIfChanged(), null);
  assert.equal(invalidations, 0);
});

test('refreshes the repository after a mutation that partially changes state then fails', async () => {
  const events = [];
  const watcher = new RepositoryWatcher({}, () => {}, {
    onMutationStart: () => events.push('start'),
  });
  watcher.repository = '/tmp/repository';
  watcher.refresh = async () => {
    events.push('refresh');
    return { repositoryRevision: 2 };
  };

  await assert.rejects(
    watcher.mutate(async () => {
      events.push('mutation');
      throw new Error('délai dépassé');
    }),
    /délai dépassé/,
  );

  assert.deepEqual(events, ['start', 'mutation', 'refresh']);
  assert.equal(watcher.mutationDepth, 0);
});
