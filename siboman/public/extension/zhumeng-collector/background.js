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

const VERSION = "2.2.4";
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
  
  // 3. 注入提取函数并执行
  let result;
  try {
    const [execResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractOzonProductData,
      args: [sku],
    });
    result = execResult?.result;
  } catch (e) {
    await safeRemoveTab(tab.id);
    throw new Error(`executeScript 失败: ${e.message}`);
  }
  
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
      const resolved = await resolveSellerCategory(result.sku || result.product_id, storeIds[0], result.type_id);
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
        // v2.2.4: 失败时清掉 URL 的旧 cat (5 位面包屑 ID 不是 Seller API 的 8 位 ID)
        //   否则 publish 把 9700 提交给 Ozon 会立刻被 Ozon 拒 (levels_category_not_found)
        result.description_category_id = 0;
        result._category_resolved = {
          from: oldCat,
          to: 0,
          source: 'none',
          confidence: 'none',
          candidates: resolved.candidates || [],
          warning: '请在 BatchUpload 页面从候选类目中点选 (URL 面包屑 ID 不是 Seller API ID)',
        };
        console.log(`[SW ${VERSION}]   类目无法解析, ${(resolved.candidates || []).length} 个候选待 user 选 (旧 cat=${oldCat} 已清零, 防误提交)`);
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
async function resolveSellerCategory(sku, storeId, typeId) {
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
  const breadcrumbSelectors = [
    '[data-widget="breadCrumbs"] a',
    '[data-widget="webBreadcrumb"] a',
    'ol.breadcrumb a, ol[itemtype*="BreadcrumbList"] a',
    'nav[aria-label*="eadcrumb" i] a',
    'a[href*="/category/"]',
  ];
  for (const sel of breadcrumbSelectors) {
    const links = document.querySelectorAll(sel);
    for (const a of links) {
      const href = a.href || "";
      if (!href.includes("/category/")) continue;
      dbg.breadcrumbLinks.push(href);
      const m = href.match(/\/category\/[^\/?#]*?(\d{2,})(?:\/|\?|#|$)/);
      if (m) {
        const id = parseInt(m[1], 10);
        if (id && id > 1000 && !data.description_category_id) {
          data.description_category_id = id;
        }
      }
    }
    if (data.description_category_id) break;
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
}

// 深度遍历找完整商品对象
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

// 把找到的 Ozon 内部商品对象 merge 到 data
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

// 解析 weight 字符串
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

// ========== 消息监听 ==========
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log(`[SW ${VERSION}] 收到消息:`, msg.action, msg.skus ? `(${msg.skus.length} SKU)` : "");

  if (msg.action === "ping") {
    sendResponse({ ok: true, version: VERSION });
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
