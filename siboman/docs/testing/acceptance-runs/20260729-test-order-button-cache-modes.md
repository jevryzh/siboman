# 2026-07-29 订单页按钮与日期缓存口径验收

- 环境：测试环境 `https://test.renwz.cn`
- 版本：`v2.2.9.95-test-order-button-cache-modes`
- 备份：`/opt/ozon/backups/test-20260729-152307`

## 调整范围

- 订单日期筛选统一转换为北京时间自然日边界：`00:00:00+08:00` 至 `23:59:59+08:00`。
- 订单列表显式日期筛选默认读取本地订单缓存，避免和 MY ERP 的缓存型订单列表口径偏离。
- 顶部按钮拆分：
  - `刷新`：只重新读取本地缓存，不请求 Ozon。
  - `拉取最新订单`：按同步窗口主动拉取 Ozon 最新订单并写入缓存。
  - `设置时间`：设置拉取最新订单使用的同步时间窗口。
  - `刷新进行中订单`：按缓存历史窗口刷新订单状态。

## 验证

- `node --check server.js`
- `node --check public/js/views/OrderList.js`
- `node tests/test_operations_modules.cjs`
- `npm run test:erp`
- `curl -fsS https://test.renwz.cn/api/version`
- `curl -fsS https://test.renwz.cn/js/views/OrderList.js | rg "sync_mode: syncMode|refreshOrderDashboard\\('cache'\\)|refreshOrderDashboard\\('latest'\\)|refreshOrderDashboard\\('in_progress'\\)|openSyncWindowDialog|T00:00:00\\+08:00"`
