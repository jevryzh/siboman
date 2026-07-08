<template>
  <el-drawer
    v-model="visible"
    title="编辑采集商品"
    size="800px"
    :before-close="handleClose"
    destroy-on-close
  >
    <div v-loading="loading" class="edit-drawer-content">
      <!-- 顶栏进度 -->
      <div class="drawer-header-stats">
        <el-progress :percentage="completionPercentage" :format="progressFormat" />
        <div class="stats-text">{{ completedFields }}/{{ totalFields }} 项已完成</div>
      </div>

      <el-form :model="form" label-position="top" ref="formRef">
        <!-- 基础信息 -->
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="目标店铺" required>
              <el-select v-model="form.store_id" placeholder="选择发布店铺" @change="handleStoreChange">
                <el-option
                  v-for="shop in shops"
                  :key="shop.id"
                  :label="shop.name"
                  :value="shop.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="货号 offer_id" required>
              <el-input v-model="form.linked_offer_id" placeholder="自定义或自动生成" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-form-item label="商品类目" required>
          <el-cascader
            v-model="form.category_path"
            :options="categoryOptions"
            :props="cascaderProps"
            placeholder="搜索或选择类目"
            filterable
            @change="handleCategoryChange"
            style="width: 100%"
          />
        </el-form-item>

        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="俄文标题" required>
              <el-input v-model="form.title" type="textarea" :rows="2" maxlength="200" show-word-limit />
              <div class="ai-tools-mini">
                <el-button size="small" type="primary" link @click="handleAiTranslate">🌐 中→俄翻译</el-button>
                <el-button size="small" type="primary" link @click="handleAiOptimize">✨ AI 优化</el-button>
              </div>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="中文标题 (辅助)">
              <el-input v-model="form.title_zh" type="textarea" :rows="2" />
            </el-form-item>
          </el-col>
        </el-row>

        <!-- 价格规格 -->
        <el-divider content-position="left">价格与规格</el-divider>
        <el-row :gutter="20">
          <el-col :span="8">
            <el-form-item label="售价 (RUB)" required>
              <el-input-number v-model="form.price_rub" :precision="2" :step="10" style="width: 100%" />
              <el-button size="small" type="success" link @click="showProfitCalc = true">
                <el-icon><Calculator /></el-icon> fx 利润反推
              </el-button>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="库存" required>
              <el-input-number v-model="form.stock" :min="0" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="重量 (g)" required>
              <el-input-number v-model="form.weight" :min="1" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="20">
          <el-col :span="8"><el-form-item label="长 (mm)" required><el-input-number v-model="form.depth" :min="1" /></el-form-item></el-col>
          <el-col :span="8"><el-form-item label="宽 (mm)" required><el-input-number v-model="form.width" :min="1" /></el-form-item></el-col>
          <el-col :span="8"><el-form-item label="高 (mm)" required><el-input-number v-model="form.height" :min="1" /></el-form-item></el-col>
        </el-row>

        <!-- 图片 -->
        <el-form-item label="商品图片 (第一张为主图)">
          <div class="image-uploader-grid">
            <div v-for="(img, idx) in form.images" :key="idx" class="img-item">
              <el-image :src="img" fit="cover" />
              <div class="img-actions">
                <el-icon @click="removeImage(idx)"><Delete /></el-icon>
                <el-icon v-if="idx > 0" @click="setAsMain(idx)"><Star /></el-icon>
              </div>
            </div>
            <el-upload
              action="/api/upload"
              :show-file-list="false"
              :on-success="handleImageUpload"
              class="uploader-trigger"
            >
              <el-icon><Plus /></el-icon>
            </el-upload>
          </div>
        </el-form-item>

        <!-- 动态属性 -->
        <el-divider content-position="left">类目属性 (Ozon)</el-divider>
        <div v-if="attributes.length" class="dynamic-attributes">
          <el-form-item
            v-for="attr in attributes"
            :key="attr.id"
            :label="attr.name"
            :required="attr.is_required"
          >
            <el-select
              v-if="attr.type === 'option'"
              v-model="form.attrs[attr.id]"
              filterable
              remote
              :remote-method="(q) => fetchAttrValues(attr.id, q)"
              placeholder="选择属性值"
            >
              <el-option
                v-for="v in attrValues[attr.id]"
                :key="v.id"
                :label="v.value"
                :value="v.id"
              />
            </el-select>
            <el-input v-else v-model="form.attrs[attr.id]" placeholder="输入属性内容" />
          </el-form-item>
        </div>
        <el-empty v-else description="请先选择类目以加载属性" :image-size="60" />
      </el-form>
    </div>

    <template #footer>
      <div class="drawer-footer">
        <el-button @click="handleAiAutoFill" type="warning" plain>✨ AI 一键补全</el-button>
        <div class="right-btns">
          <el-button @click="saveDraft">保存草稿</el-button>
          <el-button type="primary" @click="publishToOzon">上架到 Ozon</el-button>
        </div>
      </div>
    </template>

    <!-- 利润计算器 -->
    <el-dialog v-model="showProfitCalc" title="利润反推售价" width="400px" append-to-body>
      <el-form label-width="100px">
        <el-form-item label="采购价 (CNY)">
          <el-input-number v-model="calc.cost_cny" :precision="2" />
        </el-form-item>
        <el-form-item label="期望利润率 (%)">
          <el-input-number v-model="calc.profit_rate" :min="1" :max="100" />
        </el-form-item>
        <div class="calc-result" v-if="suggestedPrice">
          建议售价: <strong>₽ {{ suggestedPrice }}</strong>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="applySuggestedPrice" type="primary">应用价格</el-button>
      </template>
    </el-dialog>
  </el-drawer>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Calculator, Plus, Delete, Star } from '@element-plus/icons-vue';
import axios from 'axios';

const props = defineProps({
  modelValue: Boolean,
  itemId: String,
});
const emit = defineEmits(['update:modelValue', 'refresh']);

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
});

const loading = ref(false);
const shops = ref([]);
const categoryOptions = ref([]);
const attributes = ref([]);
const attrValues = reactive({});
const showProfitCalc = ref(false);

const form = reactive({
  store_id: '',
  linked_offer_id: '',
  category_path: [],
  title: '',
  title_zh: '',
  price_rub: 0,
  stock: 100,
  weight: 0,
  depth: 0,
  width: 0,
  height: 0,
  images: [],
  attrs: {},
});

const calc = reactive({
  cost_cny: 0,
  profit_rate: 30,
});

// 计算建议售价 (逻辑: cost / rate / exchange)
const suggestedPrice = computed(() => {
  if (!calc.cost_cny) return 0;
  const rate = 0.086; // 示例汇率，实际应从 store 获取
  const rub = (calc.cost_cny / (1 - calc.profit_rate / 100)) / rate;
  return Math.ceil(rub);
});

const handleCategoryChange = async (val) => {
  if (!val || !val.length) return;
  const categoryId = val[val.length - 1];
  loading.value = true;
  try {
    const res = await axios.post('/api/seller/categories/attributes', {
      category_id: categoryId,
      storeId: form.store_id
    });
    attributes.value = res.data.data.result || [];
  } finally {
    loading.value = false;
  }
};

const fetchAttrValues = async (attrId, query) => {
  const categoryId = form.category_path[form.category_path.length - 1];
  const res = await axios.post('/api/seller/categories/attribute-values', {
    category_id: categoryId,
    attribute_id: attrId,
    query,
    storeId: form.store_id
  });
  attrValues[attrId] = res.data.data.result || [];
};

const saveDraft = async () => {
  await axios.put(`/api/collect-items/${props.itemId}`, form);
  ElMessage.success('草稿已保存');
  visible.value = false;
  emit('refresh');
};

const publishToOzon = async () => {
  try {
    await axios.post('/api/seller/products/import', {
      item: form,
      storeId: form.store_id
    });
    ElMessage.success('上架任务已提交');
    visible.value = false;
    emit('refresh');
  } catch (e) {
    ElMessage.error('发布失败: ' + e.message);
  }
};

// 进度计算
const totalFields = 12;
const completedFields = computed(() => {
  let count = 0;
  if (form.store_id) count++;
  if (form.category_path.length) count++;
  if (form.title) count++;
  if (form.price_rub > 0) count++;
  if (form.weight > 0) count++;
  if (form.depth > 0) count++;
  // ... 其他
  return count;
});
const completionPercentage = computed(() => Math.round((completedFields.value / totalFields) * 100));

watch(() => props.itemId, async (newId) => {
  if (newId) {
    loading.value = true;
    // 获取详情与店铺列表
    const [itemRes, shopRes] = await Promise.all([
      axios.get(`/api/collect-items/${newId}`),
      axios.get('/api/seller/shops')
    ]);
    shops.value = shopRes.data.shops;
    Object.assign(form, itemRes.data.item);
    loading.value = false;
  }
});
</script>

<style scoped>
.drawer-header-stats { margin-bottom: 20px; }
.ai-tools-mini { margin-top: 5px; }
.image-uploader-grid { display: flex; flex-wrap: wrap; gap: 10px; }
.img-item { width: 80px; height: 80px; position: relative; border: 1px border #eee; }
.uploader-trigger { width: 80px; height: 80px; border: 1px dashed #ccc; display: flex; align-items: center; justify-content: center; }
.drawer-footer { display: flex; justify-content: space-between; align-items: center; }
</style>
