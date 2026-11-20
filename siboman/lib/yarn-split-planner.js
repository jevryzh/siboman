// Accio Work (2026-11-20) v2.2.9.229
// 拆单+分包发货：把一张毛线订单拆成 N 个 packages[]，每包金额 ≤ SPLIT_THRESHOLD。
//
// 规则（用户确认版）：
//   1. 只处理毛线订单（商品名含 'пряж'）
//   2. 订单总金额 > 135 才拆，≤ 135 跳过
//   3. 按毛线种类（kind: mohar / alpaca / mixed）分组
//      - 单一 kind：整单在该 kind 组内拆
//      - 多 kind（混种）：每个 kind 独立拆，各自装箱
//   4. 每个 kind 组内：
//      - 优先同色聚一包（先处理同色能满箱的）
//      - 剩的碎件（1 件 / 小量）合并混色包
//      - 目标：子单数最少（Q3=C 策略）
//   5. 装箱上限按真实金额：≤ SPLIT_THRESHOLD（135 CNY）
//      - 单件金额 > 阈值：放行，1 件一包（Q2=B）
//
// 输出格式：packages: [{ products: [{ product_id, quantity, offer_id, name, color, kind, price, line_total }], total_price, total_qty, is_mixed_color }]
//   product_id 直接透传给 Ozon /v4/posting/fbs/ship
//   其它字段仅供预览 UI / 日志展示
//
// Not opinion: 阈值 SPLIT_THRESHOLD 做成常量 export，上层可按需调整。

import { classifyColor, extractColor, isYarnName } from './yarn-kinds.js';

export const SPLIT_THRESHOLD = 135;

/**
 * 判断一张订单是否候选拆单。
 * @param {object} order { posting_number, products: [{sku, name, offer_id, quantity, price:{amount}}] }
 * @returns {{ eligible: boolean, reason?: string, total_price: number, total_qty: number, is_yarn: boolean }}
 */
export function evaluateOrder(order) {
  const products = Array.isArray(order?.products) ? order.products : [];
  if (!products.length) {
    return { eligible: false, reason: '订单无商品行', total_price: 0, total_qty: 0, is_yarn: false };
  }
  let total_price = 0;
  let total_qty = 0;
  let has_yarn = false;
  for (const p of products) {
    const qty = Number(p?.quantity || 0);
    const price = Number(p?.price?.amount || 0);
    total_qty += qty;
    total_price += qty * price;
    if (isYarnName(p?.name)) has_yarn = true;
  }
  if (!has_yarn) return { eligible: false, reason: '非毛线订单', total_price, total_qty, is_yarn: false };
  if (total_price <= SPLIT_THRESHOLD) {
    return { eligible: false, reason: `金额 ${total_price} ≤ ${SPLIT_THRESHOLD}，无需拆分`, total_price, total_qty, is_yarn: true };
  }
  return { eligible: true, total_price, total_qty, is_yarn: true };
}

/**
 * 把订单的 products 展开成「单件条目」数组，并打上 kind / color。
 * 非毛线行 kind = 'nonyarn'，仍然要装包（Ozon 要求整单全部商品都被 packages 覆盖）。
 */
function flattenToUnits(products) {
  const units = [];
  for (const p of products) {
    const qty = Number(p?.quantity || 0);
    if (qty <= 0 || !p?.sku) continue;
    const price = Number(p?.price?.amount || 0);
    const offer_id = String(p?.offer_id || '');
    const name = String(p?.name || '');
    const is_yarn = isYarnName(name);
    let kind = 'nonyarn';
    let color = '';
    if (is_yarn) {
      const raw = extractColor(offer_id);
      const cls = classifyColor(raw);
      kind = cls.kind?.code || 'unknown';
      color = cls.color || raw || '';
    }
    for (let i = 0; i < qty; i += 1) {
      units.push({
        product_id: Number(p.sku),
        offer_id, name, price, kind, color, is_yarn,
      });
    }
  }
  return units;
}

/**
 * 贪心装箱：把一组 units 装成 packages，每包金额 ≤ SPLIT_THRESHOLD。
 *   - 子单数最少（Q3=C）
 *   - 优先同色聚包：先扫同色，能塞满一包的先塞
 *   - 剩的碎件混色装包，依然每包尽量满（降序 First-Fit-Decreasing）
 */
function packUnits(units) {
  if (!units.length) return [];
  // 按 color 分组
  const byColor = new Map(); // color -> units[]
  for (const u of units) {
    if (!byColor.has(u.color)) byColor.set(u.color, []);
    byColor.get(u.color).push(u);
  }
  const packages = [];

  // Step 1: 同色优先。对每个 color 组，装满单色包；剩余 < 1 整包的碎件丢到 leftovers
  const leftovers = [];
  for (const [, group] of byColor) {
    let bucket = [];
    let bucketTotal = 0;
    for (const u of group) {
      // 单件就超阈值：放行 1 件一包（Q2=B）
      if (u.price > SPLIT_THRESHOLD) {
        if (bucket.length) { packages.push(makePack(bucket)); bucket = []; bucketTotal = 0; }
        packages.push(makePack([u]));
        continue;
      }
      if (bucketTotal + u.price > SPLIT_THRESHOLD) {
        packages.push(makePack(bucket));
        bucket = [u];
        bucketTotal = u.price;
      } else {
        bucket.push(u);
        bucketTotal += u.price;
      }
    }
    // 收尾：满包就直接 push；不满就送到 leftovers 让混色阶段再装
    if (bucket.length) {
      // 判断满包定义：再加 1 件就会超阈值
      const avgPrice = bucketTotal / bucket.length;
      const canFitMore = (bucketTotal + avgPrice) <= SPLIT_THRESHOLD;
      if (!canFitMore) {
        packages.push(makePack(bucket));
      } else {
        leftovers.push(...bucket);
      }
    }
  }

  // Step 2: leftovers 混色装包（Q3=C：子单数最少）
  //   First-Fit-Decreasing：按单价降序，依次塞入第一个装得下的包
  leftovers.sort((a, b) => b.price - a.price);
  const mixedPacks = []; // [{ units: [], total: 0 }]
  for (const u of leftovers) {
    let placed = false;
    for (const mp of mixedPacks) {
      if (mp.total + u.price <= SPLIT_THRESHOLD) {
        mp.units.push(u); mp.total += u.price; placed = true; break;
      }
    }
    if (!placed) mixedPacks.push({ units: [u], total: u.price });
  }
  for (const mp of mixedPacks) packages.push(makePack(mp.units));

  return packages;
}

function makePack(units) {
  // 合并同 product_id：Ozon packages.products 的 { product_id, quantity } 要合并重复项
  const merged = new Map(); // product_id -> { product_id, quantity, offer_id, name, color, kind, price }
  let total_price = 0;
  for (const u of units) {
    total_price += u.price;
    if (merged.has(u.product_id)) {
      merged.get(u.product_id).quantity += 1;
    } else {
      merged.set(u.product_id, {
        product_id: u.product_id, quantity: 1,
        offer_id: u.offer_id, name: u.name, color: u.color, kind: u.kind, price: u.price,
      });
    }
  }
  const products = [...merged.values()].map((m) => ({ ...m, line_total: m.quantity * m.price }));
  const colors = new Set(products.map((p) => p.color).filter(Boolean));
  const kinds = new Set(products.map((p) => p.kind).filter((k) => k && k !== 'nonyarn'));
  return {
    products,
    total_price,
    total_qty: units.length,
    is_mixed_color: colors.size > 1,
    is_mixed_kind: kinds.size > 1,
  };
}

/**
 * 主函数：把一张订单拆成 packages。
 * 返回 { packages, summary: { pack_count, total_price, total_qty } }。
 * 当订单不符合拆分条件时，packages = [] 并带 skipped=true + reason。
 */
export function planOrderSplit(order) {
  const evalResult = evaluateOrder(order);
  if (!evalResult.eligible) {
    return {
      skipped: true,
      reason: evalResult.reason,
      total_price: evalResult.total_price,
      total_qty: evalResult.total_qty,
      packages: [],
    };
  }
  const units = flattenToUnits(order.products || []);
  // 按 kind 分组装箱：mohar / alpaca / nonyarn / unknown 各自独立
  const byKind = new Map();
  for (const u of units) {
    if (!byKind.has(u.kind)) byKind.set(u.kind, []);
    byKind.get(u.kind).push(u);
  }
  const packages = [];
  // 顺序：mohar → alpaca → 其它毛线 → nonyarn
  const KIND_ORDER = ['mohar', 'alpaca'];
  const orderedKinds = [
    ...KIND_ORDER.filter((k) => byKind.has(k)),
    ...[...byKind.keys()].filter((k) => !KIND_ORDER.includes(k) && k !== 'nonyarn'),
    ...(byKind.has('nonyarn') ? ['nonyarn'] : []),
  ];
  for (const kind of orderedKinds) {
    const packs = packUnits(byKind.get(kind));
    for (const p of packs) packages.push(p);
  }
  const summary = {
    pack_count: packages.length,
    total_price: evalResult.total_price,
    total_qty: evalResult.total_qty,
  };
  return { skipped: false, packages, summary };
}
