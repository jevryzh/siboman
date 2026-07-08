# 06-top-list-selection · 榜单选品

> 归属模块：选品  ｜  优先级：P1  ｜  预估工作量：7 人日  ｜  状态：待评审

## 1. 背景

目前逐梦 ERP 在“选品 / 榜单选品”模块（`#/sourcing/bestsellers`）仅显示一个“Ozon 不开放”的占位符（`app.js` @ line 391）。而对标产品 MyERP 已提供全平台 Top 1000 实时榜单，并支持“一键跟卖”。

缺乏榜单数据使得本系统在“发现爆款”能力上大幅落后。现阶段卖家只能通过已上架类目进行被动分析。为了补齐核心竞争力，必须建立自有的全平台热销榜单库。

## 2. 目标与非目标

### 目标
- **实时榜单**：建立 Ozon 全平台 Top 1000 商品库，通过采集端自动化更新，保持 T+1 精度。
- **四大策略**：
  - **热销商品**：全平台总销量 Top。
  - **热销新品**：最近 30 天上架且销量前 100。
  - **潜力商品**：收藏量增长快但评论数不多的商品。
  - **蓝海商品**：月销量 > 500 但同款卖家数 < 5 的商品。
- **一键跟卖**：提供直接跳转 Ozon 原站的链接，以及“一键转采集任务”功能。
- **找货链路集成**：在榜单页直接调用 1688 找货接口。

### 非目标
- 不支持历史销量波动的秒级监控。
- 不提供竞争对手店铺的实时流水分析（属于竞店分析模块）。

## 3. 用户故事

1.  **小白选品**：作为一名新手卖家，我不知道卖什么，我想看“热销新品”榜单，找到那些刚刚爆发还没被大卖家统治的单品。
2.  **供应链挖掘**：我发现了一个蓝海商品，想立即在榜单上点“找货”，看看 1688 上是否有同款且利润空间是否足够（通过本系统的 1688 自动比价）。
3.  **快速铺货**：我想把榜单前 10 名全部勾选，一键加入采集队列，由 Mac 采集端后台自动抓取所有属性。

## 4. 界面草图 (Text Mockup)

```text
+---------------------------------------------------------------------------------------------------+
| [选品] / 榜单选品                                                             [全平台数据源]       |
+---------------------------------------------------------------------------------------------------+
| (分类筛选) [ 全部 ] [ 电子 ] [ 服饰 ] [ 家居 ] ...           (更新时间: 2026-07-02 02:00)          |
+---------------------------------------------------------------------------------------------------+
| (策略 Tabs)                                                                                      |
| [ 热销商品 ] [ 热销新品 ] [ 潜力商品 ] [ 蓝海商品 ]                                                 |
+---------------------------------------------------------------------------------------------------+
| # | 商品主图 | 标题                     | 价格   | 月销量 | 评论数 | 卖家数 | 机会判断 | 操作       |
|---|----------|--------------------------|--------|--------|--------|--------|----------|------------|
| 1 | [IMG]    | Portable Power Bank 20k  | 1,500₽ | 15,200 | 2,100  | 85     | 爆款稳定 | [采集][找货]|
| 2 | [IMG]    | RGB Desk Lamp (New)      | 2,400₽ | 2,100  | 45     | 3      | 蓝海新品 | [采集][找货]|
| 3 | [IMG]    | Wireless Mouse Case      | 450₽   | 800    | 12     | 1      | 极高潜力 | [采集][找货]|
+---------------------------------------------------------------------------------------------------+
```

## 5. 数据源方案评估 (Deep Dive)

针对 Ozon 数据封锁，评估以下方案：

### 5.1 方案对比

| 维度 | 方案 A：采集端抓取 | 方案 B：三方 CSV 导入 | 方案 C：内部数据降级 | 方案 D：付费接口 |
|---|---|---|---|---|
| **技术实现** | Playwright 模拟浏览抓取 | 手动导入第三方导出文件 | 基于已采类目 GMV 排序 | 接入 Mpstats API |
| **实时性** | 高（每日凌晨自动跑） | 低（人工操作） | 中 | 极高 |
| **成本** | 零（复用已有采集器） | 中 ($50-$100/mo) | 零 | 极高 (¥5000+/年) |
| **反爬风险** | 极高（需处理滑块） | 无 | 无 | 无 |
| **结论** | **主推（作为核心资产）** | **辅助（用于初期冷启动）** | **兜底（采集器失效时）** | 不推荐 |

### 5.2 推荐方案实施路径
1.  **推荐方案 (Plan A)**：在 `collector.js` 中增加 `ozon_top_list_scrape` 任务类型。
2.  **工作流**：
    - `server.js` 每天 02:00 下发一个 `SCRAPE_TOP_1000` 任务。
    - 采集端启动 Playwright，访问 `ozon.ru/highlight/` 及其子分类页。
    - 模拟瀑布流滚动，抓取前 20 页的所有商品 SKU、标题、价格、销量文字。
    - 回传数据，由 `server.js` 解析并将非重复数据入库。

## 6. 后端 API 设计

### 6.1 获取榜单数据
`GET /api/sourcing/bestsellers`
- **Params**:
  - `strategy`: `hot | new | potential | blue_ocean`
  - `category`: string (optional)
  - `limit`: number (default 50)
- **Response**:
```json
{
  "total": 1000,
  "items": [
    {
      "sku": "14829302",
      "title": "...",
      "price": 1500,
      "sales": 15000,
      "reviews": 2100,
      "sellers": 85,
      "tag": "stable_best_seller"
    }
  ]
}
```

### 6.2 触发一键找货
`POST /api/sourcing/bestsellers/:id/match`
- **Action**: 调用 `runBatchOzonJob` 对该单品进行深度画像并匹配 1688。

## 7. 数据模型变更

新建 `app_top_lists` 表：
```sql
CREATE TABLE app_top_lists (
    id SERIAL PRIMARY KEY,
    sku VARCHAR(50) UNIQUE NOT NULL,
    title TEXT,
    main_image TEXT,
    price_rub FLOAT,
    monthly_sales INT,
    review_count INT,
    seller_count INT,
    category_id VARCHAR(50),
    strategy_type VARCHAR(20), -- 'hot', 'new', etc
    ozon_url TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_top_list_strategy ON app_top_lists(strategy_type);
```

## 8. 前端改动 (Detailed)

### 8.1 路由占位符替换
修改 `public/app.js` @ line 391 的 `renderBestsellers` 函数。
- 移除：`root.innerHTML = 'Ozon 数据不开放...';`
- 替换为：复杂的表格布局，包含骨架屏展示逻辑。

### 8.2 跟卖按钮逻辑
- **逻辑**：点击“采集”，前端发送 `POST /api/jobs`，并将该商品 SKU 加入待抓取队列。
- **状态反馈**：按钮变更为“抓取中...”，任务完成后变更为“已转采集箱”。

## 9. 采集端逻辑实现 (Collector Implementation)

在 `collector.js` 中需要新增专门针对前台（非卖家中心）的解析脚本：
1.  **Anti-Headless**：在 `launchBrowser` 时禁用 `automationName`，开启真实模拟。
2.  **数据定位**：
    - 销量：查找类目页卡片底部的 `ordered_count` 文本（通常是“X+ купили”）。
    - 卖家数：需进入详情页查看“Все продавцы”链接。
3.  **断点续传**：支持按分类索引进行抓取，避免一次被封导致全量失败。

## 10. 依赖与前置

1.  **Cookie 持久化**：Mac 采集端需要定期通过手动操作 `ozon.ru` 并通过验证码，以保持会话 Cookie 依然有效。
2.  **代理服务**：需要高质量的动态住宅代理（如 Bright Data），专门用于绕过 DataDome。

## 11. 验收标准

1.  **数据规模**：系统内 `app_top_lists` 表单记录数 > 1000。
2.  **多选操作**：支持勾选 10 个以上商品并一键下发采集任务。
3.  **更新时效**：页面上显示的“最后更新时间”与当前日期差距 < 24 小时。
4.  **找货准确率**：一键找货后生成的 1688 候选项，前 3 名匹配度 > 80%。

## 12. 反爬风险与合规 (Critical)

### 12.1 风险点
- **IP 降级**：频繁抓取会导致 IP 进入黑名单，访问时直接返回 403。
- **验证码爆发**：Ozon 可能会突然要求所有匿名用户输入滑块验证码。

### 12.2 对抗方案 (server.js @ line 3815 延伸)
- **人工干预**：当 `detectHumanVerification` 触发且重试失败 3 次后，通过 Feishu/Webhook 推送告警，通知管理员在 Mac 上手动过一下滑块。
- **合规性**：不抓取任何具有 PII（个人身份信息）的数据，仅抓取公开的目录页商品信息。

## 13. 工作量估算

| 模块 | 任务 | 耗时 (人日) |
|---|---|---|
| 后端 | 榜单聚合 API 与数据清洗 | 2.0 |
| 前端 | 榜单页交互开发与找货集成 | 2.0 |
| 采集 | Playwright 前台抓取脚本编写 | 2.5 |
| 测试 | 极限反爬压力测试 | 0.5 |
| **总计** | | **7.0** |

## 14. 风险与回滚

- **回滚方案**：若全平台抓取被永久封禁，前端页面自动隐藏“全平台”选项，仅显示“店内已采类目热销榜”（退化方案 C）。

## 16. 详细算法与逻辑说明

### 16.1 策略定义算法
- **潜力商品 (Potential)**：
  - 条件：(`review_count` < 50) AND (`monthly_sales` > 200) AND (`rating` >= 4.5)。
  - 逻辑：代表商品本身素质好（评分高）且起量快，但竞争对手（评论数）还不算多。
- **蓝海商品 (Blue Ocean)**：
  - 条件：(`seller_count` < 5) AND (`monthly_sales` > 500)。
  - 逻辑：高需求、低竞争，是上架跟卖的最佳选择。

### 16.2 异常处理
- **数据项缺失**：若采集端无法获取某个商品的评论数（如被隐藏），默认填入 0，但不计入“潜力商品”判定。
- **重复 SKU 过滤**：在入库 `app_top_lists` 前，必须进行 `ON CONFLICT (sku) DO UPDATE` 操作，确保价格和销量是最新的。

## 17. 详细 API 错误码定义

| 错误码 | 描述 | 处理建议 |
|---|---|---|
| `4001` | 榜单数据尚未生成 | 提示用户“系统正在全网搜罗爆款，请 10 分钟后重试” |
| `4002` | 采集端连接断开 | 检查 Mac 采集器状态 |
| `4003` | 代理 IP 被封锁 | 系统自动切换备用代理池 |
| `4004` | Ozon SKU 已下架 | 将该条目从榜单中标记为 `inactive` |

## 18. 批处理任务整合 (Batch Job Integration)

在 `server.js` @ line 1195 `runBatchOzonJob` 中增加对榜单来源的支持：
- 当 `options.source` 为 `top_list` 时，采集器跳过“URL 发现”阶段，直接进入“详情页抓取”阶段，效率提升 40%。

## 20. 采集端抓取逻辑伪代码 (Collector Scripting)

### 20.1 全平台扫描算法
```javascript
// collector.js 扩展逻辑
async function scrapeOzonBestsellers(browser, categoryId) {
    const page = await browser.newPage();
    const targetUrl = `https://www.ozon.ru/category/${categoryId}/?sorting=orders_count`;
    
    await page.goto(targetUrl, { waitUntil: 'networkidle' });
    
    let results = [];
    const maxPages = 10;
    
    for (let i = 1; i <= maxPages; i++) {
        // 模拟人类滚动
        await autoScroll(page);
        
        const items = await page.$$eval('[data-widget="searchResultsV2"] .tile-root', nodes => {
            return nodes.map(n => ({
                sku: n.getAttribute('id'),
                title: n.querySelector('.tile-hover-target').innerText,
                price: n.querySelector('.ui-l0').innerText,
                salesText: n.querySelector('.ui-v5').innerText // e.g. "1000+ купили"
            }));
        });
        
        results.push(...items);
        
        // 翻页
        const nextBtn = await page.$('a.ui-v8');
        if (nextBtn) await nextBtn.click();
        else break;
        
        await sleep(Math.random() * 5000 + 3000); // 随机延迟
    }
    return results;
}
```

## 21. 找货匹配逻辑细节

当用户从榜单点击“找货”时：
1.  **提取特征**：提取 Ozon 标题并翻译成中文（调用 MiniMax M3）。
2.  **图像搜索**：下载 Ozon 主图，上传至 1688 搜图 API（或通过 `collector.js` 模拟搜图）。
3.  **审核匹配**：将 1688 结果与 Ozon 属性传给 MiniMax，计算 `confidence_score`。
4.  **展示**：在榜单页下方弹出“找货结果”面板，显示利润最高的 3 个候选项。

## 22. 视觉组件与 UX 规范

### 22.1 卡片式布局支持
- 除表格视图外，提供 **Grid View** 模式，方便快速浏览商品外观。
- **徽章系统**：
  - `New` (蓝色): 30天内上架。
  - `Hot` (红色): 销量 Top 5%。
  - `Low Comp` (绿色): 卖家数 < 3。

### 22.2 筛选器组
- 支持按价格区间 (`min_price` - `max_price`) 过滤。
- 支持按月销量下限 (`min_sales`) 过滤。

## 23. 系统集成与依赖关系图

```text
[Ozon Front-end] <--- (Playwright) --- [Mac Collector]
                                           |
                                       (POST API)
                                           |
                                    [server.js Job Queue]
                                           |
[Ozon Seller API] <--- (REST) --- [server.js Analytics]
                                           |
                                    [PostgreSQL DB]
                                           |
[Web UI] <--- (JSON) --- [app.js SPA]
```

## 24. 验收测试清单 (Acceptance Testing)

- **UT01**: 验证 `ozon_id` 抓取是否完整（包含变体 ID）。
- **UT02**: 验证“一键采集”是否能正确将任务推入 `app_jobs` 表。
- **UT03**: 验证在没有代理 IP 的情况下，采集器是否能正确识别反爬滑块并停机报错。
- **UT04**: 验证大促期间（如 Ozon 11.11），采集器是否能处理特殊的大促图标遮挡。



---
*Document Version: 1.0*
*Last Edited: 2026-07-02*
