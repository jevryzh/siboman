window.OrderListView = {
  setup() {
    const orders = Vue.ref([]);
    const loading = Vue.ref(false);
    const summaryRows = Vue.ref([]);
    // v2.2.9.162 各状态真实条数（服务端 group by 统计）。
    //   之前 tab 上的数字是把订单列表翻到最多 10 页 × 200 = 2000 条再本地数出来的，
    //   而库里实际有 6700+ 条 → 数字全是残缺的（用户看到「待发运 771」，卖家后台 667）。
    const serverStatusCounts = Vue.ref({});
    const summaryLoading = Vue.ref(false);
    const kpiRows = Vue.ref([]);
    const previousKpiRows = Vue.ref([]);
    const kpiLoading = Vue.ref(false);
    const hasFetched = Vue.ref(false);
    // Ozon v3/posting/fbs/list 严格要求小写 status alias
    const activeTab = Vue.ref('all');
    const pagination = Vue.reactive({ currentPage: 1, pageSize: 20, total: 0 });
    const selectedOrders = Vue.ref([]);
    // v2.2.9.169 批量单号筛选：粘贴一批货件号，只查这些单
    const postingFilter = Vue.ref([]);
    const postingDialog = Vue.reactive({ visible: false, text: '' });
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
      purchase_tracking_no: '',
      row: null,
    });
    const lastBatchResult = Vue.ref(null);
    const shops = Vue.ref([]);
    const ALL_STORES = '__all__';
    const CURRENT_STORE = '__current__';
    // 2026-11-10 店铺改由顶栏全局控制（含「全部店铺」聚合）；这里只跟随，不再自己提供选择器。
    //   顶栏选「全部店铺」时 ShopSwitcher 会写 localStorage.ordersAllStores=1。
    const ordersAllStores = () => localStorage.getItem('ordersAllStores') === '1';
    const storeScope = Vue.ref([ordersAllStores() ? ALL_STORES : CURRENT_STORE]);
    let previousStoreScope = storeScope.value.slice();
    // 2026-11-10 查询条件重构：订单号 / 货品 / 下单日期 / 结算日期 / 缺采购 / 未结算（状态仍用上方页签）
    const orderNoKeyword = Vue.ref('');
    const productKeyword = Vue.ref('');
    const settledRange = Vue.ref([]);
    const onlyMissingPurchase = Vue.ref(false);
    const onlyUnsettled = Vue.ref(false);
    const kpiAnchorAt = Vue.ref(null);
    // 2026-11-10 同步改成「后台定时 + 页面立即同步」：页面上不再有抓取时间窗 / 自动同步开关
    const syncBusy = Vue.ref(false);
    const lastSync = Vue.reactive({ at: '', inserted: 0, changed: 0, pool: 0, suspect: 0 });
    const ORDER_SUMMARY_PAGE_SIZE = 200;
    const ORDER_SUMMARY_MAX_PAGES_PER_STORE = 1;   // v2.2.9.163 计数已交给服务端统计，这里只留一页给超时/兜底逻辑

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

    // v2.2.9.200 修「报错一闪而过」：原来 notify 只接一个参数，把 duration 丢掉了，
    //   所有 notify.error(msg, 12000) 实际都用默认 3 秒 → 用户根本看不清。
    //   现在透传 duration，并且错误默认 15 秒 + 可手动关闭；传 0 表示常驻不自动关。
    const notify = {
      success: (m, d) => (window.ElementPlus?.ElMessage || console).success?.({ message: String(m), duration: d == null ? 3000 : d, showClose: true }),
      warning: (m, d) => (window.ElementPlus?.ElMessage || console).warning?.({ message: String(m), duration: d == null ? 6000 : d, showClose: true }),
      error: (m, d) => (window.ElementPlus?.ElMessage || console).error?.({ message: String(m), duration: d == null ? 15000 : d, showClose: true }),
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
    // 2026-11-10 抓取窗口已在标题栏可见，这里只说明「列表正在看哪段时间」
    const syncRangeText = Vue.computed(() => {
      const [sinceD, toD] = dateRange.value || [];
      if (!sinceD || !toD) return '列表时间：全部（缓存 84 天）';
      return `列表时间：${sinceD} ~ ${toD}`;
    });
    const dateRangeBounds = () => {
      const [sinceD, toD] = dateRange.value || [];
      return {
        since: sinceD ? new Date(`${sinceD}T00:00:00+08:00`).toISOString() : undefined,
        to: toD ? new Date(`${toD}T23:59:59+08:00`).toISOString() : undefined,
      };
    };
    // 结算日期范围（DATE 列，直接按 YYYY-MM-DD 比较）
    const settledRangeBounds = () => {
      const [sinceD, toD] = settledRange.value || [];
      return { settled_since: sinceD || undefined, settled_to: toD || undefined };
    };
    // 2026-11-10 组合查询：所有条件同时生效（后端 AND 拼接，状态由上方页签给 status）
    const advancedFilterParams = () => ({
      order_no: orderNoKeyword.value.trim() || undefined,
      product_q: productKeyword.value.trim() || undefined,
      ...settledRangeBounds(),
      ...(onlyMissingPurchase.value ? { missing_purchase: true } : {}),
      ...(onlyUnsettled.value ? { unsettled: true } : {}),
    });
    const hasAdvancedFilters = () => Boolean(
      orderNoKeyword.value.trim() || productKeyword.value.trim()
      || settledRange.value?.length || onlyMissingPurchase.value || onlyUnsettled.value
      || dateRange.value?.length,
    );
    const roundMoney = (value) => Math.round(Number(value || 0) * 100) / 100;
    const moneyText = (value) => `¥${Number(value || 0).toFixed(2)}`;
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
    const copyText = async (text) => {
      const value = String(text || '').trim();
      if (!value) return;
      try {
        await navigator.clipboard?.writeText(value);
        notify.success('已复制');
      } catch {
        notify.warning('复制失败，请手动复制');
      }
    };
    // 2026-11-10 「下单日期」独立成列：日期与时间分两行
    const orderDateText = (row) => (toBeijingTime(row.in_process_at || row.created_at) || '').slice(0, 10) || '-';
    const orderTimeText = (row) => (toBeijingTime(row.in_process_at || row.created_at) || '').slice(11, 16);
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
      // 2026-11-10 查询条件（订单号/货品/下单日期/结算日期/缺采购/未结算）全部由服务端过滤，
      //   前端只保留「已超时」这种需要按当前时间算的页签过滤。
      const filtered = orders.value
        .filter((row) => activeTab.value === 'overdue' ? isOverdue(row) : true);
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
      const sc = serverStatusCounts.value || {};
      const operationalRows = summaryRows.value.length ? summaryRows.value : orders.value;
      const pending = (typeof sc.awaiting_packaging === 'number' && typeof sc.awaiting_deliver === 'number')
        ? sc.awaiting_packaging + sc.awaiting_deliver
        : operationalRows.filter((row) => ['awaiting_packaging', 'awaiting_deliver'].includes(row.status)).length;
      return {
        gmv: current.gmv,
        profit: current.profit,
        profitRate: current.profitRate,
        gmvTrend: metricDelta(current.gmv, previous.gmv),
        profitTrend: metricDelta(current.profit, previous.profit),
        profitRateTrend: Math.round((current.profitRate - previous.profitRate) * 10) / 10,
        pending,
        awaitingPackaging: typeof sc.awaiting_packaging === 'number' ? sc.awaiting_packaging : operationalRows.filter((row) => row.status === 'awaiting_packaging').length,
        awaitingDeliver: typeof sc.awaiting_deliver === 'number' ? sc.awaiting_deliver : operationalRows.filter((row) => row.status === 'awaiting_deliver').length,
      };
    });
    const statusCount = (value) => {
      // 服务端计数优先（准确）；「已超时」需要按时间判断，仍在前端算
      const sc = serverStatusCounts.value || {};
      // v2.2.9.163 all / 各状态 / overdue 全部走服务端，前端不再需要翻全量列表
      if (typeof sc[value] === 'number') return sc[value];
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
    // 2026-11-10 查询/重置：所有条件（含状态页签）组合生效，条件变化一律回到第 1 页
    const runQuery = () => {
      pagination.currentPage = 1;
      refreshOrderDashboard();
    };
    const resetQueryConditions = () => {
      orderNoKeyword.value = '';
      productKeyword.value = '';
      settledRange.value = [];
      onlyMissingPurchase.value = false;
      onlyUnsettled.value = false;
      dateRange.value = [];
      postingFilter.value = [];
      activeTab.value = 'all';
      pagination.currentPage = 1;
      refreshOrderDashboard();
    };

    const fetchOrders = async () => {
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
          ...advancedFilterParams(),
          // 2026-11-10 列表接口只读缓存，不再传 sync_mode（同步由定时任务 / 「立即同步」负责）
          ...(postingFilter.value.length ? { posting_numbers: postingFilter.value } : {}),
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
        // v2.2.9.193 批量单号筛选：提示查不到的单号
        const missingPns = rows.__missingPostings || [];
        if (postingFilter.value.length && missingPns.length) {
          try {
            window.ElementPlus.ElMessage.warning({
              message: `有 ${missingPns.length} 个单号在本店铺查不到：${missingPns.slice(0, 5).join('、')}${missingPns.length > 5 ? ' 等' : ''}`,
              duration: 15000,
              showClose: true,
            });
          } catch (_e) { /* 忽略 */ }
        }
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
        const counts = {};
        const results = await Promise.allSettled(storeIds.map(async (sid) => {
          const rows = [];
          for (let page = 0; page < ORDER_SUMMARY_MAX_PAGES_PER_STORE; page++) {
            const res = await axios.post('/api/seller/orders', {
              store_id: sid,
              status: 'all',
              since,
              to,
              ...advancedFilterParams(),
              sync_mode: 'cache',
              limit: ORDER_SUMMARY_PAGE_SIZE,
              offset: page * ORDER_SUMMARY_PAGE_SIZE,
            });
            if (res.data.status_counts) {
              for (const [k, v] of Object.entries(res.data.status_counts)) {
                counts[k] = (counts[k] || 0) + Number(v || 0);
              }
            }
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
        serverStatusCounts.value = counts;
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
            ...(postingFilter.value.length ? { posting_numbers: postingFilter.value } : {}),
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

    // 2026-11-10 顶部「本周 GMV / 利润 / 利润率 / 待处理」四张卡片已按需求移除，
    //   fetchOrderKpis（每店再拉 200 单算 GMV）不再参与刷新，省掉一次全店订单扫描。
    //   列表接口现在只读缓存，不再顺手抓 Ozon。
    const refreshOrderDashboard = async () => {
      kpiAnchorAt.value = new Date().toISOString();
      await Promise.all([fetchOrders(), fetchOrderSummary()]);
    };

    // ===== 立即同步（手动跑一次：新单 + 待处理 + 取消 + 兜底） =====
    const lastSyncText = Vue.computed(() => {
      if (!lastSync.at) return '尚未同步';
      const parts = [`上次同步 ${toBeijingTime(lastSync.at)}`];
      if (lastSync.inserted) parts.push(`新增 ${lastSync.inserted}`);
      if (lastSync.changed) parts.push(`状态变更 ${lastSync.changed}`);
      return parts.join(' · ');
    });
    const fetchSyncState = async () => {
      const storeId = getStoreId();
      if (!storeId) return;
      try {
        const res = await axios.get('/api/seller/orders/sync/state', { params: { store_id: storeId } });
        const st = res.data?.state || {};
        lastSync.at = st.last_ok_at || st.last_run_at || '';
        lastSync.inserted = Number(st.stats?.inserted || 0);
        lastSync.changed = Number(st.stats?.changed || 0);
        lastSync.pool = Number(res.data?.watch_pool || 0);
        lastSync.suspect = Number(res.data?.watch_suspect || 0);
      } catch { /* 状态读取失败不影响列表 */ }
    };
    const runManualSync = async () => {
      const storeIds = selectedStoreIds();
      if (!storeIds.length) return notify.warning('请先在顶栏选择店铺');
      syncBusy.value = true;
      const sum = { inserted: 0, changed: 0, closing: 0, failed: 0 };
      try {
        // 逐店调用，避免多店一次请求超时
        for (const sid of storeIds) {
          const res = await axios.post('/api/seller/orders/sync', { store_id: sid }, { timeout: 300000 });
          sum.inserted += Number(res.data?.inserted || 0);
          sum.changed += Number(res.data?.changed || 0);
          sum.closing += Number(res.data?.closing_fixed || 0);
          sum.failed += Number(res.data?.failed || 0);
        }
        notify.success(`立即同步完成：新增 ${sum.inserted} · 状态变更 ${sum.changed}${sum.closing ? ` · 兜底纠正 ${sum.closing}` : ''}${sum.failed ? ` · ${sum.failed} 店失败` : ''}`);
      } catch (e) {
        notify.error('同步失败：' + (e.response?.data?.error || e.message));
      } finally {
        syncBusy.value = false;
        await fetchSyncState();
        await refreshOrderDashboard();
      }
    };

    // ===== 定时任务看板：后台在跑哪些定时器、抓什么、什么条件、最近几次结果 =====
    const cronDialog = Vue.reactive({ visible: false, loading: false, jobs: [], error: '', serverTime: '', refreshedAt: '' });
    let cronTimer = null;
    const fetchCronJobs = async () => {
      cronDialog.loading = true;
      cronDialog.error = '';
      try {
        const res = await axios.get('/api/system/cron-jobs');
        cronDialog.jobs = res.data?.jobs || [];
        cronDialog.serverTime = res.data?.serverTime || '';
        cronDialog.refreshedAt = new Date().toISOString();
      } catch (e) {
        cronDialog.error = e.response?.data?.error || e.message || '读取失败';
      } finally {
        cronDialog.loading = false;
      }
    };
    const openCronDialog = () => {
      cronDialog.visible = true;
      fetchCronJobs();
      if (cronTimer) clearInterval(cronTimer);
      cronTimer = setInterval(() => { if (cronDialog.visible) fetchCronJobs(); }, 15000);
    };
    Vue.onBeforeUnmount(() => { if (cronTimer) clearInterval(cronTimer); });
    const cronStatusMeta = (status) => ({
      running: { text: '运行中', type: 'warning' },
      succeeded: { text: '成功', type: 'success' },
      partial: { text: '部分失败', type: 'warning' },
      failed: { text: '失败', type: 'danger' },
      skipped: { text: '跳过', type: 'info' },
    }[status] || { text: status || '-', type: 'info' });
    const cronDuration = (run) => {
      if (!run?.started_at) return '';
      const start = new Date(run.started_at).getTime();
      const end = run.finished_at ? new Date(run.finished_at).getTime() : Date.now();
      if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
      const sec = Math.max(0, Math.round((end - start) / 1000));
      if (sec < 60) return `${sec}s`;
      return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`;
    };
    const cronRunLabel = (index) => ['上一次', '上上次'][index] || '更早';
    const cronIsRunning = (job) => (job?.runs || []).some((run) => run.status === 'running');

    // ===== 导入采购：模板生成 / 导入 / 导入历史（2026-11-10）=====
    //   采购金额 + 贴单费 → app_statistics_costs（与月结统计同表同口径）
    //   采购物流号        → app_order_costs.purchase_tracking_no
    const COST_HEAD = ['订单号', '下单日期', '货品', '数量', '采购价格', '贴单费', '采购物流单号'];
    const costFileInput = Vue.ref(null);
    const costImporting = Vue.ref(false);
    const costTemplateBusy = Vue.ref(false);
    const costHistory = Vue.reactive({ visible: false, loading: false, rows: [], error: '' });

    // 把「当前查询条件」命中的订单全部拉回来（不受分页限制），供模板生成使用
    const fetchAllFilteredForCost = async () => {
      const storeIds = selectedStoreIds();
      if (!storeIds.length) throw new Error('请先在顶栏选择店铺');
      const { since, to } = dateRangeBounds();
      const merged = new Map();
      for (const sid of storeIds) {
        for (let page = 0; page < 20; page += 1) {
          const res = await axios.post('/api/seller/orders', {
            store_id: sid,
            status: apiStatusForActiveTab(),
            since, to,
            sync_mode: 'cache',
            limit: 500,
            offset: page * 500,
            ...advancedFilterParams(),
            ...(postingFilter.value.length ? { posting_numbers: postingFilter.value } : {}),
          });
          const batch = res.data.orders || [];
          for (const row of batch) {
            merged.set(row.posting_number, { ...row, store_id: sid, store_name: storeNameById(sid) });
          }
          if (!res.data.has_next || batch.length < 500) break;
          if (merged.size >= 8000) break;
        }
        if (merged.size >= 8000) break;
      }
      return [...merged.values()];
    };

    const generateCostTemplate = async () => {
      if (!window.XLSX) return notify.error('Excel 组件还没加载完，请稍后再试');
      costTemplateBusy.value = true;
      try {
        const rows = await fetchAllFilteredForCost();
        if (!rows.length) return notify.warning('当前查询条件下没有订单，先调整筛选再生成模板');
        const sorted = rows.slice().sort((a, b) => String(a.in_process_at || '').localeCompare(String(b.in_process_at || '')));
        const body = sorted.map((row) => {
          const product = primaryProduct(row);
          return [
            row.posting_number,
            orderDateText(row),
            product.name || '',
            Number(row.product_count || product.quantity || 1),
            row.purchase_cny == null ? '' : Number(row.purchase_cny),
            row.label_cny == null ? '' : Number(row.label_cny),
            row.purchase_tracking_no || '',
          ];
        });
        const sheet = XLSX.utils.aoa_to_sheet([COST_HEAD, ...body]);
        sheet['!cols'] = [{ wch: 20 }, { wch: 12 }, { wch: 42 }, { wch: 6 }, { wch: 11 }, { wch: 11 }, { wch: 20 }];
        sheet['!freeze'] = { xSplit: '0', ySplit: '1' };
        const help = XLSX.utils.aoa_to_sheet([
          ['采购录入说明'],
          [''],
          ['1. 模板按「订单页当前的查询条件」生成，包含当前筛选命中的全部订单（最多 8000 单）。'],
          ['2. 只需要填「采购价格」「贴单费」「采购物流单号」三列，其余列仅供核对，填了也不会导入。'],
          ['3. 以「订单号」为准；留空的单元格表示不修改原值（不会清零）。'],
          ['4. 采购价格单位人民币，最多两位小数；贴单费按单收取。'],
          ['5. 采购物流单号非必填，填了就会写到该订单的采购物流号上。'],
          ['6. 填好后回到订单页 → 导入采购 → 导入 Excel，按订单号批量写入。'],
          ['7. 单次最多 20000 行；支持 .xlsx / .xls / .csv。'],
        ]);
        help['!cols'] = [{ wch: 92 }];
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, sheet, '采购录入');
        XLSX.utils.book_append_sheet(book, help, '填写说明');
        const stamp = new Date().toISOString().slice(0, 10);
        XLSX.writeFile(book, `采购录入模板_${currentStoreName.value}_${stamp}.xlsx`);
        notify.success(`模板已生成：${rows.length} 单`);
      } catch (e) {
        notify.error('生成模板失败：' + (e.response?.data?.error || e.message));
      } finally {
        costTemplateBusy.value = false;
      }
    };

    const costAmount = (value, label, rowNo) => {
      if (value === null || value === undefined || String(value).trim() === '') return null;
      const text = String(value).trim().replace(/[,，¥￥\s]/g, '');
      if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(`第 ${rowNo} 行${label}无效：${String(value).trim().slice(0, 20)}`);
      return Number(text);
    };

    const onCostFile = async (event) => {
      const file = event?.target?.files?.[0];
      if (event?.target) event.target.value = '';
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) return notify.error('文件不能超过 10MB');
      if (!window.XLSX) return notify.error('Excel 组件还没加载完，请稍后再试');
      costImporting.value = true;
      try {
        const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
        let matrix = null, headerIndex = -1, sheetName = '';
        for (const name of workbook.SheetNames) {
          const m = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: null });
          const hit = m.findIndex((r) => r.some((c) => String(c ?? '').trim() === '订单号'));
          if (hit >= 0) { matrix = m; headerIndex = hit; sheetName = name; break; }
        }
        if (!matrix) throw new Error('没找到含「订单号」表头的工作表，请用「生成采购模板」生成的文件');
        const header = matrix[headerIndex].map((c) => String(c ?? '').trim());
        const idIndex = header.indexOf('订单号');
        const purchaseIndex = header.findIndex((c) => c.startsWith('采购') && !c.includes('物流'));
        const labelIndex = header.findIndex((c) => c.startsWith('贴单'));
        const trackingIndex = header.findIndex((c) => c.includes('物流'));
        if (purchaseIndex < 0 && labelIndex < 0 && trackingIndex < 0) {
          throw new Error('至少要有一列：采购价格 / 贴单费 / 采购物流单号');
        }
        const rows = [];
        const seen = new Set();
        for (const [i, row] of matrix.slice(headerIndex + 1).entries()) {
          const rowNo = headerIndex + i + 2;
          const purchase = purchaseIndex < 0 ? null : costAmount(row[purchaseIndex], '采购价格', rowNo);
          const label = labelIndex < 0 ? null : costAmount(row[labelIndex], '贴单费', rowNo);
          const tracking = trackingIndex < 0 ? '' : String(row[trackingIndex] ?? '').trim();
          if (purchase === null && label === null && !tracking) continue;
          const postingNumber = String(row[idIndex] ?? '').trim();
          if (!postingNumber) throw new Error(`第 ${rowNo} 行订单号为空`);
          if (seen.has(postingNumber)) throw new Error(`订单号重复：${postingNumber}`);
          seen.add(postingNumber);
          rows.push({ posting_number: postingNumber, purchase_cny: purchase, label_cny: label, purchase_tracking_no: tracking });
        }
        if (!rows.length) throw new Error('没有读到可导入的数据（三列都是空的）');
        if (rows.length > 20000) throw new Error(`一次最多导入 20000 单，本次 ${rows.length} 单`);
        const purchaseCount = rows.filter((r) => r.purchase_cny != null).length;
        const labelCount = rows.filter((r) => r.label_cny != null).length;
        const trackingCount = rows.filter((r) => r.purchase_tracking_no).length;
        await window.ElementPlus.ElMessageBox.confirm(
          `将从「${sheetName}」导入 ${rows.length} 单：采购金额 ${purchaseCount} 单、贴单费 ${labelCount} 单、采购物流号 ${trackingCount} 单。留空的字段不会覆盖原值。`,
          '确认导入采购数据',
          { type: 'warning', confirmButtonText: '确认导入', cancelButtonText: '取消' },
        );
        const fileBase64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || '').split(',').pop() || '');
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const res = await axios.post('/api/seller/orders/costs/import', {
          filename: file.name,
          file_base64: fileBase64,
          rows,
        }, { timeout: 180000 });
        const d = res.data || {};
        notify.success(`导入完成：成功 ${d.applied || 0} 单${d.tracking_only ? `（其中 ${d.tracking_only} 单只写了物流号）` : ''}${d.failed ? `，失败 ${d.failed} 单` : ''}`);
        if (d.errors && d.errors.length) notify.warning('部分行未导入：' + d.errors.slice(0, 3).join('；'), 12000);
        await refreshOrderDashboard('cache');
      } catch (e) {
        if (e === 'cancel' || e?.message === 'cancel') return;
        notify.error('导入采购失败：' + (e.response?.data?.error || e.message));
      } finally {
        costImporting.value = false;
      }
    };

    const fetchCostImports = async () => {
      costHistory.loading = true;
      costHistory.error = '';
      try {
        const res = await axios.get('/api/seller/orders/costs/imports', { params: { limit: 50 } });
        costHistory.rows = res.data?.imports || [];
      } catch (e) {
        costHistory.error = e.response?.data?.error || e.message;
      } finally {
        costHistory.loading = false;
      }
    };
    const openCostImports = () => { costHistory.visible = true; fetchCostImports(); };
    const downloadCostImport = async (row) => {
      try {
        const res = await axios.get(`/api/seller/orders/costs/imports/${row.id}/file`, { responseType: 'blob' });
        downloadBlob(res.data, row.file_name || '采购导入源文件.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      } catch (e) {
        notify.error('下载源文件失败：' + (e.response?.data?.error || e.message));
      }
    };
    const handleCostCommand = (command) => {
      if (command === 'template') generateCostTemplate();
      else if (command === 'import') { if (costFileInput.value) costFileInput.value.click(); }
      else if (command === 'history') openCostImports();
    };

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
    // v2.2.9.171 定制导出：毛线拣货单（xlsx）/ 毛线标签（PDF），都基于「待发运」的毛线订单
    const yarnPicklistBusy = Vue.ref(false);
    const yarnLabelsBusy = Vue.ref(false);
    // v2.2.9.200 导出/打印进度条：所有导出共用一条常驻进度，替代一闪而过的 toast
    const exportProgress = Vue.reactive({ visible: false, label: '', percent: 0, detail: '' });
    const exportStart = (label) => { exportProgress.visible = true; exportProgress.label = label; exportProgress.percent = 0; exportProgress.detail = ''; };
    const exportStep = (percent, detail) => { exportProgress.percent = Math.max(0, Math.min(100, Math.round(percent))); if (detail != null) exportProgress.detail = String(detail); };
    const exportFinish = () => { exportProgress.percent = 100; setTimeout(() => { exportProgress.visible = false; exportProgress.percent = 0; exportProgress.detail = ''; }, 1500); };
    const exportFail = (label) => { exportProgress.visible = false; exportProgress.percent = 0; exportProgress.detail = ''; };
    const downloadBlob = (data, filename, mime) => {
      const blob = new Blob([data], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    };
    const exportYarnPicklist = async () => {
      const storeIds = selectedStoreIds();
      if (!storeIds.length) return notify.warning('请先选择店铺');
      yarnPicklistBusy.value = true;
      exportStart(`导出毛线拣货单（${(selectedOrders.value || []).length} 单）`);
      try {
        const picked = [...new Set((selectedOrders.value || []).map((r) => String(r.posting_number || '')).filter(Boolean))];
        if (!picked.length) { yarnPicklistBusy.value = false; exportFail(); return notify.warning('请先勾选要导出的订单'); }
        exportStep(20, `已选中 ${picked.length} 单，正在请求服务端…`);
        const res = await axios.post('/api/seller/orders/yarn-picklist-export', { store_ids: storeIds, posting_numbers: picked }, { responseType: 'blob', timeout: 120000 });
        exportStep(80, '正在生成 xlsx…');
        downloadBlob(res.data, `毛线拣货单_${new Date().toISOString().slice(0, 10)}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        exportStep(100, `${res.headers['x-item-count'] || '?'} 条 / ${res.headers['x-page-count'] || '?'} 页`);
        exportFinish();
        notify.success(`已导出毛线拣货单：${res.headers['x-item-count'] || '?'} 条 / ${res.headers['x-page-count'] || '?'} 页`);
      } catch (e) {
        exportFail();
        let msg = e.message;
        try { if (e.response?.data instanceof Blob) msg = JSON.parse(await e.response.data.text())?.error || msg; } catch (_e2) {}
        notify.error('导出毛线拣货单失败：' + String(msg).slice(0, 240), 0);
      } finally { yarnPicklistBusy.value = false; }
    };
    const exportYarnLabels = async () => {
      const storeIds = selectedStoreIds();
      if (!storeIds.length) return notify.warning('请先选择店铺');
      const picked = [...new Set((selectedOrders.value || []).map((r) => String(r.posting_number || '')).filter(Boolean))];
      if (!picked.length) return notify.warning('请先勾选要导出的订单');
      // v2.2.9.182 面单改走插件（卖家后台网页接口），不受 Seller API 配额限制
      const send = window.__zhumeng_send__;
      if (typeof send !== 'function') return notify.warning('检测不到采集插件，请确认浏览器已安装并启用');
      yarnLabelsBusy.value = true;
      try {
        // v2.2.9.199 毛线标签流程依赖插件 2.2.9.189+（逐单生成 + 卖家后台网页接口）。
        //   旧版插件（如 2.2.9.182）在 create 步骤直接失败，只报「失败步骤：create」，
        //   用户根本不知道要去升级插件 → 先 ping 拿插件版本，太旧就直接给明确提示。
        try {
          const ping = await send('ping.request', {}, 8000);
          // ⚠️ background_version 才是真正的插件版本（background.js 的 VERSION）；
          //   content-bridge-iso.js 里那个 version 是写死的旧常量（2.2.9.157，从没跟着升），
          //   之前误用它把 2.2.9.189 的新插件判成旧版 → 冤枉用户。
          const ver = String(ping?.background_version || ping?.version || '');
          const cmpVer = (a, b) => {
            const pa = String(a || '').split('.').map((x) => Number(x) || 0);
            const pb = String(b || '').split('.').map((x) => Number(x) || 0);
            for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
              if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
            }
            return 0;
          };
          if (ver && cmpVer(ver, '2.2.9.213') < 0) {
            yarnLabelsBusy.value = false;
            return notify.error(`毛线标签导出需要插件 2.2.9.213 或更高版本，你当前是 ${ver}。请点右上角「插件下载」重新下载并覆盖安装最新插件后再试。`, 18000);
          }
        } catch (_e) { /* ping 失败就继续走，让真实错误暴露出来 */ }
        exportStart(`导出毛线标签（${picked.length} 单）`);
        // v2.2.9.188 先按拣货单规则拿到排序后的单号，让标签页顺序与拣货单一一对应
        let ordered = picked;
        try {
          exportStep(5, '正在按拣货单规则排序…');
          const sorted = await axios.post('/api/seller/orders/yarn-sorted-postings', { posting_numbers: picked, store_ids: storeIds }, { timeout: 30000 });
          if (Array.isArray(sorted.data?.posting_numbers) && sorted.data.posting_numbers.length) ordered = sorted.data.posting_numbers;
        } catch (_e) { /* 排序失败就用原顺序 */ }
        // Codex: 每次只交给插件一单；标签任务慢时不让多单共用一个消息通道。
        const CHUNK = 1;
        const isClosedChannel = (res) => {
          const error = String(res?.error || '');
          return !res || /message channel closed|message port closed|before a response was received|receiving end does not exist/i.test(error);
        };
        const items = [];
        const failedAll = [];
        const batches = [];
        for (let i = 0; i < ordered.length; i += CHUNK) batches.push(ordered.slice(i, i + CHUNK));
        for (let bi = 0; bi < batches.length; bi += 1) {
          // Codex: pace one task at a time; stop the batch on seller rate limits.
          if (bi) await new Promise((resolve) => setTimeout(resolve, 1200));
          exportStep(10 + (bi / batches.length) * 80, `正在生成标签 ${bi + 1}/${batches.length} 批（已拿到 ${items.length} 个）`);
          let res;
          try {
            res = await send('printLabels.request', { storeId: storeIds[0], postingNumbers: batches[bi] }, 60000);
          } catch (e) {
            res = { error: String(e?.message || e) };
          }
          if (!res || res.ok !== true) {
            if (isClosedChannel(res)) {
              batches[bi].forEach((pn) => failedAll.push({ pn, err: '插件通信中断' }));
              notify.warning('插件通信中断，已停止后续请求；已生成的标签将继续下载。请检查插件是否已更新并保持卖家后台打开。', 12000);
              break;
            }
            let msg = res?.error || (res?.step ? `失败步骤：${res.step}` : '') + ' ' + String(res?.createText || res?.lastText || res?.tabUrl || '').slice(0, 160);
            if (res?.step === 'create') msg += ' —— 标签创建接口拒绝；若插件版本低于 2.2.9.189，请先升级插件再试';
            batches[bi].forEach((pn) => failedAll.push({ pn, err: String(msg).slice(0, 160) }));
            if (!items.length) {
              exportFail();
              return notify.error(`导出毛线标签失败（第 ${bi + 1} 批）：` + String(msg).slice(0, 240), 0);
            }
            notify.warning(`第 ${bi + 1} 批失败，已停止后续请求；已生成的标签将继续下载：${String(msg).slice(0, 160)}`, 12000);
            break;
          }
          (res.items || []).forEach((it) => items.push(it));
          (res.failed || []).forEach((f) => failedAll.push(f));
          if ((res.failed || []).some((f) => /429|rate limit/i.test(String(f.err || '')))) {
            notify.warning('卖家后台标签接口限流，已停止后续请求；已生成的标签将继续下载。请稍后再导出剩余订单。', 12000);
            break;
          }
        }
        if (!items.length) {
          exportFail();
          // Codex 修改：保留插件真实失败原因，超时不能误报成订单已发货/已取消。
          const detail = failedAll.slice(0, 5).map((f) => `${f.pn}${f.err ? `(${f.err})` : ''}`).join('、');
          const limited = /429|rate limit/i.test(detail);
          const timedOut = /timed out|timeout|超时/i.test(detail);
          return notify.error(
            `导出毛线标签失败：插件未取到任何标签${detail ? `（${detail}）` : ''}。`
            + (limited
              ? '卖家后台标签接口触发限流（429），请等 1–2 分钟再试；仍不行就减少勾选数量分批导出。'
              : timedOut
                ? '卖家后台标签接口响应超时，请确认登录状态后再试；若持续超时，请记录订单号和失败步骤。'
                : '请检查上述失败原因及订单在卖家后台的标签状态。'),
            0,
          );
        }
        exportStep(92, `已生成 ${items.length} 个标签，正在按顺序合并 PDF…`);
        // 服务端按「拣货单顺序」下载并合并
        const merged = await axios.post('/api/seller/orders/yarn-label-pdf', { order: ordered, items }, { responseType: 'blob', timeout: 300000 });
        downloadBlob(merged.data, `毛线标签_${new Date().toISOString().slice(0, 10)}.pdf`, 'application/pdf');
        exportStep(100, `${items.length} 个标签${failedAll.length ? `，${failedAll.length} 单失败` : ''}`);
        exportFinish();
        if (failedAll.length) {
          // v2.2.9.201 失败明细必须列出来：之前只报「N 单失败」，用户没法知道是哪几单，
          //   更没法只勾选失败单重试。
          const detail = failedAll.slice(0, 40)
            .map((f) => `${f.pn}${f.err ? `(${f.err})` : ''}`)
            .join('、');
          notify.warning(
            `已导出 ${items.length} 个标签，但有 ${failedAll.length} 单没拿到标签：${detail}${failedAll.length > 40 ? ' …' : ''}。可只勾选这些单再导一次。`,
            0,
          );
        } else {
          notify.success(`已导出 ${items.length} 个订单的毛线标签，顺序与拣货单一致`);
        }
      } catch (e) {
        exportFail();
        notify.error('导出毛线标签失败：' + String(e.message || e).slice(0, 240), 0);
      } finally { yarnLabelsBusy.value = false; }
    };
    const exportYarnLabelsOfficial = async () => {
      const storeIds = selectedStoreIds();
      if (!storeIds.length) return notify.warning('请先选择店铺');
      const picked = [...new Set((selectedOrders.value || []).map((r) => String(r.posting_number || '')).filter(Boolean))];
      if (!picked.length) return notify.warning('请先勾选要导出的订单');
      yarnLabelsBusy.value = true;
      exportStart(`API 导出毛线标签（${picked.length} 单）`);
      try {
        exportStep(2, '正在启动标签任务…');
        // Codex: background job reports progress without holding one HTTP request open past the gateway timeout.
        const res = await axios.post('/api/seller/orders/yarn-labels', {
          store_ids: storeIds, posting_numbers: picked, ordered_single: true, async_job: true,
        }, { timeout: 30000 });
        const jobId = res.data?.job_id;
        if (!jobId) throw new Error('服务端未返回标签任务编号');
        const deadline = Date.now() + 30 * 60 * 1000;
        while (true) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const status = (await axios.get(`/api/seller/orders/yarn-label-jobs/${encodeURIComponent(jobId)}`, { timeout: 15000 })).data;
          const done = Number(status.completed || 0);
          const total = Number(status.total || picked.length);
          exportStep(2 + (done / total) * 90, `已获取 ${done}/${total} 单${status.rate_limited ? `，Ozon 限流重试 ${status.rate_limited} 次` : ''}${done === total && status.status === 'running' ? '，正在合并 PDF…' : ''}`);
          if (status.status === 'done') break;
          if (status.status === 'failed') throw new Error(status.error || '标签任务失败');
          if (Date.now() > deadline) throw new Error(`任务仍在后台运行（编号 ${jobId}），可稍后重新点击同一批订单继续查看进度`);
        }
        exportStep(95, '正在下载 PDF…');
        const pdf = await axios.get(`/api/seller/orders/yarn-label-jobs/${encodeURIComponent(jobId)}/download`, { responseType: 'blob', timeout: 60000 });
        downloadBlob(pdf.data, `毛线标签_${new Date().toISOString().slice(0, 10)}.pdf`, 'application/pdf');
        exportFinish();
        notify.success(`已导出 ${pdf.headers['x-item-count'] || picked.length} 单毛线标签，顺序与拣货单一致`);
      } catch (e) {
        exportFail();
        let msg = e.response?.data?.error || e.message;
        try { if (e.response?.data instanceof Blob) msg = JSON.parse(await e.response.data.text())?.error || msg; } catch (_e2) {}
        notify.error('API 导出毛线标签失败：' + String(msg).slice(0, 240), 0);
      } finally { yarnLabelsBusy.value = false; }
    };
    const openPostingDialog = () => {
      postingDialog.text = postingFilter.value.join('\n');
      postingDialog.visible = true;
    };
    const applyPostingFilter = () => {
      // Accio Work (2026-11-06)：先清掉零宽字符/BOM，再统一去重，
      //   避免 Chrome/Firefox 因粘贴内容里的隐形字符导致条数不一致（199 vs 200）。
      const raw = String(postingDialog.text || '')
        .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
        .split(/[\s,，;；、]+/)
        .map((x) => x.trim())
        .filter(Boolean);
      const seen = new Set();
      const list = [];
      for (const pn of raw) {
        const key = pn.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        list.push(pn);
      }
      const duplicated = raw.length - list.length;
      // Accio Work (2026-11-06)：notify 只有 success/warning/error，没有 info，
      //   之前误用 notify.info 会抛 TypeError，导致「点查询没反应」（弹窗关不上、列表不刷新）。
      if (duplicated > 0) notify.warning(`已自动去掉 ${duplicated} 个重复单号`, 8000);
      postingFilter.value = list.slice(0, 1000);
      postingDialog.visible = false;
      pagination.currentPage = 1;
      fetchOrders();
    };
    const clearPostingFilter = () => {
      postingFilter.value = [];
      postingDialog.text = '';
      pagination.currentPage = 1;
      fetchOrders();
    };
    // v2.2.9.156 打印面单：后端 /api/seller/orders/labels 早就写好了但前端没有入口。
    //   Ozon 只允许「待备货 / 待发运」的单出标签，其它状态接口会报 INVALID_ARGUMENT，
    //   所以这里先本地筛一遍，给出明确提示。
    const labelsPrinting = Vue.ref(false);
    // v2.2.9.165 导出「待备货毛线数量」（定制需求）：按货号汇总待备货订单的商品数量
    const yarnExporting = Vue.ref(false);
    const exportPendingSkus = async () => {
      const storeIds = selectedStoreIds();
      if (!storeIds.length) return notify.warning('请先选择店铺');
      yarnExporting.value = true;
      try {
        const res = await axios.post('/api/seller/orders/pending-sku-export', { store_ids: storeIds }, { responseType: 'blob' });
        const blob = new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `待备货毛线数量_${new Date().toISOString().slice(0, 10)}.xlsx`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        const skuCount = res.headers['x-sku-count'] || '?';
        const totalQty = res.headers['x-total-qty'] || '?';
        notify.success(`已导出：${skuCount} 个货号，合计 ${totalQty} 个`);
      } catch (e) {
        let msg = e.message;
        try {
          if (e.response?.data instanceof Blob) msg = JSON.parse(await e.response.data.text())?.error || msg;
          else if (e.response?.data?.error) msg = e.response.data.error;
        } catch (_e2) { /* 保持原错误 */ }
        notify.error('导出待备货毛线数量失败：' + String(msg).slice(0, 200));
      } finally {
        yarnExporting.value = false;
      }
    };
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
      exportStart(`生成拣货单（${postingNumbers.length} 单）`);
      try {
        // v2.2.9.200 状态别名用所选订单的全部状态（不再只限待备货/待发运），
        //   让用户在「所有」tab 按筛选也能生成拣货单；报告接口会按实际状态返回。
        const statusAliases = [...new Set(sel.map((row) => String(row.status || '')).filter(Boolean))];
        exportStep(25, '插件正在向卖家后台创建拣货报告…');
        const res = await send('pickList.request', { postingNumbers, statusAliases }, 180000);
        if (!res || res.ok !== true) {
          exportFail();
          const detail = res?.step ? `（失败步骤：${res.step}）` : '';
          const msg = res?.error
            || res?.create?.text
            || (res?.log && res.log.length && JSON.stringify(res.log[res.log.length - 1]))
            || '插件无返回（可能是插件版本过旧，请到 chrome://extensions 重新加载）';
          return notify.error('生成拣货单失败' + detail + '：' + String(msg).slice(0, 300), 0);
        }
        exportStep(85, '报告已生成，正在下载 PDF…');
        const bin = atob(res.base64 || '');
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        exportStep(100, `${Math.round((res.size || 0) / 1024)} KB`);
        exportFinish();
        notify.success(`已生成 ${postingNumbers.length} 个订单的拣货单（${Math.round((res.size || 0) / 1024)} KB）`);
      } catch (e) {
        exportFail();
        notify.error('生成拣货单失败：' + String(e.message || e).slice(0, 240), 0);
      } finally {
        pickListBusy.value = false;
      }
    };
    const printLabels = async () => {
      const sel = selectedOrders.value || [];
      if (!sel.length) return notify.warning('请先勾选要打印面单的订单');
      // v2.2.9.200 去掉「只有待备货/待发运才能打印」的前端拦截：在「所有」tab 按筛选勾选，
      //   能不能打由 Ozon 按单判定，打不了的单后端会跳过/报错，不该一刀切拦掉。
      const eligible = sel;
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
      exportStart(`打印面单（${sel.length} 单 / ${byStore.size} 个店铺）`);
      try {
        // v2.2.9.167 后端按 20 个/批调 Ozon，多批会返回 ZIP（单批返回 PDF）
        let lastBlob = null;
        let lastType = 'application/pdf';
        let batches = 1;
        let storeIdx = 0;
        for (const [storeId, postings] of byStore) {
          storeIdx += 1;
          exportStep((storeIdx / byStore.size) * 85, `店铺 ${storeIdx}/${byStore.size}：正在拉取 ${postings.length} 单面单…`);
          const res = await axios.post('/api/seller/orders/labels', { store_id: storeId, posting_numbers: postings }, { responseType: 'blob', timeout: 600000 });
          const type = String(res.headers['content-type'] || '');
          if (res.headers['x-batch-count']) batches = Math.max(batches, Number(res.headers['x-batch-count']) || 1);
          lastType = type.includes('zip') ? 'application/zip' : 'application/pdf';
          lastBlob = lastBlob ? new Blob([lastBlob, res.data], { type: lastType }) : res.data;
        }
        exportStep(92, '正在合并/下载面单文件…');
        const url = URL.createObjectURL(lastBlob);
        if (lastType === 'application/zip') {
          const a = document.createElement('a');
          a.href = url;
          a.download = `ozon-labels-${Date.now()}.zip`;
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
        } else {
          window.open(url, '_blank');
        }
        setTimeout(() => URL.revokeObjectURL(url), 120000);
        exportStep(100, `分 ${batches} 批`);
        exportFinish();
        notify.success(`已生成 ${eligible.length} 个订单的面单（分 ${batches} 批）`);
      } catch (e) {
        exportFail();
        let msg = e.message;
        try {
          if (e.response?.data instanceof Blob) msg = JSON.parse(await e.response.data.text())?.error || msg;
          else if (e.response?.data?.error) msg = e.response.data.error;
        } catch (_e2) { /* 保持原错误 */ }
        notify.error('打印面单失败：' + String(msg).slice(0, 240), 0);
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
    // 2026-11-10 订单页不再做利润计算（利润只在月结统计里算），这里只维护货源链接 / 采购物流号
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
      procurementDialog.purchase_tracking_no = row.purchase_tracking_no || '';
      procurementDialog.row = row;
      procurementDialog.visible = true;
    };
    const saveProcurementSource = async () => {
      // 订单页不再维护出单成本（利润在月结统计里算），这里只把原值原样带回去，不覆盖用户历史数据
      const cost = Number(procurementDialog.outbound_cost_cny || 0);
      if (!Number.isFinite(cost) || cost < 0) return notify.warning('出单总成本异常');
      procurementDialog.saving = true;
      try {
        const res = await axios.post(`/api/seller/orders/${encodeURIComponent(procurementDialog.posting_number)}/source`, {
          store_id: procurementDialog.store_id || getStoreId(),
          offer_id: procurementDialog.offer_id,
          outbound_cost_cny: cost,
          source_url_1688: procurementDialog.source_url_1688,
          purchase_tracking_no: String(procurementDialog.purchase_tracking_no || '').trim(),
        });
        const updatedOrder = res.data.order;
        const updatedProduct = res.data.product;
        const target = orders.value.find((row) => orderRowKey(row) === orderRowKey(procurementDialog.row));
        if (target && updatedOrder) Object.assign(target, updatedOrder, { store_name: target.store_name, store_id: target.store_id });
        else if (target && updatedProduct) {
          const product = (target.products || []).find((item) => String(item.offer_id) === String(updatedProduct.offer_id));
          if (product) Object.assign(product, updatedProduct);
        }
        // 采购物流号不在订单缓存 payload 里，单独回填到行上
        if (target) target.purchase_tracking_no = String(procurementDialog.purchase_tracking_no || '').trim();
        procurementDialog.visible = false;
        notify.success('货源链接、采购物流号已保存');
        fetchOrderSummary();
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
        // v2.2.9.192 导出当前查询结果（走本地缓存，不限条数、与列表一致）
        const res = await axios.post('/api/seller/orders/export', {
          store_id: storeIds[0],
          status: activeTab.value === 'all' ? '' : activeTab.value,
          since,
          to,
          ...advancedFilterParams(),
          posting_numbers: postingFilter.value.length ? postingFilter.value : undefined,
          source: 'cache',
        }, { responseType: 'blob', timeout: 120000 });
        const url = URL.createObjectURL(res.data);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ozon-orders-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) { notify.error('导出失败: ' + (e.response?.data?.error || e.message)); }
    };

    // ===== 2026-11-10 采购批次号 =====
    //   增加：作用于「当前查询条件命中的全部订单」（后端按同一套条件取单号，不受分页限制）
    //   删除：只作用于「已勾选的订单」
    //   规则：命中订单里只要有一单已有批次号，后端整体拒绝 → 必须先删
    const batchDialog = Vue.reactive({ visible: false, value: '', busy: false });
    const batchBusy = Vue.ref(false);
    const queryScopeParams = () => ({
      store_ids: selectedStoreIds(),
      status: apiStatusForActiveTab(),
      ...dateRangeBounds(),
      ...advancedFilterParams(),
      ...(postingFilter.value.length ? { posting_numbers: postingFilter.value } : {}),
    });
    const openBatchDialog = () => {
      if (!selectedStoreIds().length) return notify.warning('请先选择店铺');
      batchDialog.value = '';
      batchDialog.visible = true;
    };
    const submitBatch = async () => {
      const batchNo = String(batchDialog.value || '').trim();
      if (!batchNo) return notify.warning('请先填写批次号');
      if (batchNo.length > 40) return notify.warning('批次号最多 40 个字符');
      try {
        await window.ElementPlus.ElMessageBox.confirm(
          `将给「当前查询条件命中的全部订单」写入批次号「${batchNo}」。已有批次号的订单不会被覆盖——只要命中一单，本次会整体拒绝。`,
          '确认增加批次',
          { type: 'warning', confirmButtonText: '确定录入', cancelButtonText: '取消' },
        );
      } catch { return; }
      batchDialog.busy = true;
      batchBusy.value = true;
      try {
        const res = await axios.post('/api/seller/orders/batches', { ...queryScopeParams(), batch_no: batchNo }, { timeout: 180000 });
        const d = res.data || {};
        batchDialog.visible = false;
        notify.success(`批次号「${d.batch_no}」已写入 ${d.assigned} 单`);
        await refreshOrderDashboard();
      } catch (e) {
        notify.error('增加批次失败：' + (e.response?.data?.error || e.message), 20000);
      } finally {
        batchDialog.busy = false;
        batchBusy.value = false;
      }
    };
    const removeBatch = async () => {
      const rows = selectedOrders.value || [];
      const picked = [...new Set(rows.map((r) => String(r.posting_number || '')).filter(Boolean))];
      if (!picked.length) return notify.warning('请先勾选要删除批次的订单');
      const names = [...new Set(rows.map((r) => String(r.batch_no || '').trim()).filter(Boolean))];
      if (!names.length) return notify.warning('所选订单里没有采购批次号，无需删除');
      try {
        await window.ElementPlus.ElMessageBox.confirm(
          `将删除所选 ${picked.length} 单的采购批次号（${names.slice(0, 3).join('、')}${names.length > 3 ? ' 等' : ''}）。删除后可以重新录入。`,
          '确认删除批次',
          { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' },
        );
      } catch { return; }
      batchBusy.value = true;
      try {
        const storeIds = [...new Set(rows.map((r) => effectiveStoreIdForOrder(r)).filter(Boolean))];
        const res = await axios.post('/api/seller/orders/batches/remove', { store_ids: storeIds, posting_numbers: picked });
        notify.success(`已删除 ${Number(res.data?.removed || 0)} 单的采购批次号`);
        selectedOrders.value = [];
        await refreshOrderDashboard();
      } catch (e) {
        notify.error('删除批次失败：' + (e.response?.data?.error || e.message), 15000);
      } finally { batchBusy.value = false; }
    };
    const handleBatchCommand = (command) => {
      if (command === 'add') openBatchDialog();
      else if (command === 'remove') removeBatch();
    };
    // 2026-11-10 三个导出按钮收进「打印」下拉，功能不变
    const handlePrintCommand = (command) => {
      if (command === 'picklist') exportYarnPicklist();
      else if (command === 'labels') exportYarnLabels();
      else if (command === 'labels-api') exportYarnLabelsOfficial();
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

    // 顶栏店铺切换（含「全部店铺」聚合）→ 同步本页作用域并重拉
    const onShopChanged = (event) => {
      const val = String(event?.detail || '');
      if (val === ALL_STORES) {
        storeScope.value = [ALL_STORES];
      } else if (!storeScopeValues().includes(ALL_STORES)) {
        // 顶栏切了某家店（或从聚合切回单店）：跟随当前店铺，不再锁定旧 id
        storeScope.value = [CURRENT_STORE];
      }
      previousStoreScope = storeScope.value.slice();
      pagination.currentPage = 1;
      orders.value = [];
      summaryRows.value = [];
      kpiRows.value = [];
      previousKpiRows.value = [];
      selectedOrders.value = [];
      pagination.total = 0;
      refreshOrderDashboard();
    };
    // 保留给「全部店铺/多选」的历史逻辑（当前无选择器入口，仍被 applyStoreScope 复用）
    const applyStoreScope = (value = storeScope.value) => {
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
    // 2026-11-10 前端自动同步已移除：同步全部交给后台定时任务，页面上的「立即同步」只做手动补一次
    window.addEventListener('shop-changed', onShopChanged);
    Vue.onBeforeUnmount(() => {
      window.removeEventListener('shop-changed', onShopChanged);
    });

    Vue.onMounted(() => {
      fetchShops().finally(() => { refreshOrderDashboard(); fetchSyncState(); });
    });

    return {
      orders, displayedOrders, loading, summaryLoading, kpiLoading, activeTab, statusTabs, statusTabItems, pagination,
      selectedOrders, notes, batchLoading,
      postingFilter, postingDialog, openPostingDialog, applyPostingFilter, clearPostingFilter,
      yarnPicklistBusy, yarnLabelsBusy, exportYarnPicklist, exportYarnLabels, exportYarnLabelsOfficial, exportProgress, noteDialog, procurementDialog, syncBusy, runManualSync, lastSync, lastSyncText, fetchSyncState,
      lastBatchResult, hasFetched, orderEmptyText, shops, currentStoreName,
      storeScope, storeScopeOptions, isAllStoresScope,
      detailDrawer, shipDialog,
      fetchOrders, fetchOrderSummary, fetchOrderKpis, refreshOrderDashboard,
      onPageChange, onPageSizeChange, toBeijingTime,
      openDetail, openShipDialog, confirmShip, statusTagType, statusText,
      onSelectionChange, orderNote, openNoteDialog, saveNote, exportOrders, batchShip, deadlineInfo,
      openProcurementSource, saveProcurementSource, findSourceForOrder, handleRowAction, cancelOrder,
      selectStatusTab,
      // 2026-11-10 采购批次号
      batchDialog, batchBusy, handleBatchCommand, openBatchDialog, submitBatch, removeBatch,
      handlePrintCommand,
      todayLabel, syncRangeText, summaryStats, moneyText, trendText, trendColor, primaryProduct, rowCreatedTime,
      profitColor, profitText, profitOf,   // v2.2.9.143 详情里的利润明细
      labelsPrinting, printLabels,   // v2.2.9.156 打印面单
      yarnExporting, exportPendingSkus,   // v2.2.9.165 导出待备货毛线数量
      pickListBusy, printPickList,   // v2.2.9.157 生成拣货单
      rowStatusSubtext, copyPostingNumber, copyText, orderDateText, orderTimeText, deadlineBadgeStyle, warehouseText, deliveryText,
      orderProfit, orderProfitRate, hasOrderProfit, orderOutboundCost, orderCommission, orderLastMile, orderOzonCost, orderTotalCost, orderDelivered, deadlineHourText, orderRowKey,
      // v0.3.5 时窗 + 2026-11-10 组合查询条件
      dateRange, rangeShortcuts,
      orderNoKeyword, productKeyword, settledRange, onlyMissingPurchase, onlyUnsettled,
      runQuery, resetQueryConditions, hasAdvancedFilters,
      // 定时任务看板
      cronDialog, openCronDialog, fetchCronJobs, cronStatusMeta, cronDuration, cronRunLabel, cronIsRunning,
      // 导入采购
      costFileInput, costImporting, costTemplateBusy, costHistory, handleCostCommand, onCostFile,
      generateCostTemplate, fetchCostImports, openCostImports, downloadCostImport,
    };
  },
  template: `
    <div class="order-workbench">
            <!-- v2.2.9.169 批量单号筛选 -->
        <el-dialog v-model="postingDialog.visible" title="按单号批量查询" width="560px">
          <div style="font-size:13px; color:#64748b; margin-bottom:8px">
            每行一个货件号，也支持用空格、逗号、分号分隔。最多 1000 个。
          </div>
          <el-input v-model="postingDialog.text" type="textarea" :rows="12" placeholder="例如：&#10;0126320481-0344-2&#10;0118486930-0033-1" />
          <template #footer>
            <el-button @click="postingDialog.visible = false">取消</el-button>
            <el-button @click="clearPostingFilter">清空筛选</el-button>
            <el-button type="primary" @click="applyPostingFilter">查询</el-button>
          </template>
        </el-dialog>
      <div style="min-width:0">
        <!-- 标题区：与「店铺结算 - 应计原始数据」同版式（h2 18px + 一行灰色说明 + 右侧操作） -->
        <header class="statistics-heading">
          <div>
            <h2>订单管理</h2>
            <div class="statistics-meta">
              {{ todayLabel }} · {{ currentStoreName }} · {{ lastSyncText }}
              <span v-if="lastSync.pool" style="color:#b45309"> · 跟踪池 {{ lastSync.pool }} 单<span v-if="lastSync.suspect">（疑似丢件 {{ lastSync.suspect }}）</span></span>
              · 后台自动：新单 15 分钟、待处理 1 小时、取消 2 小时、运输中/签收 12 小时
            </div>
          </div>
          <div class="statistics-actions order-head-actions">
            <el-tooltip content="立即手动跑一次：新单 + 待处理 + 取消 + 兜底核对（约 3~8 秒）" placement="bottom">
              <el-button type="primary" :icon="'Refresh'" :loading="syncBusy" @click="runManualSync">立即同步</el-button>
            </el-tooltip>
            <el-tooltip content="查看后台定时任务：每个步骤的频率、上次执行时间与结果" placement="bottom">
              <el-button :icon="'Timer'" circle aria-label="定时任务" @click="openCronDialog" />
            </el-tooltip>
          </div>
        </header>

        <!-- v2.2.9.200 导出/打印常驻进度条（替代一闪而过的 toast） -->
        <transition name="el-fade-in">
          <div v-if="exportProgress.visible" class="order-progress">
            <div class="order-progress-head">
              <span>{{ exportProgress.label }}</span>
              <span>{{ exportProgress.percent }}%</span>
            </div>
            <el-progress :percentage="exportProgress.percent" :stroke-width="6" :show-text="false" :status="exportProgress.percent >= 100 ? 'success' : ''" />
            <div v-if="exportProgress.detail" class="order-progress-detail">{{ exportProgress.detail }}</div>
          </div>
        </transition>

        <div class="order-status-tabs">
          <button
            v-for="tab in statusTabItems"
            :key="tab.value"
            class="order-status-tab"
            :class="{ 'is-active': activeTab === tab.value }"
            @click="selectStatusTab(tab.value)">
            {{ tab.label }}
            <span class="order-status-count">{{ tab.count }}</span>
          </button>
        </div>

        <div class="statistics-toolbar">
          <div class="statistics-filters order-query-row">
            <el-date-picker v-model="dateRange" type="daterange" value-format="YYYY-MM-DD" format="MM-DD" unlink-panels clearable
              start-placeholder="下单起" end-placeholder="下单止" @change="runQuery" style="width:200px" />
            <el-date-picker v-model="settledRange" type="daterange" value-format="YYYY-MM-DD" format="MM-DD" unlink-panels clearable
              start-placeholder="结算起" end-placeholder="结算止" @change="runQuery" style="width:200px" />
            <el-input v-model="orderNoKeyword" placeholder="订单号/批次号" clearable title="支持订单号、货件号，以及采购批次号" @keyup.enter="runQuery" @clear="runQuery" style="width:145px">
              <template #prefix><el-icon><Search /></el-icon></template>
            </el-input>
            <el-input v-model="productKeyword" placeholder="货品名称/货号/SKU" clearable @keyup.enter="runQuery" @clear="runQuery" style="width:165px" />
            <el-button plain :icon="'Tickets'" @click="openPostingDialog">批量单号<span v-if="postingFilter.length"> ({{ postingFilter.length }})</span></el-button>
            <el-checkbox v-model="onlyMissingPurchase" class="order-flag" @change="runQuery">缺采购</el-checkbox>
            <el-checkbox v-model="onlyUnsettled" class="order-flag" @change="runQuery">未结算</el-checkbox>
            <el-button :icon="'Search'" @click="runQuery">查询</el-button>
            <el-button :icon="'RefreshLeft'" circle aria-label="重置查询条件" title="重置全部查询条件" @click="resetQueryConditions" />
          </div>
        </div>

        <div class="statistics-toolbar order-tool-row">
          <div class="statistics-filters">
            <el-button type="warning" plain :icon="'Download'" @click="exportOrders">订单导出</el-button>
            <el-dropdown trigger="click" @command="handleCostCommand">
              <el-button plain :icon="'Upload'" :loading="costImporting || costTemplateBusy">
                导入采购<el-icon class="el-icon--right"><ArrowDown /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="template">
                    <el-icon><Document /></el-icon><span>生成采购模板（按当前查询）</span>
                  </el-dropdown-item>
                  <el-dropdown-item command="import">
                    <el-icon><Upload /></el-icon><span>导入 Excel（按订单号写入）</span>
                  </el-dropdown-item>
                  <el-dropdown-item command="history" divided>
                    <el-icon><Clock /></el-icon><span>导入历史</span>
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <input ref="costFileInput" type="file" accept=".xlsx,.xls,.csv" style="display:none" @change="onCostFile" />
            <el-dropdown trigger="click" @command="handleBatchCommand">
              <el-button plain :icon="'Files'" :loading="batchBusy">
                批次<el-icon class="el-icon--right"><ArrowDown /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="add">
                    <el-icon><Plus /></el-icon><span>增加批次（当前筛选的全部订单）</span>
                  </el-dropdown-item>
                  <el-dropdown-item command="remove" divided>
                    <el-icon><Delete /></el-icon><span>删除批次（只处理已勾选订单）</span>
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <el-dropdown trigger="click" @command="handlePrintCommand">
              <el-button plain :icon="'Printer'" :loading="yarnPicklistBusy || yarnLabelsBusy">
                打印<el-icon class="el-icon--right"><ArrowDown /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="picklist">
                    <el-icon><Tickets /></el-icon><span>导出毛线拣货单</span>
                  </el-dropdown-item>
                  <el-dropdown-item command="labels">
                    <el-icon><Tickets /></el-icon><span>导出毛线标签（插件）</span>
                  </el-dropdown-item>
                  <el-dropdown-item command="labels-api" :disabled="yarnLabelsBusy" divided>
                    <el-icon><Download /></el-icon><span>API 导出标签</span>
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>

        <div v-if="selectedOrders.length" class="order-selection-bar">
          <span style="font-weight:600">已选择 {{ selectedOrders.length }} 个订单</span>
          <div style="display:flex; gap:6px; flex-wrap:wrap">
            <el-button type="warning" size="small" :loading="batchLoading" @click="batchShip">批量发货</el-button>
            <el-button size="small" :loading="labelsPrinting" @click="printLabels">打印面单</el-button>
            <el-button size="small" :loading="pickListBusy" @click="printPickList">生成拣货单</el-button>
            <el-button size="small" @click="exportOrders">导出当前筛选</el-button>
            <el-button size="small" :loading="yarnExporting" @click="exportPendingSkus">导出待备货毛线</el-button>
          </div>
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

        <el-table :data="displayedOrders" v-loading="loading" element-loading-text="正在读取订单..." border size="small" :empty-text="orderEmptyText" :row-key="orderRowKey" height="calc(100vh - 348px)" style="width:100%" @selection-change="onSelectionChange">
          <el-table-column type="selection" width="42" :selectable="(row) => true" />
          <!-- 2026-11-10 倒计时列已按要求隐藏（deadlineHourText / deadlineBadgeStyle 保留，随时可以恢复） -->
          <el-table-column label="订单号" width="128">
            <template #default="{ row }">
              <div style="display:flex; align-items:center; gap:2px; min-width:0">
                <span class="order-cell-main" style="font-family:ui-monospace,monospace">{{ row.posting_number }}</span>
                <el-button link type="primary" @click="copyPostingNumber(row)"><el-icon size="12"><CopyDocument /></el-icon></el-button>
              </div>
              <div class="order-cell-sub" style="margin-top:2px">{{ row.order_number || row.order_id || '' }}</div>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="96">
            <template #default="{ row }">
              <el-tag size="small" :type="statusTagType(row.status)">{{ statusText(row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="下单日期" width="92">
            <template #default="{ row }">
              <div class="order-cell-main">{{ orderDateText(row) }}</div>
              <div class="order-cell-sub" style="margin-top:2px">{{ orderTimeText(row) }}</div>
            </template>
          </el-table-column>
          <el-table-column v-if="isAllStoresScope()" label="店铺" width="100">
            <template #default="{ row }">
              <span class="order-store-chip">{{ row.store_name || currentStoreName }}</span>
            </template>
          </el-table-column>
          <el-table-column label="商品" min-width="250">
            <template #default="{ row }">
              <div style="display:flex; gap:8px; align-items:center; min-width:0">
                <el-image :src="primaryProduct(row).image" class="order-thumb" fit="cover" preview-teleported hide-on-click-modal :preview-src-list="primaryProduct(row).image ? [primaryProduct(row).image] : []">
                  <template #error>
                    <div class="order-thumb-empty"><el-icon color="#cbd5e1"><Picture /></el-icon></div>
                  </template>
                </el-image>
                <div style="min-width:0; flex:1">
                  <div class="order-cell-main">{{ primaryProduct(row).name || '-' }}</div>
                  <div class="order-cell-sub" style="margin-top:3px">
                    SKU {{ primaryProduct(row).sku || '-' }}　货号 {{ primaryProduct(row).offer_id || '-' }}　×{{ row.product_count || primaryProduct(row).quantity || 1 }}
                    <a v-if="primaryProduct(row).source_url_1688" :href="primaryProduct(row).source_url_1688" target="_blank" rel="noopener noreferrer" style="color:#2563eb">1688</a>
                  </div>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="仓库 / 配送" width="106">
            <template #default="{ row }">
              <div class="order-cell-main">{{ warehouseText(row) }}</div>
              <div class="order-cell-sub" style="margin-top:2px">{{ deliveryText(row) }}</div>
              <div class="order-cell-sub" style="margin-top:2px; color:#4f46e5" v-if="row.tracking_number">{{ row.tracking_number }}</div>
            </template>
          </el-table-column>
          <el-table-column label="订单金额" width="94" align="right">
            <template #default="{ row }">
              <div class="order-cell-num">{{ moneyText(row.total_cny) }}</div>
              <div v-if="Number(row.total_rub || 0)" class="order-cell-sub" style="margin-top:2px">₽ {{ Number(row.total_rub || 0).toFixed(2) }}</div>
            </template>
          </el-table-column>
          <!-- 采购金额 / 贴单费：按订单号关联月结成本表（app_statistics_costs），订单表不加字段 -->
          <el-table-column label="采购金额" width="86" align="right">
            <template #default="{ row }">
              <div v-if="row.purchase_cny != null" class="order-cell-num">{{ moneyText(row.purchase_cny) }}</div>
              <span v-else class="order-cell-sub" style="color:#b45309">待录入</span>
            </template>
          </el-table-column>
          <el-table-column label="贴单费" width="74" align="right">
            <template #default="{ row }">
              <div v-if="row.label_cny != null" class="order-cell-num">{{ moneyText(row.label_cny) }}</div>
              <span v-else class="order-cell-sub">-</span>
            </template>
          </el-table-column>
          <el-table-column label="采购物流号" width="116">
            <template #default="{ row }">
              <div v-if="row.purchase_tracking_no" style="display:flex; align-items:center; gap:2px; min-width:0">
                <span class="order-cell-main" style="font-family:ui-monospace,monospace">{{ row.purchase_tracking_no }}</span>
                <el-button link type="primary" @click="copyText(row.purchase_tracking_no)"><el-icon size="12"><CopyDocument /></el-icon></el-button>
              </div>
              <el-button v-else link type="primary" style="font-size:11px" @click="openProcurementSource(row)">+ 填写</el-button>
            </template>
          </el-table-column>
          <!-- 采购批次号：来自 app_order_batches.batch_no，一单一条 -->
          <el-table-column label="采购批次号" width="112" show-overflow-tooltip>
            <template #default="{ row }">
              <span v-if="row.batch_no" class="order-cell-main" style="font-family:ui-monospace,monospace">{{ row.batch_no }}</span>
              <span v-else class="order-cell-sub">-</span>
            </template>
          </el-table-column>
          <!-- 结算日期：来自 app_statistics_orders.settled_date，同样不加字段 -->
          <el-table-column label="结算日期" width="92">
            <template #default="{ row }">
              <div v-if="row.settled_date" class="order-cell-main">{{ String(row.settled_date).slice(0, 10) }}</div>
              <span v-else class="order-cell-sub">未结算</span>
            </template>
          </el-table-column>
          <el-table-column label="备注" width="96" show-overflow-tooltip>
            <template #default="{ row }">
              <el-button v-if="orderNote(row)" link type="warning" style="max-width:100px; justify-content:flex-start" @click="openNoteDialog(row)">
                <span style="display:block; max-width:100px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">{{ orderNote(row) }}</span>
              </el-button>
              <span v-else class="order-cell-sub">-</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="48" fixed="right" align="center">
            <template #default="{ row }">
              <el-dropdown trigger="click" placement="bottom-end" @command="handleRowAction">
                <el-button link style="width:24px; height:24px; padding:0; color:#64748b">
                  <el-icon size="15"><MoreFilled /></el-icon>
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

        <div class="order-footer">
          <el-pagination
            v-model:current-page="pagination.currentPage"
            v-model:page-size="pagination.pageSize"
            :total="pagination.total"
            :page-sizes="[20, 50, 100, 200, 500, 1000]"
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

      <el-dialog v-model="procurementDialog.visible" title="编辑货源 / 采购" width="520px" style="max-width:calc(100vw - 40px)" destroy-on-close>
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
            <el-form-item label="采购物流号">
              <el-input v-model="procurementDialog.purchase_tracking_no" clearable maxlength="120" placeholder="国内采购发往仓库的快递单号（留空表示暂不填）" />
            </el-form-item>
          </el-form>
          <div style="font-size:12px; color:#8a9499; line-height:1.6">
            采购金额、贴单费请在「导入采购」里按订单号批量录入（与月结统计同一口径），这里只维护货源链接和采购物流号。
          </div>
        </div>
        <template #footer>
          <el-button @click="procurementDialog.visible=false">取消</el-button>
          <el-button type="primary" :loading="procurementDialog.saving" @click="saveProcurementSource">保存</el-button>
        </template>
      </el-dialog>

      <!-- 采购导入历史 -->
      <el-dialog v-model="costHistory.visible" title="采购导入历史" width="840px" top="7vh" append-to-body>
        <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px">
          <span style="font-size:12px; color:#6b767d">每次导入留一条记录，源文件可下载；最多显示最近 50 次</span>
          <el-button size="small" :icon="'Refresh'" :loading="costHistory.loading" @click="fetchCostImports">刷新</el-button>
        </div>
        <el-alert v-if="costHistory.error" type="error" :closable="false" show-icon :title="costHistory.error" style="margin-bottom:8px" />
        <el-table :data="costHistory.rows" size="small" border height="420" empty-text="还没有导入记录">
          <el-table-column label="导入时间" width="140">
            <template #default="{ row }">{{ toBeijingTime(row.created_at) }}</template>
          </el-table-column>
          <el-table-column prop="file_name" label="源文件" min-width="200" show-overflow-tooltip />
          <el-table-column label="行数" width="62" align="right">
            <template #default="{ row }">{{ row.rows }}</template>
          </el-table-column>
          <el-table-column label="成功" width="62" align="right">
            <template #default="{ row }"><b style="color:#15803d">{{ row.applied }}</b></template>
          </el-table-column>
          <el-table-column label="失败" width="62" align="right">
            <template #default="{ row }"><span :style="{ color: row.failed ? '#dc2626' : '#94a3b8' }">{{ row.failed }}</span></template>
          </el-table-column>
          <el-table-column prop="message" label="结果" min-width="170" show-overflow-tooltip />
          <el-table-column label="源文件" width="74" align="center">
            <template #default="{ row }">
              <el-button v-if="row.has_file" link type="primary" @click="downloadCostImport(row)">下载</el-button>
              <span v-else style="color:#cbd5e1">-</span>
            </template>
          </el-table-column>
        </el-table>
        <template #footer><el-button @click="costHistory.visible = false">关闭</el-button></template>
      </el-dialog>

      <!-- 定时任务看板 -->
      <el-dialog v-model="cronDialog.visible" title="后台定时任务" width="900px" top="6vh" append-to-body class="order-cron-dialog">
        <div class="cron-head">
          <span class="cron-meta">
            这里只列与本页 / 结算相关的定时器；每次执行结果保留 7 天。
            <span v-if="cronDialog.refreshedAt">数据时间 {{ toBeijingTime(cronDialog.refreshedAt) }}，每 15 秒自动刷新</span>
          </span>
          <el-button size="small" :icon="'Refresh'" :loading="cronDialog.loading" @click="fetchCronJobs">刷新</el-button>
        </div>
        <el-alert v-if="cronDialog.error" type="error" :closable="false" show-icon :title="'读取定时任务失败：' + cronDialog.error" style="margin-bottom:10px" />
        <div v-loading="cronDialog.loading && !cronDialog.jobs.length" element-loading-text="正在读取定时任务...">
          <div v-for="job in cronDialog.jobs" :key="job.key" class="cron-job" :class="{ 'is-frontend': job.type === 'frontend' }">
            <div class="cron-job-head">
              <b>{{ job.title }}</b>
              <el-tag size="small" :type="job.type === 'frontend' ? 'info' : 'primary'" effect="plain">{{ job.type === 'frontend' ? '前端' : '后台' }}</el-tag>
              <el-tag v-if="cronIsRunning(job)" size="small" type="warning" effect="dark">运行中</el-tag>
              <span class="cron-job-schedule">{{ job.schedule }}</span>
            </div>
            <div class="cron-row"><span class="cron-label">抓什么</span><div class="cron-text">{{ job.scope }}</div></div>
            <div class="cron-row"><span class="cron-label">条件</span><div class="cron-text">{{ job.condition }}</div></div>
            <div v-if="job.covers && job.covers.length" class="cron-row">
              <span class="cron-label">覆盖</span>
              <div class="cron-text"><span v-for="c in job.covers" :key="c" class="cron-chip">{{ c }}</span></div>
            </div>
            <div class="cron-runs">
              <template v-if="job.runs && job.runs.length">
                <div v-for="(run, index) in job.runs" :key="run.id" class="cron-run">
                  <span class="cron-run-when">{{ cronRunLabel(index) }}</span>
                  <span class="cron-run-time">{{ toBeijingTime(run.started_at) || '-' }}</span>
                  <el-tag size="small" :type="cronStatusMeta(run.status).type" effect="plain">{{ cronStatusMeta(run.status).text }}</el-tag>
                  <span class="cron-run-dur">{{ cronDuration(run) }}</span>
                  <span class="cron-run-summary">{{ run.summary || '—' }}</span>
                </div>
              </template>
              <div v-else class="cron-run-empty">{{ job.type === 'frontend' ? '前端任务，不在服务端记录执行结果' : '暂无执行记录（服务刚重启或还没到执行时点）' }}</div>
            </div>
          </div>
          <div v-if="!cronDialog.jobs.length && !cronDialog.loading" class="cron-run-empty">没有读取到定时任务</div>
        </div>
        <template #footer><el-button @click="cronDialog.visible = false">关闭</el-button></template>
      </el-dialog>

      <!-- 2026-11-10 增加采购批次号：作用于「当前查询条件命中的全部订单」 -->
      <el-dialog v-model="batchDialog.visible" title="增加采购批次号" width="460px" append-to-body>
        <div style="font-size:13px; color:#64748b; line-height:1.7; margin-bottom:10px">
          将给「当前查询条件命中的<b>全部订单</b>」写入同一个批次号（不受分页限制）。
          只要命中订单里有一单已有批次号，本次会整体拒绝——请先勾选这些订单执行「删除批次」。
        </div>
        <el-input v-model="batchDialog.value" maxlength="40" show-word-limit clearable
          placeholder="例如：PO-20261110-01" @keyup.enter="submitBatch" />
        <div style="font-size:12px; color:#94a3b8; margin-top:8px">批次号在系统内不可重复，录入后可用订单号框按批次号反查。</div>
        <template #footer>
          <el-button @click="batchDialog.visible = false">取消</el-button>
          <el-button type="primary" :loading="batchDialog.busy" @click="submitBatch">确定录入</el-button>
        </template>
      </el-dialog>

      <!-- v0.3.3 订单详情抽屉 -->
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
                  {{ detailDrawer.order.fees ? '₽ ' + Number(detailDrawer.order.fees.total_fee || 0).toFixed(2) : '' }}
                </span>
                <span v-if="!detailDrawer.order.fees" style="margin-left:8px; font-size:12px; color:#94a3b8">暂无费用数据</span>
              </el-descriptions-item>
              <el-descriptions-item label="合计费用（人民币）">
                <span style="font-weight:700; color:#b45309">
                  {{ detailDrawer.order.fees ? '¥ ' + Number(detailDrawer.order.fees.total_fee_cny || 0).toFixed(2) : '-' }}
                </span>
                <span v-if="detailDrawer.order.fees && detailDrawer.order.fees.settle_period" style="margin-left:8px; font-size:12px; color:#94a3b8">结算期 {{ detailDrawer.order.fees.settle_period }}</span>
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
