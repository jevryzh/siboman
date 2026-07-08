window.SourcingModuleView = {
  setup() {
    const activeTab = Vue.ref('category');
    const loading = Vue.ref(false);
    const tableData = Vue.ref([]);
    const pagination = Vue.reactive({ currentPage: 1, pageSize: 20, total: 0 });
    // v0.3.2: 动态取店铺 ID
    const getStoreId = () => (window.getCurrentStoreId ? window.getCurrentStoreId() : (localStorage.getItem('currentStoreId') || ''));

    const fetchData = async () => {
      const sid = getStoreId();
      if (!sid) return;
      loading.value = true;
      try {
        const endpoint = activeTab.value === 'category' ? '/api/seller/analytics/categories' : '/api/seller/analytics/bestsellers';
        const res = await axios.post(endpoint, {
          store_id: sid,
          limit: pagination.pageSize,
          offset: (pagination.currentPage - 1) * pagination.pageSize,
        });

        if (activeTab.value === 'category') {
          tableData.value = (res.data.data?.result?.data || []).map(i => ({
            name: i.dimensions[0]?.name,
            revenue: i.metrics[1],
            sales: i.metrics[0],
            returnRate: (i.metrics[0] > 0 ? (i.metrics[2] / i.metrics[0] * 100) : 0).toFixed(1) + '%'
          }));
        } else {
          tableData.value = res.data.data?.result?.items || [];
        }
        pagination.total = res.data.total || tableData.value.length;
      } finally {
        loading.value = false;
      }
    };

    const handlePageChange = () => { fetchData(); };

    Vue.onMounted(fetchData);
    const onShopChanged = () => {
      pagination.currentPage = 1;
      tableData.value = [];
      pagination.total = 0;
      fetchData();
    };
    window.addEventListener('shop-changed', onShopChanged);
    Vue.onBeforeUnmount(() => window.removeEventListener('shop-changed', onShopChanged));

    return { activeTab, tableData, loading, pagination, fetchData, handlePageChange };
  },
  template: `
    <div class="sourcing-view">
      <el-card>
        <template #header>
          <el-tabs v-model="activeTab" @tab-change="() => { pagination.currentPage = 1; fetchData(); }">
            <el-tab-pane label="类目分析" name="category" />
            <el-tab-pane label="热销榜单" name="bestseller" />
          </el-tabs>
        </template>

        <el-table :data="tableData" v-loading="loading" stripe border>
          <template v-if="activeTab === 'category'">
            <el-table-column label="类目名称" prop="name" />
            <el-table-column label="近期销售额 (RUB)" prop="revenue" sortable />
            <el-table-column label="销量" prop="sales" sortable />
            <el-table-column label="退货率" prop="returnRate" />
          </template>
          <template v-else>
            <el-table-column label="排行" type="index" width="60" />
            <el-table-column label="商品信息" prop="name" />
            <el-table-column label="指数" prop="index" width="100" />
          </template>
        </el-table>

        <div style="margin-top: 20px; display: flex; justify-content: flex-end">
          <el-pagination
            v-model:current-page="pagination.currentPage"
            :page-size="pagination.pageSize"
            :total="pagination.total"
            layout="total, prev, pager, next"
            @current-change="handlePageChange"
          />
        </div>
      </el-card>
    </div>
  `
};
