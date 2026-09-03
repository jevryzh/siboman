window.YandexProductListView = {
  setup() {
    const products = Vue.ref([]);
    const loading = Vue.ref(false);
    const saveLoading = Vue.ref(false);
    const hasFetched = Vue.ref(false);
    const activeTab = Vue.ref('all');
    const search = Vue.ref('');
    const pagination = Vue.reactive({ currentPage: 1, pageSize: 50, total: 0 });
    const apiReady = Vue.ref(true);
    const statusCounts = Vue.reactive({ all: 0, published: 0, moderation: 0, need_attention: 0, hidden: 0, archived: 0 });
    const context = Vue.ref(null);
    const drawer = Vue.reactive({
      visible: false,
      form: {
        offer_id: '',
        name: '',
        brand: '',
        description: '',
        category_id: '',
        category_name: '',
        price: 0,
        currency_code: 'RUB',
        imagesText: '',
      },
    });
    const profitDialog = Vue.reactive({
      visible: false,
      cost: {
        purchaseCny: 0,
        domesticShippingCny: 5,
        serviceFeeCny: 3,
        weightKg: 0.02,
        lengthCm: 0,
        widthCm: 0,
        heightCm: 0,
        lastMileCny: 4.68,
        commissionPct: 22,
        acquiringPct: 3.8,
        withdrawalPct: 1.2,
        returnLossPct: 0,
        adPct: 10,
        targetMarginPct: 35,
        strikeDiscountPct: 50,
        exchangeRate: 12.8205,
      },
    });

    const notify = {
      success: (msg) => (window.ElementPlus?.ElMessage || console).success?.(msg),
      warning: (msg) => (window.ElementPlus?.ElMessage || console).warning?.(msg),
      error: (msg) => (window.ElementPlus?.ElMessage || console).error?.(msg),
    };

    const statusTabs = [
      { label: '全部', value: 'all' },
      { label: '销售中', value: 'published' },
      { label: '待审核', value: 'moderation' },
      { label: '待修改', value: 'need_attention' },
      { label: '已下架', value: 'hidden' },
      { label: '归档', value: 'archived' },
    ];
    const statusTabItems = Vue.computed(() => statusTabs.map((tab) => ({
      ...tab,
      count: Number(statusCounts[tab.value] || 0),
    })));

    const statusText = (status) => ({
      published: '销售中',
      moderation: '待审核',
      need_attention: '待修改',
      hidden: '已下架',
      archived: '归档',
    }[String(status || '').toLowerCase()] || status || '-');

    const statusTagType = (status) => ({
      published: 'success',
      moderation: 'warning',
      need_attention: 'danger',
      hidden: 'info',
      archived: 'info',
    }[String(status || '').toLowerCase()] || 'info');

    const moneyText = (value, currency = 'RUB') => {
      const n = Number(value || 0);
      if (!Number.isFinite(n) || n <= 0) return '-';
      return `${currency} ${n.toFixed(2)}`;
    };

    const roundMoney = (value) => {
      const n = Number(value || 0);
      return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
    };

    const priceToCny = (price, currency) => {
      const n = Number(price || 0);
      const rate = Number(profitDialog.cost.exchangeRate || 0);
      if (!Number.isFinite(n) || n <= 0) return 0;
      return String(currency || '').toUpperCase() === 'RUB' && rate > 0 ? n / rate : n;
    };

    const priceFromCny = (priceCny, currency) => {
      const n = Number(priceCny || 0);
      const rate = Number(profitDialog.cost.exchangeRate || 0);
      if (!Number.isFinite(n) || n <= 0) return 0;
      return String(currency || '').toUpperCase() === 'RUB' && rate > 0 ? n * rate : n;
    };

    const calcCelEconomy = (priceCny = 0) => {
      const c = profitDialog.cost;
      const weightKg = Math.max(0, Number(c.weightKg || 0));
      const lengthCm = Math.max(0, Number(c.lengthCm || 0));
      const widthCm = Math.max(0, Number(c.widthCm || 0));
      const heightCm = Math.max(0, Number(c.heightCm || 0));
      const exchangeRate = Number(c.exchangeRate || 0) || 13;
      const priceRub = Math.max(0, Number(priceCny || 0) * exchangeRate);
      const volumeKg = lengthCm > 0 && widthCm > 0 && heightCm > 0 ? (lengthCm * widthCm * heightCm) / 12000 : 0;
      let zone = 'Extra Small';
      let chargeWeightKg = weightKg;
      let fee = weightKg * 28.1 + 3.37;

      if (priceRub <= 1500) {
        if (weightKg <= 0.5) {
          zone = 'Extra Small';
          chargeWeightKg = weightKg;
          fee = chargeWeightKg * 28.1 + 3.37;
        } else {
          zone = 'Budget';
          chargeWeightKg = weightKg;
          fee = chargeWeightKg * 19.1 + 25.83;
        }
      } else if (priceRub <= 7000) {
        if (weightKg <= 2) {
          zone = 'Small';
          chargeWeightKg = weightKg;
          fee = chargeWeightKg * 28.1 + 17.97;
        } else {
          zone = 'Big';
          chargeWeightKg = Math.max(weightKg, volumeKg);
          fee = chargeWeightKg * 19.1 + 40.44;
        }
      } else if (weightKg <= 5) {
        zone = 'Premium Small';
        chargeWeightKg = weightKg;
        fee = chargeWeightKg * 28.1 + 24.71;
      } else {
        zone = 'Premium Big';
        chargeWeightKg = Math.max(weightKg, volumeKg);
        fee = chargeWeightKg * 25.8 + 69.64;
      }

      return {
        zone,
        feeCny: roundMoney(fee),
        chargeWeightKg: roundMoney(chargeWeightKg),
        volumeKg: roundMoney(volumeKg),
        priceRub: roundMoney(priceRub),
      };
    };

    const applyCounts = (counts = {}) => {
      for (const tab of statusTabs) statusCounts[tab.value] = Number(counts[tab.value] || 0);
    };

    const fetchProducts = async () => {
      loading.value = true;
      try {
        const res = await axios.get('/api/yandex/products', {
          params: {
            status: activeTab.value,
            q: search.value,
            page: pagination.currentPage,
            page_size: pagination.pageSize,
          },
        });
        products.value = res.data?.items || res.data?.products || [];
        pagination.total = Number(res.data?.total || products.value.length || 0);
        apiReady.value = res.data?.api_ready !== false;
        context.value = res.data?.context || null;
        applyCounts(res.data?.status_counts || {});
      } catch (error) {
        if (error.response?.status === 404) {
          apiReady.value = false;
          products.value = [];
          pagination.total = 0;
          notify.warning('Yandex 商品 API 还未接入，页面字段已先准备好');
        } else {
          notify.error(error.response?.data?.error || error.message || '读取 Yandex 商品失败');
        }
      } finally {
        hasFetched.value = true;
        loading.value = false;
      }
    };

    const selectStatusTab = (value) => {
      activeTab.value = value;
      pagination.currentPage = 1;
      fetchProducts();
    };

    const resetFilters = () => {
      search.value = '';
      activeTab.value = 'all';
      pagination.currentPage = 1;
      fetchProducts();
    };

    const openEdit = (row) => {
      const images = Array.isArray(row.images) ? row.images : [row.image];
      Object.assign(drawer.form, {
        offer_id: row.offer_id || '',
        name: row.name || row.title || '',
        brand: row.brand || '',
        description: row.raw?.offer?.description || row.description || '',
        category_id: row.category_id || '',
        category_name: row.category_name || '',
        price: Number(row.price || 0),
        currency_code: row.currency_code || 'RUB',
        imagesText: images.filter(Boolean).join('\n'),
      });
      drawer.visible = true;
    };

    const openProfitDialog = () => {
      profitDialog.visible = true;
    };

    const fixedCostWithCross = (crossBorderFeeCny) => {
      const c = profitDialog.cost;
      return roundMoney(
        Number(c.purchaseCny || 0)
        + Number(c.domesticShippingCny || 0)
        + Number(c.serviceFeeCny || 0)
        + Number(crossBorderFeeCny || 0)
        + Number(c.lastMileCny || 0),
      );
    };

    const variableRate = Vue.computed(() => {
      const c = profitDialog.cost;
      return Math.max(0, (
        Number(c.commissionPct || 0)
        + Number(c.acquiringPct || 0)
        + Number(c.withdrawalPct || 0)
        + Number(c.returnLossPct || 0)
        + Number(c.adPct || 0)
      ) / 100);
    });

    const currentPriceCny = Vue.computed(() => roundMoney(priceToCny(drawer.form.price, drawer.form.currency_code)));
    const currentCrossBorder = Vue.computed(() => calcCelEconomy(currentPriceCny.value || 0));
    const fixedCostCny = Vue.computed(() => fixedCostWithCross(currentCrossBorder.value.feeCny));

    const currentProfitPreview = Vue.computed(() => {
      const priceCny = currentPriceCny.value;
      const fees = roundMoney(priceCny * variableRate.value);
      const profit = roundMoney(priceCny - fixedCostCny.value - fees);
      const margin = priceCny > 0 ? roundMoney((profit / priceCny) * 100) : 0;
      return { priceCny, fees, profit, margin };
    });

    const suggestedPriceModel = Vue.computed(() => {
      const targetRate = Math.max(0, Number(profitDialog.cost.targetMarginPct || 0) / 100);
      const denominator = 1 - variableRate.value - targetRate;
      const baseCost = Number(profitDialog.cost.purchaseCny || 0)
        + Number(profitDialog.cost.domesticShippingCny || 0)
        + Number(profitDialog.cost.serviceFeeCny || 0)
        + Number(profitDialog.cost.lastMileCny || 0);
      if (baseCost <= 0 || denominator <= 0.01) return { priceCny: 0, logistics: calcCelEconomy(0), fixedCostCny: 0 };

      let priceCny = roundMoney((baseCost + calcCelEconomy(0).feeCny) / denominator);
      let logistics = calcCelEconomy(priceCny);
      for (let i = 0; i < 5; i += 1) {
        priceCny = roundMoney((baseCost + logistics.feeCny) / denominator);
        logistics = calcCelEconomy(priceCny);
      }
      return { priceCny, logistics, fixedCostCny: fixedCostWithCross(logistics.feeCny) };
    });
    const suggestedPriceCny = Vue.computed(() => suggestedPriceModel.value.priceCny);
    const suggestedCrossBorder = Vue.computed(() => suggestedPriceModel.value.logistics);

    const suggestedPriceDisplay = Vue.computed(() => roundMoney(priceFromCny(suggestedPriceCny.value, drawer.form.currency_code)));
    const strikePriceDisplay = Vue.computed(() => {
      const discount = Number(profitDialog.cost.strikeDiscountPct || 0);
      if (suggestedPriceDisplay.value <= 0 || discount <= 0 || discount >= 100) return 0;
      return roundMoney(suggestedPriceDisplay.value / (discount / 100));
    });

    const applySuggestedPrice = () => {
      if (suggestedPriceDisplay.value <= 0) return notify.warning('请先录入采购成本，并检查费率和目标毛利。');
      drawer.form.price = suggestedPriceDisplay.value;
      notify.success('已把建议售价回填到商品售价');
    };

    const saveProduct = async () => {
      if (!drawer.form.offer_id) return notify.error('缺少 Yandex 货号');
      saveLoading.value = true;
      try {
        const payload = {
          name: drawer.form.name,
          brand: drawer.form.brand,
          description: drawer.form.description,
          marketCategoryId: drawer.form.category_id,
          price: drawer.form.price,
          currency_code: drawer.form.currency_code,
          images: String(drawer.form.imagesText || '').split(/\n|,/).map((item) => item.trim()).filter(Boolean),
        };
        await axios.patch(`/api/yandex/products/${encodeURIComponent(drawer.form.offer_id)}`, payload, { timeout: 120000 });
        notify.success('Yandex 商品已提交更新，平台生效可能需要几分钟');
        drawer.visible = false;
        fetchProducts();
      } catch (error) {
        notify.error(error.response?.data?.error || error.message || '保存 Yandex 商品失败');
      } finally {
        saveLoading.value = false;
      }
    };

    Vue.onMounted(fetchProducts);

    return {
      products, loading, saveLoading, hasFetched, activeTab, search, pagination, apiReady, statusTabItems,
      context, drawer, statusText, statusTagType, moneyText, fetchProducts, selectStatusTab, resetFilters,
      profitDialog, fixedCostCny, currentPriceCny, currentProfitPreview, suggestedPriceDisplay, strikePriceDisplay,
      currentCrossBorder, suggestedCrossBorder,
      openEdit, saveProduct, openProfitDialog, applySuggestedPrice,
    };
  },
  template: `
    <div>
      <div class="erp-toolbar">
        <div>
          <h1 class="erp-workbench-title">Yandex 商品</h1>
          <div class="erp-muted">
            {{ context?.store_name || 'Yandex Market' }}
            <span v-if="context?.campaign_id"> · campaign {{ context.campaign_id }}</span>
            <span v-if="context?.business_id"> · business {{ context.business_id }}</span>
          </div>
        </div>
        <el-button size="large" @click="fetchProducts">
          <el-icon><RefreshRight /></el-icon><span>刷新</span>
        </el-button>
      </div>

      <el-alert
        v-if="!apiReady"
        type="warning"
        :closable="false"
        show-icon
        style="margin-bottom:14px"
        title="Yandex 商品 API 尚未接入"
        description="当前页面已完成菜单、路由和字段布局；API 凭据会放在服务端配置里，避免泄露到浏览器端。" />

      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px">
        <button
          v-for="tab in statusTabItems"
          :key="tab.value"
          type="button"
          @click="selectStatusTab(tab.value)"
          :style="{
            height:'38px', padding:'0 14px', borderRadius:'8px', border: activeTab === tab.value ? '1px solid #111827' : '1px solid #dfe7f1',
            background: activeTab === tab.value ? '#111827' : '#fff', color: activeTab === tab.value ? '#fff' : '#334155',
            fontWeight:800, cursor:'pointer'
          }">
          {{ tab.label }} <span style="opacity:.75">({{ tab.count }})</span>
        </button>
      </div>

      <div class="erp-filter-row">
        <el-input v-model="search" size="large" clearable placeholder="搜索商品 / 货号 / SKU" style="width:360px" @keyup.enter="fetchProducts" />
        <el-button size="large" type="primary" @click="fetchProducts">查询</el-button>
        <el-button size="large" @click="resetFilters">重置</el-button>
      </div>

      <el-table
        :data="products"
        v-loading="loading"
        element-loading-text="正在读取 Yandex 商品..."
        border
        size="large"
        :empty-text="hasFetched ? '暂无 Yandex 商品数据。' : '正在读取商品...'"
        style="border-radius:8px; overflow:hidden">
        <el-table-column type="selection" width="48" />
        <el-table-column label="商品" min-width="360" fixed="left">
          <template #default="{ row }">
            <div style="display:flex; gap:12px; align-items:center; min-width:0">
              <el-image :src="row.image || row.primary_image" style="width:58px; height:58px; border-radius:8px; background:#f1f5f9; flex-shrink:0" fit="cover" preview-teleported>
                <template #error><div style="height:58px; display:flex; align-items:center; justify-content:center; color:#94a3b8; font-size:12px">无图</div></template>
              </el-image>
              <div style="min-width:0">
                <div class="text-ellipsis" style="font-weight:900; color:#0f172a">{{ row.name || row.title || '(无标题)' }}</div>
                <div class="text-ellipsis" style="font-size:12px; color:#94a3b8; margin-top:5px">货号 {{ row.offer_id || '-' }} · SKU {{ row.sku || '-' }}</div>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="130">
          <template #default="{ row }">
            <el-tooltip :content="row.status_name || row.card_status || row.campaign_status || ''" placement="top">
              <el-tag :type="statusTagType(row.status)">{{ statusText(row.status) }}</el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="售价" width="130" align="right">
          <template #default="{ row }">{{ moneyText(row.price, row.currency_code || 'RUB') }}</template>
        </el-table-column>
        <el-table-column label="库存" prop="stock" width="100" align="right" />
        <el-table-column label="品牌" prop="brand" width="140" show-overflow-tooltip />
        <el-table-column label="类目" min-width="190" show-overflow-tooltip>
          <template #default="{ row }">{{ row.category_name || row.category || '-' }}</template>
        </el-table-column>
        <el-table-column label="更新时间" width="180">
          <template #default="{ row }">{{ (row.updated_at || row.updatedAt || '').replace('T',' ').slice(0,19) || '-' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div style="display:flex; justify-content:flex-end; margin-top:14px">
        <el-pagination
          v-model:current-page="pagination.currentPage"
          v-model:page-size="pagination.pageSize"
          :total="pagination.total"
          :page-sizes="[20, 50, 100]"
          layout="total, sizes, prev, pager, next"
          @size-change="fetchProducts"
          @current-change="fetchProducts" />
      </div>

      <el-drawer v-model="drawer.visible" size="620px" title="编辑 Yandex 商品" destroy-on-close>
        <el-form label-width="110px" label-position="left">
          <el-form-item label="货号">
            <el-input v-model="drawer.form.offer_id" disabled />
          </el-form-item>
          <el-form-item label="标题">
            <el-input v-model="drawer.form.name" maxlength="300" show-word-limit />
          </el-form-item>
          <el-form-item label="品牌">
            <el-input v-model="drawer.form.brand" placeholder="vendor" />
          </el-form-item>
          <el-form-item label="类目 ID">
            <el-input v-model="drawer.form.category_id" placeholder="marketCategoryId" />
          </el-form-item>
          <el-form-item label="当前类目">
            <el-input v-model="drawer.form.category_name" disabled />
          </el-form-item>
          <el-form-item label="售价">
            <div style="display:flex; gap:8px; width:100%">
              <el-input-number v-model="drawer.form.price" :min="0" :precision="2" :step="1" style="width:180px" />
              <el-select v-model="drawer.form.currency_code" style="width:120px">
                <el-option label="CNY" value="CNY" />
                <el-option label="RUB" value="RUB" />
              </el-select>
              <el-button type="primary" plain @click="openProfitDialog">利润计算</el-button>
            </div>
          </el-form-item>
          <el-form-item label="图片">
            <el-input v-model="drawer.form.imagesText" type="textarea" :rows="6" placeholder="每行一个图片 URL，第一张为主图" />
          </el-form-item>
          <el-form-item label="描述">
            <el-input v-model="drawer.form.description" type="textarea" :rows="8" />
          </el-form-item>
        </el-form>
        <el-alert type="info" :closable="false" show-icon title="Yandex 更新不是即时生效，提交后平台可能需要几分钟处理。" />
        <template #footer>
          <el-button @click="drawer.visible=false">取消</el-button>
          <el-button type="primary" :loading="saveLoading" @click="saveProduct">保存到 Yandex</el-button>
        </template>
      </el-drawer>

      <el-dialog v-model="profitDialog.visible" title="利润核算" width="980px" append-to-body destroy-on-close>
        <div style="display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:18px; margin-bottom:18px">
          <div style="border:1px solid #e5edf6; border-radius:8px; padding:14px">
            <div style="font-weight:900; color:#475569; margin-bottom:10px">当前售价</div>
            <div style="font-size:28px; font-weight:900; color:#0f172a">{{ moneyText(drawer.form.price, drawer.form.currency_code) }}</div>
            <div style="font-size:13px; color:#94a3b8; margin-top:6px">折合 CNY {{ currentPriceCny.toFixed(2) }}</div>
          </div>
          <div style="border:1px solid #e5edf6; border-radius:8px; padding:14px">
            <div style="font-weight:900; color:#475569; margin-bottom:10px">建议售价</div>
            <div style="font-size:28px; font-weight:900; color:#2563eb">{{ drawer.form.currency_code }} {{ suggestedPriceDisplay.toFixed(2) }}</div>
            <div style="font-size:13px; color:#94a3b8; margin-top:6px">目标毛利 {{ profitDialog.cost.targetMarginPct }}%</div>
          </div>
          <div style="border:1px solid #e5edf6; border-radius:8px; padding:14px">
            <div style="font-weight:900; color:#475569; margin-bottom:10px">当前利润</div>
            <div :style="{fontSize:'28px', fontWeight:900, color: currentProfitPreview.profit >= 0 ? '#16a34a' : '#dc2626'}">¥{{ currentProfitPreview.profit.toFixed(2) }}</div>
            <div style="font-size:13px; color:#94a3b8; margin-top:6px">毛利率 {{ currentProfitPreview.margin.toFixed(1) }}%</div>
          </div>
        </div>

        <el-divider content-position="left">成本设置</el-divider>
        <div style="display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:14px">
          <el-form-item label="采购成本(¥)" label-position="top">
            <el-input-number v-model="profitDialog.cost.purchaseCny" :min="0" :precision="2" :step="1" style="width:100%" />
          </el-form-item>
          <el-form-item label="国内运费(¥)" label-position="top">
            <el-input-number v-model="profitDialog.cost.domesticShippingCny" :min="0" :precision="2" :step="1" style="width:100%" />
          </el-form-item>
          <el-form-item label="代贴单费(¥)" label-position="top">
            <el-input-number v-model="profitDialog.cost.serviceFeeCny" :min="0" :precision="2" :step="1" style="width:100%" />
          </el-form-item>
          <el-form-item label="重量(kg)" label-position="top">
            <el-input-number v-model="profitDialog.cost.weightKg" :min="0" :precision="3" :step="0.01" style="width:100%" />
          </el-form-item>
          <el-form-item label="尾程费(¥)" label-position="top">
            <el-input-number v-model="profitDialog.cost.lastMileCny" :min="0" :precision="2" :step="1" style="width:100%" />
          </el-form-item>
          <el-form-item label="长(cm)" label-position="top">
            <el-input-number v-model="profitDialog.cost.lengthCm" :min="0" :precision="1" :step="1" style="width:100%" />
          </el-form-item>
          <el-form-item label="宽(cm)" label-position="top">
            <el-input-number v-model="profitDialog.cost.widthCm" :min="0" :precision="1" :step="1" style="width:100%" />
          </el-form-item>
          <el-form-item label="高(cm)" label-position="top">
            <el-input-number v-model="profitDialog.cost.heightCm" :min="0" :precision="1" :step="1" style="width:100%" />
          </el-form-item>
          <el-form-item label="平台佣金(%)" label-position="top">
            <el-input-number v-model="profitDialog.cost.commissionPct" :min="0" :max="80" :precision="1" :step="0.5" style="width:100%" />
          </el-form-item>
          <el-form-item label="银行收单费(%)" label-position="top">
            <el-input-number v-model="profitDialog.cost.acquiringPct" :min="0" :max="30" :precision="1" :step="0.2" style="width:100%" />
          </el-form-item>
          <el-form-item label="提现费率(%)" label-position="top">
            <el-input-number v-model="profitDialog.cost.withdrawalPct" :min="0" :max="30" :precision="1" :step="0.2" style="width:100%" />
          </el-form-item>
          <el-form-item label="退货亏损(%)" label-position="top">
            <el-input-number v-model="profitDialog.cost.returnLossPct" :min="0" :max="80" :precision="1" :step="0.5" style="width:100%" />
          </el-form-item>
          <el-form-item label="广告费用(%)" label-position="top">
            <el-input-number v-model="profitDialog.cost.adPct" :min="0" :max="80" :precision="1" :step="0.5" style="width:100%" />
          </el-form-item>
          <el-form-item label="目标毛利(%)" label-position="top">
            <el-input-number v-model="profitDialog.cost.targetMarginPct" :min="1" :max="80" :precision="1" :step="1" style="width:100%" />
          </el-form-item>
          <el-form-item label="汇率(CNY/RUB)" label-position="top">
            <el-input-number v-model="profitDialog.cost.exchangeRate" :min="1" :precision="4" :step="0.1" style="width:100%" />
          </el-form-item>
        </div>
        <el-alert
          type="info"
          :closable="false"
          show-icon
          style="margin:4px 0 16px"
          :title="'CEL Economy 当前头程：' + currentCrossBorder.zone + ' / 计费重 ' + currentCrossBorder.chargeWeightKg.toFixed(3) + 'kg / ¥' + currentCrossBorder.feeCny.toFixed(2)"
          :description="'建议售价按迭代分区计算：' + suggestedCrossBorder.zone + ' / 计费重 ' + suggestedCrossBorder.chargeWeightKg.toFixed(3) + 'kg / ¥' + suggestedCrossBorder.feeCny.toFixed(2)" />

        <el-divider content-position="left">费用明细</el-divider>
        <el-table :data="[profitDialog.cost]" border>
          <el-table-column label="采购成本" width="110">
            <template #default>¥{{ Number(profitDialog.cost.purchaseCny || 0).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="国内运费" width="110">
            <template #default>¥{{ Number(profitDialog.cost.domesticShippingCny || 0).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="代贴单费" width="110">
            <template #default>¥{{ Number(profitDialog.cost.serviceFeeCny || 0).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="头程分区" width="140">
            <template #default>{{ currentCrossBorder.zone }}</template>
          </el-table-column>
          <el-table-column label="计费重" width="100">
            <template #default>{{ currentCrossBorder.chargeWeightKg.toFixed(3) }}kg</template>
          </el-table-column>
          <el-table-column label="跨境头程" width="110">
            <template #default>¥{{ currentCrossBorder.feeCny.toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="尾程费" width="100">
            <template #default>¥{{ Number(profitDialog.cost.lastMileCny || 0).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="固定成本" width="110">
            <template #default>¥{{ fixedCostCny.toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="平台/支付/广告" min-width="150">
            <template #default>¥{{ currentProfitPreview.fees.toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="划线价" width="130">
            <template #default>{{ drawer.form.currency_code }} {{ strikePriceDisplay.toFixed(2) }}</template>
          </el-table-column>
        </el-table>

        <template #footer>
          <el-button @click="profitDialog.visible=false">关闭</el-button>
          <el-button type="primary" @click="applySuggestedPrice">应用建议售价</el-button>
        </template>
      </el-dialog>
    </div>
  `,
};
