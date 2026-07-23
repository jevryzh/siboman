const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const readJson = (relativePath) => JSON.parse(read(relativePath));

const main = read('public/js/main.js');
const sourcing = read('public/js/views/SourcingModule.js');
const review = read('public/js/views/SingleSourcingReview.js');
const batch = read('public/js/views/BatchUpload.js');
const indexHtml = read('public/index.html');
const server = read('server.js');
const background = read('public/extension/zhumeng-collector/background.js');
const bridge = read('public/extension/zhumeng-collector/content-bridge-iso.js');
const packageJson = readJson('package.json');
const matrix = readJson('docs/testing/erp-p1-acceptance-matrix.json');
const report = read('docs/testing/erp-p1-readonly-acceptance-matrix.md');

const singleModule = matrix.modules.find((item) => item.id === 'single-sourcing');
assert(singleModule, 'P1 matrix must include single-sourcing');
assert.strictEqual(singleModule.route, '#/single-sourcing', 'single sourcing must use the independent route');
assert.strictEqual(singleModule.viewFile, 'public/js/views/SourcingModule.js', 'single sourcing matrix must point at SourcingModule');
assert.strictEqual(singleModule.riskLevel, 'requires_authorization', 'single sourcing needs authorization but is not an external-write module');

// Independent entry: the menu is outside the selection-center tab structure and renders the real workflow.
assert(main.includes('index="#/single-sourcing"'), 'main sidebar must expose an independent single-sourcing entry');
assert(main.includes("goTo('#/single-sourcing')"), 'main sidebar must navigate directly to #/single-sourcing');
assert(main.includes("routeName === 'single-sourcing'"), 'main shell must render single sourcing route');
assert(main.includes('index="#/single-sourcing-review"'), 'main sidebar must expose the single-sourcing review page');
assert(main.includes("routeName === 'single-sourcing-review'"), 'main shell must render the single-sourcing review page');
assert(main.indexOf("path.includes('single-sourcing-review')") < main.indexOf("path.includes('single-sourcing')"), 'review route must be matched before single-sourcing route');
assert(main.includes("register('single-sourcing-review-view'"), 'main must register the review component');
assert(indexHtml.includes('/js/views/SingleSourcingReview.js'), 'index must load the review component script');
assert(!main.includes("routeName === 'single-sourcing-frozen'"), 'old frozen placeholder route must stay removed');
assert(main.indexOf("goTo('#/single-sourcing')") > main.indexOf("goTo('#/collection')"), 'single sourcing must sit beside collection workflow, not under selection center');
assert(sourcing.includes("if (hash.includes('/single-sourcing')) return 'single';"), 'SourcingModule must enter single mode from the independent hash');
assert(sourcing.includes('<template v-if="activeTab !== \'single\'" #header>'), 'selection-center tabs must be hidden in single-sourcing mode');
assert(!sourcing.includes('<el-tab-pane label="单品找货"'), 'single sourcing must not reappear as a selection-center tab');
assert(!report.includes('Single sourcing remains frozen'), 'testing docs must not retain the old frozen-single-sourcing rule');

// Plugin auth: ERP page grants a scoped worker token; the extension must not ask for ERP username/password.
assert(sourcing.includes('authorizePluginWorker'), 'single sourcing page must authorize the plugin worker');
assert(sourcing.includes("axios.get('/api/worker/plugin-token')"), 'single sourcing page must fetch an ERP-user scoped plugin worker token');
assert(sourcing.includes('refreshAndAuthorizePlugin'), 'single sourcing refresh action must also re-authorize the plugin worker');
assert(sourcing.includes("sendToExtension('workerAuth.request'"), 'single sourcing page must pass the scoped token through the bridge');
assert(bridge.includes('kind === "workerAuth.request"'), 'content bridge must handle worker auth messages');
assert(background.includes('let workerAuthToken = ""'), 'extension must use a worker auth token instead of an ERP password');
assert(background.includes('chrome.storage.local.set({ workerAuthToken'), 'extension may persist only the scoped worker token');
assert(background.includes('headers.Authorization = `Bearer ${workerAuthToken}`'), 'extension ERP calls must authenticate with the scoped bearer token');
assert(!/erp.*password|password.*erp|username.*password/i.test(background), 'extension single-sourcing worker must not prompt for ERP username/password');
assert(server.includes('function createScopedWorkerToken'), 'server must issue scoped worker tokens');
assert(server.includes('function verifyScopedWorkerToken'), 'server must verify scoped worker tokens');
assert(server.includes('payload.type !== "plugin-worker"'), 'server must reject non-worker token types for worker APIs');
assert(server.includes('scope: ["collector:submit", "worker:poll"]'), 'plugin worker token scope must be limited to collector submit and worker polling');
assert(server.includes('tokenStoreId'), 'scoped worker token must carry the selected store id');
const singleJobPost = sourcing.slice(sourcing.indexOf("axios.post('/api/jobs'"), sourcing.indexOf("});", sourcing.indexOf("axios.post('/api/jobs'")));
assert(!singleJobPost.includes("store_id"), 'single-sourcing jobs must remain ERP-user scoped, not selected-store scoped');

// Queue and store scope: jobs are created for the selected store and claimed only by a matching scoped worker.
assert(sourcing.includes('const getStoreId = () =>'), 'single sourcing view must read current store id');
assert(sourcing.includes('window.addEventListener(\'shop-changed\', onShopChanged)'), 'single sourcing must respond to store changes');
assert(server.includes('const storeId = String(job.storeId || payload?.storeId || payload?.store_id'), 'queued jobs must persist store_id');
assert(server.includes('id, user_id, store_id, kind, status'), 'app_jobs insert must include store_id');
assert(server.includes('AND ($3::uuid IS NULL OR j.store_id = $3::uuid)'), 'worker claim must filter queued jobs by scoped store id');
assert(server.includes('idx_app_worker_heartbeats_store_seen'), 'worker heartbeat status must be indexable by current store');
assert(server.includes('storeMatch'), 'worker status must expose whether the plugin is authorized for the selected store');
assert(server.includes('where += ` AND j.store_id = $${params.length}`'), 'worker job lookup must remain store-scoped');
assert(background.includes('kinds: ["run"]'), 'extension single-sourcing worker may only claim run jobs');
assert(server.includes('MIN_SINGLE_SOURCING_PLUGIN_VERSION'), 'server must define a minimum plugin version for single-sourcing workers');
assert(server.includes('MIN_SINGLE_SOURCING_PLUGIN_VERSION = "2.2.9.57"'), 'server must force the current stable single-sourcing plugin version');
assert(server.includes('versionTooOld'), 'server must block outdated extension workers from claiming single-sourcing jobs');
assert(server.includes('blocked: true'), 'outdated extension workers must receive a blocked response instead of a job');
assert(server.includes('version: req.body?.version'), 'worker heartbeat must persist the reported plugin version');
assert(background.includes('pluginVersion: VERSION'), 'extension worker heartbeat must report its real plugin version');

// Candidate count and operator controls: default remains 5 and is passed through, never hard-coded to 3.
assert(sourcing.includes('const maxCandidates = Vue.ref(5)'), 'single sourcing default candidate count must remain 5');
assert(sourcing.includes('maxCandidates: Number(maxCandidates.value || 5)'), 'single sourcing job payload must use the user-provided candidate count');
assert(sourcing.includes('<el-input-number v-model="maxCandidates" :min="1" :max="20"'), 'candidate count input must remain user-configurable');
assert(background.includes('Number(options.maxCandidates || 5)'), 'extension worker must read candidate count from job options');
assert(background.includes('最多 ${maxCandidates} 个'), 'worker logs must show the actual candidate limit');
assert(!/maxCandidates\s*=\s*(?:Vue\.ref\()?3\b/.test(sourcing), 'candidate count must not be silently reset to 3 in the UI');
assert(!/maxCandidates\s*=\s*Math\.[\w() ,]*(?:3)\b/.test(background), 'candidate count must not be silently capped to 3 in the worker');
assert(sourcing.includes("window.open('https://www.1688.com/'"), 'open-1688 action must go to the 1688 home page');
assert(!sourcing.includes('后台浏览器模式'), 'obsolete background browser mode control must not be shown');

// Logs, results, history, and Excel download must be understandable after refresh.
assert(sourcing.includes('formatLogClock'), 'logs must render a local clock time');
assert(sourcing.includes('level = String(entry?.level || \'info\').toUpperCase()'), 'logs must render a visible level');
assert(sourcing.includes('第 ${itemNo}${total ? `/${total}` : \'\'} 条'), 'logs must render source row / total progress');
assert(sourcing.includes('sourceRow || $index + 1'), 'result table must show source row');
assert(sourcing.includes('historyDownloadUrl'), 'history rows must expose an Excel download URL');
assert(sourcing.includes('openReviewJob'), 'history rows must expose a review action');
assert(sourcing.includes('#/single-sourcing-review?id='), 'history review action must deep-link to a job review');
assert(sourcing.includes('fetchJobHistory'), 'single sourcing must load durable history');
assert(sourcing.includes('/api/history'), 'single sourcing history must come from the shared history API');
assert(sourcing.includes('下载 Excel'), 'single sourcing page must expose Excel downloads');
assert(sourcing.includes("currentJobId.value = '';"), 'single sourcing must clear stale saved job ids before restoring active jobs');
assert(sourcing.includes('job.value = null;'), 'single sourcing must reset stale terminal jobs before scanning active history');
assert(sourcing.includes('refreshHistorySilently();') && sourcing.includes('fetchCollectorStatus();'), 'active polling must refresh history and worker status while a job is running');
assert(sourcing.includes('candidate?.localImage?.publicUrl'), 'candidate table must prefer locally cached 1688 candidate images');
assert(server.includes('res.download(filePath, `${downloadPrefix}-${shortId}.xlsx`)'), 'history download must use ozon-1688/ozon-batch file names');
assert(server.includes('const downloadPrefix = kind === "batch-ozon" ? "ozon-batch" : "ozon-1688"'), 'single-sourcing downloads must use ozon-1688 prefix');
assert(server.includes('downloadUrl: job.downloadUrl'), 'DB history must expose downloadUrl');
assert(server.includes('await markJobDownloaded(id)'), 'download endpoint must record downloads');
assert(server.includes('app.get("/api/jobs/:id/review"'), 'server must expose single-sourcing review payloads');
assert(server.includes('app.post("/api/jobs/:id/review/confirm"'), 'server must save manual review confirmations');
assert(server.includes('review_confirmations'), 'server must persist review confirmations in the job payload');
assert(server.includes('buildBatchUploadTextFromConfirmations'), 'server must build batch-upload text from confirmations');
assert(review.includes('复制货号价格'), 'review page must let operators copy sku and price');
assert(review.includes('送批量上架'), 'review page must send confirmed rows to batch upload');
assert(review.includes('候选明细'), 'review page must expose the candidate detail table');
assert(review.includes('确认清单'), 'review page must expose the final confirmation table');
assert(review.includes('single_sourcing_batch_prefill'), 'review page must save batch-upload prefill data');
assert(batch.includes('single_sourcing_batch_prefill'), 'BatchUpload must consume single-sourcing review prefill data');
assert(batch.includes('已从找货核对页带入'), 'BatchUpload must explain review prefill to the operator');

for (const hiddenLabel of [
  'AI最终结果',
  '匹配类型',
  'AI是否选中',
  'AI候选判断',
  '疑似引流款',
  '引流款原因',
  '疑似优惠价',
  '优惠价原因',
  '优惠信息',
  'Ozon跟卖数量',
  'Ozon价格采集备注',
  'Ozon重量来源',
  'Ozon重量依据',
  'AI估算重量置信度',
  'AI估算重量依据',
  'Ozon件数核对',
  'Ozon件数依据',
  '1688件数依据',
  'AI最终置信度',
  'AI模型',
  'AI思考模式',
  'AI耗时秒',
  'AI输入Tokens',
  'AI输出Tokens',
  'AI总Tokens',
  'AI估算费用USD',
  '1688详情采集状态',
  '1688图片下载状态',
  'Ozon属性',
  'Ozon描述',
  'Ozon主图链接',
  '1688图片链接',
  '本地主图文件',
  'Ozon错误',
  '1688搜索错误',
  'AI选中候选',
  'MOQ解析值',
  'MOQ规则状态',
  '候选跳过原因',
  '候选质量分',
  '1688运费来源',
  '1688重量来源',
]) {
  assert(!review.includes(hiddenLabel), `review page must hide noisy Excel field: ${hiddenLabel}`);
}

// Excel contract: these fields are part of the formal v2 output and must not disappear.
for (const needle of [
  '"Ozon图片"',
  '"Ozon主图链接"',
  '"1688图片"',
  '"1688图片链接"',
  '"1688标题"',
  '"1688链接"',
  '"最少起批"',
  '"MOQ解析值"',
  '"MOQ规则状态"',
  '"1688运费"',
  '"1688运费来源"',
  '"1688重量（克）"',
  '"1688重量来源"',
  '"AI最终结果"',
  '"AI候选判断"',
  '"AI候选置信度"',
  '"AI候选原因"',
  '"AI模型"',
  '"1688搜索错误"',
]) {
  assert(server.includes(needle), `single-sourcing Excel contract missing ${needle}`);
}
assert(server.includes('writeXlsxWithEmbeddedImages'), 'single sourcing must keep embedded-image Excel writer');
assert(server.includes('imageColumns') && server.includes('"_1688ImagePath"'), 'Excel writer must map Ozon and 1688 image placeholders to local image paths');

// MOQ=1 and AI review rules are guarded in both deterministic scoring and model prompts.
assert(server.includes('parseMoqQuantity'), 'server must parse MOQ quantities');
assert(server.includes('getMoqRuleStatus'), 'server must export MOQ rule status');
assert(server.includes('isMoqEligible'), 'server must expose MOQ eligibility');
assert(server.includes('if (parseMoqQuantity(candidate.minOrderQuantity || candidate.moq) === 1) score += 120'), 'server ranking must prefer MOQ=1 candidates');
assert(server.includes('1688 候选的 MOQ/起批量大于 1 是硬性淘汰条件'), 'AI prompt must enforce MOQ>1 as a hard reject');
assert(server.includes('起批量大于 1 或起批量未取到的候选都必须判为 not_match'), 'AI prompt must reject MOQ>1 or unknown MOQ as not_match');
assert(server.includes('reviewCandidatesWithMiniMax'), 'server-side AI candidate review must remain connected');
assert(server.includes('phase: `服务器 AI 审核第 ${rowLabel} 行`'), 'server-side AI review must write live progress before each row review');
assert(server.includes('服务器 AI 审核第 ${rowLabel} 行完成'), 'server-side AI review must write live completion logs for each row review');
assert(!background.includes('AI 严格审核待接入后端评估。') || server.includes('reviewCandidatesWithMiniMax'), 'plugin placeholder AI review is allowed only when server-side AI review remains present');

// 1688 login/captcha must be visible instead of being collapsed into a generic failure.
assert(background.includes('1688 出现验证码/安全验证，请在当前 Chrome 手动完成验证后重试'), 'plugin must surface 1688 captcha/security verification');
assert(background.includes('检测到 1688 验证提示'), 'plugin must detect 1688 verification pages');
assert(!background.includes('1688 token 预热页'), 'plugin must not auto-open 1688 preheat pages while claiming jobs');
assert(!background.includes('激活 ${label}'), 'plugin must not foreground every 1688 detail tab');
assert(server.includes('触发验证码或人机验证，需要人工处理后再继续。'), 'server must translate captcha failures for operators');
assert(sourcing.includes('row.error || row.searchError'), 'result status must display row-level search/captcha errors');

// Regression gates remain in the main ERP test script.
const erpScript = packageJson.scripts['test:erp'] || '';
for (const cmd of [
  'scripts/check-extension-release.mjs --quiet',
  'tests/test_extension_release.cjs',
  'tests/test_batch_listing_guard.cjs',
]) {
  assert(erpScript.includes(cmd), `npm run test:erp must include ${cmd}`);
}

console.log('Single sourcing v2 structural guard passed.');
