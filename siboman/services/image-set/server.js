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

const KEEP = "IMPORTANT: keep the product EXACTLY as in the reference photo — same shape, proportions, material, colour, packaging, labels and quantity. Never redesign or replace the product. Photorealistic commercial product photography, high detail, sharp focus.";
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

const TEMPLATES = [
  ["main", "主图", (c) => `${KEEP} ${c.rules} ${c.mainRule} MAIN COVER IMAGE. Look carefully at the reference and understand exactly what the product is. Scene: appealing lifestyle setting matching its real usage and local buyer taste, natural props. Add a big bold headline in ${c.langName} (2-5 words, accurate) ${c.textOnMain ? "" : ""}and 3 short feature callouts with thin leader lines describing REAL visible properties. Instead of plain size text, draw TECHNICAL MEASUREMENT ANNOTATIONS: thin dimension lines with arrowheads and small numbers along the product (height, width, volume/quantity where applicable).`],
  ["usage", "使用场景", (c) => `${KEEP} ${c.rules} USAGE SCENARIO IMAGE: product in real use, person's hands only (no face), warm cosy setting with props fitting its use, product clearly visible and unchanged. Short ${c.langName} caption describing the benefit.`],
  ["multi", "多件摆拍", (c) => `${KEEP} ${c.rules} MULTI-ITEM STAGING: arrange the COMPLETE SET exactly as in the reference (all pieces, correct quantity) on a tasteful surface. Some pieces opened/in use, others untouched and neatly arranged. Short accurate ${c.langName} label naming the set plus the item count; one small bottom line marking it as a perfect gift.`],
  ["features", "产品特点", (c) => `${KEEP} ${c.rules} FEATURE INFOGRAPHIC: one large hero view from the reference in the centre, surrounded by 4-5 clean white callout cards joined by thin leader lines with short ${c.langName} labels describing REAL visible properties. Light elegant background, tidy structured layout.`],
  ["comparison", "竞品对比", (c) => `${KEEP} ${c.rules} COMPARISON IMAGE: left side our product from the reference with a green check, right side a plain generic budget alternative of the same category with a red cross. Small ${c.langName} comparison points with check/cross icons between them. Clean split background, infographic style.`],
  ["single", "单件摆拍", (c) => `${KEEP} ${c.rules} PREMIUM SINGLE ITEM SHOT (not a white background): one item alone on a dark polished slab with soft reflection, elegant gradient background, subtle rim light, props blurred behind. Minimal ${c.langName} caption at the bottom.`],
  ["details", "多角度细节", (c) => `${KEEP} ${c.rules} MULTI-ANGLE DETAIL COLLAGE: four macro close-ups of the same product in a neat 2x2 grid, each in a thin frame with a short ${c.langName} caption. Show texture, materials, labels and packaging. Consistent lighting across panels.`],
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
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (!f.endsWith(".json")) continue;
      const job = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
      jobs.set(job.id, job);
    }
    log(`已恢复 ${jobs.size} 个历史任务`);
  } catch { /* 首次运行无数据 */ }
}

function postMultipart(urlStr, { fields, fileField, fileBuf, fileName, fileType }) {
  return new Promise((resolve, reject) => {
    const boundary = `----imageset${crypto.randomBytes(8).toString("hex")}`;
    const chunks = [];
    for (const [k, v] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: ${fileType}\r\n\r\n`));
    chunks.push(fileBuf);
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(chunks);
    const u = new URL(urlStr);
    const req = https.request({ host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: "POST",
      headers: { Authorization: `Bearer ${TOKENDUN_KEY}`, "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length }, timeout: 600000 },
      (res) => { const parts = []; res.on("data", (c) => parts.push(c)); res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString("utf8") })); });
    req.on("timeout", () => req.destroy(new Error("TokenDun 超时")));
    req.on("error", reject);
    req.write(body); req.end();
  });
}

async function fetchBuffer(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(90000) });
  if (!r.ok) throw new Error(`参考图下载失败 HTTP ${r.status}`);
  return { buf: Buffer.from(await r.arrayBuffer()), type: String(r.headers.get("content-type") || "image/jpeg").split(";")[0] };
}

async function generateOne(prompt, ref, size) {
  const res = await postMultipart(`${TOKENDUN_BASE}/images/edits`, {
    fields: { model: TOKENDUN_MODEL, size, prompt }, fileField: "image[]", fileBuf: ref.buf, fileName: "ref.jpg", fileType: ref.type,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`TokenDun ${res.status}: ${String(res.text).slice(0, 200)}`);
  const payload = JSON.parse(res.text);
  const item = payload?.data?.[0] || {};
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.jpg`;
  const dest = path.join(UPLOAD_DIR, name);
  if (item.b64_json) fs.writeFileSync(dest, Buffer.from(item.b64_json, "base64"));
  else if (item.url) {
    const dl = await fetch(item.url, { signal: AbortSignal.timeout(180000) });
    if (!dl.ok) throw new Error(`生成图下载失败 ${dl.status}`);
    fs.writeFileSync(dest, Buffer.from(await dl.arrayBuffer()));
  } else throw new Error(`未返回图片: ${String(res.text).slice(0, 160)}`);
  return { url: `${PUBLIC_BASE}/uploads/image-set/${name}`, tokens: payload?.usage?.total_tokens || 0 };
}

async function runJob(job) {
  job.status = "running";
  try {
    const preset = PLATFORMS[job.platform] || PLATFORMS.yandex;
    const ratio = job.ratio || preset.ratio;
    const language = job.language || preset.language;
    const ctx = { rules: RULES[language] || RULES.ru, mainRule: MAIN_TEXT_RULE[language] || MAIN_TEXT_RULE.ru, langName: language === "en" ? "English" : "Russian", textOnMain: preset.textAllowedOnMain };
    const size = SIZE_BY_RATIO[ratio] || "1024x1536";
    job.ratio = ratio; job.size = size;
    const ref = await fetchBuffer(job.refImageUrl);
    const wanted = Array.isArray(job.keys) && job.keys.length ? TEMPLATES.filter(([k]) => job.keys.includes(k)) : TEMPLATES;
    job.total = wanted.length;
    saveJob(job);
    for (const [key, label, build] of wanted) {
      if (job.cancelRequested) break;
      job.phase = `生成 ${label}（${job.images.length + 1}/${job.total}）`;
      saveJob(job);
      try {
        const out = await generateOne(build(ctx), ref, size);
        job.images.push({ key, label, url: out.url, tokens: out.tokens, ok: true });
      } catch (e) {
        job.images.push({ key, label, url: "", ok: false, error: String(e?.message || e).slice(0, 300) });
      }
      job.processed = job.images.length;
      saveJob(job);
    }
    const okCount = job.images.filter((x) => x.ok).length;
    job.status = job.cancelRequested ? "canceled" : (okCount ? "done" : "error");
    job.phase = `完成：成功 ${okCount} / ${job.total}`;
    job.error = okCount ? "" : (job.images[0]?.error || "全部失败");
    job.updatedAt = new Date().toISOString();
    saveJob(job);
    log(`任务 ${job.id} ${job.status}：成功 ${okCount}/${job.total}`);
  } catch (e) {
    job.status = "error"; job.phase = "失败"; job.error = String(e?.message || e).slice(0, 400);
    saveJob(job);
    log(`任务 ${job.id} 失败:`, job.error);
  }
}

function json(res, code, body) { const t = JSON.stringify(body); res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(t) }); res.end(t); }
function readBody(req) { return new Promise((resolve, reject) => { const parts = []; req.on("data", (c) => parts.push(c)); req.on("end", () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {}); } catch (e) { reject(e); } }); req.on("error", reject); }); }

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === "/health") return json(res, 200, { ok: true, service: "image-set", tokendunConfigured: Boolean(TOKENDUN_KEY), model: TOKENDUN_MODEL, base: TOKENDUN_BASE, platforms: Object.keys(PLATFORMS), jobs: jobs.size });
    const key = String(req.headers["x-api-key"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    if (API_KEY && key !== API_KEY) return json(res, 401, { ok: false, error: "invalid api key" });
    if (req.method === "POST" && url.pathname === "/jobs") {
      const body = await readBody(req);
      if (!body.refImageUrl) return json(res, 400, { ok: false, error: "refImageUrl 必填" });
      const job = { id: crypto.randomUUID(), platform: String(body.platform || "yandex"), refImageUrl: String(body.refImageUrl),
        title: String(body.title || ""), features: Array.isArray(body.features) ? body.features : [], keys: body.keys || null,
        ratio: body.ratio || "", language: body.language || "", status: "queued", phase: "排队中", images: [], processed: 0, total: 0,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      jobs.set(job.id, job); saveJob(job);
      setTimeout(() => runJob(job), 20);
      return json(res, 200, { ok: true, jobId: job.id, total: TEMPLATES.length });
    }
    const m = url.pathname.match(/^\/jobs\/([\w-]+)(?:\/(cancel))?$/);
    if (m) {
      const job = jobs.get(m[1]);
      if (!job) return json(res, 404, { ok: false, error: "job not found" });
      if (req.method === "POST" && m[2] === "cancel") { job.cancelRequested = true; saveJob(job); return json(res, 200, { ok: true }); }
      if (req.method === "GET") return json(res, 200, { ok: true, job });
    }
    return json(res, 404, { ok: false, error: "not found" });
  } catch (e) { return json(res, 500, { ok: false, error: String(e?.message || e) }); }
});

loadJobs();
server.listen(PORT, "127.0.0.1", () => log(`listening on 127.0.0.1:${PORT} | model=${TOKENDUN_MODEL} | base=${TOKENDUN_BASE} | uploads=${UPLOAD_DIR}`));
