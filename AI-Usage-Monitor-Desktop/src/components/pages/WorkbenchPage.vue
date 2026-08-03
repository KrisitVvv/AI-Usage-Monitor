<script setup>
import { ref, onMounted, onUnmounted, watch, computed } from 'vue'
import * as echarts from 'echarts'
import CountUpText from '../CountUpText.vue'

// 1. 当前选中的时间范围
const timeRange = ref('today')
const loading = ref(true)

// 1.5 当前选中的 vendorId（用于 Token 统计筛选）
const selectedVendorId = ref('all')

// 2. Token 统计实时数据（来自 IPC）
const tokenStats = ref({
  todayTotal: 0, weekTotal: 0, monthTotal: 0, yearTotal: 0,
  models: [],
  vendorIds: [],
  modelUsage: { today: {}, week: {}, month: {}, year: {} },
  vendorModelUsage: { today: {}, week: {}, month: {}, year: {} },
  recentRecords: [],
  todayModelDetails: [],
  hourlyDeltas: [],
  dailySummary: []
})

// Token 统计错误状态
const tokenStatsError = ref('')

const manualRefreshing = ref(false)

let unsubscribeToken = null
let unsubscribeUsage = null

async function manualRefresh() {
  if (!window.electronAPI?.unifiedRefresh || manualRefreshing.value) return
  manualRefreshing.value = true
  try {
    await window.electronAPI.unifiedRefresh()
  } catch (e) {
    console.warn('[Workbench] 统一刷新失败:', e.message)
  } finally {
    setTimeout(() => { manualRefreshing.value = false }, 6000)
  }
}

// 3. 供应商列表和余额
const vendors = ref([])
const balance = ref(null)
const kimiBalances = ref({})

// 4. 模型颜色映射
const MODEL_COLORS = {
  'deepseek-chat': '#3b82f6',
  'deepseek-reasoner': '#6366f1',
  'deepseek-v3': '#3b82f6',
  'deepseek-v4-flash': '#3b82f6',
  'deepseek-v4-pro': '#6366f1',
  'deepseek-v4': '#64748b',
  'default': '#64748b'
}

// 从完整模型名提取显示名：deepseek-v4-flash → flash, deepseek-v4-pro → pro
function getModelDisplayName(model) {
  if (!model) return model
  const lower = model.toLowerCase()
  // 匹配 deepseek-vN-xxx 或 deepseek-chat 等模式，提取最后的变体部分
  const match = lower.match(/^deepseek[-_]?(?:v\d+[-_]?)?(.+)$/)
  if (match && match[1]) {
    return match[1].replace(/[-_]/g, ' ')
  }
  // deepseek-chat → chat, deepseek-reasoner → reasoner
  const simple = lower.match(/^deepseek[-_](.+)$/)
  if (simple && simple[1]) return simple[1]
  return model
}

// 获取模型对应的供应商名
function getVendorName(model) {
  if (!model) return ''
  if (model.toLowerCase().startsWith('deepseek')) return 'DeepSeek'
  return ''
}

function modelColorFn(model) {
  return MODEL_COLORS[model] || MODEL_COLORS.default
}

// Token 数值格式化（缩写：K/W/M/B）
const formatTokens = (value) => {
  if (!value) return '0'
  if (value >= 1000000000) return (value / 1000000000).toFixed(1).replace(/\.0$/, '') + 'B'
  if (value >= 1000000) return (value / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (value >= 10000) return (value / 10000).toFixed(1).replace(/\.0$/, '') + 'W'
  if (value >= 1000) return (value / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  return value.toString()
}

// Token 消耗量显示模式：'abbr' 缩写（K/W/M/B）| 'full' 纯数字（带千分位）
const tokenNumberMode = ref(localStorage.getItem('tokenNumberMode') || 'abbr')

function toggleTokenNumberMode() {
  tokenNumberMode.value = tokenNumberMode.value === 'abbr' ? 'full' : 'abbr'
  localStorage.setItem('tokenNumberMode', tokenNumberMode.value)
}

// 纯数字显示（不带千分位逗号）
const formatFullNumber = (value) => {
  if (!value) return '0'
  return String(value)
}

// 按当前模式格式化 Token 消耗量
const formatTokenDisplay = (value) => {
  return tokenNumberMode.value === 'full' ? formatFullNumber(value) : formatTokens(value)
}

// 5. 图表引用
const tokenChartRef = ref(null)
let tokenChartInstance = null

// 构建柱状图数据（按时间粒度分段）
function buildChartData() {
  const range = timeRange.value
  const hourlyDeltas = tokenStats.value.hourlyDeltas || []
  const dailySummary = tokenStats.value.dailySummary || []
  const vid = selectedVendorId.value

  // 根据是否选中特定 vendor 决定数据源
  let allModels
  let currentUsage = {}
  let vendorModels = null // 当选中特定 vendor 时，记录该 vendor 的模型集合
  if (vid === 'all') {
    const usage = tokenStats.value.modelUsage || {}
    allModels = tokenStats.value.models || []
    currentUsage = usage[range] || {}
  } else {
    // 按 vendor 筛选：从 vendorModelUsage 中获取该 vendor 的模型列表
    vendorModels = tokenStats.value.vendorModelUsage?.[range]?.[vid] || {}
    // 若当前粒度无模型名，从其他粒度回退获取（当日可能仅快照有数据）
    if (Object.keys(vendorModels).length === 0) {
      for (const fb of ['today', 'week', 'month', 'year']) {
        if (fb === range) continue
        const fbData = tokenStats.value.vendorModelUsage?.[fb]?.[vid]
        if (fbData && Object.keys(fbData).length > 0) {
          vendorModels = fbData
          break
        }
      }
    }
    allModels = Object.keys(vendorModels)
    currentUsage = vendorModels
  }

  const models = allModels.length > 0 ? allModels : Object.keys(currentUsage)
  if (models.length === 0) {
    return { xData: ['暂无数据'], series: [], hasData: false }
  }

  let xData = []
  let buckets = [] // [{ label, models: { model: tokens } }]

  if (range === 'today') {
    // 小时粒度 — 展示完整 24 小时（00:00~23:00），无数据的时段显示 0
    const dayOfWeek = new Date().getDay()
    const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    const hourMap = {}
    for (const d of hourlyDeltas) {
      // 当选中特定 vendor 时，只保留该 vendor 使用的模型
      if (vendorModels) {
        const filtered = {}
        for (const [m, t] of Object.entries(d.models || {})) {
          if (m in vendorModels) filtered[m] = t
        }
        hourMap[d.hour] = filtered
      } else {
        hourMap[d.hour] = d.models || {}
      }
    }
    const allHours = []
    for (let h = 0; h < 24; h++) {
      allHours.push(String(h).padStart(2, '0') + ':00')
    }
    xData = allHours.map(h => h === allHours[0] ? dayNames[dayOfWeek] + ' ' + h : h)
    buckets = allHours.map(h => ({
      label: h,
      models: hourMap[h] || {}
    }))
  } else if (range === 'week') {
    // 天粒度（最近 7 天）
    const recent7 = dailySummary.slice(-7)
    xData = recent7.map(d => d.dayLabel)
    buckets = recent7.map(d => {
      // 当选中特定 vendor 时，只保留该 vendor 使用的模型
      const m = vendorModels ? Object.fromEntries(Object.entries(d.models || {}).filter(([k]) => k in vendorModels)) : (d.models || {})
      return { label: d.dayLabel, models: m }
    })
  } else if (range === 'month') {
    // 周粒度：将最近 31 天按自然周聚合
    const weeks = {}
    for (const day of dailySummary) {
      const d = new Date(day.date)
      const dayOfWeek = d.getDay() || 7
      const monday = new Date(d)
      monday.setDate(d.getDate() - dayOfWeek + 1)
      const weekKey = `${monday.getMonth() + 1}/${monday.getDate()}`
      if (!weeks[weekKey]) weeks[weekKey] = { label: weekKey, models: {} }
      for (const [m, t] of Object.entries(day.models || {})) {
        // 当选中特定 vendor 时，只累加该 vendor 使用的模型
        if (vendorModels && !(m in vendorModels)) continue
        weeks[weekKey].models[m] = (weeks[weekKey].models[m] || 0) + t
      }
    }
    buckets = Object.values(weeks)
    xData = buckets.map(b => b.label)
  } else if (range === 'year') {
    // 月粒度：将最近 31 天按月聚合
    const months = {}
    for (const day of dailySummary) {
      const d = new Date(day.date)
      const monthKey = `${d.getFullYear()}/${d.getMonth() + 1}`
      const monthLabel = `${d.getMonth() + 1}月`
      if (!months[monthKey]) months[monthKey] = { label: monthLabel, models: {} }
      for (const [m, t] of Object.entries(day.models || {})) {
        // 当选中特定 vendor 时，只累加该 vendor 使用的模型
        if (vendorModels && !(m in vendorModels)) continue
        months[monthKey].models[m] = (months[monthKey].models[m] || 0) + t
      }
    }
    buckets = Object.values(months)
    xData = buckets.map(b => b.label)
  }

  if (xData.length === 0) {
    return { xData: ['暂无数据'], series: [], hasData: false }
  }

  const series = models.map(m => ({
    name: m,
    rawName: m,
    data: buckets.map(b => Math.max(b.models[m] || 0, 0))
  }))

  return { xData, series, hasData: series.some(s => s.data.some(v => v > 0)) }
}

const timeRangeLabel = computed(() => {
  const map = { today: '今天', week: '本周', month: '本月', year: '今年' }
  return map[timeRange.value] || '今天'
})

// Token 消耗总量（原始数值，用于滚动动画显示）
const totalTokens = computed(() => {
  const range = timeRange.value
  const vid = selectedVendorId.value

  if (vid === 'all') {
    const totals = { today: tokenStats.value.todayTotal, week: tokenStats.value.weekTotal, month: tokenStats.value.monthTotal, year: tokenStats.value.yearTotal }
    return totals[range] || 0
  }

  // 按 vendor 筛选：从 vendorModelUsage 中汇总该 vendor 的模型用量
  const vUsage = tokenStats.value.vendorModelUsage?.[range]?.[vid] || {}
  const total = Object.values(vUsage).reduce((s, v) => s + v, 0)

  // 今日粒度下，若 vendorModelUsage 值为 0 但模型 key 存在，则从 hourlyDeltas 聚合（数据源对齐）
  if (range === 'today' && total === 0 && Object.keys(vUsage).length > 0) {
    const hourlyDeltas = tokenStats.value.hourlyDeltas || []
    let aggregated = 0
    for (const d of hourlyDeltas) {
      for (const [m, t] of Object.entries(d.models || {})) {
        if (m in vUsage) aggregated += t
      }
    }
    return aggregated
  }

  return total
})

// TOP3 模型
const top3Tokens = computed(() => {
  const range = timeRange.value
  const vid = selectedVendorId.value
  let usage
  if (vid === 'all') {
    usage = tokenStats.value.modelUsage?.[range] || {}
  } else {
    usage = tokenStats.value.vendorModelUsage?.[range]?.[vid] || {}
    // 今日粒度下，若值为 0 但模型 key 存在，从 hourlyDeltas 获取真实值
    if (range === 'today') {
      const totalFromVUsage = Object.values(usage).reduce((s, v) => s + v, 0)
      if (totalFromVUsage === 0 && Object.keys(usage).length > 0) {
        const hourlyDeltas = tokenStats.value.hourlyDeltas || []
        const aggregated = {}
        for (const d of hourlyDeltas) {
          for (const [m, t] of Object.entries(d.models || {})) {
            if (m in usage) aggregated[m] = (aggregated[m] || 0) + t
          }
        }
        usage = aggregated
      }
    }
  }
  return Object.entries(usage)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([model, tokens]) => ({
      name: model,
      displayName: model,
      usedTokens: tokens
    }))
})

// 当前选中 vendor 的名称（用于显示）
const selectedVendorName = computed(() => {
  if (selectedVendorId.value === 'all') return '全部账号'
  const v = vendors.value.find(v => v.id === selectedVendorId.value)
  return v?.customName || v?.provider || selectedVendorId.value
})

// DeepSeek 供应商列表（用于筛选下拉框）
const deepseekVendors = computed(() => {
  return (vendors.value || []).filter(v => (v.provider || '').toLowerCase().includes('deepseek'))
})

// 进度条标签
const getPlanLabel = (model, slotIndex) => {
  if (slotIndex === 0) return 'Token 用量进度'
  return ''
}

// 供应商额度列表（同步 ProgressPage 的供应商数据）
const modelUsageAndQuotas = computed(() => {
  const vendorList = vendors.value || []
  const bal = balance.value

  if (vendorList.length === 0 && !bal) return []

  const list = []

  for (const v of vendorList) {
    const vendorName = v.provider || v.name || ''
    const providerShort = vendorName.replace(/\s*API$/i, '').trim() || vendorName
    const displayName = v.customName || providerShort

    // 使用 balance 数据（DeepSeek 用全局余额，Kimi 按 vendorId 取余额）
    const isDeepSeek = vendorName.toLowerCase().includes('deepseek')
    const isKimi = vendorName.toLowerCase().includes('kimi')
    const vendorBal = isDeepSeek ? bal : (isKimi ? (kimiBalances.value[v.id] || null) : null)
    const isCurrentVendor = !!vendorBal
    const budget = isCurrentVendor ? (vendorBal.totalBudget || 0) : 0
    const remaining = isCurrentVendor ? (vendorBal.remaining || 0) : 0
    const spent = isCurrentVendor ? (vendorBal.spent || 0) : 0
    const usedPercent = isCurrentVendor ? (vendorBal.usedPercent || 0) : 0
    const currency = vendorBal?.currency === 'CNY' ? '¥' : '$'

    list.push({
      id: v.id,
      provider: vendorName,
      name: displayName,
      type: providerShort,
      billingModel: v.billingMode || v.billingModel || 'plan',
      usedTokens: spent,
      usedTokensFormatted: budget > 0 ? `${currency}${spent.toFixed(2)}` : '0',
      plans: [{ limit: budget > 0 ? budget : 1000000 }],
      remaining: remaining,
      budget: budget,
      unit: currency,
      status: usedPercent >= 90 ? 'danger' : usedPercent >= 75 ? 'warning' : 'safe',
      apiKey: v.apiKey ? '***' + v.apiKey.slice(-4) : '',
      _live: isCurrentVendor && !vendorBal?._stale
    })
  }

  // 仅当有 DeepSeek 供应商存在于 vendorList 中时，才使用余额显示 DeepSeek 条目
  if (list.length === 0 && bal && vendorList.some(v => (v.provider || '').toLowerCase().includes('deepseek'))) {
    list.push({
      id: 'deepseek-default',
      provider: 'DeepSeek API',
      name: 'DeepSeek',
      type: 'DeepSeek',
      billingModel: 'plan',
      usedTokens: bal.spent || 0,
      usedTokensFormatted: bal.totalBudget > 0 ? `¥${(bal.spent || 0).toFixed(2)}` : '0',
      plans: [{ limit: bal.totalBudget || 1000000 }],
      remaining: bal.remaining || 0,
      budget: bal.totalBudget || 0,
      unit: '¥',
      status: (bal.usedPercent || 0) >= 90 ? 'danger' : (bal.usedPercent || 0) >= 75 ? 'warning' : 'safe',
      apiKey: '',
      _live: true
    })
  }

  return list
})

// 初始化图表
const initTokenChart = () => {
  if (!tokenChartRef.value) return
  tokenChartInstance = echarts.init(tokenChartRef.value)
  updateTokenChart()
}

const updateTokenChart = () => {
  if (!tokenChartInstance) return
  const chartData = buildChartData()

  if (!chartData.hasData) {
    tokenChartInstance.setOption({
      title: { text: '尚无 Token 用量数据', left: 'center', top: 'center', textStyle: { color: '#94a3b8', fontSize: 14 } },
      xAxis: { show: false },
      yAxis: { show: false },
      series: []
    }, true)
    return
  }

  const seriesList = chartData.series.map((s, i) => {
    // 动态判断每个数据点是否为该柱子的视觉顶端段：
    // 仅当该段非零且其上方所有系列在该点都为 0 时，它才是柱子顶端 → 加圆角；
    // 段与段之间的拼接处保持直角
    const data = s.data.map((v, j) => {
      if (!v || v <= 0) return { value: v, itemStyle: { borderRadius: 0 } }
      const above = chartData.series.slice(i + 1).reduce((sum, up) => sum + (up.data[j] || 0), 0)
      return {
        value: v,
        itemStyle: {
          borderRadius: above <= 0 ? [4, 4, 0, 0] : 0
        }
      }
    })
    return {
      name: s.name,
      type: 'bar',
      stack: 'total',
      data,
      itemStyle: {
        color: modelColorFn(s.rawName)
      },
      emphasis: {
        itemStyle: { borderWidth: 1, borderColor: '#fff', shadowBlur: 8, shadowColor: 'rgba(0,0,0,0.12)' }
      }
    }
  })

  const option = {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params) => {
        if (!params?.length) return ''
        const header = params[0].axisValue
        const lines = params.map(p => {
          // data 项可能为 { value, itemStyle } 对象，取其中的原始数值
          const v = typeof p.value === 'object' && p.value !== null ? p.value.value : p.value
          return `${p.marker} ${p.seriesName}: ${formatTokenDisplay(v)}`
        })
        return `${header}<br/>${lines.join('<br/>')}`
      }
    },
    legend: { orient: 'horizontal', bottom: '0%', left: 'center', icon: 'roundRect', itemWidth: 12, itemHeight: 10, itemGap: 16, textStyle: { color: '#64748b', fontSize: 11 } },
    grid: { left: '8%', right: '5%', bottom: '18%', top: '6%' },
    xAxis: {
      type: 'category', data: chartData.xData,
      axisLine: { lineStyle: { color: '#cbd5e1' } },
      axisLabel: { color: '#64748b', rotate: chartData.xData.length > 12 ? 45 : 0, fontSize: chartData.xData.length > 12 ? 10 : 12 }
    },
    yAxis: {
      type: 'value', name: 'Tokens', nameTextStyle: { color: '#64748b', fontSize: 12 },
      axisLine: { lineStyle: { color: '#cbd5e1' } },
      axisLabel: { color: '#64748b', formatter: (v) => formatTokens(v) },
      splitLine: { lineStyle: { color: '#f1f5f9' } }
    },
    series: seriesList
  }
  tokenChartInstance.setOption(option, true)
}

watch(timeRange, () => updateTokenChart())
watch(tokenStats, () => updateTokenChart(), { deep: true })
watch(selectedVendorId, () => updateTokenChart())
watch(tokenNumberMode, () => updateTokenChart())

const handleResize = () => {
  if (tokenChartInstance && !tokenChartInstance.isDisposed()) tokenChartInstance.resize()
}



// ---------- 处理来自 ModelDetailPage 的重命名通知 ----------
function applyPendingRenames() {
  try {
    const pending = JSON.parse(localStorage.getItem('pendingVendorRenames') || '[]')
    if (!pending.length) return
    const vendorList = vendors.value || []
    let changed = false
    for (const { vendorId, customName } of pending) {
      const v = vendorList.find(vendor => vendor.id === vendorId)
      if (v && v.customName !== customName) {
        v.customName = customName
        changed = true
      }
    }
    if (changed) {
      vendors.value = [...vendorList]
    }
    localStorage.removeItem('pendingVendorRenames')
  } catch { /* 忽略 */ }
}

onMounted(async () => {
  if (window.electronAPI) {
    try {
      const stats = await window.electronAPI.getTokenStats()
      if (stats) {
        tokenStats.value = stats
        tokenStatsError.value = ''
      } else {
        tokenStatsError.value = 'Token 统计数据为空'
      }
    } catch (e) {
      tokenStatsError.value = '加载 Token 统计失败: ' + (e.message || '未知错误')
      console.warn('[Workbench] 加载 token 统计失败:', e.message)
    }

    try {
      const usageData = await window.electronAPI.getUsageData()
      if (usageData) {
        vendors.value = usageData.vendors || []
        balance.value = usageData.deepseekBalance || null
        kimiBalances.value = usageData.kimiBalances || {}
      }
    } catch (e) {
      console.warn('[Workbench] 加载用量数据失败:', e.message)
    }

    // 处理来自详情页的重命名通知
    applyPendingRenames()

    unsubscribeToken = window.electronAPI.onTokenStatsUpdated((data) => {
      if (data) {
        tokenStats.value = data
        tokenStatsError.value = ''
      }
    })

    unsubscribeUsage = window.electronAPI.onUsageDataUpdated((data) => {
      if (data.vendors) vendors.value = data.vendors
      balance.value = data.deepseekBalance || null
      kimiBalances.value = data.kimiBalances || {}
    })
  } else {
    tokenStatsError.value = '运行环境不支持（非 Electron）'
  }

  setTimeout(() => { loading.value = false }, 400)
  initTokenChart()
  window.addEventListener('resize', handleResize)
  window.addEventListener('sidebar-toggle-resize', handleResize)
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  window.removeEventListener('sidebar-toggle-resize', handleResize)
  if (typeof unsubscribeToken === 'function') unsubscribeToken()
  if (typeof unsubscribeUsage === 'function') unsubscribeUsage()
  if (tokenChartInstance) { tokenChartInstance.dispose(); tokenChartInstance = null }
})
</script>

<template>
  <div class="workbench-page">
    <div class="dashboard-layout">

      <!-- 错误通知 -->
      <div v-if="tokenStatsError" class="error-notice">
        <span class="error-notice-icon">&#9888;</span>
        <span class="error-notice-text">{{ tokenStatsError }}</span>
      </div>



      <!-- 1. 上层：趋势图 + Token 消耗总量 -->
      <div class="section charts-section">
        <div class="charts-grid">
          <div class="chart-card">
            <div ref="tokenChartRef" class="chart-container"></div>
          </div>
          <div class="total-card">
            <div class="total-card-header">
              <span class="total-label">Token 消耗总量</span>
              <div class="time-range-actions">
                <select class="time-range-select" v-model="selectedVendorId" v-if="deepseekVendors.length > 1">
                  <option value="all">全部账号</option>
                  <option v-for="v in deepseekVendors" :key="v.id" :value="v.id">{{ v.customName || v.provider }}</option>
                </select>
                <select class="time-range-select" v-model="timeRange">
                  <option value="today">今天</option>
                  <option value="week">本周</option>
                  <option value="month">本月</option>
                  <option value="year">今年</option>
                </select>
                <button class="refresh-btn" @click="manualRefresh" :disabled="manualRefreshing" title="手动刷新数据">
                  <span class="refresh-icon" :class="{ spinning: manualRefreshing }">&#x21bb;</span>
                </button>
              </div>
            </div>
            <div class="total-value-wrap">
              <span class="total-number"><CountUpText :value="totalTokens" :format="formatTokenDisplay" /></span>
              <button class="number-mode-toggle" @click="toggleTokenNumberMode" :title="tokenNumberMode === 'abbr' ? '点击切换为纯数字显示' : '点击切换为缩写显示'">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M4 7h16"/>
                  <path d="M16 3l4 4-4 4"/>
                  <path d="M20 17H4"/>
                  <path d="M8 13l-4 4 4 4"/>
                </svg>
                <span class="toggle-target">{{ tokenNumberMode === 'abbr' ? '123' : 'KMB' }}</span>
              </button>
            </div>
            <div class="total-footer">
              <div class="top3-list">
                <div v-if="top3Tokens.length === 0" class="empty-hint">尚无数据</div>
                <div class="top3-item" v-for="(model, i) in top3Tokens" :key="model.name">
                  <span class="top3-rank" :class="'rank-' + (i + 1)">{{ i + 1 }}</span>
                  <span class="top3-name">{{ model.displayName }}</span>
                  <span class="top3-value"><CountUpText :value="model.usedTokens" :format="formatTokenDisplay" /></span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 2. 下层：模型用量进度条 -->
      <div class="section top-stats-section">
        <div class="section-card-wrapper">
          <div class="section-card-header">
            <div class="header-title-group">
              <h3 class="container-title">用量与余量</h3>
            </div>
          </div>

          <div class="models-progress-list" v-if="modelUsageAndQuotas.length">
            <div
              v-for="model in modelUsageAndQuotas"
              :key="model.id"
              class="model-progress-item"
            >
              <div class="model-progress-header">
                <div class="model-meta">
                  <span v-if="model.provider?.toLowerCase().includes('deepseek')" class="model-logo"><img class="vendor-logo-img" src="/deepseek.png" alt="DeepSeek" /></span>
                  <span v-else-if="model.provider?.toLowerCase().includes('kimi')" class="model-logo"><img class="vendor-logo-img" src="/kimi.png" alt="Kimi" /></span>
                  <span v-else class="model-badge" :class="model.type?.toLowerCase() + '-badge' || 'default-badge'">{{ model.type || 'API' }}</span>
                  <span class="model-name-text">{{ model.name }}</span>
                  <span v-if="model._live" class="live-badge">实时</span>
                </div>
              </div>
              <div class="progress-bars">
                <div class="progress-row" v-if="model.budget > 0">
                  <span class="progress-label">余额</span>
                  <div class="progress-track-wrap">
                    <div class="progress-track">
                      <div
                        class="progress-fill billing"
                        :style="{ width: Math.min((model.budget - model.remaining) / model.budget * 100, 100) + '%' }"
                      ></div>
                    </div>
                    <span class="progress-text">{{ model.unit }}{{ (model.remaining || 0).toFixed(2) }} / {{ model.unit }}{{ (model.budget || 0).toFixed(2) }}</span>
                  </div>
                </div>
                <div class="progress-row" v-else>
                  <span class="progress-label">余额</span>
                  <div class="progress-track-wrap">
                    <div class="progress-track">
                      <div class="progress-fill billing" style="width:0%"></div>
                    </div>
                    <span class="progress-text">—</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="empty-state">
            <span>尚无供应商数据，请先在"供应商额度"页面添加供应商</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.workbench-page {
  padding: 1.25rem;
  background-color: transparent;
  height: 100%;
  overflow-y: auto;
  box-sizing: border-box;
}

.dashboard-layout {
  display: flex;
  flex-direction: column;
  gap: 1.75rem;
}

.section { width: 100%; }

.section-card-wrapper {
  background: white;
  border-radius: 12px;
  padding: 1.25rem 1.5rem;
  box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05), 0 1px 2px -1px rgba(0, 0, 0, 0.05);
  border: 1px solid #f1f5f9;
}

.section-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid #f1f5f9;
}

.container-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  color: #1e293b;
}

.container-subtitle {
  font-size: 0.75rem;
  color: #94a3b8;
  margin-top: 0.2rem;
  display: block;
}

.models-progress-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

.model-progress-item {
  background: #f8fafc;
  border: 1px solid #f1f5f9;
  border-radius: 8px;
  padding: 0.875rem 1.25rem;
  transition: border-color 0.2s, background-color 0.2s;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.model-progress-item:hover {
  background: #f1f5f9;
  border-color: #cbd5e1;
}

.model-progress-header {
  margin-bottom: 0.625rem;
}

.model-meta {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 220px;
}

.model-name-text {
  font-size: 0.9rem;
  font-weight: 600;
  color: #334155;
}

.model-badge {
  font-size: 0.6875rem;
  font-weight: 600;
  padding: 0.125rem 0.5rem;
  border-radius: 4px;
  text-transform: uppercase;
}
.model-logo { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.model-logo .vendor-logo-img { width: 100%; height: 100%; object-fit: contain; }

.default-badge { background: #f1f5f9; color: #64748b; }
.deepseek-badge { background: #eff6ff; color: #1d4ed8; }

.live-badge {
  font-size: 0.625rem;
  color: #16a34a;
  background: #f0fdf4;
  padding: 1px 5px;
  border-radius: 3px;
  white-space: nowrap;
}

.provider-icon { flex-shrink: 0; }
.provider-icon.deepseek { color: #1d4ed8; }

.progress-bars {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.progress-row {
  display: flex;
  align-items: center;
  gap: 0.625rem;
}

.progress-label {
  font-size: 0.75rem;
  color: #64748b;
  width: 7rem;
  flex-shrink: 0;
  white-space: nowrap;
}

.progress-track-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.progress-track {
  flex: 1;
  height: 6px;
  background: #e2e8f0;
  border-radius: 3px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s ease;
}

.progress-fill.coding-plan {
  background: linear-gradient(90deg, #3b82f6, #6366f1);
}

.progress-fill.billing {
  background: linear-gradient(90deg, #10b981, #14b8a6);
}

.progress-text {
  font-size: 0.75rem;
  color: #64748b;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  white-space: nowrap;
  flex-shrink: 0;
}

.charts-section { container-type: inline-size; }

.charts-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.25rem;
}

.time-range-actions {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.time-range-select {
  padding: 0.25rem 0.5rem;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: white;
  font-size: 0.75rem;
  color: #475569;
  cursor: pointer;
  outline: none;
  transition: border-color 0.2s;
}

.time-range-select:hover,
.time-range-select:focus {
  border-color: #3b82f6;
}

.refresh-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: white;
  cursor: pointer;
  color: #64748b;
  font-size: 0.875rem;
  transition: border-color 0.2s, color 0.2s;
  padding: 0;
}

.refresh-btn:hover:not(:disabled) {
  border-color: #3b82f6;
  color: #3b82f6;
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.refresh-icon {
  display: inline-block;
  line-height: 1;
}

.refresh-icon.spinning {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.chart-card {
  background: white;
  border-radius: 12px;
  padding: 1.25rem;
  box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05), 0 1px 2px -1px rgba(0, 0, 0, 0.05);
  height: 260px;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.chart-container { width: 100%; height: 100%; }

.total-card {
  background: white;
  border-radius: 12px;
  padding: 1.25rem;
  box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05), 0 1px 2px -1px rgba(0, 0, 0, 0.05);
  height: 260px;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.total-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
}

.total-label {
  font-size: 0.875rem;
  font-weight: 600;
  color: #334155;
}

.total-value-wrap {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.total-number {
  font-size: 3rem;
  font-weight: 800;
  color: #467CFE;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  line-height: 1;
}

/* Token 消耗量显示模式切换按钮（数字右下角） */
.number-mode-toggle {
  position: absolute;
  right: 0.25rem;
  bottom: 0.25rem;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 1.7rem;
  padding: 0 0.6rem;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: white;
  color: #94a3b8;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  transition: all 0.2s ease;
}
.number-mode-toggle:hover {
  border-color: #467CFE;
  color: #467CFE;
  background: #f8faff;
}
.number-mode-toggle .toggle-target {
  font-size: 0.7rem;
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  line-height: 1;
}

.total-footer {
  padding-top: 1rem;
  border-top: 1px solid #f1f5f9;
}

.top3-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.top3-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.top3-rank {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.6875rem;
  font-weight: 600;
  color: #fff;
  flex-shrink: 0;
}

.top3-rank.rank-1 { background: #ef4444; }
.top3-rank.rank-2 { background: #f59e0b; }
.top3-rank.rank-3 { background: #3b82f6; }

.top3-name {
  font-size: 0.8125rem;
  color: #475569;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 4px;
}

.top3-vendor {
  font-size: 0.6875rem;
  color: #94a3b8;
  background: #f1f5f9;
  padding: 1px 5px;
  border-radius: 3px;
  white-space: nowrap;
}

.top3-value {
  font-size: 0.8125rem;
  font-weight: 600;
  color: #0f172a;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  flex-shrink: 0;
}

.empty-hint { font-size: 0.8rem; color: #94a3b8; text-align: center; padding: 0.5rem 0; }

.empty-state {
  text-align: center;
  padding: 2rem 1rem;
  color: #94a3b8;
  font-size: 0.85rem;
}

.error-notice {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.625rem 1rem;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 8px;
  color: #b91c1c;
  font-size: 0.8125rem;
  margin-bottom: 0.5rem;
}

.error-notice-icon {
  flex-shrink: 0;
  font-size: 1rem;
}

.error-notice-text {
  flex: 1;
  line-height: 1.4;
}

@container (max-width: 53.9em) {
  .charts-grid { grid-template-columns: 1fr; }
  .chart-card { height: 300px; }
}

@media (max-width: 768px) {
  .models-progress-list { grid-template-columns: 1fr; }
}
</style>
