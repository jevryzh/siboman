import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  cancellationReason, csvCell, datesBetween, fail, financialDate, isFormalAccrual,
  moneyCents, monthBounds, normalizeOrder, parentOf, rounded, shanghaiDate, STATUS_NAMES, validateAccrual,
} from './ozon-settlement.js';
import { businessDate, DEFAULT_AD_TIMEZONE, filterReportRows, matchOrderAdRows, monthlyAccrualReport, orderTimestamp, REPORT_FIELDS, settlementExceptions } from './statistics-daily-report.js';
import { createPerformanceClient, openCredential, sealCredential } from './ozon-performance.js';

const ACTIVE = "('queued','running')";
const PREFIX = '/api/statistics';
// 每日自动同步时间点（北京时间）：02:00、09:30（后者在 ERP 08:00 订单同步之后）
const SCHEDULE_SLOTS = [[2, 0], [9, 30]];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const utcDay = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
// pg 的 DATE 列会解析成「本地时区午夜的 Date」，直接 toISOString 会整体错一天
const dateOnly = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
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
-- 结算日期：取消订单在「被发现取消」那天生效，只写一次，后续不覆盖
ALTER TABLE app_statistics_orders ADD COLUMN IF NOT EXISTS settled_date DATE;
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
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
  records INTEGER
);
ALTER TABLE app_statistics_runs ADD COLUMN IF NOT EXISTS from_date DATE;
ALTER TABLE app_statistics_runs ADD COLUMN IF NOT EXISTS to_date DATE;
ALTER TABLE app_statistics_runs ADD COLUMN IF NOT EXISTS records INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_statistics_active_run ON app_statistics_runs(store_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS idx_statistics_runs_store ON app_statistics_runs(user_id,store_id,started_at DESC);
ALTER TABLE app_statistics_runs ADD COLUMN IF NOT EXISTS from_date DATE;
ALTER TABLE app_statistics_runs ADD COLUMN IF NOT EXISTS to_date DATE;
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
-- 逐单广告明细（按天独立存储，便于增量导入与重叠校验）
CREATE TABLE IF NOT EXISTS app_statistics_order_ad_entries (
  user_id UUID NOT NULL REFERENCES app_users(id), store_id UUID NOT NULL REFERENCES app_stores(id),
  ad_date DATE NOT NULL, order_number TEXT NOT NULL, sku TEXT NOT NULL,
  mode TEXT NOT NULL, cents BIGINT NOT NULL, quantity INTEGER NOT NULL,
  ad_order_id TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, store_id, ad_date, order_number, sku, mode)
);
CREATE INDEX IF NOT EXISTS idx_order_ad_entries_order ON app_statistics_order_ad_entries(user_id, store_id, order_number);
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
    const meta = await query('SELECT payload, settled_date::text AS settled_date FROM app_statistics_orders WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId]);
    const costs = await query('SELECT posting_number,purchase_cny,label_cny,version FROM app_statistics_costs WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId]);
    const months = await query('SELECT * FROM app_statistics_months WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId]);
    const days = await query('SELECT accrued_date::text AS accrued_date,checked_at FROM app_statistics_days WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId]);
    const adConfig = await query('SELECT client_id,business_timezone,version,last_synced_at,last_error FROM app_statistics_ad_config WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId]);
    const ads = await query('SELECT spend_date::text AS spend_date,business_timezone,cpo_rub,cpc_rub,confirmed_at,source FROM app_statistics_ad_days WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId]);
    const orderDays = await query('SELECT ordered_date::text AS ordered_date,business_timezone FROM app_statistics_order_days WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId]);
    const orderAdReports = await query('SELECT ad_date::text AS ad_date, order_number, sku, mode, cents, quantity, ad_order_id FROM app_statistics_order_ad_entries WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId]);
    const rate = await query(`SELECT rate FROM app_exchange_rates WHERE base_currency='RUB' AND quote_currency='CNY' ORDER BY effective_at DESC LIMIT 1`);
    const data = { accruals: raw.rows.map((r) => r.payload), orders: meta.rows.map((r) => ({ ...r.payload, settled_date: r.settled_date || null })), costs: costs.rows,
      months: months.rows, days: days.rows, rate: rate.rows[0] ? Number(rate.rows[0].rate) : Number(defaultRate),
      adConfig: adConfig.rows[0] || null, adDays: ads.rows, orderDays: orderDays.rows,
      orderAdEntries: orderAdReports.rows.map((r) => ({ date: r.ad_date, order_number: r.order_number, sku: r.sku,
        mode: r.mode, cents: Number(r.cents), quantity: Number(r.quantity), order_id: r.ad_order_id })) };
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
  // 月度汇总（新口径）：以订单表的结算日期归月，整单归月；未结算单独一行
  // 起点 2026-10，最后一条固定是「未结算」
  const SUMMARY_START = '2026-10';
  const SUMMARY_GROUPS = [['delivered', '正常签收订单'], ['cancelled', '取消订单'], ['whd', 'WHD订单'], ['other', '其他状态订单']];
  function settlementBucket(order) {
    if (order.schema === 'fbo') return 'whd';
    const status = String(order.status || '');
    if (status === 'delivered') return 'delivered';
    if (status.startsWith('cancelled') || status === 'returned') return 'cancelled';
    return 'other';
  }
  function settlementSummary(data) {
    // 先把流水按结算单元号聚合（收入 / 支出）
    const unitTotals = new Map();
    for (const entry of data.accruals) {
      const unit = String(entry.unit_number || '');
      if (!unit) continue;
      const cents = moneyCents(entry.total_amount?.amount ?? 0);
      if (!cents) { if (!unitTotals.has(unit)) unitTotals.set(unit, { income: 0, expense: 0 }); continue; }
      const item = unitTotals.get(unit) || { income: 0, expense: 0 };
      if (cents > 0) item.income += cents; else item.expense += -cents;
      unitTotals.set(unit, item);
    }
    const costMap = new Map(data.costs.map((c) => [c.posting_number, c]));
    const buckets = new Map();
    const bucket = (key) => {
      if (!buckets.has(key)) buckets.set(key, { orders: 0, income: 0, expense: 0, purchase: 0, label: 0, missing_purchase: 0, low_income: 0 });
      return buckets.get(key);
    };
    // 订单按结算月份归集；整单所有流水都算到该月（方案 1）
    for (const order of data.orders) {
      // 与订单明细一致：2026-07 之前下单的不纳入
      const placed = String(orderTimestamp(order) || '').slice(0, 10);
      if (!placed || placed < SYNC_MIN_DATE) continue;
      const month = order.settled_date ? String(order.settled_date).slice(0, 7) : 'unsettled';
      const group = settlementBucket(order);
      const totals = unitTotals.get(order.posting_number) || { income: 0, expense: 0 };
      const cost = costMap.get(order.posting_number);
      const purchase = moneyCents(cost?.purchase_cny ?? 0), label = moneyCents(cost?.label_cny ?? 0);
      for (const key of [month, `${month}|${group}`]) {
        const b = bucket(key);
        b.orders += 1;
        b.income += totals.income;
        b.expense += totals.expense;
        b.purchase += purchase;
        b.label += label;
        if (order.schema !== 'fbo' && cost?.purchase_cny == null) b.missing_purchase += 1;
        if (totals.income && totals.income < 10000) b.low_income += 1;
      }
    }
    // 「其他状态订单」额外并入结算审计表里挂在主单号上的费用，按应计月归月
    for (const entry of data.accruals) {
      const unit = String(entry.unit_number || '');
      if (!/^\d+-\d+$/.test(unit)) continue;
      const cents = moneyCents(entry.total_amount?.amount ?? 0);
      if (!cents) continue;
      const month = String(entry.date || '').slice(0, 7);
      if (!month) continue;
      for (const key of [month, `${month}|other`]) {
        const b = bucket(key);
        if (cents > 0) b.income += cents; else b.expense += -cents;
      }
    }
    const rate = data.rate;
    const build = (key, label, isGroup, groupKey) => {
      const b = buckets.get(key) || { orders: 0, income: 0, expense: 0, purchase: 0, label: 0, missing_purchase: 0, low_income: 0 };
      const income = b.income / 100, expense = b.expense / 100, net = income - expense;
      const receiptCny = Number.isFinite(rate) && rate > 0 ? rounded(net * rate) : null;
      const purchase = b.purchase / 100, labelCny = b.label / 100;
      const profit = receiptCny == null ? null : rounded(receiptCny - purchase - labelCny);
      const month = key.split('|')[0];
      return {
        id: `${key}:${groupKey || 'total'}`, month, group: groupKey || 'total', label, is_group: isGroup,
        orders: b.orders, income_rub: rounded(income), ozon_fees_rub: rounded(expense),
        purchase_cny: rounded(purchase), label_cny: rounded(labelCny),
        receipt_rub: rounded(net), receipt_cny: receiptCny, known_receipt_rub: rounded(net), known_receipt_cny: receiptCny,
        profit_cny: profit, known_cost_profit_cny: profit, profit_orders: b.orders, profit_excluded_orders: 0,
        advertising_rub: null, allocated_ad_rub: null, order_ad_rub: null,
        missing_advertising: 0, missing_receipt_rub: 0, missing_receipt_cny: 0,
        missing_purchase: b.missing_purchase, low_income_orders: b.low_income,
        coverage: { complete: true, checked_days: 1 },
      };
    };
    const months = [...new Set([...buckets.keys()].map((key) => key.split('|')[0]))]
      .filter((month) => month !== 'unsettled' && month >= SUMMARY_START).sort();
    const rows = months.map((month) => ({
      ...build(month, `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`, false),
      children: SUMMARY_GROUPS.map(([group, label]) => build(`${month}|${group}`, label, true, group)),
    }));
    rows.push({
      ...build('unsettled', '未结算', false),
      children: SUMMARY_GROUPS.map(([group, label]) => build(`unsettled|${group}`, label, true, group)),
    });
    return rows;
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
      const previous = (await client.query("SELECT payload FROM app_statistics_accruals WHERE user_id=$1 AND store_id=$2 AND ((accrued_date=$3 AND coalesce(payload->>'source','ozon') <> 'ad_report') OR accrual_id=ANY($4::text[])) FOR UPDATE", [ctx.userId, ctx.storeId, date, records.map((r) => r.accrual_id)])).rows.map((r) => r.payload);
      const sorted = (items) => [...items].sort((a, b) => a.accrual_id.localeCompare(b.accrual_id));
      if (!isDeepStrictEqual(sorted(previous), sorted(records))) {
        await audit(client, ctx, 'sync_day', date.slice(0, 7), `同步应计日期 ${date}`, { date, before: previous, after_ids: records.map((r) => r.accrual_id) });
        // 只替换 Ozon 同步来的流水；逐单报表写入的广告行（source=ad_report）必须保留
        await client.query("DELETE FROM app_statistics_accruals WHERE user_id=$1 AND store_id=$2 AND accrued_date=$3 AND coalesce(payload->>'source','ozon') <> 'ad_report'", [ctx.userId, ctx.storeId, date]);
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
      const prepared = incoming.map((row) => {
        const prior = old.get(row.posting_number);
        return {
          payload: {
            ...row,
            cancellation: row.cancellation?.cancel_reason ? row.cancellation : prior?.status === row.status ? (prior.cancellation || row.cancellation) : row.cancellation,
          },
          prior,
        };
      });
      const changed = prepared.filter((item) => !isDeepStrictEqual(item.payload, item.prior));
      if (!changed.length) return;
      await audit(client, ctx, 'sync_orders', null, '同步订单资料', { before: changed.map((i) => ({ posting_number: i.payload.posting_number, payload: i.prior || null })), after_ids: changed.map((i) => i.payload.posting_number) });
      await client.query(`INSERT INTO app_statistics_orders(user_id,store_id,posting_number,payload)
        SELECT $1,$2,x->>'posting_number',x FROM jsonb_array_elements($3::jsonb) x
        ON CONFLICT(user_id,store_id,posting_number) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()`, [ctx.userId, ctx.storeId, JSON.stringify(changed.map((i) => i.payload))]);
      // 只有当订单「从非取消变成取消」时才落结算日期；已经是取消状态的、以及已有结算日期的一律不动
      const becameCancelled = changed
        .filter((i) => !String(i.prior?.status || '').startsWith('cancelled') && String(i.payload.status || '').startsWith('cancelled'))
        .map((i) => i.payload.posting_number);
      if (becameCancelled.length) {
        await client.query(`UPDATE app_statistics_orders SET settled_date=$4, updated_at=now()
          WHERE user_id=$1 AND store_id=$2 AND posting_number=ANY($3::text[]) AND settled_date IS NULL`,
          [ctx.userId, ctx.storeId, becameCancelled, shanghaiDate()]);
      }
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
      if (!next) { await replaceDay(ctx, date, records); return records.length; }
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
  // 拿「销售收入」的应计日回填订单结算日期：只处理非取消订单，取首笔收入那天
  async function updateSettledFromSales(ctx) {
    const result = await query(`
      UPDATE app_statistics_orders o
      SET settled_date = s.sale_date, updated_at = now()
      FROM (
        SELECT payload->>'unit_number' AS u, min(accrued_date) AS sale_date
        FROM app_statistics_accruals
        WHERE user_id=$1 AND store_id=$2
          AND payload->>'accrued_category'='POSTING'
          AND (payload->'total_amount'->>'amount')::numeric > 0
          AND payload->>'unit_number' ~ '^[0-9]+-[0-9]+-[0-9]+$'
        GROUP BY 1
      ) s
      WHERE o.user_id=$1 AND o.store_id=$2 AND o.posting_number = s.u
        AND NOT (o.payload->>'status' LIKE 'cancelled%')
        AND o.settled_date IS DISTINCT FROM s.sale_date`, [ctx.userId, ctx.storeId]);
    return result.rowCount || 0;
  }
  async function work(ctx, run) {
    const lock = await db.connect();
    let acquired = false;
    try {
      acquired = (await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [`statistics-sync:${ctx.storeId}`])).rows[0].acquired;
      if (!acquired) throw fail('该店铺已有同步任务', 409);
      await heartbeat(run.id, { status: 'running', message: '准备同步应计流水' });
      // 该店铺从未同步过时忽略范围，直接做一次全量（起点不早于 SYNC_MIN_DATE）
      const hasHistory = ((await query('SELECT 1 FROM app_statistics_accruals WHERE user_id=$1 AND store_id=$2 LIMIT 1', [ctx.userId, ctx.storeId])).rowCount || 0) > 0;
      const rangeFrom = hasHistory && run.from_date ? dateOnly(run.from_date) : null;
      const rangeTo = hasHistory && run.to_date ? dateOnly(run.to_date) : null;
      const months = await query('SELECT month FROM app_statistics_months WHERE user_id=$1 AND store_id=$2 ORDER BY month', [ctx.userId, ctx.storeId]);
      const earliest = months.rows[0]?.month || run.month;
      const fallback = monthBounds(earliest < run.month ? earliest : run.month).start;
      const start = rangeFrom || (fallback < SYNC_MIN_DATE ? SYNC_MIN_DATE : fallback);
      const days = datesBetween(start, rangeTo || financialDate());
      await heartbeat(run.id, { days_total: days.length });
      let fetched = 0;
      for (let i = 0; i < days.length; i++) {
        fetched += (await fetchDay(ctx, days[i], run.id)) || 0;
        await heartbeat(run.id, { days_done: i + 1, records: fetched });
      }
      const missing = await fetchOrders(ctx, start, run.id);
      await updateSettledFromSales(ctx);
      const adsReady = await syncAdvertising(ctx, run.id);
      const message = missing ? `应计流水已更新，${missing} 单资料待补充` : adsReady ? '应计流水、全部订单及每日广告费已更新' : '财务和订单已更新；广告可导入后台日报或配置Performance授权';
      await query(`UPDATE app_statistics_runs SET status='succeeded',message=$2,records=$3,finished_at=now(),updated_at=now() WHERE id=$1`, [run.id, message, fetched]);
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
  // 结算数据起点：Ozon 侧 2026-07-01 之前的账不再补拉
  const SYNC_MIN_DATE = '2026-07-01';
  function validateSyncRange(from, to) {
    const valid = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s))
      && new Date(s).toISOString().slice(0, 10) === s;
    if (!valid(from) || !valid(to)) throw fail('请选择有效的开始与结束日期');
    if (from > to) throw fail('开始日期不能晚于结束日期');
    if (from < SYNC_MIN_DATE) throw fail(`结算数据最早从 ${SYNC_MIN_DATE} 开始，不能往前拉`);
    if (to > shanghaiDate()) throw fail('结束日期不能晚于今天');
    if (datesBetween(from, to).length > 400) throw fail('单次拉取范围不能超过 400 天');
    return { from, to };
  }
  async function startSync(ctx, month, trigger = 'manual', range = null) {
    validMonth(month);
    const scope = range ? validateSyncRange(range.from, range.to) : null;
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
      return { run: (await client.query(`INSERT INTO app_statistics_runs(user_id,store_id,month,trigger,from_date,to_date) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [ctx.userId, ctx.storeId, month, trigger, scope?.from || null, scope?.to || null])).rows[0], created: true };
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
    const localMin = local.getUTCHours() * 60 + local.getUTCMinutes();
    // 已经过了几个时间点，今天就应该成功几次；不够才补跑
    const dueSlots = SCHEDULE_SLOTS.filter(([h, m]) => localMin >= h * 60 + m).length;
    if (!dueSlots) return;
    scheduling = true;
    try {
      const stores = await query(`SELECT s.id,s.user_id,MIN(m.month) AS month,
        (SELECT count(*) FROM app_statistics_runs r WHERE r.store_id=s.id AND r.status='succeeded'
           AND (r.finished_at AT TIME ZONE 'Asia/Shanghai')::date=$1::date) AS done_today
        FROM app_stores s
        JOIN app_statistics_months m ON m.store_id=s.id AND m.user_id=s.user_id WHERE s.active=TRUE AND s.platform='ozon'
        AND NOT EXISTS (SELECT 1 FROM app_statistics_runs r WHERE r.store_id=s.id AND r.started_at>now()-interval '1 hour' AND r.status IN ('queued','running','failed'))
        GROUP BY s.id,s.user_id`, [shanghaiDate(now)]);
      // 自动同步只补「昨天→今天」的增量：历史日期在 Ozon 侧已固化，全量重拉没有意义
      const todayStr = shanghaiDate(now);
      const yesterdayStr = new Date(Date.parse(`${todayStr}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
      for (const store of stores.rows) {
        if (Number(store.done_today || 0) >= dueSlots) continue;
        if (running.size >= 2) break;
        await startSync({ userId: store.user_id, storeId: store.id }, store.month, 'daily', { from: yesterdayStr, to: todayStr });
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
  function normalizeAdEntry(raw) {
    const date = String(raw?.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fail('广告明细日期格式应为 YYYY-MM-DD');
    const orderNumber = String(raw?.order_number || '').trim();
    if (!/^\d+-\d+(?:-\d+)?$/.test(orderNumber) || orderNumber.length > 64) throw fail(`订单号无效：${orderNumber}`);
    const sku = String(raw?.sku || '').trim();
    if (!/^\d{1,24}$/.test(sku)) throw fail(`SKU 无效：${sku}`);
    const mode = String(raw?.mode || '').toLowerCase();
    if (!['cpo', 'cpc'].includes(mode)) throw fail(`计费模式无效：${raw?.mode}`);
    const cents = Number(raw?.cents);
    if (!Number.isSafeInteger(cents) || Math.abs(cents) > 1e10) throw fail('金额必须是整数分且在合理范围');
    const quantity = Number(raw?.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 100000) throw fail('数量必须是 1~100000 的整数');
    return { date, order_number: orderNumber, sku, mode, cents, quantity, order_id: String(raw?.order_id || '').slice(0, 32) };
  }
  // 逐单广告导入：两种模式合并校验结算明细 type 54，按天合并（重叠部分必须与已存数据一致）
  async function importOrderAdReport(ctx, body) {
    const raw = Array.isArray(body?.entries) ? body.entries : [];
    if (!raw.length) throw fail('没有可导入的明细');
    if (raw.length > 100000) throw fail('单次最多导入 10 万行');
    const force = body?.force === true;
    const entries = raw.map(normalizeAdEntry);
    const byDay = new Map();
    for (const entry of entries) {
      if (!byDay.has(entry.date)) byDay.set(entry.date, []);
      byDay.get(entry.date).push(entry);
    }
    return transaction(ctx, async (client) => {
      // 结算明细里 type 54 的每日合计，作为校验基准
      const dbDaily = new Map((await client.query(`
        WITH x AS (
          SELECT accrued_date AS d, (payload->'non_item_fee'->>'type_id')::int AS tid, (payload->'non_item_fee'->'accrued'->>'amount')::numeric AS amt
          FROM app_statistics_accruals WHERE user_id=$1 AND store_id=$2 AND jsonb_typeof(payload->'non_item_fee')='object'
            AND coalesce(payload->>'source','ozon') <> 'ad_report'
          UNION ALL
          SELECT accrued_date, (fee->>'type_id')::int, (fee->'accrued'->>'amount')::numeric
          FROM app_statistics_accruals, LATERAL jsonb_array_elements(coalesce(payload->'item_fees'->'fees','[]'::jsonb)) p,
               LATERAL jsonb_array_elements(coalesce(p->'fees','[]'::jsonb)) fee
          WHERE user_id=$1 AND store_id=$2 AND coalesce(payload->>'source','ozon') <> 'ad_report')
        SELECT d::text AS d, round(abs(sum(amt)),2) AS total FROM x WHERE tid=54 GROUP BY 1`, [ctx.userId, ctx.storeId])).rows.map((r) => [r.d, Number(r.total)]));
      const checks = [];
      for (const date of [...byDay.keys()].sort()) {
        const csv = Math.round(byDay.get(date).reduce((sum, e) => sum + e.cents, 0)) / 100;
        const db = dbDaily.has(date) ? dbDaily.get(date) : null;
        // 库里那天没有 type 54 记录时按 0 计差额：可能是 Ozon 把广告费记到了相邻的一天
        const diff = db == null ? csv : Math.round((csv - db) * 100) / 100;
        checks.push({ date, csv, db, diff, status: db == null ? 'missing' : Math.abs(diff) < 0.01 ? 'ok' : 'diff' });
      }
      // 识别「结算日顺延」：相邻两天差额互为相反数，说明是同一笔钱晚记了一天，自动平衡掉
      const dateMap = new Map(checks.map((c) => [c.date, c]));
      const adjacent = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
      const pairable = (x) => x && (x.status === 'diff' || x.status === 'missing');
      for (const c of checks) {
        if (!pairable(c)) continue;
        for (const delta of [1, -1]) {
          const other = dateMap.get(adjacent(c.date, delta));
          if (pairable(other) && Math.abs(c.diff + other.diff) < 0.01) {
            c.status = 'shift'; c.shift_with = other.date;
            other.status = 'shift'; other.shift_with = c.date;
            break;
          }
        }
      }
      const shifted = checks.filter((c) => c.status === 'shift');
      // 未配对的「无记录」也算真差异（库里确实缺这部分），不能悄悄放过
      const diffs = checks.filter((c) => c.status === 'diff' || c.status === 'missing');
      const totalDiff = Math.round(diffs.reduce((sum, c) => sum + c.diff, 0) * 100) / 100;
      if (diffs.length && Math.abs(totalDiff) > 0.01 && !force) {
        // 不抛异常，把差异明细带回去，前端用表格展示给用户确认
        return { need_confirm: true, message: `与结算明细的按订单付费合计不一致：${diffs.length} 天有差异，整期差 ${totalDiff.toFixed(2)} ₽`,
          total_diff: totalDiff, checks, shifted_days: shifted.length };
      }
      let inserted = 0, reused = 0, replaced = 0;
      for (const [date, list] of byDay) {
        const existing = (await client.query(`SELECT order_number, sku, mode, cents FROM app_statistics_order_ad_entries
          WHERE user_id=$1 AND store_id=$2 AND ad_date=$3`, [ctx.userId, ctx.storeId, date])).rows;
        const oldMap = new Map(existing.map((r) => [`${r.order_number}|${r.sku}|${r.mode}`, Number(r.cents)]));
        const newMap = new Map(list.map((e) => [`${e.order_number}|${e.sku}|${e.mode}`, e.cents]));
        // 重叠：同一订单+SKU+模式的历史金额必须一致（历史数据不会变）
        for (const [key, cents] of newMap) {
          if (oldMap.has(key) && oldMap.get(key) !== cents) {
            throw fail(`${date} 的「${key.split('|')[0]} / SKU ${key.split('|')[1]}」与已导入数据不一致（原 ${(oldMap.get(key) / 100).toFixed(2)} ₽ / 新 ${(cents / 100).toFixed(2)} ₽）`, 409);
          }
        }
        if (oldMap.size === newMap.size && [...oldMap].every(([key, cents]) => newMap.get(key) === cents)) { reused += 1; continue; }
        await client.query(`DELETE FROM app_statistics_order_ad_entries WHERE user_id=$1 AND store_id=$2 AND ad_date=$3`, [ctx.userId, ctx.storeId, date]);
        await client.query(`INSERT INTO app_statistics_order_ad_entries(user_id,store_id,ad_date,order_number,sku,mode,cents,quantity,ad_order_id)
          SELECT $1,$2,(x->>'date')::date,x->>'order_number',x->>'sku',x->>'mode',(x->>'cents')::bigint,(x->>'quantity')::int,x->>'order_id'
          FROM jsonb_array_elements($3::jsonb) x`, [ctx.userId, ctx.storeId, JSON.stringify(list)]);
        replaced += 1; inserted += list.length;
      }
      const orders = (await client.query('SELECT payload FROM app_statistics_orders WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId])).rows.map((r) => r.payload);
      const { centsByPosting, unmatched, matchedRows } = matchOrderAdRows(entries, orders);
      // 把归集到具体包裹的广告费写成结算明细的一行（source=ad_report，type 54/41），
      // 这样结算明细表能直接按订单号查到广告费，不用跨两张表。
      const adLines = new Map();
      const pushAd = (unit, cents, mode, date) => {
        if (!unit || !date) return;
        const id = `ad:${unit}:${date}:${mode}`;
        const label = mode === 'cpc' ? 41 : 54;
        adLines.set(id, { ...(adLines.get(id) || { id, posting: unit, date, mode, type: label, cents: 0 }), cents: (adLines.get(id)?.cents || 0) + cents });
      };
      // 归集到具体包裹的
      for (const row of matchedRows) pushAd(row.posting_number, row.cents, row.mode, row.date);
      // 匹配不到包裹的（多为主单号对不上或多包裹分不清），按主单号记，保证广告总额不丢
      for (const row of unmatched) pushAd(row.order_number, row.cents, row.mode, row.date);
      const adPayloads = [...adLines.values()].map((line) => ({
        accrual_id: line.id,
        date: line.date,
        unit_number: line.posting,
        total_amount: { amount: (-line.cents / 100).toFixed(2), currency: 'RUB' },
        accrued_category: 'AD',
        source: 'ad_report',
        ad_mode: line.mode,
        non_item_fee: { type_id: line.type, accrued: { amount: (-line.cents / 100).toFixed(2) } },
      }));
      const touchedDays = [...new Set(entries.map((e) => e.date))];
      if (touchedDays.length) {
        await client.query(`DELETE FROM app_statistics_accruals
          WHERE user_id=$1 AND store_id=$2 AND accrued_date=ANY($3::date[]) AND payload->>'source'='ad_report'`,
          [ctx.userId, ctx.storeId, touchedDays]);
      }
      if (adPayloads.length) {
        await client.query(`INSERT INTO app_statistics_accruals(user_id,store_id,accrual_id,accrued_date,payload)
          SELECT $1,$2,x->>'accrual_id',(x->>'date')::date,x FROM jsonb_array_elements($3::jsonb) x
          ON CONFLICT(user_id,store_id,accrual_id) DO UPDATE SET accrued_date=EXCLUDED.accrued_date,payload=EXCLUDED.payload,updated_at=now()`,
          [ctx.userId, ctx.storeId, JSON.stringify(adPayloads)]);
      }
      return { success: true, checks, total_diff: totalDiff, shifted_days: shifted.length, days: byDay.size, days_written: replaced, days_unchanged: reused,
        entries: entries.length, rows_written: inserted,
        ad_lines: adPayloads.length,
        matched_orders: centsByPosting.size, matched_rub: [...centsByPosting.values()].reduce((n, c) => n + c, 0) / 100,
        unmatched_entries: unmatched.length, unmatched_rub: unmatched.reduce((n, r) => n + r.cents, 0) / 100 };
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
      // 明细以「订单表」为基础维度：没有应计流水的订单（未动账的取消单等）也要出现
      const covered = new Set(result.rows.map((r) => r.posting_number));
      const orderOnly = data.orders
        .filter((order) => !covered.has(order.posting_number))
        .map((order) => ({
          posting_number: order.posting_number,
          status: order.substatus === 'posting_in_pickup_point' ? '待买家取件' : (STATUS_NAMES[order.status] || order.status || '资料待核对'),
          raw_status: order.status || '',
          ordered_at: orderTimestamp(order),
          settled_date: null,
          order_settled_date: order.settled_date || null,
          order_type: order.schema === 'fbo' ? 'WHD订单' : '正常销售订单',
          cancel_reason: cancellationReason(order),
          purchase_cny: null, label_cny: null, income_rub: null, ozon_fees_rub: null,
          profit_cny: null, margin_pct: null, receipt_rub: null, receipt_cny: null,
          advertising_rub: null, allocated_ad_rub: null, cost_in_month: false,
          low_income: false, pending_positive: false, pending_negative: false,
          metadata_missing: false, no_accrual: true,
        }));
      // 明细默认从 2026-07 起展示，更早下单的历史订单不再列出
      const rows = filteredRows(
        [...result.rows, ...orderOnly].filter((row) => {
          const placed = String(row.ordered_at || "").slice(0, 10);
          return placed && placed >= SYNC_MIN_DATE;
        }), params);
      const size = Math.min(500, Math.max(1, parseInt(params.page_size, 10) || 100));
      const page = Math.max(1, parseInt(params.page, 10) || 1);
      res.json({ success: true, rows: rows.slice((page - 1) * size, page * size), total: rows.length, summary: result.summary, run: await latestRun(ctx),
        advertising: { ...publicAdvertising(data.adConfig), ...result.advertising }, filter_catalog: REPORT_FIELDS,
        schedule: { time: '02:00, 09:30', timezone: 'Asia/Shanghai', frequency: 'daily' } });
    };
    route('get', '/report', reportRoute);
    route('post', '/report', reportRoute);
    route('get', '/months', async (req, res, ctx) => {
      // 新口径：按订单的结算日期归月，起点 2026-10，末尾固定「未结算」
      const data = await loadData(ctx);
      res.json({ success: true, rows: settlementSummary(data), run: await latestRun(ctx) });
    });
    route('get', '/exceptions', async (req, res, ctx) => {
      const month = validMonth(String(req.query.month || ''));
      const result = report(await loadData(ctx), month);
      const entries = settlementExceptions(result, String(req.query.group || 'total'), String(req.query.kind || ''));
      const size = 100, page = Math.max(1, parseInt(req.query.page, 10) || 1);
      res.json({ rows: entries.slice((page - 1) * size, page * size), total: entries.length, page_size: size,
        coverage_complete: result.summary.coverage.complete, exchange_rate: result.summary.exchange_rate });
    });
    route('post', '/sync', async (req, res, ctx) => {
      const range = req.body?.from && req.body?.to ? { from: String(req.body.from), to: String(req.body.to) } : null;
      const month = String(req.body?.month || (range ? range.from.slice(0, 7) : ''));
      res.status(202).json({ success: true, run: await startSync(ctx, month, 'manual', range) });
    });
    // 逐单广告对比：按广告日期，拿结算里的 type 54 与导入的 CPO+CPC 逐日比对
    route('get', '/ad-import-log', async (req, res, ctx) => {
      const today = shanghaiDate();
      const rows = (await query(`
        WITH days AS (SELECT generate_series($3::date, $4::date, '1 day')::date AS d),
        dbt AS (
          SELECT accrued_date AS d, abs(sum(amt)) AS amt FROM (
            SELECT accrued_date, (payload->'non_item_fee'->>'type_id')::int AS tid,
                   (payload->'non_item_fee'->'accrued'->>'amount')::numeric AS amt
            FROM app_statistics_accruals
            WHERE user_id=$1 AND store_id=$2 AND jsonb_typeof(payload->'non_item_fee')='object'
              AND coalesce(payload->>'source','ozon') <> 'ad_report'
            UNION ALL
            SELECT accrued_date, (fee->>'type_id')::int, (fee->'accrued'->>'amount')::numeric
            FROM app_statistics_accruals, LATERAL jsonb_array_elements(coalesce(payload->'item_fees'->'fees','[]'::jsonb)) p,
                 LATERAL jsonb_array_elements(coalesce(p->'fees','[]'::jsonb)) fee
            WHERE user_id=$1 AND store_id=$2 AND coalesce(payload->>'source','ozon') <> 'ad_report'
          ) x WHERE tid=54 GROUP BY 1
        ),
        csvt AS (
          SELECT ad_date AS d,
                 coalesce(sum(cents) FILTER (WHERE mode='cpo'),0)/100.0 AS cpo,
                 coalesce(sum(cents) FILTER (WHERE mode='cpc'),0)/100.0 AS cpc,
                 count(*)::int AS entries
          FROM app_statistics_order_ad_entries WHERE user_id=$1 AND store_id=$2 GROUP BY 1)
        SELECT to_char(days.d,'YYYY-MM-DD') AS date,
               round(coalesce(dbt.amt,0),2) AS db54,
               round(coalesce(csvt.cpo,0),2) AS cpo,
               round(coalesce(csvt.cpc,0),2) AS cpc,
               coalesce(csvt.entries,0) AS entries
        FROM days LEFT JOIN dbt ON dbt.d = days.d LEFT JOIN csvt ON csvt.d = days.d
        ORDER BY days.d DESC`, [ctx.userId, ctx.storeId, SYNC_MIN_DATE, today])).rows.map((r) => {
        const csv = Math.round((Number(r.cpo) + Number(r.cpc)) * 100) / 100;
        const db = Math.round(Number(r.db54) * 100) / 100;
        return { ...r, csv, diff: Math.round((csv - db) * 100) / 100,
          status: Number(r.entries) === 0 ? (db > 0 ? 'missing' : 'none') : db === 0 ? 'shiftable' : Math.abs(csv - db) < 0.01 ? 'ok' : 'diff' };
      });
      // 顺延配对：相邻两天差额互为相反数 → 都判为顺延（账单日错开一天）
      const byDate = new Map(rows.map((r) => [r.date, r]));
      const adjacent = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
      const pairable = (x) => x && (x.status === 'diff' || x.status === 'shiftable');
      for (const r of rows) {
        if (!pairable(r)) continue;
        for (const delta of [1, -1]) {
          const o = byDate.get(adjacent(r.date, delta));
          if (pairable(o) && Math.abs(r.diff + o.diff) < 0.01) {
            r.status = 'shift'; r.shift_with = o.date;
            o.status = 'shift'; o.shift_with = r.date;
            break;
          }
        }
      }
      for (const r of rows) if (r.status === 'shiftable') r.status = 'diff';
      const sum = (k) => Math.round(rows.reduce((n, r) => n + Number(r[k] || 0), 0) * 100) / 100;
      const realDiff = rows.filter((r) => r.status === 'diff' || r.status === 'missing');
      res.json({ success: true, rows, min_date: SYNC_MIN_DATE, today,
        summary: { days: rows.filter((r) => Number(r.entries) > 0).length,
          entries: rows.reduce((n, r) => n + Number(r.entries || 0), 0),
          cpo: sum('cpo'), cpc: sum('cpc'), db54: sum('db54'),
          diff: Math.round(realDiff.reduce((n, r) => n + r.diff, 0) * 100) / 100,
          shifted: rows.filter((r) => r.status === 'shift').length,
          missing: rows.filter((r) => r.status === 'missing').length } });
    });
    // 同步记录：未同步日期 + 历史同步任务明细
    route('get', '/sync-log', async (req, res, ctx) => {
      const today = shanghaiDate();
      const missing = (await query(`WITH d AS (SELECT generate_series($3::date, $4::date, '1 day')::date AS dt)
        SELECT to_char(dt,'YYYY-MM-DD') AS date FROM d
        WHERE NOT EXISTS (SELECT 1 FROM app_statistics_days x WHERE x.user_id=$1 AND x.store_id=$2 AND x.accrued_date=d.dt)
        ORDER BY dt`, [ctx.userId, ctx.storeId, SYNC_MIN_DATE, today])).rows.map((r) => r.date);
      const runs = (await query(`SELECT r.id, r.status, r.trigger, r.days_done, r.days_total, r.message, r.error,
          to_char(r.started_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') AS started_at,
          to_char(r.finished_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') AS finished_at,
          to_char(coalesce(r.from_date, $3::date),'YYYY-MM-DD') AS from_date,
          to_char(coalesce(r.to_date, $4::date),'YYYY-MM-DD') AS to_date,
          r.records
        FROM app_statistics_runs r WHERE r.user_id=$1 AND r.store_id=$2
        ORDER BY r.started_at DESC LIMIT 50`, [ctx.userId, ctx.storeId, SYNC_MIN_DATE, today])).rows;
      res.json({ success: true, min_date: SYNC_MIN_DATE, today, missing_dates: missing, missing_count: missing.length, runs });
    });
    // 结算明细：把每条应计凭证按费用项目展开，再按「订单号 + 应计日 + 费用项目」归并成一行
    // 主订单号一单多包裹时不拆，整笔挂在主单上
    route('get', '/accruals', async (req, res, ctx) => {
      // 不传日期时按全量范围查（方便只输订单号直接查）
      const { from, to } = validateSyncRange(String(req.query.from || SYNC_MIN_DATE), String(req.query.to || shanghaiDate()));
      // 导出走大页（2000/页），正常浏览仍限 500
      const maxSize = String(req.query.export) === '1' ? 2000 : 500;
      const size = Math.min(maxSize, Math.max(1, parseInt(req.query.page_size, 10) || 100));
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const posting = String(req.query.posting || '').trim();
      const rawType = String(req.query.type_id ?? '').trim();
      const typeId = rawType === '' ? null : Number.parseInt(rawType, 10);
      if (typeId !== null && !Number.isInteger(typeId)) throw fail('费用项目无效');
      const category = String(req.query.category || '').trim() || null;
      const rawSource = String(req.query.source || '').trim();
      const source = ['ozon', 'ad_report'].includes(rawSource) ? rawSource : null;
      const params = [ctx.userId, ctx.storeId, from, to, posting ? `%${posting}%` : null, typeId, category, source, size, (page - 1) * size];
      const sql = `
WITH base AS (
  SELECT a.payload, a.accrued_date, a.accrual_id, coalesce(a.payload->>'source','ozon') AS source
  FROM app_statistics_accruals a
  WHERE a.user_id=$1 AND a.store_id=$2 AND a.accrued_date BETWEEN $3 AND $4
), per_accrual AS (
  -- 每条凭证拆出：买家实付(sale_amount) / 佣金(commission) / 内嵌配送费(delivery)
  -- total_amount = sale_amount + commission + delivery，即扣完后的卖家实收
  SELECT b.source, b.payload->>'unit_number' AS unit_number,
         (b.payload->'total_amount'->>'amount')::numeric AS amt,
         coalesce((SELECT sum((p->'commission'->'sale_amount'->>'amount')::numeric)
                   FROM jsonb_array_elements(coalesce(b.payload->'posting'->'products','[]'::jsonb)) p), 0) AS sale_amount,
         coalesce((SELECT sum((p->'commission'->'commission'->>'amount')::numeric)
                   FROM jsonb_array_elements(coalesce(b.payload->'posting'->'products','[]'::jsonb)) p), 0) AS commission,
         coalesce((SELECT sum((p->'delivery'->'total_accrued'->>'amount')::numeric)
                   FROM jsonb_array_elements(coalesce(b.payload->'posting'->'products','[]'::jsonb)) p), 0) AS delivery
  FROM base b
), shaped AS (
  -- 先判断这条凭证用哪种方式拆：非商品费 / 商品费明细 / 整笔总额
  SELECT b.payload, b.accrual_id, b.accrued_date, b.source,
         b.payload->>'unit_number' AS unit_number,
         b.payload->>'accrued_category' AS category,
         jsonb_typeof(b.payload->'non_item_fee') = 'object' AS has_non_item,
         (b.payload->'total_amount'->>'amount')::numeric AS total_amount,
         coalesce((
           SELECT sum((fee->'accrued'->>'amount')::numeric)
           FROM jsonb_array_elements(coalesce(b.payload->'item_fees'->'fees','[]'::jsonb)) p,
                jsonb_array_elements(coalesce(p->'fees','[]'::jsonb)) fee
         ), 0) AS fee_sum
  FROM base b
), expanded AS (
  SELECT accrual_id, accrued_date, unit_number, category, source,
         (payload->'non_item_fee'->>'type_id')::int AS type_id,
         (payload->'non_item_fee'->'accrued'->>'amount')::numeric AS amount
  FROM shaped WHERE has_non_item
  UNION ALL
  SELECT s.accrual_id, s.accrued_date, s.unit_number, s.category, s.source,
         (fee->>'type_id')::int, (fee->'accrued'->>'amount')::numeric
  FROM shaped s
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(s.payload->'item_fees'->'fees','[]'::jsonb)) p
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(p->'fees','[]'::jsonb)) fee
  WHERE NOT s.has_non_item AND s.fee_sum <> 0 AND s.fee_sum = s.total_amount
    AND (fee->'accrued'->>'amount') IS NOT NULL
  UNION ALL
  -- 明细拆不准（或压根没有明细）就整笔按总额记一行，保证金額守恒
  SELECT s.accrual_id, s.accrued_date, s.unit_number, s.category, s.source, NULL, s.total_amount
  FROM shaped s
  WHERE NOT s.has_non_item AND s.total_amount IS NOT NULL
    AND (s.fee_sum = 0 OR s.fee_sum <> s.total_amount)
), grouped AS (
  SELECT unit_number, accrued_date, type_id, max(category) AS category, max(source) AS source,
         count(*)::int AS entries, sum(amount) AS amount
  FROM expanded GROUP BY 1,2,3
), summary AS (
  -- 汇总卡片跟随列表筛选（单号 / 类型 / 类别），不跟「来源」——逐单广告是归属明细，不参与收支
  -- 收款合计 = 正数凭证实收；买家实付/佣金走 per_accrual
  -- 广告按结算口径：type 54 商品推广 + 41 点击广告 + 3 品牌推广
  SELECT
    (SELECT coalesce(sum(amount),0) FROM grouped
      WHERE source <> 'ad_report' AND amount > 0 AND coalesce(type_id,0) NOT IN (3,41,54)
        AND ($5::text IS NULL OR unit_number ILIKE $5)
        AND ($6::int IS NULL OR type_id = $6)
        AND ($7::text IS NULL OR category = $7)) AS income_total,
    (SELECT coalesce(sum(amount),0) FROM grouped
      WHERE source <> 'ad_report' AND coalesce(type_id,0) NOT IN (3,41,54)
        AND ($5::text IS NULL OR unit_number ILIKE $5)
        AND ($6::int IS NULL OR type_id = $6)
        AND ($7::text IS NULL OR category = $7)) AS net_total,
    (SELECT coalesce(sum(sale_amount),0) FROM per_accrual
      WHERE source <> 'ad_report' AND ($5::text IS NULL OR unit_number ILIKE $5)) AS sale_total,
    (SELECT coalesce(sum(commission),0) FROM per_accrual
      WHERE source <> 'ad_report' AND ($5::text IS NULL OR unit_number ILIKE $5)) AS commission_total,
    -- 内嵌在正数销售凭证里的配送费（type 29/32）
    (SELECT coalesce(sum(delivery),0) FROM per_accrual
      WHERE source <> 'ad_report' AND amt > 0 AND ($5::text IS NULL OR unit_number ILIKE $5)) AS delivery_total,
    -- 负数凭证（退货/冲正）的销售额与佣金
    (SELECT coalesce(sum(sale_amount),0) FROM per_accrual
      WHERE source <> 'ad_report' AND amt <= 0 AND ($5::text IS NULL OR unit_number ILIKE $5)) AS return_sale,
    (SELECT coalesce(sum(commission),0) FROM per_accrual
      WHERE source <> 'ad_report' AND amt <= 0 AND ($5::text IS NULL OR unit_number ILIKE $5)) AS return_commission,
    -- 收单手续费退回：type 1 的正数行（拆分前口径）
    (SELECT coalesce(sum(amount),0) FROM expanded
      WHERE source <> 'ad_report' AND type_id = 1 AND amount > 0
        AND ($5::text IS NULL OR unit_number ILIKE $5)) AS fee_refund,
    -- 拆分前的正数行合计，与归并后的差额就是「同组正负相抵」
    (SELECT coalesce(sum(amount),0) FROM expanded
      WHERE source <> 'ad_report' AND amount > 0 AND coalesce(type_id,0) NOT IN (3,41,54)
        AND ($5::text IS NULL OR unit_number ILIKE $5)
        AND ($6::int IS NULL OR type_id = $6)
        AND ($7::text IS NULL OR category = $7)) AS income_rows_total,
    (SELECT coalesce(sum(amount),0) FROM grouped
      WHERE source = 'ozon' AND type_id IN (3,41,54)
        AND ($5::text IS NULL OR unit_number ILIKE $5)) AS ad_total_ozon,
    (SELECT coalesce(sum(amount),0) FROM grouped
      WHERE source = 'ozon' AND type_id = 54
        AND ($5::text IS NULL OR unit_number ILIKE $5)) AS ad_shop,
    (SELECT coalesce(sum(amount),0) FROM grouped
      WHERE source = 'ozon' AND type_id = 41
        AND ($5::text IS NULL OR unit_number ILIKE $5)) AS ad_click,
    (SELECT coalesce(sum(amount),0) FROM grouped
      WHERE source = 'ozon' AND type_id = 3
        AND ($5::text IS NULL OR unit_number ILIKE $5)) AS ad_brand,
    (SELECT coalesce(sum(amount),0) FROM grouped
      WHERE source = 'ad_report' AND ($5::text IS NULL OR unit_number ILIKE $5)) AS ad_attributed,
    (SELECT coalesce(sum(amount),0) FROM grouped
      WHERE source = 'ad_report' AND type_id = 54
        AND ($5::text IS NULL OR unit_number ILIKE $5)) AS ad_cpo,
    (SELECT coalesce(sum(amount),0) FROM grouped
      WHERE source = 'ad_report' AND type_id = 41
        AND ($5::text IS NULL OR unit_number ILIKE $5)) AS ad_cpc
)
SELECT m.unit_number, to_char(m.accrued_date, 'YYYY-MM-DD') AS accrued_date, m.type_id, m.category, m.source, m.entries, m.amount,
       CASE WHEN m.source = 'ad_report' THEN '广告明细'
            WHEN m.unit_number ~ '^[0-9]+-[0-9]+-[0-9]+$' THEN '完整订单号'
            WHEN m.unit_number ~ '^[0-9]+-[0-9]+$' THEN '主订单号'
            WHEN m.unit_number ~ '^[0-9]{8}$' THEN '广告活动'
            WHEN coalesce(m.unit_number,'')='' THEN '店铺级'
            ELSE '其他' END AS unit_type,
       count(*) OVER() AS total_rows,
       s.income_total, s.net_total, s.sale_total, s.commission_total,
       s.delivery_total, s.return_sale, s.return_commission, s.fee_refund, s.income_rows_total,
       s.ad_total_ozon, s.ad_shop, s.ad_click, s.ad_brand,
       s.ad_attributed, s.ad_cpo, s.ad_cpc
FROM grouped m CROSS JOIN summary s
WHERE ($5::text IS NULL OR m.unit_number ILIKE $5)
  AND ($6::int IS NULL OR m.type_id = $6)
  AND ($7::text IS NULL OR m.category = $7)
  AND ($8::text IS NULL OR m.source = $8)
ORDER BY m.accrued_date DESC, m.unit_number DESC, m.type_id DESC NULLS LAST
LIMIT $9 OFFSET $10`;
      const result = await query(sql, params);
      const first = result.rows[0] || {};
      const num = (v) => Number(v || 0);
      const income = num(first.income_total), net = num(first.net_total);
      // 扣费 = 净额 − 实收（负数），实收口径不含佣金，佣金在悬浮明细里单独看
      const expense = net - income;
      const saleTotal = num(first.sale_total), commission = num(first.commission_total);
      const adAttributed = num(first.ad_attributed);
      // 广告投入按实际发生（投放口径）：有逐单报表时商品推广用它，否则用结算的 54；
      // 不再为跨月顺延做扣减，结算口径单独作为参考值返回
      const adShopSettle = num(first.ad_shop);
      const adShopImport = num(first.ad_cpo) + num(first.ad_cpc);
      const hasImport = Math.abs(adShopImport) > 0.01;
      const adShop = hasImport ? adShopImport : adShopSettle;
      const adClick = num(first.ad_click), adBrand = num(first.ad_brand);
      const adSettle = num(first.ad_total_ozon) + (posting ? adAttributed : 0);
      const adTotal = hasImport ? (adShop + adClick + adBrand) : adSettle;
      // 实收 = 买家实付 + 佣金 + 内嵌配送费 + 手续费退回 − 同组相抵 + 退货销售额 − 退货佣金
      const deliveryTotal = num(first.delivery_total), feeRefund = num(first.fee_refund);
      const returnSale = num(first.return_sale), returnCommission = num(first.return_commission);
      const netting = num(first.income_rows_total) - income;
      res.json({
        success: true, rows: result.rows, total: Number(first.total_rows || 0), page, page_size: size,
        summary: {
          income_rub: income, expense_rub: expense, net_rub: net,
          sale_total_rub: saleTotal, commission_rub: commission,
          income_delivery_rub: deliveryTotal,
          income_refund_rub: feeRefund,
          income_netting_rub: netting,
          income_return_sale_rub: -returnSale,
          income_return_comm_rub: -returnCommission,
          // 差额合计（实收 − 买家实付 − 佣金），用于自检
          income_adjust_rub: income - (saleTotal + commission),
          ad_rub: adTotal, ad_shop_rub: adShop, ad_click_rub: adClick, ad_brand_rub: adBrand,
          ad_attributed_rub: adAttributed, ad_cpo_rub: num(first.ad_cpo), ad_cpc_rub: num(first.ad_cpc),
          // 结算口径（含跨月顺延）仅作参考，不参与扣减
          ad_settlement_rub: adSettle,
          // 订单收入 = 净额（收入−代扣，不含广告）+ 广告（广告以负数存放）= Ozon 报表合计
          order_income_rub: net + adTotal,
        },
        range: { from, to }, min_date: SYNC_MIN_DATE, run: await latestRun(ctx),
      });
    });
    route('patch', '/costs', async (req, res, ctx) => res.json(await saveCosts(ctx, req.body)));
    route('patch', '/month', async (req, res, ctx) => res.json(await saveMonth(ctx, req.body)));
    route('get', '/advertising/config', async (req, res, ctx) => res.json(publicAdvertising((await loadData(ctx)).adConfig)));
    route('patch', '/advertising/config', async (req, res, ctx) => res.json(await saveAdvertising(ctx, req.body)));
    route('get', '/advertising/days', async (req, res, ctx) => {
      const days = (await loadData(ctx)).adDays.filter((d) => d.business_timezone === DEFAULT_AD_TIMEZONE);
      res.json({ days, revision: adRevision(days), business_timezone: DEFAULT_AD_TIMEZONE });
    });
    route('post', '/advertising/import', async (req, res, ctx) => res.json(await importAdvertising(ctx, req.body)));
    route('post', '/advertising/order-report', async (req, res, ctx) => {
      const result = await importOrderAdReport(ctx, req.body);
      if (result?.need_confirm) return res.status(409).json({ success: false, ...result });
      res.json(result);
    });
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
