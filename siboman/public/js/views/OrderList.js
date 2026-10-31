window.OrderListView = {
  setup() {
    const orders = Vue.ref([]);
    const loading = Vue.ref(false);
    const summaryRows = Vue.ref([]);
    const summaryLoading = Vue.ref(false);
    const kpiRows = Vue.ref([]);
    const previousKpiRows = Vue.ref([]);
    const kpiLoading = Vue.ref(false);
    const hasFetched = Vue.ref(false);
    // Ozon v3/posting/fbs/list 严格要求小写 status alias
    const activeTab = Vue.ref('all');
    const pagination = Vue.reactive({ currentPage: 1, pageSize: 20, total: 0 });
    const selectedOrders = Vue.ref([]);
    const notes = Vue.reactive({});
    const batchLoading = Vue.ref(false);
    const noteDialog = Vue.reactive({ visible: false, store_id: '', posting_number: '', note: '', saving: false });
    const procurementDialog = Vue.reactive({
      visible: false,
      saving: false,
      store_id: '',
      posting_number: '',
      offer_id: '',
      sku: '',
      name: '',
      quantity: 1,
      source_url_1688: '',
      outbound_cost_cny: 0,
      row: null,
    });
    const lastBatchResult = Vue.ref(null);
    const shops = Vue.ref([]);
    const ALL_STORES = '__all__';
    const CURRENT_STORE = '__current__';
    const storeScope = Vue.ref([CURRENT_STORE]);
    let previousStoreScope = [CURRENT_STORE];
    const searchKeyword = Vue.ref('');
    const filterField = Vue.ref('all');
    const autoSync = Vue.ref(true);
    const kpiAnchorAt = Vue.ref(null);
    const syncWindowDialog = Vue.reactive({ visible: false, since: '', to: '' });
    let autoSyncTimer = null;
    const ORDER_SUMMARY_PAGE_SIZE = 200;
    const ORDER_SUMMARY_MAX_PAGES_PER_STORE = 10;

    // v0.3.5: 时窗筛选 (Ozon 限制窗口 ≤ 1 年)
    const dateRange = Vue.ref([]);
    const rangeShortcuts = [
      { text: '近 30 天', value: () => { const e = new Date(); const s = new Date(e - 30*86400e3); return [s, e]; } },
      { text: '近 90 天', value: () => { const e = new Date(); const s = new Date(e - 90*86400e3); return [s, e]; } },
      { text: '近 6 个月', value: () => { const e = new Date(); const s = new Date(e - 180*86400e3); return [s, e]; } },
      { text: '近 1 年', value: () => { const e = new Date(); const s = new Date(e - 360*86400e3); return [s, e]; } },
    ];

    // v0.3.3 详情抽屉 & 发货对话框
    const detailDrawer = Vue.reactive({ visible: false, loading: false, order: null });
    const shipDialog = Vue.reactive({ visible: false, loading: false, store_id: '', posting_number: '', products: [] });

    // 动态取店铺 ID
    const getStoreId = () => {
      const raw = window.getCurrentStoreId ? window.getCurrentStoreId() : (localStorage.getItem('currentStoreId') || '');
      return String(raw || '').split(',').map(value => value.trim()).find(Boolean) || '';
    };
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
    const effectiveStoreIdForOrder = (row) => String(row?.store_id || row?.storeId || getStoreId() || '').trim();

    const notify = {
      success: (m) => (window.ElementPlus?.ElMessage || console).success?.(m),
      warning: (m) => (window.ElementPlus?.ElMessage || console).warning?.(m),
      error: (m) => (window.ElementPlus?.ElMessage || console).error?.(m),
    };

    const statusTabs = [
      { label: '所有订单', value: 'all' },
      { label: '待备货', value: 'awaiting_packaging' },
      { label: '待发运', value: 'awaiting_deliver' },
      { label: '已超时', value: 'overdue' },
      { label: '运输中', value: 'delivering' },
      { label: '有争议的', value: 'arbitration' },
      { label: '已送达', value: 'delivered' },
      { label: '已取消', value: 'cancelled' },
    ];

    const statusTagType = (s) => ({
      awaiting_packaging: 'warning',
      awaiting_deliver: 'primary',
      delivering: 'success',
      delivered: 'success',
      cancelled: 'danger',
      arbitration: 'danger',
      dispute: 'danger',
    }[s] || 'info');
    const statusText = (s) => ({
      awaiting_packaging: '待备货', awaiting_deliver: '备货中', delivering: '运输中',
      driver_pickup: '配送员取件', delivered: '已送达', cancelled: '已取消',
      arbitration: '争议中', dispute: '争议中',
    }[s] || s || '-');
    const apiStatusForActiveTab = () => (activeTab.value === 'overdue' ? 'all' : activeTab.value);
    const orderEmptyText = Vue.computed(() => {
      if (!hasFetched.value) return '正在读取订单...';
      const tab = statusTabs.find((item) => item.value === activeTab.value)?.label || '当前状态';
      const scope = isAllStoresScope() ? '全部店铺' : '所选店铺';
      return `暂无${tab}订单。可调整店铺、状态或日期范围后刷新；当前显示${scope}订单。`;
    });
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
    const todayLabel = Vue.computed(() => {
      const d = new Date();
      const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
      return `${d.toISOString().slice(0, 10)} ${week}`;
    });
    const syncRangeText = Vue.computed(() => {
      const [sinceD, toD] = dateRange.value || [];
      if (!sinceD || !toD) {
        const custom = syncWindowBounds();
        const anchor = custom?.sync_to ? new Date(custom.sync_to) : (kpiAnchorAt.value ? new Date(kpiAnchorAt.value) : new Date());
        const since = custom?.sync_since ? new Date(custom.sync_since) : new Date(anchor.getTime() - 24 * 3600 * 1000);
        const format = (date) => {
          const pad = (n) => String(n).padStart(2, '0');
          return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
        };
        return `同步范围：${format(since)} 至 ${format(anchor)}（从上次同步前 1 天开始，避免漏单）`;
      }
      const sinceText = `${sinceD} 00:00`;
      const toText = `${toD} 23:59`;
      return `同步范围：${sinceText} 至 ${toText}（从上次同步前 1 天开始，避免漏单）`;
    });
    const dateRangeBounds = () => {
      const [sinceD, toD] = dateRange.value || [];
      return {
        since: sinceD ? new Date(`${sinceD}T00:00:00+08:00`).toISOString() : undefined,
        to: toD ? new Date(`${toD}T23:59:59+08:00`).toISOString() : undefined,
      };
    };
    const toDateTimeLocal = (date) => {
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };
    const syncWindowBounds = () => {
      if (!syncWindowDialog.since || !syncWindowDialog.to) return null;
      return {
        sync_since: new Date(`${syncWindowDialog.since}:00+08:00`).toISOString(),
        sync_to: new Date(`${syncWindowDialog.to}:59+08:00`).toISOString(),
      };
    };
    const ensureSyncWindowDefaults = () => {
      if (syncWindowDialog.since && syncWindowDialog.to) return;
      const to = kpiAnchorAt.value ? new Date(kpiAnchorAt.value) : new Date();
      const since = new Date(to.getTime() - 24 * 3600 * 1000);
      syncWindowDialog.since = toDateTimeLocal(since);
      syncWindowDialog.to = toDateTimeLocal(to);
    };
    const openSyncWindowDialog = () => {
      ensureSyncWindowDefaults();
      syncWindowDialog.visible = true;
    };
    const saveSyncWindow = () => {
      const bounds = syncWindowBounds();
      if (!bounds || new Date(bounds.sync_since).getTime() > new Date(bounds.sync_to).getTime()) {
        notify.warning('请设置有效的同步时间范围');
        return;
      }
      syncWindowDialog.visible = false;
      notify.success('同步时间已设置');
    };
    const resetSyncWindow = () => {
      syncWindowDialog.since = '';
      syncWindowDialog.to = '';
      syncWindowDialog.visible = false;
      notify.success('已恢复默认同步时间');
    };
    const filterOptions = [
      { label: '全部字段', value: 'all' },
      { label: '货件编号', value: 'posting' },
      { label: 'SKU', value: 'sku' },
      { label: '货号', value: 'offer' },
      { label: '商品名', value: 'name' },
    ];
    const roundMoney = (value) => Math.round(Number(value || 0) * 100) / 100;
    const moneyText = (value) => `¥${Number(value || 0).toFixed(2)}`;
    // v2.2.9.143 利润相关（对齐 Yandex 订单详情）
    // v2.2.9.146 WHD 退货（Ozon /v1/returns/list，实测全部是 schema=Whd）
    const returnsDrawer = Vue.reactive({ visible: false, loading: false, rows: [], error: '', scanned: 0, failed: [] });
    const openReturns = async () => {
      returnsDrawer.visible = true;
      returnsDrawer.loading = true;
      returnsDrawer.error = '';
      returnsDrawer.rows = [];
      returnsDrawer.failed = [];
      try {
        // ⚠️ 不能用 selectedStoreIds()：订单页默认带的是 CURRENT_STORE，
        //   localStorage 里可能存着一个**已失效的旧店铺 id**，结果只查那一个、
        //   而且它的 API Key 还是错的 → 一条都出不来。
        //   WHD 退货直接查**全部 Ozon 店铺**（表格里有「店铺」列可区分）。
        let ids = activeStoreIds();
        if (!ids.length) { await fetchShops(); ids = activeStoreIds(); }
        if (!ids.length) { returnsDrawer.error = '没有可用的 Ozon 店铺'; returnsDrawer.loading = false; return; }
        const all = [];
        const failed = [];
        for (const sid of ids) {
          try {
            const res = await axios.post('/api/seller/returns', { store_id: sid, limit: 200 });
            const storeName = (shops.value.find((x) => String(x.id) === String(sid)) || {}).name || '';
            (res.data?.returns || []).forEach((r) => all.push({ ...r, store_id: sid, store_name: storeName }));
          } catch (e) {
            // 个别店铺 API Key 失效/无权限时，不要让整个列表挂掉
            const name = (shops.value.find((x) => String(x.id) === String(sid)) || {}).name || sid;
            failed.push(`${name}（${e.response?.data?.error || e.message}）`);
          }
        }
        returnsDrawer.failed = failed;
        all.sort((a, b) => new Date(b.return_date || b.final_moment || 0) - new Date(a.return_date || a.final_moment || 0));
        returnsDrawer.rows = all;
        returnsDrawer.scanned = ids.length;
      } catch (e) {
        returnsDrawer.error = e.response?.data?.error || e.message || '读取失败';
      } finally {
        returnsDrawer.loading = false;
      }
    };
    const returnsTypeText = (t) => ({ ClientReturn: '客户退货', Cancellation: '订单取消' }[t] || t || '-');
    const returnsTypeTag = (t) => (t === 'ClientReturn' ? 'warning' : 'info');

    // v2.2.9.143 导入 Ozon 应收费用结算 xlsx
    const feesFileInput = Vue.ref(null);
    const feesImporting = Vue.ref(false);
    const pickFeesFile = () => { if (feesFileInput.value) feesFileInput.value.click(); };
    const onFeesFile = async (ev) => {
      const file = ev && ev.target && ev.target.files ? ev.target.files[0] : null;
      if (!file) return;
      feesImporting.value = true;
      try {
        const b64 = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result || "").split(",")[1] || "");
          r.onerror = reject;
          r.readAsDataURL(file);
        });
        const res = await axios.post('/api/seller/order-fees/import', { file_base64: b64, filename: file.name });
        const d = res.data || {};
        notify.success(`已导入 ${d.imported} 个订单的费用（表「${d.sheet}」）｜累计 ${d.stored} 单，` +
          `合计 ₽${Number(d.sum_total || 0).toFixed(2)} / ¥${Number(d.sum_total_cny || 0).toFixed(2)}` +
          (d.period ? `｜结算期 ${d.period}` : ''));
        await fetchOrders();
      } catch (e) {
        notify.error('导入失败：' + (e.response && e.response.data && e.response.data.error || e.message));
      } finally {
        feesImporting.value = false;
        if (ev && ev.target) ev.target.value = '';
      }
    };
    const profitOf = (o) => (o && o.profit) || null;
    const profitColor = (o) => {
      const p = profitOf(o);
      if (!p || p.profit_cny === null || p.profit_cny === undefined) return '#94a3b8';
      return p.profit_cny >= 0 ? '#16a34a' : '#dc2626';
    };
    const profitText = (o) => {
      const p = profitOf(o);
      if (!p) return '待核算';
      if (p.profit_cny === null || p.profit_cny === undefined) return '待核算（缺成本）';
      return `¥${Number(p.profit_cny).toFixed(2)}`;
    };
    const trendColor = (value) => Number(value || 0) >= 0 ? '#059669' : '#dc2626';
    const trendText = (value, suffix = '%') => {
      const n = Number(value || 0);
      const arrow = n >= 0 ? '↑' : '↓';
      return `${arrow} ${Math.abs(n).toFixed(1)}${suffix}`;
    };
    const primaryProduct = (row) => (row.products || [])[0] || {};
    const orderRowKey = (row) => `${effectiveStoreIdForOrder(row)}:${row.posting_number || ''}`;
    // Ozon 返回的是 UTC（Z）时间，这里统一转成北京时间（UTC+8）展示
    const toBeijingTime = (iso) => {
      if (!iso) return '';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso).replace('T', ' ').slice(0, 16);
      const bj = new Date(d.getTime() + 8 * 3600 * 1000);
      return bj.toISOString().replace('T', ' ').slice(0, 16);
    };
    const rowCreatedTime = (row) => toBeijingTime(row.in_process_at || row.created_at) || '-';
    const rowStatusSubtext = (row) => {
      if (row.status === 'awaiting_packaging') return '已创建';
      if (row.status === 'awaiting_deliver') return '待交给物流';
      return row.substatus || row.delivery_method?.name || row.tpl_integration_type || '-';
    };
    const copyPostingNumber = async (row) => {
      if (!row?.posting_number) return;
      try {
        await navigator.clipboard?.writeText(row.posting_number);
        notify.success('货件编号已复制');
      } catch {
        notify.warning('复制失败，请手动复制');
      }
    };
    const rowTextForSearch = (row) => {
      const productText = (row.products || []).map((p) => [p.sku, p.offer_id, p.name].join(' ')).join(' ');
      return [row.posting_number, row.status, row.store_name, productText].join(' ').toLowerCase();
    };
    const rowMatchesSearch = (row) => {
      const q = searchKeyword.value.trim().toLowerCase();
      if (!q) return true;
      if (filterField.value === 'posting') return String(row.posting_number || '').toLowerCase().includes(q);
      if (filterField.value === 'sku') return (row.products || []).some((p) => String(p.sku || '').toLowerCase().includes(q));
      if (filterField.value === 'offer') return (row.products || []).some((p) => String(p.offer_id || '').toLowerCase().includes(q));
      if (filterField.value === 'name') return (row.products || []).some((p) => String(p.name || '').toLowerCase().includes(q));
      return rowTextForSearch(row).includes(q);
    };
    const deadlineHours = (row) => {
      const raw = row.shipment_date || row.delivering_date || '';
      if (!raw) return null;
      const ms = new Date(raw).getTime() - Date.now();
      if (!Number.isFinite(ms)) return null;
      return Math.floor(ms / 3600000);
    };
    const isOverdue = (row) => {
      const hours = deadlineHours(row);
      return ['awaiting_packaging', 'awaiting_deliver'].includes(row.status) && hours !== null && hours <= 0;
    };
    const deadlineBadgeStyle = (row) => {
      if (isOverdue(row)) return { background:'#fef2f2', color:'#dc2626', borderColor:'#fecaca' };
      const hours = deadlineHours(row);
      if (hours !== null && hours <= 24) return { background:'#fff7ed', color:'#c2410c', borderColor:'#fed7aa' };
      return { background:'#ecfdf5', color:'#059669', borderColor:'#d1fae5' };
    };
    const deadlineHourText = (row) => {
      const hours = deadlineHours(row);
      if (hours === null) return { main: '-', unit: '' };
      if (hours <= 0) return { main: '超时', unit: '' };
      return { main: String(hours), unit: '小时' };
    };
    const warehouseText = (row) => row.analytics_data?.warehouse_name || row.delivery_method?.warehouse || row.warehouse_name || 'CEL陆空';
    const deliveryText = (row) => row.delivery_method?.name || row.tpl_integration_type || row.analytics_data?.delivery_type || 'CEL Economy';
    const orderDelivered = (row) => String(row.status || '').toLowerCase() === 'delivered';
    const orderOutboundCost = (row) => roundMoney(Number(row.outbound_cost_cny || 0));
    const orderCommission = (row) => roundMoney(Math.abs(Number(row.commission_cny || 0)));
    const orderLastMile = (row) => roundMoney(Math.abs(Number(row.last_mile_cny || 0)));
    const orderOzonCost = (row) => roundMoney(orderCommission(row) + orderLastMile(row));
    const orderTotalCost = (row) => roundMoney(orderCommission(row) + orderLastMile(row) + orderOutboundCost(row));
    const orderProfit = (row) => roundMoney(Number(row.total_cny || 0) - orderTotalCost(row));
    const orderProfitRate = (row) => {
      const total = Number(row.total_cny || 0);
      if (!total) return 0;
      return Math.round(orderProfit(row) / total * 1000) / 10;
    };
    const hasOrderProfit = (row) => orderDelivered(row) && Number(row.outbound_cost_cny || 0) > 0;
    const isKpiGmvOrder = (row) => String(row.status || '').toLowerCase() !== 'cancelled';
    const kpiOrderProfit = (row) => {
      const products = row.products || [];
      if (!products.length || !hasOrderProfit(row)) return 0;
      return orderProfit(row);
    };
    const ordersMetric = (rows) => {
      const metricRows = rows.filter(isKpiGmvOrder);
      const gmv = metricRows.reduce((sum, row) => sum + Number(row.total_cny || 0), 0);
      const profit = metricRows.reduce((sum, row) => sum + Number(kpiOrderProfit(row) || 0), 0);
      return {
        gmv: Math.round(gmv * 100) / 100,
        profit: Math.round(profit * 100) / 100,
        profitRate: gmv ? Math.round(profit / gmv * 1000) / 10 : 0,
      };
    };
    const metricDelta = (current, previous) => {
      const c = Number(current || 0);
      const p = Number(previous || 0);
      if (!p) return c ? 100 : 0;
      return Math.round((c - p) / Math.abs(p) * 1000) / 10;
    };
    const displayedOrders = Vue.computed(() => {
      const filtered = orders.value
        .filter((row) => activeTab.value === 'overdue' ? isOverdue(row) : true)
        .filter(rowMatchesSearch);
      // 多店铺/全部店铺时数据是一次性拉回前端的，这里做前端分页；
      // 单店铺走服务端分页（offset 已按页切好），不再二次切片。
      const aggregate = isAllStoresScope() || selectedStoreIds().length > 1;
      if (!aggregate) return filtered;
      const start = (pagination.currentPage - 1) * pagination.pageSize;
      return filtered.slice(start, start + pagination.pageSize);
    });
    const summaryStats = Vue.computed(() => {
      const current = ordersMetric(kpiRows.value);
      const previous = ordersMetric(previousKpiRows.value);
      const operationalRows = summaryRows.value.length ? summaryRows.value : orders.value;
      const pending = operationalRows.filter((row) => ['awaiting_packaging', 'awaiting_deliver'].includes(row.status)).length;
      return {
        gmv: current.gmv,
        profit: current.profit,
        profitRate: current.profitRate,
        gmvTrend: metricDelta(current.gmv, previous.gmv),
        profitTrend: metricDelta(current.profit, previous.profit),
        profitRateTrend: Math.round((current.profitRate - previous.profitRate) * 10) / 10,
        pending,
        awaitingPackaging: operationalRows.filter((row) => row.status === 'awaiting_packaging').length,
        awaitingDeliver: operationalRows.filter((row) => row.status === 'awaiting_deliver').length,
      };
    });
    const statusCount = (value) => {
      const rows = summaryRows.value.length ? summaryRows.value : orders.value;
      if (value === 'all') return summaryRows.value.length || pagination.total || orders.value.length;
      if (value === 'overdue') return rows.filter(isOverdue).length;
      return rows.filter((row) => row.status === value || (value === 'arbitration' && row.status === 'dispute')).length;
    };
    const statusTabItems = Vue.computed(() => statusTabs.map((tab) => ({ ...tab, count: statusCount(tab.value) })));
    const selectStatusTab = (value) => {
      activeTab.value = value;
      pagination.currentPage = 1;
      fetchOrders();
    };

    const fetchOrders = async (syncMode = 'cache') => {
      const storeIds = selectedStoreIds();
      if (!storeIds.length) {
        hasFetched.value = true;
        orders.value = [];
        pagination.total = 0;
        return;
      }
      loading.value = true;
      try {
        const { since, to } = dateRangeBounds();
        const aggregateStoreMode = isAllStoresScope() || storeIds.length > 1;
        // 多店铺/全部店铺：一次性拉满每店最多 200 单，前端按页切片（分页在前端做）；
        // 单店铺：服务端按 limit/offset 分页。
        const limit = aggregateStoreMode ? 200 : pagination.pageSize;
        const offset = aggregateStoreMode ? 0 : (pagination.currentPage - 1) * pagination.pageSize;
        const results = await Promise.allSettled(storeIds.map((sid) => axios.post('/api/seller/orders', {
          store_id: sid,
          status: apiStatusForActiveTab(),
          since, to,
          sync_mode: syncMode,
          ...(syncMode === 'latest' ? (syncWindowBounds() || {}) : {}),
          limit,
          offset,
        }).then((res) => ({ sid, data: res.data }))));
        const failures = [];
        const rows = [];
        let total = 0;
        for (const result of results) {
          if (result.status !== 'fulfilled') {
            failures.push(result.reason?.response?.data?.error || result.reason?.message || '未知错误');
            continue;
          }
          const { sid, data } = result.value;
          const storeName = storeNameById(sid);
          const storeRows = (data.orders || []).map((row) => ({ ...row, store_id: sid, store_name: storeName }));
          rows.push(...storeRows);
          total += Number(data.total || storeRows.length || 0);
        }
        if (failures.length) notify.warning(`部分店铺订单读取失败：${failures.slice(0, 2).join('；')}`);
        rows.sort((a, b) => new Date(b.in_process_at || b.created_at || 0) - new Date(a.in_process_at || a.created_at || 0));
        orders.value = rows;
        pagination.total = aggregateStoreMode ? rows.length : total;
        for (const key of Object.keys(notes)) delete notes[key];
        const numbersByStore = rows.reduce((acc, row) => {
          const sid = effectiveStoreIdForOrder(row);
          if (!sid || !row.posting_number) return acc;
          if (!acc[sid]) acc[sid] = [];
          acc[sid].push(row.posting_number);
          return acc;
        }, {});
        for (const [sid, numbers] of Object.entries(numbersByStore)) {
          const noteRes = await axios.get('/api/seller/orders/notes', { params: { store_id: sid, numbers: numbers.join(',') } });
          const scopedNotes = noteRes.data.notes || {};
          for (const [postingNumber, note] of Object.entries(scopedNotes)) {
            notes[`${sid}:${postingNumber}`] = note;
            notes[postingNumber] = note;
          }
        }
      } catch (e) {
        const msg = e.response?.data?.payload?.message || e.response?.data?.error || e.message;
        notify.error('获取订单失败: ' + msg);
      } finally {
        hasFetched.value = true;
        loading.value = false;
      }
    };

    // 分页控件回调：多店铺/全部店铺走前端切片（无需重拉），单店铺走服务端分页（重拉）
    const onPageChange = () => {
      const aggregate = isAllStoresScope() || selectedStoreIds().length > 1;
      if (!aggregate) fetchOrders('cache');
    };
    const onPageSizeChange = () => {
      pagination.currentPage = 1;
      onPageChange();
    };

    const fetchOrderSummary = async () => {
      const storeIds = selectedStoreIds();
      if (!storeIds.length) {
        summaryRows.value = [];
        return;
      }
      summaryLoading.value = true;
      try {
        const { since, to } = dateRangeBounds();
        const results = await Promise.allSettled(storeIds.map(async (sid) => {
          const rows = [];
          for (let page = 0; page < ORDER_SUMMARY_MAX_PAGES_PER_STORE; page++) {
            const res = await axios.post('/api/seller/orders', {
              store_id: sid,
              status: 'all',
              since,
              to,
              sync_mode: 'cache',
              limit: ORDER_SUMMARY_PAGE_SIZE,
              offset: page * ORDER_SUMMARY_PAGE_SIZE,
            });
            const batch = (res.data.orders || []).map((row) => ({
              ...row,
              store_id: sid,
              store_name: storeNameById(sid),
            }));
            rows.push(...batch);
            if (!res.data.has_next || batch.length < ORDER_SUMMARY_PAGE_SIZE) break;
          }
          return rows;
        }));
        const merged = [];
        const failures = [];
        for (const result of results) {
          if (result.status === 'fulfilled') merged.push(...result.value);
          else failures.push(result.reason?.response?.data?.error || result.reason?.message || '未知错误');
        }
        if (failures.length) notify.warning(`部分店铺统计读取失败：${failures.slice(0, 2).join('；')}`);
        summaryRows.value = merged.sort((a, b) => new Date(b.in_process_at || b.created_at || 0) - new Date(a.in_process_at || a.created_at || 0));
      } catch (e) {
        notify.error('获取订单统计失败: ' + (e.response?.data?.payload?.message || e.response?.data?.error || e.message));
      } finally {
        summaryLoading.value = false;
      }
    };

    const weekKpiRanges = () => {
      const end = kpiAnchorAt.value ? new Date(kpiAnchorAt.value) : new Date();
      const start = new Date(end);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - 6);
      const previousStart = new Date(end.getTime() - 14 * 86400e3);
      const previousEnd = new Date(start.getTime() - 1);
      return {
        current: { since: start.getTime(), to: end.getTime() },
        previous: { since: previousStart.getTime(), to: previousEnd.getTime() },
      };
    };

    const fetchOrdersForStores = async (storeIds, range, pageSize = ORDER_SUMMARY_PAGE_SIZE) => {
      const results = await Promise.allSettled(storeIds.map(async (sid) => {
        const rows = [];
        for (let page = 0; page < ORDER_SUMMARY_MAX_PAGES_PER_STORE; page++) {
          const res = await axios.post('/api/seller/orders', {
            store_id: sid,
            status: 'all',
            ...(range?.since ? { since: range.since } : {}),
            ...(range?.to ? { to: range.to } : {}),
            sync_mode: 'cache',
            limit: pageSize,
            offset: page * pageSize,
          });
          const batch = (res.data.orders || []).map((row) => ({
            ...row,
            store_id: sid,
            store_name: storeNameById(sid),
          }));
          rows.push(...batch);
          if (!res.data.has_next || batch.length < pageSize) break;
        }
        return rows;
      }));
      const merged = [];
      const failures = [];
      for (const result of results) {
        if (result.status === 'fulfilled') merged.push(...result.value);
        else failures.push(result.reason?.response?.data?.error || result.reason?.message || '未知错误');
      }
      return { rows: merged, failures };
    };

    const fetchOrderKpis = async () => {
      const storeIds = selectedStoreIds();
      if (!storeIds.length) {
        kpiRows.value = [];
        previousKpiRows.value = [];
        return;
      }
      kpiLoading.value = true;
      try {
        if (!kpiAnchorAt.value) kpiAnchorAt.value = new Date().toISOString();
        const ranges = weekKpiRanges();
        const trendSource = await fetchOrdersForStores(storeIds, null);
        if (trendSource.failures.length) {
          notify.warning(`部分店铺本周经营指标读取失败：${trendSource.failures.slice(0, 2).join('；')}`);
        }
        const rowTime = (row) => new Date(row.in_process_at || row.created_at || 0).getTime();
        kpiRows.value = trendSource.rows.filter((row) => {
          const time = rowTime(row);
          return Number.isFinite(time) && time >= ranges.current.since && time <= ranges.current.to;
        });
        previousKpiRows.value = trendSource.rows.filter((row) => {
          const time = rowTime(row);
          return Number.isFinite(time) && time >= ranges.previous.since && time <= ranges.previous.to;
        });
      } catch (e) {
        notify.error('获取本周经营指标失败: ' + (e.response?.data?.payload?.message || e.response?.data?.error || e.message));
      } finally {
        kpiLoading.value = false;
      }
    };

    const refreshOrderDashboard = async (syncMode = 'cache') => {
      kpiAnchorAt.value = new Date().toISOString();
      if (syncMode === 'cache') {
        await Promise.all([fetchOrders('cache'), fetchOrderSummary(), fetchOrderKpis()]);
        return;
      }
      await fetchOrders(syncMode);
      await Promise.all([fetchOrderSummary(), fetchOrderKpis()]);
    };
    const pullLatestOrders = () => refreshOrderDashboard('latest');
    const refreshInProgressOrders = () => refreshOrderDashboard('in_progress');

    // v0.3.3 订单详情
    const openDetail = async (row) => {
      detailDrawer.visible = true;
      detailDrawer.loading = true;
      detailDrawer.order = null;
      try {
        const res = await axios.post('/api/seller/orders/detail', {
          store_id: effectiveStoreIdForOrder(row),
          posting_number: row.posting_number,
        });
        detailDrawer.order = res.data.order;
      } catch (e) {
        notify.error('获取详情失败: ' + (e.response?.data?.error || e.message));
      } finally {
        detailDrawer.loading = false;
      }
    };

    // v0.3.3 一键发货 (整单)
    const openShipDialog = (row) => {
      if (row.status !== 'awaiting_packaging' && row.status !== 'awaiting_deliver') {
        return notify.warning('当前状态无法发货');
      }
      shipDialog.posting_number = row.posting_number;
      shipDialog.store_id = effectiveStoreIdForOrder(row);
      shipDialog.products = (row.products || []).map(p => ({
        product_id: p.sku,
        offer_id: p.offer_id,
        name: p.name,
        quantity: p.quantity,
      }));
      shipDialog.visible = true;
    };
    const confirmShip = async () => {
      shipDialog.loading = true;
      try {
        await axios.post('/api/seller/orders/ship', {
          store_id: shipDialog.store_id || getStoreId(),
          posting_number: shipDialog.posting_number,
          packages: [{
            products: shipDialog.products.map(p => ({
              product_id: Number(p.product_id),
              quantity: Number(p.quantity),
            })),
          }],
        });
        notify.success('发货指令已下发');
        shipDialog.visible = false;
        fetchOrders();
      } catch (e) {
        notify.error('发货失败: ' + (e.response?.data?.payload?.message || e.response?.data?.error || e.message));
      } finally {
        shipDialog.loading = false;
      }
    };

    const onSelectionChange = (rows) => { selectedOrders.value = rows || []; };
    // v2.2.9.156 打印面单：后端 /api/seller/orders/labels 早就写好了但前端没有入口。
    //   Ozon 只允许「待备货 / 待发运」的单出标签，其它状态接口会报 INVALID_ARGUMENT，
    //   所以这里先本地筛一遍，给出明确提示。
    const labelsPrinting = Vue.ref(false);
    // v2.2.9.157 生成拣货单：调卖家后台异步报告（assembly/list → report/status → report/download），
    //   接口会话绑定 IP，只能由插件在 seller.ozon.ru 里带着登录态调用。
    const pickListBusy = Vue.ref(false);
    const printPickList = async () => {
      const sel = selectedOrders.value || [];
      if (!sel.length) return notify.warning('请先勾选要生成拣货单的订单');
      const postingNumbers = sel.map((row) => String(row.posting_number || row.order_id || '')).filter(Boolean);
      if (!postingNumbers.length) return notify.warning('所选订单没有货件编号');
      const send = window.__zhumeng_send__;
      if (typeof send !== 'function') return notify.warning('检测不到采集插件，请确认浏览器已安装并启用');
      pickListBusy.value = true;
      try {
        const res = await send('pickList.request', { postingNumbers }, 180000);
        if (!res || res.ok !== true) {
          const detail = res?.step ? `（失败步骤：${res.step}）` : '';
          return notify.error('生成拣货单失败' + detail + '：' + String(res?.error || res?.text || '插件无返回').slice(0, 200));
        }
        const bin = atob(res.base64 || '');
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        notify.success(`已生成 ${postingNumbers.length} 个订单的拣货单（${Math.round((res.size || 0) / 1024)} KB）`);
      } catch (e) {
        notify.error('生成拣货单失败：' + String(e.message || e).slice(0, 200));
      } finally {
        pickListBusy.value = false;
      }
    };
    const printLabels = async () => {
      const sel = selectedOrders.value || [];
      if (!sel.length) return notify.warning('请先勾选要打印面单的订单');
      const eligible = sel.filter((row) => ['awaiting_packaging', 'awaiting_deliver'].includes(String(row.status || '')));
      if (!eligible.length) {
        return notify.warning(`所选 ${sel.length} 个订单都不是「待备货/待发运」状态，Ozon 不允许打印面单`);
      }
      // 按店铺分组（凭证是按店铺的）
      const byStore = new Map();
      for (const row of eligible) {
        const sid = String(row.store_id || row.storeId || '').trim();
        if (!sid) continue;
        if (!byStore.has(sid)) byStore.set(sid, []);
        byStore.get(sid).push(String(row.posting_number || row.order_id || ''));
      }
      if (!byStore.size) return notify.warning('所选订单没有关联店铺，无法打印');
      labelsPrinting.value = true;
      try {
        const blobs = [];
        for (const [storeId, postings] of byStore) {
          const res = await axios.post('/api/seller/orders/labels', { store_id: storeId, posting_numbers: postings }, { responseType: 'blob' });
          blobs.push(res.data);
        }
        const blob = new Blob(blobs, { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        notify.success(`已生成 ${eligible.length} 个订单的面单${eligible.length < sel.length ? `（${sel.length - eligible.length} 个状态不符已跳过）` : ''}`);
      } catch (e) {
        let msg = e.message;
        try {
          if (e.response?.data instanceof Blob) msg = JSON.parse(await e.response.data.text())?.error || msg;
          else if (e.response?.data?.error) msg = e.response.data.error;
        } catch (_e2) { /* 保持原错误 */ }
        notify.error('打印面单失败：' + String(msg).slice(0, 200));
      } finally {
        labelsPrinting.value = false;
      }
    };
    const orderNote = (row) => {
      const sid = effectiveStoreIdForOrder(row);
      return notes[`${sid}:${row.posting_number}`]?.note || notes[row.posting_number]?.note || '';
    };
    const openNoteDialog = (row) => {
      noteDialog.posting_number = row.posting_number;
      noteDialog.store_id = effectiveStoreIdForOrder(row);
      noteDialog.note = orderNote(row);
      noteDialog.visible = true;
    };
    const saveNote = async () => {
      noteDialog.saving = true;
      try {
        const res = await axios.post(`/api/seller/orders/${encodeURIComponent(noteDialog.posting_number)}/note`, {
          store_id: noteDialog.store_id || getStoreId(), note: noteDialog.note,
        });
        notes[`${noteDialog.store_id || getStoreId()}:${noteDialog.posting_number}`] = res.data.note;
        notes[noteDialog.posting_number] = res.data.note;
        noteDialog.visible = false;
        notify.success('订单备注已保存');
      } catch (e) { notify.error('备注保存失败: ' + (e.response?.data?.error || e.message)); }
      finally { noteDialog.saving = false; }
    };
    const procurementPreview = Vue.computed(() => {
      const row = procurementDialog.row || {};
      const outboundCost = roundMoney(Number(procurementDialog.outbound_cost_cny || 0));
      const commission = orderCommission(row);
      const lastMile = orderLastMile(row);
      const sales = roundMoney(Number(row.total_cny || 0));
      return {
        sales,
        commission,
        lastMile,
        ozonCost: roundMoney(commission + lastMile),
        outboundCost,
        totalCost: roundMoney(commission + lastMile + outboundCost),
        profit: roundMoney(sales - commission - lastMile - outboundCost),
        calculable: orderDelivered(row),
      };
    });
    const openProcurementSource = (row) => {
      const product = primaryProduct(row);
      if (!product.offer_id) return notify.warning('当前订单没有可编辑的商品货号');
      procurementDialog.store_id = effectiveStoreIdForOrder(row);
      procurementDialog.posting_number = row.posting_number || '';
      procurementDialog.offer_id = product.offer_id || '';
      procurementDialog.sku = product.sku || '';
      procurementDialog.name = product.name || '';
      procurementDialog.quantity = Number(product.quantity || row.product_count || 1);
      procurementDialog.source_url_1688 = product.source_url_1688 || '';
      procurementDialog.outbound_cost_cny = Number(row.outbound_cost_cny || 0);
      procurementDialog.row = row;
      procurementDialog.visible = true;
    };
    const saveProcurementSource = async () => {
      const cost = Number(procurementDialog.outbound_cost_cny);
      if (!Number.isFinite(cost) || cost < 0) return notify.warning('请输入有效的出单总成本');
      procurementDialog.saving = true;
      try {
        const res = await axios.post(`/api/seller/orders/${encodeURIComponent(procurementDialog.posting_number)}/source`, {
          store_id: procurementDialog.store_id || getStoreId(),
          offer_id: procurementDialog.offer_id,
          outbound_cost_cny: cost,
          source_url_1688: procurementDialog.source_url_1688,
        });
        const updatedOrder = res.data.order;
        const updatedProduct = res.data.product;
        const target = orders.value.find((row) => orderRowKey(row) === orderRowKey(procurementDialog.row));
        if (target && updatedOrder) Object.assign(target, updatedOrder, { store_name: target.store_name, store_id: target.store_id });
        else if (target && updatedProduct) {
          const product = (target.products || []).find((item) => String(item.offer_id) === String(updatedProduct.offer_id));
          if (product) Object.assign(product, updatedProduct);
        }
        procurementDialog.visible = false;
        notify.success(orderDelivered(target || procurementDialog.row) ? '货源和出单总成本已保存，利润已重算' : '货源和出单总成本已保存，订单已送达后会计算利润');
        fetchOrderSummary();
        fetchOrderKpis();
      } catch (e) {
        notify.error('保存货源失败: ' + (e.response?.data?.error || e.message));
      } finally {
        procurementDialog.saving = false;
      }
    };
    const findSourceForOrder = (row) => {
      const product = primaryProduct(row);
      sessionStorage.setItem('singleSourcingPrefill', JSON.stringify({
        from: 'orders',
        posting_number: row.posting_number,
        offer_id: product.offer_id || '',
        sku: product.sku || '',
        name: product.name || '',
        image: product.image || '',
      }));
      window.location.hash = '#/single-sourcing';
    };
    const handleRowAction = ({ action, row }) => {
      if (action === 'detail') return openDetail(row);
      if (action === 'source') return openProcurementSource(row);
      if (action === 'find-source') return findSourceForOrder(row);
      if (action === 'prepare') return openShipDialog(row);
      if (action === 'note') return openNoteDialog(row);
      if (action === 'cancel') return cancelOrder(row);
    };
    const cancelOrder = async (row) => {
      try {
        const reasonResult = await window.ElementPlus.ElMessageBox.prompt(
          `订单 ${row.posting_number} 会按 Ozon 真实取消接口参数提交。测试环境未启用沙箱开关时，后端会阻止真实调用。`,
          '取消订单',
          {
            confirmButtonText: '继续填写原因 ID',
            cancelButtonText: '关闭',
            inputPlaceholder: '取消原因说明，可不填',
            type: 'warning',
          },
        );
        const idResult = await window.ElementPlus.ElMessageBox.prompt(
          '请输入 Ozon cancel_reason_id。该值会原样提交给 /v2/posting/fbs/cancel。',
          'Ozon 取消原因 ID',
          {
            confirmButtonText: '提交取消',
            cancelButtonText: '关闭',
            inputPattern: /^[1-9]\d*$/,
            inputErrorMessage: 'cancel_reason_id 必须是正整数',
            inputPlaceholder: '例如：352',
            type: 'warning',
          },
        );
        await axios.post('/api/seller/orders/cancel', {
          store_id: effectiveStoreIdForOrder(row),
          posting_number: row.posting_number,
          reason: reasonResult.value || '',
          cancel_reason_id: Number(idResult.value),
        });
        notify.success('取消接口调用成功，请刷新订单状态确认');
      } catch (e) {
        if (e === 'cancel' || e === 'close') return;
        notify.error('取消订单失败: ' + (e.response?.data?.error || e.message || e));
      }
    };

    const exportOrders = async () => {
      try {
        const storeIds = selectedStoreIds();
        if (!storeIds.length) return notify.warning('请先选择店铺');
        if (storeIds.length > 1) return notify.warning('全部店铺导出请先切到单家店铺后分别导出');
        const { since, to } = dateRangeBounds();
        const res = await axios.post('/api/seller/orders/export', {
          store_id: storeIds[0],
          status: activeTab.value === 'all' ? '' : activeTab.value,
          since,
          to,
          limit: 1000,
        }, { responseType: 'blob' });
        const url = URL.createObjectURL(res.data);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ozon-orders-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) { notify.error('导出失败: ' + (e.response?.data?.error || e.message)); }
    };

    const batchShip = async () => {
      const eligible = selectedOrders.value.filter((row) => ['awaiting_packaging', 'awaiting_deliver'].includes(row.status));
      if (!eligible.length) return notify.warning('所选订单中没有可发货订单');
      try {
        await window.ElementPlus.ElMessageBox.confirm(
          `将对 ${eligible.length} 个订单执行不可逆的发货操作，请确认商品已经完成备货。`,
          '批量发货确认',
          { type: 'warning', confirmButtonText: '确认发货', cancelButtonText: '取消' },
        );
      } catch { return; }
      batchLoading.value = true;
      let succeeded = 0;
      const errors = [];
      for (const row of eligible) {
        try {
          await axios.post('/api/seller/orders/ship', {
            store_id: effectiveStoreIdForOrder(row), posting_number: row.posting_number,
            packages: [{ products: (row.products || []).map((product) => ({ product_id: Number(product.sku), quantity: Number(product.quantity || 1) })) }],
          });
          succeeded++;
        } catch (e) { errors.push(`${row.posting_number}: ${e.response?.data?.error || e.message}`); }
      }
      batchLoading.value = false;
      if (errors.length) notify.warning(`成功 ${succeeded} 单，失败 ${errors.length} 单`); else notify.success(`已提交 ${succeeded} 个订单`);
      lastBatchResult.value = {
        action: '批量发货',
        succeeded,
        failed: errors.length,
        errors,
      };
      selectedOrders.value = [];
      fetchOrders();
    };

    const deadlineInfo = (row) => {
      if (!['awaiting_packaging', 'awaiting_deliver'].includes(row.status)) return { text: '-', urgent: false };
      const raw = row.shipment_date || row.delivering_date || '';
      if (!raw) return { text: '-', urgent: false };
      const ms = new Date(raw).getTime() - Date.now();
      if (!Number.isFinite(ms)) return { text: '-', urgent: false };
      if (ms <= 0) return { text: '已超时', urgent: true };
      const hours = Math.floor(ms / 3600000);
      const minutes = Math.floor((ms % 3600000) / 60000);
      return { text: `${hours}小时${minutes}分`, urgent: ms <= 2 * 3600000 };
    };

    const onShopChanged = () => {
      if (storeScopeValues().includes(CURRENT_STORE)) {
        selectedOrders.value = [];
      }
      pagination.currentPage = 1;
      orders.value = [];
      selectedOrders.value = [];
      pagination.total = 0;
      refreshOrderDashboard();
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
      if (normalized.includes(CURRENT_STORE) && normalized.length > 1) {
        normalized = normalized.filter((item) => item !== CURRENT_STORE);
      }
      normalized = [...new Set(normalized)].filter(Boolean);
      if (!normalized.length) normalized = [CURRENT_STORE];
      storeScope.value = normalized;
      previousStoreScope = normalized.slice();
      pagination.currentPage = 1;
      orders.value = [];
      summaryRows.value = [];
      kpiRows.value = [];
      previousKpiRows.value = [];
      selectedOrders.value = [];
      pagination.total = 0;
      refreshOrderDashboard();
    };
    const fetchShops = async () => {
      try {
        const res = await axios.get('/api/seller/shops');
        // 订单管理只处理 Ozon 店铺：Yandex 店铺（CELbudget 等）走的是 Yandex 凭证，
        // 若混进 Ozon 拉单会报「Invalid Api-Key」，这里直接过滤掉。
        shops.value = (res.data.shops || []).filter((shop) => !shop.platform || shop.platform === 'ozon');
      } catch (e) {
        console.warn('订单页拉取店铺列表失败', e.message);
      }
    };
    const setupAutoSync = () => {
      if (autoSyncTimer) clearInterval(autoSyncTimer);
      autoSyncTimer = null;
      if (!autoSync.value) return;
      autoSyncTimer = setInterval(() => refreshOrderDashboard('latest'), 5 * 60 * 1000);
    };
    Vue.watch(autoSync, setupAutoSync);
    window.addEventListener('shop-changed', onShopChanged);
    Vue.onBeforeUnmount(() => {
      window.removeEventListener('shop-changed', onShopChanged);
      if (autoSyncTimer) clearInterval(autoSyncTimer);
    });

    Vue.onMounted(() => {
      fetchShops().finally(() => refreshOrderDashboard());
      setupAutoSync();
    });

    return {
      orders, displayedOrders, loading, summaryLoading, kpiLoading, activeTab, statusTabs, statusTabItems, pagination,
      selectedOrders, notes, batchLoading, noteDialog, procurementDialog, procurementPreview, syncWindowDialog,
      lastBatchResult, hasFetched, orderEmptyText, shops, currentStoreName,
      storeScope, storeScopeOptions, onStoreScopeChange,
      detailDrawer, shipDialog,
      fetchOrders, fetchOrderSummary, fetchOrderKpis, refreshOrderDashboard, pullLatestOrders, refreshInProgressOrders,
      onPageChange, onPageSizeChange, toBeijingTime,
      openSyncWindowDialog, saveSyncWindow, resetSyncWindow, openDetail, openShipDialog, confirmShip, statusTagType, statusText,
      onSelectionChange, orderNote, openNoteDialog, saveNote, exportOrders, batchShip, deadlineInfo,
      openProcurementSource, saveProcurementSource, findSourceForOrder, handleRowAction, cancelOrder,
      selectStatusTab, searchKeyword, filterField, filterOptions, autoSync,
      todayLabel, syncRangeText, summaryStats, moneyText, trendText, trendColor, primaryProduct, rowCreatedTime,
      profitColor, profitText, profitOf,   // v2.2.9.143 详情里的利润明细
      feesFileInput, feesImporting, pickFeesFile, onFeesFile,
      labelsPrinting, printLabels,   // v2.2.9.156 打印面单
      pickListBusy, printPickList,   // v2.2.9.157 生成拣货单
      returnsDrawer, openReturns, returnsTypeText, returnsTypeTag,   // v2.2.9.146 WHD 退货
      rowStatusSubtext, copyPostingNumber, deadlineBadgeStyle, warehouseText, deliveryText,
      orderProfit, orderProfitRate, hasOrderProfit, orderOutboundCost, orderCommission, orderLastMile, orderOzonCost, orderTotalCost, orderDelivered, deadlineHourText, orderRowKey,
      // v0.3.5 时窗
      dateRange, rangeShortcuts,
    };
  },
  template: `
    <div class="order-list-v3" style="background:#f8fafc; min-height:100%; padding:22px 30px 28px">
      <div style="max-width:1500px; margin:0 auto">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px; margin-bottom:18px">
          <div>
            <div style="font-size:28px; line-height:1; font-weight:800; color:#111827; letter-spacing:0">订单</div>
            <div style="margin-top:14px; font-size:14px; color:#64748b">{{ todayLabel }} · {{ currentStoreName }} · {{ autoSync ? '自动同步中' : '手动同步' }}</div>
          </div>
          <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; justify-content:flex-end">
            <el-tooltip content="重新读取本地缓存，不请求 Ozon" placement="top">
              <el-button size="large" @click="refreshOrderDashboard('cache')">
                <el-icon><Refresh /></el-icon><span>刷新</span>
              </el-button>
            </el-tooltip>
            <el-button size="large" type="primary" style="background:#111827; border-color:#111827" @click="pullLatestOrders">
              <el-icon><Download /></el-icon><span>拉取最新订单</span>
            </el-button>
            <el-button size="large" @click="openSyncWindowDialog">
              <el-icon><Calendar /></el-icon><span>设置时间</span>
            </el-button>
            <el-button size="large" @click="refreshInProgressOrders">
              <el-icon><RefreshRight /></el-icon><span>刷新进行中订单</span>
            </el-button>
          </div>
        </div>

        <div style="border:1px solid #dfe7f1; border-radius:8px; background:#fff; padding:14px 16px; color:#475569; font-weight:600; margin-bottom:18px">
          {{ syncRangeText }}
        </div>

        <div v-loading="kpiLoading || summaryLoading" element-loading-text="正在统计本周经营指标..." style="display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); border:1px solid #dfe7f1; border-radius:8px; overflow:hidden; background:#fff; margin-bottom:22px">
          <div style="padding:22px 28px; border-right:1px solid #e5edf6">
            <div style="font-size:13px; font-weight:700; color:#7c8798">本周 GMV</div>
            <div style="margin-top:12px; font-size:32px; font-weight:800; color:#111827">{{ moneyText(summaryStats.gmv) }}</div>
            <div :style="{ marginTop:'8px', color:trendColor(summaryStats.gmvTrend), fontSize:'13px', fontWeight:700 }">
              {{ trendText(summaryStats.gmvTrend) }} <span style="color:#64748b; font-weight:500">vs 上 7 天</span>
            </div>
          </div>
          <div style="padding:22px 28px; border-right:1px solid #e5edf6">
            <div style="font-size:13px; font-weight:700; color:#7c8798">本周利润</div>
            <div style="margin-top:12px; font-size:32px; font-weight:800; color:#111827">{{ moneyText(summaryStats.profit) }}</div>
            <div :style="{ marginTop:'8px', color:trendColor(summaryStats.profitTrend), fontSize:'13px', fontWeight:700 }">
              {{ trendText(summaryStats.profitTrend) }} <span style="color:#64748b; font-weight:500">vs 上 7 天</span>
            </div>
          </div>
          <div style="padding:22px 28px; border-right:1px solid #e5edf6">
            <div style="font-size:13px; font-weight:700; color:#7c8798">本周利润率</div>
            <div style="margin-top:12px; font-size:32px; font-weight:800; color:#111827">{{ summaryStats.profitRate }}<span style="font-size:18px">%</span></div>
            <div :style="{ marginTop:'8px', color:trendColor(summaryStats.profitRateTrend), fontSize:'13px', fontWeight:700 }">
              {{ trendText(summaryStats.profitRateTrend, 'pp') }} <span style="color:#64748b; font-weight:500">vs 上 7 天</span>
            </div>
          </div>
          <div style="padding:22px 28px">
            <div style="font-size:13px; font-weight:700; color:#7c8798">待处理</div>
            <div style="margin-top:12px; font-size:32px; font-weight:800; color:#111827">{{ summaryStats.pending }}</div>
            <div style="margin-top:8px; color:#64748b; font-size:13px">{{ summaryStats.awaitingPackaging }} 待备货 · {{ summaryStats.awaitingDeliver }} 待发运</div>
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

        <div style="display:grid; grid-template-columns:240px 130px minmax(240px,1fr) 250px 70px 70px; gap:10px; align-items:center; margin-bottom:12px">
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
            <el-option v-for="item in storeScopeOptions" :key="'filter-' + item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-select v-model="filterField" size="large" style="width:100%">
            <el-option v-for="item in filterOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-input v-model="searchKeyword" size="large" clearable placeholder="搜索货件号 / SKU / 货号 / 商品名..." style="width:100%">
            <template #prefix><el-icon><Search /></el-icon></template>
          </el-input>
          <el-date-picker
            v-model="dateRange"
            type="daterange"
            value-format="YYYY-MM-DD"
            start-placeholder="下单时间"
            end-placeholder="结束时间"
            :shortcuts="rangeShortcuts"
            size="large"
            style="width:100%"
            @change="() => { pagination.currentPage=1; refreshOrderDashboard(); }" />
          <el-button size="large" style="width:100%" @click="refreshOrderDashboard">筛选</el-button>
          <el-button size="large" style="width:100%" @click="() => { searchKeyword=''; filterField='all'; activeTab='all'; pagination.currentPage=1; refreshOrderDashboard(); }">重置</el-button>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:18px">
          <el-button size="large" type="warning" plain @click="exportOrders">
            <el-icon><Download /></el-icon><span>订单导出</span>
          </el-button>
          <el-button size="large" plain :loading="feesImporting" @click="pickFeesFile">
            <el-icon><Upload /></el-icon><span>导入费用结算</span>
          </el-button>
          <el-button size="large" plain @click="openReturns">
            <el-icon><Box /></el-icon><span>WHD 退货</span>
          </el-button>
          <input ref="feesFileInput" type="file" accept=".xlsx" style="display:none" @change="onFeesFile" />
          <div style="display:flex; align-items:center; gap:10px; color:#64748b; font-weight:700">
            <span :style="{ width:'8px', height:'8px', borderRadius:'50%', background:autoSync ? '#10b981' : '#cbd5e1', display:'inline-block' }"></span>
            <span>自动同步</span>
            <el-switch v-model="autoSync" />
          </div>
        </div>

        <div v-if="selectedOrders.length" style="display:flex; justify-content:space-between; align-items:center; padding:12px 14px; margin-bottom:12px; background:#eff6ff; border:1px solid #bfdbfe; border-radius:8px">
          <span style="font-size:13px; font-weight:700; color:#1e3a8a">已选择 {{ selectedOrders.length }} 个订单</span>
          <div style="display:flex; gap:8px"><el-button type="warning" size="small" :loading="batchLoading" @click="batchShip">批量发货</el-button><el-button size="small" :loading="labelsPrinting" @click="printLabels">打印面单</el-button><el-button size="small" :loading="pickListBusy" @click="printPickList">生成拣货单</el-button><el-button size="small" @click="exportOrders">导出当前筛选</el-button></div>
        </div>

        <el-alert
          v-if="lastBatchResult"
          :type="lastBatchResult.failed ? 'warning' : 'success'"
          :closable="false"
          show-icon
          style="margin-bottom:10px"
          :title="lastBatchResult.action + '结果'"
          :description="'成功 ' + lastBatchResult.succeeded + ' 单，失败 ' + lastBatchResult.failed + ' 单。' + (lastBatchResult.failed ? '失败订单仍停留在原状态，请按下方明细处理。' : '')" />
        <div v-if="lastBatchResult && lastBatchResult.errors && lastBatchResult.errors.length" style="margin-bottom:10px; border:1px solid #faecd8; background:#fffaf0; padding:10px 12px; border-radius:6px">
          <div style="font-size:12px; font-weight:700; color:#a16207; margin-bottom:6px">订单操作失败明细</div>
          <div v-for="(message, index) in lastBatchResult.errors.slice(0, 10)" :key="'order-error-' + index" style="font-size:12px; color:#7c2d12; line-height:1.7">{{ message }}</div>
          <div v-if="lastBatchResult.errors.length > 10" style="font-size:12px; color:#909399; margin-top:4px">其余 {{ lastBatchResult.errors.length - 10 }} 条请缩小筛选范围后重试。</div>
        </div>

        <el-table :data="displayedOrders" v-loading="loading" element-loading-text="正在读取订单..." border size="large" :empty-text="orderEmptyText" :row-key="orderRowKey" style="border-radius:8px; overflow:hidden; box-shadow:0 8px 24px rgba(15,23,42,.04)" @selection-change="onSelectionChange">
          <el-table-column type="selection" width="52" :selectable="(row) => row.status !== 'cancelled'" />
          <el-table-column label="倒计时" width="110">
            <template #default="{ row }">
              <div :style="{ width:'64px', minHeight:'48px', border:'1px solid', borderRadius:'10px', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', fontWeight:800, ...deadlineBadgeStyle(row) }">
                <span style="font-size:18px; line-height:1">{{ deadlineHourText(row).main }}</span>
                <span v-if="deadlineHourText(row).unit" style="font-size:11px; margin-top:2px">{{ deadlineHourText(row).unit }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="货件 / 状态" width="250">
            <template #default="{ row }">
              <div style="display:flex; flex-direction:column; gap:8px">
                <div style="display:flex; align-items:center; gap:6px">
                  <span style="font-size:15px; font-weight:800; color:#1f2937">{{ row.posting_number }}</span>
                  <el-button link type="primary" size="small" @click="copyPostingNumber(row)"><el-icon><CopyDocument /></el-icon></el-button>
                </div>
                <div style="display:flex; align-items:center; gap:8px">
                  <el-tag size="small" :type="statusTagType(row.status)">{{ statusText(row.status) }}</el-tag>
                  <span style="font-size:13px; color:#94a3b8">{{ rowCreatedTime(row) }}</span>
                </div>
                <div style="font-size:12px; color:#94a3b8">{{ rowStatusSubtext(row) }}</div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="店铺" width="135">
            <template #default="{ row }">
              <div style="display:inline-flex; align-items:center; gap:8px; background:#f1f5f9; border-radius:7px; padding:8px 10px; color:#475569; font-weight:800">
                <span style="width:5px; height:5px; border-radius:50%; background:#6366f1"></span>
                <span>{{ row.store_name || currentStoreName }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="商品" min-width="390">
            <template #default="{ row }">
              <div style="display:flex; gap:12px; align-items:center; min-width:0">
                <el-image :src="primaryProduct(row).image" style="width:58px; height:58px; border-radius:8px; flex-shrink:0; background:#f1f5f9" fit="cover" preview-teleported hide-on-click-modal :preview-src-list="primaryProduct(row).image ? [primaryProduct(row).image] : []">
                  <template #error>
                    <div style="width:58px; height:58px; background:#f1f5f9; display:flex; align-items:center; justify-content:center">
                      <el-icon color="#cbd5e1"><Picture /></el-icon>
                    </div>
                  </template>
                </el-image>
                <div style="min-width:0; flex:1">
                  <div style="font-size:15px; color:#1f2937; font-weight:800; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">{{ primaryProduct(row).name || '-' }}</div>
                  <div style="margin-top:6px; font-size:12px; color:#94a3b8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">
                    SKU {{ primaryProduct(row).sku || '-' }}　货号 {{ primaryProduct(row).offer_id || '-' }}　×{{ row.product_count || primaryProduct(row).quantity || 1 }}
                  </div>
                  <div style="margin-top:6px; display:flex; gap:10px; align-items:center; flex-wrap:wrap">
                    <a v-if="primaryProduct(row).source_url_1688" :href="primaryProduct(row).source_url_1688" target="_blank" rel="noopener noreferrer" style="font-size:12px; color:#2563eb">1688 采购</a>
                  </div>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="仓库 / 配送" width="180">
            <template #default="{ row }">
              <div style="font-weight:800; color:#1f2937">{{ warehouseText(row) }}</div>
              <div style="margin-top:5px; color:#64748b; font-size:13px">{{ deliveryText(row) }}</div>
              <div v-if="row.tracking_number" style="margin-top:5px; color:#4f46e5; font-size:12px">{{ row.tracking_number }}</div>
            </template>
          </el-table-column>
          <el-table-column label="订单金额" width="130" align="right">
            <template #default="{ row }">
              <div style="font-size:16px; font-weight:800; color:#1f2937">{{ moneyText(row.total_cny) }}</div>
              <div v-if="Number(row.total_rub || 0)" style="margin-top:4px; font-size:12px; color:#94a3b8">₽ {{ Number(row.total_rub || 0).toFixed(2) }}</div>
            </template>
          </el-table-column>
          <el-table-column label="利润" width="130" align="right">
            <template #default="{ row }">
              <template v-if="hasOrderProfit(row)">
                <div :style="{ fontSize:'16px', fontWeight:800, color: orderProfit(row) >= 0 ? '#059669' : '#dc2626' }">{{ moneyText(orderProfit(row)) }}</div>
                <div :style="{ marginTop:'4px', fontSize:'12px', color: orderProfit(row) >= 0 ? '#059669' : '#dc2626' }">{{ orderProfitRate(row) }}%</div>
                <div style="margin-top:4px; font-size:11px; color:#94a3b8">成本 {{ moneyText(orderTotalCost(row)) }}</div>
              </template>
              <el-button v-else-if="orderDelivered(row)" link type="warning" size="small" @click="openProcurementSource(row)">补出单成本</el-button>
              <span v-else style="color:#94a3b8; font-weight:700">已送达后计算</span>
            </template>
          </el-table-column>
          <el-table-column label="备注" width="170" show-overflow-tooltip>
            <template #default="{ row }">
              <el-button v-if="orderNote(row)" link type="warning" size="small" style="max-width:150px; padding:0; justify-content:flex-start" @click="openNoteDialog(row)">
                <span style="display:block; max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">{{ orderNote(row) }}</span>
              </el-button>
              <span v-else style="color:#94a3b8">-</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="72" fixed="right" align="center">
            <template #default="{ row }">
              <el-dropdown trigger="click" placement="bottom-end" @command="handleRowAction">
                <el-button link style="width:28px; height:28px; padding:0; color:#64748b">
                  <el-icon size="18"><MoreFilled /></el-icon>
                </el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item :command="{ action: 'detail', row }">
                      <el-icon><Search /></el-icon><span>查看详情</span>
                    </el-dropdown-item>
                    <el-dropdown-item :command="{ action: 'source', row }">
                      <el-icon><EditPen /></el-icon><span>编辑货源/采购</span>
                    </el-dropdown-item>
                    <el-dropdown-item :command="{ action: 'find-source', row }">
                      <el-icon><Search /></el-icon><span>找货源</span>
                    </el-dropdown-item>
                    <el-dropdown-item :command="{ action: 'prepare', row }" :disabled="!(row.status === 'awaiting_packaging' || row.status === 'awaiting_deliver')">
                      <el-icon><CircleCheck /></el-icon><span style="color:#2563eb">立即备货</span>
                    </el-dropdown-item>
                    <el-dropdown-item :command="{ action: 'cancel', row }" divided>
                      <el-icon><CircleClose /></el-icon><span style="color:#ef4444">取消订单</span>
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
            @size-change="onPageSizeChange"
            @current-change="onPageChange"
          />
        </div>
      </div>

      <el-dialog v-model="noteDialog.visible" title="订单备注" width="480px">
        <el-input v-model="noteDialog.note" type="textarea" :rows="5" maxlength="2000" show-word-limit placeholder="例如：加固包装、赠送贴纸、采购注意事项" />
        <template #footer><el-button @click="noteDialog.visible=false">取消</el-button><el-button type="primary" :loading="noteDialog.saving" @click="saveNote">保存备注</el-button></template>
      </el-dialog>

      <el-dialog v-model="procurementDialog.visible" title="编辑货源 / 出单成本" width="560px" style="max-width:calc(100vw - 40px)" destroy-on-close>
        <div style="display:grid; gap:14px; min-width:0">
          <div style="display:flex; gap:12px; align-items:flex-start; padding:12px; background:#f8fafc; border:1px solid #e5edf6; border-radius:8px; max-width:100%; box-sizing:border-box">
            <div style="min-width:0; flex:1; max-width:100%">
              <div style="font-size:14px; font-weight:800; color:#1f2937; white-space:normal; word-break:break-word; line-height:1.45">{{ procurementDialog.name || '-' }}</div>
              <div style="margin-top:6px; font-size:12px; color:#64748b; white-space:normal; word-break:break-word; line-height:1.6">货件 {{ procurementDialog.posting_number }} · 货号 {{ procurementDialog.offer_id }} · SKU {{ procurementDialog.sku || '-' }} · 数量 {{ procurementDialog.quantity }}</div>
            </div>
          </div>
          <el-form label-position="top">
            <el-form-item label="1688 货源链接">
              <el-input v-model="procurementDialog.source_url_1688" clearable placeholder="https://detail.1688.com/offer/..." />
            </el-form-item>
            <el-form-item label="出单总成本 (CNY)">
              <el-tooltip placement="top" content="决定利润计算 = 订单金额 - 出单总成本 - Ozon 佣金/尾程扣费。出单总成本包含采购、运费、包装、损耗等全部出单环节成本。">
                <el-icon style="margin-left:4px; color:#94a3b8"><QuestionFilled /></el-icon>
              </el-tooltip>
              <div style="width:100%; margin-top:8px">
                <el-input-number v-model="procurementDialog.outbound_cost_cny" :min="0" :precision="2" :step="1" controls-position="right" style="width:220px; max-width:100%" />
              </div>
            </el-form-item>
          </el-form>
          <div style="display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); border:1px solid #e5edf6; border-radius:8px; overflow:hidden; max-width:100%">
            <div style="padding:12px; border-right:1px solid #e5edf6; border-bottom:1px solid #e5edf6">
              <div style="font-size:12px; color:#64748b; font-weight:700">销售额</div>
              <div style="margin-top:6px; font-size:18px; font-weight:800; color:#111827">{{ moneyText(procurementPreview.sales) }}</div>
            </div>
            <div style="padding:12px; border-bottom:1px solid #e5edf6">
              <div style="font-size:12px; color:#64748b; font-weight:700">Ozon 佣金</div>
              <div style="margin-top:6px; font-size:18px; font-weight:800; color:#111827">{{ moneyText(procurementPreview.commission) }}</div>
            </div>
            <div style="padding:12px; border-right:1px solid #e5edf6; border-bottom:1px solid #e5edf6">
              <div style="font-size:12px; color:#64748b; font-weight:700">尾程/物流</div>
              <div style="margin-top:6px; font-size:18px; font-weight:800; color:#111827">{{ moneyText(procurementPreview.lastMile) }}</div>
            </div>
            <div style="padding:12px; border-bottom:1px solid #e5edf6">
              <div style="font-size:12px; color:#64748b; font-weight:700">出单总成本</div>
              <div style="margin-top:6px; font-size:18px; font-weight:800; color:#111827">{{ moneyText(procurementPreview.outboundCost) }}</div>
            </div>
            <div style="padding:12px; border-right:1px solid #e5edf6">
              <div style="font-size:12px; color:#64748b; font-weight:700">合计成本</div>
              <div style="margin-top:6px; font-size:18px; font-weight:800; color:#111827">{{ moneyText(procurementPreview.totalCost) }}</div>
            </div>
            <div style="padding:12px">
              <div style="font-size:12px; color:#64748b; font-weight:700">决定利润</div>
              <div v-if="procurementPreview.calculable" :style="{ marginTop:'6px', fontSize:'18px', fontWeight:800, color: procurementPreview.profit >= 0 ? '#059669' : '#dc2626' }">{{ moneyText(procurementPreview.profit) }}</div>
              <div v-else style="margin-top:6px; font-size:13px; font-weight:800; color:#94a3b8">已送达后计算</div>
            </div>
          </div>
          <div style="font-size:12px; color:#64748b; line-height:1.6">利润口径：订单金额 - 出单总成本 - Ozon 佣金 - 尾程/物流。尾程/物流来自 Ozon 财务明细里的履约、配送、转运等服务项；只有已送达订单才计算利润。</div>
        </div>
        <template #footer>
          <el-button @click="procurementDialog.visible=false">取消</el-button>
          <el-button type="primary" :loading="procurementDialog.saving" @click="saveProcurementSource">保存并重算利润</el-button>
        </template>
      </el-dialog>

      <el-dialog v-model="syncWindowDialog.visible" title="设置同步时间" width="520px">
        <div style="display:grid; gap:12px">
          <el-alert type="info" :closable="false" show-icon title="拉取最新订单会按这里设置的时间窗口同步；不设置时默认同步最近 1 天。" />
          <el-form label-position="top">
            <el-form-item label="开始时间">
              <el-input v-model="syncWindowDialog.since" type="datetime-local" />
            </el-form-item>
            <el-form-item label="结束时间">
              <el-input v-model="syncWindowDialog.to" type="datetime-local" />
            </el-form-item>
          </el-form>
        </div>
        <template #footer>
          <el-button @click="resetSyncWindow">恢复默认</el-button>
          <el-button @click="syncWindowDialog.visible=false">取消</el-button>
          <el-button type="primary" @click="saveSyncWindow">保存</el-button>
        </template>
      </el-dialog>

      <!-- v0.3.3 订单详情抽屉 -->
      <!-- v2.2.9.146 WHD 退货抽屉 -->
      <el-drawer v-model="returnsDrawer.visible" title="WHD 退货" size="980px" append-to-body destroy-on-close>
        <div v-loading="returnsDrawer.loading" element-loading-text="正在读取 WHD 退货...">
          <el-alert v-if="returnsDrawer.error" type="error" :closable="false" show-icon
            :title="'读取失败：' + returnsDrawer.error" style="margin-bottom:10px" />
          <el-alert v-if="returnsDrawer.failed.length" type="warning" :closable="false" show-icon style="margin-bottom:10px"
            :title="'有 ' + returnsDrawer.failed.length + ' 个店铺读取失败（已跳过，其余店铺正常显示）：' + returnsDrawer.failed.join('；')" />
          <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px">
            <el-tag type="success" effect="plain">共 {{ returnsDrawer.rows.length }} 条</el-tag>
            <span style="font-size:12px; color:#94a3b8">
              来源 Ozon 官方接口 /v1/returns/list（schema=Whd，仓库「Склад WHD」）
            </span>
            <el-button size="small" @click="openReturns">刷新</el-button>
          </div>
          <el-table :data="returnsDrawer.rows" size="small" border max-height="72vh" empty-text="没有 WHD 退货记录">
            <el-table-column label="店铺" width="120" show-overflow-tooltip>
              <template #default="{ row }">{{ row.store_name || '-' }}</template>
            </el-table-column>
            <el-table-column label="退货单号" width="150">
              <template #default="{ row }"><span style="font-family:monospace">{{ row.posting_number || '-' }}</span></template>
            </el-table-column>
            <el-table-column label="订单号" width="130">
              <template #default="{ row }"><span style="font-family:monospace">{{ row.order_number || '-' }}</span></template>
            </el-table-column>
            <el-table-column label="类型" width="96">
              <template #default="{ row }">
                <el-tag size="small" :type="returnsTypeTag(row.type)" effect="plain">{{ returnsTypeText(row.type) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="退货原因" min-width="170" show-overflow-tooltip>
              <template #default="{ row }">{{ row.reason || '-' }}</template>
            </el-table-column>
            <el-table-column label="商品" min-width="230">
              <template #default="{ row }">
                <div style="font-size:12px">{{ row.product_name || '-' }}</div>
                <div style="font-size:11px; color:#94a3b8">货号 {{ row.offer_id || '-' }} · SKU {{ row.sku || '-' }}</div>
              </template>
            </el-table-column>
            <el-table-column label="数量" width="60" align="center">
              <template #default="{ row }">×{{ row.quantity || 1 }}</template>
            </el-table-column>
            <el-table-column label="金额" width="100" align="right">
              <template #default="{ row }">
                {{ row.currency === 'CNY' ? '¥' : '' }}{{ Number(row.price || 0).toFixed(2) }}{{ row.currency && row.currency !== 'CNY' ? ' ' + row.currency : '' }}
              </template>
            </el-table-column>
            <el-table-column label="退货时间" width="150">
              <template #default="{ row }">{{ toBeijingTime(row.return_date || row.final_moment) || '-' }}</template>
            </el-table-column>
            <el-table-column label="仓库" min-width="110" show-overflow-tooltip>
              <template #default="{ row }">{{ row.place || '-' }}</template>
            </el-table-column>
          </el-table>
        </div>
      </el-drawer>

      <el-drawer v-model="detailDrawer.visible" title="订单详情" size="720px" destroy-on-close>
        <div v-loading="detailDrawer.loading">
          <template v-if="detailDrawer.order">
            <el-descriptions :column="2" border size="small">
              <el-descriptions-item label="货件单号"><b>{{ detailDrawer.order.posting_number }}</b></el-descriptions-item>
              <el-descriptions-item label="外部订单号">{{ detailDrawer.order.order_number || detailDrawer.order.order_id || '-' }}</el-descriptions-item>
              <el-descriptions-item label="状态">
                <el-tag size="small" :type="statusTagType(detailDrawer.order.status)">{{ statusText(detailDrawer.order.status) }}</el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="下单时间">{{ toBeijingTime(detailDrawer.order.in_process_at) }}</el-descriptions-item>
              <el-descriptions-item label="发货截止">{{ toBeijingTime(detailDrawer.order.shipment_date) }}</el-descriptions-item>
              <el-descriptions-item label="订单总额">¥ {{ Number(detailDrawer.order.total_cny || 0).toFixed(2) }} <span style="color:#999">(₽ {{ Number(detailDrawer.order.total_rub || 0).toFixed(2) }})</span></el-descriptions-item>
              <el-descriptions-item label="配送方式">{{ detailDrawer.order.tpl_integration_type || '-' }}</el-descriptions-item>
              <el-descriptions-item label="物流方向">
                {{ detailDrawer.order.financial_data?.cluster_from || '-' }} → {{ detailDrawer.order.financial_data?.cluster_to || '-' }}
              </el-descriptions-item>
              <!-- v2.2.9.143 应收费用结算（来自导入的 Ozon 结算 xlsx），只要这两个合计 -->
              <el-descriptions-item label="合计费用">
                <span style="font-weight:700; color:#b45309">
                  {{ detailDrawer.order.fees ? '₽ ' + Number(detailDrawer.order.fees.total_fee || 0).toFixed(2) : '-' }}
                </span>
                <span v-if="!detailDrawer.order.fees" style="margin-left:8px; font-size:12px; color:#94a3b8">未导入费用结算</span>
              </el-descriptions-item>
              <el-descriptions-item label="合计费用（人民币）">
                <span style="font-weight:700; color:#b45309">
                  {{ detailDrawer.order.fees ? '¥ ' + Number(detailDrawer.order.fees.total_fee_cny || 0).toFixed(2) : '-' }}
                </span>
                <span v-if="detailDrawer.order.fees && detailDrawer.order.fees.settle_period" style="margin-left:8px; font-size:12px; color:#94a3b8">结算期 {{ detailDrawer.order.fees.settle_period }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="利润(估算)">
                <span :style="{ color: profitColor(detailDrawer.order), fontWeight: 800 }">{{ profitText(detailDrawer.order) }}</span>
                <span v-if="detailDrawer.order.profit?.cost_missing" style="margin-left:8px; font-size:12px; color:#94a3b8">缺 1688 采购价</span>
                <span v-else-if="detailDrawer.order.profit?.commission_pending" style="margin-left:8px; font-size:12px; color:#94a3b8">佣金待 Ozon 结算回填</span>
              </el-descriptions-item>
            </el-descriptions>

            <!-- v2.2.9.143 利润明细（估算）：版式与 Yandex 订单详情一致 -->
            <el-divider content-position="left">利润明细（估算）</el-divider>
            <el-descriptions :column="1" border size="small">
              <el-descriptions-item label="卖家货值">{{ moneyText(detailDrawer.order.profit?.seller_goods_cny) }}</el-descriptions-item>
              <el-descriptions-item label="买家实付">
                {{ moneyText(detailDrawer.order.profit?.buyer_paid_cny) }}
                <span style="margin-left:8px; font-size:12px; color:#94a3b8">已按汇率折算，含 Ozon 促销</span>
              </el-descriptions-item>
              <el-descriptions-item label="加价/补贴差">
                <span :style="{ color: (detailDrawer.order.profit?.buyer_diff_cny || 0) >= 0 ? '#b45309' : '#16a34a' }">
                  {{ moneyText(detailDrawer.order.profit?.buyer_diff_cny) }}
                </span>
                <span style="margin-left:8px; font-size:12px; color:#94a3b8">
                  买家实付 − 卖家货值；正数=Ozon 加价（不进我口袋），负数=Ozon 出钱补贴买家
                </span>
              </el-descriptions-item>
              <el-descriptions-item label="收入合计">
                {{ moneyText(detailDrawer.order.profit?.revenue_cny) }}
                <span style="margin-left:8px; font-size:12px; color:#94a3b8">= 卖家货值（不含 Ozon 加价）</span>
              </el-descriptions-item>
              <!-- v2.2.9.147 回款金额：结算后是 Ozon 真实 payout；结算前按「卖家货值 − 平台佣金」估算 -->
              <el-descriptions-item label="回款金额">
                <b style="color:#0f766e">{{ moneyText(detailDrawer.order.payout?.payout_cny) }}</b>
                <span v-if="detailDrawer.order.payout?.estimated" style="margin-left:8px; font-size:12px; color:#b45309">
                  估算（Ozon 还没结算，按 卖家货值 − 平台佣金 计算）
                </span>
                <span v-else style="margin-left:8px; font-size:12px; color:#16a34a">Ozon 结算实值</span>
              </el-descriptions-item>
              <el-descriptions-item label="1688 采购成本">
                <span v-if="detailDrawer.order.profit?.purchase_cny === null" style="color:#b45309">待核算（缺成本）</span>
                <span v-else>{{ moneyText(detailDrawer.order.profit?.purchase_cny) }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="平台佣金">
                <span v-if="detailDrawer.order.profit?.commission_cny === null" style="color:#94a3b8">待 Ozon 结算后回填</span>
                <span v-else>{{ moneyText(detailDrawer.order.profit?.commission_cny) }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="CEL 头程">
                <span style="color:#94a3b8">—（Ozon 订单接口不返回，需财务配置）</span>
              </el-descriptions-item>
              <el-descriptions-item label="国内运费+代贴单">{{ moneyText(detailDrawer.order.profit?.fixed_cny) }}</el-descriptions-item>
              <el-descriptions-item label="利润">
                <span :style="{ color: profitColor(detailDrawer.order), fontWeight: 800 }">{{ profitText(detailDrawer.order) }}</span>
              </el-descriptions-item>
            </el-descriptions>

            <el-divider content-position="left">商品清单 ({{ (detailDrawer.order.products || []).length }})</el-divider>
            <el-table :data="detailDrawer.order.products || []" size="small" border stripe>
              <el-table-column label="图" width="60">
                <template #default="{ row }">
                  <el-image :src="row.image" style="width:40px; height:40px; border-radius:4px" fit="cover" preview-teleported hide-on-click-modal :preview-src-list="row.image ? [row.image] : []" />
                </template>
              </el-table-column>
              <el-table-column label="商品" min-width="220">
                <template #default="{ row }">
                  <div style="font-size:12px">{{ row.local_name || row.name }}</div>
                  <div style="font-size:11px; color:#999">
                    货号 <code>{{ row.offer_id }}</code> · SKU {{ row.sku }}
                  </div>
                  <a v-if="row.source_url_1688" :href="row.source_url_1688" target="_blank" rel="noopener noreferrer" style="font-size:11px">1688 采购 · ¥{{ Number(row.purchase_price_cny || 0).toFixed(2) }}</a>
                </template>
              </el-table-column>
              <el-table-column label="数量" prop="quantity" width="70" align="center" />
              <el-table-column label="单价(¥)" width="100" align="right">
                <template #default="{ row }">
                  ¥ {{ Number(row.price_cny || 0).toFixed(2) }}
                </template>
              </el-table-column>
              <el-table-column label="小计(¥)" width="110" align="right">
                <template #default="{ row }">
                  <b>¥ {{ (Number(row.price_cny || 0) * Number(row.quantity || 1)).toFixed(2) }}</b>
                </template>
              </el-table-column>
            </el-table>

            <template v-if="detailDrawer.order.customer">
              <el-divider content-position="left">收货信息</el-divider>
              <el-descriptions :column="1" border size="small">
                <el-descriptions-item label="收货人">{{ detailDrawer.order.customer?.name || '-' }}</el-descriptions-item>
                <el-descriptions-item label="联系电话">{{ detailDrawer.order.customer?.phone || '-' }}</el-descriptions-item>
                <el-descriptions-item label="收货地址">
                  {{ detailDrawer.order.customer?.address?.region }}
                  {{ detailDrawer.order.customer?.address?.city }}
                  {{ detailDrawer.order.customer?.address?.address_tail }}
                </el-descriptions-item>
              </el-descriptions>
            </template>
          </template>
        </div>
        <template #footer>
          <el-button @click="detailDrawer.visible = false">关闭</el-button>
        </template>
      </el-drawer>

      <!-- v0.3.3 发货对话框 -->
      <el-dialog v-model="shipDialog.visible" title="Ozon 一键发货" width="520px" destroy-on-close>
        <div style="font-size:13px; margin-bottom:10px">
          货件号: <b>{{ shipDialog.posting_number }}</b>
        </div>
        <el-alert type="warning" :closable="false" show-icon style="margin-bottom:10px" title="发货提交后不可逆" description="请确认已经备货并可交给 Ozon，提交成功后订单状态会进入发货流程。" />
        <el-table :data="shipDialog.products" size="small" border>
          <el-table-column label="商品" prop="name" show-overflow-tooltip />
          <el-table-column label="货号" prop="offer_id" width="140" />
          <el-table-column label="发货数量" width="120">
            <template #default="{ row }">
              <el-input-number v-model="row.quantity" :min="1" size="small" style="width:100px" />
            </template>
          </el-table-column>
        </el-table>
        <template #footer>
          <el-button @click="shipDialog.visible = false">取消</el-button>
          <el-button type="warning" :loading="shipDialog.loading" @click="confirmShip">
            确认发货至 Ozon
          </el-button>
        </template>
      </el-dialog>
    </div>
  `
};
