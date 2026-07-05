const DEFAULT_SERVER_URL = "http://xm.renwz.cn";
const HEARTBEAT_ALARM = "ozon1688CollectorHeartbeat";
const HEARTBEAT_MINUTES = 1;
const OZONE_LINK_RE = /https?:\/\/(?:www\.)?ozon\.ru\/product\/[^\s]+/i;

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
  const logs = [makeLog("插件已领取任务。")];
  const kind = job.kind === "batch-ozon" ? "batch-ozon" : "run";
  const payload = job.payload || {};
  const options = payload.options || {};
  let results = [];
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

      for (let index = 0; index < productUrls.length; index += 1) {
        const url = productUrls[index];
        const sourceRow = index + 1;
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

      for (let index = 0; index < urlRows.length; index += 1) {
        const row = typeof urlRows[index] === "string" ? { url: urlRows[index], sourceRow: index + 1 } : urlRows[index];
        const sourceRow = row.sourceRow || index + 1;
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
      result.searchError = "浏览器插件版已完成 Ozon 采集；真实 1688 以图搜货仍在接入中，未返回模拟候选。";
    }
  } catch (error) {
    result.error = error.message || String(error);
  }
  return result;
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

async function updateProgress(jobId, phase, processed, total, state, status = "running", logs = [], results = undefined) {
  await fetch(`${state.serverUrl}/api/worker/jobs/${jobId}/progress`, {
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
