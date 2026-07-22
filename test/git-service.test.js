const { beforeEach, afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { GitService, parseTrackingStatus } = require('../src/git-service');
const { branchSyncState } = require('../src/branch-sync');
const { layoutCommitGraph } = require('../src/renderer/graph-layout');

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

test('does not mark an unpushed commit as remote', () => {
  const result = branchSyncState({ name: 'master', hash: 'B', upstream: 'origin/master', tracking: { state: 'ahead', ahead: 1, behind: 0 } }, 'A');
  assert.deepEqual(result.icons, ['💻']);
  assert.equal(result.state, 'ahead');
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
  assert.deepEqual({ name: snapshot.identity.name, email: snapshot.identity.email, scope: snapshot.identity.scope }, { name: 'Forkline Test', email: 'test@forkline.local', scope: 'local' });
});

test('updates the repository Git identity locally', async () => {
  await git.setIdentity('Daisy Local', 'daisy@example.test', 'local');
  const identity = await git.identity();
  assert.equal(identity.name, 'Daisy Local');
  assert.equal(identity.email, 'daisy@example.test');
  assert.equal(identity.scope, 'local');
  assert.equal((await command(['config', '--local', '--get', 'user.name'])).stdout.trim(), 'Daisy Local');
});

test('detects Git LFS availability and tracked patterns', async () => {
  await fs.writeFile(path.join(repository, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n*.txt text\n');
  const lfs = await git.lfsStatus();
  assert.deepEqual(lfs.patterns, ['*.bin']);
  assert.equal(typeof lfs.available, 'boolean');
  if (!lfs.available) await assert.rejects(() => git.trackLfs('*.zip'), /Git LFS n’est pas installé/);
});

test('detects active hooks and preserves their error output', async () => {
  const hooksPath = path.join(repository, '.git', 'hooks');
  const hookPath = path.join(hooksPath, 'pre-commit');
  await fs.writeFile(hookPath, '#!/bin/sh\necho "Hook blocked this commit" >&2\nexit 1\n', { mode: 0o755 });
  const preferences = await git.setCommitPreferences({ scope: 'local', gpgSign: false, signingKey: '' });
  assert.equal(preferences.gpgSign, false);
  assert.deepEqual(preferences.hooks, ['pre-commit']);

  await fs.appendFile(path.join(repository, 'README.md'), 'Blocked\n');
  await git.stage(['README.md']);
  await assert.rejects(() => git.commit('Blocked by hook', { sign: false }), (error) => {
    assert.match(error.details, /Hook blocked this commit/);
    return true;
  });
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

test('discards, stages and unstages a hunk through git apply stdin', async () => {
  const readme = path.join(repository, 'README.md');
  await fs.appendFile(readme, 'Hunk change\n');
  let patch = await git.diff('README.md', false);

  await git.applyHunk(patch, false, true);
  assert.equal((await git.status()).files.length, 0);

  await fs.appendFile(readme, 'Hunk change\n');
  patch = await git.diff('README.md', false);
  await git.applyHunk(patch, true, false);
  let status = await git.status();
  assert.equal(status.files[0].staged, true);
  assert.equal(status.files[0].workingTree, ' ');

  patch = await git.diff('README.md', true);
  await git.applyHunk(patch, true, true);
  status = await git.status();
  assert.equal(status.files[0].staged, false);
  assert.equal(status.files[0].workingTree, 'M');
});

test('reports every untracked file inside an untracked directory', async () => {
  const settings = path.join(repository, '.settings');
  await fs.mkdir(settings);
  await fs.writeFile(path.join(settings, 'one.xml'), '<one/>\n');
  await fs.writeFile(path.join(settings, 'two.xml'), '<two/>\n');

  const status = await git.status();

  assert.deepEqual(status.files.map((file) => file.path), ['.settings/one.xml', '.settings/two.xml']);
  assert.equal(status.files.every((file) => file.untracked), true);

  await fs.rm(settings, { recursive: true });
  assert.equal((await git.status()).files.length, 0);
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

test('creates a branch from a selected revision without checking it out', async () => {
  const initialHash = (await git.snapshot()).headHash;
  await git.createBranch('feature/from-selection', initialHash, false);

  const snapshot = await git.snapshot();
  const created = snapshot.branches.find((branch) => branch.name === 'feature/from-selection');
  assert.equal(snapshot.head, 'main');
  assert.equal(created.hash, initialHash);
  assert.equal(created.current, false);
});

test('does not inherit the selected branch upstream when creating a branch', async () => {
  await command(['config', 'branch.autoSetupMerge', 'inherit']);
  await command(['config', 'branch.main.remote', 'origin']);
  await command(['config', 'branch.main.merge', 'refs/heads/main']);

  await git.createBranch('feature/no-inherited-upstream', 'main', false);

  const created = (await git.snapshot()).branches.find((branch) => branch.name === 'feature/no-inherited-upstream');
  assert.equal(created.upstream, '');
});

test('rejects invalid and duplicate branch names with clear errors', async () => {
  await git.createBranch('feature/existing', null, false);
  await assert.rejects(() => git.createBranch('feature/existing', null, false), /existe déjà/);
  await assert.rejects(() => git.createBranch('invalid name', null, false), /Nom de branche invalide/);
  assert.equal((await git.snapshot()).head, 'main');
});

test('amends the last commit with staged content', async () => {
  const previousHash = (await git.snapshot()).headHash;
  await fs.appendFile(path.join(repository, 'README.md'), 'Amended line\n');
  await git.stage(['README.md']);
  await git.commit('Updated initial commit', { amend: true });

  const snapshot = await git.snapshot();
  assert.notEqual(snapshot.headHash, previousHash);
  assert.equal(snapshot.commits[0].subject, 'Updated initial commit');
  assert.equal(snapshot.commits.length, 1);
  assert.match(await fs.readFile(path.join(repository, 'README.md'), 'utf8'), /Amended line/);
});

test('reorders and drops commits with an interactive rebase plan', async () => {
  const baseHash = (await git.snapshot()).headHash;
  for (const [file, subject] of [['one.txt', 'Commit one'], ['two.txt', 'Commit two'], ['three.txt', 'Commit three']]) {
    await fs.writeFile(path.join(repository, file), `${subject}\n`);
    await git.stage([file]);
    await git.commit(subject);
  }
  const plan = await git.interactiveRebasePlan(baseHash);
  assert.deepEqual(plan.map((commit) => commit.subject), ['Commit one', 'Commit two', 'Commit three']);

  const result = await git.interactiveRebase(baseHash, [
    { hash: plan[0].hash, action: 'pick' },
    { hash: plan[2].hash, action: 'pick' },
    { hash: plan[1].hash, action: 'drop' },
  ]);

  assert.equal(result.conflicted, false);
  assert.deepEqual((await git.commits()).slice(0, 3).map((commit) => commit.subject), ['Commit three', 'Commit one', 'Initial commit']);
  await assert.rejects(() => fs.access(path.join(repository, 'two.txt')));
});

test('rewords multiple commits during an interactive rebase', async () => {
  const baseHash = (await git.snapshot()).headHash;
  for (const [file, subject] of [['first.txt', 'Old first message'], ['second.txt', 'Old second message']]) {
    await fs.writeFile(path.join(repository, file), `${subject}\n`);
    await git.stage([file]);
    await git.commit(subject);
  }
  const plan = await git.interactiveRebasePlan(baseHash);
  const result = await git.interactiveRebase(baseHash, plan.map((commit, index) => ({ hash: commit.hash, action: 'reword', message: `New message ${index + 1}` })));

  assert.equal(result.conflicted, false);
  assert.deepEqual((await git.commits()).slice(0, 2).map((commit) => commit.subject), ['New message 2', 'New message 1']);
});

test('interactively rebases the active branch onto a divergent branch', async () => {
  const rootHash = (await git.snapshot()).headHash;
  await git.createBranch('target', rootHash);
  await fs.writeFile(path.join(repository, 'target.txt'), 'Target branch\n');
  await git.stage(['target.txt']);
  await git.commit('Target commit');
  const targetHash = (await git.snapshot()).headHash;

  await git.switchBranch('main');
  await fs.writeFile(path.join(repository, 'main.txt'), 'Main branch\n');
  await git.stage(['main.txt']);
  await git.commit('Main commit');

  const plan = await git.interactiveRebasePlan('target');
  assert.deepEqual(plan.map((commit) => commit.subject), ['Main commit']);
  const result = await git.interactiveRebase('target', plan);

  assert.equal(result.conflicted, false);
  assert.equal(await git.head(), 'main');
  assert.equal((await command(['rev-parse', 'HEAD^'])).stdout.trim(), targetHash);
  assert.deepEqual((await git.commits()).slice(0, 2).map((commit) => commit.subject), ['Main commit', 'Target commit']);
});

test('manages a branch lifecycle from a selected revision', async () => {
  const initialHash = (await git.snapshot()).headHash;

  await git.createBranch('feature/lifecycle', initialHash);
  assert.equal((await git.snapshot()).head, 'feature/lifecycle');
  await assert.rejects(() => git.renameBranch('feature/lifecycle', 'feature/lifecycle'), /différent/);
  await assert.rejects(() => git.renameBranch('feature/lifecycle', 'nom invalide'), /Nom de branche invalide/);
  await assert.rejects(() => git.renameBranch('feature/lifecycle', 'main'), /existe déjà/);
  assert.equal((await git.snapshot()).head, 'feature/lifecycle');
  await git.renameBranch('feature/lifecycle', 'feature/renamed');
  assert.equal((await git.snapshot()).head, 'feature/renamed');

  await git.switchBranch('main');
  await git.renameBranch('feature/renamed', 'feature/inactive-renamed');
  assert.equal((await git.snapshot()).head, 'main');
  assert.equal((await git.snapshot()).branches.some((branch) => branch.name === 'feature/inactive-renamed'), true);
  await git.renameBranch('feature/inactive-renamed', 'feature/renamed');
  await git.deleteBranch('feature/renamed');
  assert.equal((await git.snapshot()).branches.some((branch) => branch.name === 'feature/renamed'), false);
});

test('fast-forwards the active branch to another branch without a merge commit', async () => {
  await git.createBranch('feature/fast-forward');
  await fs.writeFile(path.join(repository, 'fast-forward.txt'), 'Fast-forward\n');
  await git.stage(['fast-forward.txt']);
  await git.commit('Fast-forward target');
  const featureHash = (await git.snapshot()).headHash;
  await git.switchBranch('main');

  const result = await git.fastForwardBranch('feature/fast-forward');

  assert.equal(result.conflicted, false);
  assert.equal(await git.head(), 'main');
  assert.equal((await git.snapshot()).headHash, featureHash);
  assert.equal((await command(['rev-list', '--count', '--merges', 'main'])).stdout.trim(), '0');
});

test('keeps branch references anchored to the graph after a merge action', async () => {
  await git.createBranch('feature/graph');
  await fs.writeFile(path.join(repository, 'feature.txt'), 'Feature\n');
  await git.stage(['feature.txt']);
  await git.commit('Feature graph commit');
  const featureHash = (await git.snapshot()).headHash;

  await git.switchBranch('main');
  await fs.writeFile(path.join(repository, 'main.txt'), 'Main\n');
  await git.stage(['main.txt']);
  await git.commit('Main graph commit');
  const result = await git.mergeBranch('feature/graph');
  assert.equal(result.conflicted, false);

  const snapshot = await git.snapshot();
  const graph = layoutCommitGraph(snapshot.commits.filter((commit) => !commit.stashRef), {
    headHash: snapshot.headHash,
    branches: snapshot.branches,
  });
  const headRow = snapshot.commits.findIndex((commit) => commit.hash === snapshot.headHash);
  const main = snapshot.branches.find((branch) => branch.name === 'main');
  const feature = snapshot.branches.find((branch) => branch.name === 'feature/graph');

  assert.equal(main.hash, snapshot.headHash);
  assert.equal(feature.hash, featureHash);
  assert.equal(snapshot.commits[headRow].parents.length, 2);
  assert.equal(graph.rows[headRow].connections.length, 2);
  assert.equal(graph.rows[headRow].lane, 0);
});

test('undoes and redoes a commit without discarding its changes', async () => {
  const initialHash = (await git.snapshot()).headHash;
  await fs.writeFile(path.join(repository, 'undo.txt'), 'Content preserved\n');
  await git.stage(['undo.txt']);
  await git.commit('Commit to undo');
  const committedHash = (await git.snapshot()).headHash;

  const plan = await git.undoPlan();
  assert.equal(plan.available, true);
  assert.equal(plan.mode, 'soft');
  const redoAction = await git.undoLastAction();
  assert.equal((await git.snapshot()).headHash, initialHash);
  assert.equal((await git.status()).files.find((file) => file.path === 'undo.txt')?.staged, true);
  assert.equal(await fs.readFile(path.join(repository, 'undo.txt'), 'utf8'), 'Content preserved\n');

  await git.redoLastAction(redoAction);
  assert.equal((await git.snapshot()).headHash, committedHash);
  assert.equal((await git.status()).files.length, 0);
});

test('undoes and redoes several consecutive commits while preserving the index', async () => {
  const initialHash = (await git.snapshot()).headHash;
  const committedHashes = [];
  for (const [file, content] of [['history-one.txt', 'One\n'], ['history-two.txt', 'Two\n']]) {
    await fs.writeFile(path.join(repository, file), content);
    await git.stage([file]);
    await git.commit(`Add ${file}`);
    committedHashes.push((await git.snapshot()).headHash);
  }

  const plans = await git.undoPlans();
  assert.equal(plans.length >= 2, true);
  let expected = null;
  const redoActions = [];
  for (const plan of plans.slice(0, 2)) {
    const redoAction = await git.applyUndoPlan(plan, expected);
    redoActions.push(redoAction);
    expected = redoAction.expected;
  }
  assert.equal((await git.snapshot()).headHash, initialHash);
  assert.deepEqual((await git.status()).files.map((file) => file.path).sort(), ['history-one.txt', 'history-two.txt']);
  assert.equal((await git.status()).files.every((file) => file.staged), true);

  for (const redoAction of redoActions.reverse()) await git.redoLastAction(redoAction);
  assert.equal((await git.snapshot()).headHash, committedHashes[1]);
  assert.equal((await git.status()).files.length, 0);
  assert.match((await git.reflogEntries(1))[0].subject, /^forkline redo/);
});

test('undoes and redoes a branch checkout', async () => {
  await git.createBranch('feature/history');
  await git.switchBranch('main');

  const redoAction = await git.undoLastAction();
  assert.equal(await git.head(), 'feature/history');
  await git.redoLastAction(redoAction);
  assert.equal(await git.head(), 'main');
});

test('checks out a commit in detached HEAD mode', async () => {
  const initialHash = (await git.snapshot()).headHash;

  await git.checkoutCommit(initialHash);

  assert.equal((await command(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(), 'HEAD');
  assert.equal((await git.snapshot()).headHash, initialHash);
  await git.switchBranch('main');
  assert.equal(await git.head(), 'main');
  assert.equal((await git.snapshot()).headHash, initialHash);
});

test('automatically stashes pending files before checking out a commit', async () => {
  const initialHash = (await git.snapshot()).headHash;
  await fs.writeFile(path.join(repository, 'committed.txt'), 'Committed\n');
  await git.stage(['committed.txt']);
  await git.commit('Second commit');

  await fs.appendFile(path.join(repository, 'README.md'), 'Pending tracked change\n');
  await git.stage(['README.md']);
  await fs.appendFile(path.join(repository, 'README.md'), 'Pending unstaged change\n');
  await fs.writeFile(path.join(repository, 'pending.txt'), 'Pending untracked file\n');
  await git.checkoutCommit(initialHash);

  const snapshot = await git.snapshot();
  assert.equal((await command(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(), 'HEAD');
  assert.equal(snapshot.headHash, initialHash);
  assert.equal(snapshot.status.files.length, 0);
  assert.equal(snapshot.stashes.length, 1);
  assert.equal(snapshot.stashes[0].baseHash, (await command(['rev-parse', 'main'])).stdout.trim());
  assert.equal(snapshot.stashes[0].message, `Auto stash before checking out "${initialHash.slice(0, 7)}"`);
  assert.deepEqual(snapshot.stashes[0].files.sort(), ['README.md', 'pending.txt']);
  assert.match((await command(['show', 'stash@{0}:README.md'])).stdout, /Pending unstaged change/);
  assert.doesNotMatch((await command(['show', 'stash@{0}\^2:README.md'])).stdout, /Pending unstaged change/);
  assert.match((await command(['show', 'stash@{0}\^2:README.md'])).stdout, /Pending tracked change/);
});

test('automatically stashes pending files before switching branches', async () => {
  const initialHash = (await git.snapshot()).headHash;
  await git.createBranch('target', initialHash);
  await git.switchBranch('main');
  await fs.appendFile(path.join(repository, 'README.md'), 'Pending branch change\n');

  await git.switchBranch('target');

  const snapshot = await git.snapshot();
  assert.equal(snapshot.head, 'target');
  assert.equal(snapshot.status.files.length, 0);
  assert.equal(snapshot.stashes.length, 1);
  assert.equal(snapshot.stashes[0].message, 'Auto stash before checking out "target"');
  assert.deepEqual(snapshot.stashes[0].files, ['README.md']);
});

test('cherry-picks and reverts a commit', async () => {
  await git.createBranch('feature/cherry');
  await fs.writeFile(path.join(repository, 'picked.txt'), 'Picked\n');
  await git.stage(['picked.txt']);
  await git.commit('Commit to pick');
  const pickedHash = (await git.snapshot()).headHash;
  await git.switchBranch('main');

  const picked = await git.cherryPick(pickedHash);
  assert.equal(picked.conflicted, false);
  assert.equal(await fs.readFile(path.join(repository, 'picked.txt'), 'utf8'), 'Picked\n');

  const reverted = await git.revertCommit((await git.snapshot()).headHash);
  assert.equal(reverted.conflicted, false);
  await assert.rejects(() => fs.access(path.join(repository, 'picked.txt')));
});

test('creates lightweight and annotated tags and compares a revision', async () => {
  const initialHash = (await git.snapshot()).headHash;
  await git.createTag('v1.0.0', initialHash);
  await git.createTag('v1.0.1', initialHash, 'Version annotée');
  await fs.appendFile(path.join(repository, 'README.md'), 'Comparison\n');

  assert.equal((await command(['rev-parse', 'v1.0.0'])).stdout.trim(), initialHash);
  assert.match((await command(['cat-file', '-t', 'v1.0.1'])).stdout, /tag/);
  const tags = await git.tags();
  assert.deepEqual(tags.map((tag) => tag.name), ['v1.0.0', 'v1.0.1']);
  assert.equal(tags.find((tag) => tag.name === 'v1.0.1').annotated, true);
  assert.match(await git.compareWithWorktree(initialHash), /\+Comparison/);

  await assert.rejects(() => git.createTag('v1.0.0', initialHash), /existe déjà/);
  await assert.rejects(() => git.createTag('nom de tag invalide', initialHash), /Nom de tag invalide/);
  assert.deepEqual((await git.tags()).map((tag) => tag.name), ['v1.0.0', 'v1.0.1']);

  await git.deleteTag('v1.0.0');
  assert.deepEqual((await git.tags()).map((tag) => tag.name), ['v1.0.1']);
});

test('searches commits and exposes file history, blame and revision comparison', async () => {
  const initialHash = (await git.snapshot()).headHash;
  await fs.appendFile(path.join(repository, 'README.md'), 'Historical line\n');
  await git.stage(['README.md']);
  await git.commit('Document searchable history');
  const latestHash = (await git.snapshot()).headHash;

  const results = await git.searchHistory('searchable');
  assert.equal(results.length, 1);
  assert.equal(results[0].hash, latestHash);
  const filtered = await git.searchHistory({ query: 'searchable', author: 'Forkline', file: 'README.md', after: '2000-01-01', before: '2099-12-31', ref: 'main' });
  assert.deepEqual(filtered.map((commit) => commit.hash), [latestHash]);
  await assert.rejects(() => git.searchHistory({ after: 'hier' }), /Filtre de date after invalide/);

  const history = await git.fileHistory('README.md');
  assert.deepEqual(history.map((commit) => commit.subject), ['Document searchable history', 'Initial commit']);
  assert.match(await git.blame('README.md'), /Historical line/);
  assert.match(await git.compareRevisions(initialHash, latestHash), /\+Historical line/);
  assert.deepEqual(await git.commitFiles(latestHash), [{ status: 'M', path: 'README.md', originalPath: null }]);
  assert.match(await git.commitFileDiff(latestHash, 'README.md'), /\+Historical line/);
  const analysisData = await git.commitAnalysisData(latestHash);
  assert.match(analysisData, /commit [0-9a-f]{40}/);
  assert.match(analysisData, /Document searchable history/);
  assert.match(analysisData, /\+Historical line/);
});

test('builds a stable WIP analysis payload from staged, unstaged and untracked changes', async () => {
  await fs.appendFile(path.join(repository, 'README.md'), 'Unstaged WIP change\n');
  await fs.writeFile(path.join(repository, 'staged-wip.txt'), 'Staged WIP change\n');
  await git.stage(['staged-wip.txt']);
  await fs.writeFile(path.join(repository, 'untracked-wip.txt'), 'Untracked WIP change\n');

  const first = await git.worktreeAnalysisData();
  const repeated = await git.worktreeAnalysisData();
  assert.equal(first.fingerprint, repeated.fingerprint);
  assert.equal(first.fileCount, 3);
  assert.match(first.data, /MODIFICATIONS INDEXÉES[\s\S]*Staged WIP change/);
  assert.match(first.data, /MODIFICATIONS NON INDEXÉES[\s\S]*Unstaged WIP change/);
  assert.match(first.data, /FICHIERS NON SUIVIS[\s\S]*Untracked WIP change/);

  await fs.appendFile(path.join(repository, 'untracked-wip.txt'), 'Fingerprint change\n');
  assert.notEqual((await git.worktreeAnalysisData()).fingerprint, first.fingerprint);
});

test('deletes a selected non-head commit while preserving its descendants', async () => {
  await fs.appendFile(path.join(repository, 'README.md'), 'Commit to delete\n');
  await git.stage(['README.md']);
  await git.commit('Temporary middle commit');
  const target = (await git.snapshot()).headHash;
  await fs.writeFile(path.join(repository, 'descendant.txt'), 'Descendant\n');
  await git.stage(['descendant.txt']);
  await git.commit('Keep descendant commit');

  await git.deleteCommit(target);

  const commits = await git.commits(10);
  assert.equal(commits.some((commit) => commit.subject === 'Temporary middle commit'), false);
  assert.equal(commits.some((commit) => commit.subject === 'Keep descendant commit'), true);
});

test('adds, renames, fetches and removes a remote', async () => {
  const remoteRepository = await fs.mkdtemp(path.join(os.tmpdir(), 'forkline-remote-'));
  try {
    await exec('git', ['init', '--bare', remoteRepository], { encoding: 'utf8' });
    await git.addRemote('upstream', remoteRepository);
    assert.equal((await git.remotes())[0].name, 'upstream');
    await git.push({ remote: 'upstream', branch: 'main', setUpstream: true });
    assert.match((await exec('git', ['--git-dir', remoteRepository, 'show-ref', '--verify', 'refs/heads/main'], { encoding: 'utf8' })).stdout, /refs\/heads\/main/);
    await command(['branch', '--unset-upstream', 'main']);
    assert.equal((await git.snapshot()).branches.find((branch) => branch.name === 'main').upstream, '');
    await git.setUpstream('main', 'upstream', 'main');
    assert.equal((await git.snapshot()).branches.find((branch) => branch.name === 'main').upstream, 'upstream/main');
    await assert.rejects(() => git.setUpstream('main', 'upstream', 'absente'), /n’existe pas/);
    assert.equal((await git.snapshot()).branches.find((branch) => branch.name === 'main').upstream, 'upstream/main');
    await git.createTag('remote-test', (await git.snapshot()).headHash);
    await git.pushTag('remote-test', 'upstream');
    assert.match((await exec('git', ['--git-dir', remoteRepository, 'show-ref', '--verify', 'refs/tags/remote-test'], { encoding: 'utf8' })).stdout, /refs\/tags\/remote-test/);
    await git.deleteRemoteTag('remote-test', 'upstream');
    await assert.rejects(() => exec('git', ['--git-dir', remoteRepository, 'show-ref', '--verify', 'refs/tags/remote-test'], { encoding: 'utf8' }));
    await git.fetchRemote('upstream', true);
    await git.renameRemote('upstream', 'origin');
    assert.equal((await git.remotes())[0].name, 'origin');
    await git.removeRemote('origin');
    assert.deepEqual(await git.remotes(), []);
  } finally {
    await fs.rm(remoteRepository, { recursive: true, force: true });
  }
});

test('pushes a branch to the explicitly selected remote', async () => {
  const originRepository = await fs.mkdtemp(path.join(os.tmpdir(), 'forkline-origin-'));
  const backupRepository = await fs.mkdtemp(path.join(os.tmpdir(), 'forkline-backup-'));
  try {
    await exec('git', ['init', '--bare', originRepository], { encoding: 'utf8' });
    await exec('git', ['init', '--bare', backupRepository], { encoding: 'utf8' });
    await git.addRemote('origin', originRepository);
    await git.addRemote('backup', backupRepository);

    await git.pushBranch('main', { remote: 'backup', remoteBranch: 'published-main' });

    await assert.rejects(() => exec('git', ['--git-dir', originRepository, 'show-ref', '--verify', 'refs/heads/main'], { encoding: 'utf8' }));
    assert.match((await exec('git', ['--git-dir', backupRepository, 'show-ref', '--verify', 'refs/heads/published-main'], { encoding: 'utf8' })).stdout, /refs\/heads\/published-main/);
    assert.equal((await git.snapshot()).branches.find((branch) => branch.name === 'main').upstream, 'backup/published-main');
    await fs.appendFile(path.join(repository, 'README.md'), 'Second push\n');
    await git.stage(['README.md']);
    await git.commit('Second push');
    await git.pushBranch('main');
    assert.equal((await exec('git', ['--git-dir', backupRepository, 'rev-parse', 'refs/heads/published-main'], { encoding: 'utf8' })).stdout.trim(), (await git.snapshot()).headHash);
    await assert.rejects(() => git.pushBranch('main', { remote: 'missing' }), /n’existe pas/);
  } finally {
    await fs.rm(originRepository, { recursive: true, force: true });
    await fs.rm(backupRepository, { recursive: true, force: true });
  }
});

test('deletes a local branch and its tracked remote branch together', async () => {
  const remoteRepository = await fs.mkdtemp(path.join(os.tmpdir(), 'forkline-delete-remote-'));
  try {
    await exec('git', ['init', '--bare', remoteRepository], { encoding: 'utf8' });
    await git.addRemote('origin', remoteRepository);
    await git.createBranch('feature/remote-delete');
    await fs.writeFile(path.join(repository, 'remote-delete.txt'), 'Delete me\n');
    await git.stage(['remote-delete.txt']);
    await git.commit('Remote branch to delete');
    await git.pushBranch('feature/remote-delete', { remote: 'origin' });
    await git.switchBranch('main');

    await assert.rejects(
      () => git.deleteBranchWithRemote('feature/remote-delete', 'origin/main'),
      /ne correspond pas à la branche locale/,
    );
    assert.equal((await git.branches()).some((branch) => branch.name === 'feature/remote-delete'), true);
    assert.match((await exec('git', ['--git-dir', remoteRepository, 'show-ref', '--verify', 'refs/heads/feature/remote-delete'], { encoding: 'utf8' })).stdout, /refs\/heads\/feature\/remote-delete/);

    await git.deleteBranchWithRemote('feature/remote-delete', 'origin/feature/remote-delete');

    assert.equal((await git.branches()).some((branch) => branch.name === 'feature/remote-delete'), false);
    await assert.rejects(() => exec('git', ['--git-dir', remoteRepository, 'show-ref', '--verify', 'refs/heads/feature/remote-delete'], { encoding: 'utf8' }));
  } finally {
    await fs.rm(remoteRepository, { recursive: true, force: true });
  }
});

test('rejects an unknown pull strategy', async () => {
  await assert.rejects(() => git.pull({ strategy: 'unsafe' }), /Stratégie de pull invalide/);
});

test('auto-stashes local changes during a merge and restores their staging state', async () => {
  await git.createBranch('feature/autostash');
  await fs.writeFile(path.join(repository, 'feature.txt'), 'Feature content\n');
  await git.stage(['feature.txt']);
  await git.commit('Feature for autostash');
  await git.switchBranch('main');

  await fs.appendFile(path.join(repository, 'README.md'), 'Local unstaged change\n');
  await fs.writeFile(path.join(repository, 'staged-local.txt'), 'Local staged change\n');
  await git.stage(['staged-local.txt']);
  await fs.writeFile(path.join(repository, 'untracked-local.txt'), 'Local untracked change\n');

  const result = await git.mergeBranch('feature/autostash');

  assert.equal(result.conflicted, false);
  assert.match(await fs.readFile(path.join(repository, 'README.md'), 'utf8'), /Local unstaged change/);
  assert.equal(await fs.readFile(path.join(repository, 'staged-local.txt'), 'utf8'), 'Local staged change\n');
  assert.equal(await fs.readFile(path.join(repository, 'untracked-local.txt'), 'utf8'), 'Local untracked change\n');
  const status = await git.status();
  assert.equal(status.files.find((file) => file.path === 'README.md')?.staged, false);
  assert.equal(status.files.find((file) => file.path === 'staged-local.txt')?.staged, true);
  assert.equal(status.files.find((file) => file.path === 'untracked-local.txt')?.untracked, true);
  assert.equal((await git.stashes()).length, 0);
});

test('keeps the merge autostash safe through conflict abort and continue', async () => {
  await fs.writeFile(path.join(repository, 'local.txt'), 'Committed base\n');
  await git.stage(['local.txt']);
  await git.commit('Add local base');
  await git.createBranch('feature/autostash-conflict');
  await fs.writeFile(path.join(repository, 'README.md'), '# Feature conflict\n');
  await git.stage(['README.md']);
  await git.commit('Feature conflict for autostash');
  await git.switchBranch('main');
  await fs.writeFile(path.join(repository, 'README.md'), '# Main conflict\n');
  await git.stage(['README.md']);
  await git.commit('Main conflict for autostash');
  await fs.writeFile(path.join(repository, 'local.txt'), 'Pending local work\n');
  await git.stage(['local.txt']);

  const conflicted = await git.mergeBranch('feature/autostash-conflict');
  assert.equal(conflicted.conflicted, true);
  assert.equal(await fs.readFile(path.join(repository, 'local.txt'), 'utf8'), 'Committed base\n');
  assert.match((await command(['config', '--local', '--get', 'forkline.autoStash.merge'])).stdout, /^[0-9a-f]{40}/);

  await git.abortOperation('merge');
  assert.equal(await fs.readFile(path.join(repository, 'local.txt'), 'utf8'), 'Pending local work\n');
  assert.equal((await git.status()).files.find((file) => file.path === 'local.txt')?.staged, true);
  await assert.rejects(() => command(['config', '--local', '--get', 'forkline.autoStash.merge']));

  const secondAttempt = await git.mergeBranch('feature/autostash-conflict');
  assert.equal(secondAttempt.conflicted, true);
  await git.resolveConflict('README.md', 'ours');
  const continued = await git.continueOperation('merge');
  assert.equal(continued.conflicted, false);
  assert.equal(await fs.readFile(path.join(repository, 'local.txt'), 'utf8'), 'Pending local work\n');
  assert.equal((await git.status()).files.find((file) => file.path === 'local.txt')?.staged, true);
  assert.equal((await git.stashes()).length, 0);
});

test('restores non-overlapping staged files when the autostash itself conflicts', async () => {
  await git.createBranch('feature/autostash-restore-conflict');
  await fs.writeFile(path.join(repository, 'README.md'), '# Feature version\n');
  await git.stage(['README.md']);
  await git.commit('Feature changes the pending file');
  await git.switchBranch('main');
  await fs.writeFile(path.join(repository, 'README.md'), '# Local pending version\n');
  await fs.writeFile(path.join(repository, 'staged-safe.txt'), 'Keep this staged\n');
  await git.stage(['staged-safe.txt']);

  const result = await git.mergeBranch('feature/autostash-restore-conflict');

  assert.equal(result.conflicted, true);
  assert.deepEqual(result.conflicts, ['README.md']);
  assert.equal((await git.status()).files.find((file) => file.path === 'staged-safe.txt')?.staged, true);
  assert.equal((await git.stashes()).length, 1);
  assert.equal(await git.pendingMergeAutoStash(), '');
});

test('reports merge conflicts instead of hiding the repository state', async () => {
  await git.createBranch('feature/conflict');
  await fs.writeFile(path.join(repository, 'README.md'), '# Feature\n');
  await git.stage(['README.md']);
  await git.commit('Feature version');
  await git.switchBranch('main');
  await fs.writeFile(path.join(repository, 'README.md'), '# Main\n');
  await git.stage(['README.md']);
  await git.commit('Main version');

  const result = await git.mergeBranch('feature/conflict');

  assert.equal(result.conflicted, true);
  assert.deepEqual(result.conflicts, ['README.md']);
  assert.equal((await git.status()).files[0].conflicted, true);
  const versions = await git.conflictVersions('README.md');
  assert.match(versions.base, /# Test/);
  assert.equal(versions.ours, '# Main\n');
  assert.equal(versions.theirs, '# Feature\n');
  assert.match(versions.result, /<<<<<<< HEAD/);
  const operation = await git.operationState();
  assert.equal(operation.type, 'merge');
  assert.equal(operation.label, 'Fusion en cours');
  assert.equal(operation.source, 'feature/conflict');
  assert.equal(operation.target, 'main');
  assert.match(operation.defaultMessage, /Merge branch 'feature\/conflict'/);
  assert.deepEqual(operation.conflictPaths, ['README.md']);

  await git.abortOperation('merge');
  assert.equal(await git.operationState(), null);
  assert.equal((await git.status()).files.length, 0);

  const secondAttempt = await git.mergeBranch('feature/conflict');
  assert.equal(secondAttempt.conflicted, true);
  await assert.rejects(() => git.continueOperation('merge'), /Résolvez tous les fichiers/);
  await git.resolveAllConflicts();
  assert.equal((await git.status()).files.some((file) => file.conflicted), false);
  await git.abortOperation('merge');

  assert.equal((await git.mergeBranch('feature/conflict')).conflicted, true);
  await git.resolveConflict('README.md', 'ours');
  assert.equal(await fs.readFile(path.join(repository, 'README.md'), 'utf8'), '# Main\n');
  assert.equal((await git.status()).files.some((file) => file.conflicted), false);
  const continued = await git.continueOperation('merge');
  assert.equal(continued.conflicted, false);
  assert.equal(await git.operationState(), null);
  assert.equal((await git.status()).files.length, 0);
});

test('writes and stages a custom three-way conflict resolution', async () => {
  await git.createBranch('feature/custom-resolution');
  await fs.writeFile(path.join(repository, 'README.md'), '# Feature custom\n');
  await git.stage(['README.md']);
  await git.commit('Feature custom version');
  await git.switchBranch('main');
  await fs.writeFile(path.join(repository, 'README.md'), '# Main custom\n');
  await git.stage(['README.md']);
  await git.commit('Main custom version');
  assert.equal((await git.mergeBranch('feature/custom-resolution')).conflicted, true);

  await git.resolveConflictContent('README.md', '# Combined result\n');
  assert.equal((await git.status()).files.some((file) => file.conflicted), false);
  assert.equal(await fs.readFile(path.join(repository, 'README.md'), 'utf8'), '# Combined result\n');
  assert.equal((await git.continueOperation('merge', { message: 'Fusion du scénario de conflit' })).conflicted, false);
  assert.equal((await command(['log', '-1', '--format=%s'])).stdout.trim(), 'Fusion du scénario de conflit');
});

test('validates reset modes and refuses to delete the active branch', async () => {
  const initialHash = (await git.snapshot()).headHash;

  await assert.rejects(() => git.resetToCommit(initialHash, 'invalid'), /Mode de réinitialisation invalide/);
  await assert.rejects(() => git.deleteBranch('main'), /branche actuellement active/);
});

test('includes the WIP and index commits created by a stash', async () => {
  await fs.writeFile(path.join(repository, 'README.md'), '# Indexed change\n');
  await git.stage(['README.md']);
  await fs.appendFile(path.join(repository, 'README.md'), 'Working tree change\n');
  await command(['stash', 'push', '-m', 'Travail temporaire']);

  const snapshot = await git.snapshot();
  const stashHead = snapshot.commits.find((commit) => commit.refs.includes('refs/stash'));
  assert.ok(stashHead);
  assert.match(stashHead.subject, /^On main: Travail temporaire$/);
  assert.equal(stashHead.parents.length, 2);
  assert.ok(snapshot.commits.some((commit) => commit.hash === stashHead.parents[1] && commit.subject.startsWith('index on main:')));
});

test('creates, displays, applies and drops a stash for selected files', async () => {
  await fs.writeFile(path.join(repository, 'kept.txt'), 'Original\n');
  await command(['add', 'kept.txt']);
  await command(['commit', '-m', 'Add second file']);

  await fs.appendFile(path.join(repository, 'README.md'), 'Stashed change\n');
  await fs.appendFile(path.join(repository, 'kept.txt'), 'Visible change\n');
  await fs.writeFile(path.join(repository, 'new.txt'), 'Untracked change\n');
  await git.createStash({
    message: 'Travail sélectionné',
    includeUntracked: true,
    files: ['README.md', 'new.txt'],
  });

  let snapshot = await git.snapshot();
  assert.equal(snapshot.stashes.length, 1);
  assert.equal(snapshot.stashes[0].message, 'Travail sélectionné');
  assert.equal(snapshot.stashes[0].branch, 'main');
  assert.deepEqual(snapshot.stashes[0].files.sort(), ['README.md', 'new.txt']);
  assert.equal(snapshot.status.files.some((file) => file.path === 'kept.txt'), true);
  assert.equal(snapshot.status.files.some((file) => file.path === 'README.md'), false);
  assert.equal(snapshot.status.files.some((file) => file.path === 'new.txt'), false);

  const stashCommits = snapshot.commits.filter((commit) => commit.stashRef === 'stash@{0}');
  assert.equal(stashCommits.some((commit) => commit.stashRole === 'worktree'), true);
  assert.equal(stashCommits.some((commit) => commit.stashRole === 'index'), true);
  assert.equal(stashCommits.some((commit) => commit.stashRole === 'untracked'), true);
  assert.match(await git.stashDiff('stash@{0}'), /Stashed change/);
  const stashHash = snapshot.stashes[0].hash;
  assert.equal(await git.stashHash('stash@{0}', stashHash), stashHash);
  const stashAnalysisData = await git.stashAnalysisData('stash@{0}', stashHash);
  assert.match(stashAnalysisData, /Travail sélectionné/);
  assert.match(stashAnalysisData, /Stashed change/);
  await assert.rejects(() => git.stashAnalysisData('stash@{0}', '0000000000000000000000000000000000000000'), /stash sélectionné a changé/);

  const restored = await git.restoreStash('stash@{0}', 'apply');
  assert.equal(restored.conflicted, false);
  snapshot = await git.snapshot();
  assert.equal(snapshot.status.files.some((file) => file.path === 'README.md'), true);
  assert.equal(snapshot.status.files.some((file) => file.path === 'new.txt'), true);
  assert.equal(snapshot.stashes.length, 1);

  await git.dropStash('stash@{0}');
  snapshot = await git.snapshot();
  assert.equal(snapshot.stashes.length, 0);
});

test('can keep staged changes while creating a stash', async () => {
  await fs.writeFile(path.join(repository, 'working.txt'), 'Original\n');
  await git.stage(['working.txt']);
  await git.commit('Add working file');
  await fs.appendFile(path.join(repository, 'README.md'), 'Indexed change\n');
  await git.stage(['README.md']);
  await fs.appendFile(path.join(repository, 'working.txt'), 'Working change\n');

  await git.createStash({
    message: 'Garder index',
    keepIndex: true,
    files: ['README.md', 'working.txt'],
  });

  const status = await git.status();
  assert.equal(status.files.find((file) => file.path === 'README.md')?.staged, true);
  assert.equal(status.files.some((file) => file.path === 'working.txt'), false);
});

test('pops a stash and removes it from the list', async () => {
  await fs.appendFile(path.join(repository, 'README.md'), 'Pop change\n');
  await git.createStash({ message: 'À réappliquer', files: ['README.md'] });

  const restored = await git.restoreStash('stash@{0}', 'pop');

  assert.equal(restored.conflicted, false);
  assert.equal((await git.stashes()).length, 0);
  assert.match(await fs.readFile(path.join(repository, 'README.md'), 'utf8'), /Pop change/);
});

test('renames an existing stash without losing its content', async () => {
  await fs.appendFile(path.join(repository, 'README.md'), 'First stash change\n');
  await git.createStash({ message: 'Premier message', files: ['README.md'] });
  await fs.appendFile(path.join(repository, 'README.md'), 'Second stash change\n');
  await git.createStash({ message: 'Deuxième message', files: ['README.md'] });

  await git.renameStash('stash@{1}', 'Message renommé');

  const stashes = await git.stashes();
  const renamed = stashes.find((stash) => stash.message === 'Message renommé');
  assert.equal(stashes.length, 2);
  assert.ok(renamed);
  assert.equal(renamed.branch, 'main');
  assert.match(await git.stashDiff(renamed.ref), /First stash change/);
  await assert.rejects(() => git.renameStash(renamed.ref, '   '), /message du stash est invalide/);
});

test('applies only selected tracked files from a stash', async () => {
  await fs.writeFile(path.join(repository, 'other.txt'), 'Original\n');
  await git.stage(['other.txt']);
  await git.commit('Add other file');
  await fs.appendFile(path.join(repository, 'README.md'), 'Selected change\n');
  await fs.appendFile(path.join(repository, 'other.txt'), 'Other change\n');
  await git.createStash({ message: 'Deux fichiers', files: ['README.md', 'other.txt'] });

  const restored = await git.restoreStash('stash@{0}', 'apply', ['README.md']);
  const status = await git.status();

  assert.equal(restored.partial, true);
  assert.deepEqual(status.files.map((file) => file.path), ['README.md']);
  assert.match(await fs.readFile(path.join(repository, 'README.md'), 'utf8'), /Selected change/);
  assert.doesNotMatch(await fs.readFile(path.join(repository, 'other.txt'), 'utf8'), /Other change/);
  assert.equal((await git.stashes()).length, 1);
});

test('applies a selected untracked file from a stash without staging it', async () => {
  await fs.writeFile(path.join(repository, 'new.txt'), 'Untracked stash file\n');
  await git.createStash({ message: 'Fichier non suivi', includeUntracked: true, files: ['new.txt'] });

  const restored = await git.restoreStash('stash@{0}', 'apply', ['new.txt']);
  const status = await git.status();

  assert.equal(restored.partial, true);
  assert.equal(await fs.readFile(path.join(repository, 'new.txt'), 'utf8'), 'Untracked stash file\n');
  assert.equal(status.files[0].path, 'new.txt');
  assert.equal(status.files[0].untracked, true);
  assert.equal(status.files[0].staged, false);
});

test('refuses to apply a stash while the index contains changes', async () => {
  await fs.appendFile(path.join(repository, 'README.md'), 'Stash change\n');
  await git.createStash({ message: 'À appliquer', files: ['README.md'] });
  await fs.writeFile(path.join(repository, 'indexed.txt'), 'Indexed\n');
  await git.stage(['indexed.txt']);

  await assert.rejects(() => git.restoreStash('stash@{0}', 'apply'), /fichiers sont indexés/);
  assert.equal((await git.stashes()).length, 1);
});

test('returns conflicted files when applying a stash causes conflicts', async () => {
  await fs.writeFile(path.join(repository, 'README.md'), '# Version stash\n');
  await git.createStash({ message: 'Version stash', files: ['README.md'] });
  await fs.writeFile(path.join(repository, 'README.md'), '# Version branche\n');
  await git.stage(['README.md']);
  await git.commit('Change same line');

  const restored = await git.restoreStash('stash@{0}', 'apply');

  assert.equal(restored.conflicted, true);
  assert.deepEqual(restored.conflicts, ['README.md']);
  assert.equal((await git.status()).files[0].conflicted, true);
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

test('initializes and clones repositories', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'forkline-create-'));
  try {
    const initialized = new GitService();
    await initialized.initialize(path.join(workspace, 'initialized'), 'develop');
    assert.equal((await initialized.snapshot()).head, 'develop');
    assert.deepEqual((await initialized.snapshot()).commits, []);

    await git.createBranch('feature/remote-checkout');
    await fs.writeFile(path.join(repository, 'remote-feature.txt'), 'Remote feature\n');
    await git.stage(['remote-feature.txt']);
    await git.commit('Remote feature');
    await git.switchBranch('main');

    const cloned = new GitService();
    await cloned.clone(repository, path.join(workspace, 'cloned'));
    let snapshot = await cloned.snapshot();
    assert.equal(snapshot.head, 'main');
    assert.equal(snapshot.commits.some((commit) => commit.subject === 'Initial commit'), true);
    await cloned.checkoutRemoteBranch('origin/feature/remote-checkout');
    snapshot = await cloned.snapshot();
    assert.equal(snapshot.head, 'feature/remote-checkout');
    assert.equal(snapshot.commits[0].subject, 'Remote feature');
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('adds, inspects, deinitializes and updates a submodule', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'forkline-submodule-'));
  const sourcePath = path.join(workspace, 'source');
  try {
    const source = new GitService();
    await source.initialize(sourcePath, 'main');
    await exec('git', ['-C', sourcePath, 'config', 'user.name', 'Submodule Test'], { encoding: 'utf8' });
    await exec('git', ['-C', sourcePath, 'config', 'user.email', 'submodule@example.test'], { encoding: 'utf8' });
    await fs.writeFile(path.join(sourcePath, 'module.txt'), 'Module\n');
    await source.stage(['module.txt']);
    await source.commit('Submodule initial');

    await git.addSubmodule(sourcePath, 'modules/source');
    let submodules = await git.submodules();
    assert.equal(submodules.length, 1);
    assert.equal(submodules[0].initialized, true);
    assert.equal(submodules[0].expectedHash, submodules[0].currentHash);

    await fs.appendFile(path.join(repository, 'modules/source/module.txt'), 'Dirty\n');
    submodules = await git.submodules();
    assert.equal(submodules[0].dirty, true);
    await fs.writeFile(path.join(repository, 'modules/source/module.txt'), 'Module\n');

    await git.deinitializeSubmodule('modules/source', true);
    assert.equal((await git.submodules())[0].initialized, false);
    await git.updateSubmodule('modules/source');
    assert.equal((await git.submodules())[0].initialized, true);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('creates and removes a secondary worktree safely', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'forkline-worktree-'));
  const worktreePath = path.join(workspace, 'feature-worktree');
  try {
    await git.createBranch('feature/worktree');
    await git.switchBranch('main');
    await git.addWorktree(worktreePath, 'feature/worktree', false, 'HEAD');

    let worktrees = await git.worktrees();
    assert.equal(worktrees.length, 2);
    assert.equal(worktrees.find((entry) => entry.path === worktreePath)?.branch, 'feature/worktree');
    assert.equal(worktrees.filter((entry) => entry.main).length, 1);

    await git.removeWorktree(worktreePath);
    worktrees = await git.worktrees();
    assert.equal(worktrees.length, 1);
    assert.equal(worktrees[0].main, true);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('initializes Git Flow and completes a feature', async () => {
  const config = await git.initializeGitFlow({ master: 'main', develop: 'develop' });
  assert.equal(config.initialized, true);
  assert.equal(config.master, 'main');
  assert.equal(config.develop, 'develop');

  assert.equal(await git.startGitFlow('feature', 'account'), 'feature/account');
  await fs.writeFile(path.join(repository, 'account.txt'), 'Account\n');
  await git.stage(['account.txt']);
  await git.commit('Add account feature');
  const result = await git.finishGitFlow('feature', 'feature/account');

  assert.equal(result.conflicted, false);
  const snapshot = await git.snapshot();
  assert.equal(snapshot.head, 'develop');
  assert.equal(snapshot.branches.some((branch) => branch.name === 'feature/account'), false);
  assert.equal(await fs.readFile(path.join(repository, 'account.txt'), 'utf8'), 'Account\n');
});

test('completes a Git Flow release into production and development', async () => {
  await git.initializeGitFlow({ master: 'main', develop: 'develop' });
  await git.startGitFlow('release', '1.2.0');
  await fs.writeFile(path.join(repository, 'release.txt'), 'Release\n');
  await git.stage(['release.txt']);
  await git.commit('Prepare release 1.2.0');
  const releaseHash = (await git.snapshot()).headHash;

  const result = await git.finishGitFlow('release', 'release/1.2.0');

  assert.equal(result.conflicted, false);
  assert.equal((await git.snapshot()).head, 'develop');
  assert.equal((await command(['merge-base', '--is-ancestor', releaseHash, 'main'])).stdout, '');
  assert.equal((await command(['merge-base', '--is-ancestor', releaseHash, 'develop'])).stdout, '');
  assert.equal((await command(['rev-parse', '1.2.0^{commit}'])).stdout.trim(), (await command(['rev-parse', 'main'])).stdout.trim());
  assert.equal((await git.branches()).some((branch) => branch.name === 'release/1.2.0'), false);
});

test('starts a Git Flow support branch from an explicit historical base', async () => {
  await git.initializeGitFlow({ master: 'main', develop: 'develop' });
  const baseHash = (await git.snapshot()).headHash;
  await git.createTag('1.0.0', baseHash, 'Version 1.0.0');
  await fs.writeFile(path.join(repository, 'newer.txt'), 'Newer development\n');
  await git.stage(['newer.txt']);
  await git.commit('Newer development');

  const branch = await git.startGitFlow('support', '1.x', '1.0.0');

  assert.equal(branch, 'support/1.x');
  assert.equal(await git.head(), 'support/1.x');
  assert.equal((await git.snapshot()).headHash, baseHash);
});

test('exports a commit as an applicable email patch', async () => {
  const snapshot = await git.snapshot();
  const patch = await git.createCommitPatch(snapshot.headHash);

  assert.match(patch, /^From [0-9a-f]{40} /m);
  assert.match(patch, /^Subject: \[PATCH\] /m);
  assert.match(patch, /^diff --git /m);
});

test('exports selected commits in dependency order and applies the resulting patch', async () => {
  const initialHash = (await git.snapshot()).headHash;
  await fs.writeFile(path.join(repository, 'first-patch.txt'), 'First\n');
  await git.stage(['first-patch.txt']);
  await git.commit('First patch commit');
  const firstHash = (await git.snapshot()).headHash;
  await fs.writeFile(path.join(repository, 'second-patch.txt'), 'Second\n');
  await git.stage(['second-patch.txt']);
  await git.commit('Second patch commit');
  const secondHash = (await git.snapshot()).headHash;

  const patch = await git.createCommitPatch([secondHash, firstHash]);
  await git.resetToCommit(initialHash, 'hard');
  const result = await git.applyPatch(patch);

  assert.equal(result.conflicted, false);
  assert.deepEqual((await git.commits()).slice(0, 2).map((commit) => commit.subject), ['Second patch commit', 'First patch commit']);
  assert.equal(await fs.readFile(path.join(repository, 'first-patch.txt'), 'utf8'), 'First\n');
  assert.equal(await fs.readFile(path.join(repository, 'second-patch.txt'), 'utf8'), 'Second\n');
});

test('exposes and continues conflicts created while applying a patch', async () => {
  const initialHash = (await git.snapshot()).headHash;
  await fs.writeFile(path.join(repository, 'README.md'), '# Patch version\n');
  await git.stage(['README.md']);
  await git.commit('Patch README');
  const patch = await git.createCommitPatch((await git.snapshot()).headHash);

  await git.resetToCommit(initialHash, 'hard');
  await fs.writeFile(path.join(repository, 'README.md'), '# Local version\n');
  await git.stage(['README.md']);
  await git.commit('Local README');
  const result = await git.applyPatch(patch);

  assert.equal(result.conflicted, true);
  assert.deepEqual(result.conflicts, ['README.md']);
  assert.equal((await git.operationState()).type, 'am');
  await git.resolveConflictContent('README.md', '# Resolved version\n');
  const continued = await git.continueOperation('am');
  assert.equal(continued.conflicted, false);
  assert.equal(await git.operationState(), null);
  assert.equal(await fs.readFile(path.join(repository, 'README.md'), 'utf8'), '# Resolved version\n');
});
