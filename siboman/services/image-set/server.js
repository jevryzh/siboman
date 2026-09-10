/**
 * 独立「AI 套图服务」(image-set-service)
 * - 与 ERP 解耦：独立进程 + 独立端口 + 独立 API Key，可被 ERP / Ozon / Etsy 等系统调用
 * - 出图引擎：TokenDun gpt-image-2 图生图（手写 multipart，网关只认 image[]）
 * - 结果图直接落到共享公网目录（PUBLIC_UPLOAD_DIR），保证 Yandex/Ozon/Etsy 都能抓取
 *
 * 接口：
 *   GET  /health
 *   POST /jobs      { platform, refImageUrl, title, features[], language, ratio, keys[]? }  → { jobId }
 *   GET  /jobs/:id  → { status, phase, processed, total, images:[{key,label,url,ok,error}] }
 *   POST /jobs/:id/cancel
 */
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.IMAGE_SET_PORT || 5190);
const API_KEY = String(process.env.IMAGE_SET_API_KEY || "");
const TOKENDUN_BASE = (() => {
  const raw = String(process.env.TOKENDUN_BASE_URL || "https://api.tokendun.cc/v1").replace(/\/+$/, "");
  return /\/v1$/.test(raw) ? raw : `${raw}/v1`;
})();
const TOKENDUN_KEY = String(process.env.TOKENDUN_API_KEY || "");
const TOKENDUN_MODEL = String(process.env.TOKENDUN_IMAGE_MODEL || "gpt-image-2");
const PUBLIC_BASE = String(process.env.IMAGE_SET_PUBLIC_BASE || "https://test.renwz.cn").replace(/\/+$/, "");
const UPLOAD_DIR = String(process.env.IMAGE_SET_UPLOAD_DIR || "/opt/ozon/app-test/public/uploads/image-set");
const DATA_DIR = String(process.env.IMAGE_SET_DATA_DIR || "/opt/ozon/image-set-service/data");

const SIZE_BY_RATIO = { "1:1": "1024x1024", "3:4": "1024x1536", "4:3": "1536x1024", "9:16": "1024x1536", "16:9": "1536x1024" };
// gpt-image-2 只能出 1024x1024 / 1024x1536 / 1536x1024，没有真正的 3:4；
// 所以按目标比例在本地裁切+缩放+转 JPEG（顺带把 3-4MB 的 PNG 压到 300KB 级）
const RATIO_VALUE = { "1:1": 1, "3:4": 3 / 4, "4:3": 4 / 3, "9:16": 9 / 16, "16:9": 16 / 9, "2:3": 2 / 3 };
const OUTPUT_LONG_EDGE = Number(process.env.IMAGE_SET_OUTPUT_LONG_EDGE || 1600);
const OUTPUT_QUALITY = Number(process.env.IMAGE_SET_OUTPUT_QUALITY || 82);

const MAX_REF_IMAGES = Math.max(1, Math.min(6, Number(process.env.IMAGE_SET_MAX_REF_IMAGES || 4)));   // 最多同时给几张参考图
const IMAGE_TIMEOUT_MS = Number(process.env.IMAGE_SET_IMAGE_TIMEOUT_MS || 300000);   // 单张生成上限(默认 5 分钟，实测约 55s)
const KEEP = "CRITICAL PRODUCT FIDELITY: reproduce the product EXACTLY as in the reference photo(s) — identical shape, proportions, material, colour, packaging, labels, printed text and quantity, and the same number of items. The product itself must never be redesigned, replaced, stylised or duplicated. What you MAY and MUST change is the CAMERA, FRAMING, BACKGROUND, LIGHTING, PROPS and LAYOUT: do NOT copy the reference photo's composition, crop, background or arrangement.";
const NO_COPY = "Do not repeat the reference photo's camera angle, framing, crop, background or staging — every image in this set must look like it was shot separately, from a clearly different angle and distance. Photorealistic commercial product photography, high detail, sharp focus.";
const SAFE_AREA = "Leave a clean margin around the artwork: keep ALL text, labels, callouts and the whole product inside the central 88% of the frame (the very top and bottom may be trimmed away).";
const RULES = {
  ru: "Russian marketplace listing image, professional e-commerce style, cinematic lighting, ALL text in Russian only (correct spelling, modern clean Cyrillic sans-serif, well spaced, never covering the product). No Chinese characters, no watermark.",
  en: "Etsy-style listing image, warm artisanal aesthetic, natural daylight, styled props, ALL text in English only (clean modern sans-serif, well spaced, never covering the product). No watermark.",
};
const MAIN_TEXT_RULE = {
  ru: "MAIN IMAGE RULE: no text, no logos, no watermarks on the main image; product only, hero centred occupying 55-65% of the frame, clean appealing background matching the product's real usage.",
  en: "MAIN IMAGE RULE: minimal or no text on the main image; product hero centred, beautiful styled background matching the product's real usage.",
};

// 平台预设：Ozon/Etsy/Yandex 只需要在这里描述差异
const PLATFORMS = {
  yandex: { ratio: "3:4", language: "ru", textAllowedOnMain: false },
  ozon: { ratio: "3:4", language: "ru", textAllowedOnMain: false },
  etsy: { ratio: "1:1", language: "en", textAllowedOnMain: false },
};

// 每个模板一个明确的「机位 + 构图」，避免七张图产品都摆在同一个位置只换背景
const TEMPLATES = [
  ["main", "主图", (c) => `${KEEP} ${NO_COPY} ${c.rules} ${c.mainRule} SHOT TYPE: straight-on eye-level hero shot, product standing upright, camera perfectly level, full product visible with air above and below. Scene: an appealing lifestyle setting matching its real usage and local buyer taste, natural props kept softly out of focus behind. Add a big bold headline in ${c.langName} (2-5 words, accurate) and 3 short feature callouts with thin leader lines describing REAL visible properties. Instead of plain size text, draw TECHNICAL MEASUREMENT ANNOTATIONS: thin dimension lines with arrowheads and small numbers along the product (height, width, volume/quantity where applicable). ${SAFE_AREA}`],
  ["usage", "使用场景", (c) => `${KEEP} ${NO_COPY} ${c.rules} SHOT TYPE: close-up ACTION shot — the product is being USED right now (hands interacting with it, mid-motion), camera much closer than the reference, shallow depth of field, warm cosy home setting with props fitting its use. Person's hands only, no face. The product must be at a visibly different angle than the reference. Short ${c.langName} caption describing the benefit. ${SAFE_AREA}`],
  ["multi", "多件摆拍", (c) => `${KEEP} ${NO_COPY} ${c.rules} SHOT TYPE: FLAT-LAY, camera pointing straight DOWN (90°, top-down bird's eye) — arrange the COMPLETE SET exactly as in the reference (all pieces, correct quantity) spread out across a tasteful marble/wood surface, spacing them so the whole layout reads at a glance; some pieces opened, others untouched. This must look nothing like the reference angle. Short accurate ${c.langName} top label naming the set plus the item count; one small bottom line "ИДЕАЛЬНЫЙ ПОДАРОК". ${SAFE_AREA}`],
  ["features", "产品特点", (c) => `${KEEP} ${NO_COPY} ${c.rules} SHOT TYPE: infographic layout — the product occupying the LEFT 45% of the frame shot as a clean 3/4 view (slightly turned, different from the reference), with 4-5 white callout cards stacked down the RIGHT side joined by thin leader lines, each with a short ${c.langName} label describing a REAL visible property. Light elegant background, generous spacing, tidy columns. ${SAFE_AREA}`],
  ["comparison", "竞品对比", (c) => `${KEEP} ${NO_COPY} ${c.rules} SHOT TYPE: split-screen comparison, camera at eye level — LEFT half: our product from the reference with a green check and label "НАШ НАБОР"; RIGHT half: a plain generic budget alternative of the same category with a red cross and label "ОБЫЧНЫЙ НАБОР". Both shown at the same scale on a clean two-tone split background, small ${c.langName} comparison points with check/cross icons between them. ${SAFE_AREA}`],
  ["single", "单件摆拍", (c) => `${KEEP} ${NO_COPY} ${c.rules} SHOT TYPE: low-angle dramatic close-up (camera slightly BELOW eye level looking up), one item alone on a dark polished stone slab with soft reflection, elegant smoky gradient background, strong rim light, props blurred far behind, shallow depth of field. Not a white background. Minimal ${c.langName} caption at the bottom. ${SAFE_AREA}`],
  ["details", "多角度细节", (c) => `${KEEP} ${NO_COPY} ${c.rules} SHOT TYPE: 2x2 macro grid of the SAME product — four extreme close-ups (${"СПЕРЕДИ / СБОКУ / СВЕРХУ / УПАКОВКА"}), each panel a different angle showing texture, materials, stitching, labels and packaging detail, thin frames and short ${c.langName} captions. Absolutely no full-product hero view. Consistent lighting across panels. ${SAFE_AREA}`],
];

const jobs = new Map();

function log(...args) { console.log(`[image-set ${new Date().toISOString().slice(11, 19)}]`, ...args); }
function saveJob(job) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, `${job.id}.json`), JSON.stringify(job, null, 2));
  } catch (e) { log("保存任务失败:", e.message); }
}
function loadJobs() {
  try {
    let interrupted = 0;
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (!f.endsWith(".json")) continue;
      const job = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
      // 进程重启时还在跑的任务不可能自己恢复（生成请求已随进程断开），标成失败让用户能重试
      if (job.status === "running" || job.status === "queued") {
        job.status = "error";
        job.phase = "服务重启，任务已中断";
        job.error = "出图服务重启，该任务已中断，请重新提交";
        job.updatedAt = new Date().toISOString();
        saveJob(job);
        interrupted += 1;
      }
      jobs.set(job.id, job);
    }
    log(`已恢复 ${jobs.size} 个历史任务${interrupted ? `（其中 ${interrupted} 个中断任务已标记失败）` : ""}`);
  } catch { /* 首次运行无数据 */ }
}

// ===== 出图串行队列 =====
// 实测：TokenDun 同一 key 并发提交时，第二个请求会被网关挂住（连接一直 ESTABLISHED、
//   既不返回也不报错），任务就永远停在“生成中”。所以这里强制一次只跑一个任务。
const pendingQueue = [];
let workerBusy = false;

function queuedAhead(job) {
  const idx = pendingQueue.indexOf(job);
  return idx < 0 ? 0 : idx + (workerBusy ? 1 : 0);
}
function refreshQueuePhases() {
  for (const q of pendingQueue) {
    if (q.status !== "queued") continue;
    const ahead = queuedAhead(q);
    q.queuedAhead = ahead;
    q.phase = ahead > 0 ? `排队中（前面还有 ${ahead} 个任务）` : "排队中，即将开始";
    saveJob(q);
  }
}
function enqueueJob(job) {
  pendingQueue.push(job);
  job.status = "queued";
  refreshQueuePhases();
  pumpQueue();
}
function cancelJob(job) {
  job.cancelRequested = true;
  const idx = pendingQueue.indexOf(job);
  if (idx >= 0) {                      // 还在排队：直接出队，立刻变成已取消
    pendingQueue.splice(idx, 1);
    job.status = "canceled";
    job.phase = "已取消（排队中被取消）";
    job.queuedAhead = 0;
    job.updatedAt = new Date().toISOString();
    saveJob(job);
    refreshQueuePhases();
    return true;
  }
  const req = activeRequests.get(job.id);   // 正在生成：掐掉在飞的请求，立刻停
  if (req) { try { req.destroy(new Error("已取消")); } catch (_e) {} }
  saveJob(job);
  return true;
}

async function pumpQueue() {
  if (workerBusy) return;
  const job = pendingQueue.shift();
  if (!job) return;
  if (job.cancelRequested) { job.status = "canceled"; job.phase = "已取消"; saveJob(job); return pumpQueue(); }
  workerBusy = true;
  refreshQueuePhases();
  try { await runJob(job); } catch (e) { log("任务异常:", e?.message || e); }
  finally { workerBusy = false; refreshQueuePhases(); pumpQueue(); }
}

function postMultipart(urlStr, { fields, fileField, files, onRequest }) {
  return new Promise((resolve, reject) => {
    const boundary = `----imageset${crypto.randomBytes(8).toString("hex")}`;
    const chunks = [];
    for (const [k, v] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    // OpenAI 图生图支持多张输入图：同一个字段名 image[] 重复多次
    for (const f of files) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${f.fileName}"\r\nContent-Type: ${f.fileType}\r\n\r\n`));
      chunks.push(f.buf);
      chunks.push(Buffer.from("\r\n"));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(chunks);
    const u = new URL(urlStr);
    const req = https.request({ host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: "POST",
      headers: { Authorization: `Bearer ${TOKENDUN_KEY}`, "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length }, timeout: IMAGE_TIMEOUT_MS },
      (res) => { const parts = []; res.on("data", (c) => parts.push(c)); res.on("end", () => { onRequest?.(null); resolve({ status: res.statusCode, text: Buffer.concat(parts).toString("utf8") }); }); });
    req.on("timeout", () => req.destroy(new Error(`TokenDun 单张超时（${Math.round(IMAGE_TIMEOUT_MS / 60000)} 分钟）`)));
    req.on("error", (e) => { onRequest?.(null); reject(e); });
    onRequest?.(req);      // 交给调用方，取消时可直接 destroy 掉在飞的请求
    req.write(body); req.end();
  });
}

// 取消：把正在飞的那个 HTTP 请求掐掉（否则要等这一张生成完才停）
const activeRequests = new Map();   // jobId -> req

async function fetchBuffer(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(90000) });
  if (!r.ok) throw new Error(`参考图下载失败 HTTP ${r.status}`);
  return { buf: Buffer.from(await r.arrayBuffer()), type: String(r.headers.get("content-type") || "image/jpeg").split(";")[0] };
}

// ===== 图片后处理：裁到目标比例 → 缩放 → JPEG（体积从 3-4MB PNG 降到 300KB 级）=====
let JimpLib = null, JimpLoadTried = false;
function loadJimp() {
  if (JimpLoadTried) return JimpLib;
  JimpLoadTried = true;
  for (const p of [process.env.IMAGE_SET_JIMP_PATH, "/opt/ozon/image-set-service/node_modules/jimp", "/opt/ozon/app-test/node_modules/jimp"].filter(Boolean)) {
    try { const m = require(p); if (m?.Jimp) { JimpLib = m.Jimp; break; } } catch (_e) {}
  }
  if (!JimpLib) log("⚠ 没找到 jimp，跳过压缩/裁切（图片会保持原样）");
  return JimpLib;
}

function sniffFormat(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.length > 12 && buf.subarray(0, 4).toString("ascii") === "RIFF") return "webp";
  return "bin";
}

async function processImage(buf, ratio) {
  const Jimp = loadJimp();
  const info = { bytes: buf.length, width: 0, height: 0, format: sniffFormat(buf), compressed: false };
  if (!Jimp) return { buf, ext: info.format === "jpg" ? "jpg" : "png", info };
  try {
    const img = await Jimp.read(buf);
    const w0 = img.bitmap.width, h0 = img.bitmap.height;
    const target = RATIO_VALUE[ratio] || w0 / h0;
    let w = w0, h = h0;
    if (Math.abs(w0 / h0 - target) > 0.01) {
      // 只裁掉多出来的那一边，居中裁切
      if (w0 / h0 < target) h = Math.round(w0 / target); else w = Math.round(h0 * target);
      img.crop({ x: Math.round((w0 - w) / 2), y: Math.round((h0 - h) / 2), w, h });
    }
    if (Math.max(w, h) > OUTPUT_LONG_EDGE) {
      if (w >= h) img.resize({ w: OUTPUT_LONG_EDGE }); else img.resize({ h: OUTPUT_LONG_EDGE });
    }
    const out = await img.getBuffer("image/jpeg", { quality: OUTPUT_QUALITY });
    if (out.length && out.length < buf.length) {
      info.bytes = out.length; info.compressed = true;
      info.width = img.bitmap.width; info.height = img.bitmap.height;
      return { buf: out, ext: "jpg", info };
    }
    info.width = w0; info.height = h0;
    return { buf, ext: info.format === "jpg" ? "jpg" : "png", info };
  } catch (e) {
    log("图片后处理失败，保留原图:", e.message);
    return { buf, ext: info.format === "jpg" ? "jpg" : "png", info };
  }
}

// ===== 可选：把成品图传到对象存储/CDN（七牛云 / S3 兼容都支持）=====
// 配置齐了才启用；没配就存本地。上传失败自动回退本地，绝不丢图。
// 注意：实测该七牛账号必须保留 base64 的 "=" 填充，去掉填充会返回 401 BadToken
const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
const CDN_PROVIDER = String(process.env.IMAGE_SET_CDN || "").toLowerCase();
const KEEP_LOCAL = String(process.env.IMAGE_SET_KEEP_LOCAL || "0") === "1";

const QINIU = {
  ak: String(process.env.QINIU_ACCESS_KEY || ""),
  sk: String(process.env.QINIU_SECRET_KEY || ""),
  bucket: String(process.env.QINIU_BUCKET || ""),
  domain: String(process.env.QINIU_DOMAIN || "").replace(/\/+$/, ""),
  prefix: String(process.env.QINIU_PREFIX || "zhumeng/ai-set").replace(/^\/+|\/+$/g, ""),
  upHost: String(process.env.QINIU_UP_HOST || "https://up-z2.qiniup.com"),
};
const S3 = {
  endpoint: String(process.env.IMAGE_SET_S3_ENDPOINT || "").replace(/\/+$/, ""),
  region: String(process.env.IMAGE_SET_S3_REGION || "auto"),
  bucket: String(process.env.IMAGE_SET_S3_BUCKET || ""),
  key: String(process.env.IMAGE_SET_S3_ACCESS_KEY || ""),
  secret: String(process.env.IMAGE_SET_S3_SECRET_KEY || ""),
  prefix: String(process.env.IMAGE_SET_S3_PREFIX || "ai-set").replace(/^\/+|\/+$/g, ""),
  base: String(process.env.IMAGE_SET_CDN_BASE || "").replace(/\/+$/, ""),
};

function cdnReady() {
  if (CDN_PROVIDER === "qiniu") return Boolean(QINIU.ak && QINIU.sk && QINIU.bucket && QINIU.domain);
  if (CDN_PROVIDER === "s3") return Boolean(S3.endpoint && S3.bucket && S3.key && S3.secret && S3.base);
  return false;
}
function cdnBase() { return CDN_PROVIDER === "qiniu" ? QINIU.domain : (CDN_PROVIDER === "s3" ? S3.base : "local"); }

// 七牛云原生上传（管理凭证 + 上传凭证，multipart 表单，区域 up-z2）
async function uploadToQiniu(buf, objectName, contentType) {
  const key = `${QINIU.prefix}/${objectName}`;
  const policy = JSON.stringify({ scope: `${QINIU.bucket}:${key}`, deadline: Math.floor(Date.now() / 1000) + 3600, insertOnly: 0 });
  const encodedPolicy = b64url(policy);
  const sign = crypto.createHmac("sha1", QINIU.sk).update(encodedPolicy).digest();
  const uploadToken = `${QINIU.ak}:${b64url(sign)}:${encodedPolicy}`;
  const boundary = `----imageset${crypto.randomBytes(8).toString("hex")}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="token"\r\n\r\n${uploadToken}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="key"\r\n\r\n${key}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${objectName}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const resp = await fetch(`${QINIU.upHost}/`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(120000),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`七牛上传失败 HTTP ${resp.status}: ${text.slice(0, 180)}`);
  let payload = null; try { payload = JSON.parse(text); } catch (_e) {}
  if (!payload?.key) throw new Error(`七牛返回异常: ${text.slice(0, 160)}`);
  return `${QINIU.domain}/${payload.key}`;
}

function hmac(key, data) { return crypto.createHmac("sha256", key).update(data, "utf8").digest(); }
function sha256hex(data) { return crypto.createHash("sha256").update(data).digest("hex"); }

async function uploadToS3(buf, objectName, contentType) {
  const host = new URL(S3.endpoint).host;
  const keyPath = `${S3.prefix}/${objectName}`;
  const canonicalUri = `/${S3.bucket}/${keyPath}`.replace(/\/+/g, "/");
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(buf);
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = `PUT\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${S3.region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonicalRequest)}`;
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${S3.secret}`, dateStamp), S3.region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${S3.key}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const resp = await fetch(`${S3.endpoint}${canonicalUri}`, {
    method: "PUT",
    headers: { "Content-Type": contentType, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, Authorization: authorization },
    body: buf,
    signal: AbortSignal.timeout(120000),
  });
  if (!resp.ok) throw new Error(`CDN 上传失败 HTTP ${resp.status}: ${String(await resp.text()).slice(0, 160)}`);
  return `${S3.base}/${keyPath}`;
}

async function uploadToCdn(buf, objectName, contentType = "image/jpeg") {
  if (!cdnReady()) return "";
  if (CDN_PROVIDER === "qiniu") return uploadToQiniu(buf, objectName, contentType);
  if (CDN_PROVIDER === "s3") return uploadToS3(buf, objectName, contentType);
  return "";
}

async function generateOne(prompt, refs, size, jobId) {
  const res = await postMultipart(`${TOKENDUN_BASE}/images/edits`, {
    fields: { model: TOKENDUN_MODEL, size, prompt },
    fileField: "image[]",
    files: refs.map((r, i) => ({ buf: r.buf, fileName: `ref${i + 1}.jpg`, fileType: r.type })),
    onRequest: (req) => { if (req) activeRequests.set(jobId, req); else activeRequests.delete(jobId); },
  });
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`TokenDun ${res.status}: ${String(res.text).slice(0, 200)}`);
    err.transient = res.status >= 500 || res.status === 429;   // 网关抖动可重试
    throw err;
  }
  const payload = JSON.parse(res.text);
  const item = payload?.data?.[0] || {};
  let buf = null;
  if (item.b64_json) buf = Buffer.from(item.b64_json, "base64");
  else if (item.url) {
    const dl = await fetch(item.url, { signal: AbortSignal.timeout(180000) });
    if (!dl.ok) throw new Error(`生成图下载失败 ${dl.status}`);
    buf = Buffer.from(await dl.arrayBuffer());
  }
  if (!buf || !buf.length) { const e = new Error(`未返回图片: ${String(res.text).slice(0, 160)}`); e.transient = true; throw e; }
  return { buf, tokens: payload?.usage?.total_tokens || 0 };
}

// 后处理 → 本地落盘 →（可选）上传 CDN
async function saveImage(rawBuf, ratio, tokens) {
  const { buf, ext, info } = await processImage(rawBuf, ratio);
  const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
  let url = "";
  if (cdnReady()) {
    try {
      url = await uploadToCdn(buf, name, ext === "jpg" ? "image/jpeg" : `image/${ext}`);
      log(`已上传 CDN: ${url} (${(buf.length / 1024).toFixed(0)}KB)`);
    } catch (e) {
      log("CDN 上传失败，回退本地:", e.message);
    }
  }
  if (!url || KEEP_LOCAL) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    if (!url) url = `${PUBLIC_BASE}/uploads/image-set/${name}`;
  }
  return { url, tokens, bytes: info.bytes, width: info.width, height: info.height, compressed: info.compressed };
}

// 网关抖动(5xx/429/超时)自动重试，避免整批里莫名其妙少一张
async function generateWithRetry(prompt, refs, size, jobId, attempts = 3) {
  let lastErr = null;
  for (let i = 1; i <= attempts; i += 1) {
    if (activeRequests.get(jobId)?.destroyed) throw new Error("已取消");
    try {
      return await generateOne(prompt, refs, size, jobId);
    } catch (e) {
      lastErr = e;
      const transient = e?.transient || /timeout|ECONNRESET|socket hang up|fetch failed|TokenDun 502|TokenDun 503|TokenDun 504|TokenDun 429/i.test(String(e?.message || ""));
      if (!transient || i === attempts) break;
      const wait = 4000 * i;
      log(`第 ${i} 次失败(${String(e.message).slice(0, 60)})，${wait / 1000}s 后重试`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function runJob(job) {
  job.status = "running";
  job.queuedAhead = 0;
  job.phase = "开始生成";
  saveJob(job);
  try {
    const preset = PLATFORMS[job.platform] || PLATFORMS.yandex;
    const ratio = job.ratio || preset.ratio;
    const language = job.language || preset.language;
    const ctx = { rules: RULES[language] || RULES.ru, mainRule: MAIN_TEXT_RULE[language] || MAIN_TEXT_RULE.ru, langName: language === "en" ? "English" : "Russian", textOnMain: preset.textAllowedOnMain };
    const size = SIZE_BY_RATIO[ratio] || "1024x1536";
    job.ratio = ratio; job.size = size; job.cdn = cdnReady() ? cdnBase() : "local";
    const refUrls = (Array.isArray(job.refImageUrls) && job.refImageUrls.length ? job.refImageUrls : [job.refImageUrl]).filter(Boolean);
    const refs = [];
    for (const u of refUrls) refs.push(await fetchBuffer(u));
    job.refCount = refs.length;
    const wanted = Array.isArray(job.keys) && job.keys.length ? TEMPLATES.filter(([k]) => job.keys.includes(k)) : TEMPLATES;
    job.total = wanted.length;
    saveJob(job);
    for (const [key, label, build] of wanted) {
      if (job.cancelRequested) break;
      job.phase = `生成 ${label}（${job.images.length + 1}/${job.total}）`;
      saveJob(job);
      try {
        const raw = await generateWithRetry(build(ctx), refs, size, job.id);
        if (job.cancelRequested) break;      // 取消把在飞的请求掐了，这张就不算数
        const out = await saveImage(raw.buf, ratio, raw.tokens);
        if (job.cancelRequested) break;
        job.images.push({ key, label, url: out.url, tokens: out.tokens, ok: true,
          bytes: out.bytes, width: out.width, height: out.height });
      } catch (e) {
        if (job.cancelRequested) break;
        job.images.push({ key, label, url: "", ok: false, error: String(e?.message || e).slice(0, 300) });
      }
      job.processed = job.images.length;
      saveJob(job);
    }
    const okCount = job.images.filter((x) => x.ok).length;
    job.status = job.cancelRequested ? "canceled" : (okCount ? "done" : "error");
    job.phase = job.cancelRequested ? `已取消（已生成 ${okCount} 张）` : `完成：成功 ${okCount} / ${job.total}`;
    job.error = job.cancelRequested ? "" : (okCount ? "" : (job.images[0]?.error || "全部失败"));
    job.updatedAt = new Date().toISOString();
    saveJob(job);
    log(`任务 ${job.id} ${job.status}：成功 ${okCount}/${job.total}`);
  } catch (e) {
    if (job.cancelRequested) {
      job.status = "canceled"; job.phase = "已取消"; job.error = "";
      job.updatedAt = new Date().toISOString(); saveJob(job);
      log(`任务 ${job.id} 已取消`);
      return;
    }
    job.status = "error"; job.phase = "失败"; job.error = String(e?.message || e).slice(0, 400);
    saveJob(job);
    log(`任务 ${job.id} 失败:`, job.error);
  }
}

function json(res, code, body) { const t = JSON.stringify(body); res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(t) }); res.end(t); }
function readBody(req) { return new Promise((resolve, reject) => { const parts = []; req.on("data", (c) => parts.push(c)); req.on("end", () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {}); } catch (e) { reject(e); } }); req.on("error", reject); }); }

const MAX_UPLOAD_BYTES = Number(process.env.IMAGE_SET_MAX_UPLOAD_MB || 30) * 1024 * 1024;
function readRaw(req, limit = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const parts = []; let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error(`图片过大，最大 ${Math.round(limit / 1048576)}MB`)); req.destroy(); return; }
      parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}
// 从魔数识别图片类型（不信任客户端文件名/Content-Type）
function sniffImageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: "png", mime: "image/png" };
  if (buf.length > 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return { ext: "webp", mime: "image/webp" };
  if (buf.length > 6 && ["GIF87a", "GIF89a"].includes(buf.subarray(0, 6).toString("ascii"))) return { ext: "gif", mime: "image/gif" };
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === "/health") return json(res, 200, { ok: true, service: "image-set", tokendunConfigured: Boolean(TOKENDUN_KEY), model: TOKENDUN_MODEL, base: TOKENDUN_BASE, platforms: Object.keys(PLATFORMS), jobs: jobs.size, queued: pendingQueue.length, busy: workerBusy, cdn: cdnReady() ? cdnBase() : "local" });
    const key = String(req.headers["x-api-key"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    if (API_KEY && key !== API_KEY) return json(res, 401, { ok: false, error: "invalid api key" });
    if (req.method === "POST" && url.pathname === "/upload") {
      const buf = await readRaw(req);
      if (!buf.length) return json(res, 400, { ok: false, error: "空文件" });
      const kind = sniffImageType(buf);
      if (!kind) return json(res, 400, { ok: false, error: "只支持 JPG / PNG / WEBP / GIF 图片" });
      const dir = path.join(UPLOAD_DIR, "refs");
      fs.mkdirSync(dir, { recursive: true });
      const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${kind.ext}`;
      fs.writeFileSync(path.join(dir, name), buf);
      const publicUrl = `${PUBLIC_BASE}/uploads/image-set/refs/${name}`;
      log(`上传参考图 ${(buf.length / 1024).toFixed(0)}KB → ${publicUrl}`);
      return json(res, 200, { ok: true, url: publicUrl, bytes: buf.length, mime: kind.mime });
    }
    if (req.method === "POST" && url.pathname === "/jobs") {
      const body = await readBody(req);
      const refList = (Array.isArray(body.refImageUrls) ? body.refImageUrls : [body.refImageUrl])
        .map((u) => String(u || "").trim()).filter(Boolean).slice(0, MAX_REF_IMAGES);
      if (!refList.length) return json(res, 400, { ok: false, error: "至少要有一张参考图（refImageUrl 或 refImageUrls）" });
      const job = { id: crypto.randomUUID(), platform: String(body.platform || "yandex"),
        refImageUrl: refList[0], refImageUrls: refList, refCount: refList.length,
        title: String(body.title || ""), features: Array.isArray(body.features) ? body.features : [], keys: body.keys || null,
        ratio: body.ratio || "", language: body.language || "", status: "queued", phase: "排队中", images: [], processed: 0, total: 0,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      jobs.set(job.id, job); saveJob(job);
      enqueueJob(job);
      return json(res, 200, { ok: true, jobId: job.id, total: (Array.isArray(job.keys) && job.keys.length) ? job.keys.length : TEMPLATES.length, queuedAhead: queuedAhead(job) });
    }
    if (req.method === "GET" && url.pathname === "/jobs") {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 30)));
      const list = Array.from(jobs.values())
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
        .slice(0, limit)
        .map((j) => ({
          id: j.id, platform: j.platform, status: j.status, phase: j.phase,
          processed: j.processed || 0, total: j.total || 0,
          createdAt: j.createdAt, updatedAt: j.updatedAt,
          refImageUrl: j.refImageUrl, refImageUrls: j.refImageUrls || [j.refImageUrl].filter(Boolean),
          refCount: j.refCount || (j.refImageUrls ? j.refImageUrls.length : 1),
          images: (j.images || []).map((x) => ({ key: x.key, label: x.label, ok: Boolean(x.ok), url: x.url || "", error: x.error || "" })),
        }));
      return json(res, 200, { ok: true, count: list.length, jobs: list });
    }
    const m = url.pathname.match(/^\/jobs\/([\w-]+)(?:\/(cancel))?$/);
    if (m) {
      const job = jobs.get(m[1]);
      if (!job) return json(res, 404, { ok: false, error: "job not found" });
      if (req.method === "POST" && m[2] === "cancel") {
        cancelJob(job);
        log(`收到取消请求：${job.id} → ${job.status}`);
        return json(res, 200, { ok: true, status: job.status });
      }
      if (req.method === "GET") return json(res, 200, { ok: true, job });
    }
    return json(res, 404, { ok: false, error: "not found" });
  } catch (e) { return json(res, 500, { ok: false, error: String(e?.message || e) }); }
});

loadJobs();
server.listen(PORT, "127.0.0.1", () => log(`listening on 127.0.0.1:${PORT} | model=${TOKENDUN_MODEL} | base=${TOKENDUN_BASE} | uploads=${UPLOAD_DIR}`));
