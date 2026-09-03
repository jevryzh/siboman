import { createRouter, createWebHashHistory } from 'vue-router';

const routes = [
  { path: '/', redirect: '/dashboard' },
  { path: '/dashboard', component: () => import('../views/Dashboard.vue') },
  { path: '/collection', component: () => import('../views/CollectionBox.vue') },
  { path: '/products', component: () => import('../views/ProductList.vue') },
  { path: '/yandex-products', component: () => import('../views/ProductList.vue') },
  { path: '/orders', component: () => import('../views/OrderList.vue') },
  { path: '/yandex-orders', component: () => import('../views/OrderList.vue') },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

export default router;
