// 经营分析 · 资金流水
//
// 数据来源：用户隔一段时间导出的真实收支（Excel/CSV）。导入后分类不准的行会进「待分类」，
// 手动选定分类/主体/店铺后落库（manual_corrected），这些选择本身就成为后续分析的维度。
// 明细 = 导入 + 人工修正后的逐条数据；汇总 = 按月、按分类的实际花销与收入。
window.CashFlowView = {
  // embedded=true 时嵌在别的页面里（股东权益的页签），不重复渲染自己的页头
  props: { embedded: { type: Boolean, default: false } },
  setup() {
    const { ref, computed, onMounted } = Vue;
    const tab = ref('detail');
    // 时间周期（替代原来的年份 + 月份两级选择）
    const dateRange = ref([]);
    const direction = ref('');
    const category1 = ref('');
    const category2 = ref('');
    const status = ref('');
    const operator = ref('');
    const keyword = ref('');
    const page = ref(1);
    const pageSize = ref(100);
    const rows = ref([]);
    const total = ref(0);
    const totals = ref({ income: 0, expense: 0, net: 0 });
    const loading = ref(false);
    const error = ref('');
    const profile = ref({ entities: [], stores: [], categories: [], ozon_shops: [] });
    const summary = ref({ monthly: [], byCategory: [], totals: { income: 0, expense: 0, net: 0 }, pending: 0 });
    const selected = ref([]);
    const bulk = ref({ category1: '', category2: '' });
    const saving = ref(false);

    const message = (e) => e?.response?.data?.error || e?.message || '请求失败';
    const money = (value) => value == null ? '—' : Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const expenseCats = computed(() => (profile.value.categories || []).filter((c) => c.direction === 'expense' && c.active !== false));
    const incomeCats = computed(() => (profile.value.categories || []).filter((c) => c.direction === 'income' && c.active !== false));
    const catsOf = (row) => (row.direction === 'income' ? incomeCats.value : expenseCats.value);
    const groupOfCat = (category1) => {
      const map = summary.value.categoryGroups || {};
      for (const [group, list] of Object.entries(map)) if (list.includes(category1)) return group;
      return '未分类';
    };
    const entityName = (id) => (profile.value.entities.find((e) => e.id === id) || {}).name || '';
    const storeName = (id) => (profile.value.stores.find((s) => s.id === id) || {}).name || '';
    // 二级分类下拉：选了一级就只列它下面的，否则列全部（去重）
    const category2Options = computed(() => {
      const list = (profile.value.category2s || [])
        .filter((r) => !category1.value || r.category1 === category1.value)
        .map((r) => r.category2);
      return [...new Set(list)];
    });
    // 表格里逐行编辑二级分类时，只列这一行一级分类下的二级
    const subsByCategory1 = computed(() => {
      const map = {};
      for (const r of (profile.value.category2s || [])) {
        (map[r.category1] = map[r.category1] || []).push(r.category2);
      }
      return map;
    });
    const subOptionsOf = (row) => subsByCategory1.value[row.category1] || [];
    // 批量栏的二级下拉跟着批量一级走
    const bulkSubOptions = computed(() => {
      const list = (profile.value.category2s || [])
        .filter((r) => !bulk.value.category1 || r.category1 === bulk.value.category1)
        .map((r) => r.category2);
      return [...new Set(list)];
    });
    // 明细有没有筛选条件：顶部统计卡默认全量，有筛选就按条件统计
    const hasFilter = computed(() => Boolean(
      (dateRange.value && dateRange.value.length) || direction.value || category1.value
      || category2.value || status.value || operator.value || keyword.value,
    ));
    const todayUTC = () => new Date(Date.now() + 8 * 3600000);
    // 时间周期快捷项：一个月 / 一整年 / 近 12 个月
    const rangeShortcuts = [
      { text: '本月', value: () => { const d = todayUTC(); const y = d.getUTCFullYear(); const m = d.getUTCMonth(); return [new Date(Date.UTC(y, m, 1)), new Date(Date.UTC(y, m + 1, 0))]; } },
      { text: '今年（12 个月）', value: () => { const y = todayUTC().getUTCFullYear(); return [new Date(Date.UTC(y, 0, 1)), new Date(Date.UTC(y, 11, 31))]; } },
      { text: '近 12 个月', value: () => { const d = todayUTC(); const y = d.getUTCFullYear(); const m = d.getUTCMonth(); return [new Date(Date.UTC(y, m - 11, 1)), new Date(Date.UTC(y, m + 1, 0))]; } },
    ];
    const rangeLabel = computed(() => {
      const r = dateRange.value;
      return (!r || !r.length) ? '全部流水' : `${r[0]} 至 ${r[1]}`;
    });

    const loadProfile = async () => {
      const res = await axios.get('/api/biz-analysis/bootstrap');
      profile.value = res.data;
    };

    const loadList = async () => {
      loading.value = true; error.value = '';
      try {
        const res = await axios.get('/api/biz-analysis/cashflow', {
          params: {
            date_from: (dateRange.value && dateRange.value[0]) || undefined,
            date_to: (dateRange.value && dateRange.value[1]) || undefined,
            direction: direction.value || undefined,
            category1: category1.value || undefined, category2: category2.value || undefined,
            status: status.value || undefined, operator: operator.value || undefined,
            keyword: keyword.value || undefined, page: page.value, page_size: pageSize.value,
          },
        });
        rows.value = res.data.rows;
        total.value = res.data.total;
        totals.value = res.data.totals;
      } catch (e) { error.value = message(e); } finally { loading.value = false; }
    };

    const loadSummary = async () => {
      loading.value = true; error.value = '';
      try {
        // 汇总跟着「时间周期」走：不选 = 全部流水，选了就按区间统计
        const res = await axios.get('/api/biz-analysis/cashflow/summary', {
          params: {
            date_from: (dateRange.value && dateRange.value[0]) || undefined,
            date_to: (dateRange.value && dateRange.value[1]) || undefined,
          },
        });
        summary.value = res.data;
      } catch (e) { error.value = message(e); } finally { loading.value = false; }
    };

    const reload = async () => {
      if (tab.value === 'summary') await loadSummary(); else await loadList();
    };

    const patchRow = async (row, patch) => {
      saving.value = true;
      try {
        await axios.patch(`/api/biz-analysis/cashflow/${row.id}`, patch);
        Object.assign(row, patch, { manual_corrected: true });
        ElementPlus.ElMessage.success('已保存');
        await reload();
      } catch (e) { ElementPlus.ElMessage.error(message(e)); } finally { saving.value = false; }
    };

    const applyBulk = async () => {
      if (!selected.value.length) return ElementPlus.ElMessage.warning('请先勾选流水');
      const payload = { ids: selected.value.map((r) => r.id) };
      if (bulk.value.category1) payload.category1 = bulk.value.category1;
      if (bulk.value.category2) payload.category2 = bulk.value.category2;
      if (!payload.category1 && !payload.category2) return ElementPlus.ElMessage.warning('先选要设置的分类');
      saving.value = true;
      try {
        const res = await axios.post('/api/biz-analysis/cashflow/bulk', payload);
        ElementPlus.ElMessage.success(`已更新 ${res.data.updated} 条`);
        selected.value = [];
        await reload();
      } catch (e) { ElementPlus.ElMessage.error(message(e)); } finally { saving.value = false; }
    };

    const removeRow = async (row) => {
      try {
        await ElementPlus.ElMessageBox.confirm(`删除 ${row.date} 这笔 ${money(row.amount_cny)} 的流水？`, '确认删除', { type: 'warning' });
        await axios.delete(`/api/biz-analysis/cashflow/${row.id}`);
        await reload();
      } catch (e) { if (e !== 'cancel') ElementPlus.ElMessage.error(message(e)); }
    };

    // ── 导入：前端解析 Excel/CSV，后端只收结构化行（保留原始行到 raw 便于回溯） ──
    const importVisible = ref(false);
    const importName = ref('');
    const importRows = ref([]);
    const importErrors = ref([]);
    const importSummary = ref([]);
    const importBusy = ref(false);
    const importResult = ref(null);
    const fileInput = ref(null);

    // 两种格式都要吃：
    //   ① 通用模板：日期 / 收支方向 / 金额 …
    //   ② 支付宝小荷包导出：订单号 / 交易时间 / 交易说明 / 备注 / 操作人 / 收入金额 / 支出金额
    const HEADERS = {
      date: ['日期', '交易日期', '交易时间', 'date'],
      direction: ['收支方向', '方向', '收支', '类型', 'direction'],
      amount: ['金额', '金额（元）', '金额(元)', 'amount'],
      income: ['收入金额', '收入'],
      expense: ['支出金额', '支出'],
      description: ['交易说明', '说明'],
      operator: ['操作人姓名', '操作人', '操作人昵称'],
      category1: ['一级分类', '分类', '类别', 'category1'],
      category2: ['二级分类', '子分类', 'category2'],
      store: ['经营店铺', '店铺', '店铺名称', 'store'],
      entity: ['经营主体', '主体', '负责人', 'entity'],
      counterparty: ['对方', '交易对方', '往来方', 'counterparty'],
      note: ['备注', '摘要', 'note'],
    };

    const normalizeDate = (value) => {
      if (value instanceof Date && !Number.isNaN(value.getTime())) {
        const y = value.getFullYear(), m = String(value.getMonth() + 1).padStart(2, '0'), d = String(value.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
      }
      if (typeof value === 'number' && value > 20000 && value < 60000) {
        // Excel 序列号：1899-12-30 起算
        const ms = Math.round((value - 25569) * 86400000);
        return new Date(ms).toISOString().slice(0, 10);
      }
      const text = String(value || '').trim().replace(/[./]/g, '-');
      const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      return match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : '';
    };
    const toNumber = (value) => {
      const n = Number(String(value ?? '').replace(/[,，¥￥\s]/g, ''));
      return Number.isFinite(n) ? n : 0;
    };

    const parseFile = async (file) => {
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) return ElementPlus.ElMessage.error('文件不能超过 10MB');
      importName.value = file.name;
      importResult.value = null;
      importSummary.value = [];
      try {
        const buffer = await file.arrayBuffer();
        const book = XLSX.read(buffer, { type: 'array', cellDates: true });
        const sheet = book.Sheets[book.SheetNames[0]];
        const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
        // 表头不在第一行（小荷包上面有 10 行说明），按特征找：日期类列 + 金额类列
        const headIndex = matrix.findIndex((row) => {
          const cells = row.map((c) => String(c).trim());
          const hasDate = cells.some((c) => c.includes('日期') || c.includes('交易时间'));
          const hasMoney = cells.some((c) => c.includes('金额'));
          return hasDate && hasMoney;
        });
        if (headIndex < 0) throw new Error('没找到表头：需要「日期/交易时间」和「金额」这类列');
        const head = matrix[headIndex].map((c) => String(c).trim());
        const isWallet = head.some((h) => h.includes('交易时间')) && head.some((h) => h.includes('收入金额'));
        const pick = (row, keys) => {
          for (const key of keys) {
            const idx = head.findIndex((h) => h === key || h.includes(key));
            if (idx >= 0 && row[idx] !== '' && row[idx] != null) return row[idx];
          }
          return '';
        };
        const parsed = [], errors = [];
        matrix.slice(headIndex + 1).forEach((row, i) => {
          if (!row || row.every((c) => String(c).trim() === '')) return;
          const line = headIndex + i + 2;
          if (String(row[0] || '').startsWith('#')) return;
          // 小荷包导出中间会重复一次表头，靠日期解析失败自然跳过
          const item = {
            date: normalizeDate(pick(row, HEADERS.date)),
            category1: String(pick(row, HEADERS.category1) || '').trim(),
            category2: String(pick(row, HEADERS.category2) || '').trim(),
            store: String(pick(row, HEADERS.store) || '').trim(),
            entity: String(pick(row, HEADERS.entity) || '').trim(),
            counterparty: String(pick(row, HEADERS.counterparty) || '').trim(),
            description: String(pick(row, HEADERS.description) || '').trim(),
            note: String(pick(row, HEADERS.note) || '').trim(),
            _line: line,
          };
          if (isWallet) {
            const income = toNumber(pick(row, HEADERS.income));
            const expense = toNumber(pick(row, HEADERS.expense));
            item.income = income; item.expense = expense;
            item.direction = income > 0 ? 'income' : expense > 0 ? 'expense' : '';
            item.amount = income > 0 ? income : expense;
            item.operator = String(pick(row, HEADERS.operator) || '').trim();
            const nick = String(pick(row, ['操作人昵称']) || '').trim();
            if (!item.operator) item.operator = nick;
          } else {
            item.direction = String(pick(row, HEADERS.direction) || '').trim();
            item.amount = toNumber(pick(row, HEADERS.amount));
            item.operator = String(pick(row, HEADERS.operator) || '').trim();
          }
          if (!item.date) return;            // 小荷包的说明行/重复表头直接跳过，不算错误
          if (!Number.isFinite(item.amount) || item.amount <= 0 || !item.direction) {
            errors.push({ line, message: '金额或收支方向读不出来' });
          }
          parsed.push(item);
        });
        if (!parsed.length) throw new Error('文件里没有可导入的数据行');
        // 先让后端跑一遍归类，预览里直接看到「会进哪个分类」，不对的当场改
        try {
          const res = await axios.post('/api/biz-analysis/cashflow/preview', { rows: parsed, source_file: importName.value });
          const suggested = new Map((res.data.rows || []).map((r) => [Number(r.line), r]));
          parsed.forEach((row) => {
            const hit = suggested.get(row._line);
            if (!hit) return;
            row.category1 = hit.category1 || '';
            row.category2 = hit.category2 || '';
            row.entity_name = hit.entity_name || '';
          });
          importSummary.value = res.data.summary || [];
          if (res.data.errors?.length) importErrors.value = res.data.errors;
        } catch (e) {
          // 预览失败不挡导入：按原始行继续，分类为空就进待分类
          importSummary.value = [];
        }
        importRows.value = parsed;
        importErrors.value = importErrors.value.length ? importErrors.value : errors;
        importVisible.value = true;
      } catch (e) {
        ElementPlus.ElMessage.error(e.message || '解析失败');
      } finally {
        if (fileInput.value) fileInput.value.value = '';
      }
    };

    const confirmImport = async () => {
      importBusy.value = true;
      try {
        const res = await axios.post('/api/biz-analysis/cashflow/import', {
          source_file: importName.value,
          rows: importRows.value.map(({ _line, income, expense, entity_name, ...rest }) => ({
            ...rest, entity: entity_name || rest.entity,
          })),
        });
        importResult.value = res.data;
        ElementPlus.ElMessage.success(`导入完成：新增 ${res.data.inserted} 条，重复跳过 ${res.data.skipped} 条` + (res.data.cancelled ? `，退款成对冲抵 ${res.data.cancelled} 条` : ''));
        await Promise.all([loadProfile(), loadList(), loadSummary()]);
      } catch (e) {
        ElementPlus.ElMessage.error(message(e));
      } finally { importBusy.value = false; }
    };

    const pendingCount = computed(() => summary.value.pending || rows.value.filter((r) => !r.category1).length);
    const goPending = async () => {
      tab.value = 'detail';
      status.value = 'pending'; page.value = 1;
      await loadList();
    };

    onMounted(async () => {
      // 档案拉不到（未配置数据库 / 未登录）时不要让整个页面报错，先给出可读的错误提示
      try { await loadProfile(); } catch (e) { error.value = message(e); loading.value = false; return; }
      await Promise.all([loadList(), loadSummary()]);
    });

    return {
      tab, dateRange, direction, category1, category2, category2Options, status, operator, keyword, hasFilter,
      rangeShortcuts, rangeLabel,
      page, pageSize, rows, total, totals, loading, error, profile, summary, selected, bulk, saving,
      expenseCats, incomeCats, catsOf, groupOfCat, entityName, storeName, subOptionsOf, bulkSubOptions, money,
      loadList, loadSummary, reload, patchRow, applyBulk, removeRow,
      importVisible, importName, importRows, importErrors, importSummary, importBusy, importResult, fileInput, parseFile, confirmImport,
      pendingCount, goPending,
    };
  },
  template: `
  <section class="erp-route-page biz-page biz-cashflow" :class="embedded ? 'biz-embedded' : ''" v-loading="loading">
    <!-- 嵌在股东权益页签时不重复渲染自己的页头 -->
    <header v-if="!embedded" class="biz-head">
      <div>
        <h1 class="biz-title">资金流水</h1>
        <p class="biz-sub">导入真实的收入与支出，按分类汇总；分类拿不准的先导入，再在这里手动选定（选择结果会作为分析维度保留）</p>
      </div>
    </header>

    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="biz-alert" />
    <el-alert v-if="pendingCount" type="warning" show-icon :closable="false" class="biz-alert"
      :title="'还有 ' + pendingCount + ' 笔流水没有分类，先分类才能进月度汇总'" @click="goPending" style="cursor:pointer" />

    <div class="biz-kpis biz-kpis-4">
      <div class="biz-kpi"><span>收入合计</span><strong>{{ money(totals.income) }}</strong><small>{{ hasFilter ? '当前筛选范围' : '全部流水' }}</small></div>
      <div class="biz-kpi"><span>支出合计</span><strong>{{ money(totals.expense) }}</strong><small>{{ hasFilter ? '当前筛选范围' : '全部流水' }}</small></div>
      <div class="biz-kpi"><span>净额</span><strong :class="totals.net < 0 ? 'biz-neg' : ''">{{ money(totals.net) }}</strong><small>收入 − 支出</small></div>
      <div class="biz-kpi"><span>笔数</span><strong>{{ total }}</strong><small>{{ hasFilter ? '当前筛选命中' : '全部流水' }}</small></div>
    </div>

    <el-tabs v-model="tab" @tab-change="reload">
      <el-tab-pane label="明细" name="detail">
        <div class="biz-toolbar">
          <el-date-picker v-model="dateRange" type="daterange" value-format="YYYY-MM-DD" unlink-panels
            range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" style="width:250px"
            @change="() => { page = 1; loadList(); }" />
          <el-select v-model="direction" placeholder="收支" clearable style="width:100px" @change="() => { page = 1; loadList(); }">
            <el-option label="收入" value="income" /><el-option label="支出" value="expense" />
          </el-select>
          <el-select v-model="category1" placeholder="一级分类" clearable filterable style="width:130px"
            @change="() => { category2 = ''; page = 1; loadList(); }">
            <el-option v-for="c in profile.categories" :key="c.id" :label="c.name" :value="c.name" />
          </el-select>
          <el-select v-model="category2" placeholder="二级分类" clearable filterable style="width:150px"
            @change="() => { page = 1; loadList(); }">
            <el-option v-for="c in category2Options" :key="c" :label="c" :value="c" />
          </el-select>
          <el-select v-model="status" placeholder="全部状态" clearable style="width:120px" @change="() => { page = 1; loadList(); }">
            <el-option label="待分类" value="pending" /><el-option label="已分类" value="confirmed" />
          </el-select>
          <el-select v-model="operator" placeholder="操作人" clearable style="width:110px" @change="() => { page = 1; loadList(); }">
            <el-option v-for="o in (profile.operators || [])" :key="o" :label="o" :value="o" />
          </el-select>
          <el-input v-model="keyword" placeholder="对方 / 备注" clearable style="width:160px" @keyup.enter="() => { page = 1; loadList(); }" @clear="() => { page = 1; loadList(); }" />
          <div class="biz-toolbar-actions">
            <el-button :icon="'Search'" @click="() => { page = 1; loadList(); }">查询</el-button>
            <el-button type="primary" :icon="'Upload'" @click="fileInput.click()">导入流水</el-button>
          </div>
          <input ref="fileInput" type="file" accept=".xlsx,.xls,.csv" style="display:none" @change="e => parseFile(e.target.files[0])" />
        </div>

        <div v-if="selected.length" class="biz-bulk">
          <span>已选 {{ selected.length }} 条，批量设置：</span>
          <el-select v-model="bulk.category1" placeholder="一级分类" clearable size="small" style="width:140px"
            @change="bulk.category2 = ''">
            <el-option v-for="c in profile.categories" :key="c.id" :label="c.name" :value="c.name" />
          </el-select>
          <el-select v-model="bulk.category2" placeholder="二级分类" clearable filterable allow-create size="small" style="width:150px">
            <el-option v-for="c in bulkSubOptions" :key="c" :label="c" :value="c" />
          </el-select>
          <el-button size="small" type="primary" :loading="saving" @click="applyBulk">应用</el-button>
          <el-button size="small" @click="selected = []">取消</el-button>
        </div>

        <el-table :data="rows" size="small" border :row-class-name="({row}) => row.category1 ? '' : 'biz-row-pending'"
          @selection-change="v => selected = v" empty-text="还没有流水，先「导入流水」">
          <el-table-column type="selection" width="42" />
          <el-table-column label="日期" width="106"><template #default="{row}">{{ row.date }}</template></el-table-column>
          <el-table-column label="收支" width="76" align="center"><template #default="{row}">
            <el-tag size="small" :type="row.direction === 'income' ? 'success' : 'danger'" effect="light">{{ row.direction === 'income' ? '收入' : '支出' }}</el-tag>
          </template></el-table-column>
          <el-table-column label="金额" width="120" align="right"><template #default="{row}">
            <b :class="row.direction === 'income' ? 'biz-pos' : 'biz-neg'">{{ money(row.amount_cny) }}</b>
          </template></el-table-column>
          <el-table-column label="大类" width="88"><template #default="{row}"><span class="biz-muted">{{ row.category_group || groupOfCat(row.category1) }}</span></template></el-table-column>
          <el-table-column label="一级分类" width="150"><template #default="{row}">
            <el-select v-model="row.category1" size="small" placeholder="待分类" filterable
              @change="v => patchRow(row, { category1: v })">
              <el-option v-for="c in catsOf(row)" :key="c.id" :label="c.name" :value="c.name" />
            </el-select>
          </template></el-table-column>
          <el-table-column label="二级分类" width="160"><template #default="{row}">
            <el-select v-model="row.category2" size="small" placeholder="选填" clearable filterable allow-create
              default-first-option @change="v => patchRow(row, { category2: v || '' })">
              <el-option v-for="c in subOptionsOf(row)" :key="c" :label="c" :value="c" />
            </el-select>
          </template></el-table-column>
          <el-table-column label="交易说明/对方" min-width="170" show-overflow-tooltip><template #default="{row}">{{ row.description || row.counterparty || '—' }}</template></el-table-column>
          <el-table-column label="操作人" width="90"><template #default="{row}">{{ row.operator || '—' }}</template></el-table-column>
          <el-table-column label="备注" min-width="140" show-overflow-tooltip><template #default="{row}">{{ row.note || '—' }}</template></el-table-column>
          <el-table-column label="来源" width="90" show-overflow-tooltip><template #default="{row}"><span class="biz-muted">{{ row.source_file || '手工' }}</span></template></el-table-column>
          <el-table-column label="修正" width="72" align="center"><template #default="{row}">
            <el-tooltip v-if="row.manual_corrected" content="分类/归属是人工改过的，汇总按人工口径统计"><el-tag size="small" type="warning" effect="plain">已修正</el-tag></el-tooltip>
            <span v-else class="biz-muted">—</span>
          </template></el-table-column>
          <el-table-column label="操作" width="70" align="center"><template #default="{row}">
            <el-button size="small" type="danger" link @click="removeRow(row)">删除</el-button>
          </template></el-table-column>
        </el-table>

        <el-pagination style="margin-top:12px; justify-content:flex-end" layout="total, sizes, prev, pager, next"
          :total="total" :current-page="page" :page-size="pageSize" :page-sizes="[50,100,200,500]"
          @current-change="p => { page = p; loadList(); }" @size-change="s => { pageSize = s; page = 1; loadList(); }" />
      </el-tab-pane>

      <el-tab-pane label="汇总" name="summary">
        <div class="biz-toolbar">
          <el-date-picker v-model="dateRange" type="daterange" value-format="YYYY-MM-DD" unlink-panels
            :shortcuts="rangeShortcuts" range-separator="至"
            start-placeholder="开始日期" end-placeholder="结束日期" style="width:260px"
            @change="loadSummary" />
          <span class="biz-muted">统计范围：{{ rangeLabel }}</span>
        </div>

        <div class="biz-kpis biz-kpis-3" style="margin-bottom:16px">
          <div class="biz-kpi"><span>收入合计</span><strong>{{ money(summary.totals.income) }}</strong></div>
          <div class="biz-kpi"><span>支出合计</span><strong>{{ money(summary.totals.expense) }}</strong></div>
          <div class="biz-kpi"><span>净额</span><strong :class="summary.totals.net < 0 ? 'biz-neg' : ''">{{ money(summary.totals.net) }}</strong></div>
        </div>

        <div class="biz-card" style="margin-bottom:16px">
          <div class="biz-card-head">按大类 <small>采购类 / 销售类 / 经营类（内部划转单独列在未分类）</small></div>
          <el-table :data="summary.byGroup" size="small" border empty-text="还没有数据">
            <el-table-column label="大类" width="110"><template #default="{row}"><b>{{ row.category_group }}</b></template></el-table-column>
            <el-table-column label="收入" align="right"><template #default="{row}"><span :class="row.income ? 'biz-pos' : 'biz-zero'">{{ money(row.income) }}</span></template></el-table-column>
            <el-table-column label="支出" align="right"><template #default="{row}"><span :class="row.expense ? 'biz-neg' : 'biz-zero'">{{ money(row.expense) }}</span></template></el-table-column>
            <el-table-column label="净额" align="right"><template #default="{row}"><b :class="row.net < 0 ? 'biz-neg' : ''">{{ money(row.net) }}</b></template></el-table-column>
            <el-table-column label="笔数" align="right" width="80"><template #default="{row}">{{ row.count }}</template></el-table-column>
          </el-table>
        </div>

        <div class="biz-card" style="margin-top:16px">
          <div class="biz-card-head">按二级分类 <small>下钻到渠道/工具/费用名</small></div>
          <el-table :data="summary.bySub" size="small" border max-height="420" empty-text="还没有数据">
            <el-table-column label="大类" width="92"><template #default="{row}"><span class="biz-muted">{{ groupOfCat(row.category1) }}</span></template></el-table-column>
            <el-table-column label="一级分类" width="120" prop="category1" />
            <el-table-column label="二级分类" min-width="220" show-overflow-tooltip prop="category2" />
            <el-table-column label="收入" align="right" width="130"><template #default="{row}"><span :class="row.direction === 'income' && row.total ? 'biz-pos' : 'biz-zero'">{{ row.direction === 'income' ? money(row.total) : '—' }}</span></template></el-table-column>
            <el-table-column label="支出" align="right" width="130"><template #default="{row}"><span :class="row.direction === 'expense' && row.total ? 'biz-neg' : 'biz-zero'">{{ row.direction === 'expense' ? money(row.total) : '—' }}</span></template></el-table-column>
            <el-table-column label="笔数" align="right" width="80" prop="count" />
          </el-table>
        </div>

        <div class="biz-card" style="margin-top:16px">
          <div class="biz-card-head">分类构成 <small>所选区间累计，按一级分类</small></div>
          <el-table :data="summary.byCategory" size="small" border empty-text="还没有已分类的流水">
            <el-table-column label="大类" width="100"><template #default="{row}"><span class="biz-muted">{{ groupOfCat(row.category1) }}</span></template></el-table-column>
            <el-table-column label="一级分类" min-width="140"><template #default="{row}">
              <span :class="row.category1 === '(待分类)' ? 'biz-neg' : ''">{{ row.category1 }}</span>
            </template></el-table-column>
            <el-table-column label="方向" width="90" align="center"><template #default="{row}">
              <el-tag size="small" :type="row.direction === 'income' ? 'success' : 'danger'" effect="light">{{ row.direction === 'income' ? '收入' : '支出' }}</el-tag>
            </template></el-table-column>
            <el-table-column label="金额" align="right" width="170"><template #default="{row}">
              <b>{{ money(row.total) }}</b>
            </template></el-table-column>
            <el-table-column label="笔数" align="right" width="90"><template #default="{row}">{{ row.count }}</template></el-table-column>
          </el-table>
        </div>
      </el-tab-pane>

    </el-tabs>

    <!-- 导入预览 -->
    <el-dialog v-model="importVisible" title="确认导入" width="1080px" :close-on-click-modal="false">
      <div style="margin-bottom:10px">
        <b>{{ importName }}</b> · 解析到 {{ importRows.length }} 行
        <span v-if="importErrors.length" class="biz-neg">，其中 {{ importErrors.length }} 行有问题</span>
        <div class="biz-muted" style="margin-top:6px">下面的「分类」是系统按交易说明自动判断的，导入前可以直接改；留空表示进「待分类」，之后在明细里再选。同一文件重复导入会自动跳过。</div>
      </div>
      <el-alert v-if="importErrors.length" type="warning" show-icon :closable="false" style="margin-bottom:10px"
        :title="importErrors.slice(0,3).map(e => '第' + e.line + '行：' + e.message).join('；') + (importErrors.length > 3 ? ' 等' : '')" />
      <div v-if="importSummary.length" class="biz-import-summary">
        <span class="biz-muted">自动归类结果：</span>
        <span v-for="g in importSummary" :key="g.direction + g.category1" class="biz-chip">
          <el-tag size="small" :type="g.direction === 'income' ? 'success' : 'danger'" effect="plain">{{ g.direction === 'income' ? '收' : '支' }}</el-tag>
          {{ g.category1 }} · {{ g.count }} 笔 · {{ money(g.total) }}
        </span>
      </div>
      <el-table :data="importRows.slice(0, 200)" size="small" border max-height="400">
        <el-table-column label="行" width="56"><template #default="{row}">{{ row._line }}</template></el-table-column>
        <el-table-column label="日期" width="102"><template #default="{row}">{{ row.date || '—' }}</template></el-table-column>
        <el-table-column label="收支" width="72" align="center"><template #default="{row}">
          <el-tag size="small" :type="row.direction === 'income' ? 'success' : 'danger'" effect="light">{{ row.direction === 'income' ? '收入' : row.direction === 'expense' ? '支出' : '—' }}</el-tag>
        </template></el-table-column>
        <el-table-column label="金额" width="104" align="right"><template #default="{row}">{{ money(row.amount) }}</template></el-table-column>
        <el-table-column label="交易说明" min-width="180" show-overflow-tooltip><template #default="{row}">{{ row.description || '—' }}</template></el-table-column>
        <el-table-column label="备注" min-width="120" show-overflow-tooltip><template #default="{row}">{{ row.note || '—' }}</template></el-table-column>
        <el-table-column label="操作人" width="88"><template #default="{row}">{{ row.operator || row.entity_name || '—' }}</template></el-table-column>
        <el-table-column label="大类" width="90"><template #default="{row}"><span class="biz-muted">{{ row.category_group || '未分类' }}</span></template></el-table-column>
        <el-table-column label="分类（可改）" width="150"><template #default="{row}">
          <el-select v-model="row.category1" size="small" placeholder="待分类" clearable filterable>
            <el-option v-for="c in (row.direction === 'income' ? incomeCats : expenseCats)" :key="c.id" :label="c.name" :value="c.name" />
          </el-select>
        </template></el-table-column>
        <el-table-column label="二级分类" width="150"><template #default="{row}">
          <el-input v-model="row.category2" size="small" placeholder="选填" />
        </template></el-table-column>
      </el-table>
      <div v-if="importRows.length > 200" class="biz-muted" style="margin-top:6px">仅预览前 200 行，导入按全部 {{ importRows.length }} 行处理。</div>
      <el-alert v-if="importResult" type="success" show-icon :closable="false" style="margin-top:12px"
        :title="'已导入：新增 ' + importResult.inserted + ' 条，重复跳过 ' + importResult.skipped + ' 条' + (importResult.cancelled ? '，退款成对冲抵 ' + importResult.cancelled + ' 条' : '') + '，待分类 ' + importResult.pending + ' 条'" />
      <template #footer>
        <el-button @click="importVisible = false">关闭</el-button>
        <el-button type="primary" :loading="importBusy" @click="confirmImport">确认导入</el-button>
      </template>
    </el-dialog>
  </section>`,
};
