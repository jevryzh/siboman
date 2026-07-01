const collectBtn = document.getElementById("collectBtn");
const copyCsvBtn = document.getElementById("copyCsvBtn");
const downloadCsvBtn = document.getElementById("downloadCsvBtn");
const downloadXlsxBtn = document.getElementById("downloadXlsxBtn");
const downloadZipBtn = document.getElementById("downloadZipBtn");
const downloadJsonBtn = document.getElementById("downloadJsonBtn");
const downloadHtmlBtn = document.getElementById("downloadHtmlBtn");
const copyTencentBtn = document.getElementById("copyTencentBtn");
const copyDiagnosticBtn = document.getElementById("copyDiagnosticBtn");
const versionBadge = document.getElementById("versionBadge");
const autoScrollInput = document.getElementById("autoScroll");
const scanHorizontalInput = document.getElementById("scanHorizontal");
const imageFormulaInput = document.getElementById("imageFormula");
const includeShopInput = document.getElementById("includeShop");

// 记住勾选状态
includeShopInput?.addEventListener("change", () => {
  chrome.storage.local.set({ includeShop: includeShopInput.checked });
});
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
  // 恢复"店铺"列勾选状态
  try {
    const stored = await chrome.storage.local.get("includeShop");
    if (includeShopInput && typeof stored.includeShop === "boolean") {
      includeShopInput.checked = stored.includeShop;
    }
  } catch (e) {
    // ignore
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
downloadXlsxBtn.addEventListener("click", downloadXlsx);
downloadZipBtn.addEventListener("click", downloadZip);
downloadJsonBtn.addEventListener("click", () => downloadText("json"));
downloadHtmlBtn.addEventListener("click", () => downloadHtml());
copyTencentBtn.addEventListener("click", copyTencent);
copyDiagnosticBtn.addEventListener("click", copyDiagnostic);

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

// 把采集到的所有原始数据复制到剪贴板（诊断用：含数量/货号/商品名称/原始文本等）
async function copyDiagnostic() {
  if (!latestResult) return;

  // 输出尽量原始的字段，方便排查
  const diagnosticRows = latestResult.rows.map((row, i) => ({
    序号: i + 1,
    货件编号: row["货件编号"] || "",
    数量: row["数量"] || "",
    货号: row["货号"] || "",
    商品名称: row["商品名称"] || "",
    备注: row["备注"] || "",
    价格: row["价格"] || "",
    仓库: row["仓库"] || ""
  }));
  const payload = {
    version: chrome.runtime.getManifest().version,
    timestamp: new Date().toISOString(),
    rowCount: diagnosticRows.length,
    rows: diagnosticRows
  };
  const text = JSON.stringify(payload, null, 2);

  try {
    await navigator.clipboard.writeText(text);
    setStatus(`诊断数据已复制（${diagnosticRows.length} 条）。直接粘贴给我即可。`, "good");
  } catch {
    setStatus("复制失败。试试用'下载 JSON'。", "bad");
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
  setStatus("正在下载并压缩图片到剪贴板...", "");

  try {
    const blobMap = await fetchImagesAsBlobs(latestResult.rows);
    const imageRows = Object.keys(blobMap);
    const imageMap = await buildClipboardImageMap(blobMap);
    const embeddedCount = Object.values(imageMap).filter(Boolean).length;
    const failedCount = Math.max(0, imageRows.length - embeddedCount);

    const html = buildClipboardHtml(latestResult.columns, latestResult.rows, imageMap, { preferDataImages: true });
    const csvText = toCsv(latestResult.columns, latestResult.rows, { imageFormula: false });

    if (navigator.clipboard && window.ClipboardItem) {
      const item = new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([csvText], { type: "text/plain" })
      });
      await navigator.clipboard.write([item]);
      setStatus(
        embeddedCount
          ? `已写入剪贴板：${embeddedCount} 张图已内嵌为小图${failedCount ? `，${failedCount} 张失败保留链接` : ""}。到腾讯文档直接 Ctrl+V。`
          : "已写入剪贴板，但没有图片成功内嵌；腾讯文档若仍不显示，请用'下载 Excel（内嵌图）'导入。",
        failedCount ? "warn" : "good"
      );
    } else {
      await navigator.clipboard.writeText(csvText);
      setStatus("当前浏览器不支持 HTML 剪贴板，已回退到 CSV。", "warn");
    }
  } catch (error) {
    setStatus("写入剪贴板失败：" + (error?.message || error) + "。请用'下载 Excel（内嵌图）'。", "bad");
  } finally {
    setBusy(false);
  }
}

// 上传所有图片到公共匿名图床，返回 { index: "https://..." }
// 主用 0x0.st（无 CORS、无需 key），失败回退 catbox.moe
async function uploadImagesBatch(blobMap) {
  const result = {};
  const entries = Object.entries(blobMap);
  // 并发上传 3 个（避免被限流）
  const CONCURRENCY = 3;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, entries.length) }, async () => {
    while (cursor < entries.length) {
      const idx = cursor++;
      const [i, b] = entries[idx];
      try {
        const url = await uploadToPublicHost(b.blob, b.filename);
        result[i] = url;
      } catch (e) {
        console.warn("[xiongmao] 图片上传失败", b?.filename, e);
        result[i] = null;
      }
    }
  });
  await Promise.all(workers);
  return result;
}

// 上传单个 blob 到公共图床，按顺序尝试多个服务
async function uploadToPublicHost(blob, filename) {
  if (!blob) throw new Error("blob 为空");
  const hosts = [
    {
      name: "0x0.st",
      upload: async (b) => {
        const fd = new FormData();
        fd.append("file", b, filename || "image.jpg");
        const res = await fetch("https://0x0.st", { method: "POST", body: fd });
        if (!res.ok) throw new Error(`0x0.st HTTP ${res.status}`);
        return (await res.text()).trim();
      }
    },
    {
      name: "catbox.moe",
      upload: async (b) => {
        const fd = new FormData();
        fd.append("reqtype", "fileupload");
        fd.append("fileToUpload", b, filename || "image.jpg");
        const res = await fetch("https://catbox.moe/user/api.php", { method: "POST", body: fd });
        if (!res.ok) throw new Error(`catbox.moe HTTP ${res.status}`);
        return (await res.text()).trim();
      }
    },
    {
      name: "tmpfiles.org",
      upload: async (b) => {
        const fd = new FormData();
        fd.append("file", b, filename || "image.jpg");
        const res = await fetch("https://tmpfiles.org/api/v1/upload", { method: "POST", body: fd });
        if (!res.ok) throw new Error(`tmpfiles.org HTTP ${res.status}`);
        const json = await res.json();
        if (!json?.data?.url) throw new Error("tmpfiles.org 返回格式异常");
        return String(json.data.url).replace("https://tmpfiles.org/", "https://tmpfiles.org/dl/");
      }
    }
  ];
  let lastError = null;
  for (const host of hosts) {
    try {
      const url = await host.upload(blob);
      if (url && /^https?:\/\//i.test(url)) {
        console.log(`[xiongmao] 上传 ${filename} → ${host.name}: ${url}`);
        return url;
      }
    } catch (e) {
      console.warn(`[xiongmao] ${host.name} 失败:`, e?.message || e);
      lastError = e;
    }
  }
  throw lastError || new Error("所有图床都失败了");
}

async function buildClipboardImageMap(blobMap) {
  const imageMap = {};
  for (const [index, item] of Object.entries(blobMap)) {
    if (!item?.blob) continue;
    try {
      imageMap[index] = await blobToCompressedDataUrl(item.blob, {
        maxSize: 96,
        mimeType: "image/jpeg",
        quality: 0.72
      });
    } catch (error) {
      console.warn("[xiongmao] 剪贴板图片压缩失败", item.filename, error);
    }
  }
  return imageMap;
}

// 构造可直接粘贴到腾讯文档的 HTML 表格。v1.4.13 默认使用 data:image 小图，避开腾讯文档抓取外链失败。
function buildClipboardHtml(columns, rows, imageMap = {}, options = {}) {
  const safeColumns = columns.map(escapeHtml);
  const headerRow = safeColumns.map((c) => `<th style="border:1px solid #dbe2ec;padding:6px 8px;background:#eaf2ff;color:#165cbe;">${c}</th>`).join("");

  const bodyRows = rows
    .map((row, index) => {
      const cells = columns.map((column) => {
        let value = row[column];
        if ((column === "商品图片" || column === "照片") && value) {
          const src = imageMap[index] || value;
          const original = imageMap[index] ? value : "";
          const fallbackText = options.preferDataImages && !imageMap[index] ? `<div style="font-size:11px;color:#647084;max-width:90px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(value)}</div>` : "";
          return `<td style="border:1px solid #dbe2ec;padding:6px 8px;width:92px;height:80px;text-align:center;vertical-align:middle;"><img src="${escapeAttr(src)}"${original ? ` data-original-src="${escapeAttr(original)}"` : ""} width="72" height="72" style="display:block;width:72px;height:72px;object-fit:contain;margin:auto;">${fallbackText}</td>`;
        }
        if (Array.isArray(value)) value = value.join("<br>");
        return `<td style="border:1px solid #dbe2ec;padding:6px 8px;">${escapeHtml(value ?? "")}</td>`;
      }).join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  return `<table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;">${headerRow ? `<thead><tr>${headerRow}</tr></thead>` : ""}<tbody>${bodyRows}</tbody></table>`;
}

async function downloadXlsx() {
  if (!latestResult) return;

  setBusy(true);
  setStatus("正在下载图片并生成 Excel...", "");

  try {
    const imageBlobs = await fetchImagesAsBlobs(latestResult.rows);
    const imageWanted = latestResult.rows.filter((row) => row["商品图片"] || row["照片"]).length;
    const successCount = Object.values(imageBlobs).filter((b) => b?.blob).length;
    const failedCount = Math.max(0, imageWanted - successCount);
    const xlsxBlob = await buildXlsx(latestResult.columns, latestResult.rows, imageBlobs);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `xiongmao-orders-${timestamp}.xlsx`;
    const url = URL.createObjectURL(xlsxBlob);
    chrome.downloads.download({ url, filename, saveAs: true }, () => {
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    });

    setStatus(
      `Excel 已下载：${latestResult.rows.length} 条，内嵌 ${successCount} 张图${failedCount ? `，${failedCount} 张下载失败保留链接` : ""}。`,
      failedCount && failedCount > successCount / 2 ? "warn" : "good"
    );
  } catch (error) {
    setStatus("生成 Excel 失败：" + (error?.message || error), "bad");
  } finally {
    setBusy(false);
  }
}

// 下载 ZIP（含 CSV + images/ 文件夹），适合归档；CSV 本身不能内嵌图片。
async function downloadZip() {
  if (!latestResult) return;

  setBusy(true);
  setStatus("正在下载图片并打包 ZIP...", "");

  try {
    // 1. 下载所有图为 blob
    const imageBlobs = await fetchImagesAsBlobs(latestResult.rows);
    const successCount = Object.values(imageBlobs).filter((b) => b?.blob).length;
    const failedCount = Object.values(imageBlobs).filter((b) => !b?.blob).length;

    // 2. 构造 CSV：商品图片列用相对路径 images/xxx.jpg
    const rowsWithPaths = latestResult.rows.map((row, i) => {
      const r = { ...row };
      if (imageBlobs[i]?.blob) {
        r["商品图片"] = `images/${imageBlobs[i].filename}`;
      }
      return r;
    });
    const csvText = "\uFEFF" + toCsv(latestResult.columns, rowsWithPaths, { imageFormula: false });

    // 3. 构造 ZIP（stored 模式，简单实现）
    const files = [
      { name: "orders.csv", data: new TextEncoder().encode(csvText) },
      { name: "README.txt", data: new TextEncoder().encode(buildZipReadme(rowsWithPaths.length, successCount, failedCount)) }
    ];
    for (const [i, b] of Object.entries(imageBlobs)) {
      if (b?.blob && b?.filename) {
        files.push({ name: `images/${b.filename}`, data: new Uint8Array(await b.blob.arrayBuffer()) });
      }
    }
    const zipBlob = await buildZip(files);

    // 4. 触发下载
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `xiongmao-orders-${timestamp}.zip`;
    const url = URL.createObjectURL(zipBlob);
    chrome.downloads.download({ url, filename, saveAs: true }, () => {
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    });

    setStatus(
      `ZIP 已下载：${rowsWithPaths.length} 条订单 + ${successCount} 张图${failedCount ? `（${failedCount} 张失败）` : ""}。解压后 orders.csv + images/ 同目录，双击 CSV 图会显示。`,
      failedCount && failedCount > successCount / 2 ? "warn" : "good"
    );
  } catch (error) {
    setStatus("打包 ZIP 失败：" + (error?.message || error), "bad");
  } finally {
    setBusy(false);
  }
}

function buildZipReadme(rowCount, imageOk, imageFail) {
  return [
    "熊猫 Ozon 数据采集器 - 导出包",
    "",
    "目录结构：",
    "  orders.csv     订单数据，商品图片列用相对路径 images/xxx.jpg",
    "  images/        商品图片文件夹",
    "",
    `共 ${rowCount} 条订单，${imageOk} 张图，${imageFail ? `${imageFail} 张下载失败` : "全部下载成功"}`,
    "",
    "使用方式：",
    "  1. 整个文件夹（不要只拷 CSV）发给同事",
    "  2. CSV 本身不能内嵌图片，商品图片列是本地图片路径",
    "  3. 要直接打开就看到图片，请使用插件里的“下载 Excel（内嵌图）”",
    "",
    "优势：",
    "  - 不依赖 Ozon 登录态，同事电脑无需登录",
    "  - 不依赖 URL 有效期，图永久可用",
    "  - 图保存在本地，适合归档或手动上传"
  ].join("\n");
}

// 下载每张图，返回 { index: { blob, filename, ext } }
async function fetchImagesAsBlobs(rows) {
  const map = {};
  const seen = new Map();
  let counter = 0;
  for (let i = 0; i < rows.length; i++) {
    const url = rows[i]["商品图片"] || rows[i]["照片"];
    if (!url) continue;
    if (!/^https?:/i.test(url)) continue; // 跳过非 http URL
    try {
      const blob = await fetchImageWithTimeout(url, 10000);
      if (!blob) continue;
      // 去重：相同 URL 复用
      let ext = (blob.type || "").includes("png") ? "png" :
                (blob.type || "").includes("webp") ? "webp" :
                (blob.type || "").includes("gif") ? "gif" : "jpg";
      let filename;
      if (seen.has(url)) {
        filename = seen.get(url);
      } else {
        counter++;
        const orderNo = String(rows[i]["Ozon/Etsy 订单号"] || rows[i]["货件编号"] || i).replace(/[^\w-]/g, "_").slice(0, 40);
        filename = `${String(counter).padStart(3, "0")}_${orderNo}.${ext}`;
        seen.set(url, filename);
      }
      map[i] = { blob, filename, ext };
    } catch (e) {
      // 单张失败不阻断
      console.warn("[xiongmao] 图片下载失败", url, e);
    }
  }
  return map;
}

async function fetchImageWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImageOnce(url, {
      credentials: "omit",
      signal: controller.signal,
      cache: "force-cache"
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchImageOnce(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) return null;
  const blob = await res.blob();
  if (!blob || !blob.size) return null;
  if (blob.type && !/^image\//i.test(blob.type)) return null;
  return blob;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function blobToCompressedDataUrl(blob, options = {}) {
  const maxSize = options.maxSize || 96;
  const mimeType = options.mimeType || "image/jpeg";
  const quality = options.quality ?? 0.72;

  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const outBlob = await new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality));
  if (!outBlob) return blobToDataUrl(blob);
  return blobToDataUrl(outBlob);
}

async function buildXlsx(columns, rows, imageBlobs = {}) {
  const imageColumnIndex = columns.findIndex((column) => column === "商品图片" || column === "照片");
  const preparedImages = [];

  if (imageColumnIndex >= 0) {
    for (const [rowIndexText, item] of Object.entries(imageBlobs)) {
      const rowIndex = Number(rowIndexText);
      if (!item?.blob || Number.isNaN(rowIndex)) continue;

      const normalized = await normalizeImageForXlsx(item.blob);
      if (!normalized?.blob) continue;
      preparedImages.push({
        rowIndex,
        columnIndex: imageColumnIndex,
        filename: `image${preparedImages.length + 1}.${normalized.ext}`,
        contentType: normalized.contentType,
        data: new Uint8Array(await normalized.blob.arrayBuffer())
      });
    }
  }

  const files = [
    { name: "[Content_Types].xml", data: textBytes(buildXlsxContentTypes(preparedImages)) },
    { name: "_rels/.rels", data: textBytes(buildRootRels()) },
    { name: "docProps/app.xml", data: textBytes(buildAppXml()) },
    { name: "docProps/core.xml", data: textBytes(buildCoreXml()) },
    { name: "xl/workbook.xml", data: textBytes(buildWorkbookXml()) },
    { name: "xl/_rels/workbook.xml.rels", data: textBytes(buildWorkbookRels()) },
    { name: "xl/worksheets/sheet1.xml", data: textBytes(buildWorksheetXml(columns, rows, imageColumnIndex, preparedImages.length > 0)) }
  ];

  if (preparedImages.length > 0) {
    files.push(
      { name: "xl/worksheets/_rels/sheet1.xml.rels", data: textBytes(buildSheetRels()) },
      { name: "xl/drawings/drawing1.xml", data: textBytes(buildDrawingXml(preparedImages)) },
      { name: "xl/drawings/_rels/drawing1.xml.rels", data: textBytes(buildDrawingRels(preparedImages)) }
    );
    for (const image of preparedImages) {
      files.push({ name: `xl/media/${image.filename}`, data: image.data });
    }
  }

  return buildZip(files, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

async function normalizeImageForXlsx(blob) {
  const type = String(blob.type || "").toLowerCase();
  if (type.includes("png")) return { blob, ext: "png", contentType: "image/png" };
  if (type.includes("jpeg") || type.includes("jpg")) return { blob, ext: "jpg", contentType: "image/jpeg" };

  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png", 0.92));
    if (pngBlob) return { blob: pngBlob, ext: "png", contentType: "image/png" };
  } catch (error) {
    console.warn("[xiongmao] 图片转 PNG 失败，尝试原格式写入", error);
  }

  if (type.includes("gif")) return { blob, ext: "gif", contentType: "image/gif" };
  return null;
}

function buildWorksheetXml(columns, rows, imageColumnIndex, hasDrawing) {
  const colXml = columns
    .map((column, index) => {
      const width = index === imageColumnIndex ? 14 : Math.min(42, Math.max(10, String(column || "").length + 6));
      return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
    })
    .join("");

  const header = buildXlsxRow(1, columns, -1, true);
  const body = rows
    .map((row, rowIndex) => {
      const values = columns.map((column, columnIndex) => {
        const value = row[column] ?? "";
        if (columnIndex === imageColumnIndex && value) return String(value);
        return Array.isArray(value) ? value.join("\n") : String(value);
      });
      return buildXlsxRow(rowIndex + 2, values, imageColumnIndex, false);
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <cols>${colXml}</cols>
  <sheetData>${header}${body}</sheetData>
  ${hasDrawing ? '<drawing r:id="rId1"/>' : ""}
</worksheet>`;
}

function buildXlsxRow(rowNumber, values, imageColumnIndex, isHeader) {
  const height = !isHeader && imageColumnIndex >= 0 ? ' ht="68" customHeight="1"' : "";
  const cells = values
    .map((value, index) => {
      const ref = `${columnName(index + 1)}${rowNumber}`;
      const text = String(value ?? "");
      if (!text) return `<c r="${ref}"/>`;
      return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(text)}</t></is></c>`;
    })
    .join("");
  return `<row r="${rowNumber}"${height}>${cells}</row>`;
}

function buildDrawingXml(images) {
  const anchors = images.map((image, index) => {
    const col = image.columnIndex;
    const row = image.rowIndex + 1; // xlsx drawing uses zero-based rows; +1 skips header
    const rid = `rId${index + 1}`;
    const id = index + 1;
    return `<xdr:twoCellAnchor editAs="oneCell">
  <xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>57150</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>57150</xdr:rowOff></xdr:from>
  <xdr:to><xdr:col>${col + 1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row + 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
  <xdr:pic>
    <xdr:nvPicPr><xdr:cNvPr id="${id}" name="Picture ${id}"/><xdr:cNvPicPr/></xdr:nvPicPr>
    <xdr:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
    <xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
  </xdr:pic>
  <xdr:clientData/>
</xdr:twoCellAnchor>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${anchors}
</xdr:wsDr>`;
}

function buildDrawingRels(images) {
  const rels = images.map((image, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${escapeXml(image.filename)}"/>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
}

function buildSheetRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`;
}

function buildXlsxContentTypes(images) {
  const defaults = new Map([
    ["rels", "application/vnd.openxmlformats-package.relationships+xml"],
    ["xml", "application/xml"]
  ]);
  images.forEach((image) => defaults.set(image.filename.split(".").pop(), image.contentType));
  const defaultXml = [...defaults.entries()]
    .map(([ext, type]) => `<Default Extension="${escapeXml(ext)}" ContentType="${escapeXml(type)}"/>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  ${defaultXml}
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  ${images.length ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : ""}
</Types>`;
}

function buildRootRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function buildWorkbookXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Orders" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}

function buildWorkbookRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;
}

function buildAppXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>熊猫 Ozon 数据采集器</Application></Properties>`;
}

function buildCoreXml() {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>熊猫 Ozon 数据采集器</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function textBytes(text) {
  return new TextEncoder().encode(text);
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function columnName(index) {
  let name = "";
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

// 最小 ZIP writer（stored 模式，不压缩），约 80 行，支持任意文件
async function buildZip(files, mimeType = "application/zip") {
  const encoder = new TextEncoder();
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const dataBytes = file.data;
    const crc = crc32(dataBytes);

    // Local file header
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);  // signature
    local.setUint16(4, 20, true);           // version needed
    local.setUint16(6, 0, true);            // flags
    local.setUint16(8, 0, true);            // compression = stored
    local.setUint16(10, 0, true);           // mod time
    local.setUint16(12, 0, true);           // mod date
    local.setUint32(14, crc, true);         // CRC32
    local.setUint32(18, dataBytes.length, true);  // compressed size
    local.setUint32(22, dataBytes.length, true);  // uncompressed size
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);           // extra length
    const localHeader = new Uint8Array(local.buffer);
    localChunks.push(localHeader, nameBytes, dataBytes);

    // Central directory header
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);  // signature
    central.setUint16(4, 20, true);            // version made by
    central.setUint16(6, 20, true);            // version needed
    central.setUint16(8, 0, true);             // flags
    central.setUint16(10, 0, true);            // compression
    central.setUint16(12, 0, true);            // mod time
    central.setUint16(14, 0, true);            // mod date
    central.setUint32(16, crc, true);
    central.setUint32(20, dataBytes.length, true);
    central.setUint32(24, dataBytes.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, 0, true);            // extra length
    central.setUint16(32, 0, true);            // comment length
    central.setUint16(34, 0, true);            // disk number
    central.setUint16(36, 0, true);            // internal attrs
    central.setUint32(38, 0, true);            // external attrs
    central.setUint32(42, offset, true);       // local header offset
    const centralHeader = new Uint8Array(central.buffer);
    centralChunks.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + dataBytes.length;
  }

  // End of central directory
  const totalLocal = localChunks.reduce((s, c) => s + c.length, 0);
  const totalCentral = centralChunks.reduce((s, c) => s + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);          // disk number
  eocd.setUint16(6, 0, true);          // start disk
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, totalCentral, true);
  eocd.setUint32(16, offset, true);
  eocd.setUint16(20, 0, true);         // comment length
  const eocdBytes = new Uint8Array(eocd.buffer);

  return new Blob([...localChunks, ...centralChunks, eocdBytes], { type: mimeType });
}

// CRC32 查找表
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
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
          const blob = await fetchImageWithTimeout(url, 12000);
          if (!blob) throw new Error("图片下载失败");
          const dataUrl = await blobToDataUrl(blob);
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
  downloadXlsxBtn.disabled = !rowCount;
  downloadZipBtn.disabled = !rowCount;
  downloadJsonBtn.disabled = !rowCount;
  downloadHtmlBtn.disabled = !rowCount;
  copyTencentBtn.disabled = !rowCount;
  copyDiagnosticBtn.disabled = !rowCount;
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
  "店铺",            // C-可配置（默认勾掉就不出现）
  "Ozon/Etsy 订单号", // D
  "商品名称",         // E
  "商品图片",         // F
  "下单时间",         // G
  "仓库发运时间",     // H
  "截止发运时间",     // I
  "状态",             // J
  "采购平台",         // K
  "采购下单时间",     // L
  "采购单号",         // M
  "国内快递单号",     // N
  "国外快递平台",     // O
  "物流平台",         // P
  "物流单号",         // Q
  "",                // R 占位
  "",                // S 占位
  "",                // T 占位
  "",                // U 占位
  "",                // V 占位
  "",                // W 占位
  "净收入（元）"      // X
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

  const transformedRows = result.rows.map((row, index) => transformOrderRow(row, index));
  // 可配置列："店铺"列（默认不输出，勾选后才出现）
  const includeShop = includeShopInput?.checked ?? false;
  let columns = ORDER_OUTPUT_COLUMNS.slice();
  if (!includeShop) {
    columns = columns.filter((c) => c !== "店铺");
    transformedRows.forEach((row) => {
      delete row["店铺"];
    });
  }
  return {
    ...result,
    columns,
    rows: transformedRows
  };
}

function transformOrderRow(row, index) {
  const 接收时间 = formatChineseDate(row["已接收"]);
  const 发运时间 = formatChineseDate(row["发送日期"]);
  const 截止时间 = addDaysToChineseDate(row["发送日期"], 7);

  return {
    "序号": String(index + 1),
    "平台": "Ozon",
    "店铺": "",  // 默认空，由 transformForOutput 根据勾选决定是否保留
    "Ozon/Etsy 订单号": row["货件编号"] || "",
    "商品名称": row["货号"] || "",
    "商品图片": row["照片"] || "",
    "下单时间": 接收时间,
    "仓库发运时间": 发运时间,
    "截止发运时间": 截止时间,
    "状态": "",
    "采购平台": "",
    "采购下单时间": "",
    "采购单号": "",
    "国内快递单号": "",
    "国外快递平台": "",
    "物流平台": "CEL",
    "物流单号": row["货件编号"] || "",
    "净收入（元）": extractPriceNumber(row["价格"])
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

// "28 Jun" / "4 Jul" → "6月28日" / "7月4日"
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
  return `${month}月${day}日`;
}

// 在 date + N 天（跨月自动处理）；解析失败返回原值
function addDaysToChineseDate(value, days) {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = text.match(/(\d{1,2})\s+([A-Za-z]{3,})/);
  if (!match) return "";
  const day = parseInt(match[1], 10);
  const monthKey = match[2].slice(0, 3);
  const monthKeyCap = monthKey[0].toUpperCase() + monthKey.slice(1, 3).toLowerCase();
  const month = EN_MONTH_INDEX[monthKeyCap];
  if (!month) return text;
  const date = new Date(2026, month - 1, day + days);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
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
