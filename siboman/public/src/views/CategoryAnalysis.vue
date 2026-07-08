<template>
  <div class="category-analysis-view">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>类目市场分析</span>
          <el-radio-group v-model="range" size="small" @change="fetchData">
            <el-radio-button label="7">7天</el-radio-button>
            <el-radio-button label="28">28天</el-radio-button>
            <el-radio-button label="90">90天</el-radio-button>
          </el-radio-group>
        </div>
      </template>

      <el-table :data="tableData" v-loading="loading" style="width: 100%" stripe>
        <el-table-column prop="name" label="类目名称" min-width="180" />
        <el-table-column label="销售额 (RUB)" width="150" sortable sort-by="revenue">
          <template #default="{ row }">
            ₽ {{ formatNumber(row.revenue) }}
          </template>
        </el-table-column>
        <el-table-column prop="ordered" label="销量" width="120" sortable />
        <el-table-column label="退货率" width="120">
          <template #default="{ row }">
            <el-progress 
              :percentage="row.returnRate" 
              :status="row.returnRate > 10 ? 'exception' : 'success'"
              :stroke-width="15"
              text-inside
            />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link @click="viewDetails(row)">趋势详情</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import axios from 'axios';

const range = ref('28');
const loading = ref(false);
const tableData = ref([]);

const fetchData = async () => {
  loading.value = true;
  try {
    const storeId = localStorage.getItem('currentStoreId');
    const res = await axios.post('/api/seller/analytics/categories', {
      range: range.value,
      dimension: 'category1',
      storeId
    });
    
    // 转换 Ozon 报表格式
    const rawData = res.data.data?.result?.data || [];
    tableData.value = rawData.map(item => {
      const metrics = item.metrics || [];
      const ordered = metrics[0] || 0;
      const revenue = metrics[1] || 0;
      const returns = metrics[2] || 0;
      return {
        name: item.dimensions[0]?.name || '未知',
        revenue,
        ordered,
        returnRate: ordered > 0 ? parseFloat(((returns / ordered) * 100).toFixed(2)) : 0
      };
    });
  } finally {
    loading.value = false;
  }
};

const formatNumber = (num) => {
  return new Intl.NumberFormat().format(Math.ceil(num));
};

const viewDetails = (row) => {
  // 详情下钻逻辑
};

onMounted(fetchData);
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: center; }
</style>
