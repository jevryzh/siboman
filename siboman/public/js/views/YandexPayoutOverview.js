// [Accio Work 修改] v2.2.9.222 Yandex 回款总览（店铺级三桶聚合页面）
//   菜单：Yandex 管理 → 回款总览（#/yandex-payout）
//   数据：GET /api/yandex/payout-overview（近 35 天 netting 付款报告全量聚合）
//   口径与订单详情「付款报告实测」完全一致（同一份报告、同一套通道分类）。
window.YandexPayoutOverview = {
  setup() {
    const notify = {
      success: (msg) => (window.ElementPlus?.ElMessage || console).success?.(msg),
      warning: (msg) => (window.ElementPlus?.ElMessage || console).warning?.(msg),
      error: (msg) => (window.ElementPlus?.ElMessage || console).error?.(msg),
    };

    // 店铺选择（与 Yandex 订单页同模式）
    const yandexStores = Vue.ref([]);
    const currentStoreId = Vue.ref(localStorage.getItem('currentStoreId') || '');
    const fetchYandexStores = async () => {
      try {
        const res = await axios.get('/api/seller/shops', { params: { platform: 'yandex' } });
        yandexStores.value = res.data.shops || [];
        const sid = localStorage.getItem('currentStoreId') || '';
        if (!yandexStores.value.some((s) => s.id === sid) && yandexStores.value.length) {
          currentStoreId.value = yandexStores.value[0].id;
          localStorage.setItem('currentStoreId', currentStoreId.value);
        } else {
          currentStoreId.value = sid;
        }
      } catch (_e) { /* 店铺列表失败不阻塞 */ }
    };
    const changeStore = (val) => {
      localStorage.setItem('currentStoreId', val);
      window.dispatchEvent(new CustomEvent('shop-changed', { detail: val }));
      fetchOverview();
    };

    const loading = Vue.ref(false);
    const hasFetched = Vue.ref(false);
    const totals = Vue.ref(null);
    const orders = Vue.ref([]);
    const degraded = Vue.ref(false);
    const cachedAt = Vue.ref('');
    const storeInfo = Vue.ref(null);
    // 本地筛选（不打后端）
    const search = Vue.ref('');
    const activeTab = Vue.ref('all');

    const fmt = (n) => {
      const v = Number(n);
      if (!Number.isFinite(v)) return '—';
      const sign = v > 0 ? '+' : '';
      return sign + v.toFixed(2);
    };
    const fmtAbs = (n) => (Number(n) === 0 ? '0.00' : Math.abs(Number(n)).toFixed(2));
    const color = (n) => (Number(n) > 0 ? '#16a34a' : Number(n) < 0 ? '#dc2626' : '#94a3b8');

    let fetchSeq = 0;
    const fetchOverview = async () => {
      const seq = ++fetchSeq;
      loading.value = true;
      degraded.value = false;
      try {
        const res = await axios.get('/api/yandex/payout-overview', {
          params: { store_id: currentStoreId.value || undefined },
        });
        if (seq !== fetchSeq) return;
        const d = res.data || {};
        totals.value = d.totals || null;
        orders.value = d.orders || [];
        degraded.value = Boolean(d.degraded);
        cachedAt.value = d.cached_at ? String(d.cached_at).replace('T', ' ').slice(0, 16) + ' (UTC)' : '';
        storeInfo.value = d.store || null;
        hasFetched.value = true;
        if (degraded.value) notify.warning('付款报告拉取被限流（Yandex 1 次/2分钟），2 分钟后点刷新即可');
      } catch (error) {
        if (seq !== fetchSeq) return;
        notify.error(error.response?.data?.error || error.message || '读取回款总览失败');
      } finally {
        if (seq === fetchSeq) loading.value = false;
      }
    };

    // ── 明细抽屉：复用订单结算端点，展示该单逐笔流水 ──
    const drawer = Vue.reactive({ visible: false, orderId: '', settlement: null, loading: false });
    const openDetail = async (row) => {
      drawer.orderId = row.order_id;
      drawer.settlement = null;
      drawer.visible = true;
      drawer.loading = true;
      try {
        const res = await axios.get(`/api/yandex/orders/${row.order_id}/settlement`, {
          params: { store_id: currentStoreId.value || undefined },
        });
        if (res.data?.success) drawer.settlement = res.data.settlement;
      } catch (_e) { /* 拉不到时抽屉显示提示 */ }
      finally { drawer.loading = false; }
    };

    const filtered = Vue.computed(() => {
      const q = String(search.value || '').trim();
      let list = orders.value;
      if (activeTab.value === 'pending') list = list.filter((x) => x.pending_cny > 0.005);
      else if (activeTab.value === 'paid') list = list.filter((x) => Math.abs(x.paid_cny) > 0.005);
      else if (activeTab.value === 'balance-plus') list = list.filter((x) => x.balance_cny > 0.005);
      else if (activeTab.value === 'negative') list = list.filter((x) => x.total_income_cny < 0);
      if (q) list = list.filter((x) => String(x.order_id).includes(q));
      return list;
    });

    Vue.onMounted(async () => { await fetchYandexStores(); await fetchOverview(); });

    return {
      yandexStores, currentStoreId, changeStore,
      loading, hasFetched, totals, orders, degraded, cachedAt, storeInfo,
      search, activeTab, filtered, fetchOverview,
      fmt, fmtAbs, color, drawer, openDetail,
      payoutItems: (s) => (s?.items || []).filter((x) => x.channel === 'payout'),
      balanceItems: (s) => (s?.items || []).filter((x) => x.channel === 'balance'),
    };
  },
  template: `
    <div>
      <div class="erp-toolbar">
        <div>
          <h1 class="erp-workbench-title">Yandex 回款总览</h1>
          <div class="erp-muted" style="display:flex; align-items:center; gap:10px; flex-wrap:wrap">
            <el-select v-model="currentStoreId" size="small" style="width:200px" placeholder="切换 Yandex 店铺" @change="changeStore">
              <el-option v-for="s in yandexStores" :key="s.id" :label="s.name" :value="s.id" />
            </el-select>
            <span v-if="storeInfo">{{ storeInfo.name }}</span>
            <span v-if="cachedAt" style="font-size:11px">报告时间 {{ cachedAt }}</span>
          </div>
        </div>
        <div style="display:flex; gap:8px">
          <el-button size="large" :loading="loading" @click="fetchOverview">
            <el-icon><RefreshRight /></el-icon><span>刷新</span>
          </el-button>
        </div>
      </div>

      <el-alert v-if="degraded" type="warning" :closable="false" show-icon style="margin-bottom:14px"
        title="付款报告这次没拉到（多为限流）"
        description="Yandex 报告生成限频 1 次/2 分钟；而且报告生成本来就慢（约 1 分钟）。等 2 分钟后点「刷新」即可，无需其他操作。" />

      <el-alert type="info" :closable="false" style="margin-bottom:14px"
        title="三个口径怎么读"
        description="待打款 = 已算清、Yandex 将按付款周期转到你银行卡（Будет переведён）；余额变动 = 平台补贴/联促分摊，直接进店铺余额、不经银行卡（Справочно: баланс）；已入账 = 已实际打款或已代扣（Отправлен / Удержан）。全店总所得 = 三项合计。展开订单行可看逐笔流水。" />

      <!-- 4 张 KPI 卡 -->
      <div v-loading="loading" style="display:grid; grid-template-columns:repeat(4, 1fr); gap:14px; margin-bottom:16px">
        <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:10px; padding:14px 16px">
          <div style="font-size:12px; color:#0369a1; font-weight:700">待打款（排队中）</div>
          <div style="font-size:26px; font-weight:800; color:#0369a1; margin-top:4px">¥ {{ totals ? fmtAbs(totals.pending_cny) : '—' }}</div>
          <div style="font-size:11px; color:#64748b; margin-top:2px">按付款周期自动到银行卡</div>
        </div>
        <div style="background:#f0fdfa; border:1px solid #99f6e4; border-radius:10px; padding:14px 16px">
          <div style="font-size:12px; color:#0f766e; font-weight:700">余额净变动</div>
          <div style="font-size:26px; font-weight:800; color:#0f766e; margin-top:4px">¥ {{ totals ? fmtAbs(totals.balance_cny) : '—' }}</div>
          <div style="font-size:11px; color:#64748b; margin-top:2px">补贴返还+联促分摊 · 不经银行卡</div>
        </div>
        <div style="background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:14px 16px">
          <div style="font-size:12px; color:#334155; font-weight:700">已入账（含尾数）</div>
          <div style="font-size:26px; font-weight:800; color:#334155; margin-top:4px">¥ {{ totals ? fmtAbs(totals.paid_cny) : '—' }}</div>
          <div style="font-size:11px; color:#64748b; margin-top:2px">已打款 + 已代扣（取消单多为 −0.10 尾数）</div>
        </div>
        <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:10px; padding:14px 16px">
          <div style="font-size:12px; color:#15803d; font-weight:700">全店总经济所得</div>
          <div style="font-size:26px; font-weight:800; color:#15803d; margin-top:4px">¥ {{ totals ? fmtAbs(totals.total_income_cny) : '—' }}</div>
          <div style="font-size:11px; color:#64748b; margin-top:2px">三桶合计 · 近 35 天 · {{ totals ? totals.orders : 0 }} 单</div>
        </div>
      </div>

      <div class="erp-filter-row" style="align-items:center">
        <el-radio-group v-model="activeTab">
          <el-radio-button value="all">全部 ({{ orders.length }})</el-radio-button>
          <el-radio-button value="pending">有待打款</el-radio-button>
          <el-radio-button value="paid">已入账</el-radio-button>
          <el-radio-button value="balance-plus">余额为正</el-radio-button>
          <el-radio-button value="negative">总所得为负</el-radio-button>
        </el-radio-group>
        <el-input v-model="search" size="large" clearable placeholder="搜订单号" style="width:220px" />
      </div>

      <el-table :data="filtered" v-loading="loading" border size="large"
        :empty-text="hasFetched ? '该筛选下暂无订单。' : '正在读取付款报告（首次约 1 分钟）...'"
        style="border-radius:8px; overflow:hidden; margin-top:12px">
        <el-table-column label="订单号" min-width="170" fixed="left" show-overflow-tooltip>
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)"><b>{{ row.order_id }}</b></el-button>
          </template>
        </el-table-column>
        <el-table-column label="已入账 ¥" width="120" align="right" sortable prop="paid_cny">
          <template #default="{ row }"><span :style="{ color: color(row.paid_cny), fontWeight: 700 }">{{ fmt(row.paid_cny) }}</span></template>
        </el-table-column>
        <el-table-column label="待打款 ¥" width="120" align="right" sortable prop="pending_cny">
          <template #default="{ row }"><span :style="{ color: color(row.pending_cny), fontWeight: 700 }">{{ fmt(row.pending_cny) }}</span></template>
        </el-table-column>
        <el-table-column label="银行回款合计 ¥" width="140" align="right" sortable prop="bank_payout_cny">
          <template #default="{ row }"><span :style="{ color: color(row.bank_payout_cny), fontWeight: 700 }">{{ fmt(row.bank_payout_cny) }}</span></template>
        </el-table-column>
        <el-table-column label="余额净变动 ¥" width="130" align="right" sortable prop="balance_cny">
          <template #default="{ row }"><span :style="{ color: color(row.balance_cny), fontWeight: 700 }">{{ fmt(row.balance_cny) }}</span></template>
        </el-table-column>
        <el-table-column label="总经济所得 ¥" width="140" align="right" sortable prop="total_income_cny">
          <template #default="{ row }"><span :style="{ color: color(row.total_income_cny), fontWeight: 800 }">{{ fmt(row.total_income_cny) }}</span></template>
        </el-table-column>
        <el-table-column label="流水笔数" width="100" align="center" prop="line_count" />
        <el-table-column label="最近流水" width="150">
          <template #default="{ row }">{{ row.last_transfer_at || '—' }}</template>
        </el-table-column>
      </el-table>
      <div class="erp-muted" style="margin-top:10px; font-size:12px">
        点订单号看该单逐笔流水（买家付款 → 平台代扣 → 余额分摊）。取消单只留 −0.10 收款手续费尾数属正常现象。
      </div>

      <!-- 逐笔流水抽屉 -->
      <el-drawer v-model="drawer.visible" :title="'回款流水 · 订单 ' + drawer.orderId" size="620px" append-to-body destroy-on-close>
        <div v-loading="drawer.loading">
          <template v-if="drawer.settlement">
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:14px">
              <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:8px; padding:12px">
                <div style="font-size:12px; color:#0369a1; font-weight:700">银行回款（已入账+待打款）</div>
                <div style="font-size:22px; font-weight:900; color:#0369a1; margin-top:4px">¥ {{ fmtAbs(drawer.settlement.bank_payout_cny) }}</div>
              </div>
              <div style="background:#f0fdfa; border:1px solid #99f6e4; border-radius:8px; padding:12px">
                <div style="font-size:12px; color:#0f766e; font-weight:700">总经济所得</div>
                <div style="font-size:22px; font-weight:900; color:#0f766e; margin-top:4px">¥ {{ fmtAbs(drawer.settlement.total_income_cny) }}</div>
              </div>
            </div>
            <div style="font-size:13px; font-weight:800; color:#0369a1; margin:10px 0 6px">① 银行回款通道（打款流水）</div>
            <el-table :data="payoutItems(drawer.settlement)" size="small" border>
              <el-table-column label="项目" min-width="150">
                <template #default="{ row }">
                  <div>{{ row.name }}</div>
                  <div v-if="row.raw_name && row.raw_name !== row.name" style="font-size:11px; color:#94a3b8">{{ row.raw_name }}</div>
                </template>
              </el-table-column>
              <el-table-column label="金额 ¥" width="110" align="right">
                <template #default="{ row }"><span :style="{ color: color(row.amount), fontWeight: 700 }">{{ fmt(row.amount) }}</span></template>
              </el-table-column>
              <el-table-column label="笔数" width="60" align="center" prop="n" />
              <el-table-column label="状态" min-width="170">
                <template #default="{ row }">
                  <div style="font-size:12px">{{ row.status }}</div>
                  <div style="font-size:11px; color:#94a3b8">{{ row.status.includes('Будет переведён') ? '将按周期打款' : row.status.includes('Отправлен') ? '已打款入账' : row.status.includes('удержан из платежей') ? '从货款中代扣' : '' }}</div>
                </template>
              </el-table-column>
            </el-table>
            <div style="font-size:13px; font-weight:800; color:#0f766e; margin:12px 0 6px">② 余额通道（不经银行卡）</div>
            <el-table :data="balanceItems(drawer.settlement)" size="small" border>
              <el-table-column label="项目" min-width="150">
                <template #default="{ row }">
                  <div>{{ row.name }}</div>
                  <div v-if="row.raw_name && row.raw_name !== row.name" style="font-size:11px; color:#94a3b8">{{ row.raw_name }}</div>
                </template>
              </el-table-column>
              <el-table-column label="金额 ¥" width="110" align="right">
                <template #default="{ row }"><span :style="{ color: color(row.amount), fontWeight: 700 }">{{ fmt(row.amount) }}</span></template>
              </el-table-column>
              <el-table-column label="笔数" width="60" align="center" prop="n" />
              <el-table-column label="状态" min-width="170">
                <template #default="{ row }">
                  <div style="font-size:12px">{{ row.status }}</div>
                </template>
              </el-table-column>
            </el-table>
          </template>
          <el-alert v-else-if="!drawer.loading" type="warning" :closable="false" show-icon
            title="付款报告暂未覆盖该单"
            description="可能原因：订单刚送达还没结算、或报告窗口（近 35 天）未包含它。" />
        </div>
      </el-drawer>
    </div>
  `,
};
