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
        const params = new URLSearchParams();
        if (filter.sku) params.set('sku', filter.sku);
        if (filter.status && filter.status !== 'all') params.set('status', filter.status);
        if (filter.start_date) params.set('start_date', filter.start_date);
        if (filter.end_date) params.set('end_date', filter.end_date);
        params.set('limit', '100');
        const r = await axios.get(`/api/seller/listing-history?${params}`);
        if (r.data.success) {
          items.value = r.data.items;
          total.value = r.data.total;
          stats.value = r.data.stats;
        }
      } catch (e) {
        console.error('[listing-history]', e);
      } finally {
        loading.value = false;
      }
    };

    const onQuery = () => fetchList();
    const onReset = () => {
      filter.sku = '';
      filter.status = 'all';
      filter.start_date = '';
      filter.end_date = '';
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
        imported: { label: '已完成', bg: '#f0f9eb', color: '#67c23a' },
        failed: { label: '失败', bg: '#fef0f0', color: '#f56c6c' },
        processing: { label: '处理中', bg: '#fdf6ec', color: '#e6a23c' },
        pending: { label: '处理中', bg: '#fdf6ec', color: '#e6a23c' },
      };
      return map[s] || { label: s, bg: '#f4f4f5', color: '#909399' };
    };

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

    return {
      loading, items, total, stats, filter, selectedIds,
      fetchList, onQuery, onReset, deleteOne, batchDelete,
      statusBadge, fmtMoney, fmtDate, onSelectionChange,
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
            导入批次列表 <span style="font-size:12px; color:#909399; font-weight:400">共 {{ total }} 条</span>
            <span v-if="selectedIds.length" style="margin-left:12px; font-size:12px; color:#409eff">已选 {{ selectedIds.length }} 条</span>
          </div>
          <div style="display:flex; gap:8px">
            <el-button v-if="selectedIds.length" type="danger" size="small" @click="batchDelete" icon="Delete">批量删除</el-button>
            <el-button size="small" @click="fetchList" icon="Refresh" :loading="loading">刷新</el-button>
          </div>
        </div>

        <el-table :data="items" v-loading="loading" stripe border style="width:100%" @selection-change="onSelectionChange" empty-text="暂无上架记录, 去批量跟卖页发起一次试试">
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
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <span :style="{ background: statusBadge(row.status).bg, color: statusBadge(row.status).color, padding: '3px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: 600 }">
                {{ statusBadge(row.status).label }}
              </span>
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
              <el-popover v-if="row.errors_json && row.errors_json.length" placement="top" :width="380" trigger="hover">
                <template #reference>
                  <span style="color:#f56c6c; cursor:help; font-size:12px">{{ row.errors_json[0]?.message?.slice(0, 30) || row.errors_json[0]?.code || '查看' }}<span v-if="row.errors_json.length > 1" style="color:#909399"> (+{{ row.errors_json.length - 1 }})</span></span>
                </template>
                <div style="font-size:12px; max-height:200px; overflow:auto">
                  <div v-for="(e, i) in row.errors_json" :key="i" style="padding:6px 0; border-bottom:1px dashed #eee">
                    <div v-if="e.code" style="color:#909399; font-family:monospace">{{ e.code }}</div>
                    <div>{{ e.message || e.description }}</div>
                  </div>
                </div>
              </el-popover>
              <span v-else style="color:#c0c4cc; font-size:12px">-</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="80" fixed="right">
            <template #default="{ row }">
              <el-button type="danger" link size="small" @click="deleteOne(row)" icon="Delete">删除</el-button>
            </template>
          </el-table-column>
        </el-table>

        <!-- 提示 -->
        <div style="padding:12px 16px; font-size:11px; color:#909399; display:flex; align-items:center; gap:8px">
          <span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:#10b981; animation:pulse 2s infinite"></span>
          每 30s 自动刷新 + 后台每 60s 调 Ozon 同步真实状态 · task_id 在 "最后轮询" 列反映 polling 活性
        </div>
      </div>
    </div>
  `,
};