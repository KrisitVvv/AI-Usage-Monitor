const { contextBridge, ipcRenderer } = require('electron')

// ============================================================
//  Electron IPC 桥接
//  contextIsolation: true 下，这里声明的所有 API
//  通过 contextBridge 暴露到 main world 供 Vue 应用使用
// ============================================================

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  setAutoLaunch: (value) => ipcRenderer.send('set-auto-launch', value),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  onWindowStateChanged: (callback) => {
    const handler = (_event, isMaximized) => callback(isMaximized)
    ipcRenderer.on('window-state-changed', handler)
    return () => ipcRenderer.removeListener('window-state-changed', handler)
  },

  // ---------- 供应商数据存储 ----------
  getVendors: () => ipcRenderer.invoke('get-vendors'),
  saveVendor: (vendorData) => ipcRenderer.invoke('save-vendor', vendorData),
  renameVendor: (vendorId, newName) => ipcRenderer.invoke('rename-vendor', vendorId, newName),
  deleteVendor: (vendorId) => ipcRenderer.invoke('delete-vendor', vendorId),

  // ---------- 实时用量数据 ----------
  getUsageData: () => ipcRenderer.invoke('get-usage-data'),
  onUsageDataUpdated: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('usage-data-updated', handler)
    return () => ipcRenderer.removeListener('usage-data-updated', handler)
  },

  // ---------- Token 用量统计 ----------
  getTokenStats: () => ipcRenderer.invoke('get-token-stats'),
  onTokenStatsUpdated: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('token-stats-updated', handler)
    return () => ipcRenderer.removeListener('token-stats-updated', handler)
  },

  // ---------- 重置 DeepSeek 累计充值 ----------
  resetDeepSeekBudget: () => ipcRenderer.invoke('reset-deepseek-budget'),

  // ---------- DeepSeek 用量页面监听器 ----------
  getMonitorStatus: () => ipcRenderer.invoke('get-monitor-status'),
  getMonitorLoginStatus: () => ipcRenderer.invoke('get-monitor-login-status'),
  showLoginWindow: () => ipcRenderer.invoke('show-login-window'),
  refreshMonitor: () => ipcRenderer.invoke('refresh-monitor'),
  refreshMonitorNow: () => ipcRenderer.invoke('refresh-monitor-now'),
  onDeepSeekData: (payload) => ipcRenderer.send('deepseek-monitor-data', payload),

  // ---------- 开机自启动 ----------
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enable) => ipcRenderer.invoke('set-auto-launch', enable),

  // ---------- 缩小到系统托盘 ----------
  getMinimizeToTray: () => ipcRenderer.invoke('get-minimize-to-tray'),
  setMinimizeToTray: (enable) => ipcRenderer.invoke('set-minimize-to-tray', enable),

  // ---------- 打开外部链接 ----------
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // ---------- 检查更新 ----------
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // ---------- 缓存管理 ----------
  getCacheSize: () => ipcRenderer.invoke('get-cache-size'),
  clearCache: () => ipcRenderer.invoke('clear-cache'),

  // ---------- 供 main world 拦截脚本调用的记录接口 ----------
  // 由 main.js 注入的 fetch/XHR 拦截器在检测到
  // DeepSeek Chat API 响应中的 usage 字段后调用此方法
  recordDeepSeekUsage: (payload) => {
    ipcRenderer.send('deepseek-usage-record', payload)
  }
})
