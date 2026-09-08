window.ShopSwitcher = {
  emits: ['change'],
  props: {
    // ozon | yandex | all —— 决定下拉里展示哪个平台的店铺
    platform: { type: String, default: 'ozon' },
  },
  setup(props, { emit }) {
    const shops = Vue.ref([]);
    const currentStoreId = Vue.ref(localStorage.getItem('currentStoreId') || '');
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
      localStorage.setItem('currentStoreId', val);
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

    return { shops, currentStoreId, loading, handleStoreChange, displayClientId, platformLabel };
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
