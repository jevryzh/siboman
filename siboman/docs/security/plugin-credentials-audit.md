# Plugin Credential Audit

Date: 2026-07-21

Scope: `/api/extension/seller-credentials`, worker token issuance, and Ozon Seller API key exposure risks.

## Risk Conclusion

Current risk is high while the legacy endpoint is enabled: `/api/extension/seller-credentials` returns Ozon `clientId` and `apiKey` to the Chrome extension after ERP login. The route checks `user_id + store_id + active`, which prevents basic horizontal access, but the API key leaves the server boundary and can be cached by browser tooling, extension logs, or compromised extension state.

No P0 exploitable cross-tenant break was confirmed in this review. The current test environment has high residual risk from intentional legacy compatibility, but the known exposure is behind ERP login, store ownership checks, `Cache-Control: no-store`, masked logging, and a kill switch.

## Implemented Guardrails

- Added `POST /api/v1/plugin/tokens` to issue short scoped worker tokens.
- Scoped token TTL defaults to 15 minutes via `PLUGIN_WORKER_TOKEN_TTL_MS`, capped at 1 hour.
- Scoped tokens are accepted by backend auth without changing the main HttpOnly session cookie path.
- Legacy credential response is marked `deprecated` and points to `/api/v1/plugin/tokens`.
- Legacy credential response sends `Cache-Control: no-store`.
- Legacy credential access logs only a masked `client_id`.
- Legacy credential route is in a default-open compatibility window and can be disabled with `ALLOW_LEGACY_EXTENSION_SELLER_CREDENTIALS=false` after plugin migration.
- Store management responses expose `client_id_masked` / `client_id_last4` and do not return raw Ozon `client_id` or `api_key`.
- Scoped plugin tokens are limited to collector submit and worker queue paths; they cannot call ordinary ERP APIs.
- Scoped worker queue claims and job lookups are filtered by `user_id` and token `storeId`.
- `/api/v1/ai/images/providers` exposes only provider configuration booleans and model names, never API keys.
- Dangerous Ozon write flows currently have user-facing confirmations in the UI: archive/unarchive, bulk archive, stock overwrite, bulk stock submit, draft clearing, order shipment, listing retry, and listing deletion.

## Residual Risk

- The current Chrome extension still calls `/api/extension/seller-credentials` for OPI enrichment. Disabling it before extension migration can break the existing batch listing flow.
- Scoped worker tokens are stateless HMAC tokens. They are short-lived, but not individually revocable before expiry.
- Jobs without a `store_id` are not claimable by store-scoped plugin tokens; cookie/session workers still use existing user-scoped behavior.
- Backend strong-confirmation fields are not yet standardized. A direct authenticated HTTP client can call dangerous write endpoints after normal login without sending an explicit `confirm_*` field, so the current safety boundary depends on the first-party UI confirmation plus backend ownership/status checks.

## Current Compatibility Rationale

- The test plugin package still needs `/api/extension/seller-credentials` during the migration window for OPI enrichment and batch listing continuity.
- Keeping the legacy route default-open in test lets QA compare old-plugin and new-token flows before flipping `ALLOW_LEGACY_EXTENSION_SELLER_CREDENTIALS=false`.
- The response remains intentionally marked `deprecated` so extension and QA can detect the old path without breaking current operator workflow.
- Store secrets are still accepted and stored server-side because Ozon Seller API calls for validation, product sync, stock sync, order labels, and shipment require the original Ozon credentials.

## P0 Review

- No confirmed P0: no raw Ozon `api_key` appears in store management list/create/settings responses.
- No confirmed P0: scoped plugin token cannot call ordinary ERP APIs and cannot mint `/api/worker/plugin-token`.
- No confirmed P0: worker queue access remains `user_id` scoped, with additional `storeId` filtering for scoped plugin tokens.
- Highest current risk: legacy credential handoff remains high risk by design until the extension stops requiring raw Ozon credentials client-side.

## Before Commercial Launch

- Disable `/api/extension/seller-credentials` by setting `ALLOW_LEGACY_EXTENSION_SELLER_CREDENTIALS=false` after migrated extension acceptance passes.
- Replace direct client-side Ozon API usage with server-mediated APIs or scoped worker-token submission.
- Add backend strong-confirmation requirements for dangerous write endpoints, for example explicit request fields or headers for archive/unarchive, product full update with Ozon sync, stock overwrite, bulk stock submit, order shipment, listing retry, and destructive deletes.
- Add redaction middleware or structured logger helpers so error payloads from upstream APIs cannot accidentally log configured API keys, bearer tokens, or raw credential-shaped fields.
- Add short-token revocation or rotation strategy if plugin worker tokens are used beyond the test migration window.
- Verify production cookie/security headers behind the deployed proxy, including `Secure` cookies via `x-forwarded-proto=https` and no-store responses for secret-adjacent routes.

## Required Follow-Up

- Extension engineer: replace direct Ozon credential retrieval with server-mediated collector/listing APIs or scoped worker-token submission.
- Frontend engineer: request `/api/v1/plugin/tokens` from a logged-in ERP page and hand it to the extension; do not show or persist Ozon API keys client-side.
- QA/testing engineer: verify old plugin package works while `ALLOW_LEGACY_EXTENSION_SELLER_CREDENTIALS=true`, then verify migrated package works with it set to `false`.
- DevOps engineer: keep `ALLOW_LEGACY_EXTENSION_SELLER_CREDENTIALS=true` in test until migration is accepted; set it to `false` only after plugin zip and manifest versions are confirmed.
