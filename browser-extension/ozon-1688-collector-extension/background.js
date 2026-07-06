const DEFAULT_SERVER_URL = "http://xm.renwz.cn";
const HEARTBEAT_ALARM = "ozon1688CollectorHeartbeat";
const HEARTBEAT_MINUTES = 1;
const OZONE_LINK_RE = /https?:\/\/(?:www\.)?ozon\.ru\/product\/[^\s]+/i;
const MTOP_URL = "https://h5api.m.1688.com/h5/mtop.relationrecommend.wirelessrecommend.recommend/2.0/";
const APP_KEY = "12574478";
const LOW_PRICE_THRESHOLD_RMB = 1;
const PROMOTION_PATTERN = /首单|首件|首购|新人|新客|新用户|新人价|新客价|首单价|首单减|首购价|立减|满减|优惠|优惠券|券后|领券|补贴|到手价|特价|限时|促销|专享|折扣|discount|coupon|new\s*user|first\s*order/i;

let isPolling = false;

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(["serverUrl", "workerName", "enableJobClaiming"]);
  const updates = {};
  if (!stored.serverUrl) updates.serverUrl = DEFAULT_SERVER_URL;
  if (!stored.workerName) updates.workerName = defaultWorkerName();
  if (stored.enableJobClaiming === undefined) updates.enableJobClaiming = false;
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return;
  heartbeat().catch((error) => setState({ lastError: error.message, online: false }));
  pollJob().catch((error) => setState({ lastError: error.message || String(error) }));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

async function handleMessage(message = {}) {
  if (message.type === "get-state") return getPublicState();
  if (message.type === "login") return login(message);
  if (message.type === "logout") return logout();
  if (message.type === "start") return start();
  if (message.type === "stop") return stop();
  if (message.type === "heartbeat") return heartbeat();
  if (message.type === "set-claiming") return setClaiming(Boolean(message.enabled));
  throw new Error("未知操作。");
}

async function pollJob() {
  if (isPolling) return;
  const state = await getStoredState();
  if (!state.running || !state.token || !state.enableJobClaiming) return;

  isPolling = true;
  try {
    const response = await fetch(`${state.serverUrl}/api/worker/jobs/next`, {
      method: "POST",
      headers: authHeaders(state),
      body: JSON.stringify(workerMeta(state, "浏览器插件在线，可领取任务")),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) throw new Error(data.error || `领取任务失败：HTTP ${response.status}`);
    if (data.job) await runJob(data.job, state);
  } finally {
    isPolling = false;
  }
}

async function runJob(job, state) {
  const logs = Array.isArray(job.logs) ? [...job.logs, makeLog("插件已领取任务。")] : [makeLog("插件已领取任务。")];
  const kind = job.kind === "batch-ozon" ? "batch-ozon" : "run";
  const payload = job.payload || {};
  const options = payload.options || {};
  let results = Array.isArray(job.results) ? [...job.results] : [];
  let total = 0;

  try {
    if (kind === "batch-ozon") {
      const sourceUrl = payload.sourceUrl || options.sourceUrl;
      if (!sourceUrl) throw new Error("批量任务缺少来源链接。");
      const maxProducts = clampNumber(options.maxProducts, 1, 500, 50);
      await updateProgress(job.id, "正在发现 Ozon 商品链接", 0, maxProducts, state, "running", logs);
      const productUrls = await collectOzonLinks(sourceUrl, maxProducts);
      total = productUrls.length;
      logs.push(makeLog(`已发现 ${total} 个商品链接。`));
      await updateProgress(job.id, "正在逐个采集 Ozon 商品", 0, total, state, "running", logs);

      const doneRows = new Set(results.map((item) => Number(item?.sourceRow || 0)).filter(Boolean));
      for (let index = 0; index < productUrls.length; index += 1) {
        await ensureJobRunnable(job.id, state);
        const url = productUrls[index];
        const sourceRow = index + 1;
        if (doneRows.has(sourceRow)) continue;
        const result = await collectOzonResult(url, sourceRow, options, "batch");
        applyBatchFilters(result, options.filters || {});
        results.push(result);
        logs.push(makeLog(`第 ${sourceRow}/${total} 条完成：${result.ozon?.title || url}`));
        await updateProgress(job.id, `批量采集 ${sourceRow}/${total}`, sourceRow, total, state, "running", logs, results);
        await sleep(randomDelay(options.delayMinMs, options.delayMaxMs));
      }
    } else {
      const urlRows = Array.isArray(payload.urlRows) && payload.urlRows.length
        ? payload.urlRows
        : normalizeUrls(payload.urls || options.urls || payload.raw?.urlsText || "");
      if (!urlRows.length) throw new Error("单品任务没有可采集的 Ozon 链接。");
      total = urlRows.length;
      await updateProgress(job.id, "正在逐个采集 Ozon 商品", 0, total, state, "running", logs);

      const doneKeys = new Set(results.map((item) => `${Number(item?.sourceRow || 0)}:${item?.url || ""}`));
      for (let index = 0; index < urlRows.length; index += 1) {
        await ensureJobRunnable(job.id, state);
        const row = typeof urlRows[index] === "string" ? { url: urlRows[index], sourceRow: index + 1 } : urlRows[index];
        const sourceRow = row.sourceRow || index + 1;
        if (doneKeys.has(`${Number(sourceRow)}:${row.url || ""}`)) continue;
        const result = await collectOzonResult(row.url, sourceRow, options, "single");
        results.push(result);
        logs.push(makeLog(`第 ${index + 1}/${total} 条完成：${result.ozon?.title || row.url}`));
        await updateProgress(job.id, `单品找货 ${index + 1}/${total}`, index + 1, total, state, "running", logs, results);
        await sleep(randomDelay(options.delayMinMs, options.delayMaxMs));
      }
    }

    const completed = {
      ...job,
      kind,
      status: "done",
      phase: "插件采集完成，服务器正在生成 Excel",
      processed: total,
      total,
      results,
      logs,
      error: "",
    };
    await completeJob(job.id, completed, state);
    await heartbeat();
  } catch (error) {
    if (error?.canceled) {
      logs.push(makeLog("检测到网页端停止任务，插件已停止领取后续链接。", "warn"));
      await updateProgress(job.id, "已停止", results.length, total || job.total || 0, state, "canceled", logs, results).catch(() => {});
      await heartbeat();
      return;
    }
    if (error?.paused) {
      logs.push(makeLog("检测到网页端暂停任务，插件已暂停当前任务。", "warn"));
      await heartbeat();
      return;
    }
    logs.push(makeLog(`任务失败：${error.message}`, "error"));
    await updateProgress(job.id, `任务失败：${error.message}`, results.length, total || job.total || 0, state, "error", logs, results);
    await completeJob(job.id, {
      ...job,
      kind,
      status: "error",
      phase: "插件采集失败",
      processed: results.length,
      total: total || job.total || 0,
      results,
      logs,
      error: error.message,
    }, state).catch(() => {});
    throw error;
  }
}

async function collectOzonResult(url, sourceRow, options, mode) {
  const result = {
    sourceRow,
    url,
    ozon: {},
    candidates: [],
    selectedCandidate: null,
    aiReview: null,
    searchError: "",
    error: "",
  };
  try {
    result.ozon = await scrapeOzonProduct(url);
    if (mode === "single" && options.enable1688 !== false) {
      if (!result.ozon.mainImageUrl) {
        result.searchError = "未识别到 Ozon 主图，无法进行 1688 以图搜货。";
      } else {
        const search = await search1688ByImageUrl(result.ozon.mainImageUrl, options.maxCandidates || 5, sourceRow, result.ozon);
        if (search.success) {
          result.candidates = search.candidates;
        } else {
          result.searchError = search.error;
        }
      }
    }
  } catch (error) {
    result.error = error.message || String(error);
  }
  return result;
}

async function search1688ByImageUrl(imageUrl, maxCandidates, productIndex, ozon) {
  try {
    const cookieState = await ensure1688CookieState();
    if (!cookieState.token) {
      return {
        success: false,
        error: "没有拿到 1688 搜图 token。请先在当前 Chrome 登录 1688，再回到插件开启领取任务。",
      };
    }
    await reportLocalPhase(`1688 搜图 ${productIndex}：正在下载 Ozon 主图`);
    const base64Image = await imageUrlToCompressedBase64(imageUrl);
    await reportLocalPhase(`1688 搜图 ${productIndex}：正在上传图片`);
    const imageId = await uploadImageTo1688(base64Image, cookieState);
    await sleep(900 + Math.floor(Math.random() * 1600));
    await reportLocalPhase(`1688 搜图 ${productIndex}：正在获取候选货源`);
    const basicCandidates = (await searchOffersByImageId(imageId, cookieState)).slice(0, clampNumber(maxCandidates, 1, 20, 5));
    const candidates = [];
    for (let index = 0; index < basicCandidates.length; index += 1) {
      const candidate = basicCandidates[index];
      if (index > 0) await sleep(1200 + Math.floor(Math.random() * 2600));
      await reportLocalPhase(`1688 候选详情 ${productIndex}-${index + 1}`);
      const details = await scrape1688CandidateDetails(candidate);
      candidates.push(annotateCandidateQuantity(addTrafficBaitAssessment(merge1688CandidateDetails(candidate, details)), ozon));
    }
    return { success: true, candidates };
  } catch (error) {
    if (isMtopTokenError(error.message)) {
      return { success: false, error: "1688 搜图 token 失效，请打开 1688 页面刷新登录状态后重试。" };
    }
    return { success: false, error: error.message || String(error) };
  }
}

async function imageUrlToCompressedBase64(imageUrl) {
  const response = await fetch(imageUrl, { credentials: "include" });
  if (!response.ok) throw new Error(`Ozon 主图下载失败：HTTP ${response.status}`);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob).catch(() => null);
  if (bitmap && typeof OffscreenCanvas !== "undefined") {
    const maxSide = 900;
    const ratio = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * ratio));
    const height = Math.max(1, Math.round(bitmap.height * ratio));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, width, height);
    const compressed = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
    return arrayBufferToBase64(await compressed.arrayBuffer());
  }
  return arrayBufferToBase64(await blob.arrayBuffer());
}

async function uploadImageTo1688(base64Image, cookieState) {
  const uploadParams = {
    appId: 32517,
    params: JSON.stringify({
      beginPage: 1,
      pageSize: 60,
      searchScene: "pcImageSearch",
      method: "uploadBase64WithRequest",
      appName: "pctusou",
      imageBase64: base64Image,
      tab: "imageSearch",
      spm: "a26352.b28411319/2508.imagesearch.upload",
      sortType: "normal",
    }),
  };
  const dataStr = JSON.stringify(uploadParams);
  const timestamp = String(Date.now());
  const url = buildMtopUrl({
    t: timestamp,
    sign: md5(`${cookieState.token}&${timestamp}&${APP_KEY}&${dataStr}`),
    type: "originaljson",
    dataType: "jsonp",
    jsonpIncPrefix: "reqTppId_32517_getOfferList",
  });
  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json,text/plain,*/*",
    },
    body: `data=${encodeURIComponent(dataStr)}`,
  });
  const json = parseMtopText(await response.text());
  assertMtopSuccess(json, "上传图片失败");
  const imageId = json.data?.data?.imageId || json.data?.imageId || json.data?.result?.[0]?.imageId;
  if (!imageId) throw new Error(`上传成功但没有返回 imageId：${JSON.stringify(json).slice(0, 300)}`);
  return imageId;
}

async function searchOffersByImageId(imageId, cookieState) {
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
  const url = buildMtopUrl({
    t: timestamp,
    sign: md5(`${cookieState.token}&${timestamp}&${APP_KEY}&${dataStr}`),
    type: "jsonp",
    callback: "mtopjsonpreqTppId_32517_getOfferList2",
    dataType: "jsonp",
    jsonpIncPrefix: "reqTppId_32517_getOfferList",
    data: dataStr,
  });
  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: { "Accept": "application/json,text/plain,*/*" },
  });
  const json = parseMtopText(await response.text());
  assertMtopSuccess(json, "搜索 1688 失败");
  const offers = json.data?.data?.OFFER?.items || [];
  return offers.map((item, index) => {
    const data = item.data || {};
    const offerId = data.offerId || data.skuId || "";
    const moqItem = Array.isArray(data.afterPriceList)
      ? data.afterPriceList.find((entry) => entry.matKey === "quantity_begin")
      : null;
    const title = data.title || data.subject || "";
    const promotionText = collectPromotionTextFromValue(data);
    const packQuantity = inferPackQuantityFromText([title, promotionText].join(" "));
    return {
      rank: index + 1,
      title,
      price: data.priceInfo?.price || data.price || "",
      image: normalizeUrl(data.offerPicUrl || data.odPicUrl || data.mainImage || data.picUrl || ""),
      link: normalizeUrl(data.linkUrl || data.sameDesignUrl || (offerId ? `https://detail.1688.com/offer/${offerId}.html` : "")),
      shopName: data.shop?.text || data.shopAddition?.text || data.loginId || data.sellerName || "",
      moq: moqItem?.text || "1件起批",
      minOrderQuantity: moqItem?.text || "1件起批",
      promotionText,
      packQuantity: packQuantity.quantity,
      packQuantityEvidence: packQuantity.evidence,
      shippingFee: "",
      dimensionsText: "",
      weightText: "",
      priceDetails: "",
    };
  });
}

async function scrape1688CandidateDetails(candidate) {
  const link = candidate?.link || "";
  if (!link) return { detailError: "没有候选链接" };
  const tab = await chrome.tabs.create({ url: link, active: false });
  try {
    await waitForTabComplete(tab.id, 35000);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        for (let i = 0; i < 7; i += 1) {
          window.scrollBy(0, 450 + Math.floor(Math.random() * 500));
          await delay(450 + Math.floor(Math.random() * 700));
        }
        window.scrollTo(0, 0);
        await delay(500);
      },
    });
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (fallback) => {
        const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
        const pick = (...values) => values.map(clean).find(Boolean) || "";
        const parseWeight = (value) => {
          const text = clean(value);
          const match = text.match(/(\d+(?:[.,]\d+)?)\s*(kg|公斤|千克|g|克|mg|毫克)(?=$|[\s,.;，。；、/)\]}])/i);
          if (!match) return null;
          const number = Number(match[1].replace(",", "."));
          if (!Number.isFinite(number) || number <= 0) return null;
          const unit = match[2].toLowerCase();
          if (/kg|公斤|千克/.test(unit)) return Math.round(number * 1000);
          if (/mg|毫克/.test(unit)) return Math.max(1, Math.round(number / 1000));
          return Math.round(number);
        };
        const raw = window.__INIT_DATA?.data || window.context?.result?.data || window.iDetailData || {};
        const attrs = {};
        const addPair = (key, value) => {
          const k = clean(key).replace(/[:：]$/, "");
          const v = clean(value);
          if (k && v && k !== v && k.length <= 80 && v.length <= 300) attrs[k] = v;
        };
        const unwrap = (value) => (value && typeof value === "object" && value.fields ? value.fields : value);
        const productAttrs = unwrap(raw.productAttributes || {});
        if (productAttrs?.product_attributes) {
          for (const [key, value] of Object.entries(productAttrs.product_attributes)) addPair(key, value);
        } else if (productAttrs && typeof productAttrs === "object") {
          for (const [key, value] of Object.entries(productAttrs)) {
            if (typeof value === "string" || typeof value === "number") addPair(key, value);
          }
        }
        for (const row of document.querySelectorAll("dt")) {
          const dd = row.nextElementSibling;
          if (dd) addPair(row.innerText, dd.innerText);
        }
        for (const row of document.querySelectorAll("tr")) {
          const cells = Array.from(row.children).map((cell) => clean(cell.innerText)).filter(Boolean);
          if (cells.length >= 2) addPair(cells[0], cells.slice(1).join(" "));
        }
        const getAttr = (...names) => {
          const lowered = names.map((name) => String(name).toLowerCase());
          for (const [key, value] of Object.entries(attrs)) {
            const lower = key.toLowerCase();
            if (lowered.some((name) => lower.includes(name))) return value;
          }
          return "";
        };
        const asArray = (value) => Array.isArray(value) ? value : [];
        const mainPrice = unwrap(raw.mainPrice || {});
        const orderParamModel = unwrap(raw.orderParamModel || {});
        const skuParam = orderParamModel.orderParam?.skuParam || {};
        const trade = mainPrice.finalPriceModel?.tradeWithoutPromotion || {};
        const priceRanges = [
          ...asArray(skuParam.skuRangePrices),
          ...asArray(trade.offerPriceRanges),
        ]
          .map((item) => ({
            beginAmount: item.beginAmount ?? item.startAmount ?? item.quantity ?? "",
            price: item.price ?? item.discountPrice ?? item.value ?? "",
          }))
          .filter((item) => item.price !== "");
        const priceDetails = priceRanges.length
          ? priceRanges.map((item) => `${item.beginAmount || 1}件起 ¥${item.price}`).join("; ")
          : "";
        const prices = priceRanges
          .map((item) => Number(String(item.price).replace(/[^\d.]/g, "")))
          .filter((value) => Number.isFinite(value) && value > 0)
          .sort((a, b) => a - b);
        const bodyText = clean(document.body?.innerText || "");
        const moqFromPriceRange = priceRanges
          .map((item) => Number(item.beginAmount))
          .filter((value) => Number.isFinite(value) && value > 0)
          .sort((a, b) => a - b)[0];
        const moqFromDom = bodyText.match(/(\d+)\s*(?:件|个|只|套|箱|包)\s*起批/);
        const minOrderQuantity = pick(
          moqFromPriceRange ? `${moqFromPriceRange}件起批` : "",
          moqFromDom ? `${moqFromDom[1]}件起批` : "",
          fallback.moq,
        );
        const length = getAttr("长", "length");
        const width = getAttr("宽", "width");
        const height = getAttr("高", "height");
        const dimensionsText = length || width || height
          ? `${length || "-"} x ${width || "-"} x ${height || "-"}`
          : getAttr("尺寸", "规格尺寸", "包装尺寸", "产品尺寸");
        const weightRaw = getAttr("重量", "克重", "毛重", "净重", "weight");
        const weightGrams = parseWeight(weightRaw);
        const promotionLines = (document.body?.innerText || "").split(/\n+/)
          .map(clean)
          .filter((line) => /首单|新人|新客|优惠|券后|领券|补贴|限时|促销|折扣|coupon|discount/i.test(line) && line.length <= 220)
          .slice(0, 16);
        return {
          title: pick(raw.productTitle?.fields?.title, raw.productTitle?.title, document.querySelector("h1")?.innerText, fallback.title),
          price: prices[0] ? String(prices[0]) : fallback.price || "",
          priceDetails,
          minOrderQuantity,
          moq: minOrderQuantity,
          shippingFee: pick(getAttr("运费", "物流费用", "快递费")),
          dimensionsText,
          weightText: weightGrams ? `${weightGrams} g` : weightRaw,
          weightGrams: weightGrams || "",
          promotionText: Array.from(new Set([fallback.promotionText, ...promotionLines].filter(Boolean))).join("；"),
          detailAttributes: attrs,
        };
      },
      args: [candidate],
    });
    return injected?.[0]?.result || {};
  } catch (error) {
    return { detailError: error.message || String(error) };
  } finally {
    await closeTab(tab.id);
  }
}

async function collectOzonLinks(sourceUrl, maxProducts) {
  const tab = await chrome.tabs.create({ url: sourceUrl, active: false });
  try {
    await waitForTabComplete(tab.id, 25000);
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (limit) => {
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const normalize = (href) => {
          try {
            const url = new URL(href, location.href);
            if (!/ozon\.ru$/i.test(url.hostname.replace(/^www\./, ""))) return "";
            if (!url.pathname.includes("/product/")) return "";
            return `${url.origin}${url.pathname}`;
          } catch {
            return "";
          }
        };
        const links = new Set();
        for (let i = 0; i < 8 && links.size < limit; i += 1) {
          document.querySelectorAll('a[href*="/product/"]').forEach((node) => {
            const href = normalize(node.getAttribute("href") || node.href || "");
            if (href) links.add(href);
          });
          window.scrollBy(0, Math.max(500, Math.floor(window.innerHeight * 0.8)));
          await delay(700 + Math.floor(Math.random() * 900));
        }
        window.scrollTo(0, 0);
        await delay(400);
        return Array.from(links).slice(0, limit);
      },
      args: [maxProducts],
    });
    return injected?.[0]?.result || [];
  } finally {
    await closeTab(tab.id);
  }
}

async function scrapeOzonProduct(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabComplete(tab.id, 30000);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        for (let i = 0; i < 5; i += 1) {
          window.scrollBy(0, Math.max(450, Math.floor(window.innerHeight * 0.7)));
          await delay(500 + Math.floor(Math.random() * 700));
        }
        window.scrollTo(0, 0);
        await delay(500);
      },
    });
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const text = document.body?.innerText || "";
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const parsePrice = (value) => {
          const match = String(value || "").replace(/\s+/g, "").match(/(\d+(?:[.,]\d+)?)\s*[¥￥₽руб]/i);
          return match ? Number(match[1].replace(",", ".")) : null;
        };
        const prices = Array.from(text.matchAll(/(\d+(?:[.,]\d+)?)\s*[¥￥]/g))
          .map((match) => Number(match[1].replace(",", ".")))
          .filter((value) => Number.isFinite(value) && value > 0);
        const rubPrices = Array.from(text.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:₽|руб)/gi))
          .map((match) => Number(match[1].replace(",", ".")))
          .filter((value) => Number.isFinite(value) && value > 0)
          .map((value) => Number((value * 0.0862).toFixed(2)));
        const cnyPrices = prices.length ? prices : rubPrices;
        const priceWidgets = Array.from(document.querySelectorAll('[data-widget*="webPrice"], [data-widget*="price"], [class*="price"]'))
          .map((node) => clean(node.innerText))
          .filter(Boolean);
        const currentPriceText = priceWidgets.find((value) => /[¥￥₽]/.test(value)) || "";
        const currentBlackPriceCny = parsePrice(currentPriceText) || cnyPrices[0] || null;
        const lowPriceMatch = text.match(/(?:低价推荐|Есть дешевле|дешевле)[\s\S]{0,80}?(\d+(?:[.,]\d+)?)\s*[¥￥₽]/i);
        const lowPriceValue = lowPriceMatch ? Number(lowPriceMatch[1].replace(",", ".")) : null;
        const sellerCountMatch = text.match(/(?:低价推荐|Есть дешевле|дешевле)[\s\S]{0,120}?(\d{1,4})(?:\s*(?:个|件|предлож|seller|offer))/i);
        const weightMatch = text.match(/(?:重量|Вес|weight)[^\n]{0,50}?(\d+(?:[.,]\d+)?)\s*(кг|kg|г|g|克)/i)
          || text.match(/(\d+(?:[.,]\d+)?)\s*(кг|kg|г|g|克)(?!\s*[xх*×]\s*\d)/i);
        const normalizeWeight = (match) => {
          if (!match) return null;
          const value = Number(String(match[1]).replace(",", "."));
          const unit = String(match[2] || "").toLowerCase();
          if (!Number.isFinite(value)) return null;
          return /kg|кг/.test(unit) ? Math.round(value * 1000) : Math.round(value);
        };
        const attrs = {};
        Array.from(document.querySelectorAll("dl, table, [data-widget*='webCharacteristics']")).forEach((root) => {
          const lines = clean(root.innerText).split(/ (?=[^:：]{1,30}[:：])/).slice(0, 80);
          lines.forEach((line) => {
            const pair = line.match(/^([^:：]{1,30})[:：]\s*(.{1,120})$/);
            if (pair) attrs[clean(pair[1])] = clean(pair[2]);
          });
        });
        const images = Array.from(document.images)
          .map((img) => img.currentSrc || img.src)
          .filter((src) => /^https?:\/\//i.test(src))
          .filter((src) => /ozon|ir-/.test(src))
          .slice(0, 20);
        const ogImage = document.querySelector('meta[property="og:image"]')?.content || "";
        const title = clean(document.querySelector("h1")?.innerText || document.querySelector('meta[property="og:title"]')?.content || document.title);
        const description = clean(document.querySelector('meta[name="description"]')?.content || "");
        const finalBlackPrice = lowPriceValue && currentBlackPriceCny
          ? Math.min(lowPriceValue, currentBlackPriceCny)
          : (lowPriceValue || currentBlackPriceCny || "");
        return {
          title,
          sourceUrl: location.href,
          mainImageUrl: ogImage || images[0] || "",
          images,
          description,
          attributes: attrs,
          currentBlackPriceCny: currentBlackPriceCny || "",
          sellerLowestBlackPriceCny: lowPriceValue || "",
          finalBlackPriceCny: finalBlackPrice,
          displayPrice: currentPriceText,
          sellerOfferCount: sellerCountMatch ? Number(sellerCountMatch[1]) : "",
          ozonPriceNote: currentBlackPriceCny ? "" : "插件未稳定识别到绿标价下方黑标价",
          weightGrams: normalizeWeight(weightMatch) || "",
          weightSource: weightMatch ? "页面文本" : "",
          weightEvidence: weightMatch ? clean(weightMatch[0]) : "",
        };
      },
    });
    const data = injected?.[0]?.result || {};
    if (!data.title && !data.mainImageUrl) throw new Error("未识别到 Ozon 商品内容，可能已下架或触发验证。");
    return data;
  } finally {
    await closeTab(tab.id);
  }
}

function applyBatchFilters(result, filters = {}) {
  const reasons = [];
  const ozon = result.ozon || {};
  const price = Number(ozon.finalBlackPriceCny || ozon.currentBlackPriceCny || 0);
  const sellerCount = Number(ozon.sellerOfferCount || 0);
  const title = String(ozon.title || "").toLowerCase();
  const minPrice = Number(filters.minPriceRmb || 0);
  const maxPrice = Number(filters.maxPriceRmb || 0);
  const minSeller = Number(filters.minSellerCount || 0);
  const maxSeller = Number(filters.maxSellerCount || 0);
  const keyword = String(filters.titleKeyword || "").trim().toLowerCase();

  if (result.error) reasons.push(result.error);
  if (minPrice && (!price || price < minPrice)) reasons.push(`黑标价低于 ${minPrice}`);
  if (maxPrice && price > maxPrice) reasons.push(`黑标价高于 ${maxPrice}`);
  if (minSeller && sellerCount < minSeller) reasons.push(`跟卖数低于 ${minSeller}`);
  if (maxSeller && sellerCount > maxSeller) reasons.push(`跟卖数高于 ${maxSeller}`);
  if (keyword && !title.includes(keyword)) reasons.push(`标题不包含 ${filters.titleKeyword}`);

  result.filterReasons = reasons;
  result.passedFilters = !reasons.length;
}

async function ensure1688CookieState() {
  let state = await get1688CookieState();
  if (state.token) return state;
  await refresh1688MtopToken();
  state = await get1688CookieState();
  return state;
}

async function get1688CookieState() {
  const cookies = await chrome.cookies.getAll({ domain: "1688.com" });
  const h5Cookies = await chrome.cookies.getAll({ domain: "h5api.m.1688.com" }).catch(() => []);
  const allCookies = [...cookies, ...h5Cookies];
  const tokenCookie = allCookies.find((cookie) => cookie.name === "_m_h5_tk");
  const token = tokenCookie?.value?.split("_")[0] || "";
  return { token };
}

async function refresh1688MtopToken() {
  const dataStr = JSON.stringify({});
  const timestamp = String(Date.now());
  const url = buildMtopUrl({
    t: timestamp,
    sign: md5(`&${timestamp}&${APP_KEY}&${dataStr}`),
    type: "jsonp",
    dataType: "jsonp",
    callback: `mtopjsonp${Math.floor(1000 + Math.random() * 9000)}`,
    data: dataStr,
  });
  await fetch(url, { method: "GET", credentials: "include" }).catch(() => {});
  await sleep(800);
}

function buildMtopUrl(params) {
  const url = new URL(MTOP_URL);
  const defaults = {
    jsv: "2.7.2",
    appKey: APP_KEY,
    api: "mtop.relationrecommend.wirelessrecommend.recommend",
    v: "2.0",
    timeout: "20000",
  };
  for (const [key, value] of Object.entries({ ...defaults, ...params })) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function parseMtopText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/^[^(]*\(([\s\S]*)\)\s*;?$/);
    if (!match) throw new Error(`接口返回不是 JSON：${String(text || "").slice(0, 240)}`);
    return JSON.parse(match[1]);
  }
}

function assertMtopSuccess(json, message) {
  const ret = Array.isArray(json?.ret) ? json.ret.join("; ") : "";
  if (!ret.includes("SUCCESS")) throw new Error(`${message}：${ret || JSON.stringify(json).slice(0, 360)}`);
}

function isMtopTokenError(message) {
  return /FAIL_SYS_TOKEN|_m_h5_tk|令牌|token/i.test(String(message || ""));
}

function normalizeUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("//")) return `https:${text}`;
  if (text.startsWith("/")) return `https://www.1688.com${text}`;
  return text;
}

function merge1688CandidateDetails(candidate, details = {}) {
  const detailAttrText = Object.entries(details.detailAttributes || {}).map(([key, value]) => `${key}: ${value}`).join(" ");
  const inferred = inferPackQuantityFromText([details.title, candidate.title, detailAttrText].join(" "));
  const packQuantity = details.packQuantity || candidate.packQuantity || inferred.quantity;
  const packQuantityEvidence = details.packQuantityEvidence || candidate.packQuantityEvidence || inferred.evidence;
  return {
    ...candidate,
    ...details,
    title: details.title || candidate.title,
    price: normalize1688PriceOnly(details.priceDetails || candidate.priceDetails || details.price || candidate.price),
    minOrderQuantity: details.minOrderQuantity || candidate.minOrderQuantity || candidate.moq,
    moq: details.moq || details.minOrderQuantity || candidate.moq,
    shippingFee: details.shippingFee || candidate.shippingFee || "",
    dimensionsText: details.dimensionsText || candidate.dimensionsText || "",
    weightText: details.weightText || candidate.weightText || "",
    weightGrams: details.weightGrams || candidate.weightGrams || normalizeWeightGrams(details.weightText || candidate.weightText),
    priceDetails: details.priceDetails || candidate.priceDetails || "",
    promotionText: [candidate.promotionText, details.promotionText].filter(Boolean).join("；"),
    packQuantity,
    packQuantityEvidence,
    detailError: details.detailError || "",
  };
}

function addTrafficBaitAssessment(candidate) {
  const unitPriceRmb = extract1688MinimumTierUnitPrice(candidate.priceDetails || candidate.price);
  const values = extractRmbValues([candidate.price, candidate.priceDetails, candidate.minOrderQuantity, candidate.moq].join(" "));
  const positiveValues = values.filter((value) => value > 0).sort((a, b) => a - b);
  const minPriceRmb = positiveValues[0] ?? null;
  const maxPriceRmb = positiveValues[positiveValues.length - 1] ?? null;
  const hasVeryLowPrice = minPriceRmb !== null && minPriceRmb < LOW_PRICE_THRESHOLD_RMB;
  const hasLargeSpread = minPriceRmb !== null && maxPriceRmb !== null && maxPriceRmb >= 10 && maxPriceRmb / Math.max(minPriceRmb, 0.01) >= 10;
  const promotionRisk = PROMOTION_PATTERN.test([candidate.promotionText, candidate.price, candidate.priceDetails].join(" "));
  const reasons = [];
  if (hasVeryLowPrice) reasons.push(`出现低于 ¥${LOW_PRICE_THRESHOLD_RMB} 的价格`);
  if (hasLargeSpread) reasons.push("价格区间跨度异常大，可能是引流 SKU");
  return {
    ...candidate,
    price: unitPriceRmb !== null ? formatPriceNumber(unitPriceRmb) : normalize1688PriceOnly(candidate.price || candidate.priceDetails),
    unitPriceRmb,
    minPriceRmb,
    maxPriceRmb,
    trafficBaitRisk: hasVeryLowPrice || hasLargeSpread,
    trafficBaitReason: reasons.join("；"),
    promotionRisk,
    promotionReason: promotionRisk ? "含首单/新人/优惠券/补贴等促销信息，不作为长期采购价" : "",
    avoidForSourcing: hasVeryLowPrice || hasLargeSpread,
  };
}

function annotateCandidateQuantity(candidate, ozon) {
  const ozonQuantity = Number(ozon?.packQuantity) > 0
    ? Number(ozon.packQuantity)
    : inferPackQuantityFromText([ozon?.title, ozon?.description].join(" ")).quantity;
  const candidateQuantity = Number(candidate.packQuantity) > 0
    ? Number(candidate.packQuantity)
    : inferPackQuantityFromText([candidate.title, JSON.stringify(candidate.detailAttributes || {})].join(" ")).quantity;
  const purchaseMultiplier = Math.max(1, Math.ceil(Math.max(1, ozonQuantity) / Math.max(1, candidateQuantity)));
  const unitPrice = candidate.unitPriceRmb !== null && candidate.unitPriceRmb !== undefined
    ? Number(candidate.unitPriceRmb)
    : Number(normalize1688PriceOnly(candidate.price || candidate.priceDetails));
  return {
    ...candidate,
    ozonPackQuantity: ozonQuantity,
    candidatePackQuantity: candidateQuantity,
    purchaseMultiplier,
    unitPriceRmb: Number.isFinite(unitPrice) && unitPrice > 0 ? unitPrice : candidate.unitPriceRmb,
    estimatedPurchasePriceRmb: Number.isFinite(unitPrice) && unitPrice > 0 ? Number((unitPrice * purchaseMultiplier).toFixed(2)) : null,
    quantityAssessment: `Ozon 疑似 ${ozonQuantity} 件/组，1688 疑似 ${candidateQuantity} 件/组，采购倍数 ${purchaseMultiplier}。`,
  };
}

function normalize1688PriceOnly(value) {
  const tierPrice = extract1688MinimumTierUnitPrice(value);
  if (tierPrice !== null) return formatPriceNumber(tierPrice);
  const values = extractRmbValues(value);
  return values.length ? formatPriceNumber(values[0]) : "";
}

function extract1688MinimumTierUnitPrice(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const tiers = [];
  const pattern = /(\d+)\s*(?:件|个|只|套|箱|包)?\s*起\s*[¥￥]?\s*(\d+(?:\.\d+)?)/g;
  for (const match of text.matchAll(pattern)) {
    const quantity = Number(match[1]);
    const price = Number(match[2]);
    if (Number.isFinite(quantity) && quantity > 0 && Number.isFinite(price) && price > 0) tiers.push({ quantity, price });
  }
  if (!tiers.length) return null;
  tiers.sort((a, b) => a.quantity - b.quantity);
  return tiers[0].price;
}

function extractRmbValues(text) {
  const values = [];
  const normalized = String(text || "").replace(/,/g, "");
  for (const match of normalized.matchAll(/(?:¥|￥|RMB|CNY)?\s*(\d+(?:\.\d+)?)(?:\s*(?:元|块|rmb|cny))?/gi)) {
    const before = normalized.slice(Math.max(0, match.index - 8), match.index);
    const after = normalized.slice(match.index + match[0].length, match.index + match[0].length + 8);
    if (!/[¥￥元块]|RMB|CNY/i.test(match[0]) && /件|个|只|套|起|批|库存|cm|mm|kg|克|g/i.test(before + after)) continue;
    const number = Number(match[1]);
    if (Number.isFinite(number) && number > 0) values.push(number);
  }
  return values;
}

function formatPriceNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)));
}

function normalizeWeightGrams(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(kg|公斤|千克|g|克|mg|毫克)/i);
  if (!match) return "";
  const number = Number(match[1].replace(",", "."));
  if (!Number.isFinite(number) || number <= 0) return "";
  const unit = match[2].toLowerCase();
  if (/kg|公斤|千克/.test(unit)) return Math.round(number * 1000);
  if (/mg|毫克/.test(unit)) return Math.max(1, Math.round(number / 1000));
  return Math.round(number);
}

function inferPackQuantityFromText(text) {
  const normalized = String(text || "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return { quantity: 1, evidence: "" };
  const patterns = [
    /(\d{1,3})\s*(?:шт\.?|штук|pcs?|pieces?)\b/gi,
    /(?:set|pack|bundle)\s+of\s+(\d{1,3})/gi,
    /(\d{1,3})\s*[- ]?\s*(?:pack|pcs?|pieces?)\b/gi,
    /(\d{1,3})\s*(?:件套|件装|只装|个装|条装|片装|枚装|支装|双装|套装|入装|只\/套|件\/套)/g,
  ];
  const candidates = [];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const quantity = Number(match[1]);
      const evidence = match[0].trim();
      if (!Number.isFinite(quantity) || quantity <= 1 || quantity > 100) continue;
      if (/cm|mm|kg|公斤|千克|克|g\b|起批|库存|尺寸|长|宽|高/i.test(evidence)) continue;
      candidates.push({ quantity, evidence });
    }
  }
  candidates.sort((a, b) => b.quantity - a.quantity);
  return candidates[0] || { quantity: 1, evidence: "" };
}

function collectPromotionTextFromValue(value, snippets = [], depth = 0) {
  if (snippets.length >= 24 || depth > 5 || value == null) return Array.from(new Set(snippets)).join("；");
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).replace(/\s+/g, " ").trim();
    if (PROMOTION_PATTERN.test(text) && text.length <= 220) snippets.push(text);
    return Array.from(new Set(snippets)).join("；");
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 80)) collectPromotionTextFromValue(item, snippets, depth + 1);
    return Array.from(new Set(snippets)).join("；");
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value).slice(0, 140)) {
      if (PROMOTION_PATTERN.test(key)) snippets.push(`${key}: ${typeof child === "object" ? "" : String(child).slice(0, 120)}`.trim());
      collectPromotionTextFromValue(child, snippets, depth + 1);
    }
  }
  return Array.from(new Set(snippets)).join("；");
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function md5(input) {
  function cmn(q, a, b, x, s, t) {
    a = add32(add32(a, q), add32(x, t));
    return add32((a << s) | (a >>> (32 - s)), b);
  }
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
  function md5blk(s) {
    const blocks = [];
    for (let i = 0; i < 64; i += 4) blocks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
    return blocks;
  }
  function md51(s) {
    const utf8 = unescape(encodeURIComponent(s));
    let n = utf8.length;
    const state = [1732584193, -271733879, -1732584194, 271733878];
    let i;
    for (i = 64; i <= n; i += 64) md5cycle(state, md5blk(utf8.substring(i - 64, i)));
    const tail = Array(16).fill(0);
    const rest = utf8.substring(i - 64);
    for (i = 0; i < rest.length; i += 1) tail[i >> 2] |= rest.charCodeAt(i) << ((i % 4) << 3);
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (i > 55) {
      md5cycle(state, tail);
      tail.fill(0);
    }
    tail[14] = n * 8;
    md5cycle(state, tail);
    return state;
  }
  function rhex(n) {
    let s = "";
    for (let j = 0; j < 4; j += 1) s += ((n >> (j * 8 + 4)) & 0x0f).toString(16) + ((n >> (j * 8)) & 0x0f).toString(16);
    return s;
  }
  function add32(a, b) { return (a + b) & 0xffffffff; }
  return md51(input).map(rhex).join("");
}

async function updateProgress(jobId, phase, processed, total, state, status = "running", logs = [], results = undefined) {
  const response = await fetch(`${state.serverUrl}/api/worker/jobs/${jobId}/progress`, {
    method: "POST",
    headers: authHeaders(state),
    body: JSON.stringify({
      ...workerMeta(state, phase),
      phase,
      processed,
      total,
      status,
      logs,
      ...(Array.isArray(results) ? { results } : {}),
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) throw new Error(data.error || `更新任务进度失败：HTTP ${response.status}`);
  if (data.job?.status === "canceled") throwCanceled();
  if (data.job?.status === "paused") throwPaused();
  return data.job;
}

async function completeJob(jobId, job, state) {
  const response = await fetch(`${state.serverUrl}/api/worker/jobs/${jobId}/complete`, {
    method: "POST",
    headers: authHeaders(state),
    body: JSON.stringify({
      ...workerMeta(state, job.phase || "任务回传完成"),
      job,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) throw new Error(data.error || `回传任务失败：HTTP ${response.status}`);
  return data;
}

async function ensureJobRunnable(jobId, state) {
  const response = await fetch(`${state.serverUrl}/api/jobs/${jobId}`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${state.token}` },
  });
  const data = await response.json().catch(() => ({}));
  if (data.job?.status === "canceled") throwCanceled();
  if (data.job?.status === "paused") throwPaused();
  if (data.job?.status === "done") throwCanceled();
}

function throwCanceled() {
  const error = new Error("任务已停止");
  error.canceled = true;
  throw error;
}

function throwPaused() {
  const error = new Error("任务已暂停");
  error.paused = true;
  throw error;
}

async function reportLocalPhase(phase) {
  await chrome.storage.local.set({ currentPhase: phase }).catch(() => {});
}

async function login({ serverUrl, username, password }) {
  const normalizedServerUrl = normalizeServerUrl(serverUrl || DEFAULT_SERVER_URL);
  const cleanUsername = String(username || "").trim();
  const cleanPassword = String(password || "");
  if (!cleanUsername || !cleanPassword) throw new Error("请输入 ERP 账号和密码。");

  const response = await fetch(`${normalizedServerUrl}/api/extension/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: cleanUsername, password: cleanPassword }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success || !data.token) {
    throw new Error(data.error || `登录失败：HTTP ${response.status}`);
  }
  await chrome.storage.local.set({
    serverUrl: normalizedServerUrl,
    username: cleanUsername,
    token: data.token,
    user: data.user || null,
    workerName: defaultWorkerName(),
    running: true,
    online: false,
    lastError: "",
  });
  await start();
  return getPublicState();
}

async function logout() {
  await chrome.alarms.clear(HEARTBEAT_ALARM);
  await chrome.storage.local.remove(["token", "user", "running", "lastError", "lastSeenAt", "queue", "online"]);
  return getPublicState();
}

async function start() {
  const state = await getStoredState();
  if (!state.token) throw new Error("请先登录。");
  await chrome.storage.local.set({ running: true, workerName: state.workerName || defaultWorkerName() });
  await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_MINUTES });
  await heartbeat();
  pollJob().catch((error) => setState({ lastError: error.message || String(error) }));
  return getPublicState();
}

async function stop() {
  await chrome.alarms.clear(HEARTBEAT_ALARM);
  await chrome.storage.local.set({ running: false, online: false, enableJobClaiming: false });
  return getPublicState();
}

async function setClaiming(enabled) {
  const state = await getStoredState();
  if (enabled && !state.token) throw new Error("请先登录。");
  await chrome.storage.local.set({ enableJobClaiming: enabled, running: enabled ? true : state.running });
  if (enabled) await start();
  await heartbeat();
  return getPublicState();
}

async function heartbeat() {
  const state = await getStoredState();
  if (!state.running || !state.token) return getPublicState();
  const phase = state.enableJobClaiming
    ? "浏览器插件在线，可领取任务"
    : "浏览器插件在线，未开启领取任务";
  const response = await fetch(`${state.serverUrl}/api/worker/heartbeat`, {
    method: "POST",
    headers: authHeaders(state),
    body: JSON.stringify(workerMeta(state, phase)),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new Error(data.error || `心跳失败：HTTP ${response.status}`);
  }
  await setState({
    online: true,
    lastSeenAt: new Date().toISOString(),
    lastError: "",
    queue: data.queue || null,
  });
  return getPublicState();
}

async function getStoredState() {
  const stored = await chrome.storage.local.get([
    "serverUrl", "username", "token", "user", "workerName", "running", "online", "lastSeenAt", "lastError", "queue",
    "enableJobClaiming",
  ]);
  return {
    serverUrl: normalizeServerUrl(stored.serverUrl || DEFAULT_SERVER_URL),
    username: stored.username || "",
    token: stored.token || "",
    user: stored.user || null,
    workerName: stored.workerName || defaultWorkerName(),
    running: Boolean(stored.running),
    online: Boolean(stored.online),
    lastSeenAt: stored.lastSeenAt || "",
    lastError: stored.lastError || "",
    queue: stored.queue || null,
    enableJobClaiming: Boolean(stored.enableJobClaiming),
  };
}

async function getPublicState() {
  const state = await getStoredState();
  return {
    serverUrl: state.serverUrl,
    username: state.username,
    user: state.user,
    workerName: state.workerName,
    running: state.running,
    online: state.online,
    lastSeenAt: state.lastSeenAt,
    lastError: state.lastError,
    queue: state.queue,
    enableJobClaiming: state.enableJobClaiming,
  };
}

async function setState(patch) {
  await chrome.storage.local.set(patch);
}

function authHeaders(state) {
  return {
    "Authorization": `Bearer ${state.token}`,
    "Content-Type": "application/json",
  };
}

function workerMeta(state, currentPhase) {
  return {
    workerName: state.workerName || defaultWorkerName(),
    platform: platformLabel(),
    hostname: state.workerName || defaultWorkerName(),
    profileDir: "browser-extension",
    currentPhase,
  };
}

function normalizeUrls(input) {
  const values = Array.isArray(input) ? input : String(input || "").split(/\r?\n/);
  return values
    .map((item, index) => {
      if (typeof item === "object" && item?.url) return { url: item.url, sourceRow: item.sourceRow || index + 1 };
      const match = String(item || "").match(OZONE_LINK_RE);
      return match ? { url: match[0], sourceRow: index + 1 } : null;
    })
    .filter(Boolean);
}

function normalizeServerUrl(value) {
  let text = String(value || DEFAULT_SERVER_URL).trim();
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
  return text.replace(/\/+$/, "");
}

function defaultWorkerName() {
  const browser = navigator.userAgent.includes("Edg/") ? "Edge" : "Chrome";
  return `${browser}-extension-${chrome.runtime.id.slice(0, 6)}`;
}

function platformLabel() {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "win32";
  if (/Mac OS X/i.test(ua)) return "darwin";
  if (/Linux/i.test(ua)) return "linux";
  return "browser-extension";
}

function makeLog(message, level = "info") {
  return { at: new Date().toISOString(), level, message: String(message || "") };
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function randomDelay(minMs, maxMs) {
  const min = clampNumber(minMs, 1000, 120000, 8000);
  const max = Math.max(min, clampNumber(maxMs, 1000, 120000, 20000));
  return min + Math.floor(Math.random() * (max - min + 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(finish, timeoutMs);
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") finish();
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab?.status === "complete") finish();
    });
  });
}

async function closeTab(tabId) {
  if (!tabId) return;
  await chrome.tabs.remove(tabId).catch(() => {});
}
