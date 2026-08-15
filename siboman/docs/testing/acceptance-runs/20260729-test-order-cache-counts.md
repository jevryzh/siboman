# 2026-07-29 测试环境验收：订单默认总数对齐 MY ERP 缓存口径

## 版本

- 测试环境版本：`v2.2.9.92-test-order-cache-84d`
- 备份目录：`/opt/ozon/backups/test-20260729-144537`

## MY ERP 接口核对

- 列表接口：`/ozon/postings/cache?currentPage=1&pageSize=20&orderBy=inProcessAt`
- 状态计数接口：`/ozon/postings/cache/status-counts`
- HappyFriday 返回：`all=598`

## 调整范围

- 新增 `app_order_cache`，订单页默认无日期筛选时读取本地订单缓存。
- 缓存不足时自动回填 84 天历史订单，并清理窗口外订单。
- 显式日期筛选仍走 Ozon 实时接口，不使用默认缓存池。
- 默认订单状态栏不再只统计近 30 天实时窗口，避免 HappyFriday 从 MY ERP 的 598 变成 277。

## 验证

- `npm run test:erp`
- 测试环境硬刷新后版本为 `v2.2.9.92-test-order-cache-84d`
- HappyFriday 默认订单页显示 `所有订单 598`

## 说明

- MY ERP 状态拆分来自其缓存状态；本系统回填时按 Ozon 当前实时状态落库，因此总量已对齐，个别状态分布可能因状态更新时点不同存在差异。
