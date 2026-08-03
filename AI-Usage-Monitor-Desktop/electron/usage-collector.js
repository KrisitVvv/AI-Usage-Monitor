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
 * 从快照中提取各模型的最后累计值
 */
function mergeSnapshotModels(snapshots, vendorId) {
  const result = {}
  for (const [key, vendorSnap] of Object.entries(snapshots)) {
    if (!vendorSnap || typeof vendorSnap !== 'object') continue
    if (vendorId && key !== `vendor_${vendorId}`) continue
    const hours = Object.keys(vendorSnap).sort()
    if (hours.length === 0) continue
    const last = vendorSnap[hours[hours.length - 1]]
    for (const [name, data] of Object.entries(last.models || {})) {
      result[name] = (result[name] || 0) + (data.tokens || 0)
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
 * 获取今日每小时的 token 差值（用于趋势图）
 * @param {string} vendorId - 供应商 ID，用于隔离多账号数据
 * 返回格式: [{ hour: '09:00', delta: 12345, models: { model: delta } }]
 */
function getTodayHourlyDeltas(vendorId) {
  const stats = readTokenStats()
  const todayKey = getTodayKey()
  const snapshots = stats.hourlySnapshots?.[todayKey] || {}

  // 计算基线：向前回溯最近一个非空快照日期（最多 35 天）的最后快照累计值
  // 用于修正当天第一个快照的 delta，覆盖跨午夜、跨月、多天未运行等场景，
  // 避免昨日无快照导致基线为空、把滚动总量误当当天增量
  let baselineTotal = 0
  const baselineModels = {}
  const baseDate = new Date()
  for (let i = 1; i <= 35; i++) {
    baseDate.setDate(baseDate.getDate() - 1)
    const key = `${baseDate.getFullYear()}-${String(baseDate.getMonth() + 1).padStart(2, '0')}-${String(baseDate.getDate()).padStart(2, '0')}`
    const baseSnapshots = stats.hourlySnapshots?.[key] || {}
    for (const [vKey, vendorSnap] of Object.entries(baseSnapshots)) {
      if (!vendorSnap || typeof vendorSnap !== 'object') continue
      if (vendorId && vKey !== `vendor_${vendorId}`) continue
      const hours = Object.keys(vendorSnap).sort()
      if (hours.length > 0) {
        const last = vendorSnap[hours[hours.length - 1]]
        baselineTotal += last.totalTokens || 0
        for (const [modelName, modelData] of Object.entries(last.models || {})) {
          baselineModels[modelName] = (baselineModels[modelName] || 0) + (modelData.tokens || 0)
        }
      }
    }
    if (Object.keys(baselineModels).length > 0) break
  }

  // 合并所有 vendor 的快照数据（按小时聚合）
  const mergedSnapshots = {}
  for (const [key, vendorSnap] of Object.entries(snapshots)) {
    if (!vendorSnap || typeof vendorSnap !== 'object') continue
    // 如果指定了 vendorId，只取该 vendor 的数据
    if (vendorId && key !== `vendor_${vendorId}`) continue
    for (const [hour, snapshot] of Object.entries(vendorSnap)) {
      if (!mergedSnapshots[hour]) {
        mergedSnapshots[hour] = { ...snapshot, models: { ...snapshot.models } }
      } else {
        // 聚合：totalTokens / totalRequests 累加，models 按模型名合并
        const prev = mergedSnapshots[hour]
        prev.totalTokens = (prev.totalTokens || 0) + (snapshot.totalTokens || 0)
        prev.totalRequests = (prev.totalRequests || 0) + (snapshot.totalRequests || 0)
        for (const [modelName, modelData] of Object.entries(snapshot.models || {})) {
          if (!prev.models[modelName]) {
            prev.models[modelName] = { ...modelData }
          } else {
            prev.models[modelName].tokens = (prev.models[modelName].tokens || 0) + (modelData.tokens || 0)
            prev.models[modelName].requests = (prev.models[modelName].requests || 0) + (modelData.requests || 0)
          }
        }
      }
    }
  }

  const hours = Object.keys(mergedSnapshots).sort()

  if (hours.length < 1) return []

  // 按归属小时聚合 delta（整点快照归上一小时，手动刷新归当前小时）
  const deltasMap = {}
  let prev = null

  for (const hour of hours) {
    const curr = mergedSnapshots[hour]
    if (!curr) continue

    // 计算该快照相对前一个快照（或昨日基线）的增量
    let delta, requests, modelDeltas
    if (prev) {
      delta = Math.max(0, curr.totalTokens - prev.totalTokens)
      requests = Math.max(0, (curr.totalRequests || 0) - (prev.totalRequests || 0))
      modelDeltas = {}
      for (const [name, data] of Object.entries(curr.models || {})) {
        const prevData = prev.models?.[name]
        const mDelta = prevData ? Math.max(0, data.tokens - prevData.tokens) : data.tokens
        if (mDelta > 0) modelDeltas[name] = mDelta
      }
    } else if (baselineTotal > 0) {
      // 第一个快照 — 使用昨日最后快照作为基线，更精确地反映当天实际增量
      delta = Math.max(0, curr.totalTokens - baselineTotal)
      requests = curr.totalRequests || 0
      modelDeltas = {}
      for (const [name, data] of Object.entries(curr.models || {})) {
        const mDelta = Math.max(0, data.tokens - (baselineModels[name] || 0))
        if (mDelta > 0) modelDeltas[name] = mDelta
      }
    } else {
      // 无基线数据（首次运行），只能使用当前累计值
      delta = curr.totalTokens
      requests = curr.totalRequests || 0
      modelDeltas = Object.fromEntries(Object.entries(curr.models || {}).map(([n, d]) => [n, d.tokens]))
    }

    // 归属小时调整（整点归上一小时，非整点归当前小时）
    const assignHour = getAssignHour(hour)
    if (assignHour < 0) {
      prev = curr
      continue
    }
    const bucket = deltasMap[assignHour] || (deltasMap[assignHour] = {
      hour: formatHourKey(assignHour),
      delta: 0,
      requests: 0,
      models: {},
      totalTokens: curr.totalTokens
    })
    bucket.delta += delta
    bucket.requests += requests
    for (const [name, t] of Object.entries(modelDeltas)) {
      bucket.models[name] = (bucket.models[name] || 0) + t
    }

    prev = curr
  }

  const deltas = Object.keys(deltasMap)
    .sort((a, b) => a - b)
    .map(k => deltasMap[k])

  return deltas
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

  const cacheData = {
    vendors,
    errors: [],
    lastCollect: new Date().toISOString(),
    deepseekBalance: balance,
    _raw: raw
  }
  writeCache(cacheData)

  console.log(`[Reset] 余额已初始化: totalBudget=${remaining}, spent=0, rawToppedUp=${raw.topped_up_balance}`)
  return cacheData
}

// ---------- 核心采集逻辑 ----------
async function collectAll() {
  const vendorsPath = getUserDataPath(VENDORS_FILE_NAME)

  const emptyResult = (vendors, errors = []) => ({
    vendors,
    errors,
    lastCollect: new Date().toISOString(),
    deepseekBalance: null,
    deepseekBalances: {},
    kimiBalance: null,
    kimiBalances: {}
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
        kimiBalances[kv.id] = { ...prevBal, _stale: true }
        errors.push(`${kv.customName || kv.id}: ${e.message} (使用缓存数据)`)
      } else {
        errors.push(`${kv.customName || kv.id}: ${e.message}`)
      }
    }
  }

  if (deepseekVendors.length === 0 && kimiVendors.length === 0) {
    return emptyResult(vendors, ['未找到可采集余额的供应商配置，请先添加供应商'])
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
    _raw: firstRaw
  }
  writeCache(cacheData)

  return cacheData
}

module.exports = { collectAll, readCache, writeCache, recordTokenUsage, getTokenStats, resetDeepSeekBudget, flushTokenStats, loadTokenStats, recordHourlySnapshot, getPrevModelTokens, getTodayHourlyDeltas, getDailySummary }
