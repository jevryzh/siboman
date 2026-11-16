// Accio Work (2026-11-15) 「导出毛线订单区间统计」纯函数单元测试
// 不依赖 fflate；只测试 extractColor / colorKind / isYarnProduct / aggregateYarnRange / buildSkuRows / formatBeijingMinute
import assert from "node:assert/strict";
import {
  extractColor, colorKind, isYarnProduct,
  aggregateYarnRange, buildSkuRows, formatBeijingMinute,
  MOHAR_PER_QTY, ALPACA_PER_QTY, MOHAR_UNIT_PRICE, ALPACA_UNIT_PRICE,
} from "../lib/yarn-range-export.js";

// 1. extractColor
assert.equal(extractColor("jz-260624fwg3-4736604207-01"), "01");
assert.equal(extractColor("jz-260624fwg3-4736604207-18"), "18");
assert.equal(extractColor("ALPACA-YARN-W023-2PCS"), "W023", "ALPACA 的最后段 2PCS 不是色号，应回退到 W023");
assert.equal(extractColor("ALPACA-YARN-W023"), "W023");
assert.equal(extractColor(""), "");
assert.equal(extractColor("nothing-matching"), "");

// 2. colorKind
assert.equal(colorKind("01"), "mohar");
assert.equal(colorKind("38"), "mohar");
assert.equal(colorKind("W023"), "alpaca");
assert.equal(colorKind("w023"), "alpaca", "colorKind 大小写不敏感");
assert.equal(colorKind("AB"), "unknown");
assert.equal(colorKind(""), "unknown");

// 3. isYarnProduct
assert.equal(isYarnProduct({ name: "Пряжа кид мохер, ТЁМНО-ЗЕЛЁНЫЙ, 4 мотка" }), true);
assert.equal(isYarnProduct({ name: "Пряжа из шерсти альпаки" }), true);
assert.equal(isYarnProduct({ name: "ПРЯЖА" }), true);
assert.equal(isYarnProduct({ name: "Hat" }), false);
assert.equal(isYarnProduct({}), false);

// 4. aggregateYarnRange + buildSkuRows + 核心换算
const sampleOrders = [
  {
    posting_number: "60924891-0216-1", in_process_at: "2026-11-14T10:00:00Z",
    products: [
      { offer_id: "jz-260624fwg3-4736604207-10", name: "Пряжа кид мохер, ...", quantity: 1 },
    ],
  },
  {
    posting_number: "25332899-0085-1", in_process_at: "2026-11-14T08:00:00Z",
    products: [
      { offer_id: "jz-260624fwg3-4736604207-27", name: "Пряжа кид мохер, ...", quantity: 2 },
      { offer_id: "jz-260624fwg3-4736604207-29", name: "Пряжа кид мохер, ...", quantity: 2 },
    ],
  },
  {
    posting_number: "64775068-0396-1", in_process_at: "2026-11-14T09:00:00Z",
    products: [
      { offer_id: "ALPACA-YARN-W023-2PCS", name: "Пряжа из шерсти альпаки", quantity: 2 },
    ],
  },
  {
    posting_number: "99999999-0000-0", in_process_at: "2026-11-14T11:00:00Z",
    products: [ // 非毛线，不应纳入
      { offer_id: "hat-001", name: "Winter Hat", quantity: 5 },
    ],
  },
  {
    posting_number: "0181382556-0129-1", in_process_at: "2026-11-14T10:00:00Z",
    products: [
      { offer_id: "jz-260624fwg3-4736604207-01", name: "Пряжа кид мохер, ...", quantity: 2 },
    ],
  },
];
const { skuAgg, orderDetails } = aggregateYarnRange(sampleOrders);
// 非毛线订单不应出现
assert.equal(orderDetails.find((o) => o.posting_number === "99999999-0000-0"), undefined);
assert.equal(orderDetails.length, 4);

// SKU 聚合
assert.equal(skuAgg.get("jz-260624fwg3-4736604207-10")?.qty, 1);
assert.equal(skuAgg.get("jz-260624fwg3-4736604207-27")?.qty, 2);
assert.equal(skuAgg.get("jz-260624fwg3-4736604207-01")?.qty, 2);
assert.equal(skuAgg.get("ALPACA-YARN-W023-2PCS")?.qty, 2);

const { mohar, alpaca } = buildSkuRows(skuAgg);
// 换算
const m01 = mohar.find((r) => r.color === "01");
assert.equal(m01.qty, 2);
assert.equal(m01.totalCount, 2 * MOHAR_PER_QTY, "马海毛 #01 总个数 = 2×4 = 8");
assert.equal(MOHAR_PER_QTY, 4);
assert.equal(ALPACA_PER_QTY, 2);
assert.equal(MOHAR_UNIT_PRICE, 3.3);
assert.equal(ALPACA_UNIT_PRICE, 4.5);
const a023 = alpaca.find((r) => r.color === "W023");
assert.equal(a023.qty, 2);
assert.equal(a023.totalCount, 2 * ALPACA_PER_QTY, "羊驼毛 #W023 总个数 = 2×2 = 4");
// 马海按色号数值升序
assert.deepEqual(mohar.map((r) => r.color), ["01", "10", "27", "29"]);

// Sheet2 排序：接收时间降序
assert.equal(orderDetails[0].posting_number, "0181382556-0129-1", "11:00 不在数据里，10:00 最早首位应为字典序靠前的 0181…");
// 同为 10:00 的两条：posting_number 升序 → 0181…/60924…
assert.equal(orderDetails[0].posting_number, "0181382556-0129-1");
assert.equal(orderDetails[1].posting_number, "60924891-0216-1");
// 多色号的订单明细文本，色号字典序拼接
const multi = orderDetails.find((o) => o.posting_number === "25332899-0085-1");
assert.equal(multi.detailText, "#27x2, #29x2");

// 5. formatBeijingMinute
const t = formatBeijingMinute("2026-11-14T10:35:00Z");
assert.equal(t, "2026-11-14 18:35", "UTC 10:35 → 北京 18:35");
assert.equal(formatBeijingMinute(""), "");
assert.equal(formatBeijingMinute(null), "");

console.log("yarn range export units: OK");
