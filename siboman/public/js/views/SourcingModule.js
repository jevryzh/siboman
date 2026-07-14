window.SourcingModuleView = {
  setup() {
    const detectTabFromHash = () => {
      const hash = String(window.location.hash || '').toLowerCase();
      if (hash.includes('/single')) return 'single';
      if (hash.includes('/bestseller') || hash.includes('/top')) return 'bestseller';
      return 'category';
    };
    const activeTab = Vue.ref(detectTabFromHash());
    const loading = Vue.ref(false);
    const tableData = Vue.ref([]);
    const pagination = Vue.reactive({ currentPage: 1, pageSize: 20, total: 0 });
    const getStoreId = () => (window.getCurrentStoreId ? window.getCurrentStoreId() : (localStorage.getItem('currentStoreId') || ''));

    const urlsText = Vue.ref('');
    const maxCandidates = Vue.ref(5);
    const startRow = Vue.ref(1);
    const delayMin = Vue.ref(8);
    const delayMax = Vue.ref(20);
    const maxConsecutiveFailures = Vue.ref(3);
    const enable1688 = Vue.ref(true);
    const enableAI = Vue.ref(true);
    const headless = Vue.ref(false);
    const creating = Vue.ref(false);
    const currentJobId = Vue.ref(localStorage.getItem('singleSourcingJobId') || '');
    const job = Vue.ref(null);
    const collectorLoading = Vue.ref(false);
    const collectorStatus = Vue.ref({ workers: [], queue: { queued: 0, active: 0 } });
    let pollTimer = null;
    let collectorTimer = null;

    const apiError = (error) => error?.response?.data?.error || error?.message || '请求失败';

    const fetchData = async () => {
      if (activeTab.value === 'single') return;
      const sid = getStoreId();
      if (!sid) return;
      loading.value = true;
      try {
        const endpoint = activeTab.value === 'category' ? '/api/seller/analytics/categories' : '/api/seller/analytics/bestsellers';
        const res = await axios.post(endpoint, {
          store_id: sid,
          limit: pagination.pageSize,
          offset: (pagination.currentPage - 1) * pagination.pageSize,
        });

        if (activeTab.value === 'category') {
          tableData.value = (res.data.data?.result?.data || []).map(i => ({
            name: i.dimensions?.[0]?.name || '-',
            revenue: i.metrics?.[1] || 0,
            sales: i.metrics?.[0] || 0,
            returnRate: ((i.metrics?.[0] || 0) > 0 ? ((i.metrics?.[2] || 0) / i.metrics[0] * 100) : 0).toFixed(1) + '%'
          }));
        } else {
          tableData.value = res.data.data?.result?.items || [];
        }
        pagination.total = res.data.total || tableData.value.length;
      } catch (error) {
        ElementPlus.ElMessage.error(apiError(error));
      } finally {
        loading.value = false;
      }
    };

    const fetchCollectorStatus = async () => {
      collectorLoading.value = true;
      try {
        const res = await axios.get('/api/worker/status');
        collectorStatus.value = {
          workers: res.data.workers || [],
          queue: res.data.queue || { queued: 0, active: 0 },
        };
      } catch (error) {
        collectorStatus.value = { workers: [], queue: { queued: 0, active: 0 }, error: apiError(error) };
      } finally {
        collectorLoading.value = false;
      }
    };

    const canRun = Vue.computed(() => {
      const workers = collectorStatus.value.workers || [];
      return workers.some(w => w.online && w.canClaimJobs);
    });

    const jobStatusText = Vue.computed(() => {
      const j = job.value;
      if (!j) return '待开始';
      return `${j.status || '-'} · ${j.phase || ''} · ${j.processed || 0}/${j.total || 0}`;
    });

    const recentLogs = Vue.computed(() => {
      const logs = job.value?.logs || [];
      return logs.slice(-120).map(l => `[${String(l.level || 'info').toUpperCase()}] ${l.message || l}`).join('\n') || '暂无日志';
    });

    const jobResults = Vue.computed(() => job.value?.results || []);
    const isRunning = Vue.computed(() => ['queued', 'claimed', 'running', 'exporting'].includes(job.value?.status || ''));
    const isTerminal = Vue.computed(() => ['done', 'error', 'canceled'].includes(job.value?.status || ''));

    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };

    const pollJob = async () => {
      if (!currentJobId.value) return;
      try {
        const res = await axios.get(`/api/jobs/${encodeURIComponent(currentJobId.value)}`);
        job.value = res.data.job || null;
        if (job.value && ['done', 'error', 'canceled'].includes(job.value.status)) {
          stopPolling();
          localStorage.removeItem('singleSourcingJobId');
        }
      } catch (error) {
        stopPolling();
        ElementPlus.ElMessage.error(apiError(error));
      }
    };

    const startPolling = () => {
      stopPolling();
      pollJob();
      pollTimer = setInterval(pollJob, 1500);
    };

    const restoreActiveJob = async () => {
      const savedId = localStorage.getItem('singleSourcingJobId') || '';
      if (savedId) {
        currentJobId.value = savedId;
        await pollJob();
        if (job.value && !['done', 'error', 'canceled'].includes(job.value.status)) startPolling();
        return;
      }
      try {
        const history = await axios.get('/api/history');
        const activeStatuses = new Set(['queued', 'claimed', 'running', 'exporting']);
        const item = (history.data.items || []).find(it => it.kind === 'run' && activeStatuses.has(it.status));
        if (!item?.id) return;
        currentJobId.value = item.id;
        localStorage.setItem('singleSourcingJobId', item.id);
        startPolling();
      } catch {}
    };

    const startSingleSourcing = async () => {
      const text = urlsText.value.trim();
      if (!text) {
        ElementPlus.ElMessage.warning('请先粘贴 Ozon 商品链接');
        return;
      }
      await fetchCollectorStatus();
      if (!canRun.value) {
        ElementPlus.ElMessage.error('当前没有可领取任务的本机采集端在线，请先启动采集端');
        return;
      }
      creating.value = true;
      try {
        const res = await axios.post('/api/jobs', {
          urlsText: text,
          maxCandidates: Number(maxCandidates.value || 5),
          delayMinMs: Math.round(Number(delayMin.value || 8) * 1000),
          delayMaxMs: Math.round(Number(delayMax.value || 20) * 1000),
          startRow: Number(startRow.value || 1),
          maxConsecutiveFailures: Number(maxConsecutiveFailures.value || 3),
          enable1688: Boolean(enable1688.value),
          enableAI: Boolean(enableAI.value),
          headless: Boolean(headless.value),
        });
        currentJobId.value = res.data.jobId;
        localStorage.setItem('singleSourcingJobId', res.data.jobId);
        job.value = { id: res.data.jobId, status: res.data.queued ? 'queued' : 'running', phase: res.data.queued ? '等待本机采集端领取' : '已启动', logs: [] };
        ElementPlus.ElMessage.success('单品找货任务已创建');
        startPolling();
      } catch (error) {
        ElementPlus.ElMessage.error(apiError(error));
      } finally {
        creating.value = false;
      }
    };

    const cancelJob = async () => {
      if (!currentJobId.value) return;
      try {
        await ElementPlus.ElMessageBox.confirm('确定停止当前单品找货任务吗？', '停止任务', { type: 'warning' });
        const res = await axios.post(`/api/jobs/${encodeURIComponent(currentJobId.value)}/cancel`, {});
        if (res.data.job) job.value = res.data.job;
        ElementPlus.ElMessage.success('已请求停止');
        await pollJob();
      } catch (error) {
        if (error === 'cancel') return;
        ElementPlus.ElMessage.error(apiError(error));
      }
    };

    const downloadUrl = Vue.computed(() => job.value?.downloadUrl || (isTerminal.value && currentJobId.value ? `/api/history/${encodeURIComponent(currentJobId.value)}/download` : ''));

    const open1688 = async () => {
      try {
        const res = await axios.post('/api/1688/open', {});
        ElementPlus.ElMessage.success(res.data.message || '已请求打开 1688');
      } catch (error) {
        ElementPlus.ElMessage.error(apiError(error));
      }
    };

    const handlePageChange = () => { fetchData(); };
    const handleTabChange = () => {
      const nextHash = activeTab.value === 'single'
        ? '#/sourcing/single'
        : activeTab.value === 'bestseller'
          ? '#/sourcing/bestseller'
          : '#/sourcing';
      if (window.location.hash !== nextHash) window.location.hash = nextHash;
      pagination.currentPage = 1;
      if (activeTab.value === 'single') {
        fetchCollectorStatus();
        restoreActiveJob();
      } else {
        fetchData();
      }
    };

    Vue.onMounted(() => {
      activeTab.value = detectTabFromHash();
      fetchData();
      fetchCollectorStatus();
      restoreActiveJob();
      collectorTimer = setInterval(fetchCollectorStatus, 10000);
    });
    Vue.onBeforeUnmount(() => {
      stopPolling();
      if (collectorTimer) clearInterval(collectorTimer);
      window.removeEventListener('shop-changed', onShopChanged);
    });

    const onShopChanged = () => {
      pagination.currentPage = 1;
      tableData.value = [];
      pagination.total = 0;
      if (activeTab.value !== 'single') fetchData();
    };
    window.addEventListener('shop-changed', onShopChanged);

    const formatWorkerPlatform = (platform = '') => {
      if (platform === 'win32') return 'Windows';
      if (platform === 'darwin') return 'macOS';
      if (platform === 'linux') return 'Linux';
      return platform || '未知系统';
    };

    const formatTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
    const money = (value) => value ? String(value) : '';
    const topCandidates = (row) => (row.candidates || []).slice(0, 3);
    const ozonImage = (row) => row.ozon?.mainImage?.publicUrl || row.ozon?.mainImageUrl || '';

    return {
      activeTab, tableData, loading, pagination, fetchData, handlePageChange, handleTabChange,
      urlsText, maxCandidates, startRow, delayMin, delayMax, maxConsecutiveFailures,
      enable1688, enableAI, headless, creating, currentJobId, job, collectorLoading,
      collectorStatus, canRun, jobStatusText, recentLogs, jobResults, isRunning,
      startSingleSourcing, cancelJob, downloadUrl, open1688, formatWorkerPlatform,
      formatTime, money, topCandidates, ozonImage,
    };
  },
  template: `
    <div class="sourcing-view">
      <el-card>
        <template #header>
          <el-tabs v-model="activeTab" @tab-change="handleTabChange">
            <el-tab-pane label="类目分析" name="category" />
            <el-tab-pane label="热销榜单" name="bestseller" />
            <el-tab-pane label="单品找货" name="single" />
          </el-tabs>
        </template>

        <template v-if="activeTab !== 'single'">
          <el-table :data="tableData" v-loading="loading" stripe border>
            <template v-if="activeTab === 'category'">
              <el-table-column label="类目名称" prop="name" />
              <el-table-column label="近期销售额 (RUB)" prop="revenue" sortable />
              <el-table-column label="销量" prop="sales" sortable />
              <el-table-column label="退货率" prop="returnRate" />
            </template>
            <template v-else>
              <el-table-column label="排行" type="index" width="60" />
              <el-table-column label="商品信息" prop="name" />
              <el-table-column label="指数" prop="index" width="100" />
            </template>
          </el-table>

          <div style="margin-top:20px; display:flex; justify-content:flex-end">
            <el-pagination
              v-model:current-page="pagination.currentPage"
              :page-size="pagination.pageSize"
              :total="pagination.total"
              layout="total, prev, pager, next"
              @current-change="handlePageChange"
            />
          </div>
        </template>

        <template v-else>
          <div style="display:grid; grid-template-columns:minmax(0,1fr) 360px; gap:16px; align-items:start">
            <div>
              <el-card shadow="never" style="margin-bottom:16px">
                <template #header>
                  <div style="display:flex; justify-content:space-between; align-items:center">
                    <strong>单品找货</strong>
                    <span style="color:#909399; font-size:13px">Ozon → 1688 匹配 + AI 审核</span>
                  </div>
                </template>
                <el-form label-position="top">
                  <el-form-item label="Ozon 链接（每行一个）">
                    <el-input v-model="urlsText" type="textarea" :rows="8" spellcheck="false" placeholder="https://www.ozon.ru/product/..." />
                  </el-form-item>
                  <div style="display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:12px">
                    <el-form-item label="每商品候选数"><el-input-number v-model="maxCandidates" :min="1" :max="20" style="width:100%" /></el-form-item>
                    <el-form-item label="从第几行开始"><el-input-number v-model="startRow" :min="1" style="width:100%" /></el-form-item>
                    <el-form-item label="连续异常停止"><el-input-number v-model="maxConsecutiveFailures" :min="1" :max="20" style="width:100%" /></el-form-item>
                    <el-form-item label="间隔最小（秒）"><el-input-number v-model="delayMin" :min="1" style="width:100%" /></el-form-item>
                    <el-form-item label="间隔最大（秒）"><el-input-number v-model="delayMax" :min="1" style="width:100%" /></el-form-item>
                  </div>
                  <div style="display:flex; gap:18px; align-items:center; margin:4px 0 16px">
                    <el-checkbox v-model="enable1688">1688 以图搜货</el-checkbox>
                    <el-checkbox v-model="enableAI">AI 严格审核</el-checkbox>
                    <el-checkbox v-model="headless">后台浏览器模式</el-checkbox>
                  </div>
                  <div style="display:flex; gap:10px">
                    <el-button type="primary" :loading="creating" :disabled="isRunning" @click="startSingleSourcing">开始采集</el-button>
                    <el-button type="danger" :disabled="!currentJobId || !isRunning" @click="cancelJob">停止</el-button>
                    <el-button @click="open1688">打开 1688</el-button>
                    <el-button v-if="downloadUrl" type="success" tag="a" :href="downloadUrl">下载 Excel</el-button>
                  </div>
                </el-form>
              </el-card>

              <el-card shadow="never" style="margin-bottom:16px">
                <template #header>
                  <div style="display:flex; justify-content:space-between; align-items:center">
                    <strong>实时进度</strong>
                    <span style="color:#606266; font-size:13px">{{ jobStatusText }}</span>
                  </div>
                </template>
                <pre style="margin:0; min-height:180px; max-height:360px; overflow:auto; background:#172033; color:#d8e3f0; padding:14px; border-radius:6px; line-height:1.55">{{ recentLogs }}</pre>
              </el-card>

              <el-card shadow="never">
                <template #header>
                  <div style="display:flex; justify-content:space-between; align-items:center">
                    <strong>结果</strong>
                    <span style="color:#909399; font-size:13px">{{ jobResults.length }} 条</span>
                  </div>
                </template>
                <el-table :data="jobResults" border stripe empty-text="还没有结果">
                  <el-table-column label="Ozon" min-width="260">
                    <template #default="{ row }">
                      <a :href="row.url" target="_blank" rel="noreferrer">{{ row.ozon?.title || row.url }}</a>
                      <div style="color:#909399; font-size:12px">{{ money(row.ozon?.currentBlackPriceCny || row.ozon?.finalBlackPriceCny) }}</div>
                    </template>
                  </el-table-column>
                  <el-table-column label="主图" width="96">
                    <template #default="{ row }">
                      <el-image v-if="ozonImage(row)" :src="ozonImage(row)" style="width:56px;height:56px;border-radius:6px" fit="cover" />
                    </template>
                  </el-table-column>
                  <el-table-column label="1688 候选" min-width="320">
                    <template #default="{ row }">
                      <div v-if="topCandidates(row).length">
                        <div v-for="c in topCandidates(row)" :key="c.rank + c.link" style="margin-bottom:6px">
                          <a :href="c.link" target="_blank" rel="noreferrer">{{ c.rank }}. {{ c.title }}</a>
                          <div style="color:#909399; font-size:12px">{{ c.price || c.priceDetails }}</div>
                        </div>
                      </div>
                      <span v-else style="color:#909399">{{ row.searchError || '无候选' }}</span>
                    </template>
                  </el-table-column>
                  <el-table-column label="状态" width="160">
                    <template #default="{ row }">
                      <el-tag :type="row.error ? 'danger' : 'success'">{{ row.aiReview?.decision || row.error || '已采集' }}</el-tag>
                    </template>
                  </el-table-column>
                </el-table>
              </el-card>
            </div>

            <el-card shadow="never" v-loading="collectorLoading">
              <template #header>
                <div style="display:flex; justify-content:space-between; align-items:center">
                  <strong>采集端状态</strong>
                  <el-tag :type="canRun ? 'success' : 'warning'">{{ canRun ? '可采集' : '未就绪' }}</el-tag>
                </div>
              </template>
              <div style="margin-bottom:10px; color:#606266; font-size:13px">
                排队 {{ collectorStatus.queue?.queued || 0 }} · 执行 {{ collectorStatus.queue?.active || 0 }}
              </div>
              <el-alert v-if="collectorStatus.error" :title="collectorStatus.error" type="error" :closable="false" style="margin-bottom:10px" />
              <el-empty v-if="!(collectorStatus.workers || []).length" description="还没有检测到采集端" :image-size="80" />
              <div v-for="worker in collectorStatus.workers" :key="worker.workerName" style="border:1px solid #ebeef5; border-radius:6px; padding:10px; margin-bottom:10px">
                <div style="display:flex; justify-content:space-between; gap:8px">
                  <strong>{{ worker.workerName || '本机采集端' }}</strong>
                  <el-tag size="small" :type="worker.online ? 'success' : 'info'">{{ worker.online ? '在线' : '离线' }}</el-tag>
                </div>
                <div style="color:#909399; font-size:12px; margin-top:5px">
                  {{ formatWorkerPlatform(worker.platform) }} · {{ worker.hostname || '未知电脑' }}
                </div>
                <div v-if="worker.currentPhase" style="color:#606266; font-size:12px; margin-top:5px">{{ worker.currentPhase }}</div>
                <div style="color:#c0c4cc; font-size:12px; margin-top:5px">最后心跳：{{ formatTime(worker.lastSeenAt) }}</div>
              </div>
            </el-card>
          </div>
        </template>
      </el-card>
    </div>
  `
};
