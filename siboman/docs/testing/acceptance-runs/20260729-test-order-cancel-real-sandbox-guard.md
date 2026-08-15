# 2026-07-29 订单取消真实接口沙箱保护验收

- 环境：测试环境 `https://test.renwz.cn`
- 版本：`v2.2.9.98-test-order-cancel-real-sandbox-guard`
- 备份：`/opt/ozon/backups/test-20260729-154427`

## 调整范围

- 取消订单后端改为对接 Ozon 真实接口：`POST /v2/posting/fbs/cancel`。
- 前端取消订单时要求输入 `cancel_reason_id`，并将其原样提交给后端。
- 后端构造真实 Ozon payload：`posting_number`、`cancel_reason_id`、可选 `cancel_reason_message`。
- 默认 `OZON_ORDER_CANCEL_MODE=disabled`，不调用 Ozon。
- 只有 `OZON_ORDER_CANCEL_MODE=sandbox` 时才允许真实调用。
- 生产调用需要同时配置 `OZON_ORDER_CANCEL_MODE=production` 和 `OZON_ORDER_CANCEL_ALLOW_PRODUCTION=true`。
- 每次取消尝试都会写入 `app_order_cancel_events`，记录 request、response、状态和是否调用 Ozon。

## 验证

- `node --check server.js`
- `node --check public/js/views/OrderList.js`
- `node tests/test_operations_modules.cjs`
- `npm run test:erp`
- `curl -fsS https://test.renwz.cn/api/version`
- `curl -fsS https://test.renwz.cn/js/views/OrderList.js | rg "cancelOrder|cancel_reason_id|/v2/posting/fbs/cancel|测试环境未启用沙箱开关|orders/cancel|取消订单"`
- 测试服务未配置 `OZON_ORDER_CANCEL_MODE`，当前不会误调用真实 Ozon 取消接口。
