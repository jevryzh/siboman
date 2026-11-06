import assert from "node:assert/strict";
import { sortYarnOrderRows } from "../lib/yarn-order-sort.js";

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
  "single-1-02", "single-1-10", "single-2-01", "single-2-03",
  "single-3-01", "mixed-2", "mixed-3",
];

assert.deepEqual(sortYarnOrderRows(rows).map((row) => row.pn), expected);
assert.equal(rows[0].pn, "mixed-2", "sorting must not mutate database result rows");
assert.deepEqual(
  sortYarnOrderRows(rows.map(({ color_kinds, first_color, ...row }) => ({
    ...row, kinds: color_kinds, c1: first_color,
  }))).map((row) => row.pn),
  expected,
  "the sorted-postings query uses alternate field names",
);
