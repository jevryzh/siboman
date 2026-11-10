// 经营分析 · 经营总览
//
// 展示结构（2026-11-09 按用户给的表格重做）：
//   行 = 月份，从 2025-08 一直排到当前月（倒序），每年末尾插一行「XX 年合计」
//   列 = 固定版式：ETSY 超（销售/广告/毛利）→ OZON（收入/广告/毛利）→ ETSY 宝（收入/广告/毛利）
//        → 国宝合计 → 团队合计营收；孙 暂不展示
//   列块是「版式固定、数据挂档案」：店铺档案还没建时列块照样显示，只是整列「—」，
//   档案一建（或导入后自动匹配上）立刻有数。
// 口径：
//   Etsy → 销售 / 广告 / 毛利（月度录入）
//   Ozon → 收入 / 广告 / 毛利（月结口径：收入 = 销售 − 代扣 − 采购 − 贴单 = 毛利 + 广告）
//   国宝合计 = 名字带「宝」的主体名下各店收入合计
//   团队合计营收 = 展示出来的所有块（超 + 宝）收入合计
window.BusinessOverviewView = {
  setup() {
    const { ref, computed, onMounted, onBeforeUnmount, nextTick } = Vue;
    const loading = ref(false);
    const error = ref('');
    const data = ref({ entities: [], totals: {}, unassigned: [], exchange_rate: null, year: null });
    // 月度备注：月份 -> 文本（进页面时取一次，改动后只往回写，不再触发表格重算）
    const notes = ref({});
    const notesSaved = {};
    const profile = ref({ entities: [], stores: [], categories: [], ozon_shops: [] });

    const message = (e) => e?.response?.data?.error || e?.message || '请求失败';
    const money = (value, digits = 2) => value == null ? '—'
      : Number(value).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
    const monthLabel = (month) => `${Number(String(month).slice(5, 7))}月`;
    const platformLabel = (platform) => platform === 'etsy' ? 'Etsy' : platform === 'ozon' ? 'Ozon' : platform;

    // 北京时间当前月（YYYY-MM）
    const nowMonth = () => {
      const d = new Date(Date.now() + 8 * 3600000);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    };
    // 列表起点：用户要求从 2025-08 开始，往上自动长到当前月
    const START_MONTH = '2025-08';
    // 最近两个月（当月 + 上月）仍在结算，数据不完整 → 不参与销冠 / PB 记录
    const completeCutoff = computed(() => {
      const [y, m] = nowMonth().split('-').map(Number);
      const d = new Date(Date.UTC(y, m - 1 - 2, 1));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    });

    // ── 矩阵列定义 ──
    const HIDDEN_ENTITIES = ['孙'];
    const PLATFORM_COLS = {
      etsy: [
        { key: 'revenue_cny', label: '销售' },
        { key: 'ad_cny', label: '广告' },
        { key: 'profit_cny', label: '毛利' },
      ],
      ozon: [
        { key: 'revenue_cny', label: '收入' },
        { key: 'ad_cny', label: '广告' },
        { key: 'profit_cny', label: '毛利' },
      ],
    };
    // 固定列块版式：谁的哪个平台，按这个顺序排（店铺档案没建也占位）
    const BLOCK_PLAN = [
      { entity: '超', platform: 'etsy' },
      { entity: '宝', platform: 'ozon' },
      { entity: '宝', platform: 'etsy' },
    ];
    const TONES = ['blue', 'green', 'green', 'amber'];
    const isBao = (name) => String(name || '').includes('宝');

    // ── 月份序列：当前月 → 2025-08，倒序 ──
    const monthList = computed(() => {
      const end = nowMonth();
      const list = [];
      let y = Number(end.slice(0, 4));
      let m = Number(end.slice(5, 7));
      while (true) {
        const key = `${y}-${String(m).padStart(2, '0')}`;
        if (key < START_MONTH) break;
        list.push(key);
        m -= 1;
        if (m === 0) { m = 12; y -= 1; }
      }
      return list;
    });
    const yearList = computed(() => {
      const end = Number(nowMonth().slice(0, 4));
      const list = [];
      for (let y = end; y >= Number(START_MONTH.slice(0, 4)); y -= 1) list.push(y);
      return list;
    });

    const load = async () => {
      loading.value = true; error.value = '';
      try {
        // 区间跨年 → 一次请求带上所有年份，后端只算一遍（月结数据只加载一次）
        const [res, boot, noteRes] = await Promise.all([
          axios.get('/api/biz-analysis/overview', { params: { years: yearList.value.join(',') } }),
          axios.get('/api/biz-analysis/bootstrap'),
          axios.get('/api/biz-analysis/month-notes', { params: { years: yearList.value.join(',') } }),
        ]);
        profile.value = boot.data;
        data.value = res.data;
        const noteMap = {};
        for (const row of (noteRes.data.rows || [])) { noteMap[row.month] = row.note; notesSaved[row.month] = row.note; }
        notes.value = noteMap;
        await nextTick();
        renderChart();
      } catch (e) {
        error.value = message(e);
      } finally {
        loading.value = false;
      }
    };

    // ── 列块：先按固定版式排，再补版式外的店铺 ──
    const blocks = computed(() => {
      const list = [];
      const entities = (data.value.entities || [])
        .filter((e) => !HIDDEN_ENTITIES.includes(String(e.name || '').trim()));
      // 后端已经把月份聚合到「人 + 平台」层，这里不再依赖店铺档案
      const push = (entity, entityIdx, platform, group) => {
        const cols = PLATFORM_COLS[platform] || PLATFORM_COLS.etsy;
        list.push({
          key: `${entity.id}:${platform}`,
          entity_id: entity.id,
          entity_name: entity.name,
          platform,
          group: group || null,
          months: group?.months || [],
          title: platform === 'ozon' ? 'OZON' : `ETSY ${entity.name}`,
          tone: TONES[entityIdx % TONES.length],
          cols,
          error: group?.error || '',
          empty: !group,
        });
      };
      entities.forEach((entity, idx) => {
        const groups = new Map((entity.platforms || []).map((g) => [g.platform, g]));
        const usedPlatforms = new Set();
        // 固定版式：超-ETSY / 宝-OZON / 宝-ETSY
        for (const plan of BLOCK_PLAN) {
          if (!String(entity.name || '').includes(plan.entity)) continue;
          push(entity, idx, plan.platform, groups.get(plan.platform));
          usedPlatforms.add(plan.platform);
        }
        // 版式外的平台排在后面，不丢数据
        for (const [platform, g] of groups) {
          if (usedPlatforms.has(platform)) continue;
          push(entity, idx, platform, g);
        }
      });
      return list;
    });

    // ── 按块 × 月建索引，取数快 ──
    const blockMonthIndex = computed(() => {
      const map = new Map();
      for (const block of blocks.value) {
        const rows = new Map();
        for (const m of block.months || []) rows.set(m.month, m);
        map.set(block.key, rows);
      }
      return map;
    });

    const emptyCells = () => {
      const cells = {};
      for (const block of blocks.value) {
        cells[block.key] = {};
        for (const col of block.cols) cells[block.key][col.key] = 0;
      }
      return cells;
    };

    // ── 月度是否结算完成 ──
    // 规则（用户 2026-11-10 确认）：Ozon 应计数据齐全 + 其他平台数据也都录进来了，才算这个月结算完成
    //   ① Ozon 块：用后端给的 settled（该月每天是否都同步过应计流水 + 月份已过完）
    //   ② 手工录入的平台块（Etsy 等）：这块只要在某个月录过数据，说明在运营，
    //      那么从那时起每个月都得录，没录就算「缺数据 → 未结算完」
    const blockManualMeta = computed(() => {
      const map = new Map();
      for (const block of blocks.value) {
        const months = (block.months || []).filter((m) => m.manual).map((m) => m.month).sort();
        map.set(block.key, { hasManual: months.length > 0, firstMonth: months[0] || null });
      }
      return map;
    });
    const monthSettled = (month) => {
      let judged = false, ok = true;
      for (const block of blocks.value) {
        const bucket = blockMonthIndex.value.get(block.key)?.get(month);
        if (bucket && bucket.settled != null) {   // Ozon：应计齐不齐
          judged = true;
          if (!bucket.settled) ok = false;
          continue;
        }
        const meta = blockManualMeta.value.get(block.key);
        if (meta?.hasManual && month >= meta.firstMonth) {   // 手工平台：该月有没有录
          judged = true;
          if (!bucket?.manual) ok = false;
        }
      }
      return judged ? ok : month <= completeCutoff.value;
    };

    // ── 矩阵：月份行 + 每年合计行 + 区间合计 ──
    // 合计口径跟用户的表一致：国宝合计 = 宝的毛利合计（Ozon 毛利1 + Etsy 毛利2）；
    // 团队合计营收 = 超毛利 + 国宝合计（即所有块的毛利之和）
    const matrix = computed(() => {
      const list = [];
      const totals = { cells: emptyCells(), bao: 0, team: 0, revenue: 0 };
      const months = monthList.value;
      let yearAcc = null;
      let yearKey = '';
      for (let i = 0; i < months.length; i += 1) {
        const month = months[i];
        const cells = {};
        let chao = 0, bao = 0, team = 0, revenueAll = 0;
        for (const block of blocks.value) {
          const src = blockMonthIndex.value.get(block.key)?.get(month) || {};
          const cell = {};
          for (const col of block.cols) {
            const value = r2(Number(src[col.key] || 0));
            cell[col.key] = value;
            totals.cells[block.key][col.key] = r2(totals.cells[block.key][col.key] + value);
          }
          cells[block.key] = cell;
          const profit = Number(src.profit_cny || 0);
          team += profit;
          if (isBao(block.entity_name)) bao += profit;
          if (String(block.entity_name || '').includes('超')) chao += profit;
          revenueAll += Number(src.revenue_cny || 0);
        }
        list.push({
          month, label: `${month.slice(2, 4)}-${month.slice(5, 7)}`, cells,
          chao: r2(chao), bao: r2(bao), team: r2(team), isYear: false,
          note: notes.value[month] || '',
          incomplete: !monthSettled(month),
        });
        totals.bao = r2(totals.bao + bao);
        totals.team = r2(totals.team + team);
        totals.revenue = r2(totals.revenue + revenueAll);

        // 年度累计
        const year = month.slice(0, 4);
        if (!yearAcc || yearKey !== year) {
          yearAcc = { cells: emptyCells(), chao: 0, bao: 0, team: 0, first: month, last: month, count: 0 };
          yearKey = year;
        }
        yearAcc.count += 1;
        yearAcc.last = month; // 倒序遍历，最后落在这个年度的最早一个月
        for (const block of blocks.value) {
          for (const col of block.cols) {
            yearAcc.cells[block.key][col.key] = r2(yearAcc.cells[block.key][col.key] + Number(cells[block.key]?.[col.key] || 0));
          }
        }
        yearAcc.chao = r2(yearAcc.chao + chao);
        yearAcc.bao = r2(yearAcc.bao + bao);
        yearAcc.team = r2(yearAcc.team + team);

        // 一年到头（下一行换年，或已是最后一行）插一行年度合计
        const next = months[i + 1];
        if (!next || next.slice(0, 4) !== year) {
          list.push({
            month: `${year}-total`,
            label: `${year.slice(2)} 年合计`,
            cells: yearAcc.cells,
            chao: yearAcc.chao,
            bao: yearAcc.bao,
            team: yearAcc.team,
            isYear: true,
            // 区间只覆盖了部分月份时标出来（如 2025 只有 8-12 月）
            partial: yearAcc.count < 12,
            rangeNote: yearAcc.count < 12
              ? `${Number(yearAcc.last.slice(5))}-${Number(yearAcc.first.slice(5))} 月`
              : '',
          });
        }
      }

      // ── 标记：月度销冠、个人 PB、团队总 PB（以图标形式挂在对应数字旁边） ──
      // PB 从区间最早一个月往后滚动比较；只认正毛利，避免空月份（0）刷成记录
      const monthRows = list.filter((r) => !r.isYear).reverse(); // 正序
      let chaoPb = 0, baoPb = 0, teamPb = 0;
      const yearStats = new Map();
      const statOf = (year) => {
        if (!yearStats.has(year)) yearStats.set(year, { chaoCrown: 0, baoCrown: 0, personal: 0, team: 0 });
        return yearStats.get(year);
      };
      for (const row of monthRows) {
        const chao = Number(row.chao || 0), bao = Number(row.bao || 0), team = Number(row.team || 0);
        if (row.incomplete) {
          // 数据还没结算完，不评销冠、不记纪录
          row.crown = '';
          row.pb = { chao: false, bao: false, team: false };
          continue;
        }
        row.crown = chao > bao && chao > 0 ? 'chao' : (bao > chao && bao > 0 ? 'bao' : '');
        row.pb = {
          chao: chao > 0 && chao > chaoPb,
          bao: bao > 0 && bao > baoPb,
          team: team > 0 && team > teamPb,
        };
        if (row.pb.chao) chaoPb = chao;
        if (row.pb.bao) baoPb = bao;
        if (row.pb.team) teamPb = team;
        // 年度统计：销冠次数、个人记录次数、团队记录次数
        const s = statOf(row.month.slice(0, 4));
        if (row.crown === 'chao') s.chaoCrown += 1;
        if (row.crown === 'bao') s.baoCrown += 1;
        if (row.pb.chao) s.personal += 1;
        if (row.pb.bao) s.personal += 1;
        if (row.pb.team) s.team += 1;
      }
      for (const row of list) {
        if (!row.isYear) continue;
        row.crown = '';
        row.pb = { chao: false, bao: false, team: false };
        row.stats = yearStats.get(row.month.slice(0, 4)) || { chaoCrown: 0, baoCrown: 0, personal: 0, team: 0 };
      }

      // 年度合计行放到该年数据最上面
      const ordered = [];
      let bucket = [];
      for (const row of list) {
        if (row.isYear) { ordered.push(row, ...bucket); bucket = []; } else bucket.push(row);
      }
      ordered.push(...bucket);

      return { rows: ordered, totals };
    });

    const fmt = (value) => (Number(value || 0) === 0 ? '—' : money(value));
    const cellClass = (value, col) => [
      'biz-num',
      Number(value || 0) === 0 ? 'biz-zero' : '',
      Number(value || 0) < 0 ? 'biz-num-neg' : '',
      col.key === 'profit_cny' ? 'biz-num-profit' : '',
    ];

    // ── 图表：超 / 宝 的经营毛利按月走势（月份正序） ──
    const chartEl = ref(null);
    let chart = null;
    const renderChart = () => {
      if (!window.echarts || !chartEl.value) return;
      if (!blocks.value.length) return;
      if (!chart) chart = window.echarts.init(chartEl.value);
      const ordered = [...matrix.value.rows].filter((r) => !r.isYear).reverse();
      const names = [...new Set(blocks.value.map((b) => b.entity_name))];
      const series = names.map((name) => ({
        name,
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 5,
        data: ordered.map((row) => r2(blocks.value
          .filter((b) => b.entity_name === name)
          .reduce((sum, b) => sum + Number(row.cells[b.key]?.profit_cny || 0), 0))),
      }));
      chart.setOption({
        grid: { left: 52, right: 18, top: 34, bottom: 28 },
        tooltip: { trigger: 'axis', valueFormatter: (v) => `¥${money(v)}` },
        legend: { top: 0, right: 0, textStyle: { color: '#475569' } },
        xAxis: { type: 'category', data: ordered.map((r) => r.label), axisLine: { lineStyle: { color: '#dbe3ee' } }, axisLabel: { color: '#64748b' } },
        yAxis: { type: 'value', name: '经营毛利 / 元', nameTextStyle: { color: '#94a3b8' }, splitLine: { lineStyle: { color: '#eef2f7' } }, axisLabel: { color: '#64748b' } },
        series,
      }, true);
      chart.resize();
    };
    const onResize = () => chart && chart.resize();

    // ── 月度数据录入：按「人 + 平台」直接记，不需要店铺档案 ──
    // Etsy 只有手工数据；Ozon 用来补 2026-10 之前没有月结的历史
    const entryVisible = ref(false);
    const entryBlock = ref(null);
    const entryRows = ref([]);
    const openEntry = async (block) => {
      if (!block) return;
      entryBlock.value = block;
      // 弹窗默认最新的月份在最上面
      entryRows.value = [...monthList.value].map((month) => ({
        month, revenue_cny: 0, ad_cny: 0, fee_cny: 0, refund_cny: 0, saved: false, saving: false,
      }));
      entryVisible.value = true;
      try {
        const res = await axios.get('/api/biz-analysis/manual', {
          params: { entity_id: block.entity_id, platform: block.platform, years: yearList.value.join(',') },
        });
        const index = new Map((res.data.rows || []).map((r) => [r.month, r]));
        entryRows.value = entryRows.value.map((row) => {
          const hit = index.get(row.month);
          if (!hit) return row;
          return {
            ...row,
            revenue_cny: Number(hit.revenue_cny || 0),
            ad_cny: Number(hit.ad_cny || 0),
            fee_cny: Number(hit.fee_cny || 0),
            refund_cny: Number(hit.refund_cny || 0),
            saved: true,
          };
        });
      } catch (e) {
        ElementPlus.ElMessage.error(message(e));
      }
    };
    // 单行保存：改哪个月就存哪个月，互不影响
    const saveRow = async (row) => {
      if (!row || row.saving) return;
      row.saving = true;
      try {
        await axios.post('/api/biz-analysis/manual', {
          entity_id: entryBlock.value.entity_id,
          platform: entryBlock.value.platform,
          month: row.month,
          revenue_cny: Number(row.revenue_cny || 0),
          ad_cny: Number(row.ad_cny || 0),
          fee_cny: 0,
          refund_cny: 0,
        });
        row.saved = true;
        ElementPlus.ElMessage.success(`${row.month} 已保存`);
        await load();
      } catch (e) {
        ElementPlus.ElMessage.error(message(e));
      } finally {
        row.saving = false;
      }
    };

    // 备注：失焦/回车时保存，值没变就不打接口
    const saveNote = async (row) => {
      const text = String(row.note || '');
      if (text === (notesSaved[row.month] || '')) return;
      try {
        await axios.post('/api/biz-analysis/month-notes', { month: row.month, note: text });
        notesSaved[row.month] = text;
      } catch (e) {
        ElementPlus.ElMessage.error(message(e));
      }
    };
    const rowProfit = (row) => Number(row.revenue_cny || 0) - Number(row.ad_cny || 0) - Number(row.fee_cny || 0) - Number(row.refund_cny || 0);

    // ── 经营档案（主体 + 店铺）维护 ──
    const profileVisible = ref(false);
    const profileBusy = ref(false);
    const newEntityName = ref('');
    const newStore = ref({ name: '', platform: 'etsy', entity_id: '', ozon_store_id: '' });
    const saveEntity = async (entity) => {
      profileBusy.value = true;
      try {
        await axios.post('/api/biz-analysis/entities', entity);
        await reloadProfile();
      } catch (e) { ElementPlus.ElMessage.error(message(e)); } finally { profileBusy.value = false; }
    };
    const removeEntity = async (entity) => {
      try {
        await ElementPlus.ElMessageBox.confirm(`删除经营主体「${entity.name}」？`, '确认', { type: 'warning' });
        await axios.delete(`/api/biz-analysis/entities/${entity.id}`);
        await reloadProfile();
      } catch (e) { if (e !== 'cancel') ElementPlus.ElMessage.error(message(e)); }
    };
    const saveStore = async (store) => {
      profileBusy.value = true;
      try {
        await axios.post('/api/biz-analysis/stores', store);
        await reloadProfile();
        ElementPlus.ElMessage.success('已保存');
      } catch (e) { ElementPlus.ElMessage.error(message(e)); } finally { profileBusy.value = false; }
    };
    const removeStore = async (store) => {
      try {
        await ElementPlus.ElMessageBox.confirm(`删除经营店铺「${store.name}」？已导入的流水会变成未归属。`, '确认', { type: 'warning' });
        await axios.delete(`/api/biz-analysis/stores/${store.id}`);
        await reloadProfile();
        await load();
      } catch (e) { if (e !== 'cancel') ElementPlus.ElMessage.error(message(e)); }
    };
    const addEntity = async () => {
      const name = newEntityName.value.trim();
      if (!name) return;
      await saveEntity({ name });
      newEntityName.value = '';
    };
    const addStore = async () => {
      if (!newStore.value.name.trim()) return ElementPlus.ElMessage.warning('请填写店铺名称');
      await saveStore({ ...newStore.value });
      newStore.value = { name: '', platform: 'etsy', entity_id: '', ozon_store_id: '' };
      await load();
    };
    const reloadProfile = async () => {
      const res = await axios.get('/api/biz-analysis/bootstrap');
      profile.value = res.data;
      await load();
    };

    const hasAnyStore = computed(() => (data.value.entities || []).some((e) => (e.platforms || []).length));
    const rangeText = computed(() => `${START_MONTH} 至今`);

    onMounted(() => { load(); window.addEventListener('resize', onResize); });
    onBeforeUnmount(() => { window.removeEventListener('resize', onResize); if (chart) { chart.dispose(); chart = null; } });

    return {
      loading, error, data, profile, hasAnyStore, blocks, matrix, rangeText, completeCutoff,
      money, fmt, cellClass, monthLabel, platformLabel, load, chartEl, openEntry, rowProfit, saveNote,
      entryVisible, entryBlock, entryRows, saveRow,
      profileVisible, profileBusy, newEntityName, newStore, saveEntity, removeEntity, saveStore, removeStore, addEntity, addStore,
    };
  },
  template: `
  <section class="erp-route-page biz-page" v-loading="loading">
    <header class="biz-head">
      <div>
        <h1 class="biz-title">经营总览</h1>
        <p class="biz-sub">按月看 超 / 宝 名下各店铺的销售（收入）· 广告 · 毛利；Ozon 取月结统计结算口径，Etsy 取月度录入</p>
      </div>
      <div class="biz-head-actions">
        <span class="biz-range-tag">{{ rangeText }}</span>
        <el-button :icon="'Refresh'" @click="load">刷新</el-button>
        <el-button :icon="'Setting'" @click="profileVisible = true">经营档案</el-button>
      </div>
    </header>

    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="biz-alert" />

    <el-alert v-if="data.unassigned && data.unassigned.length" type="warning" show-icon :closable="false" class="biz-alert"
      :title="'有 ' + data.unassigned.length + ' 个经营店铺还没归属到人：' + data.unassigned.map(s=>s.name).join('、') + '（到「经营档案」里指定归属后就计入统计）'" />

    <div class="biz-matrix-card">
      <div class="biz-matrix-title">
        <span>月度经营明细 <small>（单位：元 · 每年末尾自动汇总一行年度合计）</small></span>
        <div class="biz-legend">
          <span class="biz-legend-item"><el-icon class="biz-ico biz-ico-gold"><Trophy /></el-icon>当月销冠</span>
          <span class="biz-legend-item"><el-icon class="biz-ico biz-ico-blue"><Medal /></el-icon><el-icon class="biz-ico biz-ico-green"><Medal /></el-icon>个人 PB（超 / 宝）</span>
          <span class="biz-legend-item"><el-icon class="biz-ico biz-ico-amber"><Lightning /></el-icon>团队总 PB</span>
          <span class="biz-legend-item biz-legend-hint">0 显示「—」，负数红色</span>
        </div>
      </div>
      <div class="biz-matrix-wrap">
        <table class="biz-matrix">
          <thead>
            <tr>
              <th class="biz-col-month" rowspan="2">月份</th>
              <th v-for="block in blocks" :key="block.key" :colspan="block.cols.length" :class="['biz-grp', 'biz-grp-' + block.tone]">
                <span>{{ block.title }}</span>
                <button class="biz-grp-btn" @click="openEntry(block)">录入</button>
                <span v-if="block.error" class="biz-grp-err" :title="block.error">异常</span>
              </th>
              <th class="biz-grp biz-grp-bao" rowspan="2">宝毛利</th>
              <th class="biz-grp biz-grp-team" rowspan="2">团队合计营收</th>
              <th class="biz-grp biz-grp-note" rowspan="2">备注</th>
            </tr>
            <tr>
              <template v-for="block in blocks" :key="'sub-' + block.key">
                <th v-for="col in block.cols" :key="block.key + '-' + col.key" :class="'biz-sub biz-sub-' + block.tone">{{ col.label }}</th>
              </template>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in matrix.rows" :key="row.month" :class="row.isYear ? 'biz-row-year' : ''">
              <td class="biz-col-month">
                <span>{{ row.label }}</span>
                <em v-if="row.rangeNote" class="biz-th-note">{{ row.rangeNote }}</em>
                <em v-else-if="row.incomplete" class="biz-th-note biz-th-warn">未结算完</em>
              </td>
              <template v-for="block in blocks" :key="'c-' + block.key">
                <td v-for="col in block.cols" :key="block.key + '-' + col.key" :class="[cellClass(row.cells[block.key]?.[col.key], col), 'biz-tint-' + block.tone]">
                  <span>{{ fmt(row.cells[block.key]?.[col.key]) }}</span>
                  <template v-if="col.key === 'profit_cny' && String(block.entity_name).includes('超')">
                    <el-icon v-if="row.crown === 'chao'" class="biz-ico biz-ico-gold" title="本月销冠"><Trophy /></el-icon>
                    <el-icon v-if="row.pb && row.pb.chao" class="biz-ico biz-ico-blue" title="超 · 个人 PB"><Medal /></el-icon>
                  </template>
                </td>
              </template>
              <td class="biz-num biz-num-bao">
                <span>{{ fmt(row.bao) }}</span>
                <el-icon v-if="row.crown === 'bao'" class="biz-ico biz-ico-gold" title="本月销冠"><Trophy /></el-icon>
                <el-icon v-if="row.pb && row.pb.bao" class="biz-ico biz-ico-green" title="宝 · 个人 PB"><Medal /></el-icon>
              </td>
              <td class="biz-num biz-num-team">
                <span>{{ fmt(row.team) }}</span>
                <el-icon v-if="row.pb && row.pb.team" class="biz-ico biz-ico-amber" title="团队总 PB"><Lightning /></el-icon>
              </td>
              <td class="biz-note" v-if="row.isYear">
                <span v-if="row.stats" class="biz-note-stat">
                  销冠 超 {{ row.stats.chaoCrown }} 次 / 宝 {{ row.stats.baoCrown }} 次 · 个人记录 {{ row.stats.personal }} 次 · 团队记录 {{ row.stats.team }} 次
                </span>
              </td>
              <td class="biz-note" v-else>
                <input v-model="row.note" class="biz-note-input" placeholder="填备注…"
                  @change="saveNote(row)" @blur="saveNote(row)" @keyup.enter="$event.target.blur()" />
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td class="biz-col-month">区间合计</td>
              <template v-for="block in blocks" :key="'t-' + block.key">
                <td v-for="col in block.cols" :key="block.key + '-' + col.key" :class="[cellClass(matrix.totals.cells[block.key]?.[col.key], col), 'biz-tint-' + block.tone]">
                  {{ fmt(matrix.totals.cells[block.key]?.[col.key]) }}
                </td>
              </template>
              <td class="biz-num biz-num-bao">{{ fmt(matrix.totals.bao) }}</td>
              <td class="biz-num biz-num-team">{{ fmt(matrix.totals.team) }}</td>
              <td class="biz-note"></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>

    <div class="biz-chart-card" v-if="blocks.length">
      <div class="biz-chart-head">经营毛利走势 <small>（元 / 月）</small></div>
      <div ref="chartEl" class="biz-chart"></div>
    </div>

    <!-- 月度数据录入（按人 + 平台，不需要店铺档案） -->
    <el-dialog v-model="entryVisible" :title="'月度数据 · ' + (entryBlock ? entryBlock.title : '')" width="720px" :close-on-click-modal="false">
      <p class="biz-muted" style="margin:0 0 12px">金额直接填人民币，毛利 = 收入 − 广告；每个月单独保存，改哪行存哪行。</p>
      <el-table :data="entryRows" size="small" border max-height="460">
        <el-table-column label="月份" width="96"><template #default="{row}">{{ row.month }}</template></el-table-column>
        <el-table-column label="收入"><template #default="{row}"><el-input-number v-model="row.revenue_cny" :controls="false" :precision="2" style="width:100%" /></template></el-table-column>
        <el-table-column label="广告"><template #default="{row}"><el-input-number v-model="row.ad_cny" :controls="false" :precision="2" style="width:100%" /></template></el-table-column>
        <el-table-column label="毛利" width="120" align="right"><template #default="{row}">{{ money(rowProfit(row)) }}</template></el-table-column>
        <el-table-column label="操作" width="86" align="center">
          <template #default="{row}">
            <el-button size="small" type="primary" plain :loading="row.saving" @click="saveRow(row)">保存</el-button>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="entryVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 经营档案 -->
    <el-drawer v-model="profileVisible" title="经营档案" size="720px" :close-on-click-modal="false">
      <div class="biz-profile">
        <h3>经营主体</h3>
        <div v-for="entity in profile.entities" :key="entity.id" class="biz-profile-row">
          <el-input v-model="entity.name" style="width:180px" />
          <el-button size="small" :loading="profileBusy" @click="saveEntity(entity)">保存</el-button>
          <el-button size="small" type="danger" link @click="removeEntity(entity)">删除</el-button>
          <span class="biz-muted">{{ profile.stores.filter(s=>s.entity_id===entity.id).length }} 个店铺</span>
        </div>
        <div class="biz-profile-row">
          <el-input v-model="newEntityName" placeholder="新增主体名称" style="width:180px" />
          <el-button size="small" type="primary" @click="addEntity">新增</el-button>
        </div>

        <h3 style="margin-top:24px">经营店铺</h3>
        <p class="biz-muted" style="margin:-6px 0 10px">Etsy 店填名称即可；Ozon 店必须选择已接入系统的店铺，总览会自动取它的月结统计。</p>
        <el-table :data="profile.stores" size="small" border>
          <el-table-column label="店铺名称" min-width="140"><template #default="{row}"><el-input v-model="row.name" size="small" /></template></el-table-column>
          <el-table-column label="平台" width="100"><template #default="{row}"><el-tag size="small" :type="row.platform === 'etsy' ? 'warning' : 'success'">{{ platformLabel(row.platform) }}</el-tag></template></el-table-column>
          <el-table-column label="归属" width="130"><template #default="{row}">
            <el-select v-model="row.entity_id" size="small" placeholder="未归属" clearable>
              <el-option v-for="e in profile.entities" :key="e.id" :label="e.name" :value="e.id" />
            </el-select>
          </template></el-table-column>
          <el-table-column label="关联 Ozon 店铺" min-width="150"><template #default="{row}">
            <el-select v-if="row.platform === 'ozon'" v-model="row.ozon_store_id" size="small" placeholder="选择店铺">
              <el-option v-for="shop in profile.ozon_shops" :key="shop.id" :label="shop.name" :value="shop.id" />
            </el-select>
            <span v-else class="biz-muted">—</span>
          </template></el-table-column>
          <el-table-column label="操作" width="130" align="center"><template #default="{row}">
            <el-button size="small" :loading="profileBusy" @click="saveStore(row)">保存</el-button>
            <el-button size="small" type="danger" link @click="removeStore(row)">删除</el-button>
          </template></el-table-column>
        </el-table>

        <div class="biz-profile-row" style="margin-top:14px; flex-wrap:wrap">
          <el-input v-model="newStore.name" placeholder="店铺名称" style="width:150px" />
          <el-select v-model="newStore.platform" style="width:110px">
            <el-option label="Etsy" value="etsy" /><el-option label="Ozon" value="ozon" />
          </el-select>
          <el-select v-model="newStore.entity_id" placeholder="归属" clearable style="width:110px">
            <el-option v-for="e in profile.entities" :key="e.id" :label="e.name" :value="e.id" />
          </el-select>
          <el-select v-if="newStore.platform === 'ozon'" v-model="newStore.ozon_store_id" placeholder="关联 Ozon 店铺" style="width:190px">
            <el-option v-for="shop in profile.ozon_shops" :key="shop.id" :label="shop.name" :value="shop.id" />
          </el-select>
          <el-button type="primary" @click="addStore">新增店铺</el-button>
        </div>
      </div>
    </el-drawer>
  </section>`,
};
