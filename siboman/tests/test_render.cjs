// Real Vue3 render test
const fs = require('fs');
const path = require('path');

(async () => {
  const { JSDOM } = require('/Users/eason/Documents/逐梦 ERP/siboman/node_modules/jsdom');
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.HTMLElement = dom.window.HTMLElement;
  global.SVGElement = dom.window.SVGElement;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  global.localStorage = dom.window.localStorage;
  global.AbortController = class { constructor() { this.signal = {}; } abort() {} };
  global.setTimeout = setTimeout;
  global.clearTimeout = clearTimeout;
  global.setInterval = setInterval;
  global.clearInterval = clearInterval;
  global.requestAnimationFrame = (fn) => setTimeout(fn, 16);
  global.cancelAnimationFrame = (id) => clearTimeout(id);

  // Load Vue3 from a local copy
  const Vue = require('/Users/eason/Documents/逐梦 ERP/siboman/node_modules/vue');
  global.Vue = Vue;
  console.log('Vue loaded:', typeof Vue.createApp);
  const buCode = fs.readFileSync(
    '/Users/eason/Documents/逐梦 ERP/siboman/public/js/views/BatchUpload.js',
    'utf8'
  );
  // Convert const/let to globals to allow IIFE-style use
  const sandboxed = new Function('window', 'document', 'localStorage', 'Vue', 'AbortController', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console', 'Date', 'JSON', 'Math', 'RegExp', 'Error', 'Promise', 'Object', 'Array', 'Number', 'String', 'Boolean', 'Symbol', 'Map', 'Set', buCode + '; return window.BatchUploadView;');
  const BatchUploadView = sandboxed(global.window, global.document, global.localStorage, global.Vue, global.AbortController, setTimeout, clearTimeout, setInterval, clearInterval, console, Date, JSON, Math, RegExp, Error, Promise, Object, Array, Number, String, Boolean, Symbol, Map, Set);

  if (!BatchUploadView) { console.error('BatchUploadView not exposed'); process.exit(1); }

  // Inject style element manually
  const styleMatch = buCode.match(/injectBatchUploadStyles[\s\S]+?\)\(\);/);
  if (styleMatch) {
    try { eval(styleMatch[0]); } catch (e) {}
  }

  // Mount with mock items to test stats + modal
  const app = global.Vue.createApp(BatchUploadView);
  // Add a small mock for store + axios
  const vm = app.mount('#app');

  // Set mock items + category resolved states
  vm.items = [
    { index: 1, sku: '111111', valid: true, distilled: { name: 'Test', descriptionCategoryId: 17028710 }, _category_resolved: { confidence: 'high', to: 17028710, source: 'similar-name-same-store' } },
    { index: 2, sku: '222222', valid: true, distilled: { name: 'Test 2' }, _category_resolved: { confidence: 'medium', to: 17028650, candidates: [{ description_category_id: 17028650, name: 'Чехлы', count: 69 }, { description_category_id: 17027904, name: 'Аксессуары', count: 35 }] } },
    { index: 3, sku: '333333', valid: true, distilled: { name: 'Test 3' }, _category_resolved: { confidence: 'none', to: 0, candidates: [
      { description_category_id: 17027899, name: 'Бижутерные украшения', count: 107 },
      { description_category_id: 17028650, name: 'Чехлы', count: 69 },
      { description_category_id: 17028647, name: 'Аксессуары для фото- и видеотехники', count: 66 },
      { description_category_id: 53968796, name: 'Аксессуары и запчасти для бытовой техники', count: 58 },
    ] } },
    { index: 4, sku: '444444', valid: true, distilled: { name: 'Test 4' }, _category_resolved: { confidence: 'manual', to: 17028664, source: 'manual-candidate-pick' } },
  ];

  await new Promise(r => setTimeout(r, 100));
  // Re-render via $nextTick
  await global.Vue.nextTick();

  const html = document.getElementById('app').innerHTML;

  const checks = {
    'Stats card rendered': html.includes('类目状态') && html.includes('共 4 件已采商品'),
    'high badge (高 1)': html.includes('高 1'),
    'medium badge (中 1)': html.includes('中 1'),
    'manual badge (已选 1)': html.includes('已选 1'),
    'none badge (未选 1)': html.includes('未选 1'),
    'Russian name rendered (Бижутерные украшения)': html.includes('Бижутерные украшения'),
    'Russian name (Чехлы)': html.includes('Чехлы'),
    'Table 列 类目 (v2.2.2)': html.includes('类目 (v2.2.2)'),
    'High confidence row badge': html.includes('✓ 高置信'),
    'Medium confidence row badge': html.includes('⚠ 中置信'),
    'None row select button': html.includes('选类目 (4)'),
    'Modal hidden initially (no transition body)': !html.includes('选类目 — #'),
  };

  console.log('=== Real Vue3 Render Test ===\n');
  let allOk = true;
  for (const [k, v] of Object.entries(checks)) {
    console.log(`  ${v ? '✓' : '✗'} ${k}`);
    if (!v) allOk = false;
  }

  // Now open the modal for row 3
  console.log('\n--- Opening modal for row 3 ---');
  vm.openCategoryPicker(vm.items[2]);
  await global.Vue.nextTick();
  const html2 = document.getElementById('app').innerHTML;
  const modalChecks = {
    'Modal title visible': html2.includes('选类目 — #3 333333'),
    'Modal candidate name (Бижутерные украшения)': html2.includes('Бижутерные украшения'),
    'Modal candidate count (📊 107 件)': html2.includes('📊 107 件'),
    'Modal candidate count (📊 69 件)': html2.includes('📊 69 件'),
    'Modal Esc / ↑↓ hint': html2.includes('↑↓ 移动焦点'),
    'Modal footer help text': html2.includes('Ozon 后台还能改'),
    'Candidate search input present': html2.includes('🔍 按名称或 cat id 过滤'),
    'Modal close button': html2.includes('关闭'),
  };
  for (const [k, v] of Object.entries(modalChecks)) {
    console.log(`  ${v ? '✓' : '✗'} ${k}`);
    if (!v) allOk = false;
  }

  // Apply selection
  console.log('\n--- Applying first candidate ---');
  vm.applyCategoryChoice(vm.items[2]._category_resolved.candidates[0]);
  await global.Vue.nextTick();
  const item3 = vm.items[2];
  const selectChecks = {
    'Row 3 distilled.descriptionCategoryId updated': item3.distilled.descriptionCategoryId === 17027899,
    'Row 3 _category_resolved.confidence → manual': item3._category_resolved.confidence === 'manual',
    'Row 3 source → manual-candidate-pick': item3._category_resolved.source === 'manual-candidate-pick',
    'localStorage has sku 333333 entry': !!JSON.parse(localStorage.getItem('zhumeng_category_choice_v1') || '{}')['333333'],
  };
  console.log('--- Selection ---');
  for (const [k, v] of Object.entries(selectChecks)) {
    console.log(`  ${v ? '✓' : '✗'} ${k}`);
    if (!v) allOk = false;
  }

  // v2.2.3: 验证 publishBatch 后会生成 "查看上架状态" CTA 节点
  // 注: publishBatch 调 axios.post 会失败 (no backend in test), 所以手动模拟成功路径:
  //   直接 verify CTA 的 innerHTML + 创建逻辑能否被 trigger
  console.log('\n--- Publish CTA structure ---');
  const ctaChecks = {
    'Publish source contains 📜 查看上架状态 text': buCode.includes('查看上架状态'),
    'Publish source contains 📜 历史记录 fallback button': buCode.includes('📜 历史记录'),
    'Publish source generates batch-log-panel id': buCode.includes('batch-log-panel'),
    'openHistory navigates to #/listing-history': buCode.includes("window.location.hash = '#/listing-history'"),
  };
  for (const [k, v] of Object.entries(ctaChecks)) {
    console.log(`  ${v ? '✓' : '✗'} ${k}`);
    if (!v) allOk = false;
  }

  console.log('\n' + (allOk ? '✓ ALL REAL RENDER TESTS PASSED' : '✗ SOME TESTS FAILED'));
  process.exit(allOk ? 0 : 1);
})().catch((e) => {
  console.error('CRASH:', e.message);
  console.error(e.stack);
  process.exit(1);
});