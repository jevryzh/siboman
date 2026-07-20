window.AnalyticsCenterView = {
  setup() {
    const tab = Vue.ref('profit');
    const range = Vue.ref('28');
    const loading = Vue.ref(false);
    const dashboard = Vue.ref({ summary: {}, store_comparison: [] });
    const categories = Vue.ref([]);
    const categoryFilter = Vue.ref('all');
    const bestsellers = Vue.ref([]);
    const profitRows = Vue.ref([]);
    const financeSettings = Vue.ref({ exchange_rate: 0, exchange_rate_source: '' });
    const costAudit = Vue.ref([]);
    const storeId = () => String(
      window.getCurrentStoreId?.() || localStorage.getItem('currentStoreId') || '',
    ).split(',').map(value => value.trim()).find(Boolean) || '';
    const money = value => `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const errorText = error => error?.response?.data?.error || error?.message || '请求失败';

    async function load() {
      if (!storeId()) return;
      loading.value = true;
      try {
        if (tab.value === 'profit') {
          const days = Math.min(30, Number(range.value));
          const end = new Date(); const start = new Date(end.getTime() - days * 86400e3);
          const [dashboardResponse, orderResponse, settingsResponse, auditResponse] = await Promise.all([
            axios.get('/api/seller/dashboard', { params: { range: days } }),
            axios.post('/api/seller/orders', { store_id: storeId(), status: 'all', since: start.toISOString(), to: end.toISOString(), limit: 200, offset: 0 }),
            axios.get('/api/finance/settings'),
            axios.get('/api/finance/cost-audit', { params: { store_id: storeId() } }),
          ]);
          dashboard.value = dashboardResponse.data;
          profitRows.value = (orderResponse.data.orders || []).flatMap(order => (order.products || []).map(product => ({ posting_number: order.posting_number, created_at: order.in_process_at || order.created_at, status: order.status, ...product })));
          financeSettings.value = settingsResponse.data;
          costAudit.value = auditResponse.data.items || [];
        } else if (tab.value === 'category') {
          const response = await axios.post('/api/seller/analytics/categories', { store_id: storeId(), range: range.value, dimension: 'category1', filter_type: categoryFilter.value });
          if (Array.isArray(response.data.items)) categories.value = response.data.items.map((row, index) => ({ rank: index + 1, name: row.category_path, sales: row.ordered_units, revenue: row.revenue, returns: row.returns_units, averagePrice: row.avg_price, returnRate: row.return_rate * 100, growth: row.gmv_growth * 100 }));
          else categories.value = (response.data.data?.result?.data || []).map((row, index) => {
            const metrics = row.metrics || [];
            const sales = Number(metrics[0] || 0);
            const revenue = Number(metrics[1] || 0);
            const returns = Number(metrics[2] || 0);
            return { rank: index + 1, name: row.dimensions?.[0]?.name || '未分类', sales, revenue, returns, averagePrice: sales ? revenue / sales : 0, returnRate: sales ? returns / sales * 100 : 0 };
          });
        } else {
          const response = await axios.post('/api/seller/analytics/bestsellers', { store_id: storeId(), limit: 100, offset: 0 });
          const items = response.data.data?.result?.items || response.data.data?.items || [];
          bestsellers.value = items.map((row, index) => ({ ...row, rank: index + 1 }));
        }
      } catch (error) { ElementPlus.ElMessage.error(errorText(error)); }
      finally { loading.value = false; }
    }

    function exportCategories() {
      const rows = [['排名', '类目', '销量', '销售额', '退货数', '退货率'], ...categories.value.map(row => [row.rank, row.name, row.sales, row.revenue, row.returns, `${row.returnRate.toFixed(2)}%`])];
      const csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n');
      const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `类目分析-${new Date().toISOString().slice(0, 10)}.csv`; anchor.click(); URL.revokeObjectURL(url);
    }

    async function editCost(row) {
      try {
        const result = await ElementPlus.ElMessageBox.prompt(`为货号 ${row.offer_id} 录入单件采购成本（人民币）`, '维护采购成本', {
          confirmButtonText: '保存', cancelButtonText: '取消', inputValue: String(row.purchase_price_cny || ''),
          inputPattern: /^\d+(?:\.\d{1,2})?$/, inputErrorMessage: '请输入大于等于 0、最多两位小数的金额',
        });
        await axios.post('/api/finance/product-cost', { store_id: storeId(), offer_id: row.offer_id, purchase_price_cny: Number(result.value), reason: '经营分析补录' });
        ElementPlus.ElMessage.success('采购成本已保存并记录审计');
        await load();
      } catch (error) { if (error !== 'cancel' && error !== 'close') ElementPlus.ElMessage.error(errorText(error)); }
    }

    async function editExchangeRate() {
      try {
        const result = await ElementPlus.ElMessageBox.prompt('输入 1 RUB 对应的人民币金额', '维护 RUB/CNY 汇率', {
          confirmButtonText: '保存', cancelButtonText: '取消', inputValue: String(financeSettings.value.exchange_rate || ''),
          inputPattern: /^0\.\d{3,6}$/, inputErrorMessage: '请输入 0.001 至 0.999999 之间的汇率',
        });
        await axios.post('/api/finance/exchange-rate', { rate: Number(result.value) });
        ElementPlus.ElMessage.success('汇率已更新，后续查询将使用新汇率');
        await load();
      } catch (error) { if (error !== 'cancel' && error !== 'close') ElementPlus.ElMessage.error(errorText(error)); }
    }

    function exportProfit() {
      const rows = [['订单号','货号','商品','数量','销售额(CNY)','平台佣金(CNY)','Ozon到手(CNY)','采购单价(CNY)','采购成本(CNY)','净利润(CNY)','核算状态','汇率'], ...profitRows.value.map(row => [row.posting_number,row.offer_id,row.name,row.quantity,row.subtotal_cny,row.commission_cny,row.payout_cny,row.purchase_price_cny,row.purchase_cost_cny,row.profit_cny,row.profit_is_estimated?'待补采购成本':'已核算',financeSettings.value.exchange_rate])];
      const csv = rows.map(row => row.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\n');
      const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `利润明细-${new Date().toISOString().slice(0, 10)}.csv`; anchor.click(); URL.revokeObjectURL(url);
    }

    const changed = () => load();
    Vue.onMounted(() => { window.addEventListener('shop-changed', changed); load(); });
    Vue.onBeforeUnmount(() => window.removeEventListener('shop-changed', changed));
    Vue.watch([tab, range, categoryFilter], load);
    return { tab, range, categoryFilter, loading, dashboard, categories, bestsellers, profitRows, financeSettings, costAudit, money, load, exportCategories, editCost, editExchangeRate, exportProfit };
  },
  template: `
    <div v-loading="loading">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div><h2 style="margin:0 0 4px;font-size:20px">经营分析</h2><div style="font-size:13px;color:#909399">利润、类目与店内热销数据</div></div>
        <div style="display:flex;gap:8px"><el-select v-model="range" style="width:120px"><el-option label="近 7 天" value="7"/><el-option label="近 28 天" value="28"/><el-option label="近 30 天" value="30"/></el-select><el-button @click="load">刷新</el-button></div>
      </div>
      <el-tabs v-model="tab" type="border-card">
        <el-tab-pane label="利润概览" name="profit">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;gap:12px">
            <el-alert title="只有维护了采购成本的商品才计入已核算利润；缺失成本的订单明确标记为待补，不再显示猜测利润。" type="warning" :closable="false" show-icon/>
            <div style="display:flex;gap:8px;flex:none"><el-button @click="editExchangeRate">汇率 {{Number(financeSettings.exchange_rate||0).toFixed(4)}}</el-button><el-button @click="exportProfit">导出利润明细</el-button></div>
          </div>
          <el-row :gutter="12"><el-col :span="6"><el-statistic title="周期 GMV" :value="dashboard.summary?.weekly_gmv || 0" :precision="2" prefix="¥"/></el-col><el-col :span="6"><el-statistic title="周期到手" :value="dashboard.summary?.weekly_payout || 0" :precision="2" prefix="¥"/></el-col><el-col :span="6"><el-statistic title="周期利润" :value="dashboard.summary?.weekly_profit || 0" :precision="2" prefix="¥"/></el-col><el-col :span="6"><el-statistic title="周期订单" :value="dashboard.summary?.weekly_orders || 0"/></el-col></el-row>
          <el-table :data="dashboard.store_comparison || []" border style="margin-top:20px;width:100%"><el-table-column prop="store_name" label="店铺" min-width="150"/><el-table-column prop="weekly_orders" label="订单" width="90"/><el-table-column label="GMV" width="130"><template #default="{row}">{{money(row.weekly_gmv)}}</template></el-table-column><el-table-column label="到手" width="130"><template #default="{row}">{{money(row.weekly_payout)}}</template></el-table-column><el-table-column label="采购成本" width="130"><template #default="{row}">{{money(row.weekly_purchase_cost)}}</template></el-table-column><el-table-column label="利润" width="130"><template #default="{row}"><b :style="{color:row.weekly_profit >= 0 ? '#67c23a' : '#f56c6c'}">{{money(row.weekly_profit)}}</b></template></el-table-column><el-table-column prop="profit_method" label="计算依据" min-width="300" show-overflow-tooltip/></el-table>
          <h3 style="font-size:15px;margin:22px 0 10px">订单商品利润明细</h3>
          <el-table :data="profitRows" border stripe max-height="430" style="width:100%"><el-table-column prop="posting_number" label="订单号" width="180"/><el-table-column prop="name" label="商品" min-width="220" show-overflow-tooltip/><el-table-column prop="offer_id" label="货号" width="150"/><el-table-column prop="quantity" label="数量" width="70"/><el-table-column label="销售额" width="110"><template #default="{row}">{{money(row.subtotal_cny)}}</template></el-table-column><el-table-column label="平台佣金" width="110"><template #default="{row}">{{money(row.commission_cny)}}</template></el-table-column><el-table-column label="Ozon 到手" width="110"><template #default="{row}">{{money(row.payout_cny)}}</template></el-table-column><el-table-column label="采购成本" width="120"><template #default="{row}"><span v-if="!row.profit_is_estimated">{{money(row.purchase_cost_cny)}}</span><el-button v-else link type="warning" @click="editCost(row)">录入成本</el-button></template></el-table-column><el-table-column label="利润" width="110"><template #default="{row}"><b v-if="!row.profit_is_estimated" :style="{color:row.profit_cny>=0?'#67c23a':'#f56c6c'}">{{money(row.profit_cny)}}</b><span v-else>-</span></template></el-table-column><el-table-column label="操作" width="90"><template #default="{row}"><el-button link type="primary" @click="editCost(row)">改成本</el-button></template></el-table-column></el-table>
          <el-collapse style="margin-top:16px"><el-collapse-item title="成本变更记录" name="audit"><el-table :data="costAudit" size="small" border max-height="260"><el-table-column prop="offer_id" label="货号" min-width="150"/><el-table-column label="原成本" width="110"><template #default="{row}">{{row.old_value==null?'-':money(row.old_value)}}</template></el-table-column><el-table-column label="新成本" width="110"><template #default="{row}">{{money(row.new_value)}}</template></el-table-column><el-table-column prop="reason" label="原因" min-width="180"/><el-table-column prop="changed_by_name" label="操作人" width="110"/><el-table-column prop="created_at" label="时间" width="180"/></el-table></el-collapse-item></el-collapse>
        </el-tab-pane>
        <el-tab-pane label="类目分析" name="category"><div style="display:flex;justify-content:space-between;margin-bottom:12px"><el-radio-group v-model="categoryFilter" size="small"><el-radio-button value="all">全部</el-radio-button><el-radio-button value="growth">增长机会</el-radio-button><el-radio-button value="high_return">高退货率</el-radio-button></el-radio-group><el-button @click="exportCategories">导出 CSV</el-button></div><el-table :data="categories" border stripe style="width:100%"><el-table-column prop="rank" label="排名" width="70"/><el-table-column prop="name" label="类目" min-width="240"/><el-table-column prop="sales" label="销量" width="100"/><el-table-column label="销售额" width="140"><template #default="{row}">{{money(row.revenue)}}</template></el-table-column><el-table-column label="增长" width="100"><template #default="{row}"><span :style="{color:row.growth>=0?'#67c23a':'#f56c6c'}">{{Number(row.growth||0).toFixed(1)}}%</span></template></el-table-column><el-table-column label="均价" width="120"><template #default="{row}">{{money(row.averagePrice)}}</template></el-table-column><el-table-column prop="returns" label="退货" width="90"/><el-table-column label="退货率" width="100"><template #default="{row}">{{row.returnRate.toFixed(1)}}%</template></el-table-column></el-table></el-tab-pane>
        <el-tab-pane label="店内热销" name="bestseller"><el-alert title="展示当前店铺的 Ozon 销量预测数据，不是全站榜单。" type="info" :closable="false" style="margin-bottom:12px"/><el-table :data="bestsellers" border stripe style="width:100%"><el-table-column prop="rank" label="排名" width="70"/><el-table-column prop="name" label="商品" min-width="260" show-overflow-tooltip/><el-table-column prop="offer_id" label="货号" min-width="160"/><el-table-column prop="sku" label="SKU" width="150"/><el-table-column prop="sales" label="销量" width="100"/><el-table-column prop="stock" label="库存" width="100"/></el-table></el-tab-pane>
      </el-tabs>
    </div>`
};
