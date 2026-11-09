// 经营分析（店铺结算 → 经营分析）
//
// 业务背景：
//   三个经营主体（超 / 宝 / 孙），各自管自己的店铺（超=Etsy，宝=Ozon「快乐星期五」，孙=暂无）。
//   经营总览要按「人 → 平台 → 店铺 → 月份」看 销售收入 / 广告投放 / 经营利润；
//   资金流水是外部导进来的真实收支，按分类汇总，看不准的行留给人手动选分类。
//
// 口径约定（2026-11-09 与用户确认）：
//   1) Ozon 的销售收入/广告投放/经营利润 **直接复用月结统计**（app_statistics_* + settlementSummary），
//      不另写一套算法，保证和「月结统计」页面数字一致：经营利润 = 结算收入 - 代扣 - 广告 - 采购 - 贴单（毛利）。
//   2) Etsy 没有 API，按月录三项（销售收入 / 广告投放 / 其他费用），直接录人民币，
//      经营利润 = 销售收入 - 广告投放 - 其他费用。
//   3) 资金流水金额一律人民币；导入时分类为空的行标记 pending，等人手动选，选择结果落库（manual_corrected）
//      并可当作分析维度使用。
import crypto from 'node:crypto';
import { fail } from './ozon-settlement.js';

const PREFIX = '/api/biz-analysis';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// 默认经营主体（用户指定：a 超 / b 宝 / c 孙）
const DEFAULT_ENTITIES = ['超', '宝', '孙'];
// 默认分类字典：后期用户可在页面上增删
// 2026-11-09 按用户给定的口径定稿：餐饮外卖→公司福利费用、软件→软件支出、回款→销售回款、
// 注资/借款拆开、补贴激励→经营工资
// 一级分类（大类下的一级）。二级分类在导入时按规则写入 category2。
// 每个名字只登记一次（以前按收支两侧各存一条，下拉框里会出现同名两次）
const DEFAULT_CATEGORIES = {
  expense: ['原料采购', '采购退款', '成本', '工资奖金', '运营激励', '内部划转'],
  income: ['销售回款', '股东权益'],
};
// 大类（一级）：用户口径「采购类 / 销售类 / 成本类 / 经营类」，内部划转归到未分类
const CATEGORY_GROUPS = {
  '采购类': ['原料采购', '采购退款'],
  '销售类': ['销售回款'],
  '经营类': ['成本', '股东权益', '工资奖金', '运营激励'],
  '未分类': ['内部划转'],
};
// 明细里的商品关键词：这些是明确采购的商品名，自动归采购货款
const PRODUCT_HINTS = ['门锁', 'nfc', '脱毛仪', '牙盘', '陀螺', '电池', '宠物店', '手机支架', '斗罗大陆',
  'muji', '无印良品', '洗衣机', 'glamlite', '鬼娃', '华为p60', '禧玛诺', '灵动创想', '孩之宝', 'ninebot', '九号',
  '炫卡斗士', '变形机甲'];

// 暂时用不到的分类：停在隐藏状态，避免下拉框里出现一堆空分类（以后要用再打开）
const HIDDEN_CATEGORIES = ['房租水电', '广告推广', '平台费用', '税费',
  // 三级重构后的一级旧名（已并入「原料采购/经营费用/工资奖金/运营激励/股东权益/团队成本」），只停用不删
  '采购货款', '物流费用', '软件支出', '经营工资', '年终奖', '激励奖励', '股东注资', '股东借款', '公司福利费用'];

// 分类改名/废弃映射：老库里的旧名字迁到新名字，旧分类停用（不删，历史流水还能查到）
const CATEGORY_MIGRATION = [
  ['软件工具', '经营费用'], ['平台回款', '销售回款'], ['人工工资', '工资奖金'], ['物流运费', '经营费用'],
  ['股东投入', '股东权益'], ['生活开支', '团队成本'], ['采购货款', '原料采购'], ['物流费用', '经营费用'],
  ['软件支出', '经营费用'], ['经营工资', '工资奖金'], ['年终奖', '运营激励'], ['激励奖励', '运营激励'],
  ['股东注资', '股东权益'], ['股东借款', '股东权益'], ['公司福利费用', '团队成本'],
];

const SCHEMA = `
-- 经营主体（人）
CREATE TABLE IF NOT EXISTS app_biz_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, name)
);

-- 经营店铺档案：Etsy 店没有接口凭据，单独建档；Ozon 店用 ozon_store_id 关联 app_stores
CREATE TABLE IF NOT EXISTS app_biz_stores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  entity_id UUID REFERENCES app_biz_entities(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'ozon',
  ozon_store_id UUID REFERENCES app_stores(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, name),
  CHECK (platform IN ('etsy','ozon'))
);
-- 一个 Ozon 店铺只能挂到一个经营档案上，否则总览会重复计算
CREATE UNIQUE INDEX IF NOT EXISTS idx_biz_stores_ozon
  ON app_biz_stores(user_id, ozon_store_id) WHERE ozon_store_id IS NOT NULL;

-- 月度录入（人民币，按月一条）：Etsy 只能人工录；Ozon 2026-10 之前的历史也走这里手工补
CREATE TABLE IF NOT EXISTS app_biz_etsy_months (
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  biz_store_id UUID NOT NULL REFERENCES app_biz_stores(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  revenue_cny NUMERIC(16,2) NOT NULL DEFAULT 0,
  ad_cny NUMERIC(16,2) NOT NULL DEFAULT 0,
  fee_cny NUMERIC(16,2) NOT NULL DEFAULT 0,
  -- Ozon 手工历史要单独记退款：月结统计没覆盖到的月份靠它
  refund_cny NUMERIC(16,2) NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, biz_store_id, month),
  CHECK (month ~ '^[0-9]{4}-[0-9]{2}$')
);
ALTER TABLE app_biz_etsy_months ADD COLUMN IF NOT EXISTS refund_cny NUMERIC(16,2) NOT NULL DEFAULT 0;

-- 手工月度数据：按「经营主体 + 平台」存，不依赖店铺档案
-- （Etsy 没有接口也没有店铺档案，直接按人记数；Ozon 2026-10 之前的历史也走这里）
CREATE TABLE IF NOT EXISTS app_biz_manual_months (
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES app_biz_entities(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('etsy','ozon')),
  month TEXT NOT NULL CHECK (month ~ '^[0-9]{4}-[0-9]{2}$'),
  revenue_cny NUMERIC(16,2) NOT NULL DEFAULT 0,
  ad_cny NUMERIC(16,2) NOT NULL DEFAULT 0,
  fee_cny NUMERIC(16,2) NOT NULL DEFAULT 0,
  refund_cny NUMERIC(16,2) NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, entity_id, platform, month)
);

-- 股权行的人工编辑字段（按股东 key 存，目前只有「累计未发放」）
CREATE TABLE IF NOT EXISTS app_biz_equity_holders (
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  holder_key TEXT NOT NULL,
  unpaid TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, holder_key)
);

-- 月度备注：一行一个月，给经营总览的「备注」列用
CREATE TABLE IF NOT EXISTS app_biz_month_notes (
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  month TEXT NOT NULL CHECK (month ~ '^[0-9]{4}-[0-9]{2}$'),
  note TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, month)
);

-- 资金流水分类字典
CREATE TABLE IF NOT EXISTS app_biz_cashflow_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('income','expense')),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE(user_id, direction, name)
);

-- 资金流水：一行 = 一条实际收支
CREATE TABLE IF NOT EXISTS app_biz_cashflow (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  biz_date DATE NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('income','expense')),
  amount_cny NUMERIC(16,2) NOT NULL CHECK (amount_cny >= 0),
  currency TEXT NOT NULL DEFAULT 'CNY',
  -- 支付宝小荷包这类导出没有「对方」，但有「交易说明 + 操作人」：
  -- 说明用来归类（全款交易/商户单号/安心攒收益…），操作人用来推经营主体（超/宝/孙）
  description TEXT NOT NULL DEFAULT '',
  operator TEXT NOT NULL DEFAULT '',
  category1 TEXT NOT NULL DEFAULT '',
  category2 TEXT NOT NULL DEFAULT '',
  entity_id UUID REFERENCES app_biz_entities(id) ON DELETE SET NULL,
  biz_store_id UUID REFERENCES app_biz_stores(id) ON DELETE SET NULL,
  counterparty TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  source_file TEXT NOT NULL DEFAULT '',
  raw JSONB,
  -- 人工改过分类/归属：既要能回溯「原始导入值」，也要能按人工口径做分析
  manual_corrected BOOLEAN NOT NULL DEFAULT FALSE,
  corrected_at TIMESTAMPTZ,
  dedupe_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_biz_cashflow_date ON app_biz_cashflow(user_id, biz_date DESC);
CREATE INDEX IF NOT EXISTS idx_biz_cashflow_category ON app_biz_cashflow(user_id, category1);
-- 退款要能找到对应的商户单号/订单号做冲抵：单独存一列，方便配对和回溯
ALTER TABLE app_biz_cashflow ADD COLUMN IF NOT EXISTS order_no TEXT NOT NULL DEFAULT '';
-- 大类（采购类/销售类/成本类/经营类/未分类）：分类名会变，大类口径相对稳定，单独存一列便于按月汇总
ALTER TABLE app_biz_cashflow ADD COLUMN IF NOT EXISTS category_group TEXT NOT NULL DEFAULT '';
-- 一稿漏了币种列（金额统一人民币，保留列便于以后接外币）：老库补列，不用重建表
ALTER TABLE app_biz_cashflow ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'CNY';
-- 小荷包/支付宝导出特有：交易说明与操作人
ALTER TABLE app_biz_cashflow ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE app_biz_cashflow ADD COLUMN IF NOT EXISTS operator TEXT NOT NULL DEFAULT '';
`;

export function createBusinessAnalysis({ db, statistics = null }) {
  // 本地无 DATABASE_URL 时 server.js 的 db 为 null（和 statistics 模块一样降级启动），
  // 这里不直接抛错，只让相关接口返回「数据库未配置」，避免整机起不来
  const q = (text, values) => {
    if (!db) throw fail('数据库未配置，经营分析不可用', 503);
    return db.query(text, values);
  };

  async function init() {
    if (!db) return;
    await db.query(SCHEMA);
    // 主体/分类按用户懒初始化（ensureUserCatalog）：启动时一次性铺历史用户，
    // 之后新注册的用户在第一次打开经营分析时自动补上，不需要重建表
    await ensureCatalogForAllUsers();
    await migrateCategories();
  }

  // 分类口径调整后，把旧分类名上的历史数据与字典迁到新名字，旧名字只停用不删除
  async function migrateCategories() {
    // 一级分类改名：老名字 → 新结构（成本类并入经营类，销售类合并到「销售回款」）
    const RENAME = [
      ['经营费用', '成本'], ['团队成本', '运营激励'], ['贴单费', '成本'], ['其他费用', '成本'],
      ['其他收入', '销售回款'], ['利息收入', '销售回款'], ['销售收入', '销售回款'], ['其他', '销售回款'],
      ['软件工具', '成本'], ['平台回款', '销售回款'], ['人工工资', '工资奖金'], ['物流运费', '成本'],
      ['采购货款', '原料采购'], ['物流费用', '成本'], ['软件支出', '成本'], ['经营工资', '工资奖金'],
      ['年终奖', '运营激励'], ['激励奖励', '运营激励'], ['股东投入', '股东权益'],
      ['股东注资', '股东权益'], ['股东借款', '股东权益'], ['公司福利费用', '运营激励'], ['生活开支', '运营激励'],
    ];
    for (const [oldName, newName] of RENAME) {
      await q(`UPDATE app_biz_cashflow SET category1=$1 WHERE category1=$2`, [newName, oldName]);
    }

    // 二级分类归一：每个一级只保留固定几个二级
    await q(`UPDATE app_biz_cashflow SET category2='原料采购' WHERE category1='原料采购' AND category2 <> '原料采购'`);
    await q(`UPDATE app_biz_cashflow SET category2='退款' WHERE category1='采购退款' AND category2 <> '退款'`);
    await q(`UPDATE app_biz_cashflow SET category2='销售回款' WHERE category1='销售回款' AND category2 IN ('平台回款','销售收入','')`);
    await q(`UPDATE app_biz_cashflow SET category2='其他收入' WHERE category1='销售回款' AND category2 IN ('TK保证金','卖My账号','其他')`);
    await q(`UPDATE app_biz_cashflow SET category2='利息收入' WHERE category1='销售回款' AND category2 IN ('安心攒活期收益','利息收入')`);
    await q(`UPDATE app_biz_cashflow SET category2='物流费用' WHERE category1='成本' AND category2 IN ('物流费用','物流/运费','转出 · 运费','收钱码 · 物流')`);
    await q(`UPDATE app_biz_cashflow SET category2='软件费用' WHERE category1='成本' AND category2 IN ('软件费用','软件/工具订阅','收钱码 · 服务/工具')`);
    await q(`UPDATE app_biz_cashflow SET category2='贴单费' WHERE category1='成本' AND category2 IN ('巴士充值','贴单费')`);
    await q(`UPDATE app_biz_cashflow SET category2='其他费用' WHERE category1='成本' AND category2 IN ('刷单费','其他费用','其他')`);
    // 运营激励：只留 年终奖 / 月销冠奖 / 个人pb奖 / 团队pb奖 / 团建费用 / 其他激励
    await q(`UPDATE app_biz_cashflow SET category2='其他激励' WHERE category1='运营激励'
      AND category2 NOT IN ('年终奖','月销冠奖','个人pb奖','团队pb奖','团建费用','其他激励')`);
    await q(`UPDATE app_biz_cashflow SET category2='工资' WHERE category1='工资奖金' AND category2 NOT IN ('工资','奖金')`);


    // 大类重算（成本类已并入经营类）
    for (const [group, list] of Object.entries(CATEGORY_GROUPS)) {
      await q(`UPDATE app_biz_cashflow SET category_group=$1 WHERE category_group IS DISTINCT FROM $1 AND category1 = ANY($2::text[])`,
        [group, list]);
    }
    await q(`UPDATE app_biz_cashflow SET category_group='未分类' WHERE category_group='' OR category_group IS NULL`);

    // 分类字典：同名只留一条，其余停用（历史数据仍可追溯，只是下拉里不再出现）
    await q(`DELETE FROM app_biz_cashflow_categories a USING app_biz_cashflow_categories b
      WHERE a.user_id=b.user_id AND a.name=b.name AND a.ctid > b.ctid`);
    const KEEP = [...DEFAULT_CATEGORIES.expense, ...DEFAULT_CATEGORIES.income];
    await q(`UPDATE app_biz_cashflow_categories SET active = (name = ANY($1::text[]))`, [KEEP]);
  }

  async function ensureCatalogForAllUsers() {
    await q(`INSERT INTO app_biz_entities(user_id, name, sort_order)
      SELECT u.id, e.name, e.sort_order FROM app_users u
      CROSS JOIN (VALUES ('超',10),('宝',20),('孙',30)) AS e(name, sort_order)
      ON CONFLICT DO NOTHING`);
    await q(`INSERT INTO app_biz_cashflow_categories(user_id, direction, name, sort_order)
      SELECT u.id, d.direction, d.name, d.sort_order FROM app_users u
      CROSS JOIN (VALUES ${catalogValues()}) AS d(direction, name, sort_order)
      ON CONFLICT DO NOTHING`);
  }

  function catalogValues() {
    const list = [];
    DEFAULT_CATEGORIES.expense.forEach((name, i) => list.push(`('expense','${name}',${(i + 1) * 10})`));
    DEFAULT_CATEGORIES.income.forEach((name, i) => list.push(`('income','${name}',${(i + 1) * 10})`));
    return list.join(',');
  }

  async function ensureUserCatalog(userId) {
    const values = catalogValues();
    await q(`INSERT INTO app_biz_cashflow_categories(user_id, direction, name, sort_order)
      SELECT $1::uuid, d.direction, d.name, d.sort_order FROM (VALUES ${values}) AS d(direction, name, sort_order)
      ON CONFLICT DO NOTHING`, [userId]);
    await q(`INSERT INTO app_biz_entities(user_id, name, sort_order)
      VALUES ($1::uuid,'超',10),($1::uuid,'宝',20),($1::uuid,'孙',30) ON CONFLICT DO NOTHING`, [userId]);
  }

  const money = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  };
  const moneyOr0 = (value) => money(value) ?? 0;
  // 分类 → 大类
  const groupOf = (category1) => {
    if (!category1) return '未分类';
    for (const [group, list] of Object.entries(CATEGORY_GROUPS)) if (list.includes(category1)) return group;
    return '未分类';
  };

  // ───────────────────────── 档案：主体 / 店铺 / 分类 ─────────────────────────
  async function bootstrap(userId) {
    const [entities, stores, categories, shops, category2s, operators] = await Promise.all([
      q(`SELECT id,name,sort_order,active FROM app_biz_entities WHERE user_id=$1 ORDER BY sort_order,name`, [userId]),
      q(`SELECT id,entity_id,name,platform,ozon_store_id,active,sort_order FROM app_biz_stores
         WHERE user_id=$1 ORDER BY sort_order,name`, [userId]),
      q(`SELECT id,direction,name,sort_order,active FROM app_biz_cashflow_categories
         WHERE user_id=$1 ORDER BY direction,sort_order,name`, [userId]),
      q(`SELECT id,name,platform,active FROM app_stores WHERE user_id=$1 AND platform='ozon' ORDER BY name`, [userId]),
      // 二级分类没有字典表（由归类规则写入），下拉选项从实际数据里取，按一级归组
      q(`SELECT DISTINCT category1, category2 FROM app_biz_cashflow
         WHERE user_id=$1 AND category2 <> '' ORDER BY category1, category2`, [userId]),
      q(`SELECT DISTINCT operator FROM app_biz_cashflow
         WHERE user_id=$1 AND COALESCE(operator,'') <> '' ORDER BY operator`, [userId]),
    ]);
    return {
      entities: entities.rows,
      stores: stores.rows,
      categories: categories.rows,
      ozon_shops: shops.rows,
      category2s: category2s.rows,
      operators: operators.rows.map((r) => r.operator),
    };
  }

  async function saveEntity(userId, body = {}) {
    const name = String(body.name || '').trim();
    if (!name) throw fail('经营主体名称不能为空', 400);
    if (body.id) {
      if (!UUID.test(body.id)) throw fail('主体 ID 不合法', 400);
      const { rows } = await q(`UPDATE app_biz_entities SET name=$1, sort_order=COALESCE($2,sort_order),
        active=COALESCE($3,active) WHERE id=$4 AND user_id=$5 RETURNING *`,
        [name, body.sort_order ?? null, body.active ?? null, body.id, userId]);
      if (!rows[0]) throw fail('主体不存在', 404);
      return rows[0];
    }
    const { rows } = await q(`INSERT INTO app_biz_entities(user_id,name,sort_order)
      VALUES($1,$2,COALESCE($3,100)) ON CONFLICT(user_id,name) DO UPDATE SET active=TRUE RETURNING *`,
      [userId, name, body.sort_order ?? null]);
    return rows[0];
  }

  async function deleteEntity(userId, id) {
    // 主体下还挂着店铺就不让删，避免店铺变成孤儿
    const used = await q(`SELECT COUNT(*)::int AS n FROM app_biz_stores WHERE user_id=$1 AND entity_id=$2`, [userId, id]);
    if (used.rows[0].n) throw fail('该主体下还有店铺，先移走店铺再删除', 400);
    await q(`DELETE FROM app_biz_entities WHERE id=$1 AND user_id=$2`, [id, userId]);
    return { ok: true };
  }

  async function saveStore(userId, body = {}) {
    const platform = String(body.platform || 'ozon');
    if (!['etsy', 'ozon'].includes(platform)) throw fail('平台只能是 etsy 或 ozon', 400);
    const name = String(body.name || '').trim();
    if (!name) throw fail('店铺名称不能为空', 400);
    const entityId = body.entity_id && UUID.test(body.entity_id) ? body.entity_id : null;
    let ozonStoreId = null;
    if (platform === 'ozon') {
      ozonStoreId = String(body.ozon_store_id || '').trim() || null;
      if (!ozonStoreId || !UUID.test(ozonStoreId)) throw fail('Ozon 店铺必须选择一个已接入的店铺', 400);
      const own = await q(`SELECT id FROM app_stores WHERE id=$1 AND user_id=$2`, [ozonStoreId, userId]);
      if (!own.rows[0]) throw fail('所选 Ozon 店铺不存在', 400);
      // 唯一索引拦下来会抛 500，这里先查一遍给出人话提示
      const dup = await q(`SELECT name FROM app_biz_stores WHERE user_id=$1 AND ozon_store_id=$2
        AND ($3::uuid IS NULL OR id <> $3::uuid)`, [userId, ozonStoreId, body.id && UUID.test(body.id) ? body.id : null]);
      if (dup.rows[0]) throw fail(`这个 Ozon 店铺已经挂在「${dup.rows[0].name}」上了`, 400);
    }
    if (body.id) {
      if (!UUID.test(body.id)) throw fail('店铺 ID 不合法', 400);
      const { rows } = await q(`UPDATE app_biz_stores SET entity_id=$1,name=$2,platform=$3,ozon_store_id=$4,
        active=COALESCE($5,active), sort_order=COALESCE($6,sort_order) WHERE id=$7 AND user_id=$8 RETURNING *`,
        [entityId, name, platform, ozonStoreId, body.active ?? null, body.sort_order ?? null, body.id, userId]);
      if (!rows[0]) throw fail('店铺不存在', 404);
      return rows[0];
    }
    const { rows } = await q(`INSERT INTO app_biz_stores(user_id,entity_id,name,platform,ozon_store_id,sort_order)
      VALUES($1,$2,$3,$4,$5,COALESCE($6,100)) ON CONFLICT(user_id,name) DO UPDATE
      SET entity_id=EXCLUDED.entity_id, platform=EXCLUDED.platform, ozon_store_id=EXCLUDED.ozon_store_id,
      active=TRUE RETURNING *`, [userId, entityId, name, platform, ozonStoreId, body.sort_order ?? null]);
    return rows[0];
  }

  async function deleteStore(userId, id) {
    await q(`DELETE FROM app_biz_stores WHERE id=$1 AND user_id=$2`, [id, userId]);
    return { ok: true };
  }

  async function saveCategory(userId, body = {}) {
    const direction = String(body.direction || '');
    if (!['income', 'expense'].includes(direction)) throw fail('分类方向不合法', 400);
    const name = String(body.name || '').trim();
    if (!name) throw fail('分类名称不能为空', 400);
    const { rows } = await q(`INSERT INTO app_biz_cashflow_categories(user_id,direction,name,sort_order)
      VALUES($1,$2,$3,COALESCE($4,100)) ON CONFLICT(user_id,direction,name) DO UPDATE SET active=TRUE RETURNING *`,
      [userId, direction, name, body.sort_order ?? null]);
    return rows[0];
  }

  async function deleteCategory(userId, id) {
    // 只停用不删除：历史流水里存的是分类名，删掉字典会让老数据失去对照
    await q(`UPDATE app_biz_cashflow_categories SET active=FALSE WHERE id=$1 AND user_id=$2`, [id, userId]);
    return { ok: true };
  }

  // ───────────────────────── 股权行人工字段 ─────────────────────────
  async function listEquityHolders(userId) {
    const { rows } = await q(`SELECT holder_key, unpaid FROM app_biz_equity_holders WHERE user_id=$1`, [userId]);
    return rows;
  }

  async function saveEquityHolder(userId, body = {}) {
    const key = String(body.holder_key || '').trim();
    if (!key) throw fail('缺少股东标识', 400);
    const unpaid = String(body.unpaid == null ? '' : body.unpaid).slice(0, 200);
    const { rows } = await q(`INSERT INTO app_biz_equity_holders(user_id, holder_key, unpaid)
      VALUES($1,$2,$3) ON CONFLICT(user_id, holder_key) DO UPDATE
      SET unpaid=EXCLUDED.unpaid, updated_at=now() RETURNING holder_key, unpaid`,
    [userId, key, unpaid]);
    return rows[0];
  }

  // 最近两个月（当月 + 上月）数据仍在滚动结算，视为「不完整」，不参与 PB / 团队 TOP 记录
  const businessMonth = () => {
    const d = new Date(Date.now() + 8 * 3600000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  const completeMonthCutoff = (monthsBack = 2) => {
    const [y, m] = businessMonth().split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 - monthsBack, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  // ───────────────────────── 记录历史（团队 TOP / 个人 PB） ─────────────────────────
  // 从经营总览的月度毛利里滚出「每次刷新纪录」的月份列表：团队合计 / 超 / 宝
  async function recordHistory(userId, year) {
    const ov = await overview(userId, year);
    const months = new Map();
    for (const entity of ov.entities) {
      const isChao = String(entity.name || '').includes('超');
      const isBao = String(entity.name || '').includes('宝');
      for (const platform of entity.platforms || []) {
        for (const m of platform.months || []) {
          const rec = months.get(m.month) || { month: m.month, chao: 0, bao: 0, team: 0 };
          const profit = Number(m.profit_cny || 0);
          if (isChao) rec.chao += profit;
          if (isBao) rec.bao += profit;
          rec.team += profit;
          months.set(m.month, rec);
        }
      }
    }
    const cutoff = completeMonthCutoff(2);
    const list = [...months.values()]
      .filter((rec) => rec.month <= cutoff) // 不完整的月份不参与记录
      .sort((a, b) => a.month.localeCompare(b.month));
    const build = (key) => {
      let max = 0;
      const history = [];
      for (const rec of list) {
        const value = Number(rec[key] || 0);
        if (value > 0 && value > max) {
          max = value;
          history.push({ month: rec.month, value: moneyOr0(value) });
        }
      }
      return { current: history[history.length - 1] || null, history };
    };
    return { team: build('team'), chao: build('chao'), bao: build('bao'), years: ov.years, cutoff };
  }

  // ───────────────────────── 月度备注 ─────────────────────────
  async function listMonthNotes(userId, year) {
    const years = (Array.isArray(year) ? year : [year]).map((v) => String(v));
    const { rows } = await q(`SELECT month, note FROM app_biz_month_notes
      WHERE user_id=$1 AND month LIKE ANY($2::text[]) ORDER BY month`,
    [userId, years.map((y) => `${y}-%`)]);
    return rows;
  }

  async function saveMonthNote(userId, body = {}) {
    const month = String(body.month || '');
    if (!MONTH.test(month)) throw fail('月份格式应为 YYYY-MM', 400);
    const note = String(body.note == null ? '' : body.note).slice(0, 500);
    const { rows } = await q(`INSERT INTO app_biz_month_notes(user_id,month,note)
      VALUES($1,$2,$3) ON CONFLICT(user_id,month) DO UPDATE
      SET note=EXCLUDED.note, updated_at=now() RETURNING month, note`,
    [userId, month, note]);
    return rows[0];
  }

  // ───────────────────────── 手工月度数据（按 人 + 平台） ─────────────────────────
  // Etsy 没有 API 也不需要店铺档案；Ozon 2026-10 之前没有月结数据。两边都靠这张表手工记。
  async function listManualMonths(userId, year, filter = {}) {
    const years = (Array.isArray(year) ? year : [year]).map((v) => String(v));
    const values = [userId, years.map((y) => `${y}-%`)];
    let sql = `SELECT entity_id, platform, month, revenue_cny, ad_cny, fee_cny, refund_cny, note
      FROM app_biz_manual_months WHERE user_id=$1 AND month LIKE ANY($2::text[])`;
    if (filter.entity_id) { values.push(String(filter.entity_id)); sql += ` AND entity_id=$${values.length}`; }
    if (filter.platform) { values.push(String(filter.platform)); sql += ` AND platform=$${values.length}`; }
    sql += ' ORDER BY month';
    const { rows } = await q(sql, values);
    return rows.map((r) => ({
      ...r,
      revenue_cny: moneyOr0(r.revenue_cny), ad_cny: moneyOr0(r.ad_cny),
      fee_cny: moneyOr0(r.fee_cny), refund_cny: moneyOr0(r.refund_cny),
    }));
  }

  async function saveManualMonth(userId, body = {}) {
    const entityId = String(body.entity_id || '');
    if (!UUID.test(entityId)) throw fail('请选择经营主体', 400);
    const platform = String(body.platform || '');
    if (!['etsy', 'ozon'].includes(platform)) throw fail('平台只能是 etsy 或 ozon', 400);
    const month = String(body.month || '');
    if (!MONTH.test(month)) throw fail('月份格式应为 YYYY-MM', 400);
    const own = await q(`SELECT id FROM app_biz_entities WHERE id=$1 AND user_id=$2`, [entityId, userId]);
    if (!own.rows[0]) throw fail('经营主体不存在', 404);
    const revenue = Number(body.revenue_cny), ad = Number(body.ad_cny), fee = Number(body.fee_cny);
    const refund = Number(body.refund_cny || 0);
    if (!Number.isFinite(revenue)) throw fail('收入必须是数字', 400);
    for (const [label, value] of [['广告投放', ad], ['其他费用', fee], ['退款', refund]]) {
      if (!Number.isFinite(value) || value < 0) throw fail(`${label}必须是不小于 0 的数字`, 400);
    }
    const { rows } = await q(`INSERT INTO app_biz_manual_months(user_id,entity_id,platform,month,revenue_cny,ad_cny,fee_cny,refund_cny,note)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(user_id,entity_id,platform,month) DO UPDATE
      SET revenue_cny=EXCLUDED.revenue_cny, ad_cny=EXCLUDED.ad_cny, fee_cny=EXCLUDED.fee_cny,
      refund_cny=EXCLUDED.refund_cny, note=EXCLUDED.note, updated_at=now() RETURNING *`,
      [userId, entityId, platform, month, revenue, ad, fee, refund, String(body.note || '')]);
    return rows[0];
  }

  // ───────────────────────── Etsy 月度录入（老接口，保留兼容） ─────────────────────────
  // year 可以是单年，也可以是年份数组（经营总览按区间取多个年度）
  async function listEtsyMonths(userId, year) {
    const years = (Array.isArray(year) ? year : [year]).map((v) => String(v));
    const { rows } = await q(`SELECT m.biz_store_id, m.month, m.revenue_cny, m.ad_cny, m.fee_cny, m.refund_cny, m.note, s.name AS store_name
      FROM app_biz_etsy_months m JOIN app_biz_stores s ON s.id=m.biz_store_id
      WHERE m.user_id=$1 AND m.month LIKE ANY($2::text[]) ORDER BY m.month`,
    [userId, years.map((y) => `${y}-%`)]);
    return rows.map((r) => ({ ...r, revenue_cny: moneyOr0(r.revenue_cny), ad_cny: moneyOr0(r.ad_cny), fee_cny: moneyOr0(r.fee_cny), refund_cny: moneyOr0(r.refund_cny) }));
  }

  async function saveEtsyMonth(userId, body = {}) {
    const storeId = String(body.biz_store_id || '');
    if (!UUID.test(storeId)) throw fail('请选择店铺', 400);
    const month = String(body.month || '');
    if (!MONTH.test(month)) throw fail('月份格式应为 YYYY-MM', 400);
    const own = await q(`SELECT id,platform FROM app_biz_stores WHERE id=$1 AND user_id=$2`, [storeId, userId]);
    if (!own.rows[0]) throw fail('店铺不存在', 404);
    const revenue = Number(body.revenue_cny), ad = Number(body.ad_cny), fee = Number(body.fee_cny);
    const refund = Number(body.refund_cny || 0);
    // 收入可以是负数（退款扎堆的月份净收入为负），费用类必须非负
    if (!Number.isFinite(revenue)) throw fail('销售收入必须是数字', 400);
    for (const [label, value] of [['广告投放', ad], ['其他费用', fee], ['退款', refund]]) {
      if (!Number.isFinite(value) || value < 0) throw fail(`${label}必须是不小于 0 的数字`, 400);
    }
    const { rows } = await q(`INSERT INTO app_biz_etsy_months(user_id,biz_store_id,month,revenue_cny,ad_cny,fee_cny,refund_cny,note)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id,biz_store_id,month) DO UPDATE
      SET revenue_cny=EXCLUDED.revenue_cny, ad_cny=EXCLUDED.ad_cny, fee_cny=EXCLUDED.fee_cny,
      refund_cny=EXCLUDED.refund_cny, note=EXCLUDED.note, updated_at=now() RETURNING *`,
      [userId, storeId, month, revenue, ad, fee, refund, String(body.note || '')]);
    return rows[0];
  }

  async function deleteEtsyMonth(userId, storeId, month) {
    await q(`DELETE FROM app_biz_etsy_months WHERE user_id=$1 AND biz_store_id=$2 AND month=$3`, [userId, storeId, month]);
    return { ok: true };
  }

  // ───────────────────────── 经营总览 ─────────────────────────
  async function latestRate() {
    const { rows } = await q(`SELECT rate FROM app_exchange_rates WHERE base_currency='RUB' AND quote_currency='CNY'
      ORDER BY effective_at DESC LIMIT 1`);
    return rows[0] ? Number(rows[0].rate) : null;
  }

  const emptyMonths = (year) => {
    const list = [];
    for (let m = 1; m <= 12; m += 1) list.push({ month: `${year}-${String(m).padStart(2, '0')}`, revenue_cny: 0, ad_cny: 0, fee_cny: 0, profit_cny: 0, refund_cny: 0, orders: 0 });
    return list;
  };
  // 多个年度拼成一整段月份（升序），供跨年区间使用
  const monthsFor = (years) => {
    const list = [];
    for (const y of [...years].map(Number).filter(Number.isFinite).sort((a, b) => a - b)) list.push(...emptyMonths(y));
    return list;
  };

  // Ozon：复用月结统计的月度汇总，保证与「月结统计」页面口径完全一致
  // months 传进来的是要统计的月份桶（可能是跨年的整段），只加载一次月结数据
  // 2026-11-09 口径调整（用户确认）：
  //   收入 = 销售收入 − 代扣 − 采购 − 贴单（= 结算毛利 + 广告）
  //   广告 = 结算广告
  //   毛利 = 收入 − 广告 = 结算毛利，恒等式固定
  async function ozonMonths(userId, ozonStoreId, months, rate) {
    if (!statistics) throw fail('统计模块未就绪', 500);
    const data = await statistics.loadData({ userId, storeId: ozonStoreId });
    const effectiveRate = Number(rate || data.rate);
    const rows = statistics.settlementSummary(data) || [];
    const index = new Map(months.map((m) => [m.month, m]));
    for (const row of rows) {
      const bucket = index.get(String(row.month || '').slice(0, 7));
      if (!bucket) continue;
      if (row.is_group) continue; // 只看月度合计行，分组行不重复计入
      const ad = moneyOr0(Number(row.advertising_rub || 0) * effectiveRate);
      const profit = moneyOr0(row.profit_cny);
      bucket.ad_cny = ad;
      bucket.fee_cny = moneyOr0(Math.abs(Number(row.ozon_fees_rub || 0)) * effectiveRate);
      bucket.profit_cny = profit;
      // 收入 = 毛利 + 广告，等价于「销售 − 代扣 − 采购 − 贴单」
      bucket.revenue_cny = moneyOr0(profit + ad);
      bucket.refund_cny = 0;
      bucket.orders += Number(row.orders || 0);
    }
    return { months, rate: effectiveRate };
  }

  // year 支持单年（2026）或年份数组（[2025, 2026]）；总览按区间取多年
  // 输出按「人 → 平台」聚合：平台层既有 months（多店累加 + 手工覆盖），也保留 stores 明细
  async function overview(userId, year) {
    const picks = (Array.isArray(year) ? year : [year])
      .map((v) => Number(v)).filter((v) => Number.isInteger(v) && v >= 2000 && v <= 2100);
    const ys = [...new Set(picks.length ? picks : [new Date().getFullYear()])].sort((a, b) => b - a);
    const { entities, stores } = await bootstrap(userId);
    const rate = await latestRate();
    const manualRows = await listManualMonths(userId, ys);
    const result = [];
    const zero = () => ({ revenue_cny: 0, ad_cny: 0, fee_cny: 0, profit_cny: 0 });
    const grand = zero();

    for (const entity of entities.filter((e) => e.active !== false)) {
      const entityOut = { id: entity.id, name: entity.name, sort_order: entity.sort_order, platforms: [], totals: zero() };
      const own = stores.filter((s) => s.entity_id === entity.id && s.active !== false);
      const groups = new Map();
      const group = (platform) => {
        if (!groups.has(platform)) groups.set(platform, { platform, months: monthsFor(ys), stores: [], error: '' });
        return groups.get(platform);
      };

      for (const store of own) {
        const g = group(store.platform);
        let months = monthsFor(ys), error = '', effectiveRate = rate;
        if (store.platform === 'ozon') {
          if (store.ozon_store_id) {
            try {
              const res = await ozonMonths(userId, store.ozon_store_id, monthsFor(ys), rate);
              months = res.months; effectiveRate = res.rate;
            } catch (err) {
              error = err?.message || '月结统计读取失败';
            }
          } else {
            error = '未关联 Ozon 店铺';
          }
        }
        g.stores.push({
          id: store.id, name: store.name, platform: store.platform, ozon_store_id: store.ozon_store_id,
          months, error, exchange_rate: effectiveRate,
        });
        if (error && !g.error) g.error = error;
        // 多店合并到平台层
        for (const m of months) {
          const bucket = g.months.find((x) => x.month === m.month);
          if (!bucket) continue;
          bucket.revenue_cny = moneyOr0(bucket.revenue_cny + m.revenue_cny);
          bucket.ad_cny = moneyOr0(bucket.ad_cny + m.ad_cny);
          bucket.fee_cny = moneyOr0(bucket.fee_cny + m.fee_cny);
          bucket.refund_cny = moneyOr0(bucket.refund_cny + m.refund_cny);
          bucket.profit_cny = moneyOr0(bucket.profit_cny + m.profit_cny);
          bucket.orders += Number(m.orders || 0);
        }
      }

      // 手工月度数据按「主体 + 平台」覆盖：Etsy 全靠它；Ozon 补月结没覆盖到的月份
      for (const row of manualRows.filter((r) => r.entity_id === entity.id)) {
        const g = group(row.platform);
        const bucket = g.months.find((m) => m.month === row.month);
        if (!bucket) continue;
        if (!(Number(row.revenue_cny) || Number(row.ad_cny) || Number(row.fee_cny) || Number(row.refund_cny))) continue;
        bucket.revenue_cny = moneyOr0(row.revenue_cny);
        bucket.ad_cny = moneyOr0(row.ad_cny);
        bucket.fee_cny = moneyOr0(row.fee_cny);
        bucket.refund_cny = moneyOr0(row.refund_cny);
        bucket.profit_cny = moneyOr0(Number(row.revenue_cny) - Number(row.ad_cny) - Number(row.fee_cny) - Number(row.refund_cny));
        bucket.manual = true;
      }

      for (const g of groups.values()) {
        const totals = g.months.reduce((acc, m) => ({
          revenue_cny: moneyOr0(acc.revenue_cny + m.revenue_cny),
          ad_cny: moneyOr0(acc.ad_cny + m.ad_cny),
          fee_cny: moneyOr0(acc.fee_cny + m.fee_cny),
          profit_cny: moneyOr0(acc.profit_cny + m.profit_cny),
        }), zero());
        entityOut.platforms.push({ ...g, totals, stores: g.stores.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh')) });
        for (const key of ['revenue_cny', 'ad_cny', 'fee_cny', 'profit_cny']) {
          entityOut.totals[key] = moneyOr0(entityOut.totals[key] + totals[key]);
          grand[key] = moneyOr0(grand[key] + totals[key]);
        }
      }
      entityOut.platforms.sort((a, b) => (a.platform === b.platform ? 0 : a.platform === 'etsy' ? -1 : 1));
      entityOut.margin_pct = entityOut.totals.revenue_cny > 0
        ? Math.round(entityOut.totals.profit_cny / entityOut.totals.revenue_cny * 1000) / 10 : null;
      result.push(entityOut);
    }
    return {
      year: ys[0], years: ys, exchange_rate: rate,
      entities: result,
      totals: { ...grand, margin_pct: grand.revenue_cny > 0 ? Math.round(grand.profit_cny / grand.revenue_cny * 1000) / 10 : null },
      // 还没归属到任何人的店铺，提示出来（否则数据会悄悄漏掉）
      unassigned: stores.filter((s) => !s.entity_id && s.active !== false).map((s) => ({ id: s.id, name: s.name, platform: s.platform })),
    };
  }

  // ───────────────────────── 资金流水 ─────────────────────────
  const directionOf = (value) => {
    const text = String(value || '').trim().toLowerCase();
    if (['income', '收入', '收', 'in', '收入(+)', '贷'].includes(text)) return 'income';
    if (['expense', '支出', '支', 'out', '支出(-)', '借'].includes(text)) return 'expense';
    return '';
  };

  // 去重指纹：只认「交易本身」——日期/方向/金额/对方/备注/交易说明/操作人
  //   ⚠️ 不要把分类放进来：分类会随规则调整或人工修正而变，一旦参与指纹，
  //   同一笔流水重导时会被判成新行，造成成倍重复
  // 去重指纹：订单号优先（支付宝每笔都有唯一订单号），
  //   以前只看 日期|方向|金额|对方|备注|说明|操作人，同一天买了两次同款同价的东西
  //   （女包 39 元买两只、闲鱼转 16 元两笔）第二笔会被当成重复丢掉，造成真丢账
  const dedupeKey = (row) => {
    const parts = [row.date, row.direction, Number(row.amount).toFixed(2)];
    if (row.order_no) parts.push(`no:${row.order_no}`);
    parts.push(row.counterparty || '', row.note || '', row.description || '', row.operator || '');
    return crypto.createHash('md5').update(parts.join('|')).digest('hex');
  };

  // 导入表里的日期可能写成 2026/2/7、2026.2.7（Excel 常见），统一归一到 YYYY-MM-DD 并校验真实存在
  const normalizeDate = (value) => {
    const text = String(value || '').trim().replace(/[./]/g, '-');
    const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!match) return '';
    const y = Number(match[1]), m = Number(match[2]), d = Number(match[3]);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return '';
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };

  // ── 自动归类：按「交易说明 + 备注」判类型，二级分类记录分组名，便于回看与后续调规则 ──
  const RULE_SOFTWARE = ['全球节点', '荔枝ai', '荔枝', 'erank', 'kookeey', '腾讯文档', '火山引擎', '元宝', '续费', '专业版', 'jvs', '踢跟卖', '[yl]充值', 'gmini', 'gpt', 'ip续费'];
  // 物流商户（说明/备注里出现就按物流费用）
  const LOGISTICS_MERCHANT = ['递四方', '4px', '燕文', '云途', '顺友', '万邦', '递一', '出口易', '飞特', '菜鸟', '极兔',
    '中通', '圆通', '申通', '韵达', '顺丰', '京邦达', 'ems'];
  // 运费类短语（避开「快递袋/快递盒」这类包装耗材的商品名）
  const LOGISTICS_PHRASE = ['运费', '快递费', '快递代下单', '物流充值', '物流平台'];
  // 生活/团建：只用明确词，别用单字（「笔」会抓到键盘、「餐」会抓到餐垫）
  const RULE_LIFE = ['汉堡王', '麻辣烫', '柠檬茶', '外卖', '美团', '火锅', '牛排', '豆花', '啤酒',
    '福鹿家', '自助', '烧烤', '畅选', '聚餐', '用餐', '晚餐', '午餐', '早餐', '卤味', '奶茶', '咖啡', '餐饮'];
  // 电脑/数码硬件：用户口径记「成本 · 其他费用」，不是原料采购
  const RULE_HARDWARE = ['ssd', '固态硬盘', '机械硬盘', '硬盘', '内存条', '内存', '键盘', '鼠标', '显示器',
    '服务器', '白板', '显卡', '主板', 'cpu', 'u盘', '路由器', '机箱', '电源', '笔记本电脑', '打印', '摄像'];
  // 软件/账号/接口类：记「成本 · 软件费用」
  const RULE_SOFT_MORE = ['mj', 'midjourney', 'midjouney', '接口', '激活码', 'autojourney', '紫鸟', '红海', 'bcs', '独享', '会员'];

  // 个别特殊行的逐笔指定（金额+备注命中优先于规则）：
  //   2026-10-12「注资 15,000」经确认实为借款 → 注资合计 9,700 / 借款合计 85,000
  const MANUAL_OVERRIDES = [
    { match: (d, n, amount) => n === '注资' && Math.abs(Number(amount) - 15000) < 0.01, category1: '股东权益', category2: '借款' },
  ];

  // 零散收入与特殊备注的逐条口径（2026-11-09 用户确认）：
  //   TK保证金/卖My账号 = 销售类其他收入；帮cc寄代收的运费冲在物流费用上；
  //   打烊/打样/花瓶/赔付 = 销售类其他收入；快递袋/扫地机器人退款 = 冲减采购
  const SPECIAL_NOTE_RULES = [
    { test: (n) => /TK保证金/.test(n), category1: '销售回款', category2: '其他收入' },
    { test: (n) => /卖\s*my/i.test(n), category1: '销售回款', category2: '其他收入' },
    { test: (n) => /帮cc寄/i.test(n) || /帮CC寄/i.test(n), category1: '成本', category2: '物流费用' },
    { test: (n) => /快递袋退款|扫地机器人退款/.test(n), category1: '采购退款', category2: '退款' },
    { test: (n) => /打烊|打样|花瓶|赔付|丢失/.test(n), category1: '销售回款', category2: '其他收入' },
    { test: (n) => /^gpt$/i.test(n), category1: '成本', category2: '软件费用' },
  ];

  // 三级口径：大类（category_group）→ 一级（category1）→ 二级（category2）
  function classify(direction, description, note, amount = 0) {
    const d = String(description || '').trim();
    const n = String(note || '').trim();
    const text = `${d} ${n}`.toLowerCase();
    const hit = (list) => list.some((key) => text.includes(key));
    const override = MANUAL_OVERRIDES.find((row) => row.match(d, n, amount));
    if (override) return { category1: override.category1, category2: override.category2 };

    if (d.includes('安心攒')) return { category1: '销售回款', category2: '利息收入' };
    // 洗衣机这两单是孙转钱给宝代买（一前一后各 909 成对），按代付处理，不计入收支
    if (d.includes('洗衣机')) return { category1: '内部划转', category2: '代付（个人代购）' };
    // 成本类 · 贴单费（巴士充值）
    if (text.includes('巴士')) return { category1: '成本', category2: '贴单费' };
    // 成本类 · 经营费用 · 物流费用
    //   不能只凭「物流/快递」裸词：「快递袋/快递纸箱」是包装耗材，属原料采购
    if (LOGISTICS_MERCHANT.some((key) => text.includes(key)) || LOGISTICS_PHRASE.some((key) => text.includes(key))) {
      return { category1: '成本', category2: '物流费用' };
    }
    // 经营类 · 工资奖金 / 运营激励（这些钱也是从余额或银行卡转出的，必须先于「内部划转」判定）
    if (/一月激励/.test(n)) return { category1: '工资奖金', category2: '工资' };
    if (/年终奖/.test(text)) return { category1: '运营激励', category2: '年终奖' };
    if (/销冠/.test(text)) return { category1: '运营激励', category2: '月销冠奖' };
    if (/个人\s*pb/i.test(text)) return { category1: '运营激励', category2: '个人pb奖' };
    if (/团队\s*pb/i.test(text)) return { category1: '运营激励', category2: '团队pb奖' };
    if (/黄金|月.*激励|销冠/.test(text)) return { category1: '运营激励', category2: '月销冠奖' };
    if (/激励/.test(text)) return { category1: '运营激励', category2: '其他激励' };
    if (/分红/.test(text)) return { category1: '工资奖金', category2: '奖金' };
    if (/补贴|保底|工资|底薪/.test(text)) return { category1: '工资奖金', category2: '工资' };
    // 「权益」经确认为工资（2026-11-09）
    if (/权益/.test(n)) return { category1: '工资奖金', category2: '工资' };
    // 先挡掉收入性质的：赔付 / 丢失 / 退款到账（硬件、软件关键词不能吞掉它们）
    if (/赔付|丢失|退回|返现/.test(n)) return { category1: '销售回款', category2: '其他收入' };
    // 「mj销售」这类是销售收入，不是软件费
    if (/销售/.test(n) && /mj|my|插件|账号/i.test(text)) return { category1: '销售回款', category2: '其他收入' };
    // 电脑/数码硬件 → 成本 · 其他费用（用户 2026-11-09 核对后确认）
    if (RULE_HARDWARE.some((k) => text.includes(k))) return { category1: '成本', category2: '其他费用' };
    // 软件/账号/接口 → 成本 · 软件费用
    if (RULE_SOFT_MORE.some((k) => text.includes(k))) return { category1: '成本', category2: '软件费用' };
    // 采购类备注：工厂账单/货款、手帐本/本子、包装耗材、小商品…
    //   ⚠️ 这些支出多数是从「转出到余额/银行卡」走的，必须排在内部划转之前，
    //   否则会被当成「钱在钱包里搬」，3 万多的真实采购直接不计收支
    if (/工厂|货款|账单|本子|手帐本|麻将垫|粘土|贴纸|桌垫|门角|蜡烛|花盆|纸箱|采购\s*my|转换头|采购|第\s*\d+\s*单|实体单|拖鞋/i.test(text)) {
      return { category1: '原料采购', category2: '原料采购' };
    }
    // 刷单费（店铺刷单/推广）→ 成本类 · 其他费用；「麻将垫刷单」这类含商品名的已被上面的采购规则接走
    if (/刷单/.test(text)) return { category1: '成本', category2: '其他费用' };
    // 软件订阅/服务费（同上，也常从转出/转账付）
    if (hit(RULE_SOFTWARE)) return { category1: '成本', category2: '软件费用' };
    // 厨房工具类商品（松肉针/扎孔器/敲肉锤/嫩肉针）不是吃饭，
    //   必须放在团建判断之前，否则「牛排扎孔器」会被 RULE_LIFE 的"牛排"接走
    if (/松肉针|扎孔器|敲肉锤|嫩肉针|肉锤|走珠笔|中性笔|圆珠笔/.test(text)) {
      return { category1: '原料采购', category2: '原料采购' };
    }
    // 团建/聚餐
    if (hit(RULE_LIFE)) return { category1: '运营激励', category2: '团建费用' };
    // 「转账」且没写备注的按物流费用（用户口径：这批是付给物流商的钱）
    //   注意只认「转账」，「转出到余额/银行卡」无备注仍算内部划转
    if (d === '转账' && !n) return { category1: '成本', category2: '物流费用' };
    // 资金在钱包/银行卡之间搬，不是真实收支
    if (['转出到余额', '转出到银行卡', '转账'].includes(d)) return { category1: '内部划转', category2: '资金内部划转' };
    if (d.startsWith('转入')) {
      const special = SPECIAL_NOTE_RULES.find((row) => row.test(n));
      if (special) return { category1: special.category1, category2: special.category2 };
      if (/ozon|et|etsy|回款/.test(n.toLowerCase())) return { category1: '销售回款', category2: '销售回款' };
      // 股东权益：注资=本金；借用/借款/孙总注资=要还的钱
      if (/借用|借款|孙总注资/.test(n)) return { category1: '股东权益', category2: '借款' };
      if (/注资/.test(n)) return { category1: '股东权益', category2: '注资' };
      // 储备资金 / 初始资金 / 启动资金 → 股东注资（2026-11-09 用户确认）
      if (/储备资金|初始资金|启动资金/.test(n)) return { category1: '股东权益', category2: '注资' };
      // 闲鱼/MJ/插件/分销、Adobe 提现、客户托管费、赔付与仓库退款 → 其他销售收入
      if (/闲鱼|^鱼$|mj|插件销售|分销|adobe|客户\s*\d|york|赔付|仓库退款/i.test(n)) {
        return { category1: '销售回款', category2: '其他收入' };
      }
      // 无备注的转入，用户核对后一律按股东注资
      if (!n) return { category1: '股东权益', category2: '注资' };
      // 其余看不出性质的转入：不猜，留待人工归类
      return { category1: '', category2: '' };
    }
    if (d.startsWith('转出')) {
      if (/运费|快递|物流/.test(n)) return { category1: '成本', category2: '物流费用' };
      // 踢跟卖、GPt 订阅是软件服务；其余转出按原料采购（补差价、配件等）
      if (/踢跟卖/.test(n) || /踢跟卖/.test(d)) return { category1: '成本', category2: '软件费用' };
      if (/^gpt$/i.test(n) || /gpt/i.test(n)) return { category1: '成本', category2: '软件费用' };
      return { category1: '原料采购', category2: '原料采购' };
    }
    if (d.startsWith('退款-')) return { category1: '采购退款', category2: '退款' };
    if (d.startsWith('已退款')) return { category1: '采购退款', category2: '退款' };
    if (d.startsWith('商户单号')) return { category1: '原料采购', category2: '原料采购' };
    if (d.startsWith('合并支付订单')) return { category1: '原料采购', category2: '原料采购' };
    if (d.startsWith('订单号')) return { category1: '原料采购', category2: '原料采购' };
    if (d.startsWith('全款交易')) return { category1: '原料采购', category2: '原料采购' };
    if (d === '收钱码收款') {
      if (/my|踢|荔枝|续费/.test(n.toLowerCase())) return { category1: '成本', category2: '软件费用' };
      if (/物流|运费|快递/.test(n)) return { category1: '成本', category2: '物流费用' };
      return { category1: '原料采购', category2: '原料采购' };
    }
    if (/小红书|闲鱼|抖音/.test(d)) return { category1: '原料采购', category2: '原料采购' };
    // 付款码类与只有订单号的支出（经营收款单/经营码交易/二维码支付/纯数字/订单NNN）
    if (/^(经营收款单|经营码交易|二维码支付|扫码支付)$/.test(d) || /^\d{10,}$/.test(d) || /^订单\d+$/.test(d)) {
      return { category1: '原料采购', category2: '原料采购' };
    }
    // 明确的商品名（门锁 NFC 卡 / 脱毛仪 / 牙盘 / 陀螺 / 电池…）
    if (PRODUCT_HINTS.some((key) => text.includes(key))) return { category1: '原料采购', category2: '原料采购' };
    // 只剩看不懂的商品名：按用户口径一律归采购（备注原样保留，能追溯是什么东西）
    if (direction === 'expense' && d) return { category1: '原料采购', category2: '原料采购' };
    return { category1: '', category2: '' };
  }

  // 把任意来源的行归一化：通用模板（日期/方向/金额）与支付宝小荷包（交易时间/收入金额/支出金额）都吃
  async function prepareRows(userId, rows, sourceFile = '') {
    const { entities, stores, categories } = await bootstrap(userId);
    // 名称 → 档案 ID：导入表里填「快乐星期五」「超」这种名字就能自动挂上归属
    const storeByName = new Map(stores.map((s) => [String(s.name).trim(), s]));
    const entityByName = new Map(entities.map((e) => [String(e.name).trim(), e]));
    // 只校验分类名是否存在，不限制方向：代收运费冲「物流费用」、退款冲「原料采购」这类
    //   都是收入方向的费用/采购类，按方向卡会把这些行误判成待分类
    const catNames = new Set(categories.map((c) => c.name));
    const errors = [];
    const prepared = [];
    rows.forEach((raw, index) => {
      const line = index + 1;
      const date = normalizeDate(raw.date);
      if (!DATE.test(date)) { errors.push({ line, message: '日期读不出来' }); return; }
      const income = Number(raw.income), expense = Number(raw.expense);
      let direction = directionOf(raw.direction);
      if (!direction) direction = Number.isFinite(income) && income > 0 ? 'income' : Number.isFinite(expense) && expense > 0 ? 'expense' : '';
      if (!direction) { errors.push({ line, message: '收支方向只能填 收入/支出' }); return; }
      const amount = Number.isFinite(Number(raw.amount)) && Number(raw.amount) > 0 ? Number(raw.amount)
        : Number.isFinite(income) && income > 0 ? income : expense;
      if (!Number.isFinite(amount) || amount <= 0) { errors.push({ line, message: '金额必须大于 0' }); return; }
      const currency = String(raw.currency || 'CNY').trim().toUpperCase();
      if (currency && currency !== 'CNY') { errors.push({ line, message: '只支持人民币（CNY）金额，请先在表里换算' }); return; }
      const description = String(raw.description || '').trim();
      const note = String(raw.note || '').trim();
      const operator = String(raw.operator || '').trim();
      const storeName = String(raw.store || '').trim();
      const entityName = String(raw.entity || '').trim() || operator;
      const store = storeName ? storeByName.get(storeName) : null;
      if (storeName && !store) errors.push({ line, message: `经营店铺「${storeName}」不在档案里，已按未归属导入` });
      const entity = entityName ? entityByName.get(entityName) : (store?.entity_id ? entities.find((e) => e.id === store.entity_id) : null);
      if (entityName && !entity && !operator) errors.push({ line, message: `经营主体「${entityName}」不存在，已按店铺归属推断` });
      // 用户自己选了分类就用用户的；否则按规则猜，猜不出来留空等手动选
      const picked = String(raw.category1 || '').trim();
      const guess = classify(direction, description, note, raw.amount ?? (raw.income ?? raw.expense));
      const category1 = picked && catNames.has(picked) ? picked
        : !picked && catNames.has(guess.category1) ? guess.category1 : '';
      if (picked && !catNames.has(picked)) errors.push({ line, message: `分类「${picked}」不在字典里，已按待分类导入` });
      const item = {
        date, direction, amount, category1,
        category2: String(raw.category2 || '').trim() || (category1 === guess.category1 ? guess.category2 : ''),
        description, operator,
        category_group: groupOf(category1),
        order_no: orderNoOf(description) || orderNoOf(note),
        entity_id: entity?.id || null,
        biz_store_id: store?.id || null,
        counterparty: String(raw.counterparty || '').trim(),
        note,
        source_file: String(sourceFile || '').slice(0, 200),
        raw,
      };
      item.dedupe_key = dedupeKey(item);
      prepared.push(item);
    });
    // 代付配对：个人代购（洗衣机这类）前后会有同额「转入」补钱，把两笔一起按代付抵掉，不参与收支
    const proxies = prepared.filter((row) => row.category2 === '代付（个人代购）');
    for (const proxy of proxies) {
      const mate = prepared.find((row) => row !== proxy && row.direction === 'income' && !row.note
        && Math.abs(row.amount - proxy.amount) < 0.01 && row.category1 === '其他'
        && Math.abs(Date.parse(row.date) - Date.parse(proxy.date)) <= 86400000);
      if (mate) {
        mate.category1 = '内部划转';
        mate.category2 = '代付（个人代购）';
        mate.category_group = '未分类';
      }
    }
    return { prepared, errors, entities, stores };
  }

  // 导入前预览：只跑归一化 + 归类，不写库，让用户先看一眼分类对不对
  async function previewCashflow(userId, body = {}) {
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) throw fail('没有可预览的行', 400);
    if (rows.length > 5000) throw fail('单次最多处理 5000 行', 400);
    const { prepared, errors, entities } = await prepareRows(userId, rows, body.source_file);
    const byCategory = new Map();
    for (const row of prepared) {
      const key = `${row.direction}|${row.category1 || '(待分类)'}`;
      const bucket = byCategory.get(key) || { direction: row.direction, category1: row.category1 || '(待分类)', count: 0, total: 0 };
      bucket.count += 1; bucket.total = moneyOr0(bucket.total + row.amount);
      byCategory.set(key, bucket);
    }
    return {
      rows: prepared.map((row) => ({
        line: Number(row.raw?._line) || 0,
        date: row.date, direction: row.direction, amount: row.amount, description: row.description, note: row.note,
        operator: row.operator, category1: row.category1, category2: row.category2, category_group: row.category_group,
        entity_name: entities.find((e) => e.id === row.entity_id)?.name || '', store_name: '',
      })),
      errors: errors.slice(0, 50),
      summary: [...byCategory.values()].sort((a, b) => b.total - a.total),
      pending: prepared.filter((row) => !row.category1).length,
      total: prepared.length,
    };
  }

  // 说明里的商户单号 / 订单号：退款靠它找原单冲抵
  const ORDER_NO = /(?:商户单号|订单号)\s*[：:]?\s*([A-Za-z]{0,3}\d{8,})/;
  const orderNoOf = (text) => {
    const match = String(text || '').match(ORDER_NO);
    return match ? match[1] : '';
  };

  // 同一份导出里「退款-商户单号X」和「已退款 - 商户单号X」成对出现、金额相同 → 这笔买卖没发生过，
  // 两行都丢掉（否则既算一次采购、又算一次退款，两边都虚高）
  // 退款行的「身份」：优先用商户单号/订单号，没有单号就用去掉前缀的商品说明（很多退款只带商品名）
  const refundKeyOf = (row) => {
    if (row.order_no) return `no:${row.order_no}`;
    const text = String(row.description || '')
      .replace(/^(已退款|退款)\s*-?\s*/, '')
      .replace(/^(商户单号|全款交易[：:]?)/, '')
      .trim();
    return text ? `tx:${text}` : '';
  };

  function cancelRefundPairs(prepared) {
    const groups = new Map();
    for (const row of prepared) {
      if (row.category1 !== '采购退款') continue;
      const key = refundKeyOf(row);
      if (!key) continue;
      const slot = `${key}|${row.amount.toFixed(2)}`;
      if (!groups.has(slot)) groups.set(slot, []);
      groups.get(slot).push(row);
    }
    const dropped = new Set();
    for (const list of groups.values()) {
      const income = list.find((r) => r.direction === 'income');
      const expense = list.find((r) => r.direction === 'expense');
      if (income && expense) { dropped.add(income); dropped.add(expense); }
    }
    return { rows: prepared.filter((row) => !dropped.has(row)), cancelled: dropped.size };
  }

  async function importCashflow(userId, body = {}) {
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) throw fail('没有可导入的行', 400);
    if (rows.length > 5000) throw fail('单次最多导入 5000 行', 400);
    const { prepared: candidates, errors } = await prepareRows(userId, rows, body.source_file);
    const { rows: prepared, cancelled } = cancelRefundPairs(candidates);

    let inserted = 0, skipped = 0;
    if (prepared.length) {
      // 一次性走 jsonb_to_recordset：几千行也能一条 SQL 落库，避免逐行往返拖成长请求
      const payload = prepared.map((p) => ({
        date: p.date, direction: p.direction, amount: p.amount, category1: p.category1, category2: p.category2,
        category_group: p.category_group, description: p.description, operator: p.operator, order_no: p.order_no,
        entity_id: p.entity_id, biz_store_id: p.biz_store_id, counterparty: p.counterparty, note: p.note,
        source_file: p.source_file, dedupe_key: p.dedupe_key, raw: p.raw,
      }));
      const res = await q(`INSERT INTO app_biz_cashflow(user_id,biz_date,direction,amount_cny,currency,category1,category2,
        category_group,description,operator,order_no,entity_id,biz_store_id,counterparty,note,source_file,raw,dedupe_key)
        SELECT $1::uuid, x.date::date, x.direction, x.amount, 'CNY', x.category1, x.category2, x.category_group,
          x.description, x.operator, x.order_no, x.entity_id, x.biz_store_id, x.counterparty, x.note,
          x.source_file, x.raw, x.dedupe_key
        FROM jsonb_to_recordset($2::jsonb) AS x(date text, direction text, amount numeric, category1 text,
          category2 text, category_group text, description text, operator text, order_no text, entity_id uuid,
          biz_store_id uuid, counterparty text, note text, source_file text, dedupe_key text, raw jsonb)
        ON CONFLICT (user_id,dedupe_key) DO NOTHING`, [userId, JSON.stringify(payload)]);
      inserted = res.rowCount || 0;
      skipped = prepared.length - inserted;
    }
    const pending = await q(`SELECT COUNT(*)::int AS n FROM app_biz_cashflow WHERE user_id=$1 AND category1=''`, [userId]);
    return { inserted, skipped, cancelled, errors: errors.slice(0, 50), pending: pending.rows[0].n, parsed: prepared.length };
  }

  async function listCashflow(userId, params = {}) {
    const where = ['user_id=$1'];
    const values = [userId];
    // 按游标顺序拼条件：每个 ? 依次替换成 $n，避免手数索引出错
    const add = (sql, ...args) => {
      where.push(sql.replace(/\?/g, () => { values.push(args.shift()); return `$${values.length}`; }));
    };
    if (params.year && /^\d{4}$/.test(String(params.year))) {
      add(`biz_date >= ?::date AND biz_date < (?::date + interval '1 year')`, `${params.year}-01-01`, `${params.year}-01-01`);
    }
    if (params.month && MONTH.test(String(params.month))) add(`to_char(biz_date,'YYYY-MM') = ?`, String(params.month));
    const direction = directionOf(params.direction);
    if (direction) add('direction = ?', direction);
    if (params.category1) add('category1 = ?', String(params.category1));
    if (params.category2) add('category2 = ?', String(params.category2));
    if (params.operator) add('operator = ?', String(params.operator));
    if (params.status === 'pending') where.push("category1 = ''");
    if (params.status === 'confirmed') where.push("category1 <> ''");
    if (params.entity_id && UUID.test(params.entity_id)) add('entity_id = ?', params.entity_id);
    if (params.biz_store_id && UUID.test(params.biz_store_id)) add('biz_store_id = ?', params.biz_store_id);
    if (params.keyword) add(`(counterparty ILIKE ? OR note ILIKE ? OR category2 ILIKE ?)`,
      `%${params.keyword}%`, `%${params.keyword}%`, `%${params.keyword}%`);
    if (params.date_from && DATE.test(String(params.date_from))) add('biz_date >= ?::date', String(params.date_from));
    if (params.date_to && DATE.test(String(params.date_to))) add('biz_date <= ?::date', String(params.date_to));
    const clause = where.join(' AND ');
    const size = Math.min(500, Math.max(10, parseInt(params.page_size, 10) || 100));
    const page = Math.max(1, parseInt(params.page, 10) || 1);
    const [list, total, sum] = await Promise.all([
      q(`SELECT id, biz_date::text AS date, direction, amount_cny, category1, category2, category_group, description, operator, order_no,
        entity_id, biz_store_id, counterparty, note, source_file, manual_corrected, created_at
        FROM app_biz_cashflow WHERE ${clause} ORDER BY biz_date DESC, created_at DESC, id DESC
        LIMIT ${size} OFFSET ${(page - 1) * size}`, values),
      q(`SELECT COUNT(*)::int AS n FROM app_biz_cashflow WHERE ${clause}`, values),
      q(`SELECT direction, COALESCE(SUM(amount_cny),0) AS total FROM app_biz_cashflow WHERE ${clause} GROUP BY direction`, values),
    ]);
    const totals = { income: 0, expense: 0, net: 0 };
    for (const row of sum.rows) totals[row.direction] = moneyOr0(row.total);
    totals.net = moneyOr0(totals.income - totals.expense);
    return { rows: list.rows.map((r) => ({ ...r, amount_cny: moneyOr0(r.amount_cny) })), total: total.rows[0].n, totals, page, page_size: size };
  }

  async function updateCashflow(userId, id, body = {}) {
    if (!UUID.test(id)) throw fail('流水 ID 不合法', 400);
    const sets = [], values = [];
    const set = (col, value) => { values.push(value); sets.push(`${col}=$${values.length}`); };
    if (body.category1 !== undefined) {
      const next = String(body.category1 || '').trim();
      set('category1', next);
      set('category_group', groupOf(next));
    }
    if (body.category2 !== undefined) set('category2', String(body.category2 || '').trim());
    if (body.entity_id !== undefined) set('entity_id', body.entity_id && UUID.test(body.entity_id) ? body.entity_id : null);
    if (body.biz_store_id !== undefined) set('biz_store_id', body.biz_store_id && UUID.test(body.biz_store_id) ? body.biz_store_id : null);
    if (body.note !== undefined) set('note', String(body.note || ''));
    if (body.counterparty !== undefined) set('counterparty', String(body.counterparty || ''));
    if (body.direction !== undefined) {
      const direction = directionOf(body.direction);
      if (!direction) throw fail('收支方向不合法', 400);
      set('direction', direction);
    }
    if (body.amount !== undefined) {
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw fail('金额必须大于 0', 400);
      set('amount_cny', amount);
    }
    if (body.date !== undefined) {
      if (!DATE.test(String(body.date))) throw fail('日期格式应为 YYYY-MM-DD', 400);
      set('biz_date', String(body.date));
    }
    if (!sets.length) throw fail('没有要更新的字段', 400);
    sets.push('manual_corrected=TRUE', 'corrected_at=now()', 'updated_at=now()');
    values.push(id, userId);
    const { rows } = await q(`UPDATE app_biz_cashflow SET ${sets.join(',')}
      WHERE id=$${values.length - 1} AND user_id=$${values.length} RETURNING id`, values);
    if (!rows[0]) throw fail('流水不存在', 404);
    return rows[0];
  }

  // 批量改分类/归属：勾选一批待分类的行一次处理掉
  async function bulkUpdateCashflow(userId, body = {}) {
    const ids = (Array.isArray(body.ids) ? body.ids : []).filter((id) => UUID.test(id));
    if (!ids.length) throw fail('请选择要修改的流水', 400);
    const sets = [], values = [ids, userId];
    const set = (col, value) => { values.push(value); sets.push(`${col}=$${values.length}`); };
    if (body.category1 !== undefined) {
      const next = String(body.category1 || '').trim();
      set('category1', next);
      set('category_group', groupOf(next));
    }
    if (body.category2 !== undefined) set('category2', String(body.category2 || '').trim());
    if (body.entity_id !== undefined) set('entity_id', body.entity_id && UUID.test(body.entity_id) ? body.entity_id : null);
    if (body.biz_store_id !== undefined) set('biz_store_id', body.biz_store_id && UUID.test(body.biz_store_id) ? body.biz_store_id : null);
    if (!sets.length) throw fail('没有要更新的字段', 400);
    sets.push('manual_corrected=TRUE', 'corrected_at=now()', 'updated_at=now()');
    const { rowCount } = await q(`UPDATE app_biz_cashflow SET ${sets.join(',')} WHERE user_id=$2 AND id=ANY($1::uuid[])`, values);
    return { updated: rowCount };
  }

  async function deleteCashflow(userId, id) {
    if (!UUID.test(id)) throw fail('流水 ID 不合法', 400);
    await q(`DELETE FROM app_biz_cashflow WHERE id=$1 AND user_id=$2`, [id, userId]);
    return { ok: true };
  }

  // 按月 × 分类的资金流水汇总（股东权益页「总览」用）
  async function cashflowMonthlyCategories(userId, year) {
    const years = (Array.isArray(year) ? year : [year]).map((v) => Number(v)).filter(Number.isFinite);
    const ys = years.length ? years.sort((a, b) => a - b) : [new Date().getFullYear()];
    // 带上大类：股东权益总览要按「4 大类 × 12 个月」出花销矩阵
    const { rows } = await q(`SELECT to_char(biz_date,'YYYY-MM') AS month,
        CASE WHEN category1='' THEN '(待分类)' ELSE category1 END AS category1,
        CASE WHEN category2='' THEN '-' ELSE category2 END AS category2,
        COALESCE(NULLIF(category_group,''), '') AS category_group,
        direction, SUM(amount_cny) AS total, COUNT(*)::int AS cnt
      FROM app_biz_cashflow
      WHERE user_id=$1 AND biz_date >= $2::date AND biz_date < $3::date
      GROUP BY 1,2,3,4,5 ORDER BY 1`,
    [userId, `${ys[0]}-01-01`, `${ys[ys.length - 1] + 1}-01-01`]);
    return rows.map((r) => ({ ...r,
      category_group: r.category_group || groupOf(r.category1),
      total: moneyOr0(r.total), cnt: Number(r.cnt) }));
  }

  // 出入总览：按经营主体统计 注资/借款/销售/采购/工资/奖金/成本/盈利（历史全部）
  async function entityFlowSummary(userId) {
    // 主体归属：先用档案里的主体，备注里点名的按备注纠正
    //   备注含「孙总」→ 孙（例：孙总注资 1,700 记在超名下）
    //   备注含「宝」→ 宝（宝储备资金、ETsy宝回款、国宝卖的闲鱼收入）
    //   备注含「ozon 回款」→ 宝（超名下的 Ozon 店铺回款）
    const { rows } = await q(`SELECT COALESCE(e.name, '(未归属)') AS entity_name,
        c.category1, COALESCE(NULLIF(c.category2,''), '-') AS category2,
        c.direction, c.note, SUM(c.amount_cny) AS total
      FROM app_biz_cashflow c
      LEFT JOIN app_biz_entities e ON e.id = c.entity_id
      WHERE c.user_id=$1
      GROUP BY 1,2,3,4,5`, [userId]);
    const EMPTY = () => ({ inject: 0, loan: 0, sales: 0, buy: 0, wage: 0, bonus: 0, cost: 0, other: 0 });
    const map = new Map();
    const bucket = (name) => {
      if (!map.has(name)) map.set(name, EMPTY());
      return map.get(name);
    };
    const effective = (name, note) => {
      const text = String(note || '');
      if (text.includes('孙总')) return '孙';
      if (text.includes('宝')) return '宝';
      if (/ozon\s*回款/i.test(text.replace(/\s+/g, ''))) return '宝';
      return name;
    };
    for (const r of rows) {
      const b = bucket(effective(r.entity_name, r.note));
      const amount = Number(r.total || 0);
      const c1 = r.category1 || '';
      const c2 = r.category2 || '';
      const income = r.direction === 'income';
      if (c1 === '股东权益') {
        if (c2.includes('注资')) b.inject = moneyOr0(b.inject + (income ? amount : -amount));
        else if (c2.includes('借款')) b.loan = moneyOr0(b.loan + (income ? amount : -amount));
      } else if (c1 === '销售回款') {
        // 销售：收入记 +，退款冲减
        b.sales = moneyOr0(b.sales + (income ? amount : -amount));
      } else if (c1 === '原料采购' || c1 === '采购退款') {
        // 采购：支出记 +，退款冲减
        b.buy = moneyOr0(b.buy + (income ? -amount : amount));
      } else if (c1 === '工资奖金') {
        b.wage = moneyOr0(b.wage + (income ? -amount : amount));
      } else if (c1 === '运营激励') {
        // 奖金只认奖项（年终奖/销冠/PB/激励/黄金），吃喝团建算杂支，不计入奖金
        const isAward = /年终奖|销冠|激励|pb|黄金|奖金/i.test(String(r.note || ''));
        if (isAward) b.bonus = moneyOr0(b.bonus + (income ? -amount : amount));
        else b.other = moneyOr0(b.other + (income ? -amount : amount));
      } else if (c1 === '成本') {
        b.cost = moneyOr0(b.cost + (income ? -amount : amount));
      }
    }
    // 只保留人（超/宝/孙），未归属单列
    const list = [...map.entries()].map(([name, v]) => {
      // 盈利把杂支（吃喝团建）也扣掉
      const profit = moneyOr0(v.sales - v.buy - v.cost - v.wage - v.bonus - v.other);
      return { name, ...v, profit };
    }).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    const total = EMPTY();
    for (const row of list) for (const k of Object.keys(total)) total[k] = moneyOr0(total[k] + row[k]);
    total.profit = moneyOr0(total.sales - total.buy - total.cost - total.wage - total.bonus - total.other);
    return { rows: list, total };
  }

  // 公账余额：收入 − 支出。传 before=YYYY-MM-DD 则只算该日期之前（算年初余额用）
  async function cashflowBalance(userId, before) {
    const params = [userId];
    let where = 'user_id=$1';
    if (before) { params.push(String(before)); where += ` AND biz_date < $${params.length}::date`; }
    const { rows } = await q(`SELECT
        COALESCE(SUM(amount_cny) FILTER (WHERE direction='income'), 0) AS income,
        COALESCE(SUM(amount_cny) FILTER (WHERE direction='expense'), 0) AS expense,
        min(biz_date) AS first_date, max(biz_date) AS last_date
      FROM app_biz_cashflow WHERE ${where}`, params);
    const row = rows[0] || {};
    const income = moneyOr0(row.income), expense = moneyOr0(row.expense);
    return { income, expense, balance: moneyOr0(income - expense), first_date: row.first_date, last_date: row.last_date };
  }

  // 汇总：月度收支净额 + 按分类/主体/店铺的构成
  // 交易说明归一化成类型：同一类流水（商户单号/订单号/全款交易…）归到一起，
  //   否则 2836 笔会散成 1500+ 组，没法逐组核对
  const TYPE_EXPR = `CASE
    WHEN description LIKE '商户单号%' THEN '商户单号（付商户）'
    WHEN description LIKE '订单号%' THEN '订单号（平台下单）'
    WHEN description LIKE '全款交易%' THEN '全款交易（商品名）'
    WHEN description LIKE '合并支付订单%' THEN '合并支付订单'
    WHEN description LIKE '退款-%' OR description LIKE '已退款%' THEN '退款 / 已退款'
    WHEN description LIKE '收钱码收款%' THEN '收钱码收款'
    ELSE LEFT(description, 40) END`;

  // 分类核对：按「类型 + 备注 + 当前分类」聚合，方便整组改
  async function reviewGroups(userId, params = {}) {
    const values = [userId];
    const where = ['user_id=$1'];
    if (params.keyword) {
      values.push(`%${String(params.keyword).trim()}%`);
      where.push(`(description ILIKE $${values.length} OR note ILIKE $${values.length})`);
    }
    if (params.status === 'pending') where.push(`category1 = ''`);
    if (params.status === 'done') where.push(`category1 <> ''`);
    const { rows } = await q(`SELECT type, note, category1, category2, direction,
        count(*)::int AS cnt, SUM(amount_cny) AS total
      FROM (SELECT *, ${TYPE_EXPR} AS type FROM app_biz_cashflow WHERE ${where.join(' AND ')}) t
      GROUP BY type, note, category1, category2, direction
      ORDER BY SUM(amount_cny) DESC`, values);
    return rows.map((r) => ({ ...r, total: moneyOr0(r.total), cnt: Number(r.cnt) }));
  }

  // 整组改分类：按「类型 + 备注」命中，把这组所有行一起改
  async function reassignGroup(userId, body = {}) {
    const type = String(body.type || '');
    const note = String(body.note || '');
    const category1 = String(body.category1 || '').trim();
    const category2 = String(body.category2 || '').trim();
    if (!type) throw fail('缺少交易类型', 400);
    if (category1 && ![...DEFAULT_CATEGORIES.expense, ...DEFAULT_CATEGORIES.income].includes(category1)) {
      throw fail(`分类「${category1}」不在字典里`, 400);
    }
    const res = await q(`UPDATE app_biz_cashflow SET category1=$1, category2=$2, category_group=$3, manual_corrected=TRUE
      WHERE user_id=$4 AND COALESCE(note,'')=$5 AND (${TYPE_EXPR})=$6`,
      [category1, category2, groupOf(category1), userId, note, type]);
    return { updated: res.rowCount || 0 };
  }

  // 汇总：按大类 / 二级分类 / 一级分类构成
  // 统计范围由「时间周期」决定（date_from/date_to），也兼容传年份或什么都不传（全量）
  async function cashflowSummary(userId, opts = {}) {
    const o = (opts && typeof opts === 'object') ? opts : { year: opts };
    const hasYear = /^\d{4}$/.test(String(o.year || ''));
    const y = hasYear ? String(o.year) : '';
    const from = DATE.test(String(o.date_from || '')) ? String(o.date_from) : '';
    const to = DATE.test(String(o.date_to || '')) ? String(o.date_to) : '';
    const hasRange = Boolean(from || to);
    let base = 'WHERE user_id=$1';
    let args = [userId];
    if (hasRange) {
      if (from) { args.push(from); base += ` AND biz_date >= $${args.length}::date`; }
      if (to) { args.push(to); base += ` AND biz_date <= $${args.length}::date`; }
    } else if (hasYear) {
      args = [userId, `${y}-01-01`];
      base = `WHERE user_id=$1 AND biz_date >= $2::date AND biz_date < ($2::date + interval '1 year')`;
    }
    const [months, cats, subs, ents, stores, pending] = await Promise.all([
      // 内部划转（转出到余额/银行卡）是真实花掉的钱，计入支出；
      //   transfer_out/transfer_in 只作为「其中多少是转出」的参考列，不再从合计里剔除
      q(`SELECT to_char(biz_date,'YYYY-MM') AS month, direction,
         SUM(amount_cny) AS total,
         SUM(amount_cny) FILTER (WHERE category1 = '内部划转') AS transfer,
         COUNT(*)::int AS cnt
         FROM app_biz_cashflow ${base} GROUP BY 1,2 ORDER BY 1`, args),
      q(`SELECT CASE WHEN category1='' THEN '(待分类)' ELSE category1 END AS category1, direction,
         SUM(amount_cny) AS total, COUNT(*)::int AS cnt FROM app_biz_cashflow ${base} GROUP BY 1,2 ORDER BY 2,3 DESC`, args),
      // 二级分类（明细层）：软件支出看到具体工具、采购看到渠道，便于下钻
      q(`SELECT CASE WHEN category1='' THEN '(待分类)' ELSE category1 END AS category1,
         CASE WHEN category2='' THEN '-' ELSE category2 END AS category2, direction,
         SUM(amount_cny) AS total, COUNT(*)::int AS cnt
         FROM app_biz_cashflow ${base} GROUP BY 1,2,3 ORDER BY 3,4 DESC`, args),
      q(`SELECT entity_id, direction, SUM(amount_cny) AS total FROM app_biz_cashflow ${base} GROUP BY 1,2`, args),
      q(`SELECT biz_store_id, direction, SUM(amount_cny) AS total FROM app_biz_cashflow ${base} GROUP BY 1,2`, args),
      q(`SELECT COUNT(*)::int AS n FROM app_biz_cashflow WHERE user_id=$1 AND category1=''`, [userId]),
    ]);
    const monthKeys = (hasYear && !hasRange)
      ? Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`)
      : [...new Set(months.rows.map((r) => r.month))].sort();
    const monthly = monthKeys.map((key) => ({ month: key, income: 0, expense: 0, net: 0, count: 0, transfer_in: 0, transfer_out: 0 }));
    const index = new Map(monthly.map((m) => [m.month, m]));
    for (const row of months.rows) {
      const bucket = index.get(row.month);
      if (!bucket) continue;
      bucket[row.direction] = moneyOr0(row.total);
      bucket[row.direction === 'income' ? 'transfer_in' : 'transfer_out'] = moneyOr0(row.transfer);
      bucket.count += Number(row.cnt || 0);
    }
    for (const item of monthly) item.net = moneyOr0(item.income - item.expense);
    const byCategory = cats.rows.map((r) => ({ category1: r.category1, direction: r.direction, total: moneyOr0(r.total), count: Number(r.cnt) }));
    // 资金流水口径：退款是真金白银回到钱包，按收支原样统计，不做冲减，
    //   保证「分类构成 / 按大类」的合计与顶部 KPI、与明细逐笔加总完全相等。
    //   能配对的「退款- / 已退款-」在导入阶段已由 cancelRefundPairs 成对抵消，本来就不落库。
    const categoryRows = byCategory;
    // 按大类再聚合一层（内部划转计入未分类，同时算进支出合计）
    const groupMap = new Map();
    for (const row of categoryRows) {
      const group = groupOf(row.category1);
      const bucket = groupMap.get(group) || { category_group: group, income: 0, expense: 0, net: 0, count: 0 };
      if (row.direction === 'income') bucket.income = moneyOr0(bucket.income + row.total);
      else bucket.expense = moneyOr0(bucket.expense + row.total);
      bucket.count += row.count;
      groupMap.set(group, bucket);
    }
    const byGroup = [...groupMap.values()].map((g) => ({ ...g, net: moneyOr0(g.income - g.expense) }))
      .sort((a, b) => (b.income + b.expense) - (a.income + a.expense));
    const bySub = subs.rows.map((r) => ({ category1: r.category1, category2: r.category2, direction: r.direction,
      total: moneyOr0(r.total), count: Number(r.cnt) }));
    const byEntity = ents.rows.map((r) => ({ entity_id: r.entity_id, direction: r.direction, total: moneyOr0(r.total) }));
    const byStore = stores.rows.map((r) => ({ biz_store_id: r.biz_store_id, direction: r.direction, total: moneyOr0(r.total) }));
    const totals = monthly.reduce((acc, m) => ({
      income: moneyOr0(acc.income + m.income), expense: moneyOr0(acc.expense + m.expense),
      transfer_in: moneyOr0(acc.transfer_in + m.transfer_in), transfer_out: moneyOr0(acc.transfer_out + m.transfer_out),
    }), { income: 0, expense: 0, transfer_in: 0, transfer_out: 0 });
    totals.net = moneyOr0(totals.income - totals.expense);
    return { year: hasYear ? Number(y) : null, date_from: from || null, date_to: to || null,
      monthly, byCategory: categoryRows, bySub, byGroup, categoryGroups: CATEGORY_GROUPS, byEntity, byStore, totals, pending: pending.rows[0].n };
  }

  // 导入模板：列固定，顺带把已维护的店铺/主体名字写进说明，减少填错
  async function templateCsv(userId) {
    const { entities, stores, categories } = await bootstrap(userId);
    const header = ['日期', '收支方向', '金额', '一级分类', '二级分类', '经营店铺', '经营主体', '对方', '备注'];
    const sample = [
      ['2026-11-01', '支出', '1200.00', '物流费用', '11月上旬', stores[0]?.name || '', stores[0] ? (entities.find((e) => e.id === stores[0].entity_id)?.name || '') : '', '某某物流', '示例行，导入前删掉'],
      ['2026-11-03', '收入', '8600.00', '销售收入', '', stores[0]?.name || '', stores[0] ? (entities.find((e) => e.id === stores[0].entity_id)?.name || '') : '', '', '示例行，导入前删掉'],
    ];
    const escape = (value) => {
      const text = String(value ?? '');
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [header, ...sample].map((row) => row.map(escape).join(','));
    lines.push('');
    lines.push(`# 收支方向：收入 / 支出；金额只支持人民币，其他币种请先换算`);
    lines.push(`# 经营主体可选：${entities.map((e) => e.name).join(' / ') || '（未维护）'}`);
    lines.push(`# 经营店铺可选：${stores.map((s) => s.name).join(' / ') || '（未维护）'}`);
    lines.push(`# 一级分类（支出）：${categories.filter((c) => c.direction === 'expense').map((c) => c.name).join(' / ')}`);
    lines.push(`# 一级分类（收入）：${categories.filter((c) => c.direction === 'income').map((c) => c.name).join(' / ')}`);
    lines.push('# 一级分类留空也可以导入，会进「待分类」等你手动选');
    return `\ufeff${lines.join('\r\n')}\r\n`;
  }

  function register(app, requireAuth) {
    const route = (method, url, action) => app[method](PREFIX + url, requireAuth, async (req, res, next) => {
      try {
        res.setHeader('Cache-Control', 'no-store');
        await action(req, res, req.user.id);
      } catch (error) { next(error); }
    });

    route('get', '/bootstrap', async (req, res, userId) => {
      await ensureUserCatalog(userId);
      res.json({ success: true, ...(await bootstrap(userId)) });
    });

    route('post', '/entities', async (req, res, userId) => {
      res.json({ success: true, entity: await saveEntity(userId, req.body) });
    });
    route('delete', '/entities/:id', async (req, res, userId) => {
      res.json({ success: true, ...(await deleteEntity(userId, String(req.params.id))) });
    });
    route('post', '/stores', async (req, res, userId) => {
      res.json({ success: true, store: await saveStore(userId, req.body) });
    });
    route('delete', '/stores/:id', async (req, res, userId) => {
      res.json({ success: true, ...(await deleteStore(userId, String(req.params.id))) });
    });
    route('post', '/categories', async (req, res, userId) => {
      res.json({ success: true, category: await saveCategory(userId, req.body) });
    });
    route('delete', '/categories/:id', async (req, res, userId) => {
      res.json({ success: true, ...(await deleteCategory(userId, String(req.params.id))) });
    });

    route('get', '/overview', async (req, res, userId) => {
      // years=2025,2026 取跨年区间；只传 year 则按单年（兼容老调用）
      const years = req.query.years ? String(req.query.years).split(',').map((v) => Number(v)) : req.query.year;
      res.json({ success: true, ...(await overview(userId, years)) });
    });
    route('get', '/manual', async (req, res, userId) => {
      const years = req.query.years ? String(req.query.years).split(',').map((v) => Number(v)) : (req.query.year || new Date().getFullYear());
      res.json({
        success: true,
        rows: await listManualMonths(userId, years, {
          entity_id: req.query.entity_id, platform: req.query.platform,
        }),
      });
    });
    route('post', '/manual', async (req, res, userId) => {
      res.json({ success: true, row: await saveManualMonth(userId, req.body) });
    });
    route('get', '/month-notes', async (req, res, userId) => {
      const years = req.query.years ? String(req.query.years).split(',').map((v) => Number(v)) : (req.query.year || new Date().getFullYear());
      res.json({ success: true, rows: await listMonthNotes(userId, years) });
    });
    route('get', '/equity-holders', async (req, res, userId) => {
      res.json({ success: true, rows: await listEquityHolders(userId) });
    });
    route('post', '/equity-holders', async (req, res, userId) => {
      res.json({ success: true, row: await saveEquityHolder(userId, req.body) });
    });
    route('get', '/records', async (req, res, userId) => {
      const years = req.query.years ? String(req.query.years).split(',').map((v) => Number(v)) : (req.query.year || new Date().getFullYear());
      res.json({ success: true, ...(await recordHistory(userId, years)) });
    });
    route('get', '/entity-flow', async (req, res, userId) => {
      res.json({ success: true, ...(await entityFlowSummary(userId)) });
    });
    route('get', '/cashflow/balance', async (req, res, userId) => {
      res.json({ success: true, ...(await cashflowBalance(userId, req.query.before)) });
    });
    route('get', '/cashflow/monthly-categories', async (req, res, userId) => {
      const years = req.query.years ? String(req.query.years).split(',').map((v) => Number(v)) : (req.query.year || new Date().getFullYear());
      res.json({ success: true, rows: await cashflowMonthlyCategories(userId, years) });
    });
    route('post', '/month-notes', async (req, res, userId) => {
      res.json({ success: true, row: await saveMonthNote(userId, req.body) });
    });
    route('get', '/etsy', async (req, res, userId) => {
      res.json({ success: true, rows: await listEtsyMonths(userId, req.query.year || new Date().getFullYear()) });
    });
    route('post', '/etsy', async (req, res, userId) => {
      res.json({ success: true, row: await saveEtsyMonth(userId, req.body) });
    });
    route('delete', '/etsy/:storeId/:month', async (req, res, userId) => {
      res.json({ success: true, ...(await deleteEtsyMonth(userId, String(req.params.storeId), String(req.params.month))) });
    });

    route('get', '/cashflow', async (req, res, userId) => {
      res.json({ success: true, ...(await listCashflow(userId, req.query)) });
    });
    route('get', '/cashflow/review-groups', async (req, res, userId) => {
      res.json({ success: true, rows: await reviewGroups(userId, req.query) });
    });
    route('post', '/cashflow/reassign-group', async (req, res, userId) => {
      res.json({ success: true, ...(await reassignGroup(userId, req.body)) });
    });
    route('get', '/cashflow/summary', async (req, res, userId) => {
      res.json({ success: true, ...(await cashflowSummary(userId, req.query)) });
    });
    route('get', '/cashflow/template', async (req, res, userId) => {
      const csv = await templateCsv(userId);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="cashflow-template.csv"`);
      res.send(csv);
    });
    route('post', '/cashflow/preview', async (req, res, userId) => {
      res.json({ success: true, ...(await previewCashflow(userId, req.body)) });
    });
    route('post', '/cashflow/import', async (req, res, userId) => {
      res.json({ success: true, ...(await importCashflow(userId, req.body)) });
    });
    route('patch', '/cashflow/:id', async (req, res, userId) => {
      res.json({ success: true, ...(await updateCashflow(userId, String(req.params.id), req.body)) });
    });
    route('post', '/cashflow/bulk', async (req, res, userId) => {
      res.json({ success: true, ...(await bulkUpdateCashflow(userId, req.body)) });
    });
    route('delete', '/cashflow/:id', async (req, res, userId) => {
      res.json({ success: true, ...(await deleteCashflow(userId, String(req.params.id))) });
    });
  }

  return {
    init, register, bootstrap, overview, reviewGroups, reassignGroup, listManualMonths, saveManualMonth, listMonthNotes, saveMonthNote, cashflowMonthlyCategories, cashflowBalance, entityFlowSummary, listEquityHolders, saveEquityHolder, recordHistory, listEtsyMonths, saveEtsyMonth, importCashflow, previewCashflow,
    listCashflow, updateCashflow, bulkUpdateCashflow, cashflowSummary,
    // 档案维护（也直接暴露出来，便于脚本/自检调用）
    saveEntity, deleteEntity, saveStore, deleteStore, saveCategory, deleteCategory,
  };
}
