const { beforeEach, afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { GitService, parseTrackingStatus } = require('../src/git-service');

const exec = promisify(execFile);
let repository;
let git;

test('parses branch synchronization states', () => {
  assert.deepEqual(parseTrackingStatus(''), { state: 'up-to-date', ahead: 0, behind: 0 });
  assert.deepEqual(parseTrackingStatus('[ahead 2]'), { state: 'ahead', ahead: 2, behind: 0 });
  assert.deepEqual(parseTrackingStatus('[behind 3]'), { state: 'behind', ahead: 0, behind: 3 });
  assert.deepEqual(parseTrackingStatus('[ahead 1, behind 4]'), { state: 'diverged', ahead: 1, behind: 4 });
  assert.deepEqual(parseTrackingStatus('[gone]'), { state: 'gone', ahead: 0, behind: 0 });
});

async function command(args) {
  return exec('git', ['-C', repository, ...args], { encoding: 'utf8' });
}

beforeEach(async () => {
  repository = await fs.mkdtemp(path.join(os.tmpdir(), 'forkline-test-'));
  await command(['init', '-b', 'main']);
  await command(['config', 'user.name', 'Forkline Test']);
  await command(['config', 'user.email', 'test@forkline.local']);
  await fs.writeFile(path.join(repository, 'README.md'), '# Test\n');
  await command(['add', 'README.md']);
  await command(['commit', '-m', 'Initial commit']);
  git = new GitService();
  await git.open(repository);
});

afterEach(async () => {
  await fs.rm(repository, { recursive: true, force: true });
});

test('opens a repository and reads its history', async () => {
  const snapshot = await git.snapshot();
  assert.equal(snapshot.head, 'main');
  assert.match(snapshot.headHash, /^[0-9a-f]{40}$/);
  assert.equal(snapshot.commits[0].subject, 'Initial commit');
  assert.equal(snapshot.commits[0].date, snapshot.commits[0].authorDate);
  assert.match(snapshot.commits[0].authorDate, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(snapshot.commits[0].committerDate, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(snapshot.commits[0].topologicalRank, null);
  assert.equal(snapshot.commits[0].finalDisplayIndex, 0);
  assert.equal(snapshot.orderDebug, null);
  assert.equal(snapshot.status.files.length, 0);
});

test('reads, stages and unstages a changed file', async () => {
  await fs.appendFile(path.join(repository, 'README.md'), 'Changed\n');
  let snapshot = await git.snapshot();
  assert.equal(snapshot.status.files[0].workingTree, 'M');
  assert.match(await git.diff('README.md', false), /\+Changed/);

  await git.stage(['README.md']);
  snapshot = await git.snapshot();
  assert.equal(snapshot.status.files[0].staged, true);

  await git.unstage(['README.md']);
  snapshot = await git.snapshot();
  assert.equal(snapshot.status.files[0].workingTree, 'M');
});

test('creates a branch and commits staged content', async () => {
  await git.createBranch('feature/test');
  await fs.writeFile(path.join(repository, 'feature.txt'), 'Feature\n');
  await git.stage(['feature.txt']);
  await git.commit('Add feature');

  const snapshot = await git.snapshot();
  assert.equal(snapshot.head, 'feature/test');
  assert.equal(snapshot.commits[0].subject, 'Add feature');
});

test('rejects paths outside the repository', async () => {
  await assert.rejects(() => git.diff('../secret.txt'), /appartenir au dépôt/);
});

test('opens a repository before its first commit', async () => {
  const emptyRepository = path.join(repository, 'empty');
  await fs.mkdir(emptyRepository);
  await exec('git', ['-C', emptyRepository, 'init', '-b', 'trunk'], { encoding: 'utf8' });

  const emptyGit = new GitService();
  await emptyGit.open(emptyRepository);
  const snapshot = await emptyGit.snapshot();

  assert.equal(snapshot.head, 'trunk');
  assert.equal(snapshot.headHash, null);
  assert.deepEqual(snapshot.commits, []);
});
