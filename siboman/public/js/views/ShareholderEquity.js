// 经营分析 · 股东权益
//
// 两个 tab：
//   总览      左 3/5：股权结构 + 上月资金流水；右 2/5：股东规则（一～六节）
//   资金流水  直接复用 CashFlow 视图（embedded 模式，不重复显示它自己的页头）
//
// 股权与规则目前按用户给的表/文档写死在前端常量里；后续要改成可维护，
// 把 EQUITY_ROWS / RULES 挪到数据表 + 接口即可（版式不用动）。
window.ShareholderEquityView = {
  setup() {
    const { ref, computed, onMounted } = Vue;

    const tab = ref('overview');
    const loading = ref(false);
    const error = ref('');
    const START_MONTH = '2025-08';

    // ── 股权结构（来源：用户 2026-11-09 给的表） ──
    // 股东固定信息（比例来自用户给的表）；PB / 团队 TOP 由经营总览数据动态计算
    const HOLDERS = [
      { key: 'chao', name: '庄国超', ratio: '30', founder: '5', reserve: '0', record: 'chao', unpaidDefault: '0.8 克存金' },
      { key: 'bao', name: '庄国宝', ratio: '20', founder: '0', reserve: '5', record: 'bao', unpaidDefault: '无' },
      { key: 'sun', name: '孙程锦', ratio: '30', founder: '0', reserve: '0', record: '', unpaidDefault: '25 年分红' },
      { key: 'rest', name: '剩余部分', ratio: '—', founder: '—', reserve: '10', record: '', unpaidDefault: '' },
    ];

    // ── 股东规则（来源：用户 2026-11-09 给的文档） ──
    const LADDER = {
      headers: ['0~10999', '11000~11999', '12000~12999', '13000~13999', '14000~14999', '15000~15999', '16000~16999', '17000~17999', '18000~18999', '19000~19999', '>20000'],
      ratios: ['10%', '11%', '12%', '13%', '14%', '15%', '16%', '17%', '18%', '19%', '20%'],
    };
    const RULES = [
      {
        title: '一、份额规则',
        items: [
          '① 固定份额：股东未增加时不变、增加时按比例稀释；',
          '② 激励份额（创始人 5%）：不变、不参与稀释；',
          '③ 待分配 / 预留部分：随股东增加一并稀释。',
        ],
      },
      {
        title: '二、出资与资金安全',
        items: [
          '小荷包安全值：低于安全值由股东按股权占比注资；',
          '庄国宝因实际情况，短时间无法参与注资，预留股份需等待补充注资资金后进行归还。',
        ],
      },
      {
        title: '三、运营激励（店铺运营）',
        items: [
          '（一）归集口径：Etsy 类型按下单时间归集到月度（9 月即下单日在 9-1 至 9-30 的订单）；Ozon 自 9 月起按签收日归集（数据精准，无需预估）。',
          '（二）激励基数：以毛利计算，即扣除广告、物流等支出后的利润。',
          '（三）阶梯（按月度毛利）：低于 10000 按 10% 提取，不足 1000 补足到 1000；10000 起每增加 1000 比例 +1 个百分点；20000 及以上 20% 封顶。',
        ],
        ladder: true,
      },
      {
        title: '四、分红',
        items: [
          '触发：公账大于 5 万（暂定）的部分；',
          '决策：所有人一致决策后可开启；',
          '分配：按「股权 + 激励」等比例；',
          '余额：多余部分留在公账。',
        ],
      },
      {
        title: '五、专项奖励',
        items: [
          '（一）月度销冠奖：所有参与运营的人员当月竞争，以运营者个人为单位、毛利最高者获奖 0.2g 黄金；可按当日金价折现或攒至年底一次性提取。',
          '（二）个人 PB 激励：PB 为个人历史最高月毛利，当月刷新即触发，按刷新后数值分档 —— 20000 以下奖 500，20000 以上奖 1000。',
          '（三）团队 TOP 激励：按月，月度毛利总量刷新团队历史最高即触发，所有参与运营的人员每人 500。',
          '（四）三项奖励可叠加。',
        ],
      },
      {
        title: '六、当前临时应对方案',
        items: [
          '背景：因 Ozon 爆单，小荷包已透支，预估费用缺口约 9 万。解决路径为股东注资或股东借款。当下按以下顺序与份额开展，且均按「需归还」处理（即按借款处理）：',
          '1. 孙程锦先借款 30,000，后续需归还；',
          '2. 待资金不足 5,000 时，庄国超借款 15,000，后续需归还；',
          '3. 待资金再次不足 5,000 时，孙程锦再借款 45,000，后续需归还。',
          '以上三笔合计 90,000，与预估缺口一致；后续持续跟进。',
        ],
      },
    ];

    const nowMonth = () => {
      const d = new Date(Date.now() + 8 * 3600000);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    };
    // 上月（相对当前月往前一个月）
    const lastMonth = computed(() => {
      const [y, m] = nowMonth().split('-').map(Number);
      const d = new Date(Date.UTC(y, m - 2, 1));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    });
    const yearList = computed(() => {
      const end = Number(nowMonth().slice(0, 4));
      const list = [];
      for (let y = end; y >= Number(START_MONTH.slice(0, 4)); y -= 1) list.push(y);
      return list;
    });

    const money = (value) => value == null ? '—'
      : Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmt = (value) => (Number(value || 0) === 0 ? '—' : money(value));
    const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

    // 原始明细：{ month, category1, direction, total, cnt }
    const rows = ref([]);
    // 团队 TOP / 个人 PB 的记录历史（由经营总览数据算）
    const records = ref({ team: { current: null, history: [] }, chao: { current: null, history: [] }, bao: { current: null, history: [] }, cutoff: '' });
    // 股权行人工字段：holder_key -> unpaid
    const holderMeta = ref({});
    // 公账余额（全部流水收入−支出，不限年份）
    const cashBalance = ref({ income: 0, expense: 0, balance: null });
    // 本年初的公账余额（算每月累计结余的起点）
    const openingBalance = ref(0);
    // 出入总览：按人统计的历史流水
    const entityFlow = ref({ rows: [], total: null });

    const load = async () => {
      loading.value = true; error.value = '';
      try {
        const [cf, rec, holders, bal] = await Promise.all([
          axios.get('/api/biz-analysis/cashflow/monthly-categories', { params: { years: yearList.value.join(',') } }),
          axios.get('/api/biz-analysis/records', { params: { years: yearList.value.join(',') } }),
          axios.get('/api/biz-analysis/equity-holders'),
          axios.get('/api/biz-analysis/cashflow/balance'),
        ]);
        const flow = await axios.get('/api/biz-analysis/entity-flow');
        entityFlow.value = { rows: flow.data.rows || [], total: flow.data.total || null };
        cashBalance.value = { income: bal.data.income || 0, expense: bal.data.expense || 0, balance: bal.data.balance };
        // 再取「本年初」余额作为每月累计结余的起点
        const opening = await axios.get('/api/biz-analysis/cashflow/balance', {
          params: { before: `${currentYear.value}-01-01` },
        });
        openingBalance.value = Number(opening.data.balance || 0);
        rows.value = cf.data.rows || [];
        records.value = {
          team: rec.data.team || { current: null, history: [] },
          chao: rec.data.chao || { current: null, history: [] },
          bao: rec.data.bao || { current: null, history: [] },
          cutoff: rec.data.cutoff || '',
        };
        const meta = {};
        for (const row of (holders.data.rows || [])) meta[row.holder_key] = row.unpaid;
        holderMeta.value = meta;
      } catch (e) {
        error.value = e?.response?.data?.error || e?.message || '请求失败';
      } finally {
        loading.value = false;
      }
    };

    // 上月资金流水：按「分类 + 收支」汇总
    const lastMonthRows = computed(() => {
      const map = new Map();
      for (const row of rows.value) {
        if (row.month !== lastMonth.value) continue;
        const key = `${row.direction}|${row.category1}`;
        const hit = map.get(key);
        if (hit) {
          hit.total = r2(hit.total + Number(row.total || 0));
          hit.cnt += Number(row.cnt || 0);
        } else {
          map.set(key, {
            direction: row.direction,
            category1: row.category1,
            total: r2(Number(row.total || 0)),
            cnt: Number(row.cnt || 0),
          });
        }
      }
      return [...map.values()].sort((a, b) => {
        if (a.direction !== b.direction) return a.direction === 'income' ? -1 : 1;
        return b.total - a.total;
      });
    });

    const lastMonthTotals = computed(() => {
      let income = 0, expense = 0;
      for (const row of lastMonthRows.value) {
        if (row.direction === 'income') income = r2(income + row.total);
        else expense = r2(expense + row.total);
      }
      return { income, expense, net: r2(income - expense) };
    });

    // 表格行：静态比例 + 动态 PB + 人工未发放
    const equityRows = computed(() => HOLDERS.map((h) => ({
      ...h,
      pb: h.record ? records.value[h.record] : null,
      unpaid: holderMeta.value[h.key] !== undefined ? holderMeta.value[h.key] : h.unpaidDefault,
    })));
    const teamRecord = computed(() => records.value.team || { current: null, history: [] });
    // 记录只算到「完整月份」：最近两个月仍在结算，不参与
    const cutoffLabel = computed(() => (records.value.cutoff ? monthText(records.value.cutoff) : '—'));

    const monthText = (month) => {
      if (!month) return '—';
      const [y, m] = String(month).split('-');
      return `${y.slice(2)} 年 ${Number(m)} 月`;
    };
    const shortMonth = (month) => String(month || '').slice(2);
    const recentHistory = (list) => (list || []).slice(-4);
    // 累计未发放：失焦保存
    const saveUnpaid = async (row) => {
      const text = String(row.unpaid == null ? '' : row.unpaid);
      if (text === (holderMeta.value[row.key] !== undefined ? holderMeta.value[row.key] : row.unpaidDefault)) return;
      try {
        await axios.post('/api/biz-analysis/equity-holders', { holder_key: row.key, unpaid: text });
        holderMeta.value = { ...holderMeta.value, [row.key]: text };
      } catch (e) {
        error.value = e?.response?.data?.error || e?.message || '保存失败';
      }
    };

    // 「今年度流出结余」用：本年度是否有流水
    // 出入总览行：注资 / 借款 / 销售 / 采购 / 工资 / 奖金 / 盈利
    const FLOW_ROWS = [
      { key: 'inject', label: '注资', tone: 'in' },
      { key: 'loan', label: '借款', tone: 'in' },
      { key: 'sales', label: '销售', tone: 'in' },
      { key: 'buy', label: '采购', tone: 'out' },
      { key: 'wage', label: '工资', tone: 'out' },
      { key: 'bonus', label: '奖金', tone: 'out' },
      { key: 'other', label: '杂支', tone: 'out' },
      { key: 'profit', label: '盈利', tone: 'profit' },
    ];
    // 固定顺序：超 / 宝 / 孙，其它（未归属等）排后面
    const flowColumns = computed(() => {
      const order = ['超', '宝', '孙'];
      return entityFlow.value.rows.map((r) => r.name).sort((a, b) => {
        const ia = order.indexOf(a); const ib = order.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
    });
    const flowRow = (name, key) => {
      const hit = entityFlow.value.rows.find((r) => r.name === name);
      return hit ? hit[key] : 0;
    };

    const hasCashflow = computed(() => rows.value.some((r) => String(r.month || '').slice(0, 4) === currentYear.value));
    const lastMonthLabel = computed(() => {
      const [y, m] = lastMonth.value.split('-');
      return `${y.slice(2)} 年 ${Number(m)} 月`;
    });

    // ── 今年度流出结余：月份为行，二级分类为列（大类/二级分类都用导入值，全量罗列）──
    // 数值：收入记 +，支出记 −；最右「结余」= 该月各分类相加
    const currentYear = computed(() => nowMonth().slice(0, 4));
    const currentYearLabel = computed(() => `${currentYear.value} 年`);
    const GROUP_ORDER = ['销售类', '采购类', '成本类', '经营类', '未分类'];

    const subCategoryMatrix = computed(() => {
      const y = currentYear.value;
      const months = Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);
      const groups = new Map(); // 大类 -> Map(key -> {key,label,monthVals,total})
      for (const row of rows.value) {
        const month = String(row.month || '');
        if (month.slice(0, 4) !== y) continue;
        const groupName = row.category_group || '未分类';
        const subName = (row.category2 && row.category2 !== '-') ? row.category2 : (row.category1 || '(未分类)');
        const key = `${groupName}#${subName}`;
        if (!groups.has(groupName)) groups.set(groupName, new Map());
        const subs = groups.get(groupName);
        if (!subs.has(key)) subs.set(key, { key, label: subName, cells: new Array(12).fill(0), total: 0 });
        const item = subs.get(key);
        const idx = Number(month.slice(5, 7)) - 1;
        if (idx < 0 || idx > 11) continue;
        const signed = r2(Number(row.total || 0) * (row.direction === 'income' ? 1 : -1));
        item.cells[idx] = r2(item.cells[idx] + signed);
        item.total = r2(item.total + signed);
      }
      const groupList = [...groups.entries()]
        .sort((a, b) => {
          const ia = GROUP_ORDER.indexOf(a[0]); const ib = GROUP_ORDER.indexOf(b[0]);
          return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        })
        .map(([group, subs]) => ({
          group,
          items: [...subs.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total)),
        }));

      // 行 = 月份：本月进账（当月净变动）+ 公账结余（年初余额往后累加）
      let running = r2(openingBalance.value);
      const monthRows = months.map((month, i) => {
        const cells = {};
        let total = 0;
        for (const g of groupList) {
          for (const it of g.items) {
            const v = it.cells[i];
            cells[it.key] = v;
            total = r2(total + v);
          }
        }
        running = r2(running + total);
        return { month, label: `${i + 1} 月`, cells, total, inflow: total, balance: running };
      });
      const grandTotal = r2(monthRows.reduce((a, b) => a + b.total, 0));
      const endBalance = monthRows.length ? monthRows[monthRows.length - 1].balance : r2(openingBalance.value);
      return { months, groups: groupList, rows: monthRows, grandTotal, endBalance, openingBalance: r2(openingBalance.value) };
    });

    onMounted(load);

    return {
      tab, loading, error, rows, lastMonthRows, lastMonthTotals, lastMonthLabel, hasCashflow, money, fmt, load,
      subCategoryMatrix, currentYearLabel, cashBalance, entityFlow, flowColumns, flowRow, FLOW_ROWS,
      equityRows, teamRecord, cutoffLabel, monthText, shortMonth, recentHistory, saveUnpaid,
      rules: RULES, ladder: LADDER,
    };
  },
  template: `
  <section class="erp-route-page biz-page">
    <header class="biz-head">
      <div>
        <h1 class="biz-title">股东权益</h1>
        <p class="biz-sub">股权结构、股东规则，以及按月形成的资金流水分类；明细在「资金流水」页签</p>
      </div>
      <div class="biz-head-actions">
        <el-button :icon="'Refresh'" @click="load">刷新</el-button>
      </div>
    </header>

    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="biz-alert" />

    <el-tabs v-model="tab" class="biz-tabs">
      <!-- ───────── 总览 ───────── -->
      <el-tab-pane label="总览" name="overview">
        <div class="biz-eq-layout">
          <div class="biz-eq-left">
            <!-- 股权结构 -->
            <article class="biz-matrix-card">
              <div class="biz-matrix-title">
                <span>股权结构 <small>（%）</small></span>
                <span class="biz-muted">合计 100%</span>
              </div>
              <div class="biz-matrix-wrap">
                <table class="biz-matrix biz-equity-table">
                  <thead>
                    <tr>
                      <th>股东</th>
                      <th>股权占比</th>
                      <th>创始人</th>
                      <th>预留</th>
                      <th>团队 TOP</th>
                      <th>个人 PB 时间</th>
                      <th>个人 PB 金额</th>
                      <th>累计未发放</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(row, i) in equityRows" :key="row.key">
                      <td class="biz-eq-name">{{ row.name }}</td>
                      <td class="biz-num">{{ row.ratio }}</td>
                      <td class="biz-num">{{ row.founder }}</td>
                      <td class="biz-num">{{ row.reserve }}</td>
                      <td v-if="i === 0" :rowspan="equityRows.length - 1" class="biz-eq-top">
                        <el-tooltip v-if="teamRecord.current" placement="right" :show-after="120">
                          <template #content>
                            <div class="biz-tip">
                              <div class="biz-tip-title">团队 TOP 记录</div>
                              <div v-for="h in teamRecord.history" :key="h.month">{{ shortMonth(h.month) }} · ¥{{ money(h.value) }}</div>
                            </div>
                          </template>
                          <span class="biz-eq-top-inner">
                            <strong>{{ monthText(teamRecord.current.month) }}</strong>
                            <span>¥{{ money(teamRecord.current.value) }}</span>
                          </span>
                        </el-tooltip>
                        <span v-else class="biz-muted">暂无</span>
                      </td>
                      <td v-else-if="i === equityRows.length - 1"></td>
                      <td>{{ row.pb && row.pb.current ? monthText(row.pb.current.month) : '—' }}</td>
                      <td class="biz-num">
                        <el-tooltip v-if="row.pb && row.pb.current" placement="top" :show-after="120">
                          <template #content>
                            <div class="biz-tip">
                              <div class="biz-tip-title">{{ row.name }} · PB 记录</div>
                              <div v-for="h in row.pb.history" :key="h.month">{{ shortMonth(h.month) }} · ¥{{ money(h.value) }}</div>
                            </div>
                          </template>
                          <span>{{ money(row.pb.current.value) }}</span>
                        </el-tooltip>
                        <span v-else>—</span>
                      </td>
                      <td class="biz-eq-unpaid">
                        <input v-model="row.unpaid" class="biz-note-input" placeholder="填写…"
                          @change="saveUnpaid(row)" @blur="saveUnpaid(row)" @keyup.enter="$event.target.blur()" />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p class="biz-muted" style="margin:8px 0 0">
                股权占比 + 创始人激励 + 预留（含剩余部分）合计 100%。
                团队 TOP / 个人 PB 自动取「经营总览」的月度毛利，只统计到 {{ cutoffLabel }}（最近两个月仍在结算，不计入记录）。
              </p>
            </article>

            <!-- 今年度流出结余：月份为行，二级分类为列 -->
            <article class="biz-matrix-card">
              <div class="biz-matrix-title">
                <span>今年度流出结余 <small>（{{ currentYearLabel }} · 月份 × 二级分类）</small></span>
                <span class="biz-muted">
                  {{ currentYearLabel }}结余 {{ money(subCategoryMatrix.grandTotal) }}
                  · 公账余额 <b :class="(cashBalance.balance || 0) < 0 ? 'biz-num-neg' : 'biz-pos'">{{ money(cashBalance.balance) }}</b>
                </span>
              </div>
              <div v-if="!hasCashflow" class="biz-equity-empty">
                <p>{{ currentYearLabel }}还没有资金流水。</p>
                <p class="biz-muted">到「资金流水」页签导入后，这里自动按月归类。</p>
              </div>
              <div v-else class="biz-matrix-wrap">
                <table class="biz-matrix biz-year-matrix">
                  <thead>
                    <tr>
                      <th class="biz-col-month" rowspan="2">月份</th>
                      <th rowspan="2" class="biz-total-head">本月进账</th>
                      <th rowspan="2" class="biz-total-head">公账结余</th>
                      <th v-for="g in subCategoryMatrix.groups" :key="g.group" :colspan="g.items.length" class="biz-group-head">{{ g.group }}</th>
                    </tr>
                    <tr>
                      <template v-for="g in subCategoryMatrix.groups" :key="'sub-' + g.group">
                        <th v-for="it in g.items" :key="it.key" class="biz-sub-head">{{ it.label }}</th>
                      </template>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in subCategoryMatrix.rows" :key="row.month">
                      <td class="biz-col-month">{{ row.label }}</td>
                      <td class="biz-num biz-col-total" :class="row.inflow < 0 ? 'biz-num-neg' : ''">{{ fmt(row.inflow) }}</td>
                      <td class="biz-num biz-col-balance" :class="row.balance < 0 ? 'biz-num-neg' : ''">{{ fmt(row.balance) }}</td>
                      <template v-for="g in subCategoryMatrix.groups" :key="'v-' + g.group">
                        <td v-for="it in g.items" :key="it.key" class="biz-num" :class="row.cells[it.key] < 0 ? 'biz-num-neg' : ''">{{ fmt(row.cells[it.key]) }}</td>
                      </template>
                    </tr>
                  </tbody>
                  <tfoot>
                    <tr>
                      <td class="biz-col-month">合计</td>
                      <td class="biz-num biz-col-total" :class="subCategoryMatrix.grandTotal < 0 ? 'biz-num-neg' : ''">{{ fmt(subCategoryMatrix.grandTotal) }}</td>
                      <td class="biz-num biz-col-balance" :class="subCategoryMatrix.endBalance < 0 ? 'biz-num-neg' : ''">{{ fmt(subCategoryMatrix.endBalance) }}</td>
                      <template v-for="g in subCategoryMatrix.groups" :key="'t-' + g.group">
                        <td v-for="it in g.items" :key="it.key" class="biz-num" :class="it.total < 0 ? 'biz-num-neg' : ''">{{ fmt(it.total) }}</td>
                      </template>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <p class="biz-muted" style="margin:8px 0 0">
                本月进账 = 该月收入 − 支出（各分类相加）；公账结余 = 年初余额 {{ money(subCategoryMatrix.openingBalance) }} 往后逐月累加。大类和二级分类都按导入数据原样罗列。
              </p>
            </article>
          </div>

          <!-- 右 2/5：股东规则整块 -->
          <aside class="biz-eq-right">
            <article class="biz-matrix-card biz-flow-card">
              <div class="biz-matrix-title">
                <span>出入总览 <small>（历史全部）</small></span>
                <span class="biz-muted">单位：元</span>
              </div>
              <div class="biz-flow-wrap">
              <table class="biz-matrix biz-flow-table">
                <thead>
                  <tr>
                    <th>项目</th>
                    <th v-for="name in flowColumns" :key="name">{{ name }}</th>
                    <th class="biz-flow-total">合计</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="item in FLOW_ROWS" :key="item.key" :class="'biz-flow-' + item.tone">
                    <td class="biz-flow-name">{{ item.label }}</td>
                    <td v-for="name in flowColumns" :key="name + item.key" class="biz-num">
                      {{ fmt(flowRow(name, item.key)) }}
                    </td>
                    <td class="biz-num biz-flow-total">{{ fmt(entityFlow.total ? entityFlow.total[item.key] : 0) }}</td>
                  </tr>
                </tbody>
              </table>
              </div>
              <p class="biz-muted" style="margin:8px 0 0">
                归属以档案主体为准，备注点名的按备注纠正（含「孙总」→孙、含「宝」→宝、含「Ozon 回款」→宝）。
                奖金只算年终奖 / 销冠 / PB / 激励；团建餐饮归「杂支」。盈利 = 销售 − 采购 − 成本 − 工资 − 奖金 − 杂支。
              </p>
            </article>

            <article class="biz-matrix-card">
              <div class="biz-matrix-title">
                <span>股东规则</span>
                <span class="biz-muted">份额 · 出资 · 激励 · 分红 · 奖励 · 临时方案</span>
              </div>
              <div class="biz-rules">
                <section v-for="rule in rules" :key="rule.title" class="biz-rule">
                  <h4>{{ rule.title }}</h4>
                  <p v-for="(item, i) in rule.items" :key="i">{{ item }}</p>
                  <div v-if="rule.ladder" class="biz-ladder-wrap">
                    <table class="biz-matrix biz-ladder">
                      <thead>
                        <tr>
                          <th>毛利</th>
                          <th v-for="h in ladder.headers" :key="h">{{ h }}</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td>比例</td>
                          <td v-for="(r, i) in ladder.ratios" :key="i">{{ r }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            </article>
          </aside>
        </div>
      </el-tab-pane>

      <!-- ───────── 资金流水明细 ───────── -->
      <el-tab-pane label="资金流水" name="cashflow" lazy>
        <cash-flow-view :embedded="true" />
      </el-tab-pane>
    </el-tabs>
  </section>`,
};
