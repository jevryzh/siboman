window.OzonPatrolView = {
  setup() {
    const loading = Vue.ref(false);
    const hasFetched = Vue.ref(false);
    const rows = Vue.ref([]);
    const pagination = Vue.reactive({ currentPage: 1, pageSize: 100, total: 0 });
    const colorFilter = Vue.ref('followed');
    const counts = Vue.reactive({ all: 0, red: 0, yellow: 0, green: 0, no_index: 0 });
    const stores = Vue.ref([]);
    const currentStoreId = Vue.ref(localStorage.getItem('currentStoreId') || '');
    const scannedAt = Vue.ref(0);
    const selectedRows = Vue.ref([]);
    const repriceBusy = Vue.ref(false);
    const collectBusy = Vue.ref(false);

    const notify = {
      success: (m) => (window.ElementPlus?.ElMessage || console).success?.(m),
      warning: (m) => (window.ElementPlus?.ElMessage || console).warning?.(m),
      error: (m) => (window.ElementPlus?.ElMessage || console).error?.(m),
    };

    const colorOptions = [
      { label: '被压价（不利+中等）', value: 'followed' },
      { label: '不利（被压价）', value: 'red' },
      { label: '中等（略贵）', value: 'yellow' },
      { label: '有利（我最便宜）', value: 'green' },
      { label: '全部', value: 'all' },
    ];
    const colorText = (c) => ({ RED: '不利', YELLOW: '中等', GREEN: '有利', WITHOUT_INDEX: '无指数' }[c] || c || '-');
    const colorTag = (c) => ({ RED: 'danger', YELLOW: 'warning', GREEN: 'success', WITHOUT_INDEX: 'info' }[c] || 'info');
    const scannedText = Vue.computed(() => (scannedAt.value ? new Date(scannedAt.value).toLocaleString('zh-CN') : '-'));

    const fetchStores = async () => {
      try {
        const res = await axios.get('/api/seller/shops', { params: { platform: 'ozon' } });
        stores.value = res.data.shops || [];
        const sid = localStorage.getItem('currentStoreId') || '';
        if (!stores.value.some((s) => s.id === sid) && stores.value.length) {
          currentStoreId.value = stores.value[0].id;
          localStorage.setItem('currentStoreId', currentStoreId.value);
        } else {
          currentStoreId.value = sid;
        }
      } catch (_e) { /* 店铺列表失败不阻塞 */ }
    };

    const fetchPatrol = async () => {
      loading.value = true;
      try {
        const res = await axios.get('/api/ozon/patrol', {
          params: {
            store_id: currentStoreId.value || '',
            color: colorFilter.value,
            page: pagination.currentPage,
            page_size: pagination.pageSize,
          },
          timeout: 300000, // 首次扫描可能较慢
        });
        rows.value = res.data?.items || [];
        pagination.total = Number(res.data?.total || 0);
        scannedAt.value = Number(res.data?.scanned_at || 0);
        Object.assign(counts, res.data?.counts || {});
        if (pagination.total && hasFetched.value === false) notify.success(`巡查完成，共 ${pagination.total} 个（按当前筛选）`);
      } catch (e) {
        notify.error(e.response?.data?.error || e.message || '巡查失败');
        rows.value = [];
        pagination.total = 0;
      } finally {
        loading.value = false;
        hasFetched.value = true;
      }
    };

    const changeStore = (val) => {
      localStorage.setItem('currentStoreId', val);
      pagination.currentPage = 1;
      fetchPatrol();
    };

    const onSelectionChange = (rows) => { selectedRows.value = rows; };

    const followDrawer = Vue.reactive({ visible: false, offerId: '', loading: false, items: [] });
    const copySku = async (sku) => {
      try { await navigator.clipboard.writeText(sku); notify.success('已复制 SKU: ' + sku); }
      catch { notify.warning('复制失败，请手动复制: ' + sku); }
    };
    const parsePrice = (s) => {
      if (!s) return 0;
      const n = String(s).replace(/[^\d,.]/g, '').replace(/,/g, '.');
      return parseFloat(n) || 0;
    };
    const openFollow = async (row) => {
      followDrawer.visible = true;
      followDrawer.offerId = row.offer_id;
      followDrawer.items = [];
      followDrawer.loading = true;
      try {
        const res = await axios.get('/api/ozon/follow-sellers', { params: { offer_id: row.offer_id } });
        const items = res.data?.items || [];
        // 按价格从高到低排序
        items.sort((a, b) => parsePrice(b.follower_price) - parsePrice(a.follower_price));
        followDrawer.items = items;
      } catch (e) {
        notify.error(e.response?.data?.error || e.message || '获取跟卖列表失败');
      } finally {
        followDrawer.loading = false;
      }
    };
    const collectSellers = async () => {
      collectBusy.value = true;
      try {
        const res = await axios.post('/api/ozon/patrol/collect', {}, { timeout: 300000 });
        if (res.data?.existing) {
          notify.warning('已有跟卖采集任务在跑（' + (res.data.status || 'queued') + '），请稍后再试');
        } else {
          notify.success(`已提交跟卖采集任务（${res.data?.total || '?'} 个商品）。插件会在浏览器后台逐个抓取，完成后自动入库，几分钟后刷新本页即可看到最新跟卖数。`);
        }
      } catch (e) {
        notify.error(e.response?.data?.error || e.message || '提交采集任务失败');
      } finally {
        collectBusy.value = false;
      }
    };
    const copyAllSku = async () => {
      const skus = followDrawer.items.map((s) => s.follower_sku).filter(Boolean);
      if (!skus.length) return notify.warning('没有可复制的 SKU');
      try { await navigator.clipboard.writeText(skus.join('\n')); notify.success('已复制 ' + skus.length + ' 个跟卖 SKU'); }
      catch { notify.warning('复制失败，请手动复制'); }
    };

    const repriceSelected = async () => {
      if (!selectedRows.value.length) return notify.warning('请先勾选要改价的商品');
      const items = selectedRows.value.map((r) => ({
        store_id: r.store_id,
        offer_id: r.offer_id,
        min_price_rub: r.min_price_rub,
      }));
      try {
        await (window.ElementPlus?.ElMessageBox || { confirm: async () => ({}) }).confirm?.(
          `将把勾选的 ${items.length} 个商品价格改为「市场最低价」（按汇率折成 CNY）。此操作会直接改 Ozon 售价，请确认。`,
          '确认改价', { type: 'warning', confirmButtonText: '确认改价', cancelButtonText: '取消' },
        );
      } catch (_e) { return; }
      repriceBusy.value = true;
      try {
        const res = await axios.post('/api/ozon/patrol/reprice', { items }, { timeout: 120000 });
        const results = res.data?.results || [];
        const totalOk = results.reduce((s, r) => s + (r.succeeded || 0), 0);
        const totalErr = results.reduce((s, r) => s + (r.errors?.length || 0), 0);
        notify.success(`改价完成：成功 ${totalOk} 个，失败 ${totalErr} 个`);
        selectedRows.value = [];
        await fetchPatrol();
      } catch (e) {
        notify.error(e.response?.data?.error || e.message || '改价失败');
      } finally {
        repriceBusy.value = false;
      }
    };

    const exportCsv = () => {
      if (!rows.value.length) return notify.warning('没有可导出的数据');
      const head = ['店铺', '货号(offer_id)', 'product_id', '我的价', '币种', '卡片最低价(RUB)', '价格指数值', '颜色'];
      const lines = [head];
      for (const r of rows.value) lines.push([r.store_name, r.offer_id, r.product_id, r.price, r.currency, r.min_price_rub, r.price_index_value, colorText(r.color)]);
      const csv = '\uFEFF' + lines.map((l) => l.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `ozon-patrol-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    };

    Vue.onMounted(() => { fetchStores().finally(() => fetchPatrol()); });

    return {
      loading, hasFetched, rows, pagination, colorFilter, colorOptions, counts, stores, currentStoreId,
      scannedAt, scannedText, colorText, colorTag, fetchPatrol, changeStore, exportCsv,
      selectedRows, repriceBusy, onSelectionChange, repriceSelected,
      followDrawer, openFollow, copySku, copyAllSku,
      collectBusy, collectSellers,
    };
  },
  template: `
    <div>
      <div class="erp-toolbar">
        <div>
          <h1 class="erp-workbench-title">巡查跟卖</h1>
          <div class="erp-muted">扫描 Ozon 商品价格指数，找出「被压价」商品（你的价高于市场最低价）。数据缓存 10 分钟。</div>
        </div>
        <div style="display:flex; gap:8px">
          <el-button size="large" :loading="loading" @click="fetchPatrol">
            <el-icon><RefreshRight /></el-icon><span>巡查</span>
          </el-button>
          <el-button size="large" type="primary" plain :loading="collectBusy" @click="collectSellers">
            <el-icon><Connection /></el-icon><span>刷新跟卖数据</span>
          </el-button>
          <el-button size="large" type="danger" disabled>
            <el-icon><PriceTag /></el-icon><span>一键改价到最低价（已禁用）</span>
          </el-button>
          <el-button size="large" type="primary" @click="exportCsv">
            <el-icon><Download /></el-icon><span>导出当前页</span>
          </el-button>
        </div>
      </div>

      <div class="erp-filter-row" style="gap:12px; flex-wrap:wrap">
        <el-select v-model="currentStoreId" size="large" style="width:200px" placeholder="选择店铺" @change="changeStore">
          <el-option v-for="s in stores" :key="s.id" :label="s.name" :value="s.id" />
        </el-select>
        <el-radio-group v-model="colorFilter" size="large" @change="() => { pagination.currentPage = 1; fetchPatrol(); }">
          <el-radio-button v-for="opt in colorOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</el-radio-button>
        </el-radio-group>
      </div>

      <div style="margin:12px 0; display:flex; gap:14px; flex-wrap:wrap">
        <span style="font-size:13px; color:#64748b">被压价 <b style="color:#dc2626">{{ counts.red + counts.yellow }}</b>（不利 {{ counts.red }} / 中等 {{ counts.yellow }}）</span>
        <span style="font-size:13px; color:#64748b">有利 <b style="color:#16a34a">{{ counts.green }}</b></span>
        <span style="font-size:13px; color:#64748b">无指数 {{ counts.no_index }}</span>
        <span style="font-size:13px; color:#94a3b8">上次巡查：{{ scannedText }}</span>
      </div>

      <el-table :data="rows" v-loading="loading" border size="large"
        element-loading-text="正在巡查（首次扫描约 1~3 分钟）..."
        :empty-text="hasFetched ? '暂无数据' : '点击「巡查」开始扫描'" style="border-radius:8px; overflow:hidden"
        @selection-change="onSelectionChange">
        <el-table-column type="selection" width="48" />
        <el-table-column label="店铺" width="150" show-overflow-tooltip>
          <template #default="{ row }">{{ row.store_name }}</template>
        </el-table-column>
        <el-table-column label="货号 (offer_id)" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">{{ row.offer_id }}</template>
        </el-table-column>
        <el-table-column label="product_id" width="130">
          <template #default="{ row }">{{ row.product_id }}</template>
        </el-table-column>
        <el-table-column label="我的价" width="110" align="right">
          <template #default="{ row }">{{ row.price }} <span style="color:#94a3b8">{{ row.currency }}</span></template>
        </el-table-column>
        <el-table-column label="卡片最低价(RUB)" width="140" align="right">
          <template #default="{ row }">{{ row.min_price_rub || '-' }}</template>
        </el-table-column>
        <el-table-column label="价格指数值" width="110" align="right">
          <template #default="{ row }">{{ row.price_index_value || '-' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="colorTag(row.color)" effect="light">{{ colorText(row.color) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="跟卖" width="110" align="center">
          <template #default="{ row }">
            <el-button v-if="row.follow_count" link type="danger" @click="openFollow(row)">{{ row.follow_count }} 个</el-button>
            <span v-else style="color:#cbd5e1">0</span>
          </template>
        </el-table-column>
      </el-table>

      <div style="display:flex; justify-content:flex-end; margin-top:14px">
        <el-pagination
          v-model:current-page="pagination.currentPage"
          v-model:page-size="pagination.pageSize"
          :total="pagination.total"
          :page-sizes="[100, 200, 500]"
          layout="total, sizes, prev, pager, next"
          @size-change="fetchPatrol"
          @current-change="fetchPatrol" />
      </div>

      <el-drawer v-model="followDrawer.visible" title="跟卖卖家列表" size="560px" append-to-body destroy-on-close>
        <template #header>
          <div style="display:flex; align-items:center; justify-content:space-between">
            <b>跟卖卖家列表</b>
            <el-button size="small" type="primary" plain @click="copyAllSku">复制全部 SKU</el-button>
          </div>
        </template>
        <div style="font-size:12px; color:#94a3b8; margin-bottom:10px">货号：{{ followDrawer.offerId }}</div>
        <el-table :data="followDrawer.items" v-loading="followDrawer.loading" size="small" border max-height="600">
          <el-table-column label="跟卖 SKU" min-width="140">
            <template #default="{ row }">
              <span style="font-family:monospace">{{ row.follower_sku || '-' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="卖家名" min-width="120" show-overflow-tooltip>
            <template #default="{ row }">{{ row.follower_name || '-' }}</template>
          </el-table-column>
          <el-table-column label="价格" width="90" align="right">
            <template #default="{ row }">{{ row.follower_price || '-' }}</template>
          </el-table-column>
          <el-table-column label="操作" width="80" align="center">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="copySku(row.follower_sku)">复制</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-drawer>
    </div>
  `,
};
