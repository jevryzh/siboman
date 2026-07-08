<template>
  <div class="collection-box-view">
    <el-card>
      <template #header>
        <div class="card-header">
          <div class="left">
            <el-input v-model="search" placeholder="输入关键词搜索..." style="width: 300px" @keyup.enter="fetchItems" />
            <el-button type="primary" @click="fetchItems">查询</el-button>
          </div>
          <el-button type="success" @click="showImportModal = true">批量入箱</el-button>
        </div>
      </template>

      <el-tabs v-model="activeTab" @tab-change="fetchItems">
        <el-tab-pane label="全部" name="all" />
        <el-tab-pane label="待处理" name="pending" />
        <el-tab-pane label="已采集" name="scraped" />
        <el-tab-pane label="已上架" name="uploaded" />
        <el-tab-pane label="失败" name="failed" />
      </el-tabs>

      <el-table :data="items" style="width: 100%" v-loading="loading">
        <el-table-column label="商品信息">
          <template #default="{ row }">
            <div class="prod-cell">
              <el-image :src="row.main_image" style="width: 50px; height: 50px" fit="cover" />
              <div class="prod-info">
                <div class="title">{{ row.title || '（未采集）' }}</div>
                <div class="url"><el-link :href="row.ozon_url" target="_blank">{{ row.ozon_sku || '查看链接' }}</el-link></div>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="price_cny" label="采集价 (CNY)" width="120" />
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="getStatusType(row.status)">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="加入时间" width="160" />
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link @click="editItem(row)">编辑</el-button>
            <el-button type="danger" link @click="deleteItem(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <CollectionEditDrawer
      v-model="drawer.visible"
      :item-id="drawer.itemId"
      @refresh="fetchItems"
    />

    <el-dialog v-model="showImportModal" title="批量加入采集箱" width="500px">
      <el-input
        v-model="importText"
        type="textarea"
        placeholder="粘贴 Ozon 商品链接或 SKU，一行一条"
        :rows="10"
      />
      <template #footer>
        <el-button @click="handleBatchImport" type="primary">开始入箱</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted, reactive } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import axios from 'axios';
import CollectionEditDrawer from '../components/CollectionEditDrawer.vue';

const activeTab = ref('all');
const search = ref('');
const loading = ref(false);
const items = ref([]);
const showImportModal = ref(false);
const importText = ref('');

const drawer = reactive({
  visible: false,
  itemId: '',
});

const fetchItems = async () => {
  loading.value = true;
  const res = await axios.get('/api/collect-items', {
    params: { status: activeTab.value, search: search.value }
  });
  items.value = res.data.items;
  loading.value = false;
};

const editItem = (row) => {
  drawer.itemId = row.id;
  drawer.visible = true;
};

const handleBatchImport = async () => {
  if (!importText.value) return;
  await axios.post('/api/collect-items', { inputs: importText.value });
  ElMessage.success('已加入采集箱');
  showImportModal.value = false;
  importText.value = '';
  fetchItems();
};

const deleteItem = async (row) => {
  await ElMessageBox.confirm('确定删除该采集项？');
  await axios.delete(`/api/collect-items/${row.id}`);
  ElMessage.success('已删除');
  fetchItems();
};

const getStatusType = (status) => {
  const map = { pending: 'info', scraped: 'primary', uploaded: 'success', failed: 'danger' };
  return map[status] || 'info';
};

onMounted(fetchItems);
</script>

<style scoped>
.prod-cell { display: flex; gap: 10px; align-items: center; }
.prod-info { flex: 1; min-width: 0; }
.title { font-size: 13px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.url { font-size: 11px; color: #999; }
</style>
