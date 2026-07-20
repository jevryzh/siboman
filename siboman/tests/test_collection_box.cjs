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

for (const status of ['all', 'pending', 'scraped', 'uploaded', 'failed', 'ignored']) {
  assert(view.includes(`value: '${status}'`), `missing collection status ${status}`);
}
assert(view.includes('@selection-change="onSelectionChange"'));
assert(view.includes("'/api/collect-items/bulk-delete'"));
assert(view.includes('statusCounts'));
assert(view.includes('row.note'));

console.log('Collection box structural checks passed.');
