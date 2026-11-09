// 经营分析接口自检：在测试库的临时 schema 里跑完整链路（不碰真实数据）
// 用法：STATISTICS_TEST_DATABASE_URL=postgres://... node tests/test_business_analysis.mjs
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { createBusinessAnalysis } from '../lib/business-analysis.js';

const url = process.env.STATISTICS_TEST_DATABASE_URL;
if (!url) {
  console.log('SKIP business analysis integration: STATISTICS_TEST_DATABASE_URL is not configured');
  process.exit(0);
}
if (!new URL(url).pathname.includes('test')) throw new Error('Refusing a non-test database');
const schema = 'biz_check_' + crypto.randomBytes(5).toString('hex');
const admin = new Pool({ connectionString: url, max: 2 });
const fails = [];
const ok = (label, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra ? ' :: ' + extra : '')); if (!cond) fails.push(label); };

await admin.query(`CREATE SCHEMA ${schema}`);
const db = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 4 });
try {
  await db.query(`CREATE TABLE app_users(id uuid primary key, username text);
    CREATE TABLE app_stores(id uuid primary key, user_id uuid, name text, platform text, active boolean default true);
    CREATE TABLE app_exchange_rates(rate numeric, base_currency text, quote_currency text, effective_at timestamptz default now());`);
  const userId = crypto.randomUUID(), ozonStoreId = crypto.randomUUID();
  await db.query('INSERT INTO app_users VALUES($1,$2)', [userId, 'tester']);
  await db.query("INSERT INTO app_stores VALUES($1,$2,'快乐星期五','ozon',true)", [ozonStoreId, userId]);
  await db.query("INSERT INTO app_exchange_rates(rate,base_currency,quote_currency) VALUES(0.1,'RUB','CNY')");

  const statistics = {
    loadData: async () => ({ rate: 0.1 }),
    settlementSummary: () => ([
      { month: '2026-03', is_group: false, income_rub: 1000, advertising_rub: 100, ozon_fees_rub: -200, sales_cny: 100, profit_cny: -10, orders: 5 },
      { month: '2026-03', is_group: true, group: 'delivered', sales_cny: 70 },
      { month: '2026-03', is_group: true, group: 'cancelled', sales_cny: 30 },
      { month: '2026-03', is_group: true, income_rub: 99999 },
      { month: '2025-03', is_group: false, income_rub: 7777 },
    ]),
  };
  const biz = createBusinessAnalysis({ db, statistics });
  await biz.init();

  const boot = await biz.bootstrap(userId);
  ok('初始化：3 个经营主体', boot.entities.length === 3, boot.entities.map((e) => e.name).join('/'));
  ok('初始化：一级分类 8 条（新结构）', boot.categories.length === 8, String(boot.categories.length));
  const chao = boot.entities.find((e) => e.name === '超'), bao = boot.entities.find((e) => e.name === '宝');

  const etsy = await biz.saveStore(userId, { name: '超的 Etsy 店', platform: 'etsy', entity_id: chao.id });
  ok('新建 Etsy 店铺', !!etsy.id);
  const oz = await biz.saveStore(userId, { name: '快乐星期五', platform: 'ozon', entity_id: bao.id, ozon_store_id: ozonStoreId });
  ok('绑定 Ozon 店铺', oz.ozon_store_id === ozonStoreId);
  let dupErr = '';
  try { await biz.saveStore(userId, { name: '重复绑定', platform: 'ozon', entity_id: bao.id, ozon_store_id: ozonStoreId }); }
  catch (e) { dupErr = e.message; }
  ok('同一 Ozon 店铺不可重复绑定', dupErr.includes('已经挂在'), dupErr);

  await biz.saveEtsyMonth(userId, { biz_store_id: etsy.id, month: '2026-01', revenue_cny: 10000, ad_cny: 1000, fee_cny: 500 });
  await biz.saveEtsyMonth(userId, { biz_store_id: etsy.id, month: '2026-01', revenue_cny: 12000, ad_cny: 1000, fee_cny: 500 });
  const etsyRows = await biz.listEtsyMonths(userId, 2026);
  ok('Etsy 月录入可覆盖更新', etsyRows.length === 1 && Number(etsyRows[0].revenue_cny) === 12000, JSON.stringify(etsyRows.map((r) => [r.month, r.revenue_cny])));

  // 总览的人工月度数据按「主体 + 平台」存，不依赖店铺档案
  await biz.saveManualMonth(userId, { entity_id: chao.id, platform: 'etsy', month: '2026-01', revenue_cny: 10000, ad_cny: 1000, fee_cny: 500 });
  await biz.saveManualMonth(userId, { entity_id: chao.id, platform: 'etsy', month: '2026-01', revenue_cny: 12000, ad_cny: 1000, fee_cny: 500 });
  const manualRows = await biz.listManualMonths(userId, 2026, { entity_id: chao.id, platform: 'etsy' });
  ok('手工月度可覆盖更新', manualRows.length === 1 && manualRows[0].revenue_cny === 12000, JSON.stringify(manualRows));

  const ov = await biz.overview(userId, 2026);
  const chaoOut = ov.entities.find((e) => e.name === '超');
  const baoOut = ov.entities.find((e) => e.name === '宝');
  const chaoEtsy = chaoOut.platforms.find((p) => p.platform === 'etsy');
  const jan = chaoEtsy.months.find((m) => m.month === '2026-01');
  ok('总览·Etsy 月份数据（无店铺档案也有数）', jan.revenue_cny === 12000 && jan.ad_cny === 1000 && jan.fee_cny === 500 && jan.profit_cny === 10500, JSON.stringify(jan));
  ok('总览·Etsy 平台层汇总', chaoEtsy.totals.profit_cny === 10500, JSON.stringify(chaoEtsy.totals));
  const ozStore = baoOut.platforms.find((p) => p.platform === 'ozon').stores[0];
  const mar = ozStore.months.find((m) => m.month === '2026-03');
  ok('总览·Ozon 走月结口径并跳过分组行/跨年行', mar.ad_cny === 10 && mar.fee_cny === 20 && mar.profit_cny === -10 && mar.orders === 5, JSON.stringify(mar));
  ok('总览·Ozon 收入 = 毛利 + 广告（即 销售−代扣−采购−贴单）', mar.revenue_cny === 0 && mar.revenue_cny === mar.profit_cny + mar.ad_cny, JSON.stringify({ revenue: mar.revenue_cny, profit: mar.profit_cny, ad: mar.ad_cny }));
  ok('总览·合计与毛利率', chaoOut.totals.profit_cny === 10500 && ov.totals.revenue_cny === 12000, JSON.stringify(ov.totals));

  // 跨年区间（经营总览从 2025-08 排到当前月，要一次取两年）
  const ovRange = await biz.overview(userId, [2025, 2026]);
  const rangeGroup = ovRange.entities.find((e) => e.name === '超').platforms.find((p) => p.platform === 'etsy');
  ok('总览·跨年区间返回 24 个月', rangeGroup.months.length === 24
    && rangeGroup.months[0].month === '2025-01' && rangeGroup.months[23].month === '2026-12',
  JSON.stringify({ len: rangeGroup.months.length, first: rangeGroup.months[0]?.month, last: rangeGroup.months.at(-1)?.month }));
  ok('总览·跨年区间合计含 Etsy 数据', rangeGroup.totals.revenue_cny === 12000, JSON.stringify(rangeGroup.totals));
  ok('总览·单年入参仍兼容', ov.year === 2026 && ov.years[0] === 2026, JSON.stringify({ year: ov.year, years: ov.years }));

  const rows = [
    { date: '2026-02-01', direction: '支出', amount: 1200, category1: '成本', store: '快乐星期五', counterparty: '顺丰', note: '2月运费' },
    { date: '2026-02-03', direction: '收入', amount: 8600, category1: '销售回款', store: '超的 Etsy 店', counterparty: 'Etsy', note: '' },
    { date: '2026-02-05', direction: '支出', amount: 300, category1: '', counterparty: '某供应商', note: '待判断' },
    { date: '2026-02-06', direction: '支出', amount: -5, category1: '其他' },
    { date: '2026/02/07', direction: '支出', amount: 88, category1: '成本' },
    { date: '2026-02-08', direction: '支出', amount: 66, category1: '不存在的分类' },
  ];
  const imp = await biz.importCashflow(userId, { source_file: 'test.xlsx', rows });
  ok('导入：合法 5 行入库（含 2026/2/7 写法），2 行报错', imp.inserted === 5 && imp.errors.length === 2, JSON.stringify({ inserted: imp.inserted, skipped: imp.skipped, errors: imp.errors.map((e) => e.line) }));
  ok('导入：待分类 2 行（空分类 + 未知分类）', imp.pending === 2, String(imp.pending));
  const imp2 = await biz.importCashflow(userId, { source_file: 'test.xlsx', rows });
  ok('重复导入自动跳过', imp2.inserted === 0 && imp2.skipped === 5, JSON.stringify({ inserted: imp2.inserted, skipped: imp2.skipped }));

  const pending = await biz.listCashflow(userId, { year: 2026, status: 'pending' });
  ok('明细·待分类筛选', pending.total === 2, String(pending.total));
  ok('明细·待分类合计（300+66）', pending.totals.income === 0 && Number(pending.totals.expense) === 366, JSON.stringify(pending.totals));
  const all = await biz.listCashflow(userId, { year: 2026 });
  const incomeRow = all.rows.find((r) => r.direction === 'income');
  const storeRow = all.rows.find((r) => r.counterparty === '顺丰');
  ok('明细·按店铺名自动挂主体/店铺', incomeRow.entity_id === chao.id && storeRow.entity_id === bao.id && storeRow.biz_store_id === oz.id,
    JSON.stringify({ income: incomeRow.entity_id === chao.id, store: storeRow.entity_id === bao.id }));

  const target = pending.rows.find((r) => r.counterparty === '某供应商');
  await biz.updateCashflow(userId, target.id, { category1: '原料采购', entity_id: chao.id });
  const after = await biz.listCashflow(userId, { year: 2026, status: 'pending' });
  ok('手动分类后离开待分类', after.total === 1, String(after.total));

  const bulk = await biz.bulkUpdateCashflow(userId, { ids: after.rows.map((r) => r.id), category1: '其他', biz_store_id: etsy.id });
  ok('批量改分类', bulk.updated === 1, JSON.stringify(bulk));


  // ── 支付宝小荷包格式：交易说明 + 收入/支出列 + 操作人 ──
  const wallet = [
    { date: '2026-04-02', description: '安心攒活期收益', note: '', income: 0.21, expense: 0, operator: '' },
    { date: '2026-04-03', description: '转入', note: 'OZon回款', income: 19951.62, operator: '超' },
    { date: '2026-04-04', description: '转出到余额', note: '', expense: 1000, operator: '宝' },
    { date: '2026-04-05', description: '全款交易：测试商品', note: '', expense: 88, operator: '宝' },
    { date: '2026-04-06', description: '收钱码收款', note: '扫地机器人', expense: 1200, operator: '宝' },
    { date: '2026-04-07', description: '转出', note: '11月补贴', expense: 1000, operator: '宝' },
    { date: '2026-04-08', description: '退款-商户单号XP1', note: '', income: 50, operator: '宝' },
    { date: '2026-04-09', description: '某某未知消费', note: '', expense: 30, operator: '孙' },
    { date: '2026-04-10', description: '转入', note: '借用2万', income: 20000, operator: '超' },
    { date: '2026-04-11', description: '转入', note: '注资', income: 5000, operator: '超' },
    { date: '2026-04-12', description: '汉堡王(厦门软件园店)外卖订单', note: '', expense: 154.9, operator: '宝' },
    { date: '2026-04-13', description: '荔枝ai自动化选品工具ozon', note: '', expense: 29.4, operator: '宝' },
    { date: '2026-04-15', description: '订单号：5100374558190084096', note: '递四方充值', expense: 1000, operator: '宝' },
    { date: '2026-04-17', description: '巴士充值', note: '', expense: 2000, operator: '宝' },
    { date: '2026-04-19', description: '小天鹅10kg家用全自动滚筒洗衣机', note: '', expense: 909, operator: '宝' },
    { date: '2026-04-20', description: '小米智能门锁NFC卡 适用于支持NFC功能的小米门锁', note: '', expense: 300, operator: '宝' },
    { date: '2026-04-18', description: '转账', note: '燕文', expense: 1500, operator: '超' },
    { date: '2026-04-16', description: '全款交易：快递袋加厚防水自封袋', note: '', expense: 80, operator: '宝' },
    { date: '2026-04-14', description: '退款-商户单号XP2026041400001', note: '', income: 100, operator: '宝' },
    { date: '2026-04-14', description: '已退款 - 商户单号XP2026041400001', note: '', expense: 100, operator: '宝' },
    { date: '2026-04-21', description: '转入', note: 'TK保证金', income: 3460, operator: '超' },
    { date: '2026-04-22', description: '转入', note: '帮cc寄', income: 200, operator: '宝' },
    { date: '2026-04-23', description: '转入', note: '打烊', income: 195, operator: '宝' },
    { date: '2026-04-24', description: '转入', note: 'GPt', income: 135, operator: '超' },
    { date: '2026-04-25', description: '转入', note: '卖My5', income: 100, operator: '超' },
    { date: '2026-04-26', description: '转入', note: '快递袋退款', income: 80, operator: '宝' },
    { date: '2026-04-27', description: '转账', note: '', expense: 500, operator: '超' },
    { date: '2026-04-28', description: '转出到余额', note: '宝子美国店刷单', expense: 391, operator: '超' },
    { date: '2026-04-29', description: '转出到银行卡', note: '权益', expense: 1668, operator: '超' },
  ];
  const pv = await biz.previewCashflow(userId, { rows: wallet, source_file: 'alipay.xlsx' });
  const rowOf = (desc) => pv.rows.find((r) => r.description === desc) || {};
  const rowOfNote = (note) => pv.rows.find((r) => r.note === note) || {};
  const catOf = (desc) => rowOf(desc).category1;
  ok('预览·安心攒收益 → 销售回款/利息收入', catOf('安心攒活期收益') === '销售回款' && rowOf('安心攒活期收益').category2 === '利息收入', JSON.stringify(rowOf('安心攒活期收益')));
  ok('预览·转入OZon回款 → 销售回款', catOf('转入') === '销售回款', catOf('转入'));
  ok('预览·转出到余额 → 内部划转', catOf('转出到余额') === '内部划转', catOf('转出到余额'));
  ok('预览·全款交易 → 原料采购', catOf('全款交易：测试商品') === '原料采购', catOf('全款交易：测试商品'));
  ok('预览·收钱码(扫地机器人) → 原料采购', catOf('收钱码收款') === '原料采购', catOf('收钱码收款'));
  ok('预览·转出补贴 → 工资奖金', catOf('转出') === '工资奖金', catOf('转出'));
  ok('预览·退款 → 采购退款/退款', catOf('退款-商户单号XP1') === '采购退款', catOf('退款-商户单号XP1'));
  ok('预览·未知商品名按用户口径归采购', catOf('某某未知消费') === '原料采购', catOf('某某未知消费'));
  ok('预览·餐饮外卖 → 运营激励/团建费用', catOf('汉堡王(厦门软件园店)外卖订单') === '运营激励' && rowOf('汉堡王(厦门软件园店)外卖订单').category2 === '团建费用', JSON.stringify(rowOf('汉堡王(厦门软件园店)外卖订单')));
  ok('预览·软件订阅 → 成本/软件费用', catOf('荔枝ai自动化选品工具ozon') === '成本'
    && rowOf('荔枝ai自动化选品工具ozon').category2 === '软件费用', JSON.stringify(rowOf('荔枝ai自动化选品工具ozon')));
  ok('预览·操作人推主体', rowOf('转入').entity_name === '超' && rowOf('收钱码收款').entity_name === '宝',
    JSON.stringify(pv.rows.map((r) => [r.operator, r.entity_name])));
  const borrow = pv.rows.find((r) => r.note === '借用2万'), capital = pv.rows.find((r) => r.note === '注资');
  ok('预览·借用 → 股东权益/借款', borrow && borrow.category1 === '股东权益' && borrow.category2 === '借款', borrow && borrow.category1);
  ok('预览·注资 → 股东权益/注资', capital && capital.category1 === '股东权益' && capital.category2 === '注资', capital && capital.category1);

  ok('预览·洗衣机代购 → 内部划转（不计收支）', rowOf('小天鹅10kg家用全自动滚筒洗衣机').category1 === '内部划转', rowOf('小天鹅10kg家用全自动滚筒洗衣机').category1);
  ok('预览·门锁NFC卡 → 原料采购', rowOf('小米智能门锁NFC卡 适用于支持NFC功能的小米门锁').category1 === '原料采购', rowOf('小米智能门锁NFC卡 适用于支持NFC功能的小米门锁').category1);
  ok('预览·大类正确（销售回款→销售类）', rowOf('转入').category_group === '销售类', rowOf('转入').category_group);
  ok('预览·巴士充值 → 成本/贴单费', rowOf('巴士充值').category1 === '成本' && rowOf('巴士充值').category2 === '贴单费', JSON.stringify(rowOf('巴士充值')));
  ok('预览·燕文转账 → 成本/物流费用', rowOf('转账').category1 === '成本' && rowOf('转账').category2 === '物流费用', rowOf('转账').category1);
  ok('预览·递四方充值 → 成本/物流费用', rowOf('订单号：5100374558190084096').category1 === '成本', rowOf('订单号：5100374558190084096').category1);
  ok('预览·快递袋（包装耗材）仍是原料采购', rowOf('全款交易：快递袋加厚防水自封袋').category1 === '原料采购', rowOf('全款交易：快递袋加厚防水自封袋').category1);
  const wImp = await biz.importCashflow(userId, { source_file: 'alipay.xlsx', rows: wallet });
  ok('预览·TK保证金 → 销售回款/其他收入', rowOfNote('TK保证金').category1 === '销售回款' && rowOfNote('TK保证金').category2 === '其他收入', JSON.stringify(rowOfNote('TK保证金')));
  ok('预览·帮cc寄 → 成本/物流费用（收入侧冲抵）', rowOfNote('帮cc寄').category1 === '成本'
    && rowOfNote('帮cc寄').category2 === '物流费用' && rowOfNote('帮cc寄').direction === 'income', JSON.stringify(rowOfNote('帮cc寄')));
  ok('预览·打烊 → 销售回款/其他收入', rowOfNote('打烊').category1 === '销售回款' && rowOfNote('打烊').category2 === '其他收入', JSON.stringify(rowOfNote('打烊')));
  ok('预览·GPt → 成本/软件费用', rowOfNote('GPt').category1 === '成本' && rowOfNote('GPt').category2 === '软件费用', JSON.stringify(rowOfNote('GPt')));
  ok('预览·卖My5 → 销售回款/其他收入', rowOfNote('卖My5').category1 === '销售回款' && rowOfNote('卖My5').category2 === '其他收入', JSON.stringify(rowOfNote('卖My5')));
  ok('预览·快递袋退款 → 采购退款（冲减采购）', rowOfNote('快递袋退款').category1 === '采购退款', rowOfNote('快递袋退款').category1);
  ok('预览·其他收入归销售类', rowOfNote('TK保证金').category_group === '销售类', rowOfNote('TK保证金').category_group);
  const blankTransfer = pv.rows.find((r) => r.description === '转账' && !r.note);
  ok('预览·转账无备注 → 成本/物流费用', blankTransfer && blankTransfer.category1 === '成本' && blankTransfer.category2 === '物流费用', JSON.stringify(blankTransfer));
  ok('预览·宝子美国店刷单 → 成本/其他费用', rowOfNote('宝子美国店刷单').category1 === '成本' && rowOfNote('宝子美国店刷单').category2 === '其他费用', JSON.stringify(rowOfNote('宝子美国店刷单')));
  ok('预览·权益 → 工资奖金/工资', rowOfNote('权益').category1 === '工资奖金' && rowOfNote('权益').category2 === '工资', JSON.stringify(rowOfNote('权益')));
  ok('预览·成本并入经营类', rowOfNote('宝子美国店刷单').category_group === '经营类', rowOfNote('宝子美国店刷单').category_group);
  ok('小荷包格式导入 27 行、退款成对 2 行自动冲抵', wImp.inserted === 27 && wImp.cancelled === 2 && wImp.errors.length === 0, JSON.stringify({ inserted: wImp.inserted, cancelled: wImp.cancelled, errors: wImp.errors }));
  const apr = await biz.cashflowSummary(userId, 2026);
  const april = apr.monthly.find((m) => m.month === '2026-04');
  // 口径变更（2026-11-09 用户确认）：转出到余额/银行卡属于真实支出，计入合计；transfer_out 仅作参考列
  ok('汇总·内部划转计入支出', Number(april.expense) === 11850.3 && Number(april.transfer_out) === 1909, JSON.stringify(april));

  const groups = await biz.cashflowSummary(userId, 2026);
  ok('汇总·按大类聚合（采购/销售/经营，成本已并入经营）', groups.byGroup.some((g) => g.category_group === '采购类')
    && groups.byGroup.some((g) => g.category_group === '销售类') && groups.byGroup.some((g) => g.category_group === '经营类')
    && !groups.byGroup.some((g) => g.category_group === '成本类'),
    JSON.stringify(groups.byGroup.map((g) => [g.category_group, g.expense, g.income])));
  const sum = await biz.cashflowSummary(userId, 2026);
  const feb = sum.monthly.find((m) => m.month === '2026-02');
  ok('汇总·月度收支净额', feb.income === 8600 && Number(feb.expense) === 1654 && feb.count === 5, JSON.stringify(feb));
  ok('汇总·分类构成按新结构分组', sum.byCategory.length === 10, JSON.stringify(sum.byCategory.map((c) => [c.category1, c.total])));
  ok('汇总·无待分类（未知商品名归采购）', sum.pending === 0, String(sum.pending));

  console.log('\nRESULT:', fails.length ? 'FAILED → ' + fails.join(' | ') : 'ALL PASS');
  if (fails.length) process.exitCode = 1;
} catch (e) {
  console.log('EXCEPTION:', e.message, '\n', e.stack?.split('\n').slice(0, 4).join('\n'));
  process.exitCode = 1;
} finally {
  await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
}
