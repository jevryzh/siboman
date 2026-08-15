# 2026-07-29 Test Order Compact Date Filter

- Environment: test
- URL: https://test.renwz.cn/#/orders
- Version: v2.2.9.86-test-order-compact-date-filter
- Backup: /opt/ozon/backups/test-20260729-134513

## Scope

- Order filter row uses a more compact desktop grid.
- Date range picker width reduced from 330px to 250px.
- Store selector, field selector, filter button, and reset button are also compacted to keep the row from crowding the table.

## Verification

- `npm run test:erp`
- `curl -fsS https://test.renwz.cn/api/version`
- `curl -fsS https://test.renwz.cn/js/views/OrderList.js | rg "grid-template-columns:190px 130px minmax\\(260px,1fr\\) 250px 70px 70px"`
- `systemctl is-active ozon-app-test`

## Result

Passed.
