import { createRouter, createWebHashHistory } from 'vue-router'

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
    path: '/progress',
    name: 'progress',
    component: () => import('../components/pages/ProgressPage.vue')
  },
  {
    path: '/progress/:id',
    name: 'model-detail',
    component: () => import('../components/pages/ModelDetailPage.vue')
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('../components/pages/SettingsPage.vue')
  }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

export default router