/**
 * 上架记录页 (仿 MY ERP /ozon/products/import-history/)
 * 路由: #/listing-history
 * - 4 KPI 卡片 (累计批次 / 今日上品 / 处理中 / 成功率)
 * - 筛选: SKU 搜索 + 状态 (全部/已完成/部分成功/处理中/失败) + 日期范围
 * - 表格: 图+标题 / 源 SKU / 店铺 / 状态 / 售价 / 时间 / 操作
 * - 自动 30s 刷新 (后台 polling 在跑)
 * - 单删 + 批量删除
 */
window.ListingHistoryView = {
  setup() {
    const loading = Vue.ref(false);
    const items = Vue.ref([]);
    const total = Vue.ref(0);
    const stats = Vue.ref({ total: 0, imported: 0, failed: 0, processing: 0, today: 0, success_rate: 0 });
    const selectedIds = Vue.ref([]);
    const pagination = Vue.reactive({ currentPage: 1, pageSize: 50 });
    const detailDialog = Vue.reactive({ visible: false, row: null });
    const syncingTaskId = Vue.ref('');
    const retryingId = Vue.ref('');
    const exporting = Vue.ref(false);
    const lastRefreshAt = Vue.ref('');
    const getStoreId = () => {
      const raw = window.getCurrentStoreId ? window.getCurrentStoreId() : (localStorage.getItem('currentStoreId') || '');
      return String(raw || '').split(',').map(value => value.trim()).find(Boolean) || '';
    };

    const filter = Vue.reactive({
      sku: '',
      status: 'all',
      start_date: '',
      end_date: '',
    });

    let refreshTimer = null;

    const fetchList = async () => {
      loading.value = true;
      try {
        const params = {
          sku: filter.sku || undefined,
          status: filter.status && filter.status !== 'all' ? filter.status : undefined,
          start_date: filter.start_date || undefined,
          end_date: filter.end_date || undefined,
          store_id: getStoreId() || undefined,
          limit: pagination.pageSize,
          offset: (pagination.currentPage - 1) * pagination.pageSize,
        };
        const r = await axios.get('/api/seller/listing-history', { params });
        if (r.data.success) {
          items.value = r.data.items;
          total.value = r.data.total;
          stats.value = r.data.stats;
          lastRefreshAt.value = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        }
      } catch (e) {
        console.error('[listing-history]', e);
      } finally {
        loading.value = false;
      }
    };

    const onQuery = () => { pagination.currentPage = 1; fetchList(); };
    const onReset = () => {
      filter.sku = '';
      filter.status = 'all';
      filter.start_date = '';
      filter.end_date = '';
      pagination.currentPage = 1;
      fetchList();
    };

    const deleteOne = async (row) => {
      if (!confirm(`确认删除记录?\n\n任务: ${row.task_id}\n商品: ${row.product_name?.slice(0, 40) || row.offer_id}`)) return;
      try {
        const r = await axios.delete(`/api/seller/listing-history/${row.id}`);
        if (r.data.success) {
          items.value = items.value.filter(x => x.id !== row.id);
          total.value = Math.max(0, total.value - 1);
          selectedIds.value = selectedIds.value.filter(x => x !== row.id);
        } else {
          alert('删除失败: ' + r.data.error);
        }
      } catch (e) {
        alert('删除失败: ' + e.message);
      }
    };

    const batchDelete = async () => {
      if (selectedIds.value.length === 0) return;
      if (!confirm(`确认删除选中的 ${selectedIds.value.length} 条记录?`)) return;
      let ok = 0, fail = 0;
      for (const id of selectedIds.value) {
        try {
          const r = await axios.delete(`/api/seller/listing-history/${id}`);
          if (r.data.success) ok++;
          else fail++;
        } catch { fail++; }
      }
      selectedIds.value = [];
      await fetchList();
      alert(`批量删除完成: 成功 ${ok}, 失败 ${fail}`);
    };

    const statusBadge = (s) => {
      const map = {
        imported: { label: '已完成', detail: 'Ozon 已确认创建', bg: '#f0f9eb', color: '#67c23a' },
        success: { label: '已完成', detail: 'Ozon 已确认创建', bg: '#f0f9eb', color: '#67c23a' },
        failed: { label: '失败', bg: '#fef0f0', color: '#f56c6c' },
        cancelled: { label: '已取消', detail: '任务未继续提交', bg: '#f4f4f5', color: '#909399' },
        partial_success: { label: '部分成功', detail: '部分商品需处理后重试', bg: '#fff7ed', color: '#ea580c' },
        queued: { label: '处理中', detail: '已排队，等待创建', bg: '#fdf6ec', color: '#e6a23c' },
        claimed: { label: '处理中', detail: '任务已被处理器领取', bg: '#fdf6ec', color: '#e6a23c' },
        running: { label: '处理中', detail: '正在提交 Ozon', bg: '#fdf6ec', color: '#e6a23c' },
        ozon_processing: { label: '处理中', detail: 'Ozon 正在创建商品', bg: '#fdf6ec', color: '#e6a23c' },
        processing: { label: '处理中', detail: 'Ozon 正在创建商品', bg: '#fdf6ec', color: '#e6a23c' },
        pending: { label: '处理中', detail: '等待 Ozon 返回结果', bg: '#fdf6ec', color: '#e6a23c' },
        moderating: { label: '处理中', detail: 'Ozon 审核中', bg: '#fdf6ec', color: '#e6a23c' },
      };
      return map[s] || { label: s, bg: '#f4f4f5', color: '#909399' };
    };

    const displayStatus = (row) => row.partial_success
      ? statusBadge('partial_success')
      : statusBadge(row.status);
    const firstErrorText = (row) => row.error_summary
      || row.first_error_message_zh
      || row.first_error_message
      || row.errors_json?.[0]?.message_zh
      || row.errors_json?.[0]?.message
      || row.errors_json?.[0]?.description
      || row.errors_json?.[0]?.code
      || '';
    const isProcessingStatus = (row) => ['queued', 'claimed', 'running', 'ozon_processing', 'processing', 'pending', 'moderating'].includes(String(row.status || ''));
    const canRetry = (row) => String(row.status || '') === 'failed' || String(row.status || '') === 'partial_success' || row.partial_success;

    const syncTask = async (row) => {
      if (String(row.task_id || '').startsWith('portal-')) return window.ElementPlus.ElMessage.warning('该记录由门户上架，后台会自动按货号同步');
      if (String(row.task_id || '').startsWith('batch-')) return window.ElementPlus.ElMessage.warning('该记录还在批量采集/提交中，拿到 Ozon 任务后会自动更新');
      syncingTaskId.value = row.task_id;
      try {
        const res = await axios.post('/api/seller/import/sync-task', { task_id: row.task_id, store_id: row.store_id || getStoreId() });
        window.ElementPlus.ElMessage.success(`状态已同步：${res.data.localStatus || res.data.ozonStatus || '完成'}`);
        await fetchList();
      } catch (e) { window.ElementPlus.ElMessage.error('同步失败：' + (e.response?.data?.error || e.message)); }
      finally { syncingTaskId.value = ''; }
    };
    const showDetail = (row) => { detailDialog.row = row; detailDialog.visible = true; };
    const retryTask = async (row) => {
      try {
        await window.ElementPlus.ElMessageBox.confirm(
          `将使用任务 ${row.task_id} 保存的原始商品数据重新提交到店铺「${row.store_name || '-'}」。确认继续？`,
          '重试失败的上架任务',
          { type: 'warning', confirmButtonText: '确认重试', cancelButtonText: '取消' },
        );
      } catch { return; }
      retryingId.value = row.id;
      try {
        const response = await axios.post(`/api/seller/listing-history/${row.id}/retry`);
        window.ElementPlus.ElMessage.success(`已创建重试任务 ${response.data?.task?.task_id || ''}`);
        detailDialog.visible = false;
        await fetchList();
      } catch (error) {
        window.ElementPlus.ElMessage.error('重试失败：' + (error.response?.data?.error || error.message));
      } finally { retryingId.value = ''; }
    };
    const exportHistory = async () => {
      exporting.value = true;
      try {
        const response = await axios.post('/api/seller/listing-history/export', {
          store_id: getStoreId(),
          sku: filter.sku,
          status: filter.status,
          start_date: filter.start_date,
          end_date: filter.end_date,
        }, { responseType: 'blob' });
        const url = URL.createObjectURL(response.data);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `listing-history-${new Date().toISOString().slice(0, 10)}.csv`;
        anchor.click();
        URL.revokeObjectURL(url);
      } catch (error) {
        window.ElementPlus.ElMessage.error('导出失败：' + (error.response?.data?.error || error.message));
      } finally { exporting.value = false; }
    };
    const onPageChange = () => fetchList();
    const onSizeChange = () => { pagination.currentPage = 1; fetchList(); };

    const fmtMoney = (v) => v ? '¥' + Number(v).toFixed(2) : '-';
    const fmtDate = (s) => {
      if (!s) return '-';
      const d = new Date(s);
      const pad = n => String(n).padStart(2, '0');
      return `${d.getMonth()+1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    const onSelectionChange = (rows) => {
      selectedIds.value = rows.map(r => r.id);
    };

    Vue.onMounted(() => {
      fetchList();
      // 每 30s 刷新 (后台 polling 60s, 这里兜底 30s 让状态变化更及时)
      refreshTimer = setInterval(fetchList, 30000);
    });
    Vue.onUnmounted(() => {
      if (refreshTimer) clearInterval(refreshTimer);
    });
    const onShopChanged = () => { pagination.currentPage = 1; selectedIds.value = []; fetchList(); };
    window.addEventListener('shop-changed', onShopChanged);
    Vue.onBeforeUnmount(() => window.removeEventListener('shop-changed', onShopChanged));

    return {
      loading, items, total, stats, filter, selectedIds, pagination, detailDialog, syncingTaskId, retryingId, exporting, lastRefreshAt,
      fetchList, onQuery, onReset, deleteOne, batchDelete,
      statusBadge, displayStatus, firstErrorText, isProcessingStatus, canRetry, fmtMoney, fmtDate, onSelectionChange,
      syncTask, showDetail, retryTask, exportHistory, onPageChange, onSizeChange,
    };
  },
  template: `
    <div class="listing-history-v2" style="padding:0; background:#f0f2f5; min-height:100vh">
      <!-- 4 KPI 卡片 -->
      <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:16px; padding:20px 24px 0">
        <div style="background:#fff; border-radius:10px; padding:18px 22px; box-shadow:0 1px 4px rgba(0,0,0,0.04)">
          <div style="font-size:13px; color:#909399; margin-bottom:6px">累计批次</div>
          <div style="font-size:32px; font-weight:800; color:#303133">{{ stats.total }}</div>
          <div style="font-size:11px; color:#909399; margin-top:4px">全部历史</div>
        </div>
        <div style="background:linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius:10px; padding:18px 22px; box-shadow:0 2px 8px rgba(102,126,234,0.25); color:#fff">
          <div style="font-size:13px; opacity:0.9; margin-bottom:6px">今日上品</div>
          <div style="font-size:32px; font-weight:800; line-height:1">{{ stats.today }}</div>
          <div style="font-size:11px; opacity:0.8; margin-top:4px">今日提交</div>
        </div>
        <div style="background:#fff; border-radius:10px; padding:18px 22px; box-shadow:0 1px 4px rgba(0,0,0,0.04)">
          <div style="font-size:13px; color:#909399; margin-bottom:6px">处理中</div>
          <div style="font-size:32px; font-weight:800; color:#e6a23c">{{ stats.processing }}</div>
          <div style="font-size:11px; color:#909399; margin-top:4px">Ozon 队列中</div>
        </div>
        <div style="background:#fff; border-radius:10px; padding:18px 22px; box-shadow:0 1px 4px rgba(0,0,0,0.04)">
          <div style="font-size:13px; color:#909399; margin-bottom:6px">成功率</div>
          <div style="font-size:32px; font-weight:800; color:#67c23a">{{ stats.success_rate }}<span style="font-size:18px">%</span></div>
          <div style="font-size:11px; color:#909399; margin-top:4px">基于已结束任务</div>
        </div>
      </div>

      <!-- 筛选条 -->
      <div style="background:#fff; border-radius:10px; padding:16px 20px; margin:16px 24px 0; box-shadow:0 1px 4px rgba(0,0,0,0.04); display:flex; align-items:center; gap:12px; flex-wrap:wrap">
        <el-input v-model="filter.sku" placeholder="搜索 SKU / 货号 / 标题" style="width:220px" clearable size="small" />
        <span style="font-size:12px; color:#909399">状态</span>
        <el-radio-group v-model="filter.status" size="small">
          <el-radio-button label="all">全部</el-radio-button>
          <el-radio-button label="imported">已完成</el-radio-button>
          <el-radio-button label="partial_success">部分成功</el-radio-button>
          <el-radio-button label="processing">处理中</el-radio-button>
          <el-radio-button label="failed">失败</el-radio-button>
        </el-radio-group>
        <el-date-picker v-model="filter.start_date" type="date" placeholder="开始日期" value-format="YYYY-MM-DD" size="small" style="width:140px" />
        <span style="color:#909399">→</span>
        <el-date-picker v-model="filter.end_date" type="date" placeholder="结束日期" value-format="YYYY-MM-DD" size="small" style="width:140px" />
        <div style="flex:1"></div>
        <el-button size="small" @click="onReset">重置</el-button>
        <el-button type="primary" size="small" @click="onQuery" icon="Search">查询</el-button>
      </div>

      <!-- 表格 -->
      <div style="background:#fff; border-radius:10px; padding:8px 4px; margin:16px 24px 24px; box-shadow:0 1px 4px rgba(0,0,0,0.04)">
        <div style="padding:8px 16px; display:flex; justify-content:space-between; align-items:center">
          <div style="font-size:14px; font-weight:700; color:#303133">
            上架记录列表 <span style="font-size:12px; color:#909399; font-weight:400">共 {{ total }} 条</span>
            <span v-if="selectedIds.length" style="margin-left:12px; font-size:12px; color:#409eff">已选 {{ selectedIds.length }} 条</span>
          </div>
          <div style="display:flex; gap:8px">
            <el-button v-if="selectedIds.length" type="danger" size="small" @click="batchDelete" icon="Delete">批量删除</el-button>
            <el-button size="small" :loading="exporting" @click="exportHistory">导出 CSV</el-button>
            <el-button size="small" @click="fetchList" icon="Refresh" :loading="loading">刷新</el-button>
          </div>
        </div>

        <el-table :data="items" v-loading="loading" stripe border style="width:100%" @selection-change="onSelectionChange" empty-text="暂无匹配的上架记录。可调整筛选条件；新记录会在批量上架提交后出现。">
          <el-table-column type="selection" width="44" />
          <el-table-column label="商品信息" min-width="280">
            <template #default="{ row }">
              <div style="display:flex; gap:10px; align-items:center">
                <el-image :src="row.main_image" :preview-src-list="[row.main_image]" fit="cover" style="width:48px; height:48px; border-radius:6px; flex-shrink:0; background:#f5f7fa" :initial-index="0" hide-on-click-modal>
                  <template #error>
                    <div style="width:48px; height:48px; border-radius:6px; background:#f5f7fa; display:flex; align-items:center; justify-content:center; color:#c0c4cc; font-size:20px">📦</div>
                  </template>
                </el-image>
                <div style="min-width:0; flex:1">
                  <div style="font-size:13px; color:#303133; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap" :title="row.product_name">
                    {{ row.product_name || row.offer_id }}
                  </div>
                  <div style="font-size:11px; color:#909399; margin-top:2px">货号 {{ row.offer_id }}</div>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="源 SKU" prop="offer_id" width="140">
            <template #default="{ row }">
              <span style="font-family:monospace; font-size:12px; color:#606266">{{ (row.offer_id.match(/-(\d+)$/) || ['',''])[1] || '-' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="店铺" width="140">
            <template #default="{ row }">
              <el-tag v-if="row.store_name" size="small" effect="plain">● {{ row.store_name }}</el-tag>
              <span v-else style="color:#c0c4cc">-</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="150">
            <template #default="{ row }">
              <div>
                <span :style="{ background: displayStatus(row).bg, color: displayStatus(row).color, padding: '3px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: 600 }">{{ displayStatus(row).label }}</span>
                <div v-if="displayStatus(row).detail" style="font-size:11px; color:#909399; margin-top:4px">{{ displayStatus(row).detail }}</div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="售价" width="90">
            <template #default="{ row }">{{ fmtMoney(row.price_rub) }}</template>
          </el-table-column>
          <el-table-column label="创建时间" width="150">
            <template #default="{ row }">
              <span style="font-size:12px; color:#606266">{{ fmtDate(row.created_at) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="最后轮询" width="150">
            <template #default="{ row }">
              <span style="font-size:12px; color:#909399" :title="'每 60s 后台自动同步 Ozon 真实状态'">{{ fmtDate(row.updated_at) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="Ozon 错误" min-width="200">
            <template #default="{ row }">
              <el-popover v-if="firstErrorText(row) || (row.errors_json && row.errors_json.length)" placement="top" :width="420" trigger="hover">
                <template #reference>
                  <span style="color:#f56c6c; cursor:help; font-size:12px">{{ firstErrorText(row).slice(0, 42) || '查看错误' }}<span v-if="row.errors_json && row.errors_json.length > 1" style="color:#909399"> (+{{ row.errors_json.length - 1 }})</span></span>
                </template>
                <div style="font-size:12px; max-height:200px; overflow:auto">
                  <div v-if="firstErrorText(row)" style="padding:0 0 8px; margin-bottom:4px; border-bottom:1px solid #eee; color:#b91c1c">{{ firstErrorText(row) }}</div>
                  <div v-for="(e, i) in row.errors_json" :key="i" style="padding:6px 0; border-bottom:1px dashed #eee">
                    <div v-if="e.code" style="color:#909399; font-family:monospace">{{ e.code }}</div>
                    <div>{{ e.message || e.description }}</div>
                    <div v-if="e.message_zh" style="color:#e6a23c; margin-top:3px">{{ e.message_zh }}</div>
                  </div>
                </div>
              </el-popover>
              <span v-else style="color:#c0c4cc; font-size:12px">-</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="180" fixed="right">
            <template #default="{ row }">
              <el-button type="primary" link size="small" @click="showDetail(row)">详情</el-button>
              <el-button v-if="isProcessingStatus(row)" type="warning" link size="small" :loading="syncingTaskId === row.task_id" @click="syncTask(row)">同步状态</el-button>
              <el-button v-if="canRetry(row)" type="warning" link size="small" :loading="retryingId === row.id" @click="retryTask(row)">重试</el-button>
              <el-button type="danger" link size="small" @click="deleteOne(row)" icon="Delete">删除</el-button>
            </template>
          </el-table-column>
        </el-table>

        <div style="display:flex; justify-content:flex-end; padding:14px 16px 4px">
          <el-pagination v-model:current-page="pagination.currentPage" v-model:page-size="pagination.pageSize" :total="total" :page-sizes="[20,50,100,200]" layout="total, sizes, prev, pager, next, jumper" @current-change="onPageChange" @size-change="onSizeChange" />
        </div>

        <!-- 提示 -->
        <div style="padding:12px 16px; font-size:11px; color:#909399; display:flex; align-items:center; gap:8px">
          <span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:#10b981; animation:pulse 2s infinite"></span>
          每 30s 自动刷新 + 后台每 60s 调 Ozon 同步真实状态 · 最后刷新 {{ lastRefreshAt || '-' }}
        </div>
      </div>

      <el-dialog v-model="detailDialog.visible" title="上架任务详情" width="760px">
        <template v-if="detailDialog.row">
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="任务 ID" :span="2">{{ detailDialog.row.task_id }}</el-descriptions-item>
            <el-descriptions-item label="店铺">{{ detailDialog.row.store_name || '-' }}</el-descriptions-item>
            <el-descriptions-item label="货号">{{ detailDialog.row.offer_id || '-' }}</el-descriptions-item>
            <el-descriptions-item label="状态">{{ displayStatus(detailDialog.row).label }}{{ displayStatus(detailDialog.row).detail ? ' · ' + displayStatus(detailDialog.row).detail : '' }}</el-descriptions-item>
            <el-descriptions-item label="变体">{{ detailDialog.row.variants_count || 0 }} 个，失败 {{ detailDialog.row.failed_variants_count || 0 }} 个</el-descriptions-item>
          </el-descriptions>
          <el-divider>Ozon 返回错误</el-divider>
          <el-alert v-if="firstErrorText(detailDialog.row)" type="error" :closable="false" style="margin-bottom:8px" title="错误摘要" :description="firstErrorText(detailDialog.row)" />
          <el-empty v-if="!firstErrorText(detailDialog.row) && !detailDialog.row.errors_json?.length" description="没有错误" :image-size="60" />
          <el-alert v-for="(error, index) in (detailDialog.row.errors_json || [])" :key="index" type="error" :closable="false" style="margin-bottom:8px" :title="error.message || error.description || error.code || '未知错误'" :description="[error.code ? '错误代码：' + error.code : '', error.message_zh || ''].filter(Boolean).join(' · ')" />
        </template>
        <template #footer><el-button @click="detailDialog.visible=false">关闭</el-button><el-button v-if="detailDialog.row && canRetry(detailDialog.row)" type="warning" :loading="retryingId === detailDialog.row.id" @click="retryTask(detailDialog.row)">重试上架</el-button></template>
      </el-dialog>
    </div>
  `,
};
