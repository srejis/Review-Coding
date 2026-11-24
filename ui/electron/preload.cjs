const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('reviewDesktop', {
  openDetail: identity => ipcRenderer.invoke('review:detail', identity),
  openManagement: identity => ipcRenderer.invoke('review:manage', identity),
  pickFolder: () => ipcRenderer.invoke('review:folder'),
  login: account => ipcRenderer.invoke('review:login', account),
  openSettings: () => ipcRenderer.invoke('review:settings'),
  openProgress: (revision, profile, unit) => ipcRenderer.invoke('review:progress', revision, profile, unit),
  openProjects: () => ipcRenderer.invoke('review:projects'),
  focusGraph: () => ipcRenderer.invoke('review:focus-graph'),
  deleteProject: project => ipcRenderer.invoke('review:delete-project', project),
  openReview: value => ipcRenderer.invoke('review:analysis-review', value),
  preferences: () => ipcRenderer.invoke('review:preferences'),
  onPreferences: listener => {
    const handle = (_, value) => listener(value)
    ipcRenderer.on('review:preferences-changed', handle)
    return () => ipcRenderer.removeListener('review:preferences-changed', handle)
  },
  savePreferences: value => ipcRenderer.invoke('review:save-preferences', value),
  loadLayout: scope => ipcRenderer.invoke('review:load-layout', scope),
  saveLayout: (scope, cache) => ipcRenderer.invoke('review:save-layout', scope, cache)
})
