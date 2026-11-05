window.SettlementDetailView = {
  setup() {
    const { ref, computed, onMounted, onBeforeUnmount } = Vue;
    const MIN_DATE = '2026-07-01';
    const todayStr = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const shiftDay = (value, days) => new Date(Date.parse(`${value}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
    // 往前推 N 个月，月末自动收敛（3-31 → 2-28）
    const shiftMonth = (value, months) => {
      const date = new Date(`${value}T00:00:00Z`), day = date.getUTCDate();
      date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + months);
      const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      date.setUTCDate(Math.min(day, last));
      return date.toISOString().slice(0, 10);
    };

    const sid = () => window.getCurrentStoreId?.() || localStorage.getItem('currentStoreId') || '';
    const message = (e) => e?.response?.data?.error || e?.message || '请求失败';
    const money = (value) => value == null ? '—' : Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const TYPE_LABELS = {
      1: '收单手续费（正数为退回）', 3: '品牌推广', 4: '品牌推广接入', 19: '站外推广', 23: '站内广告',
      33: '广告服务', 41: '点击广告', 49: 'Premium推广', 54: '商品推广', 59: '逆向物流',
      67: '国际配送服务', 74: '费用类型 74', 87: '社交媒体广告', 122: '国际运输合同组织服务',
      123: 'Ozon物流平台接入服务', 130: '展示广告',
    };
    const CATEGORY_LABELS = { ITEM: '商品级', NON_ITEM: '非商品级', POSTING: '订单级', AD: '广告' };

    // 默认区间：昨天 → 今天（与「立即更新」的默认拉取范围一致）
    const defaultRange = () => {
      const today = todayStr(), from = shiftDay(today, -1);
      return [from < MIN_DATE ? MIN_DATE : from, today];
    };
    const dateRange = ref(defaultRange());
    // 表格查询区间：默认最近一个月（今天往前推一个月，月末自动收敛）
    const defaultQueryRange = () => {
      const today = todayStr(), from = shiftMonth(today, -1);
      return [from < MIN_DATE ? MIN_DATE : from, today];
    };
    const accrualRange = ref(defaultQueryRange());
    // 用户是否手动改过范围：没改过时「立即更新」只拉昨天→今天
    const rangeTouched = ref(false);
    const rows = ref([]), total = ref(0), summary = ref({}), run = ref(null);
    const page = ref(1), pageSize = ref(100), loading = ref(false), syncing = ref(false), exporting = ref(false), error = ref('');
    const orderAdBusy = ref(false), orderAdInput = ref(null);
    const logVisible = ref(false), logLoading = ref(false), syncRuns = ref([]), missingDates = ref([]), logToday = ref('');
    const adLogVisible = ref(false), adLogLoading = ref(false), adDays = ref([]), adMissing = ref([]), adSummary = ref({});
    const checkVisible = ref(false), checkRows = ref([]), checkMessage = ref(''), checkTotal = ref(0), pendingEntries = ref([]);
    const posting = ref(''), typeId = ref(''), category = ref(''), source = ref('');
    const stopped = false;

    const typeName = (id) => id == null ? '订单汇总' : (TYPE_LABELS[id] || `费用类型 ${id}`);
    const categoryName = (code) => CATEGORY_LABELS[code] || code || '—';
    const typeOptions = Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label }));
    const activeRun = computed(() => run.value && ['queued', 'running'].includes(run.value.status));
    const progress = computed(() => run.value?.days_total ? Math.min(99, Math.round(run.value.days_done / run.value.days_total * 100)) : 0);
    const lastUpdated = computed(() => run.value?.finished_at ? new Date(run.value.finished_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—');

    // 广告卡片的分层数据：总额 → 54（逐单报表拆成订单/点击）→ 41 → 3 → 跨月顺延
    // 没有导入逐单报表时，54 直接取结算口径
    const adItems = computed(() => {
      const s = summary.value || {};
      const abs = (v) => Math.abs(Number(v || 0));
      const cpo = abs(s.ad_cpo_rub), cpc = abs(s.ad_cpc_rub);
      const hasImport = cpo + cpc > 0.01;
      const total = abs(s.ad_rub), settlement = abs(s.ad_settlement_rub);
      return { shop: abs(s.ad_shop_rub), cpo, cpc, click: abs(s.ad_click_rub), brand: abs(s.ad_brand_rub),
        hasImport, total, settlement, delayed: total - settlement };
    });
    // 广告明细弹层：移入即展开，移出收起；点一下可钉住
    const adTipOpen = ref(false), adTipPinned = ref(false);
    function adEnter() { adTipOpen.value = true; }
    function adLeave() { if (!adTipPinned.value) adTipOpen.value = false; }
    function adToggle() { adTipPinned.value = !adTipPinned.value; adTipOpen.value = adTipPinned.value; }
    function adVisibleChange(v) { if (!v) { adTipOpen.value = false; adTipPinned.value = false; } }
    // 收款合计的悬浮明细：买家实付 / 佣金 / 调整 / 实收
    const incTipOpen = ref(false), incTipPinned = ref(false);
    function incEnter() { incTipOpen.value = true; }
    function incLeave() { if (!incTipPinned.value) incTipOpen.value = false; }
    function incToggle() { incTipPinned.value = !incTipPinned.value; incTipOpen.value = incTipPinned.value; }
    function incVisibleChange(v) { if (!v) { incTipOpen.value = false; incTipPinned.value = false; } }

    function queryParams() {
      // 顶部日期区间只用于「立即更新」的拉取周期；表格按筛选区的「应计日期」区间查询
      const [from, to] = accrualRange.value?.length === 2 ? accrualRange.value : defaultQueryRange();
      const params = { store_id: sid(), page: page.value, page_size: pageSize.value, from, to };
      if (posting.value.trim()) params.posting = posting.value.trim();
      if (typeId.value !== '') params.type_id = typeId.value;
      if (category.value) params.category = category.value;
      if (source.value) params.source = source.value;
      return params;
    }

    async function load() {
      if (!sid()) return;
      loading.value = true; error.value = '';
      try {
        const response = await axios.get('/api/statistics/accruals', { params: queryParams() });
        rows.value = response.data.rows || [];
        total.value = response.data.total || 0;
        summary.value = response.data.summary || {};
        run.value = response.data.run || null;
      } catch (e) { error.value = message(e); }
      finally { loading.value = false; }
    }

    function applyFilter() { page.value = 1; load(); }
    function resetFilters() { posting.value = ''; typeId.value = ''; category.value = ''; source.value = ''; accrualRange.value = defaultQueryRange(); page.value = 1; load(); }
    // 顶部区间只影响同步，改它不刷新表格
    function rangeChanged() { rangeTouched.value = true; }
    function pageChanged() { load(); }

    async function waitRun() {
      for (let i = 0; i < 200 && !stopped; i++) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await load();
        if (!['queued', 'running'].includes(run.value?.status || '')) return;
      }
    }

    async function syncNow() {
      if (!sid() || !dateRange.value?.[0]) return;
      // 顶部区间就是这个按钮要拉的周期
      const from = dateRange.value[0], to = dateRange.value[1];
      syncing.value = true; error.value = '';
      try {
        await axios.post('/api/statistics/sync', { store_id: sid(), from, to });
        await waitRun();
      } catch (e) { error.value = message(e); }
      finally { syncing.value = false; }
    }

    async function forceImport() {
      if (!pendingEntries.value.length) return;
      checkVisible.value = false; orderAdBusy.value = true;
      try {
        const response = await axios.post('/api/statistics/advertising/order-report',
          { store_id: sid(), entries: pendingEntries.value, force: true });
        const data = response.data;
        ElementPlus.ElMessage.success(`导入完成：写入 ${data.days_written} 天 / ${data.rows_written} 条，未变 ${data.days_unchanged} 天`);
        await load();
        await openAdLog();
      } catch (e) {
        ElementPlus.ElMessage.error(e?.response?.data?.error || e?.message || '导入失败');
      } finally { orderAdBusy.value = false; pendingEntries.value = []; }
    }

    async function openAdLog() {
      if (!sid()) return;
      adLogVisible.value = true; adLogLoading.value = true;
      try {
        const r = await axios.get('/api/statistics/ad-import-log', { params: { store_id: sid() } });
        adDays.value = r.data.rows || [];
        adSummary.value = r.data.summary || {};
      } catch (e) { error.value = message(e); }
      finally { adLogLoading.value = false; }
    }

    async function openLog() {
      if (!sid()) return;
      logVisible.value = true; logLoading.value = true;
      try {
        const r = await axios.get('/api/statistics/sync-log', { params: { store_id: sid() } });
        missingDates.value = r.data.missing_dates || [];
        syncRuns.value = r.data.runs || [];
        logToday.value = r.data.today || '';
      } catch (e) { error.value = message(e); }
      finally { logLoading.value = false; }
    }

    function copyUnit(value) {
      if (!value) return;
      navigator.clipboard?.writeText(value).then(() => {
        ElementPlus.ElMessage.success('已复制');
      }).catch(() => {});
    }

    // CSV 单元格：数字直接输出（Excel 才能求和），文本按需加引号并防公式注入
    function csvCell(value) {
      if (value == null) return '';
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      const text = String(value);
      if (!/[",\r\n]/.test(text) && !/^[=+@\t]/.test(text)) return text;
      return `"${(/^[=+@\t]/.test(text) ? "'" : '') + text.replaceAll('"', '""')}"`;
    }

    async function exportCsv() {
      if (!sid() || exporting.value) return;
      exporting.value = true; error.value = '';
      try {
        const params = queryParams();
        const pageSize = 2000;
        const all = [];
        let total = 0;
        // 按 total 循环拉全量（导出走大页，最多 100 页 = 20 万行兜底）
        for (let p = 1; p <= 100; p++) {
          const response = await axios.get('/api/statistics/accruals', { params: { ...params, export: 1, page: p, page_size: pageSize } });
          const chunk = response.data.rows || [];
          total = Number(response.data.total || 0);
          all.push(...chunk);
          if (!chunk.length || all.length >= total) break;
        }
        if (!all.length) { ElementPlus.ElMessage.warning('当前筛选条件没有数据'); return; }
        const header = ['应计日', '订单号', '来源', '单元类型', '费用项目', '项目ID', '类别', '合并笔数', '费用_RUB'];
        const lines = [header.map(csvCell).join(',')];
        for (const row of all) {
          lines.push([
            row.accrued_date, row.unit_number || '', row.source === 'ad_report' ? '逐单广告' : 'Ozon',
            row.unit_type, typeName(row.type_id), row.type_id == null ? '' : row.type_id,
            categoryName(row.category), row.entries, row.amount,
          ].map(csvCell).join(','));
        }
        const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url; link.download = `结算明细_${params.from}_${params.to}.csv`;
        document.body.appendChild(link); link.click(); link.remove();
        URL.revokeObjectURL(url);
        ElementPlus.ElMessage.success(`已导出 ${all.length.toLocaleString('zh-CN')} 行`);
      } catch (e) {
        error.value = message(e);
      } finally {
        exporting.value = false;
      }
    }

    async function importOrderAd(event) {
      const file = event.target.files?.[0]; event.target.value = '';
      if (!file) return;
      if (!window.XLSX) { ElementPlus.ElMessage.error('Excel 组件未加载，请刷新重试'); return; }
      if (file.size > 20 * 1024 * 1024) { ElementPlus.ElMessage.error('文件不能超过 20MB'); return; }
      orderAdBusy.value = true;
      try {
        const book = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true, nodim: true });
        const sheet = book.Sheets[book.SheetNames[0]];
        const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
        const headerIndex = matrix.findIndex((r) => r.some((c) => String(c ?? '').trim() === '订单号') && r.some((c) => String(c ?? '').trim() === '订单来源'));
        if (headerIndex < 0) throw new Error('找不到表头（需要包含「订单号」「订单来源」列）');
        const head = matrix[headerIndex].map((c) => String(c ?? '').replace(/\s+/g, ' ').trim());
        const col = (name) => head.findIndex((c) => c === name || c.startsWith(name));
        const iDate = col('日期'), iOrder = col('订单号'), iSku = col('SKU'), iQty = col('数量'),
          iFee = col('费用'), iSrc = col('订单来源'), iId = col('订单 ID');
        if ([iDate, iOrder, iSku, iQty, iFee, iSrc].some((i) => i < 0)) throw new Error('缺少必要列：日期 / 订单号 / SKU / 数量 / 费用 / 订单来源');
        const entries = [];
        for (const [i, row] of matrix.slice(headerIndex + 1).entries()) {
          if (!row || row.every((v) => v == null || v === '')) continue;
          const src = String(row[iSrc] ?? '');
          const mode = src.includes('点击') ? 'cpc' : src.includes('按订单') ? 'cpo' : '';
          if (!mode) throw new Error(`第 ${headerIndex + i + 2} 行「订单来源」无法识别：${src}`);
          const rawDate = row[iDate];
          let date;
          if (rawDate instanceof Date) date = [rawDate.getFullYear(), String(rawDate.getMonth() + 1).padStart(2, '0'), String(rawDate.getDate()).padStart(2, '0')].join('-');
          else {
            const matched = String(rawDate ?? '').trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
            date = matched ? `${matched[3]}-${matched[2].padStart(2, '0')}-${matched[1].padStart(2, '0')}` : String(rawDate ?? '').trim();
          }
          const fee = Number(String(row[iFee] ?? '').replace(/[^\d.-]/g, ''));
          entries.push({ date, order_number: String(row[iOrder] ?? '').trim(), sku: String(row[iSku] ?? '').trim(), mode,
            cents: Math.round(fee * 100), quantity: Number(row[iQty] ?? 0), order_id: iId < 0 ? '' : String(row[iId] ?? '').trim() });
        }
        if (!entries.length) throw new Error('文件里没有有效数据行');
        const post = (force) => axios.post('/api/statistics/advertising/order-report', { store_id: sid(), entries, force });
        let response;
        try { response = await post(false); }
        catch (e) {
          const data = e?.response?.data;
          if (e?.response?.status === 409 && Array.isArray(data?.checks)) {
            // 把每天的差异摊开给用户看，确认后再强制导入
            checkRows.value = data.checks.filter((c) => c.status !== 'ok');
            checkMessage.value = data.message || '校验未通过';
            checkTotal.value = data.total_diff || 0;
            pendingEntries.value = entries;
            checkVisible.value = true;
            return;
          }
          throw e;
        }
        const data = response.data;
        ElementPlus.ElMessage.success(`导入完成：写入 ${data.days_written} 天 / ${data.rows_written} 条，未变 ${data.days_unchanged} 天，匹配 ${data.matched_orders} 单 · ₽${money(data.matched_rub)}`);
        if (data.unmatched_entries) ElementPlus.ElMessage.warning(`有 ${data.unmatched_entries} 条未能归到订单（₽${money(data.unmatched_rub)}）`);
        if (data.shifted_days) ElementPlus.ElMessage.info(`${data.shifted_days} 天因结算日顺延已自动平衡（相邻两天差额互相抵消）`);
        await load();
        await openAdLog();
      } catch (e) {
        const msg = e?.response?.data?.error || e?.message || '导入失败';
        if (msg && !msg.includes('cancel')) ElementPlus.ElMessage.error(msg);
      } finally { orderAdBusy.value = false; }
    }

    const shopChanged = () => { page.value = 1; load(); };

    onMounted(() => {
      window.addEventListener('shop-changed', shopChanged);
      load();
    });
    onBeforeUnmount(() => {
      window.removeEventListener('shop-changed', shopChanged);
    });

    return { MIN_DATE, dateRange, rangeTouched, rows, total, summary, run, page, pageSize, loading, syncing, exporting, error,
      posting, typeId, category, source, accrualRange, typeOptions, activeRun, progress, lastUpdated, adItems,
      adTipOpen, adEnter, adLeave, adToggle, adVisibleChange, incTipOpen, incEnter, incLeave, incToggle, incVisibleChange,
      typeName, categoryName, money, load, applyFilter, resetFilters, rangeChanged, pageChanged,
      syncNow, copyUnit, exportCsv, orderAdBusy, orderAdInput, importOrderAd,
      logVisible, logLoading, syncRuns, missingDates, logToday, openLog,
      adLogVisible, adLogLoading, adDays, adMissing, adSummary, openAdLog,
      checkVisible, checkRows, checkMessage, checkTotal, forceImport };
  },

  template: `
  <section class="statistics-workbench statistics-settlement">
    <header class="statistics-heading">
      <div>
        <h2>结算明细</h2>
        <div class="statistics-meta">Ozon 应计原始数据 · 按订单号+应计日+费用项目归并 · 默认查最近一个月，按应计日倒序<span v-if="run?.finished_at"> · 同步 {{lastUpdated}}</span><span v-if="activeRun"> · 同步中 {{run.days_done}}/{{run.days_total}}</span></div>
      </div>
      <div class="statistics-actions">
        <span class="statistics-range-label">同步区间</span>
        <el-date-picker v-model="dateRange" type="daterange" value-format="YYYY-MM-DD" format="MM-DD"
          range-separator="至" start-placeholder="开始" end-placeholder="结束"
          :clearable="false" :disabled-date="(d) => d < new Date(MIN_DATE) || d > new Date()"
          @change="rangeChanged" style="width:250px"/>
        <el-tooltip content="按左侧日期区间拉取结算数据" placement="bottom">
          <el-button type="primary" :icon="'Refresh'" :loading="syncing" :disabled="activeRun" @click="syncNow">
            {{activeRun ? '同步中…' : '立即更新'}}
          </el-button>
        </el-tooltip>
        <el-button :icon="'Document'" @click="openLog">同步记录</el-button>
      </div>
    </header>

    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" style="margin-bottom:12px"/>
    <el-alert v-if="activeRun" :title="(run.message || '正在拉取结算数据') + '（' + (run.days_done||0) + '/' + (run.days_total||0) + ' 天）'" type="info" :closable="false" show-icon style="margin-bottom:12px"/>

    <div class="statistics-metrics statistics-metrics-6">
      <div><span>费用行数</span><strong>{{total.toLocaleString('zh-CN')}}<small>行</small></strong></div>
      <div><span>收款合计</span><strong>{{money(summary.income_rub)}}<small>₽</small></strong>
        <el-popover :visible="incTipOpen" placement="bottom-start" :width="320" trigger="click" popper-class="statistics-ad-pop"
          @update:visible="incVisibleChange">
          <template #reference>
            <div class="statistics-ad-summary" @mouseenter="incEnter" @mouseleave="incLeave" @click.stop="incToggle">
              <span>买家实付 <b>{{money(summary.sale_total_rub)}}</b></span>
            </div>
          </template>
          <div class="statistics-ad-detail">
            <div class="ad-head">收款构成 · ₽</div>
            <div class="ad-row"><span>买家实付</span><b>{{money(summary.sale_total_rub)}}</b></div>
            <div class="ad-row"><span>佣金</span><b>{{money(summary.commission_rub)}}</b></div>
            <div class="ad-row" v-if="Math.abs(summary.income_delivery_rub || 0) >= 0.01"><span>内嵌配送费</span><b>{{money(summary.income_delivery_rub)}}</b></div>
            <div class="ad-row" v-if="Math.abs(summary.income_refund_rub || 0) >= 0.01"><span>收单手续费退回</span><b>{{money(summary.income_refund_rub)}}</b></div>
            <div class="ad-row" v-if="Math.abs(summary.income_netting_rub || 0) >= 0.01"><span>同组正负相抵</span><b>−{{money(summary.income_netting_rub)}}</b></div>
            <div class="ad-row" v-if="Math.abs(summary.income_return_sale_rub || 0) >= 0.01"><span>退货销售额</span><b>+{{money(summary.income_return_sale_rub)}}</b></div>
            <div class="ad-row" v-if="Math.abs(summary.income_return_comm_rub || 0) >= 0.01"><span>退货佣金退回</span><b>{{money(summary.income_return_comm_rub)}}</b></div>
            <div class="ad-total"><span>卖家实收</span><b>{{money(summary.income_rub)}}</b></div>
          </div>
        </el-popover>
      </div>
      <div><span>扣费合计</span><strong>{{money(summary.expense_rub)}}<small>₽</small></strong><small>不含佣金与广告</small></div>
      <div><span>净额</span><strong>{{money(summary.net_rub)}}<small>₽</small></strong><small>实收 − 扣费</small></div>
      <div class="statistics-ad-card"><span>广告投入</span><strong class="statistics-negative">{{money(Math.abs(summary.ad_rub || 0))}}<small>₽</small></strong>
        <el-popover :visible="adTipOpen" placement="bottom-start" :width="300" trigger="click" popper-class="statistics-ad-pop"
          @update:visible="adVisibleChange">
          <template #reference>
            <div class="statistics-ad-summary" @mouseenter="adEnter" @mouseleave="adLeave" @click.stop="adToggle">
              <span>订单 <b>{{money(adItems.shop)}}</b></span>
              <span>点击 <b>{{money(adItems.click)}}</b></span>
            </div>
          </template>
          <div class="statistics-ad-detail">
            <div class="ad-head">广告构成 · ₽</div>
            <div class="ad-row"><span>54 商品推广</span><b>{{money(adItems.shop)}}</b></div>
            <div v-if="adItems.hasImport" class="ad-row sub"><span>订单</span><b>{{money(adItems.cpo)}}</b></div>
            <div v-if="Math.abs(adItems.cpc) >= 0.01" class="ad-row sub"><span>点击</span><b>{{money(adItems.cpc)}}</b></div>
            <div v-if="Math.abs(adItems.click) >= 0.01" class="ad-row"><span>41 点击消耗</span><b>{{money(adItems.click)}}</b></div>
            <div v-if="Math.abs(adItems.brand) >= 0.01" class="ad-row"><span>3 品牌推广</span><b>{{money(adItems.brand)}}</b></div>
            <div class="ad-total"><span>合计</span><b>{{money(adItems.total)}}</b></div>
            <div v-if="Math.abs(adItems.delayed) >= 0.01" class="ad-note">含月末延迟入账 {{money(adItems.delayed)}}；按 Ozon 结算口径为 {{money(adItems.settlement)}}</div>
          </div>
        </el-popover>
      </div>
      <div><span>订单收入</span><strong :class="{'statistics-negative': (summary.order_income_rub || 0) < 0}">{{money(summary.order_income_rub)}}<small>₽</small></strong><small>净额 − 广告投入</small></div>
    </div>

    <div class="statistics-toolbar">
      <div class="statistics-filters">
        <el-date-picker v-model="accrualRange" type="daterange" value-format="YYYY-MM-DD" format="YYYY-MM-DD"
          range-separator="至" start-placeholder="应计起始" end-placeholder="应计截止"
          :clearable="false" :disabled-date="(d) => d < new Date(MIN_DATE) || d > new Date()"
          @change="applyFilter" style="width:236px"/>
        <el-input v-model="posting" placeholder="订单号 / 广告活动ID" clearable @keyup.enter="applyFilter" @clear="applyFilter" style="width:172px"/>
        <el-select v-model="typeId" placeholder="全部费用项目" clearable @change="applyFilter" style="width:158px">
          <el-option v-for="item in typeOptions" :key="item.value" :label="item.label" :value="item.value"/>
        </el-select>
        <el-select v-model="category" placeholder="全部类别" clearable @change="applyFilter" style="width:112px">
          <el-option label="商品级" value="ITEM"/><el-option label="非商品级" value="NON_ITEM"/><el-option label="订单级" value="POSTING"/>
        </el-select>
        <el-select v-model="source" placeholder="全部来源" clearable @change="applyFilter" style="width:112px">
          <el-option label="Ozon" value="ozon"/><el-option label="逐单广告" value="ad_report"/>
        </el-select>
        <el-button :icon="'Search'" @click="applyFilter">查询</el-button>
        <el-button :icon="'RefreshLeft'" @click="resetFilters">重置</el-button>
        <el-tooltip content="导出当前筛选结果（全部列，含来源与项目ID）"><el-button :icon="'Download'" circle aria-label="导出" :loading="exporting" @click="exportCsv"/></el-tooltip>
        <el-button :icon="'Tickets'" class="statistics-import-btn" @click="openAdLog">导入逐单报表</el-button>
      </div>
    </div>

    <el-table :data="rows" v-loading="loading" size="small" border height="calc(100vh - 430px)" style="width:100%">
      <el-table-column prop="accrued_date" label="应计日" width="105" fixed/>
      <el-table-column label="订单号" min-width="200" fixed>
        <template #default="{row}">
          <span style="font-family:ui-monospace,monospace">{{row.unit_number || '—'}}</span>
          <el-button link :icon="'CopyDocument'" size="small" aria-label="复制订单号" @click="copyUnit(row.unit_number)"/>
        </template>
      </el-table-column>
      <el-table-column prop="source" label="来源" width="92">
        <template #default="{row}">
          <el-tag size="small" :type="row.source === 'ad_report' ? 'warning' : 'info'" effect="plain">{{row.source === 'ad_report' ? '逐单广告' : 'Ozon'}}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="unit_type" label="单元类型" width="105">
        <template #default="{row}">
          <el-tag size="small" :type="row.unit_type === '完整订单号' ? 'success' : row.unit_type === '主订单号' ? 'warning' : row.unit_type === '广告活动' ? 'info' : 'danger'">{{row.unit_type}}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="费用项目" min-width="190">
        <template #default="{row}"><span :class="{'statistics-warning': row.type_id == null}">{{typeName(row.type_id)}}</span></template>
      </el-table-column>
      <el-table-column label="项目ID" width="78" align="right">
        <template #default="{row}"><span style="font-family:ui-monospace,monospace;color:#64748b">{{row.type_id == null ? '—' : row.type_id}}</span></template>
      </el-table-column>
      <el-table-column prop="category" label="类别" width="100">
        <template #default="{row}">{{categoryName(row.category)}}</template>
      </el-table-column>
      <el-table-column prop="entries" label="合并笔数" width="95" align="right"/>
      <el-table-column label="费用 ₽" width="135" align="right">
        <template #default="{row}">
          <span :style="{color: Number(row.amount) < 0 ? '#dc2626' : '#15803d', fontWeight: 600}">{{money(row.amount)}}</span>
        </template>
      </el-table-column>
    </el-table>

    <div class="statistics-toolbar" style="margin-top:10px">
      <span>共 {{total.toLocaleString('zh-CN')}} 行</span>
      <el-pagination v-model:current-page="page" v-model:page-size="pageSize" :total="total"
        :page-sizes="[50,100,200,500]" layout="sizes, prev, pager, next, jumper"
        @size-change="pageChanged" @current-change="pageChanged"/>
    </div>
    <el-dialog v-model="logVisible" title="同步记录" width="920px" top="6vh" class="statistics-dialog">
      <div v-loading="logLoading">
        <div v-if="missingDates.length" class="statistics-data-note" style="max-height:120px;overflow:auto">
          <b>未同步日期（{{missingDates.length}} 天）</b>
          <div style="margin-top:4px;font-family:ui-monospace,monospace">{{missingDates.join('、')}}</div>
        </div>
        <el-alert v-else type="success" :closable="false" show-icon
          :title="'2026-07-01 至 ' + (logToday || '今天') + ' 全部日期均已同步'" style="margin-bottom:10px"/>
        <el-table :data="syncRuns" border size="small" max-height="430" empty-text="还没有同步记录">
          <el-table-column prop="started_at" label="开始时间" width="150"/>
          <el-table-column label="同步范围" min-width="190">
            <template #default="{row}">{{row.from_date}} ~ {{row.to_date}}</template>
          </el-table-column>
          <el-table-column label="天数" width="72" align="right">
            <template #default="{row}">{{row.days_done || 0}}/{{row.days_total || 0}}</template>
          </el-table-column>
          <el-table-column label="数据条数" width="92" align="right">
            <template #default="{row}">{{row.records == null ? '—' : Number(row.records).toLocaleString('zh-CN')}}</template>
          </el-table-column>
          <el-table-column label="方式" width="72">
            <template #default="{row}">{{row.trigger === 'daily' ? '自动' : '手动'}}</template>
          </el-table-column>
          <el-table-column label="结果" width="82">
            <template #default="{row}">
              <el-tag size="small" :type="row.status === 'succeeded' ? 'success' : row.status === 'failed' ? 'danger' : 'info'">
                {{row.status === 'succeeded' ? '成功' : row.status === 'failed' ? '失败' : '进行中'}}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="说明" min-width="210" show-overflow-tooltip>
            <template #default="{row}">{{row.status === 'failed' ? (row.error || row.message) : row.message}}</template>
          </el-table-column>
        </el-table>
      </div>
    </el-dialog>

    <el-dialog v-model="adLogVisible" title="逐单广告" width="940px" top="4vh" class="statistics-dialog">
      <div v-loading="adLogLoading">
        <div class="statistics-metrics statistics-metrics-dialog" style="margin-bottom:10px">
          <div><span>已导入天数</span><strong>{{adSummary.days || 0}}<small>天</small></strong></div>
          <div><span>明细条数</span><strong>{{Number(adSummary.entries || 0).toLocaleString('zh-CN')}}</strong></div>
          <div><span>结算广告</span><strong>{{money(adSummary.db54)}}<small>₽</small></strong><small>type 54 合计</small></div>
          <div><span>按订单付费</span><strong>{{money(adSummary.cpo)}}<small>₽</small></strong></div>
          <div><span>按点击付费</span><strong>{{money(adSummary.cpc)}}<small>₽</small></strong></div>
          <div><span>真差异</span><strong :class="{'statistics-negative': Math.abs(adSummary.diff || 0) > 0.01}">{{money(adSummary.diff)}}<small>₽</small></strong>
            <small>顺延 {{adSummary.shifted || 0}} 天 · 缺明细 {{adSummary.missing || 0}} 天</small></div>
        </div>

        <el-table :data="adDays" border size="small" height="360" empty-text="还没有导入过逐单广告">
          <el-table-column prop="date" label="广告日期" width="112" fixed/>
          <el-table-column label="结算广告 ₽" width="128" align="right">
            <template #default="{row}">{{money(row.db54)}}</template>
          </el-table-column>
          <el-table-column label="按订单付费 ₽" width="128" align="right">
            <template #default="{row}">{{Number(row.cpo) ? money(row.cpo) : '—'}}</template>
          </el-table-column>
          <el-table-column label="按点击付费 ₽" width="128" align="right">
            <template #default="{row}">{{Number(row.cpc) ? money(row.cpc) : '—'}}</template>
          </el-table-column>
          <el-table-column prop="entries" label="明细条数" width="92" align="right"/>
          <el-table-column label="差异 ₽" min-width="170" align="right">
            <template #default="{row}">
              <span :style="{color: row.status === 'diff' ? '#b45309' : row.status === 'shift' || row.status === 'ok' ? '#15803d' : '#94a3b8', fontWeight: 600}">
                {{row.status === 'none' || row.status === 'missing' ? '—' : money(row.diff)}}
              </span>
              <div v-if="row.shift_with" class="statistics-cell-note">与 {{row.shift_with}} 顺延抵消</div>
              <div v-else-if="row.status === 'missing'" class="statistics-cell-note">结算有、明细未导入</div>
              <div v-else-if="row.status === 'none'" class="statistics-cell-note">两边都没有</div>
            </template>
          </el-table-column>
        </el-table>

        <div style="margin-top:12px;padding-top:10px;border-top:1px solid #e5e9eb">
          <el-button type="primary" :icon="'Upload'" :loading="orderAdBusy" @click="orderAdInput.click()">选择文件导入</el-button>
          <input ref="orderAdInput" type="file" accept=".xlsx,.xls" hidden @change="importOrderAd"/>
          <div class="statistics-meta" style="margin-top:8px;line-height:1.75;white-space:normal">
            <b>导出路径</b>：Ozon 卖家后台 → 广告 → 报表 → <b>按订单支付（部分商品）</b> → 选择日期范围 → 下载 Excel<br>
            对比口径：结算明细的 type 54 = 按订单付费 + 按点击付费；相差一天且金额相等的，自动判为顺延抵消。
          </div>
        </div>
      </div>
    </el-dialog>

    <el-dialog v-model="checkVisible" title="校验未通过" width="720px" top="9vh" class="statistics-dialog">
      <el-alert type="warning" :closable="false" show-icon :title="checkMessage"/>
      <div class="statistics-meta" style="margin:10px 0 8px;white-space:normal">
        整期差额合计 <b style="color:#b45309">{{money(checkTotal)}} ₽</b>
        · 标「顺延」的是相邻两天互相抵消，会自动平衡；只有标「差异」的才需要人工判断
      </div>
      <el-table :data="checkRows" border size="small" height="280">
        <el-table-column prop="date" label="日期" width="118"/>
        <el-table-column label="文件合计" width="140" align="right">
          <template #default="{row}">{{money(row.csv)}}</template>
        </el-table-column>
        <el-table-column label="结算明细" width="140" align="right">
          <template #default="{row}">{{row.db == null ? '0（无记录）' : money(row.db)}}</template>
        </el-table-column>
        <el-table-column label="差额" align="right" width="150">
          <template #default="{row}">
            <span :style="{color: row.status === 'shift' ? '#15803d' : '#b45309', fontWeight:600}">{{money(row.diff)}}</span>
            <div v-if="row.shift_with" class="statistics-cell-note">与 {{row.shift_with}} 抵消</div>
          </template>
        </el-table-column>
        <el-table-column label="判定" width="86" align="center">
          <template #default="{row}">
            <el-tag size="small" :type="row.status === 'shift' ? 'success' : row.status === 'missing' ? 'info' : 'warning'">
              {{row.status === 'shift' ? '顺延' : row.status === 'missing' ? '缺记录' : '差异'}}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="checkVisible = false">取消</el-button>
        <el-button type="warning" :loading="orderAdBusy" @click="forceImport">仍要导入</el-button>
      </template>
    </el-dialog>
  </section>`,
};
