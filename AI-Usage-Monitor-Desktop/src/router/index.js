import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    redirect: '/workbench'
  },
  {
    path: '/workbench',
    name: 'workbench',
    component: () => import('../components/pages/WorkbenchPage.vue')
  },
  {
    path: '/projects',
    name: 'projects',
    component: () => import('../components/pages/ProjectsPage.vue')
  },
  {
    path: '/progress',
    name: 'progress',
    component: () => import('../components/pages/ProgressPage.vue')
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('../components/pages/SettingsPage.vue')
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

export default router