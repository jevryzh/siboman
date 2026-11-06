import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import { unzipSync, zipSync, strToU8 } from "fflate";

const source = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const start = source.indexOf("const XLSX_STYLES = {");
const end = source.indexOf("// v2.2.9.165", start);
assert.ok(start >= 0 && end > start);
const context = vm.createContext({ Buffer, zipSync, strToU8 });
vm.runInContext(`${source.slice(start, end)}\nthis.make = buildXlsx;`, context);

const header = ["No.", "Shipment", "Color×Qty", "Qty", "Label", "", "No.", "Shipment", "Color×Qty", "Qty", "Label"]
  .map((v) => ({ v, s: "header" }));
const item = (n) => [
  { v: n, s: "no" }, { v: `0123456789-${String(n).padStart(4, "0")}-1`, s: "shipment" },
  { v: "01×1", s: "colorqty" }, { v: 1, s: "qty" }, { v: "6789", s: "label" }, { v: "", s: "blank" },
];
const rows = [header];
for (let i = 1; i <= 26; i += 1) rows.push([...item(i), ...item(i + 26).slice(0, 5)]);
rows.push(header, [...item(53), ...item(54).slice(0, 5)]);
const rowHeights = Object.fromEntries(rows.map((_, i) => [i, i === 0 || i === 27 ? 25 : 28]));
const workbook = context.make("A4双列表", rows, {
  colWidths: [3.8, 12.8, 11.4, 4, 7, 1.4, 3.8, 12.8, 11.4, 4, 7],
  rowHeights, printLayout: "a4-portrait", pageBreakRows: [27],
});
const sheet = new TextDecoder().decode(unzipSync(workbook)["xl/worksheets/sheet1.xml"]);
assert.match(sheet, /<pageSetUpPr fitToPage="1"\/>/);
assert.match(sheet, /<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"\/>/);
assert.match(sheet, /<rowBreaks count="1" manualBreakCount="1"><brk id="27"/);
assert.match(sheet, /<dimension ref="A1:K29"\/>/);
if (process.argv[2]) writeFileSync(process.argv[2], workbook);
console.log("Yarn picklist A4 print metadata passed");
