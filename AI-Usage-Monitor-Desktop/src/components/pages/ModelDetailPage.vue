<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()
const loading = ref(true)
const vendor = ref(null)
const balance = ref(null)
const activeTab = ref('allowance')
const showDeleteConfirm = ref(false)
const deleting = ref(false)
const resetting = ref(false)
const loginLoading = ref(false)
const renaming = ref(false)
const monitorLoggedIn = ref(false)
let loginPollTimer = null
let loginStatusUnsubscribe = null
let loginStatusPollTimer = null
const renameValue = ref('')
let unsubscribe = null

// ---------- 工具 ----------
const PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#ec4899', '#06b6d4', '#f97316', '#84cc16', '#6366f1']
function vendorColor(name) {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash) + name.charCodeAt(i)
  return PALETTE[Math.abs(hash) % PALETTE.length]
}

onMounted(async () => {
  if (window.electronAPI) {
    try {
      const data = await window.electronAPI.getUsageData()
      if (data) {
        const found = data.vendors?.find(v => v.id === route.params.id)
        vendor.value = found || null
        // 按 vendor ID 查找 balance（DeepSeek / Kimi），找不到则用全局 fallback
        const balances = { ...(data.deepseekBalances || {}), ...(data.kimiBalances || {}) }
        balance.value = balances[route.params.id] || data.deepseekBalance || data.kimiBalance || null
      }
    } catch { /* 忽略 */ }

    // 查询 DeepSeek/Kimi Monitor 实际登录状态
    if ((isDeepSeek.value || vendorType.value === 'Moonshot') && window.electronAPI.getMonitorLoginStatus) {
      try {
        const loggedIn = await window.electronAPI.getMonitorLoginStatus(vendor.value?.id)
        monitorLoggedIn.value = !!loggedIn
      } catch { /* 忽略 */ }
    }

    // 订阅登录状态变更事件（实时更新）
    if (window.electronAPI.onMonitorLoginStatusChanged) {
      loginStatusUnsubscribe = window.electronAPI.onMonitorLoginStatusChanged(({ vendorId, loggedIn }) => {
        if (vendorId === vendor.value?.id) {
          monitorLoggedIn.value = loggedIn
        }
      })
    }

    // 定期轮询登录状态（作为事件推送的补充，防止遗漏）
    loginStatusPollTimer = setInterval(async () => {
      if (!isDeepSeek.value && vendorType.value !== 'Moonshot') return
      if (!window.electronAPI?.getMonitorLoginStatus || !vendor.value?.id) return
      try {
        const loggedIn = await window.electronAPI.getMonitorLoginStatus(vendor.value.id)
        monitorLoggedIn.value = !!loggedIn
      } catch { /* 忽略 */ }
    }, 15000)

    // 订阅后续更新
    unsubscribe = window.electronAPI.onUsageDataUpdated((data) => {
      const found = data.vendors?.find(v => v.id === route.params.id)
      if (found) {
        // 合并自定义名称，防止旧数据覆盖
        if (vendor.value?.customName && !found.customName) {
          found.customName = vendor.value.customName
        }
        vendor.value = found
      }
      const balances = { ...(data.deepseekBalances || {}), ...(data.kimiBalances || {}) }
      const newBalance = balances[route.params.id] || data.deepseekBalance || data.kimiBalance
      if (newBalance) balance.value = newBalance
    })
  }
  setTimeout(() => { loading.value = false }, 400)
})

onUnmounted(() => {
  stopLoginPoll()
  if (typeof loginStatusUnsubscribe === 'function') loginStatusUnsubscribe()
  if (loginStatusPollTimer) { clearInterval(loginStatusPollTimer); loginStatusPollTimer = null }
  if (typeof unsubscribe === 'function') unsubscribe()
})

const goBack = () => router.push({ name: 'progress' })

const isDeepSeek = computed(() => vendor.value?.provider === 'DeepSeek API')
const isPlan = computed(() => vendor.value?.billingModel === 'plan')
const isToken = computed(() => vendor.value?.billingModel === 'token')
const hasBalance = computed(() => !!balance.value)
const isLive = computed(() => isDeepSeek.value ? monitorLoggedIn.value : (hasBalance.value && !balance.value?._stale))
const isLoggedIn = computed(() => isDeepSeek.value ? monitorLoggedIn.value : hasBalance.value)
const displayName = computed(() => vendor.value?.customName || shortName(vendor.value?.provider || ''))

const modelColor = computed(() => vendorColor(vendor.value?.provider || ''))

// 供应商类型映射
const vendorType = computed(() => {
  const p = vendor.value?.provider || ''
  if (p.includes('DeepSeek')) return 'DeepSeek'
  if (p.includes('Kimi') || p.includes('Moonshot')) return 'Moonshot'
  if (p.includes('OpenAI')) return 'OpenAI'
  if (p.includes('Aliyun') || p.includes('阿里云')) return 'Aliyun'
  return ''
})

function startRename() {
  renameValue.value = vendor.value?.customName || shortName(vendor.value?.provider || '')
  renaming.value = true
}

async function saveRename() {
  if (!vendor.value?.id || !renameValue.value.trim()) { renaming.value = false; return }
  const newName = renameValue.value.trim()
  try {
    await window.electronAPI.renameVendor(vendor.value.id, newName)
    vendor.value = { ...vendor.value, customName: newName }
    // 通知 ProgressPage 立即更新名称
    try {
      const pending = JSON.parse(localStorage.getItem('pendingVendorRenames') || '[]')
      pending.push({ vendorId: vendor.value.id, customName: newName, ts: Date.now() })
      localStorage.setItem('pendingVendorRenames', JSON.stringify(pending))
    } catch { /* 忽略 */ }
  } catch (e) {
    alert('重命名失败: ' + e.message)
  }
  renaming.value = false
}

function cancelRename() { renaming.value = false }

function shortName(provider) {
  const map = {
    'DeepSeek API': 'DeepSeek', 'OpenAI API': 'OpenAI', 'Kimi CN': 'Kimi CN',
    'Aliyun API': '阿里云', '智谱 AI': 'GLM', 'Anthropic': 'Claude',
    'Google AI': 'Gemini', 'Stability AI': 'SDXL', '百度文心': '文心', '科大讯飞': '讯飞'
  }
  return map[provider] || provider
}

// ---------- 额度数据 ----------
const allowanceData = computed(() => {
  if (!hasBalance.value) return null

  const b = balance.value
  const totalBudget = b.totalBudget || 0
  const remaining = b.remaining || 0
  const spent = b.spent || 0
  const usedPercent = b.usedPercent ?? (totalBudget > 0 ? Math.round((spent / totalBudget) * 100) : 0)
  const currency = b.currency === 'CNY' ? '¥' : '$'
  const isAvailable = b.is_available
  const isStale = b._stale

  return { totalBudget, remaining, spent, usedPercent, currency, isAvailable, isStale }
})

function usageClass(pct) {
  if (pct >= 90) return 'danger'
  if (pct >= 75) return 'warning'
  return 'safe'
}

function formatMoney(n, currency) {
  if (currency) return currency + Number(n || 0).toFixed(2)
  return '$' + Number(n || 0).toFixed(2)
}

async function confirmDelete() {
  if (!vendor.value?.id || deleting.value) return
  deleting.value = true
  try {
    await window.electronAPI.deleteVendor(vendor.value.id)
    router.push({ name: 'progress' })
  } catch (e) {
    deleting.value = false
    showDeleteConfirm.value = false
    alert('删除失败: ' + e.message)
  }
}

async function loginDeepSeek() {
  if (!window.electronAPI?.showLoginWindow || loginLoading.value) return
  loginLoading.value = true
  try {
    await window.electronAPI.showLoginWindow(vendor.value?.id)
  } catch (e) {
    console.warn('[ModelDetail] 打开登录窗口失败:', e.message)
  } finally {
    setTimeout(() => { loginLoading.value = false }, 2000)
  }
  // 登录窗口关闭后，轮询登录状态直到成功
  startLoginPoll()
}

function startLoginPoll() {
  stopLoginPoll()
  let attempts = 0
  loginPollTimer = setInterval(async () => {
    attempts++
    if (attempts > 30 || monitorLoggedIn.value) { // 最多轮询 30 次（约 30 秒）
      stopLoginPoll()
      return
    }
    if (!isDeepSeek.value || !window.electronAPI?.getMonitorLoginStatus) return
    try {
      const loggedIn = await window.electronAPI.getMonitorLoginStatus(vendor.value?.id)
      if (loggedIn) {
        monitorLoggedIn.value = true
        stopLoginPoll()
      }
    } catch { /* 忽略 */ }
  }, 1000)
}

function stopLoginPoll() {
  if (loginPollTimer) {
    clearInterval(loginPollTimer)
    loginPollTimer = null
  }
}

async function resetBudget() {
  if (resetting.value) return
  resetting.value = true
  try {
    const result = await window.electronAPI.resetDeepSeekBudget()
    if (result.success) {
      // usage-data-updated 订阅会自动更新 balance
      if (result.data?.deepseekBalance) {
        balance.value = result.data.deepseekBalance
      }
    } else {
      alert('重置失败: ' + (result.error || '未知错误'))
    }
  } catch (e) {
    alert('重置失败: ' + e.message)
  } finally {
    resetting.value = false
  }
}
</script>

<template>
  <div class="detail-page">
    <div v-if="loading" class="detail-loading">
      <div class="spinner"></div>
      <p>加载厂商详情...</p>
    </div>

    <div v-else-if="!vendor" class="detail-error">
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
        <div class="topbar-right">
          <button
            v-if="isDeepSeek || vendorType === 'Moonshot'"
            class="login-deepseek-btn"
            @click="loginDeepSeek"
            :disabled="loginLoading"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>
            </svg>
            {{ loginLoading ? '打开中...' : (isLoggedIn ? '更换账户' : '登录 ' + (vendorType === 'Moonshot' ? 'Kimi' : 'DeepSeek')) }}
          </button>
          <button class="delete-btn danger-btn" @click="showDeleteConfirm = true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
            删除
          </button>
        </div>
      </div>

      <!-- 厂商头部 -->
      <div class="vendor-header">
        <div class="vendor-avatar" :style="(vendorType === 'DeepSeek' || vendorType === 'Moonshot') ? {} : { backgroundColor: modelColor }">
          <template v-if="vendorType === 'DeepSeek'">
            <img src="/deepseek.png" alt="DeepSeek" style="width: 52px; height: 52px; object-fit: contain;" />
          </template>
          <template v-else-if="vendorType === 'Moonshot'">
            <img src="/kimi.png" alt="Kimi" style="width: 52px; height: 52px; object-fit: contain;" />
          </template>
          <template v-else-if="vendorType === 'OpenAI'">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M12 2a4 4 0 014 4v4a4 4 0 01-4 4 4 4 0 01-4-4V6a4 4 0 014-4z" fill="white" opacity="0.6"/><path d="M12 10a4 4 0 014 4v4a4 4 0 01-4 4 4 4 0 01-4-4v-4a4 4 0 014-4z" fill="white"/></svg>
          </template>
          <template v-else-if="vendorType === 'Aliyun'">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M18 10h-3a2 2 0 01-2-2V5a2 2 0 012-2h3a2 2 0 012 2v3a2 2 0 01-2 2z" fill="white" opacity="0.6"/><path d="M9 14H6a2 2 0 01-2-2V9a2 2 0 012-2h3a2 2 0 012 2v3a2 2 0 01-2 2z" fill="white"/><path d="M18 21h-3a2 2 0 01-2-2v-3a2 2 0 012-2h3a2 2 0 012 2v3a2 2 0 01-2 2z" fill="white" opacity="0.4"/></svg>
          </template>
          <span v-else class="avatar-letter">{{ displayName.charAt(0) }}</span>
        </div>
        <div class="vendor-header-info">
          <div class="vendor-title-row">
            <h1 v-if="!renaming" class="vendor-title">{{ displayName }}</h1>
            <div v-else class="rename-inline">
              <input
                class="rename-input"
                v-model="renameValue"
                @keyup.enter="saveRename"
                @keyup.escape="cancelRename"
                autofocus
              />
              <button class="rename-save" @click="saveRename">确定</button>
              <button class="rename-cancel" @click="cancelRename">取消</button>
            </div>
            <span :class="['billing-chip', vendor.billingModel]">
              {{ vendor.billingModel === 'plan' ? 'Plan 订阅' : 'Token 计费' }}
            </span>
            <span v-if="hasBalance && balance._stale" class="data-badge stale">缓存</span>
            <span v-else-if="isLive" class="data-badge live">实时</span>
          </div>
          <div class="vendor-tags">
            <span class="tag">{{ vendor.provider }}</span>
            <span v-if="vendor.error" class="tag error-tag">采集异常</span>
            <button v-if="!renaming" class="rename-btn" @click="startRename" title="重命名">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
              </svg>
              重命名
            </button>
          </div>
        </div>
      </div>

      <p v-if="vendor.error" class="vendor-error">上次采集异常: {{ vendor.error }}</p>
      <p v-else-if="vendor.note" class="vendor-desc">{{ vendor.note }}</p>

      <!-- ====== 额度大卡片 ====== -->
      <div v-if="allowanceData" class="allowance-hero" :class="usageClass(allowanceData.usedPercent)">
        <div class="hero-top">
          <svg class="hero-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
          </svg>
          <span class="hero-label">
            {{ isPlan ? displayName + ' 账户余额' : '账户余额' }}
          </span>
        </div>

        <div class="hero-numbers">
          <div class="hero-number-block">
            <span class="hero-number">{{ formatMoney(allowanceData.remaining, allowanceData.currency) }}</span>
            <span class="hero-number-unit">当前余额</span>
          </div>
          <div class="hero-divider"></div>
          <div class="hero-number-block">
            <span class="hero-number">{{ formatMoney(allowanceData.totalBudget, allowanceData.currency) }}</span>
            <span class="hero-number-unit">累计充值</span>
          </div>
        </div>

        <div class="hero-bar-wrap">
          <div class="hero-track">
            <div class="hero-fill" :style="{ width: allowanceData.usedPercent + '%' }"></div>
          </div>
          <div class="hero-bar-labels">
            <span>已用 {{ allowanceData.usedPercent }}%</span>
            <span>{{ allowanceData.isAvailable ? '账户正常' : '账户异常' }}</span>
          </div>
        </div>

        <div class="hero-footer">
          <div class="hero-foot-item">
            <span class="hf-label">已消费</span>
            <span class="hf-value">{{ formatMoney(allowanceData.spent, allowanceData.currency) }}</span>
          </div>
          <div class="hero-foot-item">
            <span class="hf-label">{{ isDeepSeek ? '赠送余额' : '代金券' }}</span>
            <span class="hf-value">{{ formatMoney(isDeepSeek ? (balance?.granted_balance || 0) : (balance?.voucher_balance || 0), allowanceData.currency) }}</span>
          </div>
          <button
            v-if="isDeepSeek"
            class="reset-btn"
            :class="{ loading: resetting }"
            :disabled="resetting"
            @click.stop="resetBudget"
            title="将累计充值重置为当前余额，进度条归零"
          >
            <svg v-if="resetting" class="reset-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
            <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            {{ resetting ? '重置中...' : '初始化' }}
          </button>
        </div>
      </div>

      <!-- 无余额数据时的占位 -->
      <div v-else class="allowance-hero safe">
        <div class="hero-top">
          <svg class="hero-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
          </svg>
          <span class="hero-label">{{ displayName }}</span>
        </div>
        <div class="hero-numbers">
          <div class="hero-number-block">
            <span class="hero-number">—</span>
            <span class="hero-number-unit">等待数据</span>
          </div>
        </div>
      </div>

      <!-- Tab 栏 -->
      <div class="tab-bar">
        <button :class="['tab-btn', { active: activeTab === 'allowance' }]" @click="activeTab = 'allowance'">额度详情</button>
        <button :class="['tab-btn', { active: activeTab === 'info' }]" @click="activeTab = 'info'">供应商信息</button>
      </div>

      <div class="tab-content">
        <!-- 额度详情 -->
        <div v-if="activeTab === 'allowance' && allowanceData" class="allowance-detail-panel">
          <div class="detail-grid">
            <div class="detail-item">
              <span class="detail-label">计费模式</span>
              <span class="detail-value">{{ isPlan ? 'Plan 订阅' : 'Token 按量计费' }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">当前余额</span>
              <span class="detail-value mono highlight">{{ formatMoney(allowanceData.remaining, allowanceData.currency) }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">累计充值</span>
              <span class="detail-value mono">{{ formatMoney(allowanceData.totalBudget, allowanceData.currency) }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">已消费</span>
              <span class="detail-value mono">{{ formatMoney(allowanceData.spent, allowanceData.currency) }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">使用率</span>
              <span class="detail-value" :class="usageClass(allowanceData.usedPercent)">{{ allowanceData.usedPercent }}%</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">账户状态</span>
              <span class="detail-value" :class="allowanceData.isAvailable ? 'safe' : 'danger'">
                {{ allowanceData.isAvailable ? '正常' : '异常' }}
              </span>
            </div>
            <div class="detail-item detail-item-full">
              <span class="detail-label">{{ isDeepSeek ? '赠送余额' : '代金券余额' }}</span>
              <span class="detail-value mono">{{ formatMoney(isDeepSeek ? (balance?.granted_balance || 0) : (balance?.voucher_balance || 0), allowanceData.currency) }}</span>
            </div>
            <div class="detail-item detail-item-full">
              <span class="detail-label">数据来源</span>
              <span class="detail-value">
                {{ allowanceData.isStale ? '缓存数据（上次成功采集结果）' : '实时数据' }}
                <span v-if="balance?.fetchedAt" class="fetch-time">({{ new Date(balance.fetchedAt).toLocaleString('zh-CN') }})</span>
              </span>
            </div>
          </div>
        </div>

        <!-- 供应商信息 -->
        <div v-if="activeTab === 'info'" class="info-panel">
          <div class="detail-grid">
            <div class="detail-item">
              <span class="detail-label">供应商名称</span>
              <span class="detail-value">{{ vendor.provider }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">计费模式</span>
              <span class="detail-value">{{ vendor.billingModel === 'plan' ? 'Plan 订阅' : 'Token 按量计费' }}</span>
            </div>
            <div class="detail-item detail-item-full">
              <span class="detail-label">添加时间</span>
              <span class="detail-value">{{ vendor.createdAt ? new Date(vendor.createdAt).toLocaleString('zh-CN') : '—' }}</span>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>

  <!-- 删除确认弹窗 -->
  <Teleport to="body">
    <div v-if="showDeleteConfirm" class="modal-overlay">
      <div class="confirm-modal">
        <div class="confirm-header">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <span>确认删除</span>
        </div>
        <p class="confirm-body">
          确定要删除 <strong>{{ displayName }}</strong> 吗？<br/>
          删除后该供应商的 API 密钥和配置将被移除，此操作不可撤销。
        </p>
        <div class="confirm-actions">
          <button class="cancel-btn" @click="showDeleteConfirm = false" :disabled="deleting">取消</button>
          <button class="delete-btn" @click="confirmDelete" :disabled="deleting">
            <span v-if="deleting" class="btn-spinner"></span>
            <span v-else>确认删除</span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.detail-page { height: 100%; min-width: 0; box-sizing: border-box; display: flex; flex-direction: column; gap: 1rem; overflow-x: hidden; overflow-y: auto; padding: 0 1.25rem 1rem; margin-top: 1rem; }

.detail-loading, .detail-error { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.75rem; color: #94a3b8; }
.spinner { width: 36px; height: 36px; border: 3px solid #e2e8f0; border-top-color: #4675ED; border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.detail-error h3 { color: #1e293b; margin: 0; }

.detail-topbar { display: flex; align-items: center; justify-content: space-between; }
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
.error-tag { color: #dc2626; background: #fef2f2; }
.data-badge { font-size: 0.6rem; font-weight: 600; padding: 0.15rem 0.4rem; border-radius: 4px; vertical-align: middle; flex-shrink: 0; }
.data-badge.live { background: #f0fdf4; color: #16a34a; }
.data-badge.stale { background: #fef3c7; color: #d97706; }
.vendor-desc { font-size: 0.85rem; color: #64748b; line-height: 1.6; margin: 0; }
.vendor-error { font-size: 0.82rem; color: #dc2626; background: #fef2f2; padding: 0.5rem 0.75rem; border-radius: 8px; margin: 0; }

/* Allowance hero */
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
.hero-footer { display: flex; align-items: center; gap: 2rem; padding-top: 0.5rem; border-top: 1px solid #f1f5f9; }
.hero-foot-item { display: flex; flex-direction: column; gap: 0.1rem; }
.hf-label { font-size: 0.68rem; color: #94a3b8; }
.hf-value { font-size: 0.85rem; font-weight: 600; color: #1e293b; }

/* Reset button */
.reset-btn { display: inline-flex; align-items: center; gap: 0.35rem; margin-left: auto; padding: 0.35rem 0.75rem; border: 1px solid #dbeafe; background: #eff6ff; border-radius: 6px; font-size: 0.72rem; font-weight: 500; color: #3b82f6; cursor: pointer; transition: all 0.2s; white-space: nowrap; flex-shrink: 0; }
.reset-btn:hover:not(:disabled) { background: #dbeafe; border-color: #93c5fd; color: #2563eb; }
.reset-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.reset-btn.loading { border-color: #93c5fd; }
.reset-spinner { animation: reset-spin .8s linear infinite; }
@keyframes reset-spin { to { transform: rotate(360deg); } }

/* Tabs */
.tab-bar { display: flex; border-bottom: 1px solid #e2e8f0; flex-shrink: 0; overflow-x: auto; -ms-overflow-style: none; scrollbar-width: none; }
.tab-bar::-webkit-scrollbar { display: none; }
.tab-btn { padding: 0.55rem 1rem; border: none; background: transparent; font-size: 0.8125rem; font-weight: 500; color: #64748b; cursor: pointer; position: relative; transition: color 0.2s; white-space: nowrap; flex-shrink: 0; }
.tab-btn:hover { color: #1e293b; }
.tab-btn.active { color: #4675ED; }
.tab-btn.active::after { content: ''; position: absolute; bottom: -1px; left: 0; right: 0; height: 2px; background: #4675ED; border-radius: 2px 2px 0 0; }
.tab-content { flex: 1; min-width: 0; }

/* Detail grid */
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
.fetch-time { font-size: 0.7rem; color: #94a3b8; font-weight: 400; }

/* Topbar right */
.topbar-right { display: flex; align-items: center; gap: 0.5rem; }

/* Danger/Delete */
.danger-btn { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.4rem 0.75rem; border: 1px solid #fecaca; background: #fef2f2; border-radius: 8px; font-size: 0.75rem; color: #dc2626; cursor: pointer; transition: all 0.2s; }
.danger-btn:hover { background: #fee2e2; border-color: #fca5a5; }

/* Confirm modal */
.modal-overlay { position: fixed; inset: 0; z-index: 1000; background: rgba(0,0,0,0.35); display: flex; align-items: center; justify-content: center; padding: 1rem; }
.confirm-modal { background: white; border-radius: 14px; padding: 1.5rem; max-width: 380px; width: 100%; box-shadow: 0 20px 60px rgba(0,0,0,.15); display: flex; flex-direction: column; gap: 1rem; }
.confirm-header { display: flex; align-items: center; gap: 0.5rem; font-size: 1rem; font-weight: 600; color: #1e293b; }
.confirm-body { font-size: 0.85rem; color: #64748b; line-height: 1.6; margin: 0; }
.confirm-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
.cancel-btn { padding: 0.45rem 1rem; border: 1px solid #e2e8f0; background: white; border-radius: 8px; font-size: 0.8125rem; color: #475569; cursor: pointer; transition: all 0.2s; }
.cancel-btn:hover { background: #f8fafc; }
.cancel-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.login-deepseek-btn { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.45rem 1rem; border: 1px solid #f59e0b; background: #fffbeb; border-radius: 8px; font-size: 0.8125rem; color: #92400e; cursor: pointer; transition: all 0.2s; }
.login-deepseek-btn:hover { background: #fef3c7; border-color: #d97706; }
.login-deepseek-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.rename-btn { display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.15rem 0.5rem; border: 1px solid #e2e8f0; background: white; border-radius: 4px; font-size: 0.68rem; color: #64748b; cursor: pointer; transition: all 0.15s; }
.rename-btn:hover { border-color: #3b82f6; color: #3b82f6; }
.rename-inline { display: flex; align-items: center; gap: 0.35rem; }
.rename-input { padding: 0.2rem 0.5rem; border: 1px solid #3b82f6; border-radius: 6px; font-size: 1.125rem; font-weight: 700; color: #1e293b; outline: none; width: 14rem; }
.rename-save { padding: 0.2rem 0.6rem; border: none; background: #3b82f6; color: white; border-radius: 6px; font-size: 0.75rem; cursor: pointer; }
.rename-save:hover { background: #2563eb; }
.rename-cancel { padding: 0.2rem 0.6rem; border: 1px solid #e2e8f0; background: white; color: #64748b; border-radius: 6px; font-size: 0.75rem; cursor: pointer; }
.rename-cancel:hover { background: #f8fafc; }
.delete-btn { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.45rem 1rem; border: none; background: #dc2626; border-radius: 8px; font-size: 0.8125rem; color: white; cursor: pointer; transition: all 0.2s; }
.delete-btn:hover { background: #b91c1c; }
.delete-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-spinner { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.3); border-top-color: white; border-radius: 50%; animation: spin .6s linear infinite; }

@media (max-width: 768px) {
  .hero-numbers { gap: 1.5rem; }
  .hero-number { font-size: 1.75rem; }
  .detail-grid { grid-template-columns: 1fr; }
}
</style>
