const { contextBridge } = require('electron')

// 不暴露任何东西，但必须存在以保证上下文隔离生效
contextBridge.exposeInMainWorld('electronAPI', {})