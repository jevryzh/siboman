// 全局 axios 拦截器 - Session 保活 + 店铺 ID 自动注入 (v0.3.2)
// 修复目标:
//   1) 401 → 弹框提示登录 (不硬跳, 节流避免并发)
//   2) 5xx/网络错误 → 不清 cookie 不跳转
//   3) 【新】所有请求自动注入 currentStoreId, 组件层不再各自 localStorage.getItem
//      - GET/DELETE: 拼进 query params
//      - POST/PATCH/PUT: 拼进 request body (不覆盖组件自己传的 store_id)
(function installAxiosGuard() {
  if (!window.axios || window.__axiosGuardInstalled) return;
  window.__axiosGuardInstalled = true;
  window.axios.defaults.withCredentials = true;

  // ---- 请求拦截器: 自动注入 store_id ----
  window.axios.interceptors.request.use((config) => {
    const url = String(config.url || '');
    // 白名单: 认证 / 店铺列表 / 单店铺 CRUD / 静态资源 不注入
    const skip =
      url.includes('/api/auth/') ||
      url.match(/\/api\/seller\/shops(\/|\?|$)/) ||
      url.startsWith('/uploads/') ||
      url.includes('/api/version');
    if (skip) return config;

    const sid = localStorage.getItem('currentStoreId') || '';
    if (!sid) return config;

    const method = String(config.method || 'get').toLowerCase();
    if (method === 'get' || method === 'delete') {
      config.params = config.params || {};
      if (!config.params.store_id && !config.params.storeId) {
        config.params.store_id = sid;
      }
    } else {
      // POST/PATCH/PUT
      // FormData 不动 (multipart 保持原样)
      if (config.data instanceof FormData) return config;
      const isObj = config.data && typeof config.data === 'object';
      if (!isObj) {
        config.data = {};
      }
      if (!('store_id' in config.data) && !('storeId' in config.data)) {
        config.data.store_id = sid;
      }
    }
    return config;
  });

  // ---- 响应拦截器: 401 提示 ----
  let sessionExpiredNotified = false;
  window.axios.interceptors.response.use(
    (r) => r,
    (err) => {
      const status = err?.response?.status;
      const url = err?.config?.url || '';
      const isAuthProbe = url.includes('/api/auth/');
      if (status === 401 && !isAuthProbe) {
        if (!sessionExpiredNotified) {
          sessionExpiredNotified = true;
          const msg = 'Session 已过期，请重新登录';
          if (window.ElementPlus?.ElMessageBox) {
            window.ElementPlus.ElMessageBox.alert(msg, '登录状态失效', {
              confirmButtonText: '前往登录',
              type: 'warning',
              callback: () => { window.location.href = '/login'; },
            });
          } else {
            alert(msg);
            window.location.href = '/login';
          }
        }
      }
      return Promise.reject(err);
    },
  );
})();

// ---- 全局工具: 供 view 组件复用, 统一读取当前店铺 ID ----
window.getCurrentStoreId = () => localStorage.getItem('currentStoreId') || '';

const initApp = () => {
  const currentPath = Vue.ref(window.location.hash || '#/dashboard');
  window.addEventListener('hashchange', () => {
    currentPath.value = window.location.hash || '#/dashboard';
  });

  const App = {
    setup() {
      const currentUser = Vue.ref(null);
      const isReady = Vue.ref(false);
      const shops = Vue.ref([]);
      const currentStoreId = Vue.ref(localStorage.getItem('currentStoreId') || '');

      const fetchInitData = async () => {
        try {
          const authRes = await axios.get('/api/auth/status');
          // 只有明确 authenticated=false 才跳登录; 网络错误 / 5xx 不跳
          if (authRes?.data?.authenticated === false) {
            window.location.href = '/login';
            return;
          }
          if (authRes?.data?.user) currentUser.value = authRes.data.user;

          const shopRes = await axios.get('/api/seller/shops');
          shops.value = shopRes?.data?.shops || [];
          if (!currentStoreId.value && shops.value.length) {
            currentStoreId.value = shops.value[0].id;
            localStorage.setItem('currentStoreId', currentStoreId.value);
          }
        } catch (e) {
          // 网络异常 / 5xx: 保持在页, 由拦截器处理 401
          console.warn('[fetchInitData] warn:', e?.response?.status, e.message);
          if (e?.response?.status === 401) {
            // 拦截器已经处理, 这里不再重复跳
            return;
          }
        } finally {
          isReady.value = true;
        }
      };

      const handleLogout = async () => {
        await axios.post('/api/auth/logout');
        window.location.href = '/login';
      };

      const goTo = (p) => { window.location.hash = p; };
      const handleStoreChange = (val) => {
        // 双写: localStorage (拦截器读) + 全局事件 (视图刷新)
        currentStoreId.value = val;
        localStorage.setItem('currentStoreId', val);
        window.dispatchEvent(new CustomEvent('shop-changed', { detail: val }));
      };

      Vue.onMounted(fetchInitData);

      const routeName = Vue.computed(() => {
        const path = currentPath.value.toLowerCase();
        if (path.includes('dashboard')) return 'dashboard';
        if (path.includes('sourcing')) return 'sourcing';
        if (path.includes('collection')) return 'collection';
        if (path.includes('product')) return 'products';
        if (path.includes('inventory')) return 'inventory';
        if (path.includes('order')) return 'orders';
        if (path.includes('upload')) return 'upload';
        if (path.includes('listing-history')) return 'listing-history';
        if (path.includes('ai-generator')) return 'ai-generator';
        if (path.includes('stores')) return 'stores';
        return 'dashboard';
      });

      return { currentPath, routeName, isReady, currentUser, handleLogout, goTo, shops, currentStoreId, handleStoreChange };
    },
    template: `
      <el-container class="layout-container" v-loading="!isReady">
        <el-aside width="200px">
          <div class="logo" style="display:flex; align-items:center; gap:8px">
            <img src="/extension/zhumeng-collector/icons/icon48.png" style="width:28px; height:28px; border-radius:6px" />
            逐梦 ERP
          </div>
          <el-menu :default-active="currentPath" background-color="#001529" text-color="#fff">
            <el-menu-item index="#/dashboard" @click="goTo('#/dashboard')">
              <el-icon><Odometer /></el-icon><span>仪表盘</span>
            </el-menu-item>
            <el-menu-item index="#/sourcing" @click="goTo('#/sourcing')">
              <el-icon><TrendCharts /></el-icon><span>选品中心</span>
            </el-menu-item>
            <el-menu-item index="#/collection" @click="goTo('#/collection')">
              <el-icon><Box /></el-icon><span>采集箱</span>
            </el-menu-item>
            <el-menu-item index="#/products" @click="goTo('#/products')">
              <el-icon><Goods /></el-icon><span>商品管理</span>
            </el-menu-item>
            <el-menu-item index="#/inventory" @click="goTo('#/inventory')">
              <el-icon><House /></el-icon><span>库存管理</span>
            </el-menu-item>
            <el-menu-item index="#/orders" @click="goTo('#/orders')">
              <el-icon><ShoppingCart /></el-icon><span>订单管理</span>
            </el-menu-item>
            <el-menu-item index="#/upload" @click="goTo('#/upload')">
              <el-icon><UploadFilled /></el-icon><span>批量上架</span>
            </el-menu-item>
            <el-menu-item index="#/listing-history" @click="goTo('#/listing-history')">
              <el-icon><Document /></el-icon><span>上架记录</span>
            </el-menu-item>
            <el-menu-item index="#/ai-generator" @click="goTo('#/ai-generator')">
              <el-icon><MagicStick /></el-icon><span>AI 套图</span>
            </el-menu-item>
            <el-menu-item index="#/stores" @click="goTo('#/stores')">
              <el-icon><Setting /></el-icon><span>店铺管理</span>
            </el-menu-item>
          </el-menu>
        </el-aside>
        <el-container>
          <el-header style="background:#fff; border-bottom:1px solid #eee; display:flex; align-items:center; justify-content:space-between">
            <el-breadcrumb separator="/">
              <el-breadcrumb-item>逐梦 ERP</el-breadcrumb-item>
              <el-breadcrumb-item>{{ routeName }}</el-breadcrumb-item>
            </el-breadcrumb>
            <div class="header-right" v-if="currentUser" style="display: flex; align-items: center; gap: 15px;">
              <shop-switcher @change="handleStoreChange" />
              <span style="font-size: 13px; color: #666">
                用户：<el-tag size="small">{{ currentUser.display_name || currentUser.username }}</el-tag>
              </span>
              <el-button type="danger" link @click="handleLogout">退出</el-button>
            </div>
          </el-header>
          <el-main>
            <div v-if="routeName === 'dashboard'"><dashboard-view /></div>
            <div v-else-if="routeName === 'sourcing'"><sourcing-module-view /></div>
            <div v-else-if="routeName === 'collection'"><collection-box-view /></div>
            <div v-else-if="routeName === 'products'"><product-list-view /></div>
            <div v-else-if="routeName === 'inventory'"><inventory-management-view /></div>
            <div v-else-if="routeName === 'orders'"><order-list-view /></div>
            <div v-else-if="routeName === 'upload'"><batch-upload-view /></div>
            <div v-else-if="routeName === 'listing-history'"><listing-history-view /></div>
            <div v-else-if="routeName === 'ai-generator'"><ai-image-generator-view /></div>
            <div v-else-if="routeName === 'stores'"><store-management-view /></div>
          </el-main>
        </el-container>
      </el-container>
    `
  };

  const app = Vue.createApp(App);
  app.use(ElementPlus);
  for (const [key, component] of Object.entries(ElementPlusIconsVue)) { app.component(key, component); }

  const register = (name, comp) => {
    if (comp) {
      app.component(name, comp);
    } else {
      console.error('Failed to register component: ' + name + ' (window variable is undefined)');
    }
  };

  register('inline-edit-cell', window.InlineEditCell);
  register('shop-switcher', window.ShopSwitcher);
  register('collection-box-view', window.CollectionBoxView);
  register('collection-edit-drawer', window.CollectionEditDrawer);
  register('dashboard-view', window.DashboardView);
  register('sourcing-module-view', window.SourcingModuleView);
  register('product-list-view', window.ProductListView);
  register('inventory-management-view', window.InventoryManagementView);
  register('order-list-view', window.OrderListView);
  register('batch-upload-view', window.BatchUploadView);
  register('listing-history-view', window.ListingHistoryView);
  register('ai-image-generator-view', window.AIImageGeneratorView);
  register('store-management-view', window.StoreManagementView);

  app.mount('#app');
};

if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', initApp); } else { initApp(); }
