/**
 * Kimi 用量监控
 *
 * 职责与 DeepSeekMonitor 对称：
 * - 首次创建 BrowserWindow → 用户登录 Kimi → 登录态通过 partition 持久化
 * - 定时刷新 fee-detail 页面 → DOM 解析提取各模型 Token 用量
 * - 将解析结果通过回调送回主进程，写入统一的 token-usage.json
 *
 * 使用 partition: 'persist:kimi-{vendorId}' 按供应商隔离 session，支持多账号。
 */

const { BrowserWindow, session } = require('electron')

// Kimi 用量页地址
const KIMI_FEE_URL = 'https://platform.kimi.com/console/fee-detail?tab=detail'

/** 页面加载/刷新超时（毫秒） */
const PAGE_LOAD_TIMEOUT = 30000

/** DOM 解析后等待稳定时间（毫秒） */
const DOM_SETTLE_DELAY = 3000

class KimiMonitor {
  /**
   * @param {string} vendorId - 对应 vendors.json 中条目的 id
   */
  constructor(vendorId) {
    this.vendorId = vendorId
    /** 分区名：persist: 保证跨会话持久化 */
    this.partition = `persist:kimi-${vendorId}`
    /** BrowserWindow（对齐 deepseek-monitor 模式，避免 BrowserView 兼容问题） */
    this.monitorWindow = null
    /** 数据回调（由 start() 注入） */
    this._callback = null
    this.onLoginStatusChanged = null
    /** 登录状态：Kimi 登录后 cookie 保存在 session 中，不随窗口关闭丢失 */
    this._isLoggedIn = false
    /** 首次加载标记：首次需导航到登录/用量页；后续刷新直接 reload 即可 */
    this.isInitialLoad = true
    /** 刷新防抖 */
    this._refreshing = false
    this._pendingRefresh = false
    /** 用户正在手动登录（showLoginWindow 触发，期间不隐藏窗口） */
    this._isUserLoggingIn = false
    /** 主动销毁标记：解析成功后 destroy 窗口时不重置 _isLoggedIn */
    this._destroying = false
    /** 导航版本号（每次 reload 递增，防止旧导航的 handlePageLoaded 覆盖新结果） */
    this._navVersion = 0
    /** 超时定时器 */
    this._pageLoadTimeout = null
    this._refreshTimeout = null
  }

  // ===================== 生命周期 =====================

  /**
   * 启动监控（不创建窗口，仅注册回调）。
   * 窗口只在 refreshNow() 或 showLoginWindow() 时按需创建。
   */
  start(callback) {
    this._callback = callback
  }

  stop() {
    this._clearAllTimers()
    if (this.monitorWindow && !this.monitorWindow.isDestroyed()) {
      try { this.monitorWindow.close() } catch {}
    }
    this.monitorWindow = null
    this._isLoggedIn = false
    this._callback = null
  }

  // ===================== 刷新 =====================

  /**
   * 被 scheduler 调用：刷新 Kimi 用量页并解析数据。
   * @returns {boolean} true=刷新成功
   */
  async refreshNow() {
    if (this._refreshing) {
      this._pendingRefresh = true
      return false
    }
    this._refreshing = true

    try {
      if (!this.monitorWindow || this.monitorWindow.isDestroyed()) {
        // 首次刷新时按需创建隐藏窗口
        await this._createHiddenWindow()
        if (!this.monitorWindow) {
          console.warn(`[KimiMonitor:${this.vendorId}] 无法创建窗口，跳过刷新`)
          return false
        }
      }

      // 用户正在登录时不要刷新，以免 reload() 中断登录跳转
      if (this._isUserLoggingIn || this.monitorWindow.isVisible()) {
        console.log(`[KimiMonitor:${this.vendorId}] 用户正在登录（visible=${this.monitorWindow.isVisible()}），跳过刷新`)
        return false
      }

      this._clearAllTimers()
      this._navVersion++
      const myVersion = this._navVersion
      console.log(`[KimiMonitor:${this.vendorId}] 开始刷新 (nav#${myVersion})...`)

      const success = await new Promise((resolve) => {
        const settleTimer = setTimeout(() => {
          // settle 兜底：仅在 did-finish-load 未触发时执行
          if (this._navVersion === myVersion) {
            this.handlePageLoaded(myVersion)
          }
          resolve(true)
        }, DOM_SETTLE_DELAY)

        this._pageLoadTimeout = setTimeout(() => {
          clearTimeout(settleTimer)
          console.warn(`[KimiMonitor:${this.vendorId}] 刷新超时 (${PAGE_LOAD_TIMEOUT}ms)`)
          resolve(false)
        }, PAGE_LOAD_TIMEOUT)

        this._refreshResolve = (result) => {
          clearTimeout(settleTimer)
          clearTimeout(this._pageLoadTimeout)
          this._pageLoadTimeout = null
          resolve(result)
        }

        this.monitorWindow.webContents.reload()
      })

      if (!success) return false
      if (this._pendingRefresh) {
        this._pendingRefresh = false
        return this.refreshNow()
      }
      return true
    } catch (e) {
      console.error(`[KimiMonitor:${this.vendorId}] 刷新异常:`, e.message)
      return false
    } finally {
      this._refreshing = false
    }
  }

  // ===================== 页面加载处理 =====================

  async handlePageLoaded(navVersion) {
    if (!this.monitorWindow || this.monitorWindow.isDestroyed()) return
    // 如果传入了 navVersion，检查是否已被新导航取代
    if (navVersion !== undefined && navVersion !== this._navVersion) {
      console.log(`[KimiMonitor:${this.vendorId}] 导航已更新 (当前#${this._navVersion} > 传入#${navVersion})，跳过`)
      return
    }

    if (!this.monitorWindow.webContents) return
    const url = this.monitorWindow.webContents.getURL()
    console.log(`[KimiMonitor:${this.vendorId}] 页面加载:`, url)

    // 首次加载完成后立即重置标记，无论当前在哪个页面
    // 防止登录页停留时 isInitialLoad 一直为 true 导致反复触发导航
    if (this.isInitialLoad) {
      this.isInitialLoad = false
      this._clearLoadTimeout()
    }

    // 检测是否在登录页（基于 URL，比文本匹配更可靠）
    const isLoginUrl = url.includes('/sign_in') || url.includes('/login') || url.includes('accounts.kimi.com') || url.includes('login.moonshot.cn') || url.includes('/oauth')

    // 兜底：URL 可能在跳转中间态还没更新，通过页面内容检测登录页
    let isLoginPage = isLoginUrl
    if (!isLoginPage) {
      try {
        const pageText = await this.monitorWindow.webContents.executeJavaScript(
          'document.body?.innerText?.substring(0, 300) || ""'
        )
        // 内容检测后再次校验导航版本
        if (navVersion !== undefined && navVersion !== this._navVersion) return
        isLoginPage = /微信扫码登录|手机快捷登录|账号密码登录/.test(pageText)
      } catch { /* 忽略 */ }
    }

    if (isLoginPage) {
      const wasLoggedIn = this._isLoggedIn
      this._isLoggedIn = false
      if (wasLoggedIn && this.onLoginStatusChanged) {
        this.onLoginStatusChanged(this.vendorId, false)
      }
      // 仅在非用户主动登录时隐藏窗口；用户手动触发登录时保持窗口可见
      if (!this._isUserLoggingIn && this.monitorWindow && !this.monitorWindow.isDestroyed()) {
        this.monitorWindow.hide()
      }
      console.log(`[KimiMonitor:${this.vendorId}] 需要登录${this._isUserLoggingIn ? '（用户登录中，窗口保持可见）' : '，窗口已隐藏，等待用户手动触发'}`)
      return
    }

    // OAuth 回调中间态：Kimi 登录后通过 redirect URL 建立 session，不要打断
    if (url.includes('platform.kimi.com/redirect')) {
      console.log(`[KimiMonitor:${this.vendorId}] OAuth 回调中，等待跳转...`)
      return
    }

    // 检测是否在正确的用量页
    const isFeePage = url.includes('platform.kimi.com/console/fee')
    if (!isFeePage) {
      console.log(`[KimiMonitor:${this.vendorId}] 页面不是用量页，尝试导航...`)
      await this.monitorWindow.loadURL(KIMI_FEE_URL)
      return
    }

    this._clearLoadTimeout()

    // 等待 DOM 渲染稳定
    await new Promise(resolve => setTimeout(resolve, DOM_SETTLE_DELAY))
    // 等待后再次校验导航版本（可能已被新 reload 取代）
    if (navVersion !== undefined && navVersion !== this._navVersion) return

    // 内容校验：确认页面真正包含用量数据，而非停留在登录页或中间态
    try {
      const bodyText = await this.monitorWindow.webContents.executeJavaScript(
        'document.body?.innerText?.substring(0, 500) || ""'
      )
      if (/微信扫码登录|手机快捷登录|账号密码登录/.test(bodyText)) {
        console.log(`[KimiMonitor:${this.vendorId}] 页面内容为登录页，跳过解析`)
        return
      }
    } catch { /* 忽略 */ }

    // 解析 DOM 中的 Token 用量数据
    try {
      // 自动翻页解析所有请求明细，聚合每个模型的 Token 总量
      const raw = await this.monitorWindow.webContents.executeJavaScript(`
        (async () => {
          const numPattern = /[,，\s]/g
          const allRows = []
          const seen = new Set() // 全局行指纹去重，防止翻页/刷新过程中重复计数

          // 解析当前可见表格中的所有明细行（每行 = 一次请求的 input + output）
          function parseCurrentPage() {
            const rows = []
            const tables = document.querySelectorAll('table')
            for (const table of tables) {
              let headerCells = table.querySelectorAll('thead th, thead td')
              if (headerCells.length === 0) {
                const firstRow = table.querySelector('tr')
                if (firstRow) headerCells = firstRow.querySelectorAll('th, td')
              }
              if (headerCells.length < 3) continue

              let modelIdx = -1, inputIdx = -1, outputIdx = -1
              for (let i = 0; i < headerCells.length; i++) {
                const text = (headerCells[i].textContent || '').trim().toLowerCase()
                if (text.includes('模型') || text.includes('model')) modelIdx = i
                if ((text.includes('输入') && text.includes('token')) || text === 'input tokens') inputIdx = i
                if ((text.includes('输出') && text.includes('token')) || text === 'output tokens') outputIdx = i
              }
              if (modelIdx === -1 || inputIdx === -1) continue

              let dataRows = table.querySelectorAll('tbody tr')
              if (dataRows.length === 0) {
                dataRows = Array.from(table.querySelectorAll('tr')).slice(1)
              }
              for (const row of dataRows) {
                const cells = row.querySelectorAll('td')
                if (cells.length <= Math.max(modelIdx, inputIdx, outputIdx)) continue
                const modelName = (cells[modelIdx]?.textContent || '').trim()
                if (!modelName) continue
                const inputTokens = parseInt((cells[inputIdx]?.textContent || '').replace(numPattern, ''), 10) || 0
                const outputTokens = outputIdx >= 0
                  ? parseInt((cells[outputIdx]?.textContent || '').replace(numPattern, ''), 10) || 0
                  : 0
                const total = inputTokens + outputTokens
                if (total > 0) rows.push({ model: modelName, input: inputTokens, output: outputTokens, tokens: total })
              }
            }
            return rows
          }

          // 行指纹：用于判断翻页后表格内容是否真正变化
          function rowsKey(rows) {
            return rows.map(r => r.model + '|' + r.input + '|' + r.output).join(';')
          }

          // 去重写入：同模型同 input/output 的行只计一次
          function pushUnique(rows) {
            let added = 0
            for (const r of rows) {
              const key = r.model + '|' + r.input + '|' + r.output
              if (seen.has(key)) continue
              seen.add(key)
              allRows.push(r)
              added++
            }
            return added
          }

          // 点击"下一页"：优先使用页面分页容器中的下一个按钮（XPath），回退 Ant Design 选择器
          function clickNext() {
            let btn = null
            try {
              btn = document.evaluate(
                '/html/body/div/div[3]/div/div/main/div/div/div[5]/button[2]',
                document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
              ).singleNodeValue
            } catch (e) { btn = null }
            if (!btn) {
              btn = document.querySelector(
                'li.ant-pagination-next:not(.ant-pagination-disabled) button,' +
                'li[class*="next"]:not([class*="disabled"]) button,' +
                'button[aria-label="Next Page"]:not([disabled]),' +
                '.ant-pagination-next:not(.ant-pagination-disabled) a'
              )
            }
            if (!btn) return false
            // 最后一页检测：按钮禁用或父级带 disabled 类
            const parent = btn.closest('li') || btn.parentElement
            const isDisabled = btn.disabled ||
              btn.getAttribute('aria-disabled') === 'true' ||
              (parent && /disabled/i.test(parent.className || ''))
            if (isDisabled) return false
            btn.click()
            return true
          }

          // 解析第一页
          let prevRows = parseCurrentPage()
          pushUnique(prevRows)
          let prevKey = rowsKey(prevRows)

          // 翻页解析后续页，直至最后一页（最多 200 页防死循环）
          for (let page = 1; page < 200; page++) {
            if (!clickNext()) break // 无下一页按钮或已到最后一页

            // 等待表格内容真正变化（最长等待 10 秒，避免页面刷新慢时误判为"未翻页"）
            let rows = null
            for (let i = 0; i < 20; i++) {
              await new Promise(r => setTimeout(r, 500))
              const candidate = parseCurrentPage()
              const key = rowsKey(candidate)
              if (key && key !== prevKey) {
                rows = candidate
                prevKey = key
                break
              }
            }
            if (!rows) break // 内容始终未变化 → 已到最后一页或翻页失败，停止
            pushUnique(rows)
          }

          return JSON.stringify({ models: allRows })
        })()
      `)

      const data = JSON.parse(raw)
      // 解析完成后校验导航版本
      if (navVersion !== undefined && navVersion !== this._navVersion) return
      const wasLoggedIn = this._isLoggedIn
      this._isLoggedIn = true
      this._isUserLoggingIn = false  // 登录成功，重置手动登录标记
      if (!wasLoggedIn && this.onLoginStatusChanged) {
        this.onLoginStatusChanged(this.vendorId, true)
      }

      // 聚合：同一模型的 Token 总数（每行 = input + output）
      const modelTotals = {}
      for (const row of data.models) {
        const name = row.model
        const tokens = row.tokens || 0
        if (tokens > 0) {
          modelTotals[name] = (modelTotals[name] || 0) + tokens
        }
      }

      const models = Object.entries(modelTotals).map(([name, tokens]) => ({ name, tokens }))
      console.log(`[KimiMonitor:${this.vendorId}] 解析到 ${models.length} 个模型，总 Tokens: ${models.reduce((s, m) => s + m.tokens, 0)}`)

      // 通过回调将数据送回主进程
      if (this._callback) {
        this._callback({
          type: 'kimi-dom-parsed',
          url,
          timestamp: new Date().toISOString(),
          vendorId: this.vendorId,
          data: { models }
        })
      }

      // 解析成功后关闭窗口，释放资源（下次刷新时按需重建）
      if (this.monitorWindow && !this.monitorWindow.isDestroyed()) {
        try {
          const s = session.fromPartition(this.partition)
          if (s && typeof s.flushStorageData === 'function') s.flushStorageData()
        } catch { /* 忽略 */ }
        this._destroying = true
        this.monitorWindow.destroy()
        this.monitorWindow = null
        this._destroying = false
        console.log(`[KimiMonitor:${this.vendorId}] 解析完成，窗口已关闭`)
      }
    } catch (e) {
      console.error(`[KimiMonitor:${this.vendorId}] 解析失败:`, e.message)
    }
  }

  // ===================== 用户交互 =====================

  /** 显示登录窗口（由用户手动触发） */
  showLoginWindow() {
    this._isUserLoggingIn = true
    if (!this.monitorWindow || this.monitorWindow.isDestroyed()) {
      // 按需创建并显示
      this._createHiddenWindow().then(() => {
        if (this.monitorWindow) {
          this.monitorWindow.show()
          this.monitorWindow.focus()
        }
      })
      return true
    }
    this.monitorWindow.show()
    this.monitorWindow.webContents.loadURL(KIMI_FEE_URL).catch(() => {})
    console.log(`[KimiMonitor:${this.vendorId}] 用户触发登录窗口`)
    return true
  }

  /** 查询当前登录状态 */
  getStatus() {
    return { active: !!this.monitorWindow, loggedIn: this._isLoggedIn }
  }

  isLoggedIn() {
    return this._isLoggedIn
  }

  // ===================== 内部方法 =====================

  /** 创建隐藏的 BrowserWindow（scheduler 刷新时按需调用） */
  async _createHiddenWindow() {
    if (this.monitorWindow && !this.monitorWindow.isDestroyed()) return

    console.log(`[KimiMonitor:${this.vendorId}] 创建隐藏窗口`)

    this.monitorWindow = new BrowserWindow({
      width: 1060,
      height: 860,
      show: false,
      autoHideMenuBar: true,
      title: `Kimi 用量监控 - ${this.vendorId}`,
      webPreferences: {
        partition: this.partition,
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    this.monitorWindow.on('close', () => {
      try {
        const s = session.fromPartition(this.partition)
        if (s && typeof s.flushStorageData === 'function') s.flushStorageData()
        console.log(`[KimiMonitor:${this.vendorId}] session 已保存`)
      } catch (e) {
        console.warn(`[KimiMonitor:${this.vendorId}] session 保存失败:`, e.message)
      }
      this._clearAllTimers()
    })

    this.monitorWindow.on('closed', () => {
      this.monitorWindow = null
      // 仅在非主动销毁时重置登录状态（解析成功后主动 destroy 不重置）
      if (!this._destroying) {
        this._isLoggedIn = false
      }
    })

    this.monitorWindow.webContents.on('did-finish-load', () => {
      this.handlePageLoaded(this._navVersion)
    })

    await this.monitorWindow.loadURL(KIMI_FEE_URL)
    this._startLoadTimeout()
  }

  _startLoadTimeout() {
    this._clearLoadTimeout()
    this._pageLoadTimeout = setTimeout(() => {
      console.warn(`[KimiMonitor:${this.vendorId}] 页面加载超时 (${PAGE_LOAD_TIMEOUT}ms)`)
    }, PAGE_LOAD_TIMEOUT)
  }

  _clearLoadTimeout() {
    if (this._pageLoadTimeout) {
      clearTimeout(this._pageLoadTimeout)
      this._pageLoadTimeout = null
    }
  }

  _clearAllTimers() {
    this._clearLoadTimeout()
    if (this._refreshTimeout) {
      clearTimeout(this._refreshTimeout)
      this._refreshTimeout = null
    }
  }
}

module.exports = { KimiMonitor }
