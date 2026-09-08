window.YandexInventoryManagementView = {
  setup() {
    const inventory = Vue.ref([]);
    const loading = Vue.ref(false);
    const search = Vue.ref('');
    const pagination = Vue.reactive({ currentPage: 1, pageSize: 50, total: 0 });
    const warehouses = Vue.ref([]);
    const warming = Vue.ref(false);
    const stockDialog = Vue.reactive({ visible: false, loading: false, row: null, stocks: [], submitting: false });
    const bulkDialog = Vue.reactive({ visible: false, submitting: false, warehouseId: '', targetStock: 0, submitNow: false, selectedRows: [] });
    const selectedRows = Vue.ref([]);
    const threshold = Vue.ref(Math.max(1, Number(localStorage.getItem('yandexInvLowStockThreshold') || 5)));
    const storeName = Vue.ref('');
    let warmTimer = null;
    let warmCountInterval = null;
    const warmSeconds = Vue.ref(0);

    const notify = {
      success: (msg) => (window.ElementPlus?.ElMessage || console).success?.(msg),
      warning: (msg) => (window.ElementPlus?.ElMessage || console).warning?.(msg),
      error: (msg) => (window.ElementPlus?.ElMessage || console).error?.(msg),
    };

    const getStoreId = () => String(localStorage.getItem('currentStoreId') || '').trim();
    const totalStock = (row) => Number(row?.totalFit || 0);

    const fetchInventory = async () => {
      const sid = getStoreId();
      if (!sid) return notify.warning('请先选择 Yandex 店铺');
      loading.value = true;
      try {
        const res = await axios.get('/api/yandex/stocks', {
          params: { store_id: sid, search: search.value, page: pagination.currentPage, page_size: pagination.pageSize },
        });
        if (res.data.warming) {
          warming.value = true;
          loading.value = false; // 不遮罩，让预热提示可见
          inventory.value = [];
          pagination.total = 0;
          warehouses.value = res.data.warehouses || [];
          // 倒计时 + 轮询
          if (!warmCountInterval) {
            warmSeconds.value = 0;
            warmCountInterval = setInterval(() => { warmSeconds.value += 1; }, 1000);
          }
          if (warmTimer) clearTimeout(warmTimer);
          warmTimer = setTimeout(() => { if (warming.value) fetchInventory(); }, 10000);
          return;
        }
        warming.value = false;
        if (warmCountInterval) { clearInterval(warmCountInterval); warmCountInterval = null; }
        inventory.value = res.data.items || [];
        pagination.total = Number(res.data.total || 0);
        warehouses.value = res.data.warehouses || [];
      } catch (e) {
        notify.error('查询失败: ' + (e.response?.data?.error || e.message));
      } finally {
        loading.value = false;
      }
    };

    const stats = Vue.computed(() => ({
      total: pagination.total,
      outOfStock: inventory.value.filter((r) => totalStock(r) === 0).length,
      lowStock: inventory.value.filter((r) => totalStock(r) > 0 && totalStock(r) < threshold.value).length,
    }));

    const openStockEditor = (row) => {
      stockDialog.row = row;
      stockDialog.stocks = (row.perWarehouse || []).map((w) => ({
        warehouseId: w.warehouseId,
        warehouseName: w.warehouseName || String(w.warehouseId),
        currentFit: Number(w.fit || 0),
        newStock: Number(w.fit || 0),
        selected: false,
      }));
      stockDialog.visible = true;
    };

    const submitStockChanges = async () => {
      const changed = stockDialog.stocks.filter((s) => s.selected && Number(s.newStock) !== Number(s.currentFit));
      if (!changed.length) return notify.warning('请勾选要修改的仓库并调整数量');
      stockDialog.submitting = true;
      try {
        const sid = getStoreId();
        const res = await axios.post('/api/yandex/stocks/update', {
          store_id: sid,
          items: changed.map((s) => ({ offerId: stockDialog.row.offerId, warehouseId: s.warehouseId, stock: Number(s.newStock) })),
        });
        notify.success(`已提交 ${changed.length} 条库存更新到 Yandex`);
        stockDialog.visible = false;
        fetchInventory();
      } catch (e) {
        notify.error('更新失败: ' + (e.response?.data?.error || e.message));
      } finally {
        stockDialog.submitting = false;
      }
    };

    const openBulkDialog = () => {
      if (!selectedRows.value.length) return notify.warning('请先勾选商品');
      bulkDialog.selectedRows = selectedRows.value;
      bulkDialog.warehouseId = (warehouses.value[0] || {}).id || '';
      bulkDialog.targetStock = 100;
      bulkDialog.submitNow = false;
      bulkDialog.visible = true;
    };

    const submitBulkStock = async () => {
      const rows = bulkDialog.selectedRows;
      if (!rows.length || !bulkDialog.warehouseId) return notify.warning('请选择仓库和商品');
      bulkDialog.submitting = true;
      try {
        const sid = getStoreId();
        const items = rows.flatMap((r) =>
          (r.perWarehouse || []).some((w) => w.warehouseId === bulkDialog.warehouseId)
            ? [{ offerId: r.offerId, warehouseId: bulkDialog.warehouseId, stock: Number(bulkDialog.targetStock) }]
            : [{ offerId: r.offerId, warehouseId: bulkDialog.warehouseId, stock: Number(bulkDialog.targetStock) }]
        );
        const res = await axios.post('/api/yandex/stocks/update', { store_id: sid, items });
        notify.success(`已批量提交 ${items.length} 条库存更新`);
        bulkDialog.visible = false;
        selectedRows.value = [];
        fetchInventory();
      } catch (e) {
        notify.error('批量更新失败: ' + (e.response?.data?.error || e.message));
      } finally {
        bulkDialog.submitting = false;
      }
    };

    const handleSelectionChange = (val) => { selectedRows.value = val; };
    const onThresholdChange = (v) => { threshold.value = Math.max(1, Number(v || 5)); localStorage.setItem('yandexInvLowStockThreshold', String(threshold.value)); };
    const resetSearch = () => { search.value = ''; pagination.currentPage = 1; fetchInventory(); };

    Vue.onMounted(() => {
      storeName.value = window.getCurrentStoreName ? window.getCurrentStoreName() : '';
      fetchInventory();
    });

    return {
      inventory, loading, search, pagination, warehouses, warming, warmSeconds, stats, threshold, storeName,
      stockDialog, bulkDialog, selectedRows,
      fetchInventory, openStockEditor, submitStockChanges, openBulkDialog, submitBulkStock,
      handleSelectionChange, onThresholdChange, resetSearch, totalStock,
    };
  },
  template: `
    <div class="erp-page" style="padding:18px 22px">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:10px">
        <div>
          <h1 class="erp-workbench-title">Yandex 库存管理</h1>
          <div class="erp-muted">{{ storeName }} · 按 Yandex 仓库实时展示可售库存（FIT），支持分仓修改与批量设值</div>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap">
          <el-tag type="info" size="large">总 {{ stats.total }}</el-tag>
          <el-tag type="danger" size="large" v-if="stats.outOfStock">缺货 {{ stats.outOfStock }}</el-tag>
          <el-tag type="warning" size="large" v-if="stats.lowStock">低库存 {{ stats.lowStock }}</el-tag>
        </div>
      </div>

      <div class="erp-filter-row" style="margin-bottom:12px">
        <el-input v-model="search" clearable placeholder="搜索货号 (offerId)" style="width:320px" @keyup.enter="resetSearch" />
        <el-button type="primary" @click="resetSearch">查询</el-button>
        <el-input-number v-model="threshold" :min="1" :max="999" size="large" style="width:120px" @change="onThresholdChange" />
        <span style="font-size:13px; color:#64748b">低库存阈值</span>
        <el-button type="warning" plain :disabled="!selectedRows.length" @click="openBulkDialog">批量设置库存</el-button>
      </div>

      <el-alert v-if="warming" type="info" :closable="false" style="margin-bottom:10px" show-icon>
        <template #title>
          <div style="font-size:14px; font-weight:700">正在从 Yandex 平台拉取全店库存数据，请稍候...</div>
        </template>
        <div style="font-size:13px; color:#64748b; margin-top:4px">
          首次加载需 2-4 分钟（全店商品分页拉取），数据就绪后自动显示。已等待 {{ warmSeconds }} 秒。
          <el-button link type="primary" @click="fetchInventory" style="margin-left:8px">立即重试</el-button>
        </div>
      </el-alert>

      <el-table :data="inventory" v-loading="loading && !warming" border stripe @selection-change="handleSelectionChange" max-height="640" empty-text="暂无库存数据">
        <el-table-column type="selection" width="46" />
        <el-table-column label="货号 (offerId)" prop="offerId" min-width="200" show-overflow-tooltip />
        <el-table-column label="仓库" min-width="160">
          <template #default="{ row }">
            <div v-for="w in (row.perWarehouse || [])" :key="w.warehouseId" style="font-size:12px; color:#475569">{{ w.warehouseName || w.warehouseId }}</div>
          </template>
        </el-table-column>
        <el-table-column label="可售库存 (FIT)" width="130" align="right">
          <template #default="{ row }">
            <span :style="{ fontWeight:800, color: totalStock(row) === 0 ? '#dc2626' : totalStock(row) < threshold ? '#f59e0b' : '#16a34a' }">{{ totalStock(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="可预留 (AVAILABLE)" width="140" align="right">
          <template #default="{ row }"><span style="color:#64748b">{{ row.totalAvail || 0 }}</span></template>
        </el-table-column>
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }">
            <div v-for="w in (row.perWarehouse || [])" :key="'t'+w.warehouseId" style="font-size:11px; color:#94a3b8">{{ String(w.updatedAt || '').slice(0, 19) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="110" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openStockEditor(row)">分仓修改</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination style="margin-top:12px; justify-content:flex-end" v-model:current-page="pagination.currentPage"
        v-model:page-size="pagination.pageSize" :total="pagination.total" :page-sizes="[20,50,100,200]"
        layout="total, sizes, prev, pager, next" @current-change="fetchInventory" @size-change="fetchInventory" />

      <!-- 分仓修改弹窗 -->
      <el-dialog v-model="stockDialog.visible" :title="'分仓修改库存 — ' + (stockDialog.row?.offerId || '')" width="620px" destroy-on-close>
        <el-table :data="stockDialog.stocks" border size="large">
          <el-table-column label="仓库" prop="warehouseName" min-width="160" />
          <el-table-column label="当前库存" prop="currentFit" width="100" align="right" />
          <el-table-column label="修改" width="80" align="center">
            <template #default="{ row }"><el-checkbox v-model="row.selected" /></template>
          </el-table-column>
          <el-table-column label="新库存" width="140">
            <template #default="{ row }"><el-input-number v-model="row.newStock" :min="0" size="small" controls-position="right" style="width:120px" /></template>
          </el-table-column>
        </el-table>
        <template #footer>
          <el-button @click="stockDialog.visible = false">取消</el-button>
          <el-button type="primary" :loading="stockDialog.submitting" @click="submitStockChanges">提交到 Yandex</el-button>
        </template>
      </el-dialog>

      <!-- 批量设值弹窗 -->
      <el-dialog v-model="bulkDialog.visible" title="批量设置库存" width="480px" destroy-on-close>
        <el-form label-position="top">
          <el-form-item label="目标仓库">
            <el-select v-model="bulkDialog.warehouseId" style="width:100%">
              <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="目标库存数量">
            <el-input-number v-model="bulkDialog.targetStock" :min="0" size="large" style="width:100%" />
          </el-form-item>
        </el-form>
        <div style="font-size:13px; color:#64748b">将把 {{ bulkDialog.selectedRows.length }} 个商品的库存设为 {{ bulkDialog.targetStock }}，提交后立即生效。</div>
        <template #footer>
          <el-button @click="bulkDialog.visible = false">取消</el-button>
          <el-button type="primary" :loading="bulkDialog.submitting" @click="submitBulkStock">提交到 Yandex</el-button>
        </template>
      </el-dialog>
    </div>
  `,
};
