# 2026-07-29 Test Order Week KPI

- Environment: test
- URL: https://test.renwz.cn/#/orders
- Version: v2.2.9.83-test-order-week-kpi
- Backup: /opt/ozon/backups/test-20260729-133412

## Scope

- Order KPI cards now follow the MY ERP weekly dimension.
- KPI 1: 本周 GMV.
- KPI 2: 本周利润.
- KPI 3: 本周利润率.
- KPI trend lines compare the current week against the previous 7 days.
- The order list date filter still controls the table and status counts separately.
- The order page still keeps only one store selector in the filter row.

## Verification

- `npm run test:erp`
- `curl -fsS https://test.renwz.cn/api/version`
- `curl -fsS https://test.renwz.cn/js/views/OrderList.js | rg "本周 GMV|本周利润|本周利润率|vs 上 7 天|kpiRows|previousKpiRows|weekKpiRanges|fetchOrderKpis"`
- `curl -fsS https://test.renwz.cn/js/views/OrderList.js | rg "当前页 GMV|范围 GMV|范围到手" || true`
- `systemctl is-active ozon-app-test`

## Result

Passed.
