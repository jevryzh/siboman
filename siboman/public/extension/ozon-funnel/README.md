# Ozon 我的商品销售 / 销售漏斗（独立插件）

在 Ozon 卖家后台直接查看「我的分析 → 我的商品销售」的数据，**不需要 Premium**，独立安装使用，不需要配置任何密钥、不需要服务端。

支持 **18 个免费可用指标**，按 Ozon 自己的分组切换：**数据概览(9) / 销售漏斗(12) / 全部指标(18)**。

## 为什么需要它

Ozon 后台「我的商品销售」里不少列被前端标成 Premium 专属（点「销售漏斗」标签只弹订阅引导、列停在加载骨架），例如：

- 在搜索结果和目录中的位置
- 搜索结果和目录中的展示次数
- 商品卡片访问量
- 从商品卡片添加到购物车的转化率

**但拦住你的是前端 UI，不是数据接口。** 这些数据由 Ozon 自己的接口返回，免费号直接就能拿到。

## 不做的事

本插件**不伪造会员状态**。市面上有些 Ozon 助手插件（如「卖家国度-Ozon AI」「极掌/MY」）的做法是改写页面的 `fetch` / `XMLHttpRequest`，把 `/premium/status`、`/analytics/graphs` 的响应替换成一个假的 `{"is_premium":true,"graphsAccess":true}`，骗前端解锁 UI。那种做法：

- 违反 Ozon ToS，真实卖家账号被风控盯上不划算
- 会干扰页面路由（实测就是它把「我的商品销售」弹回「销售漏斗」的元凶）
- 有的伪造体里还塞了 `Math.random()` 生成的假数字

本插件只是用当前登录会话读 Ozon 自己返回的真实数据，不碰会员状态。

免费号点「销售漏斗」标签只会弹出订阅引导（`premium_lite_premium_analytics`），列一直停在灰色加载骨架。

## 原理

这几列的数据由 Ozon 自己的接口提供：

```
POST /api/site/seller-analytics/charts/v3/table/totals   总计
POST /api/site/seller-analytics/charts/v3/table/by_sku   按 SKU 明细
```

页面请求时会带一个 `x-o3-company-id` 头。本插件在页面里用**当前登录的会话**直接调它，所以：

- 不需要 Premium
- 不需要 Api-Key
- 不需要服务端 / ERP
- 自动跟随当前登录的 Ozon 账号（`company_id` 从 `localStorage.vuex` 或 cookie `sc_company_id` 读取）

## 安装

1. 下载并解压本目录（或 `ozon-funnel.zip`）
2. Chrome 打开 `chrome://extensions`
3. 右上角打开「开发者模式」
4. 点「加载已解压的扩展程序」，选择解压出来的 `ozon-funnel` 目录
5. 打开/刷新 `https://seller.ozon.ru/app/analytics/graphs`

## 使用

页面右下角出现 **「📊 Ozon 我的商品销售」** 按钮，点开即可：

- 日期：今天 / 昨天 / 近 7 / 14 / 28 / 30 天
  - **口径与 Ozon 后台一致**：「近 N 天」= 截止**昨天**的 N 个完整天，**不含今天**（今天数据不完整）。
    实测 Three Latte 在 2026-10-09：后台 7 天 = 10-02~10-08 → 14 单；含今天会变成 15 单。
    要看今天的数据，点「今天」。
- **指标组切换**：数据概览(9) / 销售漏斗(12) / 全部指标(18)
- 总计卡：当前组前 6 个指标的区间总计
- 明细表：商品主图 + 商品名 + **货号 / SKU**，逐列列出指标；顶部有「总计和平均值」冻结行，**点表头可排序**
- **⛶ 最大化**：横向铺满整屏（长表格用），再点「🗗 还原」回到右下角浮层
- **收起**：点面板右上角「收起」、或再点右下角悬浮按钮、或按 **Esc**，三种方式都能折叠
- 「导出 CSV」：导出**当前指标组**的全部列，带 BOM，Excel 直接打开

## 免费可用的 18 个指标

| 指标 | 说明 |
|---|---|
| `revenue` / `sold_revenue` | 已订购金额（销售价 / 最低价） |
| `ordered_units` / `delivered_units` | 已订购件数 / 已送达件数 |
| `avg_price` / `avg_sold_price` | 平均价格 / 平均实付价 |
| `discount_share_of_median_price` | 相对中位价折扣 |
| `conv_views_to_order` | 访问→下单转化率 |
| `total_views` / `total_hits_to_cart` / `conv_total_views_to_cart` | 总访问量 / 总加购次数 / 总访问→加购转化率 |
| `pdp_views` / `hits_pdp_to_cart` / `conv_pdp_views_to_cart` | 商品卡片访问量 / 详情页加购次数 / 详情页→加购转化率 |
| `search_position` / `search_views` | 搜索和目录中的位置 / 展示次数 |
| `hits_search_to_cart` / `conv_search_views_to_cart` | 搜索加购次数 / 搜索→加购转化率 |

**拿不到的**（接口直接 400，属真·会员专属）：`price_index`、`drr`、`days_in_promo`、`last_stock`、`stockout_days`、`reviews_count`、`rating`、`recommended_supply`、`returns`、`cancellations` 等。

## 已知坑（改代码时注意）

**日期区间千万别用 `today-(N-1) ~ today`**：Ozon 的「7 天」是 `today-N ~ today-1`（不含今天），
含了今天数字就比后台大（实测多出今天的 3 单，14 → 15）。

请求头 `x-o3-language` 只接受 `zh-Hans` / `ru` / `en`。传 `zh-CN` 这类后端不认的值时，接口照样返回 200，
但 `productInfo` 里的 `name` / `article` / `image` 会**全部变成空字符串** —— 表格看起来就是「商品那列什么都没有」。

## 说明

- 数据口径与 Ozon 后台完全一致（用的是同一个接口）。
- 只有登录 seller.ozon.ru 后才能取数；切账号后刷新页面即可，插件会自动跟随新账号。
- 权限只申请了 `https://seller.ozon.ru/*`，不读取其他网站、不上传任何数据。
