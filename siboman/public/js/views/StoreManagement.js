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
      api_key: ''
    });

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
      dialogVisible.value = true;
    };

    const submitForm = async () => {
      if (!form.name || !form.client_id || !form.api_key) {
        return ElementPlus.ElMessage.warning('请填写完整信息');
      }
      submitLoading.value = true;
      try {
        await axios.post('/api/seller/shops', form);
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
        await ElementPlus.ElMessageBox.confirm(`确定移除店铺 "${row.name}" 吗？`, '提示', { type: 'warning' });
        await axios.delete(`/api/seller/shops/${row.id}`);
        ElementPlus.ElMessage.success('已移除');
        fetchShops();
        window.dispatchEvent(new CustomEvent('shop-updated'));
      } catch (e) {}
    };

    const downloadExtension = () => {
      const link = document.createElement('a');
      link.href = '/extension/zhumeng-collector.zip';
      link.download = 'zhumeng-collector.zip';
      link.click();
    };

    const maskClientId = (id) => {
      if (!id) return '';
      return id.length > 8 ? id.slice(0, 4) + '****' + id.slice(-4) : id;
    };

    Vue.onMounted(fetchShops);
    const onShopChanged = () => fetchShops();
    window.addEventListener('shop-changed', onShopChanged);
    Vue.onBeforeUnmount(() => window.removeEventListener('shop-changed', onShopChanged));

    return { shops, loading, dialogVisible, submitLoading, form, handleAdd, submitForm, handleDelete, maskClientId, downloadExtension };
  },
  template: `
    <div class="store-management-container">
      <el-card>
        <template #header>
          <div style="display: flex; justify-content: space-between; align-items: center">
            <span>店铺授权管理</span>
            <el-button type="primary" @click="handleAdd">+ 新增授权</el-button>
          </div>
        </template>

        <el-table :data="shops" v-loading="loading" stripe>
          <el-table-column label="店铺名称" prop="name" />
          <el-table-column label="Client ID">
            <template #default="{ row }">
              <code>{{ maskClientId(row.client_id) }}</code>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="120">
            <template #default="{ row }">
              <el-tag :type="row.active ? 'success' : 'info'">{{ row.active ? '已激活' : '禁用' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="150" fixed="right">
            <template #default="{ row }">
              <el-button link type="danger" @click="handleDelete(row)">移除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <!-- 插件下载引导 -->
      <el-card style="margin-top: 20px; background-color: #fdf6ec; border-color: #faecd8;">
        <template #header>
          <div style="font-weight: bold; color: #e6a23c">
            逐梦 Ozon 采集器 (v2.2.8)
          </div>
        </template>
        <div style="font-size: 14px; color: #666; line-height: 1.6">
          <p>当前最新版本：<el-tag size="small" type="warning">v2.2.8</el-tag></p>
          <p>更新内容：</p>
          <ul style="margin-left: 20px; color: #666; line-height: 1.8">
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
          <div style="margin-top: 15px">
            <el-button type="warning" icon="Download" @click="downloadExtension">
              立即下载插件 (.zip)
            </el-button>
          </div>
          <p style="margin-top: 10px; font-size: 12px; color: #999">
            安装方法：解压后在 Chrome 扩展程序页面开启“开发者模式”，点击“加载已解压的扩展程序”选择文件夹即可。
          </p>
        </div>
      </el-card>

      <el-dialog v-model="dialogVisible" title="新增 Ozon 店铺授权" width="500px">
        <el-form :model="form" label-position="top">
          <el-form-item label="店铺名称" required>
            <el-input v-model="form.name" placeholder="例如：我的 Ozon 一号店" />
          </el-form-item>
          <el-form-item label="Client ID" required>
            <el-input v-model="form.client_id" placeholder="从 Ozon Seller 后台获取" />
          </el-form-item>
          <el-form-item label="API Key" required>
            <el-input v-model="form.api_key" type="password" show-password placeholder="从 Ozon Seller 后台获取" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" @click="submitForm" :loading="submitLoading">保存并验证</el-button>
        </template>
      </el-dialog>
    </div>
  `
};
