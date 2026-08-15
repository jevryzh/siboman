# 2026-07-29 测试环境验收：订单 KPI 对齐 MY ERP 统计口径

## 版本

- 测试环境版本：`v2.2.9.89-test-order-myerp-kpi-math`
- 备份目录：`/opt/ozon/backups/test-20260729-141545`

## 调整范围

- 订单页顶部 KPI 的 `本周 GMV / 本周利润 / 本周利润率` 改为按 MY ERP 的有效订单口径计算。
- KPI 统计排除 `awaiting_packaging` 和 `cancelled`，避免把未进入履约和已取消订单计入 GMV。
- KPI 时间范围改为最近 7 天，并继续使用上一段 7 天作为趋势对比。
- 当商品缺少成本/利润字段时，KPI 利润按商品成交额回退，保持 MY ERP 当前无成本时利润等于 GMV 的展示方式。
- 列表日期筛选仍用于订单列表查询，不影响顶部 KPI 的 MY ERP 对齐口径。

## 验证

- `node --check public/js/views/OrderList.js`
- `node tests/test_operations_modules.cjs`
- `npm run test:erp`
- `curl -fsS https://test.renwz.cn/api/version`
- `curl -fsS https://test.renwz.cn/js/views/OrderList.js | rg "isKpiGmvOrder|kpiOrderProfit|awaiting_packaging|cancelled|product.subtotal_cny \\|\\| product.price_cny"`

## 结果

- 测试环境服务重启后为 `active`。
- `/api/version` 返回 `v2.2.9.89-test-order-myerp-kpi-math`。
- 测试环境订单页 JS 已包含有效订单过滤和 KPI 利润回退逻辑。
