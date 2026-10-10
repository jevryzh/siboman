/**
 * Ozon 我的商品销售 —— 卖家后台数据面板
 *
 * 原理、接口清单、指标探测结果、踩过的坑，全部记在 DEV-NOTES.md（不随发布包）。
 * 这里刻意不写实现细节：发布出去的是混淆版，源码注释越少越好。
 *
 * 发布流程：node scripts/build-extension-release.mjs
 */
(function () {
  "use strict";
  if (window.__ozonFunnelStandaloneInjected) return;
  window.__ozonFunnelStandaloneInjected = true;

  const VERSION = "1.5.0";
  const HOST_ID = "__ozon_funnel_host";

  const PAGE_SIZE = 50;      // 接口 limit 上限 50
  const INITIAL_PAGES = 8;   // 先快速拉 400 条渲染，剩下的后台补
  const BATCH_PAGES = 12;    // 后台每批 600 条
  // 接口硬限制 offset 必须 < 1000（实测超了直接 HTTP 400），所以这张表最多 1000 行
  const MAX_PAGES = 20;      // 20 × 50 = offset 0..950
  const RENDER_MAX = 400;    // 表格最多渲染这么多行（搜索/导出仍用全量）

  // snake_case 指标名 → 接口返回的 camelCase 字段名
  const respKey = (m) => m.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

  const METRIC_DEFS = {
    // ── 销售 ──
    revenue: { label: "已订购金额(销售价)", fmt: "money" },
    sold_revenue: { label: "已订购金额(最低价)", fmt: "money" },
    ordered_units: { label: "已订购件数", fmt: "int" },
    delivered_units: { label: "已送达件数", fmt: "int" },
    cancelled_units: { label: "取消数量", fmt: "int" },
    returned_units: { label: "退货数量", fmt: "int" },
    avg_price: { label: "平均价格", fmt: "money" },
    avg_sold_price: { label: "平均实付价", fmt: "money" },
    discount_share_of_median_price: { label: "相对中位价折扣", fmt: "pct" },
    // ── 转化 / 销售漏斗 ──
    conv_views_to_order: { label: "访问→下单转化率", fmt: "pct" },
    total_views: { label: "总访问量", fmt: "int" },
    total_hits_to_cart: { label: "总加购次数", fmt: "int" },
    conv_total_views_to_cart: { label: "总访问→加购转化率", fmt: "pct" },
    pdp_views: { label: "商品卡片访问量", fmt: "int" },
    hits_pdp_to_cart: { label: "详情页加购次数", fmt: "int" },
    conv_pdp_views_to_cart: { label: "详情页→加购转化率", fmt: "pct" },
    search_position: { label: "搜索/目录位置", fmt: "num2" },
    search_views: { label: "搜索展示次数", fmt: "int" },
    hits_search_to_cart: { label: "搜索加购次数", fmt: "int" },
    conv_search_views_to_cart: { label: "搜索→加购转化率", fmt: "pct" },
  };

  const GROUPS = {
    overview: {
      label: "数据概览",
      metrics: ["revenue", "sold_revenue", "ordered_units", "delivered_units", "cancelled_units", "returned_units",
        "avg_price", "avg_sold_price", "total_views", "conv_views_to_order", "discount_share_of_median_price"],
    },
    funnel: {
      label: "销售漏斗",
      // 列顺序对齐 Ozon 后台「销售漏斗」标签页
      metrics: ["search_position", "search_views", "pdp_views", "conv_pdp_views_to_cart", "hits_pdp_to_cart",
        "conv_search_views_to_cart", "hits_search_to_cart", "total_views", "conv_total_views_to_cart",
        "total_hits_to_cart", "ordered_units", "revenue", "sold_revenue"],
    },
    all: { label: "全部指标", metrics: Object.keys(METRIC_DEFS) },
  };
  const ALL_METRICS = Object.keys(METRIC_DEFS);

  // 订单（posting）状态别名 —— 接口把合法值直接列在 400 报错里拿到的
  const ORDER_STATUS_ALIASES = ["awaiting_packaging", "awaiting_deliver", "arbitration", "delivering",
    "delivered", "cancelled", "driver_pickup", "not_accepted", "client_arbitration",
    "acceptance_in_progress", "awaiting_registration", "sent_by_seller"];

  const state = {
    open: false, loading: false, loadingMore: false, exhausted: false,
    data: null, totals: null, error: "", ozonClientId: "",
    sortKey: "revenue", sortDir: "desc", maximized: false,
    group: "funnel", days: 7, search: "", showCols: false,
    mode: "sales",     // sales=我的商品销售 / visibility=搜索可见性 / rank=查词排位
    orderStats: null,  // 订单级汇总（取消订单数 / 总订单数）
    sv: { loading: false, data: null, error: "", page: 0, perPage: 50, sortBy: "METRICS_TYPE_UNIQUE_SEARCH_USERS", sortDir: "DESCENDING", search: "", category: "", meta: null },
    rk: { loading: false, data: null, error: "", query: "", uuid: "", onlyMine: false, page: 1, perPage: 36, locations: [], sortKey: "position", sortDir: "asc" },
    colOrder: {},      // { groupKey: [metric,...] } 用户自定义列序
    status: "",
  };

  // ===== 偏好持久化（列序 / 分组 / 天数）=====
  function loadPrefs() {
    try {
      chrome.storage.local.get(["ozfPrefs"], (r) => {
        const p = r && r.ozfPrefs;
        if (!p) return;
        if (p.colOrder && typeof p.colOrder === "object") state.colOrder = p.colOrder;
        if (p.group && GROUPS[p.group]) state.group = p.group;
        if (p.days !== undefined) state.days = p.days;
        if (p.mode && ["sales", "visibility", "rank"].includes(p.mode)) state.mode = p.mode;
        render();
      });
    } catch (_e) { /* 无 storage 权限时静默 */ }
  }
  function savePrefs() {
    try { chrome.storage.local.set({ ozfPrefs: { colOrder: state.colOrder, group: state.group, days: state.days, mode: state.mode } }); } catch (_e) { /* 忽略 */ }
  }

  // ===== 工具 =====
  const pad = (n) => String(n).padStart(2, "0");
  const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const shiftDate = (base, days) => new Date(base.getTime() + days * 86400e3);
  const n0 = (v) => Number(v || 0);
  const fmtInt = (v) => n0(v).toLocaleString("zh-CN");
  const fmtMoney = (v) => "₽ " + n0(v).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  const fmtPct = (v) => (Number(v) === 0 ? "—" : n0(v).toFixed(2) + "%");
  const fmtNum2 = (v) => (Number(v) === 0 ? "—" : n0(v).toFixed(2));
  const fmtBy = (fmt, v) => (fmt === "money" ? fmtMoney(v) : fmt === "pct" ? fmtPct(v) : fmt === "num2" ? fmtNum2(v) : fmtInt(v));

  function detectCompanyId() {
    try {
      const v = JSON.parse(localStorage.getItem("vuex") || "{}");
      const id = v && v.user && v.user.contentId;
      if (id) return String(id);
    } catch (_e) { /* 忽略 */ }
    const m = document.cookie.match(/(?:^|;\s*)sc_company_id=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }

  // 区间口径必须和 Ozon 后台一致：后台的「7 天 / 28 天」是「截止到昨天」的 N 个完整天，
  //   **不含今天**（今天数据不完整）。实测（2026-10-09）：
  //     后台 7 天 = 10-02~10-08 → 14 单；含今天的 10-03~10-09 → 15 单（多算今天的）
  
  function periodRange() {
    const today = new Date();
    if (state.days === "today") return { from: today, to: today };
    const yesterday = shiftDate(today, -1);
    if (state.days === "yesterday") return { from: yesterday, to: yesterday };
    return { from: shiftDate(today, -Number(state.days)), to: yesterday };
  }

  // 请求头统一在这里构造。
  //   不用对象字面量的 key，而是用计算属性名 —— 否则混淆后 key 会原样留在代码里
  //   （transformObjectKeys 和 stringArrayThreshold/splitStrings 组合时并不稳定），
  //   写成 [] 赋值后，这些字符串一定会被收进混淆器的字符串数组。
  // pageType 必须和接口所属页面一致：
  //   analytics_graph  → 我的商品销售 / 销售漏斗
  //   analytics-search → 搜索可见性 / 查词排位
  //   传错会返回 403 {"message":"no premium"} —— 极难排查的误导性报错。
  function apiHeaders(extra, pageType) {
    const h = {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
    };
    h["x-o3-company-id"] = state.ozonClientId;
    h["x-o3-app-name"] = "seller-ui";
    h["x-o3-language"] = "zh-Hans";
    h["x-o3-page-type"] = pageType || "analytics_graph";
    if (extra) for (const k of Object.keys(extra)) h[k] = extra[k];
    return h;
  }

  async function callApi(path, body, pageType) {
    const resp = await fetch(`${location.origin}${path}`, {
      method: "POST",
      credentials: "include",
      headers: apiHeaders(null, pageType),
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_e) { /* 非 JSON */ }
    if (!resp.ok) {
      const msg = data?.error?.detail || data?.message || text.slice(0, 200);
      throw new Error(`HTTP ${resp.status}：${msg}`);
    }
    return data || {};
  }

  const mapRow = (it) => {
    const row = {
      sku: String(it?.productInfo?.sku || ""),
      name: it?.productInfo?.name || "",
      article: it?.productInfo?.article || "",
      image: it?.productInfo?.image || "",
    };
    for (const m of ALL_METRICS) row[respKey(m)] = it?.metrics?.[respKey(m)];
    return row;
  };

  // 浏览器时区（Ozon 用 cookie x-o3-timezone 跟随本地时区，实测 -480 = UTC+8）
  function localTzSuffix() {
    const off = -new Date().getTimezoneOffset();      // 分钟，东为正
    const sign = off >= 0 ? "+" : "-";
    const a = Math.abs(off);
    return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
  }

  // 订单级汇总：分析接口只有「件」级取消，订单级要单独问 posting-service。
  //   body 里必须带 company_id（只给请求头会 403 Failed to get body company ID）
  async function loadOrderStats(dateFrom, dateTo) {
    const tz = localTzSuffix();
    const r = await fetch(`${location.origin}/api/posting-service/v2/fbs/posting/count/by-status-alias`, {
      method: "POST",
      credentials: "include",
      headers: apiHeaders(),
      body: JSON.stringify({
        company_id: state.ozonClientId,
        processed_at_from: `${dateFrom}T00:00:00${tz}`,
        processed_at_to: `${dateTo}T23:59:59${tz}`,
        status_alias: ORDER_STATUS_ALIASES,
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const rows = j?.result || [];
    const map = Object.fromEntries(rows.map((x) => [x.status_alias, Number(x.count || 0)]));
    return {
      cancelled: map.cancelled || 0,
      delivered: map.delivered || 0,
      notAccepted: map.not_accepted || 0,
      total: rows.reduce((a, x) => a + Number(x.count || 0), 0),
      byStatus: map,
    };
  }

  let loadGen = 0;

  async function load() {
    state.ozonClientId = detectCompanyId();
    const gen = ++loadGen;                       // 让上一次没跑完的加载自动作废
    state.loading = true; state.error = ""; state.data = null; state.totals = null;
    state.loadingMore = false; state.exhausted = false;
    render();
    if (!state.ozonClientId) {
      state.loading = false;
      state.error = "读不到当前登录的 Ozon 账号（company_id）。请确认已登录卖家后台后刷新页面。";
      render();
      return;
    }
    const { from, to } = periodRange();
    const prevTo = shiftDate(from, -1);
    const prevFrom = shiftDate(prevTo, -(Math.round((to - from) / 86400e3)));
    const base = {
      current_period: { date_from: fmtDate(from), date_to: fmtDate(to) },
      filters: { desc_type_ids: [], category_3_ids: [], category_2_ids: [] },
    };
    const bySkuBody = (offset) => ({
      ...base,
      previous_period: { date_from: fmtDate(prevFrom), date_to: fmtDate(prevTo) },
      limit: String(PAGE_SIZE),
      offset: String(offset),
      metrics: ALL_METRICS,
      sort: { key: "revenue_sort", order: "desc" },
    });
    const fetchPages = async (startPage, pageCount) => {
      const out = [];
      for (let i = 0; i < pageCount; i += 1) {
        const r = await callApi("/api/site/seller-analytics/charts/v3/table/by_sku", bySkuBody((startPage + i) * PAGE_SIZE));
        const items = r?.items || [];
        out.push(...items);
        if (items.length < PAGE_SIZE) { state.exhausted = true; break; }
      }
      return out;
    };
    try {
      const [totals, orderStats] = await Promise.all([
        callApi("/api/site/seller-analytics/charts/v3/table/totals", { ...base, metrics: ALL_METRICS }),
        loadOrderStats(fmtDate(from), fmtDate(to)).catch(() => null),
      ]);
      if (gen !== loadGen) return;
      state.totals = totals?.metrics || null;
      state.orderStats = orderStats;

      const first = await fetchPages(0, INITIAL_PAGES);
      if (gen !== loadGen) return;
      state.data = { date_from: fmtDate(from), date_to: fmtDate(to), items: first.map(mapRow) };
      state.loading = false;
      state.loadingMore = !state.exhausted;
      render();

      // 后台把剩下的补齐，搜索/导出就能覆盖全店，而不是只有头 400 条。
      // 这一步失败绝不能影响已经加载好的数据（之前没 try 住，offset 过界时
      // 抛 400 直接把整份数据清空了）。
      let page = INITIAL_PAGES;
      while (!state.exhausted && page < MAX_PAGES) {
        let more;
        try {
          more = await fetchPages(page, BATCH_PAGES);
        } catch (_e) {
          state.status = "backend-failed";
          break;
        }
        if (gen !== loadGen) return;
        if (!more.length) break;
        state.data.items.push(...more.map(mapRow));
        page += BATCH_PAGES;
        updateStatus();
      }
      state.loadingMore = false;
      updateStatus();
    } catch (e) {
      if (gen !== loadGen) return;
      state.error = e?.message || String(e);
      state.data = null; state.totals = null; state.loading = false; state.loadingMore = false;
      render();
    }
  }

  // ===== 当前列 =====
  function currentMetrics() {
    const def = GROUPS[state.group]?.metrics || ALL_METRICS;
    const custom = state.colOrder?.[state.group];
    if (!Array.isArray(custom) || !custom.length) return def;
    // 自定义里可能少了新增指标，末尾补齐；已不存在的过滤掉
    const kept = custom.filter((m) => def.includes(m));
    const missing = def.filter((m) => !kept.includes(m));
    return [...kept, ...missing];
  }

  function moveCol(metric, dir) {
    const list = [...currentMetrics()];
    const i = list.indexOf(metric);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    state.colOrder = { ...state.colOrder, [state.group]: list };
    savePrefs();
    render();
  }
  function resetCols() {
    const next = { ...state.colOrder };
    delete next[state.group];
    state.colOrder = next;
    savePrefs();
    render();
  }

  // ===== 搜索 + 排序 =====
  function filteredRows() {
    const q = state.search.trim().toLowerCase();
    let list = state.data?.items || [];
    if (q) {
      list = list.filter((r) =>
        String(r.article || "").toLowerCase().includes(q)
        || String(r.sku || "").toLowerCase().includes(q)
        || String(r.name || "").toLowerCase().includes(q));
    } else {
      list = [...list];
    }
    const k = state.sortKey;
    const dir = state.sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => (n0(a[k]) - n0(b[k])) * dir || n0(b.revenue) - n0(a.revenue));
    return list;
  }

  function exportCsv() {
    const rows = filteredRows();
    if (!rows.length) return;
    const ms = currentMetrics();
    const head = ["Ozon SKU", "货号", "商品名", ...ms.map((m) => METRIC_DEFS[m].label)];
    const body = rows.map((r) => [
      r.sku, r.article, String(r.name || "").replace(/[\r\n,]/g, " "),
      ...ms.map((m) => {
        const v = n0(r[respKey(m)]);
        return METRIC_DEFS[m].fmt === "money" || METRIC_DEFS[m].fmt === "pct" ? v.toFixed(2) : v;
      }),
    ]);
    const csv = "\ufeff" + [head, ...body].map((x) => x.join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `Ozon_${GROUPS[state.group].label}_${state.data.date_from}_${state.data.date_to}${state.search ? "_筛选" : ""}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ===== 渲染 =====
  function el(tag, style, text) {
    const e = document.createElement(tag);
    if (style) e.setAttribute("style", style);
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function btn(label, active, onclick, title) {
    const b = el("button",
      `border:1px solid ${active ? "#0ea5e9" : "#dbeafe"};background:${active ? "#e0f2fe" : "#fff"};color:${active ? "#0369a1" : "#64748b"};border-radius:6px;padding:3px 9px;font-size:12px;cursor:pointer;font-weight:${active ? 700 : 400}`,
      label);
    if (title) b.title = title;
    b.onclick = onclick;
    return b;
  }

  // ===== 复制到剪贴板 =====
  function copyText(text, btnEl) {
    const done = () => {
      if (!btnEl) return;
      const old = btnEl.textContent;
      btnEl.textContent = "✓";
      btnEl.style.color = "#16a34a";
      setTimeout(() => { btnEl.textContent = old; btnEl.style.color = ""; }, 1200);
    };
    const fallback = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("style", "position:fixed;left:-9999px;top:0");
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        done();
      } catch (_e) { /* 复制不了就算了 */ }
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(fallback);
        return;
      }
    } catch (_e) { /* 走 fallback */ }
    fallback();
  }

  // 拖拽排序时正在拖的指标（dragover 期间不重渲染，落位在 drop 里做）
  let dragMetric = null;

  // ===== 商品图 hover 放大 =====
  // 商品缩略图 hover 自动放大（产品需求：所有列表页都要有）
  let zoomEl = null;
  const ZOOM_SIZE = 260;

  function showZoom(src, name, evt) {
    if (!zoomEl || !src) return;
    const im = zoomEl.querySelector("img");
    if (im.getAttribute("src") !== src) im.setAttribute("src", src);
    zoomEl.querySelector(".ofz-cap").textContent = name || "";
    zoomEl.style.display = "block";
    moveZoom(evt);
  }

  function moveZoom(evt) {
    if (!zoomEl || zoomEl.style.display === "none" || !evt) return;
    const pad = 14;
    const w = ZOOM_SIZE;
    const h = zoomEl.offsetHeight || ZOOM_SIZE + 30;
    // 默认放光标左边（别挡住鼠标），左边放不下就换右边；再统一收进视口
    let x = evt.clientX - w - pad;
    if (x < pad) x = evt.clientX + pad;
    if (x + w > window.innerWidth - pad) x = Math.max(pad, window.innerWidth - w - pad);
    let y = evt.clientY - h / 2;
    y = Math.max(pad, Math.min(y, window.innerHeight - h - pad));
    zoomEl.style.left = `${Math.round(x)}px`;
    zoomEl.style.top = `${Math.round(y)}px`;
  }

  function hideZoom() {
    if (zoomEl) zoomEl.style.display = "none";
  }

  let statusNode = null;
  function updateStatus() {
    if (!statusNode || !state.data) return;
    const n = state.data.items.length;
    if (state.loadingMore) { statusNode.textContent = `已加载 ${n} 条，后台补齐中…`; return; }
    if (state.exhausted) { statusNode.textContent = `已加载全部 ${n} 条`; return; }
    // 没加载完又停了 —— 接口 offset 上限 1000，这张表最多 1000 行
    statusNode.textContent = `已加载 ${n} 条（接口上限 1000 行）`;
  }

  function render() {
    const host = document.getElementById(HOST_ID);
    if (!host) return;
    const panel = host.shadowRoot.getElementById("of-panel");
    if (!panel) return;
    panel.innerHTML = "";
    statusNode = null;
    hideZoom();
    // setAttribute("style") 会整体覆盖内联样式，display 必须一起写，否则「收起」会被冲掉
    const pos = state.maximized
      ? "position:fixed;left:0;top:0;width:100vw;height:100vh;max-width:100vw;max-height:100vh;overflow:auto;background:#f0f2f5;padding:14px 18px;border-radius:0;box-shadow:none;z-index:1"
      : "position:fixed;right:18px;bottom:62px;z-index:1;width:800px;max-width:94vw;max-height:82vh;overflow:auto;background:#f0f2f5;border-radius:12px;padding:12px;box-shadow:0 10px 40px rgba(0,0,0,.22)";
    panel.setAttribute("style", `display:${state.open ? "block" : "none"};` + pos);

    // ── 头部 ──
    const head = el("div", "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px");
    head.appendChild(el("span", "font-size:15px;font-weight:800;color:#0f172a", "📊 Ozon 我的商品销售"));
    head.appendChild(el("span", "font-size:10px;color:#0369a1;background:#e0f2fe;border:1px solid #bae6fd;padding:1px 6px;border-radius:8px;font-weight:700", "v" + VERSION));
    if (state.ozonClientId) head.appendChild(el("span", "font-size:11px;color:#0f766e;background:#ccfbf1;padding:2px 7px;border-radius:10px;font-weight:700", "账号 " + state.ozonClientId));
    head.appendChild(el("span", "flex:1"));
    head.appendChild(btn("刷新", false, load));
    head.appendChild(btn(state.maximized ? "🗗 还原" : "⛶ 最大化", false, () => { state.maximized = !state.maximized; render(); }, "横向铺满整个屏幕"));
    head.appendChild(btn("导出 CSV", false, exportCsv, "导出当前筛选结果"));
    head.appendChild(btn("收起", false, () => {
      if (window.__ozonFunnelToggle__) window.__ozonFunnelToggle__(false);
      else { state.open = false; render(); }
    }, "收起面板（快捷键 Esc）"));
    panel.appendChild(head);

    // ── 模式切换：我的商品销售 / 搜索可见性 / 查词排位 ──
    const modeBar = el("div", "display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px");
    [["sales", "📈 我的商品销售"], ["visibility", "🔎 搜索可见性"], ["rank", "🎯 查词排位"]].forEach(([k, label]) => {
      modeBar.appendChild(btn(label, state.mode === k, () => { state.mode = k; savePrefs(); render(); }));
    });
    panel.appendChild(modeBar);

    if (state.mode === "visibility") return renderVisibility(panel);
    if (state.mode === "rank") return renderRank(panel);

    // ── 日期 ──
    const bar = el("div", "display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px");
    [["today", "今天"], ["yesterday", "昨天"], [7, "近7天"], [14, "近14天"], [28, "近28天"], [30, "近30天"]].forEach(([v, label]) => {
      bar.appendChild(btn(label, state.days === v, () => { state.days = v; savePrefs(); load(); }));
    });
    if (state.data) {
      bar.appendChild(el("span", "font-size:11px;color:#94a3b8", `${state.data.date_from} ~ ${state.data.date_to}`));
      statusNode = el("span", "font-size:11px;color:#0ea5e9", "");
      bar.appendChild(statusNode);
      updateStatus();
    }
    panel.appendChild(bar);

    // ── 指标分组 + 列设置 ──
    const groups = el("div", "display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px");
    groups.appendChild(el("span", "font-size:11px;color:#94a3b8", "指标组："));
    for (const [key, g] of Object.entries(GROUPS)) {
      groups.appendChild(btn(`${g.label}(${g.metrics.length})`, state.group === key, () => {
        state.group = key; state.showCols = false; savePrefs(); render();
      }));
    }
    groups.appendChild(btn(state.showCols ? "▴ 收起列设置" : "⚙ 调整列序", state.showCols, () => { state.showCols = !state.showCols; render(); },
      "自定义列的先后顺序（会自动记住）"));
    panel.appendChild(groups);

    // ── 列设置面板（支持拖拽排序，◀ ▶ 作为备用）──
    if (state.showCols) {
      const box = el("div", "background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;margin-bottom:8px");
      box.appendChild(el("div", "font-size:11px;color:#94a3b8;margin-bottom:6px", "🖱 直接拖动标签调整列的位置（也可以用 ◀ ▶）；按当前指标组记忆，会持久保存"));
      const listBox = el("div", "display:flex;flex-wrap:wrap;gap:6px");
      const metrics = currentMetrics();
      metrics.forEach((m, i) => {
        const chip = el("span", "display:inline-flex;align-items:center;gap:3px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:2px 6px;font-size:12px;color:#334155;user-select:none");
        chip.draggable = true;
        chip.style.cursor = "grab";
        chip.title = "按住拖动可调整顺序";
        const grip = el("span", "color:#cbd5e1;font-size:11px;cursor:grab", "⠿");
        chip.appendChild(grip);
        chip.appendChild(el("span", "color:#94a3b8;font-size:10px;min-width:14px", String(i + 1)));
        chip.appendChild(el("span", "", METRIC_DEFS[m].label));
        const left = btn("◀", false, () => moveCol(m, -1), "左移");
        const right = btn("▶", false, () => moveCol(m, 1), "右移");
        left.style.padding = right.style.padding = "0 5px";
        if (i === 0) left.disabled = true;
        if (i === metrics.length - 1) right.disabled = true;
        chip.appendChild(left); chip.appendChild(right);

        // ── 拖拽排序 ──
        // 注意：dragover 里绝对不能再 render()，否则被拖的元素被销毁，拖拽会中断。
        //   所以拖拽过程中只做高亮，真正落位在 drop 里。
        chip.addEventListener("dragstart", (e) => {
          dragMetric = m;
          chip.style.opacity = "0.35";
          try { e.dataTransfer.setData("text/plain", m); e.dataTransfer.effectAllowed = "move"; } catch (_e) { /* 忽略 */ }
        });
        chip.addEventListener("dragend", () => {
          dragMetric = null;
          chip.style.opacity = "";
          chip.style.boxShadow = "";
        });
        chip.addEventListener("dragover", (e) => {
          if (!dragMetric || dragMetric === m) return;
          e.preventDefault();
          try { e.dataTransfer.dropEffect = "move"; } catch (_e) { /* 忽略 */ }
          const r = chip.getBoundingClientRect();
          const after = e.clientX > r.left + r.width / 2;
          chip.style.boxShadow = after ? "inset -3px 0 0 #0ea5e9" : "inset 3px 0 0 #0ea5e9";
        });
        chip.addEventListener("dragleave", () => { chip.style.boxShadow = ""; });
        chip.addEventListener("drop", (e) => {
          e.preventDefault();
          chip.style.boxShadow = "";
          if (!dragMetric || dragMetric === m) return;
          const list = [...currentMetrics()];
          const from = list.indexOf(dragMetric);
          if (from < 0) return;
          list.splice(from, 1);
          let to = list.indexOf(m);
          const r = chip.getBoundingClientRect();
          if (e.clientX > r.left + r.width / 2) to += 1;   // 落在右半边 → 插到它后面
          list.splice(to, 0, dragMetric);
          state.colOrder = { ...state.colOrder, [state.group]: list };
          savePrefs();
          dragMetric = null;
          render();
        });

        listBox.appendChild(chip);
      });
      box.appendChild(listBox);
      const acts = el("div", "margin-top:8px");
      acts.appendChild(btn("恢复默认列序", false, resetCols));
      box.appendChild(acts);
      panel.appendChild(box);
    }

    // ── 搜索框 ──
    const searchBar = el("div", "display:flex;gap:6px;align-items:center;margin-bottom:10px");
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "🔍 搜货号 / SKU / 商品名（支持部分匹配）";
    input.value = state.search;
    input.setAttribute("style", "flex:1;border:1px solid #dbeafe;border-radius:6px;padding:5px 9px;font-size:12px;outline:none;background:#fff;color:#0f172a");
    let timer = null;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => { state.search = input.value; render(); }, 220);
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Escape") { input.value = ""; state.search = ""; render(); } });
    searchBar.appendChild(input);
    if (state.search) searchBar.appendChild(btn("清空", false, () => { state.search = ""; render(); }));
    panel.appendChild(searchBar);

    if (state.loading) { panel.appendChild(el("div", "padding:30px;text-align:center;color:#94a3b8;font-size:13px", "加载中…")); return; }
    if (state.error) {
      panel.appendChild(el("div", "background:#fef2f2;border-radius:8px;padding:12px;font-size:12px;color:#b91c1c;line-height:1.7;word-break:break-all", state.error));
      return;
    }
    if (!state.data) return;

    // ── 总计卡 ──
    const t = state.totals || {};
    const grid = el("div", "display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px");
    currentMetrics().slice(0, 6).forEach((m) => {
      const d = METRIC_DEFS[m];
      const c = el("div", "background:#f8fafc;border-radius:8px;padding:8px 10px");
      c.appendChild(el("div", "font-size:11px;color:#94a3b8", "总计 " + d.label));
      c.appendChild(el("div", "font-size:15px;font-weight:800;color:#0f172a;margin-top:2px", fmtBy(d.fmt, t[respKey(m)])));
      grid.appendChild(c);
    });
    panel.appendChild(grid);

    // 订单级汇总：分析接口只有「件」级取消，订单级来自 posting-service
    if (state.orderStats) {
      const o = state.orderStats;
      const line = el("div", "display:flex;flex-wrap:wrap;gap:14px;align-items:center;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:7px 11px;margin-bottom:10px;font-size:12px");
      line.appendChild(el("span", "color:#94a3b8", "订单汇总（按下单时间）："));
      line.appendChild(el("span", "color:#dc2626;font-weight:800", `取消订单 ${o.cancelled} 单`));
      line.appendChild(el("span", "color:#16a34a", `已送达 ${o.delivered} 单`));
      if (o.notAccepted) line.appendChild(el("span", "color:#e6a23c", `未受理 ${o.notAccepted} 单`));
      line.appendChild(el("span", "color:#475569;font-weight:700", `总订单 ${o.total} 单`));
      line.appendChild(el("span", "color:#c0c4cc;font-size:11px", "订单数按单据计，与上面的件数不是一回事"));
      panel.appendChild(line);
    }

    // ── 明细表 ──
    const ms = currentMetrics();
    const rows = filteredRows();
    const shown = rows.slice(0, RENDER_MAX);
    const wrap = el("div", `max-height:${state.maximized ? "calc(100vh - 330px)" : "50vh"};overflow:auto;font-size:12px`);
    // 列宽 86px：销售漏斗组 13 列在最大化时刚好整屏放下不横向滚
    const gridCols = "minmax(184px,1.5fr) " + ms.map(() => "86px").join(" ");
    const th = el("div", `display:grid;grid-template-columns:${gridCols};gap:6px;padding:6px 4px;border-bottom:1px solid #eef2f7;position:sticky;top:0;background:#fff;z-index:2`);
    th.appendChild(el("span", "color:#94a3b8;font-weight:700", state.search ? `商品（匹配 ${rows.length}）` : `商品（${state.data.items.length}）`));
    ms.forEach((m) => {
      const key = respKey(m);
      const active = state.sortKey === key;
      const s = el("span", `text-align:right;color:${active ? "#0ea5e9" : "#94a3b8"};font-weight:700;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`, METRIC_DEFS[m].label + (active ? (state.sortDir === "desc" ? " ↓" : " ↑") : ""));
      s.title = "点击按「" + METRIC_DEFS[m].label + "」排序";
      s.onclick = () => {
        if (state.sortKey === key) state.sortDir = state.sortDir === "desc" ? "asc" : "desc";
        else { state.sortKey = key; state.sortDir = "desc"; }
        render();
      };
      th.appendChild(s);
    });
    wrap.appendChild(th);

    const totalRow = el("div", `display:grid;grid-template-columns:${gridCols};gap:6px;padding:7px 4px;border-bottom:1px solid #e2e8f0;position:sticky;top:28px;background:#f8fafc;font-weight:700;z-index:1`);
    totalRow.appendChild(el("span", "color:#0f172a", "总计和平均值"));
    ms.forEach((m) => totalRow.appendChild(el("span", "text-align:right;color:#0f172a", fmtBy(METRIC_DEFS[m].fmt, t[respKey(m)]))));
    wrap.appendChild(totalRow);

    if (!shown.length) {
      wrap.appendChild(el("div", "padding:16px;text-align:center;color:#c0c4cc",
        state.search
          ? `没找到匹配「${state.search}」的商品` + (state.loadingMore ? "（数据还在加载，稍等一下）" : "")
          : "所选区间没有数据"));
    }
    shown.forEach((r) => {
      const tr = el("div", `display:grid;grid-template-columns:${gridCols};gap:6px;padding:5px 4px;border-bottom:1px solid #f8fafc;align-items:center`);
      const cell = el("div", "display:flex;gap:8px;align-items:center;min-width:0");
      const img = document.createElement("img");
      img.setAttribute("style", "width:34px;height:34px;border-radius:5px;object-fit:cover;flex-shrink:0;background:#e2e8f0;border:1px solid #eef2f7;cursor:zoom-in");
      if (r.image) { img.src = r.image; img.loading = "lazy"; }
      img.title = r.name || r.sku;
      // 鼠标悬停自动放大
      if (r.image) {
        img.addEventListener("mouseenter", (e) => showZoom(r.image, r.name || r.sku, e));
        img.addEventListener("mousemove", moveZoom);
        img.addEventListener("mouseleave", hideZoom);
      }
      cell.appendChild(img);
      const txt = el("div", "min-width:0;line-height:1.35;flex:1");
      txt.appendChild(el("div", "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#0f172a;font-weight:700", r.name || r.sku));
      // 货号 + 一键复制（没有货号就复制 SKU）
      const meta = el("div", "display:flex;align-items:center;gap:4px;font-size:10px;color:#64748b;min-width:0");
      const copyVal = r.article || r.sku || "";
      const art = el("span", "overflow:hidden;text-overflow:ellipsis;white-space:nowrap", `货号 ${r.article || "—"}`);
      art.title = copyVal;
      meta.appendChild(art);
      const cp = el("button",
        "flex-shrink:0;border:1px solid #e2e8f0;background:#fff;color:#64748b;border-radius:4px;padding:0 4px;font-size:10px;line-height:14px;cursor:pointer",
        "⧉");
      cp.title = copyVal ? `复制货号：${copyVal}` : "没有货号";
      cp.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (copyVal) copyText(copyVal, cp);
      });
      meta.appendChild(cp);
      meta.appendChild(el("span", "color:#94a3b8;flex-shrink:0", `· ${r.sku}`));
      txt.appendChild(meta);
      cell.appendChild(txt);
      tr.appendChild(cell);
      ms.forEach((m) => {
        const d = METRIC_DEFS[m];
        const color = d.fmt === "money" ? "#0f766e" : d.fmt === "pct" ? "#7c3aed" : "#475569";
        tr.appendChild(el("span", `text-align:right;color:${color};font-weight:${d.fmt === "money" ? 700 : 400}`, fmtBy(d.fmt, r[respKey(m)])));
      });
      wrap.appendChild(tr);
    });
    panel.appendChild(wrap);
    if (rows.length > shown.length) {
      panel.appendChild(el("div", "font-size:11px;color:#e6a23c;margin-top:6px", `表格只渲染前 ${RENDER_MAX} 行（共 ${rows.length} 行）；搜索和「导出 CSV」用的是全部数据。`));
    }
    requestAnimationFrame(() => {
      if (wrap.scrollWidth > wrap.clientWidth + 4) {
        panel.appendChild(el("div", "font-size:11px;color:#e6a23c;margin-top:6px", `← 表格可左右滚动，共 ${ms.length} 列 →`));
      }
    });

    panel.appendChild(el("div", "font-size:11px;color:#c0c4cc;margin-top:8px;line-height:1.6",
      `区间口径与 Ozon 后台一致：N 天 = 截止昨天的 N 个完整天（不含今天）。列序/分组/天数会自动记住。数据取自 Ozon 同款接口（页面会话），未伪造任何会员状态。v${VERSION}`));
  }

  // ===================================================================
  // 搜索可见性（分析 → 搜索可见性 → 我的商品）
  //   主接口 POST /api/search-query-analytics/v1/cjm/get-seller-analytics
  //   免费可用；8 列里 4 列是真·Premium 锁（服务端直接返回空字符串）
  // ===================================================================
  const SV_API = "/api/search-query-analytics/v1/cjm/get-seller-analytics";
  const SV_META_API = "/api/search-query-analytics/v1/cjm/get-seller-analytics-table-headers";
  const SV_COLUMNS = [
    { key: "visibility", label: "商品可见度", metric: "", locked: false },
    { key: "uniqueSearchUsers", label: "多少位买家曾搜索", metric: "METRICS_TYPE_UNIQUE_SEARCH_USERS", locked: false },
    { key: "uniqueViewUsers", label: "多少位买家已看到", metric: "METRICS_TYPE_UNIQUE_VIEW_USERS", locked: true },
    { key: "searchPosition", label: "搜索结果中的位置", metric: "METRICS_TYPE_SEARCH_POSITION", locked: true },
    { key: "queryCtrInteract", label: "搜索→卡片转化率", metric: "METRICS_TYPE_QUERY_CTR_INTERACT", locked: true },
    { key: "queryCtrOrder", label: "搜索→订单转化率", metric: "METRICS_TYPE_QUERY_CTR_ORDER", locked: true },
    { key: "uniqueOrdersCount", label: "订购商品件数", metric: "METRICS_TYPE_UNIQUE_ORDERS_COUNT", locked: false },
    { key: "gmv", label: "订购金额", metric: "METRICS_TYPE_GMV", locked: false },
  ];

  async function svGet(path) {
    const resp = await fetch(`${location.origin}${path}`, { credentials: "include", headers: apiHeaders(null, "analytics-search") });
    const text = await resp.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_e) { /* 非 JSON */ }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}：${data?.message || data?.error?.detail || text.slice(0, 160)}`);
    return data || {};
  }

  // 搜索可见性有独立的可用区间（get-dates）。
  //   ⚠️ 区间超出可用范围时，接口返回 403 {"message":"no premium"} ——
  //   极具误导性，其实是「数据还没到那天」，不是没会员（实测已确认）。
  //   而且必须按**整天**钳制：period_to 取窗口末端那个时刻本身也会被拒，
  //   必须让当天的 23:59:59.999（本地）≤ 窗口末端。
  //   例：窗口 to = 2026-10-09T00:00:00Z（= 本地 10-09 08:00）
  //       → 最后可用的一天是 10-08（其 23:59:59.999 本地 = 10-08T15:59:59.999Z）
  function maxUsableLocalDay(availToIso) {
    const limit = new Date(availToIso).getTime();
    let d = new Date(availToIso);
    for (let i = 0; i < 5; i += 1) {
      const day = fmtDate(d);
      if (new Date(`${day}T23:59:59.999`).getTime() <= limit) return day;
      d = shiftDate(d, -1);
    }
    return fmtDate(d);
  }

  async function svClampRange(fromStr, toStr) {
    const st = state.sv;
    if (!st.avail) {
      try {
        const j = await svGet(`/api/search-query-analytics/v1/get-dates?seller_id=${encodeURIComponent(state.ozonClientId)}`);
        st.avail = { from: j?.actual?.from || "", to: j?.actual?.to || "" };
      } catch (_e) { st.avail = { from: "", to: "" }; }
    }
    let fromDay = fromStr;
    let toDay = toStr;
    let clamped = false;
    // ⚠️ 关键：这个接口只认**固定长度**的窗口（当前是 7 天）。
    //   区间超出可用范围时必须整体**后移**，不能只把结束日往前截 ——
    //   截成 6 天会照样 403 no premium（实测 10-03~10-08 全被拒，
    //   而 10-02~10-08 正常）。所以按原跨度平移。
    const spanDays = Math.max(0, Math.round((new Date(toStr) - new Date(fromStr)) / 86400e3));
    if (st.avail.to) {
      const maxDay = maxUsableLocalDay(st.avail.to);
      if (toDay > maxDay) {
        const delta = Math.round((new Date(toDay) - new Date(maxDay)) / 86400e3);
        toDay = maxDay;
        fromDay = fmtDate(shiftDate(new Date(fromDay), -delta));
        clamped = true;
      }
    }
    if (st.avail.from) {
      const minDay = fmtDate(new Date(st.avail.from));
      if (fromDay < minDay) { fromDay = minDay; toDay = fmtDate(shiftDate(new Date(fromDay), spanDays)); clamped = true; }
    }
    if (fromDay > toDay) fromDay = toDay;
    return { fromIso: localDayIso(fromDay, false), toIso: localDayIso(toDay, true), fromDay, toDay, clamped };
  }

  // 本地 00:00:00 ~ 23:59:59.999 转成 UTC ISO（Ozon 就是这么传的）
  function localDayIso(dateStr, endOfDay) {
    const d = new Date(`${dateStr}T${endOfDay ? "23:59:59.999" : "00:00:00"}`);
    return d.toISOString();
  }

  function svRange() {
    const { from, to } = periodRange();
    return { from: fmtDate(from), to: fmtDate(to) };
  }

  async function loadVisibility(page) {
    const st = state.sv;
    state.ozonClientId = detectCompanyId();   // 直接进这个模式时也要先取账号，否则请求头为空 → 403
    if (!state.ozonClientId) { st.error = "读不到当前登录的 Ozon 账号（company_id），请确认已登录后刷新页面。"; render(); return; }
    const target = page === undefined ? st.page : page;
    st.loading = true; st.error = ""; render();
    try {
      const { from, to } = svRange();
      const rng = await svClampRange(from, to);
      st.clamped = rng.clamped;
      st.effFrom = rng.fromDay; st.effTo = rng.toDay;
      const j = await callApi(SV_API, {
        seller_id: state.ozonClientId,
        period_from: rng.fromIso,
        period_to: rng.toIso,
        count_total_items: true,
        page_number: String(target),
        items_per_page: String(st.perPage),
        sort_by: st.sortBy,
        sort_direction: st.sortDir,
        filters: { categories: [], search: st.search || "" },
      }, "analytics-search");
      st.data = j;
      st.page = target;
    } catch (e) {
      const msg = e?.message || String(e);
      st.error = /no premium/i.test(msg)
        ? `${msg}\n\n提示：这个 403 有迷惑性，实测是「日期超出 Ozon 可用范围」导致的，不是真没会员。已自动按可用范围收窄，若仍报错请点其它日期区间。`
        : msg;
      st.data = null;
    }
    st.loading = false;
    render();
  }

  function svVal(row, key) {
    if (key === "visibility") {
      const v = row.visibility || {};
      return v.value ? `${v.value}${v.label ? " " + v.label : ""}` : "—";
    }
    const f = row[key];
    if (!f || typeof f !== "object") return "—";
    const val = f.value || "";
    const d = f.delta && f.delta !== "—" ? ` (${f.delta})` : "";
    return (val || "—") + d;
  }

  function renderVisibility(panel) {
    const st = state.sv;

    // 日期 + 搜索
    const bar = el("div", "display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px");
    [["today", "今天"], ["yesterday", "昨天"], [7, "近7天"], [14, "近14天"], [28, "近28天"], [30, "近30天"]].forEach(([v, label]) => {
      bar.appendChild(btn(label, state.days === v, () => { state.days = v; savePrefs(); loadVisibility(0); }));
    });
    bar.appendChild(btn("刷新", false, () => loadVisibility(st.page)));
    bar.appendChild(btn("导出 CSV", false, exportVisibilityCsv));
    panel.appendChild(bar);

    const srch = el("div", "display:flex;gap:6px;align-items:center;margin-bottom:10px");
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "🔍 搜商品名称 / 货号 / SKU（服务端搜索）";
    input.value = st.search;
    input.setAttribute("style", "flex:1;border:1px solid #dbeafe;border-radius:6px;padding:5px 9px;font-size:12px;outline:none;background:#fff;color:#0f172a");
    let t1 = null;
    input.addEventListener("input", () => {
      clearTimeout(t1);
      t1 = setTimeout(() => { st.search = input.value; loadVisibility(0); }, 350);
    });
    srch.appendChild(input);
    if (st.search) srch.appendChild(btn("清空", false, () => { st.search = ""; loadVisibility(0); }));
    panel.appendChild(srch);

    if (st.loading) { panel.appendChild(el("div", "padding:30px;text-align:center;color:#94a3b8;font-size:13px", "加载中…")); return; }
    if (st.error) { panel.appendChild(el("div", "background:#fef2f2;border-radius:8px;padding:12px;font-size:12px;color:#b91c1c;line-height:1.7;word-break:break-all", st.error)); return; }
    if (!st.data) {
      panel.appendChild(el("div", "padding:24px;text-align:center;color:#94a3b8;font-size:13px", "点「刷新」加载搜索可见性数据"));
      return;
    }

    const rows = st.data.skus || [];
    const total = Number(st.data.totalNumberOfItems || rows.length);
    const pages = Number(st.data.totalPagesCount || 1);
    const info = el("div", "font-size:11px;color:#64748b;margin-bottom:8px");
    const availNote = st.avail?.to ? ` · 数据可用至 ${maxUsableLocalDay(st.avail.to)}` : "";
    info.textContent = `共 ${total} 个商品 · 第 ${st.page + 1}/${pages} 页 · ${st.effFrom || svRange().from} ~ ${st.effTo || svRange().to}${availNote}${st.clamped ? "（已按可用范围收窄）" : ""}`;
    panel.appendChild(info);

    // 表
    const ms = SV_COLUMNS;
    const gridCols = "minmax(230px,1.4fr) " + ms.map(() => "112px").join(" ");
    const wrap = el("div", `max-height:${state.maximized ? "calc(100vh - 340px)" : "46vh"};overflow:auto;font-size:12px`);
    const th = el("div", `display:grid;grid-template-columns:${gridCols};gap:6px;padding:6px 4px;border-bottom:1px solid #eef2f7;position:sticky;top:0;background:#fff;z-index:2`);
    th.appendChild(el("span", "color:#94a3b8;font-weight:700", "商品（SKU / 货号 / 状态）"));
    ms.forEach((c) => {
      const active = st.sortBy === c.metric && c.metric;
      const lbl = c.label + (active ? (st.sortDir === "DESCENDING" ? " ↓" : " ↑") : "");
      const s = el("span", `text-align:right;font-weight:700;cursor:${c.metric ? "pointer" : "default"};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${c.locked ? "#cbd5e1" : (active ? "#0ea5e9" : "#94a3b8")}`, lbl);
      s.title = c.locked ? "该列需要 Premium（服务端不返回）" : (c.metric ? "点击排序" : "");
      if (c.metric) {
        s.onclick = () => {
          if (st.sortBy === c.metric) st.sortDir = st.sortDir === "DESCENDING" ? "ASCENDING" : "DESCENDING";
          else { st.sortBy = c.metric; st.sortDir = "DESCENDING"; }
          loadVisibility(0);
        };
      }
      th.appendChild(s);
    });
    wrap.appendChild(th);

    if (!rows.length) wrap.appendChild(el("div", "padding:16px;text-align:center;color:#c0c4cc", st.search ? `没找到匹配「${st.search}」的商品` : "所选区间没有数据"));
    rows.forEach((r) => {
      const tr = el("div", `display:grid;grid-template-columns:${gridCols};gap:6px;padding:5px 4px;border-bottom:1px solid #f8fafc;align-items:center`);
      const cell = el("div", "display:flex;gap:8px;align-items:center;min-width:0");
      const img = document.createElement("img");
      img.setAttribute("style", "width:34px;height:34px;border-radius:5px;object-fit:cover;flex-shrink:0;background:#e2e8f0;border:1px solid #eef2f7;cursor:zoom-in");
      if (r.pictureUrl) {
        img.src = r.pictureUrl; img.loading = "lazy";
        img.addEventListener("mouseenter", (e) => showZoom(r.pictureUrl, r.name || r.sku, e));
        img.addEventListener("mousemove", moveZoom);
        img.addEventListener("mouseleave", hideZoom);
      }
      cell.appendChild(img);
      const txt = el("div", "min-width:0;line-height:1.35;flex:1");
      txt.appendChild(el("div", "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#0f172a;font-weight:700", r.name || r.sku));
      const meta = el("div", "display:flex;align-items:center;gap:4px;font-size:10px;color:#64748b;min-width:0");
      const copyVal = r.article || r.sku || "";
      meta.appendChild(el("span", "overflow:hidden;text-overflow:ellipsis;white-space:nowrap", `货号 ${r.article || "—"}`));
      const cp = el("button", "flex-shrink:0;border:1px solid #e2e8f0;background:#fff;color:#64748b;border-radius:4px;padding:0 4px;font-size:10px;line-height:14px;cursor:pointer", "⧉");
      cp.title = `复制货号：${copyVal}`;
      cp.addEventListener("click", (ev) => { ev.stopPropagation(); if (copyVal) copyText(copyVal, cp); });
      meta.appendChild(cp);
      meta.appendChild(el("span", "color:#94a3b8;flex-shrink:0", `· ${r.sku} · ${r.sellStatus || ""}`));
      txt.appendChild(meta);
      cell.appendChild(txt);
      tr.appendChild(cell);
      ms.forEach((c) => {
        if (c.locked) {
          tr.appendChild(el("span", "text-align:right;color:#cbd5e1;font-size:11px", "需 Premium"));
        } else {
          const v = svVal(r, c.key);
          const color = c.key === "gmv" ? "#0f766e" : (c.key === "visibility" ? "#0369a1" : "#475569");
          tr.appendChild(el("span", `text-align:right;color:${color};font-weight:${c.key === "gmv" ? 700 : 400};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`, v));
        }
      });
      wrap.appendChild(tr);
    });
    panel.appendChild(wrap);

    // 翻页
    const pager = el("div", "display:flex;gap:6px;align-items:center;justify-content:center;margin-top:8px");
    pager.appendChild(btn("⏮ 首页", false, () => loadVisibility(0)));
    pager.appendChild(btn("◀ 上一页", false, () => loadVisibility(Math.max(0, st.page - 1))));
    pager.appendChild(el("span", "font-size:12px;color:#475569", `${st.page + 1} / ${pages}`));
    pager.appendChild(btn("下一页 ▶", false, () => loadVisibility(Math.min(pages - 1, st.page + 1))));
    pager.appendChild(btn("末页 ⏭", false, () => loadVisibility(pages - 1)));
    panel.appendChild(pager);

    panel.appendChild(el("div", "font-size:11px;color:#c0c4cc;margin-top:8px;line-height:1.6",
      `数据源与 Ozon「分析 → 搜索可见性 → 我的商品」同一接口。其中「已看到人数 / 搜索位置 / 两个转化率」Ozon 服务端只对 Premium 返回，免费号拿不到（不是本插件的问题）。v${VERSION}`));
  }

  function exportVisibilityCsv() {
    const st = state.sv;
    const rows = st.data?.skus || [];
    if (!rows.length) return;
    const ms = SV_COLUMNS;
    const head = ["Ozon SKU", "货号", "商品名", "状态", ...ms.map((c) => c.label)];
    const body = rows.map((r) => [
      r.sku, r.article, String(r.name || "").replace(/[\r\n,]/g, " "), r.sellStatus || "",
      ...ms.map((c) => (c.locked ? "" : svVal(r, c.key).replace(/[\r\n,]/g, " "))),
    ]);
    const csv = "\ufeff" + [head, ...body].map((x) => x.join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `Ozon_搜索可见性_${st.effFrom || svRange().from}_${st.effTo || svRange().to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ===================================================================
  // 查词排位（分析 → 搜索可见性 → 什么影响搜索结果中的位置）
  //   POST /api/search-query-analytics/v2/external/explanation_by_id
  //   这个是免费的，能拿到「搜索结果中的位置」
  // ===================================================================
  async function loadLocations() {
    const rk = state.rk;
    state.ozonClientId = detectCompanyId();
    try {
      const j = await callApi("/api/search-query-analytics/v1/external/available_locations", { sellerId: state.ozonClientId, prefix: "" }, "analytics-search");
      rk.locations = j?.defaultLocations || [];
      if (!rk.uuid && rk.locations[0]) rk.uuid = rk.locations[0].uuid;
    } catch (_e) { rk.locations = []; }
    render();
  }

  async function loadRank(page) {
    const rk = state.rk;
    state.ozonClientId = detectCompanyId();
    if (!state.ozonClientId) { rk.error = "读不到当前登录的 Ozon 账号（company_id），请确认已登录后刷新页面。"; render(); return; }
    if (!rk.query.trim()) { rk.error = "请先填搜索词"; render(); return; }
    const target = page === undefined ? rk.page : page;
    rk.loading = true; rk.error = ""; render();
    try {
      const j = await callApi("/api/search-query-analytics/v2/external/explanation_by_id", {
        sellerId: state.ozonClientId,
        query: rk.query,
        skus: [],
        uuid: rk.uuid,
        sortOption: { headerKey: rk.sortKey || "position", direction: rk.sortDir === "desc" ? "SortDirectionDescending" : "SortDirectionAscending" },
        itemsPerPage: String(rk.perPage),
        pageNumber: String(target),
        onlyCurSellerItems: !!rk.onlyMine,
        applicationScope: "SCOPE_BIG_OZON",
      }, "analytics-search");
      rk.data = j;
      rk.page = target;
    } catch (e) {
      rk.error = e?.message || String(e);
      rk.data = null;
    }
    rk.loading = false;
    render();
  }

  // 排位表的一格：可能是 label.value，也可能是 itemInfo（商品卡）
  function rkCell(cell) {
    const v = cell?.values?.[0];
    if (!v) return { text: "—" };
    if (v.itemInfo) return { text: v.itemInfo.name || v.itemInfo.sku || "—", info: v.itemInfo };
    if (v.label) return { text: v.label.value || "—", sub: v.label.subvalue || "" };
    return { text: "—" };
  }

  function renderRank(panel) {
    const rk = state.rk;

    // 输入区
    const bar = el("div", "display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px");
    const q = document.createElement("input");
    q.type = "search";
    q.placeholder = "🔍 输入搜索词（例如 сумка женская）";
    q.value = rk.query;
    q.setAttribute("style", "flex:1;min-width:220px;border:1px solid #dbeafe;border-radius:6px;padding:5px 9px;font-size:12px;outline:none;background:#fff;color:#0f172a");
    q.addEventListener("input", () => { rk.query = q.value; });
    q.addEventListener("keydown", (e) => { if (e.key === "Enter") loadRank(1); });
    bar.appendChild(q);

    const sel = document.createElement("select");
    sel.setAttribute("style", "border:1px solid #dbeafe;border-radius:6px;padding:5px 8px;font-size:12px;background:#fff;color:#0f172a;max-width:200px");
    if (!rk.locations.length) sel.appendChild(new Option("（地区加载中…）", ""));
    rk.locations.forEach((l) => sel.appendChild(new Option(l.title, l.uuid)));
    sel.value = rk.uuid;
    sel.addEventListener("change", () => { rk.uuid = sel.value; });
    bar.appendChild(sel);

    const mine = document.createElement("label");
    mine.setAttribute("style", "display:flex;align-items:center;gap:4px;font-size:12px;color:#475569;cursor:pointer");
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = !!rk.onlyMine;
    cb.addEventListener("change", () => { rk.onlyMine = cb.checked; });
    mine.appendChild(cb); mine.appendChild(el("span", "", "只看我的商品"));
    bar.appendChild(mine);

    bar.appendChild(btn("显示结果", true, () => loadRank(1)));
    if (rk.data) bar.appendChild(btn("导出 CSV", false, exportRankCsv));
    panel.appendChild(bar);
    if (!rk.locations.length) loadLocations();

    if (rk.loading) { panel.appendChild(el("div", "padding:30px;text-align:center;color:#94a3b8;font-size:13px", "查询中…")); return; }
    if (rk.error) { panel.appendChild(el("div", "background:#fef2f2;border-radius:8px;padding:12px;font-size:12px;color:#b91c1c;line-height:1.7;word-break:break-all", rk.error)); return; }
    if (!rk.data) {
      panel.appendChild(el("div", "padding:24px;text-align:center;color:#94a3b8;font-size:13px", "输入一个搜索词，看你的商品在搜索结果里排第几"));
      return;
    }

    const headers = rk.data.headers || [];
    const items = rk.data.items || [];
    const total = Number(rk.data.totalNumberOfItems || items.length);
    const pages = Number(rk.data.totalPagesCount || 1);
    const cat = rk.data.categories?.[0]?.name || "";
    panel.appendChild(el("div", "font-size:11px;color:#64748b;margin-bottom:8px",
      `「${rk.query}」${cat ? " · 类目「" + cat + "」" : ""} · 共 ${total} 个结果 · 第 ${rk.page}/${pages} 页${rk.onlyMine ? " · 只看我的" : ""}`));

    const wrap = el("div", `max-height:${state.maximized ? "calc(100vh - 330px)" : "46vh"};overflow:auto;font-size:12px`);
    const widths = headers.map((h) => Math.min(160, Math.max(84, Number(h.styles?.width || 120))));
    const gridCols = widths.map((w) => w + "px").join(" ");
    const th = el("div", `display:grid;grid-template-columns:${gridCols};gap:6px;padding:6px 4px;border-bottom:1px solid #eef2f7;position:sticky;top:0;background:#fff;z-index:2;min-width:max-content`);
    headers.forEach((h) => {
      const active = rk.sortKey === h.key;
      const s = el("span", `font-weight:700;color:${active ? "#0ea5e9" : "#94a3b8"};cursor:${h.isSortable ? "pointer" : "default"};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:${h.styles?.horizontalAlignment === "right" ? "right" : "left"}`,
        h.title + (active ? (rk.sortDir === "desc" ? " ↓" : " ↑") : ""));
      s.title = h.subtitle ? `${h.title}（${h.subtitle}）` : h.title;
      if (h.isSortable) {
        s.onclick = () => {
          if (rk.sortKey === h.key) rk.sortDir = rk.sortDir === "desc" ? "asc" : "desc";
          else { rk.sortKey = h.key; rk.sortDir = "asc"; }
          loadRank(1);
        };
      }
      th.appendChild(s);
    });
    wrap.appendChild(th);

    if (!items.length) wrap.appendChild(el("div", "padding:16px;text-align:center;color:#c0c4cc", "没有查到结果"));
    items.forEach((it) => {
      const mineRow = it.isCurSellerItem;
      const tr = el("div", `display:grid;grid-template-columns:${gridCols};gap:6px;padding:5px 4px;border-bottom:1px solid #f8fafc;align-items:center;min-width:max-content;${mineRow ? "background:#f0fdf4;" : ""}`);
      headers.forEach((h, i) => {
        const c = rkCell(it.values?.[i]);
        if (c.info) {
          const cell = el("div", "display:flex;gap:8px;align-items:center;min-width:0");
          const img = document.createElement("img");
          img.setAttribute("style", "width:32px;height:32px;border-radius:5px;object-fit:cover;flex-shrink:0;background:#e2e8f0;border:1px solid #eef2f7;cursor:zoom-in");
          if (c.info.pictureUrl) {
            img.src = c.info.pictureUrl; img.loading = "lazy";
            img.addEventListener("mouseenter", (e) => showZoom(c.info.pictureUrl, c.info.name || c.info.sku, e));
            img.addEventListener("mousemove", moveZoom);
            img.addEventListener("mouseleave", hideZoom);
          }
          cell.appendChild(img);
          const txt = el("div", "min-width:0;line-height:1.3");
          txt.appendChild(el("div", "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#0f172a;font-weight:700;font-size:11px", c.info.name || c.info.sku));
          txt.appendChild(el("div", "font-size:10px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap",
            `${c.info.sellerName || ""}${mineRow ? " · 我的商品" : ""} · SKU ${c.info.sku || ""}`));
          cell.appendChild(txt);
          tr.appendChild(cell);
        } else {
          const right = h.styles?.horizontalAlignment === "right";
          const strong = /位置|分数/.test(h.title);
          tr.appendChild(el("span", `color:${strong ? "#0f172a" : "#475569"};font-weight:${strong ? 800 : 400};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:${right ? "right" : "left"}`, c.text));
        }
      });
      wrap.appendChild(tr);
    });
    panel.appendChild(wrap);

    const pager = el("div", "display:flex;gap:6px;align-items:center;justify-content:center;margin-top:8px");
    pager.appendChild(btn("⏮ 首页", false, () => loadRank(1)));
    pager.appendChild(btn("◀ 上一页", false, () => loadRank(Math.max(1, rk.page - 1))));
    pager.appendChild(el("span", "font-size:12px;color:#475569", `${rk.page} / ${pages}`));
    pager.appendChild(btn("下一页 ▶", false, () => loadRank(Math.min(pages, rk.page + 1))));
    pager.appendChild(btn("末页 ⏭", false, () => loadRank(pages)));
    panel.appendChild(pager);

    panel.appendChild(el("div", "font-size:11px;color:#c0c4cc;margin-top:8px;line-height:1.6",
      `数据源与 Ozon「分析 → 搜索可见性 → 什么影响搜索结果中的位置」同一接口。绿色行 = 你自己的商品。v${VERSION}`));
  }

  function exportRankCsv() {
    const rk = state.rk;
    const headers = rk.data?.headers || [];
    const items = rk.data?.items || [];
    if (!items.length) return;
    const head = headers.map((h) => h.title);
    const body = items.map((it) => headers.map((h, i) => {
      const c = rkCell(it.values?.[i]);
      return c.info ? `${c.info.name} (SKU ${c.info.sku} / ${c.info.sellerName})`.replace(/[\r\n,]/g, " ") : String(c.text).replace(/[\r\n,]/g, " ");
    }));
    const csv = "\ufeff" + [head, ...body].map((x) => x.join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `Ozon_查词排位_${String(rk.query).slice(0, 20)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ===== 挂载 =====
  function looksLikeConsole() {
    const p = location.pathname || "";
    if (p.startsWith("/app") || p.startsWith("/seller")) return true;
    return Boolean(detectCompanyId());   // 中国站的营销落地页没有 vuex/cookie，就不注入
  }

  function mount() {
    if (document.getElementById(HOST_ID)) return;
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("style", "position:fixed;z-index:2147483600;right:18px;bottom:18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        #of-btn{position:fixed;right:18px;bottom:18px;z-index:2;background:linear-gradient(135deg,#0ea5e9,#0369a1);color:#fff;border:none;border-radius:20px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 4px 12px rgba(3,105,161,.4)}
        #of-panel{position:fixed;right:18px;bottom:62px;z-index:1;width:800px;max-width:94vw;max-height:82vh;overflow:auto;background:#f0f2f5;border-radius:12px;padding:12px;box-shadow:0 10px 40px rgba(0,0,0,.22)}
        #of-panel,#of-panel *{box-sizing:border-box}
        #of-zoom{position:fixed;left:0;top:0;z-index:9;display:none;pointer-events:none;background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;box-shadow:0 14px 44px rgba(15,23,42,.3)}
        #of-zoom img{display:block;width:260px;height:260px;object-fit:contain;background:#f8fafc}
        #of-zoom .ofz-cap{font-size:11px;color:#334155;padding:6px 9px;line-height:1.45;max-width:260px;border-top:1px solid #eef2f7}
      </style>
      <button id="of-btn">📊 Ozon 我的商品销售</button>
      <div id="of-panel" style="display:none"></div>
      <div id="of-zoom"><img alt=""><div class="ofz-cap"></div></div>
    `;
    document.documentElement.appendChild(host);
    zoomEl = root.getElementById("of-zoom");

    // 折叠/展开统一走这里：改 state 后交给 render() 写 display，避免两处样式打架
    const toggle = (next) => {
      state.open = next === undefined ? !state.open : Boolean(next);
      if (!state.open) hideZoom();
      const b = root.getElementById("of-btn");
      if (b) b.textContent = state.open ? "📊 收起数据面板" : "📊 Ozon 我的商品销售";
      if (state.open && !state.data) load(); else render();
    };
    window.__ozonFunnelToggle__ = toggle;
    root.getElementById("of-btn").addEventListener("click", () => toggle());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.open && !state.search) toggle(false);
    }, true);

    loadPrefs();
  }

  // 营销落地页不注入；控制台可能晚一点才写好 vuex，所以重试几次
  let tries = 0;
  const tryMount = () => {
    if (document.getElementById(HOST_ID)) return;
    if (looksLikeConsole()) { mount(); return; }
    tries += 1;
    if (tries <= 10) setTimeout(tryMount, 1500);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tryMount, { once: true });
  else tryMount();
})();
