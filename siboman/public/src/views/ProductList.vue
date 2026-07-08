<template>
  <div class="product-list-view">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>商品列表</span>
          <el-button type="primary" @click="fetchProducts">🔄 刷新同步</el-button>
        </div>
      </template>

      <el-tabs v-model="activeTab" @tab-change="fetchProducts">
        <el-tab-pane label="全部" name="ALL" />
        <el-tab-pane label="销售中" name="VISIBLE" />
        <el-tab-pane label="待审核" name="NOT_MODERATED" />
        <el-tab-pane label="已下架" name="IN_ACTIVE" />
      </el-tabs>

      <el-table :data="products" v-loading="loading">
        <el-table-column label="商品信息" min-width="300">
          <template #default="{ row }">
            <div class="prod-cell">
              <el-image :src="row.image" style="width: 50px; height: 50px" fit="cover" />
              <div class="prod-info">
                <div class="title">{{ row.name }}</div>
                <div class="sku">offer: {{ row.offer_id }}</div>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="价格 (RUB)" width="120">
          <template #default="{ row }">
            <div class="price">₽ {{ row.price }}</div>
            <div class="profit text-success">利润: 30%</div>
          </template>
        </el-table-column>
        <el-table-column label="库存" width="100">
          <template #default="{ row }">
            <el-input-number v-model="row.stock" size="small" :min="0" @change="updateStock(row)" />
          </template>
        </el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="getStatusType(row.status)">{{ row.status_name }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link @click="editProduct(row)">编辑</el-button>
            <el-button type="primary" link @click="syncToOzon(row)">同步</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 复用编辑抽屉 -->
    <CollectionEditDrawer
      v-model="drawer.visible"
      :item-id="drawer.itemId"
      @refresh="fetchProducts"
    />
  </div>
</template>

<script setup>
import { ref, onMounted, reactive } from 'vue';
import { ElMessage } from 'element-plus';
import axios from 'axios';
import CollectionEditDrawer from '../components/CollectionEditDrawer.vue';

const activeTab = ref('ALL');
const loading = ref(false);
const products = ref([]);
const drawer = reactive({ visible: false, itemId: '' });

const fetchProducts = async () => {
  loading.value = true;
  try {
    const storeId = localStorage.getItem('currentStoreId');
    const res = await axios.post('/api/seller/products', {
      visibility: activeTab.value,
      storeId
    });
    products.value = res.data.data.result.items;
  } finally {
    loading.value = false;
  }
};

const editProduct = (row) => {
  // 这里需要后端支持根据 offer_id 找回本地 collect_id 或直接支持编辑 product_id
  drawer.itemId = row.id;
  drawer.visible = true;
};

const updateStock = async (row) => {
  await axios.post('/api/seller/products/stocks', {
    stocks: [{ offer_id: row.offer_id, stock: row.stock }]
  });
  ElMessage.success('库存已更新');
};

const syncToOzon = async (row) => {
  await axios.post('/api/seller/products/sync', { offer_id: row.offer_id });
  ElMessage.success('同步指令已下发');
};

const getStatusType = (status) => {
  if (status === 'selling') return 'success';
  if (status === 'failed') return 'danger';
  return 'info';
};

onMounted(fetchProducts);
</script>

<style scoped>
.prod-cell { display: flex; gap: 10px; align-items: center; }
.title { font-size: 13px; line-height: 1.4; }
.sku { font-size: 11px; color: #999; font-family: monospace; }
.text-success { color: #67c23a; }
</style>
