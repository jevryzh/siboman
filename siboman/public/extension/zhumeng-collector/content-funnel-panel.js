/**
 * 逐梦 ERP · 销售漏斗面板（注入 seller.ozon.ru 后台分析页）
 *
 * 为什么需要它：Ozon 后台 /app/analytics/graphs 的「销售漏斗」是 Premium 专属
 * （点标签页只弹订阅引导，列一直停在加载骨架）。同样的数据能通过 Seller API
 * /v1/analytics/data 免费取到，所以这里在页面上挂一个浮层，直接展示
 * 展示 → 详情浏览 → 加购 → 下单 的漏斗与按 SKU 明细。
 *
 * 取数链路：本脚本 → background.js(erpFunnel) → ERP /api/ozon/analytics/funnel
 *          → Ozon Seller API。插件 token 只放行「token 里店铺作用域」那家店。
 */
(function () {
  "use strict";
  if (window.__zhumengFunnelPanelInjected) return;
  window.__zhumengFunnelPanelInjected = true;

  const VERSION = "2.2.9.126";
  const HOST_ID = "__zhumeng_funnel_host";

  const fmtInt = (v) => Number(v || 0).toLocaleString("zh-CN");
  const fmtPct = (v) => Number(v || 0).toFixed(2) + "%";
  const fmtMoney = (v) => "₽ " + Number(v || 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  const pad = (n) => String(n).padStart(2, "0");
  const dayStr = (offsetDays) => {
    const d = new Date(Date.now() - offsetDays * 86400e3);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  const state = { open: false, loading: false, days: 7, data: null, error: "", ozonClientId: "" };

  // 读取「当前登录的 Ozon 账号」= company_id，也就是 ERP 里的店铺 Client-Id。
  // 内容脚本跑在 isolated world，读不到页面的 window.__companyId，
  // 但 localStorage 和 document.cookie 是跨 world 共享的，所以从这两处取。
  function detectCompanyId() {
    try {
      const v = JSON.parse(localStorage.getItem("vuex") || "{}");
      const id = v && v.user && v.user.contentId;
      if (id) return String(id);
    } catch (_e) { /* 忽略 */ }
    const m = document.cookie.match(/(?:^|;\s*)sc_company_id=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }

  function send(action, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action, ...(payload || {}) }, (resp) => {
          if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
          resolve(resp || { ok: false, error: "插件后台无响应" });
        });
      } catch (e) { resolve({ ok: false, error: e.message || String(e) }); }
    });
  }

  async function load() {
    state.loading = true; state.error = ""; render();
    state.ozonClientId = detectCompanyId();
    const resp = await send("erpFunnel", {
      ozonClientId: state.ozonClientId,
      dateFrom: dayStr(state.days - 1),
      dateTo: dayStr(0),
      limit: 200,
    });
    state.loading = false;
    if (resp?.ok && resp.data?.success) { state.data = resp.data; state.error = ""; }
    else { state.data = null; state.error = resp?.error || resp?.data?.error || "取数失败"; }
    render();
  }

  function el(tag, style, text) {
    const e = document.createElement(tag);
    if (style) e.setAttribute("style", style);
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function render() {
    const host = document.getElementById(HOST_ID);
    if (!host) return;
    const root = host.shadowRoot;
    const panel = root.getElementById("zm-panel");
    if (!panel) return;
    panel.innerHTML = "";

    const d = state.data;
    const card = (children) => {
      const c = el("div", "background:#fff;border-radius:10px;padding:12px 14px;margin-bottom:10px;box-shadow:0 1px 3px rgba(0,0,0,.06)");
      children.forEach((x) => c.appendChild(x));
      return c;
    };

    // 头部
    const head = el("div", "display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap");
    head.appendChild(el("div", "font-size:15px;font-weight:800;color:#0f172a", "📉 销售漏斗"));
    if (d?.store_name) head.appendChild(el("span", "font-size:12px;color:#0f766e;background:#ccfbf1;padding:2px 8px;border-radius:10px;font-weight:700", "本页账号 → " + d.store_name));
    if (state.ozonClientId) head.appendChild(el("span", "font-size:11px;color:#94a3b8", "Client-Id " + state.ozonClientId));
    if (d) head.appendChild(el("span", "font-size:11px;color:#94a3b8", `${d.date_from} ~ ${d.date_to}`));
    head.appendChild(el("span", "flex:1"));
    const refresh = el("button", "background:#409eff;color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer", "刷新");
    refresh.onclick = load;
    head.appendChild(refresh);
    const close = el("button", "background:#f1f5f9;color:#475569;border:none;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer", "收起");
    close.onclick = () => { state.open = false; render(); };
    head.appendChild(close);
    panel.appendChild(head);

    // 日期区间
    const ranges = el("div", "display:flex;gap:6px;margin-bottom:10px");
    [7, 14, 28, 30].forEach((n) => {
      const active = state.days === n;
      const b = el("button",
        `border:1px solid ${active ? "#409eff" : "#dbeafe"};background:${active ? "#ecf5ff" : "#fff"};color:${active ? "#409eff" : "#64748b"};border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer`,
        `近 ${n} 天`);
      b.onclick = () => { state.days = n; load(); };
      ranges.appendChild(b);
    });
    panel.appendChild(ranges);

    if (state.loading) {
      panel.appendChild(el("div", "padding:24px;text-align:center;color:#94a3b8;font-size:13px", "加载中…"));
      return;
    }
    if (state.error) {
      const box = card([
        el("div", "font-size:13px;font-weight:700;color:#dc2626;margin-bottom:6px", "取数失败"),
        el("div", "font-size:12px;color:#64748b;line-height:1.7;word-break:break-all", state.error),
        el("div", "font-size:12px;color:#94a3b8;line-height:1.7;margin-top:6px", "若提示缺少 token，请到 ERP「店铺管理」点一下插件授权/刷新，或在该店铺页授权一次。"),
      ]);
      panel.appendChild(box);
      return;
    }
    if (!d) return;

    // 漏斗
    const t = d.totals || {};
    const cv = d.conversion || {};
    const base = Math.max(1, Number(t.impressions || 0));
    const stages = [
      { label: "展示（搜索和目录）", value: t.impressions, color: "#409eff", extra: "" },
      { label: "进入商品详情页", value: t.pdp_views, color: "#67c23a", extra: `转化 ${fmtPct(cv.view_rate)}` },
      { label: "加入购物车", value: t.tocart, color: "#e6a23c", extra: `转化 ${fmtPct(cv.cart_rate)}` },
      { label: "下单", value: t.orders, color: "#f56c6c", extra: `转化 ${fmtPct(cv.order_rate)}` },
    ];
    const funnelChildren = [];
    stages.forEach((s, i) => {
      const row = el("div", "margin-bottom:10px");
      const line = el("div", "display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px");
      line.appendChild(el("span", "color:#606266;font-weight:600", `${i + 1}. ${s.label}`));
      const right = el("span", "");
      right.appendChild(el("b", "font-size:15px;color:#0f172a", fmtInt(s.value)));
      if (s.extra) right.appendChild(el("span", "font-size:11px;color:#e6a23c;margin-left:6px", s.extra));
      line.appendChild(right);
      row.appendChild(line);
      const track = el("div", "height:12px;background:#f0f2f5;border-radius:6px;overflow:hidden");
      const bar = el("div", `height:100%;border-radius:6px;background:${s.color};width:${Math.max(2, Math.min(100, (Number(s.value || 0) / base) * 100))}%`);
      track.appendChild(bar);
      row.appendChild(track);
      funnelChildren.push(row);
    });
    panel.appendChild(card(funnelChildren));

    // 汇总
    const summary = el("div", "display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:10px");
    [["销售额", fmtMoney(t.revenue), "#67c23a"], ["整体转化率", fmtPct(cv.cr), "#409eff"],
     ["下单件数", fmtInt(t.orders), "#0f172a"], ["类目平均位置", Number(t.position_category || 0).toFixed(2), "#e6a23c"]].forEach(([k, v, c]) => {
      const box = el("div", "background:#f8fafc;border-radius:8px;padding:8px 10px");
      box.appendChild(el("div", "font-size:11px;color:#94a3b8", k));
      box.appendChild(el("div", `font-size:16px;font-weight:800;color:${c};margin-top:2px`, v));
      summary.appendChild(box);
    });
    panel.appendChild(summary);

    // Top SKU
    const items = (d.items || []).slice(0, 30);
    const table = el("div", "max-height:250px;overflow:auto;font-size:12px");
    const th = el("div", "display:grid;grid-template-columns:1fr 60px 60px 50px 70px;gap:6px;padding:6px 4px;border-bottom:1px solid #eef2f7;color:#94a3b8;font-weight:700;position:sticky;top:0;background:#fff");
    ["商品", "展示", "详情", "下单", "销售额"].forEach((x) => th.appendChild(el("span", "text-align:right;overflow:hidden;text-overflow:ellipsis", x)));
    table.appendChild(th);
    if (!items.length) table.appendChild(el("div", "padding:14px;text-align:center;color:#c0c4cc", "所选区间没有数据"));
    items.forEach((x) => {
      const tr = el("div", "display:grid;grid-template-columns:1fr 60px 60px 50px 70px;gap:6px;padding:5px 4px;border-bottom:1px solid #f8fafc;align-items:center");
      const name = el("span", "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#0f172a", x.local_name || x.name || x.sku);
      name.title = `${x.local_name || x.name || ""}\nSKU ${x.sku} · 货号 ${x.offer_id || "-"}`;
      tr.appendChild(name);
      [fmtInt(x.impressions), fmtInt(x.pdp_views), fmtInt(x.orders), fmtMoney(x.revenue)].forEach((v, i) => {
        tr.appendChild(el("span", `text-align:right;color:${i === 3 ? "#67c23a" : "#475569"};font-weight:${i === 3 ? 700 : 400}`, v));
      });
      table.appendChild(tr);
    });
    const tableCard = card([el("div", "font-size:13px;font-weight:700;color:#0f172a;margin-bottom:6px", `按 SKU（前 ${items.length} 条 / 共 ${d.item_count || 0} 条）`), table]);
    panel.appendChild(tableCard);

    panel.appendChild(el("div", "font-size:11px;color:#94a3b8;line-height:1.7;margin-top:2px",
      "数据来自 Ozon Seller API /v1/analytics/data（不依赖 Premium）。插件 " + VERSION + "。"));
    panel.appendChild(el("div", "font-size:11px;color:#94a3b8;line-height:1.7;margin-top:4px",
      "自动跟随本页登录的 Ozon 账号（按 Client-Id 匹配 ERP 店铺）；若提示「ERP 里没有对应店铺」，请先在「店铺管理」添加该账号。"));
  }

  function mount() {
    if (document.getElementById(HOST_ID)) return;
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("style", "position:fixed;z-index:2147483600;right:18px;bottom:18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        #zm-btn{position:fixed;right:18px;bottom:18px;z-index:2;background:linear-gradient(135deg,#409eff,#337ecc);color:#fff;border:none;border-radius:20px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 4px 12px rgba(64,158,255,.4)}
        #zm-panel{position:fixed;right:18px;bottom:62px;z-index:1;width:420px;max-height:78vh;overflow:auto;background:#f0f2f5;border-radius:12px;padding:12px;box-shadow:0 10px 40px rgba(0,0,0,.22)}
        #zm-panel *{box-sizing:border-box}
      </style>
      <button id="zm-btn">📉 逐梦 · 销售漏斗</button>
      <div id="zm-panel" style="display:none"></div>
    `;
    document.documentElement.appendChild(host);
    const btn = root.getElementById("zm-btn");
    btn.addEventListener("click", () => {
      state.open = !state.open;
      root.getElementById("zm-panel").style.display = state.open ? "block" : "none";
      btn.textContent = state.open ? "📉 收起销售漏斗" : "📉 逐梦 · 销售漏斗";
      if (state.open && !state.data) load(); else render();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})();
