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
-- 41 点击广告按日平分到订单的结果：导入/同步后重算落库，同一天重复导入会整日覆盖
CREATE TABLE IF NOT EXISTS app_statistics_click_allocations (
  user_id UUID NOT NULL REFERENCES app_users(id), store_id UUID NOT NULL REFERENCES app_stores(id),
  ad_date DATE NOT NULL, order_number TEXT NOT NULL, cents BIGINT NOT NULL, order_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, store_id, ad_date, order_number)
);
CREATE INDEX IF NOT EXISTS idx_click_allocations_day ON app_statistics_click_allocations(user_id, store_id, ad_date);
-- 订单表增量同步记录：每 30 分钟自动跑一次，也可手动触发
CREATE TABLE IF NOT EXISTS app_statistics_order_syncs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id), store_id UUID NOT NULL REFERENCES app_stores(id),
  trigger TEXT NOT NULL DEFAULT 'auto', status TEXT NOT NULL DEFAULT 'running',
  fetched INTEGER NOT NULL DEFAULT 0, changed INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '', started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_order_syncs_store ON app_statistics_order_syncs(user_id,store_id,started_at DESC);
-- Ozon 卖家后台会话（网页版 cookie）：只用于补「取消日期」这类 Seller API 不提供的字段
CREATE TABLE IF NOT EXISTS app_statistics_web_sessions (
  user_id UUID NOT NULL REFERENCES app_users(id), store_id UUID NOT NULL REFERENCES app_stores(id),
  cookie_cipher TEXT NOT NULL, company_id TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,store_id)
);
-- 卖家后台域名：中国站店铺是 seller.ozonru.cn
ALTER TABLE app_statistics_web_sessions ADD COLUMN IF NOT EXISTS host TEXT NOT NULL DEFAULT 'seller.ozon.ru';
`;

export function createStatisticsAnalysis({ db, assertStoreAccess, callOzon, defaultRate, credentialSecret = process.env.AUTH_SECRET,
  performanceFactory = createPerformanceClient, notify = async () => {}, logger = console }) {
  const running = new Map();
  const reportCache = new Map();
  const revisions = new Map();
  let timer = null, scheduling = false, orderTimer = null;
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
  // 单个订单的全期流水：不按月份限制，把这个订单（含主单号归属、SKU 拆分）的所有应计凭证都摊出来
  function orderLedgerRows(data, posting) {
    const parent = parentOf(posting);
    const siblings = data.orders.filter((order) => parentOf(order.posting_number) === parent);
    const target = data.orders.find((order) => order.posting_number === posting);
    const skus = new Set((target?.products || []).map((product) => String(product.sku)));
    const rub = (cents) => Number((cents / 100).toFixed(2));
    const rows = [], pending = [];
    for (const entry of data.accruals) {
      const unit = String(entry.unit_number || '');
      let cents = moneyCents(entry.total_amount?.amount ?? 0), method = null;
      if (unit === posting) method = '完整订单号';
      else if (unit === parent) {
        if (siblings.length === 1) method = '唯一主订单号';
        else {
          const parts = (entry.item_fees?.fees || []).filter((part) => skus.has(String(part.sku)));
          const sum = parts.reduce((n, part) => n + (part.fees || []).reduce((m, fee) => m + moneyCents(fee.accrued?.amount ?? 0), 0), 0);
          if (parts.length && sum) { cents = sum; method = 'SKU 唯一匹配'; }
          else if (entry.item_fees?.fees?.length) {
            pending.push({ date: entry.date, unit_number: unit, accrual_id: entry.accrual_id, amount_rub: rub(cents), method: '主单多包裹待分摊' });
            continue;
          } else { pending.push({ date: entry.date, unit_number: unit, accrual_id: entry.accrual_id, amount_rub: rub(cents), method: '主单流水' }); continue; }
        }
      } else continue;
      const types = entry.non_item_fee ? [Number(entry.non_item_fee.type_id)]
        : [...new Set((entry.item_fees?.fees || []).flatMap((part) => (part.fees || []).map((fee) => Number(fee.type_id))))];
      rows.push({ posting_number: posting, accrual_id: entry.accrual_id, date: entry.date, amount_rub: rub(cents), method, types });
    }
    rows.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.accrual_id).localeCompare(String(b.accrual_id)));
    pending.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return { rows, pending };
  }
  // 订单维度聚合：把全部应计凭证按订单号归集（完整订单号 / 唯一主单号 / SKU 唯一匹配），
  // 与月份无关。收入=正数非广告凭证；代扣=负数非广告凭证（含品牌推广等实际扣款）；
  // 推广-订单=按订单付费(ad_report 54)；推广-点击=按点击付费(ad_report 41)；分摊来自 41 按日均摊表。
  function orderAggregates(data) {
    const metadata = new Map(data.orders.map((order) => [order.posting_number, order]));
    const siblings = new Map();
    for (const order of data.orders) {
      const parent = parentOf(order.posting_number);
      if (!siblings.has(parent)) siblings.set(parent, []);
      siblings.get(parent).push(order.posting_number);
    }
    const agg = new Map();
    // 只挂主单号、又拆不到具体包裹的流水（多为收单业务费），单独收集起来归到「其他状态订单」
    const loose = new Map();
    const slot = (posting) => {
      if (!agg.has(posting)) agg.set(posting, { income: 0, fees: 0, cpo: 0, cpc: 0, alloc: 0, last_date: null });
      return agg.get(posting);
    };
    for (const entry of data.accruals) {
      const unit = String(entry.unit_number || '');
      const cents = moneyCents(entry.total_amount?.amount ?? 0);
      const source = entry.source || 'ozon';
      const typeId = entry.non_item_fee?.type_id == null ? null : Number(entry.non_item_fee.type_id);
      const parts = entry.item_fees?.fees || [];
      const targets = [];
      if (metadata.has(unit)) targets.push({ posting: unit, cents });
      else {
        const children = siblings.get(unit) || [];
        if (children.length === 1) targets.push({ posting: children[0], cents });
        else if (parts.length) {
          for (const part of parts) {
            const amount = (part.fees || []).reduce((n, fee) => n + moneyCents(fee.accrued?.amount ?? 0), 0);
            const hits = children.filter((posting) => (metadata.get(posting)?.products || []).some((product) => String(product.sku) === String(part.sku)));
            if (hits.length === 1) targets.push({ posting: hits[0], cents: amount });
          }
        }
      }
      if (!targets.length) {
        const centsLoose = moneyCents(entry.total_amount?.amount ?? 0);
        const month = String(entry.date || '').slice(0, 7);
        if (centsLoose && month && /^\d+-\d+$/.test(unit)) {
          const item = loose.get(month) || { income: 0, fees: 0, flows: 0 };
          if (centsLoose > 0) item.income += centsLoose; else item.fees += -centsLoose;
          item.flows += 1;
          loose.set(month, item);
        }
      }
      for (const target of targets) {
        const row = slot(target.posting);
        if (!row.last_date || String(entry.date) > row.last_date) row.last_date = String(entry.date);
        if (source === 'ad_report' && typeId === 54) row.cpo += Math.abs(target.cents);
        else if (source === 'ad_report' && typeId === 41) row.cpc += Math.abs(target.cents);
        else if (target.cents >= 0) row.income += target.cents;
        else row.fees += target.cents;
      }
    }
    for (const row of data.clickAllocs || []) {
      const target = agg.get(row.order_number);
      if (target) target.alloc += Number(row.cents) || 0;
    }
    return { rows: agg, loose };
  }
  // 订单明细行：一行一个订单，与订单表 1:1；没有应计流水的订单也保留（金额留空，等结算）
  function buildOrderRows(data, rate) {
    const { rows: agg, loose } = orderAggregates(data);
    const costMap = new Map((data.costs || []).map((cost) => [cost.posting_number, cost]));
    const list = data.orders
      // 明细从 2026-07-01 起展示，更早下单的历史订单不再列出
      .filter((order) => String(businessDate(orderTimestamp(order), 'Asia/Shanghai') || '') >= SYNC_MIN_DATE)
      .map((order) => {
      const a = agg.get(order.posting_number);
      const income = a ? a.income / 100 : null;
      const fees = a ? a.fees / 100 : null;
      const cpo = a ? a.cpo / 100 : null;
      const cpc = a ? a.cpc / 100 : null;
      const alloc = a ? a.alloc / 100 : null;
      // 实收卢布 = 销售 + 代扣（负） − 推广订单 − 推广点击 − 点击分摊
      const receipt = a ? rounded(income + fees - cpo - cpc - alloc) : null;
      const receiptCny = receipt != null && rate ? rounded(receipt * rate) : null;
      // WHD（海外仓）由 Ozon 仓发货，不存在采购和贴单费用，历史上误录的成本一律不算
      const cost = order.schema === 'fbo' ? null : costMap.get(order.posting_number);
      const purchase = cost?.purchase_cny == null ? null : Number(cost.purchase_cny);
      // 贴单费按实际录入值展示，没录就留空（不再默认 1.5）；算毛利时未录按 0 计
      const label = cost?.label_cny == null ? null : Number(cost.label_cny);
      const profit = receiptCny != null && purchase != null ? rounded(receiptCny - purchase - (label ?? 0)) : null;
      return {
        posting_number: order.posting_number,
        status: order.substatus === 'posting_in_pickup_point' ? '待买家取件' : (STATUS_NAMES[order.status] || order.status || '资料待核对'),
        raw_status: order.status || '',
        ordered_at: orderTimestamp(order),
        settled_date: a?.last_date || null,
        order_settled_date: order.settled_date || null,
        accrual_date: a?.last_date || null,
        order_type: order.schema === 'fbo' ? 'WHD订单' : '正常销售订单',
        cancel_reason: cancellationReason(order),
        income_rub: income, ozon_fees_rub: fees,
        advertising_cpo_rub: cpo, advertising_cpc_rub: cpc, allocated_ad_rub: alloc,
        advertising_rub: a ? rounded(cpo + cpc + alloc) : null,
        receipt_rub: receipt, receipt_cny: receiptCny,
        purchase_cny: purchase, label_cny: label, profit_cny: profit,
        margin_pct: profit != null && receiptCny ? rounded(profit / receiptCny * 100) : null,
        platform_net_rub: a ? rounded(income + fees) : null,
        low_income: !!a && income < 100,
        no_accrual: !a, metadata_missing: false, pending_positive: false, pending_negative: false,
        cost_in_month: true, allocation_date: null, allocation_order_count: null,
        advertising_state: a ? 'confirmed' : 'not_synced',
      };
    });
    // 主单级、拆不到包裹的流水单独带出去，供月度汇总的「其他状态订单」使用
    list.loose = loose;
    return list;
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
    const clickAllocs = await query('SELECT ad_date::text AS ad_date, order_number, cents, order_count FROM app_statistics_click_allocations WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId]);
    const rate = await query(`SELECT rate FROM app_exchange_rates WHERE base_currency='RUB' AND quote_currency='CNY' ORDER BY effective_at DESC LIMIT 1`);
    const data = { accruals: raw.rows.map((r) => r.payload), orders: meta.rows.map((r) => ({ ...r.payload, settled_date: r.settled_date || null })), costs: costs.rows,
      months: months.rows, days: days.rows, rate: rate.rows[0] ? Number(rate.rows[0].rate) : Number(defaultRate),
      adConfig: adConfig.rows[0] || null, adDays: ads.rows, orderDays: orderDays.rows,
      clickAllocs: clickAllocs.rows.map((r) => ({ ad_date: r.ad_date, order_number: r.order_number, cents: Number(r.cents), order_count: Number(r.order_count) })),
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
      adDays: data.adDays, orderDays: data.orderDays, orderAdEntries: data.orderAdEntries, clickAllocs: data.clickAllocs,
      timezone: data.adConfig?.business_timezone || DEFAULT_AD_TIMEZONE, configured: !!data.adConfig });
  }
  // 月度汇总（新口径）：以订单表的结算日期归月，整单归月；未结算单独一行
  // 起点 2026-10，最后一条固定是「未结算」
  const SUMMARY_START = '2026-10';
  const SUMMARY_GROUPS = [['delivered', '正常签收订单'], ['cancelled', '取消订单'], ['whd', 'WHD订单'], ['other', '其他状态订单（主单级费用）']];
  function settlementBucket(order) {
    if (order.schema === 'fbo') return 'whd';
    const status = String(order.status || '');
    if (status === 'delivered') return 'delivered';
    if (status.startsWith('cancelled') || status === 'returned') return 'cancelled';
    return 'other';
  }
  // 月度汇总：按结算日期归月，整单归月；每组只做求和
  //   销售 = 结算明细里该单的销售收入；代扣 = 除广告外的扣费；推广费用 = 挂在该单上的全部广告
  //   实收卢布 = 销售 + 代扣 − 推广；实收¥ = 实收₽ × 汇率；毛利 = 实收¥ − 采购 − 贴单
  function settlementSummary(data) {
    const rate = data.rate;
    const rows = buildOrderRows(data, rate);
    const empty = () => ({ orders: 0, flows: 0, pending_orders: 0, income: 0, fees: 0, ad: 0, receipt: 0, receiptCny: 0, purchase: 0, label: 0, missing_purchase: 0, missing_label: 0 });
    const buckets = new Map();
    const bucket = (key) => { if (!buckets.has(key)) buckets.set(key, empty()); return buckets.get(key); };
    for (const row of rows) {
      const month = row.order_settled_date ? String(row.order_settled_date).slice(0, 7) : 'unsettled';
      const raw = String(row.raw_status || '');
      const group = row.order_type === 'WHD订单' ? 'whd'
        : (raw.startsWith('cancelled') || raw === 'returned') ? 'cancelled'
        : raw === 'delivered' ? 'delivered' : 'other';
      // 未结算行里那些还没走完流程的单（在途/待发运等）只计入总量，不硬塞进「其他状态订单」组
      const pendingOnly = month === 'unsettled' && group === 'other';
      for (const key of pendingOnly ? [month] : [month, `${month}|${group}`]) {
        const b = bucket(key);
        b.orders += 1;
        if (pendingOnly) b.pending_orders += 1;
        b.income += moneyCents(row.income_rub ?? 0);
        b.fees += moneyCents(row.ozon_fees_rub ?? 0);
        b.ad += moneyCents(row.advertising_cpo_rub ?? 0) + moneyCents(row.advertising_cpc_rub ?? 0) + moneyCents(row.allocated_ad_rub ?? 0);
        b.receipt += moneyCents(row.receipt_rub ?? 0);
        b.receiptCny += moneyCents(row.receipt_cny ?? 0);
        b.purchase += moneyCents(row.purchase_cny ?? 0);
        b.label += moneyCents(row.label_cny ?? 0);
        // WHD 由 Ozon 仓发货，本来就没有采购和贴单，不能算作「未录入」
        if (row.order_type !== 'WHD订单') {
          if (row.purchase_cny == null) b.missing_purchase += 1;
          if (row.label_cny == null) b.missing_label += 1;
        }
      }
    }
    // 「其他状态订单」= 结算数据里只挂主单号、拆不到具体包裹的流水（多为收单业务费），按应计日归月
    for (const [month, item] of rows.loose || new Map()) {
      if (!month || month < SUMMARY_START) continue;
      for (const key of [month, `${month}|other`]) {
        const b = bucket(key);
        b.income += item.income;
        b.fees -= item.fees;
        b.flows += item.flows;
      }
    }
    const build = (key, label, isGroup, groupKey) => {
      const b = buckets.get(key) || empty();
      const income = b.income / 100, fees = b.fees / 100, ad = b.ad / 100;
      const receipt = (b.income + b.fees - b.ad) / 100;
      const usable = Number.isFinite(rate) && rate > 0;
      const receiptCny = usable ? rounded(receipt * rate) : null;
      const salesCny = usable ? rounded(income * rate) : null;
      const purchase = b.purchase / 100, labelCny = b.label / 100;
      const profit = receiptCny == null ? null : rounded(receiptCny - purchase - labelCny);
      return {
        id: `${key}:${groupKey || 'total'}`, month: key.split('|')[0], group: groupKey || 'total', label, is_group: isGroup,
        orders: b.orders, flows: b.flows, pending_orders: b.pending_orders, income_rub: rounded(income), ozon_fees_rub: rounded(fees),
        advertising_rub: rounded(ad), allocated_ad_rub: rounded(ad), order_ad_rub: rounded(ad),
        receipt_rub: rounded(receipt), receipt_cny: receiptCny, sales_cny: salesCny,
        // WHD 无采购/贴单成本；「其他状态订单」组只有主单级流水、没有订单行，两者都展示为空，
        // 避免出现 0.00 被误读成「录了 0 元」或「成本为零」
        purchase_cny: groupKey === 'whd' || !b.orders ? null : rounded(purchase),
        label_cny: groupKey === 'whd' || !b.orders ? null : rounded(labelCny),
        profit_cny: profit,
        // 毛利率 = 毛利 ÷ 销售，分母必须是有订单的已结算组；无订单组（主单级费用）和未结算行不计算，
        // 否则会算出 -500%、-6000% 这类无业务意义的数字
        margin_pct: profit != null && salesCny > 0 && b.orders > 0 && !key.startsWith('unsettled')
          ? rounded(profit / salesCny * 100) : null,
        profit_orders: b.orders, profit_excluded_orders: 0,
        missing_purchase: b.missing_purchase, missing_label: b.missing_label,
        missing_advertising: 0, missing_receipt_rub: 0, missing_receipt_cny: 0,
        coverage: { complete: true, checked_days: 1 },
      };
    };
    const months = [...new Set([...buckets.keys()].map((key) => key.split('|')[0]))]
      .filter((month) => month !== 'unsettled' && month >= SUMMARY_START).sort();
    const list = months.map((month) => ({
      ...build(month, `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`, false),
      children: SUMMARY_GROUPS.map(([group, name]) => build(`${month}|${group}`, name, true, group)),
    }));
    list.push({
      ...build('unsettled', '未结算', false),
      children: SUMMARY_GROUPS.map(([group, name]) => build(`unsettled|${group}`, name, true, group)),
    });
    return list;
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
  async   function saveOrders(ctx, incoming) {
    if (!incoming.length) return Promise.resolve(0);
    return transaction(ctx, async (client) => {
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
      if (!changed.length) return 0;
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
      return changed.length;
    });
  }
  // 订单表增量同步：拉最近 7 天的订单（新单 + 状态变化），再补查一批「非终态」订单的状态。
  // 结算明细的状态/商品等信息都直接读订单表，所以这里一更新，明细立刻跟着变。
  const ORDER_SYNC_MS = 30 * 60 * 1000;
  async function syncOrdersNow(ctx, trigger = 'manual') {
    const id = (await query(`INSERT INTO app_statistics_order_syncs(user_id,store_id,trigger) VALUES($1,$2,$3) RETURNING id`,
      [ctx.userId, ctx.storeId, trigger])).rows[0].id;
    let fetched = 0, changed = 0;
    try {
      const since = new Date(Date.now() - 7 * 86400000).toISOString(), to = new Date().toISOString();
      for (const schema of ['fbs', 'fbo']) {
        let cursor = '';
        const seen = new Set();
        for (let page = 0; page < 100; page++) {
          const body = await callOzon(schema === 'fbs' ? '/v4/posting/fbs/list' : '/v3/posting/fbo/list', {
            cursor, filter: { since, to }, limit: 100,
            with: { financial_data: false, analytics_data: false }, ...(schema === 'fbs' ? { dir: 'DESC' } : { sort_dir: 'desc' }),
          }, { storeId: ctx.storeId, userId: ctx.userId });
          if (!Array.isArray(body.postings)) throw fail('Ozon 订单列表响应结构异常', 502);
          const items = body.postings.map((p) => normalizeOrder(p, schema));
          fetched += items.length;
          changed += await saveOrders(ctx, items);
          if (!body.has_next) break;
          const next = String(body.cursor || '');
          if (!next || next === cursor || seen.has(next)) break;
          seen.add(next); cursor = next;
        }
      }
      // 老订单的状态变化（如运输中→签收、取消）不会出现在「最近 7 天」里，
      // 按「最久没更新优先」每轮补查 120 单，几轮就能把非终态订单扫一遍。
      const stale = (await query(`SELECT payload FROM app_statistics_orders WHERE user_id=$1 AND store_id=$2
        AND coalesce(payload->>'status','') <> 'delivered' AND coalesce(payload->>'status','') NOT LIKE 'cancelled%'
        AND coalesce(payload->>'status','') <> 'returned'
        ORDER BY updated_at ASC LIMIT 120`, [ctx.userId, ctx.storeId])).rows.map((row) => row.payload);
      for (const order of stale) {
        const schema = order.schema === 'fbo' ? 'fbo' : 'fbs';
        try {
          const response = await callOzon(schema === 'fbs' ? '/v3/posting/fbs/get' : '/v2/posting/fbo/get',
            { posting_number: order.posting_number, with: { financial_data: false, analytics_data: false } },
            { storeId: ctx.storeId, userId: ctx.userId });
          changed += await saveOrders(ctx, [normalizeOrder(response.result || response, schema)]);
          fetched += 1;
        } catch { /* 单笔查不到就跳过，不影响整轮同步 */ }
      }
      await updateSettledFromSales(ctx);
      await query(`UPDATE app_statistics_order_syncs SET status='succeeded',fetched=$2,changed=$3,finished_at=now(),message=$4 WHERE id=$1`,
        [id, fetched, changed, `拉取 ${fetched} 单 · 更新 ${changed} 单`]);
      clearCache(ctx.storeId);
      return { fetched, changed };
    } catch (error) {
      await query(`UPDATE app_statistics_order_syncs SET status='failed',fetched=$2,changed=$3,finished_at=now(),message=$4 WHERE id=$1`,
        [id, fetched, changed, String(error.message || error).slice(0, 500)]).catch(() => {});
      throw error;
    }
  }
  // 每 5 分钟检查一次，距上次同步超过 30 分钟就补一轮（重启后按数据库里的时间判断，不会丢）
  // ── Ozon 卖家后台（网页版）会话 ──────────────────────────────────────────────
  // Ozon Seller API 的 posting 详情只给取消原因/发起方，**不给取消时间**；
  // 后台网页版的订单列表接口才有 last_change_status_date（精确到秒）。
  // 这里按店铺存一份网页 cookie，用于补取消单的 settled_date。
  const WEB_BASE = 'https://seller.ozon.ru';
  const WEB_LIST = '/api/posting-service/seller-ui/fbs/posting/list';
  const WEB_BATCH = 50;
  const WEB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
  function webSessionRequired(message) {
    return Object.assign(fail(message, 409), { code: 'WEB_SESSION_REQUIRED' });
  }
  // cookie 统一成 name=value; name2=value2，去掉用户粘贴时带上的 "Cookie:" 头和换行
  function normalizeCookie(raw) {
    let text = String(raw || '').trim();
    if (!text) throw fail('请粘贴 Ozon 卖家后台的 Cookie');
    if (text.length > 16000) throw fail('Cookie 内容过长，请只粘贴 ozon.ru 域下的请求头');
    text = text.replace(/^cookie\s*:\s*/i, '').replace(/[\r\n]+/g, '; ');
    const pairs = new Map();
    for (const part of text.split(';')) {
      const item = part.trim();
      const at = item.indexOf('=');
      if (at <= 0) continue;
      pairs.set(item.slice(0, at).trim(), item);
    }
    if (!pairs.size) throw fail('Cookie 格式不正确，应形如 name=value; name2=value2');
    return [...pairs.values()].join('; ');
  }
  async function webSessionRow(ctx) {
    return (await query(`SELECT cookie_cipher,company_id,host,last_error,updated_at FROM app_statistics_web_sessions WHERE user_id=$1 AND store_id=$2`,
      [ctx.userId, ctx.storeId])).rows[0] || null;
  }
  async function webCompanyId(ctx, row) {
    if (row?.company_id && /^\d+$/.test(row.company_id)) return Number(row.company_id);
    // 网页接口的 company_id 就是店铺的 Ozon Client-Id，没单独填时直接取店铺凭据
    const store = (await query('SELECT client_id FROM app_stores WHERE id=$1 AND user_id=$2', [ctx.storeId, ctx.userId])).rows[0];
    const value = String(store?.client_id || '').replace(/\D/g, '');
    if (!value) throw fail('缺少 Ozon 公司 ID，请在会话设置里补填');
    return Number(value);
  }
  // 后台域名：.ru 为主，中国站店铺是 seller.ozonru.cn
  function webHost(row) {
    const host = String(row?.host || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    return /^[a-z0-9.-]+$/i.test(host) ? host : 'seller.ozon.ru';
  }
  // Ozon 后台接口带机器人校验：首次请求会 307 到 ?__rr=1 并 Set-Cookie 一个 __Secure-ETC，
  // 用它重放才放行。所以这里不能用自动跟随（会跳死循环），要自己维护 cookie 罐。
  async function webPost(cookie, base, path, body) {
    const jar = new Map();
    for (const part of String(cookie || '').split(';')) {
      const item = part.trim(), at = item.indexOf('=');
      if (at > 0) jar.set(item.slice(0, at).trim(), item.slice(at + 1).trim());
    }
    const serialize = () => [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
    let url = base + path;
    for (let hop = 0; hop < 4; hop += 1) {
      let response;
      try {
        response = await fetch(url, {
          method: 'POST', redirect: 'manual',
          headers: {
            'Content-Type': 'application/json', Accept: 'application/json',
            Cookie: serialize(), Origin: base, Referer: `${base}/app/postings/crossborder/fbs`,
            'User-Agent': WEB_UA, 'x-o3-language': 'zh-Hans',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        });
      } catch (error) {
        const code = error?.cause?.code || error?.name || error?.message;
        if (error?.name === 'TimeoutError') throw fail('Ozon 后台接口超时，请稍后重试', 502);
        throw fail(`无法连接 Ozon 卖家后台（${code}），请确认服务器网络能访问 seller.ozon.ru`, 502);
      }
      // 收集 Set-Cookie（机器人校验的 ETC 就在这里面）
      const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
      for (const raw of setCookies) {
        const pair = String(raw).split(';')[0], at = pair.indexOf('=');
        if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw fail(`Ozon 后台接口异常跳转（${response.status}）且没有跳转地址`, 502);
        url = new URL(location, url).toString();
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw webSessionRequired('Ozon 后台拒绝了这次请求：登录态已失效（cookie 过期或被踢下线），请重新获取 cookie');
      }
      const text = await response.text();
      if (response.status >= 400) throw fail(`Ozon 后台接口返回 ${response.status}`, 502);
      if (/^\s*</.test(text)) throw webSessionRequired('Ozon 后台返回的是网页而不是数据，通常是 cookie 无效，请重新获取');
      try { return JSON.parse(text); } catch { throw fail('Ozon 后台接口返回了非 JSON 内容', 502); }
    }
    throw fail('Ozon 后台接口跳转次数过多，请重新获取 cookie', 502);
  }
  async function webProbe(cookie, companyId, host = 'seller.ozon.ru') {
    const body = await webPost(cookie, `https://${host}`, WEB_LIST, {
      filter: { company_id: companyId, delivery_groups: ['all'], status_alias: ['cancelled'] },
      limit: 1, cursor: '', sort: 'last_change_status_date', sort_dir: 'desc',
    });
    if (!body || typeof body !== 'object') throw fail('Ozon 后台接口返回结构异常', 502);
    return true;
  }
  // 当前筛选条件下（月度统计-结算明细的筛选口径），状态为已取消且还没结算日期的订单
  async function pendingSettledTargets(ctx, params = {}) {
    const month = validMonth(String(params.month || shanghaiDate().slice(0, 7)));
    const data = await loadData(ctx);
    const result = report(data, month);
    const rate = Number(result.summary.exchange_rate || data.rate) || data.rate;
    // 用与页面/导出完全相同的筛选函数，保证「页面上看到什么就同步什么」
    const allRows = buildOrderRows(data, rate);
    const pageRows = filteredRows(allRows, params);
    const rows = pageRows.filter((row) => String(row.raw_status || '').startsWith('cancelled') && row.order_settled_date == null);
    logger.info('[sync-settled-plan]', JSON.stringify({
      store: ctx.storeId, month, orders: data.orders.length, built: allRows.length,
      filtered: pageRows.length, cancelled_unsettled: rows.length,
      status: params.status || '(all)', unsettled: params.unsettled || '',
      sample: pageRows.slice(0, 3).map((row) => `${row.posting_number}|${row.raw_status}|${row.order_settled_date || 'null'}`),
    }));
    const isWhd = (row) => row.order_type === 'WHD订单';
    // 交给插件的时间窗：覆盖这批订单的下单时间，插件按「状态=已取消 + 时间窗」拉全量再本地匹配
    const times = rows.map((row) => Date.parse(row.ordered_at)).filter((value) => Number.isFinite(value));
    const range = times.length
      ? { from: new Date(Math.min(...times) - 86400000).toISOString(), to: new Date(Math.max(...times) + 86400000).toISOString() }
      : null;
    return {
      fbs: rows.filter((row) => !isWhd(row)).map((row) => row.posting_number),
      whd: rows.filter(isWhd).map((row) => row.posting_number),
      matched: rows.length,
      range,
    };
  }
  // 批量取 FBS 取消时间（返回 posting → 北京时间日期）
  async function fetchCancelDates(ctx, targets, session, companyId) {
    let cookie;
    try { cookie = openCredential(session.cookie_cipher, credentialSecret); }
    catch { throw webSessionRequired('Ozon 后台会话无法解密，请重新获取 cookie'); }
    const host = webHost(session);
    const found = new Map();
    for (let i = 0; i < targets.length; i += WEB_BATCH) {
      const batch = targets.slice(i, i + WEB_BATCH);
      const body = await webPost(cookie, `https://${host}`, WEB_LIST, {
        filter: {
          company_id: companyId, delivery_groups: ['all'], posting_number: batch,
          // 单号筛选之外再给一个足够宽的区间，避免归档单被默认「三个月」挡掉
          processed_at_from: '2025-01-01T00:00:00.000Z',
          processed_at_to: new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/, '.000Z'),
        },
        limit: batch.length * 2, cursor: '', sort: 'last_change_status_date', sort_dir: 'desc',
      });
      const postings = Array.isArray(body?.result?.postings) ? body.result.postings : [];
      for (const posting of postings) {
        if (!posting?.posting_number || !posting.last_change_status_date) continue;
        // Ozon 给的是 UTC，结算日按北京时间归日
        const date = new Date(Date.parse(posting.last_change_status_date) + 8 * 3600000).toISOString().slice(0, 10);
        found.set(String(posting.posting_number), date);
      }
      if (i + WEB_BATCH < targets.length) await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return found;
  }
  // FBS 取消日期走服务端后台接口；WHD 没有取消时间字段，返回 whd 列表交给浏览器插件去「退货和取消」页取。
  async function syncSettledFromWeb(ctx, params = {}) {
    const { fbs: targets, whd, matched, range } = await pendingSettledTargets(ctx, params);
    const session = await webSessionRow(ctx);
    const base = { whd, whd_updated: 0, matched };
    // plan=1：只回清单，由浏览器插件去取（Ozon 会话绑 IP，服务端直连不可靠）
    if (params.plan === true || params.plan === '1') {
      // 网页接口按 company_id 鉴权，必须给插件传本店真实公司号（= Ozon Client-Id）
      const store = (await query('SELECT client_id FROM app_stores WHERE id=$1 AND user_id=$2', [ctx.storeId, ctx.userId])).rows[0];
      const companyId = String(store?.client_id || session?.company_id || '').replace(/\D/g, '');
      return { ...base, total: targets.length + whd.length, fbs_total: targets.length, fbs: targets, range, company_id: companyId,
        updated: 0, missing: [], session_updated_at: session?.updated_at || null };
    }
    if (!targets.length) {
      return { ...base, total: whd.length, fbs_total: 0, updated: 0, missing: [],
        company_id: session?.company_id || '', session_updated_at: session?.updated_at || null };
    }
    if (!session) throw webSessionRequired('还没有配置 Ozon 后台会话，请先获取 cookie（点「从浏览器获取」即可）');
    const companyId = await webCompanyId(ctx, session);
    const found = await fetchCancelDates(ctx, targets, session, companyId);
    const targetSet = new Set(targets);
    const values = [...found.entries()]
      .filter(([posting]) => targetSet.has(posting))
      .map(([posting_number, date]) => ({ posting_number, date }));
    let updated = 0;
    if (values.length) updated = await writeSettledDates(ctx, values, targets.length);
    await query(`UPDATE app_statistics_web_sessions SET last_error='' WHERE user_id=$1 AND store_id=$2`,
      [ctx.userId, ctx.storeId]).catch(() => {});
    const missing = targets.filter((posting) => !found.has(posting));
    return { ...base, total: targets.length + whd.length, fbs_total: targets.length, updated, missing,
      company_id: String(companyId), session_updated_at: session.updated_at };
  }
  // 统一的落库：只写「已取消 + 结算日期为空」的订单
  async function writeSettledDates(ctx, values, requested) {
    return transaction(ctx, async (client) => {
      const result = await client.query(`
        UPDATE app_statistics_orders o
        SET settled_date = v.date::date, updated_at = now()
        FROM jsonb_to_recordset($3::jsonb) AS v(posting_number text, date text)
        WHERE o.user_id=$1 AND o.store_id=$2 AND o.posting_number = v.posting_number
          AND o.settled_date IS NULL AND coalesce(o.payload->>'status','') LIKE 'cancelled%'`,
        [ctx.userId, ctx.storeId, JSON.stringify(values)]);
      await audit(client, ctx, 'sync_settled', null, '同步取消单结算日期（Ozon 后台取消日期）',
        { requested, matched: values.length, updated: result.rowCount || 0 });
      return result.rowCount || 0;
    });
  }
  // WHD 的取消日期由插件在浏览器里从「退货和取消」取回（形如 "10 7月"），这里只做校验和落库
  function parseWebDate(value) {
    const text = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    // 插件直接回传 UTC 时间时，按北京时间归日
    if (/^\d{4}-\d{2}-\d{2}T/.test(text) && Number.isFinite(Date.parse(text))) {
      return new Date(Date.parse(text) + 8 * 3600000).toISOString().slice(0, 10);
    }
    const matched = text.match(/^(\d{1,2})\s*(\d{1,2})月$/);
    if (!matched) return null;
    const day = Number(matched[1]), month = Number(matched[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const today = shanghaiDate();
    let year = Number(today.slice(0, 4));
    const pad = (n) => String(n).padStart(2, '0');
    let date = `${year}-${pad(month)}-${pad(day)}`;
    if (date > today) date = `${year - 1}-${pad(month)}-${pad(day)}`; // 跨年时退回上一年
    return date;
  }
  async function saveWhdSettled(ctx, items, schema = 'fbo') {
    if (!Array.isArray(items) || !items.length) throw fail('没有要写入的取消日期');
    if (items.length > 2000) throw fail('一次最多写入 2000 单');
    const schemaFilter = schema === 'fbs' ? "coalesce(payload->>'schema','fbs') <> 'fbo'" : "coalesce(payload->>'schema','fbs') = 'fbo'";
    const targets = new Set((await query(`SELECT posting_number FROM app_statistics_orders
      WHERE user_id=$1 AND store_id=$2 AND posting_number=ANY($3::text[]) AND coalesce(payload->>'status','') LIKE 'cancelled%'
        AND settled_date IS NULL AND ${schemaFilter}`,
      [ctx.userId, ctx.storeId, items.map((item) => String(item.posting_number || ''))])).rows.map((row) => row.posting_number));
    const values = [];
    for (const item of items) {
      const posting = String(item.posting_number || '').trim();
      if (!targets.has(posting)) continue;
      const date = parseWebDate(item.date);
      if (!date) continue;
      values.push({ posting_number: posting, date });
    }
    if (!values.length) return { updated: 0, skipped: items.length };
    const updated = await writeSettledDates(ctx, values, items.length);
    return { updated, skipped: items.length - values.length };
  }
  let orderSyncing = false;
  async function orderSyncTick() {
    if (!db || orderSyncing) return;
    orderSyncing = true;
    try {
      const stores = (await query(`SELECT id,user_id FROM app_stores WHERE active=TRUE AND platform='ozon'`)).rows;
      for (const store of stores) {
        const last = (await query(`SELECT max(started_at) AS at FROM app_statistics_order_syncs WHERE user_id=$1 AND store_id=$2`,
          [store.user_id, store.id])).rows[0]?.at;
        if (last && Date.now() - new Date(last).getTime() < ORDER_SYNC_MS) continue;
        await syncOrdersNow({ userId: store.user_id, storeId: store.id }, 'auto').catch((error) => logger.warn('[order-sync]', store.id, error.message));
      }
    } catch (error) { logger.warn('[order-sync]', error.message); }
    finally { orderSyncing = false; }
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
      // 结算流水更新后重算 41 点击广告分摊：这一区间内每天的 41 可能新增或变动
      await rebuildClickAllocations(db, ctx, days).catch((error) => { logger.warn('[click-alloc]', error.message); });
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
    // 订单表增量同步：每 5 分钟检查一次，距上次超过 30 分钟才真正跑
    orderTimer = setInterval(() => orderSyncTick(), 5 * 60000); orderTimer.unref?.();
    setTimeout(() => orderSyncTick(), 90000).unref?.();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; if (orderTimer) clearInterval(orderTimer); orderTimer = null; }
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
    const data = await loadData(ctx);
    // 订单明细是全量订单表，维护费用不再限制在某个应计月份里
    const orders = new Map(data.orders.map((order) => [order.posting_number, order]));
    const validated = items.map((item) => {
      const order = orders.get(item.posting_number);
      if (!order) throw fail(`订单不存在：${item.posting_number}`);
      if (order.schema === 'fbo') throw fail(`WHD 订单不维护采购费和贴单费：${item.posting_number}`);
      return { posting_number: item.posting_number, purchase_cny: amountInput(item.purchase_cny, '采购费用'),
        ...(Object.hasOwn(item, 'label_cny') ? { label_cny: amountInput(item.label_cny, '贴单费用', true) } : {}), version: versionInput(item.version) };
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
  // 41 点击广告按日平分落库：每次导入广告明细、同步结算流水后重算受影响日期。
  // 同一天重复导入（当天数据还没导完）会先清空该日再重建，数字自动刷新成最新一版。
  async function rebuildClickAllocations(client, ctx, dates = null) {
    const scoped = Array.isArray(dates) && dates.length ? [...new Set(dates.map((d) => String(d).slice(0, 10)))] : null;
    const timezone = DEFAULT_AD_TIMEZONE;
    const params = scoped ? [ctx.userId, ctx.storeId, scoped] : [ctx.userId, ctx.storeId];
    const dayFilter = scoped ? ' AND accrued_date = ANY($3::date[])' : '';
    const daily = (await client.query(`
      WITH x AS (
        SELECT accrued_date AS d, (payload->'non_item_fee'->>'type_id')::int AS tid,
               coalesce((payload->'non_item_fee'->'accrued'->>'amount')::numeric,
                        (payload->'total_amount'->>'amount')::numeric) AS amt
        FROM app_statistics_accruals
        WHERE user_id=$1 AND store_id=$2 AND jsonb_typeof(payload->'non_item_fee')='object'
          AND coalesce(payload->>'source','ozon')='ozon'${dayFilter}
        UNION ALL
        SELECT a.accrued_date, (fee->>'type_id')::int, (fee->'accrued'->>'amount')::numeric
        FROM app_statistics_accruals a,
             LATERAL jsonb_array_elements(coalesce(a.payload->'item_fees'->'fees','[]'::jsonb)) p,
             LATERAL jsonb_array_elements(coalesce(p->'fees','[]'::jsonb)) fee
        WHERE a.user_id=$1 AND a.store_id=$2 AND coalesce(a.payload->>'source','ozon')='ozon'
          ${scoped ? 'AND a.accrued_date = ANY($3::date[])' : ''}
      )
      -- 逐条取绝对值再求和：41 里可能正负混合（退款/调整），先 sum 再 abs 会互相抵消
      SELECT d::text AS d, round(sum(abs(amt)),2) AS amt FROM x WHERE tid=41 GROUP BY 1`, params)).rows;
    const whdUnits = new Set((await client.query(`SELECT DISTINCT payload->>'unit_number' AS u FROM app_statistics_accruals
      WHERE user_id=$1 AND store_id=$2 AND payload->'posting'->>'delivery_schema'='Whd'`, [ctx.userId, ctx.storeId])).rows.map((r) => r.u));
    // 只在「报表里会出现」的订单之间平分：没有应计流水的订单在月度报表中没有行，
    // 分到它身上就显示不出来，总额会和 41 对不上。
    const visible = new Set((await client.query(`
      WITH units AS (
        SELECT DISTINCT payload->>'unit_number' AS u FROM app_statistics_accruals WHERE user_id=$1 AND store_id=$2
      ), ord AS (
        SELECT payload->>'posting_number' AS pn, regexp_replace(payload->>'posting_number','-[0-9]+$','') AS par
        FROM app_statistics_orders WHERE user_id=$1 AND store_id=$2
      ), sib AS (SELECT par, count(*) AS n FROM ord GROUP BY 1)
      SELECT DISTINCT o.pn FROM ord o
      WHERE o.pn IN (SELECT u FROM units)
         OR (o.par IN (SELECT u FROM units) AND (SELECT s.n FROM sib s WHERE s.par=o.par)=1)`,
      [ctx.userId, ctx.storeId])).rows.map((r) => r.pn));
    const orders = (await client.query('SELECT payload FROM app_statistics_orders WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId])).rows.map((r) => r.payload);
    const cohorts = new Map();
    for (const order of orders) {
      // WHD（海外仓）不参与平分，其余状态（取消、在途、签收）全部计入分母
      if (order.schema === 'fbo' || whdUnits.has(order.posting_number)) continue;
      if (!visible.has(order.posting_number)) continue;
      const day = businessDate(orderTimestamp(order), timezone);
      if (!day || (scoped && !scoped.includes(day))) continue;
      if (!cohorts.has(day)) cohorts.set(day, []);
      cohorts.get(day).push(order.posting_number);
    }
    if (scoped) await client.query('DELETE FROM app_statistics_click_allocations WHERE user_id=$1 AND store_id=$2 AND ad_date=ANY($3::date[])', [ctx.userId, ctx.storeId, scoped]);
    else await client.query('DELETE FROM app_statistics_click_allocations WHERE user_id=$1 AND store_id=$2', [ctx.userId, ctx.storeId]);
    let days = 0, rows = 0, amountRub = 0, skipped = 0;
    for (const row of daily) {
      const members = [...(cohorts.get(row.d) || [])].sort();
      const amount = Math.round(Number(row.amt) * 100);
      if (!amount || !members.length) { if (amount) skipped += 1; continue; }
      const perOrder = Math.floor(amount / members.length), remainder = amount % members.length;
      const list = members.map((posting, index) => ({ d: row.d, o: posting, c: perOrder + (index < remainder ? 1 : 0), n: members.length }));
      await client.query(`INSERT INTO app_statistics_click_allocations(user_id,store_id,ad_date,order_number,cents,order_count)
        SELECT $1,$2,(x->>'d')::date,x->>'o',(x->>'c')::bigint,(x->>'n')::int FROM jsonb_array_elements($3::jsonb) x`,
        [ctx.userId, ctx.storeId, JSON.stringify(list)]);
      days += 1; rows += list.length; amountRub += amount;
    }
    return { days, rows, amount_rub: amountRub / 100, skipped_days: skipped };
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
      // 导入完成后重算这几天的 41 点击广告分摊：当天数据没导完时再导一次会整日覆盖
      const click = await rebuildClickAllocations(client, ctx, touchedDays);
      return { success: true, checks, total_diff: totalDiff, shifted_days: shifted.length, days: byDay.size, days_written: replaced, days_unchanged: reused,
        entries: entries.length, rows_written: inserted,
        ad_lines: adPayloads.length, click_alloc: click,
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
      // 订单明细 = 订单总表，有多少订单就展示多少（1:1），金额按订单号从结算明细全期关联，
      // 与月份无关；没有应计流水的订单也保留，金额留空等结算后自动补上。
      const rate = Number(result.summary.exchange_rate || data.rate) || data.rate;
      const rows = filteredRows(buildOrderRows(data, rate), params);
      const size = Math.min(500, Math.max(1, parseInt(params.page_size, 10) || 100));
      const page = Math.max(1, parseInt(params.page, 10) || 1);
      // 顶部「本月结算订单」按结算日期归月，只看 settled_date 落在所选月份的订单
      const settledMonth = data.orders.filter((order) => String(order.settled_date || '').slice(0, 7) === month);
      res.json({ success: true, rows: rows.slice((page - 1) * size, page * size), total: rows.length,
        summary: { ...result.summary, settled_orders: settledMonth.length,
          settled_whd_orders: settledMonth.filter((order) => order.schema === 'fbo').length }, run: await latestRun(ctx),
        advertising: { ...publicAdvertising(data.adConfig), ...result.advertising }, filter_catalog: REPORT_FIELDS,
        schedule: { time: '02:00, 09:30', timezone: 'Asia/Shanghai', frequency: 'daily' } });
    };
    route('get', '/report', reportRoute);
    route('post', '/report', reportRoute);
    // 轻量接口：只算顶部指标卡（切月份时用，不拉订单明细，也不动下方两个 tab）
    route('get', '/summary', async (req, res, ctx) => {
      const month = validMonth(String(req.query.month || shanghaiDate().slice(0, 7)));
      const data = await loadData(ctx);
      const result = report(data, month);
      const settled = data.orders.filter((order) => String(order.settled_date || '').slice(0, 7) === month);
      res.json({ success: true, run: await latestRun(ctx),
        summary: { ...result.summary, settled_orders: settled.length, settled_whd_orders: settled.filter((order) => order.schema === 'fbo').length } });
    });
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
    // 订单表增量同步（只拉订单，不动结算流水）：每 30 分钟自动跑一次，也可手动触发
    route('post', '/sync-orders', async (req, res, ctx) => res.json({ success: true, ...(await syncOrdersNow(ctx, 'manual')) }));
    route('get', '/order-syncs', async (req, res, ctx) => {
      const rows = (await query(`SELECT id,trigger,status,fetched,changed,message,
        to_char(started_at AT TIME ZONE 'Asia/Shanghai','MM-DD HH24:MI') AS started_at,
        to_char(finished_at AT TIME ZONE 'Asia/Shanghai','MM-DD HH24:MI') AS finished_at
        FROM app_statistics_order_syncs WHERE user_id=$1 AND store_id=$2 ORDER BY started_at DESC LIMIT 50`,
        [ctx.userId, ctx.storeId])).rows;
      const last = rows.find((row) => row.status === 'succeeded');
      res.json({ success: true, rows, last_succeeded_at: last?.finished_at || null, interval_minutes: 30 });
    });
    // 网页会话：只服务于「同步结算日期」（取消时间 Seller API 拿不到，只能走后台网页接口）
    route('get', '/web-session', async (req, res, ctx) => {
      const row = await webSessionRow(ctx);
      res.json({ success: true, configured: Boolean(row), company_id: row?.company_id || '',
        host: row ? webHost(row) : 'seller.ozon.ru',
        updated_at: row?.updated_at || null, last_error: row?.last_error || '' });
    });
    route('post', '/web-session', async (req, res, ctx) => {
      const cookie = normalizeCookie(req.body?.cookie);
      const rawCompany = String(req.body?.company_id || '').replace(/\D/g, '');
      const store = (await query('SELECT client_id FROM app_stores WHERE id=$1 AND user_id=$2', [ctx.storeId, ctx.userId])).rows[0];
      const companyId = rawCompany || String(store?.client_id || '').replace(/\D/g, '');
      if (!companyId) throw fail('缺少 Ozon 公司 ID');
      const host = webHost({ host: String(req.body?.host || '') });
      // 存之前先探一次，cookie 过期就别写库，直接告诉前端去重新取
      try { await webProbe(cookie, Number(companyId), host); }
      catch (error) {
        if (error?.code === 'WEB_SESSION_REQUIRED') {
          await query(`INSERT INTO app_statistics_web_sessions(user_id,store_id,cookie_cipher,company_id,host,last_error)
            VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,store_id) DO UPDATE SET last_error=EXCLUDED.last_error`,
            [ctx.userId, ctx.storeId, sealCredential(cookie, credentialSecret), companyId, host, 'cookie 校验未通过']).catch(() => {});
          throw webSessionRequired(`这个 cookie 已被 Ozon 拒绝，请确认是在已登录的浏览器里取的最新 Cookie（接口域名 ${host}）`);
        }
        throw error;
      }
      await query(`INSERT INTO app_statistics_web_sessions(user_id,store_id,cookie_cipher,company_id,host,last_error,updated_at)
        VALUES($1,$2,$3,$4,$5,'',now())
        ON CONFLICT(user_id,store_id) DO UPDATE SET cookie_cipher=EXCLUDED.cookie_cipher, company_id=EXCLUDED.company_id,
          host=EXCLUDED.host, last_error='', updated_at=now()`,
        [ctx.userId, ctx.storeId, sealCredential(cookie, credentialSecret), companyId, host]);
      clearCache(ctx.storeId);
      res.json({ success: true, company_id: companyId, host, verified: true });
    });
    // 同步结算日期（FBS/FBP 走服务端后台接口，WHD 交给插件在浏览器里取）
    route('post', '/sync-settled', async (req, res, ctx) => {
      const result = await syncSettledFromWeb(ctx, req.body || {});
      res.json({ success: true, total: result.total, updated: result.updated, matched: result.matched,
        fbs_total: result.fbs_total, fbs: result.fbs || [], whd: result.whd || [], whd_count: (result.whd || []).length,
        missing_count: result.missing.length, missing: result.missing.slice(0, 20),
        company_id: result.company_id, session_updated_at: result.session_updated_at });
    });
    // 前端把插件返回原样报回来，便于排查（只记日志，不入库）
    route('post', '/sync-settled-report', async (req, res, ctx) => {
      const body = req.body || {};
      const safe = {
        kind: String(body.kind || '').slice(0, 20),
        ok: body.ok === true,
        error: String(body.error || '').slice(0, 300),
        version: String(body.version || '').slice(0, 30),
        total: Number(body.total || 0), scanned: Number(body.scanned || 0),
        rows: Number(body.rows || 0), missing: Number(body.missing || 0),
        pages: Array.isArray(body.pages) ? body.pages.slice(0, 10) : [],
        elapsed_ms: Number(body.elapsed_ms || 0), tabs: Number(body.tabs || 0),
      };
      logger.info('[settle-report]', JSON.stringify({ store: ctx.storeId, ...safe }));
      res.json({ success: true });
    });

    // 插件在浏览器里取回的取消日期写库（schema: whd=fbo / fbs）
    route('post', '/sync-settled-whd', async (req, res, ctx) => {
      const kind = req.body?.schema === 'fbs' ? 'fbs' : 'fbo';
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      const result = await saveWhdSettled(ctx, items, kind);
      logger.info('[sync-settled-write]', JSON.stringify({ store: ctx.storeId, schema: kind,
        items: items.length, updated: result.updated, skipped: result.skipped || 0,
        sample: items.slice(0, 3).map((item) => `${item.posting_number}|${item.date}`) }));
      res.json({ success: true, ...result });
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
    // 全量重建 41 点击广告的按日分摊（导入/同步会自动重算，这里用于首次初始化或手工修复）
    route('post', '/click-allocations/rebuild', async (req, res, ctx) => {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.from || '')) ? String(req.body.from) : null;
      const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.to || '')) ? String(req.body.to) : null;
      const dates = from && to ? datesBetween(from, to) : null;
      const result = await rebuildClickAllocations(db, ctx, dates);
      clearCache(ctx.storeId);
      res.json({ success: true, ...result });
    });
    route('get', '/changes', async (req, res, ctx) => {
      const result = await query(`SELECT id,kind,month,reason,created_at,rolled_back_at,
        CASE WHEN kind='costs' THEN jsonb_array_length(payload->'after') WHEN kind='order_ad_import' THEN jsonb_array_length(payload->'after'->'entries') ELSE 1 END AS affected
        FROM app_statistics_changes WHERE user_id=$1 AND store_id=$2 AND kind IN ('costs','month','rollback','ad_import','order_ad_import') ORDER BY created_at DESC LIMIT 100`, [ctx.userId, ctx.storeId]);
      res.json({ success: true, rows: result.rows });
    });
    route('post', '/changes/:id/rollback', async (req, res, ctx) => res.json(await rollback(ctx, req.params.id)));
    route('get', '/ledger', async (req, res, ctx) => {
      const posting = String(req.query.posting_number || '');
      if (!/^\d+-\d+-\d+$/.test(posting)) throw fail('请输入完整订单号');
      const { rows, pending } = orderLedgerRows(await loadData(ctx), posting);
      res.json({ success: true, rows, pending, months: [...new Set(rows.map((row) => String(row.date).slice(0, 7)))].sort() });
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
      const month = validMonth(String(params.month || shanghaiDate().slice(0, 7)));
      const data = await loadData(ctx), result = report(data, month);
      const rate = Number(result.summary.exchange_rate || data.rate) || data.rate;
      const rows = filteredRows(buildOrderRows(data, rate), params);
      // 留痕：导出失败时能直接从日志看出前端传了什么条件、命中了多少行
      logger.info('[statistics-export]', JSON.stringify({ store: ctx.storeId, month, rows: rows.length,
        status: params.status || null, unsettled: params.unsettled || null, order_type: params.order_type || null,
        search: params.search || null, batch: Array.isArray(params.posting_numbers) ? params.posting_numbers.length : 0,
        filters: params.filters || null }));
      sendCsv(res, `${ctx.store.name}-${month}-结算明细.csv`, [[...REPORT_FIELDS.map((field) => field.label), '成本归属月', '广告分摊日', '分摊订单数', '点击广告状态', '已归属 Ozon 净额（₽）', '实收说明'],
        ...rows.map((r) => [...REPORT_FIELDS.map((field) => field.key === 'ordered_at'
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
  return { init, register, start, stop, startSync, tick, loadData, report, saveCosts, saveMonth, saveAdvertising, importAdvertising, syncAdvertising, rollback, replaceDay, saveOrders, importSnapshot, filteredRows, rebuildClickAllocations, orderLedgerRows, buildOrderRows, orderAggregates, settlementSummary };
}
