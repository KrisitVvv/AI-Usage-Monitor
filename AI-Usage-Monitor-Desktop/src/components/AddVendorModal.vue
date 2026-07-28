<script setup>
import { ref, computed } from 'vue'

const emit = defineEmits(['close', 'saved'])

// ---------- 供应商与计费模式配置 ----------
const PROVIDERS = [
  { name: 'DeepSeek API', billingModels: ['token'] },
  { name: 'Kimi API', billingModels: ['plan', 'token'] },
  { name: 'OpenAI API', billingModels: ['plan', 'token'] },
  { name: 'Aliyun API', billingModels: ['token', 'plan'] },
  { name: '智谱 AI', billingModels: ['token'] },
  { name: 'Stability AI', billingModels: ['token'] },
  { name: '百度文心', billingModels: ['token'] },
  { name: '科大讯飞', billingModels: ['token'] },
  { name: 'Google AI', billingModels: ['token', 'plan'] },
  { name: 'Anthropic', billingModels: ['plan', 'token'] }
]

const selectedProvider = ref('')
const selectedBillingModel = ref('')
const apiKey = ref('')
const showApiKey = ref(false)
const saving = ref(false)
const error = ref('')
const success = ref(false)

// 根据选中的供应商筛选可用计费模式
const availableBillingModels = computed(() => {
  const p = PROVIDERS.find(p => p.name === selectedProvider.value)
  return p ? p.billingModels : []
})

// 选中供应商时重置计费模式
function onProviderChange() {
  selectedBillingModel.value = ''
  error.value = ''
}

// 提交保存
async function handleSave() {
  error.value = ''
  success.value = false

  // 前端校验
  if (!selectedProvider.value) {
    error.value = '请选择供应商'
    return
  }
  if (!selectedBillingModel.value) {
    error.value = '请选择计费模式'
    return
  }
  if (!apiKey.value.trim()) {
    error.value = '请输入 API 密钥'
    return
  }

  saving.value = true
  try {
    if (window.electronAPI?.saveVendor) {
      const result = await window.electronAPI.saveVendor({
        provider: selectedProvider.value,
        billingModel: selectedBillingModel.value,
        apiKey: apiKey.value
      })
      if (result.success) {
        success.value = true
        setTimeout(() => {
          emit('saved', result.vendor)
        }, 800)
      }
    } else {
      // 浏览器开发环境降级
      success.value = true
      setTimeout(() => {
        emit('saved', {
          id: Date.now().toString(36),
          provider: selectedProvider.value,
          billingModel: selectedBillingModel.value,
          apiKey: apiKey.value.trim(),
          createdAt: new Date().toISOString()
        })
      }, 800)
    }
  } catch (e) {
    error.value = e.message || '保存失败，请重试'
  } finally {
    saving.value = false
  }
}

function handleOverlayClick(e) {
  if (e.target === e.currentTarget) emit('close')
}
</script>

<template>
  <div class="modal-overlay" @click="handleOverlayClick">
    <div class="modal-dialog">
      <!-- 头部 -->
      <div class="modal-header">
        <h3 class="modal-title">添加供应商</h3>
        <button class="modal-close" @click="$emit('close')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <!-- 成功提示 -->
      <div v-if="success" class="success-banner">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
        供应商已添加成功
      </div>

      <!-- 表单 -->
      <div class="modal-body" v-if="!success">
        <!-- 供应商选择 -->
        <div class="form-group">
          <label class="form-label">供应商</label>
          <select v-model="selectedProvider" class="form-select" @change="onProviderChange">
            <option value="" disabled>请选择供应商</option>
            <option v-for="p in PROVIDERS" :key="p.name" :value="p.name">{{ p.name }}</option>
          </select>
        </div>

        <!-- 计费模式选择 -->
        <div class="form-group">
          <label class="form-label">计费模式</label>
          <select
            v-model="selectedBillingModel"
            class="form-select"
            :disabled="!selectedProvider || !availableBillingModels.length"
          >
            <option value="" disabled>请选择计费模式</option>
            <option
              v-for="bm in availableBillingModels"
              :key="bm"
              :value="bm"
            >{{ bm === 'plan' ? 'Plan（订阅制）' : 'Token（按量计费）' }}</option>
          </select>
          <p v-if="selectedProvider && !availableBillingModels.length" class="form-hint">
            该供应商暂无可用的计费模式
          </p>
        </div>

        <!-- API 密钥输入 -->
        <div class="form-group">
          <label class="form-label">API 密钥</label>
          <div class="password-wrapper">
            <input
              v-model="apiKey"
              :type="showApiKey ? 'text' : 'password'"
              class="form-input"
              placeholder="输入 API 密钥"
              autocomplete="off"
            />
            <button
              class="toggle-pwd"
              @click="showApiKey = !showApiKey"
              :title="showApiKey ? '隐藏' : '显示'"
              type="button"
            >
              <svg v-if="!showApiKey" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
              </svg>
              <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>
              </svg>
            </button>
          </div>
        </div>

        <!-- 错误提示 -->
        <p v-if="error" class="form-error">{{ error }}</p>
      </div>

      <!-- 底部按钮 -->
      <div class="modal-footer">
        <button class="btn btn-cancel" @click="$emit('close')" :disabled="saving">
          取消
        </button>
        <button
          v-if="!success"
          class="btn btn-primary"
          @click="handleSave"
          :disabled="saving"
        >
          <span v-if="saving" class="btn-spinner"></span>
          {{ saving ? '保存中...' : '确认添加' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Overlay */
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(2px);
}

/* Dialog */
.modal-dialog {
  background: white;
  border-radius: 14px;
  width: 440px;
  max-width: calc(100vw - 2rem);
  box-shadow: 0 25px 60px rgba(0,0,0,0.15);
  overflow: hidden;
  animation: modal-in 0.2s ease;
}

@keyframes modal-in {
  from { opacity: 0; transform: translateY(12px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

/* Header */
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.25rem 1.5rem 0;
}

.modal-title {
  font-size: 1.05rem;
  font-weight: 700;
  color: #1e293b;
  margin: 0;
}

.modal-close {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
  border-radius: 6px;
  transition: background 0.15s;
}

.modal-close:hover {
  background: #f1f5f9;
  color: #475569;
}

/* Success banner */
.success-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 1rem 1.5rem 0;
  padding: 0.75rem 1rem;
  background: #f0fdf4;
  color: #16a34a;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 500;
}

/* Body */
.modal-body {
  padding: 1.25rem 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

/* Form group */
.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.form-label {
  font-size: 0.8125rem;
  font-weight: 600;
  color: #334155;
}

.form-select,
.form-input {
  padding: 0.55rem 0.75rem;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  font-size: 0.875rem;
  color: #1e293b;
  background: white;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.form-select:focus,
.form-input:focus {
  border-color: #4675ED;
  box-shadow: 0 0 0 3px rgba(70,117,237,.1);
}

.form-select:disabled {
  background: #f8fafc;
  color: #94a3b8;
  cursor: not-allowed;
}

.form-hint {
  font-size: 0.75rem;
  color: #f59e0b;
  margin: 0;
}

/* Password input wrapper */
.password-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}

.password-wrapper .form-input {
  flex: 1;
  padding-right: 2.5rem;
}

.toggle-pwd {
  position: absolute;
  right: 0.5rem;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
  border-radius: 4px;
  transition: color 0.15s;
}

.toggle-pwd:hover {
  color: #475569;
}

/* Error */
.form-error {
  font-size: 0.8125rem;
  color: #dc2626;
  margin: 0;
  padding: 0.5rem 0.75rem;
  background: #fef2f2;
  border-radius: 6px;
}

/* Footer */
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  padding: 0 1.5rem 1.25rem;
}

.btn {
  padding: 0.5rem 1.25rem;
  border-radius: 8px;
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.2s;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.btn-cancel {
  background: white;
  color: #64748b;
  border-color: #e2e8f0;
}

.btn-cancel:hover {
  background: #f8fafc;
  border-color: #cbd5e1;
}

.btn-primary {
  background: #4675ED;
  color: white;
}

.btn-primary:hover {
  background: #3b5fd9;
  box-shadow: 0 4px 12px rgba(70,117,237,.25);
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255,255,255,0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
