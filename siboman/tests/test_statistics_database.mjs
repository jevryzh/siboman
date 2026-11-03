import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { Pool } from 'pg';
import { createStatisticsAnalysis } from '../lib/statistics-analysis.js';
import { datesBetween, financialDate, shanghaiDate } from '../lib/ozon-settlement.js';

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
const order = { posting_number: posting, order_number: '0100000001-0001', schema: 'fbs', status: 'delivered', created_at: date + 'T00:00:00Z', products: [{ sku: '123', quantity: 1 }] };
let apiCalls = 0, server, analysis;
try {
  await db.query(`CREATE TABLE app_users(id uuid primary key);
    CREATE TABLE app_stores(id uuid primary key,user_id uuid,name text,platform text,active boolean default true);
    CREATE TABLE app_exchange_rates(rate numeric,base_currency text,quote_currency text,effective_at timestamptz default now());`);
  await db.query('INSERT INTO app_users(id) VALUES($1),($2)', [userId, otherUser]);
  await db.query("INSERT INTO app_stores(id,user_id,name,platform) VALUES($1,$2,'test','ozon'),($3,$4,'other','ozon')", [storeId, userId, otherStore, otherUser]);
  await db.query("INSERT INTO app_exchange_rates(rate,base_currency,quote_currency) VALUES(0.1,'RUB','CNY')");
  analysis = createStatisticsAnalysis({ db, defaultRate: 0.1, logger: { error() {} },
    assertStoreAccess: async (id, user) => {
      const row = (await db.query('SELECT id,name,platform FROM app_stores WHERE id=$1 AND user_id=$2', [id, user])).rows[0];
      if (!row) throw Object.assign(new Error('no access'), { statusCode: 404 });
      return row;
    },
    callOzon: async (endpoint, body) => {
      apiCalls++;
      if (endpoint === '/v1/finance/accrual/by-day') return { accruals: body.date === date ? records : [], last_id: '' };
      if (endpoint === '/v4/posting/fbs/list') return { postings: [order], has_next: false };
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
  assert.equal(report.summary.advertising_rub, 20); assert.equal(report.summary.coverage.complete, true);
  const first = await analysis.saveCosts(ctx, { month, items: [{ posting_number: posting, purchase_cny: 25, version: 0 }] });
  await assert.rejects(analysis.saveCosts(ctx, { month, items: [{ posting_number: posting, purchase_cny: 99, version: 0 }] }), (e) => e.statusCode === 409);
  const second = await analysis.saveCosts(ctx, { month, items: [{ posting_number: posting, purchase_cny: 0, version: 1 }] });
  assert.equal(analysis.report(await analysis.loadData(ctx), month).rows[0].purchase_cny, 0);
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
  assert.equal(analysis.report(await analysis.loadData(ctx), month).summary.advertising_rub, 30);
  await analysis.rollback(ctx, setting.snapshot_id);
  report = analysis.report(await analysis.loadData(ctx), month);
  assert.equal(report.summary.advertising_rub, 0); assert.equal(report.summary.advertising_source, 'manual');
  const protectedCost = report.rows[0].purchase_cny;
  const app = express(); app.use(express.json());
  analysis.register(app, (req, res, next) => { req.user = { id: userId }; next(); });
  app.use((e, req, res, next) => res.status(e.statusCode || 500).json({ error: e.message }));
  server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/statistics`;
  const response = await fetch(`${base}/report?store_id=${storeId}&month=${month}`);
  assert.equal(response.status, 200); assert.equal((await response.json()).total, 1);
  assert.equal((await fetch(`${base}/report?store_id=${otherStore}&month=${month}`)).status, 404);
  const csv = await fetch(`${base}/export?store_id=${storeId}&month=${month}`);
  assert.deepEqual([...new Uint8Array(await csv.arrayBuffer()).slice(0, 3)], [239, 187, 191]);
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
  assert.equal(report.rows[0].purchase_cny, protectedCost); assert.equal(report.summary.advertising_rub, 0);
  const snapshots = await db.query("SELECT count(*) AS n FROM app_statistics_changes WHERE kind='costs'");
  assert.equal(Number(snapshots.rows[0].n), 3);
  assert.ok(apiCalls > 0);
  await db.query("UPDATE app_statistics_runs SET started_at=now()-interval '2 days',finished_at=now()-interval '2 days'");
  const dueTime = new Date(shanghaiDate() + 'T03:00:00+08:00');
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
  console.log(JSON.stringify({ passed: true, isolatedSchema: true, httpTenantIsolation: true, optimisticConcurrency: true, snapshotsAndRollback: true, manualValuesSurviveSync: true, dailyScheduleAndDedup: true, csvBom: true, mockSyncCalls: apiCalls }));
} finally {
  analysis?.stop();
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
