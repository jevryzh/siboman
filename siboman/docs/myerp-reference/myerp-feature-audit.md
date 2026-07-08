# MyERP (my.jizhangerp.com) 功能盘点报告

> 抓取时间：2026-07-02 / 抓取账号：用户本机已登录账号 / 抓取范围：全站功能模块

## 1. 左侧菜单完整树

- **仪表盘** (`/ozon/dashboard/`)
- **商品**
  - 商品列表 (`/ozon/products/list/`)
  - 采集箱 (`/ozon/products/collect/`)
  - 上架记录 (`/ozon/products/import-history/`)
  - 库存管理 (`/ozon/products/stocks/`)
  - 下架重上 (`/ozon/products/reshelf/`)
- **选品**
  - 类目分析 (`/ozon/selection/category/`)
  - 榜单选品 (`/ozon/selection/top-list/`)
  - 中国专区 (`/ozon/selection/china/`)
- **AI 工具 (推荐)**
  - AI 改图神器 (`/ozon/tools/ai-poster-records/`)
  - AI 商品套图 (`/ozon/ai-image/`)
- **促销**
  - 价格与折扣 (`/ozon/promotions/prices/`)
  - 营销活动 (`/ozon/promotions/campaigns/`)
  - 自动删促销 (`/ozon/promotions/auto-delete/`)
- **订单**
  - 订单 (`/ozon/postings/list/`)
  - 退货申请 (`/ozon/postings/returns/`)
  - 利润趋势 (`/ozon/postings/profit-trend/`)
  - 数据大屏 (`/datascreen/`)
  - 索要好评 (`/ozon/postings/review-request/`)
  - 提醒取货 (`/ozon/postings/pickup-reminder/`)
- **工具**
  - 水印管理 (`/ozon/tools/watermark/`)
  - 浏览器插件 (`/extension/`)
- **消息**
  - 公告中心 (`/ozon/announcements/`)
  - 消息模板 (`/ozon/messaging/templates/`)
  - 发送记录 (`/ozon/messaging/history/`)

---

## 2. 各页面详情

### 2.1 仪表盘 (Dashboard)
- **URL**：`https://my.jizhangerp.com/ozon/dashboard/`
- **截图**：`docs/myerp-reference/01-dashboard.png`
- **一句话功能**：提供全店核心运营指标概览、待办告警及业务速览。
- **顶部筛选 / Tab**：自动同步开关、时间显示（2026-07-02）。
- **主要指标卡**：今日订单、今日 GMV、待打包、待发货、在售商品、库存预警、今日退货、7日利润。
- **操作按钮**：全部同步、一键同步全部、批量改价、AI大模型改图、1688采集、群发消息、批量上架、打印发货单。
- **备注**：支持查看店铺业绩对比和订单趋势（7日/30日）。

### 2.2 商品列表
- **URL**：`https://my.jizhangerp.com/ozon/products/list/`
- **截图**：`docs/myerp-reference/02-product-list.png`
- **一句话功能**：集中管理所有已同步或上架的商品，支持状态筛选和批量操作。
- **顶部筛选 / Tab**：全部、销售中、准备出售、错误、待修改、已下架、已归档。价格指数筛选（超值/有利/中等/不利）。
- **表格列头**：商品信息、状态、价格、库存、货源(¥)、最后同步、操作。
- **操作按钮**：立即同步、搜索、编辑、体检、同步。
- **备注**：显示商品 SKU 和货号，支持快速复制。

### 2.3 采集箱
- **URL**：`https://my.jizhangerp.com/ozon/products/collect/`
- **截图**：`docs/myerp-reference/03-collect-box.png`
- **一句话功能**：通过链接或 SKU 批量采集商品，作为上品前的暂存区。
- **顶部筛选 / Tab**：全部、待处理、已上架、失败。按来源筛选。
- **表格列头**：商品信息、采集价格、卖家/来源、品牌、下单链接、采集时间、状态、操作。
- **操作按钮**：添加采集（支持 Ozon 链接/SKU）、安装插件一键采集。
- **备注**：支持自动识别价格/重量/卖家。

### 2.4 上架记录
- **URL**：`https://my.jizhangerp.com/ozon/products/import-history/`
- **截图**：`docs/myerp-reference/04-listing-history.png`
- **一句话功能**：查看商品上架任务的执行历史和成功率，支持批量重试或删除。
- **主要指标卡**：累计批次、今日上品、处理中任务、成功率。
- **顶部筛选 / Tab**：全部、已完成、部分成功、处理中、失败。日期范围选择。
- **表格列头**：#、商品信息、源 SKU、店铺、变体、售价、状态、创建时间、操作。
- **备注**：展示具体的失败原因（如 Ozon 配额上限、内容审核未通过等）。

### 2.5 库存管理
- **URL**：`https://my.jizhangerp.com/ozon/products/stocks/`
- **截图**：`docs/myerp-reference/05-inventory.png`
- **一句话功能**：实时监控和批量调整各店铺各仓库的商品库存。
- **顶部筛选 / Tab**：商品库存、暂存草稿。库存状态（全部/缺货/低库存）。
- **主要指标卡**：商品总数、缺货数、低库存数、暂存待提交数。
- **表格列头**：主图、商品、总库存、仓库分布、操作。
- **操作按钮**：改库存、刷新、查询。

### 2.6 类目分析
- **URL**：`https://my.jizhangerp.com/ozon/selection/category/`
- **截图**：`docs/myerp-reference/07-category-analysis.png`
- **一句话功能**：深入分析 Ozon 平台类目规模、增长率、退货率及品牌集中度。
- **顶部筛选 / Tab**：时间范围（7/28/90/365天）、币种切换（₽/¥）。
- **主要指标卡**：全部类目、增长机会（GMV 环比≥30%）、高退货率（≥15%）、品牌集中（≥30%）、FBS 机会。
- **表格列头**：#、类目、月销量、月销售额、GMV 增长、平均价、卖家数、品牌占比、FBS 占比、退货率。
- **备注**：支持从一级类目开始逐层下钻分析。

### 2.7 榜单选品
- **URL**：`https://my.jizhangerp.com/ozon/selection/top-list/`
- **截图**：`docs/myerp-reference/08-top-list.png`
- **一句话功能**：展示 Ozon 全平台 Top 1000 实时榜单，支持策略筛选。
- **顶部筛选 / Tab**：热销商品、热销新品、潜力商品、蓝海商品。
- **主要指标卡**：月销量、月销售额、转化率、错失销售额、推广天数等。
- **操作按钮**：一键跟卖（直接跳转 Ozon）、批量加入草稿箱。
- **备注**：提供“机会判断”标签（如高增长、高 GMV、快发、可跟卖）。

### 2.8 中国专区
- **URL**：`https://my.jizhangerp.com/ozon/selection/china/`
- **截图**：`docs/myerp-reference/09-china-zone.png`
- **一句话功能**：专门针对中国跨境卖家的热销榜单，方便同行对标。
- **顶部筛选 / Tab**：包含“含零销量商品”勾选项、中国对标策略筛选。
- **备注**：标记商品是否来自“中国馆”。

### 2.9 AI 改图神器
- **URL**：`https://my.jizhangerp.com/ozon/tools/ai-poster-records/`
- **截图**：`docs/myerp-reference/10-ai-image-editor.png`
- **一句话功能**：基于 Gemini 大模型的商品图一键生成和修改工具。
- **主要指标卡**：显示消耗 MY 币、余额。
- **操作按钮**：上传图片/粘贴链接、开始生成。
- **备注**：支持“原图 vs 改图”实时对比。

### 2.10 AI 商品套图
- **URL**：`https://my.jizhangerp.com/ozon/ai-image/`
- **截图**：`docs/myerp-reference/11-ai-product-images.png`
- **一句话功能**：自动生成符合电商平台规范的全套展示图。
- **操作按钮**：一键生成爆款套图、下载全部。
- **备注**：支持设置平台（OZON）、语言（俄语/英语/中文）、比例（3:4/1:1/4:5）。

### 2.11 价格与折扣
- **URL**：`https://my.jizhangerp.com/ozon/promotions/prices/`
- **截图**：`docs/myerp-reference/12-prices-discounts.png`
- **一句话功能**：批量调整商品售价和设置促销折扣。
- **顶部筛选 / Tab**：价格、折扣。选择商品、改价草稿。
- **表格列头**：主图、商品、当前价格、操作。
- **备注**：改价后先存草稿，确认后再同步至 Ozon。

### 2.12 营销活动
- **URL**：`https://my.jizhangerp.com/ozon/promotions/campaigns/`
- **截图**：`docs/myerp-reference/13-marketing-campaigns.png`
- **一句话功能**：同步并管理 Ozon 官方促销活动，监控参与状态。
- **主要指标卡**：全部活动、参与中、可参与、即将结束。
- **表格列头**：活动名称、状态、折扣、商品、活动周期、操作。

### 2.13 自动删促销 (特色功能)
- **URL**：`https://my.jizhangerp.com/ozon/promotions/auto-delete/`
- **截图**：`docs/myerp-reference/14-auto-delete-promotion.png`
- **一句话功能**：利润保护工具，自动检测并退出折扣过深的促销活动。
- **备注**：服务端定时执行，无需保持页面打开。支持设置“最大可接受折扣”和检测频率。

### 2.14 订单列表
- **URL**：`https://my.jizhangerp.com/ozon/postings/list/`
- **截图**：`docs/myerp-reference/15-order-list.png`
- **一句话功能**：同步和处理所有店铺订单，支持导出。
- **顶部筛选 / Tab**：等待备货、等待发运、已超时、运输中、已签收、已取消等。
- **主要指标卡**：本周 GMV、本周利润、利润率。
- **表格列头**：倒计时、货件/状态、店铺、商品、仓库/配送、订单金额、利润。

### 2.15 退货申请
- **URL**：`https://my.jizhangerp.com/ozon/postings/returns/`
- **截图**：`docs/myerp-reference/16-refund-applications.png`
- **一句话功能**：处理买家的退货和退款申请，透传 Ozon API 数据。
- **顶部筛选 / Tab**：rFBS、FBS、FBO 模式。

### 2.16 利润趋势
- **URL**：`https://my.jizhangerp.com/ozon/postings/profit-trend/`
- **截图**：`docs/myerp-reference/17-profit-trends.png`
- **一句话功能**：可视化展示全店利润数据，包含成本拆解。
- **主要指标卡**：订单金额、客单价、利润、利润率、毛利率、订单数。
- **备注**：按出单日期聚合，支持“经营判断”自动分析。

### 2.17 数据大屏
- **URL**：`https://my.jizhangerp.com/datascreen/`
- **截图**：`docs/myerp-reference/18-data-screen.png`
- **一句话功能**：暗色调可视化作战大屏，展示实时订单流和多维性能数据。
- **主要图表**：订单状态分布、订单量x销售额趋势、店铺战力榜、配送渠道 TOP 等。

### 2.18 水印管理
- **URL**：`https://my.jizhangerp.com/ozon/tools/watermark/`
- **截图**：`docs/myerp-reference/19-watermark-mgmt.png`
- **一句话功能**：为商品图快速添加边框和水印，支持模板化操作。

### 2.19 索要好评 & 提醒取货
- **URL**：`/ozon/postings/review-request/` & `/ozon/postings/pickup-reminder/`
- **截图**：`docs/myerp-reference/24-review-request.png` & `docs/myerp-reference/25-pickup-reminder.png`
- **一句话功能**：针对已收货或到货订单自动/批量发送消息给买家，提升回评率和包裹取货率。

---

## 3. MyERP 特色能力清单 (vs 逐梦 ERP)

### A. 逐梦 ERP 已有，MyERP 也有
- 仪表盘统计
- 商品采集与上架记录
- 基本订单列表与同步

### B. MyERP 有但逐梦 ERP 目前没有
- **精细化选品分析**：包括类目下钻分析、Top 1000 榜单以及专门的中国跨境卖家对标专区，逐梦目前仅有基础采集。
- **AI 赋能工具链**：集成了基于 Gemini 的图片修改、文案帮写、全套电商图生成，极大降低了美工成本。
- **利润保护机制 (自动删促销)**：能够根据设定的最大折扣阈值自动从 Ozon 促销中移除亏损商品，这是逐梦目前最缺乏的后端自动化风控能力。
- **高级财务看板**：包含利润趋势分析、成本结构拆解（佣金/采购/物流）以及经营判断建议。
- **数据可视化大屏**：提供实时的“作战室”视图，适合团队协作和实时数据监控。
- **订单后链路营销**：索要好评、提醒取货功能，通过 API 自动触达买家，提升店铺 DSR。
- **水印/边框批量处理**：针对 Ozon 搜索排名的“边框套路”提供了专门的模板化工具。

### C. MyERP 里看起来鸡肋 / 冗余的功能
- **消息模块 (公告中心/消息记录)**：如果只是单人操作，这里的消息管理显得略重，且容易与 Ozon 后台消息重叠。
- **MY 币系统**：引入虚拟币计费增加了复杂度，对小卖家来说不如包月套餐直观。

---

## 4. 建议优先移植清单

1. **自动删促销 (利润保护)**：**最高优先级**。Ozon 促销规则复杂且容易自动加入，对单店卖家来说，一键/自动防御深坑折扣是保命功能。
2. **AI 改图/套图神器**：**高优先级**。结合 MiniMax 或 Gemini，实现商品图的本地化（俄语化）和背景替换，是提升转化率的最快手段。
3. **类目/榜单选品分析**：**高优先级**。解决“卖什么”的问题，比单纯“怎么采集”更有价值。
4. **利润趋势及成本拆解**：**中优先级**。帮助卖家看清每单实际赚多少，特别是佣金和汇率波动下的真实利润。
5. **提醒取货功能**：**中优先级**。Ozon 的未取货退回成本很高，通过 ERP 批量发送提醒是降低退货率的实效方案。
