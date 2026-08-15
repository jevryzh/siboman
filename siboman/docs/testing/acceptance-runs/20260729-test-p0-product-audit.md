# 2026-07-29 Test P0 Product Audit Fix

Scope: test environment `https://test.renwz.cn`, PC ERP only. Mobile layout fix intentionally skipped.

## Changes

- Restored direct route aliases: `#/selection`, `#/history`, `#/ai-image`, `#/screen`, `#/ranking`.
- Removed order label/waybill UI from order management per product decision.
- Added contextual order empty/loading copy.
- Fixed frontend warnings for `Calculator` icon and `fetchJobHistory`.
- Aligned batch upload collector requirement with released plugin `2.2.9.63` and blocked stale plugin actions.

## Local Guards

- `npm run test:erp` passed.
- `node tests/test_operations_modules.cjs` passed.
- `node tests/test_batch_listing_guard.cjs` passed.
- `node tests/test_single_sourcing_v2.cjs` passed.

## Deploy

- Previous test version: `v2.2.9.77-test-sourcing-cooldown`.
- Backup: `/opt/ozon/backups/test-20260729-120949`.
- New test version: `v2.2.9.78-test-p0-product-audit`.
- Service: `ozon-app-test` active.
- Plugin zip sha256: `541ec851a8985a785c4e9457c4c1edb81bc4220e2362f20a3dd782ffc09d6827`.

## Smoke

- `https://test.renwz.cn/api/version` returned `v2.2.9.78-test-p0-product-audit`.
- Manifest served version `2.2.9.63`.
- Zip sha256 matched local zip.
- Online JS contains route aliases, order empty state, plugin version guard, and returned `fetchJobHistory`.
- Online `OrderList.js` no longer contains `printLabels` or `面单`.
- Fixed test server `public/uploads` ownership after deploy; restart log no longer reports uploads permission errors.
