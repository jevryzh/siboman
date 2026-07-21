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
assert(server.includes('function productStatusDisplay'), 'product read APIs must expose Chinese status labels');
assert(server.includes('status_display: productStatusDisplay(row.status, row.status_name)'), 'product rows must include additive status_display');
assert(server.includes('status_hint: productStatusHint(row.status)'), 'product rows must include additive status_hint');
assert(server.includes('category_readonly'), 'product rows must expose category ids as read-only context');
assert(server.includes('stock_readonly'), 'product rows must expose stock as read-only context');
assert(server.includes('warehouse_summary'), 'product rows must expose warehouse summary context');
assert(server.includes('return res.status(400).json({ success: false, error: "不支持的商品状态" });'), 'product list must reject unsupported status filters');

assert(productView.includes('@selection-change="onSelectionChange"'));
assert(productView.includes('selectedRows.value.length > 100'));
assert(productView.includes("'/api/seller/products/archive'"));
assert(productView.includes('copyOfferId'));
assert(productView.includes('exportCsv'));
assert(productView.includes("'/api/seller/products/export'"), 'CSV export must cover the full filtered result');
assert(server.includes("app.post(\"/api/seller/products/export\""), 'filtered product export endpoint is required');
assert(productView.includes('onSearchInput'), 'product search should be debounced');
assert(server.includes('app.patch("/api/products/:offer_id/field", requireAuth, updateProductField)'), 'legacy field route must share the guarded handler');
assert(server.includes('WHERE user_id = $1 AND store_id = $2 AND offer_id = $3'), 'product field updates must verify ownership');
assert(productView.includes("'/api/seller/images/generate'"), 'AI image refinement must use the real generator');
assert(!server.includes('/api/ai/refine-image'), 'legacy image passthrough stub must be removed');
assert(productView.includes('保存并同步价格/图片'), 'product editor must describe its real sync scope');
assert(productView.includes('syncFieldsNote'), 'product editor must explain local save and Ozon sync boundary');
assert(productView.includes('statusHint'), 'product statuses must have user-readable hints');
assert(productView.includes('statusCn'), 'product statuses must have Chinese operator-facing labels');
assert(productView.includes('productStatusLabel(row)'), 'product table must show Chinese status labels, not raw Ozon status text');
assert(productView.includes('Ozon 原始状态'), 'raw Ozon status should remain available as diagnostic context');
assert(productView.includes('issueSummary(row)'), 'moderation and compliance failures must be visible in the list');
assert(productView.includes('失败/处理原因'), 'product list must expose failed moderation or attention reasons');
assert(productView.includes('重新上架确认'), 'unarchive action must require confirmation');
assert(productView.includes('查看货源'), 'product list must keep a visible 1688 procurement entrance');
assert(productView.includes('productPreviewList(row)'), 'product images must be clickable and preview the full gallery');
assert(productView.includes('cursor:zoom-in'), 'product image preview must visually indicate zoom');
assert(productView.includes('当前总库存'), 'product editor must show stock as read-only context');
assert(!productView.includes('<el-form-item label="10. 库存">'), 'product editor must not present stock as an editable product field');
assert(productView.includes(":props=\"{ label: 'label', value: 'category_key'"), 'category cascader must use stable category keys instead of names only');
assert(productView.includes('description_category_id'), 'product editor must preserve Ozon description category id');
assert(productView.includes('syncCategoryPathFromForm'), 'product editor must preselect the current category after category tree loading');
assert(server.includes('sync_results: syncResults'), 'product update must report each downstream sync result');
assert(server.includes('价格同步失败：'), 'Ozon price errors must not be swallowed');
assert(productView.includes('source_url_1688'), 'product editor must maintain the procurement URL');
assert(server.includes('ADD COLUMN IF NOT EXISTS source_url_1688'), 'product schema must store procurement URLs');
assert(server.includes('category_name, description_category_id, type_id, price_index'), 'product list must return category ids for editor prefill');
assert(productView.includes("'purchase_price_cny', 'weight'"), 'numeric database values must be normalized for number inputs');

console.log('Product management structural checks passed.');
