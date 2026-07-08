window.CollectionEditDrawer = {
  props: ['modelValue', 'itemId'],
  emits: ['update:modelValue', 'refresh'],
  setup(props, { emit }) {
    const visible = Vue.computed({
      get: () => props.modelValue,
      set: (v) => emit('update:modelValue', v)
    });

    const form = Vue.reactive({
      store_id: '',
      title: '',
      price_rub: 0,
      stock: 100,
      weight: 0
    });

    const saveDraft = async () => {
      await axios.put(`/api/collect-items/${props.itemId}`, form);
      ElementPlus.ElMessage.success('已保存');
      visible.value = false;
      emit('refresh');
    };

    Vue.watch(() => props.itemId, async (id) => {
      if (id) {
        const res = await axios.get(`/api/collect-items/${id}`);
        Object.assign(form, res.data.item);
      }
    });

    return { visible, form, saveDraft };
  },
  template: `
    <el-drawer v-model="visible" title="编辑采集商品" size="600px">
      <el-form :model="form" label-position="top">
        <el-form-item label="商品标题"><el-input v-model="form.title" /></el-form-item>
        <el-row :gutter="20">
          <el-col :span="12"><el-form-item label="价格 (RUB)"><el-input-number v-model="form.price_rub" style="width:100%" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="重量 (g)"><el-input-number v-model="form.weight" style="width:100%" /></el-form-item></el-col>
        </el-row>
        <el-form-item label="库存"><el-input-number v-model="form.stock" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="saveDraft" type="primary">保存草稿</el-button>
      </template>
    </el-drawer>
  `
};
