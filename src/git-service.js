const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');

const execFileAsync = promisify(execFile);
const FIELD = '\x1f';
const RECORD = '\x1e';

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

  async snapshot() {
    let [status, commits, branches, remotes, head, headHash, repository] = await Promise.all([
      this.worktreeStatus(),
      this.commits(),
      this.branches(),
      this.remotes(),
      this.head(),
      this.headHash(),
      this.run(['rev-parse', '--show-toplevel']).then((value) => value.trim()),
    ]);
    const orderDebug = await this.commitOrderDebug(commits);

    return { repository, head, headHash, status, commits, branches, remotes, orderDebug };
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
    const output = await this.run(['status', '--porcelain=v1', '-z', '--branch']);
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
      };
    });

    const ahead = Number(branchLine.match(/ahead (\d+)/)?.[1] || 0);
    const behind = Number(branchLine.match(/behind (\d+)/)?.[1] || 0);
    return { files, ahead, behind };
  }

  async worktreeStatus() {
    let status = await this.status();
    const mixedFiles = status.files.filter((file) => file.staged && file.workingTree !== ' ' && !file.untracked).map((file) => file.path);
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
      'log', '--all', '--date-order', `--max-count=${limit}`, `--pretty=format:${format}`,
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
      await execFileAsync('git', ['-C', this.repoPath, 'apply', ...(staged ? ['--cached'] : []), ...(reverse ? ['--reverse'] : [])], {
        input: patch,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C.UTF-8' },
      });
    } catch (error) {
      const details = String(error.stderr || error.stdout || '').trim();
      throw new GitError(frenchGitError(details, 'Impossible d’appliquer ce hunk.'), details);
    }
    return true;
  }

  assertFileList(files) {
    if (!Array.isArray(files) || files.length === 0) throw new GitError('Aucun fichier sélectionné.');
    files.forEach((file) => this.assertSafeRelativePath(file));
  }

  async commit(message) {
    const cleanMessage = String(message || '').trim();
    if (!cleanMessage) throw new GitError('Le message de commit est obligatoire.');
    return this.run(['commit', '-m', cleanMessage]);
  }

  async switchBranch(name) {
    await this.validateBranchName(name, true);
    return this.run(['switch', name]);
  }

  async createBranch(name) {
    await this.validateBranchName(name, false);
    return this.run(['switch', '-c', name]);
  }

  async validateBranchName(name, allowExisting) {
    if (typeof name !== 'string' || !name.trim() || name.startsWith('-')) {
      throw new GitError('Nom de branche invalide.');
    }
    if (!allowExisting) {
      await this.run(['check-ref-format', '--branch', name.trim()]);
    }
  }

  async fetch() { return this.run(['fetch', '--all', '--prune']); }
  async pull() { return this.run(['pull', '--ff-only']); }
  async push() { return this.run(['push']); }
}

module.exports = { GitService, GitError, parseTrackingStatus };
