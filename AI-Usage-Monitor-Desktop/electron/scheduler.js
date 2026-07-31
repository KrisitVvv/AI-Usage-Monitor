/**
 * 统一调度器
 *
 * 集中管理所有供应商的数据采集和页面刷新任务：
 * - 余额采集：通过 API 获取余额，默认每 30 秒
 * - 页面刷新：刷新用量页面获取最新 token 数据，默认每 10 分钟
 * - 统一手动刷新：一次性触发所有采集和刷新
 *
 * 后续加入 KIMI 等新供应商时，只需注册对应的 Monitor 实例即可，
 * 调度器会自动将其纳入轮询和统一刷新。
 */

class Scheduler {
  constructor() {
    /** @type {ReturnType<typeof setInterval>|null} */
    this._balanceTimer = null
    /** @type {ReturnType<typeof setInterval>|null} */
    this._pageRefreshTimer = null
    /** @type {Map<string, any>} vendorId → Monitor 实例 */
    this._monitors = new Map()
    /** @type {Function|null} collectAll 函数引用 */
    this._collectFn = null
    /** @type {Function|null} 数据推送回调 (channel, data) */
    this._onDataFn = null

    // ===== 可配置间隔 =====
    /** 余额采集间隔（毫秒） */
    this.balanceIntervalMs = 30 * 1000
    /** 用量页面刷新间隔（毫秒） */
    this.pageRefreshIntervalMs = 10 * 60 * 1000
    /** 页面刷新对齐的分钟粒度（每 N 分钟整点执行） */
    this.pageRefreshAlignMinutes = 10
  }

  /**
   * 初始化：注入依赖
   * @param {Object} opts
   * @param {Function} opts.collectFn - collectAll 函数
   * @param {Function} opts.onDataFn  - (channel: string, data: any) => void
   */
  init({ collectFn, onDataFn }) {
    this._collectFn = collectFn
    this._onDataFn = onDataFn
  }

  // ===== 供应商监控实例注册 =====

  /**
   * 注册供应商监控实例（自动纳入轮询）
   * @param {string} vendorId
   * @param {object} monitor - 必须有 refreshNow(): boolean 方法
   */
  registerMonitor(vendorId, monitor) {
    if (this._monitors.has(vendorId)) return
    this._monitors.set(vendorId, monitor)
    console.log(`[Scheduler] 注册监控实例: ${vendorId}（共 ${this._monitors.size} 个）`)
  }

  /**
   * 注销供应商监控实例
   * @param {string} vendorId
   */
  unregisterMonitor(vendorId) {
    if (!this._monitors.has(vendorId)) return
    this._monitors.delete(vendorId)
    console.log(`[Scheduler] 注销监控实例: ${vendorId}（剩余 ${this._monitors.size} 个）`)
  }

  // ===== 余额采集 =====

  /** 启动余额定时采集 */
  startBalancePolling() {
    if (this._balanceTimer) return
    this._collectBalance()
    this._balanceTimer = setInterval(() => this._collectBalance(), this.balanceIntervalMs)
    console.log(`[Scheduler] 余额采集已启动（每 ${this.balanceIntervalMs / 1000}s）`)
  }

  /**
   * 执行一次余额采集并推送前端
   * @returns {Promise<object>} 采集结果
   */
  async collectBalance() {
    return this._collectBalance()
  }

  async _collectBalance() {
    if (!this._collectFn) return null
    try {
      const data = await this._collectFn()
      this._onDataFn?.('usage-data-updated', data)
      return data
    } catch (e) {
      const errData = {
        vendors: [],
        errors: [`采集失败: ${e.message}`],
        lastCollect: new Date().toISOString()
      }
      this._onDataFn?.('usage-data-updated', errData)
      return errData
    }
  }

  // ===== 页面刷新（所有已注册监控实例） =====

  /** 启动页面定时刷新（对齐到整 N 分钟刻度） */
  startPageRefreshPolling() {
    if (this._pageRefreshTimer) return

    const now = new Date()
    const alignMin = this.pageRefreshAlignMinutes
    const msToNext = (alignMin - (now.getMinutes() % alignMin)) * 60 * 1000
      - now.getSeconds() * 1000 - now.getMilliseconds()

    this._pageRefreshTimer = setTimeout(() => {
      this._refreshAllPages()
      this._pageRefreshTimer = setInterval(
        () => this._refreshAllPages(),
        this.pageRefreshIntervalMs
      )
    }, msToNext)

    console.log(
      `[Scheduler] 页面刷新已启动（每 ${this.pageRefreshIntervalMs / 60000}min，` +
      `${Math.round(msToNext / 1000)}s 后首次执行）`
    )
  }

  /** 刷新所有已注册的供应商页面 */
  _refreshAllPages() {
    console.log(`[Scheduler] 刷新 ${this._monitors.size} 个供应商页面...`)
    for (const [vendorId, monitor] of this._monitors) {
      try {
        const ok = monitor.refreshNow()
        if (!ok) {
          console.log(`[Scheduler]   ${vendorId}: 跳过（页面未就绪）`)
        }
      } catch (e) {
        console.warn(`[Scheduler]   ${vendorId}: 刷新失败 - ${e.message}`)
      }
    }
  }

  // ===== 统一手动刷新 =====

  /**
   * 统一手动刷新：页面刷新 + 余额采集，一次性触发
   * @returns {Promise<{pageRefreshed: boolean, balanceData: object|null}>}
   */
  async manualRefresh() {
    console.log('[Scheduler] === 统一手动刷新 ===')
    // 1. 刷新所有供应商页面
    this._refreshAllPages()
    // 2. 立即采集一次余额
    const balanceData = await this._collectBalance()
    return {
      pageRefreshed: this._monitors.size > 0,
      balanceData
    }
  }

  // ===== 生命周期 =====

  /** 停止所有定时器（不清除注册的监控实例） */
  stop() {
    if (this._balanceTimer) {
      clearInterval(this._balanceTimer)
      this._balanceTimer = null
    }
    if (this._pageRefreshTimer) {
      clearInterval(this._pageRefreshTimer)
      this._pageRefreshTimer = null
    }
    console.log('[Scheduler] 所有定时器已停止')
  }

  /** 获取调度器运行状态 */
  getStatus() {
    return {
      balancePolling: !!this._balanceTimer,
      pageRefreshPolling: !!this._pageRefreshTimer,
      monitorCount: this._monitors.size,
      balanceIntervalMs: this.balanceIntervalMs,
      pageRefreshIntervalMs: this.pageRefreshIntervalMs
    }
  }
}

module.exports = Scheduler
