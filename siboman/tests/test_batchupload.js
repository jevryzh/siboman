// Static structural test of BatchUpload v2.2.2 UI
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('/Users/eason/Documents/逐梦 ERP/siboman/node_modules/jsdom');

const code = fs.readFileSync(
  '/Users/eason/Documents/逐梦 ERP/siboman/public/js/views/BatchUpload.js',
  'utf8'
);

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;

let capturedTemplate = null;
let capturedSetup = null;
let vueRendered = null;

const VueStub = {
  ref: (v) => ({ value: v, _isRef: true }),
  reactive: (o) => o,
  computed: (fn) => ({ get value() { return fn(); } }),
  watch: () => {},
  onMounted: () => {},
  onBeforeUnmount: () => {},
  onUnmounted: () => {},
  nextTick: (fn) => fn && fn(),
  createApp: (component) => ({
    mount: () => {
      capturedTemplate = component.template;
      capturedSetup = component.setup;
      const ctx = capturedSetup();
      vueRendered = {
        hasStats: capturedTemplate.includes('categoryStats.total'),
        hasStatsCards: capturedTemplate.includes('categoryStats.high') &&
                       capturedTemplate.includes('categoryStats.medium') &&
                       capturedTemplate.includes('categoryStats.manual') &&
                       capturedTemplate.includes('categoryStats.none'),
        hasFilteredCandidates: capturedTemplate.includes('filteredCandidates'),
        hasOnPickerKeydown: capturedTemplate.includes('onPickerKeydown'),
        hasCandidateSearch: capturedTemplate.includes('candidateSearch'),
        hasApplyCategoryChoice: capturedTemplate.includes('applyCategoryChoice'),
        hasOpenCategoryPicker: capturedTemplate.includes('openCategoryPicker'),
        setupReturnsValid: !!ctx && typeof ctx === 'object',
        exposedCategoryStats: 'categoryStats' in ctx,
        exposedPicker: 'categoryPickerOpen' in ctx,
        exposedPickerKeydown: 'onPickerKeydown' in ctx,
        exposedCandidateSearch: 'candidateSearch' in ctx,
        exposedApplyHistory: 'applyCategoryHistory' in ctx,
        exposedFiltered: 'filteredCandidates' in ctx,
        exposedFocusIdx: 'pickerFocusIdx' in ctx,
      };
      return { unmount: () => {} };
    },
  }),
};

global.window = window;
global.document = window.document;
global.localStorage = window.localStorage;
global.navigator = window.navigator;
global.HTMLElement = window.HTMLElement;
global.AbortController = class { constructor() { this.signal = {}; } abort() {} };
global.Vue = VueStub;

try {
  const ctx = { window, document, localStorage, Vue: VueStub, AbortController: global.AbortController, setTimeout, clearTimeout, console };
  const fn = new Function('window', 'document', 'localStorage', 'Vue', 'AbortController', 'setTimeout', 'clearTimeout', 'console', code);
  fn(ctx.window, ctx.document, ctx.localStorage, ctx.Vue, ctx.AbortController, ctx.setTimeout, ctx.clearTimeout, ctx.console);

  if (!ctx.window.BatchUploadView) { console.error('FAIL: BatchUploadView not exposed'); process.exit(1); }

  const app = VueStub.createApp(ctx.window.BatchUploadView);
  app.mount('#app');

  console.log('=== BatchUpload v2.2.2 Structural Test ===\n');
  for (const [k, v] of Object.entries(vueRendered)) {
    const icon = v === true ? '✓' : '✗';
    console.log(`  ${icon} ${k}: ${v}`);
  }
  const allOk = Object.values(vueRendered).every((v) => v === true);
  console.log('\n' + (allOk ? '✓ ALL CHECKS PASSED' : '✗ SOME CHECKS FAILED'));
  process.exit(allOk ? 0 : 1);
} catch (e) {
  console.error('CRASH:', e.message);
  console.error(e.stack);
  process.exit(1);
}