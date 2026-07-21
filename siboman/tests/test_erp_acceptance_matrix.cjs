const fs = require('fs');
const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const readJson = (relativePath) => JSON.parse(read(relativePath));

const matrix = readJson('docs/testing/erp-p1-acceptance-matrix.json');
const formalChecklist = readJson('docs/testing/formal-user-acceptance-checklist.json');
const report = read('docs/testing/erp-p1-readonly-acceptance-matrix.md');
const formalReport = read('docs/testing/formal-user-acceptance-checklist.md');
const server = read('server.js');
const main = read('public/js/main.js');

const requiredModuleIds = [
  'store-management',
  'product-management',
  'collection-box',
  'batch-upload',
  'listing-history',
  'inventory-management',
  'order-management',
  'ai-product-images',
  'analytics-center',
  'data-screen',
  'market-discovery',
];
const allowedRiskLevels = new Set(['read_only', 'requires_authorization', 'external_write_impact']);
const modules = new Map(matrix.modules.map((item) => [item.id, item]));
const formalItems = new Map(formalChecklist.items.map((item) => [item.id, item]));
const requiredFormalIds = [
  'FA-001-product-image-zoom',
  'FA-002-product-status-chinese',
  'FA-003-product-category-prefill',
  'FA-004-product-stock-readonly',
  'FA-005-collection-errors-visible',
  'FA-006-listing-task-error-visible',
  'FA-007-dangerous-stock-order-confirmation',
  'FA-008-ai-provider-failure-reason',
];

assert.strictEqual(matrix.schemaVersion, 1, 'matrix schema version must remain explicit');
assert.deepStrictEqual([...modules.keys()].sort(), requiredModuleIds.slice().sort(), 'P1 matrix must cover the complete ERP acceptance scope');
assert(report.includes('P1-3-BUG-01'), 'acceptance report must include the current bug/gap list');
assert(report.includes('页面能开'), 'acceptance report must explicitly reject page-open-only acceptance');
assert.strictEqual(formalChecklist.schemaVersion, 1, 'formal checklist schema version must remain explicit');
assert.deepStrictEqual([...formalItems.keys()].sort(), requiredFormalIds.slice().sort(), 'formal acceptance checklist must cover all agreed first-user UX checks');
assert(formalReport.includes('结构测试'), 'formal report must audit which current tests are only structural');
assert(formalReport.includes('不覆盖的真实体验'), 'formal report must state the gap between guard checks and real user experience');
assert(formalReport.includes('本地 guard 不触发 Ozon 发布、库存提交、订单发货、AI 生成、部署'), 'formal report must forbid live external execution in local guard');
assert(formalChecklist.executionPolicy?.localGuardMode === 'static_local_only', 'formal checklist must declare static local guard mode');
assert((formalChecklist.executionPolicy?.forbiddenInLocalGuard || []).join(' ').includes('Do not call Ozon Seller APIs.'), 'formal checklist must forbid Ozon calls');
assert((formalChecklist.executionPolicy?.forbiddenInLocalGuard || []).join(' ').includes('Do not call AI providers.'), 'formal checklist must forbid AI provider calls');
assert(!main.includes('<span>单品找货</span>'), 'single sourcing must remain frozen out of the normal sidebar');
assert(main.includes("routeName === 'single-sourcing-frozen'"), 'frozen single-sourcing route must still render a notice');
assert(main.includes("axios.get('/api/version')"), 'main shell must fetch build version for acceptance traceability');
assert(main.includes('envLabel'), 'main shell must expose environment label for test/prod clarity');
assert(main.includes('测试环境') && main.includes('生产环境'), 'main shell must label test and production environments');
assert(main.includes('buildInfo.version'), 'main shell must render the current BUILD_VERSION in the header');

for (const mod of matrix.modules) {
  assert(allowedRiskLevels.has(mod.riskLevel), `${mod.id} has an unknown risk level`);
  assert(mod.menuLabel && mod.route && mod.viewFile, `${mod.id} must define menu label, route, and view file`);
  assert(Array.isArray(mod.readonlyAcceptance) && mod.readonlyAcceptance.length >= 2, `${mod.id} must define business acceptance beyond page open`);
  assert(Array.isArray(mod.authorizationAcceptance), `${mod.id} authorizationAcceptance must be explicit`);
  assert(Array.isArray(mod.externalWriteAcceptance), `${mod.id} externalWriteAcceptance must be explicit`);
  assert(mod.localSmoke && Array.isArray(mod.localSmoke.viewContains), `${mod.id} must define executable view smoke checks`);
  assert(mod.localSmoke.viewContains.length >= 2, `${mod.id} must have meaningful view checks`);
  assert(report.includes(mod.menuLabel), `report must mention ${mod.menuLabel}`);
  assert(report.includes(mod.route), `report must mention ${mod.route}`);
  assert(main.includes(`index="${mod.route}"`) || main.includes(`goTo('${mod.route}')`), `main menu missing ${mod.route}`);

  const view = read(mod.viewFile);
  for (const needle of mod.localSmoke.viewContains) {
    assert(view.includes(needle), `${mod.id} view guard missing: ${needle}`);
  }
  for (const needle of mod.localSmoke.viewMustNotContain || []) {
    assert(!view.includes(needle), `${mod.id} view must not contain: ${needle}`);
  }
  for (const needle of mod.localSmoke.serverContains || []) {
    assert(server.includes(needle), `${mod.id} server guard missing: ${needle}`);
  }

  const acceptanceText = [
    ...mod.readonlyAcceptance,
    ...mod.authorizationAcceptance,
    ...mod.externalWriteAcceptance,
  ].join(' ');
  assert(!/page\s*open|页面打开|页面能开/i.test(acceptanceText), `${mod.id} acceptance cannot be page-open-only`);

  if (mod.riskLevel === 'external_write_impact') {
    assert(mod.externalWriteAcceptance.length >= 2, `${mod.id} external-write modules must state explicit external write acceptance`);
    assert(/not part of local smoke|must not run in local smoke|requires confirmation|require confirmation|不可逆|不真实执行|本地 smoke 不触发/i.test(acceptanceText), `${mod.id} must state local smoke does not execute external writes`);
  }
}

for (const audit of formalChecklist.existingTestAudit || []) {
  assert(audit.area && audit.currentCoverage && audit.experienceGap, 'existing test audit entries must state area, coverage, and experience gap');
  assert(!/fully covers|端到端覆盖|真实成功/.test(audit.currentCoverage), `${audit.area} must not overclaim current structural tests`);
}

for (const id of requiredFormalIds) {
  const item = formalItems.get(id);
  assert(item, `missing formal acceptance item ${id}`);
  assert(allowedRiskLevels.has(item.riskLevel), `${id} has an unknown risk level`);
  assert(item.module && item.route, `${id} must identify module and route`);
  assert(Array.isArray(item.acceptanceSteps) && item.acceptanceSteps.length >= 3, `${id} must define executable formal acceptance steps`);
  assert(Array.isArray(item.manualEvidence) && item.manualEvidence.length >= 2, `${id} must require human acceptance evidence`);
  assert(item.localGuard && Array.isArray(item.localGuard.sourceFiles) && item.localGuard.sourceFiles.length, `${id} must define local guard source files`);
  assert(Array.isArray(item.localGuard.mustContain) && item.localGuard.mustContain.length >= 3, `${id} must define meaningful local guard needles`);
  assert(formalReport.includes(id), `formal report must mention ${id}`);
  assert(formalReport.includes(item.module) || formalReport.includes(item.route), `formal report must mention module or route for ${id}`);

  const acceptanceText = [...item.acceptanceSteps, ...item.manualEvidence].join(' ');
  assert(!/page\s*open|页面打开|页面能开/i.test(acceptanceText), `${id} acceptance cannot be page-open-only`);
  if (item.riskLevel === 'external_write_impact') {
    const policyText = [
      ...(formalChecklist.executionPolicy?.forbiddenInLocalGuard || []),
      ...item.acceptanceSteps,
    ].join(' ');
    assert(/Do not call Ozon|Do not call AI|授权测试店铺|confirmation|确认|不可逆|只显示库存上下文/i.test(policyText), `${id} must state a no-live-call or explicit-confirmation boundary`);
  }

  const fileText = item.localGuard.sourceFiles.map((filePath) => read(filePath)).join('\n');
  for (const needle of item.localGuard.mustContain) {
    assert(fileText.includes(needle), `${id} local guard missing: ${needle}`);
  }
  for (const forbidden of item.localGuard.mustNotContain || []) {
    assert(!fileText.includes(forbidden), `${id} local guard must not contain: ${forbidden}`);
  }
}

const formalFocusText = formalChecklist.items.map((item) => `${item.id} ${item.module} ${item.acceptanceSteps.join(' ')} ${(item.localGuard.mustContain || []).join(' ')}`).join('\n');
for (const expected of ['image', 'chinese', 'category', 'stock', 'collection', 'task', 'error', 'provider']) {
  assert(formalFocusText.toLowerCase().includes(expected.toLowerCase()), `formal checklist must cover ${expected}`);
}

for (const id of ['batch-upload', 'inventory-management', 'order-management', 'ai-product-images']) {
  assert.strictEqual(modules.get(id).riskLevel, 'external_write_impact', `${id} must be classified as external write impact`);
}
for (const id of ['analytics-center', 'data-screen']) {
  assert.strictEqual(modules.get(id).riskLevel, 'read_only', `${id} must be classified read-only`);
}

console.log('ERP P1 acceptance matrix and local smoke guard passed.');
console.log(`Covered modules: ${requiredModuleIds.length}`);
console.log(`Formal acceptance checks: ${requiredFormalIds.length}`);
