window.SingleSourcingReviewView = {
  setup() {
    const loading = Vue.ref(false);
    const saving = Vue.ref(false);
    const review = Vue.ref({ job: {}, rows: [], candidateRows: [], confirmedRows: [], batchText: '' });
    const selectedRows = Vue.ref([]);
    const currentJobId = Vue.ref('');
    const jobHistory = Vue.ref([]);
    const activeTab = Vue.ref('confirm');
    const PREFILL_KEY = 'single_sourcing_batch_prefill';

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
    const rowKey = (row) => `${row.sourceRow}-${row.ozonSku}`;
    const imageUrl = (url) => {
      const text = String(url || '').trim();
      if (!text || text.startsWith('/')) return text;
      if (/^https?:\/\/([^/]+\.)?(1688|alicdn|alibaba)\.com\//i.test(text)) {
        return `/api/utils/image-proxy?url=${encodeURIComponent(text)}`;
      }
      return text;
    };
    const decisionText = (value) => ({
      exact: '完全一致',
      approximate: '近似匹配',
      none: '未匹配',
      needs_review: '待复核',
      no_match: '无匹配',
    }[value] || value || '待复核');
    const decisionType = (value) => {
      if (value === 'exact') return 'success';
      if (value === 'none' || value === 'no_match') return 'danger';
      return 'warning';
    };
    const activeRows = Vue.computed(() => review.value.rows || []);
    const confirmedCount = Vue.computed(() => activeRows.value.filter((row) => row.confirmed).length);
    const batchText = Vue.computed(() => activeRows.value
      .filter((row) => row.confirmed && row.ozonSku && Number(row.listingPriceRub) > 0)
      .map((row) => `${row.ozonSku}\t${Number(row.listingPriceRub).toFixed(2)}`)
      .join('\n'));

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
        selectedRows.value = [];
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

    const useCandidate = (candidate) => {
      const row = activeRows.value.find(item => Number(item.sourceRow) === Number(candidate.sourceRow));
      if (!row) return;
      row.selectedRank = candidate.rank;
      row.candidateTitle = candidate.title;
      row.candidateUrl = candidate.url;
      row.candidateImage = candidate.image;
      row.purchasePriceRmb = candidate.price || row.purchasePriceRmb;
      row.candidateMoq = candidate.moq;
      row.candidateFreight = candidate.freight;
      row.candidateWeight = candidate.weight;
      row.risk = candidate.risk;
      row.aiDecision = candidate.aiDecision || row.aiDecision;
      row.aiReason = candidate.aiReason || row.aiReason;
      row.confirmed = true;
      activeTab.value = 'confirm';
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
      loading, saving, review, currentJobId, jobHistory, activeTab, activeRows,
      selectedRows, confirmedCount, batchText, formatTime, rowKey, imageUrl,
      decisionText, decisionType, loadReview, refresh, toggleAllConfirmed,
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
              在页面里核对 Ozon 商品和 1688 候选，确认后复制或送到批量上架。
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
          <el-tag type="success">已确认 {{ confirmedCount }}</el-tag>
          <span style="color:#909399; font-size:13px; line-height:24px">更新时间：{{ formatTime(review.job?.updatedAt) }}</span>
        </div>
      </section>

      <section style="background:#fff; border:1px solid #ebeef5; border-radius:6px; padding:16px">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:12px; flex-wrap:wrap">
          <el-tabs v-model="activeTab" style="min-width:300px">
            <el-tab-pane label="确认清单" name="confirm" />
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

        <el-table v-show="activeTab === 'confirm'" :data="activeRows" border stripe style="width:100%" row-key="sourceRow">
          <el-table-column label="确认" width="86" fixed="left">
            <template #default="{ row }"><el-checkbox v-model="row.confirmed" /></template>
          </el-table-column>
          <el-table-column label="行" prop="sourceRow" width="64" fixed="left" />
          <el-table-column label="Ozon 商品" min-width="300">
            <template #default="{ row }">
              <div style="display:grid; grid-template-columns:54px minmax(0,1fr); gap:10px; align-items:center">
                <el-image v-if="imageUrl(row.ozonImage)" :src="imageUrl(row.ozonImage)" style="width:48px;height:48px;border-radius:6px" fit="cover" :preview-src-list="[imageUrl(row.ozonImage)]" preview-teleported />
                <div style="min-width:0">
                  <a :href="row.ozonUrl" target="_blank" rel="noreferrer">{{ row.ozonTitle || row.ozonSku }}</a>
                  <div style="color:#909399; font-size:12px; margin-top:4px">SKU {{ row.ozonSku }} · Ozon价 {{ row.ozonPrice || '-' }} · 重量 {{ row.ozonWeight || '-' }} · 件数 {{ row.ozonPackQuantity || '-' }}</div>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="选中 1688" min-width="360">
            <template #default="{ row }">
              <div style="display:grid; grid-template-columns:54px minmax(0,1fr); gap:10px; align-items:center">
                <el-image v-if="imageUrl(row.candidateImage)" :src="imageUrl(row.candidateImage)" style="width:48px;height:48px;border-radius:6px" fit="cover" :preview-src-list="[imageUrl(row.candidateImage)]" preview-teleported />
                <div style="min-width:0">
                  <a :href="row.candidateUrl" target="_blank" rel="noreferrer">#{{ row.selectedRank }} {{ row.candidateTitle || '未选择' }}</a>
                  <div style="color:#606266; font-size:12px; margin-top:4px">采购价 {{ row.purchasePriceRmb || '-' }} · MOQ {{ row.candidateMoq || '-' }} · 运费 {{ row.candidateFreight || '-' }} · 重量 {{ row.candidateWeight || '-' }}</div>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="判断" min-width="220">
            <template #default="{ row }">
              <el-tag :type="decisionType(row.aiDecision)">{{ decisionText(row.aiDecision) }}</el-tag>
              <div v-if="row.risk" style="color:#e6a23c; font-size:12px; margin-top:6px">{{ row.risk }}</div>
              <div v-if="row.aiReason" style="color:#606266; font-size:12px; margin-top:6px">{{ row.aiReason }}</div>
            </template>
          </el-table-column>
          <el-table-column label="上架价" width="150">
            <template #default="{ row }"><el-input-number v-model="row.listingPriceRub" :min="0" :precision="2" style="width:126px" /></template>
          </el-table-column>
          <el-table-column label="备注" min-width="180">
            <template #default="{ row }"><el-input v-model="row.note" placeholder="人工备注" /></template>
          </el-table-column>
        </el-table>

        <el-table v-show="activeTab === 'candidates'" :data="review.candidateRows || []" border stripe style="width:100%">
          <el-table-column label="行" prop="sourceRow" width="64" fixed="left" />
          <el-table-column label="序号" prop="rank" width="70" fixed="left" />
          <el-table-column label="图片" width="78">
            <template #default="{ row }"><el-image v-if="imageUrl(row.image)" :src="imageUrl(row.image)" style="width:48px;height:48px;border-radius:6px" fit="cover" :preview-src-list="[imageUrl(row.image)]" preview-teleported /></template>
          </el-table-column>
          <el-table-column label="1688 候选" min-width="360">
            <template #default="{ row }">
              <a :href="row.url" target="_blank" rel="noreferrer">{{ row.title }}</a>
              <div style="color:#909399; font-size:12px; margin-top:4px">价格 {{ row.priceDetails || row.price || '-' }} · MOQ {{ row.moq || '-' }} · 运费 {{ row.freight || '-' }} · 重量 {{ row.weight || '-' }}</div>
            </template>
          </el-table-column>
          <el-table-column label="尺寸/风险/判断" min-width="300">
            <template #default="{ row }">
              <div v-if="row.dimensions" style="font-size:12px; color:#606266">尺寸 {{ row.dimensions }}</div>
              <div v-if="row.risk" style="font-size:12px; color:#e6a23c; margin-top:4px">{{ row.risk }}</div>
              <div v-if="row.aiReason" style="font-size:12px; color:#909399; margin-top:4px">{{ row.aiReason }}</div>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="110" fixed="right">
            <template #default="{ row }"><el-button size="small" type="primary" @click="useCandidate(row)">选用</el-button></template>
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
