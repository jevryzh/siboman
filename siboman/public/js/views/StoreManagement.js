// v0.7.5 Cache Buster
window.StoreManagementView = {
  setup() {
    const shops = Vue.ref([]);
    const loading = Vue.ref(false);
    const dialogVisible = Vue.ref(false);
    const submitLoading = Vue.ref(false);
    const form = Vue.reactive({
      name: '',
      client_id: '',
      api_key: '',
      platform: 'ozon',
      campaign_id: ''
    });
    // Yandex 多店铺：列表平台筛选 + 新增弹窗平台 + campaign 探测
    const listPlatform = Vue.ref('all'); // all|ozon|yandex
    const dialogPlatform = Vue.ref('ozon'); // 新增弹窗当前平台
    const yandexCampaigns = Vue.ref([]);
    const probingCampaigns = Vue.ref(false);
    const filteredShops = Vue.computed(() => {
      if (listPlatform.value === 'all') return shops.value;
      return shops.value.filter((s) => (s.platform || 'ozon') === listPlatform.value);
    });
    const probeYandexCampaigns = async () => {
      const secret = String(form.api_key || '').trim();
      if (!secret) return ElementPlus.ElMessage.warning('请先填写 Yandex API Key');
      probingCampaigns.value = true;
      try {
        const res = await axios.post('/api/yandex/campaigns-probe', { api_key: secret });
        yandexCampaigns.value = res.data.campaigns || [];
        if (yandexCampaigns.value.length === 1) {
          form.campaign_id = yandexCampaigns.value[0].id;
          form.client_id = yandexCampaigns.value[0].businessId;
          if (!form.name) form.name = yandexCampaigns.value[0].name;
          ElementPlus.ElMessage.success('已识别店铺：' + yandexCampaigns.value[0].name);
        } else if (yandexCampaigns.value.length > 1) {
          ElementPlus.ElMessage.success('该账号下有 ' + yandexCampaigns.value.length + ' 个店铺，请选择要授权的 campaign');
        } else {
          ElementPlus.ElMessage.warning('该账号下没有可用店铺(campaign)');
        }
      } catch (e) {
        ElementPlus.ElMessage.error('探测失败: ' + (e.response?.data?.error || e.message));
      } finally {
        probingCampaigns.value = false;
      }
    };
    const PLUGIN_MANIFEST_VERSION = "2.2.9.113";
    const PLUGIN_ZIP_VERSION = "2.2.9.113";
    const pluginDetected = Vue.ref(false);
    const pluginChecking = Vue.ref(false);
    const installedPluginVersion = Vue.ref('');
    const pluginStatusText = Vue.ref('尚未检测到已安装插件，请点击刷新状态。');
    const PROTO = "__zhumeng_proto";
    const PROTO_VAL = "zhumeng-v1";
    window.__zhumeng_pending__ = window.__zhumeng_pending__ || {};

    const compareVersion = (a, b) => {
      const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
      const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const da = pa[i] || 0;
        const db = pb[i] || 0;
        if (da !== db) return da > db ? 1 : -1;
      }
      return 0;
    };
    const needsPluginRefresh = Vue.computed(() => !installedPluginVersion.value || compareVersion(installedPluginVersion.value, PLUGIN_MANIFEST_VERSION) < 0);
    const sendToExtension = (kind, extra = {}, timeoutMs = 5000) => new Promise((resolve) => {
      const reqId = `store-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      let resolved = false;
      window.__zhumeng_pending__[reqId] = (data) => {
        if (resolved) return;
        resolved = true;
        delete window.__zhumeng_pending__[reqId];
        resolve(data);
      };
      try {
        window.postMessage(JSON.parse(JSON.stringify({ [PROTO]: PROTO_VAL, reqId, kind, ...extra })), '*');
      } catch (error) {
        resolved = true;
        delete window.__zhumeng_pending__[reqId];
        resolve({ ok: false, error: error.message });
        return;
      }
      setTimeout(() => {
        if (resolved) return;
        resolved = true;
        delete window.__zhumeng_pending__[reqId];
        resolve(null);
      }, timeoutMs);
    });
    const handleExtensionMessage = (event) => {
      const d = event.data;
      if (!d || typeof d !== 'object' || d[PROTO] !== PROTO_VAL) return;
      if (typeof d.kind === 'string' && d.kind.endsWith('.request')) return;
      const resolver = window.__zhumeng_pending__[d.reqId];
      if (resolver) {
        delete window.__zhumeng_pending__[d.reqId];
        resolver(d);
      }
    };
    window.addEventListener('message', handleExtensionMessage);

    const refreshPluginStatus = async () => {
      pluginChecking.value = true;
      const ping = await sendToExtension('ping.request');
      pluginDetected.value = Boolean(ping?.ok);
      installedPluginVersion.value = String(ping?.background_version || ping?.version || '');
      if (!pluginDetected.value) {
        pluginStatusText.value = '未检测到 ERP 页面桥接，请确认已安装并在 chrome://extensions 重新加载插件。';
      } else if (needsPluginRefresh.value) {
        pluginStatusText.value = `当前插件 v${installedPluginVersion.value || '未知'} 低于发布包 v${PLUGIN_MANIFEST_VERSION}，需要重新下载或在扩展程序页点重新加载。`;
      } else {
        pluginStatusText.value = `当前插件 v${installedPluginVersion.value} 已与发布包一致。`;
      }
      pluginChecking.value = false;
    };

    const fetchShops = async () => {
      loading.value = true;
      try {
        const res = await axios.get('/api/seller/shops');
        shops.value = res.data.shops || [];
      } catch (e) {
        console.error('获取店铺列表失败', e);
        ElementPlus.ElMessage.error('获取店铺列表失败: ' + (e.response?.data?.error || e.message));
      } finally {
        loading.value = false;
      }
    };

    const handleAdd = () => {
      form.name = '';
      form.client_id = '';
      form.api_key = '';
      form.campaign_id = '';
      dialogPlatform.value = listPlatform.value === 'yandex' ? 'yandex' : 'ozon';
      form.platform = dialogPlatform.value;
      yandexCampaigns.value = [];
      dialogVisible.value = true;
    };

    const switchDialogPlatform = (platform) => {
      dialogPlatform.value = platform;
      form.platform = platform;
      form.client_id = '';
      form.campaign_id = '';
      yandexCampaigns.value = [];
    };

    const submitForm = async () => {
      if (dialogPlatform.value === 'yandex') {
        if (!form.name || !form.api_key) return ElementPlus.ElMessage.warning('请填写店铺名称与 Yandex API Key');
      } else if (!form.name || !form.client_id || !form.api_key) {
        return ElementPlus.ElMessage.warning('请填写完整信息');
      }
      submitLoading.value = true;
      try {
        const payload = { ...form, platform: dialogPlatform.value };
        await axios.post('/api/seller/shops', payload);
        ElementPlus.ElMessage.success('授权成功');
        dialogVisible.value = false;
        fetchShops();
        window.dispatchEvent(new CustomEvent('shop-updated'));
      } catch (e) {
        const errorMsg = e.response?.data?.error || e.message || '未知错误';
        ElementPlus.ElMessage.error({ message: '授权失败: ' + errorMsg, duration: 5000, showClose: true });
      } finally {
        submitLoading.value = false;
      }
    };

    const handleDelete = async (row) => {
      try {
        await ElementPlus.ElMessageBox.confirm(
          `确定移除店铺 "${row.name}" 吗？这只会移除 ERP 内的授权配置，不会删除 Ozon 后台店铺。`,
          '移除店铺授权',
          { type: 'warning', confirmButtonText: '确认移除', cancelButtonText: '取消' },
        );
        await axios.delete(`/api/seller/shops/${row.id}`);
        ElementPlus.ElMessage.success('已移除');
        fetchShops();
        window.dispatchEvent(new CustomEvent('shop-updated'));
      } catch (e) {
        if (e === 'cancel' || e === 'close') return;
        ElementPlus.ElMessage.error('移除失败: ' + (e.response?.data?.error || e.message));
      }
    };

    const saveShopSettings = async (row) => {
      try {
        await axios.patch(`/api/seller/shops/${row.id}/settings`, {
          watermark_enabled: row.watermark_enabled === true,
          watermark_text: row.watermark_text || row.name || '逐梦ERP'
        });
        ElementPlus.ElMessage.success('店铺设置已保存');
        fetchShops();
        window.dispatchEvent(new CustomEvent('shop-updated'));
      } catch (e) {
        ElementPlus.ElMessage.error('保存失败: ' + (e.response?.data?.error || e.message));
      }
    };

    const downloadExtension = () => {
      const link = document.createElement('a');
      link.href = `/extension/zhumeng-collector.zip?v=${PLUGIN_ZIP_VERSION}`;
      link.download = 'zhumeng-collector.zip';
      link.click();
    };

    // AI 文本模型设置（Yandex AI 优化等功能共用）
    const llm = Vue.reactive({ provider: '', baseUrl: '', model: '', apiKey: '', configured: false, apiKeyLast4: '' });
    const llmSaving = Vue.ref(false);
    const llmTesting = Vue.ref(false);
    const LLM_PRESETS = {
      dashscope: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
      minimax: { baseUrl: 'https://api.minimaxi.com/v1', model: 'MiniMax-M3' },
      custom: { baseUrl: '', model: '' },
    };
    const fetchLlmSettings = async () => {
      try {
        const res = await axios.get('/api/settings/llm');
        Object.assign(llm, res.data || {});
      } catch (_e) { /* 未配置时静默 */ }
    };
    const switchLlmProvider = (provider) => {
      llm.provider = provider;
      const preset = LLM_PRESETS[provider] || LLM_PRESETS.custom;
      if (provider !== 'custom') { llm.baseUrl = preset.baseUrl; llm.model = preset.model; }
    };
    const saveLlmSettings = async () => {
      const key = String(llm.apiKey || '').trim();
      if (!llm.provider) return ElementPlus.ElMessage.warning('请选择 AI 服务商');
      if (!key) return ElementPlus.ElMessage.warning('请填写 API Key');
      llmSaving.value = true;
      try {
        await axios.post('/api/settings/llm', { provider: llm.provider, apiKey: key, baseUrl: llm.baseUrl, model: llm.model });
        ElementPlus.ElMessage.success('AI 设置已保存');
        await fetchLlmSettings();
      } catch (e) {
        ElementPlus.ElMessage.error('保存失败: ' + (e.response?.data?.error || e.message));
      } finally {
        llmSaving.value = false;
      }
    };
    const testLlm = async () => {
      llmTesting.value = true;
      try {
        const res = await axios.post('/api/settings/llm/test', {});
        ElementPlus.ElMessage.success('连接正常：' + String(res.data?.replied || 'OK').slice(0, 60));
      } catch (e) {
        ElementPlus.ElMessage.error('测试失败: ' + (e.response?.data?.error || e.message));
      } finally {
        llmTesting.value = false;
      }
    };

    const maskClientId = (id) => {
      if (!id) return '';
      return id.length > 8 ? id.slice(0, 4) + '****' + id.slice(-4) : id;
    };
    const displayClientId = (row) => {
      if (!row) return '';
      if (row.client_id_masked) return row.client_id_masked;
      if (row.client_id_last4) return `****${row.client_id_last4}`;
      return maskClientId(row.client_id);
    };

    Vue.onMounted(() => { fetchShops(); refreshPluginStatus(); fetchLlmSettings(); });
    const onShopChanged = () => fetchShops();
    window.addEventListener('shop-changed', onShopChanged);
    Vue.onBeforeUnmount(() => {
      window.removeEventListener('shop-changed', onShopChanged);
      window.removeEventListener('message', handleExtensionMessage);
    });

    return {
      shops, filteredShops, listPlatform, dialogPlatform, yandexCampaigns, probingCampaigns,
      loading, dialogVisible, submitLoading, form,
      PLUGIN_MANIFEST_VERSION, PLUGIN_ZIP_VERSION, pluginDetected, pluginChecking, installedPluginVersion, pluginStatusText, needsPluginRefresh,
      fetchShops, handleAdd, switchDialogPlatform, probeYandexCampaigns, submitForm, handleDelete, saveShopSettings, maskClientId, displayClientId, downloadExtension, refreshPluginStatus,
      llm, llmSaving, llmTesting, switchLlmProvider, saveLlmSettings, testLlm,
    };
  },
  template: `
    <div class="store-management-container" style="background:#f8fafc; min-height:100%; padding:22px 30px 28px; box-sizing:border-box">
      <div style="max-width:1500px; margin:0 auto">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px; margin-bottom:18px">
          <div>
            <div style="font-size:28px; line-height:1.2; font-weight:900; color:#111827">店铺授权</div>
            <div style="margin-top:14px; font-size:14px; color:#64748b; font-weight:700">
              <el-radio-group v-model="listPlatform" size="small" style="margin-right:12px">
                <el-radio-button value="all">全部</el-radio-button>
                <el-radio-button value="ozon">Ozon</el-radio-button>
                <el-radio-button value="yandex">Yandex Market</el-radio-button>
              </el-radio-group>
              <span>共 {{ filteredShops.length }} 个店铺</span>
            </div>
          </div>
          <div style="display:flex; gap:10px; justify-content:flex-end; flex-wrap:wrap">
            <el-button size="large" @click="fetchShops">
              <el-icon><Refresh /></el-icon><span>刷新</span>
            </el-button>
            <el-button size="large" type="primary" style="background:#111827; border-color:#111827" @click="handleAdd">
              <el-icon><Plus /></el-icon><span>新增授权</span>
            </el-button>
          </div>
        </div>

        <el-table :data="filteredShops" v-loading="loading" element-loading-text="正在读取店铺" stripe border size="large" style="border-radius:8px; overflow:hidden; box-shadow:0 8px 24px rgba(15,23,42,.04); margin-bottom:20px" empty-text="暂无店铺授权。新增授权后才能同步商品、库存、订单和采集任务。">
          <el-table-column label="平台" width="110">
            <template #default="{ row }">
              <el-tag :type="(row.platform || 'ozon') === 'yandex' ? 'warning' : 'success'" effect="light">{{ (row.platform || 'ozon') === 'yandex' ? 'Yandex' : 'Ozon' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="店铺名称" prop="name" min-width="180">
            <template #default="{ row }">
              <div style="font-size:15px; font-weight:800; color:#1f2937">{{ row.name }}</div>
            </template>
          </el-table-column>
          <el-table-column label="Client / Business ID">
            <template #default="{ row }">
              <code>{{ displayClientId(row) }}</code>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="120">
            <template #default="{ row }">
              <el-tag :type="row.active ? 'success' : 'info'">{{ row.active ? '已激活' : '禁用' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="店铺水印" min-width="280">
            <template #default="{ row }">
              <div style="display:flex; align-items:center; gap:8px">
                <el-switch v-model="row.watermark_enabled" @change="saveShopSettings(row)" />
                <el-input
                  v-model="row.watermark_text"
                  size="small"
                  maxlength="80"
                  placeholder="水印文字"
                  :disabled="!row.watermark_enabled"
                  @change="saveShopSettings(row)"
                  style="max-width:180px" />
              </div>
              <div style="font-size:11px; color:#909399; margin-top:4px">
                {{ row.watermark_enabled ? '批量上架开启水印增强时会使用此文字' : '未开启店铺水印，批量上架不会自动加店铺文字水印' }}
              </div>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="120" fixed="right" align="center">
            <template #default="{ row }">
              <el-button link type="danger" @click="handleDelete(row)">移除</el-button>
            </template>
          </el-table-column>
        </el-table>

      <!-- AI 文本模型设置 -->
      <el-card style="background-color:#fff; border:1px solid #dfe7f1; border-radius:8px; box-shadow:none; overflow:hidden; margin-bottom:18px">
        <template #header>
          <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap">
            <div style="font-weight: bold; color: #16a34a">AI 设置（文本模型）</div>
            <el-tag :type="llm.configured ? 'success' : 'info'" size="small">{{ llm.configured ? '已配置 · ' + llm.provider + (llm.apiKeyLast4 ? ' · key ****' + llm.apiKeyLast4 : '') : '未配置' }}</el-tag>
          </div>
        </template>
        <div style="display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:12px; align-items:end">
          <div>
            <div style="font-size:12px; color:#909399; margin-bottom:6px">服务商</div>
            <el-select v-model="llm.provider" style="width:100%" @change="switchLlmProvider" placeholder="选择服务商">
              <el-option label="通义 DashScope（qwen-plus）" value="dashscope" />
              <el-option label="MiniMax（MiniMax-M3）" value="minimax" />
              <el-option label="自定义（OpenAI 兼容）" value="custom" />
            </el-select>
          </div>
          <div>
            <div style="font-size:12px; color:#909399; margin-bottom:6px">API Key</div>
            <el-input v-model="llm.apiKey" type="password" show-password placeholder="sk-..." />
          </div>
          <div>
            <div style="font-size:12px; color:#909399; margin-bottom:6px">Base URL</div>
            <el-input v-model="llm.baseUrl" placeholder="自动填充；custom 需手动" :disabled="llm.provider !== 'custom'" />
          </div>
          <div>
            <div style="font-size:12px; color:#909399; margin-bottom:6px">模型名</div>
            <el-input v-model="llm.model" placeholder="自动填充；custom 需手动" :disabled="llm.provider !== 'custom'" />
          </div>
        </div>
        <div style="display:flex; gap:10px; margin-top:14px; align-items:center; flex-wrap:wrap">
          <el-button type="success" :loading="llmSaving" @click="saveLlmSettings">保存 AI 设置</el-button>
          <el-button :loading="llmTesting" :disabled="!llm.configured" @click="testLlm">测试连接</el-button>
          <span style="font-size:12px; color:#94a3b8">用于 Yandex 商品「AI 优化」（生成俄语标题/描述）。获取：DashScope console.aliyun.com 或 platform.minimaxi.com。</span>
        </div>
      </el-card>

      <!-- 插件下载引导 -->
      <el-card style="background-color:#fff; border:1px solid #dfe7f1; border-radius:8px; box-shadow:none; overflow:hidden">
        <template #header>
          <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap">
            <div style="font-weight: bold; color: #e6a23c">逐梦 Ozon 采集器</div>
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap">
              <el-button type="warning" size="small" icon="Download" @click="downloadExtension">
                立即下载插件
              </el-button>
              <el-button size="small" :loading="pluginChecking" @click="refreshPluginStatus" icon="Refresh">刷新插件状态</el-button>
            </div>
          </div>
        </template>
        <div style="font-size: 14px; color: #666; line-height: 1.6">
          <div style="display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:10px; margin-bottom:12px">
            <div style="background:#fff; border:1px solid #faecd8; border-radius:6px; padding:10px">
              <div style="font-size:12px; color:#909399">当前插件</div>
              <div style="margin-top:4px"><el-tag size="small" :type="pluginDetected && !needsPluginRefresh ? 'success' : 'warning'">v{{ installedPluginVersion || '未检测到' }}</el-tag></div>
            </div>
            <div style="background:#fff; border:1px solid #faecd8; border-radius:6px; padding:10px">
              <div style="font-size:12px; color:#909399">manifest 版本</div>
              <div style="margin-top:4px"><el-tag size="small" type="info">v{{ PLUGIN_MANIFEST_VERSION }}</el-tag></div>
            </div>
            <div style="background:#fff; border:1px solid #faecd8; border-radius:6px; padding:10px">
              <div style="font-size:12px; color:#909399">zip 版本</div>
              <div style="margin-top:4px"><el-tag size="small" type="info">v{{ PLUGIN_ZIP_VERSION }}</el-tag></div>
            </div>
          </div>
          <el-alert :type="needsPluginRefresh ? 'warning' : 'success'" :closable="false" style="margin-bottom:12px" :title="needsPluginRefresh ? '需要刷新插件' : '插件版本一致'" :description="pluginStatusText" />
          <div style="margin-bottom:12px; padding:10px 12px; background:#fff; border:1px solid #faecd8; border-radius:6px; font-size:12px; color:#606266; line-height:1.7">
            <div style="font-weight:700; color:#303133; margin-bottom:4px">小白检查顺序</div>
            <div>1. 下载 zip 并解压后，在 Chrome 扩展程序中加载解压后的文件夹。</div>
            <div>2. 回到本页点击“刷新插件状态”，看到当前插件 v{{ PLUGIN_MANIFEST_VERSION }} 且“插件版本一致”再去批量上架。</div>
            <div>3. 如果提示低于发布包，请在扩展程序页点“重新加载”，必要时重新下载本页 zip。</div>
          </div>
          <p>最近更新：</p>
          <ul style="margin-left: 20px; color: #666; line-height: 1.8">
            <li>✅ v2.2.9.113 修复核价/采集任务续跑丢结果：重新加载扩展或断线后续跑时保留服务器上已完成的 results（旧逻辑清空，导致报告只剩续跑后的行），并从 processed 断点继续不重复跑。</li>
            <li>✅ v2.2.9.112 新增 Yandex 自动上架采集能力：领取 kind=yandex-collect 任务后逐个打开 1688 商品详情页，采集标题/图集/详情图/SKU(规格+价格+库存+图)/商品属性/包装重量尺寸并回传 ERP，生成 Yandex 上架草稿（配合 ERP 新增的「Yandex 自动上架」页面使用）。</li>
            <li>✅ v2.2.9.111 修复 Yandex 精核价取不到真实价格阶梯：1688 详情页改版后 window.__INIT_DATA 已为空，商品数据被内联进页面 script 的 JSON，旧解析拿不到阶梯就退化去抓页面里第一个 ¥ 数字（曾把 ¥1 引流档当采购价）。现在解析内联 JSON 取回真实价格阶梯(skuRangePrices)与各规格价(skuInfoMap)，并输出结构化证据供「混合配件店」按规格匹配（1个边刷¥1.9 与 1个尘袋¥3.2 不再混淆）。</li>
            <li>✅ v2.2.9.110 Yandex 全店精核价（1688 官方真实价）：采购价口径改为「1688 详情页价格阶梯的起批首档单价」（小批量真正能买到的价），修掉旧逻辑把价格文本里第一个数字当价格（"10件起 ¥3.2" 被读成 10）的问题；精核价时若榜首候选没有详情证据会补开它的详情页，避免用搜索列表的引流最低价。</li>
            <li>✅ v2.2.9.109 Yandex 核价提速：任务领取轮询从最长 30s 缩短到数秒（SW 存活期间每 4s 快轮询）；核价轻量模式只为首个候选开 1688 详情页补 MOQ/运费，其余候选直接用搜索接口字段，避免逐个开关详情页导致单行 60s+。</li>
            <li>✅ v2.2.9.104 修复单品找货"Ozon 主图为空"：Ozon 商品图 CDN 域名升级为 ozonstatic.cn，插件域名白名单/图片正则未覆盖新域名导致主图全被丢弃。已补 ozonstatic.cn/com 域名 + DOM 图片兜底采集 + 过滤价格标签营销图（payments-cdn）。</li>
            <li>✅ v2.2.9.102 单品找货采集买家实际支付价：Ozon 页面同时有 webPrice（卖家设置价）和 finalPrice（买家实际支付价，含平台自动拉活动的折扣后价，如 69）。现在独立提取两者，Excel 新增「Ozon买家价RMB(含活动)」列，方便看出哪些商品被平台拉低价格。</li>
            <li>✅ v2.2.9.101 修复单品找货必现报错：采集商品页时注入函数缺少 cleanOzonTitle 导致 ReferenceError 整行失败（连续 3 行即自动停止）。已把标题清洗函数内置到注入函数闭包内，采集恢复。</li>
            <li>✅ v2.2.9.100 批量上架静默采集：采集商品不再打开 Ozon 标签页，直接复用已登录的 seller.ozon.ru 页面走门户 API（/search + 复制商品 bundle）拿全量数据，全程后台执行、Chrome 不弹任何标签（对齐 MY ERP）；仅当 seller 未登录/无标签页时才兜底打开商品页。售价由批量上架页行价格填写（与门户一致不带价）。</li>
            <li>✅ v2.2.9.78 批量上架恢复 Seller portal 静默上架（对齐 MY ERP 插件）：一次把全店商品提交到草稿再发布，后台执行不弹窗、绕官方 import 限流；已补上传任务轮询，确认真实上架结果（不再"显示提交但后台无商品"）；portal 失败自动回退官方 import-by-sku；Ozon Seller API 调用统一加 60s 超时防挂死，批量上架超时问题缓解。单品找货滑块可续跑：Ozon/1688 遇到滑块、验证码、登录、超时不再整体停止任务，改为该行失败并继续下一行，连续失败 3 次（可配）才停止，人工处理后自动继续。</li>
            <li>✅ v2.2.9.77 单品找货滑块可续跑（对齐生产）：Ozon/1688 遇到滑块、验证码、登录、超时不再整体停止任务，改为该行失败并继续下一行；连续失败达到阈值（默认 3 次，可配）才停止。你手动处理完滑块后，后续行成功即自动继续，不用重新发任务；失败行原因保留在结果里。批量上架逻辑未调整。</li>
            <li>✅ v2.2.9.76 单品找货提速+稳定性：找货任务默认跳过 Seller 富化链（复制商品/类目解析等上架用步骤）并对 1688 候选详情启用轻量浏览（保留防风控滚动），单行耗时对标生产；服务端领取任务时支持超时任务重新领取（插件掉线 90s 内自动续跑，不再卡到人工取消）；批量上架逻辑未调整。</li>
            <li>✅ v2.2.9.75 单品找货增强任务续租：行间等待持续回传心跳，服务端可快速救回失联/空闲未收尾任务，避免卡在 N/40 后不继续。</li>
            <li>✅ v2.2.9.72 单品找货识别 Ozon 滑块/验证码页，并给 Ozon/1688 单行采集增加硬超时；停止任务会中断当前步骤，避免卡在 39/40 条仍被心跳保活。</li>
            <li>✅ v2.2.9.63 单品找货降低 1688 风控触发：自适应风控窗口（60s 内失败 / 验证码事件动态拉长下次间隔），normal cooldown 12-22s、连续失败 30-50s/60-90s、触发风控关键字 2-5min 暂停；批量上架逻辑未调整。</li>
            <li>✅ v2.2.9.67 单品找货日志优化：实时状态保持刷新，但日志只记录关键节点，不再重复刷屏。</li>
            <li>✅ v2.2.9.61 单品找货 1688 搜图主链路切回真实 1688 页面会话，避免 direct MTOP 在当前会话中连续超时；批量上架逻辑未调整。</li>
            <li>✅ v2.2.9.60 单品找货修复旧任务锁定导致实时日志不跟随新任务，并给 1688 搜图主图压缩加 8 秒保护；批量上架逻辑未调整。</li>
            <li>✅ v2.2.9.59 单品找货补齐 1688 图片上传/搜图接口真实网络超时，并恢复实时日志自动同步；批量上架逻辑未调整。</li>
            <li>✅ v2.2.9.58 单品找货增加 1688 以图搜货单行超时保护：单个商品搜图卡住会记录失败并继续下一行；批量上架逻辑未调整。</li>
            <li>✅ v2.2.9.57 单品找货对齐生产稳定策略：1688 token 恢复不再自动打开预热页面，候选详情页不再强制切到前台，服务端会拦截旧插件领取任务，降低触发验证码概率；批量上架逻辑未调整。</li>
            <li>✅ v2.2.9.56 单品找货增加服务端插件版本闸门：低于 v2.2.9.55 或未上报版本的旧插件只能心跳，不能领取任务，避免旧扩展触发 1688 验证；批量上架逻辑未调整。</li>
            <li>✅ v2.2.9.55 单品找货 1688 搜图切回生产同款 MTOP 接口主链路，减少真实搜图页触发验证；遇到 1688 登录/验证码阻塞会自动停止后续采集，批量上架逻辑未调整。</li>
            <li>✅ v2.2.9.54 恢复单品找货独立入口，插件使用 ERP 页面短期授权领取任务，并改为临时 1688 搜图页 + MOQ=1 优先排序；批量上架逻辑未调整。</li>
            <li>✅ v2.2.9.53 修复单品找货复用 1688 搜图页时 tab 失效导致 No tab with id 的问题，自动重建搜图页重试；批量上架逻辑未调整。</li>
            <li>✅ v2.2.9.52 恢复单品找货原默认参数：5 个候选、8-20 秒间隔、候选详情完整采集；保留页面会话搜图与 moqText 修复；批量上架逻辑未调整。</li>
            <li>✅ v2.2.9.50 修复单品找货 1688 页面候选归一化 moqText 未定义导致搜图失败；批量上架逻辑未调整。</li>
            <li>✅ v2.2.9.49 单品找货 1688 搜图禁用插件后台 direct MTOP 回退，并复用同一个 1688 搜图页，降低验证码触发；批量上架逻辑未调整。</li>
            <li>✅ v2.2.9.48 单品找货 1688 搜图页、结果页、详情页和 token 预热页增加模拟人工激活、滚动、停留，降低连续采集触发验证码概率；批量上架逻辑未调整。</li>
            <li>✅ v2.2.9.47 单品找货最终候选改为 exact 优先 + MOQ=1 + 质量分择优，并导出运费/重量来源诊断；批量上架逻辑未调整。</li>
            <li>✅ v2.2.9.46 单品找货强化 MOQ=1 硬规则、1688 运费模板字段识别、同款近似纠偏；批量上架逻辑未调整。</li>
            <li>✅ v2.2.9.45 单品找货最终货源强制明确一件起购；运费未知不再按 0 计入采购成本；仅水印/贴纸/标题/拍摄差异导致的近似会校正为完全一致；批量上架逻辑未调整。</li>
            <li>✅ v2.2.9.44 单品找货增强 MOQ 识别和 AI 规则约束，避免起批量不合规候选进入最终结果；批量上架逻辑未调整。</li>
            <li>✅ v2.2.9.43 单品找货独立为 #/single-sourcing；增强 1688 重量解析，从隐藏 JSON、物流/包装/SKU 字段和页面文本兜底读取；批量上架逻辑未调整。</li>
            <li>✅ v2.2.9.42 单品找货拿到 1688 imageId 后优先进入真实结果页读取候选，接口结果保留兜底；批量上架逻辑未调整。</li>
            <li>✅ v2.2.9.41 单品找货 1688 以图搜货优先使用真实 1688 页面会话，上传前压缩 Ozon 主图，direct MTOP 保留兜底；批量上架逻辑未调整。</li>
            <li>✅ v2.2.9.40 单品找货 1688 以图搜货改为串行执行、失败冷却、会话强制恢复，并压缩错误摘要，避免 AI 审核因 1688 连续失败被跳过。</li>
            <li>✅ v2.2.9.39 增强 1688 token/非法请求/store image error 自动刷新重试；导出/进度明确显示无候选跳过 AI 原因。</li>
            <li>✅ v2.2.9.38 修复单品找货 1688 搜图稳定性: Chrome 标签页瞬时不可编辑时自动重试, 1688 图片上传 store image error 会刷新令牌后重试并返回明确错误。</li>
            <li>✅ v2.2.9.37 修复单品找货导出缺字段: Ozon 重量/价格增加兜底映射, 1688 标题过滤公司名并补价格明细。</li>
            <li>✅ v2.2.9.36 增强单品找货 1688 详情解析: 从页面初始化数据读取标题、阶梯价、起批、尺寸、重量、运费和商品属性。</li>
            <li>✅ v2.2.9.35 修复 1688 搜图 token 获取: 插件会主动预热 MTOP cookie, 已登录 1688 时可自动拿到 _m_h5_tk。</li>
            <li>✅ v2.2.9.34 修复单品找货插件授权: ERP 页面会把当前账号的短期授权同步给插件, 插件可显示在线并领取排队任务。</li>
            <li>✅ v2.2.9.33 单品找货接入逐梦采集插件: 插件可按当前登录账号领取任务, 采集 Ozon 商品并通过 1688 搜图返回候选货源。</li>
            <li>✅ v2.2.9.32 修复采集端富内容兜底作用域错误, 避免 parseMaybeJson 未定义导致采集失败。</li>
            <li>✅ v2.2.9.31 对齐 MyERP 富内容结构: 图册型 11254 使用 billboard + roll + width_full 格式, 并过滤重复大图, 确保 Ozon 真正保存 JSON 富内容。</li>
            <li>✅ v2.2.9.30 富内容兜底: 真实 richAnnotationJson 抓不到时, 用源商品完整图册生成 11254 JSON, 避免 Seller 后台富内容为空。</li>
            <li>✅ v2.2.9.29 修复 Seller portal 草稿图片字段重复: 图片只走 top-level images, 提交前去重属性。</li>
            <li>✅ v2.2.9.28 新增单店铺 Seller portal 复制草稿发布实验路径, 用于验证富文本保留。</li>
            <li>✅ v2.2.9.27 扩大 Ozon 富文本 JSON 扫描范围; 同步要求批量上架页使用最新插件。</li>
            <li>✅ v2.2.9.26 修复 Seller bundle 富文本提取作用域错误; 库存补偿提交时补齐 product_id 并记录 Ozon 响应, 避免返回成功但库存未落仓。</li>
            <li>✅ v2.2.9.25 修复类目误纠偏: 采集到 Seller bundle 源类目/类型时优先使用源商品信息, 避免公开页名称候选把背包等商品纠到错误类目。</li>
            <li>✅ v2.2.9.24 修复水印/库存/富内容补偿: imported 任务若缺图片、属性或库存会继续后台重试; 水印图存在时补图只提交水印后的 /uploads 图片; Seller bundle 递归提取 richAnnotationJson/富内容 JSON。</li>
            <li>✅ v2.2.9.23 修复插件弹窗版本号显示: popup 改为读取 manifest 版本, 店铺管理增加店铺水印配置; 批量上架支持发布前按店铺自动水印与 AI 重写, 并优化解析预览表格不再撑宽页面。</li>
            <li>✅ v2.2.9.22 修复 Seller bundle 类目误判: /search 的 description_type_dict_value 按 type_id 处理, 后端 category-resolve/import 会用 type_id 从 Ozon tree 精确反查父类目, 避免 Смеситель 被关键词误分到 Души и душевые кабины 导致 description_category_invalid。</li>
            <li>✅ v2.2.9.21 修复批量跟卖图片重复与富内容漏采: 后端按 Ozon 图片文件指纹去重, 优先使用源商品 4194/4195 图册并过滤 cms/评价图; 插件富内容采集增加标准商品路径和 PDP nextPage 追踪, 提高 attribute 11254 JSON 命中率。</li>
            <li>✅ v2.2.9.20 修复 Ozon 卡片图片重复和枚举属性错误: 图片属性 4194/4195 不再作为 attributes 提交, 只走 images/补图; Seller bundle 的 dictionary_value_id 保留并提交, 避免颜色/特征/车型等枚举属性被当作文本。</li>
            <li>✅ v2.2.9.19 修复已登录 seller 仍提示 sc_company_id 缺失: company_id 读取增加全域 cookie 与 seller/ozon 页面 document.cookie 兜底, 对齐 My ERP 的读取方式。</li>
            <li>✅ v2.2.9.18 Seller bundle 失败原因细化: /search 找不到 variant_id、create-bundle 不返回 item、bundle attributes 为空都会在批量上架日志里显示具体原因, 不再只显示“未拿到完整源包”。</li>
            <li>✅ v2.2.9.17 修复首轮类目候选慢导致“未解析”: category-resolve 首次加载 Ozon 类目树可能超过 15s, 插件等待时间放宽到 45s, 避免服务端已经算出候选但前端先超时。</li>
            <li>✅ v2.2.9.16 批量上架增加完整源包保护: 采集结果没有 _sourceVariant / Seller bundle 时直接拦截上架, 并在日志和 payload 里记录插件版本、bundle 成功状态和失败原因, 防止继续生成属性缺失商品。</li>
            <li>✅ v2.2.9.15 对齐 My ERP 复制商品链路: 插件先走 seller /api/v1/search 找真实 variant_id, 再走 create-bundle-by-variant-id 拿完整 bundle item, 把源商品属性、尺寸重量、条码、图片与 _sourceVariant 一起提交, 避免跟卖后只剩少量属性或 100x100x100 兜底尺寸。</li>
            <li>✅ v2.2.9.14 对齐 My ERP 富内容: 采集 Ozon PDP 的 entrypoint/composer widgetStates, 抽取 richAnnotationJson / Rich Content JSON 并作为 attribute 11254 随批量上架提交, 保留 Seller 后台「JSON 富内容」。</li>
            <li>✅ v2.2.9.13 对齐 My ERP followSell: 批量上架默认走完整 /v3/product/import, 保留 source_sku 但不再短路成 import-by-sku; 插件采到的 _sourceVariant 会透传到后端, 后端用源变体补全图片、属性、尺寸重量并保存到上架历史, 避免只上主图或商品信息空。</li>
            <li>✅ v2.2.9.12 强化 Ozon 商品页完整采集: 从页面 state、JSON-LD、script hydration 文本、DOM 图片源多路合并图片 URL, 避免只抓到首屏 1 张图; attributes 也改为追加去重, 为跟卖后补图/补属性提供完整数据</li>
            <li>✅ v2.2.9.11 修复 2906884816 采集时报 VERSION is not defined: 注入到 Ozon 页面里的 extractOzonProductData 不能引用 service worker 外层 VERSION 常量, 现在改为注入函数内本地日志; ping 也会回传 background 真实版本, 批量页日志可直接看到插件是否已更新</li>
            <li>✅ v2.2.9.10 修复 v2.2.9.9 try/catch 拆分 inner 函数的 ReferenceError: chrome.scripting.executeScript 注入的函数只能引用自己函数体内代码 (跨函数调会 ReferenceError), user SW console 显示 extractOzonProductDataInner is not defined. 现在把 helper (deepFindFullProduct/mergeProductObject/parseWeight) 全内嵌到 extractOzonProductData 函数体内, try/catch 包整个函数</li>
            <li>✅ v2.2.9.9 extract 函数整体包 try/catch (防抛错被吞), 抛错时 log 到 page console + 返回 minimal data 带 _error 字段, polling 检测 _error 打印到 SW console. user 上次反馈 tab.status=complete + result=null (没抛错被打印), 说明 extract 内部异常被吞, 现在 SW console 一定能看到</li>
            <li>✅ v2.2.9.8 增强 plugin 采集 debug: 第 1/5/10 次打印 result 类型 + tab.status + URL, 30s 全空时报最后 raw. 让 user 在 chrome://extensions → service worker console 看具体为啥空 (tab 没渲染/extract 函数抛错/executeScript 权限)</li>
            <li>✅ v2.2.9.7 修复 plugin 采集 2906884816 等 SPA 慢加载商品空采集: Chrome 后台 tab JS throttle 严重, polling 5×1s 不够. 改 15×2s, exit 放宽到 name 拿到就 break (不再强求 cat > 0, category-resolve 后续用 candidates 补). executeScript 抛错也打印方便 debug</li>
            <li>✅ v2.2.9.6 attribute 9048 (Название модели 型号名称) 自动兜底: plugin 从商品 name 提取型号 (跳过通用俄文词 + 尺寸/容量, 保留英文 brand+型号), server 端也兜底一次 (plugin 旧版本不会漏). 之前 Ozon 接受商品 (imported) 但 attribute 9048 必填字段空, 商品在 seller 后台无法正常上架. 实测 3678512870 帐篷 → "Cloud Skies Tarp Lite (L)" → Ozon 接受 task 5045289680 ✓</li>
            <li>✅ v2.2.9.5 candidates 排序更智能: server 端 token 集合从 3 扩到 8, 优先俄文 (cyrillic) 降权英文 (商品名常带品牌词 cloud/skies/tarp 等); 排序时 score 相同优先 name 完全等于商品 token 的 (e.g. "Тент" name == "тент" token). 实测 3678512870 大旅行帐篷: candidates #1 = cat=17029010 type_id=93523 "Тент" (天幕), 上架 task 5039550669 接受 ✓</li>
            <li>✅ v2.2.9.3 传 name 给 category-resolve, 让 server candidates 能用 name 关键词匹配 Ozon tree. v2.2.9.4 修复 5位 cat=11427 被 Ozon 拒 levels_category_not_found: 5位 (公开 URL slug) 跟 8位 (Seller API 内部 id) 是两套体系, plugin 默认用 candidates 第一个 8位 cat, server 兜底: 5位不在 Seller API tree 直接 400 (避免 Ozon polling 才暴露). 实测 cat=17029010 type_id=93526 (Шатер туристический 帐篷) → Ozon 接受 task 5039488916 ✓</li>
            <li>✅ v2.2.9.2 plugin resolve 失败时自动应用 candidates 第一个 cat (按商品 name 关键词匹配高分优先), 自动填 description_category_id + type_id, confidence=medium/high. user 不再需要手动点选类目 — 采集到就自动填上, 上架后去 Ozon 后台核对即可</li>
            <li>✅ v2.2.9.1 修复 cat=0 让 user 选类目: plugin Ozon SPA breadcrumb 等不到加 polling retry (5次 × 1s), extract 函数改取最后一级 breadcrumb (具体类目, 不是第一个), resolve 失败不清零 cat 保留 plugin 抓的 5位 breadcrumb (Ozon v2.2.9 实测接受 5位). server 端 fallback candidates 改成 "商品 name 关键词从 Ozon 全 tree 匹配" 作为第一批, 店铺历史高频降为兜底, 实测 tea kettle (Чайник заварочный) 现在第一个候选就是 cat=17028741 type_id=92538 ✓</li>
            <li>✅ v2.2.9 简化 type_id 推断: 抛弃 _sourceVariant 透传 + 5位→8位 mapping (Ozon 5位公开 cat + 8位 Seller cat 都接受). 新增 /api/seller/description-category-types endpoint, 直接调 Ozon /v1/description-category/tree 拿这个 cat 下的所有 type_id 列表 (含 type_name), 用户选一个. server 端 products/import 5位/8位 cat_id 都直接转发, 不再 normalize 警告. plugin 不再保存 _sourceVariant, mapOpiAttributes 回退到 v2.1.8 扁平版, BatchUpload 不再透传 _sourceVariant. 实测 cat=17028957 + type_id=970780832 (3035117601 跟卖) → task_id 5039100506 ✓</li>
            <li>✅ v2.2.8 跟卖深度适配: plugin enrichFromOpi 保存 data._sourceVariant = detail (完整 OPI 原始数据, 含 attributes 完整结构 + complex_attributes + 8 位 leaf cat + dimensions). mapOpiAttributes 改成 passthrough 模式保留 dictionary_value_id (单值) + dictionary_value_ids (多值). BatchUpload buildV3Item 透传 _sourceVariant 到 server, server 优先用 _sourceVariant.attributes (完整结构) 替代扁平 [{id,name,value}], 跟 MY ERP 一样让 Ozon 看到 source 数据. checkTitleQuality 加 Cyrillic 检测 (\u0400-\u04FF, 纯拉丁字母警告). 原因: 跟卖商品图片和商品信息都要跟竞品一样才会有流量</li>
            <li>✅ v2.2.7 Ozon 适配: 仿 MY 批量上架 payload, 调 Ozon /v3/product/import 时增加 service_type=IS_CODE_SERVICE (跟卖场景), attribute 自动带 dictionary_value_id (客户端传了才带), stocks 跟 items 同一次原子提交 (替代 v2.2.6 的二次 /v2/products/stocks 调用). 9 case 实测确认 Ozon /v3/product/import 强制 type_id>0 (service_type 不豁免), 8 位 leaf cat 比 5 位 breadcrumb 更稳</li>
            <li>✅ v2.2.6 per-store 仓库: 选店铺后自动拉 FBS 仓库, 每店一个, 上架成功后写库存到指定 warehouse_id</li>
            <li>✅ v2.2.5 type_id 折叠: 类目 cell 内置小灰字 type XXXXX (用户不用填), 选类目 modal 后自动调 /api/seller/type-id-suggestion 配 type_id</li>
            <li>✅ v2.2.4 fix bug: 商品上架时 plugin 不会把 URL 面包屑 5 位 cat ID (9700) 误提交给 Seller API 了 (之前会让 Ozon 返回 levels_category_not_found, 后台看不到商品). 三处拦截: plugin 清空 + 前端按钮 disabled + publishBatch 跳过</li>
            <li>✅ v2.2.3 polish: publishBatch 完成后加 "查看上架状态" CTA, 一键跳 #/listing-history 看真实状态</li>
            <li>✅ v2.2.2 BatchUpload 表格新增"类目"列, 高/中/无置信度 badge + 候选选择 modal, 用户 1-click 改类目</li>
            <li>✅ v2.2.1 类目解析优化: 调 ERP /category-resolve 时带 type_id, 严格名字匹配 (2 token 都中才用), 失败带 candidates 让前端展示</li>
            <li>✅ v2.2.0 流程简化: 不再前端校验类目, 直接提交让 Ozon 自己拒, 用户去 seller.ozon.ru 后台改类目更直接</li>
            <li>✅ v2.1.9 类目解析升级: 采集后自动调 ERP /category-resolve 拿店铺 Seller API 真实类目 (替换 URL 解析的不可靠 ID)</li>
            <li>✅ v2.1.0 重磅: 辅源 OPI 上线! 调 api-seller.ozon.ru 找店铺里同款商品, 复用 attributes + 修正 type/cat (基于 0.13.48.1 opi-client.js)</li>
            <li>✅ v2.0 UI 重构: 顶部 toolbar + 10 格式面板 + Help drawer + 实时日志 (参考 MY 批量上架)</li>
          </ul>
          <p style="margin-top: 10px; font-size: 12px; color: #999">
            安装方法：解压后在 Chrome 扩展程序页面开启“开发者模式”，点击“加载已解压的扩展程序”选择文件夹即可。
          </p>
        </div>
      </el-card>
      </div>

      <el-dialog v-model="dialogVisible" :title="dialogPlatform === 'yandex' ? '新增 Yandex Market 店铺授权' : '新增 Ozon 店铺授权'" width="540px">
        <div style="margin-bottom:16px">
          <el-radio-group v-model="dialogPlatform" @change="switchDialogPlatform">
            <el-radio-button value="ozon">Ozon</el-radio-button>
            <el-radio-button value="yandex">Yandex Market</el-radio-button>
          </el-radio-group>
        </div>
        <el-form :model="form" label-position="top">
          <template v-if="dialogPlatform === 'ozon'">
            <el-form-item label="店铺名称" required>
              <el-input v-model="form.name" placeholder="例如：我的 Ozon 一号店" />
            </el-form-item>
            <el-form-item label="Client ID" required>
              <el-input v-model="form.client_id" placeholder="从 Ozon Seller 后台获取" />
            </el-form-item>
            <el-form-item label="API Key" required>
              <el-input v-model="form.api_key" type="password" show-password placeholder="从 Ozon Seller 后台获取" />
            </el-form-item>
          </template>
          <template v-else>
            <el-alert type="info" :closable="false" style="margin-bottom:12px"
              title="Yandex Market API Key 获取方式"
              description="登录 partner.market.yandex.ru → 设置/开发者 → API Keys，复制 Api-Key（形如 ACMA:...）。填好后点「探测店铺」自动识别账号下的店铺。" />
            <el-form-item label="API Key (Api-Key)" required>
              <el-input v-model="form.api_key" type="password" show-password placeholder="ACMA:xxxxxxxx" />
            </el-form-item>
            <el-form-item>
              <el-button :loading="probingCampaigns" @click="probeYandexCampaigns">探测店铺</el-button>
            </el-form-item>
            <el-form-item v-if="yandexCampaigns.length" label="选择要授权的店铺（business 下的 campaign）" required>
              <el-select v-model="form.campaign_id" style="width:100%" placeholder="请选择 campaign"
                @change="(val) => { const c = yandexCampaigns.find(x => x.id === val); if (c) { form.client_id = c.businessId; if (!form.name) form.name = c.name; } }">
                <el-option v-for="c in yandexCampaigns" :key="c.id" :label="(c.name || c.businessName) + '（business ' + c.businessId + '）'" :value="c.id" />
              </el-select>
            </el-form-item>
            <el-form-item label="店铺名称（展示用，可修改）" required>
              <el-input v-model="form.name" placeholder="例如：ThreeLatte" />
            </el-form-item>
          </template>
        </el-form>
        <template #footer>
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" @click="submitForm" :loading="submitLoading">保存并验证</el-button>
        </template>
      </el-dialog>
    </div>
  `
};
