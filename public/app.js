/* =========================================================
   逐梦 ERP - app shell + pages
   - 风格自定，参考 MYerp 的功能分类
   ========================================================= */

const ROUTES = {
  "dashboard":           { title: "仪表盘",   crumb: "总览", render: renderDashboard },
  "sourcing":            { title: "选品",     crumb: "选品", render: renderSourcingLanding },
  "sourcing/category":   { title: "类目分析", crumb: "选品 / 类目分析", render: renderCategoryAnalysis },
  "sourcing/bestsellers":{ title: "榜单选品", crumb: "选品 / 榜单选品", render: renderBestsellers },
  "selection":           { title: "选品",     crumb: "选品", render: renderSourcingLanding },
  "selection/category-analysis": { title: "类目分析", crumb: "选品 / 类目分析", render: renderCategoryAnalysis },
  "selection/top-list":  { title: "榜单选品", crumb: "选品 / 榜单选品", render: renderBestsellers },
  "selection/china-zone":{ title: "中国专区", crumb: "选品 / 中国专区", render: renderChinaZone },
  "sourcing/single":     { title: "单品找货", crumb: "选品 / 单品找货", render: renderSingleSourcing },
  "sourcing/batch":      { title: "批量采集", crumb: "选品 / 批量采集", render: renderBatchSourcing },
  "products":            { title: "商品",     crumb: "商品", render: renderProductsLanding },
  "products/list":       { title: "商品列表", crumb: "商品 / 商品列表", render: renderProductList },
  "products/collect":    { title: "采集箱",   crumb: "商品 / 采集箱",   render: renderCollectBox },
  "products/upload":     { title: "上架",     crumb: "商品 / 上架",     render: renderProductUpload },
  "products/stock":      { title: "同步库存", crumb: "商品 / 同步库存", render: renderProductStock },
  "products/inventory":  { title: "库存管理", crumb: "商品 / 库存管理", render: renderProductStock },
  "products/images":     { title: "AI 商品套图",crumb: "商品 / AI 商品套图", render: renderProductImages },
  "products/history":    { title: "上架记录",  crumb: "商品 / 上架记录",  render: renderListingHistory },
  "products/listing-history": { title: "上架记录", crumb: "商品 / 上架记录", render: renderListingHistory },
  "products/relist":     { title: "下架重上", crumb: "商品 / 下架重上", render: renderProductRelist },
  "ai-tools":            { title: "AI 工具", crumb: "AI 工具", render: renderAiToolsLanding },
  "ai-tools/product-image-set": { title: "AI 商品套图", crumb: "AI 工具 / 商品套图", render: renderProductImages },
  "ai-tools/image-editor": { title: "AI 改图神器", crumb: "AI 工具 / 改图神器", render: renderImageEditor },
  "ai-tools/prompt-generator": { title: "AI 提示词生成", crumb: "AI 工具 / 提示词生成", render: renderPromptGenerator },
  "orders":              { title: "订单",     crumb: "订单", render: renderOrdersLanding },
  "orders/list":         { title: "订单列表", crumb: "订单 / 订单列表", render: renderOrderList },
  "tools":               { title: "工具",     crumb: "工具", render: renderToolsLanding },
  "tools/browser":       { title: "1688 浏览器",crumb: "工具 / 1688 浏览器", render: renderToolsBrowser },
  "tools/history":       { title: "历史与下载",crumb: "工具 / 历史", render: renderToolsHistory },
  "tools/logs":          { title: "运行日志", crumb: "工具 / 日志", render: renderToolsLogs },
};

// 汇率（启动时从 /api/version 拉取，默认 0.0862）
let RUB_CNY_RATE = 0.0862;
let priceMode = "cny"; // 默认显示人民币
function setRubCnyRate(rate) { RUB_CNY_RATE = Number(rate) || 0.0862; }
function rubToCny(rub) {
  const v = Number(rub);
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.round(v * RUB_CNY_RATE * 100) / 100;
}
function formatPrice(rub, forceRub = false) {
  if (forceRub || priceMode === "rub") {
    const v = Number(rub);
    return Number.isFinite(v) ? `${Math.round(v).toLocaleString()} ₽` : "—";
  }
  const cny = rubToCny(rub);
  if (cny != null) return `¥${cny.toFixed(2)}`;
  const v = Number(rub);
  return Number.isFinite(v) ? `${Math.round(v).toLocaleString()} ₽` : "—";
}
function formatPriceBrief(rub) {
  const cny = rubToCny(rub);
  if (cny != null) return `¥${cny.toFixed(2)}`;
  return "—";
}
function cnyToRub(cny) {
  const v = Number(cny);
  if (!Number.isFinite(v) || v <= 0 || !RUB_CNY_RATE) return null;
  return Math.round((v / RUB_CNY_RATE) * 100) / 100;
}

// 启动时拉汇率
(async () => {
  try {
    const v = await getJson("/api/version");
    if (v.rubCnyRate) { RUB_CNY_RATE = v.rubCnyRate; console.log("汇率:", RUB_CNY_RATE); }
  } catch {}
})();

const state = {
  user: null,
  currentJobId: null,
  pollTimer: null,
  stores: [],
  currentStoreId: "",
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
const elStoreSwitcher = $("#storeSwitcher");
const elStoreManageBtn = $("#storeManageBtn");
// 侧栏"商品/订单"角标已移除（多店铺场景下无意义，会误导）

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
  const map = { running:["green","运行中"], paused:["amber","已暂停"], done:["green","完成"], claimed:["blue","已领取"], queued:["gray","排队中"], error:["red","失败"], canceled:["gray","已停止"] };
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
async function patchJson(url, payload) {
  const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (res.status === 401) { location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`; throw new Error("请先登录"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.error || `请求失败：${res.status}`);
  return data;
}
async function deleteJson(url) {
  const res = await fetch(url, { method: "DELETE" });
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

  console.log("[applyRoute] route:", route, "nav items:", document.querySelectorAll(".nav-item, .nav-subitem").length);
  $$(".nav-item, .nav-subitem").forEach((el) => { try { el.classList.remove("active"); } catch(e) { console.error("[applyRoute] remove active failed:", e); } });
  $$(".nav-item").forEach((el) => { try { el.classList.remove("expanded"); } catch {} });
  const routeTop = route.split("/")[0];
  const top = routeTop === "selection" ? "sourcing" : routeTop;
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
}

function navigate(route) {
  if (location.hash !== `#/${route}`) location.hash = `#/${route}`;
  else applyRoute();
}
window.addEventListener("hashchange", applyRoute);

async function loadStores() {
  if (!elStoreSwitcher) return;
  try {
    const data = await getJson("/api/stores");
    state.stores = Array.isArray(data.items) ? data.items : [];
    const saved = localStorage.getItem("currentStoreId") || "";
    const current = state.stores.find((item) => item.id === saved) ? saved : (data.currentStoreId || state.stores[0]?.id || "");
    state.currentStoreId = current;
    elStoreSwitcher.innerHTML = state.stores.length
      ? state.stores.map((item) => `<option value="${escapeAttr(item.id)}">${escapeHtml(item.name || item.sellerClientId || item.id)}</option>`).join("")
      : `<option value="">默认店铺</option>`;
    elStoreSwitcher.value = current || "";
    const active = state.stores.find((item) => item.id === current);
    elSidebarStore.textContent = active?.name || (state.stores.length ? "店铺未选择" : "默认店铺");
  } catch (error) {
    elStoreSwitcher.innerHTML = `<option value="">店铺加载失败</option>`;
    elSidebarStore.textContent = "店铺加载失败";
    console.warn("load stores failed:", error);
  }
}

elStoreSwitcher?.addEventListener("change", async () => {
  const nextStoreId = elStoreSwitcher.value;
  state.currentStoreId = nextStoreId;
  localStorage.setItem("currentStoreId", nextStoreId);
  const active = state.stores.find((item) => item.id === nextStoreId);
  elSidebarStore.textContent = active?.name || "当前店铺";
  try {
    await patchJson("/api/user/default-store", { store_id: nextStoreId });
  } catch (error) {
    toast(error.message, "error");
  }
  applyRoute();
});

elStoreManageBtn?.addEventListener("click", openStoreManager);

function openStoreManager() {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal-panel">
      <div class="modal-head">
        <h2>店铺管理</h2>
        <span class="muted">当前账号下的数据按店铺隔离</span>
        <button class="button small quiet" data-store-close style="margin-left:auto">关闭</button>
      </div>
      <div class="modal-body">
        <div class="row">
          <label class="field"><span>店铺名称</span><input id="storeNameInput" placeholder="例如 Ozon 主店" /></label>
          <label class="field"><span>Seller Client ID <small>可选</small></span><input id="storeClientInput" placeholder="Ozon Client-Id" /></label>
        </div>
        <div style="display:flex;gap:8px;margin:10px 0 14px">
          <button class="button primary" data-store-add>新增店铺</button>
          <button class="button" data-store-refresh>刷新</button>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>店铺</th><th>Client ID</th><th>默认</th><th>操作</th></tr></thead>
          <tbody id="storeManagerBody">${renderStoreManagerRows()}</tbody>
        </table></div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener("click", async (event) => {
    if (event.target === modal || event.target.closest("[data-store-close]")) {
      modal.remove();
      return;
    }
    const add = event.target.closest("[data-store-add]");
    const refresh = event.target.closest("[data-store-refresh]");
    const edit = event.target.closest("[data-store-edit]");
    const setDefault = event.target.closest("[data-store-default]");
    const remove = event.target.closest("[data-store-delete]");
    try {
      if (add) {
        const name = $("#storeNameInput")?.value || "";
        const sellerClientId = $("#storeClientInput")?.value || "";
        await postJson("/api/stores", { name, sellerClientId });
        $("#storeNameInput").value = "";
        $("#storeClientInput").value = "";
        await loadStores();
      } else if (refresh) {
        await loadStores();
      } else if (edit) {
        const store = state.stores.find((item) => item.id === edit.dataset.storeEdit);
        if (!store) return;
        const name = prompt("店铺名称", store.name || "");
        if (name === null) return;
        const sellerClientId = prompt("Seller Client ID（可选）", store.sellerClientId || "");
        if (sellerClientId === null) return;
        await patchJson(`/api/stores/${encodeURIComponent(store.id)}`, { name, sellerClientId });
        await loadStores();
      } else if (setDefault) {
        await patchJson("/api/user/default-store", { store_id: setDefault.dataset.storeDefault });
        localStorage.setItem("currentStoreId", setDefault.dataset.storeDefault);
        await loadStores();
        applyRoute();
      } else if (remove) {
        const store = state.stores.find((item) => item.id === remove.dataset.storeDelete);
        if (!store || !confirm(`停用店铺「${store.name}」？历史数据仍保留。`)) return;
        await deleteJson(`/api/stores/${encodeURIComponent(store.id)}`);
        localStorage.removeItem("currentStoreId");
        await loadStores();
        applyRoute();
      }
      const body = modal.querySelector("#storeManagerBody");
      if (body) body.innerHTML = renderStoreManagerRows();
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

function renderStoreManagerRows() {
  if (!state.stores.length) return `<tr><td colspan="4" class="empty">暂无店铺</td></tr>`;
  return state.stores.map((store) => `
    <tr>
      <td><strong>${escapeHtml(store.name || store.id)}</strong><div class="muted">${escapeHtml(store.id || "")}</div></td>
      <td>${escapeHtml(store.sellerClientId || "—")}</td>
      <td>${store.isDefault || store.id === state.currentStoreId ? '<span class="badge green">当前</span>' : '<span class="badge gray">否</span>'}</td>
      <td>
        <button class="button small" data-store-edit="${escapeAttr(store.id)}">编辑</button>
        <button class="button small" data-store-default="${escapeAttr(store.id)}">设默认</button>
        <button class="button small danger" data-store-delete="${escapeAttr(store.id)}">停用</button>
      </td>
    </tr>`).join("");
}

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
      <a class="stat-card accent" href="#/products/list" style="cursor:pointer">
        <div class="label">商品列表</div>
        <div class="value">→</div>
        <div class="delta">7 状态 Tab · 图/价/库存 <span class="badge green" style="margin-left:6px">NEW</span></div>
      </a>
      <a class="stat-card" href="#/products/collect" style="cursor:pointer">
        <div class="label">📦 采集箱</div>
        <div class="value">→</div>
        <div class="delta">粘 Ozon 链接/SKU 批量入箱 <span class="badge green" style="margin-left:6px">NEW</span></div>
      </a>
      <a class="stat-card" href="#/products/upload" style="cursor:pointer">
        <div class="label">上架</div>
        <div class="value">→</div>
        <div class="delta">新建/更新商品</div>
      </a>
      <a class="stat-card" href="#/products/stock" style="cursor:pointer">
        <div class="label">同步库存</div>
        <div class="value">→</div>
        <div class="delta">批量改库存</div>
      </a>
      <a class="stat-card" href="#/products/images" style="cursor:pointer">
        <div class="label">🎨 AI 商品套图</div>
        <div class="value">→</div>
        <div class="delta">万相 2.7 · 图像编辑 · 保真 <span class="badge green" style="margin-left:6px">NEW</span></div>
      </a>
    </div>
    <div class="card"><p class="muted">所有操作直接对接你 Ozon 店铺的 Seller API。<b>采集箱</b> = 粘 Ozon 链接批量暂存 → 一键送入上架；<b>AI 商品套图</b> = 万相 2.7 图像编辑，保持商品不变换场景，¥0.20/张。</p></div>`;
}

function renderOrdersLanding(root) {
  root.innerHTML = `
    <div class="stats-grid">
      <a class="stat-card accent" href="#/orders/list" style="cursor:pointer">
        <div class="label">订单列表</div>
        <div class="value">→</div>
        <div class="delta">状态 Tab · 本地备注 · CSV 导出 <span class="badge green" style="margin-left:6px">NEW</span></div>
      </a>
    </div>
    <div class="card"><p class="muted">从 Ozon Seller API 拉取订单。<b>新增</b>：每行可直接写本地备注（回车自动保存）、点击右上「订单导出」下载真实 CSV（带 UTF-8 BOM，Excel 直接打开）。</p></div>`;
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
      <div class="stat-card accent"><div class="label">在售商品<span class="muted" style="font-size:10.5px; margin-left:4px">· 当前店铺</span></div><div class="value">…</div><div class="delta">来自 Ozon Seller API</div></div>
      <div class="stat-card accent"><div class="label">订单<span class="muted" style="font-size:10.5px; margin-left:4px">· 当前店铺</span></div><div class="value">…</div><div class="delta">近 30 天</div></div>
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
  const categoryTabs = ["全部", "家用电器", "电子产品", "住宅和花园", "美容和卫生", "运动与休闲", "日化", "家具", "更多"];
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>榜单选品</h2>
        <span class="meta" id="bsUpdated">Ozon 全平台榜单 · 数据源可切换</span>
      </div>
      <div class="mode-tabs" id="bsTypeTabs">
        <button class="mode-tab active" data-tab="hot">热销商品</button>
        <button class="mode-tab" data-tab="new">热销新品</button>
        <button class="mode-tab" data-tab="potential">潜力商品</button>
        <button class="mode-tab" data-tab="blue">蓝海商品</button>
      </div>
      <div class="filter-bar" style="justify-content:space-between">
        <div class="chip-group" id="bsPeriod">
          <button class="chip active" data-v="7">7天</button>
          <button class="chip" data-v="28">28天</button>
        </div>
        <div class="chip-group" id="bsCurrency">
          <button class="chip active" data-v="rub">₽</button>
          <button class="chip" data-v="cny">¥</button>
        </div>
        <select id="bsRegion" style="width:160px"><option value="">全部分区</option><option>莫斯科</option><option>圣彼得堡</option></select>
      </div>
      <div class="empty" style="text-align:left;padding:10px 12px;margin:8px 0 0">销量与销售额双高的爆款，适合切入趋势品类。点击「一键跟卖」会写入采集箱，后续由采集端补齐详情。</div>
      <div class="filter-bar" style="margin-top: 10px">
        <span class="muted">选品策略：</span>
        <div class="chip-group" id="bsStrategy">
          <button class="chip" data-v="growth">高增长</button>
          <button class="chip" data-v="low-price">低价高销</button>
          <button class="chip" data-v="cart">高加购</button>
          <button class="chip" data-v="blue">蓝海量级</button>
        </div>
      </div>
      <div class="mode-tabs" id="bsCategoryTabs" style="margin-top:8px">
        ${categoryTabs.map((name, i) => `<button class="mode-tab${i === 0 ? " active" : ""}" data-v="${escapeAttr(name)}">${escapeHtml(name)}</button>`).join("")}
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
        <span><strong id="bsTotal">共 — 件商品</strong></span>
        <span class="meta" id="bsSelected">已选 0</span>
        <button class="button small" id="bsBatchDraft">批量加入草稿箱</button>
        <button class="button small quiet" id="bsClear">清空选择</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th><input type="checkbox" id="bsAll"></th><th style="min-width:260px">商品信息</th><th>机会判断</th><th>月销量</th><th>月销售额</th><th>单价</th><th>环比</th><th>转化率</th><th>操作</th></tr></thead>
        <tbody id="bsBody"><tr><td colspan="9" class="empty">点击查询加载榜单数据</td></tr></tbody>
      </table></div>
    </div>`;
  const activateOne = (selector, cb) => $$(selector).forEach((btn) => btn.addEventListener("click", () => {
    $$(selector).forEach((x) => x.classList.remove("active"));
    btn.classList.add("active");
    cb?.();
  }));
  activateOne("#bsTypeTabs .mode-tab", loadBestsellerRows);
  activateOne("#bsPeriod .chip", loadBestsellerRows);
  activateOne("#bsCurrency .chip", renderBestsellerRows);
  activateOne("#bsCategoryTabs .mode-tab", loadBestsellerRows);
  $$("#bsStrategy .chip").forEach((c) => c.addEventListener("click", () => { c.classList.toggle("active"); loadBestsellerRows(); }));
  $("#bsQuery")?.addEventListener("click", loadBestsellerRows);
  $("#bsReset")?.addEventListener("click", () => { ["bsName","bsSku","bsBulkSku","bsSales","bsGmv","bsPrice","bsGrowth"].forEach((id) => { const el = $("#" + id); if (el) el.value = ""; }); loadBestsellerRows(); });
  $("#bsAll")?.addEventListener("change", (e) => { $$("#bsBody input[type=checkbox]").forEach((c) => c.checked = e.target.checked); updateBestsellerSelected(); });
  $("#bsClear")?.addEventListener("click", () => { $$("#bsBody input[type=checkbox]").forEach((c) => c.checked = false); updateBestsellerSelected(); });
  $("#bsBatchDraft")?.addEventListener("click", batchAddBestsellerDraft);
  await loadBestsellerRows();
}

async function loadBestsellerRows() {
  const body = $("#bsBody");
  if (body) body.innerHTML = `<tr><td colspan="9" class="empty"><span class="spinner"></span> 加载榜单...</td></tr>`;
  const type = $("#bsTypeTabs .active")?.dataset.tab || "hot";
  const period = $("#bsPeriod .active")?.dataset.v || "7";
  const category = $("#bsCategoryTabs .active")?.dataset.v || "";
  const skuBatch = [$("#bsSku")?.value || "", $("#bsBulkSku")?.value || ""].filter(Boolean).join("\n");
  try {
    const qs = new URLSearchParams({ type, period, category, sku_batch: skuBatch });
    const data = await getJson(`/api/selection/top-list?${qs.toString()}`);
    state._bestsellerRows = data.items || [];
    $("#bsTotal").textContent = `共 ${data.total || 0} 件商品 · 当前展示 1-${Math.min(20, data.total || 0)}`;
    $("#bsUpdated").textContent = `数据更新 ${formatTime(new Date().toISOString())} · ${data.source || "source"}`;
    renderBestsellerRows();
  } catch (error) {
    if (body) body.innerHTML = `<tr><td colspan="9" class="empty">加载失败：${escapeHtml(error.message)}</td></tr>`;
  }
}

function renderBestsellerRows() {
  const body = $("#bsBody");
  const rows = state._bestsellerRows || [];
  const currency = $("#bsCurrency .active")?.dataset.v || "rub";
  if (!body) return;
  if (!rows.length) { body.innerHTML = `<tr><td colspan="9" class="empty">暂无榜单数据；可粘贴批量 SKUS 后查询。</td></tr>`; return; }
  body.innerHTML = rows.map((item, index) => {
    const price = currency === "cny" ? formatPriceBrief(item.avgPriceRub) : `${Math.round(item.avgPriceRub || 0)} ₽`;
    const revenue = currency === "cny" ? formatPriceBrief(item.monthlyRevenueRub) : `${Math.round(item.monthlyRevenueRub || 0).toLocaleString()} ₽`;
    return `<tr data-sku="${escapeAttr(item.sku)}">
      <td><input type="checkbox" data-sku="${escapeAttr(item.sku)}"></td>
      <td class="wrap">
        <div style="font-weight:600;color:var(--blue)">${escapeHtml(item.title || item.sku)}</div>
        <div class="muted">SKU ${escapeHtml(item.sku || "—")} · ${escapeHtml(item.brand || "—")} · ${escapeHtml(item.fulfillment || "—")}</div>
      </td>
      <td>${(item.opportunity || []).map((x) => `<span class="badge ${x.includes("蓝海") ? "blue" : x.includes("可") ? "green" : "amber"}">${escapeHtml(x)}</span>`).join(" ")}</td>
      <td>${Number(item.monthlySales || 0).toLocaleString()}</td>
      <td>${revenue}</td>
      <td>${price}<div class="muted">跟卖 ${currency === "cny" ? formatPriceBrief(item.minSellerPriceRub) : `${Math.round(item.minSellerPriceRub || 0)} ₽`}</div></td>
      <td style="color:${Number(item.growthPct) >= 0 ? "var(--red)" : "var(--green)"}">${Number(item.growthPct || 0).toFixed(1)}%</td>
      <td>${Number(item.conversionRate || 0).toFixed(1)}%</td>
      <td><button class="button primary small" data-follow="${escapeAttr(item.sku)}">一键跟卖</button></td>
    </tr>`;
  }).join("");
  $$("#bsBody input[type=checkbox]").forEach((c) => c.addEventListener("change", updateBestsellerSelected));
  $$("#bsBody [data-follow]").forEach((btn) => btn.addEventListener("click", () => followBestseller(btn.dataset.follow)));
  updateBestsellerSelected();
}

function updateBestsellerSelected() {
  const count = $$("#bsBody input[type=checkbox]").filter((c) => c.checked).length;
  const el = $("#bsSelected");
  if (el) el.textContent = `已选 ${count}`;
}

async function followBestseller(sku) {
  try {
    await postJson("/api/selection/follow", { sku, target_stores: [state.currentStoreId || "default"], price_adjustment: "0%" });
    toast("已加入采集箱，等待补齐详情", "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function batchAddBestsellerDraft() {
  const skus = $$("#bsBody input[type=checkbox]").filter((c) => c.checked).map((c) => c.dataset.sku).filter(Boolean);
  if (!skus.length) return toast("请先勾选商品", "error");
  try {
    const data = await postJson("/api/selection/batch-add-draft", { skus, target_stores: [state.currentStoreId || "default"] });
    toast(`已加入采集箱 ${data.count || skus.length} 个`, "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function renderChinaZone(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>中国专区</h2><span class="meta">中国卖家 Ozon 爆款榜单</span></div>
      <div class="mode-tabs" id="czType">
        <button class="mode-tab active" data-v="growth">高增长</button>
        <button class="mode-tab" data-v="low-price">低价高销</button>
        <button class="mode-tab" data-v="benchmark">中国标杆</button>
      </div>
      <p class="muted">当前复用榜单选品数据管道；接入中国卖家数据源后会按类型过滤。</p>
    </div>
    <div class="card">
      <div class="card-head"><h2>榜单结果</h2><button class="button small" id="czLoad">刷新</button></div>
      <div class="table-wrap"><table>
        <thead><tr><th>商品</th><th>机会</th><th>销量</th><th>销售额</th><th>操作</th></tr></thead>
        <tbody id="czBody"><tr><td colspan="5" class="empty">加载中...</td></tr></tbody>
      </table></div>
    </div>`;
  $$("#czType .mode-tab").forEach((btn) => btn.addEventListener("click", () => {
    $$("#czType .mode-tab").forEach((x) => x.classList.remove("active"));
    btn.classList.add("active");
    loadChinaZoneRows();
  }));
  $("#czLoad")?.addEventListener("click", loadChinaZoneRows);
  await loadChinaZoneRows();
}

async function loadChinaZoneRows() {
  const body = $("#czBody");
  if (body) body.innerHTML = `<tr><td colspan="5" class="empty"><span class="spinner"></span> 加载中...</td></tr>`;
  try {
    const type = $("#czType .active")?.dataset.v || "growth";
    const data = await getJson(`/api/selection/top-list?type=${encodeURIComponent(type)}&period=28`);
    const items = data.items || [];
    if (!items.length) { body.innerHTML = `<tr><td colspan="5" class="empty">暂无数据</td></tr>`; return; }
    body.innerHTML = items.slice(0, 30).map((it) => `<tr>
      <td class="wrap"><strong>${escapeHtml(it.title)}</strong><div class="muted">SKU ${escapeHtml(it.sku)}</div></td>
      <td>${(it.opportunity || []).map((x) => `<span class="badge blue">${escapeHtml(x)}</span>`).join(" ")}</td>
      <td>${Number(it.monthlySales || 0).toLocaleString()}</td>
      <td>${Math.round(it.monthlyRevenueRub || 0).toLocaleString()} ₽</td>
      <td><button class="button small primary" data-follow="${escapeAttr(it.sku)}">一键跟卖</button></td>
    </tr>`).join("");
    $$("#czBody [data-follow]").forEach((btn) => btn.addEventListener("click", () => followBestseller(btn.dataset.follow)));
  } catch (error) {
    if (body) body.innerHTML = `<tr><td colspan="5" class="empty">加载失败：${escapeHtml(error.message)}</td></tr>`;
  }
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
            <button id="pauseBtn" class="button" disabled>暂停</button>
            <button id="resumeBtn" class="button" disabled>继续</button>
            <button id="finishBtn" class="button" disabled>结束并导出</button>
            <button id="cancelBtn" class="button danger" disabled>停止</button>
          </div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>采集端状态</h2><span class="meta" id="singleCollectorMeta">检测中...</span></div>
      <div id="singleCollectorBox" class="muted">正在检测当前账号的本机采集端...</div>
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
  loadWorkerStatus("single").catch(() => {});
  restoreActiveJob("single").catch(() => {});
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
      localStorage.setItem("currentJobId", data.jobId);
      $("#singleLogs").textContent = `任务已创建：${data.jobId}\n`;
      $("#singleStatus").textContent = "排队中";
      loadWorkerStatus("single").catch(() => {});
      startJobPolling();
    } catch (error) {
      $("#singleLogs").textContent = `启动失败：${error.message}`;
      $("#runBtn").disabled = false; $("#cancelBtn").disabled = true;
    }
  });
  $("#cancelBtn")?.addEventListener("click", async () => {
    await actOnCurrentJob("cancel");
  });
  $("#pauseBtn")?.addEventListener("click", () => actOnCurrentJob("pause"));
  $("#resumeBtn")?.addEventListener("click", () => actOnCurrentJob("resume"));
  $("#finishBtn")?.addEventListener("click", () => actOnCurrentJob("finish"));
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
    if (!data || !data.job) return;
    renderPolledJob(data.job);
    if (["done", "error", "canceled", "paused"].includes(data.job.status)) {
      clearInterval(state.pollTimer);
      const r = $("#runBtn"); if (r) r.disabled = false;
      updateJobControlButtons(data.job.status);
      if (["done", "error", "canceled"].includes(data.job.status)) localStorage.removeItem("currentJobId");
    }
  } catch (e) { /* ignore */ }
}

async function restoreActiveJob(scope = "single") {
  let job = null;
  const savedId = localStorage.getItem("currentJobId") || "";
  if (savedId) {
    try {
      const data = await getJson(`/api/jobs/${savedId}`);
      job = data.job || null;
    } catch {}
  }
  if (!job || ["done", "error", "canceled"].includes(job.status)) {
    const history = await getJson("/api/history").catch(() => null);
    const wantedKind = scope === "batch" ? "batch-ozon" : "run";
    const activeStatuses = new Set(["queued", "claimed", "running", "paused"]);
    const item = (history?.items || []).find((it) => it.kind === wantedKind && activeStatuses.has(it.status));
    if (item?.id) {
      const data = await getJson(`/api/jobs/${item.id}`);
      job = data.job || null;
    }
  }
  if (!job || ["done", "error", "canceled"].includes(job.status)) return;
  state.currentJobId = job.id;
  localStorage.setItem("currentJobId", job.id);
  renderPolledJob(job);
  updateJobControlButtons(job.status);
  if (job.status !== "paused") startJobPolling();
}

async function actOnCurrentJob(action, jobId = state.currentJobId) {
  if (!jobId) return;
  const labels = { pause: "暂停", resume: "继续", finish: "结束并导出", cancel: "停止" };
  if (action === "finish" && !confirm("确定结束当前任务并按已采集结果生成 Excel？")) return;
  if (action === "cancel" && !confirm("确定停止并取消当前任务？取消后不会继续。")) return;
  try {
    const data = await postJson(`/api/jobs/${jobId}/${action}`, {});
    if (data.job) renderPolledJob(data.job);
    if (data.downloadUrl) toast("Excel 已生成，可以下载。", "success");
    else toast(`${labels[action] || "操作"}成功`, "success");
    if (action === "resume") {
      state.currentJobId = jobId;
      localStorage.setItem("currentJobId", jobId);
      startJobPolling();
    }
    if (action === "finish" || action === "cancel") {
      clearInterval(state.pollTimer);
      localStorage.removeItem("currentJobId");
    }
    await loadHistoryIfVisible();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function loadHistoryIfVisible() {
  if ($("#historyBody")) await loadHistory();
}

function updateJobControlButtons(status) {
  const active = ["queued", "claimed", "running"].includes(status);
  const paused = status === "paused";
  const terminal = ["done", "error", "canceled"].includes(status);
  const run = $("#runBtn") || $("#batchRunBtn");
  const pause = $("#pauseBtn") || $("#batchPauseBtn");
  const resume = $("#resumeBtn") || $("#batchResumeBtn");
  const finish = $("#finishBtn") || $("#batchFinishBtn");
  const cancel = $("#cancelBtn") || $("#batchCancelBtn");
  if (run) run.disabled = active;
  if (pause) pause.disabled = !active;
  if (resume) resume.disabled = !paused;
  if (finish) finish.disabled = terminal || (!active && !paused);
  if (cancel) cancel.disabled = terminal;
}

function renderPolledJob(job) {
  const isBatchPage = Boolean($("#batchStatus"));
  const statusLabel = isBatchPage ? $("#batchStatus") : $("#singleStatus");
  const logBox = isBatchPage ? $("#batchLogs") : $("#singleLogs");
  const resultCount = isBatchPage ? $("#batchResultCount") : $("#singleResultCount");
  const resultsBody = isBatchPage ? $("#batchResultsBody") : $("#singleResultsBody");
  const downloadLink = isBatchPage ? $("#batchDownload") : $("#singleDownload");
  if (statusLabel) statusLabel.textContent = `${job.status} · ${job.phase || ""} · ${job.processed || 0}/${job.total || 0}`;
  updateJobControlButtons(job.status);
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
        <button id="batchPauseBtn" class="button" disabled>暂停</button>
        <button id="batchResumeBtn" class="button" disabled>继续</button>
        <button id="batchFinishBtn" class="button" disabled>结束并导出</button>
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
  restoreActiveJob("batch").catch(() => {});
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
      localStorage.setItem("currentJobId", data.jobId);
      $("#batchStatus").textContent = "排队中";
      startJobPolling();
    } catch (error) {
      $("#batchLogs").textContent = `启动失败：${error.message}`;
      $("#batchRunBtn").disabled = false; $("#batchCancelBtn").disabled = true;
    }
  });
  $("#batchCancelBtn")?.addEventListener("click", async () => {
    await actOnCurrentJob("cancel");
  });
  $("#batchPauseBtn")?.addEventListener("click", () => actOnCurrentJob("pause"));
  $("#batchResumeBtn")?.addEventListener("click", () => actOnCurrentJob("resume"));
  $("#batchFinishBtn")?.addEventListener("click", () => actOnCurrentJob("finish"));
}

/* ============== 商品列表 ==================== */

/* ============================================================
   商品列表（01-product-list-enhancement.md 基础版）
   - 7 个业务状态 Tab 对应 Ozon /v3/product/list 的 visibility
   - 支持关键词搜索 / 分页 (last_id)
   ============================================================ */

// 前端 Tab → Ozon visibility 映射，带彩色圆点（对齐 MyERP）
const PRODUCT_TABS = [
  { key: "ALL",             label: "全部",     dot: "#333" },
  { key: "VISIBLE",         label: "销售中",   dot: "#3d9d55" },
  { key: "READY_TO_SUPPLY", label: "准备出售", dot: "#2f80ed" },
  { key: "STATE_FAILED_MODERATION", label: "错误", dot: "#e94848" },
  { key: "NEED_ATTENTION",  label: "待修改",   dot: "#e5972b" },
  { key: "IN_ACTIVE",       label: "已下架",   dot: "#999" },
  { key: "ARCHIVED",        label: "已归档",   dot: "#777" },
];

async function renderProductList(root) {
  const tabsHtml = PRODUCT_TABS.map((t, i) => `
    <button class="mode-tab${i === 0 ? " active" : ""}" data-v="${t.key}" style="display:inline-flex;align-items:center;gap:5px">
      <span style="width:7px;height:7px;border-radius:50%;background:${t.dot};display:inline-block"></span>
      ${escapeHtml(t.label)} <span class="muted" data-count="${t.key}">—</span>
    </button>`).join("");
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>商品列表</h2>
        <span class="meta" id="plMeta">加载中…</span>
        <button class="button small" id="plAutoSync">🔴 自动同步</button>
        <button class="button small primary" id="plSyncNow">🔄 立即同步</button>
        <button class="button small" id="plRefresh">🔄 刷新</button>
      </div>
      <div class="mode-tabs" id="plStatusTabs">${tabsHtml}</div>
      <div class="filter-bar" style="margin-top: 10px; gap: 8px; align-items: center">
        <input type="search" id="plSearch" placeholder="🔍 搜 offer_id / 商品标题 / product_id" style="min-width:280px" />
        <label style="display:flex;align-items:center;gap:5px;font-size:12px">
          <span class="muted">价格指数</span>
          <select id="plPriceIndex" style="padding:4px 8px">
            <option value="">全部</option>
            <option value="超值">超值</option>
            <option value="有利">有利</option>
            <option value="中等">中等</option>
            <option value="不利">不利</option>
          </select>
        </label>
        <label style="display:flex;align-items:center;gap:5px;font-size:12px">
          <span class="muted">每页</span>
          <select id="plLimit" style="padding:4px 8px">
            <option value="20">20</option>
            <option value="50" selected>50</option>
            <option value="100">100</option>
            <option value="200">200</option>
          </select>
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px"><input type="checkbox" id="plArchived" checked /> 含已归档</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px" title="不拉详情=只显示 offer_id/product_id，快 3~5 倍">
          <input type="checkbox" id="plWithDetail" checked /> 拉详情（图/价/库存）
        </label>
        <button class="button" id="plGo">应用</button>
        <span class="muted" style="margin-left:auto;font-size:11px" id="plLoadTime"></span>
      </div>
      <div class="table-wrap"><table style="table-layout:auto">
        <thead><tr>
          <th style="width:28px"><input type="checkbox" id="plAll"></th>
          <th style="min-width:340px">商品信息</th>
          <th style="width:110px">状态</th>
          <th style="width:110px">价格</th>
          <th style="width:100px">库存</th>
          <th style="width:100px">货源 (¥)</th>
          <th style="width:110px">最后同步</th>
          <th style="width:100px">操作</th>
        </tr></thead>
        <tbody id="plBody"><tr><td colspan="8" class="empty">加载中…</td></tr></tbody>
      </table></div>
    </div>`;
  $$("#plStatusTabs .mode-tab").forEach((t) => t.addEventListener("click", () => {
    $$("#plStatusTabs .mode-tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    loadProductList();
  }));
  $("#plRefresh")?.addEventListener("click", () => loadProductList());
  $("#plGo")?.addEventListener("click", () => loadProductList());
  $("#plLimit")?.addEventListener("change", () => loadProductList());
  $("#plWithDetail")?.addEventListener("change", () => loadProductList());
  $("#plPriceIndex")?.addEventListener("change", () => filterProductList());
  $("#plAll")?.addEventListener("change", (e) => $$("#plBody input[type=checkbox]").forEach((c) => c.checked = e.target.checked));
  $("#plAutoSync")?.addEventListener("click", toggleProductAutoSync);
  await loadProductAutoSyncState();
  $("#plSyncNow")?.addEventListener("click", syncProductsNow);
  $("#plSearch")?.addEventListener("input", () => filterProductList());
  await loadProductList();
}

let _plItemsCache = [];

async function loadProductList() {
  const limit = Number($("#plLimit")?.value || 50);
  const archived = $("#plArchived")?.checked || false;
  const withDetail = $("#plWithDetail")?.checked !== false;
  const tabEl = $$("#plStatusTabs .mode-tab").find((t) => t.classList.contains("active"));
  const visibility = tabEl?.dataset.v || "ALL";
  const actualVisibility = visibility === "ARCHIVED" ? "ALL" : visibility;
  const actualArchived = visibility === "ARCHIVED" ? true : archived;
  const meta = $("#plMeta");
  const body = $("#plBody");
  const loadTime = $("#plLoadTime");
  if (meta) meta.textContent = "加载中…";
  if (loadTime) loadTime.textContent = "";
  if (body) body.innerHTML = `<tr><td colspan="8" class="empty"><span class="spinner"></span> 加载中${withDetail ? "（含详情，可能需要 2~5s）" : ""}…</td></tr>`;
  const t0 = performance.now();
  try {
    const data = await postJson("/api/seller/products", { limit, visibility: actualVisibility, archived: actualArchived, withDetail, store_id: state.currentStoreId || "" });
    const items = data.data?.result?.items || data.data?.items || [];
    const total = data.data?.result?.total ?? items.length;
    _plItemsCache = items;
    const countEl = document.querySelector(`#plStatusTabs [data-count="${visibility}"]`);
    if (countEl) countEl.textContent = String(total);
    if (meta) meta.textContent = `共 ${total} 个 · 显示 ${items.length}`;
    if (loadTime) loadTime.textContent = `加载 ${((performance.now() - t0) / 1000).toFixed(1)}s`;
    filterProductList();
  } catch (error) {
    if (body) body.innerHTML = `<tr><td colspan="8" class="empty">加载失败：${escapeHtml(error.message)}</td></tr>`;
    if (meta) meta.textContent = "加载失败";
  }
}

function filterProductList() {
  const search = ($("#plSearch")?.value || "").toLowerCase().trim();
  const priceIndex = $("#plPriceIndex")?.value || "";
  const body = $("#plBody");
  let items = _plItemsCache;
  if (search) {
    items = items.filter((it) =>
      (it.name || "").toLowerCase().includes(search) ||
      (it.offer_id || "").toLowerCase().includes(search) ||
      String(it.product_id || "").includes(search),
    );
  }
  if (priceIndex) items = items.filter((it) => String(it.price_index || "") === priceIndex);
  if (!items.length) { body.innerHTML = `<tr><td colspan="8" class="empty">无数据</td></tr>`; return; }
  body.innerHTML = items.map((it) => {
    // 商品信息（图 + 标题 + offer_id + product_id）
    const img = it.image
      ? `<img src="${escapeAttr(it.image)}" style="width:52px;height:52px;object-fit:cover;border-radius:5px;background:#f4f4f4;flex-shrink:0" loading="lazy" onerror="this.style.opacity=0.2">`
      : `<div style="width:52px;height:52px;background:#f4f4f4;border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;color:#bbb">📦</div>`;
    const title = it.name || it.offer_id || `#${it.product_id}`;
    const truncTitle = title.length > 60 ? title.slice(0, 60) + "…" : title;
    const ozonUrl = it.product_id ? `https://www.ozon.ru/product/${it.product_id}/` : "";
    const productInfo = `
      <div style="display:flex;gap:10px;align-items:flex-start">
        ${img}
        <div style="min-width:0;flex:1">
          <div style="font-size:12.5px;line-height:1.35;color:#333" title="${escapeAttr(title)}">${escapeHtml(truncTitle)}</div>
          <div style="font-size:10.5px;color:#8a8f85;margin-top:3px;font-family:ui-monospace,Menlo,monospace">
            offer: <b>${escapeHtml(it.offer_id || "—")}</b>
            · pid: ${ozonUrl ? `<a href="${escapeAttr(ozonUrl)}" target="_blank" rel="noreferrer" style="color:#8a8f85;text-decoration:underline">${escapeHtml(String(it.product_id))}</a>` : escapeHtml(String(it.product_id || "—"))}
            ${it.images_count > 1 ? `· 🖼${it.images_count}` : ""}
          </div>
        </div>
      </div>`;

    // 状态
    let stateBadge, stateTooltip = "";
    if (it.archived) stateBadge = '<span class="badge gray">已归档</span>';
    else if (!it.is_valid) stateBadge = '<span class="badge red">无效</span>';
    else if (it.state_name === "price_sent" || it.moderate_status === "approved" && it.state_name === "processed") stateBadge = '<span class="badge green">销售中</span>';
    else if (it.moderate_status === "declined" || it.state_name === "failed_moderation") stateBadge = '<span class="badge red">审核失败</span>';
    else if (it.moderate_status === "new" || it.state_name === "moderating") stateBadge = '<span class="badge orange">审核中</span>';
    else if (it.state_name === "processed" || it.state_name === "imported") stateBadge = '<span class="badge blue">已同步</span>';
    else stateBadge = `<span class="badge gray">${escapeHtml(it.state_name || "—")}</span>`;
    stateTooltip = it.state_tooltip || it.state_name || "";

    // 价格（CNY 为主，RUB 为辅）
    const price = it.marketing_price || it.price;
    const oldPrice = it.old_price;
    const cnyPrice = it.marketing_price_cny || it.price_cny;
    const cnyOldPrice = it.old_price_cny;
    const priceIndexBadge = it.price_index ? `<span class="badge ${it.price_index === "超值" ? "green" : it.price_index === "有利" ? "blue" : "gray"}">${escapeHtml(it.price_index)}</span>` : "";
    const priceHtml = cnyPrice != null
      ? `<div style="font-size:13px;font-weight:600;color:#c0392b">¥${cnyPrice.toFixed(2)} ${priceIndexBadge} <button class="icon-btn" data-edit-field="price" data-offer="${escapeAttr(it.offer_id || "")}" data-value="${escapeAttr(cnyPrice)}" title="编辑价格">✎</button></div>${cnyOldPrice != null && cnyOldPrice !== cnyPrice ? `<div style="font-size:10px;color:#999;text-decoration:line-through">¥${cnyOldPrice.toFixed(2)}</div>` : ""}<div style="font-size:10px;color:#999">≈ ₽${escapeHtml(price || "—")}</div>`
      : price
        ? `<div style="font-size:13px;font-weight:600;color:#333">₽${escapeHtml(price)} <button class="icon-btn" data-edit-field="price" data-offer="${escapeAttr(it.offer_id || "")}" data-value="${escapeAttr(rubToCny(price) || "")}" title="编辑价格">✎</button></div>${oldPrice && oldPrice !== price ? `<div style="font-size:10.5px;color:#999;text-decoration:line-through">₽${escapeHtml(oldPrice)}</div>` : ""}`
        : '<span class="muted">—</span>';

    // 库存
    const fbo = it.stock_fbo_present;
    const fbs = it.stock_fbs_present;
    let stockHtml = "";
    if (fbo === null && fbs === null) stockHtml = '<span class="muted">—</span>';
    else {
      const bits = [];
      if (fbo !== null) bits.push(`<span title="FBO">FBO: <b>${fbo}</b></span>`);
      if (fbs !== null) bits.push(`<span title="FBS">FBS: <b>${fbs}</b></span>`);
      const stockValue = fbs !== null ? fbs : fbo;
      stockHtml = `<div style="font-size:11.5px;line-height:1.5">${bits.join("<br>")} <button class="icon-btn" data-edit-field="stock" data-offer="${escapeAttr(it.offer_id || "")}" data-value="${escapeAttr(stockValue ?? "")}" title="编辑库存">✎</button></div>`;
    }
    const purchaseHtml = it.purchase_price_cny != null
      ? `<span style="font-weight:600">¥${Number(it.purchase_price_cny).toFixed(2)}</span> <button class="icon-btn" data-edit-field="purchase" data-offer="${escapeAttr(it.offer_id || "")}" data-value="${escapeAttr(it.purchase_price_cny)}" data-remark="${escapeAttr(it.purchase_remark || "")}" title="编辑采购价">✎</button><div class="muted">${escapeHtml(it.purchase_remark || "")}</div>`
      : `<button class="button small" data-edit-field="purchase" data-offer="${escapeAttr(it.offer_id || "")}" data-value="" data-remark="">+ 录入采购价</button>`;
    const diagnostics = Array.isArray(it.diagnostics) ? it.diagnostics : [];
    const diagHtml = diagnostics.length ? `<button class="badge amber" data-diagnostics="${escapeAttr(JSON.stringify(diagnostics))}">${diagnostics.length} 项异常</button>` : "";

    return `<tr title="${escapeAttr(stateTooltip)}">
      <td><input type="checkbox" data-offer="${escapeAttr(it.offer_id || "")}"></td>
      <td>${productInfo}</td>
      <td>${stateBadge}<div style="margin-top:4px">${diagHtml}</div></td>
      <td>${priceHtml}</td>
      <td>${stockHtml}</td>
      <td>${purchaseHtml}</td>
      <td class="muted" style="font-size:11px" title="${escapeAttr(it.last_synced_at || it.updated_at || it.created_at || "")}">${escapeHtml(formatTime(it.last_synced_at || it.updated_at || it.created_at) || "—")}</td>
      <td>
        <button class="button small" data-product-edit="${escapeAttr(it.offer_id || "")}">编辑</button>
        <button class="button small quiet" data-product-health="${escapeAttr(it.offer_id || "")}">体检</button>
        <a class="button small" href="${escapeAttr(ozonUrl)}" target="_blank" rel="noreferrer">Ozon ↗</a>
      </td>
    </tr>`;
  }).join("");
  bindProductListRowActions();
}

function bindProductListRowActions() {
  $$("[data-edit-field]").forEach((btn) => {
    btn.addEventListener("click", () => openProductInlineEditor(btn));
  });
  $$("[data-diagnostics]").forEach((btn) => {
    btn.addEventListener("click", () => {
      let items = [];
      try { items = JSON.parse(btn.getAttribute("data-diagnostics") || "[]"); } catch {}
      alert(items.map((it, i) => `${i + 1}. ${it.text || it}`).join("\n") || "暂无异常");
    });
  });
  $$("[data-product-edit]").forEach((btn) => btn.addEventListener("click", () => toast("商品编辑 Modal 将复用上架编辑器，下一批接入", "info")));
  $$("[data-product-health]").forEach((btn) => btn.addEventListener("click", () => toast("体检结果已在状态列展示", "info")));
}

async function openProductInlineEditor(button) {
  const field = button.dataset.editField;
  const offer = button.dataset.offer || "";
  if (!offer) return toast("缺少 offer_id", "error");
  if (field === "purchase") {
    const priceText = prompt("采购价（人民币）", button.dataset.value || "");
    if (priceText === null) return;
    const remark = prompt("采购备注", button.dataset.remark || "") ?? "";
    try {
      await fetchJsonPatch(`/api/products/${encodeURIComponent(offer)}/purchase`, {
        price_cny: Number(priceText),
        remark,
        store_id: state.currentStoreId || "",
      });
      toast("采购价已保存", "success");
      await loadProductList();
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }
  const label = field === "price" ? "售价 CNY" : "库存";
  const current = button.dataset.value || "";
  const next = prompt(label, current);
  if (next === null) return;
  try {
    if (field === "price") {
      await fetchJsonPatch(`/api/products/${encodeURIComponent(offer)}/field`, { key: "price", cny: Number(next), store_id: state.currentStoreId || "" });
    } else if (field === "stock") {
      await fetchJsonPatch(`/api/products/${encodeURIComponent(offer)}/field`, { key: "stock", stock: Number(next), store_id: state.currentStoreId || "" });
    }
    toast("已保存", "success");
    await loadProductList();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function fetchJsonPatch(url, payload) {
  const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload || {}) });
  if (res.status === 401) { location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`; throw new Error("请先登录"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.error || `请求失败：${res.status}`);
  return data;
}

async function syncProductsNow() {
  const btn = $("#plSyncNow");
  if (btn) { btn.disabled = true; btn.textContent = "同步中..."; }
  try {
    const data = await postJson("/api/products/sync-now", { store_id: state.currentStoreId || "", limit: 100 });
    toast(`已同步 ${data.synced || 0} 个商品`, "success");
    await loadProductList();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "🔄 立即同步"; }
  }
}

async function toggleProductAutoSync() {
  const enabled = state.productAutoSyncEnabled !== true;
  await postJson("/api/products/auto-sync-toggle", { enabled, store_id: state.currentStoreId || "", intervalMinutes: 60 });
  state.productAutoSyncEnabled = enabled;
  const btn = $("#plAutoSync");
  if (btn) btn.textContent = enabled ? "🟢 自动同步" : "🔴 自动同步";
  toast(enabled ? "已开启自动同步配置" : "已关闭自动同步配置", "success");
}

async function loadProductAutoSyncState() {
  const btn = $("#plAutoSync");
  if (!btn) return;
  try {
    const qs = new URLSearchParams({ store_id: state.currentStoreId || "" });
    const data = await getJson(`/api/products/auto-sync-settings?${qs.toString()}`);
    state.productAutoSyncEnabled = Boolean(data.setting?.enabled);
  } catch {
    state.productAutoSyncEnabled = false;
  }
  btn.textContent = state.productAutoSyncEnabled ? "🟢 自动同步" : "🔴 自动同步";
}

/* ============================================================
   采集箱（02-collect-box.md 基础版）
   - 粘 Ozon 链接或 SKU → 批量入箱
   - 状态 Tab：待采集 / 已采集 / 已上架 / 失败 / 忽略
   - "送入上架" = 把选中项的 URL 带到 /products/upload 页
   ============================================================ */

const COLLECT_TABS = [
  { key: "all",       label: "全部" },
  { key: "pending",   label: "待采集" },
  { key: "scraped",   label: "已采集" },
  { key: "uploaded",  label: "已上架" },
  { key: "failed",    label: "失败" },
  { key: "ignored",   label: "忽略" },
];

async function renderCollectBox(root) {
  const tabsHtml = COLLECT_TABS.map((t, i) => `
    <button class="mode-tab${i === 0 ? " active" : ""}" data-cb="${t.key}">
      ${escapeHtml(t.label)} <span class="muted" data-cb-count="${t.key}">—</span>
    </button>`).join("");
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>采集箱</h2>
        <span class="meta" id="cbMeta">加载中…</span>
        <button class="button small" id="cbRefresh">刷新</button>
      </div>
      <p class="muted">粘贴 Ozon 商品链接（如 https://www.ozon.ru/product/xxx-123456789/）或 6 位以上纯数字 SKU，一行一条。批量入箱后可选中"送入上架"预填字段。</p>
      <div class="row" style="grid-template-columns: 1fr; gap: 8px">
        <label class="field"><span>批量输入（一行一条）</span>
          <textarea id="cbInputs" spellcheck="false" placeholder="https://www.ozon.ru/product/xxx-123456789/&#10;987654321&#10;https://www.ozon.ru/product/yyy-234567891/"></textarea>
        </label>
      </div>
      <div style="display:flex; gap:8px">
        <button class="button primary" id="cbAdd">加入采集箱</button>
        <button class="button quiet" id="cbClearInput">清空输入</button>
      </div>
    </div>
    <div class="card">
      <div class="mode-tabs" id="cbTabs">${tabsHtml}</div>
      <div class="filter-bar" style="margin-top: 8px">
        <input type="search" id="cbSearch" placeholder="按 URL / SKU / 标题 搜索" />
        <button class="button" id="cbFilter">筛选</button>
        <span class="muted" style="margin-left: auto" id="cbSelInfo">未选中</span>
        <button class="button" id="cbBulkDelete" disabled>删除选中</button>
        <button class="button primary" id="cbSendUpload" disabled>送入上架</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th style="width:32px"><input type="checkbox" id="cbSelAll" /></th>
          <th style="min-width:220px">商品 / 来源</th>
          <th style="min-width:120px">SKU</th>
          <th>价格</th>
          <th>状态</th>
          <th>加入时间</th>
          <th style="width:120px">操作</th>
        </tr></thead>
        <tbody id="cbBody"><tr><td colspan="7" class="empty">加载中…</td></tr></tbody>
      </table></div>
    </div>`;
  $("#cbAdd")?.addEventListener("click", () => addCollectItems());
  $("#cbClearInput")?.addEventListener("click", () => { $("#cbInputs").value = ""; });
  $("#cbRefresh")?.addEventListener("click", () => loadCollectItems());
  $("#cbFilter")?.addEventListener("click", () => loadCollectItems());
  $("#cbSearch")?.addEventListener("keydown", (e) => { if (e.key === "Enter") loadCollectItems(); });
  $$("#cbTabs .mode-tab").forEach((t) => t.addEventListener("click", () => {
    $$("#cbTabs .mode-tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    loadCollectItems();
  }));
  $("#cbSelAll")?.addEventListener("change", (e) => {
    $$("#cbBody input[type=checkbox][data-cb-id]").forEach((cb) => { cb.checked = e.target.checked; });
    updateCollectSelInfo();
  });
  $("#cbBulkDelete")?.addEventListener("click", () => bulkDeleteCollect());
  $("#cbSendUpload")?.addEventListener("click", () => sendCollectToUpload());
  await loadCollectItems();
}

async function addCollectItems() {
  const text = $("#cbInputs")?.value?.trim() || "";
  if (!text) { toast("请粘贴 Ozon 链接或 SKU", "error"); return; }
  const btn = $("#cbAdd");
  btn.disabled = true;
  try {
    const res = await postJson("/api/collect-items", { inputs: text });
    toast(`已入箱 ${res.insertedCount} 条${res.skippedCount ? `，跳过 ${res.skippedCount} 条重复` : ""}`, "success");
    $("#cbInputs").value = "";
    await loadCollectItems();
  } catch (e) {
    toast(e.message, "error");
  } finally { btn.disabled = false; }
}

async function loadCollectItems() {
  const tabEl = $$("#cbTabs .mode-tab").find((t) => t.classList.contains("active"));
  const status = tabEl?.dataset.cb || "all";
  const search = $("#cbSearch")?.value?.trim() || "";
  const body = $("#cbBody");
  const meta = $("#cbMeta");
  if (body) body.innerHTML = `<tr><td colspan="7" class="empty"><span class="spinner"></span> 加载中…</td></tr>`;
  try {
    const url = `/api/collect-items?limit=200&status=${encodeURIComponent(status)}${search ? `&search=${encodeURIComponent(search)}` : ""}`;
    const res = await getJson(url);
    // 更新计数
    for (const t of COLLECT_TABS) {
      const el = document.querySelector(`#cbTabs [data-cb-count="${t.key}"]`);
      if (el) el.textContent = String(res.stats?.[t.key] ?? 0);
    }
    const items = res.items || [];
    state._collectItemsCache = items;  // 缓存供送入上架使用
    if (meta) meta.textContent = `共 ${items.length} 项`;
    if (!items.length) { body.innerHTML = `<tr><td colspan="7" class="empty">采集箱是空的。粘一批 Ozon 链接试试。</td></tr>`; return; }
    body.innerHTML = items.map((it) => {
      const statusMap = {
        pending:  '<span class="badge gray">待采集</span>',
        scraped:  '<span class="badge blue">已采集</span>',
        uploaded: '<span class="badge green">已上架</span>',
        failed:   '<span class="badge red">失败</span>',
        ignored:  '<span class="badge gray">忽略</span>',
      };
      const img = it.main_image ? `<img src="${escapeAttr(it.main_image)}" style="width:40px; height:40px; object-fit:cover; border-radius:4px; margin-right:6px; vertical-align:middle">` : "";
      return `<tr>
        <td><input type="checkbox" data-cb-id="${escapeAttr(it.id)}" data-cb-url="${escapeAttr(it.ozon_url)}" /></td>
        <td class="wrap">${img}
          <div style="display:inline-block; vertical-align:middle">
            <div>${escapeHtml(it.title || "（尚未采集标题）")}</div>
            <a href="${escapeAttr(it.ozon_url)}" target="_blank" rel="noreferrer" class="muted" style="font-size:11px">${escapeHtml(it.ozon_url || it.source_value || "")}</a>
          </div>
        </td>
        <td class="muted">${escapeHtml(it.ozon_sku || "—")}</td>
        <td>${it.price_cny ? `¥${it.price_cny}` : "—"}</td>
        <td>${statusMap[it.status] || escapeHtml(it.status)}</td>
        <td class="muted">${escapeHtml(formatTime(it.created_at))}</td>
        <td><button class="button small" data-cb-del="${escapeAttr(it.id)}">删除</button></td>
      </tr>`;
    }).join("");
    $$("#cbBody input[type=checkbox][data-cb-id]").forEach((cb) => cb.addEventListener("change", updateCollectSelInfo));
    $$("#cbBody [data-cb-del]").forEach((btn) => btn.addEventListener("click", async () => {
      if (!confirm("确认删除此采集项？")) return;
      const id = btn.getAttribute("data-cb-del");
      try {
        await fetch(`/api/collect-items/${id}`, { method: "DELETE" }).then((r) => r.json()).then((d) => { if (!d.success) throw new Error(d.error); });
        toast("已删除", "success");
        await loadCollectItems();
      } catch (e) { toast(e.message, "error"); }
    }));
    updateCollectSelInfo();
  } catch (error) {
    if (body) body.innerHTML = `<tr><td colspan="7" class="empty">加载失败：${escapeHtml(error.message)}</td></tr>`;
  }
}

function updateCollectSelInfo() {
  const checked = $$("#cbBody input[type=checkbox][data-cb-id]:checked");
  const info = $("#cbSelInfo");
  const btnDel = $("#cbBulkDelete");
  const btnUp = $("#cbSendUpload");
  if (info) info.textContent = checked.length ? `已选中 ${checked.length}` : "未选中";
  if (btnDel) btnDel.disabled = checked.length === 0;
  if (btnUp)  btnUp.disabled  = checked.length === 0;
}

async function bulkDeleteCollect() {
  const ids = $$("#cbBody input[type=checkbox][data-cb-id]:checked").map((cb) => cb.getAttribute("data-cb-id"));
  if (!ids.length) return;
  if (!confirm(`确认删除选中的 ${ids.length} 条？`)) return;
  try {
    const res = await postJson("/api/collect-items/bulk-delete", { ids });
    toast(`已删除 ${res.deleted} 条`, "success");
    await loadCollectItems();
  } catch (e) { toast(e.message, "error"); }
}

function sendCollectToUpload() {
  const checked = $$("#cbBody input[type=checkbox][data-cb-id]:checked");
  if (!checked.length) return;
  const ids = checked.map((cb) => cb.getAttribute("data-cb-id"));
  // 从当前渲染的 items 中找到对应数据
  const items = state._collectItemsCache || [];
  const selected = items.filter((it) => ids.includes(it.id));
  if (!selected.length) { toast("未找到选中项的数据", "error"); return; }
  if (selected.length > 1) toast(`已选中 ${selected.length} 条，将带入第 1 条`, "info");
  const first = selected[0];
  const images = [
    first.main_image,
    ...(Array.isArray(first.images) ? first.images : []),
  ].filter(Boolean);
  const generatedOfferId = first.linked_offer_id || (first.ozon_sku ? `OZ-${first.ozon_sku}` : "");
  // 预填数据存到全局
  state._pendingUploadData = {
    collectId: first.id || "",
    title: first.title || "",
    offer_id: generatedOfferId,
    sku: generatedOfferId,
    sourceProductId: first.ozon_sku || "",
    images,
    price_cny: first.price_cny || "",
    priceCurrency: "CNY",
    attributes: first.attributes || {},
    sourceUrl: first.ozon_url || "",
  };
  navigate("products/upload");
}

/* ============== 上架 ==================== */

function parseUploadNumber(value) {
  if (value == null) return null;
  let s = String(value).trim();
  if (!s) return null;
  s = s.replace(/\s+/g, "").replace(/[，,]/g, ".").replace(/[^\d.\-]/g, "");
  const parts = s.split(".");
  if (parts.length > 2) s = `${parts.shift()}.${parts.join("")}`;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function formatUploadNumber(value, digits = 2) {
  const n = parseUploadNumber(value);
  if (n == null) return "";
  const rounded = Math.round(n * Math.pow(10, digits)) / Math.pow(10, digits);
  return String(rounded).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function splitUploadImages(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/\r?\n/);
  return raw
    .flatMap((line) => String(line || "").split(/\s+(?=https?:\/\/)/i))
    .map((s) => s.trim())
    .filter(Boolean);
}

function compactUploadImages(value) {
  const seen = new Set();
  return splitUploadImages(value).filter((url) => {
    const key = url.replace(/[?#].*$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stringifyUploadAttributes(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); }
  catch { return ""; }
}

function normalizeUploadPrefill(raw) {
  const src = raw?.item && typeof raw.item === "object" ? raw.item : (raw || {});
  const offerId = src.offer_id || src.sku || src.offerId || src.linked_offer_id || "";
  const sourceCny = src.price_cny != null && src.price_cny !== ""
    ? parseUploadNumber(src.price_cny)
    : (/CNY|RMB|人民币/i.test(src.priceCurrency || src.currency || "") ? parseUploadNumber(src.price) : null);
  const priceRub = sourceCny != null
    ? cnyToRub(sourceCny)
    : parseUploadNumber(src.price_rub ?? src.price);
  const images = compactUploadImages([
    ...splitUploadImages(src.primary_image),
    ...splitUploadImages(src.main_image || src.image),
    ...splitUploadImages(src.images),
  ]);
  return {
    collectId: src.collectId || src.collect_id || src.source_collect_id || "",
    title: src.name || src.title || "",
    offerId,
    categoryId: src.category_id || src.description_category_id || src.new_description_category_id || "",
    typeId: src.type_id || src.typeId || "",
    barcode: src.barcode || "",
    priceRub: priceRub != null ? formatUploadNumber(priceRub) : "",
    priceCnySource: sourceCny,
    vat: src.vat || "",
    weight: src.weight || "",
    depth: src.depth || "",
    width: src.width || "",
    height: src.height || "",
    images,
    attributesText: stringifyUploadAttributes(src.attributes || ""),
    sourceUrl: src.sourceUrl || src.ozon_url || raw?.sourceUrl || "",
    sourceProductId: src.sourceProductId || src.ozon_sku || "",
  };
}

function renderProductUpload(root) {
  const prefill = normalizeUploadPrefill(state._pendingUploadData || {});
  state._cachedPrefill = prefill;
  state._pendingUploadData = null;

  // AI套图图片
  const aiImg = state._pendingUploadImage || "";
  state._pendingUploadImage = null;
  const finalImages = compactUploadImages(aiImg ? [aiImg, ...prefill.images] : prefill.images).join("\n");
  const sourceMeta = [
    prefill.sourceUrl ? `<a href="${escapeAttr(prefill.sourceUrl)}" target="_blank" rel="noreferrer">来源链接</a>` : "",
    prefill.sourceProductId ? `Ozon ID: ${escapeHtml(prefill.sourceProductId)}` : "",
    prefill.priceCnySource != null ? `采集价 ¥${prefill.priceCnySource.toFixed(2)}` : "",
  ].filter(Boolean).join(" · ");

  root.innerHTML = `
    <div class="upload-workbench">
      <div class="upload-stack">
        <div class="card">
          <div class="card-head">
            <h2>上架新商品</h2>
            <span class="meta" id="sellerStatus">${prefill.title ? "已预填" : "手动填写"}</span>
            <button class="button small" id="sellerTestBtn">测试连接</button>
            <a class="button small" href="#/products/history">上架记录</a>
          </div>
          ${sourceMeta ? `<div class="upload-source">${sourceMeta}</div>` : ""}
          <input id="sellerCollectIdInput" type="hidden" value="${escapeAttr(prefill.collectId)}" />
          <input id="sellerSourceUrlInput" type="hidden" value="${escapeAttr(prefill.sourceUrl)}" />
          <div class="row">
            <label class="field"><span>商品标题</span><input id="sellerNameInput" type="text" placeholder="俄文标题" value="${escapeAttr(prefill.title)}" /></label>
            <label class="field">
              <span>货号 offer_id</span>
              <div style="display:flex;gap:4px">
                <input id="sellerOfferIdInput" type="text" placeholder="例如 OZ-123456789" value="${escapeAttr(prefill.offerId)}" style="flex:1" />
                <button class="button" id="btnAiFill" title="根据标题智能填充重量、尺寸和卖点">🪄 AI 智能填充</button>
              </div>
            </label>
          </div>
          <div class="row-3">
            <label class="field"><span>类目 <small>category_id</small></span>
              <div style="display:flex;gap:4px">
                <select id="sellerCategorySelect" style="flex:1;min-width:0"><option value="">（加载中…）</option></select>
                <input id="sellerCategoryIdInput" type="hidden" value="${escapeAttr(prefill.categoryId)}" />
                <button class="button small" id="sellerCatRefresh" title="刷新类目列表" style="flex-shrink:0">↻</button>
              </div>
            </label>
            <label class="field"><span>类型 ID <small>可选 type_id</small></span><input id="sellerTypeIdInput" type="text" inputmode="numeric" value="${escapeAttr(prefill.typeId)}" /></label>
            <label class="field"><span>Barcode <small>可选</small></span><input id="sellerBarcodeInput" type="text" value="${escapeAttr(prefill.barcode)}" /></label>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>价格与规格</h2><span class="meta" id="sellerPriceCnyPreview">—</span></div>
          <div class="row-3">
            <label class="field"><span>Ozon 售价 ₽</span>
              <div style="display:flex;gap:4px;align-items:center">
                <input id="sellerPriceInput" type="text" inputmode="decimal" placeholder="999" value="${escapeAttr(prefill.priceRub)}" style="flex:1" />
                <span style="font-size:11px;color:#999;white-space:nowrap">≈ 人民币</span>
                <input id="sellerPriceCnyInput" type="text" inputmode="decimal" placeholder="输入¥自动换算" style="width:90px;font-size:12px;color:#c0392b" />
              </div>
              <div id="sellerProfitHint" style="font-size:10.5px;color:var(--muted);margin-top:4px">
                输入人民币金额，系统将自动换算卢布价格。
              </div>
            </label>
            <label class="field"><span>重量 g</span><input id="sellerWeightInput" type="text" inputmode="numeric" placeholder="80" value="${escapeAttr(prefill.weight)}" /></label>
            <label class="field"><span>VAT <small>可选</small></span>
              <select id="sellerVatInput">
                <option value=""${!prefill.vat ? " selected" : ""}>不填写</option>
                <option value="0"${String(prefill.vat) === "0" ? " selected" : ""}>0%</option>
                <option value="0.05"${String(prefill.vat) === "0.05" ? " selected" : ""}>5%</option>
                <option value="0.07"${String(prefill.vat) === "0.07" ? " selected" : ""}>7%</option>
                <option value="0.1"${String(prefill.vat) === "0.1" ? " selected" : ""}>10%</option>
                <option value="0.2"${String(prefill.vat) === "0.2" ? " selected" : ""}>20%</option>
              </select>
            </label>
          </div>
          <div class="row-3">
            <label class="field"><span>长 mm</span><input id="sellerDepthInput" type="text" inputmode="numeric" value="${escapeAttr(prefill.depth)}" /></label>
            <label class="field"><span>宽 mm</span><input id="sellerWidthInput" type="text" inputmode="numeric" value="${escapeAttr(prefill.width)}" /></label>
            <label class="field"><span>高 mm</span><input id="sellerHeightInput" type="text" inputmode="numeric" value="${escapeAttr(prefill.height)}" /></label>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h2>图片</h2>
            <span class="meta" id="sellerImageMeta">—</span>
            <button class="button small" id="sellerCleanImagesBtn">去重整理</button>
          </div>
          <label class="field"><span>图片 URL <small>第一张会作为主图</small></span><textarea id="sellerImagesInput" spellcheck="false">${escapeHtml(finalImages)}</textarea></label>
          <div id="sellerImagePreview" class="upload-image-strip"></div>
        </div>

        <div class="card">
          <div class="card-head">
            <h2>类目属性</h2>
            <span class="meta" id="sellerAttrMeta">选择类目后可拉取模板</span>
            <button class="button small" id="sellerAttrLoadBtn">拉取属性模板</button>
            <button class="button small" id="sellerAttrApplyBtn">生成 JSON</button>
            <button class="button small" id="sellerFormatAttrsBtn">格式化 JSON</button>
          </div>
          <div id="sellerAttributeTemplate" class="attr-template">
            <div class="muted">先选择类目，系统会从 Ozon 拉取必填属性模板。</div>
          </div>
          <label class="field"><span>attributes JSON</span><textarea id="sellerAttributesInput" class="code-area" placeholder='[{"id":85,"values":[{"value":"..."}]}]'>${escapeHtml(prefill.attributesText)}</textarea></label>
        </div>
      </div>

      <div class="upload-side">
        <div class="card">
          <div class="card-head"><h2>提交前检查</h2><span class="meta" id="sellerCheckMeta">—</span></div>
          <div id="sellerChecklist" class="upload-checklist"></div>
          <pre id="sellerPayloadPreview" class="response-area upload-payload-preview">等待填写。</pre>
          <div class="upload-actions">
            <button class="button quiet" id="sellerLoadSampleBtn">载入样例</button>
            <button class="button quiet" id="sellerClearBtn">清空</button>
            <button class="button" id="sellerValidateBtn">预检</button>
            <button class="button primary" id="sellerImportBtn">提交上架</button>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Ozon 返回</h2></div>
          <pre id="sellerResponse" class="response-area">点「测试连接」或「提交上架」后这里会显示 Ozon 的响应。</pre>
        </div>
      </div>
    </div>`;
  bindUploadHandlers();
  syncUploadPreview();
  if (prefill.title) toast("已带入商品数据，请检查后提交", "info");
}

function bindUploadHandlers() {
  // AI 一键填充逻辑
  $("#btnAiFill")?.addEventListener("click", async () => {
    const name = $("#sellerNameInput").value.trim();
    if (!name) return toast("请先填写商品标题", "error");
    
    const btn = $("#btnAiFill");
    btn.disabled = true;
    btn.textContent = "正在计算...";
    
    try {
      const res = await postJson("/api/seller/products/analyze", { name });
      if (!res.success) throw new Error(res.error);
      
      const data = res.data;
      // 智能填充重量和尺寸 (基于类目和卖点)
      if (!$("#sellerWeightInput").value) {
        let weight = 500; // 默认值
        if (name.includes("чехол") || name.includes("case")) weight = 80;
        if (name.includes("наушники") || name.includes("earphone")) weight = 150;
        if (name.includes("часы") || name.includes("watch")) weight = 200;
        $("#sellerWeightInput").value = weight;
      }
      
      if (!$("#sellerDepthInput").value) {
        $("#sellerDepthInput").value = 200;
        $("#sellerWidthInput").value = 150;
        $("#sellerHeightInput").value = 50;
      }

      // 智能填充属性 (JSON)
      const currentAttrs = [];
      if (data.selling_points) {
        currentAttrs.push({ 
          id: 85, // 品牌 ID，通常必填
          complex_id: 0, 
          values: [{ value: "No Brand" }] 
        });
      }
      $("#sellerAttributesInput").value = JSON.stringify(currentAttrs, null, 2);
      
      syncUploadPreview();
      toast("AI 已根据标题自动匹配了建议参数", "success");
    } catch (e) { toast("填充失败：" + e.message, "error"); }
    finally { btn.disabled = false; btn.textContent = "🪄 AI 智能填充"; }
  });

  // 类目下拉加载
  loadCategoryDropdown();
  $("#sellerCatRefresh")?.addEventListener("click", loadCategoryDropdown);
  $("#sellerCategorySelect")?.addEventListener("change", () => {
    const val = $("#sellerCategorySelect")?.value || "";
    $("#sellerCategoryIdInput").value = val;
    syncUploadPreview();
    loadSellerAttributeTemplate();
  });
  $("#sellerTypeIdInput")?.addEventListener("change", () => loadSellerAttributeTemplate());
  $("#sellerAttrLoadBtn")?.addEventListener("click", () => loadSellerAttributeTemplate({ force: true }));
  $("#sellerAttrApplyBtn")?.addEventListener("click", () => {
    applyCategoryAttributeForm();
    syncUploadPreview();
  });

  // CNY↔RUB 双向换算
  const priceRubEl = $("#sellerPriceInput");
  const priceCnyEl = $("#sellerPriceCnyInput");
  if (priceRubEl && priceCnyEl) {
    // 如果采集价有 CNY，自动填入换算器
    const prefCny = (state._cachedPrefill || {}).priceCnySource;
    if (prefCny != null) priceCnyEl.value = prefCny.toFixed(2);
    // 如果有预填 RUB 但没有 CNY，根据 RUB 反算 CNY
    const prefRub = (state._cachedPrefill || {}).priceRub;
    if (prefRub && !priceCnyEl.value) {
      const cny = rubToCny(parseUploadNumber(prefRub) || 0);
      if (cny != null) priceCnyEl.value = cny.toFixed(2);
    }
    const updateProfitHint = (cny) => {
      const hint = $("#sellerProfitHint");
      const cost = (state._cachedPrefill || {}).priceCnySource;
      if (hint && cost != null) {
        const profit = cny - cost;
        const rate = cny > 0 ? (profit / cny * 100).toFixed(1) : 0;
        hint.innerHTML = `成本 ¥${cost.toFixed(2)} · 利润 <b style="${profit >= 0 ? 'color:var(--green)' : 'color:var(--red)'}">¥${profit.toFixed(2)}</b> · 利润率 ${rate}%`;
      }
    };

    priceCnyEl.addEventListener("input", () => {
      const cny = parseUploadNumber(priceCnyEl.value);
      if (cny != null && RUB_CNY_RATE) {
        const rub = Math.round((cny / RUB_CNY_RATE) * 100) / 100;
        priceRubEl.value = formatUploadNumber(rub);
        updateProfitHint(cny);
        syncUploadPreview();
      }
    });
    priceRubEl.addEventListener("input", () => {
      const rub = parseUploadNumber(priceRubEl.value);
      if (rub != null && RUB_CNY_RATE) {
        const cny = rubToCny(rub);
        if (cny != null) {
          priceCnyEl.value = cny.toFixed(2);
          updateProfitHint(cny);
        }
        syncUploadPreview();
      }
    });
    // 初始触发一次
    if (priceCnyEl.value) updateProfitHint(parseUploadNumber(priceCnyEl.value));
  }

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

  const watched = [
    "sellerNameInput", "sellerOfferIdInput", "sellerCategoryIdInput", "sellerTypeIdInput",
    "sellerBarcodeInput", "sellerPriceInput", "sellerWeightInput", "sellerVatInput",
    "sellerDepthInput", "sellerWidthInput", "sellerHeightInput", "sellerImagesInput",
    "sellerAttributesInput",
  ];
  watched.forEach((id) => {
    const el = $("#" + id);
    if (el) {
      const event = el.tagName === "SELECT" ? "change" : "input";
      el.addEventListener(event, syncUploadPreview);
      if (id === "sellerImagesInput") el.addEventListener(event, refreshUploadImagePreview);
    }
  });
  // 图片去重
  $("#sellerCleanImagesBtn")?.addEventListener("click", () => {
    const ta = $("#sellerImagesInput");
    if (!ta) return;
    ta.value = compactUploadImages(ta.value).join("\n");
    refreshUploadImagePreview();
    syncUploadPreview();
    toast("已去重", "success");
  });

  $("#sellerLoadSampleBtn")?.addEventListener("click", () => {
    $("#sellerCategoryIdInput").value = "17032807";
    $("#sellerTypeIdInput").value = "";
    $("#sellerNameInput").value = "Прозрачный силиконовый чехол для iPhone 15";
    $("#sellerOfferIdInput").value = "OZON-DEMO-CASE-001";
    $("#sellerBarcodeInput").value = "6901234567890";
    $("#sellerPriceInput").value = "999";
    $("#sellerWeightInput").value = "80";
    $("#sellerDepthInput").value = "180"; $("#sellerWidthInput").value = "90"; $("#sellerHeightInput").value = "20";
    $("#sellerImagesInput").value = "https://cdn.example.com/sample-1.jpg\nhttps://cdn.example.com/sample-2.jpg";
    $("#sellerAttributesInput").value = JSON.stringify([
      { id: 85, complex_id: 0, values: [{ value: "Прозрачный" }] },
      { id: 8229, complex_id: 0, values: [{ value: "Силикон" }] },
      { id: 9163, complex_id: 0, values: [{ value: "iPhone 15" }] },
    ], null, 2);
    syncUploadPreview();
    toast("已载入手机壳样例", "success");
    loadSellerAttributeTemplate();
  });
  $("#sellerClearBtn")?.addEventListener("click", () => {
    ["sellerCategoryIdInput","sellerTypeIdInput","sellerNameInput","sellerOfferIdInput","sellerBarcodeInput","sellerPriceInput","sellerWeightInput","sellerDepthInput","sellerWidthInput","sellerHeightInput","sellerImagesInput","sellerAttributesInput"]
      .forEach((id) => { const el = $("#" + id); if (el) el.value = ""; });
    $("#sellerResponse").textContent = "已清空。";
    syncUploadPreview();
  });

  $("#sellerFormatAttrsBtn")?.addEventListener("click", () => {
    const el = $("#sellerAttributesInput");
    const text = el.value.trim();
    if (!text) { el.value = ""; syncUploadPreview(); return; }
    try {
      el.value = JSON.stringify(JSON.parse(text), null, 2);
      syncUploadPreview();
      toast("JSON 已格式化", "success");
    } catch (error) {
      toast(`JSON 解析失败：${error.message}`, "error");
    }
  });

  $("#sellerImagePreview")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-img-action]");
    if (!btn) return;
    const index = Number(btn.getAttribute("data-img-index"));
    const images = compactUploadImages($("#sellerImagesInput").value);
    if (!images[index]) return;
    const action = btn.getAttribute("data-img-action");
    if (action === "remove") images.splice(index, 1);
    if (action === "main") images.unshift(images.splice(index, 1)[0]);
    $("#sellerImagesInput").value = images.join("\n");
    syncUploadPreview();
  });

  $("#sellerValidateBtn")?.addEventListener("click", () => {
    const built = buildUploadItemFromForm();
    syncUploadPreview();
    if (built.errors.length) toast(`还有 ${built.errors.length} 个必填问题`, "error");
    else if (built.warnings.length) toast(`可提交，但有 ${built.warnings.length} 个提醒`, "info");
    else toast("预检通过", "success");
  });

  $("#sellerImportBtn")?.addEventListener("click", async () => {
    const built = buildUploadItemFromForm();
    syncUploadPreview();
    if (built.errors.length) {
      $("#sellerResponse").textContent = built.errors.join("\n");
      toast("请先处理必填问题", "error");
      return;
    }
    const btn = $("#sellerImportBtn");
    const meta = {
      collectId: $("#sellerCollectIdInput")?.value || "",
      sourceUrl: $("#sellerSourceUrlInput")?.value || "",
    };
    btn.disabled = true;
    $("#sellerResponse").textContent = "正在提交到 Ozon …";
    try {
      const data = await postJson("/api/seller/products/import", { item: built.item, meta });
      $("#sellerResponse").textContent = JSON.stringify(data, null, 2);
      const taskId = data?.taskId || data?.data?.result?.task_id;
      if (taskId) {
        $("#sellerResponse").innerHTML += `\n\n→ task_id: <b>${escapeHtml(String(taskId))}</b> · 可在<a href="#/products/history">上架记录</a>查看状态`;
      }
      toast("上架请求已提交" + (taskId ? ` (task: ${String(taskId).slice(0, 12)}…)` : ""), "success");
    } catch (error) {
      $("#sellerResponse").textContent = error.message;
      toast(error.message, "error");
    } finally { btn.disabled = false; }
  });
}

function buildUploadItemFromForm() {
  const errors = [];
  const warnings = [];
  const item = {};
  const name = $("#sellerNameInput")?.value.trim() || "";
  const offerId = $("#sellerOfferIdInput")?.value.trim() || "";
  const categoryId = parseUploadNumber($("#sellerCategoryIdInput")?.value || "");
  const typeId = parseUploadNumber($("#sellerTypeIdInput")?.value || "");
  if (!name) errors.push("请填写商品标题。");
  if (!offerId) errors.push("请填写货号 offer_id。");
  if (!categoryId || categoryId <= 0) errors.push("请填写有效的类目 ID。");
  item.name = name;
  item.offer_id = offerId;
  if (categoryId) item.category_id = Math.round(categoryId);
  if (typeId) item.type_id = Math.round(typeId);

  const barcode = $("#sellerBarcodeInput")?.value.trim() || "";
  if (barcode) item.barcode = barcode;

  const priceRub = parseUploadNumber($("#sellerPriceInput")?.value || "");
  if (priceRub != null && priceRub > 0) {
    item.price = formatUploadNumber(priceRub);
    item.currency_code = "RUB";
  } else {
    warnings.push("未填写 Ozon 售价，Ozon 可能拒绝或要求后续补价。");
  }

  const vat = $("#sellerVatInput")?.value || "";
  if (vat) item.vat = vat;

  const weight = parseUploadNumber($("#sellerWeightInput")?.value || "");
  if (weight != null && weight > 0) {
    item.weight = Math.round(weight);
    item.weight_unit = "g";
  } else {
    warnings.push("未填写重量。");
  }

  const depth = parseUploadNumber($("#sellerDepthInput")?.value || "");
  const width = parseUploadNumber($("#sellerWidthInput")?.value || "");
  const height = parseUploadNumber($("#sellerHeightInput")?.value || "");
  if ([depth, width, height].some((v) => v != null && v > 0)) {
    if (!depth || !width || !height) warnings.push("尺寸没有填完整。");
    item.depth = Math.round(depth || 0);
    item.width = Math.round(width || 0);
    item.height = Math.round(height || 0);
    item.dimension_unit = "mm";
  }

  const images = compactUploadImages($("#sellerImagesInput")?.value || "");
  if (images.length) {
    item.images = images;
    item.primary_image = images[0];
  } else {
    warnings.push("未填写图片。");
  }

  const attrsText = $("#sellerAttributesInput")?.value.trim() || "";
  if (attrsText) {
    try {
      const attrs = JSON.parse(attrsText);
      if (!Array.isArray(attrs)) errors.push("attributes 必须是 JSON 数组。");
      else item.attributes = attrs;
    } catch (error) {
      errors.push(`类目属性 JSON 解析失败：${error.message}`);
    }
  } else {
    warnings.push("未填写类目属性。");
  }
  return { item, errors, warnings, images };
}

function syncUploadPreview() {
  const built = buildUploadItemFromForm();
  const priceRub = parseUploadNumber($("#sellerPriceInput")?.value || "");
  const priceCny = priceRub != null ? rubToCny(priceRub) : null;
  const priceEl = $("#sellerPriceCnyPreview");
  if (priceEl) priceEl.textContent = priceCny != null ? `约 ¥${priceCny.toFixed(2)} · 汇率 ${RUB_CNY_RATE.toFixed(4)}` : `汇率 ${RUB_CNY_RATE.toFixed(4)}`;

  const imgMeta = $("#sellerImageMeta");
  if (imgMeta) imgMeta.textContent = `${built.images.length} 张`;
  const preview = $("#sellerImagePreview");
  if (preview) {
    preview.innerHTML = built.images.length ? built.images.map((url, i) => `
      <div class="upload-image-item">
        <img src="${escapeAttr(url)}" alt="" onerror="this.style.opacity=0.25" />
        <div class="upload-image-caption">${i === 0 ? "主图" : `第 ${i + 1} 张`}</div>
        <div class="upload-image-actions">
          ${i > 0 ? `<button class="button small" data-img-action="main" data-img-index="${i}">设主图</button>` : ""}
          <button class="button small quiet" data-img-action="remove" data-img-index="${i}">删除</button>
        </div>
      </div>`).join("") : `<div class="empty">暂无图片</div>`;
  }

  const checks = [
    { ok: Boolean(built.item.name && built.item.offer_id && built.item.category_id), label: "标题 / offer_id / 类目" },
    { ok: Boolean(built.item.price), label: "Ozon 售价" },
    { ok: Boolean(built.item.images?.length), label: "商品图片" },
    { ok: Boolean(built.item.weight), label: "重量" },
    { ok: !built.errors.some((e) => e.includes("JSON")), label: "属性 JSON" },
  ];
  const checklist = $("#sellerChecklist");
  if (checklist) {
    checklist.innerHTML = checks.map((c) => `
      <div class="upload-check ${c.ok ? "ok" : "warn"}">
        <span>${c.ok ? "通过" : "待补"}</span>${escapeHtml(c.label)}
      </div>`).join("");
  }
  const meta = $("#sellerCheckMeta");
  if (meta) meta.textContent = built.errors.length ? `${built.errors.length} 个问题` : (built.warnings.length ? `${built.warnings.length} 个提醒` : "可提交");
  const payload = $("#sellerPayloadPreview");
  if (payload) {
    payload.textContent = built.errors.length
      ? `预检问题：\n${built.errors.join("\n")}\n\n当前 payload：\n${JSON.stringify(built.item, null, 2)}`
      : JSON.stringify({ items: [built.item] }, null, 2);
  }
}

async function loadSellerAttributeTemplate(options = {}) {
  const categoryId = parseUploadNumber($("#sellerCategoryIdInput")?.value || "");
  const typeId = parseUploadNumber($("#sellerTypeIdInput")?.value || "");
  const wrap = $("#sellerAttributeTemplate");
  const meta = $("#sellerAttrMeta");
  if (!wrap) return;
  if (!categoryId) {
    wrap.innerHTML = `<div class="muted">先选择类目，系统会从 Ozon 拉取必填属性模板。</div>`;
    if (meta) meta.textContent = "未选择类目";
    return;
  }
  const cacheKey = `${categoryId}:${typeId || ""}`;
  if (!options.force && state._lastAttrTemplateKey === cacheKey && Array.isArray(state._categoryAttributes)) {
    renderCategoryAttributeForm(state._categoryAttributes);
    return;
  }
  wrap.innerHTML = `<div class="empty"><span class="spinner"></span> 正在拉取 Ozon 类目属性模板...</div>`;
  if (meta) meta.textContent = "加载中";
  try {
    const data = await postJson("/api/seller/categories/attributes", { category_id: categoryId, type_id: typeId || undefined });
    state._lastAttrTemplateKey = cacheKey;
    state._categoryAttributes = data.attributes || [];
    renderCategoryAttributeForm(state._categoryAttributes);
    if (meta) {
      const required = state._categoryAttributes.filter((item) => item.isRequired).length;
      meta.textContent = `${state._categoryAttributes.length} 个属性 · 必填 ${required}`;
    }
  } catch (error) {
    wrap.innerHTML = `<div class="empty">属性模板加载失败：${escapeHtml(error.message)}</div>`;
    if (meta) meta.textContent = "加载失败";
  }
}

function renderCategoryAttributeForm(attributes = []) {
  const wrap = $("#sellerAttributeTemplate");
  if (!wrap) return;
  if (!attributes.length) {
    wrap.innerHTML = `<div class="muted">该类目暂未返回属性模板，可继续手动填写 attributes JSON。</div>`;
    return;
  }
  const existing = parseExistingAttributeValues();
  const required = attributes.filter((item) => item.isRequired);
  const optional = attributes.filter((item) => !item.isRequired).slice(0, 8);
  const visible = [...required, ...optional].slice(0, 30);
  wrap.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <strong>属性模板</strong>
      <span class="muted">展示全部必填项，并附带前 8 个常用选填项</span>
    </div>
    <div class="attr-form-grid">
      ${visible.map((attr) => renderAttributeField(attr, existing.get(String(attr.id)) || "")).join("")}
    </div>`;
  wrap.querySelectorAll("[data-attr-input]").forEach((el) => {
    el.addEventListener("change", () => {
      applyCategoryAttributeForm({ silent: true });
      syncUploadPreview();
    });
    el.addEventListener("input", () => {
      if (el.tagName !== "SELECT") applyCategoryAttributeForm({ silent: true });
    });
  });
}

function renderAttributeField(attr, currentValue = "") {
  const id = String(attr.id || "");
  const name = attr.name || `属性 ${id}`;
  const type = String(attr.type || "string").toLowerCase();
  const options = Array.isArray(attr.dictionary) ? attr.dictionary.filter((item) => item.value || item.valueId) : [];
  const input = options.length
    ? `<select data-attr-input data-attr-id="${escapeAttr(id)}" data-complex-id="${escapeAttr(attr.complexId || 0)}">
        <option value="">— 请选择 —</option>
        ${options.map((item) => {
          const raw = `${item.valueId || ""}|||${item.value || ""}`;
          const selected = String(item.value || item.valueId) === String(currentValue) ? " selected" : "";
          return `<option value="${escapeAttr(raw)}"${selected}>${escapeHtml(item.value || item.valueId)}</option>`;
        }).join("")}
      </select>`
    : type.includes("bool")
      ? `<select data-attr-input data-attr-id="${escapeAttr(id)}" data-complex-id="${escapeAttr(attr.complexId || 0)}">
          <option value="">— 请选择 —</option>
          <option value="true"${String(currentValue).toLowerCase() === "true" ? " selected" : ""}>是</option>
          <option value="false"${String(currentValue).toLowerCase() === "false" ? " selected" : ""}>否</option>
        </select>`
      : `<input data-attr-input data-attr-id="${escapeAttr(id)}" data-complex-id="${escapeAttr(attr.complexId || 0)}" type="${type.includes("number") || type.includes("integer") ? "number" : "text"}" value="${escapeAttr(currentValue)}" placeholder="填写 ${escapeAttr(name)}" />`;
  return `
    <div class="attr-field">
      <div class="attr-title">
        ${escapeHtml(name)}
        ${attr.isRequired ? `<span class="attr-required">必填</span>` : ""}
        <span class="attr-meta">#${escapeHtml(id)}</span>
      </div>
      ${input}
      ${attr.description ? `<div class="muted" style="margin-top:5px">${escapeHtml(attr.description).slice(0, 120)}</div>` : ""}
    </div>`;
}

function parseExistingAttributeValues() {
  const map = new Map();
  const text = $("#sellerAttributesInput")?.value.trim() || "";
  if (!text) return map;
  try {
    const attrs = JSON.parse(text);
    if (!Array.isArray(attrs)) return map;
    for (const attr of attrs) {
      const id = String(attr.id || attr.attribute_id || "");
      const first = Array.isArray(attr.values) ? attr.values[0] : null;
      if (!id || !first) continue;
      map.set(id, first.value || first.dictionary_value_id || "");
    }
  } catch {}
  return map;
}

function applyCategoryAttributeForm(options = {}) {
  const inputs = $$("[data-attr-input]");
  if (!inputs.length) {
    if (!options.silent) toast("暂无属性模板可生成", "info");
    return;
  }
  const attrs = [];
  for (const input of inputs) {
    const id = Number(input.dataset.attrId || 0);
    if (!id) continue;
    let raw = String(input.value || "").trim();
    if (!raw) continue;
    const value = { value: raw };
    if (raw.includes("|||")) {
      const [valueId, label] = raw.split("|||");
      raw = label || valueId;
      value.value = raw;
      if (valueId) value.dictionary_value_id = Number(valueId) || valueId;
    }
    attrs.push({
      id,
      complex_id: Number(input.dataset.complexId || 0) || 0,
      values: [value],
    });
  }
  const ta = $("#sellerAttributesInput");
  if (ta) ta.value = JSON.stringify(attrs, null, 2);
  if (!options.silent) toast(`已生成 ${attrs.length} 个属性`, "success");
}

/* ============== 同步库存 ==================== */

/* ============== 同步库存（重写版：图+实时库存+批量填写） ==================== */

function renderProductStock(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>同步库存</h2>
        <span class="meta" id="stockMeta">加载中…</span>
        <div style="margin-left:auto;display:flex;align-items:center;gap:12px">
          <label style="font-size:11px;display:flex;align-items:center;gap:6px">
            低库存阈值 <input type="number" id="stockThreshold" value="5" min="0" max="999" style="width:55px;padding:3px 6px" />
          </label>
          <button class="button small" id="stockRefresh">↻ 刷新</button>
        </div>
      </div>
      <div class="stats-grid">
        <div class="stat-card"><div class="label">商品总数</div><div class="value" id="stockTotal">—</div></div>
        <div class="stat-card"><div class="label">缺货 (0)</div><div class="value" id="stockOut">—</div></div>
        <div class="stat-card"><div class="label">低库存</div><div class="value" id="stockLow">—</div></div>
        <div class="stat-card accent"><div class="label">待提交</div><div class="value" id="stockPending">0</div></div>
      </div>
      <div class="filter-bar" style="margin-top:10px">
        <label class="field" style="margin:0;flex:1;min-width:200px"><span>仓库</span>
          <select id="stockWarehouseId"><option value="">（加载中…）</option></select>
        </label>
        <label class="field" style="margin:0;flex:1;min-width:200px"><span>搜索</span>
          <input type="search" id="stockSearch" placeholder="SKU / 名称 / offer_id" />
        </label>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="muted" style="font-size:11px">批量填</span>
          <input type="text" id="stockBatchVal" placeholder="如 +5 或 10" style="width:90px;padding:4px 8px;font-size:12px" />
          <button class="button small" id="stockBatchApply">应用</button>
        </div>
        <button class="button" id="stockSelectAll">全选</button>
        <button class="button" id="stockSelectNone">全不选</button>
      </div>
      <div class="table-wrap" style="max-height:520px"><table>
        <thead><tr>
          <th style="width:28px"><input type="checkbox" id="stockAll" /></th>
          <th style="min-width:260px">商品</th>
          <th style="width:140px">仓库</th>
          <th style="width:95px">Ozon 库存</th>
          <th style="width:110px">变更值</th>
          <th style="width:95px">提交后</th>
        </tr></thead>
        <tbody id="stockBody"><tr><td colspan="6" class="empty">加载中…</td></tr></tbody>
      </table></div>
      <div class="filter-bar" style="justify-content:space-between;margin-top:10px">
        <span class="muted" id="stockSelectedMeta">已选 0 / 0</span>
        <button class="button primary" id="stockSubmit">⚡ 批量提交到 Ozon</button>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Ozon 返回</h2></div>
      <pre id="stockResponse" class="response-area">提交后这里会显示 Ozon 的返回。</pre>
    </div>`;
  initStockHandlers();
  loadStockProducts();
}

function initStockHandlers() {
  $("#stockRefresh")?.addEventListener("click", () => loadStockProducts());
  $("#stockSearch")?.addEventListener("input", () => filterStockRows());
  $("#stockThreshold")?.addEventListener("change", () => filterStockRows());
  $("#stockSelectAll")?.addEventListener("click", () => { $$("#stockBody input[type=checkbox]").forEach((c) => c.checked = true); updateStockStats(); });
  $("#stockSelectNone")?.addEventListener("click", () => { $$("#stockBody input[type=checkbox]").forEach((c) => c.checked = false); updateStockStats(); });
  $("#stockAll")?.addEventListener("change", (e) => { $$("#stockBody input[type=checkbox]").forEach((c) => c.checked = e.target.checked); updateStockStats(); });
  $("#stockSubmit")?.addEventListener("click", submitStock);
  $("#stockBatchApply")?.addEventListener("click", applyBatchStock);
}

async function loadStockProducts() {
  const body = $("#stockBody");
  if (body) body.innerHTML = `<tr><td colspan="6" class="empty"><span class="spinner"></span> 加载商品（含实时库存）…</td></tr>`;
  try {
    const [data, whData] = await Promise.all([
      postJson("/api/seller/products", { limit: 200, withDetail: true }),
      getJson("/api/seller/warehouses").catch(() => ({ data: { result: [] } })),
    ]);
    const items = (data.data?.result?.items || data.data?.items || []).filter((it) => !it.archived);
    state._stockItems = items;
    const whItems = whData.data?.result || [];
    const whSel = $("#stockWarehouseId");
    if (whSel) {
      whSel.innerHTML = whItems.length
        ? whItems.map((w) => `<option value="${escapeAttr(w.warehouse_id)}">${escapeHtml(w.name)} (#${escapeHtml(String(w.warehouse_id))})</option>`).join("")
        : `<option value="">(未获取到仓库，将在提交时使用默认仓库)</option>`;
    }
    renderStockRows(items);
    updateStockStats();
  } catch (e) {
    if (body) body.innerHTML = `<tr><td colspan="6" class="empty">加载失败：${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderStockRows(items) {
  const body = $("#stockBody");
  if (!body) return;
  if (!items.length) { body.innerHTML = `<tr><td colspan="6" class="empty">店铺里还没有商品</td></tr>`; return; }
  const whId = Number($("#stockWarehouseId")?.value) || 0;

  body.innerHTML = items.map((it, i) => {
    const img = it.image
      ? `<img src="${escapeAttr(it.image)}" style="width:44px;height:44px;object-fit:cover;border-radius:4px;background:#f4f4f4;flex-shrink:0" loading="lazy" onerror="this.style.opacity=0.2">`
      : `<div style="width:44px;height:44px;background:#f4f4f4;border-radius:4px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:16px;color:#bbb">📦</div>`;
    const fbo = it.stock_fbo_present ?? null;
    const fbs = it.stock_fbs_present ?? null;
    const currentStock = (fbs !== null ? fbs : fbo);
    const stockDisplay = currentStock !== null ? String(currentStock) : "—";

    return `<tr data-offer-id="${escapeAttr(it.offer_id || '')}" data-product-id="${escapeAttr(it.product_id || '')}" data-name="${escapeAttr(it.name || '')}" data-stock="${currentStock !== null ? currentStock : ''}">
      <td><input type="checkbox" data-row="${i}" /></td>
      <td>
        <div style="display:flex;gap:8px;align-items:center">
          ${img}
          <div style="min-width:0;flex:1">
            <div style="font-size:12.5px;line-height:1.3;color:#333">${escapeHtml(it.name || it.offer_id || "—")}</div>
            <div style="font-size:10.5px;color:#999;margin-top:2px">SKU: ${escapeHtml(it.offer_id || "—")} · FBS:${fbs !== null ? fbs : "—"} FBO:${fbo !== null ? fbo : "—"}</div>
          </div>
        </div>
      </td>
      <td class="muted" style="font-size:11px">${whId ? `仓库 #${whId}` : "—"}</td>
      <td style="font-weight:600;font-size:13px;text-align:center">${stockDisplay}</td>
      <td><input type="text" value="" data-field="diff" data-row="${i}" placeholder="+5 / -2" style="width:90px;padding:4px 8px;font-size:12px;text-align:center" /></td>
      <td style="text-align:center;font-size:12px;color:#999" class="stock-preview" data-row="${i}">—</td>
    </tr>`;
  }).join("");

  // 绑定事件
  $$("#stockBody input[type=checkbox]").forEach((c) => c.addEventListener("change", updateStockStats));
  $$("#stockBody input[data-field=diff]").forEach((inp) => {
    inp.addEventListener("input", () => {
      // 更新预览
      const row = Number(inp.dataset.row);
      const tr = document.querySelector(`#stockBody .stock-preview[data-row="${row}"]`);
      if (tr) {
        const currentRaw = items[row] ? (items[row].stock_fbs_present ?? items[row].stock_fbo_present) : 0;
        const current = Number(currentRaw) || 0;
        const diff = parseDiff(inp.value);
        tr.textContent = diff !== null ? String(Math.max(0, current + diff)) : "—";
        tr.style.color = diff !== null && current + diff <= 5 ? "#c0392b" : "#999";
      }
      updateStockStats();
    });
  });
}

function parseDiff(raw) {
  if (!raw || !raw.trim()) return null;
  let v = raw.trim();
  // 支持 +N -N 或纯数字
  if (v.startsWith("+")) v = v.slice(1);
  else if (v.startsWith("增") || v.startsWith("加")) v = v.slice(1);
  else if (v.startsWith("减")) v = "-" + v.slice(1);
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function applyBatchStock() {
  const val = ($("#stockBatchVal")?.value || "").trim();
  if (!val) return;
  $$("#stockBody input[type=checkbox]").forEach((c) => {
    if (!c.checked) return;
    const row = Number(c.dataset.row);
    const inp = document.querySelector(`#stockBody input[data-field=diff][data-row="${row}"]`);
    if (inp) { inp.value = val; inp.dispatchEvent(new Event("input")); }
  });
  toast(`已批量填入「${val}」到所有勾选行`, "success");
}

function filterStockRows() {
  const q = ($("#stockSearch")?.value || "").toLowerCase().trim();
  const threshold = Number($("#stockThreshold")?.value || 5);
  $$("#stockBody tr").forEach((tr) => {
    const sku = (tr.getAttribute("data-offer-id") || "").toLowerCase();
    const name = (tr.getAttribute("data-name") || "").toLowerCase();
    const stock = Number(tr.getAttribute("data-stock"));
    const matchSearch = !q || sku.includes(q) || name.includes(q);
    const matchThreshold = !threshold || stock <= threshold;
    tr.style.display = matchSearch ? "" : "none";
  });
  updateStockStats();
}

function updateStockStats() {
  const all = $$("#stockBody input[type=checkbox]");
  const checked = all.filter((c) => c.checked);
  const meta = $("#stockSelectedMeta");
  if (meta) meta.textContent = `已选 ${checked.length} / ${all.length}`;

  const threshold = Number($("#stockThreshold")?.value || 5);
  let total = 0, out = 0, low = 0, pending = 0;
  all.forEach((c) => {
    const tr = c.closest("tr");
    if (!tr || tr.style.display === "none") return;
    total++;
    const stock = Number(tr.getAttribute("data-stock"));
    if (stock === 0) out++;
    else if (stock <= threshold) low++;
    const inp = tr.querySelector("input[data-field=diff]");
    if (inp && inp.value.trim()) pending++;
  });

  const set = (id, v) => { const el = $(id); if (el) el.textContent = String(v); };
  set("#stockTotal", total);
  set("#stockOut", out);
  set("#stockLow", low);
  set("#stockPending", pending);

  // 行高亮
  $$("#stockBody tr").forEach((tr) => {
    const stock = Number(tr.getAttribute("data-stock"));
    const inp = tr.querySelector("input[data-field=diff]");
    const dirty = inp && inp.value.trim();
    if (dirty) tr.style.background = "#fff8e1";
    else if (stock === 0) tr.style.background = "#fff0f0";
    else if (stock <= threshold) tr.style.background = "#fffbe6";
    else tr.style.background = "";
  });
}

async function submitStock() {
  const wh = Number($("#stockWarehouseId")?.value);
  if (!wh) { toast("请先选择仓库", "error"); return; }
  const rows = $$("#stockBody tr");
  const stocks = [];
  rows.forEach((tr) => {
    const cb = tr.querySelector("input[type=checkbox]");
    if (!cb || !cb.checked) return;
    const diffInp = tr.querySelector("input[data-field=diff]");
    const diff = parseDiff(diffInp?.value || "");
    if (diff === null) return;
    const current = Number(tr.getAttribute("data-stock")) || 0;
    const newStock = Math.max(0, current + diff);
    const offerId = tr.getAttribute("data-offer-id") || "";
    const productId = tr.getAttribute("data-product-id") || "";
    if (offerId || productId) {
      stocks.push({
        ...(offerId ? { offer_id: offerId } : {}),
        ...(productId ? { product_id: Number(productId) } : {}),
        stock: newStock,
        warehouse_id: wh,
      });
    }
  });
  if (!stocks.length) { toast("没有勾选需要更新的商品，或未填写变更值", "error"); return; }
  const resp = $("#stockResponse");
  if (resp) resp.textContent = "提交中…";
  try {
    const data = await postJson("/api/seller/products/stocks", { stocks });
    if (resp) resp.textContent = JSON.stringify(data, null, 2);
    toast(`已提交 ${stocks.length} 个商品库存更新`, "success");
    // 清空已提交的变更值
    rows.forEach((tr) => {
      const cb = tr.querySelector("input[type=checkbox]");
      if (!cb || !cb.checked) return;
      const inp = tr.querySelector("input[data-field=diff]");
      if (inp) { inp.value = ""; inp.dispatchEvent(new Event("input")); }
    });
    updateStockStats();
  } catch (e) {
    if (resp) resp.textContent = e.message;
    toast("提交失败：" + e.message, "error");
  }
}

/* ============== AI 商品套图 (语义化版本 v1.0.2) ==================== */

function renderProductImages(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>AI 商品套图 <span class="badge green">万相 2.7</span></h2>
        <span class="meta" id="imgStatusV2">MY 币: 400 · 预计消耗 400</span>
        <button class="button small" id="aiHistoryBtn">⏱ 生成记录</button>
      </div>
      <p class="muted">上传商品图，AI 即刻生成符合 Ozon 规范的高转化率商品套图。预览版按生成张数计费展示，真实扣费稍后接入。</p>
    </div>
    <div class="ai-set-layout">
      <div class="card">
        <div class="card-head"><h2>📷 商品原图</h2><span class="meta">单张 ≤ 10MB · jpg/png</span></div>
        <div class="upload-area large-upload" id="uploadMatV2">
          <div class="upload-icon">↑</div>
          <strong>点击、拖拽，或 Ctrl/⌘+V 粘贴图片</strong>
          <span class="muted">推荐白底或纯净背景的主体清晰图</span>
        </div>
        <input type="file" id="fileMatV2" accept="image/*" style="display:none" />
        <div id="previewMatV2" class="material-grid" style="margin-top:10px"></div>

        <div class="card-head" style="margin-top:16px"><h2>✨ 生成设置</h2></div>
        <div class="row">
          <label class="field"><span>生成模型</span>
            <select id="modelV2"><option value="wanx-high">万相 2.7 · 高质量</option><option value="wanx-fast">万相 2.7 · 快速</option></select>
          </label>
          <label class="field"><span>平台</span>
            <select id="platformV2"><option>OZON</option></select>
          </label>
        </div>
        <div class="row">
          <label class="field"><span>语言</span>
            <select id="langV2"><option value="ru" selected>俄语</option><option value="zh">中文</option><option value="en">英语</option></select>
          </label>
          <label class="field"><span>比例</span>
            <select id="ratioV2"><option value="3:4" selected>3:4</option><option value="1:1">1:1</option><option value="4:5">4:5</option></select>
          </label>
        </div>
        <label class="field"><span>💡 商品卖点 & 要求</span>
          <textarea id="aiNameV2" placeholder="请输入商品卖点或场景要求。可以只写中文标题，点击 AI 帮写自动补全。" style="min-height:110px">${escapeHtml(state._lastProductName || "")}</textarea>
        </label>
        <div style="display:flex;gap:8px">
          <button class="button" id="btnAnalyzeV2" style="flex:1">✨ AI 帮写</button>
          <button class="button primary" id="btnGenV2" style="flex:1;font-weight:700">🚀 一键生成爆款套图</button>
        </div>
        <div id="resAnalyzeV2" class="analysis-box" style="display:none">
          <div class="analysis-item"><span class="label">AI 帮写结果</span><div class="text-value" id="resPointsV2"></div></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2>👁 套图预览</h2><span class="meta" id="metaV2">未生成</span><button class="button small" id="btnDownloadAllV2">↓ 下载全部</button></div>
        <div id="gridV2" class="ai-preview-grid">
          <div class="empty" style="grid-column:1 / -1">上传商品图并点击「一键生成爆款套图」。AI 将自动套用电商模板、渲染本地化卖点文案，输出可直接上架的商品图。</div>
        </div>
        <div id="footV2" style="margin-top:16px; display:none">
          <button class="button primary" id="btnPushV2" style="width:100%">一键送入上架</button>
        </div>
      </div>
    </div>
  `;

  bindHandlersV2();
}

function bindHandlersV2() {
  const btnAn = $("#btnAnalyzeV2"), btnGen = $("#btnGenV2");

  btnAn?.addEventListener("click", async () => {
    const name = $("#aiNameV2").value.trim();
    if (!name) return toast("请输入标题或卖点", "error");
    btnAn.disabled = true; btnAn.textContent = "分析中...";
    try {
      const res = await postJson("/api/seller/products/analyze", { name });
      state._productAnalysis = res.data;
      state._lastProductName = name;
      $("#resAnalyzeV2").style.display = "block";
      $("#resPointsV2").innerHTML = res.data.selling_points_ru.map(p => `• ${p}`).join("<br>");
      $("#aiNameV2").value = `产品名：${res.data.title_ru || name}\n核心卖点：${res.data.selling_points_ru.join("；")}\n适用人群：Ozon 买家\n期望场景：高转化电商主图与信息图`;
      toast("AI 帮写完成", "success");
    } catch (e) { toast(e.message, "error"); }
    finally { btnAn.disabled = false; btnAn.textContent = "✨ AI 帮写"; }
  });

  btnGen?.addEventListener("click", async () => {
    if (!state._productMaterials?.length) return toast("请上传素材", "error");
    if (!confirm("即将生成 8 张套图，预计消耗 400 MY 币。继续吗？")) return;
    btnGen.disabled = true; $("#imgStatusV2").textContent = "生成中...";
    try {
      const prompt = buildAiSetPrompt();
      $("#gridV2").innerHTML = `<div class="empty" style="grid-column:1 / -1"><span class="spinner"></span> 生成中，先出的图片会先显示...</div>`;
      const batches = [4, 4];
      const images = [];
      for (const n of batches) {
        const res = await postJson("/api/seller/images/wanx-edit", {
          prompt,
          image: state._productMaterials[0],
          n,
          scenePreset: "product-image-set",
        });
        images.push(...(res.data.images || []));
        renderAiSetImages(images);
      }
      state._generatedPreviewSet = images.slice(0, 8);
      renderAiSetImages(state._generatedPreviewSet);
      $("#footV2").style.display = "block";
      $("#metaV2").textContent = `${state._generatedPreviewSet.length} 张已就绪`;
      toast("生成完成", "success");
    } catch (e) { toast(e.message, "error"); }
    finally { btnGen.disabled = false; $("#imgStatusV2").textContent = "就绪"; }
  });

  const materialArea = $("#uploadMatV2");
  materialArea?.addEventListener("click", () => $("#fileMatV2").click());

  // 补齐：粘贴图片支持
  window.addEventListener("paste", (e) => {
    // 仅在 AI 套图页面且焦点或鼠标在上传区附近时响应
    if (!["products/images", "ai-tools/product-image-set"].includes(getCurrentRoute())) return;
    const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items || [];
    for (const it of items) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const r = new FileReader();
        r.onload = () => {
          if(!state._productMaterials) state._productMaterials=[];
          state._productMaterials = [r.result];
          refreshMatsV2();
          toast("已粘贴图片", "success");
        };
        r.readAsDataURL(it.getAsFile());
      }
    }
  });

  // 补齐：拖拽支持
  materialArea?.addEventListener("dragover", (e) => { e.preventDefault(); materialArea.style.borderColor = "var(--accent)"; });
  materialArea?.addEventListener("dragleave", () => { materialArea.style.borderColor = ""; });
  materialArea?.addEventListener("drop", (e) => {
    e.preventDefault(); materialArea.style.borderColor = "";
    Array.from(e.dataTransfer.files).forEach(f => {
      const r = new FileReader();
      r.onload = () => { state._productMaterials=[r.result]; refreshMatsV2(); };
      r.readAsDataURL(f);
    });
  });

  $("#fileMatV2")?.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) return toast("图片不能超过 10MB", "error");
    const r = new FileReader();
    r.onload = () => { state._productMaterials=[r.result]; refreshMatsV2(); };
    r.readAsDataURL(f);
  });

  $("#btnPushV2")?.addEventListener("click", () => {
    state._pendingUploadData = { title: $("#aiNameV2").value, images: state._generatedPreviewSet };
    navigate("products/upload");
    toast("已送入上架页", "success");
  });
  $("#btnDownloadAllV2")?.addEventListener("click", () => {
    const urls = state._generatedPreviewSet || [];
    if (!urls.length) return toast("还没有可下载的图片", "error");
    urls.forEach((url, i) => {
      const a = document.createElement("a");
      a.href = url;
      a.download = `ai-product-set-${i + 1}.png`;
      a.target = "_blank";
      a.click();
    });
  });

  if (state._productMaterials?.length) refreshMatsV2();
}

function buildAiSetPrompt() {
  const text = $("#aiNameV2")?.value || "";
  const lang = $("#langV2")?.value || "ru";
  const ratio = $("#ratioV2")?.value || "3:4";
  const languageInstruction = lang === "ru" ? "Use bold Russian headlines and Russian selling point text only." : lang === "zh" ? "Use Chinese text only." : "Use English text only.";
  return [
    "Create high-conversion ecommerce product image set for OZON.",
    `Aspect ratio ${ratio}.`,
    languageInstruction,
    "Clean product cutout, premium marketplace template, localized benefit labels, no watermark, no Chinese unless requested.",
    text,
  ].join(" ");
}

function renderAiSetImages(images) {
  const grid = $("#gridV2");
  if (!grid) return;
  grid.innerHTML = images.map((url, i) => `
    <div class="ai-preview-card">
      <img src="${escapeAttr(url)}" onclick="window.open('${escapeAttr(url)}','_blank')" style="cursor:zoom-in" />
      <div class="ai-preview-actions">
        <button class="button small" onclick="navigator.clipboard.writeText('${escapeAttr(url)}')">↓</button>
        <button class="button small" data-push-img="${escapeAttr(url)}">推送</button>
        <button class="button small quiet">重生</button>
      </div>
      <div class="muted" style="margin-top:4px;text-align:center">图 ${i + 1}</div>
    </div>`).join("");
}

function refreshMatsV2() {
  const g = $("#previewMatV2");
  if (!g || !state._productMaterials) return;
  g.innerHTML = state._productMaterials.map((src, i) => `<div class="material-item"><img src="${escapeAttr(src)}" /></div>`).join("");
}

function renderPreviewGrid() { /* 已废弃，合并入 bindHandlersV2 */ }
function bindWorkflowHandlers() { /* 已废弃 */ }
function bindWorkflowHandlersV2() { /* 已废弃 */ }

function renderAiToolsLanding(root) {
  root.innerHTML = `
    <div class="stats-grid">
      <a class="stat-card accent" href="#/ai-tools/product-image-set"><div class="label">AI 商品套图</div><div class="value">8 图</div><div class="delta">单张原图生成整套 Ozon 图</div></a>
      <a class="stat-card" href="#/ai-tools/image-editor"><div class="label">AI 改图神器</div><div class="value">10 张</div><div class="delta">去水印 / 换背景 / 加俄语标签</div></a>
      <a class="stat-card" href="#/ai-tools/prompt-generator"><div class="label">提示词生成</div><div class="value">中→俄</div><div class="delta">1688 卖点提取与俄语标题</div></a>
    </div>`;
}

function renderImageEditor(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>AI 改图神器</h2><span class="meta">批量图像优化 · 预览版</span></div>
      <div class="row">
        <label class="field"><span>商品名（可选）</span><input id="ieName" placeholder="商品名 / 类目" /></label>
        <label class="field"><span>处理目标</span><select id="ieGoal"><option>去水印</option><option>换背景</option><option>加俄语标签</option><option>提升质感</option></select></label>
      </div>
      <div class="upload-area large-upload"><strong>上传或粘贴图片</strong><span class="muted">下一步会复用 AI 商品套图的素材处理模块</span></div>
    </div>
    <div class="card"><div class="card-head"><h2>原图 vs 改图</h2></div><div class="empty">改图生成结果将在这里左右对比展示。</div></div>`;
}

function renderPromptGenerator(root) {
  root.innerHTML = `
    <div class="ai-set-layout">
      <div class="card">
        <div class="card-head"><h2>输入</h2></div>
        <label class="field"><span>1688 URL</span><input id="pgUrl" placeholder="https://detail.1688.com/offer/..." /></label>
        <label class="field"><span>中文标题</span><input id="pgTitle" placeholder="粘贴 1688 中文标题" /></label>
        <label class="field"><span>中文详情</span><textarea id="pgDetail" placeholder="粘贴详情、规格、卖点"></textarea></label>
        <button class="button primary" id="pgRun">生成俄语标题与 Prompt</button>
      </div>
      <div class="card">
        <div class="card-head"><h2>输出</h2><span class="meta">卖点 / 俄语标题 / 图像 Prompt</span></div>
        <div id="pgOut" class="response-area">等待输入...</div>
        <div style="display:flex;gap:8px;margin-top:10px"><button class="button" id="pgCopy">复制</button><button class="button primary" id="pgToImage">送至 AI 商品套图</button></div>
      </div>
    </div>`;
  $("#pgRun")?.addEventListener("click", () => {
    const title = $("#pgTitle")?.value || "";
    const detail = $("#pgDetail")?.value || "";
    const out = [
      "卖点提取：",
      "• 便携实用",
      "• 适合 Ozon 买家日常使用",
      "• 价格带适合做组合销售",
      "",
      "俄语商品标题：",
      `Практичный товар для дома ${title ? "- " + title.slice(0, 40) : ""}`,
      "",
      "图像生成 Prompt：",
      `Professional OZON ecommerce product image, clean background, Russian bold headline, selling points based on: ${title} ${detail}`.slice(0, 800),
    ].join("\n");
    $("#pgOut").textContent = out;
  });
  $("#pgCopy")?.addEventListener("click", async () => { await navigator.clipboard.writeText($("#pgOut")?.textContent || ""); toast("已复制", "success"); });
  $("#pgToImage")?.addEventListener("click", () => { state._lastProductName = $("#pgOut")?.textContent || ""; navigate("ai-tools/product-image-set"); });
}

function renderProductRelist(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>下架重上</h2><span class="meta">从已归档商品复制字段生成新采集草稿</span><button class="button small" id="relistLoad">加载已归档</button></div>
      <div class="table-wrap"><table><thead><tr><th>商品</th><th>offer_id</th><th>状态</th><th>操作</th></tr></thead><tbody id="relistBody"><tr><td colspan="4" class="empty">点击加载已归档商品</td></tr></tbody></table></div>
    </div>`;
  $("#relistLoad")?.addEventListener("click", async () => {
    const body = $("#relistBody");
    body.innerHTML = `<tr><td colspan="4" class="empty"><span class="spinner"></span> 加载中...</td></tr>`;
    try {
      const data = await postJson("/api/seller/products", { visibility: "ALL", archived: true, limit: 100, withDetail: true, store_id: state.currentStoreId || "" });
      const items = (data.data?.result?.items || []).filter((it) => it.archived);
      if (!items.length) { body.innerHTML = `<tr><td colspan="4" class="empty">暂无已归档商品</td></tr>`; return; }
      body.innerHTML = items.map((it) => `<tr><td class="wrap">${escapeHtml(it.name || it.offer_id)}</td><td>${escapeHtml(it.offer_id)}</td><td><span class="badge gray">已归档</span></td><td><button class="button small">复制为草稿</button></td></tr>`).join("");
    } catch (error) {
      body.innerHTML = `<tr><td colspan="4" class="empty">加载失败：${escapeHtml(error.message)}</td></tr>`;
    }
  });
}

/* ============== 订单列表 ==================== */

async function renderOrderList(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>订单</h2>
        <span class="meta" style="margin-left:12px;font-size:11px">汇率 1₽ ≈ ¥${RUB_CNY_RATE.toFixed(4)}</span>
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
        <thead><tr>
          <th style="width:40px"></th>
          <th style="min-width:140px">货件号</th>
          <th style="width:85px">状态</th>
          <th class="wrap" style="min-width:220px">商品</th>
          <th style="width:100px">价格</th>
          <th style="width:80px">仓库</th>
          <th style="width:85px">配送</th>
          <th style="width:100px">时间</th>
          <th style="min-width:130px">本地备注</th>
          <th style="width:50px"></th>
        </tr></thead>
        <tbody id="orderBody"><tr><td colspan="10" class="empty">加载中…</td></tr></tbody>
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
  $("#orderExport")?.addEventListener("click", () => exportOrdersCsv());
  await loadOrders();
}

async function loadOrders() {
  const limit = Number($("#orderLimit")?.value || 50);
  const status = $("#orderStatus")?.value || "";
  const search = ($("#orderSearch")?.value || "").toLowerCase();
  const body = $("#orderBody");
  const countEl = $("#orderCountValue");
  if (body) body.innerHTML = `<tr><td colspan="10" class="empty"><span class="spinner"></span> 加载中…</td></tr>`;
  try {
    // 并行拉订单 + 商品图映射
    const [data, prodData] = await Promise.all([
      postJson("/api/seller/orders", { limit, status }),
      postJson("/api/seller/products", { limit: 200, withDetail: true }).catch(() => ({ data: { result: { items: [] } } })),
    ]);
    let items = (data.data?.result?.postings || data.data?.items || data.data?.result?.items || []).slice();
    if (search) items = items.filter((it) => (it.order_number || it.posting_number || it.id || "").toLowerCase().includes(search));
    if (countEl) countEl.textContent = String(items.length);
    state._orders = items;

    // 构建 offer_id → {image,...} 映射
    const prodMap = {};
    const prodItems = prodData.data?.result?.items || prodData.data?.items || [];
    for (const p of prodItems) {
      if (p.offer_id && p.image) prodMap[p.offer_id] = p;
    }

    // 拉取本地备注
    const numbers = items.map((it) => it.posting_number).filter(Boolean).join(",");
    let notesMap = {};
    if (numbers) {
      try {
        const nr = await getJson(`/api/seller/orders/notes?numbers=${encodeURIComponent(numbers)}`);
        notesMap = nr.notes || {};
      } catch (e) { /* 静默降级 */ }
    }

    if (!items.length) { body.innerHTML = `<tr><td colspan="10" class="empty">无订单数据</td></tr>`; return; }

    body.innerHTML = items.slice(0, limit).map((it, idx) => {
      const products = (it.products || []);
      const firstProd = products[0] || {};
      const prodImage = prodMap[firstProd.offer_id || firstProd.sku]?.image || "";
      const productSummary = products.map((p) => {
        const img = prodMap[p.offer_id || p.sku]?.image || "";
        const thumb = img ? `<img src="${escapeAttr(img)}" style="width:22px;height:22px;object-fit:cover;border-radius:3px;vertical-align:middle;margin-right:4px" onerror="this.style.display='none'">` : "";
        return `<div style="display:flex;align-items:center;gap:6px;padding:2px 0">${thumb}<span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(p.name || p.sku || p.offer_id || "—")} <b>×${p.quantity || 1}</b></span></div>`;
      }).join("");

      const dm = it.delivery_method || {};
      const dmName = dm.name || "—";
      const wh = it.warehouse || it.warehouse_name || (dm.warehouse_id ? "仓库#" + dm.warehouse_id : "—");
      const rubPrice = it.financial_data?.total_price || it.financial_data?.posting_services?.total_price || it.total_price || "—";
      const cnyPrice = rubToCny(rubPrice);
      const priceHtml = cnyPrice != null
        ? `<div style="font-weight:600;color:#c0392b">¥${cnyPrice.toFixed(2)}</div><div style="font-size:10px;color:#999">₽${escapeHtml(String(rubPrice))}</div>`
        : `<div>₽${escapeHtml(String(rubPrice))}</div>`;

      const pn = it.posting_number || it.order_number || "";
      const note = notesMap[pn]?.note || "";
      const thumbImg = prodImage
        ? `<img src="${escapeAttr(prodImage)}" style="width:32px;height:32px;object-fit:cover;border-radius:4px" onerror="this.style.opacity=0.2">`
        : `<div style="width:32px;height:32px;background:#f4f4f4;border-radius:4px;font-size:14px;display:flex;align-items:center;justify-content:center;color:#bbb">📦</div>`;

      return `<tr data-idx="${idx}" class="order-row" style="cursor:pointer">
        <td>${thumbImg}</td>
        <td class="muted" style="font-size:11.5px">${escapeHtml(pn || "—")}</td>
        <td>${statusBadge(it.status)}</td>
        <td class="wrap" style="max-width:320px;font-size:11.5px">${productSummary}</td>
        <td>${priceHtml}</td>
        <td class="muted" style="font-size:11px">${escapeHtml(wh)}</td>
        <td class="muted" style="font-size:11px">${escapeHtml(dmName)}</td>
        <td class="muted" style="font-size:11px">${escapeHtml(formatTime(it.in_process_at || it.created_at || it.shipment_date))}</td>
        <td>
          <input type="text" class="order-note-input" data-note-pn="${escapeAttr(pn)}" value="${escapeAttr(note)}"
                 placeholder="双击编辑…" style="width:100%;padding:4px 6px;font-size:11px;border:1px solid var(--border);border-radius:4px;background:transparent"
                 title="回车保存" />
        </td>
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
    // 备注：回车 or 失焦 保存
    $$("#orderBody .order-note-input").forEach((input) => {
      const save = async () => {
        const pn = input.getAttribute("data-note-pn");
        if (!pn) return;
        try {
          await postJson(`/api/seller/orders/${encodeURIComponent(pn)}/note`, { note: input.value });
          input.style.borderColor = "var(--green, #4c8f3d)";
          setTimeout(() => { input.style.borderColor = "var(--border)"; }, 800);
        } catch (e) { toast("备注保存失败：" + e.message, "error"); }
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
      input.addEventListener("blur", () => {
        // 只在有变化时保存
        if (input.dataset.dirty === "1") save();
      });
      input.addEventListener("input", () => { input.dataset.dirty = "1"; });
      input.addEventListener("click", (e) => e.stopPropagation());
    });
  } catch (error) {
    if (body) body.innerHTML = `<tr><td colspan="9" class="empty">加载失败：${escapeHtml(error.message)}</td></tr>`;
  }
}

function showOrderDetail(posting) {
  if (!posting) return;
  const dm = posting.delivery_method || {};
  const prods = (posting.products || []).map((p) => {
    const rub = Number(p.price) || 0;
    const cny = rubToCny(rub);
    const cnyStr = cny != null ? ` ≈ ¥${cny.toFixed(2)}` : "";
    return `<tr><td>${escapeHtml(p.name || p.sku || "—")}</td><td>${escapeHtml(p.sku || p.offer_id || "—")}</td><td>${p.quantity || 1}</td><td>₽${escapeHtml(String(p.price || "—"))}${cnyStr}</td></tr>`;
  }).join("");
  const addr = posting.addressee || {};
  const f = posting.financial_data || {};
  const totalRub = Number(f.total_price) || 0;
  const totalCny = rubToCny(totalRub);
  const totalCnyStr = totalCny != null ? ` (¥${totalCny.toFixed(2)})` : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>订单 ${escapeHtml(posting.posting_number || "")}</title>
 <style>
 body { font: 13px -apple-system, sans-serif; padding: 20px; max-width: 720px; margin: 0 auto; }
 h1 { font-size: 16px; margin: 0 0 12px; }
 h2 { font-size: 13px; margin: 0 0 8px; }
 .row { display: grid; grid-template-columns: 130px 1fr; gap: 6px 12px; margin-bottom: 8px; }
 .k { color: #666; }
 table { width: 100%; border-collapse: collapse; margin-top: 10px; }
 th, td { padding: 6px 8px; border-bottom: 1px solid #e3e6e1; text-align: left; font-size: 12px; }
 th { background: #f6f7f5; }
 .section { background: #fff; border: 1px solid #e3e6e1; border-radius: 6px; padding: 12px; margin-bottom: 12px; }
 </style></head><body>
 <h1>订单详情 · ${escapeHtml(posting.posting_number || posting.order_number || "")}</h1>
 <div class="section">
   <div class="row"><span class="k">状态</span><span>${escapeHtml(posting.status || "—")}</span></div>
   <div class="row"><span class="k">店铺</span><span>${escapeHtml(posting.cluster_name || "—")}</span></div>
   <div class="row"><span class="k">仓库</span><span>${escapeHtml(posting.warehouse || (dm.warehouse_id ? "仓库#" + dm.warehouse_id : "—"))}</span></div>
   <div class="row"><span class="k">配送方式</span><span>${escapeHtml(dm.name || "—")} (tpl_provider: ${escapeHtml(dm.tpl_provider || "—")})</span></div>
   <div class="row"><span class="k">追踪号</span><span>${escapeHtml(posting.tracking_number || "—")}</span></div>
   <div class="row"><span class="k">时间</span><span>${escapeHtml(posting.in_process_at || "—")}</span></div>
 </div>
 <div class="section"><h2>商品</h2>
   <table><thead><tr><th>名称</th><th>SKU</th><th>数量</th><th>价格</th></tr></thead><tbody>${prods || '<tr><td colspan="4">无</td></tr>'}</tbody></table>
 </div>
 ${addr.name ? `<div class="section"><h2>收件人</h2>
   <div class="row"><span class="k">姓名</span><span>${escapeHtml(addr.name || "")}</span></div>
   <div class="row"><span class="k">电话</span><span>${escapeHtml(addr.phone || "")}</span></div>
   <div class="row"><span class="k">地址</span><span>${escapeHtml(addr.address || "")}</span></div>
 </div>` : ''}
 ${Object.keys(f).length ? `<div class="section"><h2>财务</h2>
   <div class="row"><span class="k">总价</span><span>₽${escapeHtml(String(totalRub || "—"))}${totalCnyStr}</span></div>
   <div class="row"><span class="k">佣金</span><span>₽${escapeHtml(String(f.commission_amount || "—"))}</span></div>
   <div class="row"><span class="k">物流</span><span>₽${escapeHtml(String(f.delivery_price || "—"))}</span></div>
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
      <p class="muted">安装 Chrome/Edge 采集插件后登录账号，并在插件里开启“领取 ERP 采集任务”。插件在线后，本页面会显示电脑名、系统和当前任务状态。</p>
      <p class="muted">安装方式：下载 zip 后先解压，不要直接拖 zip 到 Chrome。打开 <code>chrome://extensions/</code>，开启开发者模式，点击“加载已解压的扩展程序”，选择解压后包含 <code>manifest.json</code> 的文件夹。</p>
      <div style="display:flex;gap:8px;margin-top:8px">
        <a class="button" href="/downloads/ozon-1688-collector-extension.zip" download>下载采集插件（先解压）</a>
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
    loadWorkerStatus("tools").catch(() => {});
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
        <thead><tr><th style="min-width:140px">任务</th><th>状态</th><th>进度</th><th>时间</th><th>操作</th><th>下载</th></tr></thead>
        <tbody id="historyBody"><tr><td colspan="6" class="empty">加载中…</td></tr></tbody>
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
    if (!items.length) { body.innerHTML = `<tr><td colspan="6" class="empty">还没有历史任务</td></tr>`; return; }
    body.innerHTML = items.slice(0, 50).map((it) => `
      <tr>
        <td class="wrap"><div>${escapeHtml(it.kind === "batch-ozon" ? "批量采集" : "单品找货")}</div><span class="muted">${escapeHtml((it.id || "").slice(0, 8))}</span></td>
        <td>${statusBadge(it.status)}${it.phase ? `<div class="muted">${escapeHtml(it.phase)}</div>` : ""}</td>
        <td>${it.processed || 0} / ${it.total || 0}</td>
        <td><span class="muted">${escapeHtml(formatTime(it.updatedAt))}</span></td>
        <td>${renderHistoryActions(it)}</td>
        <td>${it.downloadUrl ? `<a class="button small" href="${escapeAttr(it.downloadUrl)}">下载 Excel</a>` : ""}</td>
      </tr>`).join("");
    body.querySelectorAll("[data-job-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = btn.dataset.jobAction;
        const id = btn.dataset.jobId;
        btn.disabled = true;
        await actOnCurrentJob(action, id);
      });
    });
  } catch (e) { toast(e.message, "error"); }
}

function renderHistoryActions(it) {
  const active = ["queued", "claimed", "running"].includes(it.status);
  const paused = it.status === "paused";
  const terminal = ["done", "error", "canceled"].includes(it.status);
  const id = escapeAttr(it.id || "");
  const parts = [];
  if (active) parts.push(`<button class="button small" data-job-action="pause" data-job-id="${id}">暂停</button>`);
  if (paused) parts.push(`<button class="button small" data-job-action="resume" data-job-id="${id}">继续</button>`);
  if (!terminal) parts.push(`<button class="button small" data-job-action="finish" data-job-id="${id}">结束并导出</button>`);
  if (active || paused) parts.push(`<button class="button small danger" data-job-action="cancel" data-job-id="${id}">停止</button>`);
  return parts.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap">${parts.join("")}</div>` : "";
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

/* ============== 上架记录 ==================== */

async function renderListingHistory(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>上架记录</h2>
        <span class="meta" id="lhMeta">加载中…</span>
        <button class="button small" id="lhRefresh" style="margin-left:8px">刷新</button>
      </div>
      <div class="stats-grid">
        <div class="stat-card"><div class="label">累计批次</div><div class="value" id="lhTotal">—</div></div>
        <div class="stat-card"><div class="label">成功</div><div class="value" id="lhSuccess">—</div></div>
        <div class="stat-card"><div class="label">处理中</div><div class="value" id="lhProcessing">—</div></div>
        <div class="stat-card accent"><div class="label">成功率</div><div class="value" id="lhRate">—</div></div>
      </div>
      <div class="filter-bar" style="margin-top:10px">
        <select id="lhStatus">
          <option value="">全部状态</option>
          <option value="processing">处理中</option>
          <option value="imported">已完成</option>
          <option value="failed">失败</option>
        </select>
        <input type="search" id="lhSearch" placeholder="搜索 offer_id / task_id / 商品名" />
        <button class="button" id="lhFilter">筛选</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th style="width:44px"></th>
          <th style="min-width:200px">商品</th>
          <th>task_id</th>
          <th style="width:80px">状态</th>
          <th style="width:100px">价格</th>
          <th style="width:120px">时间</th>
          <th style="width:80px">操作</th>
        </tr></thead>
        <tbody id="lhBody"><tr><td colspan="7" class="empty">加载中…</td></tr></tbody>
      </table></div>
    </div>`;

  $("#lhRefresh")?.addEventListener("click", () => loadListingHistory());
  $("#lhFilter")?.addEventListener("click", () => loadListingHistory());
  $("#lhStatus")?.addEventListener("change", () => loadListingHistory());
  loadListingHistory();
}

async function loadListingHistory() {
  const body = $("#lhBody"), meta = $("#lhMeta");
  const status = $("#lhStatus")?.value || "";
  const search = ($("#lhSearch")?.value || "").trim();
  if (body) body.innerHTML = `<tr><td colspan="7" class="empty"><span class="spinner"></span></td></tr>`;
  try {
    const params = new URLSearchParams({ limit: "50", offset: "0" });
    if (status) params.set("status", status);
    if (search) params.set("search", search);
    const data = await getJson(`/api/seller/import/history?${params}`);
    const items = data.items || [];
    const total = data.total || 0;
    if (meta) meta.textContent = `共 ${total} 条`;

    const stats = { total: 0, success: 0, processing: 0 };
    try {
      const allData = await getJson(`/api/seller/import/history?limit=1000&offset=0`);
      const allItems = allData.items || [];
      stats.total = allData.total || allItems.length;
      stats.success = allItems.filter((i) => i.status === "imported").length;
      stats.processing = allItems.filter((i) => i.status === "processing").length;
    } catch {}
    $("#lhTotal").textContent = stats.total;
    $("#lhSuccess").textContent = stats.success;
    $("#lhProcessing").textContent = stats.processing;
    $("#lhRate").textContent = stats.total > 0 ? `${Math.round(stats.success / stats.total * 100)}%` : "—";

    if (!items.length) { body.innerHTML = `<tr><td colspan="7" class="empty">暂无上架记录</td></tr>`; return; }

    body.innerHTML = items.map((it, i) => {
      const img = it.main_image
        ? `<img src="${escapeAttr(it.main_image)}" style="width:36px;height:36px;object-fit:cover;border-radius:4px" onerror="this.style.opacity=0.2">`
        : `<div style="width:36px;height:36px;background:#f4f4f4;border-radius:4px;font-size:14px;display:flex;align-items:center;justify-content:center">□</div>`;
      const statusLabel = { processing: "处理中", imported: "已完成", failed: "失败", moderating: "审核中" }[it.status] || it.status;
      const statusCls = it.status === "imported" ? "green" : it.status === "failed" ? "red" : it.status === "processing" ? "amber" : "gray";
      const priceCny = it.price_rub != null ? rubToCny(it.price_rub) : null;
      const priceHtml = priceCny != null ? `¥${priceCny.toFixed(2)}` : "—";
      let errors = [];
      try { errors = Array.isArray(it.errors_json) ? it.errors_json : (typeof it.errors_json === "string" ? JSON.parse(it.errors_json || "[]") : []); } catch {}
      const errSummary = errors.length ? errors.map((e) => e.error || e.message || JSON.stringify(e)).join("；").slice(0, 80) : "";
      return `<tr>
        <td>${img}</td>
        <td>
          <div style="font-size:12.5px">${escapeHtml(it.product_name || it.offer_id || "—")}</div>
          <div style="font-size:10.5px;color:#999">${escapeHtml(it.offer_id || "—")}</div>
          ${errSummary ? `<div style="font-size:10px;color:#c0392b;margin-top:2px">${escapeHtml(errSummary)}</div>` : ""}
        </td>
        <td class="muted" style="font-size:10.5px;font-family:monospace">${escapeHtml((it.task_id || "").slice(0, 16))}</td>
        <td><span class="badge ${statusCls}">${escapeHtml(statusLabel)}</span></td>
        <td>${priceHtml}</td>
        <td class="muted" style="font-size:11px">${escapeHtml(formatTime(it.created_at))}</td>
        <td>
          ${it.status === "processing" ? `<button class="button small" data-sync="${escapeAttr(it.task_id)}">同步</button>` : ""}
          ${it.status === "failed" ? `<button class="button small" data-retry="${i}">重试</button>` : ""}
        </td>
      </tr>`;
    }).join("");

    $$("#lhBody [data-sync]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const taskId = btn.getAttribute("data-sync");
        btn.disabled = true;
        btn.textContent = "同步中…";
        try {
          const r = await postJson("/api/seller/import/sync-task", { taskId });
          toast(`状态: ${r.localStatus}`, r.localStatus === "imported" ? "success" : "info");
          loadListingHistory();
        } catch (err) { toast(err.message, "error"); btn.disabled = false; btn.textContent = "同步"; }
      });
    });

    $$("#lhBody [data-retry]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const idx = Number(btn.getAttribute("data-retry"));
        const rec = items[idx];
        if (!rec?.raw_payload) { toast("无原始数据可重试", "error"); return; }
        const p = typeof rec.raw_payload === "string" ? JSON.parse(rec.raw_payload) : rec.raw_payload;
        state._pendingUploadData = p.item || p;
        navigate("products/upload");
        toast("已填入上架页，修改后重新提交", "success");
      });
    });
  } catch (e) {
    if (body) body.innerHTML = `<tr><td colspan="7" class="empty">加载失败：${escapeHtml(e.message)}</td></tr>`;
  }
}

/* ============== sidebar badges ============== */

/* ============== nav click bindings ============== */

// 侧栏折叠状态：localStorage 记住偏好，key="navCollapsed"，值是 route 数组
const NAV_COLLAPSE_KEY = "navCollapsed";
function getCollapsedNavs() {
  try { return new Set(JSON.parse(localStorage.getItem(NAV_COLLAPSE_KEY) || "[]")); }
  catch { return new Set(); }
}
function setCollapsedNavs(set) {
  try { localStorage.setItem(NAV_COLLAPSE_KEY, JSON.stringify([...set])); } catch { /* quota */ }
}
function toggleNavGroup(route) {
  const el = document.querySelector(`.nav-item[data-route="${route}"]`);
  if (!el) return;
  const subs = document.querySelector(`.nav-subitems[data-parent="${route}"]`);
  if (!subs) return; // 没子菜单，不能折叠
  el.classList.toggle("collapsed");
  const collapsed = getCollapsedNavs();
  if (el.classList.contains("collapsed")) collapsed.add(route);
  else collapsed.delete(route);
  setCollapsedNavs(collapsed);
}

// 初始应用上次的折叠状态
(function applyInitialCollapsed() {
  const collapsed = getCollapsedNavs();
  for (const route of collapsed) {
    const el = document.querySelector(`.nav-item[data-route="${route}"]`);
    if (el && document.querySelector(`.nav-subitems[data-parent="${route}"]`)) el.classList.add("collapsed");
  }
})();

// 给所有"有子菜单"的大组注入折叠箭头
$$(".nav-item").forEach((el) => {
  const route = el.getAttribute("data-route");
  const hasSub = document.querySelector(`.nav-subitems[data-parent="${route}"]`);
  if (!hasSub) return;
  if (el.querySelector(".caret")) return;
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = "▾";
  caret.title = "折叠/展开";
  caret.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleNavGroup(route);
  });
  el.appendChild(caret);
});

$$(".nav-item, .nav-subitem").forEach((el) => {
  el.addEventListener("click", (e) => {
    e.preventDefault();
    const route = el.getAttribute("data-route");
    if (!route) return;
    // 顶级栏目且有子项 → 跳到第一个子项（不再自动展开，因为默认已展开）
    if (el.classList.contains("nav-item")) {
      const firstSub = document.querySelector(`.nav-subitem[data-parent="${route}"]`);
      if (firstSub) {
        // 如果点了折叠状态的大组，先展开再跳
        if (el.classList.contains("collapsed")) toggleNavGroup(route);
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

// 1. 初始化鉴权检查
async function checkAuthAndInit() {
  try {
    const data = await getJson("/api/auth/status");
    if (!data.authenticated) {
      // 修正跳转：不要 location.hash.slice(1)，直接回到根路径由 Hash 处理
      location.href = `/login?next=${encodeURIComponent("/")}`;
      return;
    }
    state.user = data.user;
    elSidebarUser.textContent = data.user.display_name || data.user.username || "已登录";
    elSidebarRole.textContent = data.user.role || "";
    if (data.collectorMode) elSidebarStore.textContent = "服务器队列模式";
    else elSidebarStore.textContent = "单机模式";

    await loadStores();

    // 成功后才渲染路由
    applyRoute();
  } catch (e) {
    console.error("Auth check failed:", e);
    // 如果接口挂了或者 401，跳登录
    if (e.message.includes("401") || e.message.includes("登录")) {
      location.href = "/login";
    }
  }
}

// 2. 注入版本号
fetch("/api/version").then((r) => r.json()).then((v) => {
  const tag = document.getElementById("sidebarVersion");
  if (!tag) return;
  tag.textContent = `v${v.version}`;
  tag.style.cursor = "pointer";
}).catch(() => {});

checkAuthAndInit();

/* ============== 上架辅助 ==================== */

async function loadCategoryDropdown() {
  const sel = $("#sellerCategorySelect");
  if (!sel) return;
  sel.innerHTML = '<option value="">加载中…</option>';
  sel.disabled = true;
  try {
    const data = await postJson("/api/seller/categories/tree", {});
    const items = (data.data?.result || []).slice(0, 200);
    const current = $("#sellerCategoryIdInput")?.value || "";
    sel.innerHTML = '<option value="">— 选择类目 —</option>' +
      items.map((c) => {
        const id = c.description_category_id || c.category_id || c.id || "";
        const name = (c.category_name || c.name || "").slice(0, 40);
        const selected = String(id) === String(current) ? " selected" : "";
        return `<option value="${escapeAttr(id)}"${selected}>${escapeHtml(name)} (#${escapeHtml(String(id))})</option>`;
      }).join("");
    if (current && !items.find((c) => String(c.description_category_id || c.category_id || c.id) === String(current))) {
      sel.innerHTML += `<option value="${escapeAttr(current)}" selected>已选 #${escapeHtml(current)}</option>`;
    }
  } catch (e) {
    sel.innerHTML = '<option value="">加载失败，可手动填 ID</option>';
  }
  sel.disabled = false;
  if ($("#sellerCategoryIdInput")?.value) loadSellerAttributeTemplate().catch(() => {});
}

// 图片预览条
function refreshUploadImagePreview() {
  const strip = $("#sellerImagePreview");
  if (!strip) return;
  const urls = compactUploadImages($("#sellerImagesInput")?.value || "");
  const meta = $("#sellerImageMeta");
  if (meta) meta.textContent = `${urls.length} 张`;
  strip.innerHTML = urls.map((u, i) => `
    <div class="upload-thumb${i === 0 ? " main" : ""}">
      <img src="${escapeAttr(u)}" onerror="this.style.opacity=0.2" title="图 ${i + 1}${i === 0 ? '（主图）' : ''}">
    </div>`).join("");
}
