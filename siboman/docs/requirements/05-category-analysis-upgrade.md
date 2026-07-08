# 05-category-analysis-upgrade · 类目分析升级

> 归属模块：选品  ｜  优先级：P0  ｜  预估工作量：5 人日  ｜  状态：待评审

## 1. 背景

当前逐梦 ERP 的类目分析模块（`#/sourcing/category`）主要调用 Ozon Seller API 的 `/v1/analytics/data` 端点，仅能显示基础的 GMV、月销量等指标。对比行业领先产品 MyERP，我们的类目分析缺乏深度，无法为卖家提供“退货风险”、“竞争集中度”、“物流模式占比”等核心经营决策数据。

目前的代码实现位于：
- `server.js` @ line 521: `app.post("/api/seller/analytics/categories", ...)`
- `public/app.js` @ line 241: `async function renderCategoryAnalysis(root)`

为了提升选品精度，需要对类目分析模块进行全量升级，引入深度竞争指标。

## 2. 目标与非目标

### 目标
- **增强指标**：在现有类目分析表格中增加：卖家数、品牌集中度 (CR5)、FBS 卖家占比、估算退货率、平均客单价。
- **维度过滤**：增加五个核心 Subtab（全部、增长机会、高退货率、品牌集中、FBS 机会），实现一键筛选。
- **类目下钻**：支持点击类目名称，展开该类目下的 Top 50 热销商品列表，支持一键采集。
- **UI 优化**：对标 MyERP 截图 `07-category-analysis.png`，优化表格列头显示及 ₽/¥ 切换。
- **数据缓存**：引入 Redis 或本地缓存机制，避免频繁调用 Ozon API 导致限流。

### 非目标
- 本次升级不包含类目搜索热度趋势分析（将放在关键词模块）。
- 不处理非跨境类目的特殊物流模式分析。

## 3. 用户故事

1.  **避坑场景**：作为卖家，我想查看“高退货率”类目，自动筛选出退货率 > 15% 的类目（如部分服饰、易损玻璃制品），从而在初期避开高风险品类。
2.  **找机会场景**：我想查看“FBS 机会”类目，筛选出 FBS 占比高、品牌集中度 (CR5) < 20% 的类目，这代表该类目缺乏强势品牌，且适合跨境发货。
3.  **对标场景**：我选定一个类目后，想点击它直接看到该类目下的 Top 商品是什么样子，直接对比他们的卖点和价格。

## 4. 界面草图 (Text Mockup)

```text
+-----------------------------------------------------------------------------------------------------+
| [选品] / 类目分析                                                                    [ 币种: ₽ | ¥ ] |
+-----------------------------------------------------------------------------------------------------+
| (筛选页签)                                                                                           |
| [ 全部 ] [ 增长机会(GMV↑30%) ] [ 高退货率(>15%) ] [ 品牌集中(CR5>30%) ] [ FBS机会(FBS>50%) ]          |
+-----------------------------------------------------------------------------------------------------+
| # | 类目路径         | 月销量 | 月销售额 | GMV 增长 | 平均价 | 卖家数 | CR5   | FBS% | 退货率 | 操作 |
|---|------------------|--------|----------|----------|--------|--------|-------|------|--------|------|
| 1 | 电子/手机配件/壳 | 12.5k  | 8.5w ₽   | +25.4%   | 680₽   | 1,200  | 12.5% | 85%  | 2.1%   | [详情]|
| 2 | 家居/照明/吸顶灯 | 4.2k   | 21.0w ₽  | +45.1%   | 5,000₽ | 450    | 8.2%  | 65%  | 4.5%   | [详情]|
| 3 | 鞋包/女鞋/凉拖   | 18.2k  | 45.0w ₽  | -5.2%    | 2,470₽ | 2,800  | 45.1% | 12%  | 18.5%  | [详情]|
+-----------------------------------------------------------------------------------------------------+

(类目下钻详情页 - 抽屉式弹窗)
+-----------------------------------------------------------------------------------------------------+
| [电子/手机配件/壳] 类目 Top 50 热销商品                                                            |
+-----------------------------------------------------------------------------------------------------+
| # | 商品主图 | 标题                                | 价格   | 月销量 | 品牌     | 操作            |
|---|----------|-------------------------------------|--------|--------|----------|-----------------|
| 1 | [IMG]    | iPhone 15 Silicone Case (Blue)      | 1,200₽ | 850    | Apple    | [一键采集] [找货]|
| 2 | [IMG]    | Magnetic Magsafe Case for iPhone 14 | 850₽   | 620    | OEM      | [一键采集] [找货]|
+-----------------------------------------------------------------------------------------------------+
```

## 5. 数据源方案评估

### 5.1 指标获取逻辑

| 指标 | 计算/获取逻辑 | 来源 |
|---|---|---|
| **月销量/GMV** | 通过 API 获取过去 30 天的累积数据 | `/v1/analytics/data` (API) |
| **GMV 增长** | (本期 GMV - 上期 GMV) / 上期 GMV | 历史库对比或 API 双时间段调用 |
| **平均价** | GMV / 月销量 | 内存计算 |
| **卖家数** | 通过前台类目页筛选器抓取该类目下的卖家统计 | `collector.js` (Scraping) |
| **品牌集中度 (CR5)** | 统计 Top 5 品牌的 GMV 总和 / 类目总 GMV | 数据聚合计算 |
| **FBS 占比** | 统计类目 Top 500 商品中物流模式为 FBS 的商品数量 / 500 | 抽样计算 |
| **退货率** | 启发式：利用 API 的 `returns` 数据（如有权限）或行业基准库。若 API 不支持全平台，则标记为“估算值”。 | `/v1/analytics/data` + 行业均值 |

### 5.2 推荐方案
采用 **“API 数据为主，采集补采为辅”** 的异步刷新模式：
1.  **T级（天级）更新**：由 `server.js` 每天自动拉取全量类目基础 GMV。
2.  **热点激活（即时更新）**：当用户点击某个类目或进入某个 Subtab 时，如果缓存中没有卖家数/CR5 等深度指标，则下发一个 `category_deep_scan` 任务给采集端。

## 6. 后端 API 设计

### 6.1 增强版类目列表 API
`POST /api/seller/analytics/categories`
- **Request Body**:
```json
{
  "range": "30",
  "filter_type": "all | growth | high_return | brand_concentrated | fbs_opportunity",
  "limit": 100,
  "offset": 0
}
```
- **Response Structure**:
```json
{
  "success": true,
  "data": [
    {
      "category_id": "12345",
      "category_path": "电子 > 手机配件",
      "revenue": 850000,
      "ordered_units": 1250,
      "gmv_growth": 0.254,
      "avg_price": 680,
      "seller_count": 1200,
      "cr5": 0.125,
      "fbs_ratio": 0.85,
      "return_rate": 0.021
    }
  ]
}
```

### 6.2 类目 Top 商品下钻 API
`GET /api/seller/analytics/categories/:id/products`
- **Response**:
```json
{
  "items": [
    {
      "ozon_id": "123",
      "title": "Case for iPhone",
      "price": 1200,
      "monthly_sales": 850,
      "brand": "Apple",
      "image": "https://cdn..."
    }
  ]
}
```

## 7. 数据模型变更

在现有的 PostgreSQL 数据库中扩展类目统计表：
```sql
CREATE TABLE app_category_analytics (
    category_id VARCHAR(50) PRIMARY KEY,
    category_path TEXT,
    revenue_30d FLOAT,
    units_30d INT,
    gmv_growth FLOAT,
    avg_price FLOAT,
    seller_count INT,
    brand_concentration_cr5 FLOAT,
    fbs_ratio FLOAT,
    return_rate FLOAT,
    last_updated TIMESTAMP DEFAULT NOW()
);
```

## 8. 前端改动 (Detailed)

### 8.1 UI 组件升级
- **Tab 栏实现**：在 `renderCategoryAnalysis` 中添加 `nav-pills` 样式的 Tab。
- **列头交互**：支持点击列头进行内存排序。
- **Loading 状态**：深度指标抓取时显示骨架屏（Skeleton Screen）。

### 8.2 JavaScript 渲染逻辑
```javascript
// app.js @ line 241
async function renderCategoryAnalysis(root) {
    const filterType = state.categoryFilter || 'all';
    const data = await fetchPost('/api/seller/analytics/categories', { filter_type: filterType });
    
    root.innerHTML = `
        <div class="category-header">...</div>
        <div class="category-tabs">
            <button class="${filterType === 'all' ? 'active' : ''}" onclick="switchCatFilter('all')">全部</button>
            <button class="${filterType === 'growth' ? 'active' : ''}" onclick="switchCatFilter('growth')">增长机会</button>
            ...
        </div>
        <table class="app-table">
            <thead>
                <tr>
                    <th>类目</th>
                    <th>月销量</th>
                    <th>月销售额</th>
                    <th>GMV 增长</th>
                    <th>平均价</th>
                    <th>卖家数</th>
                    <th>CR5</th>
                    <th>FBS%</th>
                    <th>退货率</th>
                    <th>操作</th>
                </tr>
            </thead>
            <tbody>
                ${data.map(item => `
                    <tr>
                        <td class="clickable" onclick="showCategoryDetail('${item.category_id}')">${item.category_path}</td>
                        <td>${formatUnits(item.ordered_units)}</td>
                        <td>${formatPrice(item.revenue)}</td>
                        <td class="${item.gmv_growth >= 0 ? 'text-success' : 'text-danger'}">${(item.gmv_growth * 100).toFixed(1)}%</td>
                        <td>${formatPrice(item.avg_price)}</td>
                        <td>${item.seller_count || '-'}</td>
                        <td>${item.cr5 ? (item.cr5 * 100).toFixed(1) + '%' : '-'}</td>
                        <td>${item.fbs_ratio ? (item.fbs_ratio * 100).toFixed(1) + '%' : '-'}</td>
                        <td>${item.return_rate ? (item.return_rate * 100).toFixed(1) + '%' : '-'}</td>
                        <td><button onclick="showCategoryDetail('${item.category_id}')">分析</button></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}
```

## 9. 采集端改动 (Collector Implementation)

在 `collector.js` 中增加以下抓取逻辑：
1.  **入口**：`https://www.ozon.ru/category/[category_id]/`
2.  **指标提取**：
    - **卖家数**：定位到左侧筛选器的“Продавец” (Seller) 展开项，统计总行数。
    - **品牌**：定位到“Бренд” (Brand)，获取前 5 个品牌的数值，计算 CR5。
    - **物流**：解析商品卡片上的 “Доставка Ozon” (FBP) vs “Доставка со склада продавца” (FBS)。

## 10. 依赖与前置

1.  **API 权限**：需要 Ozon Seller API 的 Analytics 读取权限。
2.  **采集资源**：Mac 采集端需要处于运行状态且有稳定的代理 IP。
3.  **汇率库**：依赖 `server.js` 中已有的汇率同步逻辑。

## 11. 验收标准

1.  **数据完整性**：所有 10 个字段均有数据或明确的占位符（“-”）。
2.  **过滤准确性**：点击“增长机会”，列表中所有类目的 GMV 增长必须 >= 30%。
3.  **交互顺畅**：类目详情下钻窗口开启时间应 < 500ms（基于缓存数据）。
4.  **性能**：主表首屏渲染时间应 < 1s。

## 12. 反爬风险与合规

### 12.1 反爬检测
- **Cloudflare**：Ozon 开启了高级 Web 盾牌。
- **JS Challenge**：自动化脚本需要通过 headless 绕过或有头模式模拟。

### 12.2 对抗策略
- **User-Agent 轮换**：使用 `collector.js` 现有的随机 UA 池。
- **频率限制**：同一个类目页抓取间隔不低于 30 秒。
- **验证码处理**：复用 `waitForHumanVerificationIfNeeded` @ line 3815。

## 13. 工作量估算

| 阶段 | 任务 | 耗时 (人日) |
|---|---|---|
| 设计 | 数据库建模与接口设计 | 0.5 |
| 后端 | Ozon API 对接与数据聚合逻辑 | 1.5 |
| 前端 | UI 界面开发与下钻交互逻辑 | 1.5 |
| 采集 | Collector.js 类目指标抓取逻辑 | 1.0 |
| 测试 | 联调与反爬策略优化 | 0.5 |
| **总计** | | **5.0** |

## 14. 风险与回滚

- **风险**：Ozon 全平台关闭类目筛选器中的品牌计数（曾经发生过）。
- **回滚**：前端增加开关，若采集失败，自动退回到仅显示 API 基础数据的“标准版”。

## 16. 详细异常处理与边缘情况

### 16.1 API 调用失败
- **场景**：Ozon Seller API 返回 429 (Too Many Requests)。
- **策略**：后端实施指数退避（Exponential Backoff）重试逻辑。若重试 3 次仍失败，则返回 `ERR_OZON_API_THROTTLED`，并在前端提示“平台接口繁忙，显示 1 小时前的缓存数据”。

### 16.2 深度指标缺失
- **场景**：对于新出现的长尾类目，可能没有卖家数和 CR5 数据。
- **策略**：在表格中该字段显示“计算中...”，后台自动插入一个低优先级的 `category_deep_scan` 任务，预计 10-15 分钟后用户刷新可得。

### 16.3 汇率剧烈波动
- **场景**：RUB/CNY 汇率在 24 小时内波动超过 5%。
- **策略**：系统前端显示“实时汇率预警”，且在切换 ¥ 时使用最近 1 小时的中间价，而非固定的 T-1 结算价。

## 17. 性能优化 (Backend & Frontend)

### 17.1 后端：三级缓存架构
1.  **一级缓存 (L1)**：Node.js 进程内内存缓存（LRU），存储 Top 20 核心类目，有效期 10 分钟。
2.  **二级缓存 (L2)**：PostgreSQL 缓存表，存储所有已算好的统计指标，有效期 24 小时。
3.  **三级缓存 (L3)**：Ozon API 原始响应存储在 `/data/api_cache/` 目录下，用于灾难恢复。

### 17.2 前端：虚拟滚动与分页
- **虚拟列表**：当类目总数超过 200 条时，使用虚拟滚动技术，仅渲染可视区域内的 DOM，避免页面卡顿（`app.js` 性能优化项）。
- **按需加载**：下钻详情页的 50 个商品采取懒加载（Lazy Loading）模式。

## 18. 迁移计划与上线步骤

1.  **Phase 1**：部署数据库表结构变更及后端 API（保持原前端不变）。
2.  **Phase 2**：在测试环境发布新版 UI，邀请 3 名核心卖家进行灰度测试。
3.  **Phase 3**：根据反馈调优 CR5 计算逻辑。
4.  **Phase 4**：全量发布，并替换原有 `renderCategoryAnalysis` 函数。

## 20. 核心功能实现伪代码 (Implementation Details)

### 20.1 后端：数据聚合引擎
```javascript
// server.js 伪代码逻辑扩展
async function getEnhancedCategoryData(options) {
    const { range, filter_type } = options;
    
    // 1. 获取 Ozon 基础数据
    const rawData = await ozonClient.post('/v1/analytics/data', {
        date_from: getPastDate(range),
        date_to: getToday(),
        dimension: ['category'],
        metrics: ['revenue', 'ordered_units']
    });

    // 2. 注入深度指标（从数据库缓存获取）
    const categories = rawData.data.map(item => {
        const stats = await db.query('SELECT * FROM category_stats WHERE id = $1', [item.id]);
        return {
            ...item,
            seller_count: stats.seller_count,
            cr5: stats.cr5,
            fbs_ratio: stats.fbs_ratio,
            return_rate: stats.return_rate || calculateBaseReturnRate(item.id)
        };
    });

    // 3. 应用过滤 Subtab
    switch(filter_type) {
        case 'growth':
            return categories.filter(c => c.gmv_growth > 0.3);
        case 'high_return':
            return categories.filter(c => c.return_rate > 0.15);
        case 'brand_concentrated':
            return categories.filter(c => c.cr5 > 0.3);
        case 'fbs_opportunity':
            return categories.filter(c => c.fbs_ratio > 0.5 && c.cr5 < 0.2);
        default:
            return categories;
    }
}
```

### 20.2 前端：渲染引擎细节
```javascript
// app.js renderCategoryAnalysis 内部逻辑
function drawCategoryTable(data) {
    const tableBody = data.map(row => `
        <tr class="category-row" data-id="${row.id}">
            <td class="name-cell">
                <span class="path-icon">📂</span>
                ${row.path}
            </td>
            <td class="numeric-cell">${row.units}</td>
            <td class="numeric-cell">${formatCurrency(row.revenue)}</td>
            <td class="trend-cell ${getTrendClass(row.growth)}">
                ${row.growth > 0 ? '▲' : '▼'} ${Math.abs(row.growth * 100).toFixed(1)}%
            </td>
            <td class="numeric-cell">${formatCurrency(row.avg_price)}</td>
            <td class="numeric-cell">${row.sellers}</td>
            <td class="progress-cell">
                <div class="progress-bar">
                    <div class="fill" style="width: ${row.cr5 * 100}%"></div>
                </div>
                <span>${(row.cr5 * 100).toFixed(1)}%</span>
            </td>
            <td class="numeric-cell">${(row.fbs * 100).toFixed(1)}%</td>
            <td class="risk-cell ${row.returns > 0.1 ? 'high-risk' : ''}">
                ${(row.returns * 100).toFixed(1)}%
            </td>
            <td class="action-cell">
                <button class="btn-detail" onclick="openCatDrawer('${row.id}')">下钻分析</button>
            </td>
        </tr>
    `).join('');
    
    return `
        <div class="table-container">
            <table class="ozon-analytics-table">
                <thead>...</thead>
                <tbody>${tableBody}</tbody>
            </table>
        </div>
    `;
}
```

## 21. 交互规范与视觉要求

### 21.1 颜色规范
- **增长 (Growth)**: `#2ecc71` (Emerald Green)
- **下跌 (Decline)**: `#e74c3c` (Alizarin Red)
- **高风险 (High Risk)**: `#f39c12` (Orange) 背景高亮
- **中性指标**: `#34495e` (Wet Asphalt)

### 21.2 字体与间距
- 类目路径使用 `12px` 细体，路径级联符号用 `gray-400`。
- 数字列使用等宽字体 (Monospace)，确保对齐。

## 22. 采集端任务分发逻辑

当用户点击“分析”时，系统判断数据时效性：
1.  **If (last_updated < 24h)**: 立即展示。
2.  **If (last_updated >= 24h)**:
    - 展示旧数据。
    - 弹出小气泡：“正在刷新深度指标...”。
    - 发送 `API_REFRESH_REQUEST` 给 `collector.js`。
    - 采集端返回 `WS_DATA_UPDATE` 消息，前端局部刷新。

## 23. 测试用例集 (Test Cases)

- **TC01**: 验证 Subtab 切换时，表格内容是否即时更新。
- **TC02**: 验证 ₽ 和 ¥ 切换时，所有金额列是否按最新汇率正确重算。
- **TC03**: 验证类目路径过长时，是否显示省略号及 Hover Tooltip。
- **TC04**: 验证网络断开时，页面的错误重试按钮是否有效。
- **TC05**: 验证 CR5 进度条在 0% 和 100% 时的显示样式。



---
*Document Version: 1.1*
*Last Edited: 2026-07-02*
