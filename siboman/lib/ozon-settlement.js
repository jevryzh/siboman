const DAY_MS = 86400000;
export const ADVERTISING_TYPES = new Set([3, 4, 19, 23, 33, 41, 49, 54, 87, 130]);
export const STATUS_NAMES = {
  delivered: '已签收', cancelled: '已取消', cancelled_from_split_pending: '已取消',
  delivering: '运输中', awaiting_packaging: '等待备货', awaiting_deliver: '等待发运',
  awaiting_approve: '等待确认', acceptance_in_progress: '接收中', driver_pickup: '等待揽收',
  sent_by_seller: '卖家已发货', arbitrage: '有争议', client_arbitration: '买家争议', returned: '已退货',
};
const CANCELLATION_NAMES = new Map([
  ['Покупатель отказался при вручении: товар не подошел', '买家收货时拒收：商品不合适'],
  ['Покупатель отказался при вручении: недоволен качеством товара', '买家收货时拒收：不满意商品质量'],
  ['Покупатель не забрал заказ', '买家未领取订单'],
  ['Не удалось доставить заказ', '配送失败，未能送达'],
  ['Покупатель отменил заказ: нашел дешевле', '买家取消：找到更便宜的商品'],
  ['Покупатель отменил заказ: не устроил срок доставки', '买家取消：不满意配送时效'],
  ['Покупатель отменил заказ', '买家取消订单'],
]);

export function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function shanghaiDate(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}

// Shanghai's early morning can still be the previous date at Ozon.
export function financialDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function monthBounds(month) {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(String(month))) throw fail('月份格式应为 YYYY-MM');
  const start = `${month}-01`;
  const next = new Date(`${start}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { start, end: new Date(next.getTime() - DAY_MS).toISOString().slice(0, 10) };
}

export function datesBetween(start, end) {
  const days = [];
  for (let time = Date.parse(`${start}T00:00:00Z`); time <= Date.parse(`${end}T00:00:00Z`); time += DAY_MS) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

export function moneyCents(value) {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw fail('金额必须是最多两位小数的有效数字');
  const result = (Number(match[2]) * 100 + Number((match[3] || '').padEnd(2, '0'))) * (match[1] ? -1 : 1);
  if (!Number.isSafeInteger(result)) throw fail('金额超出支持范围');
  return result;
}
export const rounded = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const rub = (value) => value / 100;
const completePosting = (value) => /^\d+-\d+-\d+$/.test(value || '');
const parentPosting = (value) => /^\d+-\d+$/.test(value || '');
export const parentOf = (value) => String(value || '').split('-').slice(0, 2).join('-');

export function feeTypes(entry) {
  if (entry.non_item_fee) return [Number(entry.non_item_fee.type_id)];
  return (entry.item_fees?.fees || []).flatMap((product) => product.fees.map((fee) => Number(fee.type_id)));
}

export function isFormalAccrual(entry) {
  if (!completePosting(entry.unit_number)) return false;
  const types = feeTypes(entry);
  return !types.length || !types.every((id) => id === 1);
}

export function cancellationReason(order) {
  if (!String(order.status || '').startsWith('cancelled')) return null;
  const raw = order.cancellation?.cancel_reason;
  if (!raw) return order.cancel_reason_id != null ? `取消原因待补充（代码 ${order.cancel_reason_id}）` : '取消原因待补充';
  const stage = order.cancellation.cancelled_after_ship;
  return (CANCELLATION_NAMES.get(raw) || raw) + (typeof stage === 'boolean' ? (stage ? '（发货后）' : '（发货前）') : '');
}

export function normalizeOrder(item, schema) {
  const posting = String(item.posting_number || '');
  if (!completePosting(posting)) throw fail('Ozon 返回的订单号无效', 502);
  return {
    posting_number: posting, order_number: String(item.order_number || parentOf(posting)), schema,
    status: item.status || '', substatus: item.substatus || '',
    created_at: item.created_at || null, in_process_at: item.in_process_at || null,
    cancellation: item.cancellation || null, cancel_reason_id: item.cancel_reason_id ?? null,
    products: (item.products || []).map((p) => ({ sku: String(p.sku), offer_id: p.offer_id || '', quantity: Number(p.quantity) || 0 })),
  };
}

export function validateAccrual(entry, date) {
  if (!/^\d+$/.test(String(entry.accrual_id || ''))) throw fail('应计流水缺少有效 ID', 502);
  if (entry.date !== date || entry.total_amount?.currency !== 'RUB') throw fail('应计流水日期或币种与请求不一致', 502);
  moneyCents(entry.total_amount.amount);
  return { ...entry, accrual_id: String(entry.accrual_id), unit_number: String(entry.unit_number || '') };
}

export function buildSettlementReport({ month, accruals, orders, costs = [], settings = {}, defaultRate = null, coverage = null }) {
  const { start, end } = monthBounds(month);
  const metadata = new Map(orders.map((o) => [o.posting_number, o]));
  const byParent = new Map();
  for (const order of metadata.values()) {
    const parent = parentOf(order.posting_number);
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(order.posting_number);
  }
  const costMap = new Map(costs.map((c) => [c.posting_number, c]));
  const latest = new Map();
  const modes = new Map();
  const seen = new Set();
  for (const entry of accruals) {
    if (seen.has(entry.accrual_id)) throw fail('应计流水 ID 重复', 500);
    seen.add(entry.accrual_id);
    if (entry.posting?.delivery_schema) modes.set(entry.unit_number, entry.posting.delivery_schema);
    if (isFormalAccrual(entry) && entry.date > (latest.get(entry.unit_number) || '')) latest.set(entry.unit_number, entry.date);
  }
  const states = new Map();
  const pending = [], shop = [], ledger = [];
  const state = (posting) => {
    if (!states.has(posting)) states.set(posting, { positive: 0, negative: 0, pending_positive: false, pending_negative: false, entries: 0 });
    return states.get(posting);
  };
  const allocate = (posting, entry, amount, method) => {
    const sum = state(posting);
    sum.positive += Math.max(amount, 0);
    sum.negative += Math.max(-amount, 0);
    sum.entries++;
    const types = entry.posting ? (entry.posting.products || []).flatMap((p) => (p.delivery?.services || []).map((s) => Number(s.type_id))) : feeTypes(entry);
    ledger.push({ posting_number: posting, accrual_id: entry.accrual_id, date: entry.date, amount_rub: rub(amount), method, types: [...new Set(types)] });
  };
  const defer = (entry, amount, postings) => {
    const candidates = [...new Set(postings)];
    pending.push({ accrual_id: entry.accrual_id, date: entry.date, amount_rub: rub(amount), unit_number: entry.unit_number, postings: candidates });
    for (const posting of candidates) {
      if (amount > 0) state(posting).pending_positive = true;
      if (amount < 0) state(posting).pending_negative = true;
    }
  };
  let sourcePositive = 0, sourceNegative = 0;
  for (const entry of accruals) {
    if (entry.date < start || entry.date > end) continue;
    const amount = moneyCents(entry.total_amount.amount);
    sourcePositive += Math.max(amount, 0); sourceNegative += Math.max(-amount, 0);
    const unit = entry.unit_number;
    if (completePosting(unit)) { allocate(unit, entry, amount, '完整订单号'); continue; }
    if (!parentPosting(unit)) {
      const types = feeTypes(entry);
      shop.push({ ...entry, amount_rub: rub(amount), is_advertising: types.length > 0 && types.every((id) => ADVERTISING_TYPES.has(id)) });
      continue;
    }
    const children = byParent.get(unit) || [];
    if (children.length === 1) { allocate(children[0], entry, amount, '唯一主订单号'); continue; }
    const parts = (entry.item_fees?.fees || []).map((part) => ({ sku: String(part.sku), amount: part.fees.reduce((sum, fee) => sum + moneyCents(fee.accrued.amount), 0) }));
    if (!children.length || !parts.length || parts.reduce((sum, p) => sum + p.amount, 0) !== amount || !parts.every((p) => p.amount === 0 || Math.sign(p.amount) === Math.sign(amount))) {
      defer(entry, amount, children); continue;
    }
    let remaining = 0;
    const ambiguous = [];
    for (const part of parts) {
      const candidates = children.filter((id) => (metadata.get(id).products || []).some((p) => String(p.sku) === part.sku));
      if (candidates.length === 1) allocate(candidates[0], entry, part.amount, 'SKU唯一匹配');
      else { remaining += part.amount; ambiguous.push(...(candidates.length ? candidates : children)); }
    }
    if (remaining) defer(entry, remaining, ambiguous);
  }
  const rate = settings.exchange_rate == null ? defaultRate : Number(settings.exchange_rate);
  const validRate = Number.isFinite(rate) && rate > 0 && rate <= 1;
  const rows = [], excluded = [];
  for (const [posting, sum] of states) {
    const settlement = latest.get(posting) || null;
    const order = metadata.get(posting);
    if (!settlement || settlement < start || settlement > end) {
      excluded.push({ posting_number: posting, settled_date: settlement, income_rub: rub(sum.positive), ozon_fees_rub: rub(sum.negative) });
      continue;
    }
    const cost = costMap.get(posting);
    const purchase = cost?.purchase_cny == null ? null : Number(cost.purchase_cny);
    const label = cost?.label_cny == null ? 1.5 : Number(cost.label_cny);
    const income = !sum.positive && sum.pending_positive ? null : rub(sum.positive);
    const fees = !sum.negative && sum.pending_negative ? null : rub(sum.negative);
    const missingMetadata = !order;
    const profitReady = purchase !== null && validRate && !sum.pending_positive && !sum.pending_negative && !missingMetadata && !!coverage?.complete;
    const rawStatus = order?.status || '';
    rows.push({
      posting_number: posting, status: order?.substatus === 'posting_in_pickup_point' ? '待买家取件' : (STATUS_NAMES[rawStatus] || rawStatus || '资料待核对'), raw_status: rawStatus,
      ordered_at: order ? (order.schema === 'fbo' ? (order.created_at || order.in_process_at) : (order.in_process_at || order.created_at)) : null,
      settled_date: settlement, order_type: modes.get(posting) === 'Whd' || order?.schema === 'fbo' ? 'WHD订单' : '正常销售订单',
      cancel_reason: order ? cancellationReason(order) : null, purchase_cny: purchase, label_cny: label,
      income_rub: income, ozon_fees_rub: fees, profit_cny: profitReady ? rounded((income - fees) * rate - purchase - label) : null,
      pending_positive: sum.pending_positive, pending_negative: sum.pending_negative, metadata_missing: missingMetadata,
      version: Number(cost?.version || 0), low_income: income !== null && income < 100,
    });
  }
  rows.sort((a, b) => a.settled_date.localeCompare(b.settled_date) || a.posting_number.localeCompare(b.posting_number));
  const selected = new Set(rows.map((r) => r.posting_number));
  const sum = (key) => rows.reduce((total, row) => total + moneyCents(row[key] ?? 0), 0);
  const advertisingAuto = -shop.filter((r) => r.is_advertising).reduce((total, r) => total + moneyCents(r.total_amount.amount), 0);
  const adManual = settings.advertising_amount == null ? null : Number(settings.advertising_amount);
  const adCny = adManual === null ? (validRate ? rounded(rub(advertisingAuto) * rate) : null) : settings.advertising_currency === 'CNY' ? adManual : validRate ? rounded(adManual * rate) : null;
  const adRub = adManual === null ? rub(advertisingAuto) : settings.advertising_currency === 'RUB' ? adManual : validRate ? rounded(adManual / rate) : null;
  const shopOther = shop.filter((r) => !r.is_advertising).reduce((total, r) => total + moneyCents(r.total_amount.amount), 0);
  const shared = pending.filter((p) => p.postings.some((id) => selected.has(id)));
  const sourceAllocatedPositive = ledger.reduce((n, r) => n + Math.max(moneyCents(r.amount_rub), 0), 0) + pending.reduce((n, r) => n + Math.max(moneyCents(r.amount_rub), 0), 0) + shop.reduce((n, r) => n + Math.max(moneyCents(r.amount_rub), 0), 0);
  const sourceAllocatedNegative = ledger.reduce((n, r) => n + Math.max(-moneyCents(r.amount_rub), 0), 0) + pending.reduce((n, r) => n + Math.max(-moneyCents(r.amount_rub), 0), 0) + shop.reduce((n, r) => n + Math.max(-moneyCents(r.amount_rub), 0), 0);
  if (sourceAllocatedPositive !== sourcePositive || sourceAllocatedNegative !== sourceNegative) throw fail('月度流水未对平，请检查数据', 500);
  const missingPurchase = rows.filter((r) => r.purchase_cny === null).length;
  const missingMetadata = rows.filter((r) => r.metadata_missing).length;
  const unresolvedParents = pending.filter((r) => !r.postings.length).length;
  const ready = rows.length > 0 && validRate && !missingPurchase && !missingMetadata && !shared.length && !unresolvedParents && !!coverage?.complete;
  const knownProfit = validRate && adCny !== null ? rounded((rub(sum('income_rub') - sum('ozon_fees_rub') + shopOther)) * rate - rub(sum('purchase_cny')) - rub(sum('label_cny')) - adCny) : null;
  return {
    rows, pending, shop, excluded, ledger,
    summary: {
      month, orders: rows.length, normal_orders: rows.filter((r) => r.order_type === '正常销售订单').length,
      whd_orders: rows.filter((r) => r.order_type === 'WHD订单').length, income_rub: rub(sum('income_rub')), ozon_fees_rub: rub(sum('ozon_fees_rub')),
      purchase_cny: rub(sum('purchase_cny')), label_cny: rub(sum('label_cny')), exchange_rate: validRate ? rate : null,
      advertising_auto_rub: rub(advertisingAuto), advertising_rub: adRub, advertising_cny: adCny, advertising_source: adManual === null ? 'api' : 'manual',
      other_shop_net_rub: rub(shopOther), profit_cny: ready ? knownProfit : null, known_cost_profit_cny: knownProfit,
      missing_purchase: missingPurchase, missing_metadata: missingMetadata, pending_rows: shared.length,
      unresolved_parents: unresolvedParents,
      low_income_orders: rows.filter((r) => r.low_income).length, income_unknown_orders: rows.filter((r) => r.income_rub === null).length,
      source_positive_rub: rub(sourcePositive), source_negative_rub: rub(sourceNegative), reconciliation_difference_rub: 0,
      latest_formal_cutoff: accruals.reduce((latest, r) => r.date > latest ? r.date : latest, ''), coverage,
      settings_version: Number(settings.version || 0), exchange_rate_override: settings.exchange_rate == null ? null : Number(settings.exchange_rate),
      advertising_amount: adManual, advertising_currency: settings.advertising_currency || 'RUB',
    },
  };
}

export function csvCell(value) {
  const text = value == null ? '' : String(value);
  return `"${(typeof value !== 'number' && /^[=+@\-\t\r]/.test(text) ? "'" : '') + text.replaceAll('"', '""')}"`;
}
