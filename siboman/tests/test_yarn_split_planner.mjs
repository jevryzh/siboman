// Accio Work (2026-11-20) v2.2.9.229
// 拆单+分包发货 算法测试：覆盖用户真实样本案例（HappyFriday 6 单）。
//
// 对应需求：
//   Q1: 金额按 Σ price × qty
//   Q2: 单件超阈值放行
//   Q3: C 策略 - 子单数最少，同色优先、剩的碎件混色凑数
//   阈值: 135 CNY，毛线判定 'пряж'

import assert from 'node:assert/strict';
import { planOrderSplit, evaluateOrder, SPLIT_THRESHOLD } from '../lib/yarn-split-planner.js';

const PRYAJA = 'Пряжа кид мохер, 4 мотка'; // 马海毛名字（含 пряж）
const ALPACA_NAME = 'Пряжа из шерсти альпаки для вязания'; // 羊驼毛名字
const NON_YARN = '10 кусочков Концевой выключатель ME-8169';

// helper
function mkProd(sku, offer_id, name, qty, price) {
  return { sku, offer_id, name, quantity: qty, price: { amount: String(price), currency: 'CNY' } };
}

// ============== Case 1: 非毛线订单 跳过 ==============
{
  const order = { products: [mkProd(1001, 'SW-001', NON_YARN, 17, 20)] };
  const plan = planOrderSplit(order);
  assert.equal(plan.skipped, true, 'non-yarn must be skipped');
  assert.match(plan.reason, /非毛线/);
  console.log('Case 1 OK: 非毛线 → 跳过');
}

// ============== Case 2: 毛线但金额 ≤ 135 跳过 ==============
{
  // 2 件 × 45 = 90
  const order = { products: [mkProd(2001, 'jz-xxx-18', PRYAJA, 2, 45)] };
  const plan = planOrderSplit(order);
  assert.equal(plan.skipped, true);
  assert.match(plan.reason, /无需拆分/);
  console.log('Case 2 OK: 2 件 × 45 = 90 ≤ 135 → 跳过');
}

// ============== Case 3: 单色 5 件 = 225 → 拆 3+2 两包 ==============
{
  // 02252442-0109-2
  const order = { products: [mkProd(3001, 'jz-xxx-26', PRYAJA, 5, 45)] };
  const plan = planOrderSplit(order);
  assert.equal(plan.skipped, false);
  assert.equal(plan.packages.length, 2, 'should split into 2 packs');
  assert.equal(plan.packages[0].total_qty, 3);
  assert.equal(plan.packages[0].total_price, 135);
  assert.equal(plan.packages[1].total_qty, 2);
  assert.equal(plan.packages[1].total_price, 90);
  assert.equal(plan.packages[0].is_mixed_color, false);
  console.log('Case 3 OK: 同色 5×45=225 → 2 包 (3+2)');
}

// ============== Case 4: 单色 4 件 = 180 → 拆 3+1 两包 ==============
{
  // 0122208475-0440-1
  const order = { products: [mkProd(4001, 'jz-xxx-11', PRYAJA, 4, 45)] };
  const plan = planOrderSplit(order);
  assert.equal(plan.packages.length, 2);
  assert.equal(plan.packages[0].total_qty, 3);
  assert.equal(plan.packages[1].total_qty, 1);
  console.log('Case 4 OK: 同色 4×45=180 → 2 包 (3+1)');
}

// ============== Case 5: 混色 3+1 = 180 → 天然 2 包 ==============
{
  // 81625564-0181-2: -08×3 | -21×1
  const order = { products: [
    mkProd(5001, 'jz-xxx-08', PRYAJA, 3, 45),
    mkProd(5002, 'jz-xxx-21', PRYAJA, 1, 45),
  ]};
  const plan = planOrderSplit(order);
  assert.equal(plan.packages.length, 2);
  // 08×3 满包
  const pack0 = plan.packages.find((p) => p.products.some((pp) => pp.offer_id === 'jz-xxx-08'));
  assert.equal(pack0.total_qty, 3);
  assert.equal(pack0.is_mixed_color, false);
  // 21×1 单独包
  const pack1 = plan.packages.find((p) => p.products.some((pp) => pp.offer_id === 'jz-xxx-21'));
  assert.equal(pack1.total_qty, 1);
  console.log('Case 5 OK: -08×3 + -21×1 → 2 包');
}

// ============== Case 6: 两色各 3 件 = 270 → 天然各自满包 ==============
{
  // 74016203-0335-3
  const order = { products: [
    mkProd(6001, 'jz-xxx-03', PRYAJA, 3, 45),
    mkProd(6002, 'jz-xxx-13', PRYAJA, 3, 45),
  ]};
  const plan = planOrderSplit(order);
  assert.equal(plan.packages.length, 2);
  for (const p of plan.packages) {
    assert.equal(p.total_price, 135);
    assert.equal(p.is_mixed_color, false);
  }
  console.log('Case 6 OK: -03×3 + -13×3 → 2 单色满包');
}

// ============== Case 7: 两色各 4 件 = 360 → C 策略 3 包 ==============
{
  // 28353057-0561-1: -28×4 + -29×4
  // C 策略目标：-28×3 + -29×3 + (28×1+29×1 混色)
  const order = { products: [
    mkProd(7001, 'jz-xxx-28', PRYAJA, 4, 45),
    mkProd(7002, 'jz-xxx-29', PRYAJA, 4, 45),
  ]};
  const plan = planOrderSplit(order);
  assert.equal(plan.packages.length, 3, '28×4 + 29×4 应该拆成 3 包');
  const soloPacks = plan.packages.filter((p) => !p.is_mixed_color);
  const mixedPacks = plan.packages.filter((p) => p.is_mixed_color);
  assert.equal(soloPacks.length, 2, '应有 2 个同色满包');
  assert.equal(mixedPacks.length, 1, '应有 1 个混色小包');
  for (const p of soloPacks) { assert.equal(p.total_qty, 3); assert.equal(p.total_price, 135); }
  assert.equal(mixedPacks[0].total_qty, 2);
  assert.equal(mixedPacks[0].total_price, 90);
  console.log('Case 7 OK: -28×4 + -29×4 → 3 包 (28×3 | 29×3 | 28×1+29×1 混色)');
}

// ============== Case 8: 8 色 11 件 = 495 → C 策略 4 包 ==============
{
  // 0110495562-0309-1
  // -01×1 -04×1 -08×1 -10×1 -18×2 -20×1 -22×3 -28×1
  const order = { products: [
    mkProd(8001, 'jz-xxx-01', PRYAJA, 1, 45),
    mkProd(8002, 'jz-xxx-04', PRYAJA, 1, 45),
    mkProd(8003, 'jz-xxx-08', PRYAJA, 1, 45),
    mkProd(8004, 'jz-xxx-10', PRYAJA, 1, 45),
    mkProd(8005, 'jz-xxx-18', PRYAJA, 2, 45),
    mkProd(8006, 'jz-xxx-20', PRYAJA, 1, 45),
    mkProd(8007, 'jz-xxx-22', PRYAJA, 3, 45),
    mkProd(8008, 'jz-xxx-28', PRYAJA, 1, 45),
  ]};
  const plan = planOrderSplit(order);
  // 期望 4 包：22×3（同色满）+ 3 个混色每包 3 件 - 但 11 件 ÷ 3 = 4 包
  assert.equal(plan.packages.length, 4, '11 件应该拆 4 包');
  // 验证每包 ≤ 135
  for (const p of plan.packages) assert.ok(p.total_price <= 135, `每包金额 ≤ 135，实际 ${p.total_price}`);
  // 验证总件数
  const totalQty = plan.packages.reduce((s, p) => s + p.total_qty, 0);
  assert.equal(totalQty, 11);
  // 验证 22×3 应该是同色满包
  const pack22 = plan.packages.find((p) => p.products.some((pp) => pp.offer_id === 'jz-xxx-22'));
  assert.equal(pack22.total_qty, 3);
  console.log('Case 8 OK: 8 色 11 件 → 4 包，22×3 为同色满包');
}

// ============== Case 9: 羊驼毛（60 元）两色 → 应正确识别为 alpaca ==============
{
  // 0140559692-0048-2: W023×1 + W901×1 = 120
  const order = { products: [
    mkProd(9001, 'ALPACA-YARN-W023-2PCS', ALPACA_NAME, 1, 60),
    mkProd(9002, 'ALPACA-YARN-W901-2PCS', ALPACA_NAME, 1, 60),
  ]};
  const plan = planOrderSplit(order);
  // 总金额 120 ≤ 135，不拆
  assert.equal(plan.skipped, true);
  console.log('Case 9 OK: 羊驼毛 60+60=120 ≤ 135 → 跳过');
}

// ============== Case 10: 混种订单（马海毛+羊驼毛）> 135 → 按 kind 独立装箱 ==============
{
  // 虚构：马海毛 3 件 135 + 羊驼毛 2 件 120 = 255 > 135
  const order = { products: [
    mkProd(10001, 'jz-xxx-18', PRYAJA, 3, 45), // 马海毛 135
    mkProd(10002, 'ALPACA-YARN-W023-2PCS', ALPACA_NAME, 2, 60), // 羊驼毛 120
  ]};
  const plan = planOrderSplit(order);
  // 马海毛独立一包 135（≤ 阈值），羊驼毛独立一包 120 → 共 2 包
  assert.equal(plan.packages.length, 2);
  const mohar = plan.packages.find((p) => p.products.some((pp) => pp.kind === 'mohar'));
  const alpaca = plan.packages.find((p) => p.products.some((pp) => pp.kind === 'alpaca'));
  assert.ok(mohar);
  assert.ok(alpaca);
  assert.equal(mohar.is_mixed_kind, false);
  assert.equal(alpaca.is_mixed_kind, false);
  console.log('Case 10 OK: 混种 mohar+alpaca → 按 kind 各一包');
}

// ============== Case 11: 单件超阈值放行（Q2=B）==============
{
  // 虚构 180 元一件毛线，2 件
  const order = { products: [mkProd(11001, 'jz-big', PRYAJA, 2, 180)] };
  const plan = planOrderSplit(order);
  // 单件 180 > 135 → 每件 1 包
  assert.equal(plan.packages.length, 2);
  assert.equal(plan.packages[0].total_qty, 1);
  assert.equal(plan.packages[0].total_price, 180);
  console.log('Case 11 OK: 单件 180 > 阈值 → 2 件分 2 包');
}

// ============== evaluateOrder 直接校验 ==============
{
  assert.equal(evaluateOrder({ products: [mkProd(1, 'x', NON_YARN, 10, 20)] }).eligible, false);
  assert.equal(evaluateOrder({ products: [mkProd(1, 'x', PRYAJA, 3, 45)] }).eligible, false); // 135 不拆
  assert.equal(evaluateOrder({ products: [mkProd(1, 'x', PRYAJA, 4, 45)] }).eligible, true);  // 180 拆
  console.log('evaluateOrder boundary OK');
}

console.log('\nAll yarn-split-planner tests passed');
