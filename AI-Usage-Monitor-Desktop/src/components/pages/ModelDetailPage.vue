<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { modelList, MODEL_COLORS } from '../../mock/modelData.js'

const route = useRoute()
const router = useRouter()
const loading = ref(true)
const model = ref(null)
const activeTab = ref('allowance')

onMounted(() => {
  const found = modelList.find(m => m.id === route.params.id)
  setTimeout(() => {
    model.value = found || null
    loading.value = false
  }, 400)
})

const goBack = () => router.push({ name: 'progress' })

const modelColor = computed(() => model.value ? (MODEL_COLORS[model.value.name] || '#64748b') : '#64748b')
const isPlan = computed(() => model.value?.billingModel === 'plan')
const isToken = computed(() => model.value?.billingModel === 'token')

function formatTokens(n) {
  if (!n) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}

function usageClass(pct) {
  if (pct >= 90) return 'danger'
  if (pct >= 75) return 'warning'
  return 'safe'
}
</script>

<template>
  <div class="detail-page">
    <div v-if="loading" class="detail-loading">
      <div class="spinner"></div>
      <p>加载厂商详情...</p>
    </div>

    <div v-else-if="!model" class="detail-error">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="1.5">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <h3>厂商未找到</h3>
      <p>该厂商不存在或已被移除</p>
      <button class="back-btn" @click="goBack">返回列表</button>
    </div>

    <template v-else>
      <div class="detail-topbar">
        <button class="back-btn" @click="goBack">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
          返回列表
        </button>
      </div>

      <!-- 厂商头部 -->
      <div class="vendor-header">
        <div class="vendor-avatar" :style="{ backgroundColor: modelColor }">
          <span class="avatar-letter">{{ model.name.charAt(0) }}</span>
        </div>
        <div class="vendor-header-info">
          <div class="vendor-title-row">
            <h1 class="vendor-title">{{ model.name }}</h1>
            <span :class="['billing-chip', model.billingModel]">
              {{ model.billingModel === 'plan' ? 'Plan 订阅' : 'Token 计费' }}
            </span>
          </div>
          <div class="vendor-tags">
            <span class="tag">{{ model.provider }}</span>
            <span class="tag">{{ model.type }}</span>
            <span :class="['status-badge', model.status]">
              <span class="status-dot"></span>{{ model.status === 'running' ? '运行中' : '已停止' }}
            </span>
          </div>
        </div>
      </div>

      <p class="vendor-desc">{{ model.description }}</p>

      <!-- ====== 额度大卡片 ====== -->
      <div class="allowance-hero" :class="usageClass(model.allowance.usedPercent)">
        <div class="hero-top">
          <svg class="hero-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
          </svg>
          <span class="hero-label">
            {{ isPlan ? model.allowance.planName : '月度预算使用情况' }}
          </span>
        </div>

        <!-- Plan 模式 -->
        <template v-if="isPlan">
          <div class="hero-numbers">
            <div class="hero-number-block">
              <span class="hero-number">{{ formatTokens(model.allowance.remainingTokens) }}</span>
              <span class="hero-number-unit">剩余 Tokens</span>
            </div>
            <div class="hero-divider"></div>
            <div class="hero-number-block">
              <span class="hero-number">{{ formatTokens(model.allowance.planTokensTotal) }}</span>
              <span class="hero-number-unit">总配额</span>
            </div>
          </div>
          <div class="hero-bar-wrap">
            <div class="hero-track">
              <div class="hero-fill" :style="{ width: model.allowance.usedPercent + '%' }"></div>
            </div>
            <div class="hero-bar-labels">
              <span>已用 {{ model.allowance.usedPercent }}%</span>
              <span>下次续费：{{ model.allowance.nextRenewal }}</span>
            </div>
          </div>
          <div class="hero-footer">
            <div class="hero-foot-item">
              <span class="hf-label">订阅费用</span>
              <span class="hf-value">{{ model.allowance.planCost }}</span>
            </div>
            <div class="hero-foot-item">
              <span class="hf-label">已使用 Token</span>
              <span class="hf-value">{{ formatTokens(model.allowance.planTokensUsed) }}</span>
            </div>
          </div>
        </template>

        <!-- Token 模式 -->
        <template v-if="isToken">
          <div class="hero-numbers">
            <div class="hero-number-block">
              <span class="hero-number">{{ model.allowance.currency }}{{ model.allowance.remaining.toFixed(2) }}</span>
              <span class="hero-number-unit">剩余预算</span>
            </div>
            <div class="hero-divider"></div>
            <div class="hero-number-block">
              <span class="hero-number">{{ model.allowance.currency }}{{ model.allowance.totalBudget.toFixed(0) }}</span>
              <span class="hero-number-unit">总预算</span>
            </div>
          </div>
          <div class="hero-bar-wrap">
            <div class="hero-track">
              <div class="hero-fill" :style="{ width: model.allowance.usedPercent + '%' }"></div>
            </div>
            <div class="hero-bar-labels">
              <span>已用 {{ model.allowance.usedPercent }}%</span>
              <span>{{ model.allowance.billingCycle }}</span>
            </div>
          </div>
          <div class="hero-footer">
            <div class="hero-foot-item">
              <span class="hf-label">已消费</span>
              <span class="hf-value">{{ model.allowance.currency }}{{ model.allowance.spent.toFixed(2) }}</span>
            </div>
            <div class="hero-foot-item">
              <span class="hf-label">下次出账日</span>
              <span class="hf-value">{{ model.allowance.nextBillingDate }}</span>
            </div>
          </div>
        </template>
      </div>

      <!-- Tab 栏 -->
      <div class="tab-bar">
        <button :class="['tab-btn', { active: activeTab === 'allowance' }]" @click="activeTab = 'allowance'">额度详情</button>
        <button :class="['tab-btn', { active: activeTab === 'history' }]" @click="activeTab = 'history'">使用历史</button>
        <button :class="['tab-btn', { active: activeTab === 'performance' }]" @click="activeTab = 'performance'">性能指标</button>
        <button :class="['tab-btn', { active: activeTab === 'config' }]" @click="activeTab = 'config'">模型配置</button>
        <button :class="['tab-btn', { active: activeTab === 'notes' }]" @click="activeTab = 'notes'">使用说明</button>
      </div>

      <div class="tab-content">
        <!-- 额度详情 -->
        <div v-if="activeTab === 'allowance'" class="allowance-detail-panel">
          <template v-if="isPlan">
            <div class="detail-grid">
              <div class="detail-item"><span class="detail-label">订阅方案</span><span class="detail-value">{{ model.allowance.planName }}</span></div>
              <div class="detail-item"><span class="detail-label">Token 配额</span><span class="detail-value mono">{{ formatTokens(model.allowance.planTokensTotal) }}</span></div>
              <div class="detail-item"><span class="detail-label">已使用</span><span class="detail-value mono">{{ formatTokens(model.allowance.planTokensUsed) }}</span></div>
              <div class="detail-item"><span class="detail-label">剩余可用</span><span class="detail-value mono highlight">{{ formatTokens(model.allowance.remainingTokens) }}</span></div>
              <div class="detail-item"><span class="detail-label">使用率</span><span class="detail-value" :class="usageClass(model.allowance.usedPercent)">{{ model.allowance.usedPercent }}%</span></div>
              <div class="detail-item"><span class="detail-label">订阅费用</span><span class="detail-value">{{ model.allowance.planCost }}</span></div>
              <div class="detail-item"><span class="detail-label">下次续费</span><span class="detail-value">{{ model.allowance.nextRenewal }}</span></div>
              <div class="detail-item detail-item-full"><span class="detail-label">计费方式</span><span class="detail-value">{{ model.config.pricing }}</span></div>
            </div>
          </template>
          <template v-if="isToken">
            <div class="detail-grid">
              <div class="detail-item"><span class="detail-label">预算总额</span><span class="detail-value mono">{{ model.allowance.currency }}{{ model.allowance.totalBudget.toFixed(2) }}</span></div>
              <div class="detail-item"><span class="detail-label">已消费</span><span class="detail-value mono">{{ model.allowance.currency }}{{ model.allowance.spent.toFixed(2) }}</span></div>
              <div class="detail-item"><span class="detail-label">剩余预算</span><span class="detail-value mono highlight">{{ model.allowance.currency }}{{ model.allowance.remaining.toFixed(2) }}</span></div>
              <div class="detail-item"><span class="detail-label">使用率</span><span class="detail-value" :class="usageClass(model.allowance.usedPercent)">{{ model.allowance.usedPercent }}%</span></div>
              <div class="detail-item"><span class="detail-label">结算周期</span><span class="detail-value">{{ model.allowance.billingCycle }}</span></div>
              <div class="detail-item"><span class="detail-label">下次出账日</span><span class="detail-value">{{ model.allowance.nextBillingDate }}</span></div>
              <div class="detail-item detail-item-full"><span class="detail-label">计费单价</span><span class="detail-value">{{ model.config.pricing }}</span></div>
            </div>
          </template>
        </div>

        <!-- 使用历史 -->
        <div v-if="activeTab === 'history'" class="history-panel">
          <div class="history-table-wrapper">
            <table class="history-table">
              <thead>
                <tr>
                  <th>日期</th>
                  <th>请求数</th>
                  <th>Token 用量</th>
                  <th>当日费用</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in model.usageHistory" :key="r.date">
                  <td class="date-cell">{{ r.date }}</td>
                  <td>{{ r.requests.toLocaleString() }}</td>
                  <td>{{ r.tokens ? formatTokens(r.tokens) : '—' }}</td>
                  <td class="cost-cell">{{ r.cost > 0 ? (isToken ? model.allowance.currency : isPlan ? (model.config.pricing.startsWith('$') ? '$' : '¥') : '¥') + r.cost.toFixed(2) : '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 性能指标 -->
        <div v-if="activeTab === 'performance'" class="perf-panel">
          <div class="perf-grid">
            <div class="perf-card"><span class="perf-label">平均延迟</span><span class="perf-value">{{ model.performance.avgLatency }}</span></div>
            <div class="perf-card"><span class="perf-label">P95 延迟</span><span class="perf-value">{{ model.performance.p95Latency }}</span></div>
            <div class="perf-card"><span class="perf-label">成功率</span><span class="perf-value success">{{ model.performance.successRate }}</span></div>
            <div class="perf-card"><span class="perf-label">平均 Tokens/请求</span><span class="perf-value">{{ model.performance.avgTokensPerRequest.toLocaleString() }}</span></div>
            <div class="perf-card"><span class="perf-label">总请求数</span><span class="perf-value">{{ model.performance.totalRequests.toLocaleString() }}</span></div>
            <div class="perf-card"><span class="perf-label">总 Token 用量</span><span class="perf-value">{{ model.performance.totalTokens }}</span></div>
          </div>
        </div>

        <!-- 模型配置 -->
        <div v-if="activeTab === 'config'" class="config-grid">
          <div class="config-item"><span class="config-label">Model ID</span><span class="config-value mono">{{ model.config.modelId }}</span></div>
          <div class="config-item"><span class="config-label">Max Tokens</span><span class="config-value">{{ model.config.maxTokens.toLocaleString() }}</span></div>
          <div class="config-item"><span class="config-label">上下文长度</span><span class="config-value">{{ model.config.contextLength }}</span></div>
          <div class="config-item config-item-full"><span class="config-label">定价</span><span class="config-value">{{ model.config.pricing }}</span></div>
        </div>

        <!-- 使用说明 -->
        <div v-if="activeTab === 'notes'" class="notes-panel">
          <div class="notes-header">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4675ED" stroke-width="2">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
            <span>{{ model.name }} 使用说明</span>
          </div>
          <ul class="notes-list">
            <li v-for="(note, i) in model.notes" :key="i" class="note-item">
              <span class="note-bullet"></span><span>{{ note }}</span>
            </li>
          </ul>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.detail-page { height: 100%; min-width: 0; box-sizing: border-box; display: flex; flex-direction: column; gap: 1rem; overflow-x: hidden; overflow-y: auto; padding: 0 1.25rem 1rem;margin-top: 1rem; }

.detail-loading, .detail-error { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.75rem; color: #94a3b8; }
.spinner { width: 36px; height: 36px; border: 3px solid #e2e8f0; border-top-color: #4675ED; border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.detail-error h3 { color: #1e293b; margin: 0; }

.detail-topbar { display: flex; align-items: center; }
.back-btn { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.4rem 0.85rem; border: 1px solid #e2e8f0; background: white; border-radius: 8px; font-size: 0.8125rem; color: #475569; cursor: pointer; transition: all 0.2s; }
.back-btn:hover { background: #f8fafc; border-color: #cbd5e1; }

/* Header */
.vendor-header { display: flex; align-items: center; gap: 1rem; min-width: 0; }
.vendor-avatar { width: 52px; height: 52px; border-radius: 14px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.avatar-letter { color: white; font-weight: 700; font-size: 1.4rem; }
.vendor-header-info { flex: 1; min-width: 0; }
.vendor-title-row { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.35rem; min-width: 0; }
.vendor-title { font-size: 1.35rem; font-weight: 700; color: #1e293b; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.billing-chip { font-size: 0.68rem; font-weight: 600; padding: 0.2rem 0.6rem; border-radius: 6px; letter-spacing: 0.3px; flex-shrink: 0; }
.billing-chip.plan { background: #eef2ff; color: #4675ED; }
.billing-chip.token { background: #fef3c7; color: #d97706; }
.vendor-tags { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.tag { font-size: 0.72rem; color: #4675ED; background: #eef2ff; padding: 0.15rem 0.55rem; border-radius: 6px; font-weight: 500; }
.status-badge { display: flex; align-items: center; gap: 0.3rem; font-size: 0.7rem; font-weight: 500; padding: 0.2rem 0.55rem; border-radius: 999px; }
.status-badge.running { background: #f0fdf4; color: #16a34a; }
.status-badge.stopped { background: #fef2f2; color: #dc2626; }
.status-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.vendor-desc { font-size: 0.85rem; color: #64748b; line-height: 1.6; margin: 0; }

/* ====== Allowance hero ====== */
.allowance-hero { background: white; border-radius: 14px; padding: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,.05); display: flex; flex-direction: column; gap: 1rem; }
.allowance-hero.danger { border: 1px solid #fecaca; }
.allowance-hero.warning { border: 1px solid #fde68a; }
.allowance-hero.safe { border: 1px solid #bbf7d0; }
.hero-top { display: flex; align-items: center; gap: 0.5rem; }
.hero-icon { color: #1e293b; }
.hero-label { font-size: 0.9rem; font-weight: 600; color: #1e293b; }
.hero-numbers { display: flex; align-items: center; justify-content: center; gap: 2rem; flex-wrap: wrap; }
.hero-number-block { display: flex; flex-direction: column; align-items: center; gap: 0.15rem; min-width: 0; }
.hero-number { font-size: clamp(1.5rem, 5vw, 2.25rem); font-weight: 800; color: #1e293b; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; white-space: nowrap; }
.danger .hero-number { color: #dc2626; }
.warning .hero-number { color: #d97706; }
.safe .hero-number { color: #16a34a; }
.hero-number-unit { font-size: 0.72rem; color: #94a3b8; font-weight: 500; }
.hero-divider { width: 1px; height: 48px; background: #e2e8f0; }
.hero-bar-wrap { display: flex; flex-direction: column; gap: 0.35rem; }
.hero-track { width: 100%; height: 10px; background: #f1f5f9; border-radius: 999px; overflow: hidden; }
.hero-fill { height: 100%; border-radius: 999px; transition: width 0.6s; }
.safe .hero-fill { background: linear-gradient(90deg, #22c55e, #4ade80); }
.warning .hero-fill { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
.danger .hero-fill { background: linear-gradient(90deg, #ef4444, #f87171); }
.hero-bar-labels { display: flex; justify-content: space-between; font-size: 0.72rem; color: #94a3b8; }
.hero-footer { display: flex; gap: 2rem; padding-top: 0.5rem; border-top: 1px solid #f1f5f9; }
.hero-foot-item { display: flex; flex-direction: column; gap: 0.1rem; }
.hf-label { font-size: 0.68rem; color: #94a3b8; }
.hf-value { font-size: 0.85rem; font-weight: 600; color: #1e293b; }

/* Tabs */
.tab-bar { display: flex; border-bottom: 1px solid #e2e8f0; flex-shrink: 0; overflow-x: auto; -ms-overflow-style: none; scrollbar-width: none; }
.tab-bar::-webkit-scrollbar { display: none; }
.tab-btn { padding: 0.55rem 1rem; border: none; background: transparent; font-size: 0.8125rem; font-weight: 500; color: #64748b; cursor: pointer; position: relative; transition: color 0.2s; white-space: nowrap; flex-shrink: 0; }
.tab-btn:hover { color: #1e293b; }
.tab-btn.active { color: #4675ED; }
.tab-btn.active::after { content: ''; position: absolute; bottom: -1px; left: 0; right: 0; height: 2px; background: #4675ED; border-radius: 2px 2px 0 0; }
.tab-content { flex: 1; min-width: 0; }

/* Allowance detail panel */
.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
.detail-item { background: #f8fafc; border-radius: 10px; padding: 1rem; display: flex; flex-direction: column; gap: 0.35rem; }
.detail-item-full { grid-column: 1 / -1; }
.detail-label { font-size: 0.72rem; color: #94a3b8; font-weight: 500; }
.detail-value { font-size: 0.875rem; color: #1e293b; font-weight: 600; }
.detail-value.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 0.8125rem; }
.detail-value.highlight { color: #4675ED; font-size: 1.05rem; }
.detail-value.danger { color: #dc2626; }
.detail-value.warning { color: #d97706; }
.detail-value.safe { color: #16a34a; }

/* Config */
.config-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; min-width: 0; }
.config-item { background: #f8fafc; border-radius: 10px; padding: 1rem; display: flex; flex-direction: column; gap: 0.35rem; }
.config-item-full { grid-column: 1 / -1; }
.config-label { font-size: 0.72rem; color: #94a3b8; font-weight: 500; }
.config-value { font-size: 0.875rem; color: #1e293b; font-weight: 600; }
.config-value.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 0.8125rem; }

/* History */
.history-table-wrapper { overflow-x: auto; }
.history-table { width: 100%; border-collapse: collapse; }
.history-table th { text-align: left; font-size: 0.72rem; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; padding: 0.65rem 1rem; border-bottom: 2px solid #e2e8f0; }
.history-table td { padding: 0.55rem 1rem; font-size: 0.8125rem; color: #475569; border-bottom: 1px solid #f1f5f9; }
.history-table tbody tr:hover { background: #f8fafc; }
.date-cell { font-weight: 600; color: #1e293b; }
.cost-cell { font-weight: 600; color: #059669; }

/* Performance */
.perf-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 1rem; }
.perf-card { background: #f8fafc; border-radius: 10px; padding: 1.1rem; display: flex; flex-direction: column; gap: 0.4rem; }
.perf-label { font-size: 0.72rem; color: #94a3b8; font-weight: 500; }
.perf-value { font-size: 1.1rem; font-weight: 700; color: #1e293b; }
.perf-value.success { color: #16a34a; }

/* Notes */
.notes-panel { background: #f8fafc; border-radius: 12px; padding: 1.25rem; }
.notes-header { display: flex; align-items: center; gap: 0.5rem; font-size: 0.95rem; font-weight: 600; color: #1e293b; margin-bottom: 0.85rem; }
.notes-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.65rem; }
.note-item { display: flex; align-items: flex-start; gap: 0.55rem; font-size: 0.8125rem; color: #475569; line-height: 1.5; }
.note-bullet { width: 6px; height: 6px; border-radius: 50%; background: #4675ED; flex-shrink: 0; margin-top: 0.45rem; }

@media (max-width: 768px) {
  .hero-numbers { gap: 1.5rem; }
  .hero-number { font-size: 1.75rem; }
  .detail-grid { grid-template-columns: 1fr; }
  .config-grid { grid-template-columns: 1fr; }
  .perf-grid { grid-template-columns: 1fr 1fr; }
}
</style>