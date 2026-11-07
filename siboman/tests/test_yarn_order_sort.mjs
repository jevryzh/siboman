import assert from "node:assert/strict";
import { sortYarnOrderRows } from "../lib/yarn-order-sort.js";

// Accio Work (2026-11-07) 新排序规则：
//   单色优先；单色段内按总件数升序；同件数段内按色号升序；混色段同理；最后 pn 兜底。
const rows = [
  { pn: "mixed-2", total_qty: 2, color_kinds: 2, first_color: "01" },
  { pn: "single-2-03", total_qty: 2, color_kinds: 1, first_color: "03" },
  { pn: "single-1-10", total_qty: 1, color_kinds: 1, first_color: "10" },
  { pn: "single-3-01", total_qty: 3, color_kinds: 1, first_color: "01" },
  { pn: "mixed-3", total_qty: 3, color_kinds: 2, first_color: "02" },
  { pn: "single-2-01", total_qty: 2, color_kinds: 1, first_color: "01" },
  { pn: "single-1-02", total_qty: 1, color_kinds: 1, first_color: "02" },
];
const expected = [
  "single-1-02", "single-1-10",
  "single-2-01", "single-2-03",
  "single-3-01",
  "mixed-2", "mixed-3",
];

assert.deepEqual(sortYarnOrderRows(rows).map((row) => row.pn), expected);
assert.equal(rows[0].pn, "mixed-2", "sorting must not mutate database result rows");

// yarn-sorted-postings 走的字段名别名：kinds / c1
assert.deepEqual(
  sortYarnOrderRows(rows.map(({ color_kinds, first_color, ...row }) => ({
    ...row, kinds: color_kinds, c1: first_color,
  }))).map((row) => row.pn),
  expected,
  "the sorted-postings query uses alternate field names",
);

// Accio Work (2026-11-07) 新增：一组「同色号不同件数」+「同件数不同色号」的样本，
//   强制验证优先级是 数量 > 色号 而不是旧的 色号 > 数量。
const mix = [
  { pn: "A-01-qty1", total_qty: 1, color_kinds: 1, first_color: "01" },
  { pn: "B-02-qty1", total_qty: 1, color_kinds: 1, first_color: "02" },
  { pn: "C-03-qty1", total_qty: 1, color_kinds: 1, first_color: "03" },
  { pn: "D-01-qty2", total_qty: 2, color_kinds: 1, first_color: "01" },
  { pn: "E-02-qty2", total_qty: 2, color_kinds: 1, first_color: "02" },
  { pn: "F-01-qty3", total_qty: 3, color_kinds: 1, first_color: "01" },
];
assert.deepEqual(
  sortYarnOrderRows(mix).map((row) => row.pn),
  ["A-01-qty1", "B-02-qty1", "C-03-qty1", "D-01-qty2", "E-02-qty2", "F-01-qty3"],
  "quantity must take precedence over color code",
);

// Accio Work (2026-11-07) 新增：同件数同色号多单，用 pn 字典序兜底
const ties = [
  { pn: "0180082332-1319-1", total_qty: 2, color_kinds: 1, first_color: "01" },
  { pn: "0127630291-0514-1", total_qty: 2, color_kinds: 1, first_color: "01" },
  { pn: "0165584289-0039-1", total_qty: 2, color_kinds: 1, first_color: "01" },
];
assert.deepEqual(
  sortYarnOrderRows(ties).map((row) => row.pn),
  ["0127630291-0514-1", "0165584289-0039-1", "0180082332-1319-1"],
  "equal qty + color must tiebreak by pn",
);

console.log("yarn order sort: OK");
