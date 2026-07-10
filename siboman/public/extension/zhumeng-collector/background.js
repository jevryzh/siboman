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

const VERSION = "2.2.9.10";
const OZON_FRONTEND_ORIGIN = "https://www.ozon.ru";
const OZON_PRODUCT_URL = (sku) => `https://www.ozon.ru/product/${sku}/`;
const OPI_BASE_URL = "https://api-seller.ozon.ru";
const ERP_BACKEND_ORIGIN = "http://test.renwz.cn";  // ERP 后端 (拿凭证)

// ========== 采集核心: 打开 Ozon 商品前端页 + executeScript 提取 ==========
async function collectSku(sku, storeIds = []) {
  const url = OZON_PRODUCT_URL(sku);
  console.log(`[SW ${VERSION}] 采集 SKU ${sku}: 准备打开 ${url}, stores=${storeIds.length}`);
  
  // 1. 打开 Ozon 商品页 (后台 tab, 不打扰用户)
  const tab = await chrome.tabs.create({ url, active: false });
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
    if (attempt < maxRetries) await new Promise(r => setTimeout(r, 2000));
  }
  if (!result && lastRaw) console.warn(`[SW ${VERSION}]   polling 15 次都失败, 最后 raw: ${lastRaw}`);

  // 4. 关闭 tab
  await safeRemoveTab(tab.id);
  
  if (!result) {
    throw new Error("executeScript 返回空 (可能商品页是空或被 Ozon 屏蔽)");
  }
  if (!result.name) {
    throw new Error(`未提取到商品名. raw=${JSON.stringify(result).slice(0, 300)}`);
  }

  // v2.1: 辅源 - Ozon Seller API 找店铺里同款商品复用 attributes
  if (storeIds && storeIds.length > 0 && result.description_category_id) {
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
    result._opi_enriched = "skipped";
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
      if (resolved && resolved.success) {
        result.description_category_id = resolved.description_category_id;
        if (resolved.type_id && !result.type_id) result.type_id = resolved.type_id;
        result._category_resolved = {
          from: oldCat,
          to: resolved.description_category_id,
          source: resolved.source,
          confidence: resolved.confidence || 'high',
        };
        console.log(`[SW ${VERSION}]   类目解析: ${oldCat} → ${resolved.description_category_id} (${resolved.source}, confidence=${resolved.confidence})`);
      } else if (resolved) {
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
      }
    } catch (e) {
      console.warn(`[SW ${VERSION}]   category-resolve 调用失败 (非致命, 用 URL cat 上传): ${e.message}`);
    }
  }

  // v1.0.9: 详细打印每个字段的来源 + 关键数据
  const dbg = result._debug || {};
  console.log(`[SW ${VERSION}] ✓ 采集 ${sku}: ${result.name?.slice(0, 50)}`);
  console.log(`[SW ${VERSION}]   字段: images=${result.images.length} | cat=${result.description_category_id} | type=${result.type_id} | brand=${result.brand || "(空)"} | weight=${result.weight}g | dims=${result.depth}x${result.width}x${result.height} | price=${result.price || "(空)"} | barcode=${result.barcode || "(空)"} | country=${result.country_of_origin || "(空)"}`);
  console.log(`[SW ${VERSION}]   attributes: ${result.attributes.length} 个, opi=${result._opi_enriched}${result._opi_error ? " (error: "+result._opi_error+")" : ""}`);
  if (result.attributes.length > 0) {
    console.log(`[SW ${VERSION}]   attributes 前 3 个: ${JSON.stringify(result.attributes.slice(0, 3))}`);
  }
  console.log(`[SW ${VERSION}]   _debug 详情: ${JSON.stringify(dbg)}`);

  return result;
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
    const timer = setTimeout(() => ctrl.abort(), 15000);
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
    await chrome.tabs.remove(tabId);
  } catch (e) {
    // tab 已关闭, 忽略
  }
}

// ========== 注入到 Ozon 商品页的提取函数 (IIFE) ==========
// 这个函数被 executeScript 注入到 www.ozon.ru 商品页, 在 page context 跑
// v1.0.9 大幅扩展: 把上架需要的全部字段都尝试从页面拿到
function extractOzonProductData(sku) {
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
  if (Array.isArray(obj.images) && data.images.length === 0) {
    for (const img of obj.images) {
      const url = typeof img === "string" ? img : (img.url || img.file_name || img.src);
      if (url && !data.images.includes(url)) data.images.push(url);
    }
  }

  // Attributes 数组 (Ozon 格式: [{id, name, values: [{value}]}])
  if (Array.isArray(obj.attributes) && data.attributes.length === 0) {
    for (const attr of obj.attributes) {
      const id = attr.id || attr.attribute_id;
      const name = attr.name || attr.title || "";
      let value = "";
      if (Array.isArray(attr.values) && attr.values.length > 0) {
        value = typeof attr.values[0] === "string" ? attr.values[0] : (attr.values[0]?.value || attr.values[0]?.text || "");
      } else if (attr.value) {
        value = String(attr.value);
      }
      if (name && value) {
        data.attributes.push({ id, name, value });
      }
    }
  }

  // complex_attributes (Ozon 格式可能不同, 原样保留)
  if (Array.isArray(obj.complex_attributes) && data.complex_attributes.length === 0) {
    data.complex_attributes = obj.complex_attributes;
  }
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
                if (img && !data.images.includes(img)) data.images.push(img);
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

  if (data.images.length === 0) {
    document.querySelectorAll('img[src*="ozonusercontent"], img[src*="cdn1.ozone"], img[src*="ozone.ru"]').forEach((img) => {
      const src = img.src || img.dataset.src || img.getAttribute("data-src");
      if (src && !data.images.includes(src) && !src.includes("svg")) {
        data.images.push(src);
      }
    });
    if (data.images.length === 0) {
      const ogImage = document.querySelector('meta[property="og:image"]');
      if (ogImage) {
        const src = ogImage.getAttribute("content");
        if (src) data.images.push(src);
      }
    }
  }
  data.primary_image = data.images[0] || "";
  dbg.imageCount = data.images.length;

  // ========== 6. 提取价格 ==========
  if (!data.price) {
    const priceSelectors = [
      '[data-widget="webPrice"] [class*="price"]',
      '[data-widget="finalPrice"] [class*="price"]',
      '[itemprop="price"]',
      '[data-widget="price"]',
      '.price-block [class*="final"]',
    ];
    for (const sel of priceSelectors) {
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
      // 1) 取第一个逗号前的主段 (去掉尺寸/容量/颜色等后缀)
      const mainPart = data.name.split(",")[0].trim();
      // 2) 过滤掉通用俄文词 (帐篷/旅行/大型/参数等), 剩下的英文+数字+括号当型号
      const tokens = mainPart.split(/\s+/);
      const genericRu = /^(большой|маленький|туристический|походный|складной|детский|зимний|летний|домашний|уличный|портативный|новый|оригинальный|универсальный|легкий|тяжелый)$/i;
      const kept = tokens.filter(t => {
        if (genericRu.test(t)) return false;
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
      console.log(`[SW ${VERSION}]   attribute 9048 (Название модели) 自动提取: "${model}"`);
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

  // ========== 10. 调试信息 ==========
  // 截断 attributes 数组, 避免 _debug 太大
  dbg.attributesFound = data.attributes.length;
  dbg.attributesFirst3 = data.attributes.slice(0, 3);
  dbg.fullStateKeys = dbg.fullStateObject ? Object.keys(dbg.fullStateObject) : null;

  // _debug 不返回 fullStateObject (太大), 只返回关键 keys
  delete dbg.fullStateObject;

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

  if (msg.action === "collectSkus") {
    const skus = msg.skus || [];
    const storeIds = msg.storeIds || [];  // v2.1: ERP 传店铺 ID
    (async () => {
      const results = {};
      const errors = {};
      console.log(`[SW ${VERSION}] collectSkus 开始: ${skus.length} 个 SKU, ${storeIds.length} 个店铺`);
      for (const sku of skus) {
        try {
          results[sku] = await collectSku(sku, storeIds);
        } catch (e) {
          errors[sku] = e.message;
          console.error(`[SW ${VERSION}] ✗ 采集失败 ${sku}:`, e.message);
        }
      }
      const okCount = Object.keys(results).length;
      const failCount = Object.keys(errors).length;
      console.log(`[SW ${VERSION}] collectSkus 完成: ${okCount} 成功, ${failCount} 失败`);
      sendResponse({ ok: true, results, errors });
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
