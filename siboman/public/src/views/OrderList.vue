<template>
  <div class="order-list-view">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>订单管理</span>
          <div class="header-actions">
            <el-button type="primary" :disabled="!selection.length" @click="handleBulkShip">批量标记备货</el-button>
            <el-button type="success" :disabled="!selection.length" @click="handleBulkPrint">批量打印面单</el-button>
          </div>
        </div>
      </template>

      <!-- 批量操作栏 -->
      <div v-if="selection.length" class="selection-bar">
        <span>已选 {{ selection.length }} 单</span>
        <el-divider direction="vertical" />
        <el-button link type="primary" @click="selection = []">取消选择</el-button>
      </div>

      <el-table :data="orders" style="width: 100%" @selection-change="handleSelectionChange">
        <el-table-column type="selection" width="40" />
        
        <!-- C01 倒计时 -->
        <el-table-column label="倒计时" width="120">
          <template #default="{ row }">
            <el-tag :type="getCountdownType(row.shipment_date)">
              {{ formatCountdown(row.shipment_date) }}
            </el-tag>
          </template>
        </el-table-column>

        <!-- C02 货件·状态 -->
        <el-table-column label="货件·状态" width="220">
          <template #default="{ row }">
            <div class="posting-num" @click="copyText(row.posting_number)">
              {{ row.posting_number }}
              <el-icon><DocumentCopy /></el-icon>
            </div>
            <el-tag :type="getStatusType(row.status)">{{ row.status_name }}</el-tag>
          </template>
        </el-table-column>

        <!-- C03 商品 -->
        <el-table-column label="商品">
          <template #default="{ row }">
            <div v-for="item in row.products" :key="item.sku" class="product-mini">
              <el-image :src="item.image" style="width: 30px; height: 30px" fit="cover" />
              <div class="prod-text">
                <div class="prod-name">{{ item.name }}</div>
                <div class="prod-sku">offer: {{ item.offer_id }} x {{ item.quantity }}</div>
              </div>
            </div>
          </template>
        </el-table-column>

        <!-- C04 金额 -->
        <el-table-column label="金额" width="120">
          <template #default="{ row }">
            <div class="price-cny">¥ {{ row.price_cny }}</div>
            <div class="price-rub">₽ {{ row.price_rub }}</div>
          </template>
        </el-table-column>

        <!-- C05 备注 -->
        <el-table-column label="备注" width="200">
          <template #default="{ row }">
            <el-input
              v-model="row.note"
              type="textarea"
              :rows="1"
              autosize
              placeholder="本地备注"
              @blur="saveNote(row)"
            />
          </template>
        </el-table-column>

        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary">详情</el-button>
            <el-button link type="primary" @click="printLabel(row)">面单</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 进度弹窗 -->
    <el-dialog v-model="progress.visible" title="处理中..." :close-on-click-modal="false" width="400px">
      <el-progress :percentage="progress.percent" status="success" />
      <div style="margin-top: 10px">{{ progress.text }}</div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { DocumentCopy } from '@element-plus/icons-vue';
import axios from 'axios';

const orders = ref([]);
const selection = ref([]);
const progress = reactive({
  visible: false,
  percent: 0,
  text: '',
});

const fetchOrders = async () => {
  const res = await axios.get('/api/seller/orders');
  orders.value = res.data.orders;
};

const handleBulkShip = async () => {
  await ElMessageBox.confirm('确认批量标记备货？该操作不可撤销。', '二次确认');
  progress.visible = true;
  progress.percent = 0;
  
  for (let i = 0; i < selection.value.length; i++) {
    const order = selection.value[i];
    progress.text = `正在处理: ${order.posting_number}`;
    try {
      await axios.post('/api/seller/orders/ship-package', { posting_number: order.posting_number });
    } catch (e) {
      console.error(e);
    }
    progress.percent = Math.round(((i + 1) / selection.value.length) * 100);
  }
  
  progress.visible = false;
  ElMessage.success('批量备货完成');
  fetchOrders();
};

const handleBulkPrint = async () => {
  const nums = selection.value.map(o => order.posting_number);
  ElMessage.info('面单合并生成中，请稍后...');
  const res = await axios.post('/api/seller/orders/labels-bulk', { posting_numbers: nums }, { responseType: 'blob' });
  const blob = new Blob([res.data], { type: 'application/pdf' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `labels_${Date.now()}.pdf`;
  a.click();
};

const formatCountdown = (date) => {
  const diff = new Date(date) - new Date();
  if (diff < 0) return '已超时';
  const hours = Math.floor(diff / 3600000);
  return `剩 ${hours}h`;
};

const getCountdownType = (date) => {
  const diff = new Date(date) - new Date();
  if (diff < 0) return 'danger';
  if (diff < 7200000) return 'warning';
  return 'success';
};

onMounted(fetchOrders);
</script>

<style scoped>
.posting-num { cursor: pointer; color: #409eff; font-family: monospace; }
.product-mini { display: flex; gap: 5px; margin-bottom: 5px; }
.prod-text { flex: 1; min-width: 0; }
.prod-name { font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.prod-sku { font-size: 10px; color: #999; }
.selection-bar { background: #f0f9eb; padding: 10px; margin-bottom: 10px; border-radius: 4px; }
</style>
