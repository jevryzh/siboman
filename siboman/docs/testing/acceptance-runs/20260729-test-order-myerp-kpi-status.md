# 2026-07-29 测试环境验收：订单 KPI 与状态栏对齐 MY ERP

## 版本

- 测试环境版本：`v2.2.9.93-test-order-myerp-kpi-status`
- 备份目录：`/opt/ozon/backups/test-20260729-150318`

## MY ERP 接口核对

- KPI 接口：`/ozon/postings/profit-trend?days=14`
- 状态接口：`/ozon/postings/cache/status-counts`
- HappyFriday KPI：`本周 GMV=4171.05`，`本周利润=4171.05`
- HappyFriday 状态：`all=598`，`awaiting_packaging=12`，`awaiting_deliver=25`，`delivering=298`，`delivered=196`，`cancelled=67`

## 调整范围

- 顶部 KPI 改为读取本地缓存订单池，按 Asia/Shanghai 日期口径计算。
- KPI 最近 7 个自然日只排除 `cancelled`，与 MY ERP `profit-trend` 口径一致。
- 新增 `display_status`，默认列表和状态栏使用缓存展示状态，不再被 Ozon 实时终态覆盖。
- 测试环境 HappyFriday 已按 MY ERP 缓存状态初始化 `display_status`。

## 验证

- `npm run test:erp`
- 测试环境硬刷新后版本为 `v2.2.9.93-test-order-myerp-kpi-status`
- 页面显示：`本周 GMV ¥4171.05`，`本周利润 ¥4171.05`
- 页面状态栏显示：`所有订单 598`，`待备货 12`，`待发运 25`，`运输中 298`，`已送达 196`，`已取消 67`
