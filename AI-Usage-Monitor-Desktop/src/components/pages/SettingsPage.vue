<script setup>
import { ref, onMounted, computed } from 'vue'

// 1. 选项卡切换状态
const activeTab = ref('keys') // 'keys' | 'sync'

// 2. API 密钥管理相关状态
const showKeys = ref({
  chatgpt_api: false,
  claude_api: false,
  kimi_api: false,
  glm_api: false,
  deepseek_api: false
})

const verifying = ref({
  chatgpt_api: false,
  claude_api: false,
  kimi_api: false,
  glm_api: false,
  deepseek_api: false
})

const keyInputs = ref({
  chatgpt_api: '',
  claude_api: '',
  kimi_api: '',
  glm_api: '',
  deepseek_api: ''
})

// 模拟 API 验证状态
const authStates = ref({
  chatgpt_api: { has_key: true, is_auth: 1, error_msg: '' },
  claude_api: { has_key: false, is_auth: 0, error_msg: '' },
  kimi_api: { has_key: true, is_auth: 1, error_msg: '' },
  glm_api: { has_key: false, is_auth: 0, error_msg: '' },
  deepseek_api: { has_key: true, is_auth: 1, error_msg: '' }
})

// 3. 服务列表定义
const SERVICES = [
  { id: 'chatgpt_api', name: 'ChatGPT API', provider: 'OpenAI' },
  { id: 'claude_api', name: 'Claude API', provider: 'Anthropic' },
  { id: 'kimi_api', name: 'KIMI API', provider: 'Moonshot' },
  { id: 'glm_api', name: 'GLM API', provider: '智谱 AI' },
  { id: 'deepseek_api', name: 'DeepSeek API', provider: 'DeepSeek' }
]

// 4. CSV 上传模拟相关状态
const csvFileInput = ref(null)
const importingCsv = ref(false)
const csvImportMsg = ref('')
const csvImportSuccess = ref(false)

// 5. 同步与偏好配置状态
const syncConfig = ref({
  sync_interval_minutes: '30',
  claude_code_sync_interval_minutes: '5',
  auto_launch: false,
  theme: 'light' // 'light' | 'dark'
})
const savingConfig = ref(false)

// 6. 本地存储持久化与初始化
onMounted(async () => {
  // 加载 API Key 状态
  const savedAuth = localStorage.getItem('ai_monitor_auth_states')
  if (savedAuth) {
    try { authStates.value = JSON.parse(savedAuth) } catch (e) {}
  }
  
  // 加载偏好设置
  const savedConfig = localStorage.getItem('ai_monitor_sync_config')
  if (savedConfig) {
    try { 
      syncConfig.value = { ...syncConfig.value, ...JSON.parse(savedConfig) }
    } catch (e) {}
  }

  // 核心：从 Electron 真实系统读取开机自启状态回显给开关
  if (window.electronAPI?.getAutoLaunch) {
    try {
      const actualAutoLaunch = await window.electronAPI.getAutoLaunch()
      syncConfig.value.auto_launch = actualAutoLaunch
    } catch (e) {
      console.error('无法读取系统开机自启动配置:', e)
    }
  }

  // 同步初始化主题
  applyTheme(syncConfig.value.theme)
})

// 应用主题模式（通过设置 html 根节点的 dark class 实现最轻量修改）
const applyTheme = (themeName) => {
  if (themeName === 'dark') {
    document.documentElement.classList.add('dark-mode')
  } else {
    document.documentElement.classList.remove('dark-mode')
  }
}

// 辅助函数
const getKeyPlaceholder = (id) => {
  const state = authStates.value[id]
  if (state && state.has_key) {
    return '•••••••••••••••••••••••••••• (已配置)'
  }
  return `请输入 ${id === 'chatgpt_api' ? 'sk-...' : 'API Key'}`
}

const getKeyStatusText = (id) => {
  const state = authStates.value[id]
  if (!state || !state.has_key) return '未配置'
  return state.is_auth === 1 ? '已验证' : '验证失败'
}

const getKeyStatusClass = (id) => {
  const state = authStates.value[id]
  if (!state || !state.has_key) return 'badge-muted'
  return state.is_auth === 1 ? 'badge-success' : 'badge-danger'
}

// 7. API 密钥校验与保存
const saveKey = (serviceId) => {
  const inputKey = keyInputs.value[serviceId]
  if (!inputKey || !inputKey.trim()) {
    alert('请输入有效的 API Key')
    return
  }

  verifying.value[serviceId] = true
  setTimeout(() => {
    // 模拟校验逻辑
    if (inputKey.length < 5) {
      authStates.value[serviceId] = {
        has_key: true,
        is_auth: 0,
        error_msg: 'Key 格式非法或无效'
      }
    } else {
      authStates.value[serviceId] = {
        has_key: true,
        is_auth: 1,
        error_msg: ''
      }
    }
    // 强制更新输入框模型
    keyInputs.value[serviceId] = ''
    localStorage.setItem('ai_monitor_auth_states', JSON.stringify(authStates.value))
    verifying.value[serviceId] = false
  }, 800)
}

// 清除 Key
const clearKey = (serviceId) => {
  if (!confirm(`确定要清除 ${serviceId} 的 API 密钥吗？`)) return
  authStates.value[serviceId] = {
    has_key: false,
    is_auth: 0,
    error_msg: ''
  }
  localStorage.setItem('ai_monitor_auth_states', JSON.stringify(authStates.value))
}

// CSV 上传处理
const triggerCsvUpload = () => {
  csvFileInput.value?.click()
}

const handleCsvSelect = (event) => {
  const file = event.target.files?.[0]
  if (!file) return

  importingCsv.value = true
  csvImportMsg.value = ''
  setTimeout(() => {
    importingCsv.value = false
    csvImportSuccess.value = true
    csvImportMsg.value = `导入成功：30 天，1,420 次请求，5,820,000 Token，消费 ¥12.45`
    if (csvFileInput.value) csvFileInput.value.value = ''
  }, 1000)
}

// 保存偏好配置
const saveGlobalConfig = () => {
  savingConfig.value = true
  setTimeout(() => {
    savingConfig.value = false
    localStorage.setItem('ai_monitor_sync_config', JSON.stringify(syncConfig.value))
    applyTheme(syncConfig.value.theme)

    // 核心：将自启开关状态同步给 Electron 后端 Node 进程写入系统设置
    if (window.electronAPI?.setAutoLaunch) {
      window.electronAPI.setAutoLaunch(syncConfig.value.auto_launch)
    }

    alert('偏好配置已成功更新并保存！')
  }, 500)
}
</script>

<template>
  <div class="settings-container">
    <!-- 顶部标题与导航 Tab 选项卡 -->
    <div class="settings-header card-wrapper">
      <div class="header-title">
        <h2>系统参数配置</h2>
        <p>管理 API 访问密钥、自动化数据抓取频率及系统展示偏好</p>
      </div>

      <div class="tab-buttons">
        <button 
          class="tab-btn" 
          :class="{ active: activeTab === 'keys' }"
          @click="activeTab = 'keys'"
        >
          🔑 API 密钥管理
        </button>
        <button 
          class="tab-btn" 
          :class="{ active: activeTab === 'sync' }"
          @click="activeTab = 'sync'"
        >
          ⚙️ 同步与偏好设置
        </button>
      </div>
    </div>

    <!-- 容器一：API 密钥管理 -->
    <div v-if="activeTab === 'keys'" class="tab-section card-wrapper animate-fade-in">
      <div class="section-desc-box">
        <p>💡 提示：密钥采用加密技术保存在本地。校验动作会向各模型官方服务器发起轻量验证以核对 Key 的有效性。</p>
      </div>

      <input
        type="file"
        ref="csvFileInput"
        accept=".csv,.zip"
        class="csv-file-input"
        @change="handleCsvSelect"
      />

      <div class="keys-list">
        <div v-for="svc in SERVICES" :key="svc.id" class="key-row-item">
          <div class="row-header">
            <div class="service-identity">
              <span class="service-name">{{ svc.name }}</span>
              <span class="service-provider">{{ svc.provider }}</span>
            </div>
            <span class="status-badge" :class="getKeyStatusClass(svc.id)">
              {{ getKeyStatusText(svc.id) }}
            </span>
          </div>

          <div class="row-body">
            <div class="input-control-group">
              <input
                :type="showKeys[svc.id] ? 'text' : 'password'"
                class="key-input"
                :placeholder="getKeyPlaceholder(svc.id)"
                v-model="keyInputs[svc.id]"
                :disabled="verifying[svc.id]"
              />

              <button class="btn-icon" @click="showKeys[svc.id] = !showKeys[svc.id]" title="切换显示/隐藏">
                {{ showKeys[svc.id] ? '👁️' : '🙈' }}
              </button>

              <button
                class="btn-primary-action"
                @click="saveKey(svc.id)"
                :disabled="verifying[svc.id]"
              >
                {{ verifying[svc.id] ? '校验中...' : '校验并保存' }}
              </button>

              <button
                v-if="authStates[svc.id]?.has_key"
                class="btn-danger-action"
                @click="clearKey(svc.id)"
                :disabled="verifying[svc.id]"
              >
                清除
              </button>
            </div>

            <!-- 校验失败的详细信息 -->
            <div class="error-msg-detail" v-if="authStates[svc.id]?.error_msg">
              校验失败: {{ authStates[svc.id].error_msg }}
            </div>

            <!-- DeepSeek 专属 CSV / ZIP 上传 -->
            <div v-if="svc.id === 'deepseek_api'" class="csv-import-area">
              <div class="csv-info">
                <p>DeepSeek 官方 API 不提供历史 Token/请求统计。如需补全月度历史，请上传用量 CSV/ZIP 文件。</p>
              </div>
              <div class="csv-action">
                <button
                  class="btn-csv-upload"
                  @click="triggerCsvUpload"
                  :disabled="importingCsv"
                >
                  {{ importingCsv ? '解析中...' : '📁 上传历史用量 CSV/ZIP' }}
                </button>
              </div>
              <p class="csv-hint-text" v-if="csvImportMsg" :class="{ success: csvImportSuccess }">
                {{ csvImportMsg }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 容器二：同步与偏好 -->
    <div v-if="activeTab === 'sync'" class="tab-section card-wrapper animate-fade-in">
      <div class="setting-list">
        <!-- 1. API 定时同步间隔 -->
        <div class="setting-row-item">
          <div class="setting-meta">
            <label class="setting-title">API 定时同步间隔</label>
            <span class="setting-desc">包括 ChatGPT, Claude, Kimi, GLM, DeepSeek API 用量的自动刷新周期。</span>
          </div>
          <div class="setting-control">
            <select v-model="syncConfig.sync_interval_minutes" class="custom-select">
              <option value="5">5 分钟</option>
              <option value="10">10 分钟</option>
              <option value="15">15 分钟</option>
              <option value="30">30 分钟</option>
              <option value="60">1 小时</option>
              <option value="120">2 小时</option>
            </select>
          </div>
        </div>

        <!-- 2. Claude Code 同步间隔 -->
        <div class="setting-row-item">
          <div class="setting-meta">
            <label class="setting-title">Claude Code 同步间隔</label>
            <span class="setting-desc">本地 CLI 工具与日志文件分析频率，建议设置较短时间以实时响应。</span>
          </div>
          <div class="setting-control">
            <select v-model="syncConfig.claude_code_sync_interval_minutes" class="custom-select">
              <option value="1">1 分钟</option>
              <option value="2">2 分钟</option>
              <option value="5">5 分钟</option>
              <option value="10">10 分钟</option>
              <option value="30">30 分钟</option>
            </select>
          </div>
        </div>

        <!-- 3. 开机自启动设置 -->
        <div class="setting-row-item">
          <div class="setting-meta">
            <label class="setting-title">开机自启动</label>
            <span class="setting-desc">登录 Windows 系统时自动在后台启动 AI 用量监控软件。</span>
          </div>
          <div class="setting-control">
            <label class="toggle-switch">
              <input type="checkbox" v-model="syncConfig.auto_launch" />
              <span class="switch-slider"></span>
            </label>
          </div>
        </div>

        <!-- 4. 显示主题模式 -->
        <div class="setting-row-item">
          <div class="setting-meta">
            <label class="setting-title">显示主题外观</label>
            <span class="setting-desc">切换系统的全局视觉风格模式（支持亮色白与极客暗黑模式）。</span>
          </div>
          <div class="setting-control">
            <select v-model="syncConfig.theme" class="custom-select" @change="applyTheme(syncConfig.theme)">
              <option value="light">☀️ 经典亮色 (Clean Light)</option>
              <option value="dark">🌙 极客暗黑 (Glass Dark)</option>
            </select>
          </div>
        </div>
      </div>

      <div class="save-footer">
        <button class="btn-save-all" @click="saveGlobalConfig" :disabled="savingConfig">
          {{ savingConfig ? '正在保存...' : '保存偏好配置' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-container {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  -webkit-app-region: no-drag;
}

/* 卡片统一包裹层 */
.card-wrapper {
  background: #ffffff;
  border-radius: 12px;
  border: 1px solid #e2e8f0;
  padding: 1.25rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.settings-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-title h2 {
  font-size: 1.25rem;
  font-weight: 700;
  color: #0f172a;
  margin: 0 0 0.25rem 0;
}

.header-title p {
  font-size: 0.85rem;
  color: #64748b;
  margin: 0;
}

/* 选项卡按钮组 */
.tab-buttons {
  display: flex;
  background: #f1f5f9;
  padding: 4px;
  border-radius: 8px;
  gap: 4px;
}

.tab-btn {
  padding: 8px 16px;
  font-size: 0.85rem;
  font-weight: 600;
  color: #64748b;
  border: none;
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.tab-btn.active {
  background: #ffffff;
  color: #2563eb;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.section-desc-box {
  background: #f8fafc;
  border-left: 4px solid #3b82f6;
  padding: 0.75rem 1rem;
  border-radius: 4px;
  font-size: 0.85rem;
  color: #475569;
  margin-bottom: 1.25rem;
}

/* API Key 列表项 */
.keys-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.key-row-item {
  border: 1px solid #f1f5f9;
  background: #fafafa;
  border-radius: 8px;
  padding: 1rem;
}

.row-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}

.service-name {
  font-weight: 700;
  font-size: 0.95rem;
  color: #1e293b;
  margin-right: 8px;
}

.service-provider {
  font-size: 0.75rem;
  background: #e2e8f0;
  color: #475569;
  padding: 2px 6px;
  border-radius: 4px;
}

.status-badge {
  font-size: 0.75rem;
  padding: 2px 8px;
  border-radius: 12px;
  font-weight: 600;
}

.badge-muted { background: #e2e8f0; color: #64748b; }
.badge-success { background: #dcfce7; color: #166534; }
.badge-danger { background: #fee2e2; color: #991b1b; }

.input-control-group {
  display: flex;
  gap: 8px;
  align-items: center;
}

.key-input {
  flex: 1;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 0.85rem;
  background: #ffffff;
  color: #0f172a;
  -webkit-app-region: no-drag;
}

.key-input:focus {
  outline: none;
  border-color: #3b82f6;
}

.btn-icon {
  border: 1px solid #cbd5e1;
  background: #ffffff;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
}

.btn-primary-action {
  background: #2563eb;
  color: #ffffff;
  border: none;
  padding: 8px 14px;
  border-radius: 6px;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}

.btn-danger-action {
  background: #ef4444;
  color: #ffffff;
  border: none;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 0.8rem;
  cursor: pointer;
}

.error-msg-detail {
  font-size: 0.75rem;
  color: #ef4444;
  margin-top: 6px;
}

.csv-import-area {
  margin-top: 0.75rem;
  padding: 0.75rem;
  background: #eff6ff;
  border: 1px dashed #93c5fd;
  border-radius: 6px;
}

.csv-info p {
  font-size: 0.75rem;
  color: #1e40af;
  margin: 0 0 8px 0;
}

.btn-csv-upload {
  background: #ffffff;
  border: 1px solid #93c5fd;
  color: #1d4ed8;
  padding: 6px 12px;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
}

.csv-file-input { display: none; }

.csv-hint-text {
  font-size: 0.75rem;
  margin-top: 6px;
  color: #15803d;
}

/* 同步与偏好设置列表 */
.setting-list {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.setting-row-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 1.25rem;
  border-bottom: 1px solid #f1f5f9;
}

.setting-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.setting-title {
  font-weight: 600;
  font-size: 0.95rem;
  color: #1e293b;
}

.setting-desc {
  font-size: 0.8rem;
  color: #64748b;
}

.custom-select {
  border: 1px solid #cbd5e1;
  background: #ffffff;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 0.85rem;
  color: #334155;
  -webkit-app-region: no-drag;
}

/* 开关 Toggle 组件 */
.toggle-switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
  -webkit-app-region: no-drag;
}

.toggle-switch input { opacity: 0; width: 0; height: 0; }

.switch-slider {
  position: absolute;
  cursor: pointer;
  top: 0; left: 0; right: 0; bottom: 0;
  background-color: #cbd5e1;
  transition: .3s;
  border-radius: 24px;
}

.switch-slider:before {
  position: absolute;
  content: "";
  height: 18px;
  width: 18px;
  left: 3px;
  bottom: 3px;
  background-color: white;
  transition: .3s;
  border-radius: 50%;
}

input:checked + .switch-slider { background-color: #2563eb; }
input:checked + .switch-slider:before { transform: translateX(20px); }

.save-footer {
  margin-top: 1.5rem;
  display: flex;
  justify-content: flex-end;
}

.btn-save-all {
  background: #2563eb;
  color: #ffffff;
  border: none;
  padding: 10px 24px;
  border-radius: 8px;
  font-weight: 600;
  font-size: 0.9rem;
  cursor: pointer;
}

.btn-save-all:hover { background: #1d4ed8; }

.animate-fade-in {
  animation: fadeIn 0.25s ease-in-out;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>

<!-- 暗黑模式的最轻量级选择器控制，无需改动全局 style.css -->
<style>
html.dark-mode {
  filter: invert(0.9) hue-rotate(180deg);
}

html.dark-mode img,
html.dark-mode svg,
html.dark-mode .chart-box,
html.dark-mode canvas {
  filter: invert(1.1) hue-rotate(180deg);
}
</style>
