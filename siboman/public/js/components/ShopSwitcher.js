window.ShopSwitcher = {
  emits: ['change'],
  props: {
    // ozon | yandex | all —— 决定下拉里展示哪个平台的店铺
    platform: { type: String, default: 'ozon' },
    // 2026-11-10 订单页需要「全部店铺」这个聚合口径；只在该页开启，
    //   选中后用独立标记 ordersAllStores 记录，不污染全局 currentStoreId，
    //   这样切到其它页面时顶栏仍显示原来那家店铺，不会被带上 "__all__" 查空。
    allowAll: { type: Boolean, default: false },
  },
  setup(props, { emit }) {
    const ALL_VALUE = '__all__';
    const ALL_FLAG_KEY = 'ordersAllStores';
    const allStores = () => localStorage.getItem(ALL_FLAG_KEY) === '1';
    const shops = Vue.ref([]);
    const currentStoreId = Vue.ref(
      props.allowAll && allStores() ? ALL_VALUE : (localStorage.getItem('currentStoreId') || ''),
    );
    const loading = Vue.ref(false);

    const fetchShops = async () => {
      loading.value = true;
      try {
        const params = props.platform && props.platform !== 'all' ? { platform: props.platform } : {};
        const res = await axios.get('/api/seller/shops', { params });
        shops.value = res.data.shops || [];
        alignSelection();
      } catch (e) {
        console.error('切换器拉取店铺失败', e);
      } finally {
        loading.value = false;
      }
    };

    // 当前选中的店铺若不属于本平台，自动切到本平台第一家
    const alignSelection = () => {
      // 订单页选了「全部店铺」时不动它，否则会被这段逻辑改成第一家店
      if (props.allowAll && currentStoreId.value === ALL_VALUE) return;
      const sid = localStorage.getItem('currentStoreId') || '';
      const valid = shops.value.some((s) => s.id === sid);
      if (!valid && shops.value.length) {
        currentStoreId.value = shops.value[0].id;
        localStorage.setItem('currentStoreId', currentStoreId.value);
        emit('change', currentStoreId.value);
        window.dispatchEvent(new CustomEvent('shop-changed', { detail: currentStoreId.value }));
      } else {
        currentStoreId.value = sid;
      }
    };

    const handleStoreChange = (val) => {
      if (val === ALL_VALUE) {
        localStorage.setItem(ALL_FLAG_KEY, '1');
        currentStoreId.value = ALL_VALUE;
        emit('change', ALL_VALUE);
        window.dispatchEvent(new CustomEvent('shop-changed', { detail: ALL_VALUE }));
        return;
      }
      localStorage.removeItem(ALL_FLAG_KEY);
      localStorage.setItem('currentStoreId', val);
      currentStoreId.value = val;
      emit('change', val);
      window.dispatchEvent(new CustomEvent('shop-changed', { detail: val }));
    };
    const maskClientId = (id) => {
      if (!id) return '';
      return id.length > 8 ? id.slice(0, 4) + '****' + id.slice(-4) : id;
    };
    const displayClientId = (shop) => {
      if (!shop) return '';
      if (shop.client_id_masked) return shop.client_id_masked;
      if (shop.client_id_last4) return `****${shop.client_id_last4}`;
      return maskClientId(shop.client_id);
    };
    const platformLabel = Vue.computed(() =>
      props.platform === 'yandex' ? '切换 Yandex 店铺'
        : props.platform === 'all' ? '切换店铺' : '切换 Ozon 店铺');

    Vue.onMounted(fetchShops);
    Vue.watch(() => props.platform, fetchShops);

    return { shops, currentStoreId, loading, handleStoreChange, displayClientId, platformLabel, ALL_VALUE };
  },
  template: `
    <div class="shop-switcher">
      <el-select 
        v-model="currentStoreId" 
        :placeholder="platformLabel" 
        style="width: 240px"
        v-loading="loading"
        @change="handleStoreChange"
      >
        <el-option v-if="allowAll" :value="ALL_VALUE" label="全部店铺（聚合）">
          <div style="display: flex; align-items: center; gap: 8px">
            <span>全部店铺（聚合）</span>
            <el-tag size="small" type="warning">聚合</el-tag>
          </div>
        </el-option>
        <el-option
          v-for="shop in shops"
          :key="shop.id"
          :label="shop.name"
          :value="shop.id"
        >
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px">
            <span>{{ shop.name }}</span>
            <el-tag size="small" :type="shop.platform === 'yandex' ? 'warning' : 'success'">{{ shop.platform === 'yandex' ? 'Yandex' : 'Ozon' }}</el-tag>
            <el-tag size="small" type="info">{{ displayClientId(shop) }}</el-tag>
          </div>
        </el-option>
        <template #footer>
          <el-button type="primary" link @click="location.hash='#/stores'">+ 店铺授权管理</el-button>
        </template>
      </el-select>
    </div>
  `
};
