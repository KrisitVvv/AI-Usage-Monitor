const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  setAutoLaunch: (value) => ipcRenderer.send('set-auto-launch', value),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  onWindowStateChanged: (callback) => {
    const handler = (_event, isMaximized) => callback(isMaximized)
    ipcRenderer.on('window-state-changed', handler)
    // 返回取消监听的函数
    return () => ipcRenderer.removeListener('window-state-changed', handler)
  }
})