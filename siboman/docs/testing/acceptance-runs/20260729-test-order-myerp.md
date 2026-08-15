# 2026-07-29 Test Order MY ERP Layout

Scope: test environment `https://test.renwz.cn`, PC order management only.

## Changes

- Reworked order management into a MY ERP-inspired operations desk.
- Added top action bar, sync range notice, four KPI blocks, segmented status counts, filter/search row, export control, and auto-sync switch.
- Reorganized order rows into countdown, posting/status, store, product, warehouse/delivery, and actions.
- Kept order label/waybill UI removed.
- Kept irreversible shipment confirmation flow unchanged.

## Local Guards

- `npm run test:erp` passed.
- Mock browser render passed with local intercepted API data.
- Mock screenshot: `/Users/eason/Documents/OZON/product-audit-test-env-20260729/order-myerp-local-wrap.png`.
- Browser console had only Vue development-build notices.

## Deploy

- Previous test version: `v2.2.9.78-test-p0-product-audit`.
- Backup: `/opt/ozon/backups/test-20260729-124047`.
- New test version: `v2.2.9.79-test-order-myerp`.
- Service: `ozon-app-test` active.
- Plugin manifest version: `2.2.9.63`.
- Plugin zip sha256: `541ec851a8985a785c4e9457c4c1edb81bc4220e2362f20a3dd782ffc09d6827`.

## Smoke

- `/api/version` returned `v2.2.9.79-test-order-myerp`.
- Online `OrderList.js` contains `所有订单`, `待发运`, `已超时`, `有争议的`, `订单导出`, `货件 / 状态`, and `deadlineHourText`.
- Online `OrderList.js` does not contain `printLabels` or `面单`.
- Fixed test server `public/uploads` ownership after deploy; restart log no longer reports uploads permission errors.
