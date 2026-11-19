// Accio Work (2026-11-19) v2.2.9.228
// 验证「导出毛线拣货单」把取消订单放到整份表格最后一段，且不进 mohar/alpaca/mixed。
// 复刻 server.js 里那段聚合逻辑 —— 不走 DB、不走 HTTP。
//
// 关键 case：
//   1. status=cancelled 的订单 kind="cancelled"，不进 mohar/alpaca/mixed
//   2. 大小写和 CANCELLED/Canceled 都要兼容
//   3. 排序器把 cancelled 放到最后（KIND_ORDER 外 → rank=99）
//   4. 取消段内部复用同样的排序规则（单件优先 / 多件按色号升序 / 混色最后）
//   5. 一单的 products 里只要出现一次 cancelled，就整单计入 cancelled 段（不会被拆散到 mohar）

import assert from 'node:assert/strict';
import {
  YARN_KINDS,
  extractColor as extractYarnColor,
  classifyColor as classifyYarnColor,
} from '../lib/yarn-kinds.js';
import { sortYarnOrderRows } from '../lib/yarn-order-sort.js';

// ---------- 复刻 server.js 里那段 v2.2.9.228 聚合（含 cancelled 分桶）----------
function aggregatePicklist(skuRows) {
  const isCancelledStatus = (s) => /^cancell?ed/i.test(String(s || ''));
  const perOrder = new Map();
  for (const row of skuRows) {
    const pn = String(row.pn);
    const { kind, color } = classifyYarnColor(extractYarnColor(row.offer_id));
    const slot = perOrder.get(pn) || { byKind: new Map(), unknownQty: 0, isCancelled: false };
    if (isCancelledStatus(row.status)) slot.isCancelled = true;
    if (!kind) {
      slot.unknownQty += Number(row.qty) || 0;
    } else {
      const colorMap = slot.byKind.get(kind.code) || new Map();
      colorMap.set(color, (colorMap.get(color) || 0) + (Number(row.qty) || 0));
      slot.byKind.set(kind.code, colorMap);
    }
    perOrder.set(pn, slot);
  }

  const aggregated = [];
  for (const [pn, slot] of perOrder.entries()) {
    const kindCodes = [...slot.byKind.keys()];
    if (!kindCodes.length) continue;
    const isMixed = kindCodes.length > 1;
    const rowKind = slot.isCancelled
      ? 'cancelled'
      : (isMixed ? 'mixed' : kindCodes[0]);
    const colorEntries = [];
    let total = 0;
    let colorCount = 0;
    const colors = [];
    for (const code of kindCodes) {
      const colorMap = slot.byKind.get(code);
      for (const [color, qty] of colorMap.entries()) {
        colorEntries.push({ color, qty, code });
        colors.push(color);
        total += qty;
        colorCount += 1;
      }
    }
    colorEntries.sort((a, b) => {
      if (a.code !== b.code) {
        const kindIdx = (c) => YARN_KINDS.findIndex((k) => k.code === c);
        return kindIdx(a.code) - kindIdx(b.code);
      }
      return a.color < b.color ? -1 : a.color > b.color ? 1 : 0;
    });
    aggregated.push({
      pn,
      kind: rowKind,
      colorQty: colorEntries.map((e) => `${e.color}×${e.qty}`).join('/'),
      total_qty: total,
      color_kinds: colorCount,
      first_color: colors.sort()[0] || '',
    });
  }
  return sortYarnOrderRows(aggregated);
}

// ---------- 用例 ----------
// 场景：3 单 mohar + 2 单 alpaca + 1 单 mixed + 3 单各种状态的取消单
const skuRows = [
  // 正常马海毛
  { pn: 'POS-M1', offer_id: 'jz-x-y-01', qty: 1, status: 'awaiting_deliver' },
  { pn: 'POS-M2', offer_id: 'jz-x-y-18', qty: 2, status: 'awaiting_packaging' },
  { pn: 'POS-M3', offer_id: 'jz-x-y-18', qty: 3, status: '' }, // 空状态不算取消
  // 正常羊驼毛
  { pn: 'POS-A1', offer_id: 'ALPACA-YARN-W023-2PCS', qty: 1, status: 'delivered' },
  { pn: 'POS-A2', offer_id: 'ALPACA-YARN-W001-2PCS', qty: 2, status: 'awaiting_deliver' },
  // 正常混种
  { pn: 'POS-MIX-OK', offer_id: 'jz-x-y-05', qty: 1, status: 'awaiting_deliver' },
  { pn: 'POS-MIX-OK', offer_id: 'ALPACA-YARN-W023-2PCS', qty: 1, status: 'awaiting_deliver' },
  // 取消的马海毛
  { pn: 'POS-C1', offer_id: 'jz-x-y-10', qty: 2, status: 'cancelled' },
  // 取消的羊驼毛
  { pn: 'POS-C2', offer_id: 'ALPACA-YARN-W200-2PCS', qty: 1, status: 'CANCELLED' },
  // 取消的混种（哪怕一行是 canceled，整单归 cancelled）
  { pn: 'POS-C3', offer_id: 'jz-x-y-07', qty: 1, status: 'canceled' },
  { pn: 'POS-C3', offer_id: 'ALPACA-YARN-W023-2PCS', qty: 1, status: 'canceled' },
  // 大小写 Canceled 变体
  { pn: 'POS-C4', offer_id: 'jz-x-y-03', qty: 1, status: 'Canceled' },
];

const sorted = aggregatePicklist(skuRows);

// --- 分段顺序：mohar → alpaca → mixed → cancelled ---
const kinds = sorted.map((r) => r.kind);
const lastMoharIdx = kinds.lastIndexOf('mohar');
const firstAlpacaIdx = kinds.indexOf('alpaca');
const lastAlpacaIdx = kinds.lastIndexOf('alpaca');
const firstMixedIdx = kinds.indexOf('mixed');
const lastMixedIdx = kinds.lastIndexOf('mixed');
const firstCancelledIdx = kinds.indexOf('cancelled');

assert.ok(lastMoharIdx < firstAlpacaIdx, '所有 mohar 在所有 alpaca 之前');
assert.ok(lastAlpacaIdx < firstMixedIdx, '所有 alpaca 在所有 mixed 之前');
assert.ok(lastMixedIdx < firstCancelledIdx, '所有 mixed 在所有 cancelled 之前');
assert.ok(firstCancelledIdx > 0, 'cancelled 段存在且不在最前');

// --- 取消单都在 cancelled 段 ---
const cancelledPns = sorted.filter((r) => r.kind === 'cancelled').map((r) => r.pn);
assert.deepEqual(cancelledPns.sort(), ['POS-C1', 'POS-C2', 'POS-C3', 'POS-C4'],
  '所有取消单都归 cancelled 段，不会出现在 mohar/alpaca/mixed');

// --- 非取消单没有一个落进 cancelled ---
const nonCancelledInCancelledSection = sorted.filter(
  (r) => r.kind === 'cancelled' && ['POS-M1','POS-M2','POS-M3','POS-A1','POS-A2','POS-MIX-OK'].includes(r.pn),
);
assert.equal(nonCancelledInCancelledSection.length, 0, '正常单不会进 cancelled');

// --- 空字符串状态不算取消 ---
const m3 = sorted.find((r) => r.pn === 'POS-M3');
assert.ok(m3, 'POS-M3 应存在');
assert.equal(m3.kind, 'mohar', '空 status 不算取消');

// --- 一单多行只要一个 canceled，整单归 cancelled ---
const c3 = sorted.find((r) => r.pn === 'POS-C3');
assert.equal(c3.kind, 'cancelled', 'POS-C3 任一行 canceled → 整单 cancelled');
// 混种的 colorQty 仍然按 kind → 色号排序显示
assert.equal(c3.colorQty, '07×1/W023×1', 'cancelled 段的 Color×Qty 展示规则不变');

// --- cancelled 段内部排序：单件优先，按色号升序 ---
//   POS-C2（W200×1，alpaca）、POS-C4（03×1，mohar）、POS-C1（10×2，mohar）、POS-C3（07×1/W023×1，mixed）
//   1 件单优先：POS-C4(#03)、POS-C2(#W200)、POS-C3(混色算 isMixed=true 排最后)
//   2 件单（POS-C1）排在所有 1 件单后、混色之前
//   注意：POS-C2 色号 W200 字典序 > POS-C4 的 03
const cancelledSorted = sorted.filter((r) => r.kind === 'cancelled').map((r) => r.pn);
assert.deepEqual(cancelledSorted, ['POS-C4', 'POS-C2', 'POS-C1', 'POS-C3'],
  'cancelled 段复用标准排序：1 件单按色号 → 多件单 → 混色');

// --- 取消的混种单 Color×Qty 和正常混种一样格式 ---
assert.ok(c3.colorQty.includes('/'), '混种的 Color×Qty 含 "/" 分隔');
assert.equal(c3.total_qty, 2, 'POS-C3 总件数=1+1');

// --- 取消的羊驼毛 Color×Qty 显示 W 色号 ---
const c2 = sorted.find((r) => r.pn === 'POS-C2');
assert.equal(c2.colorQty, 'W200×1', 'cancelled 段的 alpaca 色号仍是 W200×N');

console.log('yarn picklist cancelled section: OK');
console.log('sorted order:', sorted.map((r) => `${r.pn}[${r.kind}]${r.colorQty}`).join(' | '));
