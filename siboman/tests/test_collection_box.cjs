const fs = require('fs');
const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const view = fs.readFileSync(path.join(root, 'public/js/views/CollectionBox.js'), 'utf8');
const duplicateFixture = require('./fixtures/collection_duplicate_contract.json');

function extractServerFunction(name, endMarker) {
  const start = server.indexOf(`function ${name}(`);
  assert(start >= 0, `missing server function ${name}`);
  if (endMarker) {
    const endByMarker = server.indexOf(endMarker, start);
    assert(endByMarker > start, `missing end marker for server function ${name}`);
    return new Function(`${server.slice(start, endByMarker).trim()}; return ${name};`)();
  }
  let depth = 0;
  let end = -1;
  for (let i = start; i < server.length; i += 1) {
    if (server[i] === '{') depth += 1;
    if (server[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert(end > start, `could not extract server function ${name}`);
  return new Function(`${server.slice(start, end)}; return ${name};`)();
}

assert.strictEqual((server.match(/app\.post\("\/api\/collect-items"/g) || []).length, 1, 'collect POST must have one canonical route');
assert.strictEqual((server.match(/app\.get\("\/api\/collect-items"/g) || []).length, 1, 'collect GET must have one canonical route');
assert(server.includes('collectionOnly: true'));
assert(server.includes('enable1688: false'));
assert(server.includes("SET status = 'failed'"));
assert(server.includes("status = 'scraped'"));
assert(server.includes('app.post("/api/collect-items/bulk-delete", requireAuth'));
assert(server.includes('if (req.params.id === "bulk-delete") return next();'));
assert(server.includes('app.post("/api/collect-items/:id/retry", requireAuth'));
assert(server.includes('source_url_1688 TEXT NOT NULL'));
assert(server.includes("status <> 'ignored'"));
assert(server.includes("reason','采集完成'"));
assert(server.includes('linked_job_id=$1'));
assert(server.includes("reason','启动时发现孤立任务'"));
assert(server.includes('/\\/product\\/(\\d+)'));

const parseCollectInputs = extractServerFunction('parseCollectInputs', '\napp.delete("/api/collect-items/:id"');
const parsedDuplicates = parseCollectInputs(duplicateFixture.manualInputs.join('\n'));
assert.deepStrictEqual(parsedDuplicates, duplicateFixture.expectedParsed, 'fixture URLs and SKU inputs must keep a stable parsed contract');
assert.strictEqual(new Set(parsedDuplicates.map((row) => row.ozonSku)).size, 2, 'fixture must include repeated SKU inputs for duplicate coverage');

assert(server.includes('const extensionItems = Array.isArray(req.body?.items) ? req.body.items : []'), 'extension fixture path must remain local payload based');
assert(server.includes('const ozonSku = String(item.sku || item.product_id || item.offer_id || "").trim()'), 'extension payload must normalize SKU from all collector aliases');
assert(server.includes('const ozonUrl = String(item.ozon_url || item.source_url || (ozonSku ? `https://www.ozon.ru/product/${ozonSku}/` : ""))'), 'extension payload must normalize source URL aliases');
assert(server.includes('AND (($2 <> \'\' AND ozon_sku = $2) OR ($3 <> \'\' AND ozon_url = $3))'), 'duplicate lookup must match by SKU or URL');
assert(server.includes('if (exists.rows[0].status !== "uploaded")'), 'uploaded duplicate rows must not be overwritten');
assert(server.includes("reason','插件数据合并'"), 'extension duplicate merge must be logged');
assert(server.includes('status=\'scraped\', note=\'\''), 'extension duplicate merge must refresh non-uploaded rows to scraped and clear stale notes');
assert(server.includes('skipped.push({ source: ozonSku || ozonUrl, reason: exists.rows[0].status === "uploaded" ? "已上架" : "已合并更新" })'), 'extension duplicate merge must be reported as skipped/merged');
assert(server.includes('skipped.push({ source: row.sourceValue, reason: existing.status === "uploaded" ? "已上架" : "已存在" })'), 'manual duplicate rows must be skipped instead of inserted');
for (const item of duplicateFixture.extensionItems) {
  assert(item.sku || item.product_id || item.offer_id, 'extension duplicate fixture must carry a SKU alias');
  assert(item.ozon_url || item.source_url, 'extension duplicate fixture must carry a URL alias');
}

for (const status of ['all', 'pending', 'scraped', 'uploaded', 'failed', 'ignored']) {
  assert(view.includes(`value: '${status}'`), `missing collection status ${status}`);
}
assert(view.includes('@selection-change="onSelectionChange"'));
assert(view.includes("'/api/collect-items/bulk-delete'"));
assert(view.includes('statusCounts'));
assert(view.includes('row.note'));
assert(view.includes('重新采集'));
assert(view.includes('rowFailureReason'), 'collection failures must be explained in list and drawer');
assert(view.includes('statusDescriptions'), 'collection statuses must have user-readable descriptions');
assert(view.includes('导出 CSV'));
assert(view.includes('source_url_1688'));
assert(view.includes('@input="onSearchInput"'));
assert(view.includes('保存采集资料'));
assert(view.includes('保存采集资料只写入本地采集箱'), 'draft edit must explain it is local only');
assert(view.includes('deleteItem'), 'single record deletion must be available');
assert(view.includes('axios.delete(`/api/collect-items/${row.id}`)'), 'single deletion must use the guarded DELETE route');
assert(view.includes('删除采集项'), 'single deletion must require explicit confirmation');
assert(view.includes('sendToListing'), 'collection items must expose a listing handoff entrance');
assert(view.includes('collection_box_listing_prefill'), 'listing handoff must persist local prefill data without submitting Ozon');
assert(view.includes("window.location.hash = '#/upload'"), 'listing handoff must navigate to the batch upload route');
assert(view.includes('不会自动提交 Ozon'), 'listing handoff must clearly avoid real publishing');
assert(view.includes('v-if="row.main_image"'));

console.log('Collection box structural checks passed.');
