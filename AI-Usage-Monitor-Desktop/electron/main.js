const { app, BrowserWindow, ipcMain, session, Tray, Menu, nativeImage, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const https = require('https')
const { spawn } = require('child_process')
const { DeepSeekMonitor } = require('./deepseek-monitor')
const { KimiMonitor } = require('./kimi-monitor')
const MimoMonitor = require('./mimo-monitor')
const { collectAll, recordTokenUsage, getTokenStats, resetDeepSeekBudget, resetMimoBudget, flushTokenStats, loadTokenStats, reloadTokenStats, recordHourlySnapshot, getPrevModelTokens } = require('./usage-collector')
const Scheduler = require('./scheduler')

// ===== 模型名校验 =====
// DOM/表格解析出的模型名可能混入错误内容（如 42096136s / 42096136 / undefined），
// 这些"模型"不是真实模型，记录前统一过滤，避免污染统计数据。
const INVALID_MODEL_NAME_PATTERNS = [
  /error/i, /fail/i, /invalid/i, /undefined/i, /null/i,
  /^[\s\-_]+$/,               // 纯空白或特殊字符
  /<[^>]+>/,                  // HTML 标签
  /^\d+$/,                    // 纯数字（token 数值被读成模型名）
  /^\d+[a-zA-Z]$/,            // 数字+单个字母拼接残留（42096136s）
  /总消耗|总体消费|总用量|单模型|模型消费|消费总金额|请求次数|插件调用|调用次数|暂无数据|小计|合计|条记录|下一页|上一页|加载中|今日|昨日|日期为|UTC/
]

function isValidModelName(name) {
  if (!name || typeof name !== 'string') return false
  if (name.length > 40) return false
  if (!/[a-zA-Z0-9]/.test(name)) return false
  return !INVALID_MODEL_NAME_PATTERNS.some(p => p.test(name))
}

// ===== 语义化版本比较工具 =====
// 解析 "v1.2.3" / "1.2.3" / "1.2.3-beta.1" 等版本号
function parseVersion(version) {
  const str = String(version || '').trim().replace(/^v/i, '')
  const match = str.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/)
  if (!match) return null
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || ''
  }
}

function comparePrerelease(a, b) {
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const sa = pa[i]
    const sb = pb[i]
    if (sa === undefined) return -1
    if (sb === undefined) return 1
    if (sa === sb) continue
    const na = parseInt(sa, 10)
    const nb = parseInt(sb, 10)
    const isNa = /^\d+$/.test(sa)
    const isNb = /^\d+$/.test(sb)
    if (isNa && isNb) return na > nb ? 1 : -1
    if (isNa) return -1
    if (isNb) return 1
    return sa > sb ? 1 : -1
  }
  return 0
}

// v1 > v2 返回 1，v1 < v2 返回 -1，相等返回 0
function compareVersions(v1, v2) {
  const a = parseVersion(v1)
  const b = parseVersion(v2)
  if (!a || !b) return String(v1).localeCompare(String(v2)) // 解析失败兜底
  if (a.major !== b.major) return a.major > b.major ? 1 : -1
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1
  return comparePrerelease(a.prerelease, b.prerelease)
}

// 设置应用名称（影响开机自启动注册表条目名称等）
app.name = 'AI Usage Monitor'

// ===== 更新下载与安装工具 =====

// 判断当前运行的是安装版还是免安装版
// electron-builder 的 portable 版运行时设置了 PORTABLE_EXECUTABLE_DIR 环境变量
// 开发模式下（electron . 无该变量）可通过 --portable 参数强制模拟免安装版
function getInstallType() {
  if (process.argv.includes('--portable')) return 'portable'
  return process.env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'installer'
}

// 从 Release 资产中匹配当前安装类型对应的安装包
// 命名约定：含 "Setup" 的 .exe 为安装版，不含的 .exe 为免安装版
function matchUpdateAsset(assets, installType) {
  const exeAssets = assets.filter(a => /\.exe$/i.test(a.name))
  if (installType === 'installer') {
    return exeAssets.find(a => /setup/i.test(a.name)) || exeAssets[0] || null
  }
  return exeAssets.find(a => !/setup/i.test(a.name)) || exeAssets[0] || null
}

// 流式下载文件（支持 GitHub 302 重定向），并上报下载进度
function downloadFileWithProgress(url, savePath, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('重定向次数过多'))
      return
    }
    const req = https.get(url, { headers: { 'User-Agent': 'AI-Usage-Monitor' } }, (res) => {
      // 收到响应后清除空闲超时，避免大文件下载被误判
      req.setTimeout(0)

      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const location = res.headers.location
        res.resume()
        if (!location) {
          reject(new Error('重定向地址缺失'))
          return
        }
        resolve(downloadFileWithProgress(location, savePath, onProgress, redirects + 1))
        return
      }
      if (res.statusCode >= 400) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      const total = parseInt(res.headers['content-length'] || '0', 10)
      let received = 0
      const file = fs.createWriteStream(savePath)
      res.on('data', (chunk) => {
        received += chunk.length
        onProgress(received, total)
      })
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve(savePath)))
      file.on('error', (err) => {
        try { fs.unlinkSync(savePath) } catch { /* 忽略 */ }
        reject(err)
      })
      res.on('error', (err) => {
        try { fs.unlinkSync(savePath) } catch { /* 忽略 */ }
        reject(err)
      })
    })

    // 30 秒内无数据则判定为网络阻塞，中断下载并给出可操作提示
    req.setTimeout(30000, () => {
      req.destroy(new Error('下载超时（长时间无数据），请检查网络连接后重试'))
    })
    req.on('error', reject)
  })
}

let mainWindow = null
const scheduler = new Scheduler()
const dsMonitors = new Map() // vendorId → DeepSeekMonitor
const kmiMonitors = new Map() // vendorId → KimiMonitor
const mimoMonitors = new Map() // vendorId → MimoMonitor

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 700,
    minWidth: 600,
    minHeight: 420,
    frame: false,
    icon: path.join(__dirname, '..', 'public', 'square_logo.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true, 
      preload: path.join(__dirname, 'preload.js') 
    }
  })

  // 监听窗口原生最大化/还原事件，同步状态到渲染进程
  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window-state-changed', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window-state-changed', false)
  })

  if (app.isPackaged) {
    // 打包后加载构建产物
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  } else {
    // 开发模式下加载 Vite 服务器（动态端口）
    const vitePort = process.env.VITE_PORT || 5173
    mainWindow.loadURL(`http://localhost:${vitePort}`)
  }

  // 可选：打开 DevTools
   //mainWindow.webContents.openDevTools()
}

const VENDORS_FILE = path.join(app.getPath('userData'), 'vendors.json')
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json')

// 系统托盘实例
let tray = null

// 读取设置
function readSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return { minimizeToTray: true }
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return { minimizeToTray: true }
  }
}

// 写入设置
function writeSettings(settings) {
  const dir = path.dirname(SETTINGS_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8')
}

// 创建系统托盘
function createTray() {
  const iconPath = path.join(__dirname, '..', 'public', 'square_logo.png')
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip('AI Usage Monitor')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show()
          mainWindow.focus()
        }
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)

  // 左键点击显示窗口
  tray.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

function readVendors() {
  try {
    if (!fs.existsSync(VENDORS_FILE)) return []
    const raw = fs.readFileSync(VENDORS_FILE, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return []
  }
}

function writeVendors(vendors) {
  const dir = path.dirname(VENDORS_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(VENDORS_FILE, JSON.stringify(vendors, null, 2), 'utf-8')
}

app.whenReady().then(() => {
  loadTokenStats()
  createWindow()
  createTray()

  // 初始化统一调度器
  scheduler.init({
    collectFn: () => collectAll(getKimiMonitorLoginMap()),
    onDataFn: (channel, data) => mainWindow?.webContents.send(channel, data)
  })
  scheduler.startBalancePolling()
  scheduler.startPageRefreshPolling()

  // MIMO 余额30秒轮询（与 DeepSeek/Kimi 保持一致）
  setInterval(() => {
    for (const [, monitor] of mimoMonitors) {
      monitor.refreshBalanceOnly().catch(() => {})
    }
  }, 30000)

  ipcMain.on('window-minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.on('window-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win?.isMaximized()) {
      win.unmaximize()
    } else {
      win?.maximize()
    }
  })
  ipcMain.on('window-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    const settings = readSettings()
    if (settings.minimizeToTray) {
      win.hide()
    } else {
      win.close()
    }
  })

  // 供应商数据存储 IPC
  ipcMain.handle('get-vendors', () => readVendors())

  ipcMain.handle('save-vendor', (_event, vendorData) => {
    // 数据验证（部分供应商无需 API 密钥，如 XIAOMI MIMO）
    if (!vendorData.provider) throw new Error('供应商不能为空')
    if (!vendorData.billingModel) throw new Error('计费模式不能为空')

    const vendors = readVendors()
    const newVendor = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      provider: vendorData.provider,
      billingModel: vendorData.billingModel,
      apiKey: (vendorData.apiKey || '').trim(),
      createdAt: new Date().toISOString()
    }
    vendors.push(newVendor)
    writeVendors(vendors)

    // 新增供应商后立即触发一次采集
    scheduler.collectBalance()

    // 如果是 DeepSeek / Kimi / XIAOMI MIMO 供应商，确保监听器已启动
    const prov = (newVendor.provider || '').toLowerCase()
    if (prov.includes('deepseek') || prov.includes('kimi') || prov.includes('mimo')) {
      ensureMonitors()
    }

    return { success: true, vendor: newVendor }
  })

  ipcMain.handle('rename-vendor', (_event, vendorId, newName) => {
    if (!vendorId || !newName || !newName.trim()) throw new Error('参数无效')
    const vendors = readVendors()
    const v = vendors.find(v => v.id === vendorId)
    if (!v) throw new Error('供应商不存在')
    v.customName = newName.trim()
    writeVendors(vendors)

    // 立即推送更新到前端，不等待采集周期
    try {
      const { readCache } = require('./usage-collector')
      const cache = readCache()
      if (cache) {
        cache.vendors = vendors
        mainWindow?.webContents.send('usage-data-updated', cache)
      }
    } catch { /* 忽略 */ }

    return { success: true }
  })

  ipcMain.handle('delete-vendor', async (_event, vendorId) => {
    if (!vendorId) throw new Error('供应商 ID 不能为空')
    const vendors = readVendors()
    const idx = vendors.findIndex(v => v.id === vendorId)
    if (idx === -1) throw new Error('供应商不存在')
    const deletedVendor = vendors[idx]
    vendors.splice(idx, 1)
    writeVendors(vendors)

    // 如果是 DeepSeek 供应商，清理对应的监控实例和浏览器 session
    if ((deletedVendor.provider || '').toLowerCase().includes('deepseek')) {
      const monitor = dsMonitors.get(vendorId)
      if (monitor) {
        monitor.stop()
        dsMonitors.delete(vendorId)
        scheduler.unregisterMonitor(vendorId)
        console.log(`[Main] 已停止并移除供应商 ${vendorId} 的 DeepSeek 监控实例`)
      }
      // 清除对应的浏览器 session（cookie/localStorage 等）
      try {
        const { session } = require('electron')
        const ses = session.fromPartition(`persist:deepseek-${vendorId}`)
        await ses.clearStorageData({
          storages: ['cookies', 'localstorage', 'caches', 'serviceworkers']
        })
        console.log(`[Main] 已清除供应商 ${vendorId} 的浏览器 session 数据`)
      } catch (e) {
        console.warn(`[Main] 清除 session 失败:`, e.message)
      }
    }

    // 如果是 Kimi 供应商，清理对应的监控实例和浏览器 session
    if ((deletedVendor.provider || '').toLowerCase().includes('kimi')) {
      const monitor = kmiMonitors.get(vendorId)
      if (monitor) {
        monitor.stop()
        kmiMonitors.delete(vendorId)
        scheduler.unregisterMonitor(vendorId)
        console.log(`[Main] 已停止并移除供应商 ${vendorId} 的 Kimi 监控实例`)
      }
      try {
        const { session } = require('electron')
        const ses = session.fromPartition(`persist:kimi-${vendorId}`)
        await ses.clearStorageData({
          storages: ['cookies', 'localstorage', 'caches', 'serviceworkers']
        })
        console.log(`[Main] 已清除供应商 ${vendorId} 的 Kimi session 数据`)
      } catch (e) {
        console.warn(`[Main] 清除 Kimi session 失败:`, e.message)
      }
    }

    // 如果是 XIAOMI MIMO 供应商，清理对应的监控实例和浏览器 session
    if ((deletedVendor.provider || '').toLowerCase().includes('mimo')) {
      const monitor = mimoMonitors.get(vendorId)
      if (monitor) {
        monitor.stop()
        mimoMonitors.delete(vendorId)
        scheduler.unregisterMonitor(vendorId)
        console.log(`[Main] 已停止并移除供应商 ${vendorId} 的 MIMO 监控实例`)
      }
      try {
        const { session } = require('electron')
        const ses = session.fromPartition(`persist:mimo-${vendorId}`)
        await ses.clearStorageData({
          storages: ['cookies', 'localstorage', 'caches', 'serviceworkers']
        })
        console.log(`[Main] 已清除供应商 ${vendorId} 的 MIMO session 数据`)
      } catch (e) {
        console.warn(`[Main] 清除 MIMO session 失败:`, e.message)
      }
    }

    // 立即更新缓存并推送前端，不等待异步采集
    try {
      const { readCache, writeCache } = require('./usage-collector')
      const cache = readCache()
      if (cache) {
        cache.vendors = vendors
        // 删除单个供应商时，清理其对应的余额缓存
        if (cache.deepseekBalances) delete cache.deepseekBalances[vendorId]
        if (cache.kimiBalances) delete cache.kimiBalances[vendorId]
        if (cache.mimoBalances) delete cache.mimoBalances[vendorId]
        // 所有供应商已删除时，清除缓存的余额数据，防止前端显示幽灵条目
        if (vendors.length === 0) {
          delete cache.deepseekBalance
          delete cache.deepseekBalances
          delete cache.kimiBalance
          delete cache.kimiBalances
          delete cache.mimoBalance
          delete cache.mimoBalances
        }
        writeCache(cache)
        mainWindow?.webContents.send('usage-data-updated', cache)
      }
    } catch { /* 忽略 */ }

    // 同时触发一次采集，刷新余额等数据
    scheduler.collectBalance()

    return { success: true }
  })

  // 用量数据 IPC
  ipcMain.handle('get-usage-data', () => {
    const { readCache } = require('./usage-collector')
    return readCache() || { vendors: [], errors: [], lastCollect: null }
  })

  ipcMain.handle('collect-now', async () => {
    try {
      const data = await collectAll(getKimiMonitorLoginMap())
      mainWindow?.webContents.send('usage-data-updated', data)
      return data
    } catch (e) {
      return { error: e.message, vendors: [], errors: [e.message] }
    }
  })

  // Token 用量统计 IPC — 旧拦截器兼容接口
  ipcMain.on('deepseek-usage-record', (_event, record) => {
    try {
      const stats = recordTokenUsage(record)
      if (stats) {
        console.log(`[Main] Token 用量记录: model=${record.model}, tokens=${record.totalTokens}, 今日累计=${stats.todayTotal}`)
        mainWindow?.webContents.send('token-stats-updated', stats)
      }
    } catch (e) {
      console.error('[Main] 记录 Token 用量失败:', e.message)
    }
  })

  ipcMain.handle('get-token-stats', () => {
    return getTokenStats()
  })

  // ====== DeepSeek 用量页面监听器 ======
  const DeepSeekMonitor = require('./deepseek-monitor')

  function hasDeepSeekVendor() {
    const vendors = readVendors()
    return vendors.some(v => (v.provider || '').toLowerCase().includes('deepseek'))
  }

  // 为每个 DeepSeek / Kimi / XIAOMI MIMO vendor 创建独立的监控实例（隔离 session）
  function ensureMonitors() {
    const vendors = readVendors()
    const deepseekVendors = vendors.filter(v => (v.provider || '').toLowerCase().includes('deepseek'))
    const kimiVendors = vendors.filter(v => (v.provider || '').toLowerCase().includes('kimi'))
    const mimoVendors = vendors.filter(v => (v.provider || '').toLowerCase().includes('mimo'))

    // 启动缺失的 DeepSeek 监控
    for (const v of deepseekVendors) {
      if (!dsMonitors.has(v.id)) {
        const monitor = new DeepSeekMonitor(v.id)
        monitor.onLoginStatusChanged = broadcastLoginStatus
        monitor.start(dsMonitorCallback)
        dsMonitors.set(v.id, monitor)
        scheduler.registerMonitor(v.id, monitor)
        console.log(`[Main] 为供应商 ${v.customName || v.id} 创建 DeepSeek 监控实例`)
      }
    }

    // 停止已删除供应商的 DeepSeek 监控
    for (const [vendorId, monitor] of dsMonitors) {
      if (!deepseekVendors.find(v => v.id === vendorId)) {
        monitor.stop()
        dsMonitors.delete(vendorId)
        scheduler.unregisterMonitor(vendorId)
        console.log(`[Main] 移除供应商 ${vendorId} 的 DeepSeek 监控实例`)
      }
    }

    // 启动缺失的 Kimi 监控
    for (const v of kimiVendors) {
      if (!kmiMonitors.has(v.id)) {
        const monitor = new KimiMonitor(v.id)
        monitor.onLoginStatusChanged = broadcastLoginStatus
        monitor.start(kmiMonitorCallback)
        kmiMonitors.set(v.id, monitor)
        scheduler.registerMonitor(v.id, monitor)
        console.log(`[Main] 为供应商 ${v.customName || v.id} 创建 Kimi 监控实例`)
        // 立即触发一次解析，不等待 scheduler 的10分钟轮询
        setTimeout(() => monitor.refreshNow(), 2000)
      }
    }

    // 停止已删除供应商的 Kimi 监控
    for (const [vendorId, monitor] of kmiMonitors) {
      if (!kimiVendors.find(v => v.id === vendorId)) {
        monitor.stop()
        kmiMonitors.delete(vendorId)
        scheduler.unregisterMonitor(vendorId)
        console.log(`[Main] 移除供应商 ${vendorId} 的 Kimi 监控实例`)
      }
    }

    // 启动缺失的 MIMO 监控
    for (const v of mimoVendors) {
      if (!mimoMonitors.has(v.id)) {
        const monitor = new MimoMonitor(v.id)
        monitor.onLoginStatusChanged = broadcastLoginStatus
        monitor.start(mimoMonitorCallback)
        mimoMonitors.set(v.id, monitor)
        scheduler.registerMonitor(v.id, monitor)
        console.log(`[Main] 为供应商 ${v.customName || v.id} 创建 MIMO 监控实例`)
        // 立即触发一次解析，不等待 scheduler 的10分钟轮询
        setTimeout(() => monitor.refreshNow(), 2000)
      }
    }

    // 停止已删除供应商的 MIMO 监控
    for (const [vendorId, monitor] of mimoMonitors) {
      if (!mimoVendors.find(v => v.id === vendorId)) {
        monitor.stop()
        mimoMonitors.delete(vendorId)
        scheduler.unregisterMonitor(vendorId)
        console.log(`[Main] 移除供应商 ${vendorId} 的 MIMO 监控实例`)
      }
    }
  }

  // 获取指定 vendorId 的监控实例，或获取任意一个
  function getMonitor(vendorId) {
    if (vendorId && dsMonitors.has(vendorId)) return dsMonitors.get(vendorId)
    if (vendorId && kmiMonitors.has(vendorId)) return kmiMonitors.get(vendorId)
    if (vendorId && mimoMonitors.has(vendorId)) return mimoMonitors.get(vendorId)
    // fallback: 返回第一个
    return dsMonitors.values().next().value || kmiMonitors.values().next().value || mimoMonitors.values().next().value || null
  }

  function getKimiMonitorLoginMap() {
    const map = {}
    for (const [id, m] of kmiMonitors) map[id] = m.isLoggedIn()
    return map
  }

  // ====== 登录状态变更广播 ======
  const _lastLoginStatus = new Map()

  function broadcastLoginStatus(vendorId, loggedIn) {
    const prev = _lastLoginStatus.get(vendorId)
    if (prev === loggedIn) return
    _lastLoginStatus.set(vendorId, loggedIn)
    console.log(`[Main] 登录状态变更: ${vendorId} → ${loggedIn ? '已登录' : '未登录'}`)
    mainWindow?.webContents.send('monitor-login-status-changed', { vendorId, loggedIn })
  }

  // 监听器数据回调：收到 DeepSeek 用量页面的数据后转发给 token 统计
  const dsMonitorCallback = (payload) => {
    console.log(`[Main] 监听器收到数据: ${payload.type} from ${payload.url}`)

    const data = payload.data

    // 1. 标准 chat completion 响应格式
    if (data && data.usage) {
      const record = {
        model: data.model || data.id?.split('-')[0] || 'unknown',
        requestId: data.id || '',
        promptTokens: data.usage.prompt_tokens || 0,
        completionTokens: data.usage.completion_tokens || 0,
        totalTokens: data.usage.total_tokens || 0,
        completionDetails: data.usage.completion_tokens_details || null,
        timestamp: payload.timestamp,
        vendorId: payload.vendorId
      }
      const stats = recordTokenUsage(record)
      if (stats) {
        mainWindow?.webContents.send('token-stats-updated', stats)
      }
      return
    }

    // 2. DeepSeek v0 API 批量用量数据 (by_api_key/amount)
    if (data && data.data && Array.isArray(data.data)) {
      let hasNewData = false
      for (const item of data.data) {
        if (item && (item.amount || item.usage || item.total_tokens)) {
          const totalTokens = item.amount || item.total_tokens || item.usage?.total_tokens || 0
          if (totalTokens > 0) {
            const record = {
              model: item.model || item.api_key_name || 'deepseek-chat',
              requestId: '',
              promptTokens: item.prompt_tokens || item.usage?.prompt_tokens || 0,
              completionTokens: item.completion_tokens || item.usage?.completion_tokens || 0,
              totalTokens,
              timestamp: item.created_at ? item.created_at * 1000 : payload.timestamp,
              vendorId: payload.vendorId
            }
            recordTokenUsage(record)
            hasNewData = true
          }
        }
      }
      if (hasNewData) {
        mainWindow?.webContents.send('token-stats-updated', getTokenStats())
      }
      return
    }

    // 3. DOM 解析的用量数据（从页面文本中提取）— 必须在余额检查之前
    if (payload.type === 'dom-usage' && data) {
      console.log(`[Main] DOM 用量: 余额=${data.balance} 消费=${data.totalCost} tokens=${data.totalTokens}`)
      // 获取上次快照中各模型的累计 token 数，用于计算增量（按 vendor 隔离）
      const prevTokens = getPrevModelTokens(payload.vendorId)
      // 记录每小时快照（用于趋势图，按 vendor 隔离）
      recordHourlySnapshot(data, payload.vendorId)
      if (data.models && data.models.length > 0) {
        let hasNewData = false
        for (const model of data.models) {
          if (model.tokens > 0) {
            // 过滤解析产生的无效模型名（如 42096136s / undefined）
            if (!isValidModelName(model.name)) {
              console.log(`[Main]   忽略无效模型名: ${JSON.stringify(model.name)}`)
              continue
            }
            // 计算增量：当前累计值 - 上次快照累计值
            // 注意：平台展示的是"近30天滚动总量"，跨月/多天未运行后窗口滑动
            // 会导致当前值小于上次基线（delta 为负）——此时应跳过本次记录，
            // 当前值会随快照成为新基线，后续刷新自然产生正确的小增量。
            // 若强行按全量或负数记录，会把滚动总量误记成当天用量。
            const prev = prevTokens[model.name] || 0
            const delta = Math.max(0, model.tokens - prev)
            if (delta === 0) {
              console.log(`[Main]   ${model.name}: 无增量 (${model.tokens} <= 上次 ${prev})`)
              continue
            }
            const record = {
              model: model.name || 'unknown',
              requestId: '',
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: delta,
              timestamp: payload.timestamp,
              vendorId: payload.vendorId
            }
            recordTokenUsage(record)
            hasNewData = true
            console.log(`[Main]   ${model.name}: +${delta} tokens (累计 ${model.tokens})`)
          }
        }
        if (hasNewData) {
          mainWindow?.webContents.send('token-stats-updated', getTokenStats())
        }
      }
      return
    }

    // 4. 用户余额数据 (get_user_summary)
    if (data && (data.balance !== undefined || data.balance_infos)) {
      console.log('[Main] 收到余额数据')
      return
    }

    console.log('[Main] 未处理的数据格式:', payload.type, Object.keys(data || {}).join(', '))
  }

  // Kimi 监听器数据回调：DOM 解析的 Token 用量数据
  const kmiMonitorCallback = (payload) => {
    console.log(`[Main] Kimi 监听器收到数据: ${payload.type} from ${payload.url}`)

    const data = payload.data

    // kimi-dom-parsed: DOM 解析的各模型 Token 总量
    if (data && data.models && Array.isArray(data.models)) {
      let hasNewData = false
      const prevTokensMap = getPrevModelTokens(payload.vendorId)
      for (const model of data.models) {
        if (model.tokens > 0) {
          // 过滤解析产生的无效模型名
          if (!isValidModelName(model.name)) {
            console.log(`[Main]   忽略无效模型名: ${JSON.stringify(model.name)}`)
            continue
          }
          const prev = prevTokensMap[model.name] || 0
          const delta = Math.max(0, model.tokens - prev)
          if (delta === 0) {
            console.log(`[Main]   ${model.name}: 无增量 (${model.tokens} <= 上次 ${prev})`)
            continue
          }
          const record = {
            model: model.name || 'unknown',
            requestId: '',
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: delta,
            timestamp: payload.timestamp,
            vendorId: payload.vendorId
          }
          recordTokenUsage(record)
          hasNewData = true
          console.log(`[Main]   ${model.name}: +${delta} tokens (累计 ${model.tokens})`)
        }
      }
      // 记录快照，供下次增量计算用（与 DeepSeek 一致）
      const totalTokens = data.models.reduce((sum, m) => sum + (m.tokens || 0), 0)
      recordHourlySnapshot({ models: data.models, totalTokens }, payload.vendorId)

      if (hasNewData) {
        mainWindow?.webContents.send('token-stats-updated', getTokenStats())
      }
      return
    }
  }

  // MIMO 监听器数据回调：DOM/XPath 解析的余额与用量数据 → 写入缓存并推送前端
  const mimoMonitorCallback = (payload) => {
    console.log(`[Main] MIMO 监听器收到数据: ${payload.type} from ${payload.url}`)

    const data = payload.data

    // mimo-dom-parsed: DOM 解析的各模型 Token 用量（模型-天，点击切换按钮后的视图）
    if (data && data.models && Array.isArray(data.models)) {
      let hasNewData = false
      const prevTokensMap = getPrevModelTokens(payload.vendorId)
      for (const model of data.models) {
        if (model.tokens > 0) {
          // 过滤解析产生的无效模型名（如 42096136s —— MIMO 表格列错位残留）
          if (!isValidModelName(model.name)) {
            console.log(`[Main]   忽略无效模型名: ${JSON.stringify(model.name)}`)
            continue
          }
          // 计算增量：当前累计值 - 上次快照累计值（与 DeepSeek/Kimi 一致）
          // 跨天/切换日期后当前值回落时（delta 为负）跳过，快照会成为新基线
          const prev = prevTokensMap[model.name] || 0
          const delta = Math.max(0, model.tokens - prev)
          if (delta === 0) {
            console.log(`[Main]   ${model.name}: 无增量 (${model.tokens} <= 上次 ${prev})`)
            continue
          }
          const record = {
            model: model.name || 'unknown',
            requestId: '',
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: delta,
            timestamp: payload.timestamp,
            vendorId: payload.vendorId
          }
          recordTokenUsage(record)
          hasNewData = true
          console.log(`[Main]   ${model.name}: +${delta} tokens (累计 ${model.tokens})`)
        }
      }
      // 记录快照，供下次增量计算用（与 Kimi 一致）
      const totalTokens = data.models.reduce((sum, m) => sum + (m.tokens || 0), 0)
      recordHourlySnapshot({ models: data.models, totalTokens }, payload.vendorId)

      if (hasNewData) {
        mainWindow?.webContents.send('token-stats-updated', getTokenStats())
      }
      return
    }

    // mimo-balance: XPath 解析的账户余额
    if (payload.type === 'mimo-balance' && data && typeof data.balance === 'number') {
      try {
        const { readCache, writeCache, computeMimoBalance } = require('./usage-collector')
        const cache = readCache() || { vendors: [] }
        const balance = computeMimoBalance(data, cache, payload.vendorId)
        if (!cache.mimoBalances) cache.mimoBalances = {}
        cache.mimoBalances[payload.vendorId] = balance
        // 兼容：全局 mimoBalance 取第一个 vendor 的 balance
        const firstMimo = Object.values(cache.mimoBalances)[0]
        cache.mimoBalance = firstMimo || null
        cache.lastCollect = new Date().toISOString()
        writeCache(cache)
        mainWindow?.webContents.send('usage-data-updated', cache)
        console.log(`[Main] MIMO 余额已更新: vendor=${payload.vendorId} remaining=${balance.remaining} spent=${balance.spent}`)
      } catch (e) {
        console.error('[Main] MIMO 余额写入失败:', e.message)
      }
      return
    }

    console.log('[Main] 未处理的 MIMO 数据格式:', payload.type)
  }

  ensureMonitors()

  // 暴露监听器状态查询（支持 vendorId 参数路由到对应监控实例）
  ipcMain.handle('get-monitor-status', (_event, vendorId) => {
    const monitor = getMonitor(vendorId)
    return monitor ? monitor.getStatus() : { active: false }
  })

  ipcMain.handle('get-monitor-login-status', (_event, vendorId) => {
    const monitor = getMonitor(vendorId)
    return monitor ? monitor.isLoggedIn() : false
  })

  ipcMain.handle('show-login-window', (_event, vendorId) => {
    const monitor = getMonitor(vendorId)
    if (monitor) monitor.showLoginWindow()
    return { success: true }
  })

  ipcMain.handle('refresh-monitor', (_event, vendorId) => {
    const monitor = getMonitor(vendorId)
    if (monitor) monitor.refresh()
    return { success: true }
  })

  ipcMain.handle('refresh-monitor-now', (_event, vendorId) => {
    const monitor = getMonitor(vendorId)
    const ok = monitor ? monitor.refreshNow() : false
    return { success: ok }
  })

  // 统一手动刷新：页面刷新 + 余额采集
  ipcMain.handle('unified-refresh', async () => {
    try {
      const result = await scheduler.manualRefresh()
      // 外部可能清理/修改过 token 统计数据文件，强制重新加载并推送最新统计，
      // 保证柱状图等图表立即反映磁盘上的最新数据
      const stats = reloadTokenStats()
      mainWindow?.webContents.send('token-stats-updated', stats)
      return { success: true, ...result }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // 重新加载 Token 统计数据（从磁盘），供手动清理数据后立即刷新图表
  ipcMain.handle('reload-token-stats', () => {
    try {
      const stats = reloadTokenStats()
      mainWindow?.webContents.send('token-stats-updated', stats)
      return { success: true, stats }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // 重置 DeepSeek 累计充值
  ipcMain.handle('reset-deepseek-budget', async () => {
    try {
      const data = await resetDeepSeekBudget()
      mainWindow?.webContents.send('usage-data-updated', data)
      return { success: true, data }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // 重置 XIAOMI MIMO 累计预算
  ipcMain.handle('reset-mimo-budget', async (_event, vendorId) => {
    try {
      const data = await resetMimoBudget(vendorId)
      mainWindow?.webContents.send('usage-data-updated', data)
      // 初始化后触发一次实时刷新，让后续数据尽快更新
      const monitor = mimoMonitors.get(vendorId)
      if (monitor) setTimeout(() => monitor.refreshNow(), 300)
      return { success: true, data }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // 开机自启动设置
  ipcMain.handle('get-auto-launch', () => {
    try {
      return app.getLoginItemSettings().openAtLogin
    } catch (e) {
      console.error('[Main] 获取开机自启动状态失败:', e.message)
      return false
    }
  })

  ipcMain.handle('set-auto-launch', (_event, enable) => {
    try {
      app.setLoginItemSettings({ openAtLogin: !!enable })
      console.log('[Main] 开机自启动:', enable ? '已开启' : '已关闭')
      return { success: true, enabled: !!enable }
    } catch (e) {
      console.error('[Main] 设置开机自启动失败:', e.message)
      return { success: false, error: e.message }
    }
  })

  // ---------- 缩小到系统托盘 ----------
  ipcMain.handle('get-minimize-to-tray', () => {
    try {
      const settings = readSettings()
      return settings.minimizeToTray !== false
    } catch (e) {
      console.error('[Main] 获取系统托盘设置失败:', e.message)
      return true
    }
  })

  ipcMain.handle('set-minimize-to-tray', (_event, enable) => {
    try {
      const settings = readSettings()
      settings.minimizeToTray = !!enable
      writeSettings(settings)
      console.log('[Main] 缩小到系统托盘:', enable ? '已开启' : '已关闭')
      return { success: true, enabled: !!enable }
    } catch (e) {
      console.error('[Main] 设置系统托盘失败:', e.message)
      return { success: false, error: e.message }
    }
  })

  // ---------- 打开外部链接 ----------
  ipcMain.handle('open-external', (_event, url) => {
    try {
      shell.openExternal(url)
      return { success: true }
    } catch (e) {
      console.error('[Main] 打开外部链接失败:', e.message)
      return { success: false, error: e.message }
    }
  })

  // ---------- 获取应用版本号 ----------
  ipcMain.handle('get-app-version', () => {
    return app.getVersion()
  })

  // ---------- 判断当前应用是安装版还是免安装版 ----------
  // electron-builder 的 portable 版运行时设置了 PORTABLE_EXECUTABLE_DIR 环境变量
  ipcMain.handle('get-install-type', () => {
    return getInstallType()
  })

  // ---------- 检查 GitHub 更新 ----------
  ipcMain.handle('check-for-updates', async () => {
    try {
      const response = await fetch('https://api.github.com/repos/KrisitVvv/AI-Usage-Monitor/releases/latest')
      if (!response.ok) {
        return { success: false, error: `GitHub API 返回 ${response.status}` }
      }
      const release = await response.json()
      const latestVersion = (release.tag_name || '').replace(/^v/i, '')
      const currentVersion = app.getVersion()
      const releaseNotes = release.body || ''
      // 匹配当前安装类型的下载资产
      const asset = matchUpdateAsset(release.assets || [], getInstallType())
      return {
        success: true,
        currentVersion,
        latestVersion,
        hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
        installType: getInstallType(),
        downloadUrl: release.html_url,
        assetUrl: asset ? asset.browser_download_url : null,
        assetName: asset ? asset.name : null,
        assetSize: asset ? asset.size : 0,
        releaseNotes
      }
    } catch (e) {
      console.error('[Main] 检查更新失败:', e.message)
      return { success: false, error: e.message }
    }
  })

  // ---------- 下载更新安装包（自动更新） ----------
  ipcMain.handle('download-update', async (event, downloadUrl) => {
    try {
      const assetName = decodeURIComponent(path.basename(new URL(downloadUrl).pathname))
      const dir = path.join(app.getPath('userData'), 'updates')
      fs.mkdirSync(dir, { recursive: true })
      const savePath = path.join(dir, assetName)
      await downloadFileWithProgress(downloadUrl, savePath, (received, total) => {
        event.sender.send('update-download-progress', {
          received,
          total,
          percent: total > 0 ? Math.round((received / total) * 100) : 0
        })
      })
      return { success: true, filePath: savePath }
    } catch (e) {
      console.error('[Main] 下载更新失败:', e.message)
      return { success: false, error: e.message }
    }
  })

  // ---------- 启动安装程序（安装版自动更新） ----------
  ipcMain.handle('install-update', async (_event, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        return { success: false, error: '安装包不存在' }
      }
      // 以独立进程启动安装程序，随后退出当前应用，由安装程序接管
      const child = spawn(filePath, [], { detached: true, stdio: 'ignore' })
      child.unref()
      setTimeout(() => {
        app.quit()
      }, 1000)
      return { success: true }
    } catch (e) {
      console.error('[Main] 启动安装程序失败:', e.message)
      return { success: false, error: e.message }
    }
  })

  // ---------- 获取更新日志（从 GitHub Releases API） ----------
  ipcMain.handle('get-changelog', async () => {
    try {
      const response = await fetch('https://api.github.com/repos/KrisitVvv/AI-Usage-Monitor/releases?per_page=20')
      if (!response.ok) {
        return { success: false, error: `GitHub API 返回 ${response.status}` }
      }
      const releases = await response.json()
      const list = releases.map(r => ({
        version: (r.tag_name || '').replace(/^v/i, ''),
        date: (r.published_at || r.created_at || '').split('T')[0],
        changes: parseReleaseNotes(r.body || ''),
        downloadUrl: r.html_url
      }))
      return { success: true, list }
    } catch (e) {
      console.error('[Main] 获取更新日志失败:', e.message)
      return { success: false, error: e.message }
    }
  })

  /**
   * 将 GitHub Release body 解析为变更列表
   * 按行解析，过滤常见的无用行
   */
  function parseReleaseNotes(body) {
    const lines = body.split('\n')
      .map(l => l.replace(/^[\s*#\-•·]+/, '').trim())
      .filter(l => l.length > 0 && !/^full changelog/i.test(l) && !/^https?:\/\//.test(l))
    return lines.length > 0 ? lines : ['请查看 GitHub Release 页面获取详情']
  }

  // ---------- 获取缓存大小 ----------
  ipcMain.handle('get-cache-size', async () => {
    try {
      const cachePath = path.join(app.getPath('userData'), 'Cache')
      let totalSize = 0
      function calcSize(dir) {
        if (!fs.existsSync(dir)) return
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            calcSize(fullPath)
          } else {
            totalSize += fs.statSync(fullPath).size
          }
        }
      }
      calcSize(cachePath)
      return { success: true, size: totalSize }
    } catch (e) {
      return { success: false, error: e.message, size: 0 }
    }
  })

  // ---------- 清理缓存 ----------
  ipcMain.handle('clear-cache', async () => {
    try {
      // 清理浏览器磁盘缓存（Chromium 管理）
      const ses = session.defaultSession
      await ses.clearCache()
      // 清理 localStorage / cookies / service workers 等存储
      await ses.clearStorageData({
        storages: ['caches', 'serviceworkers', 'localstorage']
      })
      return { success: true }
    } catch (e) {
      console.warn('[Main] 清理缓存失败:', e.message)
      // 回退：尝试删除 Cache 目录中的文件（忽略锁定文件）
      try {
        const cachePath = path.join(app.getPath('userData'), 'Cache')
        if (fs.existsSync(cachePath)) {
          const entries = fs.readdirSync(cachePath, { withFileTypes: true })
          for (const entry of entries) {
            const fullPath = path.join(cachePath, entry.name)
            try {
              if (entry.isDirectory()) {
                fs.rmSync(fullPath, { recursive: true, force: true })
              } else {
                fs.unlinkSync(fullPath)
              }
            } catch { /* 忽略锁定文件 */ }
          }
        }
        return { success: true }
      } catch {
        return { success: false, error: e.message }
      }
    }
  })

})

app.on('window-all-closed', () => {
  scheduler.stop()
  for (const [, monitor] of dsMonitors) monitor.stop()
  dsMonitors.clear()
  for (const [, monitor] of kmiMonitors) monitor.stop()
  kmiMonitors.clear()
  for (const [, monitor] of mimoMonitors) monitor.stop()
  mimoMonitors.clear()
  if (process.platform !== 'darwin') app.quit()
})

// 应用退出前保存 session 并刷写 Token 统计数据
let isQuitting = false
app.on('before-quit', (event) => {
  if (isQuitting) return
  isQuitting = true
  event.preventDefault()
  scheduler.stop()
  const stopPromises = [
    ...[...dsMonitors.values()].map(m => m.stop()),
    ...[...kmiMonitors.values()].map(m => m.stop()),
    ...[...mimoMonitors.values()].map(m => m.stop())
  ]
  Promise.all(stopPromises).then(() => {
    flushTokenStats()
    app.quit()
  }).catch(() => {
    flushTokenStats()
    app.quit()
  })
})