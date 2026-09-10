/**
 * 逐梦 Ozon 采集器 - Service Worker v1.0.7
 *
 * v1.0.7 重大改动 (采集策略重写):
 *   - 不再调 seller.ozon.ru 后台 API (会 403 PermissionDenied)
 *   - 改用: 打开 https://www.ozon.ru/product/<sku>/ 商品前端页, 用 executeScript 注入函数提取 DOM 数据
 *   - Ozon 商品前端页是公开的, 不需要登录
 *   - 关闭 tab 用完后立即关
 *
 * v1.0.4-1.0.6 改动保留:
 *   - 详细 console.log
 *   - diagnose action
 */

const VERSION = "2.2.9.118";
const OZON_FRONTEND_ORIGIN = "https://www.ozon.ru";
const OZON_PRODUCT_URL = (sku) => `https://www.ozon.ru/product/${sku}/`;
const OPI_BASE_URL = "https://api-seller.ozon.ru";
const ERP_BACKEND_ORIGIN = "https://test.renwz.cn";  // ERP 后端 (拿凭证)
const MTOP_URL = "https://h5api.m.1688.com/h5/mtop.relationrecommend.wirelessrecommend.recommend/2.0/";
const MTOP_APP_KEY = "12574478";
const WORKER_NAME = `zhumeng-plugin-${chrome.runtime.id.slice(0, 8)}`;
let sourcingBusy = false;
let sourcingQueueLoopStarted = false;
let quickPollToken = 0;
let workerAuthToken = "";
let imageSearchQueue = Promise.resolve();
let last1688SearchAt = 0;
let last1688FailureAt = 0;
const active1688TabIds = new Set();
const ACTIVE_SOURCING_JOB_KEY = "activeSourcingJob";
const ACTIVE_SOURCING_JOB_TTL_MS = 6 * 60 * 1000;
// v2.2.9.63+: 自适应风控窗口，记录最近 60s 内的失败/验证码事件数
let riskWindow = [];
const RISK_WINDOW_MS = 60_000;
const CRITICAL_RISK_HOLD_MS = 5 * 60_000;
let criticalRiskHoldUntil = 0;
function pushRiskEvent(isCritical) {
  const now = Date.now();
  riskWindow.push({ at: now, critical: !!isCritical });
  riskWindow = riskWindow.filter((entry) => now - entry.at <= RISK_WINDOW_MS);
  if (isCritical) {
    criticalRiskHoldUntil = Math.max(criticalRiskHoldUntil, now + CRITICAL_RISK_HOLD_MS);
    console.warn(`[SW ${VERSION}] 1688 触发风控关键字，进入 5 分钟任务暂停`);
  }
}
function adaptiveCooldownMs() {
  const now = Date.now();
  if (now < criticalRiskHoldUntil) return Math.max(45_000, criticalRiskHoldUntil - now + randomInt(0, 30_000));
  const active = riskWindow.filter((entry) => now - entry.at <= RISK_WINDOW_MS);
  const f60 = active.length;
  const fCritical = active.filter((entry) => entry.critical).length;
  if (fCritical > 0) return randomInt(120_000, 180_000);
  if (f60 >= 3) return randomInt(60_000, 90_000);
  if (f60 === 2) return randomInt(30_000, 50_000);
  if (f60 === 1) return randomInt(20_000, 35_000);
  return randomInt(12_000, 22_000);  // v2.2.9.62 仅 7-14s 太频繁，调慢
}
function clear1688Success() {
  if (riskWindow.length) {
    console.log(`[SW ${VERSION}] 1688 成功清零风险窗口，前 ${riskWindow.length} 个事件已通过`);
  }
  riskWindow = [];
  criticalRiskHoldUntil = 0;
  last1688FailureAt = 0;
}

function markSourcingCanceled(job, message = "收到停止请求，正在中断当前采集步骤。") {
  if (!job || job.cancelRequested) return;
  job.cancelRequested = true;
  if (job.abortController && !job.abortController.signal?.aborted) {
    try { job.abortController.abort(); } catch (_) {}
  }
  if (job.stepAbortController && !job.stepAbortController.signal?.aborted) {
    try { job.stepAbortController.abort(); } catch (_) {}
  }
  if (Array.isArray(job.logs)) job.logs.push(makeLog(message, "warn"));
  closeActive1688TabsInPlugin().catch((error) => console.warn(`[SW ${VERSION}] 关闭 1688 临时页失败: ${error.message || error}`));
}

function assertSourcingNotCanceled(job) {
  if (job?.cancelRequested || job?.abortController?.signal?.aborted) {
    throw new Error("任务已停止");
  }
  if (job?.stepAbortController?.signal?.aborted) {
    throw new Error("当前步骤超时，已中断");
  }
}

function getSourcingAbortSignal(job) {
  return job?.stepAbortController?.signal || job?.abortController?.signal;
}

// v2.2.9.101 (fix): 1688 接口 fetch 必须带硬超时 —— 步骤超时 abort 依赖 stepAbortController，
//   但部分流程（队列等待/详情页 executeScript）不受 abort 中断，1688 接口挂起时任务会永久卡住。
//   这里把任务级 signal 与 45s 硬超时合并，保证单次 1688 网络调用最多 45s 必返回。
function sourcingFetchSignal(job, timeoutMs = 45000) {
  const base = getSourcingAbortSignal(job);
  const hard = AbortSignal.timeout(timeoutMs);
  if (!base) return hard;
  try {
    return AbortSignal.any([base, hard]);
  } catch {
    return hard;
  }
}

async function withSourcingStepTimeout(job, label, timeoutMs, fn) {
  if (!job || typeof AbortController !== "function") return fn();
  const previousController = job.stepAbortController || null;
  const stepController = new AbortController();
  job.stepAbortController = stepController;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { stepController.abort(); } catch (_) {}
    closeActive1688TabsInPlugin().catch(() => {});
  }, timeoutMs);
  try {
    return await fn();
  } catch (error) {
    const message = String(error?.message || error || "");
    if (timedOut || /AbortError|aborted|当前步骤超时/i.test(message)) {
      throw new Error(`${label} 超过 ${Math.round(timeoutMs / 1000)} 秒未返回，已中断当前步骤`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (job.stepAbortController === stepController) job.stepAbortController = previousController;
  }
}

function isOzonVerificationBlocker(data) {
  const text = [
    data?.name,
    data?.title,
    data?.description,
    data?.raw_url,
    data?._debug?.url,
  ].map(value => String(value || "")).join(" ");
  return /请拖动滑块|滑块|验证码|安全验证|人机验证|captcha|verify|robot|are you human|подтвердите|капча/i.test(text);
}

function isCriticalOzonBlockerInPlugin(message) {
  return /Ozon.*(?:验证|验证码|滑块|风控|屏蔽)|请拖动滑块|captcha|verify|are you human|подтвердите|капча/i.test(String(message || ""));
}

function isSourcingStepTimeoutInPlugin(message) {
  return /超过 \d+ 秒未返回|当前步骤超时|timeout|timed out|AbortError|aborted/i.test(String(message || ""));
}

function isCriticalSourcingBlockerInPlugin(message) {
  return isCritical1688BlockerInPlugin(message) || isCriticalOzonBlockerInPlugin(message) || isSourcingStepTimeoutInPlugin(message);
}

function touchLiveHeartbeat(job) {
  if (!job) return false;
  const now = Date.now();
  if (job.lastLiveLogAt && now - job.lastLiveLogAt < 4500) return false;
  job.lastLiveLogAt = now;
  return true;
}

async function setActiveSourcingJob(job, phase = "") {
  if (!job?.id) return;
  await chrome.storage.local.set({
    [ACTIVE_SOURCING_JOB_KEY]: {
      id: job.id,
      phase: phase || job.phase || "",
      touchedAt: Date.now(),
    },
  }).catch(() => {});
}

async function getActiveSourcingJob() {
  const stored = await chrome.storage.local.get([ACTIVE_SOURCING_JOB_KEY]).catch(() => ({}));
  const active = stored?.[ACTIVE_SOURCING_JOB_KEY];
  if (!active?.id || Date.now() - Number(active.touchedAt || 0) > ACTIVE_SOURCING_JOB_TTL_MS) {
    await chrome.storage.local.remove([ACTIVE_SOURCING_JOB_KEY]).catch(() => {});
    return null;
  }
  return active;
}

async function clearActiveSourcingJob(id = "") {
  const active = await getActiveSourcingJob();
  if (!active || (id && active.id !== id)) return;
  await chrome.storage.local.remove([ACTIVE_SOURCING_JOB_KEY]).catch(() => {});
}

async function closeActive1688TabsInPlugin() {
  const ids = Array.from(active1688TabIds);
  active1688TabIds.clear();
  for (const tabId of ids) {
    await safeRemoveTab(tabId).catch(() => {});
  }
}

function isTransientTabEditError(error) {
  const message = String(error?.message || error || "");
  return /Tabs cannot be edited|user may be dragging a tab/i.test(message);
}

function isMissingChromeTabError(error) {
  const message = String(error?.message || error || "");
  return /No tab with id|Cannot find tab|Tabs? not found|No such tab/i.test(message);
}

async function withChromeTabEditRetry(label, fn, attempts = 5) {
  let lastError;
  const delays = [300, 700, 1200, 2000, 3000];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientTabEditError(error) || attempt === attempts - 1) throw error;
      console.warn(`[SW ${VERSION}] ${label} 遇到 Chrome tab 临时锁定，第 ${attempt + 1}/${attempts} 次重试: ${error.message || error}`);
      await sleep(delays[attempt] || 3000);
    }
  }
  throw lastError;
}

async function createTabWithRetry(createProperties, label = "创建标签页") {
  return withChromeTabEditRetry(label, () => chrome.tabs.create(createProperties));
}

async function removeTabWithRetry(tabId, label = "关闭标签页") {
  return withChromeTabEditRetry(label, () => chrome.tabs.remove(tabId), 4);
}

// ========== 采集核心: 打开 Ozon 商品前端页 + executeScript 提取 ==========

// v2.2.9.100: 静默采集 — 不打开商品页 tab，直接复用 seller.ozon.ru 登录 tab 走门户 API
//   (/api/v1/search → seller-prototype/create-bundle-by-variant-id)，对齐 MY ERP 插件：
//   批量上架全程后台执行，Chrome 不弹任何 Ozon 标签页。
//   售价不走采集(门户不带价)，由批量上架页行价格/批量售价填写。
//   无任何 ozon tab 时自动创建一个 seller.ozon.ru 后台 tab(active:false, 不打扰)并常驻复用。
async function ensureSellerPortalTabForSilent() {
  const tabs = await chrome.tabs.query({ url: ["*://*.ozon.ru/*"] }).catch(() => []);
  const usable = tabs.find(t => t.status === "complete") || tabs[0];
  if (usable?.id) return usable.id;
  const tab = await createTabWithRetry({ url: "https://seller.ozon.ru/", active: false }, "打开 seller.ozon.ru 后台页");
  try { await waitForTabComplete(tab.id, 30000); } catch (e) { console.warn(`[SW ${VERSION}] seller.ozon.ru 后台 tab 加载等待: ${e.message}`); }
  return tab.id;
}

async function collectSkuSilent(sku, storeIds = []) {
  const data = {};
  const companyId = await getSellerCompanyId();
  if (!companyId) throw new Error("未找到 sc_company_id cookie，请确认 seller.ozon.ru 已登录并选中店铺");
  const portalTabId = await ensureSellerPortalTabForSilent();
  await enrichFromSellerPortalBundle(data, sku, portalTabId);  // search → bundle → 组装 attributes/images/weight/类目/富文本
  data._plugin_version = VERSION;
  data._collected_via = "seller-portal-silent";
  data._seller_bundle_enriched = "silent-portal";
  // v2.2.9.100 debug: 打印 bundle 组装结果，定位 sourceAttr=1 问题
  console.log(`[SW ${VERSION}] 静默采集 debug ${sku}: sv.attrs=${Array.isArray(data._sourceVariant?.attributes) ? data._sourceVariant.attributes.length : "?"} bundleItem=${data._sourceVariant?._bundleItem ? `obj(attrs=${Array.isArray(data._sourceVariant._bundleItem.attributes) ? data._sourceVariant._bundleItem.attributes.length : "?"})` : "MISSING"} images=${Array.isArray(data.images) ? data.images.length : "?"}`);
  data.name = String(data.name || "").replace(/\s+/g, " ").trim();
  if (!data.name) throw new Error(`Seller portal 未取到商品名 (SKU ${sku})`);
  if (!Array.isArray(data.images) || !data.images.length) {
    const imgs = extractImagesFromSourceVariant(data._sourceVariant || {});
    if (imgs.length) data.images = imgs;
  }
  data.images = (data.images || [])
    .filter((u) => u && !isLikelyOzonMarketingImageInPlugin(u))   // v2.2.9.100: banner/logo/qr 图不得上架
    .filter((u, idx, arr) => arr.indexOf(u) === idx)
    .slice(0, 15);
  data.primary_image = data.images?.[0] || "";
  data.price = data.price || "";
  data.name = cleanOzonTitle(data.name);   // v2.2.9.100: 去 Ozon 页面标题模板后缀
  ensureSyntheticRichContent(data);
  injectRichContentAttr(data);
  console.log(`[SW ${VERSION}] ✓ 静默采集 ${sku}: ${String(data.name).slice(0, 50)} via seller-portal (attrs=${data.attributes?.length || 0} images=${data.images?.length || 0})`);
  return data;
}

// v2.2.9.100: Ozon 商品页 <title> 常带模板后缀 " - купить на OZON" / "- buy on OZON" / "- на OZON"，
// 直接上架会被 Ozon 拒（"商品名称中提到了品牌OZON"）。提交前统一清洗。
function cleanOzonTitle(name) {
  const text = String(name || "").replace(/\s+/g, " ").trim();
  return text
    .replace(/\s*-\s*(?:купить|buy|покупать)\s+(?:на\s+)?OZON\s*$/i, "")
    .replace(/\s*-\s*OZON\s*$/i, "")
    .replace(/\s*\(\s*(?:купить|buy)\s+(?:на\s+)?OZON\s*\)\s*$/i, "")
    .replace(/\s*-\s*купить\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function collectSku(sku, storeIds = [], job = null, opts = {}) {
  // v2.2.9.100: 静默采集模式（批量上架）— 绝不开商品页 tab；门户链路失败直接报错（保持全程静默），
  //   无 seller tab 时 collectSkuSilent 内部会自动建常驻后台 seller tab
  if (opts.silent === true && !job) {
    return await collectSkuSilent(sku, storeIds);
  }
  const url = OZON_PRODUCT_URL(sku);
  console.log(`[SW ${VERSION}] 采集 SKU ${sku}: 准备打开 ${url}, stores=${storeIds.length}`);
  
  // 1. 打开 Ozon 商品页 (后台 tab, 不打扰用户)
  const tab = await createTabWithRetry({ url, active: false }, "打开 Ozon 商品页");
  console.log(`[SW ${VERSION}] 已创建 tab id=${tab.id}, 等待页面加载...`);
  
  // 2. 等待页面加载完成 (最多 30s)
  try {
    await waitForTabComplete(tab.id, 30000);
  } catch (e) {
    await safeRemoveTab(tab.id);
    throw new Error(`Ozon 商品页加载超时/失败: ${e.message}`);
  }

// v2.2.9.1: Ozon SPA 异步渲染, status=complete 后 [data-widget="breadCrumbs"] 可能还没出现
  // v2.2.9.7: Chrome 后台 tab JS throttle 严重 (lazy-load 元素可能 5-10s 才出现), polling 5×1s 不够
  //   1) maxRetries 5 → 15, 间隔 1000ms → 2000ms (最多等 30s)
  //   2) exit 条件放宽: result.name 有就 break (不再强求 cat > 0), 后面 category-resolve 用 candidates 自动补
  //   3) executeScript 抛错时打印, 方便 debug
  // v2.2.9.8: 增强 debug — 每次 polling 后打印 result 类型 + tab status + 名字, 30s 全空时报最后 raw
  let result = null;
  let lastRaw = null;
  const maxRetries = 15;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    assertSourcingNotCanceled(job);
    try {
      const [execResult] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractOzonProductData,
        args: [sku],
      });
      result = execResult?.result;
      if (result) lastRaw = JSON.stringify(result).slice(0, 300);
    } catch (e) {
      console.warn(`[SW ${VERSION}]   attempt ${attempt} executeScript 抛错: ${e.message}`);
    }
    if (isOzonVerificationBlocker(result)) {
      await safeRemoveTab(tab.id);
      throw new Error("Ozon 商品页出现滑块/验证码，请在当前 Chrome 完成人工验证后，从当前行重新执行。");
    }
    // v2.2.9.8: extract 函数本身 try/catch 抛错时会在 result._error 字段, 这里打印到 SW console (user 能看)
    if (result && result._error) {
      console.error(`[SW ${VERSION}]   attempt ${attempt} extract 内部抛错: ${result._error} | stack=${result._stack}`);
    }
    // v2.2.9.7: 放宽 exit 条件 — name 拿到就 break (cat 可以后续 category-resolve 用 candidates 补)
    if (result && result.name) {
      if (attempt > 1) console.log(`[SW ${VERSION}]   第 ${attempt} 次 retry 拿到 name="${result.name?.slice(0,40)}" cat=${result.description_category_id || 0} attrs=${result.attributes?.length || 0}`);
      break;
    }
    // v2.2.9.8: 详细 debug — 第 1/5/10 次打印 result 类型 + tab status, 让 user 在 service worker console 能看到
    if (attempt === 1 || attempt === 5 || attempt === 10) {
      const tabInfo = await chrome.tabs.get(tab.id).catch(() => null);
      console.log(`[SW ${VERSION}]   attempt ${attempt} result=${result ? `object(name=${result.name?.slice(0,30)||'(empty)'})` : 'null'} tab.status=${tabInfo?.status} url=${tabInfo?.url?.slice(0,60)}`);
    }
    if (attempt < maxRetries) await sleep(2000);
  }
  if (!result && lastRaw) console.warn(`[SW ${VERSION}]   polling 15 次都失败, 最后 raw: ${lastRaw}`);

  if (!result) {
    await safeRemoveTab(tab.id);
    throw new Error("executeScript 返回空 (可能商品页是空或被 Ozon 屏蔽)");
  }
  if (!result.name) {
    await safeRemoveTab(tab.id);
    throw new Error(`未提取到商品名. raw=${JSON.stringify(result).slice(0, 300)}`);
  }
  if (isOzonVerificationBlocker(result)) {
    await safeRemoveTab(tab.id);
    throw new Error("Ozon 商品页出现滑块/验证码，请在当前 Chrome 完成人工验证后，从当前行重新执行。");
  }

  // v2.2.9.15: 优先复用 Seller 后台“复制商品”链路拿完整跟卖源包。
  // 公开页/OPI 只能兜底，My ERP 的完整属性、尺寸、富内容主要来自这个 bundle item。
  // v2.2.9.100: 找货模式 (opts.skipEnrichment) 跳过富化链 — 审核页只需要标题/图/价/重/属性，公开页已够用。
  result._plugin_version = VERSION;
  if (opts.skipEnrichment === true) {
    result._seller_bundle_enriched = "skipped-sourcing";
    console.log(`[SW ${VERSION}]   Seller bundle 富化跳过 (找货模式 skipEnrichment=true)`);
  } else {
    try {
      const bundle = await enrichFromSellerPortalBundle(result, sku, tab.id);
      result._seller_bundle_enriched = Boolean(bundle);
      if (bundle) {
        console.log(`[SW ${VERSION}]   Seller bundle: attrs=${bundle.attrCount} images=${bundle.imageCount} dims=${result.depth}x${result.width}x${result.height} weight=${result.weight}`);
      } else {
        console.log(`[SW ${VERSION}]   Seller bundle: 未找到可复制源包, 继续用公开页/OPI 兜底`);
      }
    } catch (e) {
      result._seller_bundle_enriched = false;
      result._seller_bundle_error = e.message || String(e);
      console.warn(`[SW ${VERSION}]   Seller bundle 增强失败 (非致命): ${result._seller_bundle_error}`);
    }
  }

  // 4. 关闭 tab
  await safeRemoveTab(tab.id);

  // v2.1: 辅源 - Ozon Seller API 找店铺里同款商品复用 attributes
  if (storeIds && storeIds.length > 0 && result.description_category_id && !result._seller_bundle_enriched) {
    try {
      const enriched = await enrichFromOpi(result, storeIds[0]);
      if (enriched) {
        result._opi_enriched = true;
        console.log(`[SW ${VERSION}]   OPI 辅源: 合并 ${enriched.added} 个新 attr, 覆盖 ${enriched.overridden} 个`);
      } else {
        result._opi_enriched = false;
        console.log(`[SW ${VERSION}]   OPI 辅源: 店铺里没找到同款`);
      }
    } catch (e) {
      result._opi_enriched = false;
      result._opi_error = e.message;
      console.warn(`[SW ${VERSION}]   OPI 辅源失败 (非致命): ${e.message}`);
    }
  } else {
    result._opi_enriched = result._seller_bundle_enriched ? "skipped-seller-bundle" : "skipped";
  }

  // v2.3.0: 重新启用 category-resolve, 带 type_id + confidence
//   - 严格名字匹配 (2 token 都中才用, 避免 Лупа/Оплетка 假阳性)
//   - type_id 匹配更稳 (同一 type_id 通常同一类目)
//   - 带回来 candidates 让前端展示供 user 1-click 选
  if (storeIds && storeIds.length > 0 && (result.name || result.type_id)) {
    try {
      const oldCat = result.description_category_id;
      // v2.2.9: 把 5位 breadcrumb 透传给 server, 配合 name+type_id 多信号解析
      const resolved = await resolveSellerCategory(
        result.sku || result.product_id,
        storeIds[0],
        result.type_id,
        Number(result.description_category_id) || 0,  // 5位 breadcrumb
        result.name,  // v2.2.9.3: 让 server candidates 能用 name 关键词匹配
      );
      const hasSellerBundleCategory = !!(result._seller_bundle_source?.description_category_id || result._seller_bundle_source?.type_id);
      if (resolved && resolved.success && !hasSellerBundleCategory) {
        result.description_category_id = resolved.description_category_id;
        if (resolved.type_id && !result.type_id) result.type_id = resolved.type_id;
        result._category_resolved = {
          from: oldCat,
          to: resolved.description_category_id,
          source: resolved.source,
          confidence: resolved.confidence || 'high',
        };
        console.log(`[SW ${VERSION}]   类目解析: ${oldCat} → ${resolved.description_category_id} (${resolved.source}, confidence=${resolved.confidence})`);
      } else if (resolved && !hasSellerBundleCategory) {
        // v2.2.9.1: 不再清零 plugin 已抓到的 cat (5位 breadcrumb)
        // v2.2.9.2: 自动应用 candidates 第一个 (按商品 name 关键词匹配的最高分 cat)
        // v2.2.9.3: 关键修复 — plugin 抓的 5位 breadcrumb 跟 Ozon Seller API 8位 cat 是两套体系
        //   5位 (e.g. 11427) 是公开 URL slug 末尾, 在 Seller API tree 里不存在, 提交会被拒 levels_category_not_found
        //   8位 (e.g. 17029010) 是 Seller API 内部 id, Ozon /v3/product/import 接受
        //   所以: 5位 cat 只用作 candidates 排序参考, 实际提交用 candidates 第一个 8位 cat + 它的 type_id
        //   user 拿到结果后可在 BatchUpload 表格里点"换一个"切换到更准的
        const candidates = resolved.candidates || [];
        let autoCat = 0;  // 默认不提交 cat, 让 server 拒绝触发 user 选
        let autoType = result.type_id;
        let autoSource = 'none';
        let autoConfidence = 'none';
        let autoWarning = '无法获取类目, 请手动从候选选';
        if (candidates.length > 0) {
          // 优先选 ozon-tree-name-match 来源 + 有 cat_id + 有 type_id 的
          //   (没 type_id 的 candidates 来自 type_id 叶子节点, 8位 cat_id 来自父节点, 实际提交时 cat+type 缺一个会被拒)
          const best = candidates.find(c => c.source === 'ozon-tree-name-match' && c.description_category_id && c.type_id > 0)
                    || candidates.find(c => c.description_category_id && c.type_id > 0)
                    || candidates.find(c => c.source === 'ozon-tree-name-match' && c.description_category_id)
                    || candidates.find(c => c.description_category_id);
          if (best) {
            autoCat = best.description_category_id;
            if (best.type_id) autoType = best.type_id;
            autoSource = 'auto-from-candidates';
            autoConfidence = best.match_score >= 2 ? 'high' : 'medium';
            autoWarning = '类目自动从商品名称匹配填上 (不一定最准, 可点"换一个"切换到更合适的)';
            console.log(`[SW ${VERSION}]   自动应用候选: cat=${autoCat} type_id=${autoType || '(无)'} (${best.name}, score=${best.match_score || '-'})`);
          }
        }
        if (autoCat) {
          result.description_category_id = autoCat;
          if (autoType && !result.type_id) result.type_id = autoType;
        } else {
          // 没 candidates, 保留 plugin 抓的 5位 cat (虽然 Ozon 可能拒, 但作为兜底总比 0 强)
          result.description_category_id = oldCat;
          autoSource = 'public-breadcrumb-fallback';
          autoConfidence = 'low';
          autoWarning = '类目来自公开页面 5位 breadcrumb, Seller API tree 找不到, 上架后会被拒, 请去 Ozon 后台改';
          console.log(`[SW ${VERSION}]   无 candidates, 保留 5位 breadcrumb cat=${oldCat} (Ozon 可能拒)`);
        }
        result._category_resolved = {
          from: oldCat,
          to: result.description_category_id,
          source: autoSource,
          confidence: autoConfidence,
          candidates,  // 保留备选, user 可点"换一个"切换
          warning: autoWarning,
        };
        console.log(`[SW ${VERSION}]   类目自动填上: cat=${result.description_category_id} type_id=${autoType || '(待补)'} (${autoSource}, confidence=${autoConfidence})`);
      } else if (resolved && hasSellerBundleCategory) {
        result._category_resolved = {
          from: oldCat,
          to: result.description_category_id,
          source: 'seller-bundle-trusted',
          confidence: 'high',
          candidates: resolved.candidates || [],
          warning: '已使用 Seller bundle 的源类目/类型, 跳过公开页名称候选纠偏',
        };
        console.log(`[SW ${VERSION}]   类目解析: 保留 Seller bundle cat=${result.description_category_id} type=${result.type_id || '(空)'}, 跳过候选覆盖`);
      }
    } catch (e) {
      console.warn(`[SW ${VERSION}]   category-resolve 调用失败 (非致命, 用 URL cat 上传): ${e.message}`);
    }
  }

  // v2.2.9.30: Ozon 公开 composer 偶发不给 richAnnotationJson。
  // 保留真实富文本优先; 抓不到时用源商品图册生成合法 11254，避免 Seller 后台富内容为空。
  ensureSyntheticRichContent(result);

  // v1.0.9: 详细打印每个字段的来源 + 关键数据
  injectRichContentAttr(result);
	  const dbg = result._debug || {};
  console.log(`[SW ${VERSION}] ✓ 采集 ${sku}: ${result.name?.slice(0, 50)}`);
  console.log(`[SW ${VERSION}]   字段: images=${result.images.length} | cat=${result.description_category_id} | type=${result.type_id} | brand=${result.brand || "(空)"} | weight=${result.weight}g | dims=${result.depth}x${result.width}x${result.height} | price=${result.price || "(空)"} | barcode=${result.barcode || "(空)"} | country=${result.country_of_origin || "(空)"}`);
	  console.log(`[SW ${VERSION}]   attributes: ${result.attributes.length} 个, rich=${result.richContent ? result.richContent.length : 0} bytes, opi=${result._opi_enriched}${result._opi_error ? " (error: "+result._opi_error+")" : ""}`);
  if (result.attributes.length > 0) {
    console.log(`[SW ${VERSION}]   attributes 前 3 个: ${JSON.stringify(result.attributes.slice(0, 3))}`);
  }
  console.log(`[SW ${VERSION}]   _debug 详情: ${JSON.stringify(dbg)}`);

	  return result;
	}

function injectRichContentAttr(data) {
  const richContent = typeof data?.richContent === "string" ? data.richContent.trim() : "";
  if (!richContent) return;
  if (!data._sourceVariant || typeof data._sourceVariant !== "object") data._sourceVariant = { attributes: [] };
  const attrs = Array.isArray(data._sourceVariant.attributes) ? data._sourceVariant.attributes : [];
  if (!attrs.some(a => String(a?.key ?? a?.id ?? a?.attribute_id) === "11254")) {
    data._sourceVariant.attributes = [...attrs, { key: "11254", value: richContent }];
  }
  if (!Array.isArray(data.attributes)) data.attributes = [];
  if (!data.attributes.some(a => Number(a?.id ?? a?.attribute_id) === 11254)) {
    data.attributes.push({ id: 11254, name: "JSON Rich Content", value: richContent });
  }
}

function makeLog(message, level = "info") {
  return { at: new Date().toISOString(), level, message };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepWithSourcingLease(job, ms, phase = "") {
  const deadline = Date.now() + Math.max(0, Number(ms) || 0);
  while (Date.now() < deadline) {
    assertSourcingNotCanceled(job);
    if (phase) job.phase = phase;
    touchLiveHeartbeat(job);
    await reportSourcingProgress(job, { phase: job.phase || phase || "等待下一条" });
    await sleep(Math.min(4000, Math.max(0, deadline - Date.now())));
  }
  assertSourcingNotCanceled(job);
}

function randomInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

async function humanBrowse1688TabInPlugin(tabId, label = "1688 页面", options = {}) {
  if (!tabId) return null;
  const config = {
    minDurationMs: options.minDurationMs ?? 4500,
    maxDurationMs: options.maxDurationMs ?? 11000,
    minStep: options.minStep ?? 180,
    maxStep: options.maxStep ?? 620,
    minDelay: options.minDelay ?? 260,
    maxDelay: options.maxDelay ?? 950,
    dwellChance: options.dwellChance ?? 0.28,
    dwellMinMs: options.dwellMinMs ?? 900,
    dwellMaxMs: options.dwellMaxMs ?? 2800,
    returnTop: Boolean(options.returnTop),
    mouseMoves: options.mouseMoves ?? randomInt(2, 5),
  };
  try {
    // Keep 1688 detail/search tabs passive. Production's stable collector does not
    // foreground every 1688 tab; repeatedly activating tabs makes verification more likely.
    await sleep(randomInt(500, 1200));
    const [execResult] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: humanBrowse1688PageContext,
      args: [config],
    });
    const result = execResult?.result || {};
    if (result.verification) {
      console.warn(`[SW ${VERSION}] ${label} 检测到 1688 验证提示: ${result.verificationText || "verification"}`);
    }
    await sleep(randomInt(600, 1600));
    return result;
  } catch (e) {
    console.warn(`[SW ${VERSION}] ${label} 人工浏览动作跳过: ${compact1688ErrorInPlugin(e.message || e)}`);
    return null;
  }
}

async function humanBrowse1688PageContext(options = {}) {
  const sleepInPage = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rand = (min, max) => Math.floor(Number(min) + Math.random() * (Number(max) - Number(min) + 1));
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const text = String(document.body?.innerText || "").replace(/\s+/g, " ").trim();
  const verification = /验证码|滑块|安全验证|人机验证|拖动滑块|captcha|verify|robot/i.test(text) || /captcha|verify|punish|security/i.test(location.href);
  const viewportW = Math.max(320, window.innerWidth || 1280);
  const viewportH = Math.max(320, window.innerHeight || 800);
  const scrollHeight = Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0, viewportH);
  const maxY = Math.max(0, scrollHeight - viewportH);
  const startedAt = Date.now();
  const minDurationMs = Math.max(1500, Number(options.minDurationMs) || 4500);
  const maxDurationMs = Math.max(minDurationMs, Number(options.maxDurationMs) || 11000);
  const targetDuration = rand(minDurationMs, maxDurationMs);

  for (let i = 0; i < Math.max(1, Number(options.mouseMoves) || 2); i += 1) {
    const x = rand(Math.floor(viewportW * 0.2), Math.floor(viewportW * 0.85));
    const y = rand(Math.floor(viewportH * 0.18), Math.floor(viewportH * 0.82));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
    await sleepInPage(rand(180, 620));
  }

  let direction = 1;
  while (Date.now() - startedAt < targetDuration && maxY > 0) {
    const step = rand(Number(options.minStep) || 180, Number(options.maxStep) || 620) * direction;
    const nextY = clamp(window.scrollY + step, 0, maxY);
    window.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: step, clientX: rand(80, viewportW - 80), clientY: rand(120, viewportH - 80) }));
    window.scrollTo({ top: nextY, behavior: "smooth" });
    await sleepInPage(rand(Number(options.minDelay) || 260, Number(options.maxDelay) || 950));
    if (Math.random() < Number(options.dwellChance ?? 0.28)) {
      await sleepInPage(rand(Number(options.dwellMinMs) || 900, Number(options.dwellMaxMs) || 2800));
    }
    if (nextY >= maxY - 24) direction = -1;
    if (nextY <= 24) direction = 1;
  }

  if (options.returnTop) {
    window.scrollTo({ top: 0, behavior: "smooth" });
    await sleepInPage(rand(800, 1700));
  }

  return {
    ok: true,
    verification,
    verificationText: verification ? text.slice(0, 140) : "",
    scrollHeight,
    finalY: Math.round(window.scrollY || 0),
    durationMs: Date.now() - startedAt,
  };
}

async function erpApi(path, { method = "GET", body } = {}) {
  if (!workerAuthToken) {
    const stored = await chrome.storage.local.get(["workerAuthToken"]).catch(() => ({}));
    workerAuthToken = stored.workerAuthToken || "";
  }
  const headers = { Accept: "application/json" };
  if (workerAuthToken) headers.Authorization = `Bearer ${workerAuthToken}`;
  const init = { method, headers, credentials: "include" };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const resp = await fetch(`${ERP_BACKEND_ORIGIN}${path}`, init);
  const text = await resp.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!resp.ok || data.success === false) {
    throw new Error(data.error || `ERP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return data;
}

async function configureWorkerAuth(token) {
  workerAuthToken = String(token || "").trim();
  if (!workerAuthToken) {
    await chrome.storage.local.remove(["workerAuthToken", "workerAuthUpdatedAt"]);
    return { ok: false, error: "插件 token 为空", version: VERSION };
  }
  await chrome.storage.local.set({ workerAuthToken, workerAuthUpdatedAt: Date.now() });
  startSourcingQueueLoop();
  await pollSourcingQueueOnce();
  return { ok: true, version: VERSION, workerName: WORKER_NAME };
}

function workerMeta(currentPhase = "") {
  return {
    workerName: WORKER_NAME,
    version: VERSION,
    pluginVersion: VERSION,
    platform: "chrome-extension",
    hostname: "Chrome",
    profileDir: chrome.runtime.id,
    currentPhase,
  };
}

async function reportSourcingProgress(job, extra = {}) {
  try {
    await setActiveSourcingJob(job, extra.phase || job.phase || "");
    const data = await erpApi(`/api/worker/jobs/${encodeURIComponent(job.id)}/progress`, {
      method: "POST",
      body: {
        status: job.status,
        phase: job.phase,
        processed: job.processed,
        total: job.total,
        logs: job.logs,
        results: job.results,
        error: job.error || "",
        ...workerMeta(job.phase),
        ...extra,
      },
    });
    if (data.job?.status === "canceled") job.cancelRequested = true;
    return data;
  } catch (e) {
    console.warn(`[SW ${VERSION}] 单品找货进度回传失败: ${e.message}`);
    return null;
  }
}

function startSourcingCancelMonitor(job) {
  const timer = setInterval(async () => {
    if (!job || ["done", "error", "canceled"].includes(job.status)) {
      clearInterval(timer);
      return;
    }
    if (!touchLiveHeartbeat(job)) return;
    const data = await reportSourcingProgress(job, { phase: job.phase || "采集中" });
    if (data?.job?.status === "canceled") {
      markSourcingCanceled(job, "收到停止请求，正在中断当前 1688/Ozon 采集步骤。");
      clearInterval(timer);
    }
  }, 5000);
  return () => clearInterval(timer);
}

async function completeSourcingJob(job) {
  try {
    await erpApi(`/api/worker/jobs/${encodeURIComponent(job.id)}/complete`, {
      method: "POST",
      body: {
        job: {
          id: job.id,
          kind: "run",
          status: job.status,
          phase: job.phase,
          total: job.total,
          processed: job.processed,
          logs: job.logs,
          results: job.results,
          error: job.error || "",
        },
        excelBase64: "",
        ...workerMeta(job.phase),
      },
    });
  } finally {
    await clearActiveSourcingJob(job.id);
  }
}

function extractOzonSkuFromUrl(url) {
  const text = String(url || "").trim();
  const match = text.match(/(?:product\/[^/?#]*-)?(\d{6,})(?:[/?#]|$)/i) || text.match(/(\d{6,})/);
  return match ? match[1] : "";
}

function isLikelyOzonMarketingImageInPlugin(url) {
  const text = String(url || "").toLowerCase();
  return /\/marketing-api\/banners?\//i.test(text)
    || /\/banners?\//i.test(text)
    || /\/brand(?:-|_)?logo/i.test(text)
    || /\/seller(?:-|_)?logo/i.test(text)
    || /\/qr-code[\/_]/i.test(text)   // v2.2.9.100: 二维码图也不得作为商品图
    || /qr[_-]?code/i.test(text)
    // v2.2.9.102 (fix): 价格标签/营销角标图（如 payments-cdn/ozon-price-compact-new）不得作为商品主图
    || /\/payments-cdn\//i.test(text)
    || /price-compact|price-ribbon|price-tag|promo-badge|sale-badge/i.test(text);
}

function normalizeOzonForSourcing(data, url, sourceRow) {
  const images = Array.isArray(data.images) ? data.images.filter((image) => image && !isLikelyOzonMarketingImageInPlugin(image)) : [];
  const mainImageUrl = images[0] || "";
  const weightGrams = Number(data.weight || data.weightGrams || 0) || "";
  const priceText = data.price || data.currentBlackPriceCny || data.currentBlackPrice || "";
  // v2.2.9.101: 透传页面 finalPrice（买家实际支付价，含平台自动拉活动折扣）；无促销时与 price 相同
  const finalPriceText = data.final_price || "";
  return {
    sourceUrl: url,
    sku: data.sku || data.product_id || extractOzonSkuFromUrl(url),
    title: data.name || "",
    description: data.description || "",
    attributes: data.attributes || [],
    brand: data.brand || "",
    description_category_id: data.description_category_id || 0,
    type_id: data.type_id || 0,
    currentBlackPriceCny: priceText,
    currentBlackPriceCnyValue: parseFloat(String(priceText).replace(/[^\d.,]/g, "").replace(",", ".")) || "",
    finalPriceCny: finalPriceText,
    finalPriceCnyValue: parseFloat(String(finalPriceText).replace(/[^\d.,]/g, "").replace(",", ".")) || "",
    weightGrams,
    weightText: weightGrams ? `${weightGrams} g` : (data.weightText || ""),
    weightSource: weightGrams ? "ozon-plugin" : "",
    weightEvidence: weightGrams ? String(data.weight || data.weightGrams) : "",
    mainImageUrl,
    mainImage: mainImageUrl ? { url: mainImageUrl, publicUrl: mainImageUrl, contentType: "image/jpeg" } : null,
    images,
    raw: data,
    sourceRow,
  };
}

async function runQueuedSourcingJob(remoteJob) {
  const payload = remoteJob.payload || {};
  const options = payload.options || {};
  const rawRows = Array.isArray(payload.urlRows) && payload.urlRows.length
    ? payload.urlRows
    : (Array.isArray(payload.urls) ? payload.urls.map((url, index) => ({ url, sourceRow: index + 1 })) : []);
  const declaredTotal = Math.max(0, Number(remoteJob.total || payload.sourceTotal || rawRows.length || 0));
  const rows = declaredTotal > 0 ? rawRows.slice(0, declaredTotal) : rawRows;
  const initialProcessed = Math.min(Math.max(0, Number(remoteJob.processed || 0)), rows.length);
  const job = {
    id: remoteJob.id,
    status: "running",
    phase: "插件已领取，准备单品找货",
    total: rows.length,
    processed: initialProcessed,
    logs: Array.isArray(remoteJob.logs) ? remoteJob.logs : [],
    results: Array.isArray(remoteJob.results) ? remoteJob.results.slice(0, rows.length) : [],
    error: "",
    cancelRequested: false,
    abortController: typeof AbortController === "function" ? new AbortController() : null,
  };
  job.logs.push(makeLog(`逐梦插件 v${VERSION} 已领取单品找货任务。`));
  await setActiveSourcingJob(job);
  await reportSourcingProgress(job);

  if (job.total > 0 && job.processed >= job.total) {
    job.status = "done";
    job.processed = job.total;
    job.phase = "已完成，正在生成 Excel";
    job.logs.push(makeLog(`任务进度已到 ${job.processed}/${job.total}，不再继续采集额外行。`));
    await completeSourcingJob(job);
    return;
  }

  const maxCandidates = Math.max(1, Math.min(20, Number(options.maxCandidates || 5)));
  const enable1688 = options.enable1688 !== false;
  // v2.2.9.100: 找货模式轻量采集 — 默认跳过 Ozon Seller 富化链(seller bundle/OPI/类目解析/富文本)
  //   并启用 1688 详情轻量浏览。富化链是为上架"复制商品"服务的，找货审核页只需要标题/图/价/重/属性。
  const skipOzonEnrichment = options.skipOzonEnrichment !== false;
  const fast1688 = options.fast1688 !== false;
  // v2.2.9.100: 对齐生产插件 — Ozon/1688 滑块/验证码/登录/超时不再整体停止任务，
  //   改为行级失败 + 连续失败计数(默认 3 次, 前端可配)。用户人工处理后, 下一行成功即自动继续。
  const maxConsecutiveFailures = Math.max(1, Math.min(20, Number(options.maxConsecutiveFailures || 3)));
  const delayMinMs = Math.max(1000, Number(options.delayMinMs || 8000));
  const delayMaxMs = Math.max(delayMinMs, Number(options.delayMaxMs || 20000));
  let fatalStop = false;
  let consecutiveFailures = 0;
  const stopCancelMonitor = startSourcingCancelMonitor(job);

  try {
    for (let index = job.processed; index < rows.length; index += 1) {
      if (job.cancelRequested) break;
      const row = rows[index] || {};
      const url = row.url || row;
      const sourceRow = Number(row.sourceRow || index + 1);
      const sku = extractOzonSkuFromUrl(url);
      const result = { url, sourceRow, ozon: null, candidates: [], selectedCandidate: null, aiReview: null };
      try {
        if (!sku) throw new Error("没有识别到 Ozon SKU");
        job.phase = `采集 Ozon 第 ${sourceRow} 行`;
        job.logs.push(makeLog(`开始采集 Ozon SKU ${sku}`));
        await reportSourcingProgress(job);
        const ozonRaw = await withSourcingStepTimeout(job, `Ozon 第 ${sourceRow} 行采集`, 90_000, () => collectSku(sku, [], job, { skipEnrichment: skipOzonEnrichment }));
        if (job.cancelRequested) break;
        result.ozon = normalizeOzonForSourcing(ozonRaw, url, sourceRow);

        if (enable1688 && result.ozon.mainImageUrl) {
          job.phase = `1688 搜图 第 ${sourceRow} 行`;
          job.logs.push(makeLog(`用主图搜索 1688 候选，最多 ${maxCandidates} 个。`));
          await reportSourcingProgress(job);
          const searchResult = await withSourcingStepTimeout(job, `1688 第 ${sourceRow} 行搜图`, 240_000, () => search1688ByImageInPlugin(result.ozon.mainImageUrl, maxCandidates, job, { lightMode: fast1688 }));
          if (job.cancelRequested) break;
          if (searchResult.success) {
            result.candidates = searchResult.candidates;
            result.selectedCandidate = result.candidates[0] || null;
            result.aiReview = {
              decision: result.selectedCandidate ? "needs_review" : "no_match",
              reason: "插件端已完成 1688 搜图和详情采集，AI 严格审核待接入后端评估。",
            };
            job.logs.push(makeLog(`1688 找到 ${result.candidates.length} 个候选。`));
          } else {
            result.searchError = searchResult.error;
            job.logs.push(makeLog(`1688 搜图失败：${searchResult.error}`, "warn"));
            // v2.2.9.100: 1688 登录/验证码/超时降级为行级失败（不整体停止），对齐生产行为
            if (isCriticalSourcingBlockerInPlugin(searchResult.error)) {
              job.logs.push(makeLog(isSourcingStepTimeoutInPlugin(searchResult.error)
                ? "该行 1688 搜图超时（非致命）：已跳过，继续下一行。"
                : "该行遇到 1688 登录/验证码阻塞（非致命）：请在当前 Chrome 处理验证，后续行会自动继续。", "warn"));
            }
          }
        } else if (enable1688) {
          result.searchError = "Ozon 主图为空，无法 1688 搜图";
          job.logs.push(makeLog(result.searchError, "warn"));
        }
      } catch (e) {
        result.error = e.message || String(e);
        job.logs.push(makeLog(`第 ${sourceRow} 行失败：${result.error}`, "error"));
        // v2.2.9.100: 滑块/验证码/登录/超时降级为行级失败（不整体停止），对齐生产插件行为
        if (isCriticalSourcingBlockerInPlugin(result.error)) {
          job.logs.push(makeLog(isCriticalOzonBlockerInPlugin(result.error)
            ? "该行被 Ozon 滑块/验证码阻塞（非致命）：请在当前 Chrome 处理验证，后续行会自动继续。"
            : isSourcingStepTimeoutInPlugin(result.error)
              ? "该行采集步骤超时（非致命）：已跳过，继续下一行。"
              : "该行遇到 1688 登录/验证码阻塞（非致命）：请处理验证，后续行会自动继续。", "warn"));
        }
      }
      if (job.cancelRequested) break;
      job.results.push(result);
      job.processed = Math.min(index + 1, job.total);
      // v2.2.9.100: 连续失败计数 — 对齐生产 maxConsecutiveFailures 语义；"主图为空"这类可预期跳过不计失败
      const rowFailed = Boolean(result.error) || (Boolean(result.searchError) && !/主图为空/.test(result.searchError));
      if (rowFailed) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= maxConsecutiveFailures) {
          fatalStop = true;
          const nextRow = Math.min(index + 2, job.total);
          job.error = `连续 ${consecutiveFailures} 行采集失败（可能验证码/登录阻塞或页面异常），已自动停止。请处理后从第 ${nextRow} 行继续。`;
          job.phase = `已自动停止：连续 ${consecutiveFailures} 行失败`;
          job.logs.push(makeLog(`连续 ${consecutiveFailures} 行失败，已自动停止。请检查 Ozon/1688 是否被验证码/登录页阻塞，处理完成后可从第 ${nextRow} 行继续。`, "error"));
        }
      } else {
        consecutiveFailures = 0;
      }
      if (!fatalStop) job.phase = `已完成 ${job.processed}/${job.total}`;
      await reportSourcingProgress(job);
      if (fatalStop || job.cancelRequested) break;
      if (index < rows.length - 1) {
        await sleepWithSourcingLease(job, randomInt(delayMinMs, delayMaxMs), `等待下一条 ${Math.min(index + 2, rows.length)}/${job.total}`);
      }
    }
  } finally {
    stopCancelMonitor();
  }

  job.status = fatalStop ? "error" : (job.cancelRequested ? "canceled" : (job.results.some(r => !r.error) ? "done" : "error"));
  job.phase = fatalStop ? job.phase : (job.status === "done" ? "已完成，正在生成 Excel" : (job.status === "canceled" ? "已停止" : "全部失败"));
  job.error = fatalStop ? (job.error || "采集被验证/超时阻断") : (job.status === "error" ? "单品找货全部失败" : "");
  job.logs.push(makeLog(job.status === "done" ? "单品找货完成。" : job.phase, job.status === "error" ? "error" : "info"));
  await completeSourcingJob(job);
}

// Yandex 自动上架采集（kind=yandex-collect）：逐个打开 1688 商品详情页，采集标题/图集/详情图/
// SKU(规格+价格+库存+图)/商品属性/包装重量尺寸，回传给 ERP 生成上架草稿。
async function runQueuedYandexCollectJob(remoteJob) {
  const payload = remoteJob.payload || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const job = {
    id: remoteJob.id,
    status: "running",
    phase: "插件已领取，开始采集 1688 商品",
    total: items.length,
    processed: Math.min(Math.max(0, Array.isArray(remoteJob.results) ? remoteJob.results.length : 0), items.length),
    logs: Array.isArray(remoteJob.logs) ? remoteJob.logs : [],
    results: Array.isArray(remoteJob.results) ? remoteJob.results.slice() : [],
    error: "",
    cancelRequested: false,
    abortController: typeof AbortController === "function" ? new AbortController() : null,
  };
  job.logs.push(makeLog(`逐梦插件 v${VERSION} 已领取 Yandex 上架采集任务（${items.length} 项）。`));
  await setActiveSourcingJob(job);
  await reportSourcingProgress(job);
  const stopCancelMonitor = startSourcingCancelMonitor(job);
  try {
    for (let index = job.results.length; index < items.length; index += 1) {
      if (job.cancelRequested) break;
      const item = items[index] || {};
      const url = String(item.url || "");
      job.phase = `采集 1688 商品 ${index + 1}/${items.length}`;
      job.logs.push(makeLog(`采集 ${url}`));
      await reportSourcingProgress(job);
      try {
        if (!url) throw new Error("缺少链接");
        const data = await collect1688ProductForListingInPlugin(url, job);
        if (!data || !data.title) throw new Error("未采集到商品标题（页面结构变化或需要登录）");
        job.results.push({ draftId: item.draftId || "", url, ok: true, data });
        job.logs.push(makeLog(`✓ ${String(data.title).slice(0, 40)} | 主图 ${(data.images || []).length} 张 | SKU ${(data.skus || []).length} 个 | 属性 ${Object.keys(data.attributes || {}).length} 项`));
      } catch (e) {
        const msg = (e?.message || String(e)).slice(0, 300);
        job.results.push({ draftId: item.draftId || "", url, ok: false, error: msg });
        job.logs.push(makeLog(`✗ 采集失败 ${url}：${msg}`, "warn"));
      }
      job.processed = Math.min(index + 1, job.total);
      job.phase = `已完成 ${job.processed}/${job.total}`;
      await reportSourcingProgress(job);
    }
  } finally {
    stopCancelMonitor();
  }
  const failed = job.results.filter((r) => r.ok === false).length;
  job.status = job.cancelRequested ? "canceled" : (failed === job.results.length && job.results.length ? "error" : "done");
  job.error = job.status === "error" ? "全部采集失败" : "";
  job.phase = job.status === "done" ? `采集完成：成功 ${job.results.length - failed} · 失败 ${failed}` : (job.status === "canceled" ? "已停止" : "全部失败");
  await completeSourcingJob(job);
}

async function collect1688ProductForListingInPlugin(url, job = null) {
  assertSourcingNotCanceled(job);
  const tab = await createTabWithRetry({ url, active: false }, "打开 1688 商品页");
  if (tab?.id) active1688TabIds.add(tab.id);
  try {
    await waitForTabComplete(tab.id, 45000);
    await sleep(randomInt(900, 1800));
    assertSourcingNotCanceled(job);
    await browse1688DetailLightInPlugin(tab.id);
    assertSourcingNotCanceled(job);
    // v2.2.9.114: 复用已验证的 extract1688DetailData 取标题/重量/尺寸/属性（含公司名过滤），
    //   再单独抽图集/SKU，避免自己重写一套导致标题抓成公司名、重量尺寸为空。
    let basics = {};
    let basicsError = "";
    // 1688 的包装重量/尺寸比标题晚加载：缺失时向下滚动触发懒加载并重试（最多 3 次）
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extract1688DetailData, args: [{}] });
        basics = r?.result || {};
        basicsError = r?.result ? "" : "注入无返回";
      } catch (e) {
        basicsError = String(e?.message || e).slice(0, 200);
      }
      if (job) job.logs.push(makeLog(`货号采集 basics 第${attempt + 1}次：title=${basics.title ? "有" : "无"} 重量=${basics.weightGrams || 0}g 尺寸=${basics.dimensionsText || "-"}${basicsError ? " 错误=" + basicsError : ""}`, basicsError ? "warn" : "info"));
      const hasWeight = Number(basics.weightGrams || 0) > 0;
      const hasDims = /\d/.test(String(basics.dimensionsText || ""));
      if (hasWeight && hasDims) break;
      if (attempt < 2) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { window.scrollBy(0, 700); window.scrollBy(0, -350); } }).catch(() => {});
        await sleep(randomInt(2200, 3200));
      }
    }
    const [mediaRes] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extract1688ListingMedia });
    const media = mediaRes?.result || {};
    const dimsText = String(basics.dimensionsText || attrAll["包装尺寸"] || attrAll["商品尺寸"] || attrAll["尺寸"] || attrText || "");
    const dims = dimsText.match(/([\d.]+)\s*[x×*]\s*([\d.]+)\s*[x×*]\s*([\d.]+)/i);
    // 属性过滤：只要像「商品参数」的（键含中文、短、非【说明】、非 SKU 规格行、值不是纯数字串）
    const attributes = {};
    const specSet = new Set((media.skus || []).map((s2) => String(s2.spec || "")));
    for (const [k, v] of Object.entries({ ...(basics.detailAttributes || {}), ...(media.attributes || {}) })) {
      const key = String(k || "").trim();
      if (!key || key.length > 20) continue;
      if (!/[\u4e00-\u9fff]/.test(key)) continue;
      if (/^【|^\*|】/.test(key)) continue;
      if (specSet.has(key)) continue;
      if (/(揽收率|代发热度|分销商数|复购率|加购|收藏|浏览|访客|回头率|退款率|好评率|支付率|平台活动下价格|非平台活动下价格|发布价|全网销量)/.test(key)) continue;
      const value = String(v ?? "").trim();
      if (!value || value.length > 120) continue;
      if (/^\d+([\s.]\d+)*$/.test(value)) continue;
      attributes[key] = value;
    }
    const skus = (Array.isArray(media.skus) && media.skus.length)
      ? media.skus
      : [{ spec: "", priceCny: Number((basics.price || "").replace(/[^\d.]/g, "")) || 0, stock: 0, image: (media.images || [])[0] || "" }];
    // 兜底：basics/属性都拿不到包装重量/尺寸时，直接从页面可见文本里解析（1688 商品参数表里通常有「包装重量/包装尺寸」）
    const pageText = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 20000),
    }).then((r) => r?.[0]?.result || "").catch(() => "");
    const attrText2 = Object.entries(attributes).map(([k, v]) => `${k}:${v}`).join(" ");
    const weightSource = [basics.weightText, attrText2, pageText].filter(Boolean).join(" ");
    const wm2 = String(weightSource).match(/(?:包装重量|发货重量|商品重量|产品重量|毛重|净重|重量)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(kg|公斤|千克|g|克)/i);
    const finalWeightKg = weightKg > 0
      ? weightKg
      : (wm2 ? (/^(kg|公斤|千克)$/i.test(wm2[2]) ? Number(wm2[1]) : Number(wm2[1]) / 1000) : 0);
    const dm2 = String([basics.dimensionsText, attrText2, pageText].filter(Boolean).join(" "))
      .match(/(?:包装尺寸|商品尺寸|产品尺寸|尺寸)\s*[:：]?\s*([\d.]+)\s*[x×*]\s*([\d.]+)\s*[x×*]\s*([\d.]+)/i);
    const finalDims = dims ? [Number(dims[1]) || 0, Number(dims[2]) || 0, Number(dims[3]) || 0] : (dm2 ? [Number(dm2[1]) || 0, Number(dm2[2]) || 0, Number(dm2[3]) || 0] : [0, 0, 0]);
    if (job) job.logs.push(makeLog(`货号采集 汇总：重量=${finalWeightKg}kg 尺寸=${finalDims.join("x")} 来源=${weightKg > 0 ? "basics" : (finalWeightKg > 0 ? "页面文本" : "无")}`, finalWeightKg > 0 ? "info" : "warn"));
    const data = {
      title: String(basics.title || media.title || "").slice(0, 300),
      images: media.images || [],
      detailImages: media.detailImages || [],
      skus,
      attributes,
      vendorCode: String(attributes["货号"] || attributes["商品货号"] || attributes["型号"] || media.vendorCode || "").slice(0, 120),
      weightKg: finalWeightKg,
      lengthCm: finalDims[0],
      widthCm: finalDims[1],
      heightCm: finalDims[2],
      priceText: String(basics.price || ""),
      priceDetails: String(basics.priceDetails || ""),
      moq: String(basics.minOrderQuantity || ""),
      url: location.href,
      collectedAt: new Date().toISOString(),
    };
    if (!data.title) throw new Error("未采集到商品标题（页面结构变化或需要登录）");
    return data;
  } finally {
    active1688TabIds.delete(tab.id);
    await safeRemoveTab(tab.id);
  }
}

// 在 1688 商品详情页上下文执行：只负责图集 / 详情图 / SKU 列表 / 结构化属性（其余交给 extract1688DetailData）
function extract1688ListingMedia() {
  const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
  const uniq = (arr) => arr.filter((u, i, a) => u && a.indexOf(u) === i);
  const sliceJson = (text, startIdx) => {
    let depth = 0, inStr = false, esc = false;
    for (let i = startIdx; i < text.length; i += 1) {
      const ch = text[i];
      if (inStr) { if (esc) { esc = false; continue; } if (ch === "\\") { esc = true; continue; } if (ch === '"') inStr = false; continue; }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "{" || ch === "[") depth += 1;
      else if (ch === "}" || ch === "]") { depth -= 1; if (depth === 0) return text.slice(startIdx, i + 1); }
    }
    return "";
  };
  const extractInline = (key, wantArray) => {
    for (const node of Array.from(document.querySelectorAll("script"))) {
      const text = node.textContent || "";
      if (text.length < 1200 || !text.includes(`"${key}"`)) continue;
      const at = text.indexOf(`"${key}"`);
      const idx = wantArray ? text.indexOf("[", at) : text.indexOf("{", at);
      if (idx < 0) continue;
      const raw = sliceJson(text, idx);
      if (!raw) continue;
      try { return JSON.parse(raw); } catch (_e) { /* 试下一个 script */ }
    }
    return null;
  };
  const num = (v) => { const n = Number(String(v ?? "").replace(/[^\d.]/g, "")); return Number.isFinite(n) ? n : 0; };

  // 图集（主图）：内联 JSON → DOM 兜底
  const imageUrls = [];
  const pushImgs = (list) => {
    for (const it of (Array.isArray(list) ? list : [])) {
      const u = typeof it === "string" ? it : (it?.fullPathImageURI || it?.imageURI || it?.url || it?.original || "");
      if (u && /^https?:/i.test(u)) imageUrls.push(String(u));
    }
  };
  pushImgs(extractInline("images", true));
  const galleryJson = extractInline("gallery", false);
  if (galleryJson && typeof galleryJson === "object") pushImgs(galleryJson.images || galleryJson.offerImgList);
  if (imageUrls.length < 3) {
    for (const img of Array.from(document.querySelectorAll('img[src*="alicdn"], img[data-src*="alicdn"]'))) {
      const u = img.currentSrc || img.src || img.getAttribute("data-src") || "";
      if (!/(cbu01|img\.alicdn|sc01|sc02)/i.test(u)) continue;
      if ((img.naturalWidth || 0) < 150) continue;
      imageUrls.push(u);
    }
  }
  // 只裁掉末尾的尺寸后缀（_120x120.jpg），保留 _!!<sellerid>-0-cib.jpg 主体 —— 否则图片 URL 失效，
  //   Yandex 会报「Нет изображения / 无图片无法开卖」。
  const normalizeImg = (u) => String(u)
    .replace(/_\(\d+x\d+\)\.(jpg|jpeg|png|webp)$/i, "")
    .replace(/\.(jpg|jpeg|png|webp)_\d+x\d+\.(jpg|jpeg|png|webp)$/i, ".$1");
  const images = uniq(imageUrls.map(normalizeImg)).slice(0, 20);

  // 详情图（描述区）
  const detailImages = uniq(Array.from(document.querySelectorAll(
    '#description img, #desc-lazyload-container img, .desc-lazyload-container img, [class*="detail-desc"] img, [class*="desc-container"] img, [class*="offer-desc"] img, [class*="detailContent"] img'
  )).map((img) => img.currentSrc || img.src || img.getAttribute("data-src") || "")
    .filter((u) => /^https?:/i.test(u) && /(alicdn|1688)/i.test(u))).slice(0, 40);

  // SKU：规格 + 价格 + 库存 + SKU 图
  const skuMap = extractInline("skuInfoMap", false) || {};
  const skus = Object.entries(skuMap).map(([key, v]) => ({
    spec: clean(v?.specAttrs || key).slice(0, 80),
    priceCny: num(v?.price ?? v?.discountPrice ?? v?.salePrice),
    stock: num(v?.canBookCount) || 0,
    image: String(v?.image || v?.skuImageURI || v?.imageUrl || ""),
    skuId: String(v?.skuId || ""),
  })).filter((sku) => sku.spec);

  // 结构化商品属性（productAttributes.product_attributes 优先）
  const attributes = {};
  const attrRaw = extractInline("productAttributes", false) || extractInline("product_attributes", false) || {};
  const attrSource = attrRaw?.product_attributes || attrRaw?.data?.product_attributes || attrRaw;
  if (attrSource && typeof attrSource === "object" && !Array.isArray(attrSource)) {
    for (const [k, v] of Object.entries(attrSource)) {
      const value = clean(typeof v === "object" ? (v?.value ?? v?.text ?? v?.name ?? "") : v);
      if (k && value && String(k).length <= 40) attributes[clean(k)] = value.slice(0, 200);
    }
  }
  // DOM 表格兜底（只取像属性的行：键短、值短、不是卖家指标）
  for (const row of Array.from(document.querySelectorAll("tr"))) {
    const cells = Array.from(row.children).map((c) => clean(c.innerText)).filter(Boolean);
    if (cells.length !== 2) continue;
    const [k, v] = cells;
    if (!k || k.length > 20 || attributes[k] !== undefined) continue;
    if (/(揽收率|代发热度|分销商数|复购率|加购|收藏|浏览|访客|回头率|退款率|好评率|支付率|库存|价格|起批)/.test(k)) continue;
    if (!v || v.length > 100) continue;
    attributes[k] = v;
  }

  const vendorCode = clean(attributes["货号"] || attributes["商品货号"] || attributes["型号"] || "");
  const title = clean(document.querySelector('meta[property="og:title"]')?.content || document.title).replace(/\s*[-_]\s*阿里巴巴.*$/i, "").slice(0, 200);
  return { images, detailImages, skus, attributes, vendorCode, title, url: location.href };
}

// Yandex 核价任务（kind=yandex-research）：逐项用 1688 官方以图找货返回同款候选（1688 登录态留在本机插件）。
async function runQueuedYandexResearchJob(remoteJob) {
  const payload = remoteJob.payload || {};
  const preciseMode = payload.precise === true; // 全店精核价：必须拿到 1688 真实价格阶梯
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const declaredTotal = Math.max(0, Number(remoteJob.total || rawItems.length || 0));
  const items = declaredTotal > 0 ? rawItems.slice(0, declaredTotal) : rawItems;
  const job = {
    id: remoteJob.id,
    status: "running",
    phase: "插件已领取，开始 Yandex 核价（1688 官方同款）",
    total: items.length,
    // v2.2.9.113: 续跑时保留服务器上已完成的 results（旧逻辑清空 results，导致报告表只剩续跑后的行）
    logs: Array.isArray(remoteJob.logs) ? remoteJob.logs : [],
    results: Array.isArray(remoteJob.results) ? remoteJob.results.slice() : [],
    error: "",
    cancelRequested: false,
    abortController: typeof AbortController === "function" ? new AbortController() : null,
  };
  job.processed = Math.min(Math.max(Number(remoteJob.processed || 0), job.results.length), items.length);
  if (!Array.isArray(job.logs)) job.logs = [];
  job.logs.push(makeLog(`逐梦插件 v${VERSION} 已领取 Yandex 核价任务（${items.length} 项${job.processed > 0 ? `，从第 ${job.processed + 1} 项续跑` : ""}）。`));
  await setActiveSourcingJob(job);
  await reportSourcingProgress(job);
  const stopCancelMonitor = startSourcingCancelMonitor(job);
  try {
    for (let index = job.processed; index < items.length; index += 1) {
      if (job.cancelRequested) break;
      const item = items[index] || {};
      const offerId = String(item.offerId || "");
      const images = Array.isArray(item.images) ? item.images.filter(Boolean) : [];
      const result = { offerId, name: item.name || "", candidates: [], searchError: "" };
      job.phase = `1688 搜图 ${index + 1}/${items.length}`;
      job.logs.push(makeLog(`为货号 ${offerId} 搜索 1688 同款（${images.length} 张图）`));
      await reportSourcingProgress(job);
      try {
        if (!offerId) throw new Error("缺少 offerId");
        if (!images.length) throw new Error("无商品图");
        const seen = new Set();
        let imgIndex = 0;
        for (const img of images) {
          if (job.cancelRequested) break;
          imgIndex += 1;
          const stepStarted = Date.now();
          const step = await withSourcingStepTimeout(job, `1688 核价搜图 ${offerId}`, 120_000,
            () => search1688ByImageInPlugin(img, 3, job, { lightMode: true }));
          const stepMs = Date.now() - stepStarted;
          const stepOk = !!(step && step.success === true && Array.isArray(step.candidates));
          const stepErr = String((step && (step.error || step.message)) || (step ? "" : "搜图步骤无返回（可能被超时中断）")).slice(0, 200);
          if (stepOk) {
            for (const c of step.candidates) {
              const oid = String(c?.offerId || c?.id || c?.itemId || "");
              if (!oid || seen.has(oid)) continue;
              seen.add(oid);
              result.candidates.push({ source: "plugin-1688", ...c });
            }
            // 精核价：采购价必须取自 1688 真实价格阶梯首档。轻量模式只为第 1 个候选开详情页，
            // 但候选会按起批量重排，重排后的榜首可能没详情 → 补开它的详情页，避免用搜索列表的引流价。
            if (preciseMode && result.candidates.length) {
              try {
                const bestCand = result.candidates[0];
                const hasTier = Array.isArray(bestCand.priceTiers) && bestCand.priceTiers.length > 0;
                if (!hasTier) {
                  const details = await scrape1688CandidateDetailsInPlugin(bestCand, job, { lightMode: true });
                  const merged = addTrafficBaitAssessmentInPlugin(merge1688CandidateDetailsInPlugin(bestCand, details));
                  result.candidates[0] = { source: "plugin-1688", ...merged };
                  const ladder = Array.isArray(merged.priceTiers) && merged.priceTiers.length
                    ? merged.priceTiers.map((t) => `${t.beginAmount}件起¥${t.price}`).join("; ")
                    : "未取到";
                  job.logs.push(makeLog(`货号 ${offerId} 榜首候选补详情页：价格阶梯 ${ladder}`, merged.priceTiers?.length ? "info" : "warn"));
                }
              } catch (e) {
                job.logs.push(makeLog(`货号 ${offerId} 榜首候选补详情页失败：${(e?.message || String(e)).slice(0, 120)}`, "warn"));
              }
            }
            job.logs.push(makeLog(`货号 ${offerId} 第 ${imgIndex}/${images.length} 张图搜 OK：接口返回 ${step.candidates.length} 个原始候选（${stepMs}ms）` + (step.candidates[0]
              ? `；首候选 keys=[${Object.keys(step.candidates[0]).join(",")}] oid="${String(step.candidates[0]?.offerId || step.candidates[0]?.id || step.candidates[0]?.itemId || step.candidates[0]?.offerId1688 || "")}" img="${String((step.candidates[0]?.image || step.candidates[0]?.img || "").slice(0, 60))}"`
              : "；候选对象为空"), "info"));
          } else {
            if (!result.candidates.length) result.searchError = stepErr || "1688 搜图无结果";
            job.logs.push(makeLog(`货号 ${offerId} 第 ${imgIndex}/${images.length} 张图未命中：${stepErr || "接口返回空结果"}（${stepMs}ms）。`, "warn"));
          }
          if (result.candidates.length) break; // 首张命中即不再搜后续图
        }
        job.logs.push(makeLog(result.candidates.length
          ? `货号 ${offerId} 找到 ${result.candidates.length} 个 1688 同款候选。`
          : `货号 ${offerId} 未找到同款：${result.searchError || "无候选"}`, result.candidates.length ? "info" : "warn"));
      } catch (e) {
        result.searchError = (e?.message || String(e)).slice(0, 300);
        job.logs.push(makeLog(`货号 ${offerId} 搜图失败：${result.searchError}`, "error"));
      }
      job.results.push(result);
      job.processed = Math.min(index + 1, job.total);
      job.phase = `已完成 ${job.processed}/${job.total}`;
      await reportSourcingProgress(job);
    }
  } finally {
    stopCancelMonitor();
  }
  job.status = job.cancelRequested ? "canceled" : (job.results.some((r) => r.candidates.length) ? "done" : "error");
  job.error = job.status === "error" ? "全部未找到 1688 同款" : "";
  job.phase = job.status === "done" ? "已完成，正在收尾" : (job.status === "canceled" ? "已停止" : "全部未匹配");
  await completeSourcingJob(job);
}

async function pollSourcingQueueOnce() {
  if (sourcingBusy) return;
  sourcingBusy = true;
  try {
    const activeJob = await getActiveSourcingJob();
    const currentPhase = activeJob?.id
      ? (activeJob.phase || "单品找货任务仍在执行，保持任务租约")
      : "逐梦插件在线，可领取单品找货任务";
    const data = await erpApi("/api/worker/jobs/next", {
      method: "POST",
      body: { ...workerMeta(currentPhase), currentJobId: activeJob?.id || "", kinds: ["run", "yandex-research", "yandex-collect"] },
    });
    if (data.job) {
      console.log(`[SW ${VERSION}] 领取任务: ${data.job.id} kind=${data.job.kind}`);
      if (data.job.kind === "yandex-research") await runQueuedYandexResearchJob(data.job);
      else if (data.job.kind === "yandex-collect") await runQueuedYandexCollectJob(data.job);
      else await runQueuedSourcingJob(data.job);
    }
  } catch (e) {
    const msg = e.message || String(e);
    if (!/请先登录|401/.test(msg)) console.warn(`[SW ${VERSION}] 单品找货轮询失败: ${msg}`);
  } finally {
    sourcingBusy = false;
  }
}

function startSourcingQueueLoop() {
  if (sourcingQueueLoopStarted) {
    // 已启动：仅重置一次快速轮询（取消旧链再开新链，避免多条并行）
    quickPollToken += 1;
    const myToken = quickPollToken;
    const quickPollAgain = () => {
      if (myToken !== quickPollToken) return;
      pollSourcingQueueOnce().catch((e) => {
        console.warn(`[SW ${VERSION}] 快速领取轮询失败: ${e.message || e}`);
      }).finally(() => {
        if (myToken === quickPollToken) setTimeout(quickPollAgain, 4000);
      });
    };
    setTimeout(quickPollAgain, 400);
    return;
  }
  sourcingQueueLoopStarted = true;
  chrome.alarms.create("zhumeng-single-sourcing", { periodInMinutes: 0.5 });
  // 领取提速：SW 存活期间每 4s 快速轮询几次（alarm 0.5min 是 MV3 下限，单靠它领取最坏等 30s）。
  // 链式 setTimeout 在 SW 休眠后自动停止，由 alarm 再次唤醒兜底，不影响 MV3 生命周期约束。
  quickPollToken += 1;
  const myToken = quickPollToken;
  const quickPoll = () => {
    if (myToken !== quickPollToken) return;
    pollSourcingQueueOnce().catch((e) => {
      console.warn(`[SW ${VERSION}] 快速领取轮询失败: ${e.message || e}`);
    }).finally(() => {
      if (myToken === quickPollToken) setTimeout(quickPoll, 4000);
    });
  };
  setTimeout(() => quickPoll(), 800);
}

async function run1688ImageSearchQueued(fn) {
  const previous = imageSearchQueue.catch(() => {});
  let release = () => {};
  imageSearchQueue = new Promise((resolve) => { release = resolve; });
  // v2.2.9.101 (fix): 前一个 1688 搜索若卡死未 resolve，后续任务会永久等队列 → 加 90s 上限，超时强制放行
  await Promise.race([
    previous,
    new Promise((resolve) => setTimeout(resolve, 90000)),
  ]);
  try {
    const cooldown = adaptiveCooldownMs();
    const baseGap = last1688SearchAt ? 0 : randomInt(2_000, 5_000);
    const waitMs = Math.max(baseGap, last1688SearchAt + cooldown - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    return await fn();
  } finally {
    last1688SearchAt = Date.now();
    release();
  }
}

function compact1688ErrorInPlugin(message) {
  const text = String(message || "").replace(/\s+/g, " ").trim();
  if (!text) return "1688 搜图失败";
  if (/store image error/i.test(text)) return "1688 图片入库失败（store image error），已触发会话恢复";
  if (/FAIL_SYS_ILLEGAL_ACCESS|非法请求/i.test(text)) return "1688 接口非法请求，已触发 token/cookie 刷新";
  if (/没有 imageId|未返回 imageId|imageId/i.test(text)) return "1688 上传图片后未返回 imageId";
  if (/token|_m_h5_tk|令牌/i.test(text)) return "1688 token 失效或未获取";
  if (/Tabs cannot be edited|user may be dragging a tab/i.test(text)) return "Chrome 标签页临时锁定，请稍后重试";
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

function isCritical1688BlockerInPlugin(message) {
  return /验证码|滑块|安全验证|人机验证|captcha|verify|robot|punish|请先.*1688.*登录|1688.*登录|没有拿到 1688 搜图 token|token 失效/i.test(String(message || ""));
}

async function recover1688SessionInPlugin(reason, attempt) {
  last1688FailureAt = Date.now();
  const reasonText = compact1688ErrorInPlugin(reason);
  pushRiskEvent(isCritical1688BlockerInPlugin(reasonText));
  console.warn(`[SW ${VERSION}] 1688 会话恢复 attempt=${attempt}: ${reasonText}`);
  await sleep(randomInt(3500, 8000) * Math.min(attempt, 3));
  if (Date.now() < criticalRiskHoldUntil) return;  // 风控暂停期不主动 seed，避免再触发
  await seed1688MtopTokenInPlugin().catch((e) => console.warn(`[SW ${VERSION}] 1688 token seed 恢复失败: ${e.message}`));
  await get1688CookieStateInPlugin().catch((e) => console.warn(`[SW ${VERSION}] 1688 cookie 读取失败: ${e.message}`));
}

async function search1688ByImageInPlugin(imageUrl, maxCandidates, job = null, opts = {}) {
  return run1688ImageSearchQueued(() => search1688ByImageInPluginInternal(imageUrl, maxCandidates, job, opts));
}

async function search1688ByImageInPluginInternal(imageUrl, maxCandidates, job = null, opts = {}) {
  try {
    assertSourcingNotCanceled(job);
    let state = await ensure1688CookieStateInPlugin(false);
    assertSourcingNotCanceled(job);
    if (!state.token) {
      return { success: false, error: "没有拿到 1688 搜图 token。请先在当前 Chrome 登录 1688，再回到 ERP 重新执行任务。" };
    }
    const base64Image = await fetchImageAsBase64(imageUrl, job);
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        assertSourcingNotCanceled(job);
        const candidates = await collect1688CandidatesInPlugin(base64Image, state, maxCandidates, job, opts);
        const ranked = rank1688CandidatesForOzonInPlugin(candidates).slice(0, maxCandidates);
        if (ranked.length) { clear1688Success(); return { success: true, candidates: ranked }; }
        return { success: false, error: "1688 接口搜图未返回候选" };
      } catch (error) {
        lastError = error;
        const message = error?.message || String(error);
        if (/任务已停止/.test(message)) throw error;
        if (attempt >= 2 || !is1688RefreshableError(message) || isCritical1688BlockerInPlugin(message)) break;
        await recover1688SessionInPlugin(message, attempt);
        state = await ensure1688CookieStateInPlugin(false);
      }
    }
    return { success: false, error: compact1688ErrorInPlugin(lastError?.message || lastError || "1688 搜图失败") };
  } catch (e) {
    return { success: false, error: compact1688ErrorInPlugin(e.message || String(e)) };
  }
}

async function create1688SearchTabInPlugin(searchUrl) {
  // 单品找货只使用插件自建临时 tab，避免改写用户手动登录/验证中的 1688 页面。
  const tab = await createTabWithRetry({ url: searchUrl, active: false }, "打开 1688 以图搜货页");
  if (tab?.id) active1688TabIds.add(tab.id);
  return { id: tab.id, ephemeral: true };
}

async function close1688SearchTabInPlugin(tab) {
  if (!tab?.id || !tab.ephemeral) return;
  active1688TabIds.delete(tab.id);
  await safeRemoveTab(tab.id);
}

async function search1688ByImageViaPageInPlugin(imageUrl, maxCandidates) {
  const searchUrl = `https://s.1688.com/youyuan/index.htm?tab=imageSearch&__jzcOzonImg=${encodeURIComponent(imageUrl)}`;
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const tab = await create1688SearchTabInPlugin(searchUrl);
    try {
      await waitForTabComplete(tab.id, 45000);
      await sleep(randomInt(2500, 5500));
      const browseResult = await humanBrowse1688TabInPlugin(tab.id, "1688 以图搜货页", {
        minDurationMs: 3500,
        maxDurationMs: 8000,
        returnTop: true,
      });
      if (browseResult?.verification) {
        return { success: false, error: "1688 出现验证码/安全验证，请在当前 Chrome 手动完成验证后重试" };
      }
      const base64Image = await fetchImageAsBase64(imageUrl);
      const [execResult] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: search1688ImageInPageContext,
        args: [base64Image, Math.max(1, Number(maxCandidates) || 5)],
      });
      const result = execResult?.result || {};
      if (!result.success) {
        return { success: false, error: result.error || "1688 页面会话未返回结果" };
      }
      const rawItems = Array.isArray(result.items) ? result.items : [];
      const pageItems = result.imageId
        ? await collect1688RenderedPageItemsInPlugin(tab.id, result.imageId, maxCandidates).catch((error) => {
            console.warn(`[SW ${VERSION}] 1688 结果页 DOM 读取失败: ${compact1688ErrorInPlugin(error.message || error)}`);
            return [];
          })
        : [];
      const candidates = (pageItems.length ? pageItems : rawItems)
        .map((item, index) => normalize1688OfferItemInPlugin(item, index))
        .filter(item => item.link || item.title);
      if (!candidates.length) {
        return { success: false, error: result.imageId ? `1688 页面会话 imageId=${result.imageId} 未返回候选` : "1688 页面会话候选为空" };
      }
      const enriched = await enrich1688CandidatesInPlugin(candidates.slice(0, maxCandidates));
      return { success: true, candidates: rank1688CandidatesForOzonInPlugin(enriched).slice(0, maxCandidates) };
    } catch (error) {
      lastError = error;
      if (!isMissingChromeTabError(error) || attempt >= 2) throw error;
      console.warn(`[SW ${VERSION}] 1688 搜图页 tab 已失效，重建临时 tab 后重试一次: ${error.message || error}`);
      await sleep(randomInt(800, 1800));
    } finally {
      await close1688SearchTabInPlugin(tab);
    }
  }
  throw lastError || new Error("1688 页面会话搜图失败");
}

async function collect1688RenderedPageItemsInPlugin(tabId, imageId, maxCandidates) {
  const resultUrl = `https://s.1688.com/youyuan/index.htm?tab=imageSearch&imageId=${encodeURIComponent(String(imageId))}&imageIdList=${encodeURIComponent(String(imageId))}`;
  await withChromeTabEditRetry("打开 1688 搜图结果页", () => chrome.tabs.update(tabId, { url: resultUrl, active: false }));
  await waitForTabComplete(tabId, 60000);
  await sleep(randomInt(2500, 5000));
  const browseResult = await humanBrowse1688TabInPlugin(tabId, "1688 搜图结果页", {
    minDurationMs: 5500,
    maxDurationMs: 13000,
    dwellChance: 0.34,
  });
  if (browseResult?.verification) {
    throw new Error("1688 搜图结果页出现验证码/安全验证，请手动完成验证后重试");
  }
  const [execResult] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extract1688RenderedOffersInPageContext,
    args: [Math.max(1, Number(maxCandidates) || 5)],
  });
  return Array.isArray(execResult?.result) ? execResult.result : [];
}

function extract1688RenderedOffersInPageContext(maxCandidates) {
  const normalizeUrl = (value) => {
    const text = String(value || "").trim();
    if (!text) return "";
    if (text.startsWith("//")) return `https:${text}`;
    if (/^https?:\/\//i.test(text)) return text;
    try { return new URL(text, location.href).href; } catch (_) { return text; }
  };
  const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const looksLikeOffer = (value) => {
    if (!value || typeof value !== "object") return false;
    const data = value.data || value;
    return Boolean(data.offerId || data.linkUrl || data.detailUrl || data.sameDesignUrl || data.title || data.subject || data.offerTitle || data.picUrl || data.offerPicUrl);
  };
  const findItems = (value, depth = 0) => {
    if (!value || depth > 8) return [];
    if (Array.isArray(value)) {
      const offers = value.filter(looksLikeOffer);
      if (offers.length >= 2) return offers;
      for (const child of value) {
        const found = findItems(child, depth + 1);
        if (found.length) return found;
      }
      return offers;
    }
    if (typeof value === "object") {
      const direct = value.OFFER?.items || value.offer?.items || value.items || value.list || value.result || value.data?.items || value.data?.list;
      const foundDirect = findItems(direct, depth + 1);
      if (foundDirect.length) return foundDirect;
      for (const child of Object.values(value).slice(0, 120)) {
        const found = findItems(child, depth + 1);
        if (found.length) return found;
      }
    }
    return [];
  };
  const parseJsonCandidates = () => {
    const out = [];
    const scripts = Array.from(document.scripts || []);
    for (const script of scripts) {
      const text = script.textContent || "";
      if (!/offerId|imageSearch|sameDesignUrl|detail\.1688\.com/.test(text)) continue;
      const assignments = [
        /window\.__INIT_DATA\s*=\s*({[\s\S]*?})\s*<\/script>/,
        /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*;/,
        /window\.searchData\s*=\s*({[\s\S]*?})\s*;/,
      ];
      for (const re of assignments) {
        const match = text.match(re);
        if (!match) continue;
        try {
          const found = findItems(JSON.parse(match[1]));
          if (found.length) out.push(...found);
        } catch (_) {}
      }
      if (out.length) break;
    }
    return out;
  };
  const parseDomCandidates = () => {
    const anchors = Array.from(document.querySelectorAll('a[href*="detail.1688.com/offer/"]'));
    const seen = new Set();
    const items = [];
    for (const anchor of anchors) {
      const link = normalizeUrl(anchor.getAttribute("href") || anchor.href);
      const offerId = (link.match(/offer\/(\d+)/) || [])[1] || "";
      const key = offerId || link;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const card = anchor.closest('[class*="offer"], [class*="item"], [class*="card"], [class*="list"], li, div') || anchor;
      const img = card.querySelector("img") || anchor.querySelector("img");
      const title = cleanText(anchor.getAttribute("title") || anchor.textContent || card.querySelector('[title]')?.getAttribute("title") || card.textContent).slice(0, 180);
      const cardText = cleanText(card.textContent);
      const price = (cardText.match(/(?:¥|￥)\s*([0-9]+(?:\.[0-9]+)?)/) || cardText.match(/([0-9]+(?:\.[0-9]+)?)\s*元/ ) || [])[1] || "";
      items.push({ offerId, title, subject: title, linkUrl: link, picUrl: normalizeUrl(img?.currentSrc || img?.src || img?.getAttribute("data-src") || ""), price });
      if (items.length >= Math.max(1, Number(maxCandidates) || 5)) break;
    }
    return items;
  };
  const items = parseJsonCandidates().concat(parseDomCandidates());
  const seen = new Set();
  return items.filter((item) => {
    const data = item?.data || item || {};
    const link = data.linkUrl || data.detailUrl || data.sameDesignUrl || data.url || "";
    const offerId = data.offerId || (String(link).match(/offer\/(\d+)/) || [])[1] || "";
    const key = offerId || link || data.title || data.subject;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, Math.max(1, Number(maxCandidates) || 5));
}

async function search1688ImageInPageContext(base64Image, maxCandidates) {
  const sleepInPage = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const getRequestCandidates = () => {
    const candidates = [];
    const mtop = (((window || {}).lib || {}).mtop || {});
    const searchSpace = ((window || {}).searchSpace || {});
    if (mtop.config) {
      mtop.config.prefix = "h5api";
      mtop.config.mainDomain = "1688.com";
      mtop.config.subDomain = location.href.includes("__mtop_subdomain__=wapa") ? "wapa" : "m";
    }
    if (typeof mtop.request === "function") candidates.push({ name: "lib.mtop.request", owner: mtop, request: mtop.request });
    if (typeof searchSpace.request === "function" && searchSpace.request !== mtop.request) candidates.push({ name: "searchSpace.request", owner: searchSpace, request: searchSpace.request });
    return candidates;
  };
  const waitForRequestCandidates = async () => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const candidates = getRequestCandidates();
      if (candidates.length) return candidates;
      await sleepInPage(500);
    }
    return [];
  };
  const extractPayload = (response) => response && response.data ? response.data : response;
  const requestWithCandidates = async (requestCandidates, options, label) => {
    let lastError = null;
    for (const candidate of requestCandidates) {
      try {
        return await candidate.request.call(candidate.owner || window, options);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error(`${label} failed`);
  };
  const findItems = (value, depth = 0) => {
    if (!value || depth > 6) return [];
    if (Array.isArray(value)) {
      const looksLikeOffers = value.filter(item => item && typeof item === "object" && (item.data?.offerId || item.data?.linkUrl || item.offerId || item.linkUrl || item.title || item.subject));
      if (looksLikeOffers.length) return looksLikeOffers;
      for (const child of value) {
        const found = findItems(child, depth + 1);
        if (found.length) return found;
      }
      return [];
    }
    if (typeof value === "object") {
      const direct = value.OFFER?.items || value.offer?.items || value.items || value.list || value.result;
      const foundDirect = findItems(direct, depth + 1);
      if (foundDirect.length) return foundDirect;
      for (const child of Object.values(value).slice(0, 80)) {
        const found = findItems(child, depth + 1);
        if (found.length) return found;
      }
    }
    return [];
  };

  try {
    const imageBase64 = String(base64Image || "").replace(/^data:image\/[^;]+;base64,/i, "");
    if (!imageBase64) return { success: false, error: "missing image base64" };
    const requestCandidates = await waitForRequestCandidates();
    if (!requestCandidates.length) return { success: false, error: "1688 页面 mtop/searchSpace request 不可用" };

    const uploadResponse = await requestWithCandidates(requestCandidates, {
      api: "mtop.relationrecommend.WirelessRecommend.recommend",
      ignoreLogin: true,
      prefix: "h5api",
      data: {
        appId: 32517,
        params: JSON.stringify({
          searchScene: "imageEx",
          interfaceName: "imageBase64ToImageId",
          "serviceParam.extendParam[imageBase64]": imageBase64,
          subChannel: "pc_image_search_image_id",
        }),
      },
      v: "2.0",
      ecode: 0,
      type: "POST",
      dataType: "jsonp",
      jsonpIncPrefix: "search1688",
      timeout: 20000,
      trackerConfig: { requestCode: "32517_imageBase64ToImageId" },
    }, "upload image");
    const uploadData = extractPayload(uploadResponse);
    const imageId = uploadData?.imageId || uploadData?.data?.imageId || uploadData?.result?.[0]?.imageId;
    if (!imageId) return { success: false, error: `页面上传成功但没有 imageId: ${JSON.stringify(uploadData).slice(0, 500)}` };

    await sleepInPage(800);
    const searchResponse = await requestWithCandidates(requestCandidates, {
      api: "mtop.relationrecommend.WirelessRecommend.recommend",
      ignoreLogin: true,
      prefix: "h5api",
      data: {
        appId: 32517,
        params: JSON.stringify({
          beginPage: 1,
          pageSize: Math.max(20, Math.min(60, Number(maxCandidates) || 5)),
          method: "imageOfferSearchService",
          searchScene: "pcImageSearch",
          appName: "pctusou",
          tab: "imageSearch",
          imageId: String(imageId),
          imageIdList: String(imageId),
          sortType: "normal",
        }),
      },
      v: "2.0",
      ecode: 0,
      type: "GET",
      dataType: "jsonp",
      jsonpIncPrefix: "reqTppId_32517_getOfferList",
      timeout: 20000,
      trackerConfig: { requestCode: "32517_imageOfferSearchService" },
    }, "search offers");
    const searchData = extractPayload(searchResponse);
    const items = findItems(searchData).slice(0, Math.max(1, Number(maxCandidates) || 5));
    return { success: true, imageId: String(imageId), items };
  } catch (error) {
    return { success: false, error: (error && error.message) || String(error) };
  }
}

function is1688RefreshableError(message) {
  return /FAIL_SYS_ILLEGAL_ACCESS|非法请求|FAIL_SYS_TOKEN|FAIL_SYS_TOKEN_EXPIRED|FAIL_SYS_TOKEN_EXOIRED|_m_h5_tk|token|令牌|store image error|没有 imageId|未返回 imageId|imageId|cookie|login|401|403|TOKEN/i.test(String(message || ""));
}

async function collect1688CandidatesInPlugin(base64Image, cookieState, maxCandidates, job = null, opts = {}) {
  assertSourcingNotCanceled(job);
  const imageId = await uploadImageTo1688InPlugin(base64Image, cookieState, job);
  assertSourcingNotCanceled(job);
  // v2.2.9.108: 找货轻量模式缩短上传后的等待，核价任务不再每次等 1.2-2.8s
  await sleep(opts.lightMode === true ? randomInt(500, 1100) : randomInt(1200, 2800));
  assertSourcingNotCanceled(job);
  const candidates = (await searchOffersByImageIdInPlugin(imageId, cookieState, job)).slice(0, maxCandidates);
  assertSourcingNotCanceled(job);
  return enrich1688CandidatesInPlugin(candidates, job, opts);
}

async function enrich1688CandidatesInPlugin(candidates, job = null, opts = {}) {
  const enriched = [];
  for (const [index, candidate] of candidates.entries()) {
    assertSourcingNotCanceled(job);
    if (index > 0) {
      // v2.2.9.100: 轻量模式(找货)缩短候选间停顿，保留防风控最小间隔
      await sleep(opts.lightMode === true ? randomInt(1200, 3800) : randomInt(2500, 6500));
    }
    assertSourcingNotCanceled(job);
    // v2.2.9.108: 找货轻量模式只为第 1 个候选开详情页补 MOQ/运费，
    //   其余候选直接用搜索接口返回字段（详情 tab 逐个开关是核价慢的主因，报价场景不需要）。
    if (opts.lightMode === true && index > 0) {
      enriched.push(addTrafficBaitAssessmentInPlugin(candidate));
      continue;
    }
    const details = await scrape1688CandidateDetailsInPlugin(candidate, job, opts);
    enriched.push(addTrafficBaitAssessmentInPlugin(merge1688CandidateDetailsInPlugin(candidate, details)));
  }
  return enriched;
}

function normalize1688OfferItemInPlugin(item, index) {
  const data = item?.data || item || {};
  const offerId = data.offerId || data.skuId || data.id || item?.offerId || "";
  const cleanTitle = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const isCompanyTitle = (value) => /(?:有限公司|有限责任公司|商行|工厂|厂|经营部|贸易商|旗舰店|专营店)\s*$/.test(cleanTitle(value));
  const titleCandidates = [
    data.title,
    data.subject,
    data.offerTitle,
    data.shortTitle,
    data.simpleSubject,
    data.name,
    data.itemTitle,
    data.productTitle,
  ].map(cleanTitle).filter(Boolean);
  const moqItem = Array.isArray(data.afterPriceList)
    ? data.afterPriceList.find((entry) => entry.matKey === "quantity_begin")
    : null;
  const title = titleCandidates.find((value) => !isCompanyTitle(value)) || titleCandidates[0] || "";
  const promotionText = collectPromotionTextFromValueInPlugin(data);
  const pack = inferPackQuantityFromTextInPlugin([title, promotionText].join(" "));
  const moqText = moqItem?.text || data.minOrderQuantity || data.moq || data.quantityBegin || data.beginAmount || "";
  return {
    rank: index + 1,
    offerId,
    title,
    price: data.priceInfo?.price || data.price || data.discountPrice || data.salePrice || "",
    image: normalizeUrlInPlugin(data.offerPicUrl || data.odPicUrl || data.mainImage || data.picUrl || data.imageUrl || data.imgUrl || ""),
    link: normalizeUrlInPlugin(data.linkUrl || data.sameDesignUrl || data.detailUrl || data.url || (offerId ? `https://detail.1688.com/offer/${offerId}.html` : "")),
    shopName: data.shop?.text || data.shopAddition?.text || data.loginId || data.sellerName || data.companyName || "",
    moq: moqText,
    minOrderQuantity: moqText,
    promotionText,
    packQuantity: pack.quantity,
    packQuantityEvidence: pack.evidence,
    shippingFee: "",
    dimensionsText: "",
    weightText: "",
    priceDetails: "",
  };
}

async function fetchImageAsBase64(url, job = null) {
  assertSourcingNotCanceled(job);
  const resp = await fetch(url, { credentials: "omit", headers: { Referer: "https://www.ozon.ru/" }, signal: getSourcingAbortSignal(job) });
  if (!resp.ok) throw new Error(`主图下载失败 ${resp.status}`);
  const blob = await resp.blob();
  assertSourcingNotCanceled(job);
  const compressed = await compressImageBlobFor1688InPlugin(blob).catch((error) => {
    console.warn(`[SW ${VERSION}] 1688 搜图主图压缩失败，使用原图: ${error.message || error}`);
    return null;
  });
  const buffer = compressed ? await compressed.arrayBuffer() : await blob.arrayBuffer();
  return arrayBufferToBase64InPlugin(buffer);
}

async function compressImageBlobFor1688InPlugin(blob) {
  if (!blob || typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") return null;
  const bitmap = await createImageBitmap(blob);
  const maxSide = 900;
  const ratio = Math.min(1, maxSide / Math.max(bitmap.width || 1, bitmap.height || 1));
  const width = Math.max(1, Math.round((bitmap.width || 1) * ratio));
  const height = Math.max(1, Math.round((bitmap.height || 1) * ratio));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);
  if (typeof bitmap.close === "function") bitmap.close();
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
}

function arrayBufferToBase64InPlugin(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function get1688CookieStateInPlugin() {
  const urls = ["https://www.1688.com/", "https://s.1688.com/", "https://m.1688.com/", "https://h5api.m.1688.com/"];
  const map = new Map();
  for (const url of urls) {
    const cookies = await chrome.cookies.getAll({ url }).catch(() => []);
    for (const cookie of cookies) map.set(cookie.name, cookie);
  }
  for (const domain of [".1688.com", "1688.com", ".m.1688.com", "h5api.m.1688.com"]) {
    const cookies = await chrome.cookies.getAll({ domain }).catch(() => []);
    for (const cookie of cookies) map.set(`${cookie.domain}:${cookie.name}`, cookie);
  }
  const tokenCookie = Array.from(map.values()).find((cookie) => cookie.name === "_m_h5_tk");
  const token = tokenCookie?.value?.split("_")[0] || "";
  return {
    token,
    cookieHeader: Array.from(map.values()).map(c => `${c.name}=${c.value}`).join("; "),
  };
}

async function ensure1688CookieStateInPlugin(forceRefresh = false) {
  let state = await get1688CookieStateInPlugin();
  if (state.token && !forceRefresh) return state;

  await seed1688MtopTokenInPlugin().catch((e) => console.warn(`[SW ${VERSION}] 1688 token seed 失败: ${e.message}`));
  state = await get1688CookieStateInPlugin();
  return get1688CookieStateInPlugin();
}

async function seed1688MtopTokenInPlugin() {
  const dataStr = JSON.stringify({ appId: 32517, params: JSON.stringify({ beginPage: 1, pageSize: 1, method: "imageOfferSearchService" }) });
  const timestamp = String(Date.now());
  const url = buildMtopUrlInPlugin({
    t: timestamp,
    sign: signMtopInPlugin("", timestamp, dataStr),
    type: "jsonp",
    callback: "mtopjsonpreqSeed",
    dataType: "jsonp",
    data: dataStr,
  });
  await fetch(url, {
    method: "GET",
    headers: build1688HeadersInPlugin("", { Referer: "https://s.1688.com/" }),
    credentials: "include",
  }).catch(() => null);
  await sleep(600);
}

async function uploadImageTo1688InPlugin(base64Image, cookieState, job = null) {
  const imageBase64 = String(base64Image || "").replace(/^data:image\/[^;]+;base64,/i, "");
  const uploadParams = {
    appId: 32517,
    params: JSON.stringify({
      beginPage: 1,
      pageSize: 60,
      searchScene: "pcImageSearch",
      method: "uploadBase64WithRequest",
      appName: "pctusou",
      imageBase64,
      tab: "imageSearch",
      spm: "a26352.b28411319/2508.imagesearch.upload",
      sortType: "normal",
    }),
  };
  let state = cookieState;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      assertSourcingNotCanceled(job);
      const dataStr = JSON.stringify(uploadParams);
      const timestamp = String(Date.now());
      const url = buildMtopUrlInPlugin({
        t: timestamp,
        sign: signMtopInPlugin(state.token, timestamp, dataStr),
        type: "originaljson",
        dataType: "jsonp",
        jsonpIncPrefix: "reqTppId_32517_getOfferList",
      });
      const resp = await fetch(url, {
        method: "POST",
        headers: build1688HeadersInPlugin(state.cookieHeader, { "Content-Type": "application/x-www-form-urlencoded" }),
        credentials: "include",
        signal: sourcingFetchSignal(job),
        body: `data=${encodeURIComponent(dataStr)}`,
      });
      assertSourcingNotCanceled(job);
      const json = parseMtopTextInPlugin(await resp.text());
      assertMtopSuccessInPlugin(json, "上传图片失败");
      const imageId = json.data?.data?.imageId || json.data?.imageId || json.data?.result?.[0]?.imageId;
      if (!imageId) throw new Error(`上传图片失败：${get1688MtopBusinessError(json) || "未返回 imageId"}`);
      return imageId;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error || "");
      if (/任务已停止|当前步骤超时|AbortError|aborted/i.test(message)) throw error;
      if (attempt >= 3 || !is1688RefreshableError(message)) throw error;
      console.warn(`[SW ${VERSION}] 1688 图片上传失败，第 ${attempt}/3 次重试: ${message}`);
      await sleep(1000 * attempt);
      state = await ensure1688CookieStateInPlugin(true);
    }
  }
  throw lastError;
}

async function searchOffersByImageIdInPlugin(imageId, cookieState, job = null) {
  const searchParams = {
    appId: 32517,
    params: JSON.stringify({
      beginPage: 1,
      pageSize: 60,
      method: "imageOfferSearchService",
      searchScene: "pcImageSearch",
      appName: "pctusou",
      tab: "imageSearch",
      imageId,
      imageIdList: imageId,
      sortType: "normal",
    }),
  };
  const dataStr = JSON.stringify(searchParams);
  const timestamp = String(Date.now());
  const url = buildMtopUrlInPlugin({
    t: timestamp,
    sign: signMtopInPlugin(cookieState.token, timestamp, dataStr),
    type: "jsonp",
    callback: "mtopjsonpreqTppId_32517_getOfferList2",
    dataType: "jsonp",
    jsonpIncPrefix: "reqTppId_32517_getOfferList",
    data: dataStr,
  });
  assertSourcingNotCanceled(job);
  const resp = await fetch(url, {
    method: "GET",
    headers: build1688HeadersInPlugin(cookieState.cookieHeader),
    credentials: "include",
    signal: sourcingFetchSignal(job),
  });
  assertSourcingNotCanceled(job);
  const json = parseMtopTextInPlugin(await resp.text());
  assertMtopSuccessInPlugin(json, "搜索 1688 失败");
  const offers = json.data?.data?.OFFER?.items || [];
  return offers.map((item, index) => {
    const data = item.data || {};
    const offerId = data.offerId || data.skuId || "";
    const cleanTitle = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isCompanyTitle = (value) => /(?:有限公司|有限责任公司|商行|工厂|厂|经营部|贸易商|旗舰店|专营店)\s*$/.test(cleanTitle(value));
    const titleCandidates = [
      data.title,
      data.subject,
      data.offerTitle,
      data.shortTitle,
      data.simpleSubject,
      data.name,
      data.itemTitle,
      data.productTitle,
    ].map(cleanTitle).filter(Boolean);
    const moqItem = Array.isArray(data.afterPriceList)
      ? data.afterPriceList.find((entry) => entry.matKey === "quantity_begin")
      : null;
    const title = titleCandidates.find((value) => !isCompanyTitle(value)) || titleCandidates[0] || "";
    const promotionText = collectPromotionTextFromValueInPlugin(data);
    const pack = inferPackQuantityFromTextInPlugin([title, promotionText].join(" "));
    const moqText = moqItem?.text || data.minOrderQuantity || data.moq || "";
    return {
      rank: index + 1,
      offerId,
      title,
      price: data.priceInfo?.price || data.price || "",
      image: normalizeUrlInPlugin(data.offerPicUrl || data.odPicUrl || data.mainImage || data.picUrl || ""),
      link: normalizeUrlInPlugin(data.linkUrl || data.sameDesignUrl || (offerId ? `https://detail.1688.com/offer/${offerId}.html` : "")),
      shopName: data.shop?.text || data.shopAddition?.text || data.loginId || data.sellerName || "",
      moq: moqText,
      minOrderQuantity: moqText,
      promotionText,
      packQuantity: pack.quantity,
      packQuantityEvidence: pack.evidence,
      shippingFee: "",
      dimensionsText: "",
      weightText: "",
      priceDetails: "",
    };
  });
}

async function scrape1688CandidateDetailsInPlugin(candidate, job = null, opts = {}) {
  assertSourcingNotCanceled(job);
  if (!candidate.link) return { detailError: "没有候选链接" };
  const tab = await createTabWithRetry({ url: candidate.link, active: false }, "打开 1688 候选详情页");
  if (tab?.id) active1688TabIds.add(tab.id);
  try {
    assertSourcingNotCanceled(job);
    await waitForTabComplete(tab.id, 45000);
    assertSourcingNotCanceled(job);
    if (opts.lightMode === true) {
      // v2.2.9.100: 找货轻量模式 — 缩短固定等待 + 简化浏览动作(保留少量滚动避免风控)，对齐生产插件速度
      await sleep(randomInt(800, 1600));
      assertSourcingNotCanceled(job);
      await browse1688DetailLightInPlugin(tab.id);
    } else {
      await sleep(randomInt(2200, 5200));
      assertSourcingNotCanceled(job);
      await humanBrowse1688TabInPlugin(tab.id, "1688 候选详情页", {
        minDurationMs: 3200,
        maxDurationMs: 8200,
        dwellChance: 0.18,
        minStep: 360,
        maxStep: 950,
        minDelay: 420,
        maxDelay: 1150,
        mouseMoves: randomInt(1, 3),
      });
    }
    assertSourcingNotCanceled(job);
    const [execResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extract1688DetailData,
      args: [candidate],
    });
    return execResult?.result || {};
  } catch (e) {
    return { detailError: e.message || String(e) };
  } finally {
    active1688TabIds.delete(tab.id);
    await safeRemoveTab(tab.id);
  }
}

// v2.2.9.100: 找货轻量模式的 1688 详情页浏览 — 只做 3 次渐进滚动 + 回到顶部, 约 2-3.5s
async function browse1688DetailLightInPlugin(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        for (let i = 0; i < 3; i += 1) {
          window.scrollBy(0, 400 + Math.floor(Math.random() * 350));
          await delay(380 + Math.floor(Math.random() * 520));
        }
        window.scrollTo(0, 0);
        await delay(300);
      },
    });
  } catch (e) {
    console.warn(`[SW ${VERSION}] 1688 轻量浏览跳过: ${compact1688ErrorInPlugin(e.message || e)}`);
  }
}

function extract1688DetailData(fallback) {
  const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const pick = (...values) => values.map(clean).find(Boolean) || "";
  const isCompanyName = (value) => /(?:有限公司|有限责任公司|商行|工厂|厂|经营部|贸易商|旗舰店|专营店)\s*$/.test(clean(value));
  const pickProductTitle = (...values) => {
    const cleaned = values.map(clean).filter(Boolean)
      .map((value) => value.replace(/\s*[-_]\s*阿里巴巴.*$/i, "").replace(/\s*1688\.com.*$/i, "").trim())
      .filter((value) => value && value.length >= 4 && !isCompanyName(value));
    return cleaned[0] || pick(...values);
  };
  const unwrap = (value) => (value && typeof value === "object" && value.fields ? value.fields : value);
  const asArray = (value) => (Array.isArray(value) ? value : []);
  const normalizeWeightGrams = (value) => {
    const text = clean(value);
    if (!text) return null;
    const match = text.match(/(\d+(?:[.,]\d+)?)\s*(кг|kg|公斤|千克|килограмм(?:а|ов)?|г|g|克|гр|грамм(?:а|ов)?|мг|mg|毫克)(?=$|[\s,.;，。；、/)\]}])/i);
    if (match) {
      const number = Number(match[1].replace(",", "."));
      const unit = match[2].toLowerCase();
      if (!Number.isFinite(number) || number <= 0) return null;
      if (/^(кг|kg|公斤|千克)|килограмм/i.test(unit)) return Math.round(number * 1000);
      if (/^(мг|mg|毫克)/i.test(unit)) return Math.max(1, Math.round(number / 1000));
      return Math.round(number);
    }
    if (/^\d+(?:[.,]\d+)?$/.test(text)) {
      const number = Number(text.replace(",", "."));
      if (!Number.isFinite(number) || number <= 0) return null;
      if (number < 1) return Math.round(number * 1000);
      if (number < 30 && !Number.isInteger(number)) return Math.round(number * 1000);
      return Math.round(number);
    }
    return null;
  };
  const addPair = (attrs, key, value) => {
    const k = clean(key).replace(/[:：]$/, "");
    const v = clean(value);
    if (k && v && k !== v && k.length <= 80 && v.length <= 300) attrs[k] = v;
  };

  const promotionPattern = /首单|首件|首购|新人|新客|新用户|新人价|新客价|首单价|首单减|首购价|立减|满减|优惠|优惠券|券后|领券|补贴|到手价|特价|限时|促销|专享|折扣|discount|coupon|new\s*user|first\s*order/i;
  const raw = window.__INIT_DATA?.data || window.context?.result?.data || window.iDetailData || {};
  const rawText = document.body?.innerText || "";
  const bodyText = clean(rawText);

  const attrs = {};
  const productAttrs = unwrap(raw.productAttributes || {});
  if (productAttrs?.product_attributes) {
    for (const [key, value] of Object.entries(productAttrs.product_attributes)) addPair(attrs, key, value);
  } else if (productAttrs && typeof productAttrs === "object") {
    for (const [key, value] of Object.entries(productAttrs)) {
      if (typeof value === "string" || typeof value === "number") addPair(attrs, key, value);
    }
  }
  const featureAttrs = raw.offerDetail?.featureAttributes || [];
  if (Array.isArray(featureAttrs)) {
    for (const item of featureAttrs) addPair(attrs, item?.name, item?.value);
  }
  for (const row of document.querySelectorAll("dt")) {
    const dd = row.nextElementSibling;
    if (dd) addPair(attrs, row.innerText, dd.innerText);
  }
  for (const row of document.querySelectorAll("tr")) {
    const cells = Array.from(row.children).map((cell) => clean(cell.innerText)).filter(Boolean);
    if (cells.length >= 2) addPair(attrs, cells[0], cells.slice(1).join(" "));
  }
  const getAttr = (...names) => {
    const normalized = names.map((name) => String(name).toLowerCase());
    for (const [key, value] of Object.entries(attrs)) {
      const lower = key.toLowerCase();
      if (normalized.some((name) => lower.includes(name))) return value;
    }
    return "";
  };
  const weightKeyPattern = /(?:weight|unitweight|skuweight|grossweight|netweight|packageweight|pieceweight|重量|克重|毛重|净重|包装重|发货重|商品重|计费重)/i;
  const shippingKeyPattern = /(?:shippingfee|shipping|shiptemplate|postage|postfee|postfeevalue|freight|freightfee|freightprice|freighttemplate|freightmodule|logisticsfee|logisticsinfo|deliveryfee|deliverytemplate|expressfee|templatefee|carriage|totalcost|logistics|delivery|express|运费|物流费|物流|快递费|快递|配送费|配送|发货费|邮费|邮资|运费模板|物流模板)/i;
  const moqKeyPattern = /(?:minorder|minorderqty|minorderquantity|minimumorder|minimumorderquantity|minorderqty|min\s*order\s*qty|min\s*order\s*quantity|minimum\s*purchase|beginamount|startamount|batchnumber|moq|起批|起订|起购|起拍|起订量|起购量|最小起订|最少起批|可批|拿样|代发)/i;
  const primitiveWeightValue = (value) => {
    if (typeof value === "string" || typeof value === "number") return value;
    if (!value || typeof value !== "object") return "";
    return pick(value.value, value.text, value.name, value.title, value.displayValue, value.displayName, value.content);
  };
  const primitiveShippingValue = (value) => {
    if (typeof value === "string" || typeof value === "number") return value;
    if (!value || typeof value !== "object") return "";
    return pick(value.value, value.text, value.name, value.title, value.displayValue, value.displayName, value.displayText, value.content, value.amount, value.price, value.fee, value.cost, value.freight, value.deliveryTemplate, value.templateFee, value.freightTemplate, value.freightModule, value.logisticsInfo, value.postage, value.carriage, value.shipTemplate);
  };
  const pickSourcedWeight = (items) => {
    for (const item of items) {
      const value = item?.value;
      if (value && normalizeWeightGrams(value)) return { value, source: item.source || "" };
    }
    return { value: "", source: "" };
  };
  const findWeightInRaw = (root) => {
    const seen = new Set();
    const stack = [{ key: "", value: root, depth: 0 }];
    const candidates = [];
    let visited = 0;
    while (stack.length && candidates.length < 24 && visited < 2500) {
      const item = stack.pop();
      visited += 1;
      const key = clean(item.key);
      const value = item.value;
      if (value == null || item.depth > 7) continue;
      const candidate = primitiveWeightValue(value);
      if (candidate && weightKeyPattern.test(key) && normalizeWeightGrams(candidate)) {
        candidates.push({ value: candidate, source: `1688原始字段 ${key}` });
      }
      if (typeof value !== "object") continue;
      if (seen.has(value)) continue;
      seen.add(value);
      const entries = Array.isArray(value) ? value.map((child, index) => [String(index), child]) : Object.entries(value);
      for (const [childKey, childValue] of entries.slice(0, 160)) {
        stack.push({ key: key ? `${key}.${childKey}` : childKey, value: childValue, depth: item.depth + 1 });
      }
    }
    return candidates.find((item) => normalizeWeightGrams(item.value)) || { value: "", source: "" };
  };
  const findWeightInBody = () => {
    const match = bodyText.match(/(?:包装重量|发货重量|商品重量|产品重量|计费重量|毛重|净重|克重|重量)\s*[:：]?\s*(\d+(?:[.,]\d+)?\s*(?:kg|公斤|千克|g|克|mg|毫克))/i);
    return match ? { value: match[1], source: "1688页面文本重量" } : { value: "", source: "" };
  };
  const normalizeShippingFee = (value, depth = 0) => {
    if (value == null || depth > 4) return "";
    if (typeof value === "object") {
      const candidates = [
        value.totalCost,
        value.postFeeValue,
        value.shippingFee,
        value.shipTemplate,
        value.postage,
        value.freightFee,
        value.freightPrice,
        value.freightTemplate,
        value.freightModule,
        value.logisticsFee,
        value.logisticsInfo,
        value.deliveryFee,
        value.deliveryTemplate,
        value.expressFee,
        value.templateFee,
        value.carriage,
        value.amount,
        value.price,
        value.fee,
        value.cost,
        value.freight,
        value.value,
        value.displayValue,
        value.displayText,
        value.content,
        value.text,
        value.name,
        value.title,
      ];
      for (const candidate of candidates) {
        const normalized = normalizeShippingFee(candidate, depth + 1);
        if (normalized) return normalized;
      }
      return "";
    }
    const text = clean(value);
    if (!text) return "";
    if (/包邮|免运费|免费配送|卖家承担|free\s*shipping|运费\s*0|物流费\s*0/i.test(text)) return "0";
    const match = text.match(/(?:¥|￥|RMB|CNY)?\s*(\d+(?:[.,]\d+)?)(?:\s*(?:元|块|rmb|cny))?/i);
    if (!match) return "";
    const number = Number(match[1].replace(",", "."));
    if (!Number.isFinite(number) || number > 9999) return "";
    return String(number);
  };
  const pickSourcedShippingFee = (items) => {
    for (const item of items) {
      const value = item?.value;
      if (value) return { value, source: item.source || "" };
    }
    return { value: "", source: "" };
  };
  const findShippingInRaw = (root) => {
    const seen = new Set();
    const stack = [{ key: "", value: root, depth: 0 }];
    let visited = 0;
    while (stack.length && visited < 3000) {
      const item = stack.pop();
      visited += 1;
      const key = clean(item.key);
      const value = item.value;
      if (value == null || item.depth > 7) continue;
      if (shippingKeyPattern.test(key)) {
        const normalized = normalizeShippingFee(value) || normalizeShippingFee(primitiveShippingValue(value));
        if (normalized) return { value: normalized, source: `1688原始字段 ${key}` };
      }
      if (typeof value !== "object") continue;
      if (seen.has(value)) continue;
      seen.add(value);
      const entries = Array.isArray(value) ? value.map((child, index) => [String(index), child]) : Object.entries(value);
      for (const [childKey, childValue] of entries.slice(0, 160)) {
        stack.push({ key: key ? `${key}.${childKey}` : childKey, value: childValue, depth: item.depth + 1 });
      }
    }
    return { value: "", source: "" };
  };
  const findShippingInBody = () => {
    if (/包邮|免运费|免费配送|卖家承担运费/i.test(bodyText)) return { value: "0", source: "1688页面文本包邮" };
    const match = bodyText.match(/(?:运费|物流费用|物流费|快递费|配送费|发货费用|邮费)\s*[:：]?\s*(?:¥|￥|RMB|CNY)?\s*(\d+(?:[.,]\d+)?)(?:\s*(?:元|块|rmb|cny))?/i);
    if (match) return { value: normalizeShippingFee(match[1]), source: "1688页面文本运费" };
    if (/运费模板|物流模板|按地区|按地址|选择地区|选择收货地|联系卖家|待议|到付|运费|物流|快递|配送/i.test(bodyText)) {
      return { value: "未公开/需选择地区", source: "1688页面提示存在运费但金额未公开" };
    }
    return { value: "", source: "" };
  };
  const primitiveMoqValue = (value) => {
    if (typeof value === "string" || typeof value === "number") return value;
    if (!value || typeof value !== "object") return "";
    return pick(value.value, value.text, value.name, value.title, value.displayValue, value.displayName, value.content, value.beginAmount, value.startAmount, value.quantity, value.amount);
  };
  const normalizeMoq = (value) => {
    const text = clean(value).replace(/,/g, " ").replace(/\s+/g, " ").trim();
    if (!text) return "";
    if (/^\d+(?:\.\d+)?$/.test(text)) {
      const number = Number(text);
      return Number.isFinite(number) && number > 0 ? `${Math.ceil(number)}件起批` : "";
    }
    if (/(?:一|1)\s*(?:件|个|只|套|箱|包|pcs?|piece|pieces)?\s*(?:起批|起订|起购|起拍|可批|拿样|代发)|(?:起批|起订|起购|起拍|起订量|起购量|最少起批|最小起订|可批|拿样|代发)\s*[:：]?\s*(?:一|1)(?:\s*(?:件|个|只|套|箱|包|pcs?|piece|pieces))?|(?:min\s*order\s*qty|min\s*order\s*quantity|min(?:imum)?\s*order|minimum\s*purchase|moq)\s*[:：]?\s*1(?:\s*(?:pcs?|piece|pieces))?/i.test(text)) {
      return "1件起批";
    }
    const match = text.match(/(?:^|[^\d])(\d+(?:\.\d+)?)\s*(?:件|个|只|套|箱|包|pcs?|piece|pieces)?\s*(?:起批|起订|起购|起拍|可批|拿样|代发|min\s*order\s*qty|min\s*order\s*quantity|min(?:imum)?\s*order|minimum\s*purchase|moq)/i)
      || text.match(/(?:起批|起订|起购|起拍|起订量|起购量|最少起批|最小起订|可批|拿样|代发|min\s*order\s*qty|min\s*order\s*quantity|min(?:imum)?\s*order|minimum\s*purchase|moq)\s*[:：]?\s*(\d+(?:\.\d+)?)/i);
    if (!match) return "";
    const number = Number(match[1]);
    return Number.isFinite(number) && number > 0 ? `${Math.ceil(number)}件起批` : "";
  };
  const findMoqInRaw = (root) => {
    const seen = new Set();
    const stack = [{ key: "", value: root, depth: 0 }];
    let visited = 0;
    while (stack.length && visited < 3000) {
      const item = stack.pop();
      visited += 1;
      const key = clean(item.key);
      const value = item.value;
      if (value == null || item.depth > 7) continue;
      const candidate = primitiveMoqValue(value);
      if (candidate && moqKeyPattern.test(key)) {
        const normalized = normalizeMoq(candidate);
        if (normalized) return normalized;
        const text = clean(candidate);
        if (text) return text;
      }
      if (typeof value !== "object") continue;
      if (seen.has(value)) continue;
      seen.add(value);
      const entries = Array.isArray(value) ? value.map((child, index) => [String(index), child]) : Object.entries(value);
      for (const [childKey, childValue] of entries.slice(0, 160)) {
        stack.push({ key: key ? `${key}.${childKey}` : childKey, value: childValue, depth: item.depth + 1 });
      }
    }
    return "";
  };

  const mainPrice = unwrap(raw.mainPrice || {});
  const orderParamModel = unwrap(raw.orderParamModel || {});
  const orderParam = orderParamModel.orderParam || {};
  const skuParam = orderParam.skuParam || {};
  const trade = mainPrice.finalPriceModel?.tradeWithoutPromotion || {};
  const priceRanges = [
    ...asArray(skuParam.skuRangePrices),
    ...asArray(trade.offerPriceRanges),
  ].map((item) => ({
    beginAmount: item.beginAmount ?? item.startAmount ?? item.quantity ?? "",
    price: item.price ?? item.discountPrice ?? item.value ?? "",
  })).filter((item) => item.price !== "");

  const skuModel = unwrap(raw.skuModel || raw.rawFusion?.skuSelection || {});
  const skuPrices = Object.values(skuModel.skuInfoMap || {})
    .map((item) => item?.price ?? item?.originalPrice ?? item?.salePrice)
    .filter((value) => value !== undefined && value !== null && value !== "");

  // v2.2.9.111: 1688 详情页改版后 window.__INIT_DATA 为 null，商品数据被内联进 <script> 的 JSON 里。
  //   这里做括号配对解析，取回真实价格阶梯(skuRangePrices) 与各规格价(skuInfoMap)。
  //   没有它就只能退化去抓页面里第一个 ¥ 数字（曾把 ¥1 引流档当成采购价）。
  const parseInlineOfferData = () => {
    const sliceJson = (text, startIdx) => {
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let i = startIdx; i < text.length; i += 1) {
        const ch = text[i];
        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === "\\") { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === "{" || ch === "[") depth += 1;
        else if (ch === "}" || ch === "]") { depth -= 1; if (depth === 0) return text.slice(startIdx, i + 1); }
      }
      return "";
    };
    const extract = (text, key, wantArray) => {
      const at = text.indexOf(`"${key}"`);
      if (at < 0) return null;
      const idx = wantArray ? text.indexOf("[", at) : text.indexOf("{", at);
      if (idx < 0) return null;
      const rawJson = sliceJson(text, idx);
      if (!rawJson) return null;
      try { return JSON.parse(rawJson); } catch (_e) { return null; }
    };
    const tiers = [];
    const skus = [];
    for (const node of Array.from(document.querySelectorAll("script"))) {
      const text = node.textContent || "";
      if (text.length < 2000 || !/"skuRangePrices"|"skuInfoMap"/.test(text)) continue;
      if (!tiers.length) {
        const arr = extract(text, "skuRangePrices", true);
        if (Array.isArray(arr)) {
          for (const item of arr) {
            const price = Number(String(item?.price ?? item?.discountPrice ?? "").replace(/[^\d.]/g, "")) || 0;
            if (price > 0) tiers.push({ beginAmount: Math.max(1, Number(item?.beginAmount) || 1), price });
          }
        }
      }
      if (!skus.length) {
        const map = extract(text, "skuInfoMap", false);
        if (map && typeof map === "object") {
          for (const [key, value] of Object.entries(map)) {
            const price = Number(String(value?.price ?? value?.discountPrice ?? value?.salePrice ?? "").replace(/[^\d.]/g, "")) || 0;
            if (price <= 0) continue;
            skus.push({
              name: clean(value?.specAttrs || value?.name || key).slice(0, 40),
              price,
              stock: Number(value?.canBookCount || 0),
            });
          }
        }
      }
      if (tiers.length && skus.length) break;
    }
    return { tiers, skus };
  };
  const inlineData = parseInlineOfferData();
  const priceTiers = (inlineData.tiers.length
    ? inlineData.tiers
    : priceRanges.map((item) => ({ beginAmount: Math.max(1, Number(item.beginAmount) || 1), price: Number(String(item.price).replace(/[^\d.]/g, "")) || 0 })))
    .filter((tier) => tier.price > 0)
    .sort((a, b) => a.beginAmount - b.beginAmount);
  const skuOptions = inlineData.skus.slice(0, 12);
  const distinctSkuPrices = Array.from(new Set(skuOptions.map((sku) => sku.price)));
  const priceDetails = priceTiers.length
    ? priceTiers.map((tier) => `${tier.beginAmount}件起 ¥${tier.price}`).join("; ")
    : "";
  // 采购价 = 价格阶梯起批首档；单规格统一价的商品直接用该价；否则留空（标待人工，绝不用页面第一个 ¥ 数字兜底）
  const price = priceTiers.length
    ? String(priceTiers[0].price)
    : (distinctSkuPrices.length === 1 ? String(distinctSkuPrices[0]) : "");
  const domPriceText = bodyText.match(/¥\s*(\d+(?:[.,]\d+)?)/)?.[1] || "";

  const promotionLines = rawText.split(/\n+/)
    .map(clean)
    .filter((line) => promotionPattern.test(line) && line.length <= 220)
    .slice(0, 16);
  const collectPromotionSnippets = (value, snippets = [], depth = 0) => {
    if (snippets.length >= 24 || depth > 5 || value == null) return snippets;
    if (typeof value === "string" || typeof value === "number") {
      const text = clean(value);
      if (promotionPattern.test(text) && text.length <= 220) snippets.push(text);
    } else if (Array.isArray(value)) {
      for (const item of value.slice(0, 80)) collectPromotionSnippets(item, snippets, depth + 1);
    } else if (typeof value === "object") {
      for (const [key, child] of Object.entries(value).slice(0, 120)) {
        if (promotionPattern.test(key)) snippets.push(clean(`${key}: ${typeof child === "object" ? "" : child}`));
        collectPromotionSnippets(child, snippets, depth + 1);
      }
    }
    return snippets;
  };
  const promotionText = Array.from(new Set([...promotionLines, ...collectPromotionSnippets(raw)].filter(Boolean))).slice(0, 24).join("；");

  const moqFromPriceRange = priceRanges
    .map((item) => Number(item.beginAmount))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)[0];
  const moqFromDom = bodyText.match(/(\d+)\s*(?:件|个|只|套|箱|包)\s*起批/);
  const minOrderQuantity = pick(
    moqFromPriceRange ? `${moqFromPriceRange}件起批` : "",
    moqFromDom ? `${moqFromDom[1]}件起批` : "",
    getAttr("起批", "起订", "起购", "最小起订", "最少起批", "min order", "moq"),
    findMoqInRaw(raw),
    fallback.moq,
  );

  const packInfo = unwrap(raw.productPackInfo || raw.pieceWeightScale || raw.offerDetail?.pieceWeightScale || {});
  const pieceWeightScale = packInfo.pieceWeightScale || packInfo;
  const scaleInfoList = asArray(pieceWeightScale.pieceWeightScaleInfo || packInfo.pieceWeightScaleInfo);
  const columnList = asArray(pieceWeightScale.columnList || packInfo.columnList);
  const colMap = {};
  for (const col of columnList) {
    const label = clean(col.label || col.title || col.name);
    const name = col.name || col.field || col.key;
    if (!name) continue;
    if (/长|length/i.test(label)) colMap.length = name;
    if (/宽|width/i.test(label)) colMap.width = name;
    if (/高|height/i.test(label)) colMap.height = name;
    if (/重|weight/i.test(label)) colMap.weight = name;
  }
  const firstScale = scaleInfoList.find((item) => item && (
    item[colMap.length] || item.length || item[colMap.width] || item.width ||
    item[colMap.height] || item.height || item[colMap.weight] || item.weight
  )) || {};
  const length = pick(firstScale[colMap.length], firstScale.length, firstScale.long, getAttr("长", "length"));
  const width = pick(firstScale[colMap.width], firstScale.width, getAttr("宽", "width"));
  const height = pick(firstScale[colMap.height], firstScale.height, getAttr("高", "height"));
  const attrDimension = getAttr("尺寸", "规格尺寸", "包装尺寸", "产品尺寸");
  const dimensionsText = length || width || height ? `${length || "-"} x ${width || "-"} x ${height || "-"} cm` : attrDimension;

  const shipping = unwrap(raw.shippingServices || {});
  const freightInfo = shipping.freightInfo || {};
  const skuWeight = freightInfo.skuWeight && typeof freightInfo.skuWeight === "object"
    ? Object.values(freightInfo.skuWeight).find(Boolean)
    : "";
  const pickedWeight = pickSourcedWeight([
    { value: firstScale[colMap.weight], source: "1688规格重量列" },
    { value: firstScale.weight, source: "1688规格weight" },
    { value: firstScale.unitWeight, source: "1688规格unitWeight" },
    { value: firstScale.grossWeight, source: "1688规格grossWeight" },
    { value: firstScale.netWeight, source: "1688规格netWeight" },
    { value: packInfo.unitWeight, source: "1688包装unitWeight" },
    { value: packInfo.grossWeight, source: "1688包装grossWeight" },
    { value: packInfo.netWeight, source: "1688包装netWeight" },
    { value: packInfo.packageWeight, source: "1688包装packageWeight" },
    { value: shipping.unitWeight, source: "1688运费unitWeight" },
    { value: shipping.grossWeight, source: "1688运费grossWeight" },
    { value: shipping.netWeight, source: "1688运费netWeight" },
    { value: shipping.packageWeight, source: "1688运费packageWeight" },
    { value: skuWeight, source: "1688运费skuWeight" },
    { value: getAttr("包装重量", "发货重量", "商品重量", "产品重量", "计费重量", "重量", "克重", "毛重", "净重", "weight"), source: "1688属性重量" },
    findWeightInRaw(raw),
    findWeightInBody(),
  ]);
  const weightRaw = pickedWeight.value;
  const weightGrams = normalizeWeightGrams(weightRaw);
  const pickedShipping = pickSourcedShippingFee([
    { value: normalizeShippingFee(freightInfo), source: "1688运费freightInfo" },
    { value: normalizeShippingFee(shipping), source: "1688运费shippingServices" },
    { value: normalizeShippingFee(freightInfo.totalCost), source: "1688运费freightInfo.totalCost" },
    { value: normalizeShippingFee(freightInfo.postFeeValue), source: "1688运费freightInfo.postFeeValue" },
    { value: normalizeShippingFee(shipping.totalCost), source: "1688运费shippingServices.totalCost" },
    { value: normalizeShippingFee(shipping.postFeeValue), source: "1688运费shippingServices.postFeeValue" },
    { value: normalizeShippingFee(getAttr("运费", "物流费用", "物流费", "快递费", "配送费", "邮费")), source: "1688属性运费" },
    findShippingInRaw(raw),
    findShippingInBody(),
  ]);
  const shippingFee = pickedShipping.value;
  const selectorTitle = pick(
    document.querySelector('[class*="title-text"]')?.innerText,
    document.querySelector('[class*="titleText"]')?.innerText,
    document.querySelector('[class*="offer-title"]')?.innerText,
    document.querySelector('[class*="detail-title"]')?.innerText,
    document.querySelector('[class*="mod-detail-title"]')?.innerText,
    document.querySelector(".d-title")?.innerText,
  );
  const title = pickProductTitle(
    raw.productTitle?.fields?.title,
    raw.productTitle?.title,
    raw.offerDetail?.subject,
    raw.offerDetail?.title,
    raw.subject,
    raw.title,
    selectorTitle,
    document.querySelector('meta[property="og:title"]')?.content,
    document.querySelector("h1")?.innerText,
    document.title,
    fallback.title,
  );

  return {
    title,
    price,
    // v2.2.9.111: 结构化价格证据（起批量→单价 + 各规格价），核价取「起批首档单价」；
    //   混合配件店（如 1个边刷¥1.9 / 1个尘袋¥3.2）由服务端按商品名匹配正确规格，匹配不到就标待人工。
    priceTiers: priceTiers.filter((tier) => tier.price <= 50000),
    skuOptions,
    priceRangeCount: priceTiers.length,
    domPriceText,
    priceDetails,
    minOrderQuantity,
    moq: minOrderQuantity,
    shippingFee,
    shippingFeeSource: pickedShipping.source || (shippingFee ? "页面提示存在运费但金额未公开" : ""),
    dimensionsText,
    weightText: weightGrams ? `${weightGrams} g` : "",
    weightGrams,
    weightSource: pickedWeight.source,
    promotionText,
    detailAttributes: attrs,
  };
}

function normalize1688PriceOnlyInPage(value) {
  const match = String(value || "").match(/(\d+(?:[.,]\d+)?)/);
  return match ? match[1].replace(",", ".") : "";
}

function buildMtopUrlInPlugin(params) {
  const url = new URL(MTOP_URL);
  const defaults = {
    jsv: "2.7.2",
    appKey: MTOP_APP_KEY,
    api: "mtop.relationrecommend.wirelessrecommend.recommend",
    v: "2.0",
    timeout: "20000",
  };
  for (const [key, value] of Object.entries({ ...defaults, ...params })) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function signMtopInPlugin(token, timestamp, dataStr) {
  return md5(`${token}&${timestamp}&${MTOP_APP_KEY}&${dataStr}`);
}

function build1688HeadersInPlugin(_cookieHeader, extra = {}) {
  return {
    Accept: "application/json,text/plain,*/*",
    Referer: "https://s.1688.com/",
    Origin: "https://s.1688.com",
    ...extra,
  };
}

function parseMtopTextInPlugin(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/^[^(]*\(([\s\S]*)\)\s*;?$/);
    if (!match) throw new Error(`接口返回不是 JSON：${String(text || "").slice(0, 300)}`);
    return JSON.parse(match[1]);
  }
}

function assertMtopSuccessInPlugin(json, message) {
  const ret = Array.isArray(json?.ret) ? json.ret.join("; ") : "";
  const businessError = get1688MtopBusinessError(json);
  if (businessError) {
    throw new Error(`${message}：${businessError}`);
  }
  if (!ret.includes("SUCCESS")) {
    throw new Error(`${message}：${ret || "1688 接口未返回 SUCCESS"}`);
  }
}

function get1688MtopBusinessError(json) {
  const data = json?.data;
  const nested = data?.data;
  const success = json?.success ?? data?.success ?? nested?.success;
  const code = json?.code ?? data?.code ?? nested?.code;
  const errorMessage = json?.errorMessage || data?.errorMessage || nested?.errorMessage || "";
  if (success === false || String(code) === "-1" || errorMessage) {
    return errorMessage || `code=${code}`;
  }
  return "";
}

function normalizeUrlInPlugin(url) {
  const text = String(url || "").trim();
  if (!text) return "";
  if (text.startsWith("//")) return `https:${text}`;
  if (text.startsWith("/")) return `https://www.1688.com${text}`;
  return text;
}

function collectPromotionTextFromValueInPlugin(value, snippets = [], depth = 0) {
  if (snippets.length >= 24 || depth > 5 || value == null) return snippets.join("；");
  const pattern = /首单|首件|新人|新客|优惠|优惠券|券后|立减|满减|补贴|特价|限时|促销|折扣|discount|coupon/i;
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).replace(/\s+/g, " ").trim();
    if (pattern.test(text) && text.length <= 220) snippets.push(text);
  } else if (Array.isArray(value)) {
    value.slice(0, 80).forEach(v => collectPromotionTextFromValueInPlugin(v, snippets, depth + 1));
  } else if (typeof value === "object") {
    Object.entries(value).slice(0, 120).forEach(([key, child]) => {
      if (pattern.test(key)) snippets.push(String(key));
      collectPromotionTextFromValueInPlugin(child, snippets, depth + 1);
    });
  }
  return Array.from(new Set(snippets.filter(Boolean))).slice(0, 24).join("；");
}

function inferPackQuantityFromTextInPlugin(text) {
  const body = String(text || "");
  const patterns = [
    /(\d+)\s*(?:шт|pcs|pieces|件|个|只|套|pack|упак)/i,
    /(?:набор|комплект|set)\s*(?:из)?\s*(\d+)/i,
    /(\d+)\s*(?:предмет|штук)/i,
  ];
  for (const pattern of patterns) {
    const match = body.match(pattern);
    const quantity = match ? Number(match[1]) : 0;
    if (quantity > 1 && quantity <= 100) return { quantity, evidence: match[0] };
  }
  return { quantity: 1, evidence: "" };
}

function merge1688CandidateDetailsInPlugin(candidate, details = {}) {
  const detailAttrText = Object.entries(details.detailAttributes || {})
    .map(([key, value]) => `${key}: ${value}`)
    .join(" ");
  const inferredPack = inferPackQuantityFromTextInPlugin([details.title, candidate.title, detailAttrText].join(" "));
  const pack = details.packQuantity || candidate.packQuantity || inferredPack.quantity;
  // v2.2.9.110: 采购价口径 = 1688 详情页价格阶梯的「起批首档单价」（起批量最小的一档 = 小批量真实能买到的价）。
  //   旧逻辑取价格文本里第一个数字，会把 "10件起 ¥3.2" 误读成 10；没有阶梯时退回详情/SKU 兜底价并标 hasTier=false。
  const tiers = (Array.isArray(details.priceTiers) ? details.priceTiers : [])
    .filter((tier) => tier && Number(tier.price) > 0)
    .sort((a, b) => (Number(a.beginAmount) || 1) - (Number(b.beginAmount) || 1));
  const firstTier = tiers[0] || null;
  const skuList = Array.isArray(details.skuOptions) ? details.skuOptions : (Array.isArray(candidate.skuOptions) ? candidate.skuOptions : []);
  const distinctSkuPrices = new Set(skuList.map((sku) => Number(sku?.price) || 0).filter((p) => p > 0));
  // 详情页已给出可信价（阶梯或全规格同价）才采信；否则留空，让服务端标待人工，
  //   绝不用搜索列表价（常常是店铺最低/引流档）兜底。
  const detailPrice = normalize1688PriceOnlyInPlugin(details.price || "");
  const priceValue = firstTier ? String(firstTier.price)
    : (detailPrice && distinctSkuPrices.size === 1 ? detailPrice : "");
  return {
    ...candidate,
    ...details,
    title: details.title || candidate.title,
    price: priceValue,
    priceFirstTier: firstTier ? String(firstTier.price) : "",
    priceTiers: tiers,
    skuOptions: skuList.slice(0, 12),
    priceHasTier: tiers.length > 0,
    priceEvidence: tiers.length > 0 ? "tier" : (priceValue ? "single_sku" : "none"),
    priceLadderText: details.priceDetails || candidate.priceDetails || "",
    minOrderQuantity: details.minOrderQuantity || candidate.minOrderQuantity || candidate.moq,
    moq: details.moq || details.minOrderQuantity || candidate.moq,
    shippingFee: details.shippingFee || candidate.shippingFee || "",
    shippingFeeSource: details.shippingFeeSource || candidate.shippingFeeSource || "",
    dimensionsText: details.dimensionsText || candidate.dimensionsText || "",
    weightText: details.weightText || candidate.weightText || "",
    weightGrams: details.weightGrams || candidate.weightGrams || normalizeWeightGramsInPlugin(details.weightText || candidate.weightText),
    weightSource: details.weightSource || candidate.weightSource || "",
    priceDetails: details.priceDetails || candidate.priceDetails || "",
    promotionText: [candidate.promotionText, details.promotionText].filter(Boolean).join("；"),
    packQuantity: pack,
    packQuantityEvidence: details.packQuantityEvidence || candidate.packQuantityEvidence || inferredPack.evidence || "",
    detailError: details.detailError || "",
  };
}

function parseMoqQuantityInPlugin(value) {
  const text = String(value || "").replace(/,/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (/(?:一|1)\s*(?:件|个|只|套|箱|包|pcs?|piece|pieces)?\s*(?:起批|起订|起购|起拍|可批|拿样|代发)|(?:起批|起订|起购|起拍|起订量|起购量|最少起批|最小起订|可批|拿样|代发)\s*[:：]?\s*(?:一|1)(?:\s*(?:件|个|只|套|箱|包|pcs?|piece|pieces))?|(?:min\s*order\s*qty|min\s*order\s*quantity|min(?:imum)?\s*order|minimum\s*purchase|moq)\s*[:：]?\s*1(?:\s*(?:pcs?|piece|pieces))?/i.test(text)) {
    return 1;
  }
  const direct = text.match(/^\s*(\d+(?:\.\d+)?)\s*$/)
    || text.match(/(?:^|[^\d])(\d+(?:\.\d+)?)\s*(?:件|个|只|套|箱|包|pcs?|piece|pieces)?\s*(?:起批|起订|起购|起拍|可批|拿样|代发|min\s*order\s*qty|min\s*order\s*quantity|min(?:imum)?\s*order|minimum\s*purchase|moq)/i)
    || text.match(/(?:起批|起订|起购|起拍|起订量|起购量|最少起批|最小起订|可批|拿样|代发|min\s*order\s*qty|min\s*order\s*quantity|min(?:imum)?\s*order|minimum\s*purchase|moq)\s*[:：]?\s*(\d+(?:\.\d+)?)/i);
  if (!direct) return null;
  const n = Number(direct[1]);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
}

function rank1688CandidatesForOzonInPlugin(candidates) {
  return (Array.isArray(candidates) ? candidates : []).map((candidate, index) => {
    const moqQuantity = parseMoqQuantityInPlugin(candidate.minOrderQuantity || candidate.moq);
    const ozonMoqPenalty = moqQuantity === 1 ? 0 : (moqQuantity === null ? 1 : 2);
    return {
      ...candidate,
      moqQuantity,
      ozonMoqOk: moqQuantity === 1,
      ozonMoqWarning: moqQuantity && moqQuantity > 1 ? `起批量 ${moqQuantity}，不适合 Ozon 一件代发优先采购` : "",
      _ozonCandidateRank: { index, ozonMoqPenalty },
    };
  }).sort((a, b) => (
    (a._ozonCandidateRank?.ozonMoqPenalty || 0) - (b._ozonCandidateRank?.ozonMoqPenalty || 0)
    || (a.avoidForSourcing ? 1 : 0) - (b.avoidForSourcing ? 1 : 0)
    || (a._ozonCandidateRank?.index || 0) - (b._ozonCandidateRank?.index || 0)
  )).map((candidate, index) => {
    const { _ozonCandidateRank, ...rest } = candidate;
    return { ...rest, rank: index + 1 };
  });
}

function addTrafficBaitAssessmentInPlugin(candidate) {
  const rawValues = extractRmbValuesInPlugin([candidate.price, candidate.priceDetails, candidate.minOrderQuantity, candidate.moq].join(" "))
    .filter(v => v > 0).sort((a, b) => a - b);
  const rawMin = rawValues[0] ?? null;
  const maxPriceRmb = rawValues[rawValues.length - 1] ?? null;
  // v2.2.9.108: 1688 常见 ¥1 引流档——展示价取排除 <2 元引流档后的最低实际档，避免候选价全为 1 元
  const meaningful = rawValues.filter(v => v >= 2);
  const minPriceRmb = meaningful[0] ?? rawMin;
  const unitPriceRmb = minPriceRmb;
  const trafficBaitRisk = (rawMin !== null && rawMin < 1) ||
    (rawMin !== null && maxPriceRmb !== null && maxPriceRmb >= 10 && maxPriceRmb / Math.max(rawMin, 0.01) >= 10);
  return {
    ...candidate,
    price: unitPriceRmb !== null ? formatPriceNumberInPlugin(unitPriceRmb) : normalize1688PriceOnlyInPlugin(candidate.price || candidate.priceDetails),
    unitPriceRmb,
    minPriceRmb,
    maxPriceRmb,
    trafficBaitRisk,
    trafficBaitReason: trafficBaitRisk ? "价格过低或价格跨度异常，可能是引流 SKU" : "",
    avoidForSourcing: trafficBaitRisk,
  };
}

function normalize1688PriceOnlyInPlugin(value) {
  const tier = extract1688MinimumTierUnitPriceInPlugin(value);
  if (tier !== null) return formatPriceNumberInPlugin(tier);
  const match = String(value || "").match(/(\d+(?:[.,]\d+)?)/);
  return match ? match[1].replace(",", ".") : "";
}

function extract1688MinimumTierUnitPriceInPlugin(value) {
  const values = extractRmbValuesInPlugin(value);
  const positive = values.filter(v => v > 0).sort((a, b) => a - b);
  return positive.length ? positive[0] : null;
}

function extractRmbValuesInPlugin(value) {
  const matches = String(value || "").matchAll(/(?:¥|￥)?\s*(\d+(?:[.,]\d+)?)/g);
  return Array.from(matches).map(m => Number(m[1].replace(",", "."))).filter(Number.isFinite);
}

function normalizeWeightGramsInPlugin(value) {
  const text = String(value || "");
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(kg|公斤|千克|кг|g|克|г|гр)/i);
  if (!match) return null;
  const n = Number(match[1].replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return /kg|公斤|千克|кг/i.test(match[2]) ? Math.round(n * 1000) : Math.round(n);
}

function formatPriceNumberInPlugin(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(Number(n.toFixed(2))) : "";
}

function md5(input) {
  function cmn(q, a, b, x, s, t) { a = add32(add32(a, q), add32(x, t)); return add32((a << s) | (a >>> (32 - s)), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
  function md5cycle(x, k) {
    let [a, b, c, d] = x;
    a = ff(a, b, c, d, k[0], 7, -680876936); d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819); b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897); d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341); b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416); d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063); b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682); d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510); d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713); b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691); d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335); b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438); d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961); b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467); d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473); b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558); d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562); b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060); d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632); b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174); d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979); b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487); d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520); b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844); d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571); d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523); b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359); d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380); b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070); d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259); b = ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = add32(a, x[0]); x[1] = add32(b, x[1]); x[2] = add32(c, x[2]); x[3] = add32(d, x[3]);
  }
  function md5blk(s) { const a = []; for (let i = 0; i < 64; i += 4) a[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24); return a; }
  function md51(s) {
    const n = s.length; const state = [1732584193, -271733879, -1732584194, 271733878]; let i;
    for (i = 64; i <= n; i += 64) md5cycle(state, md5blk(s.substring(i - 64, i)));
    s = s.substring(i - 64);
    const tail = Array(16).fill(0);
    for (i = 0; i < s.length; i++) tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (i > 55) { md5cycle(state, tail); tail.fill(0); }
    tail[14] = n * 8;
    md5cycle(state, tail);
    return state;
  }
  function rhex(n) { let s = ""; for (let j = 0; j < 4; j++) s += ((n >> (j * 8 + 4)) & 0x0f).toString(16) + ((n >> (j * 8)) & 0x0f).toString(16); return s; }
  function hex(x) { return x.map(rhex).join(""); }
  function add32(a, b) { return (a + b) & 0xffffffff; }
  return hex(md51(unescape(encodeURIComponent(String(input)))));
}

function looksLikeRichContentDoc(raw) {
  const doc = parseMaybeJsonForSyntheticRich(raw);
  return Boolean(
    doc &&
    typeof doc === "object" &&
    !Array.isArray(doc) &&
    Array.isArray(doc.content) &&
    doc.content.some(block => block && typeof block === "object" && typeof block.widgetName === "string")
  );
}

function parseMaybeJsonForSyntheticRich(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return value;
  try { return JSON.parse(trimmed); } catch { return value; }
}

function synthesizeRichContentFromImages(images) {
  const urls = [];
  const seen = new Set();
  // v2.2.9.100: 允许 wc1000 等尺寸变体，归一化去掉 /wc\d+/ 段（对齐 MY ERP 用原始图 URL），
  //   之前排除 wc1000 导致静默采集的多图全被过滤、富文本只剩 1 张主图
  const normalize = (raw) => {
    const url = String(raw || "").trim().split(/[?#]/)[0];
    if (!/^https?:\/\//i.test(url)) return "";
    if (!/(ir-\d+\.ozonru\.cn|ir-\d+\.ozonstatic\.cn|ir\.ozone\.ru|cdn1\.ozonusercontent\.com)\/s3\/(multimedia|product-service-meta-media)/i.test(url)) return "";
    return url.replace(/\/wc\d+\//i, "/");
  };
  const keyFor = (url) => {
    try {
      const parsed = new URL(url);
      const path = decodeURIComponent(parsed.pathname || "").replace(/\/wc\d+\//gi, "/");
      return (path.split("/").filter(Boolean).pop() || path).toLowerCase();
    } catch {
      return String(url || "").toLowerCase();
    }
  };
  for (const raw of Array.isArray(images) ? images : []) {
    const url = normalize(raw);
    if (!url) continue;
    const key = keyFor(url);
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
    if (urls.length >= 8) break;
  }
  if (!urls.length) return "";
  const block = (src) => ({
    imgLink: "",
    img: {
      src,
      srcMobile: src,
      alt: "",
      position: "width_full",
      positionMobile: "width_full",
      widthMobile: 800,
      heightMobile: 800,
    },
  });
  const content = [{
    widgetName: "raShowcase",
    type: "billboard",
    blocks: [block(urls[0])],
  }];
  if (urls.length > 1) {
    content.push({
      widgetName: "raShowcase",
      type: "roll",
      blocks: urls.slice(1).map(block),
    });
  }
  return JSON.stringify({
    content,
    version: 0.3,
  });
}

function ensureSyntheticRichContent(data) {
  if (!data || typeof data !== "object") return false;
  const existing = typeof data.richContent === "string" ? data.richContent.trim() : "";
  if (existing && looksLikeRichContentDoc(existing)) return false;
  const rich = synthesizeRichContentFromImages(data.images);
  if (!rich) return false;
  data.richContent = rich;
  data._synthetic_rich_content = true;
  if (data._debug && typeof data._debug === "object") {
    data._debug.syntheticRichContentBytes = rich.length;
    if (!Array.isArray(data._debug.attributeSources)) data._debug.attributeSources = [];
    data._debug.attributeSources.push("rich-content.11254.synthetic-images");
  }
  return true;
}

// ========== v2.2.9.15: Seller Portal 复制商品源包 ==========
// My ERP 批量跟卖实际不是只读公开 PDP，而是先 /api/v1/search 找 variant_id，
// 再调 /api/site/seller-prototype/create-bundle-by-variant-id 拿完整 bundle item。
async function getSellerCompanyId() {
  const readCookieValue = (cookies) => String((cookies || []).find(c => c?.name === "sc_company_id" && c?.value)?.value || "").trim();

  // v2.2.9.19: Chrome 有时按 url 读不到 sc_company_id，但按 name 或页面 document.cookie 能读到。
  // My ERP 也会从 seller 页面 cookie 兜底；这里保持一致，避免已登录却误报未登录。
  let value = readCookieValue(await chrome.cookies.getAll({ url: "https://seller.ozon.ru/", name: "sc_company_id" }));
  if (value) return value;

  value = readCookieValue(await chrome.cookies.getAll({ name: "sc_company_id" }));
  if (value) return value;

  const tabs = await chrome.tabs.query({ url: ["https://seller.ozon.ru/*", "https://*.ozon.ru/*"] }).catch(() => []);
  const sellerTabs = [
    ...tabs.filter(t => /^https:\/\/seller\.ozon\.ru\//i.test(t.url || "")),
    ...tabs.filter(t => /^https:\/\/([^/]+\.)?ozon\.ru\//i.test(t.url || "") && !/^https:\/\/seller\.ozon\.ru\//i.test(t.url || "")),
  ];
  for (const tab of sellerTabs) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: () => {
          const m = String(document.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith("sc_company_id="));
          return m ? decodeURIComponent(m.slice("sc_company_id=".length)) : "";
        },
      });
      value = String(res?.result || "").trim();
      if (value) return value;
    } catch {}
  }
  return "";
}

async function fetchSellerPortalViaOzonTab(path, body, opts = {}) {
  const timeoutMs = opts.timeoutMs || 30000;
  const urlPrefix = opts.urlPrefix !== undefined ? opts.urlPrefix : "/api/v1";
  const preferTabId = opts.preferTabId || null;
  const isOzonUrl = (u) => /^https?:\/\/([^/]+\.)?ozon\.ru\//i.test(u || "");
  let target = null;
  if (preferTabId) {
    try {
      const t = await chrome.tabs.get(preferTabId);
      if (t && isOzonUrl(t.url)) target = t;
    } catch {}
  }
  if (!target) {
    const tabs = await chrome.tabs.query({ url: ["*://*.ozon.ru/*"] });
    target = tabs.find(t => t.status === "complete" && t.active)
      || tabs.find(t => t.status === "complete")
      || tabs[0]
      || null;
  }
  if (!target) throw new Error("无可用 ozon.ru 标签页，无法调用 seller portal");

  const doFetch = async (apiPath, reqBody, timeout, prefix) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const resp = await fetch("https://seller.ozon.ru" + (prefix || "/api/v1") + apiPath, {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
        headers: { "content-type": "text/plain" },
        body: JSON.stringify(reqBody || {}),
      });
      clearTimeout(timer);
      if (resp.redirected && /\/(signin|login)/i.test(resp.url || "")) {
        return { ok: false, status: 401, error: "seller 登录态已过期，请重新登录 seller.ozon.ru" };
      }
      const text = await resp.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
      if (!resp.ok) {
        return { ok: false, status: resp.status, error: `Seller portal HTTP ${resp.status}: ${text.slice(0, 300)}` };
      }
      return { ok: true, data: json };
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, error: e.name === "AbortError" ? `请求超时 (${timeout}ms)` : (e.message || String(e)) };
    }
  };

  const results = await chrome.scripting.executeScript({
    target: { tabId: target.id },
    func: doFetch,
    args: [path, body, timeoutMs, urlPrefix],
    world: "MAIN",
  });
  const r = results?.[0]?.result;
  if (!r) throw new Error("seller portal executeScript 未返回结果");
  if (!r.ok) throw new Error(r.error || "seller portal 请求失败");
  return r.data;
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value || null));
}

// v2.2.9.100: portal 调用重试（对齐 MY ERP withRetry）— 指数退避，解决 seller 后台偶发超时/抖动
async function portalWithRetry(fn, label, maxAttempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt >= maxAttempts) break;
      // v2.2.9.100: 退避加大到 2s/4s/8s — 短时间大量 bundle 提交触发 Ozon 限流时重试更有效
      const wait = 2000 * Math.pow(2, attempt - 1);
      console.warn(`[SW ${VERSION}] portal ${label} 第 ${attempt} 次失败, ${wait}ms 后重试: ${e?.message || e}`);
      await sleep(wait);
    }
  }
  throw lastError;
}

async function portalCreateBundle(companyId, preferTabId) {
  const resp = await fetchSellerPortalViaOzonTab("/seller-prototype/create-bundle", {
    company_id: String(companyId),
  }, { urlPrefix: "/api/site", timeoutMs: 30000, preferTabId });
  const bundleId = resp?.bundle_id;
  if (!bundleId) throw new Error("Seller portal create-bundle 未返回 bundle_id");
  return String(bundleId);
}

async function portalUpdateBundleItems(bundleId, companyId, items, preferTabId, categoryLvl3Name = "") {
  return fetchSellerPortalViaOzonTab("/seller-prototype/update-bundle-items", {
    bundle_id: String(bundleId),
    company_id: String(companyId),
    source: "SOURCE_MERGED",
    // v2.2.9.100: 对齐 MY ERP — 必须带类目三级名，空字符串会导致上传任务失败/商品建不出来
    description_category_lvl3_name: String(categoryLvl3Name || ""),
    items,
  }, { urlPrefix: "/api/site", timeoutMs: 60000, preferTabId });
}

async function portalUploadBundle(bundleId, companyId, preferTabId) {
  const resp = await fetchSellerPortalViaOzonTab("/seller-prototype/upload-bundle", {
    bundle_id: String(bundleId),
    company_id: String(companyId),
    strict: true,
  }, { urlPrefix: "/api/site", timeoutMs: 60000, preferTabId });
  const taskId = resp?.upload_task_id || resp?.task_id;
  if (!taskId) throw new Error("Seller portal upload-bundle 未返回 upload_task_id");
  return String(taskId);
}

// v2.2.9.100: 轮询 portal 上传任务，确认真实上架结果（对齐 MY ERP getUploadTaskList）。
// 解决之前"ERP 显示提交但 Ozon 后台无商品"的隐患 — 返回真实 status/processed/failed。
async function pollPortalUploadTask(companyId, taskId, preferTabId, { intervalMs = 15000, maxPolls = 10 } = {}) {
  const sleepIn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let poll = 1; poll <= maxPolls; poll += 1) {
    try {
      const resp = await fetchSellerPortalViaOzonTab("/async-upload/v1/task/get-list", {
        company_id: String(companyId),
        limit: 30,
        page: 1,
      }, { urlPrefix: "/api/site", timeoutMs: 30000, preferTabId });
      const tasks = Array.isArray(resp?.tasks) ? resp.tasks : (Array.isArray(resp?.list) ? resp.list : []);
      const task = tasks.find((t) => String(t?.task_id || t?.id || "") === String(taskId)) || null;
      if (!task) {
        if (poll >= maxPolls) return { status: "unknown", reason: `轮询 ${maxPolls} 次未找到 task ${taskId}` };
      } else {
        const status = String(task?.status || task?.state || "").toLowerCase();
        const processed = Number(task?.processed || task?.done || 0);
        const failed = Number(task?.failed || 0);
        const warned = Number(task?.warned || 0);
        if (["done", "finished", "success", "completed", "complete"].includes(status) || (task?.finished === true)) {
          return { status: "done", processed, failed, warned, task };
        }
        if (["failed", "error", "canceled", "cancelled"].includes(status)) {
          return { status: "failed", reason: `upload task ${taskId} 状态=${status}`, processed, failed, warned, task };
        }
        // processing / in_progress → 继续轮询
        if (poll >= maxPolls) {
          return { status: "processing", reason: `轮询 ${maxPolls} 次仍在处理中`, processed, failed, warned, task };
        }
      }
    } catch (e) {
      console.warn(`[SW ${VERSION}] portal task 轮询第 ${poll} 次失败: ${e?.message || e}`);
      if (poll >= maxPolls) return { status: "unknown", reason: `轮询失败: ${e?.message || e}` };
    }
    await sleepIn(intervalMs);
  }
  return { status: "unknown", reason: "轮询超时" };
}

function ensurePortalAttr(item, attributeId, values) {
  const id = String(attributeId);
  if (!Array.isArray(item.attributes)) item.attributes = [];
  const normalizedValues = (Array.isArray(values) ? values : [values])
    .filter(v => v !== undefined && v !== null && String(v).trim() !== "")
    .map((v, idx) => ({
      value: String(v).trim(),
      sequence: String(idx),
      is_default: idx === 0,
      complex_sequence: "0",
      dictionary_value_id: "0",
    }));
  if (!normalizedValues.length) return;
  const existing = item.attributes.find(a => String(a?.attribute_id || a?.id || "") === id && String(a?.complex_id || "0") === "0");
  if (existing) {
    existing.values = normalizedValues;
  } else {
    item.attributes.push({ attribute_id: id, complex_id: "0", values: normalizedValues });
  }
}

function normalizePortalAttributes(item, opts = {}) {
  const removeIds = new Set((opts.removeIds || []).map(id => String(id)));
  const attrs = Array.isArray(item?.attributes) ? item.attributes : [];
  const byKey = new Map();
  for (const attr of attrs) {
    const id = String(attr?.attribute_id ?? attr?.id ?? "").trim();
    if (!id || removeIds.has(id)) continue;
    const complexId = String(attr?.complex_id ?? "0");
    const key = `${id}:${complexId}`;
    if (!byKey.has(key)) {
      byKey.set(key, attr);
      continue;
    }
    const current = byKey.get(key);
    const currentValues = Array.isArray(current?.values) ? current.values : [];
    const nextValues = Array.isArray(attr?.values) ? attr.values : [];
    if (!currentValues.length && nextValues.length) byKey.set(key, attr);
  }
  item.attributes = Array.from(byKey.values());
}

function buildPortalItemFromImportItem(importItem) {
  if (!importItem || typeof importItem !== "object") throw new Error("portalImport 缺少 item");
  const sourceVariant = importItem._sourceVariant && typeof importItem._sourceVariant === "object" ? importItem._sourceVariant : null;
  let sourceBundleItem = sourceVariant?._bundleItem && typeof sourceVariant._bundleItem === "object" ? sourceVariant._bundleItem : null;
  // v2.2.9.100: _bundleItem 缺失（静默采集/传输精简导致）时，用 _sourceVariant.attributes 重建最小源包，
  //   避免 portal 静默上架整体回退官方 import
  if (!sourceBundleItem && sourceVariant && Array.isArray(sourceVariant.attributes)) {
    sourceBundleItem = {
      attributes: sourceVariant.attributes.map((a) => {
        const vals = Array.isArray(a.values)
          ? a.values
          : Array.isArray(a.collection)
            ? a.collection
            : (a.value !== undefined && a.value !== null ? [a.value] : []);
        return {
          attribute_id: String(a.key ?? a.id ?? a.attribute_id ?? ""),
          name: a.name || "",
          values: vals
            .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
            .map((v, i) => ({
              value: String(v),
              sequence: String(i),
              is_default: i === 0,
              complex_sequence: "0",
              dictionary_value_id: String(a.dictionary_value_id || "0"),
            })),
        };
      }),
      name: sourceVariant.name || importItem.name || "",
      images: Array.isArray(importItem.images) ? importItem.images.filter((u) => typeof u === "string") : [],
      primary_image: Array.isArray(importItem.images) && importItem.images.length ? importItem.images[0] : "",
      price: importItem.price || "",
      weight: Number(importItem.weight || sourceVariant.weight || 0),
      depth: Number(importItem.depth || sourceVariant.depth || 0),
      width: Number(importItem.width || sourceVariant.width || 0),
      height: Number(importItem.height || sourceVariant.height || 0),
      barcode: importItem.barcode || sourceVariant.barcode || "",
      description: importItem.description || sourceVariant.description || "",
      _rebuilt_without_bundle_item: true,
    };
    console.warn(`[SW ${VERSION}] portalImport: _bundleItem 缺失, 已用 _sourceVariant.attributes(${sourceVariant.attributes.length}) 重建源包`);
  }
  if (!sourceBundleItem) throw new Error("portalImport 需要 Seller bundle 源包 (_sourceVariant._bundleItem)");

  const item = clonePlain(sourceBundleItem);
  const images = Array.isArray(importItem.images) ? importItem.images.filter(u => typeof u === "string" && /^https?:\/\//i.test(u)) : [];
  item.id = "0";
  item.item_id = "0";
  item.sku = "0";
  item.deleted = false;
  item.unmerged = false;
  item.offer_id = String(importItem.offer_id || "").trim();
  // v2.2.9.100: 名称对齐 MY ERP — 用采集的 bundle 商品名（如 "Браслет жесткий"），
  //   不再用 4180 完整标题（"Браслет манжета на руку широкий" 与 MY ERP 不一致）
  const portalBundleAttrs = Array.isArray(sourceBundleItem.attributes) ? sourceBundleItem.attributes : [];
  const portalAttrValue = (aid) => {
    const a = portalBundleAttrs.find((x) => String(x?.attribute_id ?? x?.id ?? x?.key ?? "") === String(aid));
    const vals = Array.isArray(a?.values) ? a.values : [];
    const v = vals[0] && typeof vals[0] === "object" ? (vals[0].value ?? vals[0].text ?? vals[0].name ?? "") : vals[0];
    return v !== null && v !== undefined ? String(v).trim() : "";
  };
  const bundleName = portalAttrValue(4180) || importItem.name || item.name || "";
  item.name = cleanOzonTitle(String(importItem.name || item.name || "")).replace(/\s+/g, " ").trim().slice(0, 200);
  item.price = String(importItem.price || item.price || "");
  item.old_price = String(importItem.old_price || item.old_price || importItem.price || "");
  item.currency = String(importItem.currency_code || importItem.currency || item.currency || "CNY");
  item.description_category_id = String(importItem.description_category_id || item.description_category_id || sourceVariant.description_category_id || "");
  item.new_description_category_id = "0";
  item.weight = Number(importItem.weight || item.weight || 0);
  item.depth = Number(importItem.depth || item.depth || 0);
  item.width = Number(importItem.width || item.width || 0);
  item.height = Number(importItem.height || item.height || 0);
  item.barcode = String(importItem.barcode || item.barcode || "");
  // v2.2.9.100: bundle item 没有 description 字段 → 用完整标题兜底（对齐 MY ERP pickFollowSellDescription 的 fallback）
  if (!String(item.description || "").trim()) {
    item.description = bundleName || item.name || "";
  }
  if (images.length) {
    item.images = images;
    item.primary_image = images[0];
  }
  if (item.name) ensurePortalAttr(item, 4180, item.name);
  if (item.weight) ensurePortalAttr(item, 4497, item.weight);
  if (item.depth) ensurePortalAttr(item, 9454, item.depth);
  if (item.width) ensurePortalAttr(item, 9455, item.width);
  if (item.height) ensurePortalAttr(item, 9456, item.height);
  if (item.barcode) ensurePortalAttr(item, 23524, item.barcode);
  if (importItem.richContent) ensurePortalAttr(item, 11254, importItem.richContent);
  // v2.2.9.100: 9048(型号名) 对齐 MY ERP — 纯源 SKU（如 4844459482），MY ERP 用 scraped_sku 兜底
  {
    const skuDigits = String(item.offer_id || "").match(/\d{6,}/)?.[0] || "";
    const modelVal = skuDigits ? skuDigits : String(item.offer_id || "").slice(0, 40);
    const existing9048 = Array.isArray(item.attributes)
      ? item.attributes.find((a) => String(a?.attribute_id ?? a?.id ?? a?.key ?? "") === "9048")
      : null;
    if (existing9048) {
      existing9048.values = [{ value: modelVal, sequence: "0", is_default: false, complex_sequence: "0", dictionary_value_id: "0" }];
      if (existing9048.attribute_id === undefined && existing9048.key) {
        existing9048.attribute_id = existing9048.key;
        delete existing9048.key;
      }
    } else if (modelVal) {
      const arr = Array.isArray(item.attributes) ? item.attributes : [];
      arr.push({
        attribute_id: "9048",
        name: "Название модели",
        values: [{ value: modelVal, sequence: "0", is_default: false, complex_sequence: "0", dictionary_value_id: "0" }],
        complex_id: "0",
      });
      item.attributes = arr;
    }
  }
  // 图片在 seller-prototype bundle 里走 top-level images/primary_image。
  // 同时带 4194/4195 会被 Ozon 判定“图片字段重复”。
  normalizePortalAttributes(item, { removeIds: [4194, 4195] });
  return item;
}

async function discoverOzonProductsFromSearch(searchQuery, strategyType, maxProducts, categoryLabel, progressTabId) {
  if (!searchQuery && !categoryLabel) throw new Error("需要搜索关键词或类目名");
  const query = searchQuery || categoryLabel;
  const searchUrl = `https://www.ozon.ru/search/?text=${encodeURIComponent(query)}&sorting=rating`;
  console.log(`[SW ${VERSION}] discoverOzonProducts: 打开搜索页 ${searchUrl}, max=${maxProducts}`);
  const tab = await createTabWithRetry({ url: searchUrl, active: false }, "打开 Ozon 搜索页");
  let collected = [];
  try {
    await waitForTabComplete(tab.id, 30000);
    await sleep(randomInt(2000, 4000));
    let stagnant = 0;
    let prevCount = 0;
    for (let round = 0; round < 15 && collected.length < maxProducts && stagnant < 4; round++) {
      const [extracted] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractOzonSearchResults,
        args: [maxProducts],
      }).catch(() => [null]);
      if (extracted && extracted.length) {
        for (const item of extracted) {
          if (!collected.find((c) => c.sku === item.sku)) collected.push(item);
          if (collected.length >= maxProducts) break;
        }
      }
      if (collected.length > prevCount) {
        console.log(`[SW ${VERSION}] discoverOzonProducts: 第 ${round + 1} 轮, 累计 ${collected.length}/${maxProducts}`);
        stagnant = 0;
        prevCount = collected.length;
      } else {
        stagnant++;
      }
      if (collected.length < maxProducts) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (d) => window.scrollBy(0, d),
          args: [Math.floor(window.innerHeight * 1.5) || 800],
        }).catch(() => {});
        await sleep(randomInt(1500, 3000));
      }
    }
  } finally {
    await safeRemoveTab(tab.id).catch(() => {});
  }
  if (!collected.length) {
    console.log(`[SW ${VERSION}] discoverOzonProducts: 新 tab 提取为空，尝试从用户已打开的 Ozon 标签页提取`);
    const ozonTabs = await chrome.tabs.query({ url: "https://www.ozon.ru/*" }).catch(() => []);
    for (const ot of ozonTabs) {
      if (collected.length >= maxProducts) break;
      const [extracted] = await chrome.scripting.executeScript({
        target: { tabId: ot.id },
        func: extractOzonSearchResults,
        args: [maxProducts - collected.length],
      }).catch(() => [null]);
      if (extracted && extracted.length) {
        for (const item of extracted) {
          if (!collected.find((c) => c.sku === item.sku)) collected.push(item);
          if (collected.length >= maxProducts) break;
        }
        console.log(`[SW ${VERSION}] discoverOzonProducts: 从已打开标签页 ${ot.url?.slice(0, 60)} 提取到 ${extracted.length} 个商品`);
      }
    }
  }
  if (!collected.length) {
    return { imported: 0, failed: 0, items: [], error: "Ozon 搜索页没有返回商品卡片（可能是反爬或地区限制）" };
  }
  const response = await erpApi("/api/sourcing/platform-snapshot/batch-upsert", {
    method: "POST",
    body: {
      items: collected,
      strategy_type: strategyType,
      source_name: "extension_search",
      source_url: searchUrl,
    },
  });
  console.log(`[SW ${VERSION}] discoverOzonProducts: 已上传 ${collected.length} 个商品到 ERP, imported=${response.imported}`);
  return {
    imported: response.imported || 0,
    failed: response.failed || 0,
    items: response.items || [],
    errors: response.errors || [],
    total_found: collected.length,
  };
}

function extractOzonSearchResults(maxCount) {
  try {
    const results = [];
    const toAbs = (val) => {
      try { return new URL(String(val || ""), location.href).href; } catch { return ""; }
    };
    const clean = (val) => String(val || "").replace(/\s+/g, " ").trim();
    const seenSkus = new Set();

    // 策略1: data-widget 容器内的 data-index 卡片
    const widgetCards = document.querySelectorAll(
      '[data-widget="searchResultsV2"] [data-index], [data-widget="searchResultsV2"] [class*="item"], [data-widget="skuGrid"] [data-index], [data-widget="skuGrid"] [class*="item"], [data-widget="searchResults"] [data-index], .widget-search-results-container [data-index]'
    );
    // 策略2: 直接找所有商品链接，向上找父容器
    const productLinks = document.querySelectorAll('a[href*="/product/"]');
    const linkCards = [];
    for (const link of productLinks) {
      let parent = link;
      for (let i = 0; i < 6; i++) {
        parent = parent.parentElement;
        if (!parent) break;
        if (parent.querySelector('img') && parent.querySelector('img') !== link.querySelector('img')) break;
      }
      if (parent) linkCards.push(parent);
    }
    const allCards = widgetCards.length ? [...widgetCards] : linkCards;

    for (const card of allCards) {
      if (results.length >= maxCount) break;
      let sku = "";
      let title = "";
      let mainImage = "";
      let priceRub = null;
      let ozonUrl = "";
      let sellerName = "";
      let categoryName = "";
      const link = card.matches?.('a[href*="/product/"]') ? card : card.querySelector?.('a[href*="/product/"]');
      if (link) {
        ozonUrl = toAbs(link.getAttribute("href"));
        const m = ozonUrl.match(/\/product\/(?:[^/?]*?-)?(\d{5,})/);
        if (m) sku = m[1];
      }
      if (!sku) {
        const idx = card.getAttribute?.("data-index") || card.getAttribute?.("data-sku") || "";
        sku = String(idx).match(/\d{5,}/)?.[0] || "";
      }
      if (!sku) continue;
      if (seenSkus.has(sku)) continue;
      seenSkus.add(sku);

      title = clean(
        card.querySelector?.("img")?.getAttribute("alt") ||
        link?.getAttribute("title") ||
        link?.textContent ||
        card.querySelector?.("[title]")?.getAttribute("title") ||
        card.querySelector?.('[class*="title"], [class*="name"]')?.textContent ||
        ""
      );
      const img = card.querySelector?.("img[src]");
      if (img) mainImage = toAbs(img.getAttribute("src") || img.getAttribute("data-src") || "");
      if (!mainImage) {
        const bgImg = card.querySelector?.('[style*="background-image"]');
        if (bgImg) {
          const m = bgImg.getAttribute("style")?.match(/url\(["']?([^"')]+)/);
          if (m) mainImage = toAbs(m[1]);
        }
      }
      const priceEl = card.querySelector?.('[class*="price"], [data-widget="price"], [class*="Price"]');
      if (priceEl) {
        const priceText = clean(priceEl.textContent);
        const m = priceText.match(/[\d\s\u00a0,]+/);
        if (m) priceRub = Number(m[0].replace(/[\s\u00a0,]/g, ""));
      }
      const breadcrumb = card.querySelector?.("[class*='category'], [class*='breadcrumb']");
      if (breadcrumb) categoryName = clean(breadcrumb.textContent);
      const sellerEl = card.querySelector?.("[class*='seller'], [class*='brand']");
      if (sellerEl) sellerName = clean(sellerEl.textContent);
      if (title || mainImage || priceRub) {
        results.push({
          sku, title: title || sku, main_image: mainImage, price_rub: priceRub,
          ozon_url: ozonUrl || `https://www.ozon.ru/product/${sku}/`,
          seller_name: sellerName, category_name: categoryName,
          monthly_sales: 0, review_count: 0, seller_count: null,
        });
      }
    }
    return results;
  } catch (e) {
    return [];
  }
}

async function discoverOzonCategoryProducts(categoryUrl, categoryName, strategyType, maxProducts) {
  if (!categoryUrl) throw new Error("需要品类页 URL");
  let url = categoryUrl;
  if (!/^https?:\/\//.test(url)) url = `https://www.ozon.ru${url.startsWith("/") ? "" : "/"}${url}`;
  if (!/\/category\//.test(url) && !/sorting=/.test(url)) url = url.replace(/\/?$/, "/?sorting=rating");
  console.log(`[SW ${VERSION}] discoverCategoryProducts: 打开品类页 ${url}, max=${maxProducts}`);
  const tab = await createTabWithRetry({ url, active: false }, "打开 Ozon 品类页");
  let collected = [];
  try {
    await waitForTabComplete(tab.id, 30000);
    await sleep(randomInt(2000, 4000));
    let stagnant = 0;
    let prevCount = 0;
    for (let round = 0; round < 15 && collected.length < maxProducts && stagnant < 4; round++) {
      const [extracted] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractOzonSearchResults,
        args: [maxProducts],
      }).catch(() => [null]);
      if (extracted && extracted.length) {
        for (const item of extracted) {
          if (!collected.find((c) => c.sku === item.sku)) collected.push(item);
          if (collected.length >= maxProducts) break;
        }
      }
      if (collected.length > prevCount) {
        console.log(`[SW ${VERSION}] discoverCategoryProducts: 第 ${round + 1} 轮, 累计 ${collected.length}/${maxProducts}`);
        stagnant = 0;
        prevCount = collected.length;
      } else {
        stagnant++;
      }
      if (collected.length < maxProducts) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (d) => window.scrollBy(0, d),
          args: [Math.floor(window.innerHeight * 1.5) || 800],
        }).catch(() => {});
        await sleep(randomInt(1500, 3000));
      }
    }
  } finally {
    await safeRemoveTab(tab.id).catch(() => {});
  }
  if (!collected.length) {
    console.log(`[SW ${VERSION}] discoverCategoryProducts: 新 tab 提取为空，尝试从用户已打开的 Ozon 标签页提取`);
    const ozonTabs = await chrome.tabs.query({ url: "https://www.ozon.ru/*" }).catch(() => []);
    for (const ot of ozonTabs) {
      if (collected.length >= maxProducts) break;
      const [extracted] = await chrome.scripting.executeScript({
        target: { tabId: ot.id },
        func: extractOzonSearchResults,
        args: [maxProducts - collected.length],
      }).catch(() => [null]);
      if (extracted && extracted.length) {
        for (const item of extracted) {
          if (!collected.find((c) => c.sku === item.sku)) collected.push(item);
          if (collected.length >= maxProducts) break;
        }
        console.log(`[SW ${VERSION}] discoverCategoryProducts: 从已打开标签页 ${ot.url?.slice(0, 60)} 提取到 ${extracted.length} 个商品`);
      }
    }
  }
  if (!collected.length) {
    return { imported: 0, failed: 0, items: [], error: "Ozon 品类页没有返回商品卡片（可能是反爬或页面结构变化），请手动在 Ozon 上浏览品类页后重试" };
  }
  for (const item of collected) {
    if (categoryName && !item.category_name) item.category_name = categoryName;
  }
  const response = await erpApi("/api/sourcing/platform-snapshot/batch-upsert", {
    method: "POST",
    body: {
      items: collected,
      strategy_type: strategyType,
      source_name: "extension_category_page",
      source_url: url,
    },
  });
  console.log(`[SW ${VERSION}] discoverCategoryProducts: 已上传 ${collected.length} 个商品到 ERP, imported=${response.imported}`);
  return {
    imported: response.imported || 0,
    failed: response.failed || 0,
    items: response.items || [],
    errors: response.errors || [],
    total_found: collected.length,
  };
}

// v2.2.9.100: 从源变体提取类目三级名（upload-bundle 依赖，对齐 MY ERP 后端 prepare 传的类目名）
function extractPortalCategoryLvl3Name(sourceVariant) {
  if (!sourceVariant || typeof sourceVariant !== "object") return "";
  const cats = Array.isArray(sourceVariant.categories) ? sourceVariant.categories : [];
  if (cats.length) {
    const last = cats[cats.length - 1];
    if (last?.name) return String(last.name).trim();
    if (last?.title) return String(last.title).trim();
  }
  return String(sourceVariant.description_type_name
    || sourceVariant.category_name
    || sourceVariant.description_category_name
    || "").trim();
}

async function portalImportItems(importItems, preferTabId) {
  const companyId = await getSellerCompanyId();
  if (!companyId) throw new Error("未找到 sc_company_id cookie，请确认 seller.ozon.ru 已登录并选中目标店铺");
  const rawList = Array.isArray(importItems) ? importItems : [importItems];
  if (!rawList.length) throw new Error("portalImport 没有可提交商品");
  // v2.2.9.100: 每个 SKU 独立一个 bundle 提交 — 实测 Ozon 一个 bundle 塞多个商品时每组只创建 1 个，
  //   必须每 SKU 一组（每组 1 个 item）才能保证全部独立创建。
  const groups = new Map();
  for (const raw of rawList) {
    const item = buildPortalItemFromImportItem(raw);
    const cat = String(item.description_category_id || "0");
    const key = `${cat}:${item.offer_id || Math.random().toString(36).slice(2, 8)}`;
    groups.set(key, { items: [item], variants: raw && typeof raw === "object" ? [raw._sourceVariant] : [] });
  }
  const taskIds = [];
  const bundleIds = [];
  const allItems = [];
  const groupErrors = [];
  // v2.2.9.100: 每 SKU 一组，并发 5 提交（97 组 5 并发 ≈ 20 轮 × 每组 3 请求）
  const groupList = [...groups.entries()].map(([cat, g]) => ({ cat, g }));
  const GROUP_CONCURRENCY = 2;
  let groupCursor = 0;
  const runGroupWorker = async () => {
    while (groupCursor < groupList.length) {
      const { cat, g } = groupList[groupCursor];
      groupCursor += 1;
      // v2.2.9.100: 每组独立容错 — 一组失败不丢其他组（之前一组抛错导致整个批次 0 提交）
      try {
        const lvl3Name = extractPortalCategoryLvl3Name(g.variants.find(Boolean));
        const bundleId = await portalWithRetry(() => portalCreateBundle(companyId, preferTabId), "create-bundle", 3);
        await portalWithRetry(() => portalUpdateBundleItems(bundleId, companyId, g.items, preferTabId, lvl3Name), "update-bundle-items", 3);
        const taskId = await portalWithRetry(() => portalUploadBundle(bundleId, companyId, preferTabId), "upload-bundle", 3);
        taskIds.push(taskId);
        bundleIds.push(bundleId);
        for (const i of g.items) allItems.push(i);
        console.log(`[SW ${VERSION}] portal 分组提交: cat=${cat} items=${g.items.length} bundle=${bundleId} task=${taskId}`);
      } catch (e) {
        const msg = String(e?.message || e).slice(0, 300);
        groupErrors.push({ category: cat, count: g.items.length, error: msg });
        console.warn(`[SW ${VERSION}] portal 分组提交失败: cat=${cat} items=${g.items.length} err=${msg}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(GROUP_CONCURRENCY, Math.max(1, groupList.length)) }, runGroupWorker));
  // v2.2.9.100: 不再原地轮询 upload task（省 0~2.5 分钟/店）— 提交即返回，
  //   真实上架结果由服务端后台 pollPendingListingTasks(每 60s) 通过查 product 确认
  return {
    viaPortal: true,
    company_id: companyId,
    bundle_id: bundleIds[0] || "",
    task_id: taskIds[0] || "",
    upload_task_id: taskIds[0] || "",
    task_ids: taskIds,
    task_count: taskIds.length,
    item_count: allItems.length,
    group_errors: groupErrors,
    task_status: "processing",
    task_reason: "已提交，后台确认中",
    task_processed: 0,
    task_failed: 0,
    items: allItems.map(i => ({ offer_id: i.offer_id, name: i.name, image: i.primary_image || (i.images || [])[0] || "" })),
  };
}

function normalizeSearchVariantToSv(v) {
  if (!v) return null;
  if (Array.isArray(v.attributes) && v.attributes.length > 0) return v;
  const attributes = [];
  if (v.description_type_name) attributes.push({ key: "8229", value: v.description_type_name });
  if (v.brand_name) attributes.push({ key: "85", value: v.brand_name });
  const productName = v.variant_name || v.title || v.name;
  if (productName) attributes.push({ key: "4180", value: productName });
  if (v.description) attributes.push({ key: "4191", value: v.description });
  if (v.main_image) attributes.push({ key: "4194", value: v.main_image });
  const secondaries = Array.isArray(v.secondary_images) ? v.secondary_images : [];
  if (secondaries.length > 0) attributes.push({ key: "4195", collection: secondaries });
  if (Array.isArray(v.barcodes) && v.barcodes.length > 0) {
    const gtin = String(v.barcodes[0] || "").trim();
    if (gtin) attributes.push({ key: "7822", value: gtin });
  }
  const categories = (v.categories || []).map(c => ({
    id: Number(c.id),
    level: Number(c.level),
    name: c.name || "",
    title: c.title || c.name || "",
  })).filter(c => c.id);
  return {
    variant_id: v.variant_id || (v.barcodes && v.barcodes[0]) || "",
    type_id: Number(v.description_type_dict_value) || 0,
    description_category_id: categories.length ? Number(categories[categories.length - 1].id) : 0,
    categories,
    _searchMeta: {
      skus: v.skus || [],
      barcodes: v.barcodes || [],
      brand_id: v.brand_id,
      is_copy_allowed: v.is_copy_allowed,
      is_content_copy_allowed: v.is_content_copy_allowed,
      rating: v.rating,
    },
    attributes,
  };
}

function addSourceAttr(attrs, key, value, extra = {}) {
  if (value === undefined || value === null || value === "") return;
  const exists = attrs.some(a => String(a?.key ?? a?.id ?? a?.attribute_id) === String(key));
  if (exists) return;
  attrs.push({ key: String(key), value: String(value), ...extra });
}

function readBundleAttrValues(attr) {
  const vals = Array.isArray(attr?.values) ? attr.values : [];
  return vals
    .map(v => v && typeof v === "object" ? (v.value ?? v.text ?? v.name ?? "") : v)
    .map(v => String(v || "").trim())
    .filter(Boolean);
}

function buildSourceVariantFromBundle(searchSv, bundleItem) {
  const sv = searchSv && typeof searchSv === "object" ? { ...searchSv } : { attributes: [] };
  const attrs = Array.isArray(sv.attributes) ? [...sv.attributes] : [];
  const existing = new Set(attrs.map(a => String(a?.key ?? a?.id ?? a?.attribute_id)));

  if (Number(bundleItem?.weight) > 0 && !existing.has("4497")) { attrs.push({ key: "4497", value: String(bundleItem.weight) }); existing.add("4497"); }
  if (Number(bundleItem?.depth) > 0 && !existing.has("9454")) { attrs.push({ key: "9454", value: String(bundleItem.depth) }); existing.add("9454"); }
  if (Number(bundleItem?.width) > 0 && !existing.has("9455")) { attrs.push({ key: "9455", value: String(bundleItem.width) }); existing.add("9455"); }
  if (Number(bundleItem?.height) > 0 && !existing.has("9456")) { attrs.push({ key: "9456", value: String(bundleItem.height) }); existing.add("9456"); }
  if (bundleItem?.barcode && !existing.has("7822")) { attrs.push({ key: "7822", value: String(bundleItem.barcode) }); existing.add("7822"); }

  const bundleComplexAttrs = [];
  if (Array.isArray(bundleItem?.attributes)) {
    for (const ba of bundleItem.attributes) {
      if (ba?.complex_id && String(ba.complex_id) !== "0") {
        bundleComplexAttrs.push(ba);
        continue;
      }
      const key = String(ba?.attribute_id || ba?.id || "");
      if (!key || existing.has(key)) continue;
      const vals = readBundleAttrValues(ba);
      if (!vals.length) continue;
      const rawValues = Array.isArray(ba.values)
        ? ba.values
            .filter(v => v && v.value != null && String(v.value).trim() !== "")
            .map(v => ({
              value: String(v.value).trim(),
              ...(Number(v.dictionary_value_id || 0) > 0 ? { dictionary_value_id: Number(v.dictionary_value_id) } : {}),
            }))
        : [];
      const attr = { key, ...(rawValues.length ? { values: rawValues } : {}) };
      if (vals.length > 1) attr.collection = vals;
      else attr.value = vals[0];
      const dictId = Number(ba?.values?.[0]?.dictionary_value_id || ba?.dictionary_value_id || 0);
      if (dictId > 0 && vals.length === 1) attr.dictionary_value_id = dictId;
      attrs.push(attr);
      existing.add(key);
    }
  }

  sv.attributes = attrs;
  if (bundleComplexAttrs.length) sv._bundleComplexAttrs = bundleComplexAttrs;
  sv._bundleItem = bundleItem;
  return sv;
}

function sourceVariantToFlatAttributes(sourceVariant, currentAttrs) {
  const attrs = Array.isArray(currentAttrs) ? [...currentAttrs] : [];
  const existing = new Set(attrs.map(a => String(a?.id ?? a?.attribute_id ?? a?.key ?? "")));
  for (const a of (sourceVariant?.attributes || [])) {
    const id = Number(a?.id ?? a?.attribute_id ?? a?.key);
    if (!Number.isFinite(id) || id <= 0 || existing.has(String(id))) continue;
    let value = "";
    if (Array.isArray(a.collection)) value = a.collection.map(v => String(v || "").trim()).filter(Boolean).join(", ");
    else if (a.value !== undefined && a.value !== null) value = String(a.value);
    else if (Array.isArray(a.values)) value = readBundleAttrValues(a).join(", ");
    if (!value) continue;
    attrs.push({ id, name: a.name || "", value, ...(a.dictionary_value_id ? { dictionary_value_id: Number(a.dictionary_value_id) } : {}) });
    existing.add(String(id));
  }
  return attrs;
}

function extractImagesFromSourceVariant(sourceVariant) {
  const images = [];
  const push = (u) => {
    if (typeof u === "string" && /^https?:\/\//i.test(u) && !images.includes(u)) images.push(u);
  };
  const attrs = Array.isArray(sourceVariant?.attributes) ? sourceVariant.attributes : [];
  const get = (key) => attrs.find(a => String(a?.key ?? a?.id ?? a?.attribute_id) === String(key));
  const primary = get("4194");
  if (primary?.value) push(primary.value);
  const gallery = get("4195");
  if (Array.isArray(gallery?.collection)) gallery.collection.forEach(push);
  if (gallery?.value) push(gallery.value);
  const bundle = sourceVariant?._bundleItem || {};
  push(bundle.primary_image);
  for (const img of (Array.isArray(bundle.images) ? bundle.images : [])) push(typeof img === "string" ? img : (img?.file_name || img?.url || img?.src));
  return images;
}

function parseMaybeJsonForSellerBundle(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return value;
  try { return JSON.parse(trimmed); } catch { return value; }
}

function isSellerBundleRichContentDoc(doc) {
  return Boolean(
    doc &&
    typeof doc === "object" &&
    !Array.isArray(doc) &&
    Array.isArray(doc.content) &&
    doc.content.length > 0 &&
    doc.content.some(block => block && typeof block === "object" && typeof block.widgetName === "string" && block.widgetName.trim())
  );
}

function scoreSellerBundleRichContent(doc, json) {
  let widgetCount = 0;
  let textChars = 0;
  let imageCount = 0;
  const skipKeys = new Set(["widgetName", "align", "size", "color", "type", "src", "srcMobile", "url", "link", "imgLink", "richAnnotationJson", "style", "trackingInfo"]);
  const walk = (node, key, depth) => {
    if (node == null || depth > 24) return;
    if (typeof node === "string") {
      const text = node.replace(/\s+/g, " ").trim();
      if (!skipKeys.has(key) && text.length > 2 && !/^https?:\/\//i.test(text) && /[A-Za-zА-Яа-яЁё]/.test(text)) textChars += text.length;
      if (/^https?:\/\/.+\.(?:jpg|jpeg|png|webp|gif|avif)(?:[?#].*)?$/i.test(text)) imageCount += 1;
      return;
    }
    if (Array.isArray(node)) { for (const item of node) walk(item, key, depth + 1); return; }
    if (typeof node !== "object") return;
    if (node.widgetName) widgetCount += 1;
    for (const childKey of Object.keys(node)) walk(node[childKey], childKey, depth + 1);
  };
  walk(doc.content, "content", 0);
  return widgetCount * 1000 + textChars * 20 + imageCount * 30 + Math.min(String(json || "").length, 20000) / 20000;
}

function extractRichContentFromSellerBundleStates(states) {
  if (!states || typeof states !== "object") return "";
  const candidates = [];
  const seenJson = new Set();
  const seenObjects = typeof WeakSet !== "undefined" ? new WeakSet() : null;
  const addCandidate = (doc, rawJson) => {
    if (!isSellerBundleRichContentDoc(doc)) return;
    const json = typeof rawJson === "string" && rawJson.trim()
      ? rawJson.trim()
      : JSON.stringify({ content: doc.content, version: doc.version || 0.3 });
    if (seenJson.has(json)) return;
    seenJson.add(json);
    candidates.push({ json, score: scoreSellerBundleRichContent(doc, json) - candidates.length / 1000 });
  };
  const walk = (node, depth) => {
    if (node == null || depth > 28) return;
    const parsed = parseMaybeJsonForSellerBundle(node);
    if (!parsed || typeof parsed !== "object") return;
    if (seenObjects) {
      if (seenObjects.has(parsed)) return;
      seenObjects.add(parsed);
    }
    if (typeof parsed.richAnnotationJson === "string" && parsed.richAnnotationJson.trim()) {
      addCandidate(parseMaybeJsonForSellerBundle(parsed.richAnnotationJson), parsed.richAnnotationJson);
    }
    if (isSellerBundleRichContentDoc(parsed)) addCandidate(parsed, null);
    if (Array.isArray(parsed)) {
      for (const item of parsed) walk(item, depth + 1);
      return;
    }
    for (const key of Object.keys(parsed)) walk(parsed[key], depth + 1);
  };
  walk(states, 0);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.json || "";
}

async function enrichFromSellerPortalBundle(data, sku, preferTabId) {
  const companyId = await getSellerCompanyId();
  if (!companyId) throw new Error("未找到 sc_company_id cookie，请确认 seller.ozon.ru 已登录并选中店铺");
  const searchResp = await fetchSellerPortalViaOzonTab("/search", {
    company_id: String(companyId),
    need_total: true,
    filter: {
      children_nodes: {
        children_nodes: [{ input_leaf: { sku: { values: [String(sku)] } } }],
        operator: "AND",
      },
    },
    pagination: { limit: "50" },
    is_copy_allowed: false,
  }, { urlPrefix: "/api/v1", timeoutMs: 30000, preferTabId });

  const rawVariants = Array.isArray(searchResp?.variants) ? searchResp.variants
    : Array.isArray(searchResp?.items) ? searchResp.items
    : Array.isArray(searchResp?.products) ? searchResp.products
    : Array.isArray(searchResp) ? searchResp : [];
  const sv = rawVariants.map(normalizeSearchVariantToSv).find(Boolean);
  if (!sv?.variant_id) {
    throw new Error(`Seller /search 未找到 SKU ${sku} 的 variant_id (variants=${rawVariants.length})`);
  }

  const bundleResp = await fetchSellerPortalViaOzonTab("/seller-prototype/create-bundle-by-variant-id", {
    company_id: String(companyId),
    variant_id: String(sv.variant_id),
    source: "SOURCE_UI_COPY_APPAREL",
  }, { urlPrefix: "/api/site", timeoutMs: 30000, preferTabId });
  const bundleItem = bundleResp?.item || null;
  if (!bundleItem) {
    throw new Error(`Seller create-bundle-by-variant-id 未返回 item (variant_id=${sv.variant_id})`);
  }
  if (!Array.isArray(bundleItem.attributes) || bundleItem.attributes.length === 0) {
    throw new Error(`Seller bundle 返回空 attributes (variant_id=${sv.variant_id}, bundle_id=${bundleResp?.bundle_id || ""})`);
  }

  const sourceVariant = buildSourceVariantFromBundle(sv, bundleItem);
  data._sourceVariant = sourceVariant;
  data.attributes = sourceVariantToFlatAttributes(sourceVariant, data.attributes);
  const bundleRichContent = extractRichContentFromSellerBundleStates(bundleResp) || extractRichContentFromSellerBundleStates(bundleItem);
  if (bundleRichContent && !data.richContent) {
    data.richContent = bundleRichContent;
  }
  const images = extractImagesFromSourceVariant(sourceVariant);
  if (images.length) {
    data.images = [...images, ...(Array.isArray(data.images) ? data.images : [])].filter((u, idx, arr) => u && arr.indexOf(u) === idx).slice(0, 15);
    data.primary_image = data.images[0] || data.primary_image || "";
  }
  if (bundleItem.name && !data.name) data.name = String(bundleItem.name);
  if (bundleItem.description && !data.description) data.description = String(bundleItem.description);
  if (Number(bundleItem.weight) > 0) data.weight = Number(bundleItem.weight);
  if (Number(bundleItem.depth) > 0) data.depth = Number(bundleItem.depth);
  if (Number(bundleItem.width) > 0) data.width = Number(bundleItem.width);
  if (Number(bundleItem.height) > 0) data.height = Number(bundleItem.height);
  if (bundleItem.barcode) data.barcode = String(bundleItem.barcode);
  const sellerTypeId = Number(sv.type_id || sourceVariant?.type_id || 0);
  const sellerCategoryId = Number(sv.description_category_id || sourceVariant?.description_category_id || 0);
  if (sellerTypeId > 0) data.type_id = sellerTypeId;
  if (sellerCategoryId > 0) data.description_category_id = sellerCategoryId;
  data._seller_bundle_source = {
    company_id: String(companyId),
    variant_id: String(sv.variant_id),
    bundle_id: bundleResp?.bundle_id || null,
    attr_count: Array.isArray(bundleItem.attributes) ? bundleItem.attributes.length : 0,
    type_id: sellerTypeId || null,
    description_category_id: sellerCategoryId || null,
  };
  return { attrCount: data.attributes.length, imageCount: data.images.length };
}

// ========== v2.1: Ozon Seller API (OPI) 辅源 ==========
const storeProductsCache = new Map();  // storeId -> { products, ts, credsMasked }
const CACHE_TTL_MS = 5 * 60 * 1000;     // 5 分钟

// 通用 OPI fetch 封装 (仿 0.13.48.1 opi-client.js)
async function callOpi(path, body, creds) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(`${OPI_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Client-Id": String(creds.clientId),
        "Api-Key": String(creds.apiKey),
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      throw new Error(`OPI ${res.status} ${path}: ${(text||"").slice(0, 200)}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

// 从 ERP 后端拿店铺凭证
async function getStoreCreds(storeId) {
  const url = `${ERP_BACKEND_ORIGIN}/api/extension/seller-credentials?store_id=${encodeURIComponent(storeId)}`;
  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) throw new Error(`getStoreCreds HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data.success) throw new Error(data.error || "no creds");
  return { clientId: data.clientId, apiKey: data.apiKey, storeName: data.storeName };
}

// 列店铺所有已上架商品 (带缓存)
async function listStoreProducts(storeId, creds, force = false) {
  const cached = storeProductsCache.get(storeId);
  if (!force && cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.products;
  }
  const all = [];
  let lastId = "";
  for (let i = 0; i < 10; i++) {  // 最多 10 页 = 10000 商品
    const resp = await callOpi("/v3/product/list", {
      filter: { visibility: "ALL" },
      limit: 1000,
      last_id: lastId,
    }, creds);
    const items = resp?.result?.items || [];
    all.push(...items);
    lastId = resp?.result?.last_id || "";
    if (!lastId || items.length < 1000) break;
  }
  storeProductsCache.set(storeId, { products: all, ts: Date.now() });
  return all;
}

// 找相似商品: 同类目优先, 否则 name 相似度匹配
function findSimilarProduct(products, sourceName, sourceCategoryId) {
  if (!products.length) return null;
  // 1) 类目完全匹配优先
  const sameCat = products.filter(p => p.description_category_id === sourceCategoryId);
  if (sameCat.length === 1) return sameCat[0];
  if (sameCat.length > 1 && sourceName) {
    const lower = sourceName.toLowerCase();
    const tokens = lower.split(/\s+/).filter(t => t.length >= 3).slice(0, 5);
    let best = null; let bestScore = 0;
    for (const p of sameCat) {
      const pName = (p.name || "").toLowerCase();
      let score = 0;
      for (const t of tokens) if (pName.includes(t)) score++;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (best && bestScore > 0) return best;
  }
  // 2) 无类目匹配, 退化到 name 相似
  if (sourceName) {
    const lower = sourceName.toLowerCase();
    const tokens = lower.split(/\s+/).filter(t => t.length >= 4).slice(0, 3);
    let best = null; let bestScore = 0;
    for (const p of products) {
      const pName = (p.name || "").toLowerCase();
      let score = 0;
      for (const t of tokens) if (pName.includes(t)) score++;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (best && bestScore >= 2) return best;
  }
  return null;
}

// 拿商品的 attributes (含 type_id / description_category_id)
async function getProductInfo(offerId, creds) {
  const resp = await callOpi("/v3/product/info", { offer_id: offerId }, creds);
  return resp?.result || resp;
}

// v2.1 主入口: 用 OPI 给公开页采集的 data 补 attributes + 修正 type/cat
async function enrichFromOpi(data, storeId) {
  console.log(`[SW ${VERSION}]   OPI 辅源: 拿凭证 (store=${storeId})...`);
  const creds = await getStoreCreds(storeId);
  // v2.1.8 兜底: 即使没找到相似商品, 用 SKU 直接反查自己店铺有没有同款
  //   (跟卖场景中同 SKU 通常已发布过), 拿到 type_id / attributes 兜底补齐
  try {
    const own = await getProductInfo(String(data.sku || ""), creds);
    if (own && typeof own === "object" && !data._seller_bundle_enriched) {
      data._sourceVariant = own;
    }
    if (own && own.type_id && !data.type_id) {
      data.type_id = own.type_id;
      data._source_type_id = "opi-direct-sku-lookup";
      console.log(`[SW ${VERSION}]   OPI 直查 SKU 拿到 type_id=${own.type_id}`);
    }
    if (own && Array.isArray(own.attributes) && own.attributes.length && (!data.attributes || !data.attributes.length)) {
      data.attributes = mapOpiAttributes(own.attributes, data.attributes || []);
      data._source_attributes = "opi-direct-sku-lookup";
      console.log(`[SW ${VERSION}]   OPI 直查 SKU 拿到 ${own.attributes.length} 个 attributes`);
    }
  } catch (e) {
    console.log(`[SW ${VERSION}]   OPI 直查 SKU 失败 (非致命): ${e.message}`);
  }
  console.log(`[SW ${VERSION}]   OPI 辅源: 拿 ${creds.storeName} 商品列表...`);
  const products = await listStoreProducts(storeId, creds);
  console.log(`[SW ${VERSION}]   OPI 辅源: 店铺有 ${products.length} 个商品, 找类目 ${data.description_category_id} 的同款...`);
  const similar = findSimilarProduct(products, data.name, data.description_category_id);
  if (!similar) {
    console.log(`[SW ${VERSION}]   OPI 辅源: 未找到同款 (类目=${data.description_category_id}, name="${data.name?.slice(0,30)}")`);
    return null;
  }
  console.log(`[SW ${VERSION}]   OPI 辅源: 找到 ${similar.offer_id} (${similar.name?.slice(0,30)})`);
  const detail = await getProductInfo(similar.offer_id, creds);
  if (!detail) return null;
  if (!data._seller_bundle_enriched) data._sourceVariant = detail;
  // 合并 attributes
  const opiAttrs = detail.attributes || [];
  if (!opiAttrs.length) {
    console.log(`[SW ${VERSION}]   OPI 辅源: ${similar.offer_id} 没有 attributes, 跳过合并`);
    return null;
  }
  // 初始化
  if (!data.attributes) data.attributes = [];
  const _mr = mapOpiAttributes(opiAttrs, data.attributes);
  data.attributes = _mr.attrs;
  const added = _mr.added;
  const overridden = _mr.overridden;
  // 修正 type_id (OPI 更准)
  if (detail.type_id && !data.type_id) {
    data.type_id = detail.type_id;
  }
  // 修正 description_category_id (OPI 精确)
  if (detail.description_category_id && detail.description_category_id !== data.description_category_id) {
    console.log(`[SW ${VERSION}]   OPI 修正 cat: ${data.description_category_id} → ${detail.description_category_id}`);
    data.description_category_id = detail.description_category_id;
  }
  // 记录来源
  data._opi_source = similar.offer_id;
  return { added, overridden };
}

// ========== v2.1.9+: 通过 ERP 后端解析 Seller 类目 (替换不可靠的 URL 解析) ==========
// v2.3.0+: 带 type_id + candidates
// v2.2.9.3: 加 name 参数, 让 server 端 candidates 能用 name 关键词从 Ozon 全 tree 过滤
async function resolveSellerCategory(sku, storeId, typeId, breadcrumbCatId, name) {
  if ((!sku && !typeId) || !storeId) return null;
  try {
    const ctrl = new AbortController();
    // v2.2.9.17: 首次加载 Ozon category tree 时服务端可能需要 18-25s。
    // 之前 15s 会先 abort，导致后端明明算出 candidates，前端仍显示“未解析”。
    const timer = setTimeout(() => ctrl.abort(), 45000);
    const res = await fetch(`${ERP_BACKEND_ORIGIN}/api/seller/products/category-resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        sku: Number(sku) || 0,
        store_id: storeId,
        type_id: Number(typeId) || 0,
        breadcrumb_cat_id: Number(breadcrumbCatId) || 0,  // 5位 URL breadcrumb (v2.2.9)
        name: String(name || '').trim(),  // v2.2.9.3: 让 server 端用 name 关键词匹配 Ozon tree
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn(`[SW ${VERSION}]   resolveSellerCategory 失败 (非致命): ${e.message}`);
    return null;
  }
}

// 等待 tab 状态变成 complete
function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const check = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete") {
          // 再额外等 2s 让 JS 渲染 (Ozon 是 SPA, status=complete 后还有异步加载)
          setTimeout(resolve, 2000);
          return;
        }
        if (Date.now() - t0 > timeoutMs) {
          reject(new Error(`tab status=${tab.status}, 超时 ${timeoutMs}ms`));
          return;
        }
        setTimeout(check, 500);
      } catch (e) {
        reject(e);
      }
    };
    check();
  });
}

async function safeRemoveTab(tabId) {
  try {
    await removeTabWithRetry(tabId);
  } catch (e) {
    // tab 已关闭, 忽略
  }
}

// ========== 注入到 Ozon 商品页的提取函数 (IIFE) ==========
// 这个函数被 executeScript 注入到 www.ozon.ru 商品页, 在 page context 跑
// v1.0.9 大幅扩展: 把上架需要的全部字段都尝试从页面拿到
async function extractOzonProductData(sku) {
  // v2.2.9.10 (fix): 把整个提取逻辑包 try/catch, helper 函数必须在 closure 里
  //   chrome.scripting.executeScript 注入的函数只能引用自己函数体内代码 (跨函数调 ReferenceError)
  try {
    // ========== 内嵌 helper 函数 (必须在 closure 里) ==========
function deepFindFullProduct(obj, sku, depth) {
  if (depth > 10 || !obj || typeof obj !== "object") return null;
  // 命中条件: 同时有 description_category_id + images + name
  if (typeof obj.description_category_id === "number" &&
      typeof obj.type_id === "number" &&
      obj.name &&
      Array.isArray(obj.images)) {
    return { source: `obj.sku=${obj.sku || "?"}`, object: obj };
  }
  // 备选命中: 只有 description_category_id + type_id + name
  if (typeof obj.description_category_id === "number" &&
      typeof obj.type_id === "number" &&
      obj.name &&
      (Array.isArray(obj.attributes) || Array.isArray(obj.complex_attributes))) {
    return { source: `obj.sku=${obj.sku || "?"} (partial)`, object: obj };
  }
  // 遍历
  for (const key of Object.keys(obj)) {
    const result = deepFindFullProduct(obj[key], sku, depth + 1);
    if (result) {
      result.source = `${key}.${result.source}`;
      return result;
    }
  }
  return null;
}

function mergeProductObject(data, obj) {
  if (!obj) return;
  // 基础字段
  if (obj.name && !data.name) data.name = String(obj.name).trim();
  if (obj.sku && !data.offer_id) data.offer_id = String(obj.sku);
  if (obj.id && !data.product_id) data.product_id = String(obj.id);
  if (obj.barcode && !data.barcode) data.barcode = String(obj.barcode);
  if (obj.description && !data.description) data.description = String(obj.description);
  if (obj.brand && !data.brand) {
    data.brand = typeof obj.brand === "string" ? obj.brand : (obj.brand?.name || "");
  }
  if (obj.description_category_id && !data.description_category_id) data.description_category_id = obj.description_category_id;
  if (obj.type_id && !data.type_id) data.type_id = obj.type_id;
  if (obj.vat) data.vat = String(obj.vat);
  if (obj.currency_code) data.currency_code = String(obj.currency_code);
  if (obj.weight && !data.weight) {
    const w = parseWeight(obj.weight);
    if (w) data.weight = w;
  }
  if (obj.country_of_origin && !data.country_of_origin) data.country_of_origin = String(obj.country_of_origin);

  // 尺寸 (Ozon 有时是 dimensions 对象)
  if (obj.dimensions) {
    if (obj.dimensions.depth && !data.depth) data.depth = parseInt(obj.dimensions.depth, 10) || 0;
    if (obj.dimensions.width && !data.width) data.width = parseInt(obj.dimensions.width, 10) || 0;
    if (obj.dimensions.height && !data.height) data.height = parseInt(obj.dimensions.height, 10) || 0;
  }

  // 图片 (Ozon 格式: [{url, ...}] 或 [{file_name, ...}])
  if (Array.isArray(obj.images)) {
    for (const img of obj.images) {
      const url = typeof img === "string" ? img : (img.url || img.file_name || img.src);
      addImageUrl(data, url);
    }
  }
  if (obj.image) {
    const imgs = Array.isArray(obj.image) ? obj.image : [obj.image];
    for (const img of imgs) addImageUrl(data, typeof img === "string" ? img : (img.url || img.src || img.file_name));
  }
  if (obj.primary_image) addImageUrl(data, obj.primary_image);
  if (obj.cover_image) addImageUrl(data, obj.cover_image);
  if (obj.color_image) addImageUrl(data, obj.color_image);

  // Attributes 数组 (Ozon 格式: [{id, name, values: [{value}]}])
  if (Array.isArray(obj.attributes)) {
    for (const attr of obj.attributes) {
      const id = attr.id || attr.attribute_id;
      const name = attr.name || attr.title || "";
      let value = "";
      let dictionary_value_id = 0;
      if (Array.isArray(attr.values) && attr.values.length > 0) {
        value = typeof attr.values[0] === "string" ? attr.values[0] : (attr.values[0]?.value || attr.values[0]?.text || "");
        dictionary_value_id = Number(attr.values[0]?.dictionary_value_id || attr.values[0]?.id || 0);
      } else if (attr.value) {
        value = String(attr.value);
      }
      if (name && value) {
        const key = `${id || name}:${value}`;
        if (!data._attrKeys.has(key)) {
          data.attributes.push({ id, name, value, ...(dictionary_value_id > 0 ? { dictionary_value_id } : {}) });
          data._attrKeys.add(key);
        }
      }
    }
  }

  // complex_attributes (Ozon 格式可能不同, 原样保留)
  if (Array.isArray(obj.complex_attributes) && data.complex_attributes.length === 0) {
    data.complex_attributes = obj.complex_attributes;
  }
}

// v2.2.9.101 (fix): 注入函数闭包内必须自带 cleanOzonTitle —— executeScript 注入到商品页的函数
//   只能引用自己函数体内的代码，顶层同名函数不在作用域，会导致 ReferenceError 整行失败
function cleanOzonTitle(name) {
  const text = String(name || "").replace(/\s+/g, " ").trim();
  return text
    .replace(/\s*-\s*(?:купить|buy|покупать)\s+(?:на\s+)?OZON\s*$/i, "")
    .replace(/\s*-\s*OZON\s*$/i, "")
    .replace(/\s*\(\s*(?:купить|buy)\s+(?:на\s+)?OZON\s*\)\s*$/i, "")
    .replace(/\s*-\s*купить\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parseWeight(w) {
  if (typeof w === "number") return Math.round(w);
  if (typeof w === "string") {
    const m = w.match(/^([\d.]+)\s*(g|kg|г|克)?$/i);
    if (m) {
      const val = parseFloat(m[1]);
      const unit = (m[2] || "g").toLowerCase();
      if (unit === "kg") return Math.round(val * 1000);
      return Math.round(val);
    }
  }
  if (typeof w === "object" && w.value) {
    return parseWeight(w.value);
  }
  return 0;
}

function normalizeImageUrl(url) {
  if (!url || typeof url !== "string") return "";
  let s = url.trim()
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
  if (s.startsWith("//")) s = "https:" + s;
  if (!/^https?:\/\//i.test(s)) return "";
  // v2.2.9.102 (fix): 域名白名单补 ozonstatic.cn / ozonstatic.com（Ozon 新 CDN），否则新域名图片全被丢弃
  if (!/(ozone\.ru|ozonusercontent\.com|ozonru\.cn|ozonstatic\.cn|ozonstatic\.com)/i.test(s)) return "";
  if (/\.(svg|gif)(?:[?#]|$)/i.test(s)) return "";
  if (/(logo|sprite|icon|avatar|placeholder|transparent|empty)/i.test(s)) return "";
  s = s.split("?")[0];
  s = s.replace(/\/wc\d+\//i, "/wc1000/");
  return s;
}

function addImageUrl(data, url) {
  const normalized = normalizeImageUrl(url);
  if (!normalized) return false;
  if (data._imageKeys.has(normalized)) return false;
  data.images.push(normalized);
  data._imageKeys.add(normalized);
  return true;
}

function collectImagesDeep(data, obj, depth) {
  if (depth > 8 || !obj) return;
  if (typeof obj === "string") {
    addImageUrl(data, obj);
    return;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (data.images.length >= 60) return;
      collectImagesDeep(data, item, depth + 1);
    }
    return;
  }
  if (typeof obj !== "object") return;
  for (const [key, value] of Object.entries(obj)) {
    if (data.images.length >= 60) return;
    if (/image|img|photo|picture|gallery|media|cover|src|url|file/i.test(key)) {
      collectImagesDeep(data, value, depth + 1);
    } else if (depth < 4 && value && typeof value === "object") {
      collectImagesDeep(data, value, depth + 1);
    }
  }
}

function collectImagesFromText(data, text) {
  if (!text || typeof text !== "string") return 0;
  const before = data.images.length;
  const normalizedText = text.replace(/\\u002F/g, "/").replace(/\\\//g, "/");
  // v2.2.9.102 (fix): Ozon 图片 CDN 域名已扩展到 ozonstatic.cn / ozonstatic.com 等，
  //   之前只匹配 ir.ozone.ru / ozonru.ru / ozonusercontent.com，新域名图片全部漏掉导致主图为空。
  const re = /(?:https?:)?\/\/(?:ir(?:-\d+)?\.(?:ozonru\.cn|ozone\.ru|ozonstatic\.cn|ozonstatic\.com)|cdn1\.ozone\.ru|[^"'<>\s()]+ozonusercontent\.com)\/[^"'<>\s()\\]+/gi;
  let m;
  while ((m = re.exec(normalizedText)) && data.images.length < 80) {
    addImageUrl(data, m[0]);
  }
	  return data.images.length - before;
	}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return value;
  try { return JSON.parse(trimmed); } catch { return value; }
}

function isRichContentDoc(doc) {
  return Boolean(
    doc &&
    typeof doc === "object" &&
    !Array.isArray(doc) &&
    Array.isArray(doc.content) &&
    doc.content.length > 0 &&
    doc.content.some(block => block && typeof block === "object" && typeof block.widgetName === "string" && block.widgetName.trim())
  );
}

function collectRichContentStats(doc) {
  const stats = { widgetCount: 0, textWidgetCount: 0, layoutWidgetCount: 0, chessWidgetCount: 0, imageCount: 0, textNodeCount: 0, textChars: 0, hasRealText: false };
  const skipTextKeys = new Set(["widgetName", "align", "size", "color", "type", "src", "srcMobile", "url", "link", "imgLink", "richAnnotationJson", "class", "className", "style", "trackingInfo", "layoutTrackingInfo", "gifUrl", "videoUrl", "previewUrl", "backgroundColor", "theme", "padding", "margin", "id", "reff", "fontColor", "borderColor", "position", "positionMobile"]);
  const looksLikeImageUrl = (text) => /^https?:\/\/.+\.(?:jpg|jpeg|png|webp|gif|avif)(?:[?#].*)?$/i.test(text);
  const pushText = (value, key) => {
    if (key && skipTextKeys.has(key)) return;
    const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    if (text.length < 2 || /^https?:\/\//i.test(text) || looksLikeImageUrl(text)) return;
    if (!/[A-Za-zА-Яа-яЁё]/.test(text)) return;
    stats.textNodeCount += 1;
    stats.textChars += text.length;
  };
  const walk = (node, key, depth) => {
    if (node == null || depth > 24) return;
    if (typeof node === "string") { pushText(node, key); return; }
    if (Array.isArray(node)) { for (const item of node) walk(item, key, depth + 1); return; }
    if (typeof node !== "object") return;
    const widgetName = String(node.widgetName || "");
    const type = String(node.type || "");
    if (widgetName) {
      stats.widgetCount += 1;
      if (/text|description|annotation/i.test(widgetName)) stats.textWidgetCount += 1;
      if (/chess/i.test(widgetName) || /chess/i.test(type)) stats.chessWidgetCount += 1;
      if (/showcase|billboard|roll|tile|media|chess/i.test(widgetName) || /billboard|roll|chess|tile/i.test(type)) stats.layoutWidgetCount += 1;
    }
    if (node.img && typeof node.img === "object") stats.imageCount += 1;
    for (const imageKey of ["src", "srcMobile", "url", "image", "imageUrl", "coverImage"]) {
      const raw = node[imageKey];
      if (typeof raw === "string" && /^https?:\/\//i.test(raw) && looksLikeImageUrl(raw)) stats.imageCount += 1;
    }
    for (const childKey of Object.keys(node)) {
      if (skipTextKeys.has(childKey) && childKey !== "text" && childKey !== "title") continue;
      walk(node[childKey], childKey, depth + 1);
    }
  };
  walk(doc?.content, "content", 0);
  stats.hasRealText = stats.textChars >= 12 || stats.textNodeCount >= 2 || stats.textWidgetCount > 0;
  return stats;
}

function extractRichContentFromStates(states) {
  if (!states || typeof states !== "object") return "";
  const candidates = [];
  const seenJson = new Set();
  const seenObjects = typeof WeakSet !== "undefined" ? new WeakSet() : null;
  const addCandidate = (doc, rawJson) => {
    if (!isRichContentDoc(doc)) return;
    const json = typeof rawJson === "string" && rawJson.trim()
      ? rawJson.trim()
      : JSON.stringify({ content: doc.content, version: doc.version || 0.3 });
    if (seenJson.has(json)) return;
    seenJson.add(json);
    const stats = collectRichContentStats(doc);
    candidates.push({
      json,
      score:
        (stats.hasRealText ? 100000 : 0) +
        stats.chessWidgetCount * 20000 +
        stats.textWidgetCount * 12000 +
        stats.layoutWidgetCount * 600 +
        stats.textChars * 40 +
        stats.textNodeCount * 500 +
        stats.widgetCount * 80 +
        stats.imageCount * 20 +
        Math.min(json.length, 20000) / 20000 -
        candidates.length / 1000,
    });
  };
  const walk = (node, depth) => {
    if (node == null || depth > 24) return;
    const parsed = parseMaybeJson(node);
    if (!parsed || typeof parsed !== "object") return;
    if (seenObjects) {
      if (seenObjects.has(parsed)) return;
      seenObjects.add(parsed);
    }
    if (typeof parsed.richAnnotationJson === "string" && parsed.richAnnotationJson.trim()) {
      addCandidate(parseMaybeJson(parsed.richAnnotationJson), parsed.richAnnotationJson);
    }
    if (isRichContentDoc(parsed)) addCandidate(parsed, null);
    if (Array.isArray(parsed)) {
      for (const item of parsed) walk(item, depth + 1);
      return;
    }
    for (const key of Object.keys(parsed)) walk(parsed[key], depth + 1);
  };
  walk(states, 0);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.json || "";
}

function normalizeOzonProductInnerPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, "https://www.ozon.ru");
    return (url.pathname || "") + (url.search || "");
  } catch {
    const noHash = raw.split("#")[0];
    return noHash.startsWith("/") ? noHash : `/${noHash}`;
  }
}

function ozonProductPathKey(value) {
  return normalizeOzonProductInnerPath(value).split("?")[0].replace(/\/+$/, "");
}

function ozonProductIdFromPath(value) {
  const match = ozonProductPathKey(value).match(/\/product\/(?:[^/?#]*-)?(\d+)$/i);
  return match ? match[1] : "";
}

function collectOzonRichContentPagePaths(states, currentPath) {
  const out = [];
  const seenPaths = new Set();
  const seenObjects = typeof WeakSet !== "undefined" ? new WeakSet() : null;
  const currentProductKey = ozonProductPathKey(currentPath);
  const currentProductId = ozonProductIdFromPath(currentPath);
  const push = (candidate) => {
    const pagePath = normalizeOzonProductInnerPath(candidate);
    if (!pagePath || !/[?&]layout_container=pdpPage2column(?:&|$)/.test(pagePath)) return;
    const productKey = ozonProductPathKey(pagePath);
    const productId = ozonProductIdFromPath(pagePath);
    if (currentProductId && productId && currentProductId !== productId) return;
    if ((!currentProductId || !productId) && currentProductKey && productKey && productKey !== currentProductKey) return;
    if (seenPaths.has(pagePath)) return;
    seenPaths.add(pagePath);
    out.push(pagePath);
  };
  const walk = (node, depth) => {
    if (node == null || depth > 18) return;
    const parsed = parseMaybeJson(node);
    if (!parsed || typeof parsed !== "object") return;
    if (seenObjects) {
      if (seenObjects.has(parsed)) return;
      seenObjects.add(parsed);
    }
    if (typeof parsed.nextPage === "string") push(parsed.nextPage);
    if (Array.isArray(parsed)) {
      for (const item of parsed) walk(item, depth + 1);
      return;
    }
    for (const key of Object.keys(parsed)) walk(parsed[key], depth + 1);
  };
  walk(states, 0);
  return out;
}

function richContentHasText(raw) {
  const doc = parseMaybeJson(raw);
  return isRichContentDoc(doc) && collectRichContentStats(doc).hasRealText;
}

async function collectRichContentFromOzonPage(sku) {
  const currentPath = normalizeOzonProductInnerPath(`${location.pathname}${location.search || ""}`);
  const cleanPath = normalizeOzonProductInnerPath(location.pathname);
  const skuPath = sku ? `/product/${sku}/` : "";
  const paths = [currentPath, cleanPath, skuPath].filter(Boolean);
  const endpoints = [];
  const seenEndpoints = new Set();
  const enqueuePath = (path) => {
    const normalized = normalizeOzonProductInnerPath(path);
    if (!normalized) return;
    for (const url of [
      `/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(normalized)}`,
      `/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(normalized)}`,
    ]) {
      if (seenEndpoints.has(url)) continue;
      seenEndpoints.add(url);
      endpoints.push(url);
    }
  };
  for (const path of paths) enqueuePath(path);
  let best = "";
  let bestHasText = false;
  let okCount = 0;
  for (let i = 0; i < endpoints.length; i += 1) {
    const url = endpoints[i];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const resp = await fetch(url, {
        credentials: "include",
        headers: { "x-o3-app-name": "dweb_client", "accept": "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) continue;
      okCount += 1;
      const payload = await resp.json();
      const states = payload?.widgetStates || {};
      // Ozon occasionally moves rich-content widgets or pagination hints outside
      // widgetStates. Scan the full page json as a fallback so we do not miss
      // 11254 when the public PDP shape changes.
      for (const root of [states, payload]) {
        for (const nextPage of collectOzonRichContentPagePaths(root, currentPath || cleanPath || skuPath)) enqueuePath(nextPage);
      }
      const rich = extractRichContentFromStates(states) || extractRichContentFromStates(payload);
      if (rich) {
        const hasText = richContentHasText(rich);
        if (!best || (!bestHasText && hasText) || (hasText === bestHasText && rich.length > best.length)) {
          best = rich;
          bestHasText = hasText;
        }
      }
    } catch (e) {
      clearTimeout(timer);
    }
  }
  if (best) console.log(`[zhumeng-extract] rich content 11254 found bytes=${best.length} text=${bestHasText} endpointsOk=${okCount}/${endpoints.length}`);
  else console.warn(`[zhumeng-extract] rich content 11254 not found endpointsOk=${okCount}/${endpoints.length}`);
  return best;
}


    // ========== 主提取逻辑 ==========

  const data = {
    sku: String(sku || ""),
    name: "",
    offer_id: "",
    product_id: "",
    images: [],
    primary_image: "",
    weight: 0,
    depth: 0,
    width: 0,
    height: 0,
    dimension_unit: "mm",
    weight_unit: "g",
    barcode: "",
    description: "",
    description_category_id: 0,
    type_id: 0,
    brand: "",
    currency_code: "RUB",
    vat: "0",
    price: "",
    country_of_origin: "",
	    attributes: [],            // [{id, name, value}] - 上架需要
	    complex_attributes: [],     // 复杂属性
	    raw_url: location.href,
	    _imageKeys: new Set(),
	    _attrKeys: new Set(),
	  };

  const dbg = {
    title: document.title,
    h1Text: document.querySelector('h1')?.textContent?.slice(0, 100) || "",
    imageCount: 0,
    hasLdJson: 0,
    bodyHtmlLength: document.body?.innerHTML?.length || 0,
    breadcrumbLinks: [],
    stateFound: null,
    categoryFromUrl: 0,
    fullStateObject: null,       // v1.0.9 新增: 找到的完整商品 state 对象
    attributeSources: [],
  };

  // ========== 1. URL 路径提取 category_id ==========
  try {
    const m = location.href.match(/\/category\/[^\/?#]*?(\d{2,})(?:\/|\?|#|$)/);
    if (m) {
      data.description_category_id = parseInt(m[1], 10);
      dbg.categoryFromUrl = data.description_category_id;
    }
  } catch (e) {}

  // ========== 2. 面包屑链接提取 category_id ==========
  // v2.2.9.1: 用最后一级 breadcrumb (具体类目), 不是第一个匹配 (顶层类目)
  //   Ozon 商品页 breadcrumb 顺序: 大类 → 中类 → 小类 → 当前 cat
  //   比如 茶壶: Дом и сад(14500) → Посуда(14501) → Чайники(30814) → Заварочные(14534) ← 这个
  const breadcrumbSelectors = [
    '[data-widget="breadCrumbs"] a',
    '[data-widget="webBreadcrumb"] a',
    'ol.breadcrumb a, ol[itemtype*="BreadcrumbList"] a',
    'nav[aria-label*="eadcrumb" i] a',
    'a[href*="/category/"]',
  ];
  const breadcrumbIds = [];  // 按 DOM 顺序收集
  for (const sel of breadcrumbSelectors) {
    const links = document.querySelectorAll(sel);
    for (const a of links) {
      const href = a.href || "";
      if (!href.includes("/category/")) continue;
      dbg.breadcrumbLinks.push(href);
      const m = href.match(/\/category\/[^\/?#]*?(\d{2,})(?:\/|\?|#|$)/);
      if (m) {
        const id = parseInt(m[1], 10);
        if (id && id > 1000) breadcrumbIds.push(id);
      }
    }
    if (breadcrumbIds.length >= 2) break;  // 拿到 2+ 个就够了
  }
  // 关键: 取最后一个 (最具体的, 就是当前商品的 cat)
  if (breadcrumbIds.length) {
    data.description_category_id = breadcrumbIds[breadcrumbIds.length - 1];
    dbg.breadcrumbIdsFound = breadcrumbIds;
    dbg.categoryFromBreadcrumb = data.description_category_id;
  }

  // ========== 3. JSON-LD (schema.org/Product + BreadcrumbList) ==========
  try {
    const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
    dbg.hasLdJson = ldScripts.length;
    for (const s of ldScripts) {
      try {
        const ld = JSON.parse(s.textContent);
        const items = Array.isArray(ld) ? ld : [ld];
        for (const item of items) {
          if (item["@type"] === "Product" || (Array.isArray(item["@type"]) && item["@type"].includes("Product"))) {
            if (item.name && !data.name) data.name = String(item.name).trim();
            if (item.description && !data.description) data.description = String(item.description).trim();
            if (item.gtin13 || item.gtin) data.barcode = String(item.gtin13 || item.gtin);
            if (item.mpn) data.offer_id = String(item.mpn);
            if (item.sku) data.sku = String(item.sku);
            if (item.brand) {
              if (typeof item.brand === "string") data.brand = item.brand;
              else if (item.brand.name) data.brand = item.brand.name;
            }
            if (item.image) {
              const imgs = Array.isArray(item.image) ? item.image : [item.image];
              for (const img of imgs) {
	                addImageUrl(data, img);
	              }
	            }
            if (item.weight) {
              const w = parseWeight(item.weight);
              if (w) data.weight = w;
            }
          }
          if (item["@type"] === "BreadcrumbList" && Array.isArray(item.itemListElement)) {
            for (const bc of item.itemListElement) {
              const url = bc.item?.url || bc.url;
              if (url && url.includes("/category/")) {
                const m = url.match(/\/category\/[^\/?#]*?(\d{2,})(?:\/|\?|#|$)/);
                if (m) {
                  const id = parseInt(m[1], 10);
                  if (id && id > 1000 && !data.description_category_id) {
                    data.description_category_id = id;
                  }
                }
              }
            }
          }
        }
      } catch (e) {}
    }
  } catch (e) {}

  // ========== 4. Ozon 内部 SSR state 深度搜索 (v1.0.9 加强: 找整个商品对象) ==========
  try {
    const stateContainers = [
      () => window.__pinia__?.state?.value,
      () => window.__INITIAL_STATE__,
      () => window.__NUXT__?.state,
      () => window.__NUXT__,
      () => window.__APP__,
      () => window.__NEXT_DATA__?.props,
      () => window.__INITIAL_DATA__,
    ];
	    for (const getter of stateContainers) {
	      try {
	        const state = getter();
	        if (!state) continue;
	        const beforeImages = data.images.length;
	        collectImagesDeep(data, state, 0);
	        if (data.images.length > beforeImages) {
	          dbg.attributeSources.push(`state-images.+${data.images.length - beforeImages}`);
	        }
	        const found = deepFindFullProduct(state, sku, 0);
	        if (found) {
          dbg.stateFound = found.source;
          dbg.fullStateObject = found.object;  // 整个对象, 方便后续处理
          // 把 found.object 里的所有相关字段填充到 data
          mergeProductObject(data, found.object);
          dbg.attributeSources.push(`state.${found.source}`);
          break;
	    }
	  } catch (e) {}

	  // ========== 4.5. 直接扫所有 script 文本里的 Ozon 图片 URL ==========
	  // Ozon 的轮播图经常藏在 hydration JSON / widget state 里, 首屏 DOM 只渲染 1 张.
	  try {
	    let scriptAdded = 0;
	    const scripts = Array.from(document.scripts || []);
	    for (const s of scripts) {
	      const text = s.textContent || "";
	      if (!text || !/(ozone\.ru|ozonusercontent\.com|ozonru\.cn|ozonstatic|multimedia|images)/i.test(text)) continue;
	      scriptAdded += collectImagesFromText(data, text);
	      if (data.images.length >= 80) break;
	    }
	    if (scriptAdded > 0) dbg.attributeSources.push(`script-images.+${scriptAdded}`);
	  } catch (e) {}
	  // v2.2.9.102 (fix): DOM img 兜底 — 轮播图/主图一定渲染在 <img> 上，
	  //   script/state 都漏时从 img 标签直接收（含 ozonstatic.cn 新 CDN 域名）
	  try {
	    let domAdded = 0;
	    const imgEls = Array.from(document.querySelectorAll('img[src*="multimedia"], img[src*="ozonstatic"], img[src*="ozone"], img[src*="ozon"]'));
	    for (const img of imgEls) {
	      const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
	      if (!src || !/^https?:\/\//i.test(src)) continue;
	      const before = data.images.length;
	      addImageUrl(data, src);
	      if (data.images.length > before) domAdded++;
	      if (data.images.length >= 80) break;
	    }
	    if (domAdded > 0) dbg.attributeSources.push(`dom-img.+${domAdded}`);
	  } catch (e) {}
    }
  } catch (e) {}

  // ========== 5. DOM 提取 (兜底 + 补充) ==========
  if (!data.name) {
    const h1 = document.querySelector('h1');
    if (h1) data.name = h1.textContent.trim();
  }
  if (!data.name) {
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) data.name = ogTitle.getAttribute("content") || "";
  }

	  const beforeDomImages = data.images.length;
	  document.querySelectorAll('img[src*="ozonusercontent"], img[src*="cdn1.ozone"], img[src*="ozone.ru"], source[srcset*="ozon"], source[srcset*="ozone"]').forEach((img) => {
	    const srcs = [
	      img.src,
	      img.dataset?.src,
	      img.getAttribute("data-src"),
	      img.getAttribute("srcset"),
	      img.getAttribute("data-srcset"),
	    ].filter(Boolean);
	    for (const src of srcs) {
	      String(src).split(",").forEach(part => addImageUrl(data, part.trim().split(/\s+/)[0]));
	    }
	  });
	  const ogImage = document.querySelector('meta[property="og:image"]');
	  if (ogImage) addImageUrl(data, ogImage.getAttribute("content"));
	  if (data.images.length > beforeDomImages) {
	    dbg.attributeSources.push(`DOM-images.+${data.images.length - beforeDomImages}`);
	  }
	  data.primary_image = data.images[0] || "";
	  dbg.imageCount = data.images.length;

  // ========== 6. 提取价格 ==========
  // v2.2.9.101 (fix): Ozon 页面同时有 webPrice（卖家设置价 95）和 finalPrice（买家实际支付价 69，含平台自动拉活动折扣）。
  //   之前只取第一个匹配（webPrice）→ 拿到的都是设置价，取不到"被拉活动"后的买家价。
  //   现在独立提取：webPrice→data.price(设置价)，finalPrice→data.final_price(买家价)，两者都保留。
  const readWidgetPrice = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return "";
    const text = (el.textContent || el.getAttribute("content") || "").trim();
    const m = text.match(/(\d[\d\s]*)/);
    return m ? m[1].replace(/\s/g, "") : "";
  };
  const webPrice = readWidgetPrice('[data-widget="webPrice"] [class*="price"]');
  const finalPrice = readWidgetPrice('[data-widget="finalPrice"] [class*="price"]');
  if (finalPrice) {
    data.final_price = finalPrice;
    dbg.attributeSources.push(`finalPrice.webPrice-vs-final=${webPrice}/${finalPrice}`);
  }
  if (!data.price) {
    data.price = webPrice || finalPrice;
    if (data.price) dbg.attributeSources.push(`price.webPrice`);
  }
  if (!data.price) {
    const legacySelectors = [
      '[itemprop="price"]',
      '[data-widget="price"]',
      '.price-block [class*="final"]',
    ];
    for (const sel of legacySelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const text = (el.textContent || el.getAttribute("content") || "").trim();
        const m = text.match(/(\d[\d\s]*)/);
        if (m) {
          data.price = m[1].replace(/\s/g, "");
          dbg.attributeSources.push(`price.${sel}`);
          break;
        }
      }
    }
  }
  if (!data.price) {
    const bodyText = document.body?.innerText || "";
    const priceMatches = Array.from(bodyText.matchAll(/(\d[\d\s]{1,12}(?:[,.]\d{1,2})?)\s*(?:₽|руб|RUB|¥|￥)/gi))
      .map((m) => m[1].replace(/\s/g, "").replace(",", "."))
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    if (priceMatches.length) {
      data.price = String(priceMatches[0]);
      dbg.attributeSources.push("price.bodyText");
    }
  }

  // ========== 7. 提取 attributes 列表 (Ozon "Характеристики" 区块) ==========
  // Ozon 商品页的属性通常是 div 容器里, key:value 形式
  if (data.attributes.length === 0) {
    // 尝试多种 Ozon 属性区块 selector
    const attributeContainerSelectors = [
      '[data-widget="webCharacteristics"]',
      '[data-widget="characteristics"]',
      'div[class*="characteristics"]',
      'div[id*="characteristics"]',
    ];
    for (const sel of attributeContainerSelectors) {
      const container = document.querySelector(sel);
      if (container) {
        // 找所有 key-value 对
        const rows = container.querySelectorAll('[class*="row"], [class*="item"], dl > div, tr');
        for (const row of rows) {
          const kEl = row.querySelector('[class*="name"], [class*="key"], dt, th, span:first-child');
          const vEl = row.querySelector('[class*="value"], [class*="val"], dd, td, span:last-child');
          if (kEl && vEl) {
            const name = kEl.textContent.trim();
            const value = vEl.textContent.trim();
            if (name && value && name !== value && value.length < 200) {
              data.attributes.push({ name, value });
            }
          }
        }
        if (data.attributes.length > 0) {
          dbg.attributeSources.push(`DOM.${sel}`);
          break;
        }
      }
    }
  }

  // ========== 8. 提取 brand (DOM 兜底) ==========
  if (!data.brand) {
    const brandEl = document.querySelector('[data-widget="webBrand"] a, [class*="brand"] a, [itemprop="brand"]');
    if (brandEl) {
      data.brand = brandEl.textContent.trim();
      dbg.attributeSources.push(`brand.DOM`);
    }
  }

  // ========== 8.5 v2.2.9.5+: attribute 9048 (Название модели) 自动兜底 ==========
  //   Ozon /v3/product/import 接受商品 (imported) 但 attribute 9048 空的话, 商品在 seller 后台无法正常上架
  //   公开页 attributes 没抓到时, 从商品 name 自动提取型号名称
  //   规则: 跳过通用词 (тент/большой/туристический/... + 尺寸/容量/颜色等), 取剩下的英文品牌词段
  //   例: 'Большой туристический тент Cloud Skies Tarp Lite (L), 500х380 см' → 'Cloud Skies Tarp Lite (L)'
  if (!data.attributes.some(a => a.id === 9048)) {
    let model = "";
    if (data.name) {
      // v2.2.9.100: 先清洗标题（去 " - купить на OZON"），避免把 OZON/купить 当型号
      const cleanName = cleanOzonTitle(data.name);
      // 1) 取第一个逗号前的主段 (去掉尺寸/容量/颜色等后缀)
      const mainPart = cleanName.split(",")[0].trim();
      // 2) 过滤掉通用俄文词 (帐篷/旅行/大型/参数等), 剩下的英文+数字+括号当型号
      const tokens = mainPart.split(/\s+/);
      const genericRu = /^(большой|маленький|туристический|походный|складной|детский|зимний|летний|домашний|уличный|портативный|новый|оригинальный|универсальный|легкий|тяжелый)$/i;
      const kept = tokens.filter(t => {
        if (genericRu.test(t)) return false;
        // v2.2.9.100: 平台词(ozon/купить)永远不当型号
        if (/^(ozon|купить|buy|покупать)$/i.test(t)) return false;
        // 跳过纯俄文长词 (形容词)
        if (/^[А-Яа-яЁё]{4,}$/.test(t) && !/[A-Za-z]/.test(t)) return false;
        // 跳过纯数字 / 数字+单位
        if (/^\d+([.,]\d+)?$/.test(t)) return false;
        if (/^\d+\s*(см|мм|м|г|кг|л|мл|w|wt|hz|×|х)$/i.test(t)) return false;
        return true;
      });
      model = kept.join(" ").trim();
    }
    if (model && model.length >= 2) {
      data.attributes.push({ id: 9048, name: "Название модели", value: model });
      dbg.attributeSources.push("attribute-9048-from-name");
      console.log(`[zhumeng-extract] attribute 9048 (Название модели) 自动提取: "${model}"`);
    }
  }

  // ========== 9. 提取 country_of_origin (原产国) ==========
	  if (!data.country_of_origin && data.attributes.length > 0) {
	    const countryAttr = data.attributes.find(a => {
	      const n = a.name.toLowerCase();
	      return n.includes("страна") || n.includes("country") || n.includes("产地") || n.includes("国家");
	    });
	    if (countryAttr) data.country_of_origin = countryAttr.value;
	  }

  // ========== 9.5. 提取 Ozon 富内容 JSON (attribute 11254) ==========
  try {
    const richContent = await collectRichContentFromOzonPage(sku);
    if (richContent) {
      data.richContent = richContent;
      data.attributes.push({ id: 11254, name: "JSON Rich Content", value: richContent });
      dbg.richContentBytes = richContent.length;
      dbg.attributeSources.push("rich-content.11254");
    }
  } catch (e) {
    dbg.richContentError = e.message || String(e);
  }

	  // ========== 10. 调试信息 ==========
  // 截断 attributes 数组, 避免 _debug 太大
  dbg.attributesFound = data.attributes.length;
  dbg.attributesFirst3 = data.attributes.slice(0, 3);
  dbg.fullStateKeys = dbg.fullStateObject ? Object.keys(dbg.fullStateObject) : null;

	  // _debug 不返回 fullStateObject (太大), 只返回关键 keys
	  delete dbg.fullStateObject;
	  delete data._imageKeys;
	  delete data._attrKeys;

	  data._debug = dbg;
  return data;

  } catch (e) {
    console.error("[zhumeng-extract] FATAL 抛错:", e.message, e.stack);
    return {
      sku: String(sku || ""),
      name: "",
      description_category_id: 0,
      type_id: 0,
      images: [],
      attributes: [],
      _error: e.message,
      _stack: (e.stack || "").slice(0, 500),
      raw_url: location.href,
    };
  }
}





// ========== 消息监听 ==========
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log(`[SW ${VERSION}] 收到消息:`, msg.action, msg.skus ? `(${msg.skus.length} SKU)` : "");

  if (msg.action === "ping") {
    sendResponse({ ok: true, version: VERSION });
    return;
  }

  // v2.2.9.5: 让 ERP 强制 reload plugin (cache 不更新时用)
  if (msg.action === "reloadPlugin") {
    console.log(`[SW ${VERSION}] 收到 reloadPlugin 请求, 1s 后 reload service worker`);
    setTimeout(() => chrome.runtime.reload(), 1000);
    sendResponse({ ok: true, willReload: true });
    return;
  }

  if (msg.action === "diagnose") {
    (async () => {
      const diag = { version: VERSION, timestamp: new Date().toISOString() };
      try {
        const cookies = await chrome.cookies.getAll({ url: "https://seller.ozon.ru" });
        diag.sellerCookies = cookies.length;
        diag.sessionCookies = cookies.filter((c) =>
          c.name.includes("access-token") || c.name.includes("session") ||
          c.name.includes("auth") || c.name.includes("token")
        ).length;
      } catch (e) { diag.cookieError = e.message; }
      try {
        const ozonTabs = await chrome.tabs.query({ url: "https://www.ozon.ru/*" });
        diag.ozonTabs = ozonTabs.length;
      } catch (e) { diag.tabError = e.message; }
      console.log(`[SW ${VERSION}] diagnose:`, JSON.stringify(diag));
      sendResponse({ ok: true, diag });
    })();
    return true;
  }

  if (msg.action === "configureWorkerAuth") {
    (async () => {
      try {
        const result = await configureWorkerAuth(msg.token || "");
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e), version: VERSION });
      }
    })();
    return true;
  }

  if (msg.action === "collectSkus") {
    const skus = msg.skus || [];
    const storeIds = msg.storeIds || [];  // v2.1: ERP 传店铺 ID
    const silent = msg.silent === true;   // v2.2.9.100: 批量上架静默采集（不弹 Ozon 标签页）
    (async () => {
      const results = {};
      const errors = {};
      console.log(`[SW ${VERSION}] collectSkus 开始: ${skus.length} 个 SKU, ${storeIds.length} 个店铺, silent=${silent}`);
      // v2.2.9.100: 并发 5 个采集提速（静默走 seller portal API，风控风险低）
      const CONCURRENCY = 5;
      const queue = [...skus];
      let cursor = 0;
      const runWorker = async () => {
        while (cursor < queue.length) {
          const sku = queue[cursor];
          cursor += 1;
          try {
            results[sku] = await collectSku(sku, storeIds, null, { silent });
          } catch (e) {
            errors[sku] = e.message;
            console.error(`[SW ${VERSION}] ✗ 采集失败 ${sku}:`, e.message);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, queue.length)) }, runWorker));
      const okCount = Object.keys(results).length;
      const failCount = Object.keys(errors).length;
      console.log(`[SW ${VERSION}] collectSkus 完成: ${okCount} 成功, ${failCount} 失败`);
      sendResponse({ ok: true, results, errors });
    })();
    return true;
  }

  if (msg.action === "portalImport") {
    (async () => {
      try {
        const result = await portalImportItems(msg.items || [], sender?.tab?.id || null);
        sendResponse({ ok: true, result });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e), version: VERSION });
      }
    })();
    return true;
  }

  if (msg.action === "discoverOzonProducts") {
    const searchQuery = String(msg.query || msg.search || "").trim();
    const strategyType = String(msg.strategy_type || "hot").trim();
    const maxProducts = Math.min(100, Math.max(5, Number(msg.limit || 30)));
    const categoryLabel = String(msg.category_label || "").trim();
    (async () => {
      try {
        const result = await discoverOzonProductsFromSearch(searchQuery, strategyType, maxProducts, categoryLabel, msg.progress_callback_tab_id);
        sendResponse({ ok: true, ...result });
      } catch (e) {
        console.error(`[SW ${VERSION}] discoverOzonProducts error:`, e.message);
        sendResponse({ ok: false, error: e.message || String(e), version: VERSION });
      }
    })();
    return true;
  }

  if (msg.action === "discoverCategoryPage") {
    const categoryUrl = String(msg.category_url || msg.url || "").trim();
    const categoryName = String(msg.category_name || "").trim();
    const strategyType = String(msg.strategy_type || "hot").trim();
    const maxProducts = Math.min(100, Math.max(5, Number(msg.limit || 30)));
    (async () => {
      try {
        const result = await discoverOzonCategoryProducts(categoryUrl, categoryName, strategyType, maxProducts);
        sendResponse({ ok: true, ...result });
      } catch (e) {
        console.error(`[SW ${VERSION}] discoverCategoryPage error:`, e.message);
        sendResponse({ ok: false, error: e.message || String(e), version: VERSION });
      }
    })();
    return true;
  }

  if (msg.action === "checkStatus") {
    (async () => {
      // 简化: 只看 seller.ozon.ru cookie
      try {
        const cookies = await chrome.cookies.getAll({ url: "https://seller.ozon.ru" });
        const sessionCookies = cookies.filter((c) =>
          c.name.includes("access-token") || c.name.includes("session") ||
          c.name.includes("auth") || c.name.includes("token")
        );
        sendResponse({
          ok: true,
          seller_connected: sessionCookies.length > 0,
          session_valid: sessionCookies.length > 0,
          hasSellerTab: false,
          tabCount: 0,
          version: VERSION,
        });
      } catch (e) {
        sendResponse({ ok: false, error: e.message, version: VERSION });
      }
    })();
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  startSourcingQueueLoop();
});

chrome.runtime.onStartup.addListener(() => {
  startSourcingQueueLoop();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === "zhumeng-single-sourcing") {
    pollSourcingQueueOnce();
  }
});

startSourcingQueueLoop();

console.log(`[逐梦采集器 v${VERSION}] Service Worker 已加载 (${new Date().toISOString()}) - 新策略: 采集 www.ozon.ru 商品前端页 DOM`);

// v2.1.8 helper: 把 OPI attributes 合并到公开页采集的 data.attributes
//   公开页拿到 id+name+value 占位, OPI 更准的 values 用同 id 覆盖, 缺则 push
function mapOpiAttributes(opiAttrs, currentAttrs) {
  const attrs = Array.isArray(currentAttrs) ? [...currentAttrs] : [];
  let added = 0, overridden = 0;
  for (const a of (opiAttrs || [])) {
    const id = a.id;
    const name = a.name || "";
    let value = "";
    if (Array.isArray(a.values) && a.values.length) {
      value = a.values.map(v => v.value || v.text || "").filter(Boolean).join(", ");
    } else if (a.value !== undefined) {
      value = String(a.value);
    }
    if (!name && !value) continue;
    const idx = attrs.findIndex(x => x.id === id);
    const attrObj = { id, name, value };
    if (idx >= 0) {
      attrs[idx] = attrObj;
      overridden++;
    } else {
      attrs.push(attrObj);
      added++;
    }
  }
  return { attrs, added, overridden };
}
