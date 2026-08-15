# 2026-07-29 Test Order Visible Notes

- Environment: test
- URL: https://test.renwz.cn/#/orders
- Version: v2.2.9.87-test-order-visible-notes
- Backup: /opt/ozon/backups/test-20260729-135545

## Scope

- Saved order notes are now visible directly in the order row.
- Notes render under the posting/status area as an orange inline note badge.
- Existing-note rows change the action text from `备注` to `看备注`.
- Note lookup uses store_id plus posting_number so all-store mode does not mix notes.

## Verification

- `npm run test:erp`
- `curl -fsS https://test.renwz.cn/api/version`
- `curl -fsS https://test.renwz.cn/js/views/OrderList.js | rg "orderNote|看备注|Memo|订单备注"`
- `systemctl is-active ozon-app-test`

## Result

Passed.
