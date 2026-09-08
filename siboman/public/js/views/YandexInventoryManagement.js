window.YandexInventoryManagementView = {
  setup() {
    const inventory = Vue.ref([]);
    const loading = Vue.ref(false);
    const syncing = Vue.ref(false);
    const search = Vue.ref('');
    const pagination = Vue.reactive({ currentPage: 1, pageSize: 50, total: 0 });
    const warehouses = Vue.ref([]);
    const warming = Vue.ref(false);
    const cachedAt = Vue.ref(0);
    const stale = Vue.ref(false);
    const syncError = Vue.ref('');
    const stockDialog = Vue.reactive({ visible: false, loading: false, row: null, stocks: [], submitting: false });
    const bulkDialog = Vue.reactive({ visible: false, submitting: false, scopeMode: 'filtered', warehouseMode: 'all', warehouseId: '', targetStock: 0, selectedRows: [], preview: [] });
    const selectedRows = Vue.ref([]);
    const threshold = Vue.ref(Math.max(1, Number(localStorage.getItem('yandexInvLowStockThreshold') || 5)));
    const storeName = Vue.ref('');
    let warmTimer = null;

    const notify = {
      success: (msg) => (window.ElementPlus?.ElMessage || console).success?.(msg),
      warning: (msg) => (window.ElementPlus?.ElMessage || console).warning?.(msg),
      error: (msg) => (window.ElementPlus?.ElMessage || console).error?.(msg),
    };

    const getStoreId = () => String(localStorage.getItem('currentStoreId') || '').trim();
    const totalStock = (row) => Number(row?.totalFit || 0);
    const totalAvail = (row) => Number(row?.totalAvail || 0);

    const fetchInventory = async (opts = {}) => {
      const sid = getStoreId();
      if (!sid) return notify.warning('请先选择 Yandex 店铺');
      loading.value = true;
      try {
        const res = await axios.get('/api/yandex/stocks', {
          params: {
            store_id: sid,
            search: search.value,
            page: pagination.currentPage,
            page_size: pagination.pageSize,
            ...(opts.refresh ? { refresh: 1 } : {}),
          },
        });
        if (res.data.warming && !res.data.items?.length) {
          warming.value = true;
          loading.value = false;
          warehouses.value = res.data.warehouses || [];
          if (warmTimer) clearTimeout(warmTimer);
          warmTimer = setTimeout(() => { if (warming.value) fetchInventory(); }, 5000);
          return;
        }
        warming.value = false;
        if (warmTimer) { clearTimeout(warmTimer); warmTimer = null; }
        inventory.value = res.data.items || [];
        pagination.total = Number(res.data.total || 0);
        warehouses.value = res.data.warehouses || [];
        cachedAt.value = Number(res.data.cached_at || 0);
        stale.value = Boolean(res.data.stale);
        syncError.value = res.data.error || '';
      } catch (e) {
        notify.error('查询失败: ' + (e.response?.data?.error || e.message));
      } finally {
        loading.value = false;
      }
    };

    const stats = Vue.computed(() => {
      const rows = inventory.value;
      return {
        total: pagination.total,
        outOfStock: rows.filter((r) => totalStock(r) === 0).length,
        lowStock: rows.filter((r) => totalStock(r) > 0 && totalStock(r) < threshold.value).length,
      };
    });

    const handleSyncAll = async () => {
      const sid = getStoreId();
      if (!sid) return notify.warning('请先选择店铺');
      syncing.value = true;
      try {
        const res = await axios.get('/api/yandex/stocks', {
          params: { store_id: sid, page: 1, page_size: 1, refresh: 1 },
        });
        if (res.data.warming) {
          notify.warning('已在后台开始全量同步 Yandex 库存，通常需 1-3 分钟，页面会自动刷新');
        } else {
          notify.success('Yandex 库存同步完成');
        }
        pagination.currentPage = 1;
        // 轮询直到快照更新
        const targetAt = Date.now();
        const poll = setInterval(async () => {
          try {
            const r = await axios.get('/api/yandex/stocks', {
              params: { store_id: sid, page: pagination.currentPage, page_size: pagination.pageSize },
            });
            if (!r.data.warming && r.data.cached_at > 0) {
              clearInterval(poll);
              inventory.value = r.data.items || [];
              pagination.total = Number(r.data.total || 0);
              warehouses.value = r.data.warehouses || [];
              cachedAt.value = Number(r.data.cached_at || 0);
              stale.value = Boolean(r.data.stale);
              if (r.data.cached_at >= targetAt - 3000) notify.success('Yandex 库存同步完成');
            }
          } catch { clearInterval(poll); }
        }, 5000);
        setTimeout(() => clearInterval(poll), 180000);
      } catch (e) {
        notify.error('同步失败: ' + (e.response?.data?.error || e.message));
      } finally {
        syncing.value = false;
      }
    };

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

    // 写操作后等待后端重建快照（update 接口已触发后台重拉），再刷新列表
    const refreshAfterWrite = async () => {
      const sid = getStoreId();
      const targetAt = Date.now();
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        try {
          const r = await axios.get('/api/yandex/stocks', {
            params: { store_id: sid, page: pagination.currentPage, page_size: pagination.pageSize },
          });
          if (r.data.warming) continue;
          if (r.data.cached_at > 0 && r.data.cached_at >= targetAt - 3000) {
            inventory.value = r.data.items || [];
            pagination.total = Number(r.data.total || 0);
            warehouses.value = r.data.warehouses || [];
            cachedAt.value = Number(r.data.cached_at || 0);
            stale.value = Boolean(r.data.stale);
            return;
          }
        } catch { return; }
      }
      fetchInventory();
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
        refreshAfterWrite();
      } catch (e) {
        notify.error('更新失败: ' + (e.response?.data?.error || e.message));
      } finally {
        stockDialog.submitting = false;
      }
    };

    // 批量可选的仓库 = 当前店铺下全部可用仓库（动态取自后端 stocks/warehouses 接口，非写死）
    // warehouses 元素形如 { id, name, campaignId }（business 级仓库列表）
    const bulkWarehouseOptions = Vue.computed(() => {
      const map = new Map();
      for (const w of (warehouses.value || [])) {
        const key = String(w.id ?? w.warehouseId);
        if (!key) continue;
        if (!map.has(key)) {
          map.set(key, {
            warehouseId: key,
            warehouseName: String(w.name || w.warehouseName || key),
            campaignId: String(w.campaignId || ''),
          });
        }
      }
      // 兼容旧缓存：若接口 warehouses 尚未就绪，退回从勾选行补全（仍带 campaignId 则保留）
      if (!map.size) {
        for (const r of (bulkDialog.selectedRows || [])) {
          for (const w of (r.perWarehouse || [])) {
            const key = String(w.warehouseId);
            if (!map.has(key)) map.set(key, { warehouseId: key, warehouseName: w.warehouseName || String(w.warehouseId), campaignId: String(w.campaignId || '') });
          }
        }
      }
      return Array.from(map.values());
    });

    // 批量：支持两种作用范围 ——
    //   scopeMode='selected'：只处理跨页勾选的行（reserve-selection 跨页保留勾选）
    //   scopeMode='filtered'：直接对"当前搜索/筛选结果的全部"批量（服务端按条件展开所有 offer，不依赖逐页勾选）
    const openBulkDialog = () => {
      const rows = selectedRows.value;
      bulkDialog.scopeMode = rows.length ? 'selected' : 'filtered';
      bulkDialog.selectedRows = rows;
      bulkDialog.warehouseMode = 'all';
      bulkDialog.warehouseId = bulkWarehouseOptions.value[0]?.warehouseId || '';
      bulkDialog.targetStock = 100;
      refreshBulkPreview();
      bulkDialog.visible = true;
    };

    const refreshBulkPreview = () => {
      const target = Math.max(0, Math.floor(Number(bulkDialog.targetStock) || 0));
      const whId = bulkDialog.warehouseMode === 'specific' ? bulkDialog.warehouseId : '';
      if (bulkDialog.scopeMode === 'filtered') {
        // 不枚举行：预览只统计"将影响的商品数（当前筛选总数）"，提交时后端按条件展开
        bulkDialog.preview = [{ _scope: true, offerId: '', name: `当前筛选结果全部商品（${pagination.total} 个）`, warehouseId: whId, warehouseName: whId ? '' : '全部仓库', current: 0, target }];
        return;
      }
      const rows = bulkDialog.selectedRows || [];
      const preview = [];
      for (const r of rows) {
        const whs = (r.perWarehouse || []).filter((w) => !whId || String(w.warehouseId) === String(whId));
        for (const w of whs) {
          preview.push({
            offerId: r.offerId,
            name: r.name || '',
            image: r.image || '',
            warehouseId: w.warehouseId,
            warehouseName: w.warehouseName || String(w.warehouseId),
            current: Number(w.fit || 0),
            target,
          });
        }
      }
      bulkDialog.preview = preview;
    };

    const submitBulkStock = async () => {
      bulkDialog.submitting = true;
      try {
        const sid = getStoreId();
        let payload;
        if (bulkDialog.scopeMode === 'filtered') {
          payload = {
            store_id: sid,
            scope: {
              search: search.value,
              stock: Math.max(0, Math.floor(Number(bulkDialog.targetStock) || 0)),
              ...(bulkDialog.warehouseMode === 'specific' && bulkDialog.warehouseId ? { warehouseId: bulkDialog.warehouseId } : {}),
            },
          };
        } else {
          const rows = bulkDialog.preview.filter((r) => !r._scope);
          if (!rows.length) return notify.warning('所选商品在当前仓库下无库存行');
          payload = {
            store_id: sid,
            items: rows.map((r) => ({ offerId: r.offerId, warehouseId: r.warehouseId, stock: r.target })),
          };
        }
        const res = await axios.post('/api/yandex/stocks/update', payload);
        const updatedRows = Number(res.data?.updated_rows || 0);
        const msg = bulkDialog.scopeMode === 'filtered'
          ? `已对当前筛选的全部商品提交库存更新（${updatedRows} 条行，${res.data.chunks || 1} 批）`
          : `已批量提交 ${bulkDialog.preview.length} 条库存更新到 Yandex（${res.data.chunks || 1} 批）`;
        notify.success(msg);
        bulkDialog.visible = false;
        selectedRows.value = [];
        // 保留当前页码与筛选，批量后只刷新数据不跳回第一页（方便定位刚才操作的位置）
        refreshAfterWrite();
      } catch (e) {
        notify.error('批量更新失败: ' + (e.response?.data?.error || e.message));
      } finally {
        bulkDialog.submitting = false;
      }
    };

    const onSelectionChange = (val) => { selectedRows.value = val || []; };
    const onThresholdChange = (v) => { threshold.value = Math.max(1, Number(v || 5)); localStorage.setItem('yandexInvLowStockThreshold', String(threshold.value)); };
    const onSearch = () => { pagination.currentPage = 1; fetchInventory(); };
    const resetSearch = () => { search.value = ''; pagination.currentPage = 1; fetchInventory(); };
    const onPageChange = () => fetchInventory();
    const onSizeChange = () => { pagination.currentPage = 1; fetchInventory(); };

    Vue.onMounted(() => {
      storeName.value = window.getCurrentStoreName ? window.getCurrentStoreName() : '';
      fetchInventory();
    });
    const onShopChanged = () => {
      pagination.currentPage = 1;
      inventory.value = [];
      pagination.total = 0;
      selectedRows.value = [];
      warehouses.value = [];
      warming.value = false;
      storeName.value = window.getCurrentStoreName ? window.getCurrentStoreName() : '';
      fetchInventory();
    };
    window.addEventListener('shop-changed', onShopChanged);
    Vue.onBeforeUnmount(() => {
      window.removeEventListener('shop-changed', onShopChanged);
      if (warmTimer) clearTimeout(warmTimer);
    });

    const fmtCachedAt = () => {
      if (!cachedAt.value) return '';
      const d = new Date(cachedAt.value);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };

    return {
      inventory, loading, syncing, search, pagination, warehouses, warming, stale, syncError, stats, threshold, storeName,
      stockDialog, bulkDialog, bulkWarehouseOptions, selectedRows, cachedAt, fmtCachedAt,
      fetchInventory, handleSyncAll, refreshAfterWrite, openStockEditor, submitStockChanges, openBulkDialog, refreshBulkPreview, submitBulkStock,
      onSelectionChange, onThresholdChange, onSearch, resetSearch, onPageChange, onSizeChange, totalStock, totalAvail,
    };
  },
  template: `
    <div class="erp-page" style="padding:18px 22px; background:#f8fafc; min-height:100%; box-sizing:border-box">
      <div style="max-width:1600px; margin:0 auto">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px; margin-bottom:16px">
          <div>
            <h1 class="erp-workbench-title" style="margin:0">Yandex 库存</h1>
            <div class="erp-muted" style="margin-top:6px">{{ storeName }} · 按 Yandex 仓库展示可售库存（FIT），可勾选多行后批量设置，支持跨页勾选</div>
          </div>
          <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end">
            <el-button size="large" :loading="loading" @click="fetchInventory()"><el-icon><Refresh /></el-icon><span>刷新</span></el-button>
            <el-button size="large" type="primary" :loading="syncing" @click="handleSyncAll"><el-icon><RefreshRight /></el-icon><span>同步 Yandex 全量</span></el-button>
          </div>
        </div>

        <div style="display:grid; grid-template-columns:repeat(3,minmax(150px,1fr)); border:1px solid #dfe7f1; border-radius:8px; overflow:hidden; background:#fff; margin-bottom:16px">
          <div style="padding:20px 24px; border-right:1px solid #dfe7f1"><div style="font-size:13px;color:#7c8798;font-weight:800;margin-bottom:10px">Yandex 商品数</div><strong style="font-size:28px;line-height:1;color:#111827;font-weight:900">{{ stats.total }}</strong></div>
          <div style="padding:20px 24px; border-right:1px solid #dfe7f1"><div style="font-size:13px;color:#7c8798;font-weight:800;margin-bottom:10px">当前页缺货</div><strong style="font-size:28px;line-height:1;color:#dc2626;font-weight:900">{{ stats.outOfStock }}</strong></div>
          <div style="padding:20px 24px"><div style="font-size:13px;color:#7c8798;font-weight:800;margin-bottom:10px">当前页低库存</div><strong style="font-size:28px;line-height:1;color:#d97706;font-weight:900">{{ stats.lowStock }}</strong></div>
        </div>

        <div v-if="warming" class="el-alert el-alert--info" style="margin-bottom:12px">
          <div style="display:flex; align-items:center; gap:10px; padding:10px 14px">
            <el-icon class="is-loading" color="#409eff"><Loading /></el-icon>
            <span style="font-size:14px; font-weight:700; color:#1f2937">正在从 Yandex 平台拉取全店库存数据（首次约需 1-3 分钟）...</span>
            <span style="font-size:12px; color:#64748b">就绪后自动显示，本页每 5 秒自动探测</span>
          </div>
        </div>

        <div v-if="cachedAt" style="display:flex; align-items:center; gap:10px; margin-bottom:10px; flex-wrap:wrap">
          <el-tag type="info" size="small">快照时间 {{ fmtCachedAt() }}</el-tag>
          <el-tag v-if="stale" type="warning" size="small">数据可能偏旧，后台正在刷新</el-tag>
          <el-tag v-if="syncError" type="danger" size="small">上次同步失败：{{ syncError }}</el-tag>
        </div>

        <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px; flex-wrap:wrap">
          <el-input v-model="search" clearable placeholder="搜索货号 (offerId) / 商品名称" size="large" style="width:min(420px,100%); max-width:420px" @keyup.enter="onSearch">
            <template #prefix><el-icon><Search /></el-icon></template>
          </el-input>
          <el-button size="large" type="primary" @click="onSearch">查询</el-button>
          <el-button size="large" @click="resetSearch">重置</el-button>
          <div style="flex:1"></div>
          <div style="display:flex; align-items:center; gap:6px">
            <span style="font-size:13px; color:#64748b; white-space:nowrap">低库存阈值</span>
            <el-input-number v-model="threshold" :min="1" :max="999" size="large" style="width:110px" @change="onThresholdChange" />
          </div>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:12px; flex-wrap:wrap">
          <div style="font-size:13px; color:#475569">
            <template v-if="selectedRows.length">已勾选 <b style="color:#2563eb">{{ selectedRows.length }}</b> 个商品（跨页勾选有效） · </template>
            当前筛选共 <b style="color:#111827">{{ pagination.total }}</b> 个商品
            <el-button v-if="!selectedRows.length" link type="primary" size="small" style="margin-left:8px" @click="fetchInventory">刷新统计</el-button>
          </div>
          <div style="flex:1"></div>
          <el-button size="large" type="warning" plain :disabled="!pagination.total" @click="openBulkDialog">
            批量设置库存
          </el-button>
        </div>

        <el-table :data="inventory" v-loading="loading" border stripe size="large" style="border-radius:8px; overflow:hidden"
          empty-text="暂无库存数据。点击右上角「同步 Yandex 全量」拉取数据，或调整搜索条件。"
          row-key="offerId" :reserve-selection="true" @selection-change="onSelectionChange">
          <el-table-column type="selection" width="52" reserve-selection />
          <el-table-column label="图片" width="88">
            <template #default="{ row }">
              <el-image v-if="row.image" :src="row.image" style="width:56px; height:56px; border-radius:6px; background:#f1f5f9" fit="cover" preview-teleported :preview-src-list="row.image ? [row.image] : []" hide-on-click-modal>
                <template #error><div style="width:56px;height:56px;background:#f1f5f9"></div></template>
              </el-image>
              <div v-else style="width:56px;height:56px;background:#f1f5f9;border-radius:6px;display:flex;align-items:center;justify-content:center"><el-icon color="#c0c4cc" size="20"><Picture /></el-icon></div>
            </template>
          </el-table-column>
          <el-table-column label="商品信息" min-width="300">
            <template #default="{ row }">
              <div style="font-size:14px; line-height:1.4; font-weight:800; color:#1f2937">{{ row.name || '(无名称)' }}</div>
              <div style="font-size:12px; color:#94a3b8; margin-top:5px">货号: <code>{{ row.offerId }}</code><span v-if="row.category" style="margin-left:8px">类目: {{ row.category }}</span></div>
            </template>
          </el-table-column>
          <el-table-column label="可售库存 (FIT)" width="160" align="right">
            <template #default="{ row }">
              <el-popover placement="top" :width="360" trigger="hover">
                <template #reference>
                  <span :style="{ cursor:'pointer', fontWeight:800, fontSize:'16px', color: totalStock(row) === 0 ? '#dc2626' : totalStock(row) < threshold ? '#d97706' : '#16a34a' }">{{ totalStock(row) }}</span>
                </template>
                <div>
                  <div style="font-size:13px; font-weight:bold; margin-bottom:8px; padding-bottom:6px; border-bottom:1px solid #eee">分仓库存明细</div>
                  <el-table v-if="(row.perWarehouse || []).length" :data="row.perWarehouse" size="small" border>
                    <el-table-column label="仓库"><template #default="{ row: s }"><b>{{ s.warehouseName }}</b></template></el-table-column>
                    <el-table-column label="FIT" width="80" align="right"><template #default="{ row: s }"><span style="font-weight:bold; color:#16a34a">{{ s.fit }}</span></template></el-table-column>
                    <el-table-column label="AVAILABLE" width="110" align="right"><template #default="{ row: s }"><span style="color:#e6a23c">{{ s.available }}</span></template></el-table-column>
                  </el-table>
                  <el-empty v-else description="暂无仓储数据" :image-size="50" />
                </div>
              </el-popover>
            </template>
          </el-table-column>
          <el-table-column label="可预留 AVAILABLE" width="150" align="right">
            <template #default="{ row }"><span style="color:#64748b; font-weight:700">{{ totalAvail(row) }}</span></template>
          </el-table-column>
          <el-table-column label="预警" width="90" align="center">
            <template #default="{ row }">
              <el-tag size="small" v-if="totalStock(row) === 0" type="danger">缺货</el-tag>
              <el-tag size="small" v-else-if="totalStock(row) < threshold" type="warning">低库存</el-tag>
              <el-tag size="small" v-else type="success">充足</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="130" fixed="right" align="center">
            <template #default="{ row }">
              <el-button link type="primary" @click="openStockEditor(row)">分仓修改</el-button>
            </template>
          </el-table-column>
        </el-table>

        <div style="position:sticky; bottom:0; margin-top:14px; padding:12px 0; background:#f8fafc; display:flex; justify-content:flex-end">
          <el-pagination
            v-model:current-page="pagination.currentPage"
            v-model:page-size="pagination.pageSize"
            :total="pagination.total"
            :page-sizes="[20, 50, 100, 200]"
            layout="total, sizes, prev, pager, next, jumper"
            @size-change="onSizeChange"
            @current-change="onPageChange"
          />
        </div>
      </div>

      <!-- 分仓修改弹窗 -->
      <el-dialog v-model="stockDialog.visible" :title="'分仓修改库存 — ' + (stockDialog.row?.offerId || '')" width="640px" destroy-on-close>
        <div v-if="stockDialog.row" style="display:flex; gap:12px; align-items:center; margin-bottom:14px; padding:10px; background:#f5f7fa; border-radius:6px">
          <el-image v-if="stockDialog.row.image" :src="stockDialog.row.image" style="width:48px;height:48px;border-radius:4px" fit="cover" />
          <div style="flex:1; font-size:13px; font-weight:600">{{ stockDialog.row.name || stockDialog.row.offerId }}</div>
        </div>
        <el-alert type="info" :closable="false" style="margin-bottom:12px" title="勾选要修改的仓库并输入新库存，点击提交后写入 Yandex（FIT）。" />
        <el-table :data="stockDialog.stocks" border size="large">
          <el-table-column label="仓库" prop="warehouseName" min-width="160" />
          <el-table-column label="当前库存" prop="currentFit" width="110" align="right" />
          <el-table-column label="修改" width="70" align="center">
            <template #default="{ row }"><el-checkbox v-model="row.selected" /></template>
          </el-table-column>
          <el-table-column label="新库存" width="150">
            <template #default="{ row }"><el-input-number v-model="row.newStock" :min="0" size="small" controls-position="right" style="width:130px" /></template>
          </el-table-column>
        </el-table>
        <template #footer>
          <el-button @click="stockDialog.visible = false">取消</el-button>
          <el-button type="primary" :loading="stockDialog.submitting" @click="submitStockChanges">提交到 Yandex</el-button>
        </template>
      </el-dialog>

      <!-- 批量设置库存弹窗 -->
      <el-dialog v-model="bulkDialog.visible" title="批量设置库存" width="760px" destroy-on-close>
        <el-alert type="info" :closable="false" show-icon style="margin-bottom:14px"
          :title="bulkDialog.scopeMode === 'filtered' ? '将对「当前搜索/筛选结果」的全部商品批量写入库存（FIT），不依赖逐页勾选，可一次处理整店几千个商品。' : '将对勾选的商品批量写入库存（FIT），勾选可跨页保留。'" />
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:14px">
          <div>
            <div style="font-size:13px; font-weight:700; margin-bottom:8px; color:#475569">处理对象</div>
            <el-radio-group v-model="bulkDialog.scopeMode" @change="refreshBulkPreview">
              <el-radio-button :label="'filtered'" :disabled="!pagination.total">当前筛选全部 ({{ pagination.total }})</el-radio-button>
              <el-radio-button :label="'selected'" :disabled="!selectedRows.length">已勾选 ({{ selectedRows.length }})</el-radio-button>
            </el-radio-group>
          </div>
          <div>
            <div style="font-size:13px; font-weight:700; margin-bottom:8px; color:#475569">目标库存数量</div>
            <el-input-number v-model="bulkDialog.targetStock" :min="0" :precision="0" :step="1" controls-position="right" style="width:180px" @change="refreshBulkPreview" />
          </div>
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:14px">
          <div>
            <div style="font-size:13px; font-weight:700; margin-bottom:8px; color:#475569">仓库</div>
            <el-radio-group v-model="bulkDialog.warehouseMode" @change="refreshBulkPreview">
              <el-radio-button label="all">全部仓库</el-radio-button>
              <el-radio-button label="specific">指定同一仓库</el-radio-button>
            </el-radio-group>
          </div>
          <div v-if="bulkDialog.warehouseMode === 'specific'">
            <div style="font-size:13px; font-weight:700; margin-bottom:8px; color:#475569">选择仓库</div>
            <el-select v-model="bulkDialog.warehouseId" filterable placeholder="选择仓库" style="width:100%" @change="refreshBulkPreview">
              <el-option v-for="w in bulkWarehouseOptions" :key="w.warehouseId" :label="w.warehouseName" :value="w.warehouseId" />
            </el-select>
          </div>
        </div>
        <div style="display:flex; justify-content:space-between; color:#64748b; font-size:12px; margin-bottom:8px">
          <template v-if="bulkDialog.scopeMode === 'filtered'">
            <span>将按当前搜索条件{{ search ? '（"' + search + '"）' : '' }}批量设置：{{ pagination.total }} 个商品</span>
            <span>每个商品写入选中的每个仓库（FIT）</span>
          </template>
          <template v-else>
            <span>将生成 {{ bulkDialog.preview.filter(r => !r._scope).length }} 条库存更新</span>
            <span>覆盖 {{ bulkDialog.selectedRows.length }} 个勾选商品</span>
          </template>
        </div>
        <el-table v-if="bulkDialog.scopeMode === 'selected'" :data="bulkDialog.preview.slice(0, 8)" size="small" border max-height="240">
          <el-table-column label="图片" width="60"><template #default="{ row }"><el-image v-if="row.image" :src="row.image" style="width:40px;height:40px;border-radius:4px" fit="cover" /><div v-else style="width:40px;height:40px;background:#f1f5f9"></div></template></el-table-column>
          <el-table-column prop="offerId" label="货号" min-width="150" show-overflow-tooltip />
          <el-table-column prop="warehouseName" label="仓库" min-width="110" />
          <el-table-column prop="current" label="当前" width="80" align="right" />
          <el-table-column prop="target" label="目标" width="80" align="right" />
        </el-table>
        <div v-else style="border:1px dashed #cbd5e1; border-radius:6px; padding:18px; text-align:center; color:#64748b; background:#f8fafc">
          当前筛选 {{ pagination.total }} 个商品将在提交时由服务端全部展开处理（数量多时自动分批提交，无需逐页勾选）。
        </div>
        <div v-if="bulkDialog.scopeMode === 'selected' && bulkDialog.preview.filter(r => !r._scope).length > 8" style="font-size:12px; color:#94a3b8; margin-top:6px">仅预览前 8 条，其余会一起提交。</div>
        <template #footer>
          <el-button @click="bulkDialog.visible = false">取消</el-button>
          <el-button type="primary" :loading="bulkDialog.submitting" @click="submitBulkStock">提交到 Yandex</el-button>
        </template>
      </el-dialog>
    </div>
  `,
};
