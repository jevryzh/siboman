window.SourcingModuleView = {
  setup() {
    const detectTabFromHash = () => {
      const hash = String(window.location.hash || '').toLowerCase();
      if (hash.includes('/single-sourcing')) return 'single';
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
    const creating = Vue.ref(false);
    const currentJobId = Vue.ref(localStorage.getItem('singleSourcingJobId') || '');
    const job = Vue.ref(null);
    const collectorLoading = Vue.ref(false);
    const collectorStatus = Vue.ref({ workers: [], queue: { queued: 0, active: 0 } });
    const historyLoading = Vue.ref(false);
    const jobHistory = Vue.ref([]);
    let pollTimer = null;
    let collectorTimer = null;

    const apiError = (error) => error?.response?.data?.error || error?.message || '请求失败';
    const PROTO = "__zhumeng_proto";
    const PROTO_VAL = "zhumeng-v1";
    window.__zhumeng_pending__ = window.__zhumeng_pending__ || {};

    const handleExtensionMessage = (event) => {
      const d = event.data;
      if (!d || typeof d !== 'object' || d[PROTO] !== PROTO_VAL) return;
      if (typeof d.kind === 'string' && d.kind.endsWith('.request')) return;
      const resolver = window.__zhumeng_pending__[d.reqId];
      if (resolver) {
        delete window.__zhumeng_pending__[d.reqId];
        resolver(d);
      }
    };
    window.addEventListener('message', handleExtensionMessage);

    const sendToExtension = (kind, extra = {}, timeoutMs = 8000) => new Promise((resolve) => {
      const reqId = `${kind.split('.')[0]}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      let resolved = false;
      window.__zhumeng_pending__[reqId] = (data) => {
        if (resolved) return;
        resolved = true;
        delete window.__zhumeng_pending__[reqId];
        resolve(data);
      };
      try {
        window.postMessage(JSON.parse(JSON.stringify({ [PROTO]: PROTO_VAL, reqId, kind, ...extra })), '*');
      } catch (error) {
        resolved = true;
        delete window.__zhumeng_pending__[reqId];
        resolve({ ok: false, error: error.message });
        return;
      }
      setTimeout(() => {
        if (resolved) return;
        resolved = true;
        delete window.__zhumeng_pending__[reqId];
        resolve(null);
      }, timeoutMs);
    });

    const authorizePluginWorker = async () => {
      try {
        const res = await axios.get('/api/worker/plugin-token');
        if (!res.data?.token) return false;
        const reply = await sendToExtension('workerAuth.request', { token: res.data.token }, 10000);
        if (reply?.ok) {
          setTimeout(fetchCollectorStatus, 1200);
          return true;
        }
      } catch (error) {
        console.warn('[single-sourcing] 插件授权失败:', apiError(error));
      }
      return false;
    };

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
    const onlineWorkers = Vue.computed(() => (collectorStatus.value.workers || []).filter(w => w.online));
    const collectorStatusText = Vue.computed(() => {
      const onlineCount = onlineWorkers.value.length;
      const queued = collectorStatus.value.queue?.queued || 0;
      const active = collectorStatus.value.queue?.active || 0;
      if (canRun.value) return `采集插件在线${onlineCount > 1 ? ` ${onlineCount}` : ''} · 排队 ${queued} · 执行 ${active}`;
      return onlineCount ? `采集端在线但不可领取 · 排队 ${queued}` : '采集插件离线';
    });

    const jobStatusText = Vue.computed(() => {
      const j = job.value;
      if (!j) return '待开始';
      return `${j.status || '-'} · ${j.phase || ''} · ${j.processed || 0}/${j.total || 0}`;
    });

    const formatLogClock = (value) => {
      if (!value) return '--:--:--';
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return '--:--:--';
      return d.toLocaleTimeString('zh-CN', { hour12: false });
    };
    const recentLogs = Vue.computed(() => {
      const logs = job.value?.logs || [];
      const total = Number(job.value?.sourceTotal || job.value?.total || 0);
      let currentItem = 0;
      let seenStarts = 0;
      const allLines = logs.map((entry) => {
        const level = String(entry?.level || 'info').toUpperCase();
        const message = String(entry?.message || entry || '');
        let itemNo = 0;
        const explicit = message.match(/第\s*(\d+)(?:\s*\/\s*(\d+))?\s*(?:条|行|个)?/);
        if (explicit) {
          itemNo = Number(explicit[1]) || 0;
          if (itemNo) currentItem = itemNo;
        } else if (/开始采集\s+Ozon\s+SKU|正在采集第/.test(message)) {
          seenStarts += 1;
          currentItem = seenStarts;
          itemNo = currentItem;
        } else if (/用主图搜索|1688\s*找到|服务器\s*AI\s*审核|候选|采集完成/.test(message)) {
          itemNo = currentItem;
        }
        const progress = itemNo ? ` 第 ${itemNo}${total ? `/${total}` : ''} 条` : '';
        return `${formatLogClock(entry?.at)} [${level}]${progress} ${message}`;
      });
      return allLines.slice(-160).join('\n') || '暂无日志';
    });

    const jobResults = Vue.computed(() => job.value?.results || []);
    const isRunning = Vue.computed(() => ['queued', 'claimed', 'running', 'exporting'].includes(job.value?.status || ''));
    const isTerminal = Vue.computed(() => ['done', 'error', 'canceled'].includes(job.value?.status || ''));

    const fetchJobHistory = async () => {
      historyLoading.value = true;
      try {
        const res = await axios.get('/api/history');
        jobHistory.value = (res.data.items || []).filter(item => item.kind === 'run').slice(0, 20);
      } catch (error) {
        console.warn('[single-sourcing] 历史记录加载失败:', apiError(error));
      } finally {
        historyLoading.value = false;
      }
    };

    const historyDownloadUrl = (item) => item?.downloadUrl || (item?.excelExists && item?.id ? `/api/history/${encodeURIComponent(item.id)}/download` : '');

    const loadHistoryJob = async (item) => {
      if (!item?.id) return;
      currentJobId.value = item.id;
      const activeStatuses = new Set(['queued', 'claimed', 'running', 'exporting']);
      if (activeStatuses.has(item.status)) localStorage.setItem('singleSourcingJobId', item.id);
      else localStorage.removeItem('singleSourcingJobId');
      await pollJob();
      if (job.value && activeStatuses.has(job.value.status)) startPolling();
    };

    const jobStatusTagType = (status) => {
      if (status === 'done') return 'success';
      if (status === 'error') return 'danger';
      if (status === 'canceled') return 'info';
      return 'warning';
    };

    const formatHistoryRange = (item) => {
      const first = item?.firstRow || item?.sourceStartRow || '';
      const last = item?.lastRow || '';
      const total = item?.sourceTotal || item?.total || '';
      if (first && last && String(first) !== String(last)) return `${first}-${last}${total ? ` / ${total}` : ''}`;
      if (first) return `第 ${first} 行${total ? ` / ${total}` : ''}`;
      return total ? `${total} 条` : '-';
    };

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
          fetchJobHistory();
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
      authorizePluginWorker().catch(() => {});
      fetchCollectorStatus().catch(() => {});
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
        });
        currentJobId.value = res.data.jobId;
        localStorage.setItem('singleSourcingJobId', res.data.jobId);
        job.value = { id: res.data.jobId, status: res.data.queued ? 'queued' : 'running', phase: res.data.queued ? '等待采集插件/采集端领取' : '已启动', logs: [] };
        ElementPlus.ElMessage.success(canRun.value ? '单品找货任务已创建' : '任务已创建，等待采集插件/采集端领取');
        fetchJobHistory();
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
        fetchJobHistory();
      } catch (error) {
        if (error === 'cancel') return;
        ElementPlus.ElMessage.error(apiError(error));
      }
    };

    const downloadUrl = Vue.computed(() => job.value?.downloadUrl || (isTerminal.value && currentJobId.value ? `/api/history/${encodeURIComponent(currentJobId.value)}/download` : ''));

    const open1688 = () => {
      window.open('https://www.1688.com/', '_blank', 'noopener');
    };

    const handlePageChange = () => { fetchData(); };
    const handleTabChange = () => {
      const nextHash = activeTab.value === 'single'
        ? '#/single-sourcing'
        : activeTab.value === 'bestseller'
          ? '#/sourcing/bestseller'
          : '#/sourcing';
      if (window.location.hash !== nextHash) window.location.hash = nextHash;
      pagination.currentPage = 1;
      if (activeTab.value === 'single') {
        fetchCollectorStatus();
        fetchJobHistory();
        restoreActiveJob();
      } else {
        fetchData();
      }
    };

    Vue.onMounted(() => {
      activeTab.value = detectTabFromHash();
      if (activeTab.value !== 'single') fetchData();
      authorizePluginWorker().catch(() => {});
      fetchCollectorStatus();
      fetchJobHistory();
      restoreActiveJob();
      collectorTimer = setInterval(fetchCollectorStatus, 10000);
    });
    Vue.onBeforeUnmount(() => {
      stopPolling();
      if (collectorTimer) clearInterval(collectorTimer);
      window.removeEventListener('message', handleExtensionMessage);
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
    const percent = (value) => {
      const n = Number(value);
      return Number.isFinite(n) ? `${Math.round(n * 100)}%` : '';
    };
    const aiDecisionText = (decision) => ({
      exact: '完全一致',
      approximate: '近似匹配',
      none: '未匹配',
      needs_review: '待复核',
      pending: '待审核',
    }[decision] || decision || '未审核');
    const aiTagType = (decision) => {
      if (decision === 'exact') return 'success';
      if (decision === 'approximate' || decision === 'needs_review' || decision === 'pending') return 'warning';
      if (decision === 'none') return 'danger';
      return 'info';
    };
    const rowStatusType = (row) => {
      if (row.error || row.searchError) return 'danger';
      if (row.aiReview?.decision === 'exact') return 'success';
      if (row.aiReview?.decision === 'approximate' || row.aiReview?.decision === 'needs_review') return 'warning';
      return 'info';
    };
    const rowStatusText = (row) => row.error || row.searchError || aiDecisionText(row.aiReview?.decision) || '已采集';
    const candidateReview = (row, rank) => (row.aiReview?.candidate_reviews || []).find(item => Number(item.rank) === Number(rank)) || null;
    const selectedCandidateText = (row) => {
      const rank = row.aiReview?.selected_rank || row.selectedCandidate?.rank || '';
      if (!rank) return '';
      return `选中 #${rank}`;
    };

    return {
      activeTab, tableData, loading, pagination, fetchData, handlePageChange, handleTabChange,
      urlsText, maxCandidates, startRow, delayMin, delayMax, maxConsecutiveFailures,
      enable1688, enableAI, creating, currentJobId, job, collectorLoading,
      collectorStatus, canRun, onlineWorkers, collectorStatusText, jobStatusText, recentLogs, jobResults, isRunning,
      startSingleSourcing, cancelJob, downloadUrl, open1688, formatWorkerPlatform,
      formatTime, money, topCandidates, ozonImage, historyLoading, jobHistory,
      historyDownloadUrl, loadHistoryJob, jobStatusTagType, formatHistoryRange,
      percent, aiDecisionText, aiTagType, rowStatusType, rowStatusText,
      candidateReview, selectedCandidateText,
    };
  },
  template: `
    <div class="sourcing-view">
      <el-card>
        <template v-if="activeTab !== 'single'" #header>
          <el-tabs v-model="activeTab" @tab-change="handleTabChange">
            <el-tab-pane label="类目分析" name="category" />
            <el-tab-pane label="热销榜单" name="bestseller" />
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
          <div style="display:flex; flex-direction:column; gap:16px; width:100%">
              <el-card shadow="never">
                <template #header>
                  <div style="display:flex; justify-content:space-between; align-items:center; gap:12px">
                    <strong>单品找货</strong>
                    <el-tooltip placement="bottom" :content="collectorStatusText">
                      <el-tag :type="canRun ? 'success' : 'info'" effect="light">{{ canRun ? '采集插件在线' : '采集插件离线' }}</el-tag>
                    </el-tooltip>
                  </div>
                </template>
                <el-form label-position="top">
                  <el-form-item label="Ozon 链接（每行一个）">
                    <el-input v-model="urlsText" type="textarea" :rows="8" spellcheck="false" placeholder="https://www.ozon.ru/product/..." />
                  </el-form-item>
                  <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px">
                    <el-form-item label="每商品候选数"><el-input-number v-model="maxCandidates" :min="1" :max="20" style="width:100%" /></el-form-item>
                    <el-form-item label="从第几行开始"><el-input-number v-model="startRow" :min="1" style="width:100%" /></el-form-item>
                    <el-form-item label="连续异常停止"><el-input-number v-model="maxConsecutiveFailures" :min="1" :max="20" style="width:100%" /></el-form-item>
                    <el-form-item label="间隔最小（秒）"><el-input-number v-model="delayMin" :min="1" style="width:100%" /></el-form-item>
                    <el-form-item label="间隔最大（秒）"><el-input-number v-model="delayMax" :min="1" style="width:100%" /></el-form-item>
                  </div>
                  <div style="display:flex; gap:18px; align-items:center; margin:4px 0 16px">
                    <el-checkbox v-model="enable1688">1688 以图搜货</el-checkbox>
                    <el-checkbox v-model="enableAI">AI 严格审核</el-checkbox>
                  </div>
                  <div style="display:flex; gap:10px">
                    <el-button type="primary" :loading="creating" :disabled="isRunning" @click="startSingleSourcing">开始采集</el-button>
                    <el-button type="danger" :disabled="!currentJobId || !isRunning" @click="cancelJob">停止</el-button>
                    <el-button @click="open1688">打开 1688 首页</el-button>
                    <el-button v-if="downloadUrl" type="success" tag="a" :href="downloadUrl">下载 Excel</el-button>
                  </div>
                </el-form>
              </el-card>

              <el-card shadow="never">
                <template #header>
                  <div style="display:flex; justify-content:space-between; align-items:center">
                    <strong>实时进度</strong>
                    <span style="color:#606266; font-size:13px">{{ jobStatusText }}</span>
                  </div>
                </template>
                <pre style="margin:0; width:100%; box-sizing:border-box; min-height:220px; max-height:460px; overflow:auto; background:#172033; color:#d8e3f0; padding:14px 18px; border-radius:6px; line-height:1.55; white-space:pre-wrap; word-break:break-word">{{ recentLogs }}</pre>
              </el-card>

              <el-card shadow="never">
                <template #header>
                  <div style="display:flex; justify-content:space-between; align-items:center">
                    <strong>结果</strong>
                    <span style="color:#909399; font-size:13px">{{ jobResults.length }} 条</span>
                  </div>
                </template>
                <el-table :data="jobResults" border stripe empty-text="还没有结果" style="width:100%">
                  <el-table-column label="行" width="70">
                    <template #default="{ row, $index }">
                      {{ row.sourceRow || $index + 1 }}
                    </template>
                  </el-table-column>
                  <el-table-column label="Ozon 商品" min-width="340">
                    <template #default="{ row }">
                      <a :href="row.url" target="_blank" rel="noreferrer">{{ row.ozon?.title || row.url }}</a>
                      <div style="color:#909399; font-size:12px; margin-top:4px">
                        SKU {{ row.ozon?.sku || row.ozon?.productId || '-' }} · {{ money(row.ozon?.currentBlackPriceCny || row.ozon?.finalBlackPriceCny) || '-' }}
                      </div>
                    </template>
                  </el-table-column>
                  <el-table-column label="主图" width="96">
                    <template #default="{ row }">
                      <el-image v-if="ozonImage(row)" :src="ozonImage(row)" style="width:56px;height:56px;border-radius:6px" fit="cover" />
                    </template>
                  </el-table-column>
                  <el-table-column label="1688 候选" min-width="460">
                    <template #default="{ row }">
                      <div v-if="topCandidates(row).length">
                        <div v-for="c in topCandidates(row)" :key="c.rank + c.link" style="margin-bottom:6px">
                          <a :href="c.link" target="_blank" rel="noreferrer">{{ c.rank }}. {{ c.title }}</a>
                          <div style="color:#909399; font-size:12px">
                            {{ c.price || c.priceDetails || '-' }}
                            <span v-if="candidateReview(row, c.rank)?.verdict"> · {{ candidateReview(row, c.rank).verdict }}</span>
                            <span v-if="candidateReview(row, c.rank)?.confidence"> · {{ percent(candidateReview(row, c.rank).confidence) }}</span>
                          </div>
                        </div>
                      </div>
                      <span v-else style="color:#909399">{{ row.searchError || '无候选' }}</span>
                    </template>
                  </el-table-column>
                  <el-table-column label="AI 审核" min-width="360">
                    <template #default="{ row }">
                      <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap">
                        <el-tag :type="aiTagType(row.aiReview?.decision)">{{ aiDecisionText(row.aiReview?.decision) }}</el-tag>
                        <span v-if="selectedCandidateText(row)" style="font-size:12px; color:#606266">{{ selectedCandidateText(row) }}</span>
                        <span v-if="row.aiReview?.confidence !== undefined" style="font-size:12px; color:#909399">置信度 {{ percent(row.aiReview.confidence) }}</span>
                      </div>
                      <div v-if="row.aiReview?.reason" style="color:#606266; font-size:12px; margin-top:6px; line-height:1.45">{{ row.aiReview.reason }}</div>
                    </template>
                  </el-table-column>
                  <el-table-column label="状态 / 错误" min-width="220">
                    <template #default="{ row }">
                      <el-tag :type="rowStatusType(row)">{{ rowStatusText(row) }}</el-tag>
                    </template>
                  </el-table-column>
                </el-table>
              </el-card>

            <el-card shadow="never" v-loading="historyLoading">
              <template #header>
                <div style="display:flex; justify-content:space-between; align-items:center; gap:10px">
                  <strong>历史记录</strong>
                  <el-button size="small" text @click="fetchJobHistory">刷新</el-button>
                </div>
              </template>
              <el-empty v-if="!jobHistory.length" description="暂无单品找货记录" :image-size="80" />
              <div v-for="item in jobHistory" :key="item.id" style="border-bottom:1px solid #ebeef5; padding:10px 0">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px">
                  <div style="min-width:0">
                    <div style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">
                      {{ item.firstUrl || item.id }}
                    </div>
                    <div style="color:#909399; font-size:12px; margin-top:4px">
                      {{ formatHistoryRange(item) }} · {{ item.processed || 0 }}/{{ item.total || item.sourceTotal || 0 }} · {{ formatTime(item.updatedAt || item.createdAt) }}
                    </div>
                    <div v-if="item.phase" style="color:#606266; font-size:12px; margin-top:4px">{{ item.phase }}</div>
                  </div>
                  <el-tag size="small" :type="jobStatusTagType(item.status)">{{ item.status || '-' }}</el-tag>
                </div>
                <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap">
                  <el-button size="small" @click="loadHistoryJob(item)">查看</el-button>
                  <el-button
                    v-if="historyDownloadUrl(item)"
                    size="small"
                    tag="a"
                    :href="historyDownloadUrl(item)"
                    target="_blank"
                    rel="noreferrer"
                  >下载 Excel</el-button>
                </div>
              </div>
            </el-card>
            </div>
          </div>
        </template>
      </el-card>
    </div>
  `
};
