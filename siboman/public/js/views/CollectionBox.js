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
      try {
        const res = await axios.post('/api/collect-items', { inputs: importText.value, storeId: currentStoreId.value });
        ElementPlus.ElMessage.success(`已加入 ${res.data.insertedCount || 0} 条，跳过 ${res.data.skippedCount || 0} 条重复数据`);
        importText.value = '';
        fetchItems();
      } catch (e) {
        ElementPlus.ElMessage.error('采集失败：' + (e.response?.data?.error || e.message));
      }
    };

    const editItem = (row) => {
      drawer.itemId = row.id;
      drawer.form = JSON.parse(JSON.stringify(row));
      // 预设尺寸重量
      drawer.form.weight = drawer.form.weight || 0;
      drawer.form.depth = drawer.form.depth || 0;
      drawer.form.width = drawer.form.width || 0;
      drawer.form.height = drawer.form.height || 0;
      drawer.visible = true;
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

    // ===== AI 套图（Ozon 3:4 俄文 7 图）=====
    const aiImg = Vue.reactive({});   // itemId -> { busy, jobId, phase, processed, total, error, images }
    const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
    const aiImageSet = async (row) => {
      const itemId = String(row?.id || '');
      if (!itemId) return ElementPlus.ElMessage.warning('该采集项没有 ID，无法出图');
      if (!row.main_image && !(row.images || []).length) return ElementPlus.ElMessage.warning('该采集项没有图片，无法出图');
      const key = itemId;
      aiImg[key] = { busy: true, jobId: '', phase: '正在提交出图任务…', processed: 0, total: 7, error: '', images: [] };
      try {
        const res = await axios.post('/api/ozon/ai-image-set', { itemId }, { timeout: 60000 });
        aiImg[key].jobId = res.data?.jobId || '';
        if (!aiImg[key].jobId) throw new Error(res.data?.error || '未返回任务号');
        ElementPlus.ElMessage.success('AI 出图已开始（7 张，约 5-8 分钟），可以先去干别的');
        for (let i = 0; i < 80; i += 1) {
          await sleepMs(10000);
          const jr = await axios.get('/api/image-set/jobs/' + encodeURIComponent(aiImg[key].jobId), { timeout: 30000 });
          const job = jr.data?.job || {};
          aiImg[key].phase = job.phase || '';
          aiImg[key].processed = Number(job.processed || 0);
          aiImg[key].total = Number(job.total || 7);
          aiImg[key].images = (job.images || []).filter((x) => x.ok && x.url).map((x) => x.url);
          if (['done', 'error', 'canceled'].includes(job.status)) {
            if (job.status === 'done') {
              const ap = await axios.post(`/api/ozon/ai-image-set/${encodeURIComponent(aiImg[key].jobId)}/apply`, { itemId, mode: 'all' }, { timeout: 60000 });
              aiImg[key].phase = `✓ 已写入商品图片（共 ${ap.data?.count || 0} 张，主图置首）`;
              ElementPlus.ElMessage.success('AI 套图已写回该商品，可直接送上架');
              fetchItems().catch(() => {});
            } else {
              aiImg[key].error = job.error || job.phase || '生成失败';
              ElementPlus.ElMessage.error('AI 出图失败: ' + aiImg[key].error);
            }
            break;
          }
        }
      } catch (e) {
        aiImg[key].error = e.response?.data?.error || e.message || '失败';
        ElementPlus.ElMessage.error('AI 出图失败: ' + aiImg[key].error);
      } finally { aiImg[key].busy = false; }
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
            <el-input v-model="importText" type="textarea" :rows="3" resize="vertical" placeholder="粘贴 Ozon 链接或 SKU，每行一条" />
            <el-button size="large" type="primary" style="height:76px; background:#111827; border-color:#111827" @click="handleImport">加入采集箱</el-button>
          </div>
          <div style="margin-top:8px; color:#64748b; font-size:12px; font-weight:700">加入后只创建采集箱记录和采集任务；送上架需要在采集完成后手动确认。</div>
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

        <el-table :data="items" v-loading="loading" element-loading-text="正在读取采集箱" size="large" stripe border style="border-radius:8px; overflow:hidden; box-shadow:0 8px 24px rgba(15,23,42,.04)" empty-text="暂无采集项。请粘贴 Ozon 链接或 SKU 后加入采集箱。" @selection-change="onSelectionChange">
          <el-table-column type="selection" width="52" />
          <el-table-column label="商品信息" min-width="360">
            <template #default="{ row }">
              <div style="display: flex; gap: 10px; align-items: center">
                <el-image v-if="row.main_image" :src="row.main_image" style="width:58px; height:58px; border-radius:8px; background:#f1f5f9" fit="cover" preview-teleported :preview-src-list="row.images?.length ? row.images : [row.main_image]" />
                <div v-else style="width:58px;height:58px;border-radius:8px;background:#f1f5f9;color:#94a3b8;display:flex;align-items:center;justify-content:center;font-size:11px">无图</div>
                <div style="flex: 1; min-width: 0">
                  <div class="text-ellipsis" style="font-size:15px; line-height:1.4; font-weight:800; color:#1f2937">{{ row.title || '正在采集...' }}</div>
                  <div style="font-size:12px; color:#94a3b8; margin-top:7px">SKU: {{ row.ozon_sku || '-' }}</div>
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
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tooltip :content="statusDescriptions[row.status] || statusLabel(row.status)" placement="top">
                <el-tag size="small" :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag>
              </el-tooltip>
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
          <el-table-column label="操作" width="240" fixed="right" align="center">
            <template #default="{ row }">
              <el-button link type="primary" @click="editItem(row)">编辑</el-button>
              <el-button v-if="row.status === 'scraped'" link type="success" @click="sendToListing(row)">送上架</el-button>
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

      <!-- 补全 Ozon 死穴字段的编辑抽屉 -->
      <el-drawer v-model="drawer.visible" title="编辑采集商品" size="650px">
        <el-alert title="保存采集资料只写入本地采集箱；上架需要点击送上架并在批量上架页确认。" type="info" :closable="false" show-icon style="margin-bottom:12px" />
        <el-alert v-if="drawer.form.status === 'failed'" :title="rowFailureReason(drawer.form)" type="error" :closable="false" show-icon style="margin-bottom:12px" />
        <el-form :model="drawer.form" label-position="top">
          <el-form-item label="商品名称 (俄/英)" required><el-input v-model="drawer.form.title" /></el-form-item>
          
          <el-row :gutter="20">
            <el-col :span="12">
              <el-form-item label="售价 (RUB)" required>
                <el-input-number v-model="drawer.form.price_rub" style="width:100%" />
                <el-button type="success" link size="small" @click="drawer.showProfitCalc = true">
                   <el-icon><DataAnalysis /></el-icon> fx 利润计算器
                </el-button>
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="品牌 (Brand)"><el-input v-model="drawer.form.brand" /></el-form-item>
            </el-col>
          </el-row>

          <el-divider content-position="left">物流规格 (Ozon 备货死穴)</el-divider>
          <el-row :gutter="10">
            <el-col :span="6"><el-form-item label="重量 (g)"><el-input-number v-model="drawer.form.weight" :min="1" /></el-form-item></el-col>
            <el-col :span="6"><el-form-item label="长 (mm)"><el-input-number v-model="drawer.form.depth" :min="1" /></el-form-item></el-col>
            <el-col :span="6"><el-form-item label="宽 (mm)"><el-input-number v-model="drawer.form.width" :min="1" /></el-form-item></el-col>
            <el-col :span="6"><el-form-item label="高 (mm)"><el-input-number v-model="drawer.form.height" :min="1" /></el-form-item></el-col>
          </el-row>

          <el-form-item label="详细描述 (Description)">
             <el-input v-model="drawer.form.description" type="textarea" :rows="8" />
          </el-form-item>
          <el-form-item label="1688 货源链接">
             <el-input v-model="drawer.form.source_url_1688" placeholder="https://detail.1688.com/offer/..." />
          </el-form-item>
        </el-form>
        
        <template #footer>
          <el-button @click="drawer.visible = false">取消</el-button>
          <el-button type="primary" @click="saveDraft">保存采集资料</el-button>
        </template>
      </el-drawer>

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
