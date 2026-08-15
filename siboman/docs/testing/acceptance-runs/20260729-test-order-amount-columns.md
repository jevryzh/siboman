# 2026-07-29 Test Order Amount Columns

- Environment: test
- URL: https://test.renwz.cn/#/orders
- Version: v2.2.9.85-test-order-amount-columns
- Backup: /opt/ozon/backups/test-20260729-134211

## Scope

- Order table now has a dedicated `订单金额` column.
- Order table now has a dedicated `利润` column.
- Product cell no longer hides order amount/profit as small inline metadata.
- Profit shows `-` when the order lacks purchasable cost/profit data.

## Verification

- `npm run test:erp`
- `curl -fsS https://test.renwz.cn/api/version`
- `curl -fsS https://test.renwz.cn/js/views/OrderList.js | rg "label=\\\"订单金额\\\"|label=\\\"利润\\\"|hasOrderProfit"`
- `systemctl is-active ozon-app-test`

## Result

Passed.
