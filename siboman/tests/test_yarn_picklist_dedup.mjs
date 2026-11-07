// Accio Work (2026-11-07)
// 防回归：拣货单/标签 SQL 必须对"同一 posting 被多个 store 同步"去重。
// 旧 bug：items CTE 直接从 app_order_cache 做 CROSS JOIN LATERAL + SUM，
//   同一订单被两个 store 存了一份 → total_qty 翻倍、排序错乱。
// 本测试用 in-memory 模拟 DB 调用，只断言 SQL 包含去重 CTE 和正确字段名。
// 这样即便未来有人回到老写法，也会被测试挡下来。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, "..", "server.js");
const src = readFileSync(serverPath, "utf8");

// 1) 三处共享 SQL 的路由必须都存在
const endpoints = [
  "/api/seller/orders/yarn-picklist-export",
  "/api/seller/orders/yarn-sorted-postings",
  "/api/seller/orders/yarn-labels",
];
for (const ep of endpoints) {
  assert.ok(src.includes(ep), `endpoint ${ep} must remain registered`);
}

// 2) 必须使用 unique_postings CTE（按 posting_number 去重，取 synced_at 最新）
const uniqueCteCount = (src.match(/WITH unique_postings AS \(/g) || []).length;
assert.ok(
  uniqueCteCount >= 3,
  `unique_postings CTE must appear in at least 3 places for picklist/sorted/labels, got ${uniqueCteCount}`,
);

const distinctOnCount = (src.match(/SELECT DISTINCT ON \(c\.posting_number\)/g) || []).length;
assert.ok(
  distinctOnCount >= 3,
  `DISTINCT ON (c.posting_number) dedup must appear in at least 3 places, got ${distinctOnCount}`,
);

const orderBySyncedCount = (src.match(/ORDER BY c\.posting_number, c\.synced_at DESC NULLS LAST/g) || []).length;
assert.ok(
  orderBySyncedCount >= 3,
  `ORDER BY c.posting_number, c.synced_at DESC must appear in at least 3 places, got ${orderBySyncedCount}`,
);

// 3) items 聚合必须跑在 unique_postings 之上，而不是直接从 app_order_cache 展开
//    关键信号：items CTE 的 FROM 必须是 unique_postings u（旧实现是 app_order_cache c）
const itemsFromUniqueCount = (src.match(/FROM unique_postings u\s*\n\s*CROSS JOIN LATERAL jsonb_array_elements/g) || []).length;
assert.ok(
  itemsFromUniqueCount >= 3,
  `items CTE must CROSS JOIN LATERAL on unique_postings (not raw app_order_cache), got ${itemsFromUniqueCount}`,
);

// 4) 旧实现特征：禁止在**毛线拣货单/标签路径**里直接 FROM app_order_cache + LATERAL +
//    按 posting_number 聚合 quantity + ILIKE '%пряж%' 一步到位。只针对"按 posting 聚合数量"
//    的毛线 SQL（拣货单 / 标签路径），不误伤 /pending-sku-export 这种按 SKU 聚合的其它接口。
const oldYarnPatternRe =
  /FROM app_order_cache c\s*\n\s*CROSS JOIN LATERAL jsonb_array_elements\(COALESCE\(c\.payload->'products'[\s\S]{0,400}c\.posting_number AS pn[\s\S]{0,400}пряж/g;
const oldYarnPatternCount = (src.match(oldYarnPatternRe) || []).length;
assert.equal(
  oldYarnPatternCount,
  0,
  `legacy pattern "yarn picklist/label items CTE directly over app_order_cache (posting-level)" must not reappear (regression of 01×2 bug)`,
);

// 5) 毛线拣货/标签三处 SQL 的 user_id 兜底必须已删除（本次合并后统一按 store_id 过滤）。
//    检查范围限定在 yarn-sorted-postings 路由附近 ±800 字符（这是唯一曾有 user_id 兜底的地方），
//    避免误伤 /pending-sku-export 这类独立接口自己的 c.user_id 过滤。
const sortedIdx = src.indexOf('"/api/seller/orders/yarn-sorted-postings"');
assert.ok(sortedIdx > 0, "yarn-sorted-postings endpoint must exist");
const sortedBlock = src.slice(sortedIdx, sortedIdx + 2000);
assert.ok(
  !/c\.user_id\s*=\s*\$1/.test(sortedBlock) && !/sharedIds\.length\s*\?\s*sharedIds\s*:\s*req\.user\.id/.test(sortedBlock),
  `user_id = $1 fallback should be removed from yarn-sorted-postings`,
);

console.log("yarn picklist dedup guard: OK");
