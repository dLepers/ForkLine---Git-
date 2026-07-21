const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { GitService } = require('./git-service');
const { RepositoryWatcher } = require('./repository-watcher');
const { selectGitProfile } = require('./git-profile-rules');
const { parseCommandLine, launchDetached } = require('./command-line');
const { CodexAnalysisStore, CodexService, DEFAULT_CODEX_SETTINGS, normalizeCodexSettings } = require('./codex-service');
const { AiSecretStore, CloudAiService, DEFAULT_AI_SETTINGS, PROVIDERS, normalizeAiSettings } = require('./ai-service');

const git = new GitService();
const codex = new CodexService();
const cloudAi = new CloudAiService();
const execFileAsync = promisify(execFile);
let mainWindow;
let undoQueue = [];
let redoStack = [];
let historyExpectedState = null;
let historyMutation = false;
let branchCreationTrace = null;
let aiSecrets = null;
function clearActionHistory() {
  undoQueue = [];
  redoStack = [];
  historyExpectedState = null;
}
function decorateSnapshot(snapshot) {
  if (!snapshot) return snapshot;
  const availableUndo = undoQueue.length ? undoQueue : snapshot.undoHistory || [];
  if (undoQueue.length) snapshot.undoPlan = undoQueue[0];
  snapshot.undoHistory = availableUndo.map((plan) => ({ label: plan.label }));
  snapshot.redoHistory = [...redoStack].reverse().map((action) => ({ label: action.label.replace(/^Annuler /, 'Rétablir ') }));
  snapshot.redoAvailable = redoStack.length > 0;
  return snapshot;
}
const repositoryWatcher = new RepositoryWatcher(git, (snapshot) => {
  decorateSnapshot(snapshot);
  const windows = BrowserWindow.getAllWindows();
  if (branchCreationTrace) console.info('[branch-create] refresh event', JSON.stringify({ ...branchCreationTrace, repositoryRevision: snapshot.repositoryRevision, head: snapshot.head, branches: snapshot.branches.filter((branch) => !branch.remote).map((branch) => ({ name: branch.name, hash: branch.hash, current: branch.current })), views: windows.length }));
  windows.forEach((window) => window.webContents.send('repository:updated', snapshot));
}, {
  onMutationStart: () => { if (!historyMutation) clearActionHistory(); },
  onExternalChange: () => { clearActionHistory(); },
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#171916',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#171916', symbolColor: '#f4f0e6', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (process.env.DEBUG_GRAPH_LAYOUT === '1') {
    mainWindow.webContents.on('console-message', (_event, detailsOrLevel, legacyMessage, legacyLine, legacySourceId) => {
      const details = detailsOrLevel && typeof detailsOrLevel === 'object'
        ? detailsOrLevel
        : { level: detailsOrLevel, message: legacyMessage, lineNumber: legacyLine, sourceId: legacySourceId };
      if (typeof details.message === 'string' && details.message.startsWith('GRAPH_LAYOUT')) {
        console.log(`[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
      }
    });
  }

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function serializeError(error) {
  return { message: error.message || 'Une erreur est survenue.', details: error.details || '' };
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await callback(...args) };
    } catch (error) {
      return { ok: false, error: serializeError(error) };
    }
  });
}

async function readApplicationState() {
  const configPath = path.join(app.getPath('userData'), 'state.json');
  try {
    return JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch {
    return {};
  }
}

async function writeApplicationState(state) {
  const configPath = path.join(app.getPath('userData'), 'state.json');
  const temporaryPath = `${configPath}.tmp`;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(temporaryPath, JSON.stringify(state, null, 2));
  await fs.rename(temporaryPath, configPath);
}

function analysisStore() {
  return new CodexAnalysisStore(path.join(app.getPath('userData'), 'codex-analyses.json'));
}

function secretStore() {
  aiSecrets ||= new AiSecretStore(path.join(app.getPath('userData'), 'ai-secrets.json'), safeStorage);
  return aiSecrets;
}

async function aiSettings() {
  const state = await readApplicationState();
  if (state.aiSettings) return normalizeAiSettings(state.aiSettings);
  const legacy = normalizeCodexSettings(state.codexSettings || DEFAULT_CODEX_SETTINGS);
  return normalizeAiSettings({ ...DEFAULT_AI_SETTINGS, ...legacy, provider: 'codex' });
}

async function rememberRepository(repository) {
  const state = await readApplicationState();
  await writeApplicationState({ ...state, lastRepository: repository });
}

async function readRememberedRepository() {
  return (await readApplicationState()).lastRepository || null;
}

async function resolveExecutable(executable) {
  if (path.isAbsolute(executable)) {
    await fs.access(executable);
    return executable;
  }
  const result = await execFileAsync('which', [executable], { encoding: 'utf8' }).catch(() => null);
  if (!result?.stdout.trim()) throw new Error(`L’exécutable « ${executable} » est introuvable.`);
  return result.stdout.trim();
}

function validateGitProfile(profile) {
  const label = String(profile?.label || '').trim();
  const name = String(profile?.name || '').trim();
  const email = String(profile?.email || '').trim();
  const signingKey = String(profile?.signingKey || '').trim();
  const pathPattern = String(profile?.pathPattern || '').trim();
  const remotePattern = String(profile?.remotePattern || '').trim();
  if (!label || /[\0\r\n]/.test(label)) throw new Error('Le nom du profil est obligatoire.');
  if (!name || /[\0\r\n]/.test(name)) throw new Error('Le nom Git du profil est obligatoire.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Adresse e-mail du profil invalide.');
  if (/[\0\r\n]/.test(signingKey)) throw new Error('Clé de signature du profil invalide.');
  if (pathPattern.length > 500 || /[\0\r\n]/.test(pathPattern)) throw new Error('Règle de chemin du profil invalide.');
  if (remotePattern.length > 500 || /[\0\r\n]/.test(remotePattern)) throw new Error('Règle d’URL distante du profil invalide.');
  return { id: profile.id || randomUUID(), label, name, email, signingKey, gpgSign: Boolean(profile.gpgSign), pathPattern, remotePattern };
}

async function applyAssignedProfile(repository) {
  const state = await readApplicationState();
  const remoteUrls = (await git.remotes()).flatMap((remote) => [remote.fetchUrl, remote.pushUrl]).filter(Boolean);
  const { profile } = selectGitProfile(state, repository, remoteUrls);
  if (!profile) return;
  await git.setIdentity(profile.name, profile.email, 'local');
  await git.setCommitPreferences({ scope: 'local', gpgSign: profile.gpgSign, signingKey: profile.signingKey });
}

async function openRepository(repository) {
  const root = await git.open(repository);
  await applyAssignedProfile(root);
  await rememberRepository(root);
  const snapshot = await git.snapshot();
  clearActionHistory();
  return repositoryWatcher.start(root, decorateSnapshot(snapshot));
}

async function selectParentDirectory(title) {
  const result = await dialog.showOpenDialog(mainWindow, { title, properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
}

app.whenReady().then(() => {
  createWindow();

  handle('repository:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Ouvrir un dépôt Git',
      properties: ['openDirectory'],
    });
    if (result.canceled) return null;
    return openRepository(result.filePaths[0]);
  });
  handle('repository:initialize', async (initialBranch) => {
    const destination = await selectParentDirectory('Choisir le dossier du nouveau dépôt');
    if (!destination) return null;
    const root = await git.initialize(destination, initialBranch);
    clearActionHistory();
    await rememberRepository(root);
    return repositoryWatcher.start(root, decorateSnapshot(await git.snapshot()));
  });
  handle('repository:clone', async (source, directoryName) => {
    const parent = await selectParentDirectory('Choisir le dossier parent du clone');
    if (!parent) return null;
    const cleanName = String(directoryName || '').trim();
    if (!cleanName || cleanName === '.' || cleanName === '..' || /[\\/\0]/.test(cleanName)) throw new Error('Nom du dossier de destination invalide.');
    const root = await git.clone(source, path.join(parent, cleanName));
    clearActionHistory();
    await rememberRepository(root);
    return repositoryWatcher.start(root, decorateSnapshot(await git.snapshot()));
  });
  handle('repository:restore', async () => {
    const repository = await readRememberedRepository();
    return repository ? openRepository(repository) : null;
  });
  handle('repository:refresh', () => repositoryWatcher.refresh());
  handle('repository:undo', async (count = 1) => {
    historyMutation = true;
    try {
      const requested = Math.max(1, Math.min(Number(count) || 1, 20));
      const result = await repositoryWatcher.mutate(async () => {
        if (!undoQueue.length) undoQueue = await git.undoPlans(null, null, 20);
        if (!undoQueue.length) {
          const unavailable = await git.undoPlan();
          throw new Error(unavailable.reason || 'Aucune action à annuler.');
        }
        const labels = [];
        for (let index = 0; index < requested && undoQueue.length; index += 1) {
          const plan = undoQueue[0];
          const action = await git.applyUndoPlan(plan, historyExpectedState);
          undoQueue.shift();
          redoStack.push(action);
          historyExpectedState = action.expected;
          labels.push(action.label);
        }
        return labels;
      });
      return { labels: result.output, snapshot: result.snapshot };
    } finally {
      historyMutation = false;
    }
  });
  handle('repository:redo', async (count = 1) => {
    if (!redoStack.length) throw new Error('Aucune action à rétablir.');
    historyMutation = true;
    try {
      const requested = Math.max(1, Math.min(Number(count) || 1, redoStack.length));
      const result = await repositoryWatcher.mutate(async () => {
        const labels = [];
        for (let index = 0; index < requested; index += 1) {
          const action = redoStack[redoStack.length - 1];
          historyExpectedState = await git.redoLastAction(action);
          redoStack.pop();
          undoQueue.unshift(action.plan);
          labels.push(action.label.replace(/^Annuler /, 'Rétablir '));
        }
        return labels;
      });
      return { labels: result.output, snapshot: result.snapshot };
    } finally {
      historyMutation = false;
    }
  });
  handle('shell:open-terminal', async () => {
    if (!git.repoPath) throw new Error('Aucun dépôt n’est ouvert.');
    const candidates = [process.env.TERMINAL, 'x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'kitty'].filter(Boolean);
    let terminal = null;
    for (const command of candidates) {
      try {
        const parsed = parseCommandLine(command);
        terminal = { executable: await resolveExecutable(parsed.executable), args: parsed.args };
        break;
      } catch {
        // Continue with the next known terminal.
      }
    }
    if (!terminal) throw new Error('Aucun terminal graphique compatible n’a été trouvé.');
    try {
      await launchDetached(terminal.executable, terminal.args, git.repoPath);
    } catch (error) {
      throw Object.assign(new Error('Impossible d’ouvrir le terminal.'), { details: error.message });
    }
    return true;
  });
  handle('shell:open-file', async (file) => {
    git.assertSafeRelativePath(file);
    const absolutePath = path.join(git.repoPath, file);
    const state = await readApplicationState();
    if (state.externalEditorCommand) {
      const editor = parseCommandLine(state.externalEditorCommand);
      const executable = await resolveExecutable(editor.executable);
      try {
        await launchDetached(executable, [...editor.args, absolutePath], git.repoPath);
      } catch (error) {
        throw Object.assign(new Error('Impossible d’ouvrir le fichier dans l’éditeur externe.'), { details: error.message });
      }
      return true;
    }
    const error = await shell.openPath(absolutePath);
    if (error) throw new Error(error);
    return true;
  });
  handle('shell:open-repository-folder', async () => {
    if (!git.repoPath) throw new Error('Aucun dépôt n’est ouvert.');
    const error = await shell.openPath(git.repoPath);
    if (error) throw new Error(error);
    return true;
  });
  handle('repository:git-profiles', async () => {
    const state = await readApplicationState();
    const remoteUrls = (await git.remotes()).flatMap((remote) => [remote.fetchUrl, remote.pushUrl]).filter(Boolean);
    const match = selectGitProfile(state, git.repoPath, remoteUrls);
    return { profiles: state.gitProfiles || [], assignedProfileId: match.profile?.id || null, assignmentType: match.matchType, externalEditorCommand: state.externalEditorCommand || '' };
  });
  handle('application:set-external-editor', async (command) => {
    const cleanCommand = String(command || '').trim();
    if (cleanCommand) {
      const editor = parseCommandLine(cleanCommand);
      await resolveExecutable(editor.executable);
    }
    const state = await readApplicationState();
    await writeApplicationState({ ...state, externalEditorCommand: cleanCommand });
    return cleanCommand;
  });
  handle('application:ai-configuration', async () => {
    const settings = await aiSettings();
    const secrets = secretStore();
    const apiKey = settings.provider === 'codex' ? '' : await secrets.get(settings.provider);
    let status;
    let models = [];
    if (settings.provider === 'codex') {
      const executable = await resolveExecutable('codex').catch(() => 'codex');
      status = await codex.status(executable);
      models = status.installed && status.authenticated ? await codex.models(executable).catch(() => []) : [];
    } else {
      status = { installed: true, authenticated: Boolean(apiKey), label: apiKey ? `${PROVIDERS[settings.provider].label} configuré` : `Clé API requise pour ${PROVIDERS[settings.provider].label}` };
      if (apiKey) models = await cloudAi.models(settings, apiKey).catch(() => []);
    }
    return { settings, status, models, providers: PROVIDERS, hasApiKey: Boolean(apiKey), securePersistenceAvailable: secrets.securePersistenceAvailable() };
  });
  handle('application:set-ai-settings', async (value) => {
    const settings = normalizeAiSettings(value);
    const state = await readApplicationState();
    await writeApplicationState({ ...state, aiSettings: settings });
    let secret = { hasApiKey: false, persisted: false };
    if (settings.provider !== 'codex') {
      const store = secretStore();
      const existing = await store.get(settings.provider);
      const apiKey = value.removeApiKey ? '' : (String(value.apiKey || '').trim() || existing);
      secret = await store.set(settings.provider, apiKey, value.persistApiKey !== false);
    }
    return { settings, ...secret };
  });
  handle('application:clear-ai-analyses', () => analysisStore().clear());
  handle('repository:save-git-profile', async (profile) => {
    const cleanProfile = validateGitProfile(profile);
    const state = await readApplicationState();
    const profiles = [...(state.gitProfiles || []).filter((entry) => entry.id !== cleanProfile.id), cleanProfile].sort((a, b) => a.label.localeCompare(b.label, 'fr'));
    await writeApplicationState({ ...state, gitProfiles: profiles });
    return cleanProfile;
  });
  handle('repository:apply-git-profile', async (profileId, remember) => {
    const state = await readApplicationState();
    const profile = (state.gitProfiles || []).find((entry) => entry.id === profileId);
    if (!profile) throw new Error('Profil Git introuvable.');
    const result = (await repositoryWatcher.mutate(async () => {
      await git.setIdentity(profile.name, profile.email, 'local');
      await git.setCommitPreferences({ scope: 'local', gpgSign: profile.gpgSign, signingKey: profile.signingKey });
      return true;
    })).snapshot;
    if (remember) await writeApplicationState({ ...state, gitProfileAssignments: { ...(state.gitProfileAssignments || {}), [git.repoPath]: profileId } });
    return result;
  });
  handle('repository:delete-git-profile', async (profileId) => {
    const state = await readApplicationState();
    const assignments = Object.fromEntries(Object.entries(state.gitProfileAssignments || {}).filter(([, value]) => value !== profileId));
    await writeApplicationState({ ...state, gitProfiles: (state.gitProfiles || []).filter((entry) => entry.id !== profileId), gitProfileAssignments: assignments });
    return true;
  });
  handle('repository:set-identity', async (name, email, scope) => (await repositoryWatcher.mutate(() => git.setIdentity(name, email, scope))).snapshot);
  handle('repository:set-commit-preferences', async (options) => (await repositoryWatcher.mutate(() => git.setCommitPreferences(options))).snapshot);
  handle('repository:add-submodule', async (url, submodulePath, branch) => (await repositoryWatcher.mutate(() => git.addSubmodule(url, submodulePath, branch))).snapshot);
  handle('repository:update-submodule', async (submodulePath) => (await repositoryWatcher.mutate(() => git.updateSubmodule(submodulePath))).snapshot);
  handle('repository:sync-submodule', async (submodulePath) => (await repositoryWatcher.mutate(() => git.syncSubmodule(submodulePath))).snapshot);
  handle('repository:deinitialize-submodule', async (submodulePath, force) => (await repositoryWatcher.mutate(() => git.deinitializeSubmodule(submodulePath, force))).snapshot);
  handle('repository:open-submodule', async (submodulePath) => {
    const repository = git.repoPath;
    const submodule = await git.assertSubmodulePath(submodulePath);
    if (!submodule.initialized) throw new Error('Initialisez ce sous-module avant de l’ouvrir.');
    return openRepository(path.join(repository, submodule.path));
  });
  handle('repository:add-worktree', async (options) => {
    const parent = await selectParentDirectory('Choisir le dossier parent du worktree');
    if (!parent) return null;
    const directoryName = String(options?.directoryName || '').trim();
    if (!directoryName || directoryName === '.' || directoryName === '..' || /[\\/\0]/.test(directoryName)) throw new Error('Nom du dossier de worktree invalide.');
    return (await repositoryWatcher.mutate(() => git.addWorktree(path.join(parent, directoryName), options.branch, options.createBranch, options.startPoint))).snapshot;
  });
  handle('repository:remove-worktree', async (worktreePath, force) => (await repositoryWatcher.mutate(() => git.removeWorktree(worktreePath, force))).snapshot);
  handle('repository:prune-worktrees', async () => (await repositoryWatcher.mutate(() => git.pruneWorktrees())).snapshot);
  handle('repository:open-worktree', async (worktreePath) => {
    const resolved = await fs.realpath(worktreePath).catch(() => '');
    const worktree = (await git.worktrees()).find((entry) => entry.path === resolved);
    if (!worktree) throw new Error('Worktree introuvable.');
    return openRepository(worktree.path);
  });
  handle('repository:initialize-git-flow', async (options) => (await repositoryWatcher.mutate(() => git.initializeGitFlow(options))).snapshot);
  handle('repository:start-git-flow', async (type, name, startPoint) => (await repositoryWatcher.mutate(() => git.startGitFlow(type, name, startPoint))).snapshot);
  handle('repository:finish-git-flow', async (type, branch) => {
    const { output, snapshot } = await repositoryWatcher.mutate(() => git.finishGitFlow(type, branch));
    return { ...output, snapshot };
  });
  handle('repository:track-lfs', async (pattern) => (await repositoryWatcher.mutate(() => git.trackLfs(pattern))).snapshot);
  handle('repository:untrack-lfs', async (pattern) => (await repositoryWatcher.mutate(() => git.untrackLfs(pattern))).snapshot);
  handle('repository:pull-lfs', async () => (await repositoryWatcher.mutate(() => git.pullLfs())).snapshot);
  handle('repository:push-lfs', async () => (await repositoryWatcher.mutate(() => git.pushLfs())).snapshot);
  handle('repository:diff', (file, staged) => git.diff(file, staged));
  handle('repository:stash-diff', (ref) => git.stashDiff(ref));
  handle('repository:stage', async (files) => (await repositoryWatcher.mutate(() => git.stage(files))).snapshot);
  handle('repository:unstage', async (files) => (await repositoryWatcher.mutate(() => git.unstage(files))).snapshot);
  handle('repository:apply-hunk', async (patch, staged, reverse) => (await repositoryWatcher.mutate(() => git.applyHunk(patch, staged, reverse))).snapshot);
  handle('repository:resolve-conflict', async (file, strategy) => (await repositoryWatcher.mutate(() => git.resolveConflict(file, strategy))).snapshot);
  handle('repository:resolve-all-conflicts', async () => (await repositoryWatcher.mutate(() => git.resolveAllConflicts())).snapshot);
  handle('repository:conflict-versions', (file) => git.conflictVersions(file));
  handle('repository:resolve-conflict-content', async (file, content) => (await repositoryWatcher.mutate(() => git.resolveConflictContent(file, content))).snapshot);
  handle('repository:commit', async (message, options) => repositoryWatcher.mutate(() => git.commit(message, options)));
  handle('repository:create-stash', async (options) => repositoryWatcher.mutate(() => git.createStash(options)));
  handle('repository:apply-stash', async (ref, files) => {
    const { output, snapshot } = await repositoryWatcher.mutate(() => git.restoreStash(ref, 'apply', files));
    return { ...output, snapshot };
  });
  handle('repository:pop-stash', async (ref) => {
    const { output, snapshot } = await repositoryWatcher.mutate(() => git.restoreStash(ref, 'pop'));
    return { ...output, snapshot };
  });
  handle('repository:rename-stash', async (ref, message) => {
    const { output, snapshot } = await repositoryWatcher.mutate(() => git.renameStash(ref, message));
    return { output, snapshot };
  });
  handle('repository:drop-stash', async (ref) => {
    const { output, snapshot } = await repositoryWatcher.mutate(() => git.dropStash(ref));
    return { output, snapshot };
  });
  handle('repository:export-stash-patch', async (ref, suggestedName) => {
    const patch = await git.stashDiff(ref);
    const safeName = path.basename(String(suggestedName || 'stash.patch'));
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Exporter le stash en patch',
      defaultPath: path.join(git.repoPath, safeName.endsWith('.patch') ? safeName : `${safeName}.patch`),
      filters: [{ name: 'Patch Git', extensions: ['patch'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, patch, 'utf8');
    return result.filePath;
  });
  handle('repository:switch', async (name) => (await repositoryWatcher.mutate(() => git.switchBranch(name))).snapshot);
  handle('repository:create-branch', async (name, startPoint, checkout) => {
    branchCreationTrace = { name, startPoint, checkout };
    console.info('[branch-create] context-menu handler', JSON.stringify(branchCreationTrace));
    try {
      const { snapshot } = await repositoryWatcher.mutate(() => git.createBranch(name, startPoint, checkout));
      console.info('[branch-create] handler result', JSON.stringify({ ok: true, repositoryRevision: snapshot.repositoryRevision, head: snapshot.head }));
      return snapshot;
    } catch (error) {
      console.error('[branch-create] handler result', JSON.stringify({ ok: false, message: error.message, details: error.details || '' }));
      throw error;
    } finally {
      branchCreationTrace = null;
    }
  });
  handle('repository:checkout-commit', async (hash) => (await repositoryWatcher.mutate(() => git.checkoutCommit(hash))).snapshot);
  for (const [channel, operation] of [
    ['merge-branch', (value) => git.mergeBranch(value)],
    ['rebase-branch', (value) => git.rebaseBranch(value)],
    ['fast-forward-branch', (value) => git.fastForwardBranch(value)],
    ['cherry-pick', (value) => git.cherryPick(value)],
    ['revert-commit', (value) => git.revertCommit(value)],
  ]) {
    handle(`repository:${channel}`, async (value) => {
      const { output, snapshot } = await repositoryWatcher.mutate(() => operation(value));
      return { ...output, snapshot };
    });
  }
  handle('repository:reset-commit', async (hash, mode) => (await repositoryWatcher.mutate(() => git.resetToCommit(hash, mode))).snapshot);
  handle('repository:rename-branch', async (oldName, newName) => (await repositoryWatcher.mutate(() => git.renameBranch(oldName, newName))).snapshot);
  handle('repository:delete-branch', async (name, force) => (await repositoryWatcher.mutate(() => git.deleteBranch(name, force))).snapshot);
  handle('repository:delete-branch-with-remote', async (name, upstream) => (await repositoryWatcher.mutate(() => git.deleteBranchWithRemote(name, upstream))).snapshot);
  handle('repository:set-upstream', async (branch, remote, remoteBranch) => (await repositoryWatcher.mutate(() => git.setUpstream(branch, remote, remoteBranch))).snapshot);
  handle('repository:checkout-remote-branch', async (remoteBranch, localName) => (await repositoryWatcher.mutate(() => git.checkoutRemoteBranch(remoteBranch, localName))).snapshot);
  handle('repository:push-branch', async (branch, options) => repositoryWatcher.mutate(() => git.pushBranch(branch, options)));
  handle('repository:add-remote', async (name, url) => (await repositoryWatcher.mutate(() => git.addRemote(name, url))).snapshot);
  handle('repository:rename-remote', async (oldName, newName) => (await repositoryWatcher.mutate(() => git.renameRemote(oldName, newName))).snapshot);
  handle('repository:remove-remote', async (name) => (await repositoryWatcher.mutate(() => git.removeRemote(name))).snapshot);
  handle('repository:fetch-remote', async (name, prune) => repositoryWatcher.mutate(() => git.fetchRemote(name, prune)));
  handle('repository:compare-worktree', (revision) => git.compareWithWorktree(revision));
  handle('repository:compare-revisions', (fromRevision, toRevision) => git.compareRevisions(fromRevision, toRevision));
  handle('repository:search-history', (query, limit) => git.searchHistory(query, limit));
  handle('repository:file-history', (file, limit) => git.fileHistory(file, limit));
  handle('repository:blame', (file, revision) => git.blame(file, revision));
  handle('repository:commit-files', (revision) => git.commitFiles(revision));
  handle('repository:commit-file-diff', (revision, file) => git.commitFileDiff(revision, file));
  handle('repository:commit-analysis', async (revision) => {
    if (!git.repoPath) throw new Error('Aucun dépôt n’est ouvert.');
    await git.validateRevision(revision);
    return analysisStore().get(git.repoPath, revision);
  });
  handle('repository:analyze-commit', async (revision) => {
    if (!git.repoPath) throw new Error('Aucun dépôt n’est ouvert.');
    await git.validateRevision(revision);
    const commitData = await git.commitAnalysisData(revision);
    const settings = await aiSettings();
    let result;
    if (settings.provider === 'codex') {
      const executable = await resolveExecutable('codex');
      const status = await codex.status(executable);
      if (!status.authenticated) throw new Error('Connectez Codex avec « codex login » avant de lancer une analyse.');
      result = await codex.analyze(executable, commitData, settings, { schemaPath: path.join(__dirname, 'codex-analysis-schema.json'), cwd: app.getPath('temp'), timeout: settings.timeoutSeconds * 1000 });
    } else {
      const apiKey = await secretStore().get(settings.provider);
      const schema = JSON.parse(await fs.readFile(path.join(__dirname, 'codex-analysis-schema.json'), 'utf8'));
      result = await cloudAi.analyze(commitData, settings, apiKey, schema);
    }
    const record = {
      ...result.analysis,
      commitHash: revision,
      provider: PROVIDERS[settings.provider].label,
      model: settings.model || 'Modèle recommandé par Codex',
      reasoningEffort: settings.reasoningEffort,
      createdAt: new Date().toISOString(),
      truncated: result.truncated,
      saved: settings.saveAnalyses,
    };
    if (settings.saveAnalyses) await analysisStore().set(git.repoPath, revision, record);
    return record;
  });
  handle('repository:delete-commit-analysis', async (revision) => {
    if (!git.repoPath) throw new Error('Aucun dépôt n’est ouvert.');
    await git.validateRevision(revision);
    return analysisStore().delete(git.repoPath, revision);
  });
  handle('repository:export-commit-patch', async (revision, suggestedName) => {
    const patch = await git.createCommitPatch(revision);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Exporter le commit en patch',
      defaultPath: path.join(git.repoPath, suggestedName || `${String(revision).slice(0, 12)}.patch`),
      filters: [{ name: 'Patch Git', extensions: ['patch'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, patch, 'utf8');
    return result.filePath;
  });
  handle('repository:apply-patch', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Appliquer un patch Git',
      properties: ['openFile'],
      filters: [{ name: 'Patch Git', extensions: ['patch', 'mbox', 'eml'] }, { name: 'Tous les fichiers', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const patch = await fs.readFile(result.filePaths[0], 'utf8');
    const mutation = await repositoryWatcher.mutate(() => git.applyPatch(patch));
    return { ...mutation.output, snapshot: mutation.snapshot };
  });
  handle('repository:apply-patch-content', async (patch) => {
    const mutation = await repositoryWatcher.mutate(() => git.applyPatch(patch));
    return { ...mutation.output, snapshot: mutation.snapshot };
  });
  handle('repository:create-tag', async (name, revision, message) => (await repositoryWatcher.mutate(() => git.createTag(name, revision, message))).snapshot);
  handle('repository:delete-tag', async (name) => (await repositoryWatcher.mutate(() => git.deleteTag(name))).snapshot);
  handle('repository:push-tag', async (name, remote) => repositoryWatcher.mutate(() => git.pushTag(name, remote)));
  handle('repository:delete-remote-tag', async (name, remote) => repositoryWatcher.mutate(() => git.deleteRemoteTag(name, remote)));
  handle('repository:amend-head-message', async (message) => (await repositoryWatcher.mutate(() => git.amendHeadMessage(message))).snapshot);
  handle('repository:interactive-rebase-plan', (baseRevision) => git.interactiveRebasePlan(baseRevision));
  handle('repository:interactive-rebase', async (baseRevision, plan) => {
    const { output, snapshot } = await repositoryWatcher.mutate(() => git.interactiveRebase(baseRevision, plan));
    return { ...output, snapshot };
  });
  handle('repository:continue-operation', async (type, options) => {
    const { output, snapshot } = await repositoryWatcher.mutate(() => git.continueOperation(type, options));
    return { ...output, snapshot };
  });
  handle('repository:abort-operation', async (type) => {
    const { output, snapshot } = await repositoryWatcher.mutate(() => git.abortOperation(type));
    return { ...output, snapshot };
  });
  handle('repository:fetch', async () => repositoryWatcher.mutate(() => git.fetch()));
  handle('repository:pull', async (options) => {
    const { output, snapshot } = await repositoryWatcher.mutate(() => git.pull(options));
    return { ...output, snapshot };
  });
  handle('repository:push', async (options) => repositoryWatcher.mutate(() => git.push(options)));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  repositoryWatcher.stop();
  if (process.platform !== 'darwin') app.quit();
});
