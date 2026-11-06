import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf('app.post("/api/seller/orders/pending-sku-export"');
const end = source.indexOf('app.post("/api/seller/orders/labels"', start);
assert.ok(start >= 0 && end > start, 'pending yarn export route exists');

let handler;
let querySql = '';
let sheetRows;
const context = {
  app: { post: (_path, _auth, callback) => { handler = callback; } },
  requireAuth: () => {},
  db: { query: async (sql) => {
    querySql = sql;
    return { rows: [
      { sku: 'YARN-01', name: 'Пряжа 01', qty: 3, first_posting_number: '001-1', last_posting_number: '003-1' },
      { sku: 'YARN-02', name: 'Пряжа 02', qty: 0, first_posting_number: null, last_posting_number: null },
    ] };
  } },
  buildXlsx: (_name, rows) => { sheetRows = rows; return Buffer.from('xlsx'); },
  Buffer,
  Date,
  encodeURIComponent,
};
vm.runInNewContext(source.slice(start, end), context);
const headers = {};
let output;
await handler(
  { body: { store_ids: ['store-1'] }, user: { id: 'user-1' } },
  { setHeader: (name, value) => { headers[name] = value; }, send: (value) => { output = value; } },
  (error) => { throw error; },
);
assert.match(querySql, /array_agg\(c\.posting_number ORDER BY c\.in_process_at ASC NULLS LAST/);
assert.match(querySql, /array_agg\(c\.posting_number ORDER BY c\.in_process_at DESC NULLS LAST/);
assert.deepEqual(Array.from(sheetRows[0]), ['序号', '货号（SKU）', '商品名称', '类别', '数量(个)', '开始订单号', '结束订单号']);
assert.deepEqual(Array.from(sheetRows[1]), [1, 'YARN-01', 'Пряжа 01', '毛线', 3, '001-1', '003-1']);
assert.deepEqual(Array.from(sheetRows[2]), [2, 'YARN-02', 'Пряжа 02', '毛线', 0, '', '']);
assert.deepEqual(Array.from(sheetRows[3]), ['', '合计', '', '', 3, '', '']);
assert.equal(headers['X-Sku-Count'], '2');
assert.equal(headers['X-Total-Qty'], '3');
assert.equal(output.toString(), 'xlsx');
console.log('Yarn pending export order range and totals: OK');
