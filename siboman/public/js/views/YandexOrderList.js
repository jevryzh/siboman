window.YandexOrderListView = {
  setup() {
    const orders = Vue.ref([]);
    const loading = Vue.ref(false);
    const hasFetched = Vue.ref(false);
    const activeTab = Vue.ref('all');
    const search = Vue.ref('');
    const pagination = Vue.reactive({ currentPage: 1, pageSize: 20, total: 0 });
    const apiReady = Vue.ref(true);
    const detailDrawer = Vue.reactive({ visible: false, row: null });
    const shipping = Vue.reactive({}); // orderId -> bool（发货中）

    const notify = {
      success: (msg) => (window.ElementPlus?.ElMessage || console).success?.(msg),
      warning: (msg) => (window.ElementPlus?.ElMessage || console).warning?.(msg),
      error: (msg) => (window.ElementPlus?.ElMessage || console).error?.(msg),
    };

    const statusTabs = [
      { label: '所有订单', value: 'all' },
      { label: '待处理', value: 'processing' },
      { label: '待发货', value: 'awaiting_delivery' },
      { label: '配送中', value: 'delivering' },
      { label: '已完成', value: 'delivered' },
      { label: '已取消', value: 'cancelled' },
    ];

    const statusText = (status) => ({
      processing: '待处理',
      awaiting_delivery: '待发货',
      delivering: '配送中',
      delivered: '已完成',
      cancelled: '已取消',
    }[String(status || '').toLowerCase()] || status || '-');

    const statusTagType = (status) => ({
      processing: 'warning',
      awaiting_delivery: 'primary',
      delivering: 'success',
      delivered: 'success',
      cancelled: 'danger',
    }[String(status || '').toLowerCase()] || 'info');

    const primaryProduct = (row) => (Array.isArray(row.products) ? row.products[0] : null) || {};
    const moneyText = (value, currency = 'RUB') => {
      const n = Number(value || 0);
      if (!Number.isFinite(n) || n <= 0) return '-';
      return `${currency} ${n.toFixed(2)}`;
    };
    // 利润展示：有成本就显示利润，否则「待核算」
    const profitText = (row) => {
      if (row?.profit_cny === null || row?.profit_cny === undefined) return '待核算';
      const n = Number(row.profit_cny);
      return `¥ ${n.toFixed(2)}`;
    };
    const profitColor = (row) => {
      if (row?.profit_cny === null || row?.profit_cny === undefined) return '#94a3b8';
      return Number(row.profit_cny) >= 0 ? '#16a34a' : '#dc2626';
    };

    // Yandex 订单时间（DD-MM-YYYY HH:MM:SS，莫斯科时间 UTC+3）转北京时间展示；
    // 兼容 ISO（含 T / 时区）与已转好的本地时间。
    const toBeijing = (s) => {
      if (!s) return '-';
      const str = String(s).trim();
      // 已含 T 或 Z（ISO 形式）：按标准 Date 解析后 +8h
      if (/[TZ]/i.test(str) || /[+-]\d{2}:?\d{2}$/.test(str)) {
        const d = new Date(str);
        if (!Number.isNaN(d.getTime())) {
          return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
        }
      }
      // Yandex 原始格式 DD-MM-YYYY HH:MM:SS（莫斯科时间）
      const m = str.match(/^(\d{2})-(\d{2})-(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
      if (m) {
        const [, dd, mm, yyyy, hh, mi, ss] = m;
        const utc = Date.UTC(+yyyy, +mm - 1, +dd, +hh, +mi, +ss) - 3 * 3600 * 1000;
        return new Date(utc + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      }
      return str;
    };

    // Yandex 多店铺：页内店铺选择（顶栏切换器在订单页隐藏，参照 Ozon 订单页）
    const yandexStores = Vue.ref([]);
    const currentStoreId = Vue.ref(localStorage.getItem('currentStoreId') || '');
    const storeContext = Vue.ref(null);
    const fetchYandexStores = async () => {
      try {
        const res = await axios.get('/api/seller/shops', { params: { platform: 'yandex' } });
        yandexStores.value = res.data.shops || [];
        const sid = localStorage.getItem('currentStoreId') || '';
        if (!yandexStores.value.some((s) => s.id === sid) && yandexStores.value.length) {
          currentStoreId.value = yandexStores.value[0].id;
          localStorage.setItem('currentStoreId', currentStoreId.value);
        } else {
          currentStoreId.value = sid;
        }
      } catch (_e) { /* 店铺列表失败不阻塞订单页 */ }
    };
    const changeYandexStore = (val) => {
      localStorage.setItem('currentStoreId', val);
      window.dispatchEvent(new CustomEvent('shop-changed', { detail: val }));
      pagination.currentPage = 1;
      fetchOrders();
    };

    const fetchOrders = async () => {
      loading.value = true;
      try {
        const res = await axios.get('/api/yandex/orders', {
          params: {
            store_id: currentStoreId.value || undefined,
            status: activeTab.value,
            q: search.value,
            page: pagination.currentPage,
            page_size: pagination.pageSize,
          },
        });
        orders.value = res.data?.items || res.data?.orders || [];
        pagination.total = Number(res.data?.total || orders.value.length || 0);
        apiReady.value = res.data?.api_ready !== false;
        storeContext.value = res.data?.context || null;
      } catch (error) {
        if (error.response?.status === 404) {
          apiReady.value = false;
          orders.value = [];
          pagination.total = 0;
          notify.warning('Yandex 订单 API 还未接入，页面字段已先准备好');
        } else {
          notify.error(error.response?.data?.error || error.message || '读取 Yandex 订单失败');
        }
      } finally {
        hasFetched.value = true;
        loading.value = false;
      }
    };

    const openDetail = (row) => {
      detailDrawer.row = row;
      detailDrawer.visible = true;
    };

    const shipOrder = async (row) => {
      const orderId = row.order_id || row.posting_number || '';
      if (!orderId) return notify.warning('缺少订单号');
      try {
        await (window.ElementPlus?.ElMessageBox || { confirm: async () => ({}) }).confirm?.(
          `确认发货订单 ${orderId}？提交后订单状态将变更为「配送中」。`,
          '发货确认',
          { type: 'warning', confirmButtonText: '确认发货', cancelButtonText: '取消' },
        );
      } catch (_e) { return; } // 用户取消
      shipping[orderId] = true;
      try {
        const res = await axios.post('/api/yandex/orders/ship', { order_id: orderId, store_id: currentStoreId.value || undefined });
        if (res.data?.success) {
          notify.success(`订单 ${orderId} 发货提交成功`);
          await fetchOrders();
        } else {
          notify.error(res.data?.error || '发货失败');
        }
      } catch (error) {
        notify.error(error.response?.data?.error || error.message || '发货失败');
      } finally {
        delete shipping[orderId];
      }
    };

    const resetFilters = () => {
      search.value = '';
      activeTab.value = 'all';
      pagination.currentPage = 1;
      fetchOrders();
    };

    Vue.onMounted(async () => { await fetchYandexStores(); await fetchOrders(); });

    return {
      orders, loading, hasFetched, activeTab, search, pagination, apiReady, statusTabs,
      statusText, statusTagType, primaryProduct, moneyText, profitText, profitColor, toBeijing, fetchOrders, resetFilters,
      yandexStores, currentStoreId, storeContext, changeYandexStore,
      detailDrawer, openDetail, shipOrder, shipping,
    };
  },
  template: `
    <div>
      <div class="erp-toolbar">
        <div>
          <h1 class="erp-workbench-title">Yandex 订单</h1>
          <div class="erp-muted" style="display:flex; align-items:center; gap:10px; flex-wrap:wrap">
            <el-select v-model="currentStoreId" size="small" style="width:200px" placeholder="切换 Yandex 店铺" @change="changeYandexStore">
              <el-option v-for="s in yandexStores" :key="s.id" :label="s.name" :value="s.id" />
            </el-select>
            <span>{{ storeContext?.store_name || '' }}</span>
          </div>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap">
          <el-button size="large" @click="fetchOrders">
            <el-icon><RefreshRight /></el-icon><span>刷新</span>
          </el-button>
          <el-button size="large" type="primary" :loading="loading" @click="fetchOrders">
            <el-icon><Connection /></el-icon><span>同步 Yandex 订单</span>
          </el-button>
        </div>
      </div>

      <el-alert
        v-if="!apiReady"
        type="warning"
        :closable="false"
        show-icon
        style="margin-bottom:14px"
        title="Yandex 订单 API 尚未接入"
        description="当前页面已完成菜单、路由和字段布局；API 凭据会放在服务端配置里，避免泄露到浏览器端。" />

      <el-tabs v-model="activeTab" @tab-change="() => { pagination.currentPage = 1; fetchOrders(); }">
        <el-tab-pane v-for="tab in statusTabs" :key="tab.value" :label="tab.label" :name="tab.value" />
      </el-tabs>

      <div class="erp-filter-row">
        <el-input v-model="search" size="large" clearable placeholder="搜索订单号 / 商品 / 货号" style="width:360px" @keyup.enter="fetchOrders" />
        <el-button size="large" type="primary" @click="fetchOrders">查询</el-button>
        <el-button size="large" @click="resetFilters">重置</el-button>
      </div>

      <el-table
        :data="orders"
        v-loading="loading"
        element-loading-text="正在读取 Yandex 订单..."
        border
        size="large"
        :empty-text="hasFetched ? '暂无 Yandex 订单数据。' : '正在读取订单...'"
        style="border-radius:8px; overflow:hidden">
        <el-table-column type="selection" width="48" />
        <el-table-column label="订单号" min-width="180" fixed="left" show-overflow-tooltip>
          <template #default="{ row }"><b>{{ row.order_id || row.posting_number || '-' }}</b></template>
        </el-table-column>
        <el-table-column label="商品" min-width="320">
          <template #default="{ row }">
            <div style="display:flex; gap:12px; align-items:center; min-width:0">
              <el-image :src="primaryProduct(row).image" style="width:58px; height:58px; border-radius:8px; background:#f1f5f9; flex-shrink:0" fit="cover" preview-teleported hide-on-click-modal>
                <template #error><div style="height:58px; display:flex; align-items:center; justify-content:center; color:#94a3b8; font-size:12px">无图</div></template>
              </el-image>
              <div style="min-width:0">
                <div class="text-ellipsis" style="font-weight:900; color:#0f172a">{{ primaryProduct(row).name || row.product_name || '-' }}</div>
                <div class="text-ellipsis" style="font-size:12px; color:#94a3b8; margin-top:5px">货号 {{ primaryProduct(row).offer_id || '-' }} · SKU {{ primaryProduct(row).sku || '-' }} · ×{{ row.product_count || primaryProduct(row).quantity || 1 }}</div>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="{ row }"><el-tag :type="statusTagType(row.status)">{{ statusText(row.status) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="订单金额" width="140" align="right">
          <template #default="{ row }">{{ moneyText(row.total, row.currency_code || 'RUB') }}</template>
        </el-table-column>
        <el-table-column label="利润(估算)" width="130" align="right">
          <template #default="{ row }">
            <span :style="{ color: profitColor(row), fontWeight: 700 }">{{ profitText(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="下单时间" width="180">
          <template #default="{ row }">{{ toBeijing(row.created_at || row.in_process_at) }}</template>
        </el-table-column>
        <el-table-column label="发货截止" width="180">
          <template #default="{ row }">{{ toBeijing(row.shipment_date || row.delivery_date) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">详情</el-button>
            <el-button v-if="row.status === 'awaiting_delivery' || row.status === 'processing'" link type="warning" :loading="!!shipping[row.order_id || row.posting_number]" @click="shipOrder(row)">发货</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div style="display:flex; justify-content:flex-end; margin-top:14px">
        <el-pagination
          v-model:current-page="pagination.currentPage"
          v-model:page-size="pagination.pageSize"
          :total="pagination.total"
          :page-sizes="[20, 50, 100, 200]"
          layout="total, sizes, prev, pager, next"
          @size-change="fetchOrders"
          @current-change="fetchOrders" />
      </div>

      <el-drawer v-model="detailDrawer.visible" title="Yandex 订单详情" size="620px" append-to-body destroy-on-close>
        <template v-if="detailDrawer.row">
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="订单号"><b>{{ detailDrawer.row.order_id }}</b></el-descriptions-item>
            <el-descriptions-item label="外部订单号">{{ detailDrawer.row.external_order_id || '-' }}</el-descriptions-item>
            <el-descriptions-item label="状态">
              <el-tag :type="statusTagType(detailDrawer.row.status)">{{ statusText(detailDrawer.row.status) }}</el-tag>
              <span style="margin-left:6px; color:#94a3b8">{{ detailDrawer.row.substatus || detailDrawer.row.status_name || '' }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="下单时间">{{ toBeijing(detailDrawer.row.created_at) }}</el-descriptions-item>
            <el-descriptions-item label="发货截止">{{ toBeijing(detailDrawer.row.shipment_date) }}</el-descriptions-item>
            <el-descriptions-item label="订单金额">{{ moneyText(detailDrawer.row.total, detailDrawer.row.currency_code) }}</el-descriptions-item>
            <el-descriptions-item label="支付方式">{{ detailDrawer.row.raw?.paymentType || detailDrawer.row.raw?.paymentMethod || '-' }}</el-descriptions-item>
            <el-descriptions-item label="利润(估算)">
              <span :style="{ color: profitColor(detailDrawer.row), fontWeight: 800 }">{{ profitText(detailDrawer.row) }}</span>
              <span style="margin-left:8px; font-size:12px; color:#94a3b8">佣金24%+费率估算，未含类目差异</span>
            </el-descriptions-item>
          </el-descriptions>

          <el-divider content-position="left">利润明细（估算）</el-divider>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="卖家货值">{{ moneyText(detailDrawer.row.total, detailDrawer.row.currency_code) }}</el-descriptions-item>
            <el-descriptions-item label="平台补贴">{{ moneyText(detailDrawer.row.subsidies_cny, detailDrawer.row.currency_code) }}</el-descriptions-item>
            <el-descriptions-item label="收入合计">{{ moneyText(detailDrawer.row.revenue_cny, detailDrawer.row.currency_code) }}</el-descriptions-item>
            <el-descriptions-item label="1688 采购成本">{{ detailDrawer.row.purchase_cny === null || detailDrawer.row.purchase_cny === undefined ? '待核算（缺成本）' : moneyText(detailDrawer.row.purchase_cny, detailDrawer.row.currency_code) }}</el-descriptions-item>
            <el-descriptions-item label="平台费率(佣金+收单+提现+尾程)">{{ moneyText(detailDrawer.row.platform_fee_cny, detailDrawer.row.currency_code) }}</el-descriptions-item>
            <el-descriptions-item label="CEL 头程">{{ moneyText(detailDrawer.row.cel_fee_cny, detailDrawer.row.currency_code) }}</el-descriptions-item>
            <el-descriptions-item label="国内运费+代贴单">8.00</el-descriptions-item>
            <el-descriptions-item label="利润">
              <span :style="{ color: profitColor(detailDrawer.row), fontWeight: 800 }">{{ profitText(detailDrawer.row) }}</span>
            </el-descriptions-item>
          </el-descriptions>
          </el-descriptions>

          <el-divider content-position="left">商品清单 ({{ (detailDrawer.row.products || []).length }})</el-divider>
          <el-table :data="detailDrawer.row.products || []" size="small" border>
            <el-table-column label="图" width="60">
              <template #default="{ row }">
                <el-image :src="row.image" style="width:40px; height:40px; border-radius:4px; background:#f1f5f9" fit="cover" preview-teleported hide-on-click-modal :preview-src-list="row.image ? [row.image] : []">
                  <template #error><div style="height:40px; display:flex; align-items:center; justify-content:center; color:#cbd5e1; font-size:12px">无图</div></template>
                </el-image>
              </template>
            </el-table-column>
            <el-table-column label="商品" min-width="220" show-overflow-tooltip>
              <template #default="{ row }">
                <div>{{ row.name || '-' }}</div>
                <div style="font-size:12px; color:#94a3b8">货号 {{ row.offer_id || '-' }} · SKU {{ row.sku || '-' }}</div>
              </template>
            </el-table-column>
            <el-table-column label="数量" width="60" align="center">
              <template #default="{ row }">×{{ row.quantity || 1 }}</template>
            </el-table-column>
            <el-table-column label="单价" width="100" align="right">
              <template #default="{ row }">{{ moneyText(row.price, detailDrawer.row.currency_code) }}</template>
            </el-table-column>
          </el-table>

          <template v-if="detailDrawer.row.raw?.buyer && Object.keys(detailDrawer.row.raw.buyer).length > 1">
            <el-divider content-position="left">买家</el-divider>
            <el-descriptions :column="1" border size="small">
              <el-descriptions-item label="姓名">{{ [detailDrawer.row.raw.buyer.lastName, detailDrawer.row.raw.buyer.firstName, detailDrawer.row.raw.buyer.middleName].filter(Boolean).join(' ') || detailDrawer.row.raw.buyer.type || '-' }}</el-descriptions-item>
              <el-descriptions-item v-if="detailDrawer.row.raw.buyer.phone" label="电话">{{ detailDrawer.row.raw.buyer.phone }}</el-descriptions-item>
              <el-descriptions-item v-if="detailDrawer.row.raw.buyer.email" label="邮箱">{{ detailDrawer.row.raw.buyer.email }}</el-descriptions-item>
            </el-descriptions>
          </template>

          <template v-if="detailDrawer.row.raw?.delivery">
            <el-divider content-position="left">配送</el-divider>
            <el-descriptions :column="1" border size="small">
              <el-descriptions-item label="方式">{{ detailDrawer.row.raw.delivery.serviceName || detailDrawer.row.raw.delivery.type || '-' }}</el-descriptions-item>
              <el-descriptions-item v-if="detailDrawer.row.raw.delivery.dates" label="时间窗口">{{ detailDrawer.row.raw.delivery.dates.fromDate }} ~ {{ detailDrawer.row.raw.delivery.dates.toDate }}</el-descriptions-item>
              <el-descriptions-item v-if="detailDrawer.row.raw.delivery.address" label="地址">{{ detailDrawer.row.raw.delivery.address.region || '' }} {{ detailDrawer.row.raw.delivery.address.street || '' }} {{ detailDrawer.row.raw.delivery.address.house || '' }}</el-descriptions-item>
            </el-descriptions>
          </template>
        </template>
      </el-drawer>
    </div>
  `,
};
