# 07-china-zone · 中国专区

> 归属模块：选品  ｜  优先级：P2  ｜  预估工作量：4 人日  ｜  状态：待评审

## 1. 背景

在跨境电商领域，“对标同行”是最稳妥的选品方式。MyERP 的“中国专区”（`docs/myerp-reference/09-china-zone.png`）允许用户一键筛选出所有中国卖家的热销商品。

对于逐梦 ERP 的用户来说，中国卖家的选品逻辑、货源渠道（1688）以及物流成本结构（如通过义乌、深圳中转）与本系统用户高度重合。通过“中国专区”，用户可以快速发现适合跨境小包直发的成熟爆款，极大地缩短了选品决策周期。

## 2. 目标与非目标

### 目标
- **跨境识别**：准确识别并聚合 Ozon 平台上的中国卖家商品。
- **同行对标**：展示中国卖家销量最高、评价最好的商品榜单。
- **货源匹配**：在列表中直接显示对应的 1688 预估采购价及利润空间。
- **多维筛选**：支持按“含零销量商品”、“高增长”、“新晋卖家”进行过滤。
- **页面集成**：在 `index.html` 侧边栏增加专门入口。

### 非目标
- 本次升级不涉及非中国籍跨境卖家（如土耳其、韩国卖家）的分析。
- 不提供中国卖家的真实联系方式或仓库地址（仅展示公开展示名）。

## 3. 用户故事

1.  **跟卖大卖**：作为卖家，我想看最近 7 天在“3C 类目”中表现最强劲的 10 个中国卖家，并查看他们的新上架商品。
2.  **成本倒算**：在看中国专区时，我想直接看到这个商品在 1688 上的大概进货价，从而算出如果我也卖，利润能有多少。
3.  **蓝海寻找**：我想过滤掉那些已经有几千条评价的大卖家，只看那些评价 < 50 且销量正猛的“新晋中国卖家”商品。

## 4. 界面草图 (Text Mockup)

```text
+---------------------------------------------------------------------------------------------------+
| [选品] / 中国专区                                                              [跨境同行对标]      |
+---------------------------------------------------------------------------------------------------+
| [ ] 含零销量商品  |  策略: [ 全部 ] [ 潜力黑马 ] [ 高增长 ] [ 蓝海对标 ] | (搜卖家名称/SKU)         |
+---------------------------------------------------------------------------------------------------+
| # | 商品主图 | 卖家名称(中国)      | Ozon 价格 | 1688 预估 | 月销量 | 评价 | 利润率 | 操作         |
|---|----------|---------------------|-----------|-----------|--------|------|--------|--------------|
| 1 | [IMG]    | Shenzhen Tech Co.   | 1,200₽    | ¥25.5     | 1,500  | 450  | 35%    | [一键跟卖] [分析]|
| 2 | [IMG]    | Yiwu Fashion Ltd.   | 450₽      | ¥8.0      | 850    | 12   | 42%    | [一键跟卖] [分析]|
| 3 | [IMG]    | Guangzhou Trading   | 2,800₽    | ¥110.0    | 320    | 150  | 28%    | [一键跟卖] [分析]|
+---------------------------------------------------------------------------------------------------+
```

## 5. 数据源方案评估 (Identifying Chinese Sellers)

Ozon 官方不直接暴露 `seller_country` 字段，我们将通过以下组合特征进行启发式识别：

### 5.1 识别维度与权重

| 维度 | 识别特征 | 实现方式 | 权重 |
|---|---|---|---|
| **物流文字** | `Доставка из Китая` (从中国发货) | 抓取商详页文本 | 100% |
| **公司名称** | 包含 `Co., Ltd`, `Shenzhen`, `Yiwu`, `Pinyin` 等 | 字符匹配 (Regex) | 80% |
| **配送时长** | 预计到达时间 > 12 天且发货地显示“国外” | 逻辑计算 | 70% |
| **品牌特征** | 品牌名称为典型中国商标 (如 Xiaomi, Baseus) | 数据库比对 | 50% |

### 5.2 最终技术方案
1.  **数据沉淀**：当 `collector.js` 执行日常任务或榜单抓取时，如果发现 `is_china_origin` 的标记，立即在数据库中打标。
2.  **卖家库**：建立 `app_china_sellers` 名录表，一旦识别为中国卖家，该卖家下的所有 SKU 自动归入“中国专区”。

## 6. 后端 API 设计

### 6.1 获取中国专区列表
`GET /api/sourcing/china-zone`
- **Request Parameters**:
  - `strategy`: `all | dark_horse | high_growth`
  - `min_sales`: number (default 1)
- **Database Query Logic**:
```sql
SELECT b.*, s.reliability_score 
FROM app_top_lists b
JOIN app_china_sellers s ON b.seller_name = s.seller_name
WHERE b.monthly_sales >= :min_sales
ORDER BY b.monthly_sales DESC;
```

### 6.2 手动纠偏接口
`POST /api/sourcing/china-zone/verify`
- **Action**: 管理员手动标记某卖家为“非中国卖家”，防止误伤。

## 7. 数据模型变更

扩展现有的数据库架构：

```sql
-- 存储已识别的中国卖家
CREATE TABLE app_china_sellers (
    seller_name VARCHAR(255) PRIMARY KEY,
    identified_method VARCHAR(50), -- 'logistics_text' | 'name_match' | 'manual'
    is_confirmed BOOLEAN DEFAULT TRUE,
    total_listings INT,
    avg_delivery_days INT
);

-- 在榜单表中增加关联标记
ALTER TABLE app_top_lists ADD COLUMN is_china_origin BOOLEAN DEFAULT FALSE;
```

## 8. 前端改动 (Detailed)

### 8.1 侧边栏菜单逻辑
修改 `public/index.html` @ line 28 左右，在“榜单选品”下方新增：
```html
<a class="nav-subitem" data-route="sourcing/china" data-parent="sourcing">中国专区</a>
```

### 8.2 JavaScript 渲染与交互
在 `public/app.js` 中新增 `renderChinaZone(root)`：
- **特色逻辑**：在渲染表格时，调用 `get1688EstimatedPrice(ozonPrice)` 函数，根据类目常见的利润结构模型，预估一个 1688 采购价范围，供卖家参考。

## 9. 采集端改动 (Collector Implementation)

在 `collector.js` 的详情页抓取逻辑 `scrapeOzonProduct` (Line 1141) 中加入：
```javascript
// 识别发货地
const deliveryText = await page.textContent('.delivery-info-text');
const isChina = deliveryText.includes('Китай') || deliveryText.includes('China');

// 识别卖家特征
const sellerName = await page.textContent('[data-widget="sellerInfo"] a');
const namePatterns = /Shenzhen|Guangzhou|Yiwu|Dongguan|Hangzhou|Trading|Co\.|Ltd|Technology/i;
const nameIsChina = namePatterns.test(sellerName);

return { is_china_origin: isChina || nameIsChina, sellerName };
```

## 10. 依赖与前置

1.  **榜单数据源**：本模块高度依赖 `06-top-list-selection.md` 的抓取结果作为池子。
2.  **1688 API 访问**：需要 `server.js` @ line 1916 的 1688 签名逻辑正常运行，用于获取实时 1688 价格建议。

## 11. 验收标准

1.  **准确性**：随机抽查 20 个“中国专区”商品，发货地确实为中国或卖家名具有明显中国特征。
2.  **筛选性能**：在 10,000 条数据级别下，页面加载时间 < 1.5s。
3.  **找货跳转**：点击“找货”后，系统能自动携带关键词或主图 URL 跳转至 1688 采集模块。

## 12. 反爬风险与合规

### 12.1 应对策略
- **低频补全**：中国卖家的识别只需进行一次。一旦卖家入库，其下属商品通过 SKU ID 关联即可，无需每次都进详情页，降低抓取频次。
- **隐私合规**：仅展示 Ozon 平台公开的卖家代号或名称。

## 13. 工作量估算

| 阶段 | 任务 | 耗时 (人日) |
|---|---|---|
| 设计 | 识别算法模型设计 | 0.5 |
| 后端 | 卖家特征库维护与 API 逻辑 | 1.0 |
| 前端 | 中国专区页面渲染与对标逻辑 | 1.0 |
| 采集 | 采集器发货地识别代码逻辑 | 1.0 |
| 联调 | 数据清洗与准确度校准 | 0.5 |
| **总计** | | **4.0** |

## 14. 风险与回滚

- **风险**：中国卖家故意使用拼音以外的俄文名称掩盖身份。
- **对策**：增加“发货时长”权重，跨境发货的时长是无法伪装的硬性特征。

## 16. 核心识别特征库 (Heuristics Library)

### 16.1 卖家名称正则过滤
在后端预置以下模式，用于初步判定中国卖家：
```javascript
const CHINA_NAME_PATTERNS = [
    /shenzhen/i, /guangzhou/i, /yiwu/i, /dongguan/i, /hangzhou/i,
    /shanghai/i, /beijing/i, /trading/i, /commerce/i, /co\./i, /ltd/i,
    /technology/i, /e-commerce/i, /pinyin/i, /huizhou/i, /foshan/i
];
```

### 16.2 利润倒算公式 (Cost Estimation)
前端列表显示的“利润率”预估算法：
- **公式**：`Profit = (OzonPrice * 0.85 - 1688Price - ShippingFee) / OzonPrice`
- **变量说明**：
  - `0.85`：假设平均佣金 + 提现成本为 15%。
  - `ShippingFee`：根据重量等级自动套用（如 500g 以下默认为 35 CNY）。

## 17. 详细实施路线图 (Implementation Phases)

### Phase 1: 基础设施 (Day 1)
- 修改 `collector.js`，在详情页抓取中增加 `delivery_info` 字段提取。
- 建立 `app_china_sellers` 数据库表。

### Phase 2: 后端聚合 (Day 2)
- 实现 `/api/sourcing/china-zone` 聚合 API。
- 编写每日定时脚本，从全平台榜单中筛选并打标中国卖家。

### Phase 3: 前端交互 (Day 3)
- 实现 `renderChinaZone` 页面。
- 添加“找货”跳转逻辑，对接 1688 自动比价模块。

### Phase 4: 校准与优化 (Day 4)
- 通过 MiniMax M3 对卖家名单进行一轮语义清洗，剔除误判的俄罗斯本地代购。

## 18. API 定义补充 (Edge Cases)

- **无 1688 对应价**：若该商品从未进行过 1688 找货，则显示“待匹配”，点击后触发实时找货。
- **卖家更名**：若卖家更改展示名，系统通过 Ozon `seller_id`（唯一标识）进行动态跟踪。

## 20. 识别算法深度说明

### 20.1 文本匹配加权逻辑
```javascript
function identifyChinaOrigin(sellerName, deliveryDays) {
    let score = 0;
    
    // 规则 1：地理名称匹配
    if (/Shenzhen|Yiwu|Guangzhou|Hangzhou|Foshan|Huizhou/i.test(sellerName)) score += 50;
    
    // 规则 2：公司形式匹配
    if (/Co\.,? Ltd|Trading|Technology|E-Commerce/i.test(sellerName)) score += 30;
    
    // 规则 3：物流时长判定
    if (deliveryDays >= 14) score += 40;
    if (deliveryDays >= 20) score += 60;
    
    // 阈值判定
    return score >= 80;
}
```

### 20.2 中国馆 (China Pavilion) 识别
- 部分 Ozon 商品属于官方“中国馆”项目。
- 采集端定位页面中的 `China Pavilion` (Китайский павильон) 标签。
- 命中此标签的商品优先级最高，赋予 `is_official_china = true` 属性。

## 21. 利润分析工具集成 (Cost Breakdown)

在“中国专区”列表中点击“利润分析”时，展示以下明细：
- **售价**: 1,200 ₽
- **扣款**:
  - 平台佣金 (12%): 144 ₽
  - 最后一公里费用: 80 ₽
  - 跨境物流 (500g): 300 ₽
- **采购成本**: 250 ₽ (约 35 CNY)
- **纯利**: 426 ₽ (约 35%)

## 22. UI/UX 详细设计说明

### 22.1 筛选面板扩展
- **卖家星级**: 仅显示评分 > 4.5 的优质中国卖家。
- **经营年限**: 筛选入驻 > 1 年的老店（代表货源稳定）。

### 22.2 商品卡片细节
- 鼠标悬停在“卖家名称”上，显示该卖家的 **主营类目百分比**。
- 支持一键导出当前页的中国卖家 SKU 列表为 Excel。

## 23. 数据一致性与维护

- **黑名单同步**：若某个卖家被识别为“土耳其卖家”或“本土一件代发”，将其加入 `app_seller_blacklist`，防止污染中国专区。
- **每日巡检**：每 24 小时重新核对一次 Top 10 卖家的发货地文字，防止卖家更改物流策略。

## 24. 验收标准补充

1.  **UI 响应**：点击“中国专区”路由，侧边栏应高亮，面包屑显示为 `选品 / 中国专区`。
2.  **数据有效性**：列表内不应出现发货地为“Россия” (俄罗斯) 的商品。
3.  **找货联动**：点击“找货”后，应能自动打开 1688 预览窗口。



---
*Document Version: 1.0*
*Last Edited: 2026-07-02*
