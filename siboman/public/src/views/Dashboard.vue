<template>
  <div class="dashboard-view">
    <el-row :gutter="20">
      <el-col :span="6">
        <el-card shadow="hover" class="stat-card">
          <template #header>今日采集</template>
          <div class="stat-value">{{ stats.today_collected }}</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover" class="stat-card">
          <template #header>待备货订单</template>
          <div class="stat-value">{{ stats.awaiting_packaging }}</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover" class="stat-card">
          <template #header>同步失败商品</template>
          <div class="stat-value text-danger">{{ stats.failed_products }}</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover" class="stat-card">
          <template #header>活跃店铺数</template>
          <div class="stat-value">{{ stats.active_stores }}</div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="20" style="margin-top: 20px">
      <el-col :span="16">
        <el-card header="最近任务">
          <el-table :data="recentJobs" style="width: 100%">
            <el-table-column prop="kind" label="类型" />
            <el-table-column prop="status" label="状态">
              <template #default="{ row }">
                <el-tag :type="row.status === 'done' ? 'success' : 'info'">{{ row.status }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="processed" label="进度">
              <template #default="{ row }">
                {{ row.processed }} / {{ row.total }}
              </template>
            </el-table-column>
            <el-table-column prop="updated_at" label="最后更新" />
          </el-table>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card header="快捷入口">
          <el-button-group>
            <el-button type="primary" icon="Box" @click="$router.push('/collection')">去采集</el-button>
            <el-button type="success" icon="ShoppingCart" @click="$router.push('/orders')">发货</el-button>
          </el-button-group>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import axios from 'axios';

const stats = ref({
  today_collected: 0,
  awaiting_packaging: 0,
  failed_products: 0,
  active_stores: 0
});
const recentJobs = ref([]);

const fetchDashboard = async () => {
  const res = await axios.get('/api/seller/dashboard');
  stats.value = res.data.stats;
  recentJobs.value = res.data.recentJobs;
};

onMounted(fetchDashboard);
</script>

<style scoped>
.stat-card { text-align: center; }
.stat-value { font-size: 32px; font-weight: bold; padding: 10px 0; }
.text-danger { color: #f56c6c; }
</style>
