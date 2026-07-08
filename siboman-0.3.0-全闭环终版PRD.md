# siboman 0.3.0 全闭环终版 PRD

> **产出人**：产品经理（Accio Work Agent）
> **日期**：2026-07-03
> **文档定位**：**siboman 0.3.0 完整功能契约**，Coder 严格实施；杜绝东抄西抄
> **前置文档**：
> - v2.0 采集+订单 PRD：[siboman-0.2.0-终版PRD-熊猫采集蓝本.md](siboman-0.2.0-终版PRD-熊猫采集蓝本.md)
> - v1.0 全功能+组件规范：[siboman-0.2.0-全功能定义与组件规范.md](siboman-0.2.0-全功能定义与组件规范.md)
> **本轮新增调研**：`screenshots/v4/`（选品/商品/AI 工具）

---

## 0. 用户核心指令（红线）

| # | 用户原话 | 落地约束 |
|---|--------|--------|
| 1 | 采集参考熊猫、**选品和商品参考 MY** | 采集 = 熊猫三层结构；选品 = MyERP 三 Tab；商品 = MyERP 6 Tab + 铅笔行内编辑 |
| 2 | **AI 商品套图不要吃掉** | §4 单独章节，完整 PRD，不能再消失 |
| 3 | **不能东抄西抄，要数据闭环** | §5 画数据流转图；每个字段标注"来源→存储→出向" |
| 4 | 多店铺商品库存必须隔离 | §6 全站 store_id 贯通 + DDL 迁移方案 |
| 5 | 不做半成品 | 每模块必须走 §11 回归清单 |

---

## 1. 本轮实机新证据（每个结论都有截图支撑）

### 1.1 MyERP 商品列表（`screenshots/v4/myerp-products/`）

**顶部**：
```
商品列表                                    [🔴 自动同步] [🔄 立即同步]
当前店铺：Three Latte · 数据定时自动同步
```

**6 状态 Tab**：`全部 | 销售中 922 | 准备出售 0 | 错误 0 | 待修改 387 | 已下架 0 | 已归档 775`

**筛选栏**：`🔍 搜 SKU/货号/标题...`  +  `价格指数：全部 / 超值 / 有利 / 中等 / 不利`  +  「共 922 个」计数

**表格列（7 列 + 复选 + 操作）**：
| 列 | 显示内容 |
|---|--------|
| ☑️ | 复选框 |
| 商品信息 | 缩略图 + 俄文标题（蓝色可点）+ `货号 jz-xxx` +  `SKU xxx` （小灰字，有复制按钮） |
| 状态 | `● 销售中`（绿）+ `1 项异常`（橙 badge） |
| 价格 | `CNY 115.42` + `[有利]` badge + 铅笔编辑图标；下一行 `原 CNY 144.28`（划线灰色） |
| 库存 | 数字 `10` + 铅笔编辑图标；下方短横线（分仓存位） |
| 货源 (¥) | 已录：`¥12` + 铅笔；未录：`[+ 录入采购价]` 按钮 |
| 最后同步 | `07-03 14:09` + `14 分钟前` |
| 操作 | `[编辑]`（蓝主按钮）`[体检]` `[同步]` `[⋯]` |

**关键洞察**：
- **行内编辑靠铅笔图标**（不是双击）—— **每个字段旁边都有一个 ✏️**
- **"1 项异常" badge** 是从体检结果实时同步到状态列的
- **"价格指数"是 Ozon 官方字段**（超值/有利/中等/不利），必须做进筛选
- 顶部有全局「自动同步」开关，可 toggle 后台定时任务
- **编辑打开新页面** `/ozon/products/online/edit/`（不是 Modal） —— 与熊猫的 Modal 形态**不同**，siboman 选哪种见 §3.3

### 1.2 MyERP 选品模块（`screenshots/v4/myerp-selection/`）

**侧栏「选品」子菜单（3 个）**：
- 类目分析
- 榜单选品
- 中国专区

#### 榜单选品页
- 4 个子 Tab：`热销商品 | 热销新品 | 潜力商品 | 蓝海商品`
- 时间：`7天 / 28天`
- 币种：`₽ / ¥`
- 分区：下拉选择
- **选品策略**（快速筛选）：`高增长 / 低价高销 / 高加购 / 蓝海量级`
- **一级类目**：横向 Tab（家用电器/电子产品/住宅和花园/美容和卫生/运动与休闲/药店/建筑和装修/食品/日化/家具/更多）
- **筛选器**（8 个字段）：
  - 商品名称 / SKU（单个）
  - **批量 SKUS**（逗号/空格/换行分隔）
  - 月销量区间 / 月销售额区间 / 平均价区间
  - 月销售额环比%区间
  - 发货模式
- 商品总数：`共 2,912,311 件 · 当前展示 1-20`
- 底部：`[已选 0]  [批量加入草稿箱]  [清空选择]`
- 提示语："销量与销售额双高的爆款，适合切入趋势品类。点击「一键跟卖」跳转 Ozon 商品页，自动唤起模拟手动跟卖。"

#### 类目分析页
- 时间：`7/28/90/365 天` + 币种 + 一级类目
- 数据列：月销量、月销售额、GMV 增长率、平均价、卖家数、品牌占比、退货率
- 支持类目下钻

#### 中国专区
- 榜单类型：`高增长 / 低价高销 / 中国标杆`
- 数据：中国卖家的 Ozon 爆款榜单

### 1.3 MyERP AI 工具（`screenshots/v4/ai-tools/`）

**侧栏「AI 工具」子菜单（2 个，标"推荐"红标签）**：
- AI 改图神器（Gemini 大模型，原图 vs 改图对比，最多 10 张批量）
- **AI 商品套图**（Gemini Pro，单张原图→8 张爆款套图）

#### AI 商品套图页布局（截图 `myerp_03_ai_set.png`）

```
┌──────────────────────────────────────────────────────────────────────┐
│ 🔵 AI 商品套图  [Gemini Pro]        [⏱生成记录] [⚡0 MY币] [充值]      │
│ 上传商品图，AI 即刻生成符合多电商平台规范的高转化率商品套图。          │
├───────────────────────────────┬──────────────────────────────────────┤
│【左栏：输入】                  │【右栏：预览】                         │
│ 📷 商品原图  单张 ≤ 10MB       │ 👁 套图预览        [↓ 下载全部]      │
│  ┌───────────────────────┐    │                                       │
│  │   ↑                    │    │        ┌───────┐                    │
│  │ 点击、拖拽，或 Ctrl+V   │    │        │  🔲    │                    │
│  │ 粘贴图片                │    │        └───────┘                    │
│  │ 推荐白底或纯净背景的     │    │  上传商品图并点击「一键生成爆款套图」│
│  │ 主体清晰图              │    │  AI 将自动抠图、套用电商模板、       │
│  └───────────────────────┘    │  渲染本地化卖点文案，输出整套可       │
│                                │  直接上架的商品图。                    │
│ ✨ 生成设置                     │                                       │
│  生成模型: [Gemini Pro·高质量 ▼] │  1️⃣ 上传一张主体清晰的商品原图        │
│           100 套电商模板自动选场景  │  2️⃣ ...                              │
│           渲染本地化文案       │                                       │
│  平台: OZON  语言: 俄  比例: 3:4/1:1/4:5│                              │
│                                │                                       │
│ 💡 商品卖点 & 要求（可 AI 帮写）│                                       │
│  [_______________________]     │                                       │
│  [AI 帮写] 自动生成卖点          │                                       │
│                                │                                       │
│         [🚀 一键生成爆款套图]    │                                       │
└───────────────────────────────┴──────────────────────────────────────┘
```

**关键设计**：
- **左右两栏布局**（输入 vs 预览），不是弹窗
- **上传单张原图 → 生成 8 张套图**（一次消耗 400 MY 币）
- **AI 帮写**：用户不用自己写 Prompt，AI 从原图 + 商品信息自动生成"产品名 + 核心卖点 + 适用人群 + 期望场景"
- **平台/语言/比例都是明确的枚举字段**（不是自由输入）—— 语言选"俄"就自动本地化文案
- **模型可切换**（Gemini Pro · 高质量 / 还有其他档次）
- 右上角**费用实时显示**（`⚡0 MY币`），可点「充值」

#### AI 改图神器
- 图片来源：本地上传 / 图片链接粘贴 / Ctrl+V
- 辅助信息：**商品名**（可选）+ **类目**（可选）
- Gemini 大模型驱动，原图 vs 改图**实时对比**
- 支持最多 10 张批量上传

### 1.4 熊猫 AI 工具（补充证据）

- **GPT-Image2**：专注生图，1K/2K 分辨率
- **Nano Banana (NanoAI)**：高级生图，10+ 种比例（1:1 到 21:9），内置**极详尽的中文 Prompt 模板**，明确指定"添加俄语粗体主标题 + 底部俄语卖点文字"

---

## 2. 【模块 A】选品模块 PRD（**参考 MyERP**）

### 2.1 模块结构

```
/selection/
├── /category-analysis   类目分析
├── /top-list            榜单选品
└── /china-zone          中国专区
```

### 2.2 榜单选品页 `/selection/top-list`（P0）

#### 2.2.1 页面头部

```
┌──────────────────────────────────────────────────────────────┐
│ 榜单选品  / Ozon 全平台 top 1000 实时榜单     数据更新 2026-07-02 │
├──────────────────────────────────────────────────────────────┤
│ [热销商品] [热销新品] [潜力商品] [蓝海商品]                     │
│                              [7天 | 28天]  金额: [₽ | ¥]  分区 ▼│
├──────────────────────────────────────────────────────────────┤
│ ℹ️ 销量与销售额双高的爆款，适合切入趋势品类。                    │
│    点击「一键跟卖」跳转 Ozon 自动唤起插件模拟跟卖。               │
├──────────────────────────────────────────────────────────────┤
│ 选品策略：[高增长][低价高销][高加购][蓝海量级]                  │
│  保留当前类目，快速切换                                          │
├──────────────────────────────────────────────────────────────┤
│ 一级类目：[全部][家用电器][电子产品]...[更多↓]                  │
└──────────────────────────────────────────────────────────────┘
```

#### 2.2.2 筛选器（严格按 MyERP `03_page2_top.png`）

| 字段 | 类型 | 数据源 |
|-----|-----|-------|
| 商品名称 | 文本 | 前端过滤 |
| SKU | 文本 | 单个 |
| **批量 SKUS** | 多行文本 | 逗号/空格/换行分隔 |
| 月销量区间 | 数字 min-max | Ozon 榜单数据 |
| 月销售额 ₽ 区间 | 数字 min-max | 同上 |
| 平均价 ₽ 区间 | 数字 min-max | 同上 |
| 月销售额环比 % | 数字 min-max | 同上 |
| 发货模式 | 下拉 | FBS/FBO/任意 |

按钮：`[🔍 查询] [🔄 重置] [更多筛选 ↓]`

#### 2.2.3 表格列

| 列 | 内容 |
|---|-----|
| ☑️ | 复选 |
| 商品信息 | 缩略图 + 俄文标题 + SKU + 品牌 |
| 机会判断 | 徽章：`[高增长]`（红）/ `[快发]`（蓝）/ `[可跟卖]`（绿） |
| 月销量 | 数字 + 环比箭头（▲252.3%） |
| 月销售额 ₽ | 数字 |
| 单价 ₽ | 数字 + 跟卖最低价（灰色副行） |
| 环比 | 百分比 |
| 转化率 | 百分比 |
| 操作 | `[一键跟卖]`（蓝主按钮） |

#### 2.2.4 底部操作栏

```
共 2,912,311 件 · 当前展示 1-20     [已选 3] [批量加入草稿箱] [清空选择]
```

#### 2.2.5 关键 AC

| ID | Given / When / Then |
|---|---------------------|
| **AC-SEL01** | Given 榜单选品页；When 切"热销新品" Tab；Then 数据切换，选品策略/一级类目筛选保留 |
| **AC-SEL02** | Given 批量 SKUS 粘贴 100 个 SKU；When 点查询；Then 后端并行拉这 100 个 SKU 的榜单数据，2s 内返回 |
| **AC-SEL03** | Given 某商品行点[一键跟卖]；Then 弹「跟卖设置」小面板：目标店铺（多选）+ 售价调整（默认原价，可加价%）+ 备注 → 确定后创建 collect_items 记录 status=pending，并调采集端抓取原商品详情 |
| **AC-SEL04** | Given 勾选 20 个商品；When 点[批量加入草稿箱]；Then 弹目标店铺选择；确定后批量创建 collect_items |

### 2.3 类目分析页 `/selection/category-analysis`（P1）

- 筛选器：时间（7/28/90/365 天）+ 币种（₽/¥）+ 一级类目
- 表格列：类目名 / 月销量 / 月销售额 / GMV 增长率 / 平均价 / 卖家数 / 品牌占比 / 退货率
- 点行 → 类目下钻（子类目详情）
- 操作：`[导出 Excel]` `[加入监控]`（P2）

### 2.4 中国专区 `/selection/china-zone`（P1）

- 类型：`高增长 / 低价高销 / 中国标杆`
- 表格：中国卖家在 Ozon 的销售数据
- 同榜单选品共用一套「一键跟卖」逻辑

---

## 3. 【模块 B】商品模块 PRD（**参考 MyERP**）

### 3.1 模块结构

```
/products/
├── /list         商品列表       ← 本次核心
├── /collect      采集箱         ← 见 v2.0 PRD（熊猫模式）
├── /listing-history 上架记录
├── /inventory    库存管理
└── /relist       下架重上
```

### 3.2 商品列表页 `/products/list`（P0）

#### 3.2.1 页面头部（严格按 MyERP `01_list_top.png`）

```
┌────────────────────────────────────────────────────────────────┐
│ 商品列表                                  [🔴 自动同步] [🔄 立即同步]│
│ 当前店铺：Three Latte · 数据定时自动同步                          │
├────────────────────────────────────────────────────────────────┤
│ [全部] [销售中 922] [准备出售 0] [错误 0] [待修改 387] [已下架 0] [已归档 775]│
├────────────────────────────────────────────────────────────────┤
│ [🔍 搜 SKU/货号/标题...]  ⌘K  │ 价格指数：全部/超值/有利/中等/不利 │ 共 922 个│
└────────────────────────────────────────────────────────────────┘
```

#### 3.2.2 表格列（7 列 + 复选 + 操作）

| # | 列 | 内容 | 交互 |
|---|----|-----|-----|
| P00 | ☑️ | 复选框 | 全/半选联动底部批量栏 |
| P01 | 商品信息 | 上：缩略图 60x60  中：**俄文标题（蓝色可点跳详情）**  下：`货号 jz-xxx [📋]`  最下：`SKU xxx [📋]` | 缩略图 hover 放大 400x400；两个 [📋] 复制 |
| P02 | 状态 | 上：`● 销售中`（绿）/`● 错误`（红）/`● 已下架`（灰）等  下：`N 项异常`（橙 badge） | 点异常 badge 弹详情 |
| P03 | 价格 | 上：`CNY 115.42` + `[有利]` badge + ✏️  下：`原 CNY 144.28`（划线灰） | 点 ✏️ 进入行内编辑（下 §3.2.3） |
| P04 | 库存 | 数字 `10` + ✏️  下：分仓存位短横线 | 点 ✏️ 编辑；hover 显示各仓库存 |
| P05 | 货源 (¥) | 已录入：`¥12` + ✏️  未录入：`[+ 录入采购价]` 按钮 | 点 [+ 录入]弹小面板输入采购价+备注 |
| P06 | 最后同步 | `07-03 14:09` + `14 分钟前` | tooltip 显示完整时间 |
| P07 | 操作 | `[编辑]`(蓝主) `[体检]` `[同步]` `[⋯更多]` | 更多 = 下架/复制/删除 |

#### 3.2.3 行内编辑（铅笔图标模式，**严格按 MyERP**）

```
默认态：
  CNY 115.42  [有利]  ✏️

点 ✏️：
  ┌─────────────────┐
  │ CNY [_115.42_]  │
  │ [取消] [√保存]  │
  └─────────────────┘
```

**AC**：
- 点 ✏️ → 单元格变输入框（预填当前值）
- Enter 保存 / Esc 取消 / 点[√]保存 / 点[取消]取消
- 保存时：先前端校验（价格 > 0，库存 ≥ 0）→ 调 PATCH API → loading 转圈 → 成功后 toast + 单元格闪绿；失败 toast 红色错误
- 保存成功自动更新"最后同步"时间

#### 3.2.4 顶部同步控件

- **[🔴 自动同步]**：Toggle 开关；开启后后端启动定时任务（默认每 30 分钟拉一次 Ozon `/v3/product/list` 更新缓存）
- **[🔄 立即同步]**：立即拉一次，按钮变 loading，完成后 toast

#### 3.2.5 批量操作栏（底部滑入）

严格按 v2.0 PRD §4.5，5 个批量操作：
- 批量修改售价（4 模式）
- 批量修改库存（3 模式）
- 批量体检
- 批量同步 Ozon
- 批量下架

#### 3.2.6 编辑器决策（MyERP vs 熊猫）

**MyERP**：新页面跳转 `/products/online/edit/`
**熊猫**：Modal 弹窗（宽 1200px）
**siboman 决策**：**用熊猫的 Modal**（v2.0 PRD §2.3 已定义）

**理由**：
1. 用户明确说"采集参考熊猫"，采集编辑用 Modal
2. 商品列表编辑 = 复用采集箱编辑 Modal（同一份代码，见 v1 组件规范）
3. Modal 比新页面**跳转成本低**，用户可随时关闭回列表
4. Modal 只在字段"卖家 ID（只读）+ 底栏按钮改成'保存并同步 Ozon'"上与采集箱不同

差异点：

| 项 | 采集箱编辑 | 商品列表编辑 |
|---|---------|-----------|
| 数据源 | `collect_items` | `app_products` |
| offer_id | 可编辑 | **只读** |
| 底栏按钮 | `[关闭][保存修改]` | `[关闭][保存并同步 Ozon]` |
| 保存 API | `PUT /api/collect/:id/draft` | `PUT /api/products/:offer_id` |

#### 3.2.7 关键 AC

| ID | Given / When / Then |
|---|---------------------|
| **AC-P01** | Given 顶部[🔴 自动同步]开启；Then 后端启动定时 job 每 30min 拉 Ozon 更新缓存；关闭则停止 |
| **AC-P02** | Given 点[🔄 立即同步]；Then 按钮变 loading，调 /api/products/sync-now，返回后 toast "已同步 N 个商品" |
| **AC-P03** | Given 6 Tab 计数与筛选；When 切"待修改" Tab；Then 只显示 ozon_state='needs_action' 的记录，顶部数字 = 该店 store_id 下待修改总数 |
| **AC-P04** | Given "价格指数"筛选 = "有利"；Then 只显示 price_index='有利' 的记录 |
| **AC-P05** | Given 价格单元格；When 点 ✏️；Then 变输入框预填 CNY 值，Enter 调 PATCH /api/products/:offer_id/price（Body: `{cny: 100, currency: 'CNY'}`）；后端换算 RUB 后调 Ozon /v1/product/import-prices |
| **AC-P06** | Given 未录入采购价的行；When 点 [+ 录入采购价]；Then 弹小面板：`采购价 [___] ¥ + 备注 [___] + [取消][保存]` → 写入 app_products.purchase_price_cny + purchase_remark |
| **AC-P07** | Given 状态列显示 "1 项异常"；When 点该 badge；Then 弹小卡片列出体检未通过的项目（如"图片分辨率不足"），[去修复]跳编辑 Modal |
| **AC-P08** | Given 点行[编辑]；Then 打开与采集箱**同一个** Modal 组件（宽 1200px），字段全预填，offer_id 只读，底栏[保存并同步 Ozon] |

### 3.3 库存管理页 `/products/inventory`（P0）

**表格列**（严格按 MyERP `06_inv_top.png`）：
| 列 | 内容 |
|---|-----|
| 主图 | 缩略图 |
| 商品 | 俄文名 + SKU + offer_id |
| 总库存 | 汇总数字 |
| **仓库分布** | `CEL 陆空: 10 / 其他仓: 0` 分仓明细 |
| 操作 | `[补货]` `[调拨]` `[编辑阈值]` |

**顶部统计卡**：
- ⚠️ 缺货商品：N 个
- 🟡 低库存 (≤10)：N 个

**AC**：
- **AC-INV01**：库存 = 0 显示红色徽章 `缺货`
- **AC-INV02**：库存 ≤ 阈值（默认 10）显示黄色徽章 `低库存`
- **AC-INV03**：仓库分布按 store_id 隔离，跨店不聚合

### 3.4 上架记录页 `/products/listing-history`（P1）

时间线视图：每次上架任务 = 一条节点
- 时间 / 任务 ID / 商品数 / 成功 / 失败 / 目标店铺 / 提交备注（来自 §2.4 上架时填的备注）
- 失败项支持"重试"

### 3.5 下架重上 `/products/relist`（P1）

- 表格显示 archived 状态商品
- 支持"重新上架"（复制字段生成新 collect_items）

---

## 4. 【模块 C】AI 商品套图 PRD（**补回，绝不再吃掉**）

### 4.1 模块结构

```
/ai-tools/
├── /product-image-set   AI 商品套图  ← 核心（严格按 MyERP）
├── /image-editor        AI 改图神器
└── /prompt-generator    AI 提示词生成（新增，见 §4.4）
```

### 4.2 AI 商品套图 `/ai-tools/product-image-set`（P0）

#### 4.2.1 页面布局（严格按 MyERP `myerp_03_ai_set.png`）

**左右两栏**（不是弹窗！）：

##### 左栏：输入区

```
📷 商品原图    单张 ≤ 10MB · jpg/jpeg/png
┌───────────────────────────────────────┐
│         ↑                              │
│  点击、拖拽，或 Ctrl+V / ⌘+V 粘贴图片   │
│  推荐白底或纯净背景的主体清晰图         │
└───────────────────────────────────────┘

✨ 生成设置
  生成模型  [Gemini Pro · 高质量 ▼]  100 套电商模板自动选场景 · 渲染本地化文案
  平台     [OZON ▼]                （未来支持 Ozon Wildberries Amazon）
  语言     [俄 ▼]                  （中/俄/英）
  比例     [3:4] [1:1] [4:5]        （单选按钮组）

💡 商品卖点 & 要求（可选，可 AI 帮写）
  ┌─────────────────────────────────────┐
  │ 请输入商品卖点或场景要求...          │
  │                                       │
  └─────────────────────────────────────┘
  [✨ AI 帮写] 自动生成产品名/核心卖点/适用人群/期望场景

         [🚀 一键生成爆款套图]
              预计消耗 400 MY 币
```

##### 右栏：预览区

```
👁 套图预览                      [↓ 下载全部]

  空态：
  ┌─────────────────────────┐
  │        🔲               │
  │                          │
  │ 上传商品图并点击          │
  │ 「一键生成爆款套图」      │
  │                          │
  │ AI 将自动抠图、套用       │
  │ 电商模板、渲染本地化      │
  │ 卖点文案，输出整套可      │
  │ 直接上架的商品图。        │
  │                          │
  │ 1️⃣ 上传一张主体清晰的     │
  │    商品原图              │
  │ 2️⃣ 选择目标平台/语言/比例 │
  │ 3️⃣ 点击一键生成           │
  └─────────────────────────┘

  生成后：
  ┌────┬────┬────┬────┐
  │[图1]│[图2]│[图3]│[图4]│  ← 8 张套图 2x4 网格
  ├────┼────┼────┼────┤     每张右上角有[⋆推送 Ozon][↓下载][🔄重生成]
  │[图5]│[图6]│[图7]│[图8]│
  └────┴────┴────┴────┘
```

##### 顶部工具栏

```
🔵 AI 商品套图  [Gemini Pro 徽章]  |  [⏱生成记录]  [⚡MY 币: 400] [充值]
上传商品图，AI 即刻生成符合多电商平台规范的高转化率商品套图。
```

#### 4.2.2 字段清单（Coder 严格按此）

| # | 字段 | 控件类型 | 必填 | 数据源 | 备注 |
|---|-----|--------|-----|-------|-----|
| AI01 | 商品原图 | 上传/拖拽/Ctrl+V | ✅ | 用户 | ≤10MB，支持 jpg/jpeg/png |
| AI02 | 生成模型 | 下拉 | ✅ | 常量 | Gemini Pro · 高质量 / Gemini Flash · 快速（后续加） |
| AI03 | 平台 | 下拉 | ✅ | 常量 | 默认 OZON，v1 只支持 OZON |
| AI04 | 语言 | 下拉 | ✅ | 常量 | 中/俄/英，默认俄 |
| AI05 | 比例 | Radio 组 | ✅ | 常量 | 3:4 / 1:1 / 4:5 |
| AI06 | 商品卖点 | 多行文本 | ⬜ | 用户 | 空时后端自动补默认卖点 |
| AI07 | AI 帮写按钮 | Button | — | — | 调 AI 生成 4 段：产品名/核心卖点/适用人群/期望场景，回填 AI06 |
| AI08 | 一键生成按钮 | 主按钮 | — | — | 预算不足 disabled + tooltip "MY 币不足" |
| AI09 | MY 币余额 | 顶部展示 | — | user.credit | 实时；点[充值]跳充值页 |

#### 4.2.3 关键交互流

```
用户上传原图 → 自动抠图（后端预处理）
     ↓
选平台/语言/比例
     ↓
可选：点 AI 帮写 → 后端调 Gemini 分析图片 → 填充卖点
     ↓
点[一键生成爆款套图]
     ↓
弹二次确认：「即将消耗 400 MY 币生成 8 张套图，余额 400 → 0」
     ↓
后端调 Gemini Pro API：
  Input:  { image, platform, lang, ratio, selling_points }
  Output: [8 张套图 URLs]
     ↓
右栏依次填充（流式展示，先出的先显示）
     ↓
每张图右上角：[⋆推送 Ozon] [↓下载] [🔄重生成]
     ↓
可点[↓下载全部]zip 打包下载
     ↓
自动记录到「生成记录」页
```

#### 4.2.4 关键 AC

| ID | Given / When / Then |
|---|---------------------|
| **AC-AI01** | Given 上传原图；When 后端预处理；Then 自动抠图 + 检测主体位置，若主体偏左/偏右提示"建议主体居中" |
| **AC-AI02** | Given 点[AI 帮写]；Then 后端并发调 Gemini 分析图片 + 生成 4 段（产品名/卖点/人群/场景），2-4s 回填到 AI06 文本框 |
| **AC-AI03** | Given 点[一键生成]；Then 弹二次确认「即将消耗 400 MY 币」；余额不足 disabled |
| **AC-AI04** | Given 确认生成；Then 调 Gemini Pro，每张图返回时右栏立即渲染（流式），总耗时 30-60s |
| **AC-AI05** | Given 8 张套图已生成；When 点单张右上[⋆推送 Ozon]；Then 弹「选择目标商品 SKU」弹窗，选中后调 Ozon `/v2/product/pictures/import` 推送 |
| **AC-AI06** | Given 生成失败（API 超时/额度不足/敏感词）；Then 退还 MY 币 + toast 明确错误原因 |
| **AC-AI07** | Given 生成完成；Then 记录写入 `ai_image_records` 表（含 original_image / prompt / result_images / cost_credits / status），可在「生成记录」查看 |
| **AC-AI08** | Given 语言选"俄"；Then 生成的图上文字为俄语（如"Скидка 30%"）；语言选"中"则中文 |

### 4.3 AI 改图神器 `/ai-tools/image-editor`（P1）

- 输入：本地上传 / 图片链接 / Ctrl+V
- 辅助信息：商品名（可选）+ 类目（可选）
- 支持最多 10 张批量
- 输出：原图 vs 改图 **左右对比**
- 用例：去水印 / 换背景 / 加俄语标签 / 换风格

### 4.4 AI 提示词生成器 `/ai-tools/prompt-generator`（P1，**用户明确诉求**）

**用户原话**："从 1688 中文标题/详情提取卖点，生成 DALL-E/Midjourney 提示词，并翻译成俄语标题"

#### 4.4.1 页面布局

```
┌──────────────────────────────────────────────────────────────┐
│【左栏：输入】                                                   │
│ 数据来源：                                                       │
│  ○ 从 1688 URL 拉取                                             │
│    [https://detail.1688.com/... _______________] [拉取]         │
│  ○ 从采集箱选商品                                                │
│    [选择商品 ▼]                                                  │
│  ○ 手动输入中文标题/详情                                          │
│    [中文标题: __________________]                                │
│    [中文详情: _______________________________]                   │
├──────────────────────────────────────────────────────────────┤
│【右栏：输出】                                                    │
│  📌 卖点提取（AI 分析）                                          │
│    • 卖点 1: 便携易带                                             │
│    • 卖点 2: 防水防摔                                             │
│    • 卖点 3: 一年质保                                             │
│    [复制] [重新生成]                                              │
│                                                                  │
│  🌐 俄语商品标题                                                  │
│    Портативный водонепроницаемый ...    [复制]                   │
│                                                                  │
│  🎨 图像生成 Prompt（Gemini/DALL-E/MJ 通用）                     │
│    Professional product photography of portable ...              │
│    [复制] [→ 送至 AI 商品套图]                                    │
│                                                                  │
│  💬 俄语描述文案（100 字，含卖点+CTA）                            │
│    Наш новый водонепроницаемый ...  [复制]                       │
└──────────────────────────────────────────────────────────────┘
```

#### 4.4.2 数据闭环

- 输入 1688 URL → 后端调采集端抓取中文标题+详情+主图
- 一次调 Gemini 生成 4 段输出（卖点 / 俄语标题 / Prompt / 俄语描述）
- 点[→ 送至 AI 商品套图] → 跳转 §4.2，自动预填卖点和图片

#### 4.4.3 关键 AC

| ID | Given / When / Then |
|---|---------------------|
| **AC-PG01** | Given 粘贴 1688 URL；When 点[拉取]；Then 5-10s 内后端返回中文标题/详情/主图，UI 显示原文预览 |
| **AC-PG02** | Given 内容已加载；Then 自动调 Gemini 生成 4 段输出，逐段流式展示 |
| **AC-PG03** | Given 输出的俄语标题；When 点[复制]；Then 剪贴板写入 + toast "已复制" |
| **AC-PG04** | Given 输出的图像 Prompt；When 点[→ 送至 AI 商品套图]；Then 跳 §4.2，AI06 卖点字段和 Prompt 预填 |
| **AC-PG05** | Given 从采集箱选商品；Then 输入区自动填充该商品的中文标题/详情 |

---

## 5. 数据闭环图（TL 明确要求）

### 5.1 全链路数据流

```
┌────────────┐          ┌────────────────┐         ┌──────────────┐
│  1688      │          │  siboman ERP   │         │  Ozon        │
│  平台       │          │                │         │              │
├────────────┤          ├────────────────┤         ├──────────────┤
│            │          │                │         │              │
│  商品详情   │──采集───▶│ collect_items  │         │              │
│  URL/图/价 │  端抓取  │ (中文原始数据)  │         │              │
│            │          │                │         │              │
│            │          │      │         │         │              │
│            │          │      ▼         │         │              │
│            │          │  用户编辑弹窗   │         │              │
│            │          │  ─选类目       │◀─类目树──│              │
│            │          │  ─选品牌       │◀─品牌库──│              │
│            │          │  ─填属性        │◀─属性 schema│         │
│            │          │  ─AI 智能填充   │         │              │
│            │          │      │         │         │              │
│            │          │      ▼         │         │              │
│            │          │ collect.draft_form│      │              │
│            │          │      │         │         │              │
│            │          │      ▼         │         │              │
│            │          │  送入上架（选店）│         │              │
│            │          │      │         │         │              │
│            │          │      ▼         │         │              │
│            │          │ listing_jobs   │──上架───▶│ /v3/products │
│            │          │ (每店一条)     │  API    │ /import      │
│            │          │      │         │         │      │       │
│            │          │      │         │◀─product_id/state─┘  │
│            │          │      ▼         │         │              │
│            │          │  app_products   │         │              │
│            │          │  (含 store_id + │◀─30min 定时拉取─────  │
│            │          │  purchase_remark)│  /v3/product/list   │
│            │          │      │         │         │              │
│            │          │      │         │         │              │
│            │          │      ▼         │         │              │
│            │          │  商品列表页     │         │              │
│            │          │  ─行内编价     │──调价───▶│ /v1/product/ │
│            │          │  ─行内改库存   │──调库存─▶│ import-prices│
│            │          │  ─批量同步     │         │              │
│            │          │                │         │              │
│            │          │                │         │              │
│            │          │  ┌─────────┐   │         │              │
│            │          │  │  订单   │◀──订单同步─│ /v3/posting/ │
│            │          │  │(orders) │           │ fbs/list      │
│            │          │  │+ store_id│           │              │
│            │          │  │+ 采购溯源│           │              │
│            │          │  │（引用     │           │              │
│            │          │  │ app_products│         │              │
│            │          │  │ .purchase_ │         │              │
│            │          │  │ remark）  │           │              │
│            │          │  └─────────┘   │         │              │
│            │          │      │         │         │              │
│            │          │      ▼         │         │              │
│            │          │  批量备货      │──ship-package─▶│      │
│            │          │  批量打面单    │──package-label▶│      │
│            │          │                │         │              │
└────────────┘          └────────────────┘         └──────────────┘
```

### 5.2 关键 ID 对齐（数据闭环的核心）

| 阶段 | 系统内 ID | Ozon 对应 ID | 落库字段 |
|-----|---------|------------|---------|
| 采集 | `collect_items.id` | — | `source_url` |
| 上架任务 | `listing_jobs.id` | `task_id` (Ozon 返回) | `ozon_task_id` |
| 已上架商品 | `app_products.id` | `product_id` + `offer_id` | 关键：`offer_id` 是 siboman 的业务主键 |
| 订单 | `orders.id` | `posting_number` + `order_id` | 通过 offer_id 关联回 app_products |
| 图片 | `ai_image_records.id` | — | 关联 offer_id |

**关键约束**（数据闭环的红线）：

1. `offer_id` 全局唯一（每个店铺内），格式 `jz-{采集ID}` 或用户自定义
2. `product_id` 由 Ozon 生成，siboman 存但不主动使用（通信用 offer_id）
3. 订单里的 `SKU`（Ozon 返回的商品 ID）= `app_products.ozon_sku`，通过 SKU 反查 offer_id 反查 app_products 反查 purchase_remark
4. 所有跨表关联必须带 `store_id`（防止跨店铺数据串扰）

### 5.3 数据一致性保证

| 场景 | 触发方 | 一致性动作 |
|-----|-------|----------|
| 上架成功 | Ozon 回调 or 定时同步 | listing_jobs.status=success + 创建 app_products |
| 改价成功 | 用户行内编辑 | 立即 PATCH Ozon → 成功后更新 app_products.price + last_synced_at |
| 改库存成功 | 用户行内编辑 | 同上 |
| Ozon 状态变化 | 定时同步 | app_products.ozon_state 更新，触发状态变更事件 |
| 订单发货 | 用户批量备货 | ship-package 成功后 orders.status 更新 + 可选扣减 app_products.stock |

---

## 6. 【模块 D】多店铺方案（含商品库存隔离）

### 6.1 全站店铺切换器

**位置**：所有列表页顶部第一位（订单/商品/采集箱/库存都统一），也见 MyERP 顶栏右侧「当前门店 Three Latte」。

**形态（对标 MyERP）**：
- 顶部横栏右侧显示 `[当前门店: Three Latte ▼]`
- 点击展开下拉：全部店铺 / Three Latte ✓ / Eight Middle / Polarwind ...
- 切换后：
  - Pinia store 更新 `currentStoreId`
  - URL query 加 `?store_id=xxx`
  - 触发全局事件 `store-changed`
  - 所有列表页刷新

### 6.2 后端 store_id 全站贯通

#### 6.2.1 DDL 迁移（**必须一次做完**）

```sql
-- 现有表加 store_id
ALTER TABLE collect_items ADD COLUMN store_id BIGINT REFERENCES app_stores(id);
ALTER TABLE app_products ADD COLUMN store_id BIGINT NOT NULL REFERENCES app_stores(id);
ALTER TABLE orders ADD COLUMN store_id BIGINT NOT NULL REFERENCES app_stores(id);
ALTER TABLE order_notes ADD COLUMN store_id BIGINT REFERENCES app_stores(id);
ALTER TABLE ai_image_records ADD COLUMN store_id BIGINT REFERENCES app_stores(id);
ALTER TABLE listing_jobs ADD COLUMN store_id BIGINT NOT NULL REFERENCES app_stores(id);

-- 强化联合唯一（同店内 offer_id 唯一，跨店可重）
ALTER TABLE app_products DROP CONSTRAINT app_products_offer_id_key;
CREATE UNIQUE INDEX idx_products_store_offer ON app_products (store_id, offer_id);

-- 库存分店隔离
CREATE TABLE product_stock (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT REFERENCES app_products(id),
  store_id BIGINT NOT NULL REFERENCES app_stores(id),
  warehouse_id BIGINT REFERENCES app_warehouses(id),
  stock INT NOT NULL DEFAULT 0,
  reserved INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(product_id, store_id, warehouse_id)
);

-- 索引
CREATE INDEX idx_products_store_state ON app_products (store_id, ozon_state);
CREATE INDEX idx_orders_store_status ON orders (store_id, status);
CREATE INDEX idx_collect_store_status ON collect_items (store_id, status);
```

#### 6.2.2 API 契约

**所有列表 API 必须支持 store_id**：

```
GET /api/products?store_id=xxx&tab=selling&last_id=...
GET /api/orders?store_id=xxx&tab=awaiting_packaging&last_id=...
GET /api/collect?store_id=xxx&status=pending
GET /api/inventory?store_id=xxx
```

**特殊值**：
- `store_id=all` → 返回该用户所有店铺（后端 join app_users_stores）
- 不传 → 默认使用 user.default_store_id

#### 6.2.3 后端权限校验

```js
middleware.checkStoreAccess(req, res, next) {
  const { store_id } = req.query;
  if (store_id === 'all') {
    // 允许，后端过滤 user_stores
    return next();
  }
  const userStores = getUserStores(req.user.id);
  if (!userStores.includes(Number(store_id))) {
    return res.status(403).json({ error: 'no access to this store' });
  }
  next();
}
```

### 6.3 商品库存隔离（用户 AC 3 核心要求）

**核心原则**：**同一款商品，在 A 店和 B 店的库存必须独立**。

数据模型：
- `app_products` (product_id, store_id, offer_id) 每店铺独立一条
- `product_stock` (product_id, store_id, warehouse_id, stock) 每仓库独立
- 库存修改必须指定 `store_id + warehouse_id`

UI 反馈：
- 商品列表库存列 hover 显示：`当前店铺 Three Latte: 10 (CEL 陆空: 10)`
- 切换到"全部店铺"时库存列显示：`Three Latte: 10 / Eight Middle: 5 / Polarwind: 0`（拼接展示）
- 库存管理页始终按 `store_id` 过滤

### 6.4 采集箱多店同发的库存分配

```
用户在采集箱[送入上架]选 3 家店 + 填初始库存 100
    ↓
后端为每店创建：
  app_products (store_id=1, offer_id=jz-xxx, ...)
  product_stock (product_id=A, store_id=1, warehouse_id=CEL, stock=100)
  app_products (store_id=2, ...)
  product_stock (store_id=2, stock=100)
  app_products (store_id=3, ...)
  product_stock (store_id=3, stock=100)

各店独立管理，互不影响
```

### 6.5 关键 AC

| ID | Given / When / Then |
|---|---------------------|
| **AC-MS01** | Given 顶部切店铺；Then URL 加 store_id；所有列表页 loading→刷新 |
| **AC-MS02** | Given "全部店铺"筛选；Then 商品列表新增"店铺"列，同一 offer_id 在不同店的记录分别显示 |
| **AC-MS03** | Given 在 Three Latte 改某商品库存为 5；Then 只影响 Three Latte 的 product_stock，其他店纹丝不动 |
| **AC-MS04** | Given 用户无某店权限；When 手改 URL store_id=X；Then 后端 403 拦截 |
| **AC-MS05** | Given 采集箱送入上架选 3 店；Then 生成 3 条 app_products + 3 条 product_stock 记录，各带独立 store_id |
| **AC-MS06** | Given 订单同步；Then 每个订单必须带 store_id（来自 Ozon 请求时的 client_id → 反查店铺） |

---

## 7. 完整功能对照表（v0.3.0 交付范围）

| 模块 | 子页 | 状态 | 参考 | 优先级 |
|-----|-----|-----|-----|-------|
| 仪表盘 | / | 已有 | 补商品/订单卡片 | P1 |
| **采集** | /products/collect | v2.0 已定 | **熊猫** | **P0** |
| **采集** | 编辑 Modal | v2.0 已定 | **熊猫** | **P0** |
| **采集** | 店铺选择弹窗 | v2.0 已定 | **熊猫** | **P0** |
| **商品** | /products/list | 本文档 §3.2 | **MyERP** | **P0** |
| **商品** | 编辑 Modal（复用采集） | v2.0 §4 | 熊猫 Modal 形态 | **P0** |
| **商品** | /products/inventory | §3.3 | **MyERP** | **P0** |
| **商品** | /products/listing-history | §3.4 | MyERP | P1 |
| **商品** | /products/relist | §3.5 | MyERP | P1 |
| **选品** | /selection/top-list | §2.2 | **MyERP** | **P0** |
| **选品** | /selection/category-analysis | §2.3 | MyERP | P1 |
| **选品** | /selection/china-zone | §2.4 | MyERP | P1 |
| **AI** | /ai-tools/product-image-set | §4.2 | **MyERP** | **P0** |
| **AI** | /ai-tools/image-editor | §4.3 | MyERP | P1 |
| **AI** | /ai-tools/prompt-generator | §4.4 | 用户诉求 | P1 |
| 订单 | /orders/list | v2.0 §3 | **MyERP** | **P0** |
| 订单 | 详情右滑抽屉 4 Tab | v2.0 §3.2 | **MyERP** | **P0** |
| 订单 | 批量备货 | v2.0 §3.3 | MyERP | **P0** |
| 订单 | 批量面单 PDF 合并 | v2.0 §3.4 | MyERP | **P0** |
| 消息 | /messages | v1 定义 | — | P1 |
| 多店铺 | 全站 store_id 贯通 | §6 | MyERP + 用户诉求 | **P0** |

**P0 = 11 个模块**，v0.3.0 必须全做。

---

## 8. 交付计划

按依赖顺序，每步做完必走 §11 回归清单：

| 序 | Week | 功能 | 预估 | 依赖 |
|---|------|-----|-----|-----|
| 1 | 0 | 组件基座（Vue 3 + Element Plus + 5 基础组件）+ DDL 迁移 | 4d | 无 |
| 2 | 1 | 多店铺切换器 + store_id 全站贯通 | 2d | 1 |
| 3 | 1 | 采集箱三层（列表 + 编辑 Modal + 店铺选择） | 6d | 1, 2 |
| 4 | 2-3 | 商品列表（含铅笔行内编辑 + 复用编辑 Modal + 批量）+ 库存管理 | 6d | 3 |
| 5 | 3 | 订单列表（5 列 + 右滑抽屉 4 Tab） | 3d | 1, 2 |
| 6 | 4 | 订单批量备货 + 批量面单 PDF | 4d | 5 |
| 7 | 4 | 选品-榜单选品 + 一键跟卖 | 3d | 采集 |
| 8 | 5 | **AI 商品套图**（左右两栏 + AI 帮写 + 8 张流式生成 + 推送 Ozon） | 4d | 组件基座 |

**总计 32 人日 / 6 周**（1 人开发 + 联调 + 回归）

**关键节点**：
- Week 1 结束：多店铺 + 采集箱 Demo，用户可看到最基础的采集→编辑闭环
- Week 3 结束：商品列表 + 采集全通，用户可完成"采集→编辑→上架→改价"闭环
- Week 4 结束：订单全通，用户可完成"发货→打面单"闭环
- Week 5 结束：**AI 套图上线**，用户可完成"上架→生成套图→推送 Ozon"完整链路

---

## 9. 组件规范（延续 v1 §4）

见 [siboman-0.2.0-全功能定义与组件规范.md](siboman-0.2.0-全功能定义与组件规范.md) §4。

**本次新增强调**：
1. `<InlineEditCell>` 组件 —— 铅笔图标行内编辑通用组件（价格/库存/货源都用它）
   ```js
   props = {
     value,
     type: 'number' | 'text' | 'currency',
     currency: 'CNY',
     validator: (v) => v > 0,
     onSave: (v) => Promise<void>  // 内部处理 loading/toast
   }
   ```
2. `<AutoSyncToggle>` 组件 —— 自动同步开关 + 立即同步按钮组合
3. `<ShopSwitcher>` 组件 —— 全站店铺切换器
4. `<AIImageGenPanel>` 组件 —— AI 套图左右两栏布局（也可用于 AI 改图）

---

## 10. API 契约（配套）

### 10.1 商品

| Method | 路径 | 说明 |
|--------|------|-----|
| GET | `/api/products?store_id=&tab=&price_index=&search=&last_id=` | 列表（含 6 Tab + 价格指数筛选） |
| PATCH | `/api/products/:offer_id/field` | 单字段更新（`{key:'price',cny:100}`），行内编辑用 |
| PATCH | `/api/products/:offer_id/purchase` | 录入采购价（`{price_cny:12,remark:''}`） |
| POST | `/api/products/sync-now` | 立即同步 |
| POST | `/api/products/auto-sync-toggle` | 开关自动同步 |

### 10.2 选品

| Method | 路径 | 说明 |
|--------|------|-----|
| GET | `/api/selection/top-list?type=hot&period=28&category=&sku_batch=&filters=` | 榜单选品数据 |
| POST | `/api/selection/follow` | 一键跟卖（`{sku, target_stores:[], price_adjustment:'+10%'}`） |
| POST | `/api/selection/batch-add-draft` | 批量加入草稿箱（`{skus:[], target_stores:[]}`） |
| GET | `/api/selection/category-analysis?period=28&currency=RUB&category=` | 类目分析 |

### 10.3 AI 套图

| Method | 路径 | 说明 |
|--------|------|-----|
| POST | `/api/ai/product-image-set/write` | AI 帮写卖点 |
| POST | `/api/ai/product-image-set/generate` | 一键生成 8 张套图（返回 task_id，前端 SSE 或轮询获取每张 URL） |
| GET | `/api/ai/product-image-set/task/:task_id` | 查询任务状态和已生成图 |
| POST | `/api/ai/product-image-set/push-ozon` | 推送单张到 Ozon 商品图库 |
| POST | `/api/ai/prompt-generator/from-1688` | 从 1688 URL 生成卖点+俄语标题+Prompt |
| GET | `/api/ai/history?type=set|editor|prompt&last_id=` | 生成历史 |

### 10.4 多店铺

| Method | 路径 | 说明 |
|--------|------|-----|
| GET | `/api/stores` | 用户所有店铺列表 |
| PATCH | `/api/user/default-store` | 设默认店 |

---

## 11. 上线回归清单（**82+ 项，勾不完不上线**）

### 11.1 采集箱（v2 §11.1，22 项，保留）

### 11.2 商品列表（22 项，本次强化）

- [ ] 6 Tab 计数正确（全部/销售中/准备出售/错误/待修改/已下架/已归档）
- [ ] 价格指数筛选（全部/超值/有利/中等/不利）生效
- [ ] 顶部[🔴 自动同步]开关可 toggle 状态持久化
- [ ] 顶部[🔄 立即同步]点击后 loading + toast
- [ ] 表格 7 列 + 复选 + 操作
- [ ] 商品信息列：图 + 俄文标题 + 货号 + SKU 齐全，两个复制按钮生效
- [ ] 状态列 "N 项异常" badge 点击弹详情
- [ ] 价格列 ✏️ 图标点击进入行内编辑
- [ ] 价格编辑 Enter 保存，Esc 取消，[√]保存，[取消]取消
- [ ] 价格编辑保存单元格闪绿 + toast
- [ ] 库存 ✏️ 编辑生效
- [ ] 库存 hover 显示各仓分布
- [ ] 货源列未录入显示[+ 录入采购价]，点击弹小面板
- [ ] 货源已录入显示 ¥N + ✏️
- [ ] 最后同步 tooltip 显示完整时间
- [ ] 操作列 [编辑][体检][同步][⋯] 齐全
- [ ] 点[编辑]打开 Modal（与采集箱同一组件）
- [ ] Modal 内 offer_id 只读
- [ ] Modal 底栏[保存并同步 Ozon]
- [ ] 5 个批量操作齐全
- [ ] 批量下架有二次确认
- [ ] Cursor 分页切页保留滚动

### 11.3 选品-榜单选品（12 项）

- [ ] 4 子 Tab 切换生效
- [ ] 7天/28天 切换
- [ ] 币种 ₽/¥ 切换
- [ ] 选品策略快速筛选
- [ ] 一级类目横向 Tab
- [ ] 筛选器 8 字段齐全
- [ ] 批量 SKUS 支持逗号/空格/换行
- [ ] 表格机会判断 badge 正确
- [ ] 环比箭头颜色（涨红/跌绿反过来符合中国习惯）
- [ ] [一键跟卖]弹目标店铺 + 售价调整
- [ ] [批量加入草稿箱]生效
- [ ] 一键跟卖成功后自动创建 collect_items

### 11.4 AI 商品套图（15 项，**用户明确要求补回**）

- [ ] 页面能打开，左右两栏布局
- [ ] 上传原图支持 拖拽/点击/Ctrl+V/⌘+V
- [ ] 单张 >10MB 拒绝上传 + toast
- [ ] 生成模型下拉可选
- [ ] 平台默认 OZON
- [ ] 语言默认俄，可切中/英
- [ ] 比例 Radio 3:4/1:1/4:5
- [ ] 卖点文本框可输入
- [ ] [AI 帮写]调 AI 自动填充卖点 4 段
- [ ] [一键生成]余额不足 disabled + tooltip
- [ ] 生成时二次确认弹窗显示消耗币数
- [ ] 生成过程流式展示（先出的先显示）
- [ ] 每张右上角[⋆推送 Ozon][↓下载][🔄重生成]
- [ ] [↓下载全部]zip 打包
- [ ] 生成失败退款 + 明确错误提示
- [ ] 记录写入 ai_image_records 表
- [ ] 「生成记录」页可查

### 11.5 订单模块（v2 §11.3，22 项，保留）

### 11.6 多店铺（12 项，本次强化）

- [ ] 全站店铺切换器位置一致（顶栏右侧）
- [ ] 切换后 URL 加 store_id
- [ ] 所有列表页自动刷新
- [ ] "全部店铺"筛选商品列表显示"店铺"列
- [ ] 采集箱多店同发生成 N 条 listing_jobs + N 条 app_products
- [ ] 商品库存跨店隔离（改 A 店不影响 B 店）
- [ ] 订单按 store_id 分组显示店铺列
- [ ] 无权限店铺 URL 篡改被 403 拦截
- [ ] 用户默认店可设
- [ ] product_stock 表按 (product_id, store_id, warehouse_id) 唯一
- [ ] 库存管理页始终按 store_id 过滤
- [ ] listing_jobs / orders / ai_image_records 都带 store_id

### 11.7 数据闭环（8 项，本次新增）

- [ ] 采集→上架→商品的 offer_id 全程一致
- [ ] Ozon 返回的 product_id 落入 app_products.ozon_product_id
- [ ] 订单里 SKU 能反查回 app_products（通过 store_id + ozon_sku）
- [ ] 订单详情"采购溯源"块显示的 purchase_remark 来源正确
- [ ] AI 套图推送 Ozon 后能在商品列表看到新图
- [ ] 30min 定时同步不覆盖用户手动修改（时间戳对比）
- [ ] 批量备货成功扣减对应 store 的 product_stock（开关打开时）
- [ ] 跨模块 store_id 一致（点采集箱→商品→订单，同一店铺不切换）

**合计 113 项**。

---

## 12. 与 TL/用户的确认清单

- [x] 采集参考熊猫（三层结构 + Modal） —— v2 已定
- [x] 选品参考 MyERP（3 子页 + 榜单 4 Tab + 一键跟卖） —— 本文档 §2
- [x] 商品参考 MyERP（6 Tab + 铅笔行内编辑 + 价格指数 + 自动同步开关） —— 本文档 §3
- [x] AI 商品套图补回（左右两栏 + AI 帮写 + 8 张流式 + 推送 Ozon） —— 本文档 §4
- [x] 数据闭环画图（1688 → ERP → Ozon 全流程 + ID 对齐规则） —— 本文档 §5
- [x] 多店铺商品/库存隔离（DDL + API + UI + 权限） —— 本文档 §6
- [x] 上线回归 113 项 —— 本文档 §11

---

## 13. 附录：本轮实机截图索引

**MyERP 选品**：
- `screenshots/v4/myerp-selection/00_sidebar.png` — 侧栏
- `screenshots/v4/myerp-selection/01_page1_top.png` + `02_page1_bottom.png` — 类目分析
- `screenshots/v4/myerp-selection/03_page2_top.png` ⭐ — 榜单选品（本次核心）
- `screenshots/v4/myerp-selection/04_page2_bottom.png`
- `screenshots/v4/myerp-selection/05_page3_top.png` + `06_page3_bottom.png` — 中国专区

**MyERP 商品**：
- `screenshots/v4/myerp-products/00_sidebar.png` — 侧栏
- `screenshots/v4/myerp-products/01_list_top.png` ⭐ — 商品列表顶部（本次核心）
- `screenshots/v4/myerp-products/02_list_bottom.png`
- `screenshots/v4/myerp-products/05_edit.png` — 编辑新页面
- `screenshots/v4/myerp-products/06_inv_top.png` — 库存管理

**AI 工具**：
- `screenshots/v4/ai-tools/myerp_00_sidebar.png` — 侧栏
- `screenshots/v4/ai-tools/myerp_01_ai_top.png` — AI 改图神器
- `screenshots/v4/ai-tools/myerp_03_ai_set.png` ⭐ — AI 商品套图（本次核心）
- `screenshots/v4/ai-tools/xiongmao_01_gptimg.png` — 熊猫 GPT-Image2
- `screenshots/v4/ai-tools/xiongmao_02_nanoai.png` — 熊猫 NanoAI（含俄语提示词模板）

---

*文档版本：v3.0 全闭环终版 · 2026-07-03 · 产品经理*
*本文档 = siboman 0.3.0 唯一功能契约。任何字段/交互调整必须回文档评审。*
