// v2.0 批量跟卖 - UI 重构 (参考 MY 批量上架)
// 保留所有现有业务函数 (parsePaste / collectSkus / aiRewriteAll / addWatermarkAll / publishBatch)
// 重写: 顶部 toolbar + 左列(粘贴/预览/进度/结果) + 右栏(店铺/品牌/图片顺序/货币/AI 增强) + Help drawer
window.BatchUploadView = {
  setup() {
    const loading = Vue.ref(false);
    const pasteText = Vue.ref('');
    const parseLoading = Vue.ref(false);
    const items = Vue.ref([]);
    const logLines = Vue.ref([]);
    const publishLoading = Vue.ref(false);
    const selectedStores = Vue.ref([]);
    const allStores = Vue.ref([]);
    const config = Vue.reactive({
      brand: 'no_brand', imageOrder: 'keep', currency: 'CNY',
      defaultStock: 0, watermark: false, aiRewrite: false, vat: '0',
    });

    // ========== v2.0 新增: Help drawer 状态 ==========
    const helpOpen = Vue.ref(false);

    // ========== v2.0 新增: 10 格式说明数据 ==========
    const formatHints = [
      { n: 1, req: 'sku · 售价', opt: '' },
      { n: 2, req: 'sku · 售价', opt: '· 货号' },
      { n: 3, req: 'sku · 售价', opt: '· 重量g' },
      { n: 4, req: 'sku · 售价', opt: '· 长mm' },
      { n: 5, req: 'sku · 售价', opt: '· 长 · 宽' },
      { n: 6, req: 'sku · 售价', opt: '· 长 · 宽 · 高' },
      { n: 7, req: 'sku · 售价', opt: '· 重 · L · W · H' },
      { n: 8, req: 'sku · 售价', opt: '· 货号 · 重' },
      { n: 9, req: 'sku · 售价', opt: '· 货 · 重 · L W H' },
      { n: 10, req: 'sku · 售价', opt: '· ~最低价' },
    ];

    const notify = {
      success: m => (window.ElementPlus?.ElMessage || console).success?.(m),
      warning: m => (window.ElementPlus?.ElMessage || console).warning?.(m),
      error: m => (window.ElementPlus?.ElMessage || console).error?.(m),
      info: m => (window.ElementPlus?.ElMessage || console).info?.(m),
    };
    const getStoreId = () => (window.getCurrentStoreId ? window.getCurrentStoreId() : '');

    // ========== 插件中继协议 (保留) ==========
    const PROTO = "__zhumeng_proto";
    const PROTO_VAL = "zhumeng-v1";
    const extensionConnected = Vue.ref(false);
    const sellerTabReady = Vue.ref(false);

    // v2.1.4: ERP ↔ content-bridge-iso 完全走 window.postMessage (双向)
    //   理由: 之前 document CustomEvent 跨 world 投递在 Chrome MV3 不可靠 (collect
    //   request 派发后 ISO listener "收到" log 不出现 - document.dispatchEvent 在 main
    //   world 不能保证到 isolated world). window.postMessage 是 Chrome 官方为跨 world
    //   通信设计的标准 API, spec 保证: main world postMessage → isolated world 'message'
    //   listener 收到, 反之亦然, 且不 bounce-back 到同 world.
    window.__zhumeng_pending__ = window.__zhumeng_pending__ || {};

    window.addEventListener('message', (event) => {
      const d = event.data;
      // v2.1.6 debug: 看 ERP 端 window 'message' 收到什么
      try { console.log('[ERP msg-receive] kind=' + (d && d.kind) + ' reqId=' + ((d && d.reqId || '').slice(0, 24)) + ' keys=' + (d ? Object.keys(d).join(',') : 'null')); } catch (e) {}
      if (!d || typeof d !== 'object' || d[PROTO] !== PROTO_VAL) return;
      // v2.1.7 fix: window.postMessage 在调用方自己 window 同步触发 'message' listener,
      //   自己发出去的 .request 会 bounce-back 立刻 resolve 自己的 promise,
      //   错把 request body 当 reply 用. 只关心 reply + ready, 忽略 request.
      if (typeof d.kind === 'string' && d.kind.endsWith('.request')) return;
      if (d.kind === 'ready' && !extensionConnected.value) {
        extensionConnected.value = true;
        appendLog('✅ 采集插件已连接', 'success');
        return;
      }
      const resolver = window.__zhumeng_pending__[d.reqId];
      if (resolver) {
        delete window.__zhumeng_pending__[d.reqId];
        resolver(d);
      }
    });

    const sendToExtension = (kind, extra = {}) => new Promise((resolve) => {
      const reqId = `${kind.split('.')[0]}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
      let resolved = false;
      window.__zhumeng_pending__[reqId] = (data) => {
        if (resolved) return;
        resolved = true;
        delete window.__zhumeng_pending__[reqId];
        resolve(data);
      };
      try {
        // v2.1.5 fix: postMessage 内部用 structuredClone 序列化消息, Vue 3 reactive Proxy
        //   (ref.value 的 array/object 是 Proxy) 不能被克隆. 之前 v2.1.4 报
        //   "[object Array] could not be cloned" 就是这个原因.
        //   用 JSON round-trip 强制 deep-clone 到 plain object/array, 剥掉 Proxy 包装.
        const payload = JSON.parse(JSON.stringify({ [PROTO]: PROTO_VAL, reqId, kind, ...extra }));
        window.postMessage(payload, '*');
        console.log(`[ERP → ISO] sent ${kind} reqId=${reqId.slice(0, 20)} via postMessage`);
      } catch (e) {
        console.error(`[ERP → ISO] postMessage ${kind} 抛错:`, e.message);
        resolved = true;
        delete window.__zhumeng_pending__[reqId];
        resolve({ ok: false, error: 'postMessage 抛错: ' + e.message });
        return;
      }
      setTimeout(() => {
        if (resolved) return;
        resolved = true;
        delete window.__zhumeng_pending__[reqId];
        resolve(null);
      }, kind === 'collect.request' ? 120000 : 15000);
    });

    const pingExtension = () => sendToExtension('ping.request').then(d => d?.ok === true);

    // v2.1.9: type_id 是上架 Ozon 必需但采集不到, 让用户在表中手动填一次
    //   并 localStorage 缓存 (key=sku). 注意: 必须在 parsePaste 等任何调它的地方
    //   之前定义 (const 不 hoisted, 否则 TDZ ReferenceError).
    const TYPE_ID_CACHE_KEY = 'zhumeng_type_id_cache';
    const getTypeIdCache = () => {
      try { return JSON.parse(localStorage.getItem(TYPE_ID_CACHE_KEY) || '{}'); } catch { return {}; }
    };
    const setTypeIdCache = (cache) => {
      try { localStorage.setItem(TYPE_ID_CACHE_KEY, JSON.stringify(cache)); } catch {}
    };
    const saveTypeIdCache = (row) => {
      if (!row.typeIdInput || !row.sku) return;
      const cache = getTypeIdCache();
      cache[String(row.sku)] = String(row.typeIdInput).trim();
      setTypeIdCache(cache);
    };
    const applyTypeIdCache = (row) => {
      const cache = getTypeIdCache();
      const hit = cache[String(row.sku)];
      if (hit && !row.typeIdInput) row.typeIdInput = hit;
    };

    // v2.1.1: 加 retry - chrome MV3 inactive SW 第一次唤醒要 1-3 秒, 用户在 mount
    //   流程里 await 时可能 SW 还没 active, 单次调用经常抛 "Receiving end does not exist".
    //   重试 3 次每次间隔 2 秒足够 SW 唤醒完成, 后续 retry 必然能拿到 cookies 状态.
    const checkSellerStatus = async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const d = await sendToExtension('status.request');
        if (d?.ok) return d;
        if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
      }
      return { ok: false };
    };

    const collectViaExtension = (skus) => sendToExtension('collect.request', {
      skus,
      storeIds: selectedStores.value || []
    }).then(d => {
      try { console.log('[collectViaExtension resolved]', JSON.stringify(d)); } catch (e) {}
      return d || { ok: false, error: '采集超时 (120s)' };
    });

    // v2.2.2: 候选类目选择器状态. pickingRow 持当前要选类目的行, 选择后写回 row.distilled
    const categoryPickerOpen = Vue.ref(false);
    const pickingRow = Vue.ref(null);
    const candidateSearch = Vue.ref('');
    const pickerFocusIdx = Vue.ref(0);  // 键盘 ↑↓ 选中候选
    const filteredCandidates = Vue.computed(() => {
      const all = pickingRow.value?._category_resolved?.candidates || [];
      const q = candidateSearch.value.trim().toLowerCase();
      if (!q) return all;
      return all.filter(c =>
        (c.name || '').toLowerCase().includes(q) ||
        String(c.description_category_id).includes(q)
      );
    });
    // v2.2.2: 搜索时若结果数变, 重置 focus 到第一项
    Vue.watch(filteredCandidates, () => { pickerFocusIdx.value = 0; });
    // v2.2.2: 类目统计 - 让顶部一行清晰显示 high/medium/none/manual 各多少
    const categoryStats = Vue.computed(() => {
      const valid = items.value.filter(r => r.valid && r.distilled);
      const stats = { high: 0, medium: 0, none: 0, manual: 0, total: valid.length, pending: 0 };
      for (const r of valid) {
        const c = r._category_resolved?.confidence;
        if (c === 'high') stats.high++;
        else if (c === 'medium') stats.medium++;
        else if (c === 'manual') stats.manual++;
        else if (c === 'none') stats.none++;
        else stats.pending++;
      }
      return stats;
    });
    // v2.2.2: localStorage 记忆用户手动选过的 (sku → description_category_id)
    const CATEGORY_HISTORY_KEY = 'zhumeng_category_choice_v1';
    const getCategoryHistory = () => {
      try { return JSON.parse(localStorage.getItem(CATEGORY_HISTORY_KEY) || '{}'); } catch { return {}; }
    };
    const setCategoryHistory = (sku, catId, name) => {
      const h = getCategoryHistory();
      h[String(sku)] = { description_category_id: Number(catId), name: name || '', ts: Date.now() };
      // 最多保留 500 条
      const entries = Object.entries(h).sort((a, b) => b[1].ts - a[1].ts).slice(0, 500);
      localStorage.setItem(CATEGORY_HISTORY_KEY, JSON.stringify(Object.fromEntries(entries)));
    };

    const openCategoryPicker = (row) => {
      pickingRow.value = row;
      candidateSearch.value = '';
      pickerFocusIdx.value = 0;
      categoryPickerOpen.value = true;
      // v2.2.2: 让 modal 拿到焦点才能接收键盘事件
      Vue.nextTick(() => {
        document.querySelector('.batch-upload-v2 [tabindex="-1"]')?.focus();
      });
    };
    const closeCategoryPicker = () => {
      categoryPickerOpen.value = false;
      pickingRow.value = null;
      candidateSearch.value = '';
      pickerFocusIdx.value = 0;
    };
    // v2.2.2: 键盘处理 — Esc 关, ↑↓ 移焦点, Enter 选
    const onPickerKeydown = (e) => {
      if (!categoryPickerOpen.value) return;
      const list = filteredCandidates.value;
      if (e.key === 'Escape') { e.preventDefault(); closeCategoryPicker(); return; }
      if (!list.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); pickerFocusIdx.value = (pickerFocusIdx.value + 1) % list.length; return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); pickerFocusIdx.value = (pickerFocusIdx.value - 1 + list.length) % list.length; return; }
      if (e.key === 'Enter') { e.preventDefault(); applyCategoryChoice(list[pickerFocusIdx.value]); return; }
    };
    const applyCategoryChoice = async (candidate) => {
      if (!pickingRow.value || !candidate) return;
      const row = pickingRow.value;
      if (!row.distilled) row.distilled = {};
      row.distilled.descriptionCategoryId = Number(candidate.description_category_id);
      row.distilled.descriptionCategoryName = candidate.name || '';
      // 用户手动选时, 把 confidence 标为 'manual' 让 UI 显示"已选"
      row._category_resolved = {
        ...(row._category_resolved || {}),
        confidence: 'manual',
        to: Number(candidate.description_category_id),
        source: 'manual-candidate-pick',
      };
      // 记住用户选过, 下次同 SKU 自动恢复
      setCategoryHistory(row.sku, candidate.description_category_id, candidate.name);
      appendLog(`  ✓ #${row.index} 手动选类目: ${candidate.description_category_id} (${candidate.name || '无名'})`, 'success');
      closeCategoryPicker();

      // v2.2.5: 选完类目立刻自动反查 type_id — 用户不应该手动填 type_id
      //   /api/seller/type-id-suggestion 已经存在, 这里在 modal 选完时也触发一次
      if (!row.distilled.typeId && selectedStores.value.length) {
        try {
          const sugg = await axios.post('/api/seller/type-id-suggestion', {
            description_category_id: row.distilled.descriptionCategoryId,
            store_id: selectedStores.value[0],
          }, { timeout: 8000 });
          if (sugg.data?.success && sugg.data.recommended > 0) {
            row.distilled.typeId = sugg.data.recommended;
            row._type_id_source = sugg.data.source;
            row._type_id_candidates = sugg.data.candidates || [];
            appendLog(`  ✓ #${row.index} 自动配 type_id=${sugg.data.recommended} (${sugg.data.source}, ${(sugg.data.candidates||[]).length} 个候选)`, 'success');
          }
        } catch (e) { /* 不阻塞, 让用户手动填 */ }
      }
    };

    // v2.2.2: 采集完成后, 把 localStorage 记忆的类目应用到 _category_resolved.none 行
    const applyCategoryHistory = () => {
      const h = getCategoryHistory();
      let restored = 0;
      for (const row of items.value) {
        if (!row.valid || !row.distilled) continue;
        if (row._category_resolved?.confidence !== 'none') continue;
        const remembered = h[String(row.sku)];
        if (remembered && !row.distilled.descriptionCategoryId) {
          row.distilled.descriptionCategoryId = remembered.description_category_id;
          row.distilled.descriptionCategoryName = remembered.name || '';
          row._category_resolved = {
            ...row._category_resolved,
            confidence: 'manual',
            to: remembered.description_category_id,
            source: 'history-auto',
          };
          restored++;
        }
      }
      if (restored) appendLog(`  💾 ${restored} 个商品自动恢复了之前选过的类目`, 'info');
      return restored;
    };

    window.addEventListener("message", (event) => {
      // v2.1.3: ready 改走 document.addEventListener('__zhumeng_reply__') 在更上面, 这里留空 stub 兼容老逻辑
    });

    const refreshing = Vue.ref(false);
    let pollTimer = null;
    const startPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(async () => {
        if (extensionConnected.value) { clearInterval(pollTimer); pollTimer = null; return; }
        const ok = await pingExtension();
        if (ok) {
          extensionConnected.value = true;
          appendLog('✅ 采集插件已连接', 'success');
          const st = await checkSellerStatus();
          sellerTabReady.value = st.ok && (st.seller_connected || st.hasSellerTab);
          appendLog(sellerTabReady.value ? 'seller.ozon.ru 已连接 ✓' : '⚠️ 请先打开并登录 seller.ozon.ru', sellerTabReady.value ? 'success' : 'warn');
          clearInterval(pollTimer); pollTimer = null;
        }
      }, 2000);
    };

    Vue.onMounted(async () => {
      fetchStores();
      loadConfig();
      const ok = await pingExtension();
      if (ok) {
        extensionConnected.value = true;
        appendLog('✅ 采集插件已连接', 'success');
        const st = await checkSellerStatus();
        sellerTabReady.value = st.ok && (st.seller_connected || st.hasSellerTab);
        appendLog(sellerTabReady.value ? 'seller.ozon.ru 已连接 ✓' : '⚠️ 请先打开并登录 seller.ozon.ru', sellerTabReady.value ? 'success' : 'warn');
      } else {
        appendLog('⏳ 等待采集插件注入 (每 3 秒自动检测)...', 'info');
        startPolling();
      }
    });

    const refreshStatus = async () => {
      refreshing.value = true;
      // v2.1.6 fix: 不要在这里覆盖 extensionConnected.value = ok. 之前 pingExtension
      //   返回 false (15s timeout) 会直接把 ready handler 已经设上的 true 覆盖成
      //   false. ready handler 是 ground truth, refreshStatus 应该 trust 它.
      const ok = await pingExtension();
      if (ok || extensionConnected.value) {
        const st = await checkSellerStatus();
        sellerTabReady.value = st.ok && (st.seller_connected || st.hasSellerTab);
        appendLog(sellerTabReady.value ? '刷新成功: 插件+seller 均已连接' : '刷新成功: 插件已连接, seller 待登录', 'success');
      } else {
        appendLog('刷新: 仍未检测到插件, 继续轮询...', 'warn');
        if (!pollTimer) startPolling();
      }
      setTimeout(() => { refreshing.value = false; }, 2000);
    };

    Vue.onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer); });

    // ========== 10 格式解析器 (保留) ==========
    const SKU_RE = /^\d{6,16}$/;
    const WEIGHT_RE = /^(\d+(?:\.\d+)?)\s*(?:g|克|г|gram|grams)$/i;
    const LENGTH_RE = /^(\d+(?:\.\d+)?)\s*(?:mm|мм|毫米)$/i;
    const BARE_NUM_RE = /^\d+(?:\.\d+)?$/;
    const MIN_PRICE_RE = /^~/;
    const MIN_PRICE_STRICT_RE = /^~\d+(\.\d+)?$/;
    const FORMAT_LABELS = {
      1:'sku+售价', 2:'+货号', 3:'+重量', 4:'+长', 5:'+长宽', 6:'+长宽高',
      7:'+重+长宽高', 8:'+货号+重', 9:'+货号+重+长宽高', 10:'+~最低价',
    };

    const splitCols = (line) => line.split(/[,，\t]|\s{2,}/).map(s=>s.trim()).filter(s=>s.length>0);
    const asNumber = (s) => { const n=Number(String(s).replace(/[^0-9.\-]/g,'')); return Number.isFinite(n)?n:null; };
    const parseValueToken = (s) => {
      const t=String(s||'').trim(); let m;
      if((m=WEIGHT_RE.exec(t))) return {num:parseFloat(m[1]),unit:'weight'};
      if((m=LENGTH_RE.exec(t))) return {num:parseFloat(m[1]),unit:'length'};
      if(BARE_NUM_RE.test(t)) return {num:parseFloat(t),unit:null};
      return null;
    };
    const classifyNumeric = (nums, units) => {
      if(!nums.length) return {kind:'unknown'};
      if(nums.length===1){
        if(units[0]==='weight') return {kind:'weight',weight:nums[0]};
        if(units[0]==='length') return {kind:'dim1',l:nums[0]};
        if(nums[0]<=3000) return {kind:'dim1',l:nums[0]};
        return {kind:'weight',weight:nums[0]};
      }
      if(nums.length===2) return {kind:'dim2',l:nums[0],w:nums[1]};
      if(nums.length===3) return {kind:'dim3',l:nums[0],w:nums[1],h:nums[2]};
      if(nums.length===4) return {kind:'w-dim3',weight:nums[0],l:nums[1],w:nums[2],h:nums[3]};
      return {kind:'unknown'};
    };

    function parseLine(line, index) {
      const trimmed = String(line||'').trim();
      if(!trimmed) return {index, raw:line, sku:'', valid:false, reason:'空行'};
      const cols = splitCols(trimmed);
      if(cols.length<2) return {index, raw:trimmed, sku:cols[0]||'', valid:false, reason:'至少2列: sku 售价'};
      const sku = cols[0];
      if(!SKU_RE.test(sku)) return {index, raw:trimmed, sku, valid:false, reason:'SKU须6-16位纯数字'};
      const price = asNumber(cols[1]);
      if(!price||price<=0) return {index, raw:trimmed, sku, valid:false, reason:'售价必须>0'};
      const row = {index, raw:trimmed, sku, price, minPrice:null, offerId:null, weightG:null, lengthMm:null, widthMm:null, heightMm:null, formatHint:1, valid:true, typeIdInput:''};
      if(cols.length===2) return {...row, formatHint:1};
      let minPrice=null; const rest=[];
      for(const c of cols.slice(2)){
        if(MIN_PRICE_RE.test(c)){
          if(minPrice!=null) return {...row, valid:false, reason:'最低价(~)只能一次'};
          if(!MIN_PRICE_STRICT_RE.test(c)) return {...row, valid:false, reason:`最低价格式无效: "${c}"`};
          minPrice=Number(c.slice(1));
          if(minPrice>price) return {...row, valid:false, reason:`最低价(${minPrice})>售价(${price})`};
        } else rest.push(c);
      }
      if(minPrice!=null) row.minPrice=minPrice;
      if(minPrice!=null && rest.length===0) return {...row, formatHint:10};
      let offerId=null, valueCols=rest;
      if(rest[0]!=null && parseValueToken(rest[0])==null){ offerId=rest[0]; valueCols=rest.slice(1); }
      const nums=[], units=[];
      for(const c of valueCols){ const tok=parseValueToken(c); if(!tok) return {...row, offerId, valid:false, reason:`"${c}"不是有效数值`}; nums.push(tok.num); units.push(tok.unit); }
      const cls=classifyNumeric(nums,units); const has=offerId!=null;
      if(cls.kind==='unknown') return has&&nums.length===0 ? {...row, offerId, formatHint:2} : {...row, offerId, valid:false, reason:'无法识别'};
      if(cls.kind==='dim1') return has ? {...row, offerId, weightG:cls.l, formatHint:8} : {...row, lengthMm:cls.l, formatHint:4};
      if(cls.kind==='weight') return has ? {...row, offerId, weightG:cls.weight, formatHint:8} : {...row, weightG:cls.weight, formatHint:has?8:3};
      if(cls.kind==='dim2') return has ? {...row, offerId, valid:false, reason:'含货号时需 重量+长宽高(4数)'} : {...row, lengthMm:cls.l, widthMm:cls.w, formatHint:5};
      if(cls.kind==='dim3') return has ? {...row, offerId, valid:false, reason:'含货号时尺寸前应有重量'} : {...row, lengthMm:cls.l, widthMm:cls.w, heightMm:cls.h, formatHint:6};
      if(cls.kind==='w-dim3') return has ? {...row, offerId, weightG:cls.weight, lengthMm:cls.l, widthMm:cls.w, heightMm:cls.h, formatHint:9} : {...row, weightG:cls.weight, lengthMm:cls.l, widthMm:cls.w, heightMm:cls.h, formatHint:7};
      return {...row, valid:false, reason:'未知格式'};
    }

    // ========== 日志面板 (保留) ==========
    const appendLog = (text, type='info') => {
      const ts = new Date().toLocaleTimeString('zh-CN', {hour12:false});
      logLines.value.push({ ts, text, type });
      Vue.nextTick(() => {
        const el = document.getElementById('batch-log-panel');
        if (el) el.scrollTop = el.scrollHeight;
      });
    };

    // ========== 解析粘贴 → 预览表 → 自动采集 (保留) ==========
    const parsePaste = async () => {
      const raw = pasteText.value.trim();
      if(!raw) return notify.warning('请先粘贴数据');
      const lines = raw.split(/\r?\n/).filter(l=>l.trim());
      const rows = lines.map((l,i) => parseLine(l, i+1));
      // v2.1.9: 套用 type_id 缓存 (用户之前手填过的 SKU 自动恢复)
      rows.forEach(r => { if (r.valid) applyTypeIdCache(r); });
      const valid = rows.filter(r=>r.valid);
      const invalid = rows.filter(r=>!r.valid);
      items.value = rows;
      appendLog(`解析完成: ${rows.length} 行, ${valid.length} 有效, ${invalid.length} 无效`, 'success');
      if(invalid.length) appendLog(`无效行: ${invalid.map(r=>`#${r.index} ${r.reason}`).join('; ')}`, 'warn');
      notify.success(`解析 ${valid.length} 行有效数据`);

      // 解析只做格式, 不自动采集. 用户看完预览后主动点「采集」或「开始批采+上架」.
      // 修复 v2.1.1 副作用: 之前解析完会 await collectSkus(), 让「采集」按钮变冗余.
      if(valid.length && !extensionConnected.value) {
        appendLog('提示: 插件未连接, 下一步点「采集」前请先安装插件并登录 seller.ozon.ru', 'warn');
      }
    };

    // ========== SKU 批采 (保留) ==========
    const collectSkus = async () => {
      const validRows = items.value.filter(r=>r.valid);
      if(!validRows.length) return notify.warning('无有效行');
      if(!selectedStores.value.length) return notify.warning('请选择目标店铺');

      if(true) {
        // v2.1.2: 去掉 extensionConnected 卡点, 直接进 plugin path.
        //   即使用户状态机有问题也强制走, 让 SW 端兜底 (找不到数据时 okCount=0 failCount=N).
        //   selleready 是历史遗留, 当前 SW 已经用 cookie 检查不依赖 tab.
        parseLoading.value = true;
        appendLog(`开始采集 ${validRows.length} 个 SKU (通过插件中继)...`, 'info');
        const skus = validRows.map(r => r.sku);
        const t0 = Date.now();
        try {
          const resp = await collectViaExtension(skus);
          if(resp.ok) {
            const results = resp.results || {};
            const errors = resp.errors || {};
            let ok=0, fail=0;
            for(const row of validRows) {
              const d = results[row.sku];
              if(d) {
                row.distilled = {
                  name: d.name, images: d.images || (d.primary_image ? [d.primary_image] : []),
                  weight: d.weight, depth: d.depth, width: d.width, height: d.height,
                  descriptionCategoryId: d.description_category_id, typeId: d.type_id,
                  barcode: d.barcode, description: d.description, brand: d.brand,
                  attributes: d.attributes || [],
                  country_of_origin: d.country_of_origin || '',
                  price: d.price || '',
                };
                // v2.2.2: 把 plugin 端类目解析结果透出, 让表格显示置信度 + 候选给用户选
                if (d._category_resolved) row._category_resolved = d._category_resolved;
                // v2.1.10: type_id 兜底 - SW 拿到 0 时, 反查 MY 后端用同店铺同 cat_id
                //   已发布过的 (type_id, 中文名) 历史, 自动填入 + 缓存. 用户无需手工填.
                if ((!row.distilled.typeId || row.distilled.typeId === 0)
                    && row.distilled.descriptionCategoryId
                    && selectedStores.value.length) {
                  try {
                    const sugg = await axios.post('/api/seller/type-id-suggestion', {
                      description_category_id: row.distilled.descriptionCategoryId,
                      store_id: selectedStores.value[0],
                    }, { timeout: 8000 });
                    if (sugg.data?.success && sugg.data.recommended > 0) {
                      row.distilled.typeId = sugg.data.recommended;
                      row._type_id_source = sugg.data.source;
                      row._type_id_candidates = sugg.data.candidates || [];
                      appendLog(`  ℹ️ #${row.index} ${row.sku}: 兜底 type_id=${sugg.data.recommended} (${sugg.data.source})`, 'info');
                    }
                  } catch (e) {
                    // 反查失败不阻塞, 上架时仍可手填
                  }
                }
                ok++;
                appendLog(`  ✓ #${row.index} ${d.name?.slice(0,40)} | ${d.images?.length}图 | cat=${d.description_category_id || 0} | attr=${(d.attributes||[]).length}`, 'success');
              } else {
                fail++;
                row._collectError = errors[row.sku] || '未找到';
                appendLog(`  ✗ #${row.index} ${row.sku}: ${row._collectError}`, 'error');
              }
            }
            appendLog(`采集完成: ${ok} 成功, ${fail} 失败 (${((Date.now()-t0)/1000).toFixed(1)}s)`, fail===0 ? 'success' : 'warn');
            // v2.2.2: 自动恢复 localStorage 记忆的类目 (none → manual)
            const restored = applyCategoryHistory();
            if (restored > 0) {
              const s = categoryStats.value;
              appendLog(`  📊 类目状态: 高 ${s.high} · 中 ${s.medium} · 已选 ${s.manual} · 未选 ${s.none}`, 'info');
            }
            notify.success(`采集 ${ok} 个商品`);
          } else {
            appendLog(`插件采集失败: ${resp.error}`, 'error');
            notify.error('插件采集失败: ' + resp.error);
          }
        } catch(e) {
          appendLog(`采集异常: ${e.message}`, 'error');
          notify.error('采集异常: ' + e.message);
        } finally { parseLoading.value = false; }
      } else {
        parseLoading.value = true;
        appendLog(`插件未连接, 走后端本地库查询...`, 'warn');
        const skus = validRows.map(r => r.sku);
        try {
          const res = await axios.post('/api/seller/products/collect-competitor', {
            store_id: selectedStores.value[0], ids: skus,
          }, { timeout: 120000 });
          const matched = res.data.items || [];
          const map = new Map(matched.map(m => [String(m.sku || m.offer_id), m]));
          let ok=0, miss=0;
          for(const row of validRows) {
            const m = map.get(row.sku) || map.get(`OZON-${row.sku}`);
            if(m) {
              row.distilled = {
                name: m.name, images: m.images || (m.image ? [m.image] : []),
                weight: m.weight, depth: m.depth, width: m.width, height: m.height,
                descriptionCategoryId: m.description_category_id, typeId: m.type_id,
                barcode: m.barcode, description: m.description, brand: m.brand,
                attributes: m.attributes || [],
              };
              ok++;
            } else { miss++; row._collectError = '未找到'; }
          }
          appendLog(`本地库查询: ${ok}/${validRows.length} 命中, ${miss} 未找到 (竞品需通过插件采集)`, miss > 0 ? 'warn' : 'success');
          if(miss > 0) notify.warning(`${miss} 个 SKU 需安装采集插件才能采集竞品数据`);
        } catch(e) {
          appendLog(`后端查询失败: ${e.message}`, 'error');
          notify.error('查询失败: ' + e.message);
        } finally { parseLoading.value = false; }
      }
    };

    // ========== V3 payload 拼装 (保留) ==========
    const buildV3Item = (row, opts={}) => {
      const d = row.distilled;
      if(!d) return {ok:false, error:'未采集到商品信息'};
      if(!d.images||!d.images.length) return {ok:false, error:'采集结果缺少图片'};
      // v2.1.9: 用户手动输入的 type_id 优先级最高
      const userTypeId = parseInt(row.typeIdInput, 10);
      if (userTypeId > 0) d.typeId = userTypeId;
      const name = (d.name||`Ozon SKU ${row.sku}`).replace(/\s+/g,' ').trim().slice(0,200);
      // v2.1.1 修复: Ozon /v3/product/import 要的是 string[] (URL 数组), 不是对象数组
      // 过滤掉非字符串的, 保持字符串数组
      const images = d.images.filter(u => typeof u === 'string' && u.length > 0);
      const weight = row.weightG>0 ? Math.round(row.weightG) : (d.weight||100);
      const depth = row.lengthMm>0 ? Math.round(row.lengthMm) : (d.depth||100);
      const width = row.widthMm>0 ? Math.round(row.widthMm) : (d.width||100);
      const height = row.heightMm>0 ? Math.round(row.heightMm) : (d.height||100);
      const offerId = row.offerId || `zm-${Math.random().toString(36).slice(2,8)}-${row.sku}`;
      const oldPrice = (row.price*1.25).toFixed(2);
      const item = {
        offer_id: offerId, name,
        price: row.price.toFixed(2), old_price: oldPrice,
        vat: opts.vat||'0', currency_code: opts.currencyCode||'CNY',
        images, weight, weight_unit:'g', depth, width, height, dimension_unit:'mm',
        barcode: d.barcode||'', description: d.description||name,
        description_category_id: d.descriptionCategoryId, type_id: d.typeId,
        primary_image: images[0] || '',
        service_type: 'IS_CODE_SERVICE', complex_attributes: [],
      };
      if(opts.brand) item.scraped_brand = opts.brand;
      if(row.minPrice>0) item.min_price = row.minPrice.toFixed(2);
      if(opts.defaultStock>0) item._stock = opts.defaultStock;
      // v1.0.9: 把 attributes 也加到 payload
      if(Array.isArray(d.attributes) && d.attributes.length) {
        item.attributes = d.attributes;
      }
      return {ok:true, item};
    };

// ========== 标题质量预检 (保留) ==========
    const checkTitleQuality = (name) => {
      const issues = [];
      if(/[\u4e00-\u9fff]/.test(name)) issues.push('含中文字符');
      if(name.length>190) issues.push('标题过长(>190)');
      const upperWords = name.match(/\b[A-Z]{2,}\b/g);
      if (upperWords && upperWords.length>=2) issues.push('多个全大写词');
      // v2.2.8: Ozon 名称不能是拉丁字母 — 必须含 Cyrillic (俄文)
      //   Cyrillic Unicode 范围: \u0400-\u04FF (Cyrillic), \u0500-\u052F (Cyrillic Supplement)
      const hasCyrillic = /[\u0400-\u04FF\u0500-\u052F]/.test(name);
      const asciiCount = (name.match(/[\x00-\x7F]/g) || []).length;
      if (!hasCyrillic && asciiCount > 5) {
        issues.push('Ozons 拒纯拉丁字母标题 (必须含俄文/西里尔字母)');
      }
      return issues;
    };

    // ========== AI 重写 (保留) ==========
    const aiRewriteAll = async () => {
      const rows = items.value.filter(r=>r.valid && r.distilled);
      if(!rows.length) return notify.warning('请先采集');
      config.aiRewrite = true;
      appendLog(`AI 重写开始 (${rows.length} 个商品)...`, 'info');
      let ok=0;
      for(const row of rows){
        try {
          const res = await axios.post('/api/ai/analyze', {
            title: row.distilled.name, images: row.distilled.images.slice(0,2), target_market:'ozon',
          });
          const d = res.data?.data||{};
          if(d.title_ru) row.distilled.name = d.title_ru;
          if(d.selling_points?.length) row.distilled.description = d.selling_points.join('\n');
          ok++;
          appendLog(`  ✓ #${row.index} ${d.title_ru?.slice(0,30)||''}`, 'success');
        } catch(e) { appendLog(`  ✗ #${row.index} AI重写失败`, 'error'); }
      }
      appendLog(`AI 重写完成: ${ok}/${rows.length}`, 'success');
      config.aiRewrite = false;
    };

    // ========== 批量加水印 (保留) ==========
    const addWatermarkAll = async () => {
      const rows = items.value.filter(r=>r.valid && r.distilled && r.distilled.images.length);
      if(!rows.length) return notify.warning('无图片可加水印');
      appendLog(`开始加水印 (${rows.length} 个商品)...`, 'info');
      let ok=0;
      for(const row of rows){
        try {
          const res = await axios.post('/api/images/watermark', {
            images: row.distilled.images, text: '逐梦ERP',
          });
          if(res.data?.images) { row.distilled.images = res.data.images; ok++; }
        } catch(e) { appendLog(`  ✗ #${row.index} 水印失败`, 'error'); }
      }
      appendLog(`水印完成: ${ok}/${rows.length}`, 'success');
    };

    // ========== 多店铺扇出发布 (保留) ==========
    const publishBatch = async () => {
      const rows = items.value.filter(r=>r.valid && r.distilled);
      if(!rows.length) return notify.warning('无可上架商品');
      if(!selectedStores.value.length) return notify.warning('请选择目标店铺');
      try {
        await window.ElementPlus.ElMessageBox.confirm(
          `确认将 ${rows.length} 个商品发布到 ${selectedStores.value.length} 个店铺?`,
          '批量跟卖', {confirmButtonText:'执行上架', cancelButtonText:'取消', type:'warning'});
      } catch { return; }
      publishLoading.value = true;
      logLines.value = [];
      appendLog(`========== 批量跟卖开始 ==========`, 'info');
      appendLog(`商品: ${rows.length} 个 | 店铺: ${selectedStores.value.length} 个`, 'info');

      let totalOk=0, totalFail=0, totalSkipped=0;
      for(const storeId of selectedStores.value){
        const storeName = allStores.value.find(s=>s.id===storeId)?.name || storeId;
        appendLog(`\n--- [${storeName}] 开始 ---`, 'info');
        // v2.2.7: 收集本店铺本轮所有有效商品, 一次性 POST 给 /api/seller/products/import
        //   (server 现在接收顶层 stocks, 跟 MY 一样原子提交 items + stocks 给 Ozon /v3/product/import)
        const storeItems = [];
        const storeStocks = [];
        const whId = selectedWarehousesByStore.value[storeId];  // v2.2.6 每店仓库, v2.2.7 仍按店走
        for(const row of rows){
          // v2.2.4: 拦截 confidence='none' 且 to=0 的行 (URL 面包屑 ID 不是 Seller API 的)
          //   Ozon 必拒 levels_category_not_found, 前端必须拦住不让提交
          const catRes = row._category_resolved || {};
          if (catRes.confidence === 'none' && !catRes.to) {
            appendLog(`  ⚠ #${row.index} SKU ${row.sku}: 类目未解析, 跳过 (去表格"选类目"按钮先选)`, 'warn');
            totalSkipped++;
            continue;
          }
          const issues = checkTitleQuality(row.distilled.name);
          if(issues.length && !config.aiRewrite) {
            appendLog(`  ⚠ #${row.index} 标题问题: ${issues.join(', ')}`, 'warn');
          }
          const built = buildV3Item(row, {
            vat: config.vat, currencyCode: config.currency,
            brand: config.brand, defaultStock: config.defaultStock,
          });
          if(!built.ok){ appendLog(`  ✗ #${row.index} ${built.error}`, 'error'); totalFail++; continue; }
          storeItems.push({ row, item: built.item });
          // v2.2.7: stocks 跟 items 同发 (Ozon 原子处理), 默认库存用 defaultStock
          if (whId && (config.defaultStock || 0) > 0) {
            storeStocks.push({
              offer_id: built.item.offer_id,
              stock: config.defaultStock,
              warehouse_id: whId,
            });
          }
        }

        if (!storeItems.length) {
          appendLog(`  — [${storeName}] 没有可上架商品, 跳过`, 'warn');
          continue;
        }

        // v2.2.7: 逐个提交 (Ozon /v3/product/import 一次只接受一个 items 比较稳; 我们的 server 也只接受单 item)
        //   stocks 全部并到每个请求, Ozon 服务端会自动按 offer_id 匹配
        for (const { row, item } of storeItems) {
          try {
            const res = await axios.post('/api/seller/products/import', {
              store_id: storeId,
              item,
              stocks: storeStocks.filter(s => s.offer_id === item.offer_id),  // 只发当前这个 offer 的 stock
            }, { timeout: 60000 });
            const tid = res.data?.task_id || res.data?.data?.result?.task_id || '?';
            // v2.2.0: 不再用 成功/失败 二元标记, 只说"已提交" (Ozon 后台异步审核)
            appendLog(`  ✓ #${row.index} SKU ${row.sku} → 已提交 task_id=${tid}${whId ? ` + stock=${config.defaultStock} → wh=${whId}` : ''}`, 'info');
            // 后台 polling 每 60s 同步 Ozon 真实状态
            totalOk++;
          } catch(e) {
            // v2.2.0: 只有本地校验失败 (商品字段缺失) 才会报错
            // 类目等问题让 Ozon 处理, 不再前端拦截
            const errMsg = e.response?.data?.error || e.message;
            appendLog(`  ✗ #${row.index} SKU ${row.sku} → 提交失败: ${errMsg}`, 'error');
            totalFail++;
          }
        }

        if (storeItems.length && !whId) {
          appendLog(`  ⚠ [${storeName}] 未选仓库, 库存会进默认仓 (用户可去 Ozon 后台手动调)`, 'warn');
        }

        appendLog(`--- [${storeName}] 完成 ---`, 'info');
      }
      appendLog(`\n========== 全部完成: ${totalOk} 提交 Ozon, ${totalFail} 本地校验失败, ${totalSkipped} 未选类目跳过 ==========`, (totalFail||totalSkipped)?'warn':'success');
      publishLoading.value = false;
      // v2.2.3: 上架后给一个明显的"→ 查看上架状态" 入口
      const skipMsg = totalSkipped ? `, ${totalSkipped} 个未选类目已跳过` : '';
      const tip = (totalFail || totalSkipped)
        ? `已提交 ${totalOk} 个到 Ozon${skipMsg} (后台 60s 自动同步真实状态, 去 seller.ozon.ru 后台改类目)`
        : `已提交 ${totalOk} 个到 Ozon。后台 60s 自动同步状态`;
      notify.success({
        message: tip,
        duration: 8000,
        dangerouslyUseHTMLString: true,
        customClass: 'zhumeng-publish-done',
        // v2.2.3: 按钮"查看上架状态" + "继续" 两条出口
        // Element Plus ElNotification 不原生支持按钮, 用 HTML 拼接 + onclick
      });
      // v2.2.3: 在主区日志下方加一条 CTA 条
      const cta = document.createElement('div');
      cta.style.cssText = 'margin-top:12px; padding:14px 18px; background:linear-gradient(90deg,#ecfdf5,#fff); border:1px solid #10b981; border-radius:8px; display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap';
      cta.innerHTML = `
        <div style="font-size:13px; color:#065f46">
          <b>✓ ${totalOk}</b> 个已提交 Ozon · 后台 60s 后同步真实状态
        </div>
        <div style="display:flex; gap:8px">
          <button id="zhumeng-go-listing" style="padding:8px 16px; background:#10b981; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:13px; font-weight:600">📜 查看上架状态</button>
          <button id="zhumeng-stay" style="padding:8px 12px; background:#fff; color:#475569; border:1px solid #cbd5e1; border-radius:6px; cursor:pointer; font-size:13px">留在本页</button>
        </div>`;
      // 挂到日志区域下方
      const logPanel = document.getElementById('batch-log-panel');
      if (logPanel && logPanel.parentElement) {
        logPanel.parentElement.appendChild(cta);
        document.getElementById('zhumeng-go-listing')?.addEventListener('click', () => {
          window.location.hash = '#/listing-history';
          cta.remove();
        });
        document.getElementById('zhumeng-stay')?.addEventListener('click', () => cta.remove());
      }
    };

    // ========== 店铺列表 (保留) ==========
    const fetchStores = async () => {
      try { const res = await axios.get('/api/seller/shops'); allStores.value = res.data.shops||[]; } catch {}
    };

    // v2.2.6: 仓库选择 — 选店铺后自动拉这家店的 FBS 仓库, 每店选一个
    const warehousesByStore = Vue.ref({});  // {storeId: [{warehouse_id, name, status}]}
    const selectedWarehousesByStore = Vue.ref({});  // {storeId: warehouse_id}
    const fetchingWarehouses = Vue.ref({});  // {storeId: true/false}
    const fetchWarehousesForStore = async (storeId) => {
      if (!storeId || warehousesByStore.value[storeId]) return;  // 已有缓存
      fetchingWarehouses.value = { ...fetchingWarehouses.value, [storeId]: true };
      try {
        const res = await axios.get(`/api/seller/warehouses?storeId=${encodeURIComponent(storeId)}`);
        const list = (res.data?.warehouses || []).filter(w => w.status === 'created' && w.is_rfbs);
        warehousesByStore.value = { ...warehousesByStore.value, [storeId]: list };
        // 默认选第一个
        if (!selectedWarehousesByStore.value[storeId] && list.length) {
          selectedWarehousesByStore.value = { ...selectedWarehousesByStore.value, [storeId]: list[0].warehouse_id };
        }
      } catch (e) {
        appendLog(`  ⚠ 拉仓库失败 (${storeId.slice(0,8)}…): ${e.message}`, 'warn');
      } finally {
        fetchingWarehouses.value = { ...fetchingWarehouses.value, [storeId]: false };
      }
    };
    // 选店铺变化时, 自动 fetch 没拉过的仓库
    Vue.watch(selectedStores, async (newStores, oldStores) => {
      const added = (newStores || []).filter(s => !(oldStores || []).includes(s));
      for (const sid of added) await fetchWarehousesForStore(sid);
    }, { deep: true });

    const saveConfig = () => {
      localStorage.setItem('batch_config', JSON.stringify({
        selectedStores: selectedStores.value,
        selectedWarehousesByStore: selectedWarehousesByStore.value,
        ...config,
      }));
    };
    const loadConfig = () => {
      try {
        const s = JSON.parse(localStorage.getItem('batch_config')||'{}');
        Object.assign(config, s);
        if (s.selectedStores) selectedStores.value = s.selectedStores;
        if (s.selectedWarehousesByStore) selectedWarehousesByStore.value = s.selectedWarehousesByStore;
      } catch {}
    };

    const fmtMoney = (v) => '¥'+Number(v||0).toFixed(2);
    const clearAll = () => { pasteText.value=''; items.value=[]; logLines.value=[]; };

    // ========== v2.0 新增: Help drawer / 历史记录 ==========
    const openHelp = () => { helpOpen.value = true; };
    const closeHelp = () => { helpOpen.value = false; };
    const openHistory = () => {
      window.location.hash = '#/listing-history';
    };

    Vue.onMounted(() => { /* 已在插件检测中调用 fetchStores + loadConfig */ });
    window.addEventListener('shop-changed', () => { items.value=[]; });

    // v2.1.1: 调试接口 - ERP 内部 Vue setup 状态机 + 强制触发入口
    //   解决 content-bridge 链路全好, 但 ERP Vue 内部 extensionConnected / selectedStores / items
    //   状态机不对导致不触发采集的疑难. 在 console 直接跑:
    //     __zhumeng_debug()
    //        列出当前所有关键状态
    //     __zhumeng_force_collect(['4425674396'])
    //        直接绕过 Vue 状态机, 强制调 collectViaExtension, 验证链路是否真的通
    window.__zhumeng_debug = () => {
      console.log('🔍 ERP 调试状态:');
      console.log('  extensionConnected.value =', extensionConnected.value);
      console.log('  sellerTabReady.value     =', sellerTabReady.value);
      console.log('  selectedStores.value     =', JSON.stringify(selectedStores.value));
      console.log('  items.length             =', items.value.length);
      console.log('  valid items              =', items.value.filter(r => r.valid).length);
      console.log('  parseLoading.value       =', parseLoading.value);
      console.log('  pasteText.length         =', pasteText.value.length);
      console.log('  Refresh Done. 要强制采集跑: __zhumeng_force_collect(["4425674396"])');
      return {
        ext: extensionConnected.value,
        seller: sellerTabReady.value,
        stores: selectedStores.value,
        items: items.value.length,
        valid: items.value.filter(r => r.valid).length,
        pasteText: pasteText.value.length,
      };
    };
    window.__zhumeng_force_collect = async (skus) => {
      skus = skus || ['4425674396'];
      console.log('🚀 强制采集开始, SKUs=', skus);
      const resp = await collectViaExtension({
        skus,
        storeIds: selectedStores.value.length ? selectedStores.value : ['force-store-id']
      });
      console.log('🚀 强制采集完成:', resp);
      return resp;
    };

    return {
      items, pasteText, parseLoading, publishLoading, logLines,
      selectedStores, allStores, config, FORMAT_LABELS, formatHints,
      extensionConnected, sellerTabReady, refreshing,
      parsePaste, collectSkus, addWatermarkAll, aiRewriteAll, publishBatch,
      fetchStores, saveConfig, loadConfig, fmtMoney, clearAll, appendLog,
      pingExtension, checkSellerStatus, refreshStatus,
      helpOpen, openHelp, closeHelp, openHistory,
      categoryPickerOpen, pickingRow, openCategoryPicker, closeCategoryPicker, applyCategoryChoice,
      candidateSearch, filteredCandidates, categoryStats, applyCategoryHistory,
      pickerFocusIdx, onPickerKeydown,
      warehousesByStore, selectedWarehousesByStore, fetchingWarehouses, fetchWarehousesForStore,
    };
  },
  template: `
    <div class="batch-upload-v2" style="padding:0; background:#f1f5f9; min-height:100vh">

      <!-- ========== 顶部 toolbar ========== -->
      <header class="bu-toolbar" style="background:#fff; padding:14px 24px; box-shadow:0 1px 4px rgba(0,0,0,0.04); display:flex; align-items:center; gap:14px; position:sticky; top:0; z-index:100; flex-wrap:wrap">
        <div style="display:flex; align-items:center; gap:10px">
          <span style="font-size:22px">🚀</span>
          <div>
            <div style="font-size:16px; font-weight:800; color:#0f172a; line-height:1.2">批量跟卖</div>
            <div style="font-size:11px; color:#64748b; line-height:1.2">按 SKU 批采 → V3 跟卖</div>
          </div>
        </div>
        <span style="width:1px; height:24px; background:#e2e8f0"></span>
        <span v-if="extensionConnected && sellerTabReady" style="display:flex; align-items:center; gap:6px; padding:4px 10px; background:#ecfdf5; color:#059669; border-radius:14px; font-size:12px; font-weight:600">
          <span style="width:6px; height:6px; border-radius:50%; background:#10b981"></span>插件已连接
        </span>
        <span v-else-if="extensionConnected && !sellerTabReady" style="display:flex; align-items:center; gap:6px; padding:4px 10px; background:#fffbeb; color:#d97706; border-radius:14px; font-size:12px; font-weight:600">
          <span style="width:6px; height:6px; border-radius:50%; background:#f59e0b"></span>插件已装·待登录 seller
        </span>
        <span v-else style="display:flex; align-items:center; gap:6px; padding:4px 10px; background:#fef2f2; color:#dc2626; border-radius:14px; font-size:12px; font-weight:600">
          <span style="width:6px; height:6px; border-radius:50%; background:#ef4444"></span>插件未安装
        </span>
        <span style="flex:1"></span>
        <button @click="refreshStatus" :loading="refreshing" style="padding:6px 12px; background:#f1f5f9; border:1px solid #cbd5e1; border-radius:6px; color:#475569; cursor:pointer; font-size:13px">🔄 刷新状态</button>
        <button @click="openHelp" style="padding:6px 12px; background:#f1f5f9; border:1px solid #cbd5e1; border-radius:6px; color:#475569; cursor:pointer; font-size:13px">📖 使用说明</button>
        <button @click="openHistory" style="padding:6px 12px; background:#f1f5f9; border:1px solid #cbd5e1; border-radius:6px; color:#475569; cursor:pointer; font-size:13px">📜 历史记录</button>
        <button @click="parsePaste" style="padding:6px 14px; background:#3b82f6; border:none; border-radius:6px; color:#fff; cursor:pointer; font-size:13px; font-weight:600">🔍 解析</button>
        <button @click="collectSkus" :loading="parseLoading" :disabled="!items.filter(r=>r.valid).length" style="padding:6px 14px; background:#f59e0b; border:none; border-radius:6px; color:#fff; cursor:pointer; font-size:13px; font-weight:600">📡 采集 ({{ items.filter(r=>r.valid).length }})</button>
        <button @click="publishBatch" :loading="publishLoading" :disabled="!items.filter(r=>r.valid&&r.distilled).length || !!items.filter(r=>r.valid&&r.distilled&&r._category_resolved&&r._category_resolved.confidence==='none'&&!r._category_resolved.to).length" style="padding:8px 18px; background:linear-gradient(135deg,#10b981,#059669); border:none; border-radius:8px; color:#fff; cursor:pointer; font-size:14px; font-weight:700; box-shadow:0 2px 6px rgba(16,185,129,0.3)">🚀 开始批采 + 上架 ({{ items.filter(r=>r.valid&&r.distilled&&r._category_resolved&&r._category_resolved.confidence!=='none').length }})</button>
      </header>

      <main class="bu-body" style="display:grid; grid-template-columns:1fr 360px; gap:16px; padding:20px; align-items:start">

        <!-- ========== 左列 ========== -->
        <div class="bu-col-main" style="display:flex; flex-direction:column; gap:16px">

          <!-- 粘贴批量数据 -->
          <section class="bu-card" style="background:#fff; border-radius:10px; box-shadow:0 1px 3px rgba(0,0,0,0.05); overflow:hidden">
            <div style="padding:14px 20px; border-bottom:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center; background:linear-gradient(90deg,#f8fafc,#fff)">
              <div style="display:flex; align-items:center; gap:8px; font-weight:700; font-size:14px; color:#0f172a">
                <span>📋 粘贴批量数据</span>
                <span v-if="items.length" style="padding:2px 8px; background:#dbeafe; color:#1e40af; border-radius:10px; font-size:11px">{{ items.filter(r=>r.valid).length }} / {{ items.length }} 有效</span>
              </div>
              <button @click="clearAll" style="background:transparent; border:none; color:#64748b; cursor:pointer; font-size:12px">🗑️ 清空</button>
            </div>
            <div style="padding:16px 20px; display:grid; grid-template-columns:1fr 280px; gap:16px">
              <div style="display:flex; flex-direction:column; gap:6px; min-width:0; height:100%">
                <textarea v-model="pasteText" class="bu-paste-area" spellcheck="false" placeholder="每行一条，格式如下：
1234567890,99.9
1234567890,99.9,JZ-001
1234567890,99.9,150,200,180,80
1234567890,99.9,JZ-001,200,300,250,120
1234567890,99.9,~75" style="width:100%; flex:1; min-height:160px; padding:12px; border:1px solid #e2e8f0; border-radius:8px; font-family:'SF Mono',Monaco,monospace; font-size:13px; resize:vertical; outline:none"></textarea>
                <div style="font-size:11px; color:#94a3b8; line-height:1.5">
                  粘贴 SKU + 价格 → 解析 → 采集 → 上架 · 支持 10 种格式, 每行一条
                </div>
              </div>
              <div style="background:#f8fafc; border-radius:8px; padding:12px; border:1px solid #e2e8f0">
                <div style="font-size:12px; font-weight:700; color:#475569; margin-bottom:8px">📐 10 种格式</div>
                <ol style="list-style:none; padding:0; margin:0; font-size:11px; color:#334155; line-height:1.6">
                  <li v-for="f in formatHints" :key="f.n" style="display:flex; gap:6px; padding:1px 0">
                    <span style="display:inline-block; min-width:18px; height:18px; line-height:18px; text-align:center; background:#3b82f6; color:#fff; border-radius:9px; font-weight:700">{{ f.n }}</span>
                    <span><b>{{ f.req }}</b><span v-if="f.opt" style="color:#64748b">{{ f.opt }}</span></span>
                  </li>
                </ol>
                <div style="margin-top:8px; padding-top:8px; border-top:1px dashed #cbd5e1; font-size:10px; color:#94a3b8; line-height:1.5">
                  分隔符: <code>,</code> <code>，</code> <code>Tab</code> <code>2空格</code><br>
                  <code>~</code> 前缀 = 最低价
                </div>
              </div>
            </div>
          </section>

          <!-- 解析预览 -->
          <section v-if="items.length" class="bu-card" style="background:#fff; border-radius:10px; box-shadow:0 1px 3px rgba(0,0,0,0.05); overflow:hidden">
            <div style="padding:14px 20px; border-bottom:1px solid #f1f5f9; font-weight:700; font-size:14px; color:#0f172a; background:linear-gradient(90deg,#f8fafc,#fff)">
              📊 解析预览 ({{ items.length }} 行)
            </div>
            <div style="overflow-x:auto">
              <table style="width:100%; border-collapse:collapse; font-size:13px">
                <thead>
                  <tr style="background:#f8fafc; color:#475569; font-weight:700; font-size:11px; text-transform:uppercase">
                    <th style="padding:10px 12px; text-align:left; width:50px">#</th>
                    <th style="padding:10px 12px; text-align:left">SKU</th>
                    <th style="padding:10px 12px; text-align:right">售价</th>
                    <th style="padding:10px 12px; text-align:left">货号</th>
                    <th style="padding:10px 12px; text-align:right">重量g</th>
                    <th style="padding:10px 12px; text-align:right">三维 L×W×H</th>
                    <th style="padding:10px 12px; text-align:left">格式</th>
                    <th style="padding:10px 12px; text-align:left; min-width:200px">类目 (含自动 type_id)</th>
                    <th style="padding:10px 12px; text-align:left">问题/状态</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in items" :key="row.index" style="border-top:1px solid #f1f5f9" :style="{ background: !row.valid ? '#fef2f2' : (row.distilled ? '#f0fdf4' : '') }">
                    <td style="padding:10px 12px; color:#64748b">{{ row.index }}</td>
                    <td style="padding:10px 12px"><code style="background:#f1f5f9; padding:2px 6px; border-radius:3px; font-size:12px">{{ row.sku }}</code></td>
                    <td style="padding:10px 12px; text-align:right; font-weight:600">{{ fmtMoney(row.price) }}</td>
                    <td style="padding:10px 12px; color:#475569">{{ row.offerId || '-' }}</td>
                    <td style="padding:10px 12px; text-align:right">{{ row.weightG || '-' }}</td>
                    <td style="padding:10px 12px; text-align:right; color:#475569; font-size:12px">
                      <span v-if="row.lengthMm || row.widthMm || row.heightMm">{{ row.lengthMm || '?' }}×{{ row.widthMm || '?' }}×{{ row.heightMm || '?' }}</span>
                      <span v-else>-</span>
                    </td>
                    <td style="padding:10px 12px">
                      <span :style="{ padding:'2px 8px', borderRadius:'10px', fontSize:'10px', fontWeight:600, background: row.valid ? '#dbeafe' : '#fee2e2', color: row.valid ? '#1e40af' : '#991b1b' }">{{ FORMAT_LABELS[row.formatHint] || '?' }}</span>
                    </td>
                    <td style="padding:10px 12px; font-size:12px">
                      <!-- v2.2.5: type_id 折叠进类目 cell, 用户完全不感知. 选完类目后自动反查 type_id -->
                      <input v-if="false" v-model="row.typeIdInput" @change="saveTypeIdCache(row)" :placeholder="row.distilled?.typeId ? String(row.distilled.typeId) : '必填'" style="width:90px; padding:4px 6px; border:1px solid #cbd5e1; border-radius:4px; font-size:12px; font-family:monospace; text-align:right" />
                    </td>
                    <td style="padding:10px 12px; font-size:12px; min-width:200px">
                      <!-- v2.2.2: 类目置信度列 (含 type_id 自动反查结果显示) — high/medium/none/manual -->
                      <template v-if="row._category_resolved">
                        <div v-if="row._category_resolved.confidence === 'high'" style="display:flex; flex-direction:column; gap:2px">
                          <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap">
                            <span style="display:inline-flex; align-items:center; gap:4px; padding:2px 8px; background:#dcfce7; color:#166534; border-radius:10px; font-size:11px; font-weight:600">✓ 高置信</span>
                            <span style="color:#475569; font-size:11px">cat {{ row._category_resolved.to }}</span>
                            <span v-if="row.distilled?.typeId" style="color:#94a3b8; font-size:10px; font-family:monospace">type {{ row.distilled.typeId }}</span>
                          </div>
                          <span style="color:#94a3b8; font-size:10px">{{ row._category_resolved.source }}</span>
                        </div>
                        <div v-else-if="row._category_resolved.confidence === 'medium'" style="display:flex; flex-direction:column; gap:2px">
                          <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap">
                            <span style="display:inline-flex; align-items:center; gap:4px; padding:2px 8px; background:#fef3c7; color:#92400e; border-radius:10px; font-size:11px; font-weight:600">⚠ 中置信</span>
                            <span style="color:#475569; font-size:11px">cat {{ row._category_resolved.to }}</span>
                            <span v-if="row.distilled?.typeId" style="color:#94a3b8; font-size:10px; font-family:monospace">type {{ row.distilled.typeId }}</span>
                          </div>
                          <button v-if="(row._category_resolved.candidates || []).length" @click="openCategoryPicker(row)" style="background:transparent; border:none; color:#2563eb; cursor:pointer; font-size:11px; padding:0; text-align:left">↻ 换一个</button>
                        </div>
                        <div v-else-if="row._category_resolved.confidence === 'manual'" style="display:flex; flex-direction:column; gap:2px">
                          <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap">
                            <span style="display:inline-flex; align-items:center; gap:4px; padding:2px 8px; background:#dbeafe; color:#1e40af; border-radius:10px; font-size:11px; font-weight:600">✓ 已选</span>
                            <span style="color:#475569; font-size:11px; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">{{ row.distilled?.descriptionCategoryName || ('cat ' + row._category_resolved.to) }}</span>
                            <span v-if="row.distilled?.typeId" style="color:#94a3b8; font-size:10px; font-family:monospace">type {{ row.distilled.typeId }}</span>
                          </div>
                          <button v-if="(row._category_resolved.candidates || []).length" @click="openCategoryPicker(row)" style="background:transparent; border:none; color:#2563eb; cursor:pointer; font-size:11px; padding:0; text-align:left">↻ 换一个</button>
                        </div>
                        <div v-else style="display:flex; flex-direction:column; gap:4px">
                          <span style="display:inline-flex; align-items:center; gap:4px; padding:2px 8px; background:#fee2e2; color:#991b1b; border-radius:10px; font-size:11px; font-weight:600; width:fit-content">⚠ 未解析</span>
                          <button @click="openCategoryPicker(row)" :disabled="!(row._category_resolved.candidates || []).length" style="padding:4px 10px; background:(row._category_resolved.candidates||[]).length ? '#f59e0b' : '#cbd5e1'; border:none; border-radius:5px; color:#fff; cursor:pointer; font-size:11px; font-weight:600; width:fit-content">
                            {{ (row._category_resolved.candidates || []).length ? '选类目 (' + (row._category_resolved.candidates || []).length + ')' : '无候选' }}
                          </button>
                          <span v-if="!row._category_resolved.candidates?.length" style="color:#94a3b8; font-size:10px">上架时去 Ozon 后台选</span>
                        </div>
                      </template>
                      <span v-else-if="row.distilled" style="color:#94a3b8; font-size:11px">采集时未调解析</span>
                      <span v-else style="color:#cbd5e1; font-size:11px">-</span>
                    </td>
                    <td style="padding:10px 12px; color:#64748b; font-size:12px">
                      <span v-if="row.distilled" style="color:#059669; font-weight:600">✓ 已采</span>
                      <span v-else-if="!row.valid" style="color:#dc2626">{{ row.reason }}</span>
                      <span v-else-if="row._collectError" style="color:#dc2626">{{ row._collectError }}</span>
                      <span v-else style="color:#94a3b8">待采</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <!-- v2.2.2: 类目状态概览 (采集后自动出现) -->
          <section v-if="categoryStats.total > 0" class="bu-card" style="background:#fff; border-radius:10px; box-shadow:0 1px 3px rgba(0,0,0,0.05); padding:14px 20px">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap">
              <div style="display:flex; align-items:center; gap:6px; font-weight:700; font-size:13px; color:#0f172a">
                🎯 类目状态
                <span style="font-size:11px; color:#94a3b8; font-weight:500">共 {{ categoryStats.total }} 件已采商品</span>
              </div>
              <div style="display:flex; gap:8px; flex-wrap:wrap; font-size:12px">
                <span style="padding:4px 10px; background:#dcfce7; color:#166534; border-radius:10px; font-weight:600">✓ 高 {{ categoryStats.high }}</span>
                <span style="padding:4px 10px; background:#fef3c7; color:#92400e; border-radius:10px; font-weight:600">⚠ 中 {{ categoryStats.medium }}</span>
                <span style="padding:4px 10px; background:#dbeafe; color:#1e40af; border-radius:10px; font-weight:600">👆 已选 {{ categoryStats.manual }}</span>
                <span :style="{ padding:'4px 10px', borderRadius:'10px', fontWeight:600, background: categoryStats.none ? '#fee2e2' : '#f1f5f9', color: categoryStats.none ? '#991b1b' : '#94a3b8' }">⚠ 未选 {{ categoryStats.none }}</span>
                <span v-if="categoryStats.pending" style="padding:4px 10px; background:#f1f5f9; color:#64748b; border-radius:10px; font-weight:600">? 待解析 {{ categoryStats.pending }}</span>
              </div>
            </div>
            <div v-if="categoryStats.none > 0" style="margin-top:10px; padding:8px 12px; background:#fef3c7; color:#92400e; border-radius:6px; font-size:12px">
              ⚠ 还有 {{ categoryStats.none }} 件商品未自动解析类目, 点击表格"⚠ 未解析"行的"选类目"按钮手动选 (提交后还能去 Ozon 后台改).
            </div>
          </section>

          <!-- 实时日志 -->
          <section v-if="logLines.length" class="bu-card" style="background:#1e293b; border-radius:10px; box-shadow:0 1px 3px rgba(0,0,0,0.05); overflow:hidden; position:sticky; bottom:0">
            <div style="padding:12px 20px; border-bottom:1px solid #334155; display:flex; justify-content:space-between; align-items:center">
              <div style="font-weight:700; font-size:13px; color:#e2e8f0">📜 实时日志</div>
              <button @click="logLines=[]" style="background:transparent; border:none; color:#94a3b8; cursor:pointer; font-size:12px">🗑️ 清空</button>
            </div>
            <div id="batch-log-panel" style="max-height:400px; overflow-y:auto; padding:12px 20px; font-family:'SF Mono',Monaco,monospace; font-size:12px; line-height:1.6">
              <div v-for="(log, i) in logLines" :key="i" :style="{ color: log.type==='success' ? '#4ade80' : log.type==='error' ? '#f87171' : log.type==='warn' ? '#fbbf24' : '#94a3b8' }">
                <span style="color:#64748b">{{ log.ts }}</span> {{ log.text }}
              </div>
            </div>
          </section>

        </div>

        <!-- ========== 右栏配置 ========== -->
        <aside class="bu-rail" style="display:flex; flex-direction:column; gap:16px; position:sticky; top:80px">

          <!-- 店铺与基础 -->
          <section class="bu-card" style="background:#fff; border-radius:10px; box-shadow:0 1px 3px rgba(0,0,0,0.05); overflow:hidden">
            <div style="padding:12px 20px; border-bottom:1px solid #f1f5f9; background:linear-gradient(90deg,#eff6ff,#fff)">
              <div style="display:flex; justify-content:space-between; align-items:center">
                <div style="font-weight:700; font-size:13px; color:#0f172a">🏪 店铺与基础</div>
                <div style="font-size:10px; color:#64748b">支持多店扇出</div>
              </div>
            </div>
            <div style="padding:14px 20px; display:flex; flex-direction:column; gap:12px">
              <div>
                <div style="font-size:12px; color:#64748b; margin-bottom:4px; font-weight:600"><span style="color:#dc2626">*</span> 目标店铺 (多选)</div>
                <el-select v-model="selectedStores" multiple filterable size="small" style="width:100%" placeholder="选择要上架的店铺" @change="saveConfig">
                  <el-option v-for="s in allStores" :key="s.id" :label="s.name" :value="s.id" />
                </el-select>
              </div>
              <!-- v2.2.6: 选店铺后自动拉仓库, 每店一个仓库 (像 MY ERP) -->
              <div v-if="selectedStores.length" style="background:#f0f9ff; border:1px solid #bae6fd; border-radius:8px; padding:10px 12px; margin-top:-4px">
                <div style="font-size:12px; color:#0c4a6e; font-weight:600; margin-bottom:6px; display:flex; align-items:center; gap:6px">
                  📦 目标仓库
                  <span style="font-size:10px; font-weight:400; color:#64748b">(每店一个, 自动拉取 FBS)</span>
                </div>
                <div v-for="storeId in selectedStores" :key="storeId" style="display:flex; align-items:center; gap:6px; margin-bottom:4px; font-size:11px">
                  <span style="min-width:80px; color:#475569; font-weight:600">{{ allStores.find(s=>s.id===storeId)?.name || storeId.slice(0,8) }}</span>
                  <el-select
                    v-model="selectedWarehousesByStore[storeId]"
                    size="small"
                    style="flex:1"
                    :loading="fetchingWarehouses[storeId]"
                    :no-data-text="fetchingWarehouses[storeId] ? '拉取中…' : '该店无可用 FBS 仓库'"
                    placeholder="选仓库"
                    @change="saveConfig">
                    <el-option
                      v-for="w in (warehousesByStore[storeId] || [])"
                      :key="w.warehouse_id"
                      :label="w.name"
                      :value="w.warehouse_id" />
                  </el-select>
                  <span v-if="!(warehousesByStore[storeId] || []).length && !fetchingWarehouses[storeId]" style="color:#dc2626; font-size:10px">⚠ 无</span>
                </div>
              </div>
              <div>
                <div style="font-size:12px; color:#64748b; margin-bottom:4px; font-weight:600"><span style="color:#dc2626">*</span> 品牌</div>
                <el-select v-model="config.brand" size="small" style="width:100%" @change="saveConfig">
                  <el-option label="无品牌" value="no_brand" />
                  <el-option label="复制源品牌" value="copy" />
                </el-select>
              </div>
              <div>
                <div style="font-size:12px; color:#64748b; margin-bottom:4px; font-weight:600">图片顺序</div>
                <el-select v-model="config.imageOrder" size="small" style="width:100%" @change="saveConfig">
                  <el-option label="不处理" value="keep" />
                  <el-option label="随机打乱" value="shuffle" />
                  <el-option label="主图不变其余打乱" value="keep_primary" />
                </el-select>
              </div>
              <div>
                <div style="font-size:12px; color:#64748b; margin-bottom:4px; font-weight:600">货币</div>
                <el-select v-model="config.currency" size="small" style="width:100%" @change="saveConfig">
                  <el-option label="¥ CNY 人民币" value="CNY" />
                  <el-option label="₽ RUB 卢布" value="RUB" />
                  <el-option label="$ USD 美元" value="USD" />
                  <el-option label="€ EUR 欧元" value="EUR" />
                </el-select>
              </div>
              <div>
                <div style="font-size:12px; color:#64748b; margin-bottom:4px; font-weight:600">默认库存</div>
                <el-input-number v-model="config.defaultStock" :min="0" size="small" style="width:100%" @change="saveConfig" />
                <div style="font-size:10px; color:#94a3b8; margin-top:3px">0 = 不挂库存</div>
              </div>
            </div>
          </section>

          <!-- AI 增强 (v2.0: 去掉改图/视频, 只保留水印/AI 重写) -->
          <section class="bu-card" style="background:#fff; border-radius:10px; box-shadow:0 1px 3px rgba(0,0,0,0.05); overflow:hidden">
            <div style="padding:12px 20px; border-bottom:1px solid #f1f5f9; background:linear-gradient(90deg,#faf5ff,#fff)">
              <div style="display:flex; justify-content:space-between; align-items:center">
                <div style="font-weight:700; font-size:13px; color:#0f172a">✨ AI 增强</div>
                <div style="font-size:10px; color:#64748b">未启用都可发布</div>
              </div>
            </div>
            <div style="padding:8px 20px">
              <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #f8fafc">
                <div>
                  <div style="font-size:13px; font-weight:600; color:#0f172a">💧 水印/边框</div>
                  <div style="font-size:10px; color:#94a3b8">免费</div>
                </div>
                <el-switch v-model="config.watermark" @change="saveConfig" />
              </div>
              <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0">
                <div>
                  <div style="font-size:13px; font-weight:600; color:#0f172a">✨ AI 重写</div>
                  <div style="font-size:10px; color:#94a3b8">翻译+SEO 优化标题/描述</div>
                </div>
                <el-switch v-model="config.aiRewrite" @change="saveConfig" />
              </div>
            </div>
          </section>
        </aside>
      </main>

      <!-- ========== Help drawer ========== -->
      <transition name="bu-fade">
        <div v-if="helpOpen" @click="closeHelp" style="position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(15,23,42,0.5); z-index:200"></div>
      </transition>
      <transition name="bu-slide">
        <aside v-if="helpOpen" style="position:fixed; top:0; right:0; bottom:0; width:480px; max-width:90vw; background:#fff; box-shadow:-4px 0 24px rgba(0,0,0,0.15); z-index:201; display:flex; flex-direction:column">
          <div style="padding:18px 24px; border-bottom:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center">
            <div style="font-weight:700; font-size:16px; color:#0f172a">📖 批量上架 · 使用说明</div>
            <button @click="closeHelp" style="background:transparent; border:none; font-size:24px; color:#64748b; cursor:pointer; padding:0; width:32px; height:32px; line-height:1">×</button>
          </div>
          <div style="flex:1; overflow-y:auto; padding:20px 24px">
            <div style="display:flex; gap:14px; margin-bottom:20px; padding:14px; background:#eff6ff; border-radius:8px; border:1px solid #bfdbfe">
              <div style="flex-shrink:0; width:28px; height:28px; background:#3b82f6; color:#fff; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:700">1</div>
              <div>
                <div style="font-weight:700; font-size:13px; color:#0f172a; margin-bottom:4px">登录 Ozon 卖家中心</div>
                <p style="font-size:12px; color:#475569; line-height:1.6; margin:0">在浏览器里打开 <code style="background:#fff; padding:1px 5px; border-radius:3px; font-size:11px">seller.ozon.ru</code> 任意页面并保持登录,别关。我们用你的登录态抓数据。</p>
              </div>
            </div>
            <div style="display:flex; gap:14px; margin-bottom:20px; padding:14px; background:#eff6ff; border-radius:8px; border:1px solid #bfdbfe">
              <div style="flex-shrink:0; width:28px; height:28px; background:#3b82f6; color:#fff; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:700">2</div>
              <div>
                <div style="font-weight:700; font-size:13px; color:#0f172a; margin-bottom:4px">粘贴 SKU + 价格</div>
                <p style="font-size:12px; color:#475569; line-height:1.6; margin:0">每行一条,最简只要 <b>SKU + 售价</b> 两列:</p>
                <pre style="background:#0f172a; color:#e2e8f0; padding:10px 12px; border-radius:6px; font-size:11px; line-height:1.5; margin:8px 0 0 0; overflow-x:auto">1234567890,99.9
1234567890,99.9,JZ-001
1234567890,99.9,150,200,180,80</pre>
                <p style="font-size:11px; color:#64748b; line-height:1.5; margin:8px 0 0 0"><b>SKU 在哪找?</b> Ozon 商品页 URL <code style="background:#fff; padding:1px 4px; border-radius:3px; font-size:10px">ozon.ru/product/<em>123456789</em></code> 末尾那串数字就是。其他字段会自动从 Ozon 公开页抓。</p>
              </div>
            </div>
            <div style="display:flex; gap:14px; margin-bottom:24px; padding:14px; background:#eff6ff; border-radius:8px; border:1px solid #bfdbfe">
              <div style="flex-shrink:0; width:28px; height:28px; background:#3b82f6; color:#fff; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:700">3</div>
              <div>
                <div style="font-weight:700; font-size:13px; color:#0f172a; margin-bottom:4px">选店铺 → 一键提交</div>
                <ul style="font-size:12px; color:#475569; line-height:1.7; margin:0; padding-left:18px">
                  <li>「目标店铺」点击多选,支持搜索</li>
                  <li>品牌 / 图片顺序 / 货币用默认值即可</li>
                  <li>点「开始批采 + 上架」,结果在下方进度面板逐条显示</li>
                </ul>
              </div>
            </div>

            <div style="margin-top:24px; padding-top:20px; border-top:1px solid #e2e8f0">
              <div style="font-weight:700; font-size:13px; color:#0f172a; margin-bottom:10px">📦 数据源</div>
              <ul style="font-size:12px; color:#475569; line-height:1.7; margin:0; padding-left:18px">
                <li><b>主源</b>:ozon.ru 公开商品页 → 商品名、图片、面包屑、属性</li>
                <li><b>辅源</b>:Ozon Seller API → 你卖过的同款,复用属性 (阶段 2 上线)</li>
              </ul>
              <p style="font-size:11px; color:#94a3b8; margin:8px 0 0 0">任一源命中就能上架。新 SKU 完全没卖过也能正常工作。</p>
            </div>

            <div style="margin-top:24px; padding-top:20px; border-top:1px solid #e2e8f0">
              <div style="font-weight:700; font-size:13px; color:#0f172a; margin-bottom:10px">❓ 常见问题</div>
              <dl style="margin:0; font-size:12px">
                <div style="margin-bottom:12px">
                  <dt style="font-weight:600; color:#0f172a; margin-bottom:3px">「插件未连接」</dt>
                  <dd style="color:#64748b; margin:0; padding-left:12px">检查 chrome://extensions 是否已加载 v1.0.9+</dd>
                </div>
                <div style="margin-bottom:12px">
                  <dt style="font-weight:600; color:#0f172a; margin-bottom:3px">「采集失败 403 / 404」</dt>
                  <dd style="color:#64748b; margin:0; padding-left:12px">Ozon 反爬触发,或 SKU 已下架。换个 SKU 或稍后再试。</dd>
                </div>
                <div style="margin-bottom:12px">
                  <dt style="font-weight:600; color:#0f172a; margin-bottom:3px">「标题/货号/类目ID不能为空」</dt>
                  <dd style="color:#64748b; margin:0; padding-left:12px">说明该 SKU 在 Ozon 没拿到完整数据,采集日志里找具体原因</dd>
                </div>
                <div style="margin-bottom:12px">
                  <dt style="font-weight:600; color:#0f172a; margin-bottom:3px">单批最多多少条?</dt>
                  <dd style="color:#64748b; margin:0; padding-left:12px">Ozon 后端限制单批 ≤200 条,超过请分批</dd>
                </div>
                <div>
                  <dt style="font-weight:600; color:#0f172a; margin-bottom:3px">想批量上库存?</dt>
                  <dd style="color:#64748b; margin:0; padding-left:12px">本页默认 0 库存,请单独走 MY ERP「商品列表 → 库存导入」</dd>
                </div>
              </dl>
            </div>
          </div>
        </aside>
      </transition>
    </div>

    <!-- v2.2.2: 候选类目选择 modal (keyboard UX: ↑↓ Enter Esc) -->
    <transition name="bu-fade">
      <div v-if="categoryPickerOpen && pickingRow" @click.self="closeCategoryPicker" tabindex="-1" @keydown="onPickerKeydown" style="position:fixed; inset:0; background:rgba(15,23,42,0.5); z-index:1000; display:flex; align-items:center; justify-content:center; padding:20px">
        <div style="background:#fff; border-radius:12px; max-width:640px; width:100%; max-height:80vh; overflow:hidden; box-shadow:0 20px 50px rgba(0,0,0,0.25); display:flex; flex-direction:column" ref="pickerModalEl">
          <div style="padding:16px 20px; border-bottom:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center; background:linear-gradient(90deg,#fffbeb,#fff)">
            <div>
              <div style="font-size:15px; font-weight:700; color:#0f172a">🎯 选类目 — #{{ pickingRow.index }} {{ pickingRow.sku }}</div>
              <div style="font-size:11px; color:#64748b; margin-top:2px">{{ pickingRow.distilled?.name || pickingRow._category_resolved?.warning || '选一个 candidate 给这个商品' }}</div>
            </div>
            <button @click="closeCategoryPicker" style="background:transparent; border:none; font-size:18px; color:#94a3b8; cursor:pointer; padding:4px 8px">✕</button>
          </div>
          <div v-if="(pickingRow._category_resolved?.candidates || []).length > 3" style="padding:10px 20px 0">
            <input v-model="candidateSearch" placeholder="🔍 按名称或 cat id 过滤 (如 'фонарь' 或 '17028')" style="width:100%; padding:8px 12px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px; outline:none" />
          </div>
          <div style="overflow-y:auto; padding:14px 20px; display:flex; flex-direction:column; gap:8px">
            <div v-if="!pickingRow._category_resolved?.candidates?.length" style="padding:40px 20px; text-align:center; color:#94a3b8">
              <div style="font-size:32px; margin-bottom:8px">📭</div>
              <div style="font-size:13px">没有候选类目 (店铺还没有任何已上架商品可参考)</div>
              <div style="font-size:11px; margin-top:4px">直接提交后去 Ozon 后台选</div>
            </div>
            <div v-else-if="!filteredCandidates.length" style="padding:30px 20px; text-align:center; color:#94a3b8">
              <div style="font-size:13px">没有匹配 "{{ candidateSearch }}" 的候选</div>
              <div style="font-size:11px; margin-top:4px">共 {{ (pickingRow._category_resolved?.candidates || []).length }} 个候选</div>
            </div>
            <div v-for="(c, i) in filteredCandidates" :key="c.description_category_id" @click="applyCategoryChoice(c)" @mouseenter="pickerFocusIdx = i" style="display:flex; align-items:center; gap:12px; padding:12px 14px; border:2px solid; border-radius:8px; cursor:pointer; transition:all 0.1s"
                 :style="{ background: i === pickerFocusIdx ? '#fef3c7' : '#fff', borderColor: i === pickerFocusIdx ? '#f59e0b' : '#e2e8f0' }">
              <div style="flex:1; min-width:0">
                <div style="font-size:13px; font-weight:600; color:#0f172a; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">{{ c.name || '(无名)' }}</div>
                <div style="font-size:11px; color:#64748b; font-family:monospace; margin-top:2px">cat {{ c.description_category_id }}</div>
              </div>
              <div style="display:flex; flex-direction:column; align-items:flex-end; gap:2px">
                <span style="padding:3px 8px; background:#dbeafe; color:#1e40af; border-radius:10px; font-size:11px; font-weight:600">📊 {{ c.count || 0 }} 件</span>
                <span style="font-size:10px; color:#94a3b8">店铺历史频率</span>
              </div>
            </div>
          </div>
          <div style="padding:10px 20px; border-top:1px solid #f1f5f9; background:#f8fafc; font-size:11px; color:#64748b; display:flex; justify-content:space-between; align-items:center">
            <span>提示: ↑↓ 移动焦点 · Enter 选中 · Esc 关闭 · 选错 Ozon 后台还能改</span>
            <button @click="closeCategoryPicker" style="padding:4px 12px; background:#f1f5f9; border:1px solid #cbd5e1; border-radius:5px; cursor:pointer; color:#475569">关闭</button>
          </div>
        </div>
      </div>
    </transition>

    <!-- 样式已挪到文件顶部 IIFE 注入, Vue runtime template 不允许 <style> 标签 -->
  `
};

// v2.1.1: Vue runtime template 不允许 <script> / <style> 标签, 原写在 template 里的样式
//   (fade + slide 过渡) 移到 IIFE 直接注入 document.head
(function injectBatchUploadStyles() {
  if (typeof document === 'undefined' || document.head.querySelector('style[data-batchupload-v2]')) return;
  const css = [
    '.batch-upload-v2 .bu-fade-enter-active, .batch-upload-v2 .bu-fade-leave-active { transition: opacity 0.2s; }',
    '.batch-upload-v2 .bu-fade-enter-from, .batch-upload-v2 .bu-fade-leave-to { opacity: 0; }',
    '.batch-upload-v2 .bu-slide-enter-active, .batch-upload-v2 .bu-slide-leave-active { transition: transform 0.3s; }',
    '.batch-upload-v2 .bu-slide-enter-from, .batch-upload-v2 .bu-slide-leave-to { transform: translateX(100%); }',
  ].join('\n');
  const el = document.createElement('style');
  el.setAttribute('data-batchupload-v2', 'true');
  el.textContent = css;
  document.head.appendChild(el);
})();
