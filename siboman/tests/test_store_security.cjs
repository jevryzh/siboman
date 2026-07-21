const fs = require('fs');
const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const storeView = fs.readFileSync(path.join(root, 'public/js/views/StoreManagement.js'), 'utf8');
const shopSwitcher = fs.readFileSync(path.join(root, 'public/js/components/ShopSwitcher.js'), 'utf8');
const inventoryView = fs.readFileSync(path.join(root, 'public/js/views/InventoryManagement.js'), 'utf8');
const orderView = fs.readFileSync(path.join(root, 'public/js/views/OrderList.js'), 'utf8');
const listingView = fs.readFileSync(path.join(root, 'public/js/views/ListingHistory.js'), 'utf8');
const productView = fs.readFileSync(path.join(root, 'public/js/views/ProductList.js'), 'utf8');
const apiDoc = fs.readFileSync(path.join(root, 'docs/api/store-security-baseline.md'), 'utf8');
const securityDoc = fs.readFileSync(path.join(root, 'docs/security/plugin-credentials-audit.md'), 'utf8');

function extractBetween(startNeedle, endNeedle, label) {
  const start = server.indexOf(startNeedle);
  assert(start >= 0, `missing ${label} start`);
  const end = server.indexOf(endNeedle, start + startNeedle.length);
  assert(end > start, `missing ${label} end`);
  return server.slice(start, end);
}

const serializer = extractBetween('function serializeStoreForFrontend', 'function normalizeStoreAiProvider', 'store serializer');
assert(serializer.includes('client_id_masked: maskSecret(clientId)'), 'store serializer must expose masked Client ID');
assert(serializer.includes('client_id_last4:'), 'store serializer must expose last4 for compact UI');
assert(!serializer.includes('api_key'), 'store serializer must never expose api_key');
assert(!serializer.includes('client_id:'), 'store serializer must not expose raw client_id');

const listRoute = extractBetween('app.get("/api/seller/shops"', 'app.post("/api/seller/shops"', 'shop list route');
assert(listRoute.includes('WHERE user_id = $1'), 'shop list must be scoped by user_id');
assert(listRoute.includes('res.setHeader("Cache-Control", "no-store")'), 'shop list must disable response caching');
assert(listRoute.includes('result.rows.map(serializeStoreForFrontend)'), 'shop list must serialize sensitive fields');

const createRoute = extractBetween('app.post("/api/seller/shops"', 'app.patch("/api/seller/shops/:id/settings"', 'shop create route');
assert(createRoute.includes('ON CONFLICT (user_id, client_id)'), 'shop upsert must be unique per user and Client ID');
assert(createRoute.includes('api_key = $4'), 'shop create must save api_key server-side');
assert(createRoute.includes('serializeStoreForFrontend(result.rows[0])'), 'shop create response must serialize sensitive fields');
assert(createRoute.includes('ai_image_provider') && createRoute.includes('ai_image_model'), 'shop create must persist AI defaults');

const settingsRoute = extractBetween('app.patch("/api/seller/shops/:id/settings"', 'app.delete("/api/seller/shops/:id"', 'shop settings route');
assert(settingsRoute.includes('WHERE id = $3 AND user_id = $4'), 'shop settings update must verify store ownership');
assert(settingsRoute.includes('watermark_enabled = $1'), 'shop settings must save watermark_enabled');
assert(settingsRoute.includes('ai_image_provider = $5'), 'shop settings must save AI provider default');
assert(settingsRoute.includes('ai_image_model = $6'), 'shop settings must save AI model default');
assert(settingsRoute.includes('serializeStoreForFrontend(result.rows[0])'), 'shop settings response must serialize sensitive fields');

const scopedAccess = extractBetween('function enforceScopedWorkerAccess', 'function isSecureRequest', 'scoped worker access guard');
assert(scopedAccess.includes('pathName === "/api/collect-items"'), 'scoped token must allow collector submit only on collect-items');
assert(scopedAccess.includes('hasScopedWorkerScope(req.user, "collector:submit")'), 'collector submit must require collector scope');
assert(scopedAccess.includes('requestedStoreId && requestedStoreId !== tokenStoreId'), 'collector submit must reject cross-store payloads');
assert(scopedAccess.includes('req.body.store_id = tokenStoreId'), 'collector submit must bind omitted store_id to token store');
assert(scopedAccess.includes('pathName === "/api/worker/jobs/next"'), 'scoped token must allow worker polling');
assert(scopedAccess.includes('SCOPED_TOKEN_FORBIDDEN'), 'scoped token must be denied on ordinary ERP APIs');
assert(!scopedAccess.includes('/api/worker/plugin-token'), 'scoped token must not mint long-lived worker plugin tokens');

const scopedVerifier = extractBetween('function verifyScopedWorkerToken', 'function maskSecret', 'scoped worker token verifier');
assert(scopedVerifier.includes('payload.type !== "plugin-worker"'), 'scoped token verifier must reject non-worker token types');
assert(scopedVerifier.includes('Number(payload.exp || 0) < Date.now()'), 'scoped token verifier must reject expired tokens');
assert(scopedVerifier.includes('safeEqual(signature, expected)'), 'scoped token verifier must use timing-safe signature comparison');

const authUser = extractBetween('async function getAuthenticatedUser', 'async function isAuthenticated', 'auth token resolver');
assert(authUser.includes('if (token.startsWith("scoped."))'), 'auth resolver must branch scoped tokens explicitly');
assert(authUser.includes('tokenType: payload.type'), 'auth resolver must mark scoped worker token type');
assert(authUser.includes('tokenStoreId: payload.storeId || ""'), 'auth resolver must carry scoped token store id');

const pluginTokenRoute = extractBetween('app.post("/api/v1/plugin/tokens"', '// v2.1:', 'plugin token route');
assert(pluginTokenRoute.includes('assertActiveStoreAccess(storeId, req.user.id, "id, name")'), 'plugin token route must verify active store ownership');
assert(pluginTokenRoute.includes('scope: ["collector:submit", "worker:poll"]'), 'plugin token must carry worker scope');
assert(pluginTokenRoute.includes('storeId: store.id'), 'plugin token response must be store-scoped');
assert(pluginTokenRoute.includes('res.setHeader("Cache-Control", "no-store")'), 'plugin token response must disable caching');
assert(!pluginTokenRoute.includes('apiKey') && !pluginTokenRoute.includes('api_key'), 'plugin token route must not return Ozon API keys');
assert(!pluginTokenRoute.includes('clientId') && !pluginTokenRoute.includes('client_id'), 'plugin token route must not return Ozon Client ID');

const legacyRoute = extractBetween('app.get("/api/extension/seller-credentials"', '/* ============================================================\n   采集与找货', 'legacy credentials route');
assert(server.includes('ALLOW_LEGACY_EXTENSION_SELLER_CREDENTIALS || "true"'), 'legacy credential route must stay default-open until plugin migration');
assert(legacyRoute.includes('if (!ALLOW_LEGACY_EXTENSION_SELLER_CREDENTIALS)'), 'legacy credential route must have a kill switch');
assert(legacyRoute.includes('assertActiveStoreAccess(storeId, req.user.id, "id, name, client_id, api_key")'), 'legacy route must verify active store ownership');
assert(legacyRoute.includes('maskSecret(store.client_id)'), 'legacy route logs only masked client_id');
assert(legacyRoute.includes('replacement: "/api/v1/plugin/tokens"'), 'legacy route must advertise plugin token replacement');

const claimNextDbJob = extractBetween('async function claimNextDbJob', 'function normalizeWorkerStatus', 'worker claim function');
assert(claimNextDbJob.includes('const tokenStoreId = isScopedWorkerUser(user)'), 'worker claim must detect scoped worker users');
assert(claimNextDbJob.includes('j.user_id = $1'), 'worker claim must remain user-scoped');
assert(claimNextDbJob.includes('AND ($3::uuid IS NULL OR j.store_id = $3::uuid)'), 'scoped worker claim must filter by token store');
assert(claimNextDbJob.includes('FOR UPDATE SKIP LOCKED'), 'worker claim must keep queue locking');

const getDbJobForUser = extractBetween('async function getDbJobForUser', 'async function updateDbJob', 'worker job lookup');
assert(getDbJobForUser.includes('user?.role !== "admin"'), 'ordinary job lookup must be user-scoped');
assert(getDbJobForUser.includes('isScopedWorkerUser(user)'), 'job lookup must treat scoped workers specially');
assert(getDbJobForUser.includes('j.store_id = $'), 'scoped worker job lookup must be store-scoped');

const dangerousUiConfirmations = [
  [inventoryView, '发现 Ozon 实时库存冲突', 'inventory conflict overwrite must be confirmed'],
  [inventoryView, '确定将 ${drafts.value.length} 条库存草稿提交到 Ozon？', 'bulk stock submit must be confirmed'],
  [inventoryView, '确定清空当前店铺全部库存草稿？', 'draft clearing must be confirmed'],
  [orderView, '不可逆的发货操作', 'bulk ship must be confirmed as irreversible'],
  [listingView, '确认删除选中的 ${selectedIds.value.length} 条记录?', 'listing batch delete must be confirmed'],
  [listingView, '重试失败的上架任务', 'listing retry must be confirmed'],
  [productView, '批量归档确认', 'bulk archive must be confirmed'],
  [productView, '保存并同步价格/图片', 'product edit UI must label Ozon sync clearly'],
];
for (const [source, needle, label] of dangerousUiConfirmations) {
  assert(source.includes(needle), label);
}

assert(securityDoc.includes('Backend strong-confirmation fields are not yet standardized'), 'security audit must document missing backend strong confirmation');
assert(securityDoc.includes('Before Commercial Launch'), 'security audit must state commercial launch gates');

assert(server.includes("ALTER TABLE app_stores ADD COLUMN IF NOT EXISTS ai_image_provider TEXT NOT NULL DEFAULT '';"), 'store DDL must include ai_image_provider');
assert(server.includes("ALTER TABLE app_stores ADD COLUMN IF NOT EXISTS ai_image_model TEXT NOT NULL DEFAULT '';"), 'store DDL must include ai_image_model');
assert(server.includes('SELECT id, ai_image_model FROM app_stores WHERE id = $1 AND user_id = $2 AND active = TRUE'), 'AI generation must verify store ownership before using store defaults');
assert(server.includes('const requestedModel = String(reqModel || storeAiModel || "").trim()'), 'AI generation must use request model before store default');
assert(server.includes('AND ($3::uuid IS NULL OR j.store_id = $3::uuid)'), 'scoped worker job claims must be store-filtered');
assert(server.includes('where += ` AND j.store_id = $${params.length}`'), 'scoped worker job lookup must be store-filtered');

for (const source of [storeView, shopSwitcher]) {
  assert(source.includes('displayClientId'), 'store UI must use a client id display helper');
  assert(source.includes('client_id_masked'), 'store UI must prefer backend masked Client ID');
  assert(source.includes('client_id_last4'), 'store UI must support backend last4 fallback');
}

assert(apiDoc.includes('`client_id_masked`') && apiDoc.includes('`client_id_last4`'), 'store security API doc must document masked Client ID fields');
assert(apiDoc.includes('`ai_image_provider`') && apiDoc.includes('`ai_image_model`'), 'store security API doc must document AI defaults');
assert(apiDoc.includes('legacy route remains default-open'), 'store security API doc must state the current compatibility choice');
assert(securityDoc.includes('default-open compatibility window'), 'security audit must document legacy default-open risk');
assert(!apiDoc.match(/Api-Key:\s*[A-Za-z0-9_-]{8,}/), 'store API doc must not contain real-looking API keys');

console.log('Store security baseline checks passed.');
