const { app, BrowserWindow, ipcMain, session, Tray, Menu, nativeImage, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const https = require('https')
const { spawn } = require('child_process')
const { collectAll, recordTokenUsage, getTokenStats, resetDeepSeekBudget, flushTokenStats, loadTokenStats, recordHourlySnapshot, getPrevModelTokens } = require('./usage-collector')

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
let collectTimer = null
const dsMonitors = new Map() // vendorId → DeepSeekMonitor

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
    // 数据验证
    if (!vendorData.provider) throw new Error('供应商不能为空')
    if (!vendorData.billingModel) throw new Error('计费模式不能为空')
    if (!vendorData.apiKey || !vendorData.apiKey.trim()) throw new Error('API 密钥不能为空')

    const vendors = readVendors()
    const newVendor = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      provider: vendorData.provider,
      billingModel: vendorData.billingModel,
      apiKey: vendorData.apiKey.trim(),
      createdAt: new Date().toISOString()
    }
    vendors.push(newVendor)
    writeVendors(vendors)

    // 新增供应商后立即触发一次采集
    triggerCollect()

    // 如果是 DeepSeek 供应商，确保监听器已启动
    if ((newVendor.provider || '').toLowerCase().includes('deepseek')) {
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
        console.log(`[Main] 已停止并移除供应商 ${vendorId} 的监控实例`)
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

    // 立即更新缓存并推送前端，不等待异步采集
    try {
      const { readCache, writeCache } = require('./usage-collector')
      const cache = readCache()
      if (cache) {
        cache.vendors = vendors
        // 所有供应商已删除时，清除缓存的余额数据，防止前端显示幽灵条目
        if (vendors.length === 0) {
          delete cache.deepseekBalance
          delete cache.deepseekBalances
        }
        writeCache(cache)
        mainWindow?.webContents.send('usage-data-updated', cache)
      }
    } catch { /* 忽略 */ }

    // 同时触发一次采集，刷新余额等数据
    triggerCollect()

    return { success: true }
  })

  // 用量数据 IPC
  ipcMain.handle('get-usage-data', () => {
    const { readCache } = require('./usage-collector')
    return readCache() || { vendors: [], errors: [], lastCollect: null }
  })

  ipcMain.handle('collect-now', async () => {
    try {
      const data = await collectAll()
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

  // 为每个 DeepSeek vendor 创建独立的监控实例（隔离 session）
  function ensureMonitors() {
    const vendors = readVendors()
    const deepseekVendors = vendors.filter(v => (v.provider || '').toLowerCase().includes('deepseek'))

    // 启动缺失的监控
    for (const v of deepseekVendors) {
      if (!dsMonitors.has(v.id)) {
        const monitor = new DeepSeekMonitor(v.id)
        monitor.start(dsMonitorCallback)
        dsMonitors.set(v.id, monitor)
        console.log(`[Main] 为供应商 ${v.customName || v.id} 创建监控实例`)
      }
    }

    // 停止已删除供应商的监控
    for (const [vendorId, monitor] of dsMonitors) {
      if (!deepseekVendors.find(v => v.id === vendorId)) {
        monitor.stop()
        dsMonitors.delete(vendorId)
        console.log(`[Main] 移除供应商 ${vendorId} 的监控实例`)
      }
    }
  }

  // 获取指定 vendorId 的监控实例，或获取任意一个
  function getMonitor(vendorId) {
    if (vendorId && dsMonitors.has(vendorId)) return dsMonitors.get(vendorId)
    // fallback: 返回第一个
    return dsMonitors.values().next().value || null
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
            // 计算增量：当前累计值 - 上次快照累计值
            const prev = prevTokens[model.name] || 0
            const delta = Math.max(0, model.tokens - prev)
            if (delta === 0) {
              console.log(`[Main]   ${model.name}: 无增量 (${model.tokens} = 上次 ${prev})`)
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

  // ====== 30 秒自动采集 ======
  function triggerCollect() {
    collectAll().then(data => {
      mainWindow?.webContents.send('usage-data-updated', data)
    }).catch(e => {
      mainWindow?.webContents.send('usage-data-updated', {
        vendors: [],
        errors: [`采集失败: ${e.message}`],
        lastCollect: new Date().toISOString()
      })
    })
  }

  // 立即执行首次采集
  triggerCollect()

  // 每 30 秒执行一次
  collectTimer = setInterval(triggerCollect, 30_000)
})

app.on('window-all-closed', () => {
  if (collectTimer) clearInterval(collectTimer)
  for (const [, monitor] of dsMonitors) monitor.stop()
  dsMonitors.clear()
  if (process.platform !== 'darwin') app.quit()
})

// 应用退出前保存 session 并刷写 Token 统计数据
let isQuitting = false
app.on('before-quit', (event) => {
  if (isQuitting) return
  isQuitting = true
  event.preventDefault()
  if (collectTimer) clearInterval(collectTimer)
  const stopPromises = [...dsMonitors.values()].map(m => m.stop())
  Promise.all(stopPromises).then(() => {
    flushTokenStats()
    app.quit()
  }).catch(() => {
    flushTokenStats()
    app.quit()
  })
})