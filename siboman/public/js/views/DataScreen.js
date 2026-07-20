window.DataScreenView = {
  setup() {
    const root = Vue.ref(null);
    const data = Vue.ref({ summary: {}, trends: [], recent_orders: [], stock_warnings: [] });
    const connected = Vue.ref(true);
    const clock = Vue.ref('');
    const loading = Vue.ref(false);
    let refreshTimer;
    let clockTimer;
    const money = value => `¥ ${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const maxOrders = Vue.computed(() => Math.max(1, ...(data.value.trends || []).map(x => Number(x.orders || 0))));
    async function refresh() {
      if (loading.value) return;
      loading.value = true;
      try { data.value = (await axios.get('/api/seller/dashboard', { params: { realtime: true, range: 7 } })).data; connected.value = true; }
      catch (_) { connected.value = false; }
      finally { loading.value = false; }
    }
    async function fullscreen() {
      try {
        if (!document.fullscreenElement) { root.value.dataset.wasFullscreen = 'yes'; await root.value?.requestFullscreen(); }
        else await document.exitFullscreen();
      } catch (_) { if (root.value) root.value.dataset.wasFullscreen = 'no'; }
    }
    function onFullscreenChange() { if (!document.fullscreenElement && root.value?.dataset.wasFullscreen === 'yes') { root.value.dataset.wasFullscreen = 'no'; window.location.hash = '#/dashboard'; } }
    Vue.onMounted(() => {
      refresh();
      refreshTimer = setInterval(refresh, 30000);
      const tick = () => { clock.value = new Date().toLocaleString('zh-CN', { hour12: false }); };
      tick(); clockTimer = setInterval(tick, 1000);
      document.addEventListener('fullscreenchange', onFullscreenChange);
    });
    Vue.onBeforeUnmount(() => { clearInterval(refreshTimer); clearInterval(clockTimer); document.removeEventListener('fullscreenchange', onFullscreenChange); });
    return { root, data, connected, clock, loading, money, maxOrders, refresh, fullscreen };
  },
  template: `
    <div ref="root" class="data-screen">
      <div class="screen-head"><div><div class="screen-title">逐梦 ERP 实时经营大屏</div><div class="screen-muted">30 秒自动刷新 · {{clock}}</div></div><div style="display:flex;gap:8px"><el-button dark :loading="loading" @click="refresh">刷新</el-button><el-button type="primary" @click="fullscreen">全屏</el-button></div></div>
      <el-alert v-if="!connected" title="连接已中断，系统将在下一轮自动重试" type="error" :closable="false" show-icon/>
      <div class="screen-grid">
        <section class="screen-panel"><div class="screen-kpi"><span class="screen-muted">今日成交额</span><strong style="color:#ffd166">{{money(data.summary?.today_gmv)}}</strong></div><div class="screen-kpi"><span class="screen-muted">今日订单</span><strong style="color:#45b7ff">{{data.summary?.today_orders || 0}}</strong></div><div class="screen-kpi"><span class="screen-muted">待打包 / 待发货</span><strong>{{data.summary?.awaiting_packaging || 0}} / {{data.summary?.awaiting_deliver || 0}}</strong></div><div class="screen-kpi"><span class="screen-muted">库存预警</span><strong style="color:#ff6b6b">{{data.summary?.stock_warning || 0}}</strong></div></section>
        <section class="screen-panel"><div style="font-weight:700">近 7 日订单趋势</div><div class="screen-trend"><div v-for="point in data.trends || []" :key="point.date" class="screen-bar"><small>{{point.orders}}</small><i :style="{height:Math.max(3, Number(point.orders || 0) / maxOrders * 185) + 'px'}"></i><small class="screen-muted">{{point.date}}</small></div></div><div style="font-weight:700;margin:24px 0 8px">店铺表现</div><el-table :data="data.store_comparison || []" size="small" style="width:100%" :header-cell-style="{background:'#202a37',color:'#aebaca'}" :cell-style="{background:'#19212c',color:'#f5f7fa'}"><el-table-column prop="store_name" label="店铺"/><el-table-column prop="today_orders" label="今日单" width="80"/><el-table-column label="今日 GMV" width="130"><template #default="{row}">{{money(row.today_gmv)}}</template></el-table-column><el-table-column prop="awaiting_treatment" label="待处理" width="80"/></el-table></section>
        <section class="screen-panel screen-feed"><div style="font-weight:700;margin-bottom:8px">最近订单</div><div class="screen-list"><div v-for="order in data.recent_orders || []" :key="order.posting_number" class="screen-order"><div style="min-width:0"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{order.product_name || order.posting_number}}</div><small class="screen-muted">{{order.store_name}} · {{order.posting_number}}</small></div><b>{{money(order.amount_cny)}}</b></div><el-empty v-if="!(data.recent_orders || []).length" description="暂无订单" :image-size="60"/></div></section>
      </div>
      <div class="screen-panel screen-marquee"><span v-if="(data.stock_warnings || []).length">{{data.stock_warnings.map(x => '[' + x.store_name + '] ' + (x.name || x.offer_id) + ' 库存 ' + x.stock).join('　　')}}</span><span v-else style="padding-left:0;animation:none;color:#67c23a">当前没有低库存商品</span></div>
    </div>`
};
