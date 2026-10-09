// 销售漏斗分析
// Ozon 卖家后台的「销售漏斗」是 Premium 专属（点标签页会弹
// premium_lite_premium_analytics 订阅引导，列一直卡在加载骨架）。
// 同样口径的数据可以通过 Seller API /v1/analytics/data 免费取到，
// 本页就是把它渲染出来：展示 → 详情浏览 → 加购 → 下单，以及按 SKU 明细。
window.AnalyticsFunnelView = {
  setup() {
    const loading = Vue.ref(false);
    const errText = Vue.ref('');
    const data = Vue.ref(null);
    const preset = Vue.ref(7);
    const customFrom = Vue.ref('');
    const customTo = Vue.ref('');
    const sortKey = Vue.ref('impressions');
    const sortDir = Vue.ref('desc');
    const currentStoreName = Vue.ref('');
    const dataAgeText = Vue.ref('');

    const notify = {
      success: (m) => (window.ElementPlus?.ElMessage || console).success?.(m),
      warning: (m) => (window.ElementPlus?.ElMessage || console).warning?.(m),
      error: (m) => (window.ElementPlus?.ElMessage || console).error?.(m),
    };

    const fmtInt = (v) => Number(v || 0).toLocaleString('zh-CN');
    const fmtMoney = (v) => '₽ ' + Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
    const fmtPct = (v) => (Number(v || 0)).toFixed(2) + '%';
    const fmtNum2 = (v) => Number(v || 0).toFixed(2);

    const todayStr = () => {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    };
    const shiftStr = (days) => {
      const d = new Date(Date.now() - days * 86400e3);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    };

    const fetchData = async () => {
      const storeId = window.getCurrentStoreId ? window.getCurrentStoreId() : '';
      if (!storeId) { errText.value = '请先在右上角选择一个 Ozon 店铺'; data.value = null; return; }
      loading.value = true;
      errText.value = '';
      try {
        const params = { store_id: storeId, limit: 500 };
        if (preset.value === 'custom') {
          if (!customFrom.value || !customTo.value) { errText.value = '请选择完整的开始/结束日期'; loading.value = false; return; }
          params.date_from = customFrom.value;
          params.date_to = customTo.value;
        } else {
          params.date_from = shiftStr(Number(preset.value) - 1);
          params.date_to = todayStr();
        }
        const res = await axios.get('/api/ozon/analytics/funnel', { params, timeout: 120000 });
        if (res.data?.success) {
          data.value = res.data;
          currentStoreName.value = res.data.store_name || '';
          dataAgeText.value = res.data.cached ? `缓存 ${res.data.ageSeconds || 0}s 前` : '实时数据';
        } else {
          errText.value = res.data?.error || '读取失败';
          data.value = null;
        }
      } catch (e) {
        errText.value = e.response?.data?.error || e.message || '读取销售漏斗失败';
        data.value = null;
      } finally {
        loading.value = false;
      }
    };

    const setPreset = (n) => { preset.value = n; fetchData(); };
    const applyCustom = () => { preset.value = 'custom'; fetchData(); };

    const totals = Vue.computed(() => data.value?.totals || null);
    const conversion = Vue.computed(() => data.value?.conversion || null);

    // 漏斗各环节（相对第一阶段的宽度）
    const stages = Vue.computed(() => {
      const t = totals.value;
      if (!t) return [];
      const base = Math.max(1, Number(t.impressions || 0));
      const mk = (label, value, extra) => ({
        label,
        value,
        width: Math.max(2, Math.min(100, (Number(value || 0) / base) * 100)),
        extra: extra || '',
      });
      return [
        mk('展示（搜索和目录）', t.impressions),
        mk('进入商品详情页', t.pdp_views, `转化 ${fmtPct(conversion.value?.view_rate)}`),
        mk('加入购物车', t.tocart, `转化 ${fmtPct(conversion.value?.cart_rate)}`),
        mk('下单', t.orders, `转化 ${fmtPct(conversion.value?.order_rate)}`),
      ];
    });

    const sortedItems = Vue.computed(() => {
      const list = [...(data.value?.items || [])];
      const k = sortKey.value;
      const dir = sortDir.value === 'asc' ? 1 : -1;
      list.sort((a, b) => {
        const av = a[k], bv = b[k];
        if (typeof av === 'string' || typeof bv === 'string') return String(av || '').localeCompare(String(bv || '')) * dir;
        return (Number(av || 0) - Number(bv || 0)) * dir;
      });
      return list;
    });

    const onSort = ({ prop, order }) => {
      if (!prop || !order) { sortKey.value = 'impressions'; sortDir.value = 'desc'; return; }
      sortKey.value = prop;
      sortDir.value = order === 'ascending' ? 'asc' : 'desc';
    };

    const exportCsv = () => {
      const items = sortedItems.value;
      if (!items.length) return notify.warning('没有可导出的数据');
      const head = ['Ozon SKU', '货号', '商品名', '展示', '详情浏览', '搜索加购', '详情加购', '加购合计', '订单', '展示→详情%', '详情→加购%', '加购→下单%', '销售额RUB', '类目平均位置'];
      const rows = items.map((x) => [
        x.sku, x.offer_id || '', (x.local_name || x.name || '').replace(/[\r\n,]/g, ' '),
        x.impressions, x.pdp_views, x.tocart_search, x.tocart_pdp, x.tocart, x.orders,
        x.view_rate, x.cart_rate, x.order_rate, x.revenue, x.position_category,
      ]);
      const csv = '\ufeff' + [head, ...rows].map((r) => r.join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `销售漏斗_${data.value.store_name}_${data.value.date_from}_${data.value.date_to}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      notify.success(`已导出 ${rows.length} 行`);
    };

    const onShopChanged = () => fetchData();
    window.addEventListener('shop-changed', onShopChanged);
    Vue.onBeforeUnmount(() => window.removeEventListener('shop-changed', onShopChanged));
    Vue.onMounted(() => { customTo.value = todayStr(); customFrom.value = shiftStr(6); fetchData(); });

    return {
      loading, errText, data, preset, customFrom, customTo, currentStoreName, dataAgeText,
      totals, conversion, stages, sortedItems, fetchData, setPreset, applyCustom, onSort, exportCsv,
      fmtInt, fmtMoney, fmtPct, fmtNum2,
    };
  },
  template: `
    <div style="padding:0; background:#f0f2f5; min-height:100vh">
      <!-- 顶部 -->
      <div style="background:#fff; padding:14px 24px; box-shadow:0 1px 4px rgba(0,0,0,0.04); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px">
        <div style="display:flex; align-items:center; gap:12px">
          <span style="font-size:20px; font-weight:800; color:#303133">📉 销售漏斗</span>
          <el-tag size="small" type="info" effect="plain" v-if="dataAgeText">{{ dataAgeText }}</el-tag>
          <span style="font-size:13px; color:#909399" v-if="currentStoreName">{{ currentStoreName }}</span>
        </div>
        <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap">
          <el-radio-group :model-value="preset" size="small" @change="setPreset">
            <el-radio-button :value="7">近 7 天</el-radio-button>
            <el-radio-button :value="14">近 14 天</el-radio-button>
            <el-radio-button :value="28">近 28 天</el-radio-button>
            <el-radio-button :value="30">近 30 天</el-radio-button>
          </el-radio-group>
          <el-date-picker v-model="customFrom" type="date" size="small" placeholder="开始" value-format="YYYY-MM-DD" style="width:140px" />
          <span style="color:#c0c4cc">~</span>
          <el-date-picker v-model="customTo" type="date" size="small" placeholder="结束" value-format="YYYY-MM-DD" style="width:140px" />
          <el-button size="small" @click="applyCustom">查询</el-button>
          <el-button size="small" type="primary" plain :loading="loading" @click="fetchData">🔄 刷新</el-button>
          <el-button size="small" @click="exportCsv" :disabled="!data || !data.items || !data.items.length">导出 CSV</el-button>
        </div>
      </div>

      <div style="padding:16px 20px 24px">
        <el-alert
          type="info" :closable="false" show-icon style="margin-bottom:14px"
          title="数据来自 Ozon Seller API /v1/analytics/data，不依赖 Premium"
          description="Ozon 后台的「销售漏斗」标签页是 Premium 专属（会弹订阅引导、列卡在加载骨架），但同样口径的数据可用店铺 Api-Key 直接取到，本页即为此数据的呈现。" />

        <el-alert v-if="errText" type="error" :closable="false" show-icon style="margin-bottom:14px" :title="errText" />

        <!-- 漏斗 -->
        <div v-loading="loading" style="background:#fff; border-radius:12px; box-shadow:0 2px 8px rgba(0,0,0,0.06); padding:20px; margin-bottom:16px">
          <div style="font-size:16px; font-weight:700; color:#303133; margin-bottom:16px">
            转化漏斗
            <span v-if="data" style="font-size:12px; font-weight:400; color:#909399; margin-left:8px">{{ data.date_from }} ~ {{ data.date_to }} · {{ data.days }} 天</span>
          </div>
          <div v-if="!totals" style="text-align:center; padding:30px; color:#c0c4cc">暂无数据</div>
          <div v-else>
            <div v-for="(s, i) in stages" :key="s.label" style="margin-bottom:14px">
              <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:6px">
                <span style="font-size:13px; color:#606266; font-weight:600">{{ i + 1 }}. {{ s.label }}</span>
                <span>
                  <b style="font-size:18px; color:#303133">{{ fmtInt(s.value) }}</b>
                  <span v-if="s.extra" style="font-size:12px; color:#e6a23c; margin-left:8px">{{ s.extra }}</span>
                </span>
              </div>
              <div style="height:16px; background:#f0f2f5; border-radius:8px; overflow:hidden">
                <div :style="{
                  width: s.width + '%',
                  height: '100%',
                  borderRadius: '8px',
                  background: ['#409eff','#67c23a','#e6a23c','#f56c6c'][i],
                  transition: 'width .3s ease'
                }"></div>
              </div>
            </div>

            <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:14px; margin-top:20px; padding-top:18px; border-top:1px solid #f0f0f0">
              <div>
                <div style="font-size:12px; color:#909399">销售额（销售价格口径）</div>
                <div style="font-size:22px; font-weight:800; color:#67c23a; margin-top:4px">{{ fmtMoney(totals.revenue) }}</div>
              </div>
              <div>
                <div style="font-size:12px; color:#909399">整体转化率（展示→下单）</div>
                <div style="font-size:22px; font-weight:800; color:#409eff; margin-top:4px">{{ fmtPct(conversion.cr) }}</div>
              </div>
              <div>
                <div style="font-size:12px; color:#909399">累计下单件数</div>
                <div style="font-size:22px; font-weight:800; color:#303133; margin-top:4px">{{ fmtInt(totals.orders) }}</div>
              </div>
              <div>
                <div style="font-size:12px; color:#909399">类目平均位置</div>
                <div style="font-size:22px; font-weight:800; color:#e6a23c; margin-top:4px">{{ fmtNum2(totals.position_category) }}</div>
              </div>
            </div>
            <div style="margin-top:12px; font-size:12px; color:#c0c4cc">
              注：展示/加购/下单为所选区间累计；「类目平均位置」是加权平均位次，越小越靠前。
            </div>
          </div>
        </div>

        <!-- 明细 -->
        <div style="background:#fff; border-radius:12px; box-shadow:0 2px 8px rgba(0,0,0,0.06); overflow:hidden">
          <div style="padding:14px 20px; border-bottom:1px solid #f0f0f0; display:flex; justify-content:space-between; align-items:center">
            <span style="font-size:15px; font-weight:700; color:#303133">按 SKU 明细</span>
            <span style="font-size:12px; color:#909399">{{ (data && data.items ? data.items.length : 0) }} 条 · 点表头可排序</span>
          </div>
          <el-table :data="sortedItems" v-loading="loading" size="small" height="520" @sort-change="onSort"
            :default-sort="{ prop: 'impressions', order: 'descending' }"
            :header-cell-style="{ background:'#fafafa', fontWeight:700, color:'#606266', fontSize:'12px' }">
            <el-table-column label="商品" min-width="230" fixed>
              <template #default="{ row }">
                <div style="display:flex; gap:8px; align-items:center; min-width:0">
                  <el-image :src="row.image" style="width:36px; height:36px; border-radius:6px; background:#f1f5f9; flex-shrink:0; cursor:zoom-in" fit="cover" preview-teleported hide-on-click-modal :preview-src-list="row.image ? [row.image] : []">
                    <template #error><div style="height:36px; display:flex; align-items:center; justify-content:center; color:#cbd5e1; font-size:10px">无图</div></template>
                  </el-image>
                  <div style="min-width:0">
                    <div class="text-ellipsis" style="font-weight:700; color:#0f172a">{{ row.local_name || row.name || '-' }}</div>
                    <div class="text-ellipsis" style="font-size:11px; color:#94a3b8">SKU {{ row.sku }} · 货号 {{ row.offer_id || '-' }}</div>
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="impressions" label="展示" width="95" align="right" sortable />
            <el-table-column prop="pdp_views" label="详情浏览" width="95" align="right" sortable />
            <el-table-column prop="tocart" label="加购" width="80" align="right" sortable />
            <el-table-column prop="orders" label="下单" width="80" align="right" sortable />
            <el-table-column prop="view_rate" label="展示→详情" width="100" align="right" sortable>
              <template #default="{ row }">{{ fmtPct(row.view_rate) }}</template>
            </el-table-column>
            <el-table-column prop="cart_rate" label="详情→加购" width="100" align="right" sortable>
              <template #default="{ row }">{{ fmtPct(row.cart_rate) }}</template>
            </el-table-column>
            <el-table-column prop="order_rate" label="加购→下单" width="100" align="right" sortable>
              <template #default="{ row }">{{ fmtPct(row.order_rate) }}</template>
            </el-table-column>
            <el-table-column prop="revenue" label="销售额 ₽" width="120" align="right" sortable>
              <template #default="{ row }"><span style="font-weight:700; color:#67c23a">{{ fmtMoney(row.revenue) }}</span></template>
            </el-table-column>
            <el-table-column prop="position_category" label="类目位置" width="100" align="right" sortable>
              <template #default="{ row }">{{ fmtNum2(row.position_category) }}</template>
            </el-table-column>
          </el-table>
        </div>
      </div>
    </div>
  `,
};
