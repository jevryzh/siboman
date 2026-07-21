const fs = require('fs');
const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const compatDoc = fs.readFileSync(path.join(root, 'docs/api/v1-compatibility-plan.md'), 'utf8');
const securityDoc = fs.readFileSync(path.join(root, 'docs/security/plugin-credentials-audit.md'), 'utf8');

assert(server.includes('const AI_IMAGE_PROVIDER = String(process.env.AI_IMAGE_PROVIDER || "agnes")'), 'Agnes must be the default image provider');
assert(server.includes('const AI_IMAGE_PROVIDER_ORDER = ["agnes", "tokendun", "wanxiang", "minimax"]'), 'AI provider order must be Agnes -> TokenDun -> Wanxiang -> MiniMax');
assert(server.includes('Agnes 失败，切换 TokenDun'), 'Agnes failures must visibly fall back to TokenDun');
assert(server.includes('TokenDun 失败，切换备用供应商'), 'TokenDun failures must visibly fall back');
assert(server.includes('万相失败，切换 MiniMax'), 'Wanxiang failures must visibly fall back to MiniMax');
assert(server.includes('未配置 DASHSCOPE_API_KEY，跳过万相并切换 MiniMax'), 'missing Wanxiang config must not stop MiniMax fallback');
assert(server.includes('app.get("/api/v1/ai/images/providers", requireAuth'), 'v1 provider config route is required');
assert(server.includes('app.post("/api/v1/ai/images/generate", requireAuth, handleAiImageGenerate)'), 'v1 AI image generation alias is required');

assert(server.includes('function createScopedWorkerToken'), 'short scoped worker token issuer is required');
assert(server.includes('function verifyScopedWorkerToken'), 'short scoped worker token verifier is required');
assert(server.includes('app.post("/api/v1/plugin/tokens", requireAuth'), 'v1 plugin token route is required');
assert(server.includes('PLUGIN_WORKER_TOKEN_TTL_MS'), 'plugin worker token TTL must be configurable');
assert(server.includes('ALLOW_LEGACY_EXTENSION_SELLER_CREDENTIALS'), 'legacy seller credential route must have a kill switch');
assert(server.includes('Cache-Control", "no-store"'), 'credential/token responses must disable caching');
assert(server.includes('replacement: "/api/v1/plugin/tokens"'), 'legacy credential response must advertise the replacement route');
assert(server.includes('maskSecret(store.client_id)'), 'legacy credential logging must mask client id');

assert(server.includes('const LISTING_STATUS_CONTRACT = ["queued", "claimed", "running", "ozon_processing", "partial_success", "success", "failed", "cancelled"]'), 'listing status contract enum is required');
assert(server.includes('function listingStatusToContractStatus'), 'listing status mapping helper is required');
assert(server.includes('status_canonical: listingStatusToContractStatus'), 'listing history must expose canonical status additively');
assert(server.includes('app.get("/api/v1/listings/status-contract", requireAuth'), 'v1 listing status contract route is required');
assert(server.includes('pending: "ozon_processing"'), 'legacy pending must map to ozon_processing');
assert(server.includes('imported: "success"'), 'legacy imported must map to success');

assert(compatDoc.includes('Do not change current batch upload payload shape'), 'compatibility plan must preserve batch upload payload shape');
assert(compatDoc.includes('/api/extension/seller-credentials'), 'compatibility plan must cover legacy plugin credentials');
assert(compatDoc.includes('/api/v1/plugin/tokens'), 'compatibility plan must name the v1 plugin token route');
assert(securityDoc.includes('Current risk is high while the legacy endpoint is enabled'), 'security audit must state the credential exposure risk');
assert(securityDoc.includes('ALLOW_LEGACY_EXTENSION_SELLER_CREDENTIALS=false'), 'security audit must document the legacy credential shutoff');
assert(!securityDoc.match(/Api-Key:\s*[A-Za-z0-9_-]{8,}/), 'security audit must not contain real-looking API keys');

console.log('Backend contract and security structural checks passed.');
