# P0-D QA Acceptance Plan

Owner: testing-engineer
Last updated: 2026-07-21

## Scope

This plan covers local static checks and read-only test-environment verification. Production is read-only and must not be changed. Real Ozon listing, stock, order, and AI generation actions are blocked unless explicitly approved.

## Mandatory Local Checks

```bash
node --check server.js
node tests/test_backend_contract_security.cjs
node scripts/check-extension-release.mjs
node tests/test_extension_release.cjs
node tests/test_batch_listing_guard.cjs
npm run test:erp
node tests/test_batchupload.cjs
```

## Batch Listing Protection

- Plugin version tuple must match manifest, background, zip, and store management download state.
- Multi-image preservation must not degrade to primary image only.
- Seller API `description_category_id` and `type_id` must be preserved.
- Rich content JSON must remain in payload and history evidence.
- Warehouse ids must stay store-scoped.
- New submissions are submitted to Ozon for asynchronous processing, not described as completed immediately.
- Listing history must show raw errors, sync status, retry, delete, and export controls.
- Portal listing path remains guarded for one selected store and bundle-backed items.

## Current Blockers

- No test credentials were provided, so authenticated read-only remote smoke is not run here.
- No sandbox Ozon mutation policy was provided, so L1/L2 checks remain blocked.
