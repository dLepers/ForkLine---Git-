const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { GitService } = require('./git-service');
const { RepositoryWatcher } = require('./repository-watcher');

const git = new GitService();
let mainWindow;
const repositoryWatcher = new RepositoryWatcher(git, (snapshot) => {
  BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('repository:updated', snapshot));
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

async function rememberRepository(repository) {
  const configPath = path.join(app.getPath('userData'), 'state.json');
  await fs.writeFile(configPath, JSON.stringify({ lastRepository: repository }, null, 2));
}

async function readRememberedRepository() {
  const configPath = path.join(app.getPath('userData'), 'state.json');
  try {
    return JSON.parse(await fs.readFile(configPath, 'utf8')).lastRepository || null;
  } catch {
    return null;
  }
}

async function openRepository(repository) {
  const root = await git.open(repository);
  await rememberRepository(root);
  const snapshot = await git.snapshot();
  return repositoryWatcher.start(root, snapshot);
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
  handle('repository:restore', async () => {
    const repository = await readRememberedRepository();
    return repository ? openRepository(repository) : null;
  });
  handle('repository:refresh', () => repositoryWatcher.refresh());
  handle('repository:diff', (file, staged) => git.diff(file, staged));
  handle('repository:stage', async (files) => (await repositoryWatcher.mutate(() => git.stage(files))).snapshot);
  handle('repository:unstage', async (files) => (await repositoryWatcher.mutate(() => git.unstage(files))).snapshot);
  handle('repository:apply-hunk', async (patch, staged, reverse) => (await repositoryWatcher.mutate(() => git.applyHunk(patch, staged, reverse))).snapshot);
  handle('repository:commit', async (message) => repositoryWatcher.mutate(() => git.commit(message)));
  handle('repository:switch', async (name) => (await repositoryWatcher.mutate(() => git.switchBranch(name))).snapshot);
  handle('repository:create-branch', async (name) => (await repositoryWatcher.mutate(() => git.createBranch(name))).snapshot);
  handle('repository:fetch', async () => repositoryWatcher.mutate(() => git.fetch()));
  handle('repository:pull', async () => repositoryWatcher.mutate(() => git.pull()));
  handle('repository:push', async () => repositoryWatcher.mutate(() => git.push()));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  repositoryWatcher.stop();
  if (process.platform !== 'darwin') app.quit();
});
