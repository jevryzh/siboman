// Accio Work (2026-11-07)
// 防回归：syncCacheRange 的 Ozon 同步链路必须对每页 batch 做"兄弟 posting 补全"
// 否则同一订单 -1 同步到了、-3 被漏（因为 Ozon /v4/posting/fbs/list 的 since/to
// 过滤是按每条 posting 自身的变更时间戳，不是按订单整体）。
//
// 这是一个静态代码断言测试：检查 server.js 里兄弟补全机制的关键组件都在，
// 不运行同步链路（那要 mock 整个 Ozon API + DB，成本太重，另有 e2e 覆盖）。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, "..", "server.js");
const src = readFileSync(serverPath, "utf8");

// 1) syncCacheRange 必须存在且调用 probeSiblingsForBatch
assert.ok(
  /const syncCacheRange = async \(/.test(src),
  "syncCacheRange must exist",
);
assert.ok(
  /await probeSiblingsForBatch\(batch\)/.test(src),
  "syncCacheRange must invoke probeSiblingsForBatch after upsertOrderCache",
);

// 2) 必须有 probeSiblingsForBatch 函数，且走 /v3/posting/fbs/get 拿 related_postings
assert.ok(
  /const probeSiblingsForBatch = async \(batch\)/.test(src),
  "probeSiblingsForBatch function must be defined",
);
assert.ok(
  /\/v3\/posting\/fbs\/get/.test(src),
  "sibling probe must call /v3/posting/fbs/get",
);
assert.ok(
  /related_postings:\s*true/.test(src),
  "sibling probe must request related_postings:true in the `with` field",
);

// 3) 兄弟 posting_number 的差集识别：必须读取 related_posting_numbers
assert.ok(
  /related_posting_numbers/.test(src),
  "sibling diff must read related_posting_numbers from response",
);

// 4) run 级去重 Set（避免跨页重复探测）
assert.ok(
  /seenInRun\s*=\s*new Set\(\)/.test(src),
  "run-level seenInRun Set must exist",
);

// 5) 并发池 + 硬上限（防限流爆炸）
assert.ok(
  /PROBE_CONCURRENCY\s*=\s*\d+/.test(src),
  "PROBE_CONCURRENCY constant must be defined",
);
assert.ok(
  /BACKFILL_HARD_CAP\s*=\s*\d+/.test(src),
  "BACKFILL_HARD_CAP constant must be defined to cap per-run backfill",
);
const capMatch = src.match(/BACKFILL_HARD_CAP\s*=\s*(\d+)/);
assert.ok(
  capMatch && Number(capMatch[1]) > 0 && Number(capMatch[1]) <= 10000,
  `BACKFILL_HARD_CAP must be a sensible positive int, got ${capMatch?.[1]}`,
);

// 6) 补抓的 posting 必须走 enrichPostings + upsertOrderCache（和主链路同口径）
const probeFnMatch = src.match(/const probeSiblingsForBatch = async \(batch\)[\s\S]*?\n {6}\};/);
assert.ok(probeFnMatch, "probeSiblingsForBatch body must be matchable");
const probeBody = probeFnMatch[0];
assert.ok(
  /await enrichPostings\(/.test(probeBody),
  "sibling backfill must call enrichPostings (same pipeline as main sync)",
);
assert.ok(
  /await upsertOrderCache\(/.test(probeBody),
  "sibling backfill must call upsertOrderCache",
);

// 7) 日志必须带 siblings_probed / backfilled 指标，否则部署后无法观测
assert.ok(
  /siblings_probed=\$\{probedTotal\}\s+backfilled=\$\{backfilledTotal\}/.test(src),
  "sync log line must report siblings_probed and backfilled counts",
);

// 8) 错误容忍：兄弟探测失败不能抛出中断主同步链路
assert.ok(
  /try\s*\{\s*\n\s*await probeSiblingsForBatch\(batch\)/.test(src),
  "probeSiblingsForBatch call must be wrapped in try/catch so a failure cannot crash the main sync",
);

console.log("yarn sibling backfill guard: OK");
