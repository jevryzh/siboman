// Accio Work (2026-11-07)
// 排序规则（和「导出毛线标签」共用，保证两边顺序一致）：
//   ① 单色单在前、混色单在后
//   ② 单色段内：按总件数升序（1 件全部 → 2 件全部 → 3 件全部 …）
//   ③ 同件数段内：按最小色号升序（字典序，色号先 padStart(4,'0')）
//   ④ 混色段内：按总件数升序 → 最小色号升序
//   ⑤ 最后用 posting_number 字典序兜底，保证稳定顺序
//
// 入参字段兼容：
//   color_kinds | kinds        -- 颜色种类数（>1 即视为混色）
//   total_qty                  -- 本单所有毛线商品的总件数
//   first_color | c1           -- 最小色号（SQL 用 MIN(color) 得到）
//   pn                         -- posting_number

const colorKey = (row) => String(row.first_color ?? row.c1 ?? "").padStart(4, "0");

export function compareYarnOrderRows(a, b) {
  // ① 单色 vs 混色
  const aMixed = Number(a.color_kinds ?? a.kinds ?? 0) > 1;
  const bMixed = Number(b.color_kinds ?? b.kinds ?? 0) > 1;
  if (aMixed !== bMixed) return Number(aMixed) - Number(bMixed);

  // ② / ④ 按总件数升序（单色段和混色段都适用）
  const aQty = Number(a.total_qty || 0);
  const bQty = Number(b.total_qty || 0);
  if (aQty !== bQty) return aQty - bQty;

  // ③ / ④ 同件数内按最小色号升序
  const aColor = colorKey(a);
  const bColor = colorKey(b);
  if (aColor !== bColor) return aColor < bColor ? -1 : 1;

  // ⑤ posting_number 兜底
  return String(a.pn || "").localeCompare(String(b.pn || ""));
}

export function sortYarnOrderRows(rows) {
  return rows.slice().sort(compareYarnOrderRows);
}
