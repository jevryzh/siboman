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
    };
  },
  template: `
    <div class="collection-box-v3">
      <el-card style="margin-bottom:16px">
        <div style="display:flex; gap:10px; align-items:flex-start">
          <el-input v-model="importText" type="textarea" :rows="3" resize="vertical" placeholder="粘贴 Ozon 链接或 SKU，每行一条" />
          <el-button type="primary" @click="handleImport" style="height:32px">加入采集箱</el-button>
        </div>
        <div style="margin-top:8px; color:#909399; font-size:12px">加入后只创建采集箱记录和采集任务；送上架需要在采集完成后手动确认。</div>
      </el-card>

      <el-card>
        <template #header>
          <div style="display:flex; justify-content:space-between; gap:12px; align-items:center">
            <strong>采集箱</strong>
            <div style="display:flex; gap:8px">
              <el-input v-model="search" clearable placeholder="搜索标题 / SKU / 链接" style="width:260px" @input="onSearchInput" @keyup.enter="onSearch" />
              <el-button @click="onSearch">搜索</el-button>
              <el-button @click="exportCsv">导出 CSV</el-button>
              <el-button type="danger" plain :disabled="!selectedRows.length" @click="bulkDelete">批量删除</el-button>
            </div>
          </div>
        </template>

        <el-tabs v-model="activeTab" @tab-change="onTabChange">
          <el-tab-pane v-for="tab in statusTabs" :key="tab.value" :name="tab.value">
            <template #label>{{ tab.label }} <span style="color:#909399">({{ statusCounts[tab.value] || 0 }})</span></template>
          </el-tab-pane>
        </el-tabs>

        <el-table :data="items" v-loading="loading" stripe border empty-text="暂无采集项。请粘贴 Ozon 链接或 SKU 后加入采集箱。" @selection-change="onSelectionChange">
          <el-table-column type="selection" width="44" />
          <el-table-column label="商品信息" min-width="250">
            <template #default="{ row }">
              <div style="display: flex; gap: 10px; align-items: center">
                <el-image v-if="row.main_image" :src="row.main_image" style="width:45px; height:45px" fit="cover" preview-teleported :preview-src-list="row.images?.length ? row.images : [row.main_image]" />
                <div v-else style="width:45px;height:45px;background:#f5f7fa;color:#909399;display:flex;align-items:center;justify-content:center;font-size:11px">无图</div>
                <div style="flex: 1; min-width: 0">
                  <div class="text-ellipsis" style="font-size: 13px">{{ row.title || '正在采集...' }}</div>
                  <div style="font-size:11px; color:#999">SKU: {{ row.ozon_sku || '-' }}</div>
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
          <el-table-column label="操作" width="240" fixed="right">
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

        <div style="margin-top: 20px; display: flex; justify-content: flex-end">
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
      </el-card>

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
                   <el-icon><Calculator /></el-icon> fx 利润计算器
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
