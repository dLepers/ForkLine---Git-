const fs = require('node:fs');
const path = require('node:path');

class RepositoryWatcher {
  constructor(git, publish, options = {}) {
    this.git = git;
    this.publish = publish;
    this.debounceMs = options.debounceMs || 120;
    this.pollMs = options.pollMs || 500;
    this.watchers = [];
    this.repository = null;
    this.fingerprint = null;
    this.debounceTimer = null;
    this.pollTimer = null;
    this.refreshPromise = null;
    this.refreshPending = false;
    this.mutationDepth = 0;
    this.revision = 0;
  }

  async start(repository, initialSnapshot = null) {
    this.stop();
    this.repository = repository;
    this.fingerprint = await this.readFingerprint();
    if (initialSnapshot) initialSnapshot.repositoryRevision = ++this.revision;

    this.watchPath(repository);
    this.watchPath(path.join(repository, '.git'));
    this.pollTimer = setInterval(() => this.poll(), this.pollMs);
    return initialSnapshot;
  }

  stop() {
    this.watchers.forEach((watcher) => watcher.close());
    this.watchers = [];
    clearTimeout(this.debounceTimer);
    clearInterval(this.pollTimer);
    this.debounceTimer = null;
    this.pollTimer = null;
    this.repository = null;
    this.fingerprint = null;
    this.refreshPending = false;
  }

  watchPath(target) {
    try {
      const watcher = fs.watch(target, { recursive: true }, (_event, filename = '') => {
        if (String(filename).includes('node_modules')) return;
        this.schedule();
      });
      watcher.on('error', () => {});
      this.watchers.push(watcher);
    } catch {
      // The fingerprint poll covers platforms without recursive fs.watch.
    }
  }

  schedule() {
    if (this.mutationDepth) {
      this.refreshPending = true;
      return;
    }
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.refreshIfChanged(), this.debounceMs);
  }

  async poll() {
    if (!this.repository || this.refreshPromise || this.mutationDepth) return;
    await this.refreshIfChanged();
  }

  async refreshIfChanged() {
    if (!this.repository || this.refreshPromise || this.mutationDepth) return null;
    try {
      const fingerprint = await this.readFingerprint();
      if (fingerprint !== this.fingerprint) return this.refresh();
    } catch {
      // A transient lock during rebase/checkout will be retried on the next poll.
    }
    return null;
  }

  async readFingerprint() {
    const [status, refs] = await Promise.all([
      this.git.run(['status', '--porcelain=v1', '-z', '--branch']),
      this.git.run(['show-ref', '--head']).catch(() => ''),
    ]);
    return `${status}\x1e${refs}`;
  }

  async refresh() {
    if (!this.repository) return null;
    if (this.refreshPromise) {
      this.refreshPending = true;
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      const snapshot = await this.git.snapshot();
      snapshot.repositoryRevision = ++this.revision;
      this.fingerprint = await this.readFingerprint();
      this.publish(snapshot);
      return snapshot;
    })();

    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
      if (this.refreshPending && !this.mutationDepth) {
        this.refreshPending = false;
        this.schedule();
      }
    }
  }

  async mutate(callback) {
    this.mutationDepth += 1;
    try {
      const output = await callback();
      const snapshot = await this.refresh();
      return { output, snapshot };
    } finally {
      this.mutationDepth -= 1;
      this.refreshPending = false;
    }
  }
}

module.exports = { RepositoryWatcher };
