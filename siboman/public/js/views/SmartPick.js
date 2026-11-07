/**
 * AI 智选工作台 (SmartPick) v1.0 — Accio Work 修改 (2026-11-07)
 * 复刻 newmy.jizhangerp.com/smart-pick/ 的五阶段流水线工作台：
 *   01 选品筛选 → 02 1688 自动找货 → 03 同款核验 → 04 采购与利润预筛 → 05 核价好品/一键跟卖
 * 已按需求整体移除原版的旺旺询价链路，改为「确认包装并核价」「报价（实际拿货价）」直接核价晋升。
 * 1688 找货与 AI 视觉同款核验走「插件 + 服务端双通道」，本页通过 /api/smart-pick/* 与后端引擎协同。
 */
window.SmartPickView = {
  setup() {
    const loading = Vue.ref(false);
    const acting = Vue.ref(false);
    const task = Vue.ref(null);
    const items = Vue.ref([]);
    const summary = Vue.ref(null);
    const categories = Vue.ref([]);
    const selectedIds = Vue.ref([]);
    const theme = Vue.ref(localStorage.getItem('sp-theme') || 'dark');
    const stageFilter = Vue.ref('all');
    const elimFilter = Vue.ref('all');
    const searchKw = Vue.ref('');
    const autoRefresh = Vue.ref(true);
    const pluginOnline = Vue.ref(null);
    const sourcingTicker = Vue.ref(0);

    // ---- 弹窗状态 ----
    const policyDialog = Vue.ref(false);
    const policySaving = Vue.ref(false);
    const policyForm = Vue.reactive({});
    const confirmDialog = Vue.ref(false);
    const confirmSaving = Vue.ref(false);
    const confirmForm = Vue.reactive({ grossWeightG: null, lengthCm: null, widthCm: null, heightCm: null, source: 'manual' });
    const quoteDialog = Vue.ref(false);
    const quoteSaving = Vue.ref(false);
    const quoteForm = Vue.reactive({ actualCostCny: null, moqText: '', note: '' });
    const compareDialog = Vue.ref(false);
    const compareItem = Vue.ref(null);
    const actItem = Vue.ref(null);

    const notify = {
      success: (m) => (window.ElementPlus?.ElMessage || console).success?.(m),
      warning: (m) => (window.ElementPlus?.ElMessage || console).warning?.(m),
      error: (m) => (window.ElementPlus?.ElMessage || console).error?.(m),
    };

    // ---- 阶段常量 ----
    const STAGE_META = {
      idle: { step: '01', name: '选品筛选', desc: '候选池待找货', cls: 'sp-status-idle' },
      queued: { step: '01', name: '选品筛选', desc: '已排队等待自动找货', cls: 'sp-status-idle' },
      sourcing: { step: '02', name: '1688 自动找货', desc: '双通道图搜与 AI 视觉核验中', cls: 'sp-status-matched' },
      matched: { step: '04', name: '采购与利润预筛', desc: '已核验同款，待确认包装核价', cls: 'sp-status-matched' },
      good: { step: '05', name: '核价好品', desc: '已核真实利润率', cls: 'sp-status-good' },
      listed: { step: '05', name: '已跟卖/已入库', desc: '已推送到跟卖或采集箱', cls: 'sp-status-listed' },
      no_source: { step: '04', name: '无同款', desc: '预算内未找到同款货源', cls: 'sp-status-elim' },
      over_budget: { step: '04', name: '超拿货预算', desc: '同款价超出预算上限', cls: 'sp-status-elim' },
      low_margin: { step: '04', name: '利润不达标', desc: '预估利润率低于目标', cls: 'sp-status-elim' },
      not_single: { step: '04', name: '非一件起批', desc: '起批量不满足策略要求', cls: 'sp-status-elim' },
      rejected: { step: '04', name: '人工淘汰', desc: '已人工标记淘汰', cls: 'sp-status-elim' },
      failed: { step: '04', name: '找货失败', desc: '双通道均未完成，可重试', cls: 'sp-status-elim' },
    };
    const PIPELINE = [
      { key: 'filter', step: '01', name: '选品筛选', desc: '按策略自动筛池：价格带 × 销量 × 跟卖数 × 重量 × 类目', stages: ['idle', 'queued'] },
      { key: 'sourcing', step: '02', name: '1688 自动找货', desc: '插件 + 服务端双通道图搜，共享同款缓存秒级复用', stages: ['sourcing'] },
      { key: 'verify', step: '03', name: '同款核验', desc: 'AI 视觉比对 Ozon 主图与 1688 货源图，输出置信度', stages: ['sourcing', 'matched', 'good'] },
      { key: 'precheck', step: '04', name: '采购与利润预筛', desc: '预算/利润率/起批量硬过滤，淘汰原因逐条落库', stages: ['matched', 'no_source', 'over_budget', 'low_margin', 'not_single', 'rejected', 'failed'] },
      { key: 'final', step: '05', name: '核价好品 / 一键跟卖', desc: '确认包装核价 → 报实际拿货价 → 加入采集箱 / 跟卖', stages: ['good', 'listed'] },
    ];
    const STAGE_TEXT = { idle: '待处理', queued: '已排队', sourcing: '找货中', matched: '已核同款', good: '★ 好品', listed: '已跟卖', no_source: '无同款', over_budget: '超预算', low_margin: '利润低', not_single: '非一件起批', rejected: '已淘汰', failed: '失败待重试' };
    const ELIM_STAGES = ['no_source', 'over_budget', 'low_margin', 'not_single', 'rejected', 'failed'];

    // ---- 请求封装：直连 /api/smart-pick/*（axios 拦截器自动补 store_id）----
    const api = async (method, url, body) => {
      const res = await axios.request({ method, url, data: body, timeout: 90000 });
      return res?.data;
    };

    const applyBundle = (data) => {
      if (!data) return;
      if (data.task) task.value = data.task;
      if (data.summary) summary.value = data.summary;
      if (Array.isArray(data.list)) items.value = data.list;
      else if (Array.isArray(data.items)) items.value = data.items;
      selectedIds.value = selectedIds.value.filter((id) => items.value.some((x) => x.id === id));
    };

    const loadTask = async (silent = false) => {
      if (!silent) loading.value = true;
      try {
        const data = await api('get', '/api/smart-pick/tasks');
        applyBundle({ task: data?.task, summary: data?.summary });
        const listRes = await api('get', `/api/smart-pick/tasks/${data?.task?.id}/items`);
        applyBundle(listRes);
      } catch (e) {
        notify.error(e?.response?.data?.error || '智选任务加载失败');
      } finally {
        loading.value = false;
      }
    };

    const loadCategories = async () => {
      try {
        const data = await api('get', '/api/smart-pick/categories');
        categories.value = data?.categories || [];
      } catch (_e) { /* 静默，不影响主流程 */ }
    };

    const checkPlugin = async () => {
      try {
        if (typeof window.__zhumeng_send__ !== 'function') { pluginOnline.value = false; return; }
        const r = await window.__zhumeng_send__('ping.request', {}, 5000);
        pluginOnline.value = Boolean(r && r.ok);
      } catch (_e) { pluginOnline.value = false; }
    };

    // ---- 派生数据 ----
    const counts = Vue.computed(() => summary.value?.counts || {});
    const stageCounts = (stages) => stages.reduce((acc, s) => acc + Number(counts.value[s] || 0), 0);
    const filteredItems = Vue.computed(() => {
      let list = items.value;
      if (stageFilter.value !== 'all') list = list.filter((x) => x.sourcingStage === stageFilter.value);
      if (elimFilter.value !== 'all') list = list.filter((x) => (x.sourcingStage === 'none' ? false : elimFilter.value === 'has' ? ELIM_STAGES.includes(x.sourcingStage) : !ELIM_STAGES.includes(x.sourcingStage)));
      const kw = searchKw.value.trim().toLowerCase();
      if (kw) list = list.filter((x) => String(x.name || '').toLowerCase().includes(kw) || String(x.sku || '').includes(kw) || (x.sourcing?.best?.title || '').toLowerCase().includes(kw));
      return list;
    });
    const activeCount = Vue.computed(() => Number(counts.value.sourcing || 0) + Number(counts.value.queued || 0));
    const engineKpis = Vue.computed(() => {
      const s = summary.value || {};
      const goodTotal = Number(counts.value.good || 0) + Number(counts.value.listed || 0);
      const matched = Number(counts.value.matched || 0);
      const hitRate = s.total ? Math.round(((matched + goodTotal) / s.total) * 100) : 0;
      return {
        goodTotal,
        hitRate,
        avgGoodMargin: s.avgGoodMargin,
        sharedHits: s.sharedHitCount,
        active: s.active,
      };
    });
    const adviceText = Vue.computed(() => summary.value?.eliminationSummary || '正在生成淘汰分析与调参建议…');
    const policyPills = Vue.computed(() => {
      const p = task.value?.policy || {};
      return [
        `售价 ${p.priceMin ?? 800}–${p.priceMax ?? 10000} ₽`,
        `月销 ≥ ${p.soldMin ?? 50}`,
        `跟卖 ≤ ${p.followMax ?? 10}`,
        `目标利润 ${p.targetMarginPct ?? 50}%`,
        `同款置信度 ≥ ${Math.round((p.minConfidence ?? 0.85) * 100)}%`,
        `货重 ≤ ${p.weightMax ?? 3000}g`,
      ];
    });

    const stageOf = (it) => STAGE_META[it?.sourcingStage] || STAGE_META.idle;
    const stageText = (it) => STAGE_TEXT[it?.sourcingStage] || it?.sourcingStage || '-';
    const fmtRub = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v).toLocaleString('ru-RU') : '—');
    const fmtCny = (v) => (v != null && Number.isFinite(Number(v)) ? `¥${Number(v).toFixed(2)}` : '—');
    const fmtMargin = (v) => (v != null && Number.isFinite(Number(v)) ? `${Number(v) > 0 ? '' : ''}${Number(v).toFixed(1)}%` : '—');
    const marginCls = (v) => {
      if (v == null || !Number.isFinite(Number(v))) return '';
      const n = Number(v);
      if (n >= 50) return 'sp-profit-pos';
      if (n >= 20) return 'sp-profit-mid';
      return 'sp-profit-neg';
    };
    const confPct = (it) => Math.round(Number(it?.sourcing?.best?.confidence || 0) * 100);
    const bestOf = (it) => it?.sourcing?.best || null;
    const candidatesOf = (it) => (Array.isArray(it?.sourcing?.candidates) ? it.sourcing.candidates : []);
    const ozonUrlOf = (it) => it?.ozonUrl || `https://www.ozon.ru/product/${it?.sku}/`;
    const detailUrlOf = (it) => bestOf(it)?.detailUrl || `https://detail.1688.com/offer/${bestOf(it)?.offerId}.html`;

    // ---- 选择 ----
    const toggleSelect = (it) => {
      const i = selectedIds.value.indexOf(it.id);
      if (i >= 0) selectedIds.value.splice(i, 1); else selectedIds.value.push(it.id);
    };
    const selectAll = () => {
      filteredItems.value.forEach((x) => { if (!selectedIds.value.includes(x.id)) selectedIds.value.push(x.id); });
    };
    const clearSelect = () => { selectedIds.value = []; };

    // ---- 批量操作 ----
    const autoSource = async () => {
      const ids = selectedIds.value.length ? selectedIds.value : items.value.filter((x) => ['idle', 'queued', 'failed'].includes(x.sourcingStage)).map((x) => x.id);
      if (!ids.length) { notify.warning('当前没有可找货的商品（待处理/排队/失败均可）'); return; }
      acting.value = true;
      try {
        const data = await api('post', `/api/smart-pick/tasks/${task.value.id}/source`, { itemIds: ids, limit: ids.length });
        applyBundle(data);
        notify.success(`双通道找货完成：处理 ${data?.result?.processed ?? 0} 件，核中同款 ${data?.result?.matched ?? 0} 件，好品 ${data?.result?.good ?? 0} 件（共享缓存命中 ${data?.result?.sharedHits ?? 0}）`);
        if (activeCount.value > 0) startTicker();
      } catch (e) {
        notify.error(e?.response?.data?.error || '自动找货请求失败');
      } finally { acting.value = false; }
    };

    const batchFinalize = async () => {
      const ids = selectedIds.value.filter((id) => {
        const it = items.value.find((x) => x.id === id);
        return it && ['matched', 'good'].includes(it.sourcingStage);
      });
      if (!ids.length) { notify.warning('请先勾选「已核同款/好品」状态的商品'); return; }
      acting.value = true;
      try {
        const data = await api('post', `/api/smart-pick/tasks/${task.value.id}/batch-finalize`, { itemIds: ids });
        applyBundle(data);
        notify.success(`一键核价晋升完成：${data?.result?.good ?? 0} 件晋升 ★ 好品`);
      } catch (e) {
        notify.error(e?.response?.data?.error || '一键核价失败');
      } finally { acting.value = false; }
    };

    const pushCollect = async () => {
      if (!selectedIds.value.length) { notify.warning('请先勾选商品'); return; }
      acting.value = true;
      try {
        const data = await api('post', `/api/smart-pick/tasks/${task.value.id}/collect-box`, { itemIds: selectedIds.value });
        applyBundle(data);
        notify.success(data?.message || `已加入采集箱 ${data?.pushed ?? 0} 件`);
      } catch (e) {
        notify.error(e?.response?.data?.error || '加入采集箱失败');
      } finally { acting.value = false; }
    };

    const pushFollowSell = async () => {
      if (!selectedIds.value.length) { notify.warning('请先勾选商品'); return; }
      acting.value = true;
      try {
        const data = await api('post', `/api/smart-pick/tasks/${task.value.id}/follow-sell`, { itemIds: selectedIds.value });
        applyBundle(data);
        notify.success(data?.message || `已推送跟卖 ${data?.pushed ?? 0} 件`);
      } catch (e) {
        notify.error(e?.response?.data?.error || '一键跟卖失败');
      } finally { acting.value = false; }
    };

    const removeItems = async () => {
      if (!selectedIds.value.length) { notify.warning('请先勾选要移除的商品'); return; }
      try {
        await window.ElementPlus.ElMessageBox.confirm(`确认移除选中的 ${selectedIds.value.length} 件商品？`, '移除确认', { type: 'warning' });
      } catch (_e) { return; }
      acting.value = true;
      try {
        const data = await api('post', `/api/smart-pick/tasks/${task.value.id}/items/delete`, { itemIds: selectedIds.value });
        applyBundle(data);
        notify.success(`已移除 ${data?.deleted ?? 0} 件`);
      } catch (e) {
        notify.error(e?.response?.data?.error || '移除失败');
      } finally { acting.value = false; }
    };

    const refill = async () => {
      acting.value = true;
      try {
        const data = await api('post', `/api/smart-pick/tasks/${task.value.id}/refill`, { limit: 30 });
        applyBundle(data);
        notify.success(data?.refill?.message || `已补充候选 ${data?.refill?.added ?? data?.total ?? 0} 件`);
      } catch (e) {
        notify.error(e?.response?.data?.error || '补池失败');
      } finally { acting.value = false; }
    };

    // ---- 导出 CSV ----
    const exportCsv = () => {
      const rows = (selectedIds.value.length ? items.value.filter((x) => selectedIds.value.includes(x.id)) : filteredItems.value);
      if (!rows.length) { notify.warning('当前没有可导出的数据'); return; }
      const head = ['Ozon SKU', 'Ozon 标题', '类目', '售价(₽)', '月销', '跟卖数', '预算(¥)', 'OGL运费(¥)', '1688货款(¥)', '1688链接', '同款置信度', '预估利润率(%)', '真实利润率(%)', '阶段', '淘汰原因'];
      const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
      const lines = [head.join(',')];
      for (const it of rows) {
        lines.push([
          it.sku, it.name, it.category3, it.priceRub, it.soldCount, it.followCount,
          Number(it.budgetCny || 0).toFixed(2), Number(it.freightCny || 0).toFixed(2),
          bestOf(it)?.priceCny ?? '', bestOf(it)?.detailUrl ?? '', confPct(it) || '',
          it.estMarginPct != null ? Number(it.estMarginPct).toFixed(1) : '',
          it.actualMarginPct != null ? Number(it.actualMarginPct).toFixed(1) : '',
          STAGE_TEXT[it.sourcingStage] || it.sourcingStage, it.sourcingReason || '',
        ].map(esc).join(','));
      }
      const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `AI智选_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    };

    // ---- 找货中自动轮询 ----
    let tickerTimer = null;
    const stopTicker = () => { if (tickerTimer) { clearInterval(tickerTimer); tickerTimer = null; } };
    const startTicker = () => {
      if (tickerTimer) return;
      tickerTimer = setInterval(async () => {
        sourcingTicker.value += 1;
        try {
          const data = await api('get', `/api/smart-pick/tasks/${task.value.id}/items`);
          applyBundle(data);
          if (activeCount.value === 0) { stopTicker(); if (autoRefresh.value) notify.success('本轮自动找货已全部完成'); }
        } catch (_e) { /* 静默重试 */ }
      }, 8000);
    };

    Vue.watchEffect(() => {
      if (activeCount.value > 0) startTicker(); else stopTicker();
    });

    // ---- 策略弹窗 ----
    const openPolicy = () => {
      const p = task.value?.policy || {};
      Object.assign(policyForm, JSON.parse(JSON.stringify(p)));
      policyDialog.value = true;
    };
    const savePolicy = async () => {
      policySaving.value = true;
      try {
        const data = await api('post', '/api/smart-pick/tasks', { policy: policyForm });
        applyBundle({ task: data?.task, summary: data?.summary });
        const listRes = await api('get', `/api/smart-pick/tasks/${data?.task?.id}/items`);
        applyBundle(listRes);
        policyDialog.value = false;
        notify.success('选品策略已保存，并已按新策略重算全池预算/运费/利润率');
      } catch (e) {
        notify.error(e?.response?.data?.error || '策略保存失败');
      } finally { policySaving.value = false; }
    };

    // ---- 确认包装并核价弹窗 ----
    const openConfirm = async (it) => {
      actItem.value = it;
      confirmForm.grossWeightG = it?.weightG ?? null;
      confirmForm.lengthCm = null; confirmForm.widthCm = null; confirmForm.heightCm = null;
      confirmForm.source = 'manual';
      confirmDialog.value = true;
      try {
        const data = await api('get', `/api/smart-pick/tasks/${task.value.id}/items/${it.id}/ozon-dims`);
        const d = data?.dims;
        if (d) {
          confirmForm.grossWeightG = d.grossWeightG;
          confirmForm.lengthCm = d.lengthCm; confirmForm.widthCm = d.widthCm; confirmForm.heightCm = d.heightCm;
          confirmForm.source = 'ozon';
          notify.info ? notify.info('已自动读取 Ozon 实测尺寸') : void 0;
        }
      } catch (_e) { /* 无实测时保持手填 */ }
    };
    const saveConfirm = async () => {
      if (!confirmForm.grossWeightG || !confirmForm.lengthCm || !confirmForm.widthCm || !confirmForm.heightCm) {
        notify.warning('请填写毛重与三边尺寸（cm）');
        return;
      }
      confirmSaving.value = true;
      try {
        const data = await api('post', `/api/smart-pick/tasks/${task.value.id}/items/${actItem.value.id}/finalize`, {
          grossWeightG: confirmForm.grossWeightG,
          lengthCm: confirmForm.lengthCm, widthCm: confirmForm.widthCm, heightCm: confirmForm.heightCm,
          source: confirmForm.source,
        });
        applyBundle(data);
        confirmDialog.value = false;
        notify.success(`已确认包装并核价：真实利润率 ${fmtMargin(data?.item?.actualMarginPct)}，晋升 ★ 好品`);
      } catch (e) {
        notify.error(e?.response?.data?.error || '核价失败');
      } finally { confirmSaving.value = false; }
    };

    // ---- 报价（实际拿货价）弹窗 ----
    const openQuote = (it) => {
      actItem.value = it;
      quoteForm.actualCostCny = it?.actualCostCny ?? bestOf(it)?.priceCny ?? null;
      quoteForm.moqText = bestOf(it)?.moqText || '';
      quoteForm.note = it?.note || '';
      quoteDialog.value = true;
    };
    const saveQuote = async () => {
      if (quoteForm.actualCostCny == null || !(Number(quoteForm.actualCostCny) > 0)) {
        notify.warning('请填写实际拿货价（元）');
        return;
      }
      quoteSaving.value = true;
      try {
        const data = await api('post', `/api/smart-pick/tasks/${task.value.id}/items/${actItem.value.id}/quote`, {
          actualCostCny: quoteForm.actualCostCny, moqText: quoteForm.moqText, note: quoteForm.note,
        });
        applyBundle(data);
        quoteDialog.value = false;
        notify.success(`已按实际拿货价 ¥${Number(quoteForm.actualCostCny).toFixed(2)} 核价：真实利润率 ${fmtMargin(data?.item?.actualMarginPct)}`);
      } catch (e) {
        notify.error(e?.response?.data?.error || '报价核价失败');
      } finally { quoteSaving.value = false; }
    };

    // ---- 1688 同款大图对比弹窗 ----
    const openCompare = (it) => { compareItem.value = it; compareDialog.value = true; };

    // ---- 主题切换 ----
    const toggleTheme = () => {
      theme.value = theme.value === 'dark' ? 'light' : 'dark';
      localStorage.setItem('sp-theme', theme.value);
    };

    const onImageError = (e) => {
      if (e?.target) { e.target.style.visibility = 'hidden'; e.target.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E'; }
    };

    Vue.onMounted(async () => {
      await loadTask();
      loadCategories();
      checkPlugin();
      if (activeCount.value > 0) startTicker();
    });
    Vue.onBeforeUnmount(stopTicker);

    return {
      loading, acting, task, items, summary, categories, selectedIds, theme, stageFilter, elimFilter,
      searchKw, autoRefresh, pluginOnline, sourcingTicker,
      policyDialog, policySaving, policyForm,
      confirmDialog, confirmSaving, confirmForm, quoteDialog, quoteSaving, quoteForm,
      compareDialog, compareItem, actItem,
      PIPELINE, STAGE_META, STAGE_TEXT, ELIM_STAGES,
      counts, stageCounts, filteredItems, activeCount, engineKpis, adviceText, policyPills,
      stageOf, stageText, fmtRub, fmtCny, fmtMargin, marginCls, confPct, bestOf, candidatesOf, ozonUrlOf, detailUrlOf,
      toggleSelect, selectAll, clearSelect,
      loadTask, autoSource, batchFinalize, pushCollect, pushFollowSell, removeItems, refill, exportCsv,
      openPolicy, savePolicy, openConfirm, saveConfirm, openQuote, saveQuote, openCompare, toggleTheme, onImageError,
      notify,
    };
  },
  template: `
    <div class="sp-page" :class="{ 'sp-theme-light': theme === 'light' }" v-loading="loading">
      <div class="sp-container">

        <!-- ═══ 顶部标题栏 ═══ -->
        <div class="sp-header">
          <div style="min-width:0">
            <div class="sp-title-row">
              <h1 class="sp-title">AI 智选工作台</h1>
              <span class="sp-badge sp-badge-ai">✦ 双通道 1688 图搜 + AI 视觉同款核验</span>
              <span v-if="pluginOnline === true" class="sp-badge sp-badge-plugin-ok">● 采集插件在线</span>
              <span v-else-if="pluginOnline === false" class="sp-badge sp-badge-plugin-warn">○ 插件离线（服务端通道兜底）</span>
            </div>
            <p class="sp-subtitle">
              从 Ozon 热销候选池 → 双通道自动找货 → AI 视觉同款核验 → 采购与利润预筛 → 核价晋升好品 / 一键跟卖。
              <template v-if="task">
                池内 {{ summary?.total ?? 0 }} 件候选
                <template v-if="activeCount > 0"> · <b style="color:#38bdf8">找货中 {{ activeCount }} 件（每 8 秒自动刷新）</b></template>
              </template>
            </p>
            <div class="sp-policy-pills">
              <span v-for="pill in policyPills" :key="pill" class="sp-policy-pill" v-html="pill"></span>
            </div>
          </div>
          <div class="sp-header-actions">
            <el-button size="small" @click="toggleTheme">{{ theme === 'dark' ? '☀ 浅色' : '🌙 深色' }}</el-button>
            <el-button size="small" @click="refill" :loading="acting">↻ 补充候选池</el-button>
            <el-button size="small" @click="loadTask(true)" :loading="loading">刷新</el-button>
            <el-button type="primary" size="small" @click="openPolicy">⚙ 选品策略</el-button>
          </div>
        </div>

        <!-- ═══ 五步全链路流水线 ═══ -->
        <div class="sp-pipeline-grid">
          <div v-for="p in PIPELINE" :key="p.key"
               class="sp-stage-card"
               :class="{ 'is-active': stageFilter !== 'all' && p.stages.includes(stageFilter), 'is-running': p.key === 'sourcing' && activeCount > 0 }"
               @click="stageFilter = p.stages.includes(stageFilter) ? 'all' : p.stages[0]">
            <div class="sp-stage-top">
              <span class="sp-stage-step">{{ p.step }}</span>
              <span class="sp-stage-count">{{ stageCounts(p.stages) }}</span>
            </div>
            <div class="sp-stage-name">{{ p.name }}</div>
            <div class="sp-stage-desc">{{ p.desc }}</div>
          </div>
        </div>

        <!-- ═══ 三大核心引擎指标 ═══ -->
        <div class="sp-engine-grid">
          <div class="sp-engine-card">
            <div class="sp-engine-head">
              <span class="sp-engine-title">🎯 同款命中率</span>
              <span class="sp-badge sp-badge-ai">引擎 ①</span>
            </div>
            <div class="sp-engine-main">
              <span class="sp-engine-kpi">{{ engineKpis.hitRate }}%</span>
              <span class="sp-engine-sub">共享缓存命中 {{ engineKpis.sharedHits }} 次 · 处理中 {{ engineKpis.active }} 件</span>
            </div>
          </div>
          <div class="sp-engine-card">
            <div class="sp-engine-head">
              <span class="sp-engine-title">💰 好品真实利润率</span>
              <span class="sp-badge sp-badge-ai">引擎 ②</span>
            </div>
            <div class="sp-engine-main">
              <span class="sp-engine-kpi">{{ engineKpis.avgGoodMargin != null ? engineKpis.avgGoodMargin + '%' : '—' }}</span>
              <span class="sp-engine-sub">基于确认包装重量 + 实际拿货价核算</span>
            </div>
          </div>
          <div class="sp-engine-card">
            <div class="sp-engine-head">
              <span class="sp-engine-title">★ 好品产出</span>
              <span class="sp-badge sp-badge-ai">引擎 ③</span>
            </div>
            <div class="sp-engine-main">
              <span class="sp-engine-kpi">{{ engineKpis.goodTotal }}</span>
              <span class="sp-engine-sub">已核同款 {{ counts.matched || 0 }} 件待晋升 · 已跟卖 {{ counts.listed || 0 }} 件</span>
            </div>
          </div>
        </div>

        <!-- ═══ 淘汰原因智能分析 ═══ -->
        <div class="sp-advice-banner">
          <div class="sp-advice-text">💡 <b>淘汰分析与调参建议：</b><span v-html="adviceText"></span></div>
        </div>

        <!-- ═══ 筛选 + 批量操作 ═══ -->
        <div class="sp-toolbar-panel">
          <div class="sp-filter-row">
            <div class="sp-chip-group">
              <span class="sp-chip" :class="{ 'is-active': stageFilter === 'all' }" @click="stageFilter = 'all'">全部 <span class="sp-chip-num">{{ summary?.total ?? items.length }}</span></span>
              <span class="sp-chip" :class="{ 'is-active': stageFilter === 'idle' }" @click="stageFilter = 'idle'">待处理 <span class="sp-chip-num">{{ counts.idle || 0 }}</span></span>
              <span class="sp-chip" :class="{ 'is-active': stageFilter === 'queued' }" @click="stageFilter = 'queued'">已排队 <span class="sp-chip-num">{{ counts.queued || 0 }}</span></span>
              <span class="sp-chip" :class="{ 'is-active': stageFilter === 'sourcing' }" @click="stageFilter = 'sourcing'">找货中 <span class="sp-chip-num">{{ counts.sourcing || 0 }}</span></span>
              <span class="sp-chip" :class="{ 'is-active': stageFilter === 'matched' }" @click="stageFilter = 'matched'">已核同款 <span class="sp-chip-num">{{ counts.matched || 0 }}</span></span>
              <span class="sp-chip" :class="{ 'is-active': stageFilter === 'good' }" @click="stageFilter = 'good'">★ 好品 <span class="sp-chip-num">{{ counts.good || 0 }}</span></span>
              <span class="sp-chip" :class="{ 'is-active': stageFilter === 'listed' }" @click="stageFilter = 'listed'">已跟卖 <span class="sp-chip-num">{{ counts.listed || 0 }}</span></span>
              <span class="sp-chip" :class="{ 'is-active': stageFilter === 'failed' }" @click="stageFilter = 'failed'">失败待重试 <span class="sp-chip-num">{{ counts.failed || 0 }}</span></span>
            </div>
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap">
              <el-radio-group v-model="elimFilter" size="small">
                <el-radio-button value="all">含淘汰</el-radio-button>
                <el-radio-button value="no">只看有效</el-radio-button>
                <el-radio-button value="has">只看淘汰</el-radio-button>
              </el-radio-group>
              <el-input v-model="searchKw" placeholder="搜索 SKU / 标题 / 1688 货源" clearable style="width:240px" />
              <el-checkbox v-model="autoRefresh" label="找货中自动刷新"></el-checkbox>
            </div>
          </div>
          <div class="sp-action-row">
            <div class="sp-action-left">
              <el-button type="primary" @click="autoSource" :loading="acting">🔍 自动找货{{ selectedIds.length ? '（' + selectedIds.length + '）' : '' }}</el-button>
              <el-button type="success" @click="batchFinalize" :loading="acting">✔ 一键核价晋升好品</el-button>
              <el-button type="warning" @click="pushFollowSell" :loading="acting">⚡ 一键跟卖</el-button>
              <el-button @click="pushCollect" :loading="acting">📦 加入采集箱</el-button>
              <el-button type="danger" plain @click="removeItems" :loading="acting">🗑 移除</el-button>
            </div>
            <div class="sp-action-right">
              <el-button size="small" @click="selectAll">全选当前筛选</el-button>
              <el-button size="small" @click="clearSelect">清空选择（{{ selectedIds.length }}）</el-button>
              <el-button size="small" type="primary" plain @click="exportCsv">⬇ 导出 CSV</el-button>
            </div>
          </div>
        </div>

        <!-- ═══ 商品对照主表 ═══ -->
        <div class="sp-table-wrap">
          <table class="sp-table">
            <thead>
              <tr>
                <th style="width:36px"></th>
                <th>Ozon 热销商品</th>
                <th style="width:110px">售价 / 月销</th>
                <th style="width:120px">重量 / 运费</th>
                <th style="width:110px">拿货预算</th>
                <th style="width:300px">1688 同款货源（AI 视觉核验）</th>
                <th style="width:110px">利润率</th>
                <th style="width:150px">阶段状态</th>
                <th style="width:130px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="it in filteredItems" :key="it.id" :class="{ 'is-good-row': it.sourcingStage === 'good' || it.sourcingStage === 'listed', }">
                <td><input type="checkbox" :checked="selectedIds.includes(it.id)" @change="toggleSelect(it)" style="width:16px;height:16px;cursor:pointer" /></td>
                <td>
                  <div class="sp-ozon-cell">
                    <img v-if="it.photo" class="sp-thumb" :src="it.photo" loading="lazy" @error="onImageError" @click="openCompare(it)" />
                    <div v-else class="sp-thumb" style="display:flex;align-items:center;justify-content:center;color:#64748b;font-weight:900">无图</div>
                    <div class="sp-ozon-meta">
                      <a class="sp-ozon-title" :href="ozonUrlOf(it)" target="_blank" rel="noreferrer" :title="it.name">{{ it.name }}</a>
                      <div class="sp-ozon-tags">
                        <span class="sp-mini-tag">{{ it.sku }}</span>
                        <span class="sp-mini-tag">{{ it.category3 }}</span>
                        <span v-if="it.brand" class="sp-mini-tag">{{ it.brand }}</span>
                        <span class="sp-mini-tag">跟卖 {{ it.followCount }}</span>
                        <span v-if="it.sourcing?.best?.shared" class="sp-mini-tag" style="color:#10b981">↺ 共享缓存</span>
                      </div>
                    </div>
                  </div>
                </td>
                <td>
                  <div style="font-weight:900; font-size:15px" class="sp-num-mono">{{ fmtRub(it.priceRub) }} ₽</div>
                  <div class="sp-engine-sub" style="margin-top:3px">月销 {{ it.soldCount }}</div>
                </td>
                <td>
                  <div class="sp-num-mono">{{ it.weightG != null ? it.weightG + ' g' : '—' }}</div>
                  <div class="sp-engine-sub" style="margin-top:3px">OGL {{ fmtCny(it.freightCny) }}</div>
                </td>
                <td>
                  <div class="sp-num-mono" style="font-weight:900; color:#38bdf8">{{ fmtCny(it.budgetCny) }}</div>
                  <div class="sp-engine-sub" style="margin-top:3px">余量 {{ Number(it.headroomPct || 0).toFixed(1) }}%</div>
                </td>
                <td>
                  <div v-if="bestOf(it)" class="sp-match-cell">
                    <img v-if="bestOf(it).imageUrl" class="sp-thumb" style="width:56px;height:56px;flex-basis:56px" :src="String(bestOf(it).imageUrl).replace('http://','https://')" loading="lazy" @error="onImageError" @click="openCompare(it)" />
                    <div class="sp-match-info">
                      <a class="sp-match-title" :href="detailUrlOf(it)" target="_blank" rel="noreferrer" :title="bestOf(it).title">{{ bestOf(it).title || '1688 同款货源' }}</a>
                      <div class="sp-conf-row">
                        <div class="sp-conf-bar"><div class="sp-conf-fill" :class="{ 'is-mid': confPct(it) < Math.round((task?.policy?.minConfidence || 0.85) * 100) }" :style="{ width: confPct(it) + '%' }"></div></div>
                        <b class="sp-num-mono" :style="{ color: confPct(it) >= Math.round((task?.policy?.minConfidence || 0.85) * 100) ? '#10b981' : '#f59e0b' }">{{ confPct(it) }}%</b>
                        <span class="sp-num-mono" style="font-weight:900; color:#fbbf24">¥{{ bestOf(it).priceCny }}</span>
                      </div>
                      <div class="sp-ozon-tags" style="margin-top:4px">
                        <span class="sp-mini-tag">{{ bestOf(it).moqText || '起批' }}</span>
                        <span class="sp-mini-tag">{{ bestOf(it).kind === 'same' ? '同款' : '相似' }}</span>
                        <span v-if="candidatesOf(it).length" class="sp-mini-tag">候选 {{ candidatesOf(it).length }}</span>
                      </div>
                    </div>
                  </div>
                  <div v-else style="color:#94a3b8; font-size:12px; line-height:1.5">
                    {{ it.sourcingStage === 'sourcing' ? '⏳ 双通道图搜与 AI 视觉核验中…' : (it.sourcingReason || '未找货 — 点「自动找货」开始') }}
                  </div>
                </td>
                <td>
                  <div :class="marginCls(it.actualMarginPct ?? it.estMarginPct)" class="sp-num-mono" style="font-size:14px">
                    {{ fmtMargin(it.actualMarginPct ?? it.estMarginPct) }}
                  </div>
                  <div class="sp-engine-sub" style="margin-top:3px">
                    {{ it.actualMarginPct != null ? '真实核价' : '预估' }}
                    <template v-if="it.actualCostCny != null"> · 拿货 ¥{{ Number(it.actualCostCny).toFixed(2) }}</template>
                  </div>
                </td>
                <td>
                  <span class="sp-status-pill" :class="stageOf(it).cls">{{ stageText(it) }}</span>
                  <div v-if="it.sourcingReason && ELIM_STAGES.includes(it.sourcingStage)" class="sp-engine-sub" style="margin-top:4px; font-size:11px; line-height:1.4">{{ it.sourcingReason }}</div>
                </td>
                <td>
                  <div class="sp-row-actions">
                    <template v-if="['matched','good'].includes(it.sourcingStage)">
                      <el-button size="small" type="primary" @click="openConfirm(it)">确认包装核价</el-button>
                      <el-button size="small" type="warning" plain @click="openQuote(it)">报价核价</el-button>
                    </template>
                    <el-button v-if="['idle','queued','failed','no_source'].includes(it.sourcingStage)" size="small" :loading="acting" @click="autoSource()">单独找货</el-button>
                    <el-button v-if="bestOf(it)" size="small" link type="info" @click="openCompare(it)">大图对比</el-button>
                  </div>
                </td>
              </tr>
              <tr v-if="!filteredItems.length && !loading">
                <td colspan="9" style="text-align:center; padding:48px 0; color:#94a3b8">
                  当前筛选下没有商品。点「↻ 补充候选池」或「🔍 自动找货」开始。
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- ═══ 弹窗 1：选品策略 ═══ -->
        <el-dialog v-model="policyDialog" title="⚙ 选品策略（保存后立即重算全池）" width="640px" top="8vh">
          <el-form label-width="145px" label-position="left">
            <div class="sp-policy-section">
              <div class="sp-policy-section-title">基础筛选（Ozon 候选池入池条件）</div>
              <el-form-item label="最低售价 (₽)"><el-input-number v-model="policyForm.priceMin" :min="0" :max="50000" :step="100" /></el-form-item>
              <el-form-item label="最高售价 (₽)"><el-input-number v-model="policyForm.priceMax" :min="100" :max="100000" :step="500" /></el-form-item>
              <el-form-item label="最低月销量"><el-input-number v-model="policyForm.soldMin" :min="0" :max="50000" :step="10" /></el-form-item>
              <el-form-item label="最高跟卖数"><el-input-number v-model="policyForm.followMax" :min="1" :max="200" :step="1" /></el-form-item>
              <el-form-item label="最大货重 (g)"><el-input-number v-model="policyForm.weightMax" :min="50" :max="30000" :step="100" /></el-form-item>
              <el-form-item label="仅中国卖家"><el-switch v-model="policyForm.chinaSellersOnly" /></el-form-item>
              <el-form-item label="仅无品牌"><el-switch v-model="policyForm.noBrandOnly" /></el-form-item>
            </div>
            <div class="sp-policy-section">
              <div class="sp-policy-section-title">核价引擎参数（预算与利润判定）</div>
              <el-form-item label="目标利润率 (%)"><el-input-number v-model="policyForm.targetMarginPct" :min="5" :max="85" :step="5" /></el-form-item>
              <el-form-item label="同款置信度阈值"><el-slider v-model="policyForm.minConfidence" :min="0.5" :max="0.99" :step="0.01" show-stops :marks="{ 0.7: '70%', 0.85: '85%', 0.95: '95%' }" /></el-form-item>
              <el-form-item label="头程物流通道">
                <el-select v-model="policyForm.freightChannel" style="width:200px">
                  <el-option label="OGL（Ozon Global Logistics）" value="OGL" />
                  <el-option label="CEL 跨境 Economy" value="CEL" />
                </el-select>
              </el-form-item>
              <el-form-item label="售价取值口径">
                <el-select v-model="policyForm.priceBasis" style="width:200px">
                  <el-option label="均价（含折扣）" value="avg" />
                  <el-option label="最低价" value="min" />
                </el-select>
              </el-form-item>
              <el-form-item label="要求一件起批"><el-switch v-model="policyForm.requireSingleUnit" active-text="开启后多件起批的货源判为非一件起批" /></el-form-item>
            </div>
            <div class="sp-policy-section">
              <div class="sp-policy-section-title">候选池规模</div>
              <el-form-item label="目标商品数"><el-input-number v-model="policyForm.targetCount" :min="10" :max="500" :step="10" /></el-form-item>
              <el-form-item label="自动找货"><el-switch v-model="policyForm.autoSource" active-text="入池后自动排队找货" /></el-form-item>
            </div>
          </el-form>
          <template #footer>
            <el-button @click="policyDialog = false">取消</el-button>
            <el-button type="primary" :loading="policySaving" @click="savePolicy">保存并重算</el-button>
          </template>
        </el-dialog>

        <!-- ═══ 弹窗 2：确认包装并核价 ═══ -->
        <el-dialog v-model="confirmDialog" title="确认包装并核价（晋升 ★ 好品）" width="480px" top="10vh">
          <p style="margin:0 0 14px; color:#64748b; font-size:13px; line-height:1.6">
            填写单件包装的<b>毛重</b>与<b>三边尺寸</b>（cm），引擎将按确认规格重算 OGL 头程运费与<b>真实利润率</b>，
            达标即晋升 <b style="color:#10b981">★ 好品</b>。尺寸会自动尝试读取 Ozon 实测值。
          </p>
          <el-form label-width="120px" label-position="left">
            <el-form-item label="毛重 (g)">
              <el-input-number v-model="confirmForm.grossWeightG" :min="5" :max="30000" :step="10" style="width:100%" />
            </el-form-item>
            <el-form-item label="长 L (cm)"><el-input-number v-model="confirmForm.lengthCm" :min="1" :max="150" :step="0.5" :precision="1" style="width:100%" /></el-form-item>
            <el-form-item label="宽 W (cm)"><el-input-number v-model="confirmForm.widthCm" :min="1" :max="150" :step="0.5" :precision="1" style="width:100%" /></el-form-item>
            <el-form-item label="高 H (cm)"><el-input-number v-model="confirmForm.heightCm" :min="1" :max="150" :step="0.5" :precision="1" style="width:100%" /></el-form-item>
            <el-form-item label="尺寸来源">
              <el-select v-model="confirmForm.source" style="width:100%">
                <el-option label="手工测量" value="manual" />
                <el-option label="Ozon 实测" value="ozon" />
              </el-select>
            </el-form-item>
          </el-form>
          <template #footer>
            <el-button @click="confirmDialog = false">取消</el-button>
            <el-button type="success" :loading="confirmSaving" @click="saveConfirm">确认并核价晋升</el-button>
          </template>
        </el-dialog>

        <!-- ═══ 弹窗 3：报价（实际拿货价） ═══ -->
        <el-dialog v-model="quoteDialog" title="报价核价：实际拿货价" width="460px" top="10vh">
          <p style="margin:0 0 14px; color:#64748b; font-size:13px; line-height:1.6">
            填真实的 1688 拿货价（含议价/运费分摊后单价），引擎将覆写图搜估价，重算<b>真实利润率</b>。
          </p>
          <el-form label-width="130px" label-position="left">
            <el-form-item label="实际拿货价 (¥)"><el-input-number v-model="quoteForm.actualCostCny" :min="0.01" :max="5000" :step="0.5" :precision="2" style="width:100%" /></el-form-item>
            <el-form-item label="起批量"><el-input v-model="quoteForm.moqText" placeholder="如 1件起批 / 2个起批" /></el-form-item>
            <el-form-item label="备注"><el-input v-model="quoteForm.note" type="textarea" :rows="2" placeholder="可选：供应商、议价记录等" /></el-form-item>
          </el-form>
          <template #footer>
            <el-button @click="quoteDialog = false">取消</el-button>
            <el-button type="warning" :loading="quoteSaving" @click="saveQuote">按此价核价</el-button>
          </template>
        </el-dialog>

        <!-- ═══ 弹窗 4：1688 同款大图对比 ═══ -->
        <el-dialog v-model="compareDialog" title="1688 同款大图对比（AI 视觉核验）" width="860px" top="6vh">
          <div v-if="compareItem" class="sp-compare-grid">
            <div style="display:flex;flex-direction:column;gap:8px;align-items:center">
              <span class="sp-badge sp-badge-ai">Ozon 主图</span>
              <img v-if="compareItem.photo" :src="compareItem.photo" style="max-width:100%;border-radius:10px;border:1px solid #e2e8f0" @error="onImageError" />
              <div style="font-size:12px;color:#64748b;line-height:1.5;text-align:center">{{ compareItem.name }}</div>
              <a :href="ozonUrlOf(compareItem)" target="_blank" rel="noreferrer" style="font-size:12px;color:#2563eb">打开 Ozon 商品页 ↗</a>
            </div>
            <div>
              <span class="sp-badge sp-badge-plugin-ok" style="margin-bottom:8px">1688 同款（置信度 {{ confPct(compareItem) }}%）</span>
              <div v-if="bestOf(compareItem)">
                <div class="sp-cand-list">
                  <div v-for="(cand, idx) in (candidatesOf(compareItem).length ? candidatesOf(compareItem) : [bestOf(compareItem)])" :key="idx"
                       class="sp-cand-card" :class="{ 'is-best': bestOf(compareItem) && cand.offerId === bestOf(compareItem).offerId }">
                    <img v-if="cand.imageUrl" :src="String(cand.imageUrl).replace('http://','https://')" style="width:64px;height:64px;border-radius:8px;object-fit:cover;flex:0 0 64px" loading="lazy" @error="onImageError" />
                    <div style="min-width:0;flex:1">
                      <a v-if="cand.detailUrl" :href="cand.detailUrl" target="_blank" rel="noreferrer" style="font-size:12px;font-weight:700;color:#1e40af;text-decoration:none;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{{ cand.title || '1688 货源 ' + cand.offerId }}</a>
                      <div v-else-if="cand.offerId" style="font-size:12px;font-weight:700;color:#334155">1688 货源 {{ cand.offerId }}</div>
                      <div style="margin-top:6px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px">
                        <b style="color:#f59e0b">¥{{ cand.priceCny }}</b>
                        <span v-if="cand.confidence" class="sp-num-mono" :style="{ color: Number(cand.confidence) >= (task?.policy?.minConfidence || 0.85) ? '#10b981' : '#94a3b8', fontWeight: 800 }">{{ Math.round(Number(cand.confidence) * 100) }}%</span>
                        <span v-if="bestOf(compareItem) && cand.offerId === bestOf(compareItem).offerId" class="sp-mini-tag" style="color:#15803d;background:#dcfce7">★ 最佳同款</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <p v-else style="color:#94a3b8;font-size:13px">该商品暂无核验通过的 1688 同款。点「自动找货」通过双通道补搜。</p>
            </div>
          </div>
          <template #footer>
            <el-button @click="compareDialog = false">关闭</el-button>
            <el-button v-if="compareItem && ['matched','good'].includes(compareItem.sourcingStage)" type="primary" @click="openConfirm(compareItem)">确认包装核价</el-button>
          </template>
        </el-dialog>

      </div>
    </div>
  `,
};
