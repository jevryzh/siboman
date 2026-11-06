export function compareYarnOrderRows(a, b) {
  const aMixed = Number(a.color_kinds ?? a.kinds ?? 0) > 1;
  const bMixed = Number(b.color_kinds ?? b.kinds ?? 0) > 1;
  if (aMixed !== bMixed) return Number(aMixed) - Number(bMixed);

  const aQty = Number(a.total_qty || 0);
  const bQty = Number(b.total_qty || 0);
  if (!aMixed && aQty !== bQty) return aQty - bQty;

  const aColor = String(a.first_color ?? a.c1 ?? "").padStart(4, "0");
  const bColor = String(b.first_color ?? b.c1 ?? "").padStart(4, "0");
  if (aColor !== bColor) return aColor < bColor ? -1 : 1;
  if (aQty !== bQty) return aQty - bQty;
  return String(a.pn || "").localeCompare(String(b.pn || ""));
}

export function sortYarnOrderRows(rows) {
  return rows.slice().sort(compareYarnOrderRows);
}
