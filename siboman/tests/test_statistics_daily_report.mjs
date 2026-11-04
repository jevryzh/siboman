import test from 'node:test';
import assert from 'node:assert/strict';
import { businessDate, dailySettlementReport, filterReportRows, matchOrderAdRows, monthlyAccrualReport, REPORT_FIELDS, settlementExceptions } from '../lib/statistics-daily-report.js';
import { datesBetween } from '../lib/ozon-settlement.js';

test('batch posting filter matches complete numbers and combines with other filters', () => {
  const rows = [
    { posting_number: '0123-0042-1', raw_status: 'delivered', income_rub: 200 },
    { posting_number: '0123-0042-10', raw_status: 'delivered', income_rub: 500 },
    { posting_number: '0123-0042-2', raw_status: 'cancelled', income_rub: 10 },
  ];
  const params = { posting_numbers: ['0123-0042-1', '0123-0042-2', '0123-0042-1', '0123-0042-3'] };
  assert.deepEqual(filterReportRows(rows, params), [rows[0], rows[2]]);
  assert.deepEqual(filterReportRows(rows, { ...params, status: 'delivered', filters: [{ field: 'income_rub', op: 'gt', value: 100 }] }), [rows[0]]);
  assert.deepEqual(filterReportRows(rows, { posting_numbers: ['123-0042-1'] }), []);
  for (const value of [[], '0123-0042-1', ['0123-0042'], [123], Array(5001).fill('0123-0042-1')]) {
    assert.throws(() => filterReportRows(rows, { posting_numbers: value }), { statusCode: 400 });
  }
});
import { createPerformanceClient, normalizePerformanceDaily, openCredential, sealCredential } from '../lib/ozon-performance.js';

const tz = 'Europe/Moscow', day = '2026-09-30';
const order = (id, status = 'delivered', schema = 'fbs') => ({ posting_number: id, status, schema, created_at: day+'T12:00:00Z', products: [{ sku: id, quantity: 2 }] });
const row = (id, type = '正常销售订单', status = 'delivered') => ({ posting_number: id, order_type: type, raw_status: status, status, settled_date: '2026-10-03', ordered_at: day+'T12:00:00Z', income_rub: 1000, ozon_fees_rub: 100, purchase_cny: 5, label_cny: 1.5 });

test('accrual months require attributed finance, keep advertising in its month and recognize costs once', () => {
  const posting = '123-0001-1', organic = '234-0002-1', whd = '345-0003-1';
  const orders = [order(posting), order(organic), order(whd, 'delivered', 'fbo')];
  const accrual = (id, unit_number, date, amount, type) => ({
    accrual_id: String(id), unit_number, date, total_amount: { amount, currency: 'RUB' },
    ...(type ? { non_item_fee: { type_id: type } } : { posting: { delivery_schema: 'Rfbs' } }),
  });
  const accruals = [accrual(1, posting, '2026-10-01', '100'), accrual(2, posting, '2026-11-01', '-20', 67),
    accrual(3, posting, day, '-2', 67)];
  const adDays = datesBetween('2026-09-01', '2026-11-30').map((spend_date) => ({
    spend_date, business_timezone: tz, cpo_rub: spend_date === day ? 16 : 0, cpc_rub: spend_date === day ? 6 : 0,
  }));
  const options = { orders, accruals, adDays, orderDays: [{ ordered_date: day, business_timezone: tz }],
    orderAdEntries: [
      { date: day, order_number: posting, sku: posting, quantity: 2, cents: 1200 },
      { date: day, order_number: whd, sku: whd, quantity: 2, cents: 400 },
    ],
    costs: [{ posting_number: posting, purchase_cny: 5, label_cny: 1 }], defaultRate: 0.1, coverage: { complete: true }, now: new Date('2026-12-02') };
  const reports = ['2026-09', '2026-10', '2026-11'].map((month) => monthlyAccrualReport({ ...options, month }));
  assert.deepEqual(reports.map(({rows}) => {
    const r = rows.find((r) => r.posting_number === posting);
    return [r.accrual_date, r.settled_date, r.income_rub, r.ozon_fees_rub, r.advertising_rub, r.allocated_ad_rub, r.purchase_cny, r.label_cny, r.receipt_rub];
  }), [
    ['2026-09-30', '2026-11-01', 0, 2, 12, 3, 0, 0, -17],
    ['2026-10-01', '2026-11-01', 100, 0, 0, 0, 5, 1, 100],
    ['2026-11-01', '2026-11-01', 0, 20, 0, 0, 0, 0, -20],
  ]);
  assert.deepEqual(reports[0].rows.map((r) => [r.posting_number, r.advertising_rub, r.allocated_ad_rub]), [[posting, 12, 3]]);
  assert.deepEqual([reports[0].summary.ad_without_finance_orders, reports[0].summary.ad_without_finance_rub], [2, 7]);
  const withWhdFinance = monthlyAccrualReport({ ...options, month: '2026-09', accruals: [...accruals, accrual(4, whd, day, '90')] });
  assert.deepEqual(withWhdFinance.rows.map((r) => [r.posting_number, r.advertising_rub, r.allocated_ad_rub]), [[posting, 12, 3], [whd, 4, 0]]);
  const sibling = '123-0001-2';
  const parentOnly = monthlyAccrualReport({ ...options, month: '2026-09', orders: [...orders, order(sibling)],
    accruals: [...accruals.slice(0, 2), accrual(5, '123-0001', day, '-2', 1)] });
  assert.equal(parentOnly.rows.length, 0);
  assert.equal(parentOnly.summary.unresolved_parents, 1);
  assert.deepEqual(settlementExceptions(parentOnly,'total','unresolved')[0].postings, [posting,sibling]);
  const missing = monthlyAccrualReport({ ...options, month: '2026-09', orderAdEntries: [] });
  assert.equal(missing.rows[0].advertising_rub, null);
  assert.equal(missing.summary.order_ad_report_verified, false);
  assert.equal(reports[0].summary.order_ad_report_verified, true);
});

test('fees before a sale do not book purchase costs, and a cancellation books them only on its first formal month', () => {
  const open = '123-0001-1', cancelled = '234-0002-1';
  const orders = [order(open, 'delivering'), order(cancelled, 'cancelled')];
  const fee = (id, posting, date, type = 67) => ({ accrual_id: String(id), unit_number: posting, date,
    total_amount: { amount: '-15', currency: 'RUB' }, non_item_fee: { type_id: type } });
  const accruals = [fee(1, open, day), fee(2, cancelled, day, 1), fee(3, cancelled, '2026-10-01'),
    fee(4, cancelled, '2026-11-01')];
  const options = { orders, accruals, costs: orders.map((o) => ({ posting_number: o.posting_number, purchase_cny: 9, label_cny: 2 })), coverage: { complete: true } };
  const costsFor = (month, posting) => {
    const row = monthlyAccrualReport({ ...options, month }).rows.find((r) => r.posting_number === posting);
    return [row.cost_month, row.cost_in_month, row.purchase_cny, row.label_cny];
  };
  assert.deepEqual(costsFor('2026-09', open), [null, false, 0, 0]);
  assert.deepEqual(costsFor('2026-09', cancelled), ['2026-10', false, 0, 0]);
  assert.deepEqual(costsFor('2026-10', cancelled), ['2026-10', true, 9, 2]);
  assert.deepEqual(costsFor('2026-11', cancelled), ['2026-10', false, 0, 0]);
});
const base = (rows) => ({ rows, ledger: [], summary: { month: '2026-10', coverage: { complete: true }, exchange_rate: 0.1 } });
const options = { now: new Date('2026-11-04'), configured: true, orderDays: [{ ordered_date: day, business_timezone: tz }], adDays: [{ spend_date: day, business_timezone: tz, cpo_rub: 10, cpc_rub: 0.01 }] };
const report = (rows, orders, extra = {}) => dailySettlementReport(base(rows), { ...options, orders, ...extra });

test('month review lists reconcile to the selected group and separate unassigned accruals', () => {
  const a = report([{ ...row('1'), pending_negative: true }, { ...row('2', '正常销售订单', 'cancelled'), pending_positive: true },
    row('3','WHD订单','cancelled')], [order('1'), order('2','cancelled'), order('3','cancelled','fbo')]);
  a.pending = [{ postings: [], accrual_id: '7', date: '2026-10-03' }, { postings: ['1','2'], accrual_id: '8', date: '2026-10-03' }];
  assert.deepEqual(settlementExceptions(a, 'total', 'receipt_rub'), []);
  assert.deepEqual(settlementExceptions(a, 'cancelled', 'receipt_cny'), []);
  assert.deepEqual(settlementExceptions(a, 'total', 'order_ads').map((r) => r.posting_number), ['1','2']);
  assert.equal(settlementExceptions(a, 'delivered', 'pending').length, a.summary.children[0].pending_rows);
  assert.deepEqual(settlementExceptions(a, 'whd', 'pending'), []);
  assert.deepEqual(settlementExceptions(a, 'total', 'unresolved').map((r) => r.accrual_id), ['7']);
  assert.throws(() => settlementExceptions(a, 'delivered', 'unresolved'), { statusCode: 400 });
  assert.throws(() => settlementExceptions(a, 'total', '__proto__'), { statusCode: 400 });
});

test('only CPC shares the full order-day cohort, cancelled included, WHD excluded, stable cents', () => {
  const orders = [order('3'), order('1'), order('2', 'cancelled'), order('4', 'cancelled', 'fbo')];
  const a = report([row('1'), row('2', '正常销售订单', 'cancelled'), row('4', 'WHD订单', 'cancelled')], orders);
  assert.equal(a.rows[0].allocated_ad_rub, 0.01); assert.equal(a.rows[1].allocated_ad_rub, 0);
  assert.equal(a.rows[0].advertising_rub, null); assert.equal(a.summary.missing_order_advertising, 2);
  assert.equal(a.rows[2].allocated_ad_rub, 0); assert.equal(a.rows[0].allocation_order_count, 3);
  const b = report([row('3')], orders);
  assert.equal(b.rows[0].allocated_ad_rub, 0);
  assert.equal(Math.round((a.rows[0].allocated_ad_rub+a.rows[1].allocated_ad_rub+b.rows[0].allocated_ad_rub)*100), 1);
  assert.equal(a.rows[0].receipt_rub, 899.99); assert.equal(a.rows[0].receipt_cny, 90);
  assert.equal(a.rows[0].profit_cny, 83.5); assert.equal(a.rows[0].margin_pct, 83.5);
  assert.equal(a.rows[0].product_quantity, 2);
  assert.deepEqual(a.summary.children.map((r) => r.orders), [1,1,1]);
  for (const key of ['orders', 'income_rub', 'ozon_fees_rub', 'purchase_cny', 'label_cny']) assert.equal(a.summary[key], a.summary.children.reduce((n,r) => n+r[key],0));
  assert.equal(Math.round(a.summary.receipt_cny*100), a.summary.children.reduce((n,r) => n+Math.round(r.receipt_cny*100),0));
});

test('unknown ads, wrong timezone, partial cohort and current day never become zero', () => {
  for (const extra of [{adDays:[]}, {orderDays:[]}, {orderDays:[{ordered_date:day,business_timezone:'UTC'}]}, {now:new Date(day+'T16:00:00Z')}]) {
    const r = report([row('1')],[order('1')], extra).rows[0];
    assert.equal(r.allocated_ad_rub,null); assert.equal(r.profit_cny,null);
  }
  const imported = report([row('1')],[order('1')], {configured:false}).rows[0];
  assert.equal(imported.advertising_state,'confirmed'); assert.equal(imported.allocated_ad_rub,0.01);
  const zero = report([row('1')],[order('1')], {adDays:[{spend_date:day,business_timezone:tz,cpo_rub:0,cpc_rub:0}]}).rows[0];
  assert.equal(zero.allocated_ad_rub,0); assert.equal(zero.profit_cny,83.5);
  const refunds = report([row('1'),row('2')],[order('1'),order('2')],{adDays:[{spend_date:day,business_timezone:tz,cpo_rub:0,cpc_rub:-0.03}]}).rows;
  assert.deepEqual(refunds.map((r)=>r.allocated_ad_rub),[-0.02,-0.01]);
});

test('order advertising stays on its order and is removed from the other fees exactly once', () => {
  const r = base([row('1')]); r.ledger = [{accrual_id:'ad',posting_number:'1',amount_rub:-10}];
  const accruals = [{accrual_id:'ad',non_item_fee:{type_id:54}}];
  const result = dailySettlementReport(r,{...options,orders:[order('1')],accruals}).rows[0];
  assert.equal(result.ozon_fees_rub,90); assert.equal(result.advertising_rub,10); assert.equal(result.receipt_rub,899.99);
  const mixed = base([{...row('1'),income_rub:100,ozon_fees_rub:0}]);
  mixed.ledger=[{accrual_id:'mixed',posting_number:'1',amount_rub:100,method:'完整订单号'}];
  const entry={accrual_id:'mixed',total_amount:{amount:'100'},item_fees:{fees:[{sku:'1',fees:[{type_id:54,accrued:{amount:'-10'}},{type_id:999,accrued:{amount:'110'}}]}]}};
  const m=dailySettlementReport(mixed,{...options,orders:[order('1')],accruals:[entry]}).rows[0];
  assert.equal(m.income_rub,110);assert.equal(m.ozon_fees_rub,0);assert.equal(m.receipt_rub,99.99);
  entry.item_fees.fees[0].fees[1].accrued.amount='111';
  assert.equal(dailySettlementReport(mixed,{...options,orders:[order('1')],accruals:[entry]}).rows[0].advertising_rub,null);
  const click = dailySettlementReport(r,{...options,orders:[order('1')],accruals:[{accrual_id:'ad',non_item_fee:{type_id:41}}]}).rows[0];
  assert.equal(click.ozon_fees_rub,90); assert.equal(click.advertising_rub,null); assert.equal(click.receipt_rub,909.99);
});

test('order report only splits by verified purchased quantities and preserves unreconciled rows', () => {
  const shipments = [
    { ...order('123-456-1'), products: [{sku:'9',quantity:3}] },
    { ...order('123-456-2'), products: [{sku:'9',quantity:2}] },
  ];
  const line = { order_number:'123-456', sku:'9', quantity:5, cents:25000 };
  assert.deepEqual([...matchOrderAdRows([line],shipments).centsByPosting], [['123-456-1',15000],['123-456-2',10000]]);
  for (const bad of [{...line,quantity:4},{...line,cents:25001},{...line,sku:'8'}]) {
    assert.deepEqual(matchOrderAdRows([bad],shipments).unmatched,[bad]);
  }
  const a = report([row('123-456-1'),row('123-456-2')],shipments,{orderAdEntries:[line]});
  assert.deepEqual(a.rows.map((r)=>r.advertising_rub),[150,100]);
  assert.equal(a.rows[1].receipt_rub,800);
  assert.equal(a.summary.order_ad_rub,250);
});

test('missing cost excluded from profit, zero sales has no margin, unexpected status kept', () => {
  const a=report([{...row('1'),purchase_cny:null},{...row('2'),income_rub:0},row('3','正常销售订单','awaiting_deliver')],[order('1'),order('2'),order('3')]);
  assert.equal(a.rows[0].profit_cny,null); assert.equal(a.rows[1].margin_pct,null);
  assert.equal(a.summary.missing_purchase,1); assert.equal(a.summary.profit_orders,2);
  assert.equal(a.summary.children[3].label,'其他状态订单');
  assert.equal(a.summary.known_cost_profit_cny,a.rows.slice(1).reduce((n,r)=>n+r.profit_cny,0));
  assert.equal(businessDate('2026-10-01T00:30:00+08:00',tz),'2026-09-30');
});

test('unassigned shared charges do not erase a known receipt; wholly unknown amounts stay missing', () => {
  const pending = {...row('2','正常销售订单','cancelled'),pending_negative:true};
  const known=report([row('1'),pending],[order('1'),order('2')]);
  assert.equal(known.rows[1].receipt_rub,900); assert.equal(known.rows[1].platform_net_rub,900);
  assert.equal(known.summary.pending_rows,1); assert.equal(known.summary.missing_receipt_rub,0);
  const a=report([row('1'),{...pending,ozon_fees_rub:null}],[order('1'),order('2')]);
  assert.equal(a.summary.receipt_rub,null);
  assert.equal(a.summary.missing_receipt_rub,1);
  assert.equal(a.summary.known_receipt_rub,a.rows[0].receipt_rub);
  assert.equal(a.summary.known_receipt_cny,a.summary.children[0].known_receipt_cny);
});

test('all fields whitelist, numeric/text/date ranges, blanks and null-last sorting', () => {
  const rows=[{...row('one'),profit_cny:-5,receipt_cny:null},{...row('two'),profit_cny:10,receipt_cny:5},{...row('three'),profit_cny:null,receipt_cny:0}];
  const f=(field,op,value,value2)=>filterReportRows(rows,{filters:JSON.stringify([{field,op,value,value2}])}).map((r)=>r.posting_number);
  assert.equal(REPORT_FIELDS.length,17);
  for(const [op,value,count] of [['gt',0,1],['gte',10,1],['lt',0,1],['lte',-5,1],['eq',10,1],['ne',10,1]]) assert.equal(f('profit_cny',op,value).length,count);
  assert.deepEqual(f('profit_cny','between',-5,10),['one','two']);
  assert.deepEqual(f('receipt_cny','empty'),['one']); assert.deepEqual(f('receipt_cny','not_empty'),['two','three']);
  assert.deepEqual(f('posting_number','contains','TW'),['two']); assert.equal(f('posting_number','not_contains','t').length,1);
  assert.equal(f('ordered_at','between','2026-09-30','2026-09-30').length,3);
  assert.deepEqual(filterReportRows(rows,{sort:'profit_cny',direction:'desc'}).map((r)=>r.posting_number),['two','one','three']);
  for(const rule of [{field:'__proto__',op:'eq',value:0},{field:'profit_cny',op:'sql',value:0},{field:'ordered_at',op:'eq',value:'2026-02-30'},{field:'profit_cny',op:'between',value:9,value2:2}]) assert.throws(()=>filterReportRows(rows,{filters:[rule]}));
  assert.throws(()=>filterReportRows(rows,{filters:'not json'}));
});

test('Performance parser rejects partial/unrecognized/duplicate records and encrypts credentials', () => {
  const campaigns=[{id:1,PaymentType:'CPO'},{id:2,PaymentType:'CPC'}];
  const out=normalizePerformanceDaily({rows:[{id:1,date:day,moneySpent:'1 234,50'},{id:2,date:day,moneySpent:'-0,50'}]},campaigns,day,day);
  assert.deepEqual(out,[{spend_date:day,cpo_rub:1234.5,cpc_rub:-0.5}]);
  assert.throws(()=>normalizePerformanceDaily({message:'error'},campaigns,day,day));
  assert.throws(()=>normalizePerformanceDaily([{id:8,date:day,moneySpent:'1'}],campaigns,day,day));
  assert.throws(()=>normalizePerformanceDaily([{id:1,date:day,moneySpent:'1'},{id:1,date:day,moneySpent:'1'}],campaigns,day,day));
  const cipher=sealCredential('test-credential','server-secret');assert.ok(!cipher.includes('test-credential'));assert.equal(openCredential(cipher,'server-secret'),'test-credential');assert.throws(()=>openCredential(cipher,'different'));
});

test('Performance requests have bounded retries, safe errors, token reuse', async () => {
  let calls=0,tokenCalls=0,failed=false;
  const client=createPerformanceClient({clientId:'fixture',clientSecret:'fixture-secret',sleep:async()=>{},fetchImpl:async(url,opts)=>{
    calls++; assert.ok(url.startsWith('https://api-performance.ozon.ru/'));
    if(url.endsWith('/token')){tokenCalls++;assert.equal(JSON.parse(opts.body).grant_type,'client_credentials');return Response.json({access_token:'test-token',expires_in:3600});}
    assert.equal(opts.headers.Authorization,'Bearer test-token');
    if(!failed){failed=true;return new Response('',{status:429});}
    return Response.json(url.endsWith('/campaign')?{list:[{id:1,PaymentType:'CPC'}]}:{rows:[{id:1,date:day,moneySpent:'10'}]});
  }});
  assert.equal((await client.daily(day,day))[0].cpc_rub,10);await client.daily(day,day);assert.equal(tokenCalls,1);assert.equal(calls,6);
  const bad=createPerformanceClient({clientId:'x',clientSecret:'do-not-leak',sleep:async()=>{},fetchImpl:async()=>new Response('do-not-leak',{status:403})});
  await assert.rejects(bad.daily(day,day),(e)=>!e.message.includes('do-not-leak')&&e.message.includes('授权'));
});
