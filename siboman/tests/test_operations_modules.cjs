const fs = require('fs');
const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const inventory = fs.readFileSync(path.join(root, 'public/js/views/InventoryManagement.js'), 'utf8');
const orders = fs.readFileSync(path.join(root, 'public/js/views/OrderList.js'), 'utf8');
const listing = fs.readFileSync(path.join(root, 'public/js/views/ListingHistory.js'), 'utf8');

for (const table of ['app_stock_drafts', 'app_stock_change_logs']) assert(server.includes(`CREATE TABLE IF NOT EXISTS ${table}`));
for (const route of [
  '/api/seller/stocks/drafts',
  '/api/seller/stocks/save-draft',
  '/api/seller/stocks/import',
  '/api/seller/products/stocks/bulk',
]) assert(server.includes(route), `missing route ${route}`);
assert(server.includes('drafts.slice(index, index + 100)'));
assert(server.includes('fetchLiveStocksByOffer'));
assert(server.includes('code: "STOCK_CONFLICT"'));
assert(server.includes("'conflict'"));
assert(inventory.includes('submitAllDrafts'));
assert(inventory.includes('saveStockDrafts'));
assert(inventory.includes('inventoryLowStockThreshold'));
assert(inventory.includes('inventoryStats'));
assert(inventory.includes('window.XLSX'));
assert(inventory.includes('exportReplenishment'));
assert(inventory.includes('submitWithConflictCheck'));
assert(inventory.includes('发现 Ozon 实时库存冲突'));
assert(server.includes('app.post("/api/seller/stocks/import", requireAuth'));
assert(server.includes('app.patch("/api/products/:offer_id/field", requireAuth'));

assert(server.includes('ON CONFLICT (store_id, posting_number)'));
assert(server.includes('CREATE TABLE IF NOT EXISTS app_order_ship_events'));
assert(server.includes('app.post("/api/seller/orders/labels", requireAuth'));
assert(server.includes('inventoryAdjusted'));
assert(server.includes('当前 Ozon Seller API 未提供可靠的逐节点物流轨迹'));
assert(orders.includes('batchShip'));
assert(orders.includes('exportOrders'));
assert(orders.includes('printLabels'));
assert(orders.includes('saveNote'));
assert(orders.includes("row.status !== 'cancelled'"));
assert(orders.includes('source_url_1688'), 'orders must expose the product procurement link');

assert(listing.includes("params.set('store_id', getStoreId())"));
assert(listing.includes('syncTask'));
assert(listing.includes('pagination.currentPage'));
assert(server.includes("lh.task_id ILIKE"));
assert(server.includes("interval '1 day'"));

console.log('Inventory, orders, and listing history structural checks passed.');
