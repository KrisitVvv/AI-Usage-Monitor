<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

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
const showChangelog = ref(false)

// 检查更新状态
const appVersion = ref('')
const checkingUpdate = ref(false)
const updateResult = ref(null) // { hasUpdate, latestVersion, downloadUrl, assetUrl, installType, ... }
const updateError = ref('')
// 自动更新状态（安装版）
const installType = ref('') // 'installer' | 'portable'
const downloading = ref(false)
const installing = ref(false)
const downloadError = ref('')
const downloadProgress = ref(0) // 0-100
const downloadReceived = ref(0) // 已下载字节
const downloadTotal = ref(0) // 总字节（可能为 0）
let offDownloadProgress = null // 下载进度事件取消订阅函数

// 缓存管理状态
const cacheSize = ref(0)
const clearingCache = ref(false)

// 数据备份与恢复状态
const showBackupModal = ref(false)
const backing = ref(false)
// 导入前确认弹窗
const showImportConfirm = ref(false)
// 导入/导出结果弹窗
const showDataResultModal = ref(false)
const dataResultType = ref('success')
const dataResultTitle = ref('')
const dataResultMessage = ref('')

// 展示操作结果弹窗（替代框体下方的内联提示）
function showDataResult(type, title, message) {
  dataResultType.value = type
  dataResultTitle.value = title
  dataResultMessage.value = message
  showDataResultModal.value = true
}

async function handleBackup(action) {
  if (!window.electronAPI || backing.value) return
  showBackupModal.value = false
  backing.value = true
  try {
    const result = await window.electronAPI.backupData(action)
    if (result.success) {
      if (action === 'export') {
        showDataResult('success', '导出成功', '数据备份导出成功，文件已保存到所选位置。')
      } else {
        const count = result.imported ? result.imported.length : 0
        showDataResult('success', '导入成功', `数据导入成功，已恢复 ${count} 个文件。备份已完全覆盖本地数据，请刷新页面或重启应用以生效。`)
      }
    } else if (result.error !== '用户取消') {
      showDataResult('error', action === 'export' ? '导出失败' : '导入失败', result.error)
    }
  } catch (e) {
    showDataResult('error', '操作失败', e.message || '未知错误')
  }
  backing.value = false
}

// 点击"导入恢复"：先弹出确认提醒（将完全覆盖本地数据，不可恢复）
function onImportClick() {
  showBackupModal.value = false
  showImportConfirm.value = true
}

function confirmImport() {
  showImportConfirm.value = false
  handleBackup('import')
}

// 更新日志（从 GitHub 获取）
const changelog = ref([]) // 当前显示的日志（默认仅本版本）
const allChangelog = ref([]) // 本版本及以下全部历史日志
const changelogExpanded = ref(false) // 是否展开显示全部历史日志
const changelogLoading = ref(false)
const changelogError = ref('')

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
    a: '本软件采用的是API和爬虫技术实现，若存在session失效、多设备使用以及未开本软件使用，均会出现部分数据误差，但不影响正常余量监控。本软件由于技术原因建议服务器不停机运行。'
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
    try {
      installType.value = await window.electronAPI.getInstallType()
    } catch (e) {
      installType.value = ''
    }
    // 订阅下载进度
    offDownloadProgress = window.electronAPI.onUpdateDownloadProgress((data) => {
      if (!data) return
      downloadReceived.value = data.received || 0
      downloadTotal.value = data.total || 0
      if (typeof data.percent === 'number') {
        downloadProgress.value = data.percent
      }
    })
    await loadCacheSize()
  }
  loading.value = false
})

onUnmounted(() => {
  if (offDownloadProgress) offDownloadProgress()
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
      // 有更新时获取累计更新日志
      if (result.hasUpdate) {
        try {
          const cl = await window.electronAPI.getChangelog()
          if (cl.success && cl.list.length > 0) {
            // 筛选：仅展示版本号高于本地当前版本的更新日志
            updateResult.value = {
              ...result,
              changelog: filterChangelogByVersion(cl.list, appVersion.value, result.latestVersion)
            }
          }
        } catch { /* 日志非关键，忽略 */ }
      }
    } else {
      updateError.value = result.error || '检查失败'
    }
  } catch (e) {
    updateError.value = '检查更新失败: ' + (e.message || '未知错误')
  }
  checkingUpdate.value = false
}

// ===== 语义化版本比较工具 =====

// 解析版本号：支持 "v1.2.3" / "1.2.3" / "1.2.3-beta.1" / "1.2.3+build.5"
function parseVersion(version) {
  const str = String(version || '').trim().replace(/^v/i, '')
  const match = str.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/)
  if (!match) return null
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || ''
  }
}

// 比较预发布标识（semver 规则：正式版 > 预发布；alpha < beta < rc）
function comparePrerelease(a, b) {
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const sa = pa[i]
    const sb = pb[i]
    if (sa === undefined) return -1
    if (sb === undefined) return 1
    if (sa === sb) continue
    const na = parseInt(sa, 10)
    const nb = parseInt(sb, 10)
    const isNa = /^\d+$/.test(sa)
    const isNb = /^\d+$/.test(sb)
    if (isNa && isNb) return na > nb ? 1 : -1
    if (isNa) return -1  // 数字标识 < 字母标识
    if (isNb) return 1
    return sa > sb ? 1 : -1
  }
  return 0
}

// 语义化版本比较：v1 > v2 返回 1，v1 < v2 返回 -1，相等返回 0
function compareVersions(v1, v2) {
  const a = parseVersion(v1)
  const b = parseVersion(v2)
  if (!a || !b) return String(v1).localeCompare(String(v2)) // 解析失败兜底
  if (a.major !== b.major) return a.major > b.major ? 1 : -1
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1
  return comparePrerelease(a.prerelease, b.prerelease)
}

// v1 是否高于 v2
function isNewerThan(v1, v2) {
  return compareVersions(v1, v2) > 0
}

// 筛选更新日志：版本高于当前本地版本、且不高于最新版本
function filterChangelogByVersion(list, currentVersion, latestVersion) {
  return list.filter(e => isNewerThan(e.version, currentVersion) && compareVersions(e.version, latestVersion) <= 0)
}

// 打开下载页面 / 自动下载安装
async function openDownloadPage() {
  const result = updateResult.value
  if (!result || !window.electronAPI) return

  // 下载失败后，按钮降级为打开 GitHub 下载页
  if (downloadError.value) {
    if (result.downloadUrl) {
      await window.electronAPI.openExternal(result.downloadUrl)
    }
    closeUpdateResult()
    return
  }

  // 免安装版：打开 GitHub 下载页手动下载
  if (result.installType !== 'installer' || !result.assetUrl) {
    if (result.downloadUrl) {
      await window.electronAPI.openExternal(result.downloadUrl)
    }
    closeUpdateResult()
    return
  }

  // 安装版：自动下载并启动安装程序
  downloadError.value = ''
  downloading.value = true
  downloadProgress.value = 0
  downloadReceived.value = 0
  downloadTotal.value = 0
  try {
    const dl = await window.electronAPI.downloadUpdate(result.assetUrl)
    if (!dl.success) {
      downloadError.value = dl.error || '下载失败'
      downloading.value = false
      return
    }
    downloadProgress.value = 100
    downloading.value = false
    // 启动安装程序
    installing.value = true
    const inst = await window.electronAPI.installUpdate(dl.filePath)
    if (!inst.success) {
      downloadError.value = inst.error || '启动安装失败'
      installing.value = false
    }
    // 安装程序已启动，应用即将退出，无需关闭弹窗
  } catch (e) {
    downloadError.value = '下载失败: ' + (e.message || '未知错误')
    downloading.value = false
    installing.value = false
  }
}

function closeUpdateResult() {
  updateResult.value = null
  updateError.value = ''
  downloadError.value = ''
  downloadProgress.value = 0
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

// 打开更新日志弹窗并加载数据
async function openChangelog() {
  showChangelog.value = true
  if (changelog.value.length > 0 || allChangelog.value.length > 0) return // 已有缓存
  if (!window.electronAPI) return
  changelogLoading.value = true
  changelogError.value = ''
  try {
    const result = await window.electronAPI.getChangelog()
    if (result.success) {
      // 本版本及以下（<= 当前版本）的全部历史日志
      allChangelog.value = result.list.filter(e => compareVersions(appVersion.value, e.version) >= 0)
      // 默认仅显示本版本
      const current = allChangelog.value.find(e => e.version === appVersion.value)
      changelog.value = current ? [current] : []
      changelogExpanded.value = false
      if (changelog.value.length === 0) {
        changelogError.value = '未找到当前版本的更新日志'
      }
    } else {
      changelogError.value = result.error || '获取失败'
    }
  } catch (e) {
    changelogError.value = e.message || '获取失败'
  }
  changelogLoading.value = false
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

      <!-- 数据管理 -->
      <h2 class="settings-title update-title">数据管理</h2>
      <div class="settings-card">
        <div class="setting-item feedback-card" @click="showBackupModal = true">
          <div class="setting-info">
            <span class="setting-label">数据备份与恢复</span>
            <span class="setting-desc">导出或导入配置、供应商信息和 Token 使用记录，用于跨设备迁移</span>
          </div>
          <svg class="feedback-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </div>
      </div>

      <!-- 检测与更新 -->
      <h2 class="settings-title update-title">检测与更新</h2>
      <div class="settings-card">
        <div class="setting-item">
          <div class="setting-info">
            <span class="setting-label">当前版本</span>
            <span class="setting-desc">
              v{{ appVersion || '未知' }}
              <button class="changelog-btn" @click.stop="openChangelog" title="查看更新日志">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="16" y1="13" x2="8" y2="13"/>
                  <line x1="16" y1="17" x2="8" y2="17"/>
                  <polyline points="10 9 9 9 8 9"/>
                </svg>
              </button>
            </span>
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

<!-- 结果在内联区域移除，改为下方弹窗展示 -->

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
    <div v-if="showFeedbackModal" class="modal-overlay">
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

  <!-- 更新日志弹窗 -->
  <Teleport to="body">
    <div v-if="showChangelog" class="modal-overlay">
      <div class="changelog-modal">
        <div class="changelog-header">
          <span>更新日志</span>
          <button class="modal-close-btn" @click="showChangelog = false">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="changelog-list">
          <div v-if="changelogLoading" class="changelog-loading">
            <svg class="spinning" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
            <span>加载中...</span>
          </div>
          <div v-else-if="changelogError" class="changelog-error">
            <span>获取更新日志失败：{{ changelogError }}</span>
          </div>
          <!-- 只要存在日志数据就渲染列表（与是否报错无关） -->
          <template v-if="!changelogLoading && (changelog.length > 0 || allChangelog.length > 0)">
            <div v-for="(entry, idx) in (changelogExpanded ? allChangelog : changelog)" :key="idx" class="changelog-entry">
              <div class="changelog-version-row">
                <span class="changelog-version">v{{ entry.version }}</span>
                <span class="changelog-date">{{ entry.date }}</span>
                <span v-if="entry.version === appVersion" class="changelog-current-tag">当前版本</span>
              </div>
              <ul class="changelog-changes">
                <li v-for="(change, ci) in entry.changes" :key="ci">{{ change }}</li>
              </ul>
            </div>
          </template>
          <div v-else-if="!changelogLoading && !changelogError && changelog.length === 0" class="changelog-empty">
            <span>暂无更新日志</span>
          </div>
        </div>
        <!-- 固定底部的"更多日志"箭头，不随列表滚动 -->
        <button v-if="!changelogLoading && allChangelog.length > 1" class="changelog-more-btn" @click="changelogExpanded = !changelogExpanded" :title="changelogExpanded ? '收起' : '查看更多历史版本'">
          <svg :class="{ 'changelog-arrow-up': changelogExpanded }" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
      </div>
    </div>
  </Teleport>

  <!-- 更新结果弹窗 -->
  <Teleport to="body">
    <div v-if="updateResult || updateError" class="modal-overlay">
      <div class="update-result-modal">
        <div class="update-modal-header">
          <span>检查更新</span>
          <button class="modal-close-btn" @click="closeUpdateResult">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <template v-if="updateError">
          <div class="update-modal-icon error">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
          </div>
          <p class="update-modal-error">{{ updateError }}</p>
          <button class="update-modal-btn secondary" @click="closeUpdateResult">关闭</button>
        </template>

        <template v-else-if="updateResult && updateResult.hasUpdate">
          <div class="update-modal-icon new">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
          </div>
          <div class="update-modal-badge new">发现新版本 v{{ updateResult.latestVersion }}</div>
          <div v-if="updateResult.changelog && updateResult.changelog.length > 0" class="update-modal-notes">
            <div v-for="(entry, idx) in updateResult.changelog" :key="idx">
              <div v-for="(change, ci) in entry.changes" :key="ci" class="update-modal-cl-line">• {{ change }}</div>
            </div>
          </div>
          <p v-else-if="updateResult.releaseNotes" class="update-modal-notes">{{ updateResult.releaseNotes }}</p>
          <!-- 下载进度 -->
          <div v-if="downloading" class="update-download-box">
            <div class="update-download-bar">
              <div class="update-download-fill" :style="{ width: downloadProgress + '%' }"></div>
            </div>
            <span class="update-download-text">
              <template v-if="downloadTotal > 0">正在下载安装包 {{ downloadProgress }}%（{{ formatSize(downloadReceived) }} / {{ formatSize(downloadTotal) }}）</template>
              <template v-else>正在下载安装包... 已下载 {{ formatSize(downloadReceived) }}</template>
            </span>
          </div>
          <div v-else-if="installing" class="update-download-box">
            <svg class="spinning" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
            <span class="update-download-text">正在启动安装程序，应用即将退出...</span>
          </div>
          <p v-if="downloadError" class="update-modal-error">{{ downloadError }}</p>
          <div v-if="!downloading && !installing" class="update-modal-actions">
            <button class="update-modal-btn secondary" @click="closeUpdateResult">稍后再说</button>
            <button class="update-modal-btn primary" @click="openDownloadPage">
              {{ downloadError ? '前往下载页' : (updateResult.installType === 'installer' ? '下载并安装' : '前往下载') }}
            </button>
          </div>
        </template>

        <template v-else-if="updateResult">
          <div class="update-modal-icon latest">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
          </div>
          <div class="update-modal-badge latest">已是最新版本</div>
          <p class="update-modal-desc">当前版本 v{{ appVersion }} 已是最新</p>
          <button class="update-modal-btn primary" @click="closeUpdateResult">确定</button>
        </template>
      </div>
    </div>
  </Teleport>

  <!-- 数据备份与恢复弹窗 -->
  <Teleport to="body">
    <div v-if="showBackupModal" class="modal-overlay" @click.self="showBackupModal = false">
      <div class="backup-modal">
        <div class="feedback-modal-header">
          <span>数据备份与恢复</span>
          <button class="modal-close-btn" @click="showBackupModal = false">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <p class="feedback-modal-desc">选择你需要的操作：</p>
        <div class="feedback-options">
          <div class="feedback-option" @click="handleBackup('export')">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <div class="feedback-option-info">
              <span class="feedback-option-title">导出备份</span>
              <span class="feedback-option-desc">将当前配置和历史数据导出为加密备份文件</span>
            </div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </div>
          <div class="feedback-option" @click="onImportClick">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <div class="feedback-option-info">
              <span class="feedback-option-title">导入恢复</span>
              <span class="feedback-option-desc">从备份文件恢复配置和历史数据（将覆盖本地所有数据）</span>
            </div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </div>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 导入确认弹窗 -->
  <Teleport to="body">
    <div v-if="showImportConfirm" class="modal-overlay" @click.self="showImportConfirm = false">
      <div class="import-confirm-modal">
        <div class="feedback-modal-header">
          <span>导入确认</span>
          <button class="modal-close-btn" @click="showImportConfirm = false">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="import-confirm-icon">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </div>
        <p class="import-confirm-text">
          导入备份将<strong>完全覆盖</strong>本地所有数据（配置、供应商信息、Token 使用记录），
          此操作<strong>不可恢复</strong>。是否继续？
        </p>
        <div class="import-confirm-actions">
          <button class="update-modal-btn secondary" @click="showImportConfirm = false">取消</button>
          <button class="update-modal-btn primary" @click="confirmImport">继续导入</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 导入/导出结果弹窗 -->
  <Teleport to="body">
    <div v-if="showDataResultModal" class="modal-overlay">
      <div class="update-result-modal">
        <div class="update-modal-header">
          <span>{{ dataResultTitle }}</span>
          <button class="modal-close-btn" @click="showDataResultModal = false">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="update-modal-icon" :class="dataResultType">
          <svg v-if="dataResultType === 'success'" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
          <svg v-else width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
        </div>
        <p class="update-modal-desc">{{ dataResultMessage }}</p>
        <button class="update-modal-btn primary" @click="showDataResultModal = false">确定</button>
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

/* 备份弹窗 */
.backup-modal {
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

/* 导入确认弹窗 */
.import-confirm-modal {
  background: white;
  border-radius: 14px;
  padding: 1.5rem;
  max-width: 400px;
  width: 100%;
  box-shadow: 0 20px 60px rgba(0,0,0,0.15);
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.import-confirm-icon {
  display: flex;
  align-items: center;
  justify-content: center;
}
.import-confirm-text {
  margin: 0;
  font-size: 0.85rem;
  color: #475569;
  line-height: 1.7;
  text-align: center;
}
.import-confirm-text strong {
  color: #b91c1c;
}
.import-confirm-actions {
  display: flex;
  gap: 0.5rem;
}
.import-confirm-actions .update-modal-btn {
  flex: 1;
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

/* 更新日志按钮 */
.changelog-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  border-radius: 4px;
  color: #94a3b8;
  cursor: pointer;
  vertical-align: middle;
  margin-left: 4px;
  padding: 0;
  transition: all 0.15s;
}
.changelog-btn:hover {
  background: #f1f5f9;
  color: #467CFE;
}

/* 更新日志弹窗 */
.changelog-modal {
  background: white;
  border-radius: 14px;
  padding: 1.5rem;
  max-width: 460px;
  width: 100%;
  /* 控制弹窗最大尺寸：不超过视口高度 65%，且不超过 560px，防止日志过多窗口过大 */
  max-height: min(65vh, 560px);
  box-shadow: 0 20px 60px rgba(0,0,0,0.15);
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.changelog-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 1rem;
  font-weight: 600;
  color: #1e293b;
}
.changelog-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 0.25rem;
}
.changelog-entry {
  padding-bottom: 1rem;
  margin-bottom: 1rem;
  border-bottom: 1px solid #f1f5f9;
}
.changelog-entry:last-child {
  border-bottom: none;
  margin-bottom: 0;
  padding-bottom: 0;
}
.changelog-version-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.5rem;
}
.changelog-version {
  font-size: 0.9375rem;
  font-weight: 700;
  color: #1e293b;
}
.changelog-current-tag {
  font-size: 0.6875rem;
  font-weight: 600;
  color: #467CFE;
  background: #eef4ff;
  border-radius: 999px;
  padding: 0.1rem 0.5rem;
}
.changelog-more-btn {
  flex-shrink: 0;
  width: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 0.25rem 0 0;
  border: none;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
  transition: color 0.2s ease;
}
.changelog-more-btn:hover {
  color: #467CFE;
}
.changelog-more-btn svg {
  transition: transform 0.25s ease;
}
.changelog-more-btn svg.changelog-arrow-up {
  transform: rotate(180deg);
}
.changelog-date {
  font-size: 0.75rem;
  color: #94a3b8;
}
.changelog-changes {
  margin: 0;
  padding-left: 1.25rem;
  list-style: none;
}
.changelog-changes li {
  position: relative;
  font-size: 0.8125rem;
  color: #475569;
  line-height: 1.7;
  padding-left: 0.5rem;
}
.changelog-changes li::before {
  content: '';
  position: absolute;
  left: -0.75rem;
  top: 0.55em;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #cbd5e1;
}

.changelog-loading,
.changelog-error,
.changelog-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 2rem 0;
  font-size: 0.8125rem;
  color: #94a3b8;
}
.changelog-error {
  color: #b91c1c;
}

/* ====== 更新结果弹窗 ====== */
.update-result-modal {
  background: white;
  border-radius: 14px;
  padding: 1.5rem 2rem;
  max-width: 400px;
  width: 100%;
  box-shadow: 0 20px 60px rgba(0,0,0,0.15);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  text-align: center;
}
.update-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  font-size: 1rem;
  font-weight: 600;
  color: #1e293b;
}
.update-modal-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 0.25rem;
}
.update-modal-badge {
  display: inline-flex;
  padding: 0.35rem 0.85rem;
  border-radius: 6px;
  font-size: 0.875rem;
  font-weight: 600;
}
.update-modal-badge.new {
  background: #fef3c7;
  color: #92400e;
}
.update-modal-badge.latest {
  background: #d1fae5;
  color: #065f46;
}
.update-modal-notes {
  margin: 0;
  font-size: 0.8rem;
  color: #64748b;
  line-height: 1.7;
  width: 100%;
  text-align: left;
}
.update-modal-cl-line {
  padding: 0.1rem 0;
  font-size: 0.8rem;
  color: #475569;
}
.update-modal-desc {
  margin: 0;
  font-size: 0.85rem;
  color: #64748b;
}
.update-modal-error {
  margin: 0;
  font-size: 0.85rem;
  color: #b91c1c;
}

/* 下载进度条 */
.update-download-box {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.45rem;
  padding: 0.25rem 0;
}
.update-download-bar {
  width: 100%;
  height: 8px;
  border-radius: 4px;
  background: #e2e8f0;
  overflow: hidden;
}
.update-download-fill {
  height: 100%;
  border-radius: 4px;
  background: linear-gradient(90deg, #467CFE, #7aa2ff);
  transition: width 0.2s ease;
}
.update-download-text {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.78rem;
  color: #64748b;
}
.update-modal-actions {
  display: flex;
  gap: 0.5rem;
  width: 100%;
  margin-top: 0.25rem;
}
.update-modal-btn {
  flex: 1;
  padding: 0.55rem 1rem;
  border-radius: 8px;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  border: none;
}
.update-modal-btn.primary {
  background: #467CFE;
  color: white;
}
.update-modal-btn.primary:hover {
  background: #3563d9;
}
.update-modal-btn.secondary {
  background: #f1f5f9;
  color: #475569;
  border: 1px solid #e2e8f0;
}
.update-modal-btn.secondary:hover {
  background: #e2e8f0;
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
