# 2026-07-29 Test Order Store Scope

- Environment: test
- URL: https://test.renwz.cn
- Version: v2.2.9.81-test-order-store-scope
- Backup: /opt/ozon/backups/test-20260729-130458

## Scope

- Order management can switch between current store, all stores, and a specific store from a dropdown.
- All-store order reads fetch each active store and merge rows with store_id/store_name.
- Row actions use the order row store_id for detail, note, single ship, and batch ship.
- The table row key includes store_id plus posting_number to avoid selection collisions across stores.
- Waybill/label entry remains removed from order management.

## Verification

- `npm run test:erp`
- `curl -fsS https://test.renwz.cn/api/version`
- `curl -fsS https://test.renwz.cn/js/views/OrderList.js | rg "storeScopeOptions|全部店铺|selectedStoreIds|effectiveStoreIdForOrder|orderRowKey|row\\.store_name \\|\\| currentStoreName|确认发货至 Ozon"`
- `systemctl is-active ozon-app-test`

## Result

Passed.
