window.InlineEditCell = {
  props: {
    modelValue: [String, Number],
    type: { type: String, default: 'text' }, // text | number | textarea
    placeholder: String
  },
  emits: ['update:modelValue', 'change', 'save'],
  setup(props, { emit }) {
    const isEditing = Vue.ref(false);
    const editValue = Vue.ref(props.modelValue);

    const startEdit = () => {
      editValue.value = props.modelValue;
      isEditing.value = true;
    };

    const cancelEdit = () => {
      isEditing.value = false;
    };

    const confirmEdit = () => {
      emit('update:modelValue', editValue.value);
      emit('save', editValue.value);
      isEditing.value = false;
    };

    return { isEditing, editValue, startEdit, cancelEdit, confirmEdit };
  },
  template: `
    <div class="inline-edit-cell" @mouseenter="showIcon=true" @mouseleave="showIcon=false">
      <div v-if="!isEditing" class="display-box" @click="startEdit" style="cursor: pointer; position: relative;">
        <slot name="display">
          <span>{{ modelValue || '（空）' }}</span>
        </slot>
        <el-icon v-if="showIcon" style="margin-left: 5px; color: #409eff;"><EditPen /></el-icon>
      </div>
      <div v-else class="edit-box" style="display: flex; gap: 5px; align-items: center;">
        <el-input 
          v-model="editValue" 
          :type="type === 'textarea' ? 'textarea' : 'text'" 
          size="small" 
          autofocus
          @keyup.enter="confirmEdit"
          @keyup.esc="cancelEdit"
        />
        <el-button-group>
          <el-button size="small" type="primary" icon="Check" @click="confirmEdit" />
          <el-button size="small" icon="Close" @click="cancelEdit" />
        </el-button-group>
      </div>
    </div>
  `
};
