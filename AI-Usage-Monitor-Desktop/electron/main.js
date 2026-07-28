const { app, BrowserWindow, ipcMain, session, Tray, Menu, nativeImage, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { collectAll, recordTokenUsage, getTokenStats, resetDeepSeekBudget, flushTokenStats, loadTokenStats, recordHourlySnapshot, getPrevModelTokens } = require('./usage-collector')

// 设置应用名称（影响开机自启动注册表条目名称等）
app.name = 'AI Usage Monitor'

let mainWindow = null
let collectTimer = null
let dsMonitor = null

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

  // 开发模式下加载 Vite 服务器（动态端口）
  const vitePort = process.env.VITE_PORT || 5173
  mainWindow.loadURL(`http://localhost:${vitePort}`)

  // 可选：打开 DevTools
  mainWindow.webContents.openDevTools()
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
        if (mainWindow) {
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
    if (mainWindow) {
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

  // 监听开机自启动 IPC 消息设置
  ipcMain.on('set-auto-launch', (event, openAtLogin) => {
    app.setLoginItemSettings({
      openAtLogin: openAtLogin,
      path: process.execPath
    })
  })

  // 获取当前系统开机自启动设置
  ipcMain.handle('get-auto-launch', () => {
    const settings = app.getLoginItemSettings()
    return settings.openAtLogin
  })

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

    // 新增供应商后同步更新缓存里的 vendors 并立即通知前端
    try {
      const { readCache, writeCache } = require('./usage-collector')
      const cache = readCache() || { vendors: [], errors: [], lastCollect: new Date().toISOString(), deepseekBalance: null, deepseekBalances: {} }
      cache.vendors = vendors
      writeCache(cache)
      mainWindow?.webContents.send('usage-data-updated', cache)
    } catch (e) {
      console.warn('[Main] 保存供应商更新缓存失败:', e.message)
    }

    // 立即触发一次采集
    triggerCollect()

    // 如果是 DeepSeek 供应商，确保监听器已启动
    if ((newVendor.provider || '').toLowerCase().includes('deepseek')) {
      ensureMonitor()
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

  ipcMain.handle('delete-vendor', (_event, vendorId) => {
    if (!vendorId) throw new Error('供应商 ID 不能为空')
    const vendors = readVendors()
    const idx = vendors.findIndex(v => v.id === vendorId)
    if (idx === -1) throw new Error('供应商不存在')
    vendors.splice(idx, 1)
    writeVendors(vendors)

    // 删除后清理对应的 balance 缓存并触发一次采集刷新缓存
    try {
      const { readCache, writeCache } = require('./usage-collector')
      const cache = readCache()
      if (cache) {
        cache.vendors = vendors
        if (cache.deepseekBalances && cache.deepseekBalances[vendorId]) {
          delete cache.deepseekBalances[vendorId]
        }
        // 如果清空了供应商，也要把 compatible 取的 deepseekBalance 设为 null
        if (vendors.length === 0) {
          cache.deepseekBalance = null
          cache.deepseekBalances = {}
        } else {
          // 如果还有其他 deepseek 供应商，就取第一个，否则设为 null
          const dsVendors = vendors.filter(v => (v.provider || '').toLowerCase().includes('deepseek'))
          if (dsVendors.length > 0) {
            cache.deepseekBalance = cache.deepseekBalances[dsVendors[0].id] || null
          } else {
            cache.deepseekBalance = null
            cache.deepseekBalances = {}
          }
        }
        writeCache(cache)
        mainWindow?.webContents.send('usage-data-updated', cache)
      }
    } catch (e) {
      console.warn('[Main] 清理删除后的缓存失败:', e.message)
    }

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
      pushTokenStats()
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

  function ensureMonitor() {
    if (dsMonitor && dsMonitor.isRunning) return
    if (!hasDeepSeekVendor()) return
    dsMonitor = new DeepSeekMonitor()
    dsMonitor.start(dsMonitorCallback)
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
        timestamp: payload.timestamp
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
              timestamp: item.created_at ? item.created_at * 1000 : payload.timestamp
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
      // 获取上次快照中各模型的累计 token 数，用于计算增量
      const prevTokens = getPrevModelTokens()
      // 记录每小时快照（用于趋势图）
      recordHourlySnapshot(data)
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
              timestamp: payload.timestamp
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

  ensureMonitor()

  // 暴露监听器状态查询
  ipcMain.handle('get-monitor-status', () => {
    return dsMonitor ? dsMonitor.getStatus() : { active: false }
  })

  ipcMain.handle('get-monitor-login-status', () => {
    return dsMonitor ? dsMonitor.isLoggedIn() : false
  })

  ipcMain.handle('show-login-window', () => {
    if (dsMonitor) dsMonitor.showLoginWindow()
    return { success: true }
  })

  ipcMain.handle('refresh-monitor', () => {
    if (dsMonitor) dsMonitor.refresh()
    return { success: true }
  })

  ipcMain.handle('refresh-monitor-now', () => {
    const ok = dsMonitor ? dsMonitor.refreshNow() : false
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
      const downloadUrl = release.html_url
      const releaseNotes = release.body || ''
      return {
        success: true,
        currentVersion,
        latestVersion,
        hasUpdate: latestVersion !== currentVersion,
        downloadUrl,
        releaseNotes
      }
    } catch (e) {
      console.error('[Main] 检查更新失败:', e.message)
      return { success: false, error: e.message }
    }
  })

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
      const cachePath = path.join(app.getPath('userData'), 'Cache')
      function removeDir(dir) {
        if (!fs.existsSync(dir)) return
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            removeDir(fullPath)
          } else {
            fs.unlinkSync(fullPath)
          }
        }
        fs.rmdirSync(dir)
      }
      removeDir(cachePath)
      return { success: true }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // ====== 30 秒自动采集 ======
  function pushTokenStats() {
    try {
      const stats = getTokenStats()
      if (stats) {
        mainWindow?.webContents.send('token-stats-updated', stats)
      }
    } catch { /* 忽略 token stats 推送失败 */ }
  }

  function triggerCollect() {
    collectAll().then(data => {
      mainWindow?.webContents.send('usage-data-updated', data)
      // 每次余额采集后，同时推送最新的 Token 用量统计
      pushTokenStats()
    }).catch(e => {
      mainWindow?.webContents.send('usage-data-updated', {
        vendors: [],
        errors: [`采集失败: ${e.message}`],
        lastCollect: new Date().toISOString()
      })
    })
  }

  // 立即执行首次采集 + Token 统计推送
  triggerCollect()

  // 每 30 秒执行一次
  collectTimer = setInterval(triggerCollect, 30_000)
})

app.on('window-all-closed', () => {
  if (collectTimer) clearInterval(collectTimer)
  if (dsMonitor) dsMonitor.stop()
  if (process.platform !== 'darwin') app.quit()
})

// 应用退出前保存 session 并刷写 Token 统计数据
let isQuitting = false
app.on('before-quit', (event) => {
  if (isQuitting) return
  isQuitting = true
  event.preventDefault()
  if (collectTimer) clearInterval(collectTimer)
  const stopPromise = dsMonitor ? dsMonitor.stop() : Promise.resolve()
  stopPromise.then(() => {
    flushTokenStats()
    app.quit()
  }).catch(() => {
    flushTokenStats()
    app.quit()
  })
})