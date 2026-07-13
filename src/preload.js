const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('forkline', {
  debugGraphLayout: process.env.DEBUG_GRAPH_LAYOUT === '1',
  chooseRepository: () => invoke('repository:choose'),
  restoreRepository: () => invoke('repository:restore'),
  refresh: () => invoke('repository:refresh'),
  diff: (file, staged) => invoke('repository:diff', file, staged),
  stage: (files) => invoke('repository:stage', files),
  unstage: (files) => invoke('repository:unstage', files),
  commit: (message) => invoke('repository:commit', message),
  switchBranch: (name) => invoke('repository:switch', name),
  createBranch: (name) => invoke('repository:create-branch', name),
  fetch: () => invoke('repository:fetch'),
  pull: () => invoke('repository:pull'),
  push: () => invoke('repository:push'),
  onRepositoryChanged: (callback) => ipcRenderer.on('repository:changed', callback),
});
