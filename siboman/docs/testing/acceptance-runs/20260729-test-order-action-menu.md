# 2026-07-29 订单列表操作菜单验收

- 环境：测试环境 `https://test.renwz.cn`
- 版本：`v2.2.9.96-test-order-action-menu`
- 备份：`/opt/ozon/backups/test-20260729-152909`

## 调整范围

- 订单列表 `操作` 列从横排文字按钮改为 MY ERP 风格的三点下拉菜单。
- 操作列宽度收窄到 `72px` 并居中，避免右侧固定列和滚动条遮挡按钮。
- 下拉菜单包含：查看详情、编辑货源/采购、找货源、立即备货、取消订单。
- `取消订单` 当前后端未接入可靠 Ozon 取消接口，先保持禁用，避免不可逆误操作。

## 验证

- `node --check public/js/views/OrderList.js`
- `node tests/test_operations_modules.cjs`
- `npm run test:erp`
- `curl -fsS https://test.renwz.cn/api/version`
- `curl -fsS https://test.renwz.cn/js/views/OrderList.js | rg "el-dropdown trigger=|MoreFilled|查看详情|编辑货源/采购|找货源|立即备货|width=\"72\" fixed=\"right\""`
