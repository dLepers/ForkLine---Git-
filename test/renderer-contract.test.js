const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const renderer = read('src/renderer/app.js');
const styles = read('src/renderer/styles.css');
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

test('commit graph nodes expose a GitKraken-style author tooltip', () => {
  assert.match(renderer, /class="commit-node-target" data-commit-node="\$\{escapeHtml\(commit\.hash\)\}"/);
  assert.match(renderer, /class="commit-node-hit-area"/);
  assert.match(renderer, /function bindGraphNodeTooltips\(\)/);
  assert.match(renderer, /node\.addEventListener\('pointerenter', \(event\) => showGraphNodeTooltip\(commit, event\)\)/);
  assert.match(renderer, /<span>AUTEUR DU COMMIT<\/span><strong>\$\{escapeHtml\(commit\.author \|\| 'Auteur inconnu'\)\}<\/strong>/);
  assert.match(renderer, /commit\.email \? `<small>\$\{escapeHtml\(commit\.email\)\}<\/small>` : ''/);
  assert.match(renderer, /const commitDate = commit\.date \? new Date\(commit\.date\)\.toLocaleString\('fr'\) : ''/);
  assert.match(renderer, /commitDate \? `<time>\$\{escapeHtml\(commitDate\)\}<\/time>` : ''/);
  assert.match(renderer, /bindGraphNodeTooltips\(\);/);
  assert.doesNotMatch(styles, /\.commit-node-target\s*\{[^}]*cursor:\s*help/);
});

test('double-clicking a local graph branch checks it out without selecting the commit row', () => {
  assert.match(renderer, /function bindGraphBranchInteractions\(\)/);
  assert.match(renderer, /label\.addEventListener\('click', \(event\) => \{[\s\S]*event\.stopPropagation\(\)/);
  assert.match(renderer, /label\.addEventListener\('dblclick', \(event\) => \{[\s\S]*switchBranch\(label\.dataset\.graphBranch\)/);
  assert.match(renderer, /label\.addEventListener\('contextmenu'/);
  assert.match(renderer, /bindGraphBranchInteractions\(\);/);
  assert.match(styles, /\.branch-label\[data-graph-branch\][^{]*\{[^}]*cursor:\s*pointer/);
});

test('merge conflicts open a dedicated GitKraken-style inspector with complete actions', () => {
  assert.match(html, /id="conflict-detail"/);
  assert.match(renderer, /activeConflicts && !options\.preserveInspector[^\n]*showInspector\('#conflict-detail'\)/);
  assert.match(renderer, /Fichiers en conflit \(\$\{conflicted\.length\}\)/);
  assert.match(renderer, /Fichiers résolus \(\$\{resolved\.length\}\)/);
  assert.match(renderer, /id="resolve-all-conflicts"/);
  assert.match(renderer, /window\.forkline\.resolveAllConflicts\(\)/);
  assert.match(renderer, /window\.forkline\.continueOperation\(operation\.type, \{ message \}\)/);
  assert.match(renderer, /window\.forkline\.abortOperation\(operation\.type\)/);
  assert.match(preload, /resolveAllConflicts: \(\) => invoke\('repository:resolve-all-conflicts'\)/);
});

test('conflicted operations keep the graph topology visible without a WIP badge', () => {
  assert.match(renderer, /renderWorkingTreeRow\(graph\.workingTreeNode, displayLaneCount, graphWidth, operation, graphLaneShift\)/);
  assert.match(renderer, /class="conflict-working-tree-node"/);
  assert.match(renderer, /Des conflits ont été détectés pendant la fusion dans/);
});

test('the working tree row displays a GitKraken-style WIP summary by change type', () => {
  assert.match(renderer, /function workingTreeChangeCounts\(files\)/);
  assert.match(renderer, /file\.untracked \|\| file\.index === 'A' \|\| file\.workingTree === 'A'/);
  assert.match(renderer, /file\.index === 'D' \|\| file\.workingTree === 'D'/);
  assert.match(renderer, /class="working-tree-wip">\/\/ WIP/);
  assert.match(renderer, /class="wip-stat modified"/);
  assert.match(renderer, /class="wip-stat added"/);
  assert.match(renderer, /class="wip-stat deleted"/);
  assert.match(renderer, /renderWorkingTreeSummary\(state\.snapshot\.status\.files\)/);
  assert.doesNotMatch(renderer, /working-tree-badge-text/);
});

test('resolved conflicts leave conflict mode while keeping the Git operation available', () => {
  assert.match(renderer, /function hasActiveConflicts\(snapshot = state\.snapshot\)/);
  assert.match(renderer, /snapshot\?\.operation && snapshot\.status\?\.files\?\.some\(\(file\) => file\.conflicted\)/);
  assert.match(renderer, /!activeConflicts && \(conflictWasVisible \|\| snapshot\.operation\)[^\n]*showInspector\('#worktree-detail'\)/);
  assert.match(renderer, /const operation = activeConflicts \? state\.snapshot\.operation : null/);
  assert.match(renderer, /showInspector\(hasActiveConflicts\(\) \? '#conflict-detail' : '#worktree-detail'\)/);
  assert.doesNotMatch(renderer, /state\.snapshot\.operation \? '#conflict-detail' : '#worktree-detail'/);
  assert.match(renderer, /hasActiveConflicts\(snapshot\)[^\n]*\{\s*showInspector\('#conflict-detail'\)[\s\S]*snapshot\.operation[^\n]*\{\s*showInspector\('#worktree-detail'\)/);
  assert.match(renderer, /Tous les conflits sont résolus\. Vérifiez les modifications indexées puis terminez l’opération\./);
  assert.match(renderer, /operation && !activeConflicts[\s\S]*window\.forkline\.continueOperation\(operation\.type, \{ message \}\)/);
  assert.match(renderer, /operation && !activeConflicts \? \(operation\.type === 'merge' \? 'Terminer la fusion'/);
});

test('aborting an operation clearly warns that conflict resolutions are destructive', () => {
  assert.match(renderer, /function confirmAbortOperation\(operation\)/);
  assert.match(renderer, /Toutes les résolutions réalisées pendant cette opération seront perdues/);
  assert.match(renderer, /Git tentera de restaurer les modifications locales présentes avant son démarrage/);
  assert.match(renderer, /if \(mode === 'abort' && !confirmAbortOperation\(operation\)\) return/);
  assert.match(renderer, /if \(!operation \|\| !confirmAbortOperation\(operation\)\) return/);
  assert.match(renderer, /Abandonner la fusion…/);
});

test('the conflict editor follows GitKraken A/B selection and safe-save behavior', () => {
  assert.match(renderer, /class="merge-editor-columns"/);
  assert.match(renderer, /data-conflict-all="ours"/);
  assert.match(renderer, /data-conflict-all="theirs"/);
  assert.match(renderer, /data-conflict-side="\$\{side\}" data-conflict-index/);
  assert.match(renderer, /selection\.ours \|\| selection\.theirs/);
  assert.match(renderer, /selectedConflictContent\(resolution\)/);
  assert.doesNotMatch(renderer, /id="open-external-merge-tool"/);
  assert.doesNotMatch(renderer, /Ouvrir dans l’outil de fusion externe/);
  assert.doesNotMatch(renderer, /class="conflict-columns"/);
  assert.doesNotMatch(renderer, /id="conflict-result-content"/);
});

test('the conflict editor renders a live GitKraken-style Output panel', () => {
  assert.match(renderer, /activeConflictIndex: 0/);
  assert.match(renderer, /function conflictOutputRows\(resolution\)/);
  assert.match(renderer, /function renderConflictOutput\(resolution\)/);
  assert.match(renderer, /class="merge-output"/);
  assert.match(renderer, />Output</);
  assert.match(renderer, /conflit \$\{activeIndex \+ 1\} sur \$\{resolution\.hunks\.length\}/);
  assert.match(renderer, /data-conflict-navigation="previous"/);
  assert.match(renderer, /data-conflict-navigation="next"/);
  assert.match(renderer, /id="reset-conflict-output"/);
  assert.match(renderer, /state\.conflictResolution\.selections\.forEach\(\(selection\) => \{[\s\S]*selection\.ours = false;[\s\S]*selection\.theirs = false;[\s\S]*state\.conflictResolution\.activeConflictIndex = 0/);
  assert.match(renderer, /selection\.ours\) append\(hunk\.ours, 'ours', conflictIndex\)/);
  assert.match(renderer, /selection\.theirs\) append\(hunk\.theirs, 'theirs', conflictIndex\)/);
});

test('the conflict editor exposes per-file and repository conflict counts', () => {
  assert.match(renderer, /const conflictedFileCount = state\.snapshot\.status\.files\.filter\(\(statusFile\) => statusFile\.conflicted\)\.length/);
  assert.match(renderer, /conflit\$\{hunks\.length > 1 \? 's' : ''\} dans ce fichier/);
  assert.match(renderer, /fichier\$\{conflictedFileCount > 1 \? 's' : ''\} en conflit au total/);
  assert.match(renderer, /class="merge-conflict-count"/);
  assert.match(renderer, /aria-label="\$\{conflictLabel\}, \$\{conflictedFileLabel\}"/);
});

test('the Output panel can be resized with pointer and keyboard controls', () => {
  assert.match(renderer, /conflictOutputHeight: null/);
  assert.match(renderer, /class="merge-output-resizer" role="separator"/);
  assert.match(renderer, /function setConflictOutputHeight\(requestedHeight\)/);
  assert.match(renderer, /availableHeight - minimumPaneHeight/);
  assert.match(renderer, /addEventListener\('pointerdown'/);
  assert.match(renderer, /addEventListener\('pointermove', move\)/);
  assert.match(renderer, /\['ArrowUp', 'ArrowDown', 'Home', 'End'\]/);
  assert.match(renderer, /addEventListener\('dblclick', resetConflictOutputHeight\)/);
  assert.match(renderer, /bindConflictOutputResizer\(\)/);
});

test('worktree inspector separates staged and unstaged file groups', () => {
  const styles = read('src/renderer/styles.css');
  assert.match(renderer, /worktree-file-group worktree-file-group-unstaged[\s\S]*id="worktree-unstaged-files"/);
  assert.match(renderer, /worktree-file-group worktree-file-group-staged[\s\S]*id="worktree-staged-files"/);
  assert.match(styles, /\.worktree-file-group \{[^}]*border-block:[^}]*background:/);
  assert.match(styles, /\.worktree-file-group \+ \.worktree-file-group \{[^}]*margin-top:/);
  assert.match(styles, /\.worktree-file-group-unstaged \{[^}]*background: rgba\(209,162,76,/);
  assert.match(styles, /\.worktree-file-group-staged \{[^}]*background: rgba\(85,188,130,/);
  assert.match(styles, /\.worktree-file-group-unstaged h4 \{[^}]*border-left-color:/);
  assert.match(styles, /\.worktree-file-group-staged h4 \{[^}]*border-left-color:/);
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

test('contextual tag creation uses a shared validated dialog and selected revision', () => {
  assert.match(renderer, /createTagAt\(branch\.hash, operation === 'annotated-tag', branch\.name\)/);
  assert.match(renderer, /createTagAt\(commit\.hash, operation === 'annotated-tag', commit\.shortHash\)/);
  assert.match(renderer, /window\.forkline\.createTag\(name, state\.tagCreation\.revision, message\)/);
  assert.match(html, /id="tag-dialog"/);
  assert.match(html, /id="tag-error"[^>]*role="alert"/);
});

test('stash rows preserve every active graph lane', () => {
  const stashRenderer = renderer.match(/function renderStashGraphRow[\s\S]*?(?=\nfunction renderWorkingTreeRow)/)?.[0] || '';
  assert.match(stashRenderer, /topRow\.before\.map/);
  assert.match(stashRenderer, /topRow\.beforeColors\[lane\]/);
  assert.match(stashRenderer, /stash-lane-continuation/);
  assert.match(stashRenderer, /stash-route/);
  assert.match(stashRenderer, /class="stash-node" data-stash-node=/);
});

test('stash rows sit below WIP and route back to their base commit', () => {
  const commitRenderer = renderer.match(/function renderCommits\(\)[\s\S]*?(?=\nfunction toggleCommitComparison)/)?.[0] || '';
  assert.match(commitRenderer, /baseIndex = commits\.findIndex\(\(commit\) => commit\.hash === stash\.baseHash\)/);
  assert.match(commitRenderer, /data-stash-base-hash=/);
  assert.match(commitRenderer, /\.map\(\(placement, index\) => \(\{ \.\.\.placement, lane: index \}\)\)/);
  assert.match(commitRenderer, /const graphLaneShift = stashPlacements\.length/);
  assert.ok(commitRenderer.indexOf('working-tree-row') < commitRenderer.indexOf('stashPlacements.forEach'));
  assert.ok(commitRenderer.indexOf('stashPlacements.forEach') < commitRenderer.indexOf('commits.forEach'));
  assert.match(renderer, /stash-base-connection/);
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
  assert.match(renderer, /operation === 'solo'[\s\S]*renderBranches\(\);[\s\S]*renderRemotes\(\);[\s\S]*renderCommits\(\)/);
  assert.match(renderer, /operation === 'hide'[\s\S]*saveHiddenBranchNames\(\);[\s\S]*renderCommits\(\)/);
  assert.match(renderer, /data-graph-branch/);
  assert.match(renderer, /showBranchContextMenu\(label\.dataset\.graphBranch/);
});

test('solo mode isolates local and remote sidebars and can restore every branch', () => {
  assert.match(renderer, /!state\.soloBranchName \|\| branch\.name === state\.soloBranchName/);
  assert.match(renderer, /visibleRemoteNames\.has\(branch\.name\)/);
  assert.match(renderer, /class="solo-mode-status"/);
  assert.match(renderer, /data-branch-visibility="stop-solo"/);
  assert.match(renderer, /branchVisibility === 'stop-solo'\) state\.soloBranchName = null;[\s\S]*renderRemotes\(\)/);
});

test('setting an upstream uses a validated dialog and keeps remote and branch separate', () => {
  assert.match(renderer, /return openUpstreamDialog\(branch\)/);
  assert.match(renderer, /window\.forkline\.setUpstream\(state\.upstreamAssignment\.branch, remote, remoteBranch\)/);
  assert.match(renderer, /remoteBranchNames\(remote\)\.includes\(branch\)/);
  assert.match(html, /id="upstream-dialog"/);
  assert.match(html, /id="upstream-error"[^>]*role="alert"/);
  assert.doesNotMatch(renderer, /prompt\('Branche distante suivie/);
});

test('a first push opens the publish dialog and configures the selected destination', () => {
  const pushToRemote = renderer.match(/async function pushToRemote[\s\S]*?(?=\n\n\$\('#fetch'\))/)?.[0] || '';
  assert.match(renderer, /if \(!upstream\) return openUpstreamDialog\(branch, 'publish', options\)/);
  assert.match(renderer, /window\.forkline\.pushBranch\(state\.upstreamAssignment\.branch, \{ \.\.\.state\.upstreamAssignment\.pushOptions, remote, remoteBranch \}\)/);
  assert.match(renderer, /\$\('#push'\)\.addEventListener\('click', \(\) => pushBranchFromUi/);
  assert.match(renderer, /Forkline créera la branche distante et configurera son suivi/);
  assert.doesNotMatch(pushToRemote, /window\.prompt/);
});

test('renaming a branch uses the selected branch and a validated persistent dialog', () => {
  assert.match(renderer, /return openRenameBranchDialog\(branch\)/);
  assert.match(renderer, /window\.forkline\.renameBranch\(originalName, newName\)/);
  assert.match(renderer, /branchNameError\(value, state\.branchRename\.originalName\)/);
  assert.match(html, /id="rename-branch-dialog"/);
  assert.match(html, /id="rename-branch-error"[^>]*role="alert"/);
  assert.doesNotMatch(renderer, /prompt\('Nouveau nom de la branche/);
});
