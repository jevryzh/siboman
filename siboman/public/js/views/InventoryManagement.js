window.InventoryManagementView = {
  setup() {
    const inventory = Vue.ref([]);
    const loading = Vue.ref(false);
    const syncLoading = Vue.ref(false);
    const search = Vue.ref('');
    const drafts = Vue.ref([]);
    const selectedInventory = Vue.ref([]);
    const draftLoading = Vue.ref(false);
    const importInput = Vue.ref(null);
    const importLoading = Vue.ref(false);
    const logDialog = Vue.reactive({ visible: false, loading: false, items: [] });
    const lastImportResult = Vue.ref(null);
    const lastSubmitResult = Vue.ref(null);
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
    const bulkStockDialog = Vue.reactive({
      visible: false,
      submitting: false,
      warehouseMode: 'default',
      warehouse_id: '',
      target_stock: 0,
      submitNow: false,
      preview: [],
    });

    // v0.3.2: 动态读取当前店铺 ID
    const getStoreId = () => String(
      window.getCurrentStoreId ? window.getCurrentStoreId() : (localStorage.getItem('currentStoreId') || ''),
    ).split(',').map((value) => value.trim()).find(Boolean) || '';

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
    const selectedStockRows = () => selectedInventory.value || [];
    const firstStock = (row) => parseStocks(row).find((stock) => Number(stock.warehouse_id) > 0) || null;
    const selectedWarehouseOptions = Vue.computed(() => {
      const map = new Map();
      for (const row of selectedStockRows()) {
        for (const stock of parseStocks(row)) {
          const wid = Number(stock.warehouse_id || 0);
          if (!wid || map.has(wid)) continue;
          map.set(wid, {
            warehouse_id: wid,
            label: `${stock.warehouse_name || stock.name || warehouseLabel(stock.source)} / ${wid}`,
          });
        }
      }
      return Array.from(map.values());
    });
    const buildBulkStockRows = () => {
      const targetStock = Math.floor(Number(bulkStockDialog.target_stock));
      if (!Number.isFinite(targetStock) || targetStock < 0) return [];
      return selectedStockRows().map((row) => {
        const stock = bulkStockDialog.warehouseMode === 'specific'
          ? parseStocks(row).find((item) => Number(item.warehouse_id) === Number(bulkStockDialog.warehouse_id))
          : firstStock(row);
        if (!stock) return null;
        return {
          offer_id: row.offer_id,
          product_id: row.product_id,
          warehouse_id: Number(stock.warehouse_id),
          current_stock: Number(stock.present ?? row.stock ?? 0),
          target_stock: targetStock,
          name: row.name,
        };
      }).filter(Boolean);
    };
    const refreshBulkStockPreview = () => {
      bulkStockDialog.preview = buildBulkStockRows();
    };
    const openBulkStockEditor = () => {
      if (!selectedInventory.value.length) return notify.warning('请先勾选要批量修改库存的商品');
      bulkStockDialog.warehouseMode = 'default';
      bulkStockDialog.warehouse_id = selectedWarehouseOptions.value[0]?.warehouse_id || '';
      bulkStockDialog.target_stock = 0;
      bulkStockDialog.submitNow = false;
      refreshBulkStockPreview();
      bulkStockDialog.visible = true;
    };
    const saveBulkStockDrafts = async () => {
      const rows = buildBulkStockRows();
      if (!rows.length) return notify.warning('所选商品没有可用仓库，或目标库存无效');
      const skipped = selectedInventory.value.length - rows.length;
      bulkStockDialog.submitting = true;
      try {
        const res = await axios.post('/api/seller/stocks/save-draft', { store_id: getStoreId(), stocks: rows });
        const savedIds = (res.data.items || []).map((item) => item.id).filter(Boolean);
        if (bulkStockDialog.submitNow) {
          const submitRes = await submitWithConflictCheck('/api/seller/products/stocks/bulk', {
            store_id: getStoreId(),
            ids: savedIds,
          }, { validateStatus: (status) => status === 200 || status === 207 });
          lastSubmitResult.value = {
            submitted: submitRes.data.submitted || 0,
            succeeded: submitRes.data.succeeded || 0,
            failed: submitRes.data.failed || 0,
            errors: Array.isArray(submitRes.data.errors) ? submitRes.data.errors : [],
          };
          notify.success(`已提交 ${submitRes.data.succeeded || 0} 条库存变更${skipped ? `，跳过 ${skipped} 个无仓库商品` : ''}`);
        } else {
          notify.success(`已保存 ${res.data.saved || 0} 条库存草稿${skipped ? `，跳过 ${skipped} 个无仓库商品` : ''}`);
        }
        bulkStockDialog.visible = false;
        selectedInventory.value = [];
        await refreshAll();
      } catch (e) {
        if (e.code !== 'STOCK_CONFLICT_CANCELLED') notify.error('批量修改库存失败: ' + (e.response?.data?.error || e.message));
      } finally {
        bulkStockDialog.submitting = false;
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
        lastSubmitResult.value = {
          submitted: res.data.submitted || 0,
          succeeded: res.data.succeeded || 0,
          failed: res.data.failed || 0,
          errors: Array.isArray(res.data.errors) ? res.data.errors : [],
        };
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
        lastImportResult.value = {
          imported: res.data.imported || 0,
          failed: res.data.failed || 0,
          errors: Array.isArray(res.data.errors) ? res.data.errors : [],
        };
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

    const openChangeLogs = async () => {
      logDialog.visible = true;
      logDialog.loading = true;
      try {
        const res = await axios.get('/api/seller/stocks/change-logs', { params: { store_id: getStoreId(), limit: 100 } });
        logDialog.items = res.data.items || [];
      } catch (e) {
        notify.error('变更记录加载失败: ' + (e.response?.data?.error || e.message));
      } finally { logDialog.loading = false; }
    };

    const exportReplenishment = () => {
      const rows = inventory.value.filter(row => totalStock(row) < threshold.value).map(row => ({
        'Offer ID': row.offer_id, '商品名称': row.name, '当前库存': totalStock(row), '建议补货': Math.max(0, threshold.value * 2 - totalStock(row)), '1688链接': row.source_url_1688 || '', '近7天销量': row.sales_7d || '',
      }));
      if (!rows.length) return notify.warning('当前页没有需要补货的商品');
      const sheet = window.XLSX.utils.json_to_sheet(rows); const book = window.XLSX.utils.book_new(); window.XLSX.utils.book_append_sheet(book, sheet, '预补货单'); window.XLSX.writeFile(book, `预补货单-${new Date().toISOString().slice(0, 10)}.xlsx`);
    };

    const onSelectionChange = (rows) => { selectedInventory.value = rows || []; };
    const onPageChange = () => fetchInventory();
    const onSizeChange = () => { pagination.currentPage = 1; fetchInventory(); };
    const onSearch = () => { pagination.currentPage = 1; fetchInventory(); };
    let searchTimer = null;
    const onSearchInput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(onSearch, 400);
    };

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
    const handleInventoryAction = ({ action, row }) => {
      if (action === 'stock') openStockEditor(row);
    };

    Vue.onMounted(refreshAll);
    const onShopChanged = () => { pagination.currentPage = 1; inventory.value = []; drafts.value = []; pagination.total = 0; refreshAll(); };
    window.addEventListener('shop-changed', onShopChanged);
    Vue.onBeforeUnmount(() => {
      clearTimeout(searchTimer);
      window.removeEventListener('shop-changed', onShopChanged);
    });

    return {
      inventory, loading, syncLoading, search, pagination, stockDialog, bulkStockDialog, selectedInventory, selectedWarehouseOptions,
      drafts, draftLoading, importInput, importLoading, logDialog, threshold, inventoryStats, lastImportResult, lastSubmitResult,
      fetchInventory, handleSyncAll, openStockEditor, submitStockChanges, openBulkStockEditor, refreshBulkStockPreview, saveBulkStockDrafts,
      fetchDrafts, refreshAll, onThresholdChange, saveStockDrafts, submitAllDrafts, clearDrafts, importStocks, downloadTemplate, exportReplenishment, openChangeLogs,
      onSelectionChange, onPageChange, onSizeChange, onSearch, onSearchInput, handleInventoryAction,
      parseStocks, totalStock, totalReserved, warehouseCount, warehouseLabel, warehouseTagType,
    };
  },
  template: `
    <div class="inventory-container" style="background:#f8fafc; min-height:100%; padding:22px 30px 28px; box-sizing:border-box">
      <div style="max-width:1500px; margin:0 auto">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px; margin-bottom:18px">
          <div>
            <div style="font-size:28px; line-height:1.2; font-weight:900; color:#111827">库存</div>
            <div style="margin-top:14px; font-size:14px; color:#64748b; font-weight:700">
              共 {{ pagination.total }} 个当前 Ozon SKU · {{ drafts.length }} 条草稿
            </div>
          </div>
          <div style="display:flex; gap:10px; justify-content:flex-end; flex-wrap:wrap">
            <el-button size="large" @click="refreshAll">
              <el-icon><Refresh /></el-icon><span>刷新</span>
            </el-button>
            <el-button size="large" type="primary" style="background:#111827; border-color:#111827" :loading="syncLoading" @click="handleSyncAll">
              <el-icon><RefreshRight /></el-icon><span>同步 Ozon 全量</span>
            </el-button>
            <el-button size="large" type="primary" plain :disabled="!drafts.length" :loading="draftLoading" @click="submitAllDrafts">提交草稿 ({{ drafts.length }})</el-button>
            <el-button size="large" @click="openChangeLogs">变更记录</el-button>
          </div>
        </div>

        <div style="display:grid; grid-template-columns:repeat(4,minmax(160px,1fr)); border:1px solid #dfe7f1; border-radius:8px; overflow:hidden; background:#fff; margin-bottom:22px">
          <div style="padding:24px 26px; border-right:1px solid #dfe7f1"><div style="font-size:13px;color:#7c8798;font-weight:800;margin-bottom:12px">当前 Ozon 商品</div><strong style="font-size:32px;line-height:1;color:#111827;font-weight:900">{{ inventoryStats.total }}</strong></div>
          <div style="padding:24px 26px; border-right:1px solid #dfe7f1"><div style="font-size:13px;color:#7c8798;font-weight:800;margin-bottom:12px">当前页缺货</div><strong style="font-size:32px;line-height:1;color:#dc2626;font-weight:900">{{ inventoryStats.outOfStock }}</strong></div>
          <div style="padding:24px 26px; border-right:1px solid #dfe7f1"><div style="font-size:13px;color:#7c8798;font-weight:800;margin-bottom:12px">当前页低库存</div><strong style="font-size:32px;line-height:1;color:#d97706;font-weight:900">{{ inventoryStats.lowStock }}</strong></div>
          <div style="padding:24px 26px"><div style="font-size:13px;color:#7c8798;font-weight:800;margin-bottom:12px">暂存待提交</div><strong style="font-size:32px;line-height:1;color:#2563eb;font-weight:900">{{ inventoryStats.drafts }}</strong></div>
        </div>

        <el-alert
          v-if="lastImportResult && lastImportResult.failed"
          type="warning"
          :closable="false"
          show-icon
          style="margin-bottom:12px"
          title="上次库存导入有失败行"
          :description="'成功 ' + lastImportResult.imported + '，失败 ' + lastImportResult.failed + '。请根据下方失败明细修正 Excel 后重新导入。'" />
        <div v-if="lastImportResult && lastImportResult.errors && lastImportResult.errors.length" style="margin-bottom:12px; border:1px solid #faecd8; background:#fffaf0; padding:10px 12px; border-radius:6px">
          <div style="font-size:12px; font-weight:700; color:#a16207; margin-bottom:6px">库存导入失败明细</div>
          <div v-for="(item, index) in lastImportResult.errors.slice(0, 8)" :key="'import-' + index" style="font-size:12px; color:#7c2d12; line-height:1.7">
            第 {{ item.row || '-' }} 行 <code>{{ item.offer_id || '-' }}</code>：{{ item.error || item.message || '未知错误' }}
          </div>
          <div v-if="lastImportResult.errors.length > 8" style="font-size:12px; color:#909399; margin-top:4px">其余 {{ lastImportResult.errors.length - 8 }} 条请查看后端返回或分批修正。</div>
        </div>

        <el-alert
          v-if="lastSubmitResult && lastSubmitResult.failed"
          type="error"
          :closable="false"
          show-icon
          style="margin-bottom:12px"
          title="上次提交 Ozon 库存有失败"
          :description="'已提交 ' + lastSubmitResult.submitted + '，成功 ' + lastSubmitResult.succeeded + '，失败 ' + lastSubmitResult.failed + '。失败草稿不会自动消失，请按明细处理后重试。'" />
        <div v-if="lastSubmitResult && lastSubmitResult.errors && lastSubmitResult.errors.length" style="margin-bottom:12px; border:1px solid #fde2e2; background:#fef0f0; padding:10px 12px; border-radius:6px">
          <div style="font-size:12px; font-weight:700; color:#b91c1c; margin-bottom:6px">库存提交失败明细</div>
          <div v-for="(item, index) in lastSubmitResult.errors.slice(0, 8)" :key="'submit-' + index" style="font-size:12px; color:#991b1b; line-height:1.7">
            <code>{{ item.offer_id || '-' }}</code>
            <span v-if="item.warehouse_id"> / 仓 {{ item.warehouse_id }}</span>：{{ item.error || item.message || '未知错误' }}
          </div>
          <div v-if="lastSubmitResult.errors.length > 8" style="font-size:12px; color:#909399; margin-top:4px">仅展示前 8 条，完整记录可打开“变更记录”。</div>
        </div>

        <div style="display:grid; grid-template-columns:minmax(280px,1fr) 88px 88px 120px 120px; gap:10px; align-items:center; margin-bottom:12px">
          <el-input v-model="search" placeholder="搜索货号 / 商品名" size="large" @input="onSearchInput" @keyup.enter="onSearch" clearable>
            <template #prefix><el-icon><Search /></el-icon></template>
          </el-input>
          <el-button size="large" type="primary" style="background:#111827; border-color:#111827" @click="onSearch">筛选</el-button>
          <el-button size="large" @click="search=''; pagination.currentPage=1; fetchInventory()">重置</el-button>
          <el-button size="large" type="warning" plain :loading="importLoading" @click="importInput?.click()">
            <el-icon><UploadFilled /></el-icon><span>导入</span>
          </el-button>
          <el-button size="large" @click="downloadTemplate">
            <el-icon><Download /></el-icon><span>模板</span>
          </el-button>
          <input ref="importInput" type="file" accept=".csv,.xlsx,.xls" style="display:none" @change="importStocks" />
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:18px">
          <div style="display:flex; gap:10px; flex-wrap:wrap">
            <el-button size="large" type="primary" plain :disabled="!selectedInventory.length" @click="openBulkStockEditor">批量改库存 ({{ selectedInventory.length }})</el-button>
            <el-button size="large" @click="exportReplenishment">导出预补货单</el-button>
            <el-button size="large" :disabled="!drafts.length" @click="clearDrafts">清空草稿</el-button>
          </div>
        </div>

        <div v-if="selectedInventory.length" style="display:flex; justify-content:space-between; align-items:center; padding:12px 14px; margin-bottom:14px; background:#eff6ff; border:1px solid #bfdbfe; border-radius:8px">
          <span style="font-size:13px; color:#1e3a8a; font-weight:800">已选择 {{ selectedInventory.length }} 个商品</span>
          <el-button type="primary" size="large" @click="openBulkStockEditor">批量设置库存</el-button>
        </div>

        <el-table :data="inventory" v-loading="loading" element-loading-text="正在读取库存" stripe border size="large" style="border-radius:8px; overflow:hidden; box-shadow:0 8px 24px rgba(15,23,42,.04)" empty-text="暂无库存数据。请先选择店铺并点击同步 Ozon 全量；如已同步，可调整搜索条件。" @selection-change="onSelectionChange">
          <el-table-column type="selection" width="52" />
          <!-- v0.3.4: 图片放大 60x60 + 点击预览大图 -->
          <el-table-column label="图片" width="92">
            <template #default="{ row }">
              <el-image
                :src="row.image"
                style="width:58px; height:58px; border-radius:8px; cursor:zoom-in; background:#f1f5f9"
                fit="cover"
                preview-teleported
                :preview-src-list="Array.isArray(row.images) && row.images.length ? row.images : (row.image ? [row.image] : [])"
                :initial-index="0"
                hide-on-click-modal>
                <template #error>
                  <div style="width:58px; height:58px; background:#f1f5f9; display:flex; align-items:center; justify-content:center; border-radius:8px">
                    <el-icon color="#c0c4cc" size="24"><Picture /></el-icon>
                  </div>
                </template>
              </el-image>
            </template>
          </el-table-column>

          <el-table-column label="商品信息" min-width="380">
            <template #default="{ row }">
              <div style="font-size:15px; line-height:1.4; font-weight:800; color:#1f2937">{{ row.name }}</div>
              <div style="font-size:12px; color:#94a3b8; margin-top:7px">
                货号: <code>{{ row.offer_id }}</code>
                <span v-if="row.sku"> · SKU {{ row.sku }}</span>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="品牌" prop="brand" width="120" show-overflow-tooltip />

          <el-table-column label="当前库存" width="190">
            <template #default="{ row }">
              <el-popover placement="top" :width="320" trigger="hover">
                <template #reference>
                  <div style="display:flex; align-items:center; gap:8px; cursor:pointer">
                    <el-tag size="large" :type="totalStock(row) < threshold ? 'danger' : 'success'" style="font-weight:900; font-size:15px">
                      {{ totalStock(row) }}
                    </el-tag>
                    <span style="font-size:12px; color:#64748b; font-weight:700">{{ warehouseCount(row) }} 仓 · 预留 {{ totalReserved(row) }}</span>
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
          <el-table-column label="重量(g)" prop="weight" width="90" />
          <el-table-column label="最后同步" width="150">
            <template #default="{ row }">
              <span style="font-size:11px; color:#666">{{ (row.updated_at || '').slice(0,19).replace('T',' ') }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="76" fixed="right" align="center">
            <template #default="{ row }">
              <el-dropdown trigger="click" placement="bottom-end" @command="handleInventoryAction">
                <el-button link type="primary" style="font-size:18px; padding:0 8px">
                  <el-icon><MoreFilled /></el-icon>
                </el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item :command="{ action: 'stock', row }">
                      <el-icon><EditPen /></el-icon><span>分仓修改</span>
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </template>
          </el-table-column>
        </el-table>

        <!-- v0.3.4 sticky 分页 -->
        <div style="position:sticky; bottom:0; left:0; right:0; margin-top:14px; padding:12px 0; background:#f8fafc; z-index:10; display:flex; justify-content:flex-end">
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

      <el-dialog v-model="logDialog.visible" title="库存变更记录" width="900px" destroy-on-close>
        <el-table :data="logDialog.items" v-loading="logDialog.loading" border stripe size="small" max-height="560">
          <el-table-column prop="created_at" label="时间" width="170">
            <template #default="{ row }">{{ (row.created_at || '').slice(0,19).replace('T',' ') }}</template>
          </el-table-column>
          <el-table-column prop="offer_id" label="货号" min-width="150" />
          <el-table-column prop="warehouse_id" label="仓库 ID" width="130" />
          <el-table-column prop="previous_stock" label="原库存" width="90" align="right" />
          <el-table-column prop="target_stock" label="目标库存" width="90" align="right" />
          <el-table-column label="结果" width="90">
            <template #default="{ row }">
              <el-tag size="small" :type="row.status === 'success' ? 'success' : (row.status === 'conflict' ? 'warning' : 'danger')">
                {{ row.status === 'success' ? '成功' : (row.status === 'conflict' ? '冲突' : '失败') }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="error" label="说明" min-width="220" show-overflow-tooltip />
        </el-table>
      </el-dialog>

      <el-dialog v-model="bulkStockDialog.visible" title="批量设置库存" width="620px" destroy-on-close>
        <div style="display:grid; gap:14px">
          <el-alert type="info" :closable="false" show-icon title="批量设置会先生成库存草稿；勾选立即提交时，会继续走 Ozon 实时库存冲突检查。" />
          <el-form label-position="top">
            <el-form-item label="作用仓库">
              <el-radio-group v-model="bulkStockDialog.warehouseMode" @change="refreshBulkStockPreview">
                <el-radio-button label="default">每个商品默认仓</el-radio-button>
                <el-radio-button label="specific">指定同一仓库</el-radio-button>
              </el-radio-group>
            </el-form-item>
            <el-form-item v-if="bulkStockDialog.warehouseMode === 'specific'" label="仓库">
              <el-select v-model="bulkStockDialog.warehouse_id" filterable placeholder="选择仓库" style="width:100%" @change="refreshBulkStockPreview">
                <el-option v-for="item in selectedWarehouseOptions" :key="item.warehouse_id" :label="item.label" :value="item.warehouse_id" />
              </el-select>
            </el-form-item>
            <el-form-item label="目标库存">
              <el-input-number v-model="bulkStockDialog.target_stock" :min="0" :precision="0" :step="1" controls-position="right" style="width:180px" @change="refreshBulkStockPreview" />
            </el-form-item>
            <el-form-item>
              <el-checkbox v-model="bulkStockDialog.submitNow">保存草稿后立即提交至 Ozon</el-checkbox>
            </el-form-item>
          </el-form>
          <div style="display:flex; justify-content:space-between; color:#64748b; font-size:12px">
            <span>将生成 {{ bulkStockDialog.preview.length }} 条库存草稿</span>
            <span v-if="selectedInventory.length - bulkStockDialog.preview.length > 0">跳过 {{ selectedInventory.length - bulkStockDialog.preview.length }} 个无可用仓库商品</span>
          </div>
          <el-table :data="bulkStockDialog.preview.slice(0, 8)" size="small" border max-height="260">
            <el-table-column prop="offer_id" label="货号" min-width="150" show-overflow-tooltip />
            <el-table-column prop="warehouse_id" label="仓库 ID" width="110" />
            <el-table-column prop="current_stock" label="当前" width="80" align="right" />
            <el-table-column prop="target_stock" label="目标" width="80" align="right" />
          </el-table>
          <div v-if="bulkStockDialog.preview.length > 8" style="font-size:12px; color:#94a3b8">仅预览前 8 条，其余会一起处理。</div>
        </div>
        <template #footer>
          <el-button @click="bulkStockDialog.visible=false">取消</el-button>
          <el-button type="primary" :loading="bulkStockDialog.submitting" @click="saveBulkStockDrafts">
            {{ bulkStockDialog.submitNow ? '保存并提交' : '保存草稿' }}
          </el-button>
        </template>
      </el-dialog>

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
