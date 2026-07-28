<script setup>
import { ref, onMounted } from 'vue'

// 开机自启动开关状态
const autoLaunch = ref(false)
const loading = ref(true)
const saving = ref(false)
const error = ref('')

// 加载当前设置
onMounted(async () => {
  if (window.electronAPI) {
    try {
      const enabled = await window.electronAPI.getAutoLaunch()
      autoLaunch.value = !!enabled
    } catch (e) {
      error.value = '加载设置失败: ' + (e.message || '未知错误')
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
      </div>

      <div v-if="error" class="settings-error">{{ error }}</div>
    </div>
  </div>
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
</style>
