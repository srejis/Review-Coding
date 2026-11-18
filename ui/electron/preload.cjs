const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('reviewDesktop', {
  openDetail: identity => ipcRenderer.invoke('review:detail', identity),
  openManagement: identity => ipcRenderer.invoke('review:manage', identity),
  pickFolder: () => ipcRenderer.invoke('review:folder'),
  login: account => ipcRenderer.invoke('review:login', account)
})
