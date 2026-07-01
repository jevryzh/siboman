const urlsInput = document.querySelector("#urlsInput");
const modeTabs = Array.from(document.querySelectorAll(".mode-tab"));
const singleModePanel = document.querySelector("#singleModePanel");
const batchModePanel = document.querySelector("#batchModePanel");
const batchSourceInput = document.querySelector("#batchSourceInput");
const batchMaxProductsInput = document.querySelector("#batchMaxProductsInput");
const batchMinPriceInput = document.querySelector("#batchMinPriceInput");
const batchMaxPriceInput = document.querySelector("#batchMaxPriceInput");
const batchMinSellerInput = document.querySelector("#batchMinSellerInput");
const batchMaxSellerInput = document.querySelector("#batchMaxSellerInput");
const batchKeywordInput = document.querySelector("#batchKeywordInput");
const batchDelayMinInput = document.querySelector("#batchDelayMinInput");
const batchDelayMaxInput = document.querySelector("#batchDelayMaxInput");
const batchMaxConsecutiveFailuresInput = document.querySelector("#batchMaxConsecutiveFailuresInput");
const batchHeadlessInput = document.querySelector("#batchHeadlessInput");
const maxCandidatesInput = document.querySelector("#maxCandidatesInput");
const delayMinInput = document.querySelector("#delayMinInput");
const delayMaxInput = document.querySelector("#delayMaxInput");
const startRowInput = document.querySelector("#startRowInput");
const maxConsecutiveFailuresInput = document.querySelector("#maxConsecutiveFailuresInput");
const enable1688Input = document.querySelector("#enable1688Input");
const enableAiInput = document.querySelector("#enableAiInput");
const headlessInput = document.querySelector("#headlessInput");
const runBtn = document.querySelector("#runBtn");
const batchRunBtn = document.querySelector("#batchRunBtn");
const cancelBtn = document.querySelector("#cancelBtn");
const batchCancelBtn = document.querySelector("#batchCancelBtn");
const open1688Btn = document.querySelector("#open1688Btn");
const closeBrowserBtn = document.querySelector("#closeBrowserBtn");
const clearLogBtn = document.querySelector("#clearLogBtn");
const refreshHistoryBtn = document.querySelector("#refreshHistoryBtn");
const statusText = document.querySelector("#statusText");
const progressText = document.querySelector("#progressText");
const downloadLink = document.querySelector("#downloadLink");
const resultsBody = document.querySelector("#resultsBody");
const resultCount = document.querySelector("#resultCount");
const logList = document.querySelector("#logList");
const todayRowsText = document.querySelector("#todayRowsText");
const todayJobsText = document.querySelector("#todayJobsText");
const historyFilesText = document.querySelector("#historyFilesText");
const historyList = document.querySelector("#historyList");

let currentJobId = null;
let pollTimer = null;
let activeMode = "single";
let visibleLogs = [];
let lastVerificationKey = "";
let lastStopKey = "";
let collectorMode = false;
const autoDownloadedJobs = new Set();

modeTabs.forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode || "single"));
});

open1688Btn.addEventListener("click", async () => {
  if (collectorMode) {
    appendLocalLog("服务器模式下不用在网页里打开 1688；本机采集端会在这台电脑上自动打开浏览器。");
    return;
  }
  open1688Btn.disabled = true;
  appendLocalLog("正在打开 1688 登录窗口...");
  try {
    const data = await postJson("/api/1688/open", {});
    appendLocalLog(data.message || "1688 登录窗口已打开。");
  } catch (error) {
    appendLocalLog(error.message, "error");
  } finally {
    open1688Btn.disabled = false;
  }
});

closeBrowserBtn.addEventListener("click", async () => {
  if (collectorMode) {
    appendLocalLog("服务器模式下浏览器由本机采集端管理。需要关闭时可以停止本机采集端。");
    return;
  }
  closeBrowserBtn.disabled = true;
  try {
    await postJson("/api/browser/close", {});
    appendLocalLog("浏览器已关闭。");
  } catch (error) {
    appendLocalLog(error.message, "error");
  } finally {
    closeBrowserBtn.disabled = false;
  }
});

runBtn.addEventListener("click", async () => {
  const urlsText = urlsInput.value.trim();
  if (!urlsText) {
    appendLocalLog("请先粘贴 Ozon 链接。", "warn");
    urlsInput.focus();
    return;
  }

  setRunningState(true);
  downloadLink.classList.add("hidden");
  resultsBody.innerHTML = `<tr><td colspan="4" class="empty">任务启动中...</td></tr>`;
  visibleLogs = [];
  renderLogs([]);

  try {
    const data = await postJson("/api/jobs", {
      urlsText,
      maxCandidates: Number(maxCandidatesInput.value || 5),
      delayMinMs: Math.round(Number(delayMinInput.value || 8) * 1000),
      delayMaxMs: Math.round(Number(delayMaxInput.value || 20) * 1000),
      startRow: Number(startRowInput.value || 1),
      maxConsecutiveFailures: Number(maxConsecutiveFailuresInput.value || 3),
      enable1688: enable1688Input.checked,
      enableAI: enableAiInput.checked,
      headless: headlessInput.checked,
    });
    currentJobId = data.jobId;
    appendLocalLog(data.queued ? `任务已进入队列，等待本机采集端领取：${currentJobId}` : `任务已创建：${currentJobId}`);
    startPolling();
  } catch (error) {
    appendLocalLog(error.message, "error");
    setRunningState(false);
  }
});

batchRunBtn.addEventListener("click", async () => {
  const sourceUrl = batchSourceInput.value.trim();
  if (!sourceUrl) {
    appendLocalLog("请先粘贴 Ozon 店铺链接或商品链接。", "warn");
    batchSourceInput.focus();
    return;
  }

  setRunningState(true);
  downloadLink.classList.add("hidden");
  resultsBody.innerHTML = `<tr><td colspan="4" class="empty">任务启动中...</td></tr>`;
  visibleLogs = [];
  renderLogs([]);

  try {
    const data = await postJson("/api/batch-ozon/jobs", {
      sourceUrl,
      maxProducts: Number(batchMaxProductsInput.value || 50),
      delayMinMs: Math.round(Number(batchDelayMinInput.value || 8) * 1000),
      delayMaxMs: Math.round(Number(batchDelayMaxInput.value || 20) * 1000),
      maxConsecutiveFailures: Number(batchMaxConsecutiveFailuresInput.value || 3),
      headless: batchHeadlessInput.checked,
      filters: {
        minPriceRmb: batchMinPriceInput.value,
        maxPriceRmb: batchMaxPriceInput.value,
        minSellerCount: batchMinSellerInput.value,
        maxSellerCount: batchMaxSellerInput.value,
        titleKeyword: batchKeywordInput.value,
      },
    });
    currentJobId = data.jobId;
    appendLocalLog(data.queued ? `批量采集任务已进入队列，等待本机采集端领取：${currentJobId}` : `批量采集任务已创建：${currentJobId}`);
    startPolling();
  } catch (error) {
    appendLocalLog(error.message, "error");
    setRunningState(false);
  }
});

cancelBtn.addEventListener("click", cancelCurrentJob);
batchCancelBtn.addEventListener("click", cancelCurrentJob);

async function cancelCurrentJob() {
  if (!currentJobId) return;
  setCancelDisabled(true);
  try {
    await postJson(`/api/jobs/${currentJobId}/cancel`, {});
  } catch (error) {
    appendLocalLog(error.message, "error");
  }
}

clearLogBtn.addEventListener("click", () => {
  visibleLogs = [];
  renderLogs([]);
});

refreshHistoryBtn.addEventListener("click", fetchHistory);

downloadLink.addEventListener("click", () => {
  setTimeout(fetchHistory, 1200);
});

historyList.addEventListener("click", (event) => {
  if (event.target.closest("a")) setTimeout(fetchHistory, 1200);
});

initRuntimeMode();
fetchHistory();

async function initRuntimeMode() {
  try {
    const data = await fetchJson("/api/auth/status");
    collectorMode = Boolean(data.collectorMode);
    if (collectorMode) {
      open1688Btn.textContent = "本机采集端已接管";
      closeBrowserBtn.textContent = "本机采集端管理中";
      open1688Btn.classList.add("quiet");
      closeBrowserBtn.classList.add("quiet");
      appendLocalLog("服务器队列模式已开启：任务会由本机采集端领取执行。");
    }
  } catch {
    // 登录状态异常会由 fetchJson 统一跳转。
  }
}

function setMode(mode) {
  activeMode = mode === "batch" ? "batch" : "single";
  modeTabs.forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === activeMode);
  });
  singleModePanel.classList.toggle("hidden", activeMode !== "single");
  batchModePanel.classList.toggle("hidden", activeMode !== "batch");
}

function setRunningState(isRunning) {
  runBtn.disabled = isRunning;
  batchRunBtn.disabled = isRunning;
  setCancelDisabled(!isRunning);
}

function setCancelDisabled(disabled) {
  cancelBtn.disabled = disabled;
  batchCancelBtn.disabled = disabled;
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(fetchCurrentJob, 1200);
  fetchCurrentJob();
}

async function fetchCurrentJob() {
  if (!currentJobId) return;
  try {
    const data = await fetchJson(`/api/jobs/${currentJobId}`);
    renderJob(data.job);
    if (data.job.status === "queued" && /本机采集端/.test(data.job.phase || "")) {
      setRunningState(false);
    }
    if (["done", "error", "canceled"].includes(data.job.status)) {
      clearInterval(pollTimer);
      setRunningState(false);
      fetchHistory();
    }
  } catch (error) {
    appendLocalLog(error.message, "error");
  }
}

function renderJob(job) {
  statusText.textContent = `${statusLabel(job.status)} · ${job.phase || ""}`;
  progressText.textContent = `${job.processed || 0} / ${job.total || 0}`;
  resultCount.textContent = `${job.results?.length || 0} 条`;
  maybeShowVerificationPopup(job);
  maybeShowStopPopup(job);
  maybeAutoDownload(job);

  if (job.downloadUrl && job.results?.length) {
    downloadLink.href = job.downloadUrl;
    downloadLink.classList.remove("hidden");
  } else {
    downloadLink.classList.add("hidden");
  }

  renderResults(job.results || []);
  renderLogs(job.logs || []);
}

function maybeAutoDownload(job) {
  if (job.status !== "done" || !job.downloadUrl || !job.results?.length) return;
  if (autoDownloadedJobs.has(job.id)) return;
  autoDownloadedJobs.add(job.id);
  appendLocalLog("任务完成，正在自动下载 Excel。");
  triggerDownload(job.downloadUrl);
  setTimeout(fetchHistory, 1500);
}

function triggerDownload(url) {
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function fetchHistory() {
  try {
    const data = await fetchJson("/api/history");
    renderHistory(data);
  } catch (error) {
    historyList.innerHTML = `<div class="empty compact">${escapeHtml(error.message)}</div>`;
  }
}

function renderHistory(data) {
  const today = data.today || {};
  const items = data.items || [];
  todayRowsText.textContent = `${today.rows || 0} 条`;
  todayJobsText.textContent = `${today.jobs || 0} 批`;
  historyFilesText.textContent = `${items.length} 份`;

  if (!items.length) {
    historyList.innerHTML = `<div class="empty compact">还没有历史 Excel</div>`;
    return;
  }

  historyList.innerHTML = items.slice(0, 30).map((item) => {
    const range = item.firstRow && item.lastRow ? `第 ${item.firstRow}-${item.lastRow} 行` : `${item.resultCount || 0} 条`;
    const status = statusLabel(item.status);
    const kind = item.kind === "batch-ozon" ? "批量采集" : "找货";
    const size = formatBytes(item.excelBytes);
    const time = formatTime(item.updatedAt);
    const downloaded = item.lastDownloadedAt ? ` · 上次下载 ${formatTime(item.lastDownloadedAt)}` : "";
    const derived = item.derived ? " · 合并/导出" : "";
    return `<div class="history-item">
      <div>
        <strong>${escapeHtml(range)}</strong>
        <span>${escapeHtml(`${kind} · ${status} · ${item.resultCount || 0} 条 · ${size} · ${time}${downloaded}${derived}`)}</span>
      </div>
      <a class="button secondary small" href="${escapeAttr(item.downloadUrl)}">打开 Excel</a>
    </div>`;
  }).join("");
}

function maybeShowStopPopup(job) {
  if (job.status !== "error") return;
  const key = `${job.id}:${job.updatedAt}:${job.error || job.phase}`;
  if (key === lastStopKey) return;
  lastStopKey = key;

  const message = `任务已自动停止\n\n${job.error || job.phase || "发生异常，需要检查后再继续。"}`;
  appendLocalLog(message, "error");
  if ("Notification" in window) {
    if (Notification.permission === "granted") {
      new Notification("采集任务已停止", { body: message });
    } else if (Notification.permission === "default") {
      Notification.requestPermission().then((permission) => {
        if (permission === "granted") new Notification("采集任务已停止", { body: message });
      });
    }
  }
  setTimeout(() => alert(message), 50);
}

function maybeShowVerificationPopup(job) {
  const verification = job.verification;
  if (!verification?.active) return;
  const key = `${job.id}:${verification.at}:${verification.label}`;
  if (key === lastVerificationKey) return;
  lastVerificationKey = key;

  const message = verification.headless
    ? `检测到验证码：${verification.label}\n\n当前是后台浏览器模式，看不到验证码窗口。\n请停止任务，取消“后台浏览器模式”，打开 1688 登录窗口处理验证后再继续。\n\n页面：${verification.url || ""}`
    : `检测到验证码：${verification.label}\n\n请在弹出的自动化浏览器里完成滑块/验证码，完成后程序会自动继续。\n\n页面：${verification.url || ""}`;

  appendLocalLog(message, "warn");
  if ("Notification" in window) {
    if (Notification.permission === "granted") {
      new Notification("采集任务需要验证码", { body: message });
    } else if (Notification.permission === "default") {
      Notification.requestPermission().then((permission) => {
        if (permission === "granted") new Notification("采集任务需要验证码", { body: message });
      });
    }
  }
  setTimeout(() => alert(message), 50);
}

function renderResults(results) {
  if (!results.length) {
    resultsBody.innerHTML = `<tr><td colspan="4" class="empty">还没有结果</td></tr>`;
    return;
  }

  resultsBody.innerHTML = results
    .map((result) => {
      if (result.batchOzon) return renderBatchOzonRow(result);
      const ozon = result.ozon || {};
      const candidates = result.candidates || [];
      const aiReview = result.aiReview || {};
      const candidateHtml = candidates.length
        ? `<div class="candidate-list">${candidates
            .slice(0, 5)
            .map(
              (item) => {
                const meta = [
                  item.price || item.priceDetails ? `价格 ${formatPriceOnly(item.priceDetails || item.price)}` : "",
                  item.minOrderQuantity || item.moq ? `起批 ${item.minOrderQuantity || item.moq}` : "",
                  item.shippingFee ? `运费 ${item.shippingFee}` : "",
                  item.dimensionsText ? `尺寸 ${item.dimensionsText}` : "",
                  item.weightText ? `重量 ${item.weightText}` : "",
                  item.trafficBaitRisk ? `疑似引流款 ${item.trafficBaitReason || ""}` : "",
                  item.promotionRisk ? `疑似优惠价 ${item.promotionReason || ""}` : "",
                  item.estimatedPurchasePriceRmb ? `按件数估算 ¥${item.estimatedPurchasePriceRmb}` : "",
                  item.quantityAssessment || "",
                  item.aiVerdict ? `AI ${aiVerdictLabel(item.aiVerdict)}` : "",
                  item.shopName || "",
                ].filter(Boolean);
                return `<div>
                <a href="${escapeAttr(item.link)}" target="_blank" rel="noreferrer">${escapeHtml(item.rank)}. ${escapeHtml(
                  item.title || "未命名候选",
                )}</a>
                <div class="candidate-meta">${escapeHtml(meta.join(" · "))}</div>
                ${
                  item.aiReason
                    ? `<div class="candidate-ai">${escapeHtml(item.aiReason)}</div>`
                    : ""
                }
                ${
                  item.detailError
                    ? `<div class="candidate-warning">${escapeHtml(`详情采集失败：${item.detailError}`)}</div>`
                    : ""
                }
              </div>`;
              },
            )
            .join("")}</div>`
        : `<span class="muted">${escapeHtml(result.searchError || "无候选")}</span>`;

      const usage = aiReview.aiUsage
        ? ` · ${aiReview.aiUsage.totalTokens || 0} tokens · $${Number(aiReview.aiUsage.estimatedCostUsd || 0).toFixed(6)}`
        : "";
      const status = result.error
        ? `<span class="muted">${escapeHtml(result.error)}</span>`
        : aiReview.decision === "exact"
          ? `AI 选中完全一致候选 ${escapeHtml(aiReview.selected_rank)}${escapeHtml(usage)}`
          : aiReview.decision === "approximate"
            ? `<span class="muted">AI 返回近似候选 ${escapeHtml(aiReview.selected_rank)}：${escapeHtml(aiReview.reason || "需要人工确认")}${escapeHtml(usage)}</span>`
            : aiReview.decision === "none"
              ? `<span class="muted">AI 未找到完全一致，已在导出中给出近似项供人工确认${escapeHtml(usage)}</span>`
        : result.searchError
          ? `<span class="muted">${escapeHtml(result.searchError)}</span>`
          : candidates.length
            ? `找到 ${candidates.length} 个候选`
            : "已采集";

      return `<tr>
        <td>
          <a class="product-title" href="${escapeAttr(result.url)}" target="_blank" rel="noreferrer">${escapeHtml(
            ozon.title || result.url,
          )}</a>
          <div class="muted">${escapeHtml([
            ozon.price ? `价格 ${ozon.price}` : "",
            ozon.currentBlackPriceCny ? `黑标 ${ozon.currentBlackPriceCny}` : "",
            ozon.sellerLowestBlackPriceCny ? `跟卖最低 ${ozon.sellerLowestBlackPriceCny}` : "",
            ozon.sellerOfferCount ? `跟卖数 ${ozon.sellerOfferCount}` : "",
            ozon.weightText ? `重量 ${ozon.weightText}` : "",
            ozon.currency,
            ozon.brand,
          ].filter(Boolean).join(" · "))}</div>
        </td>
        <td>${ozon.mainImage?.publicUrl ? `<img src="${escapeAttr(ozon.mainImage.publicUrl)}" alt="">` : ""}</td>
        <td>${candidateHtml}</td>
        <td>${status}</td>
      </tr>`;
    })
    .join("");
}

function renderBatchOzonRow(result) {
  const ozon = result.ozon || {};
  const reasons = (result.filterReasons || []).filter(Boolean);
  const filterLabel = result.error ? "采集失败" : result.passedFilters ? "通过筛选" : "未通过筛选";
  const filterClass = result.error || !result.passedFilters ? "candidate-warning" : "candidate-ai";
  const priceMeta = [
    ozon.currentBlackPriceCny ? `当前黑标 ${ozon.currentBlackPriceCny}` : "",
    ozon.sellerLowestBlackPriceCny ? `低价推荐 ${ozon.sellerLowestBlackPriceCny}` : "",
    ozon.sellerOfferCount !== "" && ozon.sellerOfferCount !== undefined ? `跟卖数 ${ozon.sellerOfferCount}` : "",
    ozon.weightText ? `重量 ${ozon.weightText}` : "",
  ].filter(Boolean);

  return `<tr>
    <td>
      <a class="product-title" href="${escapeAttr(result.url)}" target="_blank" rel="noreferrer">${escapeHtml(
        ozon.title || result.url,
      )}</a>
      <div class="muted">${escapeHtml(priceMeta.join(" · "))}</div>
    </td>
    <td>${ozon.mainImage?.publicUrl ? `<img src="${escapeAttr(ozon.mainImage.publicUrl)}" alt="">` : ""}</td>
    <td>
      <div class="${filterClass}">${escapeHtml(filterLabel)}</div>
      ${reasons.length ? `<div class="candidate-meta">${escapeHtml(reasons.join("；"))}</div>` : ""}
    </td>
    <td>${escapeHtml(result.error || "已采集")}</td>
  </tr>`;
}

function renderLogs(logs) {
  visibleLogs = logs.length ? logs : visibleLogs;
  logList.innerHTML = visibleLogs
    .map((item) => {
      const time = item.at ? new Date(item.at).toLocaleTimeString() : "";
      return `<div class="log-item ${escapeAttr(item.level || "info")}">
        <span class="log-time">${escapeHtml(time)}</span>
        ${escapeHtml(item.message || "")}
      </div>`;
    })
    .join("");
  logList.scrollTop = logList.scrollHeight;
}

function appendLocalLog(message, level = "info") {
  visibleLogs.push({ at: new Date().toISOString(), level, message });
  renderLogs([]);
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (response.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error("请先登录。");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) throw new Error(data.error || `请求失败：${response.status}`);
  return data;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (response.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error("请先登录。");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) throw new Error(data.error || `请求失败：${response.status}`);
  return data;
}

function statusLabel(status) {
  return {
    queued: "排队中",
    claimed: "已领取",
    running: "运行中",
    done: "完成",
    error: "失败",
    canceled: "已停止",
  }[status] || status || "待开始";
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "0 B";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function aiVerdictLabel(verdict) {
  return {
    exact: "完全一致",
    approximate: "近似",
    not_match: "不一致",
  }[verdict] || verdict;
}

function formatPriceOnly(value) {
  const tierPrice = extractMinimumTierUnitPrice(value);
  if (tierPrice !== null) return formatNumber(tierPrice);
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const values = [];
  for (const match of text.matchAll(/(?:¥|￥)?\s*(\d+(?:\.\d+)?)(?:\s*(?:元|RMB|CNY))?/gi)) {
    const before = text.slice(Math.max(0, match.index - 8), match.index);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 8);
    if (!/[¥￥元]|RMB|CNY/i.test(match[0]) && /件|个|只|套|起|批|库存|cm|mm|kg|克|g/i.test(before + after)) continue;
    const number = Number(match[1]);
    if (Number.isFinite(number) && number > 0) values.push(number);
  }
  if (!values.length) return text;
  return formatNumber(values[0]);
}

function extractMinimumTierUnitPrice(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const tiers = [];
  for (const match of text.matchAll(/(\d+)\s*(?:件|个|只|套|箱|包)?\s*起\s*[¥￥]?\s*(\d+(?:\.\d+)?)/g)) {
    const quantity = Number(match[1]);
    const price = Number(match[2]);
    if (Number.isFinite(quantity) && quantity > 0 && Number.isFinite(price) && price > 0) {
      tiers.push({ quantity, price });
    }
  }
  if (!tiers.length) return null;
  tiers.sort((a, b) => a.quantity - b.quantity);
  return tiers[0].price;
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}
