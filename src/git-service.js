const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const execFileAsync = promisify(execFile);
const FIELD = '\x1f';
const RECORD = '\x1e';

function spawnWithInput(command, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`La commande s’est terminée avec le code ${code}.`), { stdout, stderr, code }));
    });
    child.stdin.on('error', reject);
    child.stdin.end(input);
  });
}

function frenchGitError(message, fallback = 'La commande Git a échoué.') {
  const text = String(message || '').toLowerCase();
  if (text.includes('nothing to commit')) return 'Aucune modification à valider.';
  if (text.includes('would be overwritten')) return 'Cette opération écraserait des modifications locales.';
  if (text.includes('not a git repository')) return 'Ce dossier ne contient pas de dépôt Git.';
  if (text.includes('authentication failed') || text.includes('could not read username')) return 'Échec de l’authentification auprès du dépôt distant.';
  if (text.includes('could not resolve host')) return 'Le dépôt distant est inaccessible.';
  if (text.includes('rejected') || text.includes('non-fast-forward')) return 'Git a refusé cette opération car le dépôt distant contient des modifications.';
  if (text.includes('no upstream branch')) return 'La branche actuelle n’a pas de branche distante associée.';
  if (text.includes('conflict')) return 'Des conflits doivent être résolus avant de poursuivre.';
  if (text.includes('invalid branch name')) return 'Nom de branche invalide.';
  if (text.includes('pathspec')) return 'Le fichier indiqué est introuvable dans le dépôt.';
  return fallback;
}

function parseTrackingStatus(track = '') {
  if (track.includes('gone')) return { state: 'gone', ahead: 0, behind: 0 };
  const ahead = Number(track.match(/ahead (\d+)/)?.[1] || 0);
  const behind = Number(track.match(/behind (\d+)/)?.[1] || 0);
  return {
    state: ahead && behind ? 'diverged' : ahead ? 'ahead' : behind ? 'behind' : 'up-to-date',
    ahead,
    behind,
  };
}

class GitError extends Error {
  constructor(message, details = '') {
    super(message);
    this.name = 'GitError';
    this.details = details;
  }
}

class GitService {
  constructor(repoPath = null) {
    this.repoPath = repoPath;
    this.lfsAvailable = null;
  }

  async run(args, options = {}) {
    if (!this.repoPath) {
      throw new GitError('Aucun dépôt n’est ouvert.');
    }

    try {
      const result = await execFileAsync('git', ['-C', this.repoPath, ...args], {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C.UTF-8' },
        ...options,
      });
      return result.stdout;
    } catch (error) {
      const stderr = String(error.stderr || '').trim();
      const stdout = String(error.stdout || '').trim();
      throw new GitError(frenchGitError(stderr || stdout), stderr || stdout);
    }
  }

  async open(candidatePath) {
    let resolved;
    try {
      resolved = await fs.realpath(candidatePath);
    } catch (error) {
      throw new GitError('Le dossier sélectionné est introuvable ou inaccessible.', error.message);
    }
    const previous = this.repoPath;
    this.repoPath = resolved;

    try {
      const root = (await this.run(['rev-parse', '--show-toplevel'])).trim();
      this.repoPath = await fs.realpath(root);
      return this.repoPath;
    } catch (error) {
      this.repoPath = previous;
      throw new GitError('Ce dossier ne contient pas de dépôt Git.', error.message);
    }
  }

  async initialize(candidatePath, initialBranch = 'main') {
    const branch = String(initialBranch || 'main').trim();
    await this.validateNewBranchName(branch);
    const resolved = path.resolve(candidatePath);
    await fs.mkdir(resolved, { recursive: true });
    await this.runExternal(['init', '-b', branch, resolved]);
    return this.open(resolved);
  }

  async clone(source, destination) {
    if (typeof source !== 'string' || !source.trim() || source.startsWith('-') || /[\0\r\n]/.test(source)) throw new GitError('Adresse du dépôt à cloner invalide.');
    const resolved = path.resolve(destination);
    try {
      await fs.access(resolved);
      if ((await fs.readdir(resolved)).length) throw new GitError('Le dossier de destination doit être vide.');
    } catch (error) {
      if (error instanceof GitError) throw error;
      await fs.mkdir(path.dirname(resolved), { recursive: true });
    }
    await this.runExternal(['clone', '--', source.trim(), resolved]);
    return this.open(resolved);
  }

  async runExternal(args) {
    try {
      const result = await execFileAsync('git', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C.UTF-8' } });
      return result.stdout;
    } catch (error) {
      const details = String(error.stderr || error.stdout || '').trim();
      throw new GitError(frenchGitError(details), details);
    }
  }

  async snapshot() {
    const [status, commits, branches, remotes, tags, stashes, head, headHash, repository, operation, identity, submodules, worktrees, gitFlow, lfs, commitPreferences] = await Promise.all([
      this.worktreeStatus(),
      this.commits(),
      this.branches(),
      this.remotes(),
      this.tags(),
      this.stashes(),
      this.head(),
      this.headHash(),
      this.run(['rev-parse', '--show-toplevel']).then((value) => value.trim()),
      this.operationState(),
      this.identity(),
      this.submodules(),
      this.worktrees(),
      this.gitFlowConfig(),
      this.lfsStatus(),
      this.commitPreferences(),
    ]);
    const commitsByHash = new Map(commits.map((commit) => [commit.hash, commit]));
    stashes.forEach((stash) => {
      const headCommit = commitsByHash.get(stash.hash);
      if (headCommit) Object.assign(headCommit, { stashRole: 'worktree', stashRef: stash.ref, stashBaseHash: stash.baseHash });
      const indexCommit = commitsByHash.get(stash.indexHash);
      if (indexCommit) Object.assign(indexCommit, { stashRole: 'index', stashRef: stash.ref, stashBaseHash: stash.baseHash });
      const untrackedCommit = commitsByHash.get(stash.untrackedHash);
      if (untrackedCommit) Object.assign(untrackedCommit, { stashRole: 'untracked', stashRef: stash.ref, stashBaseHash: stash.baseHash });
    });
    const orderDebug = await this.commitOrderDebug(commits);
    const undoHistory = await this.undoPlans(status, operation);
    const undoPlan = undoHistory[0] || await this.undoPlan(status, operation);

    return { repository, head, headHash, status, commits, branches, remotes, tags, stashes, operation, identity, submodules, worktrees, gitFlow, lfs, commitPreferences, orderDebug, undoPlan, undoHistory };
  }

  async reflogEntries(limit = 20) {
    const safeLimit = Math.max(2, Math.min(Number(limit) || 20, 100));
    const output = await this.run(['reflog', `--max-count=${safeLimit}`, `--format=%H${FIELD}%gD${FIELD}%gs`]).catch(() => '');
    return output.split('\n').filter(Boolean).map((line) => {
      const [hash, selector, subject] = line.split(FIELD);
      return { hash, selector, subject: subject || '' };
    });
  }

  async undoPlan(status = null, operation = null) {
    const currentStatus = status || await this.worktreeStatus();
    const currentOperation = operation === null ? await this.operationState() : operation;
    if (currentOperation) return { available: false, reason: `Terminez ou abandonnez l’opération « ${currentOperation.label} » avant d’annuler une action.` };
    if (currentStatus.files.length) return { available: false, reason: 'Le travail en cours doit être propre avant d’annuler une action Git.' };

    const plans = await this.undoPlans(currentStatus, currentOperation, 2);
    if (plans.length) return plans[0];
    const entries = await this.reflogEntries(2);
    if (entries.length < 2) return { available: false, reason: 'Aucune action Git réversible dans le reflog.' };
    return { available: false, reason: `La dernière entrée du reflog n’est pas annulable automatiquement : ${entries[0].subject}` };
  }

  undoPlanFromEntries(current, previous) {
    if (!current || !previous || current.subject.startsWith('forkline ')) return null;
    const checkout = current.subject.match(/^checkout: moving from (.+) to (.+)$/);
    if (checkout) {
      return { available: true, kind: 'checkout', label: `Annuler le changement vers ${checkout[2]}`, fromHash: current.hash, toHash: previous.hash, fromTarget: checkout[2], toTarget: checkout[1] };
    }

    const soft = /^(commit(?: \(amend\))?|cherry-pick|revert):/.test(current.subject);
    const keep = /^(merge|pull|reset):/.test(current.subject);
    if (!soft && !keep) return null;
    return {
      available: true,
      kind: 'move-head',
      mode: soft ? 'soft' : 'keep',
      label: `Annuler « ${current.subject} »`,
      fromHash: current.hash,
      toHash: previous.hash,
    };
  }

  async undoPlans(status = null, operation = null, limit = 20) {
    const currentStatus = status || await this.worktreeStatus();
    const currentOperation = operation === null ? await this.operationState() : operation;
    if (currentOperation || currentStatus.files.length) return [];
    const entries = await this.reflogEntries(Math.min((Number(limit) || 20) + 1, 100));
    const plans = [];
    let preservingIndex = false;
    for (let index = 0; index < entries.length - 1 && plans.length < limit; index += 1) {
      const plan = this.undoPlanFromEntries(entries[index], entries[index + 1]);
      if (!plan) break;
      if (preservingIndex && !(plan.kind === 'move-head' && plan.mode === 'soft')) break;
      plans.push(plan);
      if (plan.kind === 'move-head' && plan.mode === 'soft') preservingIndex = true;
    }
    return plans;
  }

  async historyStateFingerprint() {
    const [head, hash, status] = await Promise.all([
      this.head(),
      this.headHash(),
      this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    ]);
    return { head, hash, status };
  }

  historyReflogEnvironment(action) {
    return { ...process.env, LC_ALL: 'C.UTF-8', GIT_REFLOG_ACTION: `forkline ${action}` };
  }

  async checkoutHistoryTarget(target, action = 'history') {
    const branchExists = await this.run(['show-ref', '--verify', '--quiet', `refs/heads/${target}`]).then(() => true).catch(() => false);
    if (branchExists) return this.run(['switch', target], { env: this.historyReflogEnvironment(action) });
    await this.validateRevision(target);
    return this.run(['switch', '--detach', target], { env: this.historyReflogEnvironment(action) });
  }

  async undoLastAction() {
    const plan = (await this.undoPlans(null, null, 1))[0] || await this.undoPlan();
    if (!plan.available) throw new GitError(plan.reason);
    return this.applyUndoPlan(plan);
  }

  async applyUndoPlan(plan, expectedState = null) {
    if (!plan?.available) throw new GitError('Action à annuler invalide.');
    const before = await this.historyStateFingerprint();
    if (expectedState && (before.head !== expectedState.head || before.hash !== expectedState.hash || before.status !== expectedState.status)) {
      throw new GitError('Le dépôt a changé entre deux annulations. Les actions restantes ont été désactivées.');
    }
    if (!expectedState && before.status) throw new GitError('Le travail en cours doit être propre avant d’annuler une action Git.');
    if (before.hash !== plan.fromHash) throw new GitError('Le dépôt a changé depuis le calcul de l’action à annuler.');

    if (plan.kind === 'checkout') await this.checkoutHistoryTarget(plan.toTarget, 'undo');
    else await this.run(['reset', `--${plan.mode}`, plan.toHash], { env: this.historyReflogEnvironment('undo') });

    const expected = await this.historyStateFingerprint();
    return { label: plan.label, kind: plan.kind, mode: plan.mode, targetHash: plan.fromHash, target: plan.fromTarget, expected, plan };
  }

  async redoLastAction(action) {
    if (!action || !action.expected) throw new GitError('Aucune action à rétablir.');
    const current = await this.historyStateFingerprint();
    if (current.head !== action.expected.head || current.hash !== action.expected.hash || current.status !== action.expected.status) {
      throw new GitError('Le dépôt a changé depuis l’annulation. Le rétablissement a été désactivé pour protéger vos modifications.');
    }
    if (action.kind === 'checkout') await this.checkoutHistoryTarget(action.target, 'redo');
    else {
      await this.validateRevision(action.targetHash);
      await this.run(['reset', `--${action.mode}`, action.targetHash], { env: this.historyReflogEnvironment('redo') });
    }
    return this.historyStateFingerprint();
  }

  async commitPreferences() {
    const read = (key) => this.run(['config', '--get', key]).then((value) => value.trim()).catch(() => '');
    const [gpgSign, signingKey, hooksDirectory] = await Promise.all([
      read('commit.gpgSign'), read('user.signingKey'), this.run(['rev-parse', '--git-path', 'hooks']).then((value) => value.trim()),
    ]);
    const absoluteHooks = path.resolve(this.repoPath, hooksDirectory);
    const hooks = await fs.readdir(absoluteHooks, { withFileTypes: true }).then(async (entries) => {
      const active = [];
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.endsWith('.sample')) continue;
        const stats = await fs.stat(path.join(absoluteHooks, entry.name));
        if (stats.mode & 0o111) active.push(entry.name);
      }
      return active.sort();
    }).catch(() => []);
    return { gpgSign: /^(true|yes|on|1)$/i.test(gpgSign), signingKey, hooks };
  }

  async setCommitPreferences(options = {}) {
    const scope = options.scope || 'local';
    if (!['local', 'global'].includes(scope)) throw new GitError('Portée de configuration Git invalide.');
    const flag = `--${scope}`;
    await this.run(['config', flag, 'commit.gpgSign', options.gpgSign ? 'true' : 'false']);
    const key = String(options.signingKey || '').trim();
    if (key && /[\0\r\n]/.test(key)) throw new GitError('Clé de signature invalide.');
    if (key) await this.run(['config', flag, 'user.signingKey', key]);
    else await this.run(['config', flag, '--unset-all', 'user.signingKey']).catch(() => '');
    return this.commitPreferences();
  }

  async lfsStatus() {
    if (this.lfsAvailable === null) this.lfsAvailable = await this.runExternal(['lfs', 'version']).then(() => true).catch(() => false);
    const attributes = await fs.readFile(path.join(this.repoPath, '.gitattributes'), 'utf8').catch(() => '');
    const patterns = attributes.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).filter((line) => line.split(/\s+/).includes('filter=lfs')).map((line) => line.split(/\s+/)[0]);
    return { available: this.lfsAvailable, patterns };
  }

  async assertLfsAvailable() {
    if (!(await this.lfsStatus()).available) throw new GitError('Git LFS n’est pas installé sur cette machine.');
  }

  async trackLfs(pattern) {
    await this.assertLfsAvailable();
    const cleanPattern = String(pattern || '').trim();
    if (!cleanPattern || cleanPattern.startsWith('-') || /[\0\r\n]/.test(cleanPattern)) throw new GitError('Motif Git LFS invalide.');
    return this.run(['lfs', 'track', cleanPattern]);
  }

  async untrackLfs(pattern) {
    await this.assertLfsAvailable();
    const cleanPattern = String(pattern || '').trim();
    if (!cleanPattern || cleanPattern.startsWith('-') || /[\0\r\n]/.test(cleanPattern)) throw new GitError('Motif Git LFS invalide.');
    return this.run(['lfs', 'untrack', cleanPattern]);
  }

  async pullLfs() {
    await this.assertLfsAvailable();
    return this.run(['lfs', 'pull']);
  }

  async pushLfs() {
    await this.assertLfsAvailable();
    return this.run(['lfs', 'push', '--all']);
  }

  async gitFlowConfig() {
    const read = (key) => this.run(['config', '--local', '--get', key]).then((value) => value.trim()).catch(() => '');
    const [master, develop, feature, release, hotfix, support, versionTag] = await Promise.all([
      read('gitflow.branch.master'), read('gitflow.branch.develop'), read('gitflow.prefix.feature'), read('gitflow.prefix.release'), read('gitflow.prefix.hotfix'), read('gitflow.prefix.support'), read('gitflow.prefix.versiontag'),
    ]);
    return { initialized: Boolean(master && develop), master, develop, prefixes: { feature: feature || 'feature/', release: release || 'release/', hotfix: hotfix || 'hotfix/', support: support || 'support/', versionTag } };
  }

  async initializeGitFlow(options = {}) {
    const master = String(options.master || 'main').trim();
    const develop = String(options.develop || 'develop').trim();
    await this.validateBranchName(master, true);
    await this.run(['rev-parse', '--verify', `refs/heads/${master}^{commit}`]);
    const localBranches = await this.branches();
    if (!localBranches.some((branch) => !branch.remote && branch.name === develop)) {
      await this.validateNewBranchName(develop);
      await this.run(['branch', develop, master]);
    }
    const prefixes = {
      feature: String(options.featurePrefix || 'feature/'), release: String(options.releasePrefix || 'release/'), hotfix: String(options.hotfixPrefix || 'hotfix/'), support: String(options.supportPrefix || 'support/'), versionTag: String(options.versionTagPrefix || ''),
    };
    for (const [key, value] of Object.entries(prefixes)) {
      if (/[:?*[\s\\~^\0]/.test(value)) throw new GitError(`Préfixe Git Flow ${key} invalide.`);
    }
    const values = { 'gitflow.branch.master': master, 'gitflow.branch.develop': develop, 'gitflow.prefix.feature': prefixes.feature, 'gitflow.prefix.release': prefixes.release, 'gitflow.prefix.hotfix': prefixes.hotfix, 'gitflow.prefix.support': prefixes.support, 'gitflow.prefix.versiontag': prefixes.versionTag };
    for (const [key, value] of Object.entries(values)) await this.run(['config', '--local', key, value]);
    return this.gitFlowConfig();
  }

  async startGitFlow(type, name, startPoint = '') {
    if (!['feature', 'release', 'hotfix', 'support'].includes(type)) throw new GitError('Type de branche Git Flow invalide.');
    const config = await this.gitFlowConfig();
    if (!config.initialized) throw new GitError('Git Flow n’est pas initialisé dans ce dépôt.');
    if ((await this.status()).files.length) throw new GitError('La copie de travail doit être propre avant de démarrer une branche Git Flow.');
    const cleanName = String(name || '').trim();
    const branch = `${config.prefixes[type]}${cleanName}`;
    await this.validateNewBranchName(branch);
    const base = type === 'support' ? String(startPoint || '').trim() : type === 'hotfix' ? config.master : config.develop;
    if (type === 'support' && !base) throw new GitError('Une branche ou un tag de départ est obligatoire pour une branche support.');
    await this.validateRevision(base);
    await this.run(['switch', '-c', branch, base]);
    return branch;
  }

  async finishGitFlow(type, branch) {
    if (!['feature', 'release', 'hotfix'].includes(type)) throw new GitError('Type de branche Git Flow invalide.');
    const config = await this.gitFlowConfig();
    if (!config.initialized) throw new GitError('Git Flow n’est pas initialisé dans ce dépôt.');
    const prefix = config.prefixes[type];
    if (typeof branch !== 'string' || !branch.startsWith(prefix) || branch.length <= prefix.length) throw new GitError('Branche Git Flow invalide.');
    await this.run(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
    if ((await this.status()).files.length) throw new GitError('La copie de travail doit être propre avant de terminer une branche Git Flow.');
    const mergeInto = async (target) => {
      await this.run(['switch', target]);
      return this.runConflictAware(['merge', '--no-ff', '--no-edit', branch]);
    };
    if (type === 'feature') {
      const merged = await mergeInto(config.develop);
      if (merged.conflicted) return merged;
    } else {
      const mergedToMaster = await mergeInto(config.master);
      if (mergedToMaster.conflicted) return mergedToMaster;
      const version = branch.slice(prefix.length);
      const tagName = `${config.prefixes.versionTag}${version}`;
      const existingTag = await this.run(['rev-parse', '--verify', `refs/tags/${tagName}^{commit}`]).then((value) => value.trim()).catch(() => '');
      const masterHash = await this.headHash();
      if (existingTag && existingTag !== masterHash) throw new GitError(`Le tag ${tagName} existe déjà sur un autre commit.`);
      if (!existingTag) await this.createTag(tagName, masterHash);
      const mergedToDevelop = await mergeInto(config.develop);
      if (mergedToDevelop.conflicted) return mergedToDevelop;
    }
    await this.run(['branch', '-d', branch]);
    return { output: `Branche ${branch} terminée.`, conflicted: false, conflicts: [] };
  }

  async submodules() {
    const modulesFile = path.join(this.repoPath, '.gitmodules');
    try {
      await fs.access(modulesFile);
    } catch {
      return [];
    }
    const output = await this.run(['config', '--file', '.gitmodules', '--get-regexp', '^submodule\..*\.path$']).catch(() => '');
    const entries = output.split('\n').filter(Boolean).map((line) => {
      const separator = line.indexOf(' ');
      return { key: line.slice(0, separator), path: line.slice(separator + 1) };
    });
    return Promise.all(entries.map(async (entry) => {
      this.assertSafeRelativePath(entry.path);
      const section = entry.key.slice(0, -'.path'.length);
      const readConfig = (suffix) => this.run(['config', '--file', '.gitmodules', '--get', `${section}.${suffix}`]).then((value) => value.trim()).catch(() => '');
      const absolutePath = path.join(this.repoPath, entry.path);
      const initialized = await fs.access(path.join(absolutePath, '.git')).then(() => true).catch(() => false);
      const [url, branch, indexEntry, currentHash, dirty] = await Promise.all([
        readConfig('url'),
        readConfig('branch'),
        this.run(['ls-files', '--stage', '--', entry.path]).then((value) => value.trim()).catch(() => ''),
        initialized ? this.run(['-C', absolutePath, 'rev-parse', 'HEAD']).then((value) => value.trim()).catch(() => '') : '',
        initialized ? this.run(['-C', absolutePath, 'status', '--porcelain']).then((value) => Boolean(value.trim())).catch(() => false) : false,
      ]);
      const expectedHash = indexEntry.match(/^160000\s+([0-9a-f]{40})/)?.[1] || '';
      return { name: section.slice('submodule.'.length), path: entry.path, url, branch, initialized, expectedHash, currentHash, dirty, outOfSync: Boolean(initialized && expectedHash && currentHash && expectedHash !== currentHash) };
    }));
  }

  async assertSubmodulePath(submodulePath) {
    this.assertSafeRelativePath(submodulePath);
    const submodule = (await this.submodules()).find((entry) => entry.path === submodulePath);
    if (!submodule) throw new GitError('Sous-module introuvable dans .gitmodules.');
    return submodule;
  }

  async addSubmodule(url, submodulePath, branch = '') {
    if (typeof url !== 'string' || !url.trim() || url.startsWith('-') || /[\0\r\n]/.test(url)) throw new GitError('Adresse du sous-module invalide.');
    this.assertSafeRelativePath(submodulePath);
    if (branch) await this.validateNewBranchName(branch);
    return this.run(['-c', 'protocol.file.allow=always', 'submodule', 'add', ...(branch ? ['-b', branch] : []), '--', url.trim(), submodulePath]);
  }

  async updateSubmodule(submodulePath) {
    await this.assertSubmodulePath(submodulePath);
    return this.run(['submodule', 'update', '--init', '--recursive', '--', submodulePath]);
  }

  async syncSubmodule(submodulePath) {
    await this.assertSubmodulePath(submodulePath);
    return this.run(['submodule', 'sync', '--recursive', '--', submodulePath]);
  }

  async deinitializeSubmodule(submodulePath, force = false) {
    await this.assertSubmodulePath(submodulePath);
    return this.run(['submodule', 'deinit', ...(force ? ['--force'] : []), '--', submodulePath]);
  }

  async worktrees() {
    const output = await this.run(['worktree', 'list', '--porcelain', '-z']);
    const records = [];
    let current = null;
    for (const field of output.split('\0')) {
      if (!field) {
        if (current) records.push(current);
        current = null;
        continue;
      }
      current ||= {};
      const separator = field.indexOf(' ');
      const key = separator === -1 ? field : field.slice(0, separator);
      const value = separator === -1 ? true : field.slice(separator + 1);
      current[key] = value;
    }
    if (current) records.push(current);
    const repository = await fs.realpath(this.repoPath);
    return Promise.all(records.map(async (record) => {
      const worktreePath = await fs.realpath(record.worktree).catch(() => record.worktree);
      return { path: worktreePath, hash: record.HEAD || '', branch: typeof record.branch === 'string' ? record.branch.replace('refs/heads/', '') : '', detached: Boolean(record.detached), locked: record.locked || false, prunable: record.prunable || false, main: worktreePath === repository };
    }));
  }

  async addWorktree(destination, branch, createBranch = false, startPoint = 'HEAD') {
    const resolved = path.resolve(destination);
    if (createBranch) await this.validateNewBranchName(branch);
    else await this.validateBranchName(branch, true);
    await this.validateRevision(startPoint);
    return this.run(['worktree', 'add', ...(createBranch ? ['-b', branch] : []), resolved, createBranch ? startPoint : branch]);
  }

  async removeWorktree(worktreePath, force = false) {
    const resolved = await fs.realpath(worktreePath).catch(() => path.resolve(worktreePath));
    const worktree = (await this.worktrees()).find((entry) => entry.path === resolved);
    if (!worktree || worktree.main) throw new GitError('Worktree secondaire introuvable.');
    return this.run(['worktree', 'remove', ...(force ? ['--force'] : []), resolved]);
  }

  async pruneWorktrees() {
    return this.run(['worktree', 'prune', '--verbose']);
  }

  async identity() {
    const read = (scope, key) => this.run(['config', scope, '--get', key]).then((value) => value.trim()).catch(() => '');
    const [localName, localEmail, globalName, globalEmail] = await Promise.all([
      read('--local', 'user.name'), read('--local', 'user.email'), read('--global', 'user.name'), read('--global', 'user.email'),
    ]);
    return {
      name: localName || globalName,
      email: localEmail || globalEmail,
      scope: localName || localEmail ? 'local' : 'global',
      local: { name: localName, email: localEmail },
      global: { name: globalName, email: globalEmail },
    };
  }

  async setIdentity(name, email, scope = 'local') {
    const cleanName = String(name || '').trim();
    const cleanEmail = String(email || '').trim();
    if (!cleanName || /[\0\r\n]/.test(cleanName)) throw new GitError('Le nom Git est obligatoire.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw new GitError('Adresse e-mail Git invalide.');
    if (!['local', 'global'].includes(scope)) throw new GitError('Portée de configuration Git invalide.');
    const flag = `--${scope}`;
    await this.run(['config', flag, 'user.name', cleanName]);
    await this.run(['config', flag, 'user.email', cleanEmail]);
    return this.identity();
  }

  async operationState() {
    const gitDirectory = path.resolve(this.repoPath, (await this.run(['rev-parse', '--git-dir'])).trim());
    const exists = async (entry) => fs.access(path.join(gitDirectory, entry)).then(() => true).catch(() => false);
    if (await exists('rebase-apply/applying')) return { type: 'am', label: 'Application de patch en cours' };
    if (await exists('rebase-merge') || await exists('rebase-apply')) return { type: 'rebase', label: 'Rebase en cours' };
    if (await exists('MERGE_HEAD')) {
      const [sourceHash, target, message] = await Promise.all([
        this.run(['rev-parse', 'MERGE_HEAD']).then((value) => value.trim()),
        this.head(),
        fs.readFile(path.join(gitDirectory, 'MERGE_MSG'), 'utf8').catch(() => ''),
      ]);
      const refs = await this.run(['for-each-ref', `--points-at=${sourceHash}`, '--format=%(refname:short)', 'refs/heads', 'refs/remotes']).catch(() => '');
      const candidates = refs.split('\n').map((value) => value.trim()).filter((value) => value && value !== target && !value.endsWith('/HEAD'));
      const messageSource = message.match(/^Merge (?:remote-tracking )?branch ['‘]([^'’]+)['’]/m)?.[1] || '';
      const source = candidates.find((value) => value === messageSource || value.endsWith(`/${messageSource}`)) || candidates[0] || messageSource || sourceHash.slice(0, 10);
      const conflictPaths = [];
      let readingConflicts = false;
      for (const line of message.split('\n')) {
        if (line.trim() === '# Conflicts:') {
          readingConflicts = true;
          continue;
        }
        if (!readingConflicts) continue;
        const conflict = line.match(/^#\s+(.+)$/)?.[1]?.trim();
        if (!conflict) break;
        conflictPaths.push(conflict);
      }
      return { type: 'merge', label: 'Fusion en cours', source, target, defaultMessage: message.trim(), conflictPaths };
    }
    if (await exists('CHERRY_PICK_HEAD')) return { type: 'cherry-pick', label: 'Cherry-pick en cours' };
    if (await exists('REVERT_HEAD')) return { type: 'revert', label: 'Revert en cours' };
    return null;
  }

  async head() {
    try {
      return (await this.run(['symbolic-ref', '--short', 'HEAD'])).trim();
    } catch {
      return (await this.run(['rev-parse', '--short', 'HEAD'])).trim();
    }
  }

  async headHash() {
    try {
      return (await this.run(['rev-parse', '--verify', 'HEAD'])).trim();
    } catch {
      return null;
    }
  }

  async status() {
    const output = await this.run(['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all']);
    const records = output.split('\0').filter(Boolean);
    const branchLine = records.shift() || '';
    const files = records.map((record) => {
      const index = record[0];
      const workingTree = record[1];
      let filePath = record.slice(3);
      let originalPath = null;

      if ((index === 'R' || index === 'C') && records.length) {
        originalPath = records.shift();
      }

      return {
        path: filePath,
        originalPath,
        index,
        workingTree,
        staged: index !== ' ' && index !== '?',
        untracked: index === '?' && workingTree === '?',
        conflicted: ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(`${index}${workingTree}`),
      };
    });

    const ahead = Number(branchLine.match(/ahead (\d+)/)?.[1] || 0);
    const behind = Number(branchLine.match(/behind (\d+)/)?.[1] || 0);
    return { files, ahead, behind };
  }

  async worktreeStatus() {
    let status = await this.status();
    const mixedFiles = status.files.filter((file) => file.staged && file.workingTree !== ' ' && !file.untracked && !file.conflicted).map((file) => file.path);
    if (mixedFiles.length) {
      await this.unstage(mixedFiles);
      status = await this.status();
    }
    return status;
  }

  async commits(limit = 160) {
    try {
      await this.run(['rev-parse', '--verify', 'HEAD']);
    } catch {
      return [];
    }

    const format = `%H${FIELD}%h${FIELD}%an${FIELD}%ae${FIELD}%aI${FIELD}%cI${FIELD}%P${FIELD}%D${FIELD}%s${RECORD}`;
    const output = await this.run([
      'log', '--all', '--full-history', '--date-order', `--max-count=${limit}`, `--pretty=format:${format}`,
    ]);

    return output.split(RECORD).filter((record) => record.trim()).map((record, index) => {
      const [hash, shortHash, author, email, authorDate, committerDate, parents, refs, subject] = record.trim().split(FIELD);
      return {
        hash,
        shortHash,
        author,
        email,
        // Keep date for the existing UI while retaining both Git timestamps for diagnostics.
        date: authorDate,
        authorDate,
        committerDate,
        topologicalRank: null,
        finalDisplayIndex: index,
        parents: parents ? parents.split(' ') : [],
        refs: refs ? refs.split(',').map((ref) => ref.trim()).filter(Boolean) : [],
        subject,
      };
    });
  }

  async commitOrderDebug(commits) {
    if (process.env.DEBUG_GRAPH_LAYOUT !== '1') return null;

    const topologicalOrder = (await this.run([
      'log', '--all', '--topo-order', `--max-count=${commits.length}`, '--pretty=format:%H',
    ])).split('\n').filter(Boolean);
    const topologicalRank = new Map(topologicalOrder.map((hash, index) => [hash, index]));
    let firstDifference = -1;

    for (let index = 0; index < commits.length; index += 1) {
      if (commits[index].hash !== topologicalOrder[index]) {
        firstDifference = index;
        break;
      }
    }

    commits.forEach((commit) => {
      commit.topologicalRank = topologicalRank.get(commit.hash) ?? null;
      commit.dateOrderIndex = commit.finalDisplayIndex;
    });

    return {
      finalDisplayOrder: 'date-order',
      topologicalCommitCount: topologicalOrder.length,
      dateOrderCommitCount: commits.length,
      firstDifference: firstDifference === -1 ? null : {
        index: firstDifference,
        topoHash: topologicalOrder[firstDifference] || null,
        dateHash: commits[firstDifference]?.hash || null,
      },
    };
  }

  async branches() {
    const format = '%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)%09%(committerdate:iso-strict)%09%(objectname)%09%(symref)';
    const [local, remote] = await Promise.all([
      this.run(['branch', `--format=${format}`]),
      this.run(['branch', '-r', `--format=${format}`]),
    ]);
    const parse = (output, isRemote) => output.split('\n').filter(Boolean).map((line) => {
      const [name, current, upstream, track, date, hash, symref] = line.split('\t');
      return { name, current: current === '*', upstream, track, tracking: parseTrackingStatus(track), date, hash, symbolic: Boolean(symref), remote: isRemote };
    });
    return [...parse(local, false), ...parse(remote, true)];
  }

  async remotes() {
    const output = await this.run(['remote', '-v']);
    const remotes = new Map();
    for (const line of output.split('\n').filter(Boolean)) {
      const [name, rest = ''] = line.split(/\s+/, 2);
      if (!remotes.has(name)) remotes.set(name, { name });
      const url = rest.replace(/\s+\((fetch|push)\)$/, '');
      if (line.endsWith('(fetch)')) remotes.get(name).fetchUrl = url;
      if (line.endsWith('(push)')) remotes.get(name).pushUrl = url;
    }
    return [...remotes.values()];
  }

  async tags() {
    const format = `%(refname:short)${FIELD}%(objectname)${FIELD}%(*objectname)${FIELD}%(creatordate:iso-strict)${FIELD}%(subject)${RECORD}`;
    const output = await this.run(['for-each-ref', `--format=${format}`, 'refs/tags']);
    return output.split(RECORD).filter((record) => record.trim()).map((record) => {
      const [name, objectHash, peeledHash, date, subject] = record.trim().split(FIELD);
      return { name, hash: peeledHash || objectHash, objectHash, annotated: Boolean(peeledHash), date, subject };
    });
  }

  async stashes() {
    const format = `%gd${FIELD}%H${FIELD}%gs${FIELD}%cI`;
    const output = await this.run(['stash', 'list', `--format=${format}`]);
    const entries = output.split('\n').filter(Boolean).map((line) => {
      const [ref, hash, subject, date] = line.split(FIELD);
      const match = subject.match(/^(?:On|WIP on) ([^:]+):\s*(.*)$/);
      return { ref, hash, subject, branch: match?.[1] || '', message: match?.[2] || subject, date };
    });

    return Promise.all(entries.map(async (stash) => {
      const parents = (await this.run(['show', '-s', '--format=%P', stash.hash])).trim().split(' ').filter(Boolean);
      let filesOutput = '';
      try {
        filesOutput = await this.run(['stash', 'show', '--name-only', '--include-untracked', '--format=', stash.ref]);
      } catch {
        filesOutput = await this.run(['stash', 'show', '--name-only', '--format=', stash.ref]);
      }
      const files = [...new Set(filesOutput.split('\n').filter(Boolean))];
      return {
        ...stash,
        baseHash: parents[0] || null,
        indexHash: parents[1] || null,
        untrackedHash: parents[2] || null,
        files,
        fileCount: files.length,
      };
    }));
  }

  validateStashRef(ref) {
    if (typeof ref !== 'string' || !/^stash@\{\d+\}$/.test(ref)) throw new GitError('Référence de stash invalide.');
    return ref;
  }

  async createStash(options = {}) {
    const message = String(options.message || '').trim();
    const files = Array.isArray(options.files) ? options.files : [];
    files.forEach((file) => this.assertSafeRelativePath(file));
    const args = ['stash', 'push'];
    if (options.includeUntracked) args.push('--include-untracked');
    if (options.keepIndex) args.push('--keep-index');
    if (message) args.push('-m', message);
    if (files.length) args.push('--', ...files);
    const output = await this.run(args);
    if (/No local changes to save/i.test(output)) throw new GitError('Aucune modification à mettre de côté.');
    return output;
  }

  async stashDiff(ref) {
    this.validateStashRef(ref);
    try {
      return await this.run(['stash', 'show', '--patch', '--include-untracked', '--no-ext-diff', ref]);
    } catch {
      return this.run(['stash', 'show', '--patch', '--no-ext-diff', ref]);
    }
  }

  async renameStash(ref, message) {
    this.validateStashRef(ref);
    const cleanMessage = String(message || '').trim();
    if (!cleanMessage || /[\0\r\n]/.test(cleanMessage)) throw new GitError('Le message du stash est invalide.');
    const stashes = await this.stashes();
    const stashIndex = stashes.findIndex((stash) => stash.ref === ref);
    if (stashIndex < 0) throw new GitError('Le stash est introuvable.');
    const stash = stashes[stashIndex];
    const subject = stash.branch ? `On ${stash.branch}: ${cleanMessage}` : cleanMessage;
    await this.run(['stash', 'store', '-m', subject, stash.hash]);
    await this.run(['stash', 'drop', `stash@{${stashIndex + 1}}`]);
    return `Stash renommé : ${cleanMessage}`;
  }

  async restoreStash(ref, mode, files = []) {
    this.validateStashRef(ref);
    if (!['apply', 'pop'].includes(mode)) throw new GitError('Action de stash invalide.');
    if (!Array.isArray(files)) throw new GitError('Sélection de fichiers invalide.');
    files.forEach((file) => this.assertSafeRelativePath(file));
    if (files.length && mode !== 'apply') throw new GitError('L’application partielle est disponible uniquement avec Appliquer.');

    const statusBefore = await this.status();
    if (statusBefore.files.some((file) => file.staged)) {
      throw new GitError('Impossible d’appliquer un stash tant que des fichiers sont indexés. Validez-les ou retirez-les de l’index.');
    }

    try {
      const output = files.length
        ? await this.restoreStashFiles(ref, files)
        : await this.run(['stash', mode, ref]);
      return { output, conflicted: false, conflicts: [], partial: files.length > 0 };
    } catch (error) {
      const status = await this.status();
      const conflicts = status.files.filter((file) => file.conflicted).map((file) => file.path);
      if (!conflicts.length) throw error;
      return { output: error.details || error.message, conflicted: true, conflicts };
    }
  }

  async restoreStashFiles(ref, files) {
    const parents = (await this.run(['show', '-s', '--format=%P', ref])).trim().split(' ').filter(Boolean);
    const tracked = new Set((await this.run(['ls-tree', '-r', '-z', '--name-only', ref])).split('\0').filter(Boolean));
    const untrackedParent = parents[2] || null;
    const untracked = untrackedParent
      ? new Set((await this.run(['ls-tree', '-r', '-z', '--name-only', untrackedParent])).split('\0').filter(Boolean))
      : new Set();
    const unknown = files.filter((file) => !tracked.has(file) && !untracked.has(file));
    if (unknown.length) throw new GitError(`Ces fichiers n’existent pas dans le stash : ${unknown.join(', ')}`);

    const trackedFiles = files.filter((file) => tracked.has(file));
    const untrackedFiles = files.filter((file) => untracked.has(file) && !tracked.has(file));
    if (trackedFiles.length) await this.run(['restore', `--source=${ref}`, '--worktree', '--', ...trackedFiles]);
    if (untrackedFiles.length) {
      await this.run(['checkout', untrackedParent, '--', ...untrackedFiles]);
      await this.run(['restore', '--staged', '--', ...untrackedFiles]);
    }
    return `Fichiers appliqués : ${files.join(', ')}`;
  }

  async dropStash(ref) {
    this.validateStashRef(ref);
    return this.run(['stash', 'drop', ref]);
  }

  async diff(filePath, staged = false) {
    this.assertSafeRelativePath(filePath);
    const args = ['diff', '--no-ext-diff', '--unified=4'];
    if (staged) args.push('--cached');
    args.push('--', filePath);
    const output = await this.run(args);

    if (!output && !staged) {
      const status = await this.status();
      const file = status.files.find((entry) => entry.path === filePath);
      if (file?.untracked) return this.untrackedPreview(filePath);
    }
    return output || 'Aucune différence à afficher.';
  }

  async untrackedPreview(filePath) {
    const absolutePath = path.resolve(this.repoPath, filePath);
    const content = await fs.readFile(absolutePath, 'utf8').catch(() => null);
    if (content === null) return 'Fichier binaire ou illisible.';
    const lines = content.split('\n').slice(0, 500);
    return [`diff --git a/${filePath} b/${filePath}`, 'new file mode 100644', '--- /dev/null', `+++ b/${filePath}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join('\n');
  }

  assertSafeRelativePath(filePath) {
    if (typeof filePath !== 'string' || !filePath || path.isAbsolute(filePath)) {
      throw new GitError('Chemin de fichier invalide.');
    }
    const resolved = path.resolve(this.repoPath, filePath);
    const relative = path.relative(this.repoPath, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new GitError('Le fichier doit appartenir au dépôt.');
    }
  }

  async stage(files) {
    this.assertFileList(files);
    return this.run(['add', '--', ...files]);
  }

  async unstage(files) {
    this.assertFileList(files);
    return this.run(['restore', '--staged', '--', ...files]);
  }

  async applyHunk(patch, staged = false, reverse = false) {
    if (typeof patch !== 'string' || !patch.trim()) throw new GitError('Hunk invalide.');
    try {
      await spawnWithInput('git', ['-C', this.repoPath, 'apply', ...(staged ? ['--cached'] : []), ...(reverse ? ['--reverse'] : [])], patch, {
        env: { ...process.env, LC_ALL: 'C.UTF-8' },
      });
    } catch (error) {
      const details = String(error.stderr || error.stdout || '').trim();
      throw new GitError(frenchGitError(details, 'Impossible d’appliquer ce hunk.'), details);
    }
    return true;
  }

  async resolveConflict(filePath, strategy) {
    this.assertSafeRelativePath(filePath);
    if (!['ours', 'theirs', 'resolved'].includes(strategy)) throw new GitError('Stratégie de résolution invalide.');
    const file = (await this.status()).files.find((entry) => entry.path === filePath);
    if (!file?.conflicted) throw new GitError('Ce fichier n’est pas en conflit.');
    if (strategy !== 'resolved') {
      const stage = strategy === 'ours' ? '2' : '3';
      const stagedEntries = await this.run(['ls-files', '--unmerged', '--', filePath]);
      if (!stagedEntries.split('\n').some((line) => line.match(/\s([123])\t/)?.[1] === stage)) {
        await this.run(['rm', '--', filePath]);
        return true;
      }
      await this.run(['checkout', `--${strategy}`, '--', filePath]);
    }
    await this.run(['add', '--', filePath]);
    return true;
  }

  async conflictVersions(filePath) {
    this.assertSafeRelativePath(filePath);
    const file = (await this.status()).files.find((entry) => entry.path === filePath);
    if (!file?.conflicted) throw new GitError('Ce fichier n’est pas en conflit.');
    const readStage = (stage) => this.run(['show', `:${stage}:${filePath}`]).catch(() => '');
    const [base, ours, theirs, result] = await Promise.all([
      readStage(1), readStage(2), readStage(3), fs.readFile(path.join(this.repoPath, filePath), 'utf8').catch(() => ''),
    ]);
    return { file: filePath, base, ours, theirs, result };
  }

  async resolveConflictContent(filePath, content) {
    this.assertSafeRelativePath(filePath);
    if (typeof content !== 'string' || Buffer.byteLength(content) > 20 * 1024 * 1024) throw new GitError('Contenu de résolution invalide ou trop volumineux.');
    const file = (await this.status()).files.find((entry) => entry.path === filePath);
    if (!file?.conflicted) throw new GitError('Ce fichier n’est pas en conflit.');
    const absolutePath = path.resolve(this.repoPath, filePath);
    const realParent = await fs.realpath(path.dirname(absolutePath));
    const relativeParent = path.relative(this.repoPath, realParent);
    if (relativeParent.startsWith('..') || path.isAbsolute(relativeParent)) throw new GitError('Le fichier doit appartenir au dépôt.');
    const stats = await fs.lstat(absolutePath).catch(() => null);
    if (stats?.isSymbolicLink()) throw new GitError('La résolution directe d’un lien symbolique n’est pas prise en charge.');
    await fs.writeFile(absolutePath, content, 'utf8');
    await this.run(['add', '--', filePath]);
    return true;
  }

  async resolveAllConflicts() {
    const conflicts = (await this.status()).files.filter((file) => file.conflicted).map((file) => file.path);
    if (!conflicts.length) throw new GitError('Aucun fichier en conflit à marquer comme résolu.');
    await this.run(['add', '--', ...conflicts]);
    return true;
  }

  assertFileList(files) {
    if (!Array.isArray(files) || files.length === 0) throw new GitError('Aucun fichier sélectionné.');
    files.forEach((file) => this.assertSafeRelativePath(file));
  }

  async commit(message, options = {}) {
    const cleanMessage = String(message || '').trim();
    if (!cleanMessage) throw new GitError('Le message de commit est obligatoire.');
    return this.run(['commit', ...(options.amend ? ['--amend'] : []), ...(options.sign === true ? ['-S'] : options.sign === false ? ['--no-gpg-sign'] : []), '-m', cleanMessage]);
  }

  async switchBranch(name) {
    await this.validateBranchName(name, true);
    return this.checkoutWithAutoStash(['switch', name], name);
  }

  async createBranch(name, startPoint = null, checkout = true) {
    const branchName = await this.validateNewBranchName(name);
    if (startPoint) await this.validateRevision(startPoint);
    const args = checkout
      ? ['switch', '--no-track', '-c', branchName, ...(startPoint ? [startPoint] : [])]
      : ['branch', '--no-track', branchName, ...(startPoint ? [startPoint] : [])];
    console.info('[branch-create] git command', JSON.stringify({ repository: this.repoPath, args }));
    try {
      const output = await this.run(args);
      console.info('[branch-create] git result', JSON.stringify({ ok: true, output: output.trim() }));
      return output;
    } catch (error) {
      console.error('[branch-create] git result', JSON.stringify({ ok: false, message: error.message, details: error.details || '' }));
      throw error;
    }
  }

  async checkoutCommit(hash) {
    await this.validateRevision(hash);
    return this.checkoutWithAutoStash(['switch', '--detach', hash], hash.slice(0, 7));
  }

  async checkoutWithAutoStash(args, target) {
    const status = await this.status();
    if (status.files.some((file) => file.conflicted)) {
      throw new GitError('Des conflits doivent être résolus avant de changer de branche ou de commit.');
    }

    let autoStashHash = null;
    if (status.files.length) {
      await this.createStash({
        message: `Auto stash before checking out "${target}"`,
        includeUntracked: true,
      });
      autoStashHash = (await this.run(['rev-parse', 'refs/stash'])).trim();
    }

    try {
      return await this.run(args);
    } catch (checkoutError) {
      if (!autoStashHash) throw checkoutError;

      const stash = (await this.stashes()).find((entry) => entry.hash === autoStashHash);
      if (!stash) throw checkoutError;
      try {
        await this.restoreStash(stash.ref, 'pop');
      } catch (restoreError) {
        throw new GitError(
          checkoutError.message,
          `${checkoutError.details || ''}\nLe checkout a échoué et le stash automatique n’a pas pu être restauré. Il est conservé sous ${stash.ref}.\n${restoreError.details || restoreError.message}`.trim(),
        );
      }
      throw checkoutError;
    }
  }

  async mergeBranch(name) {
    await this.validateBranchName(name, true);
    const status = await this.status();
    if (status.files.some((file) => file.conflicted)) {
      throw new GitError('Des conflits doivent être résolus avant de lancer une nouvelle fusion.');
    }

    const pendingAutoStash = await this.pendingMergeAutoStash();
    if (pendingAutoStash) {
      throw new GitError('Un autostash de fusion précédent doit être restauré avant de lancer une nouvelle fusion.');
    }

    let autoStashHash = null;
    if (status.files.length) {
      const activeBranch = await this.head();
      await this.createStash({
        message: `Auto stash before merge of "${activeBranch}" and "${name}"`,
        includeUntracked: true,
      });
      autoStashHash = (await this.run(['rev-parse', 'refs/stash'])).trim();
      await this.run(['config', '--local', 'forkline.autoStash.merge', autoStashHash]);
    }

    try {
      const merged = await this.runConflictAware(['merge', '--no-edit', name]);
      if (merged.conflicted || !autoStashHash) return merged;
      return this.restoreMergeAutoStash(autoStashHash, merged.output);
    } catch (mergeError) {
      if (!autoStashHash) throw mergeError;
      try {
        await this.restoreMergeAutoStash(autoStashHash);
      } catch (restoreError) {
        throw new GitError(
          mergeError.message,
          `${mergeError.details || ''}\nLa fusion a échoué et l’autostash n’a pas pu être restauré. Il reste disponible dans les stashes.\n${restoreError.details || restoreError.message}`.trim(),
        );
      }
      throw mergeError;
    }
  }

  async pendingMergeAutoStash() {
    return this.run(['config', '--local', '--get', 'forkline.autoStash.merge']).then((value) => value.trim()).catch(() => '');
  }

  async clearMergeAutoStash() {
    await this.run(['config', '--local', '--unset-all', 'forkline.autoStash.merge']).catch(() => '');
  }

  async restoreMergeAutoStash(hash, operationOutput = '') {
    const stash = (await this.stashes()).find((entry) => entry.hash === hash);
    if (!stash) {
      await this.clearMergeAutoStash();
      throw new GitError('L’autostash de fusion est introuvable.');
    }

    const stagedPaths = (await this.run(['diff', '--name-only', '-z', `${hash}^1`, `${hash}^2`])).split('\0').filter(Boolean);
    const changedByOperation = new Set((await this.run(['diff', '--name-only', '-z', `${hash}^1`, 'HEAD'])).split('\0').filter(Boolean));
    let restored;
    try {
      restored = await this.runConflictAware(['stash', 'apply', stash.ref]);
      const conflicts = new Set((await this.status()).files.filter((file) => file.conflicted).map((file) => file.path));
      const indexPaths = stagedPaths.filter((file) => !conflicts.has(file) && !changedByOperation.has(file));
      if (indexPaths.length) await this.run(['restore', `--source=${hash}^2`, '--staged', '--', ...indexPaths]);
      if (!restored.conflicted) await this.run(['stash', 'drop', stash.ref]);
    } catch (error) {
      throw new GitError(
        'La fusion est terminée, mais les modifications locales n’ont pas pu être restaurées automatiquement.',
        `L’autostash est conservé sous ${stash.ref}.\n${error.details || error.message}`,
      );
    }
    await this.clearMergeAutoStash();
    return {
      ...restored,
      output: [operationOutput, restored.output].filter(Boolean).join('\n'),
      autoStashRestored: !restored.conflicted,
      autoStashIndexPartiallyRestored: stagedPaths.some((file) => changedByOperation.has(file)),
    };
  }

  async rebaseBranch(name) {
    await this.validateBranchName(name, true);
    return this.runConflictAware(['rebase', name]);
  }

  async fastForwardBranch(name) {
    await this.validateBranchName(name, true);
    return this.runConflictAware(['merge', '--ff-only', name]);
  }

  async cherryPick(revision) {
    await this.validateRevision(revision);
    return this.runConflictAware(['cherry-pick', revision]);
  }

  async revertCommit(revision) {
    await this.validateRevision(revision);
    return this.runConflictAware(['revert', '--no-edit', revision]);
  }

  async resetToCommit(revision, mode = 'mixed') {
    await this.validateRevision(revision);
    if (!['soft', 'mixed', 'hard'].includes(mode)) throw new GitError('Mode de réinitialisation invalide.');
    return this.run(['reset', `--${mode}`, revision]);
  }

  async renameBranch(oldName, newName) {
    await this.validateBranchName(oldName, true);
    const sourceName = oldName.trim();
    await this.run(['rev-parse', '--verify', `refs/heads/${sourceName}`]);
    if (typeof newName === 'string' && sourceName === newName.trim()) throw new GitError('Le nouveau nom doit être différent du nom actuel.');
    const targetName = await this.validateNewBranchName(newName);
    return this.run(['branch', '-m', sourceName, targetName]);
  }

  async deleteBranch(name, force = false) {
    await this.validateBranchName(name, true);
    const current = await this.head();
    if (current === name) throw new GitError('Impossible de supprimer la branche actuellement active.');
    return this.run(['branch', force ? '-D' : '-d', name]);
  }

  async deleteBranchWithRemote(name, upstream) {
    await this.validateBranchName(name, true);
    const current = await this.head();
    if (current === name) throw new GitError('Impossible de supprimer la branche actuellement active.');
    const remotes = (await this.run(['remote'])).split('\n').filter(Boolean).sort((left, right) => right.length - left.length);
    const remote = remotes.find((candidate) => String(upstream).startsWith(`${candidate}/`));
    const remoteBranch = remote ? String(upstream).slice(remote.length + 1) : '';
    if (!remote || !remoteBranch) throw new GitError('Branche distante suivie invalide.');
    if (remoteBranch !== name) throw new GitError(`La branche distante « ${upstream} » ne correspond pas à la branche locale « ${name} » et ne sera pas supprimée.`);
    await this.validateBranchName(remoteBranch, true);
    await this.run(['rev-parse', '--verify', `refs/remotes/${remote}/${remoteBranch}`]);
    await this.run(['push', remote, '--delete', remoteBranch]);
    return this.run(['branch', '-D', name]);
  }

  async setUpstream(branch, remote, remoteBranch) {
    await this.validateBranchName(branch, true);
    if (typeof remote !== 'string' || !remote.trim() || remote.startsWith('-')) throw new GitError('Dépôt distant invalide.');
    const remoteName = remote.trim();
    const remotes = (await this.run(['remote'])).split('\n').filter(Boolean);
    if (!remotes.includes(remoteName)) throw new GitError(`Le dépôt distant « ${remoteName} » n’existe pas.`);
    const branchName = await this.validateRemoteBranchName(remoteBranch);
    const upstream = `${remoteName}/${branchName}`;
    try {
      await this.run(['rev-parse', '--verify', `refs/remotes/${upstream}^{commit}`]);
    } catch {
      throw new GitError(`La branche distante « ${upstream} » n’existe pas. Effectuez un Fetch ou publiez-la avant de la suivre.`);
    }
    return this.run(['branch', `--set-upstream-to=${upstream}`, branch]);
  }

  async checkoutRemoteBranch(remoteBranch, localName = null) {
    if (typeof remoteBranch !== 'string' || !remoteBranch.includes('/') || remoteBranch.startsWith('-') || /[\s\0]/.test(remoteBranch)) throw new GitError('Branche distante invalide.');
    await this.run(['rev-parse', '--verify', `refs/remotes/${remoteBranch}^{commit}`]);
    const targetName = String(localName || remoteBranch.split('/').slice(1).join('/')).trim();
    await this.validateNewBranchName(targetName);
    return this.run(['switch', '-c', targetName, '--track', remoteBranch]);
  }

  async pushBranch(branch, options = {}) {
    await this.validateBranchName(branch, true);
    await this.run(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
    const remotes = (await this.run(['remote'])).split('\n').filter(Boolean);
    const currentUpstream = (await this.run(['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`])).trim();
    const trackedRemote = [...remotes].sort((left, right) => right.length - left.length).find((candidate) => currentUpstream.startsWith(`${candidate}/`));
    const trackedBranch = trackedRemote ? currentUpstream.slice(trackedRemote.length + 1) : '';
    const remote = String(options.remote || '').trim() || trackedRemote || remotes[0];
    if (!remote) throw new GitError('Aucun dépôt distant n’est configuré.');
    if (!remotes.includes(remote)) throw new GitError(`Le dépôt distant « ${remote} » n’existe pas.`);
    const remoteBranch = await this.validateRemoteBranchName(options.remoteBranch || trackedBranch || branch);
    return this.push({ ...options, remote, branch, remoteBranch, setUpstream: true });
  }

  async addRemote(name, url) {
    await this.validateRemoteName(name);
    if (typeof url !== 'string' || !url.trim() || url.startsWith('-') || /[\0\r\n]/.test(url)) throw new GitError('Adresse du dépôt distant invalide.');
    return this.run(['remote', 'add', name.trim(), url.trim()]);
  }

  async renameRemote(oldName, newName) {
    await this.validateRemoteName(oldName);
    await this.validateRemoteName(newName);
    return this.run(['remote', 'rename', oldName.trim(), newName.trim()]);
  }

  async removeRemote(name) {
    await this.validateRemoteName(name);
    return this.run(['remote', 'remove', name.trim()]);
  }

  async fetchRemote(name, prune = false) {
    await this.validateRemoteName(name);
    return this.run(['fetch', ...(prune ? ['--prune'] : []), name.trim()]);
  }

  async compareWithWorktree(revision) {
    await this.validateRevision(revision);
    return this.run(['diff', '--no-ext-diff', '--unified=4', revision]);
  }

  async compareRevisions(fromRevision, toRevision) {
    await this.validateRevision(fromRevision);
    await this.validateRevision(toRevision);
    return this.run(['diff', '--no-ext-diff', '--unified=4', fromRevision, toRevision]);
  }

  async searchHistory(criteria, limit = 100) {
    const filters = typeof criteria === 'string' ? { query: criteria } : (criteria || {});
    const cleanQuery = String(filters.query || '').trim().toLocaleLowerCase('fr');
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const args = ['log', filters.ref || '--all', '--full-history', '--date-order', '--max-count=500'];
    if (filters.ref) await this.validateRevision(filters.ref);
    if (filters.author) {
      const author = String(filters.author).trim();
      if (!author || /[\0\r\n]/.test(author)) throw new GitError('Filtre auteur invalide.');
      args.push(`--author=${author}`);
    }
    for (const [key, flag] of [['after', '--since'], ['before', '--until']]) {
      if (!filters[key]) continue;
      const value = String(filters[key]).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new GitError(`Filtre de date ${key === 'after' ? 'after' : 'before'} invalide.`);
      args.push(`${flag}=${value}`);
    }
    const format = `%H${FIELD}%h${FIELD}%an${FIELD}%ae${FIELD}%aI${FIELD}%cI${FIELD}%P${FIELD}%D${FIELD}%s${RECORD}`;
    args.push(`--pretty=format:${format}`);
    if (filters.file) {
      this.assertSafeRelativePath(String(filters.file));
      args.push('--', String(filters.file));
    }
    const output = await this.run(args);
    const commits = output.split(RECORD).filter((record) => record.trim()).map((record, index) => {
      const [hash, shortHash, author, email, authorDate, committerDate, parents, refs, subject] = record.trim().split(FIELD);
      return { hash, shortHash, author, email, date: authorDate, authorDate, committerDate, parents: parents ? parents.split(' ') : [], refs: refs ? refs.split(',').map((ref) => ref.trim()).filter(Boolean) : [], subject, finalDisplayIndex: index };
    });
    if (!cleanQuery) return commits.slice(0, safeLimit);
    return commits.filter((commit) => [commit.hash, commit.shortHash, commit.subject, commit.author, commit.email]
      .some((value) => String(value || '').toLocaleLowerCase('fr').includes(cleanQuery))).slice(0, safeLimit);
  }

  async fileHistory(filePath, limit = 100) {
    this.assertSafeRelativePath(filePath);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const format = `%H${FIELD}%h${FIELD}%an${FIELD}%ae${FIELD}%aI${FIELD}%cI${FIELD}%P${FIELD}%D${FIELD}%s${RECORD}`;
    const output = await this.run(['log', '--follow', `--max-count=${safeLimit}`, `--pretty=format:${format}`, '--', filePath]);
    return output.split(RECORD).filter((record) => record.trim()).map((record, index) => {
      const [hash, shortHash, author, email, authorDate, committerDate, parents, refs, subject] = record.trim().split(FIELD);
      return { hash, shortHash, author, email, date: authorDate, authorDate, committerDate, parents: parents ? parents.split(' ') : [], refs: refs ? refs.split(',').map((ref) => ref.trim()).filter(Boolean) : [], subject, finalDisplayIndex: index };
    });
  }

  async blame(filePath, revision = 'HEAD') {
    this.assertSafeRelativePath(filePath);
    await this.validateRevision(revision);
    return this.run(['blame', '--date=short', revision, '--', filePath]);
  }

  async commitFiles(revision) {
    await this.validateRevision(revision);
    const output = await this.run(['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', revision]);
    const fields = output.split('\0').filter(Boolean);
    const files = [];
    for (let index = 0; index < fields.length;) {
      const status = fields[index++];
      const originalPath = /^[RC]/.test(status) ? fields[index++] : null;
      const filePath = fields[index++];
      if (filePath) files.push({ status: status[0], path: filePath, originalPath });
    }
    return files;
  }

  async commitFileDiff(revision, filePath) {
    await this.validateRevision(revision);
    this.assertSafeRelativePath(filePath);
    return this.run(['show', '--format=', '--no-ext-diff', '--unified=4', revision, '--', filePath]);
  }

  async commitAnalysisData(revision) {
    await this.validateRevision(revision);
    return this.run(['show', '--first-parent', '--format=fuller', '--no-ext-diff', '--find-renames', '--find-copies', '--stat', '--patch', '--unified=3', revision]);
  }

  async createCommitPatch(revisions) {
    const values = [...new Set(Array.isArray(revisions) ? revisions : [revisions])];
    if (!values.length || values.length > 100) throw new GitError('Sélection de commits invalide pour l’export du patch.');
    for (const revision of values) await this.validateRevision(revision);
    const ordered = [];
    for (const revision of values) {
      let insertionIndex = ordered.length;
      for (let index = 0; index < ordered.length; index += 1) {
        const isAncestor = await this.run(['merge-base', '--is-ancestor', revision, ordered[index]]).then(() => true).catch(() => false);
        if (isAncestor) {
          insertionIndex = index;
          break;
        }
      }
      ordered.splice(insertionIndex, 0, revision);
    }
    const patches = [];
    for (const revision of ordered) patches.push(await this.run(['format-patch', '-1', '--stdout', revision]));
    return patches.join('');
  }

  async applyPatch(patch) {
    if (typeof patch !== 'string' || !patch.trim()) throw new GitError('Le fichier de patch est vide ou invalide.');
    if (Buffer.byteLength(patch, 'utf8') > 20 * 1024 * 1024) throw new GitError('Le fichier de patch dépasse la limite de 20 Mio.');
    if ((await this.operationState())) throw new GitError('Terminez ou abandonnez l’opération Git en cours avant d’appliquer un patch.');
    if ((await this.status()).files.length) throw new GitError('La copie de travail doit être propre avant d’appliquer un patch.');
    try {
      const result = await spawnWithInput('git', ['-C', this.repoPath, 'am', '--3way'], patch, { env: { ...process.env, LC_ALL: 'C.UTF-8', GIT_EDITOR: 'true' } });
      return { output: result.stdout || result.stderr, conflicted: false, conflicts: [] };
    } catch (error) {
      const status = await this.status();
      const conflicts = status.files.filter((file) => file.conflicted).map((file) => file.path);
      if (!conflicts.length) throw new GitError('Impossible d’appliquer ce patch.', String(error.stderr || error.stdout || '').trim());
      return { output: String(error.stderr || error.stdout || '').trim(), conflicted: true, conflicts };
    }
  }

  async createTag(name, revision, message = '') {
    const tagName = await this.validateNewTagName(name);
    await this.validateRevision(revision);
    const cleanMessage = String(message || '').trim();
    return this.run(['tag', ...(cleanMessage ? ['-a', tagName, '-m', cleanMessage] : [tagName]), revision]);
  }

  async deleteTag(name) {
    if (typeof name !== 'string' || !name.trim() || name.startsWith('-')) throw new GitError('Nom de tag invalide.');
    await this.run(['rev-parse', '--verify', `refs/tags/${name.trim()}`]);
    return this.run(['tag', '-d', name.trim()]);
  }

  async pushTag(name, remoteName = null) {
    await this.validateTagName(name, true);
    const remote = remoteName || (await this.run(['remote'])).split('\n').find(Boolean);
    if (!remote) throw new GitError('Aucun dépôt distant n’est configuré.');
    await this.validateRemoteName(remote);
    return this.run(['push', remote, `refs/tags/${name.trim()}`]);
  }

  async deleteRemoteTag(name, remoteName = null) {
    await this.validateTagName(name, true);
    const remote = remoteName || (await this.run(['remote'])).split('\n').find(Boolean);
    if (!remote) throw new GitError('Aucun dépôt distant n’est configuré.');
    await this.validateRemoteName(remote);
    return this.run(['push', remote, '--delete', `refs/tags/${name.trim()}`]);
  }

  async amendHeadMessage(message) {
    const cleanMessage = String(message || '').trim();
    if (!cleanMessage) throw new GitError('Le message du commit est obligatoire.');
    return this.run(['commit', '--amend', '-m', cleanMessage]);
  }

  async interactiveRebasePlan(baseRevision) {
    await this.validateRevision(baseRevision);
    try {
      await this.run(['merge-base', baseRevision, 'HEAD']);
    } catch {
      throw new GitError('La branche active et la référence sélectionnée n’ont aucun historique commun.');
    }
    const format = `%H${FIELD}%h${FIELD}%s${FIELD}%an${FIELD}%aI${RECORD}`;
    const output = await this.run(['log', '--reverse', '--first-parent', `--pretty=format:${format}`, `${baseRevision}..HEAD`]);
    return output.split(RECORD).filter((record) => record.trim()).map((record) => {
      const [hash, shortHash, subject, author, date] = record.trim().split(FIELD);
      return { hash, shortHash, subject, author, date, action: 'pick' };
    });
  }

  async interactiveRebase(baseRevision, plan) {
    const operation = await this.operationState();
    if (operation) throw new GitError(`Impossible de démarrer un rebase pendant : ${operation.label}.`);
    if ((await this.status()).files.length) throw new GitError('La copie de travail doit être propre avant un rebase interactif.');
    const expected = await this.interactiveRebasePlan(baseRevision);
    if (!expected.length) throw new GitError('Aucun commit à rebaser après cette base.');
    if (!Array.isArray(plan) || plan.length !== expected.length) throw new GitError('Le plan de rebase ne correspond pas à l’historique actuel.');
    const expectedHashes = new Set(expected.map((commit) => commit.hash));
    const actions = new Set(['pick', 'reword', 'squash', 'fixup', 'drop']);
    if (new Set(plan.map((entry) => entry.hash)).size !== plan.length || plan.some((entry) => !expectedHashes.has(entry.hash) || !actions.has(entry.action) || (entry.action === 'reword' && !String(entry.message || '').trim()))) {
      throw new GitError('Le plan de rebase contient une action ou un commit invalide.');
    }
    const firstKept = plan.find((entry) => entry.action !== 'drop');
    if (!firstKept || !['pick', 'reword'].includes(firstKept.action)) throw new GitError('Le premier commit conservé doit utiliser l’action pick ou reword.');
    const subjects = new Map(expected.map((commit) => [commit.hash, commit.subject.replace(/[\r\n]+/g, ' ')]));
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forkline-rebase-'));
    const todoPath = path.join(directory, 'todo');
    const editorPath = path.join(directory, 'sequence-editor.sh');
    const messageEditorPath = path.join(directory, 'message-editor.sh');
    const messagesPath = path.join(directory, 'messages');
    const messageIndexPath = path.join(directory, 'message-index');
    await fs.writeFile(todoPath, `${plan.map((entry) => `${entry.action} ${entry.hash} ${subjects.get(entry.hash)}`).join('\n')}\n`, { mode: 0o600 });
    await fs.writeFile(editorPath, '#!/bin/sh\ncp "$FORKLINE_REBASE_TODO" "$1"\n', { mode: 0o700 });
    const messages = plan.filter((entry) => entry.action === 'reword').map((entry) => Buffer.from(String(entry.message).trim(), 'utf8').toString('base64'));
    await fs.writeFile(messagesPath, `${messages.join('\n')}\n`, { mode: 0o600 });
    await fs.writeFile(messageIndexPath, '1\n', { mode: 0o600 });
    await fs.writeFile(messageEditorPath, '#!/bin/sh\nindex=$(cat "$FORKLINE_MESSAGE_INDEX")\nsed -n "${index}p" "$FORKLINE_REBASE_MESSAGES" | base64 -d > "$1"\necho $((index + 1)) > "$FORKLINE_MESSAGE_INDEX"\n', { mode: 0o700 });
    try {
      return await this.runConflictAware(['rebase', '-i', baseRevision], {
        env: { ...process.env, LC_ALL: 'C.UTF-8', GIT_EDITOR: messages.length ? messageEditorPath : 'true', GIT_SEQUENCE_EDITOR: editorPath, FORKLINE_REBASE_TODO: todoPath, FORKLINE_REBASE_MESSAGES: messagesPath, FORKLINE_MESSAGE_INDEX: messageIndexPath },
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  async continueOperation(type, options = {}) {
    const operation = await this.operationState();
    if (!operation || operation.type !== type) throw new GitError('Cette opération Git n’est pas en cours.');
    if ((await this.status()).files.some((file) => file.conflicted)) throw new GitError('Résolvez tous les fichiers en conflit avant de poursuivre.');
    const message = typeof options?.message === 'string' ? options.message.trim() : '';
    if (type === 'merge' && message) {
      return this.runConflictAware(['commit', '-m', message], {
        env: { ...process.env, LC_ALL: 'C.UTF-8', GIT_EDITOR: 'true' },
      });
    }
    const commands = {
      merge: ['merge', '--continue'],
      rebase: ['rebase', '--continue'],
      am: ['am', '--continue'],
      'cherry-pick': ['cherry-pick', '--continue'],
      revert: ['revert', '--continue'],
    };
    const autoStashHash = type === 'merge' ? await this.pendingMergeAutoStash() : '';
    const continued = await this.runConflictAware(commands[type], {
      env: { ...process.env, LC_ALL: 'C.UTF-8', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
    });
    if (continued.conflicted || !autoStashHash) return continued;
    return this.restoreMergeAutoStash(autoStashHash, continued.output);
  }

  async abortOperation(type) {
    const operation = await this.operationState();
    if (!operation || operation.type !== type) throw new GitError('Cette opération Git n’est pas en cours.');
    const commands = {
      merge: ['merge', '--abort'],
      rebase: ['rebase', '--abort'],
      am: ['am', '--abort'],
      'cherry-pick': ['cherry-pick', '--abort'],
      revert: ['revert', '--abort'],
    };
    const autoStashHash = type === 'merge' ? await this.pendingMergeAutoStash() : '';
    const output = await this.run(commands[type]);
    if (!autoStashHash) return { output, conflicted: false, conflicts: [] };
    return this.restoreMergeAutoStash(autoStashHash, output);
  }

  async runConflictAware(args, options = {}) {
    try {
      const output = await this.run(args, options);
      return { output, conflicted: false, conflicts: [] };
    } catch (error) {
      const status = await this.status();
      const conflicts = status.files.filter((file) => file.conflicted).map((file) => file.path);
      if (!conflicts.length) throw error;
      return { output: error.details || error.message, conflicted: true, conflicts };
    }
  }

  async validateRevision(revision) {
    if (typeof revision !== 'string' || !revision.trim() || revision.startsWith('-') || /[\s\0]/.test(revision)) {
      throw new GitError('Révision Git invalide.');
    }
    await this.run(['rev-parse', '--verify', `${revision}^{commit}`]);
    return revision;
  }

  async validateRemoteName(name) {
    if (typeof name !== 'string' || !name.trim() || name.startsWith('-') || /[\s\0]/.test(name)) throw new GitError('Nom de dépôt distant invalide.');
    await this.run(['check-ref-format', `refs/remotes/${name.trim()}/validation`]);
    return name.trim();
  }

  async validateTagName(name, requireExisting = false) {
    if (typeof name !== 'string' || !name.trim() || name.startsWith('-')) throw new GitError('Nom de tag invalide.');
    if (requireExisting) await this.run(['rev-parse', '--verify', `refs/tags/${name.trim()}`]);
    else {
      try {
        await this.run(['check-ref-format', `refs/tags/${name.trim()}`]);
      } catch {
        throw new GitError('Nom de tag invalide.');
      }
    }
    return name.trim();
  }

  async validateNewTagName(name) {
    const tagName = await this.validateTagName(name, false);
    const existingRefs = await this.run(['for-each-ref', '--format=%(refname)', `refs/tags/${tagName}`]);
    if (existingRefs.split('\n').includes(`refs/tags/${tagName}`)) throw new GitError(`Le tag « ${tagName} » existe déjà.`);
    return tagName;
  }

  async validateBranchName(name, allowExisting) {
    if (typeof name !== 'string' || !name.trim() || name.startsWith('-')) {
      throw new GitError('Nom de branche invalide.');
    }
    if (!allowExisting) {
      await this.run(['check-ref-format', '--branch', name.trim()]);
    }
  }

  async validateNewBranchName(name) {
    if (typeof name !== 'string' || !name.trim() || name.startsWith('-')) throw new GitError('Nom de branche invalide.');
    const branchName = name.trim();
    try {
      await execFileAsync('git', ['check-ref-format', '--branch', branchName], { encoding: 'utf8' });
    } catch {
      throw new GitError('Nom de branche invalide.');
    }
    if (this.repoPath) {
      const existingRefs = await this.run(['for-each-ref', '--format=%(refname)', `refs/heads/${branchName}`]);
      if (existingRefs.split('\n').includes(`refs/heads/${branchName}`)) {
        throw new GitError(`La branche « ${branchName} » existe déjà.`);
      }
    }
    return branchName;
  }

  async validateRemoteBranchName(name) {
    if (typeof name !== 'string' || !name.trim() || name.startsWith('-')) throw new GitError('Nom de branche distante invalide.');
    const branchName = name.trim();
    try {
      await this.run(['check-ref-format', `refs/heads/${branchName}`]);
    } catch {
      throw new GitError('Nom de branche distante invalide.');
    }
    return branchName;
  }

  async fetch() { return this.run(['fetch', '--all', '--prune']); }

  async pull(options = {}) {
    const strategy = options.strategy || 'ff-only';
    if (!['ff-only', 'rebase', 'merge'].includes(strategy)) throw new GitError('Stratégie de pull invalide.');
    const args = ['pull'];
    if (strategy === 'ff-only') args.push('--ff-only');
    else if (strategy === 'rebase') args.push('--rebase');
    else args.push('--no-rebase');
    if (options.remote) {
      await this.validateRemoteName(options.remote);
      args.push(options.remote);
      if (options.branch) {
        await this.validateBranchName(options.branch, true);
        args.push(options.branch);
      }
    }
    return this.runConflictAware(args);
  }

  async push(options = {}) {
    const args = ['push'];
    if (options.forceWithLease) args.push('--force-with-lease');
    if (options.tags) args.push('--tags');
    if (options.setUpstream) args.push('--set-upstream');
    if (options.remote) {
      await this.validateRemoteName(options.remote);
      args.push(options.remote);
      if (options.branch) {
        await this.validateBranchName(options.branch, true);
        if (options.remoteBranch) {
          const remoteBranch = await this.validateRemoteBranchName(options.remoteBranch);
          args.push(`${options.branch}:${remoteBranch}`);
        } else args.push(options.branch);
      }
    }
    return this.run(args);
  }
}

module.exports = { GitService, GitError, parseTrackingStatus };
