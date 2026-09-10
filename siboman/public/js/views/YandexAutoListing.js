/**
 * Yandex 自动上架（对齐熊猫 ERP「Yandex → 自动上架」）
 * 流程：粘贴 1688 链接 → 插件采集（标题/图集/详情图/SKU/属性/重量尺寸）→ 选末级类目 + 类目参数
 *      → AI 俄文标题/描述 → 定价 → 一键上传到 Yandex（offer-mappings/update）→ 上传记录
 */
window.YandexAutoListingView = {
  setup() {
    const loading = Vue.ref(false);
    const saving = Vue.ref(false);
    const uploading = Vue.ref(false);
    const activeTab = Vue.ref('tasks');
    const drafts = Vue.ref([]);
    const total = Vue.ref(0);
    const pagination = Vue.reactive({ page: 1, pageSize: 20 });
    const query = Vue.reactive({ q: '', collectStatus: '', publishStatus: '' });
    // 店铺结算币种（跨境店为 CNY；Yandex 只接受店铺币种，推错会报 Illegal input at basicPrice.currencyId）
    const currencyId = Vue.ref('CNY');
    const currencySymbol = Vue.computed(() => (currencyId.value === 'CNY' ? '¥' : '₽'));
    const warehouses = Vue.ref([]);
    // 利润计算（对齐熊猫口径：代贴单费/国内运费/物流商/佣金/收单/提现/退货/广告/目标毛利/划线折扣/实际汇率）
    const profit = Vue.reactive({
      visible: true, busy: false, rows: [], applied: false,
      cost: { serviceFeeCny: 3, domesticShippingCny: 5, lastMileCny: 4.68, commissionPct: 24, acquiringPct: 3.8, withdrawalPct: 1.2, returnLossPct: 0, adPct: 15, targetMarginPct: 35, strikeDiscountPct: 50, exchangeRate: 12.8205 },
      rateText: '',
    });
    // 变体特征值编辑（每个 SKU 同一特征参数给不同值，Yandex 才允许同组发布）
    const skuParamDialog = Vue.reactive({ visible: false, index: -1, spec: '', rows: [] });
    const warehouseId = Vue.ref('');
    const priceField = () => (currencyId.value === 'CNY' ? 'priceCny' : 'priceRub');
    const oldPriceField = () => (currencyId.value === 'CNY' ? 'oldPriceCny' : 'oldPriceRub');

    const notify = {
      success: (m) => (window.ElementPlus?.ElMessage || console).success?.(m),
      warning: (m) => (window.ElementPlus?.ElMessage || console).warning?.(m),
      error: (m) => (window.ElementPlus?.ElMessage || console).error?.(m),
      info: (m) => (window.ElementPlus?.ElMessage || console).info?.(m),
    };

    const newTaskDialog = Vue.reactive({ visible: false, urls: '', busy: false, jobId: '', phase: '', processed: 0, total: 0, done: false, timer: null });
    const drawer = Vue.reactive({
      visible: false, busy: false, id: '', draft: null,
      categoryPath: [], categoryOptions: [], params: [], paramsLoading: false,
      aiBusy: false, saveBusy: false, uploadBusy: false, tagsText: '',
    });

    const collectStatusText = (s) => ({ pending: '待采集', collecting: '采集中', collected: '采集成功', failed: '采集失败' }[s] || s || '-');
    const collectStatusType = (s) => ({ pending: 'info', collecting: 'warning', collected: 'success', failed: 'danger' }[s] || 'info');
    const publishStatusText = (s) => ({ unpublished: '未上传', uploading: '上传中', published: '已上传', failed: '上传失败' }[s] || s || '-');
    const publishStatusType = (s) => ({ unpublished: 'info', uploading: 'warning', published: 'success', failed: 'danger' }[s] || 'info');
    const firstImage = (d) => (Array.isArray(d.images) && d.images.length ? d.images[0] : (d.skus?.[0]?.image || ''));

    const loadProfitDefaults = async () => {
      try {
        const res = await axios.get('/api/yandex/pricing-defaults', { timeout: 30000 });
        const d = res.data || {};
        for (const k of Object.keys(profit.cost)) if (d[k] !== undefined && d[k] !== null && d[k] !== '') profit.cost[k] = Number(d[k]);
        profit.rateText = `当前汇率 1 CNY = ${Number(profit.cost.exchangeRate || 0).toFixed(4)} RUB`;
      } catch (_e) { profit.rateText = '汇率读取失败，使用默认值'; }
    };
    const calcProfit = async () => {
      if (!drawer.draft) return;
      profit.busy = true;
      try {
        const items = (drawer.draft.skus || []).map((sku, i) => ({
          offerId: String(i + 1), purchaseCny: Number(sku.purchaseCny || 0), weightKg: Number(sku.weightKg || 0),
          dims: [Number(sku.lengthCm || 0), Number(sku.widthCm || 0), Number(sku.heightCm || 0)],
          categoryName: drawer.draft.categoryName || '', params: { ...profit.cost },
        }));
        const res = await axios.post('/api/yandex/price-suggest', { items }, { timeout: 60000 });
        const results = res.data?.results || [];
        profit.rows = results.map((r, i) => ({
          idx: i, spec: drawer.draft.skus[i]?.spec || ('SKU ' + (i + 1)), ok: !!r.ok, priceCny: r.priceCny || 0, priceRub: r.rubValue || 0,
          strikeCny: r.strikePriceCny || 0, profitCny: r.profitCny || 0, zone: r.zone || '', celFeeCny: r.celFeeCny || 0,
          commission: r.commissionUsed || 0, commissionSource: r.commissionSource || 'auto',
        }));
        const bad = profit.rows.filter((r) => !r.ok);
        if (bad.length) notify.warning(`${bad.length} 个 SKU 计算失败（采购价/重量/尺寸不完整）`);
      } catch (e) { notify.error('利润计算失败: ' + (e.response?.data?.error || e.message)); }
      finally { profit.busy = false; }
    };
    const applyProfitPrices = () => {
      if (!drawer.draft || !profit.rows.length) return;
      const f = priceField(), of = oldPriceField();
      for (const r of profit.rows) {
        const sku = drawer.draft.skus[r.idx];
        if (!sku || !r.ok) continue;
        if (currencyId.value === 'CNY') { sku.priceCny = r.priceCny; sku.oldPriceCny = r.strikeCny; }
        else { sku.priceRub = Math.round(r.priceRub || r.priceCny * profit.cost.exchangeRate); sku.oldPriceRub = Math.round((r.strikeCny || 0) * profit.cost.exchangeRate); }
      }
      profit.applied = true;
      notify.success(`已把 ${profit.rows.filter((r) => r.ok).length} 个 SKU 的售价/划线价填入（记得保存并上传）`);
    };

    const loadWarehouses = async () => {
      if (warehouses.value.length) return;
      try {
        const res = await axios.get('/api/yandex/listing/warehouses', { timeout: 60000 });
        warehouses.value = res.data?.warehouses || [];
        if (!warehouseId.value && warehouses.value.length) warehouseId.value = warehouses.value[0].id;
      } catch (_e) { /* 仓库读取失败不阻塞 */ }
    };

    const fetchDrafts = async () => {
      loading.value = true;
      try {
        const res = await axios.get('/api/yandex/listing/drafts', {
          params: {
            q: query.q, page: pagination.page, page_size: pagination.pageSize,
            collect_status: query.collectStatus || undefined,
            publish_status: activeTab.value === 'records' ? 'published' : (query.publishStatus || undefined),
          },
        });
        drafts.value = res.data?.items || [];
        total.value = Number(res.data?.total || 0);
        if (res.data?.currencyId) currencyId.value = String(res.data.currencyId).toUpperCase();
      } catch (e) {
        notify.error('读取上架任务失败: ' + (e.response?.data?.error || e.message));
      } finally { loading.value = false; }
    };

    // ===== 新增上架任务 =====
    const openNewTask = () => { newTaskDialog.visible = true; newTaskDialog.urls = ''; newTaskDialog.jobId = ''; newTaskDialog.phase = ''; newTaskDialog.processed = 0; newTaskDialog.total = 0; newTaskDialog.done = false; };
    const submitNewTask = async () => {
      const urls = String(newTaskDialog.urls || '').split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean);
      if (!urls.length) return notify.warning('请粘贴至少一个 1688 商品链接');
      newTaskDialog.busy = true;
      try {
        const res = await axios.post('/api/yandex/listing/tasks', { urls }, { timeout: 60000 });
        const jobId = res.data?.jobId || '';
        newTaskDialog.jobId = jobId;
        newTaskDialog.total = Number(res.data?.total || urls.length);
        notify.success(`已提交 ${res.data?.total || urls.length} 个商品，等待本机插件采集`);
        if (jobId) pollCollectJob(jobId);
        fetchDrafts();
      } catch (e) {
        notify.error('提交失败: ' + (e.response?.data?.error || e.message));
      } finally { newTaskDialog.busy = false; }
    };
    const pollCollectJob = async (jobId) => {
      if (newTaskDialog.timer) clearInterval(newTaskDialog.timer);
      const tick = async () => {
        try {
          const res = await axios.get('/api/jobs/' + encodeURIComponent(jobId));
          const job = res.data?.job || res.data || {};
          newTaskDialog.phase = job.phase || '';
          newTaskDialog.processed = Number(job.processed || 0);
          newTaskDialog.total = Number(job.total || newTaskDialog.total || 0);
          if (['done', 'error', 'canceled'].includes(job.status)) {
            clearInterval(newTaskDialog.timer); newTaskDialog.timer = null;
            newTaskDialog.done = true;
            fetchDrafts();
          }
        } catch (_e) { /* 轮询失败继续 */ }
      };
      await tick();
      newTaskDialog.timer = setInterval(tick, 4000);
    };

    // ===== 编辑属性 =====
    const loadCategoryOptions = async () => {
      if (drawer.categoryOptions.length) return;
      try {
        const res = await axios.get('/api/yandex/listing/categories', { timeout: 90000 });
        drawer.categoryOptions = res.data?.options || [];
      } catch (e) { notify.error('读取 Yandex 类目树失败: ' + (e.response?.data?.error || e.message)); }
    };
    const loadCategoryParams = async (categoryId) => {
      if (!categoryId) return;
      drawer.paramsLoading = true;
      try {
        const res = await axios.get(`/api/yandex/listing/categories/${encodeURIComponent(categoryId)}/parameters`, { timeout: 90000 });
        const fresh = res.data?.parameters || [];
        // 保留草稿里已填的值
        const saved = new Map((drawer.draft?.categoryParams || []).map((p) => [String(p.parameterId), p]));
        drawer.params = fresh.map((p) => {
          const old = saved.get(String(p.parameterId)) || {};
          return { ...p, value: old.value || '', valueId: old.valueId || '', unitId: old.unitId || p.unitId || '' };
        });
      } catch (e) { notify.error('读取类目参数失败: ' + (e.response?.data?.error || e.message)); }
      finally { drawer.paramsLoading = false; }
    };
    const openDrawer = async (row) => {
      drawer.visible = true; drawer.busy = true; drawer.id = row.id;
      try {
        const res = await axios.get('/api/yandex/listing/drafts/' + encodeURIComponent(row.id));
        const d = res.data?.draft || null;
        if (!d) throw new Error('草稿不存在');
        d.skus = (Array.isArray(d.skus) ? d.skus : []).map((s) => ({ ...s, images: Array.isArray(s.images) ? s.images : [] }));
        drawer.draft = d;
        drawer.tagsText = (d.tags || []).join(', ');
        drawer.categoryPath = d.categoryId ? await findCategoryPath(d.categoryId) : [];
        loadWarehouses();
        loadProfitDefaults();
        await loadCategoryOptions();
        if (d.categoryId) await loadCategoryParams(d.categoryId);
        else drawer.params = [];
      } catch (e) {
        notify.error('打开失败: ' + (e.response?.data?.error || e.message));
        drawer.visible = false;
      } finally { drawer.busy = false; }
    };
    const findCategoryPath = async (categoryId) => {
      await loadCategoryOptions();
      const target = String(categoryId);
      const walk = (nodes, path) => {
        for (const n of nodes || []) {
          const next = [...path, n.value];
          if (String(n.value) === target) return next;
          if (n.children?.length) { const hit = walk(n.children, next); if (hit) return hit; }
        }
        return null;
      };
      return walk(drawer.categoryOptions, []) || [];
    };
    const categoryLabel = (path) => {
      const labels = [];
      let nodes = drawer.categoryOptions;
      for (const id of path || []) {
        const node = (nodes || []).find((n) => String(n.value) === String(id));
        if (!node) break;
        labels.push(node.label); nodes = node.children || [];
      };
      return labels.join(' / ');
    };
    const onCategoryChange = async (path) => {
      const id = String((path || []).slice(-1)[0] || '');
      if (!drawer.draft) return;
      drawer.draft.categoryId = id;
      drawer.draft.categoryName = categoryLabel(path);
      await loadCategoryParams(id);
    };
    const buildPayload = () => {
      const d = drawer.draft || {};
      return {
        titleRu: d.titleRu, descriptionRu: d.descriptionRu, brand: d.brand, vendorCode: d.vendorCode,
        originCountry: d.originCountry, hotwords: d.hotwords,
        tags: String(drawer.tagsText || '').split(/[,，;；]/).map((s) => s.trim()).filter(Boolean),
        categoryId: d.categoryId, categoryName: d.categoryName,
        categoryParams: (drawer.params || []).map((p) => ({ parameterId: p.parameterId, name: p.name, type: p.type, value: p.value, valueId: p.valueId, unitId: p.unitId }))
          .filter((p) => (p.value !== '' && p.value !== undefined && p.value !== null) || p.valueId),
        images: d.images || [], detailImages: d.detailImages || [], videoUrl: d.videoUrl || '',
        skus: d.skus || [],
      };
    };
    const saveDraft = async () => {
      drawer.saveBusy = true;
      try {
        await axios.patch('/api/yandex/listing/drafts/' + encodeURIComponent(drawer.id), buildPayload(), { timeout: 60000 });
        notify.success('已保存');
        fetchDrafts();
      } catch (e) { notify.error('保存失败: ' + (e.response?.data?.error || e.message)); }
      finally { drawer.saveBusy = false; }
    };
    const aiFill = async () => {
      drawer.aiBusy = true;
      try {
        await axios.patch('/api/yandex/listing/drafts/' + encodeURIComponent(drawer.id), buildPayload(), { timeout: 60000 });
        const res = await axios.post(`/api/yandex/listing/drafts/${encodeURIComponent(drawer.id)}/ai-fill`, {}, { timeout: 180000 });
        const d = res.data?.draft;
        if (d) {
          drawer.draft.titleRu = d.titleRu; drawer.draft.descriptionRu = d.descriptionRu;
          drawer.tagsText = (d.tags || []).join(', ');
          const saved = new Map((d.categoryParams || []).map((p) => [String(p.parameterId), p]));
          drawer.params = (drawer.params || []).map((p) => ({ ...p, ...(saved.get(String(p.parameterId)) || {}) }));
        }
        notify.success('AI 填充完成，请核对后保存');
        fetchDrafts();
      } catch (e) { notify.error('AI 填充失败: ' + (e.response?.data?.error || e.message)); }
      finally { drawer.aiBusy = false; }
    };
    const uploadOne = async (id) => {
      const res = await axios.post('/api/yandex/listing/upload', { ids: [id], warehouseId: warehouseId.value || undefined }, { timeout: 180000 });
      const r = (res.data?.results || [])[0] || {};
      if (r.ok) {
        const st = r.stocks || {};
        const stockText = st.ok ? `；库存已写入（${st.count} 条）` : `；库存未写入（${st.error || '跳过'}）`;
        notify.success(`已上传到 Yandex：${(r.offerIds || []).join(', ')}${stockText}`);
      }
      else notify.error('上传失败: ' + (r.error || '未知错误'));
      fetchDrafts();
      return r;
    };
    const uploadFromDrawer = async () => {
      drawer.uploadBusy = true;
      try {
        await saveDraft();
        await uploadOne(drawer.id);
      } catch (e) { notify.error('上传失败: ' + (e.response?.data?.error || e.message)); }
      finally { drawer.uploadBusy = false; }
    };
    const uploadRow = async (row) => { uploading.value = true; try { await uploadOne(row.id); } finally { uploading.value = false; } };
    const removeDraft = async (row) => {
      try {
        await window.ElementPlus.ElMessageBox.confirm(`删除草稿「${row.titleRu || row.sourceUrl}」？（不影响已上传到 Yandex 的商品）`, '删除草稿', { type: 'warning' });
      } catch { return; }
      try { await axios.delete('/api/yandex/listing/drafts/' + encodeURIComponent(row.id)); notify.success('已删除'); fetchDrafts(); }
      catch (e) { notify.error('删除失败: ' + (e.response?.data?.error || e.message)); }
    };
    const deleteYandexOffers = async (row) => {
      try {
        await window.ElementPlus.ElMessageBox.confirm('将从 Yandex 目录删除该商品卡片，确定？', '从 Yandex 删除', { type: 'warning' });
      } catch { return; }
      try { await axios.post(`/api/yandex/listing/drafts/${encodeURIComponent(row.id)}/delete-offers`, {}, { timeout: 120000 }); notify.success('已从 Yandex 删除'); fetchDrafts(); }
      catch (e) { notify.error('删除失败: ' + (e.response?.data?.error || e.message)); }
    };

    // SKU 行操作
    const openSkuParams = (row, index) => {
      const distinctive = (drawer.params || []).filter((p) => p.distinctive === true);
      const current = new Map((Array.isArray(row.params) ? row.params : []).map((p) => [String(p.parameterId), p]));
      skuParamDialog.rows = distinctive.map((p) => {
        const old = current.get(String(p.parameterId)) || {};
        return { parameterId: p.parameterId, name: p.name, nameZh: p.nameZh, options: p.options || [], units: p.units || [], type: p.type, value: old.value || '', valueId: old.valueId || '', unitId: old.unitId || '' };
      });
      skuParamDialog.index = index; skuParamDialog.spec = row.spec || ('SKU ' + (index + 1));
      skuParamDialog.visible = true;
    };
    const saveSkuParams = () => {
      if (!drawer.draft || skuParamDialog.index < 0) return;
      const row = drawer.draft.skus[skuParamDialog.index];
      row.params = skuParamDialog.rows.filter((r) => r.valueId || (r.value !== '' && r.value !== undefined && r.value !== null))
        .map((r) => ({ parameterId: r.parameterId, name: r.name, type: r.type, value: r.value, valueId: r.valueId, unitId: r.unitId }));
      skuParamDialog.visible = false;
      notify.success('已设置该 SKU 的变体特征值（记得保存并上传）');
    };
    const addSku = () => { if (!drawer.draft) return; drawer.draft.skus = [...(drawer.draft.skus || []), { spec: '', priceRub: 0, oldPriceRub: 0, purchaseCny: 0, image: drawer.draft.images?.[0] || '', images: [], weightKg: 0.2, lengthCm: 0, widthCm: 0, heightCm: 0, stock: 0 }]; };
    const removeSku = (i) => { if (drawer.draft?.skus) drawer.draft.skus.splice(i, 1); };
    const applyWeightToAll = () => {
      const first = drawer.draft?.skus?.[0];
      if (!first) return;
      for (const s of drawer.draft.skus.slice(1)) {
        s.weightKg = first.weightKg; s.lengthCm = first.lengthCm; s.widthCm = first.widthCm; s.heightCm = first.heightCm;
      }
      notify.success('已把第 1 个 SKU 的重量尺寸套用到其余 SKU');
    };
    const removeImage = (index) => { drawer.draft?.images?.splice(index, 1); };
    const addImage = () => { const url = window.prompt('粘贴图片 URL'); if (url) drawer.draft.images.push(url.trim()); };

    Vue.onMounted(fetchDrafts);

    return {
      loading, saving, uploading, activeTab, drafts, total, pagination, query, notify,
      newTaskDialog, drawer,
      collectStatusText, collectStatusType, publishStatusText, publishStatusType, firstImage,
      fetchDrafts, openNewTask, submitNewTask,
      openDrawer, onCategoryChange, saveDraft, aiFill, uploadFromDrawer, uploadRow, removeDraft, deleteYandexOffers,
      addSku, removeSku, applyWeightToAll, skuParamDialog, openSkuParams, saveSkuParams, profit, loadProfitDefaults, calcProfit, applyProfitPrices, removeImage, addImage, categoryLabel, currencyId, currencySymbol, priceField, oldPriceField, warehouses, warehouseId, loadWarehouses,
    };
  },

  template: `
    <div class="yandex-auto-listing">
      <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px; flex-wrap:wrap">
        <h2 style="margin:0; font-size:18px">Yandex 自动上架</h2>
        <el-tag type="info" size="small">1688 链接 → 插件采集 → 选类目/属性 → AI 俄文 → 一键上传</el-tag>
        <div style="flex:1"></div>
        <el-input v-model="query.q" placeholder="搜索链接/俄文标题" size="default" style="width:240px" clearable @keyup.enter="fetchDrafts" />
        <el-button @click="fetchDrafts">刷新</el-button>
        <el-button type="primary" @click="openNewTask">新增上架任务</el-button>
      </div>

      <el-tabs v-model="activeTab" @tab-change="() => { pagination.page = 1; fetchDrafts(); }">
        <el-tab-pane label="上架任务" name="tasks" />
        <el-tab-pane label="上传记录" name="records" />
      </el-tabs>

      <el-alert v-if="activeTab === 'tasks'" type="warning" :closable="false" show-icon style="margin-bottom:10px"
        title="采集需要本机 Chrome 装着逐梦采集插件并在线（插件会打开 1688 商品页抓取标题/图集/详情图/SKU/属性/重量尺寸）。上传走 Yandex 官方 API，无需插件常驻。" />

      <el-table :data="drafts" v-loading="loading" border size="default" empty-text="还没有上架任务，点「新增上架任务」粘贴 1688 链接">
        <el-table-column label="来源链接" min-width="220">
          <template #default="{ row }">
            <a :href="row.sourceUrl" target="_blank" style="color:#2563eb; text-decoration:none">{{ (row.sourceUrl || '').replace(/^https?:\\/\\//, '').slice(0, 46) }}</a>
            <div v-if="row.collectError" style="font-size:12px; color:#b91c1c">{{ row.collectError.slice(0, 60) }}</div>
            <div v-if="row.publishError" style="font-size:12px; color:#b91c1c">上传: {{ row.publishError.slice(0, 70) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="商品图" width="90" align="center">
          <template #default="{ row }">
            <el-image v-if="firstImage(row)" :src="firstImage(row)" referrerpolicy="no-referrer" fit="cover" style="width:52px;height:52px;border-radius:4px;background:#f1f5f9"
              :preview-src-list="row.images || []" preview-teleported hide-on-click-modal />
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="采集状态" width="100" align="center">
          <template #default="{ row }"><el-tag size="small" :type="collectStatusType(row.collectStatus)">{{ collectStatusText(row.collectStatus) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="俄文标题" min-width="240">
          <template #default="{ row }">
            <div>{{ row.titleRu || '（待 AI 填充 / 手填）' }}</div>
            <div style="font-size:12px; color:#94a3b8">SKU {{ (row.skus || []).length }} · 图 {{ (row.images || []).length }}</div>
          </template>
        </el-table-column>
        <el-table-column label="类目" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">{{ row.categoryName || '-' }}</template>
        </el-table-column>
        <el-table-column label="发布状态" width="110" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="publishStatusType(row.publishStatus)">{{ publishStatusText(row.publishStatus) }}</el-tag>
            <div v-if="(row.yandexResult?.offerIds || []).length" style="font-size:11px; color:#94a3b8">{{ row.yandexResult.offerIds[0] }}</div>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="150">
          <template #default="{ row }">{{ row.createdAt ? String(row.createdAt).slice(0, 16).replace('T', ' ') : '-' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" plain :disabled="row.collectStatus !== 'collected'" @click="openDrawer(row)">编辑属性</el-button>
            <el-button size="small" type="success" plain :loading="uploading" :disabled="!row.categoryId" @click="uploadRow(row)">{{ row.publishStatus === 'published' ? '重新上传' : '上传店铺' }}</el-button>
            <el-button size="small" type="danger" plain @click="removeDraft(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div style="margin-top:12px; text-align:right">
        <el-pagination background layout="total, prev, pager, next" :total="total" :page-size="pagination.pageSize"
          :current-page="pagination.page" @current-change="(p) => { pagination.page = p; fetchDrafts(); }" />
      </div>

      <!-- 新增上架任务 -->
      <el-dialog v-model="newTaskDialog.visible" title="新增上架任务（1688 商品链接）" width="640px" :close-on-click-modal="false">
        <el-alert type="info" :closable="false" show-icon style="margin-bottom:10px"
          title="一行一个 1688 商品链接（detail.1688.com/offer/xxx.html），提交后由本机插件逐个采集。请保持 Chrome 打开。" />
        <el-input v-model="newTaskDialog.urls" type="textarea" :rows="8" placeholder="https://detail.1688.com/offer/730322803810.html&#10;https://detail.1688.com/offer/802358394710.html" />
        <div v-if="newTaskDialog.jobId" style="margin-top:12px">
          <el-progress :percentage="newTaskDialog.total ? Math.round(newTaskDialog.processed / newTaskDialog.total * 100) : 0" />
          <div style="font-size:13px; color:#334155; margin-top:6px">采集进度 {{ newTaskDialog.processed }} / {{ newTaskDialog.total }} {{ newTaskDialog.done ? '（已完成，可关闭）' : '' }} · {{ newTaskDialog.phase }}</div>
        </div>
        <template #footer>
          <el-button @click="newTaskDialog.visible = false">关闭</el-button>
          <el-button type="primary" :loading="newTaskDialog.busy" @click="submitNewTask">提交采集</el-button>
        </template>
      </el-dialog>

      <!-- 编辑属性 -->
      <el-drawer v-model="drawer.visible" size="88%" :title="'编辑商品属性' + (drawer.draft?.titleRu ? ' · ' + drawer.draft.titleRu.slice(0, 40) : '')" destroy-on-close>
        <div v-loading="drawer.busy" style="padding-right:8px">
          <template v-if="drawer.draft">
            <el-card shadow="never" style="margin-bottom:14px">
              <template #header><b>基本信息</b><span style="font-size:12px; color:#94a3b8; float:right">类目必须选末级；属性随类目变化</span></template>
              <el-form label-width="90px" size="small">
                <el-form-item label="类目">
                  <el-cascader v-model="drawer.categoryPath" :options="drawer.categoryOptions" filterable clearable
                    placeholder="请选择 Yandex 末级类目" style="width:100%" @change="onCategoryChange" />
                </el-form-item>
                <el-form-item label="商品标题">
                  <el-input v-model="drawer.draft.titleRu" placeholder="俄文标题（可用 AI 智能填充）" maxlength="255" show-word-limit />
                </el-form-item>
                <el-row :gutter="12">
                  <el-col :span="8"><el-form-item label="品牌"><el-input v-model="drawer.draft.brand" /></el-form-item></el-col>
                  <el-col :span="8"><el-form-item label="货号"><el-input v-model="drawer.draft.vendorCode" /></el-form-item></el-col>
                  <el-col :span="8"><el-form-item label="产地"><el-input v-model="drawer.draft.originCountry" /></el-form-item></el-col>
                </el-row>
                <el-form-item label="商品描述">
                  <el-input v-model="drawer.draft.descriptionRu" type="textarea" :rows="4" placeholder="俄文描述（可用 AI 智能填充）" />
                </el-form-item>
                <el-row :gutter="12">
                  <el-col :span="12"><el-form-item label="标签"><el-input v-model="drawer.tagsText" placeholder="英文逗号分隔，如 стикеры, закладки" /></el-form-item></el-col>
                  <el-col :span="12"><el-form-item label="搜索热词"><el-input v-model="drawer.draft.hotwords" placeholder="AI 生成标题/描述时自然融入" /></el-form-item></el-col>
                </el-row>
              </el-form>
            </el-card>

            <el-card shadow="never" style="margin-bottom:14px" v-loading="drawer.paramsLoading">
              <template #header><b>类目参数</b><span style="font-size:12px; color:#94a3b8; float:right">{{ drawer.params.length }} 项（带 * 为必填，下拉为平台枚举值）</span></template>
              <el-table :data="drawer.params" size="small" border max-height="320" empty-text="请先选择类目">
                <el-table-column label="参数（俄/中）" min-width="220">
                  <template #default="{ row }">
                    <div>{{ row.name }}<span style="color:#dc2626" v-if="row.required"> *</span></div>
                    <div v-if="row.nameZh" style="font-size:12px; color:#94a3b8">{{ row.nameZh }}</div>
                  </template>
                </el-table-column>
                <el-table-column label="值" min-width="240">
                  <template #default="{ row }">
                    <el-select v-if="row.options && row.options.length" v-model="row.valueId" filterable clearable placeholder="选择平台枚举值" style="width:100%">
                      <el-option v-for="o in row.options" :key="o.id" :label="o.value" :value="o.id" />
                    </el-select>
                    <el-input v-else v-model="row.value" :placeholder="row.type === 'numeric' ? '数值' : '文本'" />
                  </template>
                </el-table-column>
                <el-table-column label="单位" width="130">
                  <template #default="{ row }">
                    <el-select v-if="row.units && row.units.length" v-model="row.unitId" clearable placeholder="单位" style="width:100%">
                      <el-option v-for="u in row.units" :key="u.id" :label="u.name" :value="u.id" />
                    </el-select>
                    <span v-else style="color:#94a3b8">{{ row.unitName || '-' }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="变体特征" width="90" align="center">
                  <template #default="{ row }"><el-tag v-if="row.distinctive" size="small" type="warning">变体</el-tag><span v-else>-</span></template>
                </el-table-column>
              </el-table>
            </el-card>

            <el-card shadow="never" style="margin-bottom:14px">
              <template #header>
                <b>SKU / 价格</b>
                <div style="float:right; display:flex; gap:8px">
                  <el-button size="small" @click="applyWeightToAll">尺寸套用到全部 SKU</el-button>
                  <el-button size="small" type="primary" plain @click="addSku">添加 SKU</el-button>
                </div>
              </template>
              <el-table :data="drawer.draft.skus" size="small" border>
                <el-table-column label="#" width="46"><template #default="{ $index }">{{ $index + 1 }}</template></el-table-column>
                <el-table-column label="首图" width="80">
                  <template #default="{ row }"><el-image v-if="row.image" :src="row.image" referrerpolicy="no-referrer" fit="cover" style="width:46px;height:46px;border-radius:4px" :preview-src-list="[row.image]" preview-teleported hide-on-click-modal /></template>
                </el-table-column>
                <el-table-column label="规格（中文→俄文）" min-width="170">
                  <template #default="{ row }">
                    <el-input v-model="row.spec" size="small" placeholder="1688 规格" />
                    <el-input v-model="row.specRu" size="small" placeholder="俄文规格（AI 填充/手填，上传用这个）" style="margin-top:4px" />
                  </template>
                </el-table-column>
                <el-table-column label="采购 ¥" width="100"><template #default="{ row }"><el-input-number v-model="row.purchaseCny" :min="0" :precision="2" :controls="false" size="small" style="width:100%" /></template></el-table-column>
                <el-table-column :label="'售价 ' + currencySymbol" width="110"><template #default="{ row }"><el-input-number v-model="row[priceField()]" :min="0" :precision="currencyId === 'CNY' ? 2 : 0" :controls="false" size="small" style="width:100%" /></template></el-table-column>
                <el-table-column :label="'划线价 ' + currencySymbol" width="110"><template #default="{ row }"><el-input-number v-model="row[oldPriceField()]" :min="0" :precision="currencyId === 'CNY' ? 2 : 0" :controls="false" size="small" style="width:100%" /></template></el-table-column>
                <el-table-column label="重量kg" width="100"><template #default="{ row }"><el-input-number v-model="row.weightKg" :min="0" :precision="3" :controls="false" size="small" style="width:100%" /></template></el-table-column>
                <el-table-column label="长" width="90"><template #default="{ row }"><el-input-number v-model="row.lengthCm" :min="0" :precision="1" :controls="false" size="small" style="width:100%" /></template></el-table-column>
                <el-table-column label="宽" width="90"><template #default="{ row }"><el-input-number v-model="row.widthCm" :min="0" :precision="1" :controls="false" size="small" style="width:100%" /></template></el-table-column>
                <el-table-column label="高" width="90"><template #default="{ row }"><el-input-number v-model="row.heightCm" :min="0" :precision="1" :controls="false" size="small" style="width:100%" /></template></el-table-column>
                <el-table-column label="库存" width="90"><template #default="{ row }"><el-input-number v-model="row.stock" :min="0" :precision="0" :controls="false" size="small" style="width:100%" /></template></el-table-column>
                <el-table-column label="变体特征" width="110">
                  <template #default="{ row, $index }">
                    <el-button size="small" plain @click="openSkuParams(row, $index)">
                      {{ (row.params || []).length ? '已设(' + row.params.length + ')' : '设置' }}
                    </el-button>
                  </template>
                </el-table-column>
                <el-table-column label="操作" width="70"><template #default="{ $index }"><el-button size="small" type="danger" plain @click="removeSku($index)">删</el-button></template></el-table-column>
              </el-table>
              <div style="display:flex; align-items:center; gap:10px; margin-top:8px; flex-wrap:wrap">
                <span style="font-size:13px; color:#334155">写库存仓库：</span>
                <el-select v-model="warehouseId" placeholder="选择仓库（FBS 必须写库存才可售）" style="width:260px" size="small">
                  <el-option v-for="w in warehouses" :key="w.id" :label="w.name + ' (' + w.id + ')'" :value="w.id" />
                </el-select>
                <el-button size="small" @click="loadWarehouses">刷新仓库</el-button>
                <span style="font-size:12px; color:#94a3b8">每个 SKU 的「库存」列 > 0 时，上传会一并写到该仓库（Yandex FBS 不写库存会停在 NO_STOCKS 不可售）</span>
              </div>
              <div style="font-size:12px; color:#b45309; margin-top:4px">
                变体：多个 SKU 会被 Yandex 归到同一张卡。若要同卡发布，需在「类目参数」里填「Название группы вариантов(变体组名)」，并用每个 SKU 的「变体特征」按钮给特征参数设不同值；否则 Yandex 会报「Дубль варианта」不发布该组。
              </div>
              <div style="display:none">
              </div>
              <div style="font-size:12px; color:#94a3b8; margin-top:6px">售价/划线价按店铺结算币种填写（当前 {{ currencyId }}）。Yandex 只接受店铺币种，填错会上传失败。</div>
            </el-card>

            <el-card shadow="never" style="margin-bottom:14px">
              <template #header>
                <b>利润计算</b>
                <span style="font-size:12px; color:#94a3b8; float:right">{{ profit.rateText || '正在读取汇率…' }}</span>
              </template>
              <el-row :gutter="8">
                <el-col :span="4"><div style="font-size:12px;color:#64748b">代贴单费 ¥</div><el-input-number v-model="profit.cost.serviceFeeCny" :min="0" :precision="2" :controls="false" size="small" style="width:100%" /></el-col>
                <el-col :span="4"><div style="font-size:12px;color:#64748b">国内运费 ¥</div><el-input-number v-model="profit.cost.domesticShippingCny" :min="0" :precision="2" :controls="false" size="small" style="width:100%" /></el-col>
                <el-col :span="4"><div style="font-size:12px;color:#64748b">尾程/物流商 ¥</div><el-input-number v-model="profit.cost.lastMileCny" :min="0" :precision="2" :controls="false" size="small" style="width:100%" /></el-col>
                <el-col :span="4"><div style="font-size:12px;color:#64748b">平台佣金 %</div><el-input-number v-model="profit.cost.commissionPct" :min="0" :precision="2" :controls="false" size="small" style="width:100%" /></el-col>
                <el-col :span="4"><div style="font-size:12px;color:#64748b">银行收单 %</div><el-input-number v-model="profit.cost.acquiringPct" :min="0" :precision="2" :controls="false" size="small" style="width:100%" /></el-col>
                <el-col :span="4"><div style="font-size:12px;color:#64748b">提现费率 %</div><el-input-number v-model="profit.cost.withdrawalPct" :min="0" :precision="2" :controls="false" size="small" style="width:100%" /></el-col>
              </el-row>
              <el-row :gutter="8" style="margin-top:8px">
                <el-col :span="4"><div style="font-size:12px;color:#64748b">退货亏损 %</div><el-input-number v-model="profit.cost.returnLossPct" :min="0" :precision="2" :controls="false" size="small" style="width:100%" /></el-col>
                <el-col :span="4"><div style="font-size:12px;color:#64748b">广告费率 %</div><el-input-number v-model="profit.cost.adPct" :min="0" :precision="2" :controls="false" size="small" style="width:100%" /></el-col>
                <el-col :span="4"><div style="font-size:12px;color:#64748b">目标毛利率 %</div><el-input-number v-model="profit.cost.targetMarginPct" :min="0" :max="90" :precision="2" :controls="false" size="small" style="width:100%" /></el-col>
                <el-col :span="4"><div style="font-size:12px;color:#64748b">划线价折扣 %</div><el-input-number v-model="profit.cost.strikeDiscountPct" :min="1" :max="100" :precision="0" :controls="false" size="small" style="width:100%" /></el-col>
                <el-col :span="4"><div style="font-size:12px;color:#64748b">汇率 CNY→RUB</div><el-input-number v-model="profit.cost.exchangeRate" :min="0" :precision="4" :controls="false" size="small" style="width:100%" /></el-col>
                <el-col :span="4" style="display:flex; align-items:flex-end; gap:6px">
                  <el-button size="small" type="primary" plain :loading="profit.busy" @click="calcProfit">计算</el-button>
                  <el-button size="small" type="success" plain :disabled="!profit.rows.length" @click="applyProfitPrices">填入售价</el-button>
                </el-col>
              </el-row>
              <div style="font-size:12px; color:#94a3b8; margin-top:6px">佣金：填 0 时按类目自动匹配（兜底 24%）；尾程/物流商默认 ¥4.68，可按你实际物流商改。计算后点「填入售价」写入 SKU 表（{{ currencyId }} 币种），再保存/上传。</div>
              <el-table v-if="profit.rows.length" :data="profit.rows" size="small" border style="margin-top:8px">
                <el-table-column label="SKU" prop="spec" min-width="120" show-overflow-tooltip />
                <el-table-column label="建议售价 ¥" width="100" align="right"><template #default="{ row }"><b v-if="row.ok" style="color:#047857">{{ row.priceCny }}</b><span v-else style="color:#b91c1c">算不出</span></template></el-table-column>
                <el-table-column label="建议售价 ₽" width="100" align="right"><template #default="{ row }">{{ row.priceRub || '-' }}</template></el-table-column>
                <el-table-column label="划线价 ¥" width="90" align="right"><template #default="{ row }">{{ row.strikeCny || '-' }}</template></el-table-column>
                <el-table-column label="头程 ¥" width="80" align="right"><template #default="{ row }">{{ row.celFeeCny }}</template></el-table-column>
                <el-table-column label="佣金 %" width="90" align="right"><template #default="{ row }">{{ row.commission }}<span v-if="row.commissionSource==='auto'" style="color:#94a3b8;font-size:11px"> 类目</span></template></el-table-column>
                <el-table-column label="利润 ¥" width="90" align="right"><template #default="{ row }"><b style="color:#2563eb">{{ row.profitCny }}</b></template></el-table-column>
                <el-table-column label="分区" prop="zone" width="110" show-overflow-tooltip />
              </el-table>
            </el-card>

            <el-card shadow="never" style="margin-bottom:14px">
              <template #header><b>图片与视频</b><div style="float:right"><el-button size="small" @click="addImage">添加图片 URL</el-button></div></template>
              <div style="display:flex; flex-wrap:wrap; gap:8px">
                <div v-for="(img, i) in drawer.draft.images" :key="i" style="position:relative">
                  <el-image :src="img" referrerpolicy="no-referrer" fit="cover" style="width:76px;height:76px;border-radius:6px;background:#f1f5f9" :preview-src-list="drawer.draft.images" preview-teleported hide-on-click-modal />
                  <el-button size="small" type="danger" circle style="position:absolute; top:-6px; right:-6px" @click="removeImage(i)">×</el-button>
                </div>
                <div v-if="!(drawer.draft.images || []).length" style="color:#94a3b8; font-size:13px">暂无图片（应从采集结果自动带入）</div>
              </div>
              <div style="margin-top:10px">
                <el-form label-width="90px" size="small">
                  <el-form-item label="商品视频"><el-input v-model="drawer.draft.videoUrl" placeholder="mp4 URL（可选）" /></el-form-item>
                  <el-form-item label="详情图">
                    <span style="font-size:12px; color:#64748b">采集到 {{ (drawer.draft.detailImages || []).length }} 张（详情图仅用于参考，Yandex 卡片只吃主图）</span>
                  </el-form-item>
                </el-form>
              </div>
            </el-card>

            <div style="display:flex; gap:10px; justify-content:flex-end; padding-bottom:16px">
              <el-button :loading="drawer.aiBusy" @click="aiFill">AI 智能填充（俄文标题/描述/属性）</el-button>
              <el-button :loading="drawer.saveBusy" @click="saveDraft">保存</el-button>
              <el-button type="primary" :loading="drawer.uploadBusy" @click="uploadFromDrawer">保存并上传到 Yandex</el-button>
            </div>
          </template>
        </div>
      </el-drawer>

      <!-- 每个 SKU 的变体特征值 -->
      <el-dialog v-model="skuParamDialog.visible" :title="'变体特征值 · ' + skuParamDialog.spec" width="560px">
        <el-alert type="info" :closable="false" show-icon style="margin-bottom:10px"
          title="同一张卡的不同变体，必须在这里给「变体特征」参数填不同的值（其余参数保持一致）。" />
        <el-table :data="skuParamDialog.rows" size="small" border empty-text="当前类目没有变体特征参数">
          <el-table-column label="特征参数" min-width="180">
            <template #default="{ row }"><div>{{ row.name }}</div><div v-if="row.nameZh" style="font-size:12px;color:#94a3b8">{{ row.nameZh }}</div></template>
          </el-table-column>
          <el-table-column label="值" min-width="200">
            <template #default="{ row }">
              <el-select v-if="row.options && row.options.length" v-model="row.valueId" filterable clearable placeholder="选择枚举值" style="width:100%">
                <el-option v-for="o in row.options" :key="o.id" :label="o.value" :value="o.id" />
              </el-select>
              <el-input v-else v-model="row.value" placeholder="数值/文本" />
            </template>
          </el-table-column>
        </el-table>
        <template #footer>
          <el-button @click="skuParamDialog.visible = false">取消</el-button>
          <el-button type="primary" @click="saveSkuParams">保存</el-button>
        </template>
      </el-dialog>
    </div>
  `,
};
