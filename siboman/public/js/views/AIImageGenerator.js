// v0.3.5 AI 套图 - 粘贴上传 & 交互优化 & 修复下载
window.AIImageGeneratorView = {
  setup() {
    const getStoreId = () => String(
      window.getCurrentStoreId ? window.getCurrentStoreId() : (localStorage.getItem('currentStoreId') || ''),
    ).split(',').map((value) => value.trim()).find(Boolean) || '';
    const analyzing = Vue.ref(false);
    const generating = Vue.ref(false);
    const uploading = Vue.ref(false);
    const materialInput = Vue.ref(null);
    const publishing = Vue.ref(false);
    const resultImages = Vue.ref([]);
    const history = Vue.ref([]);
    const historyLimit = Vue.ref(20);
    const historyStats = Vue.reactive({ total: 0, total_images: 0, total_cost_usd: 0 });
    const selectedResults = Vue.ref([]);
    const currentRecordId = Vue.ref('');
    
    // 预览弹窗状态
    const previewVisible = Vue.ref(false);
    const previewUrl = Vue.ref('');
    const previewIndex = Vue.ref(0);
    const generationState = Vue.ref('idle');
    const generationProvider = Vue.ref('Agnes 2.0');
    const generationMessage = Vue.ref('默认使用 Agnes 2.0；服务端不可用时会按既定顺序回退。');
    const generationFailure = Vue.ref('');
    const generationAttempts = Vue.ref([]);
    const analyzeFailure = Vue.ref('');

    const form = Vue.reactive({
      title_zh: '',
      title_ru: '',
      material_images: [],
      selling_points: '',
      image_type: 'main',
      target_market: 'ozon',
      model: 'agnes-image-2.0-flash',
      count: 3,
      template_id: 'white-clean',
      aspect_ratio: '1:1',
      custom_prompt: '',
      subject_reference: true,
      offer_id: '',
      publish_mode: 'append',
    });

    const templates = [
      { id: 'white-clean', name: '专业白底', prompt: 'Clean white background, soft studio lighting, accurate product colors, commercial ecommerce photography' },
      { id: 'moscow-street', name: '莫斯科街景', prompt: 'Premium product photography on a Moscow street, natural winter light, realistic commercial style' },
      { id: 'modern-home', name: '现代家居', prompt: 'Product placed in a bright modern home, natural daylight, realistic lifestyle ecommerce photography' },
      { id: 'detail-closeup', name: '细节特写', prompt: 'Macro close-up product photography, emphasize material, texture and craftsmanship, sharp focus' },
      { id: 'kitchen', name: '俄式厨房', prompt: 'Product in a bright contemporary Russian kitchen, warm daylight, realistic everyday use' },
      { id: 'living-room', name: '客厅场景', prompt: 'Product in a refined modern living room, natural scale, soft daylight, realistic lifestyle photo' },
      { id: 'bedroom', name: '卧室场景', prompt: 'Product in a clean cozy bedroom, soft morning light, calm neutral styling' },
      { id: 'bathroom', name: '卫浴场景', prompt: 'Product in a clean premium bathroom, realistic moisture resistant surfaces, bright soft light' },
      { id: 'office', name: '办公桌面', prompt: 'Product on a tidy professional desk, practical work context, realistic soft window light' },
      { id: 'outdoor', name: '户外使用', prompt: 'Product used outdoors in a believable natural setting, realistic scale and weather, crisp detail' },
      { id: 'winter', name: '俄罗斯冬季', prompt: 'Product in an authentic Russian winter setting, clean snow, realistic cold daylight' },
      { id: 'summer', name: '夏日清新', prompt: 'Product in a bright summer setting, fresh natural light, clean commercial lifestyle photo' },
      { id: 'premium-dark', name: '高端深色棚拍', prompt: 'Premium dark studio product photography, controlled rim light, accurate materials, luxury composition' },
      { id: 'pastel', name: '柔和马卡龙', prompt: 'Product on a soft pastel studio background, clean balanced composition, accurate product colors' },
      { id: 'wood-table', name: '原木桌面', prompt: 'Product on a natural wood table, warm daylight, realistic home atmosphere, accurate texture' },
      { id: 'marble', name: '大理石质感', prompt: 'Product on clean marble, elegant soft studio light, premium ecommerce styling' },
      { id: 'size-guide', name: '尺寸展示底图', prompt: 'Product centered with generous clean space for later size annotations, orthographic ecommerce view' },
      { id: 'feature-layout', name: '卖点展示底图', prompt: 'Product centered with clean negative space around it for later feature callouts, no generated text' },
      { id: 'package', name: '包装组合', prompt: 'Product and its retail package arranged neatly, all included parts visible, accurate quantity and scale' },
      { id: 'multi-angle', name: '多角度展示', prompt: 'Commercial product photography showing a clear alternate angle, preserve exact design and proportions' },
      { id: 'hand-scale', name: '手持比例', prompt: 'Product naturally held in a human hand to demonstrate scale, realistic anatomy and product proportions' },
      { id: 'family', name: '家庭使用', prompt: 'Product in a believable family home context, natural interaction, warm realistic daylight' },
      { id: 'travel', name: '旅行场景', prompt: 'Product in a practical travel context, luggage and destination setting, realistic scale and use' },
      { id: 'gift', name: '礼物氛围', prompt: 'Product presented as a tasteful gift, subtle ribbon and clean festive setting, product fully visible' },
    ];

    const estimatedCost = Vue.computed(() => (Number(form.count || 0) * 0.03).toFixed(2));
    const providerLabel = (model) => {
      const value = String(model || '').toLowerCase();
      if (value.includes('agnes')) return 'Agnes 2.0';
      if (value.includes('tokendun') || value.includes('gpt-image')) return 'TokenDun';
      if (value.includes('wan')) return '万相';
      if (value.includes('minimax')) return 'MiniMax';
      return model || '未知 provider';
    };
    const generationDescription = Vue.computed(() => {
      const attempts = generationAttempts.value
        .map((item) => {
          const status = item.status === 'success' ? '成功' : item.status === 'skipped' ? '跳过' : '失败';
          return `${item.provider || providerLabel(item.model)} ${status}${item.reason ? `：${item.reason}` : ''}`;
        })
        .join('；');
      const reason = generationFailure.value ? `${generationMessage.value} 原因：${generationFailure.value}` : generationMessage.value;
      return attempts ? `${reason} 执行链路：${attempts}` : reason;
    });
    const finalPrompt = Vue.computed(() => {
      const preset = templates.find((item) => item.id === form.template_id)?.prompt || '';
      const subject = form.title_ru || form.title_zh || 'the reference product';
      const points = String(form.selling_points || '').split('\n').filter(Boolean).join(', ');
      return `${preset}. Subject: ${subject}. ${points ? `Selling points: ${points}.` : ''} ${form.custom_prompt || ''} Keep the product shape, color, material and logo consistent with the reference image. No watermark, no distorted text.`.trim();
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

    const handleMaterialFiles = async (event) => {
      const files = [...(event.target.files || [])].slice(0, Math.max(0, 8 - form.material_images.length));
      event.target.value = '';
      for (const file of files) await uploadFile(file);
    };

    const cropMaterial = async (index) => {
      const source = form.material_images[index];
      if (!source) return;
      uploading.value = true;
      try {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = source; });
        const side = Math.min(image.naturalWidth, image.naturalHeight);
        const canvas = document.createElement('canvas');
        canvas.width = 1200; canvas.height = 1200;
        const context = canvas.getContext('2d');
        context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 1200, 1200);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
        if (!blob) throw new Error('裁剪失败');
        const file = new File([blob], `crop-${Date.now()}.jpg`, { type: 'image/jpeg' });
        const fd = new FormData(); fd.append('file', file);
        const response = await axios.post('/api/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        form.material_images[index] = response.data.url;
        notify.success('已居中裁剪为 1:1');
      } catch (e) { notify.error('裁剪失败：' + (e.response?.data?.error || e.message)); }
      finally { uploading.value = false; }
    };

    const removeMaterial = (i) => form.material_images.splice(i, 1);

    const analyzeSellingPoints = async () => {
      analyzing.value = true;
      analyzeFailure.value = '';
      try {
        const r = await axios.post('/api/ai/analyze', {
          store_id: getStoreId(),
          title: form.title_zh,
          images: form.material_images,
          target_market: form.target_market,
        });
        const d = r.data?.data || {};
        form.selling_points = (Array.isArray(d.selling_points) ? d.selling_points : []).join('\n');
        if (d.title_ru) form.title_ru = d.title_ru;
        notify.success('AI 分析完成');
      } catch (e) {
        analyzeFailure.value = e.response?.data?.error || e.message || '未知错误';
        notify.error('分析失败：' + analyzeFailure.value);
      }
      finally { analyzing.value = false; }
    };

    const generateImages = async () => {
      if (!form.material_images.length) return notify.warning('请上传素材');
      generating.value = true;
      generationState.value = 'running';
      generationProvider.value = 'Agnes 2.0';
      generationFailure.value = '';
      generationAttempts.value = [];
      generationMessage.value = '正在生成。可继续填写或调整其他表单内容，结果会在此处更新。';
      resultImages.value = Array(form.count).fill({ loading: true });
      try {
        const r = await axios.post('/api/seller/images/generate', {
          store_id: getStoreId(),
          prompt: finalPrompt.value,
          image: form.subject_reference ? form.material_images : [],
          aspectRatio: form.aspect_ratio,
          n: form.count,
          scenePreset: form.template_id,
        }, { timeout: 120000 });
        const urls = (r.data?.data?.images || []).filter(Boolean);
        resultImages.value = urls.map(u => ({ url: typeof u === 'string' ? u : u.url, loading: false }));
        selectedResults.value = urls.map((_u, index) => index);
        currentRecordId.value = r.data?.data?.recordId || '';
        generationState.value = 'completed';
        generationProvider.value = providerLabel(r.data?.usage?.model);
        generationMessage.value = generationProvider.value === 'Agnes 2.0'
          ? '已由 Agnes 2.0 完成生成。'
          : `Agnes 2.0 未完成本次请求，已自动回退至 ${generationProvider.value}。`;
        generationAttempts.value = Array.isArray(r.data?.usage?.providerAttempts) ? r.data.usage.providerAttempts : [];
        notify.success(`已生成 ${urls.length} 张，预估费用 $${r.data?.usage?.estimatedCostUsd ?? estimatedCost.value}`);
        await fetchHistory();
      } catch (e) {
        resultImages.value = [];
        generationState.value = 'failed';
        generationFailure.value = e.response?.data?.error || e.message || '未知错误';
        generationAttempts.value = Array.isArray(e.response?.data?.usage?.providerAttempts) ? e.response.data.usage.providerAttempts : [];
        generationMessage.value = '所有可用 provider 均未返回图片。';
        notify.error('生成失败：' + generationFailure.value);
      } finally { generating.value = false; }
    };

    const fetchHistory = async () => {
      try {
        const r = await axios.get('/api/ai-images/history', { params: { store_id: getStoreId(), limit: historyLimit.value } });
        history.value = r.data.items || [];
        Object.assign(historyStats, r.data.stats || {});
      } catch (e) { notify.error('历史记录加载失败：' + (e.response?.data?.error || e.message)); }
    };

    const toggleResult = (index) => {
      const next = new Set(selectedResults.value);
      if (next.has(index)) next.delete(index); else next.add(index);
      selectedResults.value = [...next];
    };

    const batchDownload = async () => {
      const indexes = [...selectedResults.value].sort((a, b) => a - b);
      if (!indexes.length) return notify.warning('请先选择图片');
      for (const index of indexes) await downloadImage(resultImages.value[index]?.url, index);
    };

    const publishToOzon = async () => {
      const indexes = [...selectedResults.value].sort((a, b) => a - b);
      const images = indexes.map((index) => resultImages.value[index]?.url).filter(Boolean);
      if (!form.offer_id.trim()) return notify.warning('请填写当前店铺中的商品货号');
      if (!images.length) return notify.warning('请先选择要推送的图片');
      try {
        await window.ElementPlus.ElMessageBox.confirm(
          `确定将 ${images.length} 张图片${form.publish_mode === 'replace' ? '替换为' : '追加到'}货号 ${form.offer_id.trim()} 的 Ozon 图册？`,
          '推送图片至 Ozon',
          { confirmButtonText: '确认推送', cancelButtonText: '取消', type: 'warning' },
        );
      } catch { return; }
      publishing.value = true;
      try {
        const response = await axios.post('/api/seller/images/publish-to-ozon', {
          store_id: getStoreId(),
          offer_id: form.offer_id.trim(),
          images,
          mode: form.publish_mode,
          record_id: currentRecordId.value,
        }, { timeout: 120000 });
        notify.success(`已向 Ozon 提交图册，共 ${response.data?.count || images.length} 张`);
        await fetchHistory();
      } catch (e) {
        notify.error('推送失败：' + (e.response?.data?.error || e.message));
      } finally { publishing.value = false; }
    };

    const deleteHistory = async (id) => {
      try {
        await window.ElementPlus.ElMessageBox.confirm(
          '确定删除这条 AI 套图历史？已推送到 Ozon 的图片不会被删除。',
          '删除生成历史',
          { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' },
        );
      } catch { return; }
      try {
        await axios.delete(`/api/ai-images/${id}`);
        notify.success('历史记录已删除');
        fetchHistory();
      } catch (e) { notify.error('删除失败：' + (e.response?.data?.error || e.message)); }
    };

    const loadHistoryResult = (row) => {
      const urls = Array.isArray(row.image_urls) ? row.image_urls.filter(Boolean) : [];
      resultImages.value = urls.map((url) => ({ url, loading: false }));
      selectedResults.value = urls.map((_url, index) => index);
      currentRecordId.value = row.id;
      form.offer_id = row.offer_id || form.offer_id;
      notify.success(`已载入 ${urls.length} 张历史图片`);
    };

    const loadMoreHistory = async () => {
      historyLimit.value = Math.min(200, historyLimit.value + 20);
      await fetchHistory();
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
      form.offer_id = '';
      selectedResults.value = [];
      currentRecordId.value = '';
      fetchHistory();
    };
    window.addEventListener('shop-changed', onShopChanged);
    Vue.onBeforeUnmount(() => window.removeEventListener('shop-changed', onShopChanged));
    Vue.onMounted(fetchHistory);

    return {
      form, analyzing, generating, uploading, publishing, materialInput, resultImages, templates, finalPrompt, estimatedCost,
      history, historyStats, historyLimit, selectedResults, currentRecordId,
      generationState, generationProvider, generationMessage, generationFailure, generationAttempts, generationDescription, providerLabel, analyzeFailure,
      previewVisible, previewUrl, previewIndex,
      handlePaste, handleMaterialFiles, cropMaterial, removeMaterial, analyzeSellingPoints, generateImages, showPreview, downloadImage,
      fetchHistory, toggleResult, batchDownload, publishToOzon, deleteHistory, loadHistoryResult, loadMoreHistory,
    };
  },
  template: `
    <div class="ai-image-gen-v035" style="display:flex; gap:16px; min-height:calc(100vh - 130px)">
      <el-card style="width:360px; flex-shrink:0">
        <template #header><strong>1. 输入商品信息</strong></template>
        <el-form :model="form" label-position="top" size="small">
          <el-form-item label="素材图 (支持 Ctrl+V 粘贴)">
            <div class="paste-upload-area" @paste="handlePaste" tabindex="0">
              <el-icon size="30"><Upload /></el-icon>
              <div>点击后粘贴图片，或从电脑选择</div>
              <el-button size="small" style="margin-top:8px" :loading="uploading" @click.stop="materialInput?.click()">选择图片</el-button>
              <input ref="materialInput" type="file" accept="image/*" multiple style="display:none" @change="handleMaterialFiles" />
            </div>
            <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:8px">
              <div v-for="(u, i) in form.material_images" :key="i" style="position:relative">
                <el-image :src="u" style="width:60px; height:60px; border-radius:4px" fit="cover" />
                <el-button link size="small" title="居中裁剪为 1:1" @click="cropMaterial(i)" style="position:absolute;bottom:-3px;left:2px;background:#fff;padding:1px 3px">裁剪</el-button>
                <el-icon @click="removeMaterial(i)" style="position:absolute; top:-5px; right:-5px; background:#f56c6c; color:#fff; border-radius:50%; cursor:pointer"><Close /></el-icon>
              </div>
            </div>
          </el-form-item>
          <el-form-item label="中文标题"><el-input v-model="form.title_zh" /></el-form-item>
          <el-form-item label="Ozon 商品货号">
            <el-input v-model="form.offer_id" clearable placeholder="推送图片时必填" />
          </el-form-item>
          <el-form-item label="推送方式">
            <el-segmented v-model="form.publish_mode" :options="[{label:'追加到原图册',value:'append'},{label:'替换原图册',value:'replace'}]" />
          </el-form-item>
          <el-form-item label="卖点关键词">
            <el-button type="warning" size="small" :loading="analyzing" @click="analyzeSellingPoints" style="width:100%; margin-bottom:8px">✨ AI 自动分析</el-button>
            <el-alert v-if="analyzeFailure" type="error" :closable="false" show-icon style="margin-bottom:8px" title="AI 分析失败" :description="analyzeFailure" />
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
          <div style="margin:-4px 0 12px; font-size:12px; color:#606266; line-height:1.5">目标市场会传给 AI 分析，用于俄语/Ozon 或 Etsy 场景卖点判断。</div>
          <div style="margin:-2px 0 12px; padding:9px 10px; background:#f0f9ff; border:1px solid #bae6fd; border-radius:6px; font-size:12px; color:#075985">
            默认 provider：<strong>Agnes 2.0</strong><br />
            回退顺序：TokenDun → 万相 → MiniMax
          </div>
          <el-form-item label="场景模板">
            <el-select v-model="form.template_id" style="width:100%">
              <el-option v-for="item in templates" :key="item.id" :label="item.name" :value="item.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="图片比例">
            <el-segmented v-model="form.aspect_ratio" :options="['1:1', '3:4', '9:16']" />
          </el-form-item>
          <el-form-item label="自定义要求">
            <el-input v-model="form.custom_prompt" type="textarea" :rows="3" placeholder="可补充背景、光线、构图要求" />
          </el-form-item>
          <el-form-item>
            <el-checkbox v-model="form.subject_reference">保持商品主体一致</el-checkbox>
          </el-form-item>
          <el-form-item label="生成张数">
            <el-input-number v-model="form.count" :min="1" :max="8" />
          </el-form-item>
          <div style="font-size:12px; color:#909399; margin-bottom:10px">预估费用 USD {{ estimatedCost }}</div>
          <el-button type="primary" style="width:100%; height:44px" :loading="generating" @click="generateImages">生成套图</el-button>
        </el-form>
      </el-card>

      <el-card style="flex:1">
        <template #header>
          <div style="display:flex; justify-content:space-between; align-items:center">
            <strong>3. 生成结果</strong>
            <div style="display:flex; gap:8px">
              <el-button size="small" :disabled="!selectedResults.length" @click="batchDownload">批量下载 ({{ selectedResults.length }})</el-button>
              <el-button size="small" type="success" :loading="publishing" :disabled="!selectedResults.length || !form.offer_id.trim()" @click="publishToOzon">推送到 Ozon</el-button>
            </div>
          </div>
        </template>
        <el-alert
          :type="generationState === 'failed' ? 'error' : generationState === 'completed' ? 'success' : 'info'"
          :closable="false"
          style="margin-bottom:12px"
          :title="'执行通道：' + generationProvider"
          :description="generationDescription" />
        <div v-if="!resultImages.length && !generating"><el-empty description="暂无生成结果。上传素材并点击生成套图后，图片会显示在这里。" /></div>
        <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:12px">
          <div v-for="(img, i) in resultImages" :key="i" class="image-card-wrapper">
            <div v-if="img.loading" style="height:240px; display:flex; align-items:center; justify-content:center; background:#f5f7fa"><el-icon class="is-loading" size="30"><Loading /></el-icon></div>
            <el-image v-else :src="img.url" style="width:100%; height:240px" fit="cover" @click="showPreview(img.url, i)" />
            <el-checkbox :model-value="selectedResults.includes(i)" @change="toggleResult(i)" style="position:absolute; top:8px; left:8px; background:#fff; padding:2px 6px; border-radius:4px" />
          </div>
        </div>

        <el-divider>生成历史</el-divider>
        <div style="display:flex; gap:16px; color:#606266; font-size:12px; margin-bottom:10px">
          <span>{{ historyStats.total || 0 }} 次任务</span><span>{{ historyStats.total_images || 0 }} 张图片</span><span>累计 USD {{ Number(historyStats.total_cost_usd || 0).toFixed(2) }}</span>
        </div>
        <el-table :data="history" size="small" max-height="280">
          <template #empty>
            <el-empty description="暂无生成历史。生成成功后会记录 provider、费用和是否推送到 Ozon。" :image-size="80" />
          </template>
          <el-table-column label="图片" width="120">
            <template #default="{ row }"><el-image :src="row.image_urls?.[0]" style="width:52px; height:52px" fit="cover" preview-teleported :preview-src-list="row.image_urls || []" /></template>
          </el-table-column>
          <el-table-column label="模板 / Prompt" min-width="220" show-overflow-tooltip>
            <template #default="{ row }"><div>{{ row.scene_preset || '-' }}</div><small style="color:#909399">{{ row.prompt }}</small></template>
          </el-table-column>
          <el-table-column label="Provider" width="120"><template #default="{ row }">{{ providerLabel(row.model) }}</template></el-table-column>
          <el-table-column label="张数" prop="n" width="65" />
          <el-table-column label="费用" width="90"><template #default="{ row }">USD {{ Number(row.estimated_cost_usd || 0).toFixed(2) }}</template></el-table-column>
          <el-table-column label="Ozon 推送" width="120"><template #default="{ row }"><el-tag size="small" :type="row.ozon_sync_status ? 'success' : 'info'">{{ row.ozon_sync_status ? ('已推送 ' + (row.offer_id || '')) : '未推送' }}</el-tag></template></el-table-column>
          <el-table-column label="时间" width="155"><template #default="{ row }">{{ String(row.created_at || '').slice(0, 19).replace('T', ' ') }}</template></el-table-column>
          <el-table-column label="操作" width="120"><template #default="{ row }"><el-button link type="primary" @click="loadHistoryResult(row)">载入</el-button><el-button link type="danger" @click="deleteHistory(row.id)">删除</el-button></template></el-table-column>
        </el-table>
        <div v-if="history.length < Number(historyStats.total || 0)" style="text-align:center;margin-top:10px"><el-button size="small" @click="loadMoreHistory">加载更多</el-button></div>
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
