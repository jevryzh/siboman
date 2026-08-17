window.ProductListView = {
  setup() {
    const products = Vue.ref([]);
    const loading = Vue.ref(false);
    const syncLoading = Vue.ref(false);
    const saveLoading = Vue.ref(false);
    const activeTab = Vue.ref('ALL');
    const search = Vue.ref('');
    const priceFilter = Vue.ref('all'); // all | promo(当前价与划线价不一致) | price_changed(本地价与Ozon价不一致)
    const drawer = Vue.reactive({ visible: false, itemId: '', form: {}, categoryPath: [] });
    const pagination = Vue.reactive({ currentPage: 1, pageSize: 50, total: 0 });
    const statusCounts = Vue.reactive({ ALL: 0 });
    const selectedRows = Vue.ref([]);
    const bulkLoading = Vue.ref(false);
    const bulkStockDialog = Vue.reactive({
      visible: false,
      submitting: false,
      loadingDetails: false,
      warehouseMode: 'default',
      warehouse_id: '',
      warehouseByStore: {},
      target_stock: 0,
      submitNow: false,
      preview: [],
      skipped: 0,
    });
    const bulkPriceDialog = Vue.reactive({
      visible: false,
      submitting: false,
      newPrice: 0,
      rows: [],
    });
    const shops = Vue.ref([]);
    const ALL_STORES = '__all__';
    const CURRENT_STORE = '__current__';
    const storeScope = Vue.ref([CURRENT_STORE]);
    let previousStoreScope = [CURRENT_STORE];

    // v0.3.2: 不用 Vue.computed 缓存 localStorage (localStorage 非响应式).
    // 动态读取; 请求拦截器会自动往请求里注入 store_id.
    const getStoreId = () => String(
      window.getCurrentStoreId ? window.getCurrentStoreId() : (localStorage.getItem('currentStoreId') || ''),
    ).split(',').map((value) => value.trim()).find(Boolean) || '';
    const shopById = (storeId) => shops.value.find((shop) => String(shop.id) === String(storeId)) || null;
    const storeNameById = (storeId) => shopById(storeId)?.name || (storeId ? '未命名店铺' : '当前店铺');
    const activeStoreIds = () => shops.value.map((shop) => String(shop.id || '').trim()).filter(Boolean);
    const storeScopeValues = () => (Array.isArray(storeScope.value) ? storeScope.value : [storeScope.value])
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    const isAllStoresScope = () => storeScopeValues().includes(ALL_STORES);
    const selectedStoreIds = () => {
      const values = storeScopeValues();
      if (values.includes(ALL_STORES)) return activeStoreIds();
      const ids = values.map((value) => value === CURRENT_STORE ? getStoreId() : value).filter(Boolean);
      return [...new Set(ids)];
    };
    const effectiveStoreIdForProduct = (row) => String(row?.store_id || row?.storeId || drawer.form?.store_id || getStoreId() || '').trim();
    const currentStoreName = Vue.computed(() => {
      if (isAllStoresScope()) return `全部店铺 (${activeStoreIds().length})`;
      const ids = selectedStoreIds();
      if (!ids.length) return '未选择店铺';
      if (ids.length === 1) return storeNameById(ids[0]);
      return `已选 ${ids.length} 个店铺`;
    });
    const storeScopeOptions = Vue.computed(() => [
      { label: `全部店铺 (${activeStoreIds().length})`, value: ALL_STORES },
      { label: `当前店铺 · ${storeNameById(getStoreId())}`, value: CURRENT_STORE },
      ...shops.value.map((shop) => ({ label: shop.name || '未命名店铺', value: String(shop.id) })),
    ]);

    const notify = {
      success: (msg) => (window.ElementPlus?.ElMessage || console).success?.(msg),
      warning: (msg) => (window.ElementPlus?.ElMessage || console).warning?.(msg),
      error: (msg) => (window.ElementPlus?.ElMessage || console).error?.(msg),
    };

    const statusTabs = [
      { label: '全部', value: 'ALL' },
      { label: '销售中', value: 'VISIBLE' },
      { label: '准备销售', value: 'READY_TO_SUPPLY' },
      { label: '错误', value: 'FAILED_MODERATION' },
      { label: '待修改', value: 'NEED_ATTENTION' },
      { label: '待审核', value: 'NOT_MODERATED' },
      { label: '商品已下架', value: 'IN_ACTIVE' },
      { label: '归档', value: 'ARCHIVED' },
    ];
    const statusCn = (status) => ({
      ALL: '全部',
      VISIBLE: '销售中',
      READY_TO_SUPPLY: '准备销售',
      NEED_ATTENTION: '待修改',
      NOT_MODERATED: '待审核',
      FAILED_MODERATION: '错误',
      IN_ACTIVE: '商品已下架',
      ARCHIVED: '归档',
    }[status] || '未知状态');
    const statusHint = (status) => ({
      ALL: 'Ozon 商品列表中的全部商品',
      VISIBLE: 'Ozon 前台可见, 可正常售卖',
      READY_TO_SUPPLY: '资料已准备, 待补库存或供货后销售',
      NEED_ATTENTION: 'Ozon 要求补齐资料, 请先查看体检问题',
      NOT_MODERATED: '已提交 Ozon, 正在审核中',
      FAILED_MODERATION: 'Ozon 后台错误/审核失败状态, 先查看失败/体检原因再保存同步',
      IN_ACTIVE: '商品已下架, 可用重新上架恢复',
      ARCHIVED: 'Ozon 商品档案/归档商品',
    }[status] || '未知状态');
    const productStatusLabel = (row) => statusCn(row?.status) || row?.status_name || row?.status || '未知状态';
    const statusCount = (value) => Number(statusCounts[value] || 0);
    const statusTabItems = Vue.computed(() => statusTabs.map((tab) => ({ ...tab, count: statusCount(tab.value) })));
    const selectStatusTab = (value) => {
      activeTab.value = value;
      pagination.currentPage = 1;
      selectedRows.value = [];
      fetchProducts();
    };
    const issueSummary = (row) => {
      const issues = Array.isArray(row.compliance_issues) ? row.compliance_issues.filter(Boolean) : [];
      if (issues.length) return issues.join('；');
      return row.status_name || row.status || '暂无后端返回的详细原因';
    };
    const syncFieldsNote = '保存会先更新本地商品资料，并尝试同步价格和图片到 Ozon；库存和仓库不在这里编辑，请到库存管理处理。';

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
            `${conflicts.length} 条库存已被其他操作修改：\n${details}${conflicts.length > 8 ? '\n…' : ''}\n\n是否以当前目标库存覆盖？`,
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

    const parseStocks = (row) => {
      const raw = row?.stocks_json;
      if (!raw) return [];
      if (Array.isArray(raw)) return raw;
      try { return JSON.parse(raw); } catch { return []; }
    };
    const stockDisplay = (row) => {
      const stocks = parseStocks(row);
      if (!stocks.length) return Number(row?.stock || 0);
      return stocks.reduce((sum, item) => sum + Number(item.present || 0), 0);
    };
    const warehouseLabel = (source) => {
      const map = { fbs: 'FBS 卖家仓', fbo: 'FBO 官方仓', crossborder: '跨境仓', rfbs: 'RFBS 自发货' };
      return map[String(source || '').toLowerCase()] || String(source || '未知仓');
    };
    const bulkStockDetailCache = new Map();
    const rowStocks = (row) => {
      const detailed = Array.isArray(row?._bulk_stocks) ? row._bulk_stocks : [];
      return detailed.length ? detailed : parseStocks(row);
    };
    const firstStock = (row) => rowStocks(row).find((stock) => Number(stock.warehouse_id) > 0) || null;
    const selectedWarehouseOptions = Vue.computed(() => {
      const map = new Map();
      for (const row of selectedRows.value || []) {
        const storeId = effectiveStoreIdForProduct(row);
        for (const stock of rowStocks(row)) {
          const wid = Number(stock.warehouse_id || 0);
          if (!wid) continue;
          const key = `${storeId}|${wid}`;
          if (map.has(key)) continue;
          map.set(key, {
            value: key,
            store_id: storeId,
            warehouse_id: wid,
            label: `${storeNameById(storeId)} · ${stock.warehouse_name || stock.name || warehouseLabel(stock.source)} / ${wid}${stock.city ? ` · ${stock.city}` : ''}`,
          });
        }
      }
      return Array.from(map.values());
    });
    const selectedStoreWarehouseGroups = Vue.computed(() => {
      const groups = new Map();
      for (const option of selectedWarehouseOptions.value) {
        const storeId = String(option.store_id || '').trim();
        if (!storeId) continue;
        if (!groups.has(storeId)) {
          groups.set(storeId, {
            store_id: storeId,
            store_name: storeNameById(storeId),
            options: [],
          });
        }
        groups.get(storeId).options.push({
          warehouse_id: option.warehouse_id,
          label: option.label.replace(`${storeNameById(storeId)} · `, ''),
        });
      }
      return Array.from(groups.values());
    });

    const initializeWarehouseByStore = () => {
      const next = {};
      for (const group of selectedStoreWarehouseGroups.value) {
        const current = bulkStockDialog.warehouseByStore[group.store_id];
        const valid = group.options.some((item) => Number(item.warehouse_id) === Number(current));
        next[group.store_id] = valid ? Number(current) : Number(group.options[0]?.warehouse_id || 0);
      }
      bulkStockDialog.warehouseByStore = next;
    };

    const buildBulkStockRows = () => {
      const targetStock = Math.floor(Number(bulkStockDialog.target_stock));
      if (!Number.isFinite(targetStock) || targetStock < 0) return [];
      return (selectedRows.value || []).map((row) => {
        const storeId = effectiveStoreIdForProduct(row);
        const stock = bulkStockDialog.warehouseMode === 'specific'
          ? rowStocks(row).find((item) => Number(item.warehouse_id) === Number(bulkStockDialog.warehouseByStore[storeId]))
          : firstStock(row);
        if (!storeId || !stock || !row.offer_id) return null;
        return {
          store_id: storeId,
          store_name: row.store_name || storeNameById(storeId),
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
      bulkStockDialog.skipped = Math.max(0, selectedRows.value.length - bulkStockDialog.preview.length);
    };

    const loadBulkStockDetails = async () => {
      const rows = selectedRows.value || [];
      if (!rows.length) return;
      bulkStockDialog.loadingDetails = true;
      try {
        const tasks = rows.map(async (row) => {
          const storeId = effectiveStoreIdForProduct(row);
          const offerId = String(row.offer_id || '').trim();
          if (!storeId || !offerId) return;
          const key = `${storeId}|${offerId}`;
          if (bulkStockDetailCache.has(key)) {
            row._bulk_stocks = bulkStockDetailCache.get(key);
            return;
          }
          const res = await axios.get('/api/seller/products/stocks/detail', {
            params: { store_id: storeId, offer_id: offerId },
          });
          const stocks = (res.data?.warehouses || [])
            .filter((stock) => Number(stock.warehouse_id) > 0)
            .map((stock) => ({
              warehouse_id: Number(stock.warehouse_id),
              warehouse_name: stock.warehouse_name || stock.name || `WH-${stock.warehouse_id}`,
              name: stock.name || stock.warehouse_name || `WH-${stock.warehouse_id}`,
              source: stock.source || 'fbs',
              city: stock.city || '',
              present: Number(stock.present || 0),
              reserved: Number(stock.reserved || 0),
              has_stock: stock.has_stock !== false,
            }));
          bulkStockDetailCache.set(key, stocks);
          row._bulk_stocks = stocks;
        });
        const results = await Promise.allSettled(tasks);
        const failed = results.filter((result) => result.status === 'rejected').length;
        selectedRows.value = selectedRows.value.slice();
        if (failed) notify.warning(`有 ${failed} 个商品仓库明细读取失败，已用本地缓存兜底`);
      } finally {
        bulkStockDialog.loadingDetails = false;
      }
    };

    const openBulkPriceEditor = () => {
      if (!selectedRows.value.length) return notify.warning('请先勾选要批量改价的商品');
      bulkPriceDialog.rows = selectedRows.value.map((row) => ({
        offer_id: row.offer_id,
        store_id: row.store_id || row.storeId,
        name: row.name || row.offer_id,
        price: Number(row.price || 0),
        currency_code: row.currency_code || 'RUB',
        marketing_seller_price: Number(row.marketing_seller_price || 0),
        selected: true,
      }));
      bulkPriceDialog.newPrice = 0;
      bulkPriceDialog.visible = true;
    };

    const saveBulkPrices = async () => {
      const rows = bulkPriceDialog.rows.filter((r) => r.selected);
      const newPrice = Number(bulkPriceDialog.newPrice);
      if (!rows.length) return notify.warning('没有勾选要改价的商品');
      if (!Number.isFinite(newPrice) || newPrice <= 0) return notify.warning('请输入大于 0 的新价格');
      bulkPriceDialog.submitting = true;
      try {
        // 按店铺分组，每店一次 import/prices 批量提交（跨店铺同 SKU 价格统一）
        const groups = rows.reduce((map, row) => {
          if (!map.has(row.store_id)) map.set(row.store_id, []);
          map.get(row.store_id).push(row);
          return map;
        }, new Map());
        let succeeded = 0;
        const errors = [];
        for (const [storeId, items] of groups.entries()) {
          try {
            const res = await axios.post('/api/seller/products/prices/bulk', {
              store_id: storeId,
              prices: items.map((r) => ({ offer_id: r.offer_id, price: newPrice, currency_code: r.currency_code })),
            });
            succeeded += Number(res.data?.succeeded || items.length);
            if (res.data?.errors?.length) errors.push(...res.data.errors.map((e) => `${e.offer_id}: ${e.message}`));
          } catch (e) {
            errors.push(`${storeId.slice(0, 8)}: ${e.response?.data?.error || e.message}`);
          }
        }
        if (errors.length) notify.warning(`批量改价部分完成：成功 ${succeeded} 个，失败 ${errors.length} 个。${errors.slice(0, 3).join('；')}`);
        else notify.success(`批量改价完成：${succeeded} 个商品已提交 Ozon`);
        bulkPriceDialog.visible = false;
        await fetchProducts();
      } finally {
        bulkPriceDialog.submitting = false;
      }
    };

    const openBulkStockEditor = async () => {
      if (!selectedRows.value.length) return notify.warning('请先勾选要批量修改库存的商品');
      bulkStockDialog.warehouseMode = 'default';
      bulkStockDialog.warehouseByStore = {};
      bulkStockDialog.target_stock = 0;
      bulkStockDialog.submitNow = false;
      bulkStockDialog.visible = true;
      await loadBulkStockDetails();
      initializeWarehouseByStore();
      bulkStockDialog.warehouse_id = selectedWarehouseOptions.value[0]?.value || '';
      refreshBulkStockPreview();
    };

    const saveBulkStockDrafts = async () => {
      const rows = buildBulkStockRows();
      if (!rows.length) return notify.warning('所选商品没有可用仓库，或目标库存无效');
      bulkStockDialog.submitting = true;
      try {
        const groups = rows.reduce((map, row) => {
          if (!map.has(row.store_id)) map.set(row.store_id, []);
          map.get(row.store_id).push(row);
          return map;
        }, new Map());
        let saved = 0;
        let submitted = 0;
        let succeeded = 0;
        let failed = 0;
        const errors = [];
        for (const [storeId, stocks] of groups.entries()) {
          try {
            const saveRes = await axios.post('/api/seller/stocks/save-draft', { store_id: storeId, stocks });
            saved += Number(saveRes.data.saved || 0);
            const savedIds = (saveRes.data.items || []).map((item) => item.id).filter(Boolean);
            if (bulkStockDialog.submitNow && savedIds.length) {
              const submitRes = await submitWithConflictCheck('/api/seller/products/stocks/bulk', {
                store_id: storeId,
                ids: savedIds,
              }, { validateStatus: (status) => status === 200 || status === 207 });
              submitted += Number(submitRes.data.submitted || 0);
              succeeded += Number(submitRes.data.succeeded || 0);
              failed += Number(submitRes.data.failed || 0);
              if (Array.isArray(submitRes.data.errors)) errors.push(...submitRes.data.errors.map((err) => ({ ...err, store_name: storeNameById(storeId) })));
            }
          } catch (e) {
            if (e.code === 'STOCK_CONFLICT_CANCELLED') throw e;
            errors.push({ store_name: storeNameById(storeId), error: e.response?.data?.error || e.message });
          }
        }
        const skippedText = bulkStockDialog.skipped ? `，跳过 ${bulkStockDialog.skipped} 个无仓库商品` : '';
        if (bulkStockDialog.submitNow) {
          const message = `提交 ${submitted} 条：成功 ${succeeded}，失败 ${failed}${skippedText}`;
          if (failed || errors.length) notify.warning(message);
          else notify.success(message);
        } else {
          const message = `已保存 ${saved} 条库存草稿${skippedText}`;
          if (errors.length) notify.warning(`${message}，部分店铺失败`);
          else notify.success(message);
        }
        if (errors.length) console.warn('[ProductBulkStock]', errors);
        bulkStockDialog.visible = false;
        selectedRows.value = [];
        await fetchProducts();
      } catch (e) {
        if (e.code !== 'STOCK_CONFLICT_CANCELLED') notify.error('批量修改库存失败: ' + (e.response?.data?.error || e.message));
      } finally {
        bulkStockDialog.submitting = false;
      }
    };

    const fetchShops = async () => {
      try {
        const res = await axios.get('/api/seller/shops');
        shops.value = (res.data?.shops || []).filter((shop) => shop.active !== false);
        if (!storeScopeValues().length) storeScope.value = [CURRENT_STORE];
      } catch (e) {
        notify.warning('店铺列表读取失败: ' + (e.response?.data?.error || e.message));
      }
    };

    const fetchProducts = async () => {
      const storeIds = selectedStoreIds();
      if (!storeIds.length) return;
      loading.value = true;
      try {
        const aggregateStoreMode = isAllStoresScope() || storeIds.length > 1;
        const limit = aggregateStoreMode ? Math.min(200, Math.max(pagination.pageSize, 50)) : pagination.pageSize;
        const offset = aggregateStoreMode ? 0 : (pagination.currentPage - 1) * pagination.pageSize;
        const results = await Promise.allSettled(storeIds.map((sid) => axios.post('/api/seller/products', {
          visibility: activeTab.value,
          store_id: sid,
          search: search.value,
          price_filter: priceFilter.value,
          limit,
          offset,
        }).then((res) => ({ sid, data: res.data }))));
        const rows = [];
        let total = 0;
        const mergedCounts = { ALL: 0 };
        const failures = [];
        for (const result of results) {
          if (result.status !== 'fulfilled') {
            failures.push(result.reason?.response?.data?.error || result.reason?.message || '未知错误');
            continue;
          }
          const { sid, data } = result.value;
          const storeName = storeNameById(sid);
          rows.push(...(data.items || []).map((row) => ({ ...row, store_id: sid, store_name: storeName })));
          total += Number(data.total || 0);
          for (const [key, value] of Object.entries(data.status_counts || {})) {
            mergedCounts[key] = Number(mergedCounts[key] || 0) + Number(value || 0);
          }
        }
        rows.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
        // v2.2.9.102 双保险：促销筛选时前端再过滤一次，绝不让活动价为空的商品出现在结果里
        const visibleRows = priceFilter.value === 'promo'
          ? rows.filter((row) => row.marketing_seller_price && Number(row.marketing_seller_price) > 0 && Number(row.marketing_seller_price) !== Number(row.price))
          : rows;
        products.value = aggregateStoreMode
          ? visibleRows.slice((pagination.currentPage - 1) * pagination.pageSize, pagination.currentPage * pagination.pageSize)
          : visibleRows;
        if (priceFilter.value === 'promo') pagination.total = visibleRows.length;
        else pagination.total = total;
        Object.assign(statusCounts, { ALL: 0 }, mergedCounts);
        if (failures.length) notify.warning(`部分店铺读取失败：${failures.slice(0, 2).join('；')}`);
      } catch (e) {
        notify.error('获取列表失败: ' + (e.response?.data?.error || e.message));
      } finally {
        loading.value = false;
      }
    };

    const handleSyncAll = async () => {
      const sid = getStoreId();
      if (!sid) return notify.warning('请先选择店铺');
      syncLoading.value = true;
      try {
        const res = await axios.post('/api/seller/products/sync-all', { store_id: sid }, { timeout: 300000 });
        notify.success(`同步成功：${res.data.count} 个 SKU 落库`);
        pagination.currentPage = 1;
        await fetchProducts();
      } catch (e) {
        notify.error('同步失败: ' + (e.response?.data?.error || e.message));
      } finally {
        syncLoading.value = false;
      }
    };

    const normalizeCategoryFields = (form) => {
      const readonly = form.category_readonly || {};
      const categoryId = Number(form.description_category_id || readonly.description_category_id || 0);
      const typeId = Number(form.type_id || readonly.type_id || 0);
      if (categoryId > 0) form.description_category_id = categoryId;
      if (typeId > 0) form.type_id = typeId;
      if (!form.category_name) {
        form.category_name = readonly.category_name || form.category_display || (categoryId > 0 ? `Ozon 类目 ${categoryId}` : '');
      }
      form.category_path = form.category_path || form.category_name || '';
      return form;
    };

    const editProduct = (row) => {
      drawer.itemId = row.offer_id;
      drawer.form = JSON.parse(JSON.stringify(row));
      normalizeCategoryFields(drawer.form);
      for (const key of ['price', 'old_price', 'min_price', 'purchase_price_cny', 'weight', 'width', 'depth', 'height']) {
        const value = drawer.form[key];
        drawer.form[key] = value === null || value === undefined || value === '' ? null : Number(value);
      }
      if (!Array.isArray(drawer.form.images)) {
        try { drawer.form.images = JSON.parse(drawer.form.images || '[]'); } catch { drawer.form.images = []; }
      }
      drawer.categoryPath = [];
      drawer.visible = true;
      if (categoryTreeLoaded.value) syncCategoryPathFromForm();
      else ensureCategoryTree(true);
    };

    // v0.3.5 类目三级 cascader
    const categoryTree = Vue.ref([]);
    const categoryTreeLoaded = Vue.ref(false);
    const categoryLoading = Vue.ref(false);
    const categoryNodeByKey = new Map();
    const makeCategoryKey = (node, indexPath, inheritedCategoryId = 0) => {
      const categoryId = Number(node.description_category_id || 0);
      const typeId = Number(node.type_id || 0);
      if (typeId > 0) return `type:${typeId}`;
      if (categoryId > 0 || inheritedCategoryId > 0) return `cat:${categoryId || inheritedCategoryId}`;
      return `name:${indexPath.join('.')}:${node.category_name || node.type_name || 'unknown'}`;
    };
    const syncCategoryPathFromForm = () => {
      if (!categoryTreeLoaded.value) return;
      normalizeCategoryFields(drawer.form);
      const categoryId = Number(drawer.form.description_category_id || drawer.form.category_readonly?.description_category_id || 0);
      const typeId = Number(drawer.form.type_id || drawer.form.category_readonly?.type_id || 0);
      const currentName = String(drawer.form.category_name || drawer.form.category_readonly?.category_name || '').trim();
      let foundPath = [];
      const walk = (nodes, path = []) => {
        for (const node of nodes || []) {
          const nextPath = [...path, node.category_key];
          if ((typeId > 0 && Number(node.type_id || 0) === typeId)
            || (!typeId && categoryId > 0 && Number(node.description_category_id || 0) === categoryId)
            || (!categoryId && currentName && node.category_name === currentName)) {
            foundPath = nextPath;
            return true;
          }
          if (walk(node.children || [], nextPath)) return true;
        }
        return false;
      };
      walk(categoryTree.value);
      drawer.categoryPath = foundPath;
      if (foundPath.length) onCategoryChange(foundPath);
    };
    const ensureCategoryTree = async (visible) => {
      if (categoryTreeLoaded.value || !visible) return;
      categoryLoading.value = true;
      try {
        const r = await axios.post('/api/seller/categories/tree', { store_id: getStoreId() });
        const raw = r.data?.data?.result || [];
        categoryNodeByKey.clear();
        const clean = (nodes, indexPath = [], inherited = {}) => (nodes || []).map((n, index) => {
          const nextIndexPath = [...indexPath, index];
          const label = n.category_name_zh || n.category_name || n.type_name || '未命名类目';
          const ownCategoryId = Number(n.description_category_id || 0) || 0;
          const ownTypeId = Number(n.type_id || 0) || 0;
          const inheritedCategoryId = ownCategoryId || Number(inherited.description_category_id || 0) || null;
          const inheritedCategoryName = n.category_name || inherited.category_name || '';
          const categoryKey = makeCategoryKey(n, nextIndexPath, inheritedCategoryId);
          const node = {
            label,
            category_key: categoryKey,
            category_name: n.category_name || inheritedCategoryName || label,
            category_name_zh: n.category_name_zh || label,
            description_category_id: inheritedCategoryId,
            type_id: ownTypeId || null,
            children: n.children && n.children.length ? clean(n.children, nextIndexPath, {
              description_category_id: inheritedCategoryId,
              category_name: inheritedCategoryName || label,
            }) : undefined,
          };
          categoryNodeByKey.set(categoryKey, node);
          return node;
        });
        categoryTree.value = clean(raw);
        categoryTreeLoaded.value = true;
        syncCategoryPathFromForm();
      } catch (e) {
        notify.error('加载类目树失败: ' + (e.response?.data?.error || e.message));
      } finally {
        categoryLoading.value = false;
      }
    };
    const onCategoryChange = (path) => {
      if (Array.isArray(path) && path.length) {
        const selected = categoryNodeByKey.get(path[path.length - 1]);
        const names = path.map((key) => categoryNodeByKey.get(key)?.label).filter(Boolean);
        drawer.form.category_name = selected?.category_name || names[names.length - 1] || '';
        drawer.form.category_path = names.join(' / ');
        if (selected?.description_category_id) drawer.form.description_category_id = selected.description_category_id;
        if (selected?.type_id) drawer.form.type_id = selected.type_id;
      }
    };
    const currentCategoryText = Vue.computed(() => {
      const categoryId = Number(drawer.form.description_category_id || drawer.form.category_readonly?.description_category_id || 0);
      return drawer.form.category_path
        || drawer.form.category_name
        || drawer.form.category_readonly?.category_name
        || drawer.form.category_display
        || (categoryId > 0 ? `Ozon 类目 ${categoryId}` : '未设置');
    });
    const categoryPathMissing = Vue.computed(() => (
      drawer.visible
      && Number(drawer.form.description_category_id || drawer.form.category_readonly?.description_category_id || 0) > 0
      && categoryTreeLoaded.value
      && !drawer.categoryPath.length
    ));

    // v0.3.4 图片工具
    const allPreviewList = () => {
      const imgs = Array.isArray(drawer.form.images) ? drawer.form.images : [];
      return imgs.length ? imgs : (drawer.form.image ? [drawer.form.image] : []);
    };
    const productPreviewList = (row) => {
      const images = Array.isArray(row.images) ? row.images : [];
      const list = [row.image, ...images].filter(Boolean);
      return Array.from(new Set(list));
    };
    const uploadImage = async (opts, mode) => {
      const fd = new FormData();
      fd.append('file', opts.file);
      try {
        const res = await axios.post('/api/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        const url = res.data.url;
        if (mode === 'primary') {
          drawer.form.image = url;
          notify.success('主图已替换 (记得保存)');
        } else {
          if (!Array.isArray(drawer.form.images)) drawer.form.images = [];
          drawer.form.images.push(url);
          notify.success('副图已上传 (记得保存)');
        }
      } catch (e) {
        notify.error('上传失败: ' + (e.response?.data?.error || e.message));
      }
    };
    const removeGalleryImage = (i) => {
      drawer.form.images.splice(i, 1);
    };

    // v0.3.4 AI 增强能力
    const aiImageLoading = Vue.ref(false);
    const aiFillLoading = Vue.ref(false);
    const aiPriceLoading = Vue.ref(false);
    const aiRefineImage = async () => {
      if (!drawer.form.image) return notify.warning('请先上传主图');
      aiImageLoading.value = true;
      try {
        const res = await axios.post('/api/seller/images/generate', {
          store_id: getStoreId(),
          image: drawer.form.image,
          prompt: '保持商品主体、颜色、结构和全部细节不变，去除画面杂物，替换为纯白背景，增强清晰度与真实质感，生成适合 Ozon 商品主图的专业电商摄影图。',
          aspectRatio: '1:1',
          n: 1,
          scenePreset: '商品主图优化',
        });
        const generated = res.data?.data?.images?.[0];
        if (!generated) throw new Error('AI 服务未返回图片');
        drawer.form.image = generated;
        notify.success('AI 已生成优化主图，保存商品后同步至 Ozon');
      } catch (e) { notify.error('AI 改图失败: ' + (e.response?.data?.error || e.message)); }
      finally { aiImageLoading.value = false; }
    };
    const aiFillProduct = async () => {
      if (!drawer.form.name) return notify.warning('请先填商品名称');
      aiFillLoading.value = true;
      try {
        const res = await axios.post('/api/ai/analyze', { store_id: getStoreId(), title: drawer.form.name });
        const d = res.data?.data || {};
        if (d.brand && !drawer.form.brand) drawer.form.brand = d.brand;
        if (d.description) drawer.form.description = d.description;
        if (d.category_name && !drawer.form.category_name) drawer.form.category_name = d.category_name;
        notify.success('AI 已填充可用字段');
      } catch (e) { notify.error('AI 填充失败: ' + (e.response?.data?.error || e.message)); }
      finally { aiFillLoading.value = false; }
    };
    const aiPricing = async () => {
      aiPriceLoading.value = true;
      try {
        const res = await axios.post('/api/ai/pricing', {
          store_id: getStoreId(),
          offer_id: drawer.form.offer_id,
          name: drawer.form.name,
          weight: drawer.form.weight,
        });
        const d = res.data?.data || {};
        if (d.suggested_price) drawer.form.price = d.suggested_price;
        if (d.min_price) drawer.form.min_price = d.min_price;
        notify.success('AI 建议价格已填入');
      } catch (e) { notify.error('AI 核价失败: ' + (e.response?.data?.error || e.message)); }
      finally { aiPriceLoading.value = false; }
    };

    // v0.3.3 归档 / 上架 (调 Ozon /v1/product/archive|unarchive)
    const archiveProduct = async (row) => {
      try {
        await window.ElementPlus.ElMessageBox.confirm(
          `确定归档商品「${row.name || row.offer_id}」？归档会调用 Ozon archive 接口, 前台不可见, 可再上架恢复。`,
          '归档确认',
          { confirmButtonText: '确定归档', cancelButtonText: '取消', type: 'warning' },
        );
      } catch { return; }
      try {
        await axios.post('/api/seller/products/archive', {
          store_id: effectiveStoreIdForProduct(row),
          offer_id: [row.offer_id],
        });
        notify.success('归档成功, 本地状态已同步');
        fetchProducts();
      } catch (e) {
        notify.error('归档失败: ' + (e.response?.data?.payload?.message || e.response?.data?.error || e.message));
      }
    };
    const unarchiveProduct = async (row) => {
      try {
        await window.ElementPlus.ElMessageBox.confirm(
          `确定重新上架「${row.name || row.offer_id}」？这里仅恢复归档商品可见性, 不会新建商品。`,
          '重新上架确认',
          { confirmButtonText: '确认上架', cancelButtonText: '取消', type: 'warning' },
        );
      } catch { return; }
      try {
        await axios.post('/api/seller/products/unarchive', {
          store_id: effectiveStoreIdForProduct(row),
          offer_id: [row.offer_id],
        });
        notify.success('已上架, 本地状态已同步');
        fetchProducts();
      } catch (e) {
        notify.error('上架失败: ' + (e.response?.data?.payload?.message || e.response?.data?.error || e.message));
      }
    };

    const saveProduct = async () => {
      saveLoading.value = true;
      try {
        const response = await axios.patch(`/api/seller/products/${encodeURIComponent(drawer.itemId)}/full-update`, {
          ...drawer.form,
          store_id: effectiveStoreIdForProduct(drawer.form),
        });
        if (response.data?.success) notify.success('商品资料已保存，价格和图片已提交 Ozon');
        else notify.warning((response.data?.errors || []).join('；') || '本地资料已保存，部分 Ozon 同步失败');
        drawer.visible = false;
        await fetchProducts();
      } catch (e) {
        notify.error('同步失败: ' + (e.response?.data?.error || e.message));
      } finally {
        saveLoading.value = false;
      }
    };

    const onPageChange = () => fetchProducts();
    const onSizeChange = () => { pagination.currentPage = 1; fetchProducts(); };
    const onTabChange = () => { pagination.currentPage = 1; fetchProducts(); };
    const onSearch = () => { pagination.currentPage = 1; fetchProducts(); };
    // v2.2.9.102 (fix): el-select @change 时 v-model 可能尚未同步（读到旧值导致筛选不生效）。
    //   显式接收 change 事件的选中值并立即赋值，再刷新列表。
    const onPriceFilterChange = (val) => { priceFilter.value = val === undefined ? priceFilter.value : val; pagination.currentPage = 1; fetchProducts(); };
    let searchTimer = null;
    const onSearchInput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(onSearch, 400);
    };

    const copyOfferId = async (offerId) => {
      try {
        await navigator.clipboard.writeText(String(offerId || ''));
        notify.success('货号已复制');
      } catch {
        notify.warning('复制失败，请手动复制');
      }
    };
    const handleProductAction = ({ action, row }) => {
      if (action === 'edit') return editProduct(row);
      if (action === 'archive') return archiveProduct(row);
      if (action === 'unarchive') return unarchiveProduct(row);
    };

    const onSelectionChange = (rows) => { selectedRows.value = rows || []; };
    const bulkArchive = async () => {
      const candidates = selectedRows.value.filter((row) => row.status !== 'IN_ACTIVE' && row.offer_id);
      if (!selectedRows.value.length) return notify.warning('请先选择商品');
      if (!candidates.length) return notify.warning('所选商品都已下架或已归档');
      if (candidates.length > 100) return notify.warning('单次最多处理 100 个商品');
      try {
        await window.ElementPlus.ElMessageBox.confirm(
          `确定归档选中的 ${candidates.length} 个商品？归档会调用 Ozon 商品 archive 接口，前台不可见，可再上架恢复。`,
          '批量归档商品确认',
          { confirmButtonText: '确定归档', cancelButtonText: '取消', type: 'warning' },
        );
      } catch { return; }
      bulkLoading.value = true;
      try {
        const groups = candidates.reduce((map, row) => {
          const storeId = effectiveStoreIdForProduct(row);
          if (!storeId) return map;
          if (!map.has(storeId)) map.set(storeId, []);
          map.get(storeId).push(row.offer_id);
          return map;
        }, new Map());
        let archived = 0;
        const errors = [];
        for (const [storeId, offerIds] of groups.entries()) {
          try {
            await axios.post('/api/seller/products/archive', {
              store_id: storeId,
              offer_id: offerIds,
            });
            archived += offerIds.length;
          } catch (e) {
            errors.push(`${storeNameById(storeId)}: ${e.response?.data?.error || e.message}`);
          }
        }
        if (errors.length) notify.warning(`已归档 ${archived} 个商品，失败 ${errors.length} 个店铺`);
        else notify.success(`已归档 ${archived} 个商品`);
        selectedRows.value = [];
        await fetchProducts();
        if (errors.length) console.warn('[ProductBulkArchive]', errors);
      } catch (e) {
        notify.error('批量归档失败: ' + (e.response?.data?.error || e.message));
      } finally { bulkLoading.value = false; }
    };

    const exportCsv = async () => {
      if (!pagination.total) return notify.warning('当前筛选条件没有可导出的商品');
      try {
        const response = await axios.post('/api/seller/products/export', {
          store_id: selectedStoreIds()[0] || getStoreId(), visibility: activeTab.value, search: search.value,
        }, { responseType: 'blob', timeout: 120000 });
        const url = URL.createObjectURL(response.data);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ozon-products-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        notify.error('导出失败: ' + (e.response?.data?.error || e.message));
      }
    };

    // 店铺切换: 重置分页 + 清空数据 + 拉新店铺
    const onShopChanged = () => {
      pagination.currentPage = 1;
      products.value = [];
      pagination.total = 0;
      selectedRows.value = [];
      fetchProducts();
    };
    const onStoreScopeChange = (value = storeScope.value) => {
      const incoming = (Array.isArray(value) ? value : [value]).map((item) => String(item || '').trim()).filter(Boolean);
      const hadAll = previousStoreScope.includes(ALL_STORES);
      const hasAll = incoming.includes(ALL_STORES);
      let normalized = incoming;
      if (hasAll && (!hadAll || incoming.length === 1)) {
        normalized = [ALL_STORES];
      } else if (hasAll) {
        normalized = incoming.filter((item) => item !== ALL_STORES);
      }
      if (!normalized.length) normalized = [CURRENT_STORE];
      storeScope.value = [...new Set(normalized)];
      previousStoreScope = storeScope.value.slice();
      pagination.currentPage = 1;
      selectedRows.value = [];
      products.value = [];
      pagination.total = 0;
      fetchProducts();
    };
    window.addEventListener('shop-changed', onShopChanged);
    Vue.onBeforeUnmount(() => {
      clearTimeout(searchTimer);
      window.removeEventListener('shop-changed', onShopChanged);
    });

    Vue.onMounted(() => fetchShops().finally(() => fetchProducts()));

    return {
      products, loading, syncLoading, saveLoading,
      activeTab, statusTabs, statusCounts, statusTabItems, search, drawer, pagination,
      selectedRows, bulkLoading, bulkStockDialog, selectedWarehouseOptions, selectedStoreWarehouseGroups, storeScope, storeScopeOptions, currentStoreName,
      fetchProducts, handleSyncAll, editProduct, saveProduct,
      archiveProduct, unarchiveProduct,
      onPageChange, onSizeChange, onTabChange, onSearch, onPriceFilterChange, onSearchInput,
      copyOfferId, onSelectionChange, bulkArchive, openBulkStockEditor, refreshBulkStockPreview, saveBulkStockDrafts,
      bulkPriceDialog, openBulkPriceEditor, saveBulkPrices,
      exportCsv, onStoreScopeChange, selectStatusTab, handleProductAction,
      statusCn, statusHint, productStatusLabel, issueSummary, syncFieldsNote,
      parseStocks, stockDisplay, warehouseLabel,
      // v0.3.5
      categoryTree, categoryLoading, ensureCategoryTree, onCategoryChange,
      currentCategoryText, categoryPathMissing,
      allPreviewList, uploadImage, removeGalleryImage,
      productPreviewList,
      aiRefineImage, aiFillProduct, aiPricing,
      aiImageLoading, aiFillLoading, aiPriceLoading,
    };
  },
  template: `
    <div class="product-list-v3" style="padding:28px 34px; background:#f8fafc; min-height:calc(100vh - 64px)">
      <div style="max-width:1600px; margin:0 auto">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px; margin-bottom:18px">
          <div>
            <div style="font-size:28px; line-height:1; font-weight:800; color:#111827; letter-spacing:0">商品</div>
            <div style="margin-top:14px; font-size:14px; color:#64748b">{{ currentStoreName }} · 共 {{ pagination.total }} 个 SKU</div>
            <div v-if="priceFilter !== 'all'" style="margin-top:8px; display:inline-flex; align-items:center; gap:6px; padding:4px 10px; background:#fef2f2; border:1px solid #fecaca; border-radius:6px; font-size:12px; color:#dc2626; font-weight:700">
              <span style="width:6px; height:6px; border-radius:50%; background:#ef4444"></span>
              已筛选：价格与促销价不一致（活动价≠设置价），仅显示被促销/调价的商品
            </div>
          </div>
          <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; justify-content:flex-end">
            <el-button size="large" @click="fetchProducts">
              <el-icon><Refresh /></el-icon><span>刷新</span>
            </el-button>
            <el-button size="large" type="primary" style="background:#111827; border-color:#111827" :loading="syncLoading" @click="handleSyncAll">
              <el-icon><RefreshRight /></el-icon><span>同步 Ozon 商品</span>
            </el-button>
            <el-button size="large" type="success" @click="() => (window.location.hash = '#/collection')">从采集箱新增</el-button>
            <el-button size="large" type="warning" plain @click="exportCsv">
              <el-icon><Download /></el-icon><span>导出筛选结果</span>
            </el-button>
          </div>
        </div>

        <div style="display:flex; align-items:center; gap:10px; border:1px solid #dfe7f1; border-radius:8px; background:#fff; padding:5px; width:max-content; max-width:100%; margin-bottom:14px; overflow-x:auto">
          <button
            v-for="tab in statusTabItems"
            :key="tab.value"
            @click="selectStatusTab(tab.value)"
            :style="{
              border:'none',
              borderRadius:'6px',
              padding:'8px 14px',
              cursor:'pointer',
              fontWeight:800,
              whiteSpace:'nowrap',
              background: activeTab === tab.value ? '#111827' : 'transparent',
              color: activeTab === tab.value ? '#fff' : '#64748b'
            }">
            {{ tab.label }}
            <span :style="{ marginLeft:'6px', padding:'1px 8px', borderRadius:'999px', background: activeTab === tab.value ? 'rgba(255,255,255,.18)' : '#eef2f7', color: activeTab === tab.value ? '#fff' : '#64748b' }">{{ tab.count }}</span>
          </button>
        </div>

        <div style="display:grid; grid-template-columns:260px minmax(200px,1fr) 230px 70px 70px; gap:10px; align-items:center; margin-bottom:14px">
          <el-select
            v-model="storeScope"
            size="large"
            multiple
            collapse-tags
            collapse-tags-tooltip
            :max-collapse-tags="1"
            filterable
            placeholder="选择店铺"
            style="width:100%"
            @change="onStoreScopeChange">
            <template #prefix><el-icon><Shop /></el-icon></template>
            <el-option v-for="option in storeScopeOptions" :key="'product-filter-' + option.value" :label="option.label" :value="option.value" />
          </el-select>
          <el-input v-model="search" size="large" placeholder="搜索 SKU / 货号 / 标题..." clearable style="width:100%" @input="onSearchInput" @keyup.enter="onSearch">
            <template #prefix><el-icon><Search /></el-icon></template>
          </el-input>
          <el-select v-model="priceFilter" size="large" style="width:100%" @change="onPriceFilterChange">
            <el-option label="全部价格" value="all" />
            <el-option label="价格与促销价不一致" value="promo" />
          </el-select>
          <el-button size="large" style="width:100%" @click="onSearch">筛选</el-button>
          <el-button size="large" style="width:100%" @click="() => { search=''; priceFilter='all'; activeTab='ALL'; pagination.currentPage=1; fetchProducts(); }">重置</el-button>
        </div>

        <div v-if="selectedRows.length" style="display:flex; justify-content:space-between; align-items:center; padding:12px 14px; margin-bottom:12px; background:#eff6ff; border:1px solid #bfdbfe; border-radius:8px">
          <span style="font-size:13px; font-weight:700; color:#1e3a8a">已选择 {{ selectedRows.length }} 个商品</span>
          <div style="display:flex; gap:8px">
            <el-button type="primary" size="small" plain :loading="bulkStockDialog.loadingDetails" @click="openBulkStockEditor">批量改库存</el-button>
            <el-button type="warning" size="small" plain :disabled="!selectedRows.length" @click="openBulkPriceEditor">批量改价</el-button>
            <el-button type="danger" size="small" :loading="bulkLoading" @click="bulkArchive">批量归档</el-button>
            <el-button size="small" @click="exportCsv">导出当前筛选</el-button>
          </div>
        </div>

        <el-table :data="products" v-loading="loading" element-loading-text="正在读取商品..." border size="large" empty-text="暂无商品。请先选择店铺，或点击同步 Ozon 商品刷新本地缓存。" style="border-radius:8px; overflow:hidden; box-shadow:0 8px 24px rgba(15,23,42,.04)" @selection-change="onSelectionChange">
          <el-table-column type="selection" width="52" />
          <el-table-column label="店铺" width="135">
            <template #default="{ row }">
              <div style="display:inline-flex; align-items:center; gap:8px; max-width:112px; background:#f1f5f9; border-radius:7px; padding:8px 10px; color:#475569; font-weight:800">
                <span style="width:5px; height:5px; border-radius:50%; background:#6366f1; flex-shrink:0"></span>
                <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap">{{ row.store_name || currentStoreName }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="图片" width="96">
            <template #default="{ row }">
              <el-tooltip content="点击图片可放大查看图册" placement="top">
                <el-image
                  :src="row.image"
                  style="width:58px; height:58px; border-radius:8px; background:#f1f5f9; cursor:zoom-in"
                  fit="cover"
                  preview-teleported
                  :preview-src-list="productPreviewList(row)"
                  :initial-index="0">
                  <template #error>
                    <div style="width:58px; height:58px; background:#f1f5f9; display:flex; align-items:center; justify-content:center">
                      <el-icon color="#cbd5e1"><Picture /></el-icon>
                    </div>
                  </template>
                </el-image>
              </el-tooltip>
            </template>
          </el-table-column>
          <el-table-column label="商品" min-width="390">
            <template #default="{ row }">
              <div style="min-width:0">
                <div style="font-size:15px; color:#1f2937; font-weight:800; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">{{ row.name || '(无标题)' }}</div>
                <div style="margin-top:6px; display:flex; align-items:center; gap:6px; font-size:12px; color:#94a3b8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">
                  <span>SKU {{ row.sku || '-' }}</span>
                  <span>货号 {{ row.offer_id || '-' }}</span>
                  <el-button link type="primary" size="small" title="复制货号" @click.stop="copyOfferId(row.offer_id)"><el-icon><CopyDocument /></el-icon></el-button>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="120">
            <template #default="{ row }">
              <el-tooltip :content="statusHint(row.status) + (row.status_name ? '；Ozon 原始状态：' + row.status_name : '')" placement="top">
                <el-tag size="small" :type="row.status === 'VISIBLE' ? 'success' : (['NEED_ATTENTION', 'FAILED_MODERATION'].includes(row.status) ? 'danger' : 'info')">
                  {{ productStatusLabel(row) }}
                </el-tag>
              </el-tooltip>
            </template>
          </el-table-column>
          <el-table-column label="体检" width="110">
            <template #default="{ row }">
              <el-tag v-if="row.compliance_ok" size="small" type="success">通过</el-tag>
              <el-tooltip v-else :content="issueSummary(row)" placement="top">
                <el-tag size="small" type="danger">{{ (row.compliance_issues || []).length }} 项问题</el-tag>
              </el-tooltip>
            </template>
          </el-table-column>
          <el-table-column label="失败/处理原因" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">
              <span v-if="['NEED_ATTENTION', 'FAILED_MODERATION'].includes(row.status)" style="color:#f56c6c; font-size:12px">{{ issueSummary(row) }}</span>
              <span v-else style="color:#909399; font-size:12px">{{ statusHint(row.status) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="价格" width="110" sortable prop="price">
            <template #default="{ row }">
              <span style="font-weight:bold">{{ row.currency_code || 'RUB' }} {{ Number(row.price).toFixed(2) }}</span>
              <div v-if="row.old_price && Number(row.old_price) > Number(row.price)" style="font-size:11px; color:#999; text-decoration:line-through">
                {{ row.currency_code }} {{ Number(row.old_price).toFixed(2) }}
              </div>
            </template>
          </el-table-column>
          <el-table-column label="活动价" width="120" sortable>
            <template #default="{ row }">
              <template v-if="row.marketing_seller_price && Number(row.marketing_seller_price) > 0">
                <!-- 活动价 < 设置价：红色（被平台拉低促销） -->
                <span v-if="Number(row.marketing_seller_price) < Number(row.price)" style="color:#f56c6c; font-weight:900">{{ row.currency_code }} {{ Number(row.marketing_seller_price).toFixed(2) }}</span>
                <!-- 活动价 > 设置价：蓝色（高于设置价） -->
                <span v-else-if="Number(row.marketing_seller_price) > Number(row.price)" style="color:#2563eb; font-weight:900">{{ row.currency_code }} {{ Number(row.marketing_seller_price).toFixed(2) }}</span>
                <span v-else style="color:#94a3b8">{{ row.currency_code }} {{ Number(row.marketing_seller_price).toFixed(2) }}</span>
                <div v-if="Number(row.marketing_seller_price) !== Number(row.price)">
                  <el-tag v-if="Number(row.marketing_seller_price) < Number(row.price)" type="danger" size="small" effect="dark">已促销</el-tag>
                  <el-tag v-else type="primary" size="small" effect="dark">高于售价</el-tag>
                </div>
              </template>
              <span v-else style="color:#c0c4cc">-</span>
            </template>
          </el-table-column>
          <el-table-column label="库存" prop="stock" width="120" sortable>
            <template #default="{ row }">
              <div style="font-weight:900; color:#111827">{{ stockDisplay(row) }}</div>
              <div v-if="parseStocks(row).length" style="font-size:11px; color:#94a3b8">{{ parseStocks(row).length }} 仓</div>
            </template>
          </el-table-column>
          <el-table-column label="品牌" prop="brand" width="120" show-overflow-tooltip />
          <el-table-column label="1688 货源" width="120">
            <template #default="{ row }">
              <a v-if="row.source_url_1688" :href="row.source_url_1688" target="_blank" rel="noopener noreferrer">查看货源</a>
              <span v-else style="color:#c0c4cc">未维护</span>
            </template>
          </el-table-column>
          <el-table-column label="原产国" prop="country_of_origin" width="90" />
          <el-table-column label="尺寸(mm)" width="130">
            <template #default="{ row }">
              <span v-if="row.weight" style="font-size:12px">{{ row.width }}×{{ row.depth }}×{{ row.height }}</span>
              <span v-else style="color:#ccc">-</span>
            </template>
          </el-table-column>
          <el-table-column label="重量(g)" prop="weight" width="80" />
          <el-table-column label="最后同步" prop="updated_at" width="150">
            <template #default="{ row }">
              <span style="font-size:11px; color:#666">{{ (row.updated_at || '').slice(0,19).replace('T',' ') }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="72" fixed="right" align="center">
            <template #default="{ row }">
              <el-dropdown trigger="click" placement="bottom-end" @command="handleProductAction">
                <el-button link style="width:28px; height:28px; padding:0; color:#64748b">
                  <el-icon size="18"><MoreFilled /></el-icon>
                </el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item :command="{ action: 'edit', row }">
                      <el-icon><EditPen /></el-icon><span>编辑商品</span>
                    </el-dropdown-item>
                    <el-dropdown-item v-if="row.status !== 'IN_ACTIVE'" :command="{ action: 'archive', row }" divided>
                      <el-icon><CircleClose /></el-icon><span style="color:#ef4444">归档商品</span>
                    </el-dropdown-item>
                    <el-dropdown-item v-else :command="{ action: 'unarchive', row }" divided>
                      <el-icon><CircleCheck /></el-icon><span style="color:#059669">重新上架</span>
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </template>
          </el-table-column>
        </el-table>

        <div style="position:sticky; bottom:0; left:0; right:0; margin-top:0; padding:12px 0; background:#f8fafc; z-index:10; display:flex; justify-content:flex-end">
          <el-pagination
            v-model:current-page="pagination.currentPage"
            v-model:page-size="pagination.pageSize"
            :total="pagination.total"
            :page-sizes="[20, 50, 100]"
            layout="total, sizes, prev, pager, next"
            @size-change="onSizeChange"
            @current-change="onPageChange"
          />
        </div>
      </div>

      <!-- 生产力级编辑抽屉 (v0.3.3 加主图预览 + 归档) -->
      <el-drawer v-model="drawer.visible" title="商品资料编辑" size="760px" destroy-on-close>
        <el-form :model="drawer.form" label-position="top" size="small">
          <el-alert :title="syncFieldsNote" type="info" :closable="false" show-icon style="margin-bottom:12px" />
          <el-alert
            v-if="drawer.form.status === 'FAILED_MODERATION' || drawer.form.status === 'NEED_ATTENTION'"
            :title="issueSummary(drawer.form)"
            type="warning"
            :closable="false"
            show-icon
            style="margin-bottom:12px" />
          <!-- v0.3.4 主图 + 图册 + 编辑/替换/新增/删除 -->
          <el-divider content-position="left">
            商品主图与图册
            <span style="font-size:11px; color:#999; margin-left:8px">支持上传替换、拖拽排序、AI 改图</span>
          </el-divider>
          <div style="display:flex; gap:12px; margin-bottom:12px">
            <div style="position:relative; width:180px; height:180px; flex-shrink:0">
              <el-image
                :src="drawer.form.image"
                style="width:180px; height:180px; border:1px solid #ebeef5; border-radius:6px"
                fit="cover"
                preview-teleported
                :preview-src-list="allPreviewList()"
                :initial-index="0">
                <template #error>
                  <div style="width:180px; height:180px; background:#f5f7fa; display:flex; flex-direction:column; align-items:center; justify-content:center; color:#c0c4cc">
                    <el-icon size="32"><Picture /></el-icon>
                    <span style="font-size:12px; margin-top:8px">暂无主图</span>
                  </div>
                </template>
              </el-image>
              <el-upload
                :show-file-list="false"
                :http-request="(o) => uploadImage(o, 'primary')"
                accept="image/*"
                style="position:absolute; bottom:6px; right:6px">
                <el-button size="small" type="primary" circle>
                  <el-icon><Edit /></el-icon>
                </el-button>
              </el-upload>
            </div>
            <div style="flex:1; overflow:hidden">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px">
                <span style="font-size:13px; color:#666">图册 ({{ (drawer.form.images || []).length }} 张)</span>
                <div>
                  <el-upload
                    :show-file-list="false"
                    :http-request="(o) => uploadImage(o, 'gallery')"
                    accept="image/*"
                    style="display:inline-block">
                    <el-button size="small" type="success" plain>
                      <el-icon><Plus /></el-icon>&nbsp;上传副图
                    </el-button>
                  </el-upload>
                  <el-button size="small" type="warning" plain @click="aiRefineImage" :loading="aiImageLoading">
                    ✨ AI 改图
                  </el-button>
                </div>
              </div>
              <div style="display:flex; flex-wrap:wrap; gap:6px; max-height:180px; overflow-y:auto; padding:4px; border:1px dashed #ebeef5; border-radius:4px; min-height:60px">
                <div v-for="(u, i) in (drawer.form.images || [])" :key="i"
                     style="position:relative; width:52px; height:52px">
                  <el-image :src="u" style="width:52px; height:52px; border-radius:4px" fit="cover"
                            preview-teleported :preview-src-list="drawer.form.images" :initial-index="i" />
                  <el-icon @click="removeGalleryImage(i)"
                           style="position:absolute; top:-4px; right:-4px; background:#f56c6c; color:white; border-radius:50%; cursor:pointer; font-size:14px; padding:2px">
                    <Close />
                  </el-icon>
                </div>
                <div v-if="!drawer.form.images?.length" style="font-size:12px; color:#c0c4cc; padding:8px">无副图 · 点击上方"上传副图"新增</div>
              </div>
              <div style="margin-top:8px; display:flex; gap:6px">
                <el-button size="small" plain @click="aiFillProduct" :loading="aiFillLoading">
                  🤖 AI 自动填充商品信息
                </el-button>
                <el-button size="small" plain @click="aiPricing" :loading="aiPriceLoading">
                  💰 AI 智能核价
                </el-button>
              </div>
            </div>
          </div>

          <el-divider content-position="left">基础信息</el-divider>
          <el-row :gutter="16">
            <el-col :span="18">
              <el-form-item label="1. 商品名称 (俄语)">
                <el-input v-model="drawer.form.name" placeholder="Ozon 页面显示的标题" />
              </el-form-item>
            </el-col>
            <el-col :span="6">
              <el-form-item label="2. 品牌">
                <el-input v-model="drawer.form.brand" />
              </el-form-item>
            </el-col>
          </el-row>

          <el-row :gutter="16">
            <el-col :span="8">
              <el-form-item label="3. 原产国">
                <el-select v-model="drawer.form.country_of_origin" style="width:100%" filterable>
                  <el-option label="中国 (Китай)" value="Китай" />
                  <el-option label="俄罗斯 (Россия)" value="Россия" />
                  <el-option label="美国" value="США" />
                  <el-option label="日本" value="Япония" />
                  <el-option label="韩国" value="Республика Корея" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <!-- v0.3.5: 类目三级 cascader, 支持逐级选择 + 搜索, 数据来自 Ozon /v1/description-category/tree -->
              <el-form-item label="4. 类目 (三级 Cascader)">
                <el-cascader
                  v-model="drawer.categoryPath"
                  :options="categoryTree"
                  :props="{ label: 'label', value: 'category_key', children: 'children', checkStrictly: true, emitPath: true }"
                  filterable
                  clearable
                  :loading="categoryLoading"
                  placeholder="选择或搜索 Ozon 类目"
                  style="width:100%"
                  @change="onCategoryChange"
                  @visible-change="ensureCategoryTree" />
                <div style="margin-top:6px; font-size:12px; color:#909399">
                  当前：{{ currentCategoryText }}
                  <span v-if="drawer.form.description_category_id"> · 类目 ID {{ drawer.form.description_category_id }}</span>
                  <span v-if="drawer.form.type_id"> · Type ID {{ drawer.form.type_id }}</span>
                </div>
                <div v-if="categoryPathMissing" style="margin-top:4px; font-size:12px; color:#e6a23c">
                  已有类目 ID，但未在当前店铺类目树中匹配到三级路径；请搜索并重新选择一次 Ozon 类目。
                </div>
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="5. 条形码 Barcode">
                <el-input v-model="drawer.form.barcode" />
              </el-form-item>
            </el-col>
          </el-row>

          <el-divider content-position="left">价格</el-divider>
          <el-row :gutter="16">
            <el-col :span="6">
              <el-form-item label="6. 售价">
                <el-input-number v-model="drawer.form.price" :min="0" :precision="2" style="width:100%" />
              </el-form-item>
            </el-col>
            <el-col :span="6">
              <el-form-item label="7. 划线价 (Old)">
                <el-input-number v-model="drawer.form.old_price" :min="0" :precision="2" style="width:100%" />
              </el-form-item>
            </el-col>
            <el-col :span="6">
              <el-form-item label="8. 最低价 (Min)">
                <el-input-number v-model="drawer.form.min_price" :min="0" :precision="2" style="width:100%" />
              </el-form-item>
            </el-col>
            <el-col :span="3">
              <el-form-item label="9. 币种">
                <el-select v-model="drawer.form.currency_code" style="width:100%">
                  <el-option label="RUB" value="RUB" />
                  <el-option label="CNY" value="CNY" />
                  <el-option label="USD" value="USD" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="9">
              <el-alert
                type="info"
                :closable="false"
                show-icon
                style="margin-top:22px"
                :title="'当前总库存 ' + (drawer.form.stock ?? 0) + '，库存和仓库请到库存管理修改'" />
            </el-col>
          </el-row>

          <el-divider content-position="left">物流尺寸 & 重量</el-divider>
          <el-row :gutter="16">
            <el-col :span="6">
              <el-form-item label="10. 重量 (g)">
                <el-input-number v-model="drawer.form.weight" :min="0" style="width:100%" />
              </el-form-item>
            </el-col>
            <el-col :span="6">
              <el-form-item label="11. 宽度 (mm)">
                <el-input-number v-model="drawer.form.width" :min="0" style="width:100%" />
              </el-form-item>
            </el-col>
            <el-col :span="6">
              <el-form-item label="12. 深度 (mm)">
                <el-input-number v-model="drawer.form.depth" :min="0" style="width:100%" />
              </el-form-item>
            </el-col>
            <el-col :span="6">
              <el-form-item label="13. 高度 (mm)">
                <el-input-number v-model="drawer.form.height" :min="0" style="width:100%" />
              </el-form-item>
            </el-col>
          </el-row>

          <el-divider content-position="left">采购信息</el-divider>
          <el-row :gutter="16">
            <el-col :span="8">
              <el-form-item label="采购价 (CNY)">
                <el-input-number v-model="drawer.form.purchase_price_cny" :min="0" :precision="2" style="width:100%" />
              </el-form-item>
            </el-col>
            <el-col :span="16">
              <el-form-item label="1688 采购链接">
                <el-input v-model="drawer.form.source_url_1688" clearable placeholder="https://detail.1688.com/offer/..." />
              </el-form-item>
            </el-col>
          </el-row>

          <el-divider content-position="left">商品描述</el-divider>
          <el-form-item label="14. 详细描述 (Description)">
            <el-input v-model="drawer.form.description" type="textarea" :rows="8" placeholder="Ozon 详情页正文" />
          </el-form-item>

          <el-divider content-position="left">系统只读字段</el-divider>
          <el-descriptions :column="3" size="small" border>
            <el-descriptions-item label="Ozon Product ID">{{ drawer.form.product_id || '-' }}</el-descriptions-item>
            <el-descriptions-item label="Ozon SKU">{{ drawer.form.sku || '-' }}</el-descriptions-item>
            <el-descriptions-item label="Ozon Model ID">{{ drawer.form.model_id || '-' }}</el-descriptions-item>
            <el-descriptions-item label="状态">{{ productStatusLabel(drawer.form) }}</el-descriptions-item>
            <el-descriptions-item label="Ozon 状态">{{ drawer.form.status_name || '-' }}</el-descriptions-item>
            <el-descriptions-item label="类目 ID">{{ drawer.form.description_category_id || '-' }}</el-descriptions-item>
            <el-descriptions-item label="价格指数">{{ drawer.form.price_index || '-' }}</el-descriptions-item>
            <el-descriptions-item label="本地更新" :span="3">{{ (drawer.form.updated_at || '').slice(0,19).replace('T',' ') }}</el-descriptions-item>
          </el-descriptions>
        </el-form>

        <template #footer>
          <el-button @click="drawer.visible = false">取消</el-button>
          <el-button v-if="drawer.form.status !== 'IN_ACTIVE'" type="danger" plain @click="() => { archiveProduct(drawer.form); drawer.visible = false; }">
            归档商品
          </el-button>
          <el-button v-else type="success" plain @click="() => { unarchiveProduct(drawer.form); drawer.visible = false; }">
            重新上架
          </el-button>
          <el-button type="primary" :loading="saveLoading" @click="saveProduct">保存并同步价格/图片</el-button>
        </template>
      </el-drawer>

      <el-dialog v-model="bulkStockDialog.visible" title="批量设置库存" width="680px" destroy-on-close>
        <div style="display:flex; flex-direction:column; gap:14px">
          <el-alert
            type="info"
            :closable="false"
            show-icon
            :title="bulkStockDialog.loadingDetails ? '正在读取所选商品的分仓库存明细...' : '批量设置会按所选商品归属店铺分别生成库存草稿；勾选立即提交时，会继续走 Ozon 实时库存冲突检查。'" />
          <el-form label-position="top" size="large">
            <el-form-item label="设置范围">
              <el-radio-group v-model="bulkStockDialog.warehouseMode" @change="refreshBulkStockPreview">
                <el-radio-button label="default">每个商品默认仓库</el-radio-button>
                <el-radio-button label="specific">指定仓库</el-radio-button>
              </el-radio-group>
            </el-form-item>
            <el-form-item v-if="bulkStockDialog.warehouseMode === 'specific'" label="仓库">
              <div v-if="bulkStockDialog.loadingDetails" style="color:#64748b; font-size:13px; font-weight:700">正在读取仓库...</div>
              <el-empty v-else-if="!selectedStoreWarehouseGroups.length" description="未读取到可指定仓库" :image-size="64" />
              <div v-else style="display:flex; flex-direction:column; gap:10px; width:100%">
                <div
                  v-for="group in selectedStoreWarehouseGroups"
                  :key="'bulk-stock-store-' + group.store_id"
                  style="display:grid; grid-template-columns:150px minmax(0,1fr); gap:10px; align-items:center; padding:10px 12px; border:1px solid #e2e8f0; border-radius:8px; background:#f8fafc">
                  <div style="min-width:0; color:#334155; font-weight:900; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">
                    {{ group.store_name }}
                  </div>
                  <el-select
                    v-model="bulkStockDialog.warehouseByStore[group.store_id]"
                    filterable
                    placeholder="选择该店铺仓库"
                    style="width:100%"
                    @change="refreshBulkStockPreview">
                    <el-option v-for="item in group.options" :key="group.store_id + '-' + item.warehouse_id" :label="item.label" :value="item.warehouse_id" />
                  </el-select>
                </div>
              </div>
            </el-form-item>
            <el-form-item label="目标库存">
              <el-input-number v-model="bulkStockDialog.target_stock" :min="0" :precision="0" :step="1" controls-position="right" style="width:180px" @change="refreshBulkStockPreview" />
            </el-form-item>
            <el-form-item>
              <el-checkbox v-model="bulkStockDialog.submitNow">保存草稿后立即提交至 Ozon</el-checkbox>
            </el-form-item>
          </el-form>
          <div style="display:flex; justify-content:space-between; align-items:center; color:#64748b; font-size:13px; font-weight:700">
            <span>{{ bulkStockDialog.loadingDetails ? '正在读取仓库...' : '将生成 ' + bulkStockDialog.preview.length + ' 条库存草稿' }}</span>
            <span v-if="bulkStockDialog.skipped">跳过 {{ bulkStockDialog.skipped }} 个无可用仓库商品</span>
          </div>
          <el-table :data="bulkStockDialog.preview.slice(0, 8)" size="small" border max-height="260">
            <el-table-column prop="store_name" label="店铺" width="120" show-overflow-tooltip />
            <el-table-column prop="offer_id" label="货号" min-width="150" show-overflow-tooltip />
            <el-table-column prop="warehouse_id" label="仓库 ID" width="110" />
            <el-table-column prop="current_stock" label="当前库存" width="100" />
            <el-table-column prop="target_stock" label="目标库存" width="100" />
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

      <el-dialog v-model="bulkPriceDialog.visible" title="批量改价（跨店铺同 SKU 统一价格）" width="640px" destroy-on-close>
        <el-alert type="info" :closable="false" show-icon style="margin-bottom:12px">
          勾选要改价的商品，输入新售价后批量提交 Ozon。同 SKU 在多个店铺时逐店铺提交（服务端按店铺分组），改价后本地同步并清除促销标记。
        </el-alert>
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:14px">
          <span style="font-weight:700; color:#0f172a; white-space:nowrap">新售价（{{ bulkPriceDialog.rows[0]?.currency_code || 'RUB' }}）</span>
          <el-input-number v-model="bulkPriceDialog.newPrice" :min="1" :precision="2" :step="1" style="width:180px" />
          <span style="font-size:12px; color:#94a3b8">将覆盖所选商品当前价</span>
        </div>
        <el-table :data="bulkPriceDialog.rows" max-height="360" border size="small" style="width:100%">
          <el-table-column type="selection" width="44" :selectable="() => true" @selection-change="(rows) => { bulkPriceDialog.rows.forEach(r => r.selected = rows.includes(r)); }" />
          <el-table-column label="货号" min-width="150" show-overflow-tooltip prop="offer_id" />
          <el-table-column label="商品" min-width="180" show-overflow-tooltip prop="name" />
          <el-table-column label="当前价" width="100" align="right">
            <template #default="{ row }">{{ row.currency_code }} {{ Number(row.price).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="促销价" width="100" align="right">
            <template #default="{ row }">
              <span v-if="row.marketing_seller_price > 0" style="color:#f56c6c; font-weight:700">{{ Number(row.marketing_seller_price).toFixed(2) }}</span>
              <span v-else style="color:#c0c4cc">-</span>
            </template>
          </el-table-column>
        </el-table>
        <template #footer>
          <el-button @click="bulkPriceDialog.visible=false">取消</el-button>
          <el-button type="primary" :loading="bulkPriceDialog.submitting" @click="saveBulkPrices">提交改价</el-button>
        </template>
      </el-dialog>
    </div>
  `
};
