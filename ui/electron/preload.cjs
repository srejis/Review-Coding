const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('reviewDesktop', {
  openDetail: identity => ipcRenderer.invoke('review:detail', identity),
  openManagement: identity => ipcRenderer.invoke('review:manage', identity),
  pickFolder: () => ipcRenderer.invoke('review:folder'),
  login: account => ipcRenderer.invoke('review:login', account),
  openSettings: () => ipcRenderer.invoke('review:settings'),
  openProgress: revision => ipcRenderer.invoke('review:progress', revision),
  preferences: () => ipcRenderer.invoke('review:preferences'),
  savePreferences: value => ipcRenderer.invoke('review:save-preferences', value),
  loadLayout: scope => ipcRenderer.invoke('review:load-layout', scope),
  saveLayout: (scope, cache) => ipcRenderer.invoke('review:save-layout', scope, cache)
})
