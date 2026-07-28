<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { modelList, MODEL_COLORS } from '../../mock/modelData.js'

const router = useRouter()
const loading = ref(true)
const searchQuery = ref('')

const planModels = computed(() =>
  modelList.filter(m => m.billingModel === 'plan' && matchesSearch(m))
)

const tokenModels = computed(() =>
  modelList.filter(m => m.billingModel === 'token' && matchesSearch(m))
)

function matchesSearch(model) {
  if (!searchQuery.value.trim()) return true
  const q = searchQuery.value.trim().toLowerCase()
  return model.name.toLowerCase().includes(q) ||
    model.provider.toLowerCase().includes(q) ||
    model.type.toLowerCase().includes(q)
}

const goToDetail = (id) => router.push({ name: 'model-detail', params: { id } })

function formatTokens(n) {
  if (!n) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}

function formatMoney(n, currency) {
  return currency + n.toFixed(2)
}

function usageClass(pct) {
  if (pct >= 90) return 'danger'
  if (pct >= 75) return 'warning'
  return 'safe'
}

setTimeout(() => { loading.value = false }, 600)
</script>

<template>
  <div class="vendor-page">
    <div class="toolbar">
      <div class="toolbar-left">
        <h2 class="page-title">额度管理</h2>
        <span class="model-count">{{ modelList.length }} 个供应商</span>
      </div>
      <div class="toolbar-right">
        <div class="search-box">
          <svg class="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input v-model="searchQuery" class="search-input" type="text" placeholder="搜索厂商 / 模型名称..." />
        </div>
      </div>
    </div>

    <div v-if="loading" class="loading-state">
      <div class="spinner"></div>
      <p>正在加载厂商数据...</p>
    </div>

    <template v-else>
      <!-- ====== Plan 订阅模型 ====== -->
      <div class="model-section" v-if="planModels.length">
        <div class="section-header">
          <div class="section-label">
            <span class="section-badge plan">Plan</span>
            <span class="section-title">订阅模式</span>
          </div>
        </div>
        <div class="vendor-grid">
          <div
            v-for="m in planModels" :key="m.id"
            class="vendor-card"
            :class="['usage-' + usageClass(m.allowance.usedPercent)]"
            @click="goToDetail(m.id)"
          >
            <div class="card-row-top">
              <div class="vendor-avatar" :style="{ backgroundColor: MODEL_COLORS[m.name] || '#64748b' }">
                <span class="avatar-letter">{{ m.name.charAt(0) }}</span>
              </div>
              <div class="vendor-info">
                <h3 class="vendor-name">{{ m.name }}</h3>
                <p class="vendor-provider">{{ m.provider }}</p>
              </div>
            </div>

            <!-- 订阅额度条 -->
            <div class="allowance-bar-wrap">
              <div class="allowance-bar-top">
                <span class="allowance-label">{{ m.allowance.planName }}</span>
                <span class="allowance-value">
                  {{ formatTokens(m.allowance.remainingTokens) }} / {{ formatTokens(m.allowance.planTokensTotal) }} tokens
                </span>
              </div>
              <div class="allowance-track">
                <div
                  class="allowance-fill"
                  :style="{ width: m.allowance.usedPercent + '%' }"
                ></div>
              </div>
              <div class="allowance-bar-bottom">
                <span>已用 {{ m.allowance.usedPercent }}%</span>
                <span>下次续费 {{ m.allowance.nextRenewal }}</span>
              </div>
            </div>

            <div class="card-meta">
              <div class="meta-slot">
                <span class="meta-label">订阅费用</span>
                <span class="meta-value mono">{{ m.allowance.planCost }}</span>
              </div>
              <div class="meta-slot">
                <span class="meta-label">请求数</span>
                <span class="meta-value">{{ m.performance.totalRequests.toLocaleString() }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ====== Token 按量计费模型 ====== -->
      <div class="model-section" v-if="tokenModels.length">
        <div class="section-header">
          <div class="section-label">
            <span class="section-badge token">Token</span>
            <span class="section-title">按量计费模式</span>
          </div>
        </div>
        <div class="vendor-grid">
          <div
            v-for="m in tokenModels" :key="m.id"
            class="vendor-card"
            :class="['usage-' + usageClass(m.allowance.usedPercent)]"
            @click="goToDetail(m.id)"
          >
            <div class="card-row-top">
              <div class="vendor-avatar" :style="{ backgroundColor: MODEL_COLORS[m.name] || '#64748b' }">
                <span class="avatar-letter">{{ m.name.charAt(0) }}</span>
              </div>
              <div class="vendor-info">
                <h3 class="vendor-name">{{ m.name }}</h3>
                <p class="vendor-provider">{{ m.provider }}</p>
              </div>
            </div>

            <!-- 余额额度条 -->
            <div class="allowance-bar-wrap">
              <div class="allowance-bar-top">
                <span class="allowance-label">预算</span>
                <span class="allowance-value">
                  剩余 {{ formatMoney(m.allowance.remaining, m.allowance.currency) }} / {{ formatMoney(m.allowance.totalBudget, m.allowance.currency) }}
                </span>
              </div>
              <div class="allowance-track">
                <div
                  class="allowance-fill"
                  :style="{ width: m.allowance.usedPercent + '%' }"
                ></div>
              </div>
              <div class="allowance-bar-bottom">
                <span>已用 {{ m.allowance.usedPercent }}%</span>
                <span>{{ m.allowance.billingCycle }}</span>
              </div>
            </div>

            <div class="card-meta">
              <div class="meta-slot">
                <span class="meta-label">已消费</span>
                <span class="meta-value mono">{{ formatMoney(m.allowance.spent, m.allowance.currency) }}</span>
              </div>
              <div class="meta-slot">
                <span class="meta-label">请求数</span>
                <span class="meta-value">{{ m.performance.totalRequests.toLocaleString() }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="!planModels.length && !tokenModels.length" class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.5">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <p>没有找到匹配的厂商</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.vendor-page { height: 100%; min-width: 0; box-sizing: border-box; display: flex; flex-direction: column; gap: 1rem; overflow-x: hidden; overflow-y: auto; padding: 0 1.25rem 1rem; }

.toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.75rem; flex-shrink: 0; margin-top: 1.5rem; }
.toolbar-left { display: flex; align-items: center; gap: 0.75rem; margin-left: 0.5rem; }
.page-title { font-size: 1.25rem; font-weight: 700; color: #1e293b; margin: 0; }
.model-count { font-size: 0.75rem; color: #94a3b8; background: #f1f5f9; padding: 0.2rem 0.6rem; border-radius: 999px; }
.search-box { position: relative; display: flex; align-items: center; }
.search-icon { position: absolute; left: 0.75rem; color: #94a3b8; pointer-events: none; }
.search-input { padding: 0.45rem 0.75rem 0.45rem 2.2rem; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 0.8125rem; color: #1e293b; background: white; outline: none; width: 220px; transition: border-color 0.2s, box-shadow 0.2s; }
.search-input:focus { border-color: #4675ED; box-shadow: 0 0 0 3px rgba(70,117,237,.1); }
.search-input::placeholder { color: #94a3b8; }

/* Section header */
.model-section { display: flex; flex-direction: column; gap: 0.75rem; width: 100%; }
.section-header { display: flex; align-items: center; }
.section-label { display: flex; align-items: center; gap: 0.6rem; }
.section-badge { font-size: 0.6875rem; font-weight: 700; text-transform: uppercase; padding: 0.25rem 0.6rem; border-radius: 6px; letter-spacing: 0.5px; }
.section-badge.plan { background: #eef2ff; color: #4675ED; }
.section-badge.token { background: #fef3c7; color: #d97706; }
.section-title { font-size: 0.875rem; font-weight: 600; color: #1e293b; }
.section-desc { font-size: 0.75rem; color: #94a3b8; }

/* Vendor grid */
.vendor-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1rem; min-width: 0; }

/* Vendor card */
.vendor-card { background: white; border-radius: 12px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,.05), 0 1px 2px -1px rgba(0,0,0,.05); cursor: pointer; transition: all 0.25s; border: 1px solid #f1f5f9; display: flex; flex-direction: column; gap: 0.75rem; position: relative; min-width: 0; overflow: hidden; }
.vendor-card:hover { transform: translateY(-2px); box-shadow: 0 10px 25px rgba(0,0,0,.08); border-color: #4675ED; }
.vendor-card.usage-danger { border-left: 3px solid #ef4444; }
.vendor-card.usage-warning { border-left: 3px solid #f59e0b; }
.vendor-card.usage-safe { border-left: 3px solid #22c55e; }

.card-row-top { display: flex; align-items: center; gap: 0.75rem; }
.vendor-avatar { width: 40px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.avatar-letter { color: white; font-weight: 700; font-size: 1.05rem; }
.vendor-info { flex: 1; min-width: 0; }
.vendor-name { font-size: 0.95rem; font-weight: 600; color: #1e293b; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vendor-provider { font-size: 0.72rem; color: #94a3b8; margin: 0.125rem 0 0; }

/* Allowance bar */
.allowance-bar-wrap { display: flex; flex-direction: column; gap: 0.35rem; }
.allowance-bar-top { display: flex; justify-content: space-between; align-items: center; min-width: 0; gap: 0.5rem; }
.allowance-label { font-size: 0.72rem; color: #64748b; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.allowance-value { font-size: 0.72rem; color: #1e293b; font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; white-space: nowrap; }
.allowance-track { width: 100%; height: 8px; background: #f1f5f9; border-radius: 999px; overflow: hidden; }
.allowance-fill { height: 100%; border-radius: 999px; transition: width 0.6s ease; }
.usage-safe .allowance-fill { background: linear-gradient(90deg, #22c55e, #4ade80); }
.usage-warning .allowance-fill { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
.usage-danger .allowance-fill { background: linear-gradient(90deg, #ef4444, #f87171); }
.allowance-bar-bottom { display: flex; justify-content: space-between; font-size: 0.68rem; color: #94a3b8; }

/* Card meta */
.card-meta { display: flex; gap: 1.5rem; }
.meta-slot { display: flex; flex-direction: column; gap: 0.1rem; }
.meta-label { font-size: 0.65rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; }
.meta-value { font-size: 0.8125rem; color: #475569; font-weight: 500; }
.meta-value.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }

/* Loading / Empty */
.loading-state, .empty-state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.75rem; color: #94a3b8; }
.spinner { width: 36px; height: 36px; border: 3px solid #e2e8f0; border-top-color: #4675ED; border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 768px) {
  .toolbar { flex-direction: column; align-items: stretch; }
  .search-input { width: 100%; }
  .vendor-grid { grid-template-columns: 1fr; }
}
</style>