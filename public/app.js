/* =========================================================
   Ozon 1688 ERP - app shell + pages
   - 风格自定，参考 MYerp 的功能分类
   ========================================================= */

const ROUTES = {
  "dashboard":           { title: "仪表盘",   crumb: "总览", render: renderDashboard },
  "sourcing":            { title: "选品",     crumb: "选品", render: renderSourcingLanding },
  "sourcing/category":   { title: "类目分析", crumb: "选品 / 类目分析", render: renderCategoryAnalysis },
  "sourcing/bestsellers":{ title: "榜单选品", crumb: "选品 / 榜单选品", render: renderBestsellers },
  "sourcing/single":     { title: "单品找货", crumb: "选品 / 单品找货", render: renderSingleSourcing },
  "sourcing/batch":      { title: "批量采集", crumb: "选品 / 批量采集", render: renderBatchSourcing },
  "products":            { title: "商品",     crumb: "商品", render: renderProductsLanding },
  "products/list":       { title: "商品列表", crumb: "商品 / 商品列表", render: renderProductList },
  "products/upload":     { title: "上架",     crumb: "商品 / 上架",     render: renderProductUpload },
  "products/stock":      { title: "同步库存", crumb: "商品 / 同步库存", render: renderProductStock },
  "products/images":     { title: "AI 商品套图",crumb: "商品 / AI 商品套图", render: renderProductImages },
  "orders":              { title: "订单",     crumb: "订单", render: renderOrdersLanding },
  "orders/list":         { title: "订单列表", crumb: "订单 / 订单列表", render: renderOrderList },
  "tools":               { title: "工具",     crumb: "工具", render: renderToolsLanding },
  "tools/browser":       { title: "1688 浏览器",crumb: "工具 / 1688 浏览器", render: renderToolsBrowser },
  "tools/history":       { title: "历史与下载",crumb: "工具 / 历史", render: renderToolsHistory },
  "tools/logs":          { title: "运行日志", crumb: "工具 / 日志", render: renderToolsLogs },
};

const state = {
  user: null,
  currentJobId: null,
  pollTimer: null,
};

/* ============== DOM helpers ============== */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const elContent = $("#content");
const elPageTitle = $("#pageTitle");
const elPageCrumb = $("#pageCrumb");
const elPageActions = $("#pageActions");
const elToast = $("#toast");
const elSidebarUser = $("#sidebarUser");
const elSidebarRole = $("#sidebarRole");
const elSidebarStore = $("#sidebarStore");
const elNavProductsBadge = $("#navProductsBadge");
const elNavOrdersBadge = $("#navOrdersBadge");

let toastTimer = null;
function toast(message, level = "info") {
  elToast.textContent = message;
  elToast.className = "toast visible " + level;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elToast.classList.remove("visible"), 3200);
}

function escapeHtml(v) {
  return String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
}
function escapeAttr(v) { return escapeHtml(v).replaceAll("`","&#096;"); }
function formatTime(v) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function statusBadge(status) {
  const map = { running:["green","运行中"], done:["green","完成"], claimed:["blue","已领取"], queued:["gray","排队中"], error:["red","失败"], canceled:["gray","已停止"] };
  const [cls, label] = map[status] || ["gray", status || "—"];
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

async function postJson(url, payload) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (res.status === 401) { location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`; throw new Error("请先登录"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.error || `请求失败：${res.status}`);
  return data;
}
async function getJson(url) {
  const res = await fetch(url);
  if (res.status === 401) { location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`; throw new Error("请先登录"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.error || `请求失败：${res.status}`);
  return data;
}

/* ============== routing ============== */

function getCurrentRoute() {
  const hash = location.hash.replace(/^#\/?/, "");
  return hash || "dashboard";
}

function applyRoute() {
  const route = getCurrentRoute();
  const def = ROUTES[route] || ROUTES.dashboard;
  elPageTitle.textContent = def.title;
  elPageCrumb.textContent = def.crumb;
  elPageActions.innerHTML = "";
  elContent.innerHTML = `<div class="empty">加载中…</div>`;

  $$(".nav-item, .nav-subitem").forEach((el) => el.classList.remove("active"));
  $$(".nav-item").forEach((el) => el.classList.remove("expanded"));
  const top = route.split("/")[0];
  const topNav = $(`.nav-item[data-route="${top}"]`);
  if (topNav) topNav.classList.add("active");
  if (top !== route && topNav) {
    topNav.classList.add("expanded");
    const sub = $(`.nav-subitem[data-route="${route}"]`);
    if (sub) sub.classList.add("active");
  }

  try { def.render(elContent, route); }
  catch (err) {
    elContent.innerHTML = `<div class="empty">页面渲染失败：${escapeHtml(err.message)}</div>`;
    console.error(err);
  }
  refreshSideBadges().catch(() => {});
}

function navigate(route) {
  if (location.hash !== `#/${route}`) location.hash = `#/${route}`;
  else applyRoute();
}
window.addEventListener("hashchange", applyRoute);

/* ============== landings ============== */

function renderSourcingLanding(root) {
  root.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="label">类目分析</div><div class="value">→</div><div class="delta">浏览 Ozon 全部类目</div></div>
      <div class="stat-card"><div class="label">榜单选品</div><div class="value">→</div><div class="delta">抓 Ozon / 1688 热卖</div></div>
      <div class="stat-card"><div class="label">单品找货</div><div class="value">→</div><div class="delta">Ozon → 1688 匹配</div></div>
      <div class="stat-card"><div class="label">批量采集</div><div class="value">→</div><div class="delta">店铺/类目批量</div></div>
    </div>
    <div class="card"><p class="muted">从左侧菜单选择子项开始。</p></div>`;
}

function renderProductsLanding(root) {
  root.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card accent"><div class="label">店铺商品数</div><div class="value" id="prodCountValue">…</div><div class="delta">点「商品列表」查看明细</div></div>
      <div class="stat-card"><div class="label">上架</div><div class="value">→</div><div class="delta">新建/更新商品</div></div>
      <div class="stat-card"><div class="label">同步库存</div><div class="value">→</div><div class="delta">批量改库存</div></div>
      <div class="stat-card"><div class="label">AI 商品套图</div><div class="value">→</div><div class="delta">基于现有图生成场景图</div></div>
    </div>
    <div class="card"><p class="muted">所有操作直接对接你 Ozon 店铺的 Seller API。点左侧「上架」新建商品，「同步库存」批量改库存，「AI 商品套图」需要图像生成 API（暂未启用）。</p></div>`;
  getJson("/api/seller/dashboard").then((d) => {
    const v = $("#prodCountValue"); if (v) v.textContent = d.products?.total ?? "—";
  }).catch(() => {});
}

function renderOrdersLanding(root) {
  root.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card accent"><div class="label">订单数</div><div class="value" id="orderCountValue">…</div><div class="delta">点「订单列表」查看明细</div></div>
    </div>
    <div class="card"><p class="muted">从 Ozon Seller API 拉取订单。列表支持按状态筛选。</p></div>`;
  getJson("/api/seller/dashboard").then((d) => {
    const v = $("#orderCountValue"); if (v) v.textContent = d.orders?.total ?? "—";
  }).catch(() => {});
}

function renderToolsLanding(root) {
  root.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="label">1688 浏览器</div><div class="value">→</div><div class="delta">本机采集端管理</div></div>
      <div class="stat-card"><div class="label">历史与下载</div><div class="value">→</div><div class="delta">所有任务 Excel</div></div>
      <div class="stat-card"><div class="label">运行日志</div><div class="value">→</div><div class="delta">当前任务实时日志</div></div>
    </div>`;
}

/* ============== 仪表盘 ==================== */

async function renderDashboard(root) {
  root.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="label">今日处理</div><div class="value">…</div><div class="delta">本地任务条数</div></div>
      <div class="stat-card"><div class="label">今日任务</div><div class="value">…</div><div class="delta">本地任务批数</div></div>
      <div class="stat-card accent"><div class="label">Ozon 在售商品</div><div class="value">…</div><div class="delta">来自 Seller API</div></div>
      <div class="stat-card accent"><div class="label">Ozon 订单</div><div class="value">…</div><div class="delta">近 30 天</div></div>
    </div>
    <div class="two-col">
      <div class="card">
        <div class="card-head"><h2>最近任务</h2><a class="muted" href="#/tools/history">查看全部</a></div>
        <div class="table-wrap"><table>
          <thead><tr><th>类型</th><th>状态</th><th>进度</th><th>时间</th><th>下载</th></tr></thead>
          <tbody id="dashJobsBody"><tr><td colspan="5" class="empty">加载中…</td></tr></tbody>
        </table></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>快捷入口</h2></div>
        <p><a class="button primary" href="#/sourcing/single">开始单品找货</a></p>
        <p><a class="button" href="#/sourcing/batch">批量采集</a></p>
        <p><a class="button" href="#/products/upload">上架新商品</a></p>
        <p><a class="button" href="#/orders/list">查看订单</a></p>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>今日待办</h2><span class="meta">数据滞后 ≤ 15 分钟</span></div>
      <div class="todo-list">
        <div class="todo-item"><span class="badge red">缺货</span> 库存告急 SKU <span class="muted" id="dashLowStock">—</span></div>
        <div class="todo-item"><span class="badge amber">待改</span> Ozon 待修改商品 <span class="muted" id="dashToModify">—</span></div>
        <div class="todo-item"><span class="badge blue">发货</span> 待打包/待发货订单 <span class="muted" id="dashShip">—</span></div>
      </div>
    </div>`;
  try {
    const data = await getJson("/api/seller/dashboard");
    const cards = root.querySelectorAll(".stats-grid .stat-card .value");
    if (cards[0]) cards[0].textContent = String(data.today?.rows ?? 0);
    if (cards[1]) cards[1].textContent = String(data.today?.jobs ?? 0);
    if (cards[2]) cards[2].textContent = data.products?.total != null ? String(data.products.total) : "—";
    if (cards[3]) cards[3].textContent = data.orders?.total != null ? String(data.orders.total) : "—";
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set("#dashLowStock", data.products?.lowStock != null ? `${data.products.lowStock} 个 SKU` : "—");
    set("#dashToModify", data.products?.toModify != null ? `${data.products.toModify} 个商品` : "—");
    set("#dashShip", data.orders?.awaiting != null ? `${data.orders.awaiting} 个订单` : "—");
    const body = $("#dashJobsBody");
    const items = (data.recentJobs || []).slice(0, 8);
    if (!items.length) { body.innerHTML = `<tr><td colspan="5" class="empty">还没有任务记录</td></tr>`; }
    else {
      body.innerHTML = items.map((job) => `
        <tr>
          <td>${escapeHtml(job.kind === "batch-ozon" ? "批量采集" : "单品找货")}<br><span class="muted">${escapeHtml((job.id || "").slice(0, 8))}</span></td>
          <td>${statusBadge(job.status)}</td>
          <td>${job.processed || 0} / ${job.total || 0}</td>
          <td><span class="muted">${escapeHtml(formatTime(job.updatedAt))}</span></td>
          <td>${job.downloadUrl ? `<a class="button small" href="${escapeAttr(job.downloadUrl)}">Excel</a>` : ""}</td>
        </tr>`).join("");
    }
  } catch (error) { toast(`仪表盘加载失败：${error.message}`, "error"); }
}

/* ============== 类目分析 ==================== */

async function renderCategoryAnalysis(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>类目分析</h2>
        <span class="meta" id="catMeta">从 Ozon 拉取类目树，可下钻；明细分析需 Ozon 官方分析 API</span>
      </div>
      <div class="filter-bar">
        <div class="chip-group" id="catTimeRange">
          <span class="muted">时间范围：</span>
          <button class="chip" data-v="7">7 天</button>
          <button class="chip active" data-v="28">28 天</button>
          <button class="chip" data-v="90">90 天</button>
          <button class="chip" data-v="365">365 天</button>
        </div>
        <div class="chip-group" id="catCurrency">
          <button class="chip active" data-v="₽">₽</button>
          <button class="chip" data-v="¥">¥</button>
        </div>
        <input type="date" id="catSnapshot" />
        <button class="button small" id="catRefresh">刷新</button>
      </div>
      <div class="mode-tabs" id="catSubtabs" style="margin-top: 8px">
        <button class="mode-tab active" data-sub="all">全部类目</button>
        <button class="mode-tab" data-sub="growth">增长机会</button>
        <button class="mode-tab" data-sub="return">高退货率</button>
        <button class="mode-tab" data-sub="brand">品牌集中</button>
        <button class="mode-tab" data-sub="fbs">FBS 机会</button>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>一级类目</h2><span class="muted">点「载入子项」展开</span></div>
      <div id="catTree" class="muted">加载中…</div>
    </div>
    <div class="card">
      <div class="card-head"><h2>类目市场列表</h2><span class="meta" id="catListMeta">类目分析详情需 Ozon 官方分析 API（本项目暂用类目树占位）</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>类目</th><th>月销量</th><th>月销售额</th><th>GMV 增长</th><th>平均价</th><th>卖家数</th><th>退货率</th><th>品牌占比</th></tr></thead>
        <tbody id="catListBody"><tr><td colspan="9" class="empty">（暂未启用 — Ozon 不开放公开类目分析接口）</td></tr></tbody>
      </table></div>
    </div>`;
  $$("#catSubtabs .mode-tab").forEach((t) => t.addEventListener("click", () => {
    $$("#catSubtabs .mode-tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
  }));
  await loadCategoryTree();
}

async function loadCategoryTree() {
  const meta = $("#catMeta");
  const tree = $("#catTree");
  if (meta) meta.textContent = "加载中…";
  if (tree) tree.textContent = "加载中…";
  try {
    const data = await getJson("/api/seller/categories/tree");
    const items = data.data?.result || [];
    if (meta) meta.textContent = `共 ${items.length} 个一级类目`;
    if (!items.length) { tree.textContent = "（Ozon 没有返回类目）"; return; }
    tree.innerHTML = `<ul class="cat-tree">${items.slice(0, 100).map((c) => `
      <li>
        <span class="cat-name">${escapeHtml(c.category_name || c.name || "")}</span>
        <span class="muted">#${escapeHtml(String(c.description_category_id || c.category_id || c.id || ""))}</span>
        <button class="button small" data-cat="${escapeAttr(c.description_category_id || c.category_id || c.id || "")}" data-name="${escapeAttr(c.category_name || c.name || "")}">用此 ID</button>
      </li>`).join("")}</ul>`;
    $$("#catTree [data-cat]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-cat");
        const name = btn.getAttribute("data-name");
        const input = $("#sellerCategoryIdInput");
        if (input) input.value = id;
        toast(`已填入类目 ${id}（${name}）。切换到「上架」页继续。`, "success");
      });
    });
  } catch (e) {
    if (tree) tree.innerHTML = `<div class="empty">加载失败：${escapeHtml(e.message)}</div>`;
  }
}

/* ============== 榜单选品 ==================== */

async function renderBestsellers(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>榜单选品</h2>
        <span class="meta">Ozon top 1000 公开榜单 API 不开放；本页面提供筛选 UI，可对接第三方数据源</span>
      </div>
      <div class="mode-tabs">
        <button class="mode-tab active" data-tab="hot">热销商品</button>
        <button class="mode-tab" data-tab="new">热销新品</button>
        <button class="mode-tab" data-tab="potential">潜力商品</button>
        <button class="mode-tab" data-tab="blue">蓝海商品</button>
      </div>
      <div class="filter-bar" style="margin-top: 10px">
        <span class="muted">选品策略：</span>
        <div class="chip-group" id="bsStrategy">
          <button class="chip">高增长</button>
          <button class="chip">低价高销</button>
          <button class="chip">高加购</button>
          <button class="chip">蓝海量级</button>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="row" style="grid-template-columns: 1fr 1fr 1fr; gap: 8px">
        <input type="text" placeholder="商品名称" id="bsName" />
        <input type="text" placeholder="SKU" id="bsSku" />
        <input type="text" placeholder="批量 SKUS（逗号/空格/换行）" id="bsBulkSku" />
      </div>
      <div class="row" style="grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 8px">
        <input type="text" placeholder="月销量 最小~最大" id="bsSales" />
        <input type="text" placeholder="月销售额 最小~最大 ₽" id="bsGmv" />
        <input type="text" placeholder="平均价 最小~最大 ₽" id="bsPrice" />
      </div>
      <div class="row" style="grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px">
        <input type="text" placeholder="月销售额环比 %" id="bsGrowth" />
        <select id="bsFulfillment"><option>任意</option><option>FBS</option><option>FBO</option></select>
      </div>
      <div class="filter-bar" style="justify-content: flex-end; margin-top: 10px">
        <button class="button primary" id="bsQuery">查询</button>
        <button class="button" id="bsReset">重置</button>
      </div>
    </div>
    <div class="card">
      <div class="card-head">
        <span><strong>共 — 件商品</strong></span>
        <span class="meta">已选 0</span>
        <button class="button small">批量加入草稿箱</button>
        <button class="button small quiet">清空选择</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th></th><th>商品信息</th><th>所属类目</th><th>机会判断</th><th>月销量</th><th>月销售额</th><th>操作</th></tr></thead>
        <tbody id="bsBody"><tr><td colspan="7" class="empty">（Ozon 不开放 top 1000 公开榜单 API；本页面为占位 UI）</td></tr></tbody>
      </table></div>
    </div>`;
  $$("#bsStrategy .chip").forEach((c) => c.addEventListener("click", () => c.classList.toggle("active")));
  $("#bsQuery")?.addEventListener("click", () => toast("榜单数据需要第三方数据源接入", "info"));
}

/* ============== 单品找货 ==================== */

function renderSingleSourcing(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>单品找货</h2><span class="meta">Ozon → 1688 匹配 + AI 审核</span></div>
      <div class="row">
        <label class="field"><span>Ozon 链接（每行一个）</span><textarea id="urlsInput" spellcheck="false" placeholder="https://www.ozon.ru/product/..."></textarea></label>
        <div>
          <div class="row">
            <label class="field"><span>每商品返回候选数</span><input id="maxCandidatesInput" type="number" min="1" max="20" value="5" /></label>
            <label class="field"><span>从第几行开始</span><input id="startRowInput" type="number" min="1" value="1" /></label>
          </div>
          <div class="row">
            <label class="field"><span>间隔最小 (秒)</span><input id="delayMinInput" type="number" min="1" value="8" /></label>
            <label class="field"><span>间隔最大 (秒)</span><input id="delayMaxInput" type="number" min="1" value="20" /></label>
          </div>
          <label class="field"><span>连续异常自动停止</span><input id="maxConsecutiveFailuresInput" type="number" min="1" value="3" /></label>
          <label class="field"><span>启用项</span>
            <div>
              <label><input type="checkbox" id="enable1688Input" checked /> 1688 以图搜货</label>
              <label><input type="checkbox" id="enableAiInput" checked /> AI 严格审核</label>
              <label><input type="checkbox" id="headlessInput" /> 后台浏览器模式</label>
            </div>
          </label>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button id="runBtn" class="button primary">开始采集</button>
            <button id="cancelBtn" class="button danger" disabled>停止</button>
          </div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>实时进度</h2><span class="meta" id="singleStatus">待开始</span></div>
      <div id="singleLogs" class="code-area" style="min-height:200px"></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>结果</h2><span class="meta" id="singleResultCount">0 条</span><a id="singleDownload" class="button small hidden" href="#">下载 Excel</a></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Ozon</th><th>主图</th><th>1688 候选</th><th>状态</th></tr></thead>
        <tbody id="singleResultsBody"><tr><td colspan="4" class="empty">还没有结果</td></tr></tbody>
      </table></div>
    </div>`;
  bindSingleSourcingHandlers();
}

function bindSingleSourcingHandlers() {
  $("#runBtn")?.addEventListener("click", async () => {
    const urls = $("#urlsInput").value.trim();
    if (!urls) { toast("请粘贴 Ozon 链接", "error"); return; }
    $("#runBtn").disabled = true; $("#cancelBtn").disabled = false;
    $("#singleLogs").textContent = "任务启动中…";
    try {
      const data = await postJson("/api/jobs", {
        urlsText: urls,
        maxCandidates: Number($("#maxCandidatesInput").value || 5),
        delayMinMs: Math.round(Number($("#delayMinInput").value || 8) * 1000),
        delayMaxMs: Math.round(Number($("#delayMaxInput").value || 20) * 1000),
        startRow: Number($("#startRowInput").value || 1),
        maxConsecutiveFailures: Number($("#maxConsecutiveFailuresInput").value || 3),
        enable1688: $("#enable1688Input").checked,
        enableAI: $("#enableAiInput").checked,
        headless: $("#headlessInput").checked,
      });
      state.currentJobId = data.jobId;
      $("#singleLogs").textContent = `任务已创建：${data.jobId}\n`;
      $("#singleStatus").textContent = "排队中";
      startJobPolling();
    } catch (error) {
      $("#singleLogs").textContent = `启动失败：${error.message}`;
      $("#runBtn").disabled = false; $("#cancelBtn").disabled = true;
    }
  });
  $("#cancelBtn")?.addEventListener("click", async () => {
    if (!state.currentJobId) return;
    $("#cancelBtn").disabled = true;
    try { await postJson(`/api/jobs/${state.currentJobId}/cancel`, {}); } catch (e) { /* ignore */ }
  });
}

function startJobPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(pollCurrentJob, 1500);
  pollCurrentJob();
}

async function pollCurrentJob() {
  if (!state.currentJobId) return;
  try {
    const data = await getJson(`/api/jobs/${state.currentJobId}`);
    renderPolledJob(data.job);
    if (["done", "error", "canceled"].includes(data.job.status)) {
      clearInterval(state.pollTimer);
      const r = $("#runBtn"); if (r) r.disabled = false;
      const c = $("#cancelBtn"); if (c) c.disabled = true;
    }
  } catch (e) { /* ignore */ }
}

function renderPolledJob(job) {
  const statusLabel = $("#singleStatus");
  const logBox = $("#singleLogs");
  const resultCount = $("#singleResultCount");
  const resultsBody = $("#singleResultsBody");
  const downloadLink = $("#singleDownload");
  if (statusLabel) statusLabel.textContent = `${job.status} · ${job.phase || ""} · ${job.processed || 0}/${job.total || 0}`;
  if (logBox && job.logs) {
    logBox.textContent = job.logs.slice(-100).map((l) => `[${(l.level || "info").toUpperCase()}] ${l.message}`).join("\n") || "（暂无日志）";
  }
  if (resultCount) resultCount.textContent = `${job.results?.length || 0} 条`;
  if (resultsBody) {
    const rows = job.results || [];
    if (!rows.length) { resultsBody.innerHTML = `<tr><td colspan="4" class="empty">还没有结果</td></tr>`; return; }
    resultsBody.innerHTML = rows.map((r) => {
      const ozon = r.ozon || {};
      const cands = (r.candidates || []).slice(0, 3);
      return `<tr>
        <td><a href="${escapeAttr(r.url)}" target="_blank" rel="noreferrer">${escapeHtml(ozon.title || r.url)}</a><br><span class="muted">${escapeHtml(ozon.currentBlackPriceCny || "")}</span></td>
        <td>${ozon.mainImage?.publicUrl ? `<img class="thumb" src="${escapeAttr(ozon.mainImage.publicUrl)}">` : ""}</td>
        <td>${cands.length ? cands.map((c) => `<div>${escapeHtml(c.rank)}. ${escapeHtml(c.title || "")}<br><span class="muted">${escapeHtml(c.price || "")}</span></div>`).join("") : "<span class='muted'>无候选</span>"}</td>
        <td>${escapeHtml(r.aiReview?.decision || r.error || "已采集")}</td>
      </tr>`;
    }).join("");
  }
  if (downloadLink && job.downloadUrl) {
    downloadLink.href = job.downloadUrl;
    downloadLink.classList.remove("hidden");
  }
}

/* ============== 批量采集 ==================== */

function renderBatchSourcing(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>批量采集模式</h2><span class="meta">从店铺/类目链接自动发现商品</span></div>
      <label class="field"><span>Ozon 店铺/商品链接（单个）</span><input id="batchSourceInput" type="text" placeholder="https://www.ozon.ru/seller/..." /></label>
      <div class="row">
        <label class="field"><span>最多采集商品数</span><input id="batchMaxProductsInput" type="number" min="1" max="500" value="50" /></label>
        <label class="field"><span>连续异常自动停止</span><input id="batchMaxFailuresInput" type="number" min="1" value="3" /></label>
      </div>
      <div class="row">
        <label class="field"><span>间隔最小 (秒)</span><input id="batchDelayMinInput" type="number" min="1" value="8" /></label>
        <label class="field"><span>间隔最大 (秒)</span><input id="batchDelayMaxInput" type="number" min="1" value="20" /></label>
      </div>
      <div class="row">
        <label class="field"><span>黑标价 RMB 区间</span>
          <div class="row"><input id="batchMinPriceInput" type="number" placeholder="最低" /><input id="batchMaxPriceInput" type="number" placeholder="最高" /></div>
        </label>
        <label class="field"><span>跟卖数量区间</span>
          <div class="row"><input id="batchMinSellerInput" type="number" placeholder="最低" /><input id="batchMaxSellerInput" type="number" placeholder="最高" /></div>
        </label>
      </div>
      <label class="field"><span>标题关键词（可选）</span><input id="batchKeywordInput" type="text" placeholder="可不填" /></label>
      <label><input type="checkbox" id="batchHeadlessInput" /> 后台浏览器模式</label>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button id="batchRunBtn" class="button primary">开始批量采集</button>
        <button id="batchCancelBtn" class="button danger" disabled>停止</button>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>实时进度</h2><span class="meta" id="batchStatus">待开始</span></div>
      <div id="batchLogs" class="code-area" style="min-height:200px"></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>结果（按筛选）</h2><span class="meta" id="batchResultCount">0 条</span><a id="batchDownload" class="button small hidden" href="#">下载 Excel</a></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Ozon</th><th>主图</th><th>筛选</th><th>状态</th></tr></thead>
        <tbody id="batchResultsBody"><tr><td colspan="4" class="empty">还没有结果</td></tr></tbody>
      </table></div>
    </div>`;
  bindBatchHandlers();
}

function bindBatchHandlers() {
  $("#batchRunBtn")?.addEventListener("click", async () => {
    const url = $("#batchSourceInput").value.trim();
    if (!url) { toast("请粘贴 Ozon 店铺/商品链接", "error"); return; }
    $("#batchRunBtn").disabled = true; $("#batchCancelBtn").disabled = false;
    $("#batchLogs").textContent = "任务启动中…";
    try {
      const data = await postJson("/api/batch-ozon/jobs", {
        sourceUrl: url,
        maxProducts: Number($("#batchMaxProductsInput").value || 50),
        delayMinMs: Math.round(Number($("#batchDelayMinInput").value || 8) * 1000),
        delayMaxMs: Math.round(Number($("#batchDelayMaxInput").value || 20) * 1000),
        maxConsecutiveFailures: Number($("#batchMaxFailuresInput").value || 3),
        headless: $("#batchHeadlessInput").checked,
        filters: {
          minPriceRmb: $("#batchMinPriceInput").value,
          maxPriceRmb: $("#batchMaxPriceInput").value,
          minSellerCount: $("#batchMinSellerInput").value,
          maxSellerCount: $("#batchMaxSellerInput").value,
          titleKeyword: $("#batchKeywordInput").value,
        },
      });
      state.currentJobId = data.jobId;
      $("#batchStatus").textContent = "排队中";
      startJobPolling();
    } catch (error) {
      $("#batchLogs").textContent = `启动失败：${error.message}`;
      $("#batchRunBtn").disabled = false; $("#batchCancelBtn").disabled = true;
    }
  });
  $("#batchCancelBtn")?.addEventListener("click", async () => {
    if (!state.currentJobId) return;
    $("#batchCancelBtn").disabled = true;
    try { await postJson(`/api/jobs/${state.currentJobId}/cancel`, {}); } catch (e) { /* ignore */ }
  });
}

/* ============== 商品列表 ==================== */

async function renderProductList(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>商品列表</h2>
        <span class="meta" id="plMeta">加载中…</span>
        <button class="button small" id="plRefresh">刷新</button>
      </div>
      <div class="mode-tabs" id="plStatusTabs">
        <button class="mode-tab active" data-v="active">在售 <span class="muted" id="plActiveCount">—</span></button>
        <button class="mode-tab" data-v="archived">已归档 <span class="muted" id="plArchivedCount">—</span></button>
        <button class="mode-tab" data-v="all">全部 <span class="muted" id="plAllCount">—</span></button>
      </div>
      <div class="filter-bar" style="margin-top: 8px">
        <input type="search" id="plSearch" placeholder="按 offer_id / 名称 过滤" />
        <input type="number" id="plLimit" min="10" max="200" value="50" />
        <button class="button" id="plGo">加载</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>商品</th><th>offer_id / SKU</th><th>价格</th><th>状态</th></tr></thead>
        <tbody id="plBody"><tr><td colspan="4" class="empty">加载中…</td></tr></tbody>
      </table></div>
    </div>`;
  $$("#plStatusTabs .mode-tab").forEach((t) => t.addEventListener("click", () => {
    $$("#plStatusTabs .mode-tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    loadProductList();
  }));
  $("#plRefresh")?.addEventListener("click", () => loadProductList());
  $("#plGo")?.addEventListener("click", () => loadProductList());
  await loadProductList();
}

async function loadProductList() {
  const limit = Number($("#plLimit")?.value || 50);
  const search = ($("#plSearch")?.value || "").toLowerCase();
  const tab = $$("#plStatusTabs .mode-tab").find((t) => t.classList.contains("active"))?.dataset.v || "active";
  const archived = tab === "archived" ? "true" : "false";
  const meta = $("#plMeta");
  const body = $("#plBody");
  if (meta) meta.textContent = "加载中…";
  if (body) body.innerHTML = `<tr><td colspan="4" class="empty"><span class="spinner"></span> 加载中…</td></tr>`;
  try {
    const data = await getJson(`/api/seller/products?limit=${limit}&archived=${archived}`);
    let items = data.data?.result?.items || data.data?.items || [];
    if (search) items = items.filter((it) => (it.name || "").toLowerCase().includes(search) || (it.offer_id || "").toLowerCase().includes(search));
    if (tab === "active") items = items.filter((it) => !it.archived);
    if (meta) meta.textContent = `共 ${items.length} 个`;
    if (!items.length) { body.innerHTML = `<tr><td colspan="4" class="empty">无数据</td></tr>`; return; }
    body.innerHTML = items.map((it) => `
      <tr>
        <td>${escapeHtml(it.name || it.offer_id || "—")}</td>
        <td><span class="muted">${escapeHtml(it.offer_id || "—")}</span></td>
        <td>${escapeHtml(it.price || "—")}</td>
        <td>${it.archived ? '<span class="badge gray">已归档</span>' : '<span class="badge green">在售</span>'}</td>
      </tr>`).join("");
  } catch (error) {
    if (body) body.innerHTML = `<tr><td colspan="4" class="empty">加载失败：${escapeHtml(error.message)}</td></tr>`;
  }
}

/* ============== 上架 ==================== */

function renderProductUpload(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>上架新商品</h2>
        <span class="meta" id="sellerStatus">未连接</span>
        <button class="button small" id="sellerTestBtn">测试连接</button>
      </div>
      <p class="muted">必填：标题、SKU、类目 ID（数字）。其它字段按需填。类目 ID 可从「类目分析」页点「用此 ID」自动填入。</p>
      <div class="row">
        <label class="field"><span>类目 ID</span><input id="sellerCategoryIdInput" type="text" placeholder="例如 17032807" /></label>
        <label class="field"><span>商品标题</span><input id="sellerNameInput" type="text" placeholder="俄文标题" /></label>
      </div>
      <div class="row">
        <label class="field"><span>SKU</span><input id="sellerSkuInput" type="text" placeholder="OZ-..." /></label>
        <label class="field"><span>Barcode（可选）</span><input id="sellerBarcodeInput" type="text" /></label>
      </div>
      <div class="row">
        <label class="field"><span>售价</span><input id="sellerPriceInput" type="text" placeholder="999.00" /></label>
        <label class="field"><span>重量（克）</span><input id="sellerWeightInput" type="text" placeholder="80" /></label>
      </div>
      <div class="row">
        <label class="field"><span>长 (cm)</span><input id="sellerDepthInput" type="text" /></label>
        <label class="field"><span>宽 (cm)</span><input id="sellerWidthInput" type="text" /></label>
        <label class="field"><span>高 (cm)</span><input id="sellerHeightInput" type="text" /></label>
      </div>
      <label class="field"><span>图片 URL（一行一张）</span><textarea id="sellerImagesInput" spellcheck="false"></textarea></label>
      <label class="field"><span>类目属性（JSON 数组）</span><textarea id="sellerAttributesInput" class="code-area" placeholder='[{"id":85,"values":[{"value":"..."}]}]'></textarea></label>
      <div style="display:flex;gap:8px">
        <button class="button quiet" id="sellerLoadSampleBtn">载入手机壳样例</button>
        <button class="button quiet" id="sellerClearBtn">清空</button>
        <button class="button primary" id="sellerImportBtn">上架</button>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Ozon 返回</h2></div>
      <pre id="sellerResponse" class="response-area">点「测试连接」或「上架」后这里会显示 Ozon 的响应。</pre>
    </div>`;
  bindUploadHandlers();
}

function bindUploadHandlers() {
  $("#sellerTestBtn")?.addEventListener("click", async () => {
    const out = $("#sellerResponse");
    out.textContent = "正在测试连接…";
    try {
      const data = await postJson("/api/seller/test", {});
      $("#sellerStatus").textContent = "连接成功";
      out.textContent = JSON.stringify(data, null, 2);
    } catch (error) {
      $("#sellerStatus").textContent = `失败：${error.message}`;
      out.textContent = error.message;
    }
  });
  $("#sellerLoadSampleBtn")?.addEventListener("click", () => {
    $("#sellerCategoryIdInput").value = "17032807";
    $("#sellerNameInput").value = "Прозрачный силиконовый чехол для iPhone 15";
    $("#sellerSkuInput").value = "OZON-DEMO-CASE-001";
    $("#sellerBarcodeInput").value = "6901234567890";
    $("#sellerPriceInput").value = "999.00";
    $("#sellerWeightInput").value = "80";
    $("#sellerDepthInput").value = "18"; $("#sellerWidthInput").value = "9"; $("#sellerHeightInput").value = "2";
    $("#sellerImagesInput").value = "https://cdn.example.com/sample-1.jpg\nhttps://cdn.example.com/sample-2.jpg";
    $("#sellerAttributesInput").value = JSON.stringify([
      { id: 85, complex_id: 0, values: [{ value: "Прозрачный" }] },
      { id: 8229, complex_id: 0, values: [{ value: "Силикон" }] },
      { id: 9163, complex_id: 0, values: [{ value: "iPhone 15" }] },
    ], null, 2);
    toast("已载入手机壳样例", "success");
  });
  $("#sellerClearBtn")?.addEventListener("click", () => {
    ["sellerCategoryIdInput","sellerNameInput","sellerSkuInput","sellerBarcodeInput","sellerPriceInput","sellerWeightInput","sellerDepthInput","sellerWidthInput","sellerHeightInput","sellerImagesInput","sellerAttributesInput"]
      .forEach((id) => { const el = $("#" + id); if (el) el.value = ""; });
    $("#sellerResponse").textContent = "已清空。";
  });
  $("#sellerImportBtn")?.addEventListener("click", async () => {
    const item = {
      name: $("#sellerNameInput").value.trim(),
      sku: $("#sellerSkuInput").value.trim(),
      category_id: Number($("#sellerCategoryIdInput").value.trim()) || 0,
    };
    if (!item.name || !item.sku || !item.category_id) {
      $("#sellerResponse").textContent = "请至少填写：标题、SKU、类目 ID（数字）。";
      return;
    }
    const barcode = $("#sellerBarcodeInput").value.trim();
    if (barcode) item.barcode = barcode;
    const price = $("#sellerPriceInput").value.trim();
    if (price) item.price = price;
    const weight = $("#sellerWeightInput").value.trim();
    if (weight) item.weight = Number(weight);
    const depth = $("#sellerDepthInput").value.trim();
    const width = $("#sellerWidthInput").value.trim();
    const height = $("#sellerHeightInput").value.trim();
    if (depth || width || height) {
      item.depth = Number(depth) || 0; item.width = Number(width) || 0; item.height = Number(height) || 0;
    }
    const images = $("#sellerImagesInput").value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (images.length) item.images = images;
    const attrsText = $("#sellerAttributesInput").value.trim();
    if (attrsText) {
      try { item.attributes = JSON.parse(attrsText); } catch (error) {
        $("#sellerResponse").textContent = `类目属性 JSON 解析失败：${error.message}`; return;
      }
    }
    $("#sellerResponse").textContent = "正在提交到 Ozon …";
    try {
      const data = await postJson("/api/seller/products/import", { item });
      $("#sellerResponse").textContent = JSON.stringify(data, null, 2);
      toast("上架请求已提交", "success");
    } catch (error) {
      $("#sellerResponse").textContent = error.message;
      toast(error.message, "error");
    }
  });
}

/* ============== 同步库存 ==================== */

function renderProductStock(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>同步库存</h2><span class="meta">调 Ozon /v2/products/stocks 批量改库存</span></div>
      <p class="muted">每条库存需要：<code>sku</code>、<code>warehouse_id</code>（从「仓库」接口查）、<code>present</code>（现有库存）。</p>
      <label class="field"><span>仓库</span>
        <select id="stockWarehouseId"><option value="">（加载中…）</option></select>
      </label>
      <label class="field"><span>库存更新（JSON 数组）</span>
        <textarea id="stockPayload" class="code-area" placeholder='[{"sku":"OZ-001","present":50,"reserved":0}]'></textarea>
      </label>
      <div style="display:flex;gap:8px">
        <button class="button" id="stockLoadSample">载入样例</button>
        <button class="button primary" id="stockSubmit">同步</button>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Ozon 返回</h2></div>
      <pre id="stockResponse" class="response-area">点击「同步」后这里会显示 Ozon 的响应。</pre>
    </div>`;
  // 拉仓库列表
  getJson("/api/seller/warehouses").then((data) => {
    const items = data.data?.result || data.data || [];
    const sel = $("#stockWarehouseId");
    if (!sel) return;
    if (!items.length) { sel.innerHTML = `<option value="">(Ozon 没有返回仓库)</option>`; return; }
    sel.innerHTML = items.map((it) => `<option value="${escapeAttr(it.warehouse_id || it.id || "")}">${escapeHtml(it.name || ("仓库 " + (it.warehouse_id || it.id)))}</option>`).join("");
  }).catch((e) => {
    const sel = $("#stockWarehouseId"); if (sel) sel.innerHTML = `<option value="">${escapeHtml(e.message)}</option>`;
  });
  $("#stockLoadSample")?.addEventListener("click", () => {
    const wh = $("#stockWarehouseId")?.value || "123456";
    $("#stockPayload").value = JSON.stringify([
      { sku: "OZON-DEMO-CASE-001", warehouse_id: Number(wh), present: 100, reserved: 0 },
    ], null, 2);
  });
  $("#stockSubmit")?.addEventListener("click", async () => {
    let stocks;
    try { stocks = JSON.parse($("#stockPayload").value); } catch (error) {
      $("#stockResponse").textContent = `JSON 解析失败：${error.message}`; return;
    }
    // 补上默认 warehouse_id
    const wh = $("#stockWarehouseId")?.value;
    if (wh) stocks = stocks.map((s) => ({ ...s, warehouse_id: s.warehouse_id || Number(wh) }));
    $("#stockResponse").textContent = "正在同步…";
    try {
      const data = await postJson("/api/seller/products/stocks", { stocks });
      $("#stockResponse").textContent = JSON.stringify(data, null, 2);
      toast("库存同步已提交", "success");
    } catch (error) {
      $("#stockResponse").textContent = error.message;
      toast(error.message, "error");
    }
  });
}

/* ============== AI 商品套图 ==================== */

function renderProductImages(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>AI 商品套图 <span class="badge blue">占位</span></h2>
        <span class="meta">本项目暂未启用图像生成</span>
      </div>
      <p class="muted">功能描述：上传商品图，AI 立刻生成符合多电商平台规范的高转化率商品套图。</p>
      <p class="muted">当前 MiniMax-M3 是文本模型，不支持图像生成。该功能等接入图像生成 API（Gemini Pro / 第三方服务）后启用。</p>
    </div>
    <div class="two-col">
      <div class="card">
        <div class="card-head"><h2>商品原图</h2><span class="meta">单张 ≤ 10MB · jpg / jpeg / png</span></div>
        <div class="upload-area">
          <div class="upload-icon">⬆</div>
          <div>点击、拖拽、或 <kbd>Ctrl/⌘+V</kbd> 粘贴图片</div>
          <div class="muted">推荐白底或纯净背景的主体清晰图</div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2>套图预览</h2><button class="button small" disabled>↓ 下载全部</button></div>
        <div class="empty">上传商品图后，这里会显示 AI 生成的 8 张场景图。</div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>生成设置</h2></div>
      <label class="field"><span>生成模型</span>
        <div class="model-pick">
          <div class="model-card disabled">
            <div class="model-name">⚡ Gemini Pro · 高质量</div>
            <div class="model-meta">100 套电商模板自动选场景 · 渲染本地化文案</div>
            <button class="button small" disabled>切换</button>
          </div>
        </div>
      </label>
      <div class="row" style="grid-template-columns: 1fr 1fr 1fr; gap: 8px">
        <label class="field"><span>平台</span><select disabled><option>OZON</option></select></label>
        <label class="field"><span>语言</span><select disabled><option>俄语</option></select></label>
        <label class="field"><span>比例</span><select disabled><option>3:4</option></select></label>
      </div>
      <label class="field"><span>商品卖点 & 要求</span>
        <div class="row" style="grid-template-columns: 1fr auto; gap: 8px">
          <textarea id="imgSellingPoints" placeholder="建议：1. 产品名称  2. 核心卖点  3. 适用人群  4. 期望场景" disabled></textarea>
          <button class="button" disabled>⚡ AI 帮写</button>
        </div>
      </label>
      <div class="filter-bar" style="justify-content: space-between; margin-top: 8px">
        <span class="muted">⚡ 生成一套 8 张套图，消耗 400 MY币</span>
        <button class="button primary" disabled>⚡ 一键生成爆款套图</button>
      </div>
    </div>`;
}

/* ============== 订单列表 ==================== */

async function renderOrderList(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>订单</h2>
        <span class="meta">2026-07-02 周四 · 当前店铺</span>
        <div class="filter-bar" style="margin-left: auto">
          <button class="button small" id="orderRefresh">↻ 刷新</button>
        </div>
      </div>
      <div class="stats-grid">
        <div class="stat-card"><div class="label">本周 GMV</div><div class="value">—</div><div class="delta">—</div></div>
        <div class="stat-card"><div class="label">本周利润</div><div class="value">—</div><div class="delta">—</div></div>
        <div class="stat-card accent"><div class="label">本周利润率</div><div class="value">—</div><div class="delta">—</div></div>
        <div class="stat-card accent"><div class="label">待处理</div><div class="value" id="orderCountValue">—</div><div class="delta">0 待备货 · — 待发运</div></div>
      </div>
      <div class="mode-tabs" id="orderTabs" style="margin-top: 12px">
        <button class="mode-tab active" data-tab="all">所有订单</button>
        <button class="mode-tab" data-tab="awaiting_packaging">等待备货</button>
        <button class="mode-tab" data-tab="awaiting_deliver">等待发运</button>
        <button class="mode-tab" data-tab="delivering">运输中</button>
        <button class="mode-tab" data-tab="delivered">已签收</button>
        <button class="mode-tab" data-tab="cancelled">已取消</button>
      </div>
    </div>
    <div class="card">
      <div class="filter-bar">
        <input type="search" id="orderSearch" placeholder="搜索货件号 / SKU / 货号 / 物流单号" />
        <select id="orderStatus">
          <option value="">全部状态</option>
          <option value="awaiting_packaging">等待备货</option>
          <option value="awaiting_deliver">等待发运</option>
          <option value="delivering">运输中</option>
          <option value="delivered">已签收</option>
          <option value="cancelled">已取消</option>
        </select>
        <input type="number" id="orderLimit" min="10" max="200" value="50" />
        <button class="button" id="orderFilter">筛选</button>
        <button class="button" id="orderReset">重置</button>
        <button class="button primary" id="orderExport">↓ 订单导出</button>
      </div>
    </div>
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>货件号</th><th>状态</th><th>店铺</th><th>商品</th><th>仓库 / 配送</th><th>金额</th><th>创建时间</th></tr></thead>
        <tbody id="orderBody"><tr><td colspan="7" class="empty">加载中…</td></tr></tbody>
      </table></div>
    </div>`;
  $$("#orderTabs .mode-tab").forEach((t) => t.addEventListener("click", () => {
    $$("#orderTabs .mode-tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    $("#orderStatus").value = t.dataset.tab === "all" ? "" : t.dataset.tab;
    loadOrders();
  }));
  $("#orderStatus")?.addEventListener("change", () => loadOrders());
  $("#orderRefresh")?.addEventListener("click", () => loadOrders());
  $("#orderFilter")?.addEventListener("click", () => loadOrders());
  $("#orderReset")?.addEventListener("click", () => { $("#orderStatus").value = ""; $("#orderSearch").value = ""; loadOrders(); });
  $("#orderExport")?.addEventListener("click", () => toast("订单导出：当前显示列表可复制粘贴到 Excel", "info"));
  await loadOrders();
}

async function loadOrders() {
  const limit = Number($("#orderLimit")?.value || 50);
  const status = $("#orderStatus")?.value || "";
  const search = ($("#orderSearch")?.value || "").toLowerCase();
  const body = $("#orderBody");
  const countEl = $("#orderCountValue");
  if (body) body.innerHTML = `<tr><td colspan="7" class="empty"><span class="spinner"></span> 加载中…</td></tr>`;
  try {
    const data = await getJson(`/api/seller/orders?limit=${limit}&status=${encodeURIComponent(status)}`);
    let items = data.data?.items || data.data?.result?.items || [];
    if (search) items = items.filter((it) => (it.order_number || it.posting_number || it.id || "").toLowerCase().includes(search));
    if (countEl) countEl.textContent = String(items.length);
    if (!items.length) { body.innerHTML = `<tr><td colspan="7" class="empty">无订单数据（Ozon /v2/postings/list 接口暂未返回结果，请检查 Seller API 权限）</td></tr>`; return; }
    body.innerHTML = items.slice(0, limit).map((it) => {
      const products = (it.products || []).map((p) => p.name || p.sku || "").join("；");
      const wh = it.warehouse_name || it.delivery_method || "—";
      return `<tr>
        <td><span class="muted">${escapeHtml(it.order_number || it.posting_number || it.id || "—")}</span></td>
        <td>${statusBadge(it.status)}</td>
        <td>${escapeHtml(it.cluster_name || it.warehouse_name || "—")}</td>
        <td>${escapeHtml(products.slice(0, 80))}</td>
        <td>${escapeHtml(wh)}</td>
        <td>${escapeHtml(it.total_price || "—")}</td>
        <td><span class="muted">${escapeHtml(formatTime(it.created_at))}</span></td>
      </tr>`;
    }).join("");
  } catch (error) {
    if (body) body.innerHTML = `<tr><td colspan="7" class="empty">加载失败：${escapeHtml(error.message)}</td></tr>`;
  }
}

/* ============== 工具页 ==================== */

function renderToolsBrowser(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>1688 浏览器</h2><span class="meta" id="browserStatus">未知</span></div>
      <p class="muted">服务器队列模式下，浏览器由你 Mac 上的「本机采集端」管理。下面两个按钮仅在单机模式下生效。</p>
      <div style="display:flex;gap:8px">
        <button class="button" id="open1688Btn">打开 1688 登录窗口</button>
        <button class="button quiet" id="closeBrowserBtn">关闭浏览器</button>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>本机采集端</h2><span class="meta" id="collectorMeta">—</span></div>
      <p class="muted">查看 collector 状态：<code>screen -ls</code> 或 <code>tail -f /Users/eason/Documents/OZON/data/collector.log</code></p>
    </div>`;
  $("#open1688Btn")?.addEventListener("click", async () => {
    try { const data = await postJson("/api/1688/open", {}); toast(data.message || "已请求打开 1688 浏览器", "success"); }
    catch (e) { toast(e.message, "error"); }
  });
  $("#closeBrowserBtn")?.addEventListener("click", async () => {
    try { await postJson("/api/browser/close", {}); toast("已关闭浏览器", "success"); }
    catch (e) { toast(e.message, "error"); }
  });
  getJson("/api/auth/status").then((s) => {
    $("#browserStatus").textContent = s.collectorMode ? "本机采集端模式" : "服务器模式";
    $("#collectorMeta").textContent = s.collectorMode ? "在服务器队列模式下，浏览器由你 Mac 上的 collector.js 接管" : "单机模式";
  }).catch(() => {});
}

async function renderToolsHistory(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>历史与下载</h2><button class="button small" id="historyRefresh">刷新</button></div>
      <div class="stats-grid" id="historyStats">
        <div class="stat-card"><div class="label">今日处理</div><div class="value">…</div></div>
        <div class="stat-card"><div class="label">今日任务</div><div class="value">…</div></div>
        <div class="stat-card"><div class="label">历史文件</div><div class="value">…</div></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>任务</th><th>进度</th><th>更新时间</th><th>下载</th></tr></thead>
        <tbody id="historyBody"><tr><td colspan="4" class="empty">加载中…</td></tr></tbody>
      </table></div>
    </div>`;
  $("#historyRefresh")?.addEventListener("click", () => loadHistory());
  await loadHistory();
}

async function loadHistory() {
  try {
    const data = await getJson("/api/history");
    const today = data.today || {};
    $("#historyStats").innerHTML = `
      <div class="stat-card"><div class="label">今日处理</div><div class="value">${today.rows || 0}</div><div class="delta">条</div></div>
      <div class="stat-card"><div class="label">今日任务</div><div class="value">${today.jobs || 0}</div><div class="delta">批</div></div>
      <div class="stat-card"><div class="label">历史文件</div><div class="value">${(data.items || []).length}</div><div class="delta">份</div></div>
    `;
    const items = data.items || [];
    const body = $("#historyBody");
    if (!items.length) { body.innerHTML = `<tr><td colspan="4" class="empty">还没有历史 Excel</td></tr>`; return; }
    body.innerHTML = items.slice(0, 50).map((it) => `
      <tr>
        <td>${escapeHtml(it.kind === "batch-ozon" ? "批量采集" : "单品找货")}<br><span class="muted">${escapeHtml((it.id || "").slice(0, 8))}</span></td>
        <td>${it.processed || 0} / ${it.total || 0}</td>
        <td><span class="muted">${escapeHtml(formatTime(it.updatedAt))}</span></td>
        <td>${it.downloadUrl ? `<a class="button small" href="${escapeAttr(it.downloadUrl)}">下载</a>` : ""}</td>
      </tr>`).join("");
  } catch (e) { toast(e.message, "error"); }
}

function renderToolsLogs(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>运行日志</h2>
        <select id="logJobPicker"></select>
        <button class="button small" id="logRefresh">刷新</button>
      </div>
      <pre id="logBox" class="response-area">选择任务查看实时日志…</pre>
    </div>`;
  const picker = $("#logJobPicker");
  getJson("/api/history").then((d) => {
    const items = (d.items || []).slice(0, 30);
    if (!items.length) { picker.innerHTML = `<option>暂无任务</option>`; return; }
    picker.innerHTML = items.map((it) => `<option value="${escapeAttr(it.id)}">${escapeHtml(it.kind === "batch-ozon" ? "批量采集" : "单品找货")} · ${escapeHtml((it.id || "").slice(0, 8))} · ${escapeHtml(formatTime(it.updatedAt))}</option>`).join("");
  }).catch(() => {});
  picker?.addEventListener("change", () => loadLog(picker.value));
  $("#logRefresh")?.addEventListener("click", () => { if (picker.value) loadLog(picker.value); });
}

async function loadLog(jobId) {
  const box = $("#logBox");
  box.textContent = "加载中…";
  try {
    const data = await getJson(`/api/jobs/${jobId}`);
    box.textContent = (data.job.logs || []).map((l) => `[${(l.level || "info").toUpperCase()}] ${l.message}`).join("\n");
  } catch (error) { box.textContent = `加载失败：${error.message}`; }
}

/* ============== sidebar badges ============== */

async function refreshSideBadges() {
  try {
    const data = await getJson("/api/seller/dashboard");
    if (data.products?.total != null) elNavProductsBadge.textContent = String(data.products.total);
    if (data.orders?.total != null) elNavOrdersBadge.textContent = String(data.orders.total);
  } catch (e) { /* ignore */ }
}

/* ============== nav click bindings ============== */

$$(".nav-item, .nav-subitem").forEach((el) => {
  el.addEventListener("click", (e) => {
    e.preventDefault();
    const route = el.getAttribute("data-route");
    if (route) navigate(route);
  });
});

/* ============== logout ============== */

$("#logoutBtn")?.addEventListener("click", async () => {
  try { await postJson("/api/auth/logout", {}); } catch (e) { /* ignore */ }
  location.href = "/login";
});

/* ============== init ============== */

(async function init() {
  try {
    const data = await getJson("/api/auth/status");
    if (data.user) {
      state.user = data.user;
      elSidebarUser.textContent = data.user.display_name || data.user.username || "已登录";
      elSidebarRole.textContent = data.user.role || "";
    } else { elSidebarUser.textContent = "未登录"; }
    if (data.collectorMode) elSidebarStore.textContent = "服务器队列模式";
    else elSidebarStore.textContent = "单机模式";
  } catch (e) { elSidebarUser.textContent = "未登录"; }
  applyRoute();
})();
