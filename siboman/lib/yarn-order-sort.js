// Accio Work (2026-11-07) / (2026-11-17 v2.2.9.226 kind 维度) / (2026-11-17 v2.2.9.227 新排序规则)
// 排序规则（和「导出毛线标签」共用，保证两边顺序一致）：
//   ⓪ 先按毛线种类分段：mohar → alpaca → mixed → 其它（见 KIND_ORDER）
//   ① 段内：单色单在前、混色单在后
//   ② 单色段内（v2.2.9.227 新规则）：
//      - 1 件单整体排最前，按色号升序
//      - 2 件及以上：按色号分组（色号升序）→ 组内按件数升序
//        例：#1×1, #2×1, #1×2, #1×3, #2×2, #2×3
//          顺序：1件单#1 → 1件单#2 → #1×2 → #1×3 → #2×2 → #2×3
//   ③ 混色段内：按总件数升序 → 最小色号升序
//   ④ 最后用 posting_number 字典序兜底，保证稳定顺序
//
// 入参字段兼容：
//   kind                        -- "mohar" / "alpaca" / "mixed" / undefined(=unknown)
//   color_kinds | kinds        -- 颜色种类数（>1 即视为混色，单一 kind 内的混色）
//   total_qty                  -- 本单所有毛线商品的总件数
//   first_color | c1           -- 最小色号（SQL 用 MIN(color) 得到）
//   pn                         -- posting_number

// kind 排序优先级：数字越小越靠前
const KIND_ORDER = { mohar: 0, alpaca: 1, mixed: 2 };
const kindRank = (row) => {
  const k = String(row.kind || "");
  return k in KIND_ORDER ? KIND_ORDER[k] : 99;
};

const colorKey = (row) => String(row.first_color ?? row.c1 ?? "").padStart(4, "0");
const totalQty = (row) => Number(row.total_qty || 0);
const isMixed = (row) => Number(row.color_kinds ?? row.kinds ?? 0) > 1;

export function compareYarnOrderRows(a, b) {
  // ⓪ kind 分段
  const aKind = kindRank(a);
  const bKind = kindRank(b);
  if (aKind !== bKind) return aKind - bKind;

  // ① 单色 vs 混色（kind 相同的段内）
  const aMix = isMixed(a);
  const bMix = isMixed(b);
  if (aMix !== bMix) return Number(aMix) - Number(bMix);

  // ③ 混色段内：件数升序 → 色号升序
  if (aMix && bMix) {
    const aQty = totalQty(a);
    const bQty = totalQty(b);
    if (aQty !== bQty) return aQty - bQty;
    const aColor = colorKey(a);
    const bColor = colorKey(b);
    if (aColor !== bColor) return aColor < bColor ? -1 : 1;
    return String(a.pn || "").localeCompare(String(b.pn || ""));
  }

  // ② 单色段内（新规则 v2.2.9.227）：
  //   - 1 件单整体排最前（按色号升序）
  //   - 多件单（≥2）：色号分组 → 组内件数升序
  const aQty = totalQty(a);
  const bQty = totalQty(b);
  const aOne = aQty <= 1;
  const bOne = bQty <= 1;
  if (aOne !== bOne) return Number(!aOne) - Number(!bOne); // aOne=true → 排前

  if (aOne && bOne) {
    // 两个都是 1 件单：按色号升序
    const aColor = colorKey(a);
    const bColor = colorKey(b);
    if (aColor !== bColor) return aColor < bColor ? -1 : 1;
    return String(a.pn || "").localeCompare(String(b.pn || ""));
  }

  // 两个都是多件单：色号升序 → 件数升序 → pn
  const aColor = colorKey(a);
  const bColor = colorKey(b);
  if (aColor !== bColor) return aColor < bColor ? -1 : 1;
  if (aQty !== bQty) return aQty - bQty;
  return String(a.pn || "").localeCompare(String(b.pn || ""));
}

export function sortYarnOrderRows(rows) {
  return rows.slice().sort(compareYarnOrderRows);
}
