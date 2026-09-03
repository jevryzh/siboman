window.YandexOrderListView = {
  setup() {
    const orders = Vue.ref([]);
    const loading = Vue.ref(false);
    const hasFetched = Vue.ref(false);
    const activeTab = Vue.ref('all');
    const search = Vue.ref('');
    const pagination = Vue.reactive({ currentPage: 1, pageSize: 20, total: 0 });
    const apiReady = Vue.ref(true);

    const notify = {
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

    const fetchOrders = async () => {
      loading.value = true;
      try {
        const res = await axios.get('/api/yandex/orders', {
          params: {
            status: activeTab.value,
            q: search.value,
            page: pagination.currentPage,
            page_size: pagination.pageSize,
          },
        });
        orders.value = res.data?.items || res.data?.orders || [];
        pagination.total = Number(res.data?.total || orders.value.length || 0);
        apiReady.value = res.data?.api_ready !== false;
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

    const resetFilters = () => {
      search.value = '';
      activeTab.value = 'all';
      pagination.currentPage = 1;
      fetchOrders();
    };

    Vue.onMounted(fetchOrders);

    return {
      orders, loading, hasFetched, activeTab, search, pagination, apiReady, statusTabs,
      statusText, statusTagType, primaryProduct, moneyText, fetchOrders, resetFilters,
    };
  },
  template: `
    <div>
      <div class="erp-toolbar">
        <div>
          <h1 class="erp-workbench-title">Yandex 订单</h1>
          <div class="erp-muted">字段先按 Ozon 订单管理复制，后续接 Yandex API 后同步订单、商品、金额和发货状态。</div>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap">
          <el-button size="large" @click="fetchOrders">
            <el-icon><RefreshRight /></el-icon><span>刷新</span>
          </el-button>
          <el-button size="large" type="primary" disabled>
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
        :empty-text="hasFetched ? '暂无 Yandex 订单数据；等待 API 接入后可同步。' : '正在读取订单...'"
        style="border-radius:8px; overflow:hidden">
        <el-table-column type="selection" width="48" />
        <el-table-column label="订单号" min-width="180" fixed="left" show-overflow-tooltip>
          <template #default="{ row }"><b>{{ row.order_id || row.posting_number || '-' }}</b></template>
        </el-table-column>
        <el-table-column label="商品" min-width="320">
          <template #default="{ row }">
            <div style="display:flex; gap:12px; align-items:center; min-width:0">
              <el-image :src="primaryProduct(row).image" style="width:58px; height:58px; border-radius:8px; background:#f1f5f9; flex-shrink:0" fit="cover" preview-teleported>
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
          <template #default="{ row }">{{ moneyText(row.total || row.total_rub, row.currency_code || 'RUB') }}</template>
        </el-table-column>
        <el-table-column label="下单时间" width="180">
          <template #default="{ row }">{{ (row.created_at || row.in_process_at || '').replace('T',' ').slice(0,19) || '-' }}</template>
        </el-table-column>
        <el-table-column label="发货截止" width="180">
          <template #default="{ row }">{{ (row.shipment_date || row.delivery_date || '').replace('T',' ').slice(0,19) || '-' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right">
          <template #default>
            <el-button link type="primary" disabled>详情</el-button>
            <el-button link type="warning" disabled>发货</el-button>
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
    </div>
  `,
};
