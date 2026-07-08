# 逐梦 ERP 移交文档 (v2.1.10)

> **当前版本**: v2.1.10（BatchUpload 通信层 5 bug 全修 + type_id 历史反查兜底）
> **历史移交版本**: v0.8.0-final (commit `28af7a7`)
> **移交日期**: 2026-07-08
> **分支**: `handover-v0.8.0-final`
> **测试环境**: `test.renwz.cn` (Port 5178, `root@47.104.86.62`)
>
> **新文档**: [`CHANGELOG.md`](./CHANGELOG.md) · [`HANDOVER_v2.1.10.md`](./HANDOVER_v2.1.10.md)（v2.1.x 30 轮调试增量交接）

---

## 目录

1. [项目结构](#项目结构)
2. [中继采集插件工作原理](#中继采集插件工作原理)
3. [CNY 店铺财务纠偏逻辑](#cny-店铺财务纠偏逻辑)
4. [核心模块清单](#核心模块清单)
5. [环境配置说明](#环境配置说明)
6. [部署流程](#部署流程)
7. [待办事项](#待办事项)

---

## 项目结构

```
逐梦 ERP/
├── siboman/                    # 主项目代码
│   ├── server.js               # 后端 Node.js (ESM, ~8000行)
│   ├── app.js                  # 后端入口
│   ├── package.json
│   ├── public/                 # 前端 (CDN Vue3 + Element Plus)
│   │   ├── index.html          # SPA 入口, 含所有 script 引用
│   │   ├── js/
│   │   │   ├── main.js         # Vue App + 路由 + 侧边栏 + axios 拦截器
│   │   │   ├── views/          # 业务视图组件
│   │   │   │   ├── Dashboard.js
│   │   │   │   ├── ProductList.js
│   │   │   │   ├── OrderList.js
│   │   │   │   ├── InventoryManagement.js
│   │   │   │   ├── BatchUpload.js       # 批量跟卖 (核心)
│   │   │   │   ├── AIImageGenerator.js
│   │   │   │   ├── StoreManagement.js
│   │   │   │   ├── CollectionBox.js
│   │   │   │   └── SourcingModule.js
│   │   │   └── components/
│   │   │       └── ShopSwitcher.js
│   │   └── extension/          # 浏览器采集插件
│   │       └── zhumeng-collector/
│   │           ├── manifest.json
│   │           ├── background.js       # SW: SKU 采集核心
│   │           ├── content-bridge.js   # ERP↔插件 postMessage 桥
│   │           ├── popup.html/js       # 插件弹窗
│   │           └── icons/
│   └── public/extension/zhumeng-collector.zip
├── extension_ref/              # 参考插件 (0.13.47.1, 仅参考)
├── deploy-test.sh              # 部署脚本 (被 .gitignore 排除)
├── siboman-0.3.0-全闭环终版PRD.md  # 原始 PRD
└── HANDOVER_GUIDE.md           # 本文件
```

---

## 中继采集插件工作原理

### 架构: "网页指令 → 插件执行 → 数据回传"

```
ERP 页面 (main world)                    插件 content-bridge (isolated world)        插件 background SW                seller.ozon.ru tab
    |                                            |                                           |                              |
    |-- postMessage({__zhumeng_proto:            |                                           |                              |
    |   "zhumeng-v1", kind:"collect.request",    |                                           |                              |
    |   skus:["4425674396"]}) ---------------->  |                                           |                              |
    |                                            |-- chrome.runtime.sendMessage ------------> |                              |
    |                                            |   {action:"collectSkus", skus}            |                              |
    |                                            |                                           |-- ensureSellerTab() ------->|
    |                                            |                                           |-- scripting.executeScript ->|
    |                                            |                                           |   fetch /api/v1/search ----->|  (SKU → variant_id)
    |                                            |                                           |   fetch /api/site/...  ----->|  (variant_id → 完整商品)
    |                                            |                                           |<-- JSON (item) --------------|
    |                                            |                                           |-- distillItem()              |
    |                                            |<-- {results, errors} ---------------------|                              |
    |<-- postMessage({kind:"collect.response",   |                                           |                              |
    |    results:{...}}) ----------------------  |                                           |                              |
    |                                            |                                           |                              |
    渲染预览表 ←——————————————————————————————————|———————————————————————————————|——————————————————————————————|
```

### 关键协议: `__zhumeng_proto`

- **不能用 `__proto`**: 它是 JS 原生原型链属性名, 会被引擎拦截
- **不能用 `event.source !== window`**: content script isolated world 的 window !== main world window
- **正确做法**: `data["__zhumeng_proto"] === "zhumeng-v1"` + `postMessage(..., '*')`

### 采集链路 (background.js)

1. `ensureSellerTab()`: 查找/打开 `seller.ozon.ru` 标签页
2. `searchVariant(sku, tabId)`: `POST /api/v1/search` → `variant_id` + `company_id`
3. `fetchBundleByVariantId(sku, variantId, companyId, tabId)`: `POST /api/site/seller-prototype/create-bundle-by-variant-id` → 完整商品 JSON
4. `distillItem(rawItem)`: 提取 name/images/weight/dimensions/description_category_id/type_id/attributes

### Session 探测 (v1.0.3)

三层 fallback:
1. `chrome.cookies.getAll({url: "https://seller.ozon.ru"})` → 有登录 Cookie = 已连接
2. `chrome.tabs.query({url: "https://seller.ozon.ru/*"})` → 有 tab = 已连接
3. `fetch("https://seller.ozon.ru/api/site/seller-prototype/get-user-info")` → 200 = 已连接

---

## CNY 店铺财务纠偏逻辑

### 核心问题

Ozon 返回两种 currency_code:
- `posting.products[i].currency_code` = **卖家真实结算币** (CNY/USD)
- `financial_data.products[i].currency_code` = **Ozon 平台核算币** (通常 RUB)

**之前的 Bug**: 代码用 `fd.currency_code || "RUB"` 兜底, 导致 CNY 店铺的 144 元被当 144 卢布 × 0.0862 = ¥12.41 (缩水 94%)

### 正确逻辑 (server.js `/api/seller/orders`)

```js
// v0.3.5c: 优先 posting.products[i].currency_code (卖家结算币)
// financial_data.currency_code 是平台核算币 (RUB), 不代表卖家收款币
const currency = String(
  pd.currency_code ||          // 商品行结算币 (最权威)
  fd.currency_code ||          // fd 币种 (Ozon 平台核算币, fallback)
  p.currency_code ||           // posting 级
  "RUB"
).toUpperCase();
const priceNative = Number(pd.price || fd.price || 0);
// CNY 直读, 严禁 rubToCny; RUB 才 × 0.0862
const priceCny = currency === "CNY" ? priceNative
               : currency === "RUB" ? rubToCny(priceNative)
               : priceNative;
```

### Dashboard 利润计算 (三级回退)

```
1. payout > 0 且 有采购价 → profit = payout - purchase_cost
2. payout > 0 无采购价  → profit = payout × 20%
3. payout = 0 (取消/未结算) → profit = gmv × 20%
```

---

## 核心模块清单

| 模块 | 文件 | 版本 | 核心功能 |
|---|---|---|---|
| 仪表盘 | Dashboard.js | v0.5.6 | KPI 卡片 + 11 列店铺对比 + 7 日趋势 + 全部同步 + 单店同步 |
| 商品管理 | ProductList.js | v0.3.5 | 15 字段编辑抽屉 + 主图预览 + 类目 Cascader + 归档/上架 + AI 填充/核价 |
| 订单管理 | OrderList.js | v0.3.5 | CNY 金额 + 商品图 + 详情抽屉 + 发货对话框 + 日期选择器 |
| 库存管理 | InventoryManagement.js | v0.3.5 | 分仓 hover popover + 4 仓库修改弹窗 + 60px 图片预览 |
| 批量跟卖 | BatchUpload.js | **v2.1.10** | 10 格式解析 + 插件中继采集 + V3 payload + 多店扇出 + 实时日志 + type_id 历史反查兜底 |
| AI 套图 | AIImageGenerator.js | v0.3.8 | 三栏布局 + MiniMax 分析 + 万相 2.7 生图 (6 角色 3:4) |
| 店铺管理 | StoreManagement.js | v0.7.5 | 店铺 CRUD + 插件下载 (v1.0.3) |
| 采集插件 | zhumeng-collector/ | v1.0.3 | postMessage 协议 + Cookie 探测 + SKU 采集 |

---

## 环境配置说明

**⚠️ 配置文件不入 Git, 需单独交付**

### `.env` 文件 (放在 `/opt/ozon/app-test/.env`)

```env
PORT=5178
DATABASE_URL=postgresql://用户名:密码@localhost:5432/数据库名
AUTH_SECRET=随机32位hex
RUB_CNY_RATE=0.0862
DASHSCOPE_API_KEY=阿里云DashScope密钥
MINIMAX_API_KEY=MiniMax密钥
MINIMAX_BASE_URL=https://api.minimax.chat/v1
MINIMAX_MODEL=MiniMax-M3
INITIAL_USERS=用户名:密码:显示名:角色
```

### 数据库

- PostgreSQL, 表: `app_users`, `app_stores`, `app_products`, `collect_items`, `ai_image_records`, `app_jobs`
- `app_products` 关键列: `offer_id`, `sku`, `product_id`, `description_category_id`, `type_id`, `stocks_json`, `currency_code`

---

## 部署流程

```bash
# 1. 本地修改代码
# 2. 执行部署脚本
cd "/Users/eason/Documents/逐梦 ERP"
./deploy-test.sh
# 脚本会: rsync public/ → 远端, scp server.js, chown ozon:ozon, systemctl restart
# 3. 插件更新需单独 scp
scp -i ~/.ssh/ozon_deploy_ed25519 siboman/public/extension/zhumeng-collector.zip root@47.104.86.62:/opt/ozon/app-test/public/extension/
```

---

## 待办事项 (更新于 2026-07-08 16:25)

### 紧急 (P1)
1. **上架历史 + 异步轮询** — 当前 ERP 上架按钮点了就"成功"，Ozon 真实状态（imported/failed）完全没查。PRD 写得很细（[`siboman/docs/requirements/03-listing-history.md`](./siboman/docs/requirements/03-listing-history.md)）但代码没实现。**端点 `/api/seller/import/sync-task` 已写好**（siboman/server.js:2948）但没人调用。1-1.5 人日。

### 一般 (P2)
2. **采集器实测** — 端到端第一次实测：task_id `5027892960` 提交后 8 分钟仍 `pending`（Ozon 队列），需等 Ozon 处理完验证 `imported` 路径
3. **使用说明** — BatchUpload 右侧抽屉文案未写
4. **变体合并** — BatchUpload 的 `attr 9048` 型号名合并逻辑未实装

### 低优 (P3)
5. **UI 最终验收** — Dashboard 排版微调 (KPI 卡片间距、表格列宽)
6. **AI 套图** — 万相 2.7 生图的俄语文字标注质量不稳定, 需调优 prompt

---

## v2.1.x 增量改动 (2026-07-08)

**通信层修了 4 个根因 bug + 1 个数据兜底**，详见 [`HANDOVER_v2.1.10.md`](./HANDOVER_v2.1.10.md) §2/§3:

1. **v2.1.4** — 移除 `content-bridge-main` 转发层（addEventListener 拦截没真绑）
2. **v2.1.5** — `JSON.parse(JSON.stringify(msg))` 剥 Vue 3 reactive Proxy
3. **v2.1.7** — `content-bridge-main` 过滤自己 window 的 `.request` 消息
4. **v2.1.9** — `refreshStatus` 不再覆盖 `extensionConnected.value`
5. **v2.1.10** — `POST /api/seller/type-id-suggestion` 反查同店铺同 cat 历史 type_id 兜底

**端到端第一次实测通过**：测试 SKU `4425674396` → Three Latte 店 → task_id `5027892960` → Ozon `pending`（Ozon 队列处理中）。

---

## 配置文件位置 (单独交付, 不入库)

| 文件 | 本机绝对路径 | 内容 |
|---|---|---|
| 后端配置 | `/Users/eason/Documents/逐梦 ERP/env/server.env` | PORT / DATABASE_URL / OZON_SELLER_* / INITIAL_USERS / MINIMAX_* |
| 本地开发 | `/Users/eason/Documents/逐梦 ERP/env/local.env` | COLLECTOR_* / OZON 默认凭证 |
| 交付用 | `/Users/eason/Documents/逐梦 ERP/handover-config-private/.env` | 服务器端生产凭证（不放在 env/，单独加密交付） |
| 部署脚本 | `/Users/eason/Documents/逐梦 ERP/deploy-test.sh`（已加 .gitignore） | rsync + scp + systemctl restart |

**全部已通过 `.gitignore` 排除**（`env/`、`*.env`、`**/.env`、`handover-config-private/`），不会进 git 仓库。
```
