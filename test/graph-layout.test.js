const test = require('node:test');
const assert = require('node:assert/strict');
const { layoutCommitGraph } = require('../src/renderer/graph-layout');

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
