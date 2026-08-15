# 2026-07-29 取消沙箱开关与单品找货实时日志验收

- 环境：测试环境 `https://test.renwz.cn`
- 版本：`v2.2.9.99-test-cancel-sandbox-switch-sourcing-logs`
- 备份：`/opt/ozon/backups/test-20260729-160318`

## 调整范围

- 订单取消开关已配置为 `OZON_ORDER_CANCEL_MODE=sandbox`。
- 沙箱取消必须配置独立 `OZON_ORDER_CANCEL_BASE_URL`，且不能等于生产 `OZON_SELLER_BASE_URL`。
- 当前测试环境未配置独立沙箱 URL，因此不会误调用真实 Ozon 取消接口。
- 单品找货实时日志：
  - 轮询间隔从 1.5 秒调整到 1 秒。
  - 轮询允许 3 次短暂失败后再报错停止。
  - 日志面板新增自动滚动到底部。
  - 页面加载时优先从历史/数据库恢复最新 active job。

## 现场验证

- 数据库中当前单品找货任务 `89a13305-f7cb-4ab3-8a89-bd5801e4acdd` 正在持续更新。
- 重启测试服务后，该任务从第 3 行继续更新到第 5 行，日志从 11 条增长到 17 条。
- worker 心跳显示插件 `2.2.9.63` 在线，current job 和 current phase 与数据库任务一致。

## 测试

- `node --check server.js`
- `node --check public/js/views/SourcingModule.js`
- `node tests/test_operations_modules.cjs`
- `node tests/test_single_sourcing_v2.cjs`
- `npm run test:erp`
- `curl -fsS https://test.renwz.cn/api/version`
- `curl -fsS https://test.renwz.cn/js/views/SourcingModule.js | rg "logPanel|scrollTop = el.scrollHeight|pollFailures|1000\\);|fetchJobHistory\\(\\)\\.finally"`
