window.MarketDiscoveryView = {
  setup() {
    const activeTab = Vue.ref('category');
    const loading = Vue.ref(false);
    const marketLoading = Vue.ref(false);
    const queueLoading = Vue.ref(false);
    const selectedMarketRows = Vue.ref([]);
    const selectedQueueRows = Vue.ref([]);
    const rulesOnly = Vue.ref(false);
    const detailDrawer = Vue.reactive({ visible: false, loading: false, item: null, events: [], note: '' });
    const marketRows = Vue.ref([]);
    const queueRows = Vue.ref([]);
    const dashboard = Vue.ref(null);
    const collectorStatus = Vue.ref(null);
    const collectorResult = Vue.ref(null);
    const collectorLoading = Vue.ref(false);
    const workerStatus = Vue.ref({ workers: [], queue: { queued: 0, active: 0 } });
    const workerStatusLoading = Vue.ref(false);
    const sourcingJobState = Vue.ref(null);
    const marketView = Vue.ref('product');
    const marketSource = Vue.ref({ policy: '', note: '', freshness: {} });
    const discoveryState = Vue.ref(null);
    const defaultGeoRules = () => ({
      geo_enabled: true,
      min_blue_ocean_score: 62,
      min_sales_30d: 100,
      max_seller_count: 25,
      max_risk_score: 55,
      min_profit_score: 45,
      require_source_fresh_days: 14,
      prefer_content_gap: true,
      block_high_certification_risk: true,
    });
    const settings = Vue.reactive({ enabled: false, daily_quota: 30, min_profit_rate: 0.2, max_ai_cost_cny: 50, submit_to_ozon: false, rules: defaultGeoRules() });
    const filters = Vue.reactive({ strategy: 'blue_ocean', search: '', stage: 'all', rank: 'product' });
    const marketPage = Vue.reactive({ page: 1, size: 30, total: 0 });
    const queuePage = Vue.reactive({ page: 1, size: 30, total: 0 });
    const categoryRows = Vue.ref([]);
    const categoryLoading = Vue.ref(false);
    const selectedCategory = Vue.ref('');
    const selectedCategoryLabel = Vue.ref('');
    function clearCategory() {
      selectedCategory.value = '';
      selectedCategoryLabel.value = '';
      marketPage.page = 1;
      loadMarket();
    }
    const reviewRows = Vue.ref([]);
    const reviewLoading = Vue.ref(false);
    const reviewStage = Vue.ref('ready,submitted,listed');

    const storeId = () => String(window.getCurrentStoreId?.() || localStorage.getItem('currentStoreId') || '')
      .split(',').map(value => value.trim()).find(Boolean) || '';
    const errorText = error => error?.response?.data?.error || error?.message || '请求失败';
    const moneyRub = value => Number(value || 0) > 0 ? `₽${Number(value).toFixed(0)}` : '-';
    const formatTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
    const normalizeRules = raw => ({ ...defaultGeoRules(), ...(raw && typeof raw === 'object' ? raw : {}) });
    const hydrateSettings = raw => {
      Object.assign(settings, raw || {});
      settings.rules = normalizeRules(settings.rules);
    };
    const payloadOf = row => {
      const raw = row?.source_payload || row?.payload?.source_payload || row?.payload || {};
      if (raw && typeof raw === 'object') return raw;
      try { return JSON.parse(raw); } catch { return {}; }
    };
    const isDzRow = row => {
      const source = `${row?.source_name || row?.payload?.source_name || ''}`.toLowerCase();
      const payload = payloadOf(row);
      return source.includes('dz_blue_ocean') || payload.blueOceanScore != null || payload.blue_ocean_score != null || payload.demandScore != null;
    };
    const scoreText = value => value == null || value === '' ? '-' : Number(value).toFixed(1);
    const scoreColor = value => Number(value || 0) >= 75 ? '#16a34a' : Number(value || 0) >= 62 ? '#2563eb' : Number(value || 0) >= 48 ? '#d97706' : '#64748b';
    // 蓝海分归一化到 0-100：dz 数据为 0-1 的 blueOceanScore，旧数据为 0-100
    const blueScore = row => {
      const payload = payloadOf(row);
      const raw = payload.blueOceanScore ?? payload.blue_ocean_score ?? row?.opportunity_score;
      if (raw == null || raw === '') return 0;
      const value = Number(raw);
      if (!Number.isFinite(value)) return 0;
      return value > 1 && value <= 100 ? value : Math.round(value * 1000) / 10;
    };
    const blueLevel = row => {
      const payload = payloadOf(row);
      return payload.opportunity_level || (blueScore(row) >= 75 ? 'A' : blueScore(row) >= 62 ? 'B' : blueScore(row) >= 48 ? 'C' : 'D');
    };
    // 信号读取：兼容 dz 驼峰（demandScore/competitionScore/salesDynamics/conversion）与旧下划线命名
    const signalValue = (row, key) => {
      const payload = payloadOf(row);
      const value = payload[key] ?? payload[{
        demand: 'demandScore', competition: 'competitionScore', growth: 'salesDynamics',
        conversion: 'conversion', profit: 'profitScore', risk: 'riskScore', content: 'contentGapScore',
      }[key]] ?? row[key];
      return value == null || value === '' ? null : Number(value);
    };
    const signalText = (row, key) => {
      const value = signalValue(row, key);
      return value == null ? '-' : key === 'growth' || key === 'conversion' ? `${Number(value).toFixed(1)}%` : Number(value).toFixed(0);
    };
    const rowReasons = row => {
      const reasons = payloadOf(row).reasons;
      if (reasons) return reasons;
      if (isDzRow(row)) {
        const parts = [];
        if (signalValue(row, 'demand') != null) parts.push(`需求分 ${signalText(row, 'demand')}`);
        if (signalValue(row, 'competition') != null) parts.push(`竞争分 ${signalText(row, 'competition')}`);
        if (signalValue(row, 'growth') != null) parts.push(`增速 ${signalText(row, 'growth')}`);
        if (signalValue(row, 'conversion') != null) parts.push(`转化 ${signalText(row, 'conversion')}`);
        return parts.length ? parts.join(' · ') : '蓝海采集数据，建议按蓝海分和风险复核。';
      }
      return 'Ozon 榜单候选，建议先看销量、评论和卖家数。';
    };
    // 机会标签：蓝海商品 / 热销 / 蓝海关键词
    const sourceBadgeText = row => {
      const rank = payloadOf(row).rank || row?.strategy_type;
      if (rank === 'blue_keyword') return '蓝海关键词';
      if (row?.strategy_type === 'hot' || rank === 'hot') return '热销';
      return '蓝海商品';
    };
    const sourceBadgeType = row => {
      const rank = payloadOf(row).rank || row?.strategy_type;
      if (rank === 'blue_keyword') return 'warning';
      if (row?.strategy_type === 'hot' || rank === 'hot') return 'info';
      return 'success';
    };
    const rowTitle = row => row?.title || row?.product_name || payloadOf(row).product_name || payloadOf(row).keyword || row?.sku || '-';
    const rowSku = row => row?.sku || row?.source_sku || payloadOf(row).sku || payloadOf(row).product_key || '';
    const rowBrand = row => row?.brand || payloadOf(row).brand || '';
    const rowImage = row => row?.main_image || row?.image_url || payloadOf(row).image_url || payloadOf(row).main_image || '';
    const rowUrl = row => row?.ozon_url || row?.source_url || payloadOf(row).source_url || (rowSku(row) ? `https://www.ozon.ru/product/${rowSku(row)}/` : '');
    const rowCategory = row => row?.category_name_zh || row?.category_name || row?.category || payloadOf(row).category3 || payloadOf(row).category || '未分类';
    const rowPrice = row => row?.price_rub ?? row?.avg_price ?? payloadOf(row).avg_price ?? payloadOf(row).price_rub;
    const rowSales = row => row?.monthly_sales ?? row?.sales_30d ?? payloadOf(row).sales_30d ?? payloadOf(row).monthly_sales;
    const rowRevenue = row => row?.revenue_30d ?? row?.revenue_rub ?? row?.sales_amount_rub ?? payloadOf(row).revenue_30d ?? payloadOf(row).revenue_rub;
    const rowGrowth = row => row?.gmv_growth ?? row?.growth_30d ?? payloadOf(row).growth_30d;
    const stageLabels = {
      discovered: '已发现',
      collected: '已采集',
      sourcing: '1688 找货',
      materials: '资料完成',
      images: '图片完成',
      pricing: '核价完成',
      ready: '待上架',
      submitted: '已提交 Ozon',
      ozon_fix: 'Ozon 待更正',
      listed: '已上架',
    };
    const statusLabels = { queued: '排队中', running: '处理中', paused: '已暂停', needs_human: '待人工', failed: '失败', done: '完成' };
    const riskTypes = { low: 'success', normal: 'warning', high: 'danger' };

    async function loadDashboard() {
      if (!storeId()) return;
      const response = await axios.get('/api/auto-listing/dashboard', { params: { store_id: storeId() } });
      dashboard.value = response.data;
      hydrateSettings(response.data.settings || {});
    }

    async function loadMarket() {
      marketLoading.value = true;
      try {
        const response = await axios.get('/api/sourcing/bestsellers', {
          params: {
            view: marketView.value,
            store_id: storeId(),
            strategy: filters.strategy,
            rank: filters.rank,
            search: filters.search,
            category: selectedCategory.value,
            limit: marketPage.size,
            offset: (marketPage.page - 1) * marketPage.size,
          },
        });
        marketRows.value = response.data.items || [];
        marketPage.total = Number(response.data.total || 0);
        marketSource.value = {
          policy: response.data.source_policy || '',
          note: response.data.note || '',
          freshness: response.data.freshness || {},
        };
        selectedMarketRows.value = [];
        if ((response.data.items || []).some(row => row.row_type !== 'category')) discoveryState.value = null;
      } catch (error) { ElementPlus.ElMessage.error(errorText(error)); }
      finally { marketLoading.value = false; }
    }

    async function loadCategoryAnalysis() {
      categoryLoading.value = true;
      try {
        const response = await axios.get('/api/sourcing/category-analysis', { params: { limit: 100 } });
        categoryRows.value = response.data.items || [];
      } catch (error) { ElementPlus.ElMessage.error(errorText(error)); }
      finally { categoryLoading.value = false; }
    }

    // 审核上架：加载待上架/已提交/已上架 阶段的队列项（主流程 ⑤）
    async function loadReview() {
      if (!storeId()) return;
      reviewLoading.value = true;
      try {
        const response = await axios.get('/api/auto-listing/items', {
          params: {
            store_id: storeId(),
            stage: reviewStage.value,
            limit: 100,
            offset: 0,
          },
        });
        reviewRows.value = response.data.items || [];
      } catch (error) { ElementPlus.ElMessage.error(errorText(error)); }
      finally { reviewLoading.value = false; }
    }

    // 点击类目 → 跳到商品机会并按该类目过滤（合并行传多个俄语原名）
    function browseCategory(row) {
      const names = Array.isArray(row.ru_names) && row.ru_names.length ? row.ru_names : [row.category_name || ''];
      const ids = Array.isArray(row.category_ids) && row.category_ids.length ? row.category_ids : [];
      selectedCategory.value = [...ids, ...names].filter(Boolean).join(',');
      selectedCategoryLabel.value = row.category_name_zh || names.join(' / ');
      filters.rank = 'product';
      marketPage.page = 1;
      activeTab.value = 'overview';
      loadMarket();
    }

    async function loadQueue() {
      if (!storeId()) return;
      queueLoading.value = true;
      try {
        const response = await axios.get('/api/auto-listing/items', {
          params: {
            store_id: storeId(),
            stage: filters.stage,
            search: filters.search,
            limit: queuePage.size,
            offset: (queuePage.page - 1) * queuePage.size,
          },
        });
        queueRows.value = response.data.items || [];
        queuePage.total = Number(response.data.total || 0);
        selectedQueueRows.value = [];
      } catch (error) { ElementPlus.ElMessage.error(errorText(error)); }
      finally { queueLoading.value = false; }
    }

    async function loadCollectorStatus() {
      try {
        const response = await axios.get('/api/sourcing/opportunity-collector/status');
        collectorStatus.value = response.data || null;
      } catch (error) {
        collectorStatus.value = null;
      }
    }

    async function refreshAll() {
      if (!storeId()) return ElementPlus.ElMessage.warning('请先选择店铺');
      loading.value = true;
      try {
        await Promise.all([loadDashboard(), loadMarket(), loadCategoryAnalysis(), loadQueue(), loadCollectorStatus()]);
      } finally { loading.value = false; }
    }

    async function runOpportunityCollector() {
      collectorLoading.value = true;
      try {
        const response = await axios.post('/api/sourcing/opportunity-collector/run', {
          wait: true,
          limit: 30,
        });
        collectorResult.value = response.data || null;
        const imported = Number(response.data?.imported || 0);
        if (imported > 0) {
          ElementPlus.ElMessage.success(`已采集 ${imported} 个 Ozon 商品候选`);
          marketView.value = 'product';
          marketPage.page = 1;
        } else {
          ElementPlus.ElMessage.warning(response.data?.note || '没有采集到商品候选，请查看页面提示');
        }
        await loadCollectorStatus();
        await loadMarket();
      } catch (error) { ElementPlus.ElMessage.error(errorText(error)); }
      finally { collectorLoading.value = false; }
    }

    async function discoverSelected(limit = 20) {
      if (!storeId()) return ElementPlus.ElMessage.warning('请先选择店铺');
      const sourceRows = selectedMarketRows.value.filter(row => row.row_type !== 'category');
      if (!sourceRows.length) return ElementPlus.ElMessage.warning('请先勾选商品机会。');
      const sourceIds = sourceRows.map(row => row.id);
      try {
        const response = await axios.post('/api/auto-listing/discover', {
          store_id: storeId(),
          source_ids: sourceIds,
          strategy: filters.strategy,
          limit: sourceIds.length ? sourceIds.length : limit,
        });
        ElementPlus.ElMessage.success(`已加入找货候选 ${response.data.insertedCount || 0} 个商品`);
        activeTab.value = 'pipeline';
        await Promise.all([loadDashboard(), loadQueue(), loadMarket()]);
      } catch (error) { ElementPlus.ElMessage.error(errorText(error)); }
    }

    async function discoverProductsFromCategories() {
      const categoryRows = selectedMarketRows.value.filter(row => row.row_type === 'category');
      const fallbackRows = marketRows.value.filter(row => row.row_type === 'category').slice(0, 3);
      const categories = categoryRows.length ? categoryRows : fallbackRows;
      if (!categories.length) {
        await loadMarket();
        return ElementPlus.ElMessage.info('当前已经是商品级榜单，可以直接勾选商品加入找货候选。');
      }
      const searchQuery = categories.map(c => c.category_name_zh || c.title || c.category_name).filter(Boolean).join(' ');
      if (await tryExtensionDiscovery(searchQuery, categories)) return;
      marketLoading.value = true;
      try {
        const response = await axios.post('/api/sourcing/discover-products', {
          category_ids: categories.map(row => row.id),
          search: filters.search,
          category_limit: categories.length,
          per_category: 6,
          limit: Math.max(12, categories.length * 6),
        });
        discoveryState.value = response.data || null;
        const imported = Number(response.data.imported || 0);
        if (imported > 0) {
          ElementPlus.ElMessage.success(`已发现 ${imported} 个商品候选，下面可以勾选加入找货候选`);
          marketView.value = 'product';
        } else {
          ElementPlus.ElMessage.warning(response.data.note || '暂时没有发现商品候选，请安装并连接采集插件后重试');
        }
        marketPage.page = 1;
        await loadMarket();
      } catch (error) { ElementPlus.ElMessage.error(errorText(error)); }
      finally { marketLoading.value = false; }
    }

    async function tryExtensionDiscovery(searchQuery, categories) {
      const PROTO = "__zhumeng_proto";
      const PROTO_VAL = "zhumeng-v1";
      const hasPlugin = await checkExtensionConnected(PROTO, PROTO_VAL);
      if (!hasPlugin) {
        ElementPlus.ElMessage.warning('未检测到采集插件，尝试用服务器发现…（插件发现更快更稳定）');
        return false;
      }
      marketLoading.value = true;
      try {
        let totalImported = 0;
        const hasCategoryUrls = categories.some(c => c.ozon_url || c.category_url);
        if (hasCategoryUrls) {
          for (const cat of categories.slice(0, 3)) {
            const catUrl = cat.ozon_url || cat.category_url || `https://www.ozon.ru/category/${cat.category_id}/`;
            const result = await sendExtensionMessage('discoverCategory.request', {
              category_url: catUrl,
              category_name: cat.category_name_zh || cat.title || cat.category_name || '',
              strategy_type: filters.strategy || 'hot',
              limit: Math.min(40, 20 + categories.length * 6),
            }, 120000);
            if (!result || !result.ok) {
              discoveryState.value = { success: false, note: result?.error || '插件执行失败', code: 'EXTENSION_FAILED', plugin: true };
              continue;
            }
            totalImported += Number(result.imported || 0);
          }
        } else {
          const queries = categories.length
            ? categories.map(c => c.category_name_zh || c.title || c.category_name).filter(Boolean)
            : [searchQuery].filter(Boolean);
          if (!queries.length) return false;
          for (const query of queries.slice(0, 3)) {
            const result = await sendExtensionMessage('discoverProducts.request', {
              query,
              strategy_type: filters.strategy || 'hot',
              limit: Math.min(40, 20 + categories.length * 6),
              category_label: query,
            }, 120000);
            if (!result || !result.ok) {
              discoveryState.value = { success: false, note: result?.error || '插件执行失败', code: 'EXTENSION_FAILED', plugin: true };
              continue;
            }
            totalImported += Number(result.imported || 0);
          }
        }
        if (totalImported > 0) {
          discoveryState.value = { success: true, imported: totalImported };
          ElementPlus.ElMessage.success(`采集插件已发现 ${totalImported} 个商品候选`);
        } else {
          discoveryState.value = { success: false, note: '采集插件未在 Ozon 找到商品', code: 'EXTENSION_NO_RESULTS' };
          ElementPlus.ElMessage.warning('采集插件未在 Ozon 找到商品');
        }
        if (totalImported > 0) marketView.value = 'product';
        marketPage.page = 1;
        await loadMarket();
      } catch (error) {
        ElementPlus.ElMessage.error('插件发现失败: ' + errorText(error));
      } finally { marketLoading.value = false; }
      return true;
    }

    async function checkExtensionConnected(PROTO, PROTO_VAL) {
      if (!window.__zhumeng_pending__) window.__zhumeng_pending__ = {};
      if (!window.__zhumeng_reply_registered__) {
        window.__zhumeng_reply_registered__ = true;
        window.addEventListener('message', (event) => {
          const d = event.data;
          if (!d || typeof d !== 'object' || d[PROTO] !== PROTO_VAL) return;
          if (typeof d.kind === 'string' && d.kind.endsWith('.request')) return;
          const resolver = window.__zhumeng_pending__[d.reqId];
          if (resolver) {
            delete window.__zhumeng_pending__[d.reqId];
            resolver(d);
          }
        });
      }
      const reply = await sendExtensionMessage('ping.request', {}, 5000);
      return Boolean(reply && reply.ok);
    }

    function ensureExtensionBridge() {
      const PROTO = "__zhumeng_proto";
      const PROTO_VAL = "zhumeng-v1";
      if (!window.__zhumeng_pending__) window.__zhumeng_pending__ = {};
      if (window.__zhumeng_reply_registered__) return;
      window.__zhumeng_reply_registered__ = true;
      window.addEventListener('message', (event) => {
        const d = event.data;
        if (!d || typeof d !== 'object' || d[PROTO] !== PROTO_VAL) return;
        if (typeof d.kind === 'string' && d.kind.endsWith('.request')) return;
        const resolver = window.__zhumeng_pending__[d.reqId];
        if (resolver) {
          delete window.__zhumeng_pending__[d.reqId];
          resolver(d);
        }
      });
    }

    function sendExtensionMessage(kind, extra = {}, timeoutMs = 8000) {
      ensureExtensionBridge();
      return new Promise((resolve) => {
        const reqId = `${kind.split('.')[0]}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        window.__zhumeng_pending__[reqId] = (data) => {
          resolve(data);
        };
        try {
          window.postMessage(JSON.parse(JSON.stringify({ __zhumeng_proto: "zhumeng-v1", reqId, kind, ...extra })), '*');
        } catch {
          resolve({ ok: false, error: '序列化失败' });
          return;
        }
        setTimeout(() => {
          if (window.__zhumeng_pending__[reqId]) {
            delete window.__zhumeng_pending__[reqId];
            resolve(null);
          }
        }, timeoutMs);
      });
    }

    async function authorizePluginWorker() {
      try {
        const response = await axios.get('/api/worker/plugin-token', { params: { store_id: storeId() } });
        if (!response.data?.token) return false;
        const reply = await sendExtensionMessage('workerAuth.request', { token: response.data.token }, 10000);
        return Boolean(reply?.ok);
      } catch {
        return false;
      }
    }

    async function loadWorkerStatus() {
      workerStatusLoading.value = true;
      try {
        // 先主动 ping 插件（workerAuth.request）唤醒 service worker 并触发重新上报心跳，
        // 再读 DB——否则插件休眠时只读 DB 拿到的是旧数据（表现为“点刷新没反应”）
        const pinged = await authorizePluginWorker().catch(() => false);
        if (pinged) await new Promise((resolve) => setTimeout(resolve, 800));
        const response = await axios.get('/api/worker/status', { params: { store_id: storeId() } });
        workerStatus.value = {
          workers: response.data.workers || [],
          queue: response.data.queue || { queued: 0, active: 0 },
          pinged,
        };
        return workerStatus.value;
      } catch (error) {
        workerStatus.value = { workers: [], queue: { queued: 0, active: 0 }, error: errorText(error) };
        return workerStatus.value;
      } finally {
        workerStatusLoading.value = false;
      }
    }

    async function advanceRow(row) {
      try {
        await axios.post(`/api/auto-listing/items/${row.id}/advance`, { store_id: storeId() });
        ElementPlus.ElMessage.success('已推进到下一步');
        await Promise.all([loadDashboard(), loadQueue()]);
      } catch (error) { ElementPlus.ElMessage.error(errorText(error)); }
    }

    async function advanceTo(row, stage) {
      try {
        await axios.post(`/api/auto-listing/items/${row.id}/advance`, { store_id: storeId(), stage });
        ElementPlus.ElMessage.success('已推进阶段');
        await Promise.all([loadDashboard(), loadQueue()]);
        if (detailDrawer.visible && detailDrawer.item?.id === row.id) await openQueueDetail(row);
      } catch (error) { ElementPlus.ElMessage.error(errorText(error)); }
    }

    async function startSourcingJob(rows = selectedQueueRows.value) {
      const targets = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
      if (!targets.length) return ElementPlus.ElMessage.warning('请先选择找货候选');
      try {
        await ElementPlus.ElMessageBox.confirm(`将为 ${targets.length} 个候选创建真实单品找货任务，由本机采集端执行 Ozon 采集、1688 以图搜货和 AI 审核。继续吗？`, '启动真实找货', { type: 'warning' });
      } catch { return; }
      try {
        await loadWorkerStatus().catch(() => null);
        const response = await axios.post('/api/auto-listing/items/start-sourcing', {
          store_id: storeId(),
          ids: targets.map(row => row.id),
          maxCandidates: 5,
        });
        sourcingJobState.value = {
          jobId: response.data.jobId,
          existing: Boolean(response.data.existing),
          queued: response.data.queued !== false,
          count: response.data.count || targets.length,
          phase: response.data.job?.phase || '等待本机采集端领取',
        };
        localStorage.setItem('singleSourcingJobId', response.data.jobId);
        await loadWorkerStatus().catch(() => null);
        if (canClaimSourcingWorker.value) {
          ElementPlus.ElMessage.success(response.data.existing ? `已切换到排队中的找货任务 ${response.data.jobId}` : `已创建真实找货任务 ${response.data.jobId}`);
        } else {
          ElementPlus.ElMessage.warning('真实找货任务已排队，但当前没有可领取的采集插件');
        }
        await Promise.all([loadDashboard(), loadQueue()]);
      } catch (error) { ElementPlus.ElMessage.error(errorText(error)); }
    }

    function openSourcingReview(row) {
      const jobId = row?.payload?.sourcing_job_id || payloadOf(row).sourcing_job_id;
      if (!jobId) return ElementPlus.ElMessage.warning('还没有真实找货任务，请先启动找货');
      window.location.hash = `#/single-sourcing-review?id=${encodeURIComponent(jobId)}`;
    }

    async function bulkAction(action) {
      if (!selectedQueueRows.value.length) return ElementPlus.ElMessage.warning('请先选择商品');
      if (action === 'delete') {
        try {
          await ElementPlus.ElMessageBox.confirm(`确认移除 ${selectedQueueRows.value.length} 个找货候选？`, '移除候选', { type: 'warning' });
        } catch { return; }
      }
      try {
        await axios.post('/api/auto-listing/items/bulk-action', {
          store_id: storeId(),
          ids: selectedQueueRows.value.map(row => row.id),
          action,
        });
        ElementPlus.ElMessage.success(action === 'delete' ? '已移除候选' : '已更新队列');
        await Promise.all([loadDashboard(), loadQueue()]);
      } catch (error) { ElementPlus.ElMessage.error(errorText(error)); }
    }

    async function removeQueueRow(row) {
      try {
        await ElementPlus.ElMessageBox.confirm(`确认移除 ${rowTitle(row)}？`, '移除候选', { type: 'warning' });
        await axios.delete(`/api/auto-listing/items/${row.id}`);
        ElementPlus.ElMessage.success('已移除候选');
        if (detailDrawer.item?.id === row.id) detailDrawer.visible = false;
        await Promise.all([loadDashboard(), loadQueue()]);
      } catch (error) {
        if (error !== 'cancel') ElementPlus.ElMessage.error(errorText(error));
      }
    }

    async function openQueueDetail(row) {
      detailDrawer.visible = true;
      detailDrawer.loading = true;
      try {
        const response = await axios.get(`/api/auto-listing/items/${row.id}/events`);
        detailDrawer.item = response.data.item || row;
        detailDrawer.events = response.data.events || [];
        detailDrawer.note = detailDrawer.item.note || '';
      } catch (error) { ElementPlus.ElMessage.error(errorText(error)); }
      finally { detailDrawer.loading = false; }
    }

    async function saveQueueNote() {
      if (!detailDrawer.item?.id) return;
      try {
        const response = await axios.patch(`/api/auto-listing/items/${detailDrawer.item.id}`, { note: detailDrawer.note });
        detailDrawer.item = response.data.item || detailDrawer.item;
        ElementPlus.ElMessage.success('备注已保存');
        await loadQueue();
      } catch (error) { ElementPlus.ElMessage.error(errorText(error)); }
    }

    async function saveSettings() {
      if (!storeId()) return ElementPlus.ElMessage.warning('请先选择店铺');
      try {
        settings.rules = normalizeRules(settings.rules);
        const response = await axios.put('/api/auto-listing/settings', { ...settings, store_id: storeId() });
        hydrateSettings(response.data.settings || {});
        ElementPlus.ElMessage.success('规则已保存');
        await loadDashboard();
      } catch (error) { ElementPlus.ElMessage.error(errorText(error)); }
    }

    function resetMarket() { marketPage.page = 1; loadMarket(); }
    function resetQueue() { queuePage.page = 1; loadQueue(); }
    function marketRowSelectable() { return true; }
    const selectedProductCount = Vue.computed(() => selectedMarketRows.value.filter(row => row.row_type !== 'category').length);
    const selectedCategoryCount = Vue.computed(() => 0);
    const hasCategoryMarket = Vue.computed(() => false);
    const discoverCategoryLabel = Vue.computed(() => '采集 Ozon 机会池');
    const primaryDiscoverLabel = Vue.computed(() => '采集 Ozon 机会池');
    const discoveryErrorText = Vue.computed(() => {
      const state = discoveryState.value || {};
      const errors = Array.isArray(state.errors) ? state.errors.slice(0, 3) : [];
      const categoryNames = Array.isArray(state.categories)
        ? state.categories.map(item => item.label).filter(Boolean).slice(0, 3)
        : [];
      const parts = [];
      if (categoryNames.length) parts.push(`已尝试类目：${categoryNames.join('、')}`);
      if (errors.length) parts.push(`失败明细：${errors.map(item => [item.category, item.query, item.error].filter(Boolean).join(' / ')).join('；')}`);
      if (!parts.length && state.code === 'PRODUCT_LEVEL_SOURCE_UNAVAILABLE') {
        parts.push('当前还没有采集到的商品级 SKU 数据。');
      }
      return parts.join('。');
    });
    const collectorResultText = Vue.computed(() => {
      const result = collectorResult.value || {};
      const parts = [];
      if (Array.isArray(result.errors) && result.errors.length) {
        parts.push(`失败明细：${result.errors.slice(0, 3).map(item => [item.seed, item.url, item.stage, item.error].filter(Boolean).join(' / ')).join('；')}`);
      }
      if (Array.isArray(result.logs) && result.logs.length) {
        parts.push(`最近日志：${result.logs.slice(-3).map(line => String(line).replace(/^\[[^\]]+\]\s*/, '')).join('；')}`);
      }
      if (!parts.length && result.imported === 0) parts.push('Ozon 公共搜索没有返回可写入的商品链接。');
      return parts.join('。');
    });
    const percentText = value => value == null || value === '' ? '-' : `${Number(value).toFixed(2)}%`;
    const moneyRubLarge = value => {
      const n = Number(value || 0);
      if (!n) return '-';
      if (Math.abs(n) >= 100000000) return `₽${(n / 100000000).toFixed(2)}亿`;
      if (Math.abs(n) >= 10000) return `₽${(n / 10000).toFixed(2)}万`;
      return `₽${n.toFixed(0)}`;
    };
    const marketSummary = Vue.computed(() => {
      const rows = marketRows.value || [];
      const dzRows = rows.filter(isDzRow);
      const scored = dzRows.map(blueScore).filter(value => Number.isFinite(value) && value > 0);
      const avgScore = scored.length ? scored.reduce((sum, value) => sum + value, 0) / scored.length : 0;
      const passRows = dzRows.filter(row => {
        const payload = payloadOf(row);
        const score = blueScore(row);
        const sales = Number(payload.sales_30d ?? row.monthly_sales ?? 0);
        const sellers = Number(row.seller_count ?? payload.seller_count ?? 0);
        const risk = Number(payload.risk_score ?? payload.riskScore ?? 0);
        return score >= Number(settings.rules.min_blue_ocean_score || 0)
          && sales >= Number(settings.rules.min_sales_30d || 0)
          && (!sellers || sellers <= Number(settings.rules.max_seller_count || 9999))
          && (!risk || risk <= Number(settings.rules.max_risk_score || 100));
      });
      return {
        dzRows: dzRows.length,
        avgScore,
        passRows: passRows.length,
        sourceCount: new Set(rows.map(row => row.source_name).filter(Boolean)).size,
      };
    });
    const ruleChips = Vue.computed(() => [
      `蓝海分 ≥ ${settings.rules.min_blue_ocean_score}`,
      `30天销量 ≥ ${settings.rules.min_sales_30d}`,
      `卖家数 ≤ ${settings.rules.max_seller_count}`,
      `风险分 ≤ ${settings.rules.max_risk_score}`,
    ]);
    const passesRules = row => {
      const payload = payloadOf(row);
      const score = blueScore(row);
      const sales = Number(payload.sales_30d ?? row.monthly_sales ?? 0);
      const sellers = Number(row.seller_count ?? payload.seller_count ?? 0);
      const risk = Number(payload.risk_score ?? payload.riskScore ?? 0);
      const profit = Number(payload.profit_score ?? payload.profitScore ?? 0);
      return score >= Number(settings.rules.min_blue_ocean_score || 0)
        && sales >= Number(settings.rules.min_sales_30d || 0)
        && (!sellers || sellers <= Number(settings.rules.max_seller_count || 9999))
        && (!risk || risk <= Number(settings.rules.max_risk_score || 100))
        && (!profit || profit >= Number(settings.rules.min_profit_score || 0));
    };
    const displayedMarketRows = Vue.computed(() => rulesOnly.value ? marketRows.value.filter(passesRules) : marketRows.value);
    const rulePassedMarketRows = Vue.computed(() => marketRows.value.filter(row => row.row_type !== 'category' && passesRules(row)));
    const onlineSourcingWorkers = Vue.computed(() => (workerStatus.value.workers || []).filter(worker => worker.online));
    const canClaimSourcingWorker = Vue.computed(() => onlineSourcingWorkers.value.some(worker => worker.canClaimJobs && worker.storeMatch !== false && !worker.versionTooOld));
    const sourcingWorkerHint = Vue.computed(() => {
      const state = sourcingJobState.value;
      const queue = workerStatus.value.queue || {};
      if (workerStatus.value.error) return `任务 ${state?.jobId || ''} 状态读取失败：${workerStatus.value.error}`;
      if (canClaimSourcingWorker.value) return `采集插件已在线，可领取任务。当前排队 ${queue.queued || 0} 个，执行中 ${queue.active || 0} 个。`;
      const oldWorker = onlineSourcingWorkers.value.find(worker => worker.versionTooOld);
      if (oldWorker) return `任务 ${state?.jobId || ''} 已排队，但插件版本 ${oldWorker.version || '未知'} 低于最低版本 ${oldWorker.minVersion || ''}，需要到店铺管理下载新版插件。`;
      if (onlineSourcingWorkers.value.length) return `任务 ${state?.jobId || ''} 已排队，但在线插件还没有当前店铺授权，已尝试自动授权；请刷新插件或进入单品找货页确认授权。`;
      return `任务 ${state?.jobId || ''} 已排队，但没有检测到在线采集插件，所以暂时不会打开 Ozon/1688 页面执行找货。`;
    });
    async function discoverRulePassed() {
      const rows = rulePassedMarketRows.value;
      if (!rows.length) return ElementPlus.ElMessage.warning('当前页没有符合规则的商品');
      selectedMarketRows.value = rows;
      await discoverSelected();
    }

    Vue.onMounted(() => {
      refreshAll();
      loadWorkerStatus();
    });
    Vue.watch(() => window.currentStoreId, refreshAll);

    // ---- 主流程五步：把“榜单 → 勾选 → 入队 → 找货 → 上架”串成一条可点击的流程 ----
    const stageCountOf = (key) => (dashboard.value?.stages || []).find(s => s.key === key)?.count || 0;
    const flowSteps = Vue.computed(() => {
      const discovered = queuePage.total || 0;
      const sourcing = stageCountOf('sourcing');
      const reviewReady = stageCountOf('ready') + stageCountOf('submitted') + stageCountOf('listed');
      return [
        { step: 1, title: '看榜单', desc: '蓝海分·信号·销量', count: marketPage.total || 0, countSuffix: '条机会', active: activeTab.value === 'overview', jump: () => { activeTab.value = 'overview'; } },
        { step: 2, title: '勾选候选', desc: '勾选感兴趣的 SKU', count: selectedProductCount.value, countSuffix: '已选', active: false, jump: () => { activeTab.value = 'overview'; } },
        { step: 3, title: '加入找货候选', desc: '进入找货队列', count: discovered, countSuffix: '条候选', active: activeTab.value === 'pipeline', jump: () => { activeTab.value = 'pipeline'; } },
        { step: 4, title: '启动真实找货', desc: '采集端执行 1688 找货', count: sourcing, countSuffix: '找货中', active: false, jump: () => { activeTab.value = 'pipeline'; } },
        { step: 5, title: '审核并上架', desc: '核对后提交 Ozon', count: reviewReady, countSuffix: '待上架', active: activeTab.value === 'review', jump: () => { activeTab.value = 'review'; loadReview(); } },
      ];
    });

    // 榜单行 → 流程状态标签（是否已入队 / 处于哪个阶段）
    const queueStateOf = (row) => {
      if (!row.in_queue) return { text: '未入队', type: 'info', plain: true };
      const stage = row.queue_stage;
      const status = row.queue_status;
      const stageText = stageLabels[stage] || stage || '';
      if (status === 'running') return { text: '找货中', type: 'warning' };
      if (status === 'needs_human') return { text: '待人工', type: 'danger' };
      if (status === 'failed') return { text: '已失败', type: 'danger' };
      if (status === 'paused') return { text: '已暂停', type: 'info' };
      if (status === 'done' || stage === 'listed') return { text: '已上架', type: 'success' };
      if (stage === 'ready' || stage === 'submitted') return { text: '待上架', type: 'success' };
      if (stage === 'sourcing') return { text: '找货中', type: 'warning' };
      return { text: stageText || '排队中', type: 'primary' };
    };

    return {
      activeTab, loading, marketLoading, queueLoading, selectedMarketRows, selectedQueueRows, rulesOnly, detailDrawer,
      marketRows, queueRows, dashboard, collectorStatus, collectorResult, collectorLoading, workerStatus, sourcingJobState, settings, filters, marketPage, queuePage, marketSource,
      categoryRows, categoryLoading, selectedCategory, selectedCategoryLabel, browseCategory, clearCategory,
      reviewRows, reviewLoading, reviewStage, loadReview,
      discoveryState, marketView, moneyRub, moneyRubLarge, formatTime, percentText, stageLabels, statusLabels, riskTypes, selectedProductCount, selectedCategoryCount, hasCategoryMarket, discoverCategoryLabel, primaryDiscoverLabel, discoveryErrorText, collectorResultText,
      payloadOf, isDzRow, scoreText, scoreColor, blueScore, blueLevel, signalText, rowReasons, sourceBadgeType, sourceBadgeText,
      rowTitle, rowSku, rowBrand, rowImage, rowUrl, rowCategory, rowPrice, rowSales, rowRevenue, rowGrowth, marketSummary, ruleChips, displayedMarketRows, rulePassedMarketRows, passesRules, queueStateOf, flowSteps,
      onlineSourcingWorkers, canClaimSourcingWorker, sourcingWorkerHint,
      refreshAll, loadMarket, loadCategoryAnalysis, loadQueue, loadCollectorStatus, loadWorkerStatus, workerStatusLoading, runOpportunityCollector, discoverSelected, discoverRulePassed, discoverProductsFromCategories, advanceRow, advanceTo, startSourcingJob, openSourcingReview, bulkAction, removeQueueRow, openQueueDetail, saveQueueNote, saveSettings,
      resetMarket, resetQueue, marketRowSelectable, switchToCategoryView: () => { marketView.value = 'product'; marketPage.page = 1; loadMarket(); },
    };
  },
  template: `
    <div class="market-discovery-auto" v-loading="loading">
      <div class="market-head">
        <div>
          <h1 class="market-title">选品中心</h1>
          <div class="market-subtitle">基于每日采集的 Ozon 蓝海/热销数据，按蓝海分、需求、竞争、增速筛选，再加入 1688 找货候选。</div>
        </div>
        <div class="market-head-actions">
          <el-button @click="runOpportunityCollector" :loading="collectorLoading">采集 Ozon 机会池</el-button>
          <el-button type="primary" @click="startSourcingJob()" :disabled="!selectedQueueRows.length">启动真实找货</el-button>          <el-button :type="settings.enabled ? 'warning' : 'success'" @click="settings.enabled=!settings.enabled;saveSettings()">{{settings.enabled ? '暂停自动运营' : '启动自动运营'}}</el-button>
        </div>
      </div>

      <el-alert
        title="Ozon 机会池不会自动跑 1688"
        :description="'每日/手动采集只写入 Ozon 商品候选池；当前商品候选 ' + (collectorStatus?.stats?.total || 0) + ' 个，蓝海/热销信号 ' + marketSummary.dzRows + ' 条，最新数据 ' + formatTime(collectorStatus?.stats?.latest_captured_at) + '。点击采集会同步返回导入数和失败原因；你勾选商品后才会加入找货候选。'"
        type="warning"
        :closable="false"
        show-icon
        style="margin-bottom:14px"
      />
      <el-alert
        v-if="collectorResult && !collectorResult.imported"
        title="本次没有采集到 Ozon 商品候选"
        type="error"
        :description="(collectorResult.note || '') + (collectorResultText ? ' ' + collectorResultText : '')"
        :closable="true"
        show-icon
        style="margin-bottom:14px"
      />
      <el-alert
        v-else-if="collectorResult && collectorResult.imported"
        :title="'本次已采集 ' + collectorResult.imported + ' 个 Ozon 商品候选'"
        type="success"
        :description="collectorResult.failed ? ('失败 ' + collectorResult.failed + ' 个，' + collectorResultText) : '可切换到商品榜单勾选后加入找货候选。'"
        :closable="true"
        show-icon
        style="margin-bottom:14px"
      />
      <el-alert
        v-if="sourcingJobState"
        :title="sourcingJobState.existing ? '已有真实找货任务正在等待处理' : '真实找货任务已创建'"
        :type="canClaimSourcingWorker ? 'success' : 'warning'"
        :description="sourcingWorkerHint"
        :closable="true"
        show-icon
        style="margin-bottom:14px"
      />

      <div class="market-status-strip">
        <div class="market-status-card">
          <div class="market-status-label">{{settings.enabled ? '自动运营中' : '自动运营已暂停'}}</div>
          <div class="market-status-value">{{dashboard?.today?.created || 0}} <small>/ {{dashboard?.today?.quota || settings.daily_quota}} SKU 今日配额</small></div>
          <el-progress :percentage="dashboard?.today?.percent || 0" style="margin-top:10px" />
        </div>
        <div v-for="card in [
          ['采集商品数', marketSummary.dzRows, '条蓝海/热销'],
          ['规则通过', marketSummary.passRows, '条可优先找货'],
          ['平均蓝海分', scoreText(marketSummary.avgScore), '当前页'],
          ['找货候选', queuePage.total || 0, '条队列数据'],
        ]" :key="card[0]" class="market-status-card">
          <div class="market-status-label">{{card[0]}}</div>
          <div class="market-status-value">{{card[1]}} <small>{{card[2]}}</small></div>
        </div>
      </div>

      <div class="market-flow">
        <div class="market-flow-head">
          <div style="font-size:16px;font-weight:800;color:#0f172a">选品 → 找货 → 上架 主流程</div>
          <div style="font-size:12px;color:#64748b;margin-top:4px">点任一步直接跳转；按顺序做完 ①榜单 → ②勾选 → ③入队 → ④找货 → ⑤上架 即可完成一次选品。</div>
        </div>
        <div class="market-flow-strip">
          <div v-for="(f,index) in flowSteps" :key="f.step" class="market-flow-step" :class="{active: f.active, done: f.count > 0}" @click="f.jump()">
            <div class="market-flow-index" :class="{active: f.active, done: f.count > 0}">{{f.step}}</div>
            <div class="market-flow-body">
              <div class="market-flow-title">{{f.title}}</div>
              <div class="market-flow-desc">{{f.desc}}</div>
              <div class="market-flow-count">{{f.count}} <small>{{f.countSuffix}}</small></div>
            </div>
            <div v-if="index < flowSteps.length - 1" class="market-flow-arrow">›</div>
          </div>
        </div>
      </div>

      <el-tabs v-model="activeTab">
        <el-tab-pane label="类目分析" name="category">
          <div class="market-data-panel">
            <div class="market-data-toolbar">
              <div style="font-size:16px;font-weight:900;color:#0f172a">类目机会总览（每日采集）</div>
              <div class="market-toolbar-meta">
                <span>共 {{categoryRows.length}} 个类目</span>
                <span>按平均蓝海分排序</span>
              </div>
            </div>
            <el-alert
              title="点类目行可进入「商品机会」查看该类目下所有候选 SKU，再勾选加入找货队列。"
              type="info"
              :closable="false"
              show-icon
              style="margin-bottom:12px"
            />
            <el-table :data="categoryRows" v-loading="categoryLoading" border style="width:100%" @row-click="browseCategory" class="market-category-table">
              <el-table-column label="类目" min-width="240"><template #default="{row}"><div style="font-weight:800;color:#0f172a">{{row.category_name_zh}}</div><div class="market-product-sub">{{row.category_name}}</div></template></el-table-column>
              <el-table-column label="商品机会数" width="120" align="right"><template #default="{row}"><span style="font-weight:900;color:#0f172a">{{row.product_count}}</span> <small class="market-product-sub">SKU</small></template></el-table-column>
              <el-table-column label="平均蓝海分" width="120" align="right"><template #default="{row}"><span :style="{fontWeight:900,color:scoreColor(row.avg_blue_ocean_100)}">{{row.avg_blue_ocean_100}}</span></template></el-table-column>
              <el-table-column label="平均售价" width="110" align="right"><template #default="{row}">{{moneyRub(row.avg_price)}}</template></el-table-column>
              <el-table-column label="月销总量" width="120" align="right"><template #default="{row}">{{Number(row.total_sales || 0).toLocaleString('zh-CN')}}</template></el-table-column>
              <el-table-column label="平均月销" width="120" align="right"><template #default="{row}">{{Number(row.avg_sales || 0).toLocaleString('zh-CN')}}</template></el-table-column>
              <el-table-column label="操作" width="130" fixed="right"><template #default="{row}"><el-button link type="primary" @click.stop="browseCategory(row)">看商品机会 ›</el-button></template></el-table-column>
            </el-table>
          </div>
        </el-tab-pane>

        <el-tab-pane label="商品机会" name="overview">
          <div class="market-data-panel">
            <div class="market-data-toolbar">
              <div style="font-size:16px;font-weight:900;color:#0f172a">{{filters.rank === 'keyword' ? '蓝海关键词机会' : '商品机会'}}</div>
              <div class="market-toolbar-meta">
                <span>最新数据 {{formatTime(marketSource.freshness?.latest)}}</span>
                <span>数据源 {{marketSummary.sourceCount || '-'}}</span>
              </div>
            </div>
            <div class="market-filter-bar">
              <div class="market-filter-bar-group">
                <el-select v-model="filters.rank" style="width:150px" @change="resetMarket">
                  <el-option label="商品（蓝海+热销）" value="product"/>
                  <el-option label="蓝海关键词" value="keyword"/>
                </el-select>
                <el-select v-model="filters.strategy" style="width:130px" @change="resetMarket">
                  <el-option label="蓝海" value="blue_ocean"/>
                  <el-option label="热销" value="hot"/>
                  <el-option label="全部" value="all"/>
                </el-select>
                <el-input v-model="filters.search" placeholder="SKU / 商品 / 类目" clearable style="width:230px" @keyup.enter="resetMarket"/>
                <el-button type="primary" @click="resetMarket">查询</el-button>
              </div>
              <div class="market-filter-bar-group">
                <el-switch v-model="rulesOnly" active-text="只看通过" style="margin-right:10px"/>
                <el-popover trigger="hover" placement="bottom" :width="320">
                  <template #reference>
                    <el-button link type="primary" style="margin-right:10px">选品规则 ›</el-button>
                  </template>
                  <div style="font-weight:800;color:#0f172a;margin-bottom:8px">当前选品规则（规则中心可调整）</div>
                  <div style="display:flex;flex-wrap:wrap;gap:6px">
                    <el-tag v-for="chip in ruleChips" :key="chip" type="info" size="small">{{chip}}</el-tag>
                  </div>
                </el-popover>
                <el-button type="success" :disabled="!selectedProductCount" @click="discoverSelected()"><b>② 加入找货候选</b> ({{selectedProductCount}})</el-button>
                <el-button type="primary" :disabled="!rulePassedMarketRows.length" @click="discoverRulePassed">规则通过入池 ({{rulePassedMarketRows.length}})</el-button>
              </div>
            </div>
            <div v-if="selectedCategory" class="market-filter-bar-cat">
              <el-tag type="warning" effect="plain">当前类目：{{selectedCategoryLabel || selectedCategory}}</el-tag>
              <el-button link type="danger" @click="clearCategory">清除类目筛选</el-button>
            </div>
            <div style="font-size:12px;color:#94a3b8;line-height:1.5;margin-bottom:10px">勾选商品后点「② 加入找货候选」进入找货队列（流程条 ③）；再到「找货候选」页启动真实找货（④）。</div>
            <el-alert v-if="marketSource.note" :title="marketSource.note" type="warning" :closable="false" style="margin-bottom:10px"/>
              <el-alert
                v-if="discoveryState && !discoveryState.success"
                title="暂时没有商品级榜单数据"
                type="error"
                :description="(discoveryState.note || '') + (discoveryErrorText ? ' ' + discoveryErrorText : '')"
                :closable="false"
                show-icon
                style="margin-bottom:10px"
              />
              <el-alert
                v-else-if="discoveryState && discoveryState.success"
                :title="'已发现 ' + (discoveryState.imported || 0) + ' 个商品候选'"
                type="success"
                :closable="false"
                show-icon
                style="margin-bottom:10px"
              />
              <el-table :data="displayedMarketRows" v-loading="marketLoading" border @selection-change="selectedMarketRows=$event" style="width:100%">
                <el-table-column type="selection" width="44" :selectable="marketRowSelectable"/>
                <el-table-column label="流程" width="104"><template #default="{row}"><el-tag :type="queueStateOf(row).type" :effect="queueStateOf(row).plain ? 'plain' : 'light'" size="small" style="font-weight:800">{{queueStateOf(row).text}}</el-tag><div v-if="row.in_queue" class="market-product-sub" style="margin-top:3px">{{stageLabels[row.queue_stage] || row.queue_stage || ''}}</div></template></el-table-column>
                <el-table-column label="机会" width="120"><template #default="{row}"><el-tag :type="sourceBadgeType(row)">{{sourceBadgeText(row)}}</el-tag><div class="market-product-sub">{{rowCategory(row)}}</div></template></el-table-column>
                <el-table-column label="商品" min-width="320" show-overflow-tooltip><template #default="{row}"><div class="market-product-cell"><el-image v-if="rowImage(row)" :src="rowImage(row)" class="market-thumb" fit="cover"/><div v-else class="market-thumb market-thumb-empty">SKU</div><div class="market-product-main"><a v-if="rowUrl(row)" :href="rowUrl(row)" target="_blank" class="market-product-title">{{rowTitle(row)}}</a><div v-else class="market-product-title" style="color:#0f172a">{{rowTitle(row)}}</div><div class="market-product-sub">SKU {{rowSku(row)}}{{rowBrand(row) ? ' · ' + rowBrand(row) : ''}}{{row.seller_name ? ' · ' + row.seller_name : ''}}</div></div></div></template></el-table-column>
                <el-table-column label="蓝海" width="92" align="right"><template #default="{row}"><span :style="{fontWeight:900,color:scoreColor(blueScore(row))}">{{scoreText(blueScore(row))}}</span><div class="market-product-sub">等级 {{blueLevel(row)}}</div></template></el-table-column>
                <el-table-column label="机会信号" width="210"><template #default="{row}"><div class="market-signal-grid"><span>需求 {{signalText(row,'demand')}}</span><span>增长 {{signalText(row,'growth')}}</span><span>竞争 {{signalText(row,'competition')}}</span><span>转化 {{signalText(row,'conversion')}}</span><span>利润 {{signalText(row,'profit')}}</span><span>风险 {{signalText(row,'risk')}}</span></div></template></el-table-column>
                <el-table-column label="售价" width="96" align="right"><template #default="{row}">{{moneyRub(rowPrice(row))}}</template></el-table-column>
                <el-table-column label="30天销量" width="110" align="right"><template #default="{row}">{{Number(rowSales(row) || 0).toLocaleString('zh-CN')}}</template></el-table-column>
                <el-table-column label="30天销售额" width="130" align="right"><template #default="{row}">{{moneyRubLarge(rowRevenue(row))}}</template></el-table-column>
                <el-table-column label="卖家数" width="90" align="right"><template #default="{row}">{{row.seller_count ?? '-'}}</template></el-table-column>
                <el-table-column label="增长" width="90" align="right"><template #default="{row}">{{percentText(rowGrowth(row))}}</template></el-table-column>
                <el-table-column label="依据" min-width="190" show-overflow-tooltip><template #default="{row}">{{rowReasons(row)}}</template></el-table-column>
              </el-table>
              <div style="display:flex;justify-content:flex-end;margin-top:12px"><el-pagination v-model:current-page="marketPage.page" v-model:page-size="marketPage.size" :total="marketPage.total" :page-sizes="[20,30,50,100]" layout="total,sizes,prev,pager,next" @change="loadMarket"/></div>
          </div>
        </el-tab-pane>

        <el-tab-pane label="审核上架" name="review">
          <div class="market-data-panel">
            <div class="market-data-toolbar">
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                <div style="font-size:16px;font-weight:900;color:#0f172a">待审核 / 待上架</div>
                <el-select v-model="reviewStage" style="width:220px" @change="loadReview">
                  <el-option label="待上架 + 已提交 + 已上架" value="ready,submitted,listed"/>
                  <el-option label="仅待上架" value="ready"/>
                  <el-option label="仅已提交 Ozon" value="submitted"/>
                  <el-option label="仅已上架" value="listed"/>
                </el-select>
              </div>
              <div class="market-toolbar-meta">
                <span>共 {{reviewRows.length}} 条</span>
              </div>
            </div>
            <el-alert
              title="主流程 ⑤：这里列出从找货队列推进到上架阶段的商品。确认无误后，点击「去批量上架」打开上架页完成提交。"
              type="info"
              :closable="false"
              show-icon
              style="margin-bottom:12px"
            />
            <div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap">
              <el-button type="primary" @click="window.location.hash = '#/upload'">去批量上架 ›</el-button>
              <el-button @click="loadReview">刷新列表</el-button>
            </div>
            <el-table :data="reviewRows" v-loading="reviewLoading" border style="width:100%">
              <el-table-column label="商品" min-width="320" show-overflow-tooltip><template #default="{row}"><div class="market-product-cell"><el-image v-if="rowImage(row)" :src="rowImage(row)" class="market-thumb" fit="cover"/><div v-else class="market-thumb market-thumb-empty">SKU</div><div class="market-product-main"><div class="market-product-title" style="color:#0f172a">{{rowTitle(row)}}</div><div class="market-product-sub">SKU {{rowSku(row)}} · {{rowCategory(row)}}</div></div></div></template></el-table-column>
              <el-table-column label="阶段" width="130"><template #default="{row}"><el-tag>{{stageLabels[row.stage] || row.stage}}</el-tag></template></el-table-column>
              <el-table-column label="状态" width="105"><template #default="{row}"><el-tag :type="row.status==='needs_human'?'warning':row.status==='failed'?'danger':'info'">{{statusLabels[row.status] || row.status}}</el-tag></template></el-table-column>
              <el-table-column label="蓝海分" width="105" align="right"><template #default="{row}"><span :style="{fontWeight:900,color:scoreColor(blueScore(row))}">{{scoreText(blueScore(row))}}</span></template></el-table-column>
              <el-table-column label="风险" width="90"><template #default="{row}"><el-tag :type="riskTypes[row.risk_level] || 'info'">{{row.risk_level || 'normal'}}</el-tag></template></el-table-column>
              <el-table-column label="人工原因" min-width="190" show-overflow-tooltip><template #default="{row}">{{row.human_reason || '-'}}</template></el-table-column>
              <el-table-column label="更新" width="150"><template #default="{row}">{{formatTime(row.updated_at)}}</template></el-table-column>
              <el-table-column label="操作" width="170" fixed="right"><template #default="{row}"><el-button link type="success" @click="openSourcingReview(row)">核对</el-button><el-button link type="primary" @click="window.location.hash = '#/upload'">去上架</el-button></template></el-table-column>
            </el-table>
          </div>
        </el-tab-pane>

        <el-tab-pane label="找货候选" name="pipeline">
          <div class="market-data-panel">
          <div class="market-data-toolbar">
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><el-select v-model="filters.stage" style="width:160px" @change="resetQueue"><el-option label="全部阶段" value="all"/><el-option v-for="(label,key) in stageLabels" :key="key" :label="label" :value="key"/></el-select><el-input v-model="filters.search" placeholder="搜索 SKU / 商品 / 中文类目" clearable style="width:280px" @keyup.enter="resetQueue"/><el-button @click="resetQueue">查询</el-button></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap"><el-button @click="bulkAction('pause')" :disabled="!selectedQueueRows.length">暂停</el-button><el-button @click="bulkAction('resume')" :disabled="!selectedQueueRows.length">恢复</el-button><el-button type="primary" @click="startSourcingJob()" :disabled="!selectedQueueRows.length"><b>④ 启动真实找货</b></el-button><el-button type="danger" plain @click="bulkAction('delete')" :disabled="!selectedQueueRows.length">移除</el-button></div>
          </div>
          <el-alert
            :title="canClaimSourcingWorker ? '采集插件可领取真实找货任务' : '没有检测到可领取任务的采集插件'"
            :type="canClaimSourcingWorker ? 'success' : 'warning'"
            :description="canClaimSourcingWorker ? sourcingWorkerHint : '点击启动真实找货会创建队列任务；如果插件未在线或未授权，任务会停在等待领取，不会打开 Ozon/1688 页面。'"
            :closable="false"
            show-icon
            style="margin-bottom:12px"
          >
            <template #default>
              <div style="margin-top:8px"><el-button size="small" :loading="workerStatusLoading" @click="loadWorkerStatus">刷新采集端状态</el-button></div>
            </template>
          </el-alert>
          <el-alert
            title="这里是主流程 ③④：勾选下方候选，点「启动真实找货」交给采集端执行；完成后在「核对」里人工确认，再进入批量上架（主流程 ⑤）。"
            type="info"
            :closable="false"
            show-icon
            style="margin-bottom:12px"
          />
          <el-table :data="queueRows" v-loading="queueLoading" border @selection-change="selectedQueueRows=$event" style="width:100%">
            <el-table-column type="selection" width="44"/><el-table-column label="商品" min-width="320" show-overflow-tooltip><template #default="{row}"><div class="market-product-cell"><el-image v-if="rowImage(row)" :src="rowImage(row)" class="market-thumb" fit="cover"/><div v-else class="market-thumb market-thumb-empty">SKU</div><div class="market-product-main"><div class="market-product-title" style="color:#0f172a">{{rowTitle(row)}}</div><div class="market-product-sub">SKU {{rowSku(row)}} · {{rowCategory(row)}}</div></div></div></template></el-table-column>
            <el-table-column label="阶段" width="130"><template #default="{row}"><el-tag>{{stageLabels[row.stage] || row.stage}}</el-tag></template></el-table-column>
            <el-table-column label="状态" width="105"><template #default="{row}"><el-tag :type="row.status==='needs_human'?'warning':row.status==='failed'?'danger':'info'">{{statusLabels[row.status] || row.status}}</el-tag></template></el-table-column>
            <el-table-column label="蓝海分" width="105" align="right"><template #default="{row}"><span :style="{fontWeight:900,color:scoreColor(blueScore(row))}">{{scoreText(blueScore(row))}}</span><div style="font-size:12px;color:#64748b">等级 {{blueLevel(row)}}</div></template></el-table-column>
            <el-table-column label="来源信号" width="210"><template #default="{row}"><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;font-size:12px;color:#475569"><span>需求 {{signalText(row,'demand')}}</span><span>增长 {{signalText(row,'growth')}}</span><span>竞争 {{signalText(row,'competition')}}</span><span>转化 {{signalText(row,'conversion')}}</span><span>利润 {{signalText(row,'profit')}}</span><span>风险 {{signalText(row,'risk')}}</span></div></template></el-table-column>
            <el-table-column label="风险" width="90"><template #default="{row}"><el-tag :type="riskTypes[row.risk_level] || 'info'">{{row.risk_level || 'normal'}}</el-tag></template></el-table-column>
            <el-table-column label="推进依据" min-width="220" show-overflow-tooltip><template #default="{row}">{{rowReasons(row)}}</template></el-table-column>
            <el-table-column label="人工原因" min-width="190" show-overflow-tooltip><template #default="{row}">{{row.human_reason || '-'}}</template></el-table-column>
            <el-table-column label="更新" width="150"><template #default="{row}">{{formatTime(row.updated_at)}}</template></el-table-column>
            <el-table-column label="操作" width="230" fixed="right"><template #default="{row}"><el-button link type="primary" @click="openQueueDetail(row)">详情</el-button><el-button link type="primary" @click="startSourcingJob([row])">启动找货</el-button><el-button link type="success" @click="openSourcingReview(row)">核对</el-button><el-button link type="danger" @click="removeQueueRow(row)">移除</el-button></template></el-table-column>
          </el-table>
          <div style="display:flex;justify-content:flex-end;margin-top:14px"><el-pagination v-model:current-page="queuePage.page" v-model:page-size="queuePage.size" :total="queuePage.total" :page-sizes="[20,30,50]" layout="total,sizes,prev,pager,next" @change="loadQueue"/></div>
          </div>
        </el-tab-pane>

        <el-tab-pane label="规则中心" name="rules">
          <div class="market-settings-grid">
            <div style="background:#fff;border:1px solid #dfe7f1;border-radius:8px;padding:22px">
              <div style="font-size:16px;font-weight:900;color:#0f172a;margin-bottom:16px">运营推进规则</div>
              <el-form label-width="160px">
                <el-form-item label="自动运营"><el-switch v-model="settings.enabled"/></el-form-item>
                <el-form-item label="每日上架配额"><el-input-number v-model="settings.daily_quota" :min="1" :max="500"/></el-form-item>
                <el-form-item label="最低利润率"><el-input-number v-model="settings.min_profit_rate" :min="0" :max="5" :step="0.05"/><span style="margin-left:8px;color:#64748b">例如 0.2 = 20%</span></el-form-item>
                <el-form-item label="AI 日成本上限"><el-input-number v-model="settings.max_ai_cost_cny" :min="0" :max="9999"/></el-form-item>
                <el-form-item label="允许真实提交 Ozon"><el-switch v-model="settings.submit_to_ozon"/><span style="margin-left:8px;color:#ef4444">测试环境默认建议关闭</span></el-form-item>
              </el-form>
            </div>
            <div style="background:#fff;border:1px solid #dfe7f1;border-radius:8px;padding:22px">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
                <div>
                  <div style="font-size:16px;font-weight:900;color:#0f172a">选品规则</div>
                  <div style="font-size:12px;color:#64748b;margin-top:4px">匹配 ozon-blue-ocean 的需求、增长、竞争、利润、内容缺口、风险评分</div>
                </div>
                <el-switch v-model="settings.rules.geo_enabled" active-text="启用"/>
              </div>
              <el-form label-width="170px">
                <el-form-item label="最低蓝海分"><el-input-number v-model="settings.rules.min_blue_ocean_score" :min="0" :max="100" :step="1"/></el-form-item>
                <el-form-item label="最低 30 天销量"><el-input-number v-model="settings.rules.min_sales_30d" :min="0" :max="999999" :step="10"/></el-form-item>
                <el-form-item label="最高卖家数"><el-input-number v-model="settings.rules.max_seller_count" :min="0" :max="9999" :step="1"/></el-form-item>
                <el-form-item label="最高风险分"><el-input-number v-model="settings.rules.max_risk_score" :min="0" :max="100" :step="1"/></el-form-item>
                <el-form-item label="最低利润分"><el-input-number v-model="settings.rules.min_profit_score" :min="0" :max="100" :step="1"/></el-form-item>
                <el-form-item label="数据新鲜度"><el-input-number v-model="settings.rules.require_source_fresh_days" :min="1" :max="90" :step="1"/><span style="margin-left:8px;color:#64748b">天内</span></el-form-item>
                <el-form-item label="优先内容缺口"><el-switch v-model="settings.rules.prefer_content_gap"/><span style="margin-left:8px;color:#64748b">头部内容弱时优先找货</span></el-form-item>
                <el-form-item label="屏蔽高认证风险"><el-switch v-model="settings.rules.block_high_certification_risk"/></el-form-item>
              </el-form>
            </div>
          </div>
          <div style="margin-top:16px;display:flex;justify-content:flex-end">
            <el-button type="primary" @click="saveSettings">保存规则</el-button>
          </div>
        </el-tab-pane>
      </el-tabs>
      <el-drawer v-model="detailDrawer.visible" title="找货候选详情" size="520px">
        <div v-loading="detailDrawer.loading">
          <template v-if="detailDrawer.item">
            <div class="market-product-cell" style="align-items:flex-start;margin-bottom:16px">
              <el-image v-if="rowImage(detailDrawer.item)" :src="rowImage(detailDrawer.item)" class="market-thumb" fit="cover"/>
              <div v-else class="market-thumb market-thumb-empty">SKU</div>
              <div class="market-product-main">
                <div style="font-weight:900;color:#0f172a;line-height:1.4">{{rowTitle(detailDrawer.item)}}</div>
                <div class="market-product-sub">SKU {{rowSku(detailDrawer.item)}} · {{rowCategory(detailDrawer.item)}}</div>
                <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
                  <el-tag>{{stageLabels[detailDrawer.item.stage] || detailDrawer.item.stage}}</el-tag>
                  <el-tag type="info">{{statusLabels[detailDrawer.item.status] || detailDrawer.item.status}}</el-tag>
                  <el-tag :type="riskTypes[detailDrawer.item.risk_level] || 'warning'">风险 {{detailDrawer.item.risk_level}}</el-tag>
                </div>
              </div>
            </div>
            <el-descriptions :column="2" border style="margin-bottom:16px">
              <el-descriptions-item label="蓝海分">{{scoreText(blueScore(detailDrawer.item))}}</el-descriptions-item>
              <el-descriptions-item label="等级">{{blueLevel(detailDrawer.item)}}</el-descriptions-item>
              <el-descriptions-item label="售价">{{moneyRub(rowPrice(detailDrawer.item))}}</el-descriptions-item>
              <el-descriptions-item label="销量">{{Number(rowSales(detailDrawer.item) || 0).toLocaleString('zh-CN')}}</el-descriptions-item>
              <el-descriptions-item label="增长">{{percentText(rowGrowth(detailDrawer.item))}}</el-descriptions-item>
              <el-descriptions-item label="卖家">{{detailDrawer.item.seller_name || rowBrand(detailDrawer.item) || '-'}}</el-descriptions-item>
            </el-descriptions>
            <div style="font-weight:900;color:#0f172a;margin-bottom:8px">备注</div>
            <el-input v-model="detailDrawer.note" type="textarea" :rows="3" placeholder="记录人工判断、找货要求或排除原因"/>
            <div style="display:flex;justify-content:flex-end;margin:10px 0 18px"><el-button type="primary" @click="saveQueueNote">保存备注</el-button></div>
            <div style="font-weight:900;color:#0f172a;margin-bottom:8px">推进记录</div>
            <el-timeline>
              <el-timeline-item v-for="event in detailDrawer.events" :key="event.id" :timestamp="formatTime(event.created_at)" placement="top">
                <div style="font-weight:800;color:#334155">{{stageLabels[event.stage] || event.stage || '记录'}}</div>
                <div style="color:#64748b;margin-top:4px">{{event.message || event.event_type}}</div>
              </el-timeline-item>
            </el-timeline>
          </template>
        </div>
      </el-drawer>
    </div>
  `
};
