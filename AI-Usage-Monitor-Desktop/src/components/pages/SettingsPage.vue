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
  }
  loading.value = false
})

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

function openFeedbackModal() {
  showFeedbackModal.value = true
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
    </div>
  </div>

  <!-- 反馈弹窗 -->
  <Teleport to="body">
    <div v-if="showFeedbackModal" class="modal-overlay" @click.self="showFeedbackModal = false">
      <div class="feedback-modal">
        <div class="feedback-modal-header">
          <span>提交问题与反馈</span>
          <button class="modal-close-btn" @click="showFeedbackModal = false">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <p class="feedback-modal-desc">选择你喜欢的方式提交反馈：</p>
        <div class="feedback-options">
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
}

.settings-container {
  max-width: 560px;
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
</style>
