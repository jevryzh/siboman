/* =========================================================
   逐梦 ERP - app shell + pages
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
  if (topNav) {
    topNav.classList.add("active");
    // 顶级栏目且有子项 → 一直展开
    const hasSub = document.querySelector(`.nav-subitem[data-parent="${top}"]`);
    if (hasSub) topNav.classList.add("expanded");
  }
  if (top !== route && topNav) {
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
          <thead><tr><th style="min-width:120px">类型</th><th>状态</th><th>进度</th><th>时间</th><th>下载</th></tr></thead>
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
          <td class="wrap"><div>${escapeHtml(job.kind === "batch-ozon" ? "批量采集" : "单品找货")}</div><span class="muted">${escapeHtml((job.id || "").slice(0, 8))}</span></td>
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
        <thead><tr><th>#</th><th style="min-width:160px">类目</th><th>月销量</th><th>月销售额</th><th>发货/取消</th><th>退货率</th><th>取消率</th><th>ID</th><th>—</th></tr></thead>
        <tbody id="catListBody"><tr><td colspan="9" class="empty">（暂未启用 — Ozon 不开放公开类目分析接口）</td></tr></tbody>
      </table></div>
    </div>`;
  $$("#catSubtabs .mode-tab").forEach((t) => t.addEventListener("click", () => {
    $$("#catSubtabs .mode-tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    loadCategoryAnalytics();
  }));
  $$("#catTimeRange .chip").forEach((t) => t.addEventListener("click", () => {
    $$("#catTimeRange .chip").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    loadCategoryAnalytics();
  }));
  await loadCategoryTree();
  await loadCategoryAnalytics();
}

async function loadCategoryTree() {
  const meta = $("#catMeta");
  const tree = $("#catTree");
  if (tree) tree.textContent = "加载中…";
  try {
    const data = await postJson("/api/seller/categories/tree", {});
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

async function loadCategoryAnalytics() {
  const range = $$("#catTimeRange .chip").find((c) => c.classList.contains("active"))?.dataset.v || "30";
  const dim = $$("#catSubtabs .mode-tab").find((c) => c.classList.contains("active"))?.dataset.sub || "all";
  const dimension = dim === "all" ? "category1" : dim === "growth" ? "category1" : "category1";
  const body = $("#catListBody");
  const meta = $("#catListMeta");
  if (body) body.innerHTML = `<tr><td colspan="9" class="empty"><span class="spinner"></span> 加载中…</td></tr>`;
  try {
    const data = await postJson("/api/seller/analytics/categories", { range, dimension });
    const items = (data.data?.result?.data || []).map((row) => {
      const dim = row.dimensions?.[0] || {};
      const m = row.metrics || [];
      const revenue = m[0] || 0;
      const ordered = m[1] || 0;
      const returns = m[2] || 0;
      const delivered = m[3] || 0;
      const cancels = m[4] || 0;
      const returnRate = ordered > 0 ? (returns / ordered * 100) : 0;
      const cancelRate = ordered > 0 ? (cancels / ordered * 100) : 0;
      return { name: dim.name || "—", id: dim.id || "—", revenue, ordered, returns, delivered, cancels, returnRate, cancelRate };
    });
    items.sort((a, b) => b.revenue - a.revenue);
    if (meta) meta.textContent = `共 ${items.length} 个类目（近 ${data.range} 天，按销售额降序）`;
    if (!items.length) { body.innerHTML = `<tr><td colspan="9" class="empty">该时间范围内没有数据</td></tr>`; return; }
    // 顶部 5 个统计卡
    const totalRev = items.reduce((s, it) => s + it.revenue, 0);
    const totalOrd = items.reduce((s, it) => s + it.ordered, 0);
    const totalRet = items.reduce((s, it) => s + it.returns, 0);
    const avgRetRate = totalOrd > 0 ? (totalRet / totalOrd * 100) : 0;
    const topCat = items[0];
    const cards = $$("#catStats .stat-card .value");
    if (cards[0]) cards[0].textContent = String(items.length);
    if (cards[1]) cards[1].textContent = totalOrd.toLocaleString();
    if (cards[2]) cards[2].textContent = `₽ ${totalRev.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    if (cards[3]) cards[3].textContent = `${avgRetRate.toFixed(2)}%`;
    if (cards[4]) cards[4].textContent = topCat ? `${topCat.name} ₽${topCat.revenue.toFixed(0)}` : "—";

    body.innerHTML = items.map((it, i) => `
      <tr>
        <td>${i + 1}</td>
        <td class="wrap"><a href="#" data-cat="${escapeAttr(it.id)}" data-name="${escapeAttr(it.name)}">${escapeHtml(it.name)}</a><div class="muted">#${escapeHtml(it.id)}</div></td>
        <td>${it.ordered}</td>
        <td>₽ ${it.revenue.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
        <td>${it.delivered}/${it.cancels}</td>
        <td>${it.returnRate.toFixed(2)}%</td>
        <td>${it.cancelRate.toFixed(2)}%</td>
        <td>—</td>
        <td>—</td>
      </tr>`).join("");
    $$("#catListBody [data-cat]").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const id = a.getAttribute("data-cat");
        const name = a.getAttribute("data-name");
        const input = $("#sellerCategoryIdInput");
        if (input) input.value = id;
        toast(`已填入类目 ${id}（${name}）。切换到「上架」页继续。`, "success");
      });
    });
  } catch (e) {
    if (body) body.innerHTML = `<tr><td colspan="9" class="empty">加载失败：${escapeHtml(e.message)}</td></tr>`;
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
        <thead><tr><th style="min-width:180px">Ozon</th><th>主图</th><th style="min-width:280px">1688 候选</th><th>状态</th></tr></thead>
        <tbody id="singleResultsBody"><tr><td colspan="4" class="empty">还没有结果</td></tr></tbody>
      </table></div>
    </div>`;
  bindSingleSourcingHandlers();
}

function bindSingleSourcingHandlers() {
  $("#runBtn")?.addEventListener("click", async () => {
    const urls = $("#urlsInput").value.trim();
    if (!urls) { toast("请粘贴 Ozon 链接", "error"); return; }
    if (state.collectorMode && !(await ensureRunnableCollector("single"))) return;
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
  const isBatchPage = Boolean($("#batchStatus"));
  const statusLabel = isBatchPage ? $("#batchStatus") : $("#singleStatus");
  const logBox = isBatchPage ? $("#batchLogs") : $("#singleLogs");
  const resultCount = isBatchPage ? $("#batchResultCount") : $("#singleResultCount");
  const resultsBody = isBatchPage ? $("#batchResultsBody") : $("#singleResultsBody");
  const downloadLink = isBatchPage ? $("#batchDownload") : $("#singleDownload");
  if (statusLabel) statusLabel.textContent = `${job.status} · ${job.phase || ""} · ${job.processed || 0}/${job.total || 0}`;
  if (logBox && job.logs) {
    logBox.textContent = job.logs.slice(-100).map((l) => `[${(l.level || "info").toUpperCase()}] ${l.message}`).join("\n") || "（暂无日志）";
  }
  if (resultCount) resultCount.textContent = `${job.results?.length || 0} 条`;
  if (resultsBody) {
    const rows = job.results || [];
    if (!rows.length) {
      resultsBody.innerHTML = `<tr><td colspan="4" class="empty">还没有结果</td></tr>`;
      return;
    }
    resultsBody.innerHTML = rows.map((r) => isBatchPage ? renderBatchResultRow(r) : renderSingleResultRow(r)).join("");
  }
  if (downloadLink && job.downloadUrl) {
    downloadLink.href = job.downloadUrl;
    downloadLink.classList.remove("hidden");
  }
}

function renderSingleResultRow(r) {
  const ozon = r.ozon || {};
  const cands = (r.candidates || []).slice(0, 3);
  const image = ozon.mainImage?.publicUrl || ozon.mainImageUrl || "";
  return `<tr>
    <td class="wrap"><a href="${escapeAttr(r.url)}" target="_blank" rel="noreferrer">${escapeHtml(ozon.title || r.url)}</a><div class="muted">${escapeHtml(ozon.currentBlackPriceCny || ozon.finalBlackPriceCny || "")}</div></td>
    <td>${image ? `<img class="thumb" src="${escapeAttr(image)}">` : ""}</td>
    <td class="wrap">${cands.length ? cands.map((c) => `<div>${escapeHtml(c.rank)}. ${escapeHtml(c.title || "")}<div class="muted">${escapeHtml(c.price || "")}</div></div>`).join("") : `<span class='muted'>${escapeHtml(r.searchError || "无候选")}</span>`}</td>
    <td>${escapeHtml(r.aiReview?.decision || r.error || "已采集")}</td>
  </tr>`;
}

function renderBatchResultRow(r) {
  const ozon = r.ozon || {};
  const image = ozon.mainImage?.publicUrl || ozon.mainImageUrl || "";
  const filterText = r.passedFilters ? "通过" : "未通过";
  return `<tr>
    <td class="wrap"><a href="${escapeAttr(r.url)}" target="_blank" rel="noreferrer">${escapeHtml(ozon.title || r.url)}</a><div class="muted">${escapeHtml(ozon.finalBlackPriceCny || ozon.currentBlackPriceCny || "")}</div></td>
    <td>${image ? `<img class="thumb" src="${escapeAttr(image)}">` : ""}</td>
    <td class="wrap">${escapeHtml(filterText)}${r.filterReasons?.length ? `<div class="muted">${escapeHtml(r.filterReasons.join("；"))}</div>` : ""}</td>
    <td>${escapeHtml(r.error || "已采集")}</td>
  </tr>`;
}

async function loadWorkerStatus(scope = "single") {
  const metaEl = scope === "single" ? $("#singleCollectorMeta") : $("#collectorMeta");
  const boxEl = scope === "single" ? $("#singleCollectorBox") : $("#collectorStatusBox");
  if (!boxEl) return;
  try {
    const data = await getJson("/api/worker/status");
    const workers = data.workers || [];
    const onlineWorkers = workers.filter((worker) => worker.online);
    const runnableWorkers = onlineWorkers.filter((worker) => worker.canClaimJobs);
    const queue = data.queue || {};
    state.workerCanClaim = runnableWorkers.length > 0;
    state.workerStatusLoadedAt = Date.now();
    if (metaEl) {
      metaEl.textContent = `${runnableWorkers.length} 可执行 · ${onlineWorkers.length}/${workers.length} 在线 · 排队 ${queue.queued || 0} · 执行 ${queue.active || 0}`;
    }
    if (!workers.length) {
      boxEl.innerHTML = `
        <div class="empty" style="text-align:left">
          当前账号还没有检测到可用采集端。请在需要采集的电脑上启动本机采集端，保持登录后再开始单品找货或批量采集。
        </div>`;
      return;
    }
    boxEl.innerHTML = workers.map((worker) => {
      const platformLabel = formatWorkerPlatform(worker.platform);
      const statusClass = worker.online ? "green" : "gray";
      const statusText = worker.online ? "在线" : `离线 ${worker.ageSeconds ?? "?"} 秒`;
      const runnableBadge = worker.online && worker.canClaimJobs
        ? `<span class="badge green">可领取任务</span>`
        : `<span class="badge amber">不可领取</span>`;
      return `
        <div style="border:1px solid #e0e5dc;border-radius:6px;padding:10px;margin:8px 0;background:#fff">
          <div style="display:flex;gap:8px;align-items:center;justify-content:space-between">
            <strong>${escapeHtml(worker.workerName || "本机采集端")}</strong>
            <span style="display:flex;gap:6px">${runnableBadge}<span class="badge ${statusClass}">${escapeHtml(statusText)}</span></span>
          </div>
          <div class="muted" style="margin-top:4px;font-size:12px">
            ${escapeHtml(platformLabel)} · ${escapeHtml(worker.hostname || "未知电脑")}
            ${worker.currentPhase ? ` · ${escapeHtml(worker.currentPhase)}` : ""}
          </div>
          ${worker.profileDir ? `<div class="muted" style="margin-top:4px;font-size:11px">浏览器配置：${escapeHtml(worker.profileDir)}</div>` : ""}
          <div class="muted" style="margin-top:4px;font-size:11px">最后心跳：${escapeHtml(formatTime(worker.lastSeenAt) || "—")}</div>
        </div>`;
    }).join("");
  } catch (error) {
    state.workerCanClaim = false;
    if (metaEl) metaEl.textContent = "检测失败";
    boxEl.innerHTML = `<div class="empty" style="text-align:left">采集端状态读取失败：${escapeHtml(error.message)}</div>`;
  }
}

async function ensureRunnableCollector(scope = "single") {
  await loadWorkerStatus(scope);
  if (state.workerCanClaim) return true;
  const message = "当前没有可领取任务的本机采集端在线。请先启动本机采集端，否则任务只会排队不会执行。";
  toast(message, "error");
  const logEl = scope === "single" ? $("#singleLogs") : $("#batchLogs");
  if (logEl) logEl.textContent = message;
  return false;
}

function formatWorkerPlatform(platform = "") {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  return platform || "未知系统";
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
      <div class="card-head"><h2>采集端状态</h2><span class="meta" id="collectorMeta">检测中...</span></div>
      <div id="collectorStatusBox" class="muted">正在检测当前账号的本机采集端...</div>
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
  loadWorkerStatus("batch").catch(() => {});
}

function bindBatchHandlers() {
  $("#batchRunBtn")?.addEventListener("click", async () => {
    const url = $("#batchSourceInput").value.trim();
    if (!url) { toast("请粘贴 Ozon 店铺/商品链接", "error"); return; }
    if (state.collectorMode && !(await ensureRunnableCollector("batch"))) return;
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
        <thead><tr><th style="min-width:160px">商品</th><th style="min-width:140px">offer_id</th><th>价格</th><th>状态</th></tr></thead>
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
  const meta = $("#plMeta");
  const body = $("#plBody");
  if (meta) meta.textContent = "加载中…";
  if (body) body.innerHTML = `<tr><td colspan="4" class="empty"><span class="spinner"></span> 加载中…</td></tr>`;
  try {
    const fetchItems = async (archived) => {
      const data = await postJson("/api/seller/products", { limit, archived });
      return data.data?.result?.items || data.data?.items || [];
    };
    let items = [];
    if (tab === "all") {
      const [activeItems, archivedItems] = await Promise.all([fetchItems(false), fetchItems(true)]);
      items = [...activeItems.filter((it) => !it.archived), ...archivedItems.map((it) => ({ ...it, archived: true }))];
      $("#plActiveCount").textContent = String(activeItems.length);
      $("#plArchivedCount").textContent = String(archivedItems.length);
      $("#plAllCount").textContent = String(items.length);
    } else {
      items = await fetchItems(tab === "archived");
      if (tab === "active") items = items.filter((it) => !it.archived);
      if (tab === "archived") items = items.map((it) => ({ ...it, archived: true }));
      const activeCount = tab === "active" ? items.length : $("#plActiveCount").textContent;
      const archivedCount = tab === "archived" ? items.length : $("#plArchivedCount").textContent;
      $("#plActiveCount").textContent = activeCount;
      $("#plArchivedCount").textContent = archivedCount;
      $("#plAllCount").textContent = Number.isFinite(Number(activeCount)) && Number.isFinite(Number(archivedCount))
        ? String(Number(activeCount) + Number(archivedCount))
        : "—";
    }
    if (search) items = items.filter((it) => (it.name || "").toLowerCase().includes(search) || (it.offer_id || "").toLowerCase().includes(search));
    if (meta) meta.textContent = `共 ${items.length} 个`;
    if (!items.length) { body.innerHTML = `<tr><td colspan="4" class="empty">无数据</td></tr>`; return; }
    body.innerHTML = items.map((it) => `
      <tr>
        <td class="wrap">${escapeHtml(it.name || it.offer_id || "—")}</td>
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
  // 如果有从 AI 套图传来的图片，自动填到图片 URL 框
  setTimeout(() => {
    if (state._pendingUploadImage) {
      const imgs = $("#sellerImagesInput");
      if (imgs) imgs.value = state._pendingUploadImage;
      state._pendingUploadImage = null;
      toast("已自动填入图片 URL（来自 AI 套图）", "success");
    }
  }, 50);
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
      const productId = data?.data?.result?.product_id || data?.data?.product_id;
      if (productId) {
        $("#sellerResponse").innerHTML += `\n\n→ <a href="https://www.ozon.ru/product/${escapeAttr(productId)}" target="_blank" rel="noreferrer">在 Ozon 查看商品</a>`;
      }
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
      <div class="card-head">
        <h2>同步库存</h2>
        <span class="meta">选商品 → 改库存 → 批量提交到 Ozon</span>
      </div>
      <div class="filter-bar">
        <label class="field" style="margin: 0; flex: 1; min-width: 200px;"><span>仓库</span>
          <select id="stockWarehouseId"><option value="">（加载中…）</option></select>
        </label>
        <label class="field" style="margin: 0; flex: 1; min-width: 200px;"><span>搜索 SKU / 名称</span>
          <input type="search" id="stockSearch" placeholder="过滤商品" />
        </label>
        <button class="button" id="stockRefresh">刷新</button>
        <button class="button" id="stockSelectAll">全选</button>
        <button class="button" id="stockSelectNone">全不选</button>
      </div>
      <div class="table-wrap" style="max-height: 420px"><table>
        <thead><tr>
          <th style="width:30px"><input type="checkbox" id="stockAll" /></th>
          <th style="min-width:160px">商品</th>
          <th style="min-width:140px">offer_id / SKU</th>
          <th style="width:120px">新库存 (stock)</th>
        </tr></thead>
        <tbody id="stockBody"><tr><td colspan="4" class="empty">加载中…</td></tr></tbody>
      </table></div>
      <div class="filter-bar" style="justify-content: space-between; margin-top: 10px">
        <span class="muted" id="stockSelectedMeta">已选 0 / 0</span>
        <div style="display:flex; gap:8px">
          <button class="button primary" id="stockSubmit">⚡ 提交到 Ozon</button>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Ozon 返回</h2></div>
      <pre id="stockResponse" class="response-area">提交后这里会显示 Ozon 的返回。</pre>
    </div>`;
  bindStockHandlers();
  loadStockProducts();
}

function bindStockHandlers() {
  $("#stockRefresh")?.addEventListener("click", () => loadStockProducts());
  $("#stockSearch")?.addEventListener("input", () => filterStockRows());
  $("#stockSelectAll")?.addEventListener("click", () => { $$("#stockBody input[type=checkbox]").forEach((c) => c.checked = true); updateStockSelectedMeta(); });
  $("#stockSelectNone")?.addEventListener("click", () => { $$("#stockBody input[type=checkbox]").forEach((c) => c.checked = false); updateStockSelectedMeta(); });
  $("#stockAll")?.addEventListener("change", (e) => { $$("#stockBody input[type=checkbox]").forEach((c) => c.checked = e.target.checked); updateStockSelectedMeta(); });
  $("#stockSubmit")?.addEventListener("click", submitStock);
  $$("#stockBody").forEach?.(() => {}); // noop
  // 仓库下拉变化时自动提交时携带
}

async function loadStockProducts() {
  const body = $("#stockBody");
  if (body) body.innerHTML = `<tr><td colspan="4" class="empty"><span class="spinner"></span> 加载商品…</td></tr>`;
  try {
    const data = await postJson("/api/seller/products", { limit: 100 });
    const items = (data.data?.result?.items || []).filter((it) => !it.archived);
    // 暂存到全局
    state._stockItems = items;
    // 拉仓库
    const whData = await getJson("/api/seller/warehouses").catch(() => ({ data: { result: [] } }));
    const whItems = whData.data?.result || [];
    const whSel = $("#stockWarehouseId");
    if (whSel) {
      whSel.innerHTML = whItems.length
        ? whItems.map((w) => `<option value="${escapeAttr(w.warehouse_id)}">${escapeHtml(w.name)} (#${escapeHtml(String(w.warehouse_id))})</option>`).join("")
        : `<option value="">(未获取到 warehouse，请在 Ozon 后台确认)</option>`;
    }
    renderStockRows(items, whItems);
  } catch (e) {
    if (body) body.innerHTML = `<tr><td colspan="4" class="empty">加载失败：${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderStockRows(items, whItems) {
  const body = $("#stockBody");
  if (!body) return;
  if (!items.length) { body.innerHTML = `<tr><td colspan="4" class="empty">店铺里还没有商品</td></tr>`; return; }
  body.innerHTML = items.map((it, i) => `
    <tr data-offer-id="${escapeAttr(it.offer_id || '')}" data-product-id="${escapeAttr(it.product_id || '')}" data-name="${escapeAttr(it.name || '')}">
      <td><input type="checkbox" data-row="${i}" /></td>
      <td class="wrap">${escapeHtml(it.name || it.offer_id || "—")}</td>
      <td><span class="muted">${escapeHtml(it.offer_id || "—")}</span></td>
      <td><input type="number" min="0" value="0" data-field="stock" data-row="${i}" style="width: 90px" /></td>
    </tr>`).join("");
  // 复选框变化
  $$("#stockBody input[type=checkbox]").forEach((c) => c.addEventListener("change", updateStockSelectedMeta));
  $$("#stockBody input[type=number]").forEach((i) => i.addEventListener("input", updateStockSelectedMeta));
  updateStockSelectedMeta();
}

function filterStockRows() {
  const q = ($("#stockSearch")?.value || "").toLowerCase().trim();
  $$("#stockBody tr").forEach((tr) => {
    const sku = (tr.getAttribute("data-offer-id") || "").toLowerCase();
    const name = (tr.getAttribute("data-name") || "").toLowerCase();
    tr.style.display = (q && !sku.includes(q) && !name.includes(q)) ? "none" : "";
  });
  updateStockSelectedMeta();
}

function updateStockSelectedMeta() {
  const all = $$("#stockBody input[type=checkbox]");
  const checked = all.filter((c) => c.checked);
  const meta = $("#stockSelectedMeta");
  if (meta) meta.textContent = `已选 ${checked.length} / ${all.length}（改过库存的行会高亮）`;
  // 给改过值的行加个视觉提示
  $$("#stockBody tr").forEach((tr) => {
    const stock = tr.querySelector("input[data-field=stock]");
    const dirty = stock && Number(stock.value) > 0;
    tr.style.background = dirty ? "#fff8e1" : "";
  });
}

async function submitStock() {
  const wh = Number($("#stockWarehouseId")?.value);
  if (!wh) { toast("请先选择仓库", "error"); return; }
  const rows = $$("#stockBody tr");
  const stocks = [];
  for (const tr of rows) {
    const cb = tr.querySelector("input[type=checkbox]");
    if (!cb || !cb.checked) continue;
    const offerId = tr.getAttribute("data-offer-id") || "";
    const productId = Number(tr.getAttribute("data-product-id") || 0);
    if (!offerId && !productId) continue;
    const stock = Number(tr.querySelector("input[data-field=stock]")?.value || 0);
    stocks.push({ offer_id: offerId, product_id: productId || undefined, warehouse_id: wh, stock });
  }
  if (!stocks.length) { toast("请至少勾选一行", "error"); return; }
  if (!confirm(`即将提交 ${stocks.length} 条库存更新到 Ozon，确认？`)) return;
  const out = $("#stockResponse");
  out.textContent = "正在提交…";
  try {
    const data = await postJson("/api/seller/products/stocks", { stocks });
    out.textContent = JSON.stringify(data, null, 2);
    toast(`已提交 ${stocks.length} 条`, "success");
  } catch (e) {
    out.textContent = e.message;
    toast(e.message, "error");
  }
}

/* ============== AI 商品套图 ==================== */

function renderProductImages(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>AI 商品套图 <span class="badge green">已接入 MiniMax</span></h2>
        <span class="meta" id="imgModelLabel">模型：image-01</span>
        <span class="meta" id="imgStatus">就绪</span>
      </div>
      <p class="muted">上传商品原图 → MiniMax 图生图（i2i）生成 N 张不同场景的套图。也支持纯文字 → 图片（T2I）。</p>
    </div>
    <div class="two-col">
      <div class="card">
        <div class="card-head"><h2>商品原图</h2><span class="meta">支持 URL 或本地 → 上传后转 dataURL</span></div>
        <label class="field"><span>原图 URL（可留空，走纯文字生成）</span>
          <input id="imgRefUrl" type="text" placeholder="https://cdn.example.com/your-product.jpg" />
        </label>
        <div class="row" style="grid-template-columns: auto 1fr; gap: 8px; align-items: center">
          <input type="file" id="imgFile" accept="image/*" />
          <span class="muted" id="imgFileName">未选择</span>
        </div>
        <div id="imgPreview" class="upload-area">点击上方选文件，或拖入 / 粘贴图片</div>
      </div>
      <div class="card">
        <div class="card-head">
        <h2>套图预览</h2>
        <span class="meta" id="imgUsageMeta">未生成</span>
      </div>
        <div style="display:grid; grid-template-columns: 1fr 180px; gap: 12px">
          <div id="imgResult" class="image-grid"><div class="empty">生成结果会显示在这里。</div></div>
          <div>
            <div class="muted" style="font-size:11.5px; margin-bottom: 4px">已选中：</div>
            <div id="imgSelected" class="upload-area" style="min-height: 140px; padding: 8px; justify-content:flex-start"><span class="muted">未选中</span></div>
            <button class="button small" id="imgFillUpload" style="margin-top: 6px; width: 100%">填到上架页图片</button>
          </div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>生成设置</h2></div>
      <div class="row" style="grid-template-columns: 1fr 1fr 1fr 1fr; gap: 8px">
        <label class="field"><span>模型</span>
          <select id="imgModel">
            <option value="image-01">image-01（标准）</option>
            <option value="image-01-live">image-01-live（更快）</option>
          </select>
        </label>
        <label class="field"><span>比例</span>
          <select id="imgRatio">
            <option value="3:4" selected>3:4（OZON 主图）</option>
            <option value="1:1">1:1（方形）</option>
            <option value="4:3">4:3（横版）</option>
            <option value="16:9">16:9（宽屏）</option>
          </select>
        </label>
        <label class="field"><span>张数</span>
          <input id="imgN" type="number" min="1" max="8" value="4" />
        </label>
        <label class="field"><span>场景</span>
          <select id="imgScenePreset">
            <option value="custom">自定义</option>
            <option value="white">白底</option>
            <option value="lifestyle">生活场景</option>
            <option value="model">模特</option>
            <option value="detail">细节</option>
            <option value="bundle">搭配/组合</option>
          </select>
        </label>
      </div>
      <label class="field"><span>场景描述 / Prompt</span>
        <textarea id="imgPrompt" placeholder="例如：transparent phone case on clean white background, soft shadow, product photography, 4k"></textarea>
      </label>
      <div class="filter-bar" style="justify-content: space-between; margin-top: 8px">
        <span class="muted">💡 留空原图 = 纯文字出图；填原图 = 图生图（推荐）</span>
        <button class="button primary" id="imgGenerateBtn">⚡ 一键生成</button>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>原响应</h2></div>
      <pre id="imgResponse" class="response-area">点击「一键生成」后这里会显示 MiniMax 的返回 JSON。</pre>
    </div>`;
  bindImageHandlers();
}

function bindImageHandlers() {
  const fileInput = $("#imgFile");
  const fileName = $("#imgFileName");
  const preview = $("#imgPreview");
  const refUrl = $("#imgRefUrl");
  const promptBox = $("#imgPrompt");
  const sceneSel = $("#imgScenePreset");
  const modelSel = $("#imgModel");
  const modelLabel = $("#imgModelLabel");
  const statusEl = $("#imgStatus");

  // 模型切换更新顶部 label
  modelSel?.addEventListener("change", () => {
    modelLabel.textContent = `模型：${modelSel.value}`;
  });
  modelLabel.textContent = `模型：${modelSel.value}`;

  // 场景预设 → 自动填 prompt
  const scenePrompts = {
    white: "clean white background, soft natural shadow, product photography, e-commerce listing, sharp focus, 4k",
    lifestyle: "in a real lifestyle setting, on a wooden table, warm natural lighting, cozy atmosphere, 4k, photorealistic",
    model: "held by a young woman, casual outfit, soft daylight, lifestyle photography, e-commerce hero shot, 4k",
    detail: "macro close-up, shallow depth of field, fine texture detail, studio lighting, 4k",
    bundle: "with complementary accessories, flat lay composition, clean white surface, 4k, e-commerce bundle shot",
  };
  sceneSel?.addEventListener("change", () => {
    if (sceneSel.value !== "custom") {
      promptBox.value = scenePrompts[sceneSel.value] || "";
    }
  });

  // 文件 → 转 dataURL 预览 + 自动填
  fileInput?.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    fileName.textContent = `${f.name}（${Math.round(f.size / 1024)}KB）`;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      preview.innerHTML = `<img src="${dataUrl}" style="max-width:100%; max-height:200px; object-fit:contain;">`;
      // 暂存 dataURL 到全局
      state._imgDataUrl = dataUrl;
    };
    reader.readAsDataURL(f);
  });

  // 粘贴图片
  preview?.addEventListener("paste", (e) => {
    const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items || [];
    for (const it of items) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result;
            preview.innerHTML = `<img src="${dataUrl}" style="max-width:100%; max-height:200px; object-fit:contain;">`;
            state._imgDataUrl = dataUrl;
          };
          reader.readAsDataURL(f);
        }
      }
    }
  });

  $("#imgFillUpload")?.addEventListener("click", () => {
    if (!state._selectedGeneratedImage) { toast("请先在套图里点「用此图」选一张", "error"); return; }
    const imgs = $("#sellerImagesInput");
    if (imgs) { imgs.value = state._selectedGeneratedImage; }
    navigate("products/upload");
    setTimeout(() => {
      const imgs2 = $("#sellerImagesInput");
      if (imgs2) imgs2.value = state._selectedGeneratedImage;
      toast("已填入图片 URL。点「上架」即可提交。", "success");
    }, 100);
  });

  $("#imgGenerateBtn")?.addEventListener("click", async () => {
    const prompt = promptBox.value.trim();
    if (!prompt) { toast("请填写 prompt（或选场景预设）", "error"); return; }
    const ratio = $("#imgRatio").value;
    const n = Number($("#imgN").value || 4);
    const model = modelSel.value;
    const url = refUrl.value.trim();

    // 优先 URL，否则用 dataURL
    let refImage = null;
    if (url) refImage = [url];
    else if (state._imgDataUrl) refImage = [state._imgDataUrl];

    statusEl.textContent = "生成中…";
    statusEl.className = "meta";
    $("#imgGenerateBtn").disabled = true;
    const out = $("#imgResponse");
    out.textContent = "正在调 MiniMax 图生图…";
    try {
      const data = await postJson("/api/seller/images/generate", {
        prompt, image: refImage, aspectRatio: ratio, n, model,
      });
      const imgs = data.data?.images || [];
      const usage = data.usage || {};
      out.textContent = JSON.stringify(data, null, 2);
      if (imgs.length) {
        $("#imgResult").innerHTML = imgs.map((u, i) => `
          <div class="image-cell" data-idx="${i}">
            <a href="${escapeAttr(u)}" target="_blank" rel="noreferrer"><img src="${escapeAttr(u)}"></a>
            <div class="image-actions">
              <a class="button small" href="${escapeAttr(u)}" download="image-${Date.now()}-${i}.jpg" target="_blank" rel="noreferrer">下载</a>
              <button class="button small" data-use="${i}">用此图</button>
            </div>
          </div>`).join("");
        $$("#imgResult [data-use]").forEach((b) => b.addEventListener("click", () => {
          const idx = Number(b.getAttribute("data-use"));
          const url = imgs[idx];
          state._selectedGeneratedImage = url;
          $("#imgSelected").innerHTML = `<img src="${escapeAttr(url)}" style="max-width:140px; max-height:140px; object-fit:contain; border:1px solid var(--green); border-radius:6px;"><div class="muted" style="margin-top:4px; font-size:11px">已选中 #${idx + 1}</div>`;
          toast("已选中此图。点下方「填到上架页图片」一键带入。", "success");
        }));
        $("#imgUsageMeta").textContent = `${imgs.length} 张 · 模型 ${usage.model} · $${(usage.estimatedCostUsd || 0).toFixed(4)}`;
        statusEl.textContent = `完成 · ${imgs.length} 张`;
        statusEl.className = "meta";
        toast(`生成完成：${imgs.length} 张图`, "success");
      } else {
        $("#imgResult").innerHTML = `<div class="empty">${escapeHtml(out.textContent.slice(0, 200))}</div>`;
        statusEl.textContent = "失败";
        toast("生成失败：详见响应", "error");
      }
    } catch (error) {
      out.textContent = error.message;
      statusEl.textContent = "失败";
      toast(error.message, "error");
    } finally {
      $("#imgGenerateBtn").disabled = false;
    }
  });
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
        <thead><tr><th style="min-width:160px">货件号</th><th>状态</th><th class="wrap" style="min-width:200px">商品</th><th>仓库</th><th>配送</th><th>金额</th><th>时间</th><th></th></tr></thead>
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
  if (body) body.innerHTML = `<tr><td colspan="8" class="empty"><span class="spinner"></span> 加载中…</td></tr>`;
  try {
    const data = await postJson("/api/seller/orders", { limit, status });
    let items = (data.data?.result?.postings || data.data?.items || data.data?.result?.items || []).slice();
    if (search) items = items.filter((it) => (it.order_number || it.posting_number || it.id || "").toLowerCase().includes(search));
    if (countEl) countEl.textContent = String(items.length);
    state._orders = items;
    if (!items.length) { body.innerHTML = `<tr><td colspan="8" class="empty">无订单数据（最近 90 天没有匹配的订单）</td></tr>`; return; }
    body.innerHTML = items.slice(0, limit).map((it, idx) => {
      const products = (it.products || []);
      const productSummary = products.map((p) => `${escapeHtml(p.name || p.sku || "—")} ×${p.quantity || p.qty || 1}`).slice(0, 2).join("；");
      const more = products.length > 2 ? `<span class="muted">（还有 ${products.length - 2} 个）</span>` : "";
      const dm = it.delivery_method || {};
      const dmName = dm.name || "—";
      const wh = it.warehouse || it.warehouse_name || (dm.warehouse_id ? "仓库#" + dm.warehouse_id : "—");
      const price = it.financial_data?.total_price || it.total_price || (it.financial_data?.posting_services?.total_price) || "—";
      return `<tr data-idx="${idx}" class="order-row" style="cursor:pointer">
        <td class="muted" style="min-width:160px">${escapeHtml(it.order_number || it.posting_number || it.id || "—")}</td>
        <td>${statusBadge(it.status)}</td>
        <td class="wrap" style="min-width:200px; max-width:320px">${productSummary} ${more}</td>
        <td>${escapeHtml(wh)}</td>
        <td class="muted" style="font-size:11px">${escapeHtml(dmName)}</td>
        <td>${escapeHtml(String(price))}</td>
        <td class="muted">${escapeHtml(formatTime(it.in_process_at || it.created_at || it.shipment_date))}</td>
        <td><button class="button small" data-detail="${idx}">详情</button></td>
      </tr>`;
    }).join("");
    $$("#orderBody [data-detail]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = Number(btn.getAttribute("data-detail"));
        showOrderDetail(state._orders?.[idx]);
      });
    });
  } catch (error) {
    if (body) body.innerHTML = `<tr><td colspan="8" class="empty">加载失败：${escapeHtml(error.message)}</td></tr>`;
  }
}

function showOrderDetail(posting) {
  if (!posting) return;
  const dm = posting.delivery_method || {};
  const prods = (posting.products || []).map((p) => `<tr><td>${escapeHtml(p.name || p.sku || "—")}</td><td>${escapeHtml(p.sku || p.offer_id || "—")}</td><td>${p.quantity || 1}</td><td>${escapeHtml(p.price || "—")}</td></tr>`).join("");
  const addr = posting.addressee || {};
  const f = posting.financial_data || {};
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>订单 ${escapeHtml(posting.posting_number || "")}</title>
<style>
body { font: 13px -apple-system, sans-serif; padding: 20px; max-width: 720px; margin: 0 auto; }
h1 { font-size: 16px; margin: 0 0 12px; }
.row { display: grid; grid-template-columns: 130px 1fr; gap: 6px 12px; margin-bottom: 8px; }
.k { color: #666; }
table { width: 100%; border-collapse: collapse; margin-top: 10px; }
th, td { padding: 6px 8px; border-bottom: 1px solid #e3e6e1; text-align: left; font-size: 12px; }
th { background: #f6f7f5; }
.section { background: #fff; border: 1px solid #e3e6e1; border-radius: 6px; padding: 12px; margin-bottom: 12px; }
h2 { font-size: 13px; margin: 0 0 8px; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; background: #e6f1eb; color: #245744; }
</style></head><body>
<h1>订单详情 · ${escapeHtml(posting.posting_number || posting.order_number || "")}</h1>
<div class="section">
  <div class="row"><span class="k">状态</span><span>${escapeHtml(posting.status || "—")}</span></div>
  <div class="row"><span class="k">店铺</span><span>${escapeHtml(posting.cluster_name || "—")}</span></div>
  <div class="row"><span class="k">仓库</span><span>${escapeHtml(posting.warehouse || (dm.warehouse_id ? "仓库#" + dm.warehouse_id : "—"))}</span></div>
  <div class="row"><span class="k">配送方式</span><span>${escapeHtml(dm.name || "—")} (tpl_provider: ${escapeHtml(dm.tpl_provider || "—")})</span></div>
  <div class="row"><span class="k">追踪号</span><span class="muted">${escapeHtml(posting.tracking_number || "—")}</span></div>
  <div class="row"><span class="k">进入处理</span><span>${escapeHtml(posting.in_process_at || "—")}</span></div>
  <div class="row"><span class="k">应发货</span><span>${escapeHtml(posting.shipment_date || "—")}</span></div>
  <div class="row"><span class="k">运输中</span><span>${escapeHtml(posting.delivering_date || "—")}</span></div>
</div>
<div class="section">
  <h2>商品</h2>
  <table><thead><tr><th>名称</th><th>SKU / offer_id</th><th>数量</th><th>价格</th></tr></thead><tbody>${prods || '<tr><td colspan="4" class="muted">无</td></tr>'}</tbody></table>
</div>
${addr.name ? `<div class="section"><h2>收件人</h2>
  <div class="row"><span class="k">姓名</span><span>${escapeHtml(addr.name || "")}</span></div>
  <div class="row"><span class="k">电话</span><span>${escapeHtml(addr.phone || "")}</span></div>
  <div class="row"><span class="k">地址</span><span>${escapeHtml(addr.address || "")}</span></div>
</div>` : ''}
${Object.keys(f).length ? `<div class="section"><h2>财务</h2>
  <div class="row"><span class="k">总价</span><span>${escapeHtml(f.total_price || "—")}</span></div>
  <div class="row"><span class="k">佣金</span><span>${escapeHtml(f.commission_amount || "—")}</span></div>
  <div class="row"><span class="k">服务费</span><span>${escapeHtml(f.services_amount || "—")}</span></div>
  <div class="row"><span class="k">物流</span><span>${escapeHtml(f.delivery_price || "—")}</span></div>
</div>` : ''}
</body></html>`;
  const w = window.open("", "_blank", "width=720,height=800");
  if (w) { w.document.write(html); w.document.close(); }
  else { toast("浏览器拦截了弹窗", "error"); }
}

/* ============== 工具页 ==================== */

function renderToolsBrowser(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>1688 浏览器</h2><span class="meta" id="browserStatus">未知</span></div>
      <p class="muted">服务器队列模式下，浏览器由当前登录账号对应电脑上的「浏览器采集插件」管理。下面两个按钮仅在单机模式下生效。</p>
      <div style="display:flex;gap:8px">
        <button class="button" id="open1688Btn">打开 1688 登录窗口</button>
        <button class="button quiet" id="closeBrowserBtn">关闭浏览器</button>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>浏览器采集插件</h2><span class="meta" id="collectorMeta">检测中...</span></div>
      <div id="collectorStatusBox" class="muted">正在检测当前账号的浏览器采集插件...</div>
      <p class="muted">正式客户安装 Chrome/Edge 插件后登录账号。插件在线后，本页面会显示电脑名、系统和任务状态；自动领取采集任务会在插件采集逻辑迁移完成后开启。</p>
      <p class="muted">测试安装：下载 zip 后先解压，不要直接拖 zip 到 Chrome。打开 <code>chrome://extensions/</code>，开启开发者模式，点击“加载已解压的扩展程序”，选择解压后包含 <code>manifest.json</code> 的文件夹。</p>
      <div style="display:flex;gap:8px;margin-top:8px">
        <a class="button" href="/downloads/ozon-1688-collector-extension.zip" download>下载插件测试包（先解压）</a>
      </div>
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
        <thead><tr><th style="min-width:140px">任务</th><th>进度</th><th>时间</th><th>下载</th></tr></thead>
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
        <td class="wrap"><div>${escapeHtml(it.kind === "batch-ozon" ? "批量采集" : "单品找货")}</div><span class="muted">${escapeHtml((it.id || "").slice(0, 8))}</span></td>
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
    if (items[0]?.id) loadLog(items[0].id);
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
    if (!route) return;
    // 顶级栏目且有子项 → 自动展开 + 跳到第一个子项
    if (el.classList.contains("nav-item")) {
      const firstSub = document.querySelector(`.nav-subitem[data-parent="${route}"]`);
      if (firstSub) {
        navigate(firstSub.getAttribute("data-route"));
        return;
      }
    }
    navigate(route);
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
