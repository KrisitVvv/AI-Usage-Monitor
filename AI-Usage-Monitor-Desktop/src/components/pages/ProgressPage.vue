<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import AddVendorModal from '../AddVendorModal.vue'

const router = useRouter()
const loading = ref(true)
const showAddModal = ref(false)
const realtimeUsage = ref({ vendors: [], errors: [], lastCollect: null, deepseekBalance: null })
let unsubscribe = null
let loginStatusUnsubscribe = null
let loginStatusPollTimer = null
// DeepSeek/Kimi Monitor 登录状态（vendorId → boolean）
const monitorLoginStatus = ref({})

// ---------- 工具函数 ----------
const PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#ec4899', '#06b6d4', '#f97316', '#84cc16', '#6366f1']

function vendorColor(name) {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash) + name.charCodeAt(i)
  return PALETTE[Math.abs(hash) % PALETTE.length]
}

function shortName(provider) {
  const map = {
    'DeepSeek API': 'DeepSeek', 'OpenAI API': 'OpenAI', 'Kimi CN': 'KIMI',
    'Aliyun API': '阿里云', '智谱 AI': 'GLM', 'Anthropic': 'Claude',
    'Google AI': 'Gemini', 'Stability AI': 'SDXL', '百度文心': '文心', '科大讯飞': '讯飞',
    'XIAOMI MIMO': 'XIAOMI MIMO', 'Trae CN': 'Trae CN'
  }
  return map[provider] || provider
}

// ---------- 从实时数据构建卡片列表 ----------
const mergedModelList = computed(() => {
  const balances = {
    ...(realtimeUsage.value.deepseekBalances || {}),
    ...(realtimeUsage.value.kimiBalances || {}),
    ...(realtimeUsage.value.mimoBalances || {}),
    ...(realtimeUsage.value.traeBalances || {})
  }
  const fallbackBalance = realtimeUsage.value.deepseekBalance
  const savedVendors = realtimeUsage.value.vendors || []
  if (!savedVendors.length) return []

  return savedVendors.map(v => {
    const isDeepSeek = v.provider === 'DeepSeek API'
    const isKimi = v.provider === 'Kimi CN'
    const isMimo = v.provider === 'XIAOMI MIMO'
    const isTrae = v.provider === 'Trae CN'
    // 按 vendor ID 查找 balance，DeepSeek/MIMO 额外支持全局 fallback
    const balanceData = balances[v.id] || (isDeepSeek ? fallbackBalance : null) || (isMimo ? realtimeUsage.value.mimoBalance : null)
    const hasBalance = !!balanceData
    // DeepSeek/Kimi/MIMO/Trae 供应商：Monitor 报告已登录时视为实时（即使 balance 尚未刷新）
    const monitorLoggedIn = !!(isDeepSeek || isKimi || isMimo || isTrae) && !!monitorLoginStatus.value[v.id]
    const base = {
      id: v.id,
      name: v.customName || shortName(v.provider),
      provider: v.provider,
      billingModel: v.billingModel,
      color: vendorColor(v.provider),
      _live: monitorLoggedIn || (hasBalance && !balanceData._stale),
      _stale: !monitorLoggedIn && hasBalance && !!balanceData._stale,
      _deepseekAvailable: hasBalance ? balanceData.is_available : false,
      _monitorLoggedIn: monitorLoggedIn
    }

    if (hasBalance) {
      const totalBudget = balanceData.totalBudget || 0
      const remaining = balanceData.remaining || 0
      const spent = balanceData.spent || 0
      const usedPercent = balanceData.usedPercent ?? (totalBudget > 0 ? Math.round((spent / totalBudget) * 100) : 0)

      if (v.billingModel === 'plan') {
        if (isTrae) {
          // Trae CN 积分：外部卡片仅展示累计消耗积分与总剩余积分
          base.allowance = {
            planName: '总剩余积分',
            remainingTokens: remaining,   // 总剩余积分
            planTokensTotal: totalBudget, // 总积分（剩余 + 已消耗）
            planTokensUsed: spent,        // 累计消耗积分
            planCost: '',
            usedPercent,
            nextRenewal: '—',
            currency: 'CREDIT'
          }
        } else {
          base.allowance = {
            planName: `${base.name} 余额`,
            remainingTokens: remaining,
            planTokensTotal: totalBudget,
            planTokensUsed: spent,
            planCost: `¥${totalBudget.toFixed(2)}`,
            usedPercent,
            nextRenewal: '—'
          }
        }
      } else {
        base.allowance = {
          totalBudget, spent, remaining,
          currency: balanceData.currency === 'CNY' ? '¥' : '$',
          usedPercent,
          billingCycle: balanceData.is_available ? '可用' : '不可用'
        }
      }
    } else {
      // 无实时数据 — 显示占位
      if (v.billingModel === 'plan') {
        base.allowance = {
          planName: '等待数据...',
          remainingTokens: 0, planTokensTotal: 0, planTokensUsed: 0,
          planCost: '—', usedPercent: 0, nextRenewal: '—'
        }
      } else {
        base.allowance = {
          totalBudget: 0, spent: 0, remaining: 0,
          currency: '¥', usedPercent: 0, billingCycle: '等待数据...'
        }
      }
    }
    return base
  })
})

const planModels = computed(() => mergedModelList.value.filter(m => m.billingModel === 'plan'))
const tokenModels = computed(() => mergedModelList.value.filter(m => m.billingModel === 'token'))

const lastUpdate = computed(() => {
  const t = realtimeUsage.value.lastCollect
  return t ? new Date(t).toLocaleTimeString('zh-CN') : ''
})
const fetchErrors = computed(() => realtimeUsage.value.errors || [])

function onVendorSaved() { showAddModal.value = false }

// ---------- 处理来自 ModelDetailPage 的重命名通知 ----------
function applyPendingRenames() {
  try {
    const pending = JSON.parse(localStorage.getItem('pendingVendorRenames') || '[]')
    if (!pending.length) return
    const vendors = realtimeUsage.value.vendors || []
    let changed = false
    for (const { vendorId, customName } of pending) {
      const v = vendors.find(vendor => vendor.id === vendorId)
      if (v && v.customName !== customName) {
        v.customName = customName
        changed = true
      }
    }
    if (changed) {
      realtimeUsage.value = { ...realtimeUsage.value, vendors: [...vendors] }
    }
    localStorage.removeItem('pendingVendorRenames')
  } catch { /* 忽略 */ }
}

const goToDetail = (id) => router.push({ name: 'model-detail', params: { id } })

function formatTokens(n) {
  if (!n) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}
// Trae 积分：显示真实数字（千分位），不使用 K/M 缩写
function formatCredits(n) {
  return Number(n || 0).toLocaleString()
}
function formatMoney(n, currency) {
  if (currency) return currency + Number(n || 0).toFixed(2)
  return '$' + Number(n || 0).toFixed(2)
}
function usageClass(pct) {
  if (pct >= 90) return 'danger'
  if (pct >= 75) return 'warning'
  return 'safe'
}

// ---------- 登录状态管理 ----------
function isMonitorVendor(provider) {
  return provider === 'DeepSeek API' || provider === 'Kimi CN' || provider === 'XIAOMI MIMO' || provider === 'Trae CN'
}

async function pollLoginStatus() {
  if (!window.electronAPI?.getMonitorLoginStatus) return
  const vendors = realtimeUsage.value.vendors || []
  const needsCheck = vendors.filter(v => isMonitorVendor(v.provider))
  if (!needsCheck.length) return

  const newStatus = { ...monitorLoginStatus.value }
  for (const v of needsCheck) {
    try {
      const loggedIn = await window.electronAPI.getMonitorLoginStatus(v.id)
      newStatus[v.id] = !!loggedIn
    } catch { /* 忽略 */ }
  }
  monitorLoginStatus.value = newStatus
}

// ---------- 生命周期 ----------
onMounted(async () => {
  if (window.electronAPI) {
    try {
      const cached = await window.electronAPI.getUsageData()
      if (cached) realtimeUsage.value = cached
    } catch { /* 忽略 */ }
    // 处理来自详情页的重命名通知（在获取数据后、订阅前）
    applyPendingRenames()

    // 首次查询所有 DeepSeek/Kimi 供应商的登录状态
    await pollLoginStatus()

    // 订阅登录状态变更事件（实时更新）
    if (window.electronAPI.onMonitorLoginStatusChanged) {
      loginStatusUnsubscribe = window.electronAPI.onMonitorLoginStatusChanged(({ vendorId, loggedIn }) => {
        monitorLoginStatus.value = { ...monitorLoginStatus.value, [vendorId]: loggedIn }
      })
    }

    // 定期轮询登录状态（作为事件推送的补充）
    loginStatusPollTimer = setInterval(pollLoginStatus, 15000)

    unsubscribe = window.electronAPI.onUsageDataUpdated((data) => {
      realtimeUsage.value = data
    })
  }
  setTimeout(() => { loading.value = false }, 600)
})
onUnmounted(() => {
  if (typeof loginStatusUnsubscribe === 'function') loginStatusUnsubscribe()
  if (loginStatusPollTimer) { clearInterval(loginStatusPollTimer); loginStatusPollTimer = null }
  if (typeof unsubscribe === 'function') unsubscribe()
})
</script>

<template>
  <div class="vendor-page">
    <div class="toolbar">
      <div class="toolbar-left">
        <h2 class="page-title">额度管理</h2>
        <span class="model-count">{{ mergedModelList.length }} 个供应商</span>
      </div>
      <div class="toolbar-right">
        <button class="add-vendor-btn" @click="showAddModal = true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          添加供应商
        </button>
      </div>
    </div>

    <!-- 状态栏：最后更新时间 / 错误提示 -->
    <div class="status-bar" v-if="lastUpdate || fetchErrors.length">
      <div class="status-left" v-if="lastUpdate">
        <span class="status-dot-live"></span>
        <span class="status-text">实时数据</span>
        <span class="status-time">上次更新: {{ lastUpdate }}</span>
        <span class="status-interval">(每 60s 自动刷新)</span>
      </div>
      <div class="status-errors" v-if="fetchErrors.length">
        <span v-for="(err, i) in fetchErrors.slice(0, 2)" :key="i" class="status-error-item">
          {{ err }}
        </span>
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
              <div v-if="m.provider === 'DeepSeek API'" class="vendor-avatar vendor-avatar-img">
                <img class="vendor-logo-img" src="/deepseek.png" alt="DeepSeek" />
              </div>
              <div v-else-if="m.provider === 'Kimi CN'" class="vendor-avatar vendor-avatar-img">
                <img class="vendor-logo-img" src="/kimi.png" alt="Kimi" />
              </div>
              <div v-else-if="m.provider === 'XIAOMI MIMO'" class="vendor-avatar vendor-avatar-img">
                <img class="vendor-logo-img" src="/xiaomimimo.png" alt="XIAOMI MIMO" />
              </div>
              <div v-else-if="m.provider === 'Trae CN'" class="vendor-avatar vendor-avatar-img">
                <img class="vendor-logo-img" src="/trae.png" alt="Trae CN" />
              </div>
              <div v-else class="vendor-avatar" :style="{ backgroundColor: m.color }">
                <span class="avatar-letter">{{ m.name.charAt(0) }}</span>
              </div>
              <div class="vendor-info">
                <h3 class="vendor-name">
                  {{ m.name }}
                  <span v-if="m._stale" class="data-badge stale" title="使用缓存数据">缓存</span>
                  <span v-else-if="m._live" class="data-badge live" title="实时数据">实时</span>
                  <span v-if="isMonitorVendor(m.provider) && !m._monitorLoggedIn" class="data-badge warning" :title="m._stale ? '登录已失效，请重新登录' : '未登录，点击供应商卡片前往登录'">
                    {{ m._stale ? '登录失效' : '未登录' }}
                  </span>
                </h3>
                <p class="vendor-provider">{{ m.provider }}</p>
              </div>
            </div>

            <!-- 订阅额度条 -->
            <div class="allowance-bar-wrap">
              <div class="allowance-bar-top">
                <!-- DeepSeek / MIMO 实时余额（金额） -->
                <template v-if="(m.provider === 'DeepSeek API' || m.provider === 'XIAOMI MIMO') && m._live">
                  <span class="allowance-label">账户余额</span>
                  <span class="allowance-value">
                    {{ formatMoney(m.allowance.remainingTokens, '¥') }} / {{ formatMoney(m.allowance.planTokensTotal, '¥') }}
                  </span>
                </template>
                <!-- Trae CN 积分：总剩余积分 / 总积分 -->
                <template v-else-if="m.provider === 'Trae CN' && m._live">
                  <span class="allowance-label">总剩余积分</span>
                  <span class="allowance-value">
                    {{ formatCredits(m.allowance.remainingTokens) }} / {{ formatCredits(m.allowance.planTokensTotal) }} 积分
                  </span>
                </template>
                <template v-else>
                  <span class="allowance-label">{{ m.allowance.planName }}</span>
                  <span class="allowance-value">
                    {{ formatTokens(m.allowance.remainingTokens) }} / {{ formatTokens(m.allowance.planTokensTotal) }} tokens
                  </span>
                </template>
              </div>
              <div class="allowance-track">
                <div
                  class="allowance-fill"
                  :style="{ width: m.allowance.usedPercent + '%' }"
                ></div>
              </div>
              <div class="allowance-bar-bottom">
                <span>已用 {{ m.allowance.usedPercent }}%</span>
                <span v-if="(m.provider === 'DeepSeek API' || m.provider === 'XIAOMI MIMO') && m._live" class="allowance-status">
                  {{ m._deepseekAvailable ? '正常' : '异常' }}
                </span>
                <span v-else-if="m.provider === 'Trae CN' && m._live" class="allowance-status">
                  {{ m.allowance.remainingTokens > 0 ? '可用' : '已耗尽' }}
                </span>
                <span v-else>下次续费 {{ m.allowance.nextRenewal }}</span>
              </div>
            </div>

            <div class="card-meta">
              <div class="meta-slot">
                <span class="meta-label">{{ m.provider === 'Trae CN' ? '累计消耗' : '订阅费用' }}</span>
                <span class="meta-value mono">{{ m.provider === 'Trae CN' ? formatCredits(m.allowance.planTokensUsed) + ' 积分' : m.allowance.planCost }}</span>
              </div>
              <div class="meta-slot">
                <span class="meta-label">状态</span>
                <span class="meta-value">{{ m._live ? '实时' : m._stale ? '缓存' : '—' }}</span>
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
              <div v-if="m.provider === 'DeepSeek API'" class="vendor-avatar vendor-avatar-img">
                <img class="vendor-logo-img" src="/deepseek.png" alt="DeepSeek" />
              </div>
              <div v-else-if="m.provider === 'Kimi CN'" class="vendor-avatar vendor-avatar-img">
                <img class="vendor-logo-img" src="/kimi.png" alt="Kimi" />
              </div>
              <div v-else-if="m.provider === 'XIAOMI MIMO'" class="vendor-avatar vendor-avatar-img">
                <img class="vendor-logo-img" src="/xiaomimimo.png" alt="XIAOMI MIMO" />
              </div>
              <div v-else-if="m.provider === 'Trae CN'" class="vendor-avatar vendor-avatar-img">
                <img class="vendor-logo-img" src="/trae.png" alt="Trae CN" />
              </div>
              <div v-else class="vendor-avatar" :style="{ backgroundColor: m.color }">
                <span class="avatar-letter">{{ m.name.charAt(0) }}</span>
              </div>
              <div class="vendor-info">
                <h3 class="vendor-name">
                  {{ m.name }}
                  <span v-if="m._stale" class="data-badge stale" title="使用缓存数据">缓存</span>
                  <span v-else-if="m._live" class="data-badge live" title="实时数据">实时</span>
                  <span v-if="isMonitorVendor(m.provider) && !m._monitorLoggedIn" class="data-badge warning" :title="m._stale ? '登录已失效，请重新登录' : '未登录，点击供应商卡片前往登录'">
                    {{ m._stale ? '登录失效' : '未登录' }}
                  </span>
                </h3>
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
                <span class="meta-label">状态</span>
                <span class="meta-value">{{ m._live ? '实时' : m._stale ? '缓存' : '—' }}</span>
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

  <AddVendorModal
    v-if="showAddModal"
    @close="showAddModal = false"
    @saved="onVendorSaved"
  />
</template>

<style scoped>
.vendor-page { height: 100%; min-width: 0; box-sizing: border-box; display: flex; flex-direction: column; gap: 1rem; overflow-x: hidden; overflow-y: auto; padding: 0 1.25rem 1rem; }

.toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.75rem; flex-shrink: 0; margin-top: 1.5rem; }
.toolbar-left { display: flex; align-items: center; gap: 0.75rem; margin-left: 0.5rem; }
.page-title { font-size: 1.25rem; font-weight: 700; color: #1e293b; margin: 0; }
.model-count { font-size: 0.75rem; color: #94a3b8; background: #f1f5f9; padding: 0.2rem 0.6rem; border-radius: 999px; }
.add-vendor-btn { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.5rem 1rem; background: #4675ED; color: white; border: none; border-radius: 8px; font-size: 0.8125rem; font-weight: 500; cursor: pointer; transition: background 0.2s, box-shadow 0.2s; white-space: nowrap; }
.add-vendor-btn:hover { background: #3b5fd9; box-shadow: 0 4px 12px rgba(70,117,237,.25); }

/* Status bar */
.status-bar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem; padding: 0.45rem 0.75rem; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 0.7rem; color: #64748b; flex-shrink: 0; }
.status-left { display: flex; align-items: center; gap: 0.4rem; }
.status-dot-live { width: 7px; height: 7px; border-radius: 50%; background: #22c55e; animation: pulse-dot 2s ease-in-out infinite; }
@keyframes pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
.status-text { font-weight: 600; color: #16a34a; }
.status-time { color: #64748b; }
.status-interval { color: #94a3b8; }
.status-errors { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.status-error-item { color: #dc2626; font-size: 0.65rem; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Data source badge */
.data-badge { font-size: 0.58rem; font-weight: 600; padding: 0.1rem 0.4rem; border-radius: 4px; vertical-align: middle; margin-left: 0.35rem; }
.data-badge.live { background: #f0fdf4; color: #16a34a; }
.data-badge.stale { background: #fef3c7; color: #d97706; }

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
.vendor-avatar-img { background: #eff6ff !important; overflow: hidden; }
.vendor-logo-img { width: 100%; height: 100%; object-fit: contain; padding: 6px; box-sizing: border-box; }
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
.allowance-status { font-weight: 500; color: #16a34a; }

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

/* 未登录警告徽标（内联于供应商名称旁） */
.data-badge.warning { background: #fef2f2; color: #dc2626; }

@media (max-width: 768px) {
  .toolbar { flex-direction: column; align-items: stretch; }
  .add-vendor-btn { justify-content: center; }
  .vendor-grid { grid-template-columns: 1fr; }
}
</style>