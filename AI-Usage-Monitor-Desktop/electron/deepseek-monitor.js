/**
 * DeepSeek 用量页面监听器
 *
 * 通过隐藏窗口加载 DeepSeek 用量页面，利用页面的 Session/Cookie 读取用量数据。
 * 使用 partition: 'persist:deepseek-{vendorId}' 按供应商隔离 session，支持多账号。
 * 每个 DeepSeek 供应商独立窗口、独立登录态，重启后自动恢复。
 */

const { BrowserWindow, session } = require('electron')
const path = require('path')

const DEEPSEEK_USAGE_URL = 'https://platform.deepseek.com/usage'

class DeepSeekMonitor {
  constructor(vendorId) {
    this.vendorId = vendorId || 'default'
    this.partition = `persist:deepseek-${this.vendorId}`
    this.monitorWindow = null
    this.isRunning = false
    this.status = {
      active: false,
      loggedIn: false,
      lastDataAt: null,
      error: null,
      requestCount: 0,
      interceptedUrls: []
    }
    this.onDataCallback = null
    this._navRetryCount = 0
    this._pageReady = false
  }

  start(onDataCallback) {
    if (this.isRunning) return
    this.onDataCallback = onDataCallback
    this.isRunning = true
    this.status.active = true
    this._navRetryCount = 0
    this._pageReady = false
    console.log(`[DS-Monitor:${this.vendorId}] 启动`)
    this.createMonitorWindow()
  }

  async stop() {
    if (!this.isRunning) return
    this.isRunning = false
    this.status.active = false
    if (this.monitorWindow) {
      // 关闭前显式保存 session，确保登录态持久化到磁盘
      try {
        const s = session.fromPartition(this.partition)
        await s.saveStorage()
        console.log(`[DS-Monitor:${this.vendorId}] session 已保存`)
      } catch (e) {
        console.warn(`[DS-Monitor:${this.vendorId}] session 保存失败:`, e.message)
      }
      this.monitorWindow.destroy()
      this.monitorWindow = null
    }
    console.log(`[DS-Monitor:${this.vendorId}] 已停止`)
  }

  // ====== 窗口创建 ======

  createMonitorWindow() {
    this.monitorWindow = new BrowserWindow({
      width: 1200, height: 800, show: false, frame: false,
      icon: path.join(__dirname, '..', 'public', 'square_logo.png'),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: this.partition
      }
    })

    this.monitorWindow.webContents.on('did-start-navigation', (e, url, isInPlace, isMainFrame) => {
      if (isMainFrame && url.includes('platform.deepseek.com')) {
        this.injectInterceptor()
      }
    })

    this.monitorWindow.webContents.on('did-finish-load', () => {
      this.handlePageLoaded()
    })

    console.log(`[DS-Monitor:${this.vendorId}] 加载页面:`, DEEPSEEK_USAGE_URL)
    this.monitorWindow.loadURL(DEEPSEEK_USAGE_URL).catch(err => {
      console.error(`[DS-Monitor:${this.vendorId}] 加载失败:`, err.message)
      this.status.error = err.message
    })
  }

  // ====== 拦截器注入 ======

  injectInterceptor() {
    if (!this.monitorWindow) return

    const script = `
    (function() {
      if (window.__dsMon) return;
      window.__dsMon = { data: [], ready: false };

      function isUsageAPI(url) {
        return url.includes('/usage/by_api_key') ||
               url.includes('/get_user_summary') ||
               url.includes('/get_api_keys');
      }

      var _fetch = window.fetch;
      window.fetch = function() {
        var url = arguments[0];
        if (typeof url !== 'string') url = url?.url || String(url);
        var isTarget = isUsageAPI(url);
        return _fetch.apply(this, arguments).then(function(resp) {
          if (isTarget && resp.ok && resp.clone) {
            resp.clone().text().then(function(text) {
              try {
                var data = JSON.parse(text);
                window.__dsMon.data.push({ url: url, data: data, ts: Date.now() });
              } catch(e) {}
            }).catch(function() {});
          }
          return resp;
        });
      };

      var _open = XMLHttpRequest.prototype.open;
      var _send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(m, url) {
        this._url = url;
        this._target = isUsageAPI(url);
        return _open.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function() {
        if (this._target) {
          this.addEventListener('load', function() {
            if (this.status >= 200 && this.status < 300) {
              try {
                var data = JSON.parse(this.responseText);
                window.__dsMon.data.push({ url: this._url, data: data, ts: Date.now() });
              } catch(e) {}
            }
          });
        }
        return _send.apply(this, arguments);
      };

      window.__dsMon.ready = true;
    })();
    `

    this.monitorWindow.webContents.executeJavaScript(script).catch(() => {})
  }

  // ====== 页面加载处理 ======

  async handlePageLoaded() {
    if (!this.monitorWindow) return

    const url = this.monitorWindow.webContents.getURL()
    console.log(`[DS-Monitor:${this.vendorId}] 页面加载:`, url)

    const isLogin = url.includes('/sign_in') || url.includes('/login') || url.includes('accounts.deepseek.com')

    if (isLogin) {
      this.status.loggedIn = false
      this.status.error = '未登录'
      this._navRetryCount = 0
      this._pageReady = false
      console.log(`[DS-Monitor:${this.vendorId}] 未登录，等待用户手动触发`)
      return
    }

    this.status.loggedIn = true
    this.status.error = null

    if (!url.includes('/usage')) {
      if (this._navRetryCount >= 5) { this._navRetryCount = 0; return }
      this._navRetryCount++
      console.log(`[DS-Monitor:${this.vendorId}] 导航到用量页 (${this._navRetryCount})...`)
      this.monitorWindow.webContents.loadURL(DEEPSEEK_USAGE_URL).catch(() => {})
      return
    }

    this._navRetryCount = 0
    this.monitorWindow.hide()

    await this.sleep(5000)
    await this.readInterceptedData()
    await this.readDomData()

    this._pageReady = true
    // 页面就绪后，由统一调度器 Scheduler 接管定时刷新
    console.log(`[DS-Monitor:${this.vendorId}] 页面就绪，等待调度器接管轮询`)
  }

  sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

  // ====== 数据读取 ======

  async readInterceptedData() {
    if (!this.monitorWindow) return

    try {
      const result = await this.monitorWindow.webContents.executeJavaScript(`
        (function() {
          var d = window.__dsMon?.data || [];
          window.__dsMon.data = [];
          return JSON.stringify(d);
        })()
      `)

      if (!result) return
      const captured = JSON.parse(result)

      if (captured.length === 0) return

      console.log(`[DS-Monitor:${this.vendorId}] 拦截到 ${captured.length} 条 API 数据`)
      for (const item of captured) {
        this.processApiData(item.url, item.data)
      }
    } catch (e) {
      console.warn(`[DS-Monitor:${this.vendorId}] 读取拦截数据失败:`, e.message)
    }
  }

  async readDomData() {
    if (!this.monitorWindow) return

    try {
      const result = await this.monitorWindow.webContents.executeJavaScript(`
        (function() {
          var text = document.body?.innerText || '';
          var r = {};

          var m = text.match(/[¥￥]\\s*([\\d,.]+)/);
          if (m) r.balance = m[1];

          var costMatch = text.match(/累计消费金额[\\s\\S]*?[¥￥]\\s*([\\d,.]+)/);
          if (costMatch) r.totalCost = costMatch[1];

          var reqMatch = text.match(/API 请求次数[\\s]*([\\d,]+)/);
          if (reqMatch) r.totalRequests = reqMatch[1].replace(/,/g, '');

          var tokenMatch = text.match(/Tokens[\\s]*([\\d,]+)/);
          if (tokenMatch) r.totalTokens = tokenMatch[1].replace(/,/g, '');

          r.models = [];
          var modelPattern = /deepseek[\\w-]+/gi;
          // 大小写不敏感去重：页面中同一模型可能以不同大小写出现
          // （如汇总标题 "DeepSeek-V4-Flash" 与明细行 "deepseek-v4-flash"），
          // 若不合并会把汇总位置的总 Tokens 误记为该模型自己的用量
          var modelNames = [...new Set((text.match(modelPattern) || []).map(function(n) { return n.toLowerCase(); }))];
          var lowerText = text.toLowerCase();

          for (var name of modelNames) {
            // 跳过汇总标题（如 "DeepSeek-V4"），只保留具体模型变体（如 "deepseek-v4-flash"）
            // 汇总标题通常不含连字符后的小写变体名
            var suffix = name.replace(/^deepseek[-_]?/i, '');
            // 如果去掉 deepseek 前缀后只剩版本号（如 v4），跳过
            if (/^v?\\d+$/.test(suffix) || /^[-_]?$/.test(suffix)) continue;

            // 找出该模型名在页面文本中的所有出现位置
            var positions = [];
            var searchIdx = 0;
            while (true) {
              var idx = lowerText.indexOf(name, searchIdx);
              if (idx === -1) break;
              positions.push(idx);
              searchIdx = idx + name.length;
            }
            if (positions.length === 0) continue;

            // 从每个出现位置提取候选统计，取 Tokens 最小者作为该模型自身用量
            // （汇总/聚合位置会匹配到总 Tokens，而模型自身累计值一定 ≤ 汇总值）
            var best = null;
            for (var p of positions) {
              var after = text.substring(p, p + 500);
              var cand = {};
              var mReq = after.match(/API 请求次数[\\s]*([\\d,]+)/);
              if (mReq) cand.requests = parseInt(mReq[1].replace(/,/g, ''));
              var mTok = after.match(/Tokens[\\s]*([\\d,]+)/);
              if (mTok) cand.tokens = parseInt(mTok[1].replace(/,/g, ''));
              if (!cand.tokens && !cand.requests) continue;
              if (!best) {
                best = cand;
              } else if (cand.tokens && (!best.tokens || cand.tokens < best.tokens)) {
                best = cand;
              }
            }
            if (!best) continue;

            var modelData = { name: name.replace(/[_]/g, '-') };
            if (best.requests) modelData.requests = best.requests;
            if (best.tokens) modelData.tokens = best.tokens;

            if (modelData.requests || modelData.tokens) {
              r.models.push(modelData);
            }
          }

          return JSON.stringify(r);
        })()
      `)

      if (result) {
        const dom = JSON.parse(result)
        console.log(`[DS-Monitor:${this.vendorId}] DOM 解析:`, JSON.stringify(dom).substring(0, 300))
        this.handleData({
          type: 'dom-usage',
          url: 'dom',
          data: dom,
          timestamp: Date.now()
        })
      }
    } catch (e) {
      console.warn(`[DS-Monitor:${this.vendorId}] DOM 读取失败:`, e.message)
    }
  }

  processApiData(url, data) {
    if (!data) return
    this.status.interceptedUrls.push(url)
    if (this.status.interceptedUrls.length > 30) this.status.interceptedUrls.shift()

    if (url.includes('/usage/by_api_key/amount') && data.data) {
      const items = Array.isArray(data.data) ? data.data : [data.data]
      for (const item of items) this.handleData({ type: 'usage', url, data: item, timestamp: Date.now() })
      return
    }
    if (url.includes('/usage/by_api_key/cost') && data.data) {
      const items = Array.isArray(data.data) ? data.data : [data.data]
      for (const item of items) this.handleData({ type: 'cost', url, data: item, timestamp: Date.now() })
      return
    }
    if (url.includes('/get_user_summary') && data.data) {
      this.handleData({ type: 'summary', url, data: data.data, timestamp: Date.now() })
      return
    }
  }

  handleData(payload) {
    this.status.lastDataAt = new Date().toISOString()
    this.status.requestCount++
    this.status.error = null
    console.log(`[DS-Monitor:${this.vendorId}] >>> 数据捕获: type=${payload.type}`)
    // 注入 vendorId，使下游能区分数据来源
    payload.vendorId = this.vendorId
    if (this.onDataCallback) this.onDataCallback(payload)
  }

  getStatus() { return { ...this.status } }

  refresh() {
    if (this.monitorWindow) {
      this._navRetryCount = 0
      this._pageReady = false
      this.monitorWindow.show()
      this.monitorWindow.webContents.loadURL(DEEPSEEK_USAGE_URL).catch(() => {})
    }
  }

  // 静默刷新：不显示窗口，仅重新加载页面获取最新数据
  refreshNow() {
    if (!this.monitorWindow || !this._pageReady) return false
    const url = this.monitorWindow.webContents.getURL()
    if (!url.includes('/usage')) return false
    console.log(`[DS-Monitor:${this.vendorId}] 手动刷新 — 重新加载用量页`)
    this.monitorWindow.webContents.loadURL(DEEPSEEK_USAGE_URL).catch(() => {})
    return true
  }

  // 显示登录窗口（由用户手动触发）
  showLoginWindow() {
    if (!this.monitorWindow) return false
    this.monitorWindow.show()
    this.monitorWindow.webContents.loadURL(DEEPSEEK_USAGE_URL).catch(() => {})
    console.log(`[DS-Monitor:${this.vendorId}] 用户触发登录窗口`)
    return true
  }

  isLoggedIn() {
    return this.status.loggedIn === true
  }
}

module.exports = DeepSeekMonitor
