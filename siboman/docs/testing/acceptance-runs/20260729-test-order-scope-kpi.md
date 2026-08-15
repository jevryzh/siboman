# 2026-07-29 Test Order Scope KPI

- Environment: test
- URL: https://test.renwz.cn/#/orders
- Version: v2.2.9.82-test-order-scope-kpi
- Backup: /opt/ozon/backups/test-20260729-132000

## Scope

- Order management keeps only one store selector: the store dropdown in the filter row.
- The global header shop switcher is hidden on the order page.
- The top action bar store dropdown is removed.
- KPI cards use order scope statistics for the selected store range and date range instead of current table page rows.
- KPI labels changed from current-page copy to scope copy.

## Verification

- `npm run test:erp`
- `curl -fsS https://test.renwz.cn/api/version`
- `curl -fsS https://test.renwz.cn/js/views/OrderList.js | rg "范围 GMV|范围到手|范围到手率|summaryRows|fetchOrderSummary|ORDER_SUMMARY_PAGE_SIZE|el-select v-model=\"storeScope\""`
- `curl -fsS https://test.renwz.cn/js/main.js | rg "shop-switcher v-if=\"routeName !== 'orders'\""`
- `systemctl is-active ozon-app-test`

## Result

Passed.
