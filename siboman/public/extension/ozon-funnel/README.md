# Ozon 销售漏斗（独立插件）

在 Ozon 卖家后台直接查看「我的分析 → 我的商品销售」里的**销售漏斗**数据，**不需要 Premium**，独立安装使用，不需要配置任何密钥。

## 为什么需要它

Ozon 后台的销售漏斗这几列属于 Premium 专属：

- 在搜索结果和目录中的位置
- 搜索结果和目录中的展示次数
- 商品卡片访问量
- 从商品卡片添加到购物车的转化率

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

页面右下角出现 **「📉 Ozon 销售漏斗」** 按钮，点开即可：

- 日期：今天 / 昨天 / 近 7 / 14 / 28 / 30 天
- 总计卡：展示次数、商品卡片访问量、详情→加购转化率、搜索位次（平均）、已订购金额、已订购件数
- 明细表：按 SKU 列出上面几列，**点表头可排序**
- 「导出 CSV」：带 BOM，Excel 直接打开

## 说明

- 数据口径与 Ozon 后台完全一致（用的是同一个接口）。
- 只有登录 seller.ozon.ru 后才能取数；切账号后刷新页面即可，插件会自动跟随新账号。
- 权限只申请了 `https://seller.ozon.ru/*`，不读取其他网站、不上传任何数据。
