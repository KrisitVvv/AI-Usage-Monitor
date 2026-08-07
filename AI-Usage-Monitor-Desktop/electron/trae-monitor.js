/**
 * Trae CN 积分监控
 *
 * 与 DeepSeek/Kimi/MIMO Monitor 对齐：
 * - 通过隐藏 BrowserWindow 加载 Trae CN 用量看板（dashboard#usage），利用页面登录态读取积分
 * - 首次创建窗口 → 用户登录 → 登录态通过 persist partition 持久化，重启自动恢复
 * - 定时刷新看板 → XPath 定位积分区块 → 解析"通用积分"与"Work专属积分" → 回调送回主进程写入缓存
 *
 * 使用 partition: 'persist:trae-{vendorId}' 按供应商隔离 session，支持多账号。
 */

const { BrowserWindow, session } = require('electron')

// Trae CN 积分看板地址（#usage 为积分/用量分区，SPA 路由）
const TRAE_DASHBOARD_URL = 'https://www.trae.cn/dashboard#usage'

// 积分区块 XPath（用户提供）：包含"通用积分"与"work专属积分"卡片
const TRAE_USAGE_SECTION_XPATH = '/html/body/div[1]/div[1]/div[2]/section/div[1]/div[2]/div[4]/div/div[2]/div[1]/div[1]/section'

/** 页面加载/刷新超时（毫秒） */
const PAGE_LOAD_TIMEOUT = 30000
/** DOM 解析后等待稳定时间（毫秒） */
const DOM_SETTLE_DELAY = 3000

class TraeMonitor {
  /**
   * @param {string} vendorId - 对应 vendors.json 中条目的 id
   */
  constructor(vendorId) {
    this.vendorId = vendorId
    /** 分区名：persist: 保证跨会话持久化登录态 */
    this.partition = `persist:trae-${vendorId}`
    /** BrowserWindow（对齐 kimi/mimo-monitor 模式） */
    this.monitorWindow = null
    /** 数据回调（由 start() 注入） */
    this._callback = null
    this.onLoginStatusChanged = null
    /** 登录状态：登录后 cookie 保存在 session 中，不随窗口关闭丢失 */
    this._isLoggedIn = false
    /** 首次加载标记：首次需导航到登录/看板页；后续刷新直接 reload 即可 */
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
   * 被 scheduler 调用：刷新 Trae 积分看板并解析数据。
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
          console.warn(`[TraeMonitor:${this.vendorId}] 无法创建窗口，跳过刷新`)
          return false
        }
      }

      // 用户正在登录时不要刷新，以免 reload() 中断登录跳转
      if (this._isUserLoggingIn || this.monitorWindow.isVisible()) {
        console.log(`[TraeMonitor:${this.vendorId}] 用户正在登录（visible=${this.monitorWindow.isVisible()}），跳过刷新`)
        return false
      }

      this._clearAllTimers()
      this._navVersion++
      const myVersion = this._navVersion
      console.log(`[TraeMonitor:${this.vendorId}] 开始刷新 (nav#${myVersion})...`)

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
          console.warn(`[TraeMonitor:${this.vendorId}] 刷新超时 (${PAGE_LOAD_TIMEOUT}ms)`)
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
      console.error(`[TraeMonitor:${this.vendorId}] 刷新异常:`, e.message)
      return false
    } finally {
      this._refreshing = false
    }
  }

  /**
   * 仅刷新积分（不重新导航），供 60 秒轮询调用。
   * 窗口缺失时按需重建；窗口已在看板页时直接解析当前 DOM。
   * @returns {boolean} true=积分刷新成功
   */
  async refreshBalanceOnly() {
    if (this._refreshing || this._isUserLoggingIn) return false
    if (this.monitorWindow?.isVisible()) return false

    if (!this.monitorWindow || this.monitorWindow.isDestroyed()) {
      await this._createHiddenWindow()
      return !!this.monitorWindow
    }

    this._refreshing = true
    try {
      this._navVersion++
      const myVersion = this._navVersion

      return await new Promise((resolve) => {
        const settleTimer = setTimeout(async () => {
          try {
            const url = this.monitorWindow.webContents.getURL()
            if (url.includes('/dashboard')) {
              await this._parseDashboard(myVersion)
              resolve(true)
            } else {
              this.monitorWindow.webContents.once('did-finish-load', () => {
                this.handlePageLoaded(myVersion)
              })
              this.monitorWindow.webContents.loadURL(TRAE_DASHBOARD_URL)
              resolve(true)
            }
          } catch { resolve(false) }
        }, 1500)

        this._pageLoadTimeout = setTimeout(() => {
          clearTimeout(settleTimer)
          resolve(false)
        }, PAGE_LOAD_TIMEOUT)
      })
    } catch (e) {
      console.error(`[TraeMonitor:${this.vendorId}] 积分刷新异常:`, e.message)
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
      console.log(`[TraeMonitor:${this.vendorId}] 导航已更新 (当前#${this._navVersion} > 传入#${navVersion})，跳过`)
      return
    }

    if (!this.monitorWindow.webContents) return
    const url = this.monitorWindow.webContents.getURL()
    console.log(`[TraeMonitor:${this.vendorId}] 页面加载:`, url)

    // 首次加载完成后立即重置标记，防止登录页停留时 isInitialLoad 一直为 true 导致反复触发导航
    if (this.isInitialLoad) {
      this.isInitialLoad = false
      this._clearLoadTimeout()
    }

    // 检测是否在登录页（基于 URL 与页面文本）
    const isLoginUrl = /login|signin|sign_in|auth|passport/i.test(url)

    let isLoginPage = isLoginUrl
    if (!isLoginPage) {
      try {
        const pageText = await this.monitorWindow.webContents.executeJavaScript(
          'document.body?.innerText?.substring(0, 500) || ""'
        )
        // 内容检测后再次校验导航版本
        if (navVersion !== undefined && navVersion !== this._navVersion) return
        isLoginPage = /登录|扫码|手机号|验证码|账号密码|Sign in|Log in|sign in|log in/.test(pageText)
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
      console.log(`[TraeMonitor:${this.vendorId}] 需要登录${this._isUserLoggingIn ? '（用户登录中，窗口保持可见）' : '，窗口已隐藏，等待用户手动触发'}`)
      return
    }

    // 检测是否在看板页；不是则导航过去
    if (!url.includes('/dashboard')) {
      console.log(`[TraeMonitor:${this.vendorId}] 页面不是看板页，尝试导航...`)
      await this.monitorWindow.loadURL(TRAE_DASHBOARD_URL)
      return
    }

    await this._parseDashboard(navVersion)
  }

  /** 解析积分看板（积分区块 → 提取通用积分与 Work专属积分） */
  async _parseDashboard(navVersion) {
    if (!this.monitorWindow || this.monitorWindow.isDestroyed()) return
    this._clearLoadTimeout()

    // 等待 DOM 渲染稳定
    await new Promise(resolve => setTimeout(resolve, DOM_SETTLE_DELAY))
    // 等待后再次校验导航版本（可能已被新 reload 取代）
    if (navVersion !== undefined && navVersion !== this._navVersion) return

    const url = this.monitorWindow.webContents.getURL()

    // SPA 懒加载：解析不到有效数据时重试几次
    let result = null
    for (let attempt = 0; attempt < 4; attempt++) {
      result = await this._evalCredits()
      if (navVersion !== undefined && navVersion !== this._navVersion) return
      if (result && result.ok && (result.general?.remaining > 0 || result.general?.total > 0 || result.work?.remaining > 0 || result.work?.total > 0)) break
      console.log(`[TraeMonitor:${this.vendorId}] 第 ${attempt + 1} 次解析无有效积分数据，等待重试...`)
      await new Promise(resolve => setTimeout(resolve, 2500))
      if (navVersion !== undefined && navVersion !== this._navVersion) return
    }

    if (result && result.ok) {
      const wasLoggedIn = this._isLoggedIn
      this._isLoggedIn = true
      this._isUserLoggingIn = false  // 解析成功说明已登录
      if (!wasLoggedIn && this.onLoginStatusChanged) {
        this.onLoginStatusChanged(this.vendorId, true)
      }
      console.log(`[TraeMonitor:${this.vendorId}] 解析到积分: 通用=${result.general.remaining}/${result.general.total}, Work=${result.work.remaining}/${result.work.total}`)

      if (this._callback) {
        this._callback({
          type: 'trae-credits',
          url,
          timestamp: new Date().toISOString(),
          vendorId: this.vendorId,
          data: {
            general: result.general,
            work: result.work,
            text: result.text,
            fetchedAt: new Date().toISOString()
          }
        })
      }
    } else {
      const reason = result ? (result.reason || 'no-data') : 'eval-failed'
      console.warn(`[TraeMonitor:${this.vendorId}] 积分解析失败: ${reason}（页面结构可能变化或尚未登录）`)
    }
  }

  /** 执行页面内 JS：定位积分区块并解析"通用积分 / Work专属积分" */
  async _evalCredits() {
    if (!this.monitorWindow || this.monitorWindow.isDestroyed()) return null
    try {
      const raw = await this.monitorWindow.webContents.executeJavaScript(`
        (function() {
          // 1. 定位积分区块（用户提供的 XPath）
          function findSection() {
            try {
              return document.evaluate(
                ${JSON.stringify(TRAE_USAGE_SECTION_XPATH)},
                document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
              ).singleNodeValue;
            } catch (e) { return null; }
          }
          var section = findSection();
          // 2. XPath 失效时全文档兜底：查找同时含"通用"与 Work/专属 关键词的容器
          if (!section) {
            var all = document.querySelectorAll('section, div');
            for (var i = 0; i < all.length; i++) {
              var t = (all[i].innerText || '').trim();
              if (t && t.length > 10 && t.length < 6000 &&
                  /通用/.test(t) && /(Work|work|专属)/.test(t) && /\\d/.test(t)) {
                section = all[i];
                break;
              }
            }
          }
          if (!section) return JSON.stringify({ ok: false, reason: 'section-not-found' });

          var text = (section.innerText || section.textContent || '').trim();
          if (!text) return JSON.stringify({ ok: false, reason: 'empty-section' });

          // 3. 按关键词拆分"通用积分"与"work专属积分"两段
          var gIdx = text.indexOf('通用');
          var wIdx = -1;
          var wKeys = ['Work专属', 'work专属', 'Work 专属', '仅Work', '仅work', 'Work可用', 'work可用', '仅Work可用'];
          for (var k = 0; k < wKeys.length; k++) {
            var idx = text.indexOf(wKeys[k]);
            if (idx !== -1) { wIdx = idx; break; }
          }
          var generalText = gIdx >= 0 ? text.substring(gIdx, wIdx >= 0 ? wIdx : text.length) : '';
          var workText = wIdx >= 0 ? text.substring(wIdx) : '';

          // 4. 解析每段中的 "剩余 / 总量" 对（如 3,938 / 6,000）
          function sumPool(t) {
            var remaining = 0, total = 0, count = 0;
            var re = /([\\d][\\d,]*(?:\\.[\\d]+)?)\\s*\\/\\s*([\\d][\\d,]*(?:\\.[\\d]+)?)/g;
            var m;
            while ((m = re.exec(t)) !== null) {
              var rem = parseFloat(m[1].replace(/,/g, ''));
              var tot = parseFloat(m[2].replace(/,/g, ''));
              if (!isNaN(rem) && !isNaN(tot) && tot > 0) {
                remaining += rem;
                total += tot;
                count++;
              }
            }
            // 兜底：若无 "X / Y" 对，取最后出现的数字作为剩余（无总量时 total = remaining）
            if (count === 0) {
              var nums = (t.match(/\\d[\\d,]*(?:\\.[\\d]+)?/g) || []).map(function(s) { return parseFloat(s.replace(/,/g, '')); });
              if (nums.length > 0) {
                remaining = nums[nums.length - 1];
                total = remaining;
              }
            }
            return { remaining: remaining, total: total };
          }

          var general = sumPool(generalText);
          var work = sumPool(workText);

          return JSON.stringify({
            ok: true,
            text: text.substring(0, 1200),
            general: general,
            work: work
          });
        })()
      `)
      if (!raw) return null
      return JSON.parse(raw)
    } catch (e) {
      console.warn(`[TraeMonitor:${this.vendorId}] 执行解析脚本失败:`, e.message)
      return null
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
    this.monitorWindow.webContents.loadURL(TRAE_DASHBOARD_URL).catch(() => {})
    console.log(`[TraeMonitor:${this.vendorId}] 用户触发登录窗口`)
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

    console.log(`[TraeMonitor:${this.vendorId}] 创建隐藏窗口`)

    this.monitorWindow = new BrowserWindow({
      width: 1060,
      height: 860,
      show: false,
      autoHideMenuBar: true,
      title: `Trae CN 积分监控 - ${this.vendorId}`,
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
        console.log(`[TraeMonitor:${this.vendorId}] session 已保存`)
      } catch (e) {
        console.warn(`[TraeMonitor:${this.vendorId}] session 保存失败:`, e.message)
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

    await this.monitorWindow.loadURL(TRAE_DASHBOARD_URL)
    this._startLoadTimeout()
  }

  _startLoadTimeout() {
    this._clearLoadTimeout()
    this._pageLoadTimeout = setTimeout(() => {
      console.warn(`[TraeMonitor:${this.vendorId}] 页面加载超时 (${PAGE_LOAD_TIMEOUT}ms)`)
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

module.exports = TraeMonitor
