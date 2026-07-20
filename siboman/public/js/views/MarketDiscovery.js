window.MarketDiscoveryView = {
  setup() {
    const tab = Vue.ref('bestsellers');
    const loading = Vue.ref(false);
    const rows = Vue.ref([]);
    const selected = Vue.ref([]);
    const search = Vue.ref('');
    const strategy = Vue.ref('hot');
    const total = Vue.ref(0);
    const freshness = Vue.ref({});
    const pagination = Vue.reactive({ page: 1, size: 50 });
    const isAdmin = Vue.ref(false);
    const importInput = Vue.ref(null);
    const importDialog = Vue.reactive({ visible: false, loading: false, items: [], source_name: '', source_captured_at: new Date().toISOString().slice(0, 16) });
    const storeId = () => String(
      window.getCurrentStoreId?.() || localStorage.getItem('currentStoreId') || '',
    ).split(',').map(value => value.trim()).find(Boolean) || '';
    const errorText = error => error?.response?.data?.error || error?.message || '请求失败';
    const formatTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
    const isStale = Vue.computed(() => !freshness.value.latest || Date.now() - new Date(freshness.value.latest).getTime() > 86400e3);

    async function load() {
      loading.value = true;
      try {
        const endpoint = tab.value === 'china' ? '/api/sourcing/china-zone' : '/api/sourcing/bestsellers';
        const params = { search: search.value, limit: pagination.size, offset: (pagination.page - 1) * pagination.size };
        if (tab.value === 'china') params.min_sales = 1; else params.strategy = strategy.value;
        const response = await axios.get(endpoint, { params });
        rows.value = response.data.items || [];
        total.value = Number(response.data.total || 0);
        freshness.value = response.data.freshness || {};
        selected.value = [];
      } catch (error) { ElementPlus.ElMessage.error(errorText(error)); }
      finally { loading.value = false; }
    }

    function onSelect(items) { selected.value = items || []; }
    async function addToCollection(items = selected.value) {
      if (!items.length) return ElementPlus.ElMessage.warning('请先选择商品');
      if (!storeId()) return ElementPlus.ElMessage.warning('请先选择店铺');
      try {
        const response = await axios.post('/api/collect-items', {
          store_id: storeId(),
          items: items.map(item => ({ sku: item.sku, name: item.title, image: item.main_image, images: item.main_image ? [item.main_image] : [], price_rub: item.price_rub, source_url: item.ozon_url, attributes: { market_source: item.source_name, market_captured_at: item.source_captured_at } })),
        });
        ElementPlus.ElMessage.success(`已加入采集箱 ${response.data.insertedCount || 0} 条，跳过 ${response.data.skippedCount || 0} 条`);
      } catch (error) { ElementPlus.ElMessage.error('加入采集箱失败: ' + errorText(error)); }
    }

    async function parseImport(event) {
      const file = event.target.files?.[0]; event.target.value = '';
      if (!file) return;
      if (!window.XLSX) return ElementPlus.ElMessage.error('Excel 解析组件未加载');
      try {
        const workbook = window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
        importDialog.items = window.XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
        if (!importDialog.items.length) return ElementPlus.ElMessage.warning('文件没有数据');
        importDialog.visible = true;
      } catch (error) { ElementPlus.ElMessage.error('文件解析失败: ' + error.message); }
    }
    async function confirmImport() {
      if (!importDialog.source_name || !importDialog.source_captured_at) return ElementPlus.ElMessage.warning('请填写数据来源和抓取时间');
      importDialog.loading = true;
      try {
        const response = await axios.post('/api/sourcing/bestsellers/import', { items: importDialog.items, source_name: importDialog.source_name, source_captured_at: new Date(importDialog.source_captured_at).toISOString() }, { validateStatus: status => [200, 207, 400].includes(status) });
        const message = `导入成功 ${response.data.imported || 0}，失败 ${response.data.failed || 0}`;
        if (response.data.failed) ElementPlus.ElMessage.warning(message); else ElementPlus.ElMessage.success(message);
        if (response.data.imported) { importDialog.visible = false; await load(); }
      } catch (error) { ElementPlus.ElMessage.error('导入失败: ' + errorText(error)); }
      finally { importDialog.loading = false; }
    }

    const changed = () => { pagination.page = 1; load(); };
    Vue.onMounted(async () => { try { isAdmin.value = (await axios.get('/api/auth/status')).data?.user?.role === 'admin'; } catch {} await load(); });
    Vue.watch([tab, strategy], changed);
    return { tab, loading, rows, selected, search, strategy, total, freshness, pagination, isAdmin, isStale, importInput, importDialog, formatTime, load, changed, onSelect, addToCollection, parseImport, confirmImport };
  },
  template: `
    <div>
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
        <div><h2 style="margin:0 0 4px;font-size:20px">市场榜单</h2><div style="font-size:13px;color:#909399">独立公共数据源，不使用其他 ERP 用户的店铺商品</div></div>
        <div style="display:flex;gap:8px"><el-button v-if="isAdmin" @click="importInput?.click()">导入榜单</el-button><input ref="importInput" type="file" accept=".csv,.xlsx,.xls" style="display:none" @change="parseImport"/><el-button @click="load">刷新</el-button></div>
      </div>
      <el-alert v-if="isStale" title="榜单尚无 24 小时内的可靠数据；请由管理员导入采集端或可信数据源的最新结果。" type="warning" :closable="false" show-icon style="margin-bottom:12px"/>
      <el-tabs v-model="tab" type="border-card">
        <el-tab-pane label="全平台榜单" name="bestsellers"/><el-tab-pane label="中国专区" name="china"/>
        <div style="display:flex;justify-content:space-between;align-items:center;margin:12px 0">
          <div style="display:flex;gap:8px"><el-select v-if="tab==='bestsellers'" v-model="strategy" style="width:130px"><el-option label="热销" value="hot"/><el-option label="新品" value="new"/><el-option label="潜力" value="potential"/><el-option label="蓝海" value="blue_ocean"/><el-option label="全部" value="all"/></el-select><el-input v-model="search" placeholder="SKU / 标题 / 卖家" clearable style="width:260px" @keyup.enter="changed"/><el-button type="primary" @click="changed">查询</el-button></div>
          <div style="display:flex;align-items:center;gap:10px"><span style="font-size:12px;color:#909399">最新数据 {{formatTime(freshness.latest)}}</span><el-button type="success" :disabled="!selected.length" @click="addToCollection()">加入采集箱 ({{selected.length}})</el-button></div>
        </div>
        <el-table :data="rows" v-loading="loading" border stripe @selection-change="onSelect" style="width:100%">
          <el-table-column type="selection" width="44"/><el-table-column label="排名" width="70"><template #default="{$index}">{{(pagination.page-1)*pagination.size+$index+1}}</template></el-table-column>
          <el-table-column label="商品" min-width="300"><template #default="{row}"><div style="display:flex;gap:10px;align-items:center"><el-image :src="row.main_image" style="width:54px;height:54px" fit="cover"/><div style="min-width:0"><a :href="row.ozon_url" target="_blank" style="font-weight:600">{{row.title || row.sku}}</a><div style="font-size:11px;color:#909399">SKU {{row.sku}} · {{row.category_name || '未分类'}}</div></div></div></template></el-table-column>
          <el-table-column label="价格" width="110" align="right"><template #default="{row}">₽ {{Number(row.price_rub||0).toFixed(0)}}</template></el-table-column><el-table-column prop="monthly_sales" label="月销量" width="100" align="right"/><el-table-column prop="review_count" label="评价" width="90" align="right"/><el-table-column prop="seller_name" label="卖家" min-width="150" show-overflow-tooltip/>
          <el-table-column v-if="tab==='china'" label="中国来源依据" min-width="190"><template #default="{row}"><el-tag size="small" :type="row.seller_confirmed?'success':'warning'">{{row.seller_confirmed?'人工确认':'采集证据'}}</el-tag><span style="font-size:11px;margin-left:6px">{{row.china_evidence}}</span></template></el-table-column>
          <el-table-column label="来源" width="170"><template #default="{row}"><div>{{row.source_name}}</div><div style="font-size:11px;color:#909399">{{formatTime(row.source_captured_at)}}</div></template></el-table-column><el-table-column label="操作" width="110" fixed="right"><template #default="{row}"><el-button link type="primary" @click="addToCollection([row])">加入采集箱</el-button></template></el-table-column>
        </el-table>
        <div style="display:flex;justify-content:flex-end;margin-top:14px"><el-pagination v-model:current-page="pagination.page" v-model:page-size="pagination.size" :total="total" :page-sizes="[20,50,100]" layout="total,sizes,prev,pager,next" @change="load"/></div>
      </el-tabs>
      <el-dialog v-model="importDialog.visible" title="导入公共榜单" width="560px"><el-alert title="仅导入有明确来源的公开市场数据，文件至少需要 sku、title、monthly_sales。" type="info" :closable="false" style="margin-bottom:14px"/><el-form label-width="100px"><el-form-item label="数据来源"><el-input v-model="importDialog.source_name" placeholder="例如：Ozon highlight 采集端"/></el-form-item><el-form-item label="抓取时间"><el-date-picker v-model="importDialog.source_captured_at" type="datetime" value-format="YYYY-MM-DDTHH:mm" style="width:100%"/></el-form-item><el-form-item label="记录数">{{importDialog.items.length}} 条</el-form-item></el-form><template #footer><el-button @click="importDialog.visible=false">取消</el-button><el-button type="primary" :loading="importDialog.loading" @click="confirmImport">确认导入</el-button></template></el-dialog>
    </div>`
};
