const fs = require('fs');
const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const view = fs.readFileSync(path.join(root, 'public/js/views/AIImageGenerator.js'), 'utf8');

assert(view.includes("'/api/seller/images/generate'"), 'UI must call the real MiniMax endpoint');
assert(!view.includes("'/api/ai/product-image-set/generate'"), 'UI must not call the retired hanging endpoint');
assert(!server.includes('generate_OLD_MOCK'), 'legacy mock image endpoint must not be exposed');
assert(server.includes('app.get("/api/utils/download-proxy", requireAuth'), 'download proxy must require authentication');
assert(server.includes('assertSafeExternalUrl'), 'download proxy must reject unsafe network targets');
assert(view.includes("'/api/seller/images/publish-to-ozon'"), 'AI images must support publishing to Ozon');
assert(server.includes('app.post("/api/seller/images/publish-to-ozon", requireAuth'), 'publish endpoint must require authentication');
assert(server.includes('"/v1/product/pictures/import"'), 'publish endpoint must call the real Ozon picture API');
assert(view.includes('subject_reference'));
assert(view.includes("['1:1', '3:4', '9:16']"));
assert(view.includes('batchDownload'));
assert(view.includes("'/api/ai-images/history'"));
assert(view.includes('historyStats'));

assert(server.includes('app.get("/api/ai-images/history", requireAuth'));
assert(server.includes('app.delete("/api/ai-images/:id", requireAuth'));
assert(server.includes('await ensureUploadsDir()'));
assert(server.includes('`/uploads/${filename}`'));
assert(server.includes('INSERT INTO ai_image_records (user_id, store_id'));
assert(server.includes('const aiImageActiveByUser = new Map()'));
assert(server.includes('生成图永久保存失败'));
assert(server.includes('ozon_sync_status = TRUE'));
assert(view.includes("publish_mode: 'append'"));
assert(view.includes('追加到原图册'));
assert(view.includes('cropMaterial'));
assert(view.includes('loadHistoryResult'));
assert(view.includes('loadMoreHistory'));
assert(view.includes("id: 'gift'"), 'AI image templates should cover a complete ecommerce scene set');

console.log('AI image generator structural checks passed.');
