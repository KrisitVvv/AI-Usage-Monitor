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
    { id: 1, provider: 'DeepSeek API', name: 'DeepSeek-V3', usedTokens: 8500, remaining: 1.50, threshold: 10.00, unit: '元', type: 'DeepSeek', status: 'danger' },
    { id: 2, provider: 'Kimi API', name: 'Kimi (Moonshot)', usedTokens: 2100, remaining: 8.40, threshold: 20.00, unit: '元', type: 'Moonshot', status: 'warning' },
    { id: 3, provider: 'OpenAI API', name: 'GPT-4o', usedTokens: 4200, remaining: 152.00, threshold: 50.00, unit: '美元', type: 'OpenAI', status: 'safe' },
    { id: 4, provider: 'Aliyun API', name: 'Qwen-Max', usedTokens: 1200, remaining: 88.10, threshold: 10.00, unit: '元', type: 'Aliyun', status: 'safe' }
  ],
  week: [
    { id: 1, provider: 'DeepSeek API', name: 'DeepSeek-V3', usedTokens: 38000, remaining: 1.50, threshold: 10.00, unit: '元', type: 'DeepSeek', status: 'danger' },
    { id: 2, provider: 'Kimi API', name: 'Kimi (Moonshot)', usedTokens: 12000, remaining: 8.40, threshold: 20.00, unit: '元', type: 'Moonshot', status: 'warning' },
    { id: 3, provider: 'OpenAI API', name: 'GPT-4o', usedTokens: 45000, remaining: 152.00, threshold: 50.00, unit: '美元', type: 'OpenAI', status: 'safe' },
    { id: 4, provider: 'Aliyun API', name: 'Qwen-Max', usedTokens: 8000, remaining: 88.10, threshold: 10.00, unit: '元', type: 'Aliyun', status: 'safe' }
  ],
  month: [
    { id: 1, provider: 'DeepSeek API', name: 'DeepSeek-V3', usedTokens: 210000, remaining: 1.50, threshold: 10.00, unit: '元', type: 'DeepSeek', status: 'danger' },
    { id: 2, provider: 'Kimi API', name: 'Kimi (Moonshot)', usedTokens: 65000, remaining: 8.40, threshold: 20.00, unit: '元', type: 'Moonshot', status: 'warning' },
    { id: 3, provider: 'OpenAI API', name: 'GPT-4o', usedTokens: 120000, remaining: 152.00, threshold: 50.00, unit: '美元', type: 'OpenAI', status: 'safe' },
    { id: 4, provider: 'Aliyun API', name: 'Qwen-Max', usedTokens: 140000, remaining: 88.10, threshold: 10.00, unit: '元', type: 'Aliyun', status: 'safe' }
  ],
  year: [
    { id: 1, provider: 'DeepSeek API', name: 'DeepSeek-V3', usedTokens: 2800000, remaining: 1.50, threshold: 10.00, unit: '元', type: 'DeepSeek', status: 'danger' },
    { id: 2, provider: 'Kimi API', name: 'Kimi (Moonshot)', usedTokens: 850000, remaining: 8.40, threshold: 20.00, unit: '元', type: 'Moonshot', status: 'warning' },
    { id: 3, provider: 'OpenAI API', name: 'GPT-4o', usedTokens: 1800000, remaining: 152.00, threshold: 50.00, unit: '美元', type: 'OpenAI', status: 'safe' },
    { id: 4, provider: 'Aliyun API', name: 'Qwen-Max', usedTokens: 920000, remaining: 88.10, threshold: 10.00, unit: '元', type: 'Aliyun', status: 'safe' }
  ]
}

// 3. Token 用量趋势的假数据（由于趋势属于时间序列，保留时间轴结构）
const mockTokenData = {
  today: {
    xData: ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00', '24:00'],
    yData: [1200, 800, 3500, 6200, 4800, 9500, 3100]
  },
  week: {
    xData: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
    yData: [25000, 32000, 28000, 45000, 38000, 15000, 18000]
  },
  month: {
    xData: ['5日', '10日', '15日', '20日', '25日', '30日'],
    yData: [120000, 150000, 180000, 140000, 210000, 190000]
  },
  year: {
    xData: ['一月', '三月', '五月', '七月', '九月', '十一月'],
    yData: [1500000, 1800000, 2200000, 2100000, 2800000, 3100000]
  }
}

// 4. 当前组件实际使用的响应式模型数据对象，监听 timeRange 时会从原始 API 数据中提取
const modelUsageAndQuotas = ref([])

// 5. 图表 DOM 元素的引用 (Vue 模板中 ref 属性对应的变量)
const tokenChartRef = ref(null)
const top3ChartRef = ref(null)

// 6. 存储 ECharts 实例的变量
let tokenChartInstance = null
let top3ChartInstance = null

// 初始化 Token 用量折线图
const initTokenChart = () => {
  if (!tokenChartRef.value) return
  tokenChartInstance = echarts.init(tokenChartRef.value)
  updateTokenChart()
}

// 渲染/更新 Token 用量图表
const updateTokenChart = () => {
  if (!tokenChartInstance) return
  const currentData = mockTokenData[timeRange.value]
  
  const option = {
    title: {
      text: 'Token 消耗趋势',
      left: 'center',
      textStyle: { color: '#334155', fontSize: 16 }
    },
    tooltip: {
      trigger: 'axis',
      formatter: '{b} : {c} Tokens'
    },
    grid: { left: '10%', right: '5%', bottom: '15%', top: '20%' },
    xAxis: {
      type: 'category',
      data: currentData.xData,
      axisLine: { lineStyle: { color: '#cbd5e1' } },
      axisLabel: { color: '#64748b' }
    },
    yAxis: {
      type: 'value',
      axisLine: { lineStyle: { color: '#cbd5e1' } },
      axisLabel: { color: '#64748b' },
      splitLine: { lineStyle: { color: '#f1f5f9' } }
    },
    series: [
      {
        data: currentData.yData,
        type: 'line',
        smooth: true,
        symbolSize: 6,
        itemStyle: { color: '#3b82f6' },
        lineStyle: { width: 3 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(59, 130, 246, 0.3)' },
            { offset: 1, color: 'rgba(59, 130, 246, 0)' }
          ])
        }
      }
    ]
  }
  // 使用 true 参数，阻止合并旧的配置，彻底重绘图表，防止残留旧轴导致崩溃
  tokenChartInstance.setOption(option, true)
}

// 初始化 Top 3 模型饼图
const initTop3Chart = () => {
  if (!top3ChartRef.value) return
  top3ChartInstance = echarts.init(top3ChartRef.value)
  updateTop3Chart()
}

// 渲染/更新全模型用量占比饼图（根据当前数据源动态二次计算）
const updateTop3Chart = () => {
  if (!top3ChartInstance) return
  
  // 核心二次处理：根据当前 modelUsageAndQuotas 提取出 ECharts 所需的 name 与 value (用量 raw)
  const chartPieData = modelUsageAndQuotas.value.map(item => ({
    name: item.name,
    value: item.usedTokensRaw
  }))

  // 二次处理：按用量从大到小（降序）排序，使饼图比例和图例更加清晰有序
  chartPieData.sort((a, b) => b.value - a.value)
  
  const option = {
    title: {
      text: '全模型用量占比',
      left: 'center',
      textStyle: { color: '#334155', fontSize: 16 }
    },
    tooltip: {
      trigger: 'item',
      formatter: '{b} : {c} Tokens ({d}%)'
    },
    legend: {
      orient: 'horizontal',
      bottom: '5%',
      left: 'center',
      icon: 'circle',
      textStyle: {
        color: '#64748b',
        fontSize: 12
      },
      formatter: function (name) {
        return name.length > 15 ? name.slice(0, 12) + '...' : name;
      }
    },
    series: [
      {
        name: '模型用量占比',
        type: 'pie',
        center: ['50%', '45%'],
        radius: ['45%', '68%'],
        avoidLabelOverlap: false,
        itemStyle: {
          borderRadius: 8,
          borderColor: '#fff',
          borderWidth: 2
        },
        label: { show: false },
        emphasis: {
          label: {
            show: true,
            fontSize: 14,
            fontWeight: 'bold'
          }
        },
        data: chartPieData
      }
    ]
  }
  top3ChartInstance.setOption(option, true)
}

// 监听时间范围变化，动态计算和处理当前数据
watch(timeRange, (newRange) => {
  // 从对应时段的原始 API 返回值中读取
  const rawList = mockRawApiData[newRange] || []
  
  // 前端进行数据的二次格式化处理
  modelUsageAndQuotas.value = rawList.map(item => ({
    ...item,
    // 格式化 Token 数值以供千分位展示
    usedTokensFormatted: item.usedTokens.toLocaleString(),
    // 保留原始数值以便进行 ECharts 图表比例计算
    usedTokensRaw: item.usedTokens
  }))

  updateTokenChart()
  updateTop3Chart()
})

// 翻转卡片状态控制
const flippedCards = ref({})
const isAllFlipped = ref(false)

const toggleFlip = (index) => {
  flippedCards.value[index] = !flippedCards.value[index]
}

const flipAllCards = (e) => {
  e.stopPropagation()
  isAllFlipped.value = !isAllFlipped.value
  modelUsageAndQuotas.value.forEach((_, index) => {
    flippedCards.value[index] = isAllFlipped.value
  })
}

// 5. 计算属性：只筛选出状态为 danger 和 warning 的告警模型列表，传给底层告警卡片展示
const activeQuotaAlerts = computed(() => {
  return modelUsageAndQuotas.value.filter(item => item.status === 'danger' || item.status === 'warning')
})

// 处理窗口大小变化时，图表自适应缩放（加入防御性判断，防止实例已被销毁时 resize 报错）
const handleResize = () => {
  if (tokenChartInstance && !tokenChartInstance.isDisposed()) {
    tokenChartInstance.resize()
  }
  if (top3ChartInstance && !top3ChartInstance.isDisposed()) {
    top3ChartInstance.resize()
  }
}

// 生命周期：组件挂载时（此时 DOM 已经生成完毕，可以安全地初始化 ECharts）
onMounted(() => {
  // 1. 初始化时手动触发一次数据清洗
  const rawList = mockRawApiData[timeRange.value] || []
  modelUsageAndQuotas.value = rawList.map(item => ({
    ...item,
    usedTokensFormatted: item.usedTokens.toLocaleString(),
    usedTokensRaw: item.usedTokens
  }))

  // 2. 初始化并绑定图表
  initTokenChart()
  initTop3Chart()
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
  if (top3ChartInstance) {
    top3ChartInstance.dispose()
    top3ChartInstance = null
  }
})
</script>

<template>
  <div class="workbench-page">
    <!-- 核心三层大容器布局 -->
    <div class="dashboard-layout">
      
      <!-- 1. 最上层大容器：各个模型的具体用量和余量数值列表（带翻转/切换效果的独立大容器） -->
      <div class="section top-stats-section">
        <div class="section-card-wrapper">
          <div class="section-card-header">
            <div class="header-title-group">
              <h3 class="container-title">模型用量与余量概览</h3>
              <span class="container-subtitle">点击行可翻转切换“已用 Token”与“账户余额”</span>
            </div>
            <div class="header-action">
              <button 
                class="batch-flip-btn" 
                @click="flipAllCards"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                切换全部视图 ({{ isAllFlipped ? '已用 Token' : '账户余额' }})
              </button>
            </div>
          </div>

          <div class="models-row-list">
            <div 
              v-for="(model, index) in modelUsageAndQuotas" 
              :key="model.name" 
              class="row-perspective"
              @click="toggleFlip(index)"
            >
              <div class="row-flipper" :class="{ flipped: flippedCards[index] }">
                <!-- 行正面：展示已用 Token -->
                <div class="model-row-card front">
                  <div class="model-meta">
                    <span class="model-badge" :class="model.type.toLowerCase()">{{ model.type }}</span>
                    <span class="model-name-text">{{ model.name }}</span>
                  </div>
                  <div class="model-data-group">
                    <span class="data-label">已用 Token：</span>
                    <span class="data-value used">{{ model.usedTokensFormatted }}</span>
                  </div>
                  <div class="row-hover-hint">
                    <span>正向：用量视图</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
                  </div>
                </div>

                <!-- 行背面：展示账户余量 -->
                <div class="model-row-card back">
                  <div class="model-meta">
                    <span class="model-badge" :class="model.type.toLowerCase()">{{ model.type }}</span>
                    <span class="model-name-text">{{ model.name }}</span>
                  </div>
                  <div class="model-data-group">
                    <span class="data-label">账户余量：</span>
                    <span class="data-value quota">{{ model.remaining.toFixed(2) }} <span class="data-unit">{{ model.unit }}</span></span>
                  </div>
                  <div class="row-hover-hint back-hint">
                    <span>反向：余额视图</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 2. 中层大容器：趋势折线图和占比圆形图 (时间范围控制包含在此容器内) -->
      <div class="section charts-section">
        <div class="charts-section-header">
          <div class="section-title">数据趋势分析</div>
          <!-- 时间筛选控制放入中层容器 -->
          <div class="toolbar">
            <span class="toolbar-label">统计范围：</span>
            <div class="btn-group">
              <button 
                v-for="opt in [
                  { key: 'today', label: '今天' },
                  { key: 'week', label: '本周' },
                  { key: 'month', label: '本月' },
                  { key: 'year', label: '今年' }
                ]" 
                :key="opt.key"
                :class="['btn-opt', { active: timeRange === opt.key }]"
                @click="timeRange = opt.key"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>
        </div>
        
        <div class="charts-grid">
          <!-- Token 用量趋势图 -->
          <div class="chart-card">
            <div ref="tokenChartRef" class="chart-container"></div>
          </div>
          <!-- 模型使用 Top 3 占比图 -->
          <div class="chart-card">
            <div ref="top3ChartRef" class="chart-container"></div>
          </div>
        </div>
      </div>

      <!-- 3. 下层大容器：装余量告警 -->
      <div class="section alerts-section">
        <div class="section-title">余量监控</div>
        <div class="alert-card">
          <div class="card-header">
            <span class="card-title">实时配额告警</span>
            <span class="card-desc">自动检测低于设定阈值的 API 账户</span>
          </div>
          <div class="alert-list">
            <div 
              v-for="item in activeQuotaAlerts" 
              :key="item.id"
              :class="['alert-item', item.status]"
            >
              <div class="provider-info">
                <span class="status-indicator"></span>
                <span class="provider-name">{{ item.provider }}</span>
              </div>
              <div class="quota-detail">
                <span class="quota-text">当前剩余：</span>
                <span class="quota-val">{{ item.remaining.toFixed(2) }} {{ item.unit }}</span>
                <span class="threshold-tag">阈值：{{ item.threshold.toFixed(2) }}{{ item.unit }}</span>
              </div>
              <div class="alert-action">
                <span v-if="item.status === 'danger'" class="badge danger">严重不足，请充值</span>
                <span v-else-if="item.status === 'warning'" class="badge warning">余额走低</span>
                <span v-else class="badge safe">额度充足</span>
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
  background-color: #f8fafc;
  height: 100%;
  overflow-y: auto; /* 允许纵向滚动，防止小窗口时底部卡片被截断 */
  box-sizing: border-box;
}

/* 顶部操作栏样式 */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.25rem;
  background: white;
  padding: 0.75rem 1.25rem;
  border-radius: 10px;
  box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
}

.toolbar-left {
  display: flex;
  align-items: center;
}

.toolbar-label {
  font-size: 0.875rem;
  font-weight: 500;
  color: #64748b;
  margin-right: 1rem;
}

.btn-group {
  display: flex;
  gap: 0.375rem;
}

.btn-opt {
  padding: 0.375rem 0.875rem;
  border: 1px solid #e2e8f0;
  background: white;
  border-radius: 6px;
  font-size: 0.875rem;
  color: #475569;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-opt:hover {
  border-color: #3b82f6;
  color: #3b82f6;
}

.btn-opt.active {
  background: #3b82f6;
  border-color: #3b82f6;
  color: white;
  font-weight: 500;
}

/* 页面整体背景及排版限制 */
.workbench-page {
  padding: 1.5rem;
  background-color: #f8fafc;
  height: 100%;
  overflow-y: auto;
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

.batch-flip-btn {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.75rem;
  background: #f8fafc;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  font-size: 0.75rem;
  color: #475569;
  cursor: pointer;
  transition: all 0.2s;
}

.batch-flip-btn:hover {
  background: #eff6ff;
  border-color: #3b82f6;
  color: #3b82f6;
}

/* 一行一行的列表排版 */
.models-row-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.row-perspective {
  perspective: 1000px;
  height: 52px;
  cursor: pointer;
}

.row-flipper {
  position: relative;
  width: 100%;
  height: 100%;
  transition: transform 0.5s cubic-bezier(0.4, 0, 0.2, 1);
  transform-style: preserve-3d;
}

.row-flipper.flipped {
  transform: rotateX(180deg); /* 上下翻转或左右翻折 */
}

.model-row-card {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  backface-visibility: hidden;
  border-radius: 8px;
  padding: 0 1.25rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border: 1px solid #f1f5f9;
  box-sizing: border-box;
  transition: border-color 0.2s, background-color 0.2s;
}

.model-row-card.front {
  background-color: #f8fafc;
  transform: rotateX(0deg);
}

.model-row-card.front:hover {
  background-color: #f1f5f9;
  border-color: #cbd5e1;
}

.model-row-card.back {
  background-color: #f0fdf4;
  border-color: #bbf7d0;
  transform: rotateX(180deg);
}

.model-row-card.back:hover {
  background-color: #dcfce7;
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

.model-data-group {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.875rem;
}

.data-label {
  color: #64748b;
}

.data-value {
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.data-value.used {
  color: #0f172a;
  font-size: 1rem;
}

.data-value.quota {
  color: #16a34a;
  font-size: 1rem;
}

.data-unit {
  font-size: 0.75rem;
  font-weight: 500;
  color: #64748b;
  margin-left: 2px;
}

.row-hover-hint {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.75rem;
  color: #94a3b8;
}

.row-hover-hint.back-hint {
  color: #16a34a;
}

/* 2. 中层大容器：折线与圆形图 */
.charts-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.875rem;
}

.charts-section-header .section-title {
  margin-bottom: 0; /* 抵消标题的外边距 */
}

/* 时间筛选控制样式 */
.toolbar {
  display: flex;
  align-items: center;
  background: white;
  padding: 0.375rem 0.75rem;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
  box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.02);
}

.toolbar-label {
  font-size: 0.75rem;
  font-weight: 500;
  color: #64748b;
  margin-right: 0.5rem;
}

.btn-group {
  display: flex;
  gap: 0.25rem;
}

.btn-opt {
  padding: 0.25rem 0.625rem;
  border: 1px solid transparent;
  background: transparent;
  border-radius: 4px;
  font-size: 0.75rem;
  color: #64748b;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-opt:hover {
  background: #f1f5f9;
  color: #334155;
}

.btn-opt.active {
  background: #3b82f6;
  color: white;
  font-weight: 500;
}

.charts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 1.25rem;
}

.chart-card {
  background: white;
  border-radius: 12px;
  padding: 1.25rem;
  box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05), 0 1px 2px -1px rgba(0, 0, 0, 0.05);
  height: 320px;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.chart-container {
  width: 100%;
  height: 100%;
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