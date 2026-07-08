// v0.3.5 AI 套图 - 粘贴上传 & 交互优化 & 修复下载
window.AIImageGeneratorView = {
  setup() {
    const getStoreId = () => (window.getCurrentStoreId ? window.getCurrentStoreId() : (localStorage.getItem('currentStoreId') || ''));
    const analyzing = Vue.ref(false);
    const generating = Vue.ref(false);
    const uploading = Vue.ref(false);
    const resultImages = Vue.ref([]);
    
    // 预览弹窗状态
    const previewVisible = Vue.ref(false);
    const previewUrl = Vue.ref('');
    const previewIndex = Vue.ref(0);

    const form = Vue.reactive({
      title_zh: '',
      title_ru: '',
      material_images: [],
      selling_points: '',
      image_type: 'main',
      target_market: 'ozon',
      model: 'wanxiang-2.7',
      count: 3,
    });

    const notify = {
      success: m => (window.ElementPlus?.ElMessage || console).success?.(m),
      warning: m => (window.ElementPlus?.ElMessage || console).warning?.(m),
      error: m => (window.ElementPlus?.ElMessage || console).error?.(m),
    };

    Vue.watch(() => form.image_type, (val) => {
      form.count = val === 'main' ? 3 : 6;
    });

    const uploadFile = async (file) => {
      uploading.value = true;
      try {
        const fd = new FormData();
        fd.append('file', file);
        const r = await axios.post('/api/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        if (r.data?.url) form.material_images.push(r.data.url);
        notify.success('素材已上传');
      } catch (e) { notify.error('上传失败'); }
      finally { uploading.value = false; }
    };

    const handlePaste = async (event) => {
      const items = event.clipboardData || event.originalEvent.clipboardData;
      for (const item of items.items) {
        if (item.type.indexOf('image') !== -1) {
          const blob = item.getAsFile();
          await uploadFile(blob);
        }
      }
    };

    const removeMaterial = (i) => form.material_images.splice(i, 1);

    const analyzeSellingPoints = async () => {
      analyzing.value = true;
      try {
        const r = await axios.post('/api/ai/analyze', {
          store_id: getStoreId(),
          title: form.title_zh,
          images: form.material_images,
        });
        const d = r.data?.data || {};
        form.selling_points = (Array.isArray(d.selling_points) ? d.selling_points : []).join('\n');
        if (d.title_ru) form.title_ru = d.title_ru;
        notify.success('AI 分析完成');
      } catch (e) { notify.error('分析失败'); }
      finally { analyzing.value = false; }
    };

    const generateImages = async () => {
      if (!form.material_images.length) return notify.warning('请上传素材');
      generating.value = true;
      resultImages.value = Array(form.count).fill({ loading: true });
      try {
        const r = await axios.post('/api/ai/product-image-set/generate', {
          ...form,
          store_id: getStoreId()
        });
        const urls = (r.data?.images || []).filter(Boolean);
        resultImages.value = urls.map(u => ({ url: typeof u === 'string' ? u : u.url, loading: false }));
        notify.success(`生成完成`);
      } catch (e) {
        resultImages.value = [];
        notify.error('生成失败');
      } finally { generating.value = false; }
    };

    const showPreview = (url, i) => {
      previewUrl.value = url;
      previewIndex.value = i;
      previewVisible.value = true;
    };

    // 核心修复：带代理回滚的 Blob 下载
    const downloadImage = async (url, i) => {
      if (!url) return;
      const filename = `ai_result_${Date.now()}_${i + 1}.jpg`;
      try {
        // 尝试直接 fetch
        let response = await fetch(url, { mode: 'cors' }).catch(() => null);
        let blob;
        
        if (response && response.ok) {
          blob = await response.blob();
        } else {
          // 如果 CORS 失败，使用后端物理代理
          const proxyUrl = `/api/utils/download-proxy?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`;
          const proxyRes = await fetch(proxyUrl);
          if (!proxyRes.ok) throw new Error('Download failed');
          blob = await proxyRes.blob();
        }

        const localUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = localUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(localUrl);
        notify.success('已开始下载');
      } catch (e) {
        window.open(url, '_blank');
        notify.warning('已在新窗口打开');
      }
    };

    const onShopChanged = () => {
      // 切店后清空 resultImages (避免展示其他店的图) + 同步 form 里 material_images
      resultImages.value = [];
      previewVisible.value = false;
      form.material_images = [];
      form.title_zh = '';
      form.title_ru = '';
    };
    window.addEventListener('shop-changed', onShopChanged);
    Vue.onBeforeUnmount(() => window.removeEventListener('shop-changed', onShopChanged));

    return {
      form, analyzing, generating, uploading, resultImages,
      previewVisible, previewUrl, previewIndex,
      handlePaste, removeMaterial, analyzeSellingPoints, generateImages, showPreview, downloadImage,
    };
  },
  template: `
    <div class="ai-image-gen-v035" style="display:flex; gap:16px; min-height:calc(100vh - 130px)">
      <style>
        .paste-upload-area { border: 1px dashed #dcdfe6; border-radius: 6px; padding: 20px; text-align: center; background: #fafafa; cursor: pointer; }
        .image-card-wrapper { position: relative; overflow: hidden; border-radius: 8px; border: 1px solid #ebeef5; cursor: pointer; transition: transform 0.2s; }
        .image-card-wrapper:hover { transform: scale(1.02); }
      </style>

      <el-card style="width:360px; flex-shrink:0">
        <template #header><strong>1. 输入商品信息</strong></template>
        <el-form :model="form" label-position="top" size="small">
          <el-form-item label="素材图 (支持 Ctrl+V 粘贴)">
            <div class="paste-upload-area" @paste="handlePaste" tabindex="0">
              <el-icon size="30"><Upload /></el-icon>
              <div>点击后粘贴图片</div>
            </div>
            <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:8px">
              <div v-for="(u, i) in form.material_images" :key="i" style="position:relative">
                <el-image :src="u" style="width:60px; height:60px; border-radius:4px" fit="cover" />
                <el-icon @click="removeMaterial(i)" style="position:absolute; top:-5px; right:-5px; background:#f56c6c; color:#fff; border-radius:50%; cursor:pointer"><Close /></el-icon>
              </div>
            </div>
          </el-form-item>
          <el-form-item label="中文标题"><el-input v-model="form.title_zh" /></el-form-item>
          <el-form-item label="卖点关键词">
            <el-button type="warning" size="small" :loading="analyzing" @click="analyzeSellingPoints" style="width:100%; margin-bottom:8px">✨ AI 自动分析</el-button>
            <el-input v-model="form.selling_points" type="textarea" :rows="5" />
          </el-form-item>
        </el-form>
      </el-card>

      <el-card style="width:280px; flex-shrink:0">
        <template #header><strong>2. 生成配置</strong></template>
        <el-form :model="form" label-position="top" size="small">
          <el-form-item label="目标市场">
            <el-radio-group v-model="form.target_market">
              <el-radio-button value="ozon">Ozon</el-radio-button>
              <el-radio-button value="etsy">Etsy</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="类型">
            <el-radio-group v-model="form.image_type">
              <el-radio-button value="main">主图</el-radio-button>
              <el-radio-button value="detail">详情图</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="生成张数">
            <el-input-number v-model="form.count" :min="1" :max="form.image_type === 'main' ? 3 : 6" />
          </el-form-item>
          <el-button type="danger" style="width:100%; height:50px" :loading="generating" @click="generateImages">🚀 一键生成套图</el-button>
        </el-form>
      </el-card>

      <el-card style="flex:1">
        <template #header><strong>3. 生成结果</strong></template>
        <div v-if="!resultImages.length && !generating"><el-empty /></div>
        <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:12px">
          <div v-for="(img, i) in resultImages" :key="i" class="image-card-wrapper" @click="showPreview(img.url, i)">
            <div v-if="img.loading" style="height:240px; display:flex; align-items:center; justify-content:center; background:#f5f7fa"><el-icon class="is-loading" size="30"><Loading /></el-icon></div>
            <el-image v-else :src="img.url" style="width:100%; height:240px" fit="cover" />
          </div>
        </div>
      </el-card>

      <el-dialog v-model="previewVisible" title="查看生成结果" width="500px">
        <div style="text-align:center">
          <el-image :src="previewUrl" style="max-width:100%; border-radius:8px" />
          <div style="margin-top:20px">
            <el-button type="success" size="large" @click="downloadImage(previewUrl, previewIndex)">
              <el-icon><Download /></el-icon>&nbsp;下载此图
            </el-button>
          </div>
        </div>
      </el-dialog>
    </div>
  `
};
