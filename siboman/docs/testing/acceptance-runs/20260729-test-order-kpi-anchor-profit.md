# 2026-07-29 测试环境验收：订单 KPI 截止时间与利润修正

## 版本

- 测试环境版本：`v2.2.9.90-test-order-kpi-anchor-profit`
- 备份目录：`/opt/ozon/backups/test-20260729-142637`

## 调整范围

- 订单页顶部 KPI 使用刷新时固定的统计截止时间，避免“最近 7 天”按当前秒滑动导致边界订单几分钟后掉出统计。
- 未选择日期筛选时，同步范围文案显示“上次同步前 1 天至本次刷新时间”，不再显示“近 30 天”。
- KPI 利润在商品缺少成本/利润字段时，按订单 GMV 回退。
- 商品行金额回退不再重复乘数量，避免 `本周利润` 大于 `本周 GMV`。
- 单订单 KPI 利润增加上限保护，不超过订单 GMV。

## 验证

- `node --check public/js/views/OrderList.js`
- `node tests/test_operations_modules.cjs`
- `npm run test:erp`
- `curl -fsS https://test.renwz.cn/api/version`
- `curl -fsS https://test.renwz.cn/js/views/OrderList.js | rg "kpiAnchorAt|Math.min\\(Number\\(row.total_cny|从上次同步前 1 天"`

## 结果

- 测试环境服务重启后为 `active`。
- `/api/version` 返回 `v2.2.9.90-test-order-kpi-anchor-profit`。
- 订单页 JS 已包含固定 KPI 截止时间、默认同步范围文案和利润上限保护。
