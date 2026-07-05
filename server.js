import express from "express";
import { chromium } from "playwright";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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
const MINIMAX_IMAGE_MODEL = process.env.MINIMAX_IMAGE_MODEL || "image-01";
const MINIMAX_IMAGE_INPUT_USD_PER_M = Number(process.env.MINIMAX_IMAGE_INPUT_USD_PER_M || 0.30);
const MINIMAX_IMAGE_OUTPUT_USD_PER_M = Number(process.env.MINIMAX_IMAGE_OUTPUT_USD_PER_M || 1.20);
const MINIMAX_IMAGE_PER_IMAGE_USD = Number(process.env.MINIMAX_IMAGE_PER_IMAGE_USD || 0.03);
const DEFAULT_DELAY_MIN_MS = Number(process.env.DEFAULT_DELAY_MIN_MS || 8000);
const DEFAULT_DELAY_MAX_MS = Number(process.env.DEFAULT_DELAY_MAX_MS || 20000);
const DETAIL_DELAY_MIN_MS = Number(process.env.DETAIL_DELAY_MIN_MS || 2500);
const DETAIL_DELAY_MAX_MS = Number(process.env.DETAIL_DELAY_MAX_MS || 6500);
const DETAIL_BROWSE_MODE = process.env.DETAIL_BROWSE_MODE || "balanced";
const DEFAULT_MAX_CONSECUTIVE_FAILURES = Number(process.env.DEFAULT_MAX_CONSECUTIVE_FAILURES || 3);
const DISABLE_SERVER_SCRAPER = /^(1|true|yes)$/i.test(process.env.DISABLE_SERVER_SCRAPER || "");
const DATABASE_URL = process.env.DATABASE_URL || "";
const INITIAL_USERS = process.env.INITIAL_USERS || "";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString("hex");
const AUTH_COOKIE = "ozon_auth";
const AUTH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const app = express();
const jobs = new Map();
const db = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;
let browserContext = null;
let browserOpening = null;
let currentBrowserHeadless = false;

app.use((req, res, next) => {
  const origin = String(req.headers.origin || "");
  const isExtensionOrigin = /^chrome-extension:\/\//.test(origin);
  const isTrustedWebOrigin = /^https?:\/\/(xm|test)\.renwz\.cn$/i.test(origin) || /^https?:\/\/localhost:\d+$/i.test(origin);
  if (isExtensionOrigin || isTrustedWebOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Worker-Name");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
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

function safeEqual(left, right) {
  const leftBuffer = Buffer.isBuffer(left) ? left : Buffer.from(String(left));
  const rightBuffer = Buffer.isBuffer(right) ? right : Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function getAuthenticatedUser(req) {
  const bearerToken = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const token = bearerToken || parseCookies(req)[AUTH_COOKIE] || "";
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

    CREATE INDEX IF NOT EXISTS idx_app_jobs_user_updated ON app_jobs(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_app_jobs_status_updated ON app_jobs(status, updated_at DESC);
  `);
  await seedInitialUsers();
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

app.use(express.json({ limit: process.env.JSON_LIMIT || "120mb" }));
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

app.post("/api/extension/login", async (req, res, next) => {
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
      res.json({
        success: true,
        token: createAuthToken(user.id),
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
    res.json({ success: true, token: createAuthToken("legacy"), user: { id: "legacy", username: "admin", role: "admin" } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", (req, res) => {
  clearAuthCookie(req, res);
  res.json({ success: true });
});
app.use(requireAuth);
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

async function callOzonSellerAPI(path, body, { method = "POST" } = {}) {
  if (!OZON_SELLER_CLIENT_ID || !OZON_SELLER_API_KEY) {
    const error = new Error("服务端没有配置 OZON_SELLER_CLIENT_ID / OZON_SELLER_API_KEY，请到 .env 里填写。");
    error.statusCode = 503;
    throw error;
  }
  const response = await fetch(`${OZON_SELLER_BASE_URL}${path}`, {
    method,
    headers: {
      "Client-Id": OZON_SELLER_CLIENT_ID,
      "Api-Key": OZON_SELLER_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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

app.post("/api/seller/analytics/categories", async (req, res, next) => {
  try {
    const range = String(req.query.range || req.body?.range || "30");
    const days = Math.min(365, Math.max(1, Number(range)));
    const dimension = String(req.query.dimension || req.body?.dimension || "category1");
    const now = new Date();
    const since = new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString();
    const to = now.toISOString();
    const data = await callOzonSellerAPI("/v1/analytics/data", {
      date_from: since, date_to: to,
      metrics: ["revenue", "ordered_units", "returns", "delivered_units", "cancellations"],
      dimension: [dimension],
      limit: 200,
    });
    res.json({ success: true, data, range: days, dimension });
  } catch (error) { res.status(error.statusCode || 502).json({ success: false, error: error.message, payload: error.payload || null }); }
});

app.get("/api/seller/dashboard", async (req, res, next) => {
  try {
    const today = (db ? await loadDbJobHistory(req.user) : await loadJobHistory()).today || {};
    let products = { total: null, archived: null };
    let orders = { total: null, awaiting: null, awaiting_packaging: null, awaiting_deliver: null, delivering: null, delivered: null, cancelled: null };
    let recentJobs = [];
    try {
      const data = await callOzonSellerAPI("/v3/product/list", { filter: { visibility: "ALL" }, limit: 1 });
      const items = data?.result?.items || [];
      const total = Number(data?.result?.total || 0);
      const archived = items.filter((it) => it.archived).length;
      products = { total, archived, toModify: 0, lowStock: 0 };
    } catch (e) { products = { total: null, archived: null, toModify: null, lowStock: null, error: e.message }; }
    try {
      const since = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
      const to = new Date().toISOString();
      const data = await callOzonSellerAPI("/v3/posting/fbs/list", { filter: { since, to }, limit: 100 });
      const items = data?.result?.postings || [];
      const byStatus = { awaiting_packaging: 0, awaiting_deliver: 0, delivering: 0, delivered: 0, cancelled: 0 };
      for (const p of items) { if (p.status in byStatus) byStatus[p.status] += 1; }
      const awaiting = byStatus.awaiting_packaging + byStatus.awaiting_deliver;
      orders = { total: items.length, awaiting, ...byStatus };
    } catch (e) { orders = { total: null, awaiting: null, error: e.message }; }
    if (db) {
      const rows = await db.query(
        "SELECT id, kind, status, phase, processed, total, updated_at FROM app_jobs WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 8",
        [req.user?.id || ""],
      );
      recentJobs = rows.rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, phase: r.phase, processed: r.processed, total: r.total, updatedAt: r.updated_at }));
    }
    res.json({ success: true, today, products, orders, recentJobs });
  } catch (error) { next(error); }
});

app.post("/api/seller/products", async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || req.body?.limit || 50)));
    const archived = String(req.query.archived || req.body?.archived || "false") === "true";
    const data = await callOzonSellerAPI("/v3/product/list", { filter: { visibility: "ALL" }, limit, archived });
    res.json({ success: true, data });
  } catch (error) { res.status(error.statusCode || 502).json({ success: false, error: error.message, payload: error.payload || null }); }
});

app.post("/api/seller/orders", async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || req.body?.limit || 50)));
    const status = String(req.query.status || req.body?.status || "").trim();
    const filter = {
      since: req.query.since || req.body?.since || new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
      to: req.query.to || req.body?.to || new Date().toISOString(),
    };
    if (status) filter.status = status;
    const data = await callOzonSellerAPI("/v3/posting/fbs/list", {
      filter,
      limit,
    });
    res.json({ success: true, data });
  } catch (error) { res.status(error.statusCode || 502).json({ success: false, error: error.message, payload: error.payload || null }); }
});

app.post("/api/seller/categories/tree", async (req, res, next) => {
  try {
    const data = await callOzonSellerAPI("/v1/description-category/tree", { language: "DEFAULT" });
    res.json({ success: true, data });
  } catch (error) { res.status(error.statusCode || 502).json({ success: false, error: error.message, payload: error.payload || null }); }
});

app.get("/api/seller/warehouses", async (_req, res, next) => {
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

app.post("/api/seller/products/stocks", async (req, res, next) => {
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

app.post("/api/seller/images/generate", async (req, res, next) => {
  try {
    const apiKey = process.env.MINIMAX_API_KEY;
    if (!apiKey) {
      res.status(503).json({ success: false, error: "未配置 MINIMAX_API_KEY（请在 .env 里填写）" });
      return;
    }
    const { prompt, image: refImage, aspectRatio = "3:4", n = 1, model: reqModel } = req.body || {};
    if (!prompt) {
      res.status(400).json({ success: false, error: "需要 prompt 字段" });
      return;
    }
    const body = {
      model: reqModel || MINIMAX_IMAGE_MODEL,
      prompt: String(prompt).slice(0, 2000),
      n: Math.min(8, Math.max(1, Number(n) || 1)),
      aspect_ratio: aspectRatio,
    };
    if (Array.isArray(refImage) && refImage.length) {
      body.image = refImage.slice(0, 4).map((u) => String(u));
    } else if (typeof refImage === "string" && refImage) {
      body.image = [refImage];
    }
    const response = await fetch(`${MINIMAX_BASE_URL}/image_generation`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch { payload = { raw: text.slice(0, 4000) }; }
    if (!response.ok) {
      res.status(response.status || 502).json({ success: false, error: `MiniMax 图生 ${response.status}：${text.slice(0, 500)}`, payload });
      return;
    }
    const urls = payload?.data?.image_urls || [];
    const usage = {
      model: payload?.model || body.model,
      promptTokens: (payload?.usage?.prompt_tokens || 0),
      totalTokens: (payload?.usage?.total_tokens || 0),
      images: urls.length,
      estimatedCostUsd: Number((urls.length * MINIMAX_IMAGE_PER_IMAGE_USD).toFixed(6)),
    };
    res.json({ success: true, data: { images: urls, prompt: body.prompt, aspectRatio, n: body.n, hasRefImage: Boolean(body.image) }, usage });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/seller/products/import", async (req, res, next) => {
  try {
    const item = req.body?.item;
    if (!item || typeof item !== "object") {
      res.status(400).json({ success: false, error: "请求体需要包含 item 字段（单个商品对象）。" });
      return;
    }
    if (!item.name || !item.sku || !item.category_id) {
      res.status(400).json({ success: false, error: "item 至少需要 name / sku / category_id 三个字段。" });
      return;
    }
    const data = await callOzonSellerAPI("/v3/products/import", { items: [item] });
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.statusCode || 502).json({ success: false, error: error.message, payload: error.payload || null });
  }
});

app.post("/api/jobs", async (req, res, next) => {
  if (DISABLE_SERVER_SCRAPER && !db) {
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
    const job = {
      id,
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: DISABLE_SERVER_SCRAPER ? "等待本机采集端领取" : "等待开始",
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
    jobs.set(id, job);

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
      enable1688: req.body.enable1688 !== false,
      enableAI: req.body.enableAI !== false,
      delayMinMs,
      delayMaxMs,
      maxConsecutiveFailures: clampInt(req.body.maxConsecutiveFailures, 1, 20, DEFAULT_MAX_CONSECUTIVE_FAILURES),
      headless: req.body.headless === true,
    };

    if (DISABLE_SERVER_SCRAPER && db) {
      const queued = await createQueuedDbJob(req.user, job, {
        urls,
        urlRows,
        options,
        raw: { urlsText: req.body.urlsText || "" },
      });
      res.json({ success: true, jobId: queued.id, queued: true });
      return;
    }

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
    if (db) {
      const job = await getDbJobForUser(req.params.id, req.user);
      if (!job) {
        res.status(404).json({ success: false, error: "任务不存在。" });
        return;
      }
      res.json({ success: true, job });
      return;
    }
    const job = jobs.get(req.params.id);
    if (!job) {
      const storedJob = await loadStoredJob(req.params.id);
      if (!storedJob) {
        res.status(404).json({ success: false, error: "任务不存在。" });
        return;
      }
      res.json({ success: true, job: storedJob });
      return;
    }
    res.json({ success: true, job: serializeJob(job) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/:id/cancel", async (req, res, next) => {
  try {
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
      await updateDbJob(req.params.id, {
        status: "canceled",
        phase: "已停止",
        logs: [...(job.logs || []), makeLogEntry("已请求停止，任务已取消。", "warn")],
      });
      res.json({ success: true });
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
    if (db && !(await getDbJobForUser(req.params.id, req.user))) {
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
    if (db && !(await getDbJobForUser(req.params.id, req.user))) {
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
    await upsertWorkerHeartbeat(req.user, workerName, {
      platform: req.body?.platform,
      hostname: req.body?.hostname,
      profileDir: req.body?.profileDir,
      currentPhase: req.body?.currentPhase || "本机采集端在线，可领取任务",
    });
    const job = await claimNextDbJob(req.user, workerName);
    if (job) {
      await upsertWorkerHeartbeat(req.user, workerName, {
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
    const workersResult = await db.query(
      `SELECT worker_name, platform, hostname, profile_dir, current_job_id, current_phase, last_seen_at
       FROM app_worker_heartbeats
       WHERE user_id = $1
       ORDER BY last_seen_at DESC
       LIMIT 10`,
      [req.user?.id || ""],
    );
    const queueResult = await db.query(
      `SELECT
         count(*) FILTER (WHERE status = 'queued')::int AS queued,
         count(*) FILTER (WHERE status IN ('claimed','running'))::int AS active
       FROM app_jobs
       WHERE user_id = $1`,
      [req.user?.id || ""],
    );
    const now = Date.now();
    const workers = workersResult.rows.map((row) => {
      const lastSeenAt = row.last_seen_at ? new Date(row.last_seen_at).toISOString() : "";
      const ageMs = lastSeenAt ? now - new Date(lastSeenAt).getTime() : Infinity;
      const currentPhase = row.current_phase || "";
      const canClaimJobs = !/预览版|暂不领取|不领取任务|未开启领取任务/i.test(currentPhase);
      return {
        workerName: row.worker_name,
        platform: row.platform || "",
        hostname: row.hostname || "",
        profileDir: row.profile_dir || "",
        currentJobId: row.current_job_id || "",
        currentPhase,
        canClaimJobs,
        lastSeenAt,
        online: ageMs <= Math.max(30000, WORKER_ONLINE_WINDOW_MS),
        ageSeconds: Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / 1000)) : null,
      };
    });
    res.json({
      success: true,
      workers,
      queue: queueResult.rows[0] || { queued: 0, active: 0 },
      onlineWindowSeconds: Math.round(Math.max(30000, WORKER_ONLINE_WINDOW_MS) / 1000),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/worker/heartbeat", async (req, res, next) => {
  try {
    if (!db) {
      res.status(409).json({ success: false, error: "服务器没有启用任务队列。" });
      return;
    }
    await upsertWorkerHeartbeat(req.user, req.body?.workerName || req.headers["x-worker-name"] || "", {
      platform: req.body?.platform,
      hostname: req.body?.hostname,
      profileDir: req.body?.profileDir,
      currentPhase: req.body?.currentPhase || "浏览器插件在线",
    });
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
    if (existing.status === "canceled") {
      res.json({ success: true, job: existing });
      return;
    }
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
    if (existing.status === "canceled") {
      res.json({ success: true, job: existing, downloadUrl: existing.downloadUrl || "" });
      return;
    }
    const job = req.body?.job && typeof req.body.job === "object" ? req.body.job : {};
    const kind = existing.kind === "batch-ozon" || job.kind === "batch-ozon" ? "batch-ozon" : "run";
    await processWorkerCompletionResults(job, existing);
    const downloadUrl = await saveWorkerArtifacts(req.params.id, kind, job, req.body?.excelBase64 || "");
    const updates = normalizeWorkerJobUpdate({ ...job, downloadUrl }, existing);
    updates.status = normalizeWorkerStatus(job.status) || "done";
    updates.downloadUrl = downloadUrl;
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
            result.candidates = searchResult.candidates.map((candidate) => annotateCandidateQuantity(candidate, result.ozon));
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
      const addImage = (bucket, urlValue, source, area = 0) => {
        const absolute = toAbs(urlValue);
        if (!absolute) return;
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
      moq: moqItem?.text || "1件起批",
      minOrderQuantity: moqItem?.text || "1件起批",
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
      const weightRaw = pick(
        firstScale[colMap.weight],
        firstScale.weight,
        packInfo.unitWeight,
        shipping.unitWeight,
        skuWeight,
        getAttr("重量", "克重", "毛重", "净重", "weight"),
      );
      const weightGrams = normalizeWeightGramsInPage(weightRaw);
      const weightText = weightGrams ? `${weightGrams} g` : "";

      const shippingFee = pick(
        freightInfo.totalCost,
        freightInfo.postFeeValue,
        shipping.totalCost,
        shipping.postFeeValue,
        getAttr("运费", "物流费用", "快递费"),
      );

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
        dimensionsText,
        weightText,
        weightGrams,
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
    dimensionsText: details.dimensionsText || candidate.dimensionsText || "",
    weightText: details.weightText || candidate.weightText || "",
    weightGrams: details.weightGrams || candidate.weightGrams || normalizeWeightGrams(details.weightText || candidate.weightText),
    priceDetails: details.priceDetails || candidate.priceDetails || "",
    promotionText: [candidate.promotionText, details.promotionText].filter(Boolean).join("；"),
    packQuantity,
    packQuantityEvidence,
    detailError: details.detailError || "",
  };
}

function addTrafficBaitAssessment(candidate) {
  const unitPriceRmb = extract1688MinimumTierUnitPrice(candidate.priceDetails || candidate.price);
  const values = extractRmbValues([
    candidate.price,
    candidate.priceDetails,
    candidate.minOrderQuantity,
    candidate.moq,
  ].join(" "));
  const positiveValues = values.filter((value) => value > 0).sort((a, b) => a - b);
  const minPriceRmb = positiveValues[0] ?? null;
  const maxPriceRmb = positiveValues[positiveValues.length - 1] ?? null;
  const hasVeryLowPrice = minPriceRmb !== null && minPriceRmb < LOW_PRICE_THRESHOLD_RMB;
  const hasLargeSpread = minPriceRmb !== null && maxPriceRmb !== null && maxPriceRmb >= 10 && maxPriceRmb / Math.max(minPriceRmb, 0.01) >= 10;
  const trafficBaitRisk = hasVeryLowPrice || hasLargeSpread;
  const promotionRisk = hasPromotionRisk(candidate);
  const reasons = [];
  if (hasVeryLowPrice) reasons.push(`出现低于 ¥${LOW_PRICE_THRESHOLD_RMB} 的价格`);
  if (hasLargeSpread) reasons.push("价格区间跨度异常大，可能是引流 SKU");
  const promotionReason = promotionRisk ? summarizePromotionReason(candidate.promotionText || candidate.price || candidate.priceDetails || candidate.title) : "";
  return {
    ...candidate,
    price: unitPriceRmb !== null ? formatPriceNumber(unitPriceRmb) : normalize1688PriceOnly(candidate.price || candidate.priceDetails),
    unitPriceRmb,
    minPriceRmb,
    maxPriceRmb,
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

function extract1688MinimumTierUnitPrice(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const tiers = [];
  const pattern = /(\d+)\s*(?:件|个|只|套|箱|包)?\s*起\s*[¥￥]?\s*(\d+(?:\.\d+)?)/g;
  for (const match of text.matchAll(pattern)) {
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

function isAvoidedCandidate(candidate) {
  return Boolean(candidate?.trafficBaitRisk);
}

function findBestFallbackCandidate(candidates = []) {
  return candidates.find((candidate) => !isAvoidedCandidate(candidate)) || null;
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
              "你是跨境电商货源匹配审核员。你的任务是在候选里给出一个最优货源：优先选择与 Ozon 商品同款、同功能、同外观、同关键规格的 exact；如果没有 exact，但有外观/功能/用途高度相近且可供人工复核的候选，选择 approximate；如果候选明显不相关或都是引流款，返回 none。同时根据商品标题、属性、尺寸、图片和候选信息估算单个 Ozon 销售单位的包装后重量（克）。首单减、新人价、券后价等只属于价格风险备注，不影响产品是否一致。只输出 JSON，不要输出 Markdown。",
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
  return candidates.map((candidate) => ({
    rank: candidate.rank,
    verdict: "approximate",
    confidence: 0,
    reason,
  }));
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
    shippingFee: candidate.shippingFee,
    dimensionsText: candidate.dimensionsText,
    weightText: candidate.weightText,
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
1. 优先找 exact：同款、同功能、同外观、同关键规格。
2. 如果没有 exact，可以选 approximate：图片/标题/用途高度相近，但存在颜色、套装、细节、规格、品牌不明等风险，需要人工复核。
3. 重量和尺寸只作为参考信息，不作为硬性一致条件；Ozon 和 1688 都可能乱标重量或尺寸。
4. Ozon 图片角落里的商家水印、平台贴纸、后期叠字（例如右下角 MAOLA 这类标记）不要当成品牌或产品本体；只有印在实物/包装上的标识才算产品特征。
5. 如果候选存在 trafficBaitRisk，通常视为 1688 引流款，不要选中；除非其他候选更差且它仍是最接近项，则只能作为 approximate，并明确写出引流风险。
6. promotionRisk 只代表价格可能依赖首单减、新人价、新客价、券后价、补贴、限时优惠等，属于采购价风险备注；它不能作为判断产品是否一致的依据，也不能因为 promotionRisk 把 exact 降级成 approximate 或 none。
7. 必须核对 Ozon 标题、属性和图片中是否写了多件/套装/pack/pcs/шт 等数量。若 Ozon 是多件一起卖，而 1688 候选是单件或较少件数，不能把单件价当成 Ozon 一套的采购价；需要按 purchaseMultiplier 或你从图片识别到的数量倍数计算，并在 reason 里说明数量风险。
8. 只返回一个 selected_rank。若所有候选都明显不相关、数量无法合理对应或都是引流款，decision 返回 "none"，selected_rank 返回 null。
9. 需要估算 Ozon 当前销售单位的包装后重量，单位为克。优先参考明确尺寸、材质、件数、同类商品常见重量和图片体积感；Ozon/1688 抓到的重量只作为参考，发现明显异常时不要盲信。估算不确定时仍给出合理区间里的中位估计，并降低 estimated_weight_confidence。

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
    return {
      ...candidate,
      aiVerdict: review?.verdict || "approximate",
      aiConfidence: review?.confidence ?? 0,
      aiReason: review?.reason || "",
      aiSelected: result.aiReview.decision !== "none" && Number(result.aiReview.selected_rank) === Number(candidate.rank),
    };
  });
  result.selectedCandidate = chooseFinalCandidate(result);
  if (result.selectedCandidate) {
    result.selectedCandidate.aiSelected = true;
    result.selectedCandidate = applyAiQuantityToSelectedCandidate(result);
  }
}

function chooseFinalCandidate(result) {
  const selected = result.candidates.find((candidate) => candidate.aiSelected);
  if (selected && !isAvoidedCandidate(selected)) return markFinalCandidate(selected, result.aiReview.decision, result.aiReview.reason);

  const reviews = new Map((result.aiReview?.candidate_reviews || []).map((item) => [Number(item.rank), item]));
  const reviewedCandidates = result.candidates
    .map((candidate) => ({ candidate, review: reviews.get(Number(candidate.rank)) }))
    .sort((a, b) => (Number(b.review?.confidence) || 0) - (Number(a.review?.confidence) || 0));
  const exact = reviewedCandidates.find(({ candidate, review }) => !isAvoidedCandidate(candidate) && review?.verdict === "exact");
  if (exact) {
    return markFinalCandidate(exact.candidate, "exact", exact.review?.reason || "AI 选中的候选存在促销/引流风险，改选非促销的完全一致候选。");
  }
  const approximate = reviewedCandidates.find(({ candidate, review }) => !isAvoidedCandidate(candidate) && review?.verdict === "approximate") ||
    reviewedCandidates.find(({ candidate, review }) => !isAvoidedCandidate(candidate) && review?.verdict !== "not_match");
  if (approximate) {
    return markFinalCandidate(approximate.candidate, "approximate", result.aiReview?.reason || approximate.review?.reason || "没有完全一致候选，返回最接近项。");
  }
  const fallback = findBestFallbackCandidate(result.candidates);
  if (fallback) {
    return markFinalCandidate(fallback, "approximate", "没有完全一致候选，返回最靠前的非引流/非促销候选供人工确认。");
  }
  return null;
}

function markFinalCandidate(candidate, matchType, reason) {
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
  let converted = filePath;
  try {
    converted = await convertImageForUse(filePath, "ai", { maxSide: 768, format: "JPEG", quality: 82 });
  } catch (error) {
    console.warn(`[ai-image] image conversion failed, using original: ${error.message}`);
  }
  const buffer = await fs.readFile(converted);
  const ext = path.extname(converted).toLowerCase();
  const contentType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${contentType};base64,${buffer.toString("base64")}`;
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
  const jsonPath = path.join(dir, "results.json");
  await fs.writeFile(jsonPath, JSON.stringify(serializeJob(job), null, 2), "utf8");

  const rows = [];
  for (const result of job.results) {
    const ozon = result.ozon || {};
    const fallbackCandidate = findBestFallbackCandidate(result.candidates || []);
    const finalCandidate = result.selectedCandidate ||
      (fallbackCandidate ? markFinalCandidate(fallbackCandidate, "approximate", "未进行 AI 最终选择，返回候选中最靠前的非引流/非促销结果供人工确认。") : null);
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
      "Ozon主图链接": ozon.mainImageUrl || "",
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
    const attrs = Object.entries(ozon.attributes || {})
      .slice(0, 20)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");
    if (attrs) base["Ozon属性"] = attrs;

    if (finalCandidate) {
      const candidate = finalCandidate;
      const unitPriceForExport = Number(normalize1688PriceOnly(candidate.priceDetails || candidate.price));
      const shippingFeeForExport = parseRmbNumber(candidate.shippingFee);
      const candidateWeightGrams = formatNumberForSheet(candidate.weightGrams || normalizeWeightGrams(candidate.weightText));
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
        "1688运费": candidate.shippingFee,
        "1688尺寸": candidate.dimensionsText,
        "1688重量（克）": candidateWeightGrams,
        "1688图片": "",
        "1688链接": candidate.link,
        "1688图片链接": candidate.image,
        "疑似引流款": candidate.trafficBaitRisk ? "是" : "",
        "引流款原因": candidate.trafficBaitReason || "",
        "疑似优惠价": candidate.promotionRisk ? "是" : "",
        "优惠价原因": candidate.promotionReason || "",
        "优惠信息": candidate.promotionText || "",
        "_templateSkuId": extractOzonProductId(result.url || ozon.sourceUrl || ""),
        "_templateWeightGrams": ozonWeightGrams || candidateWeightGrams,
        "_templateAiEstimatedWeightGrams": aiEstimatedWeightGrams,
        "_templateBlackPrice": parseRmbNumber(ozonBlackPrice) ?? "",
        "_templateAlibabaCost": Number.isFinite(unitPriceForExport) && unitPriceForExport > 0
          ? Number((unitPriceForExport + (shippingFeeForExport ?? 0)).toFixed(2))
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
    const attrs = Object.entries(ozon.attributes || {})
      .slice(0, 20)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");
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
      "Ozon主图链接": ozon.mainImageUrl || "",
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
    logs: job.logs.slice(-300),
    results: job.results.map(stripBuffers),
    cancelRequested: undefined,
  };
}

function makeLogEntry(message, level = "info") {
  return { at: new Date().toISOString(), level, message };
}

function dbRowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
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
  const result = await db.query(
    `INSERT INTO app_jobs (
      id, user_id, kind, status, phase, total, processed, source_total, source_start_row,
      payload, logs, results, error, download_url, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9,
      $10::jsonb, $11::jsonb, '[]'::jsonb, '', '', now(), now()
    )
    RETURNING *`,
    [
      job.id,
      user?.id || null,
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

async function claimNextDbJob(user, workerName = "") {
  const client = await db.connect();
  const workerLabel = String(workerName || "").trim().slice(0, 80) || "本机采集端";
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      `SELECT j.*
       FROM app_jobs j
       WHERE j.user_id = $1 AND j.status = 'queued'
       ORDER BY j.created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [user?.id || ""],
    );
    if (!selected.rowCount) {
      await client.query("COMMIT");
      return null;
    }
    const row = selected.rows[0];
    const logs = Array.isArray(row.logs) ? row.logs : [];
    logs.push(makeLogEntry(`${workerLabel} 已领取任务。`));
    const updated = await client.query(
      `UPDATE app_jobs
       SET status = 'claimed',
           phase = '本机采集端已领取，等待开始采集',
           logs = $2::jsonb,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [row.id, JSON.stringify(logs)],
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
  if (input.processed !== undefined) updates.processed = clampInt(input.processed, 0, 999999, existing.processed || 0);
  if (input.total !== undefined) updates.total = clampInt(input.total, 0, 999999, existing.total || 0);
  if (Array.isArray(input.logs)) updates.logs = input.logs.slice(-300).map(normalizeLogEntryForDb);
  if (Array.isArray(input.results)) updates.results = input.results.map(stripBuffers);
  if (input.error !== undefined) updates.error = String(input.error || "").slice(0, 2000);
  if (input.downloadUrl !== undefined) updates.downloadUrl = String(input.downloadUrl || "");
  return updates;
}

async function processWorkerCompletionResults(job, existing = {}) {
  if (!job || existing.kind === "batch-ozon" || job.kind === "batch-ozon") return;
  if (!Array.isArray(job.results) || !job.results.length) return;
  await hydrateWorkerResultImages(job);
  const options = existing.payload?.options || {};
  if (options.enableAI === false) return;
  for (const result of job.results) {
    if (!result?.ozon || !Array.isArray(result.candidates) || !result.candidates.length || result.aiReview) continue;
    try {
      result.aiReview = await reviewCandidatesWithMiniMax(result.ozon, result.candidates);
      applyAiReview(result);
      result.logs = Array.isArray(result.logs) ? result.logs : [];
      job.logs = Array.isArray(job.logs) ? job.logs : [];
      job.logs.push(makeLogEntry(`AI 已审核第 ${result.sourceRow || job.results.indexOf(result) + 1} 条，结果：${result.aiReview.decision || "none"}。`));
    } catch (error) {
      result.aiReview = {
        decision: "none",
        selected_rank: null,
        confidence: 0,
        reason: `服务器 AI 审核失败：${error.message}`,
        candidate_reviews: buildAiFailureCandidateReviews(result.candidates, "服务器 AI 审核失败"),
        thinkingMode: MINIMAX_THINKING_TYPE,
      };
      job.logs = Array.isArray(job.logs) ? job.logs : [];
      job.logs.push(makeLogEntry(`AI 审核第 ${result.sourceRow || job.results.indexOf(result) + 1} 条失败：${error.message}`, "warn"));
    }
  }
}

async function hydrateWorkerResultImages(job) {
  if (!isSafeJobId(job.id) || !Array.isArray(job.results)) return;
  await ensureDir(path.join(JOBS_DIR, job.id, "images"));
  for (const [resultIndex, result] of job.results.entries()) {
    const productIndex = result.sourceRow || resultIndex + 1;
    const ozon = result.ozon || {};
    if (!ozon.mainImage?.filePath && ozon.mainImageUrl) {
      try {
        ozon.mainImage = await downloadRemoteImageFile({
          jobId: job.id,
          index: productIndex,
          prefix: "ozon",
          url: ozon.mainImageUrl,
          referer: result.url || ozon.sourceUrl || "https://www.ozon.ru/",
        });
        result.ozon = ozon;
      } catch (error) {
        ozon.imageDownloadError = error.message;
      }
    }
    for (const [candidateIndex, candidate] of (result.candidates || []).entries()) {
      if (!candidate.localImage?.filePath && candidate.image) {
        try {
          candidate.localImage = await downloadRemoteImageFile({
            jobId: job.id,
            index: `${String(productIndex).padStart(3, "0")}_${candidateIndex + 1}`,
            prefix: "1688",
            url: candidate.image,
            referer: candidate.link || "https://www.1688.com/",
          });
        } catch (error) {
          candidate.imageDownloadError = error.message;
        }
      }
    }
  }
}

async function downloadRemoteImageFile({ jobId, index, prefix, url, referer }) {
  const response = await fetch(url, {
    headers: {
      Referer: referer || "",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) throw new Error(`图片下载失败 ${response.status}：${url}`);
  const contentType = response.headers.get("content-type") || "image/jpeg";
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const ext = extensionFromContentType(contentType, url);
  const filename = `${prefix}_${String(index).replace(/[^0-9A-Za-z_-]/g, "_")}.${ext}`;
  const filePath = path.join(JOBS_DIR, jobId, "images", filename);
  await fs.writeFile(filePath, buffer);
  return {
    url,
    filePath,
    publicUrl: `/artifacts/jobs/${jobId}/images/${filename}`,
    contentType,
  };
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
  let downloadUrl = excelBase64 ? `/api/history/${id}/download` : "";
  const jobJson = {
    ...job,
    id,
    kind,
    downloadUrl,
    logs: Array.isArray(job.logs) ? job.logs : [],
    results: Array.isArray(job.results) ? job.results : [],
    updatedAt: new Date().toISOString(),
  };
  if (excelBase64) {
    const excelName = kind === "batch-ozon" ? "ozon-batch-results.xlsx" : "ozon-1688-results.xlsx";
    await fs.writeFile(path.join(dir, excelName), Buffer.from(String(excelBase64), "base64"));
    await fs.writeFile(path.join(dir, "results.json"), JSON.stringify(jobJson, null, 2), "utf8");
    return downloadUrl;
  }
  if (jobJson.results.length) {
    await writeJobArtifacts(jobJson);
    downloadUrl = jobJson.downloadUrl || `/api/history/${id}/download`;
    jobJson.downloadUrl = downloadUrl;
  }
  await fs.writeFile(path.join(dir, "results.json"), JSON.stringify(jobJson, null, 2), "utf8");
  return downloadUrl;
}

async function getDbJobForUser(id, user) {
  const params = [id];
  let where = "j.id = $1";
  if (user?.role !== "admin") {
    params.push(user?.id || "");
    where += " AND j.user_id = $2";
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

async function loadDbJobHistory(user) {
  const params = [];
  let where = "TRUE";
  if (user?.role !== "admin") {
    params.push(user?.id || "");
    where = `j.user_id = $1`;
  }
  const result = await db.query(
    `SELECT j.*, u.username, u.display_name
     FROM app_jobs j
     LEFT JOIN app_users u ON u.id = j.user_id
     WHERE ${where}
     ORDER BY j.updated_at DESC
     LIMIT 200`,
    params,
  );
  const items = result.rows.map((row) => {
    const job = dbRowToJob(row);
    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      phase: job.phase,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      processed: job.processed,
      total: job.total || job.sourceTotal || job.results.length || 0,
      resultCount: job.results.length || job.processed || job.total || 0,
      sourceStartRow: job.sourceStartRow,
      sourceTotal: job.sourceTotal,
      firstRow: job.payload?.urlRows?.[0]?.sourceRow || "",
      lastRow: job.payload?.urlRows?.at?.(-1)?.sourceRow || "",
      firstUrl: job.payload?.urls?.[0] || job.payload?.sourceUrl || "",
      excelExists: Boolean(job.downloadUrl),
      excelBytes: 0,
      downloadUrl: job.downloadUrl,
      derived: false,
      owner: job.owner,
      lastDownloadedAt: row.last_downloaded_at || "",
    };
  });
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
  return formatOzonCnyForExport(ozon.currentGreenPriceCny || "");
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
  if (!existsSync(filePath)) {
    res.status(404).send("文件不存在");
    return;
  }
  await markJobDownloaded(id).catch(() => {});
  const shortId = id.length > 18 ? id.slice(0, 18) : id;
  res.download(filePath, `${downloadPrefix}-${shortId}.xlsx`);
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
  const weightValue = `IF(TRIM(B${r}&"")="",IFERROR(VALUE(C${r}),0),IFERROR(VALUE(B${r}),0))`;
  const formulas = {
    F: `IF(OR(AND(TRIM(B${r}&"")="",TRIM(C${r}&"")=""),TRIM(D${r}&"")=""),"",IF(P${r}="无法匹配","无法匹配",IF(P${r}="Big","未上线",IF(P${r}="Extra Small",ROUND(Q${r}*1000*0.025+3,2),IF(P${r}="Budget",ROUND(Q${r}*1000*0.017+23,2),IF(P${r}="Small",ROUND(Q${r}*1000*0.025+16,2),IF(P${r}="Premium Small",ROUND(Q${r}*1000*0.025+22,2),IF(P${r}="Premium Big",ROUND(Q${r}*1000*0.023+62,2),""))))))))`,
    G: `IF(TRIM(D${r}&"")="","",ROUND(IFERROR(VALUE(D${r}),0)*IF((IFERROR(VALUE(D${r}),0)*$S$2)<1500,12%,20%),2))`,
    H: `IF(TRIM(D${r}&"")="","",3)`,
    I: `IF(TRIM(D${r}&"")="","",ROUND(IFERROR(VALUE(D${r}),0)*2%,2))`,
    K: `IF(TRIM(D${r}&"")="","",ROUND(IFERROR(VALUE(D${r}),0)*2%,2))`,
    L: `IF(TRIM(D${r}&"")="","",IF(OR(F${r}="未上线",F${r}="无法匹配"),F${r},ROUND(IFERROR(VALUE(E${r}),0)+N(F${r})+N(G${r})+N(H${r})+N(I${r})+IFERROR(VALUE(J${r}),0)+N(K${r}),2)))`,
    M: `IF(TRIM(D${r}&"")="","",IF(OR(F${r}="未上线",F${r}="无法匹配"),F${r},ROUND(IFERROR(VALUE(D${r}),0)-L${r},2)))`,
    N: `IF(TRIM(D${r}&"")="","",IF(OR(F${r}="未上线",F${r}="无法匹配"),"",IF(IFERROR(VALUE(D${r}),0)=0,"",M${r}/IFERROR(VALUE(D${r}),0))))`,
    O: `IF(OR(TRIM(A${r}&"")="",TRIM(D${r}&"")=""),"",A${r}&","&ROUND(IFERROR(VALUE(D${r}),0)*2,0))`,
    P: `IF(OR(AND(TRIM(B${r}&"")="",TRIM(C${r}&"")=""),TRIM(D${r}&"")=""),"",IF(AND((IFERROR(VALUE(D${r}),0)*$S$2)>=0,(IFERROR(VALUE(D${r}),0)*$S$2)<1500,${weightValue}>=0,${weightValue}<=500),"Extra Small",IF(AND((IFERROR(VALUE(D${r}),0)*$S$2)>=0,(IFERROR(VALUE(D${r}),0)*$S$2)<1500,${weightValue}>500,${weightValue}<=30000),"Budget",IF(AND((IFERROR(VALUE(D${r}),0)*$S$2)>=1500,(IFERROR(VALUE(D${r}),0)*$S$2)<7000,${weightValue}>=0,${weightValue}<=2000),"Small",IF(AND((IFERROR(VALUE(D${r}),0)*$S$2)>=1500,(IFERROR(VALUE(D${r}),0)*$S$2)<7000,${weightValue}>2000,${weightValue}<=30000),"Big",IF(AND((IFERROR(VALUE(D${r}),0)*$S$2)>=7000,(IFERROR(VALUE(D${r}),0)*$S$2)<=250000,${weightValue}>=0,${weightValue}<=5000),"Premium Small",IF(AND((IFERROR(VALUE(D${r}),0)*$S$2)>=7000,(IFERROR(VALUE(D${r}),0)*$S$2)<=250000,${weightValue}>5000,${weightValue}<=30000),"Premium Big","无法匹配")))))))`,
    Q: `IF(P${r}="","",IF(P${r}="无法匹配","",IF(OR(P${r}="Extra Small",P${r}="Budget"),ROUND(${weightValue}/1000,3),ROUND(MAX(${weightValue}/1000,(20*20*20/12000)),3))))`,
  };
  return formulas[column] || "";
}

function calculateAlibabaCost(row) {
  const price = parseRmbNumber(row["1688价格"]);
  if (price === null) return "";
  const shipping = parseRmbNumber(row["1688运费"]) ?? 0;
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
  ${hasImages ? '<Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="jpeg" ContentType="image/jpeg"/>' : ""}
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
  const envPath = path.join(__dirname, ".env");
  if (!existsSync(envPath)) return;
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
    if (!process.env[key]) process.env[key] = value;
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await ensureDir(DATA_DIR);
await ensureDir(JOBS_DIR);
await initDatabase();

if (process.argv[1] === __filename) {
  app.listen(PORT, HOST || undefined, () => {
    console.log(`Ozon to 1688 tool running at http://${HOST || "localhost"}:${PORT}`);
  });
}

export {
  applyAiReview,
  getBrowserContext,
  hydrateWorkerResultImages,
  processWorkerCompletionResults,
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
