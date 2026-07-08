window.ProductListView = {
  setup() {
    const products = Vue.ref([]);
    const loading = Vue.ref(false);
    const syncLoading = Vue.ref(false);
    const saveLoading = Vue.ref(false);
    const activeTab = Vue.ref('ALL');
    const search = Vue.ref('');
    const drawer = Vue.reactive({ visible: false, itemId: '', form: {}, categoryPath: [] });
    const pagination = Vue.reactive({ currentPage: 1, pageSize: 50, total: 0 });

    // v0.3.2: 不用 Vue.computed 缓存 localStorage (localStorage 非响应式).
    // 动态读取; 请求拦截器会自动往请求里注入 store_id.
    const getStoreId = () => (window.getCurrentStoreId ? window.getCurrentStoreId() : (localStorage.getItem('currentStoreId') || ''));

    const notify = {
      success: (msg) => (window.ElementPlus?.ElMessage || console).success?.(msg),
      warning: (msg) => (window.ElementPlus?.ElMessage || console).warning?.(msg),
      error: (msg) => (window.ElementPlus?.ElMessage || console).error?.(msg),
    };

    const statusTabs = [
      { label: '全部', value: 'ALL' },
      { label: '销售中', value: 'VISIBLE' },
      { label: '待销售', value: 'READY_TO_SUPPLY' },
      { label: '需修改', value: 'NEED_ATTENTION' },
      { label: '已下架', value: 'IN_ACTIVE' },
    ];

    const fetchProducts = async () => {
      const sid = getStoreId();
      if (!sid) return;
      loading.value = true;
      try {
        // store_id 由请求拦截器自动注入; 这里保留显式传参增强可读性
        const res = await axios.post('/api/seller/products', {
          visibility: activeTab.value,
          store_id: sid,
          search: search.value,
          limit: pagination.pageSize,
          offset: (pagination.currentPage - 1) * pagination.pageSize,
        });
        products.value = res.data.items || [];
        pagination.total = Number(res.data.total || 0);
      } catch (e) {
        notify.error('获取列表失败: ' + (e.response?.data?.error || e.message));
      } finally {
        loading.value = false;
      }
    };

    const handleSyncAll = async () => {
      const sid = getStoreId();
      if (!sid) return notify.warning('请先选择店铺');
      syncLoading.value = true;
      try {
        const res = await axios.post('/api/seller/products/sync-all', { store_id: sid }, { timeout: 300000 });
        notify.success(`同步成功：${res.data.count} 个 SKU 落库`);
        pagination.currentPage = 1;
        await fetchProducts();
      } catch (e) {
        notify.error('同步失败: ' + (e.response?.data?.error || e.message));
      } finally {
        syncLoading.value = false;
      }
    };

    const editProduct = (row) => {
      drawer.itemId = row.offer_id;
      drawer.form = JSON.parse(JSON.stringify(row));
      if (!Array.isArray(drawer.form.images)) {
        try { drawer.form.images = JSON.parse(drawer.form.images || '[]'); } catch { drawer.form.images = []; }
      }
      // 若已有 category_name, 初始化 cascader 至末级 (整树加载后能高亮)
      drawer.categoryPath = drawer.form.category_name ? [drawer.form.category_name] : [];
      drawer.visible = true;
    };

    // v0.3.5 类目三级 cascader
    const categoryTree = Vue.ref([]);
    const categoryTreeLoaded = Vue.ref(false);
    const ensureCategoryTree = async (visible) => {
      if (categoryTreeLoaded.value || !visible) return;
      try {
        const r = await axios.post('/api/seller/categories/tree', { store_id: getStoreId() });
        const raw = r.data?.data?.result || [];
        // 清洗: 只保留非空 children 或叶子节点
        const clean = (nodes) => (nodes || []).map(n => ({
          category_name: n.category_name,
          description_category_id: n.description_category_id,
          type_id: n.type_id,
          children: n.children && n.children.length ? clean(n.children) : undefined,
        }));
        categoryTree.value = clean(raw);
        categoryTreeLoaded.value = true;
      } catch (e) {
        notify.error('加载类目树失败: ' + (e.response?.data?.error || e.message));
      }
    };
    const onCategoryChange = (path) => {
      // 保存最叶子的名称 + 全路径
      if (Array.isArray(path) && path.length) {
        drawer.form.category_name = path[path.length - 1];
        drawer.form.category_path = path.join(' / ');
      }
    };

    // v0.3.4 图片工具
    const allPreviewList = () => {
      const imgs = Array.isArray(drawer.form.images) ? drawer.form.images : [];
      return imgs.length ? imgs : (drawer.form.image ? [drawer.form.image] : []);
    };
    const uploadImage = async (opts, mode) => {
      const fd = new FormData();
      fd.append('file', opts.file);
      try {
        const res = await axios.post('/api/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        const url = res.data.url;
        if (mode === 'primary') {
          drawer.form.image = url;
          notify.success('主图已替换 (记得保存)');
        } else {
          if (!Array.isArray(drawer.form.images)) drawer.form.images = [];
          drawer.form.images.push(url);
          notify.success('副图已上传 (记得保存)');
        }
      } catch (e) {
        notify.error('上传失败: ' + (e.response?.data?.error || e.message));
      }
    };
    const removeGalleryImage = (i) => {
      drawer.form.images.splice(i, 1);
    };

    // v0.3.4 AI 增强能力
    const aiImageLoading = Vue.ref(false);
    const aiFillLoading = Vue.ref(false);
    const aiPriceLoading = Vue.ref(false);
    const aiRefineImage = async () => {
      if (!drawer.form.image) return notify.warning('请先上传主图');
      aiImageLoading.value = true;
      try {
        const res = await axios.post('/api/ai/refine-image', {
          store_id: getStoreId(),
          image: drawer.form.image,
          instruction: '去除杂物、白底、增强清晰度',
        });
        if (res.data?.url) { drawer.form.image = res.data.url; notify.success('AI 已优化主图'); }
      } catch (e) { notify.error('AI 改图失败: ' + (e.response?.data?.error || e.message)); }
      finally { aiImageLoading.value = false; }
    };
    const aiFillProduct = async () => {
      if (!drawer.form.name) return notify.warning('请先填商品名称');
      aiFillLoading.value = true;
      try {
        const res = await axios.post('/api/ai/analyze', { store_id: getStoreId(), title: drawer.form.name });
        const d = res.data?.data || {};
        if (d.brand && !drawer.form.brand) drawer.form.brand = d.brand;
        if (d.description) drawer.form.description = d.description;
        if (d.category_name && !drawer.form.category_name) drawer.form.category_name = d.category_name;
        notify.success('AI 已填充可用字段');
      } catch (e) { notify.error('AI 填充失败: ' + (e.response?.data?.error || e.message)); }
      finally { aiFillLoading.value = false; }
    };
    const aiPricing = async () => {
      aiPriceLoading.value = true;
      try {
        const res = await axios.post('/api/ai/pricing', {
          store_id: getStoreId(),
          offer_id: drawer.form.offer_id,
          name: drawer.form.name,
          weight: drawer.form.weight,
        });
        const d = res.data?.data || {};
        if (d.suggested_price) drawer.form.price = d.suggested_price;
        if (d.min_price) drawer.form.min_price = d.min_price;
        notify.success('AI 建议价格已填入');
      } catch (e) { notify.error('AI 核价失败: ' + (e.response?.data?.error || e.message)); }
      finally { aiPriceLoading.value = false; }
    };

    // v0.3.3 归档 / 上架 (调 Ozon /v1/product/archive|unarchive)
    const archiveProduct = async (row) => {
      try {
        await window.ElementPlus.ElMessageBox.confirm(
          `确定归档商品「${row.name}」？归档后 Ozon 前台不可见, 可再上架恢复。`,
          '归档确认',
          { confirmButtonText: '确定归档', cancelButtonText: '取消', type: 'warning' },
        );
      } catch { return; }
      try {
        await axios.post('/api/seller/products/archive', {
          store_id: getStoreId(),
          offer_id: [row.offer_id],
        });
        notify.success('归档成功, 本地状态已同步');
        fetchProducts();
      } catch (e) {
        notify.error('归档失败: ' + (e.response?.data?.payload?.message || e.response?.data?.error || e.message));
      }
    };
    const unarchiveProduct = async (row) => {
      try {
        await axios.post('/api/seller/products/unarchive', {
          store_id: getStoreId(),
          offer_id: [row.offer_id],
        });
        notify.success('已上架, 本地状态已同步');
        fetchProducts();
      } catch (e) {
        notify.error('上架失败: ' + (e.response?.data?.payload?.message || e.response?.data?.error || e.message));
      }
    };

    const saveProduct = async () => {
      saveLoading.value = true;
      try {
        await axios.patch(`/api/seller/products/${encodeURIComponent(drawer.itemId)}/full-update`, {
          ...drawer.form,
          store_id: getStoreId(),
        });
        notify.success('Ozon 同步成功，本地库已刷新');
        drawer.visible = false;
        await fetchProducts();
      } catch (e) {
        notify.error('同步失败: ' + (e.response?.data?.error || e.message));
      } finally {
        saveLoading.value = false;
      }
    };

    const onPageChange = () => fetchProducts();
    const onSizeChange = () => { pagination.currentPage = 1; fetchProducts(); };
    const onTabChange = () => { pagination.currentPage = 1; fetchProducts(); };
    const onSearch = () => { pagination.currentPage = 1; fetchProducts(); };

    // 店铺切换: 重置分页 + 清空数据 + 拉新店铺
    const onShopChanged = () => {
      pagination.currentPage = 1;
      products.value = [];
      pagination.total = 0;
      fetchProducts();
    };
    window.addEventListener('shop-changed', onShopChanged);
    Vue.onBeforeUnmount(() => window.removeEventListener('shop-changed', onShopChanged));

    Vue.onMounted(fetchProducts);

    return {
      products, loading, syncLoading, saveLoading,
      activeTab, statusTabs, search, drawer, pagination,
      fetchProducts, handleSyncAll, editProduct, saveProduct,
      archiveProduct, unarchiveProduct,
      onPageChange, onSizeChange, onTabChange, onSearch,
      // v0.3.5
      categoryTree, ensureCategoryTree, onCategoryChange,
      allPreviewList, uploadImage, removeGalleryImage,
      aiRefineImage, aiFillProduct, aiPricing,
      aiImageLoading, aiFillLoading, aiPriceLoading,
    };
  },
  template: `
    <div class="product-list-v3">
      <el-card>
        <template #header>
          <div style="display:flex; justify-content:space-between; align-items:center">
            <div style="display:flex; align-items:center; gap:12px">
              <span style="font-weight:bold; font-size:15px">商品管理 (v0.3.3)</span>
              <el-tag size="small" type="info">共 {{ pagination.total }} 个 SKU</el-tag>
              <el-button type="success" size="small" @click="() => (window.location.hash = '#/collection')">
                ➕ 新增商品 (采集箱)
              </el-button>
              <el-button type="warning" size="small" :loading="syncLoading" @click="handleSyncAll">🔄 同步 Ozon 商品</el-button>
            </div>
            <div style="display:flex; gap:8px">
              <el-input v-model="search" placeholder="搜 SKU / 货号 / 标题" size="small" style="width:240px" @keyup.enter="onSearch" clearable />
              <el-button type="primary" size="small" @click="onSearch">查询</el-button>
              <el-button size="small" @click="fetchProducts">刷新</el-button>
            </div>
          </div>
        </template>

        <el-tabs v-model="activeTab" @tab-change="onTabChange">
          <el-tab-pane v-for="tab in statusTabs" :key="tab.value" :label="tab.label" :name="tab.value" />
        </el-tabs>

        <el-table :data="products" v-loading="loading" stripe border size="small">
          <el-table-column label="预览" width="70">
            <template #default="{ row }">
              <el-image :src="row.image" style="width:44px; height:44px; border-radius:4px" fit="cover" preview-teleported />
            </template>
          </el-table-column>
          <el-table-column label="商品基本信息" min-width="240">
            <template #default="{ row }">
              <div style="font-size:13px; font-weight:500; line-height:1.4">{{ row.name || '(无标题)' }}</div>
              <div style="font-size:11px; color:#999; margin-top:4px">
                货号 <code>{{ row.offer_id }}</code>
                <span v-if="row.sku"> · SKU <code>{{ row.sku }}</code></span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="120">
            <template #default="{ row }">
              <el-tag size="small" :type="row.status === 'price_sent' ? 'success' : 'info'">
                {{ row.status_name || row.status || '未知' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="价格" width="130" sortable prop="price">
            <template #default="{ row }">
              <span style="font-weight:bold">{{ row.currency_code || 'RUB' }} {{ Number(row.price).toFixed(2) }}</span>
              <div v-if="row.old_price && Number(row.old_price) > Number(row.price)" style="font-size:11px; color:#999; text-decoration:line-through">
                {{ row.currency_code }} {{ Number(row.old_price).toFixed(2) }}
              </div>
            </template>
          </el-table-column>
          <el-table-column label="库存" prop="stock" width="80" sortable />
          <el-table-column label="品牌" prop="brand" width="120" show-overflow-tooltip />
          <el-table-column label="原产国" prop="country_of_origin" width="90" />
          <el-table-column label="尺寸(mm)" width="130">
            <template #default="{ row }">
              <span v-if="row.weight" style="font-size:12px">{{ row.width }}×{{ row.depth }}×{{ row.height }}</span>
              <span v-else style="color:#ccc">-</span>
            </template>
          </el-table-column>
          <el-table-column label="重量(g)" prop="weight" width="80" />
          <el-table-column label="最后同步" prop="updated_at" width="150">
            <template #default="{ row }">
              <span style="font-size:11px; color:#666">{{ (row.updated_at || '').slice(0,19).replace('T',' ') }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="180" fixed="right">
            <template #default="{ row }">
              <el-button type="primary" size="small" @click="editProduct(row)">编辑</el-button>
              <el-button v-if="row.status !== 'IN_ACTIVE'" type="danger" size="small" link @click="archiveProduct(row)">归档</el-button>
              <el-button v-else type="success" size="small" link @click="unarchiveProduct(row)">上架</el-button>
            </template>
          </el-table-column>
        </el-table>

        <!-- v0.3.4: 分页物理 sticky 到底部, 不再随内容滚动 -->
        <div style="position:sticky; bottom:0; left:0; right:0; margin:20px -20px -20px; padding:12px 20px; background:#fff; border-top:1px solid #ebeef5; z-index:10; display:flex; justify-content:flex-end; box-shadow:0 -2px 6px rgba(0,0,0,0.04)">
          <el-pagination
            v-model:current-page="pagination.currentPage"
            v-model:page-size="pagination.pageSize"
            :total="pagination.total"
            :page-sizes="[20, 50, 100, 200]"
            layout="total, sizes, prev, pager, next, jumper"
            @size-change="onSizeChange"
            @current-change="onPageChange"
          />
        </div>
      </el-card>

      <!-- 生产力级编辑抽屉 (v0.3.3 加主图预览 + 归档) -->
      <el-drawer v-model="drawer.visible" title="商品深度编辑 & Ozon 同步" size="760px" destroy-on-close>
        <el-form :model="drawer.form" label-position="top" size="small">
          <!-- v0.3.4 主图 + 图册 + 编辑/替换/新增/删除 -->
          <el-divider content-position="left">
            商品主图与图册
            <span style="font-size:11px; color:#999; margin-left:8px">支持上传替换、拖拽排序、AI 改图</span>
          </el-divider>
          <div style="display:flex; gap:12px; margin-bottom:12px">
            <div style="position:relative; width:180px; height:180px; flex-shrink:0">
              <el-image
                :src="drawer.form.image"
                style="width:180px; height:180px; border:1px solid #ebeef5; border-radius:6px"
                fit="cover"
                preview-teleported
                :preview-src-list="allPreviewList()"
                :initial-index="0">
                <template #error>
                  <div style="width:180px; height:180px; background:#f5f7fa; display:flex; flex-direction:column; align-items:center; justify-content:center; color:#c0c4cc">
                    <el-icon size="32"><Picture /></el-icon>
                    <span style="font-size:12px; margin-top:8px">暂无主图</span>
                  </div>
                </template>
              </el-image>
              <el-upload
                :show-file-list="false"
                :http-request="(o) => uploadImage(o, 'primary')"
                accept="image/*"
                style="position:absolute; bottom:6px; right:6px">
                <el-button size="small" type="primary" circle>
                  <el-icon><Edit /></el-icon>
                </el-button>
              </el-upload>
            </div>
            <div style="flex:1; overflow:hidden">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px">
                <span style="font-size:13px; color:#666">图册 ({{ (drawer.form.images || []).length }} 张)</span>
                <div>
                  <el-upload
                    :show-file-list="false"
                    :http-request="(o) => uploadImage(o, 'gallery')"
                    accept="image/*"
                    style="display:inline-block">
                    <el-button size="small" type="success" plain>
                      <el-icon><Plus /></el-icon>&nbsp;上传副图
                    </el-button>
                  </el-upload>
                  <el-button size="small" type="warning" plain @click="aiRefineImage" :loading="aiImageLoading">
                    ✨ AI 改图
                  </el-button>
                </div>
              </div>
              <div style="display:flex; flex-wrap:wrap; gap:6px; max-height:180px; overflow-y:auto; padding:4px; border:1px dashed #ebeef5; border-radius:4px; min-height:60px">
                <div v-for="(u, i) in (drawer.form.images || [])" :key="i"
                     style="position:relative; width:52px; height:52px">
                  <el-image :src="u" style="width:52px; height:52px; border-radius:4px" fit="cover"
                            preview-teleported :preview-src-list="drawer.form.images" :initial-index="i" />
                  <el-icon @click="removeGalleryImage(i)"
                           style="position:absolute; top:-4px; right:-4px; background:#f56c6c; color:white; border-radius:50%; cursor:pointer; font-size:14px; padding:2px">
                    <Close />
                  </el-icon>
                </div>
                <div v-if="!drawer.form.images?.length" style="font-size:12px; color:#c0c4cc; padding:8px">无副图 · 点击上方"上传副图"新增</div>
              </div>
              <div style="margin-top:8px; display:flex; gap:6px">
                <el-button size="small" plain @click="aiFillProduct" :loading="aiFillLoading">
                  🤖 AI 自动填充商品信息
                </el-button>
                <el-button size="small" plain @click="aiPricing" :loading="aiPriceLoading">
                  💰 AI 智能核价
                </el-button>
              </div>
            </div>
          </div>

          <el-divider content-position="left">基础信息</el-divider>
          <el-row :gutter="16">
            <el-col :span="18">
              <el-form-item label="1. 商品名称 (俄语)">
                <el-input v-model="drawer.form.name" placeholder="Ozon 页面显示的标题" />
              </el-form-item>
            </el-col>
            <el-col :span="6">
              <el-form-item label="2. 品牌">
                <el-input v-model="drawer.form.brand" />
              </el-form-item>
            </el-col>
          </el-row>

          <el-row :gutter="16">
            <el-col :span="8">
              <el-form-item label="3. 原产国">
                <el-select v-model="drawer.form.country_of_origin" style="width:100%" filterable>
                  <el-option label="中国 (Китай)" value="Китай" />
                  <el-option label="俄罗斯 (Россия)" value="Россия" />
                  <el-option label="美国" value="США" />
                  <el-option label="日本" value="Япония" />
                  <el-option label="韩国" value="Республика Корея" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <!-- v0.3.5: 类目三级 cascader, 支持逐级选择 + 搜索, 数据来自 Ozon /v1/description-category/tree -->
              <el-form-item label="4. 类目 (三级 Cascader)">
                <el-cascader
                  v-model="drawer.categoryPath"
                  :options="categoryTree"
                  :props="{ label: 'category_name', value: 'category_name', children: 'children', checkStrictly: false, emitPath: true }"
                  filterable
                  clearable
                  placeholder="选择或搜索 Ozon 类目"
                  style="width:100%"
                  @change="onCategoryChange"
                  @visible-change="ensureCategoryTree" />
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="5. 条形码 Barcode">
                <el-input v-model="drawer.form.barcode" />
              </el-form-item>
            </el-col>
          </el-row>

          <el-divider content-position="left">价格与库存</el-divider>
          <el-row :gutter="16">
            <el-col :span="6">
              <el-form-item label="6. 售价">
                <el-input-number v-model="drawer.form.price" :min="0" :precision="2" style="width:100%" />
              </el-form-item>
            </el-col>
            <el-col :span="6">
              <el-form-item label="7. 划线价 (Old)">
                <el-input-number v-model="drawer.form.old_price" :min="0" :precision="2" style="width:100%" />
              </el-form-item>
            </el-col>
            <el-col :span="6">
              <el-form-item label="8. 最低价 (Min)">
                <el-input-number v-model="drawer.form.min_price" :min="0" :precision="2" style="width:100%" />
              </el-form-item>
            </el-col>
            <el-col :span="3">
              <el-form-item label="9. 币种">
                <el-select v-model="drawer.form.currency_code" style="width:100%">
                  <el-option label="RUB" value="RUB" />
                  <el-option label="CNY" value="CNY" />
                  <el-option label="USD" value="USD" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="3">
              <!-- v0.3.4: 库存不在此编辑, 迁移至库存管理→分仓修改 -->
              <el-form-item label="10. 库存">
                <div style="display:flex; align-items:center; height:32px; padding:0 10px; background:#f5f7fa; border-radius:4px; font-size:12px; color:#909399">
                  <el-icon style="margin-right:4px"><Warning /></el-icon>
                  <span>请至库存管理修改</span>
                </div>
              </el-form-item>
            </el-col>
          </el-row>

          <el-divider content-position="left">物流尺寸 & 重量</el-divider>
          <el-row :gutter="16">
            <el-col :span="6">
              <el-form-item label="11. 重量 (g)">
                <el-input-number v-model="drawer.form.weight" :min="0" style="width:100%" />
              </el-form-item>
            </el-col>
            <el-col :span="6">
              <el-form-item label="12. 宽度 (mm)">
                <el-input-number v-model="drawer.form.width" :min="0" style="width:100%" />
              </el-form-item>
            </el-col>
            <el-col :span="6">
              <el-form-item label="13. 深度 (mm)">
                <el-input-number v-model="drawer.form.depth" :min="0" style="width:100%" />
              </el-form-item>
            </el-col>
            <el-col :span="6">
              <el-form-item label="14. 高度 (mm)">
                <el-input-number v-model="drawer.form.height" :min="0" style="width:100%" />
              </el-form-item>
            </el-col>
          </el-row>

          <el-divider content-position="left">商品描述</el-divider>
          <el-form-item label="15. 详细描述 (Description)">
            <el-input v-model="drawer.form.description" type="textarea" :rows="8" placeholder="Ozon 详情页正文" />
          </el-form-item>

          <el-divider content-position="left">系统只读字段</el-divider>
          <el-descriptions :column="3" size="small" border>
            <el-descriptions-item label="Ozon Product ID">{{ drawer.form.product_id || '-' }}</el-descriptions-item>
            <el-descriptions-item label="Ozon SKU">{{ drawer.form.sku || '-' }}</el-descriptions-item>
            <el-descriptions-item label="Ozon Model ID">{{ drawer.form.model_id || '-' }}</el-descriptions-item>
            <el-descriptions-item label="内部状态">{{ drawer.form.status }}</el-descriptions-item>
            <el-descriptions-item label="Ozon 状态">{{ drawer.form.status_name || '-' }}</el-descriptions-item>
            <el-descriptions-item label="价格指数">{{ drawer.form.price_index || '-' }}</el-descriptions-item>
            <el-descriptions-item label="本地更新" :span="3">{{ (drawer.form.updated_at || '').slice(0,19).replace('T',' ') }}</el-descriptions-item>
          </el-descriptions>
        </el-form>

        <template #footer>
          <el-button @click="drawer.visible = false">取消</el-button>
          <el-button v-if="drawer.form.status !== 'IN_ACTIVE'" type="danger" plain @click="() => { archiveProduct(drawer.form); drawer.visible = false; }">
            归档商品
          </el-button>
          <el-button v-else type="success" plain @click="() => { unarchiveProduct(drawer.form); drawer.visible = false; }">
            重新上架
          </el-button>
          <el-button type="primary" :loading="saveLoading" @click="saveProduct">立即同步至 Ozon</el-button>
        </template>
      </el-drawer>
    </div>
  `
};
