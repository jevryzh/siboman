const fs = require('fs');
const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const view = fs.readFileSync(path.join(root, 'public/js/views/CollectionBox.js'), 'utf8');

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

for (const status of ['all', 'pending', 'scraped', 'uploaded', 'failed', 'ignored']) {
  assert(view.includes(`value: '${status}'`), `missing collection status ${status}`);
}
assert(view.includes('@selection-change="onSelectionChange"'));
assert(view.includes("'/api/collect-items/bulk-delete'"));
assert(view.includes('statusCounts'));
assert(view.includes('row.note'));
assert(view.includes('重新采集'));
assert(view.includes('导出 CSV'));
assert(view.includes('source_url_1688'));
assert(view.includes('@input="onSearchInput"'));
assert(view.includes('保存采集资料'));
assert(view.includes('v-if="row.main_image"'));

console.log('Collection box structural checks passed.');
