window.SourcingModuleView = {
  setup() {
    const detectTabFromHash = () => {
	      const hash = String(window.location.hash || '').toLowerCase();
	      if (hash.includes('/single-sourcing')) return 'single';
	      if (hash.includes('/bestseller') || hash.includes('/top')) return 'external';
	      return 'category';
	    };
	    const activeTab = Vue.ref(detectTabFromHash());
	    const loading = Vue.ref(false);
	    const tableData = Vue.ref([]);
	    const overview = Vue.ref({ summary: {}, categories: [], products: [], store_ranking: [], trends: [], price_distribution: [], data_source: {} });
	    const rangeDays = Vue.ref(30);
	    const externalRows = Vue.ref([]);
	    const externalTotal = Vue.ref(0);
	    const externalStrategy = Vue.ref('hot');
	    const externalSearch = Vue.ref('');
	    const platformCollectText = Vue.ref('');
	    const platformCollecting = Vue.ref(false);
	    const platformStatus = Vue.ref({ stats: {}, sources: [], note: '' });
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
	    const liveTick = Vue.ref(Date.now());
	    const lastJobLiveAt = Vue.ref('');
	    const collectorLoading = Vue.ref(false);
    const collectorStatus = Vue.ref({ workers: [], queue: { queued: 0, active: 0 } });
    const historyLoading = Vue.ref(false);
    const jobHistory = Vue.ref([]);
    const logPanel = Vue.ref(null);
    let pollTimer = null;
	    let collectorTimer = null;
	    let lastHistoryRefreshAt = 0;
	    let lastCollectorRefreshAt = 0;
	    let pollFailures = 0;
	    let lastPollErrorAt = 0;
	    let platformAutoRefreshRequested = false;
	    let adoptWorkerActiveJob = () => {};
	    const activeStatuses = new Set(['queued', 'claimed', 'running', 'exporting']);

    const apiError = (error) => error?.response?.data?.error || error?.message || '请求失败';
    const PROTO = "__zhumeng_proto";
    const PROTO_VAL = "zhumeng-v1";
    const PLUGIN_ZIP_VERSION = "2.2.9.75";
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
	      loading.value = true;
	      try {
	        if (activeTab.value === 'external') {
	          const res = await axios.get('/api/sourcing/bestsellers', {
	            params: {
	              strategy: externalStrategy.value,
	              search: externalSearch.value,
	              limit: pagination.pageSize,
	              offset: (pagination.currentPage - 1) * pagination.pageSize,
	            },
	          });
	          externalRows.value = res.data.items || [];
	          externalTotal.value = Number(res.data.total || 0);
	          pagination.total = externalTotal.value;
	          tableData.value = externalRows.value;
	          return;
	        }
	        const res = await axios.post('/api/sourcing/overview', {
	          range: rangeDays.value,
	        });
	        overview.value = res.data || {};
	        if (activeTab.value === 'product') tableData.value = overview.value.products || [];
	        else if (activeTab.value === 'store') tableData.value = overview.value.store_ranking || [];
	        else tableData.value = overview.value.categories || [];
	        pagination.total = tableData.value.length;
	      } catch (error) {
	        ElementPlus.ElMessage.error(apiError(error));
	      } finally {
        loading.value = false;
      }
    };

	    const fetchPlatformStatus = async () => {
	      if (activeTab.value === 'single') return;
	      try {
	        const res = await axios.get('/api/sourcing/platform-snapshot/status');
	        platformStatus.value = res.data || { stats: {}, sources: [] };
	      } catch (error) {
	        platformStatus.value = { stats: {}, sources: [], error: apiError(error) };
	      }
	    };

	    const refreshPlatformSnapshots = async (options = {}) => {
	      const silent = Boolean(options.silent);
	      platformCollecting.value = true;
	      try {
	        const res = await axios.post('/api/sourcing/platform-data-source/sync', { period: 'monthly' });
	        const imported = Number(res.data?.imported || 0);
	        if (!silent) ElementPlus.ElMessage.success(`已同步 ${imported} 条 Ozon 平台榜单数据`);
	        await Promise.all([fetchPlatformStatus(), fetchData()]);
	      } catch (error) {
	        if (!silent) ElementPlus.ElMessage.error(apiError(error));
	      } finally {
	        platformCollecting.value = false;
	      }
	    };

	    const collectPlatformSnapshots = async () => {
	      const text = String(platformCollectText.value || '').trim();
	      if (!text) {
	        ElementPlus.ElMessage.warning('请先粘贴 Ozon 商品链接或 SKU');
	        return;
	      }
	      platformCollecting.value = true;
	      try {
	        const res = await axios.post('/api/sourcing/platform-snapshot/collect', {
	          urls: text,
	          strategy_type: externalStrategy.value === 'all' ? 'hot' : externalStrategy.value,
	        });
	        const imported = Number(res.data?.imported || 0);
	        const failed = Number(res.data?.failed || 0);
	        if (failed > 0) ElementPlus.ElMessage.warning(`已采集 ${imported} 条，失败 ${failed} 条`);
	        else ElementPlus.ElMessage.success(`已采集 ${imported} 条 Ozon 平台快照`);
	        platformCollectText.value = '';
	        await Promise.all([fetchData(), fetchPlatformStatus()]);
	      } catch (error) {
	        ElementPlus.ElMessage.error(apiError(error));
	      } finally {
	        platformCollecting.value = false;
	      }
	    };

	    const fetchCollectorStatus = async (options = {}) => {
	      const silent = Boolean(options.silent);
	      const now = Date.now();
	      if (silent && now - lastCollectorRefreshAt < 5000) return;
	      lastCollectorRefreshAt = now;
	      if (!silent) collectorLoading.value = true;
	      try {
        const res = await axios.get('/api/worker/status');
        collectorStatus.value = {
          workers: res.data.workers || [],
          queue: res.data.queue || { queued: 0, active: 0 },
        };
        adoptWorkerActiveJob();
      } catch (error) {
        collectorStatus.value = { workers: [], queue: { queued: 0, active: 0 }, error: apiError(error) };
      } finally {
        if (!silent) collectorLoading.value = false;
      }
    };

    const canRun = Vue.computed(() => {
      const workers = collectorStatus.value.workers || [];
      return workers.some(w => w.online && w.canClaimJobs && !w.versionTooOld && w.storeMatch !== false);
    });
    const onlineWorkers = Vue.computed(() => (collectorStatus.value.workers || []).filter(w => w.online));
    const activeJobWorker = Vue.computed(() => {
      const id = currentJobId.value || job.value?.id || '';
      if (!id) return null;
      return (collectorStatus.value.workers || []).find(w => w.online && w.currentJobId === id) || null;
    });
    const currentWorker = Vue.computed(() => activeJobWorker.value || onlineWorkers.value.find(w => w.canClaimJobs) || onlineWorkers.value[0] || null);
    const collectorStatusText = Vue.computed(() => {
      const onlineCount = onlineWorkers.value.length;
      const queued = collectorStatus.value.queue?.queued || 0;
      const active = collectorStatus.value.queue?.active || 0;
      if (activeJobWorker.value) return `采集插件 v${activeJobWorker.value.version || '未知'} 正在执行 · 排队 ${queued} · 执行 ${active}`;
      if (canRun.value) return `采集插件在线${onlineCount > 1 ? ` ${onlineCount}` : ''} · 排队 ${queued} · 执行 ${active}`;
      return onlineCount ? `采集端在线但不可领取 · 排队 ${queued}` : '采集插件离线';
    });
    const collectorHealthType = Vue.computed(() => {
      if (collectorStatus.value.error) return 'danger';
      if (activeJobWorker.value) return 'success';
      if (canRun.value) return 'success';
      if (onlineWorkers.value.length) return 'warning';
      return 'info';
    });
    const collectorHealthText = Vue.computed(() => {
      if (collectorStatus.value.error) return `采集端状态读取失败：${collectorStatus.value.error}`;
      if (activeJobWorker.value) return `插件 v${activeJobWorker.value.version || '未知'} 正在执行任务`;
      if (canRun.value) return '当前采集插件可领取任务';
      const oldWorker = onlineWorkers.value.find(w => w.versionTooOld);
      if (oldWorker) return `插件版本 ${oldWorker.version || '未知'} 低于最低版本 v${oldWorker.minVersion || '未知'}`;
      if (onlineWorkers.value.length) return '插件已在线，但还没有拿到当前账号授权';
      return '未检测到当前在线采集插件';
    });

    const refreshAndAuthorizePlugin = async () => {
      collectorLoading.value = true;
      try {
        await authorizePluginWorker();
        await fetchCollectorStatus();
      } finally {
        collectorLoading.value = false;
      }
    };

	    const jobStatusText = Vue.computed(() => {
	      const j = job.value;
	      if (!j) return '待开始';
	      return `${j.status || '-'} · ${j.phase || ''} · ${j.processed || 0}/${j.total || 0}`;
	    });
	    const liveStatusText = Vue.computed(() => {
	      const j = job.value;
	      if (!j || !activeStatuses.has(j.status)) return '';
	      liveTick.value;
	      const worker = activeJobWorker.value;
	      const at = lastJobLiveAt.value || j.updatedAt || worker?.lastSeenAt || '';
	      const when = at ? new Date(at) : null;
	      const seconds = when && !Number.isNaN(when.getTime()) ? Math.max(0, Math.round((Date.now() - when.getTime()) / 1000)) : null;
	      const suffix = seconds == null ? '等待采集端回传' : `最后更新 ${seconds} 秒前`;
	      return `${j.phase || '采集中'} · ${suffix}`;
	    });

    const formatLogClock = (value) => {
      if (!value) return '--:--:--';
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return '--:--:--';
      return d.toLocaleTimeString('zh-CN', { hour12: false });
    };
    const extractOzonSku = (value) => {
      const text = String(value || '');
      return text.match(/product\/(\d+)/)?.[1] || text.match(/Ozon\s+SKU\s+(\d+)/i)?.[1] || '';
    };
	    const recentLogs = Vue.computed(() => {
      const logs = (job.value?.logs || []).filter((entry) => !/^实时进度：/.test(String(entry?.message || entry || '').trim()));
      const total = Number(job.value?.sourceTotal || job.value?.total || 0);
      const rowBySku = new Map();
      (job.value?.payload?.urlRows || []).forEach((row, index) => {
        const sku = extractOzonSku(row?.url || row);
        if (sku) rowBySku.set(sku, Number(row?.sourceRow || index + 1));
      });
      let currentItem = 0;
      let seenStarts = 0;
      const allLines = logs.map((entry) => {
        const level = String(entry?.level || 'info').toUpperCase();
        const message = String(entry?.message || entry || '');
        let itemNo = 0;
        const sku = extractOzonSku(message);
        const explicit = message.match(/第\s*(\d+)(?:\s*\/\s*(\d+))?\s*(?:条|行|个)?/);
        if (explicit) {
          itemNo = Number(explicit[1]) || 0;
          if (itemNo) currentItem = itemNo;
        } else if (/开始采集\s+Ozon\s+SKU|正在采集第/.test(message)) {
          seenStarts += 1;
          currentItem = (sku && rowBySku.get(sku)) || seenStarts;
          itemNo = currentItem;
        } else if (/用主图搜索|1688\s*找到|服务器\s*AI\s*审核|候选|采集完成/.test(message)) {
          itemNo = currentItem;
        }
        const progress = itemNo ? ` 第 ${itemNo}${total ? `/${total}` : ''} 条` : '';
        return `${formatLogClock(entry?.at)} [${level}]${progress} ${message}`;
      });
      return allLines.slice(-160).join('\n') || '暂无日志';
    });
    const logLineCount = Vue.computed(() => (job.value?.logs || []).length);
    Vue.watch(logLineCount, () => {
      Vue.nextTick(() => {
        const el = logPanel.value;
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
    const operatorAlert = Vue.computed(() => {
      if (collectorStatus.value.error) {
        return { type: 'error', title: '采集插件状态异常', message: collectorStatus.value.error };
      }
      if (!activeJobWorker.value && !canRun.value) {
        return {
          type: onlineWorkers.value.length ? 'warning' : 'info',
          title: onlineWorkers.value.length ? '插件需要重新授权' : '未检测到当前在线插件',
          message: onlineWorkers.value.length
            ? '请保持本页打开，点击“刷新/重新授权插件”；插件不需要登录 ERP 账号，但必须接收当前页面签发的短期授权。'
            : '请在店铺管理下载并重载最新版逐梦采集插件，然后回到本页刷新状态。',
        };
      }
      const text = (job.value?.logs || []).map(entry => String(entry?.message || entry || '')).join('\n');
      if (/验证码|滑块|captcha|verify|验证/.test(text)) {
        return { type: 'warning', title: '1688 需要人工验证', message: '请点击“打开 1688 首页”在当前 Chrome 里完成登录或验证码，再从失败行继续跑。' };
      }
      if (/未登录|login|请登录|登录/.test(text)) {
        return { type: 'warning', title: '1688 登录状态不可用', message: '请先打开 1688 首页确认已登录；插件会使用当前 Chrome 会话，不需要 ERP 账号密码。' };
      }
      if (/AI.*失败|provider|模型|AI_PROVIDER|AI_ALL_PROVIDERS/.test(text)) {
        return { type: 'error', title: 'AI 审核失败', message: '货源候选已保留，请查看日志中的 provider/model 错误并下载 Excel 做人工复核。' };
      }
      if (/无候选|没有候选|result\[\]/.test(text)) {
        return { type: 'info', title: '部分商品没有 1688 候选', message: '这通常和 Ozon 主图、1688 搜图结果或验证码有关；结果表会保留失败原因，方便断点续跑。' };
      }
      return null;
    });

	    const jobResults = Vue.computed(() => job.value?.results || []);
	    const isRunning = Vue.computed(() => ['queued', 'claimed', 'running', 'exporting'].includes(job.value?.status || ''));
	    const isTerminal = Vue.computed(() => ['done', 'error', 'canceled'].includes(job.value?.status || ''));

	    const logSignature = (logs = []) => {
	      if (!Array.isArray(logs) || !logs.length) return '0';
	      const last = logs[logs.length - 1] || {};
	      return `${logs.length}:${last.at || ''}:${last.level || ''}:${last.message || last}`;
	    };

	    const sameJobPayload = (a, b) => {
	      if (!a || !b || a.id !== b.id) return false;
	      return [
	        'status',
	        'phase',
	        'processed',
	        'total',
	        'downloadUrl',
	        'updatedAt',
	      ].every((key) => String(a[key] ?? '') === String(b[key] ?? ''))
	        && logSignature(a.logs) === logSignature(b.logs)
	        && JSON.stringify(a.results || []) === JSON.stringify(b.results || []);
	    };

	    const mergeJob = (nextJob) => {
	      if (!nextJob) {
	        if (job.value !== null) job.value = null;
	        lastJobLiveAt.value = '';
	        return;
	      }
	      if (activeStatuses.has(nextJob.status)) lastJobLiveAt.value = nextJob.updatedAt || new Date().toISOString();
	      if (!job.value || job.value.id !== nextJob.id) {
	        job.value = nextJob;
	        return;
	      }
	      if (sameJobPayload(job.value, nextJob)) return;
	      const merged = job.value;
	      for (const [key, value] of Object.entries(nextJob)) {
	        if (key === 'logs') {
	          if (logSignature(merged.logs) !== logSignature(value)) merged.logs = Array.isArray(value) ? value : [];
	        } else if (key === 'results') {
	          if (JSON.stringify(merged.results || []) !== JSON.stringify(value || [])) merged.results = Array.isArray(value) ? value : [];
	        } else if (merged[key] !== value) {
	          merged[key] = value;
	        }
	      }
	    };

    const fetchJobHistory = async (options = {}) => {
      const silent = Boolean(options.silent);
      if (!silent) historyLoading.value = true;
      try {
        const res = await axios.get('/api/history');
        jobHistory.value = (res.data.items || []).filter(item => item.kind === 'run').slice(0, 20);
        adoptLatestActiveJob();
      } catch (error) {
        console.warn('[single-sourcing] 历史记录加载失败:', apiError(error));
      } finally {
        if (!silent) historyLoading.value = false;
      }
    };

    const refreshHistorySilently = () => {
      const now = Date.now();
      if (now - lastHistoryRefreshAt < 5000) return;
      lastHistoryRefreshAt = now;
      fetchJobHistory({ silent: true });
    };

    const historyDownloadUrl = (item) => item?.downloadUrl || (item?.excelExists && item?.id ? `/api/history/${encodeURIComponent(item.id)}/download` : '');
    const openHistoryReview = (item) => {
      if (!item?.id) return;
      window.location.hash = `#/single-sourcing-review?id=${encodeURIComponent(item.id)}`;
    };

    const loadHistoryJob = async (item) => {
      if (!item?.id) return;
      currentJobId.value = item.id;
      if (activeStatuses.has(item.status)) localStorage.setItem('singleSourcingJobId', item.id);
      else localStorage.removeItem('singleSourcingJobId');
      await pollJob();
      if (job.value && activeStatuses.has(job.value.status)) startPolling();
    };

    const switchToJob = (id) => {
      if (!id) return false;
      if (currentJobId.value === id) {
        if (!pollTimer) startPolling();
        else pollJob();
        return true;
      }
      currentJobId.value = id;
      localStorage.setItem('singleSourcingJobId', id);
      startPolling();
      return true;
    };

	    const applyWorkerCurrentJob = (worker) => {
	      const workerJob = worker?.currentJob;
	      if (!workerJob?.id) return false;
	      currentJobId.value = workerJob.id;
	      localStorage.setItem('singleSourcingJobId', workerJob.id);
	      mergeJob(workerJob);
	      if (activeStatuses.has(workerJob.status) && !pollTimer) startPolling();
	      return true;
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
	        liveTick.value = Date.now();
	        pollFailures = 0;
	        if (collectorStatus.value.error && /Network Error|网络|请求失败|timeout/i.test(String(collectorStatus.value.error))) {
	          collectorStatus.value = { ...collectorStatus.value, error: '' };
	        }
	        mergeJob(res.data.job || null);
	        if (job.value && ['done', 'error', 'canceled'].includes(job.value.status)) {
          stopPolling();
          localStorage.removeItem('singleSourcingJobId');
          fetchJobHistory();
        }
      } catch (error) {
        pollFailures += 1;
        if (pollFailures >= 3) {
          const message = apiError(error);
          collectorStatus.value = {
            ...(collectorStatus.value || {}),
            workers: collectorStatus.value.workers || [],
            queue: collectorStatus.value.queue || { queued: 0, active: 0 },
            error: `任务进度连接异常，正在自动重试：${message}`,
          };
          const now = Date.now();
          if (now - lastPollErrorAt > 60000) {
            console.warn('[single-sourcing] 任务进度轮询失败:', message);
            lastPollErrorAt = now;
          }
        }
      }
    };

    const startPolling = () => {
      stopPolling();
      pollFailures = 0;
      pollJob();
	      pollTimer = setInterval(() => {
	        pollJob();
	        refreshHistorySilently();
	        fetchCollectorStatus({ silent: true });
	      }, 1500);
    };

    const restoreActiveJob = async () => {
      adoptWorkerActiveJob();
      if (currentJobId.value && activeJobWorker.value) return;
      const savedId = localStorage.getItem('singleSourcingJobId') || '';
      if (savedId) {
        currentJobId.value = savedId;
        try {
          await pollJob();
          if (job.value && activeStatuses.has(job.value.status)) {
            startPolling();
            return;
          }
        } catch {}
        currentJobId.value = '';
        job.value = null;
        localStorage.removeItem('singleSourcingJobId');
      }
      try {
        const history = await axios.get('/api/history');
        jobHistory.value = (history.data.items || []).filter(item => item.kind === 'run').slice(0, 20);
        const item = jobHistory.value.find(it => activeStatuses.has(it.status));
        if (!item?.id) return;
        switchToJob(item.id);
      } catch {}
    };

    const adoptLatestActiveJob = () => {
      if (adoptWorkerActiveJob()) return;
      const active = jobHistory.value.find(item => activeStatuses.has(item.status));
      if (!active?.id) return;
      const currentIsActive = job.value && activeStatuses.has(job.value.status) && currentJobId.value === job.value.id;
      if (currentIsActive && currentJobId.value === active.id) return;
      if (currentJobId.value === active.id && pollTimer) return;
      switchToJob(active.id);
    };

    adoptWorkerActiveJob = () => {
      const worker = (collectorStatus.value.workers || []).find(w => w.online && w.currentJobId);
      const workerJobId = worker?.currentJobId || '';
      if (!workerJobId) return false;
      if (applyWorkerCurrentJob(worker)) return true;
      return switchToJob(workerJobId);
    };

    const startSingleSourcing = async () => {
      const text = urlsText.value.trim();
      if (!text) {
        ElementPlus.ElMessage.warning('请先粘贴 Ozon 商品链接');
        return;
      }
      await authorizePluginWorker().catch(() => false);
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
	        mergeJob({ id: res.data.jobId, status: res.data.queued ? 'queued' : 'running', phase: res.data.queued ? '等待采集插件/采集端领取' : '已启动', logs: [] });
        ElementPlus.ElMessage.success(res.data.existing ? '已切换到正在执行的单品找货任务' : (canRun.value ? '单品找货任务已创建' : '任务已创建，等待采集插件/采集端领取'));
        fetchJobHistory();
        startPolling();
      } catch (error) {
        ElementPlus.ElMessage.error(apiError(error));
      } finally {
        creating.value = false;
      }
    };

    const cancelJob = async () => {
      const workerJobId = (collectorStatus.value.workers || []).find(w => w.online && w.currentJobId)?.currentJobId || '';
      const targetJobId = workerJobId || currentJobId.value;
      if (!targetJobId) return;
      try {
        await ElementPlus.ElMessageBox.confirm('确定停止当前单品找货任务吗？', '停止任务', { type: 'warning' });
        if (targetJobId !== currentJobId.value) switchToJob(targetJobId);
        const res = await axios.post(`/api/jobs/${encodeURIComponent(targetJobId)}/cancel`, {});
	        if (res.data.job) mergeJob(res.data.job);
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
    const downloadExtension = () => {
      const link = document.createElement('a');
      link.href = `/extension/zhumeng-collector.zip?v=${PLUGIN_ZIP_VERSION}`;
      link.download = 'zhumeng-collector.zip';
      link.click();
    };

	    const handlePageChange = () => { fetchData(); };
	    const handleSizeChange = () => {
	      pagination.currentPage = 1;
	      fetchData();
	    };
	    const handleTabChange = () => {
	      const nextHash = activeTab.value === 'single'
	        ? '#/single-sourcing'
	        : activeTab.value === 'external'
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
        fetchPlatformStatus();
      }
    };

    Vue.onMounted(() => {
      activeTab.value = detectTabFromHash();
      if (activeTab.value !== 'single') {
        fetchData();
        fetchPlatformStatus();
      }
      authorizePluginWorker().catch(() => {});
      fetchCollectorStatus();
      fetchJobHistory().finally(() => restoreActiveJob());
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
      if (activeTab.value !== 'single') {
        fetchData();
        fetchPlatformStatus();
      }
      if (activeTab.value === 'single') {
        authorizePluginWorker().catch(() => {});
        fetchCollectorStatus();
        fetchJobHistory();
      }
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
	    const moneyCny = (value) => `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	    const compactNumber = (value) => {
	      const n = Number(value || 0);
	      if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万`;
	      return n.toLocaleString('zh-CN');
	    };
	    const percentText = (value) => {
	      if (value == null || value === '') return '-';
	      const n = Number(value || 0);
	      return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
	    };
	    const trendColor = (value) => Number(value || 0) >= 0 ? '#10b981' : '#ef4444';
	    const metricMax = (items, key) => Math.max(1, ...((items || []).map(item => Number(item?.[key] || 0))));
	    const barWidth = (value, max) => `${Math.max(6, Math.round((Number(value || 0) / Math.max(1, max)) * 100))}%`;
		    const latestSyncText = Vue.computed(() => overview.value?.data_source?.latest_platform_captured_at ? formatTime(overview.value.data_source.latest_platform_captured_at) : '暂无平台榜单数据');
		    const platformStats = Vue.computed(() => platformStatus.value?.stats || {});
		    const platformCoverageText = Vue.computed(() => {
		      const stats = platformStats.value || {};
		      const categoryTotal = Number(stats.platform_category_total || 0);
		      const total = Number(stats.total || 0);
		      if (!stats.myerp_configured && !categoryTotal) return '平台数据源未配置';
		      if (platformStatus.value?.refreshing) return total ? `后台刷新中 · 已有 ${total} 个商品` : '后台刷新中';
		      if (categoryTotal) return `${categoryTotal} 个平台类目 · ${Number(stats.platform_category_with_gmv || 0)} 个有 GMV`;
		      if (!total) return '暂无 Ozon 平台数据';
		      const sales = Number(stats.with_sales || 0);
		      const price = Number(stats.with_price || 0);
		      return `${total} 个商品 · ${price} 个有价格 · ${sales} 个有销量指标`;
		    });
		    const platformCoverageType = Vue.computed(() => {
		      const stats = platformStats.value || {};
		      if (!stats.myerp_configured && !Number(stats.platform_category_total || 0)) return 'danger';
		      return Number(stats.platform_category_with_gmv || stats.with_sales || 0) > 0 ? 'success' : 'warning';
		    });
	    const currentRows = Vue.computed(() => {
	      const rows = activeTab.value === 'external'
	        ? externalRows.value
	        : activeTab.value === 'product'
	          ? (overview.value.products || [])
	          : activeTab.value === 'store'
	            ? (overview.value.store_ranking || [])
	            : (overview.value.categories || []);
	      if (activeTab.value === 'external') return rows;
	      const start = (pagination.currentPage - 1) * pagination.pageSize;
	      return rows.slice(start, start + pagination.pageSize);
	    });
	    const topCategories = Vue.computed(() => (overview.value.categories || []).slice(0, 18));
	    const productTreemap = Vue.computed(() => (overview.value.categories || []).filter(item => Number(item.gmv_cny || 0) > 0).slice(0, 14));
	    const trendMax = Vue.computed(() => metricMax(overview.value.trends || [], 'gmv_cny'));
	    const priceMax = Vue.computed(() => metricMax(overview.value.price_distribution || [], 'sales_cny'));
	    const priceProductMax = Vue.computed(() => metricMax(overview.value.price_distribution || [], 'product_count'));
	    const productMax = Vue.computed(() => metricMax(overview.value.products || [], 'gmv_cny'));
	    const categoryMax = Vue.computed(() => metricMax(overview.value.categories || [], 'gmv_cny'));
    const topCandidates = (row) => (row.candidates || []).slice(0, Math.max(1, Number(maxCandidates.value || 5)));
    const ozonImage = (row) => row.ozon?.mainImage?.publicUrl || row.ozon?.mainImageUrl || '';
    const proxiedCandidateImage = (url) => {
      const text = String(url || '').trim();
      if (!text || text.startsWith('/')) return text;
      if (/^https?:\/\/([^/]+\.)?(1688|alicdn|alibaba)\.com\//i.test(text)) {
        return `/api/utils/image-proxy?url=${encodeURIComponent(text)}`;
      }
      return text;
    };
    const candidateImage = (candidate) => (
      proxiedCandidateImage(candidate?.localImage?.publicUrl
      || candidate?.localImage?.url
      || candidate?.image
      || candidate?.imageUrl
      || candidate?.picUrl
      || candidate?.mainImage
      || '')
    );
    const candidateMoq = (candidate) => candidate?.moqText || candidate?.minOrderText || candidate?.minOrderQuantity || candidate?.moq || candidate?.minOrder || '';
    const candidateFreight = (candidate) => candidate?.freightText || candidate?.shippingFeeText || candidate?.freight || candidate?.shippingFee || candidate?.logisticsFee || '';
    const candidateWeight = (candidate) => candidate?.weightText || candidate?.weightGram || candidate?.weight || candidate?.packageWeight || '';
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
	      activeTab, tableData, loading, pagination, fetchData, handlePageChange, handleSizeChange, handleTabChange,
	      overview, rangeDays, externalRows, externalTotal, externalStrategy, externalSearch,
	      platformCollectText, platformCollecting, platformStatus, platformStats, platformCoverageText, platformCoverageType,
	      fetchPlatformStatus, refreshPlatformSnapshots, collectPlatformSnapshots,
	      urlsText, maxCandidates, startRow, delayMin, delayMax, maxConsecutiveFailures,
      enable1688, enableAI, creating, currentJobId, job, collectorLoading,
      collectorStatus, canRun, onlineWorkers, currentWorker, collectorStatusText, collectorHealthType,
      collectorHealthText, activeJobWorker, operatorAlert, jobStatusText, liveStatusText, recentLogs, jobResults, isRunning,
      refreshAndAuthorizePlugin, startSingleSourcing, cancelJob, downloadUrl, open1688, downloadExtension, formatWorkerPlatform,
      formatTime, money, topCandidates, ozonImage, historyLoading, jobHistory, fetchJobHistory,
	      historyDownloadUrl, openHistoryReview, loadHistoryJob, jobStatusTagType, formatHistoryRange,
	      logPanel,
	      moneyCny, compactNumber, percentText, trendColor, barWidth, latestSyncText,
	      currentRows, topCategories, productTreemap, trendMax, priceMax, priceProductMax, productMax, categoryMax,
	      percent, aiDecisionText, aiTagType, rowStatusType, rowStatusText,
      candidateReview, selectedCandidateText, candidateImage, candidateMoq, candidateFreight, candidateWeight,
    };
  },
  template: `
    <div class="sourcing-view">
	      <template v-if="activeTab !== 'single'">
	        <div style="display:flex; flex-direction:column; gap:18px">
	          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap">
	            <div>
	              <h2 style="margin:0; font-size:26px; line-height:1.25">选品中心</h2>
		              <div style="margin-top:7px; color:#64748b; font-size:14px">基于 Ozon 平台榜单数据源；不使用自己店铺订单，类目名称统一展示中文</div>
	            </div>
	            <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap">
	              <el-segmented v-model="rangeDays" :options="[{label:'近 7 天',value:7},{label:'近 30 天',value:30},{label:'近 90 天',value:90},{label:'近 180 天',value:180}]" @change="fetchData" />
	              <el-button :loading="loading" @click="fetchData"><el-icon><Refresh /></el-icon>刷新</el-button>
	            </div>
	          </div>

	          <section style="background:#fff; border:1px solid #dbe5f2; border-radius:8px; padding:18px">
	            <div style="display:flex; justify-content:space-between; gap:12px; align-items:center; margin-bottom:14px">
	              <el-tabs v-model="activeTab" @tab-change="handleTabChange" style="min-width:0">
	                <el-tab-pane label="品类大盘" name="category" />
	                <el-tab-pane label="商品大盘" name="product" />
		                <el-tab-pane label="卖家大盘" name="store" />
		                <el-tab-pane label="平台商品" name="external" />
		              </el-tabs>
		              <div style="font-size:12px; color:#94a3b8; white-space:nowrap">平台数据最新：{{ latestSyncText }}</div>
	            </div>

	            <section style="margin-bottom:16px; border:1px solid #e2e8f0; border-radius:8px; padding:14px; background:#f8fafc">
	              <div style="display:flex; justify-content:space-between; gap:14px; align-items:flex-start; flex-wrap:wrap">
	                <div style="min-width:260px; flex:1">
	                  <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap">
	                    <strong>Ozon 平台数据</strong>
	                    <el-tag size="small" :type="platformCoverageType">{{ platformCoverageText }}</el-tag>
	                    <el-tag v-if="platformStatus.refreshing" size="small" type="success">自动刷新中</el-tag>
	                  </div>
	                  <div style="margin-top:6px; color:#64748b; font-size:12px; line-height:1.7">
		                    系统只展示 Ozon 平台侧数据，不使用自己店铺订单。销量、GMV、增长、退货率来自已配置的平台榜单接口；未配置时不会用本店数据冒充。
	                  </div>
	                </div>
	                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end">
		                  <el-button type="primary" :loading="platformCollecting || platformStatus.refreshing" @click="refreshPlatformSnapshots()">同步平台数据</el-button>
	                </div>
	              </div>
	            </section>

	            <div v-if="activeTab !== 'external'" v-loading="loading" style="display:flex; flex-direction:column; gap:18px">
	              <div style="display:grid; grid-template-columns:repeat(5, minmax(150px, 1fr)); border:1px solid #dbe5f2; border-radius:8px; overflow:hidden">
	                <div style="padding:18px; border-right:1px solid #dbe5f2">
		                  <div style="font-size:13px; color:#72809a; font-weight:700">平台估算销售额</div>
		                  <div style="margin-top:12px; font-size:30px; color:#0f172a; font-weight:900">{{ moneyCny(overview.summary?.gmv_cny) }}</div>
		                  <div style="margin-top:8px; font-size:12px; color:#64748b">售价 × 月销量 × 汇率</div>
		                </div>
		                <div style="padding:18px; border-right:1px solid #dbe5f2">
		                  <div style="font-size:13px; color:#72809a; font-weight:700">平台月销量</div>
		                  <div style="margin-top:12px; font-size:30px; color:#0f172a; font-weight:900">{{ compactNumber(overview.summary?.units) }}</div>
		                  <div style="margin-top:8px; font-size:12px; color:#64748b">来自榜单销量字段</div>
		                </div>
		                <div style="padding:18px; border-right:1px solid #dbe5f2">
		                  <div style="font-size:13px; color:#72809a; font-weight:700">动销商品</div>
		                  <div style="margin-top:12px; font-size:30px; color:#0f172a; font-weight:900">{{ compactNumber(overview.summary?.moving_skus) }}</div>
		                  <div style="margin-top:8px; font-size:12px; color:#64748b">有销量的商品</div>
		                </div>
		                <div style="padding:18px; border-right:1px solid #dbe5f2">
		                  <div style="font-size:13px; color:#72809a; font-weight:700">平均售价</div>
		                  <div style="margin-top:12px; font-size:30px; color:#0f172a; font-weight:900">{{ moneyCny(overview.summary?.avg_order_cny) }}</div>
		                  <div style="margin-top:8px; font-size:12px; color:#64748b">销售额 / 月销量</div>
		                </div>
		                <div style="padding:18px">
		                  <div style="font-size:13px; color:#72809a; font-weight:700">覆盖卖家</div>
		                  <div style="margin-top:12px; font-size:30px; color:#0f172a; font-weight:900">{{ compactNumber(overview.summary?.seller_count) }}</div>
		                  <div style="margin-top:8px; font-size:12px; color:#64748b">按 Ozon 卖家名去重</div>
	                </div>
	              </div>

	              <div v-if="activeTab === 'category'" style="display:grid; grid-template-columns:minmax(0, 1.4fr) minmax(360px, .9fr); gap:16px; align-items:start">
	                <section style="border:1px solid #e2e8f0; border-radius:8px; padding:16px; min-width:0">
	                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px">
	                    <strong>品类热力图</strong>
		                    <span style="font-size:12px; color:#94a3b8">面积按平台估算销售额</span>
	                  </div>
	                  <div style="display:grid; grid-template-columns:repeat(6, minmax(90px, 1fr)); grid-auto-rows:86px; gap:8px">
	                    <div v-for="cat in topCategories" :key="cat.category_id" :style="{gridColumn: Number(cat.gmv_cny||0) > categoryMax*0.25 ? 'span 2' : 'span 1', background: Number(cat.growth_rate||0) >= 0 ? '#d9f5e8' : '#ffe4e6', border:'1px solid ' + (Number(cat.growth_rate||0) >= 0 ? '#b7ebd0' : '#fecdd3'), borderRadius:'6px', padding:'10px', display:'flex', flexDirection:'column', justifyContent:'space-between', minWidth:0}">
	                      <div style="font-weight:800; color:#1f2937; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">{{ cat.category_name_zh }}</div>
	                      <div>
	                        <div style="font-size:12px; color:#64748b">{{ moneyCny(cat.gmv_cny) }}</div>
	                        <div :style="{fontSize:'13px', fontWeight:800, color:trendColor(cat.growth_rate)}">{{ percentText(cat.growth_rate) }}</div>
	                      </div>
	                    </div>
	                  </div>
	                </section>
	                <section style="border:1px solid #e2e8f0; border-radius:8px; padding:16px; min-width:0">
		                  <strong>采集样本趋势</strong>
	                  <div style="margin-top:18px; height:260px; display:flex; align-items:end; gap:10px; border-bottom:1px solid #e2e8f0; padding:0 8px">
	                    <div v-for="point in overview.trends" :key="point.date" style="flex:1; min-width:10px; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; gap:7px">
	                      <div :title="point.date + ' ' + moneyCny(point.gmv_cny)" :style="{width:'70%', minWidth:'8px', height:barWidth(point.gmv_cny, trendMax), background:'#79b7ff', borderRadius:'6px 6px 0 0'}"></div>
	                      <span style="font-size:11px; color:#94a3b8">{{ point.date }}</span>
	                    </div>
	                  </div>
	                </section>
	              </div>

	              <div v-if="activeTab === 'product'" style="display:grid; grid-template-columns:minmax(0, 1fr) minmax(420px, .9fr); gap:16px; align-items:start">
	                <section style="border:1px solid #e2e8f0; border-radius:8px; padding:16px; min-width:0">
		                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px"><strong>品类销售额占比</strong><span style="font-size:12px;color:#94a3b8">Ozon 平台样本聚合</span></div>
	                  <div style="display:grid; grid-template-columns:repeat(5, minmax(90px,1fr)); grid-auto-rows:88px; gap:8px">
	                    <div v-for="cat in productTreemap" :key="cat.category_id" :style="{gridColumn:Number(cat.gmv_cny||0)>categoryMax*0.25?'span 2':'span 1', background:'#8b7cf6', color:'#fff', borderRadius:'6px', padding:'10px', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', textAlign:'center', minWidth:0}">
	                      <div style="font-weight:800; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%">{{ cat.category_name_zh }}</div>
	                      <div style="font-size:12px; opacity:.9">{{ moneyCny(cat.gmv_cny) }}</div>
	                    </div>
	                  </div>
	                </section>
	                <section style="border:1px solid #e2e8f0; border-radius:8px; padding:16px; min-width:0">
	                  <strong>售价分布</strong>
	                  <div style="margin-top:16px; display:grid; grid-template-columns:1fr 1fr; gap:20px">
	                    <div>
	                      <div style="font-size:13px; color:#64748b; font-weight:800; margin-bottom:10px">商品数</div>
	                      <div v-for="band in overview.price_distribution" :key="'p'+band.label" style="display:grid; grid-template-columns:56px 1fr 54px; align-items:center; gap:8px; margin:12px 0">
	                        <span style="font-size:12px; color:#94a3b8">{{ band.label }}</span><div style="height:12px; background:#eef2ff; border-radius:8px"><div :style="{height:'12px', width:barWidth(band.product_count, priceProductMax), background:'#7467f6', borderRadius:'8px'}"></div></div><span style="font-size:12px; color:#64748b">{{ compactNumber(band.product_count) }}</span>
	                      </div>
	                    </div>
	                    <div>
	                      <div style="font-size:13px; color:#64748b; font-weight:800; margin-bottom:10px">销售额</div>
	                      <div v-for="band in overview.price_distribution" :key="'s'+band.label" style="display:grid; grid-template-columns:56px 1fr 70px; align-items:center; gap:8px; margin:12px 0">
	                        <span style="font-size:12px; color:#94a3b8">{{ band.label }}</span><div style="height:12px; background:#eef2ff; border-radius:8px"><div :style="{height:'12px', width:barWidth(band.sales_cny, priceMax), background:'#7467f6', borderRadius:'8px'}"></div></div><span style="font-size:12px; color:#64748b">{{ compactNumber(band.sales_cny) }}</span>
	                      </div>
	                    </div>
	                  </div>
	                </section>
	              </div>

	              <el-table :data="currentRows" stripe border style="width:100%">
	                <template v-if="activeTab === 'category'">
	                  <el-table-column label="排名" type="index" width="70" />
	                  <el-table-column label="中文品类" min-width="190"><template #default="{row}"><strong>{{ row.category_name_zh }}</strong><div style="font-size:12px;color:#94a3b8">ID {{ row.category_id }}</div></template></el-table-column>
	                  <el-table-column label="Top3 商品" min-width="220"><template #default="{row}"><div style="display:flex; gap:6px"><el-image v-for="p in row.top_products" :key="p.name" :src="p.image" fit="cover" style="width:38px;height:38px;border-radius:6px;background:#f1f5f9" /></div></template></el-table-column>
		                  <el-table-column label="估算销售额" width="140" align="right"><template #default="{row}">{{ moneyCny(row.gmv_cny) }}</template></el-table-column>
		                  <el-table-column label="销量" prop="units" width="100" align="right" sortable />
		                  <el-table-column label="卖家数" prop="seller_count" width="100" align="right" />
		                  <el-table-column label="增长" width="100" align="right"><template #default="{row}"><span :style="{color:trendColor(row.growth_rate), fontWeight:800}">{{ percentText(row.growth_rate) }}</span></template></el-table-column>
		                  <el-table-column label="机会分" width="100" align="right"><template #default="{row}"><el-tag>{{ row.opportunity_score }}</el-tag></template></el-table-column>
	                </template>
	                <template v-else-if="activeTab === 'product'">
	                  <el-table-column label="排名" type="index" width="70" />
		                  <el-table-column label="商品" min-width="320"><template #default="{row}"><div style="display:flex; gap:10px; align-items:center; min-width:0"><el-image :src="row.image" fit="cover" style="width:54px;height:54px;border-radius:6px;background:#f1f5f9"/><div style="min-width:0"><a :href="row.ozon_url" target="_blank" style="display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:800; color:#1d4ed8">{{ row.name }}</a><div style="font-size:12px;color:#94a3b8">SKU {{ row.sku || '-' }} · {{ row.category_name_zh }}</div></div></div></template></el-table-column>
		                  <el-table-column label="卖家" prop="seller_name" width="150" show-overflow-tooltip />
		                  <el-table-column label="售价" width="110" align="right"><template #default="{row}">{{ moneyCny(row.price_cny) }}</template></el-table-column>
		                  <el-table-column label="估算销售额" width="140" align="right"><template #default="{row}">{{ moneyCny(row.gmv_cny) }}</template></el-table-column>
		                  <el-table-column label="销量" prop="units" width="90" align="right" sortable />
		                  <el-table-column label="评价" prop="review_count" width="90" align="right" />
		                  <el-table-column label="跟卖数" prop="seller_count" width="90" align="right" />
	                </template>
	                <template v-else-if="activeTab === 'store'">
	                  <el-table-column label="排名" type="index" width="70" />
		                  <el-table-column label="卖家" prop="seller_name" min-width="180" show-overflow-tooltip />
		                  <el-table-column label="估算销售额" width="140" align="right"><template #default="{row}">{{ moneyCny(row.gmv_cny) }}</template></el-table-column>
		                  <el-table-column label="月销量" prop="units" width="110" align="right" sortable />
		                  <el-table-column label="动销商品" prop="moving_skus" width="110" align="right" />
		                  <el-table-column label="商品数" prop="product_count" width="100" align="right" />
		                  <el-table-column label="均价" width="120" align="right"><template #default="{row}">{{ moneyCny(row.avg_order_cny) }}</template></el-table-column>
		                  <el-table-column label="评价数" prop="review_count" width="110" align="right" />
	                </template>
	              </el-table>
	            </div>

	            <div v-else>
		              <el-alert title="平台商品来自 Ozon 公开榜单/商品采集数据；当前版本不接第三方实时接口。" type="info" :closable="false" show-icon style="margin-bottom:12px" />
	              <div style="display:flex; justify-content:space-between; gap:12px; margin-bottom:12px; flex-wrap:wrap">
	                <div style="display:flex; gap:8px">
	                  <el-select v-model="externalStrategy" style="width:130px" @change="fetchData"><el-option label="热销" value="hot"/><el-option label="新品" value="new"/><el-option label="潜力" value="potential"/><el-option label="蓝海" value="blue_ocean"/><el-option label="全部" value="all"/></el-select>
	                  <el-input v-model="externalSearch" placeholder="SKU / 标题 / 卖家" clearable style="width:300px" @keyup.enter="fetchData" />
	                  <el-button type="primary" @click="fetchData">查询</el-button>
	                </div>
	              </div>
	              <el-table :data="currentRows" v-loading="loading" stripe border style="width:100%">
	                <el-table-column label="排名" type="index" width="70" />
		                <el-table-column label="商品" min-width="320"><template #default="{row}"><div style="display:flex; gap:10px; align-items:center"><el-image :src="row.main_image" fit="cover" style="width:54px;height:54px;border-radius:6px;background:#f1f5f9"/><div style="min-width:0"><a :href="row.ozon_url" target="_blank" style="font-weight:800; color:#1d4ed8">{{ row.title || row.sku }}</a><div style="font-size:12px;color:#94a3b8">SKU {{ row.sku }} · {{ row.category_name_zh || '未分类' }}</div></div></div></template></el-table-column>
	                <el-table-column label="价格" width="110" align="right"><template #default="{row}">₽ {{ Number(row.price_rub || 0).toFixed(0) }}</template></el-table-column>
	                <el-table-column label="月销量" prop="monthly_sales" width="100" align="right" />
	                <el-table-column label="评价" prop="review_count" width="90" align="right" />
	                <el-table-column label="卖家" prop="seller_name" min-width="150" show-overflow-tooltip />
	                <el-table-column label="来源" width="170"><template #default="{row}"><div>{{ row.source_name || '-' }}</div><div style="font-size:11px;color:#94a3b8">{{ formatTime(row.source_captured_at) }}</div></template></el-table-column>
	              </el-table>
	            </div>

	            <div style="display:flex; justify-content:flex-end; margin-top:14px">
	              <el-pagination
	                v-model:current-page="pagination.currentPage"
	                v-model:page-size="pagination.pageSize"
	                :total="pagination.total"
	                :page-sizes="[20,50,100]"
	                layout="total, sizes, prev, pager, next"
	                @current-change="handlePageChange"
	                @size-change="handleSizeChange"
	              />
	            </div>
	          </section>
	        </div>
	      </template>

      <template v-else>
        <div style="display:flex; flex-direction:column; gap:16px; width:100%">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap">
            <div>
              <h2 style="margin:0; font-size:22px; line-height:1.3">单品找货工作台</h2>
              <div style="margin-top:6px; color:#606266; font-size:13px">Ozon 商品采集、1688 以图搜货、MOQ/运费/重量诊断、AI 审核和 Excel 导出</div>
            </div>
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end">
              <el-tooltip placement="bottom" :content="collectorStatusText">
                <el-tag :type="collectorHealthType" effect="light">{{ collectorHealthText }}</el-tag>
              </el-tooltip>
              <el-button type="warning" size="small" @click="downloadExtension">下载插件</el-button>
              <el-button size="small" :loading="collectorLoading" @click="refreshAndAuthorizePlugin">刷新/重新授权插件</el-button>
            </div>
          </div>

          <el-alert
            v-if="operatorAlert"
            :type="operatorAlert.type"
            :title="operatorAlert.title"
            :description="operatorAlert.message"
            show-icon
            :closable="false"
          />

          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(360px, 1fr)); gap:16px; align-items:start">
            <section style="background:#fff; border:1px solid #ebeef5; border-radius:6px; padding:16px">
              <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:14px">
                <strong>任务参数</strong>
                <el-tag size="small" type="info">默认候选数 5</el-tag>
              </div>
              <el-form label-position="top">
                <el-form-item label="Ozon 链接（每行一个）">
                  <el-input v-model="urlsText" type="textarea" :rows="10" spellcheck="false" placeholder="https://www.ozon.ru/product/..." />
                </el-form-item>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px">
                  <el-form-item label="每商品候选数"><el-input-number v-model="maxCandidates" :min="1" :max="20" style="width:100%" /></el-form-item>
                  <el-form-item label="从第几行开始"><el-input-number v-model="startRow" :min="1" style="width:100%" /></el-form-item>
                  <el-form-item label="连续异常停止"><el-input-number v-model="maxConsecutiveFailures" :min="1" :max="20" style="width:100%" /></el-form-item>
                  <el-form-item label="间隔最小（秒）"><el-input-number v-model="delayMin" :min="1" style="width:100%" /></el-form-item>
                  <el-form-item label="间隔最大（秒）"><el-input-number v-model="delayMax" :min="1" style="width:100%" /></el-form-item>
                </div>
                <div style="display:flex; gap:18px; align-items:center; margin:4px 0 16px; flex-wrap:wrap">
                  <el-checkbox v-model="enable1688">1688 以图搜货</el-checkbox>
                  <el-checkbox v-model="enableAI">AI 严格审核</el-checkbox>
                </div>
                <div style="display:flex; gap:10px; flex-wrap:wrap">
                  <el-button type="primary" :loading="creating" :disabled="isRunning" @click="startSingleSourcing">开始采集</el-button>
                  <el-button type="danger" :disabled="!currentJobId || !isRunning" @click="cancelJob">停止</el-button>
                  <el-button @click="open1688">打开 1688 首页</el-button>
                  <el-button v-if="downloadUrl" type="success" tag="a" :href="downloadUrl">下载 Excel</el-button>
                </div>
              </el-form>
            </section>

            <section style="background:#fff; border:1px solid #ebeef5; border-radius:6px; padding:16px; min-width:0">
              <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:14px">
	                <div>
	                  <strong>实时进度</strong>
	                  <div style="color:#909399; font-size:12px; margin-top:4px">{{ jobStatusText }}</div>
	                  <div v-if="liveStatusText" style="color:#16a34a; font-size:12px; margin-top:4px">{{ liveStatusText }}</div>
	                </div>
                <div style="display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end">
                  <el-tag size="small" :type="canRun ? 'success' : 'info'">当前在线 {{ onlineWorkers.length }}</el-tag>
                  <el-tag v-if="currentWorker" size="small" type="info">{{ currentWorker.workerName || currentWorker.name || currentWorker.id || '当前采集端' }}</el-tag>
                </div>
              </div>
              <pre ref="logPanel" style="margin:0; width:100%; box-sizing:border-box; min-height:318px; max-height:520px; overflow:auto; background:#172033; color:#d8e3f0; padding:14px 18px; border-radius:6px; line-height:1.55; white-space:pre-wrap; word-break:break-word">{{ recentLogs }}</pre>
            </section>
          </div>

          <section style="background:#fff; border:1px solid #ebeef5; border-radius:6px; padding:16px; min-width:0">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:14px">
              <strong>结果</strong>
              <span style="color:#909399; font-size:13px">{{ jobResults.length }} 条 · 最多展示 {{ maxCandidates }} 个候选/商品</span>
            </div>
            <el-table :data="jobResults" border stripe empty-text="还没有结果。开始任务后会逐行显示 Ozon、1688 候选、MOQ、运费、重量、AI 审核和失败原因。" style="width:100%">
              <el-table-column label="行" width="70">
                <template #default="{ row, $index }">
                  {{ row.sourceRow || $index + 1 }}
                </template>
              </el-table-column>
              <el-table-column label="Ozon 商品" min-width="300">
                <template #default="{ row }">
                  <a :href="row.url" target="_blank" rel="noreferrer">{{ row.ozon?.title || row.url }}</a>
                  <div style="color:#909399; font-size:12px; margin-top:4px">
                    SKU {{ row.ozon?.sku || row.ozon?.productId || '-' }} · {{ money(row.ozon?.currentBlackPriceCny || row.ozon?.finalBlackPriceCny) || '-' }}
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="主图" width="96">
                <template #default="{ row }">
                  <el-image v-if="ozonImage(row)" :src="ozonImage(row)" style="width:56px;height:56px;border-radius:6px" fit="cover" :preview-src-list="[ozonImage(row)]" preview-teleported />
                </template>
              </el-table-column>
              <el-table-column label="1688 候选" min-width="560">
                <template #default="{ row }">
                  <div v-if="topCandidates(row).length">
                    <div v-for="c in topCandidates(row)" :key="c.rank + c.link" style="display:grid; grid-template-columns:52px minmax(0, 1fr); gap:10px; margin-bottom:10px">
                      <el-image v-if="candidateImage(c)" :src="candidateImage(c)" style="width:48px;height:48px;border-radius:6px" fit="cover" :preview-src-list="[candidateImage(c)]" preview-teleported />
                      <div style="min-width:0">
                        <a :href="c.link" target="_blank" rel="noreferrer">{{ c.rank }}. {{ c.title }}</a>
                        <div style="color:#606266; font-size:12px; margin-top:4px; display:flex; gap:8px; flex-wrap:wrap">
                          <span>价格 {{ c.price || c.priceDetails || '-' }}</span>
                          <span>MOQ {{ candidateMoq(c) || '未取到' }}</span>
                          <span>运费 {{ candidateFreight(c) || '未公开/需地区' }}</span>
                          <span>重量 {{ candidateWeight(c) || '未取到' }}</span>
                        </div>
                        <div v-if="candidateReview(row, c.rank)?.verdict || candidateReview(row, c.rank)?.reason" style="color:#909399; font-size:12px; margin-top:4px">
                          {{ candidateReview(row, c.rank)?.verdict || 'AI 诊断' }}
                          <span v-if="candidateReview(row, c.rank)?.confidence"> · {{ percent(candidateReview(row, c.rank).confidence) }}</span>
                          <span v-if="candidateReview(row, c.rank)?.reason"> · {{ candidateReview(row, c.rank).reason }}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <span v-else style="color:#909399">{{ row.searchError || '无候选，建议打开 1688 检查登录/验证码后从该行继续' }}</span>
                </template>
              </el-table-column>
              <el-table-column label="AI 审核" min-width="340">
                <template #default="{ row }">
                  <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap">
                    <el-tag :type="aiTagType(row.aiReview?.decision)">{{ aiDecisionText(row.aiReview?.decision) }}</el-tag>
                    <span v-if="selectedCandidateText(row)" style="font-size:12px; color:#606266">{{ selectedCandidateText(row) }}</span>
                    <span v-if="row.aiReview?.confidence !== undefined" style="font-size:12px; color:#909399">置信度 {{ percent(row.aiReview.confidence) }}</span>
                  </div>
                  <div v-if="row.aiReview?.reason" style="color:#606266; font-size:12px; margin-top:6px; line-height:1.45">{{ row.aiReview.reason }}</div>
                </template>
              </el-table-column>
              <el-table-column label="状态 / 错误" min-width="240">
                <template #default="{ row }">
                  <el-tag :type="rowStatusType(row)">{{ rowStatusText(row) }}</el-tag>
                </template>
              </el-table-column>
            </el-table>
          </section>

          <section style="background:#fff; border:1px solid #ebeef5; border-radius:6px; padding:16px; min-width:0" v-loading="historyLoading">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:12px">
              <strong>历史记录</strong>
              <el-button size="small" text @click="fetchJobHistory">刷新</el-button>
            </div>
            <el-empty v-if="!jobHistory.length" description="暂无单品找货记录。任务完成、失败或中断后都会保留在这里下载 Excel。" :image-size="80" />
            <el-table v-else :data="jobHistory" border stripe style="width:100%">
              <el-table-column label="最近任务" min-width="360">
                <template #default="{ row }">
                  <div style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">{{ row.firstUrl || row.id }}</div>
                  <div v-if="row.phase" style="color:#606266; font-size:12px; margin-top:4px">{{ row.phase }}</div>
                </template>
              </el-table-column>
              <el-table-column label="范围" width="140">
                <template #default="{ row }">{{ formatHistoryRange(row) }}</template>
              </el-table-column>
              <el-table-column label="进度" width="130">
                <template #default="{ row }">{{ row.processed || 0 }}/{{ row.total || row.sourceTotal || 0 }}</template>
              </el-table-column>
              <el-table-column label="更新时间" width="190">
                <template #default="{ row }">{{ formatTime(row.updatedAt || row.createdAt) }}</template>
              </el-table-column>
              <el-table-column label="状态" width="110">
                <template #default="{ row }"><el-tag size="small" :type="jobStatusTagType(row.status)">{{ row.status || '-' }}</el-tag></template>
              </el-table-column>
              <el-table-column label="操作" width="280" fixed="right">
                <template #default="{ row }">
                  <el-button size="small" @click="loadHistoryJob(row)">查看</el-button>
                  <el-button size="small" type="primary" plain @click="openHistoryReview(row)">结果核对</el-button>
                  <el-button
                    v-if="historyDownloadUrl(row)"
                    size="small"
                    tag="a"
                    :href="historyDownloadUrl(row)"
                    target="_blank"
                    rel="noreferrer"
                  >下载 Excel</el-button>
                </template>
              </el-table-column>
            </el-table>
          </section>
        </div>
      </template>
    </div>
  `
};
