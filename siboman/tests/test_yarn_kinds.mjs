// Accio Work (2026-11-17) v2.2.9.226
// 验证毛线种类识别配置、以及拣货单/标签接口的 kind 分段排序。
// 不涉及 DB，纯函数单测。

import assert from 'node:assert/strict';
import {
  YARN_KINDS,
  getYarnKindByCode,
  extractColor,
  classifyColor,
  classifyOfferId,
  colorKind,
  isYarnName,
} from '../lib/yarn-kinds.js';
import { sortYarnOrderRows } from '../lib/yarn-order-sort.js';

// ---------- 配置表基本断言 ----------
assert.ok(Array.isArray(YARN_KINDS) && YARN_KINDS.length >= 2, 'YARN_KINDS 至少有 mohar 和 alpaca 两类');
assert.ok(getYarnKindByCode('mohar'), '马海毛配置存在');
assert.ok(getYarnKindByCode('alpaca'), '羊驼毛配置存在');
assert.equal(getYarnKindByCode('nonexistent'), null, '未知 code 返回 null');
assert.equal(getYarnKindByCode('mohar').perQty, 4, '马海毛 1 绞 = 4 根');
assert.equal(getYarnKindByCode('alpaca').perQty, 2, '羊驼毛 1 绞 = 2 根');

// ---------- extractColor + classifyColor ----------
// 马海毛：offer_id 最后一段是色号
assert.equal(extractColor('jz-260624fwg3-4736604207-01'), '01', '马海毛纯数字色号');
assert.equal(extractColor('jz-260624fwg3-4736604207-18'), '18');
assert.equal(extractColor('jz-260624fwg3-4736604207-32'), '32');

// 羊驼毛：倒数第二段是色号（最后一段 "2PCS" 不是合法色号 → 回退）
assert.equal(extractColor('ALPACA-YARN-W023-2PCS'), 'W023', '羊驼毛 W 色号（跳过 2PCS）');
assert.equal(extractColor('alpaca-yarn-w001-5pcs'), 'W001', '大小写不敏感 + 规范化为大写');
assert.equal(extractColor('ALPACA-YARN-W999'), 'W999', '最后一段就是 W 色号');

// 边界
assert.equal(extractColor(''), '', '空串');
assert.equal(extractColor(null), '');
assert.equal(extractColor('no-color-here'), '', '没有合法色号');

// classifyColor 返回 { kind, color }
const mohColor = classifyColor('01');
assert.equal(mohColor.kind?.code, 'mohar');
assert.equal(mohColor.color, '01');

const alpColor = classifyColor('W023');
assert.equal(alpColor.kind?.code, 'alpaca');
assert.equal(alpColor.color, 'W023');

const alpColorLower = classifyColor('w023');
assert.equal(alpColorLower.kind?.code, 'alpaca');
assert.equal(alpColorLower.color, 'W023', '小写输入也规范化为大写');

const unk = classifyColor('xyz');
assert.equal(unk.kind, null, '非法色号 kind 为 null');
assert.equal(unk.color, 'xyz', '原值保留');

// classifyOfferId 组合调用
const combo = classifyOfferId('ALPACA-YARN-W023-2PCS');
assert.equal(combo.kind?.code, 'alpaca');
assert.equal(combo.color, 'W023');

// 向后兼容 colorKind（返回字符串 code）
assert.equal(colorKind('01'), 'mohar');
assert.equal(colorKind('W023'), 'alpaca');
assert.equal(colorKind(''), 'unknown');

// ---------- isYarnName ----------
assert.equal(isYarnName('Пряжа кид мохер,БОРДОВЫЙ'), true, '俄文 пряж 关键词');
assert.equal(isYarnName('ПРЯЖА из шерсти альпаки'), true, '大小写不敏感');
assert.equal(isYarnName('T-shirt cotton'), false, '非毛线商品');

// ---------- 排序器按 kind 分段 ----------
// 构造混合测试样本：
//   - A 马海毛 1 件单色
//   - B 马海毛 2 件单色
//   - C 羊驼毛 1 件单色
//   - D 混种订单（kind=mixed）
//   - E 羊驼毛 2 件单色
const samples = [
  { pn: 'E', kind: 'alpaca', color_kinds: 1, total_qty: 2, first_color: 'W001' },
  { pn: 'D', kind: 'mixed', color_kinds: 2, total_qty: 3, first_color: '05' },
  { pn: 'C', kind: 'alpaca', color_kinds: 1, total_qty: 1, first_color: 'W023' },
  { pn: 'B', kind: 'mohar', color_kinds: 1, total_qty: 2, first_color: '01' },
  { pn: 'A', kind: 'mohar', color_kinds: 1, total_qty: 1, first_color: '18' },
];
const sorted = sortYarnOrderRows(samples);
const order = sorted.map((r) => r.pn).join(',');
assert.equal(order, 'A,B,C,E,D',
  `kind 分段 + 件数升序：mohar(A,B) → alpaca(C,E) → mixed(D), got ${order}`);

// 无 kind 字段时（例如未升级的旧调用）：排在最后，但不报错
const legacyMix = [
  { pn: 'X', color_kinds: 1, total_qty: 1, first_color: '01' },  // 无 kind
  { pn: 'A', kind: 'mohar', color_kinds: 1, total_qty: 1, first_color: '01' },
  { pn: 'C', kind: 'alpaca', color_kinds: 1, total_qty: 1, first_color: 'W001' },
];
const sortedLegacy = sortYarnOrderRows(legacyMix);
assert.equal(sortedLegacy.map(r => r.pn).join(','), 'A,C,X', '无 kind 的排在最后');

// mixed 内部也按件数 → 色号 → pn
const mixedOnly = [
  { pn: 'M2', kind: 'mixed', color_kinds: 2, total_qty: 3, first_color: '01' },
  { pn: 'M1', kind: 'mixed', color_kinds: 3, total_qty: 2, first_color: '05' },
];
assert.equal(
  sortYarnOrderRows(mixedOnly).map(r => r.pn).join(','),
  'M1,M2',
  'mixed 内部按件数升序',
);

console.log('yarn kinds + sort kind-aware: OK');
