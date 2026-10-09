/**
 * Ozon 我的商品销售 / 销售漏斗（独立插件）
 *
 * 背景：「我的分析 → 我的商品销售」里不少列被前端标成 Premium 专属，
 *      免费号点「销售漏斗」标签只会弹订阅引导，列停在加载骨架。
 *      但这些列的数据其实由 Ozon 自己的接口提供，免费号直接就能拿到。
 *
 * 本插件不做任何"伪造会员状态"的事（那类做法违反 ToS、会被风控盯上，
 * 而且正是它把你页面弹回销售漏斗的）。它只用当前登录会话读 Ozon 自己返回的真实数据：
 *   POST /api/site/seller-analytics/charts/v3/table/totals   → 总计与平均值
 *   POST /api/site/seller-analytics/charts/v3/table/by_sku   → 按 SKU 明细
 * 关键请求头 x-o3-company-id = 当前登录账号的 company_id（= 店铺 Client-Id）。
 *
 * METRIC_DEFS 里的 18 个指标是逐个探测出来的可用集合；其余（price_index / drr /
 * reviews_count / rating / returns 等）接口直接 400，属真·会员专属，拿不到。
 */
(function () {
  "use strict";
  if (window.__ozonFunnelStandaloneInjected) return;
  window.__ozonFunnelStandaloneInjected = true;

  const VERSION = "1.1.1";
  const HOST_ID = "__ozon_funnel_host";

  // snake_case 指标名 → 接口返回的 camelCase 字段名
  const respKey = (m) => m.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

  const METRIC_DEFS = {
    // ── 销售 ──
    revenue: { label: "已订购金额(销售价)", fmt: "money" },
    sold_revenue: { label: "已订购金额(最低价)", fmt: "money" },
    ordered_units: { label: "已订购件数", fmt: "int" },
    delivered_units: { label: "已送达件数", fmt: "int" },
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
      metrics: ["revenue", "sold_revenue", "ordered_units", "delivered_units", "avg_price", "avg_sold_price",
        "total_views", "conv_views_to_order", "discount_share_of_median_price"],
    },
    funnel: {
      label: "销售漏斗",
      metrics: ["search_position", "search_views", "pdp_views", "conv_pdp_views_to_cart", "hits_pdp_to_cart",
        "conv_search_views_to_cart", "hits_search_to_cart", "total_views", "conv_total_views_to_cart",
        "total_hits_to_cart", "ordered_units", "revenue"],
    },
    all: { label: "全部指标", metrics: Object.keys(METRIC_DEFS) },
  };
  const ALL_METRICS = Object.keys(METRIC_DEFS);

  const state = {
    open: false, loading: false, days: 7, data: null, totals: null, error: "",
    ozonClientId: "", sortKey: "revenue", sortDir: "desc", maximized: false, group: "funnel",
  };

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
        "x-o3-company-id": state.ozonClientId,
        "x-o3-app-name": "seller-ui",
        // 只能是 zh-Hans / ru / en：传 zh-CN 后端不认，productInfo 的
        // name / article / image 会全部返回空字符串（踩过）
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
    state.ozonClientId = detectCompanyId();
    state.loading = true;
    state.error = "";
    render();
    if (!state.ozonClientId) {
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
    const PAGE_SIZE = 50;   // 接口 limit 上限 50
    const PAGE_MAX = 8;
    try {
      const totals = await callApi("/api/site/seller-analytics/charts/v3/table/totals", { ...base, metrics: ALL_METRICS });
      const raw = [];
      for (let page = 0; page < PAGE_MAX; page += 1) {
        const r = await callApi("/api/site/seller-analytics/charts/v3/table/by_sku", {
          ...base,
          previous_period: { date_from: fmtDate(prevFrom), date_to: fmtDate(prevTo) },
          limit: String(PAGE_SIZE),
          offset: String(page * PAGE_SIZE),
          metrics: ALL_METRICS,
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
        items: raw.map((it) => {
          const row = {
            sku: String(it?.productInfo?.sku || ""),
            name: it?.productInfo?.name || "",
            article: it?.productInfo?.article || "",
            image: it?.productInfo?.image || "",
          };
          for (const m of ALL_METRICS) row[respKey(m)] = it?.metrics?.[respKey(m)];
          return row;
        }),
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

  function currentMetrics() { return GROUPS[state.group]?.metrics || ALL_METRICS; }

  function sortedItems() {
    const list = [...(state.data?.items || [])];
    const k = state.sortKey;
    const dir = state.sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => (n0(a[k]) - n0(b[k])) * dir || n0(b.revenue) - n0(a.revenue));
    return list;
  }

  function exportCsv() {
    const rows = sortedItems();
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
    a.download = `Ozon_${GROUPS[state.group].label}_${state.data.date_from}_${state.data.date_to}.csv`;
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

  function render() {
    const host = document.getElementById(HOST_ID);
    if (!host) return;
    const panel = host.shadowRoot.getElementById("of-panel");
    if (!panel) return;
    panel.innerHTML = "";
    // 注意：setAttribute("style") 会整体覆盖内联样式，所以 display 必须一起写进来。
    //   之前把 display 只在按钮回调里设，随后 render() 一覆盖就被冲掉 →
    //   「收起」点了没反应、面板关不上。
    const pos = state.maximized
      ? "position:fixed;left:0;top:0;width:100vw;height:100vh;max-width:100vw;max-height:100vh;overflow:auto;background:#f0f2f5;padding:14px 18px;border-radius:0;box-shadow:none;z-index:1"
      : "position:fixed;right:18px;bottom:62px;z-index:1;width:780px;max-width:94vw;max-height:82vh;overflow:auto;background:#f0f2f5;border-radius:12px;padding:12px;box-shadow:0 10px 40px rgba(0,0,0,.22)";
    panel.setAttribute("style", `display:${state.open ? "block" : "none"};` + pos);

    // 头部
    const head = el("div", "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px");
    head.appendChild(el("span", "font-size:15px;font-weight:800;color:#0f172a", "📊 Ozon 我的商品销售"));
    if (state.ozonClientId) head.appendChild(el("span", "font-size:11px;color:#0f766e;background:#ccfbf1;padding:2px 7px;border-radius:10px;font-weight:700", "账号 " + state.ozonClientId));
    if (state.data) head.appendChild(el("span", "font-size:11px;color:#94a3b8", `${state.data.date_from} ~ ${state.data.date_to} · ${state.data.items.length} 个 SKU`));
    head.appendChild(el("span", "flex:1"));
    head.appendChild(btn("刷新", false, load));
    head.appendChild(btn(state.maximized ? "🗗 还原" : "⛶ 最大化", false, () => { state.maximized = !state.maximized; render(); }, "横向铺满整个屏幕"));
    head.appendChild(btn("导出 CSV", false, exportCsv));
    head.appendChild(btn("收起", false, () => {
      if (window.__ozonFunnelToggle__) window.__ozonFunnelToggle__(false);
      else { state.open = false; render(); }
    }, "收起面板（快捷键 Esc）"));
    panel.appendChild(head);

    // 日期
    const bar = el("div", "display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px");
    [["today", "今天"], ["yesterday", "昨天"], [7, "近7天"], [14, "近14天"], [28, "近28天"], [30, "近30天"]].forEach(([v, label]) => {
      bar.appendChild(btn(label, state.days === v, () => { state.days = v; load(); }));
    });
    panel.appendChild(bar);

    // 指标分组
    const groups = el("div", "display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px");
    groups.appendChild(el("span", "font-size:11px;color:#94a3b8", "指标组："));
    for (const [key, g] of Object.entries(GROUPS)) {
      groups.appendChild(btn(`${g.label}(${g.metrics.length})`, state.group === key, () => { state.group = key; render(); }));
    }
    groups.appendChild(el("span", "font-size:11px;color:#c0c4cc", `· 免费可用共 ${ALL_METRICS.length} 个指标`));
    panel.appendChild(groups);

    if (state.loading) { panel.appendChild(el("div", "padding:30px;text-align:center;color:#94a3b8;font-size:13px", "加载中…")); return; }
    if (state.error) {
      panel.appendChild(el("div", "background:#fef2f2;border-radius:8px;padding:12px;font-size:12px;color:#b91c1c;line-height:1.7;word-break:break-all", state.error));
      return;
    }
    if (!state.data) return;

    // 总计卡：取当前分组前 6 个指标
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

    // 明细表
    const ms = currentMetrics();
    const rows = sortedItems();
    const wrap = el("div", `max-height:${state.maximized ? "calc(100vh - 300px)" : "52vh"};overflow:auto;font-size:12px`);
    const gridCols = "minmax(240px,1.6fr) " + ms.map(() => "104px").join(" ");
    const th = el("div", `display:grid;grid-template-columns:${gridCols};gap:6px;padding:6px 4px;border-bottom:1px solid #eef2f7;position:sticky;top:0;background:#fff;z-index:2`);
    th.appendChild(el("span", "color:#94a3b8;font-weight:700", "商品"));
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

    if (!rows.length) wrap.appendChild(el("div", "padding:16px;text-align:center;color:#c0c4cc", "所选区间没有数据"));
    rows.forEach((r) => {
      const tr = el("div", `display:grid;grid-template-columns:${gridCols};gap:6px;padding:5px 4px;border-bottom:1px solid #f8fafc;align-items:center`);
      const cell = el("div", "display:flex;gap:8px;align-items:center;min-width:0");
      const img = document.createElement("img");
      img.setAttribute("style", "width:34px;height:34px;border-radius:5px;object-fit:cover;flex-shrink:0;background:#e2e8f0;border:1px solid #eef2f7");
      if (r.image) { img.src = r.image; img.loading = "lazy"; }
      img.title = r.name || r.sku;
      cell.appendChild(img);
      const txt = el("div", "min-width:0;line-height:1.35");
      txt.appendChild(el("div", "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#0f172a;font-weight:700", r.name || r.sku));
      txt.appendChild(el("div", "font-size:10px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", `货号 ${r.article || "—"} · SKU ${r.sku}`));
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

    panel.appendChild(el("div", "font-size:11px;color:#c0c4cc;margin-top:8px;line-height:1.6",
      `数据取自 Ozon 后台同款接口（页面会话），未伪造任何会员状态。price_index / drr / 评分 / 评价数 / 退货 等接口会拒绝，属真·会员专属。v${VERSION}`));
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
        #of-panel{position:fixed;right:18px;bottom:62px;z-index:1;width:780px;max-width:94vw;max-height:82vh;overflow:auto;background:#f0f2f5;border-radius:12px;padding:12px;box-shadow:0 10px 40px rgba(0,0,0,.22)}
        #of-panel,#of-panel *{box-sizing:border-box}
      </style>
      <button id="of-btn">📊 Ozon 我的商品销售</button>
      <div id="of-panel" style="display:none"></div>
    `;
    document.documentElement.appendChild(host);

    // 折叠/展开统一走这里：改 state 后交给 render() 写 display，避免两处样式打架
    const toggle = (next) => {
      state.open = next === undefined ? !state.open : Boolean(next);
      const b = root.getElementById("of-btn");
      if (b) b.textContent = state.open ? "📊 收起数据面板" : "📊 Ozon 我的商品销售";
      if (state.open && !state.data) load(); else render();
    };
    window.__ozonFunnelToggle__ = toggle;

    root.getElementById("of-btn").addEventListener("click", () => toggle());

    // 最大化铺满时不好找按钮，支持 Esc 收起
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.open) toggle(false);
    }, true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})();
