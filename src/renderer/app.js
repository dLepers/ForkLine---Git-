const state = {
  snapshot: null,
  view: 'history',
  selectedFile: null,
  selectedCommit: null,
  selectedStash: null,
  hiddenStashHashes: loadHiddenStashHashes(),
  hiddenBranchNames: loadHiddenBranchNames(),
  soloBranchName: null,
  busy: false,
  pendingSnapshot: null,
  historyQuery: '',
  searchRequest: 0,
  rebaseBaseHash: null,
  rebasePlan: [],
  conflictResolution: null,
  compareSelection: [],
  gitProfiles: [],
  assignedProfileId: null,
  profileAssignmentType: null,
  externalEditorCommand: '',
  branchCreation: { startPoint: null, sourceLabel: '' },
  branchRename: { originalName: null, pending: false },
  tagCreation: { revision: null, sourceLabel: '', pending: false },
  upstreamAssignment: { branch: null, mode: 'track', pushOptions: {}, pending: false },
};

function loadHiddenStashHashes() {
  try {
    return new Set(JSON.parse(localStorage.getItem('forkline:hidden-stashes') || '[]'));
  } catch {
    return new Set();
  }
}

function saveHiddenStashHashes() {
  localStorage.setItem('forkline:hidden-stashes', JSON.stringify([...state.hiddenStashHashes]));
}

function loadHiddenBranchNames() {
  try {
    return new Set(JSON.parse(localStorage.getItem('forkline:hidden-branches') || '[]'));
  } catch {
    return new Set();
  }
}

function saveHiddenBranchNames() {
  localStorage.setItem('forkline:hidden-branches', JSON.stringify([...state.hiddenBranchNames]));
}

function graphVisibility() {
  return window.ForklineGraph.filterGraphVisibility(
    state.snapshot?.commits || [],
    state.snapshot?.branches || [],
    { hiddenBranchNames: state.hiddenBranchNames, soloBranchName: state.soloBranchName },
  );
}

function visibleGraphBranches() {
  return graphVisibility().branches;
}

function visibleGraphCommits() {
  return graphVisibility().commits;
}

function isVisibleAncestor(ancestorHash, descendantHash) {
  if (!ancestorHash || !descendantHash || ancestorHash === descendantHash) return ancestorHash === descendantHash;
  const commits = new Map((state.snapshot?.commits || []).map((commit) => [commit.hash, commit]));
  const pending = [descendantHash];
  const visited = new Set();
  while (pending.length) {
    const hash = pending.pop();
    if (hash === ancestorHash) return true;
    if (visited.has(hash)) continue;
    visited.add(hash);
    const commit = commits.get(hash);
    if (commit) pending.push(...commit.parents);
  }
  return false;
}

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function unwrap(result) {
  if (!result?.ok) {
    const error = new Error(result?.error?.message || 'Une erreur est survenue.');
    error.details = result?.error?.details || '';
    throw error;
  }
  return result.data;
}

function toast(message, error = false) {
  const element = document.createElement('div');
  element.className = `toast${error ? ' error' : ''}`;
  element.innerHTML = `<strong>${error ? 'Action impossible' : 'Forkline'}</strong>${escapeHtml(message)}`;
  $('#toast-region').append(element);
  setTimeout(() => element.remove(), error ? 6500 : 3200);
}

async function action(label, callback) {
  if (state.busy) return;
  state.busy = true;
  document.body.style.cursor = 'progress';
  try {
    const result = await callback();
    if (result && label) toast(label);
    return result;
  } catch (error) {
    toast(error.details ? `${error.message}\n${error.details}` : error.message, true);
    return null;
  } finally {
    state.busy = false;
    document.body.style.cursor = '';
    if (state.pendingSnapshot) {
      const snapshot = state.pendingSnapshot;
      state.pendingSnapshot = null;
      queueMicrotask(() => handleRepositoryUpdate(snapshot));
    }
  }
}

function basename(filePath) {
  return filePath.replace(/\\/g, '/').split('/').pop();
}

function relativeTime(dateValue) {
  const seconds = Math.round((new Date(dateValue).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
  const units = [
    ['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(seconds, 'second');
}

function statusLabel(file) {
  if (file.conflicted) return 'C';
  const code = file.staged ? file.index : file.workingTree;
  return code === '?' ? 'N' : code || 'M';
}

function applySnapshot(snapshot, options = {}) {
  if (snapshot.repositoryRevision && state.snapshot?.repositoryRevision >= snapshot.repositoryRevision) return false;
  state.snapshot = snapshot;
  state.compareSelection = state.compareSelection.filter((hash) => snapshot.commits.some((commit) => commit.hash === hash)).slice(-2);
  const repoName = basename(snapshot.repository);
  $('#repo-name').textContent = repoName;
  $('#toolbar-repo-name').textContent = repoName;
  $('#toolbar-branch-name').textContent = snapshot.head;
  $('#repo-title').textContent = `${repoName}  ·  ${snapshot.head}`;
  $('#commit-count').textContent = snapshot.commits.length;
  $('#change-count').textContent = snapshot.status.files.length || '';
  const undoButton = $('#undo');
  undoButton.disabled = !snapshot.undoPlan?.available;
  undoButton.title = snapshot.undoPlan?.available ? `${snapshot.undoPlan.label}${snapshot.undoHistory?.length > 1 ? ` · ${snapshot.undoHistory.length} actions disponibles par clic droit` : ''}` : snapshot.undoPlan?.reason || 'Aucune action à annuler';
  const redoButton = $('#redo');
  redoButton.disabled = !snapshot.redoAvailable;
  redoButton.title = snapshot.redoAvailable ? `Rétablir la dernière action annulée${snapshot.redoHistory?.length > 1 ? ` · ${snapshot.redoHistory.length} actions disponibles par clic droit` : ''}` : 'Aucune action à rétablir';
  if ($('#commit-sign')) $('#commit-sign').checked = Boolean(snapshot.commitPreferences?.gpgSign);
  renderBranches();
  renderStashes();
  renderRemotes();
  renderTags();
  renderIdentity();
  renderSubmodules();
  renderWorktrees();
  renderGitFlow();
  renderLfs();
  refreshGitProfiles();
  if (!options.preserveHistory) renderCommits();
  renderChanges();
  renderWorktreeInspector();
  $('#welcome').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  return true;
}

function renderBranches() {
  const allLocal = state.snapshot.branches.filter((branch) => !branch.remote);
  const existingNames = new Set(allLocal.map((branch) => branch.name));
  let hiddenBranchesChanged = false;
  state.hiddenBranchNames.forEach((name) => {
    if (!existingNames.has(name)) {
      state.hiddenBranchNames.delete(name);
      hiddenBranchesChanged = true;
    }
  });
  const activeBranch = allLocal.find((branch) => branch.current);
  if (activeBranch && state.hiddenBranchNames.delete(activeBranch.name)) hiddenBranchesChanged = true;
  if (hiddenBranchesChanged) saveHiddenBranchNames();
  if (state.soloBranchName && !existingNames.has(state.soloBranchName)) state.soloBranchName = null;
  const local = allLocal.filter((branch) => !state.hiddenBranchNames.has(branch.name) && (!state.soloBranchName || branch.name === state.soloBranchName));
  const commits = visibleGraphCommits();
  const graphBranches = visibleGraphBranches();
  const graph = window.ForklineGraph.layoutCommitGraph(commits, { headHash: state.snapshot.headHash, branches: graphBranches });
  const controls = `${state.soloBranchName ? `<div class="solo-mode-status"><span>MODE SOLO</span><strong>${escapeHtml(state.soloBranchName)}</strong></div><button type="button" class="branch-visibility-action" data-branch-visibility="stop-solo">Afficher toutes les branches</button>` : ''}${state.hiddenBranchNames.size ? `<button type="button" class="branch-visibility-action" data-branch-visibility="show-hidden">Afficher ${state.hiddenBranchNames.size} branche${state.hiddenBranchNames.size > 1 ? 's' : ''} masquée${state.hiddenBranchNames.size > 1 ? 's' : ''}</button>` : ''}`;
  $('#branches').innerHTML = `${local.map((branch) => `
    <button class="branch-item${branch.current ? ' current' : ''}${state.soloBranchName === branch.name ? ' solo' : ''}" style="--branch-color: ${graphColorForHash(graph, branch.hash, commits)}" data-branch="${escapeHtml(branch.name)}" title="${escapeHtml(branchSyncDetails(branch).tooltip)}" aria-label="${escapeHtml(`${branch.name} : ${branchSyncDetails(branch).tooltip}`)}">
      ${branch.current ? '<span class="branch-current" aria-label="Branche active">✓</span>' : ''}<span class="branch-symbol"><i></i></span><span>${escapeHtml(branch.name)}</span>${renderBranchSync(branch)}
    </button>`).join('')}${controls}`;
  $$('.branch-item').forEach((button) => button.addEventListener('click', () => switchBranch(button.dataset.branch)));
  $$('.branch-item').forEach((button) => button.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showBranchContextMenu(button.dataset.branch, event.clientX, event.clientY);
  }));
  $$('[data-branch-visibility]').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.branchVisibility === 'stop-solo') state.soloBranchName = null;
    else {
      state.hiddenBranchNames.clear();
      saveHiddenBranchNames();
    }
    renderBranches();
    renderRemotes();
    renderCommits();
  }));
}

function branchContextActions(branch) {
  const activeBranch = state.snapshot.branches.find((candidate) => !candidate.remote && candidate.current);
  const activeName = activeBranch?.name || state.snapshot.head;
  const sameBranch = branch.current || branch.name === activeName;
  const hasRemote = state.snapshot.remotes?.length > 0;
  const canFastForward = !sameBranch && isVisibleAncestor(state.snapshot.headHash, branch.hash);
  const matchingUpstream = (state.snapshot.remotes || []).some((remote) => branch.upstream === `${remote.name}/${branch.name}`);
  const flowType = gitFlowBranchType(branch.name);
  return [
    { id: 'checkout', icon: '✓', label: `Checkout ${branch.name}`, disabled: sameBranch, disabledReason: 'Cette branche est déjà active.' },
    { id: 'create', icon: '＋', label: 'Créer une branche ici' },
    { id: 'tag', icon: '◇', label: 'Créer un tag ici' },
    { id: 'annotated-tag', icon: '◆', label: 'Créer un tag annoté ici' },
    { separator: true },
    { id: 'merge', icon: '↘', label: `Fusionner ${branch.name} dans ${activeName}`, disabled: sameBranch, disabledReason: 'Impossible de fusionner une branche avec elle-même.' },
    { id: 'rebase', icon: '⇢', label: `Rebaser ${activeName} sur ${branch.name}`, disabled: sameBranch, disabledReason: 'Impossible de rebaser une branche sur elle-même.' },
    { id: 'interactive-rebase', icon: '⇶', label: `Rebase interactif de ${activeName} sur ${branch.name}`, disabled: sameBranch, disabledReason: 'Impossible de rebaser une branche sur elle-même.' },
    ...(canFastForward ? [{ id: 'fast-forward', icon: '↠', label: `Fast-forward ${activeName} vers ${branch.name}` }] : []),
    { id: 'cherry-pick', icon: '⌁', label: `Cherry-pick du dernier commit de ${branch.name}`, disabled: sameBranch, disabledReason: 'Le commit est déjà sur la branche active.' },
    { separator: true },
    { id: 'pull', icon: '↓', label: `Pull ${branch.name}`, disabled: !sameBranch || !branch.upstream, disabledReason: !sameBranch ? 'Checkout cette branche avant le Pull.' : 'Définissez d’abord une branche distante suivie.' },
    { id: 'push', icon: '↑', label: `Push ${branch.name}…`, disabled: !hasRemote, disabledReason: 'Aucun dépôt distant n’est configuré.' },
    { id: 'upstream', icon: '☁', label: 'Définir la branche distante suivie', disabled: !hasRemote, disabledReason: 'Aucun dépôt distant n’est configuré.' },
    { separator: true },
    { id: 'rename', icon: '✎', label: `Renommer ${branch.name}` },
    { id: 'copy', icon: '⧉', label: 'Copier le nom de la branche' },
    { id: 'delete', icon: '⌫', label: `Supprimer ${branch.name}`, danger: true, disabled: sameBranch, disabledReason: 'Impossible de supprimer la branche active.' },
    ...(matchingUpstream && branch.tracking?.state !== 'gone' ? [{ id: 'delete-with-remote', icon: '⌫', label: `Supprimer ${branch.name} et ${branch.upstream}`, danger: true, disabled: sameBranch, disabledReason: 'Impossible de supprimer la branche active.' }] : []),
    { id: 'force-delete', icon: '⌫', label: `Forcer la suppression de ${branch.name}`, danger: true, disabled: sameBranch, disabledReason: 'Impossible de supprimer la branche active.' },
    { separator: true },
    { id: 'compare', icon: '≠', label: 'Comparer avec la copie de travail' },
    { id: 'solo', icon: '◉', label: state.soloBranchName === branch.name ? 'Arrêter le mode Solo' : `Solo ${branch.name}` },
    { id: 'hide', icon: '◌', label: `Masquer ${branch.name}`, disabled: sameBranch, disabledReason: 'La branche active doit rester visible.' },
    ...(flowType && flowType !== 'support' ? [{ separator: true }, { id: 'finish-flow', icon: '✓', label: `Terminer la ${flowType} Git Flow` }] : []),
  ];
}

function closeBranchContextMenu() {
  $('#branch-context-menu')?.remove();
}

function closeCommitContextMenu() {
  $('#commit-context-menu')?.remove();
}

function showBranchContextMenu(branchName, clientX, clientY) {
  console.info('[branch-create] selected branch', JSON.stringify({ branchName, clientX, clientY }));
  closeBranchContextMenu();
  closeCommitContextMenu();
  const menu = document.createElement('div');
  menu.id = 'branch-context-menu';
  menu.className = 'branch-context-menu';
  menu.setAttribute('role', 'menu');
  const branch = state.snapshot.branches.find((candidate) => !candidate.remote && candidate.name === branchName);
  if (!branch) return;
  const actions = branchContextActions(branch);
  menu.innerHTML = `<div class="branch-context-title"><span>BRANCHE</span><strong>${escapeHtml(branchName)}</strong></div>${actions.map((action) => action.separator
    ? '<div class="branch-context-separator"></div>'
    : `<button type="button" role="menuitem" data-branch-action="${action.id}" class="branch-context-action${action.danger ? ' danger' : ''}"${action.disabled ? ` disabled title="${escapeHtml(action.disabledReason || 'Action indisponible.')}"` : ''}><span>${action.icon}</span><span>${escapeHtml(action.label)}</span></button>`).join('')}`;
  document.body.append(menu);
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - bounds.width - 8))}px`;
  menu.style.top = `${Math.max(52, Math.min(clientY, window.innerHeight - bounds.height - 8))}px`;
  menu.querySelectorAll('[data-branch-action]:not(:disabled)').forEach((button) => button.addEventListener('click', () => {
    closeBranchContextMenu();
    runBranchContextAction(button.dataset.branchAction, branchName);
  }));
  menu.querySelector('.branch-context-action:not(:disabled)')?.focus();
}

function commitContextActions(commit) {
  const childCount = state.snapshot.commits.filter((candidate) => candidate.parents.includes(commit.hash)).length;
  const remoteName = state.snapshot.remotes[0]?.name;
  const localBranches = state.snapshot.branches.filter((branch) => !branch.remote && branch.hash === commit.hash);
  const branchCheckoutLabel = localBranches.length === 1
    ? `Basculer sur la branche ${localBranches[0].name}`
    : 'Basculer sur une branche pointant ici';
  return [
    ...(localBranches.length ? [{ id: 'checkout-branch', icon: '✓', label: branchCheckoutLabel, disabled: localBranches.length === 1 && localBranches[0].current, disabledReason: 'Cette branche est déjà active.' }] : []),
    { id: 'checkout', icon: '○', label: 'Checkout sur ce commit (HEAD détaché)' },
    { id: 'create-branch', icon: '＋', label: 'Créer une branche ici' },
    { id: 'cherry-pick', icon: '⌁', label: 'Cherry-pick du commit' },
    { id: 'reset', icon: '↶', label: `Réinitialiser ${state.snapshot.head} sur ce commit`, submenu: true },
    { id: 'revert', icon: '↩', label: 'Revert du commit' },
    { separator: true },
    { id: 'interactive-rebase', icon: '⇢', label: `Rebase interactif depuis ce commit`, disabled: commit.hash === state.snapshot.headHash || childCount === 0 },
    { id: 'amend', icon: '✎', label: 'Modifier le message du commit', disabled: commit.hash !== state.snapshot.headHash },
    { id: 'drop', icon: '⌫', label: 'Supprimer le commit', danger: true, disabled: true, disabledReason: 'Utilisez le rebase interactif pour supprimer ce commit.' },
    { id: 'move-up', icon: '↑', label: 'Déplacer le commit vers le haut', disabled: true, disabledReason: 'Utilisez le rebase interactif pour réordonner les commits.' },
    { separator: true },
    { id: 'copy-sha', icon: '⧉', label: 'Copier le SHA du commit' },
    { id: 'copy-link', icon: '↗', label: `Copier le lien distant${remoteName ? ` : ${remoteName}` : ''}`, disabled: true, disabledReason: 'Nécessite une intégration avec l’hébergeur du dépôt.' },
    { id: 'patch', icon: '▧', label: 'Créer un patch depuis ce commit' },
    { id: 'apply-patch', icon: '▣', label: 'Appliquer un patch…' },
    { id: 'apply-patch-clipboard', icon: '▤', label: 'Appliquer le patch du presse-papiers' },
    { separator: true },
    { id: 'compare', icon: '≠', label: 'Comparer avec la copie de travail' },
    { separator: true },
    { id: 'tag', icon: '◇', label: 'Créer un tag ici' },
    { id: 'annotated-tag', icon: '◆', label: 'Créer un tag annoté ici' },
  ];
}

function showCommitContextMenu(commit, clientX, clientY) {
  console.info('[branch-create] selected commit', JSON.stringify({ hash: commit.hash, shortHash: commit.shortHash, clientX, clientY }));
  closeBranchContextMenu();
  closeCommitContextMenu();
  const menu = document.createElement('div');
  menu.id = 'commit-context-menu';
  menu.className = 'branch-context-menu commit-context-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `<div class="branch-context-title"><span>COMMIT ${escapeHtml(commit.shortHash)}</span><strong>${escapeHtml(commit.subject)}</strong></div>${commitContextActions(commit).map((action) => action.separator
    ? '<div class="branch-context-separator"></div>'
    : `<button type="button" role="menuitem" data-commit-action="${action.id}" class="branch-context-action${action.danger ? ' danger' : ''}"${action.disabled ? ` disabled title="${escapeHtml(action.disabledReason || 'Action indisponible dans ce contexte.')}"` : ''}><span>${action.icon}</span><span>${escapeHtml(action.label)}</span>${action.submenu ? '<b>›</b>' : ''}</button>`).join('')}`;
  document.body.append(menu);
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - bounds.width - 8))}px`;
  menu.style.top = `${Math.max(52, Math.min(clientY, window.innerHeight - bounds.height - 8))}px`;
  menu.querySelectorAll('[data-commit-action]:not(:disabled)').forEach((button) => button.addEventListener('click', () => {
    closeCommitContextMenu();
    runCommitContextAction(button.dataset.commitAction, commit);
  }));
  menu.querySelector('.branch-context-action')?.focus();
}

async function executeRepositoryAction(label, callback) {
  const result = await action('', () => callback().then(unwrap));
  if (!result) return null;
  const snapshot = result.snapshot || result;
  if (snapshot?.commits) applySnapshot(snapshot);
  if (result.conflicted) {
    toast(`Conflits dans ${result.conflicts.length} fichier${result.conflicts.length > 1 ? 's' : ''}. Résolvez-les dans le travail en cours.`, true);
    showInspector('#worktree-detail');
  } else if (label) toast(label);
  return result;
}

async function copyText(value, label) {
  try {
    await navigator.clipboard.writeText(value);
    toast(label);
  } catch {
    toast('Impossible d’accéder au presse-papiers.', true);
  }
}

async function showComparison(revision, title) {
  const diff = await action('', () => window.forkline.compareWorktree(revision).then(unwrap));
  if (diff === null) return;
  state.selectedFile = null;
  state.selectedStash = null;
  $('#history-view').classList.remove('hidden');
  $('#changes-view').classList.add('hidden');
  $('#history-view').innerHTML = `<div class="diff-preview"><header><div><p class="eyebrow">COMPARAISON AVEC LA COPIE DE TRAVAIL</p><h3>${escapeHtml(title)}</h3></div><button id="close-diff-preview" type="button" class="icon-button" title="Fermer l’aperçu">×</button></header><pre id="left-diff-content"></pre></div>`;
  $('#left-diff-content').innerHTML = renderDiffMarkup(diff || 'Aucune différence.', 0, false);
  $('#close-diff-preview').addEventListener('click', closeDiffPreview);
}

async function showRevisionComparison(fromRevision, toRevision, title) {
  const diff = await action('', () => window.forkline.compareRevisions(fromRevision, toRevision).then(unwrap));
  if (diff === null) return;
  showTextPreview('COMPARAISON DE RÉFÉRENCES', title, renderDiffMarkup(diff || 'Aucune différence.', 0, false), true);
}

function showTextPreview(kicker, title, content, isMarkup = false) {
  $('#comparison-bar')?.remove();
  state.selectedFile = null;
  state.selectedStash = null;
  $('#history-view').classList.remove('hidden');
  $('#changes-view').classList.add('hidden');
  $('#history-view').innerHTML = `<div class="diff-preview"><header><div><p class="eyebrow">${escapeHtml(kicker)}</p><h3>${escapeHtml(title)}</h3></div><button id="close-diff-preview" type="button" class="icon-button" title="Fermer l’aperçu">×</button></header><pre id="left-diff-content"></pre></div>`;
  $('#left-diff-content')[isMarkup ? 'innerHTML' : 'textContent'] = content;
  $('#close-diff-preview').addEventListener('click', closeDiffPreview);
}

function tagNameError(value) {
  const name = value.trim();
  if (!name) return 'Le nom du tag est obligatoire.';
  if (state.snapshot.tags.some((tag) => tag.name === name)) return `Le tag « ${name} » existe déjà.`;
  if (name === '@' || name.startsWith('-') || name.startsWith('.') || name.endsWith('.') || name.endsWith('/') || name.endsWith('.lock')
    || name.includes('..') || name.includes('@{') || /[\x00-\x20\x7f~^:?*[\\]/.test(name)
    || name.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) return 'Ce nom de tag n’est pas valide.';
  return '';
}

function renderTagDialogValidation(force = false) {
  let error = tagNameError($('#tag-name').value);
  if (!error && $('#tag-annotated').checked && !$('#tag-message').value.trim()) error = 'Le message du tag annoté est obligatoire.';
  const hasInput = $('#tag-name').value || ($('#tag-annotated').checked && $('#tag-message').value);
  const visibleError = force || hasInput ? error : '';
  $('#tag-error').textContent = visibleError;
  $('#tag-error').classList.toggle('hidden', !visibleError);
  $('#tag-name').setAttribute('aria-invalid', error ? 'true' : 'false');
  return error;
}

function updateTagDialogType() {
  const annotated = $('#tag-annotated').checked;
  $('#tag-message-field').classList.toggle('hidden', !annotated);
  $('#confirm-tag').textContent = annotated ? 'Créer le tag annoté' : 'Créer le tag';
  renderTagDialogValidation(false);
}

function createTagAt(revision, annotated = false, sourceLabel = String(revision).slice(0, 7)) {
  state.tagCreation = { revision, sourceLabel, pending: false };
  $('#tag-source').textContent = sourceLabel;
  $('#tag-name').value = '';
  $('#tag-message').value = '';
  $('#tag-annotated').checked = annotated;
  updateTagDialogType();
  $('#tag-dialog').showModal();
  setTimeout(() => $('#tag-name').focus(), 50);
}

function remoteBranchNames(remoteName) {
  const prefix = `${remoteName}/`;
  return state.snapshot.branches
    .filter((branch) => branch.remote && branch.name.startsWith(prefix))
    .map((branch) => branch.name.slice(prefix.length))
    .sort((left, right) => left.localeCompare(right));
}

function selectedUpstreamParts(branch) {
  const remote = [...(state.snapshot.remotes || [])]
    .sort((left, right) => right.name.length - left.name.length)
    .find((candidate) => branch.upstream?.startsWith(`${candidate.name}/`));
  return remote ? { remote: remote.name, branch: branch.upstream.slice(remote.name.length + 1) } : null;
}

function upstreamDialogError() {
  const remote = $('#upstream-remote').value;
  const branch = $('#upstream-branch').value.trim();
  if (!(state.snapshot.remotes || []).some((candidate) => candidate.name === remote)) return 'Sélectionnez un dépôt distant valide.';
  if (!branch) return 'Le nom de la branche distante est obligatoire.';
  if (branch.startsWith('-') || branch.startsWith('.') || branch.endsWith('.') || branch.endsWith('/') || branch.endsWith('.lock')
    || branch.includes('..') || branch.includes('@{') || /[\x00-\x20\x7f~^:?*[\\]/.test(branch)
    || branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) return 'Ce nom de branche distante n’est pas valide.';
  if (state.upstreamAssignment.mode === 'track' && !remoteBranchNames(remote).includes(branch)) return `La branche distante « ${remote}/${branch} » n’existe pas. Effectuez un Fetch ou publiez-la avant de la suivre.`;
  return '';
}

function renderUpstreamDialogValidation(force = false) {
  const error = upstreamDialogError();
  const visibleError = force || $('#upstream-branch').value ? error : '';
  $('#upstream-error').textContent = visibleError;
  $('#upstream-error').classList.toggle('hidden', !visibleError);
  $('#upstream-branch').setAttribute('aria-invalid', error ? 'true' : 'false');
  return error;
}

function renderUpstreamBranchOptions() {
  $('#upstream-branch-options').innerHTML = remoteBranchNames($('#upstream-remote').value)
    .map((name) => `<option value="${escapeHtml(name)}"></option>`).join('');
  renderUpstreamDialogValidation(false);
}

function openUpstreamDialog(branch, mode = 'track', pushOptions = {}) {
  const remotes = state.snapshot.remotes || [];
  if (!remotes.length) return toast('Aucun dépôt distant n’est configuré.', true);
  const current = selectedUpstreamParts(branch);
  const selectedRemote = current?.remote || remotes.find((remote) => remote.name === 'origin')?.name || remotes[0].name;
  state.upstreamAssignment = { branch: branch.name, mode, pushOptions, pending: false };
  const publishing = mode === 'publish';
  $('#upstream-dialog-kicker').textContent = publishing ? 'PUBLIER LA BRANCHE' : 'BRANCHE DISTANTE SUIVIE';
  $('#upstream-dialog-title').textContent = publishing ? 'Publier' : 'Configurer';
  $('#upstream-dialog-help').textContent = publishing
    ? 'Choisissez la destination. Forkline créera la branche distante et configurera son suivi.'
    : 'Choisissez la branche utilisée par défaut pour les opérations Pull et Push.';
  $('#confirm-upstream').textContent = publishing ? 'Publier et suivre' : 'Définir la branche suivie';
  $('#upstream-local-branch').textContent = branch.name;
  $('#upstream-remote').innerHTML = remotes.map((remote) => `<option value="${escapeHtml(remote.name)}">${escapeHtml(remote.name)}</option>`).join('');
  $('#upstream-remote').value = selectedRemote;
  $('#upstream-branch').value = current?.branch || branch.name;
  renderUpstreamBranchOptions();
  renderUpstreamDialogValidation(false);
  $('#upstream-dialog').showModal();
  setTimeout(() => $('#upstream-branch').focus(), 50);
}

function pushBranchFromUi(branch, options = {}) {
  if (!branch) return toast('Aucune branche locale active à publier.', true);
  const upstream = selectedUpstreamParts(branch);
  if (!upstream) return openUpstreamDialog(branch, 'publish', options);
  return executeRepositoryAction(`Branche ${branch.name} publiée`, () => window.forkline.pushBranch(branch.name, { ...options, remote: upstream.remote, remoteBranch: upstream.branch }));
}

async function runBranchContextAction(operation, branchName) {
  const branch = state.snapshot.branches.find((candidate) => !candidate.remote && candidate.name === branchName);
  if (!branch) return;
  if (operation === 'checkout') return switchBranch(branchName);
  if (operation === 'create') {
    console.info('[branch-create] branch menu action', JSON.stringify({ operation, branchName, hash: branch.hash }));
    openBranchDialog(branchName, branchName);
    return;
  }
  if (operation === 'merge') {
    if (branch.current) return toast('Cette branche est déjà active.', true);
    if (window.confirm(`Fusionner ${branchName} dans ${state.snapshot.head} ?`)) await executeRepositoryAction(`Branche ${branchName} fusionnée`, () => window.forkline.mergeBranch(branchName));
    return;
  }
  if (operation === 'rebase') {
    if (branch.current) return toast('Cette branche est déjà active.', true);
    if (window.confirm(`Rebaser ${state.snapshot.head} sur ${branchName} ?`)) await executeRepositoryAction(`Branche rebasée sur ${branchName}`, () => window.forkline.rebaseBranch(branchName));
    return;
  }
  if (operation === 'interactive-rebase') {
    const commit = state.snapshot.commits.find((candidate) => candidate.hash === branch.hash);
    if (!commit) return toast('Le commit de cette branche n’est pas visible dans le graphe.', true);
    return openInteractiveRebase(commit);
  }
  if (operation === 'fast-forward') {
    if (window.confirm(`Avancer ${state.snapshot.head} en fast-forward jusqu’à ${branchName} ?`)) {
      await executeRepositoryAction(`Branche ${state.snapshot.head} avancée jusqu’à ${branchName}`, () => window.forkline.fastForwardBranch(branchName));
    }
    return;
  }
  if (operation === 'cherry-pick') {
    if (window.confirm(`Cherry-pick du dernier commit de ${branchName} ?`)) await executeRepositoryAction('Commit appliqué', () => window.forkline.cherryPick(branchName));
    return;
  }
  if (operation === 'pull') {
    if (!branch.current) return toast('Activez cette branche avant de lancer Pull.', true);
    await executeRepositoryAction('Pull terminé', () => window.forkline.pull());
    return;
  }
  if (operation === 'push') {
    return pushBranchFromUi(branch);
  }
  if (operation === 'upstream') {
    return openUpstreamDialog(branch);
  }
  if (operation === 'rename') {
    return openRenameBranchDialog(branch);
  }
  if (operation === 'copy') return copyText(branchName, 'Nom de branche copié');
  if (operation === 'delete') {
    if (window.confirm(`Supprimer la branche ${branchName} ?`)) await executeRepositoryAction(`Branche ${branchName} supprimée`, () => window.forkline.deleteBranch(branchName, false));
    return;
  }
  if (operation === 'delete-with-remote') {
    if (window.confirm(`Supprimer définitivement ${branchName} et ${branch.upstream} ?`)) {
      await executeRepositoryAction(`Branches ${branchName} et ${branch.upstream} supprimées`, () => window.forkline.deleteBranchWithRemote(branchName, branch.upstream));
    }
    return;
  }
  if (operation === 'force-delete') {
    if (branch.current) return toast('Impossible de supprimer la branche actuellement active.', true);
    const confirmation = window.prompt(`Cette action supprime ${branchName}, même si ses commits ne sont pas fusionnés.\nSaisissez exactement le nom de la branche pour confirmer :`);
    if (confirmation === branchName) await executeRepositoryAction(`Branche ${branchName} supprimée de force`, () => window.forkline.deleteBranch(branchName, true));
    else if (confirmation !== null) toast('Confirmation incorrecte, aucune branche supprimée.', true);
    return;
  }
  if (operation === 'compare') return showComparison(branchName, branchName);
  if (operation === 'solo') {
    state.soloBranchName = state.soloBranchName === branchName ? null : branchName;
    renderBranches();
    renderRemotes();
    renderCommits();
    return;
  }
  if (operation === 'hide') {
    state.hiddenBranchNames.add(branchName);
    saveHiddenBranchNames();
    if (state.soloBranchName === branchName) state.soloBranchName = null;
    renderBranches();
    renderRemotes();
    renderCommits();
    return;
  }
  if (operation === 'tag' || operation === 'annotated-tag') return createTagAt(branch.hash, operation === 'annotated-tag', branch.name);
  if (operation === 'finish-flow') {
    const type = gitFlowBranchType(branchName);
    if (type && window.confirm(`Terminer la ${type} ${branchName} ? Cette opération fusionnera et supprimera la branche.`)) await executeRepositoryAction(`${branchName} terminée`, () => window.forkline.finishGitFlow(type, branchName));
  }
}

async function runCommitContextAction(operation, commit) {
  if (operation === 'checkout-branch') {
    const localBranches = state.snapshot.branches.filter((branch) => !branch.remote && branch.hash === commit.hash);
    if (!localBranches.length) return toast('Aucune branche locale ne pointe sur ce commit.', true);
    let branchName = localBranches[0].name;
    if (localBranches.length > 1) {
      branchName = window.prompt(`Plusieurs branches pointent sur ${commit.shortHash}. Branche à activer :\n${localBranches.map((branch) => branch.name).join(', ')}`, branchName)?.trim();
      if (!branchName) return;
      if (!localBranches.some((branch) => branch.name === branchName)) return toast('Cette branche ne pointe pas sur le commit sélectionné.', true);
    }
    await switchBranch(branchName);
    return;
  }
  if (operation === 'checkout') {
    if (window.confirm(`Passer en HEAD détaché sur ${commit.shortHash} ?`)) await executeRepositoryAction(`HEAD détaché sur ${commit.shortHash}`, () => window.forkline.checkoutCommit(commit.hash));
    return;
  }
  if (operation === 'create-branch') {
    console.info('[branch-create] commit menu action', JSON.stringify({ operation, hash: commit.hash, shortHash: commit.shortHash }));
    openBranchDialog(commit.hash, commit.shortHash);
    return;
  }
  if (operation === 'cherry-pick') {
    if (window.confirm(`Cherry-pick du commit ${commit.shortHash} ?`)) await executeRepositoryAction('Commit appliqué', () => window.forkline.cherryPick(commit.hash));
    return;
  }
  if (operation === 'reset') {
    const mode = window.prompt('Mode de réinitialisation : soft, mixed ou hard', 'mixed')?.trim().toLowerCase();
    if (!['soft', 'mixed', 'hard'].includes(mode)) return mode ? toast('Mode de réinitialisation invalide.', true) : null;
    const warning = mode === 'hard' ? '\nToutes les modifications locales seront supprimées.' : '';
    if (window.confirm(`Réinitialiser ${state.snapshot.head} sur ${commit.shortHash} en mode ${mode} ?${warning}`)) await executeRepositoryAction('Branche réinitialisée', () => window.forkline.resetCommit(commit.hash, mode));
    return;
  }
  if (operation === 'revert') {
    if (window.confirm(`Créer un commit qui annule ${commit.shortHash} ?`)) await executeRepositoryAction('Commit annulé', () => window.forkline.revertCommit(commit.hash));
    return;
  }
  if (operation === 'amend') {
    const message = window.prompt('Nouveau message du commit :', commit.subject);
    if (message?.trim()) await executeRepositoryAction('Message du commit modifié', () => window.forkline.amendHeadMessage(message.trim()));
    return;
  }
  if (operation === 'interactive-rebase') return openInteractiveRebase(commit);
  if (operation === 'copy-sha') return copyText(commit.hash, 'SHA copié');
  if (operation === 'patch') {
    const safeSubject = commit.subject.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'commit';
    const exportedPath = await action('', () => window.forkline.exportCommitPatch(commit.hash, `${commit.shortHash}-${safeSubject}.patch`).then(unwrap));
    if (exportedPath) toast(`Patch exporté : ${exportedPath}`);
    return;
  }
  if (operation === 'apply-patch') return executeRepositoryAction('Patch appliqué', () => window.forkline.applyPatch());
  if (operation === 'apply-patch-clipboard') return applyPatchFromClipboard();
  if (operation === 'compare') return showComparison(commit.hash, `${commit.shortHash} · ${commit.subject}`);
  if (operation === 'tag' || operation === 'annotated-tag') return createTagAt(commit.hash, operation === 'annotated-tag', commit.shortHash);
}

async function openInteractiveRebase(baseCommit) {
  const plan = await action('', () => window.forkline.interactiveRebasePlan(baseCommit.hash).then(unwrap));
  if (plan === null) return;
  if (!plan.length) return toast('Aucun commit à rebaser après cette base.', true);
  state.rebaseBaseHash = baseCommit.hash;
  state.rebasePlan = plan;
  renderRebasePlan();
  $('#rebase-dialog').showModal();
}

function renderRebasePlan() {
  $('#rebase-plan').innerHTML = state.rebasePlan.map((commit, index) => `<div class="rebase-plan-row" data-rebase-index="${index}"><span class="rebase-order"><button type="button" data-rebase-move="up"${index === 0 ? ' disabled' : ''}>↑</button><button type="button" data-rebase-move="down"${index === state.rebasePlan.length - 1 ? ' disabled' : ''}>↓</button></span><select data-rebase-action><option value="pick"${commit.action === 'pick' ? ' selected' : ''}>Conserver</option><option value="reword"${commit.action === 'reword' ? ' selected' : ''}>Modifier le message</option><option value="squash"${commit.action === 'squash' ? ' selected' : ''}>Fusionner et garder le message</option><option value="fixup"${commit.action === 'fixup' ? ' selected' : ''}>Fusionner sans le message</option><option value="drop"${commit.action === 'drop' ? ' selected' : ''}>Supprimer</option></select><span class="rebase-commit"><strong>${escapeHtml(commit.message || commit.subject)}</strong><small>${escapeHtml(commit.shortHash)} · ${escapeHtml(commit.author)}</small></span></div>`).join('');
  $$('[data-rebase-action]').forEach((select) => select.addEventListener('change', () => {
    const index = Number(select.closest('[data-rebase-index]').dataset.rebaseIndex);
    if (select.value === 'reword') {
      const message = window.prompt('Nouveau message du commit :', state.rebasePlan[index].message || state.rebasePlan[index].subject);
      if (!message?.trim()) {
        state.rebasePlan[index].action = 'pick';
        renderRebasePlan();
        return;
      }
      state.rebasePlan[index].message = message.trim();
    }
    state.rebasePlan[index].action = select.value;
    renderRebasePlan();
  }));
  $$('[data-rebase-move]').forEach((button) => button.addEventListener('click', () => {
    const index = Number(button.closest('[data-rebase-index]').dataset.rebaseIndex);
    const target = button.dataset.rebaseMove === 'up' ? index - 1 : index + 1;
    [state.rebasePlan[index], state.rebasePlan[target]] = [state.rebasePlan[target], state.rebasePlan[index]];
    renderRebasePlan();
  }));
}

function branchSyncDetails(branch) {
  const remote = state.snapshot.branches.find((candidate) => candidate.remote && candidate.name === branch.upstream);
  const result = window.ForklineBranchSync.branchSyncState(branch, remote?.hash || null);
  if (window.forkline.debugGraphLayout) console.log({ branch: branch.name, localHash: branch.hash, upstream: branch.upstream, remoteHash: remote?.hash, ahead: branch.tracking?.ahead || 0, behind: branch.tracking?.behind || 0, syncState: result.state, iconTypes: result.icons });
  return result;
}

function renderBranchSync(branch) {
  const details = branchSyncDetails(branch);
  return `<span class="branch-sync" aria-hidden="true">${details.icons.map((icon) => `<span>${icon}</span>`).join('')}</span>`;
}

function renderRemotes() {
  const visibleRemoteNames = new Set(visibleGraphBranches().filter((branch) => branch.remote).map((branch) => branch.name));
  const remoteBranches = state.snapshot.branches.filter((branch) => branch.remote && !branch.symbolic && !branch.name.includes('HEAD')
    && (!state.soloBranchName || visibleRemoteNames.has(branch.name)));
  $('#remotes').innerHTML = state.snapshot.remotes.length
    ? state.snapshot.remotes.map((remote) => {
      const prefix = `${remote.name}/`;
      const branches = remoteBranches.filter((branch) => branch.name.startsWith(prefix));
      if (state.soloBranchName && !branches.length) return '';
      return `<div class="remote-group" data-remote="${escapeHtml(remote.name)}" title="${escapeHtml(remote.fetchUrl || '')}">
        <button type="button" class="remote-item" data-remote="${escapeHtml(remote.name)}"><span class="remote-glyph">⌁</span><span>${escapeHtml(remote.name)}</span><b>${branches.length}</b></button>
        ${branches.map((branch) => `<button type="button" class="remote-branch" data-remote-branch="${escapeHtml(branch.name)}"><span class="branch-symbol"><i></i></span><span>${escapeHtml(branch.name.slice(prefix.length))}</span></button>`).join('')}
      </div>`;
    }).join('')
    : '<div class="remote-item"><span class="remote-glyph">—</span><span>Aucun distant</span></div>';
  $$('.remote-item[data-remote]').forEach((item) => item.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    showRemoteContextMenu(item.dataset.remote, event.clientX, event.clientY);
  }));
  $$('[data-remote-branch]').forEach((item) => item.addEventListener('click', async () => {
    const remoteBranch = item.dataset.remoteBranch;
    const localName = remoteBranch.split('/').slice(1).join('/');
    const local = state.snapshot.branches.find((branch) => !branch.remote && branch.name === localName);
    if (local) await switchBranch(localName);
    else await executeRepositoryAction(`Branche ${localName} créée et suivie`, () => window.forkline.checkoutRemoteBranch(remoteBranch, localName));
  }));
}

function renderTags() {
  const tags = state.snapshot.tags || [];
  $('#tags').innerHTML = tags.length ? tags.map((tag) => `<button type="button" class="tag-item" data-tag="${escapeHtml(tag.name)}" data-hash="${escapeHtml(tag.hash)}" title="${escapeHtml(tag.subject || tag.name)}"><span>◇</span><span>${escapeHtml(tag.name)}</span>${tag.annotated ? '<b>annoté</b>' : ''}</button>`).join('') : '<div class="stash-empty">Aucun tag</div>';
  $$('.tag-item').forEach((item) => {
    item.addEventListener('click', () => selectCommit(item.dataset.hash));
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showTagContextMenu(item.dataset.tag, item.dataset.hash, event.clientX, event.clientY);
    });
  });
}

function renderIdentity() {
  const identity = state.snapshot.identity || {};
  $('#git-identity-name').textContent = identity.name || 'Non configurée';
  $('#git-identity-email').textContent = identity.email ? `${identity.email} · ${identity.scope === 'local' ? 'dépôt' : 'global'}` : 'Définir un nom et un e-mail';
}

async function refreshGitProfiles() {
  const result = await window.forkline.gitProfiles().then(unwrap).catch(() => null);
  if (!result) return;
  state.gitProfiles = result.profiles;
  state.assignedProfileId = result.assignedProfileId;
  state.profileAssignmentType = result.assignmentType;
  state.externalEditorCommand = result.externalEditorCommand || '';
  if ($('#identity-dialog').open) renderGitProfileOptions();
}

function renderGitProfileOptions() {
  $('#identity-profile').innerHTML = `<option value="">Configuration actuelle</option>${state.gitProfiles.map((profile) => `<option value="${escapeHtml(profile.id)}"${profile.id === state.assignedProfileId ? ' selected' : ''}>${escapeHtml(profile.label)}</option>`).join('')}`;
  $('#delete-identity-profile').disabled = !$('#identity-profile').value;
  $('#identity-profile-match').textContent = state.profileAssignmentType === 'rule'
    ? 'Ce profil a été sélectionné automatiquement par une règle. Une affectation explicite au dépôt reste prioritaire.'
    : state.profileAssignmentType === 'exact' ? 'Ce profil est affecté explicitement à ce dépôt.' : 'Les caractères * et ? sont acceptés. Une affectation explicite au dépôt reste prioritaire.';
}

function fillIdentityFromProfile(profile) {
  if (!profile) return;
  $('#identity-name').value = profile.name;
  $('#identity-email').value = profile.email;
  $('#identity-gpg-sign').checked = profile.gpgSign;
  $('#identity-signing-key').value = profile.signingKey || '';
  $('#identity-path-pattern').value = profile.pathPattern || '';
  $('#identity-remote-pattern').value = profile.remotePattern || '';
}

function renderSubmodules() {
  const submodules = state.snapshot.submodules || [];
  $('#submodules').innerHTML = submodules.length ? submodules.map((submodule) => `<button type="button" class="resource-item" data-submodule="${escapeHtml(submodule.path)}" title="${escapeHtml(submodule.url)}"><span class="resource-glyph">▣</span><span><strong>${escapeHtml(submodule.path)}</strong><small>${submodule.initialized ? `${submodule.currentHash.slice(0, 7)}${submodule.dirty ? ' · modifié' : submodule.outOfSync ? ' · désynchronisé' : ''}` : 'Non initialisé'}</small></span><i class="resource-state ${submodule.initialized && !submodule.dirty && !submodule.outOfSync ? 'ready' : ''}"></i></button>`).join('') : '<div class="stash-empty">Aucun sous-module</div>';
  $$('[data-submodule]').forEach((item) => {
    item.addEventListener('click', () => openSubmodule(item.dataset.submodule));
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showSubmoduleContextMenu(item.dataset.submodule, event.clientX, event.clientY);
    });
  });
}

function renderWorktrees() {
  const worktrees = state.snapshot.worktrees || [];
  $('#worktrees').innerHTML = worktrees.map((worktree) => `<button type="button" class="resource-item${worktree.main ? ' current' : ''}" data-worktree="${escapeHtml(worktree.path)}" title="${escapeHtml(worktree.path)}"><span class="resource-glyph">⌘</span><span><strong>${escapeHtml(worktree.branch || 'HEAD détaché')}</strong><small>${escapeHtml(worktree.main ? 'Worktree actuel' : worktree.path)}</small></span>${worktree.main ? '<b>actuel</b>' : ''}</button>`).join('');
  $$('[data-worktree]').forEach((item) => {
    item.addEventListener('click', () => openWorktree(item.dataset.worktree));
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showWorktreeContextMenu(item.dataset.worktree, event.clientX, event.clientY);
    });
  });
}

function gitFlowBranchType(branchName) {
  const flow = state.snapshot.gitFlow;
  if (!flow?.initialized) return null;
  return ['feature', 'release', 'hotfix', 'support'].find((type) => branchName.startsWith(flow.prefixes[type])) || null;
}

function renderGitFlow() {
  const flow = state.snapshot.gitFlow;
  if (!flow?.initialized) {
    $('#git-flow').innerHTML = '<button type="button" class="flow-initialize" data-flow-action="initialize">Initialiser Git Flow</button>';
  } else {
    $('#git-flow').innerHTML = `<div class="flow-bases"><span>${escapeHtml(flow.master)}</span><span>${escapeHtml(flow.develop)}</span></div><button type="button" data-flow-action="feature">＋ Feature</button><button type="button" data-flow-action="release">＋ Release</button><button type="button" data-flow-action="hotfix">＋ Hotfix</button><button type="button" data-flow-action="support">＋ Support</button>`;
  }
  $$('[data-flow-action]').forEach((button) => button.addEventListener('click', () => runGitFlowAction(button.dataset.flowAction)));
}

function renderLfs() {
  const lfs = state.snapshot.lfs || { available: false, patterns: [] };
  $('#new-lfs-pattern').disabled = !lfs.available;
  $('#new-lfs-pattern').title = lfs.available ? 'Suivre un motif avec Git LFS' : 'Git LFS n’est pas installé';
  $('#git-lfs').innerHTML = lfs.available ? `${lfs.patterns.map((pattern) => `<button type="button" class="resource-item" data-lfs-pattern="${escapeHtml(pattern)}"><span class="resource-glyph">◫</span><span><strong>${escapeHtml(pattern)}</strong><small>Suivi par Git LFS</small></span></button>`).join('') || '<div class="stash-empty">Aucun motif suivi</div>'}<button type="button" class="lfs-sync" data-lfs-sync="pull">Pull LFS</button><button type="button" class="lfs-sync" data-lfs-sync="push">Push LFS</button>` : '<div class="capability-missing">Git LFS n’est pas installé.</div>';
  $$('[data-lfs-pattern]').forEach((item) => item.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    showSimpleContextMenu(item.dataset.lfsPattern, [{ id: 'untrack', icon: '⌫', label: 'Ne plus suivre ce motif', danger: true, run: async () => { if (window.confirm(`Ne plus suivre ${item.dataset.lfsPattern} avec Git LFS ?`)) await executeRepositoryAction('Motif LFS retiré', () => window.forkline.untrackLfs(item.dataset.lfsPattern)); } }], event.clientX, event.clientY);
  }));
  $$('[data-lfs-sync]').forEach((button) => button.addEventListener('click', () => executeRepositoryAction(`${button.dataset.lfsSync === 'pull' ? 'Pull' : 'Push'} LFS terminé`, () => window.forkline[button.dataset.lfsSync === 'pull' ? 'pullLfs' : 'pushLfs']())));
}

async function runGitFlowAction(type) {
  if (type === 'initialize') {
    const localNames = state.snapshot.branches.filter((branch) => !branch.remote).map((branch) => branch.name);
    const defaultMaster = localNames.includes('main') ? 'main' : localNames.includes('master') ? 'master' : state.snapshot.head;
    const master = window.prompt('Branche de production :', defaultMaster);
    if (!master?.trim()) return;
    const develop = window.prompt('Branche de développement :', 'develop');
    if (!develop?.trim()) return;
    await executeRepositoryAction('Git Flow initialisé', () => window.forkline.initializeGitFlow({ master: master.trim(), develop: develop.trim() }));
    return;
  }
  const name = window.prompt(`Nom de la ${type} :`);
  if (!name?.trim()) return;
  const startPoint = type === 'support' ? window.prompt('Tag, branche ou commit de départ du support :', state.snapshot.gitFlow.master) : '';
  if (type === 'support' && !startPoint?.trim()) return;
  await executeRepositoryAction(`${type} démarrée`, () => window.forkline.startGitFlow(type, name.trim(), startPoint?.trim() || ''));
}

async function openSubmodule(submodulePath) {
  const submodule = state.snapshot.submodules.find((entry) => entry.path === submodulePath);
  if (!submodule.initialized) return executeRepositoryAction('Sous-module initialisé', () => window.forkline.updateSubmodule(submodulePath));
  if (window.confirm(`Ouvrir le sous-module ${submodulePath} à la place du dépôt actuel ?`)) {
    const snapshot = await action('', () => window.forkline.openSubmodule(submodulePath).then(unwrap));
    if (snapshot) applySnapshot(snapshot);
  }
}

function showSubmoduleContextMenu(submodulePath, x, y) {
  const submodule = state.snapshot.submodules.find((entry) => entry.path === submodulePath);
  showSimpleContextMenu(submodulePath, [
    { id: 'open', icon: '↗', label: submodule.initialized ? 'Ouvrir le sous-module' : 'Initialiser le sous-module', run: () => openSubmodule(submodulePath) },
    { id: 'update', icon: '↓', label: 'Initialiser et mettre à jour récursivement', run: () => executeRepositoryAction('Sous-module mis à jour', () => window.forkline.updateSubmodule(submodulePath)) },
    { id: 'sync', icon: '↻', label: 'Synchroniser la configuration distante', run: () => executeRepositoryAction('Sous-module synchronisé', () => window.forkline.syncSubmodule(submodulePath)) },
    { id: 'deinit', icon: '⌫', label: 'Désinitialiser', danger: true, run: async () => { if (window.confirm(`Désinitialiser ${submodulePath} ? Les fichiers de travail du sous-module seront retirés.`)) await executeRepositoryAction('Sous-module désinitialisé', () => window.forkline.deinitializeSubmodule(submodulePath, false)); } },
  ], x, y);
}

async function openWorktree(worktreePath) {
  const worktree = state.snapshot.worktrees.find((entry) => entry.path === worktreePath);
  if (!worktree || worktree.main) return;
  if (window.confirm(`Ouvrir le worktree ${worktree.branch || worktree.path} à la place du dépôt actuel ?`)) {
    const snapshot = await action('', () => window.forkline.openWorktree(worktreePath).then(unwrap));
    if (snapshot) applySnapshot(snapshot);
  }
}

function showWorktreeContextMenu(worktreePath, x, y) {
  const worktree = state.snapshot.worktrees.find((entry) => entry.path === worktreePath);
  const actions = [
    { id: 'prune', icon: '↻', label: 'Nettoyer les worktrees obsolètes', run: () => executeRepositoryAction('Worktrees obsolètes nettoyés', () => window.forkline.pruneWorktrees()) },
  ];
  if (!worktree.main) actions.unshift(
    { id: 'open', icon: '↗', label: 'Ouvrir ce worktree', run: () => openWorktree(worktreePath) },
    { id: 'remove', icon: '⌫', label: 'Supprimer ce worktree', danger: true, run: async () => { if (window.confirm(`Supprimer le worktree ${worktreePath} ?`)) await executeRepositoryAction('Worktree supprimé', () => window.forkline.removeWorktree(worktreePath, false)); } },
  );
  showSimpleContextMenu(worktree.branch || worktree.path, actions, x, y);
}

function showSimpleContextMenu(title, actions, clientX, clientY) {
  closeBranchContextMenu();
  closeCommitContextMenu();
  const menu = document.createElement('div');
  menu.id = 'branch-context-menu';
  menu.className = 'branch-context-menu';
  menu.innerHTML = `<div class="branch-context-title"><span>ACTIONS</span><strong>${escapeHtml(title)}</strong></div>${actions.map((entry) => `<button type="button" class="branch-context-action${entry.danger ? ' danger' : ''}" data-simple-action="${entry.id}"><span>${entry.icon}</span><span>${escapeHtml(entry.label)}</span></button>`).join('')}`;
  document.body.append(menu);
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - bounds.width - 8))}px`;
  menu.style.top = `${Math.max(52, Math.min(clientY, window.innerHeight - bounds.height - 8))}px`;
  actions.forEach((entry) => menu.querySelector(`[data-simple-action="${entry.id}"]`).addEventListener('click', () => {
    closeBranchContextMenu();
    entry.run();
  }));
}

function showRemoteContextMenu(name, x, y) {
  const remote = state.snapshot.remotes.find((candidate) => candidate.name === name);
  showSimpleContextMenu(name, [
    { id: 'fetch', icon: '↓', label: 'Récupérer', run: () => executeRepositoryAction(`Dépôt ${name} récupéré`, () => window.forkline.fetchRemote(name, false)) },
    { id: 'prune', icon: '⌁', label: 'Récupérer et nettoyer les références', run: () => executeRepositoryAction(`Références ${name} nettoyées`, () => window.forkline.fetchRemote(name, true)) },
    { id: 'copy', icon: '⧉', label: 'Copier l’adresse', run: () => copyText(remote.fetchUrl || '', 'Adresse copiée') },
    { id: 'rename', icon: '✎', label: 'Renommer', run: async () => { const value = window.prompt('Nouveau nom du dépôt distant :', name); if (value?.trim() && value.trim() !== name) await executeRepositoryAction('Dépôt distant renommé', () => window.forkline.renameRemote(name, value.trim())); } },
    { id: 'remove', icon: '⌫', label: 'Supprimer', danger: true, run: async () => { if (window.confirm(`Supprimer le dépôt distant ${name} ?`)) await executeRepositoryAction('Dépôt distant supprimé', () => window.forkline.removeRemote(name)); } },
  ], x, y);
}

function showTagContextMenu(name, hash, x, y) {
  showSimpleContextMenu(name, [
    { id: 'checkout', icon: '✓', label: 'Checkout sur ce tag', run: () => executeRepositoryAction(`Tag ${name} activé`, () => window.forkline.checkoutCommit(hash)) },
    { id: 'push', icon: '↑', label: 'Publier le tag', run: () => executeRepositoryAction(`Tag ${name} publié`, () => window.forkline.pushTag(name)) },
    { id: 'delete-remote', icon: '☁', label: 'Supprimer le tag distant', danger: true, run: async () => { if (window.confirm(`Supprimer le tag ${name} du dépôt distant ?`)) await executeRepositoryAction(`Tag distant ${name} supprimé`, () => window.forkline.deleteRemoteTag(name)); } },
    { id: 'copy', icon: '⧉', label: 'Copier le nom', run: () => copyText(name, 'Nom du tag copié') },
    { id: 'delete', icon: '⌫', label: 'Supprimer le tag local', danger: true, run: async () => { if (window.confirm(`Supprimer le tag ${name} ?`)) await executeRepositoryAction(`Tag ${name} supprimé`, () => window.forkline.deleteTag(name)); } },
  ], x, y);
}

function renderStashes() {
  const stashes = state.snapshot.stashes || [];
  const visibleStashes = stashes.filter((stash) => !state.hiddenStashHashes.has(stash.hash));
  const hiddenCount = stashes.length - visibleStashes.length;
  const popButton = $('#toolbar-pop-stash');
  if (popButton) popButton.disabled = stashes.length === 0;
  $('#stashes').innerHTML = `${visibleStashes.length ? visibleStashes.map((stash) => `
    <button class="stash-item${state.selectedStash === stash.ref ? ' selected' : ''}" type="button" data-stash="${escapeHtml(stash.ref)}" title="${escapeHtml(stash.subject)}">
      <span class="stash-glyph">▣</span><span class="stash-item-main"><strong>${escapeHtml(stash.message)}</strong><small>${escapeHtml(stash.branch || 'HEAD détaché')} · ${stash.fileCount} fichier${stash.fileCount > 1 ? 's' : ''}</small></span>
    </button>`).join('') : '<div class="stash-empty">Aucun stash visible</div>'}${hiddenCount ? `<button id="show-hidden-stashes" class="show-hidden-stashes" type="button">Afficher ${hiddenCount} stash${hiddenCount > 1 ? 's' : ''} masqué${hiddenCount > 1 ? 's' : ''}</button>` : ''}`;
  $$('.stash-item').forEach((button) => button.addEventListener('click', () => selectStash(button.dataset.stash)));
  $$('.stash-item').forEach((button) => button.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showStashContextMenu(button.dataset.stash, event.clientX, event.clientY);
  }));
  $('#show-hidden-stashes')?.addEventListener('click', () => {
    state.hiddenStashHashes.clear();
    saveHiddenStashHashes();
    renderBranches();
    renderStashes();
    renderCommits();
  });
}

function closeStashContextMenu() {
  $('#stash-context-menu')?.remove();
}

function showStashContextMenu(ref, clientX, clientY) {
  closeBranchContextMenu();
  closeCommitContextMenu();
  closeStashContextMenu();
  const stash = (state.snapshot.stashes || []).find((entry) => entry.ref === ref);
  if (!stash) return;
  const menu = document.createElement('div');
  menu.id = 'stash-context-menu';
  menu.className = 'branch-context-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `<div class="branch-context-title"><span>STASH</span><strong>${escapeHtml(stash.message)}</strong></div>
    <button type="button" role="menuitem" class="branch-context-action" data-stash-menu-action="apply"><span>↓</span><span>Appliquer le stash</span></button>
    <button type="button" role="menuitem" class="branch-context-action" data-stash-menu-action="pop"><span>↧</span><span>Appliquer et supprimer</span></button>
    <div class="branch-context-separator"></div>
    <button type="button" role="menuitem" class="branch-context-action" data-stash-menu-action="hide"><span>◌</span><span>Masquer du graphe</span></button>
    <button type="button" role="menuitem" class="branch-context-action danger" data-stash-menu-action="drop"><span>⌫</span><span>Supprimer le stash</span></button>`;
  document.body.append(menu);
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - bounds.width - 8))}px`;
  menu.style.top = `${Math.max(52, Math.min(clientY, window.innerHeight - bounds.height - 8))}px`;
  $$('[data-stash-menu-action]').forEach((button) => button.addEventListener('click', () => {
    closeStashContextMenu();
    if (button.dataset.stashMenuAction === 'hide') {
      state.hiddenStashHashes.add(stash.hash);
      saveHiddenStashHashes();
      if (state.selectedStash === ref) closeDiffPreview();
      renderBranches();
      renderStashes();
      renderCommits();
    } else runStashAction(button.dataset.stashMenuAction, ref);
  }));
  menu.querySelector('.branch-context-action')?.focus();
}

const GRAPH_COLORS = ['#3c91d4', '#57b88a', '#8a77cf', '#39a6a3', '#5f7fe8', '#74b96f', '#9b6fd0', '#3aa7c4'];

function graphColor(lane) {
  return GRAPH_COLORS[lane % GRAPH_COLORS.length];
}

function graphColorForHash(graph, hash, commits = state.snapshot.commits) {
  const index = commits.findIndex((commit) => commit.hash === hash);
  return index >= 0 ? graphColor(graph.rows[index].laneColor) : '#6c7169';
}

function graphLabelDetails(commit, branchColor) {
  const graphBranches = visibleGraphBranches();
  const localBranches = graphBranches.filter((branch) => !branch.remote);
  const remoteBranches = graphBranches.filter((branch) => branch.remote && !branch.symbolic && !branch.name.includes('HEAD'));
  const consumedRemoteNames = new Set();
  const renderedLocalNames = new Set();
  const labels = [];

  localBranches.filter((branch) => branch.hash === commit.hash).forEach((branch) => {
    if (!branch.name || renderedLocalNames.has(branch.name)) return;
    renderedLocalNames.add(branch.name);
    const sync = branchSyncDetails(branch);
    const upstream = branch.upstream || '';
    const matchingRemote = remoteBranches.find((remote) => {
      const remoteBranchName = remote.name.split('/').slice(1).join('/');
      return remote.hash === commit.hash && (upstream ? remote.name === upstream : remoteBranchName === branch.name);
    });
    if (matchingRemote) consumedRemoteNames.add(matchingRemote.name);
    else if (upstream) consumedRemoteNames.add(upstream);

    const iconTypes = [branch.current ? 'current' : null, 'local'].filter(Boolean);
    if (sync?.state === 'gone') iconTypes.push('warning');
    else if (matchingRemote?.hash === branch.hash) iconTypes.push('remote');
    if (sync?.state === 'behind') iconTypes.push('behind');
    if (sync?.state === 'diverged') iconTypes.push('diverged');

    const tooltip = matchingRemote && !upstream
      ? `Branche locale ${branch.name} et distante ${matchingRemote.name} sur le même commit`
      : sync.tooltip;
    labels.push({ anchorHash: commit.hash, branchName: branch.name, name: branch.name, type: branch.current ? 'head' : 'local', color: branchColor, iconTypes, tooltip });
  });

  remoteBranches.filter((branch) => branch.hash === commit.hash && !consumedRemoteNames.has(branch.name)).forEach((branch) => {
    const name = branch.name.split('/').slice(1).join('/') || branch.name;
    labels.push({ anchorHash: commit.hash, name, type: 'remote', color: branchColor, iconTypes: ['remote'], tooltip: `Branche distante ${branch.name}` });
  });

  commit.refs.map(referenceDetails).filter((reference) => reference.type === 'tag').forEach((reference) => {
    labels.push({ anchorHash: commit.hash, name: reference.name, type: 'tag', color: branchColor, iconTypes: ['tag'], tooltip: `Tag ${reference.name}` });
  });

  return labels;
}

function graphIconMarkup(type, x, y, color) {
  if (type === 'current') return '<text class="sync-icon branch-current-icon" x="' + x + '" y="' + (y + 10) + '" fill="' + color + '" font-size="11" font-weight="800">✓</text>';
  if (type === 'local') return `<g class="sync-icon" stroke="${color}" fill="none" stroke-width="1.2"><rect x="${x}" y="${y + 1}" width="9" height="6" rx="1"/><path d="M ${x + 2} ${y + 9} H ${x + 7} M ${x + 4.5} ${y + 7} V ${y + 9}"/></g>`;
  if (type === 'remote') return `<path class="sync-icon" d="M ${x + 1} ${y + 8} H ${x + 10} C ${x + 12} ${y + 8}, ${x + 12} ${y + 5}, ${x + 10} ${y + 4} C ${x + 9} ${y + 1}, ${x + 5} ${y + 1}, ${x + 4} ${y + 4} C ${x + 1} ${y + 3}, ${x} ${y + 7}, ${x + 1} ${y + 8}" fill="none" stroke="${color}" stroke-width="1.2"/>`;
  if (type === 'warning') return `<g class="sync-icon" fill="${color}"><path d="M ${x + 6} ${y} L ${x + 12} ${y + 10} H ${x} Z"/><text x="${x + 5}" y="${y + 8}" fill="var(--paper)" font-size="7">!</text></g>`;
  if (type === 'tag') return `<path class="sync-icon" d="M ${x + 1} ${y + 2} H ${x + 7} L ${x + 11} ${y + 6} L ${x + 7} ${y + 10} H ${x + 1} Z" fill="none" stroke="${color}" stroke-width="1.2"/>`;
  if (type === 'stash') return `<g class="sync-icon" fill="none" stroke="${color}" stroke-width="1.2"><rect x="${x + 1}" y="${y + 2}" width="10" height="8" rx="1.5"/><path d="M ${x + 3} ${y + 2} V ${y} H ${x + 9} V ${y + 2} M ${x + 4} ${y + 6} H ${x + 8}"/></g>`;
  const symbol = type === 'ahead' ? '↑' : type === 'behind' ? '↓' : '↕';
  return `<text class="sync-icon" x="${x + 1}" y="${y + 10}" fill="${color}" font-size="11" font-weight="800">${symbol}</text>`;
}

function renderGraphRow(row, laneCount, commit, graphWidth, rowIndex, workingTreeNode, hasStashAbove = false) {
  const spacing = 16;
  const centerY = 22;
  const laneWidth = graphLaneWidth(laneCount);
  const width = graphWidth || laneWidth;
  const laneOffset = Math.max(0, width - laneWidth);
  const x = (lane) => laneOffset + 6 + lane * spacing;
  const paths = [];
  const isStash = Boolean(commit.stashRole);

  if (hasStashAbove) {
    paths.push(`<path d="M ${x(row.lane)} 0 L ${x(row.lane)} ${centerY}" stroke="${graphColor(row.laneColor)}"/>`);
  }

  row.before.forEach((value, lane) => {
    if (value && !(row.startsHere && lane === row.lane)) {
      const workingStroke = workingTreeNode && lane === workingTreeNode.lane && rowIndex <= workingTreeNode.commitIndex;
      paths.push(`<path${isStash && lane === row.lane ? ' class="stash-edge"' : ''} d="M ${x(lane)} 0 L ${x(lane)} ${centerY}" stroke="${workingStroke ? '#24b4c2' : graphColor(row.beforeColors[lane])}"${workingStroke ? ' stroke-dasharray="2 5"' : ''}/> `);
    }
  });
  row.after.forEach((value, lane) => {
    const continuesThroughRow = row.before[lane] || lane === row.lane;
    if (value && continuesThroughRow) {
      const workingStroke = workingTreeNode && lane === workingTreeNode.lane && rowIndex < workingTreeNode.commitIndex;
      paths.push(`<path${isStash && lane === row.lane ? ' class="stash-edge"' : ''} d="M ${x(lane)} ${centerY} L ${x(lane)} 44" stroke="${workingStroke ? '#24b4c2' : graphColor(row.afterColors[lane])}"${workingStroke ? ' stroke-dasharray="2 5"' : ''}/> `);
    }
  });
  row.connections.forEach(({ from, to, toColor }) => {
    if (from === to) return;
    paths.push(`<path class="graph-curve${isStash && from === row.lane ? ' stash-edge' : ''}" d="M ${x(from)} ${centerY} C ${x(from)} 34, ${x(to)} 32, ${x(to)} 44" stroke="${graphColor(toColor)}"/>`);
  });
  row.transitions?.forEach(({ from, to }, transitionIndex) => {
    if (from === to) return;
    paths.push(`<path class="graph-transition" d="M ${x(from)} 44 C ${x(from)} 44, ${x(to)} 44, ${x(to)} 44" stroke="${graphColor(row.transitionColors?.[transitionIndex])}"/>`);
  });

  if (window.forkline.debugGraphLayout) {
    console.log(`GRAPH_LAYOUT SVG ${JSON.stringify({ row: rowIndex, commit: commit.hash, paths })}`);
  }

  const color = graphColor(row.laneColor);
  const labels = graphLabelDetails(commit, color);
  const labelGroup = graphLabelGroupMarkup(labels, x(row.lane), centerY, color);
  const nodeColor = color;
  const nodeMarkup = isStash
    ? `<rect class="stash-node-halo" x="${x(row.lane) - 7}" y="${centerY - 7}" width="14" height="14" stroke="${nodeColor}"/><path class="stash-node-mark" d="M ${x(row.lane) - 4} ${centerY - 3} H ${x(row.lane) + 4} V ${centerY + 4} H ${x(row.lane) - 4} Z M ${x(row.lane) - 2} ${centerY} H ${x(row.lane) + 2}" stroke="${nodeColor}"/>`
    : `<circle class="commit-node-halo" cx="${x(row.lane)}" cy="${centerY}" r="6.5"/><circle class="commit-node" cx="${x(row.lane)}" cy="${centerY}" r="4" fill="${color}" stroke="${color}"/>`;
  return `<svg class="commit-graph" width="${width}" height="44" viewBox="0 0 ${width} 44" aria-hidden="true">
    <g fill="none" stroke-width="2.5" stroke-linecap="round">${paths.join('')}</g>
    ${labelGroup}
    ${nodeMarkup}
  </svg>`;
}

function renderStashGraphRow(stash, row, stashLane, laneCount, graphWidth) {
  const spacing = 16;
  const laneWidth = graphLaneWidth(laneCount);
  const width = graphWidth || laneWidth;
  const laneOffset = Math.max(0, width - laneWidth);
  const baseLane = row.lane;
  const baseX = laneOffset + 6 + baseLane * spacing;
  const centerX = laneOffset + 6 + stashLane * spacing;
  const centerY = 22;
  const color = graphColor(row.laneColor);
  const activeLanes = row.before.map((hash, lane) => {
    if (!hash) return '';
    const laneX = laneOffset + 6 + lane * spacing;
    const laneStroke = graphColor(row.beforeColors[lane]);
    if (lane === stashLane) {
      return `<path class="stash-upper-stem" d="M ${laneX} 0 V ${centerY}" stroke="${laneStroke}"/><path class="stash-lane-continuation" d="M ${laneX} ${centerY} V 44" stroke="${laneStroke}"/>`;
    }
    return `<path class="stash-lane-continuation" d="M ${laneX} 0 V 44" stroke="${laneStroke}"/>`;
  }).join('');
  const sideConnection = stashLane === baseLane
    ? ''
    : `<path class="stash-side-connection" d="M ${centerX} ${centerY} C ${centerX} 34, ${baseX} 32, ${baseX} 44" stroke="${color}"/>`;
  return `<svg class="commit-graph stash-graph" width="${width}" height="44" viewBox="0 0 ${width} 44" aria-hidden="true">
    ${activeLanes}${sideConnection}
    <rect class="stash-node-halo" x="${centerX - 7}" y="${centerY - 7}" width="14" height="14" stroke="${color}"/>
    <path class="stash-node-mark" d="M ${centerX - 4} ${centerY - 3} H ${centerX + 4} V ${centerY + 4} H ${centerX - 4} Z M ${centerX - 2} ${centerY} H ${centerX + 2}" stroke="${color}"/>
  </svg>`;
}

function renderWorkingTreeRow(node, laneCount, graphWidth, changeCount) {
  const spacing = 16;
  const width = graphWidth || graphLaneWidth(laneCount);
  const laneWidth = graphLaneWidth(laneCount);
  const centerX = Math.max(0, width - laneWidth) + 6 + node.lane * spacing;
  return `<svg class="working-tree-graph" width="${width}" height="44" viewBox="0 0 ${width} 44" aria-hidden="true">
    <path class="working-tree-link" d="M 79 13 H ${centerX}"/>
    <rect class="working-tree-badge" x="4" y="4" width="75" height="18" rx="3"/>
    <text class="working-tree-badge-text" x="12" y="17">WIP · ${changeCount}</text>
    <path d="M ${centerX} 13 L ${centerX} 44"/>
    <circle cx="${centerX}" cy="13" r="6.5"/>
  </svg>`;
}

function graphLabelWidth(label) {
  return Math.min(220, Math.max(52, label.name.length * 6.6 + 23 + label.iconTypes.length * 15));
}

function graphLaneWidth(laneCount) {
  return Math.max(34, laneCount * 16 + 10);
}

function graphLabelGroupMetrics(labels) {
  const rowHeight = 20;
  const rowGap = 2;
  return {
    width: labels.reduce((maxWidth, label) => Math.max(maxWidth, graphLabelWidth(label)), 0),
    height: labels.length ? labels.length * rowHeight + (labels.length - 1) * rowGap : 0,
    rowHeight,
    rowGap,
  };
}

function graphLabelGroupMarkup(labels, nodeX, nodeY, color) {
  if (!labels.length) return '';
  const labelStart = 4;
  const metrics = graphLabelGroupMetrics(labels);
  const groupY = nodeY - metrics.height / 2;
  const rows = labels.map((label, index) => {
    const labelY = groupY + index * (metrics.rowHeight + metrics.rowGap);
    const isCurrent = label.iconTypes.includes('current');
    const nameX = labelStart + 15 + (isCurrent ? 15 : 0);
    const iconStart = nameX + label.name.length * 6.6 + 4;
    const icons = label.iconTypes.filter((type) => type !== 'current').map((type, iconIndex) => graphIconMarkup(type, iconStart + iconIndex * 15, labelY + 5, label.color)).join('');
    return `<g class="branch-label ${label.type}"${label.branchName ? ` data-graph-branch="${escapeHtml(label.branchName)}"` : ''}>
      <rect x="${labelStart}" y="${labelY}" width="${metrics.width}" height="${metrics.rowHeight}" rx="3" fill="${label.color}" fill-opacity=".12" stroke="${label.color}"/>
      <title>${escapeHtml(label.tooltip)}</title>
      ${isCurrent ? graphIconMarkup('current', labelStart + 3, labelY + 5, label.color) : ''}<text x="${nameX}" y="${labelY + 14}" fill="${label.color}">${escapeHtml(label.name)}</text>${icons}
    </g>`;
  }).join('');
  const connectorY = nodeY;
  const connectorColor = labels[0]?.color || color;
  return `<g class="branch-label-group" font-family="${escapeHtml('Nimbus Sans, Liberation Sans, sans-serif')}" font-size="10" font-weight="700">
    <path class="branch-label-link" d="M ${labelStart + metrics.width} ${connectorY} H ${nodeX}" stroke="${connectorColor}"/>
    ${rows}
  </g>`;
}

function referenceDetails(reference) {
  const current = reference.startsWith('HEAD -> ');
  const name = reference.replace('HEAD -> ', '');
  if (name.startsWith('tag: ')) return { name: name.slice(5), type: 'tag' };
  if (name.includes(' -> ')) return { name: name.split(' -> ')[0], type: 'remote' };
  const remoteNames = state.snapshot.remotes.map((remote) => `${remote.name}/`);
  if (remoteNames.some((prefix) => name.startsWith(prefix))) return { name, type: 'remote' };
  return { name, type: current ? 'head' : 'local' };
}

function ensureHistoryStructure() {
  if ($('#commits') && $('.history-head') && $('#history-search')) return;
  $('#history-view').innerHTML = `<div class="history-tools"><span>⌕</span><input id="history-search" type="search" placeholder="Texte, author:, file:, after:, before:, branch:…" autocomplete="off" title="Exemple : correction author:Daisy file:src/app.js after:2026-01-01" value="${escapeHtml(state.historyQuery)}"><button id="clear-history-search" type="button" title="Effacer la recherche">×</button></div><div class="history-head"><span>BRANCHE / TAG · GRAPHE</span><span>MESSAGE DU COMMIT</span><span>AUTEUR</span><span>DATE</span></div><div id="commits" class="commit-list"></div>`;
  bindHistorySearch();
}

function bindHistorySearch() {
  const input = $('#history-search');
  if (!input || input.dataset.bound) return;
  input.dataset.bound = 'true';
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    state.historyQuery = input.value.trim();
    timer = setTimeout(runHistorySearch, 180);
  });
  $('#clear-history-search').addEventListener('click', () => {
    state.historyQuery = '';
    input.value = '';
    renderCommits();
    $('#history-search')?.focus();
  });
}

async function runHistorySearch() {
  const query = state.historyQuery;
  if (!query) return renderCommits();
  const request = ++state.searchRequest;
  const commits = await action('', () => window.forkline.searchHistory(parseHistorySearch(query)).then(unwrap));
  if (commits === null || request !== state.searchRequest || query !== state.historyQuery) return;
  showCommitResults(`RÉSULTATS POUR « ${query} »`, commits);
}

function parseHistorySearch(value) {
  const filters = {};
  const remaining = String(value).replace(/\b(author|file|after|before|branch):(?:"([^"]+)"|(\S+))/gi, (_match, key, quoted, plain) => {
    const names = { author: 'author', file: 'file', after: 'after', before: 'before', branch: 'ref' };
    filters[names[key.toLowerCase()]] = quoted || plain;
    return ' ';
  });
  filters.query = remaining.replace(/\s+/g, ' ').trim();
  return filters;
}

function showCommitResults(title, commits) {
  $('#history-view').classList.remove('hidden');
  $('#changes-view').classList.add('hidden');
  $('#history-view').innerHTML = `<div class="result-view"><header><div><p class="eyebrow">${escapeHtml(title)}</p><h3>${commits.length} commit${commits.length > 1 ? 's' : ''}</h3></div><button id="close-result-view" type="button" class="icon-button" title="Revenir au graphe">×</button></header><div class="commit-results">${commits.length ? commits.map((commit) => `<button type="button" class="commit-result" data-result-hash="${escapeHtml(commit.hash)}"><span><strong>${escapeHtml(commit.subject)}</strong><small>${escapeHtml(commit.shortHash)}</small></span><span>${escapeHtml(commit.author)}</span><span>${escapeHtml(relativeTime(commit.date))}</span></button>`).join('') : '<p class="empty-results">Aucun résultat.</p>'}</div></div>`;
  $('#close-result-view').addEventListener('click', () => {
    state.historyQuery = '';
    renderCommits();
  });
  $$('[data-result-hash]').forEach((row) => row.addEventListener('click', () => {
    const commit = commits.find((candidate) => candidate.hash === row.dataset.resultHash);
    if (commit) showCommitDetails(commit);
  }));
}

function renderCommits() {
  ensureHistoryStructure();
  bindHistorySearch();
  const commits = visibleGraphCommits();
  const graph = window.ForklineGraph.layoutCommitGraph(commits, {
    headHash: state.snapshot.headHash,
    showWorkingTree: state.snapshot.status.files.length > 0,
    branches: visibleGraphBranches(),
    orderDebug: state.snapshot.orderDebug,
    debug: window.forkline.debugGraphLayout,
  });
  const visibleStashes = (state.snapshot.stashes || []).filter((stash) => !state.hiddenStashHashes.has(stash.hash));
  const hasWipStash = state.snapshot.status.files.length > 0 && visibleStashes.some((stash) => stash.baseHash === state.snapshot.headHash);
  const displayLaneCount = graph.laneCount + (hasWipStash ? 1 : 0);
  const labelWidth = commits.reduce((width, commit) => {
    const refsWidth = graphLabelGroupMetrics(graphLabelDetails(commit, graphColor(0))).width;
    return Math.max(width, refsWidth);
  }, 0);
  const workingTreeLabelWidth = graph.workingTreeNode ? 75 : 0;
  const labelArea = Math.max(labelWidth, workingTreeLabelWidth);
  const graphWidth = Math.max(46, graphLaneWidth(displayLaneCount) + (labelArea ? labelArea + 2 : 0));
  $('#commits').style.setProperty('--graph-width', `${graphWidth}px`);
  $('.history-head').style.setProperty('--graph-width', `${graphWidth}px`);
  const rows = [];
  commits.forEach((commit, index) => {
    if (graph.workingTreeNode && index === 0) {
      rows.push(`<button class="working-tree-row" type="button" title="Afficher les modifications locales">
        ${renderWorkingTreeRow(graph.workingTreeNode, displayLaneCount, graphWidth, state.snapshot.status.files.length)}
        <span></span>
        <span></span><span></span>
      </button>`);
    }
    const attachedStashes = (state.snapshot.stashes || []).filter((stash) => stash.baseHash === commit.hash && !state.hiddenStashHashes.has(stash.hash));
    attachedStashes.forEach((stash) => {
      const stashCommit = state.snapshot.commits.find((candidate) => candidate.hash === stash.hash);
      const isBesideWip = state.snapshot.status.files.length > 0 && stash.baseHash === state.snapshot.headHash;
      const stashLane = isBesideWip ? graph.laneCount : graph.rows[index].lane;
      rows.push(`<button class="commit-row stash-row" data-stash-ref="${escapeHtml(stash.ref)}">
        ${renderStashGraphRow(stash, graph.rows[index], stashLane, displayLaneCount, graphWidth)}
        <span class="commit-main"><span class="commit-subject">${escapeHtml(stash.message)}</span><span class="commit-meta">${escapeHtml(stashCommit?.shortHash || stash.hash.slice(0, 7))}</span></span>
        <span class="commit-author">${escapeHtml(stashCommit?.author || '')}</span>
        <span class="commit-date" title="${escapeHtml(new Date(stash.date).toLocaleString('fr'))}">${relativeTime(stash.date)}</span>
      </button>`);
    });
    rows.push(`<button class="commit-row${commit.hash === state.selectedCommit ? ' selected' : ''}${state.compareSelection.includes(commit.hash) ? ' compare-selected' : ''}${commit.stashRole ? ` stash-row stash-${commit.stashRole}` : ''}" data-hash="${commit.hash}">
      ${renderGraphRow(graph.rows[index], displayLaneCount, commit, graphWidth, index, graph.workingTreeNode, attachedStashes.length > 0)}
      <span class="commit-main"><span class="commit-subject">${escapeHtml(commit.subject)}</span><span class="commit-meta">${commit.shortHash}</span></span>
      <span class="commit-author">${escapeHtml(commit.author)}</span>
      <span class="commit-date" title="${escapeHtml(new Date(commit.date).toLocaleString('fr'))}">${relativeTime(commit.date)}</span>
    </button>`);
  });
  $('#commits').innerHTML = rows.join('');
  $$('[data-stash-ref]').forEach((row) => row.addEventListener('click', () => selectStash(row.dataset.stashRef)));
  $$('[data-stash-ref]').forEach((row) => row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showStashContextMenu(row.dataset.stashRef, event.clientX, event.clientY);
  }));
  $$('.commit-row').forEach((row) => row.addEventListener('click', (event) => {
    const commit = state.snapshot.commits.find((item) => item.hash === row.dataset.hash);
    if (commit && (event.ctrlKey || event.metaKey)) {
      toggleCommitComparison(commit.hash);
      return;
    }
    if (commit?.stashRole === 'worktree' && commit.stashRef) selectStash(commit.stashRef);
    else selectCommit(row.dataset.hash);
  }));
  $$('.commit-row').forEach((row) => row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const commit = state.snapshot.commits.find((item) => item.hash === row.dataset.hash);
    if (commit) showCommitContextMenu(commit, event.clientX, event.clientY);
  }));
  $$('[data-graph-branch]').forEach((label) => label.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showBranchContextMenu(label.dataset.graphBranch, event.clientX, event.clientY);
  }));
  $$('.working-tree-row').forEach((row) => row.addEventListener('click', () => showInspector('#worktree-detail')));
  renderComparisonBar();
}

function toggleCommitComparison(hash) {
  const index = state.compareSelection.indexOf(hash);
  if (index >= 0) state.compareSelection.splice(index, 1);
  else {
    if (state.compareSelection.length === 2) state.compareSelection.shift();
    state.compareSelection.push(hash);
  }
  renderCommits();
}

function renderComparisonBar() {
  $('#comparison-bar')?.remove();
  if (!state.compareSelection.length) return;
  const commits = state.compareSelection.map((hash) => state.snapshot.commits.find((commit) => commit.hash === hash)).filter(Boolean);
  const bar = document.createElement('div');
  bar.id = 'comparison-bar';
  bar.className = 'comparison-bar';
  bar.innerHTML = `<span>${commits.map((commit) => escapeHtml(commit.shortHash)).join(' → ')}</span><button type="button" id="run-commit-comparison"${commits.length !== 2 ? ' disabled' : ''}>Comparer</button><button type="button" id="export-commit-selection">Exporter le patch</button><button type="button" id="clear-commit-comparison" title="Effacer">×</button>`;
  document.body.append(bar);
  $('#clear-commit-comparison').addEventListener('click', () => {
    state.compareSelection = [];
    renderCommits();
  });
  $('#run-commit-comparison').addEventListener('click', () => {
    if (commits.length === 2) showRevisionComparison(commits[0].hash, commits[1].hash, `${commits[0].shortHash} → ${commits[1].shortHash}`);
  });
  $('#export-commit-selection').addEventListener('click', async () => {
    const exportedPath = await action('', () => window.forkline.exportCommitPatch(commits.map((commit) => commit.hash), `${commits.map((commit) => commit.shortHash).join('-')}.patch`).then(unwrap));
    if (exportedPath) toast(`Patch exporté : ${exportedPath}`);
  });
}

function renderChanges() {
  const files = state.snapshot.status.files;
  renderFileList('#staged-files', files.filter((file) => file.staged), true);
  renderFileList('#unstaged-files', files.filter((file) => file.workingTree !== ' ' || file.untracked), false);
}

function renderWorktreeInspector() {
  const files = state.snapshot.status.files;
  const operation = state.snapshot.operation;
  $('#worktree-detail').innerHTML = `
    ${operation ? `<section class="operation-banner"><div><p class="eyebrow">OPÉRATION GIT</p><strong>${escapeHtml(operation.label)}</strong><span>Résolvez les conflits par clic droit sur un fichier, puis continuez.</span></div><div><button class="button button-small" data-operation-action="abort">Abandonner</button><button class="button button-small button-primary" data-operation-action="continue">Continuer</button></div></section>` : ''}
    <header class="worktree-header"><div><p class="eyebrow">TRAVAIL EN COURS</p><h3>${files.length} fichier${files.length > 1 ? 's' : ''} modifié${files.length > 1 ? 's' : ''}</h3></div><button class="text-button" data-worktree-action="stage-all">Tout ajouter</button></header>
    <div class="worktree-files"><h4>Fichiers non indexés <span>${files.filter((file) => !file.staged).length}</span></h4><div id="worktree-unstaged-files" class="file-list"></div><h4>Fichiers indexés <span>${files.filter((file) => file.staged).length}</span></h4><div id="worktree-staged-files" class="file-list"></div></div>
    <div class="worktree-commit"><label for="worktree-commit-message">RÉSUMÉ DU COMMIT</label><textarea id="worktree-commit-message" rows="4" placeholder="Décrire clairement ce qui change…"></textarea><label class="commit-option"><input id="worktree-commit-amend" type="checkbox"><span>Modifier le dernier commit</span></label><label class="commit-option"><input id="worktree-commit-sign" type="checkbox"${state.snapshot.commitPreferences?.gpgSign ? ' checked' : ''}><span>Signer ce commit</span></label><button class="button button-primary" data-worktree-action="commit">Créer le commit</button></div>`;
  renderFileList('#worktree-staged-files', files.filter((file) => file.staged), true);
  renderFileList('#worktree-unstaged-files', files.filter((file) => file.workingTree !== ' ' || file.untracked), false);
  $$('[data-operation-action]').forEach((button) => button.addEventListener('click', async () => {
    const mode = button.dataset.operationAction;
    if (mode === 'abort' && !window.confirm(`Abandonner l’opération « ${operation.label} » ?`)) return;
    const method = mode === 'continue' ? 'continueOperation' : 'abortOperation';
    await executeRepositoryAction(mode === 'continue' ? 'Opération poursuivie' : 'Opération abandonnée', () => window.forkline[method](operation.type));
  }));
  $('[data-worktree-action="stage-all"]').addEventListener('click', async () => {
    const paths = files.filter((file) => file.workingTree !== ' ' || file.untracked).map((file) => file.path);
    if (paths.length) { const result = await action('Tous les fichiers ont été ajoutés', () => window.forkline.stage(paths).then(unwrap)); if (result) applySnapshot(result); }
  });
  $('[data-worktree-action="commit"]').addEventListener('click', async () => {
    const message = $('#worktree-commit-message').value.trim();
    const amend = $('#worktree-commit-amend').checked;
    const sign = $('#worktree-commit-sign').checked;
    const result = await action(amend ? 'Dernier commit modifié' : 'Commit créé', () => window.forkline.commit(message, { amend, sign }).then(unwrap));
    if (result) applySnapshot(result.snapshot);
  });
  $('#worktree-commit-amend').addEventListener('change', (event) => {
    if (event.target.checked && !$('#worktree-commit-message').value.trim()) $('#worktree-commit-message').value = state.snapshot.commits.find((commit) => commit.hash === state.snapshot.headHash)?.subject || '';
  });
}

function renderFileList(selector, files, staged) {
  $(selector).innerHTML = files.map((file) => {
    const code = statusLabel(file);
    const badgeClass = code === '?' || code === 'N' ? ' untracked' : code === 'D' ? ' deleted' : '';
    return `<button class="file-row${state.selectedFile === `${staged}:${file.path}` ? ' selected' : ''}" data-file="${escapeHtml(file.path)}" data-staged="${staged}">
      <span class="status-badge${badgeClass}">${escapeHtml(code)}</span><span class="file-name" title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</span><span class="file-action" title="${staged ? 'Retirer de l’index' : 'Ajouter à l’index'}">${staged ? '−' : '+'}</span>
    </button>`;
  }).join('');
  $$(`${selector} .file-row`).forEach((row) => {
    row.addEventListener('click', (event) => {
      if (event.target.classList.contains('file-action')) {
        event.stopPropagation();
        toggleStage(row.dataset.file, row.dataset.staged === 'true');
      } else {
        selectFile(row.dataset.file, row.dataset.staged === 'true');
      }
    });
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showFileContextMenu(row.dataset.file, event.clientX, event.clientY);
    });
  });
}

function showFileContextMenu(file, x, y) {
  const conflicted = state.snapshot.status.files.some((entry) => entry.path === file && entry.conflicted);
  const actions = [
    { id: 'open', icon: '↗', label: state.externalEditorCommand ? 'Ouvrir dans l’éditeur externe' : 'Ouvrir dans l’application par défaut', run: () => action('', () => window.forkline.openFile(file).then(unwrap)) },
    { id: 'editor', icon: '⚙', label: 'Configurer l’éditeur externe…', run: () => configureExternalEditor() },
    { id: 'history', icon: '◷', label: 'Afficher l’historique du fichier', run: () => showFileHistory(file) },
    { id: 'blame', icon: '≡', label: 'Afficher le blame', run: () => showFileBlame(file) },
    { id: 'copy', icon: '⧉', label: 'Copier le chemin', run: () => copyText(file, 'Chemin copié') },
  ];
  if (conflicted) actions.unshift(
    { id: 'ours', icon: '←', label: 'Utiliser la version ours (Git)', run: () => resolveConflict(file, 'ours') },
    { id: 'theirs', icon: '→', label: 'Utiliser la version theirs (Git)', run: () => resolveConflict(file, 'theirs') },
    { id: 'resolved', icon: '✓', label: 'Marquer le contenu actuel comme résolu', run: () => resolveConflict(file, 'resolved') },
  );
  showSimpleContextMenu(file, actions, x, y);
}

async function resolveConflict(file, strategy) {
  await executeRepositoryAction('Conflit marqué comme résolu', () => window.forkline.resolveConflict(file, strategy));
  showInspector('#worktree-detail');
}

async function showFileHistory(file) {
  const commits = await action('', () => window.forkline.fileHistory(file).then(unwrap));
  if (commits === null) return;
  showCommitResults(`HISTORIQUE DU FICHIER · ${file}`, commits);
}

async function showFileBlame(file) {
  const blame = await action('', () => window.forkline.blame(file).then(unwrap));
  if (blame === null) return;
  showTextPreview('BLAME', file, blame || 'Aucune ligne à afficher.');
}

function showInspector(id) {
  ['#inspector-empty', '#commit-detail', '#worktree-detail', '#stash-detail', '#diff-detail'].forEach((selector) => $(selector).classList.toggle('hidden', selector !== id));
}

function selectCommit(hash) {
  const commit = state.snapshot.commits.find((item) => item.hash === hash);
  if (!commit) return;
  state.selectedCommit = hash;
  renderCommits();
  showCommitDetails(commit);
}

function showCommitDetails(commit) {
  state.selectedCommit = commit.hash;
  $('#commit-detail').innerHTML = `
    <p class="eyebrow">DÉTAIL DU COMMIT</p><p class="detail-hash">${commit.hash}</p>
    <h3>${escapeHtml(commit.subject)}</h3>
    <dl class="detail-grid"><dt>Auteur</dt><dd>${escapeHtml(commit.author)}<br>${escapeHtml(commit.email)}</dd><dt>Date</dt><dd>${escapeHtml(new Date(commit.date).toLocaleString('fr'))}</dd><dt>Parent${commit.parents.length > 1 ? 's' : ''}</dt><dd>${commit.parents.map((parent) => parent.slice(0, 10)).join(', ') || 'Commit initial'}</dd></dl>
    <div class="detail-refs">${commit.refs.map((ref) => `<span class="detail-ref">${escapeHtml(ref)}</span>`).join('')}</div>
    <section class="commit-files-section"><p class="eyebrow">FICHIERS</p><div id="commit-files" class="commit-files"><span>Chargement…</span></div></section>`;
  showInspector('#commit-detail');
  loadCommitFiles(commit);
}

async function loadCommitFiles(commit) {
  const files = await window.forkline.commitFiles(commit.hash).then(unwrap).catch((error) => {
    toast(error.message, true);
    return null;
  });
  if (!files || state.selectedCommit !== commit.hash || !$('#commit-files')) return;
  $('#commit-files').innerHTML = files.length ? files.map((file) => `<button type="button" class="commit-file" data-commit-file="${escapeHtml(file.path)}"><span class="status-badge${file.status === 'D' ? ' deleted' : ''}">${escapeHtml(file.status)}</span><span>${escapeHtml(file.path)}</span></button>`).join('') : '<span>Aucun fichier.</span>';
  $$('[data-commit-file]').forEach((button) => {
    button.addEventListener('click', async () => {
      const diff = await action('', () => window.forkline.commitFileDiff(commit.hash, button.dataset.commitFile).then(unwrap));
      if (diff !== null) showTextPreview('DIFF DU COMMIT', button.dataset.commitFile, renderDiffMarkup(diff || 'Aucune différence.', 0, false), true);
    });
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showFileContextMenu(button.dataset.commitFile, event.clientX, event.clientY);
    });
  });
}

async function selectFile(file, staged) {
  const status = state.snapshot.status.files.find((entry) => entry.path === file);
  if (status?.conflicted) return selectConflictFile(file);
  state.selectedFile = `${staged}:${file}`;
  $('#history-view').classList.remove('hidden');
  $('#changes-view').classList.add('hidden');
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === 'history'));
  $('#history-view').innerHTML = `<div class="diff-preview"><header><div><p class="eyebrow">APERÇU DES MODIFICATIONS</p><h3>${escapeHtml(file)}</h3></div><button id="close-diff-preview" type="button" class="icon-button" title="Fermer l’aperçu" aria-label="Fermer l’aperçu">×</button></header><div class="diff-preview-actions"><button id="preview-diff-action" type="button" class="button button-small" data-file="${escapeHtml(file)}" data-staged="${staged}">${staged ? 'Retirer de l’index' : 'Ajouter à l’index'}</button></div><pre id="left-diff-content">Chargement…</pre></div>`;
  $('#preview-diff-action').addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const button = event.currentTarget;
    toggleStage(button.dataset.file, button.dataset.staged === 'true');
  });
  $('#close-diff-preview').addEventListener('click', closeDiffPreview);
  const result = await action('', () => window.forkline.diff(file, staged).then(unwrap));
  if (result !== null) renderDiffContent(result, staged);
}

async function selectConflictFile(file) {
  state.selectedFile = `false:${file}`;
  const versions = await action('', () => window.forkline.conflictVersions(file).then(unwrap));
  if (!versions) return;
  state.conflictResolution = { file, content: versions.result, hunks: parseConflictHunks(versions.result) };
  $('#history-view').classList.remove('hidden');
  $('#changes-view').classList.add('hidden');
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === 'history'));
  $('#history-view').innerHTML = `<div class="conflict-preview"><header><div><p class="eyebrow">RÉSOLUTION DE CONFLIT</p><h3>${escapeHtml(file)}</h3></div><button id="close-diff-preview" type="button" class="icon-button" title="Fermer">×</button></header><div class="conflict-columns"><section><h4>BASE</h4><pre>${escapeHtml(versions.base || 'Version absente')}</pre></section><section><h4>OURS</h4><pre>${escapeHtml(versions.ours || 'Version absente')}</pre><button type="button" class="button button-small" data-conflict-whole="ours">Utiliser ours</button></section><section><h4>THEIRS</h4><pre>${escapeHtml(versions.theirs || 'Version absente')}</pre><button type="button" class="button button-small" data-conflict-whole="theirs">Utiliser theirs</button></section></div><section class="conflict-result"><div><p class="eyebrow">RÉSULTAT</p><button id="save-conflict-result" type="button" class="button button-small button-primary">Marquer comme résolu</button></div><div id="conflict-hunks"></div><textarea id="conflict-result-content" spellcheck="false"></textarea></section></div>`;
  $('#close-diff-preview').addEventListener('click', closeDiffPreview);
  $('[data-conflict-whole="ours"]').addEventListener('click', () => resolveConflict(file, 'ours'));
  $('[data-conflict-whole="theirs"]').addEventListener('click', () => resolveConflict(file, 'theirs'));
  $('#conflict-result-content').value = versions.result;
  $('#conflict-result-content').addEventListener('input', (event) => {
    state.conflictResolution.content = event.target.value;
    state.conflictResolution.hunks = parseConflictHunks(event.target.value);
    renderConflictHunks();
  });
  $('#save-conflict-result').addEventListener('click', () => saveConflictContent(file, $('#conflict-result-content').value));
  renderConflictHunks();
}

function parseConflictHunks(content) {
  const hunks = [];
  const pattern = /^<<<<<<<[^\n]*\n([\s\S]*?)(?:^\|\|\|\|\|\|\|[^\n]*\n[\s\S]*?)?^=======\s*\n([\s\S]*?)^>>>>>>>[^\n]*(?:\n|$)/gm;
  let match;
  while ((match = pattern.exec(content))) hunks.push({ start: match.index, end: pattern.lastIndex, ours: match[1], theirs: match[2] });
  return hunks;
}

function renderConflictHunks() {
  const hunks = state.conflictResolution?.hunks || [];
  $('#conflict-hunks').innerHTML = hunks.length ? hunks.map((hunk, index) => `<article class="conflict-hunk-choice"><header><strong>Conflit ${index + 1}</strong><span><button type="button" data-conflict-hunk="${index}" data-choice="ours">Choisir ours</button><button type="button" data-conflict-hunk="${index}" data-choice="both">Garder les deux</button><button type="button" data-conflict-hunk="${index}" data-choice="theirs">Choisir theirs</button></span></header><div><pre>${escapeHtml(hunk.ours)}</pre><pre>${escapeHtml(hunk.theirs)}</pre></div></article>`).join('') : '<p class="conflict-clean">Aucun marqueur de conflit restant.</p>';
  $$('[data-conflict-hunk]').forEach((button) => button.addEventListener('click', () => chooseConflictHunk(Number(button.dataset.conflictHunk), button.dataset.choice)));
}

function chooseConflictHunk(index, choice) {
  const hunk = state.conflictResolution.hunks[index];
  if (!hunk) return;
  const replacement = choice === 'ours' ? hunk.ours : choice === 'theirs' ? hunk.theirs : `${hunk.ours}${hunk.theirs}`;
  state.conflictResolution.content = `${state.conflictResolution.content.slice(0, hunk.start)}${replacement}${state.conflictResolution.content.slice(hunk.end)}`;
  state.conflictResolution.hunks = parseConflictHunks(state.conflictResolution.content);
  $('#conflict-result-content').value = state.conflictResolution.content;
  renderConflictHunks();
}

async function saveConflictContent(file, content) {
  if (parseConflictHunks(content).length && !window.confirm('Des marqueurs de conflit sont encore présents. Marquer quand même ce fichier comme résolu ?')) return;
  const snapshot = await action('Conflit résolu et fichier indexé', () => window.forkline.resolveConflictContent(file, content).then(unwrap));
  if (snapshot) {
    state.conflictResolution = null;
    applySnapshot(snapshot);
    closeDiffPreview();
    showInspector('#worktree-detail');
  }
}

function renderDiffContent(diff, staged) {
  const hunks = splitDiffHunks(diff);
  $('#left-diff-content').innerHTML = renderDiffMarkup(diff, hunks.length, true, staged);
  $$('.diff-hunk-action').forEach((button) => button.addEventListener('click', () => {
    const patch = hunks[Number(button.dataset.hunk)];
    const reverse = button.classList.contains('discard') || button.classList.contains('unstage');
    const targetStaged = staged || button.classList.contains('stage') || button.classList.contains('unstage');
    const label = button.classList.contains('discard') ? 'Hunk abandonné' : button.classList.contains('unstage') ? 'Hunk retiré de l’index' : 'Hunk indexé';
    action(label, () => window.forkline.applyHunk(patch, targetStaged, reverse).then(unwrap)).then((snapshot) => {
      if (snapshot) applySnapshot(snapshot);
    });
  }));
}

function splitDiffHunks(diff) {
  const lines = diff.split('\n');
  const header = lines.slice(0, lines.findIndex((line) => line.startsWith('@@'))).join('\n');
  const starts = lines.map((line, index) => line.startsWith('@@') ? index : -1).filter((index) => index >= 0);
  return starts.map((start, index) => [header, ...lines.slice(start, starts[index + 1] || lines.length)].join('\n'));
}

function renderDiffMarkup(diff, hunkCount = 0, showActions = true, staged = false) {
  let hunkIndex = -1;
  return escapeHtml(diff).split('\n').map((line) => {
    if (line.startsWith('@@')) {
      hunkIndex += 1;
      const actionButtons = staged
        ? `<button class="diff-hunk-action unstage" data-hunk="${hunkIndex}" type="button">Retirer de l’index</button>`
        : `<button class="diff-hunk-action discard" data-hunk="${hunkIndex}" type="button">Abandonner le hunk</button><button class="diff-hunk-action stage" data-hunk="${hunkIndex}" type="button">Indexer le hunk</button>`;
      const actions = showActions ? `<span class="diff-hunk-actions">${actionButtons}</span>` : '';
      return `<span class="diff-hunk"><span>${line}</span>${actions}</span>`;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="diff-add">${line}</span>`;
    if (line.startsWith('-') && !line.startsWith('---')) return `<span class="diff-remove">${line}</span>`;
    return line;
  }).join('\n');
}

function renderDiff(diff) {
  $('#diff-content').innerHTML = renderDiffMarkup(diff);
}

function closeDiffPreview() {
  state.selectedFile = null;
  state.selectedStash = null;
  renderStashes();
  renderCommits();
  $('#history-view').classList.remove('hidden');
  $('#changes-view').classList.add('hidden');
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === 'history'));
  showInspector('#worktree-detail');
}

function renderStashDetail(stash) {
  $('#stash-detail').innerHTML = `
    <header class="stash-detail-header"><div><p class="eyebrow">${escapeHtml(stash.ref)}</p><h3>${escapeHtml(stash.message)}</h3></div><span class="stash-detail-glyph">▣</span></header>
    <dl class="detail-grid"><dt>Branche</dt><dd>${escapeHtml(stash.branch || 'HEAD détaché')}</dd><dt>Date</dt><dd>${escapeHtml(new Date(stash.date).toLocaleString('fr'))}</dd><dt>Base</dt><dd>${escapeHtml((stash.baseHash || '').slice(0, 10))}</dd><dt>Fichiers</dt><dd>${stash.fileCount}</dd></dl>
    <div class="stash-files">${stash.files.map((file) => `<label><input type="checkbox" data-stash-file value="${escapeHtml(file)}" checked><span>${escapeHtml(file)}</span></label>`).join('')}</div>
    <div class="stash-actions"><button class="button button-primary" data-stash-action="apply">Appliquer tout</button><button class="button" data-stash-action="apply-selected">Appliquer la sélection</button><button class="button" data-stash-action="pop">Appliquer et supprimer</button><button class="button danger" data-stash-action="drop">Supprimer</button></div>`;
  $$('[data-stash-action]').forEach((button) => button.addEventListener('click', () => runStashAction(button.dataset.stashAction, stash.ref)));
  showInspector('#stash-detail');
}

async function selectStash(ref) {
  const stash = (state.snapshot.stashes || []).find((entry) => entry.ref === ref);
  if (!stash) return;
  state.selectedFile = null;
  state.selectedStash = ref;
  renderStashes();
  renderStashDetail(stash);
  $('#history-view').classList.remove('hidden');
  $('#changes-view').classList.add('hidden');
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === 'history'));
  $('#history-view').innerHTML = `<div class="diff-preview stash-diff-preview"><header><div><p class="eyebrow">APERÇU DU STASH · ${escapeHtml(ref)}</p><h3>${escapeHtml(stash.message)}</h3></div><button id="close-diff-preview" type="button" class="icon-button" title="Fermer l’aperçu" aria-label="Fermer l’aperçu">×</button></header><pre id="left-diff-content">Chargement…</pre></div>`;
  $('#close-diff-preview').addEventListener('click', closeDiffPreview);
  const diff = await action('', () => window.forkline.stashDiff(ref).then(unwrap));
  if (diff !== null && state.selectedStash === ref && $('#left-diff-content')) $('#left-diff-content').innerHTML = renderDiffMarkup(diff, 0, false);
}

async function runStashAction(operation, ref) {
  const labels = { apply: 'Stash appliqué', 'apply-selected': 'Fichiers du stash appliqués', pop: 'Stash appliqué et supprimé', drop: 'Stash supprimé' };
  const methods = { apply: 'applyStash', 'apply-selected': 'applyStash', pop: 'popStash', drop: 'dropStash' };
  if (operation === 'drop' && !window.confirm(`Supprimer définitivement ${ref} ?`)) return;
  let selectedFiles = [];
  if (operation === 'apply-selected') {
    selectedFiles = $$('[data-stash-file]:checked').map((input) => input.value);
    if (!selectedFiles.length) {
      toast('Sélectionnez au moins un fichier du stash.', true);
      return;
    }
  }
  if (operation !== 'drop') {
    const staged = state.snapshot.status.files.filter((file) => file.staged);
    if (staged.length) {
      toast('Retirez les fichiers de l’index ou validez-les avant d’appliquer un stash.', true);
      return;
    }
    const unstaged = state.snapshot.status.files.filter((file) => file.workingTree !== ' ' || file.untracked);
    if (unstaged.length && !window.confirm(`Le dépôt contient ${unstaged.length} modification${unstaged.length > 1 ? 's' : ''} non indexée${unstaged.length > 1 ? 's' : ''}. Appliquer le stash par-dessus ?`)) return;
  }
  const result = await action('', () => window.forkline[methods[operation]](ref, selectedFiles).then(unwrap));
  if (!result) return;
  state.selectedStash = null;
  applySnapshot(result.snapshot);
  renderStashes();
  if (result.conflicted) {
    toast(`Conflits dans ${result.conflicts.length} fichier${result.conflicts.length > 1 ? 's' : ''}. Résolvez-les dans le travail en cours.`, true);
    renderCommits();
    showInspector('#worktree-detail');
    return;
  }
  toast(labels[operation]);
  renderCommits();
  showInspector('#worktree-detail');
}

async function toggleStage(file, staged) {
  const result = await action(staged ? 'Fichier retiré de l’index' : 'Fichier ajouté à l’index', () => {
    const method = staged ? 'unstage' : 'stage';
    return window.forkline[method]([file]).then(unwrap);
  });
  if (result) {
    state.snapshot = result;
    renderBranches();
    renderWorktreeInspector();
    showInspector('#worktree-detail');
    if ($('#preview-diff-action')) {
      $('#preview-diff-action').textContent = staged ? 'Ajouter à l’index' : 'Retirer de l’index';
    }
  }
}

async function switchBranch(name) {
  if (name === state.snapshot.head) return;
  const result = await action(`Branche ${name} activée`, () => window.forkline.switchBranch(name).then(unwrap));
  if (result) applySnapshot(result);
}

async function refresh(silent = false) {
  if (!state.snapshot || state.busy) return;
  const result = await action(silent ? '' : 'Dépôt actualisé', () => window.forkline.refresh().then(unwrap));
  if (result) {
    const selectedFile = state.selectedFile;
    applySnapshot(result);
    if (selectedFile) {
      const separator = selectedFile.indexOf(':');
      const file = selectedFile.slice(separator + 1);
      const currentFile = result.status.files.find((item) => item.path === file);
      if (currentFile) await selectFile(file, currentFile.staged);
      else state.selectedFile = null;
    }
  }
}

async function handleRepositoryUpdate(snapshot) {
  if (state.branchCreation.pending) console.info('[branch-create] renderer refresh received', JSON.stringify({ repositoryRevision: snapshot.repositoryRevision, head: snapshot.head, branchCount: snapshot.branches.filter((branch) => !branch.remote).length }));
  if (state.busy) {
    if (!state.pendingSnapshot?.repositoryRevision || state.pendingSnapshot.repositoryRevision < snapshot.repositoryRevision) state.pendingSnapshot = snapshot;
    return;
  }

  const historyScroll = $('#history-view')?.scrollTop || 0;
  const worktreeScroll = $('#worktree-detail')?.scrollTop || 0;
  const commitDetailScroll = $('#commit-detail')?.scrollTop || 0;
  const diffScroll = $('#left-diff-content') ? { top: $('#left-diff-content').scrollTop, left: $('#left-diff-content').scrollLeft } : null;
  const selectedFile = state.selectedFile;
  const selectedCommit = state.selectedCommit;
  const selectedStash = state.selectedStash;
  const diffWasOpen = Boolean($('#left-diff-content'));
  const worktreeWasOpen = !$('#worktree-detail').classList.contains('hidden');
  const selectedPath = selectedFile ? selectedFile.slice(selectedFile.indexOf(':') + 1) : null;
  const currentFile = selectedPath ? snapshot.status.files.find((item) => item.path === selectedPath) : null;
  const currentStash = selectedStash ? (snapshot.stashes || []).find((stash) => stash.ref === selectedStash) : null;
  const preserveStash = diffWasOpen && Boolean(currentStash);
  const preserveDiff = diffWasOpen && (Boolean(currentFile) || preserveStash);
  if (!applySnapshot(snapshot, { preserveHistory: preserveDiff })) return;

  if (preserveStash) {
    state.selectedStash = currentStash.ref;
    renderStashes();
    renderStashDetail(currentStash);
    const diff = await window.forkline.stashDiff(currentStash.ref).then(unwrap);
    if (state.snapshot.repositoryRevision !== snapshot.repositoryRevision || !$('#left-diff-content')) return;
    $('#left-diff-content').innerHTML = renderDiffMarkup(diff, 0, false);
  } else if (preserveDiff) {
    state.selectedFile = `${currentFile.staged}:${selectedPath}`;
    const diff = await window.forkline.diff(selectedPath, currentFile.staged).then(unwrap);
    if (state.snapshot.repositoryRevision !== snapshot.repositoryRevision || !$('#left-diff-content')) return;
    renderDiffContent(diff, currentFile.staged);
    $('#preview-diff-action').textContent = currentFile.staged ? 'Retirer de l’index' : 'Ajouter à l’index';
    $('#preview-diff-action').dataset.staged = currentFile.staged;
  } else if (diffWasOpen) {
    state.selectedFile = null;
    state.selectedStash = null;
  } else if (selectedCommit && snapshot.commits.some((commit) => commit.hash === selectedCommit)) {
    selectCommit(selectedCommit);
  } else if (worktreeWasOpen) {
    showInspector('#worktree-detail');
  }

  requestAnimationFrame(() => {
    if ($('#history-view')) $('#history-view').scrollTop = historyScroll;
    if ($('#worktree-detail')) $('#worktree-detail').scrollTop = worktreeScroll;
    if ($('#commit-detail')) $('#commit-detail').scrollTop = commitDetailScroll;
    if (diffScroll && $('#left-diff-content')) {
      $('#left-diff-content').scrollTop = diffScroll.top;
      $('#left-diff-content').scrollLeft = diffScroll.left;
    }
  });
}

async function openRepository() {
  const result = await action('', () => window.forkline.chooseRepository().then(unwrap));
  if (result) applySnapshot(result);
}

async function cloneRepository() {
  const source = window.prompt('Adresse HTTPS, SSH ou chemin du dépôt à cloner :');
  if (!source?.trim()) return;
  const inferred = source.trim().replace(/[\\/]$/, '').split(/[\\/]/).pop().replace(/\.git$/, '') || 'depot';
  const directoryName = window.prompt('Nom du dossier de destination :', inferred);
  if (!directoryName?.trim()) return;
  const result = await action('', () => window.forkline.cloneRepository(source.trim(), directoryName.trim()).then(unwrap));
  if (result) applySnapshot(result);
}

async function initializeRepository() {
  const branch = window.prompt('Nom de la branche initiale :', 'main');
  if (!branch?.trim()) return;
  const result = await action('', () => window.forkline.initializeRepository(branch.trim()).then(unwrap));
  if (result) applySnapshot(result);
}

function setView(view) {
  state.view = view;
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  $('#history-view').classList.toggle('hidden', view !== 'history');
  $('#changes-view').classList.toggle('hidden', view !== 'changes');
  $('#view-kicker').textContent = view === 'history' ? 'CHRONOLOGIE' : 'ESPACE DE TRAVAIL';
  $('#view-title').textContent = view === 'history' ? 'Historique du dépôt' : 'Préparer un commit';
}

$('#open-repo-welcome').addEventListener('click', openRepository);
$('#clone-repo-welcome').addEventListener('click', cloneRepository);
$('#init-repo-welcome').addEventListener('click', initializeRepository);
document.addEventListener('click', (event) => {
  if (!event.target.closest('#branch-context-menu')) closeBranchContextMenu();
  if (!event.target.closest('#commit-context-menu')) closeCommitContextMenu();
  if (!event.target.closest('#stash-context-menu')) closeStashContextMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeBranchContextMenu();
    closeCommitContextMenu();
    closeStashContextMenu();
  }
});
window.addEventListener('blur', () => {
  closeBranchContextMenu();
  closeCommitContextMenu();
  closeStashContextMenu();
});
$('#open-repo').addEventListener('click', openRepository);
$('#toolbar-repository').addEventListener('click', openRepository);
$('#refresh').addEventListener('click', () => refresh());
async function performUndo(count = 1) {
  const history = state.snapshot.undoHistory || [];
  const target = history[Math.min(count, history.length) - 1]?.label || state.snapshot.undoPlan?.label;
  if (!state.snapshot.undoPlan?.available || !window.confirm(`${count > 1 ? `Annuler ${count} actions jusqu’à « ${target} »` : target} ?\n\nForkline conservera les modifications des commits annulés dans l’index.`)) return;
  const result = await action('', () => window.forkline.undo(count).then(unwrap));
  if (result?.snapshot) {
    applySnapshot(result.snapshot);
    toast(result.labels?.length > 1 ? `${result.labels.length} actions annulées` : result.labels?.[0] || 'Action annulée');
  }
}

async function performRedo(count = 1) {
  const history = state.snapshot.redoHistory || [];
  const target = history[Math.min(count, history.length) - 1]?.label || 'la dernière action';
  if (!state.snapshot.redoAvailable || !window.confirm(count > 1 ? `Rétablir ${count} actions jusqu’à « ${target} » ?` : `Rétablir « ${target} » ?`)) return;
  const result = await action('', () => window.forkline.redo(count).then(unwrap));
  if (result?.snapshot) {
    applySnapshot(result.snapshot);
    toast(result.labels?.length > 1 ? `${result.labels.length} actions rétablies` : result.labels?.[0] || 'Action rétablie');
  }
}

$('#undo').addEventListener('click', () => performUndo(1));
$('#redo').addEventListener('click', () => performRedo(1));
$('#undo').addEventListener('contextmenu', (event) => {
  event.preventDefault();
  const history = state.snapshot.undoHistory || [];
  if (!history.length) return;
  showSimpleContextMenu('Historique des actions à annuler', history.slice(0, 10).map((entry, index) => ({ id: `undo-${index}`, icon: '↶', label: entry.label, run: () => performUndo(index + 1) })), event.clientX, event.clientY);
});
$('#redo').addEventListener('contextmenu', (event) => {
  event.preventDefault();
  const history = state.snapshot.redoHistory || [];
  if (!history.length) return;
  showSimpleContextMenu('Historique des actions à rétablir', history.slice(0, 10).map((entry, index) => ({ id: `redo-${index}`, icon: '↷', label: entry.label, run: () => performRedo(index + 1) })), event.clientX, event.clientY);
});
$$('.nav-item').forEach((item) => item.addEventListener('click', () => setView(item.dataset.view)));
$('#diff-action').addEventListener('click', () => toggleStage($('#diff-action').dataset.file, $('#diff-action').dataset.staged === 'true'));
$('#stage-all').addEventListener('click', async () => {
  const files = state.snapshot.status.files.filter((file) => file.workingTree !== ' ' || file.untracked).map((file) => file.path);
  if (!files.length) return;
  const result = await action('Tous les fichiers ont été ajoutés', () => window.forkline.stage(files).then(unwrap));
  if (result) applySnapshot(result);
});
$('#unstage-all').addEventListener('click', async () => {
  const files = state.snapshot.status.files.filter((file) => file.staged).map((file) => file.path);
  if (!files.length) return;
  const result = await action('Index vidé', () => window.forkline.unstage(files).then(unwrap));
  if (result) applySnapshot(result);
});
$('#commit').addEventListener('click', async () => {
  const message = $('#commit-message').value.trim();
  const amend = $('#commit-amend').checked;
  const sign = $('#commit-sign').checked;
  const result = await action(amend ? 'Dernier commit modifié' : 'Commit créé', () => window.forkline.commit(message, { amend, sign }).then(unwrap));
  if (result) {
    $('#commit-message').value = '';
    $('#commit-amend').checked = false;
    applySnapshot(result.snapshot);
    setView('history');
  }
});
$('#commit-amend').addEventListener('change', (event) => {
  if (event.target.checked && !$('#commit-message').value.trim()) $('#commit-message').value = state.snapshot.commits.find((commit) => commit.hash === state.snapshot.headHash)?.subject || '';
});

$('#pull').addEventListener('click', () => executeRepositoryAction('Pull terminé', () => window.forkline.pull()));
$('#push').addEventListener('click', () => pushBranchFromUi(state.snapshot.branches.find((branch) => !branch.remote && branch.current)));

$('#pull').addEventListener('contextmenu', (event) => {
  event.preventDefault();
  showSimpleContextMenu('Options de Pull', [
    { id: 'ff-only', icon: '↓', label: 'Pull fast-forward uniquement', run: () => executeRepositoryAction('Pull terminé', () => window.forkline.pull({ strategy: 'ff-only' })) },
    { id: 'rebase', icon: '⇢', label: 'Pull avec rebase', run: () => executeRepositoryAction('Pull avec rebase terminé', () => window.forkline.pull({ strategy: 'rebase' })) },
    { id: 'merge', icon: '↘', label: 'Pull avec merge', run: () => executeRepositoryAction('Pull avec merge terminé', () => window.forkline.pull({ strategy: 'merge' })) },
    { id: 'from', icon: '☁', label: 'Pull depuis un remote et une branche…', run: () => pullFromRemote() },
  ], event.clientX, event.clientY);
});

$('#push').addEventListener('contextmenu', (event) => {
  event.preventDefault();
  showSimpleContextMenu('Options de Push', [
    { id: 'normal', icon: '↑', label: 'Push', run: () => pushBranchFromUi(state.snapshot.branches.find((branch) => !branch.remote && branch.current)) },
    { id: 'tags', icon: '◇', label: 'Push avec tous les tags', run: () => pushBranchFromUi(state.snapshot.branches.find((branch) => !branch.remote && branch.current), { tags: true }) },
    { id: 'force-lease', icon: '⇡', label: 'Force push sécurisé (with lease)', run: async () => { if (window.confirm('Réécrire la branche distante avec --force-with-lease ?')) await pushBranchFromUi(state.snapshot.branches.find((branch) => !branch.remote && branch.current), { forceWithLease: true }); } },
    { id: 'to', icon: '☁', label: 'Push vers un remote…', run: () => pushToRemote() },
  ], event.clientX, event.clientY);
});

async function pullFromRemote() {
  const defaultRemote = state.snapshot.remotes[0]?.name || '';
  const remote = window.prompt('Dépôt distant :', defaultRemote);
  if (!remote?.trim()) return;
  const branch = window.prompt('Branche distante :', state.snapshot.head);
  if (!branch?.trim()) return;
  const strategy = window.prompt('Stratégie : ff-only, rebase ou merge', 'ff-only')?.trim();
  if (!strategy) return;
  await executeRepositoryAction('Pull terminé', () => window.forkline.pull({ remote: remote.trim(), branch: branch.trim(), strategy }));
}

async function pushToRemote() {
  const branch = state.snapshot.branches.find((candidate) => !candidate.remote && candidate.current);
  if (!branch) return toast('Aucune branche locale active à publier.', true);
  return openUpstreamDialog(branch, 'publish');
}

$('#fetch').addEventListener('click', () => executeRepositoryAction('Références distantes récupérées', () => window.forkline.fetch()));
$('#open-terminal').addEventListener('click', () => action('', () => window.forkline.openTerminal().then(unwrap)));
$('#toolbar-repository').addEventListener('contextmenu', (event) => {
  event.preventDefault();
  showSimpleContextMenu(state.snapshot.repository, [
    { id: 'folder', icon: '↗', label: 'Ouvrir le dossier du dépôt', run: () => action('', () => window.forkline.openRepositoryFolder().then(unwrap)) },
    { id: 'editor', icon: '⚙', label: 'Configurer l’éditeur externe…', run: () => configureExternalEditor() },
    { id: 'patch', icon: '▣', label: 'Appliquer un patch…', run: () => executeRepositoryAction('Patch appliqué', () => window.forkline.applyPatch()) },
    { id: 'clipboard', icon: '▤', label: 'Appliquer le patch du presse-papiers', run: () => applyPatchFromClipboard() },
  ], event.clientX, event.clientY);
});

async function configureExternalEditor() {
  const command = window.prompt('Commande de l’éditeur externe (laisser vide pour utiliser l’application système) :', state.externalEditorCommand || 'phpstorm');
  if (command === null) return;
  const saved = await action('', () => window.forkline.setExternalEditor(command.trim()).then(unwrap));
  if (saved === null) return;
  state.externalEditorCommand = saved;
  toast(saved ? 'Éditeur externe configuré' : 'Application système utilisée par défaut');
}

async function applyPatchFromClipboard() {
  let patch;
  try {
    patch = await navigator.clipboard.readText();
  } catch {
    return toast('Impossible d’accéder au presse-papiers.', true);
  }
  if (!patch.trim()) return toast('Le presse-papiers ne contient aucun patch.', true);
  return executeRepositoryAction('Patch du presse-papiers appliqué', () => window.forkline.applyPatchContent(patch));
}

function branchNameError(value, allowedExistingName = null) {
  const name = value.trim();
  if (!name) return 'Le nom de la branche est obligatoire.';
  if (state.snapshot.branches.some((branch) => !branch.remote && branch.name === name) && name !== allowedExistingName) return `La branche « ${name} » existe déjà.`;
  if (name === '@' || name.startsWith('-') || name.startsWith('.') || name.endsWith('.') || name.endsWith('/') || name.endsWith('.lock')
    || name.includes('..') || name.includes('@{') || /[\x00-\x20\x7f~^:?*[\\]/.test(name)
    || name.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) return 'Ce nom de branche n’est pas valide.';
  return '';
}

function renameBranchError(value) {
  const name = value.trim();
  if (name === state.branchRename.originalName) return 'Le nouveau nom doit être différent du nom actuel.';
  return branchNameError(value, state.branchRename.originalName);
}

function renderRenameBranchValidation(force = false) {
  const error = renameBranchError($('#rename-branch-name').value);
  const hasChanged = $('#rename-branch-name').value.trim() !== state.branchRename.originalName;
  const visibleError = force || hasChanged ? error : '';
  $('#rename-branch-error').textContent = visibleError;
  $('#rename-branch-error').classList.toggle('hidden', !visibleError);
  $('#rename-branch-name').setAttribute('aria-invalid', visibleError ? 'true' : 'false');
  return error;
}

function openRenameBranchDialog(branch) {
  state.branchRename = { originalName: branch.name, pending: false };
  $('#rename-branch-source').textContent = branch.name;
  $('#rename-branch-name').value = branch.name;
  renderRenameBranchValidation(false);
  $('#rename-branch-dialog').showModal();
  setTimeout(() => {
    $('#rename-branch-name').focus();
    $('#rename-branch-name').select();
  }, 50);
}

function renderBranchDialogValidation(force = false) {
  const error = branchNameError($('#branch-name').value);
  const visibleError = force || $('#branch-name').value ? error : '';
  $('#branch-error').textContent = visibleError;
  $('#branch-error').classList.toggle('hidden', !visibleError);
  $('#branch-name').setAttribute('aria-invalid', error ? 'true' : 'false');
  return error;
}

function updateBranchDialogAction() {
  $('#confirm-branch').textContent = $('#branch-checkout').checked ? 'Créer et basculer' : 'Créer la branche';
}

function openBranchDialog(startPoint = state.snapshot.head, sourceLabel = startPoint) {
  state.branchCreation = { startPoint, sourceLabel, pending: false };
  $('#branch-name').value = '';
  $('#branch-source').textContent = sourceLabel;
  $('#branch-checkout').checked = true;
  renderBranchDialogValidation(false);
  updateBranchDialogAction();
  $('#branch-dialog').showModal();
  setTimeout(() => $('#branch-name').focus(), 50);
}

$('#new-branch').addEventListener('click', () => openBranchDialog());
$('#toolbar-new-branch').addEventListener('click', () => openBranchDialog());
$('#branch-name').addEventListener('input', () => renderBranchDialogValidation(false));
$('#branch-checkout').addEventListener('change', updateBranchDialogAction);
$('#rename-branch-name').addEventListener('input', () => renderRenameBranchValidation(false));
$('#new-tag').addEventListener('click', () => createTagAt(state.snapshot.headHash, false, state.snapshot.head));
$('#tag-name').addEventListener('input', () => renderTagDialogValidation(false));
$('#tag-message').addEventListener('input', () => renderTagDialogValidation(false));
$('#tag-annotated').addEventListener('change', updateTagDialogType);
$('#upstream-remote').addEventListener('change', renderUpstreamBranchOptions);
$('#upstream-branch').addEventListener('input', () => renderUpstreamDialogValidation(false));
$('#new-remote').addEventListener('click', async () => {
  const name = window.prompt('Nom du dépôt distant :', 'origin');
  if (!name?.trim()) return;
  const url = window.prompt('Adresse du dépôt distant :');
  if (url?.trim()) await executeRepositoryAction(`Dépôt distant ${name.trim()} ajouté`, () => window.forkline.addRemote(name.trim(), url.trim()));
});
$('#new-submodule').addEventListener('click', async () => {
  const url = window.prompt('Adresse HTTPS, SSH ou chemin du sous-module :');
  if (!url?.trim()) return;
  const inferred = url.trim().replace(/[\\/]$/, '').split(/[\\/]/).pop().replace(/\.git$/, '') || 'module';
  const submodulePath = window.prompt('Chemin du sous-module dans le dépôt :', `modules/${inferred}`);
  if (!submodulePath?.trim()) return;
  const branch = window.prompt('Branche à suivre (optionnel) :', '') || '';
  await executeRepositoryAction('Sous-module ajouté', () => window.forkline.addSubmodule(url.trim(), submodulePath.trim(), branch.trim()));
});
$('#new-worktree').addEventListener('click', async () => {
  const branch = window.prompt('Branche du worktree (existante ou nouvelle) :');
  if (!branch?.trim()) return;
  const exists = state.snapshot.branches.some((candidate) => !candidate.remote && candidate.name === branch.trim());
  const directoryName = window.prompt('Nom du dossier du worktree :', branch.trim().split('/').pop());
  if (!directoryName?.trim()) return;
  await executeRepositoryAction('Worktree créé', () => window.forkline.addWorktree({ branch: branch.trim(), createBranch: !exists, startPoint: state.snapshot.headHash, directoryName: directoryName.trim() }));
});
$('#new-lfs-pattern').addEventListener('click', async () => {
  if (!state.snapshot.lfs?.available) return;
  const pattern = window.prompt('Motif de fichiers à suivre avec Git LFS :', '*.bin');
  if (pattern?.trim()) await executeRepositoryAction('Motif LFS ajouté', () => window.forkline.trackLfs(pattern.trim()));
});
$('#git-identity').addEventListener('click', () => {
  const identity = state.snapshot.identity || {};
  $('#identity-name').value = identity.name || '';
  $('#identity-email').value = identity.email || '';
  $('#identity-scope').value = identity.scope || 'local';
  $('#identity-gpg-sign').checked = Boolean(state.snapshot.commitPreferences?.gpgSign);
  $('#identity-signing-key').value = state.snapshot.commitPreferences?.signingKey || '';
  const hooks = state.snapshot.commitPreferences?.hooks || [];
  $('#identity-hooks').textContent = hooks.length ? `Hooks actifs : ${hooks.join(', ')}` : 'Aucun hook Git actif détecté.';
  renderGitProfileOptions();
  const assignedProfile = state.gitProfiles.find((entry) => entry.id === state.assignedProfileId);
  $('#identity-path-pattern').value = assignedProfile?.pathPattern || '';
  $('#identity-remote-pattern').value = assignedProfile?.remotePattern || '';
  $('#identity-dialog').showModal();
});
$('#identity-profile').addEventListener('change', () => {
  const profile = state.gitProfiles.find((entry) => entry.id === $('#identity-profile').value);
  if (profile) fillIdentityFromProfile(profile);
  else {
    $('#identity-path-pattern').value = '';
    $('#identity-remote-pattern').value = '';
  }
  $('#delete-identity-profile').disabled = !profile;
});
$('#save-identity-profile').addEventListener('click', async () => {
  const label = window.prompt('Nom du profil :', state.gitProfiles.find((entry) => entry.id === $('#identity-profile').value)?.label || 'Profil Git');
  if (!label?.trim()) return;
  const saved = await action('', () => window.forkline.saveGitProfile({ id: $('#identity-profile').value || undefined, label: label.trim(), name: $('#identity-name').value, email: $('#identity-email').value, gpgSign: $('#identity-gpg-sign').checked, signingKey: $('#identity-signing-key').value, pathPattern: $('#identity-path-pattern').value, remotePattern: $('#identity-remote-pattern').value }).then(unwrap));
  if (!saved) return;
  await refreshGitProfiles();
  $('#identity-profile').value = saved.id;
  const snapshot = await action('Profil enregistré et appliqué', () => window.forkline.applyGitProfile(saved.id, true).then(unwrap));
  if (snapshot) applySnapshot(snapshot);
});
$('#apply-identity-profile').addEventListener('click', async () => {
  const profileId = $('#identity-profile').value;
  if (!profileId) return toast('Sélectionnez un profil enregistré.', true);
  const snapshot = await action('Profil appliqué à ce dépôt', () => window.forkline.applyGitProfile(profileId, true).then(unwrap));
  if (snapshot) {
    applySnapshot(snapshot);
    await refreshGitProfiles();
  }
});
$('#delete-identity-profile').addEventListener('click', async () => {
  const profileId = $('#identity-profile').value;
  const profile = state.gitProfiles.find((entry) => entry.id === profileId);
  if (!profile || !window.confirm(`Supprimer le profil ${profile.label} ?`)) return;
  const removed = await action('Profil supprimé', () => window.forkline.deleteGitProfile(profileId).then(unwrap));
  if (removed) await refreshGitProfiles();
});

function openStashDialog() {
  const files = state.snapshot?.status.files || [];
  if (!files.length) {
    toast('Aucune modification à mettre de côté.', true);
    return;
  }
  $('#stash-message').value = '';
  $('#stash-include-untracked').checked = files.some((file) => file.untracked);
  $('#stash-keep-index').checked = false;
  $('#stash-dialog-files').innerHTML = files.map((file) => `
    <label class="stash-file-option"><input type="checkbox" value="${escapeHtml(file.path)}" checked><span class="status-badge${file.untracked ? ' untracked' : ''}">${escapeHtml(statusLabel(file))}</span><span title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</span></label>`).join('');
  $('#stash-dialog').showModal();
  setTimeout(() => $('#stash-message').focus(), 50);
}

$('#new-stash').addEventListener('click', openStashDialog);
$('#toolbar-stash').addEventListener('click', openStashDialog);
$('#toolbar-pop-stash').addEventListener('click', () => {
  const latest = state.snapshot?.stashes?.[0];
  if (latest) runStashAction('pop', latest.ref);
});
$('#confirm-stash').addEventListener('click', async (event) => {
  event.preventDefault();
  const files = $$('#stash-dialog-files input:checked').map((input) => input.value);
  if (!files.length) {
    toast('Sélectionnez au moins un fichier.', true);
    return;
  }
  const options = {
    message: $('#stash-message').value.trim(),
    includeUntracked: $('#stash-include-untracked').checked,
    keepIndex: $('#stash-keep-index').checked,
    files,
  };
  const result = await action('', () => window.forkline.createStash(options).then(unwrap));
  if (!result) return;
  $('#stash-dialog').close();
  applySnapshot(result.snapshot);
  renderCommits();
  toast('Stash créé');
});

$('#confirm-rebase').addEventListener('click', async (event) => {
  event.preventDefault();
  const firstKept = state.rebasePlan.find((commit) => commit.action !== 'drop');
  if (!firstKept || !['pick', 'reword'].includes(firstKept.action)) return toast('Le premier commit conservé doit être conservé ou renommé.', true);
  if (!window.confirm('Démarrer ce rebase interactif et réécrire l’historique local ?')) return;
  $('#rebase-dialog').close();
  await executeRepositoryAction('Rebase interactif terminé', () => window.forkline.interactiveRebase(state.rebaseBaseHash, state.rebasePlan.map(({ hash, action: rebaseAction, message }) => ({ hash, action: rebaseAction, message }))));
});
$('#confirm-identity').addEventListener('click', async (event) => {
  event.preventDefault();
  const identityResult = await executeRepositoryAction('', () => window.forkline.setIdentity($('#identity-name').value, $('#identity-email').value, $('#identity-scope').value));
  if (!identityResult) return;
  const result = await executeRepositoryAction('Identité et signature Git enregistrées', () => window.forkline.setCommitPreferences({ scope: $('#identity-scope').value, gpgSign: $('#identity-gpg-sign').checked, signingKey: $('#identity-signing-key').value }));
  if (result) $('#identity-dialog').close();
});
$('#confirm-branch').addEventListener('click', async (event) => {
  event.preventDefault();
  const name = $('#branch-name').value.trim();
  if (renderBranchDialogValidation(true)) return $('#branch-name').focus();
  const checkout = $('#branch-checkout').checked;
  state.branchCreation.pending = true;
  console.info('[branch-create] submit', JSON.stringify({ name, startPoint: state.branchCreation.startPoint, checkout }));
  const result = await executeRepositoryAction(
    checkout ? `Branche ${name} créée et activée` : `Branche ${name} créée`,
    () => window.forkline.createBranch(name, state.branchCreation.startPoint, checkout),
  );
  if (result) {
    console.info('[branch-create] renderer views refreshed', JSON.stringify({ repositoryRevision: state.snapshot.repositoryRevision, head: state.snapshot.head, branches: state.snapshot.branches.filter((branch) => !branch.remote).map((branch) => ({ name: branch.name, hash: branch.hash, current: branch.current })) }));
    $('#branch-dialog').close();
  } else {
    console.error('[branch-create] renderer creation failed', JSON.stringify({ name, startPoint: state.branchCreation.startPoint, checkout }));
  }
  state.branchCreation.pending = false;
});
$('#confirm-rename-branch').addEventListener('click', async (event) => {
  event.preventDefault();
  if (state.branchRename.pending || renderRenameBranchValidation(true)) return $('#rename-branch-name').focus();
  const originalName = state.branchRename.originalName;
  const newName = $('#rename-branch-name').value.trim();
  state.branchRename.pending = true;
  $('#confirm-rename-branch').disabled = true;
  const result = await executeRepositoryAction(`Branche renommée en ${newName}`, () => window.forkline.renameBranch(originalName, newName));
  state.branchRename.pending = false;
  $('#confirm-rename-branch').disabled = false;
  if (result) $('#rename-branch-dialog').close();
});
$('#confirm-tag').addEventListener('click', async (event) => {
  event.preventDefault();
  if (renderTagDialogValidation(true)) return $('#tag-name').focus();
  const name = $('#tag-name').value.trim();
  const message = $('#tag-annotated').checked ? $('#tag-message').value.trim() : '';
  state.tagCreation.pending = true;
  const result = await executeRepositoryAction(`Tag ${name} créé`, () => window.forkline.createTag(name, state.tagCreation.revision, message));
  state.tagCreation.pending = false;
  if (result) $('#tag-dialog').close();
});
$('#confirm-upstream').addEventListener('click', async (event) => {
  event.preventDefault();
  if (state.upstreamAssignment.pending || renderUpstreamDialogValidation(true)) return $('#upstream-branch').focus();
  const remote = $('#upstream-remote').value;
  const remoteBranch = $('#upstream-branch').value.trim();
  state.upstreamAssignment.pending = true;
  $('#confirm-upstream').disabled = true;
  const publishing = state.upstreamAssignment.mode === 'publish';
  const result = publishing
    ? await executeRepositoryAction(`Branche ${state.upstreamAssignment.branch} publiée`, () => window.forkline.pushBranch(state.upstreamAssignment.branch, { ...state.upstreamAssignment.pushOptions, remote, remoteBranch }))
    : await executeRepositoryAction('Branche distante associée', () => window.forkline.setUpstream(state.upstreamAssignment.branch, remote, remoteBranch));
  state.upstreamAssignment.pending = false;
  $('#confirm-upstream').disabled = false;
  if (result) $('#upstream-dialog').close();
});

window.forkline.onRepositoryUpdated(handleRepositoryUpdate);

(async () => {
  const result = await action('', () => window.forkline.restoreRepository().then(unwrap));
  if (result) applySnapshot(result);
  else $('#restore-status').textContent = 'Choisissez un dossier contenant un dépôt Git.';
})();
