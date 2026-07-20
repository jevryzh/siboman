window.OrderListView = {
  setup() {
    const orders = Vue.ref([]);
    const loading = Vue.ref(false);
    // Ozon v3/posting/fbs/list 严格要求小写 status alias
    const activeTab = Vue.ref('awaiting_packaging');
    const pagination = Vue.reactive({ currentPage: 1, pageSize: 20, total: 0 });
    const selectedOrders = Vue.ref([]);
    const notes = Vue.reactive({});
    const batchLoading = Vue.ref(false);
    const noteDialog = Vue.reactive({ visible: false, posting_number: '', note: '', saving: false });

    // v0.3.5: 时窗筛选 (Ozon 限制窗口 ≤ 1 年)
    const now = new Date();
    const past30 = new Date(now.getTime() - 30 * 86400e3);
    const dateRange = Vue.ref([past30.toISOString().slice(0,10), now.toISOString().slice(0,10)]);
    const rangeShortcuts = [
      { text: '近 30 天', value: () => { const e = new Date(); const s = new Date(e - 30*86400e3); return [s, e]; } },
      { text: '近 90 天', value: () => { const e = new Date(); const s = new Date(e - 90*86400e3); return [s, e]; } },
      { text: '近 6 个月', value: () => { const e = new Date(); const s = new Date(e - 180*86400e3); return [s, e]; } },
      { text: '近 1 年', value: () => { const e = new Date(); const s = new Date(e - 360*86400e3); return [s, e]; } },
    ];

    // v0.3.3 详情抽屉 & 发货对话框
    const detailDrawer = Vue.reactive({ visible: false, loading: false, order: null });
    const shipDialog = Vue.reactive({ visible: false, loading: false, posting_number: '', products: [] });

    // 动态取店铺 ID
    const getStoreId = () => {
      const raw = window.getCurrentStoreId ? window.getCurrentStoreId() : (localStorage.getItem('currentStoreId') || '');
      return String(raw || '').split(',').map(value => value.trim()).find(Boolean) || '';
    };

    const notify = {
      success: (m) => (window.ElementPlus?.ElMessage || console).success?.(m),
      warning: (m) => (window.ElementPlus?.ElMessage || console).warning?.(m),
      error: (m) => (window.ElementPlus?.ElMessage || console).error?.(m),
    };

    const statusTabs = [
      { label: '全部', value: 'all' },
      { label: '待备货', value: 'awaiting_packaging' },
      { label: '备货中', value: 'awaiting_deliver' },
      { label: '已发货', value: 'delivering' },
      { label: '已送达', value: 'delivered' },
      { label: '已取消', value: 'cancelled' },
      { label: '争议中', value: 'arbitration' },
    ];

    const statusTagType = (s) => ({
      awaiting_packaging: 'warning',
      awaiting_deliver: 'primary',
      delivering: 'success',
      delivered: 'success',
      cancelled: 'danger',
      arbitration: 'danger',
      dispute: 'danger',
    }[s] || 'info');
    const statusText = (s) => ({
      awaiting_packaging: '待备货', awaiting_deliver: '备货中', delivering: '运输中',
      driver_pickup: '配送员取件', delivered: '已送达', cancelled: '已取消',
      arbitration: '争议中', dispute: '争议中',
    }[s] || s || '-');

    const fetchOrders = async () => {
      const sid = getStoreId();
      if (!sid) return;
      loading.value = true;
      try {
        const [sinceD, toD] = dateRange.value || [];
        const since = sinceD ? new Date(sinceD).toISOString() : undefined;
        const to = toD ? new Date(toD + 'T23:59:59').toISOString() : undefined;
        const res = await axios.post('/api/seller/orders', {
          store_id: sid,
          status: activeTab.value,
          since, to,
          limit: pagination.pageSize,
          offset: (pagination.currentPage - 1) * pagination.pageSize,
        });
        orders.value = res.data.orders || [];
        pagination.total = res.data.total || orders.value.length;
        const numbers = orders.value.map((row) => row.posting_number).filter(Boolean);
        if (numbers.length) {
          const noteRes = await axios.get('/api/seller/orders/notes', { params: { store_id: sid, numbers: numbers.join(',') } });
          for (const key of Object.keys(notes)) delete notes[key];
          Object.assign(notes, noteRes.data.notes || {});
        }
      } catch (e) {
        const msg = e.response?.data?.payload?.message || e.response?.data?.error || e.message;
        notify.error('获取订单失败: ' + msg);
      } finally {
        loading.value = false;
      }
    };

    // v0.3.3 订单详情
    const openDetail = async (row) => {
      detailDrawer.visible = true;
      detailDrawer.loading = true;
      detailDrawer.order = null;
      try {
        const res = await axios.post('/api/seller/orders/detail', {
          store_id: getStoreId(),
          posting_number: row.posting_number,
        });
        detailDrawer.order = res.data.order;
      } catch (e) {
        notify.error('获取详情失败: ' + (e.response?.data?.error || e.message));
      } finally {
        detailDrawer.loading = false;
      }
    };

    // v0.3.3 一键发货 (整单)
    const openShipDialog = (row) => {
      if (row.status !== 'awaiting_packaging' && row.status !== 'awaiting_deliver') {
        return notify.warning('当前状态无法发货');
      }
      shipDialog.posting_number = row.posting_number;
      shipDialog.products = (row.products || []).map(p => ({
        product_id: p.sku,
        offer_id: p.offer_id,
        name: p.name,
        quantity: p.quantity,
      }));
      shipDialog.visible = true;
    };
    const confirmShip = async () => {
      shipDialog.loading = true;
      try {
        await axios.post('/api/seller/orders/ship', {
          store_id: getStoreId(),
          posting_number: shipDialog.posting_number,
          packages: [{
            products: shipDialog.products.map(p => ({
              product_id: Number(p.product_id),
              quantity: Number(p.quantity),
            })),
          }],
        });
        notify.success('发货指令已下发');
        shipDialog.visible = false;
        fetchOrders();
      } catch (e) {
        notify.error('发货失败: ' + (e.response?.data?.payload?.message || e.response?.data?.error || e.message));
      } finally {
        shipDialog.loading = false;
      }
    };

    const onSelectionChange = (rows) => { selectedOrders.value = rows || []; };
    const openNoteDialog = (row) => {
      noteDialog.posting_number = row.posting_number;
      noteDialog.note = notes[row.posting_number]?.note || '';
      noteDialog.visible = true;
    };
    const saveNote = async () => {
      noteDialog.saving = true;
      try {
        const res = await axios.post(`/api/seller/orders/${encodeURIComponent(noteDialog.posting_number)}/note`, {
          store_id: getStoreId(), note: noteDialog.note,
        });
        notes[noteDialog.posting_number] = res.data.note;
        noteDialog.visible = false;
        notify.success('订单备注已保存');
      } catch (e) { notify.error('备注保存失败: ' + (e.response?.data?.error || e.message)); }
      finally { noteDialog.saving = false; }
    };

    const exportOrders = async () => {
      const [sinceD, toD] = dateRange.value || [];
      try {
        const res = await axios.post('/api/seller/orders/export', {
          store_id: getStoreId(),
          status: activeTab.value === 'all' ? '' : activeTab.value,
          since: sinceD ? new Date(sinceD).toISOString() : undefined,
          to: toD ? new Date(toD + 'T23:59:59').toISOString() : undefined,
          limit: 1000,
        }, { responseType: 'blob' });
        const url = URL.createObjectURL(res.data);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ozon-orders-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) { notify.error('导出失败: ' + (e.response?.data?.error || e.message)); }
    };

    const printLabels = async (rows = selectedOrders.value) => {
      const numbers = (rows || []).map(row => row.posting_number).filter(Boolean).slice(0, 50);
      if (!numbers.length) return notify.warning('请先选择订单');
      batchLoading.value = true;
      try {
        const response = await axios.post('/api/seller/orders/labels', { store_id: getStoreId(), posting_numbers: numbers }, { responseType: 'blob' });
        const url = URL.createObjectURL(new Blob([response.data], { type: response.headers['content-type'] || 'application/pdf' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = `ozon-labels-${new Date().toISOString().slice(0, 10)}.pdf`; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        notify.success(`已生成 ${numbers.length} 个订单的面单`);
      } catch (e) {
        let message = e.message;
        if (e.response?.data instanceof Blob) { try { message = JSON.parse(await e.response.data.text()).error || message; } catch {} }
        notify.error('面单生成失败: ' + message);
      } finally { batchLoading.value = false; }
    };

    const batchShip = async () => {
      const eligible = selectedOrders.value.filter((row) => ['awaiting_packaging', 'awaiting_deliver'].includes(row.status));
      if (!eligible.length) return notify.warning('所选订单中没有可发货订单');
      try {
        await window.ElementPlus.ElMessageBox.confirm(
          `将对 ${eligible.length} 个订单执行不可逆的发货操作，请确认商品已经完成备货。`,
          '批量发货确认',
          { type: 'warning', confirmButtonText: '确认发货', cancelButtonText: '取消' },
        );
      } catch { return; }
      batchLoading.value = true;
      let succeeded = 0;
      const errors = [];
      for (const row of eligible) {
        try {
          await axios.post('/api/seller/orders/ship', {
            store_id: getStoreId(), posting_number: row.posting_number,
            packages: [{ products: (row.products || []).map((product) => ({ product_id: Number(product.sku), quantity: Number(product.quantity || 1) })) }],
          });
          succeeded++;
        } catch (e) { errors.push(`${row.posting_number}: ${e.response?.data?.error || e.message}`); }
      }
      batchLoading.value = false;
      if (errors.length) notify.warning(`成功 ${succeeded} 单，失败 ${errors.length} 单`); else notify.success(`已提交 ${succeeded} 个订单`);
      selectedOrders.value = [];
      fetchOrders();
    };

    const deadlineInfo = (row) => {
      if (!['awaiting_packaging', 'awaiting_deliver'].includes(row.status)) return { text: '-', urgent: false };
      const raw = row.shipment_date || row.delivering_date || '';
      if (!raw) return { text: '-', urgent: false };
      const ms = new Date(raw).getTime() - Date.now();
      if (!Number.isFinite(ms)) return { text: '-', urgent: false };
      if (ms <= 0) return { text: '已超时', urgent: true };
      const hours = Math.floor(ms / 3600000);
      const minutes = Math.floor((ms % 3600000) / 60000);
      return { text: `${hours}小时${minutes}分`, urgent: ms <= 2 * 3600000 };
    };

    const onShopChanged = () => {
      pagination.currentPage = 1;
      orders.value = [];
      selectedOrders.value = [];
      pagination.total = 0;
      fetchOrders();
    };
    window.addEventListener('shop-changed', onShopChanged);
    Vue.onBeforeUnmount(() => window.removeEventListener('shop-changed', onShopChanged));

    Vue.onMounted(fetchOrders);

    return {
      orders, loading, activeTab, statusTabs, pagination,
      selectedOrders, notes, batchLoading, noteDialog,
      detailDrawer, shipDialog,
      fetchOrders, openDetail, openShipDialog, confirmShip, statusTagType, statusText,
      onSelectionChange, openNoteDialog, saveNote, exportOrders, printLabels, batchShip, deadlineInfo,
      // v0.3.5 时窗
      dateRange, rangeShortcuts,
    };
  },
  template: `
    <div class="order-list-v3">
      <el-card>
        <template #header>
          <div style="display:flex; justify-content:space-between; align-items:center">
            <div style="display:flex; align-items:center; gap:12px">
              <span style="font-weight:bold">订单管理 (v0.3.5)</span>
              <el-tag size="small" type="info">共 {{ pagination.total }} 单</el-tag>
            </div>
            <div style="display:flex; align-items:center; gap:10px">
              <el-date-picker
                v-model="dateRange"
                type="daterange"
                value-format="YYYY-MM-DD"
                start-placeholder="起始日期"
                end-placeholder="结束日期"
                :shortcuts="rangeShortcuts"
                size="small"
                @change="() => { pagination.currentPage=1; fetchOrders(); }" />
              <el-button size="small" @click="exportOrders">导出订单</el-button>
              <el-button type="primary" size="small" @click="fetchOrders">刷新</el-button>
            </div>
          </div>
        </template>

        <el-tabs v-model="activeTab" @tab-change="() => { pagination.currentPage = 1; fetchOrders(); }">
          <el-tab-pane v-for="tab in statusTabs" :key="tab.value" :label="tab.label" :name="tab.value" />
        </el-tabs>

        <div v-if="selectedOrders.length" style="display:flex; justify-content:space-between; align-items:center; padding:10px 12px; margin-bottom:10px; background:#ecf5ff; border:1px solid #b3d8ff">
          <span style="font-size:13px">已选择 {{ selectedOrders.length }} 个订单</span>
          <div><el-button type="primary" size="small" :loading="batchLoading" @click="printLabels()">批量面单</el-button><el-button type="warning" size="small" :loading="batchLoading" @click="batchShip">批量发货</el-button><el-button size="small" @click="exportOrders">导出当前筛选</el-button></div>
        </div>

        <el-table :data="orders" v-loading="loading" stripe border size="small" @selection-change="onSelectionChange">
          <el-table-column type="selection" width="44" :selectable="(row) => row.status !== 'cancelled'" />
          <el-table-column label="货件单号" prop="posting_number" width="180" fixed="left" />
          <el-table-column label="下单时间" width="160">
            <template #default="{ row }">
              <span style="font-size:12px">{{ (row.in_process_at || row.created_at || '').replace('T',' ').slice(0,19) }}</span>
            </template>
          </el-table-column>

          <!-- v0.3.3 商品列: 每行带图 + 名称 + 数量 -->
          <el-table-column label="商品清单" min-width="320">
            <template #default="{ row }">
              <div v-for="p in row.products" :key="p.sku" style="display:flex; align-items:center; gap:8px; margin-bottom:6px">
                <el-image :src="p.image" style="width:36px; height:36px; border-radius:4px; flex-shrink:0"
                          fit="cover" preview-teleported :preview-src-list="p.image ? [p.image] : []">
                  <template #error>
                    <div style="width:36px; height:36px; background:#f5f7fa; display:flex; align-items:center; justify-content:center">
                      <el-icon color="#c0c4cc"><Picture /></el-icon>
                    </div>
                  </template>
                </el-image>
                <div style="flex:1; min-width:0">
                  <div style="font-size:12px; color:#409eff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">{{ p.name }}</div>
                  <div style="font-size:11px; color:#999">
                    <code>{{ p.offer_id }}</code> · x <b>{{ p.quantity }}</b>
                    <a v-if="p.source_url_1688" :href="p.source_url_1688" target="_blank" rel="noopener noreferrer" style="margin-left:8px">1688 采购</a>
                  </div>
                </div>
              </div>
            </template>
          </el-table-column>

          <!-- v0.3.3 金额显示: CNY 主 + RUB 辅 -->
          <el-table-column label="订单金额" width="150" align="right">
            <template #default="{ row }">
              <div style="font-weight:bold; font-size:14px; color:#e6a23c">
                ¥ {{ Number(row.total_cny || 0).toFixed(2) }}
              </div>
              <div style="font-size:11px; color:#999">
                (₽ {{ Number(row.total_rub || 0).toFixed(2) }})
              </div>
            </template>
          </el-table-column>

          <el-table-column label="预估佣金" width="120" align="right">
            <template #default="{ row }">
              <div style="font-size:12px; color:#f56c6c">- ¥ {{ Number(row.commission_cny || 0).toFixed(2) }}</div>
            </template>
          </el-table-column>

          <el-table-column label="预估到手" width="130" align="right">
            <template #default="{ row }">
              <div style="font-weight:bold; color:#67c23a">¥ {{ Number(row.payout_cny || 0).toFixed(2) }}</div>
            </template>
          </el-table-column>

          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag size="small" :type="statusTagType(row.status)">{{ statusText(row.status) }}</el-tag>
            </template>
          </el-table-column>

          <el-table-column label="发货剩余" width="110">
            <template #default="{ row }"><span :style="{ color: deadlineInfo(row).urgent ? '#f56c6c' : '#606266', fontWeight: deadlineInfo(row).urgent ? 'bold' : 'normal' }">{{ deadlineInfo(row).text }}</span></template>
          </el-table-column>

          <el-table-column label="备注" min-width="150">
            <template #default="{ row }"><span v-if="notes[row.posting_number]?.note" style="font-size:12px">{{ notes[row.posting_number].note }}</span><span v-else style="color:#c0c4cc">-</span></template>
          </el-table-column>

          <el-table-column label="操作" width="190" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="openDetail(row)">详情</el-button>
              <el-button link size="small" @click="openNoteDialog(row)">备注</el-button>
              <el-button v-if="row.status !== 'cancelled'" link type="primary" size="small" @click="printLabels([row])">面单</el-button>
              <el-button v-if="row.status === 'awaiting_packaging' || row.status === 'awaiting_deliver'"
                         link type="warning" size="small" @click="openShipDialog(row)">发货</el-button>
            </template>
          </el-table-column>
        </el-table>

        <!-- v0.3.4: sticky 分页 -->
        <div style="position:sticky; bottom:0; left:0; right:0; margin:20px -20px -20px; padding:12px 20px; background:#fff; border-top:1px solid #ebeef5; z-index:10; display:flex; justify-content:flex-end; box-shadow:0 -2px 6px rgba(0,0,0,0.04)">
          <el-pagination
            v-model:current-page="pagination.currentPage"
            v-model:page-size="pagination.pageSize"
            :total="pagination.total"
            :page-sizes="[20, 50, 100]"
            layout="total, sizes, prev, pager, next"
            @size-change="fetchOrders"
            @current-change="fetchOrders"
          />
        </div>
      </el-card>

      <el-dialog v-model="noteDialog.visible" title="订单备注" width="480px">
        <el-input v-model="noteDialog.note" type="textarea" :rows="5" maxlength="2000" show-word-limit placeholder="例如：加固包装、赠送贴纸、采购注意事项" />
        <template #footer><el-button @click="noteDialog.visible=false">取消</el-button><el-button type="primary" :loading="noteDialog.saving" @click="saveNote">保存备注</el-button></template>
      </el-dialog>

      <!-- v0.3.3 订单详情抽屉 -->
      <el-drawer v-model="detailDrawer.visible" title="订单详情" size="720px" destroy-on-close>
        <div v-loading="detailDrawer.loading">
          <template v-if="detailDrawer.order">
            <el-descriptions :column="2" border size="small">
              <el-descriptions-item label="货件单号">{{ detailDrawer.order.posting_number }}</el-descriptions-item>
              <el-descriptions-item label="状态">
                <el-tag size="small" :type="statusTagType(detailDrawer.order.status)">{{ statusText(detailDrawer.order.status) }}</el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="下单时间">{{ (detailDrawer.order.in_process_at || '').replace('T',' ').slice(0,19) }}</el-descriptions-item>
              <el-descriptions-item label="发货截止">{{ (detailDrawer.order.shipment_date || '').replace('T',' ').slice(0,19) }}</el-descriptions-item>
              <el-descriptions-item label="订单总额">¥ {{ Number(detailDrawer.order.total_cny || 0).toFixed(2) }} <span style="color:#999">(₽ {{ Number(detailDrawer.order.total_rub || 0).toFixed(2) }})</span></el-descriptions-item>
              <el-descriptions-item label="配送方式">{{ detailDrawer.order.tpl_integration_type || '-' }}</el-descriptions-item>
            </el-descriptions>

            <el-divider content-position="left">商品清单 ({{ (detailDrawer.order.products || []).length }})</el-divider>
            <el-table :data="detailDrawer.order.products || []" size="small" border stripe>
              <el-table-column label="图" width="60">
                <template #default="{ row }">
                  <el-image :src="row.image" style="width:40px; height:40px; border-radius:4px" fit="cover" preview-teleported />
                </template>
              </el-table-column>
              <el-table-column label="商品" min-width="220">
                <template #default="{ row }">
                  <div style="font-size:12px">{{ row.local_name || row.name }}</div>
                  <div style="font-size:11px; color:#999">
                    货号 <code>{{ row.offer_id }}</code> · SKU {{ row.sku }}
                  </div>
                  <a v-if="row.source_url_1688" :href="row.source_url_1688" target="_blank" rel="noopener noreferrer" style="font-size:11px">1688 采购 · ¥{{ Number(row.purchase_price_cny || 0).toFixed(2) }}</a>
                </template>
              </el-table-column>
              <el-table-column label="数量" prop="quantity" width="70" align="center" />
              <el-table-column label="单价(¥)" width="100" align="right">
                <template #default="{ row }">
                  ¥ {{ Number(row.price_cny || 0).toFixed(2) }}
                </template>
              </el-table-column>
              <el-table-column label="小计(¥)" width="110" align="right">
                <template #default="{ row }">
                  <b>¥ {{ (Number(row.price_cny || 0) * Number(row.quantity || 1)).toFixed(2) }}</b>
                </template>
              </el-table-column>
            </el-table>

            <template v-if="detailDrawer.order.customer">
              <el-divider content-position="left">收货信息</el-divider>
              <el-descriptions :column="1" border size="small">
                <el-descriptions-item label="收货人">{{ detailDrawer.order.customer?.name || '-' }}</el-descriptions-item>
                <el-descriptions-item label="联系电话">{{ detailDrawer.order.customer?.phone || '-' }}</el-descriptions-item>
                <el-descriptions-item label="收货地址">
                  {{ detailDrawer.order.customer?.address?.region }}
                  {{ detailDrawer.order.customer?.address?.city }}
                  {{ detailDrawer.order.customer?.address?.address_tail }}
                </el-descriptions-item>
              </el-descriptions>
            </template>
          </template>
        </div>
        <template #footer>
          <el-button @click="detailDrawer.visible = false">关闭</el-button>
        </template>
      </el-drawer>

      <!-- v0.3.3 发货对话框 -->
      <el-dialog v-model="shipDialog.visible" title="Ozon 一键发货" width="520px" destroy-on-close>
        <div style="font-size:13px; margin-bottom:10px">
          货件号: <b>{{ shipDialog.posting_number }}</b>
        </div>
        <el-table :data="shipDialog.products" size="small" border>
          <el-table-column label="商品" prop="name" show-overflow-tooltip />
          <el-table-column label="货号" prop="offer_id" width="140" />
          <el-table-column label="发货数量" width="120">
            <template #default="{ row }">
              <el-input-number v-model="row.quantity" :min="1" size="small" style="width:100px" />
            </template>
          </el-table-column>
        </el-table>
        <template #footer>
          <el-button @click="shipDialog.visible = false">取消</el-button>
          <el-button type="warning" :loading="shipDialog.loading" @click="confirmShip">
            确认发货 (POST /v3/posting/fbs/ship)
          </el-button>
        </template>
      </el-dialog>
    </div>
  `
};
