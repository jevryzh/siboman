// 直接在 HTML 里 mount BatchUpload, 不依赖路由
const fs = require('fs');

(async () => {
  const { JSDOM } = require('/Users/eason/Documents/逐梦 ERP/siboman/node_modules/jsdom');
  const dom = new JSDOM('<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><div id="app"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
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

  const Vue = require('/Users/eason/Documents/逐梦 ERP/siboman/node_modules/vue');
  global.Vue = Vue;

  const buCode = fs.readFileSync(
    '/Users/eason/Documents/逐梦 ERP/siboman/public/js/views/BatchUpload.js',
    'utf8'
  );
  const sandboxed = new Function('window', 'document', 'localStorage', 'Vue', 'AbortController', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console', 'Date', 'JSON', 'Math', 'RegExp', 'Error', 'Promise', 'Object', 'Array', 'Number', 'String', 'Boolean', 'Symbol', 'Map', 'Set', buCode + '; return window.BatchUploadView;');
  const BatchUploadView = sandboxed(global.window, global.document, global.localStorage, global.Vue, global.AbortController, setTimeout, clearTimeout, setInterval, clearInterval, console, Date, JSON, Math, RegExp, Error, Promise, Object, Array, Number, String, Boolean, Symbol, Map, Set);

  const app = global.Vue.createApp(BatchUploadView);
  // 必须在 mount 前注入 mock 数据, 这样模板初次渲染就有数据
  const mockItems = [
    {
      index: 1, sku: '3035117601', valid: true, price: 123.00,
      distilled: {
        name: 'Вентилятор Ebmpapst 4650N-465 230v',
        descriptionCategoryId: 17028710, typeId: 95120,
        images: [], weight: 100, depth: 100, width: 100, height: 100,
      },
      _category_resolved: { confidence: 'high', to: 17028710, source: 'similar-name-same-store' },
    },
    {
      index: 2, sku: '5000441480', valid: true, price: 90.35,
      distilled: {
        name: 'Потолочный светильник, 24 Вт',
        descriptionCategoryId: 17027899, typeId: 87593412,
        images: [], weight: 100, depth: 100, width: 100, height: 100,
      },
      _category_resolved: { confidence: 'medium', to: 17027899, candidates: [
        { description_category_id: 17027899, name: 'Бижутерные украшения', count: 107 },
        { description_category_id: 17028650, name: 'Чехлы', count: 69 },
      ] },
    },
    {
      index: 3, sku: '5006795328', valid: true, price: 256.50,
      distilled: {
        name: 'Прототип куклы',
        descriptionCategoryId: 0, typeId: 0,
        images: [], weight: 100, depth: 100, width: 100, height: 100,
      },
      _category_resolved: { confidence: 'none', to: 0, candidates: [
        { description_category_id: 17027899, name: 'Бижутерные украшения', count: 107 },
        { description_category_id: 17028650, name: 'Чехлы', count: 69 },
        { description_category_id: 17028647, name: 'Аксессуары для фото', count: 66 },
        { description_category_id: 53968796, name: 'Запчасти', count: 58 },
        { description_category_id: 17028971, name: 'Бутылочки', count: 52 },
        { description_category_id: 29183107, name: 'Аксессуары для волос', count: 41 },
        { description_category_id: 17028664, name: 'Детское творчество', count: 40 },
        { description_category_id: 17027904, name: 'Аксессуары', count: 35 },
        { description_category_id: 17028973, name: 'Игрушки', count: 29 },
        { description_category_id: 17028741, name: 'Столовая посуда', count: 28 },
      ] },
    },
    {
      index: 4, sku: '5006794407', valid: true, price: 256.50,
      distilled: {
        name: 'Прототип куклы (коричневый)',
        descriptionCategoryId: 17028650, typeId: 97021,
        descriptionCategoryName: 'Чехлы',
        images: [], weight: 100, depth: 100, width: 100, height: 100,
      },
      _category_resolved: { confidence: 'manual', to: 17028650, source: 'manual-candidate-pick' },
    },
  ];
  const mockStores = [
    { id: 'f272aa4d-7e69-4817-8e34-5ef973dd651a', name: 'Three Latte' },
    { id: '75632937-b40a-404f-86e7-01213e5aec7d', name: 'Polarwind' },
  ];
  const mockWh = {
    'f272aa4d-7e69-4817-8e34-5ef973dd651a': [
      { warehouse_id: '1020005011445850', name: 'zto深圳', status: 'created', is_rfbs: true },
      { warehouse_id: '1020005017974910', name: 'CEL陆空', status: 'created', is_rfbs: true },
    ],
    '75632937-b40a-404f-86e7-01213e5aec7d': [
      { warehouse_id: '1020005001617580', name: 'ZTO', status: 'created', is_rfbs: true },
      { warehouse_id: '1020005007060990', name: 'CEL陆空', status: 'created', is_rfbs: true },
    ],
  };
  const mockSelectedWh = {
    'f272aa4d-7e69-4817-8e34-5ef973dd651a': '1020005011445850',
    '75632937-b40a-404f-86e7-01213e5aec7d': '1020005001617580',
  };
  // patch setup 让它在 mount 之前 inject 这些数据
  const origSetup = BatchUploadView.setup;
  BatchUploadView.setup = function() {
    const r = origSetup.apply(this, arguments);
    setTimeout(() => {
      r.items.value = mockItems;
      r.allStores.value = mockStores;
      r.warehousesByStore.value = mockWh;
      r.selectedStores.value = Object.keys(mockWh);
      r.selectedWarehousesByStore.value = mockSelectedWh;
    }, 0);
    return r;
  };
  const vm = app.mount('#app');

  vm.selectedStores = [
    'f272aa4d-7e69-4817-8e34-5ef973dd651a',
    '75632937-b40a-404f-86e7-01213e5aec7d',
  ];
  vm.allStores = [
    { id: 'f272aa4d-7e69-4817-8e34-5ef973dd651a', name: 'Three Latte' },
    { id: '75632937-b40a-404f-86e7-01213e5aec7d', name: 'Polarwind' },
  ];
  vm.warehousesByStore = {
    'f272aa4d-7e69-4817-8e34-5ef973dd651a': [
      { warehouse_id: '1020005011445850', name: 'zto深圳', status: 'created', is_rfbs: true },
      { warehouse_id: '1020005017974910', name: 'CEL陆空', status: 'created', is_rfbs: true },
    ],
    '75632937-b40a-404f-86e7-01213e5aec7d': [
      { warehouse_id: '1020005001617580', name: 'ZTO', status: 'created', is_rfbs: true },
      { warehouse_id: '1020005007060990', name: 'CEL陆空', status: 'created', is_rfbs: true },
    ],
  };
  vm.selectedWarehousesByStore = {
    'f272aa4d-7e69-4817-8e34-5ef973dd651a': '1020005011445850',
    '75632937-b40a-404f-86e7-01213e5aec7d': '1020005001617580',
  };

  vm.items = [
    {
      index: 1, sku: '3035117601', valid: true, price: 123.00,
      distilled: {
        name: 'Вентилятор Ebmpapst 4650N-465 230v',
        descriptionCategoryId: 17028710, typeId: 95120,
        images: [], weight: 100, depth: 100, width: 100, height: 100,
      },
      _category_resolved: { confidence: 'high', to: 17028710, source: 'similar-name-same-store' },
    },
    {
      index: 2, sku: '5000441480', valid: true, price: 90.35,
      distilled: {
        name: 'Потолочный светильник, 24 Вт',
        descriptionCategoryId: 17027899, typeId: 87593412,
        images: [], weight: 100, depth: 100, width: 100, height: 100,
      },
      _category_resolved: { confidence: 'medium', to: 17027899, candidates: [
        { description_category_id: 17027899, name: 'Бижутерные украшения', count: 107 },
        { description_category_id: 17028650, name: 'Чехлы', count: 69 },
      ] },
    },
    {
      index: 3, sku: '5006795328', valid: true, price: 256.50,
      distilled: {
        name: 'Прототип куклы',
        descriptionCategoryId: 0, typeId: 0,
        images: [], weight: 100, depth: 100, width: 100, height: 100,
      },
      _category_resolved: { confidence: 'none', to: 0, candidates: [
        { description_category_id: 17027899, name: 'Бижутерные украшения', count: 107 },
        { description_category_id: 17028650, name: 'Чехлы', count: 69 },
        { description_category_id: 17028647, name: 'Аксессуары для фото', count: 66 },
        { description_category_id: 53968796, name: 'Запчасти', count: 58 },
        { description_category_id: 17028971, name: 'Бутылочки', count: 52 },
        { description_category_id: 29183107, name: 'Аксессуары для волос', count: 41 },
        { description_category_id: 17028664, name: 'Детское творчество', count: 40 },
        { description_category_id: 17027904, name: 'Аксессуары', count: 35 },
        { description_category_id: 17028973, name: 'Игрушки', count: 29 },
        { description_category_id: 17028741, name: 'Столовая посуда', count: 28 },
      ] },
    },
    {
      index: 4, sku: '5006794407', valid: true, price: 256.50,
      distilled: {
        name: 'Прототип куклы (коричневый)',
        descriptionCategoryId: 17028650, typeId: 97021,
        descriptionCategoryName: 'Чехлы',
        images: [], weight: 100, depth: 100, width: 100, height: 100,
      },
      _category_resolved: { confidence: 'manual', to: 17028650, source: 'manual-candidate-pick' },
    },
  ];

  await new Promise(r => setTimeout(r, 500));
  await global.Vue.nextTick();
  await global.Vue.nextTick();
  await global.Vue.nextTick();

  // 提取 DOM 内容
  const innerHtml = document.getElementById('app').innerHTML;

  // 输出完整 HTML — 用 vue production 版
  const vueSrc = fs.readFileSync(
    '/Users/eason/Documents/逐梦 ERP/siboman/node_modules/vue/dist/vue.global.prod.js',
    'utf8'
  );

  const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="data:text/javascript;base64,${Buffer.from(vueSrc).toString('base64')}"></script>
  <style>
    body { margin: 0; padding: 0; background: #f1f5f9; font-family: 'Outfit', -apple-system, sans-serif; font-size: 13px; }
    .batch-upload-v2 { background: #f1f5f9; min-height: 100vh; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
    ${buCode.replace(/<\/script>/g, '<\\/script>')}
    const { createApp } = Vue;
    // wrap setup so we can inject mock data AFTER mount
    const origSetup = window.BatchUploadView.setup;
    window.BatchUploadView.setup = function() {
      const r = origSetup.apply(this, arguments);
      // populate mock data once nextTick
      Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve()).then(() => {
        const mockItems = ${JSON.stringify(mockItems)};
        if (r.items) r.items.value = mockItems;
        if (r.allStores) r.allStores.value = ${JSON.stringify(mockStores)};
        if (r.warehousesByStore) r.warehousesByStore.value = ${JSON.stringify(mockWh)};
        if (r.selectedStores) r.selectedStores.value = Object.keys(${JSON.stringify(mockWh)});
        if (r.selectedWarehousesByStore) r.selectedWarehousesByStore.value = ${JSON.stringify(mockSelectedWh)};
      });
      return r;
    };
    const app = createApp(window.BatchUploadView);
    const vm = app.mount('#app');
    window.__demo = vm;
  </script>
</body>
</html>`;

  fs.writeFileSync('/Users/eason/Documents/逐梦 ERP/batchupload-mockup-v2.2.6.html', fullHtml);
  console.log('Saved /Users/eason/Documents/逐梦 ERP/batchupload-mockup-v2.2.6.html', fullHtml.length, 'bytes');
  process.exit(0);
})().catch((e) => {
  console.error('CRASH:', e.message);
  console.error(e.stack);
  process.exit(1);
});