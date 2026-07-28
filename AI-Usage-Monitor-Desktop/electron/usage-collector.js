/**
 * DeepSeek 余额采集器
 *
 * 从 AppData/vendors.json 中读取用户保存的 DeepSeek API Key，
 * 调用 GET https://api.deepseek.com/user/balance 查询账户余额，
 * 写入 usage-cache.json 并推送至渲染进程。
 *
 * 核心逻辑：累计充值总额 tracking
 *   - totalBudget 记录历史累计充值最高值，只增不减
 *   - remaining  取 API 返回的 total_balance（当前可用余额）
 *   - spent      = totalBudget - remaining
 *   - 每次轮询若 topped_up_balance 超过上一次记录值，差值累加到 totalBudget
 *
 * 定时 30s 轮询；失败时保留上一次缓存数据。
 */

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

// ---------- 安全的 JSON 读写 ----------

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
  for (const [scope, key] of [['daily', dateKey], ['weekly', weekKey], ['monthly', monthKey], ['yearly', yearKey]]) {
    try {
      if (!stats[scope][key]) {
        stats[scope][key] = { totalTokens: 0, models: {}, records: [] }
      } else {
        // 确保反序列化后的对象有必需字段
        if (typeof stats[scope][key].totalTokens !== 'number') stats[scope][key].totalTokens = 0
        if (!stats[scope][key].models || typeof stats[scope][key].models !== 'object') stats[scope][key].models = {}
        if (!Array.isArray(stats[scope][key].records)) stats[scope][key].records = []
      }
      const scopeData = stats[scope][key]
      scopeData.totalTokens += addTokens
      scopeData.models[record.model] = (scopeData.models[record.model] || 0) + addTokens
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
        timestamp: ts
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
 */
function buildTokenStatsResponse(stats) {
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

    const todayRecords = dailyRaw[todayKey]?.records
    const safeRecords = Array.isArray(todayRecords) ? todayRecords : []

    return {
      todayTotal: (dailyRaw[todayKey]?.totalTokens) || 0,
      weekTotal: (weeklyRaw[weekKey]?.totalTokens) || 0,
      monthTotal: (monthlyRaw[monthKey]?.totalTokens) || 0,
      yearTotal: (yearlyRaw[yearKey]?.totalTokens) || 0,
      models: [...allModels],
      // 按模型分组的 Token 数
      modelUsage: {
        today: scopeModels(dailyRaw, todayKey),
        week: scopeModels(weeklyRaw, weekKey),
        month: scopeModels(monthlyRaw, monthKey),
        year: scopeModels(yearlyRaw, yearKey)
      },
      // 最近 20 条原始记录
      recentRecords: safeRecords.slice(-20).reverse(),
      // 各时间段按模型的分布
      todayModelDetails: Object.entries(scopeModels(dailyRaw, todayKey)).map(([model, totalTokens]) => ({
        model, totalTokens
      })),
      // 今日每小时 token 趋势（差值）
      hourlyDeltas: getTodayHourlyDeltas(),
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
 */
function getTokenStats() {
  try {
    const stats = readTokenStats()
    return buildTokenStatsResponse(stats)
  } catch (e) {
    console.error(`[TokenStats] 读取统计失败: ${e.message}`)
    return {
      todayTotal: 0, weekTotal: 0, monthTotal: 0, yearTotal: 0,
      models: [], modelUsage: { today: {}, week: {}, month: {}, year: {} },
      recentRecords: [], todayModelDetails: [],
      hourlyDeltas: [], dailySummary: []
    }
  }
}

/**
 * 获取上一次快照中各模型的累计 token 数（用于计算增量）
 */
function getPrevModelTokens() {
  const stats = readTokenStats()
  const todayKey = getTodayKey()
  const snapshots = stats.hourlySnapshots?.[todayKey] || {}
  const hours = Object.keys(snapshots).sort()
  if (hours.length === 0) return {}
  const last = snapshots[hours[hours.length - 1]]
  const result = {}
  for (const [name, data] of Object.entries(last.models || {})) {
    result[name] = data.tokens || 0
  }
  return result
}

/**
 * 记录每小时快照：存储当前所有模型的累计 token 数
 * 启动时和每次轮询时调用，用于计算小时差值绘制趋势图
 */
function recordHourlySnapshot(domData) {
  if (!domData || !domData.models || !domData.totalTokens) return

  const stats = readTokenStats()
  if (!stats.hourlySnapshots || typeof stats.hourlySnapshots !== 'object') stats.hourlySnapshots = {}

  const now = new Date()
  const todayKey = getTodayKey()
  const hourKey = `${String(now.getHours()).padStart(2, '0')}:00`

  if (!stats.hourlySnapshots[todayKey]) stats.hourlySnapshots[todayKey] = {}

  // 记录此刻的累计值
  const snapshot = {
    totalTokens: parseInt(domData.totalTokens) || 0,
    totalRequests: parseInt(domData.totalRequests) || 0,
    balance: domData.balance || '',
    totalCost: domData.totalCost || '',
    models: {}
  }

  for (const m of domData.models) {
    snapshot.models[m.name] = {
      tokens: m.tokens || 0,
      requests: m.requests || 0
    }
  }

  stats.hourlySnapshots[todayKey][hourKey] = snapshot

  // 清理 30 天前的快照
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - 30)
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`
  for (const key of Object.keys(stats.hourlySnapshots)) {
    if (key < cutoffKey) delete stats.hourlySnapshots[key]
  }

  throttledWriteTokenStats(stats)
  console.log(`[TokenStats] 快照已记录: ${todayKey} ${hourKey} total=${snapshot.totalTokens}`)
}

/**
 * 获取今日每小时的 token 差值（用于趋势图）
 * 返回格式: [{ hour: '09:00', delta: 12345, model: { name, delta } }]
 */
function getTodayHourlyDeltas() {
  const stats = readTokenStats()
  const todayKey = getTodayKey()
  const snapshots = stats.hourlySnapshots?.[todayKey] || {}
  const hours = Object.keys(snapshots).sort()

  if (hours.length < 1) return []

  const deltas = []
  let prev = null

  for (const hour of hours) {
    const curr = snapshots[hour]
    if (!curr) continue

    if (prev) {
      const delta = Math.max(0, curr.totalTokens - prev.totalTokens)
      const modelDeltas = {}
      for (const [name, data] of Object.entries(curr.models || {})) {
        const prevData = prev.models?.[name]
        const mDelta = prevData ? Math.max(0, data.tokens - prevData.tokens) : data.tokens
        if (mDelta > 0) modelDeltas[name] = mDelta
      }
      deltas.push({
        hour,
        delta,
        requests: Math.max(0, (curr.totalRequests || 0) - (prev.totalRequests || 0)),
        models: modelDeltas,
        totalTokens: curr.totalTokens
      })
    } else {
      // 第一个快照 — 与当天 00:00 的差值（如果有的话）
      deltas.push({
        hour,
        delta: curr.totalTokens,
        requests: curr.totalRequests || 0,
        models: Object.fromEntries(Object.entries(curr.models || {}).map(([n, d]) => [n, d.tokens])),
        totalTokens: curr.totalTokens
      })
    }
    prev = curr
  }

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

// ---------- 累计充值与预算追踪 ----------
function computeBalance(raw, prevCache, vendorId) {
  const balances = prevCache?.deepseekBalances || {}
  const prev = vendorId ? (balances[vendorId] || prevCache?.deepseekBalance || null) : (prevCache?.deepseekBalance || null)

  const remaining = parseFloat(raw.total_balance || 0)
  const officialToppedUp = parseFloat(raw.topped_up_balance || 0)
  const granted = parseFloat(raw.granted_balance || 0)
  const officialTotal = officialToppedUp + granted

  // 1. 如果有官方充值/赠送额度记录（官方总额 > 0）
  // 额度上限优先取 官方充值总额 + 赠送额度，与当前余额以及上一次基准相比取最大值
  let totalBudget = 0
  if (officialTotal > 0) {
    totalBudget = Math.max(officialTotal, remaining, prev?.totalBudget || 0)
  } else {
    // 2. 如果官方 API 只提供了当前余额（未提供充值总额）
    // 初始时以当前余额作为总额度（已消费算 0）
    // 后续随着使用 remaining 减少，totalBudget 锁定初次或历史最高额度
    totalBudget = Math.max(remaining, prev?.totalBudget || 0)
  }

  // 已消费 = 额度上限 - 当前可用余额
  const spent = Math.max(0, totalBudget - remaining)
  const usedPercent = totalBudget > 0 ? Math.min(100, Math.round((spent / totalBudget) * 100)) : 0

  return {
    totalBudget,                           // 总预算 (累计充值/初始额度)
    remaining,                             // 当前可用余额
    spent,                                 // 已消费 = totalBudget - remaining
    usedPercent,                           // 已使用百分比
    granted_balance: granted,
    topped_up_balance: officialToppedUp,
    rawToppedUp: officialToppedUp,         // 记录原始值供下次比较
    currency: raw.currency || 'CNY',
    is_available: raw.is_available,
    fetchedAt: raw.fetchedAt || new Date().toISOString()
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
    fetchedAt: raw.fetchedAt
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

  if (!fs.existsSync(vendorsPath)) {
    const cacheData = {
      vendors: [],
      errors: [],
      lastCollect: new Date().toISOString(),
      deepseekBalance: null,
      deepseekBalances: {}
    }
    writeCache(cacheData)
    return cacheData
  }

  let vendors = []
  try {
    vendors = JSON.parse(fs.readFileSync(vendorsPath, 'utf-8'))
  } catch {
    const cacheData = {
      vendors: [],
      errors: ['供应商配置文件损坏'],
      lastCollect: new Date().toISOString(),
      deepseekBalance: null,
      deepseekBalances: {}
    }
    writeCache(cacheData)
    return cacheData
  }

  const deepseekVendors = vendors.filter(v => v.provider === 'DeepSeek API' && v.apiKey)
  const errors = []
  const prevCache = readCache()

  // 为每个 DeepSeek vendor 独立获取 balance
  const deepseekBalances = {}
  let firstRaw = null

  if (deepseekVendors.length === 0) {
    const cacheData = {
      vendors,
      errors: [],
      lastCollect: new Date().toISOString(),
      deepseekBalance: null,
      deepseekBalances: {}
    }
    writeCache(cacheData)
    return cacheData
  }

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

  // 兼容：deepseekBalance 取第一个 vendor 的 balance
  const firstBalance = deepseekBalances[deepseekVendors[0].id] || null

  const cacheData = {
    vendors,
    errors,
    lastCollect: new Date().toISOString(),
    deepseekBalance: firstBalance,
    deepseekBalances,
    _raw: firstRaw
  }
  writeCache(cacheData)

  return cacheData
}

module.exports = { collectAll, readCache, recordTokenUsage, getTokenStats, resetDeepSeekBudget, flushTokenStats, loadTokenStats, recordHourlySnapshot, getPrevModelTokens, getTodayHourlyDeltas, getDailySummary }
