<script setup>
// 1. 当前选中的时间范围：'today' (今天) | 'week' (本周) | 'month' (本月) | 'year' (今年)
import { ref, onMounted, onUnmounted, watch, computed } from 'vue'
import * as echarts from 'echarts'

// 1. 当前选中的时间范围：'today' (今天) | 'week' (本周) | 'month' (本月) | 'year' (今年)
const timeRange = ref('today')

// 2. 模拟各个时间维度下从后端返还的“模型用量与余量”原始 API 接口数据
// 提示：模拟后端接口只返还这一类最原始的数据，包含用量和余额。
// 饼图和卡片列表的比例、展示全部通过前端二次处理计算得出。
const mockRawApiData = {
  today: [
    { id: 1, provider: 'DeepSeek API', name: 'DeepSeek-V3', usedTokens: 8500, plans: [{ limit: 10000 }], remaining: 1.50, budget: 10.00, threshold: 10.00, unit: '元', type: 'DeepSeek', status: 'danger', billingMode: 'plan' },
    { id: 2, provider: 'Kimi API', name: 'Kimi (Moonshot)', usedTokens: 2100, plans: [{ limit: 8000 }], remaining: 8.40, budget: 20.00, threshold: 20.00, unit: '元', type: 'Moonshot', status: 'warning', billingMode: 'plan' },
    { id: 3, provider: 'OpenAI API', name: 'GPT-4o', usedTokens: 4200, plans: [{ limit: 8000 }, { limit: 10000 }], remaining: 152.00, budget: 200.00, threshold: 50.00, unit: '美元', type: 'OpenAI', status: 'safe', billingMode: 'plan' },
    { id: 4, provider: 'Aliyun API', name: 'Qwen-Max', usedTokens: 1200, plans: [], remaining: 88.10, budget: 100.00, threshold: 10.00, unit: '元', type: 'Aliyun', status: 'safe', billingMode: 'billing' }
  ],
  week: [
    { id: 1, provider: 'DeepSeek API', name: 'DeepSeek-V3', usedTokens: 38000, plans: [{ limit: 50000 }], remaining: 1.50, budget: 10.00, threshold: 10.00, unit: '元', type: 'DeepSeek', status: 'danger', billingMode: 'plan' },
    { id: 2, provider: 'Kimi API', name: 'Kimi (Moonshot)', usedTokens: 12000, plans: [{ limit: 25000 }], remaining: 8.40, budget: 20.00, threshold: 20.00, unit: '元', type: 'Moonshot', status: 'warning', billingMode: 'plan' },
    { id: 3, provider: 'OpenAI API', name: 'GPT-4o', usedTokens: 45000, plans: [{ limit: 40000 }, { limit: 60000 }], remaining: 152.00, budget: 200.00, threshold: 50.00, unit: '美元', type: 'OpenAI', status: 'safe', billingMode: 'plan' },
    { id: 4, provider: 'Aliyun API', name: 'Qwen-Max', usedTokens: 8000, plans: [], remaining: 88.10, budget: 100.00, threshold: 10.00, unit: '元', type: 'Aliyun', status: 'safe', billingMode: 'billing' }
  ],
  month: [
    { id: 1, provider: 'DeepSeek API', name: 'DeepSeek-V3', usedTokens: 210000, plans: [{ limit: 300000 }], remaining: 1.50, budget: 10.00, threshold: 10.00, unit: '元', type: 'DeepSeek', status: 'danger', billingMode: 'plan' },
    { id: 2, provider: 'Kimi API', name: 'Kimi (Moonshot)', usedTokens: 65000, plans: [{ limit: 100000 }], remaining: 8.40, budget: 20.00, threshold: 20.00, unit: '元', type: 'Moonshot', status: 'warning', billingMode: 'plan' },
    { id: 3, provider: 'OpenAI API', name: 'GPT-4o', usedTokens: 120000, plans: [{ limit: 150000 }, { limit: 200000 }], remaining: 152.00, budget: 200.00, threshold: 50.00, unit: '美元', type: 'OpenAI', status: 'safe', billingMode: 'plan' },
    { id: 4, provider: 'Aliyun API', name: 'Qwen-Max', usedTokens: 140000, plans: [], remaining: 88.10, budget: 100.00, threshold: 10.00, unit: '元', type: 'Aliyun', status: 'safe', billingMode: 'billing' }
  ],
  year: [
    { id: 1, provider: 'DeepSeek API', name: 'DeepSeek-V3', usedTokens: 2800000, plans: [{ limit: 5000000 }], remaining: 1.50, budget: 10.00, threshold: 10.00, unit: '元', type: 'DeepSeek', status: 'danger', billingMode: 'plan' },
    { id: 2, provider: 'Kimi API', name: 'Kimi (Moonshot)', usedTokens: 850000, plans: [{ limit: 1200000 }], remaining: 8.40, budget: 20.00, threshold: 20.00, unit: '元', type: 'Moonshot', status: 'warning', billingMode: 'plan' },
    { id: 3, provider: 'OpenAI API', name: 'GPT-4o', usedTokens: 1800000, plans: [{ limit: 2000000 }, { limit: 3000000 }], remaining: 152.00, budget: 200.00, threshold: 50.00, unit: '美元', type: 'OpenAI', status: 'safe', billingMode: 'plan' },
    { id: 4, provider: 'Aliyun API', name: 'Qwen-Max', usedTokens: 920000, plans: [], remaining: 88.10, budget: 100.00, threshold: 10.00, unit: '元', type: 'Aliyun', status: 'safe', billingMode: 'billing' }
  ]
}

// 3. 各模型在不同时间段的 Token 用量数据（柱状图数据源）
const MODEL_COLORS = {
  'DeepSeek-V3': '#3b82f6',
  'Kimi (Moonshot)': '#10b981',
  'GPT-4o': '#f59e0b',
  'Qwen-Max': '#8b5cf6'
}

const MODEL_NAMES = ['DeepSeek-V3', 'Kimi (Moonshot)', 'GPT-4o', 'Qwen-Max']

const mockTokenData = {
  today: {
    xData: ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00', '24:00'],
    series: [
      { name: 'DeepSeek-V3', data: [320, 210, 900, 1800, 1400, 2200, 800] },
      { name: 'Kimi (Moonshot)', data: [180, 120, 520, 850, 600, 1100, 350] },
      { name: 'GPT-4o', data: [400, 280, 1100, 2100, 1700, 3200, 1200] },
      { name: 'Qwen-Max', data: [300, 190, 980, 1450, 1100, 3000, 750] }
    ]
  },
  week: {
    xData: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
    series: [
      { name: 'DeepSeek-V3', data: [6800, 8500, 7200, 10000, 9200, 3800, 4200] },
      { name: 'Kimi (Moonshot)', data: [3200, 4000, 3500, 5200, 4500, 1800, 2200] },
      { name: 'GPT-4o', data: [8000, 9800, 8500, 14000, 12000, 4200, 5000] },
      { name: 'Qwen-Max', data: [7000, 8700, 7400, 12800, 9300, 5200, 6600] }
    ]
  },
  month: {
    xData: ['第1周', '第2周', '第3周', '第4周'],
    series: [
      { name: 'DeepSeek-V3', data: [48000, 52000, 50000, 60000] },
      { name: 'Kimi (Moonshot)', data: [22000, 25000, 24000, 28000] },
      { name: 'GPT-4o', data: [55000, 60000, 58000, 72000] },
      { name: 'Qwen-Max', data: [50000, 55000, 60000, 65000] }
    ]
  },
  year: {
    xData: ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'],
    series: [
      { name: 'DeepSeek-V3', data: [320000, 300000, 380000, 410000, 450000, 480000, 420000, 460000, 520000, 580000, 650000, 700000] },
      { name: 'Kimi (Moonshot)', data: [150000, 140000, 180000, 190000, 220000, 240000, 210000, 230000, 280000, 300000, 340000, 360000] },
      { name: 'GPT-4o', data: [380000, 360000, 450000, 480000, 520000, 560000, 510000, 550000, 620000, 680000, 750000, 820000] },
      { name: 'Qwen-Max', data: [400000, 380000, 490000, 520000, 580000, 610000, 550000, 600000, 690000, 750000, 820000, 900000] }
    ]
  }
}

// 4. 当前组件实际使用的响应式模型数据对象，监听 timeRange 时会从原始 API 数据中提取
const modelUsageAndQuotas = ref([])

// 根据供应商类型和 slot 索引获取进度条标签
const getPlanLabel = (model, slotIndex) => {
  if (slotIndex === 0) return 'Coding Plan'
  if (model.type === 'OpenAI') return '30 天'
  return ''
}

// Token 数值格式化：超过 1000 显示 K，超过 10000 显示 W，超过 1000000 显示 M，超过 1000000000 显示 B
const formatTokens = (value) => {
  if (value >= 1000000000) return (value / 1000000000).toFixed(1).replace(/\.0$/, '') + 'B'
  if (value >= 1000000) return (value / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (value >= 10000) return (value / 10000).toFixed(1).replace(/\.0$/, '') + 'W'
  if (value >= 1000) return (value / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  return value.toString()
}

// 5. 图表 DOM 元素的引用 (Vue 模板中 ref 属性对应的变量)
const tokenChartRef = ref(null)

// 6. 存储 ECharts 实例的变量
let tokenChartInstance = null

// 初始化 Token 用量柱状图
const initTokenChart = () => {
  if (!tokenChartRef.value) return
  tokenChartInstance = echarts.init(tokenChartRef.value)
  updateTokenChart()
}

// 渲染/更新各模型 Token 用量分组柱状图
const updateTokenChart = () => {
  if (!tokenChartInstance) return
  const currentData = mockTokenData[timeRange.value]

  const seriesList = currentData.series.map(s => ({
    name: s.name,
    type: 'bar',
    stack: 'total',
    data: s.data,
    itemStyle: {
      color: MODEL_COLORS[s.name],
      borderRadius: s.name === currentData.series[currentData.series.length - 1].name ? [4, 4, 0, 0] : 0
    },
    emphasis: {
      itemStyle: {
        color: MODEL_COLORS[s.name],
        borderWidth: 1,
        borderColor: '#fff',
        shadowBlur: 8,
        shadowColor: 'rgba(0,0,0,0.12)'
      }
    }
  }))

  const option = {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      valueFormatter: (value) => {
        if (value == null) return ''
        if (value >= 1000000000) return (value / 1000000000).toFixed(1).replace(/\.0$/, '') + 'B'
        if (value >= 1000000) return (value / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
        if (value >= 1000) return (value / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
        return value.toString()
      }
    },
    legend: {
      orient: 'horizontal',
      bottom: '0%',
      left: 'center',
      icon: 'roundRect',
      itemWidth: 12,
      itemHeight: 10,
      itemGap: 16,
      textStyle: { color: '#64748b', fontSize: 11 }
    },
    grid: { left: '8%', right: '5%', bottom: '18%', top: '6%' },
    xAxis: {
      type: 'category',
      data: currentData.xData,
      axisLine: { lineStyle: { color: '#cbd5e1' } },
      axisLabel: { color: '#64748b' }
    },
    yAxis: {
      type: 'value',
      name: 'Tokens',
      nameTextStyle: { color: '#64748b', fontSize: 12 },
      axisLine: { lineStyle: { color: '#cbd5e1' } },
      axisLabel: {
        color: '#64748b',
        formatter: (value) => {
          if (value >= 1000000000) return (value / 1000000000).toFixed(1) + 'B'
          if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M'
          if (value >= 10000) return (value / 10000).toFixed(1) + 'W'
          if (value >= 1000) return (value / 1000).toFixed(1) + 'K'
          return value
        }
      },
      splitLine: { lineStyle: { color: '#f1f5f9' } }
    },
    series: seriesList
  }
  tokenChartInstance.setOption(option, true)
}

// 监听时间范围变化，动态更新图表（模型用量与余量概览保持不变）
watch(timeRange, () => {
  updateTokenChart()
})

// 5. 计算属性：Token 消耗总量（格式化后）
const totalTokensFormatted = computed(() => {
  const total = modelUsageAndQuotas.value.reduce((sum, item) => sum + item.usedTokensRaw, 0)
  return formatTokens(total)
})

// 6. 计算属性：Token 用量 TOP3 模型
const top3Tokens = computed(() => {
  return [...modelUsageAndQuotas.value]
    .sort((a, b) => b.usedTokensRaw - a.usedTokensRaw)
    .slice(0, 3)
})

// 7. 计算属性：只筛选出状态为 danger 和 warning 的告警模型列表，传给底层告警卡片展示
const activeQuotaAlerts = computed(() => {
  return modelUsageAndQuotas.value.filter(item => item.status === 'danger' || item.status === 'warning')
})

// 处理窗口大小变化时，图表自适应缩放（加入防御性判断，防止实例已被销毁时 resize 报错）
const handleResize = () => {
  if (tokenChartInstance && !tokenChartInstance.isDisposed()) {
    tokenChartInstance.resize()
  }
}

// 生命周期：组件挂载时（此时 DOM 已经生成完毕，可以安全地初始化 ECharts）
onMounted(() => {
  // 1. 初始化时手动触发一次数据清洗
  const rawList = mockRawApiData[timeRange.value] || []
  modelUsageAndQuotas.value = rawList.map(item => ({
    ...item,
    usedTokensFormatted: formatTokens(item.usedTokens),
    usedTokensRaw: item.usedTokens
  }))

  // 2. 初始化并绑定图表
  initTokenChart()
  window.addEventListener('resize', handleResize)
  // 监听侧边栏动画伸缩事件，保证图表不被折叠或挤压
  window.addEventListener('sidebar-toggle-resize', handleResize)
})

// 生命周期：组件销毁时（必须解绑事件监听并销毁图表，否则会产生内存泄漏，甚至导致应用崩溃）
onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  window.removeEventListener('sidebar-toggle-resize', handleResize)
  if (tokenChartInstance) {
    tokenChartInstance.dispose()
    tokenChartInstance = null
  }
})
</script>

<template>
  <div class="workbench-page">
    <!-- 核心三层大容器布局 -->
    <div class="dashboard-layout">
      
      <!-- 1. 上层大容器：趋势折线图和占比圆形图 -->
      <div class="section charts-section">
        <div class="charts-grid">
          <!-- Token 用量趋势图 -->
          <div class="chart-card">
            <div ref="tokenChartRef" class="chart-container"></div>
          </div>
          <!-- Token 消耗总量展示卡 -->
          <div class="total-card">
            <div class="total-card-header">
              <span class="total-label">Token 消耗总量</span>
              <select
                class="time-range-select"
                v-model="timeRange"
                @change="timeRange = $event.target.value"
              >
                <option value="today">今天</option>
                <option value="week">本周</option>
                <option value="month">本月</option>
                <option value="year">今年</option>
              </select>
            </div>
            <div class="total-value-wrap">
              <span class="total-number">{{ totalTokensFormatted }}</span>
            </div>
            <div class="total-footer">
              <div class="top3-list">
                <div class="top3-item" v-for="(model, i) in top3Tokens" :key="model.name">
                  <span class="top3-rank" :class="'rank-' + (i + 1)">{{ i + 1 }}</span>
                  <span class="top3-name">{{ model.name }}</span>
                  <span class="top3-value">{{ model.usedTokensFormatted }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 2. 中层大容器：各个模型的用量进度条 -->
      <div class="section top-stats-section">
        <div class="section-card-wrapper">
          <div class="section-card-header">
            <div class="header-title-group">
              <h3 class="container-title">模型用量与余量</h3>
            </div>
          </div>

          <div class="models-progress-list">
            <div 
              v-for="model in modelUsageAndQuotas" 
              :key="model.name"
              class="model-progress-item"
            >
              <div class="model-progress-header">
                <div class="model-meta">
                  <!-- 供应商图标（有则只显示图标，无则显示文字 badge） -->
                  <template v-if="model.type === 'DeepSeek'">
                    <svg class="provider-icon deepseek" width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 2L2 7l10 5 10-5-10-5z" fill="currentColor"/><path d="M2 17l10 5 10-5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M2 12l10 5 10-5" stroke="currentColor" stroke-width="2" fill="none"/></svg>
                  </template>
                  <template v-else-if="model.type === 'Moonshot'">
                    <svg class="provider-icon moonshot" width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M12 6v6l4 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                  </template>
                  <template v-else-if="model.type === 'OpenAI'">
                    <svg class="provider-icon openai" width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 2a4 4 0 014 4v4a4 4 0 01-4 4 4 4 0 01-4-4V6a4 4 0 014-4z" fill="currentColor" opacity="0.6"/><path d="M12 10a4 4 0 014 4v4a4 4 0 01-4 4 4 4 0 01-4-4v-4a4 4 0 014-4z" fill="currentColor"/></svg>
                  </template>
                  <template v-else-if="model.type === 'Aliyun'">
                    <svg class="provider-icon aliyun" width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M18 10h-3a2 2 0 01-2-2V5a2 2 0 012-2h3a2 2 0 012 2v3a2 2 0 01-2 2z" fill="currentColor" opacity="0.6"/><path d="M9 14H6a2 2 0 01-2-2V9a2 2 0 012-2h3a2 2 0 012 2v3a2 2 0 01-2 2z" fill="currentColor"/><path d="M18 21h-3a2 2 0 01-2-2v-3a2 2 0 012-2h3a2 2 0 012 2v3a2 2 0 01-2 2z" fill="currentColor" opacity="0.4"/></svg>
                  </template>
                  <span v-else class="model-badge" :class="model.type.toLowerCase()">{{ model.type }}</span>
                  <span class="model-name-text">{{ model.name }}</span>
                </div>
              </div>
              <div class="progress-bars">
                <!-- 始终固定 2 条进度条位置 -->
                <template v-for="slot in [0, 1]" :key="slot">
                  <!-- Plan 模式：展示 plans 数组中对应 slot 的计划 -->
                  <div v-if="model.billingMode === 'plan' && model.plans[slot]" class="progress-row">
                    <span class="progress-label">{{ getPlanLabel(model, slot) }}</span>
                    <div class="progress-track-wrap">
                      <div class="progress-track">
                        <div class="progress-fill coding-plan" :style="{ width: Math.min(model.usedTokens / model.plans[slot].limit * 100, 100) + '%' }"></div>
                      </div>
                      <span class="progress-text">{{ Math.round(model.usedTokens / model.plans[slot].limit * 100) }}%</span>
                    </div>
                  </div>
                  <!-- Plan 模式：空占位 slot -->
                  <div v-else-if="model.billingMode === 'plan' && !model.plans[slot]" class="progress-row placeholder">
                    <span class="progress-label">&nbsp;</span>
                    <div class="progress-track-wrap">
                      <div class="progress-track">
                        <div class="progress-fill placeholder-bar"></div>
                      </div>
                      <span class="progress-text">&nbsp;</span>
                    </div>
                  </div>
                  <!-- Billing 模式：slot 0 展示计费进度（货币金额） -->
                  <div v-if="model.billingMode === 'billing' && slot === 0" class="progress-row">
                    <span class="progress-label">Token 消耗计费</span>
                    <div class="progress-track-wrap">
                      <div class="progress-track">
                        <div class="progress-fill billing" :style="{ width: Math.min((model.budget - model.remaining) / model.budget * 100, 100) + '%' }"></div>
                      </div>
                      <span class="progress-text">{{ (model.budget - model.remaining).toFixed(2) }} / {{ model.budget.toFixed(2) }} {{ model.unit }}</span>
                    </div>
                  </div>
                  <!-- Billing 模式：slot 1 空占位 -->
                  <div v-if="model.billingMode === 'billing' && slot === 1" class="progress-row placeholder">
                    <span class="progress-label">&nbsp;</span>
                    <div class="progress-track-wrap">
                      <div class="progress-track">
                        <div class="progress-fill placeholder-bar"></div>
                      </div>
                      <span class="progress-text">&nbsp;</span>
                    </div>
                  </div>
                </template>
              </div>
            </div>
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
  overflow-y: auto; /* 允许纵向滚动，防止小窗口时底部卡片被截断 */
  box-sizing: border-box;
}

/* 上下大容器布局 */
.dashboard-layout {
  display: flex;
  flex-direction: column;
  gap: 1.75rem;
}

.section {
  width: 100%;
}

.section-title {
  font-size: 1rem;
  font-weight: 600;
  color: #1e293b;
  margin-bottom: 0.875rem;
}

/* 1. 最上层大容器：整体大卡片包裹 */
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

/* 模型进度条列表 */
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

.model-badge.deepseek { background: #eff6ff; color: #1d4ed8; }
.model-badge.moonshot { background: #fff1f2; color: #e11d48; }
.model-badge.openai { background: #dcfce7; color: #15803d; }
.model-badge.aliyun { background: #ccfbf1; color: #0f766e; }

/* 供应商图标 */
.provider-icon {
  flex-shrink: 0;
}

.provider-icon.deepseek { color: #1d4ed8; }
.provider-icon.moonshot { color: #e11d48; }
.provider-icon.openai { color: #15803d; }
.provider-icon.aliyun { color: #0f766e; }

/* 进度条容器 */
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

.progress-fill.placeholder-bar {
  background: transparent;
}

.progress-row.placeholder {
  opacity: 0;
  pointer-events: none;
}

.progress-text {
  font-size: 0.75rem;
  color: #64748b;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  white-space: nowrap;
  flex-shrink: 0;
}

/* 2. 中层大容器：折线与圆形图 */

.charts-section {
  container-type: inline-size;
}

.charts-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.25rem;
}

.chart-card-header {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 0.5rem;
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

.chart-container {
  width: 100%;
  height: 100%;
}

/* Token 消耗总量展示卡 */
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

.total-footer {
  padding-top: 1rem;
  border-top: 1px solid #f1f5f9;
}

.total-unit {
  font-size: 0.8125rem;
  color: #94a3b8;
  font-weight: 500;
}

/* TOP3 列表 */
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
}

.top3-value {
  font-size: 0.8125rem;
  font-weight: 600;
  color: #0f172a;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  flex-shrink: 0;
}

/* 小窗口：两图纵向堆叠 */
@container (max-width: 863px) {
  .charts-grid {
    grid-template-columns: 1fr;
  }

  .chart-card {
    height: 300px;
  }
}

/* 3. 下层大容器：告警卡片 */
.alert-card {
  background: white;
  border-radius: 12px;
  padding: 1.25rem;
  box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05), 0 1px 2px -1px rgba(0, 0, 0, 0.05);
}

.card-header {
  margin-bottom: 1rem;
  border-bottom: 1px solid #f1f5f9;
  padding-bottom: 0.75rem;
}

.card-title {
  font-size: 1rem;
  font-weight: 600;
  color: #1e293b;
  display: block;
}

.card-desc {
  font-size: 0.8125rem;
  color: #94a3b8;
  margin-top: 0.25rem;
}

.alert-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.alert-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.875rem 1.25rem;
  border-radius: 8px;
  border: 1px solid transparent;
  flex-wrap: wrap;
  gap: 0.5rem;
  transition: all 0.2s;
}

.alert-item.danger {
  background-color: #fef2f2;
  border-color: #fee2e2;
}
.alert-item.danger .status-indicator { background-color: #ef4444; }
.alert-item.danger .quota-val { color: #ef4444; font-weight: 600; }

.alert-item.warning {
  background-color: #fffbeb;
  border-color: #fef3c7;
}
.alert-item.warning .status-indicator { background-color: #f59e0b; }
.alert-item.warning .quota-val { color: #d97706; font-weight: 600; }

.alert-item.safe {
  background-color: #f0fdf4;
  border-color: #dcfce7;
}
.alert-item.safe .status-indicator { background-color: #22c55e; }
.alert-item.safe .quota-val { color: #15803d; font-weight: 600; }

.provider-info {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  min-width: 140px;
}

.status-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.provider-name {
  font-weight: 500;
  color: #334155;
  font-size: 0.9rem;
}

.quota-detail {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8125rem;
  flex-wrap: wrap;
}

.quota-text { color: #64748b; }

.threshold-tag {
  background: rgba(0, 0, 0, 0.04);
  color: #64748b;
  padding: 0.125rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
}

.badge {
  font-size: 0.75rem;
  padding: 0.25rem 0.75rem;
  border-radius: 9999px;
  font-weight: 500;
}

.badge.danger { background-color: #fee2e2; color: #991b1b; }
.badge.warning { background-color: #fef3c7; color: #92400e; }
.badge.safe { background-color: #dcfce7; color: #166534; }
</style>