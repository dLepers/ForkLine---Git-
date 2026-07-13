const state = {
  snapshot: null,
  view: 'history',
  selectedFile: null,
  selectedCommit: null,
  busy: false,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function unwrap(result) {
  if (!result?.ok) throw new Error(result?.error?.message || 'Une erreur est survenue.');
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
    if (result) toast(label);
    return result;
  } catch (error) {
    toast(error.message, true);
    return null;
  } finally {
    state.busy = false;
    document.body.style.cursor = '';
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
  const code = file.staged ? file.index : file.workingTree;
  return code === '?' ? 'N' : code || 'M';
}

function applySnapshot(snapshot) {
  state.snapshot = snapshot;
  const repoName = basename(snapshot.repository);
  $('#repo-name').textContent = repoName;
  $('#repo-title').textContent = `${repoName}  ·  ${snapshot.head}`;
  $('#commit-count').textContent = snapshot.commits.length;
  $('#change-count').textContent = snapshot.status.files.length || '';
  $('#branch-source').textContent = snapshot.head;
  renderBranches();
  renderRemotes();
  renderCommits();
  renderChanges();
  $('#welcome').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
}

function renderBranches() {
  const local = state.snapshot.branches.filter((branch) => !branch.remote);
  const graph = window.ForklineGraph.layoutCommitGraph(state.snapshot.commits, { headHash: state.snapshot.headHash, branches: state.snapshot.branches });
  $('#branches').innerHTML = local.map((branch) => `
    <button class="branch-item${branch.current ? ' current' : ''}" style="--branch-color: ${graphColorForHash(graph, branch.hash)}" data-branch="${escapeHtml(branch.name)}" title="${escapeHtml(branchSyncDetails(branch).tooltip)}" aria-label="${escapeHtml(`${branch.name} : ${branchSyncDetails(branch).tooltip}`)}">
      <span class="branch-symbol"><i></i></span><span>${escapeHtml(branch.name)}</span>${renderBranchSync(branch)}${branch.current ? '<b>HEAD</b>' : ''}
    </button>`).join('');
  $$('.branch-item').forEach((button) => button.addEventListener('click', () => switchBranch(button.dataset.branch)));
}

function branchSyncDetails(branch) {
  const tracking = branch.tracking || { state: branch.upstream ? 'up-to-date' : 'local', ahead: 0, behind: 0 };
  const upstream = branch.upstream || '';
  if (tracking.state === 'gone') {
    return { state: 'gone', icons: ['⚠️'], tooltip: `Dépôt distant introuvable${upstream ? ` (${upstream})` : ''} : upstream supprimé` };
  }
  if (!upstream) {
    return { state: 'local', icons: ['💻'], tooltip: 'Branche uniquement locale, sans dépôt distant associé' };
  }
  const suffix = `${tracking.ahead} commit${tracking.ahead > 1 ? 's' : ''} à pousser, ${tracking.behind} commit${tracking.behind > 1 ? 's' : ''} à récupérer`;
  if (tracking.state === 'diverged') return { state: 'diverged', icons: ['☁️', '🔄'], tooltip: `Branche suivie par ${upstream}. Divergence : ${suffix}` };
  if (tracking.state === 'ahead') return { state: 'ahead', icons: ['☁️', '⬆️'], tooltip: `Branche suivie par ${upstream}. ${suffix}` };
  if (tracking.state === 'behind') return { state: 'behind', icons: ['☁️', '⬇️'], tooltip: `Branche suivie par ${upstream}. ${suffix}` };
  return { state: 'up-to-date', icons: ['☁️'], tooltip: `Branche suivie par ${upstream}, à jour avec le dépôt distant` };
}

function renderBranchSync(branch) {
  const details = branchSyncDetails(branch);
  return `<span class="branch-sync" aria-hidden="true">${details.icons.map((icon) => `<span>${icon}</span>`).join('')}</span>`;
}

function renderRemotes() {
  const remoteBranches = state.snapshot.branches.filter((branch) => branch.remote && !branch.symbolic && !branch.name.includes('HEAD'));
  $('#remotes').innerHTML = state.snapshot.remotes.length
    ? state.snapshot.remotes.map((remote) => {
      const prefix = `${remote.name}/`;
      const branches = remoteBranches.filter((branch) => branch.name.startsWith(prefix));
      return `<div class="remote-group" title="${escapeHtml(remote.fetchUrl || '')}">
        <div class="remote-item"><span class="remote-glyph">⌁</span><span>${escapeHtml(remote.name)}</span><b>${branches.length}</b></div>
        ${branches.map((branch) => `<div class="remote-branch"><span class="branch-symbol"><i></i></span><span>${escapeHtml(branch.name.slice(prefix.length))}</span></div>`).join('')}
      </div>`;
    }).join('')
    : '<div class="remote-item"><span class="remote-glyph">—</span><span>Aucun distant</span></div>';
}

const GRAPH_COLORS = ['#e95f36', '#3c91d4', '#57a773', '#d8a62a', '#d36b9d', '#8a77cf', '#39a6a3', '#c47b42'];

function graphColor(lane) {
  return GRAPH_COLORS[lane % GRAPH_COLORS.length];
}

function graphColorForHash(graph, hash) {
  const index = state.snapshot.commits.findIndex((commit) => commit.hash === hash);
  return index >= 0 ? graphColor(graph.rows[index].laneColor) : '#6c7169';
}

function graphLabelDetails(commit, branchColor) {
  const localBranches = state.snapshot.branches.filter((branch) => !branch.remote);
  const remoteBranches = state.snapshot.branches.filter((branch) => branch.remote && !branch.symbolic && !branch.name.includes('HEAD'));
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

    const iconTypes = ['local'];
    if (sync?.state === 'gone') iconTypes.push('warning');
    else if (matchingRemote || upstream) iconTypes.push('remote');
    if (sync?.state === 'ahead') iconTypes.push('ahead');
    if (sync?.state === 'behind') iconTypes.push('behind');
    if (sync?.state === 'diverged') iconTypes.push('diverged');

    const tooltip = matchingRemote && !upstream
      ? `Branche locale ${branch.name} et distante ${matchingRemote.name} sur le même commit`
      : sync.tooltip;
    labels.push({ anchorHash: commit.hash, name: branch.name, type: branch.current ? 'head' : 'local', color: branchColor, iconTypes, tooltip });
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
  if (type === 'local') return `<g class="sync-icon" stroke="${color}" fill="none" stroke-width="1.2"><rect x="${x}" y="${y + 1}" width="9" height="6" rx="1"/><path d="M ${x + 2} ${y + 9} H ${x + 7} M ${x + 4.5} ${y + 7} V ${y + 9}"/></g>`;
  if (type === 'remote') return `<path class="sync-icon" d="M ${x + 1} ${y + 8} H ${x + 10} C ${x + 12} ${y + 8}, ${x + 12} ${y + 5}, ${x + 10} ${y + 4} C ${x + 9} ${y + 1}, ${x + 5} ${y + 1}, ${x + 4} ${y + 4} C ${x + 1} ${y + 3}, ${x} ${y + 7}, ${x + 1} ${y + 8}" fill="none" stroke="${color}" stroke-width="1.2"/>`;
  if (type === 'warning') return `<g class="sync-icon" fill="${color}"><path d="M ${x + 6} ${y} L ${x + 12} ${y + 10} H ${x} Z"/><text x="${x + 5}" y="${y + 8}" fill="var(--paper)" font-size="7">!</text></g>`;
  if (type === 'tag') return `<path class="sync-icon" d="M ${x + 1} ${y + 2} H ${x + 7} L ${x + 11} ${y + 6} L ${x + 7} ${y + 10} H ${x + 1} Z" fill="none" stroke="${color}" stroke-width="1.2"/>`;
  const symbol = type === 'ahead' ? '↑' : type === 'behind' ? '↓' : '↕';
  return `<text class="sync-icon" x="${x + 1}" y="${y + 10}" fill="${color}" font-size="11" font-weight="800">${symbol}</text>`;
}

function renderGraphRow(row, laneCount, commit, graphWidth, rowIndex, workingTreeNode) {
  const spacing = 16;
  const centerY = 22;
  const laneWidth = graphLaneWidth(laneCount);
  const width = graphWidth || laneWidth;
  const laneOffset = Math.max(0, width - laneWidth);
  const x = (lane) => laneOffset + 6 + lane * spacing;
  const paths = [];

  row.before.forEach((value, lane) => {
    if (value && !(row.startsHere && lane === row.lane)) {
      const workingStroke = workingTreeNode && lane === workingTreeNode.lane && rowIndex <= workingTreeNode.commitIndex;
      paths.push(`<path d="M ${x(lane)} 0 L ${x(lane)} ${centerY}" stroke="${workingStroke ? '#24b4c2' : graphColor(row.beforeColors[lane])}"${workingStroke ? ' stroke-dasharray="2 5"' : ''}/> `);
    }
  });
  row.after.forEach((value, lane) => {
    const continuesThroughRow = row.before[lane] || lane === row.lane;
    if (value && continuesThroughRow) {
      const workingStroke = workingTreeNode && lane === workingTreeNode.lane && rowIndex < workingTreeNode.commitIndex;
      paths.push(`<path d="M ${x(lane)} ${centerY} L ${x(lane)} 44" stroke="${workingStroke ? '#24b4c2' : graphColor(row.afterColors[lane])}"${workingStroke ? ' stroke-dasharray="2 5"' : ''}/> `);
    }
  });
  row.connections.forEach(({ from, to, toColor }) => {
    if (from === to) return;
    paths.push(`<path class="graph-curve" d="M ${x(from)} ${centerY} C ${x(from)} 34, ${x(to)} 32, ${x(to)} 44" stroke="${graphColor(toColor)}"/>`);
  });
  row.transitions?.forEach(({ from, to }) => {
    if (from === to) return;
    paths.push(`<path class="graph-transition" d="M ${x(from)} 44 C ${x(from)} 44, ${x(to)} 44, ${x(to)} 44" stroke="${graphColor(row.afterColors[from])}"/>`);
  });

  if (window.forkline.debugGraphLayout) {
    console.log(`GRAPH_LAYOUT SVG ${JSON.stringify({ row: rowIndex, commit: commit.hash, paths })}`);
  }

  const color = graphColor(row.laneColor);
  const labels = graphLabelDetails(commit, color);
  const labelGroup = graphLabelGroupMarkup(labels, x(row.lane), centerY, color);
  return `<svg class="commit-graph" width="${width}" height="44" viewBox="0 0 ${width} 44" aria-hidden="true">
    <g fill="none" stroke-width="2.5" stroke-linecap="round">${paths.join('')}</g>
    ${labelGroup}
    <circle class="commit-node-halo" cx="${x(row.lane)}" cy="${centerY}" r="6.5"/>
    <circle class="commit-node" cx="${x(row.lane)}" cy="${centerY}" r="4" fill="${color}" stroke="${color}"/>
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
  return Math.min(210, Math.max(48, label.name.length * 6.1 + 21 + label.iconTypes.length * 14));
}

function graphLaneWidth(laneCount) {
  return Math.max(34, laneCount * 16 + 10);
}

function graphLabelGroupMetrics(labels) {
  const rowHeight = 18;
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
    const iconStart = labelStart + 14 + label.name.length * 6.1 + 3;
    const icons = label.iconTypes.map((type, iconIndex) => graphIconMarkup(type, iconStart + iconIndex * 14, labelY + 4, label.color)).join('');
    return `<g class="branch-label ${label.type}">
      <rect x="${labelStart}" y="${labelY}" width="${metrics.width}" height="${metrics.rowHeight}" rx="3" fill="${label.color}" fill-opacity=".12" stroke="${label.color}"/>
      <title>${escapeHtml(label.syncTooltip)}</title>
      <text x="${labelStart + 14}" y="${labelY + 12.5}" fill="${label.color}">${escapeHtml(label.name)}</text>${icons}
    </g>`;
  }).join('');
  const connectorY = nodeY;
  return `<g class="branch-label-group" font-family="${escapeHtml('Nimbus Sans, Liberation Sans, sans-serif')}" font-size="9" font-weight="700">
    <path class="branch-label-link" d="M ${labelStart + metrics.width} ${connectorY} H ${nodeX}" stroke="${color}"/>
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

function renderCommits() {
  const graph = window.ForklineGraph.layoutCommitGraph(state.snapshot.commits, {
    headHash: state.snapshot.headHash,
    showWorkingTree: state.snapshot.status.files.length > 0,
    branches: state.snapshot.branches,
    orderDebug: state.snapshot.orderDebug,
    debug: window.forkline.debugGraphLayout,
  });
  const labelWidth = state.snapshot.commits.reduce((width, commit) => {
    const refsWidth = graphLabelGroupMetrics(graphLabelDetails(commit, graphColor(0))).width;
    return Math.max(width, refsWidth);
  }, 0);
  const workingTreeLabelWidth = graph.workingTreeNode ? 75 : 0;
  const labelArea = Math.max(labelWidth, workingTreeLabelWidth);
  const graphWidth = Math.max(46, graphLaneWidth(graph.laneCount) + (labelArea ? labelArea + 2 : 0));
  $('#commits').style.setProperty('--graph-width', `${graphWidth}px`);
  $('.history-head').style.setProperty('--graph-width', `${graphWidth}px`);
  const rows = [];
  state.snapshot.commits.forEach((commit, index) => {
    if (graph.workingTreeNode && index === 0) {
      rows.push(`<button class="working-tree-row" type="button" title="Afficher les modifications locales">
        ${renderWorkingTreeRow(graph.workingTreeNode, graph.laneCount, graphWidth, state.snapshot.status.files.length)}
        <span></span>
        <span></span><span></span>
      </button>`);
    }
    rows.push(`<button class="commit-row${commit.hash === state.selectedCommit ? ' selected' : ''}" data-hash="${commit.hash}">
      ${renderGraphRow(graph.rows[index], graph.laneCount, commit, graphWidth, index, graph.workingTreeNode)}
      <span class="commit-main"><span class="commit-subject">${escapeHtml(commit.subject)}</span><span class="commit-meta">${commit.shortHash}</span></span>
      <span class="commit-author">${escapeHtml(commit.author)}</span>
      <span class="commit-date" title="${escapeHtml(new Date(commit.date).toLocaleString('fr'))}">${relativeTime(commit.date)}</span>
    </button>`);
  });
  $('#commits').innerHTML = rows.join('');
  $$('.commit-row').forEach((row) => row.addEventListener('click', () => selectCommit(row.dataset.hash)));
  $$('.working-tree-row').forEach((row) => row.addEventListener('click', () => setView('changes')));
}

function renderChanges() {
  const files = state.snapshot.status.files;
  renderFileList('#staged-files', files.filter((file) => file.staged), true);
  renderFileList('#unstaged-files', files.filter((file) => file.workingTree !== ' ' || file.untracked), false);
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
  });
}

function showInspector(id) {
  ['#inspector-empty', '#commit-detail', '#diff-detail'].forEach((selector) => $(selector).classList.toggle('hidden', selector !== id));
}

function selectCommit(hash) {
  const commit = state.snapshot.commits.find((item) => item.hash === hash);
  if (!commit) return;
  state.selectedCommit = hash;
  renderCommits();
  $('#commit-detail').innerHTML = `
    <p class="eyebrow">DÉTAIL DU COMMIT</p><p class="detail-hash">${commit.hash}</p>
    <h3>${escapeHtml(commit.subject)}</h3>
    <dl class="detail-grid"><dt>Auteur</dt><dd>${escapeHtml(commit.author)}<br>${escapeHtml(commit.email)}</dd><dt>Date</dt><dd>${escapeHtml(new Date(commit.date).toLocaleString('fr'))}</dd><dt>Parent${commit.parents.length > 1 ? 's' : ''}</dt><dd>${commit.parents.map((parent) => parent.slice(0, 10)).join(', ') || 'Commit initial'}</dd></dl>
    <div class="detail-refs">${commit.refs.map((ref) => `<span class="detail-ref">${escapeHtml(ref)}</span>`).join('')}</div>`;
  showInspector('#commit-detail');
}

async function selectFile(file, staged) {
  state.selectedFile = `${staged}:${file}`;
  renderChanges();
  $('#diff-file').textContent = file;
  $('#diff-action').textContent = staged ? 'Retirer de l’index' : 'Ajouter à l’index';
  $('#diff-action').dataset.file = file;
  $('#diff-action').dataset.staged = staged;
  $('#diff-content').textContent = 'Chargement…';
  showInspector('#diff-detail');
  const result = await action('', () => window.forkline.diff(file, staged).then(unwrap));
  if (result !== null) renderDiff(result);
}

function renderDiff(diff) {
  const html = escapeHtml(diff).split('\n').map((line) => {
    if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="diff-add">${line}</span>`;
    if (line.startsWith('-') && !line.startsWith('---')) return `<span class="diff-remove">${line}</span>`;
    return line;
  }).join('\n');
  $('#diff-content').innerHTML = html;
}

async function toggleStage(file, staged) {
  const result = await action(staged ? 'Fichier retiré de l’index' : 'Fichier ajouté à l’index', () => {
    const method = staged ? 'unstage' : 'stage';
    return window.forkline[method]([file]).then(unwrap);
  });
  if (result) applySnapshot(result);
}

async function switchBranch(name) {
  if (name === state.snapshot.head) return;
  const result = await action(`Branche ${name} activée`, () => window.forkline.switchBranch(name).then(unwrap));
  if (result) applySnapshot(result);
}

async function refresh(silent = false) {
  if (!state.snapshot || state.busy) return;
  const result = await action(silent ? '' : 'Dépôt actualisé', () => window.forkline.refresh().then(unwrap));
  if (result) applySnapshot(result);
}

async function openRepository() {
  const result = await action('', () => window.forkline.chooseRepository().then(unwrap));
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
$('#open-repo').addEventListener('click', openRepository);
$('#refresh').addEventListener('click', () => refresh());
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
  const result = await action('Commit créé', () => window.forkline.commit(message).then(unwrap));
  if (result) {
    $('#commit-message').value = '';
    applySnapshot(result.snapshot);
    setView('history');
  }
});

for (const operation of ['fetch', 'pull', 'push']) {
  $(`#${operation}`).addEventListener('click', async () => {
    const result = await action(`${operation[0].toUpperCase()}${operation.slice(1)} terminé`, () => window.forkline[operation]().then(unwrap));
    if (result) applySnapshot(result.snapshot);
  });
}

$('#new-branch').addEventListener('click', () => {
  $('#branch-name').value = '';
  $('#branch-dialog').showModal();
  setTimeout(() => $('#branch-name').focus(), 50);
});
$('#confirm-branch').addEventListener('click', async (event) => {
  event.preventDefault();
  const name = $('#branch-name').value.trim();
  const result = await action(`Branche ${name} créée`, () => window.forkline.createBranch(name).then(unwrap));
  if (result) {
    $('#branch-dialog').close();
    applySnapshot(result);
  }
});

window.forkline.onRepositoryChanged(() => refresh(true));

(async () => {
  const result = await action('', () => window.forkline.restoreRepository().then(unwrap));
  if (result) applySnapshot(result);
  else $('#restore-status').textContent = 'Choisissez un dossier contenant un dépôt Git.';
})();
