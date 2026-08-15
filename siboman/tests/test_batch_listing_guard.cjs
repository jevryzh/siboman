const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const server = read('server.js');
const batch = read('public/js/views/BatchUpload.js');
const listing = read('public/js/views/ListingHistory.js');
const store = read('public/js/views/StoreManagement.js');
const manifestText = read('public/extension/zhumeng-collector/manifest.json');
const background = read('public/extension/zhumeng-collector/background.js');
const manifest = JSON.parse(manifestText);

function matchVersion(source, pattern, label) {
  const match = source.match(pattern);
  assert(match, `missing ${label}`);
  return match[1];
}

function readZipEntry(zipPath, entryName) {
  return childProcess.execFileSync('unzip', ['-p', zipPath, entryName], { encoding: 'utf8' });
}

const backgroundVersion = matchVersion(background, /const VERSION = "([^"]+)"/, 'background VERSION');
const requiredBackgroundVersion = matchVersion(batch, /REQUIRED_BACKGROUND_VERSION = "([^"]+)"/, 'required background version');
const manifestUiVersion = matchVersion(store, /PLUGIN_MANIFEST_VERSION\s*=\s*['"]([^'"]+)/, 'store management manifest version');
const zipUiVersion = matchVersion(store, /PLUGIN_ZIP_VERSION\s*=\s*['"]([^'"]+)/, 'store management zip version');
const zipManifest = JSON.parse(readZipEntry(path.join(root, 'public/extension/zhumeng-collector.zip'), 'manifest.json'));
const zipBackgroundVersion = matchVersion(
  readZipEntry(path.join(root, 'public/extension/zhumeng-collector.zip'), 'background.js'),
  /const VERSION = "([^"]+)"/,
  'zip background VERSION',
);

assert.strictEqual(manifest.version, backgroundVersion, 'manifest version must equal background VERSION');
assert.strictEqual(manifestUiVersion, manifest.version, 'store management manifest version must equal manifest version');
assert.strictEqual(zipUiVersion, manifest.version, 'store management zip version must equal manifest version');
assert.strictEqual(zipManifest.version, manifest.version, 'zip manifest version must equal source manifest version');
assert.strictEqual(zipBackgroundVersion, backgroundVersion, 'zip background VERSION must equal source background VERSION');
assert(compareVersions(backgroundVersion, requiredBackgroundVersion) >= 0, 'background version must satisfy BatchUpload minimum version');

for (const needle of [
  'ensureFreshPlugin',
  'compareVersion(bg, REQUIRED_BACKGROUND_VERSION) < 0',
  'const canUsePortal = false',
  '复制源卡片',
  "importMode === 'sku'",
  'collectViaExtension',
  'collectTimeoutMs',
  'ensureRowsCollected',
  'createBatchListingPlaceholders',
  'updateBatchListingPlaceholder',
  '_listingPlaceholders',
  '_listingRowKey',
  'row_key: row._listingRowKey',
  '/api/seller/listing-history/batch-start',
  '/api/seller/listing-history/batch-progress',
  'listingPlaceholderTaskId',
  'runPublishBatch',
  '已提交后台流程',
  'oneClickPublish',
  '一键解析+采集+上架',
  'portalImportViaExtension',
  'buildV3Item',
  'richContent: d.richContent ||',
  'descriptionCategoryId: d.description_category_id',
  'typeId: d.type_id',
  'const images = (d.images || []).filter',
  'if(!d.images||!d.images.length)',
  'skuPrefix',
  'normalizeSkuPrefix',
  'offer_id: buildOfferIdForRow(row)',
  'const offerId = buildOfferIdForRow(row)',
  'SKU 前缀',
  'itemForStore._warehouse_id = whId',
  'warehouse_id: whId',
  'stocks: storeStocks.filter',
  'appendLog(`  ⚠ [${storeName}] 已忽略不属于该店铺的旧仓库配置',
  "window.location.hash = '#/listing-history'",
  '这不是创建完成',
  'collection_box_listing_prefill',
  'consumeCollectionPrefill',
  'collectionPrefill.value?.item?.id',
  'listingPlaceholderTaskId: placeholderForRow(storeId, row)',
  '不会自动提交 Ozon',
]) {
  assert(batch.includes(needle), `BatchUpload protection missing: ${needle}`);
}

for (const needle of [
  'sourceVariantAttributesToImportAttrs',
  'extractSourceVariantImages',
  'injectRichContentAttribute(item, sourceVariant)',
  'normalizeImportImageList(item.images)',
  'item.description_category_id = Number(categoryId)',
  'if (typeId) item.type_id = Number(typeId)',
  'description_category_id=${categoryId} 是 5位公开 URL cat',
  'const ozonPayload = { items: [item] }',
  'ozonPayload.stocks = ozonStocks',
  'raw_payload',
  'stocks: ozonStocks || rawStocks || []',
  'callOzonSellerAPI("/v1/product/import-by-sku"',
  'stockDeferred: rawStocks?.length || 0',
  'mark uploaded after import-by-sku',
  'status = $1, errors_json = $2::jsonb',
  'translateOzonListingError',
  'enrichListingErrors',
  '/api/seller/listing-history/export',
  '/api/seller/listing-history/:id/retry',
  '/api/seller/listing-history/batch-start',
  '/api/seller/listing-history/batch-progress',
  'batch-upload-placeholder',
  'row_key',
  "('queued','claimed','running','processing','pending','moderating','ozon_processing')",
]) {
  assert(server.includes(needle), `server protection missing: ${needle}`);
}

for (const needle of [
  "store_id: getStoreId() || undefined",
  "axios.get('/api/seller/listing-history', { params })",
  'displayStatus',
  'syncTask',
  'retryTask',
  'exportHistory',
  'row.task_id',
  'errors_json',
  'message_zh',
  '每 30s 自动刷新',
  '同步状态',
  "startsWith('batch-')",
]) {
  assert(listing.includes(needle), `ListingHistory protection missing: ${needle}`);
}

for (const needle of [
  'result._plugin_version = VERSION',
  'result.images.length',
  'result.description_category_id',
  'result.type_id',
  'result.richContent',
  'rich-content.11254',
  'resolveSellerCategory',
  'enrichFromSellerPortalBundle',
  'collectRichContentFromOzonPage',
  'msg.action === "portalImport"',
  'upload_task_id',
]) {
  assert(background.includes(needle), `extension protection missing: ${needle}`);
}

for (const host of [
  'https://test.renwz.cn/*',
  'https://xm.renwz.cn/*',
  'https://seller.ozon.ru/*',
  'https://api-seller.ozon.ru/*',
]) {
  assert(manifest.host_permissions.includes(host), `manifest host permission missing: ${host}`);
}

function compareVersions(a, b) {
  const left = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
  const right = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0);
  }
  return 0;
}

console.log('Batch listing protection guard passed.');
console.log(`Version tuple: manifest=${manifest.version}, background=${backgroundVersion}, required=${requiredBackgroundVersion}, zip=${zipManifest.version}`);
