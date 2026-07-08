import { createRouter, createWebHashHistory } from 'vue-router';

const routes = [
  { path: '/', redirect: '/dashboard' },
  { path: '/dashboard', component: () => import('../views/Dashboard.vue') },
  { path: '/collection', component: () => import('../views/CollectionBox.vue') },
  { path: '/products', component: () => import('../views/ProductList.vue') },
  { path: '/orders', component: () => import('../views/OrderList.vue') },
  { path: '/analytics', component: () => import('../views/CategoryAnalysis.vue') },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

export default router;
