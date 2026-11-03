window.StatisticsAnalysisView = {
  setup() {
    const { ref, computed, onMounted, onBeforeUnmount, watch } = Vue;
    const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const offsetMonth = (month, delta) => { const d = new Date(month + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + delta); return d.toISOString().slice(0, 7); };
    const month = ref(offsetMonth(today().slice(0, 7), -1));
    const monthRange = ref([month.value, today().slice(0, 7)]);
    const tab = ref('orders'), loading = ref(false), saving = ref(false), syncing = ref(false), error = ref('');
    const rows = ref([]), monthly = ref([]), summary = ref({}), run = ref(null), total = ref(0);
    const page = ref(1), pageSize = ref(100), search = ref(''), status = ref(''), orderType = ref('');
    const lowOnly = ref(false), missingOnly = ref(false), sort = ref('settled_date'), direction = ref('asc');
    const selected = ref([]), table = ref(null), costVisible = ref(false), drafts = ref([]), fillAmount = ref(null), labelFillAmount = ref(null);
    const costError = ref(''), costScope = ref(null), uploadInput = ref(null), monthVisible = ref(false), costSource = ref('manual');
    const costPage = ref(1);
    const costPageRows = computed(() => drafts.value.slice((costPage.value - 1) * 50, costPage.value * 50));
    const monthDraft = ref({}), monthScope = ref(null), settingsError = ref('');
    const changesVisible = ref(false), changes = ref([]), changesLoading = ref(false);
    const ledgerVisible = ref(false), ledgerLoading = ref(false), ledger = ref([]), ledgerPending = ref([]), ledgerOrder = ref('');
    let generation = 0, poll = null, stopped = false;
    const sid = () => window.getCurrentStoreId?.() || localStorage.getItem('currentStoreId') || '';
    const ctx = () => ({ store_id: sid(), month: month.value });
    const sameScope = (scope) => scope && scope.store_id === sid() && scope.month === month.value;
    const money = (value) => value == null ? '—' : Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const dateTime = (value) => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)) : '—';
    const message = (e) => e?.response?.data?.error || e?.message || '请求失败';
    const activeRun = computed(() => run.value && ['queued', 'running'].includes(run.value.status));
    const progress = computed(() => run.value?.days_total ? Math.min(99, Math.round(run.value.days_done / run.value.days_total * 90)) : 0);
    const titleProfit = (s) => s.profit_cny != null ? '' : !s.coverage?.complete ? '应计流水尚未完整同步' : s.missing_purchase ? `待补采购费 ${s.missing_purchase} 单` : s.pending_rows || s.unresolved_parents ? '存在未分摊收支' : s.missing_metadata ? '订单资料待补充' : !s.exchange_rate ? '汇率待设置' : '暂无订单';
    const monthlyProfit = (s) => s.profit_cny ?? (s.coverage?.complete ? (s.known_cost_profit_cny ?? null) : null);
    const monthlyProfitEstimated = (s) => s.profit_cny == null && monthlyProfit(s) != null;
    function monthlyProfitNote(s) {
      const notes = monthlyProfitEstimated(s) ? ['暂估'] : [];
      if (s.missing_purchase) notes.push(`待补采购费 ${s.missing_purchase} 单`);
      const pending = (s.pending_rows || 0) + (s.unresolved_parents || 0);
      if (pending) notes.push(`收支待分摊 ${pending} 笔`);
      if (s.missing_metadata) notes.push(`订单资料待补充 ${s.missing_metadata} 单`);
      return notes.join(' · ');
    }
    function sortMonthlyProfit(a, b) {
      const left = monthlyProfit(a), right = monthlyProfit(b);
      return left == null ? (right == null ? 0 : 1) : right == null ? -1 : left - right;
    }
    const typeLabels = { 1: '收单手续费（正数为退回）', 3: '品牌推广', 4: '品牌推广接入', 19: '站外推广', 23: '站内广告', 33: '广告服务', 41: '点击广告', 49: 'Premium推广', 54: '商品推广', 59: '逆向物流', 67: '国际配送服务', 87: '社交媒体广告', 122: '国际运输合同组织服务', 123: 'Ozon物流平台接入服务', 130: '展示广告' };
    const feeName = (row) => row.types?.length ? row.types.map((id) => typeLabels[id] || `费用类型 ${id}`).join('、') : '订单结算汇总（内层费用不重复累计）';
    const filters = () => ({ ...ctx(), page: page.value, page_size: pageSize.value, search: search.value, status: status.value,
      order_type: orderType.value, low_income: lowOnly.value ? '1' : '', missing_cost: missingOnly.value ? '1' : '', sort: sort.value, direction: direction.value });
    async function load(all = true) {
      if (!sid() || !month.value || stopped) return;
      const scope = ctx(), token = ++generation;
      loading.value = true; error.value = '';
      try {
        const response = await axios.get('/api/statistics/report', { params: filters() });
        if (token !== generation || !sameScope(scope)) return;
        rows.value = response.data.rows; summary.value = response.data.summary; total.value = response.data.total; run.value = response.data.run;
        if (all && monthRange.value?.length === 2) {
          const result = await axios.get('/api/statistics/months', { params: { store_id: scope.store_id, from: monthRange.value[0], to: monthRange.value[1] } });
          if (token !== generation || !sameScope(scope)) return;
          monthly.value = result.data.rows;
        }
      } catch (e) { if (token === generation && sameScope(scope)) error.value = message(e); }
      finally { if (token === generation) loading.value = false; }
    }
    function applyFilter() { page.value = 1; selected.value = []; table.value?.clearSelection(); load(false); }
    function sortChanged({ prop, order }) { sort.value = prop || 'settled_date'; direction.value = order === 'descending' ? 'desc' : 'asc'; applyFilter(); }
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
    function openCosts(items = selected.value, source = 'manual') {
      costScope.value = ctx(); fillAmount.value = null; labelFillAmount.value = null; costError.value = ''; costPage.value = 1;
      costSource.value = source;
      drafts.value = items.map((r) => ({ posting_number: r.posting_number, purchase_cny: r.purchase_cny, label_cny: r.label_cny, version: r.version }));
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
    // 一次性取回所选结算月份的全部订单，导入核对与模板生成共用。
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
      const badLabel = drafts.value.some((r) => r.label_cny == null || !Number.isFinite(r.label_cny) || r.label_cny < 0);
      if (badLabel) { costError.value = '贴单费用必须填写且大于等于0（默认 ¥1.50，包含取消单）'; return; }
      try {
        await ElementPlus.ElMessageBox.confirm(`保存 ${costScope.value.month} 共 ${drafts.value.length} 单的采购费/贴单费？采购费为空的订单将保持待核算，修改前会保留快照。`, '确认批量维护', { type: 'warning', confirmButtonText: '保存', cancelButtonText: '取消' });
        if (!sameScope(costScope.value)) return;
        saving.value = true; costError.value = '';
        await axios.patch('/api/statistics/costs', { ...costScope.value, reason: costSource.value === 'import' ? '导入采购费/贴单费' : '批量维护采购费/贴单费',
          items: drafts.value.map((r) => ({ posting_number: r.posting_number, purchase_cny: r.purchase_cny ?? null, label_cny: r.label_cny, version: r.version })) });
        costVisible.value = false; selected.value = []; table.value?.clearSelection();
        ElementPlus.ElMessage.success('采购费/贴单费已保存，修改快照已保留'); await load();
      } catch (e) { if (e !== 'cancel' && e !== 'close') costError.value = message(e); }
      finally { saving.value = false; }
    }
    // 导入模板：与页面导出 CSV 同构，但只保留可回填的列，便于原样导入。
    const TEMPLATE_HEAD = ['订单号', '采购费用（CNY，含采购运费）', '贴单费用（CNY）', '订单状态', '结算日', '销售收入（RUB）', 'Ozon费用（RUB）', '取消原因', '订单类型'];
    const templateAmount = (value, label, rowNo) => {
      if (value == null || String(value).trim() === '') return null;
      const text = String(value).trim().replace(/[,，¥￥\s]/g, '');
      if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(`第 ${rowNo} 行${label}无效：${String(value).trim().slice(0, 20)}`);
      return Number(text);
    };
    async function downloadTemplate() {
      const scope = ctx();
      if (!scope.store_id) return;
      if (!window.XLSX) { error.value = 'Excel组件尚未加载，请刷新后重试'; return; }
      loading.value = true; error.value = '';
      try {
        const known = await monthRows(scope);
        if (!known) return;
        const list = [...known.values()].sort((a, b) => String(a.settled_date).localeCompare(String(b.settled_date)) || a.posting_number.localeCompare(b.posting_number));
        if (!list.length) throw new Error('所选月份暂无结算订单，无法生成导入模板');
        if (list.length > 5000) throw new Error(`本月共 ${list.length} 单，超过单次导入上限 5000 单，请分开维护`);
        const sheet = XLSX.utils.aoa_to_sheet([TEMPLATE_HEAD, ...list.map((r) => [r.posting_number, r.purchase_cny ?? '', r.label_cny ?? '', r.status, r.settled_date, r.income_rub ?? '', r.ozon_fees_rub ?? '', r.cancel_reason ?? '', r.order_type])]);
        sheet['!cols'] = [{ wch: 22 }, { wch: 24 }, { wch: 16 }, { wch: 10 }, { wch: 12 }, { wch: 15 }, { wch: 15 }, { wch: 30 }, { wch: 14 }];
        sheet['!freeze'] = { xSplit: '0', ySplit: '1' };
        const help = XLSX.utils.aoa_to_sheet([
          ['导入说明'], [''],
          ['模板已填入所选结算月份的全部订单，以及当前已维护的采购费/贴单费。'],
          ['1. 只填写需要修改的金额，留空的单元格表示保持不变（不会清零）。'],
          ['2. 采购费用 = 采购价 + 采购运费，单位人民币，最多两位小数。'],
          ['3. 贴单费用按单收取，默认 1.50 元，包含取消单；实际不同时按订单填写。'],
          ['4. 文件首行必须含「订单号」，以及「采购费用」「贴单费用」中至少一列。'],
          ['5. 单次最多 5000 单；保存前会弹出预览，确认后才写入，并保留修改快照可回滚。'],
          ['6. 只导入贴单费时，采购费列可以整列留空，原有采购费不受影响。'],
          ['7. 支持 .xlsx 与 .csv；订单号必须属于当前店铺的所选结算月份，否则整批拒绝导入。'],
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
        const purchaseIndex = header.findIndex((c) => c.startsWith('采购费'));
        const labelIndex = header.findIndex((c) => c.startsWith('贴单费'));
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
        if (imported.length > 5000) throw new Error(`一次最多导入 5000 单，本次 ${imported.length} 单`);
        const known = await monthRows(scope);
        if (!known) return;
        for (const item of imported) if (!known.has(item.posting_number)) throw new Error(`订单不属于当前店铺的所选结算月份：${item.posting_number}`);
        // 与当前值一致的订单不再写库，避免空导入制造无意义的版本和快照。
        const changed = imported.filter((item) => {
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
        exchange_rate: item.exchange_rate, ad_mode: item.advertising_source === 'manual' ? 'manual' : 'api',
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
      changesVisible.value = true; changesLoading.value = true;
      const store = sid();
      try { const response = await axios.get('/api/statistics/changes', { params: { store_id: store } }); if (store === sid()) changes.value = response.data.rows; }
      catch (e) { error.value = message(e); }
      finally { changesLoading.value = false; }
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
    async function showLedger(row) {
      const scope = ctx(); ledgerOrder.value = row.posting_number; ledger.value = []; ledgerPending.value = [];
      ledgerVisible.value = true; ledgerLoading.value = true;
      try {
        const response = await axios.get('/api/statistics/ledger', { params: { ...scope, posting_number: row.posting_number } });
        if (sameScope(scope) && ledgerOrder.value === row.posting_number) { ledger.value = response.data.rows; ledgerPending.value = response.data.pending; }
      } catch (e) { error.value = message(e); }
      finally { ledgerLoading.value = false; }
    }
    async function exportOrders() {
      const scope = ctx();
      try {
        const response = await axios.get('/api/statistics/export', { params: filters(), responseType: 'blob' });
        const url = URL.createObjectURL(response.data), anchor = document.createElement('a');
        anchor.href = url; anchor.download = `${scope.month}-结算订单.csv`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) { error.value = '导出失败，请确认月份数据已加载后重试'; }
    }
    function exportMonths() {
      const cells = [['月份', '订单数', '销售总收入（RUB，含退费）', 'Ozon费用（RUB）', '广告费（RUB）', '广告费（CNY）', '广告费来源', '其他店铺净收支（RUB）', '采购费用（CNY，已录入）', '贴单费用（CNY）', '汇率（CNY/RUB）', '毛利（CNY，含广告）', '待补采购费订单数', '待分摊流水数', '应计数据完整', '毛利口径'],
        ...monthly.value.map((r) => [r.month, r.orders, r.coverage?.checked_days ? r.income_rub : null, r.coverage?.checked_days ? r.ozon_fees_rub : null, r.advertising_rub, r.advertising_cny, r.advertising_source === 'manual' ? '手工' : 'API', r.other_shop_net_rub, r.purchase_cny, r.label_cny, r.exchange_rate, monthlyProfit(r), r.missing_purchase, r.pending_rows, r.coverage?.complete ? '是' : '否', monthlyProfitEstimated(r) ? '暂估（仅扣已录入成本）' : monthlyProfit(r) == null ? titleProfit(r) : '已核算'])];
      const csv = cells.map((r) => r.map((v) => `"${String(v ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = '月度汇总.csv'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function disabledMonth(date) { const current = Number(today().slice(0, 4)) * 12 + Number(today().slice(5, 7)) - 1; const value = date.getFullYear() * 12 + date.getMonth(); return value > current || value < current - 36; }
    function shopChanged() {
      generation++; rows.value = []; monthly.value = []; summary.value = {}; run.value = null; selected.value = [];
      costVisible.value = false; monthVisible.value = false; changesVisible.value = false; ledgerVisible.value = false;
      table.value?.clearSelection(); page.value = 1; load();
    }
    watch(month, () => { if (!month.value) return; page.value = 1; selected.value = []; table.value?.clearSelection(); load(); });
    watch(monthRange, () => { if (monthRange.value?.length === 2) load(); });
    onMounted(() => {
      window.addEventListener('shop-changed', shopChanged); load();
      poll = setInterval(() => { if (!document.hidden && !loading.value && !costVisible.value && !monthVisible.value) load(tab.value === 'months' || !!activeRun.value); }, 15000);
    });
    onBeforeUnmount(() => { stopped = true; generation++; clearInterval(poll); window.removeEventListener('shop-changed', shopChanged); });
    return { tab, month, monthRange, loading, saving, syncing, error, rows, monthly, summary, run, total, page, pageSize, search, status, orderType, lowOnly, missingOnly,
      selected, table, costVisible, drafts, fillAmount, labelFillAmount, costError, uploadInput, monthVisible, monthDraft, settingsError, changesVisible, changes, changesLoading,
      ledgerVisible, ledgerLoading, ledger, ledgerPending, ledgerOrder, activeRun, progress, money, dateTime, titleProfit, monthlyProfit, monthlyProfitEstimated, monthlyProfitNote, sortMonthlyProfit, feeName, disabledMonth, costPage, costPageRows,
      load, applyFilter, sortChanged, sortCosts, syncNow, openCosts, fillCosts, fillLabels, saveCosts, importCosts, downloadTemplate, openMonth, saveMonth, openChanges, rollback, showLedger, exportOrders, exportMonths };
  },
  template: `
  <section class="statistics-workbench">
    <header class="statistics-heading">
      <div><h2>统计分析</h2><div class="statistics-meta">每日 02:30（北京时间）自动更新 <span v-if="summary.coverage?.last_updated_at">· 数据更新 {{dateTime(summary.coverage.last_updated_at)}}</span><span v-if="summary.coverage?.as_of_date"> · 应计核对至 {{summary.coverage.as_of_date}}</span></div></div>
      <div class="statistics-actions">
        <el-date-picker v-model="month" type="month" value-format="YYYY-MM" format="YYYY 年 MM 月" :clearable="false" :disabled-date="disabledMonth" aria-label="结算月份" style="width:170px"/>
        <el-tooltip content="刷新已同步的数据"><el-button :icon="'Refresh'" circle aria-label="刷新报表" @click="load()"/></el-tooltip>
        <el-button type="primary" :icon="'RefreshRight'" :loading="syncing || activeRun" @click="syncNow">立即更新</el-button>
        <el-tooltip content="修改记录与回滚"><el-button :icon="'Clock'" circle aria-label="修改记录与回滚" @click="openChanges"/></el-tooltip>
      </div>
    </header>
    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="statistics-alert"/>
    <div v-if="activeRun" class="statistics-sync" role="status"><el-icon class="is-loading"><Loading/></el-icon><span>{{run.message || '任务排队中'}}</span><span>{{run.days_done}} / {{run.days_total || '—'}} 天</span><el-progress :percentage="progress" :show-text="false" style="width:130px"/></div>
    <el-alert v-else-if="run?.status === 'failed'" :title="'更新未完成：' + run.error" type="error" show-icon :closable="false" class="statistics-alert"/>
    <div class="statistics-metrics">
      <div><span>结算订单</span><strong>{{summary.orders ?? '—'}}<small>单</small></strong><small>WHD {{summary.whd_orders || 0}} 单</small></div>
      <div><span>销售收入 <small>RUB</small></span><strong>{{summary.coverage?.checked_days ? money(summary.income_rub) : '—'}}</strong><small>含正向手续费退回</small></div>
      <div><span>Ozon 费用 <small>RUB</small></span><strong>{{summary.coverage?.checked_days ? money(summary.ozon_fees_rub) : '—'}}</strong><small>订单负向应计绝对值</small></div>
      <div><span>低于 100 卢布</span><strong class="statistics-warning">{{summary.low_income_orders ?? '—'}}<small>单</small></strong><small>另 {{summary.income_unknown_orders || 0}} 单收入待分摊</small></div>
    </div>
    <el-tabs v-model="tab">
      <el-tab-pane label="订单明细" name="orders">
        <div class="statistics-toolbar">
          <div class="statistics-filters"><el-input v-model="search" placeholder="订单号" clearable @keyup.enter="applyFilter" @clear="applyFilter" style="width:215px"><template #prefix><el-icon><Search/></el-icon></template></el-input>
            <el-select v-model="status" placeholder="全部状态" clearable @change="applyFilter" style="width:135px"><el-option label="已签收" value="delivered"/><el-option label="已取消" value="cancelled"/></el-select>
            <el-select v-model="orderType" placeholder="全部类型" clearable @change="applyFilter" style="width:155px"><el-option label="正常销售订单" value="正常销售订单"/><el-option label="WHD订单" value="WHD订单"/></el-select>
            <el-checkbox v-model="lowOnly" @change="applyFilter">收入 &lt; 100</el-checkbox><el-checkbox v-model="missingOnly" @change="applyFilter">缺采购费</el-checkbox>
            <el-button :icon="'Search'" @click="applyFilter">查询</el-button>
          </div>
          <div class="statistics-actions"><el-button :icon="'EditPen'" :disabled="!selected.length" @click="openCosts()">批量维护 ({{selected.length}})</el-button>
            <el-button :icon="'Upload'" @click="uploadInput.click()">导入采购/贴单费</el-button><el-tooltip content="下载含全部订单与已维护金额的导入模板"><el-button :icon="'Document'" circle aria-label="下载导入模板" @click="downloadTemplate"/></el-tooltip><el-tooltip content="导出当前筛选的全部订单"><el-button :icon="'Download'" circle aria-label="导出订单CSV" @click="exportOrders"/></el-tooltip>
            <input ref="uploadInput" type="file" accept=".csv,.xlsx,.xls" hidden @change="importCosts"/>
          </div>
        </div>
        <div class="statistics-data-note" v-if="summary.coverage && !summary.coverage.complete">应计数据未完整同步：本月 {{summary.coverage.checked_days}} / {{summary.coverage.expected_days}} 天，跨月核对还缺 {{summary.coverage.boundary_missing_days?.length || 0}} 天。毛利暂不结算。</div>
        <el-table ref="table" :data="rows" v-loading="loading" row-key="posting_number" border stripe max-height="620" @selection-change="selected=$event" @sort-change="sortChanged" empty-text="所选月份暂无结算订单" class="statistics-orders">
          <el-table-column type="selection" width="45" :reserve-selection="true"/>
          <el-table-column prop="posting_number" label="订单号" min-width="205" fixed="left" sortable="custom"><template #default="{row}"><el-button type="primary" link @click="showLedger(row)">{{row.posting_number}}</el-button></template></el-table-column>
          <el-table-column prop="status" label="状态" width="105" sortable="custom"/>
          <el-table-column prop="ordered_at" label="下单日期" width="180" sortable="custom"><template #default="{row}">{{dateTime(row.ordered_at)}}</template></el-table-column>
          <el-table-column prop="settled_date" label="结算日" width="125" sortable="custom"/>
          <el-table-column prop="purchase_cny" label="采购费 ¥" width="125" align="right" sortable="custom"><template #default="{row}"><el-button link :type="row.purchase_cny==null?'warning':'primary'" @click="openCosts([row])">{{row.purchase_cny==null?'待录入':money(row.purchase_cny)}}</el-button></template></el-table-column>
          <el-table-column prop="label_cny" label="贴单费 ¥" width="110" align="right" sortable="custom"><template #default="{row}"><el-button link type="primary" @click="openCosts([row])">{{money(row.label_cny)}}</el-button></template></el-table-column>
          <el-table-column prop="income_rub" label="销售收入 ₽" width="135" align="right" sortable="custom"><template #default="{row}"><span :class="{'statistics-warning':row.low_income}">{{money(row.income_rub)}}</span><el-tooltip v-if="row.pending_positive" content="仅含已明确归属部分，另有收入待分摊"><el-icon class="statistics-warning"><Warning/></el-icon></el-tooltip></template></el-table-column>
          <el-table-column prop="ozon_fees_rub" label="Ozon 费用 ₽" width="140" align="right" sortable="custom"><template #default="{row}">{{money(row.ozon_fees_rub)}}<el-tooltip v-if="row.pending_negative" content="仅含已明确归属部分，另有费用待分摊"><el-icon class="statistics-warning"><Warning/></el-icon></el-tooltip></template></el-table-column>
          <el-table-column prop="profit_cny" label="订单毛利 ¥" width="135" align="right" sortable="custom"><template #default="{row}"><el-tooltip :content="row.purchase_cny==null?'采购费待补充':row.pending_negative||row.pending_positive?'收支待分摊':'未扣店铺广告费'"><span :class="{'statistics-negative':row.profit_cny<0}">{{money(row.profit_cny)}}</span></el-tooltip></template></el-table-column>
          <el-table-column prop="cancel_reason" label="取消原因" min-width="280" show-overflow-tooltip sortable="custom"/>
          <el-table-column prop="order_type" label="订单类型" width="150" sortable="custom"/>
        </el-table>
        <div class="statistics-footer"><span>共 {{total}} 单 · 采购费含采购运费 · 贴单费默认 ¥1.50 / 单</span><el-pagination v-model:current-page="page" v-model:page-size="pageSize" :total="total" :page-sizes="[50,100,200,500]" layout="total, sizes, prev, pager, next" @current-change="load(false)" @size-change="applyFilter"/></div>
      </el-tab-pane>
      <el-tab-pane label="月度汇总" name="months">
        <div class="statistics-toolbar"><div class="statistics-filters"><el-date-picker v-model="monthRange" type="monthrange" value-format="YYYY-MM" format="YYYY-MM" start-placeholder="开始月份" end-placeholder="结束月份" :clearable="false" :disabled-date="disabledMonth" style="width:300px"/></div><div class="statistics-actions"><el-button :icon="'Setting'" @click="openMonth()">{{month}} 月度设置</el-button><el-tooltip content="导出月度汇总CSV"><el-button :icon="'Download'" circle aria-label="导出月度汇总" @click="exportMonths"/></el-tooltip></div></div>
        <el-table :data="monthly" border stripe v-loading="loading" max-height="580" empty-text="暂无月份数据">
          <el-table-column prop="month" label="月份" width="115" fixed="left" sortable/>
          <el-table-column prop="orders" label="订单数" width="100" sortable/>
          <el-table-column prop="income_rub" label="销售总收入 ₽" width="160" align="right" sortable><template #default="{row}">{{row.coverage?.checked_days?money(row.income_rub):'未同步'}}</template></el-table-column>
          <el-table-column prop="ozon_fees_rub" label="Ozon 费用 ₽" width="150" align="right" sortable><template #default="{row}">{{row.coverage?.checked_days?money(row.ozon_fees_rub):'—'}}</template></el-table-column>
          <el-table-column prop="advertising_rub" label="广告费 ₽" width="160" align="right" sortable><template #default="{row}"><el-button link type="primary" @click="openMonth(row)">{{row.coverage?.checked_days||row.advertising_source==='manual'?money(row.advertising_rub):'—'}}</el-button><div class="statistics-cell-note">{{row.advertising_source==='manual'?'手工覆盖':'API'}}</div></template></el-table-column>
          <el-table-column prop="profit_cny" label="月度毛利 ¥" width="210" align="right" sortable :sort-method="sortMonthlyProfit"><template #default="{row}"><template v-if="monthlyProfit(row)!=null"><el-tooltip :disabled="!monthlyProfitEstimated(row)" content="暂估仅扣已录入采购费，未录入部分暂按0；未明确归属的收支暂不计入。"><b :class="{'statistics-negative':monthlyProfit(row)<0}">{{money(monthlyProfit(row))}}</b></el-tooltip><div v-if="monthlyProfitNote(row)" class="statistics-cell-note statistics-warning">{{monthlyProfitNote(row)}}</div></template><span class="statistics-warning" v-else>{{titleProfit(row)}}</span></template></el-table-column>
          <el-table-column prop="other_shop_net_rub" label="其他店铺净收支 ₽" width="180" align="right" sortable><template #default="{row}">{{row.coverage?.checked_days?money(row.other_shop_net_rub):'—'}}</template></el-table-column>
          <el-table-column prop="purchase_cny" label="采购费用 ¥" width="145" align="right" sortable><template #default="{row}">{{money(row.purchase_cny)}}<div class="statistics-cell-note" v-if="row.missing_purchase">{{row.missing_purchase}} 单待录入</div></template></el-table-column>
          <el-table-column prop="label_cny" label="贴单费用 ¥" width="130" align="right" sortable><template #default="{row}">{{money(row.label_cny)}}</template></el-table-column>
          <el-table-column prop="exchange_rate" label="汇率 CNY/RUB" width="155" align="right" sortable><template #default="{row}">{{row.exchange_rate?.toFixed(6)||'—'}}</template></el-table-column>
          <el-table-column label="操作" width="80" fixed="right"><template #default="{row}"><el-tooltip content="维护本月广告费与汇率"><el-button :icon="'EditPen'" circle size="small" aria-label="月度设置" @click="openMonth(row)"/></el-tooltip></template></el-table-column>
        </el-table>
        <div class="statistics-footer"><span>月度毛利 =（销售收入 − Ozon费用 ＋ 其他店铺净收支）× 汇率 − 采购费 − 贴单费 − 广告费。广告费不重复计入 Ozon 费用。</span></div>
      </el-tab-pane>
    </el-tabs>
    <el-dialog v-model="costVisible" title="维护采购费 / 贴单费" width="850px" class="statistics-dialog" :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving" :before-close="done=>!saving&&done()">
      <div class="statistics-toolbar"><span>{{drafts.length}} 单 · 采购费用含采购运费（CNY）· 贴单费按单（CNY）</span><div class="statistics-actions"><el-input-number v-model="fillAmount" :min="0" :max="100000000" :precision="2" :controls="false" placeholder="统一采购费"/><el-button @click="fillCosts" :disabled="fillAmount==null">填充采购费</el-button><el-input-number v-model="labelFillAmount" :min="0" :max="100000000" :precision="2" :controls="false" placeholder="统一贴单费"/><el-button @click="fillLabels" :disabled="labelFillAmount==null">填充贴单费</el-button></div></div>
      <el-alert v-if="costError" :title="costError" type="error" :closable="false" class="statistics-alert"/>
      <el-table :data="costPageRows" border max-height="420" row-key="posting_number" @sort-change="sortCosts"><el-table-column prop="posting_number" label="订单号" min-width="210" sortable="custom"/><el-table-column prop="purchase_cny" label="采购费用 ¥" min-width="180" sortable="custom"><template #default="{row}"><el-input-number v-model="row.purchase_cny" :min="0" :max="100000000" :precision="2" :controls="false" placeholder="未维护"/></template></el-table-column><el-table-column prop="label_cny" label="贴单费用 ¥" min-width="170" sortable="custom"><template #default="{row}"><el-input-number v-model="row.label_cny" :min="0" :max="100000000" :precision="2" :controls="false"/></template></el-table-column></el-table>
      <el-pagination v-if="drafts.length>50" v-model:current-page="costPage" :page-size="50" :total="drafts.length" layout="total, prev, pager, next" style="margin-top:12px"/>
      <template #footer><el-button @click="costVisible=false" :disabled="saving">取消</el-button><el-button type="primary" :icon="'Check'" :loading="saving" @click="saveCosts">保存 {{drafts.length}} 单</el-button></template>
    </el-dialog>
    <el-dialog v-model="monthVisible" :title="monthDraft.month+' 月度设置'" width="540px" class="statistics-dialog" :close-on-click-modal="false">
      <el-alert v-if="settingsError" :title="settingsError" type="error" :closable="false" class="statistics-alert"/>
      <el-form label-position="top"><el-form-item label="汇率（1 RUB 对应 CNY）"><el-radio-group v-model="monthDraft.rate_mode"><el-radio-button value="default">默认汇率</el-radio-button><el-radio-button value="manual">本月汇率</el-radio-button></el-radio-group><el-input-number v-if="monthDraft.rate_mode==='manual'" v-model="monthDraft.exchange_rate" :min="0.000001" :max="1" :precision="6" :step="0.001" style="margin-top:10px;width:100%"/></el-form-item>
      <el-form-item label="广告费来源"><el-radio-group v-model="monthDraft.ad_mode"><el-radio-button value="api">Ozon 应计流水</el-radio-button><el-radio-button value="manual">手工覆盖</el-radio-button></el-radio-group></el-form-item>
      <el-form-item v-if="monthDraft.ad_mode==='manual'" label="本月广告费"><div class="statistics-actions"><el-input-number v-model="monthDraft.advertising_amount" :min="0" :max="100000000" :precision="2" :controls="false"/><el-radio-group v-model="monthDraft.advertising_currency"><el-radio-button value="RUB">RUB</el-radio-button><el-radio-button value="CNY">CNY</el-radio-button></el-radio-group></div></el-form-item></el-form>
      <template #footer><el-button @click="monthVisible=false" :disabled="saving">取消</el-button><el-button type="primary" :loading="saving" @click="saveMonth">保存</el-button></template>
    </el-dialog>
    <el-dialog v-model="changesVisible" title="修改记录" width="950px" class="statistics-dialog"><el-table :data="changes" border v-loading="changesLoading" max-height="500"><el-table-column prop="created_at" label="修改时间" min-width="180" sortable><template #default="{row}">{{dateTime(row.created_at)}}</template></el-table-column><el-table-column prop="month" label="月份" width="110" sortable/><el-table-column prop="reason" label="修改内容" min-width="230" show-overflow-tooltip sortable/><el-table-column prop="affected" label="条数" width="80" sortable/><el-table-column label="状态" width="100"><template #default="{row}">{{row.rolled_back_at?'已回滚':row.kind==='rollback'?'回滚记录':'已保存'}}</template></el-table-column><el-table-column label="操作" width="80"><template #default="{row}"><el-tooltip content="恢复修改前的数值"><el-button v-if="!row.rolled_back_at && row.kind!=='rollback'" :icon="'RefreshLeft'" circle size="small" aria-label="回滚修改" @click="rollback(row)"/></el-tooltip></template></el-table-column></el-table></el-dialog>
    <el-dialog v-model="ledgerVisible" :title="ledgerOrder+' 应计流水'" width="980px" class="statistics-dialog"><el-table :data="ledger" border v-loading="ledgerLoading" max-height="460"><el-table-column prop="date" label="应计日期" width="130" sortable/><el-table-column prop="accrual_id" label="流水 ID" width="170" sortable/><el-table-column label="费用项目" min-width="280"><template #default="{row}">{{feeName(row)}}</template></el-table-column><el-table-column prop="amount_rub" label="金额 ₽" width="145" align="right" sortable><template #default="{row}"><span :class="{'statistics-negative':row.amount_rub<0}">{{row.amount_rub>0?'+':''}}{{money(row.amount_rub)}}</span></template></el-table-column><el-table-column prop="method" label="匹配依据" width="140" sortable/></el-table><el-alert v-if="ledgerPending.length" :title="'另有 '+ledgerPending.length+' 笔共用收支尚待分摊，未重复计入金额'" type="warning" :closable="false" class="statistics-alert"/></el-dialog>
  </section>`,
};
