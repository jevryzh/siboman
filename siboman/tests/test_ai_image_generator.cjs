const fs = require('fs');
const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const view = fs.readFileSync(path.join(root, 'public/js/views/AIImageGenerator.js'), 'utf8');
const aiJsonFixture = require('./fixtures/ai_json_cleanup_contract.json');

function extractServerFunction(name, endMarker) {
  const start = server.indexOf(`function ${name}(`);
  assert(start >= 0, `missing server function ${name}`);
  if (endMarker) {
    const endByMarker = server.indexOf(endMarker, start);
    assert(endByMarker > start, `missing end marker for server function ${name}`);
    return new Function(`${server.slice(start, endByMarker).trim()}; return ${name};`)();
  }
  let depth = 0;
  let end = -1;
  for (let i = start; i < server.length; i += 1) {
    if (server[i] === '{') depth += 1;
    if (server[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert(end > start, `could not extract server function ${name}`);
  return new Function(`${server.slice(start, end)}; return ${name};`)();
}

function assertAiAnalyzeShape(parsed, requiredKeys) {
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'AI JSON must parse to an object');
  for (const key of requiredKeys) {
    assert(Object.prototype.hasOwnProperty.call(parsed, key), `AI JSON fixture missing ${key}`);
  }
  assert(Array.isArray(parsed.selling_points), 'AI selling_points must remain an array');
}

assert(view.includes("'/api/seller/images/generate'"), 'UI must call the real image generation endpoint');
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
assert(server.includes('await ensureUploadDir()'));
assert(server.includes('DASHSCOPE_IMAGE_MODEL'));
assert(server.includes('/services/aigc/multimodal-generation/generation'));
assert(server.includes('TOKENDUN_IMAGE_MODEL'));
assert(server.includes('`${TOKENDUN_BASE_URL}/images/generations`'));
assert(server.includes('`${TOKENDUN_BASE_URL}/images/edits`'));
assert(server.includes('Buffer.from(value, "base64")'));
assert(server.includes('TokenDun 失败，切换备用供应商'));
assert(server.includes('AGNES_IMAGE_MODEL'));
assert(server.includes('process.env.AI_IMAGE_PROVIDER || "agnes"'), 'server must default image provider to Agnes');
assert(server.includes('`${AGNES_BASE_URL}/images/generations`'));
assert(server.includes('Agnes 失败，切换 TokenDun'));
assert(server.includes('providerAttempts'), 'server response must expose provider fallback attempts');
assert(server.includes('businessCode !== 0'));
assert(server.includes('function parseAiJsonObject(rawContent)'));
assert(server.includes('...buildMiniMaxThinkingOptions(MINIMAX_THINKING_TYPE)'));
assert(server.includes('category_name: String(parsed.category_name || parsed.product_type || "").trim()'));
assert(server.includes('description: String(parsed.description || "").trim()'));
assert(server.includes('.replace(/<think>[\\s\\S]*?<\\/think>/gi, "")'), 'AI parser must strip think blocks');
assert(server.includes('.replace(/```(?:json)?|```/gi, "")'), 'AI parser must strip markdown code fences');
assert(server.includes('for (const start of starts)'), 'AI parser must scan for embedded JSON objects in noisy text');
assert(server.includes('try { return JSON.parse(cleaned); } catch { return null; }'), 'AI parser must reject incomplete JSON as null');
assert(server.includes('把下面内容整理成合法 JSON'), 'AI analyze must attempt one structured JSON repair');
assert(server.includes('return res.status(502).json({ success: false, error: "AI 分析结果格式异常，请重新生成"'), 'AI analyze must fail closed when JSON remains invalid');
assert(server.includes('selling_points: Array.isArray(parsed.selling_points) ? parsed.selling_points.slice(0, 6) : []'), 'AI analyze must structurally normalize selling points');
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
assert(view.includes('r.data?.data?.images'), 'UI must read generated images from the server response contract');
assert(view.includes("model: 'agnes-image-2.0-flash'"), 'AI image UI must default to Agnes 2.0');
assert(view.includes('默认 provider：<strong>Agnes 2.0</strong>'), 'AI image UI must show the Agnes default provider');
assert(view.includes('TokenDun → 万相 → MiniMax'), 'AI image UI must show fallback order');
assert(view.includes('generationFailure'), 'AI image UI must expose failure reason state');
assert(view.includes('generationAttempts'), 'AI image UI must expose provider attempts');
assert(view.includes('generationDescription'), 'AI image UI must summarize provider fallback results');
assert(view.includes('analyzeFailure'), 'AI analyze failures must stay visible in the form');
assert(view.includes('target_market: form.target_market'), 'AI analyze must receive the selected target market');
assert(view.includes('目标市场会传给 AI 分析'), 'AI image UI must explain how target market affects analysis');
assert(view.includes('providerLabel(row.model)'), 'AI image history must expose the provider used');
assert(view.includes('暂无生成结果。上传素材并点击生成套图后，图片会显示在这里。'), 'AI image results must have a clear empty state');
assert(view.includes('暂无生成历史。生成成功后会记录 provider、费用和是否推送到 Ozon。'), 'AI image history must have a clear empty state');
assert(view.includes('已推送到 Ozon 的图片不会被删除'), 'AI image history deletion must explain Ozon impact before deleting');

const parseAiJsonObject = extractServerFunction('parseAiJsonObject', '\napp.post("/api/ai/analyze"');
for (const testCase of aiJsonFixture.cases) {
  const parsed = parseAiJsonObject(testCase.raw);
  if (testCase.valid) {
    assertAiAnalyzeShape(parsed, aiJsonFixture.requiredKeys);
  } else {
    assert.strictEqual(parsed, null, `${testCase.name} must fail closed instead of leaking malformed JSON`);
  }
}

console.log('AI image generator structural checks passed.');
