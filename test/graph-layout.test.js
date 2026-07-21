const test = require('node:test');
const assert = require('node:assert/strict');
const {
  filterGraphVisibility, layoutCommitGraph, stashDisplayIndex, stashVisibilityAfterAction,
} = require('../src/renderer/graph-layout');

test('keeps descendant branch tips parallel to the active branch until HEAD', () => {
  const graph = layoutCommitGraph([
    { hash: 'master-tip', parents: ['between'] },
    { hash: 'between', parents: ['feature-tip'] },
    { hash: 'feature-tip', parents: ['active-tip'] },
    { hash: 'active-tip', parents: ['root'] },
    { hash: 'root', parents: [] },
  ], {
    headHash: 'active-tip',
    showWorkingTree: true,
    branches: [
      { name: 'master', hash: 'master-tip', current: false },
      { name: 'feature/new', hash: 'feature-tip', current: false },
      { name: 'work', hash: 'active-tip', current: true },
    ],
  });

  assert.deepEqual(graph.rows.map((row) => row.lane), [1, 1, 1, 0, 0]);
  assert.equal(graph.laneCount, 2);
  assert.deepEqual(graph.rows[2].connections.map(({ from, to }) => [from, to]), [[1, 0]]);
  assert.deepEqual(graph.workingTreeNode, { type: 'WorkingTreeNode', lane: 0, commitIndex: 3, position: 'top' });
});

test('keeps a linear history in one lane', () => {
  const graph = layoutCommitGraph([
    { hash: 'c', parents: ['b'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] },
  ]);

  assert.equal(graph.laneCount, 1);
  assert.deepEqual(graph.rows.map((row) => row.lane), [0, 0, 0]);
  assert.deepEqual(graph.rows.map((row) => row.anchorHash), ['c', 'b', 'a']);
});

test('draws a second lane for a merge parent and rejoins it', () => {
  const graph = layoutCommitGraph([
    { hash: 'merge', parents: ['main', 'feature'] },
    { hash: 'feature', parents: ['base'] },
    { hash: 'main', parents: ['base'] },
    { hash: 'base', parents: [] },
  ]);

  assert.equal(graph.laneCount, 2);
  assert.deepEqual(graph.rows[0].connections.map(({ from, to }) => [from, to]), [[0, 0], [0, 1]]);
  assert.equal(graph.rows[1].lane, 1);
  assert.equal(graph.rows[2].lane, 0);
  assert.ok(graph.rows[2].connections.some(({ to }) => to === 1));
  assert.deepEqual(graph.rows[2].transitions, [{ from: 1, to: 0, hash: 'base' }]);
  assert.equal(graph.rows[3].lane, 0);
});

test('allocates separate lanes to independent branch tips', () => {
  const graph = layoutCommitGraph([
    { hash: 'tip-a', parents: ['root'] },
    { hash: 'tip-b', parents: ['root'] },
    { hash: 'root', parents: [] },
  ]);

  assert.equal(graph.laneCount, 2);
  assert.equal(graph.rows[1].startsHere, true);
});

test('keeps the active branch vertical while a sibling branch rejoins it', () => {
  const graph = layoutCommitGraph([
    { hash: 'source-tip', parents: ['base'] },
    { hash: 'active-tip', parents: ['base'] },
    { hash: 'base', parents: ['root'] },
    { hash: 'root', parents: [] },
  ], { headHash: 'active-tip', showWorkingTree: true });

  assert.deepEqual(graph.rows.map((row) => row.lane), [1, 0, 0, 0]);
  assert.deepEqual(graph.rows[1].connections.map(({ from, to }) => [from, to]), [[0, 0]]);
  assert.deepEqual(graph.rows[1].joins.map(({ from, to, hash }) => [from, to, hash]), [[1, 0, 'base']]);
  assert.deepEqual(graph.rows[1].transitions, []);
});

test('keeps the complete first-parent chain of HEAD in lane zero', () => {
  const graph = layoutCommitGraph([
    { hash: 'head-tip', parents: ['previous-head'] },
    { hash: 'source-tip', parents: ['base'] },
    { hash: 'previous-head', parents: ['base'] },
    { hash: 'base', parents: ['root'] },
    { hash: 'root', parents: [] },
  ], { headHash: 'head-tip', showWorkingTree: true });

  assert.deepEqual(graph.rows.map((row) => row.lane), [0, 1, 0, 0, 0]);
  assert.deepEqual(graph.rows[2].connections.map(({ from, to }) => [from, to]), [[0, 0]]);
  assert.deepEqual(graph.rows[2].joins.map(({ from, to, hash }) => [from, to, hash]), [[1, 0, 'base']]);
  assert.deepEqual(graph.rows[2].transitions, []);
  assert.deepEqual(graph.workingTreeNode, { type: 'WorkingTreeNode', lane: 0, commitIndex: 0, position: 'top' });
});

test('assigns a fresh color when a freed lane is reused by another branch', () => {
  const graph = layoutCommitGraph([
    { hash: 'feature-tip', parents: [] },
    { hash: 'master-tip', parents: [] },
  ]);

  assert.equal(graph.rows[0].lane, 0);
  assert.equal(graph.rows[1].lane, 0);
  assert.notEqual(graph.rows[0].laneColor, graph.rows[1].laneColor);
});


test('exposes a dedicated working tree node on the checked out HEAD lane', () => {
  const graph = layoutCommitGraph([
    { hash: 'other', parents: ['root'] },
    { hash: 'head', parents: ['root'] },
    { hash: 'root', parents: [] },
  ], { headHash: 'head', showWorkingTree: true });

  assert.deepEqual(graph.workingTreeNode, {
    type: 'WorkingTreeNode',
    lane: 0,
    commitIndex: 1,
    position: 'top',
  });
  assert.equal(graph.rows.length, 3);
});

test('does not expose a working tree node when the worktree is clean', () => {
  const graph = layoutCommitGraph([{ hash: 'head', parents: [] }], {
    headHash: 'head',
    showWorkingTree: false,
  });

  assert.equal(graph.workingTreeNode, null);
});

test('keeps detached HEAD separate from the branch that owns an auto stash', () => {
  const graph = layoutCommitGraph([
    { hash: 'master-tip', parents: ['middle'] },
    { hash: 'middle', parents: ['detached-head'] },
    { hash: 'detached-head', parents: ['root'] },
    { hash: 'root', parents: [] },
  ], {
    headHash: 'detached-head',
    branches: [
      { name: '(HEAD detached at detached)', hash: 'detached-head' },
      { name: 'master', hash: 'master-tip' },
    ],
  });

  assert.equal(graph.laneCount, 2);
  assert.deepEqual(graph.rows.map((row) => row.lane), [1, 1, 0, 0]);
  assert.deepEqual(graph.rows[0].before, ['detached-head', 'master-tip']);
  assert.deepEqual(graph.rows[1].connections.map(({ from, to }) => [from, to]), [[1, 0]]);
});

test('hides commits that are only reachable from a hidden local branch', () => {
  const commits = [
    { hash: 'feature-tip', parents: ['root'] },
    { hash: 'main-tip', parents: ['root'] },
    { hash: 'root', parents: [] },
  ];
  const visibility = filterGraphVisibility(commits, [
    { name: 'main', hash: 'main-tip', remote: false },
    { name: 'feature/test', hash: 'feature-tip', upstream: 'origin/feature/test', remote: false },
    { name: 'origin/feature/test', hash: 'feature-tip', remote: true },
  ], { hiddenBranchNames: ['feature/test'] });

  assert.deepEqual(visibility.branches.map((branch) => branch.name), ['main']);
  assert.deepEqual(visibility.commits.map((commit) => commit.hash), ['main-tip', 'root']);
  assert.equal(layoutCommitGraph(visibility.commits, { branches: visibility.branches }).laneCount, 1);
});

test('solo keeps the selected branch, its upstream and their shared history', () => {
  const visibility = filterGraphVisibility([
    { hash: 'feature-tip', parents: ['root'] },
    { hash: 'main-tip', parents: ['root'] },
    { hash: 'stash-node', parents: ['feature-tip'], stashRef: 'stash@{0}' },
    { hash: 'root', parents: [] },
  ], [
    { name: 'main', hash: 'main-tip', remote: false },
    { name: 'feature/test', hash: 'feature-tip', upstream: 'origin/feature/test', remote: false },
    { name: 'origin/main', hash: 'main-tip', remote: true },
    { name: 'origin/feature/test', hash: 'feature-tip', remote: true },
  ], { soloBranchName: 'feature/test' });

  assert.deepEqual(visibility.branches.map((branch) => branch.name), ['feature/test', 'origin/feature/test']);
  assert.deepEqual(visibility.commits.map((commit) => commit.hash), ['feature-tip', 'root']);
});

test('places a stash chronologically below newer commits and above its base', () => {
  const commits = [
    { hash: 'newest', committerDate: '2026-07-21T10:16:26+02:00' },
    { hash: 'newer', committerDate: '2026-07-21T10:11:36+02:00' },
    { hash: 'older-head', committerDate: '2026-07-20T16:17:29+02:00' },
    { hash: 'base', committerDate: '2026-07-16T12:00:00+02:00' },
  ];

  assert.equal(stashDisplayIndex(commits, { date: '2026-07-21T08:58:34+02:00' }, 3), 2);
  assert.equal(stashDisplayIndex(commits, { date: '2026-07-15T08:58:34+02:00' }, 3), 3);
});

test('toggles one stash visibility in both directions like GitKraken', () => {
  const hidden = stashVisibilityAfterAction([], 'toggle-visibility', 'stash-a', ['stash-a', 'stash-b']);
  assert.deepEqual(hidden, ['stash-a']);
  assert.deepEqual(stashVisibilityAfterAction(hidden, 'toggle-visibility', 'stash-a', ['stash-a', 'stash-b']), []);
});

test('hides and shows every stash while removing stale visibility entries', () => {
  const hidden = stashVisibilityAfterAction(['deleted-stash'], 'hide-all', null, ['stash-a', 'stash-b']);
  assert.deepEqual(hidden.sort(), ['stash-a', 'stash-b']);
  assert.deepEqual(stashVisibilityAfterAction(hidden, 'show-all', null, ['stash-a', 'stash-b']), []);
});
