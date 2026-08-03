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

  // ---------- 重置 XIAOMI MIMO 累计预算 ----------
  resetMimoBudget: (vendorId) => ipcRenderer.invoke('reset-mimo-budget', vendorId),

  // ---------- DeepSeek 用量页面监听器（支持 vendorId 隔离多账号） ----------
  getMonitorStatus: (vendorId) => ipcRenderer.invoke('get-monitor-status', vendorId),
  getMonitorLoginStatus: (vendorId) => ipcRenderer.invoke('get-monitor-login-status', vendorId),
  showLoginWindow: (vendorId) => ipcRenderer.invoke('show-login-window', vendorId),
  refreshMonitor: (vendorId) => ipcRenderer.invoke('refresh-monitor', vendorId),
  refreshMonitorNow: (vendorId) => ipcRenderer.invoke('refresh-monitor-now', vendorId),
  onMonitorLoginStatusChanged: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('monitor-login-status-changed', handler)
    return () => ipcRenderer.removeListener('monitor-login-status-changed', handler)
  },
  // 统一手动刷新：页面刷新 + 余额采集
  unifiedRefresh: () => ipcRenderer.invoke('unified-refresh'),
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
  getChangelog: () => ipcRenderer.invoke('get-changelog'),
  getInstallType: () => ipcRenderer.invoke('get-install-type'),
  downloadUpdate: (url) => ipcRenderer.invoke('download-update', url),
  installUpdate: (filePath) => ipcRenderer.invoke('install-update', filePath),
  onUpdateDownloadProgress: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('update-download-progress', handler)
    return () => ipcRenderer.removeListener('update-download-progress', handler)
  },

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
