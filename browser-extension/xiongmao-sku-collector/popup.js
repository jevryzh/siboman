const collectBtn = document.getElementById("collectBtn");
const copyCsvBtn = document.getElementById("copyCsvBtn");
const downloadCsvBtn = document.getElementById("downloadCsvBtn");
const downloadJsonBtn = document.getElementById("downloadJsonBtn");
const autoScrollInput = document.getElementById("autoScroll");
const scanHorizontalInput = document.getElementById("scanHorizontal");
const statusEl = document.getElementById("status");
const countBadge = document.getElementById("countBadge");
const columnBadge = document.getElementById("columnBadge");
const previewText = document.getElementById("previewText");
const pageHint = document.getElementById("pageHint");

let latestResult = null;

init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) {
    try {
      const url = new URL(tab.url);
      pageHint.textContent = url.hostname || "当前页面数据";
    } catch {
      pageHint.textContent = "当前页面数据";
    }
  }

  const stored = await chrome.storage.local.get("latestResult");
  if (stored.latestResult?.rows?.length) {
    latestResult = stored.latestResult;
    renderResult(latestResult, "已载入上次采集结果。", "good");
  }
}

collectBtn.addEventListener("click", collectCurrentPage);
copyCsvBtn.addEventListener("click", copyCsv);
downloadCsvBtn.addEventListener("click", () => downloadText("csv"));
downloadJsonBtn.addEventListener("click", () => downloadText("json"));

async function collectCurrentPage() {
  setBusy(true);
  setStatus("正在读取页面表格...", "");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("没有找到当前浏览器标签页。");

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content-script.js"]
    });

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (options) => globalThis.xiongmaoSkuCollector.collect(options),
      args: [
        {
          autoScroll: autoScrollInput.checked,
          scanHorizontal: scanHorizontalInput.checked
        }
      ]
    });

    if (!result || !Array.isArray(result.rows)) {
      throw new Error("页面没有返回可用数据。");
    }

    latestResult = result;
    chrome.storage.local.set({ latestResult }).catch(() => {});

    const message = result.rows.length
      ? `采集完成：${result.rows.length} 条，${result.columns.length} 列。`
      : "没有找到包含 SKU/商品编号 的表格行，可以先确认列表已经加载出来。";
    renderResult(result, message, result.rows.length ? "good" : "warn");
  } catch (error) {
    setStatus(error?.message || "采集失败，请刷新页面后再试。", "bad");
  } finally {
    setBusy(false);
  }
}

async function copyCsv() {
  if (!latestResult) return;
  const csv = toCsv(latestResult.columns, latestResult.rows);

  try {
    await navigator.clipboard.writeText(csv);
    setStatus(`已复制 ${latestResult.rows.length} 条 CSV 数据。`, "good");
  } catch {
    setStatus("复制失败，可以先下载 CSV 文件。", "bad");
  }
}

function downloadText(type) {
  if (!latestResult) return;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const text = type === "json"
    ? JSON.stringify(latestResult, null, 2)
    : toCsv(latestResult.columns, latestResult.rows);
  const mime = type === "json" ? "application/json" : "text/csv";
  const filename = `ozon-sku-${timestamp}.${type}`;
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));

  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
}

function renderResult(result, message, tone) {
  const rowCount = result.rows.length;
  const columnCount = result.columns.length;

  countBadge.textContent = `${rowCount} 条`;
  columnBadge.textContent = `${columnCount} 列`;
  copyCsvBtn.disabled = !rowCount;
  downloadCsvBtn.disabled = !rowCount;
  downloadJsonBtn.disabled = !rowCount;
  previewText.textContent = rowCount ? buildPreview(result) : "还没有采集到数据";
  setStatus(message, tone);
}

function buildPreview(result) {
  const rows = result.rows.slice(0, 3);
  const preferred = ["SKU", "商品编号", "商品名称", "品牌", "类目", "所属类目", "机会判断", "月销量", "月销售额", "均价"];
  const columns = preferred.filter((column) => result.columns.includes(column));
  const fallbackColumns = result.columns.filter((column) => !columns.includes(column)).slice(0, 6);
  const previewColumns = [...columns, ...fallbackColumns].slice(0, 8);

  return rows
    .map((row, index) => {
      const parts = previewColumns.map((column) => `${column}: ${row[column] || ""}`);
      return `${index + 1}. ${parts.join(" | ")}`;
    })
    .join("\n\n");
}

function toCsv(columns, rows) {
  const bom = "\ufeff";
  const lines = [
    columns.map(csvCell).join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column] ?? "")).join(","))
  ];
  return bom + lines.join("\n");
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function setBusy(isBusy) {
  collectBtn.disabled = isBusy;
  collectBtn.textContent = isBusy ? "采集中..." : "采集当前页";
}

function setStatus(message, tone) {
  statusEl.textContent = message;
  statusEl.className = ["status", tone].filter(Boolean).join(" ");
}
