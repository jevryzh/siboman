const fs = require('fs');
const assert = require('assert');

const server = fs.readFileSync(new URL('../server.js', `file://${__filename}`).pathname, 'utf8');
const productView = fs.readFileSync(new URL('../public/js/views/ProductList.js', `file://${__filename}`).pathname, 'utf8');

const requiredStatuses = [
  'ALL',
  'VISIBLE',
  'READY_TO_SUPPLY',
  'NEED_ATTENTION',
  'NOT_MODERATED',
  'FAILED_MODERATION',
  'IN_ACTIVE',
];

for (const status of requiredStatuses) {
  assert(productView.includes(`value: '${status}'`), `missing product tab ${status}`);
}

assert(server.includes('if (moderate === "rejected") return "FAILED_MODERATION";'));
assert(server.includes('return "NOT_MODERATED";'));
assert(server.includes('status_counts'));
assert(server.includes('compliance_issues'));

assert(productView.includes('@selection-change="onSelectionChange"'));
assert(productView.includes('selectedRows.value.length > 100'));
assert(productView.includes("'/api/seller/products/archive'"));
assert(productView.includes('copyOfferId'));
assert(productView.includes('exportCsv'));
assert(productView.includes("'\\ufeff'"), 'CSV export must include a UTF-8 BOM');
assert(productView.includes("'/api/seller/images/generate'"), 'AI image refinement must use the real generator');
assert(!server.includes('/api/ai/refine-image'), 'legacy image passthrough stub must be removed');
assert(productView.includes('保存并同步价格/图片'), 'product editor must describe its real sync scope');
assert(server.includes('sync_results: syncResults'), 'product update must report each downstream sync result');
assert(server.includes('价格同步失败：'), 'Ozon price errors must not be swallowed');
assert(productView.includes('source_url_1688'), 'product editor must maintain the procurement URL');
assert(server.includes('ADD COLUMN IF NOT EXISTS source_url_1688'), 'product schema must store procurement URLs');
assert(productView.includes("'purchase_price_cny', 'weight'"), 'numeric database values must be normalized for number inputs');

console.log('Product management structural checks passed.');
