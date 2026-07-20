const fs = require('fs');
const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const view = fs.readFileSync(path.join(root, 'public/js/views/AIImageGenerator.js'), 'utf8');

assert(view.includes("'/api/seller/images/generate'"), 'UI must call the real MiniMax endpoint');
assert(!view.includes("'/api/ai/product-image-set/generate'"), 'UI must not call the retired hanging endpoint');
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

console.log('AI image generator structural checks passed.');
