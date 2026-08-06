window.MarketDiscoveryView = {
  setup() {
    const activeTab = Vue.ref('overview');
    const loading = Vue.ref(false);
    const marketLoading = Vue.ref(false);
    const queueLoading = Vue.ref(false);
    const selectedMarketRows = Vue.ref([]);
    const selectedQueueRows = Vue.ref([]);
    const marketRows = Vue.ref([]);
    const queueRows = Vue.ref([]);
    const dashboard = Vue.ref(null);
    const marketSource = Vue.ref({ policy: '', note: '', freshness: {} });
    const discoveryState = Vue.ref(null);
    const settings = Vue.reactive({ enabled: false, daily_quota: 30, min_profit_rate: 0.2, max_ai_cost_cny: 50, submit_to_ozon: false });
    const filters = Vue.reactive({ strategy: 'hot', search: '', stage: 'all' });
    const marketPage = Vue.reactive({ page: 1, size: 30, total: 0 });
    const queuePage = Vue.reactive({ page: 1, size: 30, total: 0 });

    const storeId = () => String(window.getCurrentStoreId?.() || localStorage.getItem('currentStoreId') || '')
      .split(',').map(value => value.trim()).find(Boolean) || '';
    const errorText = error => error?.response?.data?.error || error?.message || '请求失败';
    const moneyRub = value => Number(value || 0) > 0 ? `₽${Number(value).toFixed(0)}` : '-';
    const formatTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
    const stageLabels = {
      discovered: '已发现',
      collected: '已采集',
      sourcing: '1688 找货',
      materials: '资料完成',
      images: '图片完成',
      pricing: '核价完成',
      ready: '待上架',
      submitted: '已提交 Ozon',
      ozon_fix: 'Ozon 待更正',
      listed: '已上架',
    };
    const statusLabels = { queued: '排队中', running: '处理中', paused: '已暂停', needs_human: '待人工', failed: '失败', done: '完成' };
    const riskTypes = { low: 'success', normal: 'warning', high: 'danger' };

    async function loadDashboard() {
      if (!storeId()) return;
      const response = await axios.get('/api/auto-listing/dashboard', { params: { store_id: storeId() } });
      dashboard.value = response.data;
      Object.assign(settings, response.data.settings || {});
    }

    async function loadMarket() {
      marketLoading.value = true;
      try {
        const response = await axios.get('/api/sourcing/bestsellers', {
          params: {
            strategy: filters.strategy,
            search: filters.search,
            limit: marketPage.size,
            offset: (marketPage.page - 1) * marketPage.size,
          },
        });
        marketRows.value = response.data.items || [];
        marketPage.total = Number(response.data.total || 0);
        marketSource.value = {
          policy: response.data.source_policy || '',
          note: response.data.note || '',
          freshness: response.data.freshness || {},
        };
        selectedMarketRows.value = [];
        if ((response.data.items || []).some(row => row.row_type !== 'category')) discoveryState.value = null;
      } catch (error) { ElementPlus.ElMessage.error(errorText(error)); }
      finally { marketLoading.value = false; }
    }

    async function loadQueue() {
      if (!storeId()) return;
      queueLoading.value = true;
      try {
        const response = await axios.get('/api/auto-listing/items', {
          params: {
            store_id: storeId(),
            stage: filters.stage,
            search: filters.search,
            limit: queuePage.size,
            offset: (queuePage.page - 1) * queuePage.size,
          },
        });
        queueRows.value = response.data.items || [];
        queuePage.total = Number(response.data.total || 0);
        selectedQueueRows.value = [];
      } catch (error) { ElementPlus.ElMessage.error(errorText(error)); }
      finally { queueLoading.value = false; }
    }

    async function refreshAll() {
      if (!storeId()) return ElementPlus.ElMessage.warning('请先选择店铺');
      loading.value = true;
      try {
        await Promise.all([loadDashboard(), loadMarket(), loadQueue()]);
      } finally { loading.value = false; }
    }

    async function discoverSelected(limit = 20) {
      if (!storeId()) return ElementPlus.ElMessage.warning('请先选择店铺');
      const sourceRows = selectedMarketRows.value.filter(row => row.row_type !== 'category');
      if (!sourceRows.length) return ElementPlus.ElMessage.warning('当前是类目级平台数据，不能直接加入自动上架队列；需要先接商品级榜单。');
      const sourceIds = sourceRows.map(row => row.id);
      try {
        const response = await axios.post('/api/auto-listing/discover', {
          store_id: storeId(),
          source_ids: sourceIds,
          strategy: filters.strategy,
          limit: sourceIds.length ? sourceIds.length : limit,
        });
        ElementPlus.ElMessage.success(`已加入自动队列 ${response.data.insertedCount || 0} 个商品`);
        activeTab.value = 'pipeline';
        await Promise.all([loadDashboard(), loadQueue()]);
      } catch (error) { ElementPlus.ElMessage.error(errorText(error)); }
    }

    async function discoverProductsFromCategories() {
      const categoryRows = selectedMarketRows.value.filter(row => row.row_type === 'category');
      const fallbackRows = marketRows.value.filter(row => row.row_type === 'category').slice(0, 3);
      const categories = categoryRows.length ? categoryRows : fallbackRows;
      if (!categories.length) {
        await loadMarket();
        return ElementPlus.ElMessage.info('当前已经是商品级榜单，可以直接勾选商品加入自动队列。');
      }
      marketLoading.value = true;
      try {
        const response = await axios.post('/api/sourcing/discover-products', {
          category_ids: categories.map(row => row.id),
          search: filters.search,
          category_limit: categories.length,
          per_category: 6,
          limit: Math.max(12, categories.length * 6),
        });
        discoveryState.value = response.data || null;
        const imported = Number(response.data.imported || 0);
        if (imported > 0) {
          ElementPlus.ElMessage.success(`已发现 ${imported} 个商品候选，下面可以勾选加入自动队列`);
        } else {
          ElementPlus.ElMessage.warning(response.data.note || '暂时没有发现商品候选');
        }
        marketPage.page = 1;
        await loadMarket();
      } catch (error) { ElementPlus.ElMessage.error(errorText(error)); }
      finally { marketLoading.value = false; }
    }

    async function advanceRow(row) {
      try {
        await axios.post(`/api/auto-listing/items/${row.id}/advance`, { store_id: storeId() });
        ElementPlus.ElMessage.success('已推进到下一步');
        await Promise.all([loadDashboard(), loadQueue()]);
      } catch (error) { ElementPlus.ElMessage.error(errorText(error)); }
    }

    async function bulkAction(action) {
      if (!selectedQueueRows.value.length) return ElementPlus.ElMessage.warning('请先选择商品');
      try {
        await axios.post('/api/auto-listing/items/bulk-action', {
          store_id: storeId(),
          ids: selectedQueueRows.value.map(row => row.id),
          action,
        });
        ElementPlus.ElMessage.success('已更新队列');
        await Promise.all([loadDashboard(), loadQueue()]);
      } catch (error) { ElementPlus.ElMessage.error(errorText(error)); }
    }

    async function saveSettings() {
      if (!storeId()) return ElementPlus.ElMessage.warning('请先选择店铺');
      try {
        const response = await axios.put('/api/auto-listing/settings', { ...settings, store_id: storeId() });
        Object.assign(settings, response.data.settings || {});
        ElementPlus.ElMessage.success('规则已保存');
        await loadDashboard();
      } catch (error) { ElementPlus.ElMessage.error(errorText(error)); }
    }

    function resetMarket() { marketPage.page = 1; loadMarket(); }
    function resetQueue() { queuePage.page = 1; loadQueue(); }
    function marketRowSelectable() { return true; }
    const selectedProductCount = Vue.computed(() => selectedMarketRows.value.filter(row => row.row_type !== 'category').length);
    const selectedCategoryCount = Vue.computed(() => selectedMarketRows.value.filter(row => row.row_type === 'category').length);
    const hasCategoryMarket = Vue.computed(() => marketRows.value.some(row => row.row_type === 'category'));
    const discoverCategoryLabel = Vue.computed(() => selectedCategoryCount.value ? `从 ${selectedCategoryCount.value} 个类目发现商品` : '从当前类目发现商品');
    const primaryDiscoverLabel = Vue.computed(() => hasCategoryMarket.value ? '从类目发现商品' : '发现商品');
    const discoveryErrorText = Vue.computed(() => {
      const state = discoveryState.value || {};
      const errors = Array.isArray(state.errors) ? state.errors.slice(0, 3) : [];
      const categoryNames = Array.isArray(state.categories)
        ? state.categories.map(item => item.label).filter(Boolean).slice(0, 3)
        : [];
      const parts = [];
      if (categoryNames.length) parts.push(`已尝试类目：${categoryNames.join('、')}`);
      if (errors.length) parts.push(`失败明细：${errors.map(item => [item.category, item.query, item.error].filter(Boolean).join(' / ')).join('；')}`);
      if (!parts.length && state.code === 'PRODUCT_LEVEL_SOURCE_UNAVAILABLE') {
        parts.push('当前只有类目级机会数据，还没有商品级 SKU 榜单。');
      }
      return parts.join('。');
    });
    const percentText = value => value == null || value === '' ? '-' : `${Number(value).toFixed(2)}%`;
    const moneyRubLarge = value => {
      const n = Number(value || 0);
      if (!n) return '-';
      if (Math.abs(n) >= 100000000) return `₽${(n / 100000000).toFixed(2)}亿`;
      if (Math.abs(n) >= 10000) return `₽${(n / 10000).toFixed(2)}万`;
      return `₽${n.toFixed(0)}`;
    };

    Vue.onMounted(refreshAll);
    Vue.watch(() => window.currentStoreId, refreshAll);

    return {
      activeTab, loading, marketLoading, queueLoading, selectedMarketRows, selectedQueueRows,
      marketRows, queueRows, dashboard, settings, filters, marketPage, queuePage, marketSource,
      discoveryState, moneyRub, moneyRubLarge, formatTime, percentText, stageLabels, statusLabels, riskTypes, selectedProductCount, selectedCategoryCount, hasCategoryMarket, discoverCategoryLabel, primaryDiscoverLabel, discoveryErrorText,
      refreshAll, loadMarket, loadQueue, discoverSelected, discoverProductsFromCategories, advanceRow, bulkAction, saveSettings,
      resetMarket, resetQueue, marketRowSelectable,
    };
  },
  template: `
    <div class="market-discovery-auto" v-loading="loading" style="max-width:1600px;margin:0 auto">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:18px">
        <div>
          <h1 style="margin:0;font-size:30px;line-height:1.2;color:#0f172a">选品中心</h1>
          <div style="margin-top:8px;color:#64748b;font-size:14px">Ozon 平台机会发现、1688 找货、资料补全、图片补全和待上架队列</div>
        </div>
        <div style="display:flex;gap:10px">
          <el-button @click="discoverProductsFromCategories" :loading="marketLoading">{{primaryDiscoverLabel}}</el-button>
          <el-button type="primary" @click="bulkAction('ready')" :disabled="!selectedQueueRows.length">推进一次</el-button>
          <el-button :type="settings.enabled ? 'warning' : 'success'" @click="settings.enabled=!settings.enabled;saveSettings()">{{settings.enabled ? '暂停自动运营' : '启动自动运营'}}</el-button>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:minmax(420px,1fr) 1fr;gap:14px;margin-bottom:16px">
        <div style="background:#fff;border:1px solid #dfe7f1;border-radius:8px;padding:22px 24px">
          <div style="display:flex;align-items:center;gap:8px;color:#16a34a;font-weight:700;font-size:13px"><span style="width:8px;height:8px;border-radius:50%;background:#22c55e"></span>{{settings.enabled ? '自动运营中' : '自动运营已暂停'}}</div>
          <div style="margin-top:14px;font-size:20px;font-weight:800;color:#0f172a">今天的自动上架进度</div>
          <div style="display:flex;align-items:center;gap:14px;margin-top:12px">
            <div style="font-size:30px;font-weight:900;color:#0f172a">{{dashboard?.today?.created || 0}} <span style="font-size:16px;font-weight:500;color:#64748b">/ {{dashboard?.today?.quota || settings.daily_quota}} SKU</span></div>
            <el-progress :percentage="dashboard?.today?.percent || 0" style="flex:1" />
          </div>
          <div style="margin-top:10px;color:#64748b;font-size:13px">系统按流水线推进，有问题的商品会进入待人工处理，不会静默丢失。</div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px">
          <div v-for="card in [
            ['在管商品', dashboard?.cards?.managed || 0, '个 SKU'],
            ['自动处理中', dashboard?.cards?.processing || 0, '个'],
            ['Ozon 审核可售', dashboard?.cards?.ozon_ready || 0, 'SKU'],
            ['需要人工处理', dashboard?.cards?.needs_human || 0, '个'],
          ]" :key="card[0]" style="background:#fff;border:1px solid #dfe7f1;border-radius:8px;padding:16px">
            <div style="color:#64748b;font-weight:700">{{card[0]}}</div>
            <div style="margin-top:12px;font-size:28px;font-weight:900;color:#0f172a">{{card[1]}} <span style="font-size:13px;color:#64748b">{{card[2]}}</span></div>
          </div>
        </div>
      </div>

      <div style="background:#fff;border:1px solid #dfe7f1;border-radius:8px;padding:18px 20px;margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <div style="font-size:16px;font-weight:800;color:#0f172a">商品流水线</div>
          <el-button link type="primary" @click="activeTab='pipeline'">进入流水线</el-button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(10,minmax(80px,1fr));gap:8px">
          <div v-for="(stage,index) in dashboard?.stages || []" :key="stage.key" style="border:1px solid #e2e8f0;border-radius:8px;padding:12px 8px;text-align:center;background:#f8fafc">
            <div :style="{margin:'0 auto 8px',width:'28px',height:'28px',borderRadius:'50%',lineHeight:'28px',fontWeight:'800',color:'#fff',background:stage.count ? '#16a34a' : '#94a3b8'}">{{String(index+1).padStart(2,'0')}}</div>
            <div style="font-weight:700;color:#334155;font-size:13px;white-space:nowrap">{{stage.label}}</div>
            <div style="margin-top:6px;font-size:18px;font-weight:900;color:#0f172a">{{stage.count}}</div>
          </div>
        </div>
      </div>

      <el-tabs v-model="activeTab">
        <el-tab-pane label="市场调研" name="overview">
          <div style="display:flex;justify-content:space-between;align-items:center;margin:10px 0 12px">
            <div style="display:flex;gap:8px">
              <el-select v-model="filters.strategy" style="width:132px" @change="resetMarket"><el-option label="热销" value="hot"/><el-option label="新品" value="new"/><el-option label="潜力" value="potential"/><el-option label="蓝海" value="blue_ocean"/><el-option label="全部" value="all"/></el-select>
              <el-input v-model="filters.search" placeholder="搜索 SKU / 商品 / 卖家 / 中文类目" clearable style="width:320px" @keyup.enter="resetMarket"/>
              <el-button @click="resetMarket">查询</el-button>
            </div>
            <div style="display:flex;align-items:center;gap:12px">
              <span style="font-size:12px;color:#94a3b8">最新数据 {{formatTime(marketSource.freshness?.latest)}}</span>
              <el-button v-if="hasCategoryMarket" :loading="marketLoading" @click="discoverProductsFromCategories">{{discoverCategoryLabel}}</el-button>
              <el-button type="success" :disabled="!selectedProductCount" @click="discoverSelected()">加入自动队列 ({{selectedProductCount}})</el-button>
            </div>
          </div>
          <el-alert v-if="marketSource.note" :title="marketSource.note" type="warning" :closable="false" style="margin-bottom:12px"/>
          <el-alert
            v-if="discoveryState && !discoveryState.success"
            title="暂时没有商品级榜单数据"
            type="error"
            :description="(discoveryState.note || '') + (discoveryErrorText ? ' ' + discoveryErrorText : '')"
            :closable="false"
            show-icon
            style="margin-bottom:12px"
          />
          <el-alert
            v-else-if="discoveryState && discoveryState.success"
            :title="'已发现 ' + (discoveryState.imported || 0) + ' 个商品候选'"
            type="success"
            :closable="false"
            show-icon
            style="margin-bottom:12px"
          />
          <el-table :data="marketRows" v-loading="marketLoading" border @selection-change="selectedMarketRows=$event" style="width:100%">
            <el-table-column type="selection" width="44" :selectable="marketRowSelectable"/><el-table-column label="机会" width="120"><template #default="{row}"><el-tag :type="row.row_type==='category'?'warning':'success'">{{row.row_type==='category' ? '类目机会' : (row.strategy_type || 'hot')}}</el-tag><div style="font-size:12px;color:#64748b;margin-top:6px">{{row.category_name_zh || row.category_name || '未分类'}}</div></template></el-table-column>
            <el-table-column label="商品 / 类目" min-width="360"><template #default="{row}"><div style="display:flex;gap:12px;align-items:center"><el-image v-if="row.main_image" :src="row.main_image" style="width:58px;height:58px;border-radius:6px;background:#f1f5f9" fit="cover"/><div v-else style="width:58px;height:58px;border-radius:6px;background:#f1f5f9;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-weight:800">类目</div><div style="min-width:0"><a v-if="row.ozon_url" :href="row.ozon_url" target="_blank" style="font-weight:800;color:#1e40af;text-decoration:none">{{row.title || row.sku}}</a><div v-else style="font-weight:800;color:#0f172a">{{row.title || row.sku}}</div><div style="font-size:12px;color:#94a3b8;margin-top:5px">{{row.row_type==='category' ? ('类目 ID ' + row.category_id) : ('SKU ' + row.sku + ' · ' + (row.seller_name || '未知卖家'))}}</div></div></div></template></el-table-column>
            <el-table-column label="售价" width="100" align="right"><template #default="{row}">{{moneyRub(row.price_rub)}}</template></el-table-column>
            <el-table-column prop="monthly_sales" label="销量" width="100" align="right"/><el-table-column label="销售额" width="130" align="right"><template #default="{row}">{{moneyRubLarge(row.sales_amount_rub)}}</template></el-table-column><el-table-column prop="seller_count" label="卖家数" width="100" align="right"/><el-table-column label="GMV增长" width="105" align="right"><template #default="{row}">{{percentText(row.gmv_growth)}}</template></el-table-column><el-table-column label="退货率" width="95" align="right"><template #default="{row}">{{percentText(row.return_rate)}}</template></el-table-column>
            <el-table-column label="数据源" width="190"><template #default="{row}"><div>{{row.source_name || '-'}}</div><div style="font-size:12px;color:#94a3b8">{{formatTime(row.source_captured_at)}}</div></template></el-table-column>
          </el-table>
          <div style="display:flex;justify-content:flex-end;margin-top:14px"><el-pagination v-model:current-page="marketPage.page" v-model:page-size="marketPage.size" :total="marketPage.total" :page-sizes="[20,30,50,100]" layout="total,sizes,prev,pager,next" @change="loadMarket"/></div>
        </el-tab-pane>

        <el-tab-pane label="自动队列" name="pipeline">
          <div style="display:flex;justify-content:space-between;align-items:center;margin:10px 0 12px">
            <div style="display:flex;gap:8px"><el-select v-model="filters.stage" style="width:160px" @change="resetQueue"><el-option label="全部阶段" value="all"/><el-option v-for="(label,key) in stageLabels" :key="key" :label="label" :value="key"/></el-select><el-input v-model="filters.search" placeholder="搜索 SKU / 商品 / 中文类目" clearable style="width:320px" @keyup.enter="resetQueue"/><el-button @click="resetQueue">查询</el-button></div>
            <div style="display:flex;gap:8px"><el-button @click="bulkAction('pause')" :disabled="!selectedQueueRows.length">暂停</el-button><el-button @click="bulkAction('resume')" :disabled="!selectedQueueRows.length">恢复</el-button><el-button type="primary" @click="bulkAction('ready')" :disabled="!selectedQueueRows.length">转待上架</el-button></div>
          </div>
          <el-table :data="queueRows" v-loading="queueLoading" border @selection-change="selectedQueueRows=$event" style="width:100%">
            <el-table-column type="selection" width="44"/><el-table-column label="商品" min-width="360"><template #default="{row}"><div style="display:flex;gap:12px;align-items:center"><el-image :src="row.main_image" style="width:58px;height:58px;border-radius:6px;background:#f1f5f9" fit="cover"/><div style="min-width:0"><div style="font-weight:800;color:#0f172a">{{row.title || row.source_sku}}</div><div style="font-size:12px;color:#94a3b8;margin-top:5px">SKU {{row.source_sku}} · {{row.category_name_zh || '未分类'}}</div></div></div></template></el-table-column>
            <el-table-column label="阶段" width="130"><template #default="{row}"><el-tag>{{stageLabels[row.stage] || row.stage}}</el-tag></template></el-table-column>
            <el-table-column label="状态" width="105"><template #default="{row}"><el-tag :type="row.status==='needs_human'?'warning':row.status==='failed'?'danger':'info'">{{statusLabels[row.status] || row.status}}</el-tag></template></el-table-column>
            <el-table-column label="机会分" width="90" align="right"><template #default="{row}">{{Number(row.opportunity_score || 0).toFixed(1)}}</template></el-table-column>
            <el-table-column label="风险" width="90"><template #default="{row}"><el-tag :type="riskTypes[row.risk_level] || 'info'">{{row.risk_level || 'normal'}}</el-tag></template></el-table-column>
            <el-table-column label="人工原因" min-width="190" show-overflow-tooltip><template #default="{row}">{{row.human_reason || '-'}}</template></el-table-column>
            <el-table-column label="更新" width="150"><template #default="{row}">{{formatTime(row.updated_at)}}</template></el-table-column>
            <el-table-column label="操作" width="120" fixed="right"><template #default="{row}"><el-button link type="primary" @click="advanceRow(row)">推进</el-button></template></el-table-column>
          </el-table>
          <div style="display:flex;justify-content:flex-end;margin-top:14px"><el-pagination v-model:current-page="queuePage.page" v-model:page-size="queuePage.size" :total="queuePage.total" :page-sizes="[20,30,50]" layout="total,sizes,prev,pager,next" @change="loadQueue"/></div>
        </el-tab-pane>

        <el-tab-pane label="规则中心" name="rules">
          <div style="background:#fff;border:1px solid #dfe7f1;border-radius:8px;padding:22px;max-width:760px">
            <el-form label-width="160px">
              <el-form-item label="自动运营"><el-switch v-model="settings.enabled"/></el-form-item>
              <el-form-item label="每日上架配额"><el-input-number v-model="settings.daily_quota" :min="1" :max="500"/></el-form-item>
              <el-form-item label="最低利润率"><el-input-number v-model="settings.min_profit_rate" :min="0" :max="5" :step="0.05"/><span style="margin-left:8px;color:#64748b">例如 0.2 = 20%</span></el-form-item>
              <el-form-item label="AI 日成本上限"><el-input-number v-model="settings.max_ai_cost_cny" :min="0" :max="9999"/></el-form-item>
              <el-form-item label="允许真实提交 Ozon"><el-switch v-model="settings.submit_to_ozon"/><span style="margin-left:8px;color:#ef4444">测试环境默认建议关闭</span></el-form-item>
              <el-form-item><el-button type="primary" @click="saveSettings">保存规则</el-button></el-form-item>
            </el-form>
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>
  `
};
