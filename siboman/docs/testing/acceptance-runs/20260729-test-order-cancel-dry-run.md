# 2026-07-29 订单取消 Dry-run 验收

- 环境：测试环境 `https://test.renwz.cn`
- 版本：`v2.2.9.97-test-order-cancel-dry-run`
- 备份：`/opt/ozon/backups/test-20260729-153636`

## 调整范围

- 操作菜单中的 `取消订单` 改为可点击。
- 点击后弹出确认框，可填写取消原因。
- 后端新增 `/api/seller/orders/cancel`，只记录取消意向。
- 新增 `app_order_cancel_events` 表记录 dry-run 取消事件。
- 测试环境不调用 Ozon 取消接口，不修改订单状态。

## 验证

- `node --check server.js`
- `node --check public/js/views/OrderList.js`
- `node tests/test_operations_modules.cjs`
- `npm run test:erp`
- `curl -fsS https://test.renwz.cn/api/version`
- `curl -fsS https://test.renwz.cn/js/views/OrderList.js | rg "simulateCancelOrder|orders/cancel|未实际取消 Ozon 订单|记录取消意向|取消订单"`
- 服务端确认存在 `app_order_cancel_events`、`dry_run=true`、`ozon_called=false`。
