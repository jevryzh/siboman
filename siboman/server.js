import express from "express";
import { chromium } from "playwright";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import crypto from "node:crypto";
import multer from "multer";
import fs from "node:fs/promises";
import { readFileSync, existsSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { Pool } from "pg";
import dns from "node:dns/promises";
import net from "node:net";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 配置 multer 用于文件上传 (v0.3.2 修复: 异常回调兜底防进程崩溃)
// 注意: PUBLIC_DIR 在此文件下方才定义, 因此这里不能预建目录; 改为运行时懒建 + err 回调
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      ensureUploadDir()
        .then((uploadDir) => cb(null, uploadDir))
        .catch((err) => cb(err));   // ✅ 必须回调 err, 否则 promise reject 会冒泡 uncaught 崩进程
    },
    filename: (req, file, cb) => {
      try {
        const ext = path.extname(file.originalname || "");
        const name = crypto.randomBytes(16).toString("hex") + ext;
        cb(null, name);
      } catch (e) {
        cb(e);
      }
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },  // 20MB 上限
});

const execFileAsync = promisify(execFile);

loadLocalEnv();

const PORT = Number(process.env.PORT || 5177);
const HOST = process.env.HOST || "";
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const JOBS_DIR = path.join(DATA_DIR, "jobs");
const PROFILE_DIR = path.join(DATA_DIR, "browser-profile");
const LOGISTICS_TEMPLATE_PATH = process.env.LOGISTICS_TEMPLATE_PATH || path.join(DATA_DIR, "templates", "logistics-template.xlsx");
const PYTHON_BIN = process.env.PYTHON_BIN || "python3";
const APP_KEY = "12574478";
const MTOP_URL = "https://h5api.m.1688.com/h5/mtop.relationrecommend.wirelessrecommend.recommend/2.0/";
const MINIMAX_BASE_URL = (process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com/v1").replace(/\/$/, "");
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || "MiniMax-M3";
const MINIMAX_THINKING_TYPE = process.env.MINIMAX_THINKING_TYPE || "disabled";
const AI_CONFIDENCE_THRESHOLD = Number(process.env.AI_CONFIDENCE_THRESHOLD || 0.78);
const MINIMAX_INPUT_USD_PER_M = Number(process.env.MINIMAX_INPUT_USD_PER_M || 0.30);
const MINIMAX_OUTPUT_USD_PER_M = Number(process.env.MINIMAX_OUTPUT_USD_PER_M || 1.20);
const LOW_PRICE_THRESHOLD_RMB = Number(process.env.LOW_PRICE_THRESHOLD_RMB || 1);
const OZON_SELLER_BASE_URL = (process.env.OZON_SELLER_BASE_URL || "https://api-seller.ozon.ru").replace(/\/$/, "");
const OZON_SELLER_CLIENT_ID = process.env.OZON_SELLER_CLIENT_ID || "";
const OZON_SELLER_API_KEY = process.env.OZON_SELLER_API_KEY || "";
const OZON_ORDER_CANCEL_MODE = String(process.env.OZON_ORDER_CANCEL_MODE || "disabled").trim().toLowerCase();
const OZON_ORDER_CANCEL_BASE_URL = (process.env.OZON_ORDER_CANCEL_BASE_URL || "").replace(/\/$/, "");
const OZON_ORDER_CANCEL_ALLOW_PRODUCTION = /^(1|true|yes)$/i.test(process.env.OZON_ORDER_CANCEL_ALLOW_PRODUCTION || "");
const MINIMAX_IMAGE_MODEL = process.env.MINIMAX_IMAGE_MODEL || "image-01";
const MINIMAX_IMAGE_INPUT_USD_PER_M = Number(process.env.MINIMAX_IMAGE_INPUT_USD_PER_M || 0.30);
const MINIMAX_IMAGE_OUTPUT_USD_PER_M = Number(process.env.MINIMAX_IMAGE_OUTPUT_USD_PER_M || 1.20);
const MINIMAX_IMAGE_PER_IMAGE_USD = Number(process.env.MINIMAX_IMAGE_PER_IMAGE_USD || 0.03);
const RUB_CNY_RATE = Number(process.env.RUB_CNY_RATE || 0.0862);  // 1 RUB = ¥0.0862
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || "";
const DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
const DASHSCOPE_IMAGE_MODEL = process.env.DASHSCOPE_IMAGE_MODEL || "wan2.6-image";
const DASHSCOPE_IMAGE_PER_IMAGE_USD = Number(process.env.DASHSCOPE_IMAGE_PER_IMAGE_USD || 0.03);
const TOKENDUN_API_KEY = process.env.TOKENDUN_API_KEY || "";
const TOKENDUN_BASE_URL = (process.env.TOKENDUN_BASE_URL || "https://api.tokendun.com/v1").replace(/\/$/, "");
const TOKENDUN_IMAGE_MODEL = process.env.TOKENDUN_IMAGE_MODEL || "gpt-image-2";
const TOKENDUN_IMAGE_QUALITY = process.env.TOKENDUN_IMAGE_QUALITY || "low";
const TOKENDUN_IMAGE_PER_IMAGE_USD = Number(process.env.TOKENDUN_IMAGE_PER_IMAGE_USD || 0);
const AI_IMAGE_PROVIDER = String(process.env.AI_IMAGE_PROVIDER || "agnes").trim().toLowerCase();
const AGNES_API_KEY = process.env.AGNES_API_KEY || "";
const AGNES_BASE_URL = (process.env.AGNES_BASE_URL || "https://apihub.agnes-ai.com/v1").replace(/\/$/, "");
const AGNES_IMAGE_MODEL = process.env.AGNES_IMAGE_MODEL || "agnes-image-2.0-flash";
const AGNES_IMAGE_PER_IMAGE_USD = Number(process.env.AGNES_IMAGE_PER_IMAGE_USD || 0);
const AI_IMAGE_PROVIDER_ORDER = ["agnes", "tokendun", "wanxiang", "minimax"];
const PLUGIN_WORKER_TOKEN_TTL_MS = Number(process.env.PLUGIN_WORKER_TOKEN_TTL_MS || 15 * 60 * 1000);
const MIN_SINGLE_SOURCING_PLUGIN_VERSION = "2.2.9.100";
const ALLOW_LEGACY_EXTENSION_SELLER_CREDENTIALS = /^(1|true|yes)$/i.test(process.env.ALLOW_LEGACY_EXTENSION_SELLER_CREDENTIALS || "true");
const DEFAULT_DELAY_MIN_MS = Number(process.env.DEFAULT_DELAY_MIN_MS || 8000);
const DEFAULT_DELAY_MAX_MS = Number(process.env.DEFAULT_DELAY_MAX_MS || 20000);
const DETAIL_DELAY_MIN_MS = Number(process.env.DETAIL_DELAY_MIN_MS || 2500);
const DETAIL_DELAY_MAX_MS = Number(process.env.DETAIL_DELAY_MAX_MS || 6500);
const DETAIL_BROWSE_MODE = process.env.DETAIL_BROWSE_MODE || "balanced";
const DEFAULT_MAX_CONSECUTIVE_FAILURES = Number(process.env.DEFAULT_MAX_CONSECUTIVE_FAILURES || 3);
const DISABLE_SERVER_SCRAPER = /^(1|true|yes)$/i.test(process.env.DISABLE_SERVER_SCRAPER || "");
const SERVER_SINGLE_SOURCING = /^(1|true|yes)$/i.test(process.env.SERVER_SINGLE_SOURCING || "");
const WORKER_ONLINE_WINDOW_MS = Number(process.env.WORKER_ONLINE_WINDOW_MS || 45000);
const WORKER_JOB_STALE_MS = Number(process.env.WORKER_JOB_STALE_MS || 10 * 60 * 1000);
const WORKER_JOB_RECLAIM_MS = Number(process.env.WORKER_JOB_RECLAIM_MS || 90 * 1000);
const WORKER_IDLE_JOB_RESCUE_MS = Number(process.env.WORKER_IDLE_JOB_RESCUE_MS || 90 * 1000);
const WORKER_LOST_JOB_RESCUE_MS = Number(process.env.WORKER_LOST_JOB_RESCUE_MS || 120 * 1000);
const PLATFORM_SNAPSHOT_REFRESH_INTERVAL_MS = Number(process.env.PLATFORM_SNAPSHOT_REFRESH_INTERVAL_MS || 0);
const PLATFORM_SNAPSHOT_STALE_MS = Number(process.env.PLATFORM_SNAPSHOT_STALE_MS || 12 * 60 * 60 * 1000);
const PLATFORM_SNAPSHOT_DEFAULT_LIMIT = Number(process.env.PLATFORM_SNAPSHOT_DEFAULT_LIMIT || 48);
const OZON_OPPORTUNITY_REFRESH_INTERVAL_MS = Number(process.env.OZON_OPPORTUNITY_REFRESH_INTERVAL_MS || 24 * 60 * 60 * 1000);
const OZON_OPPORTUNITY_DEFAULT_LIMIT = Number(process.env.OZON_OPPORTUNITY_DEFAULT_LIMIT || 80);
const GEO_BLUE_OCEAN_OUTPUT_ROOT = process.env.GEO_BLUE_OCEAN_OUTPUT_ROOT || path.resolve(__dirname, "../ozon-blue-ocean/outputs/daily");
const GEO_BLUE_OCEAN_SCORED_FILE = process.env.GEO_BLUE_OCEAN_SCORED_FILE || "";
const MYERP_API_BASE_URL = (process.env.MYERP_API_BASE_URL || "https://api.jizhangerp.com").replace(/\/$/, "");
const MYERP_API_TOKEN = String(process.env.MYERP_API_TOKEN || "").trim().replace(/^Bearer\s+/i, "");
const MYERP_PLATFORM_PERIOD = process.env.MYERP_PLATFORM_PERIOD || "monthly";
const MYERP_PLATFORM_SYNC_PAGES = Math.min(20, Math.max(1, Number(process.env.MYERP_PLATFORM_SYNC_PAGES || 5)));
const MYERP_PLATFORM_SYNC_MAX_REQUESTS = Math.min(1000, Math.max(50, Number(process.env.MYERP_PLATFORM_SYNC_MAX_REQUESTS || 400)));
const DATABASE_URL = process.env.DATABASE_URL || "";
const INITIAL_USERS = process.env.INITIAL_USERS || "";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString("hex");
const AUTH_COOKIE = "ozon_auth";
const AUTH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// -----------------------------------------------------------
// 版本号：以 git 短 hash + 当前启动时间为准。前端读取 /api/version
// -----------------------------------------------------------
function detectBuildVersion() {
  return process.env.BUILD_VERSION || "v1.1.0-test";
}
const BUILD_VERSION = detectBuildVersion();
const BUILD_TIME = new Date().toISOString();

// RUB → CNY 转换工具
function rubToCny(rub) {
  const v = Number(rub);
  if (!Number.isFinite(v)) return null;
  return Math.round(v * RUB_CNY_RATE * 100) / 100;  // 保留两位小数
}
function formatCny(rub) {
  const cny = rubToCny(rub);
  return cny != null ? `¥${cny.toFixed(2)}` : "—";
}

const OZON_CATEGORY_ZH_RULES = [
  [/красот|космет|макияж|уход|парфюм|духи|волос|ногт|ресниц|бров|beauty|cosmetic|makeup|skin|hair|nail|perfume/i, "美妆个护"],
  [/одежд|бель[её]|обув|сумк|аксессуар|рюкзак|кошел|рем[её]н|шапк|перчат|fashion|apparel|clothing|shoe|bag|backpack|accessor/i, "服饰鞋包"],
  [/дом|мебел|интерьер|декор|посуд|кухн|текстил|ковр|свет|хранен|ванн|home|furniture|kitchen|decor|storage|bath|household/i, "家居家装"],
  [/спорт|туризм|отдых|рыбал|велосипед|фитнес|тренаж|sport|fitness|outdoor|cycling|fishing|camping/i, "运动户外"],
  [/дет|малыш|игруш|школ|канцеляр|пелен|коляск|baby|kid|toy|school|stationery/i, "母婴玩具"],
  [/электрон|компьют|телефон|смартфон|ноутбук|планшет|кабел|заряд|наушник|electronic|computer|phone|mobile|digital|tablet|cable|charger|headphone/i, "手机数码"],
  [/авто|мото|запчаст|шины|инструмент|ремонт|строител|сад|дач|auto|car|motor|tool|garden|hardware|repair/i, "汽摩五金"],
  [/продукт|еда|напит|кофе|чай|сладост|бакале|food|drink|coffee|tea|grocery|snack/i, "食品饮料"],
  [/зоотовар|животн|кошк|собак|питомц|аквариум|pet|cat|dog|aquarium/i, "宠物用品"],
  [/книг|хобби|творчеств|музык|канцтовар|book|hobby|music|office|creative/i, "图书文娱"],
  [/аптек|здоров|медицин|витамин|ортопед|health|medical|vitamin|pharmacy/i, "健康保健"],
];

const OZON_CATEGORY_SEARCH_RULES = [
  [/住宅|花园|家居|家装|家具|厨房|收纳|house|home|garden/i, ["товары для дома", "для сада", "хранение вещей"]],
  [/服装|服饰|鞋|包|内衣|clothing|fashion|apparel/i, ["одежда", "женская одежда", "мужская одежда"]],
  [/美容|卫生|美妆|个护|beauty|cosmetic/i, ["красота и здоровье", "косметика", "уход за кожей"]],
  [/建筑|装修|五金|工具|repair|hardware|tools/i, ["строительство и ремонт", "инструменты", "товары для ремонта"]],
  [/食品|饮料|零食|food|drink|grocery/i, ["продукты питания", "напитки", "сладости"]],
  [/电子|手机|数码|电脑|electronic|phone|computer/i, ["электроника", "смартфон", "аксессуары для телефона"]],
  [/汽车|摩托|汽摩|auto|car|motor/i, ["автотовары", "аксессуары для автомобиля", "мототовары"]],
  [/母婴|玩具|儿童|baby|kid|toy/i, ["детские товары", "игрушки", "товары для малышей"]],
  [/运动|户外|sport|outdoor|fitness/i, ["спорт и отдых", "товары для фитнеса", "туризм"]],
  [/宠物|pet|cat|dog/i, ["товары для животных", "для кошек", "для собак"]],
  [/图书|办公|文具|book|office|stationery/i, ["книги", "канцтовары", "товары для офиса"]],
  [/健康|保健|医药|health|medical/i, ["товары для здоровья", "витамины", "аптека"]],
];

function hasCyrillic(text = "") {
  return /[\u0400-\u04FF]/.test(String(text || ""));
}

function categorySearchTerms(rawName = "", zhName = "", categoryPath = "") {
  const source = [rawName, zhName, categoryPath].filter(Boolean).join(" / ");
  const terms = [];
  for (const [pattern, values] of OZON_CATEGORY_SEARCH_RULES) {
    if (pattern.test(source)) terms.push(...values);
  }
  for (const part of String(source || "").split(/\s*[/›»>]\s*/).map((item) => item.trim()).filter(Boolean)) {
    if (hasCyrillic(part) || /^[A-Za-z][A-Za-z0-9\s&-]{2,}$/.test(part)) terms.push(part);
  }
  if (!terms.length && source.trim()) terms.push(source.trim());
  return [...new Set(terms)].slice(0, 4);
}

function categoryNameZh(rawName = "", categoryId = "") {
  const clean = String(rawName || "").replace(/\s*>\s*/g, " / ").trim();
  if (!clean) return categoryId ? `未分类 ${categoryId}` : "未分类";
  const parts = clean.split(/\s*[/›»>]\s*/).filter(Boolean);
  const matched = parts.map((part) => {
    const hit = OZON_CATEGORY_ZH_RULES.find(([pattern]) => pattern.test(part));
    return hit ? hit[1] : "";
  }).filter(Boolean);
  if (matched.length) return [...new Set(matched)].slice(0, 2).join(" / ");
  if (!hasCyrillic(clean) && /[\u4e00-\u9fa5]/.test(clean)) return clean;
  return categoryId ? `未翻译类目 ${categoryId}` : "未翻译类目";
}

const app = express();
const jobs = new Map();
const aiImageActiveByUser = new Map();
const db = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;
let browserContext = null;
let browserOpening = null;
let currentBrowserHeadless = false;

// --- 路由保护与 SPA 支持 ---
const isPublicPath = (path) => {
  const publicPaths = ["/login", "/api/auth/login", "/api/auth/status", "/api/version"];
  if (publicPaths.includes(path)) return true;
  // 允许加载 JS/CSS/图片等静态资源 + 扩展下载 + 上传目录
  if (path.startsWith("/static") || path.startsWith("/extension/") || path.startsWith("/uploads/") ||
      path.endsWith(".css") || path.endsWith(".ico") || path.endsWith(".js") || path.endsWith(".zip") ||
      /\.(png|jpg|jpeg|gif|svg)$/i.test(path)) return true;
  return false;
};

app.use(async (req, res, next) => {
  if (isPublicPath(req.path)) return next();
  const user = await getAuthenticatedUser(req);
  if (!user) {
    if (wantsJson(req) || req.path.startsWith("/api/")) return res.status(401).json({ success: false, error: "请先登录。" });
    // SPA 路由下，如果直接访问某个页面路径且未登录，跳回首页/登录
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || "/")}`);
  }
  req.user = user;
  next();
});

app.use(express.json({ limit: process.env.JSON_LIMIT || "120mb" }));
app.use((req, res, next) => {
  if (!enforceScopedWorkerAccess(req, res)) return;
  next();
});
app.use(express.static(PUBLIC_DIR));

/* ============================================================
   多店铺管理 API
   ============================================================ */

async function validateOzonCredentials(clientId, apiKey) {
  const response = await fetch(`${OZON_SELLER_BASE_URL}/v3/product/list`, {
    method: "POST",
    headers: {
      "Client-Id": String(clientId),
      "Api-Key": String(apiKey),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ filter: { visibility: "ALL" }, last_id: "", limit: 1 }),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { message: text }; }
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error || `Ozon 凭证验证失败 (${response.status})`);
    error.statusCode = response.status === 401 || response.status === 403 ? 400 : 502;
    throw error;
  }
  return payload;
}

function serializeStoreForFrontend(store) {
  const clientId = String(store?.client_id || "");
  return {
    id: store.id,
    name: store.name,
    active: store.active === true,
    client_id_masked: maskSecret(clientId),
    client_id_last4: clientId ? clientId.slice(-4) : "",
    watermark_enabled: store.watermark_enabled === true,
    watermark_text: store.watermark_text || "",
    ai_image_provider: store.ai_image_provider || AI_IMAGE_PROVIDER,
    ai_image_model: store.ai_image_model || "",
  };
}

function normalizeStoreAiProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  if (!provider) return "";
  return AI_IMAGE_PROVIDER_ORDER.includes(provider) ? provider : "";
}

app.get("/api/seller/shops", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const result = await db.query(
      "SELECT id, name, client_id, active, watermark_enabled, watermark_text, ai_image_provider, ai_image_model FROM app_stores WHERE user_id = $1 ORDER BY updated_at DESC",
      [req.user.id]
    );
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, shops: result.rows.map(serializeStoreForFrontend) });
  } catch (error) { next(error); }
});

app.post("/api/seller/shops", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const { name, client_id, api_key } = req.body;
    const watermarkEnabled = req.body?.watermark_enabled === true;
    const watermarkText = String(req.body?.watermark_text || name || "逐梦ERP").trim().slice(0, 80);
    const aiImageProvider = normalizeStoreAiProvider(req.body?.ai_image_provider);
    const aiImageModel = String(req.body?.ai_image_model || "").trim().slice(0, 80);
    if (!name || !client_id || !api_key) {
      return res.status(400).json({ success: false, error: "请填写完整信息" });
    }
    await validateOzonCredentials(client_id, api_key);
    const result = await db.query(
      `INSERT INTO app_stores (user_id, name, client_id, api_key, watermark_enabled, watermark_text, ai_image_provider, ai_image_model)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, client_id) DO UPDATE
         SET name = $2, api_key = $4, active = TRUE, watermark_enabled = $5, watermark_text = $6,
             ai_image_provider = $7, ai_image_model = $8, updated_at = now()
       RETURNING id, name, client_id, active, watermark_enabled, watermark_text, ai_image_provider, ai_image_model`,
      [req.user.id, name, client_id, api_key, watermarkEnabled, watermarkText, aiImageProvider, aiImageModel]
    );
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, shop: serializeStoreForFrontend(result.rows[0]) });
  } catch (error) { next(error); }
});

app.patch("/api/seller/shops/:id/settings", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const watermarkEnabled = req.body?.watermark_enabled === true;
    const watermarkText = String(req.body?.watermark_text || "").trim().slice(0, 80);
    const aiImageProvider = normalizeStoreAiProvider(req.body?.ai_image_provider);
    const aiImageModel = String(req.body?.ai_image_model || "").trim().slice(0, 80);
    const result = await db.query(
      `UPDATE app_stores
          SET watermark_enabled = $1,
              watermark_text = COALESCE(NULLIF($2, ''), name),
              ai_image_provider = $5,
              ai_image_model = $6,
              updated_at = now()
        WHERE id = $3 AND user_id = $4
        RETURNING id, name, client_id, active, watermark_enabled, watermark_text, ai_image_provider, ai_image_model`,
      [watermarkEnabled, watermarkText, req.params.id, req.user.id, aiImageProvider, aiImageModel],
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, error: "店铺不存在" });
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, shop: serializeStoreForFrontend(result.rows[0]) });
  } catch (error) { next(error); }
});

app.delete("/api/seller/shops/:id", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const result = await db.query(
      "UPDATE app_stores SET active = FALSE, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING id",
      [req.params.id, req.user.id],
    );
    if (!result.rowCount) return res.status(404).json({ success: false, error: "店铺不存在" });
    res.json({ success: true, deactivated: true });
  } catch (error) { next(error); }
});

app.post("/api/v1/plugin/tokens", requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const storeId = String(req.body?.storeId || req.body?.store_id || "").trim();
    if (!storeId) return res.status(400).json({ success: false, code: "VALIDATION_ERROR", error: "storeId 必填" });
    const store = await assertActiveStoreAccess(storeId, req.user.id, "id, name");
    const issued = createScopedWorkerToken(req.user.id, {
      storeId: store.id,
      scope: ["collector:submit", "worker:poll"],
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      success: true,
      code: "OK",
      data: {
        token: issued.token,
        tokenType: "Bearer",
        expiresIn: issued.expiresIn,
        scope: issued.payload.scope,
        storeId: store.id,
        storeName: store.name,
      },
      requestId: req.headers["x-request-id"] || crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      code: error.statusCode === 404 ? "STORE_NOT_FOUND" : "INTERNAL_ERROR",
      error: error.message,
      requestId: req.headers["x-request-id"] || crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    });
  }
});

// v2.1: 给 Chrome 插件用的"拿卖家 API 凭证"端点
// 严格校验: 仅返回当前用户对应 store 的凭证,且仅供插件采集使用
app.get("/api/extension/seller-credentials", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const storeId = String(req.query.store_id || "").trim();
    if (!storeId) return res.status(400).json({ success: false, error: "store_id 必填" });
    if (!ALLOW_LEGACY_EXTENSION_SELLER_CREDENTIALS) {
      return res.status(410).json({
        success: false,
        error: "插件直取 Ozon 凭证接口已关闭，请改用 /api/v1/plugin/tokens 短期 worker token。",
        code: "PLUGIN_CREDENTIALS_DISABLED",
      });
    }
    const store = await assertActiveStoreAccess(storeId, req.user.id, "id, name, client_id, api_key");
    res.setHeader("Cache-Control", "no-store");
    console.warn(`[extension-credentials] deprecated credential handoff user=${req.user.id} store=${store.id} client=${maskSecret(store.client_id)}`);
    res.json({
      success: true,
      deprecated: true,
      replacement: "/api/v1/plugin/tokens",
      storeId: store.id,
      storeName: store.name,
      clientId: store.client_id,
      apiKey: store.api_key,
      clientIdMasked: maskSecret(store.client_id),
      credentialExpiresIn: 0,
    });
  } catch (error) { next(error); }
});

/* ============================================================
   采集与找货 - 增强生产环境对齐逻辑
   ============================================================ */

app.post("/api/collect-items", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const requestedStoreId = String(req.body?.store_id || req.body?.storeId || "").split(",")[0].trim();
    let storeId = null;
    if (requestedStoreId) {
      const ownedStore = await db.query(`SELECT id FROM app_stores WHERE id=$1 AND user_id=$2 AND active=TRUE`, [requestedStoreId, req.user.id]);
      if (!ownedStore.rowCount) return res.status(404).json({ success: false, error: "店铺不存在、已停用或无权限" });
      storeId = ownedStore.rows[0].id;
    }
    const extensionItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (extensionItems.length) {
      const inserted = [];
      const skipped = [];
      for (const item of extensionItems) {
        const ozonSku = String(item.sku || item.product_id || item.offer_id || "").trim();
        const ozonUrl = String(item.ozon_url || item.source_url || (ozonSku ? `https://www.ozon.ru/product/${ozonSku}/` : ""));
        const exists = await db.query(
          `SELECT id, status FROM collect_items
           WHERE user_id = $1
             AND (($2 <> '' AND ozon_sku = $2) OR ($3 <> '' AND ozon_url = $3))
           LIMIT 1`,
          [req.user.id, ozonSku, ozonUrl],
        );
        if (exists.rowCount) {
          if (exists.rows[0].status !== "uploaded") {
            await db.query(
              `UPDATE collect_items SET
                 store_id=COALESCE($1,store_id), title=COALESCE(NULLIF($2,''),title),
                 main_image=COALESCE(NULLIF($3,''),main_image), images=CASE WHEN jsonb_array_length($4::jsonb)>0 THEN $4::jsonb ELSE images END,
                 price_rub=COALESCE($5,price_rub), brand=COALESCE(NULLIF($6,''),brand),
                 attributes=CASE WHEN $7::jsonb <> '{}'::jsonb THEN $7::jsonb ELSE attributes END,
                 status='scraped', note='',
                 status_log=COALESCE(status_log,'[]'::jsonb) || jsonb_build_array(jsonb_build_object('from',status,'to','scraped','reason','插件数据合并','at',now())),
                 updated_at=now() WHERE id=$8 AND user_id=$9`,
              [storeId, String(item.name || item.title || ""), String(item.image || item.main_image || ""), JSON.stringify(item.images || []), Number(item.price || item.price_rub || 0) || null, String(item.brand || ""), JSON.stringify(item.attributes || {}), exists.rows[0].id, req.user.id],
            );
          }
          skipped.push({ source: ozonSku || ozonUrl, reason: exists.rows[0].status === "uploaded" ? "已上架" : "已合并更新" });
          continue;
        }
        const result = await db.query(
          `INSERT INTO collect_items (
             user_id, store_id, source_type, source_value, ozon_url, ozon_sku,
             title, main_image, images, price_rub, brand, attributes, status
           ) VALUES ($1,$2,'extension',$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb,'scraped')
           RETURNING id, ozon_url, ozon_sku, status, created_at`,
          [
            req.user.id,
            storeId,
            ozonSku || ozonUrl,
            ozonUrl,
            ozonSku,
            String(item.name || item.title || ""),
            String(item.image || item.main_image || ""),
            JSON.stringify(item.images || []),
            Number(item.price || item.price_rub || 0) || null,
            String(item.brand || ""),
            JSON.stringify(item.attributes || {}),
          ],
        );
        inserted.push(result.rows[0]);
      }
      return res.json({
        success: true,
        inserted,
        skipped,
        insertedCount: inserted.length,
        skippedCount: skipped.length,
      });
    }

    const inputsText = String(req.body?.inputs || req.body?.text || "").trim();
    const parsed = parseCollectInputs(inputsText);
    if (!parsed.length) {
      return res.status(400).json({ success: false, error: "未识别到有效的 Ozon 链接或 SKU。" });
    }

    const inserted = [];
    const skipped = [];
    for (const row of parsed) {
      const exists = await db.query(
        `SELECT id, status, ozon_url FROM collect_items
         WHERE user_id = $1
           AND (($2 <> '' AND ozon_sku = $2) OR ($3 <> '' AND ozon_url = $3))
         LIMIT 1`,
        [req.user.id, row.ozonSku || "", row.ozonUrl || ""],
      );
      if (exists.rowCount) {
        const existing = exists.rows[0];
        if (["failed", "ignored"].includes(existing.status)) {
          const restored = await db.query(
            `UPDATE collect_items SET store_id=COALESCE($1,store_id), status='pending', note='',
               status_log=COALESCE(status_log,'[]'::jsonb) || jsonb_build_array(jsonb_build_object('from',status,'to','pending','reason','重新采集','at',now())),
               updated_at=now() WHERE id=$2 AND user_id=$3 RETURNING id, ozon_url`,
            [storeId, existing.id, req.user.id],
          );
          inserted.push(restored.rows[0]);
        } else {
          skipped.push({ source: row.sourceValue, reason: existing.status === "uploaded" ? "已上架" : "已存在" });
        }
        continue;
      }
      const r = await db.query(
        `INSERT INTO collect_items (user_id, store_id, source_type, source_value, ozon_url, ozon_sku, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending') 
         ON CONFLICT DO NOTHING RETURNING id, ozon_url`,
        [req.user.id, storeId, row.sourceType, row.sourceValue, row.ozonUrl, row.ozonSku]
      );
      if (r.rows[0]) inserted.push(r.rows[0]);
    }

    // 采集箱只采 Ozon 信息；不启用 1688 搜图，避免进入已冻结的单品找货链路。
    if (inserted.length) {
      const jobResult = await db.query(
        `INSERT INTO app_jobs (id, user_id, store_id, kind, status, phase, total, processed, payload)
         VALUES (gen_random_uuid(), $1, $2, 'run', 'queued', '等待采集端领取', $3, 0, $4) RETURNING id`,
        [req.user.id, storeId, inserted.length, JSON.stringify({
          urls: inserted.map((item) => item.ozon_url),
          urlRows: inserted.map((item, index) => ({ url: item.ozon_url, sourceRow: index + 1, collectId: item.id })),
          options: { enable1688: false, enableAI: false, collectionOnly: true }
        })]
      );
      await db.query(
        `UPDATE collect_items SET linked_job_id=$1,
           status_log=COALESCE(status_log,'[]'::jsonb) || jsonb_build_array(jsonb_build_object('from',status,'to',status,'reason','创建采集任务','job_id',$1,'at',now())),
           updated_at=now() WHERE user_id=$2 AND id=ANY($3::uuid[])`,
        [jobResult.rows[0].id, req.user.id, inserted.map((item) => item.id)],
      );
    }

    res.json({ success: true, inserted, skipped, insertedCount: inserted.length, skippedCount: skipped.length });
  } catch (error) { next(error); }
});


class RowSkipError extends Error {
  constructor(message) {
    super(message);
    this.name = "RowSkipError";
    this.rowSkip = true;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = decodeURIComponent(part.slice(0, index).trim());
    const value = decodeURIComponent(part.slice(index + 1).trim());
    cookies[key] = value;
  }
  return cookies;
}

function createAuthSignature(userId, expiresAt) {
  return crypto.createHmac("sha256", AUTH_SECRET).update(`${userId}.${expiresAt}`).digest("base64url");
}

function createAuthToken(userId) {
  const expiresAt = Date.now() + AUTH_MAX_AGE_MS;
  return `${userId}.${expiresAt}.${createAuthSignature(userId, expiresAt)}`;
}

function createScopedWorkerToken(userId, options = {}) {
  const ttlMs = Math.max(60 * 1000, Math.min(Number(options.ttlMs || PLUGIN_WORKER_TOKEN_TTL_MS), 60 * 60 * 1000));
  const payload = {
    sub: String(userId),
    exp: Date.now() + ttlMs,
    type: "plugin-worker",
    scope: Array.isArray(options.scope) && options.scope.length
      ? options.scope.map((value) => String(value)).slice(0, 8)
      : ["collector:submit", "worker:poll"],
    storeId: options.storeId ? String(options.storeId) : "",
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", AUTH_SECRET).update(`scoped.${body}`).digest("base64url");
  return { token: `scoped.${body}.${signature}`, payload, expiresIn: Math.floor(ttlMs / 1000) };
}

function verifyScopedWorkerToken(token) {
  const [, body, signature] = String(token || "").split(".");
  if (!body || !signature) return null;
  const expected = crypto.createHmac("sha256", AUTH_SECRET).update(`scoped.${body}`).digest("base64url");
  if (!safeEqual(signature, expected)) return null;
  let payload = null;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (!payload?.sub || Number(payload.exp || 0) < Date.now() || payload.type !== "plugin-worker") return null;
  return payload;
}

function maskSecret(value, visible = 4) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= visible * 2) return `${text.slice(0, 1)}***`;
  return `${text.slice(0, visible)}***${text.slice(-visible)}`;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.isBuffer(left) ? left : Buffer.from(String(left));
  const rightBuffer = Buffer.isBuffer(right) ? right : Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function getAuthenticatedUser(req) {
  const bearer = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const token = bearer || parseCookies(req)[AUTH_COOKIE] || "";
  if (token.startsWith("scoped.")) {
    const payload = verifyScopedWorkerToken(token);
    if (!payload) return null;
    if (db) {
      const result = await db.query(
        "SELECT id, username, display_name, role FROM app_users WHERE id = $1 AND active = TRUE",
        [payload.sub],
      );
      const user = result.rows[0] || null;
      return user ? { ...user, tokenType: payload.type, tokenScope: payload.scope || [], tokenStoreId: payload.storeId || "" } : null;
    }
    if (!APP_PASSWORD || payload.sub !== "legacy") return null;
    return { id: "legacy", username: "admin", display_name: "Admin", role: "admin", tokenType: payload.type, tokenScope: payload.scope || [], tokenStoreId: payload.storeId || "" };
  }
  const [userId, expiresAtText, signature] = token.split(".");
  const expiresAt = Number(expiresAtText);
  if (!userId || !Number.isFinite(expiresAt) || expiresAt < Date.now() || !signature) return null;
  if (!safeEqual(signature, createAuthSignature(userId, expiresAt))) return null;

  if (db) {
    const result = await db.query(
      "SELECT id, username, display_name, role FROM app_users WHERE id = $1 AND active = TRUE",
      [userId],
    );
    return result.rows[0] || null;
  }

  if (!APP_PASSWORD || userId !== "legacy") return null;
  return { id: "legacy", username: "admin", display_name: "Admin", role: "admin" };
}

async function isAuthenticated(req) {
  return Boolean(await getAuthenticatedUser(req));
}

function isScopedWorkerUser(user) {
  return user?.tokenType === "plugin-worker";
}

function hasScopedWorkerScope(user, scope) {
  return Array.isArray(user?.tokenScope) && user.tokenScope.includes(scope);
}

function enforceScopedWorkerAccess(req, res) {
  if (!isScopedWorkerUser(req.user)) return true;
  const pathName = req.path || "";
  const method = String(req.method || "GET").toUpperCase();
  const tokenStoreId = String(req.user.tokenStoreId || "").trim();

  if (method === "POST" && pathName === "/api/collect-items" && hasScopedWorkerScope(req.user, "collector:submit")) {
    const requestedStoreId = String(req.body?.store_id || req.body?.storeId || "").split(",")[0].trim();
    if (!tokenStoreId) {
      res.status(403).json({ success: false, code: "TOKEN_STORE_REQUIRED", error: "插件 token 缺少店铺作用域。" });
      return false;
    }
    if (requestedStoreId && requestedStoreId !== tokenStoreId) {
      res.status(403).json({ success: false, code: "STORE_SCOPE_DENIED", error: "插件 token 无权访问该店铺。" });
      return false;
    }
    if (req.body && typeof req.body === "object") req.body.store_id = tokenStoreId;
    return true;
  }

  const workerPathAllowed =
    pathName === "/api/worker/status" ||
    pathName === "/api/worker/heartbeat" ||
    pathName === "/api/worker/jobs/next" ||
    /^\/api\/worker\/jobs\/[^/]+\/(?:progress|complete)$/.test(pathName);
  if (workerPathAllowed && hasScopedWorkerScope(req.user, "worker:poll")) return true;

  res.status(403).json({
    success: false,
    code: "SCOPED_TOKEN_FORBIDDEN",
    error: "插件 token 只能访问采集提交和 worker 队列接口。",
  });
  return false;
}

function isSecureRequest(req) {
  return req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}

function setAuthCookie(req, res, userId) {
  const parts = [
    `${AUTH_COOKIE}=${encodeURIComponent(createAuthToken(userId))}`,
    "Path=/",
    `Max-Age=${Math.floor(AUTH_MAX_AGE_MS / 1000)}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isSecureRequest(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearAuthCookie(req, res) {
  const parts = [
    `${AUTH_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isSecureRequest(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function wantsJson(req) {
  return req.path.startsWith("/api/") || String(req.headers.accept || "").includes("application/json");
}

async function requireAuth(req, res, next) {
  try {
    const user = await getAuthenticatedUser(req);
    if (user) {
      req.user = user;
      next();
      return;
    }
    if (wantsJson(req)) {
      res.status(401).json({ success: false, error: "请先登录。" });
      return;
    }
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || "/")}`);
  } catch (error) {
    next(error);
  }
}

async function assertActiveStoreAccess(storeId, userId, columns = "id, name") {
  if (!db) {
    const error = new Error("服务端未配置 DATABASE_URL。");
    error.statusCode = 503;
    throw error;
  }
  const result = await db.query(
    `SELECT ${columns} FROM app_stores WHERE id = $1 AND user_id = $2 AND active = TRUE`,
    [storeId, userId],
  );
  if (!result.rows[0]) {
    const error = new Error("店铺不存在、已停用或无权限");
    error.statusCode = 404;
    throw error;
  }
  return result.rows[0];
}

function buildLoginHtml(message = "") {
  const configMessage = db || APP_PASSWORD ? "" : "服务端还没有设置登录密码，请先配置 APP_PASSWORD。";
  const usernameField = db ? `
      <label for="username">账号</label>
      <input id="username" name="username" type="text" autocomplete="username" autofocus />` : "";
  const passwordAutofocus = db ? "" : " autofocus";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>登录 · Ozon-1688</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f5f7fb;
      color: #172033;
    }
    main {
      width: min(420px, calc(100vw - 32px));
      padding: 28px;
      background: #fff;
      border: 1px solid #dce3ef;
      border-radius: 8px;
      box-shadow: 0 18px 48px rgba(31, 45, 61, 0.12);
    }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p { margin: 0 0 22px; color: #5b687a; line-height: 1.5; }
    label { display: block; margin-bottom: 8px; font-weight: 650; }
    input {
      width: 100%;
      height: 42px;
      padding: 0 12px;
      border: 1px solid #c7d2e1;
      border-radius: 6px;
      font: inherit;
    }
    button {
      width: 100%;
      height: 42px;
      margin-top: 16px;
      border: 0;
      border-radius: 6px;
      background: #0b63f6;
      color: #fff;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    .error {
      display: none;
      margin-top: 14px;
      color: #b42318;
      line-height: 1.4;
    }
    .error.visible { display: block; }
  </style>
</head>
<body>
  <main>
    <h1>Ozon-1688 登录</h1>
    <p>${db ? "请输入账号和密码后继续。" : "请输入访问密码后继续。"}</p>
    <form id="loginForm">
${usernameField}
      <label for="password">密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password"${passwordAutofocus} />
      <button type="submit">登录</button>
      <div id="error" class="error ${message || configMessage ? "visible" : ""}">${escapeHtmlForFile(message || configMessage)}</div>
    </form>
  </main>
  <script>
    const form = document.querySelector("#loginForm");
    const username = document.querySelector("#username");
    const password = document.querySelector("#password");
    const error = document.querySelector("#error");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.classList.remove("visible");
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username?.value || "", password: password.value }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        error.textContent = data.error || "登录失败。";
        error.classList.add("visible");
        return;
      }
      const params = new URLSearchParams(location.search);
      location.href = params.get("next") || "/";
    });
  </script>
</body>
</html>`;
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const key = await promisify(crypto.scrypt)(String(password), salt, 64);
  return `scrypt$${salt}$${Buffer.from(key).toString("base64url")}`;
}

async function verifyPassword(password, passwordHash) {
  const [algorithm, salt, stored] = String(passwordHash || "").split("$");
  if (algorithm !== "scrypt" || !salt || !stored) return false;
  const key = await promisify(crypto.scrypt)(String(password), salt, 64);
  return safeEqual(Buffer.from(stored, "base64url"), Buffer.from(key));
}

async function initDatabase() {
  if (!db) return;
  try {
    // 1. 基础表结构
    await db.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'user',
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_login_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS app_stores (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        client_id TEXT NOT NULL,
        api_key TEXT NOT NULL,
        watermark_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        watermark_text TEXT NOT NULL DEFAULT '',
        ai_image_provider TEXT NOT NULL DEFAULT '',
        ai_image_model TEXT NOT NULL DEFAULT '',
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(user_id, client_id)
      );

      CREATE TABLE IF NOT EXISTS app_jobs (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT '',
        total INTEGER NOT NULL DEFAULT 0,
        processed INTEGER NOT NULL DEFAULT 0,
        source_total INTEGER NOT NULL DEFAULT 0,
        source_start_row INTEGER NOT NULL DEFAULT 1,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        logs JSONB NOT NULL DEFAULT '[]'::jsonb,
        results JSONB NOT NULL DEFAULT '[]'::jsonb,
        error TEXT NOT NULL DEFAULT '',
        download_url TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_downloaded_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS collect_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL DEFAULT 'ozon_url',
        source_value TEXT NOT NULL,
        ozon_url TEXT NOT NULL DEFAULT '',
        ozon_sku TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        main_image TEXT NOT NULL DEFAULT '',
        images JSONB NOT NULL DEFAULT '[]'::jsonb,
        price_cny NUMERIC(12,2),
        seller TEXT NOT NULL DEFAULT '',
        brand TEXT NOT NULL DEFAULT '',
        attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'pending',
        note TEXT NOT NULL DEFAULT '',
        linked_job_id UUID REFERENCES app_jobs(id) ON DELETE SET NULL,
        linked_offer_id TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS app_products (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        store_id UUID NOT NULL REFERENCES app_stores(id) ON DELETE CASCADE,
        offer_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        image TEXT NOT NULL DEFAULT '',
        price NUMERIC(12,2),
        stock INTEGER NOT NULL DEFAULT 0,
        purchase_price_cny NUMERIC(12,2),
        brand TEXT DEFAULT '',
        country_of_origin TEXT DEFAULT '',
        description TEXT DEFAULT '',
        status TEXT DEFAULT 'UNKNOWN',
        category_name TEXT DEFAULT '',
        weight INTEGER DEFAULT 0,
        depth INTEGER DEFAULT 0,
        width INTEGER DEFAULT 0,
        height INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(store_id, offer_id)
      );

      -- 物理补全尺寸、重量、业务字段 (v0.3.1 全字段)
      ALTER TABLE app_products ADD COLUMN IF NOT EXISTS weight INTEGER DEFAULT 0;
      ALTER TABLE app_products ADD COLUMN IF NOT EXISTS depth INTEGER DEFAULT 0;
      ALTER TABLE app_products ADD COLUMN IF NOT EXISTS width INTEGER DEFAULT 0;
      ALTER TABLE app_products ADD COLUMN IF NOT EXISTS height INTEGER DEFAULT 0;
      ALTER TABLE app_products ADD COLUMN IF NOT EXISTS dimension_unit TEXT DEFAULT 'mm';
      ALTER TABLE app_products ADD COLUMN IF NOT EXISTS weight_unit TEXT DEFAULT 'g';
      ALTER TABLE app_products ADD COLUMN IF NOT EXISTS product_id BIGINT;
      ALTER TABLE app_products ADD COLUMN IF NOT EXISTS sku BIGINT;
      ALTER TABLE app_products ADD COLUMN IF NOT EXISTS model_id BIGINT;
      ALTER TABLE app_products ADD COLUMN IF NOT EXISTS currency_code TEXT DEFAULT 'RUB';
      ALTER TABLE app_products ADD COLUMN IF NOT EXISTS min_price NUMERIC(12,2);
      ALTER TABLE app_products ADD COLUMN IF NOT EXISTS old_price NUMERIC(12,2);
      ALTER TABLE app_products ADD COLUMN IF NOT EXISTS vat TEXT DEFAULT '0';
      ALTER TABLE app_products ADD COLUMN IF NOT EXISTS barcode TEXT DEFAULT '';
      ALTER TABLE app_products ADD COLUMN IF NOT EXISTS images JSONB DEFAULT '[]'::jsonb;
      ALTER TABLE app_products ADD COLUMN IF NOT EXISTS status_name TEXT DEFAULT '';
      ALTER TABLE app_products ADD COLUMN IF NOT EXISTS visibility_details JSONB DEFAULT '{}'::jsonb;
      ALTER TABLE app_products ADD COLUMN IF NOT EXISTS price_index TEXT DEFAULT '';
      ALTER TABLE app_products ADD COLUMN IF NOT EXISTS updated_at_ozon TIMESTAMPTZ;
      ALTER TABLE app_products ADD COLUMN IF NOT EXISTS stocks_json JSONB DEFAULT '[]'::jsonb;   -- v0.3.3 分仓库存原始数组
      ALTER TABLE app_products ADD COLUMN IF NOT EXISTS source_url_1688 TEXT DEFAULT '';
      ALTER TABLE app_products ADD COLUMN IF NOT EXISTS description_category_id BIGINT;   -- v0.6.1 Ozon 类目 ID
      ALTER TABLE app_products ADD COLUMN IF NOT EXISTS type_id BIGINT;                    -- v0.6.1 Ozon 类目类型 ID

      CREATE INDEX IF NOT EXISTS idx_app_products_store ON app_products(store_id, status);
      CREATE INDEX IF NOT EXISTS idx_app_products_updated ON app_products(updated_at DESC);

      CREATE TABLE IF NOT EXISTS app_exchange_rates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        base_currency TEXT NOT NULL DEFAULT 'RUB',
        quote_currency TEXT NOT NULL DEFAULT 'CNY',
        rate NUMERIC(12,6) NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        effective_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_exchange_rates_pair_effective
        ON app_exchange_rates(base_currency, quote_currency, effective_at DESC);

      CREATE TABLE IF NOT EXISTS app_product_cost_audit (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        store_id UUID NOT NULL REFERENCES app_stores(id) ON DELETE CASCADE,
        product_id UUID REFERENCES app_products(id) ON DELETE SET NULL,
        offer_id TEXT NOT NULL,
        field_name TEXT NOT NULL DEFAULT 'purchase_price_cny',
        old_value NUMERIC(12,2),
        new_value NUMERIC(12,2),
        reason TEXT NOT NULL DEFAULT '',
        changed_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_product_cost_audit_user_store_created
        ON app_product_cost_audit(user_id, store_id, created_at DESC);


    `);

    // 2. 字段扩展 (DDL 迁移)
    await db.query(`
      ALTER TABLE app_stores ADD COLUMN IF NOT EXISTS watermark_enabled BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE app_stores ADD COLUMN IF NOT EXISTS watermark_text TEXT NOT NULL DEFAULT '';
      ALTER TABLE app_stores ADD COLUMN IF NOT EXISTS ai_image_provider TEXT NOT NULL DEFAULT '';
      ALTER TABLE app_stores ADD COLUMN IF NOT EXISTS ai_image_model TEXT NOT NULL DEFAULT '';

      ALTER TABLE collect_items ADD COLUMN IF NOT EXISTS price_rub NUMERIC(12,2);
      ALTER TABLE collect_items ADD COLUMN IF NOT EXISTS weight INTEGER;
      ALTER TABLE collect_items ADD COLUMN IF NOT EXISTS depth INTEGER;
      ALTER TABLE collect_items ADD COLUMN IF NOT EXISTS width INTEGER;
      ALTER TABLE collect_items ADD COLUMN IF NOT EXISTS height INTEGER;
      ALTER TABLE collect_items ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES app_stores(id) ON DELETE SET NULL;
      ALTER TABLE collect_items ADD COLUMN IF NOT EXISTS status_log JSONB DEFAULT '[]'::jsonb;
      ALTER TABLE collect_items ADD COLUMN IF NOT EXISTS source_url_1688 TEXT NOT NULL DEFAULT '';
      ALTER TABLE collect_items ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';

      UPDATE collect_items SET status='failed', note='未关联采集任务，请点击重新采集',
        status_log=COALESCE(status_log,'[]'::jsonb) || jsonb_build_array(jsonb_build_object('from','pending','to','failed','reason','启动时发现孤立任务','at',now())),
        updated_at=now()
      WHERE status='pending' AND linked_job_id IS NULL AND created_at < now() - interval '5 minutes';

      UPDATE collect_items c SET status='failed',
        note=COALESCE(NULLIF(j.error,''), NULLIF(j.phase,''), '采集任务未完成'),
        status_log=COALESCE(c.status_log,'[]'::jsonb) || jsonb_build_array(jsonb_build_object('from','pending','to','failed','reason','关联任务已结束','job_id',j.id,'at',now())),
        updated_at=now()
      FROM app_jobs j
      WHERE c.linked_job_id=j.id AND c.status='pending' AND j.status IN ('error','canceled','done');

      ALTER TABLE app_jobs ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES app_stores(id) ON DELETE SET NULL;
    `);

    // 3. 关联业务表
    await db.query(`
      CREATE TABLE IF NOT EXISTS order_notes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        posting_number TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(user_id, posting_number)
      );

      CREATE TABLE IF NOT EXISTS order_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id UUID NOT NULL REFERENCES app_stores(id) ON DELETE CASCADE,
        posting_number TEXT NOT NULL,
        sku TEXT NOT NULL,
        offer_id TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        price_rub NUMERIC(12,2),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(store_id, posting_number, sku)
      );

      CREATE TABLE IF NOT EXISTS app_order_ship_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        store_id UUID NOT NULL REFERENCES app_stores(id) ON DELETE CASCADE,
        posting_number TEXT NOT NULL,
        packages JSONB NOT NULL DEFAULT '[]'::jsonb,
        status TEXT NOT NULL DEFAULT 'processing',
        error TEXT NOT NULL DEFAULT '',
        ozon_response JSONB NOT NULL DEFAULT '{}'::jsonb,
        completed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(store_id, posting_number)
      );

      CREATE TABLE IF NOT EXISTS app_order_cancel_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        store_id UUID NOT NULL REFERENCES app_stores(id) ON DELETE CASCADE,
        posting_number TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        dry_run BOOLEAN NOT NULL DEFAULT true,
        status TEXT NOT NULL DEFAULT 'simulated',
        ozon_called BOOLEAN NOT NULL DEFAULT false,
        request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        error TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS app_order_costs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        store_id UUID NOT NULL REFERENCES app_stores(id) ON DELETE CASCADE,
        posting_number TEXT NOT NULL,
        offer_id TEXT NOT NULL DEFAULT '',
        source_url_1688 TEXT NOT NULL DEFAULT '',
        outbound_cost_cny NUMERIC(12,2) NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT '',
        changed_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(store_id, posting_number)
      );

      CREATE TABLE IF NOT EXISTS app_order_cache (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        store_id UUID NOT NULL REFERENCES app_stores(id) ON DELETE CASCADE,
        posting_number TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT '',
        display_status TEXT NOT NULL DEFAULT '',
        substatus TEXT NOT NULL DEFAULT '',
        in_process_at TIMESTAMPTZ,
        shipment_date TIMESTAMPTZ,
        delivering_date TIMESTAMPTZ,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(store_id, posting_number)
      );

      ALTER TABLE app_order_ship_events ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'processing';
      ALTER TABLE app_order_ship_events ADD COLUMN IF NOT EXISTS error TEXT NOT NULL DEFAULT '';
      ALTER TABLE app_order_costs ADD COLUMN IF NOT EXISTS source_url_1688 TEXT NOT NULL DEFAULT '';
      ALTER TABLE app_order_costs ADD COLUMN IF NOT EXISTS outbound_cost_cny NUMERIC(12,2) NOT NULL DEFAULT 0;
      ALTER TABLE app_order_ship_events ADD COLUMN IF NOT EXISTS ozon_response JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE app_order_ship_events ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
      ALTER TABLE app_order_ship_events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
      ALTER TABLE app_order_cache ADD COLUMN IF NOT EXISTS display_status TEXT NOT NULL DEFAULT '';
      ALTER TABLE app_order_cancel_events ADD COLUMN IF NOT EXISTS request_payload JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE app_order_cancel_events ADD COLUMN IF NOT EXISTS response_payload JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE app_order_cancel_events ADD COLUMN IF NOT EXISTS error TEXT NOT NULL DEFAULT '';

      CREATE TABLE IF NOT EXISTS app_top_lists (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        sku TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL DEFAULT '',
        main_image TEXT NOT NULL DEFAULT '',
        price_rub NUMERIC(14,2),
        monthly_sales INTEGER NOT NULL DEFAULT 0,
        review_count INTEGER NOT NULL DEFAULT 0,
        seller_count INTEGER,
        category_id TEXT NOT NULL DEFAULT '',
        category_name TEXT NOT NULL DEFAULT '',
        strategy_type TEXT NOT NULL DEFAULT 'hot',
        ozon_url TEXT NOT NULL DEFAULT '',
        seller_name TEXT NOT NULL DEFAULT '',
        origin_country TEXT NOT NULL DEFAULT '',
        delivery_text TEXT NOT NULL DEFAULT '',
        is_china_origin BOOLEAN NOT NULL DEFAULT FALSE,
        china_confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
        china_evidence TEXT NOT NULL DEFAULT '',
        source_name TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL DEFAULT '',
        source_captured_at TIMESTAMPTZ,
        source_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS app_china_sellers (
        seller_name TEXT PRIMARY KEY,
        identified_method TEXT NOT NULL DEFAULT 'manual',
        is_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
        reliability_score NUMERIC(5,4) NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT '',
        updated_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS app_platform_categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_name TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL DEFAULT '',
        period TEXT NOT NULL DEFAULT 'monthly',
        snapshot_date DATE,
        category_id TEXT NOT NULL DEFAULT '',
        category_parent_id TEXT NOT NULL DEFAULT '',
        category_name TEXT NOT NULL DEFAULT '',
        category_name_zh TEXT NOT NULL DEFAULT '',
        category_path TEXT NOT NULL DEFAULT '',
        level INTEGER NOT NULL DEFAULT 1,
        sales_units NUMERIC(18,2) NOT NULL DEFAULT 0,
        sales_amount_rub NUMERIC(18,2) NOT NULL DEFAULT 0,
        gmv_growth NUMERIC(10,4),
        avg_price_rub NUMERIC(14,2),
        price_growth NUMERIC(10,4),
        sellers NUMERIC(18,2),
        brands NUMERIC(18,2),
        brand_rate NUMERIC(10,4),
        leader_share NUMERIC(10,4),
        fbs_rate NUMERIC(10,4),
        buyout_rate NUMERIC(10,4),
        return_rate NUMERIC(10,4),
        source_captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        source_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(source_name, period, snapshot_date, category_id)
      );

      CREATE TABLE IF NOT EXISTS app_auto_listing_settings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        store_id UUID NOT NULL REFERENCES app_stores(id) ON DELETE CASCADE,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        daily_quota INTEGER NOT NULL DEFAULT 30,
        min_profit_rate NUMERIC(8,4) NOT NULL DEFAULT 0.20,
        max_ai_cost_cny NUMERIC(12,2) NOT NULL DEFAULT 50,
        submit_to_ozon BOOLEAN NOT NULL DEFAULT FALSE,
        rules JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(user_id, store_id)
      );

      CREATE TABLE IF NOT EXISTS app_auto_listing_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        store_id UUID NOT NULL REFERENCES app_stores(id) ON DELETE CASCADE,
        top_list_id UUID REFERENCES app_top_lists(id) ON DELETE SET NULL,
        collect_item_id UUID REFERENCES collect_items(id) ON DELETE SET NULL,
        listing_history_id UUID,
        source_sku TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        main_image TEXT NOT NULL DEFAULT '',
        ozon_url TEXT NOT NULL DEFAULT '',
        category_name TEXT NOT NULL DEFAULT '',
        category_name_zh TEXT NOT NULL DEFAULT '',
        seller_name TEXT NOT NULL DEFAULT '',
        price_rub NUMERIC(14,2),
        monthly_sales INTEGER NOT NULL DEFAULT 0,
        review_count INTEGER NOT NULL DEFAULT 0,
        seller_count INTEGER,
        opportunity_score NUMERIC(8,2) NOT NULL DEFAULT 0,
        stage TEXT NOT NULL DEFAULT 'discovered',
        status TEXT NOT NULL DEFAULT 'queued',
        risk_level TEXT NOT NULL DEFAULT 'normal',
        human_reason TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(user_id, store_id, source_sku)
      );

      CREATE TABLE IF NOT EXISTS app_auto_listing_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        store_id UUID NOT NULL REFERENCES app_stores(id) ON DELETE CASCADE,
        item_id UUID REFERENCES app_auto_listing_items(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL DEFAULT 'info',
        stage TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL DEFAULT '',
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_top_lists_strategy ON app_top_lists(active, strategy_type, monthly_sales DESC);
      CREATE INDEX IF NOT EXISTS idx_top_lists_category ON app_top_lists(category_id, monthly_sales DESC);
      CREATE INDEX IF NOT EXISTS idx_top_lists_china ON app_top_lists(is_china_origin, china_confidence DESC, monthly_sales DESC);
      CREATE INDEX IF NOT EXISTS idx_platform_categories_period ON app_platform_categories(active, period, snapshot_date DESC, sales_amount_rub DESC);
      CREATE INDEX IF NOT EXISTS idx_platform_categories_category ON app_platform_categories(category_id, source_captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_auto_listing_items_store_stage ON app_auto_listing_items(user_id, store_id, stage, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_auto_listing_items_store_status ON app_auto_listing_items(user_id, store_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_auto_listing_events_item ON app_auto_listing_events(item_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS app_stock_drafts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        store_id UUID NOT NULL REFERENCES app_stores(id) ON DELETE CASCADE,
        offer_id TEXT NOT NULL,
        product_id BIGINT,
        warehouse_id BIGINT NOT NULL,
        current_ozon_stock INTEGER NOT NULL DEFAULT 0,
        target_stock INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(user_id, store_id, offer_id, warehouse_id)
      );

      CREATE TABLE IF NOT EXISTS app_stock_change_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        store_id UUID NOT NULL REFERENCES app_stores(id) ON DELETE CASCADE,
        offer_id TEXT NOT NULL,
        warehouse_id BIGINT NOT NULL,
        previous_stock INTEGER NOT NULL,
        target_stock INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'success',
        error TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS ai_image_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        model TEXT NOT NULL DEFAULT 'image-01',
        prompt TEXT NOT NULL DEFAULT '',
        aspect_ratio TEXT NOT NULL DEFAULT '3:4',
        n INTEGER NOT NULL DEFAULT 1,
        has_ref_image BOOLEAN NOT NULL DEFAULT FALSE,
        image_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS app_listing_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        offer_id TEXT NOT NULL DEFAULT '',
        product_name TEXT NOT NULL DEFAULT '',
        main_image TEXT NOT NULL DEFAULT '',
        price_rub NUMERIC(12,2),
        status TEXT NOT NULL DEFAULT 'processing',
        raw_payload JSONB,
        errors_json JSONB,
        variants_count INT NOT NULL DEFAULT 0,
        failed_variants_count INT NOT NULL DEFAULT 0,
        partial_success BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // 4. store_id 全面隔离迁移
    await db.query(`
      ALTER TABLE order_notes ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES app_stores(id) ON DELETE CASCADE;
      ALTER TABLE ai_image_records ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES app_stores(id) ON DELETE SET NULL;
      ALTER TABLE ai_image_records ADD COLUMN IF NOT EXISTS estimated_cost_usd NUMERIC(10,4) NOT NULL DEFAULT 0;
      ALTER TABLE ai_image_records ADD COLUMN IF NOT EXISTS scene_preset TEXT NOT NULL DEFAULT '';
      ALTER TABLE ai_image_records ADD COLUMN IF NOT EXISTS offer_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE ai_image_records ADD COLUMN IF NOT EXISTS ozon_sync_status BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE ai_image_records ADD COLUMN IF NOT EXISTS ozon_synced_at TIMESTAMPTZ;
      ALTER TABLE app_listing_history ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES app_stores(id) ON DELETE SET NULL;
      ALTER TABLE app_listing_history ADD COLUMN IF NOT EXISTS raw_payload JSONB;
      ALTER TABLE app_listing_history ADD COLUMN IF NOT EXISTS errors_json JSONB;
      ALTER TABLE app_listing_history ADD COLUMN IF NOT EXISTS variants_count INT NOT NULL DEFAULT 0;
      ALTER TABLE app_listing_history ADD COLUMN IF NOT EXISTS failed_variants_count INT NOT NULL DEFAULT 0;
      ALTER TABLE app_listing_history ADD COLUMN IF NOT EXISTS partial_success BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    // 5. 索引与约束 (依赖前面字段已上线)
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_app_jobs_user_updated ON app_jobs(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_app_jobs_status_updated ON app_jobs(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_collect_items_user_status ON collect_items(user_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_collect_items_store_offer ON collect_items(store_id, linked_offer_id);
      CREATE INDEX IF NOT EXISTS idx_order_notes_store ON order_notes(store_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_order_cache_store_process ON app_order_cache(user_id, store_id, in_process_at DESC);
      CREATE INDEX IF NOT EXISTS idx_order_cache_store_status ON app_order_cache(user_id, store_id, status);
      CREATE INDEX IF NOT EXISTS idx_stock_drafts_store ON app_stock_drafts(user_id, store_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_stock_change_logs_store ON app_stock_change_logs(user_id, store_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_image_records_store ON ai_image_records(store_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_listing_history_store_offer ON app_listing_history(store_id, offer_id);

      ALTER TABLE order_notes DROP CONSTRAINT IF EXISTS order_notes_user_id_posting_number_key;
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_notes_store_posting_unique') THEN
          ALTER TABLE order_notes ADD CONSTRAINT order_notes_store_posting_unique UNIQUE(store_id, posting_number);
        END IF;
      END $$;
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_listing_history_task_id_unique') THEN
          ALTER TABLE app_listing_history ADD CONSTRAINT app_listing_history_task_id_unique UNIQUE(task_id);
        END IF;
      END $$;
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS app_worker_heartbeats (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        store_id UUID REFERENCES app_stores(id) ON DELETE SET NULL,
        worker_name TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '',
        platform TEXT NOT NULL DEFAULT '',
        hostname TEXT NOT NULL DEFAULT '',
        profile_dir TEXT NOT NULL DEFAULT '',
        current_job_id UUID REFERENCES app_jobs(id) ON DELETE SET NULL,
        current_phase TEXT NOT NULL DEFAULT '',
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(user_id, worker_name)
      );
      ALTER TABLE app_worker_heartbeats ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES app_stores(id) ON DELETE SET NULL;
      ALTER TABLE app_worker_heartbeats ADD COLUMN IF NOT EXISTS version TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_app_worker_heartbeats_user_seen ON app_worker_heartbeats(user_id, last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_app_worker_heartbeats_store_seen ON app_worker_heartbeats(user_id, store_id, last_seen_at DESC);
    `);

    await seedInitialUsers();
  } catch (e) {
    console.error("[initDatabase] ERROR:", e);
    // 不退出，尝试继续运行，某些 DDL 报错不影响基本功能
  }
}

async function seedInitialUsers() {
  if (!db || !INITIAL_USERS.trim()) return;
  for (const entry of INITIAL_USERS.split(",")) {
    const [rawUsername, password, rawDisplayName = "", rawRole = "user"] = entry.split(":");
    const username = normalizeUsername(rawUsername);
    if (!username || !password) continue;
    const exists = await db.query("SELECT id FROM app_users WHERE username = $1", [username]);
    if (exists.rowCount) continue;
    await db.query(
      "INSERT INTO app_users (username, password_hash, display_name, role) VALUES ($1, $2, $3, $4)",
      [username, await hashPassword(password), rawDisplayName || username, rawRole || "user"],
    );
  }
}

app.get("/login", async (req, res, next) => {
  try {
    if (await isAuthenticated(req)) {
      res.redirect("/");
      return;
    }
    res.type("html").send(buildLoginHtml(""));
  } catch (error) {
    next(error);
  }
});
app.get("/api/auth/status", async (req, res, next) => {
  try {
    const user = await getAuthenticatedUser(req);
    res.json({
      success: true,
      authenticated: Boolean(user),
      authEnabled: Boolean(db || APP_PASSWORD),
      user,
      collectorMode: Boolean(DISABLE_SERVER_SCRAPER && db),
      serverScraperDisabled: DISABLE_SERVER_SCRAPER,
      queueEnabled: Boolean(db),
    });
  } catch (error) {
    next(error);
  }
});
app.post("/api/auth/login", async (req, res, next) => {
  try {
    const password = String(req.body?.password || "");
    if (db) {
      const username = normalizeUsername(req.body?.username);
      if (!username || !password) {
        res.status(400).json({ success: false, error: "请输入账号和密码。" });
        return;
      }
      const result = await db.query(
        "SELECT id, username, display_name, role, password_hash FROM app_users WHERE username = $1 AND active = TRUE",
        [username],
      );
      const user = result.rows[0] || null;
      if (!user || !(await verifyPassword(password, user.password_hash))) {
        res.status(401).json({ success: false, error: "账号或密码不正确。" });
        return;
      }
      await db.query("UPDATE app_users SET last_login_at = now() WHERE id = $1", [user.id]);
      setAuthCookie(req, res, user.id);
      res.json({
        success: true,
        user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
      });
      return;
    }

    if (!APP_PASSWORD) {
      res.status(500).json({ success: false, error: "服务端还没有设置 APP_PASSWORD，无法启用登录。" });
      return;
    }
    if (!safeEqual(password, APP_PASSWORD)) {
      res.status(401).json({ success: false, error: "密码不正确。" });
      return;
    }
    setAuthCookie(req, res, "legacy");
    res.json({ success: true, user: { id: "legacy", username: "admin", role: "admin" } });
  } catch (error) {
    next(error);
  }
});
app.post("/api/auth/logout", (req, res) => {
  clearAuthCookie(req, res);
  res.json({ success: true });
});

/* ============================================================
   物理上传接口 - 解决 AI 上传 404
   ============================================================ */
app.post("/api/upload", requireAuth,
  (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err) {
        console.error("[upload] multer 错误:", err.message);
        return res.status(400).json({ success: false, error: err.message });
      }
      next();
    });
  },
  (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: "未选择文件" });
    const url = `/uploads/${req.file.filename}`;
    res.json({ success: true, url, size: req.file.size, mime: req.file.mimetype });
  },
);

app.get("/api/version", (_req, res) => {
  res.json({ version: BUILD_VERSION, buildTime: BUILD_TIME, rubCnyRate: RUB_CNY_RATE });
});

/* ============================================================
   商品管理增强 - 行内编辑 API (修正版)
   ============================================================ */
async function updateProductField(req, res, next) {
  if (!requireDb(res)) return;
  try {
    const offerId = String(req.params.offer_id || "").trim();
    const { key, value } = req.body;
    const storeId = String(req.body?.store_id || req.body?.storeId || "").trim();
    const userId = req.user.id;
    if (!offerId || !storeId) return res.status(400).json({ success: false, error: "缺少货号或店铺" });
    if (!["price", "stock", "purchase_price_cny"].includes(key)) {
      return res.status(400).json({ success: false, error: "不支持修改该字段" });
    }

    const product = await db.query(
      "SELECT offer_id FROM app_products WHERE user_id = $1 AND store_id = $2 AND offer_id = $3",
      [userId, storeId, offerId],
    );
    if (!product.rowCount) return res.status(404).json({ success: false, error: "商品不存在或不属于当前店铺" });

    if (key === 'purchase_price_cny') {
      const numericValue = Number(value);
      if (!Number.isFinite(numericValue) || numericValue < 0) {
        return res.status(400).json({ success: false, error: "采购价必须是大于等于 0 的数字" });
      }
      await db.query(
        "UPDATE app_products SET purchase_price_cny = $1, updated_at = now() WHERE user_id = $2 AND store_id = $3 AND offer_id = $4",
        [numericValue, userId, storeId, offerId],
      );
      await db.query(
        "UPDATE collect_items SET price_cny = $1, updated_at = now() WHERE linked_offer_id = $2 AND user_id = $3",
        [numericValue, offerId, userId],
      );
    } else if (key === 'price') {
      const numericValue = Number(value);
      if (!Number.isFinite(numericValue) || numericValue <= 0) {
        return res.status(400).json({ success: false, error: "售价必须是大于 0 的数字" });
      }
      await callOzonSellerAPI("/v1/product/import-prices", {
        prices: [{ offer_id: offerId, price: String(numericValue) }]
      }, { storeId, userId });
    } else if (key === 'stock') {
      const numericValue = Number(value);
      if (!Number.isInteger(numericValue) || numericValue < 0) {
        return res.status(400).json({ success: false, error: "库存必须是大于等于 0 的整数" });
      }
      await callOzonSellerAPI("/v1/product/import-stocks", {
        stocks: [{ offer_id: offerId, stocks: numericValue }]
      }, { storeId, userId });
    }

    res.json({ success: true });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
    next(error);
  }
}

app.patch("/api/seller/products/:offer_id/field", requireAuth, updateProductField);

app.use(requireAuth);
// index.html 永不缓存 + 拦截 / 和 /index.html 请求做占位符替换（注入 BUILD_VERSION）
// 其他静态文件浏览器可短缓存，配合 ?v= 破缓存
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  if (req.path === "/" || req.path === "/index.html") {
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    try {
      const raw = readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
      res.send(raw.replaceAll("__BUILD_VERSION__", BUILD_VERSION));
    } catch (e) {
      res.status(500).send("index.html 读取失败: " + e.message);
    }
    return;
  }
  if (req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-store, must-revalidate");
  } else if (/\.(js|css)$/.test(req.path)) {
    // 有 ?v= 时可以放心 immutable；无 ?v= 时短缓存
    res.setHeader("Cache-Control", req.query.v ? "public, max-age=31536000, immutable" : "public, max-age=300");
  }
  next();
});
app.use(express.static(PUBLIC_DIR));
app.use("/artifacts", express.static(DATA_DIR));

app.post("/api/1688/open", async (_req, res) => {
  if (DISABLE_SERVER_SCRAPER) {
    res.json({
      success: true,
      disabled: true,
      message: "服务器模式下不在网页里打开 1688。请保持本机采集端在线，它会在你电脑上自动打开浏览器并采集。",
    });
    return;
  }
  try {
    const context = await getBrowserContext({ headless: false });
    const page = await context.newPage();
    await page.goto("https://www.1688.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    res.json({ success: true, message: "1688 登录窗口已打开。登录后可以回到本页面开始采集。" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/browser/close", async (_req, res) => {
  try {
    if (DISABLE_SERVER_SCRAPER) {
      res.json({ success: true, disabled: true, message: "服务器模式下浏览器由本机采集端管理。" });
      return;
    }
    if (browserContext) {
      await browserContext.close();
      browserContext = null;
      currentBrowserHeadless = false;
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

async function callOzonSellerAPI(path, body, { method = "POST", storeId = null, userId = null, baseUrl = OZON_SELLER_BASE_URL, timeoutMs = 60000 } = {}) {
  let clientId = OZON_SELLER_CLIENT_ID;
  let apiKey = OZON_SELLER_API_KEY;

  if (storeId && db && userId) {
    const res = await db.query(
      "SELECT client_id, api_key FROM app_stores WHERE id = $1 AND user_id = $2 AND active = TRUE",
      [storeId, userId]
    );
    if (res.rows[0]) {
      clientId = res.rows[0].client_id;
      apiKey = res.rows[0].api_key;
    } else {
      const error = new Error("未找到该店铺或无权限，请重新选择目标店铺。");
      error.statusCode = 404;
      throw error;
    }
  }

  if (!clientId || !apiKey) {
    const error = new Error("该店铺未配置 API 凭证。请在店铺管理中设置。");
    error.statusCode = 503;
    throw error;
  }
  // v2.2.9.100: 给 Ozon Seller API 调用加超时，避免官方接口慢/挂起时请求无限等待（前端会先超时报"插件超时"）
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Client-Id": clientId,
        "Api-Key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(Math.max(15000, Number(timeoutMs) || 60000)),
    });
  } catch (fetchError) {
    if (fetchError && fetchError.name === "TimeoutError") {
      const error = new Error(`Ozon Seller API 请求超时(${timeoutMs}ms)：${path}`);
      error.statusCode = 504;
      throw error;
    }
    throw fetchError;
  }
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text.slice(0, 4000) };
    }
  }
  if (!response.ok) {
    const detail = typeof payload === "object" && payload
      ? JSON.stringify(payload).slice(0, 1500)
      : String(text).slice(0, 1500);
    const error = new Error(`Ozon Seller API ${response.status} ${response.statusText || ""}：${detail}`);
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function sellerConfiguredResponse(_req, res) {
  res.json({
    success: true,
    configured: Boolean(OZON_SELLER_CLIENT_ID && OZON_SELLER_API_KEY),
    baseUrl: OZON_SELLER_BASE_URL,
  });
}

app.get("/api/seller/status", sellerConfiguredResponse);

app.post("/api/seller/test", async (req, res, next) => {
  try {
    // 用最轻量的 list 接口验证鉴权
    const data = await callOzonSellerAPI("/v3/product/list", { filter: { visibility: "ALL" }, limit: 1 });
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.statusCode || 502).json({ success: false, error: error.message, payload: error.payload || null });
  }
});

/* ============================================================
   商品管理增强 - 全字段物理同步接口 (v0.3.1)
   ============================================================ */
app.patch("/api/seller/products/:offer_id/full-update", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const { offer_id } = req.params;
    const b = req.body || {};
    const store_id = b.store_id || b.storeId;
    const userId = req.user.id;
    if (!store_id) return res.status(400).json({ success: false, error: "未指定店铺" });

    const existingResult = await db.query(
      `SELECT product_id, image, images, price, old_price, min_price, currency_code FROM app_products
        WHERE user_id = $1 AND store_id = $2 AND offer_id = $3 LIMIT 1`,
      [userId, store_id, offer_id],
    );
    const existing = existingResult.rows[0];
    if (!existing) return res.status(404).json({ success: false, error: "当前店铺未找到该商品" });

    const price = Number(b.price || 0);
    const oldPrice = b.old_price != null ? Number(b.old_price) : null;
    const minPrice = b.min_price != null ? Number(b.min_price) : null;
    const syncResults = { price: "skipped", pictures: "skipped", local: "pending" };
    const syncErrors = [];

    // 1) 更新价格 (v1/product/import-prices)
    const priceChanged = price > 0 && (
      Number(existing.price || 0) !== price
      || Number(existing.old_price || 0) !== Number(oldPrice || 0)
      || Number(existing.min_price || 0) !== Number(minPrice || 0)
      || String(existing.currency_code || "RUB") !== String(b.currency_code || "RUB")
    );
    if (priceChanged) {
      try {
        await callOzonSellerAPI("/v1/product/import-prices", {
          prices: [{
            offer_id,
            price: String(price),
            ...(oldPrice != null ? { old_price: String(oldPrice) } : {}),
            ...(minPrice != null ? { min_price: String(minPrice) } : {}),
            currency_code: String(b.currency_code || "RUB"),
          }],
        }, { storeId: store_id, userId });
        syncResults.price = "submitted";
      } catch (e) {
        syncResults.price = "failed";
        syncErrors.push(`价格同步失败：${e.message}`);
      }
    }

    // 2) 图片使用专用 Pictures API；库存只允许从库存管理按仓库提交。
    const rawPictures = [
      b.image,
      ...(Array.isArray(b.images) ? b.images : []),
    ].filter(Boolean);
    const existingPictures = normalizeImportImageList([
      existing.image,
      ...(Array.isArray(existing.images) ? existing.images : []),
    ].filter(Boolean));
    const requestedPictures = normalizeImportImageList(rawPictures);
    const picturesChanged = requestedPictures.length > 0
      && JSON.stringify(requestedPictures) !== JSON.stringify(existingPictures);
    if (picturesChanged) {
      try {
        let productId = Number(existing.product_id || 0);
        if (!productId) {
          const info = await callOzonSellerAPI("/v3/product/info/list", { offer_id: [offer_id] }, { storeId: store_id, userId });
          productId = Number((info?.items || [])[0]?.id || 0);
        }
        if (!productId) throw new Error("Ozon 尚未返回 product_id");
        const baseUrl = getRequestPublicBaseUrl(req);
        const pictures = normalizeImportImageList(rawPictures.map((value) => {
          const image = String(value || "").trim();
          return /^\/uploads\//i.test(image) && baseUrl ? `${baseUrl}${image}` : image;
        })).filter((image) => /^https:\/\//i.test(image));
        if (!pictures.length) throw new Error("没有可供 Ozon 下载的 HTTPS 图片");
        await callOzonSellerAPI("/v1/product/pictures/import", { product_id: productId, images: pictures }, { storeId: store_id, userId });
        syncResults.pictures = "submitted";
      } catch (e) {
        syncResults.pictures = "failed";
        syncErrors.push(`图片同步失败：${e.message}`);
      }
    }

    // 3) 本地物理落库 (全字段)
    await db.query(
      `UPDATE app_products SET
         name = COALESCE($1, name),
         brand = COALESCE($2, brand),
         description = COALESCE($3, description),
         country_of_origin = COALESCE($4, country_of_origin),
         price = COALESCE($5, price),
         stock = COALESCE($6, stock),
         weight = COALESCE($7, weight),
         depth = COALESCE($8, depth),
         width = COALESCE($9, width),
         height = COALESCE($10, height),
         old_price = COALESCE($11, old_price),
         min_price = COALESCE($12, min_price),
         currency_code = COALESCE($13, currency_code),
         vat = COALESCE($14, vat),
         category_name = COALESCE($15, category_name),
         barcode = COALESCE($16, barcode),
         image = COALESCE($17, image),
         images = COALESCE($18::jsonb, images),
         purchase_price_cny = COALESCE($19, purchase_price_cny),
         source_url_1688 = COALESCE($20, source_url_1688),
         updated_at = now()
       WHERE offer_id = $21 AND store_id = $22 AND user_id = $23`,
      [
        b.name ?? null, b.brand ?? null, b.description ?? null, b.country_of_origin ?? null,
        price || null, null,
        b.weight != null ? Number(b.weight) : null,
        b.depth != null ? Number(b.depth) : null,
        b.width != null ? Number(b.width) : null,
        b.height != null ? Number(b.height) : null,
        oldPrice, minPrice,
        b.currency_code ?? null, b.vat ?? null,
        b.category_name ?? null, b.barcode ?? null,
        b.image ?? null, Array.isArray(b.images) ? JSON.stringify(b.images) : null,
        b.purchase_price_cny != null && Number.isFinite(Number(b.purchase_price_cny)) ? Math.max(0, Number(b.purchase_price_cny)) : null,
        /^https?:\/\/(?:[^/]+\.)?1688\.com\//i.test(String(b.source_url_1688 || "")) ? String(b.source_url_1688).trim() : (b.source_url_1688 === "" ? "" : null),
        offer_id, store_id, userId,
      ]
    );
    syncResults.local = "saved";

    res.status(syncErrors.length ? 207 : 200).json({
      success: syncErrors.length === 0,
      sync_results: syncResults,
      errors: syncErrors,
      message: syncErrors.length ? "本地资料已保存，部分 Ozon 同步失败" : "本地资料已保存，价格和图片已提交 Ozon",
    });
  } catch (error) {
    console.error("[full-update] err:", error);
    res.status(error.statusCode || 500).json({ success: false, error: error.message, payload: error.payload || null });
  }
});

// Ozon attribute ID -> 语义字段映射 (v4/product/info/attributes 常用属性)
const OZON_ATTR = {
  BRAND: 85,
  DESCRIPTION: 4191,
  COUNTRY_OF_ORIGIN: 4389,
};
function pickAttrValue(attributes, attrId) {
  if (!Array.isArray(attributes)) return "";
  const hit = attributes.find(a => Number(a.id) === attrId);
  if (!hit || !Array.isArray(hit.values) || !hit.values.length) return "";
  return String(hit.values[0].value || "");
}

/**
 * 把 Ozon 商品 statuses + visibility_details 映射为前端 Tab 认可的业务状态。
 * 前端 Tab 枚举: ALL / VISIBLE / READY_TO_SUPPLY / NEED_ATTENTION /
 * NOT_MODERATED / FAILED_MODERATION / IN_ACTIVE
 * 依据 (真实抓包证据, 见诊断报告):
 *   - is_created=false        -> 草稿, 归 READY_TO_SUPPLY
 *   - is_failed=true 或
 *     moderate_status in [rejected, moderating] 或
 *     validation_state='failed' -> NEED_ATTENTION (需修改)
 *   - visibility_details.active_product=false 或
 *     archived=true              -> IN_ACTIVE (已下架/归档)
 *   - visibility_details.has_price=true AND has_stock=true
 *     AND moderate_status=approved -> VISIBLE (销售中)
 *   - 其余 (已审但缺价/缺库存)     -> READY_TO_SUPPLY (待销售)
 */
function mapOzonStatus(info) {
  const s = info?.statuses || {};
  const v = info?.visibility_details || {};
  const isCreated = s.is_created !== false; // 默认 true
  const isFailed = s.is_failed === true;
  const moderate = String(s.moderate_status || "").toLowerCase();
  const validation = String(s.validation_state || "").toLowerCase();
  const archived = v.archived === true;
  const activeProduct = v.active_product !== false; // 默认 true

  if (!isCreated) return "READY_TO_SUPPLY";
  if (archived || !activeProduct) return "IN_ACTIVE";
  if (moderate === "rejected") return "FAILED_MODERATION";
  if (moderate === "moderating" || moderate === "pending") return "NOT_MODERATED";
  if (isFailed || validation === "failed") return "NEED_ATTENTION";
  const hasPrice = v.has_price === true;
  const hasStock = v.has_stock === true;
  if (hasPrice && hasStock && (moderate === "approved" || moderate === "")) {
    return "VISIBLE";
  }
  return "READY_TO_SUPPLY";
}

const PRODUCT_STATUS_DISPLAY = {
  ALL: "全部",
  VISIBLE: "销售中",
  READY_TO_SUPPLY: "准备销售",
  NEED_ATTENTION: "待修改",
  NOT_MODERATED: "待审核",
  FAILED_MODERATION: "错误",
  IN_ACTIVE: "商品已下架",
  ARCHIVED: "归档",
  UNKNOWN: "未知状态",
};

const PRODUCT_STATUS_HINT = {
  ALL: "Ozon 商品列表中的全部商品",
  VISIBLE: "Ozon 前台可见，可正常售卖",
  READY_TO_SUPPLY: "资料已准备，待补库存或供货后销售",
  NEED_ATTENTION: "Ozon 要求补齐资料，请查看体检或审核原因",
  NOT_MODERATED: "已提交 Ozon，正在审核中",
  FAILED_MODERATION: "Ozon 后台错误状态，请先处理返回的问题",
  IN_ACTIVE: "商品已下架，可重新上架恢复",
  ARCHIVED: "Ozon 商品档案/归档商品",
  UNKNOWN: "Ozon 未返回明确业务状态",
};

function productStatusDisplay(status, rawName = "") {
  const key = String(status || "UNKNOWN").trim().toUpperCase();
  return PRODUCT_STATUS_DISPLAY[key] || String(rawName || status || "未知状态");
}

function productStatusHint(status) {
  const key = String(status || "UNKNOWN").trim().toUpperCase();
  return PRODUCT_STATUS_HINT[key] || PRODUCT_STATUS_HINT.UNKNOWN;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function summarizeStocksJson(stocksJson) {
  const stocks = parseJsonArray(stocksJson).filter((item) => item && typeof item === "object");
  const warehouseIds = [...new Set(stocks
    .map((item) => Number(item.warehouse_id || 0))
    .filter((id) => Number.isFinite(id) && id > 0))];
  return {
    warehouse_count: warehouseIds.length,
    warehouse_ids: warehouseIds,
    total_stock: stocks.reduce((sum, item) => sum + (Number(item.present) || 0), 0),
    total_reserved: stocks.reduce((sum, item) => sum + (Number(item.reserved) || 0), 0),
    sources: [...new Set(stocks.map((item) => String(item.source || "").trim()).filter(Boolean))],
    has_pool_stock: stocks.some((item) => !Number(item.warehouse_id || 0)),
  };
}

function enrichProductReadModel(row = {}) {
  const stockSummary = summarizeStocksJson(row.stocks_json);
  const fallbackStock = Number(row.stock || 0);
  const totalStock = stockSummary.warehouse_count || stockSummary.has_pool_stock
    ? stockSummary.total_stock
    : fallbackStock;
  const categoryId = row.description_category_id == null ? null : Number(row.description_category_id);
  const typeId = row.type_id == null ? null : Number(row.type_id);
  return {
    ...row,
    status_display: productStatusDisplay(row.status, row.status_name),
    status_hint: productStatusHint(row.status),
    category_display: row.category_name || (categoryId ? `Ozon 类目 ${categoryId}` : "未设置"),
    category_readonly: {
      category_name: row.category_name || "",
      description_category_id: Number.isFinite(categoryId) && categoryId > 0 ? categoryId : null,
      type_id: Number.isFinite(typeId) && typeId > 0 ? typeId : null,
      editable_via: "/api/seller/products/:offer_id/full-update",
    },
    stock_readonly: {
      editable: false,
      value: fallbackStock,
      total_stock: totalStock,
      total_reserved: stockSummary.total_reserved,
      reason: "库存按仓库维护，请使用库存管理接口。",
    },
    warehouse_summary: stockSummary,
  };
}

function warehouseStatusDisplay(status) {
  const value = String(status || "active").trim().toLowerCase();
  const map = {
    active: "启用",
    disabled: "停用",
    blocked: "受限",
    archived: "已归档",
  };
  return map[value] || status || "未知状态";
}

function warehouseSourceDisplay(source) {
  const value = String(source || "").trim().toLowerCase();
  const map = {
    fbs: "FBS 仓库",
    fbo: "FBO 仓库",
    rfbs: "RFBS 仓库",
    crossborder: "跨境仓",
  };
  return map[value] || source || "仓库";
}

function enrichWarehouseReadModel(warehouse = {}) {
  const source = warehouse.source || (warehouse.is_rfbs ? "rfbs" : "fbs");
  return {
    ...warehouse,
    warehouse_name: warehouse.warehouse_name || warehouse.name || `WH-${warehouse.warehouse_id || "?"}`,
    source,
    source_display: warehouseSourceDisplay(source),
    status_display: warehouseStatusDisplay(warehouse.status),
  };
}

/**
 * v0.3.4 仓库列表 - Ozon /v2/warehouse/list (卖家自有 FBS 仓库)
 * 返回: [{warehouse_id, name, status, is_kgt, address_info, first_mile, ...}]
 */
app.get("/api/seller/warehouses", requireAuth, async (req, res) => {
  try {
    const storeId = req.query?.storeId || req.query?.store_id;
    if (!storeId) return res.status(400).json({ success: false, error: "未选择店铺" });
    const data = await callOzonSellerAPI("/v2/warehouse/list", {}, { storeId, userId: req.user.id });
    const warehouses = (data?.warehouses || data?.result || []).map(w => ({
      warehouse_id: w.warehouse_id,
      name: w.name,
      status: w.status || "active",
      is_rfbs: w.is_rfbs === true,
      is_kgt: w.is_kgt === true,
      city: w.address_info?.address || "",
      phone: w.phone || "",
    })).map(enrichWarehouseReadModel);
    res.json({ success: true, warehouses });
  } catch (error) {
    console.error("[warehouses]", error.message, error.payload);
    res.status(error.statusCode || 502).json({ success: false, error: error.message, payload: error.payload || null });
  }
});

async function fetchLiveStocksByOffer(storeId, userId, offerIds) {
  const ids = [...new Set((offerIds || []).map((value) => String(value || "").trim()).filter(Boolean))];
  const result = new Map();
  for (let index = 0; index < ids.length; index += 100) {
    const chunk = ids.slice(index, index + 100);
    const info = await callOzonSellerAPI("/v3/product/info/list", { offer_id: chunk }, { storeId, userId });
    for (const item of (info?.items || info?.result?.items || [])) {
      result.set(`${item.offer_id}|*`, true);
      const stocks = Array.isArray(item?.stocks?.stocks) ? item.stocks.stocks : (Array.isArray(item?.stocks) ? item.stocks : []);
      for (const stock of stocks) {
        const warehouseId = Number(stock.warehouse_id || 0);
        if (warehouseId > 0) result.set(`${item.offer_id}|${warehouseId}`, Number(stock.present || 0));
      }
    }
  }
  return result;
}

function findStockConflicts(rows, liveStocks) {
  return rows.flatMap((row) => {
    const key = `${row.offer_id}|${Number(row.warehouse_id)}`;
    if (!liveStocks.has(key) && !liveStocks.has(`${row.offer_id}|*`)) return [];
    const liveStock = liveStocks.has(key) ? Number(liveStocks.get(key)) : 0;
    const expectedStock = Number(row.expected_stock ?? row.current_ozon_stock ?? 0);
    return liveStock === expectedStock ? [] : [{
      id: row.id || null,
      offer_id: row.offer_id,
      warehouse_id: Number(row.warehouse_id),
      expected_stock: expectedStock,
      live_stock: liveStock,
      target_stock: Number(row.target_stock ?? row.stock),
    }];
  });
}

/**
 * v0.3.5 分仓库存明细 - 查询指定 offer_id 在所有已知仓库的库存分布
 * 数据源优先级 (三级 fallback):
 *   1) 本地 app_products.stocks_json (已同步 Ozon 分仓原始数组)
 *   2) 未覆盖的仓库 (从 /v2/warehouse/list 拉取) 补 present=0
 *   3) 若本地为空且 API 也没仓库, 从近 90 天订单 posting_number 反查涉及仓库 (兜底)
 * 返回: {warehouses:[{warehouse_id, name, source, present, reserved, city, has_stock}]}
 */
app.get("/api/seller/products/stocks/detail", requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const storeId = req.query?.store_id || req.query?.storeId;
    const offer_id = String(req.query?.offer_id || "").trim();
    if (!storeId || !offer_id) return res.status(400).json({ success: false, error: "缺少 store_id / offer_id" });
    const userId = req.user.id;

    // 1) 本地商品行 (stocks_json + product_id)
    const localR = await db.query(
      `SELECT product_id, stock, stocks_json FROM app_products WHERE user_id=$1 AND store_id=$2 AND offer_id=$3`,
      [userId, storeId, offer_id],
    );
    if (!localR.rows.length) return res.status(404).json({ success: false, error: "本地未找到商品, 请先同步" });
    const prod = localR.rows[0];
    let localStocks = [];
    try {
      const raw = prod.stocks_json;
      localStocks = Array.isArray(raw) ? raw : (raw ? JSON.parse(raw) : []);
    } catch { localStocks = []; }

    // 2) 拉店铺全部 FBS 仓库 (可能包含空仓库)
    let allWarehouses = [];
    try {
      const whData = await callOzonSellerAPI("/v2/warehouse/list", {}, { storeId, userId });
      allWarehouses = (whData?.warehouses || whData?.result || []);
    } catch (e) {
      console.warn("[stocks/detail] warehouse/list 失败, 走本地兜底:", e.message);
    }

    // 3) 合并: 以仓库表为骨架, 拿本地 stocks_json 填数
    const localByWid = new Map(localStocks.map(s => [Number(s.warehouse_id || 0), s]));
    let merged;
    if (allWarehouses.length) {
      merged = allWarehouses.map(w => {
        const hit = localByWid.get(Number(w.warehouse_id)) || {};
        return {
          warehouse_id: Number(w.warehouse_id),
          name: w.name || `WH-${w.warehouse_id}`,
          source: hit.source || (w.is_rfbs ? "rfbs" : "fbs"),
          city: w?.address_info?.address || w.city || "",
          present: Number(hit.present || 0),
          reserved: Number(hit.reserved || 0),
          has_stock: hit.present !== undefined,
        };
      });
      // 若本地还有仓库不在 API 列表里 (少见), 追加
      for (const s of localStocks) {
        const wid = Number(s.warehouse_id || 0);
        if (wid && !merged.find(x => x.warehouse_id === wid)) {
          merged.push({
            warehouse_id: wid,
            name: `WH-${wid}`,
            source: s.source || "fbs",
            city: "",
            present: Number(s.present || 0),
            reserved: Number(s.reserved || 0),
            has_stock: true,
          });
        }
      }
    } else {
      // API 空 → 直接用本地
      merged = localStocks.map(s => ({
        warehouse_id: Number(s.warehouse_id || 0),
        name: `WH-${s.warehouse_id || "?"}`,
        source: s.source || "fbs",
        city: "",
        present: Number(s.present || 0),
        reserved: Number(s.reserved || 0),
        has_stock: true,
      }));
    }

    // 4) 若本地 stocks_json 有 warehouse_id=undefined 的"跨仓池"库存 (RFBS 常见),
    //    追加一行"跨仓池"体现真实可用库存, 避免用户误以为全 0
    const poolStocks = localStocks.filter(s => !s.warehouse_id);
    if (poolStocks.length) {
      const poolPresent = poolStocks.reduce((sum, x) => sum + (Number(x.present) || 0), 0);
      const poolReserved = poolStocks.reduce((sum, x) => sum + (Number(x.reserved) || 0), 0);
      merged.push({
        warehouse_id: 0,           // 特殊 ID 0 = 跨仓池
        name: "🌐 跨仓池 (RFBS)",
        source: poolStocks[0]?.source || "rfbs",
        city: "未绑定具体仓库 · Ozon 平台通池库存",
        present: poolPresent,
        reserved: poolReserved,
        has_stock: true,
        is_pool: true,
      });
    }

    res.json({
      success: true,
      offer_id,
      product_id: prod.product_id,
      total_stock: merged.reduce((s, x) => s + (x.present || 0), 0),
      total_reserved: merged.reduce((s, x) => s + (x.reserved || 0), 0),
      warehouses: merged.map(enrichWarehouseReadModel),
    });
  } catch (error) {
    console.error("[stocks/detail]", error.message, error.payload);
    res.status(error.statusCode || 500).json({ success: false, error: error.message, payload: error.payload || null });
  }
});

/**
 * v0.3.4 精确分仓库存更新 - Ozon /v2/products/stocks
 * body: {store_id, stocks:[{offer_id, product_id, stock, warehouse_id}, ...]}
 */
app.post("/api/seller/products/stocks", requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const storeId = req.body?.store_id || req.body?.storeId;
    if (!storeId) return res.status(400).json({ success: false, error: "未选择店铺" });
    const userId = req.user.id;
    const raw = Array.isArray(req.body?.stocks) ? req.body.stocks : [];
    const force = req.body?.force === true;
    if (!raw.length) return res.status(400).json({ success: false, error: "stocks 为空" });

    // 补齐 product_id (从本地库查)
    const offersNeedResolve = raw.filter(s => !s.product_id && s.offer_id).map(s => s.offer_id);
    let offerToPid = new Map();
    if (offersNeedResolve.length) {
      const r = await db.query(
        `SELECT offer_id, product_id FROM app_products WHERE user_id = $1 AND store_id = $2 AND offer_id = ANY($3::text[])`,
        [userId, storeId, offersNeedResolve],
      );
      offerToPid = new Map(r.rows.map(x => [x.offer_id, x.product_id]));
    }

    const payload = raw.map(s => {
      const pid = s.product_id || offerToPid.get(s.offer_id);
      const wh = Number(s.warehouse_id);
      const stock = Math.max(0, Number(s.stock || 0));
      if (!pid || !wh) return null;
      return {
        offer_id: s.offer_id,
        product_id: Number(pid),
        stock,
        warehouse_id: wh,
      };
    }).filter(Boolean);

    if (!payload.length) return res.status(400).json({ success: false, error: "无有效 payload (缺 product_id 或 warehouse_id)" });

    const liveStocks = await fetchLiveStocksByOffer(storeId, userId, payload.map((row) => row.offer_id));
    const conflicts = findStockConflicts(raw, liveStocks);
    if (conflicts.length && !force) {
      for (const conflict of conflicts) {
        await db.query(
          `INSERT INTO app_stock_change_logs (
             user_id, store_id, offer_id, warehouse_id, previous_stock, target_stock, status, error
           ) VALUES ($1,$2,$3,$4,$5,$6,'conflict',$7)`,
          [userId, storeId, conflict.offer_id, conflict.warehouse_id, conflict.live_stock, conflict.target_stock, `页面基线 ${conflict.expected_stock}，Ozon 实时 ${conflict.live_stock}`],
        );
      }
      return res.status(409).json({ success: false, code: "STOCK_CONFLICT", error: "Ozon 实时库存已发生变化", conflicts });
    }

    const data = await callOzonSellerAPI("/v2/products/stocks", { stocks: payload }, { storeId, userId });

    // v0.3.5 物理修复: 精确按 offer_id 汇总 payload 内所有仓库新库存写回本地
    // 之前 `SET stock = stock + 0` 是无操作 (仅刷 updated_at), 现在真实覆盖 stock 与 stocks_json
    const byOffer = new Map();
    for (const s of payload) {
      const arr = byOffer.get(s.offer_id) || [];
      arr.push(s);
      byOffer.set(s.offer_id, arr);
    }
    for (const [offer_id, arr] of byOffer) {
      // 读现有 stocks_json, 合并 warehouse_id 维度覆盖新库存
      const cur = await db.query(
        `SELECT stocks_json FROM app_products WHERE user_id = $1 AND store_id = $2 AND offer_id = $3`,
        [userId, storeId, offer_id],
      );
      let stocksJson = [];
      try {
        const raw = cur.rows?.[0]?.stocks_json;
        stocksJson = Array.isArray(raw) ? raw : (raw ? JSON.parse(raw) : []);
      } catch { stocksJson = []; }

      // 覆盖或追加每个 warehouse 的 present
      const whMap = new Map(stocksJson.map(x => [Number(x.warehouse_id || 0), x]));
      for (const s of arr) {
        const wid = Number(s.warehouse_id);
        const existing = whMap.get(wid) || { warehouse_id: wid, source: "fbs", reserved: 0 };
        const liveKey = `${offer_id}|${wid}`;
        const previousStock = liveStocks.has(liveKey) ? Number(liveStocks.get(liveKey)) : Number(existing.present || 0);
        whMap.set(wid, { ...existing, warehouse_id: wid, present: Number(s.stock) });
        await db.query(
          `INSERT INTO app_stock_change_logs (
             user_id, store_id, offer_id, warehouse_id, previous_stock, target_stock, status
           ) VALUES ($1,$2,$3,$4,$5,$6,'success')`,
          [userId, storeId, offer_id, wid, previousStock, Number(s.stock)],
        );
      }
      const merged = Array.from(whMap.values());
      const totalStock = merged.reduce((sum, x) => sum + (Number(x.present) || 0), 0);

      await db.query(
        `UPDATE app_products
         SET stock = $3, stocks_json = $4::jsonb, updated_at = now()
         WHERE user_id = $1 AND store_id = $2 AND offer_id = $5`,
        [userId, storeId, totalStock, JSON.stringify(merged), offer_id],
      );
    }
    res.json({ success: true, data, submitted: payload });
  } catch (error) {
    console.error("[stocks-update]", error.message, error.payload);
    res.status(error.statusCode || 502).json({ success: false, error: error.message, payload: error.payload || null });
  }
});

/**
 * v0.3.3 商品归档 - Ozon /v1/product/archive (支持批量, 输入 offer_id 数组或 product_id 数组)
 */
app.post("/api/seller/products/archive", requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const storeId = req.body?.store_id || req.body?.storeId;
    if (!storeId) return res.status(400).json({ success: false, error: "未选择店铺" });
    const userId = req.user.id;
    let productIds = req.body?.product_id || [];
    let offerIds = req.body?.offer_id || [];
    if (typeof productIds === "string" || typeof productIds === "number") productIds = [productIds];
    if (typeof offerIds === "string") offerIds = [offerIds];

    // 若前端只传 offer_id, 从本地库解析 product_id
    if ((!productIds.length) && offerIds.length) {
      const r = await db.query(
        `SELECT product_id, offer_id FROM app_products WHERE user_id = $1 AND store_id = $2 AND offer_id = ANY($3::text[])`,
        [userId, storeId, offerIds],
      );
      productIds = r.rows.map(x => x.product_id).filter(Boolean);
    }
    productIds = productIds.map(x => Number(x)).filter(x => Number.isFinite(x) && x > 0);
    if (!productIds.length) return res.status(400).json({ success: false, error: "未提供 product_id 或无法解析" });

    const data = await callOzonSellerAPI("/v1/product/archive", { product_id: productIds }, { storeId, userId });

    // 本地库同步状态
    await db.query(
      `UPDATE app_products SET status = 'IN_ACTIVE', updated_at = now()
       WHERE user_id = $1 AND store_id = $2 AND product_id = ANY($3::bigint[])`,
      [userId, storeId, productIds],
    );
    res.json({ success: true, data, archived: productIds });
  } catch (error) {
    console.error("[archive]", error.message, error.payload);
    res.status(error.statusCode || 500).json({ success: false, error: error.message, payload: error.payload || null });
  }
});

/**
 * v0.3.3 商品反归档 (上架) - Ozon /v1/product/unarchive
 */
app.post("/api/seller/products/unarchive", requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const storeId = req.body?.store_id || req.body?.storeId;
    if (!storeId) return res.status(400).json({ success: false, error: "未选择店铺" });
    const userId = req.user.id;
    let productIds = req.body?.product_id || [];
    let offerIds = req.body?.offer_id || [];
    if (typeof productIds === "string" || typeof productIds === "number") productIds = [productIds];
    if (typeof offerIds === "string") offerIds = [offerIds];
    if ((!productIds.length) && offerIds.length) {
      const r = await db.query(
        `SELECT product_id FROM app_products WHERE user_id = $1 AND store_id = $2 AND offer_id = ANY($3::text[])`,
        [userId, storeId, offerIds],
      );
      productIds = r.rows.map(x => x.product_id).filter(Boolean);
    }
    productIds = productIds.map(x => Number(x)).filter(x => Number.isFinite(x) && x > 0);
    if (!productIds.length) return res.status(400).json({ success: false, error: "未提供 product_id" });

    const data = await callOzonSellerAPI("/v1/product/unarchive", { product_id: productIds }, { storeId, userId });
    await db.query(
      `UPDATE app_products SET status = 'READY_TO_SUPPLY', updated_at = now()
       WHERE user_id = $1 AND store_id = $2 AND product_id = ANY($3::bigint[])`,
      [userId, storeId, productIds],
    );
    res.json({ success: true, data, unarchived: productIds });
  } catch (error) {
    console.error("[unarchive]", error.message, error.payload);
    res.status(error.statusCode || 500).json({ success: false, error: error.message, payload: error.payload || null });
  }
});

/**
 * v2.2.9.100 批量恢复归档商品 - 供批量上架提交前调用
 * 输入: store_id + offer_id[]
 * 行为: 查 Ozon 这些 offer_id 的归档状态 → 已归档的自动 unarchive 恢复可见性
 * 输出: { checked, restored: product_id[], archived: [{offer_id, product_id}] }
 */
app.post("/api/seller/products/bulk-restore", requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const storeId = req.body?.store_id || req.body?.storeId;
    if (!storeId) return res.status(400).json({ success: false, error: "未选择店铺" });
    const userId = req.user.id;
    let offerIds = req.body?.offer_id || [];
    if (!Array.isArray(offerIds)) offerIds = [offerIds];
    offerIds = offerIds.map(v => String(v || "").trim()).filter(Boolean).slice(0, 200);
    if (!offerIds.length) return res.json({ success: true, checked: 0, restored: [], archived: [] });

    let items = [];
    try {
      const data = await callOzonSellerAPI("/v3/product/list", {
        filter: { offer_id: offerIds, visibility: "ALL" },
        limit: Math.min(100, offerIds.length),
      }, { storeId, userId });
      items = data?.result?.items || [];
    } catch (e) {
      console.warn("[bulk-restore] 查询归档状态失败:", e.message);
      return res.json({ success: true, checked: offerIds.length, restored: [], archived: [], error: e.message });
    }
    // v2.2.9.100: 去重检测 — 返回已存在的 offer_id（无论归档/在售），供前端提示"已上架过，跳过"
    const exists = items.map(i => i.offer_id).filter(Boolean);
    const archived = items.filter(i => i.archived === true);
    const archivedIds = archived.map(i => Number(i.product_id)).filter(x => Number.isFinite(x) && x > 0);
    let restored = [];
    if (archivedIds.length) {
      try {
        const data = await callOzonSellerAPI("/v1/product/unarchive", { product_id: archivedIds }, { storeId, userId });
        restored = archivedIds;
        console.log(`[bulk-restore] 已恢复归档商品 ${restored.length} 个: ${archived.map(i => i.offer_id).join(", ")}`);
        await db.query(
          `UPDATE app_products SET status = 'READY_TO_SUPPLY', updated_at = now()
           WHERE user_id = $1 AND store_id = $2 AND product_id = ANY($3::bigint[])`,
          [userId, storeId, archivedIds],
        );
      } catch (e) {
        console.error("[bulk-restore] unarchive 失败:", e.message);
      }
    }
    res.json({
      success: true,
      checked: offerIds.length,
      restored,
      exists,
      archived: archived.map(i => ({ offer_id: i.offer_id, product_id: i.product_id })),
    });
  } catch (error) {
    console.error("[bulk-restore]", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * v0.5.6 全部同步 - 串行调所有 active 店铺的 sync-all 逻辑
 * 输入: {} (无需 store_id, 自动查所有 active 店铺)
 * 输出: { success: true, results: [{store_id, store_name, count, error?}], total_count }
 */
app.post("/api/seller/products/sync-global", requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const userId = req.user.id;
    const storesRes = await db.query(
      "SELECT id, name FROM app_stores WHERE user_id = $1 AND active = TRUE ORDER BY updated_at DESC",
      [userId],
    );
    const stores = storesRes.rows;
    if (!stores.length) {
      return res.json({ success: true, results: [], total_count: 0, message: "无 active 店铺" });
    }

    console.log(`[Sync-Global] 开始全店同步, 共 ${stores.length} 店: ${stores.map(s => s.name).join(", ")}`);
    const results = [];
    let totalCount = 0;

    // 串行同步 (避免 Ozon API 限流)
    for (const store of stores) {
      try {
        // 内部复用 sync-all 的 HTTP 调用链 (v3/list + v3/info + v4/attributes + UPSERT)
        // 为避免重复代码, 直接内部 fetch 本服务
        const syncRes = await fetch(`http://localhost:${PORT}/api/seller/products/sync-all`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Cookie": req.headers.cookie || "",
          },
          body: JSON.stringify({ store_id: store.id }),
        });
        const syncData = await syncRes.json();
        const count = syncData.success ? (syncData.count || 0) : 0;
        results.push({
          store_id: store.id,
          store_name: store.name,
          count,
          error: syncData.success ? null : syncData.error,
        });
        totalCount += count;
        console.log(`[Sync-Global] ${store.name}: ${count} 条 ${syncData.success ? "✓" : "✗ " + (syncData.error || "")}`);
      } catch (e) {
        results.push({ store_id: store.id, store_name: store.name, count: 0, error: e.message });
        console.error(`[Sync-Global] ${store.name} 异常:`, e.message);
      }
    }

    console.log(`[Sync-Global] 完成: 共 ${stores.length} 店, 总计 ${totalCount} 条`);
    res.json({ success: true, results, total_count: totalCount });
  } catch (error) {
    console.error("[Sync-Global] 严重故障:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/seller/products/sync-all", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const storeId = req.body?.store_id || req.body?.storeId;
    if (!storeId) return res.status(400).json({ success: false, error: "未选择店铺" });
    const userId = req.user.id;

    let syncCount = 0;
    let lastId = "";
    let hasMore = true;
    let pageIndex = 0;

    console.log(`[Sync-All] 开始物理同步 Ozon 商品: store=${storeId}`);

    while (hasMore) {
      pageIndex++;
      // 1) 分页拉取 offer_id 列表 (v3/product/list)
      const listRes = await callOzonSellerAPI("/v3/product/list", {
        filter: { visibility: "ALL" },
        last_id: lastId,
        limit: 100,
      }, { storeId, userId });

      const listItems = listRes?.result?.items || [];
      if (!listItems.length) break;

      const offerIds = listItems.map(i => i.offer_id).filter(Boolean);
      console.log(`[Sync-All] 第 ${pageIndex} 批: ${offerIds.length} 条 offer_id (total_ozon=${listRes?.result?.total || "?"})`);

      // 2) 详情 v3/product/info/list (price/stocks/status/currency/model_id)
      const infoRes = await callOzonSellerAPI("/v3/product/info/list", {
        offer_id: offerIds,
      }, { storeId, userId });
      const infoItems = infoRes?.items || infoRes?.result?.items || [];
      const infoByOffer = new Map(infoItems.map(x => [x.offer_id, x]));

      // 3) 属性 v4/product/info/attributes (brand/description/country/dimensions/barcode/images)
      const attrRes = await callOzonSellerAPI("/v4/product/info/attributes", {
        filter: { offer_id: offerIds, visibility: "ALL" },
        limit: offerIds.length || 100,
      }, { storeId, userId });
      const attrItems = attrRes?.result || [];
      const attrByOffer = new Map(attrItems.map(x => [x.offer_id, x]));

      // 4) UPSERT 落库 (13 参数 -> 22 参数全字段)
      for (const offerId of offerIds) {
        const info = infoByOffer.get(offerId) || {};
        const attr = attrByOffer.get(offerId) || {};

        const primaryImage = Array.isArray(info.primary_image)
          ? (info.primary_image[0] || "")
          : (info.primary_image || attr.primary_image || "");
        const imagesArr = Array.isArray(info.images) ? info.images : (attr.images || []);
        const stocksArr = info?.stocks?.stocks || [];
        const stockNum = stocksArr.reduce((s, x) => s + (Number(x.present) || 0), 0);
        // 状态映射: 把 Ozon 内部 status (price_sent 等) 转为前端 Tab 认可的业务状态
        const statusStr = mapOzonStatus(info);
        const statusName = info?.statuses?.status_name || info?.statuses?.state_name || "";
        const priceIdx = info?.price_indexes?.color_index || "";
        const brand = pickAttrValue(attr.attributes, OZON_ATTR.BRAND);
        const description = pickAttrValue(attr.attributes, OZON_ATTR.DESCRIPTION);
        const country = pickAttrValue(attr.attributes, OZON_ATTR.COUNTRY_OF_ORIGIN);

        await db.query(
          `INSERT INTO app_products (
             user_id, store_id, offer_id, name, image, images,
             price, min_price, old_price, currency_code, vat, stock,
             brand, country_of_origin, description,
             status, status_name, category_name, description_category_id, type_id, price_index,
             product_id, sku, model_id, barcode,
             weight, depth, width, height, dimension_unit, weight_unit,
             visibility_details, stocks_json, updated_at, updated_at_ozon
           )
           VALUES (
             $1,$2,$3,$4,$5,$6,
             $7,$8,$9,$10,$11,$12,
             $13,$14,$15,
             $16,$17,$18,$19,$20,$21,
             $22,$23,$24,$25,
             $26,$27,$28,$29,$30,$31,
             $32, $33, now(), $34
           )
           ON CONFLICT (store_id, offer_id) DO UPDATE SET
             name = EXCLUDED.name, image = EXCLUDED.image, images = EXCLUDED.images,
             price = EXCLUDED.price, min_price = EXCLUDED.min_price, old_price = EXCLUDED.old_price,
             currency_code = EXCLUDED.currency_code, vat = EXCLUDED.vat, stock = EXCLUDED.stock,
             brand = EXCLUDED.brand, country_of_origin = EXCLUDED.country_of_origin, description = EXCLUDED.description,
             status = EXCLUDED.status, status_name = EXCLUDED.status_name,
             category_name = EXCLUDED.category_name, description_category_id = EXCLUDED.description_category_id,
             type_id = EXCLUDED.type_id, price_index = EXCLUDED.price_index,
             product_id = EXCLUDED.product_id, sku = EXCLUDED.sku, model_id = EXCLUDED.model_id,
             barcode = EXCLUDED.barcode,
             weight = EXCLUDED.weight, depth = EXCLUDED.depth, width = EXCLUDED.width, height = EXCLUDED.height,
             dimension_unit = EXCLUDED.dimension_unit, weight_unit = EXCLUDED.weight_unit,
             visibility_details = EXCLUDED.visibility_details,
             stocks_json = EXCLUDED.stocks_json,
             updated_at = now(), updated_at_ozon = EXCLUDED.updated_at_ozon`,
          [
            userId, storeId, offerId,
            String(info.name || attr.name || ""),
            primaryImage,
            JSON.stringify(imagesArr),
            Number(info.price || 0),
            info.min_price ? Number(info.min_price) : null,
            info.old_price ? Number(info.old_price) : null,
            String(info.currency_code || "RUB"),
            String(info.vat || "0"),
            stockNum,
            brand,
            country,
            description,
            statusStr,
            statusName,
            String(attr.category_name || info.category_name || ""),
            info.description_category_id ? BigInt(info.description_category_id).toString() : null,
            info.type_id ? BigInt(info.type_id).toString() : null,
            priceIdx,
            info.id ? BigInt(info.id).toString() : null,
            info.sku ? BigInt(info.sku).toString() : null,
            info?.model_info?.model_id ? BigInt(info.model_info.model_id).toString() : null,
            String(attr.barcode || ""),
            Number(attr.weight || 0),
            Number(attr.depth || 0),
            Number(attr.width || 0),
            Number(attr.height || 0),
            String(attr.dimension_unit || "mm"),
            String(attr.weight_unit || "g"),
            JSON.stringify(info.visibility_details || {}),
            JSON.stringify(stocksArr),           // v0.3.3 分仓原始数组
            info.updated_at || null,
          ]
        );
        syncCount++;
      }

      lastId = listRes?.result?.last_id || "";
      if (!lastId || listItems.length < 100) hasMore = false;
    }

    console.log(`[Sync-All] 完成: store=${storeId} 落库 ${syncCount} 条`);
    res.json({ success: true, count: syncCount });
  } catch (error) {
    console.error("[sync-all] 严重故障:", error);
    res.status(error.statusCode || 500).json({ success: false, error: error.message, payload: error.payload || null });
  }
});

app.get("/api/inventory", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const userId = req.user.id;
    const storeId = req.query.store_id || null;
    const search = String(req.query.search || "").trim();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const offset = Math.max(0, Number(req.query.offset || 0));

    if (!storeId) return res.status(400).json({ success: false, error: "未选择店铺" });

    let livePage = null;
    if (!search) {
      try {
        livePage = await fetchOzonProductListPage(storeId, userId, "ALL", limit, offset);
      } catch (error) {
        console.warn(`[inventory] Ozon ALL page fallback to local cache: ${error.message}`);
      }
    }

    let where = `WHERE user_id = $1 AND store_id = $2
      AND LOWER(COALESCE(status, '')) NOT IN ('in_active', 'archived', 'deleted')
      AND COALESCE((visibility_details->>'archived')::boolean, false) = false`;
    const params = [userId, storeId];
    if (livePage) {
      params.push(livePage.offerIds);
      where += ` AND offer_id = ANY($${params.length}::text[])`;
    }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (name ILIKE $${params.length} OR offer_id ILIKE $${params.length})`;
    }

    const countR = livePage
      ? { rows: [{ count: livePage.total }] }
      : await db.query(`SELECT count(*) FROM app_products ${where}`, params);
    const total = parseInt(countR.rows[0].count);

    const result = await db.query(
      `SELECT * FROM app_products ${where}
       ORDER BY ${livePage ? `array_position($${params.length}::text[], offer_id), updated_at DESC` : "updated_at DESC"}
       ${livePage ? "" : `LIMIT $${params.length + 1} OFFSET $${params.length + 2}`}`,
      livePage ? params : [...params, limit, offset]
    );

    res.json({ success: true, items: result.rows.map(enrichProductReadModel), total });
  } catch (e) { next(e); }
});

app.get("/api/seller/stocks/drafts", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const storeId = String(req.query.store_id || "").trim();
    if (!storeId) return res.status(400).json({ success: false, error: "未选择店铺" });
    const result = await db.query(
      `SELECT id, offer_id, product_id, warehouse_id, current_ozon_stock, target_stock,
              last_error, created_at, updated_at
       FROM app_stock_drafts
       WHERE user_id = $1 AND store_id = $2
       ORDER BY updated_at DESC`,
      [req.user.id, storeId],
    );
    res.json({ success: true, items: result.rows, total: result.rowCount });
  } catch (error) { next(error); }
});

app.get("/api/seller/stocks/change-logs", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const storeId = String(req.query.store_id || "").trim();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));
    if (!storeId) return res.status(400).json({ success: false, error: "未选择店铺" });
    const result = await db.query(
      `SELECT id, offer_id, warehouse_id, previous_stock, target_stock, status, error, created_at
       FROM app_stock_change_logs
       WHERE user_id = $1 AND store_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [req.user.id, storeId, limit],
    );
    res.json({ success: true, items: result.rows, total: result.rowCount });
  } catch (error) { next(error); }
});

app.post("/api/seller/stocks/save-draft", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const storeId = req.body?.store_id || req.body?.storeId;
    const stocks = Array.isArray(req.body?.stocks) ? req.body.stocks.slice(0, 500) : [];
    if (!storeId) return res.status(400).json({ success: false, error: "未选择店铺" });
    if (!stocks.length) return res.status(400).json({ success: false, error: "stocks 不能为空" });
    const saved = [];
    for (const stock of stocks) {
      const offerId = String(stock.offer_id || "").trim();
      const warehouseId = Number(stock.warehouse_id);
      const currentStock = Math.max(0, Math.floor(Number(stock.current_stock ?? stock.current_ozon_stock ?? 0)));
      const targetStock = Math.floor(Number(stock.target_stock ?? stock.new_stock));
      if (!offerId || !Number.isFinite(warehouseId) || warehouseId <= 0 || !Number.isFinite(targetStock) || targetStock < 0) {
        return res.status(400).json({ success: false, error: `库存草稿参数无效：${offerId || "未知货号"}` });
      }
      const result = await db.query(
        `INSERT INTO app_stock_drafts (
           user_id, store_id, offer_id, product_id, warehouse_id, current_ozon_stock, target_stock, last_error
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'')
         ON CONFLICT (user_id, store_id, offer_id, warehouse_id)
         DO UPDATE SET product_id = EXCLUDED.product_id,
                       current_ozon_stock = EXCLUDED.current_ozon_stock,
                       target_stock = EXCLUDED.target_stock,
                       last_error = '', updated_at = now()
         RETURNING id, offer_id, warehouse_id, current_ozon_stock, target_stock, updated_at`,
        [req.user.id, storeId, offerId, stock.product_id || null, warehouseId, currentStock, targetStock],
      );
      saved.push(result.rows[0]);
    }
    res.json({ success: true, items: saved, saved: saved.length });
  } catch (error) { next(error); }
});

app.post("/api/seller/stocks/import", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const storeId = req.body?.store_id || req.body?.storeId;
    const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 2000) : [];
    if (!storeId) return res.status(400).json({ success: false, error: "未选择店铺" });
    if (!rows.length) return res.status(400).json({ success: false, error: "导入文件没有有效数据" });
    const offerIds = [...new Set(rows.map(row => String(row.offer_id || row['Offer ID'] || row['货号'] || '').trim()).filter(Boolean))];
    const products = await db.query(
      `SELECT offer_id, product_id, stock, stocks_json FROM app_products
        WHERE user_id = $1 AND store_id = $2 AND offer_id = ANY($3::text[])`,
      [req.user.id, storeId, offerIds],
    );
    const productMap = new Map(products.rows.map(row => [row.offer_id, row]));
    let activeWarehouses = [];
    try {
      const warehouseData = await callOzonSellerAPI("/v2/warehouse/list", {}, { storeId, userId: req.user.id });
      activeWarehouses = (warehouseData?.warehouses || warehouseData?.result || [])
        .filter((warehouse) => !warehouse.status || String(warehouse.status).toLowerCase() === "active");
    } catch (error) {
      console.warn("[stocks/import] 获取仓库列表失败，继续使用商品已有仓库:", error.message);
    }
    const imported = [];
    const errors = [];
    for (let index = 0; index < rows.length; index += 1) {
      const source = rows[index] || {};
      const offerId = String(source.offer_id || source['Offer ID'] || source['货号'] || '').trim();
      const product = productMap.get(offerId);
      if (!offerId || !product) { errors.push({ row: index + 2, offer_id: offerId, error: '未找到当前店铺商品' }); continue; }
      const stocks = Array.isArray(product.stocks_json) ? product.stocks_json : [];
      const requestedWarehouse = Number(source.warehouse_id || source['Warehouse ID'] || source['仓库ID']);
      const knownWarehouseIds = [...new Set([
        ...stocks.map((item) => Number(item.warehouse_id)),
        ...activeWarehouses.map((item) => Number(item.warehouse_id)),
      ].filter((id) => Number.isFinite(id) && id > 0))];
      if (requestedWarehouse && !knownWarehouseIds.includes(requestedWarehouse)) {
        errors.push({ row: index + 2, offer_id: offerId, error: `仓库 ${requestedWarehouse} 不属于当前店铺` });
        continue;
      }
      if (!requestedWarehouse && knownWarehouseIds.length > 1) {
        errors.push({ row: index + 2, offer_id: offerId, error: '当前店铺有多个仓库，请在文件中填写 warehouse_id' });
        continue;
      }
      const warehouseId = Number(requestedWarehouse || knownWarehouseIds[0]);
      const warehouse = stocks.find(item => Number(item.warehouse_id) === warehouseId);
      if (!Number.isFinite(warehouseId) || warehouseId <= 0) { errors.push({ row: index + 2, offer_id: offerId, error: '当前店铺没有可用仓库' }); continue; }
      const currentStock = Number(warehouse?.present ?? product.stock ?? 0);
      const quantityRaw = source.stock ?? source.quantity ?? source.Quantity ?? source['目标库存'];
      const diffRaw = source.diff ?? source.Diff ?? source['变更量'];
      const targetStock = quantityRaw !== undefined && quantityRaw !== '' ? Number(quantityRaw) : currentStock + Number(diffRaw);
      if (!Number.isFinite(targetStock) || targetStock < 0 || !Number.isInteger(targetStock)) { errors.push({ row: index + 2, offer_id: offerId, error: '目标库存必须是非负整数' }); continue; }
      const saved = await db.query(
        `INSERT INTO app_stock_drafts (user_id, store_id, offer_id, product_id, warehouse_id, current_ozon_stock, target_stock, last_error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'')
         ON CONFLICT (user_id, store_id, offer_id, warehouse_id)
         DO UPDATE SET product_id=EXCLUDED.product_id, current_ozon_stock=EXCLUDED.current_ozon_stock,
                       target_stock=EXCLUDED.target_stock, last_error='', updated_at=now()
         RETURNING id, offer_id, warehouse_id, current_ozon_stock, target_stock`,
        [req.user.id, storeId, offerId, product.product_id || null, warehouseId, Math.max(0, Math.floor(currentStock)), targetStock],
      );
      imported.push(saved.rows[0]);
    }
    res.json({ success: true, imported: imported.length, failed: errors.length, items: imported, errors });
  } catch (error) { next(error); }
});

app.delete("/api/seller/stocks/drafts", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const storeId = req.body?.store_id || req.body?.storeId;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
    if (!storeId) return res.status(400).json({ success: false, error: "未选择店铺" });
    const params = [req.user.id, storeId];
    let idWhere = "";
    if (ids.length) { params.push(ids); idWhere = ` AND id = ANY($3::uuid[])`; }
    const result = await db.query(
      `DELETE FROM app_stock_drafts WHERE user_id = $1 AND store_id = $2${idWhere} RETURNING id`,
      params,
    );
    res.json({ success: true, deleted: result.rowCount });
  } catch (error) { next(error); }
});

app.post("/api/seller/products/stocks/bulk", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const storeId = req.body?.store_id || req.body?.storeId;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
    const force = req.body?.force === true;
    if (!storeId) return res.status(400).json({ success: false, error: "未选择店铺" });
    const params = [req.user.id, storeId];
    let idWhere = "";
    if (ids.length) { params.push(ids); idWhere = ` AND id = ANY($3::uuid[])`; }
    const draftResult = await db.query(
      `SELECT * FROM app_stock_drafts WHERE user_id = $1 AND store_id = $2${idWhere} ORDER BY created_at`,
      params,
    );
    if (!draftResult.rowCount) return res.status(400).json({ success: false, error: "没有待提交库存草稿" });

    const drafts = draftResult.rows;
    const liveStocks = await fetchLiveStocksByOffer(storeId, req.user.id, drafts.map((row) => row.offer_id));
    const conflicts = findStockConflicts(drafts, liveStocks);
    if (conflicts.length && !force) {
      for (const conflict of conflicts) {
        await db.query(
          `INSERT INTO app_stock_change_logs (
             user_id, store_id, offer_id, warehouse_id, previous_stock, target_stock, status, error
           ) VALUES ($1,$2,$3,$4,$5,$6,'conflict',$7)`,
          [req.user.id, storeId, conflict.offer_id, conflict.warehouse_id, conflict.live_stock, conflict.target_stock, `草稿基线 ${conflict.expected_stock}，Ozon 实时 ${conflict.live_stock}`],
        );
      }
      return res.status(409).json({ success: false, code: "STOCK_CONFLICT", error: "Ozon 实时库存已发生变化", conflicts });
    }
    if (conflicts.length) {
      const currentByKey = new Map(conflicts.map((row) => [`${row.offer_id}|${row.warehouse_id}`, row.live_stock]));
      for (const draft of drafts) {
        const actual = currentByKey.get(`${draft.offer_id}|${Number(draft.warehouse_id)}`);
        if (actual !== undefined) draft.current_ozon_stock = actual;
      }
    }
    const successes = [];
    const failures = [];
    for (let index = 0; index < drafts.length; index += 100) {
      const batch = drafts.slice(index, index + 100);
      const payload = batch.map((row) => ({
        offer_id: row.offer_id,
        ...(row.product_id ? { product_id: Number(row.product_id) } : {}),
        warehouse_id: Number(row.warehouse_id),
        stock: Number(row.target_stock),
      }));
      try {
        await callOzonSellerAPI("/v2/products/stocks", { stocks: payload }, { storeId, userId: req.user.id });
        successes.push(...batch);
      } catch (error) {
        const message = String(error.payload?.message || error.message || "库存同步失败").slice(0, 1000);
        failures.push(...batch.map((row) => ({ ...row, error: message })));
      }
    }

    for (const row of successes) {
      await db.query(
        `INSERT INTO app_stock_change_logs (
           user_id, store_id, offer_id, warehouse_id, previous_stock, target_stock, status
         ) VALUES ($1,$2,$3,$4,$5,$6,'success')`,
        [req.user.id, storeId, row.offer_id, row.warehouse_id, row.current_ozon_stock, row.target_stock],
      );
      await db.query(`DELETE FROM app_stock_drafts WHERE id = $1 AND user_id = $2`, [row.id, req.user.id]);
    }
    for (const row of failures) {
      await db.query(
        `UPDATE app_stock_drafts SET last_error = $1, updated_at = now() WHERE id = $2 AND user_id = $3`,
        [row.error, row.id, req.user.id],
      );
      await db.query(
        `INSERT INTO app_stock_change_logs (
           user_id, store_id, offer_id, warehouse_id, previous_stock, target_stock, status, error
         ) VALUES ($1,$2,$3,$4,$5,$6,'failed',$7)`,
        [req.user.id, storeId, row.offer_id, row.warehouse_id, row.current_ozon_stock, row.target_stock, row.error],
      );
    }
    res.status(failures.length ? 207 : 200).json({
      success: failures.length === 0,
      submitted: drafts.length,
      succeeded: successes.length,
      failed: failures.length,
      errors: failures.map((row) => ({ id: row.id, offer_id: row.offer_id, warehouse_id: row.warehouse_id, error: row.error })),
    });
  } catch (error) { next(error); }
});

app.post("/api/seller/orders/tracking", requireAuth, async (req, res, next) => {
  res.status(501).json({ success: false, error: "当前 Ozon Seller API 未提供可靠的逐节点物流轨迹，已移除模拟数据" });
});

/**
 * v0.3.6 商品套图批量生成 - 万相 2.7 真实调用
 * 输入: {
 *   title_zh, title_ru, title_en,
 *   material_images: [url],       // 素材图 (本地 /uploads 或公网)
 *   selling_points: string,       // 卖点 (换行分隔)
 *   image_type: 'main' | 'detail',
 *   target_market: 'ozon' | 'etsy',
 *   count: 1-6
 * }
 * 输出: { success: true, images: [url,url,...] } - 严禁 null
 */
app.post("/api/ai/product-image-set/generate", requireAuth, async (req, res) => {
  res.status(410).json({
    success: false,
    error: "旧套图接口已停用，请使用 /api/seller/images/generate",
  });
});

/* ============================================================
   系统工具 - 下载代理 (解决 OSS 跨域下载拦截)
   ============================================================ */
function isPrivateNetworkAddress(address) {
  const normalized = String(address || "").toLowerCase().replace(/^::ffff:/, "");
  if (net.isIPv4(normalized)) {
    const [a, b] = normalized.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (net.isIPv6(normalized)) {
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fc")
      || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized);
  }
  return true;
}

async function assertSafeExternalUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(String(rawUrl || "")); } catch { throw new Error("下载地址无效"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("仅支持 HTTP/HTTPS 下载地址");
  if (["localhost", "localhost.localdomain"].includes(parsed.hostname.toLowerCase())) throw new Error("不允许访问本机地址");
  const addresses = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateNetworkAddress(address))) {
    throw new Error("不允许访问内网地址");
  }
  return parsed;
}

async function fetchSafeExternalFile(rawUrl, maxRedirects = 3) {
  let target = await assertSafeExternalUrl(rawUrl);
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const response = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(30000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === maxRedirects) throw new Error("下载重定向次数过多");
      target = await assertSafeExternalUrl(new URL(location, target).toString());
      continue;
    }
    return response;
  }
  throw new Error("下载失败");
}

app.get("/api/utils/download-proxy", requireAuth, async (req, res) => {
  try {
    const { url, filename } = req.query;
    if (!url) return res.status(400).send("Missing URL");

    const response = await fetchSafeExternalFile(url);
    if (!response.ok) throw new Error(`Failed to fetch original image: ${response.status}`);

    const maxBytes = 25 * 1024 * 1024;
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > maxBytes) throw new Error("文件超过 25MB 限制");
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > maxBytes) throw new Error("文件超过 25MB 限制");
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    const safeFilename = String(filename || `ai_image_${Date.now()}.jpg`)
      .replace(/[\r\n"\\/]/g, "_")
      .slice(0, 180);

    res.setHeader("Content-Type", response.headers.get("content-type") || "image/jpeg");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safeFilename)}`);
    res.send(buffer);
  } catch (error) {
    console.error("[download-proxy] 失败:", error.message);
    res.status(500).send(error.message);
  }
});

app.get("/api/utils/image-proxy", requireAuth, async (req, res) => {
  try {
    const rawUrl = String(req.query.url || "").trim();
    if (!rawUrl) return res.status(400).send("Missing URL");
    const target = await assertSafeExternalUrl(rawUrl);
    const hostname = target.hostname.toLowerCase();
    const allowed = hostname.endsWith(".1688.com")
      || hostname === "1688.com"
      || hostname.endsWith(".alicdn.com")
      || hostname === "alicdn.com"
      || hostname.endsWith(".alibaba.com")
      || hostname === "alibaba.com";
    if (!allowed) return res.status(400).send("不支持代理该图片域名");
    const response = await fetch(target, {
      signal: AbortSignal.timeout(30000),
      headers: {
        "User-Agent": USER_AGENT,
        Referer: "https://www.1688.com/",
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      },
    });
    if (!response.ok) throw new Error(`图片读取失败 ${response.status}`);
    const contentType = response.headers.get("content-type") || "image/jpeg";
    if (!/^image\//i.test(contentType)) throw new Error("目标不是图片");
    const maxBytes = 8 * 1024 * 1024;
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > maxBytes) throw new Error("图片超过 8MB 限制");
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > maxBytes) throw new Error("图片超过 8MB 限制");
      chunks.push(chunk);
    }
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(Buffer.concat(chunks));
  } catch (error) {
    console.warn(`[image-proxy] 失败: ${error.message}`);
    res.status(502).send("图片代理失败");
  }
});
app.patch("/api/products/:offer_id/field", requireAuth, updateProductField);

/**
 * v2.2.9: 类目示例商品 — 给 picker 候选显示 5 个真实商品名 (俄文), 让用户
 *   不用懂俄文也能按业务含义选类目 (例: "Когтерез-секатор" → 用户认"宠物指甲钳对")
 *   入参: ?store_id=X&description_category_id=Y&limit=5
 *   出参: { examples: [{sku, offer_id, name, image}] }
 */
app.get("/api/seller/products/category-examples", requireAuth, async (req, res, next) => {
  try {
    const storeId = req.query?.store_id || req.query?.storeId;
    const catId = Number(req.query?.description_category_id || req.query?.catId);
    const limit = Math.min(Number(req.query?.limit) || 5, 20);
    if (!storeId || !catId) {
      return res.status(400).json({ success: false, error: "需要 store_id + description_category_id" });
    }
    if (!db) return res.json({ success: true, examples: [] });
    const r = await db.query(
      `SELECT sku, offer_id, name, images
         FROM app_products
        WHERE user_id = $1 AND store_id = $2 AND description_category_id = $3 AND name != ''
        ORDER BY updated_at DESC NULLS LAST
        LIMIT $4`,
      [req.user.id, storeId, catId, limit],
    );
    res.json({
      success: true,
      examples: r.rows.map(x => ({
        sku: String(x.sku || ""),
        offer_id: x.offer_id || "",
        name: x.name || "",
        image: (Array.isArray(x.images) && x.images[0]) || "",
      })),
    });
  } catch (e) {
    console.error("[category-examples]", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});


const categoryAnalyticsCache = new Map();
const categoryOpportunityCache = new Map();
app.post("/api/seller/analytics/categories", requireAuth, async (req, res, next) => {
  try {
    const { range = "28", dimension = "category1", filter_type: filterType = "all" } = req.body;
    const storeId = req.body?.store_id || req.body?.storeId;
    const days = Math.min(90, Math.max(7, Number.parseInt(range, 10) || 28));
    const cacheKey = `${req.user.id}:${storeId}:${days}:${dimension}`;
    let cached = categoryAnalyticsCache.get(cacheKey);
    if (!cached || Date.now() - cached.createdAt > 10 * 60 * 1000) {
      const end = new Date();
      const start = new Date(end.getTime() - days * 86400e3);
      const previousStart = new Date(start.getTime() - days * 86400e3);
      const request = (dateFrom, dateTo) => callOzonSellerAPI("/v1/analytics/data", {
      date_from: dateFrom.toISOString().split('T')[0],
      date_to: dateTo.toISOString().split('T')[0],
      metrics: ["ordered_units", "revenue", "returns_units"],
      dimension: [dimension],
      filters: [],
      sort: [{ key: "revenue", order: "DESC" }],
      limit: 100,
      offset: 0
      }, { storeId, userId: req.user.id });
      const [data, previous] = await Promise.all([request(start, end), request(previousStart, start)]);
      const previousRows = previous?.result?.data || [];
      const previousMap = new Map(previousRows.map(row => [String(row.dimensions?.[0]?.id || row.dimensions?.[0]?.name || ''), Number(row.metrics?.[1] || 0)]));
      const items = (data?.result?.data || []).map(row => {
        const dimensionRow = row.dimensions?.[0] || {};
        const categoryId = String(dimensionRow.id || dimensionRow.name || '');
        const orderedUnits = Number(row.metrics?.[0] || 0);
        const revenue = Number(row.metrics?.[1] || 0);
        const returns = Number(row.metrics?.[2] || 0);
        const previousRevenue = previousMap.get(categoryId) || 0;
        return {
          category_id: categoryId,
          category_path: dimensionRow.name || '未分类',
          ordered_units: orderedUnits,
          revenue,
          previous_revenue: previousRevenue,
          gmv_growth: previousRevenue > 0 ? (revenue - previousRevenue) / previousRevenue : (revenue > 0 ? 1 : 0),
          avg_price: orderedUnits > 0 ? revenue / orderedUnits : 0,
          returns_units: returns,
          return_rate: orderedUnits > 0 ? returns / orderedUnits : 0,
          seller_count: null,
          cr5: null,
          fbs_ratio: null,
        };
      });
      cached = { createdAt: Date.now(), data, items };
      categoryAnalyticsCache.set(cacheKey, cached);
      if (categoryAnalyticsCache.size > 200) categoryAnalyticsCache.delete(categoryAnalyticsCache.keys().next().value);
    }
    let items = cached.items;
    if (filterType === 'growth') items = items.filter(item => item.gmv_growth >= 0.3);
    else if (filterType === 'high_return') items = items.filter(item => item.return_rate >= 0.15);
    else if (filterType === 'brand_concentrated') items = [];
    else if (filterType === 'fbs_opportunity') items = [];
    res.json({ success: true, data: cached.data, items, cached_at: new Date(cached.createdAt).toISOString(), unavailable_metrics: ['seller_count', 'cr5', 'fbs_ratio'] });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post("/api/seller/analytics/bestsellers", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const storeId = String(req.body?.store_id || req.body?.storeId || "").trim();
    const limit = Math.min(200, Math.max(1, Number(req.body?.limit || 100)));
    const offset = Math.max(0, Number(req.body?.offset || 0));
    if (!storeId) return res.status(400).json({ success: false, error: "未选择店铺" });
    const owned = await db.query(
      "SELECT id FROM app_stores WHERE id = $1 AND user_id = $2 AND active = TRUE",
      [storeId, req.user.id],
    );
    if (!owned.rowCount) return res.status(404).json({ success: false, error: "店铺不存在、已停用或无权限" });
    const to = new Date();
    const since = new Date(to.getTime() - 90 * 86400e3);
    const ozonData = await callOzonSellerAPI("/v3/posting/fbs/list", {
      dir: "DESC",
      filter: { since: since.toISOString(), to: to.toISOString() },
      limit: 1000,
      offset: 0,
      with: { financial_data: false, analytics_data: false },
    }, { storeId, userId: req.user.id });
    const salesMap = new Map();
    for (const posting of (ozonData?.result?.postings || [])) {
      for (const product of (posting?.products || [])) {
        const offerId = String(product?.offer_id || "").trim();
        if (!offerId) continue;
        const current = salesMap.get(offerId) || { offer_id: offerId, sku: String(product?.sku || ""), name: product?.name || offerId, sales: 0 };
        current.sales += Math.max(0, Number(product?.quantity || 0));
        salesMap.set(offerId, current);
      }
    }
    const ranked = [...salesMap.values()].sort((a, b) => b.sales - a.sales || a.offer_id.localeCompare(b.offer_id));
    const page = ranked.slice(offset, offset + limit);
    const offerIds = page.map((row) => row.offer_id);
    const local = offerIds.length ? await db.query(
      `SELECT offer_id, name, sku, stock FROM app_products
        WHERE user_id = $1 AND store_id = $2 AND offer_id = ANY($3::text[])`,
      [req.user.id, storeId, offerIds],
    ) : { rows: [] };
    const localMap = new Map(local.rows.map((row) => [row.offer_id, row]));
    const items = page.map((row) => {
      const product = localMap.get(row.offer_id) || {};
      return { ...row, name: product.name || row.name, sku: String(product.sku || row.sku || ""), stock: Number(product.stock || 0) };
    });
    res.json({
      success: true,
      data: { result: { items, total: ranked.length, period_days: 90 } },
    });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post("/api/sourcing/overview", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const rangeDays = Math.min(180, Math.max(7, Number.parseInt(req.body?.range || "30", 10) || 30));
    const now = new Date();
    const currentStart = new Date(now.getTime() - rangeDays * 86400e3);
    const previousStart = new Date(currentStart.getTime() - rangeDays * 86400e3);
    const rateResult = await db.query(
      `SELECT rate FROM app_exchange_rates
        WHERE base_currency = 'RUB' AND quote_currency = 'CNY'
        ORDER BY effective_at DESC LIMIT 1`,
    );
    const effectiveRubCnyRate = Number(rateResult.rows[0]?.rate || RUB_CNY_RATE);
    const money = (value) => Math.round(Number(value || 0) * 100) / 100;
    const salesCny = (row) => Number(row.price_rub || 0) * Number(row.monthly_sales || 0) * effectiveRubCnyRate;
    const capturedAt = (row) => row.source_captured_at || row.updated_at || row.created_at || null;

    const rowsRes = await db.query(
      `WITH latest_platform_category AS (
         SELECT MAX(source_captured_at) AS latest_at
           FROM app_platform_categories
          WHERE active = TRUE
       )
       SELECT id, sku, title, main_image, price_rub, monthly_sales, review_count, seller_count,
              category_id, category_name, strategy_type, ozon_url, seller_name, origin_country,
              source_name, source_url, source_captured_at, created_at, updated_at, 'top_item' AS row_type
         FROM app_top_lists
        WHERE active = TRUE
       UNION ALL
       SELECT c.id,
              'category:' || c.category_id AS sku,
              c.category_name AS title,
              '' AS main_image,
              c.avg_price_rub AS price_rub,
              FLOOR(c.sales_units)::int AS monthly_sales,
              0 AS review_count,
              FLOOR(COALESCE(c.sellers, 0))::int AS seller_count,
              c.category_id,
              c.category_name,
              'hot' AS strategy_type,
              '' AS ozon_url,
              '' AS seller_name,
              '' AS origin_country,
              c.source_name,
              c.source_url,
              c.source_captured_at,
              c.created_at,
              c.updated_at,
              'category_snapshot' AS row_type
         FROM app_platform_categories c
         JOIN latest_platform_category l ON c.source_captured_at = l.latest_at
        WHERE c.active = TRUE`,
    );
    const rows = rowsRes.rows || [];
    const latestSource = rows.reduce((latest, row) => {
      const t = capturedAt(row) ? new Date(capturedAt(row)).getTime() : 0;
      return t > latest ? t : latest;
    }, 0);

    const categories = new Map();
    const products = [];
    const sellers = new Map();
    const trendBuckets = new Map();
    for (let i = rangeDays - 1; i >= 0; i -= 1) {
      const d = new Date(now.getTime() - i * 86400e3);
      const key = d.toISOString().slice(0, 10);
      trendBuckets.set(key, { date: key.slice(5), sales_cny: 0, units: 0, product_count: 0 });
    }
    const priceBands = [
      { label: "0-20", min: 0, max: 20 },
      { label: "20-50", min: 20, max: 50 },
      { label: "50-100", min: 50, max: 100 },
      { label: "100-200", min: 100, max: 200 },
      { label: "200-500", min: 200, max: 500 },
      { label: "500+", min: 500, max: Infinity },
    ].map((band) => ({ ...band, product_count: 0, sales_cny: 0, units: 0 }));
    const bandFor = (price) => priceBands.find((band) => price >= band.min && price < band.max) || priceBands[priceBands.length - 1];

    for (const row of rows) {
      const categoryId = String(row.category_id || row.category_name || "uncategorized");
      const categoryZh = categoryNameZh(row.category_name, row.category_id);
      const sellerName = String(row.seller_name || "未知卖家");
      const units = Math.max(0, Number(row.monthly_sales || 0));
      const amount = salesCny(row);
      const priceCny = Number(row.price_rub || 0) * effectiveRubCnyRate;
      const sourceTime = capturedAt(row) ? new Date(capturedAt(row)) : null;

      if (!categories.has(categoryId)) {
        categories.set(categoryId, {
          category_id: categoryId,
          category_name: row.category_name || "",
          category_name_zh: categoryZh,
          gmv_cny: 0,
          previous_gmv_cny: 0,
          units: 0,
          product_count: 0,
          sellers: new Set(),
          top_products: [],
        });
      }
      const category = categories.get(categoryId);
      category.gmv_cny += amount;
      category.units += units;
      category.product_count += 1;
      category.sellers.add(sellerName);
      category.top_products.push({
        name: row.title || row.sku,
        image: row.main_image || "",
        gmv_cny: amount,
      });

      if (sourceTime && sourceTime >= previousStart && sourceTime < currentStart) {
        category.previous_gmv_cny += amount;
      }

      if (!sellers.has(sellerName)) {
        sellers.set(sellerName, {
          store_id: sellerName,
          store_name: sellerName,
          seller_name: sellerName,
          gmv_cny: 0,
          order_count: 0,
          units: 0,
          moving_skus: new Set(),
          product_count: 0,
          review_count: 0,
        });
      }
      const seller = sellers.get(sellerName);
      seller.gmv_cny += amount;
      seller.units += units;
      seller.order_count += units;
      seller.product_count += 1;
      seller.review_count += Number(row.review_count || 0);
      if (units > 0) seller.moving_skus.add(row.sku);

      const band = bandFor(priceCny);
      band.product_count += 1;
      band.sales_cny += amount;
      band.units += units;

      const trendKey = sourceTime ? sourceTime.toISOString().slice(0, 10) : "";
      if (trendBuckets.has(trendKey)) {
        const point = trendBuckets.get(trendKey);
        point.sales_cny += amount;
        point.units += units;
        point.product_count += 1;
      }

      if (row.row_type !== "category_snapshot") {
        products.push({
          key: String(row.sku || row.id),
          sku: String(row.sku || ""),
          name: row.title || row.sku || "",
          image: row.main_image || "",
          ozon_url: row.ozon_url || (row.sku ? `https://www.ozon.ru/product/${row.sku}/` : ""),
          store_name: sellerName,
          seller_name: sellerName,
          category_id: categoryId,
          category_name: row.category_name || "",
          category_name_zh: categoryZh,
          price_rub: Number(row.price_rub || 0),
          price_cny: money(priceCny),
          gmv_cny: money(amount),
          sales_cny: money(amount),
          units,
          order_count: units,
          review_count: Number(row.review_count || 0),
          seller_count: Number(row.seller_count || 0),
          strategy_type: row.strategy_type || "hot",
          source_name: row.source_name || "",
          source_captured_at: row.source_captured_at,
        });
      }
    }

    const categoryItems = [...categories.values()]
      .map((row) => {
        const growth = row.previous_gmv_cny > 0
          ? (row.gmv_cny - row.previous_gmv_cny) / row.previous_gmv_cny
          : null;
        return {
          category_id: row.category_id,
          category_name: row.category_name,
          category_name_zh: row.category_name_zh,
          gmv_cny: money(row.gmv_cny),
          sales_cny: money(row.gmv_cny),
          previous_gmv_cny: money(row.previous_gmv_cny),
          growth_rate: growth == null ? null : Math.round(growth * 10000) / 100,
          units: row.units,
          order_count: row.units,
          product_count: row.product_count,
          store_count: row.sellers.size,
          seller_count: row.sellers.size,
          profit_cny: null,
          profit_rate: null,
          opportunity_score: Math.max(0, Math.min(100, Math.round((Math.log10(row.gmv_cny + 1) * 18 + Math.log10(row.units + 1) * 16 + row.sellers.size * 2) * 10) / 10)),
          top_products: row.top_products
            .sort((a, b) => b.gmv_cny - a.gmv_cny)
            .slice(0, 3)
            .map((product) => ({ ...product, gmv_cny: money(product.gmv_cny) })),
        };
      })
      .sort((a, b) => b.gmv_cny - a.gmv_cny);
    const productItems = products.sort((a, b) => b.gmv_cny - a.gmv_cny).slice(0, 100);
    const sellerItems = [...sellers.values()]
      .map((row) => ({
        ...row,
        moving_skus: row.moving_skus.size,
        gmv_cny: money(row.gmv_cny),
        sales_cny: money(row.gmv_cny),
        avg_order_cny: row.units > 0 ? money(row.gmv_cny / row.units) : 0,
      }))
      .sort((a, b) => b.gmv_cny - a.gmv_cny);
    const totalSales = products.reduce((sum, row) => sum + Number(row.gmv_cny || 0), 0);
    const totalUnits = products.reduce((sum, row) => sum + Number(row.units || 0), 0);
    const movingSkus = new Set(products.filter((row) => Number(row.units || 0) > 0).map((row) => row.sku));

    res.json({
      success: true,
      source_scope: "ozon_platform",
      range_days: rangeDays,
      stores: [],
      summary: {
        gmv_cny: money(totalSales),
        sales_cny: money(totalSales),
        order_count: totalUnits,
        units: totalUnits,
        moving_skus: movingSkus.size,
        avg_order_cny: totalUnits > 0 ? money(totalSales / totalUnits) : 0,
        profit_cny: null,
        profit_rate: null,
        active_products: rows.length,
        stock_warning: 0,
        seller_count: sellers.size,
        category_count: categories.size,
      },
      categories: categoryItems,
      products: productItems,
      store_ranking: sellerItems,
      trends: [...trendBuckets.values()].map((row) => ({ ...row, gmv_cny: money(row.sales_cny), sales_cny: money(row.sales_cny) })),
      price_distribution: priceBands.map((band) => ({
        label: band.label,
        product_count: band.product_count,
        sales_cny: money(band.sales_cny),
        gmv_cny: money(band.sales_cny),
        units: band.units,
      })),
      data_source: {
        platform: "app_platform_categories",
        exchange_rate: effectiveRubCnyRate,
        latest_platform_captured_at: latestSource ? new Date(latestSource).toISOString() : null,
        note: "Ozon 平台榜单数据源；不使用自有店铺订单缓存。",
      },
    });
  } catch (error) { next(error); }
});

app.post("/api/sourcing/overview-legacy-store", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const userId = req.user.id;
    const rawStoreIds = String(req.body?.store_id || req.body?.storeId || "").trim();
    const requestedStoreIds = rawStoreIds && !["all", "全部店铺"].includes(rawStoreIds)
      ? rawStoreIds.split(",").map((id) => id.trim()).filter(Boolean)
      : [];
    const rangeDays = Math.min(180, Math.max(7, Number.parseInt(req.body?.range || "30", 10) || 30));
    const now = new Date();
    const currentStart = new Date(now.getTime() - rangeDays * 86400e3);
    const previousStart = new Date(currentStart.getTime() - rangeDays * 86400e3);

    const storeParams = [userId];
    let storeWhere = "user_id = $1 AND active = TRUE";
    if (requestedStoreIds.length) {
      storeParams.push(requestedStoreIds);
      storeWhere += ` AND id = ANY($${storeParams.length}::uuid[])`;
    }
    const storesRes = await db.query(
      `SELECT id, name FROM app_stores WHERE ${storeWhere} ORDER BY updated_at DESC`,
      storeParams,
    );
    const stores = storesRes.rows;
    if (!stores.length) {
      return res.json({
        success: true,
        range_days: rangeDays,
        stores: [],
        summary: {},
        categories: [],
        products: [],
        store_ranking: [],
        trends: [],
        price_distribution: [],
        data_source: { orders: "app_order_cache", products: "app_products", note: "未选择可用店铺" },
      });
    }
    const storeIds = stores.map((store) => store.id);
    const storeNameById = new Map(stores.map((store) => [String(store.id), store.name]));

    const rateResult = await db.query(
      `SELECT rate FROM app_exchange_rates
        WHERE base_currency = 'RUB' AND quote_currency = 'CNY'
        ORDER BY effective_at DESC LIMIT 1`,
    );
    const effectiveRubCnyRate = Number(rateResult.rows[0]?.rate || RUB_CNY_RATE);
    const money = (value) => Math.round(Number(value || 0) * 100) / 100;
    const toCny = (amount, currency = "RUB") => {
      const n = Number(amount || 0);
      if (!Number.isFinite(n)) return 0;
      const code = String(currency || "RUB").toUpperCase();
      if (code === "RUB") return n * effectiveRubCnyRate;
      return n;
    };
    const normalizeStatus = (status = "") => String(status || "").toLowerCase();
    const isVisibleProduct = (status = "") => !["in_active", "archived", "deleted"].includes(String(status || "").toLowerCase());

    const productsRes = await db.query(
      `SELECT p.store_id, s.name AS store_name, p.offer_id, p.sku, p.name, p.image, p.price, p.currency_code,
              p.stock, p.status, p.category_name, p.description_category_id, p.purchase_price_cny, p.updated_at
         FROM app_products p
         JOIN app_stores s ON s.id = p.store_id
        WHERE p.user_id = $1 AND p.store_id = ANY($2::uuid[])`,
      [userId, storeIds],
    );
    const productMap = new Map();
    const allProducts = productsRes.rows.map((row) => {
      const categoryId = row.description_category_id ? String(row.description_category_id) : "";
      const categoryZh = categoryNameZh(row.category_name, categoryId);
      const item = {
        store_id: String(row.store_id),
        store_name: row.store_name,
        offer_id: String(row.offer_id || ""),
        sku: String(row.sku || ""),
        name: row.name || row.offer_id || "",
        image: row.image || "",
        price_cny: money(toCny(row.price, row.currency_code || "RUB")),
        stock: Number(row.stock || 0),
        status: row.status || "",
        category_id: categoryId || "uncategorized",
        category_name: row.category_name || "",
        category_name_zh: categoryZh,
        purchase_price_cny: Number(row.purchase_price_cny || 0),
        updated_at: row.updated_at,
      };
      productMap.set(`${item.store_id}:${item.offer_id}`, item);
      return item;
    });

    const cacheRes = await db.query(
      `SELECT c.store_id, c.status, c.in_process_at, c.payload, c.synced_at
         FROM app_order_cache c
        WHERE c.user_id = $1
          AND c.store_id = ANY($2::uuid[])
          AND c.in_process_at >= $3`,
      [userId, storeIds, previousStart.toISOString()],
    );
    const latestOrderSync = cacheRes.rows.reduce((latest, row) => {
      const t = row.synced_at ? new Date(row.synced_at).getTime() : 0;
      return t > latest ? t : latest;
    }, 0);

    const categories = new Map();
    const products = new Map();
    const storeRanking = new Map(stores.map((store) => [String(store.id), {
      store_id: String(store.id),
      store_name: store.name,
      gmv_cny: 0,
      profit_cny: 0,
      order_count: 0,
      units: 0,
      moving_skus: new Set(),
      active_products: 0,
      stock_warning: 0,
    }]));
    const trendBuckets = new Map();
    for (let i = rangeDays - 1; i >= 0; i -= 1) {
      const d = new Date(now.getTime() - i * 86400e3);
      const key = d.toISOString().slice(0, 10);
      trendBuckets.set(key, { date: key.slice(5), gmv_cny: 0, orders: 0, units: 0 });
    }
    const priceBands = [
      { label: "0-20", min: 0, max: 20 },
      { label: "20-50", min: 20, max: 50 },
      { label: "50-100", min: 50, max: 100 },
      { label: "100-200", min: 100, max: 200 },
      { label: "200-500", min: 200, max: 500 },
      { label: "500+", min: 500, max: Infinity },
    ].map((band) => ({ ...band, product_count: 0, sales_cny: 0, units: 0 }));
    const bandFor = (price) => priceBands.find((band) => price >= band.min && price < band.max) || priceBands[priceBands.length - 1];
    for (const product of allProducts) {
      const storeRow = storeRanking.get(product.store_id);
      if (storeRow && isVisibleProduct(product.status)) {
        storeRow.active_products += 1;
        if (product.stock < 10) storeRow.stock_warning += 1;
      }
      bandFor(product.price_cny).product_count += 1;
    }

    const ensureCategory = (product, fallbackStoreId) => {
      const key = product?.category_id || "uncategorized";
      if (!categories.has(key)) {
        categories.set(key, {
          category_id: key,
          category_name: product?.category_name || "",
          category_name_zh: product?.category_name_zh || categoryNameZh(product?.category_name || "", key === "uncategorized" ? "" : key),
          gmv_cny: 0,
          previous_gmv_cny: 0,
          units: 0,
          order_count: 0,
          product_count: 0,
          profit_cny: 0,
          stores: new Set(),
          top_product_keys: new Set(),
        });
      }
      const row = categories.get(key);
      if (fallbackStoreId) row.stores.add(String(fallbackStoreId));
      return row;
    };
    for (const product of allProducts) {
      const cat = ensureCategory(product, product.store_id);
      cat.product_count += 1;
    }

    const productImage = (payloadProduct = {}, meta = {}) => (
      meta.image || payloadProduct.image || payloadProduct.primary_image || payloadProduct.picture || ""
    );
    const productName = (payloadProduct = {}, meta = {}) => (
      meta.name || payloadProduct.name || payloadProduct.offer_id || payloadProduct.sku || "未命名商品"
    );
    const productPriceCny = (payloadProduct = {}, meta = {}) => {
      if (Number(payloadProduct.price_cny) > 0) return Number(payloadProduct.price_cny);
      if (Number(payloadProduct.subtotal_cny) > 0 && Number(payloadProduct.quantity || 1) > 0) {
        return Number(payloadProduct.subtotal_cny) / Number(payloadProduct.quantity || 1);
      }
      const currency = payloadProduct.currency_code || payloadProduct.price?.currency || "RUB";
      const raw = payloadProduct.price?.amount ?? payloadProduct.price ?? meta.price_cny ?? 0;
      if (meta.price_cny && !raw) return meta.price_cny;
      return money(toCny(raw, currency));
    };
    const orderTotalCny = (payload = {}, payloadProducts = []) => {
      if (Number(payload.total_cny) > 0) return Number(payload.total_cny);
      return payloadProducts.reduce((sum, product) => {
        const meta = productMap.get(`${payload.store_id || ""}:${product.offer_id || ""}`) || {};
        return sum + productPriceCny(product, meta) * Math.max(1, Number(product.quantity || 1));
      }, 0);
    };

    for (const row of cacheRes.rows) {
      const orderedAt = row.in_process_at ? new Date(row.in_process_at) : null;
      if (!orderedAt || Number.isNaN(orderedAt.getTime())) continue;
      const payload = { ...(row.payload || {}), store_id: String(row.store_id), status: row.status || row.payload?.status || "" };
      const payloadProducts = Array.isArray(payload.products) ? payload.products : [];
      const status = normalizeStatus(payload.status);
      const inCurrent = orderedAt >= currentStart && orderedAt <= now;
      const inPrevious = orderedAt >= previousStart && orderedAt < currentStart;
      if (!inCurrent && !inPrevious) continue;

      const gmv = money(orderTotalCny(payload, payloadProducts));
      const deliveredProfit = status === "delivered" && Number.isFinite(Number(payload.profit_cny)) ? Number(payload.profit_cny) : null;
      if (inCurrent) {
        const storeRow = storeRanking.get(String(row.store_id));
        if (storeRow) {
          storeRow.gmv_cny += gmv;
          storeRow.order_count += 1;
          if (deliveredProfit != null) storeRow.profit_cny += deliveredProfit;
        }
        const dayKey = orderedAt.toISOString().slice(0, 10);
        const bucket = trendBuckets.get(dayKey);
        if (bucket) {
          bucket.gmv_cny += gmv;
          bucket.orders += 1;
        }
      }

      for (const product of payloadProducts) {
        const qty = Math.max(1, Number(product.quantity || 1));
        const meta = productMap.get(`${String(row.store_id)}:${product.offer_id || ""}`) || {};
        const lineTotal = money(productPriceCny(product, meta) * qty);
        const productKey = `${String(row.store_id)}:${product.offer_id || product.sku || product.name || "unknown"}`;
        const categoryProbe = meta.category_id ? meta : {
          category_id: "uncategorized",
          category_name: "",
          category_name_zh: "未分类",
        };
        const cat = ensureCategory(categoryProbe, String(row.store_id));
        if (inCurrent) {
          cat.gmv_cny += lineTotal;
          cat.units += qty;
          cat.order_count += 1;
          if (deliveredProfit != null && gmv > 0) cat.profit_cny += deliveredProfit * (lineTotal / gmv);
          cat.top_product_keys.add(productKey);

          const storeRow = storeRanking.get(String(row.store_id));
          if (storeRow) {
            storeRow.units += qty;
            if (product.offer_id || product.sku) storeRow.moving_skus.add(String(product.offer_id || product.sku));
          }
          const dayKey = orderedAt.toISOString().slice(0, 10);
          const bucket = trendBuckets.get(dayKey);
          if (bucket) bucket.units += qty;
          const band = bandFor(meta.price_cny || (lineTotal / qty));
          band.sales_cny += lineTotal;
          band.units += qty;

          if (!products.has(productKey)) {
            products.set(productKey, {
              key: productKey,
              store_id: String(row.store_id),
              store_name: storeNameById.get(String(row.store_id)) || "",
              offer_id: String(product.offer_id || ""),
              sku: String(product.sku || meta.sku || ""),
              name: productName(product, meta),
              image: productImage(product, meta),
              category_id: cat.category_id,
              category_name_zh: cat.category_name_zh,
              price_cny: meta.price_cny || money(lineTotal / qty),
              gmv_cny: 0,
              units: 0,
              order_count: 0,
              profit_cny: 0,
              stock: Number(meta.stock || 0),
            });
          }
          const pr = products.get(productKey);
          pr.gmv_cny += lineTotal;
          pr.units += qty;
          pr.order_count += 1;
          if (deliveredProfit != null && gmv > 0) pr.profit_cny += deliveredProfit * (lineTotal / gmv);
        } else if (inPrevious) {
          cat.previous_gmv_cny += lineTotal;
        }
      }
    }

    const categoryItems = [...categories.values()]
      .map((row) => {
        const growth = row.previous_gmv_cny > 0
          ? (row.gmv_cny - row.previous_gmv_cny) / row.previous_gmv_cny
          : (row.gmv_cny > 0 ? 1 : 0);
        const margin = row.gmv_cny > 0 ? row.profit_cny / row.gmv_cny : 0;
        const topProducts = [...products.values()]
          .filter((product) => product.category_id === row.category_id)
          .sort((a, b) => b.gmv_cny - a.gmv_cny)
          .slice(0, 3);
        return {
          category_id: row.category_id,
          category_name: row.category_name,
          category_name_zh: row.category_name_zh,
          gmv_cny: money(row.gmv_cny),
          previous_gmv_cny: money(row.previous_gmv_cny),
          growth_rate: Math.round(growth * 10000) / 100,
          units: row.units,
          order_count: row.order_count,
          product_count: row.product_count,
          store_count: row.stores.size,
          profit_cny: money(row.profit_cny),
          profit_rate: row.gmv_cny > 0 ? Math.round(margin * 10000) / 100 : null,
          opportunity_score: Math.max(0, Math.min(100, Math.round((50 + growth * 30 + margin * 40 + Math.min(row.units, 100) * 0.1) * 10) / 10)),
          top_products: topProducts.map((product) => ({
            name: product.name,
            image: product.image,
            gmv_cny: money(product.gmv_cny),
          })),
        };
      })
      .sort((a, b) => b.gmv_cny - a.gmv_cny);
    const productItems = [...products.values()]
      .map((row) => ({
        ...row,
        gmv_cny: money(row.gmv_cny),
        profit_cny: money(row.profit_cny),
        profit_rate: row.gmv_cny > 0 ? Math.round((row.profit_cny / row.gmv_cny) * 10000) / 100 : null,
      }))
      .sort((a, b) => b.gmv_cny - a.gmv_cny)
      .slice(0, 100);
    const storeItems = [...storeRanking.values()]
      .map((row) => ({
        ...row,
        moving_skus: row.moving_skus.size,
        gmv_cny: money(row.gmv_cny),
        profit_cny: money(row.profit_cny),
        avg_order_cny: row.order_count > 0 ? money(row.gmv_cny / row.order_count) : 0,
        profit_rate: row.gmv_cny > 0 ? Math.round((row.profit_cny / row.gmv_cny) * 10000) / 100 : null,
      }))
      .sort((a, b) => b.gmv_cny - a.gmv_cny);
    const totalGmv = storeItems.reduce((sum, store) => sum + Number(store.gmv_cny || 0), 0);
    const totalOrders = storeItems.reduce((sum, store) => sum + Number(store.order_count || 0), 0);
    const totalUnits = storeItems.reduce((sum, store) => sum + Number(store.units || 0), 0);
    const totalProfit = storeItems.reduce((sum, store) => sum + Number(store.profit_cny || 0), 0);
    const movingSkus = new Set(productItems.filter((product) => product.units > 0).map((product) => product.key));

    res.json({
      success: true,
      range_days: rangeDays,
      stores: stores.map((store) => ({ id: store.id, name: store.name })),
      summary: {
        gmv_cny: money(totalGmv),
        order_count: totalOrders,
        units: totalUnits,
        moving_skus: movingSkus.size,
        avg_order_cny: totalOrders > 0 ? money(totalGmv / totalOrders) : 0,
        profit_cny: money(totalProfit),
        profit_rate: totalGmv > 0 ? Math.round((totalProfit / totalGmv) * 10000) / 100 : null,
        active_products: storeItems.reduce((sum, store) => sum + Number(store.active_products || 0), 0),
        stock_warning: storeItems.reduce((sum, store) => sum + Number(store.stock_warning || 0), 0),
      },
      categories: categoryItems,
      products: productItems,
      store_ranking: storeItems,
      trends: [...trendBuckets.values()].map((row) => ({ ...row, gmv_cny: money(row.gmv_cny) })),
      price_distribution: priceBands.map((band) => ({
        label: band.label,
        product_count: band.product_count,
        sales_cny: money(band.sales_cny),
        units: band.units,
      })),
      data_source: {
        orders: "app_order_cache",
        products: "app_products",
        exchange_rate: effectiveRubCnyRate,
        latest_order_sync_at: latestOrderSync ? new Date(latestOrderSync).toISOString() : null,
        note: "自有店铺数据；不含第三方全市场数据。",
      },
    });
  } catch (error) { next(error); }
});

function classifyChinaMarketItem(item = {}) {
  const country = String(item.origin_country || item.originCountry || '').trim();
  const delivery = String(item.delivery_text || item.deliveryText || '').trim();
  const seller = String(item.seller_name || item.sellerName || '').trim();
  if (/^(CN|CHN|China|中国|Китай)$/i.test(country)) return { isChina: true, confidence: 1, evidence: `原产国:${country}` };
  if (/\b(China|Китай|КНР|中国)\b/i.test(delivery)) return { isChina: true, confidence: 0.9, evidence: `配送信息:${delivery.slice(0, 160)}` };
  if (/(Shenzhen|Guangzhou|Yiwu|Dongguan|Hangzhou|Ningbo|Quanzhou|Xiamen|Co\.?\s*,?\s*Ltd|Trading|Technology)/i.test(seller)) {
    return { isChina: false, confidence: 0.65, evidence: `卖家名称特征:${seller}` };
  }
  return { isChina: false, confidence: 0, evidence: '' };
}

const PLATFORM_SNAPSHOT_SEEDS = [
  { key: "beauty", label: "美妆个护", query: "косметика уход красота" },
  { key: "fashion", label: "服饰鞋包", query: "одежда сумка рюкзак обувь" },
  { key: "home", label: "家居家装", query: "товары для дома кухня хранение" },
  { key: "digital", label: "手机数码", query: "чехол телефон наушники зарядка" },
  { key: "sports", label: "运动户外", query: "спорт фитнес туризм" },
  { key: "baby", label: "母婴玩具", query: "игрушки дети школа" },
  { key: "auto", label: "汽摩五金", query: "авто инструменты ремонт" },
  { key: "pets", label: "宠物用品", query: "товары для животных кошек собак" },
  { key: "food", label: "食品饮料", query: "кофе чай продукты" },
  { key: "health", label: "健康保健", query: "здоровье витамины аптечка" },
];
let platformSnapshotRefreshPromise = null;
let lastPlatformSnapshotRefreshAt = 0;

function decodeHtmlEntities(value = "") {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseJsonLdBlocks(html = "") {
  const blocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(String(html || "")))) {
    const raw = decodeHtmlEntities(match[1]).trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) blocks.push(...parsed);
      else blocks.push(parsed);
    } catch {
      // Ozon occasionally ships malformed JSON-LD; meta tags still give usable basics.
    }
  }
  return blocks;
}

function extractMetaContent(html = "", key = "") {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${escaped}["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${escaped}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = String(html || "").match(pattern);
    if (match?.[1]) return decodeHtmlEntities(match[1]);
  }
  return "";
}

function parseOzonNumber(value) {
  const text = String(value ?? "").replace(/\s/g, "").replace(",", ".");
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

function normalizeOzonSnapshotInput(value = "") {
  const text = String(value || "").trim();
  const url = normalizeOzonProductUrl(text) || normalizeOzonPageUrl(text);
  const sku = extractOzonProductId(url || text) || (text.match(/\b\d{6,}\b/)?.[0] || "");
  if (!sku) return null;
  return {
    sku,
    url: url || `https://www.ozon.ru/product/${sku}/`,
  };
}

async function fetchOzonPublicSnapshot(input) {
  const normalized = normalizeOzonSnapshotInput(input);
  if (!normalized) throw new Error("无法识别 Ozon 商品链接或 SKU");
  const response = await fetch(normalized.url, {
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.7,en;q=0.6,zh-CN;q=0.5",
    },
  });
  if (!response.ok) throw new Error(`Ozon 返回 ${response.status}`);
  const html = await response.text();
  const jsonLd = parseJsonLdBlocks(html);
  const productLd = jsonLd.find((item) => {
    const type = Array.isArray(item?.["@type"]) ? item["@type"].join(" ") : item?.["@type"];
    return /Product/i.test(String(type || ""));
  }) || {};
  const breadcrumbLd = jsonLd.find((item) => {
    const type = Array.isArray(item?.["@type"]) ? item["@type"].join(" ") : item?.["@type"];
    return /BreadcrumbList/i.test(String(type || ""));
  }) || {};
  const title = decodeHtmlEntities(
    productLd.name
    || extractMetaContent(html, "og:title")
    || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    || "",
  ).replace(/\s*\|\s*OZON.*$/i, "");
  const imageValue = productLd.image || extractMetaContent(html, "og:image") || "";
  const mainImage = Array.isArray(imageValue) ? String(imageValue[0] || "") : String(imageValue || "");
  const offer = Array.isArray(productLd.offers) ? productLd.offers[0] : productLd.offers || {};
  const priceRub = parseOzonNumber(offer.price ?? extractMetaContent(html, "product:price:amount"));
  const breadcrumbItems = Array.isArray(breadcrumbLd.itemListElement) ? breadcrumbLd.itemListElement : [];
  const categories = breadcrumbItems
    .map((entry) => decodeHtmlEntities(entry?.name || entry?.item?.name || ""))
    .filter(Boolean)
    .filter((name) => !/ozon/i.test(name));
  const categoryName = categories.slice(-3).join(" / ");
  const sellerName = decodeHtmlEntities(
    html.match(/"sellerName"\s*:\s*"([^"]+)"/i)?.[1]
    || html.match(/"brand"\s*:\s*\{\s*"@type"\s*:\s*"Brand"\s*,\s*"name"\s*:\s*"([^"]+)"/i)?.[1]
    || productLd.brand?.name
    || "",
  );
  const reviewCount = Math.max(0, Math.floor(Number(productLd.aggregateRating?.reviewCount || productLd.review?.length || 0) || 0));
  return {
    sku: normalized.sku,
    title,
    main_image: mainImage,
    price_rub: priceRub,
    monthly_sales: 0,
    review_count: reviewCount,
    seller_count: null,
    category_id: "",
    category_name: categoryName,
    strategy_type: "hot",
    ozon_url: normalized.url,
    seller_name: sellerName,
    origin_country: "",
    delivery_text: "",
    source_name: "ozon_public_page",
    source_url: normalized.url,
    source_captured_at: new Date().toISOString(),
    source_payload: {
      capture_method: "public_product_page",
      coverage: {
        title: Boolean(title),
        price_rub: priceRub != null,
        main_image: Boolean(mainImage),
        category_name: Boolean(categoryName),
        seller_name: Boolean(sellerName),
        review_count: reviewCount > 0,
        monthly_sales: false,
        gmv_growth: false,
        return_rate: false,
      },
      missing_metrics: ["monthly_sales", "gmv_growth", "sales_growth", "return_rate", "brand_share"],
    },
  };
}

function createPlatformSnapshotJob() {
  return {
    id: `platform-snapshot-${Date.now().toString(36)}`,
    logs: [],
    status: "running",
    phase: "刷新 Ozon 平台样本",
    cancelRequested: false,
  };
}

function platformSearchUrl(seed = {}) {
  if (seed.url) return seed.url;
  const query = encodeURIComponent(seed.query || seed.label || seed.key || "");
  return `https://www.ozon.ru/search/?text=${query}&sorting=rating`;
}

function mapOzonScrapeToPlatformSnapshot(ozon = {}, url = "", seed = {}) {
  const sku = String(ozon.sku || extractOzonProductId(url) || "").replace(/[^\d]/g, "");
  if (!sku) throw new Error("未识别到 Ozon SKU");
  const imageUrl = pickOzonImageUrl(ozon);
  const priceRub = parseOzonNumber(ozon.blackPriceRub || ozon.price || "");
  const categoryName = String(seed.label || categoryNameZh("", seed.key || "") || "").trim();
  return {
    sku,
    title: String(ozon.title || "").trim(),
    main_image: imageUrl,
    price_rub: priceRub,
    monthly_sales: 0,
    review_count: 0,
    seller_count: Number.isFinite(Number(ozon.sellerOfferCount)) ? Math.max(0, Math.floor(Number(ozon.sellerOfferCount))) : null,
    category_id: String(seed.key || ""),
    category_name: categoryName,
    strategy_type: "hot",
    ozon_url: normalizeOzonProductUrl(url) || url || `https://www.ozon.ru/product/${sku}/`,
    seller_name: "",
    origin_country: "",
    delivery_text: "",
    source_name: "ozon_public_auto",
    source_url: platformSearchUrl(seed),
    source_captured_at: new Date().toISOString(),
    source_payload: {
      capture_method: "public_search_auto",
      seed,
      coverage: {
        title: Boolean(ozon.title),
        price_rub: priceRub != null,
        main_image: Boolean(imageUrl),
        category_name: Boolean(categoryName),
        seller_name: false,
        review_count: false,
        monthly_sales: false,
        gmv_growth: false,
        return_rate: false,
      },
      missing_metrics: ["monthly_sales", "gmv_growth", "sales_growth", "return_rate", "brand_share"],
      ozon_price_note: ozon.ozonPriceNote || "",
    },
  };
}

async function upsertPlatformSnapshotItem(item = {}) {
  const classification = classifyChinaMarketItem(item);
  const result = await db.query(
    `INSERT INTO app_top_lists (sku,title,main_image,price_rub,monthly_sales,review_count,seller_count,category_id,category_name,strategy_type,ozon_url,seller_name,origin_country,delivery_text,is_china_origin,china_confidence,china_evidence,source_name,source_url,source_captured_at,source_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb)
     ON CONFLICT (sku) DO UPDATE SET title=COALESCE(NULLIF(EXCLUDED.title,''),app_top_lists.title),
       main_image=COALESCE(NULLIF(EXCLUDED.main_image,''),app_top_lists.main_image),
       price_rub=COALESCE(EXCLUDED.price_rub,app_top_lists.price_rub),
       monthly_sales=GREATEST(EXCLUDED.monthly_sales, app_top_lists.monthly_sales),
       review_count=GREATEST(EXCLUDED.review_count,app_top_lists.review_count),
       seller_count=COALESCE(EXCLUDED.seller_count,app_top_lists.seller_count),
       category_id=COALESCE(NULLIF(EXCLUDED.category_id,''),app_top_lists.category_id),
       category_name=COALESCE(NULLIF(EXCLUDED.category_name,''),app_top_lists.category_name),
       strategy_type=EXCLUDED.strategy_type,
       ozon_url=EXCLUDED.ozon_url,
       seller_name=COALESCE(NULLIF(EXCLUDED.seller_name,''),app_top_lists.seller_name),
       origin_country=COALESCE(NULLIF(EXCLUDED.origin_country,''),app_top_lists.origin_country),
       delivery_text=COALESCE(NULLIF(EXCLUDED.delivery_text,''),app_top_lists.delivery_text),
       is_china_origin=EXCLUDED.is_china_origin,
       china_confidence=EXCLUDED.china_confidence,
       china_evidence=EXCLUDED.china_evidence,
       source_name=EXCLUDED.source_name,
       source_url=EXCLUDED.source_url,
       source_captured_at=EXCLUDED.source_captured_at,
       source_payload=EXCLUDED.source_payload,
       active=TRUE,
       updated_at=now()
     RETURNING id, sku, title, price_rub, category_name, source_captured_at`,
    [String(item.sku || ""), String(item.title || ""), String(item.main_image || ""), item.price_rub == null ? null : Number(item.price_rub),
     Math.max(0, Math.floor(Number(item.monthly_sales || 0))), Math.max(0, Math.floor(Number(item.review_count || 0))),
     Number.isFinite(Number(item.seller_count)) ? Math.max(0, Math.floor(Number(item.seller_count))) : null,
     String(item.category_id || ""), String(item.category_name || item.category || ""), String(item.strategy_type || "hot"),
     String(item.ozon_url || `https://www.ozon.ru/product/${item.sku}/`), String(item.seller_name || item.seller || ""),
     String(item.origin_country || ""), String(item.delivery_text || ""), classification.isChina, classification.confidence, classification.evidence,
     String(item.source_name || ""), String(item.source_url || ""), new Date(item.source_captured_at || Date.now()).toISOString(),
     JSON.stringify(item.source_payload || item)],
  );
  return result.rows[0];
}

function mapGeoBlueOceanItem(raw = {}, capturedAt = new Date().toISOString()) {
  const sku = String(raw.sku || raw.product_key || raw.product_id || "").replace(/[^\d]/g, "");
  if (!sku) throw new Error("GEO 商品缺少有效 SKU");
  const sourceUrl = String(raw.source_url || raw.ozon_url || `https://www.ozon.ru/product/${sku}/`);
  return {
    sku,
    title: String(raw.product_name || raw.title || raw.name || raw.keyword || ""),
    main_image: String(raw.image_url || raw.main_image || raw.image || ""),
    price_rub: Number(raw.avg_price || raw.price_rub || raw.price || 0) || null,
    monthly_sales: Math.max(0, Math.floor(Number(raw.sales_30d || raw.monthly_sales || raw.sales || 0))),
    review_count: Math.max(0, Math.floor(Number(raw.review_count || raw.reviews || raw.avg_reviews || raw.top_reviews || 0))),
    seller_count: Number.isFinite(Number(raw.seller_count || raw.sellers || raw.product_count))
      ? Math.max(0, Math.floor(Number(raw.seller_count || raw.sellers || raw.product_count)))
      : null,
    category_id: String(raw.category_id || raw.category3 || raw.category || ""),
    category_name: String(raw.category3 || raw.category || raw.category1 || ""),
    strategy_type: "blue_ocean",
    ozon_url: sourceUrl,
    seller_name: String(raw.seller_name || raw.seller || raw.brand || ""),
    origin_country: String(raw.origin_country || ""),
    delivery_text: String(raw.delivery_text || ""),
    source_name: "geo_ozon_blue_ocean",
    source_url: sourceUrl,
    source_captured_at: raw.source_captured_at || raw.scraped_at || capturedAt,
    source_payload: {
      ...raw,
      source_system: "geo_ozon_blue_ocean",
      capture_method: "geo_blue_ocean_json",
      revenue_30d: Number(raw.revenue_30d || 0),
      growth_30d: Number(raw.growth_30d || 0),
      blue_ocean_score: Number(raw.blue_ocean_score || 0),
      opportunity_level: raw.opportunity_level || "",
    },
  };
}

async function resolveLatestGeoBlueOceanScoredFile() {
  if (GEO_BLUE_OCEAN_SCORED_FILE) {
    const absolute = path.resolve(GEO_BLUE_OCEAN_SCORED_FILE);
    if (!existsSync(absolute)) throw new Error(`GEO 蓝海评分文件不存在: ${absolute}`);
    return absolute;
  }
  const roots = [
    path.resolve(GEO_BLUE_OCEAN_OUTPUT_ROOT),
    "/opt/ozon/blue-ocean/outputs/daily",
    path.resolve(__dirname, "../ozon-blue-ocean/outputs/daily"),
  ].filter((value, index, arr) => value && arr.indexOf(value) === index);
  const candidates = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, "blue_ocean_scored.json");
      if (!existsSync(file)) continue;
      const stat = await fs.stat(file);
      candidates.push({ file, mtimeMs: stat.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!candidates.length) throw new Error(`GEO 输出目录没有 blue_ocean_scored.json: ${roots.join(", ")}`);
  return candidates[0].file;
}

async function importGeoBlueOceanScored(options = {}) {
  if (!db) throw new Error("数据库未连接");
  const file = options.file ? path.resolve(options.file) : await resolveLatestGeoBlueOceanScoredFile();
  const text = await fs.readFile(file, "utf8");
  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : Array.isArray(parsed.data) ? parsed.data : [];
  const limit = Math.min(5000, Math.max(1, Number(options.limit || rows.length || OZON_OPPORTUNITY_DEFAULT_LIMIT)));
  if (!rows.length) return { imported: 0, failed: 0, errors: [], file, note: "GEO 蓝海评分 JSON 没有商品行" };
  const capturedAt = new Date().toISOString();
  const imported = [];
  const errors = [];
  const seen = new Set();
  for (let index = 0; index < rows.length && imported.length < limit; index += 1) {
    try {
      const item = mapGeoBlueOceanItem(rows[index], capturedAt);
      if (seen.has(item.sku)) continue;
      seen.add(item.sku);
      const row = await upsertPlatformSnapshotItem(item);
      imported.push({ ...row, category_name_zh: categoryNameZh(row.category_name || "", item.category_id || "") });
    } catch (error) {
      errors.push({ row: index + 1, error: error.message });
    }
  }
  return {
    imported: imported.length,
    failed: errors.length,
    errors: errors.slice(0, 20),
    file,
    source_name: "geo_ozon_blue_ocean",
    note: "已从 GEO 商品级蓝海评分 JSON 导入 Ozon 机会池。",
  };
}

function percentFromMyErp(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

function numberFromMyErp(value) {
  if (value == null || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function myErpGet(pathname, params = {}) {
  if (!MYERP_API_TOKEN) {
    const error = new Error("未配置 MYERP_API_TOKEN，无法同步 MY ERP 平台榜单数据");
    error.code = "MYERP_TOKEN_MISSING";
    throw error;
  }
  const url = new URL(`${MYERP_API_BASE_URL}${pathname}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${MYERP_API_TOKEN}`,
      Accept: "application/json",
      "x-forwarded-host": "my.jizhangerp.com",
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const error = new Error(data?.message || data?.error || `MY ERP API ${res.status}`);
    error.status = res.status;
    error.payload = data;
    throw error;
  }
  return data;
}

async function upsertPlatformCategory(row = {}, meta = {}) {
  const categoryId = String(row.cat3Id || row.cat2Id || row.cat1Id || row.categoryId || row.category_id || row.id || row.name || row.categoryName || "").trim();
  const categoryName = String(row.cat3Name || row.cat2Name || row.cat1Name || row.categoryName || row.category_name || row.name || row.title || "").trim();
  if (!categoryId && !categoryName) return null;
  const categoryParentId = String(
    row.cat3Id ? (row.cat2Id || row.cat1Id || "")
      : row.cat2Id ? (row.cat1Id || "")
        : (row.parentId || row.parent_id || row.categoryParentId || ""),
  );
  const categoryPath = [row.cat1Name, row.cat2Name, row.cat3Name].filter(Boolean).join(" / ")
    || String(row.path || row.categoryPath || categoryName);
  const salesUnits = numberFromMyErp(row.sales ?? row.salesUnits ?? row.monthlySales ?? row.monthly_sales);
  const salesAmountRub = numberFromMyErp(row.salesAmount ?? row.sales_amount ?? row.gmv ?? row.gmvRub);
  const avgPriceRub = row.avgPrice != null
    ? numberFromMyErp(row.avgPrice)
    : (salesUnits > 0 && salesAmountRub > 0 ? salesAmountRub / salesUnits : 0);
  const sourceCapturedAt = row.updatedAt || row.capturedAt || meta.lastUpdate || meta.sourceCapturedAt || new Date().toISOString();
  const capturedDate = new Date(sourceCapturedAt);
  const safeCapturedAt = Number.isNaN(capturedDate.getTime()) ? new Date() : capturedDate;
  const snapshotDate = row.snapshotDate || row.snapshot_date || meta.snapshotDate || safeCapturedAt.toISOString().slice(0, 10);
  const categoryZh = categoryNameZh(categoryName, categoryId);
  const result = await db.query(
    `INSERT INTO app_platform_categories (
       source_name, source_url, period, snapshot_date, category_id, category_parent_id, category_name, category_name_zh,
       category_path, level, sales_units, sales_amount_rub, gmv_growth, avg_price_rub, price_growth, sellers, brands,
       brand_rate, leader_share, fbs_rate, buyout_rate, return_rate, source_captured_at, source_payload
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb
     )
     ON CONFLICT (source_name, period, snapshot_date, category_id) DO UPDATE SET
       source_url=EXCLUDED.source_url,
       category_parent_id=EXCLUDED.category_parent_id,
       category_name=EXCLUDED.category_name,
       category_name_zh=EXCLUDED.category_name_zh,
       category_path=EXCLUDED.category_path,
       level=EXCLUDED.level,
       sales_units=EXCLUDED.sales_units,
       sales_amount_rub=EXCLUDED.sales_amount_rub,
       gmv_growth=EXCLUDED.gmv_growth,
       avg_price_rub=EXCLUDED.avg_price_rub,
       price_growth=EXCLUDED.price_growth,
       sellers=EXCLUDED.sellers,
       brands=EXCLUDED.brands,
       brand_rate=EXCLUDED.brand_rate,
       leader_share=EXCLUDED.leader_share,
       fbs_rate=EXCLUDED.fbs_rate,
       buyout_rate=EXCLUDED.buyout_rate,
       return_rate=EXCLUDED.return_rate,
       source_captured_at=EXCLUDED.source_captured_at,
       source_payload=EXCLUDED.source_payload,
       active=TRUE,
       updated_at=now()
     RETURNING id, category_id`,
    [
      String(meta.sourceName || "myerp_category_analysis"),
      String(meta.sourceUrl || `${MYERP_API_BASE_URL}/ozon/category-analysis/lists`),
      String(meta.period || MYERP_PLATFORM_PERIOD),
      snapshotDate,
      categoryId || categoryName,
      categoryParentId,
      categoryName,
      categoryZh,
      categoryPath,
      Math.max(1, Math.floor(Number(row.level || meta.level || 1))),
      salesUnits,
      salesAmountRub,
      percentFromMyErp(row.gmvGrowth ?? row.gmv_growth),
      avgPriceRub || null,
      percentFromMyErp(row.priceGrowth ?? row.price_growth),
      row.sellers == null ? null : numberFromMyErp(row.sellers),
      row.brands == null ? null : numberFromMyErp(row.brands),
      percentFromMyErp(row.brandRate ?? row.brand_rate),
      percentFromMyErp(row.leaderShare ?? row.leader_share),
      percentFromMyErp(row.fbsRate ?? row.fbs_rate),
      percentFromMyErp(row.buyout ?? row.buyoutRate ?? row.buyout_rate),
      percentFromMyErp(row.returnRate ?? row.return_rate),
      safeCapturedAt.toISOString(),
      JSON.stringify(row),
    ],
  );
  return result.rows[0];
}

async function syncMyErpCategoryAnalysis(options = {}) {
  if (!db) throw new Error("数据库未连接");
  const period = String(options.period || MYERP_PLATFORM_PERIOD || "monthly");
  const pageSize = Math.min(100, Math.max(20, Number(options.pageSize || 100)));
  const fallbackPages = Math.min(200, Math.max(1, Number(options.pages || MYERP_PLATFORM_SYNC_PAGES || 5)));
  const maxRequests = Math.min(1000, Math.max(10, Number(options.maxRequests || MYERP_PLATFORM_SYNC_MAX_REQUESTS)));
  let imported = 0;
  let total = 0;
  let lastUpdate = null;
  let requests = 0;
  const savedKeys = new Set();

  const rowKey = (row = {}) => String(row.cat3Id || row.cat2Id || row.cat1Id || row.categoryId || row.id || "");
  const fetchCategoryRows = async (filters = {}) => {
    const rows = [];
    let endpointTotal = 0;
    for (let page = 1; page <= fallbackPages; page += 1) {
      if (requests >= maxRequests) {
        throw new Error(`MY ERP 类目同步请求超过上限 ${maxRequests}，已停止以避免接口异常循环`);
      }
      requests += 1;
      const data = await myErpGet("/ozon/category-analysis/lists", {
        period,
        page,
        page_size: pageSize,
        sort_by: "sales",
        sort_order: "desc",
        ...filters,
      });
      const list = Array.isArray(data?.list) ? data.list : Array.isArray(data?.data?.list) ? data.data.list : [];
      endpointTotal = Number(data?.total || data?.data?.total || endpointTotal || list.length);
      lastUpdate = data?.lastUpdate || data?.data?.lastUpdate || data?.snapshotDate || lastUpdate;
      rows.push(...list);
      if (!list.length || page * pageSize >= endpointTotal) break;
    }
    total += rows.length;
    return rows;
  };

  const saveRows = async (rows = []) => {
    for (const row of rows) {
      const key = `${row.snapshotDate || ""}:${rowKey(row)}`;
      if (savedKeys.has(key)) continue;
      const saved = await upsertPlatformCategory(row, { period, lastUpdate });
      if (saved) {
        savedKeys.add(key);
        imported += 1;
      }
    }
  };

  const level1Rows = await fetchCategoryRows();
  await saveRows(level1Rows);

  for (const level1 of level1Rows) {
    const category1 = String(level1.cat1Id || "").trim();
    if (!category1) continue;
    const level2Rows = await fetchCategoryRows({ category1 });
    await saveRows(level2Rows);

    for (const level2 of level2Rows) {
      const category2 = String(level2.cat2Id || "").trim();
      if (!category2) continue;
      const level3Rows = await fetchCategoryRows({ category1, category2 });
      await saveRows(level3Rows);
    }
  }
  return { imported, total, period, lastUpdate, requests, configured: Boolean(MYERP_API_TOKEN) };
}

async function refreshOzonPlatformSnapshots(options = {}) {
  if (!db) throw new Error("数据库未连接");
  if (platformSnapshotRefreshPromise) return platformSnapshotRefreshPromise;
  platformSnapshotRefreshPromise = (async () => {
    const limit = Math.min(200, Math.max(10, Number(options.limit || PLATFORM_SNAPSHOT_DEFAULT_LIMIT)));
    const perSeed = Math.max(3, Math.ceil(limit / PLATFORM_SNAPSHOT_SEEDS.length));
    const job = createPlatformSnapshotJob();
    const context = await getBrowserContext({ headless: true });
    const seenUrls = new Set();
    const imported = [];
    const errors = [];
    try {
      for (const seed of PLATFORM_SNAPSHOT_SEEDS) {
        if (seenUrls.size >= limit) break;
        const sourceUrl = platformSearchUrl(seed);
        let urls = [];
        try {
          urls = await discoverOzonProductUrls(context, sourceUrl, job, perSeed);
        } catch (error) {
          errors.push({ seed: seed.label, stage: "discover", error: error.message });
          continue;
        }
        for (const url of urls) {
          if (seenUrls.size >= limit) break;
          const normalizedUrl = normalizeOzonProductUrl(url);
          if (!normalizedUrl || seenUrls.has(normalizedUrl)) continue;
          seenUrls.add(normalizedUrl);
          try {
            let item;
            try {
              item = await fetchOzonPublicSnapshot(normalizedUrl);
              item.category_id ||= seed.key;
              item.category_name ||= seed.label;
              item.source_name = "ozon_public_auto";
              item.source_url = sourceUrl;
              item.source_payload = { ...(item.source_payload || {}), seed, capture_method: "public_search_auto" };
            } catch {
              const ozon = await scrapeOzonProduct(context, normalizedUrl, job.id, imported.length + 1);
              item = mapOzonScrapeToPlatformSnapshot(ozon, normalizedUrl, seed);
            }
            const row = await upsertPlatformSnapshotItem(item);
            imported.push({ ...row, category_name_zh: categoryNameZh(row.category_name, item.category_id || "") });
            await sleep(randomInt(350, 900));
          } catch (error) {
            errors.push({ url: normalizedUrl, stage: "detail", error: error.message });
          }
        }
      }
      lastPlatformSnapshotRefreshAt = Date.now();
      return { imported: imported.length, failed: errors.length, items: imported, errors: errors.slice(0, 30), logs: job.logs.slice(-80) };
    } finally {
      platformSnapshotRefreshPromise = null;
    }
  })();
  return platformSnapshotRefreshPromise;
}

async function discoverOzonProductsFromPlatformCategories(options = {}) {
  if (!db) throw new Error("数据库未连接");
  const categoryIds = Array.isArray(options.categoryIds)
    ? options.categoryIds.map(String).map((value) => value.trim()).filter(Boolean)
    : [];
  const search = String(options.search || "").trim();
  const categoryLimit = Math.min(8, Math.max(1, Number(options.categoryLimit || (categoryIds.length ? categoryIds.length : 3))));
  const perCategory = Math.min(12, Math.max(1, Number(options.perCategory || 6)));
  const totalLimit = Math.min(80, Math.max(1, Number(options.limit || categoryLimit * perCategory)));
  const args = [];
  const where = ["c.active=TRUE"];
  if (categoryIds.length) {
    args.push(categoryIds);
    where.push(`c.id=ANY($${args.length}::uuid[])`);
  } else if (search) {
    args.push(search);
    where.push(`(c.category_id ILIKE '%' || $${args.length} || '%' OR c.category_name ILIKE '%' || $${args.length} || '%' OR c.category_name_zh ILIKE '%' || $${args.length} || '%' OR c.category_path ILIKE '%' || $${args.length} || '%')`);
  }
  const categories = await db.query(
    `WITH latest_platform_category AS (
       SELECT MAX(source_captured_at) AS latest_at
         FROM app_platform_categories
        WHERE active=TRUE
     )
     SELECT c.id, c.category_id, c.category_name, c.category_name_zh, c.category_path, c.sales_units, c.sales_amount_rub
       FROM app_platform_categories c
       JOIN latest_platform_category l ON c.source_captured_at = l.latest_at
      WHERE ${where.join(" AND ")}
      ORDER BY c.sales_units DESC, c.sales_amount_rub DESC, c.updated_at DESC
      LIMIT $${args.length + 1}`,
    [...args, categoryLimit],
  );
  if (!categories.rowCount) {
    return { imported: 0, failed: 0, items: [], errors: [], categories: [], note: "没有可用于发现商品的 Ozon 平台类目数据。" };
  }

  const context = await getBrowserContext({ headless: true });
  const job = createPlatformSnapshotJob();
  job.phase = "按类目发现 Ozon 商品";
  const seenUrls = new Set();
  const imported = [];
  const errors = [];
  const usedCategories = [];
  try {
    for (const category of categories.rows) {
      if (seenUrls.size >= totalLimit) break;
      const label = category.category_name_zh || categoryNameZh(category.category_name, category.category_id) || category.category_name;
      const queries = categorySearchTerms(category.category_name, category.category_name_zh, category.category_path);
      if (!queries.length) continue;
      usedCategories.push({ id: category.id, category_id: category.category_id, label, queries });
      for (const query of queries) {
        if (seenUrls.size >= totalLimit) break;
        const remaining = Math.max(1, Math.min(perCategory, totalLimit - seenUrls.size));
        const seed = {
          key: category.category_id,
          label,
          query,
          source_category_id: category.id,
          category_path: category.category_path,
        };
        let urls = [];
        try {
          urls = await discoverOzonProductUrls(context, platformSearchUrl(seed), job, remaining);
        } catch (error) {
          errors.push({ category: label, query, stage: "discover", error: error.message });
          continue;
        }
        if (!urls.length) {
          errors.push({
            category: label,
            query,
            stage: "discover",
            error: "Ozon 公共搜索没有返回商品链接，常见原因是服务器访问 Ozon 被重定向、风控或地区限制。",
          });
        }
        for (const url of urls) {
          if (seenUrls.size >= totalLimit) break;
          const normalizedUrl = normalizeOzonProductUrl(url);
          if (!normalizedUrl || seenUrls.has(normalizedUrl)) continue;
          seenUrls.add(normalizedUrl);
          try {
            let item;
            try {
              item = await fetchOzonPublicSnapshot(normalizedUrl);
              item.category_id ||= category.category_id;
              item.category_name ||= label;
              item.source_name = "ozon_public_category_discovery";
              item.source_url = platformSearchUrl(seed);
              item.source_payload = { ...(item.source_payload || {}), seed, capture_method: "public_category_discovery" };
            } catch {
              const ozon = await scrapeOzonProduct(context, normalizedUrl, job.id, imported.length + 1);
              item = mapOzonScrapeToPlatformSnapshot(ozon, normalizedUrl, seed);
              item.source_name = "ozon_public_category_discovery";
            }
            const row = await upsertPlatformSnapshotItem(item);
            imported.push({ ...row, category_name_zh: categoryNameZh(row.category_name, item.category_id || "") });
            await sleep(randomInt(260, 720));
          } catch (error) {
            errors.push({ url: normalizedUrl, query, stage: "detail", error: error.message });
          }
        }
      }
    }
    return {
      success: imported.length > 0,
      code: imported.length ? "PRODUCT_DISCOVERY_IMPORTED" : "PRODUCT_LEVEL_SOURCE_UNAVAILABLE",
      imported: imported.length,
      failed: errors.length,
      items: imported,
      categories: usedCategories,
      errors: errors.slice(0, 30),
      logs: job.logs.slice(-80),
      note: imported.length
        ? "已按类目发现商品级 Ozon 候选，可勾选后加入找货候选。"
        : "现在没有 GEO 商品级榜单数据：请先运行 GEO Ozon 采集并生成 blue_ocean_scored.json，再导入机会池。",
    };
  } finally {
    job.status = imported.length ? "done" : "error";
  }
}

async function maybeRefreshOzonPlatformSnapshots(reason = "auto") {
  if (!db || platformSnapshotRefreshPromise) return null;
  const stats = await db.query(
    `SELECT COUNT(*)::int AS total, MAX(source_captured_at) AS latest_captured_at
       FROM app_top_lists WHERE active=TRUE`,
  ).catch(() => ({ rows: [{}] }));
  const total = Number(stats.rows[0]?.total || 0);
  const latest = stats.rows[0]?.latest_captured_at ? new Date(stats.rows[0].latest_captured_at).getTime() : 0;
  const stale = !latest || Date.now() - latest > PLATFORM_SNAPSHOT_STALE_MS;
  if (total >= 30 && !stale && reason !== "manual") return null;
  return refreshOzonPlatformSnapshots({ reason }).catch((error) => {
    console.warn(`[platform-snapshot] refresh failed: ${error.message}`);
    return null;
  });
}

async function getOzonOpportunityCollectorStatus() {
  if (!db) throw new Error("数据库未连接");
  const stats = await db.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE price_rub IS NOT NULL AND price_rub > 0)::int AS with_price,
            COUNT(*) FILTER (WHERE monthly_sales > 0)::int AS with_sales,
            COUNT(*) FILTER (WHERE review_count > 0)::int AS with_reviews,
            COUNT(DISTINCT NULLIF(category_name, ''))::int AS category_count,
            MAX(source_captured_at) AS latest_captured_at,
            MIN(source_captured_at) AS oldest_captured_at
       FROM app_top_lists
      WHERE active=TRUE`,
  );
  const recent = await db.query(
    `SELECT id, sku, title, main_image, price_rub, monthly_sales, review_count, seller_count,
            category_id, category_name, strategy_type, ozon_url, seller_name, source_name,
            source_url, source_captured_at, updated_at
       FROM app_top_lists
      WHERE active=TRUE
      ORDER BY source_captured_at DESC NULLS LAST, updated_at DESC
      LIMIT 8`,
  );
  const sourceRows = await db.query(
    `SELECT source_name, COUNT(*)::int AS total, MAX(source_captured_at) AS latest_captured_at
       FROM app_top_lists
      WHERE active=TRUE
      GROUP BY source_name
      ORDER BY total DESC, source_name ASC
      LIMIT 12`,
  );
  return {
    success: true,
    refreshing: Boolean(platformSnapshotRefreshPromise),
    interval_ms: OZON_OPPORTUNITY_REFRESH_INTERVAL_MS,
    default_limit: OZON_OPPORTUNITY_DEFAULT_LIMIT,
    stale_ms: PLATFORM_SNAPSHOT_STALE_MS,
    last_refresh_at: lastPlatformSnapshotRefreshAt ? new Date(lastPlatformSnapshotRefreshAt).toISOString() : null,
    stats: stats.rows[0] || {},
    sources: sourceRows.rows || [],
    recent: (recent.rows || []).map((row) => ({
      ...row,
      row_type: "product",
      category_name_zh: categoryNameZh(row.category_name, row.category_id),
    })),
    note: "Ozon 机会池只采集平台商品候选；不会自动请求 1688，选中商品后才进入找货候选队列。",
  };
}

async function maybeRefreshOzonOpportunityPool(reason = "opportunity-interval") {
  if (!db || platformSnapshotRefreshPromise || OZON_OPPORTUNITY_REFRESH_INTERVAL_MS <= 0) return null;
  const stats = await getOzonOpportunityCollectorStatus().catch(() => ({ stats: {} }));
  const total = Number(stats.stats?.total || 0);
  const latest = stats.stats?.latest_captured_at ? new Date(stats.stats.latest_captured_at).getTime() : 0;
  const stale = !latest || Date.now() - latest > PLATFORM_SNAPSHOT_STALE_MS;
  if (total >= 50 && !stale && reason !== "manual") return null;
  return importGeoBlueOceanScored({ reason, limit: OZON_OPPORTUNITY_DEFAULT_LIMIT }).catch((error) => {
    console.warn(`[ozon-opportunity] refresh failed: ${error.message}`);
    return null;
  });
}

// ---- dz_blue_ocean 商品主图回填（采集侧不写 main_image，这里按 sku 调 Ozon API 补图，内存缓存 6 小时）----
const dzProductImageCache = new Map(); // sku -> { url, expiresAt }
async function fillDzProductImages(items, { storeId, userId } = {}) {
  const missing = [];
  for (const item of items) {
    const sku = String(item.sku || "").trim();
    if (!/^\d+$/.test(sku) || item.main_image) continue;
    const cached = dzProductImageCache.get(sku);
    if (cached && cached.expiresAt > Date.now()) {
      item.main_image = cached.url;
      continue;
    }
    missing.push(sku);
  }
  if (!missing.length || !storeId || !userId) return;
  // 分批查询（Ozon /v3/product/info/list 单次最多 100 个 sku）
  const chunks = [];
  for (let i = 0; i < missing.length; i += 100) chunks.push(missing.slice(i, i + 100));
  for (const chunk of chunks) {
    try {
      const info = await callOzonSellerAPI("/v3/product/info/list", { sku: chunk }, { storeId, userId, timeoutMs: 30000 });
      for (const it of info?.items || []) {
        const url = Array.isArray(it.primary_image) ? (it.primary_image[0] || "") : (it.primary_image || "");
        if (url) dzProductImageCache.set(String(it.sku), { url, expiresAt: Date.now() + 6 * 3600e3 });
      }
    } catch (e) {
      console.warn("[dz-images] Ozon API 图片回填失败:", e.message);
    }
  }
  for (const item of items) {
    const sku = String(item.sku || "").trim();
    const cached = dzProductImageCache.get(sku);
    if (!item.main_image && cached && cached.expiresAt > Date.now()) item.main_image = cached.url;
  }
}

app.get("/api/sourcing/bestsellers", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const strategy = String(req.query.strategy || 'blue_ocean').trim();
    const category = String(req.query.category || '').trim();
    const search = String(req.query.search || '').trim();
    const rank = String(req.query.rank || 'product').trim(); // product=商品(默认) | keyword=关键词 | all=全部
    const source = String(req.query.source || 'dz_blue_ocean').trim(); // 默认只读采集系统数据
    const sort = String(req.query.sort || 'blue_ocean').trim(); // blue_ocean | sales
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
    const offset = Math.max(0, Number(req.query.offset || 0));
    const storeId = String(req.query.store_id || req.query.storeId || "").split(",")[0].trim();
    if (storeId) await assertActiveStoreAccess(storeId, req.user.id, "id");
    const args = [];
    const where = ['active=TRUE'];
    if (source && source !== 'all') { args.push(source); where.push(`source_name=$${args.length}`); }
    if (strategy && strategy !== 'all') { args.push(strategy); where.push(`strategy_type=$${args.length}`); }
    if (rank === 'product') {
      where.push(`COALESCE(source_payload->>'rank','hot') <> 'blue_keyword'`);
    } else if (rank === 'keyword') {
      where.push(`source_payload->>'rank' = 'blue_keyword'`);
    }
    if (category) { args.push(category); where.push(`(category_id=$${args.length} OR category_name ILIKE '%' || $${args.length} || '%')`); }
    if (search) { args.push(search); where.push(`(sku ILIKE '%' || $${args.length} || '%' OR title ILIKE '%' || $${args.length} || '%' OR seller_name ILIKE '%' || $${args.length} || '%')`); }
    const count = await db.query(`SELECT COUNT(*)::int AS total FROM app_top_lists WHERE ${where.join(' AND ')}`, args);
    const orderBy = sort === 'sales'
      ? 'monthly_sales DESC, review_count DESC, updated_at DESC'
      : `(COALESCE((source_payload->>'blueOceanScore')::numeric,0)) DESC, monthly_sales DESC, updated_at DESC`;
    const rows = await db.query(
      `SELECT id, sku, title, main_image, price_rub, monthly_sales, review_count, seller_count,
              category_id, category_name, strategy_type, ozon_url, seller_name, origin_country,
              source_name, source_url, source_captured_at, source_payload, updated_at
         FROM app_top_lists WHERE ${where.join(' AND ')}
        ORDER BY ${orderBy}
        LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, limit, offset],
    );
    // 附加“当前店铺是否已入找货队列”状态，方便榜单页直接看出每个 SKU 的流程进度。
    // 匹配方式：优先 top_list_id，兼容旧数据按 source_sku = app_top_lists.sku 匹配；每个榜单行取最新一条队列记录。
    const queueStates = new Map();
    if (storeId && rows.rows.length) {
      const qr = await db.query(
        `SELECT DISTINCT ON (matched_key) matched_key, stage, status
           FROM (
             SELECT top_list_id AS matched_key, stage, status, updated_at
               FROM app_auto_listing_items
              WHERE user_id=$1 AND store_id=$2 AND top_list_id=ANY($3::uuid[])
             UNION ALL
             SELECT t.id, i.stage, i.status, i.updated_at
               FROM app_auto_listing_items i
               JOIN app_top_lists t ON i.source_sku = t.sku
              WHERE i.user_id=$1 AND i.store_id=$2 AND t.id=ANY($3::uuid[])
           ) matched
          ORDER BY matched_key, updated_at DESC`,
        [req.user.id, storeId, rows.rows.map(r => r.id)],
      );
      for (const q of qr.rows) {
        queueStates.set(q.matched_key, { in_queue: true, queue_stage: q.stage, queue_status: q.status });
      }
    }
    const freshness = await db.query(`SELECT MAX(source_captured_at) AS latest, MIN(source_captured_at) AS oldest FROM app_top_lists WHERE active=TRUE AND source_name=$1`, [source || 'dz_blue_ocean']);
    const items = rows.rows.map((row) => {
      const queueState = queueStates.get(row.id) || { in_queue: false, queue_stage: null, queue_status: null };
      return {
        ...row,
        row_type: "product",
        category_name_zh: categoryNameZh(row.category_name, row.category_id),
        in_queue: queueState.in_queue,
        queue_stage: queueState.queue_stage,
        queue_status: queueState.queue_status,
      };
    });
    // 商品行（非关键词）按 sku 回填主图
    await fillDzProductImages(items, { storeId, userId: req.user.id });
    const productTotal = Number(count.rows[0]?.total || 0);
    return res.json({
      success: true,
      items,
      total: productTotal,
      freshness: freshness.rows[0] || {},
      source_policy: 'dz_blue_ocean',
      note: productTotal ? "" : "当前没有采集数据，请先运行「采集 Ozon 机会池」或等待每日 08:00 自动采集。",
    });
  } catch (error) { next(error); }
});

// 类目分析：按类目聚合 dz 采集数据（蓝海商品 + 热销商品，不含关键词行）
app.get("/api/sourcing/category-analysis", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const source = String(req.query.source || 'dz_blue_ocean').trim();
    const minProducts = Math.max(1, Number(req.query.min_products || 1));
    const rows = await db.query(
      `SELECT category_id, category_name,
              COUNT(*)::int AS product_count,
              ROUND(AVG(COALESCE((source_payload->>'blueOceanScore')::numeric, 0)), 3) AS avg_blue_ocean,
              ROUND(AVG(price_rub), 0) AS avg_price,
              SUM(monthly_sales)::bigint AS total_sales,
              ROUND(AVG(monthly_sales), 0) AS avg_sales,
              MAX(source_captured_at) AS latest_capture
         FROM app_top_lists
        WHERE active=TRUE AND source_name=$1
          AND COALESCE(source_payload->>'rank','hot') <> 'blue_keyword'
          AND category_name <> ''
        GROUP BY category_id, category_name
       HAVING COUNT(*) >= $2
        ORDER BY avg_blue_ocean DESC, total_sales DESC
        LIMIT $3`,
      [source, minProducts, limit],
    );
    const items = rows.rows.map((row) => ({
      ...row,
      category_name_zh: categoryNameZh(row.category_name, row.category_id),
      avg_blue_ocean_100: Math.round(Number(row.avg_blue_ocean || 0) * 1000) / 10,
      avg_price: Number(row.avg_price || 0),
      total_sales: Number(row.total_sales || 0),
      avg_sales: Number(row.avg_sales || 0),
    }));
    return res.json({ success: true, items, total: items.length, source_policy: source });
  } catch (error) { next(error); }
});

app.get("/api/sourcing/category-opportunities", requireAuth, async (req, res, next) => {
  try {
    const storeId = String(req.query.store_id || req.query.storeId || "").split(",")[0].trim();
    const days = Math.min(90, Math.max(7, Number(req.query.days || 28)));
    if (!storeId) return res.status(400).json({ success: false, error: "需要选择店铺" });
    await assertActiveStoreAccess(storeId, req.user.id, "id");
    const cacheKey = `cat_opp:${req.user.id}:${storeId}:${days}`;
    const cached = categoryOpportunityCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < 5 * 60 * 1000) {
      return res.json({ success: true, ...cached.data, cached: true });
    }
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400e3);
    const previousStart = new Date(start.getTime() - days * 86400e3);
    const dimension = "category1";
    const request = (dateFrom, dateTo) => callOzonSellerAPI("/v1/analytics/data", {
      date_from: dateFrom.toISOString().split('T')[0],
      date_to: dateTo.toISOString().split('T')[0],
      metrics: ["ordered_units", "revenue", "returns_units"],
      dimension: [dimension],
      filters: [],
      sort: [{ key: "revenue", order: "DESC" }],
      limit: 100,
      offset: 0,
    }, { storeId, userId: req.user.id });
    const currentData = await request(start, end);
    await sleep(600);
    const previousData = await request(previousStart, start);
    const previousMap = new Map(
      (previousData?.result?.data || []).map(row => {
        const id = String(row.dimensions?.[0]?.id || row.dimensions?.[0]?.name || '');
        return [id, { revenue: Number(row.metrics?.[1] || 0), units: Number(row.metrics?.[0] || 0) }];
      })
    );
    const items = (currentData?.result?.data || []).map(row => {
      const d = row.dimensions?.[0] || {};
      const categoryId = String(d.id || d.name || '');
      const units = Number(row.metrics?.[0] || 0);
      const revenue = Number(row.metrics?.[1] || 0);
      const returns = Number(row.metrics?.[2] || 0);
      const prev = previousMap.get(categoryId) || { revenue: 0, units: 0 };
      const growth = prev.revenue > 0 ? (revenue - prev.revenue) / prev.revenue : (revenue > 0 ? 1 : 0);
      const returnRate = units > 0 ? returns / units : 0;
      const avgPrice = units > 0 ? revenue / units : 0;
      const opportunityScore = Math.max(0, Math.min(100, Math.round(
        (Math.min(30, Math.log10(units + 1) * 12)) +
        (growth > 0 ? Math.min(25, growth * 25) : 0) +
        (returnRate < 0.05 ? 15 : returnRate < 0.1 ? 10 : returnRate < 0.15 ? 5 : 0) +
        (avgPrice > 200 && avgPrice < 3000 ? 10 : avgPrice > 50 ? 5 : 0)
      )));
      return {
        category_id: categoryId,
        category_name: d.name || '未分类',
        category_name_zh: categoryNameZh(d.name || '', categoryId),
        ordered_units: units,
        revenue,
        revenue_rub: revenue,
        previous_revenue: prev.revenue,
        gmv_growth: growth,
        avg_price_rub: avgPrice,
        return_rate: returnRate,
        returns_units: returns,
        opportunity_score: opportunityScore,
        source: "ozon_seller_api",
      };
    }).sort((a, b) => b.opportunity_score - a.opportunity_score || b.revenue - a.revenue);
    const responseData = {
      items,
      total: items.length,
      days,
      source: "ozon_seller_api",
      note: items.length ? "基于 Ozon Seller API 自主分析，无需第三方数据源。" : "Ozon API 未返回类目数据，请检查店铺授权。",
    };
    categoryOpportunityCache.set(cacheKey, { createdAt: Date.now(), data: responseData });
    if (categoryOpportunityCache.size > 50) categoryOpportunityCache.delete(categoryOpportunityCache.keys().next().value);
    res.json({ success: true, ...responseData });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post("/api/sourcing/discover-products", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const categoryIds = Array.isArray(req.body?.category_ids || req.body?.categoryIds)
      ? (req.body.category_ids || req.body.categoryIds)
      : [];
    const result = await discoverOzonProductsFromPlatformCategories({
      categoryIds,
      search: req.body?.search,
      categoryLimit: req.body?.category_limit || req.body?.categoryLimit,
      perCategory: req.body?.per_category || req.body?.perCategory,
      limit: req.body?.limit,
    });
    res.status(result.imported ? 200 : 207).json({ success: result.imported > 0, ...result });
  } catch (error) { next(error); }
});

app.get("/api/sourcing/platform-snapshot/status", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const stats = await db.query(
	      `SELECT COUNT(*)::int AS total,
	              COUNT(*) FILTER (WHERE monthly_sales > 0)::int AS with_sales,
	              COUNT(*) FILTER (WHERE price_rub IS NOT NULL AND price_rub > 0)::int AS with_price,
	              COUNT(*) FILTER (WHERE title <> '')::int AS with_title,
	              COUNT(*) FILTER (WHERE category_name <> '')::int AS with_category,
	              COUNT(*) FILTER (WHERE source_name = 'ozon_public_page')::int AS public_page_rows,
	              MAX(source_captured_at) AS latest_captured_at
	         FROM app_top_lists
	        WHERE active = TRUE`,
    );
    const categoryStats = await db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE sales_units > 0)::int AS with_sales,
              COUNT(*) FILTER (WHERE sales_amount_rub > 0)::int AS with_gmv,
              COUNT(*) FILTER (WHERE category_name_zh <> '')::int AS with_chinese_name,
              MAX(source_captured_at) AS latest_captured_at
         FROM app_platform_categories
        WHERE active = TRUE`,
    );
    const bySource = await db.query(
      `SELECT source_name, COUNT(*)::int AS total, MAX(source_captured_at) AS latest_captured_at
         FROM app_top_lists
        WHERE active = TRUE
        GROUP BY source_name
        ORDER BY total DESC, source_name ASC
        LIMIT 12`,
    );
    res.json({
      success: true,
      stats: {
        ...(stats.rows[0] || {}),
        platform_category_total: categoryStats.rows[0]?.total || 0,
        platform_category_with_sales: categoryStats.rows[0]?.with_sales || 0,
        platform_category_with_gmv: categoryStats.rows[0]?.with_gmv || 0,
        platform_category_with_chinese_name: categoryStats.rows[0]?.with_chinese_name || 0,
        platform_category_latest_captured_at: categoryStats.rows[0]?.latest_captured_at || null,
        myerp_configured: Boolean(MYERP_API_TOKEN),
        myerp_api_base_url: MYERP_API_BASE_URL,
      },
      sources: bySource.rows || [],
      refreshing: Boolean(platformSnapshotRefreshPromise),
      note: MYERP_API_TOKEN
        ? "平台大盘数据来自已配置的 MY ERP 榜单接口；不使用自己店铺订单。"
        : "未配置 MYERP_API_TOKEN，测试环境无法读取 MY ERP/Ozon 平台榜单数据。",
    });
    const total = Number(stats.rows[0]?.total || 0);
    const latest = stats.rows[0]?.latest_captured_at ? new Date(stats.rows[0].latest_captured_at).getTime() : 0;
    if (PLATFORM_SNAPSHOT_REFRESH_INTERVAL_MS > 0 && !MYERP_API_TOKEN && !platformSnapshotRefreshPromise && (total < 30 || !latest || Date.now() - latest > PLATFORM_SNAPSHOT_STALE_MS)) {
      setTimeout(() => maybeRefreshOzonPlatformSnapshots("status-auto"), 100).unref?.();
    }
  } catch (error) { next(error); }
});

app.get("/api/sourcing/opportunity-collector/status", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    res.json(await getOzonOpportunityCollectorStatus());
  } catch (error) { next(error); }
});

app.post("/api/sourcing/opportunity-collector/run", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const limit = Math.min(200, Math.max(10, Number(req.body?.limit || OZON_OPPORTUNITY_DEFAULT_LIMIT)));
    const wait = req.body?.wait === true;
    if (!wait) {
      maybeRefreshOzonOpportunityPool("manual").catch(() => {});
      return res.json({
        success: true,
        queued: true,
        refreshing: Boolean(platformSnapshotRefreshPromise),
        message: "已开始后台采集 Ozon 商品机会；不会自动跑 1688。",
      });
    }
    const result = await importGeoBlueOceanScored({ reason: "manual", limit });
    res.json({
      success: true,
      ...result,
      note: result.note || "已导入 GEO/Ozon 商品机会池；后续需要人工选择商品后再进入 1688 找货。",
    });
  } catch (error) { next(error); }
});

app.get("/api/sourcing/platform-data-source/status", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const stats = await db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE sales_units > 0)::int AS with_sales,
              COUNT(*) FILTER (WHERE sales_amount_rub > 0)::int AS with_gmv,
              COUNT(DISTINCT snapshot_date)::int AS snapshot_days,
              MAX(source_captured_at) AS latest_captured_at
         FROM app_platform_categories
        WHERE active = TRUE`,
    );
    res.json({
      success: true,
      configured: Boolean(MYERP_API_TOKEN),
      source: "myerp_category_analysis",
      api_base_url: MYERP_API_BASE_URL,
      period: MYERP_PLATFORM_PERIOD,
      stats: stats.rows[0] || {},
      note: MYERP_API_TOKEN
        ? "已配置平台榜单数据源，可同步 MY ERP 的 Ozon 类目分析数据。"
        : "未配置 MYERP_API_TOKEN，不能读取 MY ERP 的 Ozon 平台榜单接口。",
    });
  } catch (error) { next(error); }
});

app.post("/api/sourcing/platform-data-source/sync", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    if (req.user.role !== "admin") return res.status(403).json({ success: false, error: "仅管理员可同步平台数据源" });
    if (!MYERP_API_TOKEN) {
      return res.status(400).json({
        success: false,
        code: "MYERP_TOKEN_MISSING",
        error: "测试环境未配置 MYERP_API_TOKEN，无法读取 MY ERP 的 Ozon 平台榜单数据。",
      });
    }
    const result = await syncMyErpCategoryAnalysis({
      period: req.body?.period || MYERP_PLATFORM_PERIOD,
      pages: req.body?.pages || MYERP_PLATFORM_SYNC_PAGES,
      pageSize: req.body?.page_size || req.body?.pageSize || 100,
    });
    res.json({ success: true, ...result });
  } catch (error) { next(error); }
});

function autoListingScore(row = {}) {
  const payload = row.source_payload && typeof row.source_payload === "object" ? row.source_payload : {};
  const geoScore = Number(payload.blue_ocean_score ?? payload.opportunity_score);
  if (Number.isFinite(geoScore) && geoScore > 0) return Math.max(0, Math.min(100, Math.round(geoScore * 10) / 10));
  const sales = Math.max(0, Number(row.monthly_sales || row.sales_units || 0));
  const reviews = Math.max(0, Number(row.review_count || 0));
  const sellers = Math.max(0, Number(row.seller_count || row.sellers || 0));
  const price = Math.max(0, Number(row.price_rub || row.avg_price_rub || 0));
  const demand = Math.min(45, Math.log10(sales + 1) * 18);
  const proof = Math.min(20, Math.log10(reviews + 1) * 7);
  const competition = sellers > 0 ? Math.max(0, 22 - Math.log10(sellers + 1) * 9) : 12;
  const priceFit = price > 0 ? Math.max(0, 13 - Math.abs(price - 1200) / 180) : 4;
  return Math.max(0, Math.min(100, Math.round((demand + proof + competition + priceFit) * 10) / 10));
}

async function insertAutoListingEvent({ userId, storeId, itemId, eventType = "info", stage = "", message = "", payload = {} }) {
  if (!db || !itemId) return;
  await db.query(
    `INSERT INTO app_auto_listing_events (user_id, store_id, item_id, event_type, stage, message, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [userId, storeId, itemId, eventType, stage, message, JSON.stringify(payload || {})],
  );
}

const AUTO_LISTING_STAGES = [
  ["discovered", "已发现"],
  ["collected", "已采集"],
  ["sourcing", "1688 找货"],
  ["materials", "资料完成"],
  ["images", "图片完成"],
  ["pricing", "核价完成"],
  ["ready", "待上架"],
  ["submitted", "已提交 Ozon"],
  ["ozon_fix", "Ozon 待更正"],
  ["listed", "已上架"],
];

app.get("/api/auto-listing/settings", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const storeId = String(req.query.store_id || req.query.storeId || "").split(",")[0].trim();
    if (!storeId) return res.status(400).json({ success: false, error: "需要店铺 ID" });
    await assertActiveStoreAccess(storeId, req.user.id, "id");
    const result = await db.query(
      `INSERT INTO app_auto_listing_settings (user_id, store_id)
       VALUES ($1,$2)
       ON CONFLICT (user_id, store_id) DO UPDATE SET updated_at = app_auto_listing_settings.updated_at
       RETURNING *`,
      [req.user.id, storeId],
    );
    res.json({ success: true, settings: result.rows[0] });
  } catch (error) { next(error); }
});

app.put("/api/auto-listing/settings", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const storeId = String(req.body?.store_id || req.body?.storeId || "").split(",")[0].trim();
    if (!storeId) return res.status(400).json({ success: false, error: "需要店铺 ID" });
    await assertActiveStoreAccess(storeId, req.user.id, "id");
    const dailyQuota = Math.min(500, Math.max(1, Number(req.body?.daily_quota || req.body?.dailyQuota || 30)));
    const minProfitRate = Math.max(0, Math.min(5, Number(req.body?.min_profit_rate ?? req.body?.minProfitRate ?? 0.2)));
    const maxAiCostCny = Math.max(0, Number(req.body?.max_ai_cost_cny ?? req.body?.maxAiCostCny ?? 50));
    const result = await db.query(
      `INSERT INTO app_auto_listing_settings (user_id, store_id, enabled, daily_quota, min_profit_rate, max_ai_cost_cny, submit_to_ozon, rules)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT (user_id, store_id) DO UPDATE SET
         enabled=EXCLUDED.enabled, daily_quota=EXCLUDED.daily_quota, min_profit_rate=EXCLUDED.min_profit_rate,
         max_ai_cost_cny=EXCLUDED.max_ai_cost_cny, submit_to_ozon=EXCLUDED.submit_to_ozon,
         rules=EXCLUDED.rules, updated_at=now()
       RETURNING *`,
      [
        req.user.id,
        storeId,
        Boolean(req.body?.enabled),
        Math.round(dailyQuota),
        minProfitRate,
        maxAiCostCny,
        Boolean(req.body?.submit_to_ozon || req.body?.submitToOzon),
        JSON.stringify(req.body?.rules && typeof req.body.rules === "object" ? req.body.rules : {}),
      ],
    );
    res.json({ success: true, settings: result.rows[0] });
  } catch (error) { next(error); }
});

app.get("/api/auto-listing/dashboard", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const storeId = String(req.query.store_id || req.query.storeId || "").split(",")[0].trim();
    if (!storeId) return res.status(400).json({ success: false, error: "需要店铺 ID" });
    await assertActiveStoreAccess(storeId, req.user.id, "id, name");
    const settingsRes = await db.query(
      `INSERT INTO app_auto_listing_settings (user_id, store_id)
       VALUES ($1,$2)
       ON CONFLICT (user_id, store_id) DO UPDATE SET updated_at = app_auto_listing_settings.updated_at
       RETURNING *`,
      [req.user.id, storeId],
    );
    const countsRes = await db.query(
      `SELECT stage, status, COUNT(*)::int AS count
         FROM app_auto_listing_items
        WHERE user_id=$1 AND store_id=$2
        GROUP BY stage, status`,
      [req.user.id, storeId],
    );
    const todayRes = await db.query(
      `SELECT COUNT(*)::int AS total
         FROM app_auto_listing_items
        WHERE user_id=$1 AND store_id=$2 AND created_at >= date_trunc('day', now())`,
      [req.user.id, storeId],
    );
    const processingRes = await db.query(
      `SELECT id, source_sku, title, main_image, category_name_zh, stage, status, risk_level, human_reason, updated_at
         FROM app_auto_listing_items
        WHERE user_id=$1 AND store_id=$2 AND status IN ('queued','running','needs_human')
        ORDER BY updated_at DESC LIMIT 8`,
      [req.user.id, storeId],
    );
    const eventRes = await db.query(
      `SELECT e.*, i.source_sku, i.title
         FROM app_auto_listing_events e
         JOIN app_auto_listing_items i ON i.id=e.item_id
        WHERE e.user_id=$1 AND e.store_id=$2
        ORDER BY e.created_at DESC LIMIT 20`,
      [req.user.id, storeId],
    );
    const stageCounts = Object.fromEntries(AUTO_LISTING_STAGES.map(([key]) => [key, 0]));
    const statusCounts = { queued: 0, running: 0, paused: 0, needs_human: 0, failed: 0, done: 0 };
    for (const row of countsRes.rows) {
      stageCounts[row.stage] = (stageCounts[row.stage] || 0) + Number(row.count || 0);
      statusCounts[row.status] = (statusCounts[row.status] || 0) + Number(row.count || 0);
    }
    const settings = settingsRes.rows[0];
    const todayTotal = Number(todayRes.rows[0]?.total || 0);
    res.json({
      success: true,
      settings,
      today: { created: todayTotal, quota: Number(settings.daily_quota || 30), percent: Math.min(100, Math.round(todayTotal * 100 / Math.max(1, Number(settings.daily_quota || 30)))) },
      cards: {
        managed: Object.values(stageCounts).reduce((sum, n) => sum + Number(n || 0), 0),
        processing: statusCounts.queued + statusCounts.running,
        ozon_ready: stageCounts.listed,
        needs_human: statusCounts.needs_human + statusCounts.failed,
        store_quota_left: Math.max(0, Number(settings.daily_quota || 30) - todayTotal),
        ai_cost_cny: 0,
      },
      stages: AUTO_LISTING_STAGES.map(([key, label]) => ({ key, label, count: stageCounts[key] || 0 })),
      status_counts: statusCounts,
      processing_items: processingRes.rows,
      events: eventRes.rows,
    });
  } catch (error) { next(error); }
});

app.get("/api/auto-listing/items", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const storeId = String(req.query.store_id || req.query.storeId || "").split(",")[0].trim();
    if (!storeId) return res.status(400).json({ success: false, error: "需要店铺 ID" });
    await assertActiveStoreAccess(storeId, req.user.id, "id");
    const stage = String(req.query.stage || "all").trim();
    const search = String(req.query.search || "").trim();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 30)));
    const offset = Math.max(0, Number(req.query.offset || 0));
    const args = [req.user.id, storeId];
    const where = ["user_id=$1", "store_id=$2"];
    if (stage !== "all") { args.push(stage); where.push(`stage=$${args.length}`); }
    if (search) {
      args.push(`%${search}%`);
      where.push(`(source_sku ILIKE $${args.length} OR title ILIKE $${args.length} OR category_name_zh ILIKE $${args.length})`);
    }
    const count = await db.query(`SELECT COUNT(*)::int AS total FROM app_auto_listing_items WHERE ${where.join(" AND ")}`, args);
    const rows = await db.query(
      `SELECT * FROM app_auto_listing_items WHERE ${where.join(" AND ")}
       ORDER BY updated_at DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, limit, offset],
    );
    res.json({ success: true, items: rows.rows, total: Number(count.rows[0]?.total || 0), stages: AUTO_LISTING_STAGES });
  } catch (error) { next(error); }
});

app.get("/api/auto-listing/items/:id/events", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const id = String(req.params.id || "").trim();
    const itemRes = await db.query(`SELECT * FROM app_auto_listing_items WHERE id=$1 AND user_id=$2`, [id, req.user.id]);
    if (!itemRes.rowCount) return res.status(404).json({ success: false, error: "找货候选不存在" });
    const item = itemRes.rows[0];
    await assertActiveStoreAccess(item.store_id, req.user.id, "id");
    const events = await db.query(
      `SELECT * FROM app_auto_listing_events
        WHERE user_id=$1 AND store_id=$2 AND item_id=$3
        ORDER BY created_at DESC LIMIT 80`,
      [req.user.id, item.store_id, id],
    );
    res.json({ success: true, item, events: events.rows });
  } catch (error) { next(error); }
});

app.post("/api/auto-listing/discover", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const storeId = String(req.body?.store_id || req.body?.storeId || "").split(",")[0].trim();
    if (!storeId) return res.status(400).json({ success: false, error: "需要店铺 ID" });
    await assertActiveStoreAccess(storeId, req.user.id, "id");
    const sourceIds = Array.isArray(req.body?.source_ids || req.body?.sourceIds) ? (req.body.source_ids || req.body.sourceIds).map(String) : [];
    const limit = Math.min(100, Math.max(1, Number(req.body?.limit || 20)));
    const strategy = String(req.body?.strategy || "hot").trim();
    let rows;
    if (sourceIds.length) {
      rows = await db.query(
        `SELECT * FROM app_top_lists WHERE active=TRUE AND id=ANY($1::uuid[]) ORDER BY monthly_sales DESC LIMIT $2`,
        [sourceIds, limit],
      );
    } else {
      const args = [];
      const where = ["active=TRUE"];
      if (strategy && strategy !== "all") { args.push(strategy); where.push(`strategy_type=$${args.length}`); }
      rows = await db.query(
        `SELECT * FROM app_top_lists WHERE ${where.join(" AND ")}
         ORDER BY monthly_sales DESC, review_count DESC, updated_at DESC LIMIT $${args.length + 1}`,
        [...args, limit],
      );
    }
    const inserted = [];
    const skipped = [];
    for (const row of rows.rows) {
      const sku = String(row.sku || "").trim();
      if (!sku) continue;
      const score = autoListingScore(row);
      const riskLevel = score >= 70 ? "low" : score >= 45 ? "normal" : "high";
      const result = await db.query(
        `INSERT INTO app_auto_listing_items (
           user_id, store_id, top_list_id, source_sku, title, main_image, ozon_url,
           category_name, category_name_zh, seller_name, price_rub, monthly_sales, review_count,
           seller_count, opportunity_score, risk_level, payload
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
         ON CONFLICT (user_id, store_id, source_sku) DO UPDATE SET
           title=EXCLUDED.title, main_image=EXCLUDED.main_image, price_rub=EXCLUDED.price_rub,
           monthly_sales=EXCLUDED.monthly_sales, review_count=EXCLUDED.review_count,
           seller_count=EXCLUDED.seller_count, opportunity_score=EXCLUDED.opportunity_score,
           risk_level=EXCLUDED.risk_level, updated_at=now()
         RETURNING id, source_sku, title, stage, status`,
        [
          req.user.id,
          storeId,
          row.id,
          sku,
          row.title || "",
          row.main_image || "",
          row.ozon_url || (sku ? `https://www.ozon.ru/product/${sku}/` : ""),
          row.category_name || "",
          categoryNameZh(row.category_name || "", row.category_id || ""),
          row.seller_name || "",
          Number(row.price_rub || 0) || null,
          Math.max(0, Number(row.monthly_sales || 0)),
          Math.max(0, Number(row.review_count || 0)),
          Number.isFinite(Number(row.seller_count)) ? Math.max(0, Number(row.seller_count)) : null,
          score,
          riskLevel,
          JSON.stringify({
            source_name: row.source_name,
            source_captured_at: row.source_captured_at,
            strategy_type: row.strategy_type,
            source_payload: row.source_payload || {},
            blue_ocean_score: row.source_payload?.blue_ocean_score,
            opportunity_level: row.source_payload?.opportunity_level,
            demand_score: row.source_payload?.demand_score,
            growth_score: row.source_payload?.growth_score,
            competition_score: row.source_payload?.competition_score,
            profit_score: row.source_payload?.profit_score,
            content_gap_score: row.source_payload?.content_gap_score,
            risk_score: row.source_payload?.risk_score,
            reasons: row.source_payload?.reasons,
          }),
        ],
      );
      inserted.push(result.rows[0]);
      await insertAutoListingEvent({ userId: req.user.id, storeId, itemId: result.rows[0].id, stage: "discovered", message: "进入找货候选队列，等待人工推进 1688 找货" });
    }
    res.json({ success: true, inserted, skipped, insertedCount: inserted.length, skippedCount: skipped.length });
  } catch (error) { next(error); }
});

app.post("/api/auto-listing/items/:id/advance", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const id = String(req.params.id || "").trim();
    const rowRes = await db.query(`SELECT * FROM app_auto_listing_items WHERE id=$1 AND user_id=$2 FOR UPDATE`, [id, req.user.id]);
    if (!rowRes.rowCount) return res.status(404).json({ success: false, error: "自动上架商品不存在" });
    const item = rowRes.rows[0];
    await assertActiveStoreAccess(item.store_id, req.user.id, "id");
    const stageKeys = AUTO_LISTING_STAGES.map(([key]) => key);
    const currentIndex = Math.max(0, stageKeys.indexOf(item.stage));
    let nextStage = String(req.body?.stage || "").trim();
    if (!nextStage || !stageKeys.includes(nextStage)) nextStage = stageKeys[Math.min(stageKeys.length - 1, currentIndex + 1)];
    let collectItemId = item.collect_item_id;
    let status = nextStage === "ready" || nextStage === "submitted" ? "needs_human" : "running";
    let message = `推进到${AUTO_LISTING_STAGES.find(([key]) => key === nextStage)?.[1] || nextStage}`;
    if (item.stage === "discovered" && nextStage !== "discovered" && !collectItemId) {
      const collect = await db.query(
        `INSERT INTO collect_items (
           user_id, store_id, source_type, source_value, ozon_url, ozon_sku,
           title, main_image, images, price_rub, attributes, status
         ) VALUES ($1,$2,'auto-listing',$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,'scraped')
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          req.user.id,
          item.store_id,
          item.source_sku || item.ozon_url,
          item.ozon_url || (item.source_sku ? `https://www.ozon.ru/product/${item.source_sku}/` : ""),
          item.source_sku,
          item.title,
          item.main_image,
          JSON.stringify(item.main_image ? [item.main_image] : []),
          Number(item.price_rub || 0) || null,
          JSON.stringify({ auto_listing_item_id: item.id, category_name_zh: item.category_name_zh }),
        ],
      );
      collectItemId = collect.rows[0]?.id || collectItemId;
      nextStage = nextStage === "collected" ? nextStage : "collected";
      status = "queued";
      message = "已加入采集箱，等待后续找货和资料补全";
    }
    const updated = await db.query(
      `UPDATE app_auto_listing_items
          SET stage=$1, status=$2, collect_item_id=COALESCE($3, collect_item_id),
              human_reason=CASE WHEN $2='needs_human' THEN '提交 Ozon 前需要人工确认' ELSE human_reason END,
              updated_at=now()
        WHERE id=$4 AND user_id=$5
        RETURNING *`,
      [nextStage, status, collectItemId, item.id, req.user.id],
    );
    await insertAutoListingEvent({ userId: req.user.id, storeId: item.store_id, itemId: item.id, eventType: status, stage: nextStage, message });
    res.json({ success: true, item: updated.rows[0] });
  } catch (error) { next(error); }
});

app.post("/api/auto-listing/items/start-sourcing", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const storeId = String(req.body?.store_id || req.body?.storeId || "").split(",")[0].trim();
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean).slice(0, 80) : [];
    if (!storeId) return res.status(400).json({ success: false, error: "需要店铺 ID" });
    if (!ids.length) return res.status(400).json({ success: false, error: "请选择找货候选" });
    await assertActiveStoreAccess(storeId, req.user.id, "id");
    const rows = await db.query(
      `SELECT * FROM app_auto_listing_items
        WHERE user_id=$1 AND store_id=$2 AND id=ANY($3::uuid[])
        ORDER BY opportunity_score DESC, monthly_sales DESC, updated_at DESC`,
      [req.user.id, storeId, ids],
    );
    const items = rows.rows || [];
    const urlRows = items
      .map((item, index) => ({
        sourceRow: index + 1,
        url: item.ozon_url || (item.source_sku ? `https://www.ozon.ru/product/${item.source_sku}/` : ""),
        item,
      }))
      .filter((entry) => /^https?:\/\/(?:www\.)?ozon\.ru\/product\//i.test(entry.url));
    if (!urlRows.length) return res.status(400).json({ success: false, error: "所选候选没有有效 Ozon 商品链接" });
    const activeJob = await findActiveDbJobForUser(req.user, { kind: "run", storeId });
    if (activeJob) {
      return res.json({
        success: true,
        existing: true,
        jobId: activeJob.id,
        job: activeJob,
        queued: activeJob.status === "queued",
        count: activeJob.total || 0,
      });
    }
    const id = crypto.randomUUID();
    const urls = urlRows.map((entry) => entry.url);
    const job = {
      id,
      storeId,
      kind: "run",
      status: "queued",
      phase: "等待本机采集端领取",
      total: urls.length,
      sourceTotal: urls.length,
      sourceStartRow: 1,
    };
    const queued = await createQueuedDbJob(req.user, job, {
      urls,
      urlRows: urlRows.map(({ sourceRow, url, item }) => ({
        sourceRow,
        url,
        autoListingItemId: item.id,
        sku: item.source_sku,
        title: item.title,
      })),
      storeId,
      options: {
        urls,
        urlRows: urlRows.map(({ sourceRow, url }) => ({ sourceRow, url })),
        startRow: 1,
        sourceTotal: urls.length,
        maxCandidates: Math.min(8, Math.max(3, Number(req.body?.maxCandidates || 5))),
        storeId,
        enable1688: true,
        enableAI: true,
        delayMinMs: Math.max(5000, Number(req.body?.delayMinMs || 8000)),
        delayMaxMs: Math.max(8000, Number(req.body?.delayMaxMs || 20000)),
        maxConsecutiveFailures: 3,
        headless: false,
      },
      raw: { from: "market-discovery", item_ids: items.map((item) => item.id) },
    });
    await db.query(
      `UPDATE app_auto_listing_items
          SET stage='sourcing',
              status='queued',
              human_reason='已创建真实单品找货任务，等待本机采集端领取',
              payload = COALESCE(payload,'{}'::jsonb) || $4::jsonb,
              updated_at=now()
        WHERE user_id=$1 AND store_id=$2 AND id=ANY($3::uuid[])`,
      [req.user.id, storeId, items.map((item) => item.id), JSON.stringify({ sourcing_job_id: queued.id, sourcing_job_created_at: new Date().toISOString() })],
    );
    for (const item of items) {
      await insertAutoListingEvent({
        userId: req.user.id,
        storeId,
        itemId: item.id,
        eventType: "queued",
        stage: "sourcing",
        message: `已创建真实 1688 找货任务 ${queued.id}，等待本机采集端领取`,
        payload: { job_id: queued.id },
      });
    }
    res.json({ success: true, jobId: queued.id, job: queued, queued: true, count: items.length });
  } catch (error) { next(error); }
});

app.patch("/api/auto-listing/items/:id", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const id = String(req.params.id || "").trim();
    const rowRes = await db.query(`SELECT * FROM app_auto_listing_items WHERE id=$1 AND user_id=$2`, [id, req.user.id]);
    if (!rowRes.rowCount) return res.status(404).json({ success: false, error: "找货候选不存在" });
    const item = rowRes.rows[0];
    await assertActiveStoreAccess(item.store_id, req.user.id, "id");
    const stageKeys = AUTO_LISTING_STAGES.map(([key]) => key);
    const sets = ["updated_at=now()"];
    const params = [id, req.user.id];
    const allowedStatuses = new Set(["queued", "running", "paused", "needs_human", "failed", "done"]);
    if (req.body?.stage !== undefined) {
      const stage = String(req.body.stage || "").trim();
      if (!stageKeys.includes(stage)) return res.status(400).json({ success: false, error: "阶段无效" });
      params.push(stage); sets.push(`stage=$${params.length}`);
    }
    if (req.body?.status !== undefined) {
      const status = String(req.body.status || "").trim();
      if (!allowedStatuses.has(status)) return res.status(400).json({ success: false, error: "状态无效" });
      params.push(status); sets.push(`status=$${params.length}`);
    }
    if (req.body?.note !== undefined) {
      params.push(String(req.body.note || "").slice(0, 1000)); sets.push(`note=$${params.length}`);
    }
    if (req.body?.human_reason !== undefined || req.body?.humanReason !== undefined) {
      params.push(String(req.body.human_reason ?? req.body.humanReason ?? "").slice(0, 1000)); sets.push(`human_reason=$${params.length}`);
    }
    if (sets.length === 1) return res.status(400).json({ success: false, error: "没有可更新字段" });
    const updated = await db.query(
      `UPDATE app_auto_listing_items SET ${sets.join(", ")}
        WHERE id=$1 AND user_id=$2 RETURNING *`,
      params,
    );
    await insertAutoListingEvent({
      userId: req.user.id,
      storeId: item.store_id,
      itemId: item.id,
      eventType: "update",
      stage: updated.rows[0].stage,
      message: "已更新候选信息",
      payload: req.body || {},
    });
    res.json({ success: true, item: updated.rows[0] });
  } catch (error) { next(error); }
});

app.delete("/api/auto-listing/items/:id", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const id = String(req.params.id || "").trim();
    const itemRes = await db.query(`SELECT * FROM app_auto_listing_items WHERE id=$1 AND user_id=$2`, [id, req.user.id]);
    if (!itemRes.rowCount) return res.status(404).json({ success: false, error: "找货候选不存在" });
    await assertActiveStoreAccess(itemRes.rows[0].store_id, req.user.id, "id");
    await db.query(`DELETE FROM app_auto_listing_items WHERE id=$1 AND user_id=$2`, [id, req.user.id]);
    res.json({ success: true, deleted: 1 });
  } catch (error) { next(error); }
});

app.post("/api/auto-listing/items/bulk-action", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const storeId = String(req.body?.store_id || req.body?.storeId || "").split(",")[0].trim();
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : [];
    const action = String(req.body?.action || "").trim();
    if (!storeId) return res.status(400).json({ success: false, error: "需要店铺 ID" });
    if (!ids.length) return res.status(400).json({ success: false, error: "请选择商品" });
    await assertActiveStoreAccess(storeId, req.user.id, "id");
    let status = null;
    let stage = null;
    let message = "";
    if (action === "pause") { status = "paused"; message = "已暂停"; }
    else if (action === "resume") { status = "queued"; message = "已恢复排队"; }
    else if (action === "needs_human") { status = "needs_human"; message = "已转人工处理"; }
    else if (action === "ready") { stage = "ready"; status = "needs_human"; message = "已进入待上架，等待人工确认"; }
    else if (action === "delete") {
      const result = await db.query(
        `DELETE FROM app_auto_listing_items
          WHERE user_id=$1 AND store_id=$2 AND id=ANY($3::uuid[])`,
        [req.user.id, storeId, ids],
      );
      return res.json({ success: true, deleted: result.rowCount, updated: result.rowCount });
    }
    else return res.status(400).json({ success: false, error: "不支持的批量动作" });
    const sets = ["status=$1", "updated_at=now()"];
    const params = [status, req.user.id, storeId, ids];
    if (stage) { sets.push("stage=$5"); params.push(stage); }
    const result = await db.query(
      `UPDATE app_auto_listing_items SET ${sets.join(", ")}
        WHERE user_id=$2 AND store_id=$3 AND id=ANY($4::uuid[])
        RETURNING id, stage`,
      params,
    );
    for (const item of result.rows) {
      await insertAutoListingEvent({ userId: req.user.id, storeId, itemId: item.id, eventType: status, stage: item.stage, message });
    }
    res.json({ success: true, updated: result.rowCount });
  } catch (error) { next(error); }
});

app.post("/api/sourcing/platform-snapshot/refresh", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const wait = req.body?.wait !== false;
    const limit = Math.min(200, Math.max(10, Number(req.body?.limit || PLATFORM_SNAPSHOT_DEFAULT_LIMIT)));
    if (!wait) {
      maybeRefreshOzonPlatformSnapshots("manual").catch(() => {});
      return res.json({ success: true, queued: true, refreshing: Boolean(platformSnapshotRefreshPromise), message: "已开始后台刷新 Ozon 平台样本" });
    }
    const result = await refreshOzonPlatformSnapshots({ reason: "manual", limit });
    res.json({ success: true, ...result });
  } catch (error) { next(error); }
});

app.post("/api/sourcing/platform-snapshot/batch-upsert", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!rawItems.length) return res.status(400).json({ success: false, error: "请提供商品数据列表" });
    const strategy = ["hot", "new", "potential", "blue_ocean"].includes(String(req.body?.strategy_type || "hot"))
      ? String(req.body?.strategy_type || "hot") : "hot";
    const sourceName = String(req.body?.source_name || "extension_discovery").trim();
    const sourceUrl = String(req.body?.source_url || "").trim();
    const imported = [];
    const errors = [];
    const seenSkus = new Set();
    for (let i = 0; i < rawItems.length && i < 200; i++) {
      const raw = rawItems[i] || {};
      const sku = String(raw.sku || raw.skuId || "").replace(/[^\d]/g, "");
      if (!sku || seenSkus.has(sku)) continue;
      seenSkus.add(sku);
      try {
        const item = {
          sku,
          title: String(raw.title || raw.name || ""),
          main_image: String(raw.main_image || raw.image || raw.mainImage || ""),
          price_rub: raw.price_rub != null ? Number(raw.price_rub) : (raw.price != null ? Number(raw.price) : null),
          monthly_sales: Math.max(0, Math.floor(Number(raw.monthly_sales || raw.sales || 0))),
          review_count: Math.max(0, Math.floor(Number(raw.review_count || raw.reviews || 0))),
          seller_count: Number.isFinite(Number(raw.seller_count)) ? Math.max(0, Math.floor(Number(raw.seller_count))) : null,
          category_id: String(raw.category_id || raw.categoryId || ""),
          category_name: String(raw.category_name || raw.category || ""),
          strategy_type: strategy,
          ozon_url: String(raw.ozon_url || raw.url || `https://www.ozon.ru/product/${sku}/`),
          seller_name: String(raw.seller_name || raw.seller || ""),
          origin_country: String(raw.origin_country || ""),
          delivery_text: String(raw.delivery_text || ""),
          source_name: sourceName,
          source_url: sourceUrl || String(raw.ozon_url || raw.url || ""),
          source_captured_at: new Date().toISOString(),
          source_payload: { capture_method: "extension_search", ...raw },
        };
        const row = await upsertPlatformSnapshotItem(item);
        imported.push({ ...row, category_name_zh: categoryNameZh(row.category_name || "", item.category_id || "") });
      } catch (error) {
        errors.push({ sku, error: error.message });
      }
    }
    res.status(errors.length && !imported.length ? 400 : 200).json({
      success: errors.length === 0,
      imported: imported.length,
      failed: errors.length,
      items: imported,
      errors: errors.slice(0, 20),
    });
  } catch (error) { next(error); }
});

app.post("/api/sourcing/platform-snapshot/collect", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const rawInputs = Array.isArray(req.body?.items)
      ? req.body.items.map((item) => item?.url || item?.sku || item).filter(Boolean)
      : String(req.body?.urls || req.body?.text || "")
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
    const normalized = [];
    const seen = new Set();
    for (const input of rawInputs) {
      const item = normalizeOzonSnapshotInput(input);
      if (!item || seen.has(item.sku)) continue;
      seen.add(item.sku);
      normalized.push(item.url);
      if (normalized.length >= 100) break;
    }
    if (!normalized.length) return res.status(400).json({ success: false, error: "请粘贴 Ozon 商品链接或 SKU" });
    const strategy = ["hot", "new", "potential", "blue_ocean"].includes(String(req.body?.strategy_type || req.body?.strategy || "hot"))
      ? String(req.body?.strategy_type || req.body?.strategy || "hot")
      : "hot";
    const imported = [];
    const errors = [];
    for (let index = 0; index < normalized.length; index += 1) {
      try {
        const item = await fetchOzonPublicSnapshot(normalized[index]);
        item.strategy_type = strategy;
        const row = await upsertPlatformSnapshotItem(item);
        imported.push({ ...row, category_name_zh: categoryNameZh(row.category_name || "", item.category_id || "") });
      } catch (error) {
        const sku = normalizeOzonSnapshotInput(normalized[index])?.sku || "";
        errors.push({ row: index + 1, sku, url: normalized[index], error: error.message });
      }
    }
    res.status(errors.length && imported.length ? 207 : errors.length ? 400 : 200).json({
      success: errors.length === 0,
      imported: imported.length,
      failed: errors.length,
      items: imported,
      errors,
      note: "已写入 Ozon 平台公开页快照；销量/GMV/增长等榜单指标未从公开商品页伪造。",
    });
  } catch (error) { next(error); }
});

app.post("/api/sourcing/bestsellers/import", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, error: '仅管理员可导入公共榜单' });
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 5000) : [];
    const defaultSource = String(req.body?.source_name || '').trim();
    const defaultCapturedAt = req.body?.source_captured_at;
    if (!items.length) return res.status(400).json({ success: false, error: 'items 不能为空' });
    const imported = [];
    const errors = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index] || {};
      const sku = String(item.sku || item.product_id || '').trim();
      const sourceName = String(item.source_name || defaultSource || 'geo_ozon_blue_ocean').trim();
      const capturedAt = new Date(item.source_captured_at || item.scraped_at || defaultCapturedAt || '');
      if (!sku || !/^\d{6,}$/.test(sku)) { errors.push({ row: index + 1, sku, error: 'SKU 无效' }); continue; }
      if (!sourceName || Number.isNaN(capturedAt.getTime())) { errors.push({ row: index + 1, sku, error: '缺少有效 source_name/source_captured_at' }); continue; }
      const classification = classifyChinaMarketItem(item);
      const strategy = ['hot', 'new', 'potential', 'blue_ocean'].includes(String(item.strategy_type || item.strategy || 'hot')) ? String(item.strategy_type || item.strategy || 'hot') : 'hot';
      const result = await db.query(
        `INSERT INTO app_top_lists (sku,title,main_image,price_rub,monthly_sales,review_count,seller_count,category_id,category_name,strategy_type,ozon_url,seller_name,origin_country,delivery_text,is_china_origin,china_confidence,china_evidence,source_name,source_url,source_captured_at,source_payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb)
         ON CONFLICT (sku) DO UPDATE SET title=EXCLUDED.title, main_image=EXCLUDED.main_image, price_rub=EXCLUDED.price_rub,
           monthly_sales=EXCLUDED.monthly_sales, review_count=EXCLUDED.review_count, seller_count=EXCLUDED.seller_count,
           category_id=EXCLUDED.category_id, category_name=EXCLUDED.category_name, strategy_type=EXCLUDED.strategy_type,
           ozon_url=EXCLUDED.ozon_url, seller_name=EXCLUDED.seller_name, origin_country=EXCLUDED.origin_country,
           delivery_text=EXCLUDED.delivery_text, is_china_origin=EXCLUDED.is_china_origin, china_confidence=EXCLUDED.china_confidence,
           china_evidence=EXCLUDED.china_evidence, source_name=EXCLUDED.source_name, source_url=EXCLUDED.source_url,
           source_captured_at=EXCLUDED.source_captured_at, source_payload=EXCLUDED.source_payload, active=TRUE, updated_at=now()
         RETURNING id, sku`,
        [sku, String(item.title || item.name || item.product_name || item.keyword || ''), String(item.main_image || item.image || item.image_url || ''), Number(item.price_rub || item.price || item.avg_price || 0) || null,
         Math.max(0, Math.floor(Number(item.monthly_sales || item.sales || item.sales_30d || 0))), Math.max(0, Math.floor(Number(item.review_count || item.reviews || item.avg_reviews || item.top_reviews || 0))),
         Number.isFinite(Number(item.seller_count || item.sellers)) ? Math.max(0, Math.floor(Number(item.seller_count || item.sellers))) : null,
         String(item.category_id || ''), String(item.category_name || item.category || ''), strategy,
         String(item.ozon_url || item.source_url || `https://www.ozon.ru/product/${sku}/`), String(item.seller_name || item.seller || item.brand || ''),
         String(item.origin_country || ''), String(item.delivery_text || ''), classification.isChina, classification.confidence, classification.evidence,
         sourceName, String(item.source_url || ''), capturedAt.toISOString(), JSON.stringify(item)],
      );
      imported.push(result.rows[0]);
    }
    res.status(errors.length && imported.length ? 207 : errors.length ? 400 : 200).json({ success: errors.length === 0, imported: imported.length, failed: errors.length, errors });
  } catch (error) { next(error); }
});

app.get("/api/sourcing/china-zone", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const minSales = Math.max(0, Number(req.query.min_sales || 1));
    const search = String(req.query.search || '').trim();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
    const offset = Math.max(0, Number(req.query.offset || 0));
    const args = [minSales];
    const where = [`t.active=TRUE`, `t.monthly_sales >= $1`, `(t.is_china_origin=TRUE OR COALESCE(s.is_confirmed,FALSE)=TRUE)`];
    if (search) { args.push(search); where.push(`(t.sku ILIKE '%'||$${args.length}||'%' OR t.title ILIKE '%'||$${args.length}||'%' OR t.seller_name ILIKE '%'||$${args.length}||'%')`); }
    const count = await db.query(`SELECT COUNT(*)::int AS total FROM app_top_lists t LEFT JOIN app_china_sellers s ON s.seller_name=t.seller_name WHERE ${where.join(' AND ')}`, args);
    const rows = await db.query(
      `SELECT t.id,t.sku,t.title,t.main_image,t.price_rub,t.monthly_sales,t.review_count,t.category_name,t.ozon_url,
              t.seller_name,t.origin_country,t.china_confidence,t.china_evidence,t.source_name,t.source_captured_at,
              COALESCE(s.is_confirmed,FALSE) AS seller_confirmed, COALESCE(s.reliability_score,t.china_confidence) AS reliability_score
         FROM app_top_lists t LEFT JOIN app_china_sellers s ON s.seller_name=t.seller_name
        WHERE ${where.join(' AND ')} ORDER BY t.monthly_sales DESC,t.review_count DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, limit, offset],
    );
    const items = rows.rows.map((row) => ({
      ...row,
      category_name_zh: categoryNameZh(row.category_name, row.category_id),
    }));
    res.json({ success: true, items, total: count.rows[0]?.total || 0 });
  } catch (error) { next(error); }
});

app.post("/api/sourcing/china-zone/verify", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, error: '仅管理员可纠偏中国卖家' });
    const sellerName = String(req.body?.seller_name || '').trim();
    if (!sellerName) return res.status(400).json({ success: false, error: 'seller_name 必填' });
    const confirmed = req.body?.is_confirmed === true;
    const score = confirmed ? Math.min(1, Math.max(0.8, Number(req.body?.reliability_score || 1))) : 0;
    const result = await db.query(
      `INSERT INTO app_china_sellers (seller_name,identified_method,is_confirmed,reliability_score,note,updated_by)
       VALUES ($1,'manual',$2,$3,$4,$5) ON CONFLICT (seller_name) DO UPDATE SET is_confirmed=EXCLUDED.is_confirmed,
       reliability_score=EXCLUDED.reliability_score,note=EXCLUDED.note,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
      [sellerName, confirmed, score, String(req.body?.note || '').slice(0, 500), req.user.id],
    );
    res.json({ success: true, seller: result.rows[0] });
  } catch (error) { next(error); }
});

app.get("/api/finance/settings", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const rateResult = await db.query(
      `SELECT rate, source, effective_at
         FROM app_exchange_rates
        WHERE base_currency = 'RUB' AND quote_currency = 'CNY'
        ORDER BY effective_at DESC LIMIT 1`,
    );
    const latest = rateResult.rows[0] || null;
    res.json({
      success: true,
      exchange_rate: latest ? Number(latest.rate) : RUB_CNY_RATE,
      exchange_rate_source: latest?.source || "environment",
      exchange_rate_effective_at: latest?.effective_at || null,
    });
  } catch (error) { next(error); }
});

app.post("/api/finance/exchange-rate", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    if (req.user.role !== "admin") return res.status(403).json({ success: false, error: "仅管理员可维护汇率" });
    const rate = Number(req.body?.rate);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1) {
      return res.status(400).json({ success: false, error: "请输入有效的 RUB/CNY 汇率" });
    }
    const result = await db.query(
      `INSERT INTO app_exchange_rates (rate, source, effective_at, created_by)
       VALUES ($1, 'manual', now(), $2) RETURNING rate, source, effective_at`,
      [rate, req.user.id],
    );
    res.json({ success: true, exchange_rate: Number(result.rows[0].rate), effective_at: result.rows[0].effective_at });
  } catch (error) { next(error); }
});

app.get("/api/finance/cost-audit", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const storeId = String(req.query.store_id || "").trim();
    if (!storeId) return res.status(400).json({ success: false, error: "未选择店铺" });
    const result = await db.query(
      `SELECT a.id, a.offer_id, a.old_value, a.new_value, a.reason, a.created_at,
              COALESCE(u.display_name, u.username, '') AS changed_by_name
         FROM app_product_cost_audit a
         LEFT JOIN app_users u ON u.id = a.changed_by
        WHERE a.user_id = $1 AND a.store_id = $2
        ORDER BY a.created_at DESC LIMIT 100`,
      [req.user.id, storeId],
    );
    res.json({ success: true, items: result.rows });
  } catch (error) { next(error); }
});

app.post("/api/finance/product-cost", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  const client = await db.connect();
  try {
    const storeId = String(req.body?.store_id || "").trim();
    const offerId = String(req.body?.offer_id || "").trim();
    const value = Number(req.body?.purchase_price_cny);
    const reason = String(req.body?.reason || "经营分析补录").trim().slice(0, 300);
    if (!storeId || !offerId) return res.status(400).json({ success: false, error: "店铺和货号必填" });
    if (!Number.isFinite(value) || value < 0 || value > 1000000) {
      return res.status(400).json({ success: false, error: "请输入有效采购成本" });
    }
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT id, purchase_price_cny FROM app_products
        WHERE user_id = $1 AND store_id = $2 AND offer_id = $3 FOR UPDATE`,
      [req.user.id, storeId, offerId],
    );
    if (!current.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, error: "商品不存在，请先同步商品列表" });
    }
    const oldValue = current.rows[0].purchase_price_cny == null ? null : Number(current.rows[0].purchase_price_cny);
    await client.query(
      `UPDATE app_products SET purchase_price_cny = $1, updated_at = now()
        WHERE id = $2 AND user_id = $3`,
      [value, current.rows[0].id, req.user.id],
    );
    await client.query(
      `INSERT INTO app_product_cost_audit
        (user_id, store_id, product_id, offer_id, old_value, new_value, reason, changed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$1)`,
      [req.user.id, storeId, current.rows[0].id, offerId, oldValue, value, reason],
    );
    await client.query("COMMIT");
    res.json({ success: true, offer_id: offerId, old_value: oldValue, new_value: value });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally { client.release(); }
});

/**
 * v0.5.0 仪表盘经营统计 - 对标 MyERP
 * 数据源:
 *   - Ozon API 实时拉订单 (今日/7日/待打包/待发货/退货)
 *   - app_products 本地聚合 (在售/库存预警)
 *   - app_stores 多店对比
 * 金额: 严格按 v0.3.5c 币种感知 (CNY 直读, RUB × 0.0862)
 * v2.2.9.100 提速: 每店订单合并为 1 次 7 天全量查询(内存分桶/过滤), 并加 60s 结果缓存
 */
const DASHBOARD_CACHE_TTL_MS = Number(process.env.DASHBOARD_CACHE_TTL_MS || 60 * 1000);
const dashboardCache = new Map();  // key=`userId:range` → { at, data }

app.get("/api/seller/dashboard", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const userId = req.user.id;
    const range = Math.min(30, Math.max(7, Number(req.query.range) || 7));
    // v2.2.9.100: 结果缓存 — TTL 内重复打开/刷新秒回，显著降低 Ozon API 压力与页面加载耗时
    const cacheKey = `dashboard:${userId}:${range}`;
    const cachedEntry = dashboardCache.get(cacheKey);
    if (cachedEntry && Date.now() - cachedEntry.at < DASHBOARD_CACHE_TTL_MS) {
      return res.json({
        ...cachedEntry.data,
        cached: true,
        ageSeconds: Math.round((Date.now() - cachedEntry.at) / 1000),
        generated_at: new Date(cachedEntry.at).toISOString(),
      });
    }
    const rateResult = await db.query(
      `SELECT rate FROM app_exchange_rates
        WHERE base_currency = 'RUB' AND quote_currency = 'CNY'
        ORDER BY effective_at DESC LIMIT 1`,
    );
    const effectiveRubCnyRate = Number(rateResult.rows[0]?.rate || RUB_CNY_RATE);
    const convertRub = value => Math.round(Number(value || 0) * effectiveRubCnyRate * 100) / 100;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(now.getTime() - range * 86400e3);
    const yesterdayStart = new Date(todayStart.getTime() - 86400e3);
    const todayStartISO = todayStart.toISOString();
    const weekAgoISO = weekAgo.toISOString();
    const yesterdayStartISO = yesterdayStart.toISOString();
    const nowISO = now.toISOString();

    // 1. 查所有 active 店铺
    const storesRes = await db.query(
      `SELECT id, name, client_id, api_key
         FROM app_stores
        WHERE active = TRUE AND user_id = $1`,
      [userId],
    );
    const stores = storesRes.rows;
    if (!stores.length) {
      return res.json({ success: true, summary: {}, store_comparison: [], trends: [] });
    }

    // 2. 并行调每个店铺的 Ozon 订单 API (今日 + 7 日 + 待打包 + 待发货 + 退货)
    const fetchStoreOrders = async (store, since, to, status) => {
      try {
        const postings = [];
        for (let offset = 0; offset < 5000; offset += 100) {
          const data = await callOzonSellerAPI("/v3/posting/fbs/list", {
            dir: "DESC",
            filter: { since, to, ...(status && status !== "all" ? { status } : {}) },
            limit: 100,
            offset,
            with: { financial_data: true },
          }, { storeId: store.id, userId });
          const page = data?.result?.postings || [];
          postings.push(...page);
          if (page.length < 100 || data?.result?.has_next === false) break;
        }
        return postings;
      } catch (e) {
        console.warn(`[dashboard] store=${store.name} orders fetch fail:`, e.message);
        return [];
      }
    };

    // 3. 金额计算 (v0.3.5c 币种感知 + v0.5.0 真实利润)
    // GMV = Σ(pd.price × qty)  按币种转 CNY
    // Payout = Σ(fd.payout × qty)  卖家到手 (已扣佣金/物流)
    // Profit = Payout_CNY - Purchase_Price_CNY (从 app_products 查)
    //         若 purchase_price_cny 为空, 不猜测利润，并明确返回待补成本数量。
    const calcOrderMetrics = (posting) => {
      let gmvCny = 0;
      let payoutCny = 0;
      const offerIds = [];
      for (const pd of (posting.products || [])) {
        const fd = (posting.financial_data?.products || []).find(x => String(x.product_id) === String(pd.sku)) || {};
        // v0.3.5c: 优先 pd.currency_code (卖家结算币), fd.currency_code 是平台核算币
        const currency = String(pd.currency_code || fd.currency_code || "RUB").toUpperCase();
        const priceNative = Number(pd.price || fd.price || 0);
        const payoutNative = Number(fd.payout || 0);
        const platformPrice = Number(fd.price || fd.customer_price || 0);
        const qty = Number(pd.quantity || fd.quantity || 1);
        const priceCny = currency === "CNY" ? priceNative
                       : currency === "RUB" ? convertRub(priceNative)
                       : priceNative;
        // 跨境店铺 pd.price 是 CNY，而 financial_data 往往仍是 RUB。
        // 用同一商品的两套价格推导订单内结算比例，不能把 RUB payout 当 CNY。
        const settlementRate = currency === "CNY" && platformPrice > 0 ? priceNative / platformPrice : null;
        const payoutPerItemCny = currency === "CNY" ? (settlementRate ? payoutNative * settlementRate : priceNative)
                               : currency === "RUB" ? convertRub(payoutNative)
                               : payoutNative;
        gmvCny += priceCny * qty;
        payoutCny += payoutPerItemCny * qty;   // payout 是单品到手, 需 ×qty
        if (pd.offer_id) offerIds.push(pd.offer_id);
      }
      return {
        gmv: Math.round(gmvCny * 100) / 100,
        payout: Math.round(payoutCny * 100) / 100,
        offerIds,
      };
    };

    // 查本地 app_products 的 purchase_price_cny (采购成本)
    const fetchPurchasePrices = async (offerIds, storeId) => {
      if (!offerIds.length) return new Map();
      const r = await db.query(
        `SELECT offer_id, purchase_price_cny FROM app_products WHERE user_id = $1 AND store_id = $2 AND offer_id = ANY($3::text[])`,
        [userId, storeId, offerIds],
      );
      return new Map(r.rows.map(x => [x.offer_id, Number(x.purchase_price_cny) || 0]));
    };

    // 4. 并行拉每个店铺的数据 (v0.5.1: 加昨日对比 + 争议单)
    // v2.2.9.100: 合并为 1 次 7 天全量查询，内存分桶/过滤 today/yesterday/各状态（原来 7 次 Ozon API → 1 次）
    const storeData = await Promise.all(stores.map(async (store) => {
      const weekOrders = await fetchStoreOrders(store, weekAgoISO, nowISO, "all");
      const postingTime = (o) => new Date(o.in_process_at || o.created_at || 0).getTime();
      const todayOrders = weekOrders.filter(o => postingTime(o) >= todayStart.getTime() && postingTime(o) <= now.getTime() + 1000);
      const yesterdayOrders = weekOrders.filter(o => postingTime(o) >= yesterdayStart.getTime() && postingTime(o) < todayStart.getTime());
      const awaitingPkg = weekOrders.filter(o => String(o.status || "") === "awaiting_packaging");
      const awaitingDel = weekOrders.filter(o => String(o.status || "") === "awaiting_deliver");
      const returns = weekOrders.filter(o => String(o.status || "") === "cancelled");
      const arbitration = weekOrders.filter(o => String(o.status || "") === "arbitration");

      // 今日 GMV + Payout
      let todayGmv = 0, todayPayout = 0;
      const todayOfferIds = new Set();
      for (const o of todayOrders) {
        const m = calcOrderMetrics(o);
        todayGmv += m.gmv;
        todayPayout += m.payout;
        m.offerIds.forEach(id => todayOfferIds.add(id));
      }

      // 昨日 GMV (对比基数)
      let yesterdayGmv = 0;
      for (const o of yesterdayOrders) {
        yesterdayGmv += calcOrderMetrics(o).gmv;
      }

      // 本周 GMV + Payout + 采购成本
      let weeklyGmv = 0, weeklyPayout = 0;
      const weekOfferIds = new Set();
      // 按天分桶 (精确趋势, 准备 30 天, weekOrders 只填前 7 天)
      const dailyBuckets = {};
      for (let i = 0; i < 30; i++) {
        const d = new Date(now.getTime() - i * 86400e3);
        const key = `${d.getMonth() + 1}/${d.getDate()}`;
        dailyBuckets[key] = { orders: 0, gmv: 0 };
      }
      for (const o of weekOrders) {
        const m = calcOrderMetrics(o);
        weeklyGmv += m.gmv;
        weeklyPayout += m.payout;
        m.offerIds.forEach(id => weekOfferIds.add(id));
        // 按天分桶
        const od = new Date(o.in_process_at || o.created_at || 0);
        const key = `${od.getMonth() + 1}/${od.getDate()}`;
        if (dailyBuckets[key]) {
          dailyBuckets[key].orders++;
          dailyBuckets[key].gmv += m.gmv;
        }
      }

      // 查采购价 → 计算真实利润
      const priceMap = await fetchPurchasePrices(Array.from(weekOfferIds), store.id);
      let weeklyPurchaseCost = 0;
      let weeklyMatchedPayout = 0;
      let matchedCount = 0;
      let unmatchedCount = 0;
      for (const o of weekOrders) {
        for (const pd of (o.products || [])) {
          const oid = pd.offer_id;
          if (!oid) continue;
          const qty = Number(pd.quantity || 1);
          const purchasePrice = priceMap.get(oid);
          if (purchasePrice && purchasePrice > 0) {
            weeklyPurchaseCost += purchasePrice * qty;
            const fd = (o.financial_data?.products || []).find(x => String(x.product_id) === String(pd.sku)) || {};
            const currency = String(pd.currency_code || fd.currency_code || "RUB").toUpperCase();
            const payoutNative = Number(fd.payout || 0);
            const platformPrice = Number(fd.price || fd.customer_price || 0);
            const settlementPrice = Number(pd.price || 0);
            const settlementRate = currency === "CNY" && platformPrice > 0 ? settlementPrice / platformPrice : null;
            weeklyMatchedPayout += (currency === "CNY" ? (settlementRate ? payoutNative * settlementRate : settlementPrice) : convertRub(payoutNative)) * qty;
            matchedCount++;
          } else {
            unmatchedCount++;
          }
        }
      }

      // 只核算采购成本完整的商品，缺失成本的商品不再用固定比例猜测利润。
      const weeklyProfit = weeklyMatchedPayout - weeklyPurchaseCost;
      const profitMethod = matchedCount
        ? `已核算 ${matchedCount} 行：到手 ¥${weeklyMatchedPayout.toFixed(2)} - 采购 ¥${weeklyPurchaseCost.toFixed(2)}；${unmatchedCount} 行待补成本`
        : `${unmatchedCount} 行待补采购成本，尚无可核算利润`;

      const todayReturns = returns.filter(o => {
        const d = new Date(o.in_process_at || o.created_at || 0);
        return d >= todayStart;
      }).length;

      // 本地商品统计 (v0.5.2: 加 max(updated_at) 判同步状态)
      const prodRes = await db.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'VISIBLE') as active_products,
           COUNT(*) FILTER (WHERE stock < 5 AND status != 'IN_ACTIVE') as stock_warning,
           COUNT(*) as total_products,
           MAX(updated_at) as last_sync
         FROM app_products WHERE user_id = $1 AND store_id = $2`,
        [userId, store.id]
      );
      const pr = prodRes.rows[0] || {};
      let activeProducts = parseInt(pr.active_products || 0);
      try {
        const liveProductCounts = await fetchOzonProductStatusCounts(store.id, userId);
        if (Number.isFinite(Number(liveProductCounts.VISIBLE))) {
          activeProducts = Number(liveProductCounts.VISIBLE);
        }
      } catch (error) {
        console.warn(`[dashboard] store=${store.name} active product count fallback to local cache: ${error.message}`);
      }
      const warningRes = await db.query(
        `SELECT offer_id, name, image, stock
           FROM app_products
          WHERE user_id = $1 AND store_id = $2 AND stock < 10 AND status != 'IN_ACTIVE'
          ORDER BY stock ASC, updated_at DESC
          LIMIT 20`,
        [userId, store.id],
      );

      const recentOrders = weekOrders.slice(0, 15).map(order => {
        const metrics = calcOrderMetrics(order);
        const product = order.products?.[0] || {};
        return {
          store_name: store.name,
          posting_number: order.posting_number || '',
          status: order.status || '',
          amount_cny: metrics.gmv,
          product_name: product.name || product.offer_id || '',
          image: product.image || product.primary_image || '',
          created_at: order.in_process_at || order.created_at || null,
        };
      });

      // v0.5.2 同步判定: last_sync > 24h 前 → "需同步", 否则 "已同步"
      const lastSync = pr.last_sync ? new Date(pr.last_sync) : null;
      const syncStatus = (!lastSync || (now.getTime() - lastSync.getTime()) > 86400e3)
        ? "需同步"
        : "已同步";

      // v0.5.2 退货率: 7 日内 (arbitration + cancelled) / 总单量 × 100
      const returnCount = arbitration.length + returns.length;
      const returnRate = weekOrders.length > 0
        ? Math.round((returnCount / weekOrders.length) * 10000) / 100
        : 0;

      // v0.5.2 待处理汇总
      const awaitingTreatment = awaitingPkg.length + awaitingDel.length;

      // v0.5.1 增长率 (今日 vs 昨日, 保留 2 位小数)
      const gmvGrowth = yesterdayGmv > 0
        ? Math.round(((todayGmv - yesterdayGmv) / yesterdayGmv) * 10000) / 100
        : (todayGmv > 0 ? 100 : 0);
      const orderGrowth = yesterdayOrders.length > 0
        ? Math.round(((todayOrders.length - yesterdayOrders.length) / yesterdayOrders.length) * 10000) / 100
        : (todayOrders.length > 0 ? 100 : 0);

      console.log(`[dashboard] store=${store.name} today=¥${todayGmv.toFixed(2)}/ yesterday=¥${yesterdayGmv.toFixed(2)} gmv_growth=${gmvGrowth}% | awaiting_treatment=${awaitingTreatment} | return_rate=${returnRate}% | sync=${syncStatus} | active=${activeProducts} | profit=¥${weeklyProfit.toFixed(2)} [${profitMethod}]`);

      return {
        store_id: store.id,
        store_name: store.name,
        // 7 大核心指标 (对齐 MyERP)
        active_products: activeProducts,
        today_orders: todayOrders.length,
        awaiting_treatment: awaitingTreatment,       // 待打包 + 待发货
        today_gmv: Math.round(todayGmv * 100) / 100,
        weekly_gmv: Math.round(weeklyGmv * 100) / 100,
        return_rate: returnRate,                      // 7 日退货率 %
        sync_status: syncStatus,                      // 同步判定
        // 扩展指标
        yesterday_orders: yesterdayOrders.length,
        yesterday_gmv: Math.round(yesterdayGmv * 100) / 100,
        gmv_growth: gmvGrowth,
        order_growth: orderGrowth,
        awaiting_packaging: awaitingPkg.length,
        awaiting_deliver: awaitingDel.length,
        today_returns: todayReturns,
        arbitration: arbitration.length,
        _returns7d: returnCount,                      // 7 日 (cancelled + arbitration), 仅用于汇总 return_rate
        weekly_payout: Math.round(weeklyPayout * 100) / 100,
        weekly_profit: Math.round(weeklyProfit * 100) / 100,
        weekly_orders: weekOrders.length,
        weekly_purchase_cost: Math.round(weeklyPurchaseCost * 100) / 100,
        profit_complete: unmatchedCount === 0,
        cost_missing_count: unmatchedCount,
        profit_method: profitMethod,
        stock_warning: parseInt(pr.stock_warning || 0),
        total_products: parseInt(pr.total_products || 0),
        last_sync: pr.last_sync || null,
        _dailyBuckets: dailyBuckets,
        _recentOrders: recentOrders,
        _stockWarnings: warningRes.rows,
      };
    }));

    // 5. 汇总
    const totalTodayGmv = storeData.reduce((s, x) => s + x.today_gmv, 0);
    const totalYesterdayGmv = storeData.reduce((s, x) => s + x.yesterday_gmv, 0);
    const totalTodayOrders = storeData.reduce((s, x) => s + x.today_orders, 0);
    const totalYesterdayOrders = storeData.reduce((s, x) => s + x.yesterday_orders, 0);
    const summary = {
      today_orders: totalTodayOrders,
      today_gmv: Math.round(totalTodayGmv * 100) / 100,
      yesterday_orders: totalYesterdayOrders,
      yesterday_gmv: Math.round(totalYesterdayGmv * 100) / 100,
      gmv_growth: totalYesterdayGmv > 0
        ? Math.round(((totalTodayGmv - totalYesterdayGmv) / totalYesterdayGmv) * 10000) / 100
        : (totalTodayGmv > 0 ? 100 : 0),
      order_growth: totalYesterdayOrders > 0
        ? Math.round(((totalTodayOrders - totalYesterdayOrders) / totalYesterdayOrders) * 10000) / 100
        : (totalTodayOrders > 0 ? 100 : 0),
      awaiting_packaging: storeData.reduce((s, x) => s + x.awaiting_packaging, 0),
      awaiting_deliver: storeData.reduce((s, x) => s + x.awaiting_deliver, 0),
      awaiting_treatment: storeData.reduce((s, x) => s + x.awaiting_treatment, 0),
      active_products: storeData.reduce((s, x) => s + x.active_products, 0),
      stock_warning: storeData.reduce((s, x) => s + x.stock_warning, 0),
      today_returns: storeData.reduce((s, x) => s + x.today_returns, 0),
      arbitration: storeData.reduce((s, x) => s + x.arbitration, 0),      // v0.5.1 真实争议单
      weekly_orders: storeData.reduce((s, x) => s + x.weekly_orders, 0),
      weekly_gmv: Math.round(storeData.reduce((s, x) => s + x.weekly_gmv, 0) * 100) / 100,
      weekly_payout: Math.round(storeData.reduce((s, x) => s + x.weekly_payout, 0) * 100) / 100,
      weekly_profit: Math.round(storeData.reduce((s, x) => s + x.weekly_profit, 0) * 100) / 100,
      profit_complete: storeData.every((item) => item.profit_complete),
      cost_missing_count: storeData.reduce((sum, item) => sum + item.cost_missing_count, 0),
      return_rate: (() => {
        const totalReturns = storeData.reduce((s, x) => s + (x._returns7d || 0), 0);
        const totalWeek = storeData.reduce((s, x) => s + x.weekly_orders, 0);
        return totalWeek > 0 ? Math.round((totalReturns / totalWeek) * 10000) / 100 : 0;
      })(),
    };

    // 6. 趋势 (v0.5.0 精确按天聚合, 不再用日均估算). range=7 / range=30
    const trends = [];
    for (let i = range - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400e3);
      const dayLabel = `${d.getMonth() + 1}/${d.getDate()}`;
      let dayOrders = 0;
      let dayGmv = 0;
      for (const sd of storeData) {
        const bucket = sd._dailyBuckets[dayLabel];
        if (bucket) {
          dayOrders += bucket.orders;
          dayGmv += bucket.gmv;
        }
      }
      trends.push({
        date: dayLabel,
        orders: dayOrders,
        gmv: Math.round(dayGmv * 100) / 100,
      });
    }

    // 7. 最近任务 (保留原有 jobs)
    const jobsRes = await db.query(
      `SELECT kind, status, processed, total, updated_at as "updatedAt"
       FROM app_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [userId]
    );

    console.log(`[dashboard] summary: orders=${summary.today_orders} gmv=¥${summary.today_gmv} profit=¥${summary.weekly_profit} warn=${summary.stock_warning}`);

    // 清理内部字段 (_dailyBuckets 不返回给前端)
    const recentOrders = storeData.flatMap(item => item._recentOrders || [])
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
      .slice(0, 15);
    const stockWarnings = storeData.flatMap(item => (item._stockWarnings || []).map(row => ({
      ...row,
      store_name: item.store_name,
    }))).slice(0, 20);
    const cleanStoreComparison = storeData.map(({ _dailyBuckets, _recentOrders, _stockWarnings, ...rest }) => rest);

    const dashboardPayload = {
      success: true,
      summary,
      store_comparison: cleanStoreComparison,
      trends,
      recentJobs: jobsRes.rows,
      recent_orders: recentOrders,
      stock_warnings: stockWarnings,
      generated_at: nowISO,
    };
    // v2.2.9.100: 写入结果缓存；Map 超限时清理最旧一半，防止长期运行内存膨胀
    if (dashboardCache.size > 500) {
      const oldestKeys = [...dashboardCache.entries()]
        .sort((a, b) => a[1].at - b[1].at)
        .slice(0, Math.floor(dashboardCache.size / 2))
        .map(([k]) => k);
      for (const k of oldestKeys) dashboardCache.delete(k);
    }
    dashboardCache.set(cacheKey, { at: Date.now(), data: dashboardPayload });
    res.json(dashboardPayload);
  } catch (error) {
    console.error("[dashboard] 统计失败:", error);
    next(error);
  }
});

// Ozon /v3/product/list 支持的 visibility 值（对应前端 7 个 Tab）
// 参考：https://docs.ozon.ru/api/seller/#operation/ProductAPI_GetProductList
const OZON_VISIBILITY_ENUM = new Set([
  "ALL",              // 全部
  "VISIBLE",          // 销售中（在售）
  "READY_TO_SUPPLY",  // 准备出售
  "NEED_ATTENTION",   // 需处理（错误 + 待修改）
  "NOT_MODERATED",    // 待审核
  "MODERATED",        // 已审核
  "IN_ACTIVE",        // 已下架
  "ARCHIVED",         // 归档
  "STATE_FAILED",     // 错误
  "IN_SALE",
  "TO_SUPPLY",
  "PARTIAL_APPROVED",
  "REMOVED_FROM_SALE",
  "VALIDATION_STATE_FAIL",
  "VALIDATION_STATE_PENDING",
  "STATE_FAILED_MODERATION",  // 审核失败
  "FAILED_MODERATION",
  "IS_TOO_MANY_IMAGES",
]);

const PRODUCT_STATUS_COUNT_FILTERS = {
  ALL: ["ALL"],
  VISIBLE: ["IN_SALE"],
  READY_TO_SUPPLY: ["TO_SUPPLY"],
  NEED_ATTENTION: ["PARTIAL_APPROVED"],
  NOT_MODERATED: ["VALIDATION_STATE_PENDING", "NOT_MODERATED"],
  FAILED_MODERATION: ["STATE_FAILED", "VALIDATION_STATE_FAIL", "FAILED_MODERATION", "STATE_FAILED_MODERATION"],
  IN_ACTIVE: ["REMOVED_FROM_SALE"],
  ARCHIVED: ["ARCHIVED"],
};

function extractOzonProductListTotal(payload) {
  const candidates = [
    payload?.result?.total,
    payload?.total,
    payload?.result?.count,
    payload?.count,
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function fetchOzonProductStatusCounts(storeId, userId) {
  const counts = {};
  for (const [status, filters] of Object.entries(PRODUCT_STATUS_COUNT_FILTERS)) {
    let value = null;
    for (const filter of filters) {
      try {
        const payload = await callOzonSellerAPI("/v3/product/list", {
          filter: { visibility: filter },
          last_id: "",
          limit: 1,
        }, { storeId, userId });
        const total = extractOzonProductListTotal(payload);
        if (total !== null) {
          value = total;
          if (total > 0 || filter === filters[filters.length - 1]) break;
        }
      } catch (error) {
        // Some Ozon visibility names differ by account/API generation; try the next alias.
        if (filter === filters[filters.length - 1]) {
          console.warn(`[products] Ozon ${status} count unavailable via ${filter}: ${error.message}`);
        }
      }
    }
    if (value !== null) counts[status] = value;
  }
  return counts;
}

async function fetchOzonProductListPage(storeId, userId, status, limit, offset) {
  const filters = PRODUCT_STATUS_COUNT_FILTERS[status] || [status];
  const requested = Math.min(1000, Math.max(1, Number(limit || 50) + Number(offset || 0)));
  for (const visibility of filters) {
    try {
      const offerIds = [];
      let total = 0;
      let lastId = "";
      while (offerIds.length < requested) {
        const payload = await callOzonSellerAPI("/v3/product/list", {
          filter: { visibility },
          last_id: lastId,
          limit: Math.min(100, requested - offerIds.length),
        }, { storeId, userId });
        total = extractOzonProductListTotal(payload) ?? total;
        const items = payload?.result?.items || payload?.items || [];
        offerIds.push(...items.map((item) => String(item.offer_id || "").trim()).filter(Boolean));
        lastId = payload?.result?.last_id || payload?.last_id || "";
        if (!lastId || items.length === 0) break;
      }
      return {
        visibility,
        total,
        offerIds: offerIds.slice(Number(offset || 0), Number(offset || 0) + Number(limit || 50)),
      };
    } catch (error) {
      if (visibility === filters[filters.length - 1]) throw error;
    }
  }
  return { visibility: status, total: 0, offerIds: [] };
}

app.post("/api/seller/products", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const userId = req.user.id;
    const storeId = req.body?.store_id || req.body?.storeId;
    const visibility = String(req.body?.visibility || "ALL").toUpperCase();
    const limit = Math.min(200, Math.max(1, Number(req.body?.limit || 50)));
    const offset = Math.max(0, Number(req.body?.offset || 0));
    const search = String(req.body?.search || "").trim();

    if (!storeId) return res.status(400).json({ success: false, error: "未选择店铺" });
    if (!OZON_VISIBILITY_ENUM.has(visibility)) {
      return res.status(400).json({ success: false, error: "不支持的商品状态" });
    }

    let livePage = null;
    if (!search) {
      try {
        livePage = await fetchOzonProductListPage(storeId, userId, visibility, limit, offset);
      } catch (error) {
        console.warn(`[products] Ozon ${visibility} page fallback to local cache: ${error.message}`);
      }
    }

    // 1. 构建过滤条件
    const where = ["user_id = $1 AND store_id = $2"];
    const params = [userId, storeId];

    if (livePage) {
      params.push(livePage.offerIds);
      where.push(`offer_id = ANY($${params.length}::text[])`);
    } else if (visibility !== "ALL") {
      params.push(visibility);
      where.push(`status = $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      where.push(`(name ILIKE $${params.length} OR offer_id ILIKE $${params.length} OR sku::text ILIKE $${params.length})`);
    }

    // 2. 分页查询记录 (全字段回传给前端抽屉编辑) - v0.3.3 加 stocks_json 分仓原始数据
    const rows = await db.query(
      `SELECT id, store_id, offer_id, name, image, images, price, min_price, old_price, currency_code, vat, stock,
              brand, country_of_origin, description,
              status, status_name, category_name, description_category_id, type_id, price_index,
              product_id, sku, model_id, barcode,
              weight, depth, width, height, dimension_unit, weight_unit,
              stocks_json, purchase_price_cny, source_url_1688,
              updated_at, updated_at_ozon
       FROM app_products
       WHERE ${where.join(" AND ")}
       ORDER BY ${livePage ? `array_position($${params.length}::text[], offer_id), updated_at DESC` : "updated_at DESC"}
       ${livePage ? "" : `LIMIT $${params.length + 1} OFFSET $${params.length + 2}`}`,
      livePage ? params : [...params, limit, offset]
    );

    // 3. 查询总数
    const countRes = livePage
      ? { rows: [{ count: livePage.total }] }
      : await db.query(
        `SELECT count(*) FROM app_products WHERE ${where.join(" AND ")}`,
        params
      );

    const statusCountRes = await db.query(
      `SELECT status, count(*)::int AS count
       FROM app_products
       WHERE user_id = $1 AND store_id = $2
       GROUP BY status`,
      [userId, storeId]
    );
    const status_counts = { ALL: 0 };
    for (const row of statusCountRes.rows) {
      status_counts[row.status || "UNKNOWN"] = Number(row.count || 0);
      status_counts.ALL += Number(row.count || 0);
    }

    let responseTotal = parseInt(countRes.rows[0].count);
    let countsSource = "local";
    if (!search) {
      try {
        const ozonCounts = await fetchOzonProductStatusCounts(storeId, userId);
        if (Object.keys(ozonCounts).length) {
          Object.assign(status_counts, ozonCounts);
          countsSource = "ozon";
          if (Number.isFinite(Number(ozonCounts[visibility]))) {
            responseTotal = Number(ozonCounts[visibility]);
          }
        }
      } catch (error) {
        console.warn(`[products] Ozon status counts fallback to local cache: ${error.message}`);
      }
    }

    const items = rows.rows.map((row) => {
      const issues = [];
      if (!(Number(row.weight) > 0)) issues.push("缺少重量");
      if (!(Number(row.width) > 0 && Number(row.depth) > 0 && Number(row.height) > 0)) issues.push("缺少尺寸");
      if ((Number(row.width) + Number(row.depth) + Number(row.height)) >= 2000) issues.push("尺寸三边和超过 2000mm");
      const titleLength = String(row.name || "").trim().length;
      if (titleLength < 20 || titleLength > 500) issues.push("标题长度应为 20-500 字符");
      if (!row.image) issues.push("缺少主图");
      if (!row.brand) issues.push("缺少品牌");
      if (!row.description) issues.push("缺少描述");
      return enrichProductReadModel({ ...row, compliance_issues: issues, compliance_ok: issues.length === 0 });
    });

    res.json({
      success: true,
      total: responseTotal,
      items,
      status_counts,
      status_counts_source: countsSource,
      data: {
        result: {
          items,
          total: responseTotal
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/seller/products/export", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const userId = req.user.id;
    const storeId = String(req.body?.store_id || req.body?.storeId || "").trim();
    const visibility = String(req.body?.visibility || "ALL").toUpperCase();
    const search = String(req.body?.search || "").trim();
    if (!storeId) return res.status(400).json({ success: false, error: "未选择店铺" });
    if (!OZON_VISIBILITY_ENUM.has(visibility)) {
      return res.status(400).json({ success: false, error: "不支持的商品状态" });
    }

    const where = ["user_id = $1", "store_id = $2"];
    const params = [userId, storeId];
    if (visibility !== "ALL") {
      params.push(visibility);
      where.push(`status = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(name ILIKE $${params.length} OR offer_id ILIKE $${params.length} OR sku::text ILIKE $${params.length})`);
    }

    const result = await db.query(
      `SELECT offer_id, sku, name, status, status_name, price, currency_code, stock,
              brand, country_of_origin, weight, width, depth, height,
              purchase_price_cny, source_url_1688, description, image, updated_at
       FROM app_products
       WHERE ${where.join(" AND ")}
       ORDER BY updated_at DESC
       LIMIT 10000`,
      params,
    );
    const csvCell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const headers = [
      "货号", "Ozon SKU", "标题", "业务状态", "Ozon 状态", "售价", "币种", "库存",
      "品牌", "原产国", "重量(g)", "宽度(mm)", "深度(mm)", "高度(mm)",
      "采购价(CNY)", "1688采购链接", "主图", "合规问题", "最后同步",
    ];
    const rows = result.rows.map((row) => {
      const issues = [];
      if (!(Number(row.weight) > 0)) issues.push("缺少重量");
      if (!(Number(row.width) > 0 && Number(row.depth) > 0 && Number(row.height) > 0)) issues.push("缺少尺寸");
      if ((Number(row.width) + Number(row.depth) + Number(row.height)) >= 2000) issues.push("尺寸三边和超过 2000mm");
      const titleLength = String(row.name || "").trim().length;
      if (titleLength < 20 || titleLength > 500) issues.push("标题长度应为 20-500 字符");
      if (!row.image) issues.push("缺少主图");
      if (!row.brand) issues.push("缺少品牌");
      if (!row.description) issues.push("缺少描述");
      return [
        row.offer_id, row.sku, row.name, row.status, row.status_name, row.price,
        row.currency_code || "RUB", row.stock, row.brand, row.country_of_origin,
        row.weight, row.width, row.depth, row.height, row.purchase_price_cny,
        row.source_url_1688, row.image, issues.join("；"), row.updated_at?.toISOString?.() || row.updated_at,
      ];
    });
    const content = `\ufeff${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="ozon-products-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(content);
  } catch (error) {
    next(error);
  }
});

/**
 * v0.3.4 AI 智能核价 - 参考历史价格 + 同类目均价给建议
 */
app.post("/api/ai/pricing", requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const storeId = req.body?.store_id || req.body?.storeId;
    const { offer_id, name, weight } = req.body || {};
    if (!storeId || !offer_id) return res.status(400).json({ success: false, error: "缺少 store_id / offer_id" });

    // 简易策略: 同店铺同类目均价 + 重量系数 (业务可迭代)
    const r = await db.query(
      `SELECT AVG(price) as avg_price, MIN(price) as min_price, COUNT(*) as n
       FROM app_products WHERE user_id = $1 AND store_id = $2 AND price > 0`,
      [req.user.id, storeId],
    );
    const avg = Number(r.rows?.[0]?.avg_price || 0);
    const min = Number(r.rows?.[0]?.min_price || 0);
    const w = Number(weight || 0);
    const suggested = Math.round((avg * (1 + (w / 5000))) * 100) / 100;
    const floor = Math.round((min * 0.95) * 100) / 100;

    res.json({
      success: true,
      data: {
        suggested_price: suggested || 100,
        min_price: floor || 50,
        rationale: `店铺 ${r.rows[0].n} 个 SKU 均价 ${avg.toFixed(2)}, 结合重量 ${w}g 得建议价 ${suggested}`,
      },
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/**
 * v0.3.7 商品分析 - MiniMax M3 多模态真实分析 (DashScope 已下线)
 * 支持:
 *   - 无标题只传图片: 从图片反推商品品类/标题/卖点
 *   - 有标题 + 有图: 图文联合分析, 卖点更准
 *   - 有标题无图: 纯文本分析
 * 输入: { title?, images?: [url], target_market?: 'ozon' | 'etsy', store_id? }
 * 输出: { title_zh, title_ru, product_type, selling_points[], image_prompt, model }
 * 严禁: 任何 Mock 数据兜底
 */
/**
 * v0.6.2 获取 collect_items 列表 (供 BatchUpload 消费)
 */
app.get("/api/collect-items", requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const userId = req.user.id;
    const status = String(req.query?.status || "all").trim();
    const search = String(req.query?.search || "").trim();
    const storeId = String(req.query?.store_id || "").split(",")[0].trim();
    const allowedStatuses = new Set(["all", "pending", "scraped", "uploaded", "failed", "ignored"]);
    if (!allowedStatuses.has(status)) return res.status(400).json({ success: false, error: "无效采集状态" });
    if (storeId && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(storeId)) return res.status(400).json({ success: false, error: "无效店铺 ID" });
    const limit = Math.min(200, Math.max(1, Number(req.query?.limit || 50)));
    const offset = Math.max(0, Number(req.query?.offset || 0));
    const args = [userId];
    const where = ["user_id = $1"];
    if (status && status !== "all") { args.push(status); where.push(`status = $${args.length}`); }
    else where.push(`status <> 'ignored'`);
    if (storeId) { args.push(storeId); where.push(`store_id = $${args.length}`); }
    if (search) {
      args.push(`%${search}%`);
      where.push(`(ozon_url ILIKE $${args.length} OR ozon_sku ILIKE $${args.length} OR title ILIKE $${args.length})`);
    }
    const countResult = await db.query(`SELECT count(*)::int AS count FROM collect_items WHERE ${where.join(" AND ")}`, args);
    const statusCountArgs = [userId];
    let statusCountWhere = "user_id = $1";
    if (storeId) { statusCountArgs.push(storeId); statusCountWhere += " AND store_id = $2"; }
    const statusResult = await db.query(
      `SELECT status, count(*)::int AS count FROM collect_items WHERE ${statusCountWhere} GROUP BY status`,
      statusCountArgs,
    );
    const statusCounts = { all: 0 };
    for (const row of statusResult.rows) {
      statusCounts[row.status] = Number(row.count || 0);
      if (row.status !== "ignored") statusCounts.all += Number(row.count || 0);
    }
    const result = await db.query(
      `SELECT * FROM collect_items WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, limit, offset],
    );
    res.json({
      success: true,
      items: result.rows,
      total: Number(countResult.rows[0]?.count || 0),
      status_counts: statusCounts,
      limit,
      offset,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * v0.6.1 批量采集竞品商品 - 用于跟卖
 * 输入: { store_id, ids: ["offer_id" 或 "sku数字" 混合] }
 * 逻辑: 先从本地 app_products 查 (offer_id 或 sku 匹配), 未命中则调 Ozon /v3/product/info/list 用 sku 查
 * 输出: { success: true, items: [{offer_id, sku, name, image, images, price, ...}] }
 */
app.post("/api/seller/products/collect-competitor", requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const storeId = req.body?.store_id || req.body?.storeId;
    if (!storeId) return res.status(400).json({ success: false, error: "未选择店铺" });
    const userId = req.user.id;
    let ids = req.body?.ids || [];
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ success: false, error: "ids 为空" });
    ids = ids.map(String).filter(Boolean).slice(0, 500);

    // 分离: 字符串 offer_id vs 纯数字 sku
    const offerIds = ids.filter(x => /\D/.test(x));
    const skus = ids.filter(x => /^\d+$/.test(x)).map(Number);

    const items = [];

    // 1. 本地查 offer_id
    if (offerIds.length) {
      const r = await db.query(
        `SELECT offer_id, product_id, sku, name, image, images, price, currency_code, brand,
                weight, depth, width, height, category_name, description_category_id, type_id, country_of_origin, description, vat
         FROM app_products WHERE user_id = $1 AND store_id = $2 AND offer_id = ANY($3::text[])`,
        [userId, storeId, offerIds],
      );
      items.push(...r.rows);
    }

    // 2. 本地查 sku (数字)
    if (skus.length) {
      const r = await db.query(
        `SELECT offer_id, product_id, sku, name, image, images, price, currency_code, brand,
                weight, depth, width, height, category_name, description_category_id, type_id, country_of_origin, description, vat
         FROM app_products WHERE user_id = $1 AND store_id = $2 AND sku = ANY($3::bigint[])`,
        [userId, storeId, skus],
      );
      items.push(...r.rows);
    }

    // 3. 未命中的 sku 调 Ozon API 查 (竞品采集)
    const localSkus = new Set(items.map(x => String(x.sku)).filter(Boolean));
    const remoteSkus = skus.filter(s => !localSkus.has(String(s)));
    if (remoteSkus.length) {
      try {
        const ozonData = await callOzonSellerAPI("/v3/product/info/list", { sku: remoteSkus }, { storeId, userId });
        for (const info of (ozonData?.items || [])) {
          items.push({
            offer_id: info.offer_id || `SKU-${info.sku}`,
            sku: info.sku,
            product_id: info.id,
            name: info.name || "",
            image: Array.isArray(info.primary_image) ? (info.primary_image[0] || "") : (info.primary_image || ""),
            images: Array.isArray(info.images) ? info.images : [],
            price: Number(info.price || 0),
            currency_code: info.currency_code || "RUB",
            brand: "", weight: 0, depth: 0, width: 0, height: 0,
            category_name: "", description_category_id: info.description_category_id || null,
            type_id: info.type_id || null, country_of_origin: "", description: info.description || "",
            vat: info.vat || "0",
            source: "ozon_competitor",
          });
        }
      } catch (e) {
        console.warn("[collect-competitor] Ozon API 查询失败:", e.message);
      }
    }

    // 规范化 images 字段
    for (const it of items) {
      if (!Array.isArray(it.images)) {
        try { it.images = it.images ? JSON.parse(it.images) : []; } catch { it.images = []; }
      }
      if (!it.image && it.images?.length) it.image = it.images[0];
    }

    console.log(`[collect-competitor] 请求 ${ids.length} ID, 匹配 ${items.length} 商品 (本地+Ozon API)`);
    res.json({ success: true, items, matched: items.length, requested: ids.length });
  } catch (e) {
    console.error("[collect-competitor]", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * v0.6.1 图片物理加水印 - 使用 jimp 纯 JS 库
 * 输入: { images: [url], text: "逐梦ERP" }
 * 输出: { success: true, images: [local_url] }
 */
app.post("/api/images/watermark", requireAuth, async (req, res) => {
  try {
    const images = normalizeImportImageList(Array.isArray(req.body?.images) ? req.body.images.filter(Boolean) : []);
    const text = String(req.body?.text || "逐梦ERP");
    if (!images.length) return res.status(400).json({ success: false, error: "images 为空" });

    let Jimp;
    try {
      const mod = await import("jimp");
      Jimp = mod.default || mod;
    } catch {
      return res.status(503).json({ success: false, error: "jimp 未安装, 请 npm install jimp" });
    }

    const uploadDir = await ensureUploadDir();
    const publicBaseUrl = getRequestPublicBaseUrl(req);

    const watermarkedUrls = [];
    for (const url of images) {
      try {
        let image;
        if (/^https?:\/\//.test(url)) {
          const resp = await fetch(url);
          const buf = Buffer.from(await resp.arrayBuffer());
          image = await Jimp.read(buf);
        } else if (url.startsWith("/uploads/")) {
          image = await Jimp.read(path.join(PUBLIC_DIR, url.replace(/^\//, "")));
        } else if (url.startsWith("data:image/")) {
          image = await Jimp.read(Buffer.from(url.split(",")[1], "base64"));
        } else {
          watermarkedUrls.push(url); continue;
        }

        // 加水印文字 (右下角, 提高可见度)
        const font = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
        const textW = Jimp.measureText(font, text);
        const textH = Jimp.measureTextHeight(font, text);
        const x = image.bitmap.width - textW - 20;
        const y = image.bitmap.height - textH - 20;
        const bgX = Math.max(0, x - 12);
        const bgY = Math.max(0, y - 8);
        const bgW = Math.min(image.bitmap.width - bgX, textW + 24);
        const bgH = Math.min(image.bitmap.height - bgY, textH + 16);
        const overlay = new Jimp(bgW, bgH, 0x00000099);
        image.composite(overlay, bgX, bgY);
        image.print(font, Math.max(0, x + 2), Math.max(0, y + 2), text);
        image.print(font, x, y, text);

        const hashName = crypto.randomBytes(16).toString("hex") + ".jpg";
        const localPath = path.join(uploadDir, hashName);
        await image.quality(85).writeAsync(localPath);
        const publicUrl = `${publicBaseUrl}/uploads/${hashName}`;
        watermarkedUrls.push(publicUrl);
        console.log(`[watermark] ✓ ${url.slice(0, 50)}... → ${publicUrl}`);
      } catch (e) {
        console.warn("[watermark] 单图失败:", e.message);
        watermarkedUrls.push(url);
      }
    }

    res.json({ success: true, images: watermarkedUrls, text, count: watermarkedUrls.length });
  } catch (e) {
    console.error("[watermark]", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * v0.6.0 批量按 offer_id 查商品 - 用于"粘贴批量上架"
 * 输入: { store_id, offer_ids: ["3012108591-i5Rp", ...] }
 * 输出: { success: true, items: [{offer_id, name, image, price, brand, ...}] }
 */
app.post("/api/seller/products/batch-lookup", requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const storeId = req.body?.store_id || req.body?.storeId;
    if (!storeId) return res.status(400).json({ success: false, error: "未选择店铺" });
    let offerIds = req.body?.offer_ids || [];
    if (!Array.isArray(offerIds) || !offerIds.length) {
      return res.status(400).json({ success: false, error: "offer_ids 为空" });
    }
    offerIds = offerIds.map(String).filter(Boolean).slice(0, 500);

    const r = await db.query(
      `SELECT offer_id, product_id, name, image, images, price, currency_code, brand,
              weight, depth, width, height, status, category_name, country_of_origin,
              description, barcode, vat
       FROM app_products
       WHERE store_id = $1 AND offer_id = ANY($2::text[])`,
      [storeId, offerIds],
    );
    res.json({ success: true, items: r.rows, matched: r.rows.length, requested: offerIds.length });
  } catch (e) {
    console.error("[batch-lookup]", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * v0.6.0 AI 批量翻译 - MiniMax M3
 * 输入: { text, target_lang: 'ru'|'zh'|'en' }
 * 输出: { success: true, translated: "...", model: "MiniMax-M3" }
 */
app.post("/api/ai/translate", requireAuth, async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    const targetLang = String(req.body?.target_lang || "ru").toLowerCase();
    if (!text) return res.status(400).json({ success: false, error: "缺少 text" });
    if (!process.env.MINIMAX_API_KEY) return res.status(503).json({ success: false, error: "MINIMAX_API_KEY 未配置" });

    const langName = { ru: "俄语", zh: "中文", en: "英语" }[targetLang] || "俄语";
    const prompt = `将以下文本翻译为${langName}, 保持电商专业术语, 每行对应翻译, 保持换行结构。只输出翻译结果, 不要解释:\n\n${text}`;

    const resp = await fetch(`${MINIMAX_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.MINIMAX_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MINIMAX_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_completion_tokens: 2000,
      }),
    });
    const raw = await resp.text();
    if (!resp.ok) return res.status(502).json({ success: false, error: `MiniMax ${resp.status}`, payload: raw.slice(0, 300) });
    const payload = JSON.parse(raw);
    const translated = payload?.choices?.[0]?.message?.content || "";
    console.log(`[AI-Translate] ${text.length} chars → ${targetLang}, ${translated.length} chars`);
    res.json({ success: true, translated, model: MINIMAX_MODEL });
  } catch (e) {
    console.error("[AI-Translate]", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

function parseAiJsonObject(rawContent) {
  const cleaned = String(rawContent || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?|```/gi, "")
    .trim();

  const starts = [];
  for (let i = 0; i < cleaned.length; i += 1) {
    if (cleaned[i] === "{") starts.push(i);
  }
  for (const start of starts) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = start; i < cleaned.length; i += 1) {
      const char = cleaned[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) {
        try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  try { return JSON.parse(cleaned); } catch { return null; }
}

app.post("/api/ai/analyze", requireAuth, async (req, res) => {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 120000);   // v0.3.7: 40s → 120s (MiniMax M3 多图常 60s+)

  try {
    const title = String(req.body?.title || "").trim();
    const images = Array.isArray(req.body?.images) ? req.body.images.filter(Boolean).slice(0, 5) : [];
    const targetMarket = String(req.body?.target_market || "ozon").toLowerCase();
    const storeId = req.body?.store_id || req.body?.storeId;
    console.log(`[AI-Analyze] title="${title || "(空)"}", images=${images.length}, market=${targetMarket}, store=${storeId}`);

    if (!title && !images.length) {
      return res.status(400).json({ success: false, error: "至少需要标题或图片其中一个" });
    }
    if (!process.env.MINIMAX_API_KEY) {
      throw new Error("MINIMAX_API_KEY 未配置, 无法调用 MiniMax M3");
    }

    // 目标市场风格模板
    const marketProfile = {
      ozon: {
        style_hint: "俄罗斯 Ozon 平台风格: 白底商务、干净清晰、突出参数与卖点标注、Cyrillic 文本可读, 主图 4:5 或 1:1, 详情图带俄语功能标注",
        title_lang: "俄语",
        title_lang_hint: "标题必须为俄语, 长度 60-90 字符, 包含核心关键词",
        image_style_kw: "clean white background, product photography, Russian ecommerce, marketplace hero image, 4k, studio lighting",
      },
      etsy: {
        style_hint: "美国 Etsy 平台风格: 生活场景化、手工温暖调、木质/亚麻/植物背景, 情感化叙事, 主图 4:3 或 1:1, 详情图强调工艺细节与使用场景",
        title_lang: "英语",
        title_lang_hint: "标题必须为英语, 长度 40-70 字符, 突出 handmade / vintage / eco 等 Etsy 关键词",
        image_style_kw: "lifestyle scene, warm natural lighting, handmade aesthetic, wood/linen backdrop, Etsy vintage vibe, cozy",
      },
    }[targetMarket] || null;
    if (!marketProfile) {
      return res.status(400).json({ success: false, error: `不支持的 target_market: ${targetMarket} (仅 ozon | etsy)` });
    }

    // 构造 prompt
    const titleKey = marketProfile.title_lang === "俄语" ? "title_ru" : "title_en";
    const promptText = [
      `你是跨境电商选品专家, 目标平台: ${targetMarket.toUpperCase()}。`,
      `平台风格: ${marketProfile.style_hint}`,
      title ? `用户输入的商品中文标题: 【${title}】` : `用户未提供标题, 请你根据图片自行判断商品品类。`,
      images.length ? `已附上 ${images.length} 张商品素材图, 请仔细看图后分析。` : `无图片, 仅根据标题分析。`,
      images.length ? `重要: 若图片内容与用户给的标题不一致, 以图片实际内容为准进行商品分析。` : ``,
      `任务:`,
      `1) product_type: 商品品类 (1-4 个中文词, 基于图片实际内容)`,
      `2) title_zh: 生成或优化中文标题 (30-50 字, 突出核心卖点+关键词)`,
      `3) ${titleKey}: ${marketProfile.title_lang_hint}`,
      `4) selling_points: 3-5 个核心卖点 (中文, 每条 8-20 字, 崇尚真实基于图片实际内容, 严禁瞎编)`,
      `5) image_prompt: 一段英文生图 prompt (60-120 词), 用于万相 2.7 生成主图, 融合平台风格关键词: ${marketProfile.image_style_kw}`,
      `6) brand: 仅在标题或图片能明确识别品牌时填写, 无法确认则留空, 严禁猜测`,
      `7) category_name: 商品类目中文名称 (2-10 字)`,
      `8) description: ${marketProfile.title_lang}商品描述 (80-180 字, 只写可确认的信息, 不使用 HTML)`,
      ``,
      `【输出格式 - 必须严格遵守】`,
      `只输出一个 JSON 对象, 不要任何解释文字、不要前后说明、不要 markdown code fence。`,
      `格式如下:`,
      `{"product_type":"", "title_zh":"", "${titleKey}":"", "selling_points":[], "image_prompt":"", "brand":"", "category_name":"", "description":""}`,
    ].filter(Boolean).join("\n");

    // v0.3.7: MiniMax M3 需要 data URL 或 公网 URL, 本地 /uploads/xxx 须读盘转 base64
    const MIME_BY_EXT = {
      ".png": "image/png",
      ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
    };
    const resolveImageUrl = async (raw) => {
      const u = String(raw || "").trim();
      if (!u) return null;
      if (/^https?:\/\//i.test(u)) return u;          // 公网 URL: 原样
      if (/^data:image\//i.test(u)) return u;         // 已是 data URL: 原样
      if (u.startsWith("/uploads/") || u.startsWith("uploads/")) {
        const rel = u.replace(/^\//, "");
        const abs = path.join(PUBLIC_DIR, rel);
        if (!abs.startsWith(PUBLIC_DIR)) return null; // 路径穿越保护
        try {
          const buf = await fs.readFile(abs);
          const ext = path.extname(abs).toLowerCase();
          const mime = MIME_BY_EXT[ext] || "image/jpeg";
          return `data:${mime};base64,${buf.toString("base64")}`;
        } catch (e) {
          console.warn(`[AI-Analyze] 读本地图失败 ${abs}: ${e.message}`);
          return null;
        }
      }
      return u;
    };

    // MiniMax M3 多模态消息格式 (与 reviewCandidatesWithMiniMax 一致)
    const content = [];
    for (const url of images) {
      const resolved = await resolveImageUrl(url);
      if (!resolved) {
        console.warn(`[AI-Analyze] 图片无法解析, 跳过: ${url}`);
        continue;
      }
      const isB64 = resolved.startsWith("data:");
      console.log(`[AI-Analyze] image: ${isB64 ? `base64(${Math.round(resolved.length / 1024)}KB)` : resolved}`);
      content.push({ type: "image_url", image_url: { url: resolved, detail: "default" } });
    }
    content.push({ type: "text", text: promptText });

    console.log(`[AI-Analyze] 调用 MiniMax 模型: ${MINIMAX_MODEL}`);

    // v0.3.7: 排障日志 - 图片张数 + 估算 payload 大小 (运维排查用)
    const payloadSizeKB = Math.round(JSON.stringify({ model: MINIMAX_MODEL, messages: [{ role: "user", content }] }).length / 1024);
    console.log(`[AI-Analyze] 准备 fetch · images=${images.length} · payload≈${payloadSizeKB}KB · timeout=120s`);

    const mmResp = await fetch(`${MINIMAX_BASE_URL}/chat/completions`, {
      method: "POST",
      signal: abortController.signal,
      headers: {
        "Authorization": `Bearer ${process.env.MINIMAX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MINIMAX_MODEL,
        messages: [{ role: "user", content }],
        temperature: 0.3,
        max_completion_tokens: 2400,
        ...buildMiniMaxThinkingOptions(MINIMAX_THINKING_TYPE),
      }),
    });
    clearTimeout(timeoutId);

    const raw = await mmResp.text();
    if (!mmResp.ok) {
      console.error(`[AI-Analyze] MiniMax ${mmResp.status}:`, raw.slice(0, 500));
      return res.status(502).json({ success: false, error: `MiniMax 调用失败 (${mmResp.status})`, payload: raw.slice(0, 500) });
    }
    const payload = JSON.parse(raw);
    let resultText = payload?.choices?.[0]?.message?.content || "";
    let parsed = parseAiJsonObject(resultText);

    if (!parsed) {
      console.warn("[AI-Analyze] 首次返回非 JSON, 自动纠正一次:", resultText.slice(0, 300));
      const repairResp = await fetch(`${MINIMAX_BASE_URL}/chat/completions`, {
        method: "POST",
        signal: abortController.signal,
        headers: {
          "Authorization": `Bearer ${process.env.MINIMAX_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MINIMAX_MODEL,
          messages: [{
            role: "user",
            content: `把下面内容整理成合法 JSON。只输出 JSON 对象，不要思考过程、解释或代码围栏。必须包含 product_type、title_zh、${titleKey}、selling_points、image_prompt、brand、category_name、description。\n\n${resultText.slice(0, 8000)}`,
          }],
          temperature: 0.1,
          max_completion_tokens: 1600,
          ...buildMiniMaxThinkingOptions("disabled"),
        }),
      });
      const repairRaw = await repairResp.text();
      if (repairResp.ok) {
        const repairPayload = JSON.parse(repairRaw);
        resultText = repairPayload?.choices?.[0]?.message?.content || "";
        parsed = parseAiJsonObject(resultText);
      }
    }

    if (!parsed) {
      console.error("[AI-Analyze] JSON 纠正后仍解析失败, 原始:", resultText.slice(0, 500));
      return res.status(502).json({ success: false, error: "AI 分析结果格式异常，请重新生成", raw: resultText.slice(0, 500) });
    }

    // 结构规范化
    const data = {
      product_type: String(parsed.product_type || "").trim(),
      title_zh: String(parsed.title_zh || title || "").trim(),
      title_ru: String(parsed.title_ru || "").trim(),
      title_en: String(parsed.title_en || "").trim(),
      selling_points: Array.isArray(parsed.selling_points) ? parsed.selling_points.slice(0, 6) : [],
      image_prompt: String(parsed.image_prompt || "").trim(),
      brand: String(parsed.brand || "").trim(),
      category_name: String(parsed.category_name || parsed.product_type || "").trim(),
      description: String(parsed.description || "").trim(),
      target_market: targetMarket,
      model: MINIMAX_MODEL,
    };
    console.log(`[AI-Analyze] 成功 · model=${MINIMAX_MODEL} · product_type="${data.product_type}", ${data.selling_points.length} 卖点`);
    res.json({ success: true, data });
  } catch (error) {
    clearTimeout(timeoutId);
    // v0.3.7: AbortError 友好提示, 不暴露原始系统错误
    if (error.name === "AbortError" || /aborted/i.test(error.message)) {
      console.error("[AI-Analyze] 超时 (120s)");
      return res.status(504).json({
        success: false,
        error: "AI 分析超时 (120s)，请尝试减少图片数量或分批次分析。",
      });
    }
    console.error("[AI-Analyze] 失败:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * v0.3.3 订单列表 - 平铺金额 + 物理 JOIN 商品表拉图
 * 输入: {store_id, status, limit, offset, since, to}
 * 输出: 每单含 total_rub / total_cny / commission_cny / payout_cny / product_count / products[{image,name,offer_id,sku,quantity,price_cny}]
 */
app.post("/api/seller/orders", requireAuth, async (req, res, next) => {
  try {
    const storeId = req.body?.store_id || req.body?.storeId;
    if (!storeId) return res.status(400).json({ success: false, error: "未选择店铺" });
    const rateResult = db ? await db.query(
      `SELECT rate FROM app_exchange_rates
        WHERE base_currency = 'RUB' AND quote_currency = 'CNY'
        ORDER BY effective_at DESC LIMIT 1`,
    ) : { rows: [] };
    const effectiveRubCnyRate = Number(rateResult.rows[0]?.rate || RUB_CNY_RATE);
    const convertRub = value => Math.round(Number(value || 0) * effectiveRubCnyRate * 100) / 100;

    const limit = Math.min(200, Math.max(1, Number(req.body?.limit || 50)));
    const offset = Math.max(0, Number(req.body?.offset || 0));
    const status = String(req.body?.status || "").trim().toLowerCase();
    const hasExplicitRange = Boolean(req.body?.since || req.body?.to);
    const syncMode = String(req.body?.sync_mode || req.body?.syncMode || "").trim().toLowerCase();
    const defaultCacheHistoryDays = 84;
    const financialToCny = (value, currency, settlementRate = null) => {
      const amount = Number(value || 0);
      if (!Number.isFinite(amount)) return 0;
      if (currency === "CNY") return settlementRate ? amount * settlementRate : amount;
      if (currency === "RUB") return convertRub(amount);
      return amount;
    };
    const logisticsServiceCny = (services, currency, settlementRate = null) => Object.entries(services || {}).reduce((sum, [key, value]) => {
      const serviceKey = String(key || "").toLowerCase();
      if (!/fulfillment|pickup|dropoff|deliv|delivery|trans|return|flow|last/.test(serviceKey)) return sum;
      return sum + Math.abs(financialToCny(value, currency, settlementRate));
    }, 0);
    const normalizeOrderAccountingPayload = (payload = {}) => {
      const fdProducts = payload?.financial_data?.products || [];
      const products = Array.isArray(payload.products) ? payload.products.map((product) => {
        const fd = fdProducts.find(x => String(x.product_id) === String(product.sku)) || {};
        const currency = String(product.currency_code || payload.currency_code || "RUB").toUpperCase();
        const financialCurrency = String(fd.currency_code || product.financial_currency_code || "RUB").toUpperCase();
        const priceNative = Number(product.price_native || product.price?.amount || product.price || fd.price || 0);
        const platformPrice = Number(fd.price || fd.customer_price || 0);
        const settlementRate = currency === "CNY" && platformPrice > 0 ? priceNative / platformPrice : null;
        const commissionCny = Math.abs(financialToCny(fd.commission_amount ?? product.commission_amount ?? 0, financialCurrency, null));
        const lastMileCny = logisticsServiceCny(fd.item_services || fd.services || {}, financialCurrency, null);
        const payoutCny = financialToCny(fd.payout ?? product.payout_native ?? product.payout_cny ?? 0, financialCurrency, null);
        return {
          ...product,
          financial_currency_code: financialCurrency,
          commission_cny: Math.round(commissionCny * Number(product.quantity || fd.quantity || 1) * 100) / 100,
          last_mile_cny: Math.round(lastMileCny * Number(product.quantity || fd.quantity || 1) * 100) / 100,
          payout_cny: Math.round(payoutCny * Number(product.quantity || fd.quantity || 1) * 100) / 100,
        };
      }) : [];
      const totalCny = Number(payload.total_cny || 0);
      const commissionCny = products.reduce((sum, product) => sum + Number(product.commission_cny || 0), 0);
      const payoutCny = products.reduce((sum, product) => sum + Number(product.payout_cny || 0), 0);
      const rawLastMileCny = products.reduce((sum, product) => sum + Number(product.last_mile_cny || 0), 0);
      const lastMileCny = rawLastMileCny > 0 ? rawLastMileCny : Math.max(0, totalCny - payoutCny - commissionCny);
      const outboundCostCny = Number(payload.outbound_cost_cny || 0);
      const delivered = String(payload.status || "").toLowerCase() === "delivered";
      return {
        ...payload,
        products,
        commission_cny: Math.round(commissionCny * 100) / 100,
        last_mile_cny: Math.round(lastMileCny * 100) / 100,
        ozon_cost_cny: Math.round((commissionCny + lastMileCny) * 100) / 100,
        profit_cny: delivered ? Math.round((totalCny - commissionCny - lastMileCny - outboundCostCny) * 100) / 100 : null,
        profit_calculable: delivered,
        profit_block_reason: delivered ? "" : "仅已送达订单可计算利润",
      };
    };

    const enrichPostings = async (postings) => {
      const allOfferIds = new Set();
      for (const p of postings) {
        for (const pd of (p.products || [])) {
          if (pd?.offer_id) allOfferIds.add(pd.offer_id);
        }
      }
      const imageMap = new Map();
      if (allOfferIds.size && db) {
        const joinRows = await db.query(
          `SELECT offer_id, image, name, purchase_price_cny, source_url_1688 FROM app_products
           WHERE user_id = $1 AND store_id = $2 AND offer_id = ANY($3::text[])`,
          [req.user.id, storeId, Array.from(allOfferIds)],
        );
        for (const r of joinRows.rows) imageMap.set(r.offer_id, {
          image: r.image,
          name: r.name,
          purchase_price_cny: Number(r.purchase_price_cny || 0),
          source_url_1688: r.source_url_1688 || "",
        });
      }
      const postingNumbers = postings.map((p) => p.posting_number).filter(Boolean);
      const orderCostMap = new Map();
      if (postingNumbers.length && db) {
        const costRows = await db.query(
          `SELECT posting_number, offer_id, source_url_1688, outbound_cost_cny
             FROM app_order_costs
            WHERE user_id = $1 AND store_id = $2 AND posting_number = ANY($3::text[])`,
          [req.user.id, storeId, postingNumbers],
        );
        for (const r of costRows.rows) {
          orderCostMap.set(r.posting_number, {
            offer_id: r.offer_id || "",
            source_url_1688: r.source_url_1688 || "",
            outbound_cost_cny: Number(r.outbound_cost_cny || 0),
          });
        }
      }

      const enriched = postings.map((p) => {
        const fdProducts = p?.financial_data?.products || [];
        const orderCost = orderCostMap.get(p.posting_number) || {};
        const serviceAmountCny = (fd, currency, settlementRate) => {
          const services = fd?.item_services || fd?.services || {};
          return logisticsServiceCny(services, currency, settlementRate);
        };
        const products = (p.products || []).map((pd) => {
          const fd = fdProducts.find(x => String(x.product_id) === String(pd.sku)) || {};
          const currency = String(
            pd.currency_code ||
            pd.price?.currency ||
            fd.currency_code ||
            p.currency_code ||
            "RUB"
          ).toUpperCase();
          const priceNative = Number(pd.price?.amount || pd.price || fd.price || 0);
          const qty = Number(pd.quantity || fd.quantity || 1);
          const priceCny = currency === "CNY" ? priceNative
                         : currency === "RUB" ? convertRub(priceNative)
                         : priceNative;
          const priceRub = currency === "RUB" ? priceNative
                         : currency === "CNY" ? (priceNative / effectiveRubCnyRate)
                         : 0;
          const customerRub = Number(fd.customer_price || 0);
          const commissionNative = Number(fd.commission_amount || 0);
          const payoutNative = Number(fd.payout || 0);
          const platformPrice = Number(fd.price || fd.customer_price || 0);
          const localMeta = imageMap.get(pd.offer_id) || {};
          const settlementRate = currency === "CNY" && platformPrice > 0 ? priceNative / platformPrice : null;
          const financialCurrency = String(fd.currency_code || "RUB").toUpperCase();
          const payoutCny = financialToCny(payoutNative, financialCurrency, null);
          const commissionCny = Math.abs(financialToCny(commissionNative, financialCurrency, null));
          const lastMileCny = serviceAmountCny(fd, financialCurrency, null);
          const purchasePriceCny = Number(localMeta.purchase_price_cny || 0);
          return {
            offer_id: pd.offer_id,
            sku: pd.sku,
            name: localMeta.name || pd.name,
            image: localMeta.image || pd.image || "",
            quantity: qty,
            currency_code: currency,
            financial_currency_code: financialCurrency,
            price_native: priceNative,
            price_cny: Math.round(priceCny * 100) / 100,
            price_rub: Math.round(priceRub * 100) / 100,
            customer_price_rub: customerRub,
            subtotal_cny: Math.round(priceCny * qty * 100) / 100,
            subtotal_rub: Math.round(priceRub * qty * 100) / 100,
            commission_amount: commissionNative,
            commission_cny: Math.round(commissionCny * qty * 100) / 100,
            last_mile_cny: Math.round(lastMileCny * qty * 100) / 100,
            payout_cny: Math.round(payoutCny * qty * 100) / 100,
            purchase_price_cny: purchasePriceCny,
            purchase_cost_cny: Math.round(purchasePriceCny * qty * 100) / 100,
            profit_cny: purchasePriceCny > 0 ? Math.round((payoutCny * qty - purchasePriceCny * qty) * 100) / 100 : null,
            profit_is_estimated: purchasePriceCny <= 0,
            source_url_1688: (String(orderCost.offer_id || "") === String(pd.offer_id || "") ? orderCost.source_url_1688 : "") || localMeta.source_url_1688 || "",
          };
        });
        const totalCny = products.reduce((s, x) => s + (x.subtotal_cny || 0), 0);
        const totalRub = products.reduce((s, x) => s + (x.subtotal_rub || 0), 0);
        const totalCustomerRub = (fdProducts || []).reduce((s, x) => s + Number(x.customer_price || 0) * Number(x.quantity || 1), 0);
        const totalCommissionCny = products.reduce((s, x) => s + (x.commission_cny || 0), 0);
        const totalPayoutCny = products.reduce((s, x) => s + (x.payout_cny || 0), 0);
        const rawLastMileCny = products.reduce((s, x) => s + (x.last_mile_cny || 0), 0);
        const delivered = String(p.status || "").toLowerCase() === "delivered";
        const totalLastMileCny = rawLastMileCny > 0 ? rawLastMileCny : Math.max(0, totalCny - totalPayoutCny - totalCommissionCny);
        const purchaseCostCny = products.reduce((s, x) => s + (x.purchase_cost_cny || 0), 0);
        const ozonCostCny = totalCommissionCny + totalLastMileCny;
        const outboundCostCny = Number(orderCost.outbound_cost_cny || 0);
        return {
          ...p,
          products,
          total_cny: Math.round(totalCny * 100) / 100,
          total_rub: Math.round(totalRub * 100) / 100,
          customer_total_rub: Math.round(totalCustomerRub * 100) / 100,
          commission_cny: Math.round(totalCommissionCny * 100) / 100,
          last_mile_cny: Math.round(totalLastMileCny * 100) / 100,
          payout_cny: Math.round(totalPayoutCny * 100) / 100,
          ozon_cost_cny: Math.round(ozonCostCny * 100) / 100,
          purchase_cost_cny: Math.round(purchaseCostCny * 100) / 100,
          outbound_cost_cny: Math.round(outboundCostCny * 100) / 100,
          profit_cny: delivered ? Math.round((totalCny - ozonCostCny - outboundCostCny) * 100) / 100 : null,
          profit_calculable: delivered,
          profit_block_reason: delivered ? "" : "仅已送达订单可计算利润",
          product_count: products.reduce((s, x) => s + (x.quantity || 0), 0),
        };
      });
      return { enriched, offerCount: allOfferIds.size, imageCount: imageMap.size };
    };

    const fetchLiveOrders = async ({ since, to, status: liveStatus, pageLimit = limit, pageOffset = offset }) => {
      const filter = { since, to };
      if (liveStatus && liveStatus !== "all") filter.status = liveStatus;
      const ozonData = await callOzonSellerAPI("/v3/posting/fbs/list", {
        dir: "DESC",
        filter,
        limit: pageLimit,
        offset: pageOffset,
        with: { financial_data: true, analytics_data: true },
      }, { storeId, userId: req.user.id });
      const postings = ozonData?.result?.postings || [];
      const hasNext = ozonData?.result?.has_next === true;
      const totalCount = hasNext ? pageOffset + postings.length + 1 : pageOffset + postings.length;
      const enrichedResult = await enrichPostings(postings);
      return { ...enrichedResult, hasNext, totalCount };
    };

    const upsertOrderCache = async (rows) => {
      if (!db || !rows.length) return;
      for (const row of rows) {
        await db.query(
          `INSERT INTO app_order_cache (
             user_id, store_id, posting_number, status, display_status, substatus,
             in_process_at, shipment_date, delivering_date, payload, synced_at, updated_at
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,now(),now())
           ON CONFLICT (store_id, posting_number) DO UPDATE SET
             status = EXCLUDED.status,
             display_status = COALESCE(NULLIF(app_order_cache.display_status, ''), EXCLUDED.display_status),
             substatus = EXCLUDED.substatus,
             in_process_at = EXCLUDED.in_process_at,
             shipment_date = EXCLUDED.shipment_date,
             delivering_date = EXCLUDED.delivering_date,
             payload = EXCLUDED.payload,
             synced_at = now(),
             updated_at = now()`,
          [
            req.user.id,
            storeId,
            row.posting_number,
            row.status || "",
            row.status || "",
            row.substatus || "",
            row.in_process_at || row.created_at || null,
            row.shipment_date || null,
            row.delivering_date || null,
            JSON.stringify(row),
          ],
        );
      }
    };

    const syncCacheRange = async ({ since, to, label = "custom" }) => {
      let syncOffset = 0;
      let synced = 0;
      for (let page = 0; page < 12; page++) {
        const live = await fetchLiveOrders({
          since: since.toISOString(),
          to: to.toISOString(),
          status: "all",
          pageLimit: 200,
          pageOffset: syncOffset,
        });
        await upsertOrderCache(live.enriched);
        synced += live.enriched.length;
        if (!live.hasNext || live.enriched.length < 200) break;
        syncOffset += 200;
      }
      console.log(`[OrdersCache] store=${storeId} sync_range=${label} synced=${synced}`);
    };

    const syncCacheWindow = async (days) => {
      const to = new Date();
      const since = new Date(to.getTime() - days * 24 * 3600 * 1000);
      await syncCacheRange({ since, to, label: `${days}d` });
    };

    const pruneCacheWindow = async (days) => {
      if (!db) return;
      const since = new Date(Date.now() - days * 24 * 3600 * 1000);
      await db.query(
        `DELETE FROM app_order_cache
         WHERE user_id = $1 AND store_id = $2 AND in_process_at < $3`,
        [req.user.id, storeId, since.toISOString()],
      );
    };

    if (db && syncMode !== "live") {
      const cacheCountRes = await db.query(
        `SELECT count(*)::int AS count
         FROM app_order_cache
         WHERE user_id = $1 AND store_id = $2`,
        [req.user.id, storeId],
      );
      const cacheCount = Number(cacheCountRes.rows[0]?.count || 0);
      if (syncMode === "latest") {
        const syncSince = req.body?.sync_since ? new Date(req.body.sync_since) : null;
        const syncTo = req.body?.sync_to ? new Date(req.body.sync_to) : null;
        if (syncSince && syncTo && Number.isFinite(syncSince.getTime()) && Number.isFinite(syncTo.getTime()) && syncSince <= syncTo) {
          await syncCacheRange({ since: syncSince, to: syncTo, label: "manual" });
        } else {
          await syncCacheWindow(1);
        }
      }
      else if (syncMode === "in_progress") await syncCacheWindow(defaultCacheHistoryDays);
      else if (!hasExplicitRange && cacheCount < 550) await syncCacheWindow(defaultCacheHistoryDays);
      await pruneCacheWindow(defaultCacheHistoryDays);

      const where = ["user_id = $1", "store_id = $2"];
      const params = [req.user.id, storeId];
      if (req.body?.since) {
        params.push(req.body.since);
        where.push(`in_process_at >= $${params.length}`);
      }
      if (req.body?.to) {
        params.push(req.body.to);
        where.push(`in_process_at <= $${params.length}`);
      }
      if (status && status !== "all") {
        params.push(status === "disputed" ? "dispute" : status);
        where.push(`COALESCE(NULLIF(display_status, ''), status) = $${params.length}`);
      }
      const countRes = await db.query(
        `SELECT count(*)::int AS count FROM app_order_cache WHERE ${where.join(" AND ")}`,
        params,
      );
      const rowsRes = await db.query(
        `SELECT payload, COALESCE(NULLIF(display_status, ''), status) AS display_status, status AS source_status
         FROM app_order_cache
         WHERE ${where.join(" AND ")}
         ORDER BY in_process_at DESC NULLS LAST, updated_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      );
      const orders = rowsRes.rows.map((row) => normalizeOrderAccountingPayload({
        ...(row.payload || {}),
        source_status: row.source_status,
        status: row.display_status || row.payload?.status || row.source_status,
      }));
      console.log(`[OrdersCache] store=${storeId} mode=${syncMode || "cache"} status=${status || "all"} limit=${limit} offset=${offset} total=${countRes.rows[0]?.count || 0}`);
      return res.json({ success: true, orders, total: Number(countRes.rows[0]?.count || orders.length), has_next: offset + orders.length < Number(countRes.rows[0]?.count || 0), source: "cache" });
    }

    const filter = {
      since: req.body?.since || new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
      to: req.body?.to || new Date().toISOString(),
    };
    if (status && status !== "all") filter.status = status;

    console.log(`[Orders] store=${storeId} status=${status || "all"} limit=${limit} offset=${offset}`);
    const live = await fetchLiveOrders({
      since: filter.since,
      to: filter.to,
      status,
      pageLimit: limit,
      pageOffset: offset,
    });
    console.log(`[Orders] 拉到 ${live.enriched.length} 单, has_next=${live.hasNext}, JOIN 命中图 ${live.imageCount}/${live.offerCount}`);
    res.json({ success: true, orders: live.enriched, total: live.totalCount, has_next: live.hasNext, source: "live" });
  } catch (error) {
    console.error("[Orders] Ozon 拉单失败:", {
      message: error.message,
      statusCode: error.statusCode,
      payload: error.payload,
    });
    res.status(error.statusCode || 502).json({
      success: false,
      error: error.message,
      payload: error.payload || null,
    });
  }
});

/**
 * v0.3.3 订单详情 - Ozon posting/fbs/get 单单详情
 */
app.post("/api/seller/orders/detail", requireAuth, async (req, res) => {
  try {
    const storeId = req.body?.store_id || req.body?.storeId;
    const posting_number = String(req.body?.posting_number || "").trim();
    if (!storeId || !posting_number) return res.status(400).json({ success: false, error: "缺少 store_id / posting_number" });

    const ozonData = await callOzonSellerAPI("/v3/posting/fbs/get", {
      posting_number,
      with: { analytics_data: true, financial_data: true, barcodes: true, product_exemplars: true, translit: true },
    }, { storeId, userId: req.user.id });

    const p = ozonData?.result || {};
    // 附加商品图
    if (db && Array.isArray(p.products) && p.products.length) {
      const offerIds = p.products.map(x => x.offer_id).filter(Boolean);
      const r = await db.query(
        `SELECT offer_id, image, name, purchase_price_cny, source_url_1688
           FROM app_products WHERE user_id=$1 AND store_id=$2 AND offer_id = ANY($3::text[])`,
        [req.user.id, storeId, offerIds],
      );
      const meta = new Map(r.rows.map(x => [x.offer_id, x]));
      p.products = p.products.map(pd => {
        const localMeta = meta.get(pd.offer_id) || {};
        // v0.3.5: 币种优先从商品行明确字段读取, CNY 直读
        const currency = String(pd.currency_code || p.financial_data?.currency_code || "RUB").toUpperCase();
        const priceNative = Number(pd.price || 0);
        const priceCny = currency === "CNY" ? priceNative : rubToCny(priceNative);
        return {
          ...pd,
          image: localMeta.image || "",
          local_name: localMeta.name || pd.name,
          purchase_price_cny: Number(localMeta.purchase_price_cny || 0),
          source_url_1688: localMeta.source_url_1688 || "",
          currency_code: currency,
          price_native: priceNative,
          price_cny: Math.round(priceCny * 100) / 100,
        };
      });
    }
    // 平铺金额 (币种感知)
    const totalCny = (p.products || []).reduce((s, x) => s + Number(x.price_cny || 0) * Number(x.quantity || 1), 0);
    p.total_cny = Math.round(totalCny * 100) / 100;
    p.total_rub = Math.round((totalCny / RUB_CNY_RATE) * 100) / 100;

    res.json({ success: true, order: p });
  } catch (error) {
    console.error("[Orders.detail]", error.message, error.payload);
    res.status(error.statusCode || 502).json({ success: false, error: error.message, payload: error.payload || null });
  }
});

/**
 * v0.3.3 订单发货 - Ozon posting/fbs/ship 单发货 (支持整单发货, 需前端传 packages)
 */
app.post("/api/seller/orders/ship", requireAuth, async (req, res) => {
  let claimedEventId = null;
  try {
    const storeId = req.body?.store_id || req.body?.storeId;
    const posting_number = String(req.body?.posting_number || "").trim();
    const packages = req.body?.packages;   // [{products:[{product_id,quantity}]}]
    if (!storeId || !posting_number) return res.status(400).json({ success: false, error: "缺少 store_id / posting_number" });
    if (!Array.isArray(packages) || !packages.length) return res.status(400).json({ success: false, error: "缺少发货包裹信息" });

    if (!db) return res.status(503).json({ success: false, error: "数据库不可用，无法安全执行发货" });

    let claim = await db.query(
      `INSERT INTO app_order_ship_events (user_id, store_id, posting_number, packages, status)
       VALUES ($1,$2,$3,$4::jsonb,'processing')
       ON CONFLICT (store_id, posting_number) DO NOTHING
       RETURNING id, status, packages, ozon_response, completed_at, updated_at`,
      [req.user.id, storeId, posting_number, JSON.stringify(packages)],
    );
    const inserted = claim.rowCount > 0;
    let ownsClaim = inserted;
    if (!inserted) {
      claim = await db.query(
        `UPDATE app_order_ship_events
            SET packages=$1::jsonb, status='processing', error='', updated_at=now()
          WHERE user_id=$2 AND store_id=$3 AND posting_number=$4 AND status='failed'
          RETURNING id, status, packages, ozon_response, completed_at, updated_at`,
        [JSON.stringify(packages), req.user.id, storeId, posting_number],
      );
      ownsClaim = claim.rowCount > 0;
      if (!claim.rowCount) {
        claim = await db.query(
          `SELECT id, status, packages, ozon_response, completed_at, updated_at
             FROM app_order_ship_events WHERE user_id=$1 AND store_id=$2 AND posting_number=$3`,
          [req.user.id, storeId, posting_number],
        );
      }
    }
    const event = claim.rows[0];
    claimedEventId = event.id;
    if (event.status === "completed") {
      return res.status(409).json({ success: false, code: "ORDER_ALREADY_SHIPPED", error: "该订单已提交发货，请刷新订单状态", completed_at: event.completed_at });
    }
    if (!ownsClaim && event.status === "processing") {
      return res.status(409).json({ success: false, code: "ORDER_SHIP_IN_PROGRESS", error: "该订单正在处理，请勿重复提交" });
    }

    let data = event.ozon_response && Object.keys(event.ozon_response).length ? event.ozon_response : null;
    if (!data) {
      const latest = await callOzonSellerAPI("/v3/posting/fbs/get", {
        posting_number,
        with: { analytics_data: false, financial_data: false },
      }, { storeId, userId: req.user.id });
      const currentStatus = String(latest?.result?.status || "").toLowerCase();
      if (currentStatus === "cancelled") {
        await db.query(`UPDATE app_order_ship_events SET status='failed', error=$1, updated_at=now() WHERE id=$2`, ["订单已取消", event.id]);
        return res.status(409).json({ success: false, code: "ORDER_CANCELLED", error: "订单已被取消，已阻止发货" });
      }
      if (!["awaiting_packaging", "awaiting_deliver"].includes(currentStatus)) {
        await db.query(`UPDATE app_order_ship_events SET status='failed', error=$1, updated_at=now() WHERE id=$2`, [`订单当前状态 ${currentStatus || '未知'} 不允许发货`, event.id]);
        return res.status(409).json({ success: false, code: "ORDER_STATUS_CHANGED", error: `订单状态已变为 ${currentStatus || "未知"}，请刷新后重试` });
      }
      data = await callOzonSellerAPI("/v3/posting/fbs/ship", {
        posting_number,
        packages,
        with: { additional_data: true },
      }, { storeId, userId: req.user.id });
      await db.query(
        `UPDATE app_order_ship_events SET status='ozon_succeeded', ozon_response=$1::jsonb, error='', updated_at=now() WHERE id=$2`,
        [JSON.stringify(data || {}), event.id],
      );
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(`SELECT status, packages FROM app_order_ship_events WHERE id=$1 FOR UPDATE`, [event.id]);
      if (locked.rows[0]?.status !== "completed") {
        const shipped = new Map();
        for (const pack of (locked.rows[0]?.packages || packages)) for (const product of (pack.products || [])) {
          const sku = String(product.product_id || "");
          shipped.set(sku, (shipped.get(sku) || 0) + Math.max(0, Number(product.quantity || 0)));
        }
        for (const [sku, quantity] of shipped) {
          const found = await client.query(
            `SELECT id, stock, stocks_json FROM app_products
              WHERE user_id=$1 AND store_id=$2 AND (sku::text=$3 OR product_id::text=$3) FOR UPDATE`,
            [req.user.id, storeId, sku],
          );
          for (const product of found.rows) {
            let remaining = quantity;
            const stocks = Array.isArray(product.stocks_json) ? product.stocks_json.map(row => ({ ...row })) : [];
            for (const stock of stocks) {
              if (remaining <= 0) break;
              const present = Math.max(0, Number(stock.present || 0));
              const deducted = Math.min(present, remaining);
              stock.present = present - deducted;
              remaining -= deducted;
            }
            const total = stocks.length ? stocks.reduce((sum, row) => sum + Math.max(0, Number(row.present || 0)), 0) : Math.max(0, Number(product.stock || 0) - quantity);
            await client.query(`UPDATE app_products SET stock=$1, stocks_json=$2::jsonb, updated_at=now() WHERE id=$3 AND user_id=$4`, [total, JSON.stringify(stocks), product.id, req.user.id]);
          }
        }
        await client.query(`UPDATE app_order_ship_events SET status='completed', completed_at=now(), updated_at=now() WHERE id=$1`, [event.id]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("[Orders.ship] local inventory adjustment failed:", error.message);
      return res.status(500).json({ success: false, code: "LOCAL_RECONCILIATION_REQUIRED", error: "Ozon 已接收发货，但本地库存更新失败；再次提交只会补本地库存，不会重复发货" });
    } finally { client.release(); }

    res.json({ success: true, data, inventoryAdjusted: true });
  } catch (error) {
    console.error("[Orders.ship]", error.message, error.payload);
    if (claimedEventId && db) {
      await db.query(
        `UPDATE app_order_ship_events SET status=CASE WHEN status='ozon_succeeded' THEN status ELSE 'failed' END, error=$1, updated_at=now() WHERE id=$2`,
        [String(error.payload?.message || error.message || "发货失败").slice(0, 1000), claimedEventId],
      ).catch(() => {});
    }
    res.status(error.statusCode || 502).json({ success: false, error: error.message, payload: error.payload || null });
  }
});

/**
 * 订单取消 - 对接 Ozon /v2/posting/fbs/cancel，但默认仅允许沙箱模式执行。
 */
app.post("/api/seller/orders/cancel", requireAuth, async (req, res) => {
  try {
    const storeId = req.body?.store_id || req.body?.storeId;
    const postingNumber = String(req.body?.posting_number || "").trim();
    const reason = String(req.body?.reason || "").trim();
    const cancelReasonId = Number(req.body?.cancel_reason_id || req.body?.cancelReasonId || 0);
    if (!storeId || !postingNumber) return res.status(400).json({ success: false, error: "缺少 store_id / posting_number" });
    if (!Number.isInteger(cancelReasonId) || cancelReasonId <= 0) return res.status(400).json({ success: false, error: "缺少有效的 cancel_reason_id" });
    if (!db) return res.status(503).json({ success: false, error: "数据库不可用，无法安全执行取消" });

    const cached = await db.query(
      `SELECT status, display_status
         FROM app_order_cache
        WHERE user_id=$1 AND store_id=$2 AND posting_number=$3
        LIMIT 1`,
      [req.user.id, storeId, postingNumber],
    );
    if (!cached.rowCount) {
      return res.status(404).json({ success: false, error: "本地缓存未找到该订单，请先拉取最新订单" });
    }
    const status = String(cached.rows[0]?.display_status || cached.rows[0]?.status || "").toLowerCase();
    if (status === "cancelled") {
      return res.status(409).json({ success: false, code: "ORDER_ALREADY_CANCELLED", error: "该订单已是取消状态" });
    }
    if (!["awaiting_packaging", "awaiting_deliver"].includes(status)) {
      return res.status(409).json({ success: false, code: "ORDER_CANCEL_STATUS_BLOCKED", error: `订单当前状态 ${status || "未知"} 不允许取消` });
    }

    const payload = {
      posting_number: postingNumber,
      cancel_reason_id: cancelReasonId,
      ...(reason ? { cancel_reason_message: reason } : {}),
    };
    const cancelBaseUrl = OZON_ORDER_CANCEL_MODE === "sandbox" ? OZON_ORDER_CANCEL_BASE_URL : OZON_SELLER_BASE_URL;
    const sandboxBaseReady = OZON_ORDER_CANCEL_MODE === "sandbox" &&
      OZON_ORDER_CANCEL_BASE_URL &&
      OZON_ORDER_CANCEL_BASE_URL !== OZON_SELLER_BASE_URL;
    const canCallOzonCancel = sandboxBaseReady ||
      (OZON_ORDER_CANCEL_MODE === "production" && OZON_ORDER_CANCEL_ALLOW_PRODUCTION);
    const event = await db.query(
      `INSERT INTO app_order_cancel_events
        (user_id, store_id, posting_number, reason, dry_run, status, ozon_called, request_payload)
       VALUES ($1,$2,$3,$4,$5,$6,false,$7::jsonb)
       RETURNING id, created_at`,
      [req.user.id, storeId, postingNumber, reason, !canCallOzonCancel, canCallOzonCancel ? "processing" : "blocked", JSON.stringify(payload)],
    );

    if (!canCallOzonCancel) {
      return res.status(409).json({
        success: false,
        code: "ORDER_CANCEL_SANDBOX_DISABLED",
        error: OZON_ORDER_CANCEL_MODE === "sandbox"
          ? "取消订单真实接口已对接，但未配置独立 Ozon 沙箱地址，已阻止调用真实 Ozon"
          : "取消订单真实接口已对接，但当前未启用沙箱取消开关，已阻止调用 Ozon",
        mode: OZON_ORDER_CANCEL_MODE || "disabled",
        dry_run: true,
        ozon_called: false,
        event: event.rows[0],
      });
    }

    try {
      const data = await callOzonSellerAPI("/v2/posting/fbs/cancel", payload, {
        storeId,
        userId: req.user.id,
        baseUrl: cancelBaseUrl,
      });
      await db.query(
        `UPDATE app_order_cancel_events
            SET status='ozon_succeeded', dry_run=false, ozon_called=true, response_payload=$1::jsonb
          WHERE id=$2`,
        [JSON.stringify(data || {}), event.rows[0].id],
      );
      return res.json({ success: true, dry_run: false, ozon_called: true, mode: OZON_ORDER_CANCEL_MODE, data, event: event.rows[0] });
    } catch (error) {
      await db.query(
        `UPDATE app_order_cancel_events
            SET status='failed', dry_run=false, ozon_called=true, error=$1, response_payload=$2::jsonb
          WHERE id=$3`,
        [String(error.message || "取消失败").slice(0, 1000), JSON.stringify(error.payload || {}), event.rows[0].id],
      );
      throw error;
    }
  } catch (error) {
    console.error("[Orders.cancel]", error.message, error.payload);
    res.status(error.statusCode || 502).json({ success: false, error: error.message, payload: error.payload || null });
  }
});

app.post("/api/seller/orders/labels", requireAuth, async (req, res) => {
  try {
    const storeId = req.body?.store_id || req.body?.storeId;
    const postingNumbers = Array.isArray(req.body?.posting_numbers) ? req.body.posting_numbers.map(String).filter(Boolean).slice(0, 50) : [];
    if (!storeId || !postingNumbers.length) return res.status(400).json({ success: false, error: '请选择需要打印面单的订单' });
    const credentials = await db.query(`SELECT client_id, api_key FROM app_stores WHERE id=$1 AND user_id=$2 AND active=TRUE`, [storeId, req.user.id]);
    if (!credentials.rowCount) return res.status(404).json({ success: false, error: '未找到店铺或无权限' });
    const response = await fetch(`${OZON_SELLER_BASE_URL}/v2/posting/fbs/package-label`, {
      method: 'POST',
      headers: { 'Client-Id': credentials.rows[0].client_id, 'Api-Key': credentials.rows[0].api_key, 'Content-Type': 'application/json', Accept: 'application/pdf, application/json' },
      body: JSON.stringify({ posting_number: postingNumbers }),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) return res.status(response.status).json({ success: false, error: `Ozon 面单生成失败：${bytes.toString('utf8').slice(0, 1000)}` });
    const contentType = response.headers.get('content-type') || 'application/pdf';
    if (contentType.includes('json')) return res.status(502).json({ success: false, error: `Ozon 未返回 PDF：${bytes.toString('utf8').slice(0, 1000)}` });
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="ozon-labels-${Date.now()}.pdf"`);
    res.send(bytes);
  } catch (error) { res.status(error.statusCode || 502).json({ success: false, error: error.message }); }
});

// ---------- 上架记录 ----------
app.get("/api/seller/import/history", requireAuth, async (req, res, next) => {
  try {
    if (!db || !req.user?.id) { res.json({ items: [], total: 0 }); return; }
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
    const offset = Math.max(0, Number(req.query.offset || 0));
    const status = String(req.query.status || "").trim();
    const search = String(req.query.search || "").trim();
    let where = "WHERE user_id = $1";
    const params = [req.user.id];
    let pi = 2;
    if (status) { where += ` AND status = $${pi++}`; params.push(status); }
    if (search) { where += ` AND (offer_id ILIKE $${pi} OR product_name ILIKE $${pi} OR task_id ILIKE $${pi})`; params.push(`%${search}%`); pi++; }
    const countR = await db.query(`SELECT count(*) FROM app_listing_history ${where}`, params);
    const total = Number(countR.rows[0]?.count || 0);
    const rows = await db.query(
      `SELECT * FROM app_listing_history ${where} ORDER BY created_at DESC LIMIT $${pi++} OFFSET $${pi++}`,
      [...params, limit, offset],
    );
    res.json({ items: rows.rows, total, limit, offset });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post("/api/seller/import/portal-record", requireAuth, async (req, res) => {
  try {
    if (!db || !req.user?.id) return res.json({ success: true, skipped: true });
    const storeId = req.body?.store_id || req.body?.storeId || null;
    const portalTaskId = String(req.body?.task_id || req.body?.taskId || "").trim();
    const bundleId = String(req.body?.bundle_id || req.body?.bundleId || "").trim();
    const companyId = String(req.body?.company_id || req.body?.companyId || "").trim();
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!portalTaskId) return res.status(400).json({ success: false, error: "缺少 portal task_id" });
    if (!items.length) return res.status(400).json({ success: false, error: "缺少 items" });

    let count = 0;
    for (const it of items) {
      const offerId = String(it?.offer_id || it?.item?.offer_id || "").trim();
      if (!offerId) continue;
      const historyTaskId = `portal-${portalTaskId}-${offerId}`.slice(0, 180);
      const rawPayload = {
        via_portal: true,
        portal_task_id: portalTaskId,
        bundle_id: bundleId,
        company_id: companyId,
        source_sku: it?.source_sku || null,
        item: it?.item || null,
        stocks: Array.isArray(it?.stocks) ? it.stocks : [],
        submitted_at: new Date().toISOString(),
      };
      await db.query(
        `INSERT INTO app_listing_history (user_id, store_id, task_id, offer_id, product_name, main_image, price_rub, status, raw_payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'processing',$8::jsonb)
         ON CONFLICT (task_id) DO UPDATE
            SET updated_at = now(), raw_payload = EXCLUDED.raw_payload, status = EXCLUDED.status`,
        [
          req.user.id,
          storeId || null,
          historyTaskId,
          offerId,
          String(it?.name || it?.item?.name || ""),
          String(it?.image || it?.item?.primary_image || (Array.isArray(it?.item?.images) ? it.item.images[0] : "") || ""),
          it?.price ? Number(it.price) : null,
          JSON.stringify(rawPayload),
        ],
      );
      count++;
    }
    res.json({ success: true, count, portalTaskId, bundleId });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// 强制同步 Ozon 任务状态
app.post("/api/seller/import/sync-task", requireAuth, async (req, res, next) => {
  try {
    const taskId = req.body?.taskId || req.body?.task_id;
    if (!taskId) { res.status(400).json({ success: false, error: "需要 taskId" }); return; }

    // v0.6.2: 优先用请求体里的 store_id (前端知道是哪个店铺)
    // 否则从 history 表里查 (旧记录可能 store_id 为 null, 会 fallback 到 env 默认)
    let storeId = req.body?.store_id || req.body?.storeId || null;
    let historyRow = null;
    if (db && req.user?.id) {
      const r = await db.query(
        `SELECT task_id, store_id, user_id, offer_id, main_image, raw_payload FROM app_listing_history WHERE task_id = $1 AND user_id = $2 LIMIT 1`,
        [String(taskId), req.user.id],
      );
      historyRow = r.rows[0] || null;
      if (!storeId) storeId = historyRow?.store_id || null;
    }

    const data = await callOzonSellerAPI("/v1/product/import/info", { task_id: String(taskId) }, { storeId, userId: req.user?.id });
    const items = data?.result?.items || data?.items || [];
    const item = items[0] || {};
    const ozonStatus = item.status || "unknown";
    const errors = Array.isArray(item.errors) ? item.errors : [];

    // 映射到本地状态
    const statusMap = { imported: "imported", failed: "failed", processing: "processing", moderating: "moderating", pending: "processing" };
    const localStatus = statusMap[ozonStatus] || ozonStatus;

    if (db && req.user?.id) {
      let stockResult = null;
      let pictureResult = null;
      let attributeResult = null;
      if (localStatus === "imported" && historyRow) {
        const importRow = { ...historyRow, store_id: storeId || historyRow.store_id };
        pictureResult = await applyListingPicturesAfterImport(importRow);
        attributeResult = await applyListingAttributesAfterImport(importRow);
        stockResult = await applyListingStocksAfterImport(importRow);
      }
      await db.query(
        `UPDATE app_listing_history SET status = $1, errors_json = $2::jsonb, updated_at = now() WHERE task_id = $3 AND user_id = $4`,
        [localStatus, JSON.stringify(errors), String(taskId), req.user.id],
      );
      res.json({
        success: true,
        ozonStatus,
        localStatus,
        status_canonical: listingStatusToContractStatus(localStatus),
        status_display: listingDisplayStatus(listingStatusToContractStatus(localStatus)),
        errors,
        pictureResult,
        attributeResult,
        stockResult,
      });
      return;
    }
    res.json({
      success: true,
      ozonStatus,
      localStatus,
      status_canonical: listingStatusToContractStatus(localStatus),
      status_display: listingDisplayStatus(listingStatusToContractStatus(localStatus)),
      errors,
    });
  } catch (error) { res.status(error.statusCode || 502).json({ success: false, error: error.message }); }
});

function translateOzonListingError(error) {
  const source = `${error?.code || ""} ${error?.message || error?.description || ""}`.toLowerCase();
  const rules = [
    [/periodic_limit_exceeded|суточн.*лимит|лимит.*создан/i, "当前店铺今日创建商品额度已用完，Ozon 会在莫斯科 03:00（北京时间 08:00）重置额度；请等额度恢复后再提交，或换有额度的店铺。"],
    [/attribute.*(?:empty|required)|error_attribute_values_empty|missing.*attribute/, "缺少必填商品属性，请检查错误代码对应的属性 ID。"],
    [/category.*(?:not found|invalid)|levels_category_not_found|description_category/, "商品类目无效或与类型不匹配，请重新选择 Ozon Seller 类目。"],
    [/type[_ ]?id|product type/, "商品类型不正确，请核对类目下允许的 type_id。"],
    [/image.*(?:download|load|fetch)|picture.*(?:download|invalid)/, "Ozon 无法下载或识别商品图片，请确认图片是公开 HTTPS 地址且格式合规。"],
    [/duplicate.*offer|offer.*already|offer_id.*exist/, "货号已存在或重复，请使用当前店铺内唯一的 offer_id。"],
    [/barcode.*(?:invalid|exist|duplicate)/, "条形码无效、重复或已被其他商品占用。"],
    [/price.*(?:invalid|minimum|maximum|too low|too high)/, "商品价格不符合 Ozon 限制，请检查售价、最低价和划线价。"],
    [/(?:weight|dimension|height|width|depth).*(?:invalid|required|limit)/, "重量或包装尺寸不符合要求，请检查单位和数值范围。"],
    [/name.*(?:invalid|required|length)|title.*(?:invalid|required|length)/, "商品标题为空、过长或包含不允许的内容。"],
    [/rich.*content|11254/, "富文本内容格式不正确，请检查富内容 JSON。"],
  ];
  const match = rules.find(([pattern]) => pattern.test(source));
  return match ? match[1] : "请根据 Ozon 原始错误检查对应字段；若错误持续，可在 Seller 后台查看该商品的审核详情。";
}

function enrichListingErrors(errors) {
  return (Array.isArray(errors) ? errors : []).map((error) => ({
    ...error,
    message_zh: error?.message_zh || translateOzonListingError(error),
  }));
}

function listingErrorSummary(errors) {
  const enriched = enrichListingErrors(errors);
  const first = enriched[0] || {};
  const readable = enriched
    .map((error) => error.message_zh || error.message || error.description || error.code || "")
    .filter(Boolean);
  return {
    errors_json: enriched,
    error_count: enriched.length,
    error_summary: readable.slice(0, 3).join("；"),
    first_error_code: first.code || "",
    first_error_message: first.message || first.description || "",
    first_error_message_zh: first.message_zh || "",
  };
}

const LISTING_STATUS_CONTRACT = ["queued", "claimed", "running", "ozon_processing", "partial_success", "success", "failed", "cancelled"];

function listingStatusToContractStatus(status, partialSuccess = false) {
  if (partialSuccess) return "partial_success";
  const value = String(status || "").trim().toLowerCase();
  const map = {
    queued: "queued",
    claimed: "claimed",
    running: "running",
    pending: "ozon_processing",
    processing: "ozon_processing",
    moderating: "ozon_processing",
    ozon_processing: "ozon_processing",
    imported: "success",
    success: "success",
    done: "success",
    failed: "failed",
    error: "failed",
    cancelled: "cancelled",
    canceled: "cancelled",
  };
  return map[value] || "ozon_processing";
}

function listingDisplayStatus(contractStatus) {
  const map = {
    queued: "处理中",
    claimed: "处理中",
    running: "处理中",
    ozon_processing: "处理中",
    partial_success: "部分成功",
    success: "已完成",
    failed: "失败",
    cancelled: "失败",
  };
  return map[contractStatus] || "处理中";
}

function listingStatusSqlCondition(status, alias, params) {
  const value = String(status || "").trim();
  if (!value || value === "all") return "";
  if (["processing", "pending", "ozon_processing"].includes(value)) return `${alias}.status IN ('queued','claimed','running','processing','pending','moderating','ozon_processing')`;
  if (value === "success") return `${alias}.status IN ('imported','success')`;
  if (value === "partial_success") return `${alias}.partial_success = TRUE`;
  if (value === "cancelled" || value === "canceled") return `${alias}.status IN ('cancelled','canceled')`;
  params.push(value);
  return `${alias}.status = $${params.length}`;
}

function batchListingPlaceholderTaskId(batchId, storeId, sku, index = 0, rowKey = "") {
  const batch = String(batchId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || crypto.randomUUID();
  const store = String(storeId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 36) || "store";
  const cleanSku = String(sku || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || `row${index}`;
  const cleanRow = String(rowKey || `row-${index}`).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || `row${index}`;
  return `batch-${batch}-${store}-${cleanRow}-${cleanSku}`.slice(0, 180);
}

app.get("/api/v1/listings/status-contract", requireAuth, async (_req, res) => {
  res.json({
    success: true,
    code: "OK",
    data: {
      statuses: LISTING_STATUS_CONTRACT,
      legacyMapping: {
        pending: "ozon_processing",
        processing: "ozon_processing",
        moderating: "ozon_processing",
        imported: "success",
        done: "success",
        error: "failed",
        canceled: "cancelled",
      },
      display: Object.fromEntries(LISTING_STATUS_CONTRACT.map((status) => [status, listingDisplayStatus(status)])),
    },
    requestId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  });
});

// v2.1.9: 上架历史列表 (含统计) - 用户在前端"上架记录"页用
app.get("/api/seller/listing-history", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const status = String(req.query.status || "").trim();   // all|imported|failed|processing|pending
    const storeId = String(req.query.store_id || "").trim();
    const sku = String(req.query.sku || "").trim();
    const startDate = String(req.query.start_date || "").trim();
    const endDate = String(req.query.end_date || "").trim();
    const limit = Math.min(parseInt(req.query.limit || "50"), 200);
    const offset = Math.max(parseInt(req.query.offset || "0"), 0);

    const conds = ["lh.user_id = $1"];
    const params = [userId];
    const statusCondition = listingStatusSqlCondition(status, "lh", params);
    if (statusCondition) conds.push(statusCondition);
    if (storeId) { params.push(storeId); conds.push(`lh.store_id = $${params.length}`); }
    if (sku) { params.push(`%${sku}%`); conds.push(`(lh.offer_id ILIKE $${params.length} OR lh.product_name ILIKE $${params.length} OR lh.task_id ILIKE $${params.length})`); }
    if (startDate) { params.push(startDate); conds.push(`lh.created_at >= $${params.length}`); }
    if (endDate) { params.push(endDate); conds.push(`lh.created_at < ($${params.length}::date + interval '1 day')`); }

    const where = conds.join(" AND ");

    // 列表 (带店铺名)
    const listParams = [...params, limit, offset];
    const listSql = `
      SELECT lh.id, lh.task_id, lh.offer_id, lh.product_name, lh.main_image, lh.price_rub,
             lh.status, lh.created_at, lh.updated_at, lh.store_id, lh.errors_json,
             lh.variants_count, lh.failed_variants_count, lh.partial_success, lh.raw_payload,
             s.name AS store_name
      FROM app_listing_history lh
      LEFT JOIN app_stores s ON s.id = lh.store_id
      WHERE ${where}
      ORDER BY lh.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

    // 总数 + KPI 统计 (一次 query 用 FILTER)
    const statsParams = [...params];
    const statsSql = `
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE lh.status IN ('imported','success')) AS imported,
        COUNT(*) FILTER (WHERE lh.status = 'failed') AS failed,
        COUNT(*) FILTER (WHERE lh.status IN ('queued','claimed','running','processing','pending','moderating','ozon_processing')) AS processing,
        COUNT(*) FILTER (WHERE lh.created_at >= CURRENT_DATE) AS today
      FROM app_listing_history lh
      WHERE ${where}`;

    const [listRes, statsRes] = await Promise.all([
      db.query(listSql, listParams),
      db.query(statsSql, statsParams),
    ]);

    const stats = statsRes.rows[0] || {};
    const successRate = Number(stats.imported || 0) + Number(stats.failed || 0) > 0
      ? Math.round((Number(stats.imported) / (Number(stats.imported) + Number(stats.failed))) * 1000) / 10
      : 0;

    res.json({
      success: true,
      items: listRes.rows.map(r => {
        const statusCanonical = listingStatusToContractStatus(r.status, r.partial_success);
        return {
          ...r,
          ...listingErrorSummary(r.errors_json),
          status_canonical: statusCanonical,
          status_display: listingDisplayStatus(statusCanonical),
        };
      }),
      status_contract: LISTING_STATUS_CONTRACT,
      total: Number(stats.total || 0),
      stats: {
        total: Number(stats.total || 0),
        imported: Number(stats.imported || 0),
        failed: Number(stats.failed || 0),
        processing: Number(stats.processing || 0),
        today: Number(stats.today || 0),
        success_rate: successRate,
      },
      limit, offset,
    });
  } catch (e) {
    console.error("[listing-history]", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/seller/listing-history/batch-start", requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ success: false, error: "服务端未配置 DATABASE_URL。" });
    const storeId = String(req.body?.store_id || req.body?.storeId || "").trim();
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!storeId) return res.status(400).json({ success: false, error: "需要店铺 ID" });
    if (!rows.length) return res.status(400).json({ success: false, error: "需要上架商品行" });
    await assertActiveStoreAccess(storeId, req.user.id, "id, name");
    const batchId = String(req.body?.batch_id || req.body?.batchId || crypto.randomUUID()).trim();
    const inserted = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i] || {};
      const sku = String(row.sku || row.source_sku || row.offer_id || "").trim();
      if (!sku) continue;
      const rowKey = String(row.row_key || row.rowKey || `row-${i + 1}`).trim();
      const taskId = batchListingPlaceholderTaskId(batchId, storeId, sku, i + 1, rowKey);
      const price = Number(row.price ?? row.price_rub ?? 0);
      const rawPayload = {
        kind: "batch-upload-placeholder",
        batch_id: batchId,
        source_sku: sku,
        row_key: rowKey,
        status_note: "等待采集，采完后自动提交 Ozon",
        created_from: "batch-start",
      };
      const result = await db.query(
        `INSERT INTO app_listing_history (
           user_id, store_id, task_id, offer_id, product_name, main_image, price_rub, status, raw_payload, errors_json
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8::jsonb,'[]'::jsonb)
         ON CONFLICT (task_id) DO UPDATE SET
           status = CASE WHEN app_listing_history.status IN ('queued','claimed','running') THEN 'queued' ELSE app_listing_history.status END,
           offer_id = EXCLUDED.offer_id,
           product_name = COALESCE(NULLIF(EXCLUDED.product_name,''), app_listing_history.product_name),
           price_rub = COALESCE(EXCLUDED.price_rub, app_listing_history.price_rub),
           raw_payload = app_listing_history.raw_payload || EXCLUDED.raw_payload,
           updated_at = now()
         RETURNING id, task_id, offer_id, status`,
        [
          req.user.id,
          storeId,
          taskId,
          String(row.offer_id || row.offerId || sku),
          String(row.name || row.product_name || `等待采集 SKU ${sku}`),
          String(row.main_image || row.image || ""),
          Number.isFinite(price) && price > 0 ? price : null,
          JSON.stringify(rawPayload),
        ],
      );
      inserted.push({ ...result.rows[0], sku, row_key: rowKey, store_id: storeId });
    }
    res.json({ success: true, batch_id: batchId, items: inserted });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/api/seller/listing-history/batch-progress", requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ success: false, error: "服务端未配置 DATABASE_URL。" });
    const placeholderTaskId = String(req.body?.placeholder_task_id || req.body?.placeholderTaskId || "").trim();
    const storeId = String(req.body?.store_id || req.body?.storeId || "").trim();
    if (!placeholderTaskId) return res.status(400).json({ success: false, error: "需要占位任务 ID" });
    if (storeId) await assertActiveStoreAccess(storeId, req.user.id, "id, name");
    const status = String(req.body?.status || "running").trim().toLowerCase();
    const allowedStatus = new Set(["queued", "claimed", "running", "failed"]);
    const nextStatus = allowedStatus.has(status) ? status : "running";
    const errorMessage = String(req.body?.error || "").trim();
    const rawPatch = req.body?.raw_payload && typeof req.body.raw_payload === "object" ? req.body.raw_payload : {};
    const errorsJson = nextStatus === "failed"
      ? JSON.stringify([{ code: "batch_upload_failed", message: errorMessage || "批量上架流程中断", message_zh: errorMessage || "批量上架流程中断" }])
      : null;
    const result = await db.query(
      `UPDATE app_listing_history
          SET status = $1,
              product_name = COALESCE(NULLIF($2,''), product_name),
              main_image = COALESCE(NULLIF($3,''), main_image),
              price_rub = COALESCE($4, price_rub),
              raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $5::jsonb,
              errors_json = COALESCE($6::jsonb, errors_json),
              updated_at = now()
        WHERE user_id = $7 AND task_id = $8
        RETURNING id, task_id, status`,
      [
        nextStatus,
        String(req.body?.product_name || req.body?.name || ""),
        String(req.body?.main_image || req.body?.image || ""),
        Number.isFinite(Number(req.body?.price_rub ?? req.body?.price)) ? Number(req.body?.price_rub ?? req.body?.price) : null,
        JSON.stringify({ ...rawPatch, batch_progress_status: nextStatus, batch_progress_at: new Date().toISOString() }),
        errorsJson,
        req.user.id,
        placeholderTaskId,
      ],
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: "未找到批量上架占位记录" });
    res.json({ success: true, item: result.rows[0] });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/api/seller/listing-history/export", requireAuth, async (req, res) => {
  try {
    const conditions = ["lh.user_id = $1"];
    const params = [req.user.id];
    const storeId = String(req.body?.store_id || "").trim();
    const status = String(req.body?.status || "").trim();
    const sku = String(req.body?.sku || "").trim();
    const startDate = String(req.body?.start_date || "").trim();
    const endDate = String(req.body?.end_date || "").trim();
    if (storeId) { params.push(storeId); conditions.push(`lh.store_id = $${params.length}`); }
    const statusCondition = listingStatusSqlCondition(status, "lh", params);
    if (statusCondition) conditions.push(statusCondition);
    if (sku) { params.push(`%${sku}%`); conditions.push(`(lh.offer_id ILIKE $${params.length} OR lh.product_name ILIKE $${params.length} OR lh.task_id ILIKE $${params.length})`); }
    if (startDate) { params.push(startDate); conditions.push(`lh.created_at >= $${params.length}`); }
    if (endDate) { params.push(endDate); conditions.push(`lh.created_at < ($${params.length}::date + interval '1 day')`); }
    const rows = await db.query(
      `SELECT lh.task_id, lh.offer_id, lh.product_name, s.name AS store_name, lh.status,
              lh.price_rub, lh.errors_json, lh.created_at, lh.updated_at
         FROM app_listing_history lh
         LEFT JOIN app_stores s ON s.id = lh.store_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY lh.created_at DESC LIMIT 5000`,
      params,
    );
    const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const header = ["任务ID", "货号", "商品标题", "店铺", "状态", "售价", "Ozon原始错误", "中文解释", "创建时间", "更新时间"];
    const lines = rows.rows.map((row) => {
      const errors = enrichListingErrors(row.errors_json);
      return [
        row.task_id, row.offer_id, row.product_name, row.store_name, row.status, row.price_rub,
        errors.map((error) => `${error.code || ""} ${error.message || error.description || ""}`.trim()).join(" | "),
        [...new Set(errors.map((error) => error.message_zh).filter(Boolean))].join(" | "),
        row.created_at?.toISOString?.() || row.created_at,
        row.updated_at?.toISOString?.() || row.updated_at,
      ].map(csvCell).join(",");
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="listing-history-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(`\ufeff${header.map(csvCell).join(",")}\n${lines.join("\n")}`);
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post("/api/seller/listing-history/:id/retry", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM app_listing_history WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [req.params.id, req.user.id],
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ success: false, error: "未找到上架记录" });
    if (!row.store_id) return res.status(409).json({ success: false, error: "历史记录缺少店铺，无法安全重试" });
    if (String(row.status) !== 'failed' && !row.partial_success) {
      return res.status(409).json({ success: false, error: "任务仍在处理中，请先同步状态" });
    }
    const raw = row.raw_payload && typeof row.raw_payload === "object" ? row.raw_payload : {};
    let endpoint;
    let payload;
    if (raw.import_mode === "sku" && raw.ozon_item) {
      endpoint = "/v1/product/import-by-sku";
      payload = { items: [raw.ozon_item] };
    } else if (raw.item) {
      endpoint = "/v3/product/import";
      payload = { items: [raw.item] };
      if (Array.isArray(raw.stocks) && raw.stocks.length) payload.stocks = raw.stocks;
    } else {
      return res.status(409).json({ success: false, error: "该历史记录没有可重试的原始商品数据" });
    }
    const data = await callOzonSellerAPI(endpoint, payload, { storeId: row.store_id, userId: req.user.id });
    const taskId = String(data?.result?.task_id || data?.task_id || "");
    if (!taskId) return res.status(502).json({ success: false, error: "Ozon 未返回新的任务 ID", payload: data });
    const retryPayload = { ...raw, retry_of: row.task_id, retried_at: new Date().toISOString() };
    const inserted = await db.query(
      `INSERT INTO app_listing_history (
         user_id, store_id, task_id, offer_id, product_name, main_image, price_rub, status, raw_payload
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'processing',$8::jsonb)
       ON CONFLICT (task_id) DO UPDATE SET updated_at = now()
       RETURNING id, task_id, status`,
      [req.user.id, row.store_id, taskId, row.offer_id, row.product_name, row.main_image, row.price_rub, JSON.stringify(retryPayload)],
    );
    res.json({ success: true, task: inserted.rows[0], data });
  } catch (error) {
    res.status(error.statusCode || 502).json({ success: false, error: error.message, payload: error.payload || null });
  }
});

// v2.1.9: 删除上架记录
app.delete("/api/seller/listing-history/:id", requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, error: "需要 id" });
    const r = await db.query(
      `DELETE FROM app_listing_history WHERE id = $1 AND user_id = $2 RETURNING task_id`,
      [id, req.user.id],
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: "未找到记录或无权删除" });
    res.json({ success: true, deleted: r.rows[0].task_id });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/seller/categories/tree", requireAuth, async (req, res, next) => {
  try {
    const storeId = req.body?.store_id || req.body?.storeId;
    const data = await callOzonSellerAPI("/v1/description-category/tree", { language: "DEFAULT" }, { storeId, userId: req.user.id });
    res.json({ success: true, data });
  } catch (error) { res.status(error.statusCode || 502).json({ success: false, error: error.message }); }
});

app.post("/api/seller/categories/attributes", requireAuth, async (req, res, next) => {
  try {
    const { category_id, type_id } = req.body;
    const storeId = req.body?.store_id || req.body?.storeId;
    const data = await callOzonSellerAPI("/v1/description-category/attribute", {
      description_category_id: Number(category_id),
      type_id: Number(type_id || 0),
      language: "DEFAULT"
    }, { storeId, userId: req.user.id });
    res.json({ success: true, data });
  } catch (error) { res.status(error.statusCode || 502).json({ success: false, error: error.message }); }
});

app.post("/api/seller/categories/attribute-values", requireAuth, async (req, res, next) => {
  try {
    const { category_id, attribute_id, query, limit = 100 } = req.body;
    const storeId = req.body?.store_id || req.body?.storeId;
    const data = await callOzonSellerAPI("/v1/description-category/attribute/values", {
      description_category_id: Number(category_id),
      attribute_id: Number(attribute_id),
      last_value_id: 0,
      limit: Number(limit),
      query: String(query || ""),
      language: "DEFAULT"
    }, { storeId, userId: req.user.id });
    res.json({ success: true, data });
  } catch (error) { res.status(error.statusCode || 502).json({ success: false, error: error.message }); }
});

app.get("/api/seller/warehouses", requireAuth, async (_req, res, next) => {
  // Ozon 的 cluster/list 和 /v1/warehouse/list 端点对该 Seller 不可用。
  // 但 /v2/posting/fbo/list 和 /v3/posting/fbs/list 返回的 posting 里有 warehouse_id + warehouse 名称。
  // 这里采用：先尝试拉一次最近订单，从结果里提取去重的 warehouse 列表。
  try {
    const now = new Date();
    const since = new Date(now.getTime() - 90 * 24 * 3600 * 1000).toISOString();
    const to = now.toISOString();
    let result = { result: [] };
    try {
      const data = await callOzonSellerAPI("/v3/posting/fbs/list", {
        filter: { since, to }, limit: 100,
      });
      const map = new Map();
      for (const p of (data?.result?.postings || [])) {
        const m = p?.delivery_method || {};
        if (m.warehouse_id) map.set(m.warehouse_id, { warehouse_id: m.warehouse_id, name: m.warehouse || ("仓库 " + m.warehouse_id) });
      }
      result = { result: Array.from(map.values()) };
    } catch (e) { /* posting 端点失败时返回空 */ }
    res.json({ success: true, data: result, note: result.result.length ? "" : "未从订单中提取到 warehouse（最近 90 天无订单）" });
  } catch (error) { res.status(error.statusCode || 502).json({ success: false, error: error.message, payload: error.payload || null }); }
});

app.post("/api/seller/products/stocks", requireAuth, async (req, res, next) => {
  try {
    const stocks = Array.isArray(req.body?.stocks) ? req.body.stocks : null;
    if (!stocks) { res.status(400).json({ success: false, error: "请求体需要 stocks 数组" }); return; }
    const errors = [];
    const normalizedStocks = stocks.map((item, index) => {
      const offerId = String(item?.offer_id || item?.sku || "").trim();
      const productId = Number(item?.product_id || 0);
      const stock = Number(item?.stock ?? item?.present ?? 0);
      const warehouseId = Number(item?.warehouse_id || 0);
      if (!offerId && !productId) errors.push(`第 ${index + 1} 行缺少 offer_id/product_id`);
      if (!Number.isFinite(stock) || stock < 0) errors.push(`第 ${index + 1} 行库存不合法`);
      if (!Number.isFinite(warehouseId) || warehouseId <= 0) errors.push(`第 ${index + 1} 行 warehouse_id 不合法`);
      return {
        ...(offerId ? { offer_id: offerId } : {}),
        ...(Number.isFinite(productId) && productId > 0 ? { product_id: productId } : {}),
        stock: Math.max(0, Math.floor(stock)),
        warehouse_id: Math.floor(warehouseId),
      };
    });
    if (errors.length) {
      res.status(400).json({ success: false, error: errors.slice(0, 5).join("；") });
      return;
    }
    const data = await callOzonSellerAPI("/v2/products/stocks", { stocks: normalizedStocks });
    res.json({ success: true, data });
  } catch (error) { res.status(error.statusCode || 502).json({ success: false, error: error.message, payload: error.payload || null }); }
});

app.get("/api/v1/ai/images/providers", requireAuth, async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    success: true,
    code: "OK",
    data: {
      defaultProvider: AI_IMAGE_PROVIDER,
      providerOrder: AI_IMAGE_PROVIDER_ORDER,
      providers: {
        agnes: { configured: Boolean(AGNES_API_KEY), model: AGNES_IMAGE_MODEL },
        tokendun: { configured: Boolean(TOKENDUN_API_KEY), model: TOKENDUN_IMAGE_MODEL },
        wanxiang: { configured: Boolean(DASHSCOPE_API_KEY), model: DASHSCOPE_IMAGE_MODEL },
        minimax: { configured: Boolean(process.env.MINIMAX_API_KEY), model: MINIMAX_IMAGE_MODEL },
      },
    },
    requestId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  });
});

async function handleAiImageGenerate(req, res, next) {
  const userKey = String(req.user.id);
  const activeCount = Number(aiImageActiveByUser.get(userKey) || 0);
  if (activeCount >= 2) {
    return res.status(429).json({ success: false, error: "同时最多生成 2 个套图任务，请等待当前任务完成" });
  }
  aiImageActiveByUser.set(userKey, activeCount + 1);
  try {
    const { prompt, image: refImage, aspectRatio = "3:4", n = 1, model: reqModel, scenePreset = "" } = req.body || {};
    const storeId = String(req.body?.store_id || req.body?.storeId || "").split(",")[0].trim();
    let storeAiModel = "";
    if (storeId && db) {
      const store = await db.query("SELECT id, ai_image_model FROM app_stores WHERE id = $1 AND user_id = $2 AND active = TRUE", [storeId, req.user.id]);
      if (!store.rowCount) return res.status(404).json({ success: false, error: "店铺不存在、已停用或无权限" });
      storeAiModel = String(store.rows[0]?.ai_image_model || "").trim();
    }
    const requestedModel = String(reqModel || storeAiModel || "").trim();
    if (!prompt) {
      res.status(400).json({ success: false, error: "需要 prompt 字段" });
      return;
    }
    const requestedN = Math.min(9, Math.max(1, Number(n) || 1));
    const normalizedPrompt = String(prompt).slice(0, 1500);
    const rawReference = Array.isArray(refImage) ? refImage[0] : refImage;
    let accessibleReference = "";
    if (rawReference) {
      const reference = String(rawReference).trim();
      const publicBaseUrl = getRequestPublicBaseUrl(req);
      accessibleReference = /^\/uploads\//i.test(reference) && publicBaseUrl ? `${publicBaseUrl}${reference}` : reference;
      if (!/^https:\/\//i.test(accessibleReference) && !/^data:image\//i.test(accessibleReference)) {
        return res.status(400).json({ success: false, error: "参考图必须是公网 HTTPS 图片或 Base64 图片" });
      }
    }

    let payload = null;
    let providerModel = "";
    const providerAttempts = [];
    const recordProviderAttempt = (provider, status, model = "", reason = "") => {
      providerAttempts.push({
        provider,
        status,
        ...(model ? { model: String(model).slice(0, 80) } : {}),
        ...(reason ? { reason: String(reason).slice(0, 500) } : {}),
      });
    };
    let remoteUrls = [];
    let generatedBuffers = [];
    let perImageCostUsd = MINIMAX_IMAGE_PER_IMAGE_USD;
    if (AI_IMAGE_PROVIDER === "agnes" && !AGNES_API_KEY) {
      recordProviderAttempt("Agnes 2.0", "skipped", AGNES_IMAGE_MODEL, "未配置 Agnes API Key");
    }
    if (AI_IMAGE_PROVIDER === "agnes" && AGNES_API_KEY) {
      try {
        providerModel = AGNES_IMAGE_MODEL;
        perImageCostUsd = AGNES_IMAGE_PER_IMAGE_USD;
        for (let index = 0; index < requestedN; index += 1) {
          const extraBody = { response_format: "url" };
          if (accessibleReference) extraBody.image = [accessibleReference];
          const response = await fetch(`${AGNES_BASE_URL}/images/generations`, {
            method: "POST",
            headers: { Authorization: `Bearer ${AGNES_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: providerModel,
              prompt: normalizedPrompt,
              size: "1K",
              ratio: ["1:1", "3:4", "9:16"].includes(aspectRatio) ? aspectRatio : "3:4",
              extra_body: extraBody,
            }),
            signal: AbortSignal.timeout(240000),
          });
          const text = await response.text();
          let imagePayload = null;
          try { imagePayload = JSON.parse(text); } catch { imagePayload = { raw: text.slice(0, 4000) }; }
          if (!response.ok || imagePayload?.error) {
            throw new Error(imagePayload?.error?.message || imagePayload?.message || `HTTP ${response.status}`);
          }
          const imageUrl = imagePayload?.data?.[0]?.url;
          const imageBase64 = imagePayload?.data?.[0]?.b64_json;
          if (imageUrl) remoteUrls.push(imageUrl);
          else if (imageBase64) generatedBuffers.push(Buffer.from(imageBase64, "base64"));
          else throw new Error("未返回图片数据");
          payload = imagePayload;
        }
        recordProviderAttempt("Agnes 2.0", "success", providerModel);
      } catch (error) {
        recordProviderAttempt("Agnes 2.0", "failed", providerModel || AGNES_IMAGE_MODEL, error.message);
        console.warn(`[AI-Images] Agnes 失败，切换 TokenDun: ${error.message}`);
        providerModel = "";
        remoteUrls = [];
        generatedBuffers = [];
      }
    }

    if (!remoteUrls.length && !generatedBuffers.length && ["tokendun", "agnes"].includes(AI_IMAGE_PROVIDER) && TOKENDUN_API_KEY) {
      try {
        providerModel = TOKENDUN_IMAGE_MODEL;
        perImageCostUsd = TOKENDUN_IMAGE_PER_IMAGE_USD;
        const sizeByRatio = { "1:1": "1024x1024", "3:4": "1024x1536", "9:16": "1024x1536" };
        let response;
        if (accessibleReference) {
          const imageResponse = await fetch(accessibleReference, { signal: AbortSignal.timeout(60000) });
          if (!imageResponse.ok) throw new Error(`参考图下载失败 HTTP ${imageResponse.status}`);
          const imageType = String(imageResponse.headers.get("content-type") || "image/png").split(";")[0];
          const form = new FormData();
          form.append("model", providerModel);
          form.append("prompt", normalizedPrompt);
          form.append("size", sizeByRatio[aspectRatio] || "1024x1536");
          form.append("quality", TOKENDUN_IMAGE_QUALITY);
          form.append("n", String(requestedN));
          form.append("image", new Blob([await imageResponse.arrayBuffer()], { type: imageType }), "reference.png");
          response = await fetch(`${TOKENDUN_BASE_URL}/images/edits`, {
            method: "POST",
            headers: { Authorization: `Bearer ${TOKENDUN_API_KEY}` },
            body: form,
            signal: AbortSignal.timeout(180000),
          });
        } else {
          response = await fetch(`${TOKENDUN_BASE_URL}/images/generations`, {
            method: "POST",
            headers: { Authorization: `Bearer ${TOKENDUN_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: providerModel,
              prompt: normalizedPrompt,
              size: sizeByRatio[aspectRatio] || "1024x1536",
              quality: TOKENDUN_IMAGE_QUALITY,
              n: requestedN,
            }),
            signal: AbortSignal.timeout(180000),
          });
        }
        const text = await response.text();
        try { payload = JSON.parse(text); } catch { payload = { raw: text.slice(0, 4000) }; }
        if (!response.ok || payload?.error) {
          throw new Error(payload?.error?.message || payload?.message || `HTTP ${response.status}`);
        }
        remoteUrls = (payload?.data || []).map((item) => item?.url).filter(Boolean);
        generatedBuffers = (payload?.data || [])
          .map((item) => item?.b64_json)
          .filter(Boolean)
          .map((value) => Buffer.from(value, "base64"));
        if (!remoteUrls.length && !generatedBuffers.length) throw new Error("未返回图片数据");
        recordProviderAttempt("TokenDun", "success", providerModel);
      } catch (error) {
        recordProviderAttempt("TokenDun", "failed", providerModel || TOKENDUN_IMAGE_MODEL, error.message);
        console.warn(`[AI-Images] TokenDun 失败，切换备用供应商: ${error.message}`);
        providerModel = "";
        remoteUrls = [];
        generatedBuffers = [];
      }
    }

    if (!remoteUrls.length && !generatedBuffers.length && accessibleReference) {
      if (DASHSCOPE_API_KEY) {
        try {
          providerModel = requestedModel && /^wan/i.test(String(requestedModel)) ? String(requestedModel) : DASHSCOPE_IMAGE_MODEL;
          perImageCostUsd = DASHSCOPE_IMAGE_PER_IMAGE_USD;
          const sizeByRatio = { "1:1": "1280*1280", "3:4": "960*1280", "9:16": "720*1280" };
          for (let remaining = requestedN; remaining > 0; remaining -= 4) {
            const batchSize = Math.min(4, remaining);
            const response = await fetch(`${DASHSCOPE_BASE_URL}/services/aigc/multimodal-generation/generation`, {
              method: "POST",
              headers: { Authorization: `Bearer ${DASHSCOPE_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                model: providerModel,
                input: { messages: [{ role: "user", content: [{ image: accessibleReference }, { text: normalizedPrompt }] }] },
                parameters: {
                  size: sizeByRatio[aspectRatio] || "960*1280",
                  n: batchSize,
                  enable_interleave: false,
                  prompt_extend: false,
                  watermark: false,
                },
              }),
              signal: AbortSignal.timeout(180000),
            });
            const text = await response.text();
            let batchPayload = null;
            try { batchPayload = JSON.parse(text); } catch { batchPayload = { raw: text.slice(0, 4000) }; }
            payload = batchPayload;
            const batchUrls = (batchPayload?.output?.choices || [])
              .flatMap((choice) => choice?.message?.content || [])
              .map((item) => item?.image)
              .filter(Boolean);
            if (!response.ok || !batchUrls.length) {
              const detail = batchPayload?.message || batchPayload?.code || batchPayload?.output?.message || text.slice(0, 500);
              throw new Error(`万相图像编辑失败：${detail}`);
            }
            remoteUrls.push(...batchUrls);
          }
          recordProviderAttempt("万相", "success", providerModel);
        } catch (error) {
          recordProviderAttempt("万相", "failed", providerModel || DASHSCOPE_IMAGE_MODEL, error.message);
          console.warn(`[AI-Images] 万相失败，切换 MiniMax: ${error.message}`);
          providerModel = "";
          remoteUrls = [];
          generatedBuffers = [];
        }
      } else {
        recordProviderAttempt("万相", "skipped", DASHSCOPE_IMAGE_MODEL, "未配置 DASHSCOPE_API_KEY");
        console.warn("[AI-Images] 未配置 DASHSCOPE_API_KEY，跳过万相并切换 MiniMax");
      }
    }

    if (!remoteUrls.length && !generatedBuffers.length) {
      const apiKey = process.env.MINIMAX_API_KEY;
      if (!apiKey) {
        recordProviderAttempt("MiniMax", "skipped", requestedModel || MINIMAX_IMAGE_MODEL, "未配置 MINIMAX_API_KEY");
        return res.status(503).json({ success: false, error: "未配置 MINIMAX_API_KEY", usage: { providerAttempts } });
      }
      providerModel = requestedModel || MINIMAX_IMAGE_MODEL;
      const body = {
        model: providerModel,
        prompt: normalizedPrompt,
        n: requestedN,
        aspect_ratio: aspectRatio,
        response_format: "url",
        prompt_optimizer: true,
      };
      const response = await fetch(`${MINIMAX_BASE_URL}/image_generation`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000),
      });
      const text = await response.text();
      try { payload = JSON.parse(text); } catch { payload = { raw: text.slice(0, 4000) }; }
      const businessCode = Number(payload?.base_resp?.status_code || 0);
      if (!response.ok || businessCode !== 0) {
        const detail = payload?.base_resp?.status_msg || text.slice(0, 500);
        throw new Error(`MiniMax 图片生成失败：${detail}`);
      }
      remoteUrls = payload?.data?.image_urls || [];
      recordProviderAttempt("MiniMax", "success", providerModel);
    }
    if (!remoteUrls.length && !generatedBuffers.length) {
      return res.status(502).json({ success: false, error: "图片服务未返回生成结果，请稍后重试", payload, usage: { providerAttempts } });
    }
    const urls = [];
    const uploadsDir = await ensureUploadDir();
    for (const remoteUrl of remoteUrls) {
      try {
        const imageResponse = await fetch(remoteUrl);
        if (!imageResponse.ok) throw new Error(`HTTP ${imageResponse.status}`);
        const contentType = String(imageResponse.headers.get("content-type") || "image/jpeg");
        const extension = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
        const filename = `ai-${crypto.randomUUID()}.${extension}`;
        await fs.writeFile(path.join(uploadsDir, filename), Buffer.from(await imageResponse.arrayBuffer()));
        urls.push(`/uploads/${filename}`);
      } catch (error) {
        throw new Error(`生成图永久保存失败：${error.message}`);
      }
    }
    for (const buffer of generatedBuffers) {
      const filename = `ai-${crypto.randomUUID()}.png`;
      await fs.writeFile(path.join(uploadsDir, filename), buffer);
      urls.push(`/uploads/${filename}`);
    }
    const estimatedCostUsd = Number((urls.length * perImageCostUsd).toFixed(6));
    const usage = {
      model: providerModel,
      providerAttempts,
      promptTokens: (payload?.usage?.prompt_tokens || 0),
      totalTokens: (payload?.usage?.total_tokens || 0),
      images: urls.length,
      estimatedCostUsd,
    };

    // 写入历史（如果 DB 可用 + 用户已登录）
    let recordId = null;
    if (db && req.user?.id) {
      try {
        const r = await db.query(
          `INSERT INTO ai_image_records (user_id, store_id, model, prompt, aspect_ratio, n, has_ref_image, image_urls, estimated_cost_usd, scene_preset)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING id`,
          [
            req.user.id,
            storeId || null,
            providerModel,
            normalizedPrompt,
            aspectRatio,
            urls.length,
            Boolean(accessibleReference),
            JSON.stringify(urls),
            estimatedCostUsd,
            String(scenePreset || "").slice(0, 40),
          ],
        );
        recordId = r.rows[0]?.id || null;
      } catch (e) {
        // 记录失败不影响返回结果
        console.error("[ai-image-records] 写入失败：", e.message);
      }
    }

    res.json({
      success: true,
      data: { images: urls, prompt: normalizedPrompt, aspectRatio, n: urls.length, hasRefImage: Boolean(accessibleReference), recordId },
      usage,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    const remaining = Number(aiImageActiveByUser.get(userKey) || 1) - 1;
    if (remaining > 0) aiImageActiveByUser.set(userKey, remaining);
    else aiImageActiveByUser.delete(userKey);
  }
}

app.post("/api/seller/images/generate", requireAuth, handleAiImageGenerate);
app.post("/api/v1/ai/images/generate", requireAuth, handleAiImageGenerate);

app.post("/api/seller/images/publish-to-ozon", requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const userId = req.user.id;
    const storeId = String(req.body?.store_id || req.body?.storeId || "").trim();
    const offerId = String(req.body?.offer_id || "").trim();
    const recordId = String(req.body?.record_id || "").trim();
    const publishMode = req.body?.mode === "replace" ? "replace" : "append";
    const inputImages = Array.isArray(req.body?.images) ? req.body.images : [];
    if (!storeId || !offerId) return res.status(400).json({ success: false, error: "缺少店铺或商品货号" });
    if (!inputImages.length || inputImages.length > 15) {
      return res.status(400).json({ success: false, error: "请选择 1-15 张图片" });
    }

    const productResult = await db.query(
      `SELECT offer_id, product_id, image, images
         FROM app_products
        WHERE user_id = $1 AND store_id = $2 AND offer_id = $3
        LIMIT 1`,
      [userId, storeId, offerId],
    );
    const product = productResult.rows[0];
    if (!product) return res.status(404).json({ success: false, error: "当前店铺未找到该货号，请先同步商品" });

    const publicBaseUrl = getRequestPublicBaseUrl(req);
    const images = normalizeImportImageList(inputImages.map((value) => {
      const image = String(value || "").trim();
      if (/^\/uploads\//i.test(image)) return publicBaseUrl ? `${publicBaseUrl}${image}` : image;
      return image;
    })).filter((image) => /^https:\/\//i.test(image));
    if (!images.length) return res.status(400).json({ success: false, error: "图片必须是可供 Ozon 下载的 HTTPS 地址" });

    let productId = Number(product.product_id || 0);
    if (!productId) {
      const info = await callOzonSellerAPI(
        "/v3/product/info/list",
        { offer_id: [offerId] },
        { storeId, userId },
      );
      productId = Number((info?.items || [])[0]?.id || 0);
    }
    if (!productId) return res.status(409).json({ success: false, error: "Ozon 商品尚未生成 product_id，请稍后同步后重试" });

    const existingImages = normalizeImportImageList([
      product.image,
      ...(Array.isArray(product.images) ? product.images : []),
    ]);
    const publishImages = publishMode === "replace"
      ? images
      : normalizeImportImageList([...existingImages, ...images]).slice(0, 15);
    const data = await callOzonSellerAPI(
      "/v1/product/pictures/import",
      { product_id: productId, images: publishImages },
      { storeId, userId },
    );
    await db.query(
      `UPDATE app_products
          SET product_id = $1, image = $2, images = $3::jsonb, updated_at = now()
        WHERE user_id = $4 AND store_id = $5 AND offer_id = $6`,
      [productId, publishImages[0], JSON.stringify(publishImages), userId, storeId, offerId],
    );
    if (recordId) {
      await db.query(
        `UPDATE ai_image_records SET offer_id = $1, ozon_sync_status = TRUE, ozon_synced_at = now()
         WHERE id = $2 AND user_id = $3 AND (store_id IS NULL OR store_id = $4)`,
        [offerId, recordId, userId, storeId],
      );
    }
    res.json({ success: true, product_id: productId, offer_id: offerId, images: publishImages, added_count: images.length, count: publishImages.length, mode: publishMode, data });
  } catch (error) {
    res.status(error.statusCode || 502).json({ success: false, error: error.message, payload: error.payload || null });
  }
});

// ---------- 万相 2.7 图像编辑（替代 MiniMax 图生图）----------
app.post("/api/seller/images/wanx-edit", requireAuth, async (req, res, next) => {
  try {
    if (!DASHSCOPE_API_KEY) {
      res.status(503).json({ success: false, error: "未配置 DASHSCOPE_API_KEY" });
      return;
    }
    const { prompt, image: refImage, n = 1, scenePreset = "" } = req.body || {};
    if (!prompt) {
      res.status(400).json({ success: false, error: "需要 prompt 字段" });
      return;
    }
    const requestedN = Math.min(4, Math.max(1, Number(n) || 1));

    // 构建消息：图生图模式有参考图，否则纯文生图
    const content = [{ text: String(prompt).slice(0, 1500) }];
    if (Array.isArray(refImage) && refImage.length && refImage[0]) {
      content.push({ image: String(refImage[0]) });
    } else if (typeof refImage === "string" && refImage) {
      content.push({ image: refImage });
    }

    const body = {
      model: "wan2.7-image",
      input: { messages: [{ role: "user", content }] },
      parameters: { n: requestedN, size: "2K" },
    };

    const t0 = Date.now();
    const response = await fetch(`${DASHSCOPE_BASE_URL}/services/aigc/multimodal-generation/generation`, {
      method: "POST",
      headers: { Authorization: `Bearer ${DASHSCOPE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch { payload = { raw: text.slice(0, 4000) }; }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    if (!response.ok) {
      res.status(response.status || 502).json({ success: false, error: `万相 ${response.status}：${text.slice(0, 500)}`, payload });
      return;
    }

    const urls = [];
    const choices = payload?.output?.choices || [];
    for (const choice of choices) {
      for (const c of (choice?.message?.content || [])) {
        if (c.type === "image" && c.image) urls.push(c.image);
      }
    }

    const costPerImage = 0.20;
    const costCny = +(urls.length * costPerImage).toFixed(2);

    let recordId = null;
    if (db && req.user?.id) {
      try {
        const r = await db.query(
          `INSERT INTO ai_image_records (user_id, model, prompt, aspect_ratio, n, has_ref_image, image_urls, estimated_cost_usd, scene_preset)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING id`,
          [req.user.id, "wan2.7-image", String(prompt).slice(0, 2000), "1:1", requestedN, Boolean(refImage), JSON.stringify(urls), costCny, String(scenePreset || "").slice(0, 40)],
        );
        recordId = r.rows[0]?.id || null;
      } catch (e) { console.error("[wanx-record] write failed:", e.message); }
    }

    res.json({
      success: true,
      data: { images: urls, prompt: String(prompt).slice(0, 1500), n: requestedN, hasRefImage: Boolean(refImage), recordId },
      usage: { model: "wan2.7-image", images: urls.length, costCny, elapsed },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- 新增：AI 商品分析接口 (Step 1) ---
/* ============================================================
   AI 逻辑增强 - 支持中文输入与提示词分析
   ============================================================ */

app.post("/api/seller/products/analyze", requireAuth, async (req, res) => {
  try {
    const { name, title_zh } = req.body;
    const input = title_zh || name;
    if (!input) return res.status(400).json({ success: false, error: "缺少输入文本" });

    const prompt = `任务：分析商品标题，提取卖点并生成 Ozon SEO 俄语标题。输入：${input}。要求：1. 提取 3-5 个核心卖点（俄语）。2. 生成符合 Ozon 规范的俄语标题。3. 生成生图英文描述。格式JSON: {"selling_points": [], "title_ru": "", "image_prompt": ""}`;

    const response = await fetch(`${MINIMAX_BASE_URL}/text_generation`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.MINIMAX_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MINIMAX_MODEL,
        messages: [{ role: "user", content: prompt }]
      })
    });
    
    const payload = await response.json();
    const resultText = payload.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(resultText.replace(/```json|```/g, "").trim());
    res.json({ success: true, data: parsed });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// v2.1.10: 按 description_category_id 推荐这家店所有出现过的 (type_id, category_name)
//   解决 Ozon 公开 API + SW 公开页都无法直接拿 type_id 的问题.
//   app_products 表里 sync-all 已存了所有商品的 (description_category_id, type_id,
//   category_name). 这个端点返回所有去重的 (type_id, category_name) 让前端做下拉.
app.post("/api/seller/type-id-suggestion", requireAuth, async (req, res, next) => {
  try {
    const { description_category_id, category_id } = req.body || {};
    const storeId = req.body?.store_id || req.body?.storeId;
    const cat = Number(description_category_id || category_id);
    if (!db) return res.json({ success: false, type_id: 0, candidates: [], error: "DB 不可用" });

    let rows = [];
    if (cat) {
      // 优先: 这个店铺这个类目下所有出现过的 (type_id, category_name)
      const r = await db.query(
        `SELECT type_id, category_name, COUNT(*) AS c, MAX(updated_at) AS last_used
           FROM app_products
          WHERE user_id = $1 AND store_id = $2
            AND description_category_id = $3
            AND type_id IS NOT NULL AND type_id > 0
          GROUP BY type_id, category_name
          ORDER BY c DESC, last_used DESC
          LIMIT 20`,
        [req.user.id, storeId, cat]
      );
      rows = r.rows || [];
    }
    // 兜底: 整个店铺最近用的 type_id (按 updated_at desc), 不限类目
    if (!rows.length) {
      const r = await db.query(
        `SELECT type_id, category_name, COUNT(*) AS c, MAX(updated_at) AS last_used
           FROM app_products
          WHERE user_id = $1 AND store_id = $2
            AND type_id IS NOT NULL AND type_id > 0
          GROUP BY type_id, category_name
          ORDER BY last_used DESC
          LIMIT 20`,
        [req.user.id, storeId]
      );
      rows = r.rows || [];
    }
    const candidates = rows.map(r => ({ type_id: Number(r.type_id), name: r.category_name || "" }));
    return res.json({
      success: true,
      candidates,
      recommended: candidates[0]?.type_id || 0,
      source: candidates.length ? "store-history" : "no-history",
    });
  } catch (error) {
    res.status(error.statusCode || 502).json({ success: false, error: error.message });
  }
});

/**
 * v2.2.9: 类目下所有 type_id 列表 (从 Ozon /v1/description-category/tree 直接拿)
 *   入参: { description_category_id: 5位 OR 8位, store_id }
 *   出参: { types: [{type_id, type_name}], count }
 *   这个 endpoint 是 type_id 推断的"真相来源" - 直接调 Ozon, 不依赖历史
 */
app.post("/api/seller/description-category-types", requireAuth, async (req, res, next) => {
  try {
    const catId = Number(req.body?.description_category_id || req.body?.cat_id || 0);
    const storeId = req.body?.store_id || req.body?.storeId;
    if (!catId) return res.status(400).json({ success: false, error: "需要 description_category_id" });
    if (!storeId) return res.status(400).json({ success: false, error: "需要 store_id" });

    // v2.2.9: 直接调 Ozon /v1/description-category/tree (拿这个 cat 下的所有 type_id)
    //   这个 endpoint 返回 全部 leaf cat + 它们的 type_ids, 我们 walk 找到 catId 那一支
    const tree = await getCategoryTreeForStore(storeId, req.user.id);
    const findTypes = (nodes) => {
      for (const n of nodes || []) {
        if (Number(n.description_category_id) === catId) {
          return (n.children || []).map(c => ({
            type_id: Number(c.type_id),
            type_name: c.type_name || c.category_name || "",
            disabled: c.disabled || false,
          })).filter(t => t.type_id);
        }
        const sub = findTypes(n.children || []);
        if (sub.length) return sub;
      }
      return [];
    };
    const types = findTypes(tree);
    res.json({ success: true, types, count: types.length, source: "ozon-tree" });
  } catch (error) {
    console.error("[description-category-types]", error.message);
    res.status(error.statusCode || 502).json({ success: false, error: error.message });
  }
});

// v2.2.9: 缓存 (跟 categoryTreeCache 分开, 因为这个是商家级别全 tree, 不是 valid 子集)
const ozonCategoryTreeCache = new Map();  // storeId -> { tree, fetchedAt }
async function getCategoryTreeForStore(storeId, userId) {
  if (!storeId || !userId) return [];
  const cached = ozonCategoryTreeCache.get(storeId);
  if (cached && Date.now() - cached.fetchedAt < CATEGORY_TTL_MS) return cached.tree;
  const data = await callOzonSellerAPI("/v1/description-category/tree", { language: "DEFAULT" }, { storeId, userId });
  const tree = data?.result || [];
  ozonCategoryTreeCache.set(storeId, { tree, fetchedAt: Date.now() });
  return tree;
}

async function findCategoryByTypeId(storeId, userId, typeId) {
  const wanted = Number(typeId || 0);
  if (!wanted) return null;
  const tree = await getCategoryTreeForStore(storeId, userId);
  let found = null;
  const walk = (nodes, parentCat = null, breadcrumb = []) => {
    if (found) return;
    for (const n of nodes || []) {
      const catId = Number(n.description_category_id || 0);
      const type = Number(n.type_id || 0);
      const name = n.category_name || n.type_name || "";
      const currentParent = catId ? { id: catId, name } : parentCat;
      if (type === wanted && parentCat?.id) {
        found = {
          description_category_id: Number(parentCat.id),
          type_id: wanted,
          type_name: name,
          category_name: parentCat.name || "",
          breadcrumb: [...breadcrumb, name].filter(Boolean).join(" › "),
        };
        return;
      }
      walk(n.children || [], currentParent, [...breadcrumb, name]);
      if (found) return;
    }
  };
  walk(tree, null, []);
  return found;
}

// ========== v0.6.2: 类目树缓存 + 校验 + 后台 polling ==========
const categoryTreeCache = new Map();   // storeId -> { validIds: Set<number>, nameById: Map<number,string>, fetchedAt: number }
const CATEGORY_TTL_MS = 24 * 3600 * 1000;

async function getValidCategoryIds(storeId, userId) {
  if (!storeId || !userId) return null;
  const cached = categoryTreeCache.get(storeId);
  if (cached && (Date.now() - cached.fetchedAt) < CATEGORY_TTL_MS) return cached.validIds;
  // 缓存命中但只有 validIds (旧格式), 触发一次 refresh 重建带 name 的新缓存
  if (cached && !cached.nameById) {
    // fall through, 走下面的 rebuild
  }
  try {
    const data = await callOzonSellerAPI("/v1/description-category/tree", { language: "DEFAULT" }, { storeId, userId });
    const validIds = new Set();
    const nameById = new Map();
    const walk = (items) => {
      for (const it of (items || [])) {
        const cid = Number(it.description_category_id || 0);
        if (cid > 0) {
          validIds.add(cid);
          if (it.category_name) nameById.set(cid, it.category_name);
        }
        if (Array.isArray(it.children) && it.children.length) walk(it.children);
      }
    };
    walk(data?.result);
    categoryTreeCache.set(storeId, { validIds, nameById, fetchedAt: Date.now() });
    console.log(`[category-cache] store=${storeId} loaded ${validIds.size} categories (${nameById.size} with names)`);
    return validIds;
  } catch (e) {
    console.warn(`[category-cache] load failed store=${storeId}:`, e.message);
    return cached?.validIds || null;  // 失败时用旧缓存, 不阻塞上传
  }
}

// 给定店铺 + id, 返回类目名 (从 tree cache). 找不到返回 null.
function getCategoryName(storeId, id) {
  const c = categoryTreeCache.get(storeId);
  return c?.nameById?.get(Number(id)) || null;
}

// 失效某个店铺的类目缓存 (供 refresh 接口用)
function invalidateCategoryCache(storeId) {
  if (storeId) categoryTreeCache.delete(storeId);
  else categoryTreeCache.clear();
}

async function applyListingStocksAfterImport(row) {
  if (!db || !row?.task_id || !row?.user_id) return { skipped: true, reason: "missing_context" };
  const raw = row.raw_payload && typeof row.raw_payload === "object" ? row.raw_payload : {};
  if (raw.stock_applied_at) return { skipped: true, reason: "already_applied" };
  const item = raw.item && typeof raw.item === "object" ? raw.item : {};
  const fallbackStock = Number(item._stock ?? item.stock ?? item.default_stock ?? 0);
  const fallbackWarehouseId = Number(item._warehouse_id ?? item.warehouse_id ?? 0);
  const fallbackStocks = fallbackStock > 0 && fallbackWarehouseId > 0 && (row.offer_id || item.offer_id)
    ? [{ offer_id: row.offer_id || item.offer_id, stock: fallbackStock, warehouse_id: fallbackWarehouseId }]
    : [];
  const stocks = Array.isArray(raw.stocks) && raw.stocks.length ? raw.stocks : fallbackStocks;
  const requestedStocks = stocks
    .filter(s => s && s.offer_id && Number(s.stock ?? s.stocks) >= 0)
    .map(s => ({
      offer_id: String(s.offer_id),
      stock: parseInt(s.stock ?? s.stocks, 10),
      ...(Number(s.warehouse_id) > 0 ? { warehouse_id: Number(s.warehouse_id) } : {}),
    }))
    .filter(s => Number.isFinite(s.stock) && s.stock >= 0);
  const normalizedStocks = await normalizeStocksForStore(requestedStocks, row.store_id, row.user_id);

  if (!normalizedStocks.length) return { skipped: true, reason: "no_valid_stocks" };

  try {
    let productId = Number(raw.product_id || raw.ozon_product_id || 0);
    if (!productId) {
      const info = await callOzonSellerAPI("/v3/product/info/list", { offer_id: [String(row.offer_id || item.offer_id)] }, { storeId: row.store_id, userId: row.user_id });
      productId = Number((info?.items || [])[0]?.id || 0);
    }
    const stocksPayload = normalizedStocks.map(s => ({
      ...s,
      ...(productId > 0 ? { product_id: productId } : {}),
    }));
    const data = await callOzonSellerAPI("/v2/products/stocks", { stocks: stocksPayload }, { storeId: row.store_id, userId: row.user_id });
    const stockResults = Array.isArray(data?.result) ? data.result : [];
    const failedStock = stockResults.find(r => r?.updated === false || (Array.isArray(r?.errors) && r.errors.length));
    if (failedStock) {
      const err = Array.isArray(failedStock.errors) && failedStock.errors[0]
        ? `${failedStock.errors[0].code || "stock_update_failed"}: ${failedStock.errors[0].message || ""}`.trim()
        : "stock_update_failed";
      throw new Error(err);
    }
    await db.query(
      `UPDATE app_listing_history
          SET raw_payload = jsonb_set(
                jsonb_set(
                  jsonb_set(
                    jsonb_set(COALESCE(raw_payload, '{}'::jsonb), '{stock_applied_at}', to_jsonb(now()::text), true),
                    '{stocks}', $3::jsonb, true
                  ),
                  '{stock_apply_response}', $4::jsonb, true
                ),
                '{product_id}', to_jsonb($5::bigint), true
              ),
              updated_at = now()
        WHERE task_id = $1 AND user_id = $2`,
      [String(row.task_id), row.user_id, JSON.stringify(stocksPayload), JSON.stringify(data || {}), productId || 0],
    );
    console.log(`[listing-stocks] task=${row.task_id} product=${productId || "(unknown)"} applied stocks=${stocksPayload.length}`);
    return { applied: true, data, count: normalizedStocks.length };
  } catch (e) {
    await db.query(
      `UPDATE app_listing_history
          SET raw_payload = jsonb_set(COALESCE(raw_payload, '{}'::jsonb), '{stock_apply_error}', to_jsonb($1::text), true),
              updated_at = now()
        WHERE task_id = $2 AND user_id = $3`,
      [String(e.message || e), String(row.task_id), row.user_id],
    );
    console.warn(`[listing-stocks] task=${row.task_id} apply failed:`, e.message || e);
    return { applied: false, error: e.message || String(e) };
  }
}

async function applyListingPicturesAfterImport(row) {
  if (!db || !row?.task_id || !row?.user_id || !row?.offer_id) return { skipped: true, reason: "missing_context" };
  const raw = row.raw_payload && typeof row.raw_payload === "object" ? row.raw_payload : {};
  if (raw.picture_applied_at) return { skipped: true, reason: "already_applied" };

  const item = raw.item && typeof raw.item === "object" ? raw.item : {};
  const sourceItem = raw.source_item && typeof raw.source_item === "object" ? raw.source_item : {};
  const itemImages = Array.isArray(item.images) ? item.images : [];
  const itemHasUploads = itemImages.some(u => typeof u === "string" && /\/uploads\//i.test(u));
  const images = normalizeImportImageList(itemHasUploads
    ? itemImages
    : [
        ...extractSourceVariantImages(sourceItem),
        ...(Array.isArray(sourceItem.images) ? sourceItem.images : []),
        ...itemImages,
        row.main_image || item.primary_image || sourceItem.primary_image || "",
      ]);

  if (!images.length) return { skipped: true, reason: "no_images" };

  try {
    let productId = Number(raw.product_id || raw.ozon_product_id || 0);
    if (!productId) {
      const info = await callOzonSellerAPI("/v3/product/info/list", { offer_id: [String(row.offer_id)] }, { storeId: row.store_id, userId: row.user_id });
      productId = Number((info?.items || [])[0]?.id || 0);
    }
    if (!productId) return { skipped: true, reason: "product_id_not_ready" };

    const data = await callOzonSellerAPI("/v1/product/pictures/import", { product_id: productId, images }, { storeId: row.store_id, userId: row.user_id });
    await db.query(
      `UPDATE app_listing_history
          SET raw_payload = jsonb_set(
                jsonb_set(COALESCE(raw_payload, '{}'::jsonb), '{picture_applied_at}', to_jsonb(now()::text), true),
                '{product_id}', to_jsonb($1::bigint), true
              ),
              updated_at = now()
        WHERE task_id = $2 AND user_id = $3`,
      [productId, String(row.task_id), row.user_id],
    );
    console.log(`[listing-pictures] task=${row.task_id} product=${productId} applied images=${images.length}`);
    return { applied: true, productId, data, count: images.length };
  } catch (e) {
    await db.query(
      `UPDATE app_listing_history
          SET raw_payload = jsonb_set(COALESCE(raw_payload, '{}'::jsonb), '{picture_apply_error}', to_jsonb($1::text), true),
              updated_at = now()
        WHERE task_id = $2 AND user_id = $3`,
      [String(e.message || e), String(row.task_id), row.user_id],
    );
    console.warn(`[listing-pictures] task=${row.task_id} apply failed:`, e.message || e);
    return { applied: false, error: e.message || String(e) };
  }
}

function normalizeOzonAttributeForUpdate(attr) {
  const id = Number(attr?.id ?? attr?.attribute_id);
  if (!Number.isFinite(id) || id <= 0) return null;

  const rawValues = Array.isArray(attr.values)
    ? attr.values
    : (attr.value !== undefined && attr.value !== null ? [{ value: attr.value, dictionary_value_id: attr.dictionary_value_id }] : []);
  const values = rawValues
    .map(v => {
      const out = {};
      let value = v?.value ?? v?.name ?? v;
      if (id === 11254 && typeof value === "string") {
        value = normalizeOzonRichContentForSubmit(value);
      }
      const dictId = Number(v?.dictionary_value_id ?? v?.dictionaryValueId ?? 0);
      if (dictId > 0) out.dictionary_value_id = dictId;
      if (value !== undefined && value !== null && String(value).trim() !== "") out.value = String(value).trim();
      return out;
    })
    .filter(v => Object.keys(v).length > 0);

  if (!values.length) return null;
  return {
    id,
    ...(Number(attr?.complex_id) > 0 ? { complex_id: Number(attr.complex_id) } : {}),
    values,
  };
}

function getAttrRawValue(attr) {
  if (!attr || typeof attr !== "object") return "";
  if (attr.value !== undefined && attr.value !== null) return String(attr.value).trim();
  if (Array.isArray(attr.collection)) return attr.collection.map(v => String(v || "").trim()).filter(Boolean);
  if (Array.isArray(attr.values)) {
    const values = attr.values
      .map(v => (v && typeof v === "object") ? (v.value ?? v.name ?? v.text ?? "") : v)
      .map(v => String(v || "").trim())
      .filter(Boolean);
    return values.length > 1 ? values : (values[0] || "");
  }
  return "";
}

function sourceVariantAttributesToImportAttrs(sourceVariant) {
  const attrs = Array.isArray(sourceVariant?.attributes) ? sourceVariant.attributes : [];
  const out = [];
  for (const attr of attrs) {
    const id = Number(attr?.id ?? attr?.attribute_id ?? attr?.key);
    if (!Number.isFinite(id) || id <= 0) continue;
    // 4194/4195 are Ozon image attributes. We submit media through images /
    // pictures/import; sending these attributes too makes Ozon reject as duplicate.
    if (id === 4194 || id === 4195) continue;
    const dictValues = Array.isArray(attr.values)
      ? attr.values
          .map(v => {
            const value = (v && typeof v === "object") ? (v.value ?? v.name ?? v.text ?? "") : v;
            const dictId = Number(v?.dictionary_value_id ?? v?.dictionaryValueId ?? 0);
            if (value === undefined || value === null || String(value).trim() === "") return null;
            return {
              value: String(value).trim(),
              ...(dictId > 0 ? { dictionary_value_id: dictId } : {}),
            };
          })
          .filter(Boolean)
      : [];
    const raw = dictValues.length ? "" : getAttrRawValue(attr);
    const rawValues = dictValues.length ? [] : (Array.isArray(raw) ? raw : (raw ? [raw] : []));
    if (!dictValues.length && !rawValues.length) continue;
    out.push({
      id,
      ...(Number(attr?.complex_id) > 0 ? { complex_id: Number(attr.complex_id) } : {}),
      values: dictValues.length ? dictValues : rawValues.map(value => {
        const v = { value: String(value) };
        const dictId = Number(attr?.dictionary_value_id ?? attr?.dictionaryValueId ?? 0);
        if (dictId > 0 && rawValues.length === 1) v.dictionary_value_id = dictId;
        return v;
      }),
    });
  }
  return out;
}

function isBrandAttributeId(value) {
  return Number(value) === 85;
}

function stripBrandAttributes(attributes) {
  if (!Array.isArray(attributes)) return [];
  return attributes.filter((attr) => {
    const id = Number(attr?.id ?? attr?.attribute_id ?? attr?.key);
    return !isBrandAttributeId(id);
  });
}

function extractSourceVariantImages(sourceVariant) {
  const attrs = Array.isArray(sourceVariant?.attributes) ? sourceVariant.attributes : [];
  const images = [];
  const push = (u) => {
    if (typeof u === "string" && /^https?:\/\//i.test(u) && !images.includes(u)) images.push(u);
  };
  const primary = attrs.find(a => String(a?.key ?? a?.id ?? a?.attribute_id) === "4194");
  const gallery = attrs.find(a => String(a?.key ?? a?.id ?? a?.attribute_id) === "4195");
  const primaryValue = getAttrRawValue(primary);
  if (typeof primaryValue === "string") push(primaryValue);
  const galleryValue = getAttrRawValue(gallery);
  for (const u of (Array.isArray(galleryValue) ? galleryValue : [galleryValue])) push(u);
  push(sourceVariant?.primary_image);
  push(sourceVariant?.image);
  for (const u of (Array.isArray(sourceVariant?.images) ? sourceVariant.images : [])) push(typeof u === "string" ? u : (u?.file_name || u?.url));
  return images;
}

function normalizeImportImageList(images) {
  const normalized = [];
  const seen = new Set();
  for (const raw of (Array.isArray(images) ? images : [])) {
    const url = normalizeImportImageUrl(raw);
    if (!url) continue;
    const key = canonicalImportImageKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(url);
    if (normalized.length >= 15) break;
  }
  return normalized;
}

function normalizeImportImageUrl(raw) {
  let u = typeof raw === "string" ? raw : (raw?.file_name || raw?.url || raw?.src || raw?.image || "");
  if (typeof u !== "string") return "";
  u = u.trim()
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
  if (u.startsWith("//")) u = `https:${u}`;
  if (!/^https?:\/\//i.test(u)) return "";
  try {
    const parsed = new URL(u);
    parsed.hash = "";
    parsed.search = "";
    if (/^\/uploads\/[^/]+\.(?:jpg|jpeg|png|webp)$/i.test(parsed.pathname)) {
      return parsed.toString();
    }
    if (!/(ozone\.ru|ozonru\.cn|ozonusercontent\.com)/i.test(parsed.hostname)) return "";
    if (/(payments-cdn|marketing-api|seller-edu|cdn-cgi|static|assets|banner|promo|advert|logo|sprite|icon|avatar|placeholder|transparent|empty)/i.test(u)) return "";
    if (/\.(svg|gif)(?:[?#]|$)/i.test(u)) return "";
    if (/\/s3\/(?:cms|rp-photo|cdn-cgi|certificate|payments-cdn|marketing-api)\//i.test(parsed.pathname)) return "";
    if (/(banner|promo|advert|avatar|review|feedback)/i.test(u)) return "";
    if (/(logo|sprite|icon|avatar|placeholder|transparent|empty)/i.test(u)) return "";
    return parsed.toString();
  } catch {
    return u.split(/[?#]/)[0];
  }
}

function pickSourceRichContent(...sources) {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const key of ["richContent", "rich_content", "richAnnotationJson", "jsonRichContent"]) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    const attrs = Array.isArray(source.attributes) ? source.attributes : [];
    for (const attr of attrs) {
      const id = String(attr?.id ?? attr?.attribute_id ?? attr?.key ?? "");
      if (id !== "11254") continue;
      const value = getAttrRawValue(attr);
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return "";
}

function normalizeOzonRichContentForSubmit(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return "";
  let doc = null;
  try { doc = JSON.parse(text); } catch { return text; }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.content)) return text;

  const widgets = doc.content.filter(w => w && typeof w === "object");
  const allShowcase = widgets.length > 0 && widgets.every(w => String(w.widgetName || "") === "raShowcase");
  if (!allShowcase) return text;

  const urls = [];
  const seen = new Set();
  const keyFor = (url) => {
    try {
      const parsed = new URL(url);
      const path = decodeURIComponent(parsed.pathname || "").replace(/\/wc\d+\//gi, "/");
      return (path.split("/").filter(Boolean).pop() || path).toLowerCase();
    } catch {
      return String(url || "").toLowerCase();
    }
  };
  const normalize = (rawUrl) => {
    const url = String(rawUrl || "").trim().split(/[?#]/)[0];
    if (!/^https?:\/\//i.test(url)) return "";
    if (/\/wc\d+\//i.test(url)) return "";
    if (!/(ir-\d+\.ozonru\.cn|ir\.ozone\.ru)\/s3\/multimedia/i.test(url)) return "";
    return url;
  };
  const walk = (node) => {
    if (!node) return;
    if (typeof node === "string") {
      const url = normalize(node);
      if (url) {
        const key = keyFor(url);
        if (!seen.has(key)) {
          seen.add(key);
          urls.push(url);
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node === "object") {
      for (const key of ["src", "srcMobile", "url", "image", "imageUrl"]) walk(node[key]);
      for (const value of Object.values(node)) {
        if (urls.length >= 8) break;
        if (value && typeof value === "object") walk(value);
      }
    }
  };
  walk(widgets);
  if (!urls.length) return text;
  const block = (src) => ({
    imgLink: "",
    img: {
      src,
      srcMobile: src,
      alt: "",
      position: "width_full",
      positionMobile: "width_full",
      widthMobile: 800,
      heightMobile: 800,
    },
  });
  const content = [{ widgetName: "raShowcase", type: "billboard", blocks: [block(urls[0])] }];
  if (urls.length > 1) content.push({ widgetName: "raShowcase", type: "roll", blocks: urls.slice(1).map(block) });
  return JSON.stringify({ content, version: doc.version || 0.3 });
}

function hasImportAttribute(attributes, attrId) {
  return Array.isArray(attributes) && attributes.some(a => Number(a?.id ?? a?.attribute_id) === Number(attrId));
}

function injectRichContentAttribute(item, sourceVariant = null) {
  const richContent = normalizeOzonRichContentForSubmit(pickSourceRichContent(item, sourceVariant));
  if (!richContent) return false;
  if (!Array.isArray(item.attributes)) item.attributes = [];
  if (!hasImportAttribute(item.attributes, 11254)) {
    item.attributes.push({ id: 11254, values: [{ value: richContent }] });
  }
  item.richContent = richContent;
  return true;
}

function getRequestPublicBaseUrl(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || "").replace(/\/+$/, "");
  if (configured) return configured;
  const proto = String(req.get("x-forwarded-proto") || req.protocol || "http").split(",")[0].trim() || "http";
  const host = String(req.get("x-forwarded-host") || req.get("host") || "").split(",")[0].trim();
  if (host) return `${proto}://${host}`.replace(/\/+$/, "");
  return "";
}

async function listStoreWarehouses(storeId, userId) {
  if (!storeId || !userId) return [];
  const data = await callOzonSellerAPI("/v2/warehouse/list", {}, { storeId, userId });
  return (data?.warehouses || data?.result || []).map(w => ({
    warehouse_id: Number(w.warehouse_id),
    name: w.name || `WH-${w.warehouse_id}`,
    status: w.status || "active",
    is_rfbs: w.is_rfbs === true,
  })).filter(w => Number.isFinite(w.warehouse_id) && w.warehouse_id > 0);
}

async function normalizeStocksForStore(rawStocks, storeId, userId) {
  const stocks = Array.isArray(rawStocks) ? rawStocks : [];
  if (!stocks.length) return [];

  let warehouses = [];
  try {
    warehouses = await listStoreWarehouses(storeId, userId);
  } catch (e) {
    console.warn(`[stocks] 拉店铺仓库失败 store=${storeId}: ${e.message}`);
  }
  const preferred = warehouses.find(w => w.status === "created" && w.is_rfbs) || warehouses.find(w => w.is_rfbs) || warehouses[0] || null;
  const validIds = new Set(warehouses.map(w => String(w.warehouse_id)));

  return stocks
    .filter(s => s && s.offer_id)
    .map(s => {
      const requestedWh = Number(s.warehouse_id);
      let warehouseId = Number.isFinite(requestedWh) && requestedWh > 0 ? requestedWh : 0;
      if (warehouseId && validIds.size && !validIds.has(String(warehouseId))) {
        const replacement = preferred?.warehouse_id || 0;
        console.warn(`[stocks] warehouse_id=${warehouseId} 不属于 store=${storeId}, 自动改为 ${replacement || "空"}`);
        warehouseId = replacement;
      }
      return {
        offer_id: String(s.offer_id),
        stock: parseInt(s.stock ?? s.stocks ?? 0, 10),
        ...(warehouseId > 0 ? { warehouse_id: warehouseId } : {}),
      };
    })
    .filter(s => Number.isFinite(s.stock) && s.stock >= 0 && (!validIds.size || !s.warehouse_id || validIds.has(String(s.warehouse_id))));
}

function canonicalImportImageKey(url) {
  const lower = String(url || "").toLowerCase();
  try {
    const u = new URL(lower);
    let path = decodeURIComponent(u.pathname || "")
      .replace(/\/(?:wc|c)\d+\//g, "/")
      .replace(/\/+/g, "/");
    const file = path.split("/").filter(Boolean).pop() || path;
    if (/\/s3\/(?:multimedia|rp-photo)[^/]*\//i.test(path) && file) return `ozon:${file}`;
    if (/\/s3\/cms\//i.test(path)) return `drop:${path}`;
    return `${u.hostname.replace(/^ir-\d+\.ozonru\.cn$/, "ir.ozone.ru")}:${path}`;
  } catch {
    return lower.replace(/[?#].*$/, "").replace(/\/(?:wc|c)\d+\//g, "/");
  }
}

async function applyListingAttributesAfterImport(row) {
  if (!db || !row?.task_id || !row?.user_id || !row?.offer_id) return { skipped: true, reason: "missing_context" };
  const raw = row.raw_payload && typeof row.raw_payload === "object" ? row.raw_payload : {};
  if (raw.attribute_applied_at) return { skipped: true, reason: "already_applied" };

  const item = raw.item && typeof raw.item === "object" ? raw.item : {};
  const sourceItem = raw.source_item && typeof raw.source_item === "object" ? raw.source_item : {};
  const noBrandMode = raw.no_brand_mode === true
    || raw.no_brand_mode === "true"
    || item._no_brand === true
    || item.no_brand === true
    || String(item.brand_mode || item.brandMode || "").trim() === "no_brand";
  const attributes = [
    ...(Array.isArray(item.attributes) ? item.attributes : []),
    ...(Array.isArray(sourceItem.attributes) ? sourceItem.attributes : []),
    ...sourceVariantAttributesToImportAttrs(sourceItem),
  ]
    .map(normalizeOzonAttributeForUpdate)
    .filter(attr => attr && attr.id !== 4194 && attr.id !== 4195 && (!noBrandMode || !isBrandAttributeId(attr.id)));

  const attrById = new Map();
  for (const attr of attributes) {
    const key = `${attr.complex_id || 0}:${attr.id}`;
    if (!attrById.has(key)) attrById.set(key, attr);
  }
  const normalizedAttributes = [...attrById.values()].slice(0, 100);

  if (!normalizedAttributes.length) return { skipped: true, reason: "no_valid_attributes" };

  try {
    let productId = Number(raw.product_id || raw.ozon_product_id || 0);
    if (!productId) {
      const info = await callOzonSellerAPI("/v3/product/info/list", { offer_id: [String(row.offer_id)] }, { storeId: row.store_id, userId: row.user_id });
      productId = Number((info?.items || [])[0]?.id || 0);
    }
    if (!productId) return { skipped: true, reason: "product_id_not_ready" };

    const richAttributes = normalizedAttributes.filter(attr => Number(attr.id) === 11254).slice(0, 1);
    const regularAttributes = normalizedAttributes.filter(attr => Number(attr.id) !== 11254);
    let regularData = null;
    let richData = null;
    if (regularAttributes.length) {
      const payload = { items: [{ product_id: productId, offer_id: String(row.offer_id), attributes: regularAttributes }] };
      regularData = await callOzonSellerAPI("/v1/product/attributes/update", payload, { storeId: row.store_id, userId: row.user_id });
    }
    // Ozon accepts 11254 mixed with other attributes but often does not persist it.
    // Sending rich content alone matches Seller UI behavior more reliably.
    if (richAttributes.length) {
      const richPayload = { items: [{ product_id: productId, offer_id: String(row.offer_id), attributes: richAttributes }] };
      richData = await callOzonSellerAPI("/v1/product/attributes/update", richPayload, { storeId: row.store_id, userId: row.user_id });
    }
    await db.query(
      `UPDATE app_listing_history
          SET raw_payload = jsonb_set(
                jsonb_set(
                  jsonb_set(
                    jsonb_set(COALESCE(raw_payload, '{}'::jsonb), '{attribute_applied_at}', to_jsonb(now()::text), true),
                    '{attribute_apply_response}', $4::jsonb, true
                  ),
                  '{rich_attribute_apply_response}', $5::jsonb, true
                ),
                '{product_id}', to_jsonb($1::bigint), true
              ),
              updated_at = now()
        WHERE task_id = $2 AND user_id = $3`,
      [productId, String(row.task_id), row.user_id, JSON.stringify(regularData || {}), JSON.stringify(richData || {})],
    );
    console.log(`[listing-attributes] task=${row.task_id} product=${productId} applied attrs=${regularAttributes.length}${richAttributes.length ? " + rich11254" : ""}`);
    return { applied: true, productId, data: { regular: regularData, rich: richData }, count: normalizedAttributes.length };
  } catch (e) {
    await db.query(
      `UPDATE app_listing_history
          SET raw_payload = jsonb_set(COALESCE(raw_payload, '{}'::jsonb), '{attribute_apply_error}', to_jsonb($1::text), true),
              updated_at = now()
        WHERE task_id = $2 AND user_id = $3`,
      [String(e.message || e), String(row.task_id), row.user_id],
    );
    console.warn(`[listing-attributes] task=${row.task_id} apply failed:`, e.message || e);
    return { applied: false, error: e.message || String(e) };
  }
}

// 后台 polling: 扫所有非终态 task, 调 Ozon 更新到 DB
const POLL_INTERVAL_MS = 60 * 1000;
const POLL_BATCH = 50;

// v2.2.9.100: poll 单任务超时保护 — 防止某条 Ozon 调用卡死整个 cycle，导致新任务确认被无限延后
function withPollTaskTimeout(promiseFactory, timeoutMs = 30000) {
  return Promise.race([
    Promise.resolve().then(promiseFactory),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`poll task timeout ${timeoutMs}ms`)), timeoutMs)),
  ]);
}

async function pollPendingListingTasks() {
  if (!db) return;
  try {
    const r = await db.query(
      `SELECT task_id, store_id, user_id, offer_id, main_image, status, raw_payload FROM app_listing_history
       WHERE created_at > now() - interval '7 days'
         AND (
           status IN ('processing', 'pending')
           OR (
             status = 'imported'
             AND (
               (
                 NOT (COALESCE(raw_payload, '{}'::jsonb) ? 'picture_applied_at')
                 AND NOT (COALESCE(raw_payload, '{}'::jsonb) ? 'picture_apply_error')
               )
               OR NOT (COALESCE(raw_payload, '{}'::jsonb) ? 'attribute_applied_at')
               OR (
                 jsonb_array_length(COALESCE(raw_payload->'stocks', '[]'::jsonb)) > 0
                 AND NOT (COALESCE(raw_payload, '{}'::jsonb) ? 'stock_applied_at')
               )
             )
           )
         )
       -- v2.2.9.100: processing/pending（待确认创建）优先于 imported 补全，避免新提交被历史任务挤掉
       ORDER BY CASE WHEN status IN ('processing','pending') THEN 0 ELSE 1 END, created_at DESC LIMIT $1`,
      [POLL_BATCH],
    );
    if (!r.rows.length) return;
    let updated = 0, gc = 0;
    for (const row of r.rows) {
      try {
        const rawPayload = row.raw_payload && typeof row.raw_payload === "object" ? row.raw_payload : {};
        if (rawPayload.via_portal === true || rawPayload.via_portal === "true") {
          if (row.status === "imported") {
            // v2.2.9.100: 跳过补全（提交时已带图片/属性/富文本/库存），只 touch 防超时
            await db.query(
              `UPDATE app_listing_history SET updated_at = now() WHERE task_id = $1 AND user_id = $2`,
              [row.task_id, row.user_id],
            );
            updated++;
            continue;
          }
          const info = await withPollTaskTimeout(() => callOzonSellerAPI("/v3/product/info/list", { offer_id: [String(row.offer_id)] }, { storeId: row.store_id, userId: row.user_id }), 30000);
          const productId = Number((info?.items || [])[0]?.id || 0);
          if (!productId) {
            await db.query(
              `UPDATE app_listing_history SET updated_at = now() WHERE task_id = $1 AND user_id = $2`,
              [row.task_id, row.user_id],
            );
            continue;
          }
          const portalRow = {
            ...row,
            raw_payload: { ...rawPayload, product_id: productId },
          };
          await db.query(
            `UPDATE app_listing_history
                SET status = 'imported',
                    raw_payload = jsonb_set(COALESCE(raw_payload, '{}'::jsonb), '{product_id}', to_jsonb($1::bigint), true),
                    updated_at = now()
              WHERE task_id = $2 AND user_id = $3`,
            [productId, row.task_id, row.user_id],
          );
          // v2.2.9.100: 跳过属性/库存补全（提交已带）
          console.log(`[poll-pending] portal task=${row.task_id} offer=${row.offer_id} → imported product=${productId}`);
          updated++;
          continue;
        }
        if (row.status === "imported") {
          // v2.2.9.100: imported 跳过补图/补属性/补库存 — 提交时已带完整数据，避免堆积任务拖垮 poll
          await db.query(
            `UPDATE app_listing_history SET updated_at = now() WHERE task_id = $1 AND user_id = $2`,
            [row.task_id, row.user_id],
          );
          updated++;
          continue;
        }
        const data = await withPollTaskTimeout(() => callOzonSellerAPI("/v1/product/import/info", { task_id: String(row.task_id) }, { storeId: row.store_id, userId: row.user_id }), 30000);
        const it = (data?.result?.items || [])[0];
        if (!it) continue;
        const ozonStatus = it.status || "unknown";
        const errors = Array.isArray(it.errors) ? it.errors : [];
        const statusMap = { imported: "imported", failed: "failed", processing: "processing", moderating: "moderating", pending: "processing" };
        const localStatus = statusMap[ozonStatus] || ozonStatus;
        if (["imported", "failed"].includes(localStatus)) {
          if (localStatus === "imported") {
            await applyListingPicturesAfterImport(row);
            await applyListingAttributesAfterImport(row);
            await applyListingStocksAfterImport(row);
          }
          await db.query(
            `UPDATE app_listing_history SET status = $1, errors_json = $2::jsonb, updated_at = now() WHERE task_id = $3 AND user_id = $4`,
            [localStatus, JSON.stringify(errors), row.task_id, row.user_id],
          );
          console.log(`[poll-pending] task=${row.task_id} offer=${row.offer_id} → ${localStatus}${errors.length ? ' errors=' + errors.length : ''}`);
          updated++;
        } else {
          // v2.1.9: pending/processing 也 touch updated_at, 让 user 看到 polling 活着
          await db.query(
            `UPDATE app_listing_history SET updated_at = now() WHERE task_id = $1 AND user_id = $2`,
            [row.task_id, row.user_id],
          );
        }
      } catch (e) {
        const msg = e.message || "";
        if (msg.includes("task not found")) {
          await db.query(
            `UPDATE app_listing_history SET status = 'failed', errors_json = $1::jsonb, updated_at = now() WHERE task_id = $2 AND user_id = $3`,
            [JSON.stringify([{ code: "task_not_found", message: "Ozon 已清理 (跨店铺/时间 GC)" }]), row.task_id, row.user_id],
          );
          console.log(`[poll-pending] task=${row.task_id} → failed (task_not_found)`);
          gc++;
        } else {
          console.warn(`[poll-pending] task=${row.task_id} poll error:`, msg);
        }
      }
    }
    if (updated || gc) console.log(`[poll-pending] cycle done: ${updated} updated, ${gc} gc`);
  } catch (e) {
    console.error("[poll-pending] cycle error:", e.message);
  }
}

// 启动 2 分钟后开始, 然后每 60s 跑一次
if (db) {
  setTimeout(() => {
    pollPendingListingTasks();
    setInterval(pollPendingListingTasks, POLL_INTERVAL_MS);
    console.log(`[poll-pending] started, interval=${POLL_INTERVAL_MS}ms`);
  }, 2 * 60 * 1000);
}

// v0.6.2: 按 sku 解析 Seller API 类目 (供 plugin 用, 替换 URL 解析)
// v2.1.9+: 多级 fallback - 本地 → Ozon 本店 → 跨店 → 同店名字相似 → 失败带候选
app.post("/api/seller/products/category-resolve", requireAuth, async (req, res, next) => {
  try {
    const storeId = req.body?.store_id || req.body?.storeId;
    const sku = Number(req.body?.sku || 0);
    const offerId = String(req.body?.offer_id || "").trim();
    const productName = String(req.body?.name || "").trim();
    const typeId = req.body?.type_id || req.body?.typeId || 0;
    const breadcrumbCatId = Number(req.body?.breadcrumb_cat_id || 0);  // v2.2.9 trace
    console.log(`[category-resolve] sku=${sku} name="${productName.slice(0,40)}" type_id=${typeId} breadcrumb_cat_id=${breadcrumbCatId} store=${storeId.slice(-8)}`);
    if (!storeId) return res.status(400).json({ success: false, error: "需要 store_id" });
    if (!sku && !offerId && !productName && !typeId) return res.status(400).json({ success: false, error: "需要 sku/offer_id/name/type_id 至少一个" });

    const userId = req.user.id;
    let resolvedName = productName;

    // 1. 本地 DB 查 (同店铺已有)
    if (offerId || sku) {
      const r = await db.query(
        `SELECT description_category_id, type_id, name FROM app_products
         WHERE store_id = $1 AND (offer_id = $2 OR sku = $3) LIMIT 1`,
        [storeId, offerId || "", sku || 0],
      );
      if (r.rows[0]?.description_category_id) {
        return res.json({
          success: true,
          source: "local-same-store",
          description_category_id: Number(r.rows[0].description_category_id),
          type_id: Number(r.rows[0].type_id || 0),
          name: r.rows[0].name || "",
        });
      }
    }

    // 2. Ozon 本店 API (sku 必须在这家店存在, 竞品不会返回)
    if (sku) {
      try {
        const data = await callOzonSellerAPI("/v3/product/info/list", { sku: [sku] }, { storeId, userId });
        const it = (data?.items || data?.result?.items || [])[0];
        if (it?.description_category_id) {
          return res.json({
            success: true,
            source: "ozon-same-store",
            description_category_id: Number(it.description_category_id),
            type_id: Number(it.type_id || 0),
            name: it.name || "",
          });
        }
      } catch (e) {
        console.warn("[category-resolve] Ozon 本店 API fail:", e.message);
      }
    }

    // 3. 跨店查询 - 同用户其他店可能有这个 sku (例如从 LuckyDay 采集, 上传到 Three Latte)
    if (sku && db) {
      try {
        const otherStores = await db.query(
          `SELECT id, client_id, api_key FROM app_stores WHERE user_id = $1 AND id != $2 AND active = TRUE`,
          [userId, storeId],
        );
        for (const st of otherStores.rows) {
          try {
            const data = await callOzonSellerAPI("/v3/product/info/list", { sku: [sku] }, { storeId: st.id, userId });
            const it = (data?.items || data?.result?.items || [])[0];
            if (it?.description_category_id) {
              // 注意: 跨店的 category 可能也不在目标店 tree 里, 但概率高
              return res.json({
                success: true,
                source: `cross-store:${st.id}`,
                description_category_id: Number(it.description_category_id),
                type_id: Number(it.type_id || 0),
                name: it.name || "",
                warning: "跨店匹配, 可能与目标店类目树不兼容",
              });
            }
          } catch (e) { /* 单店失败不阻塞 */ }
        }
      } catch (e) {
        console.warn("[category-resolve] 跨店查询 fail:", e.message);
      }
    }

    // 3b. Ozon tree 精确 type_id 反查父类目。
    // Seller /search 的 description_type_dict_value 实际是 type_id; 有它时比商品名关键词更可靠。
    if (typeId) {
      try {
        const typeHit = await findCategoryByTypeId(storeId, userId, typeId);
        if (typeHit?.description_category_id) {
          return res.json({
            success: true,
            confidence: "high",
            source: "ozon-tree-type-id",
            description_category_id: typeHit.description_category_id,
            type_id: typeHit.type_id,
            name: typeHit.type_name || "",
            category_name: typeHit.category_name || "",
            breadcrumb: typeHit.breadcrumb || "",
          });
        }
      } catch (e) {
        console.warn("[category-resolve] type_id tree lookup fail:", e.message);
      }
    }

    // 4. 同店名字相似 - 找同店铺商品名相似商品复用其类目
    if (productName && productName.length >= 3 && db) {
      try {
        // 取关键词 (俄文 / 中文 / 英文 单词, 取前 2 个最长)
        const tokens = productName.toLowerCase()
          .replace(/[^\p{L}\p{N}\s]/gu, ' ')
          .split(/\s+/)
          .filter(t => t.length >= 3)
          .sort((a, b) => b.length - a.length)
          .slice(0, 2);
        if (tokens.length > 0) {
          // v2.3.0: 严格匹配 - 多 token 时要求 ALL 命中 (避免 Лупа/Оплетка 这种假阳性)
          const useAnd = tokens.length >= 2;
          const conditions = tokens.map((_, i) => `name ILIKE $${i + 2}`).join(useAnd ? ' AND ' : ' OR ');
          const params = [storeId, ...tokens.map(t => `%${t}%`)];
          const r = await db.query(
            `SELECT description_category_id, type_id, name,
                    (CASE WHEN name ILIKE $2 THEN 1 ELSE 0 END) +
                    (CASE WHEN $3::text IS NOT NULL AND name ILIKE $3 THEN 1 ELSE 0 END) AS match_score
             FROM app_products
             WHERE store_id = $1 AND description_category_id IS NOT NULL
               AND description_category_id > 0 AND (${conditions})
             GROUP BY description_category_id, type_id, name, match_score
             ORDER BY match_score DESC, COUNT(*) DESC LIMIT 5`,
            params,
          );
          if (r.rows.length > 0) {
            const validIds = await getValidCategoryIds(storeId, userId);
            const validHit = r.rows.find(row => validIds?.has(Number(row.description_category_id)));
            if (validHit) {
              const confidence = useAnd ? 'high' : 'medium';
              return res.json({
                success: true,
                confidence,
                source: "similar-name-same-store",
                description_category_id: Number(validHit.description_category_id),
                type_id: Number(validHit.type_id || 0),
                name: validHit.name || "",
                matched_tokens: tokens,
              });
            }
          }
        }
      } catch (e) {
        console.warn("[category-resolve] 名字相似查询 fail:", e.message);
      }
    }

    // 4b. type_id 匹配 - 同 type_id 在店铺里通常在同一类目, 比名字更稳
    if (typeId && db) {
      try {
        const typeRes = Number(typeId);
        if (typeRes > 0) {
          const tr = await db.query(
            `SELECT description_category_id, COUNT(*) as cnt FROM app_products
             WHERE store_id = $1 AND type_id = $2 AND description_category_id IS NOT NULL AND description_category_id > 0
             GROUP BY description_category_id ORDER BY cnt DESC LIMIT 3`,
            [storeId, typeRes],
          );
          if (tr.rows.length > 0) {
            const validIds = await getValidCategoryIds(storeId, userId);
            const validTypeHit = tr.rows.find(row => validIds?.has(Number(row.description_category_id)));
            if (validTypeHit) {
              return res.json({
                success: true,
                confidence: 'medium',
                source: 'same-type-id',
                description_category_id: Number(validTypeHit.description_category_id),
                type_id: typeRes,
                name: '',
                note: '同一 type_id 在你店通常归此类目 (type_id 比 name 更稳, 但仍建议你核对)',
              });
            }
          }
        }
      } catch (e) {
        console.warn("[category-resolve] type_id 匹配 fail:", e.message);
      }
    }

    // 5. 全部失败 - 返回目标店高频类目作为候选 (让前端给 user 看)
    // v2.2.9.1: 增加 "按当前商品 name 关键词从 Ozon 全 tree 过滤" 作为第一批候选
    //   之前只给店铺历史高频 (跟当前商品可能完全不相关), 现在用 name 匹配 Ozon 全树
    const fallbackCandidates = async () => {
      if (!db) return [];
      // 确保 tree cache 已加载, 不然 name 查不到
      if (userId) await getValidCategoryIds(storeId, userId);
      const candidates = [];
      const seen = new Set();

      // v2.2.9.1 第一优先: 用商品名俄文 token 从 Ozon 全 tree 过滤
      //   比如 "Чайник заварочный" → tokens=[чайник, заварочный]
      //   从 categoryTreeCache 里找 name 含这些 token 的 cat, 跟当前商品最相关
      //   关键: type_id 节点 (Ozon tree 叶子) 的 description_category_id=0, 要用父级 cat 的 id
      if (productName && productName.length >= 3) {
        try {
          // v2.2.9.5: 加大到 8 个 + 优先俄文 (cyrillic) token, 英文 token 降权
          //   之前 slice(0, 3) 太短, 商品名 "Большой туристический тент Cloud Skies Tarp Lite (L)" 7 个 token 只取 3,
          //   核心词 "тент" 被英文 "cloud" 挤掉, candidates 拿不到正确的 Тент 类目
          const allTokens = productName.toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .split(/\s+/)
            .filter(t => t.length >= 3);
          // 优先俄文 (cyrillic range 0400-04FF), 英文 (latin range) 排后面
          const cyr = allTokens.filter(t => /[Ѐ-ӿ]/.test(t));
          const lat = allTokens.filter(t => /[a-z]/.test(t) && !/[Ѐ-ӿ]/.test(t));
          const tokens = [...cyr.sort((a, b) => b.length - a.length), ...lat.sort((a, b) => b.length - a.length)].slice(0, 8);
          if (tokens.length) {
            const tree = await getCategoryTreeForStore(storeId, userId);
            const matches = [];
            const walk = (nodes, parentCatId = null, breadcrumb = []) => {
              for (const n of nodes || []) {
                const name = (n.category_name || n.type_name || '').toLowerCase();
                const hits = tokens.filter(t => name.includes(t)).length;
                // v2.2.9.1: type_id 节点 (叶子) 没有 description_category_id, 用父 cat id
                const catId = Number(n.description_category_id) || parentCatId;
                const typeId = Number(n.type_id) || 0;
                if (hits > 0 && catId) {
                  matches.push({
                    description_category_id: catId,
                    type_id: typeId,
                    name: n.category_name || n.type_name || '',
                    match_score: hits,
                    breadcrumb: [...breadcrumb, n.category_name || n.type_name].join(" › "),
                  });
                }
                walk(n.children || [], catId, [...breadcrumb, n.category_name || n.type_name || '']);
              }
            };
            walk(tree, null, []);
            // 按 match_score 排序, 取前 8
            // v2.2.9.5: 排序 score 相同时, 优先 name 直接命中商品 token (e.g. "Тент" name 完全等于商品 "тент" token)
            //   之前 sort 不稳, 同样 score=1 的会被随机排, 正确 cat (Тент) 经常被截断到 8+ 名
            matches.sort((a, b) => {
              if (b.match_score !== a.match_score) return b.match_score - a.match_score;
              // score 相同时: 优先 name 跟商品 token 完全相等的 (e.g. "Тент" name == "тент" token)
              const aExact = tokens.some(t => a.name.toLowerCase() === t) ? 1 : 0;
              const bExact = tokens.some(t => b.name.toLowerCase() === t) ? 1 : 0;
              if (bExact !== aExact) return bExact - aExact;
              // 再按 name 长度 (短的优先, 更可能是叶子)
              return a.name.length - b.name.length;
            });
            console.log(`[fallbackCandidates] productName="${productName.slice(0,40)}" tokens=${JSON.stringify(tokens)} matches=${matches.length}`);
            for (const m of matches.slice(0, 8)) {
              if (!seen.has(m.description_category_id)) {
                candidates.push({ ...m, source: 'ozon-tree-name-match' });
                seen.add(m.description_category_id);
              }
            }
          }
        } catch (e) {
          console.warn("[category-resolve] ozon-tree name match fail:", e.message);
        }
      }

      // 第二优先: 店铺历史高频 cat (兜底, 如果 name 匹配不到才显示)
      try {
        const r = await db.query(
          `SELECT description_category_id, COUNT(*) as cnt FROM app_products
           WHERE store_id = $1 AND description_category_id IS NOT NULL AND description_category_id > 0
             AND description_category_id NOT IN (${[...seen].map((_, i) => `$${i + 2}`).join(',') || '$2'})
           GROUP BY description_category_id ORDER BY cnt DESC LIMIT 10`,
          [storeId, ...[...seen].map(Number)],
        );
        for (const x of r.rows) {
          const id = Number(x.description_category_id);
          if (seen.has(id)) continue;
          candidates.push({
            description_category_id: id,
            name: getCategoryName(storeId, id) || '',
            count: Number(x.cnt),
            source: 'store-history',
          });
          seen.add(id);
          if (candidates.length >= 15) break;
        }
      } catch { /* 兜底查询失败不阻塞 */ }

      return candidates.slice(0, 15);
    };

    const candidates = await fallbackCandidates();
    res.json({
      success: false,
      confidence: 'none',
      error: "无法自动解析 (sku 不在任何店, 名字相似也找不到, type_id 也没匹配)",
      description_category_id: 0,
      candidates,
    });
  } catch (error) {
    res.status(error.statusCode || 502).json({ success: false, error: error.message });
  }
});

// v0.6.2: 强制刷新类目缓存
app.post("/api/seller/categories/refresh-cache", requireAuth, async (req, res, next) => {
  try {
    const storeId = req.body?.store_id || req.body?.storeId;
    invalidateCategoryCache(storeId);
    const validIds = await getValidCategoryIds(storeId, req.user.id);
    res.json({ success: true, count: validIds?.size || 0, refreshed: true });
  } catch (error) {
    res.status(error.statusCode || 502).json({ success: false, error: error.message });
  }
});

app.post("/api/seller/products/import", requireAuth, async (req, res, next) => {
  try {
    const { item: rawItem } = req.body;
    // v2.2.7: 接受顶层 stocks (跟 MY 一样, items 和 stocks 一起传给 Ozon /v3/product/import)
    const rawStocks = Array.isArray(req.body?.stocks) ? req.body.stocks : null;
    const storeId = req.body?.store_id || req.body?.storeId;
    if (!rawItem || typeof rawItem !== "object") {
      return res.status(400).json({ success: false, error: "缺少商品数据" });
    }
    const item = { ...rawItem };
    const sourceVariant = item._sourceVariant && typeof item._sourceVariant === "object" ? item._sourceVariant : null;
    const collectMeta = item._collect_meta && typeof item._collect_meta === "object" ? item._collect_meta : null;
    const sourceImages = sourceVariant ? extractSourceVariantImages(sourceVariant) : [];
    const offerId = String(item.offer_id || item.sku || "").trim();
    const sourceSku = Number(item.source_sku || item.sourceSku || item.ozon_sku || item.ozonSku || 0);
    const importMode = String(item.import_mode || item.importMode || "").trim().toLowerCase();
    const noBrandMode = item._no_brand === true
      || item.no_brand === true
      || String(item.brand_mode || item.brandMode || "").trim() === "no_brand"
      || String(item.scraped_brand || "").trim() === "no_brand";

    // v2.2.9.12: 跟卖优先走 Ozon 官方按 SKU 创建接口.
    // /v3/product/import 需要本系统自己拼完整类目/属性, 容易出现必填属性缺失或信息不一致;
    // /v1/product/import-by-sku 让 Ozon 按源 SKU 复制/关联原卡片, 更接近 MY ERP 的批量跟卖.
    if (sourceSku > 0 && importMode !== "v3") {
      if (!item.name || !offerId) {
        return res.status(400).json({ success: false, error: "按 SKU 跟卖需要 source_sku/name/offer_id" });
      }
      const skuItem = {
        sku: sourceSku,
        name: String(item.name || "").replace(/\s+/g, " ").trim().slice(0, 200),
        offer_id: offerId,
        currency_code: String(item.currency_code || "CNY"),
        old_price: String(item.old_price || item.price || "0"),
        price: String(item.price || "0"),
        premium_price: String(item.premium_price || item.price || "0"),
        vat: String(item.vat || "0"),
      };
      const ozonPayload = { items: [skuItem] };
      const data = await callOzonSellerAPI("/v1/product/import-by-sku", ozonPayload, { storeId, userId: req.user.id });
      const taskId = data?.result?.task_id || data?.task_id || "";

      if (db && req.user?.id && taskId) {
        try {
          const placeholderTaskId = String(req.body?.meta?.listingPlaceholderTaskId || req.body?.meta?.placeholderTaskId || "").trim();
          const historyPayload = JSON.stringify({ item, ozon_item: skuItem, source_sku: sourceSku, import_mode: "sku", stocks: rawStocks || [], submitted_at: new Date().toISOString(), placeholder_task_id: placeholderTaskId });
          let updatedPlaceholder = { rowCount: 0 };
          if (placeholderTaskId) {
            updatedPlaceholder = await db.query(
              `UPDATE app_listing_history
                  SET task_id = $1,
                      offer_id = $2,
                      product_name = $3,
                      main_image = $4,
                      price_rub = $5,
                      status = 'processing',
                      raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $6::jsonb,
                      errors_json = '[]'::jsonb,
                      updated_at = now()
                WHERE user_id = $7 AND store_id = $8 AND task_id = $9
                  AND NOT EXISTS (
                    SELECT 1 FROM app_listing_history existing
                     WHERE existing.user_id = $7 AND existing.task_id = $1 AND existing.task_id <> $9
                  )`,
              [
                String(taskId),
                String(skuItem.offer_id || ""),
                String(skuItem.name || ""),
                String(item.primary_image || (Array.isArray(item.images) ? item.images[0] : "") || ""),
                skuItem.price ? Number(skuItem.price) : null,
                historyPayload,
                req.user.id,
                storeId || null,
                placeholderTaskId,
              ],
            );
          }
          if (!updatedPlaceholder.rowCount) {
            await db.query(
              `INSERT INTO app_listing_history (user_id, store_id, task_id, offer_id, product_name, main_image, price_rub, raw_payload)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
               ON CONFLICT (task_id) DO NOTHING`,
              [
                req.user.id,
                storeId || null,
                String(taskId),
                String(skuItem.offer_id || ""),
                String(skuItem.name || ""),
                String(item.primary_image || (Array.isArray(item.images) ? item.images[0] : "") || ""),
                skuItem.price ? Number(skuItem.price) : null,
                historyPayload,
              ],
            );
          }
        } catch (e) { console.error("[listing-history] insert import-by-sku failed:", e.message); }

        const collectId = String(req.body?.meta?.collectId || "").trim();
        if (collectId) {
          try {
            await db.query(
              `UPDATE collect_items
                  SET status = 'uploaded', linked_offer_id = $1, updated_at = now()
                WHERE id = $2 AND user_id = $3`,
              [String(skuItem.offer_id || ""), collectId, req.user.id],
            );
          } catch (e) { console.error("[collect-items] mark uploaded after import-by-sku failed:", e.message); }
        }
      }

      res.json({ success: true, data, taskId, importMode: "sku", stockDeferred: rawStocks?.length || 0 });
      return;
    }

    // v0.6.1: category_id 透传 - 支持 description_category_id (Ozon 原始) 或 category_id (前端简化)
    let categoryId = item.description_category_id || item.category_id;
    let typeId = item.type_id;
    const sourceVariantCategoryId = Number(sourceVariant?.description_category_id || sourceVariant?.category_id || 0);
    const sourceVariantTypeId = Number(sourceVariant?.type_id || sourceVariant?.typeId || 0);
    const itemTypeId = Number(typeId || 0);
    if (sourceVariantCategoryId > 0 && sourceVariantCategoryId >= 100000 && Number(categoryId) !== sourceVariantCategoryId) {
      console.log(`[v2.2.9.25 import] Seller bundle 源类目优先 ${categoryId || 0} → ${sourceVariantCategoryId}`);
      categoryId = sourceVariantCategoryId;
    }
    if (sourceVariantTypeId > 0 && itemTypeId !== sourceVariantTypeId) {
      console.log(`[v2.2.9.25 import] Seller bundle 源 type_id 优先 ${itemTypeId || 0} → ${sourceVariantTypeId}`);
      typeId = sourceVariantTypeId;
    }
    const trustedTypeId = Number(sourceVariantTypeId || itemTypeId || 0);
    if (trustedTypeId > 0) {
      try {
        const typeHit = await findCategoryByTypeId(storeId, req.user.id, trustedTypeId);
        const typeHitCategoryId = Number(typeHit?.description_category_id || 0);
        const canApplyTypeCategory = typeHitCategoryId > 0
          && (!sourceVariantCategoryId || sourceVariantCategoryId === typeHitCategoryId || Number(categoryId) < 100000);
        if (canApplyTypeCategory && Number(categoryId) !== typeHitCategoryId) {
          console.log(`[v2.2.9.25 import] type_id=${trustedTypeId} 修正类目 ${categoryId || 0} → ${typeHit.description_category_id} (${typeHit.breadcrumb || typeHit.type_name || ""})`);
          categoryId = typeHit.description_category_id;
          typeId = trustedTypeId;
        } else if (typeHitCategoryId > 0 && sourceVariantCategoryId > 0 && sourceVariantCategoryId !== typeHitCategoryId) {
          console.warn(`[v2.2.9.25 import] type_id=${trustedTypeId} 映射类目 ${typeHitCategoryId} 与 Seller bundle 源类目 ${sourceVariantCategoryId} 不一致, 保留源类目`);
          typeId = trustedTypeId;
        }
      } catch (e) {
        console.warn("[v2.2.9.25 import] type_id 类目修正失败:", e.message);
      }
    }
    if (!item.name || !offerId || !categoryId) {
      return res.status(400).json({ success: false, error: "标题/货号/类目ID不能为空 (需要 description_category_id)" });
    }

    // v2.2.0: 不再校验 description_category_id (公开站类目 ≠ Seller API, 强行校验会拦掉大量合规商品)
    // Ozon 自己会拒 (返回 failed), 用户去 seller.ozon.ru 后台改类目更直接.
    // 仅在后台 polling 把失败原因写回 DB, listing-history 页可见.
    // v2.2.9.3: 5位 (公开 URL breadcrumb) 大概率会被 Ozon 拒 levels_category_not_found
    //   实测 5位 cat 11427 在 Seller API tree 查不到 (空 types 列表), Ozon 立刻拒
    //   5位跟 8位是两套体系: 5位是公开 URL slug 末尾, 8位是 Seller API 内部 id
    //   plugin v2.2.9.3 默认用 candidates 第一个 (8位), 这里兜底: 5位没匹配上就直接 400
    if (Number(categoryId) > 0 && Number(categoryId) < 100000) {
      // 5位 cat - 验证是否在 Seller API tree 存在, 不存在直接 400
      const validIds = await getValidCategoryIds(storeId, req.user.id);
      if (validIds && !validIds.has(Number(categoryId))) {
        console.warn(`[v2.2.9.3 import] 拒绝 5位 description_category_id=${categoryId} (不在 Seller API tree, Ozon 会拒)`);
        return res.status(400).json({
          success: false,
          error: `description_category_id=${categoryId} 是 5位公开 URL cat, 不在 Seller API tree. 请从 candidates 选 8位 cat, 或去 Ozon 后台改类目`,
          hint: 'plugin v2.2.9.3 会自动选 candidates 第一个, 如果这里报错说明 plugin 没选, 检查 plugin 是否已 reload',
        });
      }
      console.log(`[v2.2.9.3 import] 5位 description_category_id=${categoryId} (在 Seller API tree, 合法)`);
    } else if (Number(categoryId) >= 100000) {
      console.log(`[v2.2.9.3 import] 8位 description_category_id=${categoryId} (Seller API 内部 id)`);
    }

    // Ozon /v3/product/import 规范化
    item.offer_id = offerId;
    item.description_category_id = Number(categoryId);  // v2.2.9: 不再 5位↔8位 转换, 透传
    if (typeId) item.type_id = Number(typeId);
    delete item.category_id;  // 移除非标字段, 避免 Ozon 报错
    if (item.price_rub) item.price = String(item.price_rub);
    if (item.price != null) item.price = String(item.price);   // Ozon 要求 price 是字符串
    if (item.price && !item.currency_code) item.currency_code = "RUB";
    if (item.weight && !item.weight_unit) item.weight_unit = "g";
    if (!item.dimension_unit) item.dimension_unit = "mm";
    if (Array.isArray(item.images) && item.images.length) item.primary_image = item.images[0];

    // v2.2.7: 默认 service_type=IS_CODE_SERVICE (跟卖场景, Ozon 可能走 source_variant 路径)
    if (!item.service_type) item.service_type = "IS_CODE_SERVICE";

    // v2.2.10: My ERP 跟卖会把源变体 attributes/images 一起带上。
    // 先把 _sourceVariant 合并成 Ozon /v3/product/import 能识别的扁平 attributes/images,
    // 再删除内部字段，避免发给 Ozon 的 payload 出现未知 key。
    if (sourceVariant) {
      const sourceAttrs = noBrandMode
        ? stripBrandAttributes(sourceVariantAttributesToImportAttrs(sourceVariant))
        : sourceVariantAttributesToImportAttrs(sourceVariant);
      if (sourceAttrs.length) {
        const sourceById = new Map(sourceAttrs.map(a => [`${a.id}:${a.complex_id || 0}`, a]));
        // v2.2.9.102: 前端扁平属性({id,name,value})没有 dictionary_value_id，Ozon 枚举属性(性别/材料/包装等)
        //   只认词典 ID 会被忽略。对前端已有属性：若源属性带 dictionary_value_id 则用源属性替换。
        item.attributes = (Array.isArray(item.attributes) ? item.attributes : []).map(attr => {
          const key = `${Number(attr?.id ?? attr?.attribute_id) || 0}:${Number(attr?.complex_id || 0)}`;
          const src = sourceById.get(key);
          if (src && Array.isArray(src.values) && src.values.length
            && (!Array.isArray(attr.values) || !attr.values.length || !attr.values[0]?.dictionary_value_id)) {
            return src;
          }
          return attr;
        });
        const existing = new Set(item.attributes.map(a => `${Number(a?.id ?? a?.attribute_id) || 0}:${Number(a?.complex_id || 0)}`));
        for (const attr of sourceAttrs) {
          const key = `${attr.id}:${attr.complex_id || 0}`;
          if (!existing.has(key)) {
            item.attributes.push(attr);
            existing.add(key);
          }
        }
      }
      const itemImages = Array.isArray(item.images) ? item.images : [];
      const itemHasUploads = itemImages.some(u => typeof u === "string" && /\/uploads\//i.test(u));
      const mergedImages = normalizeImportImageList(itemHasUploads ? itemImages : [...sourceImages, ...itemImages]);
      if (mergedImages.length) item.images = mergedImages;
      const sourceAttr = (key) => (sourceVariant.attributes || []).find(a => String(a?.key ?? a?.id ?? a?.attribute_id) === String(key));
      const readInt = (key) => {
        const v = getAttrRawValue(sourceAttr(key));
        const n = parseInt(Array.isArray(v) ? v[0] : v, 10);
        return Number.isFinite(n) && n > 0 ? n : 0;
      };
      if (!Number(item.weight)) item.weight = readInt("4497") || item.weight;
      if (!Number(item.depth)) item.depth = readInt("9454") || item.depth;
      if (!Number(item.width)) item.width = readInt("9455") || item.width;
      if (!Number(item.height)) item.height = readInt("9456") || item.height;
      if (!item.barcode) item.barcode = getAttrRawValue(sourceAttr("23524")) || getAttrRawValue(sourceAttr("7822")) || item.barcode;
    }
    item.images = normalizeImportImageList(item.images);
    item.primary_image = item.images[0] || item.primary_image || "";
    injectRichContentAttribute(item, sourceVariant);

    // v2.2.8 (回退 attributes 逻辑): 用扁平化 attributes, 尽量补 dictionary_value_id
    if (Array.isArray(item.attributes)) {
      item.attributes = item.attributes.map(a => {
        const aId = Number(a.id ?? a.attribute_id);
        // 兼容 v2.2.8 plugin 透传格式: {id, name, value, dictionary_value_id?, dictionary_value_ids?}
        let dictId = null;
        if (a.dictionary_value_id) dictId = Number(a.dictionary_value_id);
        else if (Array.isArray(a.dictionary_value_ids) && a.dictionary_value_ids.length === 1) dictId = a.dictionary_value_ids[0];

        const values = Array.isArray(a.values)
          ? a.values.map(v => ({
              value: String(v.value ?? ""),
              ...(v.dictionary_value_id ? { dictionary_value_id: Number(v.dictionary_value_id) } : {}),
            }))
          : (a.value !== undefined ? [{ value: String(a.value), ...(dictId ? { dictionary_value_id: dictId } : {}) }] : []);
        return { id: aId, values };
      }).filter(a => a.id && a.id !== 4194 && a.id !== 4195 && (!noBrandMode || !isBrandAttributeId(a.id)) && a.values.length);
    }
    // v2.2.9.6: attribute 9048 (Название модели) 兜底
    //   Ozon 17029010 (天幕) 等类目必填 attribute 9048, 不填 Ozon 接受商品但报 error_attribute_values_empty
    //   plugin v2.2.9.5+ 应该从 name 提取, 这里 server 端再兜底一次 (plugin 旧版本也不会漏)
    // v2.2.9.100: 先清洗标题(去 " - купить на OZON")且排除平台词, 避免把 OZON/купить 当型号被拒
    const has9048 = Array.isArray(item.attributes) && item.attributes.some(a => Number(a.id) === 9048);
    if (!has9048 && item.name && item.name.length >= 3) {
      const cleanName = String(item.name)
        .replace(/\s*-\s*(?:купить|buy|покупать)\s+(?:на\s+)?OZON\s*$/i, "")
        .replace(/\s*-\s*OZON\s*$/i, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      const mainPart = cleanName.split(",")[0].trim();
      const tokens = mainPart.split(/\s+/);
      const genericRu = /^(большой|маленький|туристический|походный|складной|детский|зимний|летний|домашний|уличный|портативный|новый|оригинальный|универсальный|легкий|тяжелый)$/i;
      const kept = tokens.filter(t => {
        if (genericRu.test(t)) return false;
        if (/^(ozon|купить|buy|покупать)$/i.test(t)) return false;
        if (/^[А-Яа-яЁё]{4,}$/.test(t) && !/[A-Za-z]/.test(t)) return false;
        if (/^\d+([.,]\d+)?$/.test(t)) return false;
        if (/^\d+\s*(см|мм|м|г|кг|л|мл|w|wt|hz|×|х)$/i.test(t)) return false;
        return true;
      });
      const model = kept.join(" ").trim();
      if (model && model.length >= 2 && !/^ozon$/i.test(model)) {
        if (!Array.isArray(item.attributes)) item.attributes = [];
        item.attributes.push({ id: 9048, values: [{ value: model }] });
        console.log(`[v2.2.9.6 import] attribute 9048 (Название модели) 兜底: "${model}"`);
      }
    }
    delete item._sourceVariant;
    item.images = normalizeImportImageList(item.images);
    item.primary_image = item.images[0] || item.primary_image || "";
    injectRichContentAttribute(item, sourceVariant);
    if (Array.isArray(item.attributes)) {
      item.attributes = item.attributes.map(a => {
        const aId = Number(a.id ?? a.attribute_id);
        // 兼容 v2.2.8 plugin 透传格式: {id, name, value, dictionary_value_id?, dictionary_value_ids?}
        let dictId = null;
        if (a.dictionary_value_id) dictId = Number(a.dictionary_value_id);
        else if (Array.isArray(a.dictionary_value_ids) && a.dictionary_value_ids.length === 1) dictId = a.dictionary_value_ids[0];

        const values = Array.isArray(a.values)
          ? a.values.map(v => ({
              value: String(v.value ?? ""),
              ...(v.dictionary_value_id ? { dictionary_value_id: Number(v.dictionary_value_id) } : {}),
            }))
          : (a.value !== undefined ? [{ value: String(a.value), ...(dictId ? { dictionary_value_id: dictId } : {}) }] : []);
        return { id: aId, values };
      }).filter(a => a.id && a.id !== 4194 && a.id !== 4195 && (!noBrandMode || !isBrandAttributeId(a.id)) && a.values.length);
    }
    delete item._sourceVariant;
    delete item._collect_meta;
    delete item._no_brand;
    delete item.no_brand;
    delete item.brand_mode;
    delete item.brandMode;
    delete item.scraped_brand;
    delete item.richContent;
    delete item.rich_content;
    delete item.richAnnotationJson;
    if (!item.images.length) return res.status(400).json({ success: false, error: "过滤后没有可提交的商品图片" });

    // v2.2.7: 顶层 stocks 数组 (跟 MY 一样, 一次原子提交)
    let ozonStocks = null;
    if (rawStocks && rawStocks.length) {
      ozonStocks = await normalizeStocksForStore(rawStocks, storeId, req.user.id);
    }

    const ozonPayload = { items: [item] };
    if (ozonStocks && ozonStocks.length) ozonPayload.stocks = ozonStocks;

    const data = await callOzonSellerAPI("/v3/product/import", ozonPayload, { storeId, userId: req.user.id });
    const taskId = data?.result?.task_id || data?.task_id || "";

    // 写入上架历史
    if (db && req.user?.id && taskId) {
      try {
        const placeholderTaskId = String(req.body?.meta?.listingPlaceholderTaskId || req.body?.meta?.placeholderTaskId || "").trim();
        const historyPayload = JSON.stringify({ item, source_item: sourceVariant || null, collect_meta: collectMeta || null, no_brand_mode: noBrandMode, stocks: ozonStocks || rawStocks || [], submitted_at: new Date().toISOString(), placeholder_task_id: placeholderTaskId });
        let updatedPlaceholder = { rowCount: 0 };
        if (placeholderTaskId) {
          updatedPlaceholder = await db.query(
            `UPDATE app_listing_history
                SET task_id = $1,
                    offer_id = $2,
                    product_name = $3,
                    main_image = $4,
                    price_rub = $5,
                    status = 'processing',
                    raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $6::jsonb,
                    errors_json = '[]'::jsonb,
                    updated_at = now()
              WHERE user_id = $7 AND store_id = $8 AND task_id = $9
                AND NOT EXISTS (
                  SELECT 1 FROM app_listing_history existing
                   WHERE existing.user_id = $7 AND existing.task_id = $1 AND existing.task_id <> $9
                )`,
            [
              String(taskId),
              String(item.offer_id || ""),
              String(item.name || ""),
              String(item.primary_image || (Array.isArray(item.images) ? item.images[0] : "") || ""),
              item.price ? Number(item.price) : null,
              historyPayload,
              req.user.id,
              storeId || null,
              placeholderTaskId,
            ],
          );
        }
        if (!updatedPlaceholder.rowCount) {
          await db.query(
            `INSERT INTO app_listing_history (user_id, store_id, task_id, offer_id, product_name, main_image, price_rub, raw_payload)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
             ON CONFLICT (task_id) DO NOTHING`,
            [
              req.user.id,
              storeId || null,
              String(taskId),
              String(item.offer_id || ""),
              String(item.name || ""),
              String(item.primary_image || (Array.isArray(item.images) ? item.images[0] : "") || ""),
              item.price ? Number(item.price) : null,
              historyPayload,
            ],
          );
        }
      } catch (e) { console.error("[listing-history] insert failed:", e.message); }

      const collectId = String(req.body?.meta?.collectId || "").trim();
      if (collectId) {
        try {
          await db.query(
            `UPDATE collect_items
                SET status = 'uploaded', linked_offer_id = $1, updated_at = now()
              WHERE id = $2 AND user_id = $3`,
            [String(item.offer_id || ""), collectId, req.user.id],
          );
        } catch (e) { console.error("[collect-items] mark uploaded failed:", e.message); }
      }
    }

    res.json({ success: true, data, taskId });
  } catch (error) {
    res.status(error.statusCode || 502).json({ success: false, error: error.message, payload: error.payload || null });
  }
});

/**
 * v2.2.6: 批量写库存到指定仓库 — 用 Ozon /v2/products/stocks (新版本, /v1/product/import-stocks 已 404)
 *   入参: { store_id, stocks: [{ offer_id, stock, warehouse_id }] }
 *   Ozon /v2/products/stocks 入参:
 *     { stocks: [{ offer_id, stock, warehouse_id? }] }
 *   注意: 字段是 stock 不是 stocks
 */
app.post("/api/seller/products/import-stocks", requireAuth, async (req, res) => {
  try {
    const { store_id: storeId, stocks } = req.body || {};
    if (!storeId) return res.status(400).json({ success: false, error: "缺少 store_id" });
    if (!Array.isArray(stocks) || !stocks.length) return res.status(400).json({ success: false, error: "缺少 stocks 数组" });
    // 规范化: 过滤无效, 转 int, warehouse_id 字符串
    const norm = stocks
      .filter(s => s && s.offer_id && (Number(s.stock ?? s.stocks) >= 0))
      .map(s => ({
        offer_id: String(s.offer_id),
        stock: parseInt(s.stock ?? s.stocks, 10),
        ...(Number(s.warehouse_id) > 0 ? { warehouse_id: Number(s.warehouse_id) } : {}),
      }));
    if (!norm.length) return res.status(400).json({ success: false, error: "stocks 全无效" });

    const data = await callOzonSellerAPI("/v2/products/stocks", { stocks: norm }, { storeId, userId: req.user.id });
    const taskId = data?.result?.task_id || data?.task_id || "";
    res.json({ success: true, data, taskId, count: norm.length });
  } catch (error) {
    res.status(error.statusCode || 502).json({ success: false, error: error.message, payload: error.payload || null });
  }
});

/* ============================================================
   采集箱（02-collect-box.md）
   - 粘 Ozon 链接 / SKU 批量入箱
   - 状态：pending → scraped → uploaded / failed / ignored
   - "送入上架" = 在 UI 端把行数据带入 /products/upload
   ============================================================ */

function requireDb(res) {
  if (!db) {
    res.status(503).json({ success: false, error: "服务端未配置 DATABASE_URL，采集箱需要数据库支持。" });
    return false;
  }
  return true;
}

function parseCollectInputs(text) {
  const rows = String(text || "").split(/[\r\n,;\s]+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const raw of rows) {
    let sourceType = "manual";
    let ozonUrl = "";
    let ozonSku = "";
    if (/^https?:\/\/.*ozon\./i.test(raw)) {
      sourceType = "ozon_url";
      ozonUrl = raw;
      const skuMatch = raw.match(/\/product\/(\d+)(?:\/|\?|$)/) || raw.match(/\/product\/[^/]*-(\d+)(?:\/|\?|$)/) || raw.match(/[?&]sku=(\d+)/) || raw.match(/-(\d{6,})(?:\/|\?|$)/);
      if (skuMatch) ozonSku = skuMatch[1];
    } else if (/^\d{6,}$/.test(raw)) {
      sourceType = "ozon_sku";
      ozonSku = raw;
      ozonUrl = `https://www.ozon.ru/product/${raw}/`;
    } else {
      continue; // 跳过不合法的行
    }
    out.push({ sourceType, sourceValue: raw, ozonUrl, ozonSku });
  }
  return out;
}

app.delete("/api/collect-items/:id", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const r = await db.query("DELETE FROM collect_items WHERE id = $1 AND user_id = $2 RETURNING id", [req.params.id, req.user.id]);
    if (!r.rowCount) { res.status(404).json({ success: false, error: "找不到该采集项" }); return; }
    res.json({ success: true });
  } catch (error) { next(error); }
});

app.post("/api/collect-items/:id", requireAuth, async (req, res, next) => {
  if (req.params.id === "bulk-delete") return next();
  if (!requireDb(res)) return;
  try {
    const allowed = [
      "status", "note", "title", "main_image", "images", "price_cny", "price_rub",
      "seller", "brand", "linked_offer_id", "source_url_1688", "description",
      "weight", "depth", "width", "height", "attributes"
    ];
    const sets = [];
    const args = [];
    for (const key of allowed) {
      if (req.body?.[key] !== undefined) {
        let val = req.body[key];
        if (key === "status" && !["pending", "scraped", "uploaded", "failed", "ignored"].includes(String(val))) {
          return res.status(400).json({ success: false, error: "无效采集状态" });
        }
        if (["images", "attributes"].includes(key) && typeof val === "object") {
          val = JSON.stringify(val);
        }
        args.push(val);
        sets.push(`${key} = $${args.length}`);
        if (key === "status") {
          sets.push(`status_log = COALESCE(status_log,'[]'::jsonb) || jsonb_build_array(jsonb_build_object('from',status,'to',$${args.length}::text,'reason','人工更新','at',now()))`);
        }
      }
    }
    if (!sets.length) { res.status(400).json({ success: false, error: "没有可更新字段" }); return; }
    sets.push(`updated_at = now()`);
    args.push(req.params.id, req.user.id);
    const r = await db.query(
      `UPDATE collect_items SET ${sets.join(", ")} WHERE id = $${args.length - 1} AND user_id = $${args.length} RETURNING id, status, updated_at`,
      args,
    );
    if (!r.rowCount) { res.status(404).json({ success: false, error: "找不到该采集项" }); return; }
    res.json({ success: true, item: r.rows[0] });
  } catch (error) { next(error); }
});

app.put("/api/collect-items/:id", requireAuth, async (req, res, next) => {
  // Express 只按 method 匹配路由；显式切换为 POST 后复用同一更新处理器。
  req.method = "POST";
  return app._router.handle(req, res, next);
});

app.post("/api/collect-items/:id/retry", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const itemResult = await client.query(
      `SELECT id, store_id, ozon_url, status FROM collect_items WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [req.params.id, req.user.id],
    );
    if (!itemResult.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, error: "找不到该采集项" }); }
    const item = itemResult.rows[0];
    if (item.status === "uploaded") { await client.query("ROLLBACK"); return res.status(409).json({ success: false, error: "已上架记录不能重新采集" }); }
    if (!item.ozon_url) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, error: "该记录没有有效 Ozon 链接" }); }
    const jobResult = await client.query(
      `INSERT INTO app_jobs (id, user_id, store_id, kind, status, phase, total, processed, payload)
       VALUES (gen_random_uuid(),$1,$2,'run','queued','等待采集端领取',1,0,$3::jsonb) RETURNING id`,
      [req.user.id, item.store_id, JSON.stringify({
        urls: [item.ozon_url],
        urlRows: [{ url: item.ozon_url, sourceRow: 1, collectId: item.id }],
        options: { enable1688: false, enableAI: false, collectionOnly: true },
      })],
    );
    await client.query(
      `UPDATE collect_items SET status='pending', note='', linked_job_id=$1,
         status_log=COALESCE(status_log,'[]'::jsonb) || jsonb_build_array(jsonb_build_object('from',status,'to','pending','reason','人工重试','job_id',$1,'at',now())),
         updated_at=now() WHERE id=$2 AND user_id=$3`,
      [jobResult.rows[0].id, item.id, req.user.id],
    );
    await client.query("COMMIT");
    res.json({ success: true, job_id: jobResult.rows[0].id });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally { client.release(); }
});

app.post("/api/collect-items/bulk-delete", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
    if (!ids.length) { res.status(400).json({ success: false, error: "ids 不能为空" }); return; }
    const r = await db.query(`DELETE FROM collect_items WHERE user_id = $1 AND id = ANY($2::uuid[]) RETURNING id`, [req.user.id, ids]);
    res.json({ success: true, deleted: r.rowCount });
  } catch (error) { next(error); }
});

/* ============================================================
   订单本地备注（11-order-management.md 基础版）
   ============================================================ */

app.get("/api/seller/orders/notes", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const numbers = String(req.query.numbers || "").split(",").map((s) => s.trim()).filter(Boolean);
    const storeId = String(req.query.store_id || "").trim();
    if (!storeId) return res.status(400).json({ success: false, error: "未选择店铺" });
    if (!numbers.length) { res.json({ success: true, notes: {} }); return; }
    const r = await db.query(
      `SELECT posting_number, note, updated_at FROM order_notes
       WHERE user_id = $1 AND store_id = $2 AND posting_number = ANY($3::text[])`,
      [req.user.id, storeId, numbers],
    );
    const notes = {};
    for (const row of r.rows) notes[row.posting_number] = { note: row.note, updated_at: row.updated_at };
    res.json({ success: true, notes });
  } catch (error) { next(error); }
});

app.post("/api/seller/orders/:postingNumber/note", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const pn = String(req.params.postingNumber || "").trim();
    const storeId = req.body?.store_id || req.body?.storeId;
    if (!pn) { res.status(400).json({ success: false, error: "缺少 posting_number" }); return; }
    if (!storeId) return res.status(400).json({ success: false, error: "未选择店铺" });
    const note = String(req.body?.note || "").slice(0, 2000);
    const r = await db.query(
      `INSERT INTO order_notes (user_id, store_id, posting_number, note) VALUES ($1, $2, $3, $4)
       ON CONFLICT (store_id, posting_number) DO UPDATE SET note = EXCLUDED.note, user_id = EXCLUDED.user_id, updated_at = now()
       RETURNING posting_number, note, updated_at`,
      [req.user.id, storeId, pn, note],
    );
    res.json({ success: true, note: r.rows[0] });
  } catch (error) { next(error); }
});

app.post("/api/seller/orders/:postingNumber/source", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  const client = await db.connect();
  try {
    const postingNumber = String(req.params.postingNumber || "").trim();
    const storeId = String(req.body?.store_id || req.body?.storeId || "").trim();
    const offerId = String(req.body?.offer_id || "").trim();
    const outboundCostCny = Number(req.body?.outbound_cost_cny ?? req.body?.purchase_price_cny);
    const sourceUrl = String(req.body?.source_url_1688 || "").trim();
    if (!postingNumber) return res.status(400).json({ success: false, error: "缺少 posting_number" });
    if (!storeId || !offerId) return res.status(400).json({ success: false, error: "店铺和货号必填" });
    if (!Number.isFinite(outboundCostCny) || outboundCostCny < 0 || outboundCostCny > 1000000) {
      return res.status(400).json({ success: false, error: "请输入有效出单总成本" });
    }
    if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) {
      return res.status(400).json({ success: false, error: "货源链接必须以 http:// 或 https:// 开头" });
    }

    await client.query("BEGIN");
    const current = await client.query(
      `SELECT id, purchase_price_cny, source_url_1688
         FROM app_products
        WHERE user_id = $1 AND store_id = $2 AND offer_id = $3
        FOR UPDATE`,
      [req.user.id, storeId, offerId],
    );
    if (!current.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, error: "商品不存在，请先同步商品列表" });
    }
    const productId = current.rows[0].id;
    const productRes = await client.query(
      `UPDATE app_products
          SET source_url_1688 = $1,
              updated_at = now()
        WHERE id = $2 AND user_id = $3
        RETURNING offer_id, name, image, purchase_price_cny, source_url_1688`,
      [sourceUrl, productId, req.user.id],
    );
    await client.query(
      `UPDATE collect_items
          SET source_url_1688 = $1,
              updated_at = now()
        WHERE linked_offer_id = $2 AND user_id = $3`,
      [sourceUrl, offerId, req.user.id],
    );
    await client.query(
      `INSERT INTO app_order_costs
        (user_id, store_id, posting_number, offer_id, source_url_1688, outbound_cost_cny, note, changed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$1)
       ON CONFLICT (store_id, posting_number) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         offer_id = EXCLUDED.offer_id,
         source_url_1688 = EXCLUDED.source_url_1688,
         outbound_cost_cny = EXCLUDED.outbound_cost_cny,
         note = EXCLUDED.note,
         changed_by = EXCLUDED.changed_by,
         updated_at = now()`,
      [req.user.id, storeId, postingNumber, offerId, sourceUrl, outboundCostCny, `订单 ${postingNumber} 编辑出单总成本`],
    );

    const cacheRes = await client.query(
      `SELECT payload FROM app_order_cache
        WHERE user_id = $1 AND store_id = $2 AND posting_number = $3
        FOR UPDATE`,
      [req.user.id, storeId, postingNumber],
    );
    let updatedOrder = null;
    if (cacheRes.rowCount) {
      const payload = cacheRes.rows[0].payload || {};
      const products = Array.isArray(payload.products) ? payload.products : [];
      for (const product of products) {
        if (String(product.offer_id || "") !== offerId) continue;
        product.source_url_1688 = sourceUrl;
      }
      const rateResult = await client.query(
        `SELECT rate FROM app_exchange_rates
          WHERE base_currency = 'RUB' AND quote_currency = 'CNY'
          ORDER BY effective_at DESC LIMIT 1`,
      );
      const effectiveRubCnyRate = Number(rateResult.rows[0]?.rate || RUB_CNY_RATE);
      const money = (value) => Math.round(Number(value || 0) * 100) / 100;
      const financialToCny = (value, currency) => {
        const amount = Number(value || 0);
        if (!Number.isFinite(amount)) return 0;
        const code = String(currency || "").trim().toUpperCase();
        if (code === "RUB") return amount * effectiveRubCnyRate;
        return amount;
      };
      const logisticsServiceCny = (services, currency) => Object.entries(services || {}).reduce((sum, [key, value]) => {
        const serviceKey = String(key || "").toLowerCase();
        if (!/fulfillment|pickup|dropoff|deliv|delivery|trans|return|flow|last/.test(serviceKey)) return sum;
        return sum + Math.abs(financialToCny(value, currency));
      }, 0);
      const fdProducts = Array.isArray(payload?.financial_data?.products) ? payload.financial_data.products : [];
      for (const product of products) {
        const fd = fdProducts.find((item) => String(item.product_id) === String(product.sku)) || {};
        const qty = Number(product.quantity || fd.quantity || 1);
        const financialCurrency = String(fd.currency_code || product.financial_currency_code || "RUB").toUpperCase();
        const commissionCny = Math.abs(financialToCny(fd.commission_amount ?? product.commission_amount ?? product.commission_cny ?? 0, financialCurrency));
        const lastMileCny = logisticsServiceCny(fd.item_services || fd.services || {}, financialCurrency);
        const payoutCny = Math.abs(financialToCny(fd.payout ?? product.payout_native ?? product.payout_cny ?? 0, financialCurrency));
        product.financial_currency_code = financialCurrency;
        product.commission_cny = money(commissionCny * qty);
        product.last_mile_cny = money(lastMileCny * qty);
        product.payout_cny = money(payoutCny * qty);
      }
      const totalCny = Number(payload.total_cny || 0);
      const commissionCny = products.reduce((sum, product) => sum + Math.abs(Number(product.commission_cny || 0)), 0);
      const payoutCny = products.reduce((sum, product) => sum + Math.abs(Number(product.payout_cny || 0)), 0);
      const rawLastMileCny = products.reduce((sum, product) => sum + Math.abs(Number(product.last_mile_cny || 0)), 0);
      const lastMileCny = rawLastMileCny > 0 ? rawLastMileCny : Math.max(0, totalCny - payoutCny - commissionCny);
      const ozonCostCny = commissionCny + lastMileCny;
      const delivered = String(payload.status || "").toLowerCase() === "delivered";
      payload.commission_cny = money(commissionCny);
      payload.last_mile_cny = money(lastMileCny);
      payload.ozon_cost_cny = money(ozonCostCny);
      payload.outbound_cost_cny = money(outboundCostCny);
      payload.profit_cny = delivered ? money(totalCny - ozonCostCny - outboundCostCny) : null;
      payload.profit_calculable = delivered;
      payload.profit_block_reason = delivered ? "" : "仅已送达订单可计算利润";
      await client.query(
        `UPDATE app_order_cache
            SET payload = $1::jsonb,
                updated_at = now()
          WHERE user_id = $2 AND store_id = $3 AND posting_number = $4`,
        [JSON.stringify(payload), req.user.id, storeId, postingNumber],
      );
      updatedOrder = payload;
    }

    await client.query("COMMIT");
    const product = productRes.rows[0];
    res.json({
      success: true,
      product: {
        ...product,
        purchase_price_cny: Number(product.purchase_price_cny || 0),
        outbound_cost_cny: Math.round(outboundCostCny * 100) / 100,
        source_url_1688: product.source_url_1688 || "",
      },
      order: updatedOrder,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally { client.release(); }
});

app.post("/api/seller/orders/export", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const storeId = req.body?.store_id || req.body?.storeId;
    if (!storeId) return res.status(400).json({ success: false, error: "未选择店铺" });
    const status = String(req.body?.status || "").trim();
    const limit = Math.min(1000, Math.max(1, Number(req.body?.limit || 200)));
    const filter = {
      since: req.body?.since || new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString(),
      to: req.body?.to || new Date().toISOString(),
    };
    if (status && status.toLowerCase() !== "all") filter.status = status;
    const data = await callOzonSellerAPI("/v3/posting/fbs/list", {
      filter, limit, with: { financial_data: true, analytics_data: true },
    }, { storeId, userId: req.user.id });
    const postings = data?.result?.postings || [];

    // 本地备注补充
    let notesMap = {};
    if (db && postings.length) {
      const nums = postings.map((p) => p.posting_number).filter(Boolean);
      if (nums.length) {
        const nr = await db.query(
          `SELECT posting_number, note FROM order_notes WHERE user_id = $1 AND store_id = $2 AND posting_number = ANY($3::text[])`,
          [req.user.id, storeId, nums],
        );
        for (const r of nr.rows) notesMap[r.posting_number] = r.note;
      }
    }

    const offerIds = [...new Set(postings.flatMap((posting) => (posting.products || []).map((product) => product.offer_id).filter(Boolean)))];
    const productMeta = new Map();
    if (offerIds.length) {
      const metaRows = await db.query(
        `SELECT offer_id, purchase_price_cny, source_url_1688 FROM app_products
          WHERE user_id=$1 AND store_id=$2 AND offer_id=ANY($3::text[])`,
        [req.user.id, storeId, offerIds],
      );
      for (const row of metaRows.rows) productMeta.set(row.offer_id, row);
    }

    // 订单级履约 CSV，保留 Ozon 原始金额与本地采购信息，便于财务复核。
    const header = ["货件号", "订单号", "状态", "创建时间", "发货截止", "实际发货时间", "配送方式", "仓库", "买家城市", "收货地址", "商品", "货号", "SKU", "数量", "结算币种", "商品金额", "平台佣金", "平台到手", "采购成本(CNY)", "1688货源", "本地备注"];
    const rows = [header];
    for (const p of postings) {
      const prods = p.products || [];
      const summary = prods.map((x) => x.name).slice(0, 3).join(" / ");
      const skus = prods.map((x) => x.sku || x.offer_id).join(",");
      const offers = prods.map((x) => x.offer_id).filter(Boolean);
      const qty = prods.reduce((a, x) => a + (x.quantity || 0), 0);
      const dm = p.delivery_method || {};
      const financialProducts = p.financial_data?.products || [];
      const nativeAmount = prods.reduce((sum, product) => sum + Number(product.price || 0) * Number(product.quantity || 1), 0);
      const commission = financialProducts.reduce((sum, product) => sum + Number(product.commission_amount || 0) * Number(product.quantity || 1), 0);
      const payout = financialProducts.reduce((sum, product) => sum + Number(product.payout || 0) * Number(product.quantity || 1), 0);
      const purchaseCost = prods.reduce((sum, product) => sum + Number(productMeta.get(product.offer_id)?.purchase_price_cny || 0) * Number(product.quantity || 1), 0);
      const address = p.customer?.address || p.addressee || p.address || {};
      rows.push([
        p.posting_number || "",
        p.order_number || "",
        p.status || "",
        p.in_process_at || p.created_at || "",
        p.shipment_date || "",
        p.delivering_date || p.shipped_at || "",
        dm.name || "",
        p.warehouse || dm.warehouse || (dm.warehouse_id ? `#${dm.warehouse_id}` : ""),
        address.city || p.customer?.address?.city || "",
        address.address_tail || address.address || address.comment || "",
        summary,
        offers.join(","),
        skus,
        qty,
        prods[0]?.currency_code || financialProducts[0]?.currency_code || "",
        nativeAmount,
        commission,
        payout,
        purchaseCost,
        offers.map((offerId) => productMeta.get(offerId)?.source_url_1688 || "").filter(Boolean).join(" | "),
        notesMap[p.posting_number] || "",
      ]);
    }
    const csv = rows.map((row) => row.map((cell) => {
      const s = String(cell ?? "");
      return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    }).join(",")).join("\r\n");
    const bom = "\ufeff"; // Excel 打开 UTF-8 需要 BOM
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="orders-${Date.now()}.csv"`);
    res.send(bom + csv);
  } catch (error) { res.status(error.statusCode || 502).json({ success: false, error: error.message }); }
});

/* ============================================================
   AI 商品套图历史（10-ai-product-images.md 基础版）
   ============================================================ */

app.get("/api/ai-images/history", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 30)));
    const offset = Math.max(0, Number(req.query.offset || 0));
    const storeId = String(req.query.store_id || "").trim();
    const args = [req.user.id];
    let storeWhere = "";
    if (storeId) { args.push(storeId); storeWhere = ` AND store_id = $${args.length}`; }
    const r = await db.query(
      `SELECT id, model, prompt, aspect_ratio, n, has_ref_image, image_urls,
              estimated_cost_usd, scene_preset, offer_id, ozon_sync_status, ozon_synced_at, created_at
         FROM ai_image_records WHERE user_id = $1${storeWhere}
         ORDER BY created_at DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, limit, offset],
    );
    const stat = await db.query(
      `SELECT count(*)::int AS total,
              COALESCE(SUM(n),0)::int AS total_images,
              COALESCE(SUM(estimated_cost_usd),0)::numeric AS total_cost_usd
         FROM ai_image_records WHERE user_id = $1${storeWhere}`,
      args,
    );
    res.json({ success: true, items: r.rows, stats: stat.rows[0] });
  } catch (error) { next(error); }
});

app.delete("/api/ai-images/:id", requireAuth, async (req, res, next) => {
  if (!requireDb(res)) return;
  try {
    const r = await db.query("DELETE FROM ai_image_records WHERE id = $1 AND user_id = $2 RETURNING id", [req.params.id, req.user.id]);
    if (!r.rowCount) { res.status(404).json({ success: false, error: "找不到" }); return; }
    res.json({ success: true });
  } catch (error) { next(error); }
});

app.post("/api/jobs", async (req, res, next) => {
  const queueSingleSourcing = DISABLE_SERVER_SCRAPER && db && !SERVER_SINGLE_SOURCING;
  if (DISABLE_SERVER_SCRAPER && !db && !SERVER_SINGLE_SOURCING) {
    res.status(409).json({ success: false, error: "服务器端已禁用直接采集。后续会通过你电脑上的本机采集端执行任务。" });
    return;
  }
  try {
    const allUrlRows = parseUrlRows(req.body.urlsText || "");
    if (!allUrlRows.length) {
      res.status(400).json({ success: false, error: "没有识别到 Ozon 链接。" });
      return;
    }
    const startRow = clampInt(req.body.startRow, 1, 999999, 1);
    const urlRows = allUrlRows.filter((entry) => entry.sourceRow >= startRow);
    if (!urlRows.length) {
      res.status(400).json({ success: false, error: `从第 ${startRow} 行往后没有识别到 Ozon 链接。` });
      return;
    }
    const urls = urlRows.map((entry) => entry.url);

    const id = crypto.randomUUID();
    const storeId = String(req.body.store_id || req.body.storeId || req.query.store_id || req.query.storeId || "").split(",")[0].trim();
    if (storeId && db) {
      await assertActiveStoreAccess(storeId, req.user.id, "id");
    }
    const job = {
      id,
      storeId,
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: queueSingleSourcing ? "等待本机采集端领取" : "等待开始",
      kind: "run",
      total: urls.length,
      sourceTotal: allUrlRows.length,
      sourceStartRow: startRow,
      inputUrlRows: urlRows,
      resumeFromRow: null,
      resumeFile: null,
      processed: 0,
      consecutiveFailures: 0,
      logs: [],
      verification: null,
      results: [],
      error: null,
      downloadUrl: null,
      cancelRequested: false,
    };
    const delayMinMs = clampInt(req.body.delayMinMs ?? req.body.delayMs, 1000, 120000, DEFAULT_DELAY_MIN_MS);
    const delayMaxMs = Math.max(
      delayMinMs,
      clampInt(req.body.delayMaxMs ?? req.body.delayMs, 1000, 120000, DEFAULT_DELAY_MAX_MS),
    );

    const options = {
      urls,
      urlRows,
      startRow,
      sourceTotal: allUrlRows.length,
      maxCandidates: clampInt(req.body.maxCandidates, 1, 20, 5),
      storeId,
      enable1688: req.body.enable1688 !== false,
      enableAI: req.body.enableAI !== false,
      delayMinMs,
      delayMaxMs,
      maxConsecutiveFailures: clampInt(req.body.maxConsecutiveFailures, 1, 20, DEFAULT_MAX_CONSECUTIVE_FAILURES),
      headless: req.body.headless === true,
    };

    if (queueSingleSourcing) {
      const activeJob = await findActiveDbJobForUser(req.user, { kind: "run", storeId });
      if (activeJob) {
        res.json({ success: true, jobId: activeJob.id, queued: activeJob.status === "queued", existing: true, job: activeJob });
        return;
      }
      const queued = await createQueuedDbJob(req.user, job, {
        urls,
        urlRows,
        storeId,
        options,
        raw: { urlsText: req.body.urlsText || "" },
      });
      res.json({ success: true, jobId: queued.id, queued: true, job: queued });
      return;
    }

    jobs.set(id, job);

    runJob(job, options).catch(async (error) => {
      if (job.status === "canceled") {
        await writeJobArtifacts(job).catch(() => {});
        return;
      }
      job.status = "error";
      job.error = error.message;
      job.phase = "任务失败";
      log(job, `任务失败：${error.message}`, "error");
      notifyUser("采集任务失败", error.message);
      await writeJobArtifacts(job).catch(() => {});
    });

    res.json({ success: true, jobId: id });
  } catch (error) {
    next(error);
  }
});

app.post("/api/batch-ozon/jobs", async (req, res, next) => {
  if (DISABLE_SERVER_SCRAPER && !db) {
    res.status(409).json({ success: false, error: "服务器端已禁用直接采集。后续会通过你电脑上的本机采集端执行任务。" });
    return;
  }
  try {
    const sourceUrl = parseFirstOzonUrl(req.body.sourceUrl || "");
    if (!sourceUrl) {
      res.status(400).json({ success: false, error: "没有识别到 Ozon 店铺链接或商品链接。" });
      return;
    }

    const id = crypto.randomUUID();
    const job = {
      id,
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: DISABLE_SERVER_SCRAPER ? "等待本机采集端领取" : "等待开始",
      kind: "batch-ozon",
      sourceUrl,
      total: 0,
      processed: 0,
      consecutiveFailures: 0,
      logs: [],
      verification: null,
      results: [],
      error: null,
      downloadUrl: null,
      cancelRequested: false,
    };
    jobs.set(id, job);

    const delayMinMs = clampInt(req.body.delayMinMs ?? req.body.delayMs, 1000, 120000, DEFAULT_DELAY_MIN_MS);
    const delayMaxMs = Math.max(
      delayMinMs,
      clampInt(req.body.delayMaxMs ?? req.body.delayMs, 1000, 120000, DEFAULT_DELAY_MAX_MS),
    );

    const options = {
      sourceUrl,
      maxProducts: clampInt(req.body.maxProducts, 1, 500, 50),
      delayMinMs,
      delayMaxMs,
      maxConsecutiveFailures: clampInt(req.body.maxConsecutiveFailures, 1, 20, DEFAULT_MAX_CONSECUTIVE_FAILURES),
      headless: req.body.headless === true,
      filters: normalizeBatchOzonFilters(req.body.filters || {}),
    };

    if (DISABLE_SERVER_SCRAPER && db) {
      const queued = await createQueuedDbJob(req.user, { ...job, total: options.maxProducts, sourceTotal: options.maxProducts, sourceStartRow: 1 }, {
        sourceUrl,
        options,
        raw: { sourceUrl: req.body.sourceUrl || "" },
      });
      res.json({ success: true, jobId: queued.id, queued: true });
      return;
    }

    runBatchOzonJob(job, options).catch(async (error) => {
      if (job.status === "canceled") {
        await writeJobArtifacts(job).catch(() => {});
        return;
      }
      job.status = "error";
      job.error = error.message;
      job.phase = "批量采集失败";
      log(job, `批量采集失败：${error.message}`, "error");
      notifyUser("批量采集失败", error.message);
      await writeJobArtifacts(job).catch(() => {});
    });

    res.json({ success: true, jobId: id });
  } catch (error) {
    next(error);
  }
});

app.get("/api/jobs/:id", async (req, res, next) => {
  try {
    // v2.2.9.100: light=1 供前端进度轮询 — 不返回大 results JSONB（只给数量），
    //   避免 5s 轮询每次都传输几 MB 的 77 行结果数据
    const light = String(req.query.light || "").trim() === "1" || String(req.query.light || "").trim() === "true";
    const truncateForLight = (job) => {
      if (!job || !light) return job;
      const resultCount = Array.isArray(job.results) ? job.results.length : Number(job.processed || 0);
      return { ...job, results: [], resultsTruncated: true, resultCount };
    };
    if (db) {
      const job = await getDbJobForUser(req.params.id, req.user);
      if (job) {
        res.json({ success: true, job: truncateForLight(job) });
        return;
      }
    }
    const runtimeJob = jobs.get(req.params.id);
    if (runtimeJob) {
      res.json({ success: true, job: truncateForLight(serializeJob(runtimeJob)) });
      return;
    }
    const storedJob = await loadStoredJob(req.params.id);
    if (!storedJob) {
      res.status(404).json({ success: false, error: "任务不存在。" });
      return;
    }
    res.json({ success: true, job: truncateForLight(storedJob) });
  } catch (error) {
    next(error);
  }
});

// Single-sourcing review API. The review page lets operators confirm the
// Ozon-1688 match and then rebuild the latest logistics workbook.
app.get("/api/jobs/:id/review", async (req, res, next) => {
  try {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let job = null;
    if (db) {
      if (!uuidRe.test(req.params.id)) {
        res.status(404).json({ success: false, error: "任务不存在。" });
        return;
      }
      job = await getDbJobForUser(req.params.id, req.user);
    } else {
      job = jobs.get(req.params.id) || null;
    }
    if (!job) {
      res.status(404).json({ success: false, error: "任务不存在。" });
      return;
    }

    const results = Array.isArray(job.results) ? job.results : [];
    const fallbackImagesBySourceRow = await loadAutoListingFallbackImagesForJob(job);
    const rows = [];
    const candidateRows = [];
    for (const r of results) {
      const ozon = r.ozon || {};
      const aiReview = r.aiReview || {};
      const selected = r.selectedCandidate || aiReview?.selected_candidate || {};
      const candidates = Array.isArray(r.candidates) ? r.candidates : [];
      const ozonPriceRub = Number(ozon.priceRub ?? ozon.price ?? ozon.priceRubValue ?? 0);
      const selectedRank = Number(selected.rank ?? aiReview?.selected_rank ?? 0);
      const rawOzonImage = ozon.mainImage?.url || ozon.mainImageUrl || ozon.image || "";
      const fallbackOzonImage = fallbackImagesBySourceRow.get(Number(r.sourceRow || 0)) || "";
      rows.push({
        sourceRow: r.sourceRow,
        confirmed: Boolean(r.confirmed),
        selectedRank: selectedRank || "",
        aiDecision: aiReview.decision || r.aiDecision || "none",
        aiReason: aiReview.reason || aiReview.summary || r.aiReason || "",
        ozonTitle: ozon.title || "",
        ozonImage: isLikelyOzonMarketingImage(rawOzonImage) && fallbackOzonImage ? fallbackOzonImage : rawOzonImage,
        ozonUrl: r.url || "",
        ozonSku: ozon.offerId || ozon.sku || "",
        ozonPrice: ozonPriceRub || "",
        ozonBlackPrice: ozon.blackPriceRub ?? ozonPriceRub ?? "",
        ozonWeight: ozon.weightG ?? ozon.weight ?? "",
        aiEstimatedWeight: aiReview.estimated_weight_g ?? ozon.weightG ?? "",
        ozonPackQuantity: aiReview.ozon_pack_quantity ?? ozon.packQuantity ?? 1,
        candidateTitle: selected.title || "",
        candidateImage: selected.image || "",
        candidateUrl: selected.url || "",
        purchasePriceRmb: selected.priceCny ?? selected.price ?? "",
        candidatePriceDetails: selected.priceDetails || "",
        estimatedPurchasePriceRmb: selected.estimatedPurchasePriceRmb ?? "",
        manualPurchasePriceRmb: r.manualPurchasePriceRmb ?? "",
        purchaseMultiplier: selected.purchaseMultiplier ?? aiReview.purchase_multiplier ?? "",
        candidatePackQuantity: selected.packQuantity ?? aiReview.selected_candidate_pack_quantity ?? "",
        candidateMoq: selected.moq ?? "",
        candidateFreight: selected.freightCny ?? selected.freight ?? "",
        manualFreightRmb: r.manualFreightRmb ?? "",
        candidateDimensions: selected.dimensions ?? "",
        candidateWeight: selected.weightG ?? "",
        manualWeightG: r.manualWeightG ?? "",
        listingPriceRub: r.listingPriceRub ?? ozonPriceRub ?? "",
        note: r.note || "",
      });
      candidates.forEach((c, idx) => {
        candidateRows.push({
          sourceRow: r.sourceRow,
          rank: c.rank ?? idx + 1,
          title: c.title || "",
          image: c.image || c.pic || "",
          url: c.url || c.offerUrl || "",
          price: c.priceCny ?? c.price ?? "",
          priceDetails: c.priceDetails || "",
          moq: c.moq ?? "",
          freight: c.freightCny ?? c.freight ?? "",
          weight: c.weightG ?? c.weight ?? "",
          dimensions: c.dimensions || "",
          risk: c.risk || "",
          aiReason: c.aiReason || "",
          aiDecision: c.aiDecision || c.decision || "",
          purchaseMultiplier: c.purchaseMultiplier ?? "",
          estimatedPurchasePriceRmb: c.estimatedPurchasePriceRmb ?? "",
          packQuantity: c.packQuantity ?? "",
        });
      });
    }

    res.json({
      success: true,
      review: {
        job: {
          id: job.id,
          status: job.status,
          processed: job.processed,
          total: job.total || job.sourceTotal,
          updatedAt: job.updatedAt || job.updated_at,
          firstUrl: job.payload?.urls?.[0] || job.inputUrlRows?.[0]?.url || "",
        },
        rows,
        candidateRows,
        confirmedRows: rows.filter((row) => row.confirmed),
        batchText: "",
      },
    });
  } catch (error) {
    next(error);
  }
});

function isLikelyOzonMarketingImage(url) {
  const text = String(url || "").toLowerCase();
  if (!text) return false;
  return /\/marketing-api\/banners?\//i.test(text)
    || /\/banners?\//i.test(text)
    || /\/brand(?:-|_)?logo/i.test(text)
    || /\/seller(?:-|_)?logo/i.test(text);
}

async function loadAutoListingFallbackImagesForJob(job) {
  const map = new Map();
  if (!db || !job?.owner?.id) return map;
  const urlRows = Array.isArray(job.payload?.urlRows) ? job.payload.urlRows : [];
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const pairs = urlRows
    .map((row) => ({
      sourceRow: Number(row?.sourceRow || 0),
      itemId: String(row?.autoListingItemId || ""),
    }))
    .filter((row) => row.sourceRow > 0 && uuidRe.test(row.itemId));
  if (!pairs.length) return map;
  const ids = pairs.map((row) => row.itemId);
  const rows = await db.query(
    `SELECT id, main_image
       FROM app_auto_listing_items
      WHERE user_id=$1 AND id=ANY($2::uuid[])`,
    [job.owner.id, ids],
  );
  const byId = new Map((rows.rows || []).map((row) => [String(row.id), String(row.main_image || "")]));
  for (const pair of pairs) {
    const image = byId.get(pair.itemId);
    if (image) map.set(pair.sourceRow, image);
  }
  return map;
}

app.post("/api/jobs/:id/review/confirm", async (req, res, next) => {
  try {
    const { rows = [] } = req.body;
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let job = null;
    if (db) {
      if (!uuidRe.test(req.params.id)) {
        res.status(404).json({ success: false, error: "任务不存在。" });
        return;
      }
      job = await getDbJobForUser(req.params.id, req.user);
    } else {
      job = jobs.get(req.params.id) || null;
    }
    if (!job) {
      res.status(404).json({ success: false, error: "任务不存在。" });
      return;
    }

    const results = Array.isArray(job.results) ? job.results : [];
    const byRow = new Map(rows.map((r) => [Number(r.sourceRow), r]));
    for (const r of results) {
      const override = byRow.get(Number(r.sourceRow));
      if (override) {
        r.confirmed = Boolean(override.confirmed);
        r.note = override.note || r.note || "";
        if (override.listingPriceRub != null) r.listingPriceRub = Number(override.listingPriceRub);
        if (override.manualPurchasePriceRmb != null) r.manualPurchasePriceRmb = Number(override.manualPurchasePriceRmb);
        if (override.manualFreightRmb != null) r.manualFreightRmb = Number(override.manualFreightRmb);
        if (override.manualWeightG != null) r.manualWeightG = Number(override.manualWeightG);
      }
    }

    if (db) {
      job = await updateDbJob(req.params.id, { results, phase: "人工核对完成" }) || job;
    } else {
      job.results = results;
      touch(job);
    }
    try {
      job.results = results;
      await writeJobArtifacts(job);
    } catch (error) {
      console.warn("[single-sourcing-review] rebuild artifacts failed:", error?.message || error);
    }

    const confirmed = results
      .filter((r) => r.confirmed)
      .map((r) => {
        const ozon = r.ozon || {};
        const sku = ozon.offerId || ozon.sku || "";
        const price = Number(r.listingPriceRub ?? ozon.priceRub ?? ozon.price ?? 0);
        return { sourceRow: r.sourceRow, ozonSku: sku, listingPriceRub: price };
      });
    const batchText = confirmed
      .filter((c) => c.ozonSku && c.listingPriceRub > 0)
      .map((c) => `${c.ozonSku}\t${Number(c.listingPriceRub).toFixed(2)}`)
      .join("\n");

    res.json({ success: true, confirmed, batchText });
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/:id/cancel", async (req, res, next) => {
  try {
    const runtimeJob = jobs.get(req.params.id);
    if (runtimeJob) {
      runtimeJob.cancelRequested = true;
      log(runtimeJob, "已请求停止，当前商品处理完后会停下。", "warn");
      res.json({ success: true });
      return;
    }
    if (db) {
      const job = await getDbJobForUser(req.params.id, req.user);
      if (!job) {
        res.status(404).json({ success: false, error: "任务不存在。" });
        return;
      }
      if (["done", "error", "canceled"].includes(job.status)) {
        res.json({ success: true });
        return;
      }
      const updated = await updateDbJob(req.params.id, {
        status: "canceled",
        phase: "已停止",
        logs: [...(job.logs || []), makeLogEntry("已请求停止，任务已取消。", "warn")],
      });
      await clearWorkerCurrentJobRefs(req.params.id);
      res.json({ success: true, job: updated });
      return;
    }
    const job = jobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ success: false, error: "任务不存在。" });
      return;
    }
    job.cancelRequested = true;
    log(job, "已请求停止，当前商品处理完后会停下。", "warn");
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/jobs/:id/download", async (req, res, next) => {
  try {
    const runtimeJob = jobs.get(req.params.id);
    const storedJob = runtimeJob ? null : await loadStoredJob(req.params.id);
    if (db && !runtimeJob && !storedJob && !(await getDbJobForUser(req.params.id, req.user))) {
      res.status(404).send("文件不存在");
      return;
    }
    await sendJobDownload(req.params.id, res);
  } catch (error) {
    next(error);
  }
});

app.get("/api/history/:id/download", async (req, res, next) => {
  try {
    const runtimeJob = jobs.get(req.params.id);
    const storedJob = runtimeJob ? null : await loadStoredJob(req.params.id);
    if (db && !runtimeJob && !storedJob && !(await getDbJobForUser(req.params.id, req.user))) {
      res.status(404).send("文件不存在");
      return;
    }
    await sendJobDownload(req.params.id, res);
  } catch (error) {
    next(error);
  }
});

app.get("/api/history", async (req, res) => {
  try {
    const history = db ? await loadDbJobHistory(req.user) : await loadJobHistory();
    res.json({ success: true, ...history });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/worker/jobs/next", async (req, res, next) => {
  try {
    if (!db) {
      res.status(409).json({ success: false, error: "服务器没有启用任务队列。" });
      return;
    }
    const workerName = req.body?.workerName || req.headers["x-worker-name"] || "";
    const kinds = Array.isArray(req.body?.kinds)
      ? req.body.kinds.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 8)
      : [];
    const workerVersion = String(req.body?.version || req.body?.pluginVersion || "").trim();
    const isChromeExtensionWorker = String(req.body?.platform || "").trim() === "chrome-extension";
    const wantsSingleSourcing = !kinds.length || kinds.includes("run");
    const versionTooOld = isChromeExtensionWorker
      && wantsSingleSourcing
      && compareNumericVersion(workerVersion, MIN_SINGLE_SOURCING_PLUGIN_VERSION) < 0;
    const blockedPhase = `插件版本 ${workerVersion || "未知"} 低于单品找货最低版本 v${MIN_SINGLE_SOURCING_PLUGIN_VERSION}，请在店铺管理下载新版插件。`;
    await upsertWorkerHeartbeat(req.user, workerName, {
      version: req.body?.version,
      pluginVersion: req.body?.pluginVersion,
      platform: req.body?.platform,
      hostname: req.body?.hostname,
      profileDir: req.body?.profileDir,
      currentJobId: req.body?.currentJobId,
      currentPhase: versionTooOld ? blockedPhase : (req.body?.currentPhase || "本机采集端在线，可领取任务"),
    });
    if (versionTooOld) {
      res.json({
        success: true,
        job: null,
        blocked: true,
        error: blockedPhase,
        minVersion: MIN_SINGLE_SOURCING_PLUGIN_VERSION,
      });
      return;
    }
    await rescueStaleDbJobsForUser(req.user, { kinds });
    const job = await claimNextDbJob(req.user, workerName, { kinds });
    if (job) {
      await upsertWorkerHeartbeat(req.user, workerName, {
        version: req.body?.version,
        pluginVersion: req.body?.pluginVersion,
        platform: req.body?.platform,
        hostname: req.body?.hostname,
        profileDir: req.body?.profileDir,
        currentJobId: job.id,
        currentPhase: job.phase || "已领取任务",
      });
    }
    res.json({ success: true, job });
  } catch (error) {
    next(error);
  }
});

app.get("/api/worker/status", async (req, res, next) => {
  try {
    if (!db) {
      res.status(409).json({ success: false, error: "服务器没有启用任务队列。" });
      return;
    }
    const requestedStoreId = String(req.query.store_id || req.query.storeId || "").split(",")[0].trim();
    if (requestedStoreId) {
      await assertActiveStoreAccess(requestedStoreId, req.user.id, "id");
    }
    await rescueStaleDbJobsForUser(req.user, { kinds: ["run"] });
    const workersResult = await db.query(
      `SELECT h.worker_name, h.store_id, h.version, h.platform, h.hostname, h.profile_dir,
              CASE WHEN j.status IN ('queued','claimed','running','exporting') THEN h.current_job_id ELSE NULL END AS current_job_id,
              CASE WHEN h.current_job_id IS NOT NULL AND COALESCE(j.status, '') NOT IN ('queued','claimed','running','exporting')
                   THEN COALESCE(NULLIF(j.phase, ''), '任务已结束')
                   ELSE h.current_phase
              END AS current_phase,
              j.id AS job_id,
              j.kind AS job_kind,
              j.status AS job_status,
              j.phase AS job_phase,
              j.total AS job_total,
              j.processed AS job_processed,
              j.source_total AS job_source_total,
              j.source_start_row AS job_source_start_row,
              j.payload AS job_payload,
              j.logs AS job_logs,
              j.results AS job_results,
              j.error AS job_error,
              j.download_url AS job_download_url,
              j.created_at AS job_created_at,
              j.updated_at AS job_updated_at,
              h.last_seen_at
       FROM app_worker_heartbeats h
       LEFT JOIN app_jobs j ON j.id = h.current_job_id AND j.user_id = h.user_id
       WHERE h.user_id = $1
       ORDER BY last_seen_at DESC
       LIMIT 10`,
      [req.user?.id || ""],
    );
    const queueResult = await db.query(
      `SELECT
         count(*) FILTER (WHERE status = 'queued')::int AS queued,
         count(*) FILTER (WHERE status IN ('claimed','running'))::int AS active
       FROM app_jobs
       WHERE user_id = $1
         AND ($2::uuid IS NULL OR store_id = $2::uuid)`,
      [req.user?.id || "", requestedStoreId || null],
    );
    const now = Date.now();
    const onlineWindow = Math.max(30000, WORKER_ONLINE_WINDOW_MS);
    const workers = workersResult.rows.map((row) => {
      const lastSeenAt = row.last_seen_at ? new Date(row.last_seen_at).toISOString() : "";
      const ageMs = lastSeenAt ? now - new Date(lastSeenAt).getTime() : Infinity;
      const currentPhase = row.current_phase || "";
      const version = String(row.version || "").trim();
      const storeId = String(row.store_id || "").trim();
      const storeMatch = !requestedStoreId || storeId === requestedStoreId;
      const versionTooOld = compareNumericVersion(version, MIN_SINGLE_SOURCING_PLUGIN_VERSION) < 0;
      const blockedByPhase = /预览版|暂不领取|不领取任务|未开启领取任务|低于单品找货最低版本|版本\s*未知/i.test(currentPhase);
      const canClaimJobs = storeMatch && !versionTooOld && !blockedByPhase;
      const currentJob = row.current_job_id && row.job_id ? serializeJob({
        id: row.job_id,
        status: row.job_status,
        storeId: row.store_id || "",
        createdAt: row.job_created_at,
        updatedAt: row.job_updated_at,
        phase: row.job_phase || "",
        kind: row.job_kind,
        total: row.job_total || 0,
        sourceTotal: row.job_source_total || 0,
        sourceStartRow: row.job_source_start_row || 1,
        processed: row.job_processed || 0,
        consecutiveFailures: 0,
        logs: Array.isArray(row.job_logs) ? row.job_logs : [],
        verification: null,
        results: Array.isArray(row.job_results) ? row.job_results : [],
        error: row.job_error || "",
        downloadUrl: row.job_download_url || "",
        cancelRequested: undefined,
        payload: row.job_payload || {},
      }) : null;
      return {
        workerName: row.worker_name,
        storeId,
        storeMatch,
        version,
        platform: row.platform || "",
        hostname: row.hostname || "",
        profileDir: row.profile_dir || "",
        currentJobId: row.current_job_id || "",
        currentJob,
        currentPhase,
        canClaimJobs,
        versionTooOld,
        minVersion: MIN_SINGLE_SOURCING_PLUGIN_VERSION,
        lastSeenAt,
        online: ageMs <= onlineWindow,
        ageSeconds: Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / 1000)) : null,
      };
    });
    res.json({
      success: true,
      workers,
      queue: queueResult.rows[0] || { queued: 0, active: 0 },
      onlineWindowSeconds: Math.round(onlineWindow / 1000),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/worker/plugin-token", async (req, res) => {
  const storeId = String(req.query.store_id || req.query.storeId || req.body?.store_id || req.body?.storeId || "").split(",")[0].trim();
  if (storeId && db) {
    try {
      await assertActiveStoreAccess(storeId, req.user.id, "id");
    } catch (error) {
      res.status(error.statusCode || 403).json({ success: false, error: error.message });
      return;
    }
  }
  const issued = createScopedWorkerToken(req.user.id, {
    storeId,
    scope: ["collector:submit", "worker:poll"],
  });
  res.setHeader("Cache-Control", "no-store");
  res.json({
    success: true,
    token: issued.token,
    tokenType: "Bearer",
    userId: req.user.id,
    storeId,
    scope: issued.payload.scope,
    expiresIn: issued.expiresIn,
  });
});

app.post("/api/worker/heartbeat", async (req, res, next) => {
  try {
    if (!db) {
      res.status(409).json({ success: false, error: "服务器没有启用任务队列。" });
      return;
    }
    await upsertWorkerHeartbeat(req.user, req.body?.workerName || req.headers["x-worker-name"] || "", {
      version: req.body?.version,
      pluginVersion: req.body?.pluginVersion,
      platform: req.body?.platform,
      hostname: req.body?.hostname,
      profileDir: req.body?.profileDir,
      currentPhase: req.body?.currentPhase || "本机采集端在线",
      currentJobId: req.body?.currentJobId,
    });
    await rescueStaleDbJobsForUser(req.user, { kinds: ["run"] });
    const queueResult = await db.query(
      `SELECT
         count(*) FILTER (WHERE status = 'queued')::int AS queued,
         count(*) FILTER (WHERE status IN ('claimed','running'))::int AS active
       FROM app_jobs
       WHERE user_id = $1`,
      [req.user?.id || ""],
    );
    res.json({ success: true, queue: queueResult.rows[0] || { queued: 0, active: 0 } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/worker/jobs/:id/progress", async (req, res, next) => {
  try {
    if (!db) {
      res.status(409).json({ success: false, error: "服务器没有启用任务队列。" });
      return;
    }
    const existing = await getDbJobForUser(req.params.id, req.user);
    if (!existing) {
      res.status(404).json({ success: false, error: "任务不存在。" });
      return;
    }
    if (["done", "error", "canceled"].includes(existing.status)) {
      await clearWorkerCurrentJobRefs(req.params.id);
      res.json({ success: true, job: existing, terminal: true, canceled: existing.status === "canceled" });
      return;
    }
    await upsertWorkerHeartbeat(req.user, req.body?.workerName || req.headers["x-worker-name"] || "", {
      version: req.body?.version,
      pluginVersion: req.body?.pluginVersion,
      platform: req.body?.platform,
      hostname: req.body?.hostname,
      profileDir: req.body?.profileDir,
      currentJobId: req.params.id,
      currentPhase: req.body?.phase || existing.phase || "采集中",
    });
    const updates = normalizeWorkerJobUpdate(req.body || {}, existing);
    if (existing.status === "canceled" && updates.status && !["canceled", "done", "error"].includes(updates.status)) {
      delete updates.status;
    }
    const job = Object.keys(updates).length ? await updateDbJob(req.params.id, updates) : existing;
    res.json({ success: true, job });
  } catch (error) {
    next(error);
  }
});

app.post("/api/worker/jobs/:id/complete", async (req, res, next) => {
  try {
    if (!db) {
      res.status(409).json({ success: false, error: "服务器没有启用任务队列。" });
      return;
    }
    const existing = await getDbJobForUser(req.params.id, req.user);
    if (!existing) {
      res.status(404).json({ success: false, error: "任务不存在。" });
      return;
    }
    const job = req.body?.job && typeof req.body.job === "object" ? req.body.job : {};
    const kind = existing.kind === "batch-ozon" || job.kind === "batch-ozon" ? "batch-ozon" : "run";
    if (["done", "error"].includes(existing.status)) {
      await clearWorkerCurrentJobRefs(req.params.id);
      res.json({ success: true, job: existing, downloadUrl: existing.downloadUrl || "", terminal: true });
      return;
    }
    if (existing.status === "canceled") {
      await clearWorkerCurrentJobRefs(req.params.id);
      const stoppedJob = {
        ...job,
        id: req.params.id,
        kind,
        status: "canceled",
        phase: "已停止",
        logs: Array.isArray(job.logs) ? job.logs : existing.logs,
        results: Array.isArray(job.results) ? job.results : existing.results,
        processed: job.processed ?? existing.processed,
        total: job.total ?? existing.total,
      };
      const downloadUrl = await saveWorkerArtifacts(req.params.id, kind, stoppedJob, req.body?.excelBase64 || "").catch(() => existing.downloadUrl || "");
      const updates = normalizeWorkerJobUpdate({ ...stoppedJob, downloadUrl }, existing);
      updates.status = "canceled";
      updates.phase = "已停止";
      if (downloadUrl) updates.downloadUrl = downloadUrl;
      const updated = await updateDbJob(req.params.id, updates);
      res.json({ success: true, job: updated, downloadUrl, canceled: true });
      return;
    }
    await upsertWorkerHeartbeat(req.user, req.body?.workerName || req.headers["x-worker-name"] || "", {
      version: req.body?.version,
      pluginVersion: req.body?.pluginVersion,
      platform: req.body?.platform,
      hostname: req.body?.hostname,
      profileDir: req.body?.profileDir,
      currentJobId: req.params.id,
      currentPhase: job.phase || existing.phase || "任务完成",
    });
    if (kind === "run") {
      const initialUpdates = {
        status: "running",
        phase: "服务器 AI 审核/生成 Excel",
        processed: job.processed ?? existing.processed,
        total: job.total ?? existing.total,
        logs: Array.isArray(job.logs) ? job.logs : existing.logs,
      };
      if (Array.isArray(job.results) && job.results.length !== (existing.results || []).length) {
        initialUpdates.results = job.results;
      }
      await updateDbJob(req.params.id, initialUpdates);
      await finalizeWorkerRunJob(existing, job);
    }
    const downloadUrl = await saveWorkerArtifacts(req.params.id, kind, job, req.body?.excelBase64 || "");
    const updates = normalizeWorkerJobUpdate({ ...job, downloadUrl }, existing);
    updates.status = normalizeWorkerStatus(job.status) || "done";
    updates.downloadUrl = downloadUrl;
    if (updates.status === "done" && downloadUrl) {
      updates.phase = "已完成，可下载 Excel";
    }
    const updated = await updateDbJob(req.params.id, updates);
    res.json({ success: true, job: updated, downloadUrl });
  } catch (error) {
    next(error);
  }
});

async function runJob(job, options) {
  await ensureDir(JOBS_DIR);
  await ensureDir(path.join(JOBS_DIR, job.id, "images"));

  job.status = "running";
  job.phase = "启动浏览器";
  touch(job);
  if (options.startRow > 1) {
    log(job, `识别到 ${options.sourceTotal} 个 Ozon 链接，本次从第 ${options.startRow} 行开始，处理 ${options.urls.length} 个。`);
  } else {
    log(job, `开始处理 ${options.urls.length} 个 Ozon 链接。`);
  }
  log(job, `已开启随机访问节奏：每个商品之间等待 ${formatSeconds(options.delayMinMs)}-${formatSeconds(options.delayMaxMs)}，候选详情之间也会随机停顿。`);
  log(job, `1688 详情浏览模式：${detailBrowseModeLabel()}，候选详情间隔 ${formatSeconds(DETAIL_DELAY_MIN_MS)}-${formatSeconds(DETAIL_DELAY_MAX_MS)}。`);
  log(job, `自动停止规则：致命异常立刻停止；普通异常连续 ${options.maxConsecutiveFailures} 条停止。`);

  const context = await getBrowserContext({ headless: options.headless });
  if (options.enable1688) {
    job.phase = "准备 1688";
    touch(job);
    await prepare1688Page(context, job);
    log(job, "已打开 1688 页面。若还没登录，请先在弹出的浏览器里登录后重试任务。");
  }

  for (let i = 0; i < options.urls.length; i += 1) {
    if (job.cancelRequested) {
      job.status = "canceled";
      job.phase = "已停止";
      log(job, "任务已停止。", "warn");
      break;
    }

    const entry = options.urlRows?.[i] || { url: options.urls[i], sourceRow: options.startRow + i };
    const url = entry.url;
    const sourceRow = entry.sourceRow;
    const progressLabel = options.startRow > 1
      ? `第 ${sourceRow} 行（本次 ${i + 1}/${options.urls.length}）`
      : `${i + 1}/${options.urls.length}`;
    job.phase = `采集 Ozon ${progressLabel}`;
    touch(job);
    log(job, `正在采集第 ${sourceRow} 行：${url}`);

    const result = {
      url,
      sourceRow,
      ozon: null,
      candidates: [],
      aiReview: null,
      selectedCandidate: null,
      searchError: "",
      error: "",
    };

    try {
      result.ozon = await scrapeOzonProduct(context, url, job.id, sourceRow);
      log(job, `Ozon 采集完成：${result.ozon.title || "未识别标题"}`);

      if (options.enable1688) {
        if (result.ozon.mainImage?.buffer) {
          job.phase = `1688 搜图 ${progressLabel}`;
          touch(job);
          log(job, "正在用 Ozon 主图搜索 1688 候选货源，并补采起批量、价格、运费、尺寸、重量。");
          const searchResult = await search1688ByImage(context, result.ozon.mainImage, options.maxCandidates, job.id, sourceRow);
          if (searchResult.success) {
            result.candidates = searchResult.candidates.map((candidate) => normalizeSourcingCandidateForReview(candidate, result.ozon));
            log(job, `找到 ${result.candidates.length} 个 1688 候选，详情字段已尽量补全。`);
            if (options.enableAI && result.candidates.length) {
              job.phase = `AI 审核 ${progressLabel}`;
              touch(job);
              log(job, "正在用 AI 严格审核候选是否与 Ozon 商品完全一致。");
              result.aiReview = await reviewCandidatesWithMiniMax(result.ozon, result.candidates);
              applyAiReview(result);
              if (result.aiReview.decision === "exact") {
                log(job, `AI 选中完全一致候选 ${result.aiReview.selected_rank}：${result.aiReview.reason || "通过审核"}`);
              } else if (result.aiReview.decision === "approximate") {
                log(job, `AI 未找到完全一致，返回近似候选 ${result.aiReview.selected_rank}：${result.aiReview.reason || "需要人工确认"}`, "warn");
              } else {
                log(job, `AI 未找到合理候选：${result.aiReview.reason || "无法确认"}`, "warn");
              }
            }
          } else {
            result.searchError = searchResult.error;
            log(job, `1688 搜图失败：${searchResult.error}`, "warn");
          }
        } else {
          result.searchError = "未下载到可用于搜图的 Ozon 主图";
          log(job, result.searchError, "warn");
        }
      }
    } catch (error) {
      result.error = error.message;
      if (error.rowSkip) {
        result.skipped = true;
        log(job, `跳过第 ${sourceRow} 行：${error.message}`, "warn");
      } else {
        log(job, `处理失败：${error.message}`, "error");
      }
    }

    const failureReason = getResultFailureReason(result);
    let stopReason = "";
    if (failureReason) {
      job.consecutiveFailures += 1;
      const criticalReason = getCriticalStopReason(failureReason);
      if (criticalReason) {
        stopReason = `第 ${sourceRow} 行出现不能继续的异常：${criticalReason}`;
      } else {
        log(job, `第 ${sourceRow} 行异常，连续异常 ${job.consecutiveFailures}/${options.maxConsecutiveFailures}：${failureReason}`, "warn");
        if (job.consecutiveFailures >= options.maxConsecutiveFailures) {
          stopReason = `连续 ${job.consecutiveFailures} 条出现异常，已自动停止。最后异常：${failureReason}`;
        }
      }
    } else {
      job.consecutiveFailures = 0;
    }

    job.results.push(stripBuffers(result));
    job.processed = i + 1;
    if (stopReason) {
      job.resumeFromRow = sourceRow;
      job.resumeUrls = (options.urlRows || []).filter((item) => item.sourceRow >= sourceRow).map((item) => item.url);
      stopJob(job, stopReason);
    }
    touch(job);
    await writeJobArtifacts(job);

    if (job.status === "error") break;
    if (i < options.urls.length - 1) {
      const waitMs = randomInt(options.delayMinMs, options.delayMaxMs);
      log(job, `随机等待 ${formatSeconds(waitMs)} 后继续下一条。`);
      await sleep(waitMs);
    }
  }

  if (job.status === "running") {
    job.status = "done";
    job.phase = "已完成";
    await writeJobArtifacts(job);
    log(job, "任务完成，Excel 已生成。");
  } else {
    await writeJobArtifacts(job);
  }
  touch(job);
}

async function finalizeWorkerRunJob(existing, job) {
  if (!job || !Array.isArray(job.results) || !job.results.length) return;
  const payload = existing?.payload && typeof existing.payload === "object" ? existing.payload : {};
  const options = payload.options && typeof payload.options === "object" ? payload.options : payload;
  const enableAI = options.enableAI !== false;
  const collectionOnly = options.collectionOnly === true;
  const urlRows = Array.isArray(payload.urlRows) ? payload.urlRows : [];
  const jobId = existing?.id || job.id || "";
  job.logs = Array.isArray(job.logs) ? job.logs : [];
  for (const result of job.results) {
    if (!result) continue;
    const sourceRow = Number(result.sourceRow || 0);
    const source = urlRows.find((row) => Number(row?.sourceRow || 0) === sourceRow);
    const collectId = String(source?.collectId || "").trim();
    if (collectionOnly && collectId && result.error && db) {
      await db.query(
        `UPDATE collect_items SET status = 'failed', note = $1,
           status_log=COALESCE(status_log,'[]'::jsonb) || jsonb_build_array(jsonb_build_object('from',status,'to','failed','reason',$1::text,'job_id',$4::text,'at',now())),
           updated_at = now()
         WHERE id = $2 AND user_id = $3`,
        [String(result.error).slice(0, 1000), collectId, existing.owner?.id, jobId],
      );
    }
    if (result.error) {
      await syncAutoListingItemFromSourcingResult(existing, result, source, jobId);
      continue;
    }
    result.ozon = normalizePluginOzonResult(result.ozon || {});
    if (collectionOnly && db) {
      if (collectId) {
        const ozon = result.ozon || {};
        const imageUrls = Array.isArray(ozon.images) ? ozon.images.filter(Boolean) : [];
        const mainImage = ozon.mainImageUrl || ozon.mainImage?.url || imageUrls[0] || "";
        await db.query(
          `UPDATE collect_items
           SET title = $1, main_image = $2, images = $3::jsonb, price_rub = $4,
               brand = $5, attributes = $6::jsonb, status = 'scraped', note = '',
               status_log=COALESCE(status_log,'[]'::jsonb) || jsonb_build_array(jsonb_build_object('from',status,'to','scraped','reason','采集完成','job_id',$9::text,'at',now())),
               updated_at = now()
           WHERE id = $7 AND user_id = $8`,
          [
            String(ozon.title || ""),
            String(mainImage),
            JSON.stringify(imageUrls),
            Number(ozon.currentBlackPriceCnyValue || ozon.raw?.price || 0) || null,
            String(ozon.brand || ""),
            JSON.stringify(ozon.attributes || []),
            collectId,
            existing.owner?.id,
            jobId,
          ],
        );
      }
    }
    await hydrateWorkerRunResultImages(jobId, result);
    if (Array.isArray(result.candidates) && result.candidates.length) {
      result.candidates = result.candidates.map((candidate) => normalizeSourcingCandidateForReview(candidate, result.ozon));
      if (enableAI && shouldReviewWorkerResultWithAi(result)) {
        const rowLabel = result.sourceRow || "";
        job.logs.push(makeLogEntry(`服务器 AI 审核第 ${rowLabel} 行候选。`));
        await updateDbJob(jobId, {
          status: "running",
          phase: `服务器 AI 审核第 ${rowLabel} 行`,
          processed: job.processed,
          total: job.total,
          logs: job.logs,
        });
        result.aiReview = await reviewCandidatesWithMiniMax(result.ozon, result.candidates);
        applyAiReview(result);
        const decisionText = result.aiReview?.decision || "unknown";
        job.logs.push(makeLogEntry(`服务器 AI 审核第 ${rowLabel} 行完成：${decisionText}${result.aiReview?.reason ? `，${result.aiReview.reason}` : ""}`));
        await updateDbJob(jobId, {
          status: "running",
          phase: `服务器 AI 审核第 ${rowLabel} 行完成`,
          processed: job.processed,
          total: job.total,
          logs: job.logs,
        });
      } else if (!result.selectedCandidate && !hasStrictNoneAiDecision(result)) {
        const fallback = findBestFallbackCandidate(result.candidates);
        if (fallback) {
          result.selectedCandidate = markFinalCandidate(fallback, "approximate", "未进行 AI 审核，返回非引流候选供人工确认。");
        }
      }
    }
    await syncAutoListingItemFromSourcingResult(existing, result, source, jobId);
  }
}

async function syncAutoListingItemFromSourcingResult(existing, result, source = {}, jobId = "") {
  if (!db || !existing?.owner?.id || !existing?.storeId || !result) return;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const itemId = uuidRe.test(String(source?.autoListingItemId || "")) ? String(source.autoListingItemId) : null;
  const sku = String(source?.sku || result.ozon?.sku || result.ozon?.offerId || "").trim();
  if (!itemId && !sku) return;
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  const selected = result.selectedCandidate || {};
  const aiReview = result.aiReview || {};
  const hasSelected = Boolean(selected.url || selected.title || selected.rank || aiReview.selected_rank);
  const aiDecision = String(aiReview.decision || "").trim();
  const hasUsableCandidate = hasSelected && aiDecision !== "none";
  const errorText = String(result.error || result.searchError || "").trim();
  const stage = hasUsableCandidate ? "materials" : "sourcing";
  const status = hasUsableCandidate ? "needs_human" : (errorText ? "failed" : "needs_human");
  const reason = hasUsableCandidate
    ? `1688 找货完成，找到 ${candidates.length} 个候选，等待人工核对。`
    : (aiReview.reason || aiReview.summary
      ? `找货完成但 AI 未确认可用货源：${aiReview.reason || aiReview.summary}`
      : (errorText ? `找货完成但没有可用候选：${errorText}` : "找货完成但没有可用候选，等待人工处理。"));
  const ozon = result.ozon || {};
  const compactCandidate = hasSelected ? {
    rank: selected.rank ?? aiReview.selected_rank ?? "",
    title: selected.title || "",
    url: selected.url || "",
    image: pickCandidateImageUrl(selected),
    priceCny: selected.priceCny ?? selected.price ?? "",
    moq: selected.moq ?? "",
    matchType: selected.finalMatchType || aiReview.decision || "",
    reason: selected.finalReason || selected.aiReason || aiReview.reason || "",
  } : null;
  const summary = {
    job_id: jobId,
    source_row: result.sourceRow || "",
    completed_at: new Date().toISOString(),
    ozon: {
      title: ozon.title || "",
      sku: ozon.sku || ozon.offerId || sku,
      url: result.url || "",
      image: pickOzonImageUrl(ozon),
    },
    candidate_count: candidates.length,
    selected_candidate: compactCandidate,
    ai_decision: aiDecision,
    ai_reason: aiReview.reason || aiReview.summary || "",
    error: errorText,
  };
  const update = await db.query(
    `UPDATE app_auto_listing_items
        SET stage=$1,
            status=$2,
            human_reason=$3,
            payload = COALESCE(payload,'{}'::jsonb) || $4::jsonb,
            updated_at=now()
      WHERE user_id=$5
        AND store_id=$6
        AND (($7::uuid IS NOT NULL AND id=$7::uuid) OR ($7::uuid IS NULL AND source_sku=$8))
      RETURNING id`,
    [
      stage,
      status,
      reason.slice(0, 500),
      JSON.stringify({
        sourcing_job_id: jobId,
        sourcing_completed_at: summary.completed_at,
        sourcing_result: summary,
      }),
      existing.owner.id,
      existing.storeId,
      itemId,
      sku,
    ],
  );
  if (!update.rowCount) return;
  await insertAutoListingEvent({
    userId: existing.owner.id,
    storeId: existing.storeId,
    itemId: update.rows[0].id,
    eventType: status,
    stage,
    message: reason.slice(0, 500),
    payload: summary,
  });
}

function hasUsableLocalImage(image) {
  return Boolean(image?.filePath && existsSync(image.filePath));
}

function normalizeImageUrlValue(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("//")) return `https:${text}`;
  return text;
}

function pickFirstImageUrl(values) {
  const queue = Array.isArray(values) ? [...values] : [values];
  const seen = new Set();
  const preferredKeys = [
    "mainImageUrl",
    "mainImage",
    "primaryImage",
    "primary_image",
    "image",
    "imageUrl",
    "image_url",
    "images",
    "imageUrls",
    "image_urls",
    "url",
    "publicUrl",
    "picUrl",
    "imgUrl",
    "offerPicUrl",
    "odPicUrl",
    "thumbnail",
    "thumb",
    "cover",
    "coverImage",
    "src",
    "currentSrc",
  ];
  while (queue.length) {
    const value = queue.shift();
    if (value == null) continue;
    if (typeof value === "string") {
      const normalized = normalizeImageUrlValue(value);
      if (isLikelyOzonMarketingImage(normalized)) continue;
      if (/^(https?:)?\/\//i.test(normalized) || normalized.startsWith("/artifacts/")) return normalized;
      continue;
    }
    if (Array.isArray(value)) {
      queue.unshift(...value);
      continue;
    }
    if (typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    for (const key of preferredKeys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) queue.push(value[key]);
    }
  }
  return "";
}

function pickOzonImageUrl(ozon = {}) {
  return pickFirstImageUrl([
    ozon?.mainImageUrl,
    ozon?.mainImage,
    ozon?.image,
    ozon?.imageUrl,
    ozon?.primaryImage,
    ozon?.primary_image,
    ozon?.cover,
    ozon?.thumbnail,
    ozon?.images,
    ozon?.imageUrls,
    ozon?.raw?.mainImageUrl,
    ozon?.raw?.mainImage,
    ozon?.raw?.image,
    ozon?.raw?.imageUrl,
    ozon?.raw?.primaryImage,
    ozon?.raw?.primary_image,
    ozon?.raw?.images,
    ozon?.raw?.imageUrls,
  ]);
}

function pickCandidateImageUrl(candidate = {}) {
  return pickFirstImageUrl([
    candidate?.image,
    candidate?.imageUrl,
    candidate?.picUrl,
    candidate?.imgUrl,
    candidate?.mainImageUrl,
    candidate?.mainImage,
    candidate?.offerPicUrl,
    candidate?.odPicUrl,
    candidate?.thumbnail,
    candidate?.thumb,
    candidate?.cover,
    candidate?.localImage,
    candidate?.raw?.image,
    candidate?.raw?.imageUrl,
    candidate?.raw?.picUrl,
    candidate?.raw?.imgUrl,
    candidate?.raw?.mainImage,
    candidate?.raw?.mainImageUrl,
    candidate?.raw?.offerPicUrl,
    candidate?.raw?.odPicUrl,
  ]);
}

function localArtifactPathFromPublicUrl(jobId, publicUrl) {
  if (!jobId || !isSafeJobId(jobId)) return "";
  const text = String(publicUrl || "").trim();
  if (!text) return "";
  let pathname = text;
  try {
    if (/^https?:\/\//i.test(text)) pathname = new URL(text).pathname;
  } catch {
    pathname = text;
  }
  const prefix = `/artifacts/jobs/${jobId}/images/`;
  if (!pathname.startsWith(prefix)) return "";
  const filename = path.basename(pathname.slice(prefix.length));
  if (!filename) return "";
  const filePath = path.join(JOBS_DIR, jobId, "images", filename);
  return existsSync(filePath) ? filePath : "";
}

function existingLocalImageFromArtifactUrl(jobId, image, imageUrl) {
  if (hasUsableLocalImage(image)) return image;
  const localPath = localArtifactPathFromPublicUrl(jobId, image?.publicUrl || image?.url || imageUrl);
  if (!localPath) return null;
  return {
    ...(image && typeof image === "object" ? image : {}),
    url: image?.url || imageUrl || "",
    filePath: localPath,
    publicUrl: image?.publicUrl || imageUrl || `/artifacts/jobs/${jobId}/images/${path.basename(localPath)}`,
  };
}

async function hydrateWorkerRunResultImages(jobId, result) {
  if (!jobId || !isSafeJobId(jobId) || !result) return;
  const sourceRow = result.sourceRow || extractOzonProductId(result.url || result.ozon?.sourceUrl || "") || "0";
  result.ozon = result.ozon && typeof result.ozon === "object" ? result.ozon : {};
  const ozonUrl = pickOzonImageUrl(result.ozon);
  const existingOzonImage = existingLocalImageFromArtifactUrl(jobId, result.ozon.mainImage, ozonUrl);
  if (existingOzonImage) {
    result.ozon.mainImage = existingOzonImage;
  } else if (ozonUrl && /^https?:\/\//i.test(ozonUrl)) {
    try {
      result.ozon.mainImage = await downloadArtifactImageByUrl({
        jobId,
        prefix: `ozon_${String(sourceRow).padStart(3, "0")}`,
        url: ozonUrl,
        referer: result.url || result.ozon?.sourceUrl || "https://www.ozon.ru/",
      });
    } catch (error) {
      result.ozon.mainImageDownloadError = error.message;
    }
  }
  if (!Array.isArray(result.candidates)) return;
  for (const candidate of result.candidates) {
    const imageUrl = pickCandidateImageUrl(candidate);
    const existingCandidateImage = existingLocalImageFromArtifactUrl(jobId, candidate?.localImage, imageUrl);
    if (existingCandidateImage) {
      candidate.localImage = existingCandidateImage;
      continue;
    }
    if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) continue;
    try {
      candidate.localImage = await downloadArtifactImageByUrl({
        jobId,
        prefix: `1688_${String(sourceRow).padStart(3, "0")}_${String(candidate.rank || 0).padStart(2, "0")}`,
        url: imageUrl,
        referer: candidate.link || "https://www.1688.com/",
      });
    } catch (error) {
      candidate.imageDownloadError = error.message;
    }
  }
}

async function downloadArtifactImageByUrl({ jobId, prefix, url, referer }) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(45000),
    headers: { Referer: referer || "", "User-Agent": USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`图片下载失败 ${response.status}：${url}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = response.headers.get("content-type") || "image/jpeg";
  const ext = extensionFromContentType(contentType, url);
  const safePrefix = String(prefix || "image").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 80);
  const filename = `${safePrefix}.${ext}`;
  const dir = path.join(JOBS_DIR, jobId, "images");
  await ensureDir(dir);
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, buffer);
  return {
    url,
    filePath,
    publicUrl: `/artifacts/jobs/${jobId}/images/${filename}`,
    contentType,
    buffer,
  };
}

function normalizePluginOzonResult(ozon = {}) {
  const blackText = getOzonBestBlackPriceText(ozon);
  const blackValue = getOzonBestBlackPriceValue(ozon);
  const weight = inferOzonWeight(ozon);
  return {
    ...ozon,
    currentBlackPriceCny: ozon.currentBlackPriceCny || blackText || ozon.price || "",
    currentBlackPriceCnyValue: Number.isFinite(Number(ozon.currentBlackPriceCnyValue))
      ? Number(ozon.currentBlackPriceCnyValue)
      : (Number.isFinite(blackValue) ? blackValue : ""),
    currentGreenPriceCny: ozon.currentGreenPriceCny || ozon.price || ozon.currentBlackPriceCny || "",
    weightGrams: ozon.weightGrams || weight.weightGrams || "",
    weightText: ozon.weightText || (weight.weightGrams ? `${weight.weightGrams} g` : ""),
    weightSource: ozon.weightSource || weight.source || "",
    weightEvidence: ozon.weightEvidence || weight.evidence || "",
  };
}

function shouldReviewWorkerResultWithAi(result) {
  if (!result?.candidates?.length) return false;
  const decision = String(result.aiReview?.decision || "");
  if (!result.aiReview) return true;
  if (["needs_review", "pending", "approximate"].includes(decision)) return true;
  if (!["exact", "none"].includes(decision)) return true;
  return !Array.isArray(result.aiReview?.candidate_reviews) || !result.aiReview.candidate_reviews.length;
}

function hasStrictNoneAiDecision(result) {
  return result?.aiReview?.decision === "none" && !result.aiReview?.selected_rank;
}

async function runBatchOzonJob(job, options) {
  await ensureDir(JOBS_DIR);
  await ensureDir(path.join(JOBS_DIR, job.id, "images"));

  job.status = "running";
  job.phase = "启动浏览器";
  touch(job);
  log(job, `批量采集模式启动，来源：${options.sourceUrl}`);
  log(job, `最多采集 ${options.maxProducts} 个 Ozon 商品；商品之间随机等待 ${formatSeconds(options.delayMinMs)}-${formatSeconds(options.delayMaxMs)}。`);
  log(job, `筛选条件：${describeBatchOzonFilters(options.filters) || "未设置，全部保留"}`);

  const context = await getBrowserContext({ headless: options.headless });
  job.phase = "发现商品列表";
  touch(job);
  const productUrls = await discoverOzonProductUrls(context, options.sourceUrl, job, options.maxProducts);
  job.discoveredTotal = productUrls.length;
  job.total = productUrls.length;
  touch(job);
  await writeJobArtifacts(job);

  if (!productUrls.length) {
    job.status = "done";
    job.phase = "未发现商品";
    log(job, "没有从当前页面发现可采集的 Ozon 商品链接。", "warn");
    await writeJobArtifacts(job);
    touch(job);
    return;
  }

  log(job, `已发现 ${productUrls.length} 个商品链接，开始逐个采集基础信息。`);
  for (let i = 0; i < productUrls.length; i += 1) {
    if (job.cancelRequested) {
      job.status = "canceled";
      job.phase = "已停止";
      log(job, "任务已停止。", "warn");
      break;
    }

    const url = productUrls[i];
    const sourceRow = i + 1;
    const progressLabel = `${sourceRow}/${productUrls.length}`;
    const result = {
      url,
      sourceRow,
      batchOzon: true,
      ozon: null,
      passedFilters: false,
      filterReasons: [],
      error: null,
    };

    try {
      job.phase = `采集 Ozon ${progressLabel}`;
      touch(job);
      log(job, `正在采集第 ${progressLabel} 个商品。`);
      result.ozon = await scrapeOzonProduct(context, url, job.id, sourceRow);
      const filterResult = applyBatchOzonFilters(result.ozon, options.filters);
      result.passedFilters = filterResult.passed;
      result.filterReasons = filterResult.reasons;
      if (filterResult.passed) {
        log(job, `第 ${sourceRow} 个商品通过筛选：${result.ozon?.title || url}`);
      } else {
        log(job, `第 ${sourceRow} 个商品未通过筛选：${filterResult.reasons.join("；") || "条件不匹配"}`, "warn");
      }
      job.consecutiveFailures = 0;
    } catch (error) {
      result.error = error.message;
      result.filterReasons = ["采集失败"];
      job.consecutiveFailures += 1;
      if (error.rowSkip) {
        log(job, `跳过第 ${sourceRow} 个商品：${error.message}`, "warn");
      } else {
        log(job, `第 ${sourceRow} 个商品采集失败，连续异常 ${job.consecutiveFailures}/${options.maxConsecutiveFailures}：${error.message}`, "error");
      }
      if (job.consecutiveFailures >= options.maxConsecutiveFailures) {
        stopJob(job, `连续 ${job.consecutiveFailures} 个商品采集异常，已自动停止。最后异常：${error.message}`);
      }
    }

    job.results.push(stripBuffers(result));
    job.processed = i + 1;
    touch(job);
    await writeJobArtifacts(job);

    if (job.status === "error") break;
    if (i < productUrls.length - 1) {
      const waitMs = randomInt(options.delayMinMs, options.delayMaxMs);
      log(job, `随机等待 ${formatSeconds(waitMs)} 后继续下一条。`);
      await sleep(waitMs);
    }
  }

  if (job.status === "running") {
    job.status = "done";
    job.phase = "已完成";
    log(job, "批量采集完成，Excel 已生成。");
    await writeJobArtifacts(job);
  } else {
    await writeJobArtifacts(job);
  }
  touch(job);
}

async function discoverOzonProductUrls(context, sourceUrl, job, maxProducts) {
  const page = await context.newPage();
  try {
    const normalizedSourceUrl = normalizeOzonPageUrl(sourceUrl);
    await page.goto(normalizedSourceUrl, { waitUntil: "domcontentloaded", timeout: 70000 });
    await humanPause(page, 1800, 4200);
    await waitForHumanVerificationIfNeeded(page, context, job, "Ozon 批量来源页");
    await ensureOzonChineseCny(page, job);

    const sourceProductUrl = normalizeOzonProductUrl(normalizedSourceUrl);
    if (sourceProductUrl) {
      const storeLink = await findOzonStoreLink(page);
      if (storeLink) {
        log(job, `已从商品页识别到店铺/卖家链接：${storeLink}`);
        await page.goto(storeLink, { waitUntil: "domcontentloaded", timeout: 70000 });
        await humanPause(page, 1800, 4200);
        await waitForHumanVerificationIfNeeded(page, context, job, "Ozon 店铺页");
        await ensureOzonChineseCny(page, job);
      } else {
        log(job, "未从商品页识别到店铺链接，先采集当前页可见的商品链接。", "warn");
      }
    }

    const urls = await collectOzonProductLinksOnPage(page, maxProducts, job);
    if (sourceProductUrl && !urls.includes(sourceProductUrl)) {
      urls.unshift(sourceProductUrl);
    }
    return Array.from(new Set(urls)).slice(0, maxProducts);
  } finally {
    await page.close().catch(() => {});
  }
}

async function findOzonStoreLink(page) {
  const href = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const toAbs = (value) => {
      try {
        return new URL(String(value || ""), location.href).href;
      } catch {
        return "";
      }
    };
    const anchors = Array.from(document.querySelectorAll("a[href]"))
      .map((anchor) => {
        const hrefValue = toAbs(anchor.getAttribute("href"));
        if (!hrefValue) return null;
        let url;
        try {
          url = new URL(hrefValue);
        } catch {
          return null;
        }
        if (!/ozon\./i.test(url.hostname) || /\/product\//i.test(url.pathname)) return null;
        const text = clean(anchor.innerText || anchor.getAttribute("aria-label") || anchor.getAttribute("title"));
        const path = `${url.pathname}${url.search}`;
        if (!/(\/seller\/|\/shop\/|\/brand\/|seller=|merchant|store)/i.test(path)) return null;
        let score = 0;
        if (/\/seller\//i.test(path)) score += 12;
        if (/\/shop\//i.test(path)) score += 8;
        if (/\/brand\//i.test(path)) score += 4;
        if (/店铺|商店|卖家| продав|магазин|brand|бренд/i.test(text)) score += 8;
        if (text.length && text.length < 80) score += 2;
        return { href: hrefValue, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    return anchors[0]?.href || "";
  }).catch(() => "");
  return normalizeOzonPageUrl(href);
}

async function collectOzonProductLinksOnPage(page, maxProducts, job) {
  const urls = new Map();
  let stagnantRounds = 0;
  for (let round = 0; round < 18 && urls.size < maxProducts && stagnantRounds < 5; round += 1) {
    await waitForHumanVerificationIfNeeded(page, page.context(), job, "Ozon 商品列表");
    const before = urls.size;
    const found = await page.evaluate(() => {
      const toAbs = (value) => {
        try {
          return new URL(String(value || ""), location.href).href;
        } catch {
          return "";
        }
      };
      return Array.from(document.querySelectorAll("a[href]"))
        .map((anchor) => toAbs(anchor.getAttribute("href")))
        .filter(Boolean);
    }).catch(() => []);
    for (const href of found) {
      const productUrl = normalizeOzonProductUrl(href);
      if (productUrl && !urls.has(productUrl)) urls.set(productUrl, productUrl);
      if (urls.size >= maxProducts) break;
    }
    if (urls.size > before) {
      stagnantRounds = 0;
      log(job, `列表页已发现 ${urls.size}/${maxProducts} 个商品链接。`);
    } else {
      stagnantRounds += 1;
    }
    if (urls.size >= maxProducts) break;
    await page.mouse.move(randomInt(160, 900), randomInt(180, 680), { steps: randomInt(6, 18) }).catch(() => {});
    await page.mouse.wheel(0, randomInt(850, 1900)).catch(() => {});
    await humanPause(page, 900, 2400);
  }
  await humanScroll(page, {
    maxScroll: randomInt(1200, 2600),
    minStep: 420,
    maxStep: 900,
    minDelay: 160,
    maxDelay: 420,
    returnTop: true,
  });
  return Array.from(urls.values()).slice(0, maxProducts);
}

async function scrapeOzonProduct(context, url, jobId, index) {
  const page = await context.newPage();
  const networkWeightCollector = createOzonNetworkWeightCollector(page);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 70000 });
    await humanPause(page, 1800, 4500);
    const activeJob = getActiveJobById(jobId);
    await waitForHumanVerificationIfNeeded(page, context, activeJob, `Ozon 商品 ${index}`);
    await ensureOzonChineseCny(page, activeJob);
    await autoScroll(page);
    await networkWeightCollector.settle();
    const networkWeightCandidates = networkWeightCollector.getCandidates();

    const extracted = await page.evaluate(() => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const toAbs = (value) => {
        try {
          if (!value || String(value).startsWith("data:")) return "";
          return new URL(String(value).replace(/&amp;/g, "&"), location.href).href;
        } catch {
          return "";
        }
      };
      const meta = (...names) => {
        for (const name of names) {
          const el =
            document.querySelector(`meta[property="${name}"]`) ||
            document.querySelector(`meta[name="${name}"]`);
          const content = clean(el?.getAttribute("content"));
          if (content) return content;
        }
        return "";
      };
      const isBadProductImage = (urlValue) => /\/marketing-api\/banners?\//i.test(String(urlValue || ""))
        || /\/banners?\//i.test(String(urlValue || ""))
        || /\/brand(?:-|_)?logo/i.test(String(urlValue || ""))
        || /\/seller(?:-|_)?logo/i.test(String(urlValue || ""));
      const addImage = (bucket, urlValue, source, area = 0) => {
        const absolute = toAbs(urlValue);
        if (!absolute) return;
        if (isBadProductImage(absolute)) return;
        const lower = absolute.toLowerCase();
        if (!/\.(jpg|jpeg|png|webp)(\?|$)/.test(lower) && !lower.includes("ozone.ru")) return;
        bucket.push({ url: absolute, source, area });
      };
      const addSrcset = (bucket, srcset, source) => {
        String(srcset || "")
          .split(",")
          .map((part) => part.trim().split(/\s+/)[0])
          .filter(Boolean)
          .forEach((src) => addImage(bucket, src, source));
      };
      const parseJsonLd = () => {
        const products = [];
        const visit = (node) => {
          if (!node || typeof node !== "object") return;
          const type = node["@type"];
          const types = Array.isArray(type) ? type : [type];
          if (types.some((item) => String(item || "").toLowerCase() === "product")) {
            products.push(node);
          }
          for (const value of Object.values(node)) {
            if (value && typeof value === "object") visit(value);
          }
        };
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            visit(JSON.parse(script.textContent || ""));
          } catch {
            // Ignore malformed JSON-LD blocks.
          }
        }
        return products[0] || {};
      };

      const product = parseJsonLd();
      const images = [];
      const jsonImages = Array.isArray(product.image) ? product.image : [product.image];
      jsonImages.filter(Boolean).forEach((src) => addImage(images, src, "jsonld", 10_000_000));
      addImage(images, meta("og:image", "twitter:image"), "meta", 9_000_000);

      for (const img of document.images) {
        const area = Number(img.naturalWidth || img.width || 0) * Number(img.naturalHeight || img.height || 0);
        addImage(images, img.currentSrc || img.src, "img", area);
        addSrcset(images, img.getAttribute("srcset"), "srcset");
        addImage(images, img.getAttribute("data-src"), "data-src", area);
      }
      for (const source of document.querySelectorAll("source[srcset]")) {
        addSrcset(images, source.getAttribute("srcset"), "source");
      }

      const imageUrlRegex = /https?:\\?\/\\?\/[^"'<>\\\s]+?(?:jpg|jpeg|png|webp)(?:\?[^"'<>\\\s]*)?/gi;
      for (const script of Array.from(document.scripts).slice(0, 120)) {
        const text = script.textContent || "";
        const matches = text.match(imageUrlRegex) || [];
        for (const match of matches.slice(0, 80)) {
          const normalized = match.replace(/\\u002F/g, "/").replace(/\\\//g, "/");
          addImage(images, normalized, "script", 1_000_000);
        }
      }

      const uniqueImages = [];
      const seen = new Set();
      for (const item of images) {
        const key = item.url.split("?")[0];
        if (seen.has(key)) continue;
        seen.add(key);
        uniqueImages.push(item);
      }
      uniqueImages.sort((a, b) => {
        const score = (item) => {
          let value = item.area || 0;
          if (item.url.includes("/s3/multimedia")) value += 3_000_000;
          if (item.source === "jsonld" || item.source === "meta") value += 2_000_000;
          if (/\/w\d+\//.test(item.url)) value -= 500_000;
          return value;
        };
        return score(b) - score(a);
      });

      const attributes = {};
      const addPair = (key, value) => {
        const k = clean(key).replace(/[:：]$/, "");
        const v = clean(value);
        if (k && v && k.length <= 80 && v.length <= 300 && k !== v) {
          attributes[k] = v;
        }
      };
      for (const dt of document.querySelectorAll("dt")) {
        const dd = dt.nextElementSibling;
        if (dd) addPair(dt.innerText, dd.innerText);
      }
      for (const row of document.querySelectorAll("tr")) {
        const cells = Array.from(row.children).map((cell) => clean(cell.innerText)).filter(Boolean);
        if (cells.length >= 2) addPair(cells[0], cells.slice(1).join(" "));
      }
      for (const node of document.querySelectorAll('[data-widget*="character"], [data-widget*="webCharacteristics"]')) {
        const lines = clean(node.innerText).split(/ (?=[^ ]{1,40}:)|\n/).filter(Boolean);
        for (const line of lines) {
          const match = line.match(/^(.{1,60}?)[：:]\s*(.{1,260})$/);
          if (match) addPair(match[1], match[2]);
        }
      }

      const hiddenWeightCandidates = [];
      const addWeightCandidate = (source, key, value, context = "") => {
        const k = clean(key);
        const v = clean(value);
        const ctx = clean(context);
        if (!k || !v || hiddenWeightCandidates.length >= 80) return;
        hiddenWeightCandidates.push({ source, key: k, value: v, context: ctx.slice(0, 220) });
      };
      addWeightCandidate("jsonld", "product.weight", product.weight || product.weightValue, "JSON-LD Product");
      for (const item of Array.isArray(product.additionalProperty) ? product.additionalProperty : []) {
        addWeightCandidate("jsonld-additionalProperty", item?.name || item?.propertyID || item?.["@type"], item?.value || item?.description, "JSON-LD additionalProperty");
      }
      for (const [key, value] of Object.entries(attributes)) {
        if (/weight|вес|масса|重量|毛重|净重|克重/i.test(`${key} ${value}`)) {
          addWeightCandidate("page-attribute", key, value, "页面商品属性");
        }
      }
      const weightKey = String.raw`(?:weight|вес|масса|重量|毛重|净重|克重|shippingWeight|packageWeight|grossWeight|netWeight)`;
      const scriptCandidates = [];
      for (const script of Array.from(document.scripts).slice(0, 160)) {
        const text = script.textContent || "";
        if (!/(weight|вес|масса|重量|毛重|净重|克重|грамм|кг|kg)/i.test(text)) continue;
        scriptCandidates.push(text.slice(0, 400000));
      }
      const scriptText = scriptCandidates.join("\n");
      for (const match of scriptText.matchAll(new RegExp(`["']([^"']*${weightKey}[^"']*)["']\\s*:\\s*["']([^"']{1,90})["']`, "gi"))) {
        addWeightCandidate("page-hidden-script", match[1], match[2], "页面隐藏脚本");
      }
      for (const match of scriptText.matchAll(new RegExp(`["']([^"']*${weightKey}[^"']*)["']\\s*:\\s*(-?\\d+(?:[.,]\\d+)?)`, "gi"))) {
        addWeightCandidate("page-hidden-script", match[1], match[2], "页面隐藏脚本");
      }
      for (const match of scriptText.matchAll(new RegExp(`(${weightKey}[^\\n:：]{0,40})[:：]?\\s*(\\d+(?:[.,]\\d+)?\\s*(?:kg|кг|g|гр|г|грамм(?:а|ов)?|克|公斤|千克))`, "gi"))) {
        addWeightCandidate("page-hidden-script", match[1], match[2], "页面隐藏脚本文本");
      }

      const parseRubPrice = (text) => {
        const match = String(text || "").match(/(\d[\d\s.,]{0,12})\s*(?:₽|руб\.?|р\b)/i);
        if (!match) return null;
        const value = Number(match[1].replace(/\s/g, "").replace(",", "."));
        return Number.isFinite(value) ? value : null;
      };
      const isDarkColor = (color) => {
        const match = String(color || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
        if (!match) return false;
        const [r, g, b] = match.slice(1).map(Number);
        return r <= 95 && g <= 95 && b <= 95 && r + g + b <= 210;
      };
      const collectBlackPrices = () => {
        const candidates = [];
        const seenText = new Set();
        const skipContext = /балл|кешбэк|рассроч|скидк|эконом|выгода|до скидки|старая цена|зачерк|card|карта|premium|рассрочка|месяц|x\d/i;
        const sellerContext = /продав|предложен|магазин|поставщик|другие продавцы|все продавцы|ещ[её]/i;
        const nodes = Array.from(document.querySelectorAll("body *")).filter((node) => {
          const text = clean(node.textContent);
          return text && text.length <= 180 && /(?:₽|руб\.?|р\b)/i.test(text);
        });
        for (const node of nodes) {
          const text = clean(node.textContent);
          const value = parseRubPrice(text);
          if (!value) continue;
          const style = getComputedStyle(node);
          const parentText = clean(node.closest('[data-widget], section, article, div')?.innerText || "");
          const context = parentText.slice(0, 260);
          const decoration = `${style.textDecorationLine || ""} ${style.textDecoration || ""}`;
          const dark = isDarkColor(style.color);
          const isOldPrice = /line-through/i.test(decoration) || /до скидки|старая цена|скидк|эконом|выгода/i.test(context);
          const isBlackPrice = dark && !isOldPrice && !skipContext.test(`${text} ${context}`);
          if (!isBlackPrice) continue;
          const key = `${value}:${text}`;
          if (seenText.has(key)) continue;
          seenText.add(key);
          candidates.push({
            value,
            text,
            context,
            isSellerOffer: sellerContext.test(context),
            href: toAbs(node.closest("a")?.href || ""),
          });
        }
        candidates.sort((a, b) => a.value - b.value);
        return candidates.slice(0, 30);
      };

      const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers || {};
      const blackPriceCandidates = collectBlackPrices();
      const lowestBlackPrice = blackPriceCandidates[0] || null;
      const title =
        clean(product.name) ||
        meta("og:title", "twitter:title") ||
        clean(document.querySelector("h1")?.innerText) ||
        clean(document.title);
      const bodyText = clean(document.body?.innerText || "");
      const unavailableSignals = [];
      if (/товар\s+не\s+найден|страница\s+не\s+найдена|нет\s+в\s+продаже|снят\s+с\s+продажи|商品不存在|商品已下架|页面不存在|暂无商品|没有数据/i.test(bodyText)) {
        unavailableSignals.push("页面提示商品不可售或不存在");
      }

      return {
        title,
        description: clean(product.description) || meta("description", "og:description"),
        price: clean(offers.price || meta("product:price:amount", "og:price:amount")),
        blackPrice: lowestBlackPrice?.text || "",
        blackPriceRub: lowestBlackPrice?.value ?? "",
        blackPriceContext: lowestBlackPrice?.context || "",
        blackPriceCandidates,
        currency: clean(offers.priceCurrency || meta("product:price:currency")),
        sku: clean(product.sku),
        brand: clean(product.brand?.name || product.brand),
        weight: clean(product.weight || product.weightValue),
        additionalProperty: product.additionalProperty || [],
        hiddenWeightCandidates,
        imageUrls: uniqueImages.map((item) => item.url).slice(0, 24),
        attributes,
        unavailableSignals,
      };
    });

    const buyerPriceInfo = await scrapeOzonBuyerCnyPrices(page);
    assertOzonProductAvailable(extracted, buyerPriceInfo);
    const mainImageUrl = extracted.imageUrls[0] || "";
    let mainImage = null;
    let mainImageDownloadError = "";
    if (mainImageUrl) {
      try {
        mainImage = await downloadImage(context, jobId, index, mainImageUrl, url);
      } catch (error) {
        mainImageDownloadError = error.message;
      }
    }
    const ozonQuantity = inferPackQuantityFromText([
      extracted.title,
      extracted.description,
      Object.entries(extracted.attributes || {}).map(([key, value]) => `${key}: ${value}`).join(" "),
    ].join(" "));
    const ozonWeight = inferOzonWeight({ ...extracted, networkWeightCandidates });

    const moqText = moqItem?.text || data.minOrderQuantity || data.moq || "";
    return {
      ...extracted,
      sourceUrl: url,
      networkWeightCandidates,
      mainImageUrl,
      mainImage,
      mainImageDownloadError,
      currentGreenPriceCny: buyerPriceInfo.currentGreenPriceText,
      currentGreenPriceCnyValue: buyerPriceInfo.currentGreenPriceValue ?? "",
      currentGreenPriceContext: buyerPriceInfo.currentGreenPriceContext || "",
      productBlackPriceCny: buyerPriceInfo.productBlackPriceText,
      productBlackPriceCnyValue: buyerPriceInfo.productBlackPriceValue ?? "",
      productBlackPriceContext: buyerPriceInfo.productBlackPriceContext || "",
      currentBlackPriceCny: buyerPriceInfo.currentBlackPriceText,
      currentBlackPriceCnyValue: buyerPriceInfo.currentBlackPriceValue ?? "",
      sellerLowestBlackPriceCny: buyerPriceInfo.sellerLowestPriceText,
      sellerLowestBlackPriceCnyValue: buyerPriceInfo.sellerLowestPriceValue ?? "",
      sellerOfferCount: buyerPriceInfo.sellerOfferCount ?? "",
      ozonPriceNote: buyerPriceInfo.note,
      ozonPriceCurrencyReady: buyerPriceInfo.currencyReady,
      ozonPriceCandidates: buyerPriceInfo.candidates,
      packQuantity: ozonQuantity.quantity,
      packQuantityEvidence: ozonQuantity.evidence,
      weightText: ozonWeight.weightText,
      weightGrams: ozonWeight.weightGrams,
      weightSource: ozonWeight.source,
      weightEvidence: ozonWeight.evidence,
      weightCandidates: ozonWeight.candidates,
    };
  } finally {
    networkWeightCollector.dispose();
    await page.close().catch(() => {});
  }
}

function assertOzonProductAvailable(extracted = {}, buyerPriceInfo = {}) {
  const attrs = extracted.attributes || {};
  const title = String(extracted.title || "").replace(/\s+/g, " ").trim();
  const attrCount = Object.keys(attrs).length;
  const hasBuyerPrice = Number.isFinite(Number(buyerPriceInfo.currentBlackPriceValue)) ||
    Number.isFinite(Number(buyerPriceInfo.sellerLowestPriceValue));
  const hasRubPrice = Number.isFinite(Number(extracted.blackPriceRub));
  const genericTitle = !title ||
    /在OZON购买|купить\s+на\s+ozon|ozon/i.test(title) ||
    title.length <= 4;
  const hasStrongProductIdentity = Boolean(
    attrCount ||
    extracted.sku ||
    extracted.brand ||
    (title && title.length > 8 && !genericTitle),
  );

  if (Array.isArray(extracted.unavailableSignals) && extracted.unavailableSignals.length) {
    throw new RowSkipError(`Ozon 商品无数据，可能已下架或不可访问：${extracted.unavailableSignals.join("；")}`);
  }
  if (!hasBuyerPrice && !hasRubPrice && !hasStrongProductIdentity) {
    throw new RowSkipError("Ozon 商品无有效商品数据，已跳过 1688 搜图");
  }
}

async function ensureOzonChineseCny(page, job = null) {
  const before = await getOzonCurrencySignal(page);
  if (before.currencyReady && before.languageReady) return true;

  const opened = await clickOzonLocaleSwitcher(page);
  if (!opened) {
    if (job) log(job, "未找到 Ozon 右上角语言/币种入口；如果价格不是人民币，请先在浏览器里手动设置中文和 CNY。", "warn");
    return false;
  }
  await humanPause(page, 900, 1800);

  const languageReady = (await getOzonCurrencySignal(page)).languageReady;
  if (!languageReady) {
    await clickVisibleText(page, ["Русский", "English", "RU", "语言", "Язык"], { modalOnly: true, maxLength: 80 });
    await humanPause(page, 400, 900);
    await clickVisibleText(page, ["中文\\s*\\(\\s*简体\\s*\\)", "中文", "Chinese"], { modalOnly: true, maxLength: 120 });
    await humanPause(page, 500, 1000);
  }

  const currencyReady = (await getOzonCurrencySignal(page)).currencyReady;
  if (!currencyReady) {
    await clickVisibleText(page, ["Российский рубль", "RUB", "рубль", "₽", "货币", "Валюта", "俄罗斯卢布", "俄.*卢布", "卢布"], { modalOnly: true, maxLength: 120 });
    await humanPause(page, 400, 900);
    await clickVisibleText(page, ["Китайский юань", "CNY", "人民币", "Chinese yuan", "中国.*元", "中国.*人民币", "人民币.*CNY"], { modalOnly: true, maxLength: 160 });
    await humanPause(page, 500, 1000);
  }

  const saved = await clickVisibleText(page, ["Сохранить", "保存", "Save", "Применить", "Apply"], { modalOnly: true, maxLength: 60 });
  if (saved) {
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await humanPause(page, 1500, 3200);
  }

  const after = await getOzonCurrencySignal(page);
  if (job && after.currencyReady) log(job, "已确认 Ozon 买家端币种为人民币/CNY。");
  if (job && !after.currencyReady) log(job, "Ozon 币种可能未切换到人民币/CNY，本次会避免把非人民币价格当作人民币。", "warn");
  return after.currencyReady;
}

async function getOzonCurrencySignal(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || "";
    return {
      currencyReady: /(?:CNY|人民币|中国.*元|Китайский юань|¥|￥)/i.test(text),
      languageReady: /(?:中文|简体|语言|保存|人民币|Китайский юань)/i.test(text),
    };
  }).catch(() => ({ currencyReady: false, languageReady: false }));
}

async function clickOzonLocaleSwitcher(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width >= 8 && rect.height >= 8 && style.visibility !== "hidden" && style.display !== "none";
    };
    const elements = Array.from(document.querySelectorAll("button, a, [role='button'], div, span"))
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: clean(`${el.innerText || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`) }))
      .filter((item) => item.rect.top < 360 && item.rect.left > window.innerWidth * 0.62);
    const exact = elements.find((item) => /^(RU|EN|CN|ZH|中文|Русский|English|CNY|RUB)\b/i.test(item.text));
    const likely = exact || elements.find((item) => /RU|EN|CN|ZH|中文|Русский|English|CNY|RUB|₽|¥|валюта|язык|language|货币|语言/i.test(item.text));
    if (!likely) return false;
    const clickable = likely.el.closest("button, a, [role='button']") || likely.el;
    clickable.scrollIntoView({ block: "center", inline: "center" });
    clickable.click();
    return true;
  }).catch(() => false);
}

async function clickVisibleText(page, patternSources, options = {}) {
  return page.evaluate(({ patternSources: sources, options: opts }) => {
    const patterns = sources.map((source) => new RegExp(source, "i"));
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width >= 8 && rect.height >= 8 && style.visibility !== "hidden" && style.display !== "none";
    };
    const dialogs = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']"))
      .filter(visible);
    const root = opts.modalOnly && dialogs.length ? dialogs[dialogs.length - 1] : document.body;
    const elements = Array.from(root.querySelectorAll("button, a, [role='button'], input, div, span"))
      .filter(visible)
      .map((el) => ({ el, text: clean(`${el.innerText || ""} ${el.value || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`) }))
      .filter((item) => item.text && item.text.length <= (opts.maxLength || 160));
    const found = elements.find((item) => patterns.some((pattern) => pattern.test(item.text)));
    if (!found) return false;
    const clickable = found.el.closest("button, a, [role='button']") || found.el;
    clickable.scrollIntoView({ block: "center", inline: "center" });
    clickable.click();
    return true;
  }, { patternSources, options }).catch(() => false);
}

async function scrapeOzonBuyerCnyPrices(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width >= 4 && rect.height >= 4 && style.visibility !== "hidden" && style.display !== "none";
    };
    const parseCnyPrice = (text) => {
      const value = String(text || "");
      const prices = [];
      const addPrice = (raw, index) => {
        const before = value.slice(Math.max(0, index - 4), index);
        if (/\+\s*$/.test(before)) return;
        const number = Number(String(raw || "").replace(/\s/g, "").replace(",", "."));
        if (Number.isFinite(number) && number > 0) prices.push(number);
      };
      for (const match of value.matchAll(/(\d{1,6}(?:[\s.,]\d{1,2})?)\s*(?:CN¥|CNY|¥|￥|人民币|元)/gi)) {
        addPrice(match[1], match.index);
      }
      if (prices.length) return prices[0];
      for (const match of value.matchAll(/(?:CN¥|CNY|¥|￥|人民币|元)\s*(\d{1,6}(?:[\s.,]\d{1,2})?)/gi)) {
        const beforeCurrency = value.slice(Math.max(0, match.index - 2), match.index);
        if (/[\d,.]\s*$/.test(beforeCurrency)) continue;
        addPrice(match[1], match.index);
      }
      return prices[0] ?? null;
    };
    const formatCnyPrice = (value) => {
      if (!Number.isFinite(value)) return "";
      return Number.isInteger(value) ? `${value} ¥` : `${Number(value.toFixed(2))} ¥`;
    };
    const parseCnyNumber = (value) => {
      const number = Number(String(value || "").replace(/\s/g, "").replace(",", "."));
      return Number.isFinite(number) && number > 0 ? number : null;
    };
    const isDarkColor = (color) => {
      const match = String(color || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (!match) return false;
      const [r, g, b] = match.slice(1).map(Number);
      return r <= 110 && g <= 110 && b <= 110 && r + g + b <= 260;
    };
    const hasColoredBackground = (el) => {
      for (let node = el; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        const match = String(style.backgroundColor || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([.\d]+))?/i);
        if (!match) continue;
        const [r, g, b] = match.slice(1, 4).map(Number);
        const alpha = match[4] === undefined ? 1 : Number(match[4]);
        if (alpha > 0.2 && (Math.abs(r - g) > 18 || Math.abs(g - b) > 18 || r + g + b < 620)) return true;
      }
      return false;
    };
    const isLineThrough = (el) => {
      for (let node = el; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (/line-through/i.test(`${style.textDecorationLine || ""} ${style.textDecoration || ""}`)) return true;
      }
      return false;
    };
    const sellerBlockPattern = /есть дешевле|дешевле|быстрее|низк|дешевле или быстрее|другие продавцы|все продавцы|предложен|other sellers|all offers|low price|lower price|低价推荐|更便宜|更快|其他卖家|有更低|有更便宜/i;
    const buyButton = Array.from(document.querySelectorAll("button, a, [role='button']"))
      .filter(visible)
      .map((el) => ({ el, text: clean(el.innerText || el.getAttribute("aria-label") || ""), rect: el.getBoundingClientRect() }))
      .find((item) => /в корзину|добавить|купить|加入购物车|购物车|购买/i.test(item.text));
    const priceNodes = Array.from(document.querySelectorAll("body *"))
      .filter(visible)
      .map((el) => {
        const text = clean(el.textContent);
        const value = parseCnyPrice(text);
        if (!value || text.length > 180) return null;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const block = el.closest("[data-widget], section, article, li, div") || el;
        const context = clean(block.innerText || text).slice(0, 320);
        return {
          el,
          text,
          value,
          rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
          fontSize: Number.parseFloat(style.fontSize) || 0,
          isDark: isDarkColor(style.color),
          hasColoredBackground: hasColoredBackground(el),
          lineThrough: isLineThrough(el),
          context,
          priceText: formatCnyPrice(value),
          isSellerBlock: sellerBlockPattern.test(context),
        };
      })
      .filter(Boolean);

    const rightSide = (item) => item.rect.left > window.innerWidth * 0.45;
    const buyRect = buyButton?.rect;
    const buyAreaFilter = (item) => !buyRect || (item.rect.top < buyRect.top && item.rect.top > buyRect.top - 560);
    const greenCandidates = priceNodes
      .filter((item) => item.hasColoredBackground && !item.lineThrough && !item.isSellerBlock && rightSide(item))
      .filter(buyAreaFilter)
      .sort((a, b) => {
        const targetY = buyRect ? buyRect.top - 160 : window.innerHeight * 0.45;
        const score = (item) => item.fontSize * 12 - Math.abs(item.rect.top - targetY) * 0.12 + item.rect.width * 0.02;
        return score(b) - score(a);
      });
    const green = greenCandidates[0] || null;
    const productBlackCandidates = priceNodes
      .filter((item) => item.isDark && !item.hasColoredBackground && !item.lineThrough && !item.isSellerBlock && rightSide(item))
      .filter((item) => {
        if (green) return item.rect.top >= green.rect.top - 12 && item.rect.top <= green.rect.top + 120;
        return buyAreaFilter(item);
      })
      .sort((a, b) => {
        const targetY = green ? green.rect.top + 48 : (buyRect ? buyRect.top - 120 : window.innerHeight * 0.45);
        const score = (item) => item.fontSize * 12 - Math.abs(item.rect.top - targetY) * 0.22 + item.rect.width * 0.02;
        return score(b) - score(a);
      });
    const currentVisual = productBlackCandidates[0] || null;

    const sellerBlocks = Array.from(document.querySelectorAll("body *"))
      .filter(visible)
      .map((el) => {
        const text = clean(el.innerText || el.textContent || "");
        if (!text || text.length > 520 || !sellerBlockPattern.test(text) || parseCnyPrice(text) == null) return null;
        const rect = el.getBoundingClientRect();
        if (rect.left < window.innerWidth * 0.42) return null;
        if (currentVisual && rect.top < currentVisual.rect.top) return null;
        const prices = [];
        for (const child of Array.from(el.querySelectorAll("*")).filter(visible)) {
          const childText = clean(child.textContent);
          const value = parseCnyPrice(childText);
          if (value) prices.push({ value, text: formatCnyPrice(value) });
        }
        const fallbackValue = parseCnyPrice(text);
        if (!prices.length && fallbackValue) prices.push({ value: fallbackValue, text: formatCnyPrice(fallbackValue) });
        prices.sort((a, b) => a.value - b.value);
        const exactNumbers = Array.from(el.querySelectorAll("*"))
          .map((node) => clean(node.textContent))
          .filter((value) => /^\d{1,6}$/.test(value))
          .map(Number)
          .filter((value) => Number.isFinite(value) && value > 0);
        return {
          text,
          rect: { top: rect.top, left: rect.left },
          price: prices[0] || null,
          count: exactNumbers.length ? exactNumbers[exactNumbers.length - 1] : null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (currentVisual) return Math.abs(a.rect.top - currentVisual.rect.top) - Math.abs(b.rect.top - currentVisual.rect.top);
        return a.rect.top - b.rect.top;
      });
    const seller = sellerBlocks[0] || null;
    const findCurrentBlackFromMainText = () => {
      const texts = [
        clean(buyButton?.el?.closest("[data-widget], section, article, div")?.innerText || ""),
        ...sellerBlocks.map((item) => item.text),
      ].filter(Boolean);
      const patterns = [
        /(\d{1,6}(?:[\s.,]\d{1,2})?)\s*(?:CN¥|CNY|¥|￥|人民币|元)(?:\s+\d{1,6}(?:[\s.,]\d{1,2})?\s*(?:CN¥|CNY|¥|￥|人民币|元))?\s*(?:与其他银行|с\s+другими\s+банками|other\s+banks)/i,
        /(?:与其他银行|с\s+другими\s+банками|other\s+banks)[^\d]{0,24}(\d{1,6}(?:[\s.,]\d{1,2})?)\s*(?:CN¥|CNY|¥|￥|人民币|元)/i,
      ];
      for (const text of texts) {
        for (const pattern of patterns) {
          const match = text.match(pattern);
          const value = match ? parseCnyNumber(match[1]) : null;
          if (value) {
            return {
              value,
              text: formatCnyPrice(value),
              priceText: formatCnyPrice(value),
              context: text.slice(0, 320),
              source: "main-text",
            };
          }
        }
      }
      return null;
    };
    const current = currentVisual || findCurrentBlackFromMainText();
    const selectedBlack = [current, seller?.price ? { ...seller.price, priceText: seller.price.text, context: seller.text } : null]
      .filter(Boolean)
      .sort((a, b) => a.value - b.value)[0] || null;
    const notes = [];
    const bodyText = document.body?.innerText || "";
    const currencyReady = /(?:CNY|人民币|中国.*元|¥|￥)/i.test(bodyText);
    if (!currencyReady) notes.push("页面未确认切换到人民币/CNY");
    if (!current && !selectedBlack) notes.push("未识别到绿标价下方黑标价");
    if (seller?.price && current && seller.price.value < current.value) notes.push("Ozon产品黑标价按外层低价推荐取最低值");
    if (!seller?.count) notes.push("未识别到跟卖数量");

    return {
      currencyReady,
      currentGreenPriceText: green?.priceText || green?.text || "",
      currentGreenPriceValue: green?.value ?? null,
      currentGreenPriceContext: green?.context || "",
      productBlackPriceText: current?.priceText || current?.text || "",
      productBlackPriceValue: current?.value ?? null,
      productBlackPriceContext: current?.context || "",
      currentBlackPriceText: selectedBlack?.priceText || selectedBlack?.text || "",
      currentBlackPriceValue: selectedBlack?.value ?? null,
      currentBlackPriceContext: selectedBlack?.context || "",
      sellerLowestPriceText: seller?.price?.text || "",
      sellerLowestPriceValue: seller?.price?.value ?? null,
      sellerOfferCount: seller?.count ?? "",
      sellerContext: seller?.text || "",
      note: notes.join("；"),
      candidates: {
        current: [
          ...(current && current !== currentVisual ? [current] : []),
          ...productBlackCandidates,
        ].slice(0, 5).map(({ priceText, text, value, context, source }) => ({ text: priceText || text, value, context, source })),
        green: greenCandidates.slice(0, 3).map(({ priceText, value, context }) => ({ text: priceText, value, context })),
        seller: sellerBlocks.slice(0, 5).map((item) => ({ text: item.text, price: item.price, count: item.count })),
      },
    };
  });
}

async function scrapeOzonSellerOfferPriceInfo(page) {
  const before = await collectOzonBlackPricesOnPage(page).catch(() => []);
  const beforeSeller = before.filter((item) => item.isSellerOffer);
  const opened = await revealOzonSellerOffers(page).catch((error) => ({ opened: false, note: error.message }));
  let after = [];
  if (opened.opened) {
    await humanPause(page, 1200, 2800);
    await humanScroll(page, { maxScroll: 2200, minStep: 360, maxStep: 820, minDelay: 160, maxDelay: 420 });
    after = await collectOzonBlackPricesOnPage(page).catch(() => []);
  }
  const pool = uniqueOzonPriceCandidates([
    ...beforeSeller,
    ...(opened.opened ? after.filter((item) => item.isSellerOffer || opened.source !== "none") : []),
  ]);
  const lowest = pool.sort((a, b) => a.value - b.value)[0] || null;
  return {
    lowestText: lowest?.text || "",
    lowestValue: lowest?.value ?? null,
    lowestContext: lowest?.context || "",
    count: pool.length,
    source: opened.source || (beforeSeller.length ? "page" : "none"),
    note: lowest ? "" : (opened.note || "未在页面中发现可识别的跟卖黑标价"),
    candidates: pool.slice(0, 10),
  };
}

async function revealOzonSellerOffers(page) {
  const action = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const toAbs = (value) => {
      try {
        return value ? new URL(value, location.href).href : "";
      } catch {
        return "";
      }
    };
    const pattern = /другие продавцы|все продавцы|все предложения|предложения продавц|ещ[её]\s+\d+\s+продав|продавц[а-я]+\s+от|сравнить цены|other sellers|all offers/i;
    const elements = Array.from(document.querySelectorAll("a, button, [role='button']"));
    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) continue;
      const text = clean(`${el.innerText || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`);
      const href = toAbs(el.getAttribute("href") || el.href || "");
      if (!pattern.test(text)) continue;
      if (href && !href.startsWith("javascript:")) {
        return { opened: true, source: "link", href, text: text.slice(0, 120) };
      }
      el.scrollIntoView({ block: "center", inline: "center" });
      el.click();
      return { opened: true, source: "button", text: text.slice(0, 120) };
    }
    return { opened: false, source: "none", note: "没有找到其他卖家/跟卖入口" };
  });
  if (action.href) {
    await page.goto(action.href, { waitUntil: "domcontentloaded", timeout: 60000 });
  }
  return action;
}

async function collectOzonBlackPricesOnPage(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const toAbs = (value) => {
      try {
        return value ? new URL(value, location.href).href : "";
      } catch {
        return "";
      }
    };
    const parseRubPrice = (text) => {
      const match = String(text || "").match(/(\d[\d\s.,]{0,12})\s*(?:₽|руб\.?|р\b)/i);
      if (!match) return null;
      const value = Number(match[1].replace(/\s/g, "").replace(",", "."));
      return Number.isFinite(value) ? value : null;
    };
    const isDarkColor = (color) => {
      const match = String(color || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (!match) return false;
      const [r, g, b] = match.slice(1).map(Number);
      return r <= 95 && g <= 95 && b <= 95 && r + g + b <= 210;
    };
    const skipContext = /балл|кешбэк|рассроч|скидк|эконом|выгода|до скидки|старая цена|зачерк|card|карта|premium|рассрочка|месяц|x\d/i;
    const sellerContext = /продав|предложен|магазин|поставщик|другие продавцы|все продавцы|ещ[её]|other sellers|all offers/i;
    const candidates = [];
    const seen = new Set();
    const nodes = Array.from(document.querySelectorAll("body *")).filter((node) => {
      const text = clean(node.textContent);
      return text && text.length <= 180 && /(?:₽|руб\.?|р\b)/i.test(text);
    });
    for (const node of nodes) {
      const text = clean(node.textContent);
      const value = parseRubPrice(text);
      if (!value) continue;
      const style = getComputedStyle(node);
      const area = node.closest('[data-widget], section, article, div, li');
      const context = clean(area?.innerText || text).slice(0, 300);
      const decoration = `${style.textDecorationLine || ""} ${style.textDecoration || ""}`;
      const isOldPrice = /line-through/i.test(decoration) || /до скидки|старая цена|скидк|эконом|выгода/i.test(context);
      const isBlackPrice = isDarkColor(style.color) && !isOldPrice && !skipContext.test(`${text} ${context}`);
      if (!isBlackPrice) continue;
      const key = `${value}:${text}:${context.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        value,
        text,
        context,
        isSellerOffer: sellerContext.test(context),
        href: toAbs(node.closest("a")?.href || ""),
      });
    }
    return candidates.sort((a, b) => a.value - b.value).slice(0, 40);
  });
}

function uniqueOzonPriceCandidates(candidates) {
  const seen = new Set();
  const unique = [];
  for (const item of candidates) {
    const key = `${item.value}:${item.text}:${String(item.context || "").slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

async function search1688ByImage(context, imageInfo, maxCandidates, jobId, productIndex) {
  const activeJob = getActiveJobById(jobId);
  const page = await prepare1688Page(context, activeJob);
  await waitForHumanVerificationIfNeeded(page, context, getActiveJobById(jobId), "1688 首页/搜图准备");
  const compressedBase64 = await compressImageFor1688(page, imageInfo.buffer, imageInfo.contentType);
  let cookieState = await ensure1688CookieState(context, activeJob);

  if (!cookieState.token) {
    return {
      success: false,
      error: "没有拿到 1688 搜图 token。请先点击“打开 1688 登录窗口”，完成登录后重新开始任务。",
    };
  }

  try {
    return { success: true, candidates: await collect1688Candidates(context, compressedBase64, cookieState, maxCandidates, jobId, productIndex) };
  } catch (error) {
    if (isMtopTokenError(error.message)) {
      if (activeJob) log(activeJob, "1688 搜图 token 失效，正在刷新 token 并重试一次。", "warn");
      cookieState = await ensure1688CookieState(context, activeJob, { forceRefresh: true });
      if (cookieState.token) {
        try {
          return { success: true, candidates: await collect1688Candidates(context, compressedBase64, cookieState, maxCandidates, jobId, productIndex) };
        } catch (retryError) {
          return { success: false, error: retryError.message };
        }
      }
    }
    return { success: false, error: error.message };
  }
}

async function collect1688Candidates(context, compressedBase64, cookieState, maxCandidates, jobId, productIndex) {
  const activeJob = getActiveJobById(jobId);
  const imageId = await uploadImageTo1688(compressedBase64, cookieState);
  await sleep(randomInt(1200, 3200));
  const candidates = (await searchOffersByImageId(imageId, cookieState)).slice(0, maxCandidates);
  const enrichedCandidates = [];
  for (const [index, candidate] of candidates.entries()) {
    if (activeJob?.cancelRequested) break;
    if (index > 0) await sleep(randomInt(DETAIL_DELAY_MIN_MS, DETAIL_DELAY_MAX_MS));
    const candidateNumber = index + 1;
    const startedAt = Date.now();
    if (activeJob) log(activeJob, `正在采集 1688 候选详情 ${candidateNumber}/${candidates.length}。`);
    const details = await scrape1688CandidateDetails(context, candidate, jobId, productIndex, index + 1);
    const enriched = addTrafficBaitAssessment(merge1688CandidateDetails(candidate, details));
    if (enriched.image) {
      try {
        enriched.localImage = await download1688CandidateImage(context, jobId, productIndex, index + 1, enriched.image, enriched.link);
      } catch (error) {
        enriched.imageDownloadError = error.message;
      }
    }
    enrichedCandidates.push(enriched);
    if (activeJob) {
      const elapsedSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(1));
      log(activeJob, `1688 候选详情 ${candidateNumber}/${candidates.length} 完成，用时 ${elapsedSeconds} 秒。`);
    }
  }
  return enrichedCandidates;
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
    sign: signMtop(cookieState.token, timestamp, dataStr),
    type: "originaljson",
    dataType: "jsonp",
    jsonpIncPrefix: "reqTppId_32517_getOfferList",
  });

  const response = await fetch(url, {
    method: "POST",
    headers: build1688Headers(cookieState.cookieHeader, {
      "Content-Type": "application/x-www-form-urlencoded",
    }),
    body: `data=${encodeURIComponent(dataStr)}`,
  });
  const json = parseMtopText(await response.text());
  assertMtopSuccess(json, "上传图片失败");

  const imageId =
    json.data?.data?.imageId ||
    json.data?.imageId ||
    json.data?.result?.[0]?.imageId;
  if (!imageId) {
    throw new Error(`上传成功但没有返回 imageId：${JSON.stringify(json).slice(0, 500)}`);
  }
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
    sign: signMtop(cookieState.token, timestamp, dataStr),
    type: "jsonp",
    callback: "mtopjsonpreqTppId_32517_getOfferList2",
    dataType: "jsonp",
    jsonpIncPrefix: "reqTppId_32517_getOfferList",
    data: dataStr,
  });

  const response = await fetch(url, {
    method: "GET",
    headers: build1688Headers(cookieState.cookieHeader),
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
    const priceRangeMoq = Array.isArray(data.priceInfo?.priceRange)
      ? data.priceInfo.priceRange[0]?.beginAmount
      : "";
    const priceRangeMoqAlt = Array.isArray(data.priceRange)
      ? data.priceRange[0]?.beginAmount
      : "";
    const priceRangesMoq = Array.isArray(data.priceRanges)
      ? data.priceRanges[0]?.beginAmount
      : "";
    const moqRaw = pickFirstText(
      moqItem?.text,
      moqItem?.value,
      moqItem?.name,
      data.minOrderQuantity,
      data.minimumOrderQuantity,
      data.minOrder,
      data.beginAmount,
      data.startAmount,
      data.batchNumber,
      data.moq,
      data.priceInfo?.beginAmount,
      priceRangeMoq,
      priceRangeMoqAlt,
      priceRangesMoq,
    );
    const moqText = moqRaw && /^\d+(?:\.\d+)?$/.test(String(moqRaw).trim())
      ? `${String(moqRaw).trim()}件起批`
      : moqRaw;
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
      moq: moqText,
      minOrderQuantity: moqText,
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

async function download1688CandidateImage(context, jobId, productIndex, index, url, referer) {
  return downloadImageFile(context, {
    jobId,
    index,
    prefix: `1688_${String(productIndex).padStart(3, "0")}`,
    url,
    referer: referer || "https://www.1688.com/",
  });
}

async function scrape1688CandidateDetails(context, candidate, jobId, productIndex, candidateIndex) {
  if (!candidate.link) return { detailError: "没有候选链接" };
  const page = await context.newPage();
  try {
    await page.goto(candidate.link, { waitUntil: "domcontentloaded", timeout: 70000 });
    await humanPause(page, 3500, 8000);
    await waitForHumanVerificationIfNeeded(page, context, getActiveJobById(jobId), `1688 候选详情 ${productIndex}-${candidateIndex}`);
    await humanBrowse1688DetailPage(page);
    await waitForHumanVerificationIfNeeded(page, context, getActiveJobById(jobId), `1688 候选详情 ${productIndex}-${candidateIndex}`);
    await humanPause(page, 1800, 4200);

    return await page.evaluate((fallback) => {
      const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
      const pick = (...values) => values.map(clean).find(Boolean) || "";
      const unwrap = (value) => (value && typeof value === "object" && value.fields ? value.fields : value);
      const normalizeWeightGramsInPage = (value) => {
        const text = clean(value);
        if (!text) return null;
        const match = text.match(/(\d+(?:[.,]\d+)?)\s*(кг|kg|公斤|千克|килограмм(?:а|ов)?|г|g|克|гр|грамм(?:а|ов)?|мг|mg|毫克)(?=$|[\s,.;，。；、/)\]}])/i);
        if (match) {
          const number = Number(match[1].replace(",", "."));
          const unit = match[2].toLowerCase();
          if (!Number.isFinite(number) || number <= 0) return null;
          if (/^(кг|kg|公斤|千克)|килограмм/i.test(unit)) return Math.round(number * 1000);
          if (/^(мг|mg|毫克)/i.test(unit)) return Math.max(1, Math.round(number / 1000));
          return Math.round(number);
        }
        if (/^\d+(?:[.,]\d+)?$/.test(text)) {
          const number = Number(text.replace(",", "."));
          if (!Number.isFinite(number) || number <= 0) return null;
          if (number < 1) return Math.round(number * 1000);
          if (number < 30 && !Number.isInteger(number)) return Math.round(number * 1000);
          return Math.round(number);
        }
        return null;
      };
      const weightKeyPattern = /(?:weight|unitweight|skuweight|grossweight|netweight|packageweight|pieceweight|重量|克重|毛重|净重|包装重|发货重|商品重|计费重)/i;
      const shippingKeyPattern = /(?:shippingfee|shipping|shiptemplate|postage|postfee|postfeevalue|freight|freightfee|freightprice|freighttemplate|freightmodule|logisticsfee|logisticsinfo|deliveryfee|deliverytemplate|expressfee|templatefee|carriage|totalcost|logistics|delivery|express|运费|物流费|物流|快递费|快递|配送费|配送|发货费|邮费|邮资|运费模板|物流模板)/i;
      const moqKeyPattern = /(?:minorder|minorderquantity|minimumorder|beginamount|startamount|batchnumber|moq|起批|起订|起购|起拍|最小起订|最少起批)/i;
      const primitiveWeightValue = (value) => {
        if (typeof value === "string" || typeof value === "number") return value;
        if (!value || typeof value !== "object") return "";
        return pick(value.value, value.text, value.name, value.title, value.displayValue, value.displayName, value.content);
      };
      const primitiveShippingValue = (value) => {
        if (typeof value === "string" || typeof value === "number") return value;
        if (!value || typeof value !== "object") return "";
        return pick(value.value, value.text, value.name, value.title, value.displayValue, value.displayName, value.content, value.amount, value.price, value.fee, value.cost);
      };
      const findWeightInRaw = (root) => {
        const seen = new Set();
        const stack = [{ key: "", value: root, depth: 0 }];
        const candidates = [];
        let visited = 0;
        while (stack.length && candidates.length < 24 && visited < 2500) {
          const item = stack.pop();
          visited += 1;
          const key = clean(item.key);
          const value = item.value;
          if (value == null || item.depth > 7) continue;
          const candidate = primitiveWeightValue(value);
          if (candidate && weightKeyPattern.test(key) && normalizeWeightGramsInPage(candidate)) candidates.push(candidate);
          if (typeof value !== "object") continue;
          if (seen.has(value)) continue;
          seen.add(value);
          const entries = Array.isArray(value) ? value.map((child, index) => [String(index), child]) : Object.entries(value);
          for (const [childKey, childValue] of entries.slice(0, 160)) {
            stack.push({ key: key ? `${key}.${childKey}` : childKey, value: childValue, depth: item.depth + 1 });
          }
        }
        return candidates.find((value) => normalizeWeightGramsInPage(value)) || "";
      };
      const normalizeShippingFeeInPage = (value, depth = 0) => {
        if (value == null || depth > 4) return "";
        if (typeof value === "object") {
          const candidates = [
            value.totalCost,
            value.postFeeValue,
            value.shippingFee,
            value.freightFee,
            value.freightPrice,
            value.logisticsFee,
            value.deliveryFee,
            value.deliveryTemplate,
            value.expressFee,
            value.templateFee,
            value.price,
            value.fee,
            value.amount,
            value.cost,
            value.freight,
            value.freightTemplate,
            value.freightModule,
            value.logisticsInfo,
            value.postage,
            value.carriage,
            value.shipTemplate,
            value.value,
            value.text,
            value.title,
            value.name,
            value.displayText,
            value.displayValue,
            value.content,
          ];
          for (const item of candidates) {
            const normalized = normalizeShippingFeeInPage(item, depth + 1);
            if (normalized) return normalized;
          }
          if (!Array.isArray(value)) {
            for (const [key, child] of Object.entries(value).slice(0, 80)) {
              if (!shippingKeyPattern.test(key)) continue;
              const normalized = normalizeShippingFeeInPage(child, depth + 1);
              if (normalized) return normalized;
            }
          }
          return "";
        }
        const text = clean(value);
        if (!text) return "";
        if (/包邮|免运费|免费配送|卖家承担|free\s*shipping|运费\s*0|物流费\s*0/i.test(text)) return "0";
        const match = text.match(/(?:¥|￥|RMB|CNY)?\s*(\d+(?:[.,]\d+)?)(?:\s*(?:元|块|rmb|cny))?/i);
        if (!match) return "";
        const number = Number(match[1].replace(",", "."));
        if (!Number.isFinite(number) || number < 0 || number > 9999) return "";
        return String(number);
      };
      const pickShippingFee = (...values) => {
        for (const value of values) {
          const normalized = normalizeShippingFeeInPage(value);
          if (normalized !== "") return normalized;
        }
        return "";
      };
      const pickSourcedWeight = (items) => {
        for (const item of items) {
          const value = clean(item?.value);
          if (value && normalizeWeightGramsInPage(value)) return { value, source: item.source };
        }
        return { value: "", source: "" };
      };
      const pickSourcedShippingFee = (items) => {
        for (const item of items) {
          const normalized = normalizeShippingFeeInPage(item?.value);
          if (normalized !== "") return { value: normalized, source: item.source };
        }
        return { value: "", source: "" };
      };
      const findShippingInRaw = (root) => {
        const seen = new Set();
        const stack = [{ key: "", value: root, depth: 0 }];
        const candidates = [];
        let visited = 0;
        while (stack.length && candidates.length < 24 && visited < 3500) {
          const item = stack.pop();
          visited += 1;
          const key = clean(item.key);
          const value = item.value;
          if (value == null || item.depth > 8) continue;
          const candidate = primitiveShippingValue(value);
          if (candidate && shippingKeyPattern.test(key)) {
            const normalized = normalizeShippingFeeInPage(candidate);
            if (normalized) candidates.push(normalized);
          }
          if (typeof value !== "object") continue;
          if (seen.has(value)) continue;
          seen.add(value);
          const entries = Array.isArray(value) ? value.map((child, index) => [String(index), child]) : Object.entries(value);
          for (const [childKey, childValue] of entries.slice(0, 180)) {
            stack.push({ key: key ? `${key}.${childKey}` : childKey, value: childValue, depth: item.depth + 1 });
          }
        }
        return candidates.find(Boolean) || "";
      };
      const normalizeMoqInPage = (value, depth = 0) => {
        if (value == null || depth > 3) return "";
        if (typeof value === "object") {
          const candidates = [
            value.minOrderQuantity,
            value.minimumOrderQuantity,
            value.minOrder,
            value.minimumOrder,
            value.beginAmount,
            value.startAmount,
            value.batchNumber,
            value.moq,
            value.value,
            value.text,
            value.title,
            value.name,
            value.displayValue,
            value.content,
          ];
          for (const item of candidates) {
            const normalized = normalizeMoqInPage(item, depth + 1);
            if (normalized) return normalized;
          }
          if (!Array.isArray(value)) {
            for (const [key, child] of Object.entries(value).slice(0, 80)) {
              if (!moqKeyPattern.test(key)) continue;
              const normalized = normalizeMoqInPage(child, depth + 1);
              if (normalized) return normalized;
            }
          }
          return "";
        }
        const text = clean(value);
        if (!text) return "";
        if (/一\s*(?:件|个|只|套|箱|包)?\s*(?:起批|起订|起购|可批|拿样|代发)|1\s*(?:件|个|只|套|箱|包)?\s*(?:起批|起订|起购|可批|拿样|代发)|(?:起批|起订|起购|起订量|起购量|最少起批|min(?:imum)?\s*order(?:\s*qty|\s*quantity)?|minimum\s*purchase|moq)\s*[:：]?\s*1(?:\D|$)/i.test(text)) return "1件起批";
        const direct = text.match(/^(\d+(?:\.\d+)?)$/);
        const match = text.match(/(?:^|[^\d])(\d+(?:\.\d+)?)\s*(?:件|个|只|套|箱|包|pcs?|piece|pieces)?\s*(?:起批|起订|起购|起拍|可批|拿样|代发|min(?:imum)?\s*order(?:\s*qty|\s*quantity)?|minimum\s*purchase|moq)/i)
          || text.match(/(?:起批|起订|起购|起拍|起订量|起购量|最少起批|min(?:imum)?\s*order(?:\s*qty|\s*quantity)?|minimum\s*purchase|moq)\s*[:：]?\s*(\d+(?:\.\d+)?)/i)
          || direct;
        if (!match) return "";
        const number = Number(match[1]);
        if (!Number.isFinite(number) || number <= 0 || number > 100000) return "";
        return `${Math.ceil(number)}件起批`;
      };
      const findMoqInRaw = (root) => {
        const seen = new Set();
        const stack = [{ key: "", value: root, depth: 0 }];
        const candidates = [];
        let visited = 0;
        while (stack.length && candidates.length < 24 && visited < 3000) {
          const item = stack.pop();
          visited += 1;
          const key = clean(item.key);
          const value = item.value;
          if (value == null || item.depth > 7) continue;
          if (moqKeyPattern.test(key)) {
            const normalized = normalizeMoqInPage(value);
            if (normalized) candidates.push(normalized);
          }
          if (typeof value !== "object") continue;
          if (seen.has(value)) continue;
          seen.add(value);
          const entries = Array.isArray(value) ? value.map((child, index) => [String(index), child]) : Object.entries(value);
          for (const [childKey, childValue] of entries.slice(0, 160)) {
            stack.push({ key: key ? `${key}.${childKey}` : childKey, value: childValue, depth: item.depth + 1 });
          }
        }
        return candidates.find(Boolean) || "";
      };
      const promotionPattern = /首单|首件|首购|新人|新客|新用户|新人价|新客价|首单价|首单减|首购价|立减|满减|优惠|优惠券|券后|领券|补贴|到手价|特价|限时|促销|专享|折扣|discount|coupon|new\s*user|first\s*order/i;
      const raw =
        window.__INIT_DATA?.data ||
        window.context?.result?.data ||
        window.iDetailData ||
        {};
      const collectPromotionSnippets = (value, snippets = [], depth = 0) => {
        if (snippets.length >= 24 || depth > 5 || value == null) return snippets;
        if (typeof value === "string" || typeof value === "number") {
          const text = clean(value);
          if (promotionPattern.test(text) && text.length <= 220) snippets.push(text);
          return snippets;
        }
        if (Array.isArray(value)) {
          for (const item of value.slice(0, 80)) collectPromotionSnippets(item, snippets, depth + 1);
          return snippets;
        }
        if (typeof value === "object") {
          for (const [key, child] of Object.entries(value).slice(0, 120)) {
            if (promotionPattern.test(key)) snippets.push(clean(`${key}: ${typeof child === "object" ? "" : child}`));
            collectPromotionSnippets(child, snippets, depth + 1);
          }
        }
        return snippets;
      };

      const attrs = {};
      const addPair = (key, value) => {
        const k = clean(key).replace(/[:：]$/, "");
        const v = clean(value);
        if (k && v && k !== v && k.length <= 80 && v.length <= 300) attrs[k] = v;
      };

      const productAttrs = unwrap(raw.productAttributes || {});
      if (productAttrs?.product_attributes) {
        for (const [key, value] of Object.entries(productAttrs.product_attributes)) addPair(key, value);
      } else if (productAttrs && typeof productAttrs === "object") {
        for (const [key, value] of Object.entries(productAttrs)) {
          if (typeof value === "string" || typeof value === "number") addPair(key, value);
        }
      }
      const featureAttrs = raw.offerDetail?.featureAttributes || [];
      if (Array.isArray(featureAttrs)) {
        for (const item of featureAttrs) addPair(item?.name, item?.value);
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
        const normalized = names.map((name) => String(name).toLowerCase());
        for (const [key, value] of Object.entries(attrs)) {
          const lower = key.toLowerCase();
          if (normalized.some((name) => lower.includes(name))) return value;
        }
        return "";
      };

      const asArray = (value) => (Array.isArray(value) ? value : []);
      const mainPrice = unwrap(raw.mainPrice || {});
      const orderParamModel = unwrap(raw.orderParamModel || {});
      const orderParam = orderParamModel.orderParam || {};
      const skuParam = orderParam.skuParam || {};
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

      const skuModel = unwrap(raw.skuModel || raw.rawFusion?.skuSelection || {});
      const skuInfoMap = skuModel.skuInfoMap || {};
      const skuPrices = Object.values(skuInfoMap)
        .map((item) => item?.price ?? item?.originalPrice ?? item?.salePrice)
        .filter((value) => value !== undefined && value !== null && value !== "");
      const priceDetails = priceRanges.length
        ? priceRanges.map((item) => `${item.beginAmount || 1}件起 ¥${item.price}`).join("; ")
        : "";
      const rangePrices = priceRanges
        .map((item) => Number(String(item.price).replace(/[^\d.]/g, "")))
        .filter((value) => Number.isFinite(value) && value > 0);
      const minPrice = [...rangePrices, ...skuPrices
        .map(Number)
        .filter((value) => Number.isFinite(value) && value > 0)]
        .sort((a, b) => a - b)[0];
      const price = pick(
        minPrice ? String(minPrice) : "",
        String(fallback.price || "").match(/^\s*\d+(?:\.\d+)?\s*$/) ? fallback.price : "",
      );

      const rawBodyText = document.body.innerText || "";
      const bodyText = clean(rawBodyText);
      const findWeightInBody = () => {
        const match = bodyText.match(/(?:包装重量|发货重量|商品重量|产品重量|计费重量|毛重|净重|克重|重量)\s*[:：]?\s*(\d+(?:[.,]\d+)?\s*(?:kg|公斤|千克|g|克|mg|毫克))/i);
        return match ? match[1] : "";
      };
      const findShippingInBody = () => {
        if (/包邮|免运费|免费配送|卖家承担运费/i.test(bodyText)) return "0";
        const match = bodyText.match(/(?:运费|物流费用|物流费|快递费|配送费|发货费用|邮费)\s*[:：]?\s*(?:¥|￥|RMB|CNY)?\s*(\d+(?:[.,]\d+)?)(?:\s*(?:元|块|rmb|cny))?/i);
        return match ? normalizeShippingFeeInPage(match[1]) : "";
      };
      const promotionLines = rawBodyText.split(/\n+/)
        .map(clean)
        .filter((line) => promotionPattern.test(line) && line.length <= 220)
        .slice(0, 16);
      const promotionText = Array.from(new Set([
        ...promotionLines,
        ...collectPromotionSnippets(raw),
      ].filter(Boolean))).slice(0, 24).join("；");
      const moqFromPriceRange = priceRanges
        .map((item) => Number(item.beginAmount))
        .filter((value) => Number.isFinite(value) && value > 0)
        .sort((a, b) => a - b)[0];
      const moqFromDom = bodyText.match(/(\d+)\s*(?:件|个|只|套|箱|包)\s*起批/);
      const minOrderQuantity = pick(
        moqFromPriceRange ? `${moqFromPriceRange}件起批` : "",
        moqFromDom ? `${moqFromDom[1]}件起批` : "",
        normalizeMoqInPage(fallback.moq),
        findMoqInRaw(raw),
        fallback.moq,
      );

      const packInfo = unwrap(raw.productPackInfo || raw.pieceWeightScale || raw.offerDetail?.pieceWeightScale || {});
      const pieceWeightScale = packInfo.pieceWeightScale || packInfo;
      const scaleInfoList = asArray(pieceWeightScale.pieceWeightScaleInfo || packInfo.pieceWeightScaleInfo);
      const columnList = asArray(pieceWeightScale.columnList || packInfo.columnList);
      const colMap = {};
      for (const col of columnList) {
        const label = clean(col.label || col.title || col.name);
        const name = col.name || col.field || col.key;
        if (!name) continue;
        if (/长|length/i.test(label)) colMap.length = name;
        if (/宽|width/i.test(label)) colMap.width = name;
        if (/高|height/i.test(label)) colMap.height = name;
        if (/重|weight/i.test(label)) colMap.weight = name;
      }
      const firstScale = scaleInfoList.find((item) =>
        item && (
          item[colMap.length] || item.length ||
          item[colMap.width] || item.width ||
          item[colMap.height] || item.height ||
          item[colMap.weight] || item.weight
        )
      ) || {};

      const length = pick(firstScale[colMap.length], firstScale.length, firstScale.long, getAttr("长", "length"));
      const width = pick(firstScale[colMap.width], firstScale.width, getAttr("宽", "width"));
      const height = pick(firstScale[colMap.height], firstScale.height, getAttr("高", "height"));
      const attrDimension = getAttr("尺寸", "规格尺寸", "包装尺寸", "产品尺寸");
      const dimensionsText = length || width || height
        ? `${length || "-"} x ${width || "-"} x ${height || "-"} cm`
        : attrDimension;

      const shipping = unwrap(raw.shippingServices || {});
      const freightInfo = shipping.freightInfo || {};
      const skuWeight = freightInfo.skuWeight && typeof freightInfo.skuWeight === "object"
        ? Object.values(freightInfo.skuWeight).find(Boolean)
        : "";
      const attrWeight = getAttr("包装重量", "发货重量", "商品重量", "产品重量", "计费重量", "重量", "克重", "毛重", "净重", "weight");
      const rawWeight = findWeightInRaw(raw);
      const bodyWeight = findWeightInBody();
      const pickedWeight = pickSourcedWeight([
        { value: firstScale[colMap.weight], source: "1688规格表字段" },
        { value: firstScale.weight, source: "1688规格表weight" },
        { value: firstScale.unitWeight, source: "1688规格表unitWeight" },
        { value: firstScale.grossWeight, source: "1688规格表grossWeight" },
        { value: firstScale.netWeight, source: "1688规格表netWeight" },
        { value: packInfo.unitWeight, source: "1688包装信息unitWeight" },
        { value: packInfo.grossWeight, source: "1688包装信息grossWeight" },
        { value: packInfo.netWeight, source: "1688包装信息netWeight" },
        { value: packInfo.packageWeight, source: "1688包装信息packageWeight" },
        { value: shipping.unitWeight, source: "1688物流信息unitWeight" },
        { value: shipping.grossWeight, source: "1688物流信息grossWeight" },
        { value: shipping.netWeight, source: "1688物流信息netWeight" },
        { value: shipping.packageWeight, source: "1688物流信息packageWeight" },
        { value: skuWeight, source: "1688运费skuWeight" },
        { value: attrWeight, source: "1688属性表" },
        { value: rawWeight, source: "1688页面原始数据" },
        { value: bodyWeight, source: "1688页面文本" },
      ]);
      const weightRaw = pickedWeight.value;
      const weightGrams = normalizeWeightGramsInPage(weightRaw);
      const weightText = weightGrams ? `${weightGrams} g` : "";

      const attrShipping = getAttr("运费", "物流费用", "物流费", "快递费", "配送费", "发货费用", "邮费");
      const rawShipping = findShippingInRaw(raw);
      const bodyShipping = findShippingInBody();
      const pickedShipping = pickSourcedShippingFee([
        { value: freightInfo.totalCost, source: "1688运费freightInfo.totalCost" },
        { value: freightInfo.postFeeValue, source: "1688运费freightInfo.postFeeValue" },
        { value: freightInfo.shippingFee, source: "1688运费freightInfo.shippingFee" },
        { value: freightInfo.freightFee, source: "1688运费freightInfo.freightFee" },
        { value: freightInfo.freightPrice, source: "1688运费freightInfo.freightPrice" },
        { value: freightInfo.logisticsFee, source: "1688运费freightInfo.logisticsFee" },
        { value: freightInfo.deliveryFee, source: "1688运费freightInfo.deliveryFee" },
        { value: freightInfo.expressFee, source: "1688运费freightInfo.expressFee" },
        { value: shipping.totalCost, source: "1688物流shipping.totalCost" },
        { value: shipping.postFeeValue, source: "1688物流shipping.postFeeValue" },
        { value: shipping.shippingFee, source: "1688物流shipping.shippingFee" },
        { value: shipping.freightFee, source: "1688物流shipping.freightFee" },
        { value: shipping.freightPrice, source: "1688物流shipping.freightPrice" },
        { value: shipping.logisticsFee, source: "1688物流shipping.logisticsFee" },
        { value: shipping.deliveryFee, source: "1688物流shipping.deliveryFee" },
        { value: shipping.expressFee, source: "1688物流shipping.expressFee" },
        { value: attrShipping, source: "1688属性表" },
        { value: rawShipping, source: "1688页面原始数据" },
        { value: bodyShipping, source: "1688页面文本" },
      ]);
      const shippingFee = pickedShipping.value || (/运费|物流|快递|配送/.test(bodyText) ? "未公开/需选择地区" : "");

      const title = pick(
        raw.productTitle?.fields?.title,
        raw.productTitle?.title,
        document.querySelector("h1")?.innerText,
        fallback.title,
      );

      return {
        title,
        price,
        priceDetails,
        minOrderQuantity,
        moq: minOrderQuantity,
        shippingFee,
        shippingFeeSource: pickedShipping.source || (shippingFee ? "页面提示存在运费但金额未公开" : ""),
        dimensionsText,
        weightText,
        weightGrams,
        weightSource: pickedWeight.source,
        promotionText,
        detailAttributes: attrs,
      };
    }, candidate);
  } catch (error) {
    return { detailError: error.message };
  } finally {
    await page.close().catch(() => {});
  }
}

function merge1688CandidateDetails(candidate, details) {
  const detailAttrText = Object.entries(details.detailAttributes || {})
    .map(([key, value]) => `${key}: ${value}`)
    .join(" ");
  const packQuantity = details.packQuantity || candidate.packQuantity ||
    inferPackQuantityFromText([details.title, candidate.title, detailAttrText].join(" ")).quantity;
  const packQuantityEvidence = details.packQuantityEvidence || candidate.packQuantityEvidence ||
    inferPackQuantityFromText([details.title, candidate.title, detailAttrText].join(" ")).evidence;
  return {
    ...candidate,
    ...details,
    title: details.title || candidate.title,
    price: normalize1688PriceOnly(details.priceDetails || candidate.priceDetails || details.price || candidate.price),
    minOrderQuantity: details.minOrderQuantity || candidate.minOrderQuantity || candidate.moq,
    moq: details.moq || details.minOrderQuantity || candidate.moq,
    shippingFee: details.shippingFee || candidate.shippingFee || "",
    shippingFeeSource: details.shippingFeeSource || candidate.shippingFeeSource || "",
    dimensionsText: details.dimensionsText || candidate.dimensionsText || "",
    weightText: details.weightText || candidate.weightText || "",
    weightGrams: details.weightGrams || candidate.weightGrams || normalizeWeightGrams(details.weightText || candidate.weightText),
    weightSource: details.weightSource || candidate.weightSource || "",
    priceDetails: details.priceDetails || candidate.priceDetails || "",
    promotionText: [candidate.promotionText, details.promotionText].filter(Boolean).join("；"),
    packQuantity,
    packQuantityEvidence,
    detailError: details.detailError || "",
  };
}

function addTrafficBaitAssessment(candidate) {
  const tierPrices = extract1688TierPrices(candidate.priceDetails);
  const fallbackPrice = Number(normalize1688PriceOnly(candidate.price));
  const unitPriceRmb = tierPrices.length
    ? tierPrices[0]
    : Number.isFinite(fallbackPrice) && fallbackPrice > 0
      ? fallbackPrice
      : null;
  const explicitZeroPrice = /[¥￥]\s*0(?:\.0+)?(?:\D|$)|(?:^|[^\d])0(?:\.0+)?\s*(?:元|RMB|CNY)/i.test(String(candidate.priceDetails || candidate.price || ""));
  const positiveValues = (tierPrices.length ? tierPrices : (unitPriceRmb ? [unitPriceRmb] : []))
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  const minPriceRmb = positiveValues[0] ?? null;
  const maxPriceRmb = positiveValues[positiveValues.length - 1] ?? null;
  const hasVeryLowPrice = minPriceRmb !== null && minPriceRmb < LOW_PRICE_THRESHOLD_RMB;
  const hasLargeSpread = minPriceRmb !== null && maxPriceRmb !== null && maxPriceRmb >= 10 && maxPriceRmb / Math.max(minPriceRmb, 0.01) >= 10;
  const invalidPriceRisk = explicitZeroPrice || unitPriceRmb === null;
  const trafficBaitRisk = invalidPriceRisk || hasVeryLowPrice || hasLargeSpread;
  const promotionRisk = hasPromotionRisk(candidate);
  const reasons = [];
  if (explicitZeroPrice) reasons.push("价格为 ¥0，无法作为真实采购价");
  if (unitPriceRmb === null && !explicitZeroPrice) reasons.push("未解析到有效采购价");
  if (hasVeryLowPrice) reasons.push(`出现低于 ¥${LOW_PRICE_THRESHOLD_RMB} 的价格`);
  if (hasLargeSpread) reasons.push("价格区间跨度异常大，可能是引流 SKU");
  const promotionReason = promotionRisk ? summarizePromotionReason(candidate.promotionText || candidate.price || candidate.priceDetails || candidate.title) : "";
  return {
    ...candidate,
    price: unitPriceRmb !== null ? formatPriceNumber(unitPriceRmb) : normalize1688PriceOnly(candidate.priceDetails || candidate.price),
    unitPriceRmb,
    minPriceRmb,
    maxPriceRmb,
    invalidPriceRisk,
    trafficBaitRisk,
    trafficBaitReason: trafficBaitRisk ? reasons.join("；") : "",
    promotionRisk,
    promotionReason,
    avoidForSourcing: trafficBaitRisk,
  };
}

function annotateCandidateQuantity(candidate, ozon) {
  const ozonQuantity = Number(ozon?.packQuantity) > 0
    ? Number(ozon.packQuantity)
    : inferPackQuantityFromText([ozon?.title, ozon?.description].join(" ")).quantity;
  const candidateQuantity = Number(candidate.packQuantity) > 0
    ? Number(candidate.packQuantity)
    : inferPackQuantityFromText([candidate.title, candidate.detailAttributes && JSON.stringify(candidate.detailAttributes)].join(" ")).quantity;
  const purchaseMultiplier = Math.max(1, Math.ceil(Math.max(1, ozonQuantity) / Math.max(1, candidateQuantity)));
  const unitPrice = candidate.unitPriceRmb !== null && candidate.unitPriceRmb !== undefined
    ? Number(candidate.unitPriceRmb)
    : Number(normalize1688PriceOnly(candidate.price || candidate.priceDetails));
  const estimatedPurchasePriceRmb = Number.isFinite(unitPrice) && unitPrice > 0
    ? Number((unitPrice * purchaseMultiplier).toFixed(2))
    : null;
  const quantityAssessment = buildQuantityAssessment(ozonQuantity, candidateQuantity, purchaseMultiplier);
  return {
    ...candidate,
    ozonPackQuantity: ozonQuantity,
    candidatePackQuantity: candidateQuantity,
    purchaseMultiplier,
    unitPriceRmb: Number.isFinite(unitPrice) && unitPrice > 0 ? unitPrice : candidate.unitPriceRmb,
    estimatedPurchasePriceRmb,
    quantityAssessment,
  };
}

function normalizeSourcingCandidateForReview(candidate, ozon) {
  return {
    ...addTrafficBaitAssessment(annotateCandidateQuantity(candidate, ozon)),
    modelMatchScore: getModelMatchScore(ozon, candidate),
  };
}

function getModelMatchScore(ozon = {}, candidate = {}) {
  const ozonText = [ozon.title, ozon.description].filter(Boolean).join(" ").toUpperCase();
  const candidateText = [candidate.title, candidate.detailAttributes && JSON.stringify(candidate.detailAttributes)].filter(Boolean).join(" ").toUpperCase();
  if (!ozonText || !candidateText) return 0;
  const normalize = (value) => String(value || "").replace(/\s+/g, "").toUpperCase();
  const ozonNorm = normalize(ozonText);
  const candidateNorm = normalize(candidateText);
  const patterns = [
    /\b(?:GT|X|K|Q|CF|Z|Y|A|FD|YS|LK)\s*[- ]?\s*\d{1,4}\s*(?:PRO|MAX|PLUS|ULTRA)?\b/gi,
    /\b[A-Z]{1,4}\s*[- ]?\s*\d{1,4}\s*(?:PRO|MAX|PLUS|ULTRA)?\b/gi,
  ];
  const tokens = new Set();
  for (const pattern of patterns) {
    for (const match of ozonText.matchAll(pattern)) {
      const token = normalize(match[0]);
      if (token.length >= 2 && token.length <= 16) tokens.add(token);
    }
  }
  let score = 0;
  for (const token of tokens) {
    if (candidateNorm.includes(token)) score += 180;
    else if (/PRO|MAX|PLUS|ULTRA$/.test(token)) {
      const base = token.replace(/(?:PRO|MAX|PLUS|ULTRA)+$/, "");
      if (base.length >= 2 && candidateNorm.includes(base)) score += 120;
    }
  }
  return Math.min(score, 260);
}

function buildQuantityAssessment(ozonQuantity, candidateQuantity, purchaseMultiplier) {
  if (ozonQuantity <= 1 && candidateQuantity <= 1) return "";
  if (ozonQuantity === candidateQuantity) return `Ozon 与 1688 均识别为 ${ozonQuantity} 件/组。`;
  if (ozonQuantity > candidateQuantity) {
    return `Ozon 疑似 ${ozonQuantity} 件/组，1688 疑似 ${candidateQuantity} 件/组，估算需采购 ${purchaseMultiplier} 组。`;
  }
  return `Ozon 疑似 ${ozonQuantity} 件/组，1688 疑似 ${candidateQuantity} 件/组，数量可能不一致，需人工确认。`;
}

function createOzonNetworkWeightCollector(page) {
  const candidates = [];
  const tasks = [];
  const maxTasks = 80;
  const handler = (response) => {
    if (tasks.length >= maxTasks) return;
    const url = response.url();
    if (!/ozon\./i.test(url)) return;
    if (!/(api|composer|widget|product|card|pdp|frontend|entrypoint|viewer|cell|modal)/i.test(url)) return;
    const headers = response.headers();
    const contentType = headers["content-type"] || "";
    const contentLength = Number(headers["content-length"] || 0);
    if (contentLength && contentLength > 2_500_000) return;
    if (contentType && !/(json|javascript|text|plain)/i.test(contentType)) return;
    const task = (async () => {
      let text = "";
      try {
        text = await response.text();
      } catch {
        return;
      }
      if (!/(weight|вес|масса|重量|毛重|净重|克重|грамм|кг|kg)/i.test(text)) return;
      const source = `ozon-network:${safeUrlPath(url)}`;
      try {
        collectOzonWeightCandidatesFromObject(JSON.parse(text), source, candidates);
      } catch {
        collectOzonWeightCandidatesFromText(text, source, candidates);
      }
    })();
    tasks.push(task);
  };
  page.on("response", handler);
  return {
    async settle(timeoutMs = 2500) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = tasks.slice();
        if (!snapshot.length) {
          await sleep(250);
          if (!tasks.length) break;
          continue;
        }
        await Promise.race([
          Promise.allSettled(snapshot),
          sleep(Math.max(100, deadline - Date.now())),
        ]);
        if (tasks.length === snapshot.length) break;
      }
    },
    getCandidates() {
      return candidates.slice(0, 80);
    },
    dispose() {
      page.off("response", handler);
    },
  };
}

function safeUrlPath(value) {
  try {
    const url = new URL(value);
    return `${url.pathname}${url.search ? "?" : ""}`.slice(0, 120);
  } catch {
    return String(value || "").slice(0, 120);
  }
}

function collectOzonWeightCandidatesFromObject(value, source, candidates, pathName = "", depth = 0) {
  if (!value || candidates.length >= 100 || depth > 7) return;
  if (Array.isArray(value)) {
    for (const [index, item] of value.slice(0, 80).entries()) {
      collectOzonWeightCandidatesFromObject(item, source, candidates, `${pathName}[${index}]`, depth + 1);
      if (candidates.length >= 100) return;
    }
    return;
  }
  if (typeof value !== "object") return;

  const entries = Object.entries(value).slice(0, 160);
  const lowerPath = pathName.toLowerCase();
  const unitHint = value.unit || value.unitName || value.dimension || value.measure || value.measureUnit || value.uom || "";
  const valueHint = value.value ?? value.amount ?? value.number ?? value.val ?? value.text ?? value.title ?? null;
  if (isOzonWeightKey(lowerPath) && valueHint !== null && valueHint !== undefined) {
    candidates.push({
      source,
      key: pathName,
      value: unitHint ? `${valueHint} ${unitHint}` : String(valueHint),
      context: "接口对象 value/unit",
    });
  }

  for (const [key, child] of entries) {
    const childPath = pathName ? `${pathName}.${key}` : key;
    if (child === null || child === undefined) continue;
    if (typeof child === "string" || typeof child === "number") {
      if (isOzonWeightKey(childPath) || /(?:weight|вес|масса|重量|毛重|净重|克重)/i.test(String(child))) {
        candidates.push({
          source,
          key: childPath,
          value: String(child),
          context: "接口字段",
        });
      }
      continue;
    }
    collectOzonWeightCandidatesFromObject(child, source, candidates, childPath, depth + 1);
    if (candidates.length >= 100) return;
  }
}

function collectOzonWeightCandidatesFromText(text, source, candidates) {
  const value = String(text || "").slice(0, 1_200_000);
  const weightKey = String.raw`(?:weight|вес|масса|重量|毛重|净重|克重|shippingWeight|packageWeight|grossWeight|netWeight)`;
  const patterns = [
    new RegExp(`["']([^"']*${weightKey}[^"']*)["']\\s*:\\s*["']([^"']{1,90})["']`, "gi"),
    new RegExp(`["']([^"']*${weightKey}[^"']*)["']\\s*:\\s*(-?\\d+(?:[.,]\\d+)?)`, "gi"),
    new RegExp(`(${weightKey}[^\\n:：]{0,40})[:：]?\\s*(\\d+(?:[.,]\\d+)?\\s*(?:kg|кг|g|гр|г|грамм(?:а|ов)?|克|公斤|千克))`, "gi"),
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      if (candidates.length >= 100) return;
      candidates.push({
        source,
        key: String(match[1] || "").slice(0, 160),
        value: String(match[2] || "").slice(0, 90),
        context: "接口文本",
      });
    }
  }
}

function isOzonWeightKey(value) {
  const text = String(value || "");
  if (!/(weight|вес|масса|重量|毛重|净重|克重)/i.test(text)) return false;
  if (/(height|width|length|depth|dimension|размер|габарит|длина|ширина|высота|объем|volume|尺寸|长|宽|高)/i.test(text) && !/(weight|вес|масса|重量|毛重|净重|克重)/i.test(text.replace(/volumeweight/i, "weight"))) {
    return false;
  }
  return true;
}

function inferOzonWeight(ozon = {}) {
  const rawCandidates = [];
  const addRawCandidate = (source, key, value, context = "") => {
    if (value === null || value === undefined || value === "") return;
    rawCandidates.push({
      source,
      key: String(key || ""),
      value: String(value),
      context: String(context || ""),
    });
  };

  for (const candidate of ozon.networkWeightCandidates || []) {
    addRawCandidate(candidate.source || "ozon-network", candidate.key, candidate.value, candidate.context);
  }
  for (const candidate of ozon.hiddenWeightCandidates || []) {
    addRawCandidate(candidate.source || "page-hidden", candidate.key, candidate.value, candidate.context);
  }

  const attrs = { ...(ozon.attributes || {}) };
  const additional = Array.isArray(ozon.additionalProperty) ? ozon.additionalProperty : [];
  for (const item of additional) {
    const key = item?.name || item?.propertyID || item?.["@type"] || "";
    const value = item?.value || item?.description || "";
    if (key && value && !attrs[key]) attrs[key] = value;
    addRawCandidate("jsonld-additionalProperty", key, value, "JSON-LD additionalProperty");
  }
  const preferredKeys = [
    /вес\s+товара\s+с\s+упаков/i,
    /вес\s+с\s+упаков/i,
    /shipping\s+weight/i,
    /package\s+weight/i,
    /вес\s+товара/i,
    /^вес$/i,
    /масса/i,
    /weight/i,
    /重量|毛重|净重|克重/i,
  ];
  const badKeys = /размер|габарит|длина|ширина|высота|объем|volume|尺寸|长|宽|高|起批|库存/i;
  for (const keyPattern of preferredKeys) {
    for (const [key, value] of Object.entries(attrs)) {
      const keyText = String(key || "");
      if (!keyPattern.test(keyText) || badKeys.test(keyText)) continue;
      addRawCandidate("page-attribute", key, value, "页面商品属性");
    }
  }

  const productWeight = ozon.weight || ozon.weightValue || ozon.additionalProperty?.weight;
  addRawCandidate("jsonld", "product.weight", productWeight, "JSON-LD Product");

  const normalizedCandidates = normalizeOzonWeightCandidates(rawCandidates);
  const best = normalizedCandidates[0];
  if (best) {
    return {
      weightText: `${best.grams} g`,
      weightGrams: best.grams,
      source: formatOzonWeightSource(best.source),
      evidence: `${formatOzonWeightSource(best.source)}：${best.key} = ${best.value}`,
      candidates: normalizedCandidates.slice(0, 12),
    };
  }

  return { weightText: "", weightGrams: "", source: "", evidence: "", candidates: [] };
}

function normalizeOzonWeightCandidates(rawCandidates = []) {
  const seen = new Set();
  return rawCandidates
    .map((candidate) => {
      const grams = normalizeOzonWeightCandidateGrams(candidate);
      if (!grams) return null;
      const source = String(candidate.source || "");
      const key = String(candidate.key || "");
      const value = String(candidate.value || "");
      const score = scoreOzonWeightCandidate({ ...candidate, grams });
      const normalized = {
        source,
        key,
        value,
        context: String(candidate.context || ""),
        grams,
        score,
      };
      const dedupeKey = `${grams}:${source}:${key}:${value}`;
      if (seen.has(dedupeKey)) return null;
      seen.add(dedupeKey);
      return normalized;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.grams - b.grams);
}

function normalizeOzonWeightCandidateGrams(candidate = {}) {
  const key = String(candidate.key || "");
  const value = String(candidate.value ?? "").replace(/&quot;|&#34;/g, '"').replace(/\\u002F/g, "/").trim();
  if (!value || !isOzonWeightKey(key) && !/(kg|кг|g|гр|г|грамм|克|公斤|千克|重量|вес|масса|weight)/i.test(value)) return null;
  const withUnit = normalizeWeightGrams(value);
  if (withUnit) return validOzonWeightGrams(withUnit);

  const numberMatch = value.match(/-?\d+(?:[.,]\d+)?/);
  if (!numberMatch) return null;
  const number = Number(numberMatch[0].replace(",", "."));
  if (!Number.isFinite(number) || number <= 0) return null;
  const keyText = key.toLowerCase();
  let grams = number;
  if (/(kg|kilogram|килограмм|кг|вескг|weightkg|weight_kg)/i.test(keyText)) {
    grams = number * 1000;
  } else if (/(mg|milligram|мг|weightmg|weight_mg)/i.test(keyText)) {
    grams = number / 1000;
  } else if (number < 1 || (number < 30 && !Number.isInteger(number))) {
    grams = number * 1000;
  }
  return validOzonWeightGrams(Math.round(grams));
}

function validOzonWeightGrams(value) {
  const grams = Number(value);
  if (!Number.isFinite(grams) || grams <= 0 || grams > 300000) return null;
  return Math.max(1, Math.round(grams));
}

function scoreOzonWeightCandidate(candidate = {}) {
  const text = `${candidate.source || ""} ${candidate.key || ""} ${candidate.context || ""}`.toLowerCase();
  let score = 0;
  if (/ozon-network/.test(text)) score += 80;
  if (/page-attribute/.test(text)) score += 72;
  if (/jsonld/.test(text)) score += 62;
  if (/hidden/.test(text)) score += 55;
  if (/с\s+упаков|упаков|package|shipping|gross|毛重|包装/i.test(text)) score += 35;
  if (/вес\s+товара|productweight|itemweight|net|масса|商品重量|净重/i.test(text)) score += 18;
  if (/volume|объем|length|width|height|длина|ширина|высота|尺寸|长|宽|高/i.test(text) && !/volumeweight/i.test(text)) score -= 45;
  if (candidate.grams >= 5 && candidate.grams <= 50000) score += 8;
  return score;
}

function formatOzonWeightSource(source) {
  const text = String(source || "");
  if (/ozon-network/i.test(text)) return "Ozon接口";
  if (/page-attribute/i.test(text)) return "Ozon页面属性";
  if (/jsonld/i.test(text)) return "Ozon结构化数据";
  if (/hidden/i.test(text)) return "Ozon页面隐藏数据";
  return text || "Ozon页面";
}

function normalizeWeightGrams(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(кг|kg|公斤|千克|килограмм(?:а|ов)?|г|g|克|гр|грамм(?:а|ов)?|мг|mg|毫克)(?=$|[\s,.;，。；、/)\]}])/i);
  if (match) {
    const number = Number(match[1].replace(",", "."));
    const unit = match[2].toLowerCase();
    if (!Number.isFinite(number) || number <= 0) return null;
    if (/^(кг|kg|公斤|千克)|килограмм/i.test(unit)) return Math.round(number * 1000);
    if (/^(мг|mg|毫克)/i.test(unit)) return Math.max(1, Math.round(number / 1000));
    return Math.round(number);
  }
  if (/^\d+(?:[.,]\d+)?$/.test(text)) {
    const number = Number(text.replace(",", "."));
    if (!Number.isFinite(number) || number <= 0) return null;
    if (number < 1) return Math.round(number * 1000);
    if (number < 30 && !Number.isInteger(number)) return Math.round(number * 1000);
    return Math.round(number);
  }
  return null;
}

function normalize1688PriceOnly(value) {
  const tierPrice = extract1688MinimumTierUnitPrice(value);
  if (tierPrice !== null) return formatPriceNumber(tierPrice);
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const values = [];
  for (const match of text.matchAll(/(?:¥|￥)?\s*(\d+(?:\.\d+)?)(?:\s*(?:元|RMB|CNY))?/gi)) {
    const before = text.slice(Math.max(0, match.index - 8), match.index);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 8);
    if (!/[¥￥元]|RMB|CNY/i.test(match[0]) && /件|个|只|套|起|批|库存|cm|mm|kg|克|g/i.test(before + after)) continue;
    const number = Number(match[1]);
    if (Number.isFinite(number) && number > 0) values.push(number);
  }
  if (!values.length) return "";
  return formatPriceNumber(values[0]);
}

function extract1688TierPrices(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const tierPattern = /(\d+)\s*(?:件|个|只|套|箱|包)?\s*起\s*[¥￥]\s*(\d+(?:\.\d+)?)/g;
  const tiers = [];
  for (const match of text.matchAll(tierPattern)) {
    const quantity = Number(match[1]);
    const price = Number(match[2]);
    if (Number.isFinite(quantity) && quantity > 0 && Number.isFinite(price) && price > 0) {
      tiers.push({ quantity, price });
    }
  }
  if (tiers.length) {
    tiers.sort((a, b) => a.quantity - b.quantity);
    return Array.from(new Set(tiers.map((tier) => tier.price)));
  }
  const prices = [];
  const patterns = [
    /(?:^|[;；,，\s])(?:[¥￥]\s*)?(\d+(?:\.\d+)?)\s*(?:元|RMB|CNY)(?=$|[;；,，\s])/gi,
    /[¥￥]\s*(\d+(?:\.\d+)?)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const price = Number(match[1]);
      if (Number.isFinite(price) && price > 0) prices.push(price);
    }
    if (prices.length) return Array.from(new Set(prices));
  }
  return [];
}

function extract1688MinimumTierUnitPrice(value) {
  const prices = extract1688TierPrices(value);
  return prices.length ? prices[0] : null;
}

function formatPriceNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)));
}

function inferPackQuantityFromText(text) {
  const normalized = String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return { quantity: 1, evidence: "" };

  const candidates = [];
  const patterns = [
    /(?:набор|комплект)[^0-9]{0,30}(\d{1,3})\s*(?:шт\.?|штук|pcs?|pieces?|件|个|只|条|片|枚|支)/gi,
    /(\d{1,3})\s*(?:шт\.?|штук|pcs?|pieces?)\b/gi,
    /(?:set|pack|bundle)\s+of\s+(\d{1,3})/gi,
    /(\d{1,3})\s*[- ]?\s*(?:pack|pcs?|pieces?)\b/gi,
    /(\d{1,3})\s*(?:件套|件装|只装|个装|条装|片装|枚装|支装|双装|套装|入装|只\/套|件\/套)/g,
    /(?:套装|组合|一套|整套|装)[^0-9一二两三四五六七八九十]{0,20}(\d{1,3})\s*(?:件|个|只|条|片|枚|支)/g,
    /([一二两三四五六七八九十]{1,3})\s*(?:件套|件装|只装|个装|条装|片装|枚装|支装|双装|套装|入装|只\/套|件\/套)/g,
  ];

  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const raw = match[1];
      const quantity = /^\d+$/.test(raw) ? Number(raw) : parseChineseNumber(raw);
      if (!Number.isFinite(quantity) || quantity <= 1 || quantity > 100) continue;
      const evidence = match[0].trim();
      if (/cm|mm|kg|公斤|千克|克|g\b|起批|库存|尺寸|长|宽|高/i.test(evidence)) continue;
      candidates.push({ quantity, evidence });
    }
  }

  candidates.sort((a, b) => b.quantity - a.quantity);
  return candidates[0] || { quantity: 1, evidence: "" };
}

function parseChineseNumber(text) {
  const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const value = String(text || "");
  if (value === "十") return 10;
  if (value.includes("十")) {
    const [tens, ones] = value.split("十");
    return (digits[tens] || 1) * 10 + (digits[ones] || 0);
  }
  return digits[value] || 0;
}

const PROMOTION_PATTERN = /首单|首件|首购|新人|新客|新用户|新人价|新客价|首单价|首单减|首购价|立减|满减|优惠|优惠券|券后|领券|补贴|到手价|特价|限时|促销|专享|折扣|discount|coupon|new\s*user|first\s*order/i;
const REAL_PROMOTION_PATTERN = /(?:首单|首件|首购).{0,10}(?:减|立减|价|优惠|包邮|免运费|\d|元)|(?:新人|新客|新用户).{0,10}(?:价|包邮|专享|优惠|减|免运费)|券后(?:价|到手价)?\s*[¥￥]?\s*\d|领券|优惠券|满\s*\d+\s*减|立减\s*\d|补贴\s*\d|到手价\s*[¥￥]?\s*\d|限时\s*(?:特价|优惠|折扣)|秒杀|专享价|折扣价|new\s*user|first\s*order/i;
const PROMOTION_BOILERPLATE_PATTERN = /前述价格|未计算平台|未计算商家|划线价格|未划线价格|销售标价|销售价格|仅供参考|商家自行设置|商品页面当日展示|价格说明/i;
const PROMOTION_FIELD_ONLY_PATTERN = /^(?:isGovCouponOfferInOD:\s*false|discountCoupon:?|od_discount_coupon:?|couponList:?|couponInfoList:?|couponType:?\s*[A-Z_]*|Page_GetCoupon:?|newCouponList:?|券后:?|优惠:?|优惠券:?|coupon:?|discount:?)$/i;

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
      if (PROMOTION_PATTERN.test(key)) {
        snippets.push(`${key}: ${typeof child === "object" ? "" : String(child).slice(0, 120)}`.trim());
      }
      collectPromotionTextFromValue(child, snippets, depth + 1);
    }
  }
  return Array.from(new Set(snippets)).join("；");
}

function hasPromotionRisk(candidate) {
  return getRealPromotionSnippets([
    candidate.promotionText,
    candidate.price,
    candidate.priceDetails,
  ].filter(Boolean).join(" ")).length > 0;
}

function summarizePromotionReason(text) {
  const snippets = getRealPromotionSnippets(text).slice(0, 4);
  return snippets.length ? snippets.join("；") : "含首单/新人/优惠券/补贴等促销信息，不作为长期采购价";
}

function getRealPromotionSnippets(text) {
  return String(text || "")
    .split(/[；;\n]+/)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((item) => REAL_PROMOTION_PATTERN.test(item) && !PROMOTION_BOILERPLATE_PATTERN.test(item) && !PROMOTION_FIELD_ONLY_PATTERN.test(item));
}

function parseMoqQuantity(value) {
  const text = String(value ?? "").replace(/,/g, "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const number = Number(text);
    return Number.isFinite(number) && number > 0 ? Math.ceil(number) : null;
  }
  const onePiecePattern = /(?:一|1)\s*(?:件|个|只|套|箱|包|pcs?|piece|pieces)?\s*(?:起批|起订|起购|起拍|可批|拿样|代发)|(?:起批|起订|起购|起拍|起订量|起购量|最少起批|最小起订|可批|拿样|代发)\s*[:：]?\s*(?:一|1)(?:\s*(?:件|个|只|套|箱|包|pcs?|piece|pieces))?|(?:min\s*order\s*qty|min\s*order\s*quantity|min(?:imum)?\s*order|minimum\s*purchase|moq)\s*[:：]?\s*1(?:\s*(?:pcs?|piece|pieces))?/i;
  if (onePiecePattern.test(text)) return 1;
  const match = text.match(/(?:^|[^\d])(\d+(?:\.\d+)?)\s*(?:件|个|只|套|箱|包|pcs?|piece|pieces)?\s*(?:起批|起订|起购|起拍|可批|拿样|代发|min\s*order\s*qty|min\s*order\s*quantity|min(?:imum)?\s*order|minimum\s*purchase|moq)/i)
    || text.match(/(?:起批|起订|起购|起拍|起订量|起购量|最少起批|最小起订|可批|拿样|代发|min\s*order\s*qty|min\s*order\s*quantity|min(?:imum)?\s*order|minimum\s*purchase|moq)\s*[:：]?\s*(\d+(?:\.\d+)?)/i);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.ceil(number);
}

function isMoqEligible(candidate) {
  const quantity = parseMoqQuantity(candidate?.minOrderQuantity || candidate?.moq);
  return quantity === 1;
}

function getMoqRuleStatus(candidate) {
  const quantity = parseMoqQuantity(candidate?.minOrderQuantity || candidate?.moq);
  if (quantity === 1) return "通过：一件起购";
  if (quantity == null) return "未通过：起批量未确认";
  return `未通过：起批量 ${quantity}`;
}

function getMoqAvoidReason(candidate) {
  const quantity = parseMoqQuantity(candidate?.minOrderQuantity || candidate?.moq);
  if (quantity == null) return "1688 起批量未确认，不满足一件代采自动选品规则。";
  return quantity > 1 ? `1688 起批量为 ${quantity}，不满足一件代采规则。` : "";
}

function getCandidateAvoidReason(candidate) {
  const moqReason = getMoqAvoidReason(candidate);
  if (moqReason) return moqReason;
  if (candidate?.trafficBaitRisk) return candidate.trafficBaitReason || "1688 候选疑似引流款，不作为最终货源。";
  return "";
}

function isAvoidedCandidate(candidate) {
  return Boolean(getCandidateAvoidReason(candidate));
}

function scoreSourcingCandidate(candidate = {}) {
  if (!candidate || isAvoidedCandidate(candidate)) return -100000;
  let score = 0;
  const rank = Number(candidate.rank);
  const aiConfidence = Number(candidate.aiConfidence);
  const unitPrice = Number(normalize1688PriceOnly(candidate.priceDetails || candidate.price));
  const shippingFee = parseRmbNumber(candidate.shippingFee);
  const weightGrams = Number(candidate.weightGrams || normalizeWeightGrams(candidate.weightText));
  const dimensionsText = String(candidate.dimensionsText || "").trim();
  const detailAttrCount = candidate.detailAttributes && typeof candidate.detailAttributes === "object"
    ? Object.keys(candidate.detailAttributes).length
    : 0;

  score += 1000;
  if (candidate.aiVerdict === "exact" || candidate.finalMatchType === "exact") score += 600;
  if (candidate.aiVerdict === "approximate" || candidate.finalMatchType === "approximate") score += 220;
  if (candidate.aiVerdict === "not_match") score -= 500;
  if (candidate.aiSelected) score += 120;
  if (Number.isFinite(aiConfidence)) score += Math.round(aiConfidence * 120);
  if (candidate.localImage?.filePath || candidate.image) score += 70;
  if (candidate.title) score += 40;
  if (Number.isFinite(unitPrice) && unitPrice > 0) score += 70;
  if (Number.isFinite(shippingFee) && shippingFee >= 0) score += 80;
  if (Number.isFinite(weightGrams) && weightGrams > 0) score += 70;
  if (dimensionsText) score += 45;
  if (candidate.priceDetails) score += 35;
  if (candidate.shopName) score += 20;
  if (detailAttrCount) score += Math.min(90, detailAttrCount * 6);
  if (Number.isFinite(Number(candidate.modelMatchScore))) score += Number(candidate.modelMatchScore);
  if (candidate.promotionRisk) score -= 25;
  if (Number.isFinite(rank)) score -= Math.min(80, rank * 4);
  return score;
}

function compareSourcingCandidates(a, b) {
  const scoreDiff = scoreSourcingCandidate(b) - scoreSourcingCandidate(a);
  if (scoreDiff) return scoreDiff;
  return (Number(a?.rank) || 9999) - (Number(b?.rank) || 9999);
}

function getCandidateLandedCost(candidate = {}) {
  const unitPrice = Number(normalize1688PriceOnly(candidate.priceDetails || candidate.price));
  const shippingFee = parseRmbNumber(candidate.shippingFee);
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) return null;
  return unitPrice + (shippingFee !== null ? shippingFee : 0);
}

function compareExactSourcingCandidates(a, b) {
  const aPromotion = Boolean(a?.promotionRisk);
  const bPromotion = Boolean(b?.promotionRisk);
  if (aPromotion !== bPromotion) return aPromotion ? 1 : -1;
  const aCost = getCandidateLandedCost(a);
  const bCost = getCandidateLandedCost(b);
  if (aCost !== null && bCost !== null && Math.abs(aCost - bCost) > 0.01) return aCost - bCost;
  if (aCost !== null && bCost === null) return -1;
  if (aCost === null && bCost !== null) return 1;
  return compareSourcingCandidates(a, b);
}

function findBestFallbackCandidate(candidates = []) {
  return candidates
    .filter((candidate) => !isAvoidedCandidate(candidate) && candidate?.aiVerdict !== "not_match")
    .sort(compareSourcingCandidates)[0] || null;
}

function scoreDiagnosticCandidate(candidate = {}) {
  if (!candidate) return -100000;
  let score = 0;
  const rank = Number(candidate.rank);
  const aiConfidence = Number(candidate.aiConfidence);
  const verdict = candidate.aiVerdict || candidate.finalMatchType || "";
  const unitPrice = Number(normalize1688PriceOnly(candidate.priceDetails || candidate.price));
  if (candidate.aiSelected) score += 500;
  if (verdict === "exact") score += 420;
  if (verdict === "approximate") score += 260;
  if (verdict === "not_match") score -= 420;
  if (Number.isFinite(aiConfidence)) {
    score += verdict === "not_match" ? -Math.round(aiConfidence * 180) : Math.round(aiConfidence * 90);
  }
  if (candidate.title) score += 40;
  if (candidate.localImage?.filePath || candidate.image) score += 60;
  if (candidate.priceDetails || candidate.price) score += 35;
  if (candidate.link) score += 25;
  if (candidate.shippingFee) score += 20;
  if (candidate.weightGrams || candidate.weightText) score += 20;
  if (parseMoqQuantity(candidate.minOrderQuantity || candidate.moq) === 1) score += 120;
  if (Number.isFinite(unitPrice) && unitPrice > 0 && unitPrice < 5) score -= 140;
  if (candidate.invalidPriceRisk) score -= 160;
  if (candidate.trafficBaitRisk) score -= 90;
  if (Number.isFinite(rank)) score -= Math.min(60, rank * 3);
  return score;
}

function findBestDiagnosticCandidate(candidates = [], selectedRank = null) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const selected = candidates.find((candidate) => Number(candidate.rank) === Number(selectedRank));
  if (selected && !isAvoidedCandidate(selected)) return selected;
  const pool = candidates.filter((candidate) => !isAvoidedCandidate(candidate));
  const diagnosticPool = pool.length ? pool : candidates;
  return [...diagnosticPool].sort((a, b) => {
    const diff = scoreDiagnosticCandidate(b) - scoreDiagnosticCandidate(a);
    if (diff) return diff;
    return (Number(a?.rank) || 9999) - (Number(b?.rank) || 9999);
  })[0] || null;
}

function pickReviewedCandidate(reviewedCandidates, verdicts) {
  const verdictSet = new Set(verdicts);
  const exactOnly = verdictSet.size === 1 && verdictSet.has("exact");
  return reviewedCandidates
    .filter(({ candidate, review }) => !isAvoidedCandidate(candidate) && candidate?.aiVerdict !== "not_match" && verdictSet.has(review?.verdict))
    .sort((a, b) => exactOnly
      ? compareExactSourcingCandidates(a.candidate, b.candidate)
      : compareSourcingCandidates(a.candidate, b.candidate))[0] || null;
}

function getFunctionalMismatchReason(ozon = {}, candidate = {}) {
  const ozonText = [
    ozon.title,
    ozon.description,
    ozon.attributes && JSON.stringify(ozon.attributes),
  ].filter(Boolean).join(" ").toLowerCase();
  const candidateText = [
    candidate.title,
    candidate.detailAttributes && JSON.stringify(candidate.detailAttributes),
  ].filter(Boolean).join(" ").toLowerCase();
  const ozonChildPhoneWatch = /детск|реб[её]н|child|kids|儿童|小孩|学生/.test(ozonText)
    && /(?:4g|gps|sim|сим|телефон|phone|видеосвяз|video\s*call|定位|电话|视频|插卡|通话)/i.test(ozonText);
  if (ozonChildPhoneWatch) {
    const candidateHasChildPhoneSignals = /(?:4g|gps|sim|儿童|小孩|学生|老人|定位|电话|视频|插卡|通话|全网通|微聊|拍照|phone|kids|child)/i.test(candidateText);
    const candidateLooksGenericBand = /(?:手环|运动手表|运动监测|计步|心率|闹钟|普通|bracelet|fitness)/i.test(candidateText);
    if (!candidateHasChildPhoneSignals && candidateLooksGenericBand) {
      return "Ozon 是儿童 4G/GPS 电话手表，候选标题/属性更像普通运动手环，缺少电话、定位、SIM 或视频通话等核心功能。";
    }
  }
  const ozonWatchBundle = /(?:набор|комплект|ремешк|strap|band|表带|套装|礼盒)/i.test(ozonText)
    && /(?:\b[3-9]\b|\b1[0-9]\b|нескольк|много|多条|十条|10\s*(?:条|шт|pcs|ремешк|strap|band)|3\s*(?:条|шт|pcs|ремешк|strap|band))/i.test(ozonText)
    && /(?:watch|smart\s*watch|смарт|часы|手表)/i.test(ozonText);
  if (ozonWatchBundle) {
    const candidateHasBundle = /(?:набор|комплект|ремешк|strap|band|表带|套装|礼盒|多条|十条|10\s*(?:条|шт|pcs|ремешк|strap|band)|3\s*(?:条|шт|pcs|ремешк|strap|band))/i.test(candidateText);
    if (!candidateHasBundle) {
      return "Ozon 是多表带/礼盒套装，候选更像单只手表，缺少套装表带或礼盒配置。";
    }
  }
  return "";
}

function extractRmbValues(text) {
  const values = [];
  const normalized = String(text || "").replace(/,/g, "");
  for (const match of normalized.matchAll(/(?:¥|￥|RMB|CNY)?\s*(\d+(?:\.\d+)?)(?:\s*(?:元|块|rmb|cny))?/gi)) {
    const raw = match[1];
    const before = normalized.slice(Math.max(0, match.index - 8), match.index);
    const after = normalized.slice(match.index, match.index + match[0].length + 8);
    if (/起批|库存|个|件|套|只|包|箱|cm|mm|kg|公斤|千克|g|克/i.test(before + after) && !/[¥￥元块]|RMB|CNY/i.test(match[0])) {
      continue;
    }
    const value = Number(raw);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

async function reviewCandidatesWithMiniMax(ozon, candidates) {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    const localWeight = estimateWeightLocally(ozon, candidates);
    return {
      decision: "none",
      selected_rank: null,
      confidence: 0,
      reason: "未配置 MiniMax API Key，无法自动判断，返回候选中最靠前的近似结果供人工确认。",
      candidate_reviews: buildAiFailureCandidateReviews(candidates, "未进行 AI 审核"),
      estimated_weight_grams: localWeight.estimated_weight_grams,
      estimated_weight_confidence: localWeight.estimated_weight_confidence,
      estimated_weight_reason: `未配置 MiniMax API Key；${localWeight.estimated_weight_reason}`,
      thinkingMode: MINIMAX_THINKING_TYPE,
    };
  }

  const startedAt = Date.now();
  try {
    const content = [];
    content.push({
      type: "text",
      text: buildAiReviewPrompt(ozon, candidates),
    });
    const ozonImage = await imageFileToDataUrl(ozon.mainImage?.filePath);
    if (ozonImage) {
      content.push({ type: "text", text: "Ozon 商品主图：" });
      content.push({ type: "image_url", image_url: { url: ozonImage, detail: "default" } });
    }
    for (const candidate of candidates) {
      const image = await imageFileToDataUrl(candidate.localImage?.filePath);
      if (image) {
        content.push({ type: "text", text: `1688 候选 ${candidate.rank} 图片：` });
        content.push({ type: "image_url", image_url: { url: image, detail: "default" } });
      }
    }

    const response = await fetch(`${MINIMAX_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MINIMAX_MODEL,
        messages: [
          {
            role: "system",
            content:
              "你是跨境电商货源匹配审核员。你的任务是在候选里给出一个最优货源：优先选择与 Ozon 商品同款、同功能、同外观、同关键规格的 exact；如果没有 exact，但有外观/功能/用途高度相近且可供人工复核的候选，选择 approximate；如果候选明显不相关、都是引流款或没有满足一件起购的候选，返回 none。1688 候选的 MOQ/起批量大于 1 是硬性淘汰条件，不能选为 exact 或 approximate。同时根据商品标题、属性、尺寸、图片和候选信息估算单个 Ozon 销售单位的包装后重量（克）。首单减、新人价、券后价等只属于价格风险备注，不影响产品是否一致；图片水印、平台贴纸、标题噪音也不能把真实同款降级为近似。只输出 JSON，不要输出 Markdown。",
          },
          { role: "user", content },
        ],
        temperature: 0,
        max_completion_tokens: 2400,
        ...buildMiniMaxThinkingOptions(MINIMAX_THINKING_TYPE),
      }),
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`MiniMax 返回 ${response.status}: ${responseText.slice(0, 600)}`);
    }
    const payload = JSON.parse(responseText);
    const text = extractMiniMaxMessageText(payload);
    const aiUsage = normalizeMiniMaxUsage(payload.usage);
    const model = payload.model || MINIMAX_MODEL;
    let parsedReview;
    try {
      parsedReview = parseJsonFromText(text);
    } catch (parseError) {
      parseError.aiUsage = aiUsage;
      parseError.model = model;
      throw parseError;
    }
    const review = {
      ...normalizeAiReview(parsedReview, candidates),
      aiUsage,
      model,
      thinkingMode: MINIMAX_THINKING_TYPE,
      aiElapsedMs: Date.now() - startedAt,
    };
    return enforceStrictAiReview(review);
  } catch (error) {
    const weightFallback = await estimateWeightAfterAiFailure(ozon, candidates, error);
    return {
      decision: "none",
      selected_rank: null,
      confidence: 0,
      reason: `AI 审核失败，已按严格规则跳过：${error.message}`,
      candidate_reviews: buildAiFailureCandidateReviews(candidates, "AI 审核失败"),
      estimated_weight_grams: weightFallback.estimated_weight_grams,
      estimated_weight_confidence: weightFallback.estimated_weight_confidence,
      estimated_weight_reason: weightFallback.estimated_weight_reason,
      model: weightFallback.model || error.model || MINIMAX_MODEL,
      thinkingMode: weightFallback.thinkingMode
        ? `${MINIMAX_THINKING_TYPE};${weightFallback.thinkingMode}`
        : MINIMAX_THINKING_TYPE,
      aiUsage: mergeMiniMaxUsage(error.aiUsage, weightFallback.aiUsage),
      aiElapsedMs: Date.now() - startedAt,
      weightFallback: weightFallback.source || "",
    };
  }
}

function buildAiFailureCandidateReviews(candidates, reason) {
  return candidates.map((candidate) => {
    const avoidReason = getCandidateAvoidReason(candidate);
    return {
      rank: candidate.rank,
      verdict: avoidReason ? "not_match" : "approximate",
      confidence: 0,
      reason: avoidReason || reason,
    };
  });
}

function buildMiniMaxThinkingOptions(type) {
  const normalized = String(type || "disabled").trim().toLowerCase();
  if (!normalized || ["disabled", "off", "false", "0", "none"].includes(normalized)) {
    return { thinking: { type: "disabled" } };
  }
  return {
    reasoning_split: true,
    thinking: { type: normalized },
  };
}

function buildAiReviewPrompt(ozon, candidates) {
  const compactCandidates = candidates.map((candidate) => ({
    rank: candidate.rank,
    title: candidate.title,
    price: candidate.price,
    priceDetails: candidate.priceDetails,
    minOrderQuantity: candidate.minOrderQuantity || candidate.moq,
    parsedMoqQuantity: parseMoqQuantity(candidate.minOrderQuantity || candidate.moq),
    moqEligible: isMoqEligible(candidate),
    moqAvoidReason: getMoqAvoidReason(candidate),
    shippingFee: candidate.shippingFee,
    dimensionsText: candidate.dimensionsText,
    weightText: candidate.weightText,
    shippingFeeSource: candidate.shippingFeeSource,
    weightSource: candidate.weightSource,
    invalidPriceRisk: candidate.invalidPriceRisk,
    trafficBaitRisk: candidate.trafficBaitRisk,
    trafficBaitReason: candidate.trafficBaitReason,
    promotionRisk: candidate.promotionRisk,
    promotionReason: candidate.promotionReason,
    promotionText: candidate.promotionText,
    ozonPackQuantity: candidate.ozonPackQuantity,
    candidatePackQuantity: candidate.candidatePackQuantity,
    purchaseMultiplier: candidate.purchaseMultiplier,
    estimatedPurchasePriceRmb: candidate.estimatedPurchasePriceRmb,
    quantityAssessment: candidate.quantityAssessment,
    minPriceRmb: candidate.minPriceRmb,
    maxPriceRmb: candidate.maxPriceRmb,
    shopName: candidate.shopName,
    link: candidate.link,
  }));
  return `请审核 1688 候选，并只返回一个最优解。

Ozon 商品：
${JSON.stringify({
  title: ozon.title,
  price: ozon.price,
  currency: ozon.currency,
  brand: ozon.brand,
  packQuantity: ozon.packQuantity,
  packQuantityEvidence: ozon.packQuantityEvidence,
  description: ozon.description,
  attributes: ozon.attributes,
  sourceUrl: ozon.sourceUrl,
}, null, 2)}

1688 候选：
${JSON.stringify(compactCandidates, null, 2)}

审核规则：
1. 1688 候选必须明确满足一件起购：只有 minOrderQuantity/MOQ/起批量能解析为 1 的候选才可选中。起批量大于 1 或起批量未取到的候选都必须判为 not_match，不能作为 selected_rank，也不能作为 approximate 兜底，这是硬规则。
2. 优先找 exact：同款、同功能、同外观、同关键规格。若实物、款式、功能和关键规格一致，不要因为 Ozon 水印、商家贴纸、标题翻译、品牌缺失、拍摄角度、光线、背景或店铺图差异把它降级成 approximate。
3. approximate 只能用于产品可替代但不是严格同款的情况。尺寸、颜色、型号、材质、版本、接口、适用对象、套装数量、容量、功率、功能、细节造型存在差异时，必须保持 approximate 或 not_match，不能为了看起来像而强行 exact。
4. 重量和尺寸只作为参考信息，不作为硬性一致条件；Ozon 和 1688 都可能乱标重量或尺寸。候选都相近时，优先选择 shippingFee、weightText、dimensionsText、priceDetails、detailAttributes 更完整的候选，但不能突破 MOQ=1 规则。
5. Ozon 图片角落里的商家水印、平台贴纸、后期叠字（例如右下角 MAOLA 这类标记）不要当成品牌或产品本体；只有印在实物/包装上的标识才算产品特征。
6. 如果候选存在 trafficBaitRisk，通常视为 1688 引流款，不要选中；除非其他候选更差且它仍是最接近项，则只能作为 approximate，并明确写出引流风险。
7. promotionRisk 只代表价格可能依赖首单减、新人价、新客价、券后价、补贴、限时优惠等，属于采购价风险备注；它不能作为判断产品是否一致的依据，也不能因为 promotionRisk 把 exact 降级成 approximate 或 none。
8. 必须核对 Ozon 标题、属性和图片中是否写了多件/套装/pack/pcs/шт 等数量。若 Ozon 是多件一起卖，而 1688 候选是单件或较少件数，不能把单件价当成 Ozon 一套的采购价；需要按 purchaseMultiplier 或你从图片识别到的数量倍数计算，并在 reason 里说明数量风险。若 Ozon 明确是多表带/礼盒套装（例如 3 条、10 条表带），1688 候选只是单只手表且没有对应表带套装，不要作为 selected_rank，只能判 not_match。
9. 智能手表、儿童电话手表、扫地机器人、净水器、电器等功能型商品，核心功能/适用对象/型号系列优先于外观相似。儿童 4G 电话手表不能优先选择普通运动手环；手表本体不能选择表带、保护壳、充电器等配件；净水器不能选择花洒、充电线、车充等相邻图片误召回。
10. 只返回一个 selected_rank。若所有候选都明显不相关、数量无法合理对应、都是引流款或都不满足一件起购，decision 返回 "none"，selected_rank 返回 null。
11. 需要估算 Ozon 当前销售单位的包装后重量，单位为克。优先参考明确尺寸、材质、件数、同类商品常见重量和图片体积感；Ozon/1688 抓到的重量只作为参考，发现明显异常时不要盲信。估算不确定时仍给出合理区间里的中位估计，并降低 estimated_weight_confidence。

只返回 JSON，格式如下：
{
  "decision": "exact" 或 "approximate" 或 "none",
  "selected_rank": 数字或 null,
  "confidence": 0 到 1,
  "ozon_pack_quantity": 数字,
  "selected_candidate_pack_quantity": 数字或 null,
  "purchase_multiplier": 数字或 null,
  "quantity_reason": "说明 Ozon 和 1688 的件数/套装数量是否对应",
  "estimated_weight_grams": 数字或 null,
  "estimated_weight_confidence": 0 到 1,
  "estimated_weight_reason": "一句话说明估重依据，例如材质、尺寸、件数、包装体积或参考候选",
  "reason": "一句话说明最终选择、近似风险或无结果原因",
  "candidate_reviews": [
    {"rank": 1, "verdict": "exact/approximate/not_match", "confidence": 0到1, "reason": "简短原因"}
  ]
}`;
}

async function estimateWeightAfterAiFailure(ozon, candidates, originalError) {
  try {
    const aiWeight = await requestMiniMaxWeightEstimate(ozon, candidates);
    if (aiWeight.estimated_weight_grams) return aiWeight;
  } catch (error) {
    const localWeight = estimateWeightLocally(ozon, candidates);
    return {
      ...localWeight,
      estimated_weight_reason: `${localWeight.estimated_weight_reason}；AI 估重重试失败：${String(error.message || error).slice(0, 120)}`,
      source: "local_after_ai_weight_retry_failed",
    };
  }

  const localWeight = estimateWeightLocally(ozon, candidates);
  return {
    ...localWeight,
    estimated_weight_reason: `${localWeight.estimated_weight_reason}；AI 审核失败：${String(originalError?.message || originalError).slice(0, 120)}`,
    source: "local_after_empty_ai_weight",
  };
}

async function requestMiniMaxWeightEstimate(ozon, candidates) {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error("未配置 MiniMax API Key");

  const response = await fetch(`${MINIMAX_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MINIMAX_MODEL,
      messages: [
        {
          role: "system",
          content:
            "你只负责估算跨境电商商品当前销售单位的包装后重量，单位为克。必须只输出 JSON，不要输出 Markdown，不要解释过程。",
        },
        {
          role: "user",
          content: buildWeightEstimatePrompt(ozon, candidates),
        },
      ],
      temperature: 0,
      max_completion_tokens: 600,
      thinking: { type: "disabled" },
    }),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`MiniMax 估重返回 ${response.status}: ${responseText.slice(0, 300)}`);
  }
  const payload = JSON.parse(responseText);
  const parsed = parseJsonFromText(extractMiniMaxMessageText(payload));
  const normalized = normalizeAiWeightEstimate(parsed);
  if (!normalized.estimated_weight_grams) throw new Error("AI 估重没有返回有效克重");
  return {
    ...normalized,
    aiUsage: normalizeMiniMaxUsage(payload.usage),
    model: payload.model || MINIMAX_MODEL,
    thinkingMode: "估重重试关闭思考",
    source: "ai_weight_retry",
  };
}

function buildWeightEstimatePrompt(ozon, candidates) {
  const compactCandidates = candidates.slice(0, 5).map((candidate) => ({
    rank: candidate.rank,
    title: candidate.title,
    dimensionsText: candidate.dimensionsText,
    weightText: candidate.weightText,
    weightGrams: candidate.weightGrams,
    packQuantity: candidate.packQuantity || candidate.candidatePackQuantity,
    quantityAssessment: candidate.quantityAssessment,
  }));
  return `请估算 Ozon 当前销售单位的包装后重量，单位为克。

要求：
1. 优先参考 Ozon 标题、属性、材质、尺寸、件数。
2. 1688 候选只作为弱参考；如果候选明显不相关，不要按候选重量估。
3. 如果信息不完整，也必须给一个合理中位估算，并降低置信度。
4. 只返回 JSON。

Ozon 商品：
${JSON.stringify({
  title: ozon.title,
  description: ozon.description,
  attributes: ozon.attributes,
  packQuantity: ozon.packQuantity,
  packQuantityEvidence: ozon.packQuantityEvidence,
  weight: ozon.weight,
  weightText: ozon.weightText,
  weightGrams: ozon.weightGrams,
}, null, 2)}

1688 候选参考：
${JSON.stringify(compactCandidates, null, 2)}

返回格式：
{
  "estimated_weight_grams": 数字,
  "estimated_weight_confidence": 0 到 1,
  "estimated_weight_reason": "一句话说明估重依据"
}`;
}

function normalizeAiWeightEstimate(value = {}) {
  return {
    estimated_weight_grams: normalizeAiEstimatedWeightGrams(value.estimated_weight_grams),
    estimated_weight_confidence: clampNumber(value.estimated_weight_confidence, 0, 1, 0.35),
    estimated_weight_reason: String(value.estimated_weight_reason || "AI 估重重试补全"),
  };
}

function estimateWeightLocally(ozon = {}, candidates = []) {
  const ozonWeight = inferOzonWeight(ozon);
  if (ozonWeight.weightGrams) {
    return {
      estimated_weight_grams: ozonWeight.weightGrams,
      estimated_weight_confidence: 0.55,
      estimated_weight_reason: `本地兜底估算：按 Ozon 重量字段 ${ozonWeight.evidence || ""}`.trim(),
      source: "local_ozon_weight",
    };
  }

  const text = [
    ozon.title,
    ozon.description,
    ozon.packQuantityEvidence,
    JSON.stringify(ozon.attributes || {}),
  ].filter(Boolean).join(" ").toLowerCase();
  const quantity = Math.max(1, Number(ozon.packQuantity) || inferPackQuantityFromText(text).quantity || 1);
  const rules = [
    { pattern: /平板|tablet|ipad|планшет/i, require: /套|壳|case|保护|чехол/i, grams: 320, confidence: 0.34, label: "平板保护套" },
    { pattern: /手机壳|手机套|phone case|smartphone case|чехол.*телефон/i, grams: 80, confidence: 0.32, label: "手机保护壳" },
    { pattern: /耳机盒|耳机套|airpods|earphone|наушник/i, grams: 55, confidence: 0.32, label: "耳机保护套" },
    { pattern: /面具|mask|маска|карнавал/i, grams: 120, confidence: 0.3, label: "面具" },
    { pattern: /锯条|锯片|saw blade|пила/i, grams: 80, confidence: 0.3, label: "小型锯片配件" },
    { pattern: /变速箱|排挡|换挡|挡把|gear|shift|ручк/i, grams: 230, confidence: 0.32, label: "汽车换挡配件" },
    { pattern: /汽车内饰|护套|车.*套|auto|car|авто/i, grams: 100, confidence: 0.28, label: "汽车小配件" },
    { pattern: /包|袋|斜挎|背包|сумк|bag/i, grams: 260, confidence: 0.32, label: "包袋" },
    { pattern: /玩具|toy|игруш/i, grams: 300, confidence: 0.28, label: "玩具" },
  ];

  for (const rule of rules) {
    if (rule.pattern.test(text) && (!rule.require || rule.require.test(text))) {
      return {
        estimated_weight_grams: Math.round(rule.grams * quantity),
        estimated_weight_confidence: rule.confidence,
        estimated_weight_reason: `本地兜底估算：按“${rule.label}”品类和 ${quantity} 件/组粗估包装后重量`,
        source: "local_category",
      };
    }
  }

  const candidateWeights = candidates
    .map((candidate) => Number(candidate.weightGrams || normalizeWeightGrams(candidate.weightText)))
    .filter((value) => Number.isFinite(value) && value > 5 && value < 100000)
    .sort((a, b) => a - b);
  if (candidateWeights.length) {
    const median = candidateWeights[Math.floor(candidateWeights.length / 2)];
    return {
      estimated_weight_grams: Math.round(median * quantity),
      estimated_weight_confidence: 0.25,
      estimated_weight_reason: `本地兜底估算：参考候选重量中位数 ${median}g，并按 ${quantity} 件/组粗估`,
      source: "local_candidate_weight",
    };
  }

  return {
    estimated_weight_grams: Math.round(200 * quantity),
    estimated_weight_confidence: 0.2,
    estimated_weight_reason: `本地兜底估算：信息不足，按小件商品默认 ${quantity} 件/组粗估`,
    source: "local_default",
  };
}

function extractMiniMaxMessageText(payload = {}) {
  const choice = payload.choices?.[0] || {};
  const message = choice.message || {};
  return [
    message.content,
    message.reasoning_content,
    message.reasoningContent,
    message.output_text,
    choice.text,
    payload.output_text,
  ]
    .map(stringifyAiMessageContent)
    .filter(Boolean)
    .join("\n")
    .trim();
}

function stringifyAiMessageContent(content) {
  if (content === null || content === undefined) return "";
  if (Array.isArray(content)) {
    return content.map((part) => stringifyAiMessageContent(part)).filter(Boolean).join("\n");
  }
  if (typeof content === "object") {
    return String(content.text || content.content || content.value || JSON.stringify(content));
  }
  return String(content);
}

function parseJsonFromText(text) {
  const cleaned = String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("AI 没有返回 JSON");
    return JSON.parse(match[0]);
  }
}

function normalizeAiReview(review, candidates) {
  const candidateRanks = new Set(candidates.map((candidate) => Number(candidate.rank)));
  const candidateReviews = Array.isArray(review.candidate_reviews) ? review.candidate_reviews : [];
  const normalizedReviews = candidates.map((candidate) => {
    const found = candidateReviews.find((item) => Number(item.rank) === Number(candidate.rank)) || {};
    const verdict = ["exact", "approximate", "not_match"].includes(found.verdict) ? found.verdict : "approximate";
    return {
      rank: candidate.rank,
      verdict,
      confidence: clampNumber(found.confidence, 0, 1, 0),
      reason: String(found.reason || ""),
    };
  });
  const selectedRank = Number(review.selected_rank);
  const decision = ["exact", "approximate", "none"].includes(review.decision) ? review.decision : "none";
  return {
    decision: decision !== "none" && candidateRanks.has(selectedRank) ? decision : "none",
    selected_rank: Number.isFinite(selectedRank) && candidateRanks.has(selectedRank) ? selectedRank : null,
    confidence: clampNumber(review.confidence, 0, 1, 0),
    ozon_pack_quantity: clampInt(review.ozon_pack_quantity, 1, 100, 1),
    selected_candidate_pack_quantity: Number.isFinite(Number(review.selected_candidate_pack_quantity))
      ? clampInt(review.selected_candidate_pack_quantity, 1, 100, 1)
      : null,
    purchase_multiplier: Number.isFinite(Number(review.purchase_multiplier))
      ? clampInt(review.purchase_multiplier, 1, 100, 1)
      : null,
    quantity_reason: String(review.quantity_reason || ""),
    estimated_weight_grams: normalizeAiEstimatedWeightGrams(review.estimated_weight_grams),
    estimated_weight_confidence: clampNumber(review.estimated_weight_confidence, 0, 1, 0),
    estimated_weight_reason: String(review.estimated_weight_reason || ""),
    reason: String(review.reason || ""),
    candidate_reviews: normalizedReviews,
  };
}

function normalizeAiEstimatedWeightGrams(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const hasUnit = /(кг|kg|公斤|千克|килограмм|г|g|克|гр|грамм|мг|mg|毫克)\b/i.test(text);
  const grams = hasUnit ? normalizeWeightGrams(text) : null;
  const number = grams || Number(text.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.min(300000, Math.max(1, Math.round(number)));
}

function shouldPromoteApproximateAiReview(review, selected, selectedConfidence) {
  if (review.decision !== "approximate" || selected?.verdict !== "approximate") return false;
  if (selectedConfidence < AI_CONFIDENCE_THRESHOLD) return false;
  const text = [review.reason, selected.reason, review.quantity_reason]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!text) return false;
  const displayNoisePattern = /水印|贴纸|角落|后期|叠字|商家标记|平台标记|背景|拍摄|角度|图片差异|标题|翻译|品牌缺失|品牌未体现|logo|watermark|sticker|background|angle|photo|translation/i;
  const displayNoiseOnlyPattern = /(?:仅|只是|只有|主要是|差异为|区别为|不同点为|不一致的是).{0,24}(?:水印|贴纸|角落|后期|叠字|商家标记|平台标记|背景|拍摄|角度|图片|标题|翻译|品牌|logo|watermark|sticker|background|angle|photo|translation)/i;
  const exactIdentityPattern = /同款|同一商品|同一个商品|本体一致|实物一致|主体一致|外观一致|功能一致|same\s+item|same\s+product|identical\s+item|same\s+model|only\s+packaging|仅包装|仅赠品|仅促销|仅店铺图/i;
  const realRiskPattern = /规格|尺寸|尺码|大小|颜色|色号|型号|款式|造型|形状|套装|数量|件数|容量|毫升|升|材质|材料|功能不同|功能差异|功能缺失|功能不一致|功能少|功能多|接口|版本|适配|兼容|多出|少了|缺少|可能不是|pack\s*(?:count|size)|pcs\s*(?:count|diff|different)|piece\s*(?:count|diff|different)|size|color|model|material|version|mismatch|different\s+function|function\s+mismatch|missing\s+function/i;
  return (displayNoiseOnlyPattern.test(text) || exactIdentityPattern.test(text) || displayNoisePattern.test(text)) && !realRiskPattern.test(text);
}

function enforceStrictAiReview(review) {
  if (review.decision === "none" || !review.selected_rank) {
    return { ...review, decision: "none", selected_rank: null };
  }
  const selected = review.candidate_reviews.find((item) => Number(item.rank) === Number(review.selected_rank));
  const selectedConfidence = Math.max(Number(review.confidence) || 0, Number(selected?.confidence) || 0);
  if (!selected) {
    return {
      ...review,
      decision: "none",
      selected_rank: null,
      confidence: selectedConfidence || review.confidence,
      reason: review.reason || "AI 没有返回有效候选。",
    };
  }
  if (review.decision === "exact" && (selected.verdict !== "exact" || selectedConfidence < AI_CONFIDENCE_THRESHOLD)) {
    return {
      ...review,
      decision: "approximate",
      confidence: selectedConfidence,
      reason: review.reason || "未达到完全一致阈值，降级为近似匹配，需要人工确认。",
    };
  }
  if (review.decision === "approximate" && selected.verdict === "not_match") {
    return {
      ...review,
      decision: "approximate",
      confidence: selectedConfidence,
      reason: review.reason || "AI 返回了最接近候选，但判断为不完全匹配，需要人工确认。",
    };
  }
  if (shouldPromoteApproximateAiReview(review, selected, selectedConfidence)) {
    return {
      ...review,
      decision: "exact",
      confidence: selectedConfidence,
      reason: [review.reason || selected.reason || "差异仅为展示噪音。", "系统校正：水印、贴纸、标题翻译、拍摄角度或背景差异不降级为近似匹配。"].filter(Boolean).join(" "),
      candidate_reviews: review.candidate_reviews.map((item) => Number(item.rank) === Number(selected.rank)
        ? { ...item, verdict: "exact", confidence: Math.max(Number(item.confidence) || 0, selectedConfidence), reason: item.reason || review.reason || "差异仅为展示噪音。" }
        : item),
    };
  }
  return { ...review, confidence: selectedConfidence };
}

function normalizeMiniMaxUsage(usage = {}) {
  const inputTokens =
    Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.total_input_tokens ?? 0) || 0;
  const outputTokens =
    Number(usage.completion_tokens ?? usage.output_tokens ?? usage.total_output_tokens ?? 0) || 0;
  const totalTokens =
    Number(usage.total_tokens ?? usage.total_token_count ?? (inputTokens + outputTokens)) || 0;
  const estimatedCostUsd =
    (inputTokens / 1_000_000) * MINIMAX_INPUT_USD_PER_M +
    (outputTokens / 1_000_000) * MINIMAX_OUTPUT_USD_PER_M;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
    inputUsdPerMTokens: MINIMAX_INPUT_USD_PER_M,
    outputUsdPerMTokens: MINIMAX_OUTPUT_USD_PER_M,
  };
}

function mergeMiniMaxUsage(...usages) {
  const valid = usages.filter((usage) => usage && (
    Number(usage.inputTokens) ||
    Number(usage.outputTokens) ||
    Number(usage.totalTokens) ||
    Number(usage.estimatedCostUsd)
  ));
  if (!valid.length) return undefined;
  const inputTokens = valid.reduce((sum, usage) => sum + (Number(usage.inputTokens) || 0), 0);
  const outputTokens = valid.reduce((sum, usage) => sum + (Number(usage.outputTokens) || 0), 0);
  const totalTokens = valid.reduce((sum, usage) => sum + (Number(usage.totalTokens) || 0), 0) || inputTokens + outputTokens;
  const estimatedCostUsd = valid.reduce((sum, usage) => sum + (Number(usage.estimatedCostUsd) || 0), 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
    inputUsdPerMTokens: MINIMAX_INPUT_USD_PER_M,
    outputUsdPerMTokens: MINIMAX_OUTPUT_USD_PER_M,
  };
}

function applyAiReview(result) {
  if (!result.aiReview) return;
  const reviews = new Map((result.aiReview.candidate_reviews || []).map((item) => [Number(item.rank), item]));
  result.candidates = result.candidates.map((candidate) => {
    const review = reviews.get(Number(candidate.rank));
    const avoidReason = getCandidateAvoidReason(candidate);
    const functionalMismatchReason = getFunctionalMismatchReason(result.ozon || {}, candidate);
    const rejectReason = avoidReason || functionalMismatchReason;
    const selectedByAi = result.aiReview.decision !== "none" && Number(result.aiReview.selected_rank) === Number(candidate.rank);
    return {
      ...candidate,
      aiVerdict: rejectReason ? "not_match" : (review?.verdict || "approximate"),
      aiConfidence: rejectReason ? 0 : (review?.confidence ?? 0),
      aiReason: rejectReason || review?.reason || "",
      aiSelected: selectedByAi && !rejectReason,
    };
  });
  result.selectedCandidate = chooseFinalCandidate(result);
  if (result.selectedCandidate) {
    result.selectedCandidate.aiSelected = true;
    result.selectedCandidate = applyAiQuantityToSelectedCandidate(result);
  }
}

function chooseFinalCandidate(result) {
  if (result.aiReview?.decision === "none") return null;
  const skippedSelected = result.candidates.find((candidate) => Number(candidate.rank) === Number(result.aiReview?.selected_rank));
  const skippedSelectedReason = skippedSelected ? getCandidateAvoidReason(skippedSelected) : "";

  const reviews = new Map((result.aiReview?.candidate_reviews || []).map((item) => [Number(item.rank), item]));
  const reviewedCandidates = result.candidates
    .map((candidate) => ({ candidate, review: reviews.get(Number(candidate.rank)) }));
  const exact = pickReviewedCandidate(reviewedCandidates, ["exact"]);
  if (exact) {
    const selectedWasChanged = Number(exact.candidate.rank) !== Number(result.aiReview?.selected_rank);
    const reasonPrefix = skippedSelectedReason
      ? `AI 选中的候选已跳过：${skippedSelectedReason}`
      : selectedWasChanged
        ? "已按 MOQ=1、运费/重量/属性完整度从完全一致候选中择优。"
        : "";
    return markFinalCandidate(exact.candidate, "exact", [reasonPrefix, exact.review?.reason || exact.candidate.aiReason || "选择符合一件起购规则的完全一致候选。"].filter(Boolean).join(" "));
  }
  const approximate = pickReviewedCandidate(reviewedCandidates, ["approximate"]) ||
    pickReviewedCandidate(reviewedCandidates, ["exact", "approximate", "uncertain", ""]);
  if (approximate) {
    const selectedWasChanged = Number(approximate.candidate.rank) !== Number(result.aiReview?.selected_rank);
    const reasonPrefix = skippedSelectedReason
      ? `AI 选中的候选已跳过：${skippedSelectedReason}`
      : selectedWasChanged
        ? "已按 MOQ=1、运费/重量/属性完整度从近似候选中择优。"
        : "";
    return markFinalCandidate(approximate.candidate, "approximate", [reasonPrefix, approximate.review?.reason || result.aiReview?.reason || "没有完全一致候选，返回最接近且符合一件起购规则的候选。"].filter(Boolean).join(" "));
  }
  const fallback = findBestFallbackCandidate(result.candidates);
  if (fallback) {
    const reasonPrefix = skippedSelectedReason ? `AI 选中的候选已跳过：${skippedSelectedReason}` : "";
    return markFinalCandidate(fallback, "approximate", [reasonPrefix, "没有完全一致候选，返回信息更完整且符合一件起购规则的非引流候选供人工确认。"].filter(Boolean).join(" "));
  }
  return null;
}

function markFinalCandidate(candidate, matchType, reason) {
  if (!candidate || isAvoidedCandidate(candidate)) return null;
  return {
    ...candidate,
    finalMatchType: matchType === "exact" ? "exact" : "approximate",
    finalReason: reason || candidate.aiReason || "",
  };
}

function applyAiQuantityToSelectedCandidate(result) {
  const aiReview = result.aiReview || {};
  const ozonQuantity = Number(aiReview.ozon_pack_quantity) > 1
    ? Number(aiReview.ozon_pack_quantity)
    : Number(result.ozon?.packQuantity || 1);
  const candidateQuantity = Number(aiReview.selected_candidate_pack_quantity) > 1
    ? Number(aiReview.selected_candidate_pack_quantity)
    : Number(result.selectedCandidate?.candidatePackQuantity || result.selectedCandidate?.packQuantity || 1);
  const annotated = annotateCandidateQuantity(
    {
      ...result.selectedCandidate,
      packQuantity: candidateQuantity,
      packQuantityEvidence: aiReview.quantity_reason || result.selectedCandidate?.packQuantityEvidence || "",
    },
    {
      ...result.ozon,
      packQuantity: ozonQuantity,
      packQuantityEvidence: aiReview.quantity_reason || result.ozon?.packQuantityEvidence || "",
    },
  );
  if (aiReview.purchase_multiplier && aiReview.purchase_multiplier > annotated.purchaseMultiplier) {
    annotated.purchaseMultiplier = aiReview.purchase_multiplier;
    const unitPrice = annotated.unitPriceRmb !== null && annotated.unitPriceRmb !== undefined
      ? Number(annotated.unitPriceRmb)
      : Number(normalize1688PriceOnly(annotated.price || annotated.priceDetails));
    annotated.estimatedPurchasePriceRmb = Number.isFinite(unitPrice) && unitPrice > 0
      ? Number((unitPrice * annotated.purchaseMultiplier).toFixed(2))
      : null;
  }
  annotated.finalReason = [annotated.finalReason, aiReview.quantity_reason ? `数量核对：${aiReview.quantity_reason}` : ""]
    .filter(Boolean)
    .join(" ");
  return annotated;
}

async function imageFileToDataUrl(filePath) {
  if (!filePath || !existsSync(filePath)) return "";
  const converted = await convertImageForUse(filePath, "ai", { maxSide: 768, format: "JPEG", quality: 82 });
  const buffer = await fs.readFile(converted);
  return `data:image/jpeg;base64,${buffer.toString("base64")}`;
}

async function prepare1688Page(context, job = null) {
  const existing = context.pages().find((page) => page.url().includes("1688.com"));
  if (existing && !existing.isClosed()) {
    await waitForHumanVerificationIfNeeded(existing, context, job, "1688 已打开页面");
    return existing;
  }
  const page = await context.newPage();
  await page.goto("https://www.1688.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await humanPause(page, 1200, 3000);
  await waitForHumanVerificationIfNeeded(page, context, job, "1688 首页");
  return page;
}

async function waitForHumanVerificationIfNeeded(page, context, job, label, options = {}) {
  const timeoutMs = options.timeoutMs || 10 * 60 * 1000;
  const pollMs = options.pollMs || 3000;
  if (page.isClosed()) {
    throw new Error(`${label} 页面已关闭，任务已停止`);
  }
  let verification = await detectHumanVerification(page);
  if (!verification.detected) return false;

  const startedAt = Date.now();
  const isHeadless = isLikelyHeadlessContext(context);
  if (job) {
    job.verification = {
      active: true,
      label,
      reason: verification.reason,
      url: verification.url || page.url(),
      headless: isHeadless,
      at: new Date().toISOString(),
    };
    job.phase = `等待验证码处理：${label}`;
    touch(job);
    if (isHeadless) {
      log(job, `检测到 ${label} 出现人机验证/滑块验证码：${verification.reason}。当前是后台浏览器模式，验证码窗口不可见；请停止任务，取消“后台浏览器模式”，打开 1688 登录窗口处理验证后再继续。`, "warn");
      notifyUser(`采集任务需要验证码`, `${label} 触发验证。后台模式看不到窗口，请切回可见模式处理。`);
    } else {
      log(job, `检测到 ${label} 出现人机验证/滑块验证码：${verification.reason}。请在弹出的自动化浏览器里完成验证，完成后程序会自动继续。`, "warn");
      notifyUser(`采集任务需要验证码`, `${label} 触发验证，请在自动化浏览器中处理。`);
    }
  }

  while (Date.now() - startedAt < timeoutMs) {
    if (page.isClosed()) {
      if (job) {
        job.verification = null;
        job.status = "error";
        job.phase = "已停止";
        log(job, `${label} 验证窗口已关闭，任务已停止。`, "warn");
        touch(job);
      }
      throw new Error(`${label} 验证窗口已关闭，任务已停止`);
    }
    if (job?.cancelRequested) {
      job.verification = null;
      job.status = "canceled";
      job.phase = "已停止";
      log(job, `${label} 验证码等待期间收到停止请求，任务已停止。`, "warn");
      touch(job);
      throw new RowSkipError(`${label} 验证码等待期间已停止任务`);
    }
    if (!isHeadless) {
      await page.bringToFront().catch(() => {});
    }
    await page.waitForTimeout(pollMs).catch(() => {});
    verification = await detectHumanVerification(page);
    if (!verification.detected) {
      if (job) {
        log(job, `${label} 的验证码/人机验证已解除，继续任务。`);
        job.verification = null;
        job.phase = "继续执行";
        touch(job);
      }
      return true;
    }
  }

  throw new Error(`${label} 的验证码等待超时，请处理后重新运行任务`);
}

async function detectHumanVerification(page) {
  try {
    return await page.evaluate(() => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 5000);
      const url = location.href;
      const selectors = [
        "#nc_1_n1z",
        ".nc_scale",
        ".nc-lang-cnt",
        ".slidetounlock",
        ".geetest_panel",
        ".geetest_slider_button",
        ".captcha",
        "[class*='captcha']",
        "[id*='captcha']",
        "[class*='verify']",
        "[id*='verify']",
        "iframe[src*='captcha']",
        "iframe[src*='verify']",
        "iframe[src*='punish']",
      ];
      const selectorHit = selectors.find((selector) => document.querySelector(selector));
      const textPatterns = [
        /滑块|拖动.*滑块|向右滑动|请拖动|验证码|验证中心|安全验证|人机验证|访问验证|身份验证|verify|captcha|robot|unusual traffic|security check/i,
      ];
      const textHit = textPatterns.find((pattern) => pattern.test(text));
      const urlHit = /captcha|verify|punish|sec|security/i.test(url);
      return {
        detected: Boolean(selectorHit || textHit || urlHit),
        reason: selectorHit ? `页面元素 ${selectorHit}` : textHit ? "页面文字提示" : urlHit ? "验证相关网址" : "",
        url,
      };
    });
  } catch {
    return { detected: false, reason: "", url: "" };
  }
}

function isLikelyHeadlessContext(context) {
  return currentBrowserHeadless;
}

async function compressImageFor1688(page, buffer, contentType = "image/jpeg") {
  const base64 = buffer.toString("base64");
  return page.evaluate(
    async ({ base64Image, mime }) => {
      const byteString = atob(base64Image.includes(",") ? base64Image.split(",")[1] : base64Image);
      const bytes = new Uint8Array(byteString.length);
      for (let i = 0; i < byteString.length; i += 1) bytes[i] = byteString.charCodeAt(i);
      const blob = new Blob([bytes], { type: mime || "image/jpeg" });
      const img = await createImageBitmap(blob);
      const width = Math.min(img.width, 800);
      const height = Math.round((img.height / img.width) * width);
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      const compressedBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(compressedBlob);
      });
    },
    { base64Image: base64, mime: contentType },
  );
}

async function get1688CookieState(context) {
  const cookies = await context.cookies([
    "https://www.1688.com/",
    "https://s.1688.com/",
    "https://h5api.m.1688.com/",
  ]);
  const tokenCookie = cookies.find((cookie) => cookie.name === "_m_h5_tk");
  const token = tokenCookie?.value?.split("_")[0] || "";
  const cookieMap = new Map();
  for (const cookie of cookies) cookieMap.set(cookie.name, `${cookie.name}=${cookie.value}`);
  return {
    token,
    cookieHeader: Array.from(cookieMap.values()).join("; "),
  };
}

async function ensure1688CookieState(context, job = null, options = {}) {
  let cookieState = await get1688CookieState(context);
  if (cookieState.token && !options.forceRefresh) return cookieState;

  await refresh1688MtopToken(context, job);
  cookieState = await get1688CookieState(context);
  return cookieState;
}

async function refresh1688MtopToken(context, job = null) {
  const dataStr = JSON.stringify({});
  const timestamp = String(Date.now());
  const url = buildMtopUrl({
    t: timestamp,
    sign: signMtop("", timestamp, dataStr),
    type: "jsonp",
    dataType: "jsonp",
    callback: `mtopjsonp${randomInt(1000, 9999)}`,
    data: dataStr,
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await humanPause(page, 800, 1800);
    if (job) log(job, "已尝试刷新 1688 搜图 token。");
  } finally {
    await page.close().catch(() => {});
  }
}

function isMtopTokenError(message) {
  return /FAIL_SYS_TOKEN|_m_h5_tk|令牌|token/i.test(String(message || ""));
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

function signMtop(token, timestamp, dataStr) {
  return crypto.createHash("md5").update(`${token}&${timestamp}&${APP_KEY}&${dataStr}`).digest("hex");
}

function build1688Headers(cookieHeader, extra = {}) {
  return {
    Accept: "application/json,text/plain,*/*",
    Referer: "https://s.1688.com/",
    Origin: "https://s.1688.com",
    "User-Agent": USER_AGENT,
    Cookie: cookieHeader,
    ...extra,
  };
}

function parseMtopText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/^[^(]*\(([\s\S]*)\)\s*;?$/);
    if (!match) throw new Error(`接口返回不是 JSON：${text.slice(0, 300)}`);
    return JSON.parse(match[1]);
  }
}

function assertMtopSuccess(json, message) {
  const ret = Array.isArray(json?.ret) ? json.ret.join("; ") : "";
  if (!ret.includes("SUCCESS")) {
    throw new Error(`${message}：${ret || JSON.stringify(json).slice(0, 500)}`);
  }
}

async function downloadImage(context, jobId, index, url, referer) {
  return downloadImageFile(context, {
    jobId,
    index,
    prefix: "ozon",
    url,
    referer,
  });
}

async function downloadImageFile(context, { jobId, index, prefix, url, referer }) {
  const response = await context.request.get(url, {
    timeout: 45000,
    headers: { Referer: referer, "User-Agent": USER_AGENT },
  });
  if (!response.ok()) {
    throw new Error(`图片下载失败 ${response.status()}：${url}`);
  }
  const buffer = await response.body();
  const contentType = response.headers()["content-type"] || "image/jpeg";
  const ext = extensionFromContentType(contentType, url);
  const filename = `${prefix}_${String(index).padStart(3, "0")}.${ext}`;
  const filePath = path.join(JOBS_DIR, jobId, "images", filename);
  await fs.writeFile(filePath, buffer);
  return {
    url,
    filePath,
    publicUrl: `/artifacts/jobs/${jobId}/images/${filename}`,
    contentType,
    buffer,
  };
}

function formatOzonCnyForExport(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const match = text.match(/(\d+(?:[.,]\d+)?)/);
  if (!match) return text;
  const number = Number(match[1].replace(",", "."));
  if (!Number.isFinite(number)) return text;
  return `${formatPriceNumber(number)} ¥`;
}

function formatNumberForSheet(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "";
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)));
}

function formatAiThinkingModeForSheet(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const parts = text.split(";").map((part) => part.trim()).filter(Boolean);
  const primary = parts[0] || text;
  if (["disabled", "off", "false", "0", "none"].includes(primary.toLowerCase())) {
    return parts.length > 1 ? `关闭（${parts.slice(1).join("；")}）` : "关闭";
  }
  return `开启(${text})`;
}

function parseRmbNumber(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text || /包邮|免运费|免费|无需额外费用/i.test(text)) return text ? 0 : null;
  const match = text.replace(/,/g, ".").match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? number : null;
}

function extractOzonProductId(value) {
  const text = String(value || "");
  const productPath = text.match(/\/product\/([^/?#]+)/i)?.[1] || text;
  const groups = Array.from(productPath.matchAll(/\d{6,}/g)).map((match) => match[0]);
  return groups.length ? groups[groups.length - 1] : "";
}

function formatAttributeValueForSheet(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => formatAttributeValueForSheet(item))
      .filter(Boolean)
      .join(", ");
  }
  if (typeof value === "object") {
    const direct = value.value ?? value.text ?? value.name ?? value.title ?? value.displayValue ?? value.displayName;
    if (direct != null && direct !== value) return formatAttributeValueForSheet(direct);
    try {
      return JSON.stringify(value, null, 0);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function formatAttributesForSheet(attributes, limit = 20) {
  return Object.entries(attributes || {})
    .slice(0, limit)
    .map(([key, value]) => `${key}: ${formatAttributeValueForSheet(value)}`)
    .join("\n");
}

async function writeJobArtifacts(job) {
  if (job.kind === "batch-ozon") {
    await writeBatchOzonArtifacts(job);
    return;
  }

  const dir = path.join(JOBS_DIR, job.id);
  await ensureDir(dir);
  if (job.resumeFromRow && Array.isArray(job.resumeUrls) && job.resumeUrls.length) {
    const resumeFilename = `resume-from-row-${job.resumeFromRow}.txt`;
    await fs.writeFile(path.join(dir, resumeFilename), `${job.resumeUrls.join("\n")}\n`, "utf8");
    job.resumeFile = `/artifacts/jobs/${job.id}/${resumeFilename}`;
  }
  if (Array.isArray(job.results)) {
    for (const result of job.results) {
      if (!result || result.error) continue;
      await hydrateWorkerRunResultImages(job.id, result).catch((error) => {
        console.warn(`[single-sourcing-artifacts] image hydration failed job=${job.id}: ${error.message}`);
      });
    }
  }
  const jsonPath = path.join(dir, "results.json");
  await fs.writeFile(jsonPath, JSON.stringify(serializeJob(job), null, 2), "utf8");

  const rows = [];
  for (const result of job.results) {
    const ozon = result.ozon || {};
    const fallbackCandidate = findBestFallbackCandidate(result.candidates || []);
    const aiSaysNoCandidate = result.aiReview?.decision === "none" && !result.aiReview?.selected_rank;
    const selectedCandidate = result.selectedCandidate && !isAvoidedCandidate(result.selectedCandidate)
      ? markFinalCandidate(
        result.selectedCandidate,
        result.selectedCandidate.finalMatchType || result.aiReview?.decision,
        result.selectedCandidate.finalReason || result.selectedCandidate.aiReason || result.aiReview?.reason,
      )
      : null;
    const fallbackFinalCandidate = !aiSaysNoCandidate && fallbackCandidate
      ? markFinalCandidate(fallbackCandidate, "approximate", "未进行 AI 最终选择，返回候选中最靠前且明确一件起购的非引流/非促销结果供人工确认。")
      : null;
    const finalCandidate = selectedCandidate || fallbackFinalCandidate;
    const ozonDisplayPrice = getOzonDisplayPriceText(ozon);
    const ozonBlackPrice = getOzonBestBlackPriceText(ozon);
    const ozonWeightGrams = formatNumberForSheet(ozon.weightGrams || normalizeWeightGrams(ozon.weightText));
    const aiEstimatedWeightGrams = formatNumberForSheet(result.aiReview?.estimated_weight_grams);
    const base = {
      "原始行号": result.sourceRow || "",
      "Ozon链接": result.url,
      "Ozon标题": ozon.title || "",
      "Ozon价格": ozonDisplayPrice,
      "Ozon产品黑标价RMB": ozonBlackPrice,
      "Ozon跟卖数量": ozon.sellerOfferCount ?? "",
      "Ozon价格采集备注": ozon.ozonPriceNote || "",
      "Ozon重量（克）": ozonWeightGrams,
      "Ozon重量来源": ozon.weightSource || "",
      "Ozon重量依据": ozon.weightEvidence || "",
      "AI估算重量（克）": aiEstimatedWeightGrams,
      "AI估算重量置信度": result.aiReview?.estimated_weight_confidence ?? "",
      "AI估算重量依据": result.aiReview?.estimated_weight_reason || "",
      "Ozon件数": ozon.packQuantity || "",
      "Ozon件数依据": ozon.packQuantityEvidence || "",
      "Ozon图片": "",
      "Ozon主图链接": pickOzonImageUrl(ozon),
      "本地主图文件": ozon.mainImage?.filePath || "",
      "Ozon描述": ozon.description || "",
      "Ozon错误": result.error || "",
      "1688搜索错误": result.searchError || "",
      "AI最终结果": finalCandidate?.finalMatchType === "exact" ? "完全一致" : finalCandidate ? "近似匹配" : "无候选",
      "AI选中候选": finalCandidate?.rank || result.aiReview?.selected_rank || "",
      "AI最终置信度": result.aiReview?.confidence ?? "",
      "AI最终原因": result.aiReview?.reason || "",
      "AI模型": result.aiReview?.model || "",
      "AI思考模式": formatAiThinkingModeForSheet(result.aiReview?.thinkingMode),
      "AI耗时秒": result.aiReview?.aiElapsedMs ? Number((result.aiReview.aiElapsedMs / 1000).toFixed(2)) : "",
      "AI输入Tokens": result.aiReview?.aiUsage?.inputTokens ?? "",
      "AI输出Tokens": result.aiReview?.aiUsage?.outputTokens ?? "",
      "AI总Tokens": result.aiReview?.aiUsage?.totalTokens ?? "",
      "AI估算费用USD": result.aiReview?.aiUsage?.estimatedCostUsd ?? "",
      _ozonImagePath: ozon.mainImage?.filePath || "",
      _templateSkuId: extractOzonProductId(result.url || ozon.sourceUrl || ""),
      _templateWeightGrams: ozonWeightGrams,
      _templateAiEstimatedWeightGrams: aiEstimatedWeightGrams,
      _templateBlackPrice: parseRmbNumber(ozonBlackPrice) ?? "",
      _templateAlibabaCost: "",
    };
    const attrs = formatAttributesForSheet(ozon.attributes);
    if (attrs) base["Ozon属性"] = attrs;

    if (finalCandidate) {
      const candidate = finalCandidate;
      const unitPriceForExport = Number(normalize1688PriceOnly(candidate.priceDetails || candidate.price));
      const shippingFeeForExport = parseRmbNumber(candidate.shippingFee);
      const candidateWeightGrams = formatNumberForSheet(candidate.weightGrams || normalizeWeightGrams(candidate.weightText));
      const moqQuantityForExport = parseMoqQuantity(candidate.minOrderQuantity || candidate.moq);
      const candidateAvoidReason = getCandidateAvoidReason(candidate);
      const estimatedPurchasePriceForExport = Number.isFinite(unitPriceForExport) && unitPriceForExport > 0 && candidate.purchaseMultiplier
        ? Number((unitPriceForExport * Number(candidate.purchaseMultiplier)).toFixed(2))
        : candidate.estimatedPurchasePriceRmb;
      rows.push({
        ...base,
        "匹配类型": candidate.finalMatchType === "exact" ? "完全一致" : "近似匹配",
        "候选序号": candidate.rank,
        "1688标题": candidate.title,
        "1688价格": normalize1688PriceOnly(candidate.priceDetails || candidate.price),
        "1688价格明细": candidate.priceDetails,
        "按Ozon件数估算采购价RMB": estimatedPurchasePriceForExport ?? "",
        "采购倍数": candidate.purchaseMultiplier || "",
        "Ozon件数核对": candidate.quantityAssessment || "",
        "1688销售件数": candidate.candidatePackQuantity || candidate.packQuantity || "",
        "1688件数依据": candidate.packQuantityEvidence || "",
        "最少起批": candidate.minOrderQuantity || candidate.moq,
        "MOQ解析值": moqQuantityForExport ?? "",
        "MOQ规则状态": getMoqRuleStatus(candidate),
        "候选跳过原因": candidateAvoidReason,
        "候选质量分": scoreSourcingCandidate(candidate),
        "1688运费": candidate.shippingFee || (candidate.detailError ? "" : "未公开/需选择地区"),
        "1688运费来源": candidate.shippingFeeSource || "",
        "1688尺寸": candidate.dimensionsText,
        "1688重量（克）": candidateWeightGrams,
        "1688重量来源": candidate.weightSource || "",
        "1688图片": "",
        "1688链接": candidate.link,
        "1688图片链接": pickCandidateImageUrl(candidate),
        "疑似引流款": candidate.trafficBaitRisk ? "是" : "",
        "引流款原因": candidate.trafficBaitReason || "",
        "疑似优惠价": candidate.promotionRisk ? "是" : "",
        "优惠价原因": candidate.promotionReason || "",
        "优惠信息": candidate.promotionText || "",
        "_templateSkuId": extractOzonProductId(result.url || ozon.sourceUrl || ""),
        "_templateWeightGrams": ozonWeightGrams || candidateWeightGrams,
        "_templateAiEstimatedWeightGrams": aiEstimatedWeightGrams,
        "_templateBlackPrice": parseRmbNumber(ozonBlackPrice) ?? "",
        "_templateAlibabaCost": Number.isFinite(unitPriceForExport) && unitPriceForExport > 0 && shippingFeeForExport !== null
          ? Number((unitPriceForExport + shippingFeeForExport).toFixed(2))
          : "",
        "AI是否选中": candidate.aiSelected ? "是" : "",
        "AI候选判断": aiVerdictText(candidate.aiVerdict),
        "AI候选置信度": candidate.aiConfidence ?? "",
        "AI候选原因": candidate.finalReason || candidate.aiReason || "",
        "1688详情采集状态": candidate.detailError ? `采集失败：${candidate.detailError}` : "已采集",
        "1688图片下载状态": candidate.imageDownloadError ? `下载失败：${candidate.imageDownloadError}` : candidate.localImage?.filePath ? "已嵌入" : "",
        _1688ImagePath: candidate.localImage?.filePath || "",
        _highlight: candidate.finalMatchType === "exact" ? "" : "yellow",
      });
    } else {
      const diagnosticCandidate = findBestDiagnosticCandidate(result.candidates || [], result.aiReview?.selected_rank);
      if (diagnosticCandidate) {
        const moqQuantityForExport = parseMoqQuantity(diagnosticCandidate.minOrderQuantity || diagnosticCandidate.moq);
        const candidateWeightGrams = formatNumberForSheet(diagnosticCandidate.weightGrams || normalizeWeightGrams(diagnosticCandidate.weightText));
        const candidateAvoidReason = getCandidateAvoidReason(diagnosticCandidate);
        rows.push({
          ...base,
          "匹配类型": "无候选",
          "候选序号": diagnosticCandidate.rank,
          "1688标题": diagnosticCandidate.title,
          "1688价格": normalize1688PriceOnly(diagnosticCandidate.priceDetails || diagnosticCandidate.price),
          "1688价格明细": diagnosticCandidate.priceDetails,
          "最少起批": diagnosticCandidate.minOrderQuantity || diagnosticCandidate.moq,
          "MOQ解析值": moqQuantityForExport ?? "",
          "MOQ规则状态": getMoqRuleStatus(diagnosticCandidate),
          "候选跳过原因": candidateAvoidReason || "AI 判定无可自动采用候选，仅导出该候选供人工复核。",
          "候选质量分": scoreDiagnosticCandidate(diagnosticCandidate),
          "1688运费": diagnosticCandidate.shippingFee || (diagnosticCandidate.detailError ? "" : "未公开/需选择地区"),
          "1688运费来源": diagnosticCandidate.shippingFeeSource || "",
          "1688尺寸": diagnosticCandidate.dimensionsText,
          "1688重量（克）": candidateWeightGrams,
          "1688重量来源": diagnosticCandidate.weightSource || "",
          "1688图片": "",
          "1688链接": diagnosticCandidate.link,
          "1688图片链接": pickCandidateImageUrl(diagnosticCandidate),
          "疑似引流款": diagnosticCandidate.trafficBaitRisk ? "是" : "",
          "引流款原因": diagnosticCandidate.trafficBaitReason || "",
          "疑似优惠价": diagnosticCandidate.promotionRisk ? "是" : "",
          "优惠价原因": diagnosticCandidate.promotionReason || "",
          "优惠信息": diagnosticCandidate.promotionText || "",
          "AI是否选中": diagnosticCandidate.aiSelected || Number(diagnosticCandidate.rank) === Number(result.aiReview?.selected_rank) ? "是" : "",
          "AI候选判断": aiVerdictText(diagnosticCandidate.aiVerdict),
          "AI候选置信度": diagnosticCandidate.aiConfidence ?? "",
          "AI候选原因": diagnosticCandidate.aiReason || result.aiReview?.reason || "",
          "1688详情采集状态": diagnosticCandidate.detailError ? `采集失败：${diagnosticCandidate.detailError}` : "已采集",
          "1688图片下载状态": diagnosticCandidate.imageDownloadError ? `下载失败：${diagnosticCandidate.imageDownloadError}` : diagnosticCandidate.localImage?.filePath ? "已嵌入" : "",
          _1688ImagePath: diagnosticCandidate.localImage?.filePath || "",
          _highlight: "yellow",
        });
        continue;
      }
      rows.push({
        ...base,
        "匹配类型": "无候选",
        _highlight: "yellow",
      });
    }
  }

  const excelPath = path.join(dir, "ozon-1688-results.xlsx");
  await writeXlsxWithEmbeddedImages(rows, excelPath);
  job.downloadUrl = `/api/history/${job.id}/download`;
}

async function writeBatchOzonArtifacts(job) {
  const dir = path.join(JOBS_DIR, job.id);
  await ensureDir(dir);
  const jsonPath = path.join(dir, "results.json");
  await fs.writeFile(jsonPath, JSON.stringify(serializeJob(job), null, 2), "utf8");

  const rows = (job.results || []).map((result) => {
    const ozon = result.ozon || {};
    const attrs = formatAttributesForSheet(ozon.attributes);
    return {
      "序号": result.sourceRow || "",
      "筛选结果": result.error ? "采集失败" : result.passedFilters ? "通过" : "未通过",
      "筛选原因": (result.filterReasons || []).join("；"),
      "Ozon商品ID": extractOzonProductId(result.url || ozon.sourceUrl || ""),
      "Ozon链接": result.url || ozon.sourceUrl || "",
      "Ozon标题": ozon.title || "",
      "Ozon最终黑标价RMB": getOzonBestBlackPriceText(ozon),
      "当前商品黑标价RMB": formatOzonCnyForExport(ozon.currentBlackPriceCny || ""),
      "低价推荐黑标价RMB": formatOzonCnyForExport(ozon.sellerLowestBlackPriceCny || ""),
      "Ozon跟卖数量": ozon.sellerOfferCount ?? "",
      "Ozon价格": getOzonDisplayPriceText(ozon),
      "Ozon价格采集备注": ozon.ozonPriceNote || "",
      "Ozon重量（克）": formatNumberForSheet(ozon.weightGrams || normalizeWeightGrams(ozon.weightText)),
      "Ozon重量来源": ozon.weightSource || "",
      "Ozon重量依据": ozon.weightEvidence || "",
      "Ozon件数": ozon.packQuantity || "",
      "Ozon件数依据": ozon.packQuantityEvidence || "",
      "Ozon图片": "",
      "Ozon主图链接": pickOzonImageUrl(ozon),
      "本地主图文件": ozon.mainImage?.filePath || "",
      "Ozon属性": attrs,
      "Ozon描述": ozon.description || "",
      "采集错误": result.error || "",
      _ozonImagePath: ozon.mainImage?.filePath || "",
      _highlight: result.error || !result.passedFilters ? "yellow" : "",
    };
  });

  const excelPath = path.join(dir, "ozon-batch-results.xlsx");
  await writeXlsxWithEmbeddedImages(rows, excelPath, {
    useLogisticsTemplate: false,
    preferredHeaders: [
      "Ozon图片",
      "序号",
      "筛选结果",
      "筛选原因",
      "Ozon商品ID",
      "Ozon标题",
      "Ozon链接",
      "Ozon最终黑标价RMB",
      "当前商品黑标价RMB",
      "低价推荐黑标价RMB",
      "Ozon跟卖数量",
      "Ozon价格",
      "Ozon价格采集备注",
      "Ozon重量（克）",
      "Ozon重量来源",
      "Ozon重量依据",
      "Ozon件数",
      "Ozon件数依据",
      "Ozon属性",
      "Ozon描述",
      "Ozon主图链接",
      "本地主图文件",
      "采集错误",
    ],
    imageColumns: new Map([["Ozon图片", "_ozonImagePath"]]),
  });
  job.downloadUrl = `/api/history/${job.id}/download`;
}

async function autoScroll(page) {
  await humanScroll(page, { maxScroll: 5000, minStep: 500, maxStep: 1100, minDelay: 180, maxDelay: 520, returnTop: true });
  await humanPause(page, 500, 1400);
}

async function humanBrowse1688DetailPage(page) {
  const mode = String(DETAIL_BROWSE_MODE || "balanced").toLowerCase();
  if (mode === "fast") {
    await page.mouse.move(randomInt(180, 680), randomInt(160, 520), { steps: randomInt(6, 16) }).catch(() => {});
    await humanPause(page, 500, 1200);
    await humanScroll(page, {
      maxScroll: randomInt(2200, 5200),
      minStep: 900,
      maxStep: 1800,
      minDelay: 90,
      maxDelay: 260,
      dwellMinDelay: 300,
      dwellMaxDelay: 900,
      dwellEveryMin: 3,
      dwellEveryMax: 6,
      returnTop: true,
      returnMinStep: 1200,
      returnMaxStep: 2200,
      returnMinDelay: 80,
      returnMaxDelay: 220,
    });
    await humanPause(page, 400, 1000);
    return;
  }
  if (mode !== "slow") {
    await page.mouse.move(randomInt(180, 680), randomInt(160, 520), { steps: randomInt(8, 20) }).catch(() => {});
    await humanPause(page, 800, 1800);
    await humanScroll(page, {
      maxScroll: randomInt(4200, 9000),
      minStep: 700,
      maxStep: 1500,
      minDelay: 180,
      maxDelay: 520,
      dwellMinDelay: 600,
      dwellMaxDelay: 1600,
      dwellEveryMin: 3,
      dwellEveryMax: 6,
      returnTop: true,
      returnMinStep: 900,
      returnMaxStep: 1800,
      returnMinDelay: 120,
      returnMaxDelay: 360,
    });
    await page.mouse.move(randomInt(160, 860), randomInt(120, 620), { steps: randomInt(6, 16) }).catch(() => {});
    await humanPause(page, 700, 1800);
    return;
  }

  await page.mouse.move(randomInt(180, 680), randomInt(160, 520), { steps: randomInt(8, 24) }).catch(() => {});
  await humanPause(page, 1800, 4200);
  await humanScroll(page, {
    toBottom: true,
    minStep: 260,
    maxStep: 760,
    minDelay: 550,
    maxDelay: 1800,
    dwellMinDelay: 1800,
    dwellMaxDelay: 5200,
    dwellEveryMin: 2,
    dwellEveryMax: 5,
    returnTop: true,
    returnMinStep: 520,
    returnMaxStep: 1200,
    returnMinDelay: 260,
    returnMaxDelay: 900,
  });
  await page.mouse.move(randomInt(160, 860), randomInt(120, 620), { steps: randomInt(6, 18) }).catch(() => {});
  await humanPause(page, 2200, 6200);
}

function detailBrowseModeLabel() {
  const mode = String(DETAIL_BROWSE_MODE || "balanced").toLowerCase();
  if (mode === "fast") return "快速拟人";
  if (mode === "slow") return "慢速完整拟人";
  return "平衡拟人";
}

async function humanScroll(page, options = {}) {
  await page.evaluate(async (settings) => {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const randomIntInPage = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
    const documentHeight = Math.max(
      document.body?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0,
      window.innerHeight,
    );
    const max = settings.toBottom
      ? Math.max(0, documentHeight - window.innerHeight)
      : Math.min(documentHeight, settings.maxScroll);
    let dwellCounter = randomIntInPage(settings.dwellEveryMin, settings.dwellEveryMax);
    for (let y = 0; y < max; y += randomIntInPage(settings.minStep, settings.maxStep)) {
      window.scrollTo(0, y);
      await delay(randomIntInPage(settings.minDelay, settings.maxDelay));
      dwellCounter -= 1;
      if (settings.dwellMinDelay && dwellCounter <= 0) {
        await delay(randomIntInPage(settings.dwellMinDelay, settings.dwellMaxDelay));
        dwellCounter = randomIntInPage(settings.dwellEveryMin, settings.dwellEveryMax);
      }
    }
    if (settings.toBottom) {
      window.scrollTo(0, max);
      await delay(randomIntInPage(settings.dwellMinDelay || settings.minDelay, settings.dwellMaxDelay || settings.maxDelay));
    }
    if (settings.returnTop) {
      await delay(randomIntInPage(settings.minDelay, settings.maxDelay));
      for (let y = max; y > 0; y -= randomIntInPage(settings.returnMinStep, settings.returnMaxStep)) {
        window.scrollTo(0, y);
        await delay(randomIntInPage(settings.returnMinDelay, settings.returnMaxDelay));
      }
      window.scrollTo(0, 0);
    }
  }, {
    maxScroll: options.maxScroll || 5000,
    toBottom: Boolean(options.toBottom),
    minStep: options.minStep || 500,
    maxStep: options.maxStep || 1000,
    minDelay: options.minDelay || 180,
    maxDelay: options.maxDelay || 500,
    dwellMinDelay: options.dwellMinDelay || 0,
    dwellMaxDelay: options.dwellMaxDelay || 0,
    dwellEveryMin: options.dwellEveryMin || 3,
    dwellEveryMax: options.dwellEveryMax || 6,
    returnTop: Boolean(options.returnTop),
    returnMinStep: options.returnMinStep || options.minStep || 500,
    returnMaxStep: options.returnMaxStep || options.maxStep || 1000,
    returnMinDelay: options.returnMinDelay || options.minDelay || 180,
    returnMaxDelay: options.returnMaxDelay || options.maxDelay || 500,
  }).catch(() => {});
}

async function humanPause(page, minMs, maxMs) {
  await page.waitForTimeout(randomInt(minMs, maxMs)).catch(() => {});
}

async function getBrowserContext({ headless = false } = {}) {
  if (browserContext && currentBrowserHeadless !== headless) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    currentBrowserHeadless = false;
  }
  if (browserContext) return browserContext;
  if (browserOpening) return browserOpening;

  browserOpening = (async () => {
    try {
      await ensureDir(PROFILE_DIR);
      const context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless,
        viewport: { width: 1365, height: 900 },
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        userAgent: USER_AGENT,
        args: ["--disable-blink-features=AutomationControlled"],
      });
      context.on("close", () => {
        browserContext = null;
        currentBrowserHeadless = false;
      });
      currentBrowserHeadless = headless;
      browserContext = context;
      browserOpening = null;
      return context;
    } catch (error) {
      browserOpening = null;
      throw error;
    }
  })();

  return browserOpening;
}

function serializeJob(job) {
  return {
    ...job,
    logs: (Array.isArray(job.logs) ? job.logs : []).slice(-300).map((entry) => {
      if (typeof entry === "string") return entry.slice(0, 2000);
      return {
        ...entry,
        message: String(entry?.message || "").slice(0, 2000),
      };
    }),
    results: (Array.isArray(job.results) ? job.results : []).map((result) => compactJobJsonValue(stripBuffers(result), "result")),
    cancelRequested: undefined,
  };
}

function compactJobJsonValue(value, key = "", depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") {
    if (/^data:image\/|base64,/i.test(value)) return `[省略 base64 ${value.length} 字符]`;
    return value.length > 4000 ? `${value.slice(0, 4000)}... [已截断 ${value.length} 字符]` : value;
  }
  if (typeof value !== "object") return value;
  if (depth > 8) return "[已省略深层对象]";
  if (Array.isArray(value)) {
    const limit = key === "results" ? 2000
      : key === "logs" ? 300
        : /candidates|candidate_reviews/i.test(key) ? 20
          : 80;
    return value.slice(0, limit).map((item) => compactJobJsonValue(item, key, depth + 1));
  }
  const heavyKeyPattern = /(?:^|_)(raw|html|script|snapshot|payload|base64|dataurl|bodytext|textcontent|webpack|apollo|redux)(?:$|_)/i;
  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (childKey === "buffer" || heavyKeyPattern.test(childKey)) {
      const size = typeof childValue === "string" ? childValue.length : Array.isArray(childValue) ? childValue.length : "";
      out[childKey] = size ? `[已省略大字段 ${size}]` : "[已省略大字段]";
      continue;
    }
    out[childKey] = compactJobJsonValue(childValue, childKey, depth + 1);
  }
  return out;
}

function makeLogEntry(message, level = "info") {
  return { at: new Date().toISOString(), level, message };
}

function compareNumericVersion(a, b) {
  const left = String(a || "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b || "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function dbRowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    storeId: row.store_id || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    phase: row.phase || "",
    kind: row.kind,
    total: row.total || 0,
    sourceTotal: row.source_total || 0,
    sourceStartRow: row.source_start_row || 1,
    processed: row.processed || 0,
    consecutiveFailures: 0,
    logs: Array.isArray(row.logs) ? row.logs.slice(-300) : [],
    verification: null,
    results: Array.isArray(row.results) ? row.results : [],
    error: row.error || "",
    downloadUrl: row.download_url || "",
    cancelRequested: undefined,
    payload: row.payload || {},
    owner: row.username ? {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name || row.username,
    } : null,
  };
}

async function createQueuedDbJob(user, job, payload) {
  const logs = [
    makeLogEntry("任务已创建，等待本机采集端领取。"),
  ];
  const storeId = String(job.storeId || payload?.storeId || payload?.store_id || payload?.options?.storeId || payload?.options?.store_id || "").trim() || null;
  const result = await db.query(
    `INSERT INTO app_jobs (
      id, user_id, store_id, kind, status, phase, total, processed, source_total, source_start_row,
      payload, logs, results, error, download_url, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11::jsonb, $12::jsonb, '[]'::jsonb, '', '', now(), now()
    )
    RETURNING *`,
    [
      job.id,
      user?.id || null,
      storeId,
      job.kind,
      "queued",
      job.phase || "等待本机采集端领取",
      Number(job.total || 0),
      0,
      Number(job.sourceTotal || job.total || 0),
      Number(job.sourceStartRow || 1),
      JSON.stringify(payload || {}),
      JSON.stringify(logs),
    ],
  );
  return dbRowToJob(result.rows[0]);
}

async function findActiveDbJobForUser(user, options = {}) {
  if (!db || !user?.id) return null;
  const kind = String(options.kind || "").trim();
  const storeId = String(options.storeId || options.store_id || "").trim();
  const result = await db.query(
    `SELECT j.*, u.username, u.display_name
     FROM app_jobs j
     LEFT JOIN app_users u ON u.id = j.user_id
     WHERE j.user_id = $1
       AND j.status IN ('queued','claimed','running','exporting')
       AND ($2 = '' OR j.kind = $2)
       AND ($3::uuid IS NULL OR j.store_id = $3::uuid)
     ORDER BY
       CASE j.status WHEN 'running' THEN 1 WHEN 'claimed' THEN 2 WHEN 'exporting' THEN 3 WHEN 'queued' THEN 4 ELSE 9 END,
       j.updated_at DESC
     LIMIT 1`,
    [user.id, kind, storeId || null],
  );
  return result.rowCount ? dbRowToJob(result.rows[0]) : null;
}

async function upsertWorkerHeartbeat(user, workerName = "", meta = {}) {
  if (!db || !user?.id) return;
  const workerLabel = String(workerName || "").trim().slice(0, 80) || "本机采集端";
  const storeId = String(meta.storeId || meta.store_id || user.tokenStoreId || "").trim() || null;
  const version = String(meta.version || meta.pluginVersion || "").trim().slice(0, 40);
  const platform = String(meta.platform || "").trim().slice(0, 40);
  const hostname = String(meta.hostname || "").trim().slice(0, 120);
  const profileDir = String(meta.profileDir || "").trim().slice(0, 500);
  const currentPhase = String(meta.currentPhase || "").trim().slice(0, 200);
  const currentJobId = isSafeJobId(meta.currentJobId) ? meta.currentJobId : null;
  await db.query(
    `INSERT INTO app_worker_heartbeats (
       user_id, store_id, worker_name, version, platform, hostname, profile_dir, current_job_id, current_phase, last_seen_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (user_id, worker_name)
     DO UPDATE SET
       store_id = EXCLUDED.store_id,
       version = COALESCE(NULLIF(EXCLUDED.version, ''), app_worker_heartbeats.version),
       platform = EXCLUDED.platform,
       hostname = EXCLUDED.hostname,
       profile_dir = EXCLUDED.profile_dir,
       current_job_id = EXCLUDED.current_job_id,
       current_phase = COALESCE(NULLIF(EXCLUDED.current_phase, ''), app_worker_heartbeats.current_phase),
       last_seen_at = now()`,
    [user.id, storeId, workerLabel, version, platform, hostname, profileDir, currentJobId, currentPhase],
  );
}

async function rescueStaleDbJobsForUser(user, options = {}) {
  if (!db || !user?.id) return 0;
  const client = await db.connect();
  const kinds = Array.isArray(options.kinds)
    ? options.kinds.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 8)
    : [];
  const tokenStoreId = isScopedWorkerUser(user) ? String(user.tokenStoreId || "").trim() : "";
  const staleSeconds = Math.max(60, Math.round(WORKER_JOB_STALE_MS / 1000));
  const onlineSeconds = Math.max(30, Math.round(WORKER_ONLINE_WINDOW_MS / 1000));
  const idleRescueSeconds = Math.max(45, Math.round(WORKER_IDLE_JOB_RESCUE_MS / 1000));
  const lostRescueSeconds = Math.max(90, Math.round(WORKER_LOST_JOB_RESCUE_MS / 1000));
  const requeueRows = async (rows, reason) => {
    for (const row of rows) {
      const logs = Array.isArray(row.logs) ? row.logs.slice(-299) : [];
      const processed = Number(row.processed || 0);
      const total = Number(row.total || 0);
      const nextText = total > 0 ? `第 ${Math.min(processed + 1, total)}/${total} 条` : "断点";
      const message = reason === "idle"
        ? `采集端已空闲但任务仍未收尾，已重新放回队列，将从${nextText}继续。`
        : reason === "lost"
          ? `采集端当前任务心跳失联，已重新放回队列，将从${nextText}继续。`
          : `超过 ${Math.round(staleSeconds / 60)} 分钟未收到采集端进度，已重新放回队列，将从${nextText}继续。`;
      const phase = reason === "idle"
        ? `采集端已空闲，等待重新领取（从${nextText}继续）`
        : reason === "lost"
          ? `采集端失联，等待重新领取（从${nextText}继续）`
          : `采集端断开，等待重新领取（从${nextText}继续）`;
      logs.push(makeLogEntry(message, "warn"));
      await client.query(
        `UPDATE app_jobs
         SET status = 'queued',
             phase = $2,
             logs = $3::jsonb,
             updated_at = now()
         WHERE id = $1`,
        [row.id, phase, JSON.stringify(logs)],
      );
    }
  };
  try {
    await client.query("BEGIN");
    const stale = await client.query(
      `SELECT j.*
       FROM app_jobs j
       WHERE j.user_id = $1
         AND j.status IN ('claimed','running')
         AND (cardinality($2::text[]) = 0 OR j.kind = ANY($2::text[]))
         AND ($3::uuid IS NULL OR j.store_id = $3::uuid)
         AND j.updated_at < now() - ($4::int * interval '1 second')
         AND (COALESCE(j.total, 0) <= 0 OR COALESCE(j.processed, 0) < COALESCE(j.total, 0))
         AND NOT EXISTS (
           SELECT 1
           FROM app_worker_heartbeats h
           WHERE h.user_id = j.user_id
             AND h.current_job_id = j.id
             AND h.last_seen_at > now() - ($5::int * interval '1 second')
         )
       ORDER BY j.updated_at ASC
       LIMIT 5
       FOR UPDATE SKIP LOCKED`,
      [user.id, kinds, tokenStoreId || null, staleSeconds, onlineSeconds],
    );
    await requeueRows(stale.rows, "stale");
    const lost = await client.query(
      `SELECT j.*
       FROM app_jobs j
       WHERE j.user_id = $1
         AND j.status IN ('claimed','running')
         AND (cardinality($2::text[]) = 0 OR j.kind = ANY($2::text[]))
         AND ($3::uuid IS NULL OR j.store_id = $3::uuid)
         AND j.updated_at < now() - ($4::int * interval '1 second')
         AND (COALESCE(j.total, 0) <= 0 OR COALESCE(j.processed, 0) < COALESCE(j.total, 0))
         AND NOT EXISTS (
           SELECT 1
           FROM app_worker_heartbeats h
           WHERE h.user_id = j.user_id
             AND h.current_job_id = j.id
             AND h.last_seen_at > now() - ($5::int * interval '1 second')
         )
       ORDER BY j.updated_at ASC
       LIMIT 5
       FOR UPDATE SKIP LOCKED`,
      [user.id, kinds, tokenStoreId || null, lostRescueSeconds, onlineSeconds],
    );
    await requeueRows(lost.rows, "lost");
    const idle = await client.query(
      `SELECT j.*
       FROM app_jobs j
       WHERE j.user_id = $1
         AND j.status IN ('claimed','running')
         AND (cardinality($2::text[]) = 0 OR j.kind = ANY($2::text[]))
         AND ($3::uuid IS NULL OR j.store_id = $3::uuid)
         AND j.updated_at < now() - ($4::int * interval '1 second')
         AND (COALESCE(j.total, 0) <= 0 OR COALESCE(j.processed, 0) < COALESCE(j.total, 0))
         AND NOT EXISTS (
           SELECT 1
           FROM app_worker_heartbeats h
           WHERE h.user_id = j.user_id
             AND h.current_job_id = j.id
             AND h.last_seen_at > now() - ($5::int * interval '1 second')
         )
         AND EXISTS (
           SELECT 1
           FROM app_worker_heartbeats h
           WHERE h.user_id = j.user_id
             AND h.last_seen_at > now() - ($5::int * interval '1 second')
             AND h.current_job_id IS NULL
             AND (h.store_id IS NULL OR j.store_id IS NULL OR h.store_id = j.store_id)
             AND COALESCE(h.current_phase, '') ~ '(在线|可领取|空闲|领取任务)'
             AND COALESCE(h.current_phase, '') !~ '(低于单品找货最低版本|不领取任务|暂不领取|预览版)'
         )
       ORDER BY j.updated_at ASC
       LIMIT 5
       FOR UPDATE SKIP LOCKED`,
      [user.id, kinds, tokenStoreId || null, idleRescueSeconds, onlineSeconds],
    );
    await requeueRows(idle.rows, "idle");
    await client.query("COMMIT");
    return (stale.rowCount || 0) + (lost.rowCount || 0) + (idle.rowCount || 0);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function claimNextDbJob(user, workerName = "", options = {}) {
  const client = await db.connect();
  const workerLabel = String(workerName || "").trim().slice(0, 80) || "本机采集端";
  const kinds = Array.isArray(options.kinds)
    ? options.kinds.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 8)
    : [];
  const tokenStoreId = isScopedWorkerUser(user) ? String(user.tokenStoreId || "").trim() : "";
  // 超时任务重新领取 — 插件掉线后 claimed/running 任务在 reclaim 窗口内自动被续跑（对齐生产旧版机制）。
  // 守卫：
  //   ① 排除服务器侧收尾阶段（服务器 AI 审核/生成 Excel），避免 complete 处理中被抢单重复执行；
  //   ② 排除心跳仍新鲜的任务（该 job 的 current_job_id 心跳在 online 窗口内），避免抢活插件正在跑的任务。
  const reclaimMs = Math.max(60000, WORKER_JOB_RECLAIM_MS);
  const heartbeatOnlineMs = Math.max(30000, WORKER_ONLINE_WINDOW_MS);
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      `SELECT j.*
       FROM app_jobs j
       WHERE j.user_id = $1
         AND (cardinality($2::text[]) = 0 OR j.kind = ANY($2::text[]))
         AND ($3::uuid IS NULL OR j.store_id = $3::uuid)
         AND (
           j.status = 'queued'
           OR (
             j.kind = 'run'
             AND j.status IN ('claimed','running')
             AND COALESCE(j.processed, 0) < COALESCE(j.total, 0)
             AND j.updated_at < now() - ($4::int * interval '1 millisecond')
             AND NOT (j.phase LIKE '服务器%' OR j.phase LIKE '%生成 Excel%')
             AND NOT EXISTS (
               SELECT 1 FROM app_worker_heartbeats h
               WHERE h.user_id = j.user_id AND h.current_job_id = j.id
                 AND h.last_seen_at > now() - ($5::int * interval '1 millisecond')
             )
           )
         )
       ORDER BY
         CASE WHEN j.status = 'queued' THEN 0 ELSE 1 END,
         j.updated_at ASC,
         j.created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [user?.id || "", kinds, tokenStoreId || null, reclaimMs, heartbeatOnlineMs],
    );
    if (!selected.rowCount) {
      await client.query("COMMIT");
      return null;
    }
    const row = selected.rows[0];
    const logs = Array.isArray(row.logs) ? row.logs : [];
    const reclaimed = row.status !== "queued";
    if (reclaimed) {
      const processed = Number(row.processed || 0);
      const total = Number(row.total || 0);
      const nextText = total > 0 ? `第 ${Math.min(processed + 1, total)}/${total} 条` : "断点";
      logs.push(makeLogEntry(`${workerLabel} 已重新领取超时未推进任务，将从${nextText}继续。`, "warn"));
    } else {
      logs.push(makeLogEntry(`${workerLabel} 已领取任务。`));
    }
    const updated = await client.query(
      `UPDATE app_jobs
       SET status = 'claimed',
           phase = $3,
           logs = $2::jsonb,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [row.id, JSON.stringify(logs), reclaimed ? "采集端已重新领取，从断点继续" : "本机采集端已领取，等待开始采集"],
    );
    await client.query("COMMIT");
    return dbRowToJob(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function normalizeWorkerStatus(status) {
  const value = String(status || "").trim();
  return ["queued", "claimed", "running", "done", "error", "canceled"].includes(value) ? value : "";
}

function normalizeWorkerJobUpdate(input = {}, existing = {}) {
  const updates = {};
  const status = normalizeWorkerStatus(input.status);
  if (status) updates.status = status;
  if (input.phase !== undefined) updates.phase = String(input.phase || "").slice(0, 500);
  if (input.total !== undefined) updates.total = clampInt(input.total, 0, 999999, existing.total || 0);
  if (input.processed !== undefined) {
    const totalLimit = Number(updates.total ?? existing.total ?? 0);
    updates.processed = clampInt(input.processed, 0, totalLimit > 0 ? totalLimit : 999999, existing.processed || 0);
  }
  if (Array.isArray(input.logs)) {
    updates.logs = input.logs
      .filter((entry) => !/^实时进度：/.test(String(entry?.message || entry || "").trim()))
      .slice(-300)
      .map(normalizeLogEntryForDb);
  }
  if (Array.isArray(input.results)) updates.results = input.results.map(stripBuffers);
  if (input.error !== undefined) updates.error = String(input.error || "").slice(0, 2000);
  if (input.downloadUrl !== undefined) updates.downloadUrl = String(input.downloadUrl || "");
  return updates;
}

function normalizeLogEntryForDb(entry) {
  if (typeof entry === "string") return makeLogEntry(entry);
  return {
    at: entry?.at || new Date().toISOString(),
    level: ["info", "warn", "error"].includes(entry?.level) ? entry.level : "info",
    message: String(entry?.message || "").slice(0, 2000),
  };
}

async function saveWorkerArtifacts(id, kind, job, excelBase64) {
  if (!isSafeJobId(id)) throw new Error("任务 ID 不合法");
  const dir = path.join(JOBS_DIR, id);
  await ensureDir(dir);
  const shouldUseWorkerExcel = kind === "batch-ozon" && excelBase64;
  let downloadUrl = shouldUseWorkerExcel ? `/api/history/${id}/download` : "";
  const jobJson = {
    ...job,
    id,
    kind,
    downloadUrl,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(dir, "results.json"), JSON.stringify(serializeJob(jobJson), null, 2), "utf8");
  if (shouldUseWorkerExcel) {
    const excelName = kind === "batch-ozon" ? "ozon-batch-results.xlsx" : "ozon-1688-results.xlsx";
    await fs.writeFile(path.join(dir, excelName), Buffer.from(String(excelBase64), "base64"));
  } else if (kind !== "batch-ozon" && Array.isArray(jobJson.results)) {
    const artifactJob = {
      id,
      kind,
      status: jobJson.status || "done",
      phase: jobJson.phase || "已完成",
      total: jobJson.total || jobJson.results.length,
      processed: jobJson.processed || jobJson.results.length,
      logs: Array.isArray(jobJson.logs) ? jobJson.logs : [],
      results: jobJson.results,
      downloadUrl: "",
      cancelRequested: false,
    };
    await writeJobArtifacts(artifactJob);
    downloadUrl = artifactJob.downloadUrl || `/api/history/${id}/download`;
    jobJson.downloadUrl = downloadUrl;
    await fs.writeFile(path.join(dir, "results.json"), JSON.stringify(serializeJob(jobJson), null, 2), "utf8");
  }
  return downloadUrl;
}

async function getDbJobForUser(id, user) {
  const params = [id];
  let where = "j.id = $1";
  if (user?.role !== "admin") {
    params.push(user?.id || "");
    where += " AND j.user_id = $2";
  }
  if (isScopedWorkerUser(user)) {
    params.push(String(user.tokenStoreId || ""));
    where += ` AND j.store_id = $${params.length}`;
  }
  const result = await db.query(
    `SELECT j.*, u.username, u.display_name
     FROM app_jobs j
     LEFT JOIN app_users u ON u.id = j.user_id
     WHERE ${where}
     LIMIT 1`,
    params,
  );
  return dbRowToJob(result.rows[0]);
}

async function updateDbJob(id, updates = {}) {
  const assignments = [];
  const values = [];
  const add = (column, value, cast = "") => {
    values.push(value);
    assignments.push(`${column} = $${values.length}${cast}`);
  };
  if (updates.status !== undefined) add("status", updates.status);
  if (updates.phase !== undefined) add("phase", updates.phase);
  if (updates.processed !== undefined) add("processed", Number(updates.processed || 0));
  if (updates.total !== undefined) add("total", Number(updates.total || 0));
  if (updates.logs !== undefined) add("logs", JSON.stringify(updates.logs || []), "::jsonb");
  if (updates.results !== undefined) add("results", JSON.stringify(updates.results || []), "::jsonb");
  if (updates.error !== undefined) add("error", updates.error || "");
  if (updates.downloadUrl !== undefined) add("download_url", updates.downloadUrl || "");
  if (!assignments.length) return null;
  values.push(id);
  const result = await db.query(
    `UPDATE app_jobs SET ${assignments.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
    values,
  );
  return dbRowToJob(result.rows[0]);
}

async function clearWorkerCurrentJobRefs(jobId, phase = "任务已停止，等待插件刷新") {
  if (!db || !isSafeJobId(jobId)) return 0;
  const result = await db.query(
    `UPDATE app_worker_heartbeats
        SET current_job_id = NULL,
            current_phase = $2,
            last_seen_at = now()
      WHERE current_job_id = $1
      RETURNING worker_name`,
    [jobId, String(phase || "").slice(0, 200)],
  );
  return result.rowCount || 0;
}

async function loadDbJobHistory(user) {
  const params = [];
  let where = "TRUE";
  if (user?.role !== "admin") {
    params.push(user?.id || "");
    where = `j.user_id = $1`;
  }
  // v2.2.9.100: 不再 SELECT j.* — 大 results JSONB 逐个解析会让历史列表很慢。
  // 只拉展示所需列，result_count 用 SQL 端 jsonb_array_length 计算。
  const result = await db.query(
    `SELECT j.id, j.kind, j.status, j.phase, j.processed, j.total,
            j.source_total, j.source_start_row, j.download_url, j.last_downloaded_at,
            j.created_at, j.updated_at, j.payload,
            COALESCE(jsonb_array_length(j.results), 0) AS result_count,
            u.username, u.display_name
     FROM app_jobs j
     LEFT JOIN app_users u ON u.id = j.user_id
     WHERE ${where}
     ORDER BY j.updated_at DESC
     LIMIT 200`,
    params,
  );
  const items = result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    phase: row.phase || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    processed: Number(row.processed || 0),
    total: Number(row.total || 0),
    resultCount: Number(row.result_count || 0) || Number(row.processed || 0) || Number(row.total || 0),
    sourceStartRow: Number(row.source_start_row || 1),
    sourceTotal: Number(row.source_total || 0),
    firstRow: row.payload?.urlRows?.[0]?.sourceRow || "",
    lastRow: row.payload?.urlRows?.at?.(-1)?.sourceRow || "",
    firstUrl: row.payload?.urls?.[0] || row.payload?.sourceUrl || "",
    excelExists: Boolean(row.download_url),
    excelBytes: 0,
    downloadUrl: row.download_url || "",
    derived: false,
    owner: row.username ? {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name || row.username,
    } : null,
    lastDownloadedAt: row.last_downloaded_at || "",
  }));
  const todayKey = dateKeyInShanghai(new Date());
  const todayItems = items.filter((item) => dateKeyInShanghai(item.createdAt || item.updatedAt) === todayKey);
  return {
    today: {
      date: todayKey,
      rows: todayItems.reduce((sum, item) => sum + Number(item.processed || 0), 0),
      jobs: todayItems.length,
      doneJobs: todayItems.filter((item) => item.status === "done").length,
      downloads: todayItems.filter((item) => item.downloadUrl).length,
    },
    items,
  };
}

function getActiveJobById(jobId) {
  return jobs.get(jobId) || null;
}

function registerRuntimeJob(job) {
  if (job?.id) jobs.set(job.id, job);
  return job;
}

function unregisterRuntimeJob(jobId) {
  jobs.delete(jobId);
}

function stripBuffers(value) {
  if (Array.isArray(value)) return value.map(stripBuffers);
  if (!value || typeof value !== "object") return value;
  const copy = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "buffer") continue;
    copy[key] = stripBuffers(child);
  }
  return copy;
}

function parseUrlRows(text) {
  const rows = String(text || "").split(/\r?\n/);
  return rows.flatMap((row, index) => {
    const matches = row.match(/https?:\/\/[^\s,，;；"'<>]+/gi) || [];
    return matches
      .map((url) => url.trim())
      .filter((url) => /ozon\./i.test(url))
      .map((url) => ({ url, sourceRow: index + 1 }));
  });
}

function parseUrls(text) {
  return parseUrlRows(text).map((entry) => entry.url);
}

function parseFirstOzonUrl(text) {
  const rows = parseUrlRows(text);
  return rows[0]?.url ? normalizeOzonPageUrl(rows[0].url) : "";
}

function normalizeOzonPageUrl(value) {
  try {
    const url = new URL(String(value || ""), "https://www.ozon.ru");
    if (!/ozon\./i.test(url.hostname)) return "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function normalizeOzonProductUrl(value) {
  try {
    const url = new URL(String(value || ""), "https://www.ozon.ru");
    if (!/ozon\./i.test(url.hostname) || !/\/product\//i.test(url.pathname)) return "";
    url.hash = "";
    url.search = "";
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathname}`;
  } catch {
    return "";
  }
}

function normalizeBatchOzonFilters(filters = {}) {
  const normalizeNumber = (value) => {
    if (value === "" || value === null || value === undefined) return "";
    const number = Number(String(value).replace(",", "."));
    return Number.isFinite(number) ? number : "";
  };
  return {
    minPriceRmb: normalizeNumber(filters.minPriceRmb),
    maxPriceRmb: normalizeNumber(filters.maxPriceRmb),
    minSellerCount: normalizeNumber(filters.minSellerCount),
    maxSellerCount: normalizeNumber(filters.maxSellerCount),
    titleKeyword: String(filters.titleKeyword || "").trim(),
  };
}

function describeBatchOzonFilters(filters = {}) {
  return [
    filters.minPriceRmb !== "" ? `黑标价 >= ${filters.minPriceRmb}` : "",
    filters.maxPriceRmb !== "" ? `黑标价 <= ${filters.maxPriceRmb}` : "",
    filters.minSellerCount !== "" ? `跟卖数 >= ${filters.minSellerCount}` : "",
    filters.maxSellerCount !== "" ? `跟卖数 <= ${filters.maxSellerCount}` : "",
    filters.titleKeyword ? `标题包含“${filters.titleKeyword}”` : "",
  ].filter(Boolean).join("；");
}

function applyBatchOzonFilters(ozon = {}, filters = {}) {
  const reasons = [];
  const price = getOzonBestBlackPriceValue(ozon);
  const sellerCount = Number(ozon.sellerOfferCount);
  const title = String(ozon.title || "");

  if (filters.minPriceRmb !== "" || filters.maxPriceRmb !== "") {
    if (!Number.isFinite(price)) {
      reasons.push("未识别到可筛选黑标价");
    } else {
      if (filters.minPriceRmb !== "" && price < filters.minPriceRmb) reasons.push(`黑标价 ${formatNumberForSheet(price)} 低于 ${filters.minPriceRmb}`);
      if (filters.maxPriceRmb !== "" && price > filters.maxPriceRmb) reasons.push(`黑标价 ${formatNumberForSheet(price)} 高于 ${filters.maxPriceRmb}`);
    }
  }

  if (filters.minSellerCount !== "" || filters.maxSellerCount !== "") {
    if (!Number.isFinite(sellerCount)) {
      reasons.push("未识别到跟卖数量");
    } else {
      if (filters.minSellerCount !== "" && sellerCount < filters.minSellerCount) reasons.push(`跟卖数 ${sellerCount} 低于 ${filters.minSellerCount}`);
      if (filters.maxSellerCount !== "" && sellerCount > filters.maxSellerCount) reasons.push(`跟卖数 ${sellerCount} 高于 ${filters.maxSellerCount}`);
    }
  }

  if (filters.titleKeyword && !title.toLowerCase().includes(filters.titleKeyword.toLowerCase())) {
    reasons.push(`标题不包含“${filters.titleKeyword}”`);
  }

  return { passed: reasons.length === 0, reasons };
}

function getOzonDisplayPriceText(ozon = {}) {
  return formatOzonCnyForExport(ozon.currentGreenPriceCny || "") || getOzonBestBlackPriceText(ozon);
}

function getOzonBestBlackPriceValue(ozon = {}) {
  const values = [
    Number(ozon.currentBlackPriceCnyValue),
    Number(ozon.sellerLowestBlackPriceCnyValue),
    parseRmbNumber(ozon.currentBlackPriceCny),
    parseRmbNumber(ozon.sellerLowestBlackPriceCny),
  ].filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? Math.min(...values) : NaN;
}

function getOzonBestBlackPriceText(ozon = {}) {
  const price = getOzonBestBlackPriceValue(ozon);
  if (Number.isFinite(price)) return formatNumberForSheet(price);
  return formatOzonCnyForExport(ozon.currentBlackPriceCny || ozon.sellerLowestBlackPriceCny || "");
}

async function sendJobDownload(id, res) {
  if (!isSafeJobId(id)) {
    res.status(400).send("任务 ID 不合法");
    return;
  }
  const jsonPath = path.join(JOBS_DIR, id, "results.json");
  let kind = "";
  if (existsSync(jsonPath)) {
    try {
      kind = JSON.parse(await fs.readFile(jsonPath, "utf8")).kind || "";
    } catch {
      kind = "";
    }
  }
  const excelName = kind === "batch-ozon" ? "ozon-batch-results.xlsx" : "ozon-1688-results.xlsx";
  const downloadPrefix = kind === "batch-ozon" ? "ozon-batch" : "ozon-1688";
  const filePath = path.join(JOBS_DIR, id, excelName);
  if (existsSync(filePath) && kind !== "batch-ozon") {
    const shouldRepairImages = await singleSourcingExcelNeedsImageRepair(id, filePath, jsonPath).catch((error) => {
      console.warn(`[history-download] image repair precheck failed job=${id}: ${error.message}`);
      return false;
    });
    if (shouldRepairImages) {
      const repaired = await rebuildJobArtifactsFromLocalJson(id).catch((error) => {
        console.warn(`[history-download] local image repair failed job=${id}: ${error.message}`);
        return false;
      });
      if (!repaired) {
        await rebuildJobArtifactsFromDb(id).catch((error) => {
          console.warn(`[history-download] db image repair failed job=${id}: ${error.message}`);
          return false;
        });
      }
    }
  }
  if (!existsSync(filePath)) {
    const rebuilt = await rebuildJobArtifactsFromLocalJson(id).catch((error) => {
      console.warn(`[history-download] local rebuild failed job=${id}: ${error.message}`);
      return false;
    }) || await rebuildJobArtifactsFromDb(id).catch((error) => {
      console.warn(`[history-download] rebuild failed job=${id}: ${error.message}`);
      return false;
    });
    if (!rebuilt || !existsSync(filePath)) {
      res.status(404).send("文件不存在");
      return;
    }
  }
  await markJobDownloaded(id).catch(() => {});
  const shortId = id.length > 18 ? id.slice(0, 18) : id;
  res.download(filePath, `${downloadPrefix}-${shortId}.xlsx`);
}

function singleSourcingWorkbookHasEmbeddedMedia(filePath) {
  if (!filePath || !existsSync(filePath)) return false;
  try {
    return readFileSync(filePath).includes(Buffer.from("xl/media/"));
  } catch {
    return false;
  }
}

function jobResultsHaveRecoverableImageSources(job) {
  if (!job || !Array.isArray(job.results)) return false;
  return job.results.some((result) => {
    if (!result || result.error) return false;
    if (pickOzonImageUrl(result.ozon || {})) return true;
    if (hasUsableLocalImage(result.ozon?.mainImage)) return true;
    return (result.candidates || []).some((candidate) => pickCandidateImageUrl(candidate) || hasUsableLocalImage(candidate?.localImage));
  });
}

async function readJobArtifactJson(id) {
  if (!isSafeJobId(id)) return null;
  const jsonPath = path.join(JOBS_DIR, id, "results.json");
  if (!existsSync(jsonPath)) return null;
  try {
    return JSON.parse(await fs.readFile(jsonPath, "utf8"));
  } catch {
    return null;
  }
}

async function singleSourcingExcelNeedsImageRepair(id, excelPath, jsonPath = "") {
  if (!isSafeJobId(id) || !existsSync(excelPath)) return false;
  if (singleSourcingWorkbookHasEmbeddedMedia(excelPath)) return false;
  let job = null;
  if (jsonPath && existsSync(jsonPath)) {
    try {
      job = JSON.parse(await fs.readFile(jsonPath, "utf8"));
    } catch {
      job = null;
    }
  }
  job ||= await readJobArtifactJson(id);
  return jobResultsHaveRecoverableImageSources(job);
}

async function rebuildJobArtifactsFromLocalJson(id) {
  const job = await readJobArtifactJson(id);
  if (!job || !Array.isArray(job.results) || !job.results.length) return false;
  await writeJobArtifacts({
    ...job,
    id,
    kind: job.kind || "run",
    status: job.status || "done",
    phase: job.phase || "已完成",
    total: job.total || job.results.length,
    processed: job.processed || job.results.length,
    logs: Array.isArray(job.logs) ? job.logs : [],
    results: job.results,
    downloadUrl: job.downloadUrl || `/api/history/${id}/download`,
    cancelRequested: false,
  });
  return true;
}

async function rebuildJobArtifactsFromDb(id) {
  if (!db || !isSafeJobId(id)) return false;
  const result = await db.query(`SELECT * FROM app_jobs WHERE id = $1 LIMIT 1`, [id]);
  const job = dbRowToJob(result.rows[0]);
  if (!job || !Array.isArray(job.results) || !job.results.length) return false;
  await writeJobArtifacts({
    ...job,
    id,
    kind: job.kind || "run",
    status: job.status || "done",
    phase: job.phase || "已完成",
    total: job.total || job.results.length,
    processed: job.processed || job.results.length,
    logs: Array.isArray(job.logs) ? job.logs : [],
    results: job.results,
    downloadUrl: job.downloadUrl || `/api/history/${id}/download`,
    cancelRequested: false,
  });
  return true;
}

async function loadStoredJob(id) {
  if (!isSafeJobId(id)) return null;
  const jsonPath = path.join(JOBS_DIR, id, "results.json");
  if (!existsSync(jsonPath)) return null;
  try {
    const data = JSON.parse(await fs.readFile(jsonPath, "utf8"));
    const kind = data.kind === "batch-ozon" ? "batch-ozon" : data.kind || "run";
    const excelName = kind === "batch-ozon" ? "ozon-batch-results.xlsx" : "ozon-1688-results.xlsx";
    const excelPath = path.join(JOBS_DIR, id, excelName);
    return {
      ...data,
      id,
      kind,
      logs: Array.isArray(data.logs) ? data.logs.slice(-300) : [],
      results: Array.isArray(data.results) ? data.results.map(stripBuffers) : [],
      downloadUrl: data.downloadUrl || (existsSync(excelPath) ? `/api/history/${encodeURIComponent(id)}/download` : ""),
    };
  } catch {
    return null;
  }
}

async function loadJobHistory() {
  await ensureDir(JOBS_DIR);
  const entries = await fs.readdir(JOBS_DIR, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeJobId(entry.name)) continue;
    const dir = path.join(JOBS_DIR, entry.name);
    const jsonPath = path.join(dir, "results.json");
    if (!existsSync(jsonPath)) continue;
    try {
      const stat = await fs.stat(jsonPath);
      const data = JSON.parse(await fs.readFile(jsonPath, "utf8"));
      const excelName = data.kind === "batch-ozon" ? "ozon-batch-results.xlsx" : "ozon-1688-results.xlsx";
      const excelPath = path.join(dir, excelName);
      const excelExists = existsSync(excelPath);
      const excelStat = excelExists ? await fs.stat(excelPath) : null;
      const resultCount = Array.isArray(data.results) ? data.results.length : Number(data.processed || 0);
      const createdAt = data.createdAt || stat.birthtime?.toISOString?.() || stat.mtime.toISOString();
      const updatedAt = data.updatedAt || stat.mtime.toISOString();
      const derived = isDerivedHistoryJob(entry.name, data);
      items.push({
        id: entry.name,
        status: data.status || "",
        kind: data.kind || "run",
        phase: data.phase || "",
        createdAt,
        updatedAt,
        lastDownloadedAt: data.lastDownloadedAt || "",
        processed: Number(data.processed || resultCount || 0),
        total: Number(data.total || resultCount || 0),
        resultCount,
        sourceStartRow: data.sourceStartRow || "",
        sourceTotal: data.sourceTotal || "",
        firstRow: data.results?.[0]?.sourceRow || "",
        lastRow: data.results?.at?.(-1)?.sourceRow || "",
        firstUrl: data.results?.[0]?.url || "",
        excelExists,
        excelBytes: excelStat?.size || 0,
        downloadUrl: excelExists ? `/api/history/${encodeURIComponent(entry.name)}/download` : "",
        derived,
      });
    } catch {
      // Ignore malformed historical records so one bad file does not break the page.
    }
  }
  items.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const todayKey = dateKeyInShanghai(new Date());
  const todayRunnableItems = items.filter((item) => !item.derived && dateKeyInShanghai(item.createdAt || item.updatedAt) === todayKey);
  const todayRows = todayRunnableItems.reduce((sum, item) => sum + Number(item.resultCount || item.processed || 0), 0);
  const todayDoneJobs = todayRunnableItems.filter((item) => item.status === "done").length;
  const todayJobs = todayRunnableItems.length;
  const historyDownloads = items.filter((item) => item.excelExists);

  return {
    today: {
      date: todayKey,
      rows: todayRows,
      jobs: todayJobs,
      doneJobs: todayDoneJobs,
      downloads: historyDownloads.filter((item) => dateKeyInShanghai(item.updatedAt) === todayKey).length,
    },
    items: historyDownloads,
  };
}

async function markJobDownloaded(id) {
  if (!isSafeJobId(id)) return;
  if (db) {
    await db.query("UPDATE app_jobs SET last_downloaded_at = now(), updated_at = now() WHERE id = $1", [id]).catch(() => {});
  }
  const jsonPath = path.join(JOBS_DIR, id, "results.json");
  if (!existsSync(jsonPath)) return;
  const data = JSON.parse(await fs.readFile(jsonPath, "utf8"));
  data.lastDownloadedAt = new Date().toISOString();
  await fs.writeFile(jsonPath, JSON.stringify(data, null, 2), "utf8");
}

function isDerivedHistoryJob(id, data) {
  if (data.kind === "batch-ozon") return false;
  if (data.kind && data.kind !== "run") return true;
  if (id.startsWith("combined-") || /-first-\d+$/i.test(id)) return true;
  const logText = (data.logs || []).map((item) => item.message || "").join(" ");
  return /合并|前\s*\d+\s*条结果已生成|已生成/.test(`${data.phase || ""} ${logText}`);
}

function isSafeJobId(id) {
  return /^[\w.-]+$/.test(String(id || ""));
}

function dateKeyInShanghai(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getResultFailureReason(result) {
  if (result.skipped) return "";
  return [
    result.error ? `处理失败：${result.error}` : "",
    result.searchError ? `1688 搜索失败：${result.searchError}` : "",
  ].filter(Boolean).join("；");
}

function getCriticalStopReason(message) {
  const text = String(message || "");
  const rules = [
    [/没有拿到\s*1688\s*搜图\s*token|FAIL_SYS_TOKEN|_m_h5_tk|mtop.*token/i, "1688 登录状态或搜图 token 已失效，需要重新打开 1688 登录窗口。"],
    [/验证码等待超时|人机验证|滑块|验证码|captcha|verify|punish/i, "触发验证码或人机验证，需要人工处理后再继续。"],
    [/Target page, context or browser has been closed|browser has been closed|context.*closed|page.*closed/i, "自动化浏览器已关闭或崩溃，需要重新打开后再继续。"],
    [/登录|login|unauthorized|forbidden|403/i, "登录状态异常或访问被拒绝，需要检查账号状态。"],
    [/访问频繁|请求过于频繁|too many requests|rate.?limit|429|被限制|限制访问|封禁|封号|封\s*ip/i, "访问频率或账号/IP 状态异常，需要暂停后再处理。"],
  ];
  return rules.find(([pattern]) => pattern.test(text))?.[1] || "";
}

function stopJob(job, reason) {
  job.status = "error";
  job.error = reason;
  job.phase = "已自动停止";
  log(job, `任务已自动停止：${reason}`, "error");
  notifyUser("采集任务已自动停止", reason);
}

function log(job, message, level = "info") {
  const entry = { at: new Date().toISOString(), level, message };
  job.logs.push(entry);
  console.log(`[${entry.at}] [${level}] [${job.id}] ${message}`);
  touch(job);
}

function notifyUser(title, message) {
  if (process.platform !== "darwin") return;
  execFile("osascript", [
    "-e",
    `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Glass"`,
  ], () => {});
}

function touch(job) {
  job.updatedAt = new Date().toISOString();
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function randomInt(min, max) {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  return Math.floor(low + Math.random() * (high - low + 1));
}

function formatSeconds(ms) {
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}秒`;
}

function aiVerdictText(verdict) {
  return {
    exact: "完全一致",
    approximate: "近似",
    not_match: "不一致",
  }[verdict] || "";
}

function normalizeUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("//")) return `https:${text}`;
  return text;
}

function columnName(index) {
  let name = "";
  let current = index;
  while (current > 0) {
    const mod = (current - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    current = Math.floor((current - mod) / 26);
  }
  return name;
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function extensionFromContentType(contentType, url) {
  const lower = String(contentType || "").toLowerCase();
  if (lower.includes("png")) return "png";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("gif")) return "gif";
  const match = String(url).match(/\.(jpg|jpeg|png|webp|gif)(?:\?|$)/i);
  if (match) return match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  return "jpg";
}

async function writeXlsxWithEmbeddedImages(rows, excelPath, options = {}) {
  const useLogisticsTemplate = options.useLogisticsTemplate ?? existsSync(LOGISTICS_TEMPLATE_PATH);
  const discoveredHeaders = Array.from(rows.reduce((set, row) => {
    Object.keys(row)
      .filter((key) => !key.startsWith("_"))
      .forEach((key) => set.add(key));
    return set;
  }, new Set()));
  if (useLogisticsTemplate) {
    discoveredHeaders.push("盈亏", "利润率");
  }
  const preferredHeaders = options.preferredHeaders || [
    "Ozon图片",
    "1688图片",
    "原始行号",
    "AI最终结果",
    "匹配类型",
    "AI是否选中",
    "AI候选判断",
    "AI候选置信度",
    "AI候选原因",
    "疑似引流款",
    "引流款原因",
    "疑似优惠价",
    "优惠价原因",
    "优惠信息",
    "Ozon标题",
    "1688标题",
    "候选序号",
    "Ozon链接",
    "1688链接",
    "盈亏",
    "利润率",
    "Ozon价格",
    "Ozon产品黑标价RMB",
    "Ozon跟卖数量",
    "Ozon价格采集备注",
    "Ozon重量（克）",
    "Ozon重量来源",
    "Ozon重量依据",
    "AI估算重量（克）",
    "AI估算重量置信度",
    "AI估算重量依据",
    "1688价格",
    "1688价格明细",
    "按Ozon件数估算采购价RMB",
    "采购倍数",
    "Ozon件数核对",
    "Ozon件数",
    "Ozon件数依据",
    "1688销售件数",
    "1688件数依据",
    "最少起批",
    "1688运费",
    "1688尺寸",
    "1688重量（克）",
    "AI最终置信度",
    "AI最终原因",
    "AI模型",
    "AI思考模式",
    "AI耗时秒",
    "AI输入Tokens",
    "AI输出Tokens",
    "AI总Tokens",
    "AI估算费用USD",
    "1688详情采集状态",
    "1688图片下载状态",
    "Ozon属性",
    "Ozon描述",
    "Ozon主图链接",
    "1688图片链接",
    "本地主图文件",
    "Ozon错误",
    "1688搜索错误",
  ];
  if (!discoveredHeaders.length && options.preferredHeaders?.length) {
    discoveredHeaders.push(...options.preferredHeaders);
  }
  const headers = [
    ...preferredHeaders.filter((header) => discoveredHeaders.includes(header)),
    ...discoveredHeaders.filter((header) => !preferredHeaders.includes(header)),
  ];
  const imageColumns = options.imageColumns || new Map([
    ["Ozon图片", "_ozonImagePath"],
    ["1688图片", "_1688ImagePath"],
  ]);
  const images = [];
  const mediaFiles = {};

  for (const [rowIndex, row] of rows.entries()) {
    for (const [header, pathKey] of imageColumns.entries()) {
      const imagePath = row[pathKey];
      const colIndex = headers.indexOf(header) + 1;
      if (!imagePath || colIndex <= 0 || !existsSync(imagePath)) continue;
      try {
        const converted = await convertImageForUse(imagePath, "excel", { maxSide: 220, format: "PNG" });
        const mediaIndex = images.length + 1;
        const mediaName = `image${mediaIndex}.png`;
        mediaFiles[`xl/media/${mediaName}`] = await fs.readFile(converted);
        images.push({
          rowNumber: rowIndex + 2,
          colNumber: colIndex,
          mediaName,
          relId: `rId${mediaIndex}`,
        });
      } catch {
        // Keep spreadsheet generation resilient if a source image cannot be converted.
      }
    }
  }

  const sheetStyleMap = useLogisticsTemplate
    ? { default: 0, header: 1, highlight: 6, profit: 5, profitHighlight: 6, rate: 7, rateHighlight: 10, hasLogisticsMetrics: true }
    : { default: 0, header: 1, highlight: 2 };
  const files = useLogisticsTemplate
    ? await buildWorkbookFilesWithLogisticsTemplate(headers, rows, Boolean(images.length), mediaFiles, sheetStyleMap)
    : {
      "[Content_Types].xml": strToU8(buildContentTypesXml(Boolean(images.length))),
      "_rels/.rels": strToU8(buildRootRelsXml()),
      "xl/workbook.xml": strToU8(buildWorkbookXml()),
      "xl/_rels/workbook.xml.rels": strToU8(buildWorkbookRelsXml()),
      "xl/styles.xml": strToU8(buildStylesXml()),
      "xl/worksheets/sheet1.xml": strToU8(buildSheetXml(headers, rows, Boolean(images.length), sheetStyleMap)),
      ...mediaFiles,
    };

  if (images.length) {
    files["xl/worksheets/_rels/sheet1.xml.rels"] = strToU8(buildSheetRelsXml());
    files["xl/drawings/drawing1.xml"] = strToU8(buildDrawingXml(images));
    files["xl/drawings/_rels/drawing1.xml.rels"] = strToU8(buildDrawingRelsXml(images));
  }

  const zipped = zipSync(files, { level: 6 });
  await fs.writeFile(excelPath, Buffer.from(zipped));
}

async function buildWorkbookFilesWithLogisticsTemplate(headers, rows, hasImages, mediaFiles, sheetStyleMap) {
  const templateFiles = unzipSync(await fs.readFile(LOGISTICS_TEMPLATE_PATH));
  const files = {};
  for (const [name, content] of Object.entries(templateFiles)) {
    if (name.endsWith("/")) continue;
    if ([
      "[Content_Types].xml",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/worksheets/sheet1.xml",
    ].includes(name)) continue;
    files[name] = content;
  }
  if (files["xl/styles.xml"]) {
    files["xl/styles.xml"] = strToU8(addMainSheetMetricStyles(strFromU8(files["xl/styles.xml"])));
  }
  const templateSheetXml = strFromU8(templateFiles["xl/worksheets/sheet1.xml"]);
  const contentTypesXml = strFromU8(templateFiles["[Content_Types].xml"]);
  files["[Content_Types].xml"] = strToU8(addWorkbookContentTypes(contentTypesXml, hasImages));
  files["_rels/.rels"] = files["_rels/.rels"] || strToU8(buildRootRelsXml());
  files["xl/workbook.xml"] = strToU8(buildWorkbookXml(true));
  files["xl/_rels/workbook.xml.rels"] = strToU8(buildWorkbookRelsXml(true));
  files["xl/worksheets/sheet1.xml"] = strToU8(buildSheetXml(headers, rows, hasImages, sheetStyleMap));
  files["xl/worksheets/sheet2.xml"] = strToU8(fillLogisticsTemplateSheetXml(templateSheetXml, rows));
  Object.assign(files, mediaFiles);
  return files;
}

function buildSheetXml(headers, rows, hasImages, styleMap = { default: 0, header: 1, highlight: 2 }) {
  const lastColumn = columnName(headers.length);
  const lastRow = Math.max(rows.length + 1, 1);
  const cols = headers.map((header, index) => {
    const width = header === "Ozon图片" || header === "1688图片"
      ? 16
      : Math.min(Math.max(String(header).length + 6, 14), 42);
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
  }).join("");
  const headerRow = `<row r="1" ht="26" customHeight="1">${headers.map((header, index) =>
    buildCell(1, index + 1, header, styleMap.header),
  ).join("")}</row>`;
  const dataRows = rows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 2;
    const styleIndex = row._highlight === "yellow" ? styleMap.highlight : styleMap.default;
    const cells = headers.map((header, colIndex) => {
      const formula = buildMainSheetFormula(header, rowNumber, styleMap, row._highlight === "yellow");
      if (formula) {
        return buildFormulaCell(rowNumber, colIndex + 1, formula.formula, formula.styleIndex);
      }
      const value = header === "Ozon图片" || header === "1688图片" ? "" : row[header];
      return buildCell(rowNumber, colIndex + 1, value, styleIndex);
    }).join("");
    return `<row r="${rowNumber}" ht="92" customHeight="1">${cells}</row>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:${lastColumn}${lastRow}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>${cols}</cols>
  <sheetData>${headerRow}${dataRows}</sheetData>
  ${hasImages ? '<drawing r:id="rId1"/>' : ""}
</worksheet>`;
}

function buildMainSheetFormula(header, rowNumber, styleMap = {}, highlighted = false) {
  if (!styleMap.hasLogisticsMetrics) return null;
  if (header === "盈亏") {
    return {
      formula: `'头程物流测算'!M${rowNumber}`,
      styleIndex: highlighted ? styleMap.profitHighlight : styleMap.profit,
    };
  }
  if (header === "利润率") {
    return {
      formula: `'头程物流测算'!N${rowNumber}`,
      styleIndex: highlighted ? styleMap.rateHighlight : styleMap.rate,
    };
  }
  return null;
}

function buildCell(rowNumber, colNumber, value, styleIndex) {
  const ref = `${columnName(colNumber)}${rowNumber}`;
  const text = value === null || value === undefined ? "" : String(value);
  return `<c r="${ref}" s="${styleIndex}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

function buildFormulaCell(rowNumber, colNumber, formula, styleIndex) {
  const ref = `${columnName(colNumber)}${rowNumber}`;
  return `<c r="${ref}" s="${styleIndex}"><f>${escapeXml(formula)}</f></c>`;
}

function buildNumericCell(rowNumber, colNumber, value, styleIndex) {
  const ref = `${columnName(colNumber)}${rowNumber}`;
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return `<c r="${ref}" s="${styleIndex}"><v>${formatPriceNumber(number)}</v></c>`;
}

function fillLogisticsTemplateSheetXml(sheetXml, rows) {
  const templateRows = buildLogisticsTemplateRows(rows);
  const lastRow = templateRows.length + 1;
  const sheetData = [
    buildLogisticsHeaderRowXml(),
    ...templateRows.map((data, index) => buildLogisticsTemplateRowXml(index + 2, data)),
  ].join("");
  let xml = sheetXml.replace(/<dimension\b[^>]*\bref="[^"]*"[^>]*\/>/, `<dimension ref="A1:S${lastRow}"/>`);
  xml = xml.replace(/<cols>[\s\S]*?<\/cols>/, `<cols>${buildLogisticsColumnsXml()}</cols>`);
  xml = xml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${sheetData}</sheetData>`);
  return xml;
}

function buildLogisticsTemplateRows(rows) {
  return rows.map((row) => {
    const blackPrice = row._templateBlackPrice ?? parseRmbNumber(row["Ozon产品黑标价RMB"]);
    const weightGrams = row._templateWeightGrams || row["Ozon重量（克）"] || row["1688重量（克）"] || "";
    const alibabaCost = row._templateAlibabaCost || calculateAlibabaCost(row);
    return {
      skuId: row._templateSkuId || extractOzonProductId(row["Ozon链接"]),
      weightGrams: formatNumberForSheet(weightGrams),
      aiEstimatedWeightGrams: formatNumberForSheet(row._templateAiEstimatedWeightGrams || row["AI估算重量（克）"]),
      blackPrice: formatNumberForSheet(blackPrice),
      alibabaCost: formatNumberForSheet(alibabaCost),
    };
  });
}

function buildLogisticsColumnsXml() {
  const widths = [18, 12, 16, 12, 18, 12, 10, 8, 12, 10, 12, 12, 12, 12, 18, 14, 14, 8, 8];
  return widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
}

function buildLogisticsHeaderRowXml() {
  const headers = [
    "SkuId",
    "重量（克）",
    "AI估算重量（克）",
    "黑标价",
    "阿里巴巴采购价(预)",
    "头程物流费",
    "佣金",
    "贴单",
    "尾程物流",
    "广告费",
    "收单业务费",
    "总成本",
    "盈亏",
    "利润率",
    "ozon上架格式",
    "匹配组别",
    "计费重量(KG)",
  ];
  return `<row r="1">${headers.map((header, index) => buildCell(1, index + 1, header, 1)).join("")}${buildNumericCell(1, 18, 16, 1)}</row>`;
}

function buildLogisticsTemplateRowXml(rowNumber, data = {}) {
  const cells = [
    data.skuId ? buildCell(rowNumber, 1, data.skuId, 1) : "",
    data.weightGrams ? buildNumericCell(rowNumber, 2, data.weightGrams, 1) : "",
    data.aiEstimatedWeightGrams ? buildNumericCell(rowNumber, 3, data.aiEstimatedWeightGrams, 1) : "",
    data.blackPrice ? buildNumericCell(rowNumber, 4, data.blackPrice, 1) : "",
    data.alibabaCost ? buildNumericCell(rowNumber, 5, data.alibabaCost, 1) : "",
    buildFormulaCell(rowNumber, 6, logisticsFormula("F", rowNumber), 5),
    buildFormulaCell(rowNumber, 7, logisticsFormula("G", rowNumber), 5),
    buildFormulaCell(rowNumber, 8, logisticsFormula("H", rowNumber), 5),
    buildFormulaCell(rowNumber, 9, logisticsFormula("I", rowNumber), 5),
    `<c r="J${rowNumber}" s="5"/>`,
    buildFormulaCell(rowNumber, 11, logisticsFormula("K", rowNumber), 5),
    buildFormulaCell(rowNumber, 12, logisticsFormula("L", rowNumber), 5),
    buildFormulaCell(rowNumber, 13, logisticsFormula("M", rowNumber), 6),
    buildFormulaCell(rowNumber, 14, logisticsFormula("N", rowNumber), 7),
    buildFormulaCell(rowNumber, 15, logisticsFormula("O", rowNumber), 0),
    buildFormulaCell(rowNumber, 16, logisticsFormula("P", rowNumber), 0),
    buildFormulaCell(rowNumber, 17, logisticsFormula("Q", rowNumber), 8),
    rowNumber === 2 ? buildNumericCell(rowNumber, 19, 11, 1) : "",
  ].join("");
  return `<row r="${rowNumber}">${cells}</row>`;
}

function logisticsFormula(column, rowNumber) {
  const r = rowNumber;
  const weightKg = `IF(TRIM(B${r}&"")="",IFERROR(VALUE(C${r})/1000,0),IFERROR(VALUE(B${r})/1000,0))`;
  const rubValue = `IFERROR(VALUE(D${r})*$S$2,0)`;
  const volumeKg = `(20*20*20/12000)`;
  const formulas = {
    F: `IF(OR(AND(TRIM(B${r}&"")="",TRIM(C${r}&"")=""),TRIM(D${r}&"")=""),"",IF(P${r}="无法匹配","无法匹配",IF(P${r}="Extra Small",ROUND(Q${r}*28.1+3.37,2),IF(P${r}="Budget",ROUND(Q${r}*19.1+25.83,2),IF(P${r}="Small",ROUND(Q${r}*28.1+17.97,2),IF(P${r}="Big",ROUND(Q${r}*19.1+40.44,2),IF(P${r}="Premium Small",ROUND(Q${r}*28.1+24.71,2),IF(P${r}="Premium Big",ROUND(Q${r}*25.8+69.64,2),""))))))))`,
    G: `IF(TRIM(D${r}&"")="","",ROUND(IFERROR(VALUE(D${r}),0)*IF(${rubValue}<1500,12%,20%),2))`,
    H: `IF(TRIM(D${r}&"")="","",3)`,
    I: `IF(TRIM(D${r}&"")="","",ROUND(IFERROR(VALUE(D${r}),0)*2%,2))`,
    K: `IF(TRIM(D${r}&"")="","",ROUND(IFERROR(VALUE(D${r}),0)*2%,2))`,
    L: `IF(TRIM(D${r}&"")="","",IF(F${r}="无法匹配",F${r},ROUND(IFERROR(VALUE(E${r}),0)+N(F${r})+N(G${r})+N(H${r})+N(I${r})+IFERROR(VALUE(J${r}),0)+N(K${r}),2)))`,
    M: `IF(TRIM(D${r}&"")="","",IF(F${r}="无法匹配",F${r},ROUND(IFERROR(VALUE(D${r}),0)-L${r},2)))`,
    N: `IF(TRIM(D${r}&"")="","",IF(F${r}="无法匹配","",IF(IFERROR(VALUE(D${r}),0)=0,"",M${r}/IFERROR(VALUE(D${r}),0))))`,
    O: `IF(OR(TRIM(A${r}&"")="",TRIM(D${r}&"")=""),"",A${r}&","&ROUND(IFERROR(VALUE(D${r}),0)*2,0))`,
    P: `IF(OR(AND(TRIM(B${r}&"")="",TRIM(C${r}&"")=""),TRIM(D${r}&"")=""),"",IF(AND(${rubValue}<=1500,${weightKg}<=0.5),"Extra Small",IF(AND(${rubValue}<=1500,${weightKg}>0.5,${weightKg}<=25),"Budget",IF(AND(${rubValue}>1500,${rubValue}<=7000,${weightKg}<=2),"Small",IF(AND(${rubValue}>1500,${rubValue}<=7000,${weightKg}>2,${weightKg}<=30,MAX(${weightKg},${volumeKg})<=31),"Big",IF(AND(${rubValue}>7000,${rubValue}<=250000,${weightKg}<=5),"Premium Small",IF(AND(${rubValue}>7000,${rubValue}<=250000,${weightKg}>5,${weightKg}<=30,MAX(${weightKg},${volumeKg})<=31),"Premium Big","无法匹配")))))))`,
    Q: `IF(P${r}="","",IF(P${r}="无法匹配","",ROUND(IF(OR(P${r}="Big",P${r}="Premium Big"),MAX(${weightKg},${volumeKg}),${weightKg}),3)))`,
  };
  return formulas[column] || "";
}

function calculateAlibabaCost(row) {
  const price = parseRmbNumber(row["1688价格"]);
  if (price === null) return "";
  const shipping = parseRmbNumber(row["1688运费"]);
  if (shipping === null) return "";
  return Number((price + shipping).toFixed(2));
}

function addMainSheetMetricStyles(stylesXml) {
  const highlightedPercentStyle = '<xf numFmtId="10" fontId="0" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"/>';
  if (stylesXml.includes(highlightedPercentStyle)) return stylesXml;
  return stylesXml.replace(/<cellXfs\b([^>]*)count="(\d+)"([^>]*)>([\s\S]*?)<\/cellXfs>/, (_match, before, countText, after, inner) => {
    const count = Number(countText);
    const nextCount = Number.isFinite(count) ? count + 1 : countText;
    return `<cellXfs${before}count="${nextCount}"${after}>${inner}${highlightedPercentStyle}</cellXfs>`;
  });
}

function addWorkbookContentTypes(contentTypesXml, hasImages) {
  let xml = contentTypesXml;
  const ensureBeforeEnd = (snippet) => {
    if (!xml.includes(snippet)) xml = xml.replace("</Types>", `${snippet}</Types>`);
  };
  ensureBeforeEnd('<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>');
  if (hasImages) {
    if (!/<Default\s+Extension="png"/i.test(xml)) {
      xml = xml.replace("</Types>", '<Default Extension="png" ContentType="image/png"/></Types>');
    }
    ensureBeforeEnd('<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>');
  }
  return xml;
}

function buildDrawingXml(images) {
  const anchors = images.map((image, index) => {
    const col = image.colNumber - 1;
    const row = image.rowNumber - 1;
    return `<xdr:twoCellAnchor editAs="oneCell">
  <xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>90000</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>90000</xdr:rowOff></xdr:from>
  <xdr:to><xdr:col>${col + 1}</xdr:col><xdr:colOff>90000</xdr:colOff><xdr:row>${row + 1}</xdr:row><xdr:rowOff>90000</xdr:rowOff></xdr:to>
  <xdr:pic>
    <xdr:nvPicPr><xdr:cNvPr id="${index + 1}" name="Picture ${index + 1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>
    <xdr:blipFill><a:blip r:embed="${image.relId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
    <xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
  </xdr:pic>
  <xdr:clientData/>
</xdr:twoCellAnchor>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`;
}

function buildContentTypesXml(hasImages) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${hasImages ? '<Default Extension="png" ContentType="image/png"/>' : ""}
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${hasImages ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : ""}
</Types>`;
}

function buildRootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}

function buildWorkbookXml(hasLogisticsTemplate = false) {
  const sheets = hasLogisticsTemplate
    ? '<sheets><sheet name="Ozon-1688" sheetId="1" r:id="rId1"/><sheet name="头程物流测算" sheetId="2" r:id="rId2"/></sheets>'
    : '<sheets><sheet name="Ozon-1688" sheetId="1" r:id="rId1"/></sheets>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  ${sheets}
</workbook>`;
}

function buildWorkbookRelsXml(hasLogisticsTemplate = false) {
  if (hasLogisticsTemplate) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function buildSheetRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`;
}

function buildDrawingRelsXml(images) {
  const rels = images.map((image) =>
    `<Relationship Id="${image.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${image.mediaName}"/>`,
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
}

function buildStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts>
  <fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEFF3EF"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="1"><border><left style="thin"><color rgb="FFB7B7B7"/></left><right style="thin"><color rgb="FFB7B7B7"/></right><top style="thin"><color rgb="FFB7B7B7"/></top><bottom style="thin"><color rgb="FFB7B7B7"/></bottom></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3"><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="49" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="49" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>
</styleSheet>`;
}

async function convertImageForUse(filePath, purpose, options = {}) {
  const maxSide = String(options.maxSide || 768);
  const format = options.format || "PNG";
  const quality = String(options.quality || 82);
  const ext = format.toLowerCase() === "jpeg" ? "jpg" : "png";
  const outputPath = `${filePath}.${purpose}.${ext}`;
  if (existsSync(outputPath)) return outputPath;
  const code = `
from PIL import Image
import sys
src, dst, max_side, fmt, quality = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4], int(sys.argv[5])
im = Image.open(src)
im.thumbnail((max_side, max_side))
if fmt.upper() == "JPEG":
    if im.mode not in ("RGB", "L"):
        im = im.convert("RGB")
    im.save(dst, "JPEG", quality=quality, optimize=True)
else:
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGBA")
    im.save(dst, "PNG", optimize=True)
`;
  await execFileAsync(PYTHON_BIN, ["-c", code, filePath, outputPath, maxSide, format, quality], {
    timeout: 30000,
  });
  return outputPath;
}

function formatCellForFile(value) {
  const text = String(value ?? "");
  const escaped = escapeHtmlForFile(text).replace(/\n/g, "<br>");
  if (/^https?:\/\//i.test(text)) {
    return `<td><a href="${escapeHtmlForFile(text)}">${escaped}</a></td>`;
  }
  return `<td>${escaped}</td>`;
}

function escapeHtmlForFile(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function loadLocalEnv() {
  for (const name of [".env", ".env.build"]) {
    const envPath = path.join(__dirname, name);
    if (!existsSync(envPath)) continue;
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (name === ".env.build" && key === "BUILD_VERSION") process.env[key] = value;
      else if (!process.env[key]) process.env[key] = value;
    }
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function ensureWritableDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  await fs.access(dir, fsConstants.W_OK);
  return dir;
}

async function ensureUploadDir() {
  return ensureWritableDir(path.join(PUBLIC_DIR, "uploads"));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await ensureDir(DATA_DIR);
await ensureDir(JOBS_DIR);
try {
  await ensureUploadDir();
} catch (e) {
  console.warn(`[uploads] 目录不可写，图片上传/水印会失败: ${e.message}`);
}
await initDatabase();
if (db && OZON_OPPORTUNITY_REFRESH_INTERVAL_MS > 0) {
  setTimeout(() => maybeRefreshOzonOpportunityPool("startup"), 12000).unref?.();
  setInterval(() => maybeRefreshOzonOpportunityPool("interval"), OZON_OPPORTUNITY_REFRESH_INTERVAL_MS).unref?.();
}

// SPA catch-all
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

if (process.argv[1] === __filename) {
  const finalPort = parseInt(process.env.PORT || "5177");
  app.listen(finalPort, "0.0.0.0", () => {
    console.log(`Ozon to 1688 tool running at http://0.0.0.0:${finalPort}`);
  });
}

export {
  applyAiReview,
  getBrowserContext,
  registerRuntimeJob,
  reviewCandidatesWithMiniMax,
  runBatchOzonJob,
  runJob,
  scrapeOzonProduct,
  unregisterRuntimeJob,
  writeJobArtifacts,
};

export {
  writeXlsxWithEmbeddedImages,
};
