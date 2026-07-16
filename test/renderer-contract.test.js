const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const renderer = read('src/renderer/app.js');
const html = read('src/renderer/index.html');
const preload = read('src/preload.js');
const main = read('src/main.js');

function captures(source, expression) {
  return [...source.matchAll(expression)].map((match) => match[1]);
}

test('all static renderer ID selectors refer to declared interface elements', () => {
  const usedIds = new Set(captures(renderer, /\$\('#([A-Za-z][\w-]*)'\)/g));
  const declaredIds = new Set(captures(`${html}\n${renderer}`, /\bid=["']([A-Za-z][\w-]*)["']/g));
  captures(renderer, /\.id\s*=\s*'([A-Za-z][\w-]*)'/g).forEach((id) => declaredIds.add(id));
  const missing = [...usedIds].filter((id) => !declaredIds.has(id)).sort();

  assert.deepEqual(missing, []);
  assert.equal(usedIds.size > 70, true, 'Le test doit couvrir l’essentiel de l’interface renderer.');
});

test('all renderer calls are exposed by the preload bridge', () => {
  const usedMethods = new Set(captures(renderer, /window\.forkline\.([A-Za-z][\w]*)/g));
  const exposedMethods = new Set(captures(preload, /^\s{2}([A-Za-z][\w]*):/gm));
  const missing = [...usedMethods].filter((method) => !exposedMethods.has(method)).sort();

  assert.deepEqual(missing, []);
});

test('all preload IPC invocations have a main-process handler', () => {
  const invokedChannels = new Set(captures(preload, /invoke\('([^']+)'/g));
  const handledChannels = new Set(captures(main, /handle\('([^']+)'/g));
  captures(main, /\['([^']+)',\s*\(value\)\s*=>/g).forEach((suffix) => handledChannels.add(`repository:${suffix}`));
  const missing = [...invokedChannels].filter((channel) => !handledChannels.has(channel)).sort();

  assert.deepEqual(missing, []);
});

test('commit checkout distinguishes branch switching from detached HEAD', () => {
  assert.match(renderer, /const branchCheckoutLabel =[\s\S]*Basculer sur une branche pointant ici/);
  assert.match(renderer, /id: 'checkout-branch'.*label: branchCheckoutLabel/);
  assert.match(renderer, /id: 'checkout'.*Checkout sur ce commit \(HEAD détaché\)/);
  assert.match(renderer, /operation === 'checkout-branch'[\s\S]*await switchBranch\(branchName\)/);
  assert.match(renderer, /operation === 'checkout'[\s\S]*window\.forkline\.checkoutCommit\(commit\.hash\)/);
});

test('contextual branch creation uses the shared dialog and selected revision', () => {
  assert.match(renderer, /operation === 'create'[\s\S]*openBranchDialog\(branchName, branchName\)/);
  assert.match(renderer, /operation === 'create-branch'[\s\S]*openBranchDialog\(commit\.hash, commit\.shortHash\)/);
  assert.match(renderer, /window\.forkline\.createBranch\(name, state\.branchCreation\.startPoint, checkout\)/);
  assert.match(html, /id="branch-checkout"[^>]*checked/);
  assert.match(html, /id="branch-error"[^>]*role="alert"/);
});

test('stash rows preserve every active graph lane', () => {
  const stashRenderer = renderer.match(/function renderStashGraphRow[\s\S]*?(?=\nfunction renderWorkingTreeRow)/)?.[0] || '';
  assert.match(stashRenderer, /row\.before\.map/);
  assert.match(stashRenderer, /row\.beforeColors\[lane\]/);
  assert.match(stashRenderer, /stash-lane-continuation/);
  assert.match(stashRenderer, /stash-upper-stem/);
});

test('branch context actions follow the selected branch state and update graph visibility', () => {
  const branchMenu = renderer.match(/function branchContextActions[\s\S]*?(?=\nfunction closeBranchContextMenu)/)?.[0] || '';
  assert.match(branchMenu, /disabled: sameBranch/);
  assert.match(branchMenu, /canFastForward/);
  assert.match(branchMenu, /id: 'interactive-rebase'/);
  assert.match(branchMenu, /id: 'delete-with-remote'/);
  assert.match(branchMenu, /branch\.upstream === `\$\{remote\.name\}\/\$\{branch\.name\}`/);
  assert.match(branchMenu, /id: 'solo'/);
  assert.match(branchMenu, /id: 'hide'/);
  assert.match(renderer, /operation === 'solo'[\s\S]*renderBranches\(\);[\s\S]*renderCommits\(\)/);
  assert.match(renderer, /operation === 'hide'[\s\S]*saveHiddenBranchNames\(\);[\s\S]*renderCommits\(\)/);
  assert.match(renderer, /data-graph-branch/);
  assert.match(renderer, /showBranchContextMenu\(label\.dataset\.graphBranch/);
});
