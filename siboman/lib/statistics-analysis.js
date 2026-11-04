import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  csvCell, datesBetween, fail, financialDate, isFormalAccrual,
  moneyCents, monthBounds, normalizeOrder, parentOf, shanghaiDate, validateAccrual,
} from './ozon-settlement.js';
import { businessDate, DEFAULT_AD_TIMEZONE, filterReportRows, matchOrderAdRows, monthlyAccrualReport, orderTimestamp, REPORT_FIELDS, settlementExceptions } from './statistics-daily-report.js';
import { createPerformanceClient, openCredential, sealCredential } from './ozon-performance.js';

const ACTIVE = "('queued','running')";
const PREFIX = '/api/statistics';
const SCHEDULE_HOUR = 8, SCHEDULE_MINUTE = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const utcDay = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const serialMonth = (value) => Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7));
const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_statistics_accruals (
  user_id UUID NOT NULL REFERENCES app_users(id), store_id UUID NOT NULL REFERENCES app_stores(id),
  accrual_id TEXT NOT NULL, accrued_date DATE NOT NULL, payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(user_id,store_id,accrual_id)
);
CREATE INDEX IF NOT EXISTS idx_statistics_accrual_date ON app_statistics_accruals(user_id,store_id,accrued_date);
CREATE TABLE IF NOT EXISTS app_statistics_orders (
  user_id UUID NOT NULL REFERENCES app_users(id), store_id UUID NOT NULL REFERENCES app_stores(id),
  posting_number TEXT NOT NULL, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,store_id,posting_number)
);
CREATE TABLE IF NOT EXISTS app_statistics_costs (
  user_id UUID NOT NULL REFERENCES app_users(id), store_id UUID NOT NULL REFERENCES app_stores(id),
  posting_number TEXT NOT NULL, purchase_cny NUMERIC(14,2), label_cny NUMERIC(14,2) NOT NULL DEFAULT 1.50,
  version INTEGER NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,store_id,posting_number), CHECK(purchase_cny >= 0), CHECK(label_cny >= 0)
);
CREATE TABLE IF NOT EXISTS app_statistics_months (
  user_id UUID NOT NULL REFERENCES app_users(id), store_id UUID NOT NULL REFERENCES app_stores(id),
  month TEXT NOT NULL, exchange_rate NUMERIC(12,6), advertising_amount NUMERIC(14,2),
  advertising_currency TEXT NOT NULL DEFAULT 'RUB', version INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(user_id,store_id,month),
  CHECK(exchange_rate > 0 AND exchange_rate <= 1), CHECK(advertising_amount >= 0),
  CHECK(advertising_currency IN ('CNY','RUB'))
);
CREATE TABLE IF NOT EXISTS app_statistics_days (
  user_id UUID NOT NULL REFERENCES app_users(id), store_id UUID NOT NULL REFERENCES app_stores(id),
  accrued_date DATE NOT NULL, records INTEGER NOT NULL, checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,store_id,accrued_date)
);
CREATE TABLE IF NOT EXISTS app_statistics_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES app_users(id),
  store_id UUID NOT NULL REFERENCES app_stores(id), month TEXT NOT NULL, trigger TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', message TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
  days_done INTEGER NOT NULL DEFAULT 0, days_total INTEGER NOT NULL DEFAULT 0, metadata_pages INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_statistics_active_run ON app_statistics_runs(store_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS idx_statistics_runs_store ON app_statistics_runs(user_id,store_id,started_at DESC);
CREATE TABLE IF NOT EXISTS app_statistics_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES app_users(id),
  store_id UUID NOT NULL REFERENCES app_stores(id), kind TEXT NOT NULL, month TEXT, reason TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), rolled_back_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_statistics_changes_store ON app_statistics_changes(user_id,store_id,created_at DESC);
CREATE TABLE IF NOT EXISTS app_statistics_ad_config (
  user_id UUID NOT NULL REFERENCES app_users(id), store_id UUID NOT NULL REFERENCES app_stores(id),
  client_id TEXT NOT NULL, secret_cipher TEXT NOT NULL, business_timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
  version INTEGER NOT NULL DEFAULT 1, last_synced_at TIMESTAMPTZ, last_error TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(user_id,store_id)
);
CREATE TABLE IF NOT EXISTS app_statistics_ad_days (
  user_id UUID NOT NULL REFERENCES app_users(id), store_id UUID NOT NULL REFERENCES app_stores(id),
  spend_date DATE NOT NULL, business_timezone TEXT NOT NULL, cpo_rub NUMERIC(16,2) NOT NULL, cpc_rub NUMERIC(16,2) NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(user_id,store_id,spend_date,business_timezone)
);
ALTER TABLE app_statistics_ad_days ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'performance';
CREATE TABLE IF NOT EXISTS app_statistics_order_ad_reports (
  user_id UUID NOT NULL REFERENCES app_users(id), store_id UUID NOT NULL REFERENCES app_stores(id),
  month TEXT NOT NULL, entries JSONB NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(user_id,store_id,month)
);
CREATE TABLE IF NOT EXISTS app_statistics_order_days (
  user_id UUID NOT NULL REFERENCES app_users(id), store_id UUID NOT NULL REFERENCES app_stores(id),
  ordered_date DATE NOT NULL, business_timezone TEXT NOT NULL, checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,store_id,ordered_date,business_timezone)
);
`;

export function createStatisticsAnalysis({ db, assertStoreAccess, callOzon, defaultRate, credentialSecret = process.env.AUTH_SECRET,
  performanceFactory = createPerformanceClient, notify = async () => {}, logger = console }) {
  const running = new Map();
  const reportCache = new Map();
  const revisions = new Map();
  let timer = null, scheduling = false;
  const clearCache = (store) => { reportCache.delete(store); revisions.set(store, (revisions.get(store) || 0) + 1); };
  const query = (sql, values = []) => {
    if (!db) throw fail('统计分析需要数据库支持', 503);
    return db.query(sql, values);
  };
  async function init() { if (db) await db.query(SCHEMA); }
  async function context(req) {
    const storeId = String(req.body?.store_id || req.query?.store_id || '').trim();
    if (!UUID.test(storeId)) throw fail('请选择一个有效的 Ozon 店铺');
    const userId = req.user.id;
    const store = await assertStoreAccess(storeId, userId, 'id, name, platform');
    if (store.platform !== 'ozon') throw fail('统计分析仅支持 Ozon 店铺');
    return { userId, storeId, store };
  }
  function validMonth(month) {
    monthBounds(month);
    if (month > shanghaiDate().slice(0, 7)) throw fail('不能同步未来月份');
    if (serialMonth(shanghaiDate().slice(0, 7)) - serialMonth(month) > 36) throw fail('一次只支持查询最近36个月');
    return month;
  }
  async function audit(client, ctx, kind, month, reason, payload) {
    const result = await client.query(`INSERT INTO app_statistics_changes(user_id,store_id,kind,month,reason,payload)
      VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`, [ctx.userId, ctx.storeId, kind, month || null, reason, JSON.stringify(payload)]);
    return result.rows[0].id;
  }
  async function transaction(ctx, operation) {
    if (!db) throw fail('统计分析需要数据库支持', 503);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`statistics-manual:${ctx.storeId}`]);
      const result = await operation(client);
      await client.query('COMMIT'); clearCache(ctx.storeId);
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async function loadData(ctx) {
    const revision = revisions.get(ctx.storeId) || 0;
    const cached = reportCache.get(ctx.storeId);
    if (cached?.userId === ctx.userId && Date.now() - cached.at < 10000) return cached.data;
    const raw = await query('SELECT payload FROM app_statistics_accruals WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId]);
    const meta = await query('SELECT payload FROM app_statistics_orders WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId]);
    const costs = await query('SELECT posting_number,purchase_cny,label_cny,version FROM app_statistics_costs WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId]);
    const months = await query('SELECT * FROM app_statistics_months WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId]);
    const days = await query('SELECT accrued_date::text AS accrued_date,checked_at FROM app_statistics_days WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId]);
    const adConfig = await query('SELECT client_id,business_timezone,version,last_synced_at,last_error FROM app_statistics_ad_config WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId]);
    const ads = await query('SELECT spend_date::text AS spend_date,business_timezone,cpo_rub,cpc_rub,confirmed_at,source FROM app_statistics_ad_days WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId]);
    const orderDays = await query('SELECT ordered_date::text AS ordered_date,business_timezone FROM app_statistics_order_days WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId]);
    const orderAdReports = await query('SELECT entries FROM app_statistics_order_ad_reports WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId]);
    const rate = await query(`SELECT rate FROM app_exchange_rates WHERE base_currency='RUB' AND quote_currency='CNY' ORDER BY effective_at DESC LIMIT 1`);
    const data = { accruals: raw.rows.map((r) => r.payload), orders: meta.rows.map((r) => r.payload), costs: costs.rows,
      months: months.rows, days: days.rows, rate: rate.rows[0] ? Number(rate.rows[0].rate) : Number(defaultRate),
      adConfig: adConfig.rows[0] || null, adDays: ads.rows, orderDays: orderDays.rows,
      orderAdEntries: orderAdReports.rows.flatMap((r) => r.entries) };
    // An older read must not refill the cache after a cost update invalidates it.
    if ((revisions.get(ctx.storeId) || 0) === revision) reportCache.set(ctx.storeId, { userId: ctx.userId, at: Date.now(), data });
    while (reportCache.size > 4) reportCache.delete(reportCache.keys().next().value);
    return data;
  }
  function report(data, month) {
    const { start, end } = monthBounds(month);
    const checkedCutoff = data.days.reduce((latest, d) => utcDay(d.accrued_date) > latest ? utcDay(d.accrued_date) : latest, '');
    const cutoff = checkedCutoff && checkedCutoff < financialDate() ? checkedCutoff : financialDate();
    const expected = datesBetween(start, end < financialDate() ? end : financialDate());
    const done = new Map(data.days.map((d) => [utcDay(d.accrued_date), d.checked_at]));
    const missing = expected.filter((d) => !done.has(d));
    const checked = expected.filter((d) => done.has(d)).map((d) => new Date(done.get(d)).getTime());
    const settings = data.months.find((s) => s.month === month) || {};
    return monthlyAccrualReport({ month, accruals: data.accruals, orders: data.orders, costs: data.costs, settings, defaultRate: data.rate,
      coverage: { complete: !missing.length && !!expected.length, as_of_date: checkedCutoff ? cutoff : null, expected_days: expected.length, checked_days: expected.length - missing.length,
        missing_days: missing, boundary_missing_days: [], last_updated_at: checked.length ? new Date(Math.min(...checked)).toISOString() : null },
      adDays: data.adDays, orderDays: data.orderDays, orderAdEntries: data.orderAdEntries,
      timezone: data.adConfig?.business_timezone || DEFAULT_AD_TIMEZONE, configured: !!data.adConfig });
  }
  async function latestRun(ctx) {
    return (await query('SELECT * FROM app_statistics_runs WHERE user_id=$1 AND store_id=$2 ORDER BY started_at DESC LIMIT 1', [ctx.userId, ctx.storeId])).rows[0] || null;
  }
  async function heartbeat(id, values) {
    const keys = Object.keys(values).filter((key) => ['status', 'message', 'days_done', 'days_total', 'metadata_pages', 'error'].includes(key));
    if (!keys.length) return;
    await query(`UPDATE app_statistics_runs SET ${keys.map((key, i) => `${key}=$${i + 2}`).join(',')},updated_at=now() WHERE id=$1`, [id, ...keys.map((key) => values[key])]);
  }
  async function replaceDay(ctx, date, incoming) {
    const records = incoming.map((r) => validateAccrual(r, date));
    if (new Set(records.map((r) => r.accrual_id)).size !== records.length) throw fail(`应计流水重复：${date}`, 502);
    await transaction(ctx, async (client) => {
      const previous = (await client.query('SELECT payload FROM app_statistics_accruals WHERE user_id=$1 AND store_id=$2 AND (accrued_date=$3 OR accrual_id=ANY($4::text[])) FOR UPDATE', [ctx.userId, ctx.storeId, date, records.map((r) => r.accrual_id)])).rows.map((r) => r.payload);
      const sorted = (items) => [...items].sort((a, b) => a.accrual_id.localeCompare(b.accrual_id));
      if (!isDeepStrictEqual(sorted(previous), sorted(records))) {
        await audit(client, ctx, 'sync_day', date.slice(0, 7), `同步应计日期 ${date}`, { date, before: previous, after_ids: records.map((r) => r.accrual_id) });
        await client.query('DELETE FROM app_statistics_accruals WHERE user_id=$1 AND store_id=$2 AND accrued_date=$3', [ctx.userId, ctx.storeId, date]);
        if (records.length) await client.query(`INSERT INTO app_statistics_accruals(user_id,store_id,accrual_id,accrued_date,payload)
          SELECT $1,$2,x->>'accrual_id',$3,x FROM jsonb_array_elements($4::jsonb) x
          ON CONFLICT(user_id,store_id,accrual_id) DO UPDATE SET accrued_date=EXCLUDED.accrued_date,payload=EXCLUDED.payload,updated_at=now()`, [ctx.userId, ctx.storeId, date, JSON.stringify(records)]);
      }
      await client.query(`INSERT INTO app_statistics_days(user_id,store_id,accrued_date,records) VALUES($1,$2,$3,$4)
        ON CONFLICT(user_id,store_id,accrued_date) DO UPDATE SET records=EXCLUDED.records,checked_at=now()`, [ctx.userId, ctx.storeId, date, records.length]);
    });
  }
  async function saveOrders(ctx, incoming) {
    if (!incoming.length) return;
    await transaction(ctx, async (client) => {
      const previous = (await client.query(`SELECT posting_number,payload FROM app_statistics_orders WHERE user_id=$1 AND store_id=$2 AND posting_number=ANY($3::text[]) FOR UPDATE`, [ctx.userId, ctx.storeId, incoming.map((r) => r.posting_number)])).rows;
      const old = new Map(previous.map((r) => [r.posting_number, r.payload]));
      const changed = incoming.map((row) => {
        const prior = old.get(row.posting_number);
        return { ...row, cancellation: row.cancellation?.cancel_reason ? row.cancellation : prior?.status === row.status ? (prior.cancellation || row.cancellation) : row.cancellation };
      }).filter((r) => !isDeepStrictEqual(r, old.get(r.posting_number)));
      if (!changed.length) return;
      await audit(client, ctx, 'sync_orders', null, '同步订单资料', { before: changed.map((r) => ({ posting_number: r.posting_number, payload: old.get(r.posting_number) || null })), after_ids: changed.map((r) => r.posting_number) });
      await client.query(`INSERT INTO app_statistics_orders(user_id,store_id,posting_number,payload)
        SELECT $1,$2,x->>'posting_number',x FROM jsonb_array_elements($3::jsonb) x
        ON CONFLICT(user_id,store_id,posting_number) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()`, [ctx.userId, ctx.storeId, JSON.stringify(changed)]);
    });
  }
  async function fetchDay(ctx, date, id) {
    let cursor = '';
    const seen = new Set(), records = [];
    for (let page = 0; page < 1000; page++) {
      const body = await callOzon('/v1/finance/accrual/by-day', { date, last_id: cursor }, { storeId: ctx.storeId, userId: ctx.userId });
      if (!Array.isArray(body.accruals)) throw fail('Ozon 应计流水响应结构异常', 502);
      records.push(...body.accruals);
      const next = String(body.last_id || '');
      await heartbeat(id, { message: `拉取 ${date} 应计流水，第 ${page + 1} 页` });
      if (!next) { await replaceDay(ctx, date, records); return; }
      if (next === cursor || seen.has(next)) throw fail(`Ozon 应计流水分页重复：${date}`, 502);
      seen.add(next); cursor = next;
    }
    throw fail('应计流水超过分页上限，未覆盖旧数据', 502);
  }
  async function fetchOrders(ctx, start, id) {
    const raw = (await query('SELECT payload FROM app_statistics_accruals WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId])).rows.map((r) => r.payload);
    const since = new Date(Date.parse(`${start}T00:00:00Z`) - 180 * 86400000).toISOString();
    let pages = 0;
    for (const schema of ['fbs', 'fbo']) {
      let cursor = '';
      const seen = new Set();
      for (let page = 0; page < 1000; page++) {
        const body = await callOzon(schema === 'fbs' ? '/v4/posting/fbs/list' : '/v3/posting/fbo/list', {
          cursor, filter: { since, to: new Date().toISOString() }, limit: 100,
          with: { financial_data: false, analytics_data: false }, ...(schema === 'fbs' ? { dir: 'DESC' } : { sort_dir: 'desc' }),
        }, { storeId: ctx.storeId, userId: ctx.userId });
        if (!Array.isArray(body.postings)) throw fail('Ozon 订单列表响应结构异常', 502);
        const items = body.postings.map((p) => normalizeOrder(p, schema));
        await saveOrders(ctx, items);
        await heartbeat(id, { metadata_pages: ++pages, message: `核对 ${schema === 'fbs' ? '正常销售' : 'WHD'} 订单，第 ${page + 1} 页` });
        if (!body.has_next) break;
        const next = String(body.cursor || '');
        if (!next || next === cursor || seen.has(next)) throw fail('Ozon 订单分页游标异常', 502);
        if (page === 999) throw fail('订单列表超过分页上限', 502);
        seen.add(next); cursor = next;
      }
    }
    const known = new Map((await query('SELECT payload FROM app_statistics_orders WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId])).rows.map((r) => [r.payload.posting_number, r.payload]));
    const formals = new Set(raw.filter(isFormalAccrual).map((r) => r.unit_number));
    let missing = 0;
    for (const posting of formals) {
      const old = known.get(posting);
      if (old && (!String(old.status).startsWith('cancelled') || old.cancellation?.cancel_reason)) continue;
      let found = false;
      for (const schema of old?.schema === 'fbo' ? ['fbo'] : ['fbs', 'fbo']) {
        try {
          const response = await callOzon(schema === 'fbs' ? '/v3/posting/fbs/get' : '/v2/posting/fbo/get', { posting_number: posting, with: { financial_data: false, analytics_data: false } }, { storeId: ctx.storeId, userId: ctx.userId });
          const record = normalizeOrder(response.result || response, schema);
          await saveOrders(ctx, [record]); found = true; break;
        } catch (error) {
          if (error.statusCode !== 404 && error.status !== 404) throw error;
        }
      }
      if (!found) missing++;
      await heartbeat(id, { message: `核对订单详情 ${posting}` });
    }
    const config = (await query('SELECT business_timezone FROM app_statistics_ad_config WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId])).rows[0];
    const timezone = config?.business_timezone || DEFAULT_AD_TIMEZONE;
    const firstDay = new Date(Date.parse(businessDate(since, timezone) + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
    const lastDay = new Date(Date.parse(businessDate(new Date(), timezone) + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
    await transaction(ctx, async (client) => {
      await client.query(`INSERT INTO app_statistics_order_days(user_id,store_id,ordered_date,business_timezone)
        SELECT $1,$2,day::date,$5 FROM generate_series($3::date,$4::date,interval '1 day') day
        ON CONFLICT(user_id,store_id,ordered_date,business_timezone) DO UPDATE SET checked_at=now()`, [ctx.userId, ctx.storeId, firstDay, lastDay, timezone]);
    });
    return missing;
  }
  async function syncAdvertising(ctx, id) {
    const config = (await query('SELECT * FROM app_statistics_ad_config WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId])).rows[0];
    if (!config) return false;
    try {
      const client = performanceFactory({ clientId: config.client_id, clientSecret: openCredential(config.secret_cipher, credentialSecret) });
      const data = await loadData(ctx), today = businessDate(new Date(), config.business_timezone);
      const cohortDates = [...new Set(data.orders.filter((o) => o.schema !== 'fbo').map((o) => businessDate(orderTimestamp(o), config.business_timezone)).filter((date) => date && date < today))].sort();
      const done = new Set(data.adDays.filter((day) => day.business_timezone === config.business_timezone).map((d) => String(d.spend_date).slice(0, 10)));
      const recheck = new Date(Date.parse(today + 'T00:00:00Z') - 7 * 86400000).toISOString().slice(0, 10);
      const needed = cohortDates.filter((date) => !done.has(date) || date >= recheck);
      while (needed.length) {
        const start = needed.shift(); let end = start;
        while (needed.length && Date.parse(needed[0]) - Date.parse(start) < 31 * 86400000) end = needed.shift();
        await heartbeat(id, { message: `拉取 ${start} 至 ${end} 按订单付费及点击广告` });
        const days = await client.daily(start, end);
        if (!Array.isArray(days) || days.length !== datesBetween(start, end).length) throw fail('广告报表日期覆盖不完整', 502);
        await transaction(ctx, async (connection) => {
          // The credential may have changed while the external report was generated.
          const current = (await connection.query('SELECT version FROM app_statistics_ad_config WHERE user_id=$1 AND store_id=$2 FOR UPDATE', [ctx.userId, ctx.storeId])).rows[0];
          if (current?.version !== config.version) throw fail('广告授权已改变，请重新更新', 409);
          for (const day of days) {
            if (!datesBetween(start, end).includes(day.spend_date)) throw fail('广告报表返回了区间之外的日期', 502);
            moneyCents(day.cpo_rub); moneyCents(day.cpc_rub);
          }
          if (new Set(days.map((d) => d.spend_date)).size !== days.length) throw fail('广告报表日期重复', 502);
          const before = (await connection.query(`SELECT spend_date::text AS spend_date,cpo_rub,cpc_rub FROM app_statistics_ad_days
            WHERE user_id=$1 AND store_id=$2 AND business_timezone=$3 AND spend_date BETWEEN $4 AND $5 FOR UPDATE`, [ctx.userId, ctx.storeId, config.business_timezone, start, end])).rows;
          await audit(connection, ctx, 'sync_ads', start.slice(0, 7), '同步每日按订单付费及点击广告', { timezone: config.business_timezone, before, after: days });
          await connection.query(`INSERT INTO app_statistics_ad_days(user_id,store_id,spend_date,business_timezone,cpo_rub,cpc_rub)
            SELECT $1,$2,x.spend_date,$3,x.cpo_rub,x.cpc_rub FROM jsonb_to_recordset($4::jsonb) AS x(spend_date date,cpo_rub numeric,cpc_rub numeric)
            ON CONFLICT(user_id,store_id,spend_date,business_timezone) DO UPDATE SET cpo_rub=EXCLUDED.cpo_rub,cpc_rub=EXCLUDED.cpc_rub,source='performance',confirmed_at=now()`, [ctx.userId, ctx.storeId, config.business_timezone, JSON.stringify(days)]);
        });
      }
      await query("UPDATE app_statistics_ad_config SET last_synced_at=now(),last_error='' WHERE user_id=$1 AND store_id=$2 AND version=$3", [ctx.userId, ctx.storeId, config.version]);
      clearCache(ctx.storeId); return true;
    } catch (error) {
      await query('UPDATE app_statistics_ad_config SET last_error=$3 WHERE user_id=$1 AND store_id=$2 AND version=$4', [ctx.userId, ctx.storeId, String(error.message).slice(0, 600), config.version]);
      clearCache(ctx.storeId); throw error;
    }
  }
  async function work(ctx, run) {
    const lock = await db.connect();
    let acquired = false;
    try {
      acquired = (await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [`statistics-sync:${ctx.storeId}`])).rows[0].acquired;
      if (!acquired) throw fail('该店铺已有同步任务', 409);
      await heartbeat(run.id, { status: 'running', message: '准备同步应计流水' });
      const months = await query('SELECT month FROM app_statistics_months WHERE user_id=$1 AND store_id=$2 ORDER BY month', [ctx.userId, ctx.storeId]);
      const earliest = months.rows[0]?.month || run.month;
      const start = monthBounds(earliest < run.month ? earliest : run.month).start;
      const days = datesBetween(start, financialDate());
      await heartbeat(run.id, { days_total: days.length });
      for (let i = 0; i < days.length; i++) {
        await fetchDay(ctx, days[i], run.id);
        await heartbeat(run.id, { days_done: i + 1 });
      }
      const missing = await fetchOrders(ctx, start, run.id);
      const adsReady = await syncAdvertising(ctx, run.id);
      const message = missing ? `应计流水已更新，${missing} 单资料待补充` : adsReady ? '应计流水、全部订单及每日广告费已更新' : '财务和订单已更新；广告可导入后台日报或配置Performance授权';
      await query(`UPDATE app_statistics_runs SET status='succeeded',message=$2,finished_at=now(),updated_at=now() WHERE id=$1`, [run.id, message]);
    } catch (error) {
      logger.error('[statistics-sync]', run.id, error.message);
      await query(`UPDATE app_statistics_runs SET status='failed',error=$2,message='同步未完成，保留已成功拉取的日期与原有手工数据',finished_at=now(),updated_at=now() WHERE id=$1`, [run.id, String(error.message).slice(0, 1500)]).catch(() => {});
      await notify({ key: `statistics-sync:${ctx.storeId}`, subject: '【逐梦ERP】统计分析同步失败',
        text: `店铺：${ctx.storeId}\n月份：${run.month}\n任务：${run.id}\n原因：${String(error.message).slice(0, 1000)}\n手工采购费、广告费保留不变，可在统计分析中重新更新。`, minIntervalMs: 3600000 }).catch(() => {});
    } finally {
      clearCache(ctx.storeId); running.delete(ctx.storeId);
      if (acquired) await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [`statistics-sync:${ctx.storeId}`]).catch(() => {});
      lock.release();
    }
  }
  async function startSync(ctx, month, trigger = 'manual') {
    validMonth(month);
    if (running.has(ctx.storeId)) return running.get(ctx.storeId);
    const result = await transaction(ctx, async (client) => {
      const active = (await client.query(`SELECT * FROM app_statistics_runs WHERE user_id=$1 AND store_id=$2 AND status IN ${ACTIVE} ORDER BY started_at DESC LIMIT 1 FOR UPDATE`, [ctx.userId, ctx.storeId])).rows[0];
      if (active && Date.now() - new Date(active.updated_at).getTime() < 15 * 60000) return { run: active, created: false };
      const unlocked = (await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired', [`statistics-sync:${ctx.storeId}`])).rows[0].acquired;
      if (!unlocked) {
        if (active) return { run: active, created: false };
        throw fail('该店铺已有同步进程，请稍后重试', 409);
      }
      if (active) await client.query(`UPDATE app_statistics_runs SET status='failed',error='上次同步中断，可重新更新',finished_at=now() WHERE id=$1`, [active.id]);
      for (const value of new Set([month, shanghaiDate().slice(0, 7)])) await client.query(`INSERT INTO app_statistics_months(user_id,store_id,month) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [ctx.userId, ctx.storeId, value]);
      return { run: (await client.query(`INSERT INTO app_statistics_runs(user_id,store_id,month,trigger) VALUES($1,$2,$3,$4) RETURNING *`, [ctx.userId, ctx.storeId, month, trigger])).rows[0], created: true };
    });
    const { run, created } = result;
    if (!created) return run;
    running.set(ctx.storeId, run);
    setTimeout(() => work(ctx, run).catch((error) => { running.delete(ctx.storeId); logger.error('[statistics-sync]', error.message); }), 30).unref?.();
    return run;
  }
  async function tick(now = new Date()) {
    if (!db || scheduling) return;
    const local = new Date(now.getTime() + 8 * 3600000);
    if (local.getUTCHours() * 60 + local.getUTCMinutes() < SCHEDULE_HOUR * 60 + SCHEDULE_MINUTE) return;
    scheduling = true;
    try {
      const stores = await query(`SELECT s.id,s.user_id,MIN(m.month) AS month FROM app_stores s
        JOIN app_statistics_months m ON m.store_id=s.id AND m.user_id=s.user_id WHERE s.active=TRUE AND s.platform='ozon'
        AND NOT EXISTS (SELECT 1 FROM app_statistics_runs r WHERE r.store_id=s.id AND r.status='succeeded' AND (r.finished_at AT TIME ZONE 'Asia/Shanghai')::date=$1::date)
        AND NOT EXISTS (SELECT 1 FROM app_statistics_runs r WHERE r.store_id=s.id AND r.started_at>now()-interval '1 hour' AND r.status IN ('queued','running','failed'))
        GROUP BY s.id,s.user_id`, [shanghaiDate(now)]);
      for (const store of stores.rows) {
        if (running.size >= 2) break;
        await startSync({ userId: store.user_id, storeId: store.id }, store.month, 'daily');
      }
    } catch (error) { logger.error('[statistics-schedule]', error.message); }
    finally { scheduling = false; }
  }
  function start() {
    if (!db || timer) return;
    timer = setInterval(() => tick(), 60000); timer.unref?.();
    setTimeout(() => tick(), 20000).unref?.();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  function amountInput(value, label, nullable = true) {
    if (value === null && nullable) return null;
    if (value === '' || value === undefined || typeof value === 'boolean') throw fail(`${label}不能为空`);
    const amount = moneyCents(value);
    if (amount < 0 || amount > 10000000000) throw fail(`${label}必须介于0和100000000之间`);
    return amount / 100;
  }
  function versionInput(value) {
    if (!Number.isInteger(value) || value < 0) throw fail('缺少有效版本号，请刷新后重试');
    return value;
  }
  async function saveCosts(ctx, body) {
    const month = validMonth(String(body.month || ''));
    const items = body.items;
    if (!Array.isArray(items) || !items.length || items.length > 5000) throw fail('一次可维护1至5000条订单');
    if (new Set(items.map((r) => r.posting_number)).size !== items.length) throw fail('批量数据中有重复订单号');
    const selected = new Map(report(await loadData(ctx), month).rows.map((r) => [r.posting_number, r]));
    const validated = items.map((item) => {
      const row = selected.get(item.posting_number);
      if (!row) throw fail(`订单不在当前店铺所选应计月份：${item.posting_number}`);
      if (row.order_type === 'WHD订单') throw fail(`WHD 订单不维护采购费和贴单费：${item.posting_number}`);
      if (!row.cost_in_month) throw fail(`请在成本归属月维护订单费用：${item.posting_number}（${row.cost_month || '待结算'}）`);
      return { posting_number: item.posting_number, purchase_cny: amountInput(item.purchase_cny, '采购费用'),
        ...(Object.hasOwn(item, 'label_cny') ? { label_cny: amountInput(item.label_cny, '贴单费用', false) } : {}), version: versionInput(item.version) };
    });
    return transaction(ctx, async (client) => {
      const before = (await client.query(`SELECT posting_number,purchase_cny,label_cny,version FROM app_statistics_costs WHERE user_id=$1 AND store_id=$2 AND posting_number=ANY($3::text[]) FOR UPDATE`, [ctx.userId, ctx.storeId, validated.map((r) => r.posting_number)])).rows;
      const old = new Map(before.map((r) => [r.posting_number, r]));
      for (const item of validated) if (Number(old.get(item.posting_number)?.version || 0) !== item.version) throw fail(`采购费已被修改，请刷新：${item.posting_number}`, 409);
      const after = validated.map((r) => ({ ...r, label_cny: r.label_cny ?? Number(old.get(r.posting_number)?.label_cny ?? 1.5), version: r.version + 1 }));
      const snapshot = validated.map((r) => old.get(r.posting_number) || { posting_number: r.posting_number, purchase_cny: null, label_cny: 1.5, version: 0 });
      const auditId = await audit(client, ctx, 'costs', month, String(body.reason || '维护订单采购费用（含采购运费）').slice(0, 300), { before: snapshot, after });
      await client.query(`INSERT INTO app_statistics_costs(user_id,store_id,posting_number,purchase_cny,label_cny,version)
        SELECT $1,$2,x.posting_number,x.purchase_cny,x.label_cny,x.version FROM jsonb_to_recordset($3::jsonb) AS x(posting_number text,purchase_cny numeric,label_cny numeric,version integer)
        ON CONFLICT(user_id,store_id,posting_number) DO UPDATE SET purchase_cny=EXCLUDED.purchase_cny,label_cny=EXCLUDED.label_cny,version=EXCLUDED.version,updated_at=now()`, [ctx.userId, ctx.storeId, JSON.stringify(after)]);
      return { success: true, updated: after.length, snapshot_id: auditId };
    });
  }
  async function saveMonth(ctx, body) {
    const month = validMonth(String(body.month || ''));
    const version = versionInput(body.version);
    const rate = body.exchange_rate === null ? null : Number(body.exchange_rate);
    if (rate !== null && (!Number.isFinite(rate) || rate <= 0 || rate > 1 || !/^\d+(?:\.\d{1,6})?$/.test(String(body.exchange_rate)))) throw fail('汇率应为1卢布对应人民币金额，最多六位小数且不大于1');
    const amount = amountInput(body.advertising_amount, '广告费');
    const currency = String(body.advertising_currency || 'RUB');
    if (!['CNY', 'RUB'].includes(currency)) throw fail('广告费币种只能为人民币或卢布');
    return transaction(ctx, async (client) => {
      const before = (await client.query('SELECT month,exchange_rate,advertising_amount,advertising_currency,version FROM app_statistics_months WHERE user_id=$1 AND store_id=$2 AND month=$3 FOR UPDATE', [ctx.userId, ctx.storeId, month])).rows[0] || { month, exchange_rate: null, advertising_amount: null, advertising_currency: 'RUB', version: 0 };
      if (Number(before.version) !== version) throw fail('本月设置已被修改，请刷新后重试', 409);
      const after = { month, exchange_rate: rate, advertising_amount: amount, advertising_currency: currency, version: version + 1 };
      const auditId = await audit(client, ctx, 'month', month, '维护月度汇率和广告费', { before, after });
      await client.query(`INSERT INTO app_statistics_months(user_id,store_id,month,exchange_rate,advertising_amount,advertising_currency,version) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(user_id,store_id,month) DO UPDATE SET exchange_rate=EXCLUDED.exchange_rate,advertising_amount=EXCLUDED.advertising_amount,advertising_currency=EXCLUDED.advertising_currency,version=EXCLUDED.version,updated_at=now()`, [ctx.userId, ctx.storeId, month, rate, amount, currency, version + 1]);
      return { success: true, snapshot_id: auditId };
    });
  }
  async function rollback(ctx, id) {
    if (!UUID.test(id)) throw fail('无效的修改记录');
    return transaction(ctx, async (client) => {
      const change = (await client.query(`SELECT * FROM app_statistics_changes WHERE id=$1 AND user_id=$2 AND store_id=$3 FOR UPDATE`, [id, ctx.userId, ctx.storeId])).rows[0];
      if (!change || !['costs', 'month', 'ad_import', 'order_ad_import'].includes(change.kind)) throw fail('找不到可回滚的修改记录', 404);
      if (change.rolled_back_at) throw fail('该修改已经回滚', 409);
      const { before, after } = change.payload;
      if (change.kind === 'costs') {
        const current = (await client.query(`SELECT posting_number,purchase_cny,label_cny,version FROM app_statistics_costs WHERE user_id=$1 AND store_id=$2 AND posting_number=ANY($3::text[]) FOR UPDATE`, [ctx.userId, ctx.storeId, after.map((r) => r.posting_number)])).rows;
        const versions = new Map(current.map((r) => [r.posting_number, Number(r.version)]));
        for (const row of after) if (versions.get(row.posting_number) !== row.version) throw fail(`该订单之后又有修改，不能覆盖回滚：${row.posting_number}`, 409);
        const restored = before.map((r) => ({ ...r, version: versions.get(r.posting_number) + 1 }));
        await audit(client, ctx, 'rollback', change.month, `回滚 ${id}`, { original_id: id, before: current, after: restored });
        for (const row of restored) await client.query(`UPDATE app_statistics_costs SET purchase_cny=$4,label_cny=$5,version=$6,updated_at=now() WHERE user_id=$1 AND store_id=$2 AND posting_number=$3`, [ctx.userId, ctx.storeId, row.posting_number, row.purchase_cny, row.label_cny, row.version]);
      } else if (change.kind === 'ad_import') {
        const timezone = change.payload.timezone, dates = after.map((d) => d.spend_date);
        const current = (await client.query(`SELECT spend_date::text AS spend_date,cpo_rub,cpc_rub,source FROM app_statistics_ad_days
          WHERE user_id=$1 AND store_id=$2 AND business_timezone=$3 AND spend_date=ANY($4::date[]) FOR UPDATE`, [ctx.userId, ctx.storeId, timezone, dates])).rows;
        const normalized = (items) => items.map((d) => ({ ...d, cpo_rub: moneyCents(d.cpo_rub) / 100, cpc_rub: moneyCents(d.cpc_rub) / 100 }));
        if (adRevision(normalized(current)) !== adRevision(normalized(after))) throw fail('每日广告费之后又有修改，不能覆盖回滚', 409);
        await audit(client, ctx, 'rollback', null, `回滚 ${id}`, { original_id: id, before: current, after: before });
        await client.query('DELETE FROM app_statistics_ad_days WHERE user_id=$1 AND store_id=$2 AND business_timezone=$3 AND spend_date=ANY($4::date[])', [ctx.userId, ctx.storeId, timezone, dates]);
        if (before.length) await client.query(`INSERT INTO app_statistics_ad_days(user_id,store_id,spend_date,business_timezone,cpo_rub,cpc_rub,source)
          SELECT $1,$2,x.spend_date,$3,x.cpo_rub,x.cpc_rub,x.source FROM jsonb_to_recordset($4::jsonb) AS x(spend_date date,cpo_rub numeric,cpc_rub numeric,source text)`, [ctx.userId, ctx.storeId, timezone, JSON.stringify(before)]);
      } else if (change.kind === 'order_ad_import') {
        const current = (await client.query('SELECT entries,version FROM app_statistics_order_ad_reports WHERE user_id=$1 AND store_id=$2 AND month=$3 FOR UPDATE',
          [ctx.userId, ctx.storeId, change.month])).rows[0];
        if (current?.version !== after.version || !isDeepStrictEqual(current.entries, after.entries)) throw fail('逐单广告报表之后又有修改，不能覆盖回滚', 409);
        await audit(client, ctx, 'rollback', change.month, `回滚 ${id}`, { original_id: id, before: current, after: before });
        if (before) await client.query('UPDATE app_statistics_order_ad_reports SET entries=$4,version=version+1 WHERE user_id=$1 AND store_id=$2 AND month=$3',
          [ctx.userId, ctx.storeId, change.month, JSON.stringify(before.entries)]);
        else await client.query('DELETE FROM app_statistics_order_ad_reports WHERE user_id=$1 AND store_id=$2 AND month=$3', [ctx.userId, ctx.storeId, change.month]);
      } else {
        const current = (await client.query(`SELECT * FROM app_statistics_months WHERE user_id=$1 AND store_id=$2 AND month=$3 FOR UPDATE`, [ctx.userId, ctx.storeId, change.month])).rows[0];
        if (Number(current?.version) !== after.version) throw fail('本月设置之后又有修改，不能覆盖回滚', 409);
        await audit(client, ctx, 'rollback', change.month, `回滚 ${id}`, { original_id: id, before: current, after: before });
        await client.query(`UPDATE app_statistics_months SET exchange_rate=$4,advertising_amount=$5,advertising_currency=$6,version=version+1,updated_at=now() WHERE user_id=$1 AND store_id=$2 AND month=$3`, [ctx.userId, ctx.storeId, change.month, before.exchange_rate, before.advertising_amount, before.advertising_currency]);
      }
      await client.query('UPDATE app_statistics_changes SET rolled_back_at=now() WHERE id=$1', [id]);
      return { success: true };
    });
  }
  const filteredRows = filterReportRows;
  function publicAdvertising(config) {
    return { configured: !!config, client_id: config?.client_id || '', business_timezone: config?.business_timezone || DEFAULT_AD_TIMEZONE,
      version: config?.version || 0, last_synced_at: config?.last_synced_at || null, last_error: config?.last_error || '' };
  }
  const adRevision = (days) => crypto.createHash('sha256').update(JSON.stringify([...days].sort((a, b) => a.spend_date.localeCompare(b.spend_date)).map((d) => [d.spend_date, moneyCents(d.cpo_rub), moneyCents(d.cpc_rub), d.source]))).digest('hex');
  async function importAdvertising(ctx, body) {
    const timezone = DEFAULT_AD_TIMEZONE, items = body.days;
    if (!Array.isArray(items) || !items.length || items.length > 1100) throw fail('一次导入1至1100天广告费用');
    const today = businessDate(new Date(), timezone);
    const days = items.map((d) => {
      const date = String(d.spend_date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date >= today) throw fail('只能导入已结束日期的广告费');
      validMonth(date.slice(0, 7));
      return { spend_date: date, cpo_rub: moneyCents(d.cpo_rub) / 100, cpc_rub: moneyCents(d.cpc_rub) / 100 };
    });
    if (new Set(days.map((d) => d.spend_date)).size !== days.length) throw fail('导入广告日期重复');
    return transaction(ctx, async (client) => {
      const config = (await client.query('SELECT business_timezone FROM app_statistics_ad_config WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId])).rows[0];
      if (config && config.business_timezone !== timezone) throw fail('后台日报按莫斯科时间统计，请先将广告时区设为Europe/Moscow');
      const previous = (await client.query('SELECT spend_date::text AS spend_date,cpo_rub,cpc_rub,source FROM app_statistics_ad_days WHERE user_id=$1 AND store_id=$2 AND business_timezone=$3 FOR UPDATE', [ctx.userId, ctx.storeId, timezone])).rows;
      if (body.revision !== adRevision(previous)) throw fail('每日广告费已改变，请重新读取后导入', 409);
      const before = previous.filter((d) => days.some((x) => x.spend_date === d.spend_date));
      const snapshot = await audit(client, ctx, 'ad_import', null, '导入后台每日广告费', { timezone, before, after: days.map((d) => ({ ...d, source: 'seller-report' })) });
      await client.query(`INSERT INTO app_statistics_ad_days(user_id,store_id,spend_date,business_timezone,cpo_rub,cpc_rub,source)
        SELECT $1,$2,x.spend_date,$3,x.cpo_rub,x.cpc_rub,'seller-report' FROM jsonb_to_recordset($4::jsonb) AS x(spend_date date,cpo_rub numeric,cpc_rub numeric)
        ON CONFLICT(user_id,store_id,spend_date,business_timezone) DO UPDATE SET cpo_rub=EXCLUDED.cpo_rub,cpc_rub=EXCLUDED.cpc_rub,source=EXCLUDED.source,confirmed_at=now()`, [ctx.userId, ctx.storeId, timezone, JSON.stringify(days)]);
      return { success: true, snapshot_id: snapshot, days: days.length };
    });
  }
  async function saveAdvertising(ctx, body) {
    const version = versionInput(body.version), timezone = String(body.business_timezone || DEFAULT_AD_TIMEZONE);
    if (timezone !== DEFAULT_AD_TIMEZONE) throw fail('广告日报必须使用莫斯科业务时区');
    const clientId = String(body.client_id || '').trim(), secret = body.client_secret;
    if (!clientId || clientId.length > 300 || secret != null && (typeof secret !== 'string' || secret.length > 3000)) throw fail('广告授权参数无效');
    return transaction(ctx, async (client) => {
      const before = (await client.query('SELECT * FROM app_statistics_ad_config WHERE user_id=$1 AND store_id=$2 FOR UPDATE', [ctx.userId, ctx.storeId])).rows[0];
      if (version !== (before?.version || 0)) throw fail('广告配置已改变，请刷新重试', 409);
      if (!secret && (!before || before.client_id !== clientId)) throw fail('新增或更换Client ID时必须填写Client Secret');
      const cipher = secret ? sealCredential(secret, credentialSecret) : before.secret_cipher;
      await audit(client, ctx, 'ad_config', null, '更新Performance广告授权', { before: before ? { client_id: before.client_id, business_timezone: before.business_timezone, version: before.version } : null,
        after: { client_id: clientId, business_timezone: timezone, version: version + 1 } });
      await client.query(`INSERT INTO app_statistics_ad_config(user_id,store_id,client_id,secret_cipher,business_timezone,version)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,store_id) DO UPDATE SET client_id=EXCLUDED.client_id,secret_cipher=EXCLUDED.secret_cipher,
        business_timezone=EXCLUDED.business_timezone,version=EXCLUDED.version,last_error='',updated_at=now()`, [ctx.userId, ctx.storeId, clientId, cipher, timezone, version + 1]);
      return { success: true };
    });
  }
  async function importOrderAdReport(ctx, body) {
    const month = validMonth(String(body.month || '')), { start, end } = monthBounds(month);
    if (end >= businessDate(new Date(), DEFAULT_AD_TIMEZONE)) throw fail('只能导入已结束月份的逐单广告报表');
    const version = versionInput(body.version);
    if (!Array.isArray(body.entries) || body.entries.length > 50000) throw fail('逐单广告报表格式错误或超过 50000 行');
    const dates = datesBetween(start, end), totals = new Map(dates.map((date) => [date, 0])), seen = new Set();
    const validId = (id) => typeof id === 'string' && /^\d{1,24}$/.test(id);
    const entries = body.entries.map((entry) => {
      const { date, order_number, sku, order_id, cents, quantity } = entry || {};
      if (!totals.has(date) || typeof order_number !== 'string' || order_number.length > 64 || !/^\d+-\d+(?:-\d+)?$/.test(order_number)
        || !validId(sku) || !validId(order_id) || !Number.isSafeInteger(cents) || Math.abs(cents) > 10000000000
        || !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 100000) throw fail('逐单广告明细的日期、订单号、SKU、数量或金额无效');
      const key = JSON.stringify([date, order_number, sku, order_id, cents, quantity]);
      if (seen.has(key)) throw fail('逐单广告报表存在重复记录');
      seen.add(key); totals.set(date, totals.get(date) + cents);
      return { date, order_number, sku, order_id, cents, quantity };
    });
    return transaction(ctx, async (client) => {
      const daily = (await client.query(`SELECT spend_date::text AS spend_date,cpo_rub FROM app_statistics_ad_days
        WHERE user_id=$1 AND store_id=$2 AND business_timezone=$3 AND spend_date BETWEEN $4 AND $5 FOR UPDATE`,
        [ctx.userId, ctx.storeId, DEFAULT_AD_TIMEZONE, start, end])).rows;
      const paid = new Map(daily.map((d) => [d.spend_date, moneyCents(d.cpo_rub)]));
      const mismatch = dates.find((date) => paid.get(date) !== totals.get(date));
      if (mismatch) throw fail(`逐单报表与广告日报的按订单付费未对平：${mismatch}`, 409);
      const before = (await client.query('SELECT entries,version FROM app_statistics_order_ad_reports WHERE user_id=$1 AND store_id=$2 AND month=$3 FOR UPDATE',
        [ctx.userId, ctx.storeId, month])).rows[0] || null;
      if ((before?.version || 0) !== version) throw fail('逐单广告报表已更新，请重新核对版本', 409);
      const after = { entries, version: version + 1 };
      const snapshot = await audit(client, ctx, 'order_ad_import', month, '导入 Ozon 按订单付费原始报表', { before, after });
      await client.query(`INSERT INTO app_statistics_order_ad_reports(user_id,store_id,month,entries,version) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(user_id,store_id,month) DO UPDATE SET entries=EXCLUDED.entries,version=EXCLUDED.version`,
        [ctx.userId, ctx.storeId, month, JSON.stringify(entries), after.version]);
      const orders = (await client.query('SELECT payload FROM app_statistics_orders WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId])).rows;
      const { centsByPosting, unmatched } = matchOrderAdRows(entries, orders.map((r) => r.payload));
      return { success: true, snapshot_id: snapshot, entries: entries.length, matched_orders: centsByPosting.size,
        matched_rub: [...centsByPosting.values()].reduce((n, c) => n + c, 0) / 100, unmatched_entries: unmatched.length,
        unmatched_rub: unmatched.reduce((n, row) => n + row.cents, 0) / 100 };
    });
  }
  function sendCsv(res, filename, rows) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send('\ufeff' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n'));
  }
  function register(app, requireAuth) {
    const route = (method, url, action) => app[method](PREFIX + url, requireAuth, async (req, res, next) => {
      try { const ctx = await context(req); res.setHeader('Cache-Control', 'no-store'); await action(req, res, ctx); } catch (error) { next(error); }
    });
    const reportRoute = async (req, res, ctx) => {
      const params = (req.method === 'POST' ? req.body : req.query) || {};
      const month = validMonth(String(params.month || shanghaiDate().slice(0, 7)));
      const data = await loadData(ctx), result = report(data, month);
      const rows = filteredRows(result.rows, params);
      const size = Math.min(500, Math.max(1, parseInt(params.page_size, 10) || 100));
      const page = Math.max(1, parseInt(params.page, 10) || 1);
      res.json({ success: true, rows: rows.slice((page - 1) * size, page * size), total: rows.length, summary: result.summary, run: await latestRun(ctx),
        advertising: { ...publicAdvertising(data.adConfig), ...result.advertising }, filter_catalog: REPORT_FIELDS,
        schedule: { time: '08:30', timezone: 'Asia/Shanghai', frequency: 'daily' } });
    };
    route('get', '/report', reportRoute);
    route('post', '/report', reportRoute);
    route('get', '/months', async (req, res, ctx) => {
      const from = validMonth(String(req.query.from || shanghaiDate().slice(0, 7)));
      const to = validMonth(String(req.query.to || shanghaiDate().slice(0, 7)));
      if (from > to || serialMonth(to) - serialMonth(from) > 23) throw fail('汇总范围须为1至24个月');
      const data = await loadData(ctx), summaries = [];
      for (let month = from; month <= to;) {
        summaries.push(report(data, month).summary);
        month = new Date(Date.parse(monthBounds(month).end + 'T00:00:00Z') + 86400000).toISOString().slice(0, 7);
      }
      res.json({ success: true, rows: summaries, run: await latestRun(ctx) });
    });
    route('get', '/exceptions', async (req, res, ctx) => {
      const month = validMonth(String(req.query.month || ''));
      const result = report(await loadData(ctx), month);
      const entries = settlementExceptions(result, String(req.query.group || 'total'), String(req.query.kind || ''));
      const size = 100, page = Math.max(1, parseInt(req.query.page, 10) || 1);
      res.json({ rows: entries.slice((page - 1) * size, page * size), total: entries.length, page_size: size,
        coverage_complete: result.summary.coverage.complete, exchange_rate: result.summary.exchange_rate });
    });
    route('post', '/sync', async (req, res, ctx) => res.status(202).json({ success: true, run: await startSync(ctx, String(req.body.month || '')) }));
    route('patch', '/costs', async (req, res, ctx) => res.json(await saveCosts(ctx, req.body)));
    route('patch', '/month', async (req, res, ctx) => res.json(await saveMonth(ctx, req.body)));
    route('get', '/advertising/config', async (req, res, ctx) => res.json(publicAdvertising((await loadData(ctx)).adConfig)));
    route('patch', '/advertising/config', async (req, res, ctx) => res.json(await saveAdvertising(ctx, req.body)));
    route('get', '/advertising/days', async (req, res, ctx) => {
      const days = (await loadData(ctx)).adDays.filter((d) => d.business_timezone === DEFAULT_AD_TIMEZONE);
      res.json({ days, revision: adRevision(days), business_timezone: DEFAULT_AD_TIMEZONE });
    });
    route('post', '/advertising/import', async (req, res, ctx) => res.json(await importAdvertising(ctx, req.body)));
    route('post', '/advertising/order-report', async (req, res, ctx) => res.json(await importOrderAdReport(ctx, req.body)));
    route('get', '/changes', async (req, res, ctx) => {
      const result = await query(`SELECT id,kind,month,reason,created_at,rolled_back_at,
        CASE WHEN kind='costs' THEN jsonb_array_length(payload->'after') WHEN kind='order_ad_import' THEN jsonb_array_length(payload->'after'->'entries') ELSE 1 END AS affected
        FROM app_statistics_changes WHERE user_id=$1 AND store_id=$2 AND kind IN ('costs','month','rollback','ad_import','order_ad_import') ORDER BY created_at DESC LIMIT 100`, [ctx.userId, ctx.storeId]);
      res.json({ success: true, rows: result.rows });
    });
    route('post', '/changes/:id/rollback', async (req, res, ctx) => res.json(await rollback(ctx, req.params.id)));
    route('get', '/ledger', async (req, res, ctx) => {
      const result = report(await loadData(ctx), validMonth(String(req.query.month || '')));
      const posting = String(req.query.posting_number || '');
      if (!result.rows.some((r) => r.posting_number === posting)) throw fail('订单不在所选应计月份', 404);
      res.json({ success: true, rows: result.ledger.filter((r) => r.posting_number === posting), pending: result.pending.filter((r) => r.postings.includes(posting)) });
    });
    route('get', '/order-detail', async (req, res, ctx) => {
      const posting = req.query.posting_number;
      if (typeof posting !== 'string' || posting.length > 64 || !/^\d+-\d+-\d+$/.test(posting)) throw fail('请输入完整订单号');
      const order = (await query('SELECT payload,updated_at FROM app_statistics_orders WHERE user_id=$1 AND store_id=$2 AND posting_number=$3',
        [ctx.userId, ctx.storeId, posting])).rows[0];
      if (!order) return res.json({ success: true, detail: null });
      const products = Array.isArray(order.payload.products) ? order.payload.products : [];
      const offerIds = [...new Set(products.map((p) => p.offer_id).filter(Boolean))];
      const items = offerIds.length ? (await query('SELECT offer_id,name,image FROM app_products WHERE user_id=$1 AND store_id=$2 AND offer_id=ANY($3::text[])',
        [ctx.userId, ctx.storeId, offerIds])).rows : [];
      const catalog = new Map(items.map((p) => [p.offer_id, p]));
      const cached = products.some((p) => !catalog.get(p.offer_id)?.image)
        ? (await query("SELECT payload->'products' AS products FROM app_order_cache WHERE user_id=$1 AND store_id=$2 AND posting_number=$3",
          [ctx.userId, ctx.storeId, posting])).rows[0]?.products : null;
      res.json({ success: true, detail: { order_number: order.payload.order_number, updated_at: order.updated_at,
        products: products.map((p) => {
          const product = catalog.get(p.offer_id);
          const fallback = Array.isArray(cached) && cached.find((item) => item && (p.offer_id && item.offer_id
            ? p.offer_id === item.offer_id && (!p.sku || !item.sku || String(p.sku) === String(item.sku))
            : p.sku && item.sku && String(p.sku) === String(item.sku)));
          return { sku: p.sku, offer_id: p.offer_id, quantity: p.quantity, name: product?.name || fallback?.name || '',
            image: product?.image || fallback?.image || '' };
        }) } });
    });
    const exportRoute = async (req, res, ctx) => {
      const params = (req.method === 'POST' ? req.body : req.query) || {};
      const month = validMonth(String(params.month || ''));
      const result = report(await loadData(ctx), month);
      sendCsv(res, `${ctx.store.name}-${month}-应计订单.csv`, [[...REPORT_FIELDS.map((field) => field.label), '成本归属月', '广告分摊日', '分摊订单数', '点击广告状态', '已归属 Ozon 净额（₽）', '实收说明'],
        ...filteredRows(result.rows, params).map((r) => [...REPORT_FIELDS.map((field) => field.key === 'ordered_at'
          ? (r.ordered_at ? new Date(Date.parse(r.ordered_at) + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') : '') : r[field.key]),
          r.cost_month, r.allocation_date, r.allocation_order_count, r.advertising_state, r.platform_net_rub,
          [r.pending_positive || r.pending_negative ? '仅含已归属流水' : '', r.advertising_rub == null ? '按订单广告待核对' : ''].filter(Boolean).join('；')])]);
    };
    route('get', '/export', exportRoute);
    route('post', '/export', exportRoute);
  }
  async function importSnapshot(ctx, { accruals, orders, days, month }) {
    validMonth(month);
    for (const date of days) await replaceDay(ctx, date, accruals.filter((r) => r.date === date));
    for (let i = 0; i < orders.length; i += 250) await saveOrders(ctx, orders.slice(i, i + 250));
    await transaction(ctx, async (client) => {
      for (const value of new Set([month, shanghaiDate().slice(0, 7)])) await client.query(`INSERT INTO app_statistics_months(user_id,store_id,month) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [ctx.userId, ctx.storeId, value]);
      await client.query(`INSERT INTO app_statistics_runs(user_id,store_id,month,trigger,status,message,days_done,days_total,finished_at)
        VALUES($1,$2,$3,'seed','succeeded','已导入逐笔核对过的 API 快照',$4,$4,now())`, [ctx.userId, ctx.storeId, month, days.length]);
    });
  }
  return { init, register, start, stop, startSync, tick, loadData, report, saveCosts, saveMonth, saveAdvertising, importAdvertising, syncAdvertising, rollback, replaceDay, saveOrders, importSnapshot, filteredRows };
}
