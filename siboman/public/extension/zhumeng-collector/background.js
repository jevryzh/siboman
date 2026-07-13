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

const VERSION = "2.2.9.21";
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

  if (!result) {
    await safeRemoveTab(tab.id);
    throw new Error("executeScript 返回空 (可能商品页是空或被 Ozon 屏蔽)");
  }
  if (!result.name) {
    await safeRemoveTab(tab.id);
    throw new Error(`未提取到商品名. raw=${JSON.stringify(result).slice(0, 300)}`);
  }

  // v2.2.9.15: 优先复用 Seller 后台“复制商品”链路拿完整跟卖源包。
  // 公开页/OPI 只能兜底，My ERP 的完整属性、尺寸、富内容主要来自这个 bundle item。
  result._plugin_version = VERSION;
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
  return {
    variant_id: v.variant_id || (v.barcodes && v.barcodes[0]) || "",
    description_category_id: Number(v.description_type_dict_value) || 0,
    categories: (v.categories || []).map(c => ({
      id: Number(c.id),
      level: Number(c.level),
      name: c.name || "",
      title: c.title || c.name || "",
    })),
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
  if (sv.description_category_id && !data.type_id) data.type_id = Number(sv.description_category_id) || data.type_id;
  data._seller_bundle_source = {
    company_id: String(companyId),
    variant_id: String(sv.variant_id),
    bundle_id: bundleResp?.bundle_id || null,
    attr_count: Array.isArray(bundleItem.attributes) ? bundleItem.attributes.length : 0,
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
    await chrome.tabs.remove(tabId);
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
  if (!/(ozone\.ru|ozonusercontent\.com|ozonru\.cn)/i.test(s)) return "";
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
  const re = /(?:https?:)?\/\/(?:ir(?:-\d+)?\.ozonru\.cn|ir\.ozone\.ru|cdn1\.ozone\.ru|[^"'<>\s()]+ozonusercontent\.com)\/[^"'<>\s()\\]+/gi;
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
      for (const nextPage of collectOzonRichContentPagePaths(states, currentPath || cleanPath || skuPath)) enqueuePath(nextPage);
      const rich = extractRichContentFromStates(states);
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
	      if (!text || !/(ozone\.ru|ozonusercontent\.com|ozonru\.cn|multimedia|images)/i.test(text)) continue;
	      scriptAdded += collectImagesFromText(data, text);
	      if (data.images.length >= 80) break;
	    }
	    if (scriptAdded > 0) dbg.attributeSources.push(`script-images.+${scriptAdded}`);
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
