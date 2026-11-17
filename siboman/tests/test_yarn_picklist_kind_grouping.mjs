// Accio Work (2026-11-17) v2.2.9.226
// 端到端模拟「拣货单接口」核心聚合：SQL 返回的 skuRes.rows 形状 → aggregated → 分组 → 排序
// 不走 DB、不走 HTTP，只测 server.js 里那段 JS 逻辑。
//
// 这段逻辑在 server.js 里是行内代码，这里用相同的算法复刻一遍，
// 验证关键 case：
//   1. 一单含两种毛线 → 归到 "mixed"
//   2. W023 不再被当成马海毛混进统计
//   3. 分组顺序：mohar → alpaca → mixed
//   4. 空 Color×Qty 用 "/" 分隔，顺序按 kind → 色号

import assert from 'node:assert/strict';
import {
  YARN_KINDS,
  extractColor as extractYarnColor,
  classifyColor as classifyYarnColor,
} from '../lib/yarn-kinds.js';
import { sortYarnOrderRows } from '../lib/yarn-order-sort.js';

// ---------- 复刻 server.js 里那段聚合 ----------
function aggregatePicklist(skuRows) {
  const perOrder = new Map();
  for (const row of skuRows) {
    const pn = String(row.pn);
    const { kind, color } = classifyYarnColor(extractYarnColor(row.offer_id));
    const slot = perOrder.get(pn) || { byKind: new Map(), unknownQty: 0 };
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
    const rowKind = isMixed ? 'mixed' : kindCodes[0];
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
// 场景：模拟今天的真实数据 —— 马海毛大头，中间混进 2 单 W023 羊驼毛，再加 1 单两种都有的混种
const skuRows = [
  // 纯马海毛
  { pn: 'POS-M1', offer_id: 'jz-260624fwg3-4736604207-01', qty: 2 },
  { pn: 'POS-M2', offer_id: 'jz-260624fwg3-4736604207-18', qty: 1 },
  { pn: 'POS-M3', offer_id: 'jz-260624fwg3-4736604207-32', qty: 3 },
  // 纯羊驼毛（像今天实际的数据）
  { pn: 'POS-A1', offer_id: 'ALPACA-YARN-W023-2PCS', qty: 2 },
  { pn: 'POS-A2', offer_id: 'ALPACA-YARN-W001-2PCS', qty: 1 },
  // 混种：一单既有马海毛又有羊驼毛
  { pn: 'POS-MIX', offer_id: 'jz-260624fwg3-4736604207-05', qty: 1 },
  { pn: 'POS-MIX', offer_id: 'ALPACA-YARN-W023-2PCS', qty: 1 },
  // 应被忽略：offer_id 没有合法色号
  { pn: 'POS-SKIP', offer_id: 'unknown-sku-no-color-xyz', qty: 1 },
];

const sorted = aggregatePicklist(skuRows);

// --- 分组顺序：mohar → alpaca → mixed → (unknown 已跳过) ---
const kinds = sorted.map((r) => r.kind);
const firstAlpacaIdx = kinds.indexOf('alpaca');
const lastMoharIdx = kinds.lastIndexOf('mohar');
const firstMixedIdx = kinds.indexOf('mixed');
assert.ok(lastMoharIdx < firstAlpacaIdx, '所有 mohar 在所有 alpaca 之前');
assert.ok(firstAlpacaIdx < firstMixedIdx, '所有 alpaca 在 mixed 之前');

// --- POS-SKIP 不在结果里（全 unknown 的订单被忽略）---
assert.equal(sorted.find(r => r.pn === 'POS-SKIP'), undefined, 'POS-SKIP（无合法色号）不进拣货单');

// --- POS-MIX 归到 mixed，Color×Qty 同时包含两种色号 ---
const mix = sorted.find(r => r.pn === 'POS-MIX');
assert.ok(mix, 'POS-MIX 应存在');
assert.equal(mix.kind, 'mixed', 'POS-MIX 分组=mixed');
assert.equal(mix.total_qty, 2, 'POS-MIX 总件数=1+1');
// kind 顺序：mohar 在前、alpaca 在后 → "05×1/W023×1"
assert.equal(mix.colorQty, '05×1/W023×1', 'Color×Qty 按 kind 排序：mohar 色号在前，alpaca 色号在后');

// --- POS-A1 W023 被正确识别为 alpaca，不是 2PCS ---
const a1 = sorted.find(r => r.pn === 'POS-A1');
assert.ok(a1, 'POS-A1 应存在');
assert.equal(a1.kind, 'alpaca', 'POS-A1 分组=alpaca（不再是 unknown）');
assert.equal(a1.colorQty, 'W023×2', 'Color×Qty 正确展示 W023×2，不是 2PCS×2');

// --- POS-M1 的 "01" 展示正确 ---
const m1 = sorted.find(r => r.pn === 'POS-M1');
assert.equal(m1.kind, 'mohar');
assert.equal(m1.colorQty, '01×2');

console.log('yarn picklist aggregation (kind grouping): OK');
console.log('sorted order:', sorted.map(r => `${r.pn}[${r.kind}]${r.colorQty}`).join(' | '));
