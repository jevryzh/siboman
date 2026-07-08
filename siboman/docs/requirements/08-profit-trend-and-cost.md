# 08-profit-trend-and-cost · 利润趋势与成本拆解需求文档

> 归属模块：财务统计 ｜ 优先级：P0 ｜ 预估工作量：8 人日 ｜ 状态：待评审
> 版本：v2.0 (详尽版)

## 1. 背景

目前逐梦 ERP 已实现基础的订单抓取（`server.js:582`）和仪表盘概览（`server.js:539`），但商家对于“纯利润”的把控仅停留在感性认知阶段。跨境电商业务受 RUB/CNY 汇率大幅波动、Ozon 动态佣金率、跨境物流多段计费（头程+干线+末端）的影响，极易出现“订单不断，口袋没钱”的情况。

本项目旨在构建一套精细化的财务核算体系，对标 MyERP（`docs/myerp-reference/16-profit-trends.png`），将散落在 1688 采购端、Ozon 平台端、物流服务商端的离散数据进行聚合，为卖家提供单品级、订单级、店铺级的全维度利润看板。

### 1.1 变更记录

| 版本 | 日期 | 变更内容 | 变更人 |
| :--- | :--- | :--- | :--- |
| v1.0 | 2026-06-30 | 初始草案 | Eason |
| v2.1 | 2026-07-02 | 深入细化 DDL、API 错误码、前端交互逻辑及 AC 准则 | Codex |

---

## 2. 目标与非目标

### 2.1 目标
- **精准核算**：基于单笔订单的到账金额，扣除采购、运费、佣金、损耗，计算单笔毛利。
- **趋势分析**：通过 Chart.js 展示利润额、毛利率随时间的波动趋势。
- **货源关联**：自动关联 1688 采集时的成本价，支持手动校准。
- **汇率自动化**：实现 RUB -> CNY 的动态折算，支持多种取价策略。
- **预警机制**：自动标记亏损订单及低毛利（<5%）商品。
- **数据导出**：支持导出含所有成本拆解字段的完整财务报表。
- **多维度筛选**：支持按 SKU、类目、物流渠道筛选利润情况。

### 2.2 非目标
- **对账单核对**：不与银行流水进行自动对账，以 Ozon 结算单为准。
- **税务处理**：暂不处理复杂的 VAT 抵扣逻辑，统一按 Ozon 最终到账净额（Net Amount）计算。
- **多币种并行**：目前仅支持结算为 CNY 的统计。
- **非 Ozon 平台**：本模块暂不处理 WB、Amazon 等其他平台的利润统计。

---

## 3. 用户故事

| ID | 用户角色 | 需求场景 (Given/When) | 期望结果 (Then) | 关联 AC |
| :--- | :--- | :--- | :--- | :--- |
| US.01 | 店主 | 当我想了解本月赚了多少钱时 | 系统能展示扣除所有成本后的净利润和利润率趋势 | AC.01, AC.02 |
| US.02 | 运营 | 当订单状态变为“已妥投”后 | 系统自动折算 RUB 到 CNY，并展示详细的佣金扣减明细 | AC.03, AC.04 |
| US.03 | 采购 | 当 1688 采购价发生变动时 | 我能在系统中更新 SKU 成本，并自动回溯计算未结算订单的利润 | AC.05, AC.06 |
| US.04 | 运营 | 当我想知道为什么某笔订单亏损时 | 系统能列出采购价、重量分摊的头程费、平台履约费的占比 | AC.07 |
| US.05 | 决策者 | 当汇率从 0.08 跌到 0.07 时 | 系统能实时更新预估利润，提醒我调整 Ozon 售价 | AC.08, AC.14 |
| US.06 | 财务 | 当需要进行月度核算时 | 我能一键导出包含所有物流、平台费明细的 Excel 表格 | AC.09, AC.10 |
| US.07 | 店主 | 当某款商品持续亏损时 | 系统在仪表盘显著位置弹出红色告警，建议下架或调价 | AC.11, AC.15 |

---

---

## 3. 用户故事

| ID | 用户角色 | 需求场景 (Given/When) | 期望结果 (Then) | 关联 AC |
| :--- | :--- | :--- | :--- | :--- |
| US.01 | 店主 | 当我想了解本月赚了多少钱时 | 系统能展示扣除所有成本后的净利润和利润率趋势 | AC.01, AC.02 |
| US.02 | 运营 | 当订单状态变为“已妥投”后 | 系统自动折算 RUB 到 CNY，并展示详细的佣金扣减明细 | AC.03, AC.04 |
| US.03 | 采购 | 当 1688 采购价发生变动时 | 我能在系统中更新 SKU 成本，并自动回溯计算未结算订单的利润 | AC.05, AC.06 |
| US.04 | 运营 | 当我想知道为什么某笔订单亏损时 | 系统能列出采购价、重量分摊的头程费、平台履约费的占比 | AC.07 |
| US.05 | 决策者 | 当汇率从 0.08 跌到 0.07 时 | 系统能实时更新预估利润，提醒我调整 Ozon 售价 | AC.08 |

---

## 4. 界面草图 (ASCII Sketch)

```text
+---------------------------------------------------------------------------------------+
| [财务] / 利润趋势分析                                                 [ 币种: ¥ ] [ 30天 ] |
+---------------------------------------------------------------------------------------+
| +----------------+ +----------------+ +----------------+ +----------------+          |
| |    总毛利润     | |    平均毛利率   | |    总运营支出   | |    客单价(CNY)  |          |
| |  ¥ 45,280.00   | |     18.5%      | |  ¥ 182,500.00  | |    ¥ 124.50    |          |
| |  ↑ 12% (环比)   | |  ↓ 1.2% (环比)  | |  ↑ 5.4% (环比)  | |  - 0.5% (环比)  |          |
| +----------------+ +----------------+ +----------------+ +----------------+          |
+---------------------------------------------------------------------------------------+
|  利润趋势 (Chart.js Line Chart)                                                        |
|  [ 75 ]  *                                                                            |
|  [ 50 ]     *       *       *                                                         |
|  [ 25 ]        *  *    *  *   *                                                       |
|  [ 00 ]  +---+---+---+---+---+---+---+                                               |
|          06-25   06-27   06-29   07-01                                                |
+---------------------------------------------------------------------------------------+
|  订单明细表                                                               [ 导出 Excel ] |
+---------------------------------------------------------------------------------------+
| Ozon订单号 | 售价(RUB) | 售价(CNY) | 采购成本 | 平台费 | 国际运费 | 净利润 | 毛利率 | 状态 |
| 765432101  | 1,200    | 96.00     | 35.00   | 12.00  | 24.50   | 24.50  | 25.5% | 已妥投 |
| 765432102  | 550      | 44.00     | 28.00   | 5.50   | 18.00   | -7.50  | -17%  | [亏损] |
| ...        | ...      | ...       | ...     | ...    | ...     | ...    | ...   | ...   |
+---------------------------------------------------------------------------------------+
```

---

## 5. 核心算法与业务逻辑

### 5.1 成本拆解算法

单笔订单的核算必须精确到 SKU 级，单位统一折算为 **CNY**。

**核心公式：**
$$ 单笔订单毛利 (CNY) = R - (C_{sourcing} + F_{dom} + F_{intl} + F_{plat} + L_{loss} + T_{tax}) $$

**字段定义与来源：**

1.  **到账金额 (R)**:
    - 定义：Ozon 结算给卖家的最终 RUB 金额折算为 CNY。
    - 来源：`callOzonSellerAPI("/v3/posting/fbs/list")` 里的 `financial_data.products.price` 累计，再通过 `exchange_rate` 折算。
2.  **采购成本 (Csourcing)**:
    - 定义：商品的 1688 实际采购价格。
    - 来源：关联 `app_jobs` 中 payload 的 `price_cny`。若不存在，则取 `app_product_costs` 表中的 `default_sourcing_price`。
3.  **1688 国内运费 (Fdom)**:
    - 定义：1688 卖家发往中国仓的费用。
    - 来源：通常按订单平摊，或设为固定值（如 0）。
4.  **头程/国际运费 (Fintl)**:
    - 计算：`订单重量 (kg) * 用户配置的国际物流单价 (元/kg)`。
    - 来源：重量从 Ozon API 获取；单价在 ERP 设置页录入（如 45 元/kg）。
5.  **平台佣金及履约费 (Fplat)**:
    - 定义：包含类目佣金、FBS 包裹处理费、配送费、最后一公里费。
    - 来源：Ozon API `financial_data.cluster_fulfillment` 等明细。
6.  **退货损耗摊销 (Lloss)**:
    - 计算：`单件综合成本 * SKU历史退货率`（默认 5%）。
7.  **税费 (Ttax)**:
    - 默认 0，若为跨国贸易需包含关税。

### 5.2 汇率数据源方案评估

| 方案 | 描述 | 优点 | 缺点 | 推荐度 |
| :--- | :--- | :--- | :--- | :--- |
| A. 手动录入 | 每日由管理员在后台录入今日汇率 | 100% 准确，可控 | 费人工，不能实时反映波动 | ⭐⭐ |
| B. Ozon 反推 | 利用 Ozon 结算单中的 `payout` / `revenue` 比例计算 | 最符合实际到账情况 | 结算有 15 天滞后，无法计算当日预估 | ⭐⭐⭐ |
| C. 第三方 API | 调用 `exchangerate-api.com` 实时接口 | 自动化，数据新 | 可能存在接口费用，与实际结算汇率有偏差 | ⭐⭐⭐⭐ |
| **D. 组合策略** | 默认用 API 抓取；当结算单下发时，用结算汇率修正 | 兼顾预估实时性与核算准确性 | 实现逻辑较复杂 | **推荐** |

### 5.3 单元测试用例

#### 用例 1：标准盈利订单
- **输入**：售价 1000 RUB，重量 0.5kg，采购价 30 CNY，汇率 0.08，平台费 150 RUB，运费单价 40元/kg。
- **计算过程**：
    - 收入 = 1000 * 0.08 = 80 CNY
    - 平台费 = 150 * 0.08 = 12 CNY
    - 国际运费 = 0.5 * 40 = 20 CNY
    - 毛利 = 80 - 30 - 12 - 20 = 18 CNY
- **预期结果**：利润 18.00，利润率 22.5%。

#### 用例 2：退款订单（负利润）
- **输入**：状态为 `cancelled` 或 `returned`。
- **计算过程**：
    - 收入 = 0 CNY
    - 损失 = 采购成本 + 发货运费（无法退回部分）。
- **预期结果**：利润为负值（如 -50.00）。

---

## 6. 后端 API 设计

### 6.1 GET /api/finance/profit-stats
**功能**：获取利润趋势图表数据。
**Query Params**: `range=30` (天数), `shop_id=1`
**Response JSON**:
```json
{
  "success": true,
  "summary": {
    "total_profit": 45280.50,
    "avg_margin": 0.185,
    "total_revenue": 245000.00,
    "total_cost": 199719.50,
    "profit_growth": 0.12,
    "order_count": 1250,
    "loss_order_count": 12
  },
  "chart": [
    { 
      "date": "2026-06-01", 
      "profit": 1200.5, 
      "revenue": 8000.0, 
      "orders": 45,
      "costs": {
        "sourcing": 3500.0,
        "logistics": 2100.0,
        "platform": 1200.0
      }
    },
    { "date": "2026-06-02", "profit": 1350.2, "revenue": 8500.0, "orders": 48 }
  ]
}
```

### 6.2 POST /api/finance/orders/list
**功能**：带成本明细的订单列表（支持分页与高级筛选）。
**Request Body**:
```json
{
  "filter": {
    "status": ["delivered", "shipped"],
    "date_range": ["2026-06-01", "2026-06-30"],
    "min_margin": -1.0,
    "max_margin": 1.0,
    "search": "765432101"
  },
  "pagination": {
    "page": 1,
    "limit": 50
  },
  "sort": {
    "field": "profit",
    "order": "desc"
  }
}
```
**Response JSON**:
```json
{
  "success": true,
  "data": [
    {
      "order_id": "765432101",
      "ozon_status": "delivered",
      "order_date": "2026-06-25T14:30:00Z",
      "currency": "RUB",
      "price_rub": 1200.00,
      "price_cny": 96.00,
      "exchange_rate": 0.08,
      "sku_info": {
        "offer_id": "SKU-PRO-001",
        "name": "多功能蓝牙耳机",
        "weight_kg": 0.35
      },
      "costs": {
        "sourcing": 35.00,
        "logistics_intl": 15.75,
        "logistics_dom": 2.00,
        "platform_commission": 9.60,
        "platform_fulfillment": 4.50,
        "ad_spend": 1.20,
        "refund_provision": 1.75
      },
      "profit": 25.45,
      "margin": 0.2651,
      "is_estimated": false
    }
  ],
  "total": 1250,
  "pages": 25
}
```

### 6.3 POST /api/finance/costs/batch-update
**功能**：批量更新 SKU 采购价或重量。
**Request Body**:
```json
{
  "items": [
    { "offer_id": "SKU-PRO-001", "sourcing_price": 32.50, "weight": 0.34 },
    { "offer_id": "SKU-PRO-002", "sourcing_price": 115.00 }
  ]
}
```

---

## 7. 数据模型变更

### 7.1 PostgreSQL DDL (详尽版)

```sql
-- 1. 存储商品维度的基准成本（带历史审计能力）
CREATE TABLE app_product_costs (
    offer_id VARCHAR(100) PRIMARY KEY,
    product_id BIGINT,
    sourcing_price_cny NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    weight_kg NUMERIC(10, 3) NOT NULL DEFAULT 0.000,
    category_id VARCHAR(50),
    category_commission_rate NUMERIC(5, 4) DEFAULT 0.1000, -- 默认 10%
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT check_positive_price CHECK (sourcing_price_cny >= 0),
    CONSTRAINT check_positive_weight CHECK (weight_kg >= 0)
);

-- 2. 存储单笔订单的核算快照
CREATE TABLE app_order_profit_records (
    order_id VARCHAR(50) PRIMARY KEY,        -- Ozon posting_number
    user_id UUID REFERENCES app_users(id),  -- 关联所属用户
    order_date TIMESTAMP WITH TIME ZONE NOT NULL,
    status VARCHAR(20) NOT NULL,            -- ozon 订单状态
    
    -- 收入项
    price_rub NUMERIC(12, 2) NOT NULL,
    exchange_rate NUMERIC(10, 6) NOT NULL,
    revenue_cny NUMERIC(12, 2) NOT NULL,
    
    -- 成本项拆解
    cost_sourcing NUMERIC(12, 2) DEFAULT 0.00,
    cost_logistics_intl NUMERIC(12, 2) DEFAULT 0.00,
    cost_logistics_dom NUMERIC(12, 2) DEFAULT 0.00,
    cost_platform_commission NUMERIC(12, 2) DEFAULT 0.00,
    cost_platform_fulfillment NUMERIC(12, 2) DEFAULT 0.00,
    cost_ad_spend NUMERIC(12, 2) DEFAULT 0.00,
    cost_other NUMERIC(12, 2) DEFAULT 0.00,
    
    -- 结果项
    profit_cny NUMERIC(12, 2) NOT NULL,
    margin_rate NUMERIC(8, 4) NOT NULL,
    
    -- 状态标识
    is_finalized BOOLEAN DEFAULT FALSE,     -- 最终财务结算是否完成
    data_version INTEGER DEFAULT 1,         -- 数据版本，用于逻辑更新后重算
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. 索引优化 (覆盖高频查询)
CREATE INDEX idx_profit_user_date ON app_order_profit_records(user_id, order_date DESC);
CREATE INDEX idx_profit_status ON app_order_profit_records(status);
CREATE INDEX idx_profit_margin ON app_order_profit_records(margin_rate) WHERE margin_rate < 0.05;

-- 4. 汇率历史表
CREATE TABLE app_exchange_rates (
    id SERIAL PRIMARY KEY,
    pair VARCHAR(10) DEFAULT 'RUB_CNY',
    rate NUMERIC(12, 8) NOT NULL,
    source VARCHAR(20), -- 'api', 'manual', 'ozon_invoice'
    record_date DATE UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. 成本变更审计表
CREATE TABLE app_product_cost_audit (
    id SERIAL PRIMARY KEY,
    offer_id VARCHAR(100),
    old_price NUMERIC(12, 2),
    new_price NUMERIC(12, 2),
    changed_by UUID,
    changed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

### 7.2 迁移与回滚
- **迁移逻辑**：执行上述 SQL 后，需运行一个迁移脚本，从 `app_jobs` 的历史记录中追溯近 30 天的订单并初始化 `app_order_profit_records`。
- **回滚逻辑**：`DROP TABLE app_order_profit_records; DROP TABLE app_product_costs; DROP TABLE app_exchange_rates;`

---

## 8. 前端改动

### 8.1 JS 伪代码：利润计算器逻辑
```javascript
/**
 * 前端实时估算利润逻辑
 * 用于在商品列表或详情页预览
 */
function calculateEstimatedProfit(priceRub, weight, sourcingCost, rate, logisticsUnitPrice = 45) {
    const revenueCny = priceRub * rate;
    const platformFee = revenueCny * 0.12; // 估算 12% 综合费率
    const logisticsCost = weight * logisticsUnitPrice;
    const profit = revenueCny - sourcingCost - platformFee - logisticsCost;
    const margin = profit / revenueCny;
    
    return {
        profit: profit.toFixed(2),
        margin: (margin * 100).toFixed(1) + '%',
        isLoss: profit < 0
    };
}
```

### 8.2 Chart.js 集成逻辑
```javascript
function initProfitChart(ctx, data) {
    return new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map(i => i.date),
            datasets: [{
                label: '每日净利润 (CNY)',
                data: data.map(i => i.profit),
                borderColor: '#2ecc71',
                backgroundColor: 'rgba(46, 204, 113, 0.1)',
                fill: true,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: { beginAtZero: true, grid: { color: '#2c2c2c' } },
                x: { grid: { display: false } }
            }
        }
    });
}
```

## 9. 核心实现方案 (Technical Implementation)

### 9.1 异步核算引擎架构
为了保证订单列表的响应速度，核算引擎采取“双速”模式：
1. **快路径 (Real-time Estimation)**：当订单进入系统时，利用 `app_product_costs` 的历史平均值进行实时预估。
2. **慢路径 (Accurate Calibration)**：每 12 小时跑一次 Worker，调用 Ozon `finance/realization` 接口，用真实的平台扣费对 `app_order_profit_records` 进行覆盖修正。

### 9.2 关键代码逻辑 (Node.js)

```javascript
/**
 * 核心核算函数 (Server-side)
 */
async function syncOrderProfit(orderId) {
  const order = await ozon.getOrderDetail(orderId);
  const sourcing = await db.query('SELECT * FROM app_product_costs WHERE offer_id = $1', [order.offer_id]);
  const exchangeRate = await getExchangeRate(order.date);
  
  // 1. 计算收入
  const revenueRub = order.financial_data.products.reduce((acc, p) => acc + p.price, 0);
  const revenueCny = revenueRub * exchangeRate;
  
  // 2. 计算平台费 (Ozon 接口明细)
  const platformFeeRub = order.financial_data.products.reduce((acc, p) => {
    return acc + p.commission_amount + p.payout; // 简化逻辑
  }, 0);
  const platformFeeCny = platformFeeRub * exchangeRate;
  
  // 3. 计算物流费 (基于重量)
  const weight = order.financial_data.products.reduce((acc, p) => acc + (p.weight || 0.5), 0);
  const logisticsCny = weight * config.intlLogisticsUnitPrice;
  
  // 4. 持久化
  await db.query(`
    INSERT INTO app_order_profit_records (...)
    VALUES (...)
    ON CONFLICT (order_id) DO UPDATE SET ...
  `);
}
```

### 9.3 任务调度配置
```json
{
  "cron": "0 2 * * *",
  "name": "daily-profit-calibration",
  "description": "每日凌晨2点追溯前15天已妥投订单的真实利润"
}
```

## 10. 详细实施路径 (Implementation Roadmap)

### 10.1 第一阶段：基础底座建设 (Day 1-2)
1. **数据库初始化**：执行 `7.1` 中的 DDL，建立核心利润表与审计表。
2. **汇率服务**：在 `server.js` 中增加 `syncExchangeRate` 定时任务，每 24 小时抓取一次。
3. **成本迁移**：编写脚本遍历 `app_jobs`，提取 `price_cny` 字段并回填到 `app_product_costs`。

### 10.2 第二阶段：核算引擎开发 (Day 3-5)
1. **算法实现**：封装 `ProfitEngine` 类，支持 `estimate()` (预估模式) 和 `calibrate()` (修正模式)。
2. **Ozon 财务对接**：调通 `/v1/finance/realization` 接口，解决分页与 Token 过期重试逻辑。
3. **异常处理**：处理订单拆包、退货、部分退款等特殊场景下的利润计算逻辑。

### 10.3 第三阶段：前端看板与报表 (Day 6-8)
1. **指标卡片**：在 `renderDashboard` 中增加利润相关的实时卡片。
2. **趋势图**：集成 Chart.js，实现利润与 GMV 的双轴对比图。
3. **明细表**：开发可折叠的订单明细行，点击展示详细的成本构成（饼图或进度条）。
4. **导出工具**：优化 `writeXlsxWithEmbeddedImages`，支持导出带公式的财务明细 Excel。

## 11. 利润核算场景详解 (Edge Cases)

### 场景 01：一单多件且重量不均
- **描述**：订单包含 1 个 2kg 的加湿器和 1 个 0.1kg 的香囊。
- **算法**：国际运费按 `(Item_Weight / Total_Weight) * Total_Logistics_Cost` 进行加权平摊，避免轻小件被过度计费。

### 场景 02：Ozon 部分退款
- **描述**：买家因质量问题申请退款 200 RUB，但保留商品。
- **算法**：该笔订单的 `revenue_cny` 需扣除退款部分的折算金额，并在 `cost_other` 记录损失。

### 场景 03：汇率剧烈波动（T-Day vs Payout-Day）
- **描述**：下单时 1 RUB = 0.08 CNY，结算时 1 RUB = 0.075 CNY。
- **算法**：下单时记录“预估利润”；结算后通过修正 Worker 将 `exchange_rate` 更新为结算汇率，并更新 `is_finalized` 状态。

### 场景 04：1688 运费摊销
- **描述**：采购 10 个 SKU 共产生 10 元国内运费。
- **算法**：单件分摊 1 元成本。需在录入采购成本时支持“运费”字段。

### 场景 05：广告费（Ads）扣减
- **描述**：某 SKU 开启了 Ozon 点击付费广告。
- **算法**：从 `v1/analytics/ads` 获取费用，按订单归因到 `cost_ad_spend` 字段。

## 12. 验收标准 (AC)

1.  **[AC.01] 概览准确性**：
    - **Given**: 店铺有 100 笔已妥投订单。
    - **When**: 在仪表盘查看总毛利。
    - **Then**: 显示的金额必须与单笔明细手动加和的结果一致，误差范围控制在 0.01 元以内。

2.  **[AC.02] 趋势图渲染**：
    - **Given**: 过去 30 天每天均有订单。
    - **When**: 渲染趋势折线图。
    - **Then**: 折线应平滑连接，且鼠标悬停时能精确显示当日利润（CNY）。

3.  **[AC.03] 汇率自动化**：
    - **Given**: 每日凌晨 02:00。
    - **When**: 系统执行汇率抓取任务。
    - **Then**: `app_exchange_rates` 表中应新增一条记录，且该汇率立即生效于后续新订单。

4.  **[AC.04] 亏损订单高亮**：
    - **Given**: 某笔订单毛利为 -15.5 元。
    - **When**: 在明细表中展示。
    - **Then**: 该行背景色应为浅红色，且在利润率列显示醒目的 [亏损] 标识。

5.  **[AC.05] 成本回溯**：
    - **Given**: 修改了 SKU-A 的采购价从 20 调至 25 元。
    - **When**: 点击“保存并更新相关订单”。
    - **Then**: 所有状态为 `awaiting_deliver` 的订单利润应自动重算并更新。

6.  **[AC.06] 导出完整性**：
    - **Given**: 点击“导出财务明细”。
    - **When**: 生成 Excel 文件。
    - **Then**: 包含物流、佣金、采购、汇率等 15 个以上核心核算列，且格式正确。

7.  **[AC.07] 权限控制**：
    - **Given**: 用户角色为“初级运营”。
    - **When**: 访问财务页面。
    - **Then**: 利润的具体金额字段应被掩码或隐藏，仅展示利润率范围。

8.  **[AC.08] Ozon 明细修正**：
    - **Given**: Ozon 结算单下发（Billing data available）。
    - **When**: 修正 Worker 运行。
    - **Then**: 订单的 `is_finalized` 字段变为 `true`，且平台费用的各分项（配送、仓储）被精确覆盖。

9.  **[AC.09] 异常状态处理**：
    - **Given**: 订单状态为 `cancelled`。
    - **When**: 计算利润。
    - **Then**: 利润应计算为负值（已产生的国内段成本），利润率为 -100%。

10. **[AC.10] 性能表现**：
    - **Given**: 数据库中有 50,000 条订单记录。
    - **When**: 搜索某 SKU 近半年的利润表现。
    - **Then**: 结果返回时间应在 1 秒以内。

11. **[AC.11] 空值引导**：
    - **Given**: 新采集的商品尚未录入采购价。
    - **When**: 订单列表展示该商品订单。
    - **Then**: 利润列显示“待录入”，点击可弹出快速编辑窗口。

12. **[AC.12] 响应式布局**：
    - **Given**: 使用 13 寸笔记本浏览器访问。
    - **When**: 调整窗口大小。
    - **Then**: 财务表格不应发生布局错乱，核心列必须可见。

13. **[AC.13] 汇率异常兜底**：
    - **Given**: 第三方汇率 API 挂掉。
    - **When**: 系统尝试更新。
    - **Then**: 必须自动回退使用 `app_exchange_rates` 中最新的一条记录，并给系统日志记入 Error。

14. **[AC.14] 利润率告警**：
    - **Given**: 某订单利润率低于 5%。
    - **When**: 列表渲染。
    - **Then**: 利润率数值显示为黄色，提示“利润风险”。

15. **[AC.15] 审计日志**：
    - **Given**: 手动修改了某笔订单的物流成本。
    - **When**: 保存后。
    - **Then**: `app_product_cost_audit` 中必须产生一条含“修改前、修改后、操作人”的记录。

## 13. API 错误码定义 (Error Codes)

| 错误码 | 描述 | 处理建议 |
| :--- | :--- | :--- |
| `ERR_FIN_001` | 汇率 API 调用上限 | 等待 1 小时或更换 API Key |
| `ERR_FIN_002` | Ozon 结算数据未生成 | 订单状态尚未达到结算周期，请等待 15 日 |
| `ERR_FIN_003` | 采购价未设置 | 请前往商品中心录入该 SKU 的 1688 采购成本 |
| `ERR_FIN_004` | 结算单金额严重偏差 | 触发人工核查，可能是佣金率配置错误 |
| `ERR_FIN_005` | 数据库并发锁冲突 | 重试写入利润快照 |

---

---

## 9. 依赖与前置

1.  **权限**：需要 Ozon Seller API 的财务权限（通常是 `Client-Id` 和 `Api-Key` 必须有财务操作角色）。
2.  **数据**：
    - 依赖 `server.js:582` 提供基础订单流。
    - 依赖 `server.js:464` `callOzonSellerAPI` 能够调用 `/v1/finance/realization` 接口获取结算明细。
3.  **库**：引入 `Chart.min.js` (cdn.jsdelivr.net)。

---

## 10. 验收标准

1.  [ ] **利润概览准确性**：仪表盘核心指标（总利润、利润率）必须与单笔订单明细汇总一致，误差 < 0.01%。
2.  [ ] **趋势图交互**：鼠标悬停在折线图上时，需弹出 Tooltip 显示该日期的具体利润、订单数及核心成本占比。
3.  [ ] **亏损识别**：利润率为负的订单在列表中必须显示为背景色浅红（#fff5f5），且带有 [亏损] 标签。
4.  [ ] **低毛利预警**：利润率在 0% ~ 5% 之间的商品，需显示黄色警告图标，提示“毛利过低，建议调价”。
5.  [ ] **汇率刷新机制**：每日 02:00 自动抓取中国银行 RUB/CNY 中间价，若抓取失败则沿用前一日数据并向管理员发送告警。
6.  [ ] **成本追溯逻辑**：手动修改 SKU 采购价后，系统需弹窗询问“是否重新计算该 SKU 下所有‘未结算’状态订单的利润？”
7.  [ ] **导出功能验证**：导出的 Excel 文件必须包含 `posting_number`, `sku`, `price_cny`, `sourcing_cost`, `logistics_cost`, `commission`, `fulfillment`, `net_profit`, `margin` 等 15+ 核心字段。
8.  [ ] **性能基准**：查询过去 90 天的利润统计（数据量 ~10,000 笔），后端响应时间必须 < 500ms。
9.  [ ] **数据同步逻辑**：每当 Ozon 订单状态更新为 `delivered` 时，必须立即触发该订单的二次利润核算（使用最新的平台明细费用）。
10. [ ] **空值处理**：对于未匹配到 1688 货源的订单，成本项应显示为“待录入”，且在该行操作列增加“录入成本”快捷按钮。
11. [ ] **权限控制**：只有具备 `ADMIN` 或 `FINANCE` 权限的用户可见利润金额，普通 `OPERATOR` 仅可见利润率百分比或隐藏。
12. [ ] **多件订单核算**：验证一个订单内含多个不同单价 SKU 的情况，运费分摊必须按重量比例精确计算。
13. [ ] **退款逻辑验证**：订单被取消后，利润必须更新为“负（已产生的物流费+采购损耗）”，不能直接清零。
14. [ ] **响应式测试**：在 13 吋笔记本（1280x800）分辨率下，明细表应支持水平滚动，且“操作”列冻结在右侧。
15. [ ] **错误处理**：当第三方汇率 API 挂掉时，系统能无缝切换到本地缓存的最后一次有效汇率。

---

## 11. 工作量估算 (详细拆解)

| 子任务 | 描述 | 工期 (人日) |
| :--- | :--- | :--- |
| **P1-1: DB Schema** | 设计并创建 `app_order_profit_records`, `app_product_costs`, `app_exchange_rates` 表及索引 | 0.5 |
| **P1-2: Data Migration** | 编写 Node.js 脚本，从历史 `app_jobs` 提取成本并初始化利润表 | 1.0 |
| **P2-1: Exchange Rate Task** | 实现定时任务调用第三方 API 抓取汇率，含异常重试逻辑 | 0.5 |
| **P2-2: Ozon Finance API** | 对接 Ozon `/v1/finance/realization` 接口，解析复杂的财务扣费明细 | 1.5 |
| **P3-1: Core Profit Engine** | 核心核算算法编写，处理 RUB->CNY 转换及各项成本分摊逻辑 | 1.5 |
| **P4-1: Analytics API** | 实现按时间、SKU、状态聚合统计的后端 RESTful 接口 | 1.0 |
| **P5-1: Dashboard Frontend** | 集成 Chart.js，实现利润趋势图及四个核心指标卡片 | 1.5 |
| **P5-2: Order Detail List** | 开发高级订单明细表，支持排序、筛选、亏损高亮、批量导出 | 1.5 |
| **P6-1: Settings & Config** | 开发后台汇率录入、国际物流单价配置、SKU 成本补录 UI | 1.0 |
| **P7-1: QA & Bugfix** | 单元测试、集成测试、各状态订单核算准确性验证 | 1.0 |
| **Total** | | **11.0** |

---

## 12. 风险与回滚

### 12.1 风险矩阵

| 风险描述 | 可能性 | 影响程度 | 对策 |
| :--- | :--- | :--- | :--- |
| Ozon 佣金政策突然调整 | 中 | 高 | 支持在后台按类目 ID 手动覆盖佣金率 |
| 采集端被封禁无法获取汇率 | 高 | 中 | 接入第三方付费汇率 API 兜底 |
| 历史订单数据量过大导致聚合卡顿 | 低 | 中 | 使用 Materialized View (物化视图) 进行预聚合 |
| 汇率波动剧烈导致预估严重偏离 | 中 | 高 | 在订单页增加“汇率波动预警”标识 |
| Ozon API 返回的财务明细为空 | 低 | 极高 | 实施基于售价的“启发式估算法”作为备份 |
| 1688 采购单价采集错误 | 中 | 中 | 允许用户在利润表单行手动覆盖（Overwrite）采购成本 |

---


## 11. 工作量估算

| 子任务 | 描述 | 工期 (人日) |
| :--- | :--- | :--- |
| **DB & Schema** | 设计并实现 3 张核心表及迁移脚本 | 1.0 |
| **Collector logic** | 抓取 Ozon 类目佣金率与结算汇率 | 1.5 |
| **Finance Engine** | 后端实现利润核算服务类，处理各种扣费逻辑 | 2.0 |
| **Dashboard UI** | 实现四个指标卡与折线图交互 | 1.5 |
| **Order Details** | 扩展订单列表，增加成本详情弹窗 | 1.0 |
| **Testing** | 汇率波动测试、极端大单测试、烟测 | 1.0 |
| **Total** | | **8.0** |

---

## 12. 风险与回滚

### 12.1 风险矩阵

| 风险描述 | 可能性 | 影响程度 | 对策 |
| :--- | :--- | :--- | :--- |
| Ozon 佣金政策突然调整 | 中 | 高 | 支持在后台按类目 ID 手动覆盖佣金率 |
| 采集端被封禁无法获取汇率 | 高 | 中 | 接入第三方付费汇率 API 兜底 |
| 历史订单数据量过大导致聚合卡顿 | 低 | 中 | 使用 Materialized View (物化视图) 进行预聚合 |
| 汇率波动剧烈导致预估严重偏离 | 中 | 高 | 在订单页增加“汇率波动预警”标识 |
| Ozon API 返回的财务明细为空 | 低 | 极高 | 实施基于售价的“启发式估算法”作为备份 |

### 12.2 回滚方案
- 如果新核算引擎上线导致数据异常，前端切换回“基础订单版”。
- 后端保留 `ozon_sourcing` 原始数据，通过 `created_at` 过滤重新跑迁移脚本。

---

## 13. 后续演进

- **广告费分摊**：对接 Ozon Advertising API，将广告点击费分摊到单 SKU 成本。
- **智能调价**：基于预设的目标毛利率（如 15%），自动计算并修改 Ozon 售价。
- **库存周转**：分析资金占用，计算 SKU 的 ROI (投资回报率)。

---
## 14. 数据库性能优化与架构细节

### 14.1 核心表分区策略
考虑到订单数据随时间的快速增长，对 `app_order_profit_records` 建议采用按月分区（Table Partitioning）：
```sql
CREATE TABLE app_order_profit_records (
    order_id VARCHAR(50) NOT NULL,
    order_date TIMESTAMP WITH TIME ZONE NOT NULL,
    -- 其他字段...
) PARTITION BY RANGE (order_date);

CREATE TABLE app_order_profit_2026_06 PARTITION OF app_order_profit_records
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
```

### 14.2 物化视图 (Materialized View)
为加速趋势图的聚合查询，建立预计算视图：
```sql
CREATE MATERIALIZED VIEW mv_daily_profit_summary AS
SELECT 
    date_trunc('day', order_date) as day,
    SUM(profit_cny) as total_profit,
    SUM(revenue_cny) as total_revenue,
    COUNT(order_id) as order_count
FROM app_order_profit_records
GROUP BY 1
WITH NO DATA;

-- 每日凌晨 03:00 刷新
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_profit_summary;
```

## 15. 安全与权限矩阵 (Permission Matrix)

| 功能模块 | OPERATOR (运营) | FINANCE (财务) | ADMIN (管理员) |
| :--- | :--- | :--- | :--- |
| 查看利润趋势图 | 仅限百分比 | 全权限 | 全权限 |
| 查看订单明细金额 | 隐藏 | 可见 | 可见 |
| 修改 SKU 采购价 | 仅限自己上传的 | 全权限 | 全权限 |
| 修改国际运费配置 | 无权限 | 无权限 | 全权限 |
| 导出财务报表 | 无权限 | 可导出 | 可导出 |
| 修正已结算订单 | 无权限 | 无权限 | 全权限 |

## 16. 用户操作手册 (User Manual)

### 16.1 如何录入初始成本
1. 进入“商品中心” -> “同步库存”。
2. 点击列表右侧的“编辑成本”图标。
3. 在弹出的窗口中输入该 SKU 的 1688 采购单价（人民币）和单件重量（kg）。
4. 点击“保存”，系统将自动触发未结算订单的利润重算。

### 16.2 如何查看亏损原因
1. 进入“财务统计” -> “利润趋势”。
2. 在底部的订单明细表中，点击红色高亮的“利润”数值。
3. 侧边栏将展开该订单的成本构成饼图。
4. 检查“平台费”或“运费”是否异常偏高（通常是因为重量填错）。

### 16.3 汇率异常处理流程
1. 若仪表盘顶部显示“汇率已过期 (Last Update: 2 days ago)”。
2. 点击旁边的“手动同步”按钮。
3. 若 API 持续失败，请点击“手动录入”，输入今日中间价并保存。

## 17. 接口性能基准 (Performance Benchmark)

| 场景 | 数据规模 | 期望延迟 | 压测工具 |
| :--- | :--- | :--- | :--- |
| 加载 30 天利润趋势 | 5,000 笔 | < 300ms | k6 / autocannon |
| 搜索指定 SKU 历史利润 | 50,000 笔 | < 500ms | Explain Analyze |
| 批量修正 1,000 笔订单利润 | 1,000 笔 | < 2s | Node.js Worker |
| 导出 10,000 行 Excel | 10,000 行 | < 5s | xlsx / fflate |

---
## 18. 前端界面详细逻辑 (Frontend Interaction Details)

### 18.1 筛选与排序逻辑
在 `renderFinanceDashboard` 中，所有表格列均应支持点击排序：
```javascript
function handleSort(column) {
    state.financeSort.field = column;
    state.financeSort.order = state.financeSort.order === 'asc' ? 'desc' : 'asc';
    renderFinanceTable();
}

// 内存排序逻辑示例
data.sort((a, b) => {
    const valA = a[state.financeSort.field];
    const valB = b[state.financeSort.field];
    return state.financeSort.order === 'asc' ? valA - valB : valB - valA;
});
```

### 18.2 利润详情弹窗组件
当点击利润数值时，弹出一个 `Modal` 或 `Drawer`：
```html
<div class="profit-drawer">
  <h3>订单成本拆解: #765432101</h3>
  <div class="summary-grid">
    <div class="row"><span>订单总额 (RUB)</span><span>1,200</span></div>
    <div class="row"><span>到账金额 (CNY)</span><span>96.00</span></div>
  </div>
  <hr/>
  <div class="costs-list">
    <div class="cost-item">
      <span>采购价格 (1688)</span>
      <span class="value">¥ 35.00</span>
      <div class="progress-bar"><div style="width: 36%"></div></div>
    </div>
    <div class="cost-item">
      <span>国际物流 (0.5kg)</span>
      <span class="value">¥ 22.50</span>
      <div class="progress-bar"><div style="width: 23%"></div></div>
    </div>
    <div class="cost-item">
      <span>Ozon 佣金 (12%)</span>
      <span class="value">¥ 11.52</span>
      <div class="progress-bar"><div style="width: 12%"></div></div>
    </div>
  </div>
  <div class="profit-footer">
    <span>净利润</span>
    <span class="profit-value positive">¥ 26.98</span>
  </div>
</div>
```

## 19. 异常数据处理策略 (Data Quality)

### 19.1 缺失重量处理
若 Ozon API 未返回包裹重量，核算引擎将按以下顺序获取：
1. `app_product_costs` 表中的 `weight_kg`。
2. 采集记录中的 AI 估算重量。
3. 若均无，则按类目平均重量（如 0.5kg）作为兜底，并在界面标记为“估算值”。

### 19.2 退款分摊逻辑
- **全额退款**：利润记录为 `- (采购价 + 运费)`，状态标记为 `REFUNDED`。
- **部分退款**：`revenue_cny` 按退款金额比例扣减，平台费按实际扣除后的金额重新计算。

### 19.3 汇率对冲与修正
- 下单日汇率 vs 结算日汇率的差额记录在 `exchange_diff` 字段，作为财务审计的参考。

## 20. 验收测试用例 (Detailed QA Cases)

### TC-FIN-01: 单个 SKU 成本更新联动
1. **Given**: 订单号 101, SKU-A, 采购价 20。
2. **When**: 在后台修改 SKU-A 采购价为 25 并保存。
3. **Then**: 访问利润明细，订单 101 的 `cost_sourcing` 应变为 25，且利润自动减少 5 元。

### TC-FIN-02: 大数据量下的趋势渲染
1. **Given**: 数据库模拟插入 50,000 条订单。
2. **When**: 点击切换时间跨度为“过去 180 天”。
3. **Then**: 页面加载遮罩出现时间 < 100ms，图表渲染时间 < 800ms。

### TC-FIN-03: 导出 Excel 中的公式验证
1. **Given**: 点击“导出财务明细”。
2. **When**: 打开 Excel。
3. **Then**: 利润列应为 `售价-成本` 的计算结果，而非死值（方便财务二次核算）。

### TC-FIN-04: 多币种汇率展示
1. **Given**: 卖家选择显示为 RUB。
2. **When**: 查看趋势图。
3. **Then**: 所有坐标轴数值应自动乘以 1（RUB），且单位显示为 ₽。

---
*文档版本：v2.3*
*编写日期：2026-07-02*
