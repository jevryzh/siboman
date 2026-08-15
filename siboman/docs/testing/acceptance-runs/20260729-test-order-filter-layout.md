# 2026-07-29 Test Order Filter Layout

- Environment: test
- URL: https://test.renwz.cn/#/orders
- Version: v2.2.9.84-test-order-filter-layout
- Backup: /opt/ozon/backups/test-20260729-133923

## Scope

- Order filter controls now use a fixed PC grid:
  - Store selector
  - Field selector
  - Keyword search
  - Date range
  - Filter
  - Reset
- Filter and reset buttons no longer wrap onto an orphan second line on desktop.
- The store selector remains the single order-page store scope control.

## Verification

- `npm run test:erp`
- `curl -fsS https://test.renwz.cn/api/version`
- `curl -fsS https://test.renwz.cn/js/views/OrderList.js | rg "grid-template-columns:220px 150px minmax\\(280px,1fr\\) 330px 80px 80px|el-select v-model=\\\"storeScope\\\""`
- `systemctl is-active ozon-app-test`

## Result

Passed.
