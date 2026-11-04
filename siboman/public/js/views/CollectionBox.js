window.CollectionBoxView = {
  setup() {
    const items = Vue.ref([]);
    const loading = Vue.ref(false);
    const drawer = Vue.reactive({ 
      visible: false, 
      itemId: '', 
      form: {},
      showProfitCalc: false,
      calc: { cost_cny: 0, profit_rate: 30 }
    });
    const uploadShop = Vue.reactive({ visible: false, row: null, note: '' });
    const garmentGenders = ['自动', '男装', '女装', '童装', '中性'];
    const importText = Vue.ref('');
    const activeTab = Vue.ref('all');
    const search = Vue.ref('');
    const selectedRows = Vue.ref([]);
    const statusCounts = Vue.reactive({ all: 0 });
    const pagination = Vue.reactive({ currentPage: 1, pageSize: 20, total: 0 });

    const statusTabs = [
      { label: '全部', value: 'all' },
      { label: '待采集', value: 'pending' },
      { label: '已采集', value: 'scraped' },
      { label: '已上架', value: 'uploaded' },
      { label: '失败', value: 'failed' },
      { label: '已忽略', value: 'ignored' },
    ];
    const statusDescriptions = {
      pending: '已入库, 等待采集端领取或重试',
      scraped: '采集完成, 可编辑资料后送去批量上架',
      uploaded: '已由上架流程标记为完成',
      failed: '采集失败, 请先查看失败原因后重试',
      ignored: '已忽略, 默认不参与处理',
    };

    const currentStoreId = Vue.computed(() => String(window.getCurrentStoreId?.() || localStorage.getItem('currentStoreId') || '').split(',')[0].trim());
    let searchTimer = null;
    const rowFailureReason = (row) => row.note || row.error || row.fail_reason || '暂无失败原因';
    const taskSummary = (row) => {
      if (row.linked_job_id) return `任务 ${String(row.linked_job_id).slice(0, 8)} · ${statusDescriptions[row.status] || statusLabel(row.status)}`;
      return statusDescriptions[row.status] || statusLabel(row.status);
    };

    const fetchItems = async () => {
      loading.value = true;
      try {
        const res = await axios.get('/api/collect-items', {
          params: { 
            status: activeTab.value, 
            store_id: currentStoreId.value,
            search: search.value,
            limit: pagination.pageSize,
            offset: (pagination.currentPage - 1) * pagination.pageSize
          }
        });
        items.value = res.data.items || [];
        pagination.total = res.data.total || 0;
        Object.assign(statusCounts, { all: 0 }, res.data.status_counts || {});
      } catch (e) {
        ElementPlus.ElMessage.error('获取采集箱失败：' + (e.response?.data?.error || e.message));
      } finally {
        loading.value = false;
      }
    };

    const handleImport = async () => {
      if (!importText.value.trim()) return;
      const lines = importText.value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!lines.length) return;
      const MAX = 5;
      if (lines.length > MAX) {
        ElementPlus.ElMessage.warning(`单次最多 ${MAX} 条采集链接，超出部分将被忽略（当前 ${lines.length} 条）`);
        importText.value = lines.slice(0, MAX).join('\n');
      }
      try {
        const res = await axios.post('/api/collect-items', { inputs: importText.value, storeId: currentStoreId.value });
        ElementPlus.ElMessage.success(`已加入 ${res.data.insertedCount || 0} 条，跳过 ${res.data.skippedCount || 0} 条重复数据`);
        importText.value = '';
        fetchItems();
      } catch (e) {
        ElementPlus.ElMessage.error('采集失败：' + (e.response?.data?.error || e.message));
      }
    };

    const defaultVariant = (row = {}) => ({
      sku: row.ozon_sku || row.sku || '',
      title: row.title || '',
      color_image: '',
      main_image: row.main_image || '',
      images: Array.isArray(row.images) ? row.images : [],
      cost_price: row.price_cny ?? null,
      price: row.price_rub ?? null,
      old_price: null,
      weight: row.weight ?? null,
      weight_unit: 'g',
      depth: row.depth ?? null,
      width: row.width ?? null,
      height: row.height ?? null,
      dimension_unit: 'mm',
      merge: false,
      color_name: '',
      color: '',
      manufacturer_size: '',
      russian_size: '',
    });
    const addVariant = () => { drawer.form.variants.push(defaultVariant({})); };
    const removeVariant = (i) => { if (drawer.form.variants.length > 1) drawer.form.variants.splice(i, 1); };
    const editItem = (row) => {
      drawer.itemId = row.id;
      drawer.form = JSON.parse(JSON.stringify(row));
      drawer.form.attributes = drawer.form.attributes || {};
      drawer.form.variants = (Array.isArray(drawer.form.variants) && drawer.form.variants.length)
        ? drawer.form.variants.map((v) => ({ ...defaultVariant(row), ...v }))
        : [defaultVariant(row)];
      drawer.form.vat = drawer.form.vat || '0';
      drawer.form.garment_gender = drawer.form.garment_gender || '自动';
      drawer.form.category_name = drawer.form.category_name || '';
      drawer.visible = true;
    };

    // ===== AI 能力（翻译标题 / AI智能填充，复用 /api/ai/* ）=====
    const aiFilling = Vue.ref(false);
    const translateTitle = async () => {
      if (!drawer.form.title) return ElementPlus.ElMessage.warning('请先填写商品名称');
      aiFilling.value = true;
      try {
        const res = await axios.post('/api/ai/translate', { text: drawer.form.title, target_lang: 'ru' });
        drawer.form.title = res.data.translated || drawer.form.title;
        ElementPlus.ElMessage.success('标题已翻译为俄语');
      } catch (e) { ElementPlus.ElMessage.error('翻译失败：' + (e.response?.data?.error || e.message)); }
      finally { aiFilling.value = false; }
    };
    const aiFill = async () => {
      if (!drawer.form.title && !drawer.form.main_image) return ElementPlus.ElMessage.warning('请先填写标题或提供主图');
      aiFilling.value = true;
      try {
        const res = await axios.post('/api/ai/analyze', {
          title: drawer.form.title,
          images: (drawer.form.images || []).filter(Boolean).slice(0, 5),
          target_market: 'ozon',
          store_id: currentStoreId.value,
        });
        const d = res.data?.data || {};
        if (d.category_name) drawer.form.category_name = d.category_name;
        if (d.brand) drawer.form.brand = d.brand;
        if (d.product_type) drawer.form.attributes.type = d.product_type;
        if (d.title_ru) drawer.form.title = d.title_ru;
        if (d.description) drawer.form.description = d.description;
        ElementPlus.ElMessage.success('AI 智能填充完成');
      } catch (e) { ElementPlus.ElMessage.error('AI 填充失败：' + (e.response?.data?.error || e.message)); }
      finally { aiFilling.value = false; }
    };

    // ===== 一键添加水印（复用 /api/images/watermark）=====
    const waterMarking = Vue.ref(false);
    const watermarkText = Vue.ref('逐梦ERP');
    const watermarkImages = async () => {
      const seen = new Set();
      if (drawer.form.main_image) seen.add(drawer.form.main_image);
      (drawer.form.images || []).forEach((u) => u && seen.add(u));
      (drawer.form.variants || []).forEach((v) => {
        if (v.main_image) seen.add(v.main_image);
        if (v.color_image) seen.add(v.color_image);
        (v.images || []).forEach((u) => u && seen.add(u));
      });
      const list = [...seen].filter(Boolean);
      if (!list.length) return ElementPlus.ElMessage.warning('该商品没有图片可加水印');
      const text = (watermarkText.value || '逐梦ERP').trim();
      waterMarking.value = true;
      try {
        const res = await axios.post('/api/images/watermark', { images: list, text });
        const map = {};
        list.forEach((u, i) => { map[u] = res.data.images?.[i] || u; });
        if (drawer.form.main_image) drawer.form.main_image = map[drawer.form.main_image] || drawer.form.main_image;
        drawer.form.images = (drawer.form.images || []).map((u) => map[u] || u);
        (drawer.form.variants || []).forEach((v) => {
          if (v.main_image) v.main_image = map[v.main_image] || v.main_image;
          if (v.color_image) v.color_image = map[v.color_image] || v.color_image;
          v.images = (v.images || []).map((u) => map[u] || u);
        });
        ElementPlus.ElMessage.success(`已为 ${list.length} 张图片添加水印`);
      } catch (e) { ElementPlus.ElMessage.error('水印失败：' + (e.response?.data?.error || e.message)); }
      finally { waterMarking.value = false; }
    };

    const suggestedPrice = Vue.computed(() => {
      if (!drawer.calc.cost_cny) return 0;
      const rate = 0.0862;
      return Math.ceil((drawer.calc.cost_cny / (1 - drawer.calc.profit_rate / 100)) / rate);
    });

    const applySuggestedPrice = () => {
      drawer.form.price_rub = suggestedPrice.value;
      drawer.showProfitCalc = false;
    };

    const saveDraft = async () => {
      try {
        await axios.put(`/api/collect-items/${drawer.itemId}`, drawer.form);
        ElementPlus.ElMessage.success('采集资料已保存到本地, 尚未上架');
        drawer.visible = false;
        fetchItems();
      } catch (e) {
        ElementPlus.ElMessage.error('保存失败：' + (e.response?.data?.error || e.message));
      }
    };

    const onTabChange = () => { pagination.currentPage = 1; fetchItems(); };
    const onSearch = () => { pagination.currentPage = 1; fetchItems(); };
    const onSizeChange = () => { pagination.currentPage = 1; fetchItems(); };
    const onSearchInput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(onSearch, 350);
    };
    const onSelectionChange = (rows) => { selectedRows.value = rows || []; };

    const updateStatus = async (row, status) => {
      try {
        await axios.post(`/api/collect-items/${row.id}`, { status });
        ElementPlus.ElMessage.success(status === 'ignored' ? '已忽略' : '已恢复');
        fetchItems();
      } catch (e) {
        ElementPlus.ElMessage.error('更新失败：' + (e.response?.data?.error || e.message));
      }
    };

    const bulkDelete = async () => {
      if (!selectedRows.value.length) return ElementPlus.ElMessage.warning('请先选择采集项');
      try {
        await ElementPlus.ElMessageBox.confirm(
          `确定删除选中的 ${selectedRows.value.length} 条记录？`,
          '批量删除',
          { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
        );
      } catch { return; }
      try {
        const res = await axios.post('/api/collect-items/bulk-delete', { ids: selectedRows.value.map((row) => row.id) });
        ElementPlus.ElMessage.success(`已删除 ${res.data.deleted || 0} 条`);
        selectedRows.value = [];
        fetchItems();
      } catch (e) {
        ElementPlus.ElMessage.error('删除失败：' + (e.response?.data?.error || e.message));
      }
    };
    const deleteItem = async (row) => {
      try {
        await ElementPlus.ElMessageBox.confirm(
          `确定删除「${row.title || row.ozon_sku || row.id}」？删除后不会影响已上架商品, 但采集箱记录不可恢复。`,
          '删除采集项',
          { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' },
        );
      } catch { return; }
      try {
        await axios.delete(`/api/collect-items/${row.id}`);
        ElementPlus.ElMessage.success('采集项已删除');
        fetchItems();
      } catch (e) {
        ElementPlus.ElMessage.error('删除失败：' + (e.response?.data?.error || e.message));
      }
    };

    const retryItem = async (row) => {
      try {
        const res = await axios.post(`/api/collect-items/${row.id}/retry`);
        ElementPlus.ElMessage.success(`已重新创建采集任务 ${res.data.job_id || ''}`);
        fetchItems();
      } catch (e) { ElementPlus.ElMessage.error('重试失败：' + (e.response?.data?.error || e.message)); }
    };
    const sendToListing = async (row) => {
      if (row.status === 'failed') return ElementPlus.ElMessage.warning('失败采集项请先重新采集, 成功后再送上架');
      if (!row.ozon_sku && !row.ozon_url) return ElementPlus.ElMessage.warning('缺少 Ozon SKU 或链接, 暂不能送上架');
      try {
        await ElementPlus.ElMessageBox.confirm(
          '将把这条采集资料放入本地待上架暂存, 并跳转到批量上架页。不会自动提交 Ozon。',
          '送入上架确认',
          { type: 'info', confirmButtonText: '去上架页', cancelButtonText: '取消' },
        );
      } catch { return; }
      const payload = {
        from: 'collection-box',
        created_at: new Date().toISOString(),
        item: {
          id: row.id,
          ozon_sku: row.ozon_sku,
          ozon_url: row.ozon_url,
          title: row.title,
          price_rub: row.price_rub,
          source_url_1688: row.source_url_1688,
          price_cny: row.price_cny,
          weight: row.weight,
          depth: row.depth,
          width: row.width,
          height: row.height,
        },
      };
      try { localStorage.setItem('collection_box_listing_prefill', JSON.stringify(payload)); } catch {}
      ElementPlus.ElMessage.success('已暂存采集资料, 请在批量上架页确认后提交');
      window.location.hash = '#/upload';
    };

    // ===== 上传店铺（选店铺 + 备注，复刻熊猫采集箱）=====
    const openUploadShop = (row) => {
      if (row.status === 'failed') return ElementPlus.ElMessage.warning('失败采集项请先重新采集, 成功后再送上架');
      if (!row.ozon_sku && !row.ozon_url) return ElementPlus.ElMessage.warning('缺少 Ozon SKU 或链接, 暂不能上传店铺');
      uploadShop.row = row;
      uploadShop.note = (row.attributes && row.attributes.upload_note) || '';
      uploadShop.visible = true;
    };
    const confirmUploadShop = async () => {
      const row = uploadShop.row;
      if (!row) return;
      const attrs = { ...(row.attributes || {}), upload_note: uploadShop.note };
      try { await axios.put(`/api/collect-items/${row.id}`, { attributes: attrs }); } catch {}
      uploadShop.visible = false;
      sendToListing(row);
    };

    // ===== AI 套图（共享客户端：public/js/image-set-client.js）=====
    const aiImg = Vue.reactive({});   // itemId -> { busy, jobId, phase, processed, total, error, images }
    const aiImageSet = async (row) => {
      const itemId = String(row?.id || '');
      if (!itemId) return ElementPlus.ElMessage.warning('该采集项没有 ID，无法出图');
      if (!row.main_image && !(row.images || []).length) return ElementPlus.ElMessage.warning('该采集项没有图片，无法出图');
      aiImg[itemId] = { busy: true, jobId: '', phase: '正在提交出图任务…', processed: 0, total: 7, error: '', images: [] };
      const onState = (patch) => Object.assign(aiImg[itemId], patch);
      try {
        ElementPlus.ElMessage.success('AI 出图已开始（7 张，约 5-8 分钟），可以先去干别的');
        const r = await ImageSetClient.runOzonItem({ itemId, onState });
        if (r.status === 'done') {
          ElementPlus.ElMessage.success('AI 套图已写回该商品，可直接送上架');
          fetchItems().catch(() => {});
        } else {
          ElementPlus.ElMessage.error('AI 出图失败: ' + r.error);
        }
      } catch (e) {
        onState({ error: e.response?.data?.error || e.message || '失败' });
        ElementPlus.ElMessage.error('AI 出图失败: ' + aiImg[itemId].error);
      } finally { aiImg[itemId].busy = false; }
    };

    const exportCsv = () => {
      const rows = [['Ozon SKU','标题','Ozon链接','主图','全部图片','售价(RUB)','1688链接','1688成本(CNY)','状态','失败原因'], ...items.value.map(row => [row.ozon_sku,row.title,row.ozon_url,row.main_image,(row.images || []).join(' | '),row.price_rub,row.source_url_1688,row.price_cny,statusLabel(row.status),row.note])];
      const csv = rows.map(row => row.map(value => `"${String(value ?? '').replaceAll('"','""')}"`).join(',')).join('\n');
      const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `采集箱-${new Date().toISOString().slice(0,10)}.csv`; anchor.click(); URL.revokeObjectURL(url);
    };

    const statusLabel = (status) => ({
      pending: '待采集', scraped: '已采集', uploaded: '已上架', failed: '失败', ignored: '已忽略',
    }[status] || status || '未知');
    const statusType = (status) => ({
      pending: 'warning', scraped: 'success', uploaded: 'success', failed: 'danger', ignored: 'info',
    }[status] || 'info');

    const getProfitStyle = (row) => {
      if (!row.price_rub || !row.price_cny) return {};
      const margin = (row.price_rub * 0.0862 - row.price_cny) / (row.price_rub * 0.0862);
      if (margin < 0.15) return { color: '#f56c6c', fontWeight: 'bold' };
      if (margin > 0.30) return { color: '#67c23a', fontWeight: 'bold' };
      return { color: '#e6a23c' };
    };

    Vue.onMounted(fetchItems);
    const onShopChanged = () => { pagination.currentPage = 1; selectedRows.value = []; fetchItems(); };
    window.addEventListener('shop-changed', onShopChanged);
    Vue.onBeforeUnmount(() => { clearTimeout(searchTimer); window.removeEventListener('shop-changed', onShopChanged); });

    return { 
      items, loading, importText, handleImport, editItem, drawer,
      activeTab, search, selectedRows, statusCounts, statusTabs,
      pagination, fetchItems, getProfitStyle, suggestedPrice, applySuggestedPrice, saveDraft,
      onTabChange, onSearch, onSearchInput, onSizeChange, onSelectionChange, updateStatus, bulkDelete, deleteItem, retryItem, sendToListing, exportCsv,
      statusLabel, statusType, statusDescriptions, rowFailureReason, taskSummary,
      aiImg, aiImageSet,
      uploadShop, garmentGenders, openUploadShop, confirmUploadShop, addVariant, removeVariant,
      aiFilling, translateTitle, aiFill,
      waterMarking, watermarkText, watermarkImages,
    };
  },
  template: `
    <div class="collection-box-v3" style="background:#f8fafc; min-height:100%; padding:22px 30px 28px; box-sizing:border-box">
      <div style="max-width:1500px; margin:0 auto">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px; margin-bottom:18px">
          <div>
            <div style="font-size:28px; line-height:1.2; font-weight:900; color:#111827">采集箱</div>
            <div style="margin-top:14px; font-size:14px; color:#64748b; font-weight:700">共 {{ pagination.total }} 条采集项 · 当前 {{ statusLabel(activeTab) }}</div>
          </div>
          <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end">
            <el-button size="large" @click="fetchItems">
              <el-icon><Refresh /></el-icon><span>刷新</span>
            </el-button>
            <el-button size="large" @click="exportCsv">
              <el-icon><Download /></el-icon><span>导出 CSV</span>
            </el-button>
            <el-button size="large" type="danger" plain :disabled="!selectedRows.length" @click="bulkDelete">批量删除 ({{ selectedRows.length }})</el-button>
          </div>
        </div>

        <div style="background:#fff; border:1px solid #dfe7f1; border-radius:8px; padding:14px; margin-bottom:16px">
          <div style="display:grid; grid-template-columns:minmax(320px,1fr) 132px; gap:12px; align-items:start">
            <el-input v-model="importText" type="textarea" :rows="3" resize="vertical" placeholder="粘贴 1688 / 淘宝 / 拼多多 / Ozon 链接，每行一条，单次最多 5 条" />
            <el-button size="large" type="primary" style="height:76px; background:#111827; border-color:#111827" @click="handleImport">加入采集箱</el-button>
          </div>
          <div style="margin-top:8px; color:#64748b; font-size:12px; font-weight:700">支持 1688 / 淘宝 / 拼多多 / Ozon 链接，来源自动识别；加入后只创建采集箱记录和采集任务，上传店铺需在采集完成后手动确认。</div>
        </div>

        <div style="background:#fff; border:1px solid #dfe7f1; border-radius:8px; padding:6px; margin-bottom:14px; display:flex; gap:8px; flex-wrap:wrap">
          <button
            v-for="tab in statusTabs"
            :key="tab.value"
            type="button"
            @click="activeTab = tab.value; onTabChange()"
            :style="{
              border:'0',
              borderRadius:'7px',
              padding:'9px 14px',
              fontWeight:800,
              cursor:'pointer',
              background: activeTab === tab.value ? '#111827' : '#fff',
              color: activeTab === tab.value ? '#fff' : '#64748b'
            }">
            {{ tab.label }} <span style="margin-left:6px; opacity:.78">{{ statusCounts[tab.value] || 0 }}</span>
          </button>
        </div>

        <div style="display:grid; grid-template-columns:minmax(320px,1fr) 92px; gap:10px; align-items:center; margin-bottom:14px">
          <el-input v-model="search" clearable size="large" placeholder="搜索标题 / SKU / 链接" @input="onSearchInput" @keyup.enter="onSearch">
            <template #prefix><el-icon><Search /></el-icon></template>
          </el-input>
          <el-button size="large" type="primary" style="background:#111827; border-color:#111827" @click="onSearch">筛选</el-button>
        </div>

        <el-table :data="items" v-loading="loading" element-loading-text="正在读取采集箱" size="large" stripe border style="border-radius:8px; overflow:hidden; box-shadow:0 8px 24px rgba(15,23,42,.04)" empty-text="暂无采集项。请粘贴 Ozon / 1688 / 拼多多 链接或 SKU 后加入采集箱。" @selection-change="onSelectionChange">
          <el-table-column type="selection" width="52" />
          <el-table-column label="商品信息" min-width="360">
            <template #default="{ row }">
              <div style="display: flex; gap: 10px; align-items: center">
                <el-image v-if="row.main_image" :src="row.main_image" style="width:58px; height:58px; border-radius:8px; background:#f1f5f9" fit="cover" preview-teleported :preview-src-list="row.images?.length ? row.images : [row.main_image]" />
                <div v-else style="width:58px;height:58px;border-radius:8px;background:#f1f5f9;color:#94a3b8;display:flex;align-items:center;justify-content:center;font-size:11px">无图</div>
                <div style="flex: 1; min-width: 0">
                  <div class="text-ellipsis" style="font-size:15px; line-height:1.4; font-weight:800; color:#1f2937">{{ row.title || '正在采集...' }}</div>
                  <div style="font-size:12px; color:#94a3b8; margin-top:7px">
                    <el-tag v-if="['1688','pdd'].includes(String(row.source_type || ''))" size="small"
                            :type="row.source_type === '1688' ? 'warning' : 'danger'" style="margin-right:6px">
                      {{ row.source_type === '1688' ? '1688' : '拼多多' }}
                    </el-tag>
                    SKU: {{ row.ozon_sku || '-' }}
                  </div>
                  <div v-if="row.status === 'failed'" style="font-size:11px; color:#f56c6c; margin-top:3px">{{ rowFailureReason(row) }}</div>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="采集任务" min-width="170" show-overflow-tooltip>
            <template #default="{ row }">
              <div style="font-size:12px; color:#606266">{{ taskSummary(row) }}</div>
              <div v-if="row.status === 'failed'" style="font-size:11px; color:#f56c6c">{{ rowFailureReason(row) }}</div>
            </template>
          </el-table-column>
          <el-table-column label="1688 货源" width="120">
             <template #default="{ row }">
                <a v-if="row.source_url_1688" :href="row.source_url_1688" target="_blank" rel="noopener noreferrer">查看货源</a>
                <div v-if="row.price_cny">¥ {{ row.price_cny }}</div>
                <div v-else-if="!row.source_url_1688" style="color:#ccc">未匹配</div>
             </template>
          </el-table-column>
          <el-table-column label="类目" min-width="140" show-overflow-tooltip>
            <template #default="{ row }">{{ row.category_name || '—' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tooltip :content="statusDescriptions[row.status] || statusLabel(row.status)" placement="top">
                <el-tag size="small" :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag>
              </el-tooltip>
            </template>
          </el-table-column>
          <el-table-column label="发布状态" width="110">
            <template #default="{ row }">
              <el-tag size="small" :type="row.status === 'uploaded' ? 'success' : 'info'">{{ row.publish_status || (row.status === 'uploaded' ? '上传成功' : '未上传') }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="采集时间" width="120">
            <template #default="{ row }">
              <div style="font-size:12px;color:#606266">{{ String(row.collect_finished_at || row.updated_at || '').slice(0,10) }}</div>
            </template>
          </el-table-column>
          <el-table-column label="AI 套图" width="190" align="center">
            <template #default="{ row }">
              <el-button v-if="!(aiImg[row.id] && aiImg[row.id].busy)" link type="primary" :disabled="!row.main_image && !(row.images || []).length" @click="aiImageSet(row)">AI 出图</el-button>
              <div v-else style="font-size:11px; color:#b45309; line-height:1.5">
                {{ aiImg[row.id].phase }}<br />{{ aiImg[row.id].processed }}/{{ aiImg[row.id].total }}
              </div>
              <div v-if="aiImg[row.id] && aiImg[row.id].error" style="font-size:11px; color:#f56c6c; max-width:170px; white-space:normal">{{ aiImg[row.id].error.slice(0, 60) }}</div>
              <div v-if="(aiImg[row.id] && aiImg[row.id].images || []).length" style="display:flex; gap:4px; flex-wrap:wrap; justify-content:center; margin-top:6px">
                <el-image v-for="(u, i) in aiImg[row.id].images.slice(0, 7)" :key="u" :src="u"
                  :preview-src-list="aiImg[row.id].images" :initial-index="i" preview-teleported fit="cover"
                  style="width:26px; height:34px; border-radius:3px; background:#f1f5f9" />
              </div>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="260" fixed="right" align="center">
            <template #default="{ row }">
              <el-button link type="primary" @click="editItem(row)">编辑</el-button>
              <el-button v-if="row.status === 'scraped'" link type="success" @click="openUploadShop(row)">上传店铺</el-button>
              <el-button v-if="row.status === 'uploaded'" link type="success" @click="openUploadShop(row)">重新上传</el-button>
              <el-button v-if="row.status === 'failed'" link type="danger" @click="retryItem(row)">重新采集</el-button>
              <el-button v-if="row.status !== 'ignored'" link type="warning" @click="updateStatus(row, 'ignored')">忽略</el-button>
              <el-button v-else link type="success" @click="updateStatus(row, 'pending')">恢复</el-button>
              <el-button link type="danger" @click="deleteItem(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>

        <div style="position:sticky; bottom:0; left:0; right:0; margin-top:14px; padding:12px 0; background:#f8fafc; z-index:10; display:flex; justify-content:flex-end">
          <el-pagination
            v-model:current-page="pagination.currentPage"
            v-model:page-size="pagination.pageSize"
            :total="pagination.total"
            :page-sizes="[20, 50, 100]"
            layout="total, sizes, prev, pager, next"
            @current-change="fetchItems"
            @size-change="onSizeChange"
          />
        </div>
      </div>

            <!-- 商品属性编辑（复刻熊猫采集箱） -->
      <el-dialog v-model="drawer.visible" title="商品属性编辑" width="1280px" top="3vh" :close-on-click-modal="false">
        <el-alert title="保存只写入本地采集箱；上传走「上传店铺」并在批量上架页确认。" type="info" :closable="false" show-icon style="margin-bottom:12px" />
        <el-alert v-if="drawer.form.status === 'failed'" :title="rowFailureReason(drawer.form)" type="error" :closable="false" show-icon style="margin-bottom:12px" />

        <div style="display:flex; gap:16px; align-items:flex-end; margin-bottom:12px; flex-wrap:wrap">
          <div style="flex:1; min-width:320px">
            <div style="font-size:13px; font-weight:700; color:#111827; margin-bottom:4px">商品类目</div>
            <el-input v-model="drawer.form.category_name" placeholder="输入类目关键词（如：休闲鞋 / 豆豆鞋）" clearable />
          </div>
          <div>
            <div style="font-size:13px; font-weight:700; color:#111827; margin-bottom:4px">服装性别（辅助AI识别）</div>
            <el-radio-group v-model="drawer.form.garment_gender" size="small">
              <el-radio-button v-for="g in garmentGenders" :key="g" :value="g">{{ g }}</el-radio-button>
            </el-radio-group>
          </div>
        </div>

        <el-divider content-position="left">必填信息</el-divider>
        <el-row :gutter="16">
          <el-col :span="12"><el-form-item label="商品名称" required>
            <el-input v-model="drawer.form.title" />
            <div style="margin-top:6px; display:flex; gap:8px; flex-wrap:wrap; align-items:center">
              <el-button size="small" :loading="aiFilling" @click="translateTitle">翻译标题</el-button>
              <el-button size="small" type="primary" :loading="aiFilling" @click="aiFill">AI智能填充</el-button>
              <el-input v-model="watermarkText" size="small" style="width:130px" placeholder="水印文字" />
              <el-button size="small" type="warning" :loading="waterMarking" @click="watermarkImages">一键添加水印</el-button>
            </div>
          </el-form-item></el-col>
          <el-col :span="6"><el-form-item label="卖家ID"><el-input v-model="drawer.form.seller" /></el-form-item></el-col>
          <el-col :span="6"><el-form-item label="税率 VAT"><el-select v-model="drawer.form.vat" style="width:100%"><el-option value="0" label="0%" /><el-option value="0.1" label="10%" /><el-option value="0.2" label="20%" /></el-select></el-form-item></el-col>
        </el-row>

        <el-divider content-position="left">商品必填属性</el-divider>
        <el-row :gutter="16">
          <el-col :span="8"><el-form-item label="服装和鞋类品牌"><el-input v-model="drawer.form.brand" placeholder="无品牌填「无品牌」" /></el-form-item></el-col>
          <el-col :span="8"><el-form-item label="类型"><el-input v-model="drawer.form.attributes.type" /></el-form-item></el-col>
          <el-col :span="8"><el-form-item label="性别"><el-input v-model="drawer.form.attributes.gender" /></el-form-item></el-col>
        </el-row>

        <el-divider content-position="left">SKU 多变体列表</el-divider>
        <div style="margin-bottom:10px; display:flex; justify-content:space-between; align-items:center">
          <span style="font-size:13px; color:#64748b">共 {{ (drawer.form.variants || []).length }} 个变体</span>
          <el-button type="primary" size="small" @click="addVariant">+ 添加变体</el-button>
        </div>
        <div style="max-height:400px; overflow:auto; border:1px solid #e5e7eb; border-radius:8px">
          <table style="width:100%; border-collapse:collapse; font-size:12px; min-width:1600px">
            <thead>
              <tr style="background:#f8fafc">
                <th style="padding:8px; border:1px solid #e5e7eb">#</th>
                <th style="padding:8px; border:1px solid #e5e7eb">颜色样本图</th>
                <th style="padding:8px; border:1px solid #e5e7eb">主图</th>
                <th style="padding:8px; border:1px solid #e5e7eb">标题</th>
                <th style="padding:8px; border:1px solid #e5e7eb">SKU货号</th>
                <th style="padding:8px; border:1px solid #e5e7eb">成本价</th>
                <th style="padding:8px; border:1px solid #e5e7eb">售价</th>
                <th style="padding:8px; border:1px solid #e5e7eb">划线价</th>
                <th style="padding:8px; border:1px solid #e5e7eb">重量</th>
                <th style="padding:8px; border:1px solid #e5e7eb">长/宽/高</th>
                <th style="padding:8px; border:1px solid #e5e7eb">颜色名称</th>
                <th style="padding:8px; border:1px solid #e5e7eb">商品颜色</th>
                <th style="padding:8px; border:1px solid #e5e7eb">制造尺码</th>
                <th style="padding:8px; border:1px solid #e5e7eb">俄尺码</th>
                <th style="padding:8px; border:1px solid #e5e7eb">合并变体</th>
                <th style="padding:8px; border:1px solid #e5e7eb">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(v, i) in drawer.form.variants" :key="i">
                <td style="padding:6px; border:1px solid #e5e7eb; text-align:center">{{ i + 1 }}</td>
                <td style="padding:6px; border:1px solid #e5e7eb"><el-input v-model="v.color_image" placeholder="图片URL" size="small" /></td>
                <td style="padding:6px; border:1px solid #e5e7eb"><el-input v-model="v.main_image" placeholder="图片URL" size="small" /></td>
                <td style="padding:6px; border:1px solid #e5e7eb"><el-input v-model="v.title" size="small" /></td>
                <td style="padding:6px; border:1px solid #e5e7eb"><el-input v-model="v.sku" size="small" /></td>
                <td style="padding:6px; border:1px solid #e5e7eb"><el-input-number v-model="v.cost_price" :min="0" :controls="false" size="small" style="width:80px" /></td>
                <td style="padding:6px; border:1px solid #e5e7eb"><el-input-number v-model="v.price" :min="0" :controls="false" size="small" style="width:80px" /></td>
                <td style="padding:6px; border:1px solid #e5e7eb"><el-input-number v-model="v.old_price" :min="0" :controls="false" size="small" style="width:80px" /></td>
                <td style="padding:6px; border:1px solid #e5e7eb"><el-input-number v-model="v.weight" :min="0" :controls="false" size="small" style="width:72px" /></td>
                <td style="padding:6px; border:1px solid #e5e7eb">
                  <div style="display:flex; gap:2px">
                    <el-input-number v-model="v.depth" :min="0" :controls="false" size="small" style="width:58px" placeholder="长" />
                    <el-input-number v-model="v.width" :min="0" :controls="false" size="small" style="width:58px" placeholder="宽" />
                    <el-input-number v-model="v.height" :min="0" :controls="false" size="small" style="width:58px" placeholder="高" />
                  </div>
                </td>
                <td style="padding:6px; border:1px solid #e5e7eb"><el-input v-model="v.color_name" size="small" /></td>
                <td style="padding:6px; border:1px solid #e5e7eb"><el-input v-model="v.color" size="small" /></td>
                <td style="padding:6px; border:1px solid #e5e7eb"><el-input v-model="v.manufacturer_size" size="small" /></td>
                <td style="padding:6px; border:1px solid #e5e7eb"><el-input v-model="v.russian_size" size="small" /></td>
                <td style="padding:6px; border:1px solid #e5e7eb; text-align:center"><el-switch v-model="v.merge" size="small" /></td>
                <td style="padding:6px; border:1px solid #e5e7eb; text-align:center"><el-button link type="danger" size="small" @click="removeVariant(i)">删除</el-button></td>
              </tr>
            </tbody>
          </table>
        </div>

        <el-divider content-position="left">其他信息</el-divider>
        <el-row :gutter="16">
          <el-col :span="14"><el-form-item label="详细描述 (Description)"><el-input v-model="drawer.form.description" type="textarea" :rows="4" /></el-form-item></el-col>
          <el-col :span="10"><el-form-item label="1688 货源链接"><el-input v-model="drawer.form.source_url_1688" placeholder="https://detail.1688.com/offer/..." /></el-form-item></el-col>
        </el-row>

        <template #footer>
          <el-button @click="drawer.visible = false">关闭</el-button>
          <el-button type="primary" @click="saveDraft">保存采集资料</el-button>
        </template>
      </el-dialog>

      <!-- 上传店铺（选店铺 + 备注） -->
      <el-dialog v-model="uploadShop.visible" title="上传店铺" width="480px" :close-on-click-modal="false">
        <el-form label-position="top">
          <el-form-item label="选择店铺">
            <el-tag type="primary" size="medium">当前店铺</el-tag>
            <span style="margin-left:8px; font-size:12px; color:#94a3b8">（多店铺切换请使用右上角店铺选择器）</span>
          </el-form-item>
          <el-form-item label="上传备注">
            <el-input v-model="uploadShop.note" type="textarea" :rows="4" maxlength="2000" show-word-limit placeholder="选填" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="uploadShop.visible = false">取 消</el-button>
          <el-button type="primary" @click="confirmUploadShop">确 定</el-button>
        </template>
      </el-dialog>


      <!-- fx 计算器弹窗 -->
      <el-dialog v-model="drawer.showProfitCalc" title="fx 利润计算器" width="400px" append-to-body>
        <el-form label-width="120px">
          <el-form-item label="采购成本 (CNY)"><el-input-number v-model="drawer.calc.cost_cny" /></el-form-item>
          <el-form-item label="期望利润率 (%)"><el-input-number v-model="drawer.calc.profit_rate" /></el-form-item>
          <div style="padding: 15px; background:#f0f9eb; border-radius:4px; text-align:center">
             建议售价: <strong style="font-size: 18px; color: #67c23a">₽ {{ suggestedPrice }}</strong>
          </div>
        </el-form>
        <template #footer>
          <el-button type="primary" @click="applySuggestedPrice">应用建议价格</el-button>
        </template>
      </el-dialog>
    </div>
  `
};
