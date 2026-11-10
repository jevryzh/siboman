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
      const buildInfo = Vue.ref({ version: '', buildTime: '' });
      const mobileNavOpen = Vue.ref(false);

      const envLabel = Vue.computed(() => {
        const host = window.location.hostname || '';
        if (host.includes('test.renwz.cn')) return '测试环境';
        if (host.includes('xm.renwz.cn')) return '生产环境';
        return '本地环境';
      });

      const fetchInitData = async () => {
        try {
          axios.get('/api/version').then((res) => {
            buildInfo.value = {
              version: res.data?.version || '',
              buildTime: res.data?.buildTime || '',
            };
          }).catch(() => {});
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

      const goTo = (p) => { mobileNavOpen.value = false; window.location.hash = p; };
      // 独立出图服务（image-set）的控制台：同域，未登录会跳 ERP 登录页
      const openImageSetConsole = () => window.open('/image-set-console.html', '_blank', 'noopener');
      const handleStoreChange = (val) => {
        // 「全部店铺（聚合）」只属于订单页：不能写进全局 currentStoreId，
        //   否则切到商品/库存等页面会拿 '__all__' 当店铺 id 去查 → 全空。
        if (val === '__all__') {
          currentStoreId.value = localStorage.getItem('currentStoreId') || '';
          window.dispatchEvent(new CustomEvent('shop-changed', { detail: val }));
          return;
        }
        // 双写: localStorage (拦截器读) + 全局事件 (视图刷新)
        currentStoreId.value = val;
        localStorage.setItem('currentStoreId', val);
        window.dispatchEvent(new CustomEvent('shop-changed', { detail: val }));
      };

      // v2.2.9.81: 顶部导航插件下载 — 版本号动态读 manifest，升插件后无需改代码
      const pluginDownloadUrl = Vue.ref('/extension/zhumeng-collector.zip');
      const fetchPluginDownloadUrl = async () => {
        try {
          const res = await fetch('/extension/zhumeng-collector/manifest.json');
          const m = await res.json();
          pluginDownloadUrl.value = `/extension/zhumeng-collector.zip?v=${encodeURIComponent(String(m.version || ''))}`;
        } catch {
          pluginDownloadUrl.value = '/extension/zhumeng-collector.zip';
        }
      };

      Vue.onMounted(fetchInitData);
      Vue.onMounted(fetchPluginDownloadUrl);

      // 面包屑显示用的中文名；没收录的路由保持原来的 slug，不影响其它页面
      const ROUTE_LABELS = {
        dashboard: '仪表盘', sourcing: '选品中心', collection: '采集箱', 'single-sourcing': '单品找货',
        'single-sourcing-review': '单品审核', 'listing-history': '上架记录', 'ai-generator': 'AI 图片生成',
        products: '商品管理', inventory: '库存管理', orders: '订单管理', upload: '批量上架',
        'yandex-products': 'Yandex 商品', 'yandex-autolist': 'Yandex 自动上架', 'yandex-inventory': 'Yandex 库存',
        'yandex-orders': 'Yandex 订单', 'ozon-patrol': '巡查跟卖', 'sales-funnel': '销售漏斗',
        'statistics-analysis': '月结统计', 'settlement-detail': '应计原始数据',
        'business-overview': '经营总览', cashflow: '资金流水', 'shareholder-equity': '股东权益',
        'data-screen': '数据大屏', stores: '店铺管理', analytics: '统计分析', 'market-discovery': '选品发现',
        'smart-pick': 'AI 智选',
      };
      const routeName = Vue.computed(() => {
        const path = currentPath.value.toLowerCase();
        if (path === '#/selection') return 'sourcing';
        if (path === '#/history') return 'listing-history';
        if (path === '#/ai-image') return 'ai-generator';
        if (path === '#/screen') return 'data-screen';
        if (path === '#/ranking') return 'market-discovery';
        if (path.includes('smart-pick')) return 'smart-pick';
        if (path.includes('business-overview')) return 'business-overview';
        if (path.includes('shareholder-equity')) return 'shareholder-equity';
        if (path.includes('cashflow')) return 'cashflow';
        if (path.includes('dashboard')) return 'dashboard';
        if (path.includes('sales-funnel') || path.includes('funnel')) return 'sales-funnel';
        if (path.includes('single-sourcing-review')) return 'single-sourcing-review';
        if (path.includes('single-sourcing')) return 'single-sourcing';
        if (path.includes('sourcing')) return 'sourcing';
        if (path.includes('collection')) return 'collection';
        if (path.includes('yandex-autolist')) return 'yandex-autolist';
        if (path.includes('yandex-products')) return 'yandex-products';
        if (path.includes('yandex-inventory')) return 'yandex-inventory';
        if (path.includes('yandex-orders')) return 'yandex-orders';
        if (path.includes('product')) return 'products';
        if (path.includes('inventory')) return 'inventory';
        if (path.includes('order')) return 'orders';
        if (path.includes('upload')) return 'upload';
        if (path.includes('listing-history')) return 'listing-history';
        if (path.includes('ai-generator')) return 'ai-generator';
        if (path.includes('settlement-detail')) return 'settlement-detail';
        if (path.includes('statistics-analysis')) return 'statistics-analysis';
        if (path.includes('analytics')) return 'analytics';
        if (path.includes('data-screen')) return 'data-screen';
        if (path.includes('market-discovery')) return 'market-discovery';
        if (path.includes('stores')) return 'stores';
        if (path.includes('ozon-patrol')) return 'ozon-patrol';
        return 'dashboard';
      });

      // Yandex 多店铺：按当前路由决定顶栏切换器展示的平台，并自动对齐当前店铺
      const headerPlatform = Vue.computed(() => {
        const r = routeName.value;
        if (r === 'yandex-products' || r === 'yandex-orders' || r === 'yandex-inventory' || r === 'yandex-autolist') return 'yandex';
        if (r === 'stores') return 'all';
        // 经营分析跨多个店铺/平台，不该因为切页面把顶栏店铺改掉
        if (r === 'business-overview' || r === 'cashflow' || r === 'shareholder-equity') return 'all';
        return 'ozon';
      });
      Vue.watch(headerPlatform, (platform) => {
        if (platform === 'all') return;
        const sid = localStorage.getItem('currentStoreId') || '';
        const shop = shops.value.find((s) => s.id === sid);
        const list = shops.value.filter((s) => s.platform === platform && s.active !== false);
        if (!list.length) return;
        if (!shop || shop.platform !== platform) {
          handleStoreChange(list[0].id);
        }
      });

      const routeLabel = Vue.computed(() => ROUTE_LABELS[routeName.value] || routeName.value);
      return { currentPath, routeName, routeLabel, isReady, currentUser, handleLogout, goTo, openImageSetConsole, shops, currentStoreId, handleStoreChange, headerPlatform, buildInfo, envLabel, pluginDownloadUrl, mobileNavOpen };
    },
    template: `
      <el-container class="layout-container" :class="{'statistics-mobile-nav-open':mobileNavOpen}" v-loading="!isReady">
        <div v-if="mobileNavOpen && routeName === 'statistics-analysis'" class="statistics-nav-backdrop" @click="mobileNavOpen=false"></div>
        <el-aside width="200px">
          <div class="logo" style="display:flex; align-items:center; gap:8px">
            <img src="/extension/zhumeng-collector/icons/icon48.png" style="width:28px; height:28px; border-radius:6px" />
            逐梦 ERP
          </div>
          <el-menu :default-active="currentPath" :default-openeds="['selection-mgmt','product-mgmt','statistics','biz-analysis','yandex-mgmt','ai-tools']" background-color="#001529" text-color="#fff">
            <el-menu-item index="#/dashboard" @click="goTo('#/dashboard')">
              <el-icon><Odometer /></el-icon><span>仪表盘</span>
            </el-menu-item>
            <!-- [Accio Work 修改] v2.2.9.219 左侧菜单重组：二级菜单分组版 -->
            <el-sub-menu index="selection-mgmt">
              <template #title><el-icon><TrendCharts /></el-icon><span>选品管理</span></template>
              <el-menu-item index="#/sourcing" @click="goTo('#/sourcing')"><span>选品中心</span></el-menu-item>
              <el-menu-item index="#/smart-pick" @click="goTo('#/smart-pick')"><span>AI 智选</span></el-menu-item>
              <el-menu-item index="#/collection" @click="goTo('#/collection')"><span>采集箱</span></el-menu-item>
              <el-menu-item index="#/single-sourcing" @click="goTo('#/single-sourcing')"><span>单品找货</span></el-menu-item>
            </el-sub-menu>
            <el-sub-menu index="product-mgmt">
              <template #title><el-icon><Goods /></el-icon><span>商品管理</span></template>
              <el-menu-item index="#/products" @click="goTo('#/products')"><span>商品列表</span></el-menu-item>
              <el-menu-item index="#/upload" @click="goTo('#/upload')"><span>批量上架</span></el-menu-item>
              <el-menu-item index="#/listing-history" @click="goTo('#/listing-history')"><span>上架记录</span></el-menu-item>
              <el-menu-item index="#/ozon-patrol" @click="goTo('#/ozon-patrol')"><span>巡查跟卖</span></el-menu-item>
            </el-sub-menu>
            <el-menu-item index="#/inventory" @click="goTo('#/inventory')">
              <el-icon><House /></el-icon><span>库存管理</span>
            </el-menu-item>
            <el-menu-item index="#/orders" @click="goTo('#/orders')">
              <el-icon><ShoppingCart /></el-icon><span>订单管理</span>
            </el-menu-item>
            <el-sub-menu index="statistics">
              <template #title><el-icon><DataAnalysis /></el-icon><span>店铺结算</span></template>
              <el-menu-item index="#/statistics-analysis" @click="goTo('#/statistics-analysis')"><span>月结统计</span></el-menu-item>
              <el-menu-item index="#/settlement-detail" @click="goTo('#/settlement-detail')"><span>应计原始数据</span></el-menu-item>
            </el-sub-menu>
            <el-sub-menu index="biz-analysis">
              <template #title><el-icon><TrendCharts /></el-icon><span>经营分析</span></template>
              <el-menu-item index="#/business-overview" @click="goTo('#/business-overview')"><span>经营总览</span></el-menu-item>
              <el-menu-item index="#/shareholder-equity" @click="goTo('#/shareholder-equity')"><span>股东权益</span></el-menu-item>
            </el-sub-menu>
            <el-menu-item index="#/stores" @click="goTo('#/stores')">
              <el-icon><Setting /></el-icon><span>店铺管理</span>
            </el-menu-item>
            <el-sub-menu index="yandex-mgmt">
              <template #title><el-icon><GoodsFilled /></el-icon><span>Yandex 管理</span></template>
              <el-menu-item index="#/yandex-products" @click="goTo('#/yandex-products')"><span>商品管理</span></el-menu-item>
              <el-menu-item index="#/yandex-autolist" @click="goTo('#/yandex-autolist')"><span>自动上架</span></el-menu-item>
              <el-menu-item index="#/yandex-inventory" @click="goTo('#/yandex-inventory')"><span>库存管理</span></el-menu-item>
              <el-menu-item index="#/yandex-orders" @click="goTo('#/yandex-orders')"><span>订单管理</span></el-menu-item>
            </el-sub-menu>
            <el-sub-menu index="ai-tools">
              <template #title><el-icon><MagicStick /></el-icon><span>AI 工具</span></template>
              <el-menu-item index="#/ai-generator" @click="goTo('#/ai-generator')"><span>AI 图片生成</span></el-menu-item>
              <el-menu-item index="#/image-set-console" @click="openImageSetConsole"><span>AI 套图控制台</span></el-menu-item>
              <el-menu-item index="#/data-screen" @click="goTo('#/data-screen')"><span>数据大屏</span></el-menu-item>
              <el-menu-item index="#/sales-funnel" @click="goTo('#/sales-funnel')"><span>销售漏斗</span></el-menu-item>
            </el-sub-menu>
          </el-menu>
        </el-aside>
        <el-container>
          <el-header class="erp-app-header">
            <el-button v-if="routeName === 'statistics-analysis'" class="statistics-nav-toggle" :icon="'Menu'" circle :aria-label="mobileNavOpen?'关闭导航':'打开导航'" :aria-expanded="mobileNavOpen" title="导航" @click="mobileNavOpen=!mobileNavOpen" />
            <el-breadcrumb separator="/">
              <el-breadcrumb-item>逐梦 ERP</el-breadcrumb-item>
              <el-breadcrumb-item>{{ routeLabel }}</el-breadcrumb-item>
            </el-breadcrumb>
            <div class="header-right" v-if="currentUser" style="display: flex; align-items: center; gap: 15px;">
              <!-- 2026-11-10 订单页也把店铺放到顶栏（全局控制）：订单页额外提供「全部店铺（聚合）」 -->
              <shop-switcher v-if="routeName !== 'yandex-orders'" :platform="headerPlatform" :allow-all="routeName === 'orders'" @change="handleStoreChange" />
              <el-tooltip content="下载最新版 Chrome 采集插件 zip（解压后在扩展程序页加载已解压的文件夹）" placement="bottom">
                <a :href="pluginDownloadUrl" target="_blank" rel="noreferrer" style="display:inline-flex; align-items:center; gap:4px; padding:4px 10px; border:1px solid #cbd5e1; border-radius:6px; background:#f8fafc; color:#475569; font-size:12px; text-decoration:none; white-space:nowrap">
                  📦 插件下载
                </a>
              </el-tooltip>
              <el-tooltip :content="buildInfo.buildTime ? ('构建时间：' + buildInfo.buildTime) : '版本信息读取中'" placement="bottom">
                <el-tag size="small" :type="envLabel === '生产环境' ? 'success' : envLabel === '测试环境' ? 'warning' : 'info'">
                  {{ envLabel }}<span v-if="buildInfo.version"> · {{ buildInfo.version }}</span>
                </el-tag>
              </el-tooltip>
              <span style="font-size: 13px; color: #666">
                用户：<el-tag size="small">{{ currentUser.display_name || currentUser.username }}</el-tag>
              </span>
              <el-button type="danger" link @click="handleLogout">退出</el-button>
            </div>
          </el-header>
          <el-main class="erp-main">
            <div v-if="routeName === 'dashboard'" class="erp-route-page"><dashboard-view /></div>
            <div v-else-if="routeName === 'sourcing'" class="erp-route-page"><market-discovery-view /></div>
            <div v-else-if="routeName === 'smart-pick'" class="erp-route-page" style="padding:0; background:transparent; min-height:100%"><smart-pick-view /></div>
            <div v-else-if="routeName === 'single-sourcing-review'" class="erp-route-page"><single-sourcing-review-view /></div>
            <div v-else-if="routeName === 'single-sourcing'" class="erp-route-page"><sourcing-module-view /></div>
            <div v-else-if="routeName === 'collection'"><collection-box-view /></div>
            <div v-else-if="routeName === 'products'"><product-list-view /></div>
            <div v-else-if="routeName === 'yandex-products'" class="erp-route-page"><yandex-product-list-view /></div>
            <div v-else-if="routeName === 'yandex-autolist'" class="erp-route-page"><yandex-auto-listing-view /></div>
            <div v-else-if="routeName === 'yandex-inventory'" class="erp-route-page"><yandex-inventory-view /></div>
            <div v-else-if="routeName === 'inventory'"><inventory-management-view /></div>
            <div v-else-if="routeName === 'orders'"><order-list-view /></div>
            <div v-else-if="routeName === 'yandex-orders'" class="erp-route-page"><yandex-order-list-view /></div>
            <div v-else-if="routeName === 'upload'" class="erp-route-page"><batch-upload-view /></div>
            <div v-else-if="routeName === 'listing-history'" class="erp-route-page"><listing-history-view /></div>
            <div v-else-if="routeName === 'ai-generator'" class="erp-route-page"><ai-image-generator-view /></div>
            <div v-else-if="routeName === 'analytics'" class="erp-route-page"><analytics-center-view /></div>
            <div v-else-if="routeName === 'statistics-analysis'" class="erp-route-page"><statistics-analysis-view /></div>
            <div v-else-if="routeName === 'settlement-detail'" class="erp-route-page"><settlement-detail-view /></div>
            <div v-else-if="routeName === 'business-overview'" class="erp-route-page"><business-overview-view /></div>
            <div v-else-if="routeName === 'shareholder-equity'" class="erp-route-page"><shareholder-equity-view /></div>
            <div v-else-if="routeName === 'cashflow'" class="erp-route-page"><cash-flow-view /></div>
            <div v-else-if="routeName === 'data-screen'"><data-screen-view /></div>
            <div v-else-if="routeName === 'market-discovery'" class="erp-route-page"><market-discovery-view /></div>
            <div v-else-if="routeName === 'stores'"><store-management-view /></div>
            <div v-else-if="routeName === 'ozon-patrol'" class="erp-route-page"><ozon-patrol-view /></div>
            <div v-else-if="routeName === 'sales-funnel'" class="erp-route-page"><analytics-funnel-view /></div>
          </el-main>
        </el-container>
      </el-container>
    `
  };

  const app = Vue.createApp(App);
  // 2026-11-10 兜底：某个页面组件渲染报错时（例如模板引用了 setup 没 return 的方法），
  //   Vue 默认会把错误往上抛，整棵树渲染失败 → 整站白屏，用户只看到「系统全量重构中」。
  //   装上 errorHandler 后只让出错的那个组件区域不显示，其余页面照常可用，并给出可见提示。
  app.config.errorHandler = (err, _instance, info) => {
    console.error('[vue-error]', info, err);
    try {
      window.ElementPlus?.ElMessage?.error?.({ message: `页面渲染出错：${String(err?.message || err).slice(0, 120)}`, duration: 10000, showClose: true });
    } catch (_e) { /* 提示失败不影响主流程 */ }
  };
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
  register('single-sourcing-review-view', window.SingleSourcingReviewView);
  register('product-list-view', window.ProductListView);
  register('yandex-product-list-view', window.YandexProductListView);
  register('yandex-auto-listing-view', window.YandexAutoListingView);
  register('inventory-management-view', window.InventoryManagementView);
  register('yandex-inventory-view', window.YandexInventoryManagementView);
  register('order-list-view', window.OrderListView);
  register('yandex-order-list-view', window.YandexOrderListView);
  register('batch-upload-view', window.BatchUploadView);
  register('listing-history-view', window.ListingHistoryView);
  register('ai-image-generator-view', window.AIImageGeneratorView);
  register('analytics-center-view', window.AnalyticsCenterView);
  register('statistics-analysis-view', window.StatisticsAnalysisView);
  register('settlement-detail-view', window.SettlementDetailView);
  register('business-overview-view', window.BusinessOverviewView);
  register('shareholder-equity-view', window.ShareholderEquityView);
  register('cash-flow-view', window.CashFlowView);
  register('data-screen-view', window.DataScreenView);
  register('market-discovery-view', window.MarketDiscoveryView);
  register('smart-pick-view', window.SmartPickView);
  register('store-management-view', window.StoreManagementView);
  register('ozon-patrol-view', window.OzonPatrolView);
  register('analytics-funnel-view', window.AnalyticsFunnelView);

  app.mount('#app');
  setupPluginWorkerKeepAlive();
};

// 插件 worker token 只有 15 分钟有效期，而全站此前只有「选品中心 / 单品找货」两个页面会把它推给插件。
// 结果：在别的页面停留超过 15 分钟，插件就一直拿着过期 token 轮询（服务端 401），
// 界面上表现为「采集器没有开始采集」。这里改成任意页面常驻续期，每 8 分钟推一次新 token。
function setupPluginWorkerKeepAlive() {
  const PROTO = "__zhumeng_proto";
  const PROTO_VAL = "zhumeng-v1";
  if (!window.__zhumeng_pending__) window.__zhumeng_pending__ = {};
  if (!window.__zhumeng_bridge_ready__) {
    window.__zhumeng_bridge_ready__ = true;
    window.addEventListener("message", (event) => {
      const d = event.data;
      if (!d || typeof d !== "object" || d[PROTO] !== PROTO_VAL || !d.reqId) return;
      // v2.2.9.124 修复：必须忽略自己发出去的 *.request 回弹。
      //   window.postMessage 会在调用方自己的 window 同步触发 message，这条全局 listener
      //   早于各页面（批量上架/店铺管理/单品找货）注册，会把 request body 当回复立刻
      //   resolve 掉 pending → ping 永远拿不到 ok/background_version →
      //   pluginVersionOk=false → 「一键解析+采集+上架」按钮被永久禁用（点了没反应）。
      if (typeof d.kind === "string" && d.kind.endsWith(".request")) return;
      const resolver = window.__zhumeng_pending__[d.reqId];
      if (typeof resolver === "function") { delete window.__zhumeng_pending__[d.reqId]; resolver(d); }
    });
  }
  const sendToExtension = (kind, extra = {}, timeoutMs = 8000) => new Promise((resolve) => {
    const reqId = `${kind.split(".")[0]}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    let resolved = false;
    window.__zhumeng_pending__[reqId] = (data) => {
      if (resolved) return;
      resolved = true;
      delete window.__zhumeng_pending__[reqId];
      resolve(data);
    };
    try {
      window.postMessage({ [PROTO]: PROTO_VAL, reqId, kind, ...extra }, "*");
    } catch (e) {
      resolved = true; delete window.__zhumeng_pending__[reqId]; resolve({ ok: false, error: e.message }); return;
    }
    setTimeout(() => {
      if (resolved) return;
      resolved = true; delete window.__zhumeng_pending__[reqId];
      resolve(null);
    }, timeoutMs);
  });
  // v2.2.9.128: 暴露给各页面用 —— 提交任务后立刻唤醒插件来领取，
  //   否则要等插件的 30 秒 alarm 轮询，用户会以为「卡住了」。
  try { window.__zhumeng_send__ = sendToExtension; } catch (_e) { /* 忽略 */ }

  const refresh = async () => {
    try {
      // v2.2.9.125: 带上当前店铺 —— worker token 里的店铺作用域决定插件能读哪家店的数据
      //   （seller.ozon.ru 后台注入的「销售漏斗」面板走这个 token 取数，只放行该店）。
      //   不传 store_id 的话 token 没有店铺作用域，面板会报「插件 token 缺少店铺作用域」。
      const sid = localStorage.getItem("currentStoreId") || "";
      const url = sid
        ? `/api/worker/plugin-token?store_id=${encodeURIComponent(sid)}`
        : "/api/worker/plugin-token";
      let resp = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
      // v2.2.9.129 换账号登录后的坑：
      //   localStorage.currentStoreId 是**上一个账号**选的店铺，这个浏览器里不会自动清。
      //   带着别人的 store_id 去签 token，服务端会 404「店铺不存在、已停用或无权限」，
      //   于是 token 一直签不出来 → 插件继续用旧账号的 token →
      //   新账号（如 jindiao）的跟卖任务永远没人领取，界面一直「等待采集端领取」。
      //   这里失败就退一步：清掉这个失效的店铺 id，改成不带 store_id 再签一次。
      //   （店铺作用域只影响 seller.ozon.ru 里的销售漏斗面板，不影响采集任务。）
      if (!resp.ok && sid) {
        try { localStorage.removeItem("currentStoreId"); } catch (_e) { /* 忽略 */ }
        resp = await fetch("/api/worker/plugin-token", { credentials: "include", headers: { Accept: "application/json" } });
      }
      if (!resp.ok) return null;
      const data = await resp.json();
      if (!data?.token) return null;
      const reply = await sendToExtension("workerAuth.request", { token: data.token }, 8000);
      return reply?.ok === true ? data.token : null;
    } catch (_e) { return null; }
  };
  if (!window.__zhumeng_keepalive_started__) {
    window.__zhumeng_keepalive_started__ = true;
    setTimeout(refresh, 1200);
    setInterval(refresh, 8 * 60 * 1000);
    // 切店铺后立刻用新店铺重新签发 token，避免插件还拿着旧店铺的作用域
    window.addEventListener("shop-changed", () => { setTimeout(refresh, 300); });
  }
  window.__zhumengRefreshWorkerAuth__ = refresh;   // 页面可按需立即续期（如刚提交采集任务）
}

if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', initApp); } else { initApp(); }
