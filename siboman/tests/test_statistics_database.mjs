import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { Pool } from 'pg';
import { createStatisticsAnalysis } from '../lib/statistics-analysis.js';
import { datesBetween, financialDate, monthBounds, shanghaiDate } from '../lib/ozon-settlement.js';

const url = process.env.STATISTICS_TEST_DATABASE_URL;
if (!url) {
  console.log('SKIP statistics database integration: STATISTICS_TEST_DATABASE_URL is not configured');
  process.exit(0);
}
if (!new URL(url).pathname.includes('test')) throw new Error('Refusing a non-test database');
const schema = 'statistics_test_' + crypto.randomBytes(6).toString('hex');
const admin = new Pool({ connectionString: url, max: 2 });
await admin.query(`CREATE SCHEMA ${schema}`);
const db = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 6 });
const userId = crypto.randomUUID(), otherUser = crypto.randomUUID(), storeId = crypto.randomUUID(), otherStore = crypto.randomUUID();
const ctx = { userId, storeId };
const month = financialDate().slice(0, 7), date = month + '-01', posting = '0100000001-0001-1';
const records = [
  { accrual_id: '1', unit_number: posting, date, total_amount: { amount: '200', currency: 'RUB' }, posting: { delivery_schema: 'Rfbs' }, accrued_category: 'POSTING' },
  { accrual_id: '2', unit_number: posting, date, total_amount: { amount: '-50', currency: 'RUB' }, posting: null, non_item_fee: { type_id: 67 }, accrued_category: 'NON_ITEM' },
  { accrual_id: '3', unit_number: 'product-42', date, total_amount: { amount: '-20', currency: 'RUB' }, posting: null, non_item_fee: { type_id: 41 }, accrued_category: 'NON_ITEM' },
];
const order = { posting_number: posting, order_number: '0100000001-0001', schema: 'fbs', status: 'delivered', created_at: date + 'T00:00:00Z', products: [{ sku: '123', offer_id: 'SKU-001', quantity: 1 }] };
let apiCalls = 0, server, analysis;
try {
  await db.query(`CREATE TABLE app_users(id uuid primary key);
    CREATE TABLE app_stores(id uuid primary key,user_id uuid,name text,platform text,active boolean default true);
    CREATE TABLE app_exchange_rates(rate numeric,base_currency text,quote_currency text,effective_at timestamptz default now());
    CREATE TABLE app_products(user_id uuid,store_id uuid,offer_id text,name text,image text,primary key(store_id,offer_id));
    CREATE TABLE app_order_cache(user_id uuid,store_id uuid,posting_number text,payload jsonb,primary key(store_id,posting_number));`);
  await db.query('INSERT INTO app_users(id) VALUES($1),($2)', [userId, otherUser]);
  await db.query("INSERT INTO app_stores(id,user_id,name,platform) VALUES($1,$2,'test','ozon'),($3,$4,'other','ozon')", [storeId, userId, otherStore, otherUser]);
  await db.query("INSERT INTO app_exchange_rates(rate,base_currency,quote_currency) VALUES(0.1,'RUB','CNY')");
  await db.query("INSERT INTO app_products VALUES($1,$2,'SKU-001','Fixture product','https://example.test/catalog.jpg'),($3,$4,'SKU-001','Other store product','https://example.test/other.jpg')", [userId, storeId, otherUser, otherStore]);
  analysis = createStatisticsAnalysis({ db, defaultRate: 0.1, logger: { error() {} },
    credentialSecret: 'isolated-test-encryption-secret',
    performanceFactory: ({ clientSecret }) => { assert.equal(clientSecret,'fixture-only'); return {daily:async(start,end)=>datesBetween(start,end).map((d)=>({spend_date:d,cpo_rub:d===date?35:0,cpc_rub:d===date?20:0}))}; },
    assertStoreAccess: async (id, user) => {
      const row = (await db.query('SELECT id,name,platform FROM app_stores WHERE id=$1 AND user_id=$2', [id, user])).rows[0];
      if (!row) throw Object.assign(new Error('no access'), { statusCode: 404 });
      return row;
    },
    callOzon: async (endpoint, body) => {
      apiCalls++;
      if (endpoint === '/v1/finance/accrual/by-day') return { accruals: body.date === date ? records : [], last_id: '' };
      if (endpoint === '/v4/posting/fbs/list') return { postings: [order, { ...order, posting_number:'0200000002-0002-1', status:'cancelled', cancellation:{cancel_reason:'customer'} }], has_next: false };
      if (endpoint === '/v3/posting/fbo/list') return { postings: [], has_next: false };
      throw new Error('Unexpected or mutating Ozon endpoint: ' + endpoint);
    },
  });
  await analysis.init();
  await analysis.importSnapshot(ctx, { month, accruals: records, orders: [order], days: datesBetween(date, financialDate()) });
  const movedDate = month + '-02';
  await analysis.replaceDay(ctx, movedDate, records.map((r) => ({ ...r, date: movedDate })));
  await analysis.replaceDay(ctx, date, records);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM app_statistics_accruals')).rows[0].n), 3);
  let report = analysis.report(await analysis.loadData(ctx), month);
  assert.equal(report.rows.length, 1); assert.equal(report.summary.profit_cny, null);
  assert.equal(report.summary.advertising_rub, null); assert.equal(report.summary.coverage.complete, true);
  assert.equal(report.summary.profit_orders, 0); assert.equal(report.summary.known_cost_profit_cny, null);
  await db.query('INSERT INTO app_statistics_order_days(user_id,store_id,ordered_date,business_timezone) VALUES($1,$2,$3,$4)',[userId,storeId,date,'Europe/Moscow']);
  const revision=crypto.createHash('sha256').update('[]').digest('hex');
  const imported = await analysis.importAdvertising(ctx,{revision,days:[{spend_date:date,cpo_rub:35,cpc_rub:20}]});
  await assert.rejects(analysis.importAdvertising(ctx,{revision,days:[{spend_date:date,cpo_rub:30,cpc_rub:0}]}),(e)=>e.statusCode===409);
  await analysis.rollback(ctx,imported.snapshot_id);
  await analysis.importAdvertising(ctx,{revision,days:[{spend_date:date,cpo_rub:35,cpc_rub:20}]});
  await assert.rejects(analysis.importAdvertising(ctx,{revision,days:[{spend_date:date,cpo_rub:null,cpc_rub:0}]}));
  const first = await analysis.saveCosts(ctx, { month, items: [{ posting_number: posting, purchase_cny: 25, version: 0 }] });
  report = analysis.report(await analysis.loadData(ctx), month);
  assert.equal(report.summary.profit_orders, 1); assert.equal(report.summary.known_cost_profit_cny, -13.5);
  await assert.rejects(analysis.saveCosts(ctx, { month, items: [{ posting_number: posting, purchase_cny: 99, version: 0 }] }), (e) => e.statusCode === 409);
  const second = await analysis.saveCosts(ctx, { month, items: [{ posting_number: posting, purchase_cny: 0, version: 1 }] });
  report = analysis.report(await analysis.loadData(ctx), month);
  assert.equal(report.rows[0].purchase_cny, 0); assert.equal(report.summary.profit_orders, 1); assert.equal(report.summary.known_cost_profit_cny, 11.5);
  await analysis.rollback(ctx, second.snapshot_id);
  await assert.rejects(analysis.rollback(ctx, second.snapshot_id), (e) => e.statusCode === 409);
  await assert.rejects(analysis.rollback(ctx, first.snapshot_id), (e) => e.statusCode === 409);
  report = analysis.report(await analysis.loadData(ctx), month);
  assert.equal(report.rows[0].purchase_cny, 25); assert.equal(report.rows[0].version, 3);
  for (const value of ['', true, -1, '1.234']) await assert.rejects(analysis.saveCosts(ctx, { month, items: [{ posting_number: posting, purchase_cny: value, version: 3 }] }));
  await assert.rejects(analysis.saveCosts(ctx, { month, items: [{ posting_number: '99999999-9999-1', purchase_cny: 1, version: 0 }] }));
  const concurrent = await Promise.allSettled([1, 2].map((value) => analysis.saveCosts(ctx, { month, items: [{ posting_number: posting, purchase_cny: value, version: 3 }] })));
  assert.equal(concurrent.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter((r) => r.status === 'rejected' && r.reason.statusCode === 409).length, 1);
  await analysis.saveMonth(ctx, { month, version: 0, exchange_rate: 0.1, advertising_amount: 0, advertising_currency: 'RUB' });
  const setting = await analysis.saveMonth(ctx, { month, version: 1, exchange_rate: 0.1, advertising_amount: 3, advertising_currency: 'CNY' });
  assert.equal(analysis.report(await analysis.loadData(ctx), month).summary.advertising_rub, 20);
  await analysis.rollback(ctx, setting.snapshot_id);
  report = analysis.report(await analysis.loadData(ctx), month);
  assert.equal(report.summary.advertising_rub, 20); assert.equal(report.summary.advertising_source, 'performance-daily');
  const protectedCost = report.rows[0].purchase_cny;
  const app = express(); app.use(express.json());
  analysis.register(app, (req, res, next) => { req.user = { id: userId }; next(); });
  app.use((e, req, res, next) => res.status(e.statusCode || 500).json({ error: e.message }));
  server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/statistics`;
  const response = await fetch(`${base}/report?store_id=${storeId}&month=${month}`);
  assert.equal(response.status, 200); assert.equal((await response.json()).total, 1);
  assert.equal((await fetch(`${base}/report?store_id=${otherStore}&month=${month}`)).status, 404);
  const requestDetail = (id, number) => fetch(`${base}/order-detail?store_id=${id}&posting_number=${number}`);
  const beforeDetail = apiCalls;
  const detailResponse = await requestDetail(storeId, posting);
  assert.equal(detailResponse.status, 200);
  const { detail } = await detailResponse.json();
  assert.deepEqual(detail.products, [{ sku: '123', offer_id: 'SKU-001', quantity: 1, name: 'Fixture product', image: 'https://example.test/catalog.jpg' }]);
  await db.query("UPDATE app_products SET image='' WHERE store_id=$1", [storeId]);
  assert.equal((await (await requestDetail(storeId, posting)).json()).detail.products[0].image, '');
  await db.query('INSERT INTO app_order_cache VALUES($1,$2,$3,$4)', [userId, storeId, posting, { products: [
    { sku: 999, offer_id: 'SKU-001', image: 'https://example.test/wrong.jpg' },
    { sku: 123, offer_id: 'SKU-001', image: 'https://example.test/cached.jpg' },
  ] }]);
  assert.equal((await (await requestDetail(storeId, posting)).json()).detail.products[0].image, 'https://example.test/cached.jpg');
  assert.equal((await (await requestDetail(storeId, '0000000000-0000-1')).json()).detail, null);
  assert.equal((await requestDetail(storeId, '0100000001')).status, 400);
  assert.equal((await requestDetail(otherStore, posting)).status, 404);
  assert.equal(apiCalls, beforeDetail);
  assert.equal((await fetch(`${base}/advertising/days?store_id=${otherStore}`)).status,404);
  const config = await fetch(`${base}/advertising/config`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({store_id:storeId,client_id:'fixture-client',client_secret:'fixture-only',version:0})});
  assert.equal(config.status,200);
  const stored=(await db.query('SELECT secret_cipher FROM app_statistics_ad_config WHERE store_id=$1',[storeId])).rows[0];
  assert.ok(!stored.secret_cipher.includes('fixture-only'));
  const safe=await (await fetch(`${base}/advertising/config?store_id=${storeId}`)).text();
  assert.ok(!safe.includes('secret_cipher')&&!safe.includes('fixture-only'));
  const audit=JSON.stringify((await db.query("SELECT payload FROM app_statistics_changes WHERE kind='ad_config'")).rows);
  assert.ok(!audit.includes('fixture-only')&&!audit.includes('secret_cipher'));
  await assert.rejects(analysis.saveAdvertising(ctx,{client_id:'fixture-client',client_secret:'new',version:0}),(e)=>e.statusCode===409);
  const csv = await fetch(`${base}/export?store_id=${storeId}&month=${month}`);
  assert.deepEqual([...new Uint8Array(await csv.arrayBuffer()).slice(0, 3)], [239, 187, 191]);
  const missingPosting = '00000000-0000-1';
  const batch = (path, params = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ store_id: storeId, month, posting_numbers: [missingPosting, posting, posting], ...params }) });
  const batchResult = await (await batch('/report', { page_size: 1 })).json();
  assert.equal(batchResult.total, 1); assert.equal(batchResult.summary.orders, 1);
  assert.deepEqual(batchResult.rows.map((r) => r.posting_number), [posting]);
  const noMatches = await (await batch('/report', { posting_numbers: [missingPosting] })).json();
  assert.equal(noMatches.total, 0); assert.equal(noMatches.summary.orders, 1);
  assert.equal((await batch('/report', { store_id: otherStore })).status, 404);
  assert.equal((await batch('/export', { posting_numbers: [] })).status, 400);
  const batchCsv = Buffer.from(await (await batch('/export', { page: 2, page_size: 1 })).arrayBuffer());
  assert.deepEqual([...batchCsv.subarray(0, 3)], [239, 187, 191]);
  assert.ok(batchCsv.toString().includes(posting) && !batchCsv.toString().includes(missingPosting));
  const started = await fetch(base + '/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ store_id: storeId, month }) });
  assert.equal(started.status, 202);
  const runId = (await started.json()).run.id;
  for (let i = 0; i < 300; i++) {
    const r = (await db.query('SELECT status,error FROM app_statistics_runs WHERE id=$1', [runId])).rows[0];
    if (r.status === 'failed') throw new Error('mock sync failed: ' + r.error);
    if (r.status === 'succeeded') break;
    if (i === 299) throw new Error('mock sync timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  report = analysis.report(await analysis.loadData(ctx), month);
  assert.equal(report.rows[0].purchase_cny, protectedCost); assert.equal(report.summary.advertising_rub, 10);
  assert.equal(report.summary.ad_without_finance_rub, 10);
  assert.equal(report.rows[0].allocation_order_count,2);
  assert.equal((await analysis.loadData(ctx)).orders.length,2);
  const numeric=await (await fetch(`${base}/report?store_id=${storeId}&month=${month}&filters=${encodeURIComponent(JSON.stringify([{field:'allocated_ad_rub',op:'eq',value:10}]))}`)).json();
  assert.equal(numeric.total,1);
  const snapshots = await db.query("SELECT count(*) AS n FROM app_statistics_changes WHERE kind='costs'");
  assert.equal(Number(snapshots.rows[0].n), 3);
  assert.ok(apiCalls > 0);
  await db.query("UPDATE app_statistics_runs SET started_at=now()-interval '2 days',finished_at=now()-interval '2 days'");
  await analysis.tick(new Date(shanghaiDate()+'T08:29:00+08:00'));
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM app_statistics_runs WHERE trigger='daily'")).rows[0].n),0);
  const dueTime = new Date(shanghaiDate() + 'T08:31:00+08:00');
  await analysis.tick(dueTime); await analysis.tick(dueTime);
  let daily;
  for (let i = 0; i < 300; i++) {
    const dailyRows = (await db.query("SELECT * FROM app_statistics_runs WHERE trigger='daily' ORDER BY started_at DESC")).rows;
    assert.equal(dailyRows.length, 1);
    daily = dailyRows[0];
    if (daily.status === 'failed') throw new Error(daily.error);
    if (daily.status === 'succeeded') break;
    if (i === 299) throw new Error('daily sync timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await analysis.tick(dueTime);
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM app_statistics_runs WHERE trigger='daily'")).rows[0].n), 1);
  assert.equal(analysis.report(await analysis.loadData(ctx), month).rows[0].purchase_cny, protectedCost);
  const resalePosting = '0300000003-0003-1';
  await analysis.replaceDay(ctx, date, [...records, { ...records[0], accrual_id: '4', unit_number: resalePosting, posting: { delivery_schema: 'Whd' } }]);
  await analysis.saveOrders(ctx, [{ ...order, posting_number: resalePosting, schema: 'fbo' }]);
  await db.query('INSERT INTO app_statistics_costs(user_id,store_id,posting_number,purchase_cny,label_cny,version) VALUES($1,$2,$3,12,2,1)', [userId, storeId, resalePosting]);
  const resaleReport = await (await fetch(`${base}/report?store_id=${storeId}&month=${month}&order_type=${encodeURIComponent('WHD订单')}`)).json();
  assert.equal(resaleReport.total, 1);
  assert.deepEqual([resaleReport.rows[0].purchase_cny, resaleReport.rows[0].label_cny, resaleReport.rows[0].profit_cny], [0, 0, 20]);
  const resaleGroup = resaleReport.summary.children.find((r) => r.group === 'whd');
  assert.deepEqual([resaleGroup.purchase_cny, resaleGroup.label_cny, resaleGroup.missing_purchase, resaleGroup.profit_orders], [0, 0, 0, 1]);
  const refused = await fetch(base+'/costs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ store_id: storeId, month, items: [
      { posting_number: posting, purchase_cny: 100, version: resaleReport.rows[0].version },
      { posting_number: resalePosting, purchase_cny: 99, label_cny: 99, version: 1 },
    ] }) });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /WHD 订单/);
  const historicalCosts = await db.query('SELECT purchase_cny::float AS purchase,label_cny::float AS label FROM app_statistics_costs WHERE store_id=$1 AND posting_number=$2', [storeId, resalePosting]);
  assert.deepEqual(historicalCosts.rows[0], { purchase: 12, label: 2 });
  const review = (id, group, kind) => fetch(`${base}/exceptions?store_id=${id}&month=${month}&group=${group}&kind=${kind}`);
  assert.equal((await review(otherStore,'total','pending')).status, 404);
  assert.equal((await review(storeId,'all','pending')).status, 400);
  assert.equal((await (await review(storeId,'whd','purchase')).json()).total, 0);
  await analysis.replaceDay(ctx,date,[...records,{...records[1],accrual_id:'5',unit_number:'0999999999-1234'}]);
  const unassigned = await (await review(storeId,'total','unresolved')).json();
  assert.equal(unassigned.total,1);
  assert.equal(unassigned.rows[0].unit_number,'0999999999-1234');
  assert.deepEqual(unassigned.rows[0].postings,[]);
  const oldMonth = new Date(Date.parse(month+'-01')-86400000).toISOString().slice(0,7);
  const {start,end} = monthBounds(oldMonth);
  const dailyDates = datesBetween(start,end);
  const postOrderAds = (params) => fetch(base+'/advertising/order-report', {method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({store_id:storeId,month:oldMonth,version:0,entries:[{date:start,order_number:order.order_number,sku:'123',order_id:'45',quantity:1,cents:2000}],...params})});
  assert.equal((await postOrderAds({store_id:otherStore})).status,404);
  assert.equal((await postOrderAds()).status,409);
  for (const d of dailyDates) await db.query(`INSERT INTO app_statistics_ad_days(user_id,store_id,spend_date,business_timezone,cpo_rub,cpc_rub)
    VALUES($1,$2,$3,'Europe/Moscow',$4,0) ON CONFLICT DO NOTHING`,[userId,storeId,d,d===start?20:0]);
  const orderedAd = await postOrderAds();
  assert.equal(orderedAd.status,200);
  const saved = await orderedAd.json();
  assert.equal(saved.matched_rub,20); assert.equal(saved.unmatched_entries,0);
  const adOnly = analysis.report(await analysis.loadData(ctx),oldMonth);
  assert.equal(adOnly.rows.length,0);
  assert.equal(adOnly.summary.ad_without_finance_rub,20);
  await analysis.replaceDay(ctx,start,[{ ...records[1],accrual_id:'6',date:start }]);
  const dataWithOrderAds = await analysis.loadData(ctx);
  const accrualFromPriorMonth = analysis.report(dataWithOrderAds,oldMonth).rows.find((r) => r.posting_number === posting);
  assert.deepEqual([accrualFromPriorMonth.advertising_rub, accrualFromPriorMonth.income_rub, accrualFromPriorMonth.cost_in_month], [20,0,false]);
  assert.equal(analysis.report(dataWithOrderAds,month).rows[0].advertising_rub,null);
  await assert.rejects(analysis.saveCosts(ctx, { month:oldMonth,items:[{ posting_number:posting,purchase_cny:99,version:0 }] }), /成本归属月/);
  assert.equal((await postOrderAds()).status,409);
  await analysis.rollback(ctx,saved.snapshot_id);
  assert.equal((await analysis.loadData(ctx)).orderAdEntries.length,0);
  console.log(JSON.stringify({ passed: true, isolatedSchema: true, httpTenantIsolation: true, optimisticConcurrency: true, snapshotsAndRollback: true, manualValuesSurviveSync: true, dailyScheduleAndDedup: true, csvBom: true, mockSyncCalls: apiCalls }));
} finally {
  analysis?.stop();
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
