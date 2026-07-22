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

test('contains a transient refresh failure triggered by an external change', async () => {
  const watcher = new RepositoryWatcher({}, () => {});
  watcher.repository = '/tmp/repository';
  watcher.fingerprint = 'before';
  watcher.readFingerprint = async () => 'after';
  watcher.refresh = async () => { throw new Error('verrou Git temporaire'); };

  assert.equal(await watcher.refreshIfChanged(), null);
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

test('starts a cached repository without blocking on its fingerprint', async () => {
  let fingerprintReads = 0;
  const watcher = new RepositoryWatcher({}, () => {});
  watcher.readFingerprint = async () => {
    fingerprintReads += 1;
    return 'fingerprint';
  };

  const snapshot = await watcher.start('/tmp/cached-repository', { repository: '/tmp/cached-repository' }, { deferFingerprint: true });

  assert.equal(fingerprintReads, 0);
  assert.equal(snapshot.repository, '/tmp/cached-repository');
  assert.equal(snapshot.repositoryRevision, 1);
  watcher.stop();
});

test('does not publish a stale refresh after switching repositories', async () => {
  let resolveSnapshot;
  const published = [];
  const git = {
    snapshot: () => new Promise((resolve) => { resolveSnapshot = resolve; }),
  };
  const watcher = new RepositoryWatcher(git, (snapshot) => published.push(snapshot.repository));
  watcher.repository = '/tmp/one';
  const refresh = watcher.refresh();
  watcher.stop();
  watcher.repository = '/tmp/two';
  resolveSnapshot({ repository: '/tmp/one' });

  assert.equal(await refresh, null);
  assert.deepEqual(published, []);
});
