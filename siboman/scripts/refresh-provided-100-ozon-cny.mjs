import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import {
  registerRuntimeJob,
  scrapeOzonProduct,
  unregisterRuntimeJob,
  writeJobArtifacts,
} from "../server.js";

const ROOT = "/Users/eason/Documents/OZON";
const JOBS_DIR = path.join(ROOT, "data", "jobs");
const DOWNLOADS_DIR = "/Users/eason/Downloads";
const SOURCE_ID = process.env.SOURCE_ID || "combined-provided-100-2026-06-30-2026-06-30T09-01-55-895Z";
const OUTPUT_ID = process.env.OUTPUT_ID || `fixed-provided-100-ozon-cny-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const OUTPUT_DIR = path.join(JOBS_DIR, OUTPUT_ID);
const REFRESH_PROFILE_DIR = path.join(ROOT, "data", "ozon-refresh-profile");
const OUTPUT_FILE = process.env.OUTPUT_FILE || "ozon-1688-merged-provided-100-2026-06-30-fixed.xlsx";
const START_ROW = Number(process.env.START_ROW || 1);
const END_ROW = Number(process.env.END_ROW || 100);
const LIMIT = Number(process.env.LIMIT || 0);
const ONLY_ROWS = new Set(String(process.env.ROWS || "")
  .split(/[,\s]+/)
  .map((value) => Number(value))
  .filter((value) => Number.isFinite(value) && value > 0));
const HEADLESS = process.env.HEADLESS === "1" || process.env.HEADLESS === "true";
const ROW_DELAY_MIN_MS = Number(process.env.ROW_DELAY_MIN_MS || 1800);
const ROW_DELAY_MAX_MS = Number(process.env.ROW_DELAY_MAX_MS || 5200);
const STOP_ON_WINDOW_CLOSE = process.env.STOP_ON_WINDOW_CLOSE !== "0";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function nowIso() {
  return new Date().toISOString();
}

function pushLog(job, message, level = "info") {
  const entry = { at: nowIso(), level, message };
  job.logs.push(entry);
  job.updatedAt = entry.at;
  console.log(`[${entry.at}] [${level}] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

function stripVolatileOzonFields(ozon = {}) {
  const copy = { ...ozon };
  delete copy.buffer;
  return copy;
}

function firstFilled(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function mergeRefreshedOzon(original = {}, fresh = {}) {
  const merged = {
    ...stripVolatileOzonFields(original),
    ...stripVolatileOzonFields(fresh),
  };

  if (!fresh.mainImage?.filePath && original.mainImage?.filePath) {
    merged.mainImage = original.mainImage;
  }
  if (!firstFilled(fresh.mainImageUrl) && firstFilled(original.mainImageUrl)) {
    merged.mainImageUrl = original.mainImageUrl;
  }

  for (const key of [
    "currentGreenPriceCny",
    "currentGreenPriceCnyValue",
    "currentGreenPriceContext",
    "productBlackPriceCny",
    "productBlackPriceCnyValue",
    "productBlackPriceContext",
    "currentBlackPriceCny",
    "currentBlackPriceCnyValue",
    "currentBlackPriceContext",
    "sellerLowestBlackPriceCny",
    "sellerLowestBlackPriceCnyValue",
    "sellerOfferCount",
    "weightText",
    "weightGrams",
    "weightSource",
    "weightEvidence",
    "packQuantity",
    "packQuantityEvidence",
  ]) {
    merged[key] = firstFilled(fresh[key], original[key]) ?? "";
  }

  return merged;
}

function isWindowClosedError(error) {
  return /target page.*closed|target context.*closed|target browser.*closed|browser has been closed|page.*closed|context.*closed|验证窗口已关闭|页面已关闭/i.test(String(error?.message || error || ""));
}

const sourcePath = path.join(JOBS_DIR, SOURCE_ID, "results.json");
if (!existsSync(sourcePath)) {
  throw new Error(`找不到源结果：${sourcePath}`);
}

const sourceJob = JSON.parse(await fs.readFile(sourcePath, "utf8"));
const sourceResults = Array.isArray(sourceJob.results) ? sourceJob.results : [];
if (!sourceResults.length) {
  throw new Error("源结果里没有数据。");
}

await fs.mkdir(path.join(OUTPUT_DIR, "images"), { recursive: true });

const startedAt = nowIso();
const job = {
  id: OUTPUT_ID,
  status: "running",
  phase: "补采 Ozon 人民币价格",
  kind: "run",
  createdAt: startedAt,
  updatedAt: startedAt,
  total: sourceResults.length,
  processed: 0,
  sourceStartRow: 1,
  sourceTotal: sourceResults.length,
  consecutiveFailures: 0,
  logs: [],
  verification: null,
  results: [],
  error: "",
  downloadUrl: null,
  cancelRequested: false,
};
registerRuntimeJob(job);
pushLog(job, `从 ${SOURCE_ID} 读取 ${sourceResults.length} 条结果，只补采 Ozon 人民币价格/黑标价。`);

await fs.mkdir(REFRESH_PROFILE_DIR, { recursive: true });
const context = await chromium.launchPersistentContext(REFRESH_PROFILE_DIR, {
  headless: HEADLESS,
  viewport: { width: 1365, height: 900 },
  locale: "zh-CN",
  timezoneId: "Asia/Shanghai",
  userAgent: USER_AGENT,
  args: ["--disable-blink-features=AutomationControlled"],
});
let refreshed = 0;
let failed = 0;

try {
  for (const original of sourceResults) {
    const sourceRow = Number(original.sourceRow || 0);
    if (ONLY_ROWS.size && !ONLY_ROWS.has(sourceRow)) {
      job.results.push(original);
      continue;
    }
    if (sourceRow < START_ROW || sourceRow > END_ROW) {
      job.results.push(original);
      continue;
    }
    if (LIMIT && refreshed >= LIMIT) {
      job.results.push(original);
      continue;
    }

    const result = {
      ...original,
      sourceRow,
      url: original.url || original.ozon?.sourceUrl || "",
    };
    job.phase = `补采 Ozon 第 ${sourceRow} 行`;
    job.updatedAt = nowIso();
    pushLog(job, `正在补采第 ${sourceRow} 行 Ozon 人民币价格：${result.url}`);

    try {
      const freshOzon = await scrapeOzonProduct(context, result.url, job.id, sourceRow);
      result.ozon = mergeRefreshedOzon(original.ozon || {}, freshOzon);
      result.error = /^Ozon 补采失败/i.test(String(original.error || "")) ? "" : (original.error || "");
      refreshed += 1;
      job.consecutiveFailures = 0;
      pushLog(job, `第 ${sourceRow} 行补采完成：绿色价 ${result.ozon.currentGreenPriceCny || "空"}，黑标价 ${result.ozon.currentBlackPriceCny || "空"}，备注 ${result.ozon.ozonPriceNote || "无"}`);
    } catch (error) {
      failed += 1;
      job.consecutiveFailures += 1;
      result.error = original.error || `Ozon 补采失败：${error.message}`;
      result.ozon = {
        ...(original.ozon || {}),
        ozonPriceNote: [original.ozon?.ozonPriceNote, `Ozon 补采失败：${error.message}`].filter(Boolean).join("；"),
      };
      pushLog(job, `第 ${sourceRow} 行补采失败：${error.message}`, "warn");
      if (STOP_ON_WINDOW_CLOSE && isWindowClosedError(error)) {
        job.status = "error";
        job.phase = "已停止";
        job.error = `检测到补采浏览器窗口被关闭，已停止整批补采。最后位置：第 ${sourceRow} 行。`;
        pushLog(job, job.error, "error");
      }
    }

    job.results.push(result);
    job.processed = job.results.length;
    job.updatedAt = nowIso();
    await fs.writeFile(path.join(OUTPUT_DIR, "partial-results.json"), JSON.stringify(job, null, 2), "utf8");

    if (job.status === "error") break;

    if (sourceRow < END_ROW && (!LIMIT || refreshed < LIMIT)) {
      await sleep(randomInt(ROW_DELAY_MIN_MS, ROW_DELAY_MAX_MS));
    }
  }

  if (job.status !== "error") {
    job.status = "done";
    job.phase = failed ? `补采完成，${failed} 条失败` : "补采完成";
    pushLog(job, `补采结束：成功 ${refreshed} 条，失败 ${failed} 条。`);
  }
  await writeJobArtifacts(job);

  if (job.status === "error") {
    console.log(JSON.stringify({
      outputId: OUTPUT_ID,
      stopped: true,
      rows: job.results.length,
      refreshed,
      failed,
      error: job.error,
      partialPath: path.join(OUTPUT_DIR, "partial-results.json"),
    }, null, 2));
    process.exitCode = 1;
  } else {
  const sourceExcel = path.join(OUTPUT_DIR, "ozon-1688-results.xlsx");
  if (!existsSync(sourceExcel)) {
    throw new Error(`没有生成 Excel：${sourceExcel}`);
  }
  const downloadPath = path.join(DOWNLOADS_DIR, OUTPUT_FILE);
  await fs.copyFile(sourceExcel, downloadPath);

  console.log(JSON.stringify({
    outputId: OUTPUT_ID,
    rows: job.results.length,
    refreshed,
    failed,
    sourceExcel,
    downloadPath,
  }, null, 2));
  }
} finally {
  unregisterRuntimeJob(job.id);
  await context.close().catch(() => {});
}
