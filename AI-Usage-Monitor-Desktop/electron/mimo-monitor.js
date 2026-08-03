/**
 * XIAOMI MIMO 余额监控
 *
 * 与 DeepSeek/Kimi Monitor 对齐：
 * - 通过隐藏 BrowserWindow 加载 MIMO 控制台余额页，利用页面登录态读取余额
 * - 首次创建窗口 → 用户登录 → 登录态通过 persist partition 持久化，重启自动恢复
 * - 定时刷新余额页 → XPath 解析余额元素 → 回调送回主进程写入缓存
 *
 * 使用 partition: 'persist:mimo-{vendorId}' 按供应商隔离 session，支持多账号。
 */

const { BrowserWindow, session } = require('electron')

// MIMO 控制台余额页地址
const MIMO_BALANCE_URL = 'https://platform.xiaomimimo.com/console/balance'

// 余额元素 XPath（用户提供）：/html/body/div/div/div/div/main/div/div/div/div/div/div[1]/div[2]/div/div[1]/div/div[1]/p
const MIMO_BALANCE_XPATH = '/html/body/div/div/div/div/main/div/div/div/div/div/div[1]/div[2]/div/div[1]/div/div[1]/p'

/** 页面加载/刷新超时（毫秒） */
const PAGE_LOAD_TIMEOUT = 30000
/** DOM 解析后等待稳定时间（毫秒） */
const DOM_SETTLE_DELAY = 3000

class MimoMonitor {
  /**
   * @param {string} vendorId - 对应 vendors.json 中条目的 id
   */
  constructor(vendorId) {
    this.vendorId = vendorId
    /** 分区名：persist: 保证跨会话持久化登录态 */
    this.partition = `persist:mimo-${vendorId}`
    /** BrowserWindow（对齐 kimi-monitor 模式） */
    this.monitorWindow = null
    /** 数据回调（由 start() 注入） */
    this._callback = null
    this.onLoginStatusChanged = null
    /** 登录状态：登录后 cookie 保存在 session 中，不随窗口关闭丢失 */
    this._isLoggedIn = false
    /** 首次加载标记：首次需导航到登录/余额页；后续刷新直接 reload 即可 */
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
   * 被 scheduler 调用：刷新 MIMO 余额页并解析数据。
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
          console.warn(`[MimoMonitor:${this.vendorId}] 无法创建窗口，跳过刷新`)
          return false
        }
      }

      // 用户正在登录时不要刷新，以免 reload() 中断登录跳转
      if (this._isUserLoggingIn || this.monitorWindow.isVisible()) {
        console.log(`[MimoMonitor:${this.vendorId}] 用户正在登录（visible=${this.monitorWindow.isVisible()}），跳过刷新`)
        return false
      }

      this._clearAllTimers()
      this._navVersion++
      const myVersion = this._navVersion
      console.log(`[MimoMonitor:${this.vendorId}] 开始刷新 (nav#${myVersion})...`)

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
          console.warn(`[MimoMonitor:${this.vendorId}] 刷新超时 (${PAGE_LOAD_TIMEOUT}ms)`)
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
      console.error(`[MimoMonitor:${this.vendorId}] 刷新异常:`, e.message)
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
      console.log(`[MimoMonitor:${this.vendorId}] 导航已更新 (当前#${this._navVersion} > 传入#${navVersion})，跳过`)
      return
    }

    if (!this.monitorWindow.webContents) return
    const url = this.monitorWindow.webContents.getURL()
    console.log(`[MimoMonitor:${this.vendorId}] 页面加载:`, url)

    // 首次加载完成后立即重置标记，防止登录页停留时 isInitialLoad 一直为 true 导致反复触发导航
    if (this.isInitialLoad) {
      this.isInitialLoad = false
      this._clearLoadTimeout()
    }

    // 检测是否在登录页（基于 URL 与页面文本）
    const isLoginUrl = /login|signin|sign_in|auth/i.test(url)

    let isLoginPage = isLoginUrl
    if (!isLoginPage) {
      try {
        const pageText = await this.monitorWindow.webContents.executeJavaScript(
          'document.body?.innerText?.substring(0, 500) || ""'
        )
        // 内容检测后再次校验导航版本
        if (navVersion !== undefined && navVersion !== this._navVersion) return
        isLoginPage = /登录|扫码登录|手机号|验证码|账号密码|Sign in|Log in|sign in|log in/.test(pageText)
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
      console.log(`[MimoMonitor:${this.vendorId}] 需要登录${this._isUserLoggingIn ? '（用户登录中，窗口保持可见）' : '，窗口已隐藏，等待用户手动触发'}`)
      return
    }

    // 检测是否在正确的余额页
    if (!url.includes('/console/balance')) {
      console.log(`[MimoMonitor:${this.vendorId}] 页面不是余额页，尝试导航...`)
      await this.monitorWindow.loadURL(MIMO_BALANCE_URL)
      return
    }

    this._clearLoadTimeout()

    // 等待 DOM 渲染稳定
    await new Promise(resolve => setTimeout(resolve, DOM_SETTLE_DELAY))
    // 等待后再次校验导航版本（可能已被新 reload 取代）
    if (navVersion !== undefined && navVersion !== this._navVersion) return

    // 解析余额元素（用户指定的 XPath）
    try {
      const raw = await this.monitorWindow.webContents.executeJavaScript(`
        (function() {
          var el = null;
          try {
            var res = document.evaluate(
              ${JSON.stringify(MIMO_BALANCE_XPATH)},
              document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
            );
            el = res.singleNodeValue;
          } catch (e) { el = null; }
          if (!el) return null;

          var text = (el.textContent || el.innerText || '').trim();
          // 提取数字（兼容 "¥ 123.45" / "123.45 元" / "1,234.56" 等格式）
          var m = text.replace(/[,，\\s]/g, '').match(/(\\d+(?:\\.\\d+)?)/);
          if (!m) return null;
          return JSON.stringify({ balance: parseFloat(m[1]), text: text });
        })()
      `)
      if (navVersion !== undefined && navVersion !== this._navVersion) return
      const data = raw ? JSON.parse(raw) : null

      if (data && typeof data.balance === 'number') {
        const wasLoggedIn = this._isLoggedIn
        this._isLoggedIn = true
        this._isUserLoggingIn = false  // 登录成功，重置手动登录标记
        if (!wasLoggedIn && this.onLoginStatusChanged) {
          this.onLoginStatusChanged(this.vendorId, true)
        }
        console.log(`[MimoMonitor:${this.vendorId}] 解析到余额: ${data.text || data.balance}`)

        if (this._callback) {
          this._callback({
            type: 'mimo-balance',
            url,
            timestamp: new Date().toISOString(),
            vendorId: this.vendorId,
            data
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
          console.log(`[MimoMonitor:${this.vendorId}] 解析完成，窗口已关闭`)
        }
      } else {
        console.warn(`[MimoMonitor:${this.vendorId}] 未解析到余额元素（页面结构可能变化或尚未登录）`)
      }
    } catch (e) {
      console.error(`[MimoMonitor:${this.vendorId}] 余额解析失败:`, e.message)
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
    this.monitorWindow.webContents.loadURL(MIMO_BALANCE_URL).catch(() => {})
    console.log(`[MimoMonitor:${this.vendorId}] 用户触发登录窗口`)
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

    console.log(`[MimoMonitor:${this.vendorId}] 创建隐藏窗口`)

    this.monitorWindow = new BrowserWindow({
      width: 1060,
      height: 860,
      show: false,
      autoHideMenuBar: true,
      title: `XIAOMI MIMO 余额监控 - ${this.vendorId}`,
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
        console.log(`[MimoMonitor:${this.vendorId}] session 已保存`)
      } catch (e) {
        console.warn(`[MimoMonitor:${this.vendorId}] session 保存失败:`, e.message)
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

    await this.monitorWindow.loadURL(MIMO_BALANCE_URL)
    this._startLoadTimeout()
  }

  _startLoadTimeout() {
    this._clearLoadTimeout()
    this._pageLoadTimeout = setTimeout(() => {
      console.warn(`[MimoMonitor:${this.vendorId}] 页面加载超时 (${PAGE_LOAD_TIMEOUT}ms)`)
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

module.exports = MimoMonitor
