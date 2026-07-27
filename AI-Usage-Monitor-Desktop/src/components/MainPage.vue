<template>
  <div class="main-container">
    <!-- 顶部栏 -->
    <header class="top-bar">
      <div class="top-bar-left">
        <img src="/logo.png" alt="Logo" class="logo-img" />
      </div>
      <div class="draggable-region"></div>
      <div class="window-controls-container">
        <button class="window-btn" @click="minimizeWindow" title="最小化">
          <svg width="14" height="14" viewBox="0 0 12 12"><rect x="2" y="5.5" width="8" height="1" fill="currentColor"/></svg>
        </button>
        <button class="window-btn" @click="maximizeRestoreWindow" title="最大化">
          <svg v-if="!isMaximized" width="14" height="14" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1"/></svg>
          <svg v-else width="14" height="14" viewBox="0 0 12 12"><rect x="3" y="1" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1"/><rect x="1" y="3" width="8" height="8" fill="white" stroke="currentColor" stroke-width="1"/></svg>
        </button>
        <button class="window-btn window-btn-close" @click="closeWindow" title="关闭">
          <svg width="14" height="14" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>
        </button>
      </div>
    </header>

    <!-- 主体布局 -->
    <div class="layout-container">
      <!-- 侧边栏 -->
      <aside
        class="sidebar"
        :class="sidebarExpanded ? 'expanded' : 'collapsed'"
        @mouseenter="startExpandTimer"
        @mouseleave="cancelExpandTimer"
        @transitionend="handleSidebarTransitionEnd"
      >
        <div class="sidebar-content">
          <nav class="main-navigation">
            <!-- 展开状态 -->
            <div class="nav-menu nav-expanded" v-show="sidebarExpanded">
              <router-link class="nav-item" :to="{name: 'workbench'}" active-class="active-nav-item">
                <svg class="nav-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                <span class="nav-text">工作台</span>
              </router-link>
              <router-link class="nav-item" :to="{name: 'projects'}" active-class="active-nav-item">
                <svg class="nav-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                <span class="nav-text">项目</span>
              </router-link>
              <router-link class="nav-item" :to="{name: 'progress'}" active-class="active-nav-item">
                <svg class="nav-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
                <span class="nav-text">渲染进度</span>
              </router-link>
              <router-link class="nav-item" :to="{name: 'settings'}" active-class="active-nav-item">
                <svg class="nav-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                <span class="nav-text">设置</span>
              </router-link>
            </div>

            <!-- 收起状态 -->
            <div class="nav-menu nav-collapsed" v-show="!sidebarExpanded">
              <router-link class="nav-item-collapsed" :to="{name: 'workbench'}" active-class="active-nav-item">
                <svg class="nav-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
              </router-link>
              <router-link class="nav-item-collapsed" :to="{name: 'projects'}" active-class="active-nav-item">
                <svg class="nav-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              </router-link>
              <router-link class="nav-item-collapsed" :to="{name: 'progress'}" active-class="active-nav-item">
                <svg class="nav-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
              </router-link>
              <router-link class="nav-item-collapsed" :to="{name: 'settings'}" active-class="active-nav-item">
                <svg class="nav-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              </router-link>
            </div>
          </nav>
        </div>
      </aside>

      <!-- 主内容区 -->
      <main class="main-content-area" :class="sidebarExpanded ? 'sidebar-expanded' : 'sidebar-collapsed'">
        <!-- 内容区域 -->
        <div class="content-body">
          <router-view />
        </div>
      </main>
    </div>
  </div>
</template>

<script>
import { RouterView, RouterLink } from 'vue-router'

export default {
  name: 'MainPage',
  components: { RouterView, RouterLink },
  data() {
    return {
      sidebarExpanded: false,
      expandTimer: null,
      isMaximized: false
    }
  },
  computed: {
    pageTitle() {
      const routeTitles = {
        'workbench': '系统概览',
        'projects': '项目管理中心',
        'progress': '渲染任务调度',
        'settings': '系统设置'
      }
      return routeTitles[this.$route.name] || '系统概览'
    }
  },
  methods: {
    startExpandTimer() {
      if (this.expandTimer) clearTimeout(this.expandTimer)
      this.expandTimer = setTimeout(() => {
        this.sidebarExpanded = true
      }, 1000)
    },
    cancelExpandTimer() {
      if (this.expandTimer) {
        clearTimeout(this.expandTimer)
        this.expandTimer = null
      }
      this.sidebarExpanded = false
    },
    handleSidebarTransitionEnd() {
      // 侧边栏过渡动画结束时，向子路由组件派发通知事件，让其重绘图表
      window.dispatchEvent(new Event('sidebar-toggle-resize'))
    },
    minimizeWindow() {
      if (window.electronAPI) window.electronAPI.minimize()
    },
    maximizeRestoreWindow() {
      if (window.electronAPI) {
        if (this.isMaximized) {
          window.electronAPI.maximize?.()
          this.isMaximized = false
        } else {
          window.electronAPI.maximize?.()
          this.isMaximized = true
        }
      }
    },
    closeWindow() {
      if (window.electronAPI) window.electronAPI.close()
    }
  }
}
</script>

<style scoped>
.main-container {
  background-color: #f8fafc;
  font-family: ui-sans-serif, system-ui, sans-serif;
  color: #0f172a;
  height: 100vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
}

.layout-container {
  display: flex;
  flex: 1;
  overflow: hidden;
  margin: 0;
  padding: 0;
}

/* 顶部栏 */
.top-bar {
  position: relative;
  height: 4rem;
  flex-shrink: 0;
  background-color: white;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.top-bar-left {
  display: flex;
  align-items: center;
  height: 100%;
  padding-left: 1.4rem;
  margin-top: 0.5rem;
  -webkit-app-region: no-drag;
}

.logo-img {
  height: 1.3rem;
  width: auto;
}

.draggable-region {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  -webkit-app-region: drag;
  pointer-events: none;
}

.window-controls-container {
  margin: 0.5rem 1.25rem 0.5rem 0.5rem;
  display: flex;
  align-items: center;
  -webkit-app-region: no-drag;
  gap: 2px;
}

.window-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 28px;
  border: none;
  background: transparent;
  color: #64748b;
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.15s;
  will-change: transform;
  backface-visibility: hidden;
}

.window-btn:hover {
  background: rgba(0, 0, 0, 0.06);
}

.window-btn-close:hover {
  background: #e81123;
  color: #fff;
}

/* 侧边栏 */
.sidebar {
  position: fixed;
  left: 0;
  top: 4rem;
  height: calc(100vh - 4rem);
  background-color: white;
  border-right: 1px solid #e2e8f0;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 0.5rem;
  z-index: 30;
  transition: all 0.3s ease;
  min-width: 3.5rem;
}

.sidebar.expanded {
  width: 10rem;
}

.sidebar.collapsed {
  width: 4rem;
  min-width: 4rem;
}

.sidebar-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
  width: 100%;
}

.main-navigation {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  padding: 0 1rem;
  margin-top: 1rem;
}

.nav-menu {
  width: 100%;
}

.nav-expanded .nav-item {
  display: flex;
  align-items: center;
  position: relative;
  margin-bottom: 1rem;
  width: 100%;
  padding: 0.5rem 0;
  min-height: 2.5rem;
  justify-content: flex-start;
  padding-left: 1.45rem;
  text-decoration: none;
  color: #64748b;
  transition: color 0.2s;
}

.nav-collapsed .nav-item-collapsed {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  position: relative;
  margin-bottom: 1rem;
  width: 100%;
  padding: 0.5rem 0;
  min-height: 2.5rem;
  padding-left: 1.45rem;
  text-decoration: none;
  color: #94a3b8;
  transition: color 0.2s;
}

.nav-item:hover,
.nav-item-collapsed:hover {
  color: #9333ea;
}

.nav-text {
  margin-left: 0.75rem;
  font-weight: 500;
  font-size: 0.9rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nav-icon {
  flex-shrink: 0;
}

/* 主内容区 */
.main-content-area {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  transition: margin-left 0.3s ease;
  margin-left: 3.5rem;
  border-top: 1px solid #e2e8f0;
  border-left: 1px solid #e2e8f0;
}

.main-content-area.sidebar-expanded {
  margin-left: 10rem;
}

/* 内容主体 */
.content-body {
  flex: 1;
  overflow: auto;
  position: relative;
  padding: 1.5rem;
}

/* 激活状态 */
.nav-item.active-nav-item,
.nav-item-collapsed.active-nav-item {
  color: #9333ea;
}

.active-nav-item .nav-icon {
  color: #9333ea;
}

/* 动画 */
@keyframes pulse-soft {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

/* 滚动条隐藏 */
.main-container::-webkit-scrollbar,
.content-body::-webkit-scrollbar,
.sidebar::-webkit-scrollbar {
  display: none;
}
</style>