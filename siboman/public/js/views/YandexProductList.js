window.YandexProductListView = {
  setup() {
    const products = Vue.ref([]);
    const loading = Vue.ref(false);
    const pulling = Vue.ref(false);       // 正在全量拉取店铺商品（后台刷新中）
    const pullSeconds = Vue.ref(0);
    let pullTimer = null;
    const saveLoading = Vue.ref(false);
    const hasFetched = Vue.ref(false);
    const activeTab = Vue.ref('all');
    const search = Vue.ref('');
    const pagination = Vue.reactive({ currentPage: 1, pageSize: 50, total: 0 });
    const apiReady = Vue.ref(true);
    const statusCounts = Vue.reactive({ all: 0, published: 0, moderation: 0, need_attention: 0, hidden: 0, archived: 0 });
    const context = Vue.ref(null);
    const drawer = Vue.reactive({
      visible: false,
      form: {
        offer_id: '',
        name: '',
        brand: '',
        description: '',
        category_id: '',
        category_name: '',
        diagnostic: null,
        stockSummary: null,
        price: 0,
        currency_code: 'RUB',
        imagesText: '',
        attributes: {},     // 属性名 -> 值（含 AI 填充）
      },
      attrTemplate: [],     // 类目参数模板
      dirtyAttrs: {},       // 本次改动/新增的属性名
      aiFillBusy: false,
      aiFilled: false,      // 本表单是否含"AI 智能填充"产物（保存时记入 AI 优化记录）
      aiNotes: [],
    });
    const editDrawerMode = Vue.ref('manual'); // manual|aiFill
    const profitDialog = Vue.reactive({
      visible: false,
      cost: {
        purchaseCny: 0,
        domesticShippingCny: 5,
        serviceFeeCny: 3,
        weightKg: 0.02,
        lengthCm: 0,
        widthCm: 0,
        heightCm: 0,
        lastMileCny: 4.68,
        commissionPct: 0, // 0 = 按 Yandex 官方费率表自动匹配类目佣金（手动填数则优先手动）
        acquiringPct: 3.8,
        withdrawalPct: 1.2,
        returnLossPct: 0,
        adPct: 10,
        targetMarginPct: 35,
        strikeDiscountPct: 50,
        ozonMarginPct: 10, // Ozon 反推采购价用的目标利润率
        exchangeRate: 12.8205,
      },
    });

    const notify = {
      success: (msg) => (window.ElementPlus?.ElMessage || console).success?.(msg),
      warning: (msg) => (window.ElementPlus?.ElMessage || console).warning?.(msg),
      error: (msg) => (window.ElementPlus?.ElMessage || console).error?.(msg),
    };

    const statusTabs = [
      { label: '全部', value: 'all' },
      { label: '销售中', value: 'published' },
      { label: '待审核', value: 'moderation' },
      { label: '待修改', value: 'need_attention' },
      { label: '已下架', value: 'hidden' },
      { label: '归档', value: 'archived' },
    ];
    const statusTabItems = Vue.computed(() => statusTabs.map((tab) => ({
      ...tab,
      count: Number(statusCounts[tab.value] || 0),
    })));

    const statusText = (status) => ({
      published: '销售中',
      moderation: '待审核',
      need_attention: '待修改',
      hidden: '已下架',
      archived: '归档',
    }[String(status || '').toLowerCase()] || status || '-');

    const statusTagType = (status) => ({
      published: 'success',
      moderation: 'warning',
      need_attention: 'danger',
      hidden: 'info',
      archived: 'info',
    }[String(status || '').toLowerCase()] || 'info');

    const moneyText = (value, currency = 'RUB') => {
      const n = Number(value || 0);
      if (!Number.isFinite(n) || n <= 0) return '-';
      return `${currency} ${n.toFixed(2)}`;
    };

    const roundMoney = (value) => {
      const n = Number(value || 0);
      return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
    };

    const priceToCny = (price, currency) => {
      const n = Number(price || 0);
      const rate = Number(profitDialog.cost.exchangeRate || 0);
      if (!Number.isFinite(n) || n <= 0) return 0;
      return String(currency || '').toUpperCase() === 'RUB' && rate > 0 ? n / rate : n;
    };

    const priceFromCny = (priceCny, currency) => {
      const n = Number(priceCny || 0);
      const rate = Number(profitDialog.cost.exchangeRate || 0);
      if (!Number.isFinite(n) || n <= 0) return 0;
      return String(currency || '').toUpperCase() === 'RUB' && rate > 0 ? n * rate : n;
    };

    const calcCelEconomy = (priceCny = 0) => {
      const c = profitDialog.cost;
      const weightKg = Math.max(0, Number(c.weightKg || 0));
      const lengthCm = Math.max(0, Number(c.lengthCm || 0));
      const widthCm = Math.max(0, Number(c.widthCm || 0));
      const heightCm = Math.max(0, Number(c.heightCm || 0));
      const exchangeRate = Number(c.exchangeRate || 0) || 13;
      const priceRub = Math.max(0, Number(priceCny || 0) * exchangeRate);
      const volumeKg = lengthCm > 0 && widthCm > 0 && heightCm > 0 ? (lengthCm * widthCm * heightCm) / 12000 : 0;
      let zone = 'Extra Small';
      let chargeWeightKg = weightKg;
      let fee = weightKg * 28.1 + 3.37;

      if (priceRub <= 1500) {
        if (weightKg <= 0.5) {
          zone = 'Extra Small';
          chargeWeightKg = weightKg;
          fee = chargeWeightKg * 28.1 + 3.37;
        } else {
          zone = 'Budget';
          chargeWeightKg = weightKg;
          fee = chargeWeightKg * 19.1 + 25.83;
        }
      } else if (priceRub <= 7000) {
        if (weightKg <= 2) {
          zone = 'Small';
          chargeWeightKg = weightKg;
          fee = chargeWeightKg * 28.1 + 17.97;
        } else {
          zone = 'Big';
          chargeWeightKg = Math.max(weightKg, volumeKg);
          fee = chargeWeightKg * 19.1 + 40.44;
        }
      } else if (weightKg <= 5) {
        zone = 'Premium Small';
        chargeWeightKg = weightKg;
        fee = chargeWeightKg * 28.1 + 24.71;
      } else {
        zone = 'Premium Big';
        chargeWeightKg = Math.max(weightKg, volumeKg);
        fee = chargeWeightKg * 25.8 + 69.64;
      }

      return {
        zone,
        feeCny: roundMoney(fee),
        chargeWeightKg: roundMoney(chargeWeightKg),
        volumeKg: roundMoney(volumeKg),
        priceRub: roundMoney(priceRub),
      };
    };

    const applyCounts = (counts = {}) => {
      for (const tab of statusTabs) statusCounts[tab.value] = Number(counts[tab.value] || 0);
    };

    // 卡片质量筛选：all | high(≥80) | medium(60-79) | low(<60)
    const qualityFilter = Vue.ref('all');
    const qualityOptions = [
      { label: '全部质量', value: 'all' },
      { label: '优秀(≥80 绿)', value: 'high' },
      { label: '一般(60-79 橙)', value: 'medium' },
      { label: '待优化(<60 红)', value: 'low' },
    ];
    // AI 优化状态：是否做过 AI 优化 + 次数/最近时间（来自 ai_stats）
    const aiFilter = Vue.ref('all');
    const aiOptions = [
      { label: '全部 AI 状态', value: 'all' },
      { label: '已 AI 优化', value: 'yes' },
      { label: '未 AI 优化', value: 'no' },
    ];
    // 调价状态：all | priced（已调价） | unpriced（未调价）| promo（售价≠划线价=促销中）
    const priceFilter = Vue.ref('all');
    const priceOptions = [
      { label: '全部调价状态', value: 'all' },
      { label: '已调价', value: 'priced' },
      { label: '未调价', value: 'unpriced' },
      { label: '售价≠划线价(促销中)', value: 'promo' },
    ];
    const diagnosticFilter = Vue.ref('all');
    const diagnosticOptions = [
      { label: '全部诊断', value: 'all' },
      { label: '疑似类目错配', value: 'category_mismatch' },
      { label: '有风险提示', value: 'warning' },
      { label: '诊断正常', value: 'ok' },
    ];
    const diagnosticTagType = (row) => {
      const severity = String(row?.yandex_diagnostic?.severity || 'ok');
      return severity === 'danger' ? 'danger' : severity === 'warning' ? 'warning' : 'success';
    };
    const diagnosticText = (row) => {
      const d = row?.yandex_diagnostic || {};
      if (Array.isArray(d.issues) && d.issues.length) return d.issues[0];
      return '正常';
    };
    const diagnosticTips = (row) => {
      const d = row?.yandex_diagnostic || {};
      const tips = [];
      if (Array.isArray(d.issues)) tips.push(...d.issues);
      if (d.product_category || d.market_category) tips.push(`商品类目：${d.product_category || '-'} / Yandex类目：${d.market_category || '-'}`);
      if (Array.isArray(d.tips)) tips.push(...d.tips);
      return tips.filter(Boolean).join('；');
    };
    const stockSummaryText = (row) => {
      const s = row?.yandex_stock_summary;
      if (!s || !Array.isArray(s.warehouses) || !s.warehouses.length) return '无库存快照';
      const first = s.warehouses[0];
      const more = s.warehouses.length > 1 ? ` 等 ${s.warehouses.length} 仓` : '';
      return `${first.warehouse_name || first.warehouse_id}${more} · FIT ${s.total_fit || 0}`;
    };
    const isPriced = (row) => {
      const st = priceState[row.offer_id];
      return !!(st && Array.isArray(st.records) && st.records.some((r) => r.status === 'applied'));
    };
    const aiStats = Vue.ref({});
    const aiRecordsDialog = Vue.reactive({ visible: false, offerId: '', name: '', rows: [], busy: false });
    const openAiRecords = async (row) => {
      aiRecordsDialog.offerId = row.offer_id || row.offerId || '';
      aiRecordsDialog.name = row.name || row.title || '';
      aiRecordsDialog.rows = [];
      aiRecordsDialog.visible = true;
      aiRecordsDialog.busy = true;
      try {
        const res = await axios.get('/api/yandex/ai-records', { params: { offer_id: aiRecordsDialog.offerId, limit: 30 } });
        aiRecordsDialog.rows = res.data?.records || [];
      } catch (e) {
        notify.error(e.response?.data?.error || e.message || '读取优化记录失败');
      } finally {
        aiRecordsDialog.busy = false;
      }
    };

    // 拉取店铺商品（强制后台全量刷新 active+archived），旧数据继续展示，轮询直到快照更新
    const cacheReady = Vue.ref(false);
    const cachedAt = Vue.ref(0);
    const pullProducts = async () => {
      pulling.value = true;
      pullSeconds.value = 0;
      if (pullTimer) clearInterval(pullTimer);
      pullTimer = setInterval(() => { pullSeconds.value += 1; }, 1000);
      const beforeAt = Date.now();
      try {
        const res = await axios.post('/api/yandex/products/pull', {}, { timeout: 30000 });
        if (!res.data?.success) throw new Error(res.data?.error || '拉取失败');
        notify.warning('已在后台拉取店铺商品（active + 归档），通常需 1-3 分钟，完成后自动刷新');
        // 轮询直到缓存就绪且快照更新
        const poll = setInterval(async () => {
          try {
            const r = await axios.get('/api/yandex/products', {
              params: { status: activeTab.value, page: 1, page_size: pagination.pageSize },
            });
            if (r.data?.cache_ready && Number(r.data?.cached_at || 0) > 0 && Number(r.data.cached_at) >= beforeAt - 5000) {
              clearInterval(poll);
              stopPullProgress();
              fetchProducts();
            }
          } catch { /* 网络抖动继续轮询 */ }
        }, 5000);
        setTimeout(() => { clearInterval(poll); stopPullProgress(); fetchProducts(); }, 240000);
      } catch (e) {
        notify.error('拉取失败: ' + (e.response?.data?.error || e.message));
        stopPullProgress();
      }
    };
    const stopPullProgress = () => {
      pulling.value = false;
      if (pullTimer) { clearInterval(pullTimer); pullTimer = null; }
    };
    Vue.onBeforeUnmount(stopPullProgress);

    const fetchProducts = async () => {
      loading.value = true;
      try {
        const res = await axios.get('/api/yandex/products', {
          params: {
            status: activeTab.value,
            quality: qualityFilter.value,
            ai: aiFilter.value,
            diagnostic: diagnosticFilter.value,
            price: priceFilter.value,
            q: search.value,
            page: pagination.currentPage,
            page_size: pagination.pageSize,
          },
        });
        products.value = res.data?.items || res.data?.products || [];
        pagination.total = Number(res.data?.total || products.value.length || 0);
        apiReady.value = res.data?.api_ready !== false;
        context.value = res.data?.context || null;
        cacheReady.value = Boolean(res.data?.cache_ready);
        cachedAt.value = Number(res.data?.cached_at || 0);
        applyCounts(res.data?.status_counts || {});
        aiStats.value = res.data?.ai_stats || {};
        const stateIds = (res.data?.items || []).map((it) => it.offer_id).filter(Boolean);
        if (stateIds.length) refreshPriceState(stateIds);
      } catch (error) {
        if (error.response?.status === 404) {
          apiReady.value = false;
          products.value = [];
          pagination.total = 0;
          notify.warning('Yandex 商品 API 还未接入，页面字段已先准备好');
        } else {
          notify.error(error.response?.data?.error || error.message || '读取 Yandex 商品失败');
        }
      } finally {
        hasFetched.value = true;
        loading.value = false;
      }
    };

    // 划线价来源：Yandex basicPrice.discountBase（normalize 后为 row.old_price）
    const isPromoRow = (row) => {
      const price = Number(row?.price || 0);
      const old = Number(row?.old_price || row?.discountBase || 0);
      return old > 0 && price > 0 && Math.abs(price - old) > 0.001;
    };
    // 调价/促销筛选已由服务端整店过滤（fetchProducts 传 price 参数），此处不再二次过滤，
    // 直接展示服务端返回结果（分页/总数随服务端一致）。
    const displayProducts = Vue.computed(() => products.value);

    const selectStatusTab = (value) => {
      activeTab.value = value;
      pagination.currentPage = 1;
      fetchProducts();
    };

    const resetFilters = () => {
      search.value = '';
      activeTab.value = 'all';
      qualityFilter.value = 'all';
      aiFilter.value = 'all';
      priceFilter.value = 'all';
      diagnosticFilter.value = 'all';
      pagination.currentPage = 1;
      fetchProducts();
    };

    const openEdit = (row) => {
      const images = Array.isArray(row.images) ? row.images : [row.image];
      const attrMap = {};
      if (Array.isArray(row.attributes)) {
        for (const a of row.attributes) {
          if (a && a.name) attrMap[a.name] = String(a.value ?? '');
        }
      }
      Object.assign(drawer.form, {
        offer_id: row.offer_id || '',
        name: row.name || row.title || '',
        brand: row.brand || '',
        description: row.raw?.offer?.description || row.description || '',
        category_id: row.category_id || '',
        category_name: row.category_name || '',
        diagnostic: row.yandex_diagnostic || null,
        stockSummary: row.yandex_stock_summary || null,
        price: Number(row.price || 0),
        currency_code: row.currency_code || 'RUB',
        imagesText: images.filter(Boolean).join('\n'),
        attributes: attrMap,
      });
      drawer.attrTemplate = [];
      drawer.dirtyAttrs = {};
      drawer.aiFilled = false;
      drawer.visible = true;
      fetchCategoryTemplate(row.category_id || '');
    };

    // 拉取类目参数模板，用于渲染"空属性补齐"表单
    const fetchCategoryTemplate = async (categoryId) => {
      if (!categoryId) return;
      drawer.attrTemplate = [];
      try {
        const res = await axios.get(`/api/yandex/category/${encodeURIComponent(categoryId)}/parameters`);
        drawer.attrTemplate = (res.data && res.data.parameters) || [];
      } catch (e) {
        if (!(e.response && e.response.status === 404)) {
          notify.warning('属性模板加载失败：' + (e.response?.data?.error || e.message || ''));
        }
      }
    };

    // 熊猫式「AI 智能填充」：只补空缺（标题/描述/必填与推荐属性）
    const aiFillProduct = async () => {
      if (!drawer.form.name || !drawer.form.name.trim()) return notify.warning('请先填写商品标题');
      if (drawer.aiFillBusy) return;
      drawer.aiFillBusy = true;
      try {
        const res = await axios.post('/api/yandex/ai-fill', {
          name: drawer.form.name,
          description: drawer.form.description,
          category_id: drawer.form.category_id,
          category_name: drawer.form.category_name,
          attributes: drawer.form.attributes,
        }, { timeout: 180000 });
        const data = res.data || {};
        if (data.name) drawer.form.name = data.name;
        if (data.description) drawer.form.description = data.description;
        if (Array.isArray(data.attributes)) {
          let filled = 0;
          const filledZh = [];
          for (const a of data.attributes) {
            if (!a || !a.name || !a.value) continue;
            if (String(a.value).trim()) {
              drawer.form.attributes[a.name] = String(a.value).trim();
              drawer.dirtyAttrs[a.name] = true;
              filled += 1;
              const tpl = attrTemplateOf(a.name);
              filledZh.push((tpl && tpl.name_zh) || a.name_zh || a.name);
            }
          }
          drawer.aiFilled = true;
          notify.success('AI 填充完成：' + filled + ' 个属性已补全（' + filledZh.slice(0, 6).join('、') + (filledZh.length > 6 ? ' 等' : '') + '），请核对后点「保存并更新到 Yandex」');
        } else {
          notify.success('AI 填充完成');
        }
        drawer.aiNotes = data.notes || [];
        if (drawer.aiNotes.length) {
          const mb = window.ElementPlus && window.ElementPlus.ElMessageBox;
          if (mb) mb.alert(drawer.aiNotes.join('<br/>'), 'AI 改动说明', { dangerouslyUseHTMLString: true });
        }
      } catch (e) {
        notify.error((e.response?.data?.error) || e.message || 'AI 填充失败');
      } finally {
        drawer.aiFillBusy = false;
      }
    };

    const setAttrValue = (name, value) => {
      drawer.form.attributes[name] = String(value ?? '');
      drawer.dirtyAttrs[name] = true;
    };
    const attrTemplateOf = (name) => (drawer.attrTemplate || []).find((t) => t.name === name);
    const drawerMissingAttrs = Vue.computed(() => {
      const tpl = drawer.attrTemplate || [];
      return tpl.filter((t) => {
        const cur = String(drawer.form.attributes[t.name] ?? '').trim();
        const recommended = Array.isArray(t.recommendation) ? t.recommendation.some((r) => String(r).toUpperCase() !== 'ADDITIONAL') : false;
        return !cur && (t.required === true || recommended);
      });
    });

    const openProfitDialog = () => {
      profitDialog.visible = true;
    };

    const fixedCostWithCross = (crossBorderFeeCny) => {
      const c = profitDialog.cost;
      return roundMoney(
        Number(c.purchaseCny || 0)
        + Number(c.domesticShippingCny || 0)
        + Number(c.serviceFeeCny || 0)
        + Number(crossBorderFeeCny || 0)
        + Number(c.lastMileCny || 0),
      );
    };

    const variableRate = Vue.computed(() => {
      const c = profitDialog.cost;
      return Math.max(0, (
        Number(c.commissionPct || 0)
        + Number(c.acquiringPct || 0)
        + Number(c.withdrawalPct || 0)
        + Number(c.returnLossPct || 0)
        + Number(c.adPct || 0)
      ) / 100);
    });

    const currentPriceCny = Vue.computed(() => roundMoney(priceToCny(drawer.form.price, drawer.form.currency_code)));
    const currentCrossBorder = Vue.computed(() => calcCelEconomy(currentPriceCny.value || 0));
    const fixedCostCny = Vue.computed(() => fixedCostWithCross(currentCrossBorder.value.feeCny));

    const currentProfitPreview = Vue.computed(() => {
      const priceCny = currentPriceCny.value;
      const fees = roundMoney(priceCny * variableRate.value);
      const profit = roundMoney(priceCny - fixedCostCny.value - fees);
      const margin = priceCny > 0 ? roundMoney((profit / priceCny) * 100) : 0;
      return { priceCny, fees, profit, margin };
    });

    const suggestedPriceModel = Vue.computed(() => {
      const targetRate = Math.max(0, Number(profitDialog.cost.targetMarginPct || 0) / 100);
      const denominator = 1 - variableRate.value - targetRate;
      const baseCost = Number(profitDialog.cost.purchaseCny || 0)
        + Number(profitDialog.cost.domesticShippingCny || 0)
        + Number(profitDialog.cost.serviceFeeCny || 0)
        + Number(profitDialog.cost.lastMileCny || 0);
      if (baseCost <= 0 || denominator <= 0.01) return { priceCny: 0, logistics: calcCelEconomy(0), fixedCostCny: 0 };

      let priceCny = roundMoney((baseCost + calcCelEconomy(0).feeCny) / denominator);
      let logistics = calcCelEconomy(priceCny);
      for (let i = 0; i < 5; i += 1) {
        priceCny = roundMoney((baseCost + logistics.feeCny) / denominator);
        logistics = calcCelEconomy(priceCny);
      }
      return { priceCny, logistics, fixedCostCny: fixedCostWithCross(logistics.feeCny) };
    });
    const suggestedPriceCny = Vue.computed(() => suggestedPriceModel.value.priceCny);
    const suggestedCrossBorder = Vue.computed(() => suggestedPriceModel.value.logistics);

    const suggestedPriceDisplay = Vue.computed(() => roundMoney(priceFromCny(suggestedPriceCny.value, drawer.form.currency_code)));
    const strikePriceDisplay = Vue.computed(() => {
      const discount = Number(profitDialog.cost.strikeDiscountPct || 0);
      if (suggestedPriceDisplay.value <= 0 || discount <= 0 || discount >= 100) return 0;
      return roundMoney(suggestedPriceDisplay.value / (discount / 100));
    });

    const applySuggestedPrice = () => {
      if (suggestedPriceDisplay.value <= 0) return notify.warning('请先录入采购成本，并检查费率和目标毛利。');
      drawer.form.price = suggestedPriceDisplay.value;
      notify.success('已把建议售价回填到商品售价');
    };

    const saveProduct = async () => {
      if (!drawer.form.offer_id) return notify.error('缺少 Yandex 货号');
      saveLoading.value = true;
      try {
        const dirtyAttributes = Object.keys(drawer.dirtyAttrs || {})
          .filter((n) => drawer.form.attributes[n] && String(drawer.form.attributes[n]).trim())
          .map((n) => ({ name: n, value: drawer.form.attributes[n] }));
        const payload = {
          ai_filled: drawer.aiFilled === true,
          name: drawer.form.name,
          brand: drawer.form.brand,
          description: drawer.form.description,
          marketCategoryId: drawer.form.category_id,
          price: drawer.form.price,
          currency_code: drawer.form.currency_code,
          images: String(drawer.form.imagesText || '').split(/\n|,/).map((item) => item.trim()).filter(Boolean),
          attributes: dirtyAttributes,
        };
        await axios.patch(`/api/yandex/products/${encodeURIComponent(drawer.form.offer_id)}`, payload, { timeout: 120000 });
        notify.success('Yandex 商品已提交更新，平台生效可能需要几分钟');
        drawer.visible = false;
        fetchProducts();
      } catch (error) {
        notify.error(error.response?.data?.error || error.message || '保存 Yandex 商品失败');
      } finally {
        saveLoading.value = false;
      }
    };

    // ===== Task #41: 核价 / 调价（1688 候选 + 批量写回）=====
    const selectedRows = Vue.ref([]);
    const reverseDialog = Vue.reactive({ visible: false, rows: [], busy: false, applying: false });
    const hoverImg = Vue.reactive({ show: false, url: '', x: 0, y: 0, left: 0, top: 0 });
    const priceState = Vue.reactive({}); // offerId -> { candidate, records }
    const researchDialog = Vue.reactive({ visible: false, busy: false, error: '', rows: [], jobId: '', jobText: '', pluginDisabled: false, stopRequested: false, stopping: false, pluginPhase: false });
    const researchTableRef = Vue.ref(null);
    const stateDrawer = Vue.reactive({
      visible: false, offerId: '', name: '', image: '',
      candidate: null, records: [], suggest: null,
      saving: false, applying: false, suggestBusy: false,
    });
    const applyDialog = Vue.reactive({ visible: false, busy: false, rows: [], results: [] });

    const confirmBox = (message, title) => {
      const mb = window.ElementPlus && window.ElementPlus.ElMessageBox;
      if (!mb) return Promise.reject(new Error('ElementPlus MessageBox 未加载'));
      return mb.confirm(message, title || '请确认', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' });
    };

    const handleSelectionChange = (val) => { selectedRows.value = val || []; };

    // ===== 全店批量核价（服务端 AlphaShop 后台任务）=====
    const bulkPricingDialog = Vue.reactive({
      visible: false, jobId: '', status: '', phase: '', total: 0, processed: 0,
      priced: 0, noMatch: 0, needWeight: 0, error: '', busy: false, pollTimer: null,
      summaryRows: [],
    });
    const stopBulkPoll = () => {
      if (bulkPricingDialog.pollTimer) { clearInterval(bulkPricingDialog.pollTimer); bulkPricingDialog.pollTimer = null; }
    };
    // 拉取当前筛选下全部 offer（分页翻完）用于后台核价
    const collectFilteredOfferIds = async () => {
      const ids = [];
      let page = 1;
      const pageSize = 100;
      for (let i = 0; i < 50; i += 1) {
        const res = await axios.get('/api/yandex/products', {
          params: { status: activeTab.value, quality: qualityFilter.value, ai: aiFilter.value, diagnostic: diagnosticFilter.value, price: priceFilter.value, q: search.value, page, page_size: pageSize },
        });
        const items = res.data?.items || [];
        for (const it of items) ids.push(String(it.offer_id || it.offerId || '').trim());
        const total = Number(res.data?.total || ids.length);
        if (ids.length >= total || !items.length) break;
        page += 1;
      }
      return ids.filter(Boolean);
    };
    const startBulkPricing = async (offerIds) => {
      const ids = (offerIds && offerIds.length ? offerIds : (await collectFilteredOfferIds()));
      const uniq = [...new Set(ids)];
      if (!uniq.length) return notify.warning('当前筛选下没有可核价商品');
      bulkPricingDialog.busy = true;
      bulkPricingDialog.jobId = '';
      bulkPricingDialog.status = '';
      bulkPricingDialog.error = '';
      try {
        const res = await axios.post('/api/yandex/bulk-pricing', { offer_ids: uniq }, { timeout: 30000 });
        bulkPricingDialog.jobId = res.data?.jobId || '';
        bulkPricingDialog.total = Number(res.data?.total || uniq.length);
        if (!bulkPricingDialog.jobId) throw new Error('未返回任务号');
        notify.success(`已提交 ${uniq.length} 个商品进行后台批量核价（AlphaShop），可关弹窗稍后查看`);
        bulkPricingDialog.visible = true;
        pollBulkPricing();
      } catch (e) {
        notify.error('启动批量核价失败: ' + (e.response?.data?.error || e.message));
      } finally {
        bulkPricingDialog.busy = false;
      }
    };
    const pollBulkPricing = async () => {
      stopBulkPoll();
      const doPoll = async () => {
        if (!bulkPricingDialog.jobId) return;
        try {
          const res = await axios.get('/api/yandex/bulk-pricing/' + encodeURIComponent(bulkPricingDialog.jobId));
          const job = res.data?.job || {};
          bulkPricingDialog.status = job.status || '';
          bulkPricingDialog.phase = job.phase || '';
          bulkPricingDialog.total = Number(job.total || bulkPricingDialog.total || 0);
          bulkPricingDialog.processed = Number(job.processed || 0);
          const results = Array.isArray(job.results) ? job.results : [];
          bulkPricingDialog.priced = results.filter((r) => r?.ok && r?.reason === 'priced').length;
          bulkPricingDialog.noMatch = results.filter((r) => ['no_match', 'no_image'].includes(r?.reason)).length;
          bulkPricingDialog.needWeight = results.filter((r) => r?.reason === 'need_weight').length;
          bulkPricingDialog.error = job.error || '';
          bulkPricingDialog.summaryRows = results.slice(-30).map((r) => ({
            offerId: r.offerId || r.offer_id || '',
            ok: !!r.ok, reason: r.reason || '',
            purchaseCny: r.purchaseCny || '',
            suggestPriceCny: r.suggestPriceCny || r.suggest?.priceCny || '',
            title: (r.title || (r.best && r.best.title) || '').slice(0, 50),
            img: (r.best && (r.best.img || r.best.originImageUrl)) || (r.candidates && r.candidates[0] && r.candidates[0].img) || '',
          }));
          if (['done', 'error', 'canceled'].includes(job.status)) {
            stopBulkPoll();
            if (job.status === 'done') {
              notify.success(`批量核价完成：定价 ${bulkPricingDialog.priced} · 无同款 ${bulkPricingDialog.noMatch} · 待补重量 ${bulkPricingDialog.needWeight}`);
              fetchProducts();
            } else if (job.error) notify.error('批量核价失败: ' + job.error);
          }
        } catch (_e) { /* 轮询失败继续 */ }
      };
      await doPoll();
      if (!['done', 'error', 'canceled'].includes(bulkPricingDialog.status)) {
        bulkPricingDialog.pollTimer = setInterval(doPoll, 6000);
      }
    };
    const reasonText = (reason) => ({
      priced: '✓ 已定价', need_weight: '⚠ 待补重量', no_match: '✗ 无同款', no_image: '✗ 无图',
      already_applied: '已应用(跳过)', bad_price: '✗ 价格异常', not_in_cache: '? 缓存缺失', error: '✗ 出错',
    }[reason] || reason || '-');
    // 查询最近的后台核价任务：返回最近一条 running/queued（或最近 done）
    const checkRecentBulkJob = async () => {
      try {
        const res = await axios.get('/api/yandex/bulk-pricing');
        const jobs = res.data?.jobs || [];
        return jobs[0] || null;
      } catch (_e) { return null; }
    };
    const resumeBulkPricing = async (job) => {
      if (!job || !job.id) return;
      bulkPricingDialog.jobId = job.id;
      bulkPricingDialog.status = job.status || '';
      bulkPricingDialog.phase = job.phase || '';
      bulkPricingDialog.total = Number(job.total || 0);
      bulkPricingDialog.processed = Number(job.processed || 0);
      bulkPricingDialog.visible = true;
      pollBulkPricing();
    };
    const openBulkPricingCurrentTab = async () => {
      // 已有任务在跑 → 直接打开进度，避免重复发起
      const recent = await checkRecentBulkJob();
      if (recent && ['queued', 'running'].includes(recent.status)) {
        await resumeBulkPricing(recent);
        notify.info('检测到后台核价任务仍在进行，已为你打开进度（进度 ' + (recent.processed || 0) + '/' + (recent.total || 0) + '）。');
        return;
      }
      if (recent && recent.status === 'done' && recent.processed === recent.total) {
        // 最近一次已完成：询问是查看结果还是重新发起
        try {
          await window.ElementPlus.ElMessageBox.confirm(
            `最近一次后台核价已完成（${recent.processed || 0} 条），要查看结果还是重新对当前筛选核价？`,
            '后台批量核价',
            { type: 'info', confirmButtonText: '重新核价', cancelButtonText: '查看上次结果', distinguishCancelAndClose: true },
          );
          // 确认 → 新建
        } catch (cancelResult) {
          // 取消按钮 → 查看上次结果
          if (cancelResult === 'cancel' || cancelResult === 'close') {
            await resumeBulkPricing(recent);
            return;
          }
          return;
        }
      }
      const msg = activeTab.value === 'all'
        ? '将对「全部」筛选下的商品发起后台批量核价（AlphaShop 图搜），数量多时需较长时间，是否继续？'
        : `将对「${(statusTabItems.value.find(t => t.value === activeTab.value) || {}).label || activeTab.value}」筛选下的商品后台批量核价？`;
      try {
        await window.ElementPlus.ElMessageBox.confirm(msg, '后台批量核价', { type: 'warning', confirmButtonText: '开始核价', cancelButtonText: '取消' });
      } catch { return; }
      startBulkPricing();
    };

    // ===== 全店插件精核价（1688 官方真实价，用本机插件的 1688 登录态）=====
    // 与 AlphaShop 批量核价的区别：AlphaShop 图搜只能给“这家店最便宜那个 SKU”（常是引流配件档），
    // 本流程让插件以图找货 + 打开 1688 详情页读真实价格阶梯，采购价取「起批首档单价」。
    const preciseDialog = Vue.reactive({
      visible: false, jobId: '', status: '', phase: '', total: 0, processed: 0,
      busy: false, pollTimer: null, error: '', report: null, onlyIssues: false, notice: '',
    });
    const stopPrecisePoll = () => {
      if (preciseDialog.pollTimer) { clearInterval(preciseDialog.pollTimer); preciseDialog.pollTimer = null; }
    };
    const preciseReasonText = (reason) => ({
      ok: '可直接采用（起批首档价）', need_confirm: '待人工核对（无完整阶梯）',
      no_price: '价格未取到', no_match: '无同款',
    }[reason] || reason || '-');
    const preciseReasonTag = (reason) => ({
      ok: 'success', need_confirm: 'warning', no_price: 'warning', no_match: 'danger',
    }[reason] || 'info');
    const preciseRows = Vue.computed(() => {
      const rows = (preciseDialog.report && preciseDialog.report.rows) || [];
      return preciseDialog.onlyIssues ? rows.filter((r) => r.reason !== 'ok') : rows;
    });
    const preciseBands = Vue.computed(() => (preciseDialog.report && preciseDialog.report.bands) || []);
    const pollPrecise1688 = async () => {
      stopPrecisePoll();
      const doPoll = async () => {
        if (!preciseDialog.jobId) return;
        try {
          const res = await axios.get('/api/yandex/precise-1688/' + encodeURIComponent(preciseDialog.jobId));
          const job = res.data?.job || {};
          preciseDialog.status = job.status || '';
          preciseDialog.phase = job.phase || '';
          preciseDialog.total = Number(job.total || preciseDialog.total || 0);
          preciseDialog.processed = Number(job.processed || 0);
          preciseDialog.error = job.error || '';
          preciseDialog.report = res.data?.report || null;
          if (!['queued', 'claimed', 'running'].includes(job.status) && !preciseDialog.status) preciseDialog.status = job.status || '';
          if (['done', 'error', 'canceled'].includes(job.status)) {
            stopPrecisePoll();
            if (job.status === 'done') {
              const r = preciseDialog.report || {};
              notify.success(`插件精核价完成：可直接采用 ${r.ready || 0} · 待人工核对 ${(r.needConfirm || 0) + (r.noPrice || 0)} · 无同款 ${r.noMatch || 0}`);
              fetchProducts();
            } else if (job.error) notify.error('插件精核价失败: ' + job.error);
          }
        } catch (_e) { /* 轮询失败继续 */ }
      };
      await doPoll();
      if (!['done', 'error', 'canceled'].includes(preciseDialog.status)) {
        preciseDialog.pollTimer = setInterval(doPoll, 6000);
      }
    };
    const checkRecentPreciseJob = async () => {
      try {
        const res = await axios.get('/api/yandex/precise-1688');
        return (res.data?.jobs || [])[0] || null;
      } catch (_e) { return null; }
    };
    const resumePrecise1688 = async (job) => {
      if (!job || !job.id) return;
      preciseDialog.jobId = job.id;
      preciseDialog.status = job.status || '';
      preciseDialog.phase = job.phase || '';
      preciseDialog.total = Number(job.total || 0);
      preciseDialog.processed = Number(job.processed || 0);
      preciseDialog.visible = true;
      pollPrecise1688();
    };
    const startPrecise1688 = async () => {
      preciseDialog.busy = true;
      preciseDialog.error = '';
      preciseDialog.notice = '';
      try {
        const res = await axios.post('/api/yandex/precise-1688', {}, { timeout: 120000 });
        preciseDialog.jobId = res.data?.jobId || '';
        preciseDialog.total = Number(res.data?.total || 0);
        if (!preciseDialog.jobId) throw new Error('未返回任务号');
        preciseDialog.visible = true;
        if (res.data?.existing) {
          notify.info('已有插件精核价任务在进行，已为你打开进度。');
        } else {
          notify.success(`已提交 ${res.data?.total || 0} 个「销售中」商品给本机插件核价（1688 官方），需插件在线并登录 1688。`);
          if (Number(res.data?.skipped || 0) > 0) preciseDialog.notice = `有 ${res.data.skipped} 个商品无可用图片被跳过。`;
        }
        pollPrecise1688();
      } catch (e) {
        const msg = e.response?.data?.error || e.message || '启动失败';
        preciseDialog.error = msg;
        notify.error('启动插件精核价失败: ' + msg);
      } finally {
        preciseDialog.busy = false;
      }
    };
    const openPreciseCurrentTab = async () => {
      const recent = await checkRecentPreciseJob();
      if (recent && ['queued', 'claimed', 'running'].includes(recent.status)) {
        await resumePrecise1688(recent);
        notify.info(`检测到插件精核价仍在进行（${recent.processed || 0}/${recent.total || 0}），已打开进度。`);
        return;
      }
      if (recent && recent.status === 'done') {
        try {
          await window.ElementPlus.ElMessageBox.confirm(
            `上次精核价已完成（${recent.processed || 0}/${recent.total || 0}）。要查看上次结果，还是重新核价？`,
            '插件精核价（1688 官方真实价）',
            { type: 'info', confirmButtonText: '重新核价', cancelButtonText: '查看上次结果', distinguishCancelAndClose: true },
          );
        } catch (cancelResult) {
          if (cancelResult === 'cancel' || cancelResult === 'close') { await resumePrecise1688(recent); return; }
          return;
        }
      }
      try {
        await window.ElementPlus.ElMessageBox.confirm(
          '将对本店「销售中」商品逐个做 1688 官方以图找货 + 打开详情页读真实价格阶梯，采购价取「起批首档单价」。\n'
          + '需要：本机 Chrome 装着采集插件并已登录 1688；核价期间请保持浏览器开启（可关本弹窗，后台继续）。\n'
          + '速度约 15-40 秒/个，163 个约 40-90 分钟。是否开始？',
          '插件精核价（1688 官方真实价）',
          { type: 'warning', confirmButtonText: '开始核价', cancelButtonText: '取消' },
        );
      } catch { return; }
      await startPrecise1688();
    };
    const stopPreciseJob = async () => {
      if (!preciseDialog.jobId) return;
      try {
        await axios.post('/api/jobs/' + encodeURIComponent(preciseDialog.jobId) + '/cancel', {}, { timeout: 15000 });
        notify.info('已请求停止插件精核价（插件端会尽快中止，已核结果已保存）');
      } catch (_e) {
        notify.warning('停止请求发送失败，任务可能刚好完成');
      }
    };

    // 上架/下架：调 /api/yandex/products/visibility（hidden-offers）。list=恢复显示，unlist=隐藏
    const visBusy = Vue.ref(false);
    const changeVisibility = async (action) => {
      const rows = selectedRows.value || [];
      const ids = rows.map((r) => r.offer_id || r.offerId || '').filter(Boolean);
      if (!ids.length) return notify.warning('请先勾选要操作的 Yandex 商品');
      const isList = action === 'list';
      try {
        await window.ElementPlus.ElMessageBox.confirm(
          `确定对勾选的 ${ids.length} 个商品${isList ? '执行「上架」（恢复在 Yandex 前台显示）' : '执行「下架」（从 Yandex 前台隐藏）'}？\n平台数据更新需要几分钟生效。`,
          isList ? '上架商品' : '下架商品',
          { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' },
        );
      } catch { return; }
      visBusy.value = true;
      try {
        const res = await axios.post('/api/yandex/products/visibility', { action: isList ? 'list' : 'unlist', offerIds: ids }, { timeout: 120000 });
        const n = Number(res.data?.count || ids.length);
        notify.success(`${isList ? '上架' : '下架'}已提交 ${n} 个商品（${res.data?.chunks || 1} 批），平台处理中`);
        // 稍后刷新缓存与列表
        await fetchProducts();
        fetchProducts();
      } catch (e) {
        notify.error(`${isList ? '上架' : '下架'}失败: ` + (e.response?.data?.error || e.message));
      } finally {
        visBusy.value = false;
      }
    };

    // 缩略图悬停大图预览
    const onImgEnter = (ev, row) => {
      hoverImg.url = row.image || row.primary_image || (Array.isArray(row.images) ? (row.images[0] || '') : '') || '';
      hoverImg.show = Boolean(hoverImg.url);
      onImgMove(ev);
    };
    const onImgMove = (ev) => {
      hoverImg.x = ev.clientX;
      hoverImg.y = ev.clientY;
      const vw = window.innerWidth || 1600;
      const vh = window.innerHeight || 900;
      hoverImg.left = Math.max(8, Math.min(hoverImg.x + 18, vw - 336));
      hoverImg.top = Math.max(8, Math.min(hoverImg.y + 18, vh - 420));
    };
    const onImgLeave = () => { hoverImg.show = false; hoverImg.url = ''; };

    const mapCandidate = (c) => {
      if (!c) return null;
      return {
        offerId: c.offer_id, purchaseCny: Number(c.purchase_cny || 0),
        supplier: c.supplier || '', sourceUrl1688: c.source_url_1688 || '',
        score: Number(c.score || 0), weightKg: Number(c.weight_kg || 0),
        lenCm: Number(c.len_cm || 0), widCm: Number(c.wid_cm || 0), heiCm: Number(c.hei_cm || 0),
        pkgQty: Number(c.pkg_qty || 1), suggestPriceCny: Number(c.suggest_price_cny || 0),
        zone: c.zone || '', celFeeCny: Number(c.cel_fee_cny || 0),
        status: c.status || 'pending', source: c.source || '', updatedAt: c.updated_at || '',
      };
    };

    const mapRecord = (r) => ({
      offerId: r.offer_id, purchaseCny: Number(r.purchase_cny || 0),
      oldPriceCny: Number(r.old_price_cny || 0), newPriceCny: Number(r.new_price_cny || 0),
      zone: r.zone || '', status: r.status || '', error: r.error || '', createdAt: r.created_at || '',
    });

    const rowFirstImage = (row) => (Array.isArray(row.images) && row.images.length ? row.images[0] : (row.image || ''));

    const pricingParams = () => {
      const c = profitDialog.cost;
      return {
        domesticShippingCny: Number(c.domesticShippingCny || 0),
        serviceFeeCny: Number(c.serviceFeeCny || 0),
        lastMileCny: Number(c.lastMileCny || 0),
        commissionPct: Number(c.commissionPct || 0),
        acquiringPct: Number(c.acquiringPct || 0),
        withdrawalPct: Number(c.withdrawalPct || 0),
        returnLossPct: Number(c.returnLossPct || 0),
        adPct: Number(c.adPct || 0),
        targetMarginPct: Number(c.targetMarginPct || 0),
        strikeDiscountPct: Number(c.strikeDiscountPct || 0) || 50,
        exchangeRate: Number(c.exchangeRate || 0) || 12.8205,
      };
    };

    const refreshPriceState = async (offerIds) => {
      const ids = (offerIds || []).map((v) => String(v)).filter(Boolean);
      if (!ids.length) return;
      try {
        const res = await axios.get('/api/yandex/price-state', { params: { offerIds: ids.join(',') }, timeout: 30000 });
        const items = (res.data && res.data.items) || [];
        for (const it of items) {
          priceState[it.offerId] = { candidate: mapCandidate(it.candidate), records: (it.records || []).map(mapRecord) };
        }
      } catch (_e) { /* 状态查询失败不阻塞列表 */ }
    };

    const buildResearchRow = (row) => ({
      offerId: row.offer_id || row.offerId || '',
      name: row.name || row.title || '',
      categoryName: row.category_name || row.category || '',
      categoryLeaf: row.category_leaf || '',
      imgUrl: rowFirstImage(row),
      images: (Array.isArray(row.images) ? row.images : []).filter(Boolean).slice(0, 3),
      status: 'queued', message: '', result: null, chosen: -1,
      // 尺寸重量优先预填平台(店铺/Ozon)已同步值，1688 候选有值才覆盖；平台无则回落默认待手动确认
      cand: {
        purchaseCny: 0, supplier: '', sourceUrl1688: '', score: 0,
        weightKg: Number(row.weightKg) > 0 ? Number(row.weightKg) : 0.2,
        lenCm: Number(row.lenCm || 0), widCm: Number(row.widCm || 0), heiCm: Number(row.heiCm || 0),
        pkgQty: 1,
      },
      suggest: null, suggestBusy: false,
    });

    // ===== 插件模式核价（1688 官方同款）编排 =====
    const parseDimCm = (text) => {
      const raw = String(text || '').replace(/[（(]?[长宽高厚]*[）)]?/g, ' ').trim();
      const nums = (raw.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter((n) => n > 0 && n < 100000);
      return nums.length ? { lenCm: nums[0], widCm: nums[1] || 0, heiCm: nums[2] || 0 } : null;
    };
    const parseWeightKg = (c) => {
      const direct = Number(c.weightKg || c.weight_kg || 0);
      if (direct > 0) return direct;
      const grams = Number(c.weightGrams || 0);
      if (grams > 0) return Math.round((grams / 1000) * 1000) / 1000;
      const text = String(c.weightText || '');
      const m = text.match(/(\d+(?:\.\d+)?)\s*(kg|千克|公斤)/i);
      if (m) return Number(m[1]);
      const g = text.match(/(\d+(?:\.\d+)?)\s*g(?:ram)?s?\b/i);
      if (g) return Math.round((Number(g[1]) / 1000) * 1000) / 1000;
      return 0;
    };
    const normPluginCand = (c) => {
      if (!c) return null;
      const img = c.img || c.image || c.imageUrl || c.originImageUrl || (Array.isArray(c.images) ? c.images[0] : '') || '';
      const price = Number(c.price || c.salePrice || c.minPrice || 0);
      // 插件候选价格来自 1688 阶梯最低档，可能为 ¥1 引流价：只要 >0 就展示，由用户核对/手动改价
      if (!img || !(price > 0)) return null;
      const detailUrl = c.detailUrl || c.link || c.url || '';
      const dimsText = String(c.dimensionsText || '').trim();
      const weightText = String(c.weightText || '').trim();
      const dims = parseDimCm(dimsText);
      const weightKg = parseWeightKg(c);
      return {
        offerId1688: String(c.offerId || c.id || c.itemId || c.offerId1688 || ''),
        title: String(c.title || c.originTitle || '').slice(0, 120),
        price: Math.round(price * 100) / 100,
        sold: Number(c.sold || c.sales || c.volume || c.soldOut || 0),
        img,
        detailUrl,
        trafficBaitRisk: !!c.trafficBaitRisk,
        dimsText, weightText,
        lenCm: dims ? dims.lenCm : 0,
        widCm: dims ? dims.widCm : 0,
        heiCm: dims ? dims.heiCm : 0,
        weightKg,
      };
    };

    const applyPluginResults = (rows, results) => {
      for (const row of rows) {
        const item = (results || []).find((x) => String(x.offerId) === String(row.offerId));
        if (!item) { row.status = 'queued'; row.message = ''; continue; }
        const candidates = (Array.isArray(item.candidates) ? item.candidates : []).map(normPluginCand).filter(Boolean);
        if (candidates.length) {
          row.status = 'ok';
          row.message = '';
          row.result = { ok: true, matchSource: 'plugin', source: 'plugin-1688', candidates, best: candidates[0] };
          applyCandidateFields(row, 0, { silent: true });
        } else {
          row.status = 'empty';
          row.message = '插件未返回候选（可能 1688 登录态异常），可手动填成本';
        }
      }
      // 核价完成自动展开有候选的行，方便直接看图核对同款
      Vue.nextTick(() => {
        const table = researchTableRef.value;
        if (!table) return;
        for (const row of rows) {
          if (row.status === 'ok' && row.result?.candidates?.length) {
            try { table.toggleRowExpansion(row, true); } catch (_e) { /* 展开失败不阻塞 */ }
          }
        }
      });
      calcAllSuggest();
    };

    const tryPluginResearch = async (targets) => {
      if (researchDialog.pluginDisabled) return false;
      if (researchDialog.stopRequested) return 'aborted';
      researchDialog.jobText = '正在提交给本机插件做 1688 官方同款搜索…';
      let jobId = '';
      try {
        const created = await axios.post('/api/yandex/research-job', {
          items: targets.map((t) => ({ offerId: t.offerId, name: t.name, images: ((t.images && t.images.length ? t.images : [t.imgUrl]).filter(Boolean)).slice(0, 3) })),
        }, { timeout: 20000 });
        jobId = created.data && created.data.jobId;
        if (!jobId) throw new Error('服务端未返回任务号');
        researchDialog.jobId = jobId;
        researchDialog.pluginPhase = true;
      } catch (err) {
        const data = (err && err.response && err.response.data) || {};
        if (err && err.response && err.response.status === 409 && data.code === 'precise_running') {
          // 全店精核价占着插件：明确提示并停止本轮，绝不回落到 AlphaShop（那是不可信价源）
          researchDialog.error = data.error || '本机插件正在跑全店精核价，请等它跑完再单独核价。';
          researchDialog.jobText = '已暂停本批核价：全店精核价进行中';
          targets.forEach((t) => { t.message = '全店精核价进行中，稍后重试'; });
          return 'aborted';
        }
        researchDialog.pluginDisabled = true;
        researchDialog.jobText = '插件任务不可用，回落 AlphaShop 搜索';
        return false;
      }
      let queuedAt = 0;
      try {
        const deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        if (researchDialog.stopRequested) {
          researchDialog.jobText = '正在停止插件核价…';
          try { await axios.post('/api/jobs/' + encodeURIComponent(jobId) + '/cancel', {}, { timeout: 15000 }); } catch (_e3) { /* 任务可能已结束 */ }
          researchDialog.jobText = '已请求停止，未完成商品不再自动回落搜索';
          return 'aborted';
        }
        await new Promise((r) => setTimeout(r, 2500));
        let job = null;
        try { const g = await axios.get('/api/jobs/' + encodeURIComponent(jobId), { timeout: 15000 }); job = g.data && (g.data.job || g.data); } catch (_e2) { job = null; }
        if (!job) continue;
        const st = job.status || '';
        if (job.phase && !/完成|收尾/.test(String(job.phase))) researchDialog.jobText = String(job.phase).slice(0, 60);
        if (st === 'queued') {
          if (!queuedAt) queuedAt = Date.now();
          if (Date.now() - queuedAt > 45000) {
            researchDialog.jobText = '插件 45s 内未认领（可能离线或未开启），回落 AlphaShop 搜索';
            return false;
          }
          if (!researchDialog.jobText.startsWith('等待')) researchDialog.jobText = '等待本机插件认领（插件每 30 秒轮询一次，可点下方「停止」取消）…';
          continue;
        }
        if (st === 'claimed' || st === 'running' || st === 'processing') continue;
        if (st === 'done' || st === 'error' || st === 'canceled') {
          applyPluginResults(researchDialog.rows, (job.results || []));
          researchDialog.jobText = st === 'done' ? '插件核价完成' : '插件未匹配，回落 AlphaShop 搜索';
          return st === 'done';
        }
      }
      researchDialog.jobText = '插件核价超时，回落 AlphaShop 搜索';
      return false;
      } finally {
        researchDialog.pluginPhase = false;
      }
    };

    const runResearch = async () => {
      const targets = researchDialog.rows.filter((r) => r.status === 'queued');
      if (!targets.length) return;
      const pluginResult = await tryPluginResearch(targets);
      if (pluginResult === true || pluginResult === 'aborted') return;
      const remain = researchDialog.rows.filter((r) => r.status === 'queued');
      if (remain.length) await runAlphaResearch();
    };

    const stopPluginJob = async () => {
      const jobId = researchDialog.jobId;
      if (!jobId || researchDialog.stopping) return;
      researchDialog.stopping = true;
      researchDialog.stopRequested = true;
      researchDialog.jobText = '正在请求停止插件核价…';
      try {
        await axios.post('/api/jobs/' + encodeURIComponent(jobId) + '/cancel', {}, { timeout: 15000 });
        researchDialog.jobText = '已请求停止插件核价（插件端会尽快中止，未完成商品不再自动回落搜索）';
      } catch (_e) {
        researchDialog.jobText = '停止请求发送失败，任务可能刚好完成';
      }
      researchDialog.stopping = false;
    };

    const runAlphaResearch = async () => {
      const targets = researchDialog.rows.filter((r) => r.status === 'queued');
      if (!targets.length) return;
      researchDialog.busy = true;
      researchDialog.error = '';
      targets.forEach((t) => { t.status = 'running'; t.message = '正在搜索 1688 同款…'; });
      try {
        const chunks = [];
        for (let i = 0; i < targets.length; i += 10) chunks.push(targets.slice(i, i + 10));
        for (const chunk of chunks) {
          let res;
          try {
            res = await axios.post('/api/yandex/price-research', {
              items: chunk.map((t) => ({ offerId: t.offerId, imgUrl: t.imgUrl, images: (t.images && t.images.length ? t.images : undefined), title: t.name })),
            }, { timeout: 240000 });
          } catch (chunkError) {
            const msg = (chunkError.response && chunkError.response.data && chunkError.response.data.error) || chunkError.message || '核价失败';
            if (chunkError.response && chunkError.response.status === 400 && /AlphaShop|凭据/i.test(msg)) {
              researchDialog.error = 'AlphaShop 凭据未配置，自动核价不可用；可手动填写采购信息后保存候选。';
              chunk.forEach((t) => { t.status = 'empty'; t.message = '手动填写候选'; });
            } else {
              chunk.forEach((t) => { if (t.status === 'running') { t.status = 'fail'; t.message = msg; } });
              notify.error(msg);
            }
            continue;
          }
          const results = (res.data && res.data.results) || [];
          for (const t of chunk) {
            const r = results.find((x) => String(x.offerId) === String(t.offerId));
            if (!r) { t.status = 'fail'; t.message = '服务端未返回该项结果'; continue; }
            t.result = r;
            if (r.ok) {
              // 仅图搜命中才标“已匹配”；词搜兜底命中标记为疑似，需人工核对
              t.status = r.matchSource === 'image' ? 'ok' : 'suspect';
              t.message = r.matchSource === 'text' ? '仅按标题词搜到疑似同款，请核对是否同一商品（可点下方“纯手动填写”）' : '';
              if (Array.isArray(r.candidates) && r.candidates.length) applyCandidateFields(t, 0, { silent: true });
            } else {
              t.status = 'empty';
              t.message = '未找到可核对的 1688 同款（图搜无结果或候选缺图），可手动填写候选';
            }
          }
        }
        await calcAllSuggest();
      } finally {
        researchDialog.busy = false;
      }
    };

    const calcSuggestRows = async (rows) => {
      const ready = rows.filter((r) => Number(r.cand.purchaseCny || 0) > 0);
      if (!ready.length) return;
      ready.forEach((r) => { r.suggestBusy = true; });
      try {
        const res = await axios.post('/api/yandex/price-suggest', {
          items: ready.map((r) => ({
            offerId: r.offerId, purchaseCny: r.cand.purchaseCny, weightKg: r.cand.weightKg,
            lenCm: r.cand.lenCm, widCm: r.cand.widCm, heiCm: r.cand.heiCm,
            categoryName: r.categoryName || '', categoryLeaf: r.categoryLeaf || '',
            params: pricingParams(),
          })),
        }, { timeout: 60000 });
        const results = (res.data && res.data.results) || [];
        for (const r of results) {
          const row = ready.find((x) => String(x.offerId) === String(r.offerId));
          if (row) row.suggest = r && r.ok ? r : null;
        }
      } catch (_e) { /* 预览失败保持为空 */ } finally {
        ready.forEach((r) => { r.suggestBusy = false; });
      }
    };

    const calcAllSuggest = () => calcSuggestRows(researchDialog.rows);
    const calcRowSuggest = (row) => calcSuggestRows([row]);

    const openReversePricing = () => {
      const rows = (selectedRows.value || []).filter((r) => r && (r.offer_id || r.offerId));
      if (!rows.length) return notify.warning('请先勾选要反推定价的商品');
      reverseDialog.rows = rows.map((r) => ({
        offerId: r.offer_id || r.offerId || '',
        name: r.name || r.title || '',
        img: rowFirstImage(r),
        weightKg: Number(r.weightKg || 0) || 0.2,
        lenCm: Number(r.lenCm || 0), widCm: Number(r.widCm || 0), heiCm: Number(r.heiCm || 0),
        categoryName: r.category_name || r.category || '',
        categoryLeaf: r.category_leaf || '',
        ozonPriceCny: Number(r.ozon_price_cny || 0) || null,
        rev: null, err: '',
      }));
      reverseDialog.busy = false;
      reverseDialog.visible = true;
      // 打开后自动开始反推（不再需要手动触发；个别失败行可改 Ozon 价后点行内重试）
      reverseAllRows();
    };

    const reverseOneRow = async (row) => {
      row.err = ''; row.rev = null;
      try {
        const r = await axios.post('/api/yandex/ozon-reverse', {
          vendorCode: row.offerId, ozonPriceCny: Number(row.ozonPriceCny || 0),
          weightKg: row.weightKg, lenCm: row.lenCm, widCm: row.widCm, heiCm: row.heiCm,
          marginPct: Number(profitDialog.cost.ozonMarginPct || 0) || 10,
          domesticCny: Number(profitDialog.cost.domesticShippingCny || 0) || 5,
          rubRate: Number(profitDialog.cost.exchangeRate || 0) || 13,
        }, { timeout: 30000 });
        const d = r.data || {};
        if (!d.ok) { row.err = d.error || '反推失败'; return; }
        row.rev = d;
        if (Number(d.ozonPriceCny || 0) > 0) row.ozonPriceCny = Number(d.ozonPriceCny);
        const s = await axios.post('/api/yandex/price-suggest', { items: [{
          offerId: row.offerId, purchaseCny: Number(d.purchaseCny), weightKg: row.weightKg,
          lenCm: row.lenCm, widCm: row.widCm, heiCm: row.heiCm,
          categoryName: row.categoryName || '', categoryLeaf: row.categoryLeaf || '',
          params: pricingParams(),
        }] }, { timeout: 30000 });
        const sd = ((s.data && s.data.results) || []).find((x) => String(x.offerId) === String(row.offerId)) || {};
        if (sd.ok) row.rev.ys = sd;
      } catch (_e) { row.err = '反推失败（网络/服务异常）'; }
    };

    const reverseAllRows = async () => {
      if (!reverseDialog.rows.length || reverseDialog.busy) return;
      reverseDialog.busy = true;
      await Promise.all(reverseDialog.rows.map((row) => reverseOneRow(row)));
      reverseDialog.busy = false;
      const okN = reverseDialog.rows.filter((r) => r.rev).length;
      notify.success(okN + '/' + reverseDialog.rows.length + ' 反推完成（含 Yandex 建议售价），未成功的见各行提示');
    };

    const applyReverseToYandex = async () => {
      // 保存为价格候选（调价队列），随后由列表「批量应用候选调价」统一提交 Yandex 平台
      const okRows = reverseDialog.rows.filter((r) => r.rev && r.rev.ys);
      if (!okRows.length) return notify.warning('没有成功反推的行可保存');
      if (reverseDialog.applying) return;
      reverseDialog.applying = true;
      try {
        const items = okRows.map((r) => ({
          offerId: r.offerId, name: r.name,
          purchaseCny: Number(r.rev.purchaseCny || 0),
          supplier: '', sourceUrl1688: '', score: 0,
          weightKg: Number(r.weightKg || 0),
          lenCm: Number(r.lenCm || 0), widCm: Number(r.widCm || 0), heiCm: Number(r.heiCm || 0),
          pkgQty: 1,
          suggestPriceCny: Number((r.rev.ys && r.rev.ys.priceCny) || 0),
          zone: (r.rev.ys && r.rev.ys.zone) || '',
          celFeeCny: Number((r.rev.ys && r.rev.ys.celFeeCny) || 0),
          source: 'ozon-reverse',
        }));
        const res = await axios.post('/api/yandex/price-candidates', { items }, { timeout: 120000 });
        const n = res.data && res.data.inserted != null ? res.data.inserted : items.length;
        for (const r of okRows) r.applyResult = '✓ 已保存候选（采购 ¥' + Number(r.rev.purchaseCny).toFixed(2) + ' / 建议 ¥' + r.rev.ys.priceCny + '）';
        notify.success('候选已保存 ' + n + ' 条：关掉本窗后，在列表勾选这些商品，点「批量应用候选调价」统一提交 Yandex');
        fetchProducts();
      } catch (e) {
        notify.error((e.response && e.response.data && e.response.data.error) || e.message || '保存候选失败');
      }
      reverseDialog.applying = false;
    };

    const ozonReverse = async (row) => {
      if (!row || !row.offerId || row.ozonBusy) return;
      row.ozonBusy = true;
      row.ozonMsg = '';
      try {
        const r = await axios.post('/api/yandex/ozon-reverse', {
          vendorCode: row.offerId,
          weightKg: Number(row.cand.weightKg || 0),
          lenCm: Number(row.cand.lenCm || 0),
          widCm: Number(row.cand.widCm || 0),
          heiCm: Number(row.cand.heiCm || 0),
          marginPct: Number(profitDialog.cost.ozonMarginPct || 0) || 10,
          domesticCny: Number(profitDialog.cost.domesticShippingCny || 0) || 5,
          rubRate: Number(profitDialog.cost.exchangeRate || 0) || 13,
        }, { timeout: 30000 });
        const d = r.data || {};
        if (d.ok) {
          row.cand.purchaseCny = Number(d.purchaseCny || 0);
          row.ozonMsg = `Ozon 同款 ¥${Number(d.ozonPriceCny || 0).toFixed(0)}（≈₽${d.priceRub}）→ 反推采购 ¥${Number(d.purchaseCny).toFixed(2)}（佣金 ${d.commission}%${d.descCat ? '·按Ozon类目' : '·默认档'} · 头程 ¥${Number(d.crossCny || 0).toFixed(1)} · 利润率 ${d.marginPct}%）`;
          await calcSuggestRows([row]);
        } else {
          row.ozonMsg = '反推失败：' + (d.error || '未知原因');
        }
      } catch (_e) {
        row.ozonMsg = '反推失败（网络/服务异常）';
      }
      row.ozonBusy = false;
    };

    // 选用某个 1688 候选（idx>=0）→ 回填采购价/链接/销量；idx=-1 → 纯手动
    const applyCandidateFields = (row, idx, { silent = false } = {}) => {
      row.chosen = idx;
      const list = (row.result && Array.isArray(row.result.candidates)) ? row.result.candidates : [];
      const cand = (typeof idx === 'number' && idx >= 0) ? list[idx] : null;
      if (cand) {
        const candFields = {
          purchaseCny: Number(cand.price || 0),
          sourceUrl1688: cand.detailUrl || '',
          score: Number(cand.sold || 0),
        };
        // v2.2.9: 1688 详情有尺寸/重量时一并回写（无数据则保留默认值，供手动确认）
        if (Number(cand.weightKg || 0) > 0) candFields.weightKg = cand.weightKg;
        if (Number(cand.lenCm || 0) > 0) candFields.lenCm = cand.lenCm;
        if (Number(cand.widCm || 0) > 0) candFields.widCm = cand.widCm;
        if (Number(cand.heiCm || 0) > 0) candFields.heiCm = cand.heiCm;
        Object.assign(row.cand, candFields);
      } else {
        Object.assign(row.cand, { purchaseCny: 0, sourceUrl1688: '', score: 0 });
      }
      if (!silent && Number(row.cand.purchaseCny || 0) > 0) calcRowSuggest(row);
    };

    const candRowStyle = (row, idx) => ({
      display: 'flex', alignItems: 'center', gap: '10px', borderRadius: '8px', padding: '8px 10px',
      marginBottom: '6px', cursor: 'pointer',
      border: `1px solid ${row.chosen === idx ? '#3b82f6' : '#eef2f7'}`,
      background: row.chosen === idx ? '#eff6ff' : '#f8fafc',
    });

    const openResearch = (rows) => {
      const valid = (rows || []).filter((r) => r && r.offer_id);
      if (!valid.length) return notify.warning('请先勾选要核价的商品');
      researchDialog.rows = valid.map((r) => {
        const row = buildResearchRow(r);
        // 历史已保存候选（含之前核对过的尺寸重量）作为兜底，1688 候选无值时不丢
        const st = priceState[r.offer_id] || {};
        const pc = st.candidate;
        if (pc) {
          if (Number(pc.weightKg || 0) > 0) row.cand.weightKg = Number(pc.weightKg);
          if (Number(pc.lenCm || 0) > 0) row.cand.lenCm = Number(pc.lenCm);
          if (Number(pc.widCm || 0) > 0) row.cand.widCm = Number(pc.widCm);
          if (Number(pc.heiCm || 0) > 0) row.cand.heiCm = Number(pc.heiCm);
          if (Number(pc.pkgQty || 0) > 0) row.cand.pkgQty = Number(pc.pkgQty);
        }
        return row;
      });
      researchDialog.error = '';
      researchDialog.jobText = '';
      researchDialog.jobId = '';
      researchDialog.pluginDisabled = false;
      researchDialog.stopRequested = false;
      researchDialog.stopping = false;
      researchDialog.visible = true;
      runResearch();
    };
    const openResearchBatch = () => openResearch(selectedRows.value);
    const openResearchRow = (row) => openResearch([row]);

    const retryFailedResearch = () => {
      researchDialog.rows.forEach((r) => {
        if (r.status === 'empty' || r.status === 'fail') { r.status = 'queued'; r.result = null; r.message = ''; }
      });
      runResearch();
    };

    const saveCandidates = async () => {
      const ready = researchDialog.rows.filter((r) => Number(r.cand.purchaseCny || 0) > 0);
      if (!ready.length) return notify.warning('请至少为一项商品填写采购价后再保存候选');
      researchDialog.busy = true;
      try {
        const items = ready.map((r) => ({
          offerId: r.offerId, name: r.name,
          purchaseCny: Number(r.cand.purchaseCny || 0),
          supplier: r.cand.supplier || '',
          sourceUrl1688: r.cand.sourceUrl1688 || '',
          score: Number(r.cand.score || 0),
          weightKg: Number(r.cand.weightKg || 0),
          lenCm: Number(r.cand.lenCm || 0), widCm: Number(r.cand.widCm || 0), heiCm: Number(r.cand.heiCm || 0),
          pkgQty: Number(r.cand.pkgQty || 1),
          suggestPriceCny: (r.suggest && r.suggest.priceCny) || 0,
          zone: (r.suggest && r.suggest.zone) || '',
          celFeeCny: (r.suggest && r.suggest.celFeeCny) || 0,
          source: (r.result && r.result.ok && ['image', 'text', 'plugin'].indexOf(r.result.matchSource) !== -1) ? r.result.matchSource : 'manual',
        }));
        const res = await axios.post('/api/yandex/price-candidates', { items }, { timeout: 60000 });
        notify.success('候选已保存 ' + (res.data && res.data.inserted != null ? res.data.inserted : items.length) + ' 条：回列表勾选后点「批量应用候选调价」');
        await refreshPriceState(ready.map((r) => r.offerId));
        researchDialog.visible = false;
      } catch (error) {
        notify.error((error.response && error.response.data && error.response.data.error) || error.message || '保存候选失败');
      } finally {
        researchDialog.busy = false;
      }
    };

    const emptyCandidate = (offerId) => ({
      offerId, purchaseCny: 0, supplier: '', sourceUrl1688: '', score: 0,
      weightKg: 0.2, lenCm: 0, widCm: 0, heiCm: 0, pkgQty: 1,
      suggestPriceCny: 0, zone: '', celFeeCny: 0, status: 'pending', source: '', updatedAt: '',
    });

    const openStateDrawer = (row) => {
      const st = priceState[row.offer_id] || {};
      stateDrawer.offerId = row.offer_id;
      stateDrawer.name = row.name || row.title || '';
      stateDrawer.image = rowFirstImage(row);
      stateDrawer.candidate = st.candidate ? Object.assign({}, st.candidate) : emptyCandidate(row.offer_id);
      stateDrawer.records = st.records || [];
      stateDrawer.suggest = null;
      stateDrawer.visible = true;
    };

    const calcDrawerSuggest = async () => {
      const c = stateDrawer.candidate;
      if (!c || !(Number(c.purchaseCny || 0) > 0)) return notify.warning('请先填写采购成本');
      stateDrawer.suggestBusy = true;
      try {
        const res = await axios.post('/api/yandex/price-suggest', {
          items: [{
            offerId: stateDrawer.offerId, purchaseCny: c.purchaseCny, weightKg: c.weightKg,
            lenCm: c.lenCm, widCm: c.widCm, heiCm: c.heiCm, params: pricingParams(),
          }],
        }, { timeout: 30000 });
        const r = res.data && res.data.results && res.data.results[0];
        if (r && r.ok) { stateDrawer.suggest = r; notify.success('建议价已更新'); }
        else notify.warning((r && r.error) || '计算失败：请检查采购价/参数');
      } catch (error) {
        notify.error((error.response && error.response.data && error.response.data.error) || error.message || '计算建议价失败');
      } finally {
        stateDrawer.suggestBusy = false;
      }
    };

    const saveDrawerCandidate = async () => {
      const c = stateDrawer.candidate;
      if (!c || !(Number(c.purchaseCny || 0) > 0)) return notify.warning('请先填写采购成本');
      stateDrawer.saving = true;
      try {
        const s = stateDrawer.suggest;
        const items = [{
          offerId: stateDrawer.offerId, name: stateDrawer.name,
          purchaseCny: Number(c.purchaseCny || 0), supplier: c.supplier || '',
          sourceUrl1688: c.sourceUrl1688 || '', score: Number(c.score || 0),
          weightKg: Number(c.weightKg || 0), lenCm: Number(c.lenCm || 0),
          widCm: Number(c.widCm || 0), heiCm: Number(c.heiCm || 0), pkgQty: Number(c.pkgQty || 1),
          suggestPriceCny: (s && s.priceCny) || Number(c.suggestPriceCny || 0),
          zone: (s && s.zone) || c.zone || '',
          celFeeCny: (s && s.celFeeCny) || Number(c.celFeeCny || 0),
          source: c.source || 'manual',
        }];
        await axios.post('/api/yandex/price-candidates', { items }, { timeout: 30000 });
        notify.success('候选已保存（状态置为待应用）');
        await refreshPriceState([stateDrawer.offerId]);
        const st = priceState[stateDrawer.offerId];
        if (st) { stateDrawer.candidate = st.candidate ? Object.assign({}, st.candidate) : stateDrawer.candidate; stateDrawer.records = st.records || []; }
      } catch (error) {
        notify.error((error.response && error.response.data && error.response.data.error) || error.message || '保存候选失败');
      } finally {
        stateDrawer.saving = false;
      }
    };

    const applyOnePrice = async () => {
      const c = stateDrawer.candidate;
      const target = (stateDrawer.suggest && stateDrawer.suggest.priceCny) || Number(c.suggestPriceCny || 0);
      if (!(Number(c.purchaseCny || 0) > 0) || !(target > 0)) return notify.warning('请先填写采购价并点击「计算建议价」');
      try {
        await confirmBox('将把「' + stateDrawer.name + '」售价写为 CNY ' + target + '（服务端按采购成本/重量/尺寸重算）？', '确认调价');
      } catch (_e) { return; }
      stateDrawer.applying = true;
      try {
        const res = await axios.post('/api/yandex/price-apply', {
          items: [{
            offerId: stateDrawer.offerId, name: stateDrawer.name,
            purchaseCny: c.purchaseCny, weightKg: c.weightKg,
            dims: [Number(c.lenCm || 0), Number(c.widCm || 0), Number(c.heiCm || 0)],
            params: pricingParams(),
          }],
        }, { timeout: 120000 });
        const r = res.data && res.data.results && res.data.results[0];
        if (r && r.ok) notify.success('调价成功：CNY ' + r.newPrice + (r.oldPrice ? '（原 ' + r.oldPrice + '）' : ''));
        else notify.error((r && r.error) || '调价失败');
        await refreshPriceState([stateDrawer.offerId]);
        const st = priceState[stateDrawer.offerId];
        if (st) {
          stateDrawer.records = st.records || [];
          stateDrawer.candidate = st.candidate ? Object.assign({}, st.candidate) : stateDrawer.candidate;
        }
        fetchProducts();
      } catch (error) {
        notify.error((error.response && error.response.data && error.response.data.error) || error.message || '调价失败');
      } finally {
        stateDrawer.applying = false;
      }
    };

    const openApplyBatch = async () => {
      const rows = (selectedRows.value || []).filter((row) => priceState[row.offer_id] && priceState[row.offer_id].candidate);
      if (!rows.length) return notify.warning('所选商品还没有候选：先「批量核价」并保存候选，或通过状态「详情」手工补录');
      applyDialog.rows = rows.map((row) => {
        const c = priceState[row.offer_id].candidate;
        return {
          offerId: row.offer_id, name: row.name || row.title || '',
          image: rowFirstImage(row),
          oldPrice: Number(row.price || 0), oldCurrency: row.currency_code || 'RUB',
          cand: Object.assign({}, c), preview: null, result: null,
        };
      });
      applyDialog.results = [];
      applyDialog.visible = true;
      applyDialog.busy = true;
      try {
        const res = await axios.post('/api/yandex/price-suggest', {
          items: applyDialog.rows.map((r) => ({
            offerId: r.offerId, purchaseCny: r.cand.purchaseCny, weightKg: r.cand.weightKg,
            lenCm: r.cand.lenCm, widCm: r.cand.widCm, heiCm: r.cand.heiCm, params: pricingParams(),
          })),
        }, { timeout: 60000 });
        const results = (res.data && res.data.results) || [];
        for (const r of results) {
          const row = applyDialog.rows.find((x) => String(x.offerId) === String(r.offerId));
          if (row) row.preview = r && r.ok ? r : null;
        }
        const missing = applyDialog.rows.filter((r) => !r.preview);
        if (missing.length) notify.warning(missing.length + ' 项预览失败（多为采购价/参数问题），将被跳过');
      } catch (error) {
        notify.error((error.response && error.response.data && error.response.data.error) || error.message || '预览计算失败');
      } finally {
        applyDialog.busy = false;
      }
    };

    const confirmApplyBatch = async () => {
      const targets = applyDialog.rows.filter((r) => r.preview);
      if (!targets.length) return notify.warning('没有可执行的调价项（需要成功的建议价预览）');
      applyDialog.busy = true;
      applyDialog.results = [];
      try {
        const res = await axios.post('/api/yandex/price-apply', {
          items: targets.map((r) => ({
            offerId: r.offerId, name: r.name,
            purchaseCny: r.cand.purchaseCny, weightKg: r.cand.weightKg,
            dims: [Number(r.cand.lenCm || 0), Number(r.cand.widCm || 0), Number(r.cand.heiCm || 0)],
            params: pricingParams(),
          })),
        }, { timeout: 600000 });
        const results = (res.data && res.data.results) || [];
        applyDialog.results = results;
        for (const r of results) {
          const row = applyDialog.rows.find((x) => String(x.offerId) === String(r.offerId));
          if (row) row.result = r;
        }
        const okN = results.filter((r) => r.ok).length;
        if (okN === results.length) notify.success('批量调价完成：' + okN + '/' + results.length + ' 已写回 Yandex（平台处理中）');
        else notify.warning('批量调价：成功 ' + okN + '/' + results.length + '，失败项见列表');
        await refreshPriceState(applyDialog.rows.map((r) => r.offerId));
        fetchProducts();
      } catch (error) {
        notify.error((error.response && error.response.data && error.response.data.error) || error.message || '批量调价失败');
      } finally {
        applyDialog.busy = false;
      }
    };

    // ===== Yandex 卡片质量：评分列展示 + AI 优化（试点，预览→确认→提交）=====
    const qgradeInfo = (row) => {
      const score = Number(row?.qscore);
      if (!Number.isFinite(score)) return { color: '#94a3b8', text: '-' };
      const color = score >= 80 ? '#16a34a' : score >= 60 ? '#f59e0b' : '#dc2626';
      return { color, text: String(score) };
    };
    const qualityTagType = (grade) => (grade === 'high' ? 'success' : grade === 'medium' ? 'warning' : 'danger');

    const aiDialog = Vue.reactive({ visible: false, busy: false, rows: [], applying: false });
    const aiChecked = Vue.reactive({}); // offerId -> bool

    // 熊猫式：把类目与现有属性一并带上，让 AI 只补空缺（标题/描述/属性）
    const attrMapFromRow = (row) => {
      const map = {};
      if (Array.isArray(row.attributes)) {
        for (const a of row.attributes) {
          if (a && a.name) map[a.name] = String(a.value ?? '');
        }
      }
      return map;
    };
    const buildAiItems = (rows) => rows.map((row) => ({
      offerId: row.offer_id || row.offerId || '',
      name: row.name || row.title || '',
      description: row.description || (row.raw && row.raw.offer && row.raw.offer.description) || '',
      category_id: row.category_id || '',
      category_name: row.category_name || '',
      attributes: attrMapFromRow(row),
      issues: Array.isArray(row.qissues) ? row.qissues : [],
    })).filter((it) => it.offerId);

    const openAiOptimize = async (sourceRows) => {
      const rows = (sourceRows && sourceRows.length ? sourceRows : selectedRows.value).slice(0, 10);
      if (!rows.length) return notify.warning('请先勾选要优化的商品（单次最多 10 个）');
      aiDialog.rows = rows.map((row) => ({
        offerId: row.offer_id || row.offerId || '',
        name: row.name || '',
        status: 'queued', message: '', suggested: null, changes: [], error: '',
      }));
      aiDialog.busy = true;
      aiDialog.visible = true;
      for (const key of Object.keys(aiChecked)) delete aiChecked[key];
      try {
        const res = await axios.post('/api/yandex/ai-optimize-preview', { items: buildAiItems(rows) }, { timeout: 300000 });
        const results = (res.data && res.data.rows) || [];
        for (const rr of results) {
          const target = aiDialog.rows.find((r) => r.offerId === rr.offerId);
          if (!target) continue;
          if (rr.ok) {
            target.status = 'ok';
            target.suggested = rr.suggested;
            target.changes = rr.changes || [];
            target.attributes = rr.attributes || [];
            target.originName = rr.origin && rr.origin.name;
            aiChecked[rr.offerId] = true;
          } else {
            target.status = 'error';
            target.error = rr.error || '生成失败';
          }
        }
        const failed = results.filter((r) => !r.ok);
        if (failed.length) notify.warning(failed.length + ' 个商品生成失败（含未配置 AI 模型的情况）');
      } catch (error) {
        notify.error((error.response && error.response.data && error.response.data.error) || error.message || 'AI 优化失败');
      } finally {
        aiDialog.busy = false;
      }
    };

    const applyAiOptimize = async () => {
      const okItems = aiDialog.rows.filter((r) => r.status === 'ok' && aiChecked[r.offerId] && r.suggested);
      if (!okItems.length) return notify.warning('没有勾选可提交的优化项');
      aiDialog.applying = true;
      try {
        const res = await axios.post('/api/yandex/ai-optimize-apply', {
          items: okItems.map((r) => ({
            offerId: r.offerId,
            name: r.suggested.name,
            description: r.suggested.description,
            attributes: (r.attributes || []).filter((a) => a && a.name && String(a.value).trim()),
          })),
        }, { timeout: 300000 });
        const results = (res.data && res.data.results) || [];
        const okN = results.filter((x) => x.ok).length;
        if (okN === results.length) notify.success('AI 优化已提交 Yandex：' + okN + '/' + results.length);
        else notify.warning('AI 优化提交：成功 ' + okN + '/' + results.length + '，失败项见下方提示');
        for (const rr of results) {
          const target = aiDialog.rows.find((r) => r.offerId === rr.offerId);
          if (target) target.message = rr.ok ? '✓ 已提交 Yandex，等待平台审核' : ('✗ ' + (rr.error || '失败'));
        }
        fetchProducts();
      } catch (error) {
        notify.error((error.response && error.response.data && error.response.data.error) || error.message || '提交失败');
      } finally {
        aiDialog.applying = false;
      }
    };

    const onShopChanged = () => {
      pagination.currentPage = 1;
      hasFetched.value = false;
      fetchProducts();
    };

    Vue.onMounted(async () => {
      fetchProducts();
      window.addEventListener('shop-changed', onShopChanged);
      // 若上次有未完成/刚完成的后台核价任务，进入页面自动弹进度（避免误以为要重新发起）
      const recent = await checkRecentBulkJob();
      if (recent && ['queued', 'running', 'done'].includes(recent.status)) {
        if (recent.status === 'done' && recent.processed === recent.total) {
          // 已完成：不自动弹窗打扰，仅留按钮可查；这里静默
        } else {
          await resumeBulkPricing(recent);
          notify.info('检测到未完成的后台核价任务，已为你打开进度。');
        }
      }
    });
    Vue.onBeforeUnmount(() => window.removeEventListener('shop-changed', onShopChanged));

    return {
      products, loading, pulling, pullSeconds, saveLoading, hasFetched, activeTab, search, qualityFilter, qualityOptions, pagination, apiReady, statusTabItems,
      context, drawer, statusText, statusTagType, moneyText, fetchProducts, pullProducts, selectStatusTab, resetFilters,
      profitDialog, fixedCostCny, currentPriceCny, currentProfitPreview, suggestedPriceDisplay, strikePriceDisplay,
      currentCrossBorder, suggestedCrossBorder,
      openEdit, saveProduct, openProfitDialog, applySuggestedPrice, applyCandidateFields, candRowStyle,
      hoverImg, onImgEnter, onImgMove, onImgLeave,
      selectedRows, priceState, researchDialog, researchTableRef, stateDrawer, applyDialog,
      handleSelectionChange, changeVisibility, visBusy, openResearchBatch, openResearchRow, openStateDrawer,
      bulkPricingDialog, reasonText, startBulkPricing, openBulkPricingCurrentTab, resumeBulkPricing, checkRecentBulkJob, stopBulkPoll, collectFilteredOfferIds,
      preciseDialog, preciseRows, preciseBands, preciseReasonText, preciseReasonTag, openPreciseCurrentTab, stopPreciseJob, stopPrecisePoll,
      retryFailedResearch, saveCandidates, calcRowSuggest, stopPluginJob, ozonReverse,
      reverseDialog, reverseOneRow, openReversePricing, reverseAllRows, applyReverseToYandex,
      calcDrawerSuggest, saveDrawerCandidate, applyOnePrice, openApplyBatch, confirmApplyBatch,
      qgradeInfo, qualityTagType, aiDialog, aiChecked, openAiOptimize, applyAiOptimize,
      drawer, saveLoading, editDrawerMode, aiFillProduct, setAttrValue, attrTemplateOf, drawerMissingAttrs,
      aiFilter, aiOptions, aiStats, aiRecordsDialog, openAiRecords,
      priceFilter, priceOptions, displayProducts, isPromoRow,
      diagnosticFilter, diagnosticOptions, diagnosticTagType, diagnosticText, diagnosticTips, stockSummaryText,
    };
  },
  template: `
    <div>
      <div class="erp-toolbar">
        <div>
          <h1 class="erp-workbench-title">Yandex 商品</h1>
          <div class="erp-muted">
            {{ context?.store_name || 'Yandex Market' }}
            <span v-if="context?.campaign_id"> · campaign {{ context.campaign_id }}</span>
            <span v-if="context?.business_id"> · business {{ context.business_id }}</span>
          </div>
        </div>
        <el-button size="large" @click="fetchProducts">
          <el-icon><RefreshRight /></el-icon><span>刷新</span>
        </el-button>
        <el-button size="large" type="primary" plain :loading="pulling" @click="pullProducts">
          <el-icon><Download /></el-icon><span>{{ pulling ? '正在拉取商品... ' + pullSeconds + 's' : '拉取店铺商品' }}</span>
        </el-button>
      </div>

      <el-alert v-if="pulling" type="info" :closable="false" show-icon style="margin-bottom:14px"
        title="正在从 Yandex 后台拉取店铺全部商品（含归档）"
        :description="'后台全量拉取中，已等待 ' + pullSeconds + ' 秒。期间页面继续显示上次已拉取的商品，完成后自动刷新。'" />

      <el-alert
        v-if="!apiReady"
        type="warning"
        :closable="false"
        show-icon
        style="margin-bottom:14px"
        title="Yandex 商品 API 尚未接入"
        description="当前页面已完成菜单、路由和字段布局；API 凭据会放在服务端配置里，避免泄露到浏览器端。" />

      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px">
        <button
          v-for="tab in statusTabItems"
          :key="tab.value"
          type="button"
          @click="selectStatusTab(tab.value)"
          :style="{
            height:'38px', padding:'0 14px', borderRadius:'8px', border: activeTab === tab.value ? '1px solid #111827' : '1px solid #dfe7f1',
            background: activeTab === tab.value ? '#111827' : '#fff', color: activeTab === tab.value ? '#fff' : '#334155',
            fontWeight:800, cursor:'pointer'
          }">
          {{ tab.label }} <span style="opacity:.75">({{ tab.count }})</span>
        </button>
      </div>

      <div class="erp-filter-row">
        <el-input v-model="search" size="large" clearable placeholder="搜索商品 / 货号 / SKU" style="width:360px" @keyup.enter="fetchProducts" />
        <el-select v-model="qualityFilter" size="large" style="width:160px" @change="() => { pagination.currentPage = 1; fetchProducts(); }">
          <el-option v-for="opt in qualityOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
        <el-select v-model="diagnosticFilter" size="large" style="width:160px" @change="() => { pagination.currentPage = 1; fetchProducts(); }">
          <el-option v-for="opt in diagnosticOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
        <el-select v-model="aiFilter" size="large" style="width:150px" @change="() => { pagination.currentPage = 1; fetchProducts(); }">
          <el-option v-for="opt in aiOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
        <el-select v-model="priceFilter" size="large" style="width:210px" @change="() => { pagination.currentPage = 1; fetchProducts(); }">
          <el-option v-for="opt in priceOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
        <el-button size="large" type="primary" @click="fetchProducts">查询</el-button>
        <el-button size="large" @click="resetFilters">重置</el-button>
      </div>

      <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px; flex-wrap:wrap">
        <el-button type="primary" @click="openReversePricing">Ozon 反推定价</el-button>
        <el-button type="primary" plain @click="openResearchBatch">批量核价（1688 找货）</el-button>
        <el-button type="primary" plain :loading="bulkPricingDialog.busy" @click="openBulkPricingCurrentTab">后台全店核价（AlphaShop）</el-button>
        <el-button type="danger" plain :loading="preciseDialog.busy" @click="openPreciseCurrentTab">插件精核价（1688 官方真实价）</el-button>
        <el-button type="warning" plain @click="openApplyBatch">批量应用候选调价</el-button>
        <el-button type="success" plain :disabled="!selectedRows.length || visBusy" @click="changeVisibility('list')">上架</el-button>
        <el-button type="danger" plain :disabled="!selectedRows.length || visBusy" @click="changeVisibility('unlist')">下架</el-button>
        <el-button type="danger" plain @click="openAiOptimize(selectedRows)">AI 优化（预览确认）</el-button>
        <span style="font-size:13px; color:#94a3b8">已选 {{ selectedRows.length }} 项 · 调价按候选的采购成本/重量/尺寸以 CNY 写回 Yandex</span>
      </div>

      <el-table
        :data="displayProducts"
        @selection-change="handleSelectionChange"
        v-loading="loading"
        element-loading-text="正在读取 Yandex 商品..."
        border
        size="large"
        :empty-text="hasFetched ? '暂无 Yandex 商品数据。' : '正在读取商品...'"
        style="border-radius:8px; overflow:hidden">
        <el-table-column type="selection" width="48" />
        <el-table-column label="商品" min-width="360" fixed="left">
          <template #default="{ row }">
            <div style="display:flex; gap:12px; align-items:center; min-width:0">
              <el-image :src="row.image || row.primary_image" lazy style="width:58px; height:58px; border-radius:8px; background:#f1f5f9; flex-shrink:0; cursor:zoom-in" fit="cover" preview-teleported
                        @mouseenter="onImgEnter($event, row)" @mousemove="onImgMove" @mouseleave="onImgLeave">
                <template #error><div style="height:58px; display:flex; align-items:center; justify-content:center; color:#94a3b8; font-size:12px">无图</div></template>
              </el-image>
              <div style="min-width:0">
                <div class="text-ellipsis" style="font-weight:900; color:#0f172a">{{ row.name || row.title || '(无标题)' }}</div>
                <div class="text-ellipsis" style="font-size:12px; color:#94a3b8; margin-top:5px">货号 {{ row.offer_id || '-' }} · SKU {{ row.sku || '-' }}</div>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="130">
          <template #default="{ row }">
            <el-tooltip :content="row.status_name || row.card_status || row.campaign_status || ''" placement="top">
              <el-tag :type="statusTagType(row.status)">{{ statusText(row.status) }}</el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="卡片质量" width="130">
          <template #default="{ row }">
            <el-tooltip v-if="Array.isArray(row.qissues) && row.qissues.length" :content="row.qissues.join('；')" placement="top">
              <el-tag :type="qualityTagType(row.qgrade)" effect="light" style="cursor:help">
                {{ qgradeInfo(row).text }} · {{ row.qgrade === 'high' ? '优' : row.qgrade === 'medium' ? '中' : '低' }}
              </el-tag>
            </el-tooltip>
            <el-tag v-else :type="qualityTagType(row.qgrade)" effect="light">{{ qgradeInfo(row).text }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="AI 优化" width="130" align="center">
          <template #default="{ row }">
            <template v-if="aiStats[row.offer_id] && aiStats[row.offer_id].count > 0">
              <el-tooltip :content="'最近优化：' + String(aiStats[row.offer_id].lastAt || '').slice(0, 16)" placement="top">
                <el-button link type="success" @click="openAiRecords(row)">
                  <el-tag size="small" type="success" effect="light" style="cursor:pointer">{{ aiStats[row.offer_id].count }} 次</el-tag>
                </el-button>
              </el-tooltip>
              <div style="font-size:11px; color:#94a3b8">点击查看记录</div>
            </template>
            <span v-else style="color:#cbd5e1; font-size:12px">—</span>
          </template>
        </el-table-column>
        <el-table-column label="售价 / 划线价" width="180" align="right">
          <template #default="{ row }">
            <template v-if="isPromoRow(row)">
              <div>
                <span style="color:#dc2626; font-weight:900">{{ moneyText(row.price, row.currency_code || 'RUB') }}</span>
                <span style="color:#94a3b8; text-decoration:line-through; margin-left:6px; font-size:12px">{{ moneyText(row.old_price, row.currency_code || 'RUB') }}</span>
              </div>
              <div style="font-size:11px; color:#e11d48; margin-top:2px">促销中（划线价 ≠ 售价）</div>
            </template>
            <span v-else>{{ moneyText(row.price, row.currency_code || 'RUB') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="库存" prop="stock" width="100" align="right" />
        <el-table-column label="发货/类目诊断" min-width="210">
          <template #default="{ row }">
            <el-tooltip :content="diagnosticTips(row)" placement="top" :disabled="!diagnosticTips(row)">
              <div style="display:flex; flex-direction:column; gap:5px; min-width:0">
                <el-tag :type="diagnosticTagType(row)" effect="light" style="width:max-content; max-width:180px">
                  {{ diagnosticText(row) }}
                </el-tag>
                <div v-if="row.yandex_diagnostic && row.yandex_diagnostic.market_category" class="text-ellipsis" style="font-size:12px; color:#64748b; max-width:190px">
                  {{ row.yandex_diagnostic.market_category }}
                </div>
              </div>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="库存发货点" min-width="150">
          <template #default="{ row }">
            <el-tooltip :content="(row.yandex_stock_summary?.warehouses || []).map(w => (w.warehouse_name || w.warehouse_id) + ' FIT ' + w.fit + ' / 可售 ' + w.available).join('；')" placement="top" :disabled="!(row.yandex_stock_summary?.warehouses || []).length">
              <span style="font-size:12px; color:#475569; font-weight:700">{{ stockSummaryText(row) }}</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="品牌" prop="brand" width="140" show-overflow-tooltip />
        <el-table-column label="类目" min-width="190" show-overflow-tooltip>
          <template #default="{ row }">{{ row.category_name || row.category || '-' }}</template>
        </el-table-column>
        <el-table-column label="核价 / 调价" min-width="250">
          <template #default="{ row }">
            <div v-if="priceState[row.offer_id]" style="display:flex; flex-direction:column; gap:4px; min-width:0">
              <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap">
                <el-tag v-if="priceState[row.offer_id].records[0] && priceState[row.offer_id].records[0].status === 'failed'" type="danger" size="small">上次失败</el-tag>
                <el-tag v-else-if="!priceState[row.offer_id].candidate" type="info" size="small">未核价</el-tag>
                <el-tag v-else-if="priceState[row.offer_id].candidate.status === 'pending'" type="warning" size="small">候选待应用</el-tag>
                <el-tag v-else type="success" size="small">已调价</el-tag>
                <el-link type="primary" :underline="false" @click="openStateDrawer(row)">详情</el-link>
              </div>
              <template v-if="priceState[row.offer_id].candidate">
                <div style="font-size:12px; color:#475569">
                  采购 ¥{{ Number(priceState[row.offer_id].candidate.purchaseCny || 0).toFixed(2) }}
                  <template v-if="Number(priceState[row.offer_id].candidate.suggestPriceCny || 0) > 0">
                    → 建议 ¥{{ Number(priceState[row.offer_id].candidate.suggestPriceCny || 0).toFixed(0) }}
                  </template>
                  <span v-if="priceState[row.offer_id].candidate.zone" style="color:#94a3b8"> · {{ priceState[row.offer_id].candidate.zone }}</span>
                </div>
              </template>
              <div v-if="priceState[row.offer_id].records[0] && priceState[row.offer_id].records[0].status === 'failed' && priceState[row.offer_id].records[0].error"
                   class="text-ellipsis" style="font-size:12px; color:#dc2626; max-width:230px"
                   :title="priceState[row.offer_id].records[0].error">{{ priceState[row.offer_id].records[0].error }}</div>
            </div>
            <el-button v-else link type="primary" @click="openStateDrawer(row)">核价 / 调价</el-button>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="180">
          <template #default="{ row }">{{ (row.updated_at || row.updatedAt || '').replace('T',' ').slice(0,19) || '-' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="190" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="primary" @click="openResearchRow(row)">核价</el-button>
            <el-button link type="danger" @click="openAiOptimize([row])">AI 优化</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div style="display:flex; justify-content:flex-end; margin-top:14px">
        <el-pagination
          v-model:current-page="pagination.currentPage"
          v-model:page-size="pagination.pageSize"
          :total="pagination.total"
          :page-sizes="[20, 50, 100]"
          layout="total, sizes, prev, pager, next"
          @size-change="fetchProducts"
          @current-change="fetchProducts" />
      </div>

      <el-drawer v-model="drawer.visible" size="620px" title="编辑 Yandex 商品" destroy-on-close>
        <el-alert
          v-if="drawer.form.diagnostic && drawer.form.diagnostic.severity !== 'ok'"
          :type="drawer.form.diagnostic.severity === 'danger' ? 'error' : 'warning'"
          :closable="false"
          show-icon
          style="margin-bottom:14px"
          :title="(drawer.form.diagnostic.issues || []).join('；') || '商品需要检查'"
          :description="diagnosticTips({ yandex_diagnostic: drawer.form.diagnostic })" />
        <el-alert
          v-if="drawer.form.stockSummary && drawer.form.stockSummary.warehouses && drawer.form.stockSummary.warehouses.length"
          type="success"
          :closable="false"
          show-icon
          style="margin-bottom:14px"
          :title="'库存已写入：' + stockSummaryText({ yandex_stock_summary: drawer.form.stockSummary })"
          :description="drawer.form.stockSummary.warehouses.map(w => (w.warehouse_name || w.warehouse_id) + ' · campaign ' + (w.campaign_id || '-') + ' · FIT ' + w.fit + ' / 可售 ' + w.available).join('；')" />
        <el-form label-width="110px" label-position="left">
          <el-form-item label="货号">
            <el-input v-model="drawer.form.offer_id" disabled />
          </el-form-item>
          <el-form-item label="标题">
            <el-input v-model="drawer.form.name" maxlength="300" show-word-limit />
          </el-form-item>
          <el-form-item label="品牌">
            <el-input v-model="drawer.form.brand" placeholder="vendor" />
          </el-form-item>
          <el-form-item label="类目 ID">
            <el-input v-model="drawer.form.category_id" placeholder="marketCategoryId" />
          </el-form-item>
          <el-form-item label="当前类目">
            <el-input v-model="drawer.form.category_name" disabled />
          </el-form-item>
          <el-form-item label="售价">
            <div style="display:flex; gap:8px; width:100%">
              <el-input-number v-model="drawer.form.price" :min="0" :precision="2" :step="1" style="width:180px" />
              <el-select v-model="drawer.form.currency_code" style="width:120px">
                <el-option label="CNY" value="CNY" />
                <el-option label="RUB" value="RUB" />
              </el-select>
              <el-button type="primary" plain @click="openProfitDialog">利润计算</el-button>
            </div>
          </el-form-item>
          <el-form-item label="图片">
            <el-input v-model="drawer.form.imagesText" type="textarea" :rows="6" placeholder="每行一个图片 URL，第一张为主图" />
          </el-form-item>
          <el-form-item label="描述">
            <el-input v-model="drawer.form.description" type="textarea" :rows="8" />
          </el-form-item>
        </el-form>

        <!-- AI 智能填充：只补空缺，熊猫式 -->
        <div style="display:flex; align-items:center; gap:10px; margin: 4px 0 14px 0; flex-wrap:wrap">
          <el-button type="warning" plain :loading="drawer.aiFillBusy" @click="aiFillProduct">
            <el-icon><MagicStick /></el-icon>&nbsp;AI 智能填充（补标题/描述/空属性）
          </el-button>
          <span style="font-size:12px; color:#94a3b8">
            缺 {{ drawerMissingAttrs.length }} 项必填/推荐属性{{ drawerMissingAttrs.length ? '：' + drawerMissingAttrs.slice(0,5).map(t => t.name).join('、') + (drawerMissingAttrs.length > 5 ? ' 等' : '') : '' }}
          </span>
        </div>

        <!-- 类目属性区 -->
        <div v-if="drawer.attrTemplate && drawer.attrTemplate.length" style="margin-bottom:14px; border:1px solid #e2e8f0; border-radius:8px; overflow:hidden">
          <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:#f8fafc; font-weight:700; color:#334155; font-size:14px">
            <span>类目属性（{{ drawer.form.category_name || ('类目 ' + drawer.form.category_id) }}）</span>
            <span style="font-size:12px; color:#94a3b8">AI 填充后请核对；保存仅提交改动项</span>
          </div>
          <div style="padding:6px 14px; max-height:340px; overflow:auto">
            <div v-for="t in drawerMissingAttrs" :key="t.name"
              style="display:flex; gap:8px; align-items:center; padding:7px 0; border-bottom:1px dashed #eef2f7">
              <el-tag size="small" :type="t.required ? 'danger' : 'warning'" style="flex-shrink:0">{{ t.required ? '必填' : '推荐' }}</el-tag>
              <div style="flex:1; min-width:0">
                <div class="text-ellipsis" style="font-size:13px; color:#334155" :title="t.name_zh ? t.name : '俄文原名（暂无中文对照，可反馈添加）：' + t.name">
                  {{ t.name_zh || t.name }}<span v-if="t.name_zh" style="color:#94a3b8; font-size:12px">（{{ t.name }}）</span><span v-if="t.unit" style="color:#94a3b8"> ({{ t.unit }})</span>
                </div>
              </div>
              <el-select v-if="t.type === 'ENUM' && t.options && t.options.length" v-model="drawer.form.attributes[t.name]" filterable size="small" style="width:220px"
                placeholder="选择或输入" allow-create default-first-option @change="setAttrValue(t.name, $event)">
                <el-option v-for="opt in t.options" :key="opt" :label="opt" :value="opt" />
              </el-select>
              <el-input v-else size="small" v-model="drawer.form.attributes[t.name]" style="width:220px"
                :placeholder="t.type === 'NUMERIC' && t.unit ? '填数值(' + t.unit + ')' : '填值'" @change="setAttrValue(t.name, $event)" />
            </div>
            <div v-if="!drawerMissingAttrs.length" style="padding:8px 0; font-size:13px; color:#16a34a">✓ 必填与推荐属性已齐全</div>
            <el-collapse style="margin-top:6px">
              <el-collapse-item :title="'已填属性 ' + Object.keys(drawer.form.attributes).filter(n => String(drawer.form.attributes[n] || '').trim()).length + ' 项（查看/修改，改动会随保存提交）'">
                <div v-for="t in drawer.attrTemplate.filter((x) => String(drawer.form.attributes[x.name] || '').trim())" :key="t.name"
                  style="display:flex; gap:8px; align-items:center; padding:5px 0">
                  <div style="flex:1; min-width:0; font-size:13px; color:#475569">
                    {{ t.name_zh || t.name }}<span v-if="t.name_zh" style="color:#94a3b8; font-size:11px">（{{ t.name }}）</span>
                    <span style="color:#16a34a"> = {{ drawer.form.attributes[t.name] }}</span>
                  </div>
                  <el-select v-if="t.type === 'ENUM' && t.values && t.values.length" v-model="drawer.form.attributes[t.name]" filterable size="small" style="width:200px" allow-create default-first-option @change="setAttrValue(t.name, $event)">
                    <el-option v-for="opt in t.values" :key="opt.value" :label="opt.value" :value="opt.value" />
                  </el-select>
                  <el-input v-else size="small" v-model="drawer.form.attributes[t.name]" style="width:200px" @change="setAttrValue(t.name, $event)" />
                </div>
              </el-collapse-item>
            </el-collapse>
          </div>
        </div>

        <el-alert type="info" :closable="false" show-icon title="Yandex 更新不是即时生效，提交后平台可能需要几分钟处理。" />
        <template #footer>
          <el-button @click="drawer.visible=false">取消</el-button>
          <el-button type="success" :loading="saveLoading" @click="saveProduct">保存并更新到 Yandex</el-button>
        </template>
      </el-drawer>

      <el-dialog v-model="profitDialog.visible" title="利润核算" width="980px" append-to-body destroy-on-close>
        <div style="display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:18px; margin-bottom:18px">
          <div style="border:1px solid #e5edf6; border-radius:8px; padding:14px">
            <div style="font-weight:900; color:#475569; margin-bottom:10px">当前售价</div>
            <div style="font-size:28px; font-weight:900; color:#0f172a">{{ moneyText(drawer.form.price, drawer.form.currency_code) }}</div>
            <div style="font-size:13px; color:#94a3b8; margin-top:6px">折合 CNY {{ currentPriceCny.toFixed(2) }}</div>
          </div>
          <div style="border:1px solid #e5edf6; border-radius:8px; padding:14px">
            <div style="font-weight:900; color:#475569; margin-bottom:10px">建议售价</div>
            <div style="font-size:28px; font-weight:900; color:#2563eb">{{ drawer.form.currency_code }} {{ suggestedPriceDisplay.toFixed(2) }}</div>
            <div style="font-size:13px; color:#94a3b8; margin-top:6px">目标毛利 {{ profitDialog.cost.targetMarginPct }}%</div>
          </div>
          <div style="border:1px solid #e5edf6; border-radius:8px; padding:14px">
            <div style="font-weight:900; color:#475569; margin-bottom:10px">当前利润</div>
            <div :style="{fontSize:'28px', fontWeight:900, color: currentProfitPreview.profit >= 0 ? '#16a34a' : '#dc2626'}">¥{{ currentProfitPreview.profit.toFixed(2) }}</div>
            <div style="font-size:13px; color:#94a3b8; margin-top:6px">毛利率 {{ currentProfitPreview.margin.toFixed(1) }}%</div>
          </div>
        </div>

        <el-divider content-position="left">成本设置</el-divider>
        <div style="display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:14px">
          <el-form-item label="采购成本(¥)" label-position="top">
            <el-input-number v-model="profitDialog.cost.purchaseCny" :min="0" :precision="2" :step="1" style="width:100%" />
          </el-form-item>
          <el-form-item label="国内运费(¥)" label-position="top">
            <el-input-number v-model="profitDialog.cost.domesticShippingCny" :min="0" :precision="2" :step="1" style="width:100%" />
          </el-form-item>
          <el-form-item label="代贴单费(¥)" label-position="top">
            <el-input-number v-model="profitDialog.cost.serviceFeeCny" :min="0" :precision="2" :step="1" style="width:100%" />
          </el-form-item>
          <el-form-item label="重量(kg)" label-position="top">
            <el-input-number v-model="profitDialog.cost.weightKg" :min="0" :precision="3" :step="0.01" style="width:100%" />
          </el-form-item>
          <el-form-item label="尾程费(¥)" label-position="top">
            <el-input-number v-model="profitDialog.cost.lastMileCny" :min="0" :precision="2" :step="1" style="width:100%" />
          </el-form-item>
          <el-form-item label="长(cm)" label-position="top">
            <el-input-number v-model="profitDialog.cost.lengthCm" :min="0" :precision="1" :step="1" style="width:100%" />
          </el-form-item>
          <el-form-item label="宽(cm)" label-position="top">
            <el-input-number v-model="profitDialog.cost.widthCm" :min="0" :precision="1" :step="1" style="width:100%" />
          </el-form-item>
          <el-form-item label="高(cm)" label-position="top">
            <el-input-number v-model="profitDialog.cost.heightCm" :min="0" :precision="1" :step="1" style="width:100%" />
          </el-form-item>
          <el-form-item label="平台佣金(%)" label-position="top">
            <el-input-number v-model="profitDialog.cost.commissionPct" :min="0" :max="80" :precision="1" :step="0.5" style="width:100%" />
          </el-form-item>
          <el-form-item label="银行收单费(%)" label-position="top">
            <el-input-number v-model="profitDialog.cost.acquiringPct" :min="0" :max="30" :precision="1" :step="0.2" style="width:100%" />
          </el-form-item>
          <el-form-item label="提现费率(%)" label-position="top">
            <el-input-number v-model="profitDialog.cost.withdrawalPct" :min="0" :max="30" :precision="1" :step="0.2" style="width:100%" />
          </el-form-item>
          <el-form-item label="退货亏损(%)" label-position="top">
            <el-input-number v-model="profitDialog.cost.returnLossPct" :min="0" :max="80" :precision="1" :step="0.5" style="width:100%" />
          </el-form-item>
          <el-form-item label="广告费用(%)" label-position="top">
            <el-input-number v-model="profitDialog.cost.adPct" :min="0" :max="80" :precision="1" :step="0.5" style="width:100%" />
          </el-form-item>
          <el-form-item label="目标毛利(%)" label-position="top">
            <el-input-number v-model="profitDialog.cost.targetMarginPct" :min="1" :max="80" :precision="1" :step="1" style="width:100%" />
          </el-form-item>
          <el-form-item label="汇率(CNY/RUB)" label-position="top">
            <el-input-number v-model="profitDialog.cost.exchangeRate" :min="1" :precision="4" :step="0.1" style="width:100%" />
          </el-form-item>
        </div>
        <el-alert
          type="info"
          :closable="false"
          show-icon
          style="margin:4px 0 16px"
          :title="'CEL Economy 当前头程：' + currentCrossBorder.zone + ' / 计费重 ' + currentCrossBorder.chargeWeightKg.toFixed(3) + 'kg / ¥' + currentCrossBorder.feeCny.toFixed(2)"
          :description="'建议售价按迭代分区计算：' + suggestedCrossBorder.zone + ' / 计费重 ' + suggestedCrossBorder.chargeWeightKg.toFixed(3) + 'kg / ¥' + suggestedCrossBorder.feeCny.toFixed(2)" />

        <el-divider content-position="left">费用明细</el-divider>
        <el-table :data="[profitDialog.cost]" border>
          <el-table-column label="采购成本" width="110">
            <template #default>¥{{ Number(profitDialog.cost.purchaseCny || 0).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="国内运费" width="110">
            <template #default>¥{{ Number(profitDialog.cost.domesticShippingCny || 0).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="代贴单费" width="110">
            <template #default>¥{{ Number(profitDialog.cost.serviceFeeCny || 0).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="头程分区" width="140">
            <template #default>{{ currentCrossBorder.zone }}</template>
          </el-table-column>
          <el-table-column label="计费重" width="100">
            <template #default>{{ currentCrossBorder.chargeWeightKg.toFixed(3) }}kg</template>
          </el-table-column>
          <el-table-column label="跨境头程" width="110">
            <template #default>¥{{ currentCrossBorder.feeCny.toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="尾程费" width="100">
            <template #default>¥{{ Number(profitDialog.cost.lastMileCny || 0).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="固定成本" width="110">
            <template #default>¥{{ fixedCostCny.toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="平台/支付/广告" min-width="150">
            <template #default>¥{{ currentProfitPreview.fees.toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="划线价" width="130">
            <template #default>{{ drawer.form.currency_code }} {{ strikePriceDisplay.toFixed(2) }}</template>
          </el-table-column>
        </el-table>

        <template #footer>
          <el-button @click="profitDialog.visible=false">关闭</el-button>
          <el-button type="primary" @click="applySuggestedPrice">应用建议售价</el-button>
        </template>
      </el-dialog>

      <!-- 批量应用候选调价：预览 → 确认提交 Yandex -->
      <!-- 后台全店核价进度 -->
      <el-dialog v-model="bulkPricingDialog.visible" title="后台批量核价（AlphaShop 图搜）" width="980px" append-to-body destroy-on-close
        :close-on-click-modal="false" @closed="stopBulkPoll">
        <el-alert type="info" :closable="false" show-icon style="margin-bottom:12px"
          title="服务端逐条以图搜 1688 同款并定价：命中且商品有重量 → 自动写入价格候选（可在列表「批量应用候选调价」提交）；无同款/缺重量 → 标待人工，不会误定价。关掉弹窗任务继续后台跑。" />
        <div style="display:flex; align-items:center; gap:18px; flex-wrap:wrap; margin-bottom:12px">
          <el-tag type="info" size="large">进度 {{ bulkPricingDialog.processed }} / {{ bulkPricingDialog.total }}</el-tag>
          <el-tag v-if="bulkPricingDialog.status==='running'" type="warning" size="large">核价中…</el-tag>
          <el-tag v-else-if="bulkPricingDialog.status==='done'" type="success" size="large">已完成</el-tag>
          <el-tag v-else-if="bulkPricingDialog.status==='error'" type="danger" size="large">失败</el-tag>
          <span style="font-size:13px; color:#334155">{{ bulkPricingDialog.phase }}</span>
        </div>
        <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:12px">
          <div style="border:1px solid #d1fae5; background:#ecfdf5; border-radius:8px; padding:12px; text-align:center">
            <div style="font-size:12px;color:#047857;font-weight:800">已自动定价</div>
            <strong style="font-size:24px;color:#047857">{{ bulkPricingDialog.priced }}</strong>
          </div>
          <div style="border:1px solid #fde68a; background:#fffbeb; border-radius:8px; padding:12px; text-align:center">
            <div style="font-size:12px;color:#92400e;font-weight:800">待补重量（未定价）</div>
            <strong style="font-size:24px;color:#b45309">{{ bulkPricingDialog.needWeight }}</strong>
          </div>
          <div style="border:1px solid #fecaca; background:#fef2f2; border-radius:8px; padding:12px; text-align:center">
            <div style="font-size:12px;color:#991b1b;font-weight:800">无同款（未定价）</div>
            <strong style="font-size:24px;color:#b91c1c">{{ bulkPricingDialog.noMatch }}</strong>
          </div>
        </div>
        <div v-if="bulkPricingDialog.error" style="color:#dc2626; font-size:13px; margin-bottom:10px">{{ bulkPricingDialog.error }}</div>
        <el-table :data="bulkPricingDialog.summaryRows" size="small" border max-height="300" empty-text="暂无结果">
          <el-table-column label="货号" prop="offerId" min-width="150" show-overflow-tooltip />
          <el-table-column label="结果" width="110" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="row.ok ? 'success' : (row.reason==='need_weight'?'warning':(row.reason==='already_applied'?'info':'danger'))">{{ reasonText(row.reason) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="同款图" width="80" align="center">
            <template #default="{ row }">
              <img v-if="row.img" :src="row.img" referrerpolicy="no-referrer" style="width:42px;height:42px;border-radius:4px;object-fit:cover;background:#f1f5f9" @error="$event.target.style.visibility='hidden'" />
              <span v-else>-</span>
            </template>
          </el-table-column>
          <el-table-column label="候选/标题" prop="title" min-width="200" show-overflow-tooltip />
          <el-table-column label="采购 ¥" width="80" align="right">
            <template #default="{ row }">{{ row.purchaseCny || '-' }}</template>
          </el-table-column>
          <el-table-column label="建议价 ¥" width="90" align="right">
            <template #default="{ row }"><b v-if="row.suggestPriceCny" style="color:#2563eb">{{ row.suggestPriceCny }}</b><span v-else>-</span></template>
          </el-table-column>
        </el-table>
        <template #footer>
          <el-button @click="bulkPricingDialog.visible = false; stopBulkPoll()">关闭（后台继续）</el-button>
          <el-button v-if="bulkPricingDialog.status==='running'" :loading="bulkPricingDialog.busy" @click="fetchProducts">刷新商品</el-button>
        </template>
      </el-dialog>

      <!-- 插件精核价（1688 官方真实价）：进度 + 真实成本分布 -->
      <el-dialog v-model="preciseDialog.visible" title="插件精核价（1688 官方真实价）" width="1180px" append-to-body destroy-on-close
        :close-on-click-modal="false" @closed="stopPrecisePoll">
        <el-alert type="warning" :closable="false" show-icon style="margin-bottom:12px"
          title="本机插件用 1688 官方以图找货 + 打开详情页读「真实价格阶梯」，采购价取起批首档单价（小批量真能买到的价）。可直接采用 = 有完整阶梯；待人工核对 = 阶梯缺失或疑似引流档，需要你点开链接确认。需要浏览器插件在线并登录 1688。" />
        <div style="display:flex; align-items:center; gap:16px; flex-wrap:wrap; margin-bottom:12px">
          <el-tag type="info" size="large">进度 {{ preciseDialog.processed }} / {{ preciseDialog.total }}</el-tag>
          <el-tag v-if="['queued','claimed'].includes(preciseDialog.status)" type="warning" size="large">等待本机插件领取…</el-tag>
          <el-tag v-else-if="preciseDialog.status==='running'" type="warning" size="large">核价中…</el-tag>
          <el-tag v-else-if="preciseDialog.status==='done'" type="success" size="large">已完成</el-tag>
          <el-tag v-else-if="preciseDialog.status==='error'" type="danger" size="large">失败</el-tag>
          <span style="font-size:13px; color:#334155">{{ preciseDialog.phase }}</span>
        </div>
        <div v-if="preciseDialog.notice" style="color:#b45309; font-size:13px; margin-bottom:8px">{{ preciseDialog.notice }}</div>
        <div v-if="preciseDialog.error" style="color:#dc2626; font-size:13px; margin-bottom:10px">{{ preciseDialog.error }}</div>
        <template v-if="preciseDialog.report">
          <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:12px">
            <div style="border:1px solid #d1fae5; background:#ecfdf5; border-radius:8px; padding:12px; text-align:center">
              <div style="font-size:12px;color:#047857;font-weight:800">可直接采用（起批首档价）</div>
              <strong style="font-size:24px;color:#047857">{{ preciseDialog.report.ready }}</strong>
            </div>
            <div style="border:1px solid #fde68a; background:#fffbeb; border-radius:8px; padding:12px; text-align:center">
              <div style="font-size:12px;color:#92400e;font-weight:800">待人工核对</div>
              <strong style="font-size:24px;color:#b45309">{{ (preciseDialog.report.needConfirm || 0) + (preciseDialog.report.noPrice || 0) }}</strong>
            </div>
            <div style="border:1px solid #fecaca; background:#fef2f2; border-radius:8px; padding:12px; text-align:center">
              <div style="font-size:12px;color:#991b1b;font-weight:800">无同款</div>
              <strong style="font-size:24px;color:#b91c1c">{{ preciseDialog.report.noMatch }}</strong>
            </div>
            <div style="border:1px solid #bfdbfe; background:#eff6ff; border-radius:8px; padding:12px; text-align:center">
              <div style="font-size:12px;color:#1d4ed8;font-weight:800">已落库候选</div>
              <strong style="font-size:24px;color:#1d4ed8">{{ preciseDialog.report.savedCount }}</strong>
            </div>
          </div>
          <div style="margin-bottom:10px; font-size:13px; color:#334155">
            <b>真实采购成本分布</b>（按已核到价的 {{ preciseDialog.report.ready + preciseDialog.report.needConfirm }} 个商品）：
            <el-tag v-for="b in preciseBands" :key="b.label" size="small" style="margin-left:6px" :type="b.count ? 'primary' : 'info'">
              {{ b.label }}：{{ b.count }}
            </el-tag>
          </div>
          <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px">
            <el-checkbox v-model="preciseDialog.onlyIssues">只看待人工/无同款</el-checkbox>
            <span style="font-size:12px; color:#94a3b8">共 {{ preciseRows.length }} 行</span>
          </div>
          <el-table :data="preciseRows" size="small" border max-height="420" empty-text="暂无结果">
            <el-table-column label="货号" prop="offerId" width="140" show-overflow-tooltip />
            <el-table-column label="状态" width="170" align="center">
              <template #default="{ row }">
                <el-tag size="small" :type="preciseReasonTag(row.reason)">{{ preciseReasonText(row.reason) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="1688 同款图" width="90" align="center">
              <template #default="{ row }">
                <el-image v-if="row.candidateImage" :src="row.candidateImage" referrerpolicy="no-referrer" fit="cover"
                  style="width:46px;height:46px;border-radius:4px;background:#f1f5f9"
                  :preview-src-list="[row.candidateImage]" preview-teleported hide-on-click-modal />
                <span v-else>-</span>
              </template>
            </el-table-column>
            <el-table-column label="1688 同款标题 / 来源店" min-width="240">
              <template #default="{ row }">
                <a v-if="row.detailUrl" :href="row.detailUrl" target="_blank" style="color:#2563eb; text-decoration:none">{{ row.candidateTitle || '打开 1688 链接' }}</a>
                <span v-else>{{ row.candidateTitle || '-' }}</span>
                <div v-if="row.shopName" style="font-size:12px;color:#94a3b8">{{ row.shopName }}</div>
                <div v-if="!row.matched && row.searchError" style="font-size:12px;color:#b91c1c">{{ row.searchError }}</div>
              </template>
            </el-table-column>
            <el-table-column label="起批首档 ¥" width="100" align="right">
              <template #default="{ row }"><b v-if="row.price" :style="{color: row.reason==='ok' ? '#047857' : '#b45309'}">{{ Number(row.price).toFixed(2) }}</b><span v-else>-</span></template>
            </el-table-column>
            <el-table-column label="取价方式" width="160" show-overflow-tooltip>
              <template #default="{ row }">
                <el-tag v-if="row.priceModeLabel" size="small" :type="row.reason==='ok' ? 'success' : 'warning'">{{ row.priceModeLabel }}</el-tag>
                <div v-if="row.matchedSku" style="font-size:12px;color:#047857">采用规格：{{ row.matchedSku.name }} ¥{{ row.matchedSku.price }}</div>
              </template>
            </el-table-column>
            <el-table-column label="1688 价格阶梯 / 各规格价" min-width="240">
              <template #default="{ row }">
                <div v-if="row.priceDetails">{{ row.priceDetails }}</div>
                <div v-if="row.skuOptions && row.skuOptions.length > 1" style="font-size:12px;color:#92400e">
                  该链接各规格：<span v-for="(s, si) in row.skuOptions.slice(0, 8)" :key="si">{{ si ? ' / ' : '' }}{{ s.name }} ¥{{ s.price }}</span>
                </div>
                <span v-if="!row.priceDetails && (!row.skuOptions || row.skuOptions.length <= 1)" style="color:#94a3b8">（未取到阶梯，需人工点开链接确认）</span>
              </template>
            </el-table-column>
            <el-table-column label="起批" width="90" show-overflow-tooltip>
              <template #default="{ row }">{{ row.moq || '-' }}</template>
            </el-table-column>
            <el-table-column label="引流风险" width="80" align="center">
              <template #default="{ row }"><el-tag v-if="row.trafficBaitRisk" size="small" type="danger">可疑</el-tag><span v-else>-</span></template>
            </el-table-column>
          </el-table>
        </template>
        <template #footer>
          <el-button @click="preciseDialog.visible = false; stopPrecisePoll()">关闭（后台继续）</el-button>
          <el-button v-if="['queued','claimed','running'].includes(preciseDialog.status)" @click="stopPreciseJob">停止核价</el-button>
          <el-button type="primary" plain @click="fetchProducts">刷新商品</el-button>
        </template>
      </el-dialog>

      <!-- 核价（1688 同款候选搜索/选择/保存） -->
      <el-dialog v-model="researchDialog.visible" title="1688 核价 → 保存候选" width="1200px" append-to-body destroy-on-close :close-on-click-modal="false">
        <el-alert v-if="researchDialog.jobText" type="info" :closable="false" style="margin-bottom:10px" :title="researchDialog.jobText" />
        <el-alert v-if="researchDialog.error" type="error" :closable="false" style="margin-bottom:10px" :title="researchDialog.error" />
        <el-alert v-if="researchDialog.pluginDisabled" type="warning" :closable="false" style="margin-bottom:10px"
          title="本机核价插件不可用（插件未连接/版本过旧），候选将为空，可手动在下方填写采购成本后保存。" />
        <el-table ref="researchTableRef" :data="researchDialog.rows" v-loading="researchDialog.busy" element-loading-text="正在核价..." border size="large" max-height="520" row-key="offerId">
          <el-table-column type="expand">
            <template #default="{ row }">
              <div v-if="row.result && row.result.ok && row.result.candidates && row.result.candidates.length" style="padding:6px 14px 10px 14px">
                <div style="font-size:12px; color:#64748b; margin:4px 0 8px 0; font-weight:700">1688 同款候选（点选一项回填采购信息）</div>
                <div v-for="(c, i) in row.result.candidates" :key="i" :style="candRowStyle(row, i)" @click="applyCandidateFields(row, i)">
                  <el-image :src="c.img" lazy fit="cover" referrerpolicy="no-referrer" style="width:46px; height:46px; border-radius:6px; background:#f1f5f9; flex-shrink:0" />
                  <div style="flex:1; min-width:0">
                    <div class="text-ellipsis" style="font-size:13px; color:#0f172a; max-width:520px" :title="c.title">{{ c.title }}</div>
                    <div style="font-size:12px; color:#94a3b8">1688 货号 {{ c.offerId1688 || '-' }} · 销量 {{ c.sold || 0 }}</div>
                    <div v-if="c.dimsText || c.weightText" style="font-size:12px; color:#64748b">{{ c.dimsText }} {{ c.weightText }}</div>
                  </div>
                  <div style="flex-shrink:0; text-align:right">
                    <div style="font-size:15px; font-weight:800; color:#dc2626">¥{{ c.price }}</div>
                    <el-tag v-if="row.chosen === i" size="small" type="primary">已选用</el-tag>
                    <el-tag v-else size="small" effect="plain">选用</el-tag>
                  </div>
                </div>
              </div>
              <div v-else style="padding:10px 14px; font-size:13px; color:#94a3b8">暂无 1688 候选，可在下方填写采购成本与尺寸重量后点「计算建议价」，再「保存候选」。</div>
            </template>
          </el-table-column>
          <el-table-column label="商品" min-width="230">
            <template #default="{ row }">
              <div style="display:flex; align-items:center; gap:10px">
                <el-image :src="row.imgUrl" lazy style="width:48px; height:48px; border-radius:6px; background:#f1f5f9; flex-shrink:0" fit="cover" />
                <div>
                  <div class="text-ellipsis" style="font-size:13px; font-weight:600; color:#111827; max-width:300px">{{ row.name }}</div>
                  <div style="font-size:12px; color:#94a3b8">{{ row.offerId }} · {{ row.categoryName || '-' }}</div>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="采购成本 ¥" width="150" align="center">
            <template #default="{ row }">
              <el-input-number v-model="row.cand.purchaseCny" :min="0" :precision="2" :controls="false" size="small" style="width:110px" />
              <div v-if="row.cand.supplier" class="text-ellipsis" style="font-size:11px; color:#64748b; max-width:140px">{{ row.cand.supplier }}</div>
            </template>
          </el-table-column>
          <el-table-column label="单重/数量" width="170" align="center">
            <template #default="{ row }">
              <div style="display:flex; gap:6px; justify-content:center">
                <el-tooltip content="重量 kg" placement="top"><el-input-number v-model="row.cand.weightKg" :min="0" :precision="3" :controls="false" size="small" style="width:86px" /></el-tooltip>
                <el-tooltip content="每包件数" placement="top"><el-input-number v-model="row.cand.pkgQty" :min="1" :controls="false" size="small" style="width:70px" /></el-tooltip>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="尺寸 cm (长×宽×高)" width="240" align="center">
            <template #default="{ row }">
              <div style="display:flex; gap:6px; justify-content:center">
                <el-input-number v-model="row.cand.lenCm" :min="0" :precision="1" :controls="false" size="small" style="width:72px" />
                <el-input-number v-model="row.cand.widCm" :min="0" :precision="1" :controls="false" size="small" style="width:72px" />
                <el-input-number v-model="row.cand.heiCm" :min="0" :precision="1" :controls="false" size="small" style="width:72px" />
              </div>
            </template>
          </el-table-column>
          <el-table-column label="建议售价" width="190" align="center">
            <template #default="{ row }">
              <div v-if="row.suggest" style="font-weight:800; color:#16a34a">¥{{ row.suggest.priceCny }}<span style="font-weight:400;color:#64748b"> ≈₽{{ row.suggest.rubValue }}</span>
                <div style="font-size:12px; font-weight:400; color:#64748b">毛利 {{ row.suggest.marginPct }}%</div>
              </div>
              <div v-else style="color:#94a3b8; font-size:12px">未计算</div>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="130">
            <template #default="{ row }">
              <span v-if="row.status === 'ok'" style="color:#16a34a; font-size:12px">✓ 已核价{{ row.result && row.result.candidates ? '（' + row.result.candidates.length + ' 候选）' : '' }}</span>
              <span v-else-if="row.status === 'empty'" style="color:#f59e0b; font-size:12px">无候选，可手动填成本</span>
              <span v-else-if="row.status === 'fail'" style="color:#dc2626; font-size:12px">{{ row.message || '核价失败' }}</span>
              <span v-else-if="row.status === 'queued'" style="color:#94a3b8; font-size:12px">{{ row.message || '排队中...' }}</span>
              <el-button v-if="row.suggestBusy || row.status === 'queued'" link type="primary" loading>计算</el-button>
              <el-button v-else link type="primary" @click="calcRowSuggest(row)">计算建议价</el-button>
            </template>
          </el-table-column>
          <el-table-column label="候选同款图" width="170" align="center">
            <template #default="{ row }">
              <div v-if="row.status === 'ok' && row.result && row.result.candidates && row.result.candidates.length"
                style="display:flex; gap:6px; align-items:center; justify-content:center; cursor:pointer" title="点行展开看全部候选并选用" @click.stop>
                <el-image v-for="(c, i) in row.result.candidates.slice(0, 3)" :key="i" :src="c.img" lazy fit="cover" referrerpolicy="no-referrer"
                  style="width:46px; height:46px; border-radius:6px; background:#f1f5f9; border:1px solid #e2e8f0"
                  preview-teleported :preview-src-list="(row.result.candidates || []).map(x => x.img).filter(Boolean)"
                  :initial-index="i" hide-on-click-modal />
              </div>
              <span v-else style="color:#cbd5e1; font-size:12px">—</span>
            </template>
          </el-table-column>
        </el-table>
        <template #footer>
          <el-button v-if="researchDialog.jobId && !researchDialog.stopping" :loading="researchDialog.stopping" @click="stopPluginJob">停止核价</el-button>
          <el-button @click="retryFailedResearch">重试失败项</el-button>
          <el-button type="primary" :loading="researchDialog.busy" @click="saveCandidates">保存全部候选</el-button>
          <el-button @click="researchDialog.visible = false">关闭</el-button>
        </template>
      </el-dialog>

      <!-- 核价详情 / 单商品候选维护 -->
      <el-drawer v-model="stateDrawer.visible" size="640px" title="候选详情与调价（Yandex）" destroy-on-close>
        <div style="display:flex; gap:12px; align-items:flex-start; margin-bottom:14px">
          <el-image :src="stateDrawer.image" style="width:64px; height:64px; border-radius:8px; background:#f1f5f9" fit="cover" />
          <div>
            <div style="font-size:14px; font-weight:700; color:#111827">{{ stateDrawer.name }}</div>
            <div style="font-size:12px; color:#94a3b8; margin-top:2px">{{ stateDrawer.offerId }}</div>
          </div>
        </div>
        <el-form :model="stateDrawer.candidate" label-position="top" size="small">
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:0 14px">
            <el-form-item label="采购成本 (CNY)">
              <el-input-number v-model="stateDrawer.candidate.purchaseCny" :min="0" :precision="2" :controls="false" style="width:100%" />
            </el-form-item>
            <el-form-item label="每包件数">
              <el-input-number v-model="stateDrawer.candidate.pkgQty" :min="1" :controls="false" style="width:100%" />
            </el-form-item>
          </div>
          <el-form-item label="供应商">
            <el-input v-model="stateDrawer.candidate.supplier" placeholder="供应商名称" />
          </el-form-item>
          <el-form-item label="1688 链接">
            <el-input v-model="stateDrawer.candidate.sourceUrl1688" placeholder="https://detail.1688.com/..." />
          </el-form-item>
          <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:0 12px">
            <el-form-item label="重量 kg"><el-input-number v-model="stateDrawer.candidate.weightKg" :min="0" :precision="3" :controls="false" style="width:100%" /></el-form-item>
            <el-form-item label="长 cm"><el-input-number v-model="stateDrawer.candidate.lenCm" :min="0" :precision="1" :controls="false" style="width:100%" /></el-form-item>
            <el-form-item label="宽 cm"><el-input-number v-model="stateDrawer.candidate.widCm" :min="0" :precision="1" :controls="false" style="width:100%" /></el-form-item>
            <el-form-item label="高 cm"><el-input-number v-model="stateDrawer.candidate.heiCm" :min="0" :precision="1" :controls="false" style="width:100%" /></el-form-item>
          </div>
        </el-form>
        <div v-if="stateDrawer.suggest" style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; padding:10px 14px; margin-bottom:14px">
          <div style="display:flex; gap:18px; flex-wrap:wrap; align-items:baseline">
            <span style="font-size:20px; font-weight:900; color:#16a34a">建议售价 ¥{{ stateDrawer.suggest.priceCny }}</span>
            <span style="color:#64748b">≈₽{{ stateDrawer.suggest.rubValue }}</span>
            <span style="font-size:12px; color:#64748b">毛利 {{ stateDrawer.suggest.marginPct }}% · 佣金区 {{ stateDrawer.suggest.zone || '-' }}</span>
            <span v-if="stateDrawer.suggest.strikePriceCny" style="font-size:12px; color:#94a3b8">划线 {{ stateDrawer.suggest.strikePriceCny }}</span>
          </div>
        </div>
        <div style="display:flex; gap:10px; margin-bottom:18px; flex-wrap:wrap">
          <el-button type="primary" :loading="stateDrawer.suggestBusy" @click="calcDrawerSuggest">计算建议价</el-button>
          <el-button :loading="stateDrawer.saving" @click="saveDrawerCandidate">保存候选（待应用）</el-button>
          <el-button type="warning" :loading="stateDrawer.applying" @click="applyOnePrice">应用调价到 Yandex</el-button>
        </div>
        <div style="font-size:13px; font-weight:700; color:#334155; margin:6px 0 8px 0">调价历史</div>
        <el-table :data="stateDrawer.records" size="small" border max-height="260" empty-text="暂无调价记录">
          <el-table-column label="时间" width="150">
            <template #default="{ row }">{{ String(row.createdAt || '').slice(0, 16) || '-' }}</template>
          </el-table-column>
          <el-table-column label="原价 ¥" width="90" align="right"><template #default="{ row }">{{ row.oldPriceCny || '-' }}</template></el-table-column>
          <el-table-column label="新价 ¥" width="90" align="right"><template #default="{ row }">{{ row.newPriceCny || '-' }}</template></el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag size="small" :type="row.status === 'applied' ? 'success' : row.status === 'failed' ? 'danger' : 'info'">{{ row.status === 'applied' ? '已应用' : row.status === 'failed' ? '失败' : row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="错误" min-width="140"><template #default="{ row }"><span style="font-size:12px; color:#dc2626">{{ row.error || '' }}</span></template></el-table-column>
        </el-table>
        <template #footer>
          <el-button @click="stateDrawer.visible = false">关闭</el-button>
        </template>
      </el-drawer>

      <el-dialog v-model="applyDialog.visible" title="批量应用候选调价 → Yandex" width="1120px" append-to-body destroy-on-close :close-on-click-modal="false">
        <el-alert type="info" :closable="false" style="margin-bottom:10px"
          title="流程：按候选的采购成本/尺寸/重量 + 当前定价参数重算 Yandex 售价并提交平台（写调价记录）。提交即真实改价，建议先小批量核对。" />
        <el-table :data="applyDialog.rows" v-loading="applyDialog.busy" element-loading-text="正在预览 / 提交..." border size="large" max-height="460">
          <el-table-column label="商品" min-width="230">
            <template #default="{ row }">
              <div style="display:flex; align-items:center; gap:10px">
                <el-image :src="row.image" lazy style="width:44px; height:44px; border-radius:6px; background:#f1f5f9" fit="cover" />
                <div style="min-width:0">
                  <div class="text-ellipsis" style="font-size:13px; color:#111827; font-weight:600">{{ row.name }}</div>
                  <div style="font-size:12px; color:#94a3b8">{{ row.offerId }}</div>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="现价" width="100" align="right">
            <template #default="{ row }">
              <span style="color:#64748b">{{ row.oldPrice ? row.oldPrice + ' ' + row.oldCurrency : '-' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="采购 ¥" width="90" align="right">
            <template #default="{ row }">¥{{ row.cand ? Number(row.cand.purchaseCny || 0).toFixed(2) : '-' }}</template>
          </el-table-column>
          <el-table-column label="建议售价" width="140" align="center">
            <template #default="{ row }">
              <span v-if="row.preview" style="color:#2563eb; font-weight:700">CNY {{ row.preview.priceCny }}<br /><span style="font-weight:400;color:#64748b">≈₽{{ row.preview.rubValue }}</span></span>
              <span v-else style="color:#b91c1c; font-size:12px">{{ row.result ? '' : '预览失败/跳过' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="利润" width="120" align="center">
            <template #default="{ row }">
              <span v-if="row.preview" :style="{ color: row.preview.profitCny >= 0 ? '#16a34a' : '#dc2626' }">¥{{ row.preview.profitCny }}<br /><span style="font-size:12px;color:#64748b">毛利 {{ row.preview.marginPct }}%</span></span>
              <span v-else style="color:#94a3b8">-</span>
            </template>
          </el-table-column>
          <el-table-column label="提交结果" min-width="170">
            <template #default="{ row }">
              <span v-if="row.result" :style="{ color: row.result.ok ? '#16a34a' : '#dc2626', fontSize: '12px' }">
                {{ row.result.ok ? '✓ 已提交 Yandex' : '✗ ' + (row.result.error || '失败') }}
              </span>
              <span v-else-if="row.preview" style="color:#94a3b8; font-size:12px">待确认</span>
              <span v-else style="color:#94a3b8; font-size:12px">-</span>
            </template>
          </el-table-column>
        </el-table>
        <template #footer>
          <el-button :disabled="applyDialog.busy" @click="applyDialog.visible = false">关闭</el-button>
          <el-button type="warning" :loading="applyDialog.busy" :disabled="!applyDialog.rows.some((r) => r.preview && !r.result)" @click="confirmApplyBatch">
            确认批量应用（{{ applyDialog.rows.filter((r) => r.preview && !r.result).length }} 项）
          </el-button>
        </template>
      </el-dialog>

      <el-dialog v-model="reverseDialog.visible" title="Ozon 反推定价 → Yandex 售价（免 1688 核价）" width="1080px" append-to-body destroy-on-close :close-on-click-modal="false">
        <div style="display:flex; align-items:center; gap:16px; flex-wrap:wrap; margin-bottom:10px">
          <span style="font-size:12px; color:#64748b">Ozon 售价自动匹配同款；匹配不到的行请手填 Ozon 在售价(CNY)。利润率为 Ozon 侧目标。</span>
          <el-form-item label="Ozon 利润率 %" style="margin:0"><el-input-number v-model="profitDialog.cost.ozonMarginPct" :min="0" :max="80" :precision="1" :step="1" size="small" style="width:110px" /></el-form-item>
          <el-form-item label="国内运费 ¥" style="margin:0"><el-input-number v-model="profitDialog.cost.domesticShippingCny" :min="0" :precision="2" :step="0.5" size="small" style="width:100px" /></el-form-item>
          <el-form-item label="汇率 CNY/RUB" style="margin:0"><el-input-number v-model="profitDialog.cost.exchangeRate" :min="1" :precision="4" :step="0.5" size="small" style="width:120px" /></el-form-item>
        </div>
        <el-table :data="reverseDialog.rows" height="420" size="small" border>
          <el-table-column label="商品" min-width="220">
            <template #default="{ row }">
              <div style="display:flex; gap:8px; align-items:center">
                <img :src="row.img" referrerpolicy="no-referrer" style="width:38px;height:38px;border-radius:4px;object-fit:cover;background:#f1f5f9" @error="$event.target.style.visibility='hidden'" />
                <div style="min-width:0">
                  <div style="font-size:12px; color:#334155; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:170px">{{ row.name }}</div>
                  <div style="font-size:11px; color:#94a3b8">{{ row.offerId }}</div>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="Ozon 在售价 CNY（可改）" width="150">
            <template #default="{ row }">
              <el-input-number v-model="row.ozonPriceCny" :min="0" :precision="2" size="small" style="width:120px" :placeholder="row.rev ? '' : '自动匹配或手填'" />
            </template>
          </el-table-column>
          <el-table-column label="佣金 %" width="80" align="center">
            <template #default="{ row }">{{ row.rev ? row.rev.commission : '-' }}</template>
          </el-table-column>
          <el-table-column label="头程 ¥" width="90" align="center">
            <template #default="{ row }">{{ row.rev ? row.rev.crossCny : '-' }}</template>
          </el-table-column>
          <el-table-column label="反推采购 ¥" width="110" align="center">
            <template #default="{ row }"><b v-if="row.rev" style="color:#0f172a">{{ Number(row.rev.purchaseCny).toFixed(2) }}</b><span v-else>-</span></template>
          </el-table-column>
          <el-table-column label="Yandex 建议售价" width="130" align="center">
            <template #default="{ row }">
              <span v-if="row.rev && row.rev.ys" style="color:#2563eb; font-weight:700">CNY {{ row.rev.ys.priceCny }}<br /><span style="font-weight:400;color:#64748b">≈₽{{ row.rev.ys.rubValue }}</span></span>
              <span v-else>-</span>
            </template>
          </el-table-column>
          <el-table-column label="划线价 / 利润 ¥" width="150" align="center">
            <template #default="{ row }">
              <span v-if="row.rev && row.rev.ys" style="font-size:12px; color:#64748b">划线 CNY {{ row.rev.ys.strikePriceCny }}<br />利润 ¥{{ row.rev.ys.profitCny }}</span>
              <span v-else>-</span>
            </template>
          </el-table-column>
          <el-table-column label="状态 / 应用结果" min-width="180">
            <template #default="{ row }">
              <div>
                <div v-if="row.err" style="color:#dc2626; font-size:12px">{{ row.err }}
                  <el-button link type="primary" size="small" style="margin-left:4px" @click="reverseOneRow(row)">重试</el-button>
                </div>
                <div v-else-if="row.rev" style="color:#16a34a; font-size:12px">✓ 已反推（佣金 {{ row.rev.commission }}% · {{ row.rev.descCat ? '按类目' : '默认档' }}）</div>
                <div v-else style="color:#94a3b8; font-size:12px">反推中…</div>
                <div v-if="row.applyResult" style="font-size:12px; color:#0ea5e9; margin-top:2px">{{ row.applyResult }}</div>
              </div>
            </template>
          </el-table-column>
        </el-table>
        <template #footer>
          <el-button @click="reverseDialog.visible = false">关闭</el-button>
          <el-popconfirm :title="'将把 ' + reverseDialog.rows.filter((r) => r.rev && r.rev.ys).length + ' 个反推结果保存为价格候选（调价队列），之后到列表用「批量应用候选调价」统一提交 Yandex，确认？'" @confirm="applyReverseToYandex">
            <template #reference>
              <el-button type="success" plain :loading="reverseDialog.applying" :disabled="!reverseDialog.rows.some((r) => r.rev && r.rev.ys)">保存为候选（待批量应用调价）</el-button>
              </template>
            </template>
          </el-table>
        </template>
      </el-dialog>

      <el-dialog v-model="aiDialog.visible" title="AI 优化（Yandex 商品卡片：生成俄语标题/描述 → 勾选后提交平台）" width="1200px" append-to-body destroy-on-close :close-on-click-modal="false" :close-on-press-escape="!aiDialog.busy">
        <el-alert type="info" :closable="false" style="margin-bottom:12px"
          title="试点说明"
          description="AI 依据商品现状与质量问题生成优化标题与描述（俄语）。提交后 Yandex 会重新审核商品卡片，审核通过质量分会提升。AI 模型在「店铺管理 → AI 设置」配置（支持通义 DashScope / MiniMax）。" />
        <el-table :data="aiDialog.rows" v-loading="aiDialog.busy" element-loading-text="AI 正在逐个生成优化内容..." border size="large" max-height="520">
          <el-table-column label="提交" width="64" align="center">
            <template #default="{ row }">
              <el-checkbox :model-value="Boolean(aiChecked[row.offerId])" :disabled="row.status !== 'ok'"
                @change="(v) => { aiChecked[row.offerId] = Boolean(v); }" />
            </template>
          </el-table-column>
          <el-table-column label="商品（现状）" min-width="230">
            <template #default="{ row }">
              <div class="text-ellipsis" style="font-weight:700; color:#0f172a; max-width:220px" :title="row.originName || row.name">{{ row.originName || row.name }}</div>
              <div style="font-size:12px; color:#94a3b8; margin-top:4px">货号 {{ row.offerId }}</div>
            </template>
          </el-table-column>
          <el-table-column label="状态 / 生成结果" min-width="260">
            <template #default="{ row }">
              <div v-if="row.status === 'queued'" style="color:#94a3b8">生成中...</div>
              <div v-else-if="row.status === 'error'" style="color:#dc2626; font-size:12px">{{ row.error }}</div>
              <div v-else-if="row.status === 'ok' && row.suggested">
                <div style="color:#16a34a; font-weight:800; margin-bottom:4px">✓ 建议标题（俄语）</div>
                <div class="text-ellipsis" style="font-size:13px; color:#0f172a; max-width:520px" :title="row.suggested.name">{{ row.suggested.name }}</div>
                <el-tooltip :content="row.suggested.description" placement="top">
                  <div class="text-ellipsis" style="font-size:12px; color:#64748b; margin-top:4px; max-width:520px">{{ row.suggested.description }}</div>
                </el-tooltip>
                <div v-if="row.attributes && row.attributes.length" style="margin-top:6px">
                  <div style="font-size:12px; color:#2563eb; font-weight:700; margin-bottom:3px">补全属性（{{ row.attributes.length }} 项，随提交写入 Yandex）</div>
                  <div style="display:flex; flex-wrap:wrap; gap:4px">
                    <el-tag v-for="(a, i) in row.attributes" :key="i" size="small" type="primary" effect="plain"
                      :title="a.name">{{ a.name_zh || a.name }}<span style="color:#94a3b8"> = </span>{{ a.value }}{{ a.unit ? ' ' + a.unit : '' }}</el-tag>
                  </div>
                </div>
                <div v-if="row.changes.length" style="margin-top:6px; display:flex; flex-wrap:wrap; gap:4px">
                  <el-tag v-for="(c, i) in row.changes" :key="i" size="small" type="warning" effect="plain">{{ c }}</el-tag>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="提交结果" width="200">
            <template #default="{ row }">
              <span style="font-size:12px">{{ row.message || '' }}</span>
            </template>
          </el-table-column>
        </el-table>
        <template #footer>
          <el-button @click="aiDialog.visible = false" :disabled="aiDialog.busy || aiDialog.applying">关闭</el-button>
          <el-button type="success" :loading="aiDialog.applying" :disabled="aiDialog.busy || !aiDialog.rows.some((r) => r.status === 'ok')" @click="applyAiOptimize">
            提交勾选项到 Yandex（真实改商品卡片）
          </el-button>
        </template>
      </el-dialog>

      <el-dialog v-model="aiRecordsDialog.visible" title="AI 优化记录" width="820px" append-to-body destroy-on-close>
        <div style="font-size:13px; color:#334155; margin-bottom:10px; font-weight:700">{{ aiRecordsDialog.name }} <span style="color:#94a3b8; font-weight:400">{{ aiRecordsDialog.offerId }}</span></div>
        <el-table :data="aiRecordsDialog.rows" v-loading="aiRecordsDialog.busy" size="large" border max-height="440" empty-text="暂无 AI 优化记录（做过优化并提交后会出现在这里）">
          <el-table-column label="时间" width="170"><template #default="{ row }">{{ String(row.created_at || '').slice(0, 16) }}</template></el-table-column>
          <el-table-column label="方式" width="110"><template #default="{ row }"><el-tag size="small" :type="row.action === 'fill' ? 'warning' : 'primary'">{{ row.action === 'fill' ? '智能填充' : 'AI 优化' }}</el-tag></template></el-table-column>
          <el-table-column label="改动内容" min-width="220">
            <template #default="{ row }">
              <div style="display:flex; gap:4px; flex-wrap:wrap">
                <el-tag v-if="row.title_changed" size="small" type="info" effect="plain">标题</el-tag>
                <el-tag v-if="row.desc_changed" size="small" type="info" effect="plain">描述</el-tag>
                <el-tag v-if="row.attr_count > 0" size="small" type="info" effect="plain">属性 {{ row.attr_count }} 项</el-tag>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag size="small" :type="row.status === 'applied' ? 'success' : 'danger'">{{ row.status === 'applied' ? '已提交' : '失败' }}</el-tag></template></el-table-column>
          <el-table-column label="说明" min-width="160"><template #default="{ row }"><span style="font-size:12px; color:#94a3b8">{{ row.detail || '' }}</span></template></el-table-column>
        </el-table>
      </el-dialog>
    </div>
  `
};
