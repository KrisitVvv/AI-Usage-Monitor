const path = require('path')
const fs = require('fs')
const { app } = require('electron')

const VENDORS_FILE_NAME = 'vendors.json'
const CACHE_FILE_NAME = 'usage-cache.json'
const TOKEN_STATS_FILE_NAME = 'token-usage.json'

// 数据保留天数（超过此天数的 daily 记录将被清理，但每周/每月/每年的聚合数据保留）
const DAILY_RETENTION_DAYS = 90
// 单日最大原始记录条数
const MAX_RECORDS_PER_DAY = 500
// 写入节流间隔（毫秒）——高频记录时合并磁盘写入
const WRITE_THROTTLE_MS = 2000

let writeTimer = null
let pendingData = null
let statsCache = null

// 无效模型名模式：DOM/表格解析可能把 token 数值（42096136s / 42096136）或
// 错误占位（undefined）误当模型名，记录前统一过滤
const INVALID_MODEL_NAME_PATTERNS = [
  /error/i, /fail/i, /invalid/i, /undefined/i, /null/i,
  /^[\s\-_]+$/,               // 纯空白或特殊字符
  /<[^>]+>/,                  // HTML 标签
  /^\d+$/,                    // 纯数字（token 数值被读成模型名）
  /^\d+[a-zA-Z]$/,            // 数字+单个字母拼接残留（42096136s）
  /^sk-[a-zA-Z0-9]/,          // API key 被误解析为模型名（如 sk-cjdtp8***whliai）
  /^mimo-v(?!\d)/i,           // MIMO 残缺模型名（mimo-v / mimo-v-pro0 等），必须 v 后跟数字才有效
  /总消耗|总体消费|总用量|单模型|模型消费|消费总金额|请求次数|插件调用|调用次数|暂无数据|小计|合计|条记录|下一页|上一页|加载中|今日|昨日|日期为|UTC/
]

function getUserDataPath(filename) {
  return path.join(app.getPath('userData'), filename)
}

/** 安全读取 JSON 文件，文件不存在或损坏均返回 fallback */
function safeReadJSON(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback
    const raw = fs.readFileSync(filePath, 'utf-8')
    if (!raw || !raw.trim()) return fallback
    return JSON.parse(raw)
  } catch (e) {
    console.warn(`[safeRead] 文件读取/解析失败 ${path.basename(filePath)}: ${e.message}`)
    return fallback
  }
}

/** 确保目录存在 */
function ensureDir(filePath) {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

// ---------- 缓存读写 ----------
function readCache() {
  const cachePath = getUserDataPath(CACHE_FILE_NAME)
  return safeReadJSON(cachePath, null)
}

function writeCache(data) {
  const cachePath = getUserDataPath(CACHE_FILE_NAME)
  ensureDir(cachePath)
  try {
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), 'utf-8')
  } catch (e) {
    console.error(`[writeCache] 写入失败: ${e.message}`)
  }
}

// ---------- Token 用量统计 ----------
function getTodayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function getWeekKey() {
  const d = new Date()
  const day = d.getDay() || 7 // 周日 = 7
  const monday = new Date(d)
  monday.setDate(d.getDate() - day + 1)
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`
}

function getMonthKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function getYearKey() {
  return String(new Date().getFullYear())
}

function readTokenStats() {
  if (statsCache) return statsCache
  const p = getUserDataPath(TOKEN_STATS_FILE_NAME)
  statsCache = safeReadJSON(p, {})
  return statsCache
}

function loadTokenStats() {
  const p = getUserDataPath(TOKEN_STATS_FILE_NAME)
  statsCache = safeReadJSON(p, {})
  return statsCache
}

/**
 * 强制从磁盘重新加载 Token 统计数据（丢弃内存缓存）。
 * 用于外部清理/修改了 token-usage.json 后，让应用内图表立即反映最新数据，
 * 同时避免后续写入把旧内存数据覆盖回磁盘。
 */
function reloadTokenStats() {
  loadTokenStats()
  return getTokenStats()
}

/**
 * 节流写入：高频调用时合并为一次实际磁盘写入
 */
function throttledWriteTokenStats(data) {
  pendingData = data
  if (writeTimer) return
  writeTimer = setTimeout(() => {
    writeTimer = null
    if (pendingData) {
      const p = getUserDataPath(TOKEN_STATS_FILE_NAME)
      ensureDir(p)
      try {
        fs.writeFileSync(p, JSON.stringify(pendingData, null, 2), 'utf-8')
        pendingData = null
      } catch (e) {
        console.error(`[TokenStats] 写入失败: ${e.message}`)
        pendingData = null
      }
    }
  }, WRITE_THROTTLE_MS)
}

/**
 * 立即强制写入（应用退出或手动刷新时调用）
 */
function flushTokenStats() {
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  if (pendingData) {
    const p = getUserDataPath(TOKEN_STATS_FILE_NAME)
    ensureDir(p)
    try {
      fs.writeFileSync(p, JSON.stringify(pendingData, null, 2), 'utf-8')
    } catch (e) {
      console.error(`[TokenStats] flush 失败: ${e.message}`)
    }
    pendingData = null
  }
}

/**
 * 验证一条 usage 记录的合法性
 */
function isValidRecord(record) {
  if (!record || typeof record !== 'object') return false
  if (typeof record.totalTokens !== 'number' || record.totalTokens < 0) return false
  if (typeof record.model !== 'string' || !record.model) return false
  // 过滤解析产生的无效模型名（如 42096136s / 42096136 / undefined），
  // 所有记录最终都经过此处，作为记录前的最后一道防线
  if (INVALID_MODEL_NAME_PATTERNS.some(p => p.test(record.model))) return false
  return true
}

/**
 * 清理超过 DAILY_RETENTION_DAYS 的旧 daily 记录
 * 清理条件：该日期的 all day keys 超过 DAILY_RETENTION_DAYS 天前
 * 注意：只清理 daily 中的详细 records 列表，聚合数据保留（已汇总到 weekly/monthly/yearly 中）
 */
function cleanOldDailyRecords(stats) {
  if (!stats.daily || typeof stats.daily !== 'object') return
  const now = new Date()
  const cutoff = new Date(now)
  cutoff.setDate(now.getDate() - DAILY_RETENTION_DAYS)
  const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`

  const dateKeys = Object.keys(stats.daily)
  let cleaned = 0
  for (const key of dateKeys) {
    if (key < cutoffStr) {
      // 删除旧日期的完整 records（释放内存）
      if (stats.daily[key] && Array.isArray(stats.daily[key].records) && stats.daily[key].records.length > 0) {
        stats.daily[key].records = []
        stats.daily[key]._cleaned = true
        cleaned++
      }
    }
  }
  if (cleaned > 0) {
    console.log(`[TokenStats] 已清理 ${cleaned} 天前的详细记录 (保留 ${DAILY_RETENTION_DAYS} 天)`)
  }
}

/**
 * 记录一条 DeepSeek usage 记录
 * 每条记录会被累加到 daily/weekly/monthly/yearly 四个时间维度中
 *
 * @param {Object} record - { model, promptTokens, completionTokens, totalTokens, requestId, timestamp }
 * @returns {Object|null} 统计响应，失败时返回 null
 */
function recordTokenUsage(record) {
  // 输入验证
  if (!isValidRecord(record)) {
    console.warn(`[TokenUsage] 无效记录已忽略:`, JSON.stringify(record))
    return null
  }

  let stats
  try {
    stats = readTokenStats()
  } catch {
    stats = {}
  }

  const ts = record.timestamp || Date.now()
  const date = new Date(ts)

  const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
  const yearKey = String(date.getFullYear())

  const day = date.getDay() || 7
  const monday = new Date(date)
  monday.setDate(date.getDate() - day + 1)
  const weekKey = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`

  // === 记录此次写入前的状态用于调试 ===
  const beforeDaily = stats.daily?.[dateKey]?.totalTokens || 0

  // 确保嵌套结构存在
  if (!stats.daily || typeof stats.daily !== 'object') stats.daily = {}
  if (!stats.weekly || typeof stats.weekly !== 'object') stats.weekly = {}
  if (!stats.monthly || typeof stats.monthly !== 'object') stats.monthly = {}
  if (!stats.yearly || typeof stats.yearly !== 'object') stats.yearly = {}

  const addTokens = record.totalTokens || 0

  // 累加到四个时间维度
  const vendorId = record.vendorId || '_unknown'
  for (const [scope, key] of [['daily', dateKey], ['weekly', weekKey], ['monthly', monthKey], ['yearly', yearKey]]) {
    try {
      if (!stats[scope][key]) {
        stats[scope][key] = { totalTokens: 0, models: {}, vendorModels: {}, records: [] }
      } else {
        // 确保反序列化后的对象有必需字段
        if (typeof stats[scope][key].totalTokens !== 'number') stats[scope][key].totalTokens = 0
        if (!stats[scope][key].models || typeof stats[scope][key].models !== 'object') stats[scope][key].models = {}
        if (!stats[scope][key].vendorModels || typeof stats[scope][key].vendorModels !== 'object') stats[scope][key].vendorModels = {}
        if (!Array.isArray(stats[scope][key].records)) stats[scope][key].records = []
      }
      const scopeData = stats[scope][key]
      scopeData.totalTokens += addTokens
      scopeData.models[record.model] = (scopeData.models[record.model] || 0) + addTokens
      // 按 vendor 分组统计
      if (!scopeData.vendorModels[vendorId]) scopeData.vendorModels[vendorId] = {}
      scopeData.vendorModels[vendorId][record.model] = (scopeData.vendorModels[vendorId][record.model] || 0) + addTokens
    } catch (e) {
      console.error(`[TokenUsage] scope=${scope} key=${key} 累加失败: ${e.message}`)
    }
  }

  // 保留原始记录（仅 daily）
  try {
    const dailyData = stats.daily[dateKey]
    if (dailyData) {
      dailyData.records.push({
        model: record.model,
        promptTokens: record.promptTokens || 0,
        completionTokens: record.completionTokens || 0,
        totalTokens: addTokens,
        requestId: record.requestId || '',
        timestamp: ts,
        vendorId: record.vendorId || ''
      })
      if (dailyData.records.length > MAX_RECORDS_PER_DAY) {
        dailyData.records = dailyData.records.slice(-MAX_RECORDS_PER_DAY)
      }
    }
  } catch (e) {
    console.error(`[TokenUsage] 写入记录失败: ${e.message}`)
  }

  // 定期清理旧数据
  try {
    cleanOldDailyRecords(stats)
  } catch (e) {
    console.warn(`[TokenUsage] 清理旧数据失败: ${e.message}`)
  }

  // 使用节流写入
  throttledWriteTokenStats(stats)

  let response = null
  try {
    response = buildTokenStatsResponse(stats)
  } catch (e) {
    console.error(`[TokenUsage] 构建响应失败: ${e.message}`)
    response = null
  }

  console.log(
    `[TokenUsage] model=${record.model} add=${addTokens}` +
    ` before_daily=${beforeDaily} after_daily=${stats.daily[dateKey]?.totalTokens || 0}` +
    ` todayTotal=${response?.todayTotal || 0}` +
    ` records_count=${stats.daily[dateKey]?.records?.length || 0}`
  )
  return response
}

/**
 * 构建供前端使用的 Token 统计响应
 * @param {Object} stats - token 统计数据
 * @param {string} vendorId - 可选，按 vendor 过滤 hourlyDeltas
 */
function buildTokenStatsResponse(stats, vendorId) {
  try {
    if (!stats) return null

    const todayKey = getTodayKey()
    const weekKey = getWeekKey()
    const monthKey = getMonthKey()
    const yearKey = getYearKey()

    const dailyRaw = stats.daily || {}
    const weeklyRaw = stats.weekly || {}
    const monthlyRaw = stats.monthly || {}
    const yearlyRaw = stats.yearly || {}

    // 构建按模型分组的 today/week/month/year 数据
    const allModels = new Set()
    for (const s of Object.values(dailyRaw)) {
      if (s && s.models) for (const m of Object.keys(s.models)) allModels.add(m)
    }
    for (const s of Object.values(weeklyRaw)) {
      if (s && s.models) for (const m of Object.keys(s.models)) allModels.add(m)
    }
    for (const s of Object.values(monthlyRaw)) {
      if (s && s.models) for (const m of Object.keys(s.models)) allModels.add(m)
    }
    for (const s of Object.values(yearlyRaw)) {
      if (s && s.models) for (const m of Object.keys(s.models)) allModels.add(m)
    }

    function scopeModels(scopeData, key) {
      const entry = scopeData[key]
      if (!entry || !entry.models) return {}
      return entry.models
    }

    // 按 vendor 分组的模型用量：{ vendorId: { model: tokens } }
    function scopeVendorModels(scopeData, key) {
      const entry = scopeData[key]
      if (!entry || !entry.vendorModels) return {}
      return entry.vendorModels
    }

    // 收集所有出现过的 vendorId
    const allVendorIds = new Set()
    for (const s of Object.values(dailyRaw)) {
      if (s && s.vendorModels) for (const vid of Object.keys(s.vendorModels)) allVendorIds.add(vid)
    }

    const todayRecords = dailyRaw[todayKey]?.records
    const safeRecords = Array.isArray(todayRecords) ? todayRecords : []

    return {
      todayTotal: (dailyRaw[todayKey]?.totalTokens) || 0,
      weekTotal: (weeklyRaw[weekKey]?.totalTokens) || 0,
      monthTotal: (monthlyRaw[monthKey]?.totalTokens) || 0,
      yearTotal: (yearlyRaw[yearKey]?.totalTokens) || 0,
      models: [...allModels],
      vendorIds: [...allVendorIds],
      // 按模型分组的 Token 数（所有 vendor 合并，同模型累加）
      modelUsage: {
        today: scopeModels(dailyRaw, todayKey),
        week: scopeModels(weeklyRaw, weekKey),
        month: scopeModels(monthlyRaw, monthKey),
        year: scopeModels(yearlyRaw, yearKey)
      },
      // 按 vendor 分组的模型用量
      vendorModelUsage: {
        today: scopeVendorModels(dailyRaw, todayKey),
        week: scopeVendorModels(weeklyRaw, weekKey),
        month: scopeVendorModels(monthlyRaw, monthKey),
        year: scopeVendorModels(yearlyRaw, yearKey)
      },
      // 最近 20 条原始记录
      recentRecords: safeRecords.slice(-20).reverse(),
      // 各时间段按模型的分布
      todayModelDetails: Object.entries(scopeModels(dailyRaw, todayKey)).map(([model, totalTokens]) => ({
        model, totalTokens
      })),
      // 今日每小时 token 趋势（差值），按 vendor 隔离
      hourlyDeltas: getTodayHourlyDeltas(vendorId),
      // 最近 31 天每日汇总（用于月/年维度聚合）
      dailySummary: getDailySummary(31)
    }
  } catch (e) {
    console.error(`[TokenStats] 构建响应异常: ${e.message}`)
    return null
  }
}

/**
 * 读取 Token 统计（不修改数据）
 * @param {string} vendorId - 可选，按 vendor 过滤
 */
function getTokenStats(vendorId) {
  try {
    const stats = readTokenStats()
    return buildTokenStatsResponse(stats, vendorId)
  } catch (e) {
    console.error(`[TokenStats] 读取统计失败: ${e.message}`)
    return {
      todayTotal: 0, weekTotal: 0, monthTotal: 0, yearTotal: 0,
      models: [], vendorIds: [],
      modelUsage: { today: {}, week: {}, month: {}, year: {} },
      vendorModelUsage: { today: {}, week: {}, month: {}, year: {} },
      recentRecords: [], todayModelDetails: [],
      hourlyDeltas: [], dailySummary: []
    }
  }
}

/**
 * @param {string} vendorId - 供应商 ID，用于隔离多账号快照
 */
function getPrevModelTokens(vendorId) {
  const stats = readTokenStats()
  const todayKey = getTodayKey()

  // 从当天快照中获取基线
  const todaySnapshots = stats.hourlySnapshots?.[todayKey] || {}
  let result = mergeSnapshotModels(todaySnapshots, vendorId)
  if (Object.keys(result).length > 0) return result

  // 向前回溯最近一个非空快照日期
  const date = new Date()
  for (let i = 1; i <= 35; i++) {
    date.setDate(date.getDate() - 1)
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    const snapshots = stats.hourlySnapshots?.[key] || {}
    result = mergeSnapshotModels(snapshots, vendorId)
    if (Object.keys(result).length > 0) {
      console.log(`[TokenStats] 回退基线: 使用 ${key} 最后快照, models=${Object.keys(result).length}`)
      return result
    }
  }
  return {}
}

/**
 * 从快照中提取各模型的最大累计值作为增量基线。
 *
 * 注意：取"最大值"而非"最后快照"——累计值本质单调递增，正常情况下最大值等于最后快照值；
 * 但当最后一次快照不完整（某次解析只得到部分模型）时，最后快照会缺失部分模型，
 * 导致这些模型的基线归零、下次解析时把相同累计值当作全新增量重复计数。
 * 取最大值可抵御这种不完整快照带来的重复计数。
 */
function mergeSnapshotModels(snapshots, vendorId) {
  const result = {}
  for (const [key, vendorSnap] of Object.entries(snapshots)) {
    if (!vendorSnap || typeof vendorSnap !== 'object') continue
    if (vendorId && key !== `vendor_${vendorId}`) continue
    for (const hourData of Object.values(vendorSnap)) {
      if (!hourData || typeof hourData !== 'object') continue
      for (const [name, data] of Object.entries(hourData.models || {})) {
        const tokens = data.tokens || 0
        result[name] = Math.max(result[name] || 0, tokens)
      }
    }
  }
  return result
}

/**
 * 记录每小时快照：存储当前所有模型的累计 token 数
 * @param {Object} domData - DOM 解析的用量数据
 * @param {string} vendorId - 供应商 ID，用于隔离多账号快照
 */
function recordHourlySnapshot(domData, vendorId) {
  if (!domData || !domData.models || !domData.totalTokens) return

  const stats = readTokenStats()
  if (!stats.hourlySnapshots || typeof stats.hourlySnapshots !== 'object') stats.hourlySnapshots = {}

  const now = new Date()
  const todayKey = getTodayKey()
  // 使用完整时间作为 key（HH:MM），同一小时内多次快照（整点+手动刷新）互不覆盖
  const hourKey = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

  if (!stats.hourlySnapshots[todayKey]) stats.hourlySnapshots[todayKey] = {}

  // 按 vendor 隔离快照
  const vendorKey = vendorId ? `vendor_${vendorId}` : 'default'
  if (!stats.hourlySnapshots[todayKey][vendorKey]) stats.hourlySnapshots[todayKey][vendorKey] = {}

  // 记录此刻的累计值（minutes 用于区分整点定时快照与小时内手动刷新）
  const snapshot = {
    totalTokens: parseInt(domData.totalTokens) || 0,
    totalRequests: parseInt(domData.totalRequests) || 0,
    balance: domData.balance || '',
    totalCost: domData.totalCost || '',
    minutes: now.getMinutes(),
    models: {}
  }

  for (const m of domData.models) {
    snapshot.models[m.name] = {
      tokens: m.tokens || 0,
      requests: m.requests || 0
    }
  }

  stats.hourlySnapshots[todayKey][vendorKey][hourKey] = snapshot

  // 清理 30 天前的快照
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - 30)
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`
  for (const key of Object.keys(stats.hourlySnapshots)) {
    if (key < cutoffKey) delete stats.hourlySnapshots[key]
  }

  throttledWriteTokenStats(stats)
  console.log(`[TokenStats] 快照已记录: ${todayKey} ${hourKey} vendor=${vendorKey} total=${snapshot.totalTokens}`)
}

/**
 * 快照增量归属的小时：
 * - 整点定时快照（key 分钟为 00）：增量属于上一小时（如 11:00 快照增量计入 10:00）
 * - 小时内手动刷新（key 分钟非 00）：增量属于当前小时（如 10:30 刷新计入 10:00）
 * 返回 -1 表示归属昨日（00:00 整点快照的增量属于昨天 23:00，今日图表不显示）
 * @param {string} hourKey - 快照 key，格式 "HH:MM"；旧数据无分钟信息按整点处理
 */
function getAssignHour(hourKey) {
  const parts = String(hourKey).split(':')
  const h = parseInt(parts[0], 10)
  const m = parts.length > 1 ? parseInt(parts[1], 10) : 0
  if (m !== 0) return h
  const prevHour = (h - 1 + 24) % 24
  return prevHour === 23 ? -1 : prevHour
}

function formatHourKey(h) {
  return `${String(h).padStart(2, '0')}:00`
}

/**
 * 计算某供应商作用域在历史快照中的基线（最近一个非空快照日期的最后累计值）
 * @param {Object} stats - token 统计数据
 * @param {string} scopeKey - 快照作用域 key（如 'default' 或 'vendor_xxx'）
 * @returns {{ total: number, models: Object }|null} 基线；无历史数据返回 null
 */
function getSnapshotBaseline(stats, scopeKey) {
  const date = new Date()
  for (let i = 1; i <= 35; i++) {
    date.setDate(date.getDate() - 1)
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    const vendorSnap = stats.hourlySnapshots?.[key]?.[scopeKey]
    if (!vendorSnap || typeof vendorSnap !== 'object') continue
    const hours = Object.keys(vendorSnap).sort()
    if (hours.length === 0) continue
    const last = vendorSnap[hours[hours.length - 1]]
    return {
      total: last.totalTokens || 0,
      models: last.models || {}
    }
  }
  return null
}

/**
 * 读取供应商列表，建立 vendorId → provider（小写）映射
 */
function getVendorProviderMap() {
  try {
    const raw = safeReadJSON(getUserDataPath(VENDORS_FILE_NAME), [])
    const list = Array.isArray(raw) ? raw : (raw.vendors || [])
    const map = {}
    for (const v of list) {
      if (v && v.id) map[String(v.id)] = String(v.provider || '').toLowerCase()
    }
    return map
  } catch (e) {
    return {}
  }
}

/**
 * 判断某供应商快照是否为「今日累计」语义。
 * - Kimi / MIMO 平台展示的是当日用量明细求和，首个快照值即当天至今的用量，无基线时可直接计入当天；
 * - DeepSeek 平台展示的是近 30 天滚动总量，无基线时无法区分当天增量，只能作为新基线（增量为 0）。
 */
function isTodayAccumScope(scopeKey) {
  if (scopeKey === 'default') return false
  const provider = getVendorProviderMap()[String(scopeKey).replace(/^vendor_/, '')] || ''
  return provider.includes('kimi') || provider.includes('mimo')
}

/**
 * 获取今日每小时的 token 差值（用于趋势图）
 * @param {string} vendorId - 供应商 ID，用于隔离多账号数据
 * 返回格式: [{ hour: '09:00', delta: 12345, models: { model: delta } }]
 */
function getTodayHourlyDeltas(vendorId) {
  const stats = readTokenStats()
  const todayKey = getTodayKey()
  const snapshots = stats.hourlySnapshots?.[todayKey] || {}

  // 确定要处理的供应商作用域（未指定时处理全部）
  const scopeKeys = vendorId ? [`vendor_${vendorId}`] : Object.keys(snapshots)
  if (scopeKeys.length === 0) return []

  // 按供应商作用域分别计算每小时增量，再合并结果。
  // 各供应商快照时间交错时，若混在一起计算增量，会把 A 供应商的累计值
  // 误当成 B 供应商的基线，导致某小时柱子出现"全部累计总量"的错误峰值。
  const deltasMap = {}

  for (const scopeKey of scopeKeys) {
    const vendorSnap = snapshots[scopeKey]
    if (!vendorSnap || typeof vendorSnap !== 'object') continue
    const hours = Object.keys(vendorSnap).sort()
    if (hours.length === 0) continue

    // 该供应商的昨日基线：修正当天第一个快照的 delta，覆盖跨午夜、跨月、多天未运行等场景
    const baseline = getSnapshotBaseline(stats, scopeKey)
    const todayAccum = isTodayAccumScope(scopeKey)

    let prev = null
    for (const hour of hours) {
      const curr = vendorSnap[hour]
      if (!curr) continue

      // 计算该快照相对前一个快照（或昨日基线）的增量（仅在同一供应商内比较）
      let delta, requests, modelDeltas
      if (prev) {
        delta = Math.max(0, (curr.totalTokens || 0) - (prev.totalTokens || 0))
        requests = Math.max(0, (curr.totalRequests || 0) - (prev.totalRequests || 0))
        modelDeltas = {}
        for (const [name, data] of Object.entries(curr.models || {})) {
          const mDelta = Math.max(0, data.tokens - (prev.models?.[name]?.tokens || 0))
          if (mDelta > 0) modelDeltas[name] = mDelta
        }
      } else if (baseline && !(todayAccum && (curr.totalTokens || 0) < baseline.total)) {
        // 当天第一个快照 — 使用该供应商昨日最后快照作为基线，反映当天实际增量；
        // 今日累计型供应商若当前值小于昨日基线，说明当日明细已跨天清零，转入下方分支按当天用量处理
        delta = Math.max(0, (curr.totalTokens || 0) - baseline.total)
        requests = curr.totalRequests || 0
        modelDeltas = {}
        for (const [name, data] of Object.entries(curr.models || {})) {
          const mDelta = Math.max(0, data.tokens - (baseline.models?.[name]?.tokens || 0))
          if (mDelta > 0) modelDeltas[name] = mDelta
        }
      } else if (todayAccum) {
        // 今日累计型供应商（如 Kimi / MIMO 当日明细求和）：
        // 首个快照值即当天至今的用量，直接计入，避免因无历史基线/跨天清零而被归零。
        // 特殊场景：昨日基线存在但当前值更小（MIMO 切换视图导致页面重置后重新展示当日用量），
        // 此时应将整个当前值视为今日用量，而非与昨日基线做差（差值为负会被 max(0,..) 归零）。
        delta = curr.totalTokens || 0
        requests = curr.totalRequests || 0
        modelDeltas = {}
        for (const [name, data] of Object.entries(curr.models || {})) {
          const t = data.tokens || 0
          if (t > 0) modelDeltas[name] = t
        }
      } else {
        // 滚动累计型供应商（如 DeepSeek 近 30 天总量）无历史基线：
        // 无法区分累计总量与当天增量，将第一个快照作为新基线（增量为 0），
        // 避免把滚动累计总量误记为当天用量
        delta = 0
        requests = 0
        modelDeltas = {}
      }

      // 归属小时调整（整点快照归上一小时，非整点归当前小时）
      const assignHour = getAssignHour(hour)
      if (assignHour < 0) {
        prev = curr
        continue
      }
      const bucket = deltasMap[assignHour] || (deltasMap[assignHour] = {
        hour: formatHourKey(assignHour),
        delta: 0,
        requests: 0,
        models: {}
      })
      bucket.delta += delta
      bucket.requests += requests
      for (const [name, t] of Object.entries(modelDeltas)) {
        bucket.models[name] = (bucket.models[name] || 0) + t
      }

      prev = curr
    }
  }

  return Object.keys(deltasMap)
    .sort((a, b) => a - b)
    .map(k => deltasMap[k])
}

/**
 * 获取最近 N 天每天的总 token 用量
 */
function getDailySummary(days = 7) {
  const stats = readTokenStats()
  const daily = stats.daily || {}
  const result = []

  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const dayData = daily[key]
    result.push({
      date: key,
      dayLabel: `${d.getMonth() + 1}/${d.getDate()}`,
      totalTokens: dayData?.totalTokens || 0,
      models: dayData?.models || {}
    })
  }

  return result
}

// ---------- DeepSeek 余额查询 ----------
async function fetchDeepSeekBalance(apiKey) {
  const resp = await fetch('https://api.deepseek.com/user/balance', {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  })

  if (!resp.ok) {
    throw new Error(`DeepSeek API 返回 ${resp.status}: ${await resp.text()}`)
  }

  const data = await resp.json()

  // 解析 balance_infos 数组
  const balanceInfos = data.balance_infos || []
  const info = balanceInfos.length > 0 ? balanceInfos[0] : {}

  return {
    total_balance: parseFloat(info.total_balance || 0),          // 当前可用余额
    granted_balance: parseFloat(info.granted_balance || 0),      // 赠送余额
    topped_up_balance: parseFloat(info.topped_up_balance || 0),  // 累计充值总额
    currency: info.currency || 'CNY',
    is_available: !!data.is_available,
    fetchedAt: new Date().toISOString()
  }
}

// ---------- Kimi 余额查询 ----------
// 参考: https://platform.kimi.com/docs - 查询余额
// GET https://api.moonshot.cn/v1/users/me/balance
async function fetchKimiBalance(apiKey) {
  const resp = await fetch('https://api.moonshot.cn/v1/users/me/balance', {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  })

  if (!resp.ok) {
    throw new Error(`Kimi API 返回 ${resp.status}: ${await resp.text()}`)
  }

  const data = await resp.json()

  // 响应码 0 表示成功；失败时带 error 对象
  if (data.code !== 0 || !data.data) {
    throw new Error(data.error?.message || `Kimi API 响应异常: ${JSON.stringify(data).substring(0, 200)}`)
  }

  const available = parseFloat(data.data.available_balance || 0)
  return {
    available_balance: available,        // 可用余额（现金 + 代金券），<= 0 时无法调用推理 API
    voucher_balance: parseFloat(data.data.voucher_balance || 0),  // 代金券余额
    cash_balance: parseFloat(data.data.cash_balance || 0),        // 现金余额（可为负）
    currency: 'CNY',
    is_available: available > 0,
    fetchedAt: new Date().toISOString()
  }
}

/**
 * 计算 Kimi 余额（计量计价，余额 = 金额）
 *
 * 无"累计充值"字段，改用余额变化追踪：
 * - 首次采集：以当前可用余额作为累计预算
 * - 之后余额上涨（充值）→ 差值计入累计预算
 * - 余额下降（消费）→ spent 自动 = 累计预算 - 当前余额
 */
function computeKimiBalance(raw, prevCache, vendorId) {
  const balances = prevCache?.kimiBalances || {}
  const prev = vendorId ? (balances[vendorId] || prevCache?.kimiBalance || null) : null
  const prevRemaining = prev?.remaining ?? null
  const prevBudget = prev?.totalBudget || 0

  const remaining = raw.available_balance

  let totalBudget = prevBudget
  if (prevRemaining !== null) {
    if (remaining > prevRemaining) {
      // 检测到充值：累加差额
      totalBudget += (remaining - prevRemaining)
    }
  } else {
    // 首次运行：以当前余额为基准
    totalBudget = remaining
  }

  const spent = Math.max(0, totalBudget - remaining)
  const usedPercent = totalBudget > 0 ? Math.round((spent / totalBudget) * 100) : 0

  return {
    totalBudget,        // 累计预算（充值追踪）
    remaining,           // 当前可用余额
    spent,               // 已消费
    usedPercent,
    voucher_balance: raw.voucher_balance,
    cash_balance: raw.cash_balance,
    currency: raw.currency,
    is_available: raw.is_available,
    fetchedAt: raw.fetchedAt
  }
}

// ---------- 累计充值追踪 ----------
/**
 * 计算 XIAOMI MIMO 余额（无累计充值字段，与 Kimi 一致采用余额变化追踪）：
 * - 首次采集：以当前余额作为累计预算
 * - 之后余额上涨（充值）→ 差值计入累计预算
 * - 余额下降（消费）→ spent 自动 = 累计预算 - 当前余额
 */
function computeMimoBalance(raw, prevCache, vendorId) {
  const balances = prevCache?.mimoBalances || {}
  const prev = vendorId ? (balances[vendorId] || null) : null
  const prevRemaining = prev?.remaining ?? null
  const prevBudget = prev?.totalBudget || 0

  const remaining = raw.balance

  let totalBudget = prevBudget
  if (prevRemaining !== null) {
    if (remaining > prevRemaining) {
      // 检测到充值：累加差额
      totalBudget += (remaining - prevRemaining)
    }
  } else {
    // 首次运行：以当前余额为基准
    totalBudget = remaining
  }

  const spent = Math.max(0, totalBudget - remaining)
  const usedPercent = totalBudget > 0 ? Math.round((spent / totalBudget) * 100) : 0

  return {
    totalBudget,        // 累计预算（充值追踪）
    remaining,           // 当前可用余额
    spent,               // 已消费
    usedPercent,
    currency: raw.currency || 'CNY',
    is_available: remaining > 0,
    fetchedAt: raw.fetchedAt || new Date().toISOString()
  }
}

function computeBalance(raw, prevCache, vendorId) {
  const balances = prevCache?.deepseekBalances || {}
  const prev = vendorId ? (balances[vendorId] || prevCache?.deepseekBalance || null) : (prevCache?.deepseekBalance || null)
  const prevCumBudget = prev?.totalBudget || 0
  const prevToppedUp = prev?.rawToppedUp || 0

  const rawToppedUp = raw.topped_up_balance

  // 累计预算：充值总额比上次高 → 差值计入累计
  let cumulativeBudget = prevCumBudget
  if (rawToppedUp > prevToppedUp && prevToppedUp > 0) {
    // 检测到新充值：累加差额
    cumulativeBudget += (rawToppedUp - prevToppedUp)
  } else if (rawToppedUp > cumulativeBudget) {
    // 首次运行或数据重置：用当前值
    cumulativeBudget = rawToppedUp
  }

  const remaining = raw.total_balance
  const spent = Math.max(0, cumulativeBudget - remaining)
  const usedPercent = cumulativeBudget > 0 ? Math.round((spent / cumulativeBudget) * 100) : 0

  return {
    totalBudget: cumulativeBudget,        // 历史累计充值总额
    remaining,                             // 当前余额
    spent,                                 // 已消费
    usedPercent,
    granted_balance: raw.granted_balance,
    topped_up_balance: raw.topped_up_balance,
    rawToppedUp,                           // 记录原始值供下次比较
    currency: raw.currency,
    is_available: raw.is_available,
    fetchedAt: raw.fetchedAt
  }
}

// ---------- 重置累计充值（初始化） ----------
/**
 * 将累计预算重置为当前余额
 * 调用 DeepSeek API 获取最新余额，将 totalBudget 设成当前 remaining
 * 效果：spent = 0，进度条归零，后续充值继续累加
 */
async function resetDeepSeekBudget() {
  const vendorsPath = getUserDataPath(VENDORS_FILE_NAME)
  if (!fs.existsSync(vendorsPath)) throw new Error('未找到供应商配置')

  let vendors = []
  try { vendors = JSON.parse(fs.readFileSync(vendorsPath, 'utf-8')) } catch { throw new Error('供应商配置文件损坏') }

  const deepseekVendor = vendors.find(v => v.provider === 'DeepSeek API')
  if (!deepseekVendor || !deepseekVendor.apiKey) throw new Error('未找到 DeepSeek API 配置')

  // 调用 API 获取实时余额
  const raw = await fetchDeepSeekBalance(deepseekVendor.apiKey)
  const remaining = raw.total_balance

  // 构造新的余额缓存：totalBudget = remaining → 已消费 = 0
  const balance = {
    totalBudget: remaining,
    remaining,
    spent: 0,
    usedPercent: 0,
    granted_balance: raw.granted_balance,
    topped_up_balance: raw.topped_up_balance,
    rawToppedUp: raw.topped_up_balance,
    currency: raw.currency,
    is_available: raw.is_available,
    fetchedAt: raw.fetchedAt,
    _reset: true
  }

  // 基于现有缓存合并更新：只替换 DeepSeek 余额字段，
  // 保留 kimiBalances / mimoBalances 等其他供应商数据，避免覆盖整个缓存文件
  const cache = readCache() || { vendors: [] }
  cache.vendors = vendors
  cache.errors = []
  cache.lastCollect = new Date().toISOString()
  cache.deepseekBalance = balance
  if (!cache.deepseekBalances) cache.deepseekBalances = {}
  if (deepseekVendor.id) cache.deepseekBalances[deepseekVendor.id] = balance
  cache._raw = raw
  writeCache(cache)

  console.log(`[Reset] 余额已初始化: totalBudget=${remaining}, spent=0, rawToppedUp=${raw.topped_up_balance}`)
  return cache
}

/**
 * 重置 XIAOMI MIMO 累计预算为当前余额
 * 效果：spent = 0，进度条归零，后续充值继续累加（与 DeepSeek 初始化逻辑一致）
 * MIMO 无 API，余额来自 Monitor 解析结果（mimoBalances 缓存）
 */
async function resetMimoBudget(vendorId) {
  const vendorsPath = getUserDataPath(VENDORS_FILE_NAME)
  if (!fs.existsSync(vendorsPath)) throw new Error('未找到供应商配置')

  let vendors = []
  try { vendors = JSON.parse(fs.readFileSync(vendorsPath, 'utf-8')) } catch { throw new Error('供应商配置文件损坏') }

  const mimoVendor = vendors.find(v => v.id === vendorId && (v.provider || '').toLowerCase().includes('mimo'))
  if (!mimoVendor) throw new Error('未找到 XIAOMI MIMO 配置')

  const cache = readCache() || { vendors: [] }
  const balance = cache.mimoBalances?.[vendorId] || null
  if (!balance || typeof balance.remaining !== 'number') {
    throw new Error('暂无余额数据，请先登录 MIMO 账户获取余额后再初始化')
  }

  // 构造新的余额：totalBudget = 当前余额 → 已消费 = 0
  const newBalance = {
    totalBudget: balance.remaining,
    remaining: balance.remaining,
    spent: 0,
    usedPercent: 0,
    currency: balance.currency || 'CNY',
    is_available: balance.is_available,
    fetchedAt: new Date().toISOString(),
    _reset: true
  }

  if (!cache.mimoBalances) cache.mimoBalances = {}
  cache.mimoBalances[vendorId] = newBalance
  cache.mimoBalance = Object.values(cache.mimoBalances)[0] || null
  cache.lastCollect = new Date().toISOString()
  writeCache(cache)

  console.log(`[Reset] MIMO 余额已初始化: vendor=${vendorId}, totalBudget=${newBalance.remaining}, spent=0`)
  return cache
}

// ---------- 核心采集逻辑 ----------
async function collectAll(kimiMonitorLoggedInMap = {}) {
  const vendorsPath = getUserDataPath(VENDORS_FILE_NAME)

  const emptyResult = (vendors, errors = []) => ({
    vendors,
    errors,
    lastCollect: new Date().toISOString(),
    deepseekBalance: null,
    deepseekBalances: {},
    kimiBalance: null,
    kimiBalances: {},
    mimoBalance: null,
    mimoBalances: {}
  })

  if (!fs.existsSync(vendorsPath)) {
    return emptyResult([])
  }

  let vendors = []
  try {
    vendors = JSON.parse(fs.readFileSync(vendorsPath, 'utf-8'))
  } catch {
    return emptyResult([], ['供应商配置文件损坏'])
  }

  const deepseekVendors = vendors.filter(v => v.provider === 'DeepSeek API' && v.apiKey)
  const kimiVendors = vendors.filter(v => v.provider === 'Kimi CN' && v.apiKey)
  const errors = []
  const prevCache = readCache()

  // 为每个 DeepSeek vendor 独立获取 balance
  const deepseekBalances = {}
  let firstRaw = null
  for (const dv of deepseekVendors) {
    try {
      const raw = await fetchDeepSeekBalance(dv.apiKey)
      if (!firstRaw) firstRaw = raw
      deepseekBalances[dv.id] = computeBalance(raw, prevCache, dv.id)
    } catch (e) {
      // 尝试从缓存恢复
      const prevBal = prevCache?.deepseekBalances?.[dv.id] || prevCache?.deepseekBalance
      if (prevBal) {
        deepseekBalances[dv.id] = { ...prevBal, _stale: true }
        errors.push(`${dv.customName || dv.id}: ${e.message} (使用缓存数据)`)
      } else {
        errors.push(`${dv.customName || dv.id}: ${e.message}`)
      }
    }
  }

  // 为每个 Kimi vendor 独立获取 balance
  const kimiBalances = {}
  for (const kv of kimiVendors) {
    try {
      const raw = await fetchKimiBalance(kv.apiKey)
      kimiBalances[kv.id] = computeKimiBalance(raw, prevCache, kv.id)
    } catch (e) {
      // 尝试从缓存恢复
      const prevBal = prevCache?.kimiBalances?.[kv.id] || prevCache?.kimiBalance
      if (prevBal) {
        // Monitor 已登录时 DOM 解析提供实时数据，缓存不视为 stale
        const monitorActive = kimiMonitorLoggedInMap[kv.id]
        kimiBalances[kv.id] = { ...prevBal, _stale: !monitorActive }
        if (!monitorActive) {
          errors.push(`${kv.customName || kv.id}: ${e.message} (使用缓存数据)`)
        }
      } else {
        errors.push(`${kv.customName || kv.id}: ${e.message}`)
      }
    }
  }

  if (deepseekVendors.length === 0 && kimiVendors.length === 0) {
    // 没有任何需 API 采集余额的供应商：若已存在供应商（如无 API 密钥的 XIAOMI MIMO），不视为错误
    if (vendors.length === 0) {
      return emptyResult([], ['未找到可采集余额的供应商配置，请先添加供应商'])
    }
    const result = emptyResult(vendors)
    // 保留 MIMO Monitor 写入的余额数据（该供应商无 API，仅通过 Monitor 采集）
    result.mimoBalance = prevCache?.mimoBalance || null
    result.mimoBalances = prevCache?.mimoBalances || {}
    return result
  }

  // 兼容：deepseekBalance / kimiBalance 取第一个 vendor 的 balance
  const firstBalance = deepseekBalances[deepseekVendors[0]?.id] || null
  const firstKimiBalance = kimiBalances[kimiVendors[0]?.id] || null

  const cacheData = {
    vendors,
    errors,
    lastCollect: new Date().toISOString(),
    deepseekBalance: firstBalance,
    deepseekBalances,
    kimiBalance: firstKimiBalance,
    kimiBalances,
    // 透传 MIMO Monitor 写入的余额数据，避免被本轮 API 采集覆盖
    mimoBalance: prevCache?.mimoBalance || null,
    mimoBalances: prevCache?.mimoBalances || {},
    _raw: firstRaw
  }
  writeCache(cacheData)

  return cacheData
}

module.exports = { collectAll, readCache, writeCache, recordTokenUsage, getTokenStats, resetDeepSeekBudget, resetMimoBudget, flushTokenStats, loadTokenStats, reloadTokenStats, recordHourlySnapshot, getPrevModelTokens, getTodayHourlyDeltas, getDailySummary, computeMimoBalance }
