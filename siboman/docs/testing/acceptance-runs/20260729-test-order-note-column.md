# 2026-07-29 Test Order Note Column

- Environment: test
- URL: https://test.renwz.cn/#/orders
- Version: v2.2.9.88-test-order-note-column
- Backup: /opt/ozon/backups/test-20260729-140333

## Scope

- Removed the inline note badge from the posting/status cell.
- Added a dedicated `备注` table column.
- Existing notes are shown as an ellipsized clickable note summary.
- Empty notes show `-`.
- The action column uses a stable `备注` action instead of switching to `看备注`.

## Verification

- `npm run test:erp`
- `curl -fsS https://test.renwz.cn/api/version`
- `curl -fsS https://test.renwz.cn/js/views/OrderList.js | rg "label=\\\"备注\\\"|orderNote"`
- `curl -fsS https://test.renwz.cn/js/views/OrderList.js | rg "看备注" || true`
- `systemctl is-active ozon-app-test`

## Result

Passed.
