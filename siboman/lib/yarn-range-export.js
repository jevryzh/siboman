// Accio Work (2026-11-15)
// 「导出毛线订单区间统计」—— 按用户指定的起止订单号区间（含首尾），
// 聚合毛线色号数量，生成双 Sheet 的 Excel。
//
// Sheet1「毛线色号统计」：
//   - 顶部 3 行标题（标题 / 区间+计数摘要 / 导出日期）
//   - 马海毛表（色号 #NN）：色号 | 总个数(=数量×4) | 数量(个) | SKU
//   - 数量合计（马海毛） —— 粉底
//   - 金额（马海毛） = 数量合计 × 3.3
//   - 羊驼毛表（色号 #W开头）：色号 | 总个数(=数量×2) | 数量(个) | SKU
//   - 数量合计（羊驼毛） —— 粉底
//   - 金额（羊驼毛） = 数量合计 × 4.5 —— 绿底
//   - 总金额合计 = 两金额之和 —— 黄底
//
// Sheet2「毛线订单明细」：
//   - 订单号 | 已接收时间(精确到分) | 毛线明细(#NNxM, #WNNxM)
//   - 按接收时间降序；同时间 posting_number 升序；只列含毛线订单
//
// 入参：
//   orders: [{ posting_number, in_process_at, status, products: [{ offer_id, name, quantity }, ...] }]
//           外部保证：区间内已包含首尾两单，status=cancelled 的已剔除（但计数时要知道取消数）
//   meta:   { startPosting, endPosting, cancelledCount }
// 返回：
//   { buf: Buffer, summary: { validCount, cancelledCount, yarnOrderCount, moharQty, moharTotal, alpacaQty, alpacaTotal, moharAmount, alpacaAmount, totalAmount } }

// fflate 延迟到 buildYarnRangeXlsx 内按需 import，避免本地无依赖时阻塞纯函数单元测试

// ---------- 常量 ----------
const YARN_NAME_RE = /пряж/i;
export const MOHAR_PER_QTY = 4;     // 马海毛：1 绞 = 4 根
export const ALPACA_PER_QTY = 2;    // 羊驼毛：1 绞 = 2 根
export const MOHAR_UNIT_PRICE = 3.3;
export const ALPACA_UNIT_PRICE = 4.5;

// ---------- 色号解析 ----------
// offer_id 示例：
//   jz-260624fwg3-4736604207-01   → 色号 "01"  （马海毛，#NN）
//   ALPACA-YARN-W023-2PCS         → ❌ 这个最后一段是 "2PCS"，不是色号
//                                   实际色号是 "W023"（倒数第二段）
// 规则：优先取最后一段；若最后一段不是 `^\d+$` / `^W\d+$`，则向前回退一段。
export function extractColor(offerId) {
  const s = String(offerId || "").trim();
  if (!s) return "";
  const parts = s.split("-");
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i];
    if (/^\d+$/.test(seg)) return seg;                    // 纯数字 → 马海毛色号
    if (/^W\d+$/i.test(seg)) return seg.toUpperCase();    // W 开头 → 羊驼毛色号
  }
  return "";
}

export function colorKind(color) {
  if (!color) return "unknown";
  if (/^W\d+$/i.test(color)) return "alpaca";
  if (/^\d+$/.test(color)) return "mohar";
  return "unknown";
}

// 是否毛线商品
export function isYarnProduct(p) {
  return YARN_NAME_RE.test(String(p?.name || ""));
}

// ---------- 聚合 ----------
// 从 orders 聚合出：
//   - skuAgg: Map<sku, { color, kind, qty, name }>
//   - orderDetails: [{ posting_number, in_process_at, detailText }]（只含毛线订单）
export function aggregateYarnRange(orders) {
  const skuAgg = new Map();        // sku -> { color, kind, qty, name }
  const orderDetails = [];

  for (const order of orders || []) {
    const pn = String(order.posting_number || "").trim();
    if (!pn) continue;
    const products = Array.isArray(order.products) ? order.products : [];
    const perColor = new Map();    // color -> qty（本单内按色号合并）

    for (const p of products) {
      if (!isYarnProduct(p)) continue;
      const offerId = String(p.offer_id || "").trim();
      if (!offerId) continue;
      const color = extractColor(offerId);
      if (!color) continue;
      const kind = colorKind(color);
      if (kind === "unknown") continue;
      const qty = Number(p.quantity) || 1;

      // 全局 SKU 聚合
      const agg = skuAgg.get(offerId) || { color, kind, qty: 0, name: String(p.name || "") };
      agg.qty += qty;
      if (!agg.name && p.name) agg.name = String(p.name);
      skuAgg.set(offerId, agg);

      // 本单色号聚合（用于 Sheet2 明细）
      perColor.set(color, (perColor.get(color) || 0) + qty);
    }

    if (perColor.size > 0) {
      // 色号在订单明细里的顺序：按出现时的色号字典序（统一预览友好）
      const detailText = [...perColor.entries()]
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]), "en"))
        .map(([c, q]) => `#${c}x${q}`)
        .join(", ");
      orderDetails.push({
        posting_number: pn,
        in_process_at: order.in_process_at || null,
        detailText,
      });
    }
  }

  // Sheet2 排序：接收时间降序 → posting_number 升序
  orderDetails.sort((a, b) => {
    const ta = a.in_process_at ? new Date(a.in_process_at).getTime() : 0;
    const tb = b.in_process_at ? new Date(b.in_process_at).getTime() : 0;
    if (ta !== tb) return tb - ta;
    return String(a.posting_number).localeCompare(String(b.posting_number), "en");
  });

  return { skuAgg, orderDetails };
}

// 从 skuAgg 拆成马海毛行、羊驼毛行（各自按色号升序）
export function buildSkuRows(skuAgg) {
  const mohar = [];
  const alpaca = [];
  for (const [sku, agg] of skuAgg.entries()) {
    const row = {
      sku,
      color: agg.color,
      qty: agg.qty,
      totalCount: agg.kind === "mohar" ? agg.qty * MOHAR_PER_QTY : agg.qty * ALPACA_PER_QTY,
    };
    if (agg.kind === "mohar") mohar.push(row);
    else if (agg.kind === "alpaca") alpaca.push(row);
  }
  // 色号升序：
  //   马海毛是纯数字，按数值升序；
  //   羊驼毛是 W001/W023 之类，按字符串升序即可。
  mohar.sort((a, b) => Number(a.color) - Number(b.color) || a.sku.localeCompare(b.sku, "en"));
  alpaca.sort((a, b) => String(a.color).localeCompare(String(b.color), "en") || a.sku.localeCompare(b.sku, "en"));
  return { mohar, alpaca };
}

// ---------- 时间格式化：北京时间，精确到分 ----------
// 不依赖运行时 TZ：直接对 UTC 时间戳 +8h，再用 UTC getter 取各分量
export function formatBeijingMinute(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())} `
    + `${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`;
}

export function formatBeijingDate(iso) {
  if (!iso) return "";
  const s = formatBeijingMinute(iso);
  return s ? s.slice(0, 10) : "";
}

// ---------- XLSX 构建 ----------
// 简化版样式系统：
//   s=0 默认 / s=1 粗体居中 / s=2 表头（蓝底白字） / s=3 居中边框
//   s=4 粉底（数量合计行） / s=5 绿底（金额羊驼毛） / s=6 黄底（总金额合计）
//   s=7 居左边框
const XLSX_STYLES_XML = {
  numFmts: `<numFmts count="1"><numFmt numFmtId="164" formatCode="0.00"/></numFmts>`,
  fonts: `<fonts count="3">`
    + `<font><sz val="11"/><name val="Arial"/></font>`
    + `<font><b/><sz val="11"/><name val="Arial"/></font>`
    + `<font><b/><sz val="12"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>`
    + `</fonts>`,
  fills: `<fills count="7">`
    + `<fill><patternFill patternType="none"/></fill>`
    + `<fill><patternFill patternType="gray125"/></fill>`
    // s=2 蓝底（表头）
    + `<fill><patternFill patternType="solid"><fgColor rgb="FF4472C4"/><bgColor indexed="64"/></patternFill></fill>`
    // s=4 粉底（数量合计行）—— 对齐用户截图粉色
    + `<fill><patternFill patternType="solid"><fgColor rgb="FFF8CBAD"/><bgColor indexed="64"/></patternFill></fill>`
    // s=5 绿底（金额羊驼毛）
    + `<fill><patternFill patternType="solid"><fgColor rgb="FFC6E0B4"/><bgColor indexed="64"/></patternFill></fill>`
    // s=6 黄底（总金额合计）
    + `<fill><patternFill patternType="solid"><fgColor rgb="FFFFE699"/><bgColor indexed="64"/></patternFill></fill>`
    // s=3 粉底（金额马海毛行）
    + `<fill><patternFill patternType="solid"><fgColor rgb="FFF4B084"/><bgColor indexed="64"/></patternFill></fill>`
    + `</fills>`,
  borders: `<borders count="2">`
    + `<border><left/><right/><top/><bottom/><diagonal/></border>`
    + `<border>`
    +   `<left style="thin"><color rgb="FF9CA3AF"/></left>`
    +   `<right style="thin"><color rgb="FF9CA3AF"/></right>`
    +   `<top style="thin"><color rgb="FF9CA3AF"/></top>`
    +   `<bottom style="thin"><color rgb="FF9CA3AF"/></bottom>`
    +   `<diagonal/>`
    + `</border>`
    + `</borders>`,
  // cellXfs：各样式 index = 数组下标
  cellXfs: `<cellXfs count="9">`
    // 0 default
    + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
    // 1 粗体居中（标题）
    + `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>`
    // 2 表头（蓝底白字 + 边框 + 居中）
    + `<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>`
    // 3 居中边框（数据单元格）
    + `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>`
    // 4 粉底 + 粗体 + 边框 + 居中（数量合计）
    + `<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>`
    // 5 绿底 + 粗体 + 边框 + 居中（金额-羊驼毛）
    + `<xf numFmtId="164" fontId="1" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>`
    // 6 黄底 + 粗体 + 边框 + 居中（总金额合计）
    + `<xf numFmtId="164" fontId="1" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>`
    // 7 居左边框（SKU / 明细文本）
    + `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>`
    // 8 橙底 + 粗体 + 边框 + 居中（金额-马海毛，用橙色和羊驼毛的绿色做区分）
    + `<xf numFmtId="164" fontId="1" fillId="6" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>`
    + `</cellXfs>`,
};

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}
function colName(i) {
  let n = i + 1; let out = "";
  while (n > 0) { const m = (n - 1) % 26; out = String.fromCharCode(65 + m) + out; n = Math.floor((n - 1) / 26); }
  return out;
}

// 把一个二维行数组编译成 <row> 字符串
// rows 元素：{ cells: Array<{ v, s }>, height? }
// merges: Array<{ r1, c1, r2, c2 }>（1-based 行、0-based 列）
function compileSheet(rows, opts = {}) {
  const sheetRows = rows.map((row, ri) => {
    const cells = (row.cells || []).map((cell, ci) => {
      const ref = `${colName(ci)}${ri + 1}`;
      const sAttr = cell.s ? ` s="${cell.s}"` : "";
      if (cell.v == null || cell.v === "") return `<c r="${ref}"${sAttr}/>`;
      if (typeof cell.v === "number" && Number.isFinite(cell.v)) {
        return `<c r="${ref}"${sAttr}><v>${cell.v}</v></c>`;
      }
      return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${esc(cell.v)}</t></is></c>`;
    }).join("");
    const h = row.height;
    return `<row r="${ri + 1}"${h ? ` ht="${h}" customHeight="1"` : ""}>${cells}</row>`;
  }).join("");

  const cols = (opts.colWidths || []).map((w, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  const mergeXml = (opts.merges || []).length
    ? `<mergeCells count="${opts.merges.length}">`
      + opts.merges.map((m) => `<mergeCell ref="${colName(m.c1)}${m.r1}:${colName(m.c2)}${m.r2}"/>`).join("")
      + `</mergeCells>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + (cols ? `<cols>${cols}</cols>` : "")
    + `<sheetData>${sheetRows}</sheetData>`
    + mergeXml
    + `</worksheet>`;
}

export async function buildYarnRangeXlsx({ orders, meta }) {
  const { zipSync, strToU8 } = await import("fflate");
  const { skuAgg, orderDetails } = aggregateYarnRange(orders);
  const { mohar, alpaca } = buildSkuRows(skuAgg);

  // ---- 汇总数字 ----
  const moharQty = mohar.reduce((s, r) => s + r.qty, 0);
  const moharTotal = mohar.reduce((s, r) => s + r.totalCount, 0);
  const alpacaQty = alpaca.reduce((s, r) => s + r.qty, 0);
  const alpacaTotal = alpaca.reduce((s, r) => s + r.totalCount, 0);
  const moharAmount = Math.round(moharTotal * MOHAR_UNIT_PRICE * 100) / 100;
  const alpacaAmount = Math.round(alpacaTotal * ALPACA_UNIT_PRICE * 100) / 100;
  const totalAmount = Math.round((moharAmount + alpacaAmount) * 100) / 100;
  const yarnOrderCount = orderDetails.length;

  const summary = {
    validCount: meta.validCount || 0,
    cancelledCount: meta.cancelledCount || 0,
    yarnOrderCount,
    moharQty, moharTotal, alpacaQty, alpacaTotal,
    moharAmount, alpacaAmount, totalAmount,
  };

  // =========================================================
  // Sheet1「毛线色号统计」
  // =========================================================
  const sheet1Rows = [];
  const merges1 = [];

  // Row 1: 标题
  sheet1Rows.push({
    cells: [
      { v: "毛线订单区间统计（已剔除取消订单）", s: 1 },
      { v: "", s: 1 }, { v: "", s: 1 }, { v: "", s: 1 }, { v: "", s: 1 },
    ],
    height: 22,
  });
  merges1.push({ r1: 1, c1: 0, r2: 1, c2: 4 });

  // Row 2: 区间 + 统计
  const rangeText = `${meta.startPosting} ~ ${meta.endPosting} | 共${summary.validCount}个有效订单（取消${summary.cancelledCount}个）| 毛线${summary.yarnOrderCount}单`;
  sheet1Rows.push({
    cells: [{ v: rangeText, s: 1 }, { v: "", s: 1 }, { v: "", s: 1 }, { v: "", s: 1 }, { v: "", s: 1 }],
    height: 20,
  });
  merges1.push({ r1: 2, c1: 0, r2: 2, c2: 4 });

  // Row 3: 导出日期
  const exportDate = (() => {
    const bj = new Date(Date.now() + 8 * 3600 * 1000);
    return `${bj.getUTCFullYear()}/${String(bj.getUTCMonth() + 1).padStart(2, "0")}/${String(bj.getUTCDate()).padStart(2, "0")}`;
  })();
  sheet1Rows.push({
    cells: [{ v: exportDate, s: 1 }, { v: "", s: 1 }, { v: "", s: 1 }, { v: "", s: 1 }, { v: "", s: 1 }],
    height: 18,
  });
  merges1.push({ r1: 3, c1: 0, r2: 3, c2: 4 });

  // Row 4: 空
  sheet1Rows.push({ cells: [] });

  // ---- 马海毛表 ----
  // Row 5: 表头
  sheet1Rows.push({
    cells: [
      { v: "色号", s: 2 },
      { v: "总个数", s: 2 },
      { v: "数量(个)", s: 2 },
      { v: "SKU", s: 2 },
    ],
    height: 22,
  });

  for (const r of mohar) {
    sheet1Rows.push({
      cells: [
        { v: `#${r.color}`, s: 3 },
        { v: r.totalCount, s: 3 },
        { v: r.qty, s: 3 },
        { v: r.sku, s: 7 },
      ],
    });
  }

  // 数量合计（马海毛）
  const moharSumRow = sheet1Rows.length + 1;
  sheet1Rows.push({
    cells: [
      { v: "数量合计（马海毛）", s: 4 },
      { v: moharTotal, s: 4 },
      { v: moharQty, s: 4 },
      { v: "", s: 4 },
    ],
  });

  // 金额（马海毛）
  const moharAmtRow = sheet1Rows.length + 1;
  sheet1Rows.push({
    cells: [
      { v: "金额（马海毛）", s: 8 },
      { v: moharAmount, s: 8 },
      { v: "", s: 8 },
      { v: "", s: 8 },
    ],
  });
  merges1.push({ r1: moharAmtRow, c1: 1, r2: moharAmtRow, c2: 3 });

  // ---- 羊驼毛表 ----
  // 表头
  sheet1Rows.push({
    cells: [
      { v: "色号", s: 2 },
      { v: "总个数", s: 2 },
      { v: "数量(个)", s: 2 },
      { v: "SKU", s: 2 },
    ],
    height: 22,
  });

  for (const r of alpaca) {
    sheet1Rows.push({
      cells: [
        { v: `#${r.color}`, s: 3 },
        { v: r.totalCount, s: 3 },
        { v: r.qty, s: 3 },
        { v: r.sku, s: 7 },
      ],
    });
  }

  // 数量合计（羊驼毛）
  sheet1Rows.push({
    cells: [
      { v: "数量合计（羊驼毛）", s: 4 },
      { v: alpacaTotal, s: 4 },
      { v: alpacaQty, s: 4 },
      { v: "", s: 4 },
    ],
  });

  // 金额（羊驼毛）
  const alpacaAmtRow = sheet1Rows.length + 1;
  sheet1Rows.push({
    cells: [
      { v: "金额（羊驼毛）", s: 5 },
      { v: alpacaAmount, s: 5 },
      { v: "", s: 5 },
      { v: "", s: 5 },
    ],
  });
  merges1.push({ r1: alpacaAmtRow, c1: 1, r2: alpacaAmtRow, c2: 3 });

  // 总金额合计
  const totalAmtRow = sheet1Rows.length + 1;
  sheet1Rows.push({
    cells: [
      { v: "总金额合计", s: 6 },
      { v: totalAmount, s: 6 },
      { v: "", s: 6 },
      { v: "", s: 6 },
    ],
  });
  merges1.push({ r1: totalAmtRow, c1: 1, r2: totalAmtRow, c2: 3 });

  const sheet1Xml = compileSheet(sheet1Rows, {
    colWidths: [22, 12, 12, 34],
    merges: merges1,
  });

  // =========================================================
  // Sheet2「毛线订单明细」
  // =========================================================
  const sheet2Rows = [];
  sheet2Rows.push({
    cells: [
      { v: "订单号", s: 2 },
      { v: "已接收时间", s: 2 },
      { v: "毛线明细", s: 2 },
    ],
    height: 22,
  });
  for (const d of orderDetails) {
    sheet2Rows.push({
      cells: [
        { v: d.posting_number, s: 7 },
        { v: formatBeijingMinute(d.in_process_at), s: 3 },
        { v: d.detailText, s: 7 },
      ],
    });
  }
  const sheet2Xml = compileSheet(sheet2Rows, {
    colWidths: [22, 20, 32],
  });

  // =========================================================
  // 打包
  // =========================================================
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + XLSX_STYLES_XML.numFmts
    + XLSX_STYLES_XML.fonts
    + XLSX_STYLES_XML.fills
    + XLSX_STYLES_XML.borders
    + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
    + XLSX_STYLES_XML.cellXfs
    + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>`
    + `</styleSheet>`;

  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
      + `<Default Extension="xml" ContentType="application/xml"/>`
      + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
      + `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
      + `<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
      + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
      + `</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
      + `</Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
      + `<sheets>`
      + `<sheet name="毛线色号统计" sheetId="1" r:id="rId1"/>`
      + `<sheet name="毛线订单明细" sheetId="2" r:id="rId2"/>`
      + `</sheets>`
      + `</workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>`
      + `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>`
      + `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
      + `</Relationships>`,
    "xl/styles.xml": stylesXml,
    "xl/worksheets/sheet1.xml": sheet1Xml,
    "xl/worksheets/sheet2.xml": sheet2Xml,
  };
  const zipped = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
  return { buf: Buffer.from(zipped), summary };
}
