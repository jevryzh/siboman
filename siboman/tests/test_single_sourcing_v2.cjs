const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const readJson = (relativePath) => JSON.parse(read(relativePath));

const main = read('public/js/main.js');
const sourcing = read('public/js/views/SourcingModule.js');
const indexHtml = read('public/index.html');
const server = read('server.js');
const background = read('public/extension/zhumeng-collector/background.js');
const bridge = read('public/extension/zhumeng-collector/content-bridge-iso.js');
const manifest = readJson('public/extension/zhumeng-collector/manifest.json');
const packageJson = readJson('package.json');
const matrix = readJson('docs/testing/erp-p1-acceptance-matrix.json');
const report = read('docs/testing/erp-p1-readonly-acceptance-matrix.md');

const singleModule = matrix.modules.find((item) => item.id === 'single-sourcing');
assert(singleModule, 'P1 matrix must include single-sourcing');
assert.strictEqual(singleModule.route, '#/single-sourcing', 'single sourcing must use the independent route');
assert.strictEqual(singleModule.viewFile, 'public/js/views/SourcingModule.js', 'single sourcing matrix must point at SourcingModule');
assert.strictEqual(singleModule.riskLevel, 'requires_authorization', 'single sourcing needs authorization but is not an external-write module');

// Stable single-sourcing flow stays independent, with the review page reachable from history.
assert(main.includes('index="#/single-sourcing"'), 'main sidebar must expose an independent single-sourcing entry');
assert(main.includes("goTo('#/single-sourcing')"), 'main sidebar must navigate directly to #/single-sourcing');
assert(main.includes("routeName === 'single-sourcing'"), 'main shell must render single sourcing route');
assert(main.includes("routeName === 'single-sourcing-review'"), 'main shell must render single-sourcing review route');
assert(indexHtml.includes('/js/views/SingleSourcingReview.js'), 'index must load the review component script');
assert(sourcing.includes('openHistoryReview'), 'history rows must expose the result-review action');
assert(sourcing.includes('结果核对'), 'history rows must show the result-review button');
assert(server.includes('app.get("/api/jobs/:id/review"'), 'server must expose the review read API');
assert(server.includes('app.post("/api/jobs/:id/review/confirm"'), 'server must expose the review confirmation API');
assert(server.includes('await writeJobArtifacts(job);'), 'review confirmation must rebuild the latest logistics workbook');
assert(indexHtml.includes('/js/views/SourcingModule.js?v=23017'), 'index must bust browser cache for the single sourcing module');
assert(/\/js\/views\/StoreManagement\.js\?v=\d+/.test(indexHtml), 'index must bust browser cache for plugin download status');
assert(!main.includes("routeName === 'single-sourcing-frozen'"), 'old frozen placeholder route must stay removed');
assert(main.indexOf("goTo('#/single-sourcing')") > main.indexOf("goTo('#/collection')"), 'single sourcing must sit beside collection workflow, not under selection center');
assert(sourcing.includes("if (hash.includes('/single-sourcing')) return 'single';"), 'SourcingModule must enter single mode from the independent hash');
assert(sourcing.includes('<template v-if="activeTab !== \'single\'">'), 'selection-center dashboard must be hidden in single-sourcing mode');
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
const singleJobPost = sourcing.slice(sourcing.indexOf("axios.post('/api/jobs'"), sourcing.indexOf("});", sourcing.indexOf("axios.post('/api/jobs'")));
assert(!singleJobPost.includes("store_id"), 'single-sourcing jobs must remain ERP-user scoped, not selected-store scoped');

// Queue and version gate: jobs are created for the selected store and claimed only by a matching current worker.
assert(sourcing.includes('const getStoreId = () =>'), 'single sourcing view must read current store id');
assert(sourcing.includes('window.addEventListener(\'shop-changed\', onShopChanged)'), 'single sourcing must respond to store changes');
assert(server.includes('const storeId = String(job.storeId || payload?.storeId || payload?.store_id'), 'queued jobs must persist store_id');
assert(server.includes('id, user_id, store_id, kind, status'), 'app_jobs insert must include store_id');
assert(server.includes('AND ($3::uuid IS NULL OR j.store_id = $3::uuid)'), 'worker claim must filter queued jobs by scoped store id');
assert(server.includes('storeMatch'), 'worker status must expose whether the plugin is authorized for the selected store');
assert(background.includes('kinds: ["run"]'), 'extension single-sourcing worker may only claim run jobs');
assert(server.includes('MIN_SINGLE_SOURCING_PLUGIN_VERSION = "2.2.9.101"'), 'server must force the current stable plugin version');
assert(server.includes('const WORKER_JOB_STALE_MS'), 'server must configure stale worker job rescue timeout');
assert(server.includes('async function rescueStaleDbJobsForUser'), 'server must rescue stale claimed/running worker jobs');
assert(server.includes("AND j.status IN ('claimed','running')"), 'stale rescue must target claimed/running jobs');
assert(server.includes("SET status = 'queued'"), 'stale rescue must requeue interrupted jobs for resume');
assert(server.includes('AND h.current_job_id = j.id'), 'stale rescue must not steal jobs from online active workers');
assert(server.includes('COALESCE(j.processed, 0) < COALESCE(j.total, 0)'), 'stale rescue must not requeue jobs that already reached total progress');
assert(server.includes('await rescueStaleDbJobsForUser(req.user, { kinds });'), 'worker polling must rescue stale jobs before claiming');
assert(server.includes('["done", "error", "canceled"].includes(existing.status)'), 'worker progress must not overwrite terminal jobs');
assert(server.includes('totalLimit > 0 ? totalLimit : 999999'), 'worker progress must clamp processed to total when total is known');
assert(server.includes('initialUpdates.results = job.results'), 'worker completion should persist incoming results only when progress has not already stored them');
assert(!server.includes('phase: `服务器 AI 审核第 ${rowLabel} 行`,\n          processed: job.processed,\n          total: job.total,\n          logs: job.logs,\n          results: job.results'), 'AI review progress must not rewrite the full results JSON before each model call');
assert.strictEqual(manifest.version, '2.2.9.101', 'manifest version must match current plugin version');
assert(background.includes('const VERSION = "2.2.9.101"'), 'background version must match current plugin version');
assert(bridge.includes('const VERSION = "2.2.9.101"'), 'bridge version must match current plugin version');
assert(background.includes('startSourcingCancelMonitor'), 'worker must poll cancellation while long collection/search steps are running');
assert(server.includes('if (existing.status === "canceled")'), 'server must not let worker progress/complete overwrite canceled jobs');
assert(server.includes('clearWorkerCurrentJobRefs'), 'server must clear worker current-job pointers when a job is canceled');
assert(sourcing.includes('w.online && w.currentJobId === id'), 'single sourcing UI must not treat stale worker heartbeats as active jobs');
assert(sourcing.includes('adoptWorkerActiveJob'), 'single sourcing UI must follow the worker current job instead of stale localStorage');
assert(sourcing.includes('applyWorkerCurrentJob'), 'single sourcing UI must render the worker current job logs immediately from worker status');
assert(sourcing.includes('const mergeJob = (nextJob) =>'), 'single sourcing UI must merge live job updates without replacing the whole panel every poll');
assert(sourcing.includes('sameJobPayload'), 'single sourcing UI must skip DOM updates when the polled job payload has not changed');
assert(sourcing.includes('mergeJob(workerJob);'), 'single sourcing UI must merge worker current job details even when the job id is unchanged');
assert(sourcing.includes('lastCollectorRefreshAt'), 'single sourcing UI must throttle worker status refreshes so status tags do not flicker');
assert(sourcing.includes('const liveStatusText = Vue.computed'), 'single sourcing UI must show heartbeat freshness without appending duplicate log lines');
assert(sourcing.includes('最后更新 ${seconds} 秒前'), 'single sourcing UI must make long-running unchanged phases visibly live');
assert(sourcing.includes('v-if="liveStatusText"'), 'single sourcing template must render the live heartbeat status line');
assert(sourcing.includes('const targetJobId = workerJobId || currentJobId.value'), 'single sourcing cancel must target the actual worker job first');
assert(server.includes('findActiveDbJobForUser'), 'server must avoid creating duplicate queued single-sourcing jobs while one is active');
assert(server.includes('currentJob,'), 'worker status must include the current job payload so live logs are not split across state sources');
assert(server.includes('queued: true, job: queued'), 'single sourcing job creation must return the persisted queued job, not only a local placeholder id');
assert(server.indexOf('if (queueSingleSourcing)') < server.indexOf('jobs.set(id, job);', server.indexOf('app.post("/api/jobs"')), 'queued single-sourcing DB jobs must not leave stale in-memory placeholder jobs');
assert(server.indexOf('const job = await getDbJobForUser(req.params.id, req.user);') < server.indexOf('const runtimeJob = jobs.get(req.params.id);'), 'job polling must prefer the persisted DB job over any runtime placeholder');
assert(server.includes('!/^实时进度：/.test'), 'server must reject duplicate heartbeat logs from older plugins before DB storage');
assert(background.includes('active1688TabIds'), 'extension must track temporary 1688 tabs so cancel can close them');
assert(background.includes('abortController'), 'extension must abort in-flight 1688/Ozon network requests on cancel');
assert(background.includes('withSourcingStepTimeout'), 'extension must apply per-step hard timeouts for Ozon and 1688 collection');
assert(background.includes('isOzonVerificationBlocker'), 'extension must detect Ozon captcha/slider pages before accepting scraped data');
assert(background.includes('touchLiveHeartbeat'), 'extension must send heartbeat progress while long 1688 steps are running');
assert(background.includes('rawRows.slice(0, declaredTotal)'), 'extension must not process more rows than the server-declared total');
assert(background.includes('job.processed >= job.total'), 'extension must complete instead of continuing when resumed progress already reached total');
assert(background.includes('Math.min(index + 1, job.total)'), 'extension must clamp processed progress to total');
assert(!background.includes('job.logs.push(makeLog(`实时进度：'), 'extension heartbeat must not spam duplicate progress entries into logs');
assert(sourcing.includes('filter((entry) => !/^实时进度：/'), 'single sourcing log panel must hide legacy duplicate heartbeat logs');
assert(background.includes('pluginVersion: VERSION'), 'extension worker heartbeat must report its real plugin version');

// Stable search chain: use the pre-review direct MTOP chain, not the later page-session-first search that caused frequent captcha.
assert(background.includes('async function search1688ByImageInPlugin(imageUrl, maxCandidates, job = null, opts = {})'), 'worker must expose the 1688 image search entry');
assert(background.includes('return run1688ImageSearchQueued(() => search1688ByImageInPluginInternal(imageUrl, maxCandidates, job, opts));'), 'worker must use the restored internal direct search chain');
assert(background.includes('ensure1688CookieStateInPlugin'), 'direct MTOP search must check 1688 cookie state');
assert(background.includes('fetchImageAsBase64'), 'direct MTOP search must upload the Ozon image bytes');
assert(background.includes('collect1688CandidatesInPlugin'), 'direct MTOP search must collect candidates from MTOP response');
assert(!background.includes('run1688ImageSearchQueued(() => withTimeoutInPlugin'), 'restored stable chain must not use the later timeout wrapper');

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

// Logs, results, history, Excel download, images, and CEL logistics remain available on the stable flow.
assert(sourcing.includes('formatLogClock'), 'logs must render a local clock time');
assert(sourcing.includes('level = String(entry?.level || \'info\').toUpperCase()'), 'logs must render a visible level');
assert(sourcing.includes('第 ${itemNo}${total ? `/${total}` : \'\'} 条'), 'logs must render source row / total progress');
assert(sourcing.includes('const logPanel = Vue.ref(null)'), 'live log panel must expose a scrollable ref');
assert(sourcing.includes('el.scrollTop = el.scrollHeight'), 'live log panel must auto-scroll to the newest progress');
assert(sourcing.includes('pollFailures >= 3'), 'job polling must tolerate transient errors instead of stopping immediately');
assert(sourcing.includes('setInterval(() =>') && sourcing.includes('}, 1500);'), 'single sourcing live logs should poll frequently enough without visually flickering');
assert(sourcing.includes('单品找货任务已创建') || sourcing.includes('任务已创建，等待采集插件/采集端领取'), 'new jobs must show an immediate operator message');
assert(sourcing.includes('sourceRow || $index + 1'), 'result table must show source row');
assert(sourcing.includes('historyDownloadUrl'), 'history rows must expose an Excel download URL');
assert(sourcing.includes('fetchJobHistory'), 'single sourcing must load durable history');
assert(sourcing.includes('/api/history'), 'single sourcing history must come from the shared history API');
assert(sourcing.includes('下载 Excel'), 'single sourcing page must expose Excel downloads');
assert(sourcing.includes('candidate?.localImage?.publicUrl'), 'candidate table must prefer locally cached 1688 candidate images');
assert(server.includes('app.get("/api/jobs/:id"'), 'single sourcing must keep job detail polling for live logs');
assert(server.includes('app.get("/api/history"'), 'single sourcing must keep durable history listing');
assert(server.includes('res.download(filePath, `${downloadPrefix}-${shortId}.xlsx`)'), 'history download must use ozon-1688/ozon-batch file names');
assert(server.includes('const downloadPrefix = kind === "batch-ozon" ? "ozon-batch" : "ozon-1688"'), 'single-sourcing downloads must use ozon-1688 prefix');
assert(server.includes('downloadUrl: job.downloadUrl'), 'DB history must expose downloadUrl');
assert(server.includes('await markJobDownloaded(id)'), 'download endpoint must record downloads');
assert(server.includes('logistics') || server.includes('物流'), 'single sourcing must keep logistics calculation output support');

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
assert(server.includes('hydrateWorkerRunResultImages') && server.includes('pickOzonImageUrl') && server.includes('pickCandidateImageUrl'), 'single sourcing must hydrate Ozon/1688 image URLs before Excel export');
assert(server.includes('ozon?.images') && server.includes('candidate?.picUrl') && server.includes('candidate?.localImage'), 'image hydration must support plugin/worker image payload fallbacks');
assert(server.includes('singleSourcingExcelNeedsImageRepair') && server.includes('rebuildJobArtifactsFromLocalJson'), 'history download must repair old image-less single-sourcing workbooks');
assert(String(packageJson.version).includes('review-prefix'), 'package version must describe the review and SKU prefix build');

console.log('Single sourcing review entry guard passed.');
