window.ShopSwitcher = {
  emits: ['change'],
  setup(props, { emit }) {
    const shops = Vue.ref([]);
    const currentStoreId = Vue.ref(localStorage.getItem('currentStoreId') || '');
    const loading = Vue.ref(false);

    const fetchShops = async () => {
      loading.value = true;
      try {
        const res = await axios.get('/api/seller/shops');
        shops.value = res.data.shops || [];
        if (!currentStoreId.value && shops.value.length) {
          currentStoreId.value = shops.value[0].id;
          localStorage.setItem('currentStoreId', currentStoreId.value);
        }
      } catch (e) {
        console.error('切换器拉取店铺失败', e);
      } finally {
        loading.value = false;
      }
    };

    const handleStoreChange = (val) => {
      localStorage.setItem('currentStoreId', val);
      emit('change', val);
      window.dispatchEvent(new CustomEvent('shop-changed', { detail: val }));
    };

    Vue.onMounted(fetchShops);

    return { shops, currentStoreId, loading, handleStoreChange };
  },
  template: `
    <div class="shop-switcher">
      <el-select 
        v-model="currentStoreId" 
        placeholder="切换 Ozon 店铺" 
        style="width: 220px"
        v-loading="loading"
        @change="handleStoreChange"
      >
        <el-option
          v-for="shop in shops"
          :key="shop.id"
          :label="shop.name"
          :value="shop.id"
        >
          <div style="display: flex; justify-content: space-between; align-items: center">
            <span>{{ shop.name }}</span>
            <el-tag size="small" type="info">{{ shop.client_id.slice(0, 4) }}...{{ shop.client_id.slice(-4) }}</el-tag>
          </div>
        </el-option>
        <template #footer>
          <el-button type="primary" link @click="location.hash='#/stores'">+ 店铺授权管理</el-button>
        </template>
      </el-select>
    </div>
  `
};
