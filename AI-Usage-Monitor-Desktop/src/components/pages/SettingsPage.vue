<script setup>
import { ref, onMounted } from 'vue'

// 开机自启动开关状态
const autoLaunch = ref(false)
// 缩小到系统托盘开关状态（默认开启）
const minimizeToTray = ref(true)
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const showFeedbackModal = ref(false)
const feedbackView = ref('menu') // 'menu' | 'faq'
const openFaqIndex = ref(-1)

// 检查更新状态
const appVersion = ref('')
const checkingUpdate = ref(false)
const updateResult = ref(null) // { hasUpdate, latestVersion, downloadUrl, releaseNotes }
const updateError = ref('')

// 缓存管理状态
const cacheSize = ref(0)
const clearingCache = ref(false)

function openFeedbackModal() {
  feedbackView.value = 'menu'
  openFaqIndex.value = -1
  showFeedbackModal.value = true
}

function goToFaq() {
  feedbackView.value = 'faq'
  openFaqIndex.value = -1
}

function backToMenu() {
  feedbackView.value = 'menu'
  openFaqIndex.value = -1
}

function toggleFaq(index) {
  openFaqIndex.value = openFaqIndex.value === index ? -1 : index
}

const faqList = [
  {
    q: '为什么数据和实际有误差？',
    a: '本软件采用的是API和爬虫技术实现，若存在session失效、多设备使用以及未开本软件使用，均会出现部分数据误差，但不影响正常余量监控。'
  },
  {
    q: '为什么数据没有实时更新？',
    a: '应用默认每 30 秒自动采集一次数据。如果长时间未更新，请检查网络连接和 API 密钥是否有效，也可以点击手动刷新按钮。'
  },
  {
    q: '为什么使用需要登录外部账户，会不会有安全问题？',
    a: '本软件在部分供应商通过浏览器会话读取用量，您的session数据和API key都仅在本地存储，不会上传云端，请放心使用。'
  },
  {
    q: '关闭应用后还会继续运行吗？',
    a: '当"缩小到系统托盘"开启时（默认开启），关闭窗口后应用会缩小到系统托盘后台运行。右键托盘图标可以"显示窗口"或"退出"。'
  },
  {
    q: '如何提交问题或建议？',
    a: '在上方"问题与反馈"中选择邮箱反馈或 GitHub Issues，我们会尽快处理。'
  }
]

// 加载当前设置
onMounted(async () => {
  if (window.electronAPI) {
    try {
      const enabled = await window.electronAPI.getAutoLaunch()
      autoLaunch.value = !!enabled
    } catch (e) {
      error.value = '加载设置失败: ' + (e.message || '未知错误')
    }
    try {
      const enabled = await window.electronAPI.getMinimizeToTray()
      minimizeToTray.value = enabled !== false
    } catch (e) {
      // 忽略，保持默认 true
    }
    try {
      appVersion.value = await window.electronAPI.getAppVersion()
    } catch (e) {
      appVersion.value = '未知'
    }
    await loadCacheSize()
  }
  loading.value = false
})

// 加载缓存大小
async function loadCacheSize() {
  if (!window.electronAPI) return
  try {
    const result = await window.electronAPI.getCacheSize()
    if (result.success) cacheSize.value = result.size
  } catch (e) {
    // 忽略
  }
}

// 格式化文件大小
function formatSize(bytes) {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i]
}

// 清理缓存
async function handleClearCache() {
  if (!window.electronAPI || clearingCache.value) return
  clearingCache.value = true
  try {
    const result = await window.electronAPI.clearCache()
    if (result.success) {
      await loadCacheSize()
    }
  } catch (e) {
    // 忽略
  }
  clearingCache.value = false
}

// 检查更新
async function checkForUpdates() {
  if (!window.electronAPI) return
  checkingUpdate.value = true
  updateError.value = ''
  updateResult.value = null
  try {
    const result = await window.electronAPI.checkForUpdates()
    if (result.success) {
      updateResult.value = result
    } else {
      updateError.value = result.error || '检查失败'
    }
  } catch (e) {
    updateError.value = '检查更新失败: ' + (e.message || '未知错误')
  }
  checkingUpdate.value = false
}

// 打开下载页面
async function openDownloadPage() {
  if (updateResult.value?.downloadUrl && window.electronAPI) {
    await window.electronAPI.openExternal(updateResult.value.downloadUrl)
  }
}

// 切换开关
async function toggleAutoLaunch() {
  const newValue = !autoLaunch.value
  saving.value = true
  error.value = ''

  if (window.electronAPI) {
    try {
      const result = await window.electronAPI.setAutoLaunch(newValue)
      if (result.success) {
        autoLaunch.value = result.enabled
      } else {
        error.value = result.error || '设置失败'
      }
    } catch (e) {
      error.value = '设置失败: ' + (e.message || '未知错误')
    }
  }

  saving.value = false
}

// 切换缩小到系统托盘
async function toggleMinimizeToTray() {
  const newValue = !minimizeToTray.value
  saving.value = true
  error.value = ''

  if (window.electronAPI) {
    try {
      const result = await window.electronAPI.setMinimizeToTray(newValue)
      if (result.success) {
        minimizeToTray.value = result.enabled
      } else {
        error.value = result.error || '设置失败'
      }
    } catch (e) {
      error.value = '设置失败: ' + (e.message || '未知错误')
    }
  }

  saving.value = false
}

async function sendEmail() {
  if (window.electronAPI) {
    await window.electronAPI.openExternal('mailto:service@lemonscloud.cn')
  }
  showFeedbackModal.value = false
}

async function openGitHub() {
  if (window.electronAPI) {
    await window.electronAPI.openExternal('https://github.com/KrisitVvv/AI-Usage-Monitor/issues')
  }
  showFeedbackModal.value = false
}
</script>

<template>
  <div class="settings-page">
    <div class="settings-container">
      <h2 class="settings-title">系统设置</h2>

      <div class="settings-card">
        <div class="setting-item">
          <div class="setting-info">
            <span class="setting-label">开机自启动</span>
            <span class="setting-desc">系统启动时自动运行本应用</span>
          </div>
          <div class="setting-control">
            <label class="toggle-switch" :class="{ disabled: saving }">
              <input
                type="checkbox"
                :checked="autoLaunch"
                :disabled="saving"
                @change="toggleAutoLaunch"
              />
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-item">
          <div class="setting-info">
            <span class="setting-label">缩小到系统托盘</span>
            <span class="setting-desc">关闭窗口时缩小到系统托盘继续运行</span>
          </div>
          <div class="setting-control">
            <label class="toggle-switch" :class="{ disabled: saving }">
              <input
                type="checkbox"
                :checked="minimizeToTray"
                :disabled="saving"
                @change="toggleMinimizeToTray"
              />
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-item feedback-card" @click="openFeedbackModal">
          <div class="setting-info">
            <span class="setting-label">问题与反馈</span>
            <span class="setting-desc">通过邮箱或 GitHub Issues 提交反馈</span>
          </div>
          <svg class="feedback-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </div>
      </div>

      <div v-if="error" class="settings-error">{{ error }}</div>

      <!-- 检测与更新 -->
      <h2 class="settings-title update-title">检测与更新</h2>
      <div class="settings-card">
        <div class="setting-item">
          <div class="setting-info">
            <span class="setting-label">当前版本</span>
            <span class="setting-desc">v{{ appVersion || '未知' }}</span>
          </div>
          <button class="check-update-btn" :disabled="checkingUpdate" @click="checkForUpdates">
            <svg v-if="!checkingUpdate" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>
            <svg v-else class="spinning" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
            <span>{{ checkingUpdate ? '检查中...' : '检查更新' }}</span>
          </button>
        </div>

        <!-- 更新结果 -->
        <template v-if="updateResult">
          <div class="setting-divider"></div>
          <div class="update-result">
            <template v-if="updateResult.hasUpdate">
              <div class="update-badge new">有新版本 v{{ updateResult.latestVersion }}</div>
              <p v-if="updateResult.releaseNotes" class="update-notes">{{ updateResult.releaseNotes }}</p>
              <button class="update-download-btn" @click="openDownloadPage">前往下载</button>
            </template>
            <template v-else>
              <div class="update-badge latest">已是最新版本</div>
            </template>
          </div>
        </template>

        <template v-if="updateError">
          <div class="setting-divider"></div>
          <div class="update-error">{{ updateError }}</div>
        </template>

        <div class="setting-divider"></div>
        <div class="setting-item">
          <div class="setting-info">
            <span class="setting-label">应用缓存</span>
            <span class="setting-desc">缓存占用 {{ formatSize(cacheSize) }}</span>
          </div>
          <button class="check-update-btn" :disabled="clearingCache" @click="handleClearCache">
            <svg v-if="!clearingCache" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
            <svg v-else class="spinning" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
            <span>{{ clearingCache ? '清理中...' : '清理缓存' }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- 反馈弹窗 -->
  <Teleport to="body">
    <div v-if="showFeedbackModal" class="modal-overlay" @click.self="showFeedbackModal = false">
      <div class="feedback-modal">
        <!-- 菜单视图 -->
        <template v-if="feedbackView === 'menu'">
          <div class="feedback-modal-header">
            <span>问题与反馈</span>
            <button class="modal-close-btn" @click="showFeedbackModal = false">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <p class="feedback-modal-desc">选择你需要的方式：</p>
          <div class="feedback-options">
            <div class="feedback-option" @click="goToFaq">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
                <circle cx="12" cy="17" r="0.5" fill="#8b5cf6"/>
              </svg>
              <div class="feedback-option-info">
                <span class="feedback-option-title">常见问题</span>
                <span class="feedback-option-desc">查看常见问题解答</span>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </div>
            <div class="feedback-option" @click="sendEmail">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2">
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                <polyline points="22,6 12,13 2,6"/>
              </svg>
              <div class="feedback-option-info">
                <span class="feedback-option-title">邮箱反馈</span>
                <span class="feedback-option-desc">发送邮件到 service@lemonscloud.cn</span>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </div>
            <div class="feedback-option" @click="openGitHub">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="#1e293b">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
              </svg>
              <div class="feedback-option-info">
                <span class="feedback-option-title">GitHub Issues</span>
                <span class="feedback-option-desc">在 GitHub 上创建 Issues</span>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </div>
          </div>
        </template>

        <!-- FAQ 视图 -->
        <template v-else>
          <div class="feedback-modal-header">
            <div class="faq-back-btn" @click="backToMenu">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
              </svg>
              <span>返回</span>
            </div>
            <button class="modal-close-btn" @click="showFeedbackModal = false">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <p class="feedback-modal-desc">常见问题解答：</p>
          <div class="modal-faq-list">
            <div
              v-for="(item, index) in faqList"
              :key="index"
              class="modal-faq-item"
              :class="{ open: openFaqIndex === index }"
            >
              <div class="modal-faq-question" @click="toggleFaq(index)">
                <span>{{ item.q }}</span>
                <svg class="modal-faq-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </div>
              <div class="modal-faq-answer-wrap">
                <div class="modal-faq-answer">{{ item.a }}</div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.settings-page {
  padding: 2rem;
  height: 100%;
  box-sizing: border-box;
  overflow-y: auto;
  container-type: inline-size;
}

.settings-container {
  width: 100%;
  margin: 0 auto;
}

.settings-title {
  font-size: 1.25rem;
  font-weight: 700;
  color: #1e293b;
  margin: 0 0 1.25rem;
}

.settings-card {
  background: white;
  border-radius: 12px;
  box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05), 0 1px 2px -1px rgba(0, 0, 0, 0.05);
  border: 1px solid #f1f5f9;
  overflow: hidden;
}

.setting-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.125rem 1.25rem;
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.setting-label {
  font-size: 0.9375rem;
  font-weight: 600;
  color: #1e293b;
}

.setting-desc {
  font-size: 0.8125rem;
  color: #94a3b8;
}

.setting-control {
  flex-shrink: 0;
  margin-left: 1.5rem;
}

.setting-divider {
  height: 1px;
  background: #f1f5f9;
  margin: 0 1.25rem;
}

/* ====== iOS 风格滑动开关 ====== */
.toggle-switch {
  position: relative;
  display: inline-block;
  width: 48px;
  height: 28px;
  cursor: pointer;
}

.toggle-switch.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.toggle-switch input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  inset: 0;
  background-color: #cbd5e1;
  border-radius: 28px;
  transition: background-color 0.25s ease;
}

.toggle-slider::before {
  content: '';
  position: absolute;
  width: 22px;
  height: 22px;
  left: 3px;
  bottom: 3px;
  background: white;
  border-radius: 50%;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
  transition: transform 0.25s ease;
}

.toggle-switch input:checked + .toggle-slider {
  background-color: #467CFE;
}

.toggle-switch input:checked + .toggle-slider::before {
  transform: translateX(20px);
}

.toggle-switch input:focus-visible + .toggle-slider {
  box-shadow: 0 0 0 3px rgba(70, 124, 254, 0.25);
}

/* 错误提示 */
.settings-error {
  margin-top: 0.75rem;
  padding: 0.5rem 0.875rem;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 8px;
  color: #b91c1c;
  font-size: 0.8125rem;
}

/* 反馈卡片 */
.feedback-card {
  cursor: pointer;
  transition: background-color 0.15s;
}
.feedback-card:hover {
  background: #f8fafc;
}
.feedback-arrow {
  flex-shrink: 0;
  margin-left: 1.5rem;
}

/* 反馈弹窗覆盖层 */
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0,0,0,0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}

/* 反馈弹窗 */
.feedback-modal {
  background: white;
  border-radius: 14px;
  padding: 1.5rem;
  max-width: 420px;
  width: 100%;
  box-shadow: 0 20px 60px rgba(0,0,0,0.15);
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.feedback-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 1rem;
  font-weight: 600;
  color: #1e293b;
}
.modal-close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  border-radius: 6px;
  color: #94a3b8;
  cursor: pointer;
  transition: all 0.15s;
}
.modal-close-btn:hover {
  background: #f1f5f9;
  color: #475569;
}
.feedback-modal-desc {
  margin: 0;
  font-size: 0.85rem;
  color: #64748b;
  line-height: 1.5;
}

/* 反馈选项 */
.feedback-options {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.feedback-option {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.85rem 1rem;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s;
}
.feedback-option:hover {
  border-color: #3b82f6;
  background: #f8faff;
}
.feedback-option-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.feedback-option-title {
  font-size: 0.875rem;
  font-weight: 600;
  color: #1e293b;
}
.feedback-option-desc {
  font-size: 0.75rem;
  color: #94a3b8;
}

/* 返回按钮 */
.faq-back-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  cursor: pointer;
  color: #475569;
  font-size: 0.875rem;
  font-weight: 500;
  transition: color 0.15s;
}
.faq-back-btn:hover {
  color: #1e293b;
}

/* 弹窗内常见问题 */
.modal-faq-list {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  max-height: 360px;
  overflow-y: auto;
}
.modal-faq-item {
  border: 1px solid #f1f5f9;
  border-radius: 8px;
  overflow: hidden;
  transition: border-color 0.2s;
}
.modal-faq-item.open {
  border-color: #e2e8f0;
}
.modal-faq-question {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.7rem 0.875rem;
  cursor: pointer;
  font-size: 0.8125rem;
  font-weight: 600;
  color: #1e293b;
  user-select: none;
  transition: background-color 0.15s;
}
.modal-faq-question:hover {
  background: #f8fafc;
}
.modal-faq-arrow {
  flex-shrink: 0;
  color: #94a3b8;
  transition: transform 0.25s ease;
}
.modal-faq-item.open .modal-faq-arrow {
  transform: rotate(180deg);
}
.modal-faq-answer-wrap {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.25s ease;
}
.modal-faq-item.open .modal-faq-answer-wrap {
  grid-template-rows: 1fr;
}
.modal-faq-answer {
  overflow: hidden;
  padding: 0 0.875rem;
  font-size: 0.8rem;
  color: #64748b;
  line-height: 1.65;
  max-height: 0;
  transition: max-height 0.25s ease, padding 0.25s ease;
}
.modal-faq-item.open .modal-faq-answer {
  max-height: 200px;
  padding: 0 0.875rem 0.7rem;
}

/* 检测与更新 */
.update-title {
  margin-top: 2rem;
}
.check-update-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem 1rem;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: white;
  color: #475569;
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}
.check-update-btn:hover:not(:disabled) {
  border-color: #467CFE;
  color: #467CFE;
  background: #f0f5ff;
}
.check-update-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.spinning {
  animation: spin 0.8s linear infinite;
}
.update-result {
  padding: 1.125rem 1.25rem;
}
.update-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.3rem 0.7rem;
  border-radius: 6px;
  font-size: 0.8125rem;
  font-weight: 600;
}
.update-badge.new {
  background: #fef3c7;
  color: #92400e;
}
.update-badge.latest {
  background: #d1fae5;
  color: #065f46;
}
.update-notes {
  margin: 0.625rem 0;
  font-size: 0.8rem;
  color: #64748b;
  line-height: 1.6;
  white-space: pre-wrap;
}
.update-download-btn {
  margin-top: 0.5rem;
  padding: 0.5rem 1.25rem;
  border: none;
  border-radius: 8px;
  background: #467CFE;
  color: white;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s;
}
.update-download-btn:hover {
  background: #3563d9;
}
.update-error {
  padding: 0.5rem 1.25rem;
  font-size: 0.8125rem;
  color: #b91c1c;
}

@container (max-width: 480px) {
  .settings-page {
    padding: 1rem;
  }
  .setting-item {
    padding: 0.875rem 1rem;
  }
  .setting-divider {
    margin: 0 1rem;
  }
}
</style>
