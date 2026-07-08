window.DashboardView = {
  setup() {
    const loading = Vue.ref(false);
    const syncLoading = Vue.ref(false);
    const syncingStore = Vue.ref(null);   // 单店同步 loading
    const summary = Vue.ref({
      today_orders: 0, today_gmv: 0,
      yesterday_orders: 0, yesterday_gmv: 0,
      gmv_growth: 0, order_growth: 0,
      awaiting_packaging: 0, awaiting_deliver: 0, awaiting_treatment: 0,
      active_products: 0, stock_warning: 0,
      today_returns: 0, arbitration: 0,
      weekly_gmv: 0, weekly_payout: 0, weekly_profit: 0, weekly_orders: 0,
      return_rate: 0,
    });
    const storeComparison = Vue.ref([]);
    const trends = Vue.ref([]);
    const recentJobs = Vue.ref([]);

    const fmtMoney = (v) => '¥' + (Number(v || 0)).toFixed(2);
    const fmtPct = (v) => {
      const n = Number(v || 0);
      const sign = n > 0 ? '+' : '';
      return sign + n.toFixed(2) + '%';
    };
    const fmtRate = (v) => (Number(v || 0)).toFixed(2) + '%';

    const fetchDashboard = async () => {
      loading.value = true;
      try {
        const res = await axios.get('/api/seller/dashboard', {
          params: { store_id: (window.getCurrentStoreId ? window.getCurrentStoreId() : '') },
        });
        if (res.data.success) {
          const s = res.data.summary || {};
          // 物理兜底: 所有数值字段确保非 null/undefined
          const num = (x) => Number(x || 0);
          summary.value = {
            today_orders: num(s.today_orders),
            today_gmv: num(s.today_gmv),
            yesterday_orders: num(s.yesterday_orders),
            yesterday_gmv: num(s.yesterday_gmv),
            gmv_growth: num(s.gmv_growth),
            order_growth: num(s.order_growth),
            awaiting_packaging: num(s.awaiting_packaging),
            awaiting_deliver: num(s.awaiting_deliver),
            awaiting_treatment: num(s.awaiting_treatment),
            active_products: num(s.active_products),
            stock_warning: num(s.stock_warning),
            today_returns: num(s.today_returns),
            arbitration: num(s.arbitration),
            weekly_gmv: num(s.weekly_gmv),
            weekly_payout: num(s.weekly_payout),
            weekly_profit: num(s.weekly_profit),
            weekly_orders: num(s.weekly_orders),
            return_rate: num(s.return_rate),
          };
          storeComparison.value = (res.data.store_comparison || []).map(sc => ({
            ...sc,
            active_products: Number(sc.active_products || 0),
            today_orders: Number(sc.today_orders || 0),
            yesterday_orders: Number(sc.yesterday_orders || 0),
            awaiting_treatment: Number(sc.awaiting_treatment || 0),
            today_gmv: Number(sc.today_gmv || 0),
            yesterday_gmv: Number(sc.yesterday_gmv || 0),
            weekly_orders: Number(sc.weekly_orders || 0),
            weekly_gmv: Number(sc.weekly_gmv || 0),
            return_rate: Number(sc.return_rate || 0),
          }));
          trends.value = res.data.trends || [];
          recentJobs.value = res.data.recentJobs || [];
        }
      } catch (e) {
        console.error('仪表盘加载失败', e);
      } finally {
        loading.value = false;
      }
    };

    const goToStores = () => { window.location.hash = '#/stores'; };
    const goToCollection = () => { window.location.hash = '#/collection'; };
    const goToOrders = () => { window.location.hash = '#/orders'; };
    const goToProducts = () => { window.location.hash = '#/products'; };
    const goToAIImage = () => { window.location.hash = '#/ai-image'; };
    const goToInventory = () => { window.location.hash = '#/inventory'; };

    // v0.5.6 全部同步
    const syncAllStores = async () => {
      try {
        await window.ElementPlus.ElMessageBox.confirm(
          '将同步所有店铺的 Ozon 商品数据，预计耗时 30-120 秒，确认开始？',
          '全部同步',
          { confirmButtonText: '开始同步', cancelButtonText: '取消', type: 'info' },
        );
      } catch { return; }
      syncLoading.value = true;
      try {
        const res = await axios.post('/api/seller/products/sync-global', {}, { timeout: 300000 });
        const results = res.data.results || [];
        const ok = results.filter(r => !r.error);
        const fail = results.filter(r => r.error);
        let msg = `同步完成: ${ok.length} 店成功, 共 ${res.data.total_count} 条`;
        if (fail.length) msg += `; ${fail.length} 店失败: ${fail.map(f => f.store_name).join(', ')}`;
        (window.ElementPlus?.ElMessage || console).success?.(msg);
        await fetchDashboard();
      } catch (e) {
        (window.ElementPlus?.ElMessage || console).error?.('同步失败: ' + (e.response?.data?.error || e.message));
      } finally {
        syncLoading.value = false;
      }
    };

    // v0.5.6 单店同步
    const syncOneStore = async (row) => {
      syncingStore.value = row.store_id;
      try {
        const res = await axios.post('/api/seller/products/sync-all',
          { store_id: row.store_id }, { timeout: 300000 });
        (window.ElementPlus?.ElMessage || console).success?.(`${row.store_name} 同步完成: ${res.data.count} 条`);
        await fetchDashboard();
      } catch (e) {
        (window.ElementPlus?.ElMessage || console).error?.(`${row.store_name} 同步失败: ` + (e.response?.data?.error || e.message));
      } finally {
        syncingStore.value = null;
      }
    };

    const onShopChanged = () => fetchDashboard();
    window.addEventListener('shop-changed', onShopChanged);
    Vue.onBeforeUnmount(() => window.removeEventListener('shop-changed', onShopChanged));
    Vue.onMounted(fetchDashboard);

    return {
      summary, storeComparison, trends, recentJobs, loading,
      syncLoading, syncingStore,
      fmtMoney, fmtPct, fmtRate,
      goToStores, goToCollection, goToOrders, goToProducts, goToAIImage, goToInventory,
      syncAllStores, syncOneStore,
    };
  },
  template: `
    <div class="dashboard-v056" v-loading="loading" style="padding: 0; background: #f0f2f5; min-height: 100vh">

      <!-- ========== 顶部标题行 ========== -->
      <div style="background: #fff; padding: 14px 24px; box-shadow: 0 1px 4px rgba(0,0,0,0.04); display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 100">
        <div style="display: flex; align-items: center; gap: 12px">
          <span style="font-size: 20px; font-weight: 800; color: #303133">📊 经营仪表盘</span>
          <el-tag size="small" type="info" effect="plain">实时数据</el-tag>
        </div>
        <div style="display: flex; gap: 10px; align-items: center">
          <el-button size="small" @click="fetchDashboard" :icon="undefined" style="border-radius: 8px">
            🔄 刷新
          </el-button>
          <el-button type="primary" size="default" :loading="syncLoading" @click="syncAllStores"
            style="font-weight: 600; border-radius: 8px; padding: 10px 24px; font-size: 14px">
            <span v-if="!syncLoading">🔄 全部同步</span>
            <span v-else>同步中...</span>
          </el-button>
        </div>
      </div>

      <!-- ========== KPI 卡片区 (4列网格, 阴影圆角) ========== -->
      <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; padding: 20px 20px 0">

        <!-- 今日订单 -->
        <div style="background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); padding: 20px; position: relative; overflow: hidden">
          <div style="position: absolute; top: 0; left: 0; right: 0; height: 4px; background: linear-gradient(90deg, #409eff, #67c23a)"></div>
          <div style="font-size: 13px; color: #909399; margin-bottom: 8px">今日订单</div>
          <div style="font-size: 32px; font-weight: 800; color: #303133; line-height: 1">{{ summary.today_orders }}</div>
          <div style="margin-top: 10px; display: flex; align-items: center; gap: 6px">
            <span style="font-size: 12px; color: #909399">昨日 {{ summary.yesterday_orders }}</span>
            <span :style="{ fontSize: '12px', fontWeight: 700, color: summary.order_growth > 0 ? '#f56c6c' : summary.order_growth < 0 ? '#67c23a' : '#909399' }">
              {{ summary.order_growth > 0 ? '▲' : summary.order_growth < 0 ? '▼' : '—' }} {{ Math.abs(summary.order_growth) }}%
            </span>
          </div>
        </div>

        <!-- 今日 GMV -->
        <div style="background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); padding: 20px; position: relative; overflow: hidden">
          <div style="position: absolute; top: 0; left: 0; right: 0; height: 4px; background: linear-gradient(90deg, #e6a23c, #f56c6c)"></div>
          <div style="font-size: 13px; color: #909399; margin-bottom: 8px">今日 GMV</div>
          <div style="font-size: 32px; font-weight: 800; color: #e6a23c; line-height: 1">{{ fmtMoney(summary.today_gmv) }}</div>
          <div style="margin-top: 10px; display: flex; align-items: center; gap: 6px">
            <span style="font-size: 12px; color: #909399">昨日 {{ fmtMoney(summary.yesterday_gmv) }}</span>
            <span :style="{ fontSize: '12px', fontWeight: 700, color: summary.gmv_growth > 0 ? '#f56c6c' : summary.gmv_growth < 0 ? '#67c23a' : '#909399' }">
              {{ summary.gmv_growth > 0 ? '▲' : summary.gmv_growth < 0 ? '▼' : '—' }} {{ Math.abs(summary.gmv_growth) }}%
            </span>
          </div>
        </div>

        <!-- 待处理 -->
        <div style="background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); padding: 20px; position: relative; overflow: hidden">
          <div style="position: absolute; top: 0; left: 0; right: 0; height: 4px; background: linear-gradient(90deg, #f56c6c, #e6a23c)"></div>
          <div style="font-size: 13px; color: #909399; margin-bottom: 8px">待处理 (打包+发货)</div>
          <div :style="{ fontSize: '32px', fontWeight: 800, lineHeight: 1, color: summary.awaiting_treatment > 0 ? '#f56c6c' : '#303133' }">{{ summary.awaiting_treatment }}</div>
          <div style="margin-top: 10px; font-size: 12px; color: #909399">
            打包 <b style="color: #e6a23c">{{ summary.awaiting_packaging }}</b> · 发货 <b style="color: #e6a23c">{{ summary.awaiting_deliver }}</b>
          </div>
        </div>

        <!-- 7 日 GMV -->
        <div style="background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); padding: 20px; position: relative; overflow: hidden">
          <div style="position: absolute; top: 0; left: 0; right: 0; height: 4px; background: linear-gradient(90deg, #67c23a, #409eff)"></div>
          <div style="font-size: 13px; color: #909399; margin-bottom: 8px">本周累计 GMV</div>
          <div style="font-size: 32px; font-weight: 800; color: #67c23a; line-height: 1">{{ fmtMoney(summary.weekly_gmv) }}</div>
          <div style="margin-top: 10px; font-size: 12px; color: #909399">
            7日 {{ summary.weekly_orders }} 单 · 利润 {{ fmtMoney(summary.weekly_profit) }}
          </div>
        </div>
      </div>

      <!-- ========== 副指标行 (4 小卡片) ========== -->
      <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; padding: 16px 20px 0">
        <div style="background: #fff; border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,0.04); padding: 14px 18px; display: flex; align-items: center; gap: 12px">
          <div style="width: 40px; height: 40px; border-radius: 8px; background: #ecf5ff; display: flex; align-items: center; justify-content: center; flex-shrink: 0">
            <span style="font-size: 18px">📦</span>
          </div>
          <div>
            <div style="font-size: 11px; color: #909399">在售商品</div>
            <div style="font-size: 20px; font-weight: 700">{{ summary.active_products }}</div>
          </div>
        </div>
        <div style="background: #fff; border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,0.04); padding: 14px 18px; display: flex; align-items: center; gap: 12px">
          <div style="width: 40px; height: 40px; border-radius: 8px; background: #fef0f0; display: flex; align-items: center; justify-content: center; flex-shrink: 0">
            <span style="font-size: 18px">⚠️</span>
          </div>
          <div>
            <div style="font-size: 11px; color: #909399">库存预警</div>
            <div :style="{ fontSize: '20px', fontWeight: 700, color: summary.stock_warning > 0 ? '#f56c6c' : '#303133' }">{{ summary.stock_warning }}</div>
          </div>
        </div>
        <div style="background: #fff; border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,0.04); padding: 14px 18px; display: flex; align-items: center; gap: 12px">
          <div style="width: 40px; height: 40px; border-radius: 8px; background: #fdf6ec; display: flex; align-items: center; justify-content: center; flex-shrink: 0">
            <span style="font-size: 18px">↩️</span>
          </div>
          <div>
            <div style="font-size: 11px; color: #909399">退货率</div>
            <div style="font-size: 20px; font-weight: 700">{{ fmtRate(summary.return_rate) }}</div>
          </div>
        </div>
        <div style="background: #fff; border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,0.04); padding: 14px 18px; display: flex; align-items: center; gap: 12px">
          <div style="width: 40px; height: 40px; border-radius: 8px; background: #f0f9ff; display: flex; align-items: center; justify-content: center; flex-shrink: 0">
            <span style="font-size: 18px">⚖️</span>
          </div>
          <div>
            <div style="font-size: 11px; color: #909399">争议单</div>
            <div :style="{ fontSize: '20px', fontWeight: 700, color: summary.arbitration > 0 ? '#f56c6c' : '#303133' }">{{ summary.arbitration }}</div>
          </div>
        </div>
      </div>

      <!-- ========== 店铺业绩对比表 (11 列, width 100%, 严禁留白) ========== -->
      <div style="padding: 16px 20px 0">
        <div style="background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); overflow: hidden">
          <div style="padding: 16px 20px; border-bottom: 1px solid #f0f0f0; display: flex; justify-content: space-between; align-items: center">
            <span style="font-size: 16px; font-weight: 700; color: #303133">📊 店铺业绩对比</span>
            <el-button text size="small" @click="goToStores">管理店铺 →</el-button>
          </div>
          <el-table :data="storeComparison" stripe size="default" style="width: 100%" :header-cell-style="{ background: '#fafafa', fontWeight: 700, color: '#606266', fontSize: '13px' }">
            <el-table-column prop="store_name" label="店铺" min-width="120" fixed>
              <template #default="{row}">
                <span style="font-weight: 600; color: #409eff">{{ row.store_name }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="active_products" label="在售" width="80" align="right" />
            <el-table-column prop="today_orders" label="今日单" width="80" align="right" />
            <el-table-column prop="yesterday_orders" label="昨日单" width="80" align="right" />
            <el-table-column label="待处理" width="80" align="right">
              <template #default="{row}">
                <span :style="{ fontWeight: row.awaiting_treatment > 0 ? '800' : '400', color: row.awaiting_treatment > 0 ? '#f56c6c' : '#909399' }">{{ row.awaiting_treatment }}</span>
              </template>
            </el-table-column>
            <el-table-column label="今日 GMV" width="110" align="right">
              <template #default="{row}">{{ fmtMoney(row.today_gmv) }}</template>
            </el-table-column>
            <el-table-column label="昨日 GMV" width="110" align="right">
              <template #default="{row}">{{ fmtMoney(row.yesterday_gmv) }}</template>
            </el-table-column>
            <el-table-column prop="weekly_orders" label="7日单" width="80" align="right" />
            <el-table-column label="7日 GMV" width="120" align="right">
              <template #default="{row}">
                <span style="font-weight: 700; color: #67c23a">{{ fmtMoney(row.weekly_gmv) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="退货率" width="90" align="right">
              <template #default="{row}">{{ fmtRate(row.return_rate) }}</template>
            </el-table-column>
            <el-table-column label="状态" width="100" align="center">
              <template #default="{row}">
                <el-tag size="small"
                  :type="row.sync_status === '已同步' ? 'success' : 'warning'"
                  effect="light"
                  style="cursor: pointer"
                  @click="syncOneStore(row)">
                  {{ row.sync_status }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="100" align="center" fixed="right">
              <template #default="{row}">
                <el-button type="primary" size="small" link
                  :loading="syncingStore === row.store_id"
                  @click="syncOneStore(row)">
                  {{ syncingStore === row.store_id ? '同步中' : '同步' }}
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>

      <!-- ========== 7 日趋势 + 功能入口 (两列) ========== -->
      <div style="display: grid; grid-template-columns: 1fr 360px; gap: 16px; padding: 16px 20px 20px">

        <!-- 7 日趋势 -->
        <div style="background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); overflow: hidden">
          <div style="padding: 16px 20px; border-bottom: 1px solid #f0f0f0">
            <span style="font-size: 16px; font-weight: 700; color: #303133">📈 7 日订单趋势</span>
          </div>
          <div style="padding: 20px">
            <div v-if="!trends.length" style="text-align: center; padding: 40px; color: #c0c4cc">暂无趋势数据</div>
            <div v-else style="display: flex; align-items: flex-end; gap: 8px; height: 200px; padding: 0 10px">
              <div v-for="t in trends" :key="t.date" style="flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px">
                <div style="font-size: 11px; color: #909399; font-weight: 600">{{ t.orders }}单</div>
                <div :style="{
                  width: '100%',
                  maxWidth: '48px',
                  height: Math.max(4, (t.orders / Math.max(...trends.map(x => x.orders || 1)) * 160)) + 'px',
                  borderRadius: '6px 6px 0 0',
                  background: t.orders > 0 ? 'linear-gradient(180deg, #409eff, #67c23a)' : '#ebeef5',
                  transition: 'height 0.3s ease',
                }"></div>
                <div style="font-size: 11px; color: #909399">{{ t.date }}</div>
              </div>
            </div>
          </div>
        </div>

        <!-- 功能入口 -->
        <div style="background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); overflow: hidden">
          <div style="padding: 16px 20px; border-bottom: 1px solid #f0f0f0">
            <span style="font-size: 16px; font-weight: 700; color: #303133">⚡ 快捷功能</span>
          </div>
          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; padding: 20px">
            <div v-for="fn in [
              { icon: '🔄', label: '同步商品', action: goToProducts, color: '#409eff' },
              { icon: '📦', label: '库存管理', action: goToInventory, color: '#67c23a' },
              { icon: '📋', label: '订单管理', action: goToOrders, color: '#e6a23c' },
              { icon: '🛒', label: '采集箱', action: goToCollection, color: '#f56c6c' },
              { icon: '🎨', label: 'AI 套图', action: goToAIImage, color: '#909399' },
              { icon: '🏪', label: '店铺管理', action: goToStores, color: '#9b59b6' },
            ]" :key="fn.label" @click="fn.action()"
              style="display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 16px 8px; border-radius: 10px; cursor: pointer; transition: all 0.2s; background: #f9fafc"
              onmouseover="this.style.background='#ecf5ff'" onmouseout="this.style.background='#f9fafc'">
              <span style="font-size: 24px">{{ fn.icon }}</span>
              <span style="font-size: 12px; color: #606266; font-weight: 500">{{ fn.label }}</span>
            </div>
          </div>
        </div>
      </div>

    </div>
  `
};
