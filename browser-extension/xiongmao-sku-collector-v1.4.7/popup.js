const collectBtn = document.getElementById("collectBtn");
const copyCsvBtn = document.getElementById("copyCsvBtn");
const downloadCsvBtn = document.getElementById("downloadCsvBtn");
const downloadJsonBtn = document.getElementById("downloadJsonBtn");
const downloadHtmlBtn = document.getElementById("downloadHtmlBtn");
const copyTencentBtn = document.getElementById("copyTencentBtn");
const versionBadge = document.getElementById("versionBadge");
const autoScrollInput = document.getElementById("autoScroll");
const scanHorizontalInput = document.getElementById("scanHorizontal");
const imageFormulaInput = document.getElementById("imageFormula");
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
  try {
    const version = chrome.runtime.getManifest().version;
    if (versionBadge) versionBadge.textContent = `v${version}`;
  } catch (e) {
    // ignore
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
downloadHtmlBtn.addEventListener("click", () => downloadHtml());
copyTencentBtn.addEventListener("click", copyTencent);

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

    const transformed = transformForOutput(result);
    latestResult = transformed;
    chrome.storage.local.set({ latestResult }).catch(() => {});

    const message = transformed.rows.length
      ? `采集完成：${transformed.rows.length} 条，${transformed.columns.length} 列。`
      : "没有找到表格数据，可以先确认列表已经加载出来。";
    renderResult(transformed, message, transformed.rows.length ? "good" : "warn");
  } catch (error) {
    setStatus(error?.message || "采集失败，请刷新页面后再试。", "bad");
  } finally {
    setBusy(false);
  }
}

async function copyCsv() {
  if (!latestResult) return;
  const csv = toCsv(latestResult.columns, latestResult.rows, { imageFormula: imageFormulaInput.checked });

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
    : toCsv(latestResult.columns, latestResult.rows, { imageFormula: imageFormulaInput.checked });
  const mime = type === "json" ? "application/json" : "text/csv";
  const filename = `xiongmao-collector-${timestamp}.${type}`;
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));

  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
}

async function copyTencent() {
  if (!latestResult) return;

  setBusy(true);
  setStatus("正在下载图片并写入剪贴板...", "");

  try {
    const imageMap = await fetchImagesAsBase64(latestResult.rows);
    const embeddedCount = Object.values(imageMap).filter((v) => v && v.startsWith("data:")).length;
    const fallbackCount = Object.values(imageMap).filter((v) => v && !v.startsWith("data:")).length;

    const html = buildClipboardHtml(latestResult.columns, latestResult.rows, imageMap);
    const csvText = toCsv(latestResult.columns, latestResult.rows, { imageFormula: false });

    if (navigator.clipboard && window.ClipboardItem) {
      const item = new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([csvText], { type: "text/plain" })
      });
      await navigator.clipboard.write([item]);
      setStatus(
        `已写入剪贴板（${embeddedCount} 张图内嵌${fallbackCount ? `，${fallbackCount} 张 fallback` : ""}）。到腾讯文档/微信表格直接 Ctrl+V 粘贴即可。`,
        "good"
      );
    } else {
      await navigator.clipboard.writeText(csvText);
      setStatus("当前浏览器不支持剪贴板图片写入，已回退到 CSV。", "warn");
    }
  } catch (error) {
    setStatus("写入剪贴板失败：" + (error?.message || error) + "。试试'下载 HTML'方案。", "bad");
  } finally {
    setBusy(false);
  }
}

// 构造可直接粘贴到腾讯文档的 HTML 表格（含 base64 图片）
function buildClipboardHtml(columns, rows, imageMap = {}) {
  const safeColumns = columns.map(escapeHtml);
  const headerRow = safeColumns.map((c) => `<th style="border:1px solid #dbe2ec;padding:6px 8px;background:#eaf2ff;color:#165cbe;">${c}</th>`).join("");

  const bodyRows = rows
    .map((row, index) => {
      const cells = columns.map((column) => {
        let value = row[column];
        if ((column === "商品图片" || column === "照片") && value) {
          const src = imageMap[index] || value;
          return `<td style="border:1px solid #dbe2ec;padding:6px 8px;"><img src="${escapeAttr(src)}" width="80" style="display:block;"></td>`;
        }
        if (Array.isArray(value)) value = value.join("<br>");
        return `<td style="border:1px solid #dbe2ec;padding:6px 8px;">${escapeHtml(value ?? "")}</td>`;
      }).join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  return `<table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;">${headerRow ? `<thead><tr>${headerRow}</tr></thead>` : ""}<tbody>${bodyRows}</tbody></table>`;
}

async function downloadHtml() {
  if (!latestResult) return;

  setStatus("正在下载并嵌入图片，请稍候...", "");
  setBusy(true);

  try {
    const imageMap = await fetchImagesAsBase64(latestResult.rows);
    const successCount = Object.values(imageMap).filter((v) => v && v.startsWith("data:")).length;
    const fallbackCount = Object.values(imageMap).filter((v) => v && !v.startsWith("data:")).length;

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const html = toHtml(latestResult.columns, latestResult.rows, latestResult.sourceUrl, imageMap);
    const filename = `xiongmao-orders-${timestamp}.html`;
    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));

    chrome.downloads.download({ url, filename, saveAs: true }, () => {
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    });

    setStatus(`HTML 已下载。成功内嵌 ${successCount} 张图${fallbackCount ? `，${fallbackCount} 张用 URL 兜底` : ""}。可在浏览器打开后复制表格粘贴到腾讯文档。`, "good");
  } catch (error) {
    setStatus(error?.message || "下载 HTML 失败。", "bad");
  } finally {
    setBusy(false);
  }
}

// 下载每张图片并转 base64（data: URL），用于 HTML 内嵌，便于腾讯文档粘贴保留图片
async function fetchImagesAsBase64(rows) {
  const map = {};
  const uniqueUrls = new Map();
  const tasks = [];

  for (let i = 0; i < rows.length; i += 1) {
    const url = rows[i]["商品图片"] || rows[i]["照片"] || "";
    if (!url) {
      map[i] = "";
      continue;
    }
    if (url.startsWith("data:")) {
      map[i] = url;
      continue;
    }
    if (!uniqueUrls.has(url)) {
      uniqueUrls.set(url, []);
      tasks.push((async () => {
        try {
          const response = await fetch(url, { credentials: "omit", mode: "cors" });
          if (!response.ok) throw new Error("HTTP " + response.status);
          const blob = await response.blob();
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          uniqueUrls.set(url, dataUrl);
        } catch (e) {
          uniqueUrls.set(url, null);
        }
      })());
    }
  }

  await Promise.all(tasks);

  for (let i = 0; i < rows.length; i += 1) {
    const url = rows[i]["商品图片"] || rows[i]["照片"] || "";
    if (!url) continue;
    if (url.startsWith("data:")) continue;
    const result = uniqueUrls.get(url);
    map[i] = result === undefined ? url : (result || url);
  }

  return map;
}

function renderResult(result, message, tone) {
  const rowCount = result.rows.length;
  const columnCount = result.columns.length;

  countBadge.textContent = `${rowCount} 条`;
  columnBadge.textContent = `${columnCount} 列`;
  copyCsvBtn.disabled = !rowCount;
  downloadCsvBtn.disabled = !rowCount;
  downloadJsonBtn.disabled = !rowCount;
  downloadHtmlBtn.disabled = !rowCount;
  copyTencentBtn.disabled = !rowCount;
  previewText.textContent = rowCount ? buildPreview(result) : "还没有采集到数据";
  setStatus(message, tone);
}

function buildPreview(result) {
  const rows = result.rows.slice(0, 3);
  const isOrderSheet = result.columns.includes("Ozon/Etsy 订单号") || rows.some((row) => row["Ozon/Etsy 订单号"] || row["货件编号"]);
  const preferred = isOrderSheet
    ? ["序号", "Ozon/Etsy 订单号", "商品名称", "下单时间", "仓库发运时间", "截止发运时间", "净收入（元）", "物流平台", "物流单号"]
    : ["SKU", "商品编号", "商品名称", "品牌", "类目", "所属类目", "机会判断", "月销量", "月销售额", "均价"];
  const columns = preferred.filter((column) => result.columns.includes(column));
  const fallbackColumns = result.columns.filter((column) => !columns.includes(column)).slice(0, 6);
  const previewColumns = [...columns, ...fallbackColumns].slice(0, 9);

  return rows
    .map((row, index) => {
      const parts = previewColumns.map((column) => {
        const value = row[column] || "";
        const display = column === "商品图片" && value ? "[图片]" : value;
        return `${column}: ${display}`;
      });
      return `${index + 1}. ${parts.join(" | ")}`;
    })
    .join("\n\n");
}

// ============ 输出转换：把采集到的原始字段映射成图2 的 16 列 ============

const ORDER_OUTPUT_COLUMNS = [
  "序号",            // A
  "平台",            // B
  "Ozon/Etsy 订单号", // C
  "商品名称",         // D
  "商品图片",         // E
  "下单时间",         // F
  "仓库发运时间",     // G
  "截止发运时间",     // H
  "状态",             // I
  "采购平台",         // J
  "采购下单时间",     // K
  "采购单号",         // L
  "国内快递单号",     // M
  "国外快递平台",     // N
  "物流平台",         // O
  "物流单号",         // P
  "",                // Q 占位
  "",                // R 占位
  "",                // S 占位
  "",                // T 占位
  "",                // U 占位
  "",                // V 占位
  "净收入（元）"      // W
  ,
  "数量",
  "货号",
  "Ozon商品名称",
  "Ozon状态",
  "Ozon仓库",
  "Ozon价格"
];

const EN_MONTH_INDEX = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12
};

function isOrderSheet(rows) {
  return rows.some((row) => row["货件编号"]);
}

function transformForOutput(result) {
  if (!result || !Array.isArray(result.rows) || !result.rows.length) {
    return { ...result, columns: result.columns || [], rows: result.rows || [] };
  }
  if (!isOrderSheet(result.rows)) return result;

  const rawRows = result.rows.map((row) => ({ ...row }));
  const transformedRows = result.rows.map((row, index) => transformOrderRow(row, index));
  return {
    ...result,
    rawRows,
    columns: ORDER_OUTPUT_COLUMNS.slice(),
    rows: transformedRows
  };
}

function transformOrderRow(row, index) {
  const 接收时间 = formatChineseDate(row["已接收"]);
  const 截止时间 = formatChineseDate(row["发送日期"]);
  const 展示商品名 = [row["货号"], row["商品名称"]].filter(Boolean).join("\n");
  const 物流平台 = extractLogisticsPlatform(row["配送服务"] || row["仓库"]) || "CEL";

  return {
    "序号": String(index + 1),
    "平台": "Ozon",
    "Ozon/Etsy 订单号": row["货件编号"] || "",
    "商品名称": 展示商品名 || row["商品名称"] || row["货号"] || "",
    "商品图片": row["照片"] || "",
    "下单时间": 接收时间,
    "仓库发运时间": "",
    "截止发运时间": 截止时间,
    "状态": row["状态"] || "",
    "采购平台": "",
    "采购下单时间": "",
    "采购单号": "",
    "国内快递单号": "",
    "国外快递平台": "",
    "物流平台": 物流平台,
    "物流单号": row["货件编号"] || "",
    "净收入（元）": extractPriceNumber(row["价格"]),
    "数量": row["数量"] || "",
    "货号": row["货号"] || "",
    "Ozon商品名称": row["商品名称"] || "",
    "Ozon状态": row["状态"] || "",
    "Ozon仓库": row["仓库"] || "",
    "Ozon价格": row["价格"] || ""
  };
}

// "89,00 ₽" / "89.00 ₽" / "￥89.00" → "89"（去货币符号 + 去小数）
function extractPriceNumber(value) {
  const text = String(value || "");
  // 匹配第一个数字（含俄式逗号小数）
  const match = text.match(/(\d+(?:[.,]\d+)?)/);
  if (!match) return "";
  return match[1].split(/[.,]/)[0];
}

// "28 Jun 22:00" / "4 Jul 至07:00" → "6月28日 22:00" / "7月4日 07:00"
function formatChineseDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = text.match(/(\d{1,2})\s+([A-Za-z]{3,})/);
  if (!match) return text;
  const day = parseInt(match[1], 10);
  const monthKey = match[2].slice(0, 3);
  const monthKeyCap = monthKey[0].toUpperCase() + monthKey.slice(1, 3).toLowerCase();
  const month = EN_MONTH_INDEX[monthKeyCap];
  if (!month) return text;
  const timeMatch = text.match(/(?:至|~|-|—|–)?\s*(\d{1,2}[:.：]\d{2})(?!.*\d{1,2}[:.：]\d{2})/);
  const time = timeMatch ? ` ${timeMatch[1].replace(/[.：]/g, ":")}` : "";
  return `${month}月${day}日${time}`;
}

function extractLogisticsPlatform(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = text.match(/^[A-Za-z]+/);
  return match ? match[0].toUpperCase() : "";
}

function toCsv(columns, rows, options = {}) {
  const bom = "\ufeff";
  const useImageFormula = options.imageFormula !== false;
  const lines = [
    columns.map((c) => csvCell(c)).join(","),
    ...rows.map((row) =>
      columns.map((column) => csvCell(formatCellValue(row[column], column, useImageFormula))).join(",")
    )
  ];
  return bom + lines.join("\n");
}

function formatCellValue(value, column, useImageFormula) {
  if (value == null) return "";
  if ((column === "照片" || column === "商品图片") && typeof value === "string" && value.length > 0) {
    if (useImageFormula) {
      // WPS / Excel 365 / 2021+ 直接渲染图
      return `=IMAGE("${value.replace(/"/g, '""')}")`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.join("\n");
  return value;
}

function toHtml(columns, rows, sourceUrl = "", imageMap = {}) {
  const isOrderSheet = columns.includes("Ozon/Etsy 订单号") || rows.some((row) => row["Ozon/Etsy 订单号"] || row["货件编号"]);
  const safeColumns = columns.map(escapeHtml);
  const headerRow = safeColumns.map((c) => `<th>${c}</th>`).join("");

  const bodyRows = rows
    .map((row, index) => {
      const cells = columns.map((column) => {
        let value = row[column];
        if ((column === "商品图片" || column === "照片") && value) {
          const src = imageMap[index] || value;
          return `<td><img class="photo" src="${escapeAttr(src)}" alt="photo"></td>`;
        }
        if (Array.isArray(value)) value = value.join("<br>");
        return `<td>${escapeHtml(value ?? "")}</td>`;
      }).join("");
      return `<tr${index % 2 ? ' class="odd"' : ""}>${cells}</tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>熊猫 Ozon 数据采集器 - 导出</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; padding: 16px; color: #1c2434; background: #f5f7fb; }
  h1 { margin: 0 0 4px; font-size: 18px; }
  .meta { color: #647084; font-size: 12px; margin-bottom: 12px; }
  table { border-collapse: collapse; width: 100%; background: #fff; }
  th, td { border: 1px solid #dbe2ec; padding: 8px 10px; text-align: left; vertical-align: top; font-size: 13px; white-space: nowrap; }
  th { background: #eaf2ff; color: #165cbe; position: sticky; top: 0; }
  tr.odd td { background: #f8fafd; }
  img.photo { width: 60px; height: 60px; object-fit: cover; border-radius: 4px; border: 1px solid #dbe2ec; background: #fff; }
  .scroll { overflow-x: auto; max-width: 100%; }
</style>
</head>
<body>
<h1>熊猫 Ozon 数据采集器 - ${isOrderSheet ? "仓库订单（图2格式）" : "选品数据"}</h1>
<p class="meta">来源: <a href="${escapeAttr(sourceUrl)}">${escapeHtml(sourceUrl)}</a> · 共 ${rows.length} 条 · 导出时间 ${new Date().toLocaleString()}</p>
<p class="meta">使用方法：用浏览器打开此 HTML，<strong>选中表格复制</strong>，到腾讯文档粘贴即可，图片会一起带上。</p>
<div class="scroll">
<table>
<thead><tr>${headerRow}</tr></thead>
<tbody>
${bodyRows}
</tbody>
</table>
</div>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
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
