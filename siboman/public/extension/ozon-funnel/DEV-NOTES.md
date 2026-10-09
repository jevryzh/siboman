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

```bash
cd siboman/public/extension/ozon-funnel
zip -qr ../ozon-funnel.zip manifest.json content.js README.md   # 显式列出，别用 .
```

**别用 `zip -r ../ozon-funnel.zip .`** —— 会把本文件也打进去。
