/**
 * Ozon 全网热销品抓取器 (服务端 Playwright 版 - ESM)
 * 
 * 参考 MYERP 插件的反爬绕过策略，移植到服务端：
 * 1. 拦截 composer-api BFF 响应（抄 ozon-bff-interceptor.js）
 * 2. 从 widgetStates 提取商品级数据（抄 ozon-public-product-snapshot.js）
 * 3. 自动滚动加载更多（抄 auto-scroller.js）
 * 4. 403 检测 + 自动重开页面（抄 anti-ban.js）
 */

import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROFILE_DIR = path.join(__dirname, "data", "browser-profile");
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Ozon BFF 端点白名单（抄 MYERP ozon-bff-interceptor.js）
const BFF_PATTERNS = [
  /\/api\/composer-api\.bx\/_action\/getCatalog/i,
  /\/api\/composer-api\.bx\/_action\/getSimilarSearch/i,
  /\/api\/composer-api\.bx\/page\/json\/v2/i,
  /\/api\/entrypoint-api\.bx\/page\/json\/v2/i,
];

/**
 * 从 Ozon BFF 响应的 widgetStates 里提取商品列表
 * 抄 MYERP 的 lib/ozon-public-product-snapshot.js + ozon-search.js extractCardInfo
 */
function extractProductsFromBff(json) {
  const widgetStates = json?.widgetStates || {};
  const products = [];

  for (const [key, rawVal] of Object.entries(widgetStates)) {
    let widget;
    try {
      widget = typeof rawVal === "string" ? JSON.parse(rawVal) : rawVal;
    } catch {
      continue;
    }

    if (key.startsWith("searchResults") && widget) {
      const items = widget.items || widget.components || [];
      for (const item of items) {
        const product = extractSingleProduct(item, key);
        if (product && product.sku) products.push(product);
      }
    }

    if (key.startsWith("tile") && Array.isArray(widget)) {
      for (const item of widget) {
        const product = extractSingleProduct(item, key);
        if (product && product.sku) products.push(product);
      }
    }
  }

  return products;
}

function extractSingleProduct(item, sourceKey) {
  const sku =
    String(item?.id || item?.sku || item?.productId || item?.itemId || "").trim() || "";

  const title =
    item?.title?.text || item?.title?.content || item?.name ||
    item?.ariaLabel || item?.alt || item?.text || "";

  const priceWidget = item?.price || item?.priceWidget || {};
  const price = extractPrice(priceWidget);

  const image =
    item?.image?.src || item?.image?.url || item?.imageUrl ||
    item?.mainImage || item?.coverImage?.url || "";

  const url = item?.link || item?.url || item?.action?.link || "";
  const fullUrl = url ? (url.startsWith("http") ? url : `https://www.ozon.ru${url}`) : "";

  const salesText = item?.sales?.text || item?.salesLabel || "";
  const soldCount = parseSoldCount(salesText);

  const rating = item?.rating?.value || item?.rating || null;
  const reviewCount = item?.reviewCount || item?.reviews?.count || null;

  const sellerName = item?.seller?.name || item?.sellerName || "";
  const sellerLink = item?.seller?.link || "";

  const brand = item?.brand?.name || item?.brand || "";

  if (!sku && !fullUrl) return null;

  return {
    sku,
    title: String(title).trim(),
    price: price.value,
    priceCurrency: price.currency || "RUB",
    image: image.startsWith("//") ? "https:" + image : image,
    url: fullUrl,
    soldCount,
    salesText,
    rating: rating ? Number(rating) : null,
    reviewCount: reviewCount ? Number(reviewCount) : null,
    sellerName,
    sellerLink,
    brand,
    sourceKey,
    scrapedAt: new Date().toISOString(),
  };
}

function extractPrice(priceWidget) {
  if (!priceWidget) return { value: null, currency: "RUB" };
  const raw =
    priceWidget?.cardPrice?.text || priceWidget?.price?.text ||
    priceWidget?.finalPrice?.text || priceWidget?.value ||
    priceWidget?.text || "";
  const str = String(raw).replace(/\s+/g, "").replace(",", ".");
  const match = str.match(/(\d+(?:\.\d+)?)/);
  const currency = /₽|руб|RUB/i.test(str) ? "RUB" : /¥|元|CNY|RMB/i.test(str) ? "CNY" : "RUB";
  return { value: match ? Number(match[1]) : null, currency };
}

function parseSoldCount(text) {
  if (!text) return null;
  const str = String(text).replace(/\s+/g, "");
  const match = str.match(/(\d+(?:[.,]\d+)?)\s*(тыс|тысяч|млн|млрд)?/i);
  if (!match) return null;
  let num = parseFloat(match[1].replace(",", "."));
  const unit = (match[2] || "").toLowerCase();
  if (unit === "тыс" || unit === "тысяч") num *= 1000;
  if (unit === "млн") num *= 1000000;
  return Math.round(num);
}

/**
 * 主抓取函数
 */
export async function scrapeOzonMarket(options = {}) {
  const {
    keyword = "",
    categoryUrl = "",
    maxProducts = 60,
    headless = true,
    maxScrollAttempts = 30,
  } = options;

  const targetUrl = categoryUrl
    ? categoryUrl
    : `https://www.ozon.ru/search/?text=${encodeURIComponent(keyword)}&from_global=true`;

  console.log(`[ozon-scraper] 目标 URL: ${targetUrl}`);
  console.log(`[ozon-scraper] 最大商品数: ${maxProducts}`);

  await fs.mkdir(PROFILE_DIR, { recursive: true });

  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    userAgent: USER_AGENT,
    viewport: { width: 1440, height: 900 },
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
    args: ["--disable-blink-features=AutomationControlled"],
  });

  // 反检测：隐藏 webdriver
  await browser.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "languages", { get: () => ["ru-RU", "ru", "en"] });
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });
  });

  const page = await browser.newPage();

  const capturedBffData = [];
  let response403count = 0;

  page.on("response", async (response) => {
    const url = response.url();
    const isBff = BFF_PATTERNS.some((p) => p.test(url));
    if (!isBff) return;

    try {
      if (response.status() === 403) {
        response403count++;
        console.warn(`[ozon-scraper] 403 detected (#${response403count}): ${url}`);
        return;
      }
      const json = await response.json();
      const products = extractProductsFromBff(json);
      if (products.length) {
        capturedBffData.push(...products);
        console.log(`[ozon-scraper] BFF 拦截 +${products.length} 个商品 (累计 ${capturedBffData.length})`);
      }
    } catch (e) {
      // 静默吞掉
    }
  });

  console.log("[ozon-scraper] 正在打开页面...");
  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (e) {
    console.warn(`[ozon-scraper] 导航超时/失败: ${e.message}`);
  }

  await page.waitForTimeout(3000);

  const title = await page.title();
  if (title.includes("капча") || title.includes("captcha") || title.includes("Robot")) {
    console.error("[ozon-scraper] 被风控拦截，需要手动验证");
    if (headless) {
      await browser.close();
      return { products: [], error: "CAPTCHA_DETECTED", captcha: true };
    }
    console.log("[ozon-scraper] 等待用户手动过验证码（60 秒）...");
    await page.waitForTimeout(60000);
  }

  let lastCount = 0;
  let emptyStreak = 0;
  const scrollInterval = 2000;
  const settleTime = 1500;
  const emptyThreshold = 5;

  const seen = new Set();
  const dedupe = (arr) => {
    const out = [];
    for (const p of arr) {
      const key = p.sku || p.url;
      if (key && !seen.has(key)) {
        seen.add(key);
        out.push(p);
      }
    }
    return out;
  };

  for (let i = 0; i < maxScrollAttempts; i++) {
    const current = dedupe(capturedBffData);
    if (current.length >= maxProducts) {
      console.log(`[ozon-scraper] 达到目标数量 ${maxProducts}，停止滚动`);
      break;
    }

    if (current.length === lastCount) {
      emptyStreak++;
    } else {
      emptyStreak = 0;
      lastCount = current.length;
    }

    if (emptyStreak >= emptyThreshold) {
      console.log(`[ozon-scraper] 连续 ${emptyThreshold} 次无新增，判定到底`);
      break;
    }

    if (response403count >= 5) {
      console.warn("[ozon-scraper] 403 过多，重新打开页面...");
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(3000);
      response403count = 0;
      continue;
    }

    const scrollStep = Math.max(680, Math.floor(900 * 0.95));
    await page.evaluate((step) => window.scrollBy(0, step), scrollStep);
    await page.waitForTimeout(scrollInterval + settleTime);
  }

  // DOM 兜底
  const domProducts = await page.evaluate(() => {
    const SELECTORS = [
      '[data-widget="searchResultsV2"] [data-widget="searchResultsItem"]',
      '[data-widget="searchResults"] [data-widget="searchResultsItem"]',
      '[data-widget="searchResultsV2"] > div > div',
    ];
    const cards = new Set();
    for (const sel of SELECTORS) {
      document.querySelectorAll(sel).forEach((c) => cards.add(c));
    }
    return Array.from(cards).map((card) => {
      const link = card.querySelector('a[href*="/product/"]');
      const img = card.querySelector("img");
      const priceEl = card.querySelector('[data-widget="searchResultsPrice"], [data-widget="webPrice"]');
      const salesEl = card.querySelector('[data-widget="searchResultsSales"]');
      const url = link?.href || "";
      const skuMatch = url.match(/\/product\/.*-(\d{5,})/);
      return {
        sku: skuMatch ? skuMatch[1] : "",
        title: link?.getAttribute("aria-label") || img?.getAttribute("alt") || link?.textContent?.trim() || "",
        url,
        image: img?.getAttribute("src") || img?.getAttribute("data-src") || "",
        priceText: priceEl?.textContent?.trim() || "",
        salesText: salesEl?.textContent?.trim() || "",
      };
    });
  }).catch(() => []);

  await browser.close();

  const merged = new Map();
  for (const p of capturedBffData) {
    const key = p.sku || p.url;
    if (key && !merged.has(key)) merged.set(key, p);
  }
  for (const d of domProducts) {
    const key = d.sku || d.url;
    if (key && !merged.has(key)) {
      const price = extractPrice({ text: d.priceText });
      merged.set(key, {
        sku: d.sku,
        title: d.title,
        url: d.url,
        image: d.image,
        price: price.value,
        priceCurrency: "RUB",
        soldCount: parseSoldCount(d.salesText),
        salesText: d.salesText,
        rating: null,
        reviewCount: null,
        sellerName: "",
        brand: "",
        sourceKey: "dom-fallback",
        scrapedAt: new Date().toISOString(),
      });
    }
  }

  const results = Array.from(merged.values()).slice(0, maxProducts);
  console.log(`[ozon-scraper] 最终结果: ${results.length} 个商品`);

  return {
    products: results,
    total: results.length,
    keyword,
    categoryUrl,
    scrapedAt: new Date().toISOString(),
  };
}

export { extractProductsFromBff };
