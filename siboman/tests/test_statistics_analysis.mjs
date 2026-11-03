import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildSettlementReport, csvCell, datesBetween, financialDate, moneyCents, monthBounds, normalizeOrder, validateAccrual } from '../lib/ozon-settlement.js';

const posting = '0100000001-0001-1', second = '0100000001-0001-2', other = '0200000002-0002-1';
const accrual = (id, unit, date, amount, type = null) => ({ accrual_id: String(id), unit_number: unit, date,
  total_amount: { amount: String(amount), currency: 'RUB' }, accrued_category: type === null ? 'POSTING' : 'ITEM',
  ...(type === null ? { posting: { delivery_schema: 'Rfbs' } } : { item_fees: { fees: [{ sku: 123, fees: [{ type_id: type, accrued: { amount: String(amount), currency: 'RUB' } }] }] } }) });
const order = (id, status = 'delivered', sku = '123') => ({ posting_number: id, order_number: id.split('-').slice(0, 2).join('-'), schema: 'fbs', status,
  in_process_at: '2026-09-06T16:00:21Z', products: [{ sku, quantity: 1 }],
  cancellation: status === 'cancelled' ? { cancel_reason: 'Покупатель отказался при вручении: товар не подошел', cancelled_after_ship: true } : null });
const build = (options = {}) => buildSettlementReport({ month: '2026-10', accruals: [], orders: [], defaultRate: 0.1, coverage: { complete: true }, ...options });

test('money and dates preserve cents, boundaries and leap years', () => {
  assert.equal(moneyCents('17.80'), 1780); assert.equal(moneyCents('-0.02'), -2);
  for (const value of ['', null, true, '1.234', '1e3', 'NaN']) assert.throws(() => moneyCents(value));
  assert.deepEqual(monthBounds('2024-02'), { start: '2024-02-01', end: '2024-02-29' });
  assert.throws(() => monthBounds('2026-13'));
  assert.equal(datesBetween('2026-10-31', '2026-11-01').length, 2);
  assert.equal(financialDate(new Date('2026-11-04T02:30:00+08:00')), '2026-11-03');
});

test('latest full posting date is selected before month filtering; parent acquiring fee is not an anchor', () => {
  const result = build({ orders: [order(posting)], accruals: [accrual(1, '0100000001-0001', '2026-10-01', '-7.03', 1), accrual(2, posting, '2026-11-01', '448')] });
  assert.equal(result.rows.length, 0); assert.equal(result.excluded[0].settled_date, '2026-11-01');
  const later = build({ orders: [order(posting)], accruals: [accrual(1, posting, '2026-10-10', '500'), accrual(2, posting, '2026-11-01', '-10')] });
  assert.equal(later.rows.length, 0);
});

test('canceled order retains fee refund and gross charges without netting', () => {
  const source = [accrual(1, '0100000001-0001', '2026-10-01', '17.80', 1), ...['-3.8', '-23.04', '-202.04', '-116'].map((v, i) => accrual(i + 2, posting, '2026-10-03', v))];
  const result = build({ orders: [order(posting, 'cancelled')], accruals: source });
  assert.equal(result.rows[0].income_rub, 17.8); assert.equal(result.rows[0].ozon_fees_rub, 344.88);
  assert.equal(result.rows[0].settled_date, '2026-10-03'); assert.match(result.rows[0].cancel_reason, /商品不合适.*发货后/);
  assert.equal(result.rows[0].profit_cny, null); assert.equal(result.summary.low_income_orders, 1);
  assert.equal(result.summary.reconciliation_difference_rub, 0);
});

test('same SKU on split postings is deferred; blanks are not zero or low income', () => {
  const source = [accrual(1, posting, '2026-10-03', '-10'), accrual(2, second, '2026-10-03', '-10'), accrual(3, '0100000001-0001', '2026-10-03', '7.8', 1)];
  const result = build({ orders: [order(posting), order(second)], accruals: source, costs: [{ posting_number: posting, purchase_cny: 0, version: 1 }] });
  assert.equal(result.pending.length, 1); assert.equal(result.rows[0].income_rub, null);
  assert.equal(result.summary.low_income_orders, 0); assert.equal(result.summary.income_unknown_orders, 2);
  assert.equal(result.summary.profit_cny, null); assert.equal(result.rows[0].profit_cny, null);
});

test('unknown parent does not invent a child posting or disappear from reconciliation', () => {
  const result = build({ accruals: [accrual(1, '0100000001-0001', '2026-10-01', '-7', 1)] });
  assert.equal(result.rows.length, 0); assert.equal(result.pending.length, 1); assert.equal(result.summary.unresolved_parents, 1);
  assert.equal(result.summary.source_negative_rub, 7);
});

test('threshold is strictly below 100; WHD derives from actual delivery schema', () => {
  const whd = accrual(2, other, '2026-10-03', '100'); whd.posting.delivery_schema = 'Whd';
  const result = build({ orders: [order(posting), order(other)], accruals: [accrual(1, posting, '2026-10-03', '99.99'), whd] });
  assert.equal(result.summary.low_income_orders, 1); assert.equal(result.summary.whd_orders, 1);
  assert.equal(result.rows.find((r) => r.posting_number === other).order_type, 'WHD订单');
});

test('advertising is separate from order fees, overrides including zero persist, currencies are explicit', () => {
  const ad = { ...accrual(3, 'product-42', '2026-10-03', '-20'), posting: null, non_item_fee: { type_id: 41 } };
  const source = [accrual(1, posting, '2026-10-03', '200'), accrual(2, posting, '2026-10-03', '-50'), ad];
  const input = { orders: [order(posting)], accruals: source, costs: [{ posting_number: posting, purchase_cny: 5, label_cny: 1.5, version: 1 }] };
  const result = build(input);
  assert.equal(result.summary.ozon_fees_rub, 50); assert.equal(result.summary.advertising_rub, 20);
  assert.equal(result.summary.profit_cny, 6.5); assert.equal(result.rows[0].profit_cny, 8.5);
  assert.equal(build({ ...input, settings: { advertising_amount: 0, advertising_currency: 'RUB' } }).summary.profit_cny, 8.5);
  const cny = build({ ...input, settings: { advertising_amount: 3, advertising_currency: 'CNY', exchange_rate: 0.1 } });
  assert.equal(cny.summary.advertising_rub, 30); assert.equal(cny.summary.profit_cny, 5.5);
  assert.equal(build({ ...input, coverage: { complete: false } }).rows[0].profit_cny, null);
});

test('unvalidated currency, response date and duplicate accruals fail loudly', () => {
  const record = accrual(1, posting, '2026-10-01', '10');
  assert.throws(() => validateAccrual(record, '2026-10-02'));
  assert.throws(() => validateAccrual({ ...record, total_amount: { amount: '10', currency: 'CNY' } }, '2026-10-01'));
  assert.throws(() => build({ accruals: [record, record] }));
  assert.throws(() => normalizeOrder({ posting_number: 'bad' }, 'fbs'));
  assert.equal(csvCell('=HYPERLINK("bad")'), '"\'=HYPERLINK(""bad"")"');
  assert.equal(csvCell(-327.08), '"-327.08"');
});

test('menu, scoped API, daily schedule and read-only Ozon endpoints are wired', () => {
  const main = readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const service = readFileSync(new URL('../lib/statistics-analysis.js', import.meta.url), 'utf8');
  assert.match(main, /<span>统计分析<\/span>/); assert.match(html, /StatisticsAnalysis.js/);
  assert.match(service, /assertStoreAccess\(storeId, userId/); assert.match(service, /platform !== 'ozon'/);
  assert.match(service, /SCHEDULE_HOUR = 2, SCHEDULE_MINUTE = 30/);
  for (const mutation of ['/v1/product/import', '/v2/products/stocks', '/posting/fbs/ship', '/posting/fbs/cancel']) assert.ok(!service.includes(mutation));
});

test('monthly view displays a provisional profit, retains missing-cost notes and sorts the displayed values', () => {
  const context = { window: {}, Vue: { ref: (value) => ({ value }), computed: (get) => ({ get value() { return get(); } }), watch() {}, onMounted() {}, onBeforeUnmount() {} } };
  vm.runInNewContext(readFileSync(new URL('../public/js/views/StatisticsAnalysis.js', import.meta.url), 'utf8'), context);
  const view = context.window.StatisticsAnalysisView.setup();
  const provisional = { profit_cny: null, known_cost_profit_cny: 123.45, missing_purchase: 8, pending_rows: 2, coverage: { complete: true } };
  assert.equal(view.monthlyProfit(provisional), 123.45);
  assert.equal(view.monthlyProfitEstimated(provisional), true);
  assert.match(view.monthlyProfitNote(provisional), /暂估.*待补采购费 8 单.*收支待分摊 2 笔/);
  assert.equal(view.monthlyProfit({ ...provisional, known_cost_profit_cny: 0 }), 0);
  assert.equal(view.monthlyProfit({ ...provisional, known_cost_profit_cny: -20 }), -20);
  assert.equal(view.monthlyProfit({ ...provisional, coverage: { complete: false } }), null);
  assert.equal(view.monthlyProfit({ ...provisional, known_cost_profit_cny: null }), null);
  const final = { ...provisional, profit_cny: 10, missing_purchase: 0, pending_rows: 0 };
  assert.equal(view.monthlyProfit(final), 10);
  assert.equal(view.monthlyProfitEstimated(final), false);
  assert.equal(view.monthlyProfitNote(final), '');
  assert.ok(view.sortMonthlyProfit({ ...provisional, known_cost_profit_cny: -20 }, provisional) < 0);
});
