window.SingleSourcingReviewView = {
  setup() {
    const loading = Vue.ref(false);
    const saving = Vue.ref(false);
    const review = Vue.ref({ job: {}, rows: [], candidateRows: [], confirmedRows: [], batchText: '' });
    const currentJobId = Vue.ref('');
    const jobHistory = Vue.ref([]);
    const activeTab = Vue.ref('sheet');
    const PREFILL_KEY = 'single_sourcing_batch_prefill';
    const RUB_CNY_RATE = 0.0862;

    const apiError = (error) => error?.response?.data?.error || error?.message || '请求失败';
    const notify = {
      success: (m) => ElementPlus.ElMessage.success(m),
      warning: (m) => ElementPlus.ElMessage.warning(m),
      error: (m) => ElementPlus.ElMessage.error(m),
    };
    const formatTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
    const getHashJobId = () => {
      const hash = String(window.location.hash || '');
      const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
      return new URLSearchParams(query).get('id') || '';
    };
    const imageUrl = (url) => {
      const text = String(url || '').trim();
      if (!text || text.startsWith('/')) return text;
      if (/^https?:\/\/([^/]+\.)?(1688|alicdn|alibaba)\.com\//i.test(text)) {
        return `/api/utils/image-proxy?url=${encodeURIComponent(text)}`;
      }
      return text;
    };
    const numberOf = (value) => {
      if (value === 0) return 0;
      const text = String(value ?? '').replace(/,/g, '.').trim();
      if (!text || /无法匹配|未上线|未公开/i.test(text)) return null;
      const match = text.match(/-?\d+(?:\.\d+)?/);
      if (!match) return null;
      const number = Number(match[0]);
      return Number.isFinite(number) ? number : null;
    };
    const money = (value) => {
      const number = numberOf(value);
      if (number === null) return value || '';
      return Number(number.toFixed(2));
    };
    const percent = (value) => {
      const number = numberOf(value);
      if (number === null) return '';
      return `${(number * 100).toFixed(1)}%`;
    };
    const decisionText = (value) => ({
      exact: '完全一致',
      approximate: '近似匹配',
      none: '未匹配',
      needs_review: '待复核',
      no_match: '无匹配',
      match: '可匹配',
      not_match: '不匹配',
    }[value] || value || '待复核');
    const decisionType = (value) => {
      if (value === 'exact' || value === 'match') return 'success';
      if (value === 'none' || value === 'no_match' || value === 'not_match') return 'danger';
      return 'warning';
    };

    const logisticsFor = (row) => {
      const blackPrice = numberOf(row.ozonBlackPrice || row.ozonPrice);
      const realWeightG = numberOf(row.ozonWeight);
      const aiWeightG = numberOf(row.aiEstimatedWeight);
      const weightG = realWeightG ?? aiWeightG;
      const weightKg = weightG !== null ? weightG / 1000 : null;
      const purchase = numberOf(row.estimatedPurchasePriceRmb) ?? numberOf(row.purchasePriceRmb);
      const freight = numberOf(row.candidateFreight);
      const alibabaCost = purchase !== null ? Number((purchase + (freight ?? 0)).toFixed(2)) : null;
      if (blackPrice === null || weightKg === null) {
        return {
          logisticsFee: '',
          commission: blackPrice === null ? '' : money(blackPrice * (blackPrice / RUB_CNY_RATE < 1500 ? 0.12 : 0.2)),
          sticker: blackPrice === null ? '' : 3,
          lastMile: blackPrice === null ? '' : money(blackPrice * 0.02),
          acquiring: blackPrice === null ? '' : money(blackPrice * 0.02),
          totalCost: '',
          profit: '',
          profitRate: '',
          uploadText: row.ozonSku && blackPrice !== null ? `${row.ozonSku},${Math.round(blackPrice * 2)}` : '',
          group: '',
          chargeWeightKg: '',
        };
      }
      const rubValue = blackPrice / RUB_CNY_RATE;
      const volumeKg = 20 * 20 * 20 / 12000;
      let group = '无法匹配';
      if (rubValue <= 1500 && weightKg <= 0.5) group = 'Extra Small';
      else if (rubValue <= 1500 && weightKg > 0.5 && weightKg <= 25) group = 'Budget';
      else if (rubValue > 1500 && rubValue <= 7000 && weightKg <= 2) group = 'Small';
      else if (rubValue > 1500 && rubValue <= 7000 && weightKg > 2 && weightKg <= 30 && Math.max(weightKg, volumeKg) <= 31) group = 'Big';
      else if (rubValue > 7000 && rubValue <= 250000 && weightKg <= 5) group = 'Premium Small';
      else if (rubValue > 7000 && rubValue <= 250000 && weightKg > 5 && weightKg <= 30 && Math.max(weightKg, volumeKg) <= 31) group = 'Premium Big';
      const chargeWeightKg = group === 'Big' || group === 'Premium Big' ? Math.max(weightKg, volumeKg) : weightKg;
      const feeMap = {
        'Extra Small': chargeWeightKg * 28.1 + 3.37,
        Budget: chargeWeightKg * 19.1 + 25.83,
        Small: chargeWeightKg * 28.1 + 17.97,
        Big: chargeWeightKg * 19.1 + 40.44,
        'Premium Small': chargeWeightKg * 28.1 + 24.71,
        'Premium Big': chargeWeightKg * 25.8 + 69.64,
      };
      const logisticsFee = feeMap[group] == null ? null : Number(feeMap[group].toFixed(2));
      const commission = Number((blackPrice * (rubValue < 1500 ? 0.12 : 0.2)).toFixed(2));
      const sticker = 3;
      const lastMile = Number((blackPrice * 0.02).toFixed(2));
      const acquiring = Number((blackPrice * 0.02).toFixed(2));
      const totalCost = logisticsFee === null || alibabaCost === null
        ? null
        : Number((alibabaCost + logisticsFee + commission + sticker + lastMile + acquiring).toFixed(2));
      const profit = totalCost === null ? null : Number((blackPrice - totalCost).toFixed(2));
      return {
        alibabaCost: alibabaCost ?? '',
        logisticsFee: logisticsFee ?? group,
        commission,
        sticker,
        lastMile,
        acquiring,
        totalCost: totalCost ?? '',
        profit: profit ?? '',
        profitRate: profit === null || !blackPrice ? '' : profit / blackPrice,
        uploadText: row.ozonSku && blackPrice !== null ? `${row.ozonSku},${Math.round(blackPrice * 2)}` : '',
        group,
        chargeWeightKg: Number(chargeWeightKg.toFixed(3)),
      };
    };

    const activeRows = Vue.computed(() => review.value.rows || []);
    const confirmedCount = Vue.computed(() => activeRows.value.filter((row) => row.confirmed).length);
    const batchText = Vue.computed(() => activeRows.value
      .filter((row) => row.confirmed && row.ozonSku && Number(row.listingPriceRub) > 0)
      .map((row) => `${row.ozonSku}\t${Number(row.listingPriceRub).toFixed(2)}`)
      .join('\n'));
    const candidateRows = Vue.computed(() => review.value.candidateRows || []);

    const displayColumns = [
      { label: '已选用', prop: 'confirmed', width: 88, fixed: 'left' },
      { label: 'Ozon图片', prop: 'ozonImage', width: 86 },
      { label: '1688图片', prop: 'candidateImage', width: 86 },
      { label: '原始行号', prop: 'sourceRow', width: 86 },
      { label: 'AI判断', prop: 'aiDecision', width: 118 },
      { label: 'AI原因', prop: 'aiReason', width: 320 },
      { label: 'Ozon标题', prop: 'ozonTitle', width: 300 },
      { label: '1688标题', prop: 'candidateTitle', width: 300 },
      { label: '候选序号', prop: 'selectedRank', width: 90 },
      { label: 'Ozon链接', prop: 'ozonUrl', width: 160 },
      { label: '1688链接', prop: 'candidateUrl', width: 160 },
      { label: '盈亏', prop: 'profit', width: 100 },
      { label: '利润率', prop: 'profitRate', width: 100 },
      { label: 'Ozon价格', prop: 'ozonPrice', width: 120 },
      { label: 'Ozon产品黑标价RMB', prop: 'ozonBlackPrice', width: 150 },
      { label: 'Ozon重量（克）', prop: 'ozonWeight', width: 130 },
      { label: 'AI估算重量（克）', prop: 'aiEstimatedWeight', width: 140 },
      { label: '1688价格', prop: 'purchasePriceRmb', width: 110 },
      { label: '1688价格明细', prop: 'candidatePriceDetails', width: 220 },
      { label: '按Ozon件数估算采购价RMB', prop: 'estimatedPurchasePriceRmb', width: 190 },
      { label: '采购倍数', prop: 'purchaseMultiplier', width: 100 },
      { label: 'Ozon件数', prop: 'ozonPackQuantity', width: 100 },
      { label: '1688销售件数', prop: 'candidatePackQuantity', width: 120 },
      { label: '最少起批', prop: 'candidateMoq', width: 110 },
      { label: '1688运费', prop: 'candidateFreight', width: 110 },
      { label: '1688尺寸', prop: 'candidateDimensions', width: 140 },
      { label: '1688重量（克）', prop: 'candidateWeight', width: 130 },
      { label: '阿里巴巴采购价(预)', prop: 'alibabaCost', width: 150 },
      { label: '头程物流费', prop: 'logisticsFee', width: 120 },
      { label: '佣金', prop: 'commission', width: 100 },
      { label: '贴单', prop: 'sticker', width: 80 },
      { label: '尾程物流', prop: 'lastMile', width: 100 },
      { label: '收单业务费', prop: 'acquiring', width: 110 },
      { label: '总成本', prop: 'totalCost', width: 110 },
      { label: 'ozon上架格式', prop: 'uploadText', width: 150 },
      { label: '匹配组别', prop: 'group', width: 130 },
      { label: '计费重量(KG)', prop: 'chargeWeightKg', width: 130 },
      { label: '上架价', prop: 'listingPriceRub', width: 150, fixed: 'right' },
      { label: '备注', prop: 'note', width: 180, fixed: 'right' },
    ];

    const cellValue = (row, prop) => {
      const logistics = ['profit', 'profitRate', 'alibabaCost', 'logisticsFee', 'commission', 'sticker', 'lastMile', 'acquiring', 'totalCost', 'uploadText', 'group', 'chargeWeightKg'];
      if (logistics.includes(prop)) {
        const value = logisticsFor(row)[prop];
        if (prop === 'profitRate') return percent(value);
        return value;
      }
      if (prop === 'aiDecision') return decisionText(row.aiDecision);
      return row[prop] ?? '';
    };

    const fetchHistory = async () => {
      const res = await axios.get('/api/history');
      jobHistory.value = (res.data.items || []).filter(item => item.kind === 'run').slice(0, 50);
      if (!currentJobId.value) {
        const firstDone = jobHistory.value.find(item => ['done', 'running', 'exporting'].includes(item.status));
        if (firstDone?.id) currentJobId.value = firstDone.id;
      }
    };
    const loadReview = async (id = currentJobId.value) => {
      if (!id) return;
      loading.value = true;
      try {
        const res = await axios.get(`/api/jobs/${encodeURIComponent(id)}/review`);
        review.value = res.data.review || { job: {}, rows: [], candidateRows: [] };
        currentJobId.value = id;
      } catch (error) {
        notify.error(apiError(error));
      } finally {
        loading.value = false;
      }
    };
    const refresh = async () => {
      await fetchHistory();
      await loadReview(currentJobId.value);
    };
    const toggleAllConfirmed = (value) => {
      for (const row of activeRows.value) row.confirmed = Boolean(value);
    };
    const isSelectedCandidate = (candidate) => {
      const row = activeRows.value.find(item => Number(item.sourceRow) === Number(candidate.sourceRow));
      return row && Number(row.selectedRank) === Number(candidate.rank);
    };
    const useCandidate = (candidate) => {
      const row = activeRows.value.find(item => Number(item.sourceRow) === Number(candidate.sourceRow));
      if (!row) return;
      row.selectedRank = candidate.rank;
      row.candidateTitle = candidate.title;
      row.candidateUrl = candidate.url;
      row.candidateImage = candidate.image;
      row.purchasePriceRmb = candidate.price || row.purchasePriceRmb;
      row.candidatePriceDetails = candidate.priceDetails || '';
      row.estimatedPurchasePriceRmb = candidate.estimatedPurchasePriceRmb || '';
      row.purchaseMultiplier = candidate.purchaseMultiplier || '';
      row.candidateMoq = candidate.moq;
      row.candidateFreight = candidate.freight;
      row.candidateWeight = candidate.weight;
      row.candidateDimensions = candidate.dimensions;
      row.candidatePackQuantity = candidate.packQuantity;
      row.risk = candidate.risk;
      row.aiDecision = candidate.aiDecision || row.aiDecision;
      row.aiReason = candidate.aiReason || row.aiReason;
      row.confirmed = true;
      activeTab.value = 'sheet';
      notify.success(`已选用第 ${candidate.sourceRow} 行候选 #${candidate.rank}`);
    };
    const saveConfirmations = async () => {
      saving.value = true;
      try {
        const rows = activeRows.value.filter(row => row.confirmed);
        const res = await axios.post(`/api/jobs/${encodeURIComponent(currentJobId.value)}/review/confirm`, { rows });
        review.value.confirmedRows = res.data.confirmed || [];
        review.value.batchText = res.data.batchText || '';
        notify.success(`已确认 ${review.value.confirmedRows.length} 条`);
        return true;
      } catch (error) {
        notify.error(apiError(error));
        return false;
      } finally {
        saving.value = false;
      }
    };
    const copyBatchText = async () => {
      const text = batchText.value || review.value.batchText || '';
      if (!text) return notify.warning('没有可复制的确认数据');
      await navigator.clipboard.writeText(text);
      notify.success('已复制货号和价格');
    };
    const sendToBatchUpload = async () => {
      const text = batchText.value || review.value.batchText || '';
      if (!text) return notify.warning('请先确认至少一条数据');
      const saved = await saveConfirmations();
      if (!saved) return;
      localStorage.setItem(PREFILL_KEY, JSON.stringify({
        from: 'single-sourcing-review',
        jobId: currentJobId.value,
        rows: activeRows.value.filter(row => row.confirmed),
        batchText: text,
        createdAt: new Date().toISOString(),
      }));
      window.location.hash = '#/upload';
    };

    Vue.onMounted(async () => {
      currentJobId.value = getHashJobId();
      await refresh();
    });

    return {
      loading, saving, review, currentJobId, jobHistory, activeTab, activeRows, candidateRows,
      confirmedCount, batchText, displayColumns, formatTime, imageUrl, decisionText, decisionType,
      cellValue, logisticsFor, loadReview, refresh, toggleAllConfirmed, isSelectedCandidate,
      useCandidate, saveConfirmations, copyBatchText, sendToBatchUpload,
    };
  },
  template: `
    <div class="single-sourcing-review" v-loading="loading" style="display:flex; flex-direction:column; gap:14px">
      <section style="background:#fff; border:1px solid #ebeef5; border-radius:6px; padding:16px">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap">
          <div>
            <h2 style="margin:0; font-size:22px">单品找货结果核对</h2>
            <div style="margin-top:6px; color:#606266; font-size:13px">
              按 Ozon-1688 核对表展示，并把头程物流测算并入同一张表。选用候选后会自动打勾。
            </div>
          </div>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
            <el-select v-model="currentJobId" filterable style="width:360px" @change="loadReview">
              <el-option
                v-for="item in jobHistory"
                :key="item.id"
                :label="(item.status || '-') + ' · ' + (item.processed || 0) + '/' + (item.total || item.sourceTotal || 0) + ' · ' + (item.firstUrl || item.id)"
                :value="item.id"
              />
            </el-select>
            <el-button @click="refresh">刷新</el-button>
          </div>
        </div>
        <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:14px">
          <el-tag type="info">任务 {{ review.job?.status || '-' }}</el-tag>
          <el-tag>{{ review.job?.processed || 0 }}/{{ review.job?.total || 0 }}</el-tag>
          <el-tag type="success">已选用 {{ confirmedCount }}</el-tag>
          <span style="color:#909399; font-size:13px; line-height:24px">更新时间：{{ formatTime(review.job?.updatedAt) }}</span>
        </div>
      </section>

      <section style="background:#fff; border:1px solid #ebeef5; border-radius:6px; padding:16px">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:12px; flex-wrap:wrap">
          <el-tabs v-model="activeTab" style="min-width:300px">
            <el-tab-pane label="Excel 核对表" name="sheet" />
            <el-tab-pane label="候选明细" name="candidates" />
          </el-tabs>
          <div style="display:flex; gap:8px; flex-wrap:wrap">
            <el-button @click="toggleAllConfirmed(true)">全选确认</el-button>
            <el-button @click="toggleAllConfirmed(false)">清空确认</el-button>
            <el-button :loading="saving" type="primary" @click="saveConfirmations">保存确认</el-button>
            <el-button type="success" @click="copyBatchText">复制货号价格</el-button>
            <el-button type="warning" @click="sendToBatchUpload">送批量上架</el-button>
          </div>
        </div>

        <el-table v-show="activeTab === 'sheet'" :data="activeRows" border stripe height="620" style="width:100%" row-key="sourceRow">
          <el-table-column
            v-for="col in displayColumns"
            :key="col.prop"
            :label="col.label"
            :width="col.width"
            :fixed="col.fixed"
            show-overflow-tooltip
          >
            <template #default="{ row }">
              <template v-if="col.prop === 'confirmed'">
                <el-checkbox v-model="row.confirmed" />
              </template>
              <template v-else-if="col.prop === 'ozonImage'">
                <el-image v-if="imageUrl(row.ozonImage)" :src="imageUrl(row.ozonImage)" style="width:54px;height:54px;border-radius:6px" fit="cover" :preview-src-list="[imageUrl(row.ozonImage)]" preview-teleported />
              </template>
              <template v-else-if="col.prop === 'candidateImage'">
                <el-image v-if="imageUrl(row.candidateImage)" :src="imageUrl(row.candidateImage)" style="width:54px;height:54px;border-radius:6px" fit="cover" :preview-src-list="[imageUrl(row.candidateImage)]" preview-teleported />
              </template>
              <template v-else-if="col.prop === 'aiDecision'">
                <el-tag :type="decisionType(row.aiDecision)">{{ decisionText(row.aiDecision) }}</el-tag>
              </template>
              <template v-else-if="col.prop === 'ozonUrl'">
                <a :href="row.ozonUrl" target="_blank" rel="noreferrer">Ozon</a>
              </template>
              <template v-else-if="col.prop === 'candidateUrl'">
                <a :href="row.candidateUrl" target="_blank" rel="noreferrer">1688</a>
              </template>
              <template v-else-if="col.prop === 'listingPriceRub'">
                <el-input-number v-model="row.listingPriceRub" :min="0" :precision="2" style="width:126px" />
              </template>
              <template v-else-if="col.prop === 'note'">
                <el-input v-model="row.note" placeholder="人工备注" />
              </template>
              <template v-else>
                <span>{{ cellValue(row, col.prop) || '-' }}</span>
              </template>
            </template>
          </el-table-column>
        </el-table>

        <el-table v-show="activeTab === 'candidates'" :data="candidateRows" border stripe height="620" style="width:100%">
          <el-table-column label="选用" width="90" fixed="left">
            <template #default="{ row }">
              <el-tag v-if="isSelectedCandidate(row)" type="success">✓ 已选</el-tag>
              <el-button v-else size="small" type="primary" @click="useCandidate(row)">选用</el-button>
            </template>
          </el-table-column>
          <el-table-column label="行" prop="sourceRow" width="64" fixed="left" />
          <el-table-column label="序号" prop="rank" width="70" fixed="left" />
          <el-table-column label="图片" width="78">
            <template #default="{ row }"><el-image v-if="imageUrl(row.image)" :src="imageUrl(row.image)" style="width:48px;height:48px;border-radius:6px" fit="cover" :preview-src-list="[imageUrl(row.image)]" preview-teleported /></template>
          </el-table-column>
          <el-table-column label="1688 候选" min-width="360" show-overflow-tooltip>
            <template #default="{ row }">
              <a :href="row.url" target="_blank" rel="noreferrer">{{ row.title }}</a>
              <div style="color:#909399; font-size:12px; margin-top:4px">价格 {{ row.priceDetails || row.price || '-' }} · MOQ {{ row.moq || '-' }} · 运费 {{ row.freight || '-' }} · 重量 {{ row.weight || '-' }}</div>
            </template>
          </el-table-column>
          <el-table-column label="尺寸/风险/判断" min-width="340" show-overflow-tooltip>
            <template #default="{ row }">
              <div v-if="row.dimensions" style="font-size:12px; color:#606266">尺寸 {{ row.dimensions }}</div>
              <div v-if="row.risk" style="font-size:12px; color:#e6a23c; margin-top:4px">{{ row.risk }}</div>
              <div v-if="row.aiReason" style="font-size:12px; color:#909399; margin-top:4px">{{ row.aiReason }}</div>
            </template>
          </el-table-column>
        </el-table>

        <el-alert
          style="margin-top:12px"
          type="info"
          :closable="false"
          title="复制/送批量上架格式"
          :description="batchText || '确认后会生成：Ozon SKU + 上架价，每行一条。'"
        />
      </section>
    </div>
  `
};
