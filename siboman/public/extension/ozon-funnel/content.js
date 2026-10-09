/**
 * Ozon 销售漏斗（独立插件）
 *
 * 背景：Ozon 卖家后台「我的分析 → 我的商品销售」里的「销售漏斗」那几列
 *      （在搜索结果和目录中的位置 / 搜索结果和目录中的展示次数 / 商品卡片访问量 /
 *        从商品卡片添加到购物车的转化率 / 已订购金额）属于 Premium 专属，
 *       免费号点「销售漏斗」标签只会弹订阅引导，列一直停在加载骨架。
 *
 * 原理：这几列的数据其实由 Ozon 自己的接口提供，页面请求时带一个
 *      `x-o3-company-id` 头即可。本插件在页面里用当前登录会话直接调它，
 *      所以不需要 Premium、不需要 Api-Key、也不需要任何服务端。
 *
 * 接口（同源，用页面会话 cookie）：
 *   POST /api/site/seller-analytics/charts/v3/table/totals   → 总计与平均值
 *   POST /api/site/seller-analytics/charts/v3/table/by_sku   → 按 SKU 明细
 * 关键指标名（已实测）：
 *   search_position           在搜索结果和目录中的位置
 *   search_views              搜索结果和目录中的展示次数
 *   pdp_views                 商品卡片访问量
 *   conv_pdp_views_to_cart    从商品卡片添加到购物车的转化率（%）
 *   total_views               总访问量
 *   conv_total_views_to_cart  总访问→加购转化率（%）
 *   ordered_units / revenue   已订购件数 / 已订购金额
 *   conv_views_to_order       访问→下单转化率
 */
(function () {
  "use strict";
  if (window.__ozonFunnelStandaloneInjected) return;
  window.__ozonFunnelStandaloneInjected = true;

  const VERSION = "1.0.2";
  const HOST_ID = "__ozon_funnel_host";

  // ===== 指标定义（表头文案对齐 Ozon 后台）=====
  const METRICS = [
    "search_position",
    "search_views",
    "pdp_views",
    "conv_pdp_views_to_cart",
    "total_views",
    "conv_total_views_to_cart",
    "hits_pdp_to_cart",
    "ordered_units",
    "revenue",
  ];
  const COLUMNS = [
    { key: "searchPosition", label: "在搜索结果和目录中的位置", fmt: "int", w: "120px" },
    { key: "searchViews", label: "搜索结果和目录中的展示次数", fmt: "int", w: "140px" },
    { key: "pdpViews", label: "商品卡片访问量", fmt: "int", w: "110px" },
    { key: "convPdpViewsToCart", label: "详情页→加购转化率", fmt: "pct", w: "120px" },
    { key: "orderedUnits", label: "已订购件数", fmt: "int", w: "95px" },
    { key: "revenue", label: "已订购金额", fmt: "money", w: "120px" },
  ];

  const state = {
    open: false,
    loading: false,
    days: 7,
    data: null,
    totals: null,
    error: "",
    sortKey: "revenue",
    sortDir: "desc",
    companyId: "",
    maximized: false,
  };

  // ===== 工具 =====
  const pad = (n) => String(n).padStart(2, "0");
  const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const shiftDate = (base, days) => new Date(base.getTime() + days * 86400e3);
  const n0 = (v) => Number(v || 0);
  const fmtInt = (v) => n0(v).toLocaleString("zh-CN");
  const fmtMoney = (v) => "₽ " + n0(v).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  const fmtPct = (v) => (n0(v) ? n0(v).toFixed(2) + "%" : "—");
  const fmtBy = (fmt, v) => (fmt === "money" ? fmtMoney(v) : fmt === "pct" ? fmtPct(v) : fmtInt(v));

  // 当前登录的 Ozon 账号（company_id = 店铺 Client-Id）
  function detectCompanyId() {
    try {
      const v = JSON.parse(localStorage.getItem("vuex") || "{}");
      const id = v && v.user && v.user.contentId;
      if (id) return String(id);
    } catch (_e) { /* 忽略 */ }
    const m = document.cookie.match(/(?:^|;\s*)sc_company_id=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }

  function periodRange() {
    const to = new Date();
    if (state.days === "today") return { from: to, to };
    if (state.days === "yesterday") { const y = shiftDate(to, -1); return { from: y, to: y }; }
    return { from: shiftDate(to, -(Number(state.days) - 1)), to };
  }

  async function callApi(path, body) {
    const resp = await fetch(`https://seller.ozon.ru${path}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-o3-company-id": state.companyId,
        "x-o3-app-name": "seller-ui",
        // 必须是 zh-Hans / ru / en 之一：传 zh-CN 这种后端不认的语言时，
        // productInfo 的 name / article / image 会全部返回空字符串（踩过）。
        "x-o3-language": "zh-Hans",
        "x-o3-page-type": "analytics_graph",
      },
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

  async function load() {
    state.companyId = detectCompanyId();
    state.loading = true;
    state.error = "";
    render();
    if (!state.companyId) {
      state.loading = false;
      state.error = "读不到当前登录的 Ozon 账号（company_id）。请确认已登录 seller.ozon.ru 后刷新页面。";
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
    // 该接口 limit 上限 50，要更多就翻页（最多 PAGE_MAX 页，避免打太多请求）
    const PAGE_SIZE = 50;
    const PAGE_MAX = 8;
    try {
      const totals = await callApi("/api/site/seller-analytics/charts/v3/table/totals", { ...base, metrics: METRICS });
      const raw = [];
      for (let page = 0; page < PAGE_MAX; page += 1) {
        const r = await callApi("/api/site/seller-analytics/charts/v3/table/by_sku", {
          ...base,
          previous_period: { date_from: fmtDate(prevFrom), date_to: fmtDate(prevTo) },
          limit: String(PAGE_SIZE),
          offset: String(page * PAGE_SIZE),
          metrics: METRICS,
          sort: { key: "revenue_sort", order: "desc" },
        });
        const items = r?.items || [];
        raw.push(...items);
        if (items.length < PAGE_SIZE) break;
      }
      state.totals = totals?.metrics || null;
      state.data = {
        date_from: fmtDate(from),
        date_to: fmtDate(to),
        items: raw.map((it) => ({
          sku: String(it?.productInfo?.sku || ""),
          name: it?.productInfo?.name || "",
          article: it?.productInfo?.article || "",
          image: it?.productInfo?.image || "",
          ...(it?.metrics || {}),
        })),
      };
    } catch (e) {
      state.error = e?.message || String(e);
      state.data = null;
      state.totals = null;
    } finally {
      state.loading = false;
      render();
    }
  }

  function exportCsv() {
    const rows = sortedItems();
    if (!rows.length) return;
    const head = ["Ozon SKU", "货号", "商品名", ...COLUMNS.map((c) => c.label), "总访问量", "总访问→加购转化率"];
    const body = rows.map((r) => [
      r.sku, r.article, String(r.name || "").replace(/[\r\n,]/g, " "),
      ...COLUMNS.map((c) => (c.fmt === "pct" ? n0(r[c.key]).toFixed(2) : n0(r[c.key]))),
      n0(r.totalViews), n0(r.convTotalViewsToCart).toFixed(2),
    ]);
    const csv = "\ufeff" + [head, ...body].map((r) => r.join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `Ozon销售漏斗_${state.data.date_from}_${state.data.date_to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function sortedItems() {
    const list = [...(state.data?.items || [])];
    const k = state.sortKey;
    const dir = state.sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => (n0(a[k]) - n0(b[k])) * dir);
    return list;
  }

  // ===== 渲染 =====
  function el(tag, style, text) {
    const e = document.createElement(tag);
    if (style) e.setAttribute("style", style);
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function render() {
    const host = document.getElementById(HOST_ID);
    if (!host) return;
    const panel = host.shadowRoot.getElementById("of-panel");
    if (!panel) return;
    panel.innerHTML = "";
    // 最大化：横向铺满整屏，纵向也占满，方便看长表格
    panel.setAttribute("style", state.maximized
      ? "position:fixed;left:0;top:0;width:100vw;height:100vh;max-width:100vw;max-height:100vh;overflow:auto;background:#f0f2f5;padding:14px 18px;border-radius:0;box-shadow:none;z-index:1"
      : "position:fixed;right:18px;bottom:62px;z-index:1;width:680px;max-width:94vw;max-height:82vh;overflow:auto;background:#f0f2f5;border-radius:12px;padding:12px;box-shadow:0 10px 40px rgba(0,0,0,.22)");

    // 头部
    const head = el("div", "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px");
    head.appendChild(el("span", "font-size:15px;font-weight:800;color:#0f172a", "📉 Ozon 销售漏斗"));
    if (state.companyId) head.appendChild(el("span", "font-size:11px;color:#0f766e;background:#ccfbf1;padding:2px 7px;border-radius:10px;font-weight:700", "账号 " + state.companyId));
    head.appendChild(el("span", "flex:1"));
    const btnRefresh = el("button", "background:#409eff;color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer", "刷新");
    btnRefresh.onclick = load;
    head.appendChild(btnRefresh);
    const btnMax = el("button", "background:#f1f5f9;color:#475569;border:none;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer", state.maximized ? "🗗 还原" : "⛶ 最大化");
    btnMax.title = state.maximized ? "还原成右下角浮层" : "横向铺满整个屏幕";
    btnMax.onclick = () => { state.maximized = !state.maximized; render(); };
    head.appendChild(btnMax);
    const btnCsv = el("button", "background:#f1f5f9;color:#475569;border:none;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer", "导出 CSV");
    btnCsv.onclick = exportCsv;
    head.appendChild(btnCsv);
    const btnClose = el("button", "background:#f1f5f9;color:#475569;border:none;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer", "收起");
    btnClose.onclick = () => { state.open = false; render(); };
    head.appendChild(btnClose);
    panel.appendChild(head);

    // 日期
    const ranges = el("div", "display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap");
    [["today", "今天"], ["yesterday", "昨天"], [7, "近 7 天"], [14, "近 14 天"], [28, "近 28 天"], [30, "近 30 天"]].forEach(([v, label]) => {
      const active = state.days === v;
      const b = el("button", `border:1px solid ${active ? "#409eff" : "#dbeafe"};background:${active ? "#ecf5ff" : "#fff"};color:${active ? "#409eff" : "#64748b"};border-radius:6px;padding:3px 9px;font-size:12px;cursor:pointer`, label);
      b.onclick = () => { state.days = v; load(); };
      ranges.appendChild(b);
    });
    if (state.data) ranges.appendChild(el("span", "font-size:11px;color:#94a3b8;align-self:center;margin-left:4px", `${state.data.date_from} ~ ${state.data.date_to}`));
    panel.appendChild(ranges);

    if (state.loading) { panel.appendChild(el("div", "padding:30px;text-align:center;color:#94a3b8;font-size:13px", "加载中…")); return; }
    if (state.error) {
      const box = el("div", "background:#fef2f2;border-radius:8px;padding:12px;font-size:12px;color:#b91c1c;line-height:1.7;word-break:break-all", state.error);
      panel.appendChild(box);
      return;
    }
    if (!state.data) return;

    // 总计
    if (state.totals) {
      const t = state.totals;
      const grid = el("div", "display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px");
      [
        ["展示次数", fmtInt(t.searchViews)],
        ["商品卡片访问量", fmtInt(t.pdpViews)],
        ["详情→加购转化率", fmtPct(t.convPdpViewsToCart)],
        ["搜索位次(平均)", fmtInt(t.searchPosition)],
        ["已订购金额", fmtMoney(t.revenue)],
        ["已订购件数", fmtInt(t.orderedUnits)],
      ].forEach(([k, v]) => {
        const c = el("div", "background:#f8fafc;border-radius:8px;padding:8px 10px");
        c.appendChild(el("div", "font-size:11px;color:#94a3b8", k));
        c.appendChild(el("div", "font-size:15px;font-weight:800;color:#0f172a;margin-top:2px", v));
        grid.appendChild(c);
      });
      panel.appendChild(grid);
    }

    // 明细表
    const rows = sortedItems();
    const wrap = el("div", `max-height:${state.maximized ? "calc(100vh - 250px)" : "56vh"};overflow:auto;font-size:12px`);
    const gridCols = "minmax(250px,1.7fr) " + COLUMNS.map((c) => c.w).join(" ");
    const th = el("div", `display:grid;grid-template-columns:${gridCols};gap:6px;padding:6px 4px;border-bottom:1px solid #eef2f7;position:sticky;top:0;background:#fff;z-index:1`);
    const thProd = el("span", "color:#94a3b8;font-weight:700", "商品");
    th.appendChild(thProd);
    COLUMNS.forEach((c) => {
      const active = state.sortKey === c.key;
      const span = el("span", `text-align:right;color:${active ? "#409eff" : "#94a3b8"};font-weight:700;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`, c.label + (active ? (state.sortDir === "desc" ? " ↓" : " ↑") : ""));
      span.title = "点击按此列排序";
      span.onclick = () => {
        if (state.sortKey === c.key) state.sortDir = state.sortDir === "desc" ? "asc" : "desc";
        else { state.sortKey = c.key; state.sortDir = "desc"; }
        render();
      };
      th.appendChild(span);
    });
    wrap.appendChild(th);
    if (!rows.length) wrap.appendChild(el("div", "padding:16px;text-align:center;color:#c0c4cc", "所选区间没有数据"));
    rows.forEach((r) => {
      const tr = el("div", `display:grid;grid-template-columns:${gridCols};gap:6px;padding:5px 4px;border-bottom:1px solid #f8fafc;align-items:center`);
      const p = el("div", "display:flex;gap:8px;align-items:center;min-width:0");
      const img = document.createElement("img");
      img.setAttribute("style", "width:34px;height:34px;border-radius:5px;object-fit:cover;flex-shrink:0;background:#e2e8f0;border:1px solid #eef2f7");
      if (r.image) { img.src = r.image; img.loading = "lazy"; }
      img.title = r.name || r.sku;
      p.appendChild(img);
      const txt = el("div", "min-width:0;line-height:1.35");
      txt.appendChild(el("div", "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#0f172a;font-weight:700", r.name || r.sku));
      txt.appendChild(el("div", "font-size:10px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", `货号 ${r.article || "—"} · SKU ${r.sku}`));
      p.appendChild(txt);
      tr.appendChild(p);
      COLUMNS.forEach((c) => {
        const v = fmtBy(c.fmt, r[c.key]);
        tr.appendChild(el("span", `text-align:right;color:${c.fmt === "money" ? "#0f766e" : "#475569"};font-weight:${c.fmt === "money" ? 700 : 400}`, v));
      });
      wrap.appendChild(tr);
    });
    panel.appendChild(wrap);
    panel.appendChild(el("div", "font-size:11px;color:#c0c4cc;margin-top:8px;line-height:1.6",
      `共 ${rows.length} 个 SKU。数据取自 Ozon 后台同款接口（页面会话），无需 Premium。v${VERSION}`));
  }

  // ===== 挂载 =====
  function mount() {
    if (document.getElementById(HOST_ID)) return;
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("style", "position:fixed;z-index:2147483600;right:18px;bottom:18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        #of-btn{position:fixed;right:18px;bottom:18px;z-index:2;background:linear-gradient(135deg,#0ea5e9,#0369a1);color:#fff;border:none;border-radius:20px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 4px 12px rgba(3,105,161,.4)}
        #of-panel{position:fixed;right:18px;bottom:62px;z-index:1;width:680px;max-width:94vw;max-height:82vh;overflow:auto;background:#f0f2f5;border-radius:12px;padding:12px;box-shadow:0 10px 40px rgba(0,0,0,.22)}
        /* 面板自身也必须 border-box：否则最大化时 100vw 再加左右 padding 会比屏幕更宽，
           最右一列（已订购金额）被裁掉 */
        #of-panel,#of-panel *{box-sizing:border-box}
      </style>
      <button id="of-btn">📉 Ozon 销售漏斗</button>
      <div id="of-panel" style="display:none"></div>
    `;
    document.documentElement.appendChild(host);
    const btn = root.getElementById("of-btn");
    btn.addEventListener("click", () => {
      state.open = !state.open;
      root.getElementById("of-panel").style.display = state.open ? "block" : "none";
      btn.textContent = state.open ? "📉 收起销售漏斗" : "📉 Ozon 销售漏斗";
      if (state.open && !state.data) load(); else render();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})();
