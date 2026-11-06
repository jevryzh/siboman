window.StatisticsAnalysisView = {
  setup() {
    const { ref, computed, onMounted, onBeforeUnmount, watch } = Vue;
    const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const offsetMonth = (month, delta) => { const d = new Date(month + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + delta); return d.toISOString().slice(0, 7); };
    const shiftDay = (value, days) => new Date(Date.parse(`${value}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
    // 默认展示本月，切换月份时按所选月份重新取数
    const month = ref(today().slice(0, 7));
    const monthRange = ref([offsetMonth(today().slice(0, 7), -1), today().slice(0, 7)]);
    const tab = ref('orders'), loading = ref(false), saving = ref(false), syncing = ref(false), error = ref('');
    // 订单表同步（这里才是订单维度：状态 / 结算日期），与应计原始数据页的应计流水同步分开
    const orderSyncing = ref(false), orderLogLoading = ref(false), orderLogs = ref([]), orderLogLast = ref('');
    // 订单同步的实时进度：{phase, progress, fetched, changed}
    const orderSyncProgress = ref(null);
    // 手动同步订单表用的区间：默认今天往前一周
    const orderSyncRange = ref([shiftDay(today(), -7), today()]);
    const rows = ref([]), monthly = ref([]), summary = ref({}), run = ref(null), total = ref(0);
    const page = ref(1), pageSize = ref(100), search = ref(''), status = ref(''), orderType = ref(''), exporting = ref(false);
    // 主筛选栏常驻的两个日期区间：下单日期 / 结算日期
    const orderDateRange = ref([]), settleDateRange = ref([]);
    const batchNumbers = ref([]), batchVisible = ref(false), batchText = ref(''), batchError = ref('');
    const missingOnly = ref(false), unsettledOnly = ref(false), sort = ref('ordered_at'), direction = ref('asc');
    const selected = ref([]), table = ref(null), costVisible = ref(false), drafts = ref([]), fillAmount = ref(null), labelFillAmount = ref(null);
    const costError = ref(''), costScope = ref(null), uploadInput = ref(null), monthVisible = ref(false), costSource = ref('manual');
    const costPage = ref(1);
    // 同步结算日期：正常单取 Ozon 后台取消时间，WHD 单由插件在「退货和取消」页取（只到日）
    const settledSyncing = ref(false), settledStage = ref('');
    // 进度：{phase, done, total}；结果：{ok, fail, groups:[{label, ok, fail, reason, postings}]}
    const settleRun = ref(null);
    const settlePluginVersion = ref("");
    const settleResult = ref({ visible: false, ok: 0, fail: 0, groups: [], requested: 0 });
    const cookieVisible = ref(false), cookieSaving = ref(false), cookieInput = ref(''), webSession = ref(null);
    const costPageRows = computed(() => drafts.value.slice((costPage.value - 1) * 50, costPage.value * 50));
    const monthDraft = ref({}), monthScope = ref(null), settingsError = ref('');
    // 记录中心：订单表同步记录 + 修改记录 合到一个弹窗，用标签切换
    const recordsVisible = ref(false), recordsTab = ref('order');
    const changes = ref([]), changesLoading = ref(false);
    const ledgerVisible = ref(false), ledgerLoading = ref(false), ledger = ref([]), ledgerPending = ref([]), ledgerOrder = ref('');
    const ledgerMonths = ref([]);
    const ledgerError = ref(''), orderTab = ref('fees'), orderRow = ref(null), orderDetail = ref(null);
    const detailLoading = ref(false), detailLoaded = ref(false), detailError = ref('');
    const exceptionScope = ref(null), exceptionVisible = ref(false), exceptionLoading = ref(false), exceptionError = ref('');
    const exceptionPage = ref(1), exceptions = ref({ rows: [], total: 0, page_size: 100 });
    const exceptionTitles = { receipt_rub: '实收 ₽ 待核对', receipt_cny: '实收 ¥ 待核对', pending: '收支待分摊订单',
      unresolved: '未匹配流水', ads: '点击费待核对订单', order_ads: '按订单广告待核对', purchase: '待补采购费订单', metadata: '待补订单资料' };
    let exceptionRequest = 0;
    const productZoom = ref(null);
    const orderQuantity = computed(() => (orderDetail.value?.products || []).reduce((sum, product) => sum + (Number(product.quantity) || 0), 0));
    let orderRequest = 0;
    const fieldCatalog = ref([]), rules = ref([]), filterVisible = ref(false), appliedRules = ref([]), advertising = ref({});
    const adsVisible = ref(false), adsError = ref(''), adsInput = ref(null), adsDraft = ref([]), adsExisting = ref([]), adsRevision = ref(''), adsScope = ref(null);
    const adsPasteVisible = ref(false), adsText = ref('');
    const adsTotals = computed(() => adsDraft.value.reduce((totals, row) => {
      totals.cpo += Math.round(row.cpo_rub * 100); totals.cpc += Math.round(row.cpc_rub * 100);
      return totals;
    }, { cpo: 0, cpc: 0 }));
    const configVisible = ref(false), configDraft = ref({}), configError = ref(''), configScope = ref(null);
    const adStates = { confirmed: '已核对', other_month: '点击费归下单月', whd_excluded: 'WHD不分摊', missing_date: '下单日期待补', missing_config: '广告日报待导入 / 授权待配置', pending_day: '次日核对', not_synced: '广告费待同步', incomplete_cohort: '当日全量订单待核对' };
    const adStatus = (row) => adStates[row.advertising_state] || '待核对';
    const fieldType = (rule) => fieldCatalog.value.find((f) => f.key === rule.field)?.type || 'text';
    const operators = (rule) => [{ value: 'empty', label: '为空' }, { value: 'not_empty', label: '不为空' }, ...(fieldType(rule) === 'text'
      ? [{ value: 'contains', label: '包含' }, { value: 'not_contains', label: '不包含' }, { value: 'eq', label: '等于' }, { value: 'ne', label: '不等于' }]
      : [{ value: 'eq', label: '等于' }, { value: 'gt', label: '大于' }, { value: 'gte', label: '大于等于' }, { value: 'lt', label: '小于' }, { value: 'lte', label: '小于等于' }, { value: 'between', label: '区间' }])];
    function resetRule(rule) { rule.op = fieldType(rule) === 'text' ? 'contains' : 'eq'; rule.value = ''; rule.value2 = ''; }
    function addRule() { if (rules.value.length < 30) rules.value.push({ field: 'profit_cny', op: 'lt', value: 0, value2: '' }); }
    function queryRules() { appliedRules.value = rules.value.map((r) => ({ ...r })); applyFilter(); }
    function resetFilters() { rules.value = []; appliedRules.value = []; batchNumbers.value = []; search.value = ''; status.value = ''; orderType.value = ''; missingOnly.value = false; unsettledOnly.value = false; orderDateRange.value = []; settleDateRange.value = []; applyFilter(); }
    let generation = 0, poll = null, stopped = false;
    const sid = () => window.getCurrentStoreId?.() || localStorage.getItem('currentStoreId') || '';
    // 顶部卡片跟着月份选择器走；下方订单明细用 tableMonth（切月份时不重载，切回该 tab 才跟随）
    const tableMonth = ref(month.value);
    const ctx = () => ({ store_id: sid(), month: tableMonth.value });
    const sameScope = (scope) => scope && scope.store_id === sid();
    const money = (value) => value == null ? '—' : Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const dateTime = (value) => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)) : '—';
    const message = (e) => e?.response?.data?.error || e?.message || '请求失败';
    const activeRun = computed(() => run.value && ['queued', 'running'].includes(run.value.status));
    const progress = computed(() => run.value?.days_total ? Math.min(99, Math.round(run.value.days_done / run.value.days_total * 90)) : 0);
    const titleProfit = (s) => s.profit_cny != null ? '' : !s.coverage?.complete ? '应计流水尚未完整同步' : s.missing_advertising ? `广告待核对 ${s.missing_advertising} 单` : s.missing_purchase ? `待补采购费 ${s.missing_purchase} 单` : s.pending_rows || s.unresolved_parents ? '存在未分摊收支' : s.missing_metadata ? '订单资料待补充' : !s.exchange_rate ? '汇率待设置' : '暂无订单';
    const monthlyProfit = (s) => s.profit_cny ?? (s.coverage?.complete ? (s.known_cost_profit_cny ?? null) : null);
    const monthlyProfitEstimated = (s) => s.profit_cny == null && monthlyProfit(s) != null;
    function monthlyProfitNote(s) {
      const notes = monthlyProfitEstimated(s) ? ['暂估'] : [];
      if (s.profit_orders != null) notes.push(`已计入 ${s.profit_orders} 单`);
      return notes.join(' · ');
    }
    function monthlyIssues(row) {
      return [
        { kind: 'purchase', count: row.missing_purchase, label: `待补采购费 ${row.missing_purchase} 单` },
        { kind: 'ads', count: row.missing_advertising, label: `点击费待核对 ${row.missing_advertising} 单` },
        { kind: 'order_ads', count: row.missing_order_advertising, label: `订单广告待核对 ${row.missing_order_advertising} 单` },
        { kind: 'pending', count: row.pending_rows, label: `收支待分摊 ${row.pending_rows} 单` },
        { kind: 'unresolved', count: row.unresolved_parents, label: `未匹配流水 ${row.unresolved_parents} 笔` },
        { kind: 'metadata', count: row.missing_metadata, label: `订单资料待补 ${row.missing_metadata} 单` },
      ].filter((issue) => issue.count > 0);
    }
    function openExceptions(row, kind) {
      exceptionScope.value = { store_id: sid(), month: row.month, group: row.group || 'total', kind,
        title: `${row.month} · ${row.is_group ? row.label : '合计'} · ${exceptionTitles[kind]}` };
      exceptionPage.value = 1; exceptions.value = { rows: [], total: 0, page_size: 100 };
      exceptionVisible.value = true; loadExceptions();
    }
    async function loadExceptions() {
      const scope = exceptionScope.value;
      if (!exceptionVisible.value || !scope || scope.store_id !== sid()) return;
      const request = ++exceptionRequest;
      const current = () => !stopped && exceptionVisible.value && request === exceptionRequest && scope.store_id === sid();
      exceptionLoading.value = true; exceptionError.value = '';
      try {
        const { data } = await axios.get('/api/statistics/exceptions', { params: { store_id: scope.store_id, month: scope.month,
          group: scope.group, kind: scope.kind, page: exceptionPage.value } });
        if (current()) exceptions.value = data;
      } catch (e) { if (current()) exceptionError.value = message(e); }
      finally { if (current()) exceptionLoading.value = false; }
    }
    function exceptionReason(row) {
      const notes = [];
      if (row.pending_income ?? row.pending_positive) notes.push('收入待分摊');
      else if (row.pending_positive) notes.push('主单手续费退回未计入');
      if (row.pending_negative) notes.push('费用待分摊');
      if (row.metadata_missing) notes.push('订单资料待补');
      if (row.allocated_ad_rub == null) notes.push(adStatus(row));
      if (exceptionScope.value?.kind === 'order_ads') notes.push('没有已确认的逐单广告费');
      if (exceptionScope.value?.kind === 'purchase') notes.push('采购费待录入');
      if (exceptionScope.value?.kind === 'receipt_cny' && !exceptions.value.exchange_rate) notes.push('汇率待设置');
      if (!exceptions.value.coverage_complete) notes.push('应计流水未同步完整');
      return notes.join(' · ') || '收支待核对';
    }
    function sortMonthlyProfit(a, b) {
      const left = monthlyProfit(a), right = monthlyProfit(b);
      return left == null ? (right == null ? 0 : 1) : right == null ? -1 : left - right;
    }
    const monthlyReceipt = (row, currency) => row['receipt_' + currency] ?? row['known_receipt_' + currency] ?? null;
    const typeLabels = { 1: '收单手续费（正数为退回）', 3: '品牌推广', 4: '品牌推广接入', 19: '站外推广', 23: '站内广告', 33: '广告服务', 41: '点击广告', 49: 'Premium推广', 54: '商品推广', 59: '逆向物流', 67: '国际配送服务', 87: '社交媒体广告', 122: '国际运输合同组织服务', 123: 'Ozon物流平台接入服务', 130: '展示广告' };
    const feeName = (row) => row.types?.length ? row.types.map((id) => typeLabels[id] || `费用类型 ${id}`).join('、') : '订单结算汇总（内层费用不重复累计）';
    // 下单日期 / 结算日期两个区间控件不在规则面板里，查询时合并成两条 between 规则一起提交
    const activeRules = () => {
      const list = [...appliedRules.value];
      const [of, ot] = orderDateRange.value || [];
      if (of && ot) list.push({ field: 'ordered_at', op: 'between', value: of, value2: ot });
      const [sf, st] = settleDateRange.value || [];
      if (sf && st) list.push({ field: 'order_settled_date', op: 'between', value: sf, value2: st });
      return list;
    };
    const filters = () => ({ ...ctx(), page: page.value, page_size: pageSize.value, search: search.value, status: status.value,
      order_type: orderType.value, missing_cost: missingOnly.value ? '1' : '', unsettled: unsettledOnly.value ? '1' : '', sort: sort.value, direction: direction.value, filters: JSON.stringify(activeRules()) });
    function requestOrders(url, options = {}) {
      const params = filters();
      return batchNumbers.value.length
        ? axios.post(url, { ...params, posting_numbers: batchNumbers.value }, options)
        : axios.get(url, { ...options, params });
    }
    function openBatch() {
      batchText.value = batchNumbers.value.join('\n'); batchError.value = ''; batchVisible.value = true;
    }
    function applyBatch() {
      if (batchText.value.length > 350000) { batchError.value = '内容过长，请分批筛选'; return; }
      const tokens = batchText.value.trim().split(/[\s,，;；、]+/).filter(Boolean);
      if (tokens[0] === '订单号') tokens.shift();
      const numbers = [...new Set(tokens)];
      if (!numbers.length || numbers.length > 5000) { batchError.value = '请输入 1 至 5000 个不同的订单号'; return; }
      const invalid = numbers.find((number) => number.length > 64 || !/^\d+-\d+-\d+$/.test(number));
      if (invalid) { batchError.value = `订单号格式不正确：${invalid.slice(0, 64)}，请粘贴完整订单号`; return; }
      batchNumbers.value = numbers; search.value = ''; batchVisible.value = false; applyFilter();
    }
    function clearBatch() { batchNumbers.value = []; batchVisible.value = false; applyFilter(); }
    async function load(all = true) {
      if (!sid() || !month.value || stopped) return;
      const scope = ctx(), token = ++generation;
      loading.value = true; error.value = '';
      try {
        const response = await requestOrders('/api/statistics/report');
        if (token !== generation || !sameScope(scope)) return;
        rows.value = response.data.rows; total.value = response.data.total; run.value = response.data.run;
        // 表格月份与顶部月份不一致时（切换了月份但还没重载表格），不要用表格结果覆盖顶部卡片
        if (scope.month === month.value) summary.value = response.data.summary;
        fieldCatalog.value = response.data.filter_catalog || []; advertising.value = response.data.advertising || {};
        if (all && monthRange.value?.length === 2) {
          const result = await axios.get('/api/statistics/months', { params: { store_id: scope.store_id, from: monthRange.value[0], to: monthRange.value[1] } });
          if (token !== generation || !sameScope(scope)) return;
          monthly.value = result.data.rows;
        }
      } catch (e) { if (token === generation && sameScope(scope)) error.value = message(e); }
      finally { if (token === generation) loading.value = false; }
    }
    // 只刷新顶部指标卡：切月份时不动下方两个 tab 的数据，也不触发表格的 loading 遮罩
    let summaryRequest = 0;
    async function loadSummary() {
      if (!sid() || !month.value || stopped) return;
      const scope = { store_id: sid(), month: month.value }, request = ++summaryRequest;
      try {
        const { data } = await axios.get('/api/statistics/summary', { params: { store_id: scope.store_id, month: scope.month } });
        if (request !== summaryRequest || !sameScope(scope) || scope.month !== month.value) return;
        summary.value = data.summary; run.value = data.run;
      } catch (e) { if (request === summaryRequest && sameScope(scope)) error.value = message(e); }
    }
    function applyFilter() { tableMonth.value = month.value; page.value = 1; selected.value = []; table.value?.clearSelection(); load(false); }
    function sortChanged({ prop, order }) { sort.value = prop || 'accrual_date'; direction.value = order === 'descending' ? 'desc' : 'asc'; applyFilter(); }
    async function syncNow() {
      const scope = ctx();
      if (!scope.store_id) return;
      syncing.value = true; error.value = '';
      try {
        const response = await axios.post('/api/statistics/sync', scope);
        if (sameScope(scope)) { run.value = response.data.run; await load(); }
      } catch (e) { if (sameScope(scope)) error.value = message(e); }
      finally { syncing.value = false; }
    }
    // 同步订单表：按顶部区间拉订单（默认今天往前一周），再补一批非终态订单，回填状态与结算日期
    // 后端把每一步写进 app_statistics_order_syncs(phase/progress)，这里边同步边轮询，实时画进度
    let orderSyncTimer = null;
    function stopOrderSyncPoll() { if (orderSyncTimer) { clearInterval(orderSyncTimer); orderSyncTimer = null; } }
    async function pollOrderSync() {
      try {
        const r = await axios.get('/api/statistics/order-syncs', { params: { store_id: sid() } });
        const running = (r.data.rows || []).find((row) => row.status === 'running');
        if (!running) return;
        orderSyncProgress.value = {
          phase: running.phase || '正在同步…',
          progress: Number(running.progress) || 0,
          fetched: Number(running.fetched) || 0,
          changed: Number(running.changed) || 0,
          startedAt: running.started_at || '',
        };
      } catch { /* 轮询失败不影响同步本身，下一轮再试 */ }
    }
    async function syncOrdersNow() {
      if (!sid() || orderSyncing.value) return;
      const range = Array.isArray(orderSyncRange.value) ? orderSyncRange.value : [];
      if (!range[0] || !range[1]) { ElementPlus.ElMessage.warning('请先选择订单同步区间'); return; }
      orderSyncing.value = true; error.value = '';
      orderSyncProgress.value = { phase: '正在启动同步…', progress: 1, fetched: 0, changed: 0, startedAt: '' };
      stopOrderSyncPoll();
      orderSyncTimer = setInterval(pollOrderSync, 1200);
      try {
        const { data } = await axios.post('/api/statistics/sync-orders', { store_id: sid(), from: range[0], to: range[1] });
        orderSyncProgress.value = { phase: '同步完成，正在刷新表格…', progress: 100, fetched: data.fetched, changed: data.changed, startedAt: '' };
        ElementPlus.ElMessage.success(`订单同步完成（${range[0]} ~ ${range[1]}）：读取 ${data.fetched} 单，更新 ${data.changed} 单`);
        await load();
      } catch (e) { error.value = message(e); }
      finally {
        stopOrderSyncPoll();
        orderSyncing.value = false;
        setTimeout(() => { if (!orderSyncing.value) orderSyncProgress.value = null; }, 1600);
      }
    }
    async function loadOrderLogs() {
      if (!sid()) return;
      orderLogLoading.value = true;
      try {
        const r = await axios.get('/api/statistics/order-syncs', { params: { store_id: sid() } });
        orderLogs.value = r.data.rows || [];
        orderLogLast.value = r.data.last_succeeded_at || '';
      } catch (e) { error.value = message(e); }
      finally { orderLogLoading.value = false; }
    }
    function openRecords(tab = recordsTab.value || 'order') {
      if (!sid()) return;
      recordsTab.value = tab === 'change' ? 'change' : 'order';
      recordsVisible.value = true;
      loadOrderLogs();
      if (recordsTab.value === 'change') loadChanges();
    }
    function loadChanges() {
      changesLoading.value = true;
      const store = sid();
      axios.get('/api/statistics/changes', { params: { store_id: store } })
        .then((response) => { if (store === sid()) changes.value = response.data.rows; })
        .catch((e) => { error.value = message(e); })
        .finally(() => { changesLoading.value = false; });
    }
    function recordsTabChanged(name) {
      if (name === 'change' && !changes.value.length) loadChanges();
      if (name === 'order' && !orderLogs.value.length) loadOrderLogs();
    }
    const canMaintainCosts = (row) => row.order_type !== 'WHD订单' && row.cost_in_month !== false;
    function openCosts(items = selected.value, source = 'manual') {
      const editable = items.filter(canMaintainCosts);
      if (!editable.length) return;
      costScope.value = ctx(); fillAmount.value = null; labelFillAmount.value = null; costError.value = ''; costPage.value = 1;
      costSource.value = source;
      drafts.value = editable.map((r) => ({ posting_number: r.posting_number, purchase_cny: r.purchase_cny, label_cny: r.label_cny, version: r.version }));
      costVisible.value = true;
    }
    function fillCosts() {
      if (fillAmount.value == null || !Number.isFinite(fillAmount.value) || fillAmount.value < 0) return;
      drafts.value.forEach((r) => { r.purchase_cny = fillAmount.value; });
    }
    function fillLabels() {
      if (labelFillAmount.value == null || !Number.isFinite(labelFillAmount.value) || labelFillAmount.value < 0) return;
      drafts.value.forEach((r) => { r.label_cny = labelFillAmount.value; });
    }
    // 一次性取回所选应计月份的全部订单，导入核对与模板生成共用。
    async function monthRows(scope) {
      const known = new Map();
      for (let p = 1; ; p++) {
        const result = await axios.get('/api/statistics/report', { params: { ...scope, page: p, page_size: 500 } });
        if (!sameScope(scope)) return null;
        result.data.rows.forEach((r) => known.set(r.posting_number, r));
        if (p * 500 >= result.data.total) return known;
        if (p > 200) throw new Error('订单量超过导入核对上限');
      }
    }
    function sortCosts({ prop, order }) {
      if (!prop) return;
      const factor = order === 'descending' ? -1 : 1;
      drafts.value.sort((a, b) => a[prop] == null ? (b[prop] == null ? 0 : 1) : b[prop] == null ? -1 : factor * (typeof a[prop] === 'number' ? a[prop] - b[prop] : String(a[prop]).localeCompare(String(b[prop]))));
      costPage.value = 1;
    }
    async function saveCosts() {
      if (!sameScope(costScope.value)) { costError.value = '店铺或月份已改变，请重新打开'; return; }
      const invalid = drafts.value.some((r) => r.purchase_cny != null && (!Number.isFinite(r.purchase_cny) || r.purchase_cny < 0));
      if (invalid) { costError.value = '采购费用必须为空或大于等于0'; return; }
      const badLabel = drafts.value.some((r) => r.label_cny != null && (!Number.isFinite(r.label_cny) || r.label_cny < 0));
      if (badLabel) { costError.value = '贴单费用必须为空或大于等于0'; return; }
      try {
        await ElementPlus.ElMessageBox.confirm(`保存 ${costScope.value.month} 共 ${drafts.value.length} 单的采购费/贴单费？采购费为空的订单将保持待核算，修改前会保留快照。`, '确认批量维护', { type: 'warning', confirmButtonText: '保存', cancelButtonText: '取消' });
        if (!sameScope(costScope.value)) return;
        saving.value = true; costError.value = '';
        await axios.patch('/api/statistics/costs', { ...costScope.value, reason: costSource.value === 'import' ? '导入采购费/贴单费' : '批量维护采购费/贴单费',
          items: drafts.value.map((r) => ({ posting_number: r.posting_number, purchase_cny: r.purchase_cny ?? null, label_cny: r.label_cny ?? null, version: r.version })) });
        costVisible.value = false; selected.value = []; table.value?.clearSelection();
        ElementPlus.ElMessage.success('采购费/贴单费已保存，修改快照已保留'); await load();
      } catch (e) { if (e !== 'cancel' && e !== 'close') costError.value = message(e); }
      finally { saving.value = false; }
    }
    // ── 同步结算日期（取消单）───────────────────────────────────────────────
    // Ozon Seller API 不返回取消时间，只能走卖家后台；cookie 由采集插件从浏览器直接读取。
    function sendToPlugin(kind, extra = {}, timeoutMs = 10000) {
      const send = window.__zhumeng_send__;
      if (typeof send !== "function") return Promise.resolve(null);
      return send(kind, extra, timeoutMs);
    }
    async function loadWebSession() {
      try { webSession.value = (await axios.get("/api/statistics/web-session", { params: { store_id: sid() } })).data; }
      catch (_e) { webSession.value = null; }
    }
    // 插件逐单/逐页推的进度（content-bridge 转成 window message）
    function onSettleProgress(event) {
      const data = event?.data;
      if (!data || typeof data !== "object" || data.kind !== "settleProgress.event") return;
      if (!settleRun.value) return;
      if (data.phase === "whd" && data.total) {
        settleRun.value = { phase: "取 WHD 取消日期", done: data.done || 0, total: data.total, hit: data.hit || 0 };
      } else if (data.phase === "fbs") {
        settleRun.value = { phase: `拉取正常单取消时间（已拉到 ${data.scanned || 0} 单）`, done: data.done || 0, total: 0, scanned: data.scanned || 0 };
      }
    }
    function settleProgressText() {
      const run = settleRun.value;
      if (!run) return "";
      if (!run.total) return `${run.phase}（第 ${run.done || 1} 批）`;
      const pct = Math.min(100, Math.round(run.done / run.total * 100));
      return `${run.phase} ${run.done}/${run.total}（${pct}%）`;
    }
    function settlePercent() {
      const run = settleRun.value;
      if (!run || !run.total) return 0;
      return Math.min(100, Math.round(run.done / run.total * 100));
    }
    // 把插件返回原样报给服务端（只打日志，方便定位「为什么没写入」）
    function reportPluginResult(kind, payload, elapsed) {
      try {
        axios.post("/api/statistics/sync-settled-report", {
          store_id: sid(), kind, elapsed_ms: elapsed,
          version: settlePluginVersion.value, ...payload,
        }).catch(() => {});
      } catch (_e) { /* 忽略 */ }
    }
    // 版本比较：2.2.9.209 > 2.2.9.206
    function versionAtLeast(version, target) {
      const left = String(version || "").split(".").map((n) => parseInt(n, 10) || 0);
      const right = String(target || "").split(".").map((n) => parseInt(n, 10) || 0);
      for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
        const a = left[i] || 0, b = right[i] || 0;
        if (a !== b) return a > b;
      }
      return true;
    }
    // 动手前先确认插件在线且版本够新，避免旧插件没有对应指令、前端干等 5 分钟超时
    async function ensurePluginReady() {
      const ping = await sendToPlugin("ping.request", {}, 5000);
      reportPluginResult("ping", { ok: ping?.ok === true, error: ping ? "" : "ping 无响应", version: ping?.version || "" }, 0);
      if (!ping || !ping.ok) return { ok: false, error: "没检测到采集插件：请在「店铺管理」下载并启用（需 2.2.9.209）" };
      const version = String(ping.version || "");
      if (!versionAtLeast(version, "2.2.9.206")) {
        return { ok: false, error: `页面里的插件脚本还是旧版（${version || "未知"}）：扩展更新后必须刷新本页面（Cmd+Shift+R）才能加载新脚本` };
      }
      settlePluginVersion.value = version;
      return { ok: true, version };
    }
    async function syncSettledDates() {
      if (!sid() || settledSyncing.value) return;
      settledSyncing.value = true; error.value = ""; settleResult.value = { visible: false, ok: 0, fail: 0, groups: [], requested: 0 };
      settleRun.value = { phase: "检查插件", done: 0, total: 0 };
      try {
        const plugin = await ensurePluginReady();
        if (!plugin.ok) {
          settleRun.value = null;
          ElementPlus.ElMessage.error(plugin.error);
          return;
        }
        settleRun.value = { phase: "统计待补订单", done: 0, total: 0 };
        const body = { ...filters(), posting_numbers: batchNumbers.value.length ? batchNumbers.value : undefined, plan: true };
        const { data } = await axios.post("/api/statistics/sync-settled", body);
        const fbsList = Array.isArray(data.fbs) ? data.fbs : [];
        const whdList = Array.isArray(data.whd) ? data.whd : [];
        if (!fbsList.length && !whdList.length) {
          settleRun.value = null;
          ElementPlus.ElMessage.info("当前筛选条件下没有「已取消且缺结算日期」的订单");
          return;
        }
        const groups = [];
        let fbsSaved = 0, whdSaved = 0;

        if (fbsList.length) {
          settleRun.value = { phase: "拉取正常单取消时间", done: 0, total: fbsList.length };
          const startedAt = Date.now();
          const resp = await sendToPlugin("ozonCancel.request",
            { postings: fbsList, companyId: data.company_id || "", from: data.range?.from, to: data.range?.to }, 120000);
          reportPluginResult("fbs", {
            ok: resp?.ok === true, error: resp?.error || (resp ? "" : "插件无返回（超时或未安装）"),
            total: fbsList.length, scanned: resp?.scanned || 0,
            rows: resp ? Object.keys(resp.rows || {}).length : 0,
            missing: Array.isArray(resp?.missing) ? resp.missing.length : 0,
            pages: resp?.pages, tabs: resp?.tabs,
          }, Date.now() - startedAt);
          if (!resp) {
            groups.push({ label: "正常销售订单", ok: 0, fail: fbsList.length, reason: "没检测到采集插件（需 2.2.9.207+）", postings: fbsList.slice(0, 200) });
          } else if (!resp.ok) {
            groups.push({ label: "正常销售订单", ok: 0, fail: fbsList.length, reason: `取数失败：${resp.error || "插件无返回"}`, postings: fbsList.slice(0, 200) });
          } else {
            const items = Object.entries(resp.rows || {}).map(([posting_number, iso]) =>
              ({ posting_number, date: new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 10) }));
            if (items.length) {
              const saved = await axios.post("/api/statistics/sync-settled-whd", { store_id: sid(), schema: "fbs", items });
              fbsSaved = Number(saved.data.updated || 0);
            }
            const missing = Array.isArray(resp.missing) ? resp.missing : [];
            const scanned = Number(resp.scanned || 0);
            const pages = Array.isArray(resp.pages) ? resp.pages.length : 0;
            groups.push({ label: "正常销售订单", ok: fbsSaved, fail: missing.length,
              reason: missing.length
                ? `后台扫到 ${scanned} 单${pages ? `（${pages} 页）` : ""}，其中没有这 ${missing.length} 单（已归档、或不属于当前公司）`
                : `后台扫到 ${scanned} 单，全部命中`,
              postings: missing.slice(0, 200) });
            settleRun.value = { phase: "拉取正常单取消时间", done: fbsList.length, total: fbsList.length };
          }
        }

        if (whdList.length) {
          const chunkSize = 5;
          const whdMissing = [];
          let whdError = "";
          for (let i = 0; i < whdList.length; i += chunkSize) {
            const chunk = whdList.slice(i, i + chunkSize);
            settleRun.value = { phase: "取 WHD 取消日期", done: i, total: whdList.length };
            const resp = await sendToPlugin("whdCancel.request", { postings: chunk }, 300000);
            if (!resp) { whdError = "没检测到采集插件（需 2.2.9.207+）"; whdMissing.push(...chunk); break; }
            if (!resp.ok) { whdError = `取数失败：${resp.error || "插件无返回"}`; whdMissing.push(...chunk); break; }
            if (Array.isArray(resp.missing)) whdMissing.push(...resp.missing);
            const items = Object.entries(resp.rows || {}).map(([posting_number, row]) => ({ posting_number, date: row.date }));
            if (items.length) {
              const saved = await axios.post("/api/statistics/sync-settled-whd", { store_id: sid(), schema: "whd", items });
              whdSaved += Number(saved.data.updated || 0);
            }
            settleRun.value = { phase: "取 WHD 取消日期", done: Math.min(i + chunk.length, whdList.length), total: whdList.length };
          }
          groups.push({ label: "WHD 订单", ok: whdSaved, fail: whdMissing.length,
            reason: whdError || (whdMissing.length ? "「退货和取消」页没有这些单的记录（未走退货流程，多为下单即取消）" : ""),
            postings: whdMissing.slice(0, 200) });
        }

        const totalOk = fbsSaved + whdSaved;
        const totalFail = groups.reduce((sum, group) => sum + group.fail, 0);
        settleResult.value = { visible: true, ok: totalOk, fail: totalFail, groups, requested: fbsList.length + whdList.length };
        ElementPlus.ElMessage.success(`同步完成：成功 ${totalOk} 单，未取到 ${totalFail} 单`);
        // 结算日期变了，订单明细和「月度汇总」都要重算
        await load(true);
      } catch (e) {
        const res = e?.response;
        if (res?.data?.code === "WEB_SESSION_REQUIRED" || res?.status === 409) {
          cookieVisible.value = true; loadWebSession();
          ElementPlus.ElMessage.warning(res?.data?.error || "Ozon 后台会话已失效，请重新获取");
        } else {
          error.value = message(e);
          ElementPlus.ElMessage.error(message(e));
        }
      } finally { settledSyncing.value = false; settledStage.value = ""; settleRun.value = null; }
    }
    function copyFailed(rows) {
      const text = (rows || []).join("\\n");
      if (!text) return;
      navigator.clipboard?.writeText(text).then(() => ElementPlus.ElMessage.success("已复制失败订单号")).catch(() => {});
    }
    async function saveCookiePayload(payload) {
      await axios.post("/api/statistics/web-session", { store_id: sid(), ...payload });
      cookieVisible.value = false; cookieInput.value = "";
      await loadWebSession();
    }
    // 一键：插件用 cookies 权限读浏览器里已登录的 Ozon 会话
    async function cookieFromBrowser() {
      if (cookieSaving.value) return;
      cookieSaving.value = true;
      try {
        const resp = await sendToPlugin("ozonCookies.request", {}, 15000);
        if (!resp) throw new Error("没检测到采集插件（需 2.2.9.205+）：请先安装/更新插件，或手动粘贴 cookie");
        if (!resp.ok || !resp.cookie) throw new Error(resp.error || "浏览器里没有 Ozon 登录态，请先在 Chrome 登录卖家后台");
        await saveCookiePayload({ cookie: resp.cookie, host: resp.host || "", company_id: resp.company_id || "" });
        ElementPlus.ElMessage.success(`已从浏览器取到 ${resp.count || ""} 个 cookie 并校验通过`);
        await syncSettledDates();
      } catch (e) {
        ElementPlus.ElMessage.error(e?.response?.data?.error || e?.message || "获取失败");
      } finally { cookieSaving.value = false; }
    }
    async function saveCookie() {
      if (!cookieInput.value.trim()) { ElementPlus.ElMessage.warning("请先粘贴 cookie"); return; }
      cookieSaving.value = true;
      try {
        await saveCookiePayload({ cookie: cookieInput.value });
        ElementPlus.ElMessage.success("会话已保存并校验通过，开始同步…");
        await syncSettledDates();
      } catch (e) {
        ElementPlus.ElMessage.error(e?.response?.data?.error || e?.message || "cookie 校验失败");
      } finally { cookieSaving.value = false; }
    }
    // 导入模板：与页面导出 CSV 同构，但只保留可回填的列，便于原样导入。
    const TEMPLATE_HEAD = ['订单号', '订单日期', '订单状态', '订单类型', '取消原因', '采购费用（CNY，含采购运费）', '贴单费用（CNY）'];
    const TEMPLATE_MAX = 20000;
    const templateAmount = (value, label, rowNo) => {
      if (value == null || String(value).trim() === '') return null;
      const text = String(value).trim().replace(/[,，¥￥\s]/g, '');
      if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(`第 ${rowNo} 行${label}无效：${String(value).trim().slice(0, 20)}`);
      return Number(text);
    };
    // 按「结算明细」页当前的查询条件把命中的订单全部拉回来（供下载模板用），不受列表分页限制
    async function queryAllRows() {
      const params = filters(), size = 500, known = new Map();
      for (let p = 1; p <= 400; p++) {
        const base = { ...params, page: p, page_size: size };
        const result = batchNumbers.value.length
          ? await axios.post('/api/statistics/report', { ...base, posting_numbers: batchNumbers.value })
          : await axios.get('/api/statistics/report', { params: base });
        result.data.rows.forEach((row) => known.set(row.posting_number, row));
        if (p * size >= result.data.total) return known;
      }
      throw new Error('命中的订单超过 20 万单，请缩小查询范围后再下载模板');
    }
    async function downloadTemplate() {
      const scope = ctx();
      if (!scope.store_id) return;
      if (!window.XLSX) { error.value = 'Excel组件尚未加载，请刷新后重试'; return; }
      loading.value = true; error.value = '';
      try {
        const known = await queryAllRows();
        if (!sameScope(scope)) return;
        // 与导入保持同一口径：只要 7/1 之后的非 WHD 订单
        const list = [...known.values()].filter(canMaintainCosts)
          .sort((a, b) => String(a.ordered_at || '').localeCompare(String(b.ordered_at || '')) || a.posting_number.localeCompare(b.posting_number));
        if (!list.length) throw new Error('当前查询条件下没有可维护采购/贴单的订单（WHD 订单不导入）');
        const day = (value) => value ? new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 10) : '';
        const sheet = XLSX.utils.aoa_to_sheet([TEMPLATE_HEAD, ...list.map((r) => [
          r.posting_number, day(r.ordered_at), r.status, r.order_type, r.cancel_reason ?? '', r.purchase_cny ?? '', r.label_cny ?? ''])]);
        sheet['!cols'] = [{ wch: 22 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 26 }, { wch: 24 }, { wch: 16 }];
        sheet['!freeze'] = { xSplit: '0', ySplit: '1' };
        const help = XLSX.utils.aoa_to_sheet([
          ['导入说明'], [''],
          ['模板按「结算明细」页当前的查询条件导出，只含 2026-07-01 之后的非 WHD 订单，并带出已维护的采购费/贴单费。'],
          ['1. 以「订单号」为准，只覆盖「采购费用」「贴单费用」两列；其余列仅供核对，改了不会导入。'],
          ['2. 只填写需要修改的金额，留空的单元格表示保持不变（不会清零）。'],
          ['3. 采购费用 = 采购价 + 采购运费，单位人民币，最多两位小数。'],
          ['4. 贴单费用按单收取，按实际金额填写；留空表示不修改。'],
          ['5. 只导入贴单费时，采购费列可以整列留空，原有采购费不受影响。'],
          [`6. 单次最多 ${TEMPLATE_MAX} 单；保存前会弹出预览，确认后才写入，并保留修改快照可回滚。`],
          ['7. 支持 .xlsx 与 .csv；WHD 订单会被自动跳过。'],
        ]);
        help['!cols'] = [{ wch: 96 }];
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, sheet, '采购贴单费');
        XLSX.utils.book_append_sheet(book, help, '填写说明');
        XLSX.writeFile(book, `${scope.month}-采购贴单费导入模板.xlsx`);
        ElementPlus.ElMessage.success(`模板已下载：${list.length} 单`);
      } catch (e) { if (sameScope(scope)) error.value = message(e); }
      finally { loading.value = false; }
    }
    async function importCosts(event) {
      const file = event.target.files?.[0]; event.target.value = '';
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) { error.value = '文件不能超过10MB'; return; }
      if (!window.XLSX) { error.value = 'Excel读取组件尚未加载，请刷新后重试'; return; }
      const scope = ctx(); loading.value = true; error.value = '';
      try {
        const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
        const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: null });
        const headerIndex = matrix.findIndex((r) => r.some((c) => String(c ?? '').trim() === '订单号'));
        if (headerIndex < 0) throw new Error('找不到“订单号”表头，请使用「下载导入模板」生成的文件');
        const header = matrix[headerIndex].map((c) => String(c ?? '').trim());
        const idIndex = header.indexOf('订单号');
        const purchaseIndex = header.findIndex((c) => c.startsWith('采购'));
        const labelIndex = header.findIndex((c) => c.startsWith('贴单'));
        if (purchaseIndex < 0 && labelIndex < 0) throw new Error('模板需至少包含“采购费用”或“贴单费用”一列');
        const imported = [], seen = new Set();
        for (const [i, row] of matrix.slice(headerIndex + 1).entries()) {
          const rowNo = headerIndex + i + 2;
          const purchase = purchaseIndex < 0 ? null : templateAmount(row[purchaseIndex], '采购费用', rowNo);
          const label = labelIndex < 0 ? null : templateAmount(row[labelIndex], '贴单费用', rowNo);
          if (purchase === null && label === null) continue;
          const id = String(row[idIndex] ?? '').trim();
          if (!/^\d+-\d+-\d+$/.test(id)) throw new Error(`第 ${rowNo} 行订单号无效：${id || '（空）'}`);
          if (seen.has(id)) throw new Error(`订单号重复：${id}`);
          seen.add(id);
          imported.push({ posting_number: id, ...(purchase === null ? {} : { purchase_cny: purchase }), ...(label === null ? {} : { label_cny: label }) });
        }
        if (!imported.length) throw new Error('没有读到要导入的金额，请填写“采购费用”或“贴单费用”后重试');
        if (imported.length > TEMPLATE_MAX) throw new Error(`一次最多导入 ${TEMPLATE_MAX} 单，本次 ${imported.length} 单`);
        const known = await monthRows(scope);
        if (!known) return;
        for (const item of imported) if (!known.has(item.posting_number)) throw new Error(`订单不在当前店铺的订单表里：${item.posting_number}`);
        const editable = imported.filter((item) => canMaintainCosts(known.get(item.posting_number)));
        const skipped = imported.length - editable.length;
        if (skipped) ElementPlus.ElMessage.info(`已跳过 ${skipped} 单：WHD 或成本不在所选月份`);
        if (!editable.length) return;
        // 与当前值一致的订单不再写库，避免空导入制造无意义的版本和快照。
        const changed = editable.filter((item) => {
          const row = known.get(item.posting_number);
          return (Object.hasOwn(item, 'purchase_cny') && (row.purchase_cny ?? null) !== item.purchase_cny)
            || (Object.hasOwn(item, 'label_cny') && Number(row.label_cny) !== item.label_cny);
        });
        if (!changed.length) throw new Error('导入的金额与当前数据完全一致，没有需要保存的修改');
        if (!sameScope(scope)) return;
        openCosts(changed.map((item) => ({ ...known.get(item.posting_number), ...item })), 'import');
      } catch (e) { if (sameScope(scope)) error.value = message(e); }
      finally { loading.value = false; }
    }
    function openMonth(item = summary.value) {
      monthScope.value = { store_id: sid(), month: item.month || month.value };
      monthDraft.value = { month: item.month || month.value, rate_mode: item.exchange_rate_override == null ? 'default' : 'manual',
        exchange_rate: item.exchange_rate, ad_mode: item.advertising_amount != null ? 'manual' : 'api',
        advertising_amount: item.advertising_amount, advertising_currency: item.advertising_currency || 'RUB', version: item.settings_version || 0 };
      settingsError.value = ''; monthVisible.value = true;
    }
    async function saveMonth() {
      if (monthScope.value.store_id !== sid()) { settingsError.value = '店铺已切换，请重新打开'; return; }
      saving.value = true; settingsError.value = '';
      try {
        const d = monthDraft.value;
        if (d.ad_mode === 'manual' && d.advertising_amount == null) throw new Error('请填写广告费，0表示本月无广告费');
        await axios.patch('/api/statistics/month', { ...monthScope.value, version: d.version,
          exchange_rate: d.rate_mode === 'default' ? null : d.exchange_rate,
          advertising_amount: d.ad_mode === 'api' ? null : d.advertising_amount, advertising_currency: d.advertising_currency });
        monthVisible.value = false; ElementPlus.ElMessage.success('本月设置已保存'); await load();
      } catch (e) { settingsError.value = message(e); }
      finally { saving.value = false; }
    }
    async function openChanges() {
      if (!sid()) return;
      recordsVisible.value = true; recordsTab.value = 'change';
      loadChanges();
    }
    async function rollback(item) {
      const store = sid();
      try {
        await ElementPlus.ElMessageBox.confirm(`回滚“${item.reason}”？若这些数据之后又有修改，将拒绝覆盖。`, '确认回滚', { type: 'warning', confirmButtonText: '回滚', cancelButtonText: '取消' });
        if (store !== sid()) return;
        await axios.post(`/api/statistics/changes/${item.id}/rollback`, { store_id: store });
        ElementPlus.ElMessage.success('已恢复修改前的数值'); await openChanges(); await load();
      } catch (e) { if (e !== 'cancel' && e !== 'close') ElementPlus.ElMessage.error(message(e)); }
    }
    async function copyOrderNumber(posting) {
      try {
        await navigator.clipboard.writeText(posting);
        ElementPlus.ElMessage.success('订单号已复制');
      } catch {
        try {
          await ElementPlus.ElMessageBox.prompt('请选择订单号后复制', '复制订单号', { inputValue: posting, showCancelButton: false, confirmButtonText: '关闭' });
        } catch {}
      }
    }
    function currentOrder(scope, request) { return !stopped && scope.store_id === sid() && ledgerVisible.value && request === orderRequest; }
    async function showLedger(row, event, reportMonth = month.value) {
      const selection = window.getSelection?.();
      if (event?.detail && selection && !selection.isCollapsed && selection.containsNode(event.currentTarget, true)) return;
      const scope = { store_id: sid(), month: reportMonth }, request = ++orderRequest;
      ledgerOrder.value = row.posting_number; ledger.value = []; ledgerPending.value = []; ledgerError.value = ''; ledgerMonths.value = [];
      orderTab.value = 'fees'; orderRow.value = row; orderDetail.value = null; detailLoaded.value = false; detailLoading.value = false; detailError.value = '';
      ledgerVisible.value = true; ledgerLoading.value = true;
      try {
        const response = await axios.get('/api/statistics/ledger', { params: { store_id: scope.store_id, posting_number: row.posting_number } });
        if (currentOrder(scope, request)) {
          ledger.value = response.data.rows; ledgerPending.value = response.data.pending; ledgerMonths.value = response.data.months || [];
        }
      } catch (e) { if (currentOrder(scope, request)) ledgerError.value = message(e); }
      finally { if (currentOrder(scope, request)) ledgerLoading.value = false; }
    }
    async function loadOrderDetail() {
      if (orderTab.value !== 'detail' || !ledgerVisible.value || detailLoading.value || detailLoaded.value) return;
      const scope = ctx(), request = orderRequest;
      detailLoading.value = true; detailError.value = '';
      try {
        const response = await axios.get('/api/statistics/order-detail', { params: { store_id: scope.store_id, posting_number: ledgerOrder.value } });
        if (currentOrder(scope, request)) { orderDetail.value = response.data.detail; detailLoaded.value = true; }
      } catch (e) { if (currentOrder(scope, request)) detailError.value = message(e); }
      finally { if (currentOrder(scope, request)) detailLoading.value = false; }
    }
    function moveProductZoom(event) {
      if (!productZoom.value) return;
      const size = Math.max(0, Math.min(260, window.innerWidth - 32, window.innerHeight - 64));
      const width = size + 16, height = size + 42;
      const left = event.clientX + width + 20 <= window.innerWidth ? event.clientX + 12 : event.clientX - width - 12;
      productZoom.value = { ...productZoom.value, size, x: Math.min(window.innerWidth - width - 8, Math.max(8, left)),
        y: Math.min(window.innerHeight - height - 8, Math.max(8, event.clientY + 12)) };
    }
    function showProductZoom(row, event) {
      if (!row.image || event.pointerType === 'touch' || !event.currentTarget.querySelector('img')?.naturalWidth) return;
      productZoom.value = { src: row.image, title: row.name || row.offer_id || row.sku };
      moveProductZoom(event);
    }
    function hideProductZoom() { productZoom.value = null; }
    function changeOrderTab() { hideProductZoom(); loadOrderDetail(); }
    // 把导出失败的真实原因显示出来：HTTP 状态 + 后端返回的中文提示，避免一律显示同一句模糊文案
    async function exportFailureText(e) {
      const response = e?.response;
      if (!response) return `导出失败：${e?.message || '网络异常或服务器无响应'}，请稍后重试`;
      let detail = '';
      try {
        const data = response.data;
        if (data instanceof Blob) {
          const text = await data.text();
          try { const json = JSON.parse(text); detail = json.error || json.message || ''; }
          catch { detail = String(text).slice(0, 160); }
        } else if (typeof data === 'string') detail = data.slice(0, 160);
        else if (data?.error) detail = data.error;
      } catch { /* 读不出错误体就不再追问 */ }
      return `导出失败（HTTP ${response.status}）${detail ? '：' + detail : ''}`;
    }
    async function exportOrders() {
      if (!sid() || exporting.value) return;
      const scope = ctx();
      exporting.value = true; error.value = '';
      try {
        // 改用 POST：筛选条件走请求体，避免长 URL、中文与特殊字符在 query 里被截断
        const response = await axios.post('/api/statistics/export', { ...filters(), posting_numbers: batchNumbers.value.length ? batchNumbers.value : undefined }, { responseType: 'blob' });
        if (!sameScope(scope)) return;
        const blob = response.data instanceof Blob ? response.data : new Blob([response.data], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob), anchor = document.createElement('a');
        anchor.href = url; anchor.download = `${scope.month}-结算明细.csv`;
        document.body.appendChild(anchor); anchor.click(); anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) {
        console.error('[结算明细导出]', e);
        error.value = await exportFailureText(e);
      } finally { exporting.value = false; }
    }
    async function openAds() {
      const scope = ctx(); adsScope.value = scope; adsError.value = ''; adsDraft.value = []; adsExisting.value = []; adsRevision.value = ''; adsVisible.value = true;
      adsPasteVisible.value = false; adsText.value = '';
      try { const response = await axios.get('/api/statistics/advertising/days', { params: { store_id: scope.store_id } });
        if (sameScope(scope)) { adsExisting.value = response.data.days; adsRevision.value = response.data.revision; }
      } catch (e) { adsError.value = message(e); }
    }
    function adTemplate() {
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['日期', '按订单付费（₽）', '按点击付费（₽）']]), '每日广告费');
      XLSX.writeFile(book, '每日广告费导入模板.xlsx');
    }
    function adAmount(value) {
      const clean = String(value ?? '').trim().replace(/[\s₽]/g, '');
      const text = /^-?\d+,\d{1,2}$/.test(clean) ? clean.replace(',', '.') : clean.replace(/,(?=\d{3}(?:,|\.|$))/g, '');
      if (!/^-?\d+(?:\.\d{1,2})?$/.test(text) || Math.abs(Number(text)) > 1e12) throw new Error('广告费必须是明确的卢布金额，最多两位小数；无花费请填0');
      return Math.round(Number(text) * 100);
    }
    function invalidateAdsPreview() { adsDraft.value = []; adsError.value = ''; }
    function toggleAdsPaste() { adsPasteVisible.value = !adsPasteVisible.value; invalidateAdsPreview(); }
    function previewAdsText() {
      invalidateAdsPreview();
      try {
        if (adsText.value.length > 100000) throw new Error('粘贴内容过长');
        const lines = adsText.value.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const mos = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
        const days = new Map();
        for (const [index, line] of lines.entries()) {
          const [date, cpo, cpc, ...extra] = line.split(line.includes('\t') ? '\t' : ',').map((cell) => cell.trim());
          if (!index && date === '日期' && cpo?.startsWith('按订单付费') && cpc?.startsWith('按点击付费') && !extra.length) continue;
          const invalidDate = !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date;
          if (invalidDate || date >= mos || days.has(date)) throw new Error(`第 ${index + 1} 行日期无效、重复或尚未结束`);
          if (extra.length || !/^-?\d+(?:\.\d{1,2})?$/.test(cpo ?? '') || !/^-?\d+(?:\.\d{1,2})?$/.test(cpc ?? '')) throw new Error(`第 ${index + 1} 行须填写两类卢布金额，用小数点，不加千分位`);
          days.set(date, { spend_date: date, cpo_rub: adAmount(cpo)/100, cpc_rub: adAmount(cpc)/100 });
        }
        if (!days.size || days.size > 1100) throw new Error('一次导入1至1100天数据');
        adsDraft.value = [...days.values()].sort((a,b) => a.spend_date.localeCompare(b.spend_date));
      } catch (e) { adsError.value = message(e); }
    }
    function sellerExpenseDays(matrix) {
      const index = matrix.findIndex((r) => r.includes('广告活动ID') && r.includes('推广类型') && r.includes('应计日期') && r.includes('费用，₽'));
      if (index < 0) return null;
      const head = matrix[index], id = head.indexOf('广告活动ID'), type = head.indexOf('推广类型'), date = head.indexOf('应计日期'), amount = head.indexOf('费用，₽');
      const days = new Map(), types = new Set(), seen = new Set();
      for (const row of matrix.slice(index + 1)) {
        if (row.every((v) => v == null || v === '')) continue;
        const label = String(row[type] || ''), field = label.startsWith('按订单付费') ? 'cpo_rub' : label === '按点击付费' ? 'cpc_rub' : null;
        if (!field) continue;
        const day = String(row[date] || '').trim().replaceAll('.', '-'), cents = adAmount(row[amount]);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !row[id]) throw new Error('Ozon 费用报表缺少应计日期或广告活动ID');
        const key = JSON.stringify([day,row[id],label,cents]);
        if (seen.has(key)) throw new Error('Ozon 费用报表存在重复记录，请重新导出');
        seen.add(key); types.add(field);
        const value = days.get(day) || { spend_date: day, cpo_rub: 0, cpc_rub: 0 };
        value[field] += cents; days.set(day, value);
      }
      if (types.size !== 2) throw new Error('请导出未按推广类型筛选的「费用详细信息」报表，或用模板明确填入两类费用');
      return [...days.values()].sort((a,b) => a.spend_date.localeCompare(b.spend_date)).map((d) => ({ ...d, cpo_rub: d.cpo_rub / 100, cpc_rub: d.cpc_rub / 100 }));
    }
    // 导入 Ozon「按订单支付」报表：CPO / CPC 两种模式一起导，重叠日期必须与已存一致
    async function readAds(event) {
      const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
      adsPasteVisible.value = false; invalidateAdsPreview();
      try {
        if (file.size > 10 * 1024 * 1024) throw new Error('广告文件不能超过10MB');
        const book = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true, nodim: true });
        const sheet = book.Sheets[book.SheetNames[0]];
        const range = { s: {r:0,c:0}, e:{r:0,c:0} };
        // Some Seller exports declare an A1-only used range despite containing all rows.
        for (const key of Object.keys(sheet)) if (/^[A-Z]+[1-9]\d*$/.test(key)) {
          const {r,c} = XLSX.utils.decode_cell(key); range.e.r = Math.max(range.e.r,r); range.e.c = Math.max(range.e.c,c);
        }
        if (range.e.r > 50000 || range.e.c > 100) throw new Error('广告文件行列数超出导入上限');
        const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, range });
        const official = sellerExpenseDays(matrix);
        if (official) { adsDraft.value = official; return; }
        const headerIndex = matrix.findIndex((r) => r.includes('日期') && r.some((v) => String(v).startsWith('按订单付费')) && r.some((v) => String(v).startsWith('按点击付费')));
        if (headerIndex < 0) throw new Error('请先按每日广告费模板整理：日期、按订单付费（₽）、按点击付费（₽）');
        const head = matrix[headerIndex], di = head.indexOf('日期'), ci = head.findIndex((v) => String(v).startsWith('按订单付费')), pi = head.findIndex((v) => String(v).startsWith('按点击付费'));
        const seen = new Set();
        for (const [i, row] of matrix.slice(headerIndex + 1).entries()) {
          if (row.every((v) => v == null || v === '')) continue;
          const date = row[di] instanceof Date ? [row[di].getFullYear(), String(row[di].getMonth()+1).padStart(2,'0'), String(row[di].getDate()).padStart(2,'0')].join('-') : String(row[di] || '').trim();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || seen.has(date)) throw new Error(`第 ${i+headerIndex+2} 行日期无效或重复`);
          seen.add(date); adsDraft.value.push({ spend_date: date, cpo_rub: adAmount(row[ci])/100, cpc_rub: adAmount(row[pi])/100 });
        }
        if (!adsDraft.value.length || adsDraft.value.length > 1100) throw new Error('一次导入1至1100天数据');
      } catch (e) { adsDraft.value = []; adsError.value = message(e); }
    }
    async function saveAds() {
      if (!sameScope(adsScope.value)) { adsError.value = '店铺或月份已改变，请重新打开'; return; }
      const scope = adsScope.value, days = adsDraft.value, revision = adsRevision.value;
      if (!days.length || !revision || saving.value) return;
      try {
        await ElementPlus.ElMessageBox.confirm(`导入 ${days.length} 天的按订单付费及点击广告？同日期数据将覆盖，并保留可回滚快照。`, '确认导入广告费', { type: 'warning', confirmButtonText: '确认导入', cancelButtonText: '取消' });
        if (!sameScope(scope) || scope !== adsScope.value || days !== adsDraft.value || revision !== adsRevision.value) return;
        saving.value = true;
        await axios.post('/api/statistics/advertising/import', { store_id: scope.store_id, days, revision });
        adsVisible.value = false; ElementPlus.ElMessage.success('每日广告费已导入'); await load();
      } catch (e) { if (e !== 'cancel' && e !== 'close') adsError.value = message(e); }
      finally { saving.value = false; }
    }
    async function openConfig() {
      configScope.value = ctx(); configError.value = ''; configDraft.value = { ...advertising.value, client_secret: '' }; configVisible.value = true;
    }
    async function saveConfig() {
      if (!sameScope(configScope.value)) { configError.value = '店铺或月份已改变，请重新打开'; return; }
      saving.value = true;
      try { await axios.patch('/api/statistics/advertising/config', { store_id: configScope.value.store_id, ...configDraft.value });
        configDraft.value.client_secret = ''; configVisible.value = false; await load();
      } catch (e) { configError.value = message(e); } finally { saving.value = false; }
    }
    function exportMonths() {
      const header = ['月份', '分类', '订单数', '销售₽', '代扣₽', '推广费用₽', '实收₽', '实收¥', '采购¥', '贴单¥', '毛利¥', '毛利率%', '采购未录入单数', '贴单未录入单数'];
      const cells = [header, ...monthly.value.flatMap((r) => [r, ...(r.children || [])]).map((r) => [
        r.month, r.is_group ? r.label : '合计', r.orders, r.income_rub, r.ozon_fees_rub, r.advertising_rub,
        r.receipt_rub, r.receipt_cny, r.purchase_cny, r.label_cny, r.profit_cny, r.margin_pct, r.missing_purchase, r.missing_label])];
      const csv = cells.map((r) => r.map((v) => `"${String(v ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = '月度汇总.csv'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function disabledMonth(date) { const current = Number(today().slice(0, 4)) * 12 + Number(today().slice(5, 7)) - 1; const value = date.getFullYear() * 12 + date.getMonth(); return value > current || value < current - 36; }
    function shopChanged() {
      generation++; rows.value = []; monthly.value = []; summary.value = {}; run.value = null; selected.value = [];
      costVisible.value = false; monthVisible.value = false; recordsVisible.value = false; ledgerVisible.value = false;
      exceptionVisible.value = false;
      adsVisible.value = false; configVisible.value = false; configDraft.value = {}; advertising.value = {}; rules.value = []; appliedRules.value = [];
      batchNumbers.value = []; batchVisible.value = false; batchText.value = '';
      stopOrderSyncPoll(); orderSyncProgress.value = null;
      table.value?.clearSelection(); page.value = 1; load();
    }
    watch(month, () => { ledgerVisible.value = false; if (!month.value) return; loadSummary(); });
    // 月份选择器只改顶部统计；切回订单明细时，若月份变过才跟着重载
    watch(tab, (value) => { if (value === 'orders' && tableMonth.value !== month.value) applyFilter(); });
    watch(monthRange, () => { if (monthRange.value?.length === 2) load(); });
    onMounted(() => {
      // 不做定时轮询，进页面、切月份、同步完成后各拉一次
      window.addEventListener('shop-changed', shopChanged);
      window.addEventListener('message', onSettleProgress);
      load();
    });
    onBeforeUnmount(() => { stopped = true; generation++; clearInterval(poll); stopOrderSyncPoll(); window.removeEventListener('shop-changed', shopChanged); window.removeEventListener('message', onSettleProgress); });
    return { tab, month, monthRange, loading, saving, syncing, orderSyncing, orderSyncRange, orderSyncProgress, orderLogLoading, orderLogs, orderLogLast, syncOrdersNow, loadOrderLogs, recordsVisible, recordsTab, openRecords, recordsTabChanged, exporting, error, rows, monthly, summary, run, total, page, pageSize, search, status, orderType, missingOnly, unsettledOnly,
      settledSyncing, settledStage, settleRun, settleResult, settlePercent, settleProgressText, copyFailed, onSettleProgress, cookieVisible, cookieSaving, cookieInput, webSession, syncSettledDates, cookieFromBrowser, saveCookie, loadWebSession,
      orderDateRange, settleDateRange,
      selected, table, costVisible, drafts, fillAmount, labelFillAmount, costError, uploadInput, monthVisible, monthDraft, settingsError, changes, changesLoading,
      ledgerVisible, ledgerLoading, ledger, ledgerPending, ledgerOrder, ledgerMonths, activeRun, progress, money, dateTime, titleProfit, monthlyProfit, monthlyProfitEstimated, monthlyProfitNote, sortMonthlyProfit, monthlyReceipt, feeName, disabledMonth, costPage, costPageRows,
      ledgerError, orderTab, orderRow, orderDetail, detailLoading, detailLoaded, detailError, orderQuantity, copyOrderNumber, loadOrderDetail,
      exceptionScope, exceptionVisible, exceptionLoading, exceptionError, exceptionPage, exceptions, monthlyIssues, openExceptions, loadExceptions, exceptionReason,
      productZoom, showProductZoom, moveProductZoom, hideProductZoom, changeOrderTab,
      fieldCatalog, rules, filterVisible, appliedRules, advertising, fieldType, operators, resetRule, addRule, queryRules, resetFilters, adStatus,
      batchNumbers, batchVisible, batchText, batchError, openBatch, applyBatch, clearBatch,
      adsVisible, adsError, adsInput, adsDraft, adsExisting, adsRevision, adsPasteVisible, adsText, adsTotals, openAds, adTemplate, readAds, saveAds, toggleAdsPaste, previewAdsText, invalidateAdsPreview, configVisible, configDraft, configError, openConfig, saveConfig,
      load, applyFilter, sortChanged, sortCosts, syncNow, canMaintainCosts, openCosts, fillCosts, fillLabels, saveCosts, importCosts, downloadTemplate, openMonth, saveMonth, openChanges, rollback, showLedger, exportOrders, exportMonths };
  },
  template: `
  <section class="statistics-workbench">
    <header class="statistics-heading">
      <div><div class="statistics-title-row"><h2>月结统计</h2><el-date-picker v-model="month" type="month" value-format="YYYY-MM" format="YYYY 年 MM 月" :clearable="false" :disabled-date="disabledMonth" aria-label="应计月份" style="width:170px"/></div><div class="statistics-meta">每日 02:00 / 09:30（北京时间）自动更新 <span v-if="summary.coverage?.last_updated_at">· 财务更新 {{dateTime(summary.coverage.last_updated_at)}}</span><span v-if="summary.coverage?.as_of_date"> · 应计核对至 {{summary.coverage.as_of_date}}</span><span> · 每日广告（莫斯科）{{advertising.configured?'Performance':'日报导入'}}</span><span v-if="summary.missing_advertising" class="statistics-warning"> · {{summary.missing_advertising}} 单待核对</span><span v-if="advertising.last_error" class="statistics-warning"> · {{advertising.last_error}}</span></div></div>
      <div class="statistics-actions">
        <span class="statistics-range-label">同步区间</span>
        <el-date-picker v-model="orderSyncRange" type="daterange" value-format="YYYY-MM-DD" format="MM-DD" range-separator="至"
          start-placeholder="开始" end-placeholder="结束" :clearable="false" unlink-panels aria-label="订单同步区间" style="width:230px"/>
        <el-tooltip content="普通订单读 ERP 订单表，WHD 订单仍从 Ozon 拉取，更新状态与结算日期"><el-button :icon="'RefreshRight'" circle :loading="orderSyncing" aria-label="同步订单" @click="syncOrdersNow"/></el-tooltip>
        <el-tooltip content="订单表同步记录与修改记录"><el-button :icon="'Document'" circle aria-label="记录" @click="openRecords()"/></el-tooltip>
      </div>
    </header>
    <div v-if="orderSyncProgress" class="statistics-sync-progress">
      <el-progress :percentage="orderSyncProgress.progress" :stroke-width="16" striped striped-flow
        :status="orderSyncProgress.progress >= 100 ? 'success' : ''" style="width:340px"/>
      <span class="statistics-sync-phase">{{orderSyncProgress.phase}}</span>
      <span class="statistics-meta">已拉取 <b>{{orderSyncProgress.fetched}}</b> 单 · 更新 <b>{{orderSyncProgress.changed}}</b> 单</span>
    </div>
    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="statistics-alert"/>
    <el-alert v-if="run?.status === 'failed'" :title="'更新未完成：' + run.error" type="error" show-icon :closable="false" class="statistics-alert"/>
    <div class="statistics-metrics statistics-metrics-6">
      <div><span>本月结算订单</span><strong>{{summary.settled_orders ?? '—'}}<small>单</small></strong><small>正常签收 {{summary.settled_delivered || 0}} · 已取消 {{summary.settled_cancelled || 0}} · WHD {{summary.settled_whd_orders || 0}}<span v-if="summary.settled_other"> · 其他 {{summary.settled_other}}</span></small></div>
      <div><span>销售收入 <small>RUB</small></span><strong>{{summary.settled_orders ? money(summary.settled_income_rub) : '—'}}</strong><small>结算日期在本月的订单</small></div>
      <div><span>代扣 <small>RUB</small></span><strong>{{summary.settled_orders ? money(summary.settled_fees_rub) : '—'}}</strong><small>同上，含主单级费用</small></div>
      <div><span>推广 <small>RUB</small></span><strong>{{money(summary.settled_ad_rub)}}</strong><small>本月结算订单上的全部广告</small></div>
      <div><span>采购 / 贴单 <small>CNY</small></span><strong>{{money(summary.settled_cost_cny)}}</strong>
        <small>采购 {{money(summary.settled_purchase_cny)}} · {{summary.settled_purchase_missing || 0}} 单未录入</small>
        <small>贴单 {{money(summary.settled_label_cny)}} · {{summary.settled_label_missing || 0}} 单未录入</small></div>
      <div><span>毛利 <small>CNY</small></span><strong>{{money(summary.settled_profit_cny)}}<small v-if="summary.settled_margin_pct != null"> · {{summary.settled_margin_pct}}%</small></strong>
        <small>毛利率 = 毛利 ÷ 销售</small>
        <small v-if="summary.settled_incomplete" class="statistics-warning">{{summary.settled_incomplete}} 单还未能完全结算</small></div>
    </div>
    <el-tabs v-model="tab">
      <el-tab-pane label="结算明细" name="orders">
        <div class="statistics-toolbar">
          <div class="statistics-filters">
            <el-date-picker v-model="orderDateRange" type="daterange" value-format="YYYY-MM-DD" format="MM-DD" unlink-panels clearable
              start-placeholder="下单起" end-placeholder="下单止" @change="applyFilter" style="width:225px"/>
            <el-date-picker v-model="settleDateRange" type="daterange" value-format="YYYY-MM-DD" format="MM-DD" unlink-panels clearable
              start-placeholder="结算起" end-placeholder="结算止" @change="applyFilter" style="width:225px"/>
            <el-input v-model="search" placeholder="订单号" clearable @keyup.enter="applyFilter" @clear="applyFilter" style="width:165px"><template #prefix><el-icon><Search/></el-icon></template></el-input>
            <el-select v-model="status" placeholder="全部状态" clearable @change="applyFilter" style="width:122px"><el-option label="已签收" value="delivered"/><el-option label="已取消" value="cancelled"/></el-select>
            <el-select v-model="orderType" placeholder="全部类型" clearable @change="applyFilter" style="width:138px"><el-option label="正常销售订单" value="正常销售订单"/><el-option label="WHD订单" value="WHD订单"/><el-option label="主单级费用" value="主单级费用"/></el-select>
            <el-checkbox v-model="missingOnly" @change="applyFilter">缺采购</el-checkbox><el-checkbox v-model="unsettledOnly" @change="applyFilter">未结算</el-checkbox>
            <el-button :icon="'Search'" @click="applyFilter">查询</el-button>
            <el-button :icon="'Filter'" :type="appliedRules.length?'primary':'default'" plain @click="filterVisible=!filterVisible">筛选 {{appliedRules.length||''}}</el-button>
            <el-tooltip :content="exporting?'正在生成 CSV…':'导出当前筛选的全部订单'"><el-button :icon="'Download'" circle :loading="exporting" aria-label="导出订单CSV" @click="exportOrders"/></el-tooltip>
            <el-button :icon="'EditPen'" :disabled="!selected.length" @click="openCosts()">批量维护 ({{selected.length}})</el-button>
            <el-button :icon="'Upload'" @click="uploadInput.click()">导入采购</el-button>
            <el-tooltip content="下载非 WHD 订单的采购/贴单费模板"><el-button :icon="'Document'" circle aria-label="下载导入模板" @click="downloadTemplate"/></el-tooltip>
            <el-tooltip :content="settledSyncing ? (settledStage || '同步中…') : '同步结算日期（补齐已取消订单的取消日期）'"><el-button :icon="'Calendar'" circle :loading="settledSyncing" aria-label="同步结算日期" @click="syncSettledDates"/></el-tooltip>
            <input ref="uploadInput" type="file" accept=".csv,.xlsx,.xls" hidden @change="importCosts"/>
          </div>
        </div>
        <div v-if="settleRun" class="statistics-actions" style="margin-top:8px">
          <el-progress v-if="settleRun.total" :percentage="settlePercent()" :stroke-width="14" striped striped-flow style="width:320px"/>
          <el-progress v-else :percentage="100" :show-text="false" :stroke-width="14" striped striped-flow :duration="3" style="width:320px"/>
          <span class="statistics-meta">{{settleProgressText()}}</span>
        </div>
        <div v-if="batchNumbers.length" class="statistics-actions">
          <span class="statistics-meta">已筛选 {{batchNumbers.length}} 个订单号<span v-if="!loading && !error">，匹配 {{total}} 单</span></span>
          <el-button link type="primary" @click="clearBatch">清除批量筛选</el-button>
        </div>
        <div v-if="filterVisible" class="statistics-rule-panel">
          <div class="statistics-actions" style="margin-bottom:8px">
            <el-button :icon="'Filter'" :type="batchNumbers.length?'primary':'default'" plain @click="openBatch">批量订单号{{batchNumbers.length?' ('+batchNumbers.length+')':''}}</el-button>
            <span class="statistics-meta">粘贴多个完整订单号做批量筛选，与下方条件是「同时满足」</span>
          </div>
          <div v-for="(rule,index) in rules" :key="index" class="statistics-rule">
            <el-select v-model="rule.field" aria-label="筛选字段" @change="resetRule(rule)"><el-option v-for="field in fieldCatalog" :key="field.key" :label="field.label" :value="field.key"/></el-select>
            <el-select v-model="rule.op" aria-label="比较条件"><el-option v-for="op in operators(rule)" :key="op.value" :label="op.label" :value="op.value"/></el-select>
            <template v-if="!['empty','not_empty'].includes(rule.op)">
              <el-date-picker v-if="fieldType(rule)==='date'" v-model="rule.value" type="date" value-format="YYYY-MM-DD" placeholder="日期" aria-label="筛选日期"/>
              <el-input-number v-else-if="fieldType(rule)==='number'" v-model="rule.value" :controls="false" aria-label="筛选数值"/>
              <el-input v-else v-model="rule.value" placeholder="筛选内容" aria-label="筛选内容"/>
              <template v-if="rule.op==='between'"><span>至</span><el-date-picker v-if="fieldType(rule)==='date'" v-model="rule.value2" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" aria-label="结束日期"/><el-input-number v-else v-model="rule.value2" :controls="false" aria-label="区间上限"/></template>
            </template>
            <el-tooltip content="移除此条件"><el-button :icon="'Delete'" circle aria-label="移除筛选条件" @click="rules.splice(index,1)"/></el-tooltip>
          </div>
          <div class="statistics-actions"><el-button :icon="'Plus'" :disabled="rules.length>=30" @click="addRule">条件</el-button><el-button :icon="'Search'" type="primary" @click="queryRules">应用筛选</el-button><el-tooltip content="清空全部筛选"><el-button :icon="'RefreshLeft'" circle aria-label="清空筛选" @click="resetFilters"/></el-tooltip><span class="statistics-meta">同时满足全部条件</span></div>
        </div>
        <div class="statistics-data-note" v-if="summary.coverage && !summary.coverage.complete">应计数据未完整同步：本月 {{summary.coverage.checked_days}} / {{summary.coverage.expected_days}} 天。毛利暂不结算。</div>
        <el-table ref="table" :data="rows" v-loading="loading" row-key="posting_number" border stripe max-height="calc(100vh - 400px)" @selection-change="selected=$event" @sort-change="sortChanged" empty-text="所选月份暂无应计订单" class="statistics-orders">
          <el-table-column type="selection" width="40" :reserve-selection="true" :selectable="canMaintainCosts"/>
          <el-table-column prop="posting_number" label="订单号" width="190" fixed="left" sortable="custom">
            <template #default="{row}"><div class="statistics-posting">
              <el-button type="primary" link @click="showLedger(row, $event)"><span class="statistics-posting-text">{{row.posting_number}}</span></el-button>
              <el-tooltip content="复制订单号"><el-button :icon="'CopyDocument'" circle text size="small" :aria-label="'复制订单号 '+row.posting_number" @click.stop="copyOrderNumber(row.posting_number)"/></el-tooltip>
            </div></template>
          </el-table-column>
          <el-table-column prop="status" label="状态" width="76" sortable="custom"/>
          <el-table-column prop="ordered_at" label="下单日期" width="92" sortable="custom"><template #default="{row}">{{row.loose_month ? (row.accrual_date || '—') : dateTime(row.ordered_at).slice(0,10)}}</template></el-table-column>
          <el-table-column prop="order_settled_date" label="结算日期" width="102" sortable="custom"><template #default="{row}">{{row.order_settled_date || '—'}}</template></el-table-column>
          <el-table-column prop="receipt_cny" label="实收 ¥" width="88" align="right" sortable="custom"><template #default="{row}">{{money(row.receipt_cny)}}<div v-if="row.receipt_cny!=null && !row.loose_month && (row.pending_positive || row.pending_negative || row.advertising_rub==null)" class="statistics-cell-note">按已归属</div></template></el-table-column>
          <el-table-column prop="purchase_cny" label="采购费 ¥" width="92" align="right" sortable="custom"><template #default="{row}"><el-button v-if="canMaintainCosts(row)" link :type="row.purchase_cny==null?'warning':'primary'" @click="openCosts([row])">{{row.purchase_cny==null?'待录入':money(row.purchase_cny)}}</el-button><span v-else>{{money(row.purchase_cny)}}</span><div v-if="row.cost_in_month===false && row.order_type!=='WHD订单' && !row.loose_month" class="statistics-cell-note">{{row.cost_month ? row.cost_month+' 计入' : '待正式入账'}}</div></template></el-table-column>
          <el-table-column prop="label_cny" label="贴单费 ¥" width="84" align="right" sortable="custom"><template #default="{row}"><el-button v-if="canMaintainCosts(row)" link type="primary" @click="openCosts([row])">{{money(row.label_cny)}}</el-button><span v-else>{{money(row.label_cny)}}</span></template></el-table-column>
          <el-table-column prop="profit_cny" label="毛利 ¥" width="92" align="right" sortable="custom"><template #default="{row}"><el-tooltip :content="row.loose_month?'主单级费用：只有主单号，不计采购与贴单费':row.order_type==='WHD订单'?'WHD 由 Ozon 仓发货，不计采购与贴单费':row.allocated_ad_rub==null?adStatus(row):row.purchase_cny==null?'采购费待补充':row.pending_negative||row.pending_positive?'收支待分摊':'实收人民币减采购及贴单费'"><span :class="{'statistics-negative':row.profit_cny<0}">{{money(row.profit_cny)}}</span></el-tooltip><div class="statistics-cell-note">{{row.loose_month?'':(row.margin_pct==null?'—':money(row.margin_pct)+'%')}}</div></template></el-table-column>
          <el-table-column prop="income_rub" label="销售收入 ₽" width="104" align="right" sortable="custom"><template #default="{row}"><span :class="{'statistics-warning':row.low_income}">{{money(row.income_rub)}}</span><el-tooltip v-if="row.pending_income ?? row.pending_positive" content="仅含已明确归属部分，另有收入待分摊"><el-icon class="statistics-warning"><Warning/></el-icon></el-tooltip></template></el-table-column>
          <el-table-column prop="ozon_fees_rub" label="代扣 ₽" width="88" align="right" sortable="custom"><template #default="{row}">{{money(row.ozon_fees_rub)}}<el-tooltip v-if="row.pending_negative" content="仅含已明确归属部分，另有费用待分摊"><el-icon class="statistics-warning"><Warning/></el-icon></el-tooltip></template></el-table-column>
          <el-table-column prop="advertising_cpo_rub" label="推广-订单 ₽" width="112" align="right" sortable="custom"><template #default="{row}"><span v-if="row.advertising_cpo_rub==null" :class="row.no_accrual?'statistics-meta':'statistics-warning'">{{(row.no_accrual||row.loose_month)?'—':'待核对'}}</span><span v-else>{{money(row.advertising_cpo_rub)}}</span></template></el-table-column>
          <el-table-column prop="advertising_cpc_rub" label="推广-点击 ₽" width="112" align="right" sortable="custom"><template #default="{row}"><span v-if="row.advertising_cpc_rub==null" :class="row.no_accrual?'statistics-meta':'statistics-warning'">{{(row.no_accrual||row.loose_month)?'—':'待核对'}}</span><span v-else>{{money(row.advertising_cpc_rub)}}</span></template></el-table-column>
          <el-table-column prop="allocated_ad_rub" label="点击广告分摊 ₽" width="140" align="right" sortable="custom"><template #default="{row}"><el-tooltip :content="adStatus(row)+(row.allocation_order_count?' · '+row.allocation_date+' / '+row.allocation_order_count+' 单':'')"><span :class="{'statistics-warning':row.allocated_ad_rub==null&&!row.no_accrual&&!row.loose_month,'statistics-meta':row.no_accrual}">{{row.allocated_ad_rub==null?((row.no_accrual||row.loose_month)?'—':'待核对'):money(row.allocated_ad_rub)}}</span></el-tooltip></template></el-table-column>
          <el-table-column prop="receipt_rub" label="实收 ₽" width="88" align="right" sortable="custom"><template #default="{row}">{{money(row.receipt_rub)}}</template></el-table-column>
          <el-table-column prop="cancel_reason" label="取消原因" min-width="160" show-overflow-tooltip sortable="custom"/>
          <el-table-column prop="order_type" label="订单类型" width="92" sortable="custom"/>
        </el-table>
        <div class="statistics-footer"><span>共 {{total}} 单 · 采购费含采购运费 · 贴单费按实际录入</span><el-pagination v-model:current-page="page" v-model:page-size="pageSize" :total="total" :page-sizes="[50,100,200,500]" layout="total, sizes, prev, pager, next" @current-change="load(false)" @size-change="applyFilter"/></div>
      </el-tab-pane>
      <el-tab-pane label="月度汇总" name="months">
        <div class="statistics-toolbar"><div class="statistics-filters"><el-date-picker v-model="monthRange" type="monthrange" value-format="YYYY-MM" format="YYYY-MM" start-placeholder="开始月份" end-placeholder="结束月份" :clearable="false" :disabled-date="disabledMonth" style="width:300px"/></div><div class="statistics-actions"><el-button :icon="'Setting'" @click="openMonth()">{{month}} 月度设置</el-button><el-tooltip content="导出月度汇总CSV"><el-button :icon="'Download'" circle aria-label="导出月度汇总" @click="exportMonths"/></el-tooltip></div></div>
        <el-table :data="monthly" row-key="id" default-expand-all :tree-props="{children:'children'}" :row-class-name="({row})=>row.is_group?'statistics-month-child':'statistics-month-total'" border v-loading="loading" max-height="calc(100vh - 380px)" empty-text="暂无月份数据">
          <el-table-column prop="label" label="月份" min-width="150" fixed="left" sortable><template #default="{row}">{{row.label}}<div class="statistics-cell-note" v-if="row.pending_orders">{{row.pending_orders}} 单在途，未拆组</div></template></el-table-column>
          <el-table-column prop="orders" label="订单数" width="92" align="right" sortable><template #default="{row}">{{row.group === 'other' && !row.orders ? (row.flows || 0) + ' 笔' : row.orders}}</template></el-table-column>
          <el-table-column prop="income_rub" label="销售 ₽" min-width="112" align="right" sortable><template #default="{row}">{{money(row.income_rub)}}</template></el-table-column>
          <el-table-column prop="ozon_fees_rub" label="代扣 ₽" min-width="108" align="right" sortable><template #default="{row}">{{money(row.ozon_fees_rub)}}</template></el-table-column>
          <el-table-column prop="advertising_rub" label="推广费用 ₽" min-width="120" align="right" sortable><template #default="{row}">{{money(row.advertising_rub)}}</template></el-table-column>
          <el-table-column prop="receipt_rub" label="实收 ₽" min-width="112" align="right" sortable><template #default="{row}">{{money(row.receipt_rub)}}</template></el-table-column>
          <el-table-column prop="receipt_cny" label="实收 ¥" min-width="104" align="right" sortable><template #default="{row}">{{money(row.receipt_cny)}}</template></el-table-column>
          <el-table-column prop="purchase_cny" label="采购 ¥" min-width="108" align="right" sortable><template #default="{row}">{{money(row.purchase_cny)}}<div class="statistics-cell-note statistics-warning" v-if="row.missing_purchase">{{row.missing_purchase}} 单未录入</div></template></el-table-column>
          <el-table-column prop="label_cny" label="贴单 ¥" min-width="100" align="right" sortable><template #default="{row}">{{money(row.label_cny)}}<div class="statistics-cell-note statistics-warning" v-if="row.missing_label">{{row.missing_label}} 单未录入</div></template></el-table-column>
          <el-table-column prop="profit_cny" label="毛利 ¥" min-width="112" align="right" sortable><template #default="{row}"><b :class="{'statistics-negative':row.profit_cny<0}">{{money(row.profit_cny)}}</b></template></el-table-column>
          <el-table-column prop="margin_pct" label="毛利率" min-width="92" align="right" sortable><template #default="{row}">{{row.margin_pct==null?'—':money(row.margin_pct)+'%'}}</template></el-table-column>
        </el-table>
        <div class="statistics-footer"><span>按结算日期整单归月 · 实收 ₽ = 销售 − 代扣 − 推广费用 · 毛利 ¥ = 实收 ¥ − 采购 − 贴单（未录入按 0 计并提示单数）· 毛利率 = 毛利 ÷ 销售 ¥</span></div>
      </el-tab-pane>
    </el-tabs>
    <el-dialog v-model="recordsVisible" title="同步记录与修改记录" width="940px" top="6vh" class="statistics-dialog">
      <el-tabs v-model="recordsTab" @tab-change="recordsTabChanged">
        <el-tab-pane label="订单表同步" name="order">
          <div class="statistics-meta" style="margin-bottom:10px">每 30 分钟自动同步一次：普通订单按顶部「同步区间」从 ERP 订单表读取，WHD 订单仍从 Ozon 拉取，把最新的状态与结算日期落进统计订单表。<span v-if="orderLogLast"> · 最近成功 {{orderLogLast}}</span></div>
          <el-table :data="orderLogs" border size="small" max-height="420" v-loading="orderLogLoading" empty-text="还没有同步记录">
            <el-table-column prop="started_at" label="开始时间" width="126"/>
            <el-table-column prop="finished_at" label="完成时间" width="126"/>
            <el-table-column label="方式" width="70">
              <template #default="{row}">{{row.trigger === 'auto' ? '自动' : '手动'}}</template>
            </el-table-column>
            <el-table-column label="同步区间" width="180">
              <template #default="{row}">
                <span v-if="row.range_from">{{row.range_from.slice(5)}} ~ {{row.range_to.slice(5)}}</span>
                <span v-else class="statistics-meta">最近一周</span>
              </template>
            </el-table-column>
            <el-table-column label="读取订单" width="88" align="right">
              <template #default="{row}">{{row.fetched || 0}}</template>
            </el-table-column>
            <el-table-column label="更新订单" width="88" align="right">
              <template #default="{row}">{{row.changed || 0}}</template>
            </el-table-column>
            <el-table-column label="结果" width="78">
              <template #default="{row}">
                <el-tag size="small" :type="row.status === 'succeeded' ? 'success' : row.status === 'failed' ? 'danger' : 'info'">
                  {{row.status === 'succeeded' ? '成功' : row.status === 'failed' ? '失败' : '进行中'}}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="message" label="说明" min-width="190" show-overflow-tooltip/>
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="修改记录" name="change">
          <div class="statistics-meta" style="margin-bottom:10px">按月导出的采购 / 贴单费维护与回滚都记在这里，回滚会校验数据是否又被改过。</div>
          <el-table :data="changes" border v-loading="changesLoading" max-height="420" empty-text="还没有修改记录">
            <el-table-column prop="created_at" label="修改时间" min-width="170" sortable>
              <template #default="{row}">{{dateTime(row.created_at)}}</template>
            </el-table-column>
            <el-table-column prop="month" label="月份" width="100" sortable/>
            <el-table-column prop="reason" label="修改内容" min-width="220" show-overflow-tooltip sortable/>
            <el-table-column prop="affected" label="条数" width="72" sortable/>
            <el-table-column label="状态" width="92">
              <template #default="{row}">{{row.rolled_back_at?'已回滚':row.kind==='rollback'?'回滚记录':'已保存'}}</template>
            </el-table-column>
            <el-table-column label="操作" width="72">
              <template #default="{row}">
                <el-tooltip content="恢复修改前的数值"><el-button v-if="!row.rolled_back_at && row.kind!=='rollback'" :icon="'RefreshLeft'" circle size="small" aria-label="回滚修改" @click="rollback(row)"/></el-tooltip>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </el-dialog>

    <el-dialog v-model="batchVisible" title="批量订单号" width="540px" class="statistics-dialog" :close-on-click-modal="false">
      <el-input v-model="batchText" type="textarea" :rows="8" aria-label="订单号列表" placeholder="粘贴 Excel 的订单号列，或用换行、逗号分隔" @input="batchError=''"/>
      <el-alert v-if="batchError" :title="batchError" type="error" :closable="false" class="statistics-alert"/>
      <template #footer>
        <el-button @click="batchVisible=false">取消</el-button>
        <el-button type="primary" @click="applyBatch">应用筛选</el-button>
      </template>
    </el-dialog>
    <el-dialog v-model="costVisible" title="维护采购费 / 贴单费" width="850px" class="statistics-dialog" :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving" :before-close="done=>!saving&&done()">
      <div class="statistics-toolbar"><span>{{drafts.length}} 单 · 采购费用含采购运费（CNY）· 贴单费按单（CNY）</span><div class="statistics-actions"><el-input-number v-model="fillAmount" :min="0" :max="100000000" :precision="2" :controls="false" placeholder="统一采购费"/><el-button @click="fillCosts" :disabled="fillAmount==null">填充采购费</el-button><el-input-number v-model="labelFillAmount" :min="0" :max="100000000" :precision="2" :controls="false" placeholder="统一贴单费"/><el-button @click="fillLabels" :disabled="labelFillAmount==null">填充贴单费</el-button></div></div>
      <el-alert v-if="costError" :title="costError" type="error" :closable="false" class="statistics-alert"/>
      <el-table :data="costPageRows" border max-height="420" row-key="posting_number" @sort-change="sortCosts"><el-table-column prop="posting_number" label="订单号" min-width="210" sortable="custom"/><el-table-column prop="purchase_cny" label="采购费用 ¥" min-width="180" sortable="custom"><template #default="{row}"><el-input-number v-model="row.purchase_cny" :min="0" :max="100000000" :precision="2" :controls="false" placeholder="未维护"/></template></el-table-column><el-table-column prop="label_cny" label="贴单费用 ¥" min-width="170" sortable="custom"><template #default="{row}"><el-input-number v-model="row.label_cny" :min="0" :max="100000000" :precision="2" :controls="false"/></template></el-table-column></el-table>
      <el-pagination v-if="drafts.length>50" v-model:current-page="costPage" :page-size="50" :total="drafts.length" layout="total, prev, pager, next" style="margin-top:12px"/>
      <template #footer><el-button @click="costVisible=false" :disabled="saving">取消</el-button><el-button type="primary" :icon="'Check'" :loading="saving" @click="saveCosts">保存 {{drafts.length}} 单</el-button></template>
    </el-dialog>
    <el-dialog v-model="adsVisible" title="每日广告费 · Europe/Moscow" width="790px" class="statistics-dialog" :close-on-click-modal="false" :show-close="!saving" :before-close="done=>!saving&&done()">
      <el-alert v-if="adsError" :title="adsError" type="error" :closable="false" class="statistics-alert"/>
      <div class="statistics-toolbar"><span>已录入 {{adsExisting.length}} 天 · 本次 {{adsDraft.length}} 天</span><div class="statistics-actions"><el-button :icon="'Upload'" :disabled="!adsRevision || saving" @click="adsInput.click()">选择费用报表</el-button><el-button :icon="'EditPen'" :type="adsPasteVisible?'primary':'default'" plain :aria-pressed="adsPasteVisible" :disabled="!adsRevision || saving" @click="toggleAdsPaste">粘贴日报</el-button><el-tooltip content="下载每日广告费模板"><el-button :icon="'Document'" circle aria-label="下载广告费模板" @click="adTemplate"/></el-tooltip><input ref="adsInput" type="file" accept=".xlsx,.csv" hidden @change="readAds"/></div></div>
      <template v-if="adsPasteVisible">
        <el-input v-model="adsText" type="textarea" :rows="4" :disabled="saving" aria-label="广告日报文本" placeholder="日期,按订单付费（₽）,按点击付费（₽）" @input="invalidateAdsPreview"/>
        <div class="statistics-toolbar"><div class="statistics-cell-note" v-if="adsDraft.length">按订单付费 ₽{{money(adsTotals.cpo/100)}} · 按点击付费 ₽{{money(adsTotals.cpc/100)}}</div><el-button :icon="'View'" :disabled="!adsText.trim() || saving" @click="previewAdsText">预览日报</el-button></div>
      </template>
      <el-table :data="adsDraft.length?adsDraft:adsExisting" border max-height="390" empty-text="暂无已确认广告日报">
        <el-table-column prop="spend_date" label="日期" width="140" sortable/>
        <el-table-column prop="cpo_rub" label="按订单付费 ₽" min-width="170" sortable align="right"><template #default="{row}">{{money(row.cpo_rub)}}</template></el-table-column>
        <el-table-column prop="cpc_rub" label="按点击付费 ₽" min-width="170" sortable align="right"><template #default="{row}">{{money(row.cpc_rub)}}</template></el-table-column>
        <el-table-column label="合计 ₽" min-width="150" align="right"><template #default="{row}">{{money(Number(row.cpo_rub)+Number(row.cpc_rub))}}</template></el-table-column>
      </el-table>
      <template #footer><el-button @click="adsVisible=false" :disabled="saving">关闭</el-button><el-button :icon="'Check'" type="primary" :disabled="!adsDraft.length||!adsRevision" :loading="saving" @click="saveAds">确认导入 {{adsDraft.length}} 天</el-button></template>
    </el-dialog>
    <el-dialog v-model="configVisible" title="Performance API 授权（可选）" width="530px" class="statistics-dialog" :close-on-click-modal="false" @closed="configDraft.client_secret=''">
      <el-alert v-if="configError" :title="configError" type="error" :closable="false" class="statistics-alert"/>
      <el-form label-position="top"><el-form-item label="Client ID"><el-input v-model="configDraft.client_id" autocomplete="off"/></el-form-item><el-form-item label="Client Secret"><el-input v-model="configDraft.client_secret" type="password" show-password autocomplete="new-password" :placeholder="advertising.configured?'已保存；留空保留原密钥':'Performance Client Secret'"/></el-form-item><el-form-item label="广告时区"><el-select v-model="configDraft.business_timezone"><el-option label="莫斯科（Europe/Moscow）" value="Europe/Moscow"/></el-select></el-form-item></el-form>
      <template #footer><el-button @click="configVisible=false" :disabled="saving">取消</el-button><el-button type="primary" :loading="saving" @click="saveConfig">保存授权</el-button></template>
    </el-dialog>
    <el-dialog v-model="monthVisible" :title="monthDraft.month+' 月度汇率'" width="540px" class="statistics-dialog" :close-on-click-modal="false">
      <el-alert v-if="settingsError" :title="settingsError" type="error" :closable="false" class="statistics-alert"/>
      <el-form label-position="top"><el-form-item label="汇率（1 RUB 对应 CNY）"><el-radio-group v-model="monthDraft.rate_mode"><el-radio-button value="default">默认汇率</el-radio-button><el-radio-button value="manual">本月汇率</el-radio-button></el-radio-group><el-input-number v-if="monthDraft.rate_mode==='manual'" v-model="monthDraft.exchange_rate" :min="0.000001" :max="1" :precision="6" :step="0.001" style="margin-top:10px;width:100%"/></el-form-item>
      </el-form>
      <template #footer><el-button @click="monthVisible=false" :disabled="saving">取消</el-button><el-button type="primary" :loading="saving" @click="saveMonth">保存</el-button></template>
    </el-dialog>
    <el-dialog v-model="exceptionVisible" :title="exceptionScope?.title" width="980px" class="statistics-dialog">
      <el-alert v-if="exceptionError" :title="exceptionError" type="error" :closable="false" class="statistics-alert"/>
      <el-table v-else-if="exceptionScope?.kind==='unresolved'" :data="exceptions.rows" v-loading="exceptionLoading" border max-height="450" empty-text="没有未匹配流水">
        <el-table-column prop="date" label="应计日期" width="130" sortable/>
        <el-table-column prop="accrual_id" label="流水 ID" min-width="165" sortable/>
        <el-table-column prop="unit_number" label="应计费用 ID / 主订单号" min-width="230" sortable/>
        <el-table-column prop="amount_rub" label="待分摊金额 ₽" min-width="142" align="right" sortable><template #default="{row}">{{money(row.amount_rub)}}</template></el-table-column>
      </el-table>
      <el-table v-else :data="exceptions.rows" v-loading="exceptionLoading" border max-height="450" empty-text="没有待核对订单">
        <el-table-column prop="posting_number" label="订单号" width="224" sortable><template #default="{row}"><div class="statistics-posting">
          <el-button type="primary" link @click="showLedger(row,$event,exceptionScope.month)"><span class="statistics-posting-text">{{row.posting_number}}</span></el-button>
          <el-tooltip content="复制订单号"><el-button :icon="'CopyDocument'" circle text size="small" :aria-label="'复制订单号 '+row.posting_number" @click.stop="copyOrderNumber(row.posting_number)"/></el-tooltip>
        </div></template></el-table-column>
        <el-table-column prop="status" label="状态" min-width="110" sortable/>
        <el-table-column prop="accrual_date" label="本月最后应计日" min-width="142" sortable/>
        <el-table-column label="核对原因" min-width="250"><template #default="{row}">{{exceptionReason(row)}}</template></el-table-column>
      </el-table>
      <div v-if="exceptions.total" class="statistics-footer">
        <span>{{exceptions.total}} {{exceptionScope?.kind==='unresolved'?'笔流水':'单'}}</span>
        <el-pagination v-model:current-page="exceptionPage" :page-size="exceptions.page_size" :total="exceptions.total" layout="prev, pager, next" @current-change="loadExceptions"/>
      </div>
    </el-dialog>
    <el-dialog v-model="ledgerVisible" :title="(orderRow?.loose_month ? '主单级费用 ' : '订单 ') + ledgerOrder" width="980px" class="statistics-dialog" @close="hideProductZoom">
      <el-tabs v-model="orderTab" @tab-change="changeOrderTab">
        <el-tab-pane label="费用明细" name="fees">
          <div v-if="orderRow?.platform_net_rub!=null" class="statistics-toolbar statistics-meta"><span>已归属 Ozon 净额：₽{{money(orderRow.platform_net_rub)}}</span></div>
          <div v-if="ledger.length" class="statistics-meta" style="margin:0 0 8px">共 {{ledger.length}} 笔流水，覆盖 {{ledgerMonths.length}} 个月 · {{orderRow?.loose_month ? '这里显示该主单号下的全部结算流水，不受上方月份筛选限制' : '这里显示该订单的全期结算数据，不受上方月份筛选限制'}}</div>
          <el-alert v-if="ledgerError" :title="ledgerError" type="error" :closable="false" class="statistics-alert"/>
          <el-table v-else :data="ledger" border v-loading="ledgerLoading" max-height="420" empty-text="该订单暂无结算流水（可能尚未结算，或不属于当前店铺）">
            <el-table-column prop="date" label="应计日期" width="130" sortable/>
            <el-table-column prop="accrual_id" label="流水 ID" width="170" sortable/>
            <el-table-column label="费用项目" min-width="280"><template #default="{row}">{{feeName(row)}}</template></el-table-column>
            <el-table-column prop="amount_rub" label="金额 ₽" width="145" align="right" sortable><template #default="{row}"><span :class="{'statistics-negative':row.amount_rub<0}">{{row.amount_rub>0?'+':''}}{{money(row.amount_rub)}}</span></template></el-table-column>
            <el-table-column prop="method" label="匹配依据" width="140" sortable/>
          </el-table>
          <el-collapse v-if="ledgerPending.length" class="statistics-alert">
            <el-collapse-item :title="'未计入本单的主单流水（'+ledgerPending.length+' 笔）'">
              <el-table :data="ledgerPending" border max-height="220">
                <el-table-column prop="date" label="应计日期" min-width="125" sortable/>
                <el-table-column prop="unit_number" label="主订单号" min-width="160" sortable/>
                <el-table-column prop="accrual_id" label="流水 ID" min-width="155" sortable/>
                <el-table-column prop="amount_rub" label="未计入金额 ₽" min-width="140" align="right" sortable><template #default="{row}">{{row.amount_rub>0?'+':''}}{{money(row.amount_rub)}}</template></el-table-column>
              </el-table>
            </el-collapse-item>
          </el-collapse>
        </el-tab-pane>
        <el-tab-pane v-if="!orderRow?.loose_month" label="订单详情" name="detail">
          <dl v-if="orderRow" class="statistics-order-facts">
            <div><dt>订单状态</dt><dd>{{orderRow.status}}</dd></div>
            <div><dt>订单类型</dt><dd>{{orderRow.order_type}}</dd></div>
            <div><dt>下单日期（北京时间）</dt><dd>{{dateTime(orderRow.ordered_at)}}</dd></div>
            <div><dt>本月最后应计日</dt><dd>{{orderRow.accrual_date || '—'}}</dd></div>
            <div><dt>订单最近结算日</dt><dd>{{orderRow.settled_date || '—'}}</dd></div>
            <div v-if="orderRow.cancel_reason"><dt>取消原因</dt><dd>{{orderRow.cancel_reason}}</dd></div>
          </dl>
          <div class="statistics-order-panel" v-loading="detailLoading">
            <template v-if="detailError">
              <el-alert :title="detailError" type="error" :closable="false" class="statistics-alert"/>
              <el-button :icon="'Refresh'" @click="loadOrderDetail">重试</el-button>
            </template>
            <template v-else-if="orderDetail?.products.length">
              <div class="statistics-toolbar statistics-meta"><span>商品合计 {{orderQuantity}} 件</span><span>订单资料更新 {{dateTime(orderDetail.updated_at)}}</span></div>
              <el-table :data="orderDetail.products" border max-height="320">
                <el-table-column label="图片" width="78" align="center">
                  <template #default="{row}">
                    <span class="statistics-product-thumb" @pointerenter="showProductZoom(row,$event)" @pointermove="moveProductZoom" @pointerleave="hideProductZoom" @click="hideProductZoom">
                      <el-image v-if="row.image" :src="row.image" :alt="row.name || row.offer_id || row.sku" fit="contain" :preview-src-list="[row.image]" preview-teleported hide-on-click-modal>
                        <template #error><span class="statistics-product-empty">无图</span></template>
                      </el-image>
                      <span v-else class="statistics-product-empty">无图</span>
                    </span>
                  </template>
                </el-table-column>
                <el-table-column prop="name" label="商品名称" min-width="260" show-overflow-tooltip sortable><template #default="{row}">{{row.name || '未匹配到商品名称'}}</template></el-table-column>
                <el-table-column prop="sku" label="Ozon SKU" min-width="130" sortable/>
                <el-table-column prop="offer_id" label="商家货号" min-width="240" show-overflow-tooltip sortable/>
                <el-table-column prop="quantity" label="数量" width="86" align="right" sortable/>
              </el-table>
            </template>
            <el-empty v-else-if="detailLoaded" description="暂无已同步的商品明细" :image-size="48"/>
          </div>
        </el-tab-pane>
      </el-tabs>
      <template #footer><el-button :icon="'CopyDocument'" @click="copyOrderNumber(ledgerOrder)">复制订单号</el-button></template>
    </el-dialog>
    <el-dialog v-model="settleResult.visible" title="同步结算日期结果" width="760px" top="8vh" class="statistics-dialog">
      <div v-if="settleResult" class="statistics-metrics statistics-metrics-dialog" style="margin-bottom:12px">
        <div><span>本次待补</span><strong>{{settleResult.requested}}<small>单</small></strong></div>
        <div><span>成功</span><strong style="color:#15803d">{{settleResult.ok}}<small>单</small></strong></div>
        <div><span>未取到</span><strong :style="{color: settleResult.fail ? '#b45309' : '#94a3b8'}">{{settleResult.fail}}<small>单</small></strong></div>
      </div>
      <el-table :data="settleResult.groups" border size="small" empty-text="没有分组">
        <el-table-column prop="label" label="类型" width="130"/>
        <el-table-column label="成功" width="80" align="right">
          <template #default="{row}">{{row.ok}}</template>
        </el-table-column>
        <el-table-column label="未取到" width="90" align="right">
          <template #default="{row}"><span :style="{color: row.fail ? '#b45309' : '#94a3b8'}">{{row.fail}}</span></template>
        </el-table-column>
        <el-table-column prop="reason" label="失败原因" min-width="260" show-overflow-tooltip/>
      </el-table>
      <div v-for="group in settleResult.groups.filter(g => g.fail)" :key="group.label" style="margin-top:12px">
        <div class="statistics-actions" style="margin-bottom:4px">
          <span class="statistics-meta"><b>{{group.label}}</b> 未取到 {{group.postings.length}} 单（最多展示 200 个）</span>
          <el-button link type="primary" :icon="'CopyDocument'" @click="copyFailed(group.postings)">复制单号</el-button>
        </div>
        <div class="statistics-meta" style="max-height:110px;overflow:auto;font-family:ui-monospace,monospace;line-height:1.7">{{group.postings.join('  ')}}</div>
      </div>
      <template #footer><el-button type="primary" @click="settleResult.visible = false">知道了</el-button></template>
    </el-dialog>
    <el-dialog v-model="cookieVisible" title="需要 Ozon 后台会话" width="720px" top="8vh" class="statistics-dialog">
      <el-alert type="warning" :closable="false" show-icon title="取消时间只有卖家后台网页里有，Seller API 不返回，这一步要用一次后台会话"/>
      <div class="statistics-meta" style="margin:10px 0;line-height:1.8;white-space:normal">
        点 <b>「从浏览器获取」</b>：采集插件用 Chrome 的 cookies 权限直接读出你浏览器里的 ozon.ru 登录态，不用手抄。<br>
        <span v-if="webSession && webSession.updated_at">当前会话保存于 {{webSession.updated_at}}（{{webSession.host}}），已失效。</span>
        <span v-if="webSession && webSession.last_error">最近一次错误：{{webSession.last_error}}</span>
      </div>
      <el-divider style="margin:6px 0 12px"><span style="font-size:12px;color:#94a3b8">或手动粘贴</span></el-divider>
      <el-input v-model="cookieInput" type="textarea" :rows="4" placeholder="卖家后台 F12 → Network → 任一请求 → 复制 Request Headers 里的 Cookie 整行"/>
      <template #footer>
        <el-button @click="cookieVisible = false">取消</el-button>
        <el-button :loading="cookieSaving" @click="saveCookie">粘贴的 cookie 保存并同步</el-button>
        <el-button type="primary" :loading="cookieSaving" @click="cookieFromBrowser">从浏览器获取</el-button>
      </template>
    </el-dialog>
    <teleport to="body">
      <figure v-if="productZoom && ledgerVisible" class="statistics-product-zoom" aria-hidden="true" :style="{left:productZoom.x+'px',top:productZoom.y+'px','--preview-size':productZoom.size+'px',margin:0}">
        <img :src="productZoom.src" alt="" /><figcaption>{{productZoom.title}}</figcaption>
      </figure>
    </teleport>
  </section>`,
};
