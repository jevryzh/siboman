import { buildSettlementReport, datesBetween, fail, moneyCents, monthBounds, parentOf, rounded } from './ozon-settlement.js';

export const DEFAULT_AD_TIMEZONE = 'Europe/Moscow';
export const REPORT_FIELDS = [
  { key: 'posting_number', label: '订单号', type: 'text' },
  { key: 'status', label: '状态', type: 'text' },
  { key: 'ordered_at', label: '下单日期', type: 'date' },
  { key: 'order_settled_date', label: '结算日期', type: 'date' },
  { key: 'settled_date', label: '末笔流水日', type: 'date' },
  { key: 'receipt_cny', label: '实收（¥）', type: 'number' },
  { key: 'purchase_cny', label: '采购（¥）', type: 'number' },
  { key: 'label_cny', label: '贴单（¥）', type: 'number' },
  { key: 'profit_cny', label: '毛利（¥）', type: 'number' },
  { key: 'margin_pct', label: '毛利率（%）', type: 'number' },
  { key: 'income_rub', label: '销售（₽）', type: 'number' },
  { key: 'ozon_fees_rub', label: '代扣（₽）', type: 'number' },
  { key: 'advertising_cpo_rub', label: '推广-订单（₽）', type: 'number' },
  { key: 'advertising_cpc_rub', label: '推广-点击（₽）', type: 'number' },
  { key: 'allocated_ad_rub', label: '点击广告分摊（₽）', type: 'number' },
  { key: 'receipt_rub', label: '实收（₽）', type: 'number' },
  { key: 'cancel_reason', label: '取消原因', type: 'text' },
  { key: 'order_type', label: '订单类型', type: 'text' },
];

const dateFormatters = new Map();
export function businessDate(value, timezone = DEFAULT_AD_TIMEZONE) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return null;
  try {
    if (!dateFormatters.has(timezone)) dateFormatters.set(timezone, new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }));
    return dateFormatters.get(timezone).format(new Date(value));
  }
  catch { throw fail('广告业务时区无效'); }
}
export function orderTimestamp(order) {
  return order.schema === 'fbo' ? (order.created_at || order.in_process_at) : (order.in_process_at || order.created_at);
}
const total = (items, key) => items.reduce((sum, row) => sum + moneyCents(row[key] ?? 0), 0) / 100;
const completeTotal = (items, key) => items.some((row) => row[key] == null) ? null : total(items, key);
const CLICK_AD = 41, ORDER_AD = 54;

// Only split fee components whose sum exactly reconciles to the root entry.
function attributedAds(entry, ledger, metadata) {
  if (!entry) return null;
  const amount = moneyCents(ledger.amount_rub);
  let fees;
  if (entry.non_item_fee) fees = [[Number(entry.non_item_fee.type_id), amount]];
  else {
    const parts = entry.item_fees?.fees || [];
    if (!parts.length || parts.flatMap((p) => p.fees).reduce((n, f) => n + moneyCents(f.accrued.amount), 0) !== moneyCents(entry.total_amount.amount)) return null;
    const selected = ledger.method === 'SKU唯一匹配'
      ? parts.filter((p) => metadata.get(ledger.posting_number)?.products?.some((item) => String(item.sku) === String(p.sku))) : parts;
    fees = selected.flatMap((p) => p.fees).map((f) => [Number(f.type_id), moneyCents(f.accrued.amount)]);
    if (fees.reduce((n, [, value]) => n + value, 0) !== amount) return null;
  }
  const order = fees.filter(([type]) => type === ORDER_AD);
  const cpo = order.length ? order.reduce((n, [, value]) => n + value, 0) : null;
  const cpc = fees.reduce((n, [type, value]) => n + (type === CLICK_AD ? value : 0), 0);
  return { cpo, cpc };
}

export function matchOrderAdRows(entries, orders) {
  const candidates = new Map(), occurrences = new Map(), centsByPosting = new Map(), cpoByPosting = new Map(), cpcByPosting = new Map(), unmatched = [];
  // matchedRows：逐条记录「哪个包裹、哪一天、哪种模式、多少钱」，供写入结算明细用
  const matchedRows = [];
  if (!entries.length) return { centsByPosting, cpoByPosting, cpcByPosting, unmatched, matchedRows };
  const key = (order, sku) => `${order}:${sku}`;
  const add = (posting, cents, mode, date) => {
    centsByPosting.set(posting, (centsByPosting.get(posting) || 0) + cents);
    const target = mode === 'cpc' ? cpcByPosting : cpoByPosting;
    target.set(posting, (target.get(posting) || 0) + cents);
    if (date) matchedRows.push({ posting_number: posting, cents, mode, date });
  };
  for (const order of orders) {
    const parent = order.posting_number.split('-').slice(0, 2).join('-');
    for (const product of order.products || []) {
      if (!Number.isSafeInteger(product.quantity) || product.quantity <= 0) continue;
      for (const number of new Set([parent, order.posting_number])) {
        const k = key(number, product.sku), map = candidates.get(k) || new Map();
        map.set(order.posting_number, (map.get(order.posting_number) || 0) + product.quantity);
        candidates.set(k, map);
      }
    }
  }
  for (const entry of entries) {
    const k = key(entry.order_number, entry.sku);
    occurrences.set(k, (occurrences.get(k) || 0) + 1);
  }
  for (const entry of entries) {
    const k = key(entry.order_number, entry.sku), matches = [...(candidates.get(k) || [])];
    const count = matches.reduce((n, [, qty]) => n + qty, 0);
    if (matches.length === 1 && count >= entry.quantity) {
      const [posting] = matches[0];
      add(posting, entry.cents, entry.mode, entry.date);
    } else if (matches.length > 1 && occurrences.get(k) === 1 && count === entry.quantity && entry.cents % count === 0) {
      for (const [posting, qty] of matches) add(posting, entry.cents / count * qty, entry.mode, entry.date);
    } else unmatched.push(entry);
  }
  return { centsByPosting, cpoByPosting, cpcByPosting, unmatched, matchedRows };
}

export function monthlyAccrualReport(options) {
  const scoped = { ...options, byAccrualMonth: true };
  return dailySettlementReport(buildSettlementReport(scoped), scoped);
}

export function dailySettlementReport(base, { month, orders = [], accruals = [], adDays = [], orderDays = [], orderAdEntries = [], timezone = DEFAULT_AD_TIMEZONE, now = new Date(), configured = false, byAccrualMonth = false } = {}) {
  const metadata = new Map(orders.map((order) => [order.posting_number, order]));
  const withinMonth = (date) => date?.slice(0, 7) === month;
  const matchingEntries = byAccrualMonth ? orderAdEntries.filter((entry) => withinMonth(entry.date)) : orderAdEntries;
  const { centsByPosting, cpoByPosting, cpcByPosting, unmatched } = matchOrderAdRows(matchingEntries, orders);
  const hasAnyAd = cpoByPosting.size > 0 || cpcByPosting.size > 0;
  const whd = new Set(orders.filter((o) => o.schema === 'fbo').map((o) => o.posting_number));
  for (const entry of accruals) if (entry.posting?.delivery_schema === 'Whd') whd.add(entry.unit_number);
  const cohorts = new Map(), checked = new Set(orderDays.filter((d) => d.business_timezone === timezone).map((d) => String(d.ordered_date).slice(0, 10)));
  for (const order of metadata.values()) {
    if (whd.has(order.posting_number)) continue;
    const date = businessDate(orderTimestamp(order), timezone);
    if (!date || (byAccrualMonth && !withinMonth(date))) continue;
    if (!cohorts.has(date)) cohorts.set(date, []);
    cohorts.get(date).push(order.posting_number);
  }
  const daily = new Map(adDays.filter((d) => d.business_timezone === timezone).map((d) => [String(d.spend_date).slice(0, 10), d]));
  const shares = new Map(), today = businessDate(now, timezone), unallocated = [];
  for (const [date, day] of daily) {
    if (byAccrualMonth && !withinMonth(date)) continue;
    if (date >= today || !checked.has(date)) continue;
    const members = [...(cohorts.get(date) || [])].sort();
    const budget = moneyCents(day.cpc_rub);
    if (!members.length) { if (budget) unallocated.push({ date, amount_rub: budget / 100 }); continue; }
    const sign = budget < 0 ? -1 : 1, amount = Math.abs(budget), perOrder = Math.floor(amount / members.length), remainder = amount % members.length;
    members.forEach((posting, index) => shares.set(posting, { amount: sign * (perOrder + (index < remainder ? 1 : 0)) / 100, count: members.length }));
  }
  let orderAdsChecked = false;
  const unresolvedOrderNumbers = new Set(unmatched.map((entry) => entry.order_number));
  const adsWithoutFinance = new Map();
  if (byAccrualMonth) {
    const { start, end } = monthBounds(month);
    const totals = new Map();
    for (const e of matchingEntries) totals.set(e.date, (totals.get(e.date) || 0) + e.cents);
    orderAdsChecked = end < today && datesBetween(start, end).every((date) =>
      daily.has(date) && moneyCents(daily.get(date).cpo_rub) === (totals.get(date) || 0));
    const posted = new Set(base.rows.map((r) => r.posting_number));
    const addOutside = (id, cents) => {
      if (!posted.has(id) && cents) adsWithoutFinance.set(id, (adsWithoutFinance.get(id) || 0) + cents);
    };
    for (const [id, cents] of centsByPosting) addOutside(id, cents);
    for (const [id, share] of shares) addOutside(id, moneyCents(share.amount));
  }
  const raw = new Map(accruals.map((entry) => [entry.accrual_id, entry]));
  const adjustments = new Map();
  for (const ledger of base.ledger) {
    if (!byAccrualMonth && whd.has(ledger.posting_number)) continue;
    const ads = attributedAds(raw.get(ledger.accrual_id), ledger, metadata);
    if (!ads || (ads.cpo == null && !ads.cpc)) continue;
    const value = adjustments.get(ledger.posting_number) || { sales: 0, fees: 0, cpo: null };
    const original = moneyCents(ledger.amount_rub), withoutAds = original - (ads.cpo ?? 0) - ads.cpc;
    value.sales += Math.max(withoutAds, 0) - Math.max(original, 0);
    value.fees += Math.max(-withoutAds, 0) - Math.max(-original, 0);
    if (ads.cpo != null) value.cpo = (value.cpo ?? 0) - ads.cpo;
    adjustments.set(ledger.posting_number, value);
  }
  const rows = base.rows.map((row) => {
    const isWhd = row.order_type === 'WHD订单', date = businessDate(row.ordered_at, timezone), share = shares.get(row.posting_number);
    const otherClickMonth = byAccrualMonth && !!date && !withinMonth(date);
    const adjustment = adjustments.get(row.posting_number) || { sales: 0, fees: 0, cpo: null };
    const sales = row.income_rub == null ? null : (moneyCents(row.income_rub) + adjustment.sales) / 100;
    const fees = row.ozon_fees_rub == null ? null : (moneyCents(row.ozon_fees_rub) + adjustment.fees) / 100;
    const adState = isWhd ? 'whd_excluded' : otherClickMonth ? 'other_month' : !date ? 'missing_date' : date >= today ? 'pending_day'
      : !daily.has(date) ? (configured ? 'not_synced' : 'missing_config') : !checked.has(date) ? 'incomplete_cohort' : !share ? 'not_synced' : 'confirmed';
    const allocated = isWhd || otherClickMonth ? 0 : share?.amount ?? null;
    // Use the posted charge when available; the same fee must not be counted from both sources.
    const orderAdCents = adjustment.cpo ?? centsByPosting.get(row.posting_number);
    const zeroOrderAd = orderAdsChecked && !unresolvedOrderNumbers.has(row.posting_number) && !unresolvedOrderNumbers.has(parentOf(row.posting_number));
    const orderAd = isWhd && !byAccrualMonth ? 0 : orderAdCents == null ? (zeroOrderAd ? 0 : null) : orderAdCents / 100;
    const financeReady = !!base.summary.coverage?.complete && !row.metadata_missing;
    const receipt = allocated != null && sales != null && fees != null && financeReady ? rounded(sales - fees - (orderAd ?? 0) - allocated) : null;
    const receiptCny = receipt != null && base.summary.exchange_rate ? rounded(receipt * base.summary.exchange_rate) : null;
    const profit = receiptCny != null && row.purchase_cny != null ? rounded(receiptCny - row.purchase_cny - row.label_cny) : null;
    return { ...row, income_rub: sales, ozon_fees_rub: fees, advertising_rub: orderAd,
      // 广告费按计费模式拆开：按订单付费 / 按点击付费
      advertising_cpo_rub: isWhd && !byAccrualMonth ? 0 : hasAnyAd ? (cpoByPosting.get(row.posting_number) || 0) / 100 : null,
      advertising_cpc_rub: isWhd && !byAccrualMonth ? 0 : hasAnyAd ? (cpcByPosting.get(row.posting_number) || 0) / 100 : null,
      // 订单表上的结算日期（取消订单在被发现取消那天写入），供明细展示
      order_settled_date: metadata.get(row.posting_number)?.settled_date ?? null,
      platform_net_rub: row.income_rub == null || row.ozon_fees_rub == null ? null : rounded(row.income_rub - row.ozon_fees_rub),
      allocated_ad_rub: allocated, receipt_rub: receipt, receipt_cny: receiptCny, profit_cny: profit,
      margin_pct: profit != null && sales > 0 && base.summary.exchange_rate ? rounded(profit / (sales * base.summary.exchange_rate) * 100) : null,
      advertising_state: adState, allocation_date: otherClickMonth ? null : date, allocation_order_count: share?.count ?? null, low_income: sales != null && sales < 100,
      product_quantity: metadata.get(row.posting_number)?.products?.reduce((n, p) => n + Number(p.quantity || 0), 0) ?? null,
    };
  });
  const summarize = (items, key = 'total', label = base.summary.month) => {
    const known = items.filter((row) => row.profit_cny != null), missingAds = items.filter((row) => row.allocated_ad_rub == null).length;
    const orderAds = total(items, 'advertising_rub'), clickAds = completeTotal(items, 'allocated_ad_rub');
    const unverifiedOrderAds = items.filter((row) => row.advertising_rub == null).length;
    const rubReceipts = items.filter((row) => row.receipt_rub != null), cnyReceipts = items.filter((row) => row.receipt_cny != null);
    return { ...base.summary, id: `${base.summary.month}:${key}`, group: key, label, is_group: key !== 'total', orders: items.length,
      normal_orders: items.filter((r) => r.order_type !== 'WHD订单').length, whd_orders: items.filter((r) => r.order_type === 'WHD订单').length,
      income_rub: total(items, 'income_rub'), ozon_fees_rub: total(items, 'ozon_fees_rub'), purchase_cny: total(items, 'purchase_cny'), label_cny: total(items, 'label_cny'),
      advertising_rub: clickAds == null ? null : rounded(orderAds + clickAds), allocated_ad_rub: clickAds,
      order_ad_rub: orderAds, missing_order_advertising: unverifiedOrderAds,
      receipt_rub: completeTotal(items, 'receipt_rub'), receipt_cny: completeTotal(items, 'receipt_cny'),
      known_receipt_rub: rubReceipts.length || !items.length ? total(rubReceipts, 'receipt_rub') : null,
      known_receipt_cny: cnyReceipts.length || !items.length ? total(cnyReceipts, 'receipt_cny') : null,
      missing_receipt_rub: items.length - rubReceipts.length, missing_receipt_cny: items.length - cnyReceipts.length,
      profit_cny: known.length === items.length && !unverifiedOrderAds && (!byAccrualMonth || key !== 'total' || orderAdsChecked && !adsWithoutFinance.size && !unmatched.length && !unallocated.length && !base.summary.pending_rows && !base.summary.unresolved_parents) ? total(known, 'profit_cny') : null,
      known_cost_profit_cny: known.length ? total(known, 'profit_cny') : items.length ? null : 0,
      profit_orders: known.length, profit_excluded_orders: items.length - known.length,
      missing_purchase: items.filter((r) => r.purchase_cny == null).length, missing_metadata: items.filter((r) => r.metadata_missing).length,
      missing_advertising: missingAds, pending_rows: items.filter((r) => r.pending_positive || r.pending_negative).length,
      income_unknown_orders: items.filter((r) => r.income_rub == null).length, low_income_orders: items.filter((r) => r.low_income).length,
      advertising_source: 'performance-daily', business_timezone: timezone,
      unresolved_parents: key === 'total' ? base.summary.unresolved_parents : 0,
    };
  };
  const summary = summarize(rows);
  summary.children = Object.entries(SETTLEMENT_GROUPS).map(([key, label]) => summarize(rows.filter((row) => settlementGroup(row) === key), key, label)).filter((g) => g.group !== 'other' || g.orders);
  summary.unallocated_ad_days = unallocated.length;
  if (byAccrualMonth) {
    summary.order_ad_report_verified = orderAdsChecked;
    summary.unmatched_order_ad_rows = unmatched.length;
    summary.unmatched_order_ad_rub = unmatched.reduce((sum, entry) => sum + entry.cents, 0) / 100;
    summary.ad_without_finance_orders = adsWithoutFinance.size;
    summary.ad_without_finance_rub = [...adsWithoutFinance.values()].reduce((sum, cents) => sum + cents, 0) / 100;
  }
  return { ...base, rows, summary, advertising: { configured, timezone, unallocated,
    missing_days: [...new Set(rows.filter((r) => r.allocated_ad_rub == null).map((r) => r.allocation_date).filter(Boolean))] } };
}

const SETTLEMENT_GROUPS = { delivered: '正常签收订单', cancelled: '取消订单', whd: 'WHD订单', other: '其他状态订单' };
function settlementGroup(row) {
  if (row.order_type === 'WHD订单') return 'whd';
  if (row.raw_status === 'delivered') return 'delivered';
  return row.raw_status.startsWith('cancelled') ? 'cancelled' : 'other';
}

export function settlementExceptions(report, group, kind) {
  if (group !== 'total' && !Object.hasOwn(SETTLEMENT_GROUPS, group)) throw fail('未知订单分组');
  if (kind === 'unresolved') {
    if (group !== 'total') throw fail('未匹配流水仅属于月度合计');
    return (report.unresolved || report.pending.filter((entry) => !entry.postings.length)).slice().sort((a, b) => a.date.localeCompare(b.date) || a.accrual_id.localeCompare(b.accrual_id));
  }
  const filters = {
    receipt_rub: (row) => row.receipt_rub == null,
    receipt_cny: (row) => row.receipt_cny == null,
    pending: (row) => row.pending_positive || row.pending_negative,
    ads: (row) => row.allocated_ad_rub == null,
    order_ads: (row) => row.advertising_rub == null,
    purchase: (row) => row.purchase_cny == null,
    metadata: (row) => row.metadata_missing,
  };
  if (!Object.hasOwn(filters, kind)) throw fail('未知核对类型');
  return report.rows.filter((row) => (group === 'total' || settlementGroup(row) === group) && filters[kind](row));
}

export function filterReportRows(rows, params = {}) {
  let postings = null;
  if (params.posting_numbers !== undefined) {
    const numbers = params.posting_numbers;
    if (!Array.isArray(numbers) || !numbers.length || numbers.length > 5000) throw fail('批量订单号须为 1 至 5000 个');
    if (numbers.some((number) => typeof number !== 'string' || number.length > 64 || !/^\d+-\d+-\d+$/.test(number))) throw fail('批量筛选需要完整订单号');
    postings = new Set(numbers);
  }
  const catalog = new Map(REPORT_FIELDS.map((field) => [field.key, field]));
  let rules = [];
  try { rules = typeof params.filters === 'string' ? JSON.parse(params.filters) : params.filters || []; }
  catch { throw fail('筛选条件格式无效'); }
  if (!Array.isArray(rules) || rules.length > 30) throw fail('最多支持30条筛选条件');
  const tests = rules.map((rule) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw fail('筛选条件格式无效');
    const field = catalog.get(rule.field), op = rule.op;
    if (!field || !['empty','not_empty','eq','ne','gt','gte','lt','lte','between','contains','not_contains'].includes(op)) throw fail('筛选字段或操作无效');
    if (op === 'empty' || op === 'not_empty') return (row) => (row[field.key] == null || row[field.key] === '') === (op === 'empty');
    const value = rule.value;
    if (value == null || typeof value === 'boolean' || Array.isArray(value) || typeof value === 'object' || String(value).length > 300) throw fail('筛选值无效');
    if (field.type === 'number') {
      const number = (v) => { if (v === '' || v == null || typeof v === 'boolean' || !Number.isFinite(Number(v)) || Math.abs(Number(v)) > 1e12) throw fail('金额筛选值无效'); return Number(v); };
      const lower = number(value), upper = op === 'between' ? number(rule.value2) : null;
      if (op === 'between' && lower > upper) throw fail('区间下限不能大于上限');
      const compare = { eq: (x) => x === lower, ne: (x) => x !== lower, gt: (x) => x > lower, gte: (x) => x >= lower, lt: (x) => x < lower, lte: (x) => x <= lower, between: (x) => x >= lower && x <= upper }[op];
      if (!compare) throw fail('金额筛选操作无效');
      return (row) => row[field.key] != null && compare(row[field.key]);
    }
    if (field.type === 'date') {
      const valid = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
      if (!valid(value) || op === 'between' && (!valid(rule.value2) || value > rule.value2)) throw fail('日期筛选范围无效');
      const compare = { eq: (s) => s === value, gt: (s) => s > value, gte: (s) => s >= value, lt: (s) => s < value, lte: (s) => s <= value, between: (s) => s >= value && s <= rule.value2 }[op];
      if (!compare) throw fail('日期筛选操作无效');
      return (row) => { const date = field.key === 'ordered_at' ? businessDate(row.ordered_at, 'Asia/Shanghai') : row[field.key]; return date != null && compare(date); };
    }
    const text = String(value).toLocaleLowerCase();
    const compare = { contains: (s) => s.includes(text), not_contains: (s) => !s.includes(text), eq: (s) => s === text, ne: (s) => s !== text }[op];
    if (!compare) throw fail('文本筛选操作无效');
    return (row) => row[field.key] != null && compare(String(row[field.key]).toLocaleLowerCase());
  });
  const search = String(params.search || '').trim().toLowerCase();
  const filtered = rows.filter((row) => (!postings || postings.has(row.posting_number))
    && (!search || row.posting_number.toLowerCase().includes(search))
    && (!params.status || (params.status === 'cancelled' ? row.raw_status.startsWith('cancelled') : row.raw_status === params.status))
    && (!params.order_type || row.order_type === params.order_type) && (params.low_income !== '1' || row.low_income)
    && (params.missing_cost !== '1' || row.purchase_cny == null)
    && (params.unsettled !== '1' || row.order_settled_date == null)
    && tests.every((test) => test(row)));
  const key = catalog.has(params.sort) ? params.sort : 'ordered_at', direction = params.direction === 'desc' ? -1 : 1;
  return filtered.sort((a, b) => a[key] == null ? (b[key] == null ? 0 : 1) : b[key] == null ? -1
    : direction * (typeof a[key] === 'number' ? a[key] - b[key] : String(a[key]).localeCompare(String(b[key]))));
}
