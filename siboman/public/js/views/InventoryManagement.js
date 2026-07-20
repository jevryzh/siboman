window.InventoryManagementView = {
  setup() {
    const inventory = Vue.ref([]);
    const loading = Vue.ref(false);
    const syncLoading = Vue.ref(false);
    const search = Vue.ref('');
    const drafts = Vue.ref([]);
    const draftLoading = Vue.ref(false);
    const importInput = Vue.ref(null);
    const importLoading = Vue.ref(false);
    const threshold = Vue.ref(Math.max(1, Number(localStorage.getItem('inventoryLowStockThreshold') || 5)));
    const pagination = Vue.reactive({ currentPage: 1, pageSize: 50, total: 0 });

    // v0.3.4 分仓修改弹窗
    const stockDialog = Vue.reactive({
      visible: false,
      loading: false,
      row: null,          // 当前编辑商品
      warehouses: [],     // 仓库列表
      stocks: [],         // [{warehouse_id, warehouse_name, stock}]
      submitting: false,
    });

    // v0.3.2: 动态读取当前店铺 ID
    const getStoreId = () => (window.getCurrentStoreId ? window.getCurrentStoreId() : (localStorage.getItem('currentStoreId') || ''));

    const notify = {
      success: (msg) => (window.ElementPlus?.ElMessage || console).success?.(msg),
      warning: (msg) => (window.ElementPlus?.ElMessage || console).warning?.(msg),
      error: (msg) => (window.ElementPlus?.ElMessage || console).error?.(msg),
    };

    const submitWithConflictCheck = async (url, payload, config = {}) => {
      try {
        return await axios.post(url, payload, config);
      } catch (error) {
        const data = error.response?.data || {};
        if (error.response?.status !== 409 || data.code !== 'STOCK_CONFLICT') throw error;
        const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
        const details = conflicts.slice(0, 8).map((item) =>
          `${item.offer_id} / 仓${item.warehouse_id}: 原 ${item.expected_stock}，现 ${item.live_stock}，目标 ${item.target_stock}`
        ).join('\n');
        try {
          await window.ElementPlus.ElMessageBox.confirm(
            `${conflicts.length} 条库存已被其他操作修改：\n${details}${conflicts.length > 8 ? '\n…' : ''}\n\n是否以当前草稿目标库存覆盖？`,
            '发现 Ozon 实时库存冲突',
            { type: 'warning', confirmButtonText: '确认覆盖', cancelButtonText: '取消', dangerouslyUseHTMLString: false },
          );
        } catch {
          const cancelled = new Error('已取消覆盖实时库存');
          cancelled.code = 'STOCK_CONFLICT_CANCELLED';
          throw cancelled;
        }
        return axios.post(url, { ...payload, force: true }, config);
      }
    };

    const fetchInventory = async () => {
      const sid = getStoreId();
      if (!sid) return;
      loading.value = true;
      try {
        const res = await axios.get('/api/inventory', {
          params: { store_id: sid, search: search.value, limit: pagination.pageSize, offset: (pagination.currentPage - 1) * pagination.pageSize },
        });
        inventory.value = res.data.items || [];
        pagination.total = Number(res.data.total || 0);
      } catch (e) {
        notify.error('查询失败: ' + (e.response?.data?.error || e.message));
      } finally {
        loading.value = false;
      }
    };

    const fetchDrafts = async () => {
      const sid = getStoreId();
      if (!sid) return;
      try {
        const res = await axios.get('/api/seller/stocks/drafts', { params: { store_id: sid } });
        drafts.value = res.data.items || [];
      } catch (e) { notify.error('库存草稿加载失败: ' + (e.response?.data?.error || e.message)); }
    };

    const refreshAll = async () => Promise.all([fetchInventory(), fetchDrafts()]);
    const inventoryStats = Vue.computed(() => ({
      total: pagination.total,
      outOfStock: inventory.value.filter((row) => totalStock(row) === 0).length,
      lowStock: inventory.value.filter((row) => totalStock(row) > 0 && totalStock(row) < threshold.value).length,
      drafts: drafts.value.length,
    }));
    const onThresholdChange = (value) => {
      threshold.value = Math.max(1, Number(value || 5));
      localStorage.setItem('inventoryLowStockThreshold', String(threshold.value));
    };

    const handleSyncAll = async () => {
      const sid = getStoreId();
      if (!sid) return notify.warning('请先选择店铺');
      syncLoading.value = true;
      try {
        const res = await axios.post('/api/seller/products/sync-all', { store_id: sid }, { timeout: 300000 });
        notify.success(`成功从 Ozon 同步 ${res.data.count} 个商品`);
        pagination.currentPage = 1;
        fetchInventory();
      } catch (e) {
        notify.error('同步失败: ' + (e.response?.data?.error || e.message));
      } finally {
        syncLoading.value = false;
      }
    };

    // v0.3.5 打开分仓修改弹窗 - 优先调新的 /stocks/detail 接口 (含未使用仓库)
    const openStockEditor = async (row) => {
      stockDialog.row = row;
      stockDialog.visible = true;
      stockDialog.loading = true;
      stockDialog.warehouses = [];
      stockDialog.stocks = [];
      try {
        // 优先调 detail 接口: 已经合并了 warehouse 列表 + 本地 stocks_json + 未覆盖仓补 0
        const detailRes = await axios.get('/api/seller/products/stocks/detail', {
          params: { store_id: getStoreId(), offer_id: row.offer_id },
        });
        const whs = detailRes.data.warehouses || [];
        stockDialog.warehouses = whs;
        stockDialog.stocks = whs.map(w => ({
          warehouse_id: w.warehouse_id,
          warehouse_name: w.name,
          city: w.city,
          source: w.source,
          present: Number(w.present || 0),
          reserved: Number(w.reserved || 0),
          new_stock: Number(w.present || 0),
          selected: false,
          has_stock: w.has_stock,
        }));
        for (const stock of stockDialog.stocks) {
          const draft = drafts.value.find((item) => item.offer_id === row.offer_id && Number(item.warehouse_id) === Number(stock.warehouse_id));
          if (draft) {
            stock.new_stock = Number(draft.target_stock);
            stock.selected = true;
            stock.draft_id = draft.id;
            stock.last_error = draft.last_error || '';
          }
        }
      } catch (e) {
        // Fallback: detail 失败时走旧的 warehouses + parseStocks 组合
        console.warn('[stock-editor] detail 接口失败, 回退旧逻辑:', e.message);
        try {
          const whRes = await axios.get('/api/seller/warehouses', { params: { store_id: getStoreId() } });
          const whs = whRes.data.warehouses || [];
          const existingStocks = parseStocks(row);
          stockDialog.warehouses = whs;
          stockDialog.stocks = whs.map(w => {
            const hit = existingStocks.find(s => Number(s.warehouse_id) === Number(w.warehouse_id))
                      || (existingStocks[0] || {});
            return {
              warehouse_id: w.warehouse_id,
              warehouse_name: w.name,
              city: w.city,
              source: hit?.source || (w.is_rfbs ? 'rfbs' : 'fbs'),
              present: Number(hit?.present || 0),
              reserved: Number(hit?.reserved || 0),
              new_stock: Number(hit?.present || 0),
              selected: false,
            };
          });
        } catch (e2) {
          notify.error('加载仓库失败: ' + (e2.response?.data?.error || e2.message));
        }
      } finally {
        stockDialog.loading = false;
      }
    };

    const submitStockChanges = async () => {
      const changed = stockDialog.stocks.filter(s => s.selected && Number(s.new_stock) !== Number(s.present));
      if (!changed.length) return notify.warning('请勾选要修改的仓库并调整数量');
      stockDialog.submitting = true;
      try {
        const stocks = changed.map(s => ({
          offer_id: stockDialog.row.offer_id,
          product_id: stockDialog.row.product_id,
          warehouse_id: Number(s.warehouse_id),
          stock: Number(s.new_stock),
          expected_stock: Number(s.present),
        }));
        const res = await submitWithConflictCheck('/api/seller/products/stocks', { store_id: getStoreId(), stocks });
        const draftIds = changed.map((stock) => stock.draft_id).filter(Boolean);
        if (draftIds.length) {
          await axios.delete('/api/seller/stocks/drafts', { data: { store_id: getStoreId(), ids: draftIds } });
        }
        notify.success(`已提交 ${stocks.length} 个仓库的库存变更至 Ozon`);
        stockDialog.visible = false;
        setTimeout(refreshAll, 800);
      } catch (e) {
        if (e.code === 'STOCK_CONFLICT_CANCELLED') return;
        notify.error('提交失败: ' + (e.response?.data?.payload?.message || e.response?.data?.error || e.message));
      } finally {
        stockDialog.submitting = false;
      }
    };

    const saveStockDrafts = async () => {
      const selected = stockDialog.stocks.filter((stock) => stock.selected);
      if (!selected.length) return notify.warning('请勾选要保存的仓库');
      if (selected.some((stock) => Number(stock.new_stock) < 0)) return notify.warning('库存不能小于 0');
      stockDialog.submitting = true;
      try {
        const res = await axios.post('/api/seller/stocks/save-draft', {
          store_id: getStoreId(),
          stocks: selected.map((stock) => ({
            offer_id: stockDialog.row.offer_id,
            product_id: stockDialog.row.product_id,
            warehouse_id: stock.warehouse_id,
            current_stock: stock.present,
            target_stock: stock.new_stock,
          })),
        });
        notify.success(`已保存 ${res.data.saved || 0} 条库存草稿`);
        stockDialog.visible = false;
        await fetchDrafts();
      } catch (e) { notify.error('保存草稿失败: ' + (e.response?.data?.error || e.message)); }
      finally { stockDialog.submitting = false; }
    };

    const submitAllDrafts = async () => {
      if (!drafts.value.length) return notify.warning('没有待提交的库存草稿');
      try {
        await window.ElementPlus.ElMessageBox.confirm(
          `确定将 ${drafts.value.length} 条库存草稿提交到 Ozon？`,
          '批量提交库存',
          { type: 'warning', confirmButtonText: '确认提交', cancelButtonText: '取消' },
        );
      } catch { return; }
      draftLoading.value = true;
      try {
        const res = await submitWithConflictCheck('/api/seller/products/stocks/bulk', { store_id: getStoreId() }, { validateStatus: (status) => status === 200 || status === 207 });
        const message = `提交 ${res.data.submitted || 0} 条：成功 ${res.data.succeeded || 0}，失败 ${res.data.failed || 0}`;
        if (res.data.failed) notify.warning(message); else notify.success(message);
        await refreshAll();
      } catch (e) {
        if (e.code !== 'STOCK_CONFLICT_CANCELLED') notify.error('批量提交失败: ' + (e.response?.data?.error || e.message));
      }
      finally { draftLoading.value = false; }
    };

    const clearDrafts = async () => {
      if (!drafts.value.length) return;
      try {
        await window.ElementPlus.ElMessageBox.confirm('确定清空当前店铺全部库存草稿？', '清空草稿', { type: 'warning' });
      } catch { return; }
      try {
        await axios.delete('/api/seller/stocks/drafts', { data: { store_id: getStoreId() } });
        drafts.value = [];
        notify.success('库存草稿已清空');
      } catch (e) { notify.error('清空失败: ' + (e.response?.data?.error || e.message)); }
    };

    const importStocks = async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      if (!window.XLSX) return notify.error('Excel 解析组件加载失败，请刷新页面后重试');
      importLoading.value = true;
      try {
        const workbook = window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = window.XLSX.utils.sheet_to_json(sheet, { defval: '' });
        if (!rows.length) return notify.warning('文件中没有数据');
        const res = await axios.post('/api/seller/stocks/import', { store_id: getStoreId(), rows });
        const message = `导入完成：成功 ${res.data.imported || 0}，失败 ${res.data.failed || 0}`;
        if (res.data.failed) {
          const sample = (res.data.errors || []).slice(0, 3).map(item => `第${item.row}行 ${item.offer_id || ''}: ${item.error}`).join('；');
          notify.warning(`${message}。${sample}`);
        } else notify.success(message);
        await fetchDrafts();
      } catch (e) { notify.error('导入失败: ' + (e.response?.data?.error || e.message)); }
      finally { importLoading.value = false; }
    };

    const downloadTemplate = () => {
      const sheet = window.XLSX.utils.json_to_sheet([{ offer_id: '示例货号', stock: 10, warehouse_id: '' }]);
      const book = window.XLSX.utils.book_new(); window.XLSX.utils.book_append_sheet(book, sheet, '库存导入');
      window.XLSX.writeFile(book, '库存导入模板.xlsx');
    };

    const exportReplenishment = () => {
      const rows = inventory.value.filter(row => totalStock(row) < threshold.value).map(row => ({
        'Offer ID': row.offer_id, '商品名称': row.name, '当前库存': totalStock(row), '建议补货': Math.max(0, threshold.value * 2 - totalStock(row)), '1688链接': row.source_url_1688 || '', '近7天销量': row.sales_7d || '',
      }));
      if (!rows.length) return notify.warning('当前页没有需要补货的商品');
      const sheet = window.XLSX.utils.json_to_sheet(rows); const book = window.XLSX.utils.book_new(); window.XLSX.utils.book_append_sheet(book, sheet, '预补货单'); window.XLSX.writeFile(book, `预补货单-${new Date().toISOString().slice(0, 10)}.xlsx`);
    };

    const onPageChange = () => fetchInventory();
    const onSizeChange = () => { pagination.currentPage = 1; fetchInventory(); };
    const onSearch = () => { pagination.currentPage = 1; fetchInventory(); };

    // v0.3.3 分仓工具
    const parseStocks = (row) => {
      const raw = row?.stocks_json;
      if (!raw) return [];
      if (Array.isArray(raw)) return raw;
      try { return JSON.parse(raw); } catch { return []; }
    };
    const totalStock = (row) => {
      const arr = parseStocks(row);
      if (!arr.length) return Number(row.stock || 0);
      return arr.reduce((s, x) => s + (Number(x.present) || 0), 0);
    };
    const totalReserved = (row) => parseStocks(row).reduce((s, x) => s + (Number(x.reserved) || 0), 0);
    const warehouseCount = (row) => parseStocks(row).length;
    const warehouseLabel = (source) => {
      const map = { fbs: 'FBS 卖家仓', fbo: 'FBO 官方仓', crossborder: '跨境仓', rfbs: 'RFBS 自发货' };
      return map[String(source || '').toLowerCase()] || String(source || '未知仓');
    };
    const warehouseTagType = (source) => ({ fbs: 'primary', fbo: 'success', crossborder: 'warning', rfbs: 'info' }[String(source || '').toLowerCase()] || 'info');

    Vue.onMounted(refreshAll);
    const onShopChanged = () => { pagination.currentPage = 1; inventory.value = []; drafts.value = []; pagination.total = 0; refreshAll(); };
    window.addEventListener('shop-changed', onShopChanged);
    Vue.onBeforeUnmount(() => window.removeEventListener('shop-changed', onShopChanged));

    return {
      inventory, loading, syncLoading, search, pagination, stockDialog,
      drafts, draftLoading, importInput, importLoading, threshold, inventoryStats,
      fetchInventory, handleSyncAll, openStockEditor, submitStockChanges,
      fetchDrafts, refreshAll, onThresholdChange, saveStockDrafts, submitAllDrafts, clearDrafts, importStocks, downloadTemplate, exportReplenishment,
      onPageChange, onSizeChange, onSearch,
      parseStocks, totalStock, totalReserved, warehouseCount, warehouseLabel, warehouseTagType,
    };
  },
  template: `
    <div class="inventory-container">
      <el-card>
        <template #header>
          <div style="display:flex; justify-content:space-between; align-items:center">
            <div style="display:flex; align-items:center; gap:12px">
              <span style="font-weight:bold">库存管理 (v0.3.4)</span>
              <el-tag size="small" type="info">共 {{ pagination.total }} 个 SKU</el-tag>
              <el-button type="warning" size="small" :loading="syncLoading" @click="handleSyncAll">同步 Ozon 全量</el-button>
              <el-button type="primary" size="small" :disabled="!drafts.length" :loading="draftLoading" @click="submitAllDrafts">提交草稿 ({{ drafts.length }})</el-button>
              <el-button size="small" :disabled="!drafts.length" @click="clearDrafts">清空草稿</el-button>
              <el-button size="small" :loading="importLoading" @click="importInput?.click()">导入库存</el-button>
              <el-button size="small" @click="downloadTemplate">下载模板</el-button>
              <el-button size="small" @click="exportReplenishment">导出预补货单</el-button>
              <input ref="importInput" type="file" accept=".csv,.xlsx,.xls" style="display:none" @change="importStocks" />
            </div>
            <div style="display:flex; gap:8px">
              <span style="font-size:12px; color:#606266; align-self:center">低库存阈值</span>
              <el-input-number :model-value="threshold" :min="1" :max="9999" size="small" style="width:100px" @change="onThresholdChange" />
              <el-input v-model="search" placeholder="货号 / 商品名" size="small" style="width:240px" @keyup.enter="onSearch" clearable />
              <el-button type="primary" size="small" @click="onSearch">查询</el-button>
            </div>
          </div>
        </template>

        <div style="display:grid; grid-template-columns:repeat(4,minmax(140px,1fr)); border:1px solid #ebeef5; margin-bottom:16px">
          <div style="padding:14px 18px; border-right:1px solid #ebeef5"><div style="font-size:12px;color:#909399">商品总数</div><strong style="font-size:24px">{{ inventoryStats.total }}</strong></div>
          <div style="padding:14px 18px; border-right:1px solid #ebeef5"><div style="font-size:12px;color:#909399">当前页缺货</div><strong style="font-size:24px;color:#f56c6c">{{ inventoryStats.outOfStock }}</strong></div>
          <div style="padding:14px 18px; border-right:1px solid #ebeef5"><div style="font-size:12px;color:#909399">当前页低库存</div><strong style="font-size:24px;color:#e6a23c">{{ inventoryStats.lowStock }}</strong></div>
          <div style="padding:14px 18px"><div style="font-size:12px;color:#909399">暂存待提交</div><strong style="font-size:24px;color:#409eff">{{ inventoryStats.drafts }}</strong></div>
        </div>

        <el-table :data="inventory" v-loading="loading" stripe border size="small">
          <!-- v0.3.4: 图片放大 60x60 + 点击预览大图 -->
          <el-table-column label="图片" width="80">
            <template #default="{ row }">
              <el-image
                :src="row.image"
                style="width:60px; height:60px; border-radius:6px; cursor:zoom-in; border:1px solid #ebeef5"
                fit="cover"
                preview-teleported
                :preview-src-list="Array.isArray(row.images) && row.images.length ? row.images : (row.image ? [row.image] : [])"
                :initial-index="0"
                hide-on-click-modal>
                <template #error>
                  <div style="width:60px; height:60px; background:#f5f7fa; display:flex; align-items:center; justify-content:center">
                    <el-icon color="#c0c4cc" size="24"><Picture /></el-icon>
                  </div>
                </template>
              </el-image>
            </template>
          </el-table-column>

          <el-table-column label="商品信息" min-width="240">
            <template #default="{ row }">
              <div style="font-size:13px; font-weight:500">{{ row.name }}</div>
              <div style="font-size:11px; color:#999; margin-top:2px">
                货号: <code>{{ row.offer_id }}</code>
                <span v-if="row.sku"> · SKU {{ row.sku }}</span>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="品牌" prop="brand" width="120" show-overflow-tooltip />

          <el-table-column label="当前库存 (分仓)" width="220">
            <template #default="{ row }">
              <el-popover placement="top" :width="320" trigger="hover">
                <template #reference>
                  <div style="display:flex; align-items:center; gap:8px; cursor:pointer">
                    <el-tag size="small" :type="totalStock(row) < threshold ? 'danger' : 'success'" style="font-weight:bold; font-size:13px">
                      {{ totalStock(row) }}
                    </el-tag>
                    <span style="font-size:11px; color:#999">{{ warehouseCount(row) }} 仓</span>
                    <el-icon size="12" color="#999"><InfoFilled /></el-icon>
                  </div>
                </template>
                <div>
                  <div style="font-size:13px; font-weight:bold; margin-bottom:8px; padding-bottom:6px; border-bottom:1px solid #eee">分仓库存明细</div>
                  <el-empty v-if="!parseStocks(row).length" description="暂无仓储数据" :image-size="60" />
                  <el-table v-else :data="parseStocks(row)" size="small" :show-header="true" border>
                    <el-table-column label="仓库">
                      <template #default="{ row: s }">
                        <el-tag size="small" :type="warehouseTagType(s.source)">{{ warehouseLabel(s.source) }}</el-tag>
                      </template>
                    </el-table-column>
                    <el-table-column label="可用" width="70" align="right">
                      <template #default="{ row: s }">
                        <span style="font-weight:bold; color:#67c23a">{{ s.present || 0 }}</span>
                      </template>
                    </el-table-column>
                    <el-table-column label="预留" width="70" align="right">
                      <template #default="{ row: s }">
                        <span style="color:#e6a23c">{{ s.reserved || 0 }}</span>
                      </template>
                    </el-table-column>
                  </el-table>
                  <div style="margin-top:8px; font-size:11px; color:#666">
                    汇总: 可用 <b style="color:#67c23a">{{ totalStock(row) }}</b> · 预留 <b style="color:#e6a23c">{{ totalReserved(row) }}</b>
                  </div>
                </div>
              </el-popover>
            </template>
          </el-table-column>

          <el-table-column label="预警" width="90">
            <template #default="{ row }">
              <el-tag size="small" v-if="totalStock(row) === 0" type="danger">缺货</el-tag>
              <el-tag size="small" v-else-if="totalStock(row) < threshold" type="warning">低库存</el-tag>
              <el-tag size="small" v-else type="success">充足</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="重量(g)" prop="weight" width="80" />
          <el-table-column label="最后同步" width="150">
            <template #default="{ row }">
              <span style="font-size:11px; color:#666">{{ (row.updated_at || '').slice(0,19).replace('T',' ') }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="130" fixed="right">
            <template #default="{ row }">
              <el-button type="primary" size="small" @click="openStockEditor(row)">分仓修改</el-button>
            </template>
          </el-table-column>
        </el-table>

        <!-- v0.3.4 sticky 分页 -->
        <div style="position:sticky; bottom:0; left:0; right:0; margin:20px -20px -20px; padding:12px 20px; background:#fff; border-top:1px solid #ebeef5; z-index:10; display:flex; justify-content:flex-end; box-shadow:0 -2px 6px rgba(0,0,0,0.04)">
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
      </el-card>

      <!-- v0.3.4 分仓库存修改对话框 -->
      <el-dialog v-model="stockDialog.visible" width="720px" :title="'分仓库存调整 · ' + (stockDialog.row?.offer_id || '')" destroy-on-close>
        <div v-loading="stockDialog.loading">
          <div v-if="stockDialog.row" style="display:flex; gap:12px; align-items:center; margin-bottom:15px; padding:10px; background:#f5f7fa; border-radius:6px">
            <el-image :src="stockDialog.row.image" style="width:50px; height:50px; border-radius:4px" fit="cover" />
            <div style="flex:1">
              <div style="font-size:13px; font-weight:500">{{ stockDialog.row.name }}</div>
              <div style="font-size:11px; color:#999">货号 {{ stockDialog.row.offer_id }} · SKU {{ stockDialog.row.sku || '-' }}</div>
            </div>
          </div>

          <el-alert type="info" :closable="false" style="margin-bottom:12px">
            勾选要修改的仓库, 输入新库存数量后点击"提交至 Ozon"。仅勾选且数值有变化的仓库会被同步。
          </el-alert>

          <el-table :data="stockDialog.stocks" size="small" border>
            <el-table-column width="55" align="center">
              <template #default="{ row }">
                <el-checkbox v-model="row.selected" />
              </template>
            </el-table-column>
            <el-table-column label="仓库名称" min-width="180">
              <template #default="{ row }">
                <div>
                  <div style="font-weight:500">{{ row.warehouse_name }}</div>
                  <div style="font-size:11px; color:#999">{{ row.city }}</div>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="类型" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="warehouseTagType(row.source)">{{ warehouseLabel(row.source) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="当前" width="70" align="right">
              <template #default="{ row }">
                <span style="color:#67c23a; font-weight:bold">{{ row.present }}</span>
              </template>
            </el-table-column>
            <el-table-column label="预留" width="70" align="right">
              <template #default="{ row }">
                <span style="color:#e6a23c">{{ row.reserved }}</span>
              </template>
            </el-table-column>
            <el-table-column label="新库存" width="140">
              <template #default="{ row }">
                <div><el-input-number v-model="row.new_stock" :min="0" size="small" :disabled="!row.selected" style="width:120px" /></div>
                <div v-if="row.last_error" style="font-size:10px; color:#f56c6c; margin-top:3px" :title="row.last_error">上次提交失败</div>
              </template>
            </el-table-column>
          </el-table>
          <div v-if="!stockDialog.stocks.length && !stockDialog.loading" style="text-align:center; padding:30px; color:#999">
            当前店铺尚未开通任何 FBS 仓库
          </div>
        </div>
        <template #footer>
          <el-button @click="stockDialog.visible = false">取消</el-button>
          <el-button type="success" plain :loading="stockDialog.submitting" @click="saveStockDrafts">保存草稿</el-button>
          <el-button type="primary" :loading="stockDialog.submitting" @click="submitStockChanges">
            立即提交至 Ozon
          </el-button>
        </template>
      </el-dialog>
    </div>
  `
};
