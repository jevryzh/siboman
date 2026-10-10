# 开发笔记（**不要打进 zip**，商用发布包只含 manifest.json / content.js / README.md）

## 数据来源（实测，非猜测）

被 Premium 拦住的是**前端 UI**，数据接口本身不拦。用当前登录会话直接调即可：

```
POST {origin}/api/site/seller-analytics/charts/v3/table/totals   总计与平均值
POST {origin}/api/site/seller-analytics/charts/v3/table/by_sku   按 SKU 明细
```

必需请求头：

| 头 | 值 | 说明 |
|---|---|---|
| `x-o3-company-id` | 当前登录账号的 `company_id` | **必须**，缺了报 `PermissionDenied: Failed to get company ID` |
| `x-o3-app-name` | `seller-ui` | |
| `x-o3-language` | `zh-Hans` / `ru` / `en` | ⚠️ 见下方坑 |
| `x-o3-page-type` | `analytics_graph` | |

`company_id`（= 店铺 Client-Id）取法，按优先级：
1. `localStorage.vuex` → `user.contentId`
2. cookie `sc_company_id`
3. 页面主世界的 `window.__companyId`（内容脚本读不到，isolated world）

## 免费可用的 20 个指标

探测方式：对每个候选名词单独发一次 `by_sku`，看返回 200 还是 400。

```
revenue  sold_revenue  ordered_units  delivered_units  avg_price  avg_sold_price
discount_share_of_median_price
conv_views_to_order  total_views  total_hits_to_cart  conv_total_views_to_cart
pdp_views  hits_pdp_to_cart  conv_pdp_views_to_cart
search_position  search_views  hits_search_to_cart  conv_search_views_to_cart
cancelled_units  returned_units          # ← 后补的：取消数量 / 退货数量
```

⚠️ 全是**件级**（units）。订单级（posting）的取消数这个接口**没有**：
`cancelled_orders` / `cancellations` / `cancel_orders` / `orders_cancelled` / `cancel_count` 等
候选名要么 400，要么 200 但返回空对象 `{}`（等于没这个字段）。

注意：Ozon 后台内部接口用的是**短名**，和公开 Seller API（`/v1/analytics/data`）完全不同。
公开 API 的 `hits_view_search` / `position_category` / `conv_tocart_pdp` 在这边一律 400。
另外公开 API 有 429 每秒限流，内部接口没有。

**真·会员专属（400，拿不到）**：`price_index`、`drr`、`days_in_promo`、`days_in_trafarets`、
`last_stock`、`stockout_days`、`reviews_count`、`rating`、`recommended_supply`、`returns`、
`cancellations`、`gmv`、`profit`、`commission`、`ctr`、`favorites` 等 44 个。

## 订单级数量（取消订单 / 已送达订单）

分析接口只有件级，订单级要单独问卖家后台的 posting-service（**同样只需页面会话，不需要 Api-Key**）：

```
POST {origin}/api/posting-service/v2/fbs/posting/count/by-status-alias
body: {
  company_id: "<company_id>",          // ⚠️ 必须放 body，只放 header 会 403 Failed to get body company ID
  processed_at_from: "2026-10-02T00:00:00+08:00",
  processed_at_to:   "2026-10-08T23:59:59+08:00",
  status_alias: ["cancelled", "delivered", ...]
}
→ {"result":[{"status_alias":"cancelled","count":0}, ...]}
```

合法状态别名（接口把允许值直接列在 400 报错里）：
`awaiting_packaging` `awaiting_deliver` `arbitration` `delivering` `delivered` `cancelled`
`driver_pickup` `not_accepted` `client_arbitration` `acceptance_in_progress`
`awaiting_registration` `sent_by_seller`

时间用**浏览器本地时区**：Ozon 用 cookie `x-o3-timezone` 跟随本地（实测 `-480` = UTC+8），
所以 `localTzSuffix()` 拼的是 `+08:00`。

订单页路径是 `/app/postings/fbs`（`/app/orders` 是 404）。

## 搜索可见性 / 查词排位（两块新功能）

### 主接口（免费可用）

```
POST {origin}/api/search-query-analytics/v1/cjm/get-seller-analytics
body: { seller_id, period_from, period_to, count_total_items, page_number, items_per_page,
        sort_by, sort_direction, filters: { categories: [], search: "" } }
→ { skus: [...], totalNumberOfItems, totalPagesCount }
```
支持服务端搜索（`filters.search`）、排序、真分页（有总数，每页最多 500）。

列定义可以问接口要：`GET /v1/cjm/get-seller-analytics-table-headers?seller_id=`，
返回每列的 key / metricType / premium / hints。

**8 列里 4 列是真·Premium 锁**（服务端直接返回空字符串，`premium.lockMode = "FULL"`）：
`uniqueViewUsers`、`searchPosition`、`queryCtrInteract`、`queryCtrOrder`。
免费能拿到的是：`visibility`（可见度）、`uniqueSearchUsers`（曾搜索人数）、
`uniqueOrdersCount`（订购件数）、`gmv`（订购金额）。

### 查词排位接口（免费，能拿到位置）

```
POST {origin}/api/search-query-analytics/v2/external/explanation_by_id
body: { sellerId, query, skus: [], uuid: <地区>, sortOption: { headerKey, direction },
        itemsPerPage, pageNumber, onlyCurSellerItems, applicationScope: "SCOPE_BIG_OZON" }
→ { headers: [...], items: [...], totalNumberOfItems, totalPagesCount, categories }
```
返回 13 列（位置 / 商品 / 综合分数 / 状态 / CPC 出价 / CPO 出价 / 匹配度 / 评价 / 价格 …）。
单元格结构：`items[].values[colIndex].values[0]` → 要么 `label.value`，要么 `itemInfo`（商品卡）。

配套：
- `GET /v1/get-dates?seller_id=` → 可用区间
- `POST /v1/external/available_locations {sellerId, prefix}` → 地区列表
- `POST /v1/external/explain_suggest {sellerId, skus, filter}` → 搜索词建议
- `GET /v1/get-seller-premium-status?company_id=` → 会员状态

### ⚠️⚠️ 这个接口最大的坑：`403 {"code":7,"message":"no premium"}`

它**几乎总是和会员无关**，而是**日期区间不对**。实测（2026-10-10）：

| 请求区间 | 结果 |
|---|---|
| 2026-10-02 ~ 2026-10-08 | ✅ 200 |
| 2026-10-03 ~ 2026-10-08 | ❌ 403 no premium |
| 2026-10-04 ~ 2026-10-08 | ❌ 403 |
| 2026-10-01 ~ 2026-10-07 | ❌ 403 |
| 2026-09-25 ~ 2026-10-01 | ❌ 403 |

也就是说**只认一个固定长度的窗口**（当时是 7 天），而且必须**整体落在可用区间内**。
排查时踩了两个连环坑：
1. 只把结束日往前截（7 天截成 6 天）→ 照样 403。**必须整体平移，保持跨度不变。**
2. 一度以为是请求头 `x-o3-page-type` 的问题 —— 实测传 `analytics-search` /
   `analytics_graph` / `analytics` / 不传，结果完全一样，**与请求头无关**。

现在的做法（`svClampRange`）：
- `GET /v1/get-dates` 拿到 `actual.to`
- 算出最后一个可用本地日：该日 `23:59:59.999`（本地）≤ `actual.to`（注意不能直接把
  `period_to` 设成 `actual.to` 本身，那也会被拒）
- 若请求区间超出，**整体左移相同天数**（保持跨度），而不是截断

另外注意：这两个模块**必须先 `detectCompanyId()`**。原来只有「我的商品销售」的 `load()` 里赋值，
直接切到搜索可见性时 `x-o3-company-id` 是空的 → 同样 403。

## 接口硬限制

| 限制 | 表现 | 处理 |
|---|---|---|
| `limit` ≤ 50 | 超了 400 `limit must be > 0 and <= 50` | 固定 50，翻页 |
| `offset` < 1000 | 超了 400 `offset must be < 1000` | 最多 20 页 = 1000 行 |
| `dimension` 必填（公开 API） | 400 | 内部接口不需要 |
| 不支持服务端按货号/SKU 过滤 | `query`/`search`/`sku`/`article`/`skus` 都无效，返回不变 | 搜索在本地做 |

响应结构：`{ items: [{ productInfo: { sku, name, article, image }, metrics: {...} }], nextOffset }`
—— **没有 total 字段**，靠 `items.length < limit` 判断到底。

## 踩过的坑

1. **`x-o3-language` 传 `zh-CN` 会静默返回空商品信息。**
   接口照样 200，但 `productInfo` 的 `name` / `article` / `image` 全是空字符串 ——
   表现是「商品那一列什么都没有」。必须是 `zh-Hans` / `ru` / `en`。

2. **日期口径不含今天。**
   Ozon 后台的「7 天」= `today-7 ~ today-1`（今天数据不完整，不计入）。
   写成 `today-(N-1) ~ today` 会多算今天的单，数字比后台大。
   实测（2026-10-09，某店铺）：后台 10-02~10-08 → 14 单；含今天 10-03~10-09 → 15 单。

3. **`render()` 里用 `setAttribute("style", ...)` 会整体覆盖内联样式。**
   折叠逻辑如果只在按钮回调里设 `display:none`，随后 `render()` 一覆盖就失效 ——
   表现为「收起点了没反应」。display 必须由 `render()` 统一写。

4. **表格全屏时面板自身也要 `box-sizing:border-box`。**
   只给 `#panel *` 设不加自身的话，`width:100vw` + 左右 padding 会比屏幕宽，
   最右一列被裁掉。

5. **后台补数循环必须 try 住。**
   否则 `offset` 过界抛 400 会把已经加载好的整份数据清空。

## 不要做的事（合规）

不要改写成「伪造会员状态」那类做法：改写页面 `fetch` / `XMLHttpRequest`，
把 `/premium/status`、`/analytics/graphs` 的响应替换成
`{"is_premium":true,"graphsAccess":true}` 骗前端解锁。那类做法：

- 违反 Ozon ToS，卖家账号有被风控的风险
- 会干扰页面路由（实测会把「我的商品销售」弹回「销售漏斗」）
- 有的实现里还塞了 `Math.random()` 生成的假数字

本插件只用当前登录会话读 Ozon 自己返回的真实数据，不碰会员状态、不改页面逻辑、不上传数据。

## 打包

### 开发版（自己维护/内部测试用，代码可读）

```bash
cd siboman/public/extension/ozon-funnel
zip -qr ../ozon-funnel.zip manifest.json content.js README.md   # 显式列出，别用 .
```

**别用 `zip -r ../ozon-funnel.zip .`** —— 会把本文件也打进去。

### 混淆发布版（对外分发用）

```bash
npm run build:ext:release
# 等价于 node scripts/build-extension-release.mjs
```

产出：
- `public/extension/ozon-funnel/dist/`（混淆后的解压目录，已 gitignore）
- `public/extension/ozon-funnel.release.zip`（对外分发的安装包）

脚本的取舍：
- 压缩 + 混淆都由 `javascript-obfuscator` 完成
- `stringArray` + `base64` + `splitStrings`：接口路径、请求头名收进字符串数组
- **`transformObjectKeys` 单独开不够**：与 `stringArrayThreshold:1` + `splitStrings`
  组合时，对象字面量的 key（如 `"x-o3-company-id"`）会漏出来。所以源码里请求头一律用
  **计算属性名**构造（`h["x-o3-company-id"] = ...`），不依赖混淆配置，确定性隐藏。
- 脚本末尾有**自检**：混淆后若还能 grep 到 `seller-analytics` / `posting-service` /
  `x-o3-company-id` 就直接报错，防止以后配置回退导致泄露。
- **故意不开 `debugProtection`**：它会让开发者工具卡死，而卖家本来就要用 F12 看后台。
- `selfDefending` 开着：改一行或格式化一下就崩，显著抬高「读一遍再改写」的成本。

实测（v1.4.0）：源码 33.5 KB → 混淆后 95.8 KB（2.9×）；
装进真实 Chrome 跑通，面板注入 / 1000 行数据 / 订单汇总 / 400 个复制按钮全部正常，无报错。

### ⚠️ 混淆不是防护

代码一定在用户机器上，混淆只提高门槛，**挡不住抓包**（F12 一看请求就知道调了哪个接口）。
真想防住「复制 zip 就能用」，只能上**服务端授权校验**；否则靠持续更新 + 商店合规。

## 发布检查清单

- [ ] `node --check public/extension/ozon-funnel/content.js`
- [ ] `npm run build:ext:release`（自检会拦字符串泄露）
- [ ] 装混淆版到 Chrome 实测一次（面板能出数、无 console 报错）
- [ ] 确认发布 zip 里**只有** `manifest.json` / `content.js` / `README.md`
- [ ] 对外只发 `ozon-funnel.release.zip`；开发版 `ozon-funnel.zip` 别外传
