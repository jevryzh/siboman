window.CollectionBoxView = {
  setup() {
    const items = Vue.ref([]);
    const loading = Vue.ref(false);
    const drawer = Vue.reactive({ 
      visible: false, 
      itemId: '', 
      form: {},
      showProfitCalc: false,
      calc: { cost_cny: 0, profit_rate: 30 }
    });
    const importText = Vue.ref('');
    const activeTab = Vue.ref('all');
    const pagination = Vue.reactive({ currentPage: 1, pageSize: 20, total: 0 });

    const currentStoreId = Vue.computed(() => localStorage.getItem('currentStoreId') || '');

    const fetchItems = async () => {
      loading.value = true;
      try {
        const res = await axios.get('/api/collect-items', {
          params: { 
            status: activeTab.value, 
            store_id: currentStoreId.value,
            limit: pagination.pageSize,
            offset: (pagination.currentPage - 1) * pagination.pageSize
          }
        });
        items.value = res.data.items || [];
        pagination.total = res.data.total || 0;
      } finally {
        loading.value = false;
      }
    };

    const handleImport = async () => {
      if (!importText.value.trim()) return;
      try {
        await axios.post('/api/collect-items', { inputs: importText.value, storeId: currentStoreId.value });
        ElementPlus.ElMessage.success('已提交采集');
        importText.value = '';
        fetchItems();
      } catch (e) {
        ElementPlus.ElMessage.error('采集失败');
      }
    };

    const editItem = (row) => {
      drawer.itemId = row.id;
      drawer.form = JSON.parse(JSON.stringify(row));
      // 预设尺寸重量
      drawer.form.weight = drawer.form.weight || 0;
      drawer.form.depth = drawer.form.depth || 0;
      drawer.form.width = drawer.form.width || 0;
      drawer.form.height = drawer.form.height || 0;
      drawer.visible = true;
    };

    const suggestedPrice = Vue.computed(() => {
      if (!drawer.calc.cost_cny) return 0;
      const rate = 0.0862;
      return Math.ceil((drawer.calc.cost_cny / (1 - drawer.calc.profit_rate / 100)) / rate);
    });

    const applySuggestedPrice = () => {
      drawer.form.price_rub = suggestedPrice.value;
      drawer.showProfitCalc = false;
    };

    const saveDraft = async () => {
      try {
        await axios.put(`/api/collect-items/${drawer.itemId}`, drawer.form);
        ElementPlus.ElMessage.success('草稿已物理落地');
        drawer.visible = false;
        fetchItems();
      } catch (e) {
        ElementPlus.ElMessage.error('保存失败');
      }
    };

    const getProfitStyle = (row) => {
      if (!row.price_rub || !row.price_cny) return {};
      const margin = (row.price_rub * 0.0862 - row.price_cny) / (row.price_rub * 0.0862);
      if (margin < 0.15) return { color: '#f56c6c', fontWeight: 'bold' };
      if (margin > 0.30) return { color: '#67c23a', fontWeight: 'bold' };
      return { color: '#e6a23c' };
    };

    Vue.onMounted(fetchItems);
    window.addEventListener('shop-changed', () => { pagination.currentPage = 1; fetchItems(); });

    return { 
      items, loading, importText, handleImport, editItem, drawer, 
      pagination, fetchItems, getProfitStyle, suggestedPrice, applySuggestedPrice, saveDraft 
    };
  },
  template: `
    <div class="collection-box-v3">
      <el-card style="margin-bottom: 20px">
        <div style="display: flex; gap: 10px">
          <el-input v-model="importText" placeholder="粘贴单条或多条 Ozon 链接/SKU..." @keyup.enter="handleImport" />
          <el-button type="primary" @click="handleImport">立即采集</el-button>
        </div>
      </el-card>

      <el-card>
        <el-table :data="items" v-loading="loading" stripe border>
          <el-table-column label="商品信息" min-width="250">
            <template #default="{ row }">
              <div style="display: flex; gap: 10px; align-items: center">
                <el-image :src="row.main_image" style="width: 45px; height: 45px" fit="cover" />
                <div style="flex: 1; min-width: 0">
                  <div class="text-ellipsis" style="font-size: 13px">{{ row.title || '正在采集...' }}</div>
                  <div style="font-size: 11px; color: #999">货号: {{ row.linked_offer_id || '-' }}</div>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="1688 货源" width="120">
             <template #default="{ row }">
                <div v-if="row.price_cny">¥ {{ row.price_cny }}</div>
                <div v-else style="color:#ccc">未匹配</div>
             </template>
          </el-table-column>
          <el-table-column label="状态" width="100" prop="status" />
          <el-table-column label="操作" width="100" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="editItem(row)">编辑/上架</el-button>
            </template>
          </el-table-column>
        </el-table>

        <div style="margin-top: 20px; display: flex; justify-content: flex-end">
          <el-pagination
            v-model:current-page="pagination.currentPage"
            v-model:page-size="pagination.pageSize"
            :total="pagination.total"
            layout="total, prev, pager, next"
            @current-change="fetchItems"
          />
        </div>
      </el-card>

      <!-- 补全 Ozon 死穴字段的编辑抽屉 -->
      <el-drawer v-model="drawer.visible" title="编辑采集商品" size="650px">
        <el-form :model="drawer.form" label-position="top">
          <el-form-item label="商品名称 (俄/英)" required><el-input v-model="drawer.form.title" /></el-form-item>
          
          <el-row :gutter="20">
            <el-col :span="12">
              <el-form-item label="售价 (RUB)" required>
                <el-input-number v-model="drawer.form.price_rub" style="width:100%" />
                <el-button type="success" link size="small" @click="drawer.showProfitCalc = true">
                   <el-icon><Calculator /></el-icon> fx 利润计算器
                </el-button>
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="品牌 (Brand)"><el-input v-model="drawer.form.brand" /></el-form-item>
            </el-col>
          </el-row>

          <el-divider content-position="left">物流规格 (Ozon 备货死穴)</el-divider>
          <el-row :gutter="10">
            <el-col :span="6"><el-form-item label="重量 (g)"><el-input-number v-model="drawer.form.weight" :min="1" /></el-form-item></el-col>
            <el-col :span="6"><el-form-item label="长 (mm)"><el-input-number v-model="drawer.form.depth" :min="1" /></el-form-item></el-col>
            <el-col :span="6"><el-form-item label="宽 (mm)"><el-input-number v-model="drawer.form.width" :min="1" /></el-form-item></el-col>
            <el-col :span="6"><el-form-item label="高 (mm)"><el-input-number v-model="drawer.form.height" :min="1" /></el-form-item></el-col>
          </el-row>

          <el-form-item label="详细描述 (Description)">
             <el-input v-model="drawer.form.description" type="textarea" :rows="8" />
          </el-form-item>
        </el-form>
        
        <template #footer>
          <el-button type="primary" @click="saveDraft">物理保存并同步</el-button>
        </template>
      </el-drawer>

      <!-- fx 计算器弹窗 -->
      <el-dialog v-model="drawer.showProfitCalc" title="fx 利润计算器" width="400px" append-to-body>
        <el-form label-width="120px">
          <el-form-item label="采购成本 (CNY)"><el-input-number v-model="drawer.calc.cost_cny" /></el-form-item>
          <el-form-item label="期望利润率 (%)"><el-input-number v-model="drawer.calc.profit_rate" /></el-form-item>
          <div style="padding: 15px; background:#f0f9eb; border-radius:4px; text-align:center">
             建议售价: <strong style="font-size: 18px; color: #67c23a">₽ {{ suggestedPrice }}</strong>
          </div>
        </el-form>
        <template #footer>
          <el-button type="primary" @click="applySuggestedPrice">应用建议价格</el-button>
        </template>
      </el-dialog>
    </div>
  `
};
