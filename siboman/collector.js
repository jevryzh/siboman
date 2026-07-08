import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  registerRuntimeJob,
  runBatchOzonJob,
  runJob,
  unregisterRuntimeJob,
  writeJobArtifacts,
} from "./server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const JOBS_DIR = path.join(__dirname, "data", "jobs");

const SERVER_URL = (process.env.COLLECTOR_SERVER_URL || process.env.REMOTE_BASE_URL || "http://xm.renwz.cn").replace(/\/$/, "");
const USERNAME = process.env.COLLECTOR_USERNAME || "";
const PASSWORD = process.env.COLLECTOR_PASSWORD || "";
const WORKER_NAME = process.env.COLLECTOR_WORKER_NAME || `${os.hostname()}-${process.pid}`;
const POLL_MS = Math.max(2000, Number(process.env.COLLECTOR_POLL_SECONDS || 5) * 1000);
const PROGRESS_MS = Math.max(1500, Number(process.env.COLLECTOR_PROGRESS_SECONDS || 4) * 1000);
const ONCE = /^(1|true|yes)$/i.test(process.env.COLLECTOR_ONCE || "");

let cookieHeader = "";
let lastProgressSignature = "";
let isSyncingProgress = false;

async function main() {
  if (!USERNAME || !PASSWORD) {
    throw new Error("请先在 .env 里配置 COLLECTOR_USERNAME 和 COLLECTOR_PASSWORD。");
  }
  console.log(`[collector] 连接服务器：${SERVER_URL}`);
  await loginWithRetry();

  while (true) {
    try {
      const { job } = await apiJson("/api/worker/jobs/next", {
        method: "POST",
        body: { workerName: WORKER_NAME },
      });
      if (!job) {
        console.log(`[collector] 暂无任务，${Math.round(POLL_MS / 1000)} 秒后继续检查。`);
        if (ONCE) return;
        await sleep(POLL_MS);
        continue;
      }
      await runRemoteJob(job);
      if (ONCE) return;
    } catch (error) {
      console.error(`[collector] 轮询异常：${error.message}`);
      cookieHeader = "";
      await loginWithRetry();
      await sleep(POLL_MS);
    }
  }
}

async function login() {
  await apiJson("/api/auth/login", {
    method: "POST",
    body: { username: USERNAME, password: PASSWORD },
  });
}

async function loginWithRetry() {
  while (true) {
    try {
      await login();
      console.log(`[collector] 已登录账号：${USERNAME}，采集端：${WORKER_NAME}`);
      return;
    } catch (error) {
      console.error(`[collector] 登录失败：${error.message}，${Math.round(POLL_MS / 1000)} 秒后重试。`);
      await sleep(POLL_MS);
    }
  }
}

async function runRemoteJob(remoteJob) {
  const payload = remoteJob.payload || {};
  const job = buildRuntimeJob(remoteJob, payload);
  registerRuntimeJob(job);
  lastProgressSignature = "";
  console.log(`[collector] 已领取任务：${job.id}`);

  const progressTimer = setInterval(() => {
    syncProgress(job).catch((error) => {
      console.error(`[collector] 回传进度失败：${error.message}`);
    });
  }, PROGRESS_MS);

  try {
    await syncProgress(job, true);
    if (job.kind === "batch-ozon") {
      await runBatchOzonJob(job, buildBatchOptions(remoteJob, payload));
    } else {
      await runJob(job, buildRunOptions(remoteJob, payload));
    }
  } catch (error) {
    job.status = job.cancelRequested ? "canceled" : "error";
    job.phase = job.cancelRequested ? "已停止" : "采集端异常";
    job.error = error.message;
    job.logs.push({
      at: new Date().toISOString(),
      level: "error",
      message: `采集端异常：${error.message}`,
    });
    console.error(`[collector] 任务失败：${error.message}`);
  } finally {
    clearInterval(progressTimer);
    await writeJobArtifacts(job).catch((error) => {
      console.error(`[collector] 本地写入结果失败：${error.message}`);
    });
    try {
      await retryAsync(() => uploadComplete(job), 3, 3000);
    } finally {
      unregisterRuntimeJob(job.id);
    }
    console.log(`[collector] 任务已回传：${job.id}，状态：${job.status}`);
  }
}

function buildRuntimeJob(remoteJob, payload) {
  return {
    id: remoteJob.id,
    status: "claimed",
    createdAt: remoteJob.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phase: "本机采集端已领取",
    kind: remoteJob.kind || "run",
    total: Number(remoteJob.total || payload.options?.maxProducts || payload.urls?.length || 0),
    sourceTotal: Number(remoteJob.sourceTotal || payload.options?.sourceTotal || payload.urls?.length || 0),
    sourceStartRow: Number(remoteJob.sourceStartRow || payload.options?.startRow || 1),
    inputUrlRows: payload.urlRows || [],
    resumeFromRow: null,
    resumeFile: null,
    processed: Number(remoteJob.processed || 0),
    consecutiveFailures: 0,
    logs: Array.isArray(remoteJob.logs) ? [...remoteJob.logs] : [],
    verification: null,
    results: [],
    error: null,
    downloadUrl: null,
    cancelRequested: false,
    sourceUrl: payload.sourceUrl || remoteJob.sourceUrl || "",
  };
}

function buildRunOptions(remoteJob, payload) {
  const options = { ...(payload.options || {}) };
  options.urls = Array.isArray(options.urls) && options.urls.length ? options.urls : payload.urls || [];
  options.urlRows = Array.isArray(options.urlRows) && options.urlRows.length ? options.urlRows : payload.urlRows || [];
  options.startRow = Number(options.startRow || remoteJob.sourceStartRow || 1);
  options.sourceTotal = Number(options.sourceTotal || remoteJob.sourceTotal || options.urls.length);
  return options;
}

function buildBatchOptions(remoteJob, payload) {
  const options = { ...(payload.options || {}) };
  options.sourceUrl = options.sourceUrl || payload.sourceUrl || remoteJob.sourceUrl || "";
  options.maxProducts = Number(options.maxProducts || remoteJob.total || 50);
  options.filters = options.filters || {};
  return options;
}

async function syncProgress(job, force = false) {
  if (isSyncingProgress) return;
  const signature = [
    job.status,
    job.phase,
    job.processed,
    job.total,
    job.logs.length,
    job.results.length,
    job.error || "",
  ].join("|");
  if (!force && signature === lastProgressSignature) return;
  isSyncingProgress = true;
  try {
    const data = await apiJson(`/api/worker/jobs/${encodeURIComponent(job.id)}/progress`, {
      method: "POST",
      body: stripLocalBuffers({
        status: job.status,
        phase: job.phase,
        processed: job.processed,
        total: job.total,
        logs: job.logs,
        results: job.results,
        error: job.error || "",
      }),
    });
    if (data.job?.status === "canceled" && !job.cancelRequested) {
      job.cancelRequested = true;
      job.logs.push({
        at: new Date().toISOString(),
        level: "warn",
        message: "服务器已请求停止，当前商品处理完后会停下。",
      });
    }
    lastProgressSignature = signature;
  } finally {
    isSyncingProgress = false;
  }
}

async function uploadComplete(job) {
  await syncProgress(job, true).catch(() => {});
  const localJob = await readLocalJobJson(job);
  const excelBase64 = await readLocalExcelBase64(job);
  await apiJson(`/api/worker/jobs/${encodeURIComponent(job.id)}/complete`, {
    method: "POST",
    body: {
      job: stripLocalBuffers(localJob || job),
      excelBase64,
    },
  });
}

async function readLocalJobJson(job) {
  const jsonPath = path.join(JOBS_DIR, job.id, "results.json");
  try {
    return JSON.parse(await fs.readFile(jsonPath, "utf8"));
  } catch {
    return null;
  }
}

async function readLocalExcelBase64(job) {
  const excelName = job.kind === "batch-ozon" ? "ozon-batch-results.xlsx" : "ozon-1688-results.xlsx";
  const excelPath = path.join(JOBS_DIR, job.id, excelName);
  try {
    return (await fs.readFile(excelPath)).toString("base64");
  } catch {
    return "";
  }
}

async function apiJson(route, { method = "GET", body } = {}) {
  const headers = { Accept: "application/json" };
  if (cookieHeader) headers.Cookie = cookieHeader;
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(new URL(route, `${SERVER_URL}/`), init);
  const nextCookie = extractCookie(response);
  if (nextCookie) cookieHeader = nextCookie;
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `请求失败：${response.status}`);
  }
  return data;
}

function extractCookie(response) {
  const cookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  const pairs = cookies.map((cookie) => String(cookie).split(";")[0]).filter(Boolean);
  return pairs.length ? pairs.join("; ") : "";
}

function stripLocalBuffers(value) {
  if (Array.isArray(value)) return value.map(stripLocalBuffers);
  if (!value || typeof value !== "object") return value;
  if (Buffer.isBuffer(value)) return undefined;
  const copy = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "buffer") continue;
    const stripped = stripLocalBuffers(child);
    if (stripped !== undefined) copy[key] = stripped;
  }
  return copy;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryAsync(callback, attempts, delayMs) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await callback();
    } catch (error) {
      lastError = error;
      if (index < attempts - 1) {
        console.error(`[collector] 操作失败：${error.message}，准备重试。`);
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

main().catch((error) => {
  console.error(`[collector] 已停止：${error.message}`);
  process.exitCode = 1;
});
