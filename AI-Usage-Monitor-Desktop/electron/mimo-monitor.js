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

// MIMO 控制台用量页地址
const MIMO_USAGE_URL = 'https://platform.xiaomimimo.com/console/usage'

// 余额元素 XPath（用户提供）：/html/body/div/div/div/div/main/div/div/div/div/div/div[1]/div[2]/div/div[1]/div/div[1]/p
const MIMO_BALANCE_XPATH = '/html/body/div/div/div/div/main/div/div/div/div/div/div[1]/div[2]/div/div[1]/div/div[1]/p'

// 用量页切换按钮 XPath（用户提供）：点击后进入"模型-天"视图
const MIMO_USAGE_TOGGLE_XPATH = '/html/body/div/div/div/div/main/div/div/div/div/div/div[2]/div[1]/div/div[1]/div[3]/div/div[2]/div[2]/label[2]'

// 用量页数据容器 XPath（用户提供）：包含各模型的用量记录
const MIMO_USAGE_CONTAINER_XPATH = '/html/body/div/div/div/div/main/div/div/div/div/div/div[2]/div[2]'

// 用量页表格 XPath（用户提供）：Token 用量数据在 th[8]（第 9 列）下
const MIMO_USAGE_TABLE_XPATH = '/html/body/div/div/div/div/main/div/div/div/div/div/div[2]/div[2]/div[3]/div/div/div/div/div/div/div/div/div/table'

// 用量表格中 Token 用量列的固定列号（0 基，对应 thead 中第 9 个 th）
const MIMO_USAGE_TOKEN_COLUMN = 8

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

  /**
   * 仅刷新余额（不触发用量页解析），供30秒轮询调用。
   *
   * 说明：MimoMonitor 在每次用量解析完成后会主动销毁窗口（_destroyWindowAfterParse），
   * 导致窗口长时间不存在。若 30 秒轮询时窗口已被销毁直接 return，余额将永远无法
   * 按 30 秒频率刷新。因此这里在窗口缺失时按需重建窗口，保证余额持续更新。
   * @returns {boolean} true=余额刷新成功
   */
  async refreshBalanceOnly() {
    if (this._refreshing || this._isUserLoggingIn) return false
    if (this.monitorWindow?.isVisible()) return false

    // 窗口已被销毁（用量解析后正常销毁）→ 按需重建，30秒轮询即可刷新余额
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
            if (url.includes('/console/balance')) {
              await this._parseBalancePage(myVersion)
              resolve(true)
            } else {
              this.monitorWindow.webContents.once('did-finish-load', () => {
                this.handlePageLoaded(myVersion)
              })
              this.monitorWindow.webContents.loadURL(MIMO_BALANCE_URL)
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
      console.error(`[MimoMonitor:${this.vendorId}] 余额刷新异常:`, e.message)
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

    // 按 URL 路由到对应监控页
    if (url.includes('/console/balance')) {
      await this._parseBalancePage(navVersion)
      return
    }
    if (url.includes('/console/usage')) {
      await this._parseUsagePage(navVersion)
      return
    }

    // 其他页面（登录跳转中间态等）→ 导航到余额页开始
    console.log(`[MimoMonitor:${this.vendorId}] 页面不是监控页，尝试导航...`)
    await this.monitorWindow.loadURL(MIMO_BALANCE_URL)
  }

  /** 解析余额页（余额 → 继续导航用量页） */
  async _parseBalancePage(navVersion) {
    if (!this.monitorWindow || this.monitorWindow.isDestroyed()) return
    this._clearLoadTimeout()

    // 等待 DOM 渲染稳定
    await new Promise(resolve => setTimeout(resolve, DOM_SETTLE_DELAY))
    // 等待后再次校验导航版本（可能已被新 reload 取代）
    if (navVersion !== undefined && navVersion !== this._navVersion) return

    const url = this.monitorWindow.webContents.getURL()

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
      } else {
        console.warn(`[MimoMonitor:${this.vendorId}] 未解析到余额元素（页面结构可能变化或尚未登录）`)
      }
    } catch (e) {
      console.error(`[MimoMonitor:${this.vendorId}] 余额解析失败:`, e.message)
    }

    // 无论余额解析是否成功，继续解析用量页（两页共用一次窗口，减少开销）
    try {
      await this.monitorWindow.loadURL(MIMO_USAGE_URL)
    } catch (e) {
      console.error(`[MimoMonitor:${this.vendorId}] 导航到用量页失败:`, e.message)
      this._destroyWindowAfterParse()
    }
  }

  /** 解析用量页（点击切换按钮 → 提取模型-天用量数据） */
  async _parseUsagePage(navVersion) {
    if (!this.monitorWindow || this.monitorWindow.isDestroyed()) return
    this._clearLoadTimeout()

    // 等待 DOM 渲染稳定
    await new Promise(resolve => setTimeout(resolve, DOM_SETTLE_DELAY))
    // 等待后再次校验导航版本
    if (navVersion !== undefined && navVersion !== this._navVersion) return

    const url = this.monitorWindow.webContents.getURL()

    try {
      // 1. 点击切换按钮（若已激活则跳过，避免来回切换）
      const clickResult = await this.monitorWindow.webContents.executeJavaScript(`
        (function() {
          var label = null;
          try {
            label = document.evaluate(
              ${JSON.stringify(MIMO_USAGE_TOGGLE_XPATH)},
              document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
            ).singleNodeValue;
          } catch (e) { label = null; }
          if (!label) return 'not-found';
          var input = label.querySelector('input');
          var active = /active|checked|selected/i.test(label.className || '') ||
            label.getAttribute('aria-checked') === 'true' ||
            (input && input.checked);
          if (active) return 'already-active';
          label.click();
          return 'clicked';
        })()
      `)
      console.log(`[MimoMonitor:${this.vendorId}] 用量页切换按钮: ${clickResult}`)

      // 2. 等待切换后数据刷新
      await new Promise(resolve => setTimeout(resolve, 2000))
      if (navVersion !== undefined && navVersion !== this._navVersion) return

      // 3. 解析容器中的模型-天数据
      const raw = await this.monitorWindow.webContents.executeJavaScript(`
        (async () => {
          const container = document.evaluate(
            ${JSON.stringify(MIMO_USAGE_CONTAINER_XPATH)},
            document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
          ).singleNodeValue;
          if (!container) return JSON.stringify({ ok: false, reason: 'container-not-found' });

          // 解析 token 数值：支持 30万 / 7.5万 / 1.2M / 3,000 / 5000 / 12.3亿
          function parseTokens(str) {
            var clean = String(str).replace(/[,，\\s]/g, '');
            var m = clean.match(/(\\d+(?:\\.\\d+)?)\\s*([万亿wWkKmM])?/i);
            if (!m) return null;
            var n = parseFloat(m[1]);
            var unit = (m[2] || '').toLowerCase();
            if (unit === '万' || unit === 'w') n *= 10000;
            else if (unit === '亿' || unit === 'y') n *= 100000000;
            else if (unit === 'k') n *= 1000;
            else if (unit === 'm') n *= 1000000;
            return Math.round(n);
          }

          // 从整段文本中选出最可能的 Token 数值：
          // 优先"带单位或紧邻 token 关键字"的数（如 30万 / 335466Token），其次取最大值（排除模型名中的版本号如 v2.5）
          function extractTokenCount(text) {
            var clean = String(text).replace(/[,，\\s]/g, '');
            var regex = /(\\d+(?:\\.\\d+)?)\\s*([万亿wWkKmM])?\\s*(?:token|tokens)?/gi;
            var best = null;
            var m;
            while ((m = regex.exec(clean)) !== null) {
              if (!m[1]) continue;
              var n = parseTokens(m[0]);
              if (n === null || n <= 0) continue;
              var score = 0;
              if (/token/i.test(m[0])) score += 100;   // 紧邻 token 关键字
              if (m[2]) score += 10;                    // 带 万/K/M 单位
              score += n / 1000000;                     // 数值大的更可能是用量
              if (!best || score > best.score) best = { n: n, raw: m[0], score: score };
            }
            return best;
          }

          // 模型名校验：过滤页面上的聚合行/统计标签/说明文字
          function isValidModelName(name) {
            if (!name) return false;
            if (name.length > 40) return false;
            if (!/[a-zA-Z0-9]/.test(name)) return false; // 必须含字母或数字（v2.5 / mimo-v3）
            if (/^mimo-v(?!\d)/i.test(name)) return false;  // mimo-v 后必须跟数字才有效（拒绝 mimo-v-pro0 等）
            if (/总消耗|总体消费|总用量|单模型|模型消费|消费总金额|请求次数|插件调用|调用次数|暂无数据|日期为|UTC|小计|合计|共\s*\d+|条记录|下一页|上一页|加载中|今日|昨日/.test(name)) return false;
            // 名称中不应再出现带单位的数值（如 "v2.5v37万" 这类拼接残留）
            if (/(\\d+(?:\\.\\d+)?)\\s*[万亿wWkKmM]/i.test(name)) return false;
            // 拒绝"纯数字 + 单个字母"的拼接残留（如 42096136s —— 数值被误当模型名）
            if (/^\\d+[a-zA-Z]$/.test(name)) return false;
            // 拒绝纯数字的"模型名"（如 42096136 —— token 数值被读进模型名列）
            if (/^\\d+$/.test(name)) return false;
            // 拒绝纯日期（如 2026-08-03 / 8-3）
            if (/^\\d{4}[-/年]\\d{1,2}[-/月]\\d{1,2}$/.test(name)) return false;
            if (/^\\d{1,2}[-/]\\d{1,2}$/.test(name)) return false;
            return true;
          }

          // 判断一个叶子元素是否承载"用量数值"（排除模型名里的版本号）
          function isCountCarrier(text) {
            var clean = String(text).replace(/[,，\\s]/g, '');
            var m = clean.match(/(\\d+(?:\\.\\d+)?)\\s*([万亿wWkKmM])?\\s*(?:token|tokens)?/i);
            if (!m) return false;
            if (m[2]) return true;                       // 带单位
            if (/token/i.test(m[0])) return true;        // 带 token 关键字
            var idx = clean.indexOf(m[1]);
            if (idx > 0 && /[a-zA-Z]/.test(clean[idx - 1])) return false; // 数字紧跟字母 → 版本号/模型名一部分
            return true;
          }

          var models = {};
          var rowKeys = new Set();

          // ===== 方案 A：表格 =====
          // 优先使用用户指定的精确表格 XPath（Token 用量在 th[8] 列）
          var exactTable = null;
          try {
            exactTable = document.evaluate(
              ${JSON.stringify(MIMO_USAGE_TABLE_XPATH)},
              document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
            ).singleNodeValue;
          } catch (e) { exactTable = null; }

          var tables = [];
          if (exactTable) tables.push(exactTable);
          else tables = Array.from(container.querySelectorAll('table'));

          var tableHit = false;
          for (var ti = 0; ti < tables.length; ti++) {
            var table = tables[ti];
            var headerCells = table.querySelectorAll('thead th, thead td');
            if (headerCells.length === 0) {
              var firstRow = table.querySelector('tr');
              if (firstRow) headerCells = firstRow.querySelectorAll('th, td');
            }
            if (headerCells.length < 2) continue;
            var nameIdx = -1, tokenIdx = -1;
            for (var hi = 0; hi < headerCells.length; hi++) {
              var htext = (headerCells[hi].textContent || '').trim().toLowerCase();
              if (/模型|model|名称|name/.test(htext)) nameIdx = hi;
              if (/token|tokens|用量|消耗|使用/.test(htext)) tokenIdx = hi;
            }
            if (ti === 0 && exactTable && headerCells.length > ${JSON.stringify(MIMO_USAGE_TOKEN_COLUMN)}) {
              // 精确表格：Token 列固定为 th[8]（用户指定），避免关键字误匹配到输入/输出等列
              tokenIdx = ${JSON.stringify(MIMO_USAGE_TOKEN_COLUMN)};
              if (nameIdx === -1) nameIdx = 1; // 模型名列未识别时假设为第 2 列
            } else if (tokenIdx === -1 && headerCells.length > ${JSON.stringify(MIMO_USAGE_TOKEN_COLUMN)}) {
              // 其他表格：表头关键字未命中但列数充足时，同样按固定列兜底
              tokenIdx = ${JSON.stringify(MIMO_USAGE_TOKEN_COLUMN)};
              if (nameIdx === -1) nameIdx = 1;
            }
            if (tokenIdx === -1) continue;
            var dataRows = table.querySelectorAll('tbody tr');
            if (dataRows.length === 0) dataRows = Array.from(table.querySelectorAll('tr')).slice(1);
            for (var ri = 0; ri < dataRows.length; ri++) {
              var cells = dataRows[ri].querySelectorAll('td');
              if (nameIdx >= 0 && cells.length <= Math.max(nameIdx, tokenIdx)) continue;
              var name = nameIdx >= 0 ? (cells[nameIdx]?.textContent || '').trim() : '';
              var tokens = parseTokens(nameIdx >= 0 ? (cells[tokenIdx]?.textContent || '') : (dataRows[ri].textContent || ''));
              if (!tokens || tokens <= 0) continue;
              if (!name || !isValidModelName(name)) {
                // 模型名列未识别/无效：遍历本行其他单元格寻找合法模型名
                var foundName = null;
                for (var ci = 0; ci < cells.length; ci++) {
                  if (ci === tokenIdx) continue;
                  var cn = (cells[ci]?.textContent || '').trim();
                  if (cn && isValidModelName(cn)) { foundName = cn; break; }
                }
                if (!foundName) continue;
                name = foundName;
              }
              var key = 'row:' + name;
              if (rowKeys.has(key)) continue;
              rowKeys.add(key);
              models[name] = (models[name] || 0) + tokens;
              tableHit = true;
            }
          }

          // ===== 方案 B：非表格行（卡片/列表） =====
          if (!tableHit || Object.keys(models).length === 0) {
            // 从数值叶子元素向上找最近的合格"行"（包含模型名 + 用量）
            function findRowRecord(el) {
              var cur = el;
              while (cur && cur !== container) {
                var text = (cur.textContent || '').trim();
                if (text && text.length <= 80) {
                  var tk = extractTokenCount(text);
                  if (tk) {
                    var name = text.replace(tk.raw, '').replace(/[,，\\s]/g, '').replace(/token|tokens/gi, '').replace(/[:：]/g, '').trim();
                    if (isValidModelName(name)) return { name: name, num: tk.n };
                  }
                }
                cur = cur.parentElement;
              }
              return null;
            }

            var all = container.querySelectorAll('*');
            for (var ei = 0; ei < all.length; ei++) {
              var el = all[ei];
              var text = (el.textContent || '').trim();
              if (!text || text.length > 80) continue;
              if (!isCountCarrier(text)) continue;
              var rec = findRowRecord(el);
              if (!rec) continue;
              var rk = 'el:' + rec.name;
              if (rowKeys.has(rk)) continue;
              rowKeys.add(rk);
              models[rec.name] = (models[rec.name] || 0) + rec.num;
            }
          }

          var result = Object.entries(models).map(function (e) { return { name: e[0], tokens: e[1] }; });
          return JSON.stringify({ ok: true, models: result });
        })()
      `)
      if (navVersion !== undefined && navVersion !== this._navVersion) return
      const result = raw ? JSON.parse(raw) : null

      if (result && result.ok !== false) {
        const models = result.models || []
        const wasLoggedIn = this._isLoggedIn
        this._isLoggedIn = true
        this._isUserLoggingIn = false  // 解析成功说明已登录
        if (!wasLoggedIn && this.onLoginStatusChanged) {
          this.onLoginStatusChanged(this.vendorId, true)
        }
        const total = models.reduce((s, m) => s + (m.tokens || 0), 0)
        console.log(`[MimoMonitor:${this.vendorId}] 解析到 ${models.length} 个模型的用量，总 Tokens: ${total}`)

        if (this._callback) {
          this._callback({
            type: 'mimo-dom-parsed',
            url,
            timestamp: new Date().toISOString(),
            vendorId: this.vendorId,
            data: { models }
          })
        }
      } else {
        console.warn(`[MimoMonitor:${this.vendorId}] 用量解析失败: ${(result && result.reason) || '未知原因'}（页面结构可能变化）`)
      }
    } catch (e) {
      console.error(`[MimoMonitor:${this.vendorId}] 用量页解析失败:`, e.message)
    }

    // 解析完成，关闭窗口释放资源（下次刷新时按需重建）
    this._destroyWindowAfterParse()
  }

  /** 销毁监控窗口（保留持久化 session） */
  _destroyWindowAfterParse() {
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
