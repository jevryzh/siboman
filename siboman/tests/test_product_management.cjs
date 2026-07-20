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

console.log('Product management structural checks passed.');
